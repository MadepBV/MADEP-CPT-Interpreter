// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Plastic-trial-stress kernel (WGSL).
// =============================================================================
//
// For each Gauss point, compute the elastic trial stress increment from the
// strain increment Δε relative to the committed reference configuration:
//
//   σ_trial[gp]  =  σ_committed[gp]  +  D_e[gp] · Δε[gp]
//
// where D_e is the elastic plane-strain stiffness derived from the GP's
// material (KBulk, G):
//
//   λ  = K - (2/3) G          → λ + 2G  on the diagonal in-plane;
//                                λ      on the off-diagonal in-plane;
//                                G      on the shear;
//                                σ_zz   = λ (ε_xx + ε_yy)  for plane strain.
//
// Δε is the strain Voigt-3 increment from `mf-element-strain` applied to
// (u - u₀).  σ_committed is held in a Voigt-6 buffer.
//
// One thread per Gauss point.

import { DS_WGSL } from '../../wgsl/ds.js';

export const KERNEL_MF_TRIAL_STRESS_WGSL = /* wgsl */ `
${DS_WGSL}

const STRAIN_DIM: u32 = 3u;
const VOIGT6: u32 = 6u;

struct TrialParams { numGp: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       sigmaCommitted: array<vec2<f32>>;  // 6 DS per GP (Voigt-6, tension-positive)
@group(0) @binding(1) var<storage, read>       deltaEps:       array<vec2<f32>>;  // 3 DS per GP (Voigt-3)
@group(0) @binding(2) var<storage, read>       matParams:      array<vec2<f32>>;  // 8 DS per material; slot 6 = K, 7 = G
@group(0) @binding(3) var<storage, read>       matIndex:       array<u32>;        // matIdx per GP
@group(0) @binding(4) var<storage, read_write> sigmaTrial:     array<vec2<f32>>;  // 6 DS per GP (Voigt-6, tension-positive)
@group(0) @binding(5) var<uniform>             params:         TrialParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  let numGp: u32 = min(min(arrayLength(&matIndex), arrayLength(&deltaEps) / STRAIN_DIM), min(arrayLength(&sigmaCommitted), arrayLength(&sigmaTrial)) / VOIGT6);
  if (gp >= numGp) { return; }
  let mi: u32 = matIndex[gp];
  let K: vec2<f32> = matParams[mi * 8u + 6u];
  let G: vec2<f32> = matParams[mi * 8u + 7u];
  let two_thirds: vec2<f32> = vec2<f32>(0.66666669, -3.9736431e-9);
  let two:        vec2<f32> = vec2<f32>(2.0, 0.0);
  let lambda:     vec2<f32> = dsSub(K, dsMul(two_thirds, G));
  let twoG:       vec2<f32> = dsMul(two, G);
  let lamPlus2G:  vec2<f32> = dsAdd(lambda, twoG);

  let exx: vec2<f32> = deltaEps[gp * STRAIN_DIM + 0u];
  let eyy: vec2<f32> = deltaEps[gp * STRAIN_DIM + 1u];
  let gxy: vec2<f32> = deltaEps[gp * STRAIN_DIM + 2u];

  // σ_e = D · ε   (plane strain isotropic; in-plane terms as elsewhere; out-of-plane σ_zz = λ(εxx+εyy))
  let dSigXX: vec2<f32> = dsAdd(dsMul(lamPlus2G, exx), dsMul(lambda, eyy));
  let dSigYY: vec2<f32> = dsAdd(dsMul(lambda, exx), dsMul(lamPlus2G, eyy));
  let dSigZZ: vec2<f32> = dsMul(lambda, dsAdd(exx, eyy));
  let dSigXY: vec2<f32> = dsMul(G, gxy);   // G·γxy since γxy = 2 εxy

  let base: u32 = gp * VOIGT6;
  sigmaTrial[base + 0u] = dsAdd(sigmaCommitted[base + 0u], dSigXX);
  sigmaTrial[base + 1u] = dsAdd(sigmaCommitted[base + 1u], dSigYY);
  sigmaTrial[base + 2u] = dsAdd(sigmaCommitted[base + 2u], dSigZZ);
  sigmaTrial[base + 3u] = dsAdd(sigmaCommitted[base + 3u], dSigXY);
  sigmaTrial[base + 4u] = sigmaCommitted[base + 4u];   // σ_yz unchanged in plane strain
  sigmaTrial[base + 5u] = sigmaCommitted[base + 5u];   // σ_xz unchanged
}
`;

export const MF_TRIAL_STRESS_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'read-only-storage' },
    { binding: 3, type: 'read-only-storage' },
    { binding: 4, type: 'storage' },
    { binding: 5, type: 'uniform' }
  ]
};
