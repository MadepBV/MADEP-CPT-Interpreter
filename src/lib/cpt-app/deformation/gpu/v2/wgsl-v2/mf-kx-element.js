// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Matrix-free element Kx kernel (WGSL).
// =============================================================================
//
// Computes  y_e = K_e · u_e  per element, scatters to a per-element scratch
// buffer.  A separate node-side kernel sums the scatter into the global y
// vector via the same `forceIncPtr` / `forceIncList` incidence used by v1's
// internal-force scatter.
//
// One thread per element.  The element loops its own GPs and accumulates
//
//     y_e[d] = Σ_g  w_g · |J_g| · Σ_{i,j}  B[g,i,d] · D[g,i,j] · (B[g,j,:] · u_e)
//
// in a local register array of length numLocalDofs.  All arithmetic is DS.
//
// D is stored either as 6 DS per GP, packed in the symmetric (3×3) Voigt form
//     D[gp, 0] = D11   D[gp, 1] = D12   D[gp, 2] = D13
//     D[gp, 3] = D22   D[gp, 4] = D23
//     D[gp, 5] = D33
// or as 9 DS per GP, row-major full 3×3 algorithmic tangent
//     D11 D12 D13
//     D21 D22 D23
//     D31 D32 D33
// The 9-slot path is used by the production plastic v2 route.  The 6-slot
// path remains for elastic parity tests and explicit elastic-tangent fallback.
//
// u_e is gathered from the global free-DOF vector through `dofMap` (Int32, -1
// for constrained DOFs which are clamped to zero — Dirichlet handling).
//
// Output: `kxOut` of length numElements * numLocalDofs (DS).  The downstream
// `KERNEL_SCATTER_FREE_RHS_WGSL` kernel from v1 sums these into the global
// free-DOF y vector through the existing `forceIncPtr`/`forceIncList` arrays.
//
// Note on units & sign: this matches v1's convention where K_e is the tangent
// stiffness in free-DOF space and the ScatterFreeRhs kernel sums per element
// contributions for each free DOF.

import { DS_WGSL } from '../../wgsl/ds.js';

function makeMfKxKernel(numLocalDofs, gpsPerElem, dPack = 6) {
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

struct MfKxParams {
  numElements: u32,
  _pad: vec3<u32>
};

@group(0) @binding(0) var<storage, read>       uvec:      array<vec2<f32>>;   // global free-DOF u (DS)
@group(0) @binding(1) var<storage, read>       bMatrices: array<vec2<f32>>;   // element B-pack (DS)
@group(0) @binding(2) var<storage, read>       gpWeights: array<vec2<f32>>;   // w·|J| per GP (DS)
@group(0) @binding(3) var<storage, read>       dPerGp:    array<vec2<f32>>;   // D matrix per GP (6 DS each)
@group(0) @binding(4) var<storage, read>       dofMap:    array<i32>;         // (elem, localDof) → free DOF or -1
@group(0) @binding(5) var<storage, read_write> kxOut:     array<vec2<f32>>;   // numElements * numLocalDofs (DS)
@group(0) @binding(6) var<uniform>             params:    MfKxParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let e: u32 = gid.x;
  let numElements: u32 = min(arrayLength(&kxOut) / NUM_LOCAL_DOFS, arrayLength(&dofMap) / NUM_LOCAL_DOFS);
  if (e >= numElements) { return; }

  let bBaseElem: u32  = e * GPS_PER_ELEM * STRAIN_DIM * NUM_LOCAL_DOFS;
  let dBaseElem: u32  = e * GPS_PER_ELEM * D_PACK;
  let wBaseElem: u32  = e * GPS_PER_ELEM;
  let dofBase:   u32  = e * NUM_LOCAL_DOFS;
  let outBase:   u32  = e * NUM_LOCAL_DOFS;

  // Gather element nodal displacements (constrained DOFs clamped to 0).
  var u_e: array<vec2<f32>, ${numLocalDofs}>;
  for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
    let dofIdx: i32 = dofMap[dofBase + d];
    if (dofIdx < 0) {
      u_e[d] = vec2<f32>(0.0, 0.0);
    } else {
      u_e[d] = uvec[u32(dofIdx)];
    }
  }

  // Element output accumulator.
  var ke_u: array<vec2<f32>, ${numLocalDofs}>;
  for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
    ke_u[d] = vec2<f32>(0.0, 0.0);
  }

  for (var g: u32 = 0u; g < GPS_PER_ELEM; g = g + 1u) {
    let bBase: u32 = bBaseElem + g * STRAIN_DIM * NUM_LOCAL_DOFS;
    let dBase: u32 = dBaseElem + g * D_PACK;
    let wDet:  vec2<f32> = gpWeights[wBaseElem + g];

    // Step 1: strain = B u_e   (3 DS)
    var eps_xx: vec2<f32> = vec2<f32>(0.0, 0.0);
    var eps_yy: vec2<f32> = vec2<f32>(0.0, 0.0);
    var eps_xy: vec2<f32> = vec2<f32>(0.0, 0.0);
    for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
      let b_xx: vec2<f32> = bMatrices[bBase + 0u * NUM_LOCAL_DOFS + d];
      let b_yy: vec2<f32> = bMatrices[bBase + 1u * NUM_LOCAL_DOFS + d];
      let b_xy: vec2<f32> = bMatrices[bBase + 2u * NUM_LOCAL_DOFS + d];
      eps_xx = dsAdd(eps_xx, dsMul(b_xx, u_e[d]));
      eps_yy = dsAdd(eps_yy, dsMul(b_yy, u_e[d]));
      eps_xy = dsAdd(eps_xy, dsMul(b_xy, u_e[d]));
    }

    // Step 2: stress increment = D · ε  (3 DS)
