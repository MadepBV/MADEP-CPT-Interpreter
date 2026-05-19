#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HS Phase 6 tangent oracle — production tangent vs finite-difference parity.
//
// For each smooth active set:
//   * pure elastic    (active set 0)
//   * cone-only       (active set 1)
//   * cap-only        (active set 2)
//   * corner          (active set 3)
//
// drive the WASM `update_plane_strain` path with a plane-strain trial state
// that lands in the target regime, then:
//
//   1. read the production algorithmic tangent D_an reported by the dispatch;
//   2. perturb the in-plane FE strain components (V_XX, V_YY, V_XY) by ±h
//      and rebuild the central-difference tangent D_fd (out-of-plane
//      columns from D_e, matching the WASM oracle convention);
//   3. compute
//          rel_err = ||D_an - D_fd||_F / max(||D_fd||_F, 1)
//      restricted to the in-plane 3×3 block (which is what the FE
//      assembly consumes via linalg::tangent2D_from_6x6);
//   4. record the symmetry-norm
//          sym_err = ||D - D^T||_F / max(||D||_F, 1)
//      and report (without failing) — cone / corner tangents are
//      legitimately unsymmetric per theory-fix §4.
//
// Acceptance tolerances:
//   * Elastic regime: 1e-6 relative (D_e ≡ FD oracle D_e to machine
//     precision because the inner update returns D_e itself).
//   * Cone/corner: analytic continuum tangent, checked against the FD oracle
//     with the documented continuum-vs-discrete envelope (0.35 max).
//   * Cap-only: FD tangent, checked at 1e-6 relative because the current
//     analytic cap tangent is still too far from the implemented return-map
//     derivative for production use.
//
// Pure tension (active set 4) and mixed-tension states (5/6/7) are not in
// scope for this oracle: tension keeps D_e (Phase 6D defers analytic
// Rankine), and mixed-tension uses the FD oracle in production.

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

const V_XX = 0, V_YY = 1, V_ZZ = 2, V_XY = 3, V_YZ = 4, V_XZ = 5;

const HsTangentMode = { Elastic: 0, Analytic: 1, FiniteDifference: 2, SimoHughes: 3 };
const USE_SIMO_HUGHES = process.env.MADEP_HS_USE_SIMO_HUGHES === '1';
const CORNER_FD_CANONICAL_PHASE4 = process.env.MADEP_HS_CORNER_FD_CANONICAL === 'phase4';

async function loadWasm() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function defaultRegion() {
  const e50 = USE_SIMO_HUGHES ? 300 : 30000;
  const eur = 3 * e50;
  return {
    Emc: e50,
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
      E50_ref: e50,
      Eoed_ref: e50,
      Eur_ref: eur,
      m: 0.5,
      nu_ur: 0.2,
      p_ref: 100,
      Rf: 0.9,
      K0_nc: 0,
      e_init: -1,
      e_max: -1,
      OCR: 1.0,
      nearSurfaceMinConfiningStress: 0,
      useConsistentTangent: USE_SIMO_HUGHES ? 1 : 0
    }
  };
}

// Encode HS WASM input. `usePlaneStrainWrapper = 1` exercises the Phase 6
// tangent dispatch inside `update_plane_strain`.
function encodeHsInput({
  region,
  computeReferenceConstants = 0,
  usePlaneStrainWrapper = 0,
  M_cap = 0, H_cap = 0, sin_phi_cv = 0,
  sigmaMsf = 1.0,
  stressCommitted,
  strainCommitted,
  strainTrial,
  hsState
}) {
  const bytes = new Uint8Array(
    2 * 4
    + 10 * 8 + 4
    + 13 * 8
    + 1 + 3
    + 3 * 8
    + 8
    + 3 * (6 * 8)
    + 3 * 8 + 1 + 7
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
  f64(hs.OCR); f64(hs.nearSurfaceMinConfiningStress ?? hs.reserved ?? 0);
  f64(hs.useConsistentTangent ?? 0);
  u8(computeReferenceConstants); u8(usePlaneStrainWrapper); u8(0); u8(0);
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
  u8();
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
  const tangentMode = u8();
  for (let i = 0; i < 6; i += 1) u8();
  return {
    failureCode, activeSurface, stressUpdated, plasticIncrement, tangent,
    M_cap_out, H_cap_out, sin_phi_cv_out,
    gamma_p, p_p, eps_v_p, lastActiveSet, tangentMode
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

function zeroVec6() { return [0, 0, 0, 0, 0, 0]; }
function copyVec6(v) { return v.slice(); }

function frobeniusNorm(M) {
  let s = 0;
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 6; j += 1) s += M[i][j] * M[i][j];
  }
  return Math.sqrt(s);
}

function frobeniusDiff(A, B) {
  let s = 0;
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 6; j += 1) {
      const d = A[i][j] - B[i][j];
      s += d * d;
    }
  }
  return Math.sqrt(s);
}

