// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Resident GPU elastic gravity step + K0 stress recovery (DS).
// ============================================================================
//
// The single canonical initial-stress workflow from solver.js, lifted to
// the GPU resident pipeline:
//
//   1. Assemble linear-elastic K_e and gravity load b_g once on CPU,
//      upload as DS-CSR / DS-vector.
//   2. Solve K_e · u = b_g with resident CG (Phase 4).
//   3. Per Gauss point: compute σ_total = D_e · B · u  (one strain kernel
//      from Phase 6 + one D-multiplication kernel here), then apply K0
//      transform σ' = (-K0·σ'_v, -σ'_v, -K0·σ'_v, 0, 0, 0).
//
// The K0 transform kernel is small enough that we fuse it with the strain
// kernel: for each GP, read the strain → compute (σxx, σyy, σzz, σxy)_total
// via plane-strain elastic D → take σyy_total → effective σ'_v after pore
// pressure → apply K0 → write the Voigt-6 stress to the material-point state.
//
// All arithmetic in DS.

import { DS_WGSL } from './wgsl/ds.js';
import { dsAdd, dsMul, dsAddF32, dsMulF32, dsNeg, dsFromF64, dsToF64 } from './wgsl/ds.js';

// -----------------------------------------------------------------------------
// K0 stress recovery kernel.  One thread per GP.
//
// Inputs:
//   strain[gp * 3 + k]: DS Voigt-3 strain at GP (εxx, εyy, γxy)
//   regionId[gp]: u32 region index
//   matParams[regionId * 8 + ?]: DS region constants
//                                (E, ν, K0nc, gamma, c, sin φ, cos φ, σ_T)
//                                - actually just K0 + plane-strain D info
//   porePressure[gp]: DS pore pressure (negative = compression positive)
//
// Output:
//   sigmaInitial[gp * 6 + k]: DS Voigt-6 K0-controlled effective stress.
//
// The plane-strain elastic D in 2D Voigt-3 form:
//   D = (E / ((1+ν)(1-2ν))) · [ 1-ν   ν     0;
//                               ν    1-ν   0;
//                               0    0    (1-2ν)/2 ]
//
// (σxx, σyy, σxy)_total = D · (εxx, εyy, γxy)
// σzz_total = ν / (1-ν) · (σxx_total + σyy_total)   (plane-strain constraint)
//
// Then σ'_v = σ_yy_total - u_pore   (compression-positive convention)
//      σ'_h = K0 · σ'_v
//      σ' = (-σ'_h, -σ'_v, -σ'_h, 0, 0, 0)
// -----------------------------------------------------------------------------
export const KERNEL_K0_RECOVERY_WGSL = /* wgsl */ `
${DS_WGSL}

struct K0Params {
  numGp: u32,
  _pad: vec3<u32>
};

struct RegionParams {
  K0:    vec2<f32>,           // K0 = K0nc (or 1 - sin φ default)
  E:     vec2<f32>,           // Young modulus
  nu:    vec2<f32>,           // Poisson ratio
  gamma: vec2<f32>            // bulk unit weight (unused at this stage; kept for future)
};

@group(0) @binding(0) var<storage, read>       strain: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       regionId: array<u32>;
@group(0) @binding(2) var<storage, read>       regions:  array<RegionParams>;
@group(0) @binding(3) var<storage, read>       porePressure: array<vec2<f32>>;
@group(0) @binding(4) var<storage, read_write> sigmaInitial: array<vec2<f32>>;
@group(0) @binding(5) var<uniform>             params: K0Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  if (gp >= params.numGp) { return; }
  let r: RegionParams = regions[regionId[gp]];
  let exx: vec2<f32> = strain[gp * 3u + 0u];
  let eyy: vec2<f32> = strain[gp * 3u + 1u];
  let gxy: vec2<f32> = strain[gp * 3u + 2u];

  // Plane-strain elastic D coefficients.  Compute once:
  //   factor = E / ((1+nu)(1-2nu))
  //   D11 = factor (1 - nu)
  //   D12 = factor nu
  //   D33 = factor (1 - 2 nu) / 2
  let one: vec2<f32> = vec2<f32>(1.0, 0.0);
  let two: vec2<f32> = vec2<f32>(2.0, 0.0);
  let onePlusNu:  vec2<f32> = dsAdd(one, r.nu);
  let oneMinus2Nu: vec2<f32> = dsAdd(one, dsNeg(dsMul(two, r.nu)));
  let denom: vec2<f32> = dsMul(onePlusNu, oneMinus2Nu);
  let factor: vec2<f32> = dsDiv(r.E, denom);
  let oneMinusNu: vec2<f32> = dsAdd(one, dsNeg(r.nu));
  let D11: vec2<f32> = dsMul(factor, oneMinusNu);
  let D12: vec2<f32> = dsMul(factor, r.nu);
  // D33 = factor (1 - 2 nu) / 2  — not used in the K0 recovery directly
  // but useful when we want σxy.  We keep σxy = 0 in the seed, so unused.

  // σ_total = D · ε
  let sxxTot: vec2<f32> = dsAdd(dsMul(D11, exx), dsMul(D12, eyy));
  let syyTot: vec2<f32> = dsAdd(dsMul(D12, exx), dsMul(D11, eyy));
  // σzz_total = ν/(1-ν) · (σxx + σyy)
  let nuOverOneMinusNu: vec2<f32> = dsDiv(r.nu, oneMinusNu);
  let szzTot: vec2<f32> = dsMul(nuOverOneMinusNu, dsAdd(sxxTot, syyTot));

  // Effective vertical (compression positive): σ'_v = σ_yy_total - u_pore.
  // We assume the elastic gravity step computed σ_yy_total in the
  // tension-positive convention typical of FE displacement formulations,
  // then the K0 recovery flips the sign for compression-positive output.
  let u0: vec2<f32> = porePressure[gp];
  let sigmaVEff: vec2<f32> = dsAdd(syyTot, dsNeg(u0));
  let sigmaHEff: vec2<f32> = dsMul(r.K0, sigmaVEff);

  // Output Voigt-6 in compression-positive convention.
  sigmaInitial[gp * 6u + 0u] = dsNeg(sigmaHEff);
  sigmaInitial[gp * 6u + 1u] = dsNeg(sigmaVEff);
  sigmaInitial[gp * 6u + 2u] = dsNeg(sigmaHEff);
  sigmaInitial[gp * 6u + 3u] = vec2<f32>(0.0, 0.0);
  sigmaInitial[gp * 6u + 4u] = vec2<f32>(0.0, 0.0);
  sigmaInitial[gp * 6u + 5u] = vec2<f32>(0.0, 0.0);
}
`;

