#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Task #56 Stage C-1 gate: the initial-stiffness (PLAXIS-style) global scheme.
//
// Gates:
//   #1  ADVERSARIAL CONTROL — the c≈1 kPa 3 m unsupported cut (legacy
//       wall-free geostatic), forced through the NEW machinery (debug solver
//       mode 3), must NOT converge and must classify as SOIL-BODY COLLAPSE
//       (CSP < 0.015 at the step floor). This is the task's hard rule: the
//       genuine physical limit must never read as converged. The stall band
//       is asserted around the historical λ=0.4511 (loose-tolerance steps may
//       legitimately commit slightly past it).
//   #2  Scheme scoping — a non-staged MC wall run must NOT use the
//       initial-stiffness scheme (usedInitialStiffness=false in telemetry):
//       the scheme is keyed on stagedExcavationActive, never on
//       isInitialGravityPhase (plan review item 8).
//   #3  Default-on behavior — the staged+interface 1.5 m repro converges to
//       λ=1 through the scheme with CG only (no GMRES dispatch) and honest
//       final-state labels (research-converged).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { __setDeformationWasmModuleForTests } from '../src/lib/cpt-app/deformation/wasm/wasm-loader.js';
import { buildBishopModelFromStageLayers } from '../src/lib/cpt-app/stage6-bishop.js';

if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

let wasmModule = null;
async function loadWasmModule() {
  const glue = await import(pathToFileURL(resolve('static/wasm/deformation/deformation.js')).href);
  const factory = glue.default || glue.createDeformationModule;
  wasmModule = await factory({ wasmBinary: readFileSync(resolve('static/wasm/deformation/deformation.wasm')) });
  return wasmModule;
}

function stageLayers() {
  return [
    { top: 0.00, bot: 2.98,  type: 'Sand',       subtype: 'zand, matig',      c: 1, phi: 30, psi: 0, g: 17, gs: 19, Emc: 23448, nu: 0.3, K0nc: 0.500, rShear: 0.33, kh: 4e-5, kv: 4e-5 },
    { top: 2.98, bot: 6.98,  type: 'Sandy clay', subtype: 'klei, matig vast', c: 4, phi: 20, psi: 0, g: 17, gs: 17, Emc: 5316,  nu: 0.4, K0nc: 0.658, rShear: 0.15, kh: 5e-7, kv: 1.7e-7, cu: 50 },
    { top: 6.98, bot: 21.72, type: 'Silty sand', subtype: 'leem, vast',       c: 8, phi: 22, psi: 0, g: 20, gs: 20, Emc: 11374, nu: 0.3, K0nc: 0.625, rShear: 0.25, kh: 3e-6, kv: 1e-6, cu: 100 }
  ];
}
function steppedUiState(cut, tip) {
  const xw = 8.5;
  return {
    terrain: [{ x: 0, y: 0 }, { x: xw, y: 0 }, { x: xw, y: -cut }, { x: 20, y: -cut }],
    activeCptX: 4, analysisDepth: 20, strengthSet: 'characteristic',
    useCustomRegions: false, customRegions: [],
    walls: [{ id: 'wall-1', x: xw, yTop: 0, yTip: tip, passiveSide: 'right', mechanicalActive: true,
      material: { label: 'RC wall', kAcross: 1e-12, kAlong: 1e-12, kSource: 'preset',
        mechanical: { model: 'rectangular', E: 3e7, nu: 0.2, thickness: 0.5, kappa: 5 / 6, source: 'user' } }, anchors: [] }],
    surfaceLoads: [{ id: 'load-1', xStart: 3, xEnd: xw, q: 0.2, active: true }],
    deformation: { options: { outOfPlaneLength: 1, loadMode: 'pressure' } }, seepage: null
  };
}
function baseOptions(extra) {
  return {
    analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 1.2,
    loadMode: 'pressure', constitutiveModel: 'mc-plastic', outOfPlaneLength: 1,
    useSeepagePorePressures: false, initialStressMode: 'plastic-geostatic',
    residualRelTol: 1e-4, residualAbsTol: 1e-3, displacementRelTol: 1e-4, displacementAbsTol: 1e-6,
    nonlinearMaxIterations: 32, initialLoadStep: 0.25, minLoadStep: 1 / 4096, maxLoadSteps: 384,
    useWasmCpuPipeline: true, useNewGpuPipeline: false,
    ...extra
  };
}
async function runWall(cut, tip, extra, debugMode = 0) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  if (typeof wasmModule?._madepSetDebugSolverMode === 'function') {
    wasmModule._madepSetDebugSolverMode(debugMode);
  }
  const model = buildBishopModelFromStageLayers(stageLayers(), steppedUiState(cut, tip));
  try {
    const result = await analyzeDeformationModel({ model, options: baseOptions(extra) });
    return { result, s: result?.solver || {} };
  } finally {
    if (typeof wasmModule?._madepSetDebugSolverMode === 'function') {
      wasmModule._madepSetDebugSolverMode(0);
    }
  }
}

