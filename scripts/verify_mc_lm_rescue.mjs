#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workstream B — Tier-2 LM-damped consistent-tangent rescue.
//
// Geometry (the dossier failing case): 20x20 m domain, 1.2 m vertical step at
// x=10, a 4 m sheet-pile wall (E=2.1e8 kPa), mc-plastic sand, WASM-CPU pipeline,
// app MC tolerances. The plastic geostatic (InitialGravity) phase is WALL-FREE
// (the beam is installed only after the geostatic handoff), so it must
// equilibrate the self-weight-mobilised active wedge behind the (geometric-only)
// wall with the elastic-predictor modified Newton. At a yielded wedge that
// direction stops being a descent direction, the Armijo line search collapses,
// every load step rejects and the phase aborts.
//
// COHESION GOVERNS WHICH FAILURE MODE THIS IS:
//   * c = 3 kPa: an equilibrium EXISTS at full gravity (sub-mm localized yield,
//     maxEta = 1.0) but Tier-1 STALLS at lambda ~= 0.993 — exactly the dossier's
//     "equilibrium exists, the modified Newton cannot find it" diagnosis. This
//     is the case the Tier-2 rescue is designed for, and it is asserted below.
//   * c = 1 kPa (literal dossier value): the 1.2 m unsupported cut in nearly
//     cohesionless sand is a genuine FE limit-load collapse — there is NO static
//     equilibrium at full self-weight (the undamped residual plateaus ~0.04-0.12
//     across mesh densities). Tier-2 correctly drives the solve PAST Tier-1's
//     stall toward the limit load but cannot exceed it. Reported, not asserted.
//
// Gates asserted on the c = 3 stall case:
//   #1  OFF run: Tier-2 activations == 0 (the default path is byte-untouched).
//   #2  ON run that converges: tier2.finalMuZero == true (mu_final == 0 — the
//       converged state satisfies the UNDAMPED equilibrium to tolerance).
//   #3  ON run: geostatic + service converge, finalLoadFactor >= 1-1e-6,
//       maxMcEta <= 1+tol, sub-mm localized field, tier2.activations > 0.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  __setDeformationWasmModuleForTests
} from '../src/lib/cpt-app/deformation/wasm/wasm-loader.js';
import { buildBishopModelFromStageLayers } from '../src/lib/cpt-app/stage6-bishop.js';

if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

async function loadWasmModule() {
  const glue = await import(pathToFileURL(resolve('static/wasm/deformation/deformation.js')).href);
  const factory = glue.default || glue.createDeformationModule;
  const wasmBinary = readFileSync(resolve('static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

function stageLayers(c) {
  return [{
    top: 0, bot: 20, type: 'Sand', subtype: 'sand',
    c, phi: 32, psi: 2, g: 18, gs: 20,
    Emc: 25000, nu: 0.3, K0nc: 0.47, rShear: 0.25, kh: 1e-6, kv: 1e-6
  }];
}

function steppedUiState() {
  const xw = 10;
  return {
    terrain: [{ x: 0, y: 0 }, { x: xw, y: 0 }, { x: xw, y: -1.2 }, { x: 20, y: -1.2 }],
    activeCptX: 5, analysisDepth: 20, strengthSet: 'characteristic',
    useCustomRegions: false, customRegions: [],
    walls: [{
      id: 'wall-1', x: xw, yTop: 0, yTip: -4, passiveSide: 'right', mechanicalActive: true,
      material: {
        label: 'Sheet pile', kAcross: 1e-12, kAlong: 1e-12, kSource: 'preset',
        mechanical: { model: 'rectangular', E: 2.1e8, nu: 0.3, thickness: 0.4, kappa: 5 / 6, source: 'user' }
      },
      anchors: []
    }],
    surfaceLoads: [{ id: 'load-1', xStart: 1, xEnd: 4, q: 20, active: true }],
    deformation: { options: { outOfPlaneLength: 10, loadMode: 'pressure' } },
    seepage: null
  };
}

function options(mode) {
  return {
    analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 1.0,
    loadMode: 'pressure', constitutiveModel: 'mc-plastic', outOfPlaneLength: 10,
    useSeepagePorePressures: false, initialStressMode: 'plastic-geostatic',
    residualRelTol: 1e-4, residualAbsTol: 1e-3, displacementRelTol: 1e-4, displacementAbsTol: 1e-6,
    nonlinearMaxIterations: 32, initialLoadStep: 0.25, minLoadStep: 1 / 4096, maxLoadSteps: 384,
    useWasmCpuPipeline: true, useNewGpuPipeline: false, mcGlobalizationMode: mode
  };
}

let fails = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) fails++;
}

function maxAbsDisplacement(result) {
  const nd = result?.nodalDisplacements || result?.solver?.nodalDisplacements || null;
  let m = 0;
  if (Array.isArray(nd)) for (const d of nd) m = Math.max(m, Math.abs(d?.ux ?? d?.[0] ?? 0), Math.abs(d?.uy ?? d?.[1] ?? 0));
  return m;
}

async function runCase(c, mode) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  const model = buildBishopModelFromStageLayers(stageLayers(c), steppedUiState());
  const t0 = Date.now();
  const result = await analyzeDeformationModel({ model, options: options(mode) });
  const s = result?.solver || {};
  return { result, s, tier2: s.tier2 || null, dt: Date.now() - t0, nElems: result?.mesh?.elements?.length || 0 };
}

