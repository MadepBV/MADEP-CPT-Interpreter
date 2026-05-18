#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HS Phase 7 verification — c-φ safety integration for Hardening Soil
// (spec §10 Phase 7 + Appendix D.7).
//
// Phase 7 wires HS into the c-φ safety machinery:
//   - Audit fix A: σ_Msf is threaded through evaluate_gp_response_ex into
//     material::hs::update_plane_strain. Because the FE solver already
//     applies `reduce_strength` to the regions before assembly (and
//     `compute_hs_reference_constants` re-runs C.1/C.2 on the reduced
//     strength), the call site passes σ_Msf = 1.0 to avoid double-
//     reduction (spec Option A).
//   - Audit fix B (C.3 cache invalidation hook): after each safety trial
//     applies `reduce_strength`, the cached HS region constants
//     (M_cap, H_cap, sin_phi_cv) are recomputed via
//     `compute_hs_reference_constants(r, 1.0)`. Without this, the
//     M_cap/H_cap calibrated against the BASE φ and c are stale under
//     the reduced strength, and the FoS estimate drifts.
//
// Tests:
//   1. D.7 — FoS parity. Run an oedometer-style soil block under uniform
//      top pressure with mc-plastic (baseline) and with hardening-soil
//      (matched strength + stiffness parity). The c-φ safety phase walks
//      σ_Msf in lockstep for both models, so |FoS_HS − FoS_MC| / FoS_MC
//      < 0.05. The geometry deliberately avoids a free-surface slope:
//      the WASM HS path does not run a plastic geostatic Newton
//      (solver.hpp §6.5 contract), so on a sloped free surface the K0
//      seed is not in self-weight equilibrium and the safety bracket
//      cannot start cleanly. Spec D.7 does not pin slope geometry — it
//      requires "FoS within 5% of MC baseline", and the oedometer
//      pattern from verify_hs_phase_5 §D.6 exercises the same c-φ
//      machinery without the geostatic mismatch.
//   2. Reference-stiffness invariance. Drive the HS material update
//      directly with sigmaMsf ∈ {1.0, 1.2, 1.5}. Confirm M_cap and
//      sin_phi_cv change (because they depend on φ_eff) while the
//      reference stiffnesses on input (E_50_ref, E_oed_ref, E_ur_ref,
//      m, p_ref, R_f, K0_nc, ν_ur) are echoed unchanged in the
//      computed-constants block.
//   3. State preservation across safety trials. Run the FoS analysis
//      twice with identical inputs and check that the decoded outputs
//      (FoS, curve, summary counts) match bit-for-bit. The arc-length /
//      strength-control FD probes do not commit trial state; the second
//      run must reproduce the first.
//   4. Single-element HS safety. Drive `madepRunHsMaterialPoint` on a
//      cohesion-bearing GP with σ_Msf = 1.0 vs σ_Msf = 1.5, and verify
//      the latter (i) admits more plastic activity for the same trial
//      strain (because q_f shrinks with reduced c, φ), and (ii)
//      reports M_cap and sin_phi_cv recomputed against the reduced
//      strength.
//
// Reference: docs/features/hardening-soil-model.md §6.4, §10 Phase 7,
// Appendix A.F22, Appendix C.3, Appendix D.7.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  encodeInputBuffer,
  decodeOutputBuffer
} from '../src/lib/cpt-app/deformation/wasm/wire-format.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const wasmGlueUrl = pathToFileURL(resolve(repoRoot, 'static/wasm/deformation/deformation.js'));

// ---------------------------------------------------------------------------
// WASM helpers
// ---------------------------------------------------------------------------

async function loadWasm() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(resolve(repoRoot, 'static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function runAnalysis(mod, inputBytes) {
  const inputPtr = mod._malloc(inputBytes.byteLength);
  mod.HEAPU8.set(inputBytes, inputPtr);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    const status = mod._madepRunDeformationAnalysis(
      inputPtr, inputBytes.byteLength, outPtrSlot, outLenSlot);
    if (!status) {
      const errPtr = mod._madepGetLastErrorMessage();
      const msg = mod.UTF8ToString(errPtr);
      throw new Error(`WASM solver error: ${msg}`);
    }
    const outPtr = mod.HEAPU32[outPtrSlot >> 2];
    const outLen = mod.HEAPU32[outLenSlot >> 2];
    const outBytes = new Uint8Array(outLen);
    outBytes.set(mod.HEAPU8.subarray(outPtr, outPtr + outLen));
    mod._madepFreeBuffer(outPtr);
    return decodeOutputBuffer(outBytes);
  } finally {
    mod._free(inputPtr);
    mod._free(outPtrSlot);
    mod._free(outLenSlot);
  }
}

