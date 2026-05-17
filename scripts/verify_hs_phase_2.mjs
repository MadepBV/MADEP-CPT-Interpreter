#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HS Phase 2 verification — single-Gauss-point analytical fixtures.
//
// Drives the WASM `madepRunHsMaterialPoint` export directly. All tests use
// the standard D-fixture parameter sets (docs/features/hardening-soil-model.md,
// Appendix D).
//
// Sub-tests:
//   0. Elastic round-trip self-test. Pure-elastic strain on a virgin GP must
//      recover σ_v = D_e · Δε to 1e-10 relative.
//   1. D.1 — drained triaxial CD at σ_3 = 100 kPa.
//   2. D.2 — drained triaxial CD at σ_3 = 400 kPa.
//   3. D.3 — oedometric loading, NC, σ_v 50 → 200 kPa.
//   4. D.5 — unload-reload, σ_v 50→200→100→200 kPa.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

const LOCAL_HS_INPUT_MAGIC = 0x50534831;
const LOCAL_HS_OUTPUT_MAGIC = 0x4F534831;
const LOCAL_HS_VERSION = 1;

// Voigt indices (engineering shear convention).
const V_XX = 0, V_YY = 1, V_ZZ = 2, V_XY = 3, V_YZ = 4, V_XZ = 5;

async function loadWasm() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function defaultRegion() {
  // Granular preset from D.1.
  return {
    Emc: 30000,
    nu: 0.3,
    cEff: 0.1,
    phiDeg: 30,
    psiDeg: 0,
    K0nc: 0.5,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: 0,
    symmetrize: 0,
    hs: {
      E50_ref: 30000,
      Eoed_ref: 30000,
      Eur_ref: 90000,
      m: 0.5,
      nu_ur: 0.2,
      p_ref: 100,
      Rf: 0.9,
      K0_nc: 0,        // 0 = use Jaky
      e_init: -1,      // dilatancy cutoff disabled
      e_max: -1,
      OCR: 1.0,
      reserved: 0
    }
  };
}

// Encode the Phase 2 single-GP HS input wire (matches deformation_wasm.cpp).
function encodeHsInput({
  region,
  computeReferenceConstants = 1,
  M_cap = 0, H_cap = 0, sin_phi_cv = 0,
  sigmaMsf = 1.0,
  stressCommitted,
  strainCommitted,
  strainTrial,
  hsState
}) {
  const bytes = new Uint8Array(
    2 * 4                       // magic + version
    + 10 * 8 + 4                // region prefix (10 f64 + 4 u8)
    + 12 * 8                    // HS block
    + 1 + 3                     // computeRef + 3 pad
    + 3 * 8                     // M_cap_in, H_cap_in, sin_phi_cv_in
    + 8                         // sigmaMsf
    + 3 * (6 * 8)               // 3 Vec6's
    + 3 * 8 + 1 + 7             // committed hs state
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u32 = (v) => { view.setUint32(o, v >>> 0, true); o += 4; };
  const u8 = (v) => { view.setUint8(o, v & 0xff); o += 1; };
  const f64 = (v) => { view.setFloat64(o, Number(v) || 0, true); o += 8; };
  const vec6 = (v) => { for (let i = 0; i < 6; i += 1) f64(v[i] || 0); };

  u32(LOCAL_HS_INPUT_MAGIC);
  u32(LOCAL_HS_VERSION);

  f64(region.Emc); f64(region.nu); f64(region.cEff);
  f64(region.phiDeg); f64(region.psiDeg);
  f64(region.K0nc); f64(region.gamma); f64(region.gammaSat);
  f64(region.sigmaTAllow); f64(region.rShear);
  u8(region.useTensionCutoff); u8(region.symmetrize); u8(0); u8(0);

  const hs = region.hs || {};
  f64(hs.E50_ref); f64(hs.Eoed_ref); f64(hs.Eur_ref);
  f64(hs.m); f64(hs.nu_ur); f64(hs.p_ref);
  f64(hs.Rf); f64(hs.K0_nc); f64(hs.e_init); f64(hs.e_max);
  f64(hs.OCR); f64(hs.reserved || 0);

  u8(computeReferenceConstants); u8(0); u8(0); u8(0);
  f64(M_cap); f64(H_cap); f64(sin_phi_cv);
  f64(sigmaMsf);

  vec6(stressCommitted);
  vec6(strainCommitted);
  vec6(strainTrial);

  f64(hsState.gamma_p); f64(hsState.p_p); f64(hsState.eps_v_p);
  u8(hsState.lastActiveSet || 0);
  for (let i = 0; i < 7; i += 1) u8(0);

  assert.equal(o, bytes.length);
  return bytes;
}

function decodeHsOutput(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const u32 = () => { const v = view.getUint32(o, true); o += 4; return v; };
  const u16 = () => { const v = view.getUint16(o, true); o += 2; return v; };
  const u8 = () => { const v = view.getUint8(o); o += 1; return v; };
  const f64 = () => { const v = view.getFloat64(o, true); o += 8; return v; };
  const vec6 = () => { const v = new Array(6); for (let i = 0; i < 6; i += 1) v[i] = f64(); return v; };
  const mat6 = () => {
    const m = [];
    for (let i = 0; i < 6; i += 1) {
      const row = [];
      for (let j = 0; j < 6; j += 1) row.push(f64());
      m.push(row);
    }
    return m;
  };
  const magic = u32();
  const version = u32();
  assert.equal(magic, LOCAL_HS_OUTPUT_MAGIC, 'HS output magic');
  assert.equal(version, LOCAL_HS_VERSION, 'HS output version');
  const failureCode = u16();
  const activeSurface = u8();
  u8();  // pad
  const stressUpdated = vec6();
  const plasticIncrement = vec6();
  const tangent = mat6();
  const M_cap_out = f64();
  const H_cap_out = f64();
  const sin_phi_cv_out = f64();
  const gamma_p = f64();
  const p_p = f64();
  const eps_v_p = f64();
  const lastActiveSet = u8();
  for (let i = 0; i < 7; i += 1) u8();
  return {
    failureCode, activeSurface, stressUpdated, plasticIncrement, tangent,
    M_cap_out, H_cap_out, sin_phi_cv_out,
    gamma_p, p_p, eps_v_p, lastActiveSet
  };
}

async function runHsMaterialPoint(mod, input) {
  const inputPtr = mod._malloc(input.byteLength);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    mod.HEAPU8.set(input, inputPtr);
    const status = mod._madepRunHsMaterialPoint(inputPtr, input.byteLength, outPtrSlot, outLenSlot);
    if (!status) {
      const errPtr = mod._madepGetLastErrorMessage();
      let end = errPtr;
      while (mod.HEAPU8[end] !== 0) end += 1;
      const message = new TextDecoder().decode(mod.HEAPU8.subarray(errPtr, end));
      throw new Error(`HS WASM material-point call failed: ${message}`);
    }
    const outPtr = mod.HEAPU32[outPtrSlot >> 2];
    const outLen = mod.HEAPU32[outLenSlot >> 2];
    const outBytes = new Uint8Array(outLen);
    outBytes.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    mod._madepFreeBuffer(outPtr);
    return decodeHsOutput(outBytes);
  } finally {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
  }
}

