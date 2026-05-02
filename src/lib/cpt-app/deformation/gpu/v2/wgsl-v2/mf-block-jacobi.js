// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Matrix-free 2×2 nodal block-Jacobi preconditioner (WGSL).
// =============================================================================
//
// Two kernels:
//
//   1. KERNEL_MF_BLOCK_DIAG_BUILD_WGSL
//        Per-element kernel that, for every pair of LOCAL DOFs (i, j) sharing
//        an element, computes the (i, j) entry of K_e and writes it to a
//        per-element block-pattern scratch buffer.  One thread per element.
//
//        Output: kBlockElem[e * (numLocalDofs * numLocalDofs)] = K_e[i,j] DS.
//
//   2. KERNEL_MF_BLOCK_JACOBI_INVERT_WGSL
//        One thread per node-pair.  Reads the per-element K_e contributions
//        for the two free DOFs (2n, 2n+1) belonging to the same node, sums
//        them via the standard `forceIncPtr` / `forceIncList` pattern (see
//        the diag kernel), and inverts the resulting 2×2 block analytically:
//
//            M_n^{-1} = (1/det) [ d  -b ]
//                                [-c   a ]
//            where  [a b; c d] is the symmetric K nodal block.
//
// Apply kernel: KERNEL_MF_BLOCK_JACOBI_APPLY_WGSL
//        z[2n]   = a r[2n]   + b r[2n+1]
//        z[2n+1] = c r[2n]   + d r[2n+1]
//
// The pack format is identical to v1's `packDsBlockJacobi`: 4 DS values per
// node-pair (a, b, c, d) of the inverse block.  Apply matches v1's
// `KERNEL_BLOCK_JACOBI_WGSL` semantics so we can re-use any consumer code
// downstream.
//
// Note: this build kernel computes the FULL symmetric K_e per element on the
// fly, which is O(numLocalDofs²) per element — fine for the precompute stage,
// not in the inner CG loop.

import { DS_WGSL } from '../../wgsl/ds.js';

