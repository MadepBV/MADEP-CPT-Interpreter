// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GPU pipeline v2 -- committed plastic-strain state update.
// =============================================================================
//
// After MC return mapping:
//
//   sigmaTrial - sigmaReturned = D_e * deltaEpsPlastic
//
// This kernel applies the isotropic compliance to that stress correction,
// stores the tensor plastic strain state, and accumulates the scalar
// equivalent plastic strain used by plotting/reporting. It is v2-only so the
// shared v1 MC return kernel and bind layout remain unchanged.

import { DS_WGSL } from '../../wgsl/ds.js';

export const KERNEL_MF_PLASTIC_STRAIN_WGSL = /* wgsl */ `
${DS_WGSL}

const VOIGT6: u32 = 6u;

@group(0) @binding(0) var<storage, read>       sigmaTrial:       array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       sigmaReturned:    array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       plasticCommitted: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read>       plasticEqCommitted: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read>       matParams:        array<vec2<f32>>;
@group(0) @binding(5) var<storage, read>       matIndex:         array<u32>;
@group(0) @binding(6) var<storage, read_write> plasticReturned:  array<vec2<f32>>;
@group(0) @binding(7) var<storage, read_write> plasticEqReturned: array<vec2<f32>>;

fn compliancePlasticIncrement(deltaSigma: array<vec2<f32>, 6>, K: vec2<f32>, G: vec2<f32>) -> array<vec2<f32>, 6> {
  let two: vec2<f32> = vec2<f32>(2.0, 0.0);
  let three: vec2<f32> = vec2<f32>(3.0, 0.0);
  let nine: vec2<f32> = vec2<f32>(9.0, 0.0);
  let denom: vec2<f32> = dsAdd(dsMul(three, K), G);
  let E: vec2<f32> = dsDiv(dsMul(nine, dsMul(K, G)), denom);
  let nu: vec2<f32> = dsDiv(dsSub(dsMul(three, K), dsMul(two, G)), dsMul(two, denom));
  let invE: vec2<f32> = dsRecip(E);
  let invG: vec2<f32> = dsRecip(G);

  var out: array<vec2<f32>, 6>;
  out[0] = dsMul(invE, dsSub(deltaSigma[0], dsMul(nu, dsAdd(deltaSigma[1], deltaSigma[2]))));
  out[1] = dsMul(invE, dsSub(deltaSigma[1], dsMul(nu, dsAdd(deltaSigma[0], deltaSigma[2]))));
  out[2] = dsMul(invE, dsSub(deltaSigma[2], dsMul(nu, dsAdd(deltaSigma[0], deltaSigma[1]))));
  out[3] = dsMul(invG, deltaSigma[3]);
  out[4] = dsMul(invG, deltaSigma[4]);
  out[5] = dsMul(invG, deltaSigma[5]);
  return out;
}

fn equivalentPlasticIncrement(deltaPlastic: array<vec2<f32>, 6>) -> vec2<f32> {
  let oneThird: vec2<f32> = vec2<f32>(0.33333334, -9.9341078e-9);
  let oneHalf: vec2<f32> = vec2<f32>(0.5, 0.0);
  let twoThirds: vec2<f32> = vec2<f32>(0.66666669, -3.9736431e-9);
  let mean: vec2<f32> = dsMul(oneThird, dsAdd(dsAdd(deltaPlastic[0], deltaPlastic[1]), deltaPlastic[2]));
  let d0: vec2<f32> = dsSub(deltaPlastic[0], mean);
  let d1: vec2<f32> = dsSub(deltaPlastic[1], mean);
  let d2: vec2<f32> = dsSub(deltaPlastic[2], mean);
  var normSq: vec2<f32> = dsAdd(dsAdd(dsMul(d0, d0), dsMul(d1, d1)), dsMul(d2, d2));
  normSq = dsAdd(normSq, dsMul(oneHalf, dsMul(deltaPlastic[3], deltaPlastic[3])));
  normSq = dsAdd(normSq, dsMul(oneHalf, dsMul(deltaPlastic[4], deltaPlastic[4])));
  normSq = dsAdd(normSq, dsMul(oneHalf, dsMul(deltaPlastic[5], deltaPlastic[5])));
  return dsSqrt(dsMul(twoThirds, normSq));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  let numGp: u32 = min(
    min(arrayLength(&matIndex), arrayLength(&plasticEqCommitted)),
    min(min(arrayLength(&sigmaTrial), arrayLength(&sigmaReturned)), min(arrayLength(&plasticCommitted), arrayLength(&plasticReturned))) / VOIGT6
  );
  if (gp >= numGp || gp >= arrayLength(&plasticEqReturned)) { return; }

  let mi: u32 = matIndex[gp];
  let K: vec2<f32> = matParams[mi * 8u + 6u];
  let G: vec2<f32> = matParams[mi * 8u + 7u];
  let base: u32 = gp * VOIGT6;

  var deltaSigma: array<vec2<f32>, 6>;
  for (var k: u32 = 0u; k < VOIGT6; k = k + 1u) {
    deltaSigma[k] = dsSub(sigmaTrial[base + k], sigmaReturned[base + k]);
  }
  let deltaPlastic: array<vec2<f32>, 6> = compliancePlasticIncrement(deltaSigma, K, G);
  let equivalentIncrement: vec2<f32> = equivalentPlasticIncrement(deltaPlastic);
  if (abs(equivalentIncrement.x) + abs(equivalentIncrement.y) <= 1.0e-9) {
    for (var k: u32 = 0u; k < VOIGT6; k = k + 1u) {
      plasticReturned[base + k] = plasticCommitted[base + k];
    }
    plasticEqReturned[gp] = plasticEqCommitted[gp];
    return;
  }
  for (var k: u32 = 0u; k < VOIGT6; k = k + 1u) {
    plasticReturned[base + k] = dsAdd(plasticCommitted[base + k], deltaPlastic[k]);
  }
  plasticEqReturned[gp] = dsAdd(plasticEqCommitted[gp], equivalentIncrement);
}
`;

export const MF_PLASTIC_STRAIN_LAYOUT = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'read-only-storage' },
    { binding: 3, type: 'read-only-storage' },
    { binding: 4, type: 'read-only-storage' },
    { binding: 5, type: 'read-only-storage' },
    { binding: 6, type: 'storage' },
    { binding: 7, type: 'storage' }
  ]
};