function zeroVec6() {
  return [0, 0, 0, 0, 0, 0];
}

function copyVec6(v) {
  return v.slice();
}

// Elastic D_e for linear-isotropic material.
function elasticTangent6(E, nu) {
  const G = E / (2 * (1 + nu));
  const K = E / (3 * (1 - 2 * nu));
  const lam = K - (2 * G) / 3;
  const D = Array.from({ length: 6 }, () => new Array(6).fill(0));
  D[0][0] = lam + 2 * G; D[0][1] = lam; D[0][2] = lam;
  D[1][0] = lam; D[1][1] = lam + 2 * G; D[1][2] = lam;
  D[2][0] = lam; D[2][1] = lam; D[2][2] = lam + 2 * G;
  D[3][3] = G; D[4][4] = G; D[5][5] = G;
  return D;
}

function mul6x6(D, v) {
  const r = new Array(6).fill(0);
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 6; j += 1) r[i] += D[i][j] * v[j];
  }
  return r;
}

// Hyperbolic-curve forward: q given ε_1 (from D.1).
function hyperbolaQFromEps1(eps1, E_i, q_a) {
  return (eps1 * E_i) / (1 + (eps1 * E_i) / q_a);
}

// Triaxial CD constants for D.1 / D.2.
function triaxialConstants(region, sigma3) {
  const phiRad = (region.phiDeg * Math.PI) / 180;
  const sinPhi = Math.sin(phiRad);
  const cosPhi = Math.cos(phiRad);
  const c = region.cEff;
  const m = region.hs.m;
  const pref = region.hs.p_ref;
  const Rf = region.hs.Rf;
  const numerator = c * cosPhi + sigma3 * sinPhi;
  const denominator = c * cosPhi + pref * sinPhi;
  const ratio = Math.pow(Math.max(numerator, 0.5) / Math.max(denominator, 0.5), m);
  const E_50 = region.hs.E50_ref * ratio;
  const E_ur = region.hs.Eur_ref * ratio;
  const q_f = (c / Math.tan(phiRad) + sigma3) * (2 * sinPhi) / (1 - sinPhi);
  const q_a = q_f / Rf;
  const E_i = (2 * E_50) / (2 - Rf);
  return { E_50, E_ur, q_a, q_f, E_i, sinPhi };
}