function symmetryNorm(M) {
  let s = 0;
  for (let i = 0; i < 6; i += 1) {
    for (let j = i + 1; j < 6; j += 1) {
      const d = M[i][j] - M[j][i];
      s += 2 * d * d;   // upper + lower triangles
    }
  }
  return Math.sqrt(s);
}

// In-plane 3×3 block (V_XX, V_YY, V_XY rows and columns). This is the
// block the FE assembly uses via linalg::tangent2D_from_6x6 — and the
// only block the FD oracle ACTUALLY perturbs (out-of-plane columns are
// the D_e pass-through fill). Comparison against analytic must restrict
// to this block to be apples-to-apples.
function inPlane3x3(M) {
  const idx = [V_XX, V_YY, V_XY];
  const r = [];
  for (let i = 0; i < 3; i += 1) {
    const row = [];
    for (let j = 0; j < 3; j += 1) row.push(M[idx[i]][idx[j]]);
    r.push(row);
  }
  return r;
}

function frobenius3x3(M) {
  let s = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) s += M[i][j] * M[i][j];
  }
  return Math.sqrt(s);
}

function frobeniusDiff3x3(A, B) {
  let s = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      const d = A[i][j] - B[i][j];
      s += d * d;
    }
  }
  return Math.sqrt(s);
}

function symmetryNorm3x3(M) {
  let s = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      const d = M[i][j] - M[j][i];
      s += 2 * d * d;
    }
  }
  return Math.sqrt(s);
}

// Build the central-difference tangent column-by-column on V_XX, V_YY, V_XY
// (plane-strain in-plane DOFs). Out-of-plane columns are copied from the
// reported D_e (mirroring `fd_algorithmic_tangent`'s pass-through fill).
async function fdTangent(mod, baseInput, strainTrial, h, D_e_referenceTangent) {
  const D_fd = D_e_referenceTangent.map((row) => row.slice());
  const dofs = [V_XX, V_YY, V_XY];
  // Reference unperturbed return (used for one-sided differences if a
  // central probe fails).
  const ref = await runHsMaterialPoint(mod, baseInput);
  if (ref.failureCode !== 0) {
    throw new Error(`FD reference probe failed: failureCode=${ref.failureCode}`);
  }
  const refActiveSurface = ref.activeSurface;
  for (const dof of dofs) {
    const plus = copyVec6(strainTrial);
    const minus = copyVec6(strainTrial);
    plus[dof] += h;
    minus[dof] -= h;
    const inputP = encodeHsInputFromBase(baseInput, plus);
    const inputM = encodeHsInputFromBase(baseInput, minus);
    const resP = await runHsMaterialPoint(mod, inputP);
    const resM = await runHsMaterialPoint(mod, inputM);
    const plusOk = resP.failureCode === 0;
    const minusOk = resM.failureCode === 0;
    const plusSameBranch = plusOk && resP.activeSurface === refActiveSurface;
    const minusSameBranch = minusOk && resM.activeSurface === refActiveSurface;
    if (plusSameBranch && minusSameBranch) {
      const inv = 1 / (2 * h);
      for (let i = 0; i < 6; i += 1) {
        D_fd[i][dof] = (resP.stressUpdated[i] - resM.stressUpdated[i]) * inv;
      }
      continue;
    }
    if (plusSameBranch) {
      const inv = 1 / h;
      for (let i = 0; i < 6; i += 1) {
        D_fd[i][dof] = (resP.stressUpdated[i] - ref.stressUpdated[i]) * inv;
      }
      continue;
    }
    if (minusSameBranch) {
      const inv = 1 / h;
      for (let i = 0; i < 6; i += 1) {
        D_fd[i][dof] = (ref.stressUpdated[i] - resM.stressUpdated[i]) * inv;
      }
      continue;
    }
    // Both probes failed; leave column at D_e fill.
  }
  return D_fd;
}

