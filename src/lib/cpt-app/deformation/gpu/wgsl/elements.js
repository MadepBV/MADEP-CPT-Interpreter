// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Element kernels (WGSL).  Strain, internal force, stiffness for T3 and T6
// 2-D plane-strain elements.  All arithmetic is double-single.
// ============================================================================
//
// Layout per element (uploaded once when the mesh is built; bytes are
// rounded up to satisfy WebGPU's 16 B uniform-buffer alignment):
//
//   T3 element:  3 corners × (x, y) f32 = 24 B,   1 GP
//                B-matrix (3 × 6 DS) = 144 B
//                weight × |J|  (DS) = 8 B
//   T6 element:  3 corners × (x, y) f32 = 24 B,   3 GPs
//                3 × (B-matrix 3 × 12 DS) = 3 × 288 = 864 B
//                3 × (weight × |J|  DS) = 24 B
//
// In practice we pack the B-matrices as a flat DS buffer indexed by
// (elementIndex, gpIndex, row, col).  The kernel below assumes the B-bar
// transformation has already been applied at upload time when relevant —
// since B-bar averages volumetric B over the element's GPs, the natural
// place to do that transform is the host-side pre-pack stage, exactly as
// the CPU element-cache builder already does for T6.
//
// Strain output: 3 DS scalars per GP (εxx, εyy, γxy).  Stored contiguously
// as `array<vec2<f32>, 3 * numGp>`.
//
// Internal force output: 6 DS scalars per T3 element / 12 per T6 element,
// gathered into the global free-DOF residual via a separate scatter pass.
// To stay atomic-free, we write per-element contributions to a scratch
// buffer; a second scatter kernel sums them at each free DOF using a
// pre-built incidence list.

import { DS_WGSL } from './ds.js';

// -----------------------------------------------------------------------------
// Strain at every Gauss point.  One thread per GP.
//
// Inputs (read-only):
//   uvec       : DS displacement vector (length N).
//   bMatrices  : flat DS array of length (3 × numGp) per element row, packed
//                in row-major (gp, row, col) order.  For a T3 with 1 GP:
//                  3 × 6 DS = 18 entries / element
//                For a T6 with 3 GPs:
//                  9 × 12 DS = 108 entries / element
//   dofMap     : for each element, an Int32Array of length 6 (T3) or 12 (T6)
//                listing the global DOF index of each local DOF.
//
// Output:
//   strain     : DS array of length 3 × totalGp.  Layout
//                strain[gp_global * 3 + 0] = εxx
//                strain[gp_global * 3 + 1] = εyy
//                strain[gp_global * 3 + 2] = γxy
// -----------------------------------------------------------------------------
function makeStrainKernel(numLocalDofs, gpsPerElem) {
  return /* wgsl */ `
${DS_WGSL}

const NUM_LOCAL_DOFS: u32 = ${numLocalDofs}u;
const GPS_PER_ELEM:   u32 = ${gpsPerElem}u;
const STRAIN_DIM:     u32 = 3u;

struct StrainParams { numElements: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       uvec: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       bMatrices: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       dofMap: array<i32>;
@group(0) @binding(3) var<storage, read_write> strain: array<vec2<f32>>;
@group(0) @binding(4) var<uniform>             params: StrainParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let totalGp: u32 = params.numElements * GPS_PER_ELEM;
  let gp: u32 = gid.x;
  if (gp >= totalGp) { return; }
  let elementIndex: u32 = gp / GPS_PER_ELEM;
  let gpInElement:  u32 = gp % GPS_PER_ELEM;
  let bBase: u32 = elementIndex * GPS_PER_ELEM * STRAIN_DIM * NUM_LOCAL_DOFS
                    + gpInElement * STRAIN_DIM * NUM_LOCAL_DOFS;
  let dBase: u32 = elementIndex * NUM_LOCAL_DOFS;
  var exx: vec2<f32> = vec2<f32>(0.0, 0.0);
  var eyy: vec2<f32> = vec2<f32>(0.0, 0.0);
  var gxy: vec2<f32> = vec2<f32>(0.0, 0.0);
  for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
    let dofIdx: i32 = dofMap[dBase + d];
    if (dofIdx < 0) { continue; }
    let u_d: vec2<f32> = uvec[u32(dofIdx)];
    let b_xx: vec2<f32> = bMatrices[bBase + 0u * NUM_LOCAL_DOFS + d];
    let b_yy: vec2<f32> = bMatrices[bBase + 1u * NUM_LOCAL_DOFS + d];
    let b_xy: vec2<f32> = bMatrices[bBase + 2u * NUM_LOCAL_DOFS + d];
    exx = dsAdd(exx, dsMul(b_xx, u_d));
    eyy = dsAdd(eyy, dsMul(b_yy, u_d));
    gxy = dsAdd(gxy, dsMul(b_xy, u_d));
  }
  strain[gp * STRAIN_DIM + 0u] = exx;
  strain[gp * STRAIN_DIM + 1u] = eyy;
  strain[gp * STRAIN_DIM + 2u] = gxy;
}
`;
}