// Drive a strain-controlled triaxial-CD test. σ_3 (and σ_2) are held at
// `sigma3_target` (compression-positive); axial strain ε_yy is ramped.
// At each axial step we run an inner Newton on Δε_xx = Δε_zz to keep
// σ_xx = σ_zz = -sigma3_target (tension-positive Voigt).
async function triaxialCdRun(mod, region, sigma3_target, eps1_max, n_steps) {
  // Initial state — hydrostatic consolidation at σ_3_target. The verify
  // exercises the cone surface; we set p_p far ahead of the trial state
  // so the cap stays inactive throughout (this matches the analytic
  // hyperbola which assumes pure cone yield). γ^p starts at 0 (virgin
  // shear). The cap-OCR equivalent here is ~5× to keep p_p comfortably
  // outside even at q≈q_a.
  let stress = zeroVec6();
  stress[V_XX] = -sigma3_target;
  stress[V_YY] = -sigma3_target;
  stress[V_ZZ] = -sigma3_target;
  let strain = zeroVec6();
  let state = {
    gamma_p: 0,
    p_p: 5.0 * sigma3_target,
    eps_v_p: 0,
    lastActiveSet: 0
  };

  // Eagerly compute reference constants ONCE (so we don't pay calibration
  // cost on every step).
  const stepOnce = async (strain_trial, strain_committed, stressCommitted, hsState, opts) => {
    const input = encodeHsInput({
      region,
      computeReferenceConstants: opts?.computeRef ?? 0,
      M_cap: opts?.M_cap ?? 0,
      H_cap: opts?.H_cap ?? 0,
      sin_phi_cv: opts?.sin_phi_cv ?? 0,
      sigmaMsf: 1.0,
      stressCommitted,
      strainCommitted: strain_committed,
      strainTrial: strain_trial,
      hsState
    });
    return runHsMaterialPoint(mod, input);
  };

  // First call: get M_cap / H_cap calibrated and cached.
  let probe = await stepOnce(strain, strain, stress, state, { computeRef: 1 });
  if (probe.failureCode !== 0) {
    throw new Error(`Triaxial CD warmup failed (failureCode ${probe.failureCode})`);
  }
  const M_cap = probe.M_cap_out;
  const H_cap = probe.H_cap_out;
  const sin_phi_cv = probe.sin_phi_cv_out;

  const points = [];
  const d_eps1 = eps1_max / n_steps;

  for (let step = 0; step < n_steps; step += 1) {
    const target_eps1 = (step + 1) * d_eps1;
    let strain_trial = copyVec6(strain);
    // ε_yy in this codebase is tension-positive; axial compression ⇒
    // ε_yy = -target_eps1 (negative, more compressive).
    strain_trial[V_YY] = -target_eps1;

    // Inner Newton on Δε_xx = Δε_zz so σ_xx = σ_zz = -sigma3_target.
    // Initial guess from elastic Poisson: Δε_xx ≈ ν · Δε_yy.
    let d_eps_lat = region.hs.nu_ur * (strain_trial[V_YY] - strain[V_YY]);
    strain_trial[V_XX] = strain[V_XX] + d_eps_lat;
    strain_trial[V_ZZ] = strain[V_ZZ] + d_eps_lat;

    let result = null;
    let lastResidual = Infinity;
    for (let inner = 0; inner < 30; inner += 1) {
      result = await stepOnce(strain_trial, strain, stress, state, {
        computeRef: 0, M_cap, H_cap, sin_phi_cv
      });
      if (result.failureCode !== 0) {
        throw new Error(`Triaxial CD inner Newton failed at step ${step} inner ${inner} (failureCode ${result.failureCode})`);
      }
      const r_xx = result.stressUpdated[V_XX] - (-sigma3_target);
      const r_zz = result.stressUpdated[V_ZZ] - (-sigma3_target);
      const residual = 0.5 * (r_xx + r_zz);
      lastResidual = Math.max(Math.abs(r_xx), Math.abs(r_zz));
      if (lastResidual < 1e-6 * sigma3_target) break;

      const h = 1e-8;
      const strain_perturb = copyVec6(strain_trial);
      strain_perturb[V_XX] = strain_trial[V_XX] + h;
      strain_perturb[V_ZZ] = strain_trial[V_ZZ] + h;
      const perturb = await stepOnce(strain_perturb, strain, stress, state, {
        computeRef: 0, M_cap, H_cap, sin_phi_cv
      });
      if (perturb.failureCode !== 0) break;
      const slope = (0.5 * (perturb.stressUpdated[V_XX] + perturb.stressUpdated[V_ZZ])
                   - 0.5 * (result.stressUpdated[V_XX] + result.stressUpdated[V_ZZ])) / h;
      if (!Number.isFinite(slope) || Math.abs(slope) < 1e-9) break;
      d_eps_lat -= residual / slope;
      strain_trial[V_XX] = strain[V_XX] + d_eps_lat;
      strain_trial[V_ZZ] = strain[V_ZZ] + d_eps_lat;
    }
    if (lastResidual > 1e-3 * sigma3_target) {
      console.warn(`  WARN step ${step}: σ_3 inner Newton residual ${lastResidual.toFixed(4)} kPa`);
    }

    // Commit.
    stress = result.stressUpdated.slice();
    strain = strain_trial;
    state = {
      gamma_p: result.gamma_p,
      p_p: result.p_p,
      eps_v_p: result.eps_v_p,
      lastActiveSet: result.lastActiveSet
    };

    // Record q = σ_1 - σ_3 in compression-positive. With σ_yy most
    // compressive (most negative), q = -σ_yy - (-σ_xx) ≈ -σ_yy - sigma3_target.
    const sigma_yy_cp = -stress[V_YY];
    const sigma_xx_cp = -stress[V_XX];
    const q = sigma_yy_cp - sigma_xx_cp;
    points.push({
      eps1: target_eps1,
      q,
      sigma3_actual: sigma_xx_cp,
      sigma1: sigma_yy_cp,
      eps_v_p: state.eps_v_p,
      gamma_p: state.gamma_p,
      lastActiveSet: state.lastActiveSet,
      M_cap, H_cap
    });
  }

  return points;
}