// Re-encode the WASM input with a different strainTrial vector by replacing
// the trial-strain Vec6 slot in the canonical layout. Offsets must match
// `encodeHsInput`.
function encodeHsInputFromBase(baseInput, strainTrial) {
  // Compute the offset of strainTrial in the encoded byte stream by
  // mirroring the encoder layout.
  // Header(8) + region prefix(10*8 + 4) + HS block(13*8) + computeRef+pad(4)
  // + 3 f64 (M_cap, H_cap, sin_phi_cv) + 1 f64 (sigmaMsf)
  // + 2 Vec6 (stressCommitted, strainCommitted) = offset of strainTrial.
  const STRAIN_TRIAL_OFFSET =
    8
    + (10 * 8 + 4)
    + (13 * 8)
    + 4
    + 3 * 8
    + 8
    + 2 * (6 * 8);
  const buf = baseInput.slice();
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < 6; i += 1) {
    view.setFloat64(STRAIN_TRIAL_OFFSET + i * 8, strainTrial[i] || 0, true);
  }
  return buf;
}

// Compute the elastic-tangent reference D_e from region (E_ur, nu_ur).
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

// Build a Voigt-6 stress array for a hydrostatic compressive state in
// tension-positive convention.
function hydrostaticStress(p_compr) {
  // σ_voigt is tension-positive; p_compr > 0 is compression ⇒ negate.
  return [-p_compr, -p_compr, -p_compr, 0, 0, 0];
}

// Power-law stress-dependent E_ur at a given compression-positive sigma_3.
function powerLawEur(hs, c, phiRad, sigma3_compr) {
  const sphi = Math.sin(phiRad);
  const cphi = Math.cos(phiRad);
  const num = Math.max(c * cphi + sigma3_compr * sphi, 0.5);
  const den = Math.max(c * cphi + hs.p_ref * sphi, 0.5);
  return hs.Eur_ref * Math.pow(num / den, hs.m);
}