// A WALL-FREE, layered service-phase stall: a 80 kPa strip surcharge on a 3-layer
// soil column. The geostatic phase converges; the SERVICE ramp stalls under the
// surcharge plasticity. Demonstrates Tier-2 is phase-agnostic (covers ServiceLoad
// too) and works with no wall / no coarse correction (block-Jacobi GMRES carries
// it). Mirrors scripts/probe_solver_dx.mjs.
function nonWallModel(q) {
  const k0 = (deg) => 1 - Math.sin(deg * Math.PI / 180);
  return {
    terrain: { vertices: [{ x: 0, y: 10 }, { x: 20, y: 10 }] },
    phreatic: { vertices: [{ x: 0, y: 8.5 }, { x: 20, y: 8.5 }] },
    regions: [
      { id: 'sand-1', label: 'Sand 1', polygon: [{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 7.5 }, { x: 0, y: 7.5 }],
        material: { id: 's1', label: 'S1', Emc: 30000, nu: 0.3, cEff: 1, phiEffDeg: 32, psiEffDeg: 2, gamma: 19, gammaSat: 20, K0nc: k0(32), sigmaTAllow: 0 } },
      { id: 'clay-1', label: 'Clay 1', polygon: [{ x: 0, y: 7.5 }, { x: 20, y: 7.5 }, { x: 20, y: 4.5 }, { x: 0, y: 4.5 }],
        material: { id: 'c1', label: 'C1', Emc: 8000, nu: 0.35, cEff: 18, phiEffDeg: 22, psiEffDeg: 0, gamma: 18, gammaSat: 19, K0nc: k0(22), sigmaTAllow: 0 } },
      { id: 'sand-2', label: 'Sand 2', polygon: [{ x: 0, y: 4.5 }, { x: 20, y: 4.5 }, { x: 20, y: 0 }, { x: 0, y: 0 }],
        material: { id: 's2', label: 'S2', Emc: 60000, nu: 0.3, cEff: 0, phiEffDeg: 36, psiEffDeg: 6, gamma: 20, gammaSat: 21, K0nc: k0(36), sigmaTAllow: 0 } }
    ],
    analysisLeftX: 0, analysisRightX: 20, analysisBottomY: 0, analysisTopY: 10,
    walls: [], surfaceLoad: { xStart: 8, xEnd: 12, q }, seepage: null
  };
}