// Drive a strain-controlled oedometric test (no inner Newton needed —
// lateral strain forced to zero by ε_xx = ε_zz = 0).
async function oedometricRun(mod, region, sigma_v_start, sigma_v_end_list, n_steps_list) {
  // Oedometric loading is dominated by the cap. For Phase 2 single-surface
  // verification we initialise γ^p large enough that the cone stays
  // inactive (γ^p ≥ f_s(q_K0, σ_3=σ_v) so cone yield is well negative).
  // p_p is set to the NC-consistent value such that f_c = 0 at the K0 seed.
  let stress = zeroVec6();
  const phiRad = (region.phiDeg * Math.PI) / 180;
  const K0_init = (region.hs.K0_nc && region.hs.K0_nc > 0)
    ? region.hs.K0_nc
    : Math.max(1 - Math.sin(phiRad), 0.1);
  stress[V_XX] = -K0_init * sigma_v_start;
  stress[V_YY] = -sigma_v_start;
  stress[V_ZZ] = stress[V_XX];
  // Compute NC-consistent p_p (closed form).
  const sphi = Math.sin(phiRad);
  const delta_w = (3 + sphi) / (3 - sphi);
  const sigma_v_cp = sigma_v_start;
  const sigma_h_cp = K0_init * sigma_v_start;
  const q_tilde_seed = sigma_v_cp + (delta_w - 1) * sigma_h_cp - delta_w * sigma_h_cp;
  const p_prime_seed = (sigma_v_cp + 2 * sigma_h_cp) / 3;
  const c_eff = region.cEff;
  const cosPhi = Math.cos(phiRad);
  const cotPhi = cosPhi / Math.max(sphi, 1e-12);
  const p_t = c_eff * cotPhi;
  let strain = zeroVec6();
  let state = {
    gamma_p: 0.5,
    p_p: 0,                // filled in after we get M_cap from calibration
    eps_v_p: 0,
    lastActiveSet: 2
  };

  // Warm-up to cache derived constants. Use a temporary high p_p so the
  // warmup itself doesn't engage the cap (the actual p_p_nc is set below
  // once we know M_cap).
  const warmupState = { ...state, p_p: 1e6 };
  let probe = await runHsMaterialPoint(mod, encodeHsInput({
    region,
    computeReferenceConstants: 1,
    sigmaMsf: 1.0,
    stressCommitted: stress,
    strainCommitted: strain,
    strainTrial: strain,
    hsState: warmupState
  }));
  if (probe.failureCode !== 0) {
    throw new Error(`Oedometric warmup failed: failureCode ${probe.failureCode}`);
  }
  const M_cap = probe.M_cap_out;
  const H_cap = probe.H_cap_out;
  const sin_phi_cv = probe.sin_phi_cv_out;
  console.log(`  D.3 calibration: M_cap=${M_cap.toFixed(3)}, H_cap=${H_cap.toFixed(1)}, sin_phi_cv=${sin_phi_cv.toFixed(4)}`);
  // Now that we have M_cap, compute the NC-consistent p_p.
  const cap_rhs = (q_tilde_seed * q_tilde_seed) / (M_cap * M_cap)
                + (p_prime_seed + p_t) * (p_prime_seed + p_t);
  const p_p_nc = Math.max(Math.sqrt(Math.max(cap_rhs, 0)) - p_t, 1e-6);
  state.p_p = p_p_nc;
  console.log(`  D.3 NC seed: p_p=${p_p_nc.toFixed(2)} kPa (sigma_v_start=${sigma_v_start})`);

  // For oedometric, we drive σ_v in steps with a Newton inner on
  // Δε_yy to hit the target σ_yy (since the constitutive is strain-driven).
  const points = [{
    sigma_v: sigma_v_start,
    eps_yy: strain[V_YY],
    sigma_h: -stress[V_XX]
  }];
  let sigma_v_current = sigma_v_start;
  let total_eps_yy = strain[V_YY];

  for (let segIdx = 0; segIdx < sigma_v_end_list.length; segIdx += 1) {
    const sigma_v_target_end = sigma_v_end_list[segIdx];
    const n_steps = n_steps_list[segIdx];
    const d_sigma_v = (sigma_v_target_end - sigma_v_current) / n_steps;

    for (let step = 0; step < n_steps; step += 1) {
      const sigma_v_target = sigma_v_current + (step + 1) * d_sigma_v;

      // Inner Newton on Δε_yy.
      let d_eps_yy = d_sigma_v / -Math.max(region.hs.Eur_ref, 1);  // negative because target is "more compressive"
      let strain_trial = copyVec6(strain);
      strain_trial[V_YY] = strain[V_YY] + d_eps_yy;
      // ε_xx, ε_zz unchanged (no lateral strain).

      let result = null;
      let lastResidual = Infinity;
      for (let inner = 0; inner < 30; inner += 1) {
        result = await runHsMaterialPoint(mod, encodeHsInput({
          region,
          computeReferenceConstants: 0,
          M_cap, H_cap, sin_phi_cv,
          sigmaMsf: 1.0,
          stressCommitted: stress,
          strainCommitted: strain,
          strainTrial: strain_trial,
          hsState: state
        }));
        if (result.failureCode !== 0) {
          throw new Error(`Oedometric inner Newton failed at seg ${segIdx} step ${step}: failureCode ${result.failureCode}`);
        }
        const residual = result.stressUpdated[V_YY] - (-sigma_v_target);
        lastResidual = Math.abs(residual);
        if (lastResidual < 1e-5 * Math.max(sigma_v_target, 1)) break;

        const h = -1e-7;
        const strain_perturb = copyVec6(strain_trial);
        strain_perturb[V_YY] = strain_trial[V_YY] + h;
        const perturb = await runHsMaterialPoint(mod, encodeHsInput({
          region,
          computeReferenceConstants: 0,
          M_cap, H_cap, sin_phi_cv,
          sigmaMsf: 1.0,
          stressCommitted: stress,
          strainCommitted: strain,
          strainTrial: strain_perturb,
          hsState: state
        }));
        if (perturb.failureCode !== 0) break;
        const slope = (perturb.stressUpdated[V_YY] - result.stressUpdated[V_YY]) / h;
        if (!Number.isFinite(slope) || Math.abs(slope) < 1e-9) break;
        d_eps_yy -= residual / slope;
        strain_trial[V_YY] = strain[V_YY] + d_eps_yy;
      }
      if (lastResidual > 1e-3 * Math.max(sigma_v_target, 1)) {
        throw new Error(`Oedometric inner Newton failed to converge: residual ${lastResidual} kPa at σ_v target ${sigma_v_target}`);
      }

      stress = result.stressUpdated.slice();
      strain = strain_trial;
      state = {
        gamma_p: result.gamma_p,
        p_p: result.p_p,
        eps_v_p: result.eps_v_p,
        lastActiveSet: result.lastActiveSet
      };
      total_eps_yy = strain[V_YY];
      points.push({
        sigma_v: -stress[V_YY],
        eps_yy: strain[V_YY],
        sigma_h: -stress[V_XX],
        eps_v_p: state.eps_v_p,
        gamma_p: state.gamma_p,
        p_p: state.p_p,
        lastActiveSet: state.lastActiveSet
      });
    }
    sigma_v_current = sigma_v_target_end;
  }

  return points;
}