// Test a single scenario: drive the WASM tangent dispatch at a controlled
// trial state, compare production tangent vs FD, log the result. Returns the
// per-test record { name, relErr, symAn, symFd, modeAn, activeSurface }.
async function runOracleCase(mod, name, opts) {
  const {
    region, stressCommitted, strainCommitted, strainTrial,
    hsState, M_cap, H_cap, sin_phi_cv, expectActiveSurface
  } = opts;

  // Inputs for production tangent: usePlaneStrainWrapper = 1 → Phase 6 dispatch.
  const baseInput = encodeHsInput({
    region,
    computeReferenceConstants: 0,
    usePlaneStrainWrapper: 1,
    M_cap, H_cap, sin_phi_cv,
    sigmaMsf: 1.0,
    stressCommitted, strainCommitted, strainTrial,
    hsState
  });
  const anResult = await runHsMaterialPoint(mod, baseInput);
  if (anResult.failureCode !== 0) {
    throw new Error(`${name}: analytic-tangent probe failed (failureCode=${anResult.failureCode})`);
  }
  if (typeof expectActiveSurface === 'number') {
    assert.equal(
      anResult.activeSurface,
      expectActiveSurface,
      `${name}: expected activeSurface=${expectActiveSurface}, got ${anResult.activeSurface}`
    );
  }
  const D_an = anResult.tangent;
  const modeAn = anResult.tangentMode;

  // Elastic reference for pass-through fill of out-of-plane columns.
  const sigma3_committed = -Math.min(
    stressCommitted[V_XX], stressCommitted[V_YY], stressCommitted[V_ZZ]
  );
  const phiRad = (region.phiDeg * Math.PI) / 180;
  const E_ur = powerLawEur(region.hs, region.cEff, phiRad, sigma3_committed);
  const D_e_ref = elasticTangent6(E_ur, region.hs.nu_ur);

  // FD step size. To resolve the plastic correction (Δλ proportional to
  // the strain trial size) the perturbation h must be a sizable fraction
  // of |strainTrial|; otherwise both perturbed probes converge to nearly
  // the same Δλ as the reference and FD measures the elastic response.
  // Empirically h = 1e-3 · |strainTrial_largest| with a 1e-9 absolute
  // floor balances FD truncation error against return-mapping
  // convergence noise (~ 1e-9 in stress).
  const trialMag = Math.max(
    Math.abs(strainTrial[V_XX]),
    Math.abs(strainTrial[V_YY]),
    Math.abs(strainTrial[V_XY]),
    1e-6
  );
  const h = USE_SIMO_HUGHES
    ? 1e-6 * Math.max(trialMag, 1e-3)
    : Math.max(1e-3 * trialMag, 1e-9);
  const D_fd = await fdTangent(mod, baseInput, strainTrial, h, D_e_ref);

  // Full 6×6 frobenius norms (informational) and in-plane 3×3 norms
  // (acceptance metric). The FE assembly consumes only the in-plane block
  // via linalg::tangent2D_from_6x6, and the FD oracle fills out-of-plane
  // columns with D_e by convention — so the apples-to-apples comparison
  // is on the in-plane block only.
  const normFd6 = Math.max(frobeniusNorm(D_fd), 1);
  const relErr6 = frobeniusDiff(D_an, D_fd) / normFd6;

  const An3 = inPlane3x3(D_an);
  const Fd3 = inPlane3x3(D_fd);
  const normFd3 = Math.max(frobenius3x3(Fd3), 1);
  const relErr = frobeniusDiff3x3(An3, Fd3) / normFd3;
  const normAn3 = Math.max(frobenius3x3(An3), 1);
  const symAn = symmetryNorm3x3(An3) / normAn3;
  const symFd = symmetryNorm3x3(Fd3) / normFd3;

  return {
    name,
    relErr,
    relErr6,
    symAn,
    symFd,
    modeAn,
    activeSurface: anResult.activeSurface,
    M_cap_out: anResult.M_cap_out,
    H_cap_out: anResult.H_cap_out,
    D_an,
    D_fd
  };
}

// ---------------------------------------------------------------------------
// Calibration: get region reference constants once (M_cap, H_cap,
// sin_phi_cv) so subsequent calls bypass the expensive iterative calibration.
// ---------------------------------------------------------------------------
async function calibrateRegion(mod, region, seedStress, seedState) {
  const probeInput = encodeHsInput({
    region,
    computeReferenceConstants: 1,
    usePlaneStrainWrapper: 0,
    sigmaMsf: 1.0,
    stressCommitted: seedStress,
    strainCommitted: zeroVec6(),
    strainTrial: zeroVec6(),
    hsState: seedState
  });
  const probe = await runHsMaterialPoint(mod, probeInput);
  if (probe.failureCode !== 0) {
    throw new Error(`Calibration probe failed: failureCode=${probe.failureCode}`);
  }
  return {
    M_cap: probe.M_cap_out,
    H_cap: probe.H_cap_out,
    sin_phi_cv: probe.sin_phi_cv_out
  };
}

// ---------------------------------------------------------------------------
// Helper: cone-zero γ^p that puts f^s = 0 at a K0 loading state (mirrors
// cone_zero_gamma_p_for_K0 in material_hs.hpp).
// ---------------------------------------------------------------------------
function coneZeroGammaP(sigma_v, K0, c, phiRad, hs) {
  const sphi = Math.sin(phiRad);
  const cphi = Math.cos(phiRad);
  const sigma3 = K0 * sigma_v;
  const num = Math.max(c * cphi + sigma3 * sphi, 0.5);
  const den = Math.max(c * cphi + hs.p_ref * sphi, 0.5);
  const ratio = Math.pow(num / den, hs.m);
  const E_50 = hs.E50_ref * ratio;
  const E_ur = hs.Eur_ref * ratio;
  const E_i = 2 * E_50 / (2 - hs.Rf);
  const sphi_f = Math.max(sphi, 1e-6);
  const q_f = (c * cphi / Math.max(sphi, 1e-12) + sigma3) * 2 * sphi_f
            / Math.max(1 - sphi_f, 1e-9);
  const q_a = Math.max(q_f / hs.Rf, 1);
  const q = sigma_v - sigma3;
  const q_clamp = Math.min(q, 0.999 * q_a);
  let denom = 1 - q_clamp / q_a;
  if (denom < 1e-3) denom = 1e-3;
  return (2 / E_i) * q_clamp / denom - 2 * q / E_ur;
}

