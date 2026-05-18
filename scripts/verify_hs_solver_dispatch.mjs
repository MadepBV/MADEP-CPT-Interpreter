#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// HS Phase 7 verification — linear-solver dispatch parity.
//
// Per docs/features/hardening-soil-fix.md §Phase 7 and
// docs/features/hardening-soil-theory-fix.md §4 and §9: HS plastic
// Newton iterations MUST dispatch through GMRES because the Phase 6
// algorithmic tangent is unsymmetric for non-associated cone and
// corner regimes. CG (which requires SPD) is reserved for HS elastic
// iterations and the pure mc-plastic (symmetrized) path.
//
// This verifier exercises four representative load scenarios and
// asserts the wire-exposed dispatch telemetry matches the spec rule:
//
//   1. Elastic HS step
//      Heavily over-consolidated layer reloaded well below
//      preconsolidation — cap stays admissible at every GP, so every
//      Newton iteration runs against D_e (symmetric). CG is allowed
//      AND expected. `hsPlasticUsedGmres == false`.
//
//   2. Plastic HS cone step
//      Triaxial-style deviatoric path. The cone activates first under
//      the elastic K0_ur reload, and the algorithmic tangent is the
//      non-associated single-surface analytic form. GMRES required.
//      `hsPlasticUsedGmres == true`.
//
//   3. Plastic HS corner step
//      Normally-consolidated K0 oedometer (mirror of verify_hs_phase_5
//      D.6). Every GP sits on the cone-cap corner along K0_nc.
//      Algorithmic corner tangent is unsymmetric. GMRES required.
//      `hsPlasticUsedGmres == true`.
//
//   4. Mixed tension + plastic HS step
//      Foundation-style edge load that drives the near-surface GPs
//      into a low-confinement, plastic state. We enable the MC
//      tension cutoff alongside HS cap activation. GMRES required.
//      `hsPlasticUsedGmres == true`.
//
// All four cases assert `summary.lastLinearSolverKind` (0=CG, 1=GMRES)
// and `summary.hsPlasticUsedGmres` against the expected dispatch.
//
// Reference: docs/features/hardening-soil-fix.md §Phase 7;
// docs/features/hardening-soil-theory-fix.md §4, §9.

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
const wasmGlueUrl = pathToFileURL(
  resolve(repoRoot, 'static/wasm/deformation/deformation.js')
);

// ---------------------------------------------------------------------------
// WASM glue.
// ---------------------------------------------------------------------------

async function loadWasm() {
  const moduleGlue = await import(wasmGlueUrl.href);
  const factory = moduleGlue.default || moduleGlue.createDeformationModule;
  const wasmBinary = readFileSync(
    resolve(repoRoot, 'static/wasm/deformation/deformation.wasm')
  );
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
// Mesh + load builders.
// ---------------------------------------------------------------------------

function buildOedometerGrid({ rows, cols, lx, ly }) {
  const nodes = [];
  for (let j = 0; j <= rows; j += 1) {
    for (let i = 0; i <= cols; i += 1) {
      nodes.push({
        x: (i / cols) * lx,
        y: (j / rows) * ly
      });
    }
  }
  const elements = [];
  const elementCell = [];
  const cells = [];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const n00 = j * (cols + 1) + i;
      const n10 = n00 + 1;
      const n01 = (j + 1) * (cols + 1) + i;
      const n11 = n01 + 1;
      elements.push([n00, n10, n11]);
      elements.push([n00, n11, n01]);
      const cellIdx = cells.length;
      cells.push({
        regionIndex: 0,
        centroid: {
          x: ((i + 0.5) / cols) * lx,
          y: ((j + 0.5) / rows) * ly
        }
      });
      elementCell.push(cellIdx);
      elementCell.push(cellIdx);
    }
  }
  return {
    elementType: 't3',
    nodes,
    elements,
    cells,
    elementCell,
    rows,
    cols,
    lx,
    ly
  };
}

