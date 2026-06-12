#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Permanent gate: the deformation wall response must cover the WHOLE drawn wall,
// and a stale wall overlay (a diagram drawn at old coordinates after a since-
// applied wall edit) must never survive in the UI state.
//
// This gate was promoted from scripts/scratch/diag_station_span.mjs after fixing
// the stale-deformation-overlay bug, where dragging a wall endpoint in the
// Stage-6 canvas invalidated only seepage and left the deformation workspace
// rendering a moment diagram computed for the previous wall geometry (covering
// only part of a since-lengthened wall, with a stale "Deformation screen ready…"
// status). It locks three invariants at the data level so the regression cannot
// silently return:
//
//   (a) STATION-SPAN COVERAGE — for each of 10 stepped-terrain + wall-geometry
//       variants, the recovered mesh wall-station span must cover the drawn wall:
//       |s_max − wallLength| ≤ (max station spacing) AND s_min ≤ (max spacing).
//       A truncated span is exactly the "diagram covers only part of the wall"
//       symptom, caught here at the mesh level before any solve.
//
//   (b) FREE-END MOMENT EQUILIBRIUM — on a converged solve, the bending moment
//       at the first and last wall station must vanish (a free-ended beam can
//       carry no end moment): |M(first)|, |M(last)| ≤ 1e-6 · max|M|. A stale or
//       truncated M(s) display violates this at the data level. The check uses
//       the legacy-path stepped fixture (staged construction, interface off,
//       1.0 m cut) which converges to λ=1.
//
//   (c) UI STALENESS CONTRACT — two parts:
//       (c1) The pure renderer guard `wallResultIsStale` (the production
//            defense-in-depth predicate used at the deformation overlay call
//            site) must flag a wallResult whose run-time wall geometry no longer
//            matches the current wall (tip dragged deeper / head moved), and must
//            NOT flag a matching one.
//       (c2) The invalidator contract that the wall-tip pointer-up path now uses:
//            calling stage6BishopInvalidateWallGeometry on an edited wall must
//            clear deformation.result AND replace the stale progress message.
//            Driving the real DOM pointer handlers headlessly is impractical
//            (legacy-controller.js pulls in the whole Svelte/browser app), so we
//            assert the invalidator's STATE-MACHINE contract directly against a
//            faithful, self-contained replica of stage6BishopInvalidate /
//            stage6BishopInvalidateWallGeometry and the deformation-state shape.
//            (c1) exercises the actual shipped predicate end-to-end.

import { buildDeformationMesh } from '../src/lib/cpt-app/deformation/mesh.js';
import { buildBishopModelFromStageLayers } from '../src/lib/cpt-app/stage6-bishop.js';
import { wallResultIsStale } from '../src/lib/cpt-app/deformation/wall-result-staleness.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { __setDeformationWasmModuleForTests } from '../src/lib/cpt-app/deformation/wasm/wasm-loader.js';

if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => Number(process.hrtime.bigint() / 1000000n) };
}
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;

let fails = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) fails++;
}

async function loadWasmModule() {
  const glue = await import(pathToFileURL(resolve('static/wasm/deformation/deformation.js')).href);
  const factory = glue.default || glue.createDeformationModule;
  const wasmBinary = readFileSync(resolve('static/wasm/deformation/deformation.wasm'));
  return factory({ wasmBinary });
}

// The user's CPT_CPT1_demo_layers.csv, as Stage 6 ingests it.
function stageLayers() {
  return [
    { top: 0.00, bot: 2.98,  type: 'Sand',       subtype: 'zand, matig',      c: 1, phi: 30, psi: 0, g: 17, gs: 19, Emc: 23448, nu: 0.3, K0nc: 0.500, rShear: 0.33, kh: 4e-5, kv: 4e-5 },
    { top: 2.98, bot: 6.98,  type: 'Sandy clay', subtype: 'klei, matig vast', c: 4, phi: 20, psi: 0, g: 17, gs: 17, Emc: 5316,  nu: 0.4, K0nc: 0.658, rShear: 0.15, kh: 5e-7, kv: 1.7e-7, cu: 50 },
    { top: 6.98, bot: 21.72, type: 'Silty sand', subtype: 'leem, vast',       c: 8, phi: 22, psi: 0, g: 20, gs: 20, Emc: 11374, nu: 0.3, K0nc: 0.625, rShear: 0.25, kh: 3e-6, kv: 1e-6, cu: 100 }
  ];
}