export const KERNEL_STRAIN_T3_WGSL = makeStrainKernel(6, 1);
export const KERNEL_STRAIN_T6_WGSL = makeStrainKernel(12, 3);

// -----------------------------------------------------------------------------
// Per-element internal force.  One thread per element.  Reads the per-GP
// stress (Voigt 3 = (σxx, σyy, σxy)) and computes
//
//     F_e = Σ_g  w_g · |J_g| · B_g^T · σ_g
//
// of length 6 (T3) or 12 (T6).  The output is a flat DS buffer indexed by
// (elementIndex, localDof).  A separate scatter kernel pulls these into the
// global free-DOF residual.
// -----------------------------------------------------------------------------
function makeInternalForceKernel(numLocalDofs, gpsPerElem) {
  return /* wgsl */ `
${DS_WGSL}

const NUM_LOCAL_DOFS: u32 = ${numLocalDofs}u;
const GPS_PER_ELEM:   u32 = ${gpsPerElem}u;
const STRAIN_DIM:     u32 = 3u;

struct ForceParams { numElements: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       bMatrices: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       gpWeights: array<vec2<f32>>;  // w·|J| per GP
@group(0) @binding(2) var<storage, read>       stress: array<vec2<f32>>;     // 3 DS per GP
@group(0) @binding(3) var<storage, read_write> forceOut: array<vec2<f32>>;   // numLocalDofs DS per element
@group(0) @binding(4) var<uniform>             params: ForceParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let elementIndex: u32 = gid.x;
  if (elementIndex >= params.numElements) { return; }
  let bBaseElem: u32 = elementIndex * GPS_PER_ELEM * STRAIN_DIM * NUM_LOCAL_DOFS;
  let stressBase: u32 = elementIndex * GPS_PER_ELEM * STRAIN_DIM;
  let weightBase: u32 = elementIndex * GPS_PER_ELEM;
  let forceBase:  u32 = elementIndex * NUM_LOCAL_DOFS;

  var fLocal: array<vec2<f32>, ${numLocalDofs}>;
  for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
    fLocal[d] = vec2<f32>(0.0, 0.0);
  }
  for (var g: u32 = 0u; g < GPS_PER_ELEM; g = g + 1u) {
    let bBase: u32 = bBaseElem + g * STRAIN_DIM * NUM_LOCAL_DOFS;
    let wDet: vec2<f32> = gpWeights[weightBase + g];
    let sxx: vec2<f32> = stress[stressBase + g * STRAIN_DIM + 0u];
    let syy: vec2<f32> = stress[stressBase + g * STRAIN_DIM + 1u];
    let sxy: vec2<f32> = stress[stressBase + g * STRAIN_DIM + 2u];
    for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
      let b_xx: vec2<f32> = bMatrices[bBase + 0u * NUM_LOCAL_DOFS + d];
      let b_yy: vec2<f32> = bMatrices[bBase + 1u * NUM_LOCAL_DOFS + d];
      let b_xy: vec2<f32> = bMatrices[bBase + 2u * NUM_LOCAL_DOFS + d];
      let term: vec2<f32> = dsAdd(dsAdd(dsMul(b_xx, sxx), dsMul(b_yy, syy)), dsMul(b_xy, sxy));
      fLocal[d] = dsAdd(fLocal[d], dsMul(wDet, term));
    }
  }
  for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
    forceOut[forceBase + d] = fLocal[d];
  }
}
`;
}

export const KERNEL_INTERNAL_FORCE_T3_WGSL = makeInternalForceKernel(6, 1);
export const KERNEL_INTERNAL_FORCE_T6_WGSL = makeInternalForceKernel(12, 3);