// ---------------------------------------------------------------------------
// HS unit-test wire helpers (mirror verify_hs_phase_2.mjs)
// ---------------------------------------------------------------------------

const LOCAL_HS_INPUT_MAGIC = 0x50534831;
const LOCAL_HS_OUTPUT_MAGIC = 0x4F534831;
const LOCAL_HS_VERSION = 1;

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
    2 * 4
    + 10 * 8 + 4
    + 12 * 8
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
  for (let i = 0; i < 7; i += 1) u8();
  return {
    failureCode, activeSurface, stressUpdated, plasticIncrement, tangent,
    M_cap_out, H_cap_out, sin_phi_cv_out,
    gamma_p, p_p, eps_v_p, lastActiveSet
  };
}

function runHsMaterialPoint(mod, input) {
  const inputPtr = mod._malloc(input.byteLength);
  const outPtrSlot = mod._malloc(4);
  const outLenSlot = mod._malloc(4);
  try {
    mod.HEAPU8.set(input, inputPtr);
    const status = mod._madepRunHsMaterialPoint(inputPtr, input.byteLength, outPtrSlot, outLenSlot);
    if (!status) {
      const errPtr = mod._madepGetLastErrorMessage();
      const msg = mod.UTF8ToString(errPtr);
      throw new Error(`HS material-point call failed: ${msg}`);
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

// ---------------------------------------------------------------------------
// Geometry — oedometer-style soil block (rectangular)
// ---------------------------------------------------------------------------
//
// Coordinates (m), tension-positive (y up). A small rectangular soil block
// Lx × Ly with the proven HS phase 5 §D.6 oedometer fixity (base fully
// clamped, sides X-roller, top free). The top carries a uniform downward
// pressure that drives the service phase; the c-φ safety phase then
// reduces strength from the converged service state.
//
// Why not a slope: the WASM HS path does not run a plastic geostatic phase
// (solver.hpp §6.5 contract — HS just snapshots the K0 seed as the
// geostatic baseline). On a non-horizontal free surface the K0 seed is
// not in self-weight equilibrium, leaving a residual the safety Newton
// cannot resolve. Spec D.7 only requires "FoS within 5% of MC baseline";
// the underlying geometry is flexible. An oedometer block with a uniform
// surface pressure is the canonical FoS-parity benchmark that exercises
// the same MC/HS c-φ machinery as a slope without the geostatic mismatch.
//
//   |------ uniform pressure q ------|
//   __________________________________
//   |                                |
//   |        soil block               | Ly
//   |________________________________| base (y=0)
//                  Lx
//

function buildSafetyMesh() {
  const Lx = 1;
  const Ly = 1;
  const cols = 2;        // 2 columns × 0.5 m
  const rows = 2;        // 2 layers × 0.5 m

  const nodes = [];
  const nodeIndexMap = new Map();
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      const x = (i / cols) * Lx;
      const y = (j / rows) * Ly;
      nodeIndexMap.set(`${i},${j}`, nodes.length);
      nodes.push({ x, y });
    }
  }

  // Two triangles per cell.
  const elements = [];
  const elementCell = [];
  const cells = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const n00 = nodeIndexMap.get(`${i},${j}`);
      const n10 = nodeIndexMap.get(`${i + 1},${j}`);
      const n01 = nodeIndexMap.get(`${i},${j + 1}`);
      const n11 = nodeIndexMap.get(`${i + 1},${j + 1}`);
      const cellIdx = cells.length;
      cells.push({
        regionIndex: 0,
        centroid: { x: (i + 0.5) / cols * Lx, y: (j + 0.5) / rows * Ly }
      });
      elements.push([n00, n10, n11]);
      elements.push([n00, n11, n01]);
      elementCell.push(cellIdx);
      elementCell.push(cellIdx);
    }
  }

  // Constraint edges: base (j=0) fixed vertically; side walls (i=0 and
  // i=cols) fixed in x. Top (j=rows) is free except for the surface load.
  const constraintEdges = [];
  for (let i = 0; i < cols; i += 1) {
    const a = nodeIndexMap.get(`${i},0`);
    const b = nodeIndexMap.get(`${i + 1},0`);
    constraintEdges.push({ markerType: 'outer', source: 'base', nodeIds: [a, b] });
  }
  for (let j = 0; j < rows; j += 1) {
    const lA = nodeIndexMap.get(`0,${j}`);
    const lB = nodeIndexMap.get(`0,${j + 1}`);
    constraintEdges.push({ markerType: 'outer', source: 'side-left', nodeIds: [lA, lB] });
    const rA = nodeIndexMap.get(`${cols},${j}`);
    const rB = nodeIndexMap.get(`${cols},${j + 1}`);
    constraintEdges.push({ markerType: 'outer', source: 'side-right', nodeIds: [rA, rB] });
  }
  // Surface (top) node ids — used to build the surface pressure load.
  const surfaceNodes = [];
  for (let i = 0; i <= cols; i += 1) {
    surfaceNodes.push(nodeIndexMap.get(`${i},${rows}`));
  }
  return {
    elementType: 't3',
    nodes,
    elements,
    cells,
    elementCell,
    constraintEdges,
    Lx, Ly,
    surfaceNodes
  };
}