// -----------------------------------------------------------------------------
// Per-element K_e build → flat block scratch.  Runs once per Newton step
// (or once per linear solve if D changes).  One thread per element.
// -----------------------------------------------------------------------------
function makeBlockBuildKernel(numLocalDofs, gpsPerElem, dPack = 6) {
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

struct BlockBuildParams { numElements: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       bMatrices: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       gpWeights: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       dPerGp:    array<vec2<f32>>;
@group(0) @binding(3) var<storage, read_write> kElem:     array<vec2<f32>>;   // numElements * numLocalDofs² DS
@group(0) @binding(4) var<uniform>             params:    BlockBuildParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let e: u32 = gid.x;
  let numElements: u32 = arrayLength(&kElem) / (NUM_LOCAL_DOFS * NUM_LOCAL_DOFS);
  if (e >= numElements) { return; }

  let bBaseElem: u32  = e * GPS_PER_ELEM * STRAIN_DIM * NUM_LOCAL_DOFS;
  let dBaseElem: u32  = e * GPS_PER_ELEM * D_PACK;
  let wBaseElem: u32  = e * GPS_PER_ELEM;
  let kBase:     u32  = e * NUM_LOCAL_DOFS * NUM_LOCAL_DOFS;

  var Ke: array<vec2<f32>, ${numLocalDofs * numLocalDofs}>;
  for (var k: u32 = 0u; k < NUM_LOCAL_DOFS * NUM_LOCAL_DOFS; k = k + 1u) {
    Ke[k] = vec2<f32>(0.0, 0.0);
  }

  for (var g: u32 = 0u; g < GPS_PER_ELEM; g = g + 1u) {
    let bBase: u32 = bBaseElem + g * STRAIN_DIM * NUM_LOCAL_DOFS;
    let dBase: u32 = dBaseElem + g * D_PACK;
    let wDet:  vec2<f32> = gpWeights[wBaseElem + g];
${loadD}
    for (var i: u32 = 0u; i < NUM_LOCAL_DOFS; i = i + 1u) {
      let bi_xx: vec2<f32> = bMatrices[bBase + 0u * NUM_LOCAL_DOFS + i];
      let bi_yy: vec2<f32> = bMatrices[bBase + 1u * NUM_LOCAL_DOFS + i];
      let bi_xy: vec2<f32> = bMatrices[bBase + 2u * NUM_LOCAL_DOFS + i];
      for (var j: u32 = 0u; j < NUM_LOCAL_DOFS; j = j + 1u) {
        let bj_xx: vec2<f32> = bMatrices[bBase + 0u * NUM_LOCAL_DOFS + j];
        let bj_yy: vec2<f32> = bMatrices[bBase + 1u * NUM_LOCAL_DOFS + j];
        let bj_xy: vec2<f32> = bMatrices[bBase + 2u * NUM_LOCAL_DOFS + j];
        // (D B_j)_r
        let cb0 = dsAdd(dsAdd(dsMul(D11, bj_xx), dsMul(D12, bj_yy)), dsMul(D13, bj_xy));
        let cb1 = dsAdd(dsAdd(dsMul(D21, bj_xx), dsMul(D22, bj_yy)), dsMul(D23, bj_xy));
        let cb2 = dsAdd(dsAdd(dsMul(D31, bj_xx), dsMul(D32, bj_yy)), dsMul(D33, bj_xy));
        let kij = dsAdd(dsAdd(dsMul(bi_xx, cb0), dsMul(bi_yy, cb1)), dsMul(bi_xy, cb2));
        let idx: u32 = i * NUM_LOCAL_DOFS + j;
        Ke[idx] = dsAdd(Ke[idx], dsMul(wDet, kij));
      }
    }
  }
  for (var k: u32 = 0u; k < NUM_LOCAL_DOFS * NUM_LOCAL_DOFS; k = k + 1u) {
    kElem[kBase + k] = Ke[k];
  }
}
`;
}

export const KERNEL_MF_BLOCK_BUILD_T3_WGSL = makeBlockBuildKernel(6, 1);
export const KERNEL_MF_BLOCK_BUILD_T6_WGSL = makeBlockBuildKernel(12, 3);
export const KERNEL_MF_BLOCK_BUILD_T3_TANGENT_WGSL = makeBlockBuildKernel(6, 1, 9);
export const KERNEL_MF_BLOCK_BUILD_T6_TANGENT_WGSL = makeBlockBuildKernel(12, 3, 9);

export const MF_BLOCK_BUILD_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'read-only-storage' },
    { binding: 3, type: 'storage' },
    { binding: 4, type: 'uniform' }
  ]
};

// -----------------------------------------------------------------------------
// Extract per-element diagonal entries from the already-built K_e scratch.
// This keeps block-Jacobi from recomputing B^T D B just to populate diagFree.
// The existing forceIncPtr/List scatter then reduces elemDiag to global diag.
// -----------------------------------------------------------------------------
function makeBlockDiagFromKElemKernel(numLocalDofs) {
  return /* wgsl */ `
struct BlockDiagParams { numElements: u32, _pad: vec3<u32> };

const NUM_LOCAL_DOFS: u32 = ${numLocalDofs}u;

@group(0) @binding(0) var<storage, read>       kElem:    array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> elemDiag: array<vec2<f32>>;
@group(0) @binding(2) var<uniform>             params:   BlockDiagParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let e: u32 = gid.x;
  let numFromK: u32 = arrayLength(&kElem) / (NUM_LOCAL_DOFS * NUM_LOCAL_DOFS);
  let numFromDiag: u32 = arrayLength(&elemDiag) / NUM_LOCAL_DOFS;
  let numElements: u32 = min(numFromK, numFromDiag);
  if (e >= numElements) { return; }
  let kBase: u32 = e * NUM_LOCAL_DOFS * NUM_LOCAL_DOFS;
  let dBase: u32 = e * NUM_LOCAL_DOFS;
  for (var d: u32 = 0u; d < NUM_LOCAL_DOFS; d = d + 1u) {
    elemDiag[dBase + d] = kElem[kBase + d * NUM_LOCAL_DOFS + d];
  }
}
`;
}

export const KERNEL_MF_BLOCK_DIAG_FROM_KELEM_T3_WGSL = makeBlockDiagFromKElemKernel(6);
export const KERNEL_MF_BLOCK_DIAG_FROM_KELEM_T6_WGSL = makeBlockDiagFromKElemKernel(12);

export const MF_BLOCK_DIAG_FROM_KELEM_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'storage' },
    { binding: 2, type: 'uniform' }
  ]
};

// -----------------------------------------------------------------------------
// Block-Jacobi inverter.  One thread per node-pair.
//
// Inputs:
//   kElem               : per-element K_e flat (numElements * numLocalDofs² DS)
//   nodePairOffPtrB/ListB: flat slots for K[first, second] off-diagonal.
//   nodePairOffPtrC/ListC: flat slots for K[second, first] off-diagonal.
//   nodePairFlags       : 1 bit per pair indicating "has both DOFs free" vs
//                         "only one free" (degenerate; falls back to scalar).
//   diagFree            : numFree DS — already-extracted diagonal of K
//                         (avoids a second sum here).
// Output:
//   blocksOut           : 4 DS values per node-pair (a, b, c, d) of M⁻¹.
// -----------------------------------------------------------------------------
export const KERNEL_MF_BLOCK_JACOBI_INVERT_WGSL = /* wgsl */ `
${DS_WGSL}