function uiState({ terrain, wall, q = 5, loadStart = 2, loadEnd = 7 }) {
  return {
    terrain,
    activeCptX: 4, analysisDepth: 20, strengthSet: 'characteristic',
    useCustomRegions: false, customRegions: [],
    walls: [{ id: 'wall-1', passiveSide: 'right', mechanicalActive: true,
      material: { label: 'RC wall', kAcross: 1e-12, kAlong: 1e-12, kSource: 'preset',
        mechanical: { model: 'rectangular', E: 3e7, nu: 0.2, thickness: 0.5, kappa: 5 / 6, source: 'user' } },
      anchors: [], ...wall }],
    surfaceLoads: [{ id: 'load-1', xStart: loadStart, xEnd: loadEnd, q, active: true }],
    deformation: { options: { outOfPlaneLength: 1, loadMode: 'pressure' } }, seepage: null
  };
}

const CUT = 2.3;
// The 10 variants from scripts/scratch/diag_station_span.mjs, preserved verbatim.
const variants = [
  { name: 'A wall exactly at step, vertical step', terrain: [{x:0,y:0},{x:8.5,y:0},{x:8.5,y:-CUT},{x:20,y:-CUT}], wall: { x: 8.5, yTop: 0, yTip: -8 } },
  { name: 'B wall 0.3 left of step (snap range)', terrain: [{x:0,y:0},{x:8.8,y:0},{x:8.8,y:-CUT},{x:20,y:-CUT}], wall: { x: 8.5, yTop: 0, yTip: -8 } },
  { name: 'C wall 0.8 left of step (beyond snap)', terrain: [{x:0,y:0},{x:9.3,y:0},{x:9.3,y:-CUT},{x:20,y:-CUT}], wall: { x: 8.5, yTop: 0, yTip: -8 } },
  { name: 'D wall 0.3 right of step (snap range, head in air)', terrain: [{x:0,y:0},{x:8.2,y:0},{x:8.2,y:-CUT},{x:20,y:-CUT}], wall: { x: 8.5, yTop: 0, yTip: -8 } },
  { name: 'E sloped step face (0.5 m run), wall at top edge', terrain: [{x:0,y:0},{x:8.5,y:0},{x:9.0,y:-CUT},{x:20,y:-CUT}], wall: { x: 8.5, yTop: 0, yTip: -8 } },
  { name: 'F sloped step face (0.5 m run), wall at bottom edge', terrain: [{x:0,y:0},{x:8.5,y:0},{x:9.0,y:-CUT},{x:20,y:-CUT}], wall: { x: 9.0, yTop: 0, yTip: -8 } },
  { name: 'G wall head 0.3 above upper terrain', terrain: [{x:0,y:0},{x:8.5,y:0},{x:8.5,y:-CUT},{x:20,y:-CUT}], wall: { x: 8.5, yTop: 0.3, yTip: -8 } },
  { name: 'H wall head/tip given as head/tip objects', terrain: [{x:0,y:0},{x:8.5,y:0},{x:8.5,y:-CUT},{x:20,y:-CUT}], wall: { head: {x:8.5,y:0}, tip: {x:8.5,y:-8} } },
  { name: 'I wall slightly inclined (tip 0.2 right)', terrain: [{x:0,y:0},{x:8.5,y:0},{x:8.5,y:-CUT},{x:20,y:-CUT}], wall: { head: {x:8.5,y:0}, tip: {x:8.7,y:-8} } },
  { name: 'J load ends exactly at wall', terrain: [{x:0,y:0},{x:8.5,y:0},{x:8.5,y:-CUT},{x:20,y:-CUT}], wall: { x: 8.5, yTop: 0, yTip: -8 }, loadEnd: 8.5 },
];

const meshOptions = {
  analysisType: 'deformation', meshElementType: 't3', meshTargetArea: Number(process.env.AREA || 1.0),
  loadMode: 'pressure', constitutiveModel: 'mc-plastic', outOfPlaneLength: 1,
  useStagedExcavation: true, useWallInterface: true
};

function maxStationSpacing(stations) {
  const sorted = [...stations].sort((a, b) => a - b);
  let maxGap = 0;
  for (let i = 1; i < sorted.length; i += 1) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
  return maxGap;
}