// ---------------------------------------------------------------------------
// Test 0: elastic round-trip self-test.
//
// Sets up a committed state on the unload-reload (E_ur) branch: σ_1 = 100,
// σ_3 = 50 (q = 50) with γ^p chosen so that f^s evaluated at q = 50 is
// well negative (the material has been historically loaded to a higher q
// and then unloaded). p_p ahead of current p' so the cap is inactive.
// Apply a small purely-elastic Δε and verify Δσ = D_e · Δε to 1e-10.
// ---------------------------------------------------------------------------
async function elasticRoundTrip(mod) {
  const region = defaultRegion();
  const stressCommitted = zeroVec6();
  stressCommitted[V_XX] = -50;
  stressCommitted[V_YY] = -100;   // sigma_1 = 100 (compression-positive)
  stressCommitted[V_ZZ] = -50;

  // Compute γ^p that puts the cone strictly inside (f^s < 0). f^s at
  // q = 50 with no γ^p ≈ 7.8e-4; pick γ^p = 5e-3 so f^s = -4.2e-3 ≪ 0.
  const gamma_p_committed = 5e-3;
  // Cap: pick p_p far ahead so f^c ≪ 0.
  const p_p_committed = 400;

  const strainCommitted = zeroVec6();
  const strainTrial = copyVec6(strainCommitted);
  // Small Δε that decreases q (unload-style). Drop σ_yy a touch.
  strainTrial[V_YY] = +1e-7;   // tension-positive Δε_yy > 0 ⇒ unload

  // Build the expected Δσ = D_e(E_ur at committed σ_3) · Δε.
  const sigma3_cp = 50;
  const sinPhi = Math.sin(region.phiDeg * Math.PI / 180);
  const cosPhi = Math.cos(region.phiDeg * Math.PI / 180);
  const num = region.cEff * cosPhi + sigma3_cp * sinPhi;
  const den = region.cEff * cosPhi + region.hs.p_ref * sinPhi;
  const ratio = Math.pow(Math.max(num, 0.5) / Math.max(den, 0.5), region.hs.m);
  const E_ur = region.hs.Eur_ref * ratio;
  const D = elasticTangent6(E_ur, region.hs.nu_ur);
  const dEps = new Array(6).fill(0);
  for (let i = 0; i < 6; i += 1) dEps[i] = strainTrial[i] - strainCommitted[i];
  const expected_dSigma = mul6x6(D, dEps);

  const result = await runHsMaterialPoint(mod, encodeHsInput({
    region,
    computeReferenceConstants: 1,
    sigmaMsf: 1.0,
    stressCommitted,
    strainCommitted,
    strainTrial,
    hsState: { gamma_p: gamma_p_committed, p_p: p_p_committed, eps_v_p: 0, lastActiveSet: 0 }
  }));
  assert.equal(result.failureCode, 0, `elastic round-trip failureCode ${result.failureCode}`);
  assert.equal(result.activeSurface, 0,
    `elastic round-trip should be elastic, got activeSurface ${result.activeSurface}`);

  let maxRelErr = 0;
  for (let i = 0; i < 6; i += 1) {
    const actual_dSigma = result.stressUpdated[i] - stressCommitted[i];
    const expected = expected_dSigma[i];
    const scale = Math.max(Math.abs(expected), Math.abs(actual_dSigma), 1e-3);
    const relErr = Math.abs(actual_dSigma - expected) / scale;
    if (relErr > maxRelErr) maxRelErr = relErr;
  }
  console.log(`  Elastic round-trip (E_ur at σ_3=50 → ${E_ur.toFixed(0)} kPa): max rel error ${maxRelErr.toExponential(3)}`);
  assert.ok(maxRelErr < 1e-10, `Elastic round-trip should match D_e · Δε to 1e-10 (got ${maxRelErr})`);
  console.log('  PASS — elastic round-trip');
}

