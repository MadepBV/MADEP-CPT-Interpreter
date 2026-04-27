// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Plastic-Newton helper kernels: strain-to-trial-stress and commit-state.
// =============================================================================
//
// strain-to-trial-stress kernel
// -----------------------------
//   Reads the current iteration's strain (Voigt-3 ε at every Gauss point), the
//   committed strain at the start of the load step, and the committed σ; emits
//   the Voigt-6 trial stress σ_trial that the MC return-mapping kernel
//   consumes.
//
//     Δε = ε_current − ε_committed
//     σ_trial = σ_committed + D_e · Δε
//
//   D_e is plane-strain isotropic (λ + 2G on the diagonal, λ off-diagonal,
//   G for the shear slot, σzz coupling via λ for plane-strain εzz=0).
//   All arithmetic is double-single.  The kernel is bandwidth-bound: the
//   computation is a handful of DS multiplies/additions per Gauss point.
//
// commit-state kernel
// -------------------
//   After Newton converges for a load step, this kernel persists the post-
//   return σ and the current strain into the committed buffers, plus the
//   branch id used.  Trivial copy, one thread per Gauss point.  Run *once*
//   per accepted load increment — never per Newton iteration, never per
//   line-search backtrack.
//
// Both kernels share the matIndex/matParams readonly buffers with the rest of
// the GPU resident pipeline.
// =============================================================================

import { DS_WGSL } from './ds.js';
import {
  dsAdd, dsMul, dsNeg, dsFromF64, dsToF64
} from './ds.js';

// -----------------------------------------------------------------------------
// strain-to-trial-stress
// -----------------------------------------------------------------------------
export const KERNEL_STRAIN_TO_TRIAL_STRESS_WGSL = /* wgsl */ `
${DS_WGSL}

struct PlasticTrialParams { numGp: u32, _pad0: u32, _pad1: u32, _pad2: u32 };

@group(0) @binding(0) var<storage, read>       strain:           array<vec2<f32>>; // 3 DS / GP
@group(0) @binding(1) var<storage, read>       strainCommitted:  array<vec2<f32>>; // 3 DS / GP
@group(0) @binding(2) var<storage, read>       sigmaCommitted:   array<vec2<f32>>; // 6 DS / GP
@group(0) @binding(3) var<storage, read>       matIndex:         array<u32>;
@group(0) @binding(4) var<storage, read>       matParams:        array<vec2<f32>>; // 8 DS / material
@group(0) @binding(5) var<storage, read_write> sigmaTrial:       array<vec2<f32>>; // 6 DS / GP, output
@group(0) @binding(6) var<uniform>             params: PlasticTrialParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  if (gp >= params.numGp) { return; }

  // Read current and committed strain (Voigt-3 in-plane).  γxy is engineering shear.
  let exx_k: vec2<f32> = strain[gp * 3u + 0u];
  let eyy_k: vec2<f32> = strain[gp * 3u + 1u];
  let gxy_k: vec2<f32> = strain[gp * 3u + 2u];
  let exx_c: vec2<f32> = strainCommitted[gp * 3u + 0u];
  let eyy_c: vec2<f32> = strainCommitted[gp * 3u + 1u];
  let gxy_c: vec2<f32> = strainCommitted[gp * 3u + 2u];

  // Δε = current − committed.
  let dexx: vec2<f32> = dsAdd(exx_k, dsNeg(exx_c));
  let deyy: vec2<f32> = dsAdd(eyy_k, dsNeg(eyy_c));
  let dgxy: vec2<f32> = dsAdd(gxy_k, dsNeg(gxy_c));

  // Material constants.
  let mi: u32 = matIndex[gp];
  let KBulk:  vec2<f32> = matParams[mi * 8u + 6u];
  let G:      vec2<f32> = matParams[mi * 8u + 7u];
  let twoThirds: vec2<f32> = vec2<f32>(0.6666666666666666, 0.0);
  let two:       vec2<f32> = vec2<f32>(2.0, 0.0);
  let lambda: vec2<f32> = dsAdd(KBulk, dsNeg(dsMul(twoThirds, G)));
  let twoG:   vec2<f32> = dsMul(two, G);
  let lpTwoG: vec2<f32> = dsAdd(lambda, twoG);

  // Δσ = D_e · Δε  (plane-strain Voigt-3 form, with σzz from λ(εxx+εyy)).
  let dsxx: vec2<f32> = dsAdd(dsMul(lpTwoG, dexx), dsMul(lambda, deyy));
  let dsyy: vec2<f32> = dsAdd(dsMul(lambda, dexx), dsMul(lpTwoG, deyy));
  let dsxy: vec2<f32> = dsMul(G, dgxy);
  let dszz: vec2<f32> = dsMul(lambda, dsAdd(dexx, deyy));

  // σ_trial = σ_committed + Δσ  (Voigt-6 with εzz=0 plane-strain σzz, no yz/xz).
  let sxx_c: vec2<f32> = sigmaCommitted[gp * 6u + 0u];
  let syy_c: vec2<f32> = sigmaCommitted[gp * 6u + 1u];
  let szz_c: vec2<f32> = sigmaCommitted[gp * 6u + 2u];
  let sxy_c: vec2<f32> = sigmaCommitted[gp * 6u + 3u];

  sigmaTrial[gp * 6u + 0u] = dsAdd(sxx_c, dsxx);
  sigmaTrial[gp * 6u + 1u] = dsAdd(syy_c, dsyy);
  sigmaTrial[gp * 6u + 2u] = dsAdd(szz_c, dszz);
  sigmaTrial[gp * 6u + 3u] = dsAdd(sxy_c, dsxy);
  sigmaTrial[gp * 6u + 4u] = vec2<f32>(0.0, 0.0);
  sigmaTrial[gp * 6u + 5u] = vec2<f32>(0.0, 0.0);
}
`;