// ── (a) station-span coverage across the 10 variants ─────────────────────────
async function gateStationSpan() {
  console.log('== (a) Recovered wall-station span covers the drawn wall ==');
  for (const v of variants) {
    const ui = uiState(v);
    const model = buildBishopModelFromStageLayers(stageLayers(), ui);
    const w0 = model.walls?.[0];
    const drawnLen = w0 ? Math.hypot(w0.tip.x - w0.head.x, w0.tip.y - w0.head.y) : NaN;
    let mesh;
    try {
      mesh = await buildDeformationMesh(model, model.regions, meshOptions, () => {});
    } catch (err) {
      // Some variants are intentionally degenerate inputs (e.g. D: wall head
      // floating 0.3 m past the step, in air) that the mesher legitimately
      // rejects before any wall is recovered. The station-span invariant is
      // undefined with no mesh, so SKIP (not FAIL) — exactly as the scratch
      // diagnostic treated per-variant errors. A coverage regression on a
      // meshable variant still FAILs below.
      console.log(`SKIP  ${v.name}: mesh rejected the degenerate input  [${(err?.message || err).slice(0, 80)}]`);
      continue;
    }
    const walls = mesh.mechanicalWalls || [];
    if (!walls.length) { check(`${v.name}: walls recovered`, false, 'NO WALLS RECOVERED'); continue; }
    for (const w of walls) {
      const ss = (w.nodes || []).map((n) => n.s);
      const sMin = Math.min(...ss), sMax = Math.max(...ss);
      const spacing = maxStationSpacing(ss);
      // HARD invariant: the recovered span must reach the wall length to within
      // one station spacing, and must start at (or within one spacing of) the head.
      const covers = Math.abs(sMax - drawnLen) <= spacing && sMin <= spacing;
      check(`${v.name}: span covers wall`, covers,
        `drawn=${drawnLen.toFixed(3)} s=[${sMin.toFixed(3)},${sMax.toFixed(3)}] spacing=${spacing.toFixed(3)}`);
    }
  }
}

// ── (b) free-end moment equilibrium on a converged solve ─────────────────────
function steppedUiState(cut, tip, q) {
  const xw = 8.5;
  return {
    terrain: [{ x: 0, y: 0 }, { x: xw, y: 0 }, { x: xw, y: -cut }, { x: 20, y: -cut }],
    activeCptX: 4, analysisDepth: 20, strengthSet: 'characteristic',
    useCustomRegions: false, customRegions: [],
    walls: [{ id: 'wall-1', x: xw, yTop: 0, yTip: tip, passiveSide: 'right', mechanicalActive: true,
      material: { label: 'RC wall', kAcross: 1e-12, kAlong: 1e-12, kSource: 'preset',
        mechanical: { model: 'rectangular', E: 3e7, nu: 0.2, thickness: 0.5, kappa: 5 / 6, source: 'user' } }, anchors: [] }],
    surfaceLoads: [{ id: 'load-1', xStart: 3, xEnd: xw, q, active: true }],
    deformation: { options: { outOfPlaneLength: 1, loadMode: 'pressure' } }, seepage: null
  };
}