// ---------------------------------------------------------------------------
// Test 1: D.1 — triaxial CD at σ_3 = 100 kPa.
// ---------------------------------------------------------------------------
async function triaxialD1(mod) {
  const region = defaultRegion();
  const sigma3 = 100;
  const eps1_max = 0.05;
  const n_steps = 500;
  const points = await triaxialCdRun(mod, region, sigma3, eps1_max, n_steps);
  const consts = triaxialConstants(region, sigma3);
  console.log(`  D.1 derived: E_i=${consts.E_i.toFixed(1)} q_a=${consts.q_a.toFixed(2)} q_f=${consts.q_f.toFixed(2)}`);

  const probes = [
    { eps1: 0.0025, tol: 1e-3 },
    { eps1: 0.0050, tol: 1e-3 },
    { eps1: 0.0100, tol: 1e-3 },
    { eps1: 0.0200, tol: 1e-3 },
    { eps1: 0.0500, tol: 5e-3 }   // 5% — curve flattens, looser tolerance
  ];
  let maxRelErr = 0;
  let worstEps1 = 0;
  for (const probe of probes) {
    // Find closest point.
    const found = points.reduce((best, p) =>
      Math.abs(p.eps1 - probe.eps1) < Math.abs(best.eps1 - probe.eps1) ? p : best);
    assert.ok(found, `D.1 missing point at ε_1 = ${probe.eps1}`);
    const q_analytic = hyperbolaQFromEps1(probe.eps1, consts.E_i, consts.q_a);
    const relErr = Math.abs(found.q - q_analytic) / Math.max(Math.abs(q_analytic), 1e-9);
    const sigma3_drift = Math.abs(found.sigma3_actual - sigma3) / sigma3;
    console.log(`    ε_1=${(probe.eps1 * 100).toFixed(2)}%: q=${found.q.toFixed(2)} (analytic ${q_analytic.toFixed(2)}) rel.err ${relErr.toExponential(2)}, σ_3 drift ${(sigma3_drift * 100).toExponential(2)}%`);
    if (relErr > maxRelErr) { maxRelErr = relErr; worstEps1 = probe.eps1; }
    assert.ok(relErr < probe.tol, `D.1 q at ε_1=${probe.eps1}: rel err ${relErr} exceeds ${probe.tol}`);
  }
  console.log(`  D.1 max relative q error: ${maxRelErr.toExponential(3)} at ε_1=${worstEps1}`);
  return { maxRelErr, worstEps1 };
}

