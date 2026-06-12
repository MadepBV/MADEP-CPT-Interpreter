#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase-2 gate: the zero-thickness Coulomb soil-wall interface on the deep
// near-cohesionless cut, re-baselined for task #56 stage C-1.
//
// HISTORY. Under the legacy consistent-Newton machinery the staged (glued)
// 3 m cut capped at lambda~0.557 and the interface runs stalled on a
// numerical plateau (KNOWN-OPEN). The task #56 experiment proved those
// stalls were machinery artifacts (the constant-elastic-K_e fixed point
// marched every stalled repro to lambda=1 at the research tolerance), and
// the initial-stiffness scheme (PLAXIS-style, default for staged runs) now
// converges ALL of these fixtures. The KNOWN-OPEN markers are replaced by
// real lambda=1 assertions; the honest final-state labels
// (finalStateResearchConverged / finalStatePlaxisConverged) are asserted so
// a loose-tolerance-only state can never masquerade as a research-grade one.
//
// Gates:
//   #1  Deep cut staged-only (interface OFF): geo AND service converge to
//       lambda = 1 (was: stall at 0.557 — re-baselined under C-1).
//   #2  Deep cut with staged + interface converges: geo (excavation) AND
//       service converged, lambda >= 1-1e-6, bounded SLS deformation, wall
//       response present, honest convergence labels.
//   #3  1.5 m and 2.0 m cuts reach lambda = 1 with the interface ON.
//   #4  Non-wall byte-identity: interface flag inert without a wall.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { __setDeformationWasmModuleForTests } from '../src/lib/cpt-app/deformation/wasm/wasm-loader.js';
import { buildBishopModelFromStageLayers } from '../src/lib/cpt-app/stage6-bishop.js';

if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

async function loadWasmModule() {
  const glue = await import(pathToFileURL(resolve('static/wasm/deformation/deformation.js')).href);
  const factory = glue.default || glue.createDeformationModule;
  return factory({ wasmBinary: readFileSync(resolve('static/wasm/deformation/deformation.wasm')) });
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
    useWasmCpuPipeline: true, useNewGpuPipeline: false, useStagedExcavation: true,
    ...extra
  };
}
function maxAbsU(result) {
  const nd = result?.nodalDisplacements || result?.solver?.nodalDisplacements || null;
  let m = 0;
  if (Array.isArray(nd)) for (const d of nd) m = Math.max(m, Math.abs(d?.ux ?? d?.[0] ?? 0), Math.abs(d?.uy ?? d?.[1] ?? 0));
  return m;
}
function wallStationCount(result) {
  const W = result?.wallResults || result?.solver?.wallResults || [];
  return W.reduce((n, w) => n + (w?.stations?.length || 0), 0);
}
function wallMaxMoment(result) {
  const W = result?.wallResults || result?.solver?.wallResults || [];
  let m = 0;
  for (const w of W) for (const v of (w?.M_passive || [])) m = Math.max(m, Math.abs(Number(v) || 0));
  return m;
}
async function runWall(cut, tip, extra) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  const model = buildBishopModelFromStageLayers(stageLayers(), steppedUiState(cut, tip));
  const result = await analyzeDeformationModel({ model, options: baseOptions(extra) });
  return { result, s: result?.solver || {} };
}
let fails = 0;
const check = (n, c, d = '') => { console.log(`${c ? 'OK  ' : 'FAIL'}  ${n}${d ? '  [' + d + ']' : ''}`); if (!c) fails++; };
const lam = (s) => Number(s.loadFactorCommitted ?? s.displayedLoadFactor) || 0;
const fmt = (s) => `geo=${s.initialPhaseConvergenceState} svc=${s.servicePhaseConvergenceState} conv=${s.converged} λ=${lam(s).toFixed(4)}`;

function nonWallModel(q) {
  const k0 = (deg) => 1 - Math.sin(deg * Math.PI / 180);
  return {
    terrain: { vertices: [{ x: 0, y: 10 }, { x: 20, y: 10 }] },
    phreatic: { vertices: [{ x: 0, y: 8.5 }, { x: 20, y: 8.5 }] },
    regions: [
      { id: 's1', label: 'S1', polygon: [{ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 6 }, { x: 0, y: 6 }],
        material: { id: 's1', label: 'S1', Emc: 30000, nu: 0.3, cEff: 5, phiEffDeg: 30, psiEffDeg: 0, gamma: 18, gammaSat: 20, K0nc: k0(30), sigmaTAllow: 0 } },
      { id: 'c1', label: 'C1', polygon: [{ x: 0, y: 6 }, { x: 20, y: 6 }, { x: 20, y: 0 }, { x: 0, y: 0 }],
        material: { id: 'c1', label: 'C1', Emc: 9000, nu: 0.35, cEff: 12, phiEffDeg: 24, psiEffDeg: 0, gamma: 19, gammaSat: 20, K0nc: k0(24), sigmaTAllow: 0 } }
    ],
    analysisLeftX: 0, analysisRightX: 20, analysisBottomY: 0, analysisTopY: 10,
    walls: [], surfaceLoad: { xStart: 8, xEnd: 12, q }, seepage: null
  };
}
async function runNonWall(extra) {
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  const result = await analyzeDeformationModel({ model: nonWallModel(40), options: baseOptions({ meshTargetArea: 0.8, ...extra }) });
  return result?.solver || {};
}
const sig = (s) => (s?.nodalDisplacements || []).reduce((a, d) => a + Math.abs(d?.ux ?? 0) + Math.abs(d?.uy ?? 0), 0);