// ---------------------------------------------------------------------------
// Scenario constructors.
// ---------------------------------------------------------------------------

// Pure elastic — small isotropic loading, q ≈ 0, well inside both cone
// and cap (large p_p so cap is far away; q = 0 means cone trivially in).
function elasticScenario() {
  const region = defaultRegion();
  const stressCommitted = hydrostaticStress(50);
  const strainCommitted = zeroVec6();
  const strainTrial = zeroVec6();
  // Small purely-hydrostatic compressive increment — q stays at 0 and the
  // FD perturbations (V_XX, V_YY, V_XY of size h ≈ 1e-9) cannot push the
  // state out of the cone tolerance band.
  strainTrial[V_XX] = -1e-5;
  strainTrial[V_YY] = -1e-5;
  // γ^p > 0 puts the cone yield clearly negative even under perturbation;
  // p_p ≫ p_prime keeps the cap far away.
  const hsState = { gamma_p: 1e-3, p_p: 500, eps_v_p: 0, lastActiveSet: 0 };
  return { region, stressCommitted, strainCommitted, strainTrial, hsState };
}

// Cone-only — drained triaxial style: large q at modest p, cap far away.
//
// The committed state sits exactly on the cone yield surface (γ^p set to
// the cone-zero value). We deliberately split σ_xx ≠ σ_zz so the trial
// principal decomposition lands on Face13 (non-degenerate); without this
// split, σ_2 = σ_3 makes the eigenvector basis unstable to tiny FD
// perturbations and the cone Newton fails (ordering swap → fc 101).
// ψ > 0 makes flow non-associated so the plastic tangent is legitimately
// unsymmetric per theory-fix §4.
function coneOnlyScenario() {
  const region = defaultRegion();
  region.psiDeg = 20;    // dilatant cone (ψ > 0) — drives sin_psi_mob ≠ 0
  const sigma3 = 80;
  const sigma_int = 120;       // σ_2 between σ_3 (= sigma3) and σ_1, well-separated
  const q_target = 80;
  const stressCommitted = [-sigma3, -(sigma3 + q_target), -sigma_int, 0, 0, 0];
  const strainCommitted = zeroVec6();
  const strainTrial = zeroVec6();
  // Axial increment chosen so Δλ_s · (n · D_e · m / A) is well above the
  // FD truncation floor. Empirically -1e-5 keeps the linearization smooth
  // while letting the FD oracle resolve D_ep.
  strainTrial[V_YY] = USE_SIMO_HUGHES ? -1e-3 : -1e-5;
  // Elastic Poisson contraction in V_XX would reduce σ_3 → cone may go
  // inactive; keep ε_xx = 0 (plane-strain-like) for the test.
  // γ^p is set to the cone-zero value at this state so f^s = 0 at trial.
  const phiRad = (region.phiDeg * Math.PI) / 180;
  // Reverse-engineer γ^p so f^s(q, σ_3, γ^p) = 0 at the committed state.
  const c = region.cEff;
  const sphi = Math.sin(phiRad);
  const cphi = Math.cos(phiRad);
  const num = Math.max(c * cphi + sigma3 * sphi, 0.5);
  const den = Math.max(c * cphi + region.hs.p_ref * sphi, 0.5);
  const ratio = Math.pow(num / den, region.hs.m);
  const E_50 = region.hs.E50_ref * ratio;
  const E_ur = region.hs.Eur_ref * ratio;
  const E_i = 2 * E_50 / (2 - region.hs.Rf);
  const q_f = (c / Math.tan(phiRad) + sigma3) * 2 * sphi / Math.max(1 - sphi, 1e-9);
  const q_a = q_f / region.hs.Rf;
  const q_clamp = Math.min(q_target, 0.999 * q_a);
  let dn = 1 - q_clamp / q_a; if (dn < 1e-3) dn = 1e-3;
  const gamma_p = (2 / E_i) * q_clamp / dn - 2 * q_target / E_ur;
  // p_p set far ahead so cap inactive.
  const hsState = { gamma_p, p_p: 5 * sigma3, eps_v_p: 0, lastActiveSet: 1 };
  return { region, stressCommitted, strainCommitted, strainTrial, hsState };
}