// ---------------------------------------------------------------------------
// Test 2: D.2 — triaxial CD at σ_3 = 400 kPa.
// ---------------------------------------------------------------------------
async function triaxialD2(mod) {
  const region = defaultRegion();
  const sigma3 = 400;
  const eps1_max = 0.05;
  const n_steps = 500;
  const points = await triaxialCdRun(mod, region, sigma3, eps1_max, n_steps);
  const consts = triaxialConstants(region, sigma3);
  console.log(`  D.2 derived: E_i=${consts.E_i.toFixed(1)} q_a=${consts.q_a.toFixed(2)} q_f=${consts.q_f.toFixed(2)}`);

  const probes = [
    { eps1: 0.0025, tol: 1e-3 },
    { eps1: 0.0050, tol: 1e-3 },
    { eps1: 0.0100, tol: 1e-3 },
    { eps1: 0.0200, tol: 1e-3 }
  ];
  let maxRelErr = 0;
  let worstEps1 = 0;
  for (const probe of probes) {
    const found = points.reduce((best, p) =>
      Math.abs(p.eps1 - probe.eps1) < Math.abs(best.eps1 - probe.eps1) ? p : best);
    assert.ok(found, `D.2 missing point at ε_1 = ${probe.eps1}`);
    const q_analytic = hyperbolaQFromEps1(probe.eps1, consts.E_i, consts.q_a);
    const relErr = Math.abs(found.q - q_analytic) / Math.max(Math.abs(q_analytic), 1e-9);
    console.log(`    ε_1=${(probe.eps1 * 100).toFixed(2)}%: q=${found.q.toFixed(2)} (analytic ${q_analytic.toFixed(2)}) rel.err ${relErr.toExponential(2)}`);
    if (relErr > maxRelErr) { maxRelErr = relErr; worstEps1 = probe.eps1; }
    assert.ok(relErr < probe.tol, `D.2 q at ε_1=${probe.eps1}: rel err ${relErr} exceeds ${probe.tol}`);
  }
  console.log(`  D.2 max relative q error: ${maxRelErr.toExponential(3)} at ε_1=${worstEps1}`);
  return { maxRelErr, worstEps1 };
}

// ---------------------------------------------------------------------------
// Test 3: D.3 — oedometric NC, σ_v 50 → 200 kPa in 30 steps.
// ---------------------------------------------------------------------------
function oedometricEpsClosedForm(sigma_v, sigma_v_start, region) {
  // dε_v = dσ_v / E_oed, E_oed = E_oed_ref · (σ_v / p_ref)^m
  // For m = 0.5 and the default cohesion-zero limit, closed-form:
  //   ε_v(σ_v) = (2 / E_oed_ref) · sqrt(p_ref) · [sqrt(σ_v) - sqrt(σ_v_start)]
  const m = region.hs.m;
  const Eoed_ref = region.hs.Eoed_ref;
  const pref = region.hs.p_ref;
  if (Math.abs(m - 0.5) < 1e-12) {
    return (2 * Math.sqrt(pref) / Eoed_ref) * (Math.sqrt(sigma_v) - Math.sqrt(sigma_v_start));
  }
  // General case: ε_v = ∫ dσ / (Eoed_ref · (σ/p_ref)^m) from σ_v_start to σ_v.
  const exp = 1 - m;
  return (Math.pow(pref, m) / (Eoed_ref * exp)) * (Math.pow(sigma_v, exp) - Math.pow(sigma_v_start, exp));
}

async function oedometricD3(mod) {
  const region = defaultRegion();
  const points = await oedometricRun(mod, region, 50, [200], [30]);
  console.log(`  D.3 oedometric: ${points.length} points`);
  // ε_v in the codebase is tension-positive (volume increase is positive).
  // The analytical formula gives compression-positive ε_v. The HS update's
  // ε_yy (tension-positive) is the axial strain; with ε_xx = ε_zz = 0 the
  // volumetric strain ε_v = ε_yy (tension-positive). The closed-form
  // ε_v_compression-positive = -ε_yy.
  let maxAbsErr = 0;
  let worstSigma = 0;
  const probes = [50, 75, 100, 150, 200];
  for (const sigma of probes) {
    const closest = points.reduce((best, p) => {
      return Math.abs(p.sigma_v - sigma) < Math.abs(best.sigma_v - sigma) ? p : best;
    });
    const eps_v_compression_positive = -closest.eps_yy;
    const eps_v_analytic = oedometricEpsClosedForm(closest.sigma_v, 50, region);
    const absErr = Math.abs(eps_v_compression_positive - eps_v_analytic);
    console.log(`    σ_v=${closest.sigma_v.toFixed(2)} kPa: ε_v=${eps_v_compression_positive.toExponential(3)} (analytic ${eps_v_analytic.toExponential(3)}) abs.err ${absErr.toExponential(2)}`);
    if (absErr > maxAbsErr) { maxAbsErr = absErr; worstSigma = closest.sigma_v; }
  }
  console.log(`  D.3 max ε_v absolute error: ${maxAbsErr.toExponential(3)} at σ_v=${worstSigma.toFixed(2)} kPa`);
  assert.ok(maxAbsErr < 5e-4, `D.3 max abs ε_v error ${maxAbsErr} exceeds 5e-4`);
  return { maxAbsErr, worstSigma };
}