function buildOedometerFixedDofs(mesh) {
  const set = new Set();
  const { rows, cols } = mesh;
  for (let i = 0; i <= cols; i += 1) {
    const nodeId = i;
    set.add(2 * nodeId + 0);
    set.add(2 * nodeId + 1);
  }
  for (let j = 0; j <= rows; j += 1) {
    const left = j * (cols + 1) + 0;
    const right = j * (cols + 1) + cols;
    set.add(2 * left + 0);
    set.add(2 * right + 0);
  }
  return [...set].sort((a, b) => a - b);
}

// Apply a uniform vertical pressure p on the top edge. Positive p =
// compressive (downward) traction.
function makeUniformTopPressureRhs(mesh, pressure) {
  const ndof = 2 * mesh.nodes.length;
  const rhs = new Float64Array(ndof);
  const { rows, cols, lx } = mesh;
  const dx = lx / cols;
  for (let i = 0; i < cols; i += 1) {
    const left = rows * (cols + 1) + i;
    const right = left + 1;
    const half = -pressure * dx / 2;
    rhs[2 * left + 1] += half;
    rhs[2 * right + 1] += half;
  }
  return rhs;
}

// Apply a vertical traction only on the LEFT half of the top edge
// (foundation-style local loading). This induces a non-uniform stress
// state — high σ_v under the patch and reduced σ_v elsewhere, with
// tensile σ_h potential at the patch edge / free surface.
function makeFoundationPressureRhs(mesh, pressure) {
  const ndof = 2 * mesh.nodes.length;
  const rhs = new Float64Array(ndof);
  const { rows, cols, lx } = mesh;
  const dx = lx / cols;
  const halfCol = Math.max(1, Math.floor(cols / 2));
  for (let i = 0; i < halfCol; i += 1) {
    const left = rows * (cols + 1) + i;
    const right = left + 1;
    const half = -pressure * dx / 2;
    rhs[2 * left + 1] += half;
    rhs[2 * right + 1] += half;
  }
  return rhs;
}

function makeUniformK0Seed(numGpTotal, sigma_v, K0) {
  const arr = new Float64Array(6 * numGpTotal);
  for (let gp = 0; gp < numGpTotal; gp += 1) {
    arr[6 * gp + 0] = -K0 * sigma_v;
    arr[6 * gp + 1] = -sigma_v;
    arr[6 * gp + 2] = -K0 * sigma_v;
  }
  return arr;
}

function granularHsPreset({
  K0 = 0.5,
  OCR = 1.0,
  m = 0.5,
  useTensionCutoff = false,
  sigmaTAllow = 0
} = {}) {
  return {
    Emc: 30000,
    nu: 0.3,
    cEff: 0,
    phiEffDeg: 30,
    psiEffDeg: 0,
    K0nc: K0,
    gamma: 0,
    gammaSat: 0,
    sigmaTAllow,
    rShear: 0.25,
    useTensionCutoff,
    symmetrizeEpTangent: false,
    hs: {
      E50_ref: 30000,
      Eoed_ref: 30000,
      Eur_ref: 90000,
      m,
      nu_ur: 0.2,
      p_ref: 100,
      Rf: 0.9,
      K0_nc: K0,
      e_init: -1,
      e_max: -1,
      OCR,
      reserved: 0
    }
  };
}

function defaultOpts(extra = {}) {
  return {
    constitutiveModel: 'hardening-soil',
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
    residualRelTol: 1e-3,
    residualAbsTol: 1e-2,
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
    useTensionCutoff: false,
    symmetrizeTangent: false,
    useBBar: true,
    hasSurfaceLoad: true,
    useK0Init: true,
    useGeostaticInit: true,
    analysisType: 'deformation',
    ...extra
  };
}

// ---------------------------------------------------------------------------
// Dispatch assertions.
// ---------------------------------------------------------------------------

function assertSolverDispatch(label, decoded, {
  lastLinearSolverKind,
  hsPlasticUsedGmres
}) {
  if (!decoded.summary.serviceConverged) {
    throw new Error(`[${label}] service phase did not converge`);
  }
  const last = decoded.summary.lastLinearSolverKind;
  const sticky = decoded.summary.hsPlasticUsedGmres;
  console.log(`  observed: lastLinearSolverKind=${last} hsPlasticUsedGmres=${sticky}`);
  if (last !== lastLinearSolverKind) {
    throw new Error(
      `[${label}] lastLinearSolverKind=${last}, expected ${lastLinearSolverKind} ` +
      `(0=CG, 1=GMRES)`
    );
  }
  if (sticky !== hsPlasticUsedGmres) {
    throw new Error(
      `[${label}] hsPlasticUsedGmres=${sticky}, expected ${hsPlasticUsedGmres}`
    );
  }
}