// -----------------------------------------------------------------------------
// Per-element stiffness K_e of size (numLocalDofs × numLocalDofs).  One
// thread per element.  Reads the per-GP material tangent D_g (3 × 3 DS) and
// computes
//
//     K_e = Σ_g  w_g · |J_g| · B_g^T · D_g · B_g
//
// Output is a flat DS buffer indexed by (elementIndex, i, j) with stride
// numLocalDofs².  A separate scatter kernel sums these into the global CSR.
// -----------------------------------------------------------------------------
function makeStiffnessKernel(numLocalDofs, gpsPerElem) {
  return /* wgsl */ `
${DS_WGSL}

const NUM_LOCAL_DOFS: u32 = ${numLocalDofs}u;
const GPS_PER_ELEM:   u32 = ${gpsPerElem}u;
const STRAIN_DIM:     u32 = 3u;

struct StiffParams { numElements: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       bMatrices: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       gpWeights: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       tangents: array<vec2<f32>>;   // 9 DS per GP (D row-major)
@group(0) @binding(3) var<storage, read_write> kOut: array<vec2<f32>>;       // (NUM_LOCAL_DOFS²) DS per elem
@group(0) @binding(4) var<uniform>             params: StiffParams;

@compute @workgroup_size(32)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let elementIndex: u32 = gid.x;
  if (elementIndex >= params.numElements) { return; }
  let bBaseElem: u32 = elementIndex * GPS_PER_ELEM * STRAIN_DIM * NUM_LOCAL_DOFS;
  let dBaseElem: u32 = elementIndex * GPS_PER_ELEM * 9u;
  let weightBase: u32 = elementIndex * GPS_PER_ELEM;
  let kBase: u32 = elementIndex * NUM_LOCAL_DOFS * NUM_LOCAL_DOFS;

  // Zero the output K_e.
  for (var idx: u32 = 0u; idx < NUM_LOCAL_DOFS * NUM_LOCAL_DOFS; idx = idx + 1u) {
    kOut[kBase + idx] = vec2<f32>(0.0, 0.0);
  }

  for (var g: u32 = 0u; g < GPS_PER_ELEM; g = g + 1u) {
    let bBase: u32 = bBaseElem + g * STRAIN_DIM * NUM_LOCAL_DOFS;
    let dBase: u32 = dBaseElem + g * 9u;
    let wDet: vec2<f32> = gpWeights[weightBase + g];
    // D matrix entries: D[i][j] at dBase + 3*i + j.
    let d00: vec2<f32> = tangents[dBase + 0u];
    let d01: vec2<f32> = tangents[dBase + 1u];
    let d02: vec2<f32> = tangents[dBase + 2u];
    let d10: vec2<f32> = tangents[dBase + 3u];
    let d11: vec2<f32> = tangents[dBase + 4u];
    let d12: vec2<f32> = tangents[dBase + 5u];
    let d20: vec2<f32> = tangents[dBase + 6u];
    let d21: vec2<f32> = tangents[dBase + 7u];
    let d22: vec2<f32> = tangents[dBase + 8u];

    // K_e += wDet · B^T · D · B
    for (var i: u32 = 0u; i < NUM_LOCAL_DOFS; i = i + 1u) {
      let bi0: vec2<f32> = bMatrices[bBase + 0u * NUM_LOCAL_DOFS + i];
      let bi1: vec2<f32> = bMatrices[bBase + 1u * NUM_LOCAL_DOFS + i];
      let bi2: vec2<f32> = bMatrices[bBase + 2u * NUM_LOCAL_DOFS + i];
      // D · B[:, i] computed once per j-loop:
      // (D B)_r = Σ_c D[r][c] B[c][i]
      let dbCol0: vec2<f32> = dsAdd(dsAdd(dsMul(d00, bi0), dsMul(d01, bi1)), dsMul(d02, bi2));
      let dbCol1: vec2<f32> = dsAdd(dsAdd(dsMul(d10, bi0), dsMul(d11, bi1)), dsMul(d12, bi2));
      let dbCol2: vec2<f32> = dsAdd(dsAdd(dsMul(d20, bi0), dsMul(d21, bi1)), dsMul(d22, bi2));
      for (var j: u32 = 0u; j < NUM_LOCAL_DOFS; j = j + 1u) {
        let bj0: vec2<f32> = bMatrices[bBase + 0u * NUM_LOCAL_DOFS + j];
        let bj1: vec2<f32> = bMatrices[bBase + 1u * NUM_LOCAL_DOFS + j];
        let bj2: vec2<f32> = bMatrices[bBase + 2u * NUM_LOCAL_DOFS + j];
        // Wait: B^T D B at (i,j) needs Σ_r B[r][i] (D B)[:,j]. The above
        // computes (D B)[:,i] — we need (D B)[:,j].  Recompute per (i,j):
        let _unused: u32 = j; // suppress unused warning when WGSL impls flag it
        let cb0: vec2<f32> = dsAdd(dsAdd(dsMul(d00, bj0), dsMul(d01, bj1)), dsMul(d02, bj2));
        let cb1: vec2<f32> = dsAdd(dsAdd(dsMul(d10, bj0), dsMul(d11, bj1)), dsMul(d12, bj2));
        let cb2: vec2<f32> = dsAdd(dsAdd(dsMul(d20, bj0), dsMul(d21, bj1)), dsMul(d22, bj2));
        let kij: vec2<f32> = dsAdd(dsAdd(dsMul(bi0, cb0), dsMul(bi1, cb1)), dsMul(bi2, cb2));
        let scaled: vec2<f32> = dsMul(wDet, kij);
        let outIdx: u32 = kBase + i * NUM_LOCAL_DOFS + j;
        kOut[outIdx] = dsAdd(kOut[outIdx], scaled);
      }
    }
  }
}
`;
}