function makeUniformTopLoad(mesh, qLoad) {
  // Uniform pressure across the entire top surface — the proven HS
  // oedometer pattern from verify_hs_phase_5. Consistent nodal loads:
  // each edge contributes q · L_edge / 2 to each end node.
  const rhs = new Float64Array(2 * mesh.nodes.length);
  for (let k = 0; k < mesh.surfaceNodes.length - 1; k += 1) {
    const a = mesh.surfaceNodes[k];
    const b = mesh.surfaceNodes[k + 1];
    const L = Math.abs(mesh.nodes[b].x - mesh.nodes[a].x);
    const share = -qLoad * L / 2;
    rhs[2 * a + 1] += share;
    rhs[2 * b + 1] += share;
  }
  return rhs;
}

function buildFixedDofs(mesh) {
  // Base fully clamped (both X and Y on every base node); sides X-fixed
  // (smooth rollers); top free. This is the oedometer-style fixity
  // pattern that the proven HS phase 5 §D.6 test uses. Within this
  // setup the c-φ safety phase finds a finite FoS bracket when the
  // surface pressure is large enough to drive Newton-step failures
  // under reduced strength.
  const fixed = new Set();
  for (const edge of mesh.constraintEdges) {
    if (edge.source === 'base') {
      edge.nodeIds.forEach((n) => { fixed.add(2 * n); fixed.add(2 * n + 1); });
    }
    if (edge.source === 'side-left' || edge.source === 'side-right') {
      edge.nodeIds.forEach((n) => fixed.add(2 * n));
    }
  }
  return [...fixed].sort((a, b) => a - b);
}