async function main() {
  __setDeformationWasmModuleForTests(await loadWasmModule());

  console.log('== Deep 3 m near-cohesionless cut ==');
  const off3 = await runWall(3, -8, { useWallInterface: false });
  const on3 = await runWall(3, -8, { useWallInterface: true });
  console.log(`  staged-only : ${fmt(off3.s)}  maxU=${(maxAbsU(off3.result) * 1000).toFixed(2)}mm`);
  console.log(`  +interface  : ${fmt(on3.s)}  maxU=${(maxAbsU(on3.result) * 1000).toFixed(2)}mm`);
  check('#1 staged-only deep cut converges to λ=1 (task #56 C-1 re-baseline)',
    off3.s.initialPhaseConvergenceState === 'converged' &&
    off3.s.servicePhaseConvergenceState === 'converged' && lam(off3.s) >= 1 - 1e-6,
    fmt(off3.s));
  check('#2 interface deep cut: geo AND service converge to λ=1',
    on3.s.initialPhaseConvergenceState === 'converged' &&
    on3.s.servicePhaseConvergenceState === 'converged' && lam(on3.s) >= 1 - 1e-6,
    fmt(on3.s));
  const on3Phases = on3.s.convergence?.phases || [];
  check('#2 interface deep cut: honest convergence labels (research or plaxis per phase)',
    on3Phases.length >= 2 &&
    on3Phases.every((p) => p.usedInitialStiffness === true) &&
    on3Phases.every((p) => p.finalStateResearchConverged === true || p.finalStatePlaxisConverged === true),
    JSON.stringify(on3Phases.map((p) => ({ phase: p.phase, research: p.finalStateResearchConverged, plaxis: p.finalStatePlaxisConverged }))));
  const u3 = maxAbsU(on3.result);
  check('#2 interface: bounded deformation (0 < maxU < 100 mm)', u3 > 0 && u3 < 0.10, `maxU=${(u3 * 1000).toFixed(2)}mm`);
  check('#2 interface: wall response present', wallStationCount(on3.result) > 0, `stations=${wallStationCount(on3.result)}`);
  const m3 = wallMaxMoment(on3.result);
  check('#2 interface: wall carries a non-trivial moment (rigid-wall pinning regression)',
    m3 > 0.5, `max|M|=${m3.toFixed(3)} kNm/m`);

  console.log('\n== Shallower cuts with the interface ==');
  const on15 = await runWall(1.5, -8, { useWallInterface: true });
  const on20 = await runWall(2.0, -7, { useWallInterface: true });
  console.log(`  cut=1.5: ${fmt(on15.s)}   cut=2.0: ${fmt(on20.s)}`);
  check('#3 cut=1.5 converges to λ=1', lam(on15.s) >= 1 - 1e-6 &&
    on15.s.initialPhaseConvergenceState === 'converged' && on15.s.servicePhaseConvergenceState === 'converged',
    fmt(on15.s));
  check('#3 cut=2.0 converges to λ=1', lam(on20.s) >= 1 - 1e-6 &&
    on20.s.initialPhaseConvergenceState === 'converged' && on20.s.servicePhaseConvergenceState === 'converged',
    fmt(on20.s));
  check('#3 cut=1.5 produces a live wall (moment > 0.5 kNm/m)', wallMaxMoment(on15.result) > 0.5,
    `max|M|=${wallMaxMoment(on15.result).toFixed(3)}`);
  check('#3 cut=2.0 produces a live wall (moment > 0.5 kNm/m)', wallMaxMoment(on20.result) > 0.5,
    `max|M|=${wallMaxMoment(on20.result).toFixed(3)}`);

  console.log('\n== Non-wall byte-identity ==');
  const nwOff = await runNonWall({ useWallInterface: false });
  const nwOn = await runNonWall({ useWallInterface: true });
  check('#4 non-wall ON==OFF', Math.abs(sig(nwOff) - sig(nwOn)) <= 1e-9 * Math.max(1, sig(nwOff)) &&
    Number(nwOff.loadFactorCommitted) === Number(nwOn.loadFactorCommitted),
    `Δsig=${Math.abs(sig(nwOff) - sig(nwOn)).toExponential(2)}`);

  console.log(`\n${fails ? 'FAILURES' : 'ALL OK'}: ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error('THREW:', e?.stack || e?.message || e); process.exit(2); });