export const KERNEL_STIFFNESS_T3_WGSL = makeStiffnessKernel(6, 1);
export const KERNEL_STIFFNESS_T6_WGSL = makeStiffnessKernel(12, 3);

// =============================================================================
// CPU references for parity testing.
// =============================================================================

import { dsAdd, dsMul, dsFromF64, dsToF64 } from './ds.js';
import { liftF64, lowerDs } from './blas.js';

// Compute element strain at every GP (CPU reference matching the WGSL kernel).
//
// Inputs (DS):
//   uvec        : DS array length N (global displacement vector)
//   bMatrices   : flat DS array, see makeStrainKernel layout
//   dofMap      : Int32Array length numElements * numLocalDofs (negative => skip)
//   numElements, gpsPerElem, numLocalDofs
//
// Output:
//   strain[gp * 3 + 0..2] in DS form.
export function cpuRefElementStrain({ uvec, bMatrices, dofMap, numElements, gpsPerElem, numLocalDofs }) {
  const STRAIN_DIM = 3;
  const totalGp = numElements * gpsPerElem;
  const out = new Array(totalGp * STRAIN_DIM);
  for (let gp = 0; gp < totalGp; gp += 1) {
    const elementIndex = (gp / gpsPerElem) | 0;
    const gpInElement = gp - elementIndex * gpsPerElem;
    const bBase = elementIndex * gpsPerElem * STRAIN_DIM * numLocalDofs
                  + gpInElement * STRAIN_DIM * numLocalDofs;
    const dBase = elementIndex * numLocalDofs;
    let exx = [0, 0], eyy = [0, 0], gxy = [0, 0];
    for (let d = 0; d < numLocalDofs; d += 1) {
      const dofIdx = dofMap[dBase + d];
      if (dofIdx < 0) continue;
      const u_d = uvec[dofIdx];
      const b_xx = bMatrices[bBase + 0 * numLocalDofs + d];
      const b_yy = bMatrices[bBase + 1 * numLocalDofs + d];
      const b_xy = bMatrices[bBase + 2 * numLocalDofs + d];
      exx = dsAdd(exx, dsMul(b_xx, u_d));
      eyy = dsAdd(eyy, dsMul(b_yy, u_d));
      gxy = dsAdd(gxy, dsMul(b_xy, u_d));
    }
    out[gp * STRAIN_DIM + 0] = exx;
    out[gp * STRAIN_DIM + 1] = eyy;
    out[gp * STRAIN_DIM + 2] = gxy;
  }
  return out;
}

