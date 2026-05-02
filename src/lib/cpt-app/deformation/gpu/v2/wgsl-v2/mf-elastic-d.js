// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Elastic plane-strain D precompute (one-shot at upload).
// =============================================================================
//
// For each Gauss point, build the elastic plane-strain D matrix from the
// material's bulk modulus K and shear modulus G (already DS-packed in v1's
// `matParams` buffer at slots [matIdx*8 + 6] and [matIdx*8 + 7]).
//
//   λ  = K - (2/3) G
//   D11 = D22 = λ + 2G  =  K + (4/3) G
//   D12         = λ      =  K - (2/3) G
//   D33         = G
//   D13 = D23   = 0      (isotropic)
//
// Pack layout (6 DS per GP, matches `mf-kx-element.js` / `mf-jacobi-diag.js`):
//   D[gp,0] = D11   D[gp,1] = D12   D[gp,2] = D13
//   D[gp,3] = D22   D[gp,4] = D23   D[gp,5] = D33
//
// One thread per GP.

import { DS_WGSL } from '../../wgsl/ds.js';

export const KERNEL_MF_ELASTIC_D_WGSL = /* wgsl */ `
${DS_WGSL}

const D_PACK: u32 = 6u;

struct ElasticDParams { numGp: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       matParams: array<vec2<f32>>;   // 8 DS per material
@group(0) @binding(1) var<storage, read>       matIndex:  array<u32>;          // matIdx per GP
@group(0) @binding(2) var<storage, read_write> dPerGp:    array<vec2<f32>>;    // 6 DS per GP
@group(0) @binding(3) var<uniform>             params:    ElasticDParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  let numGp: u32 = min(arrayLength(&matIndex), arrayLength(&dPerGp) / D_PACK);
  if (gp >= numGp) { return; }
  let matIdx: u32 = matIndex[gp];
  let K: vec2<f32> = matParams[matIdx * 8u + 6u];
  let G: vec2<f32> = matParams[matIdx * 8u + 7u];

  // λ = K - (2/3) G        (DS arithmetic, IEEE-754 round-to-nearest split)
  let two_thirds: vec2<f32> = vec2<f32>(0.66666669, -3.9736431e-9);   // 2/3 ≈ 0.6666666666666666
  let two:        vec2<f32> = vec2<f32>(2.0, 0.0);

  let twoThirdG:  vec2<f32> = dsMul(two_thirds, G);
  let lambda:     vec2<f32> = dsSub(K, twoThirdG);
  let twoG:       vec2<f32> = dsMul(two, G);
  let lamPlus2G:  vec2<f32> = dsAdd(lambda, twoG);

  let base: u32 = gp * D_PACK;
  dPerGp[base + 0u] = lamPlus2G;                  // D11
  dPerGp[base + 1u] = lambda;                     // D12
  dPerGp[base + 2u] = vec2<f32>(0.0, 0.0);        // D13
  dPerGp[base + 3u] = lamPlus2G;                  // D22
  dPerGp[base + 4u] = vec2<f32>(0.0, 0.0);        // D23
  dPerGp[base + 5u] = G;                          // D33
}
`;

export const MF_ELASTIC_D_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'storage' },
    { binding: 3, type: 'uniform' }
  ]
};