let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'OK  ' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); if (!c) fails++; };
const lam = (s) => Number(s.loadFactorCommitted ?? s.displayedLoadFactor) || 0;
const fmt = (s) => `geo=${s.initialPhaseConvergenceState} svc=${s.servicePhaseConvergenceState} λ=${lam(s).toFixed(4)}`;
const phases = (s) => s?.convergence?.phases || [];

async function main() {
  await loadWasmModule();
  __setDeformationWasmModuleForTests(wasmModule);

  console.log('== #1 Adversarial control: c≈1 unsupported 3 m cut, FORCED initial-stiffness ==');
  const ctrl = await runWall(3, -8, { useStagedExcavation: false }, /*debugMode=*/3);
  const ctrlPhase = phases(ctrl.s).find((p) => p.phase === 'initial-gravity') || null;
  console.log(`  ${fmt(ctrl.s)}  phase=${JSON.stringify(ctrlPhase && {
    verdict: ctrlPhase.verdict, csp: ctrlPhase.csp, cspAtFailure: ctrlPhase.cspAtFailure,
    usedInitialStiffness: ctrlPhase.usedInitialStiffness, lambda: ctrlPhase.lambdaCommitted
  })}`);
  check('#1 control traversed the initial-stiffness machinery',
    ctrlPhase !== null && ctrlPhase.usedInitialStiffness === true, '');
  check('#1 control did NOT converge (genuine limit stays a failure)',
    ctrl.s.initialPhaseConvergenceState !== 'converged' && ctrlPhase?.converged === false,
    fmt(ctrl.s));
  check('#1 control classified as SOIL-BODY COLLAPSE (CSP discriminator)',
    ctrlPhase?.verdict === 'collapse' &&
    Number(ctrlPhase?.cspAtFailure) < 0.015,
    `verdict=${ctrlPhase?.verdict} cspAtFailure=${ctrlPhase?.cspAtFailure}`);
  check('#1 control stall in the honest band around the legacy limit (0.40 ≤ λ ≤ 0.60)',
    lam(ctrl.s) >= 0.40 && lam(ctrl.s) <= 0.60, `λ=${lam(ctrl.s).toFixed(4)}`);
  check('#1 collapse classification surfaced as an honest warning',
    (ctrl.result?.warnings || []).some((w) => /SOIL-BODY COLLAPSE/.test(String(w))), '');

  console.log('\n== #2 Scheme scoping: non-staged run must keep the legacy Newton path ==');
  const legacy = await runWall(3, -8, { useStagedExcavation: false }, /*debugMode=*/0);
  const legacyUsed = phases(legacy.s).some((p) => p.usedInitialStiffness === true);
  console.log(`  ${fmt(legacy.s)}  phases=${JSON.stringify(phases(legacy.s).map((p) => ({ phase: p.phase, is: p.usedInitialStiffness })))}`);
  check('#2 non-staged run never used the initial-stiffness scheme', legacyUsed === false, '');
  check('#2 non-staged legacy stall unchanged (0.2 < λ < 0.6)',
    legacy.s.initialPhaseConvergenceState !== 'converged' && lam(legacy.s) > 0.2 && lam(legacy.s) < 0.6,
    `λ=${lam(legacy.s).toFixed(4)}`);

  console.log('\n== #3 Default-on: staged+interface 1.5 m repro through the scheme ==');
  const head = await runWall(1.5, -8, { useStagedExcavation: true, useWallInterface: true }, 0);
  const headPhases = phases(head.s);
  console.log(`  ${fmt(head.s)}  phases=${JSON.stringify(headPhases.map((p) => ({
    phase: p.phase, conv: p.converged, research: p.finalStateResearchConverged, plaxis: p.finalStatePlaxisConverged
  })))}`);
  check('#3 staged+interface converges to λ=1 through the scheme',
    head.s.initialPhaseConvergenceState === 'converged' &&
    head.s.servicePhaseConvergenceState === 'converged' &&
    lam(head.s) >= 1 - 1e-6 &&
    headPhases.length >= 2 && headPhases.every((p) => p.usedInitialStiffness === true),
    fmt(head.s));
  check('#3 honest final-state labels present (research or plaxis converged)',
    headPhases.every((p) => p.finalStateResearchConverged === true || p.finalStatePlaxisConverged === true),
    '');
  check('#3 CG-only (initial-stiffness never dispatches GMRES)',
    head.s.lastLinearSolverKind === 0, `kind=${head.s.lastLinearSolverKind}`);

  console.log(`\n${fails ? 'FAILURES' : 'ALL OK'}: ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error('THREW:', e?.stack || e?.message || e); process.exit(2); });