export function cpuRefElementInternalForce({ bMatrices, gpWeights, stress, numElements, gpsPerElem, numLocalDofs }) {
  const STRAIN_DIM = 3;
  const out = new Array(numElements * numLocalDofs);
  for (let elementIndex = 0; elementIndex < numElements; elementIndex += 1) {
    const bBaseElem = elementIndex * gpsPerElem * STRAIN_DIM * numLocalDofs;
    const stressBase = elementIndex * gpsPerElem * STRAIN_DIM;
    const weightBase = elementIndex * gpsPerElem;
    const forceBase = elementIndex * numLocalDofs;
    for (let d = 0; d < numLocalDofs; d += 1) out[forceBase + d] = [0, 0];
    for (let g = 0; g < gpsPerElem; g += 1) {
      const bBase = bBaseElem + g * STRAIN_DIM * numLocalDofs;
      const wDet = gpWeights[weightBase + g];
      const sxx = stress[stressBase + g * STRAIN_DIM + 0];
      const syy = stress[stressBase + g * STRAIN_DIM + 1];
      const sxy = stress[stressBase + g * STRAIN_DIM + 2];
      for (let d = 0; d < numLocalDofs; d += 1) {
        const b_xx = bMatrices[bBase + 0 * numLocalDofs + d];
        const b_yy = bMatrices[bBase + 1 * numLocalDofs + d];
        const b_xy = bMatrices[bBase + 2 * numLocalDofs + d];
        const term = dsAdd(dsAdd(dsMul(b_xx, sxx), dsMul(b_yy, syy)), dsMul(b_xy, sxy));
        out[forceBase + d] = dsAdd(out[forceBase + d], dsMul(wDet, term));
      }
    }
  }
  return out;
}

export function cpuRefElementStiffness({ bMatrices, gpWeights, tangents, numElements, gpsPerElem, numLocalDofs }) {
  const STRAIN_DIM = 3;
  const out = new Array(numElements * numLocalDofs * numLocalDofs);
  for (let elementIndex = 0; elementIndex < numElements; elementIndex += 1) {
    const bBaseElem = elementIndex * gpsPerElem * STRAIN_DIM * numLocalDofs;
    const dBaseElem = elementIndex * gpsPerElem * 9;
    const weightBase = elementIndex * gpsPerElem;
    const kBase = elementIndex * numLocalDofs * numLocalDofs;
    for (let idx = 0; idx < numLocalDofs * numLocalDofs; idx += 1) out[kBase + idx] = [0, 0];
    for (let g = 0; g < gpsPerElem; g += 1) {
      const bBase = bBaseElem + g * STRAIN_DIM * numLocalDofs;
      const dBase = dBaseElem + g * 9;
      const wDet = gpWeights[weightBase + g];
      const D = [[tangents[dBase + 0], tangents[dBase + 1], tangents[dBase + 2]],
                 [tangents[dBase + 3], tangents[dBase + 4], tangents[dBase + 5]],
                 [tangents[dBase + 6], tangents[dBase + 7], tangents[dBase + 8]]];
      for (let i = 0; i < numLocalDofs; i += 1) {
        const Bi = [bMatrices[bBase + 0 * numLocalDofs + i],
                    bMatrices[bBase + 1 * numLocalDofs + i],
                    bMatrices[bBase + 2 * numLocalDofs + i]];
        for (let j = 0; j < numLocalDofs; j += 1) {
          const Bj = [bMatrices[bBase + 0 * numLocalDofs + j],
                      bMatrices[bBase + 1 * numLocalDofs + j],
                      bMatrices[bBase + 2 * numLocalDofs + j]];
          // (D B_j)_r = Σ_c D[r][c] B_j[c]
          const cb0 = dsAdd(dsAdd(dsMul(D[0][0], Bj[0]), dsMul(D[0][1], Bj[1])), dsMul(D[0][2], Bj[2]));
          const cb1 = dsAdd(dsAdd(dsMul(D[1][0], Bj[0]), dsMul(D[1][1], Bj[1])), dsMul(D[1][2], Bj[2]));
          const cb2 = dsAdd(dsAdd(dsMul(D[2][0], Bj[0]), dsMul(D[2][1], Bj[1])), dsMul(D[2][2], Bj[2]));
          const kij = dsAdd(dsAdd(dsMul(Bi[0], cb0), dsMul(Bi[1], cb1)), dsMul(Bi[2], cb2));
          out[kBase + i * numLocalDofs + j] = dsAdd(out[kBase + i * numLocalDofs + j], dsMul(wDet, kij));
        }
      }
    }
  }
  return out;
}