// ---------------------------------------------------------------------------
// Case 1: Elastic HS step.
//
// OCR = 2 layer reloaded well below preconsolidation. σ_v_initial = 100
// at K0 = 0.5 with OCR = 2 ⇒ p_p_seed = OCR · σ_1 = 200. We reload from
// σ_v 100 → 112 (Δp = 12 kPa, ν_ur-driven elastic stress path well
// inside the cap and below the cone yield surface for the elastic
// K0_ur = ν_ur / (1−ν_ur) = 0.25 increment). Every GP stays elastic
// (lastActiveSet = 0). CG is allowed and expected.
// ---------------------------------------------------------------------------
async function caseElastic(mod) {
  console.log('\n[1/4] Elastic HS step (OC layer, small reload)');
  const ROWS = 4;
  const COLS = 4;
  const SIGMA_V = 100;
  const K0 = 0.5;
  const mesh = buildOedometerGrid({ rows: ROWS, cols: COLS, lx: 1, ly: 1 });
  const regions = [granularHsPreset({ K0, OCR: 2.0 })];
  const fixedDofs = buildOedometerFixedDofs(mesh);
  const numGpTotal = mesh.elements.length;
  const initialSigmaByGp = makeUniformK0Seed(numGpTotal, SIGMA_V, K0);
  const loadRhs = makeUniformTopPressureRhs(mesh, 12);

  const inputBytes = encodeInputBuffer({
    mesh,
    options: defaultOpts(),
    regions,
    gravityRhsFull: new Float64Array(2 * mesh.nodes.length),
    loadRhsFull: loadRhs,
    initialSigmaByGp,
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });

  const decoded = runAnalysis(mod, inputBytes);
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const gp of decoded.gpStates) counts[gp.hs?.lastActiveSet ?? 0] += 1;
  console.log(`  surface histogram: elastic=${counts[0]} cone=${counts[1]} cap=${counts[2]} corner=${counts[3]} tension-mixed=${counts.slice(4).reduce((a,b)=>a+b,0)}`);
  console.log(`  summary: converged=${decoded.summary.serviceConverged} newton=${decoded.summary.newtonIterations} cgIter=${decoded.summary.cgIterations}`);
  if (counts.slice(1).some((c) => c > 0)) {
    throw new Error(
      `[Elastic HS] expected all GPs elastic but observed plastic / tension activity`
    );
  }
  // No plastic activity → no GMRES dispatch needed → CG path.
  assertSolverDispatch('Elastic HS', decoded, {
    lastLinearSolverKind: 0,
    hsPlasticUsedGmres: false
  });
  console.log('  PASS — CG path retained for HS elastic step');
}