// Cap-only — oedometric loading, cone inactive (γ^p large enough).
//
// Committed state on the cap NC surface; trial increment drives ACTIVE
// plastic loading. Probe FD around the converged state where Δλ_c is well
// above floating-point noise.
function capOnlyScenario() {
  const region = defaultRegion();
  // K0 NC state at σ_v = 100 kPa, K0 = 0.5. Slight σ_xx ≠ σ_zz split so
  // the trial principal frame is non-degenerate and the FD oracle can
  // resolve the cap rank-1 update without principal-direction noise
  // dominating tiny perturbations.
  const sigma_v = 100;
  const K0 = 0.5;
  const sigma_h_xx = K0 * sigma_v;
  const sigma_h_zz = K0 * sigma_v + 5;
  const stressCommitted = [-sigma_h_xx, -sigma_v, -sigma_h_zz, 0, 0, 0];
  const strainCommitted = zeroVec6();
  const strainTrial = zeroVec6();
  // Vertical compression sized so the FD oracle resolves the cap
  // rank-1 update above floating-point noise (Δλ_c ≈ a few × 1e-7).
  strainTrial[V_YY] = -1e-4;
  if (USE_SIMO_HUGHES) strainTrial[V_XY] = 1e-5;
  // Force cone inactive by inflating γ^p above the cone-zero value.
  const phiRad = (region.phiDeg * Math.PI) / 180;
  const gamma_p_floor = coneZeroGammaP(sigma_v, K0, region.cEff, phiRad, region.hs);
  // p_p sized so f^c = 0 at the seed, making the cap active under the
  // increment. q_tilde uses sorted principals in compression-positive:
  // s1 = sigma_v (most compressive), s2 = sigma_h_zz (mid), s3 = sigma_h_xx
  // (least). Cap yield function evaluates correctly under this ordering.
  const sphi = Math.sin(phiRad);
  const delta_w = (3 + sphi) / (3 - sphi);
  const s1 = sigma_v;
  const s2 = sigma_h_zz;
  const s3 = sigma_h_xx;
  const q_tilde = s1 + (delta_w - 1) * s2 - delta_w * s3;
  const p_prime = (s1 + s2 + s3) / 3;
  const c_eff = region.cEff;
  const cphi = Math.cos(phiRad);
  const p_t = c_eff * cphi / Math.max(sphi, 1e-12);
  const hsState = {
    gamma_p: Math.max(gamma_p_floor + 0.5, 0.5),     // bump well above cone yield
    p_p: 0,                                           // filled at call site from calibrated M_cap
    eps_v_p: 0,
    lastActiveSet: 2
  };
  return {
    region, stressCommitted, strainCommitted, strainTrial, hsState,
    _capScenarioMeta: { q_tilde, p_prime, p_t }
  };
}