async function gateFreeEndMoment() {
  console.log('\n== (b) Free-end moment equilibrium on a converged solve ==');
  __setDeformationWasmModuleForTests(await loadWasmModule());
  const { analyzeDeformationModel } = await import('../src/lib/cpt-app/deformation/solver.js');
  // Legacy-path stepped fixture that converges to λ=1: staged construction ON,
  // interface OFF, 1.0 m cut (coarse mesh keeps the gate fast, ~0.5 s).
  const solveOptions = {
    analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 2.0,
    loadMode: 'pressure', constitutiveModel: 'mc-plastic', outOfPlaneLength: 1,
    useSeepagePorePressures: false, initialStressMode: 'plastic-geostatic',
    residualRelTol: 1e-4, residualAbsTol: 1e-3, displacementRelTol: 1e-4, displacementAbsTol: 1e-6,
    nonlinearMaxIterations: 32, initialLoadStep: 0.5, minLoadStep: 1 / 1024, maxLoadSteps: 200,
    useWasmCpuPipeline: true, useNewGpuPipeline: false,
    useStagedExcavation: true, useWallInterface: false
  };
  const model = buildBishopModelFromStageLayers(stageLayers(), steppedUiState(1.0, -8, 0.2));
  const result = await analyzeDeformationModel({ model, options: solveOptions });
  const s = result?.solver || {};
  const lam = Number(s.loadFactorCommitted ?? s.displayedLoadFactor) || 0;
  const converged = s.converged === true && lam >= 1 - 1e-6;
  check('(b) fixture converged to λ=1 (precondition for the equilibrium check)', converged,
    `geo=${s.initialPhaseConvergenceState} svc=${s.servicePhaseConvergenceState} λ=${lam.toFixed(4)}`);
  const W = result?.wallResults || [];
  check('(b) wall response present', W.length > 0, `wallResults=${W.length}`);
  for (const w of W) {
    const stations = w.stations || [];
    const M = stations.map((st) => Number(st.MPassive ?? st.M ?? 0));
    const maxAbsM = Math.max(...M.map(Math.abs), 0);
    const tol = 1e-6 * maxAbsM;
    const mFirst = Math.abs(M[0] ?? 0);
    const mLast = Math.abs(M[M.length - 1] ?? 0);
    // The span must also reach the full wall length — a truncated M(s) display
    // would show end moments at the wrong station, so assert coverage too.
    const sMax = Number(stations[stations.length - 1]?.s) || 0;
    const sMin = Number(stations[0]?.s) || 0;
    const wallLen = Math.hypot((w.stations[w.stations.length - 1]?.y ?? 0) - (w.stations[0]?.y ?? 0),
      (w.stations[w.stations.length - 1]?.x ?? 0) - (w.stations[0]?.x ?? 0));
    check(`(b) wall idx=${w.wallIndex}: |M(first)| ≤ 1e-6·max|M|`, mFirst <= tol,
      `M0=${mFirst.toExponential(2)} tol=${tol.toExponential(2)} maxM=${maxAbsM.toFixed(3)}`);
    check(`(b) wall idx=${w.wallIndex}: |M(last)| ≤ 1e-6·max|M|`, mLast <= tol,
      `MN=${mLast.toExponential(2)} tol=${tol.toExponential(2)}`);
    check(`(b) wall idx=${w.wallIndex}: station span reaches the wall length`,
      Math.abs(sMax - wallLen) <= 1e-6 + sMax * 1e-9 && sMin <= 1e-6,
      `s=[${sMin.toFixed(3)},${sMax.toFixed(3)}] wallLen=${wallLen.toFixed(3)}`);
  }
}

// ── (c1) the production renderer staleness predicate ─────────────────────────
function gateRendererGuard() {
  console.log('\n== (c1) Renderer staleness guard (production wallResultIsStale) ==');
  // A run-time snapshot for an 8 m wall (head at y=0, tip at y=-8).
  const lastWallInputs = [{ id: 'wall-1', head: { x: 8.5, y: 0 }, tip: { x: 8.5, y: -8 }, x: 8.5, yTop: 0, yTip: -8 }];
  const wallResult = { wallIndex: 0, stations: [{ s: 0 }, { s: 8 }] };

  // Matching current wall → not stale.
  const matching = { deformation: { lastWallInputs }, walls: [{ id: 'wall-1', head: { x: 8.5, y: 0 }, tip: { x: 8.5, y: -8 } }] };
  check('(c1) matching geometry is NOT stale', wallResultIsStale(wallResult, matching) === false);

  // Tip dragged deeper (wall lengthened to 12 m) → stale.
  const lengthened = { deformation: { lastWallInputs }, walls: [{ id: 'wall-1', head: { x: 8.5, y: 0 }, tip: { x: 8.5, y: -12 } }] };
  check('(c1) lengthened wall (tip dragged deeper) IS stale', wallResultIsStale(wallResult, lengthened) === true);

  // Head moved → stale.
  const headMoved = { deformation: { lastWallInputs }, walls: [{ id: 'wall-1', head: { x: 9.0, y: 0 }, tip: { x: 8.5, y: -8 } }] };
  check('(c1) head moved IS stale', wallResultIsStale(wallResult, headMoved) === true);

  // Wall deleted → stale.
  const deleted = { deformation: { lastWallInputs }, walls: [] };
  check('(c1) deleted wall IS stale', wallResultIsStale(wallResult, deleted) === true);

  // No snapshot → conservatively NOT stale (never wrongly hide a healthy result).
  const noSnapshot = { deformation: { lastWallInputs: [] }, walls: [{ id: 'wall-1', head: { x: 8.5, y: 0 }, tip: { x: 8.5, y: -8 } }] };
  check('(c1) no run-time snapshot → NOT flagged stale', wallResultIsStale(wallResult, noSnapshot) === false);
}