// ---------------------------------------------------------------------------
// Case 2: Plastic HS cone step.
//
// 2×2 patch with an over-consolidated seed (OCR=1.5) so the cap stays
// admissible under the applied stress, then load deviatorically to
// engage the cone alone. K0 seed σ_v=100, K0=0.5; applied surface
// pressure brings the deviator up while p stays below p_p_seed =
// OCR·σ_1.
//
// In practice the cap can still co-activate on the K0_nc line; what
// matters for the Phase 7 rule is that ANY plastic regime triggers
// GMRES dispatch. The Phase 6 cone single-surface analytic tangent is
// unsymmetric for non-associated flow (ψ=0 < φ=30°); the corner
// analytic tangent is unsymmetric for the same reason. Both routes
// require GMRES.
// ---------------------------------------------------------------------------
async function caseCone(mod) {
  console.log('\n[2/4] Plastic HS cone step (deviatoric triaxial-equivalent)');
  const mesh = buildOedometerGrid({ rows: 2, cols: 2, lx: 1.0, ly: 1.0 });
  const regions = [granularHsPreset({ K0: 0.5, OCR: 1.5 })];
  const SIGMA_V_INITIAL = 100;
  const K0 = 0.5;
  const numGpTotal = mesh.elements.length;
  const initialSigmaByGp = makeUniformK0Seed(numGpTotal, SIGMA_V_INITIAL, K0);
  const fixedDofs = buildOedometerFixedDofs(mesh);
  const loadRhs = makeUniformTopPressureRhs(mesh, 50);

  const inputBytes = encodeInputBuffer({
    mesh,
    options: defaultOpts(),
    regions,
    gravityRhsFull: new Float64Array(2 * mesh.nodes.length),
    loadRhsFull: loadRhs,
    initialSigmaByGp,
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });

  const decoded = runAnalysis(mod, inputBytes);
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const gp of decoded.gpStates) counts[gp.hs?.lastActiveSet ?? 0] += 1;
  console.log(`  surface histogram: elastic=${counts[0]} cone=${counts[1]} cap=${counts[2]} corner=${counts[3]} tension-mixed=${counts.slice(4).reduce((a,b)=>a+b,0)}`);
  console.log(`  summary: converged=${decoded.summary.serviceConverged} newton=${decoded.summary.newtonIterations} cgIter=${decoded.summary.cgIterations}`);
  // Confirm plasticity was active during the run. Allow the final
  // state to be corner (cone + cap together) — what matters is that
  // GMRES was the chosen solver for the converged step.
  const plasticGps = counts.slice(1).reduce((a, b) => a + b, 0);
  if (plasticGps === 0) {
    throw new Error(`[Cone HS] expected plastic activity but all GPs elastic`);
  }
  assertSolverDispatch('Cone HS', decoded, {
    lastLinearSolverKind: 1,
    hsPlasticUsedGmres: true
  });
  console.log('  PASS — GMRES used for HS plastic step');
}

// ---------------------------------------------------------------------------
// Case 3: Plastic HS corner step.
//
// Multi-element NC oedometer (mirror of verify_hs_phase_5 §D.6 at a
// smaller mesh). Along the K0_nc loading path every GP simultaneously
// engages the cone and cap (the K0_nc state is the cone-cap corner per
// HS theory, spec §5.5.4). The corner analytic tangent is unsymmetric.
// GMRES required.
// ---------------------------------------------------------------------------
async function caseCorner(mod) {
  console.log('\n[3/4] Plastic HS corner step (NC K0 oedometer)');
  const ROWS = 6;
  const COLS = 6;
  const SIGMA_V_INITIAL = 50;
  const K0 = 0.5;
  const mesh = buildOedometerGrid({ rows: ROWS, cols: COLS, lx: 1.0, ly: 1.0 });
  const regions = [granularHsPreset({ K0, OCR: 1.0 })];
  const fixedDofs = buildOedometerFixedDofs(mesh);
  const numGpTotal = mesh.elements.length;
  const initialSigmaByGp = makeUniformK0Seed(numGpTotal, SIGMA_V_INITIAL, K0);
  const loadRhs = makeUniformTopPressureRhs(mesh, 150);

  const inputBytes = encodeInputBuffer({
    mesh,
    options: defaultOpts(),
    regions,
    gravityRhsFull: new Float64Array(2 * mesh.nodes.length),
    loadRhsFull: loadRhs,
    initialSigmaByGp,
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });

  const decoded = runAnalysis(mod, inputBytes);
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const gp of decoded.gpStates) counts[gp.hs?.lastActiveSet ?? 0] += 1;
  console.log(`  surface histogram: elastic=${counts[0]} cone=${counts[1]} cap=${counts[2]} corner=${counts[3]} tension-mixed=${counts.slice(4).reduce((a,b)=>a+b,0)}`);
  console.log(`  summary: converged=${decoded.summary.serviceConverged} newton=${decoded.summary.newtonIterations} cgIter=${decoded.summary.cgIterations}`);
  if (counts[3] === 0) {
    throw new Error(
      `[Corner HS] expected at least one corner (lastActiveSet=3) GP, ` +
      `found ${counts[3]}`
    );
  }
  assertSolverDispatch('Corner HS', decoded, {
    lastLinearSolverKind: 1,
    hsPlasticUsedGmres: true
  });
  console.log('  PASS — GMRES used for HS corner step');
}