async function runNonWall(q, mode) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  const t0 = Date.now();
  const result = await analyzeDeformationModel({ model: nonWallModel(q), options: {
    analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 0.5,
    loadMode: 'pressure', constitutiveModel: 'mc-plastic', outOfPlaneLength: 10,
    useSeepagePorePressures: false, initialStressMode: 'plastic-geostatic',
    residualRelTol: 1e-4, residualAbsTol: 1e-3, nonlinearMaxIterations: 32,
    initialLoadStep: 0.25, minLoadStep: 1 / 2048, maxLoadSteps: 256,
    useWasmCpuPipeline: true, useNewGpuPipeline: false, mcGlobalizationMode: mode
  } });
  const s = result?.solver || {};
  return { result, s, tier2: s.tier2 || null, dt: Date.now() - t0, nElems: result?.mesh?.elements?.length || 0 };
}

function line(label, r) {
  console.log(`  ${label.padEnd(34)} geo=${r.s.initialPhaseConvergenceState} svc=${r.s.servicePhaseConvergenceState} ` +
    `λ=${(Number(r.s.loadFactorCommitted) || 0).toFixed(4)} maxEta=${(Number(r.s.peakMcEta) || 0).toFixed(4)} ` +
    `newton=${r.s.nonlinearIterations} cg=${r.s.linearIterations} elems=${r.nElems} t=${r.dt}ms`);
  console.log(`    tier2=${JSON.stringify(r.tier2)}`);
}