${loadD}
    let s_xx: vec2<f32> = dsAdd(dsAdd(dsMul(D11, eps_xx), dsMul(D12, eps_yy)), dsMul(D13, eps_xy));
    let s_yy: vec2<f32> = dsAdd(dsAdd(dsMul(D21, eps_xx), dsMul(D22, eps_yy)), dsMul(D23, eps_xy));
    let s_xy: vec2<f32> = dsAdd(dsAdd(dsMul(D31, eps_xx), dsMul(D32, eps_yy)), dsMul(D33, eps_xy));

    // Step 3: ke_u_d += w |J| · (B^T σ)_d for each local DOF.
    let sigma_xx: vec2<f32> = dsMul(wDet, s_xx);
    let sigma_yy: vec2<f32> = dsMul(wDet, s_yy);
    let sigma_xy: vec2<f32> = dsMul(wDet, s_xy);
    for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
      let b_xx: vec2<f32> = bMatrices[bBase + 0u * NUM_LOCAL_DOFS + d];
      let b_yy: vec2<f32> = bMatrices[bBase + 1u * NUM_LOCAL_DOFS + d];
      let b_xy: vec2<f32> = bMatrices[bBase + 2u * NUM_LOCAL_DOFS + d];
      let term: vec2<f32> = dsAdd(dsAdd(dsMul(b_xx, sigma_xx), dsMul(b_yy, sigma_yy)), dsMul(b_xy, sigma_xy));
      ke_u[d] = dsAdd(ke_u[d], term);
    }
  }

  for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
    kxOut[outBase + d] = ke_u[d];
  }
}
`;
}

export const KERNEL_MF_KX_T3_WGSL = makeMfKxKernel(6, 1);
export const KERNEL_MF_KX_T6_WGSL = makeMfKxKernel(12, 3);
export const KERNEL_MF_KX_T3_TANGENT_WGSL = makeMfKxKernel(6, 1, 9);
export const KERNEL_MF_KX_T6_TANGENT_WGSL = makeMfKxKernel(12, 3, 9);

export const MF_KX_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' }, // uvec
    { binding: 1, type: 'read-only-storage' }, // bMatrices
    { binding: 2, type: 'read-only-storage' }, // gpWeights
    { binding: 3, type: 'read-only-storage' }, // dPerGp
    { binding: 4, type: 'read-only-storage' }, // dofMap
    { binding: 5, type: 'storage' },           // kxOut
    { binding: 6, type: 'uniform' }            // params
  ]
};