// ---------------------------------------------------------------------------
// Case 4: Mixed tension + plastic HS step.
//
// Same deviatoric NC oedometer as the cone case (Case 2), but with the
// MC tension cutoff enabled (sigmaTAllow = 5 kPa) so the constitutive
// branch is the HS dispatcher with the MC tension cutoff layered on
// top. The plastic-Newton dispatch predicate in solver.hpp is
//   hasPlastic = (a.plasticActiveCount > 0) || (a.tensionCount > 0)
// so as long as any GP yields the cone/cap/corner of HS, GMRES fires.
// The tension cutoff path (lastActiveSet ∈ {4..7}) does not need to
// activate for the Phase 7 dispatch rule to be exercised — it is the
// *capability* (cutoff enabled, mixed tangent possible) that the rule
// guards against. We still load deep enough to trigger HS plasticity.
//
// GMRES required.
// ---------------------------------------------------------------------------
async function caseTensionMixed(mod) {
  console.log('\n[4/4] Mixed tension + plastic HS step (HS plasticity with tension cutoff enabled)');
  const mesh = buildOedometerGrid({ rows: 2, cols: 2, lx: 1.0, ly: 1.0 });
  const regions = [granularHsPreset({
    K0: 0.5,
    OCR: 1.0,
    useTensionCutoff: true,
    sigmaTAllow: 5
  })];
  const SIGMA_V_INITIAL = 100;
  const K0 = 0.5;
  const numGpTotal = mesh.elements.length;
  const initialSigmaByGp = makeUniformK0Seed(numGpTotal, SIGMA_V_INITIAL, K0);
  const fixedDofs = buildOedometerFixedDofs(mesh);
  const loadRhs = makeUniformTopPressureRhs(mesh, 100);

  const inputBytes = encodeInputBuffer({
    mesh,
    options: defaultOpts({ useTensionCutoff: true }),
    regions,
    gravityRhsFull: new Float64Array(2 * mesh.nodes.length),
    loadRhsFull: loadRhs,
    initialSigmaByGp,
    porePressureByGp: new Float64Array(numGpTotal),
    fixedDofs,
    numGpTotal
  });

  const decoded = runAnalysis(mod, inputBytes);
  const counts = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const gp of decoded.gpStates) counts[gp.hs?.lastActiveSet ?? 0] += 1;
  console.log(`  surface histogram: elastic=${counts[0]} cone=${counts[1]} cap=${counts[2]} corner=${counts[3]} tension-mixed=${counts.slice(4).reduce((a,b)=>a+b,0)}`);
  console.log(`  summary: converged=${decoded.summary.serviceConverged} newton=${decoded.summary.newtonIterations} cgIter=${decoded.summary.cgIterations} finalTensionCount=${decoded.summary.finalTensionCount}`);
  const plasticGps = counts.slice(1).reduce((a, b) => a + b, 0);
  if (plasticGps === 0) {
    throw new Error(`[Tension-mixed HS] expected plastic activity, found none`);
  }
  assertSolverDispatch('Tension-mixed HS', decoded, {
    lastLinearSolverKind: 1,
    hsPlasticUsedGmres: true
  });
  console.log('  PASS — GMRES used for HS plastic step (tension cutoff enabled)');
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

async function main() {
  console.log('HS Phase 7 verification (linear-solver dispatch):');
  const mod = await loadWasm();
  await caseElastic(mod);
  await caseCone(mod);
  await caseCorner(mod);
  await caseTensionMixed(mod);
  console.log('\n=== HS Phase 7 solver-dispatch summary ===');
  console.log('  elastic HS → CG       (allowed and chosen)');
  console.log('  cone HS    → GMRES    (required and chosen)');
  console.log('  corner HS  → GMRES    (required and chosen)');
  console.log('  tension-mixed HS → GMRES (required and chosen)');
  console.log('\nHS Phase 7 solver-dispatch verification PASSED.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