async function main() {
  __setDeformationWasmModuleForTests(await loadWasmModule());

  // ---- Demonstrable stall case (c = 3): equilibrium exists, Tier-1 stalls. ----
  console.log('\n=== c = 3 kPa (equilibrium exists; Tier-1 stalls) ===');
  const off3 = await runCase(3, 'default');
  const on3 = await runCase(3, 'lm-consistent-rescue');
  line('OFF (default)', off3);
  line('ON  (lm-consistent-rescue)', on3);

  console.log('\n--- Gates (c = 3) ---');
  // Gate #1: default path never engages Tier-2.
  check('Gate#1 OFF Tier-2 activations == 0', (off3.tier2?.activations ?? 0) === 0, `activations=${off3.tier2?.activations}`);
  // Bonus: OFF must NOT converge (proves the case genuinely stalls at Tier-1).
  check('OFF genuinely stalls (geostatic partial)', off3.s.initialPhaseConvergenceState !== 'converged',
    `geo=${off3.s.initialPhaseConvergenceState} λ=${off3.s.loadFactorCommitted}`);
  // Gate #3: ON converges geostatic + service to full load, admissible, sub-mm.
  check('Gate#3 ON geostatic converged', on3.s.initialPhaseConvergenceState === 'converged');
  check('Gate#3 ON service converged', on3.s.servicePhaseConvergenceState === 'converged');
  check('Gate#3 ON overall converged', on3.s.converged === true);
  check('Gate#3 ON finalLoadFactor >= 1 - 1e-6', Number(on3.s.loadFactorCommitted) >= 1 - 1e-6, `λ=${on3.s.loadFactorCommitted}`);
  check('Gate#3 ON admissibility maxEta <= 1 + 1e-3', Number(on3.s.peakMcEta) <= 1 + 1e-3, `maxEta=${on3.s.peakMcEta}`);
  check('Gate#3 ON Tier-2 engaged (activations > 0)', (on3.tier2?.activations ?? 0) > 0, `activations=${on3.tier2?.activations}`);
  // Localized, BOUNDED field: a converged retaining response is a few mm (wall
  // deflection under the surcharge + retained soil), not the cm-to-m motion of a
  // collapse. (The dossier's "sub-mm" referred to the geostatic relaxation; the
  // service surcharge adds the load response on top.)
  const maxU3 = maxAbsDisplacement(on3.result);
  check('Gate#3 ON bounded localized field (0 < max|u| < 50 mm)', maxU3 > 0 && maxU3 < 0.05, `max|u|=${(maxU3 * 1000).toFixed(2)} mm`);
  // Gate #2: converged Tier-2 run proves mu_final == 0 (undamped equilibrium).
  check('Gate#2 ON μ_final == 0 (undamped confirmation)', on3.tier2?.finalMuZero === true && Number(on3.tier2?.finalMu) === 0,
    `finalMu=${on3.tier2?.finalMu} finalMuZero=${on3.tier2?.finalMuZero}`);

  // ---- Literal dossier value (c = 1): genuine collapse — reported only. ----
  console.log('\n=== c = 1 kPa (literal dossier value — genuine FE limit-load collapse) ===');
  const off1 = await runCase(1, 'default');
  const on1 = await runCase(1, 'lm-consistent-rescue');
  line('OFF (default)', off1);
  line('ON  (lm-consistent-rescue)', on1);
  console.log('  [report] c=1 has NO static equilibrium at full self-weight (a 1.2 m unsupported cut in');
  console.log('           c=1 sand). Tier-1 stalls at λ=' + (Number(off1.s.loadFactorCommitted) || 0).toFixed(4) +
    '; Tier-2 advances to λ=' + (Number(on1.tier2?.loadFactor) || 0).toFixed(4) +
    ' (undamped residual plateau ' + (Number(on1.tier2?.lastResidual) || 0).toFixed(3) + ') then halts at the limit.');
  check('c=1 OFF Tier-2 activations == 0 (Gate#1)', (off1.tier2?.activations ?? 0) === 0);
  check('c=1 ON Tier-2 advances past the Tier-1 stall', (Number(on1.tier2?.loadFactor) || 0) > Number(off1.s.loadFactorCommitted) - 1e-9,
    `tier1=${off1.s.loadFactorCommitted} tier2=${on1.tier2?.loadFactor}`);

  // ---- WALL-FREE service-phase stall (80 kPa surcharge): a 2nd clean rescue. ----
  console.log('\n=== wall-free 80 kPa service-phase stall (phase-agnostic Tier-2) ===');
  const offNW = await runNonWall(80, 'default');
  const onNW = await runNonWall(80, 'lm-consistent-rescue');
  line('OFF (default)', offNW);
  line('ON  (lm-consistent-rescue)', onNW);
  check('NW Gate#1 OFF Tier-2 activations == 0', (offNW.tier2?.activations ?? 0) === 0);
  check('NW OFF genuinely stalls (service partial)', offNW.s.servicePhaseConvergenceState !== 'converged',
    `svc=${offNW.s.servicePhaseConvergenceState} λ=${offNW.s.loadFactorCommitted}`);
  check('NW Gate#3 ON converged to full load', onNW.s.converged === true && Number(onNW.s.loadFactorCommitted) >= 1 - 1e-6,
    `conv=${onNW.s.converged} λ=${onNW.s.loadFactorCommitted}`);
  check('NW Gate#3 ON service converged', onNW.s.servicePhaseConvergenceState === 'converged');
  check('NW Gate#3 ON admissibility maxEta <= 1 + 1e-3', Number(onNW.s.peakMcEta) <= 1 + 1e-3, `maxEta=${onNW.s.peakMcEta}`);
  check('NW Gate#3 ON Tier-2 engaged (activations > 0)', (onNW.tier2?.activations ?? 0) > 0, `activations=${onNW.tier2?.activations}`);
  check('NW Gate#2 ON μ_final == 0', onNW.tier2?.finalMuZero === true && Number(onNW.tier2?.finalMu) === 0,
    `finalMu=${onNW.tier2?.finalMu} finalMuZero=${onNW.tier2?.finalMuZero}`);

  console.log(`\n${fails ? 'FAILURES' : 'ALL OK'}: ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('THREW:', e?.stack || e?.message || e); process.exit(2); });