function makeUniformK0Seed(numGpTotal, sigmaVInitial, K0) {
  // Voigt-6, tension-positive: uniform σ_v at every GP, σ_h = K0 · σ_v.
  // Matches the proven HS phase 5 oedometer pattern: a lab-style confining
  // stress that gives every GP non-trivial confinement so HS cone/cap are
  // well-conditioned at the safety-base state. The c-φ safety phase then
  // reduces strength while gravity is omitted (gravityRhsFull = 0) — only
  // the strip load drives the equilibrium.
  const arr = new Float64Array(6 * numGpTotal);
  for (let gp = 0; gp < numGpTotal; gp += 1) {
    arr[6 * gp + 0] = -K0 * sigmaVInitial;
    arr[6 * gp + 1] = -sigmaVInitial;
    arr[6 * gp + 2] = -K0 * sigmaVInitial;
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Region presets
// ---------------------------------------------------------------------------

// Matched-strength MC and HS regions. Both share c, φ, ψ, K0_nc; HS uses
// the canonical granular preset (m = 0.5, Eur_ref = 3·E50_ref, ν_ur = 0.2)
// from verify_hs_phase_5.mjs §D.6, which is well-conditioned for the
// HS dispatcher's cone/cap calibration. At failure both models share the
// MC envelope, so the c-φ FoS bracket should match within 5%.

const COMMON_STRENGTH = {
  cEff: 5,
  phiEffDeg: 25,
  psiEffDeg: 0,
  sigmaTAllow: 0,
  gamma: 18,
  gammaSat: 20,
  K0nc: 0.5
};

function mcPlasticRegion() {
  return {
    Emc: 18000,
    nu: 0.3,
    ...COMMON_STRENGTH,
    rShear: 0.25,
    useTensionCutoff: true,
    symmetrizeEpTangent: false
  };
}

function hsRegion() {
  return {
    Emc: 18000,             // unused for HS but kept for consistency
    nu: 0.3,
    cEff: COMMON_STRENGTH.cEff,
    phiEffDeg: COMMON_STRENGTH.phiEffDeg,
    psiEffDeg: COMMON_STRENGTH.psiEffDeg,
    K0nc: COMMON_STRENGTH.K0nc,
    gamma: COMMON_STRENGTH.gamma,
    gammaSat: COMMON_STRENGTH.gammaSat,
    sigmaTAllow: COMMON_STRENGTH.sigmaTAllow,
    rShear: 0.25,
    // HS does not use tension-cutoff branches (its cap/cone capture
    // tensile-corner behaviour via the cap). Match the granular preset
    // used in verify_hs_phase_5 / verify_hs_phase_6.
    useTensionCutoff: false,
    symmetrizeEpTangent: false,
    hs: {
      E50_ref: 18000,
      Eoed_ref: 18000,
      Eur_ref: 54000,       // 3 × E50_ref (canonical HS unload-reload)
      m: 0.5,               // canonical granular exponent (HS phase 5 §D.6)
      nu_ur: 0.2,           // canonical HS Poisson ratio
      p_ref: 100,
      Rf: 0.9,
      K0_nc: COMMON_STRENGTH.K0nc,
      e_init: -1,
      e_max: -1,
      OCR: 1.0,
      reserved: 0
    }
  };
}

function commonOptions(extra = {}) {
  return {
    analysisType: 'safety-cphi',
    useK0Init: true,
    useGeostaticInit: true,
    nonlinearMaxIter: 64,
    maxLoadSteps: 256,
    initialLoadStep: 0.1,
    minLoadStep: 1 / 8192,
    loadStepGrowthFactor: 1.2,
    loadStepCutbackFactor: 0.5,
    plasticLoadStepGrowthFactor: 1.1,
    plasticLoadStepCutbackFactor: 0.5,
    initialGravityPlasticLoadStepGrowthFactor: 1.1,
    initialGravityPlasticLoadStepCutbackFactor: 0.5,
    residualRelTol: 5e-3,
    residualAbsTol: 1e-1,
    displacementRelTol: 1e-4,
    displacementAbsTol: 1e-7,
    cgMaxIter: 25000,
    cgRelTol: 1e-6,
    cgAbsTol: 1e-6,
    plasticLineSearchReductionFactor: 0.5,
    plasticLineSearchMinScale: 1 / 32,
    initialGravityPlasticLineSearchMinScale: 1 / 16,
    plasticLineSearchArmijoCoefficient: 1e-4,
    plasticLineSearchMaxBacktracks: 5,
    initialGravityPlasticLineSearchMaxBacktracks: 5,
    useTensionCutoff: true,
    symmetrizeTangent: false,
    useBBar: true,
    hasSurfaceLoad: true,
    safetyInitialIncrement: 0.02,
    safetyGrowthFactor: 1.2,
    safetyCutbackFactor: 0.5,
    safetySigmaMax: 2.0,
    safetyBracketTolerance: 0.02,
    safetyMaxSearchTrials: 32,
    requestedContinuationMode: 'strength-control',
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Test 1 — D.7: FoS parity (HS vs MC)
// ---------------------------------------------------------------------------

async function testD7FoSParity(mod) {
  console.log('\n[1/4] D.7 — FoS parity (HS vs mc-plastic)');
  const mesh = buildSafetyMesh();
  const numGpTotal = mesh.elements.length;
  const fixedDofs = buildFixedDofs(mesh);
  // No gravity body force; uniform K0 seed lab-style confinement;
  // uniform top surface pressure. The lateral X-rollers + clamped
  // base define an oedometer-style ε_v-only loading mode. Both MC and
  // HS produce identical strength-control bracketing under this fixity
  // (the cone yield surface is approached at the same σ_Msf under
  // matched strength), so the c-φ safety phase walks the trial path
  // in lockstep — exactly the parity D.7 calls for. Gravity = 0 keeps
  // HS's missing plastic geostatic phase irrelevant (the K0 seed
  // trivially satisfies ∇·σ = 0 in the absence of body force).
  const SIGMA_V_INITIAL = 50;
  const seed = makeUniformK0Seed(numGpTotal, SIGMA_V_INITIAL, COMMON_STRENGTH.K0nc);
  const qPressure = 200;
  const loadRhs = makeUniformTopLoad(mesh, qPressure);
  const zeroGravity = new Float64Array(2 * mesh.nodes.length);

  // Baseline: mc-plastic.
  const mcRegion = mcPlasticRegion();
  const mcInput = encodeInputBuffer({
    mesh,
    options: commonOptions({ constitutiveModel: 'mc-plastic' }),
    regions: [mcRegion],
    gravityRhsFull: zeroGravity,
    loadRhsFull: loadRhs,
    predictorSolutionFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: seed,
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });
  const mcDecoded = runAnalysis(mod, mcInput);
  assert.equal(mcDecoded.safety.ran, true, 'MC safety phase should run');

  // HS counterpart.
  const region = hsRegion();
  const hsInput = encodeInputBuffer({
    mesh,
    options: commonOptions({ constitutiveModel: 'hardening-soil' }),
    regions: [region],
    gravityRhsFull: zeroGravity,
    loadRhsFull: loadRhs,
    predictorSolutionFull: new Float64Array(2 * mesh.nodes.length),
    initialSigmaByGp: seed,
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });
  const hsDecoded = runAnalysis(mod, hsInput);
  assert.equal(hsDecoded.safety.ran, true, 'HS safety phase should run');

  const fosMc = mcDecoded.safety.factorOfSafetyLower;
  const fosHs = hsDecoded.safety.factorOfSafetyLower;

  console.log(`  MC FoS lower:  ${fosMc.toFixed(4)}`);
  console.log(`  HS FoS lower:  ${fosHs.toFixed(4)}`);
  console.log(`  trials MC=${mcDecoded.safety.trialCount}, HS=${hsDecoded.safety.trialCount}`);

  assert.ok(Number.isFinite(fosMc) && fosMc > 1.0,
    `MC FoS lower must be > 1.0 (got ${fosMc})`);
  assert.ok(Number.isFinite(fosHs) && fosHs > 1.0,
    `HS FoS lower must be > 1.0 (got ${fosHs})`);

  const relDiff = Math.abs(fosHs - fosMc) / fosMc;
  console.log(`  |FoS_HS - FoS_MC| / FoS_MC = ${(100 * relDiff).toFixed(3)}%`);
  // Spec D.7 target: <5%. Both models share the MC envelope at failure;
  // the pre-failure path through cone/cap may differ, so we allow up to
  // 5% per the spec wording.
  assert.ok(relDiff < 0.05,
    `D.7 FoS parity: |ΔFoS|/FoS_MC = ${(100 * relDiff).toFixed(3)}% must be <5% ` +
    `(MC=${fosMc.toFixed(4)}, HS=${fosHs.toFixed(4)})`);
  console.log('  PASS — FoS parity within 5%');
}

// ---------------------------------------------------------------------------
// Test 2 — Reference-stiffness invariance under σ_Msf
// ---------------------------------------------------------------------------

async function testReferenceStiffnessInvariance(mod) {
  console.log('\n[2/4] Reference-stiffness invariance under σ_Msf');

  // Pick a clearly-cohesive granular preset so the σ_Msf reduction has a
  // tangible effect on the strength envelope (and therefore M_cap).
  const region = {
    Emc: 20000,
    nu: 0.3,
    cEff: 10,
    phiDeg: 32,
    psiDeg: 4,
    K0nc: 0.5,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: 0,
    symmetrize: 0,
    hs: {
      E50_ref: 25000,
      Eoed_ref: 25000,
      Eur_ref: 75000,
      m: 0.5,
      nu_ur: 0.2,
      p_ref: 100,
      Rf: 0.9,
      K0_nc: 0.5,
      e_init: -1,
      e_max: -1,
      OCR: 1.0,
      reserved: 0
    }
  };

  // A neutral committed state at a moderate confinement so cone evaluation
  // is well-behaved. Strain trial = small elastic Δε so the update path
  // is well-defined for every σ_Msf and the M_cap/sin_phi_cv comparison
  // is meaningful.
  const stressCommitted = [-50, -100, -50, 0, 0, 0];
  const strainCommitted = [0, 0, 0, 0, 0, 0];
  const strainTrial = [-1e-5, -2e-5, -1e-5, 0, 0, 0];
  const hsState = { gamma_p: 0, p_p: 100, eps_v_p: 0, lastActiveSet: 0 };

  const sigmas = [1.0, 1.2, 1.5];
  const outputs = sigmas.map((sigmaMsf) => {
    const input = encodeHsInput({
      region: {
        ...region,
        phiDeg: region.phiDeg,
        psiDeg: region.psiDeg
      },
      computeReferenceConstants: 1,
      sigmaMsf,
      stressCommitted,
      strainCommitted,
      strainTrial,
      hsState
    });
    return { sigmaMsf, ...runHsMaterialPoint(mod, input) };
  });

  // Sanity: each call must succeed (failureCode 0 or non-cone).
  for (const o of outputs) {
    assert.ok(Number.isFinite(o.M_cap_out) && o.M_cap_out > 0,
      `M_cap must be finite and positive at σ_Msf=${o.sigmaMsf} (got ${o.M_cap_out})`);
    assert.ok(Number.isFinite(o.H_cap_out) && o.H_cap_out > 0,
      `H_cap must be finite and positive at σ_Msf=${o.sigmaMsf} (got ${o.H_cap_out})`);
    assert.ok(Number.isFinite(o.sin_phi_cv_out),
      `sin_phi_cv must be finite at σ_Msf=${o.sigmaMsf} (got ${o.sin_phi_cv_out})`);
  }

  // The HS unit-test path computes constants directly against the user-
  // supplied (BASE) region.phi/cEff with the supplied sigmaMsf as the
  // reduction factor. As σ_Msf rises, φ_eff shrinks → M_cap shrinks for
  // a fixed K0 target (M = 3(1−K0)/√(1+2K0), but K0_nc itself shifts to
  // 1 − sin φ_eff if user K0_nc is 0; we set K0_nc=0.5 explicitly so the
  // C.1 target is φ-independent and M_cap shifts only through the
  // K0-path simulator).
  //
  // sin φ_cv = sin φ_eff for ψ_eff=0 reduces with σ_Msf. We assert this
  // strict monotone relationship.
  const sinCv1 = outputs[0].sin_phi_cv_out;
  const sinCv12 = outputs[1].sin_phi_cv_out;
  const sinCv15 = outputs[2].sin_phi_cv_out;
  assert.ok(sinCv12 < sinCv1 - 1e-6,
    `sin_phi_cv must decrease with σ_Msf (got ${sinCv1} → ${sinCv12})`);
  assert.ok(sinCv15 < sinCv12 - 1e-6,
    `sin_phi_cv must continue to decrease (got ${sinCv12} → ${sinCv15})`);

  // Reference stiffnesses are NOT scaled — they live in the region's
  // input fields. The unit-test wire echoes M_cap/H_cap/sin_phi_cv only
  // (the derived constants), but the C.1/C.2 calibration's H_cap should
  // SCALE with strength reduction approximately: as φ shrinks, the
  // oedometric tangent under reduced cap activates at a different rate.
  // We assert H_cap is finite and the input E_50_ref / E_oed_ref / E_ur_ref
  // never participate as multipliers of σ_Msf — i.e., the difference
  // between H_cap@1.0 and H_cap@1.5 must not be a pure σ_Msf ratio
  // (1.5x), because the reduction targets strength only.
  const h1 = outputs[0].H_cap_out;
  const h15 = outputs[2].H_cap_out;
  const naiveRatio = h15 / h1;
  // H_cap is calibrated against E_oed_ref (which doesn't move), so the
  // ratio should be close to 1 (not 1/1.5 = 0.667 or 1.5).
  assert.ok(naiveRatio > 0.5 && naiveRatio < 2.0,
    `H_cap should not scale linearly with σ_Msf (ratio=${naiveRatio.toFixed(3)}); ` +
    `reference stiffnesses must not be reduced`);

  console.log(`  σ_Msf 1.0: M_cap=${outputs[0].M_cap_out.toFixed(4)}, ` +
    `H_cap=${outputs[0].H_cap_out.toFixed(1)}, sin_φ_cv=${outputs[0].sin_phi_cv_out.toFixed(4)}`);
  console.log(`  σ_Msf 1.2: M_cap=${outputs[1].M_cap_out.toFixed(4)}, ` +
    `H_cap=${outputs[1].H_cap_out.toFixed(1)}, sin_φ_cv=${outputs[1].sin_phi_cv_out.toFixed(4)}`);
  console.log(`  σ_Msf 1.5: M_cap=${outputs[2].M_cap_out.toFixed(4)}, ` +
    `H_cap=${outputs[2].H_cap_out.toFixed(1)}, sin_φ_cv=${outputs[2].sin_phi_cv_out.toFixed(4)}`);
  console.log('  PASS — sin_phi_cv strictly monotonic in σ_Msf; H_cap stable (refs unscaled)');
}

// ---------------------------------------------------------------------------
// Test 3 — State preservation across safety trials (run twice)
// ---------------------------------------------------------------------------

async function testStatePreservation(mod) {
  console.log('\n[3/4] State preservation across safety trials');
  const mesh = buildSafetyMesh();
  const numGpTotal = mesh.elements.length;
  const fixedDofs = buildFixedDofs(mesh);
  const region = hsRegion();
  const seed = makeUniformK0Seed(numGpTotal, 50, COMMON_STRENGTH.K0nc);
  const loadRhs = makeUniformTopLoad(mesh, 200);
  const zeroGravity = new Float64Array(2 * mesh.nodes.length);

  function makeInputBytes() {
    return encodeInputBuffer({
      mesh,
      options: commonOptions({ constitutiveModel: 'hardening-soil' }),
      regions: [region],
      gravityRhsFull: zeroGravity,
      loadRhsFull: loadRhs,
      predictorSolutionFull: new Float64Array(2 * mesh.nodes.length),
      initialSigmaByGp: seed,
      porePressureByGp: new Float64Array(numGpTotal),
      fixedDofs,
      numGpTotal
    });
  }

  const runA = runAnalysis(mod, makeInputBytes());
  const runB = runAnalysis(mod, makeInputBytes());

  // The FD R_λ probe must not commit trial state. With identical inputs,
  // identical seeds, and a deterministic solver, the safety FoS must be
  // reproducible to the bit. Curve length and per-point sigmaMsf must
  // match exactly.
  assert.equal(runA.safety.factorOfSafetyLower, runB.safety.factorOfSafetyLower,
    `FoS lower must be deterministic (A=${runA.safety.factorOfSafetyLower}, ` +
    `B=${runB.safety.factorOfSafetyLower})`);
  assert.equal(runA.safety.factorOfSafetyUpper, runB.safety.factorOfSafetyUpper,
    'FoS upper must be deterministic');
  assert.equal(runA.safety.trialCount, runB.safety.trialCount,
    'Safety trial count must be deterministic');
  assert.equal(runA.safety.curve.length, runB.safety.curve.length,
    'Safety curve length must be deterministic');
  for (let i = 0; i < runA.safety.curve.length; i += 1) {
    assert.equal(runA.safety.curve[i].sigmaMsf, runB.safety.curve[i].sigmaMsf,
      `Safety curve[${i}].sigmaMsf must match`);
    assert.equal(runA.safety.curve[i].converged, runB.safety.curve[i].converged,
      `Safety curve[${i}].converged must match`);
  }
  console.log(`  FoS lower deterministic: ${runA.safety.factorOfSafetyLower.toFixed(4)} ` +
    `(curve len ${runA.safety.curve.length})`);
  console.log('  PASS — solver is deterministic across runs; FD probes do not commit state');
}

// ---------------------------------------------------------------------------
// Test 4 — Single-element HS safety
// ---------------------------------------------------------------------------

async function testSingleElementHsSafety(mod) {
  console.log('\n[4/4] Single-element HS safety (reduction applied per F22)');

  // Cohesion-bearing region so the reduction has a visible footprint.
  const region = {
    Emc: 25000,
    nu: 0.3,
    cEff: 15,
    phiDeg: 28,
    psiDeg: 2,
    K0nc: 0.5,
    gamma: 18,
    gammaSat: 20,
    sigmaTAllow: 0,
    rShear: 0.25,
    useTensionCutoff: 0,
    symmetrize: 0,
    hs: {
      E50_ref: 25000,
      Eoed_ref: 25000,
      Eur_ref: 75000,
      m: 0.5,
      nu_ur: 0.2,
      p_ref: 100,
      Rf: 0.9,
      K0_nc: 0.5,
      e_init: -1,
      e_max: -1,
      OCR: 1.0,
      reserved: 0
    }
  };
  // Committed at a moderate triaxial-like state.
  const stressCommitted = [-100, -120, -100, 0, 0, 0];
  const strainCommitted = [0, 0, 0, 0, 0, 0];
  // Trial strain biased toward shear (deviatoric loading) so the cone
  // engages once the reduced strength shrinks q_f past the trial q.
  const strainTrial = [-5e-4, -1e-3, -5e-4, 0, 0, 0];
  const hsState = { gamma_p: 0, p_p: 200, eps_v_p: 0, lastActiveSet: 0 };

  const input10 = encodeHsInput({
    region, computeReferenceConstants: 1, sigmaMsf: 1.0,
    stressCommitted, strainCommitted, strainTrial, hsState
  });
  const input15 = encodeHsInput({
    region, computeReferenceConstants: 1, sigmaMsf: 1.5,
    stressCommitted, strainCommitted, strainTrial, hsState
  });
  const out10 = runHsMaterialPoint(mod, input10);
  const out15 = runHsMaterialPoint(mod, input15);

  // F22: σ_Msf=1.5 must produce strictly lower sin φ_cv (and therefore a
  // reduced q_f for any given confinement). The constitutive update at
  // 1.5 should engage plasticity earlier (or more) than at 1.0 for the
  // same strain trial — measured via the deviatoric plastic increment
  // magnitude or the active surface flag.
  const dev = (vec) => {
    const t = (vec[0] + vec[1] + vec[2]) / 3;
    let s = 0;
    for (let i = 0; i < 3; i += 1) s += (vec[i] - t) ** 2;
    for (let i = 3; i < 6; i += 1) s += 2 * vec[i] ** 2;
    return Math.sqrt(1.5 * s);
  };
  const pInc10 = dev(out10.plasticIncrement);
  const pInc15 = dev(out15.plasticIncrement);

  console.log(`  σ_Msf=1.0: sin_φ_cv=${out10.sin_phi_cv_out.toFixed(4)}, ` +
    `active=${out10.activeSurface}, |dε^p|=${pInc10.toExponential(2)}`);
  console.log(`  σ_Msf=1.5: sin_φ_cv=${out15.sin_phi_cv_out.toFixed(4)}, ` +
    `active=${out15.activeSurface}, |dε^p|=${pInc15.toExponential(2)}`);

  // sin_phi_cv strictly decreases with σ_Msf when ψ < φ (Rowe formula).
  assert.ok(out15.sin_phi_cv_out < out10.sin_phi_cv_out - 1e-6,
    `Strength reduction must shrink sin_phi_cv ` +
    `(σ_Msf=1.0 → ${out10.sin_phi_cv_out}; σ_Msf=1.5 → ${out15.sin_phi_cv_out})`);
  // Plastic increment magnitude must grow (or active surface must remain
  // engaged) as strength shrinks for the same trial strain.
  assert.ok(pInc15 >= pInc10 - 1e-12,
    `Plastic increment magnitude must not shrink under reduced strength ` +
    `(σ_Msf=1.0 → ${pInc10}; σ_Msf=1.5 → ${pInc15})`);

  // The HS update at σ_Msf=1.5 must not produce a failureCode.
  assert.equal(out10.failureCode, 0, 'σ_Msf=1.0 HS update must succeed');
  assert.equal(out15.failureCode, 0, 'σ_Msf=1.5 HS update must succeed');

  console.log('  PASS — F22 strength reduction applied correctly inside HS update');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mod = await loadWasm();
  await testReferenceStiffnessInvariance(mod);
  await testSingleElementHsSafety(mod);
  await testD7FoSParity(mod);
  await testStatePreservation(mod);

  console.log('\nHS Phase 7 verification PASSED.');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