// -----------------------------------------------------------------------------
// CPU reference implementation.  Used by the parity suite.
// -----------------------------------------------------------------------------
export function cpuRefK0Recovery({ strainPerGp, regionId, regions, porePressure }) {
  // Inputs:
  //   strainPerGp: Array of length 3 * numGp DS pairs (εxx, εyy, γxy per GP)
  //   regionId: Array<int> length numGp
  //   regions: Array of { K0: ds, E: ds, nu: ds, gamma: ds }
  //   porePressure: Array<ds> length numGp
  // Output: Array of length 6 * numGp DS pairs (Voigt-6 effective stress).
  const numGp = porePressure.length;
  const out = new Array(6 * numGp);
  const one = dsFromF64(1);
  const two = dsFromF64(2);
  for (let gp = 0; gp < numGp; gp += 1) {
    const r = regions[regionId[gp]];
    const exx = strainPerGp[gp * 3 + 0];
    const eyy = strainPerGp[gp * 3 + 1];
    // gxy unused for the K0 recovery (we drop the elastic shear by design).
    const onePlusNu = dsAdd(one, r.nu);
    const oneMinus2Nu = dsAdd(one, dsNeg(dsMul(two, r.nu)));
    const denom = dsMul(onePlusNu, oneMinus2Nu);
    const factor = dsDiv(r.E, denom);
    const oneMinusNu = dsAdd(one, dsNeg(r.nu));
    const D11 = dsMul(factor, oneMinusNu);
    const D12 = dsMul(factor, r.nu);
    const sxxTot = dsAdd(dsMul(D11, exx), dsMul(D12, eyy));
    const syyTot = dsAdd(dsMul(D12, exx), dsMul(D11, eyy));
    const u0 = porePressure[gp];
    const sigmaVEff = dsAdd(syyTot, dsNeg(u0));
    const sigmaHEff = dsMul(r.K0, sigmaVEff);
    const zero = dsFromF64(0);
    out[gp * 6 + 0] = dsNeg(sigmaHEff);
    out[gp * 6 + 1] = dsNeg(sigmaVEff);
    out[gp * 6 + 2] = dsNeg(sigmaHEff);
    out[gp * 6 + 3] = zero;
    out[gp * 6 + 4] = zero;
    out[gp * 6 + 5] = zero;
  }
  return out;
}

// dsDiv reference for use in CPU verification.
import { dsDiv, dsRecip } from './wgsl/ds.js';