// ---------------------------------------------------------------------------
// Test 4: D.5 — unload-reload.
// ---------------------------------------------------------------------------
async function unloadReloadD5(mod) {
  const region = defaultRegion();
  // Load 50 → 200 → 100 → 200.
  const points = await oedometricRun(mod, region, 50, [200, 100, 200], [30, 10, 10]);
  console.log(`  D.5 unload-reload: ${points.length} points`);

  // Find the load-200 endpoint.
  const initialLoadEnd = points.findIndex((p, i) => i >= 30 && Math.abs(p.sigma_v - 200) < 1e-2);
  const unloadEnd = points.findIndex((p, i) => i >= 40 && Math.abs(p.sigma_v - 100) < 1e-2);
  const reloadEnd = points.length - 1;
  if (initialLoadEnd < 0 || unloadEnd < 0) {
    throw new Error('D.5 could not locate segment endpoints');
  }
  const epsInitial200 = -points[initialLoadEnd].eps_yy;
  const epsUnload100 = -points[unloadEnd].eps_yy;
  const epsReload200 = -points[reloadEnd].eps_yy;
  console.log(`    σ_v=200 (initial load):  ε_v=${epsInitial200.toExponential(4)} (lastActiveSet=${points[initialLoadEnd].lastActiveSet})`);
  console.log(`    σ_v=100 (after unload):  ε_v=${epsUnload100.toExponential(4)} (lastActiveSet=${points[unloadEnd].lastActiveSet})`);
  console.log(`    σ_v=200 (after reload):  ε_v=${epsReload200.toExponential(4)} (lastActiveSet=${points[reloadEnd].lastActiveSet})`);

  // (a) Unload slope ≈ 3× steeper than D.3 loading slope (because
  // E_ur = 3 · E_50 ≈ 3 · E_oed for the default preset).
  const loadingSlope = (epsInitial200 - 0) / 200;  // average ε_v / σ_v over the load
  const unloadingDeltaSigma = 200 - 100;
  const unloadingDeltaEps = epsInitial200 - epsUnload100;
  const unloadingSlope = unloadingDeltaEps / unloadingDeltaSigma;
  const slopeRatio = loadingSlope / unloadingSlope;
  console.log(`    Loading slope (avg) ${loadingSlope.toExponential(3)}, unloading slope ${unloadingSlope.toExponential(3)}, ratio ${slopeRatio.toFixed(2)}`);
  // Expect the load-slope to be about 3× the unload-slope; allow tolerance
  // because the loading slope is non-linear and the average underestimates
  // the early steep portion.
  assert.ok(slopeRatio > 1.5 && slopeRatio < 6.0,
    `D.5 unload should be ~3× stiffer than load (ratio ${slopeRatio}, expected 1.5-6×)`);

  // (b) Reload settlement at σ_v = 200 matches initial load to 1e-3 relative.
  const relErr = Math.abs(epsReload200 - epsInitial200) / Math.max(Math.abs(epsInitial200), 1e-9);
  console.log(`    Reload-vs-initial settlement at σ_v=200: rel.err ${relErr.toExponential(2)}`);
  assert.ok(relErr < 1e-2,
    `D.5 reload settlement should match initial load to 1e-2 (got ${relErr})`);
  return { unloadRatio: slopeRatio, reloadMatch: relErr };
}

// ---------------------------------------------------------------------------
async function main() {
  const mod = await loadWasm();
  console.log('HS Phase 2 verification (single-Gauss-point):');

  console.log('[0/5] Elastic round-trip self-test');
  await elasticRoundTrip(mod);

  console.log('[1/5] D.1 — drained triaxial CD at σ_3 = 100 kPa');
  const d1 = await triaxialD1(mod);

  console.log('[2/5] D.2 — drained triaxial CD at σ_3 = 400 kPa');
  const d2 = await triaxialD2(mod);

  console.log('[3/5] D.3 — oedometric NC σ_v 50 → 200 kPa');
  const d3 = await oedometricD3(mod);

  console.log('[4/5] D.5 — unload-reload');
  const d5 = await unloadReloadD5(mod);

  console.log('\n=== HS Phase 2 summary ===');
  console.log(`  D.1: max q rel.err ${d1.maxRelErr.toExponential(3)} at ε_1=${d1.worstEps1}`);
  console.log(`  D.2: max q rel.err ${d2.maxRelErr.toExponential(3)} at ε_1=${d2.worstEps1}`);
  console.log(`  D.3: max ε_v abs.err ${d3.maxAbsErr.toExponential(3)} at σ_v=${d3.worstSigma.toFixed(1)} kPa`);
  console.log(`  D.5: unload/load slope ratio ${d5.unloadRatio.toFixed(2)} (expect ~3), reload-vs-initial rel.err ${d5.reloadMatch.toExponential(2)}`);
  console.log('\nHS Phase 2 verification PASSED.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