// Corner — K0 NC seed with corner-aware γ^p (cone exactly on yield).
// σ_xx ≠ σ_zz split: non-degenerate principal frame so FD probes don't
// hit eigenvector-noise.
function cornerScenario() {
  const region = defaultRegion();
  const sigma_v = 100;
  const K0 = 0.5;
  const sigma_h_xx = K0 * sigma_v;
  const sigma_h_zz = K0 * sigma_v + 5;
  const stressCommitted = [-sigma_h_xx, -sigma_v, -sigma_h_zz, 0, 0, 0];
  const strainCommitted = zeroVec6();
  const strainTrial = zeroVec6();
  // Vertical increment sized to engage both cone and cap above FD
  // truncation noise (Δλ_s, Δλ_c ≈ a few × 1e-7).
  strainTrial[V_YY] = -1e-4;
  if (USE_SIMO_HUGHES) strainTrial[V_XY] = 1e-5;
  const phiRad = (region.phiDeg * Math.PI) / 180;
  const gamma_p_seed = Math.max(
    coneZeroGammaP(sigma_v, K0, region.cEff, phiRad, region.hs),
    0
  );
  const sphi = Math.sin(phiRad);
  const delta_w = (3 + sphi) / (3 - sphi);
  const s1 = sigma_v;
  const s2 = sigma_h_zz;
  const s3 = sigma_h_xx;
  const q_tilde = s1 + (delta_w - 1) * s2 - delta_w * s3;
  const p_prime = (s1 + s2 + s3) / 3;
  const c_eff = region.cEff;
  const cphi = Math.cos(phiRad);
  const p_t = c_eff * cphi / Math.max(sphi, 1e-12);
  const hsState = {
    gamma_p: USE_SIMO_HUGHES ? 0.8 * gamma_p_seed : gamma_p_seed,
    p_p: 0,
    eps_v_p: 0,
    lastActiveSet: 3
  };
  return {
    region, stressCommitted, strainCommitted, strainTrial, hsState,
    _cornerScenarioMeta: { q_tilde, p_prime, p_t }
  };
}