export const STRAIN_TO_TRIAL_STRESS_LAYOUT = {
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

// -----------------------------------------------------------------------------
// commit-state
// -----------------------------------------------------------------------------
export const KERNEL_COMMIT_STATE_WGSL = /* wgsl */ `
struct CommitParams { numGp: u32, _pad0: u32, _pad1: u32, _pad2: u32 };

@group(0) @binding(0) var<storage, read>       sigmaReturned:        array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       strain:               array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       branchKind:           array<u32>;
@group(0) @binding(3) var<storage, read_write> sigmaCommitted:       array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> strainCommitted:      array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> branchHistory:        array<u32>;
@group(0) @binding(6) var<uniform>             params: CommitParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  if (gp >= params.numGp) { return; }
  // Voigt-6 σ commit.
  for (var k: u32 = 0u; k < 6u; k = k + 1u) {
    sigmaCommitted[gp * 6u + k] = sigmaReturned[gp * 6u + k];
  }
  // Voigt-3 ε commit.
  for (var k: u32 = 0u; k < 3u; k = k + 1u) {
    strainCommitted[gp * 3u + k] = strain[gp * 3u + k];
  }
  branchHistory[gp] = branchKind[gp];
}
`;

export const COMMIT_STATE_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'read-only-storage' },
    { binding: 3, type: 'storage' },
    { binding: 4, type: 'storage' },
    { binding: 5, type: 'storage' },
    { binding: 6, type: 'uniform' }
  ]
};

// =============================================================================
// CPU references — bit-for-bit equivalent of the WGSL kernels above.
// =============================================================================

// strain-to-trial-stress per Gauss point.
//
// strainDs:           Array<DS> length 3 * numGp
// strainCommittedDs:  Array<DS> length 3 * numGp
// sigmaCommittedDs:   Array<DS> length 6 * numGp
// matIndexI32:        Int32Array (or Uint32Array) length numGp
// matParamsDs:        Array<DS> length 8 * numMaterials
//
// Returns: Array<DS> length 6 * numGp.
export function cpuRefStrainToTrialStress({
  strainDs, strainCommittedDs, sigmaCommittedDs, matIndex, matParamsDs
}) {
  const numGp = strainDs.length / 3;
  const out = new Array(6 * numGp);
  const twoThirds = dsFromF64(2 / 3);
  const two = dsFromF64(2);
  for (let gp = 0; gp < numGp; gp += 1) {
    const exx_k = strainDs[gp * 3 + 0];
    const eyy_k = strainDs[gp * 3 + 1];
    const gxy_k = strainDs[gp * 3 + 2];
    const exx_c = strainCommittedDs[gp * 3 + 0];
    const eyy_c = strainCommittedDs[gp * 3 + 1];
    const gxy_c = strainCommittedDs[gp * 3 + 2];

    const dexx = dsAdd(exx_k, dsNeg(exx_c));
    const deyy = dsAdd(eyy_k, dsNeg(eyy_c));
    const dgxy = dsAdd(gxy_k, dsNeg(gxy_c));

    const mi = matIndex[gp];
    const KBulk = matParamsDs[mi * 8 + 6];
    const G     = matParamsDs[mi * 8 + 7];
    const lambda = dsAdd(KBulk, dsNeg(dsMul(twoThirds, G)));
    const twoG = dsMul(two, G);
    const lpTwoG = dsAdd(lambda, twoG);

    const dsxx = dsAdd(dsMul(lpTwoG, dexx), dsMul(lambda, deyy));
    const dsyy = dsAdd(dsMul(lambda, dexx), dsMul(lpTwoG, deyy));
    const dsxy = dsMul(G, dgxy);
    const dszz = dsMul(lambda, dsAdd(dexx, deyy));

    const sxx_c = sigmaCommittedDs[gp * 6 + 0];
    const syy_c = sigmaCommittedDs[gp * 6 + 1];
    const szz_c = sigmaCommittedDs[gp * 6 + 2];
    const sxy_c = sigmaCommittedDs[gp * 6 + 3];

    out[gp * 6 + 0] = dsAdd(sxx_c, dsxx);
    out[gp * 6 + 1] = dsAdd(syy_c, dsyy);
    out[gp * 6 + 2] = dsAdd(szz_c, dszz);
    out[gp * 6 + 3] = dsAdd(sxy_c, dsxy);
    out[gp * 6 + 4] = [0, 0];
    out[gp * 6 + 5] = [0, 0];
  }
  return out;
}

// commit-state CPU reference.
export function cpuRefCommitState({
  sigmaReturnedDs, strainDs, branchKind,
  sigmaCommittedDs, strainCommittedDs, branchHistory
}) {
  const numGp = sigmaReturnedDs.length / 6;
  for (let gp = 0; gp < numGp; gp += 1) {
    for (let k = 0; k < 6; k += 1) {
      sigmaCommittedDs[gp * 6 + k] = sigmaReturnedDs[gp * 6 + k];
    }
    for (let k = 0; k < 3; k += 1) {
      strainCommittedDs[gp * 3 + k] = strainDs[gp * 3 + k];
    }
    branchHistory[gp] = branchKind[gp];
  }
}