struct InvertParams { numNodePairs: u32, _pad: vec3<u32> };

const BLOCK_PIVOT_EPS: f32 = 1e-14;

@group(0) @binding(0) var<storage, read>       kElem:           array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       diagFree:        array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       nodePairOffPtrB:  array<u32>;
@group(0) @binding(3) var<storage, read>       nodePairOffListB: array<u32>;
@group(0) @binding(4) var<storage, read>       nodePairOffPtrC:  array<u32>;
@group(0) @binding(5) var<storage, read>       nodePairOffListC: array<u32>;
@group(0) @binding(6) var<storage, read>       nodePairFreeIdx:  array<u32>;   // 2 u32 per pair: (iFree, jFree); jFree = 0xFFFFFFFFu if only one
@group(0) @binding(7) var<storage, read_write> blocksOut:        array<vec2<f32>>;
@group(0) @binding(8) var<uniform>             params:           InvertParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n: u32 = gid.x;
  let offPairsB: u32 = select(0u, arrayLength(&nodePairOffPtrB) - 1u, arrayLength(&nodePairOffPtrB) > 0u);
  let offPairsC: u32 = select(0u, arrayLength(&nodePairOffPtrC) - 1u, arrayLength(&nodePairOffPtrC) > 0u);
  let numNodePairs: u32 = min(min(min(arrayLength(&blocksOut) / 4u, arrayLength(&nodePairFreeIdx) / 2u), offPairsB), offPairsC);
  if (n >= numNodePairs) { return; }
  let iFree: u32 = nodePairFreeIdx[2u * n + 0u];
  let jFree: u32 = nodePairFreeIdx[2u * n + 1u];
  if (iFree == 0xFFFFFFFFu) { return; }    // empty entry (no free DOFs)

	  let a: vec2<f32> = diagFree[iFree];

	  if (jFree == 0xFFFFFFFFu) {
	    // Only one DOF free → scalar Jacobi: M_inv = diag(1/a).
	    let aF64: f32 = a.x + a.y;
	    let aInv: vec2<f32> = select(vec2<f32>(1.0, 0.0), dsRecip(a), abs(aF64) > BLOCK_PIVOT_EPS);
	    blocksOut[4u * n + 0u] = aInv;
    blocksOut[4u * n + 1u] = vec2<f32>(0.0, 0.0);
    blocksOut[4u * n + 2u] = vec2<f32>(0.0, 0.0);
    blocksOut[4u * n + 3u] = vec2<f32>(1.0, 0.0);
    return;
  }

  let d: vec2<f32> = diagFree[jFree];

  // Off-diagonal entry: sum element contributions through the incidence list.
  let begin: u32 = nodePairOffPtrB[n];
  let end:   u32 = nodePairOffPtrB[n + 1u];
  var b: vec2<f32> = vec2<f32>(0.0, 0.0);
  for (var k: u32 = begin; k < end; k = k + 1u) {
    b = dsAdd(b, kElem[nodePairOffListB[k]]);
  }
  let beginC: u32 = nodePairOffPtrC[n];
  let endC:   u32 = nodePairOffPtrC[n + 1u];
  var c: vec2<f32> = vec2<f32>(0.0, 0.0);
  for (var k: u32 = beginC; k < endC; k = k + 1u) {
    c = dsAdd(c, kElem[nodePairOffListC[k]]);
  }

  // det = a*d - b*c
	  let ad: vec2<f32> = dsMul(a, d);
	  let bc: vec2<f32> = dsMul(b, c);
	  let det: vec2<f32> = dsSub(ad, bc);
	  let detF64: f32 = det.x + det.y;
	  let aF64: f32 = a.x + a.y;
	  let bF64: f32 = b.x + b.y;
	  let cF64: f32 = c.x + c.y;
	  let dF64: f32 = d.x + d.y;
	  let detScale: f32 = max(max(abs(aF64 * dF64), abs(bF64 * cF64)), 1.0);
	  if (abs(detF64) <= BLOCK_PIVOT_EPS * detScale) {
	    // Degenerate; fall back to scalar Jacobi on each diagonal.
	    let aInv: vec2<f32> = select(vec2<f32>(1.0, 0.0), dsRecip(a), abs(aF64) > BLOCK_PIVOT_EPS);
	    let dInv: vec2<f32> = select(vec2<f32>(1.0, 0.0), dsRecip(d), abs(dF64) > BLOCK_PIVOT_EPS);
    blocksOut[4u * n + 0u] = aInv;
    blocksOut[4u * n + 1u] = vec2<f32>(0.0, 0.0);
    blocksOut[4u * n + 2u] = vec2<f32>(0.0, 0.0);
    blocksOut[4u * n + 3u] = dInv;
    return;
  }
  let invDet: vec2<f32> = dsRecip(det);
  blocksOut[4u * n + 0u] = dsMul(d, invDet);                                     //  a' =  d/det
  blocksOut[4u * n + 1u] = dsMul(vec2<f32>(-b.x, -b.y), invDet);                 //  b' = -b/det
  blocksOut[4u * n + 2u] = dsMul(vec2<f32>(-c.x, -c.y), invDet);                 //  c' = -c/det
  blocksOut[4u * n + 3u] = dsMul(a, invDet);                                     //  d' =  a/det
}
`;

export const MF_BLOCK_JACOBI_INVERT_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'read-only-storage' },
    { binding: 3, type: 'read-only-storage' },
    { binding: 4, type: 'read-only-storage' },
    { binding: 5, type: 'read-only-storage' },
    { binding: 6, type: 'read-only-storage' },
    { binding: 7, type: 'storage' },
    { binding: 8, type: 'uniform' }
  ]
};

// -----------------------------------------------------------------------------
// Apply 2×2 block preconditioner.  One thread per free DOF.
// Each thread reads its (pairIndex, isSecond) lookup, fetches the block
// inverse, and computes z = a r + b r' or c r' + d r.
// -----------------------------------------------------------------------------
export const KERNEL_MF_BLOCK_JACOBI_APPLY_WGSL = /* wgsl */ `
${DS_WGSL}