// Resolve the NC-consistent p_p given the calibrated M_cap.
function nc_p_p(M_cap, q_tilde, p_prime, p_t) {
  const rhs = (q_tilde * q_tilde) / (M_cap * M_cap)
            + (p_prime + p_t) * (p_prime + p_t);
  return Math.max(Math.sqrt(Math.max(rhs, 0)) - p_t, 1e-6);
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
async function main() {
  const mod = await loadWasm();
  console.log(`HS Phase 6 tangent oracle (production tangent vs FD parity, Simo-Hughes=${USE_SIMO_HUGHES ? 'on' : 'off'}):`);

  // Calibration probe — uses the same region across all scenarios.
  const calibRegion = defaultRegion();
  const calibStress = hydrostaticStress(100);
  const calib = await calibrateRegion(mod, calibRegion, calibStress, {
    gamma_p: 0, p_p: 1000, eps_v_p: 0, lastActiveSet: 0
  });
  if (USE_SIMO_HUGHES) calib.H_cap = 1.0;
  console.log(`  Calibration: M_cap=${calib.M_cap.toFixed(4)}, H_cap=${calib.H_cap.toFixed(1)}, sin_phi_cv=${calib.sin_phi_cv.toFixed(4)}`);

  const records = [];

  // --- Elastic ---
  {
    const sc = elasticScenario();
    const r = await runOracleCase(mod, 'elastic', {
      ...sc,
      M_cap: calib.M_cap, H_cap: calib.H_cap, sin_phi_cv: calib.sin_phi_cv,
      expectActiveSurface: 0
    });
    records.push(r);
    console.log(`  [elastic]   active=${r.activeSurface} mode=${r.modeAn} relErr_3x3=${r.relErr.toExponential(3)} relErr_6x6=${r.relErr6.toExponential(3)} sym(an)=${r.symAn.toExponential(3)} sym(fd)=${r.symFd.toExponential(3)}`);
    assert.equal(r.modeAn, HsTangentMode.Elastic, 'elastic mode tag');
    assert.ok(r.relErr < 1e-6, `elastic relErr ${r.relErr} should be < 1e-6 (D_e == D_e)`);
    // Elastic tangent must be symmetric.
    assert.ok(r.symAn < 1e-12, `elastic D should be symmetric, got sym=${r.symAn}`);
  }

  // --- Cone-only ---
  {
    const sc = coneOnlyScenario();
    const r = await runOracleCase(mod, 'cone', {
      ...sc,
      M_cap: calib.M_cap, H_cap: calib.H_cap, sin_phi_cv: calib.sin_phi_cv,
      expectActiveSurface: 1
    });
    records.push(r);
    console.log(`  [cone]      active=${r.activeSurface} mode=${r.modeAn} relErr_3x3=${r.relErr.toExponential(3)} relErr_6x6=${r.relErr6.toExponential(3)} sym(an)=${r.symAn.toExponential(3)} sym(fd)=${r.symFd.toExponential(3)}`);
    assert.equal(r.modeAn, USE_SIMO_HUGHES ? HsTangentMode.SimoHughes : HsTangentMode.Analytic, 'cone mode tag');
    assert.ok(
      r.relErr < (USE_SIMO_HUGHES ? 1e-4 : 0.35),
      `cone tangent outside ${USE_SIMO_HUGHES ? 'Simo-Hughes' : 'continuum'} envelope, got relErr ${r.relErr}`
    );
    // Cone is non-associated (ψ < φ) → tangent is generally unsymmetric.
  }

  // --- Cap-only ---
  {
    const sc = capOnlyScenario();
    sc.hsState.p_p = nc_p_p(
      calib.M_cap,
      sc._capScenarioMeta.q_tilde,
      sc._capScenarioMeta.p_prime,
      sc._capScenarioMeta.p_t
    );
    const r = await runOracleCase(mod, 'cap', {
      ...sc,
      M_cap: calib.M_cap, H_cap: calib.H_cap, sin_phi_cv: calib.sin_phi_cv,
      expectActiveSurface: 2
    });
    records.push(r);
    console.log(`  [cap]       active=${r.activeSurface} mode=${r.modeAn} relErr_3x3=${r.relErr.toExponential(3)} relErr_6x6=${r.relErr6.toExponential(3)} sym(an)=${r.symAn.toExponential(3)} sym(fd)=${r.symFd.toExponential(3)}`);
    assert.equal(r.modeAn, USE_SIMO_HUGHES ? HsTangentMode.SimoHughes : HsTangentMode.FiniteDifference, 'cap mode tag');
    assert.ok(
      r.relErr < (USE_SIMO_HUGHES ? 1e-4 : 1e-6),
      `cap production tangent must match FD oracle, got relErr ${r.relErr}`
    );
    // Cap flow is associated in principal stress space, but the production
    // FD tangent differentiates the full plane-strain return map with
    // stress-dependent stiffness and active-set projection. Record symmetry;
    // do not force a symmetric tangent into CG.
  }

  // --- Corner ---
  {
    const sc = cornerScenario();
    sc.hsState.p_p = nc_p_p(
      calib.M_cap,
      sc._cornerScenarioMeta.q_tilde,
      sc._cornerScenarioMeta.p_prime,
      sc._cornerScenarioMeta.p_t
    ) * (USE_SIMO_HUGHES ? 0.98 : 1.0);
    const r = await runOracleCase(mod, 'corner', {
      ...sc,
      M_cap: calib.M_cap, H_cap: calib.H_cap, sin_phi_cv: calib.sin_phi_cv,
      expectActiveSurface: 3
    });
    records.push(r);
    console.log(`  [corner]    active=${r.activeSurface} mode=${r.modeAn} relErr_3x3=${r.relErr.toExponential(3)} relErr_6x6=${r.relErr6.toExponential(3)} sym(an)=${r.symAn.toExponential(3)} sym(fd)=${r.symFd.toExponential(3)}`);
    assert.equal(r.modeAn, USE_SIMO_HUGHES ? HsTangentMode.SimoHughes : HsTangentMode.Analytic, 'corner mode tag');
    if (USE_SIMO_HUGHES && CORNER_FD_CANONICAL_PHASE4) {
      console.log('  [corner]    FD parity is enforced by verify_hs_simo_hughes_phase_4.mjs; this WASM probe checks runtime mode dispatch.');
    } else {
      assert.ok(
        r.relErr < (USE_SIMO_HUGHES ? 1e-4 : 0.35),
        `corner tangent outside ${USE_SIMO_HUGHES ? 'Simo-Hughes' : 'continuum'} envelope, got relErr ${r.relErr}`
      );
    }
    // Corner is generally unsymmetric because cone flow is non-associated.
  }

  console.log('\n=== HS Phase 6 tangent oracle summary ===');
  for (const r of records) {
    console.log(`  ${r.name.padEnd(10)} relErr=${r.relErr.toExponential(3)}  sym(an)=${r.symAn.toExponential(3)}  sym(fd)=${r.symFd.toExponential(3)}  mode=${r.modeAn}`);
  }
  console.log('\nHS Phase 6 tangent oracle PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
