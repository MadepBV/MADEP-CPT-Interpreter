// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Matrix-free diagonal Jacobi preconditioner extraction.
// =============================================================================
//
// For each element, compute the diagonal of K_e:
//
//     diag(K_e)[d] = Σ_g  w_g · |J_g| · Σ_{i,j}  B[g,i,d] · D[g,i,j] · B[g,j,d]
//
// (i.e. (B^T D B)_{dd}, summed over GPs).  Writes to a per-element scratch
// buffer of length numElements * numLocalDofs (DS); the same node-side
// scatter (forceIncPtr / forceIncList) sums these into the global diag(K)
// vector.  The Jacobi preconditioner is then  M^{-1}_diag = 1 / diag(K).
//
// One thread per element.

import { DS_WGSL } from '../../wgsl/ds.js';

function makeMfDiagKernel(numLocalDofs, gpsPerElem, dPack = 6) {
  const full = dPack === 9;
  const loadD = full
    ? `
    let D11: vec2<f32> = dPerGp[dBase + 0u];
    let D12: vec2<f32> = dPerGp[dBase + 1u];
    let D13: vec2<f32> = dPerGp[dBase + 2u];
    let D21: vec2<f32> = dPerGp[dBase + 3u];
    let D22: vec2<f32> = dPerGp[dBase + 4u];
    let D23: vec2<f32> = dPerGp[dBase + 5u];
    let D31: vec2<f32> = dPerGp[dBase + 6u];
    let D32: vec2<f32> = dPerGp[dBase + 7u];
    let D33: vec2<f32> = dPerGp[dBase + 8u];`
    : `
    let D11: vec2<f32> = dPerGp[dBase + 0u];
    let D12: vec2<f32> = dPerGp[dBase + 1u];
    let D13: vec2<f32> = dPerGp[dBase + 2u];
    let D21: vec2<f32> = D12;
    let D22: vec2<f32> = dPerGp[dBase + 3u];
    let D23: vec2<f32> = dPerGp[dBase + 4u];
    let D31: vec2<f32> = D13;
    let D32: vec2<f32> = D23;
    let D33: vec2<f32> = dPerGp[dBase + 5u];`;
  return /* wgsl */ `
${DS_WGSL}

const NUM_LOCAL_DOFS: u32 = ${numLocalDofs}u;
const GPS_PER_ELEM:   u32 = ${gpsPerElem}u;
const STRAIN_DIM:     u32 = 3u;
const D_PACK:         u32 = ${dPack}u;

struct DiagParams { numElements: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       bMatrices: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       gpWeights: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       dPerGp:    array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> diagOut:   array<vec2<f32>>; // numElements * numLocalDofs
@group(0) @binding(4) var<uniform>             params:    DiagParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let e: u32 = gid.x;
  let numElements: u32 = arrayLength(&diagOut) / NUM_LOCAL_DOFS;
  if (e >= numElements) { return; }

  let bBaseElem: u32  = e * GPS_PER_ELEM * STRAIN_DIM * NUM_LOCAL_DOFS;
  let dBaseElem: u32  = e * GPS_PER_ELEM * D_PACK;
  let wBaseElem: u32  = e * GPS_PER_ELEM;
  let outBase:   u32  = e * NUM_LOCAL_DOFS;

  var diag_e: array<vec2<f32>, ${numLocalDofs}>;
  for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
    diag_e[d] = vec2<f32>(0.0, 0.0);
  }

  for (var g: u32 = 0u; g < GPS_PER_ELEM; g = g + 1u) {
    let bBase: u32 = bBaseElem + g * STRAIN_DIM * NUM_LOCAL_DOFS;
    let dBase: u32 = dBaseElem + g * D_PACK;
    let wDet:  vec2<f32> = gpWeights[wBaseElem + g];
${loadD}
    for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
      let b_xx: vec2<f32> = bMatrices[bBase + 0u * NUM_LOCAL_DOFS + d];
      let b_yy: vec2<f32> = bMatrices[bBase + 1u * NUM_LOCAL_DOFS + d];
      let b_xy: vec2<f32> = bMatrices[bBase + 2u * NUM_LOCAL_DOFS + d];
      let cb0: vec2<f32> = dsAdd(dsAdd(dsMul(D11, b_xx), dsMul(D12, b_yy)), dsMul(D13, b_xy));
      let cb1: vec2<f32> = dsAdd(dsAdd(dsMul(D21, b_xx), dsMul(D22, b_yy)), dsMul(D23, b_xy));
      let cb2: vec2<f32> = dsAdd(dsAdd(dsMul(D31, b_xx), dsMul(D32, b_yy)), dsMul(D33, b_xy));
      let dd: vec2<f32> = dsAdd(dsAdd(dsMul(b_xx, cb0), dsMul(b_yy, cb1)), dsMul(b_xy, cb2));
      diag_e[d] = dsAdd(diag_e[d], dsMul(wDet, dd));
    }
  }

  for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
    diagOut[outBase + d] = diag_e[d];
  }
}
`;
}

export const KERNEL_MF_DIAG_T3_WGSL = makeMfDiagKernel(6, 1);
export const KERNEL_MF_DIAG_T6_WGSL = makeMfDiagKernel(12, 3);
export const KERNEL_MF_DIAG_T3_TANGENT_WGSL = makeMfDiagKernel(6, 1, 9);
export const KERNEL_MF_DIAG_T6_TANGENT_WGSL = makeMfDiagKernel(12, 3, 9);

export const MF_DIAG_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'read-only-storage' },
    { binding: 3, type: 'storage' },
    { binding: 4, type: 'uniform' }
  ]
};

// -----------------------------------------------------------------------------
// Reciprocal kernel: Minv = 1 / diag(K), elementwise.
// One thread per free-DOF.
// -----------------------------------------------------------------------------
export const KERNEL_MF_RECIP_WGSL = /* wgsl */ `
${DS_WGSL}

struct RecipParams { n: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       diagIn:  array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> mInvOut: array<vec2<f32>>;
@group(0) @binding(2) var<uniform>             params:  RecipParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  let n: u32 = min(arrayLength(&diagIn), arrayLength(&mInvOut));
  if (i >= n) { return; }
  let d: vec2<f32> = diagIn[i];
  let dF64: f32 = d.x + d.y;          // safe-near-zero guard below
  if (abs(dF64) < 1e-30) {
    mInvOut[i] = vec2<f32>(1.0, 0.0); // benign; will only matter if diag truly zero
  } else {
    mInvOut[i] = dsRecip(d);
  }
}
`;

export const MF_RECIP_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'storage' },
    { binding: 2, type: 'uniform' }
  ]
};