struct ApplyParams { numFree: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       blocks:        array<vec2<f32>>;   // 4 DS per pair
@group(0) @binding(1) var<storage, read>       freeToPair:    array<u32>;          // per free DOF → pair index
@group(0) @binding(2) var<storage, read>       freeIsSecond:  array<u32>;          // per free DOF → 0 (first) or 1 (second slot in pair)
@group(0) @binding(3) var<storage, read>       freeMate:      array<u32>;          // per free DOF → mate's free-DOF index, or 0xFFFFFFFFu if no mate
@group(0) @binding(4) var<storage, read>       r:             array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> z:             array<vec2<f32>>;
@group(0) @binding(6) var<uniform>             params:        ApplyParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  let numFree: u32 = min(min(arrayLength(&r), arrayLength(&z)), min(arrayLength(&freeToPair), min(arrayLength(&freeIsSecond), arrayLength(&freeMate))));
  if (i >= numFree) { return; }
  let p: u32 = freeToPair[i];
  let isSecond: u32 = freeIsSecond[i];
  let mate: u32 = freeMate[i];
  let ri: vec2<f32> = r[i];
  if (mate == 0xFFFFFFFFu) {
    // Solo DOF: scalar Jacobi (a stored on slot 0 if isSecond==0, slot 3 otherwise).
    let coef: vec2<f32> = blocks[4u * p + (isSecond * 3u)];
    z[i] = dsMul(coef, ri);
    return;
  }
  let rj: vec2<f32> = r[mate];
  if (isSecond == 0u) {
    // first slot:  z = a·r + b·r_mate
    let a: vec2<f32> = blocks[4u * p + 0u];
    let b: vec2<f32> = blocks[4u * p + 1u];
    z[i] = dsAdd(dsMul(a, ri), dsMul(b, rj));
  } else {
    // second slot: z = c·r_mate + d·r
    let c: vec2<f32> = blocks[4u * p + 2u];
    let d: vec2<f32> = blocks[4u * p + 3u];
    z[i] = dsAdd(dsMul(c, rj), dsMul(d, ri));
  }
}
`;

export const MF_BLOCK_JACOBI_APPLY_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'read-only-storage' },
    { binding: 3, type: 'read-only-storage' },
    { binding: 4, type: 'read-only-storage' },
    { binding: 5, type: 'storage' },
    { binding: 6, type: 'uniform' }
  ]
};
