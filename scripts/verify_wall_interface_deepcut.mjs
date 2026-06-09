#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Phase-2 gate: the zero-thickness Coulomb soil-wall interface releases the
// glued-band barrier and carries the DEEP near-cohesionless cut to full load.
//
// Context: staged construction (model C) alone converges cuts <= ~2 m and any
// cohesive cut, but a deep (3 m) vertical cut in c~1 sand caps at lambda~0.557:
// the retained crest soil shares the wall's mesh nodes, is dragged into tension
// the MC continuum cannot carry, and the band goes near-singular. The interface
// (wall-line node split + Coulomb springs + tension cut-off) lets the crest
// gap/slip instead — the canonical Plaxis mechanism.
//
// Gates:
//   #1  Baseline: deep cut with staged-only (interface OFF) still stalls
//       (0.2 < lambda < 0.8) — the barrier is real and the comparison honest.
//   #2  Deep cut with staged + interface converges: geo (excavation) AND
//       service converged, lambda >= 1-1e-6, bounded SLS deformation, wall
//       response present.
//   #3  No regressions: 1.5 m and 2.0 m cuts (staged-converged before) still
//       reach lambda = 1 with the interface ON.
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
  check('#1 staged-only deep cut still stalls (glued band, 0.2<λ<0.8)',
    off3.s.initialPhaseConvergenceState !== 'converged' && lam(off3.s) > 0.2 && lam(off3.s) < 0.8,
    `λ=${lam(off3.s).toFixed(4)}`);
  check('#2 interface: excavation converged', on3.s.initialPhaseConvergenceState === 'converged');
  check('#2 interface: service converged', on3.s.servicePhaseConvergenceState === 'converged');
  check('#2 interface: λ ≥ 1−1e-6 overall', on3.s.converged === true && lam(on3.s) >= 1 - 1e-6, fmt(on3.s));
  const u3 = maxAbsU(on3.result);
  check('#2 interface: bounded SLS deformation (0 < maxU < 100 mm)', u3 > 0 && u3 < 0.10, `maxU=${(u3 * 1000).toFixed(2)}mm`);
  check('#2 interface: wall response present', wallStationCount(on3.result) > 0, `stations=${wallStationCount(on3.result)}`);

  console.log('\n== Shallower cuts must stay converged with the interface ==');
  const on15 = await runWall(1.5, -8, { useWallInterface: true });
  const on20 = await runWall(2.0, -7, { useWallInterface: true });
  console.log(`  cut=1.5: ${fmt(on15.s)}   cut=2.0: ${fmt(on20.s)}`);
  check('#3 cut=1.5 converges with interface', on15.s.converged === true && lam(on15.s) >= 1 - 1e-6);
  check('#3 cut=2.0 converges with interface', on20.s.converged === true && lam(on20.s) >= 1 - 1e-6);

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