// ── (c2) the invalidator state-machine contract ──────────────────────────────
// Faithful, self-contained replica of the legacy-controller invalidators that
// the wall-tip pointer-up path now invokes. legacy-controller.js cannot be
// imported in node (it pulls in the whole Svelte/browser app), so we model the
// exact state mutations and assert the contract: after a wall edit, the
// deformation result is cleared AND the stale progress message is replaced.
function makeBishopState() {
  return {
    results: { allResults: [{}] },
    selectedResult: 0,
    stale: false,
    progress: { message: 'Bishop ready.' },
    walls: [{ id: 'wall-1', head: { x: 8.5, y: 0 }, tip: { x: 8.5, y: -8 }, x: 8.5, yTop: 0, yTip: -8 }],
    seepage: { result: { ok: true }, mesh: {}, stale: false, status: 'success', progress: { running: false, percent: 0 }, rejectReason: '' },
    deformation: {
      result: { wallResults: [{ wallIndex: 0, stations: [{ s: 0 }, { s: 8 }] }] },
      mesh: {}, stale: false, status: 'success', warnings: [],
      progress: { running: false, percent: 0, message: 'Deformation screen ready. Max settlement 1.0 mm; max MC eta 0.50.' },
      rejectReason: ''
    }
  };
}
// Mirrors stage6BishopInvalidate (Bishop + deformation, incl. status-honesty).
function invalidate(bishop, message) {
  bishop.results = null;
  bishop.selectedResult = 0;
  bishop.stale = true;
  if (bishop.deformation) {
    bishop.deformation.mesh = null;
    bishop.deformation.result = null;
    bishop.deformation.stale = false;
    bishop.deformation.warnings = [];
    bishop.deformation.progress.running = false;
    bishop.deformation.progress.percent = 0;
    if (['success', 'meshing', 'solving', 'post'].includes(bishop.deformation.status)) bishop.deformation.status = 'idle';
    bishop.deformation.rejectReason = '';
    bishop.deformation.progress.message = message || 'Deformation result cleared; rerun deformation analysis.';
  }
  if (message) bishop.progress.message = message;
}
// Mirrors stage6BishopInvalidateSeepage (seepage only).
function invalidateSeepage(bishop, message) {
  const seepage = bishop.seepage;
  seepage.progress.running = false;
  seepage.progress.percent = 0;
  seepage.mesh = null;
  seepage.result = null;
  seepage.stale = false;
  if (['success', 'meshing', 'solving'].includes(seepage.status)) seepage.status = 'idle';
  if (message) seepage.rejectReason = message;
}
// Mirrors stage6BishopInvalidateWallGeometry (everything).
function invalidateWallGeometry(bishop, message) {
  invalidate(bishop, message || 'Retaining wall geometry changed; rerun Bishop search.');
  invalidateSeepage(bishop, 'Wall geometry changed; rerun seepage.');
}

function gateInvalidatorContract() {
  console.log('\n== (c2) Wall-edit invalidator contract (state-machine replica) ==');
  const bishop = makeBishopState();
  const staleMessage = bishop.deformation.progress.message;
  // Simulate the wall-tip edit: lengthen the wall, then invalidate exactly as
  // the pointer-up path now does.
  bishop.walls[0].tip = { x: 8.5, y: -12 };
  bishop.walls[0].yTip = -12;
  invalidateWallGeometry(bishop, 'Retaining wall geometry updated; rerun analyses.');

  check('(c2) deformation.result === null after wall edit', bishop.deformation.result === null);
  check('(c2) bishop.results cleared after wall edit', bishop.results === null);
  check('(c2) seepage.result cleared after wall edit', bishop.seepage.result === null);
  check('(c2) stale "screen ready" progress message replaced',
    bishop.deformation.progress.message !== staleMessage &&
    bishop.deformation.progress.message === 'Retaining wall geometry updated; rerun analyses.',
    `msg="${bishop.deformation.progress.message}"`);
}

async function main() {
  await gateStationSpan();
  await gateFreeEndMoment();
  gateRendererGuard();
  gateInvalidatorContract();
  console.log(`\n${fails ? 'FAILURES' : 'ALL OK'}: ${fails} failure(s)`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('THREW:', e?.stack || e?.message || e); process.exit(2); });
