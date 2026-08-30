#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 9b / PR 18b (worklog/refactor/22-pr18b-seepslope-model.md): the
// Seep / Slope soil-model sync and the result invalidation moved out of legacy-controller.js into
// src/lib/cpt-app/seepslope/model/** as pure functions, and the canvas draw path stopped mutating
// the state. Pattern of scripts/verify_seepslope_state.mjs: the controller of a base ref (default
// `integration-r`) and the working-tree controller are each loaded under Node through the Tier-B
// loader in their own child process, dump the same observations to JSON, and the parent compares
// the two dumps byte for byte (JSON text, key order included):
//
//   (a) the soil-model sync — S.stage6.bishop, progress.message, the returned model
//       (S.stage6Cache.bishopModel) — after the sync on: the seeded loadDemo() CPT, every CPT of
//       the three project fixtures (legacy-v0.5.2, multi-3cpt, single-layered), the two synthetic
//       legacy bishop blocks of verify_seepslope_state.mjs (fresh + layered), and a walk on the
//       `layered` fixture under a seeded clock + PRNG that reaches every branch of the sync: first
//       import, the HS mirror after a Stage 4 stiffness-method toggle (materials patched, no
//       invalidation), a Stage 3 layer edit (signature → "Active CPT layers changed…" with the
//       results cleared), the strength-set change ("Material strength set changed…"), a legacy
//       material.hs without the consistent-tangent flag (the HS prompt), a custom region without
//       an id (a region_ id allocated — compared verbatim), an unsorted terrain / out-of-range CPT /
//       zones / loads / a legacy x-yTop-yTip wall / a one-vertex drain / a dangling wall, drain,
//       region and draft-material selection / the split tool without a selection / useCustomRegions
//       without polygons / customRegions not an array — each through the sync-only handler
//       (stage6BishopSetDrainField on an unknown drain: ensure + sync, no render) and then a
//       renderStage6() (sync + current model + seepage-state sync + render), idempotence after each
//   (b) the invalidation transitions — every façade through its window handlers on synthetic
//       result states (results / mesh / result present or not, every status, with and without a
//       message, keepMesh × preserveSolvedState): stage6BishopInvalidateSeepage via
//       SetField('seepage.options.*') (true, true) and Clear('seepageResults') (false),
//       InvalidateDeformation via SetField('deformation.options.*') and Clear('deformationResults'),
//       Invalidate via SetField('useFemPorePressure') (message) and Clear('phreatic') (no message),
//       InvalidateWallGeometry via SetWallField('tip.y') — the Stage 6 shell shows the bearing app
//       during this walk so renderStage6() does not re-sync the bishop block in between
//   (c) the draw path — after (a), N canvas frames through the two published paths that are pure
//       draw (pointer move / leave on #stage6BishopCanvas) on a synced state and then on a state
//       whose layers / strength set changed underneath. In PR 18b commit 1 (the pure move) this is
//       a parity check: base and working tree must behave identically frame for frame, and the
//       report line prints whether drawing mutated the block at all — which is PLAN §4 defect 3
//       measured. Commit 2 (the draw stops syncing) turns it into "the working tree's block is
//       byte-identical after every frame". Either way the renderStage6() that follows must converge
//       both controllers to the same state (the same model from the same inputs, whoever synced).
//   (d) working tree only: the package standalone — syncSoilModel on a copy of the pre-step state
//       of every (a) step with the ids the controller consumed, applied with applySoilModelPatch
//       (+ invalidateBishop when it says so), equals the controller's post-step block; the input
//       is never mutated; the sync converges (a second run patches at most `walls`, a third patches
//       nothing — see sync-soil-model.js "Convergence"); soilModelFromState never touches the block
//       it is handed; every (b) transition replayed on a copy of its pre-step state (with the
//       field the *handler* itself stored applied first) equals the controller's post-step block
//       and reports the workers to stop / the analyses to rerun; materialsSource /
//       materialsInvalidation decisions; previewState, applySoilModelPatch, mirrorHsParams unit
//       checks; the index re-exports the engine builders
//   (e) working tree only: tests/golden/node/bishop/<id>.model.json recomputed with the package's
//       buildBishopModel on the fixture models, and cpt.<fx>.{model,materials}.json with
//       soilModelFromState on the pre-sync state (the package's defaults() + ensure() + the suite's
//       terrain) and on the synced state — byte-identical to the files on disk
//
// Usage
//   node scripts/verify_seepslope_model.mjs                 compare against integration-r
//   node scripts/verify_seepslope_model.mjs --base <ref>    compare against another git ref
//   node scripts/verify_seepslope_model.mjs --snapshot f.json   dump the working tree only
//   node scripts/verify_seepslope_model.mjs --against f.json    compare the working tree with a dump
//
// The base controller is materialised as src/lib/cpt-app/__verify-seepslope-model-base.legacy-controller.js
// (its sibling imports — stage6/, seepslope/state/, the packages — are unchanged by this PR, so the
// base runs against the working tree's copies) and deleted again, whatever happens.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-seepslope-model-base.legacy-controller.js';
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
const WALK_FIXTURE = 'layered';
const DRAW_FRAMES = 24;
// The bishop golden suite's section (scripts/golden/suites/bishop.mjs), verbatim.
const CPT_TERRAIN = { terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], entryZone: { xStart: 1, xEnd: 5 }, exitZone: { xStart: 13, xEnd: 19 } };

/** The two synthetic legacy bishop blocks of verify_seepslope_state.mjs (v1 / v2 era shapes). */
const LEGACY_BISHOP_V1 = {
  schemaVersion: 1,
  bottomMargin: 7,
  analysisDepth: '',
  workspace: 'bogus', methodMode: 'bogus', strengthSet: 'bogus', analysisTab: 'bogus',
  useFemPorePressure: 'yes',
  measurement: { points: [{ x: 1, y: 2 }, { x: '3', y: 4 }, { x: 5, y: 6 }, { x: 'nan', y: 1 }] },
  lineProbe: { sampleCount: 5, seepageQuantity: 'x', deformationQuantity: 'y', copyMessage: 7, copyTone: 'warn' },
  cptInsertionOffset: 500, snapSize: 0.001, pointSnap: 1,
  display: { showRegions: 0, regionOpacity: 2 },
  search: { nEntry: 1, nExit: '3', nCenter: 0, centerOffsetMin: 2, centerOffsetMax: 1, maxExitAngleDeg: 100, keepBest: 3, geomTol: 0 },
  solver: { initialFS: 0, maxIterations: 1 },
  spencer: { recheckCount: 8, FfTolerance: 0.01, FfBracketLow: 0.2, FfBracketHigh: 0.25, lambdaLow: 0.5, lambdaHigh: 0.5, initialF: -1, useNewton: 1 },
  terrain: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 1 }],
  phreatic: 'none', draft: null, materials: null,
  walls: [{ x: 4, yTop: 0, yTip: -3 }, { x: 12, yTop: 0, yTip: -2, passiveSide: 'left', maxShearForce: 50 }],
  drains: [{ id: 'd1', vertices: [{ x: 1, y: -1 }, { x: 2, y: -1 }] }, { vertices: [{ x: 1, y: -1 }] }],
  selectedDrainId: 42,
  customRegions: [{ polygon: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: -2 }], materialId: 'nope' }],
  surfaceLoad: { xStart: 2, xEnd: 6, q: '12' },
  selectedSurfaceLoadId: 'load-9',
  seepage: { status: 'weird', bcs: 'none', progress: { running: 1, percent: 250, runId: '3.6' }, rejectReason: 5, drainValidation: { errors: 'x' }, geometryHash: 12,
    options: { meshTargetArea: 0.5, freeSurface: 'x', usePhreaticAsSeed: 0, flowErrorTolerance: 0, maxRuntimeMs: -1, drains: 'none' },
    display: { contourMode: 'bogus', showBoundaryLabels: 0, showHead: 1 }, lastAppliedBcType: 'x', lastAppliedBcHead: '4', selectedEdgeKey: 9, selectedBcId: 3 },
  deformation: { status: 'bogus', progress: { percent: -5 }, rejectReason: 0, warnings: 'x',
    options: { analysisType: 'bogus', meshElementType: 'T6', constitutiveModel: 'hardening-soil', initialStressMode: 'predictor', loadMode: 'x', totalLoad: -3, outOfPlaneLength: 0,
      residualRelTol: 1e-3, residualAbsTol: 1e-2, minLoadStep: 1 / 2048, maxLoadSteps: 256, plasticLoadStepGrowthFactor: 1.05, plasticLineSearchMaxBacktracks: 4,
      initialLoadStep: 1e-9, geostaticInitializationMethod: 'direct-k0', initialGravityTangentSchedule: 'plastic, elastic', useStagedGeostaticInit: false,
      schwarzOverlap: 2, schwarzMinFreeDofs: 10, allowSchwarzPreconditioner: true, useAdmissibleSlopeSeed: true, unsymmetricLinearSolver: 'x', preconditionerLevel: 'schwarz',
      useGpuAcceleration: true, useResidentCg: true, gpuMinDof: 100, linearAlgebraBackend: 'gpu', useWasmCpuPipeline: false,
      meshTargetArea: 0.9, safetyFinalizationMode: 'weird', safetySigmaMsfMax: 0.5, useUnsymmetricPlasticSolver: false, wasmRobustNonlinearMode: true },
    display: { contourMode: 'syy', showLoadVectors: 0, showWallMomentOverlay: 'yes', wallOverlayQuantity: 'Q' } },
  viewport: 'none'
};
const LEGACY_BISHOP_V2 = {
  schemaVersion: 2,
  analysisDepth: 3,
  terrain: [{ x: 0, y: 2 }, { x: 30, y: 2 }],
  activeCptX: 12,
  spencer: { momentTolerance: 0.5, FfTolerance: 0.01, FBracketLow: 3, FBracketHigh: 2 },
  surfaceLoads: [{ id: 'load-1', xStart: 3, xEnd: 3 }, { id: 'load-1', label: 'Load 7', xStart: 8, xEnd: 4, q: 5 }, { xStart: 1, xEnd: 2 }],
  selectedSurfaceLoadId: 'load-1',
  seepage: { options: { meshTargetArea: 0.7, meshTargetAreaAuto: false, drains: { gatingTolerances: null } }, display: { contourMode: 'porePressure' } },
  deformation: { status: 'post',
    options: { analysisType: 'safety-cphi', constitutiveModel: 'linear-elastic', geostaticInitializationMethod: 'gravity-ramp', solverBackend: 'gpu', hsConsistentTangentMigrationResolved: false,
      meshTargetArea: null, meshTargetAreaAuto: false, loadMode: 'total', totalLoad: 200, safetyFinalizationMode: 'legacy-bracket' },
    display: { contourMode: 'mc', wallOverlayQuantity: 'V' } },
  lineProbe: { deformationQuantity: 'safetyEquivalentPlasticIncrement' }
};

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// ─────────────────────────────── child: dump one controller ───────────────────────────────
if (args[0] === '--dump') {
  const ctrlRel = args[1];
  const outPath = args[2];
  const pure = args.includes('--pure');
  const { installDomStub } = await import('./golden/lib/load-controller.mjs');
  const { mulberry32 } = await import('./golden/lib/prng.mjs');
  const { createServer } = await import('vite');
  const stub = installDomStub();
  const canvasEl = stub.document.getElementById('stage6BishopCanvas');
  canvasEl.setPointerCapture = () => {}; canvasEl.releasePointerCapture = () => {};
  canvasEl.parentElement = canvasEl.parentNode = stub.document.createElement('div');
  const server = await createServer({
    root: ROOT,
    configFile: false,
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: { alias: { $lib: resolve(ROOT, 'src/lib') } },
    define: { __APP_VERSION__: JSON.stringify(globalThis.__APP_VERSION__) }
  });
  const mod = await server.ssrLoadModule('/' + ctrlRel);
  mod.initLegacyController();
  const api = globalThis;
  const modelParams = await server.ssrLoadModule('/src/lib/cpt-app/model-params/index.js');
  const FIX = resolve(ROOT, 'tests/golden/fixtures');
  const manifest = JSON.parse(readFileSync(join(FIX, 'manifest.json'), 'utf8'));
  const realNow = Date.now.bind(Date);
  const realRandom = Math.random;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, label, timeout = 15000) {
    const t0 = realNow();
    while (!pred()) { if (realNow() - t0 > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(5); }
  }
  const S = () => api.PROJECT.cpts[api.PROJECT.activeCptIdx];
  const B = () => S().stage6.bishop;
  const layersOf = () => modelParams.workingLayers(S());
  function resetProject() {
    const P = api.PROJECT;
    P.cpts.splice(0, P.cpts.length, api.newCptState('CPT-1'));
    P.activeCptIdx = 0; P.sectionOrder = [0]; P.name = 'CPT Project'; P.phase = 'analysis'; P.stratigraphy = null;
    api.selectCpt(0);
  }
  function fixtureEntry(name) {
    for (const key of [`cpt/${name}`, `cpt/${name}.gef`, `cpt/${name}.state.json`]) if (manifest.fixtures[key]) return { key, ...manifest.fixtures[key] };
    throw new Error(`unknown CPT fixture ${name}`);
  }
  async function importCpt(name) {
    const entry = fixtureEntry(name);
    const fileRel = entry.base ? `cpt/${entry.base}` : entry.key;
    const fname = fileRel.slice(fileRel.lastIndexOf('/') + 1);
    const file = new File([readFileSync(join(FIX, fileRel))], fname);
    stub.alerts.length = 0;
    const before = stub.alerts.length;
    api.loadGEF({ target: { files: [file], value: '' } });
    await waitFor(() => (S().meta?.fname === fname && S().data.length > 0) || stub.alerts.length > before, `import of ${fname}`);
    if (entry.inject) Object.assign(S(), entry.inject);
  }
  async function classify(name) {
    resetProject();
    await importCpt(name);
    S().method = 'sb260';
    api.runClass();
    api.goS(3); api.goS(5);
  }
  // JSON with undefined / NaN / ±Infinity made visible, key order preserved (no sorting).
  const ser = (v) => JSON.stringify(v, (k, x) => (x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const dump = { controller: ctrlRel, sync: [], invalidate: [], draw: [], pure: {} };

  // seeded clock + PRNG for the whole walk (region ids are allocated by the sync)
  const idEvents = [];
  let clockT = 1700000000000;
  const rng = mulberry32(0x5eed5eed);
  const seedIds = () => { Date.now = () => { clockT += 1000; idEvents.push(['now', clockT]); return clockT; }; Math.random = () => { const v = rng(); idEvents.push(['random', v]); return v; }; };
  const unseedIds = () => { Date.now = realNow; Math.random = realRandom; };

  const replaySnapshots = {};   // label → { pre, layers, eventIndex } for (d)
  /** One observation of the bishop block after `fn`; `sync: true` marks a sync-only step to replay in (d). */
  function observe(list, label, fn, { replay = false, model = false } = {}) {
    stub.rafErrors.length = 0; stub.alerts.length = 0;
    if (replay) { api.ensureStage6State(); replaySnapshots[label] = { pre: clone(B()), layers: clone(layersOf()), eventIndex: idEvents.length }; }
    let error = null;
    try { fn(); } catch (e) { error = String(e?.stack || e).split('\n').slice(0, 3).join(' | '); }
    const obs = {
      label, error,
      bishop: ser(B()),
      message: B().progress?.message ?? null,
      seepageReason: B().seepage?.rejectReason ?? null,
      deformationReason: B().deformation?.rejectReason ?? null,
      deformationMessage: B().deformation?.progress?.message ?? null,
      app: S().stage6.app,
      cacheKeys: Object.keys(S().stage6Cache || {}).sort(),
      rafErrors: stub.rafErrors.map((e) => e.split('\n')[0]),
      alerts: stub.alerts.slice(),
      idEvents: idEvents.length
    };
    if (model) obs.model = ser(S().stage6Cache?.bishopModel ?? null);
    if (replay) replaySnapshots[label].post = obs.bishop;
    list.push(obs);
    return obs;
  }
  const syncOnly = () => api.stage6BishopSetDrainField(99, 'label', 'x');   // ensure + stage6BishopSyncSoilModel, unknown drain → return before the render
  const layerEdit = (i, f, value) => api.editL({ dataset: { i: String(i), f }, value: String(value), classList: { add() {} } });
  const withTerrain = () => { Object.assign(B(), clone(CPT_TERRAIN)); };

  seedIds();
  // ── (a) the sync on the demo
  {
    resetProject();
    const seeded = mulberry32(manifest.seed);
    Math.random = () => { const v = seeded(); idEvents.push(['random', v]); return v; };
    api.loadDemo();
    seedIds();
    S().method = 'sb260'; api.runClass(); api.goS(3); api.goS(5);
    withTerrain();
    observe(dump.sync, 'demo: first sync (sync only)', syncOnly, { replay: true });
    observe(dump.sync, 'demo: sync again', syncOnly, { replay: true });
    observe(dump.sync, 'demo: sync a third time', syncOnly, { replay: true });
    observe(dump.sync, "demo: setStage6App('bishop') → render", () => api.setStage6App('bishop'), { model: true });
    observe(dump.sync, 'demo: sync after the render', syncOnly, { replay: true });
  }
  // ── (a) the project fixtures
  for (const name of PROJECT_FIXTURES) {
    resetProject();
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, `projects/${name}.madep.json`))], `${name}.madep.json`));
    for (let i = 0; i < api.PROJECT.cpts.length; i += 1) {
      api.selectCpt(i);
      observe(dump.sync, `${name}[${i}] ${S().id}: sync`, syncOnly, { replay: true });
      observe(dump.sync, `${name}[${i}] ${S().id}: sync again`, syncOnly, { replay: true });
      observe(dump.sync, `${name}[${i}] ${S().id}: sync a third time`, syncOnly, { replay: true });
      observe(dump.sync, `${name}[${i}] ${S().id}: render → current model`, () => api.renderStage6(), { model: true });
      observe(dump.sync, `${name}[${i}] ${S().id}: sync after the render`, syncOnly, { replay: true });
    }
  }
  // ── (a) the legacy blocks, fresh and layered
  const legacyStates = [['legacyV1', LEGACY_BISHOP_V1], ['legacyV2', LEGACY_BISHOP_V2]];
  resetProject();
  for (const [label, block] of legacyStates) {
    S().stage6 = { app: 'bishop', bishop: clone(block) };
    observe(dump.sync, `${label} fresh: sync`, syncOnly, { replay: true });
    observe(dump.sync, `${label} fresh: sync again`, syncOnly, { replay: true });
    observe(dump.sync, `${label} fresh: sync a third time`, syncOnly, { replay: true });
    observe(dump.sync, `${label} fresh: render`, () => api.renderStage6(), { model: true });
  }
  await classify(WALK_FIXTURE);
  for (const [label, block] of legacyStates) {
    S().stage6 = { app: 'bishop', bishop: clone(block) };
    observe(dump.sync, `${label} layered: sync`, syncOnly, { replay: true });
    observe(dump.sync, `${label} layered: sync again`, syncOnly, { replay: true });
    observe(dump.sync, `${label} layered: sync a third time`, syncOnly, { replay: true });
    observe(dump.sync, `${label} layered: render`, () => api.renderStage6(), { model: true });
    observe(dump.sync, `${label} layered: sync after the render`, syncOnly, { replay: true });
  }
  // ── (a) the walk on layered: every branch of the sync
  await classify(WALK_FIXTURE);
  withTerrain();
  const fakeResults = () => { const b = B(); b.results = { allResults: [], summary: null, wallSummary: null }; b.stale = false; b.selectedResult = 0; b.progress.message = 'Bishop search finished.'; };
  observe(dump.sync, 'walk: first import (sync only)', syncOnly, { replay: true });
  observe(dump.sync, 'walk: app entry (render)', () => api.setStage6App('bishop'), { model: true });
  // 'B' is the default (S.stiffMethod), so 'A' is the toggle that actually moves E50_ref / Eoed_ref.
  observe(dump.sync, "walk: setStiffMethod('A') (Stage 4 → HS mirror, no signature change)", () => api.setStiffMethod('A'));
  observe(dump.sync, 'walk: sync after the stiffness toggle (materials patched, no invalidation)', syncOnly, { replay: true });
  observe(dump.sync, 'walk: render after the stiffness toggle', () => api.renderStage6(), { model: true });
  observe(dump.sync, "walk: editL layer 0 'c' += 3 (Stage 3 → signature)", () => { fakeResults(); layerEdit(0, 'c', (Number(S().layers[0].c) || 0) + 3); });
  observe(dump.sync, 'walk: sync after the layer edit (re-import + "Active CPT layers changed")', syncOnly, { replay: true });
  observe(dump.sync, 'walk: render after the layer edit', () => api.renderStage6(), { model: true });
  observe(dump.sync, "walk: strengthSet = 'da1_2' written directly", () => { fakeResults(); B().strengthSet = 'da1_2'; });
  observe(dump.sync, 'walk: sync after the strength set change ("Material strength set changed")', syncOnly, { replay: true });
  observe(dump.sync, "walk: SetField('strengthSet', 'characteristic') (handler)", () => { fakeResults(); api.stage6BishopSetField('strengthSet', 'characteristic'); }, { model: true });
  observe(dump.sync, 'walk: sync after the handler', syncOnly, { replay: true });
  observe(dump.sync, 'walk: legacy material.hs (no useConsistentTangent, reserved + stiffness keys, rShear NaN)', () => {
    const m = B().materials[0];
    m.hs = { p_ref: -5, Rf: 'x', reserved: 7, E50_ref: 1, Eoed_ref: 1, Eur_ref: 1, m: 1, nu_ur: 1, K0_nc: 1, OCR: 0 };
    m.rShear = 'nope';
    B().deformation.options.hsConsistentTangentMigrationResolved = false;
    B().deformation.options.hsConsistentTangentPromptPending = false;
  });
  observe(dump.sync, 'walk: sync (HS prompt raised, legacy keys stripped)', syncOnly, { replay: true });
  observe(dump.sync, 'walk: legacy hs with useConsistentTangent 0.7 and the prompt resolved', () => {
    B().materials[1].hs = { ...B().materials[1].hs, useConsistentTangent: 0.7 };
    delete B().materials[2].hs.useConsistentTangent;
    B().deformation.options.hsConsistentTangentMigrationResolved = true;
    B().deformation.options.hsConsistentTangentPromptPending = false;
  });
  observe(dump.sync, 'walk: sync (tangent flag coerced, no prompt)', syncOnly, { replay: true });
  observe(dump.sync, 'walk: a custom region without an id, one with an unknown material, one degenerate', () => {
    B().customRegions = [
      { polygon: [{ x: 2, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 1 }, { x: 2, y: 1 }], materialId: B().materials[0].id },
      { id: 'region_keep', polygon: [{ x: 10, y: 2.5 }, { x: 14, y: 2 }, { x: 14, y: 0 }, { x: 10, y: 0 }], materialId: 'nope', coarseness: 'x' },
      { id: 'region_flat', polygon: [{ x: 1, y: 1 }, { x: 2, y: 1 }], materialId: B().materials[0].id }
    ];
    B().useCustomRegions = true;
    B().selectedRegionId = 'gone';
    B().regionDraftMaterialId = 'gone';
  });
  observe(dump.sync, 'walk: sync (region_ id allocated, unknown material → first, degenerate dropped, selections pruned)', syncOnly, { replay: true });
  observe(dump.sync, 'walk: render with the custom regions', () => api.renderStage6(), { model: true });
  observe(dump.sync, 'walk: unsorted terrain, CPT / zones / loads out of range, a legacy wall, a one-vertex drain, dangling selections', () => {
    const b = B();
    b.terrain = [{ x: 20, y: 0 }, { x: 0, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 4 }, { x: 'x', y: 1 }];
    b.activeCptX = 55;
    b.entryZone = { xStart: 7, xEnd: -3 };
    b.exitZone = { xStart: 25, xEnd: 13 };
    b.surfaceLoads = [{ id: 'load-1', xStart: 30, xEnd: 18, q: '7' }, { id: 'load-2', xStart: 3, xEnd: 3 }, { xStart: -4, xEnd: 2, active: false }];
    b.selectedSurfaceLoadId = 'load-2';
    b.walls = [{ x: 4, yTop: 3.9, yTip: -1 }, { head: { x: 30, y: 2 }, tip: { x: 30, y: 2.01 } }];
    b.selectedWallId = 12345;
    b.drains = [{ id: 'd1', vertices: [{ x: 1, y: 1 }, { x: 4, y: 1 }] }, { vertices: [{ x: 1, y: -1 }] }];
    b.selectedDrainId = 'gone';
    b.tool = 'regionSplit'; b.draft = [{ x: 1, y: 1 }]; b.draftKind = 'regionSplit';
    b.selectedRegionId = 'gone';
  });
  observe(dump.sync, 'walk: sync (geometry normalised, selections pruned, split tool → edit)', syncOnly, { replay: true });
  observe(dump.sync, 'walk: render after the geometry normalisation', () => api.renderStage6(), { model: true });
  observe(dump.sync, 'walk: useCustomRegions without polygons, customRegions not an array, activeCptX NaN, no drains', () => {
    const b = B();
    b.customRegions = 'none'; b.useCustomRegions = 1; b.activeCptX = 'x'; b.drains = []; b.selectedDrainId = 'd1'; b.tool = 'regionHole';
  });
  observe(dump.sync, 'walk: sync (custom set disabled, CPT centred, drain selection cleared, hole tool → edit)', syncOnly, { replay: true });
  observe(dump.sync, 'walk: one terrain point (no geometry normalisation)', () => { B().terrain = [{ x: 0, y: 4 }]; B().activeCptX = 99; });
  observe(dump.sync, 'walk: sync without terrain', syncOnly, { replay: true });
  observe(dump.sync, 'walk: render without terrain (model null)', () => api.renderStage6(), { model: true });
  observe(dump.sync, 'walk: terrain restored', () => { withTerrain(); });
  observe(dump.sync, 'walk: sync (terrain back)', syncOnly, { replay: true });
  observe(dump.sync, 'walk: final render', () => api.renderStage6(), { model: true });
  dump.syncIdEvents = idEvents.length;

  // ── (b) the invalidation transitions, the shell on the bearing app (renderStage6 does not sync the bishop block)
  const invalidateSnapshots = [];
  function seedResults({ results = true, seepageMesh = true, seepageResult = true, seepageStatus = 'success', deformationMesh = true, deformationResult = true, deformationStatus = 'success' } = {}) {
    const b = B();
    b.results = results ? { allResults: [], summary: null, wallSummary: null } : null;
    b.selectedResult = 2; b.stale = false; b.progress.message = 'Bishop search finished.'; b.progress.running = true; b.progress.previewCircle = { x: 1 };
    b.seepage.mesh = seepageMesh ? { nodes: [1] } : null; b.seepage.result = seepageResult ? { heads: [1] } : null; b.seepage.status = seepageStatus; b.seepage.stale = false;
    b.seepage.rejectReason = 'previous reason'; b.seepage.progress.running = true; b.seepage.progress.percent = 40;
    b.deformation.mesh = deformationMesh ? { nodes: [1] } : null; b.deformation.result = deformationResult ? { u: [1] } : null; b.deformation.status = deformationStatus; b.deformation.stale = false;
    b.deformation.warnings = ['w']; b.deformation.rejectReason = 'previous reason'; b.deformation.progress.running = true; b.deformation.progress.percent = 60; b.deformation.progress.message = 'Deformation screen ready.';
  }
  /**
   * One invalidation step. `replay` is [packageFn, argument, handlerPaths]: the pure transition to
   * replay in (d) and the dotted paths the *handler* writes itself before invalidating (the field
   * the setter stores). The replay applies those first — otherwise it would be asked to reproduce
   * a write that is not the invalidator's.
   */
  function transition(label, seed, fn, replay) {
    seedResults(seed);
    api.ensureStage6State();
    const snap = { label, pre: clone(B()), replay };
    const obs = observe(dump.invalidate, label, fn);
    snap.post = obs.bishop;
    snap.handlerWrites = {};
    for (const path of (replay && replay[2]) || []) {
      let node = B();
      const parts = path.split('.');
      for (let i = 0; i < parts.length - 1; i += 1) node = node?.[parts[i]];
      snap.handlerWrites[path] = clone(node?.[parts[parts.length - 1]] ?? null);
    }
    invalidateSnapshots.push(snap);
  }
  S().stage6.app = 'bearing';
  observe(dump.invalidate, "shell on 'bearing' (render)", () => api.renderStage6());
  for (const status of ['success', 'meshing', 'solving', 'failed', 'idle']) {
    for (const [seepageMesh, seepageResult] of [[true, true], [true, false], [false, false]]) {
      const seed = { seepageStatus: status, seepageMesh, seepageResult };
      transition(`seepage ${status} mesh=${seepageMesh} result=${seepageResult}: SetField('seepage.options.maxRuntimeMs') → InvalidateSeepage(msg, true, true)`, seed,
        () => api.stage6BishopSetField('seepage.options.maxRuntimeMs', 5000 + idEvents.length), ['invalidateSeepage', { message: 'Seepage settings changed. Showing the previous result until you rerun.', keepMesh: true, preserveSolvedState: true }, ['seepage.options.maxRuntimeMs']]);
      transition(`seepage ${status} mesh=${seepageMesh} result=${seepageResult}: Clear('seepageResults') → InvalidateSeepage(msg, false)`, seed,
        () => api.stage6BishopClear('seepageResults'), ['invalidateSeepage', { message: 'Seepage result cleared.', keepMesh: false, preserveSolvedState: undefined }]);
    }
  }
  for (const status of ['success', 'meshing', 'solving', 'post', 'failed', 'idle']) {
    for (const [deformationMesh, deformationResult] of [[true, true], [true, false], [false, false]]) {
      const seed = { deformationStatus: status, deformationMesh, deformationResult };
      transition(`deformation ${status} mesh=${deformationMesh} result=${deformationResult}: SetField('deformation.options.maxLoadSteps') → InvalidateDeformation(msg, true, true)`, seed,
        () => api.stage6BishopSetField('deformation.options.maxLoadSteps', 100 + idEvents.length), ['invalidateDeformation', { message: 'Deformation settings changed. Showing the previous result until you rerun.', keepMesh: true, preserveSolvedState: true }, ['deformation.options.maxLoadSteps']]);
      transition(`deformation ${status} mesh=${deformationMesh} result=${deformationResult}: Clear('deformationResults') → InvalidateDeformation(msg, false)`, seed,
        () => api.stage6BishopClear('deformationResults'), ['invalidateDeformation', { message: 'Deformation result cleared.', keepMesh: false, preserveSolvedState: undefined }]);
      transition(`deformation ${status} mesh=${deformationMesh} result=${deformationResult}: SetField('useFemPorePressure', true) → Invalidate(msg)`, seed,
        () => { B().useFemPorePressure = false; api.stage6BishopSetField('useFemPorePressure', true); }, ['invalidateBishop', 'FEM pore pressure enabled; rerun Bishop search.', ['useFemPorePressure']]);
      transition(`deformation ${status} mesh=${deformationMesh} result=${deformationResult}: Clear('phreatic') → Invalidate()`, seed,
        () => api.stage6BishopClear('phreatic'), ['invalidateBishop', undefined]);
    }
  }
  transition("results=null: SetField('useFemPorePressure', false) → Invalidate(msg)", { results: false }, () => { B().useFemPorePressure = true; api.stage6BishopSetField('useFemPorePressure', false); }, ['invalidateBishop', 'Reverted to hydrostatic pore pressure; rerun Bishop search.', ['useFemPorePressure']]);
  transition("wall geometry: SetWallField(0, 'tip.y', '-2') → InvalidateWallGeometry(msg)", {}, () => {
    B().walls = [{ head: { x: 3, y: 4 }, tip: { x: 3, y: 0 } }];
    api.stage6BishopSetWallField(0, 'tip.y', '-2');
  }, null);
  transition('wall geometry on empty states', { results: false, seepageMesh: false, seepageResult: false, seepageStatus: 'idle', deformationMesh: false, deformationResult: false, deformationStatus: 'idle' }, () => {
    B().walls = [{ head: { x: 3, y: 4 }, tip: { x: 3, y: 0 } }];
    api.stage6BishopSetWallField(0, 'tip.y', '-3');
  }, null);
  observe(dump.invalidate, "shell back on 'bishop' (render)", () => { S().stage6.app = 'bishop'; api.renderStage6(); });

  // ── (c) the draw path: N frames on a synced state, then on a state changed underneath
  const vp = () => B().viewport;
  const screen = (x, y) => ({ clientX: x * vp().scale + vp().offsetX, clientY: vp().offsetY - y * vp().scale });
  const moveEvent = (x, y) => ({ currentTarget: canvasEl, target: canvasEl, ...screen(x, y), pointerId: 1, buttons: 0, preventDefault() {}, stopPropagation() {} });
  function drawFrames(label) {
    api.ensureStage6State();
    const before = ser(B());
    const cacheBefore = ser(S().stage6Cache?.bishopModel ?? null);
    const frames = [];
    let error = null;
    try {
      if (typeof canvasEl.onpointermove !== 'function') throw new Error('canvas handlers not bound (initStage6BishopCanvas did not run)');
      // Only the two published paths that are *pure* draw: hover (updateHoverDom → drawCanvas) and
      // leave (hideHoverDom → drawCanvas). fitStage6BishopViewport and the wheel handler are
      // deliberately excluded — they write bishop.viewport and go through stage6BishopCurrentModel,
      // i.e. they are input changes, not frames. stage6BishopDrawCanvas itself is not published.
      for (let i = 0; i < DRAW_FRAMES; i += 1) {
        const x = 1 + (i % 12) * 1.5, y = 4 - (i % 5);
        if (i % 6 === 5) canvasEl.onpointerleave(moveEvent(x, y));
        else canvasEl.onpointermove(moveEvent(x, y));
        frames.push(ser(B()) === before);
      }
    } catch (e) { error = String(e?.stack || e).split('\n').slice(0, 3).join(' | '); }
    dump.draw.push({ label, error, frames: DRAW_FRAMES, identicalFrames: frames.filter(Boolean).length, firstChangedFrame: frames.indexOf(false), before, after: ser(B()), message: B().progress?.message ?? null, cacheChanged: ser(S().stage6Cache?.bishopModel ?? null) !== cacheBefore, rafErrors: stub.rafErrors.map((e) => e.split('\n')[0]) });
  }
  observe(dump.sync, 'draw: render before the frames', () => api.renderStage6(), { model: true });
  api.fitStage6BishopViewport();
  drawFrames('synced state');
  observe(dump.sync, 'draw: render after the frames on the synced state', () => api.renderStage6(), { model: true });
  fakeResults();
  layerEdit(1, 'phi', (Number(S().layers[1].phi) || 0) + 2);
  drawFrames('layers changed underneath (signature)');
  observe(dump.sync, 'draw: render after the frames on the changed layers (both converge)', () => api.renderStage6(), { model: true });
  fakeResults();
  B().strengthSet = 'da1_1';
  drawFrames('strength set changed underneath');
  observe(dump.sync, 'draw: render after the frames on the changed strength set (both converge)', () => api.renderStage6(), { model: true });
  dump.idEvents = idEvents.length;
  unseedIds();

  // ── (d) + (e): working tree only — the package standalone
  if (pure) {
    const pkg = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/model/index.js');
    const statePkg = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/state/index.js');
    const replayIds = (fromIndex) => {
      let i = fromIndex;
      const take = (kind) => { while (i < idEvents.length && idEvents[i][0] !== kind) i += 1; if (i >= idEvents.length) throw new Error(`no ${kind} event after ${fromIndex}`); return idEvents[i++][1]; };
      return { now: () => take('now'), random: () => take('random') };
    };
    dump.pure.sync = {};
    for (const [label, snap] of Object.entries(replaySnapshots)) {
      const copy = clone(snap.pre);
      const inputBefore = ser(copy);
      let error = null, r = null, again = null, third = null, model = null;
      try {
        r = pkg.syncSoilModel(copy, snap.layers, { ids: replayIds(snap.eventIndex) });
        const inputAfter = ser(copy);
        pkg.applySoilModelPatch(copy, r.patch);
        if (r.invalidation) pkg.invalidateBishop(copy, r.invalidation.message);
        const replayed = ser(copy);                       // ← this is what the controller must equal
        again = pkg.syncSoilModel(copy, snap.layers, { ids: replayIds(snap.eventIndex) });
        pkg.applySoilModelPatch(copy, again.patch);
        if (again.invalidation) pkg.invalidateBishop(copy, again.invalidation.message);
        third = pkg.syncSoilModel(copy, snap.layers, { ids: replayIds(snap.eventIndex) });
        const beforeModel = ser(copy);
        model = pkg.soilModelFromState(copy, snap.layers);
        dump.pure.sync[label] = { error, inputUntouched: inputBefore === inputAfter, changed: r.changed, patchKeys: Object.keys(r.patch), invalidation: r.invalidation, reimported: r.reimported, replayed, controller: snap.post,
          layerCount: snap.layers.length,
          againChanged: again.changed, againPatchKeys: Object.keys(again.patch),
          thirdChanged: third.changed, thirdPatchKeys: Object.keys(third.patch), thirdInvalidated: !!third.invalidation,
          modelChanged: model.sync.changed, modelInputUntouched: ser(copy) === beforeModel };
      } catch (e) { dump.pure.sync[label] = { error: String(e?.stack || e).split('\n').slice(0, 3).join(' | ') }; }
    }
    dump.pure.invalidate = {};
    for (const snap of invalidateSnapshots) {
      if (!snap.replay) continue;
      const [fn, arg] = snap.replay;
      const copy = clone(snap.pre);
      let error = null, ret = null;
      try {
        pkg.applySoilModelPatch(copy, snap.handlerWrites || {});   // the field the setter stored
        ret = pkg[fn](copy, arg);
      } catch (e) { error = String(e?.stack || e).split('\n').slice(0, 2).join(' | '); }
      dump.pure.invalidate[snap.label] = { error, fn, ret, replayed: ser(copy), controller: snap.post };
    }
    // the wall-geometry transition: invalidateWallGeometry on the pre-step state after the wall edit the handler made
    {
      const snap = invalidateSnapshots.find((s) => s.label.startsWith("wall geometry: SetWallField"));
      const copy = clone(snap.pre);
      const post = JSON.parse(snap.post);
      copy.walls = post.walls; copy.selectedWallId = post.selectedWallId;
      const ret = pkg.invalidateWallGeometry(copy, 'Retaining wall geometry updated; rerun Bishop search.');
      dump.pure.wallGeometry = { ret, replayed: ser(copy), controller: snap.post };
    }
    // unit checks
    const u = {};
    const st = statePkg.defaults();
    Object.assign(st, clone(CPT_TERRAIN));
    const layers = clone(replaySnapshots['walk: first import (sync only)'].layers);
    u.sourceFresh = pkg.materialsSource(st, layers);
    const synced = pkg.previewState(st, pkg.syncSoilModel(st, layers).patch);
    u.sourceSynced = pkg.materialsSource(synced, layers);
    u.sourceStrength = pkg.materialsSource({ ...synced, strengthSet: 'da1_2' }, layers);
    u.sourceLayers = pkg.materialsSource(synced, [{ ...layers[0], c: 99 }, ...layers.slice(1)]);
    u.sourceEmpty = pkg.materialsSource({ ...synced, materials: [] }, layers);
    u.invalidationFresh = pkg.materialsInvalidation(u.sourceFresh);
    u.invalidationStrength = pkg.materialsInvalidation(u.sourceStrength);
    u.invalidationLayers = pkg.materialsInvalidation(u.sourceLayers);
    u.invalidationNone = pkg.materialsInvalidation(u.sourceSynced);
    u.messages = pkg.MATERIALS_INVALIDATION_MESSAGES;
    u.stUntouchedByPreview = ser(st.materials) === ser(statePkg.defaults().materials) && st.terrain.length === 3 && !('sourceLayerSignature' in st && st.sourceLayerSignature);
    u.syncedHasMaterials = synced.materials.length === layers.length && synced.sourceLayerSignature === u.sourceFresh.signature && synced.sourceStrengthSet === 'characteristic';
    const target = { a: 1, deformation: { options: { x: 1 } } };
    const targetRef = target.deformation;
    pkg.applySoilModelPatch(target, { a: 2, 'deformation.options.hsConsistentTangentPromptPending': true, b: [1] });
    u.applyInPlace = target.a === 2 && target.b.length === 1 && target.deformation === targetRef && target.deformation.options.hsConsistentTangentPromptPending === true && target.deformation.options.x === 1;
    const previewSrc = { a: 1, deformation: { options: { x: 1 } } };
    const preview = pkg.previewState(previewSrc, { a: 2, 'deformation.options.hsConsistentTangentPromptPending': true });
    u.previewCopies = preview.a === 2 && previewSrc.a === 1 && preview.deformation !== previewSrc.deformation && previewSrc.deformation.options.hsConsistentTangentPromptPending === undefined && preview.deformation.options.hsConsistentTangentPromptPending === true;
    const mirrored = pkg.mirrorHsParams({ id: 'm', Emc: 500, hs: { E50_ref: 1, reserved: 3, p_ref: 0 }, color: '#000' }, { E50_ref: 0, m: 2, nu_ur: -5, K0nc: 0.4, psi: 'x' });
    u.mirror = { keys: Object.keys(mirrored.material), hsKeys: Object.keys(mirrored.material.hs), legacy: mirrored.legacyTangentSchema, E50: mirrored.material.E50_ref, Eur: mirrored.material.Eur_ref, m: mirrored.material.m, nu_ur: mirrored.material.nu_ur, K0nc: mirrored.material.K0nc, psi: mirrored.material.psi, rShear: mirrored.material.rShear, nearSurface: mirrored.material.hs.nearSurfaceMinConfiningStress, p_ref: mirrored.material.hs.p_ref };
    u.patchKeys = pkg.SOIL_MODEL_PATCH_KEYS;
    u.hsPromptPath = pkg.HS_PROMPT_PATH;
    const engine = await server.ssrLoadModule('/src/lib/cpt-app/stage6-bishop.js');
    u.reexports = pkg.buildBishopModelFromStageLayers === engine.buildBishopModelFromStageLayers && pkg.importBishopMaterialsFromLayers === engine.importBishopMaterialsFromLayers && pkg.bishopLayerSignature === engine.bishopLayerSignature
      && typeof pkg.sync.syncSoilModel === 'function' && typeof pkg.invalidate.invalidateBishop === 'function' && typeof pkg.signature.materialsSource === 'function';
    u.stopStates = (() => {
      const b = { progress: { running: true, previewCircle: {} }, seepage: { progress: { running: true, percent: 5 }, status: 'meshing' }, deformation: { progress: { running: true, percent: 5 }, status: 'post' } };
      pkg.stopSearchState(b); pkg.stopSeepageState(b); pkg.stopDeformationState(b);
      return b.progress.running === false && b.progress.previewCircle === null && b.seepage.status === 'idle' && b.seepage.progress.percent === 0 && b.deformation.status === 'idle' && b.deformation.progress.running === false;
    })();
    dump.pure.unit = u;

    // (e) the bishop goldens with the pure builder
    const { normalize } = await import('./golden/lib/normalize.mjs');
    const { stableJson } = await import('./golden/lib/store.mjs');
    const stage6Pkg = await server.ssrLoadModule('/src/lib/cpt-app/stage6/index.js');
    dump.pure.goldens = {};
    for (const key of Object.keys(manifest.fixtures).filter((k) => /^models\/bishop-.*\.json$/.test(k)).sort()) {
      const fx = JSON.parse(readFileSync(join(FIX, key), 'utf8'));
      const id = key.replace(/^models\/bishop-/, '').replace(/\.json$/, '');
      dump.pure.goldens[`${id}.model.json`] = stableJson(normalize(pkg.buildBishopModel(fx.layers, fx.bishopState)));
    }
    const deformationQuantityIds = (analysisType = null, hasHs = false) => {
      const ids = ['uTotal', 'settlement', 'ux', 'uy', 'epsilonXx', 'epsilonYy', 'gammaXy', 'equivalentPlasticStrain', 'deltaSigmaYy', 'sigmaYyEffInit', 'sigmaYyEff', 'sigmaYyTotalInit', 'sigmaYyTotal', 'sigmaXxEffInit', 'sigmaXxEff', 'sigmaXxTotalInit', 'sigmaXxTotal', 'tauXy', 'mcEta'];
      if (analysisType === 'safety-cphi') ids.splice(8, 0, 'safetyEquivalentPlasticIncrement');
      if (hasHs === true) ids.push('hsGammaP', 'hsPP', 'hsEpsVPDilative', 'hsLastActiveSet');
      return ids;
    };
    const names = Object.entries(manifest.fixtures).filter(([k, e]) => k.startsWith('cpt/') && e.role === 'profile').map(([k]) => k.slice(4).replace(/\.(gef|state\.json)$/, '')).filter((n) => !['trailing-qc-only', 'wt-above-surface'].includes(n));
    dump.pure.goldenCpt = {};
    for (const fx of names) {
      await classify(fx);
      api.ensureStage6State();
      const cpt = S();
      const rawMaxDepth = cpt.layers.length ? cpt.layers[cpt.layers.length - 1].bot : 10;
      cpt.stage6.bishop = statePkg.defaults();
      stage6Pkg.merge(cpt.stage6, { bishop: statePkg.defaults() });
      statePkg.ensure(cpt.stage6, { rawMaxDepth, maxDepth: Math.max(rawMaxDepth, 0.5), hardeningSoilUi: false, deformationQuantityIds });
      Object.assign(cpt.stage6.bishop, clone(CPT_TERRAIN));
      const pre = clone(cpt.stage6.bishop);
      const layersFx = clone(layersOf());
      api.setStage6App('bishop');
      const post = clone(B());
      const fromPre = pkg.soilModelFromState(pre, layersFx);
      const fromPost = pkg.soilModelFromState(post, layersFx);
      const preModel = fromPre.model ? { ...fromPre.model, seepage: post.seepage, deformation: post.deformation } : fromPre.model;
      dump.pure.goldenCpt[fx] = {
        preChanged: fromPre.sync.changed, postChanged: fromPost.sync.changed,
        [`cpt.${fx}.model.json`]: stableJson(normalize(fromPost.model)),
        [`cpt.${fx}.model.json (pre)`]: stableJson(normalize(preModel)),
        [`cpt.${fx}.materials.json`]: stableJson(normalize(fromPre.state.materials)),
        cache: stableJson(normalize(S().stage6Cache.bishopModel))
      };
    }
  }

  writeFileSync(outPath, JSON.stringify(dump));
  await server.close();
  process.exit(0);
}

// ─────────────────────────────── parent: run + compare ───────────────────────────────
function runDump(ctrlRel, outPath, extra = []) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--dump', ctrlRel, outPath, ...extra], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`dump of ${ctrlRel} failed (exit ${r.status})`);
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function firstTextDiff(a, b) {
  if (a === b) return null;
  a = String(a ?? ''); b = String(b ?? '');
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `at char ${i}: …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`;
}
function firstDiff(aJson, bJson) {
  if (aJson === bJson) return null;
  let a, b;
  try { a = JSON.parse(aJson); b = JSON.parse(bJson); } catch { return firstTextDiff(String(aJson), String(bJson)); }
  const walk = (x, y, path) => {
    if (x === y) return null;
    if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object') return `${path || '<root>'}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`;
    const kx = Object.keys(x), ky = Object.keys(y);
    if (kx.join(' ') !== ky.join(' ')) {
      const missing = kx.filter((k) => !ky.includes(k)), extra = ky.filter((k) => !kx.includes(k));
      if (missing.length || extra.length) return `${path || '<root>'}: keys missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`;
      return `${path || '<root>'}: key order ${JSON.stringify(kx)} → ${JSON.stringify(ky)}`;
    }
    for (const k of kx) { const d = walk(x[k], y[k], path ? `${path}.${k}` : k); if (d) return d; }
    return null;
  };
  return walk(a, b, '') || 'texts differ (whitespace?)';
}
const errorMessage = (e) => (e ? String(e).split(' | ')[0] : null);

const tmp = mkdtempSync(join(tmpdir(), 'verify-seepslope-model-'));
const materialised = [];
let oldDump, newDump;
try {
  const against = opt('--against');
  const snapshot = opt('--snapshot');
  console.log('working tree controller …');
  newDump = runDump(CTRL_REL, join(tmp, 'new.json'), ['--pure']);
  if (snapshot) { writeFileSync(snapshot, JSON.stringify(newDump)); console.log(`snapshot written: ${snapshot}`); process.exit(0); }
  if (against) {
    oldDump = JSON.parse(readFileSync(against, 'utf8'));
  } else {
    const base = opt('--base') || 'integration-r';
    let text;
    try { text = execFileSync('git', ['show', `${base}:${CTRL_REL}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch (e) { console.error(`cannot read ${CTRL_REL} at ${base} (${e.message.split('\n')[0]}); pass --base <ref> or --against <dump.json>`); process.exit(2); }
    const basePath = resolve(ROOT, BASE_REL);
    writeFileSync(basePath, text); materialised.push(basePath);
    console.log(`base controller (${base}) …`);
    oldDump = runDump(BASE_REL, join(tmp, 'old.json'));
  }
} finally {
  for (const p of materialised) if (existsSync(p)) rmSync(p);
  rmSync(tmp, { recursive: true, force: true });
}

function compareSteps(title, oldList, newList) {
  console.log(`\n${title} — ${oldList.length} steps`);
  check(`same step list (${oldList.length})`, JSON.stringify(oldList.map((d) => d.label)) === JSON.stringify(newList.map((d) => d.label)));
  oldList.forEach((o, i) => {
    const n = newList[i] || {};
    const p = `step ${String(i + 1).padStart(3, '0')} ${o.label}`;
    check(`${p}: exception identical (${errorMessage(o.error) || 'none'})`, errorMessage(o.error) === errorMessage(n.error), `${errorMessage(o.error)} → ${errorMessage(n.error)}`);
    check(`${p}: S.stage6.bishop deep-equal + key order`, o.bishop === n.bishop, firstDiff(o.bishop, n.bishop));
    check(`${p}: messages identical`, JSON.stringify([o.message, o.seepageReason, o.deformationReason, o.deformationMessage]) === JSON.stringify([n.message, n.seepageReason, n.deformationReason, n.deformationMessage]),
      `${JSON.stringify([o.message, o.seepageReason, o.deformationReason, o.deformationMessage])} → ${JSON.stringify([n.message, n.seepageReason, n.deformationReason, n.deformationMessage])}`);
    if ('model' in o) check(`${p}: cached model deep-equal + key order`, o.model === n.model, firstDiff(o.model, n.model));
    check(`${p}: app / cache keys / rAF errors / alerts / id events identical`, JSON.stringify([o.app, o.cacheKeys, o.rafErrors, o.alerts, o.idEvents]) === JSON.stringify([n.app, n.cacheKeys, n.rafErrors, n.alerts, n.idEvents]),
      `${JSON.stringify([o.app, o.cacheKeys, o.rafErrors, o.alerts, o.idEvents])} → ${JSON.stringify([n.app, n.cacheKeys, n.rafErrors, n.alerts, n.idEvents])}`);
  });
}

compareSteps('(a) the soil-model sync', oldDump.sync, newDump.sync);
check('(a) same number of Date.now() / Math.random() calls over the sync walk', oldDump.syncIdEvents === newDump.syncIdEvents, `${oldDump.syncIdEvents} → ${newDump.syncIdEvents}`);
{
  // the walk really reached the branches it names (in the new tree)
  const at = (label) => newDump.sync.find((o) => o.label.startsWith(label));
  const parse = (o) => JSON.parse(o.bishop.replace(/"<undefined>"/g, 'null'));
  const first = parse(at('walk: first import'));
  check('walk: the first sync imported one material per layer with the signature remembered and no invalidation message', first.materials.length > 0 && !!first.sourceLayerSignature && first.sourceStrengthSet === 'characteristic' && first.progress.message !== 'Active CPT layers changed; Bishop results were cleared.', `${first.materials.length} materials, ${JSON.stringify(first.progress.message)}`);
  const stiff = parse(at('walk: sync after the stiffness toggle'));
  const preStiff = parse(at('walk: app entry'));
  check('walk: the stiffness toggle re-mirrored the HS fields without a re-import or invalidation', stiff.sourceLayerSignature === preStiff.sourceLayerSignature && JSON.stringify(stiff.materials.map((m) => m.E50_ref)) !== JSON.stringify(preStiff.materials.map((m) => m.E50_ref)) && stiff.progress.message === preStiff.progress.message,
    `${JSON.stringify(preStiff.materials.map((m) => m.E50_ref))} → ${JSON.stringify(stiff.materials.map((m) => m.E50_ref))}`);
  const edited = at('walk: sync after the layer edit');
  check('walk: the layer edit re-imported the materials, cleared the results and set the layers message', edited.message === 'Active CPT layers changed; Bishop results were cleared.' && parse(edited).results === null && parse(edited).stale === true && parse(edited).sourceLayerSignature !== stiff.sourceLayerSignature, edited.message);
  const strength = at('walk: sync after the strength set change');
  check('walk: the strength-set change re-imported with the strength message', strength.message === 'Material strength set changed; Bishop results were cleared.' && parse(strength).sourceStrengthSet === 'da1_2' && parse(strength).results === null, strength.message);
  const hs = parse(at('walk: sync (HS prompt raised'));
  check('walk: the legacy material.hs raised the HS prompt, stripped the legacy keys, filled rShear', hs.deformation.options.hsConsistentTangentPromptPending === true && hs.materials[0].hs.useConsistentTangent === false && !('reserved' in hs.materials[0].hs) && !('E50_ref' in hs.materials[0].hs) && hs.materials[0].hs.nearSurfaceMinConfiningStress === 7 && hs.materials[0].hs.p_ref === 1e-6 && Number.isFinite(hs.materials[0].rShear),
    JSON.stringify(hs.materials[0].hs));
  const hs2 = parse(at('walk: sync (tangent flag coerced'));
  check('walk: useConsistentTangent 0.7 → true, a missing flag → false without the prompt (resolved)', hs2.materials[1].hs.useConsistentTangent === true && hs2.materials[2].hs.useConsistentTangent === false && hs2.deformation.options.hsConsistentTangentPromptPending === false, JSON.stringify([hs2.materials[1].hs.useConsistentTangent, hs2.materials[2].hs.useConsistentTangent, hs2.deformation.options.hsConsistentTangentPromptPending]));
  const regions = parse(at('walk: sync (region_ id allocated'));
  check('walk: a region_ id was allocated, the unknown material fell back to the first, the degenerate polygon was dropped, the selections were pruned', regions.customRegions.length === 2 && /^region_[0-9a-z]+_[0-9a-z]{5}$/.test(regions.customRegions[0].id) && regions.customRegions[1].id === 'region_keep' && regions.customRegions[1].materialId === regions.materials[0].id && regions.selectedRegionId === regions.customRegions[0].id && regions.regionDraftMaterialId === regions.materials[0].id && regions.useCustomRegions === true,
    JSON.stringify(regions.customRegions.map((r) => [r.id, r.materialId, r.coarseness])));
  const geo = parse(at('walk: sync (geometry normalised'));
  // The split tool survives here: the pruning only falls back to 'edit' when no polygon is
  // selected, and the previous step left two custom regions, so selectedRegionId is refilled with
  // the first one. The tool → edit branch is reached by the next step ('custom set disabled').
  check('walk: terrain sorted + deduped, CPT / zones / loads clamped, the legacy wall normalised, the one-vertex drain dropped, selections pruned, split tool kept (a polygon is selected)',
    geo.terrain.length === 3 && geo.terrain[0].x === 0 && geo.activeCptX === 20 && geo.entryZone.xStart === 0 && geo.entryZone.xEnd === 7 && geo.exitZone.xEnd === 20 && geo.surfaceLoads.length === 2 && geo.surfaceLoads[0].xEnd === 20 && geo.surfaceLoads[1].xStart === 0 && geo.selectedSurfaceLoadId === null
      && geo.walls.length === 2 && geo.walls[0].id === 'wall-1' && geo.walls[0].head.x === 4 && geo.walls[1].tip.y === 1.95 && geo.selectedWallId === null && geo.drains.length === 1 && geo.selectedDrainId === 'd1' && geo.tool === 'regionSplit' && geo.selectedRegionId === geo.customRegions[0].id,
    JSON.stringify({ terrain: geo.terrain, cpt: geo.activeCptX, entry: geo.entryZone, exit: geo.exitZone, loads: geo.surfaceLoads.map((l) => [l.id, l.xStart, l.xEnd]), walls: geo.walls.map((w) => [w.id, w.head, w.tip]), drains: geo.drains.length, sel: [geo.selectedWallId, geo.selectedDrainId, geo.tool, geo.selectedRegionId] }));
  const none = parse(at('walk: sync (custom set disabled'));
  check('walk: customRegions not an array → [], useCustomRegions → false, CPT centred, drain selection cleared, hole tool → edit', Array.isArray(none.customRegions) && none.customRegions.length === 0 && none.useCustomRegions === false && none.activeCptX === 10 && none.selectedDrainId === '' && none.tool === 'edit', JSON.stringify([none.customRegions, none.useCustomRegions, none.activeCptX, none.selectedDrainId, none.tool]));
  const noTerrain = at('walk: render without terrain');
  check('walk: without two terrain points the model is null and activeCptX is left alone', noTerrain.model === 'null' && parse(noTerrain).activeCptX === 99, `${noTerrain.model} ${parse(noTerrain).activeCptX}`);
  // The sync converges, but not always on the second run — three drivers, all the monolith's own
  // (§(a) proves base and working tree agree step for step; report 22 §6):
  //   · state/walls.js normalizeWalls raises `mechanicalActivationPromptPending` on the first pass
  //     (the wall has no `mechanicalActive` yet) and clears it on the second, which now does;
  //   · ensure()'s auto mesh target area is recomputed from the terrain the first sync sorted;
  //   · a CPT with no layers has no materials, so `empty` keeps re-importing (and, once a signature
  //     is stored, re-firing "Active CPT layers changed") on every sync.
  // What must hold — and what the draw path of commit 2 relies on — is that a *third* consecutive
  // sync-only run changes nothing more, and that a sync right after a render is always a no-op.
  const thirds = newDump.sync.filter((o) => / sync a third time$/.test(o.label));
  const notConverged = thirds.filter((o) => newDump.sync[newDump.sync.indexOf(o) - 1].bishop !== o.bishop);
  check(`walk: a third consecutive sync-only run changes nothing (${thirds.length} triples)`, thirds.length >= 12 && notConverged.length === 0, notConverged.map((o) => `${o.label}: ${firstDiff(newDump.sync[newDump.sync.indexOf(o) - 1].bishop, o.bishop)}`).join('; '));
  const afterRender = newDump.sync.filter((o) => /sync after the render|sync after the handler/.test(o.label));
  const dirtyAfterRender = afterRender.filter((o) => { const idx = newDump.sync.indexOf(o); return newDump.sync[idx - 1].bishop !== o.bishop; });
  check(`walk: a sync right after a render is a no-op (${afterRender.length} steps)`, afterRender.length >= 10 && dirtyAfterRender.length === 0, dirtyAfterRender.map((o) => `${o.label}: ${firstDiff(newDump.sync[newDump.sync.indexOf(o) - 1].bishop, o.bishop)}`).join('; '));
  const seconds = newDump.sync.filter((o) => / sync again$/.test(o.label));
  const stable = seconds.filter((o) => newDump.sync[newDump.sync.indexOf(o) - 1].bishop === o.bishop);
  console.log(`       ${stable.length}/${seconds.length} second syncs were already a no-op; the rest converge on the third`);
}

compareSteps('(b) the invalidation transitions', oldDump.invalidate, newDump.invalidate);
{
  const parse = (o) => JSON.parse(o.bishop.replace(/"<undefined>"/g, 'null'));
  const kept = newDump.invalidate.find((o) => o.label.startsWith('seepage success mesh=true result=true: SetField'));
  check('transitions: a solved seepage state survives a settings change as stale', parse(kept).seepage.stale === true && parse(kept).seepage.status === 'success' && parse(kept).seepage.mesh !== null && parse(kept).seepage.result !== null && parse(kept).seepage.rejectReason === 'Seepage settings changed. Showing the previous result until you rerun.', JSON.stringify(parse(kept).seepage.status));
  const cleared = newDump.invalidate.find((o) => o.label.startsWith('seepage success mesh=true result=true: Clear'));
  check('transitions: Clear(seepageResults) discards mesh + result, status idle', parse(cleared).seepage.mesh === null && parse(cleared).seepage.result === null && parse(cleared).seepage.status === 'idle' && parse(cleared).seepage.stale === false && parse(cleared).seepage.rejectReason === 'Seepage result cleared.', JSON.stringify(parse(cleared).seepage.status));
  const noResult = newDump.invalidate.find((o) => o.label.startsWith('seepage solving mesh=true result=false: SetField'));
  check('transitions: without a result the mesh is kept (keepMesh) and a running status goes idle', parse(noResult).seepage.mesh !== null && parse(noResult).seepage.result === null && parse(noResult).seepage.status === 'idle' && parse(noResult).seepage.progress.running === false, JSON.stringify(parse(noResult).seepage));
  const bishop = newDump.invalidate.find((o) => o.label.startsWith('deformation post mesh=true result=true: SetField(\'useFemPorePressure\''));
  check('transitions: Invalidate(msg) clears the results, flags stale, discards the deformation screen with the reason in its status bar', parse(bishop).results === null && parse(bishop).stale === true && parse(bishop).selectedResult === 0 && parse(bishop).deformation.mesh === null && parse(bishop).deformation.result === null && parse(bishop).deformation.status === 'idle' && parse(bishop).deformation.progress.message === 'FEM pore pressure enabled; rerun Bishop search.' && bishop.message === 'FEM pore pressure enabled; rerun Bishop search.' && parse(bishop).progress.previewCircle === null,
    JSON.stringify([bishop.message, parse(bishop).deformation.progress.message]));
  const noMsg = newDump.invalidate.find((o) => o.label.startsWith("deformation success mesh=true result=true: Clear('phreatic')"));
  check('transitions: Invalidate() keeps the Bishop message and writes the default deformation reason', noMsg.message === 'Bishop search finished.' && parse(noMsg).deformation.progress.message === 'Deformation result cleared; rerun deformation analysis.' && parse(noMsg).deformation.rejectReason === '', JSON.stringify([noMsg.message, parse(noMsg).deformation.progress.message]));
  const wall = newDump.invalidate.find((o) => o.label.startsWith('wall geometry: SetWallField'));
  check('transitions: the wall edit invalidated everything (Bishop + deformation + seepage mesh)', parse(wall).results === null && parse(wall).seepage.mesh === null && parse(wall).seepage.result === null && parse(wall).deformation.result === null && /Retaining wall geometry updated/.test(wall.message) && wall.seepageReason === 'Wall geometry changed; rerun seepage.', JSON.stringify([wall.message, wall.seepageReason]));
}

// (c) The draw path. PR 18b commit 1 is a pure move: the draw still runs the sync, so the only
// thing to prove here is that base and working tree behave identically frame for frame. Commit 2
// (PLAN §4 defect 3) turns the second check into "the working tree's block is byte-identical after
// every frame" — see report 22 §4 (c).
console.log('\n(c) the draw path');
{
  check('(c) same scenario list', JSON.stringify(oldDump.draw.map((d) => d.label)) === JSON.stringify(newDump.draw.map((d) => d.label)));
  newDump.draw.forEach((n, i) => {
    const o = oldDump.draw[i] || {};
    check(`draw ${n.label}: no exception (${n.frames} frames)`, !n.error && !o.error, n.error || o.error || '');
    check(`draw ${n.label}: base and working tree agree frame for frame (${n.identicalFrames}/${n.frames} left the block identical)`,
      o.before === n.before && o.after === n.after && o.identicalFrames === n.identicalFrames && o.message === n.message && o.cacheChanged === n.cacheChanged,
      `${firstDiff(o.after, n.after) || ''} identical ${o.identicalFrames} → ${n.identicalFrames}, cacheChanged ${o.cacheChanged} → ${n.cacheChanged}`);
    console.log(`       drawing ${n.frames} frames changed the block: ${n.identicalFrames === n.frames ? 'no' : `yes, from frame ${n.firstChangedFrame} — ${firstDiff(n.before, n.after)}`}`);
  });
  const converge = (l) => newDump.sync.find((o) => o.label.startsWith(l)) && oldDump.sync.find((o) => o.label.startsWith(l));
  check('draw: the render after the frames converges both controllers (compared in (a))', ['draw: render after the frames on the changed layers', 'draw: render after the frames on the changed strength set'].every((l) => converge(l) && newDump.sync.find((o) => o.label.startsWith(l)).bishop === oldDump.sync.find((o) => o.label.startsWith(l)).bishop));
}

console.log('\n(d) the package standalone (working tree)');
for (const [label, o] of Object.entries(newDump.pure.sync)) {
  check(`sync replay ${label}: no exception`, !o.error, o.error || '');
  if (o.error) continue;
  check(`sync replay ${label}: syncSoilModel leaves its input untouched`, o.inputUntouched === true);
  check(`sync replay ${label}: patch + invalidation == the controller's block (changed=${o.changed}, ${o.patchKeys.length} keys${o.invalidation ? ', invalidated' : ''})`, o.replayed === o.controller, firstDiff(o.replayed, o.controller));
  // Convergence, not idempotence on the second run — the three documented drivers (see (a) above
  // and report 22 §6). A second sync may still patch `walls` (the one-shot
  // mechanicalActivationPromptPending flag); a third must patch nothing at all, and
  // soilModelFromState must never touch the block it is given.
  check(`sync replay ${label}: converges — a second sync patches at most walls (${JSON.stringify(o.againPatchKeys)}), a third patches nothing, soilModelFromState leaves the block untouched`,
    o.againPatchKeys.every((k) => k === 'walls') && o.thirdChanged === false && o.thirdPatchKeys.length === 0 && o.modelInputUntouched === true,
    JSON.stringify([o.againPatchKeys, o.thirdPatchKeys, o.modelInputUntouched]));
  check(`sync replay ${label}: a converged sync only keeps re-invalidating when the CPT has no layers (${o.layerCount} layers)`,
    o.thirdInvalidated === (o.layerCount === 0), `thirdInvalidated=${o.thirdInvalidated} layers=${o.layerCount}`);
}
{
  const s = newDump.pure.sync;
  check('sync replay: the first import reports reimported without invalidation, the layer edit / strength change report the invalidation', s['walk: first import (sync only)'].reimported === true && s['walk: first import (sync only)'].invalidation === null
    && s['walk: sync after the layer edit (re-import + "Active CPT layers changed")'].invalidation?.message === 'Active CPT layers changed; Bishop results were cleared.'
    && s['walk: sync after the strength set change ("Material strength set changed")'].invalidation?.message === 'Material strength set changed; Bishop results were cleared.'
    && s['walk: sync after the stiffness toggle (materials patched, no invalidation)'].reimported === false && s['walk: sync after the stiffness toggle (materials patched, no invalidation)'].patchKeys.join() === 'materials',
    JSON.stringify([s['walk: first import (sync only)'].invalidation, s['walk: sync after the stiffness toggle (materials patched, no invalidation)'].patchKeys]));
  check('sync replay: the legacy hs step patches materials + the HS prompt path only', s['walk: sync (HS prompt raised, legacy keys stripped)'].patchKeys.join() === 'materials,deformation.options.hsConsistentTangentPromptPending', s['walk: sync (HS prompt raised, legacy keys stripped)'].patchKeys.join());
}
for (const [label, o] of Object.entries(newDump.pure.invalidate)) {
  check(`transition replay ${label}: ${o.fn} == the controller's block`, !o.error && o.replayed === o.controller, o.error || firstDiff(o.replayed, o.controller));
}
{
  const inv = newDump.pure.invalidate;
  const rets = Object.values(inv).map((o) => o.ret);
  check('transition replay: invalidateSeepage reports stop/rerun seepage and keptSolvedState only with mesh + result', Object.entries(inv).filter(([l]) => l.startsWith('seepage')).every(([l, o]) => o.ret.stop.join() === 'seepage' && o.ret.rerun.join() === 'seepage' && o.ret.render === true && o.ret.keptSolvedState === (/mesh=true result=true: SetField/.test(l))));
  check('transition replay: invalidateDeformation reports stop/rerun deformation and keptSolvedState only with mesh + result', Object.entries(inv).filter(([l]) => l.startsWith('deformation') && /InvalidateDeformation/.test(l)).every(([l, o]) => o.ret.stop.join() === 'deformation' && o.ret.rerun.join() === 'deformation' && o.ret.keptSolvedState === (/mesh=true result=true: SetField/.test(l))));
  check('transition replay: invalidateBishop reports stop search + deformation, rerun bishop + deformation', Object.entries(inv).filter(([l]) => /Invalidate\(/.test(l)).every(([, o]) => o.ret.stop.join() === 'search,deformation' && o.ret.rerun.join() === 'bishop,deformation' && o.ret.render === true) && rets.length > 0);
  const w = newDump.pure.wallGeometry;
  check('transition replay: invalidateWallGeometry == the controller after SetWallField(tip.y) and reports everything', w.replayed === w.controller && w.ret.stop.join() === 'search,deformation,seepage' && w.ret.rerun.join() === 'bishop,deformation,seepage', firstDiff(w.replayed, w.controller));
}
{
  const u = newDump.pure.unit;
  check('materialsSource: fresh → empty + reimport without a previous signature; synced → no reimport', u.sourceFresh.reimport === true && u.sourceFresh.empty === true && u.sourceFresh.hadSignature === false && u.sourceSynced.reimport === false && u.sourceSynced.hadSignature === true, JSON.stringify([u.sourceFresh, u.sourceSynced]));
  check('materialsSource: a strength-set / layer / empty change → reimport', u.sourceStrength.reimport && u.sourceStrength.strengthSetChanged && !u.sourceStrength.layersChanged && u.sourceLayers.reimport && u.sourceLayers.layersChanged && !u.sourceLayers.strengthSetChanged && u.sourceEmpty.reimport && u.sourceEmpty.empty);
  check('materialsInvalidation: null on the first import and without a reimport; the two monolith messages otherwise', u.invalidationFresh === null && u.invalidationNone === null && u.invalidationStrength.message === u.messages.strengthSet && u.invalidationLayers.message === u.messages.layers && u.messages.layers === 'Active CPT layers changed; Bishop results were cleared.', JSON.stringify([u.invalidationFresh, u.invalidationStrength, u.invalidationLayers]));
  check('previewState / syncSoilModel leave the input block untouched; the synced preview carries the materials + signature', u.stUntouchedByPreview === true && u.syncedHasMaterials === true);
  check('applySoilModelPatch writes in place (block + nested objects keep their identity); previewState copies along the written path', u.applyInPlace === true && u.previewCopies === true);
  check('mirrorHsParams: key order (rShear appended, hs last), legacy hs keys stripped, reserved → nearSurfaceMinConfiningStress, clamps', u.mirror.legacy === true && u.mirror.keys.join() === 'id,Emc,hs,color,rShear,E50_ref,Eoed_ref,Eur_ref,m,nu_ur,K0nc' && u.mirror.hsKeys.join() === 'p_ref,Rf,e_init,e_max,OCR,nearSurfaceMinConfiningStress,useConsistentTangent'
    && u.mirror.E50 === 500 && u.mirror.Eur === 1500 && u.mirror.m === 1 && u.mirror.nu_ur === -0.99 && u.mirror.K0nc === 0.4 && u.mirror.psi === undefined && u.mirror.rShear === 0.25 && u.mirror.nearSurface === 3 && u.mirror.p_ref === 100, JSON.stringify(u.mirror));
  check('SOIL_MODEL_PATCH_KEYS lists the 21 keys the monolith wrote, HS_PROMPT_PATH the nested one', u.patchKeys.length === 21 && u.patchKeys[0] === 'surfaceLoads' && u.patchKeys.includes('sourceLayerSignature') && u.patchKeys[u.patchKeys.length - 1] === 'draftKind' && u.hsPromptPath === 'deformation.options.hsConsistentTangentPromptPending');
  check('index.js re-exports the engine builders and the three namespaces', u.reexports === true);
  check('stopSearchState / stopSeepageState / stopDeformationState = the silent stops', u.stopStates === true);
}

console.log('\n(e) tests/golden/node/bishop/* recomputed with the package');
{
  const suite = 'tests/golden/node/bishop';
  const onDisk = readdirSync(resolve(ROOT, suite)).sort();
  for (const [f, text] of Object.entries(newDump.pure.goldens)) {
    check(`${f} == buildBishopModel on the fixture (on disk: ${onDisk.includes(f)})`, onDisk.includes(f) && readFileSync(resolve(ROOT, suite, f), 'utf8') === text, firstTextDiff(onDisk.includes(f) ? readFileSync(resolve(ROOT, suite, f), 'utf8') : '', text));
  }
  for (const [fx, o] of Object.entries(newDump.pure.goldenCpt)) {
    const modelFile = `cpt.${fx}.model.json`, materialsFile = `cpt.${fx}.materials.json`;
    const model = readFileSync(resolve(ROOT, suite, modelFile), 'utf8');
    const materials = readFileSync(resolve(ROOT, suite, materialsFile), 'utf8');
    check(`${modelFile} == soilModelFromState on the synced block (changed=false) and on the pre-sync block (changed=true)`, o.postChanged === false && o.preChanged === true && o[modelFile] === model && o[`${modelFile} (pre)`] === model && o.cache === model, firstTextDiff(model, o[modelFile]) || firstTextDiff(model, o[`${modelFile} (pre)`]) || `${o.postChanged} ${o.preChanged}`);
    check(`${materialsFile} == the materials of the pure sync on the pre-sync block`, o[materialsFile] === materials, firstTextDiff(materials, o[materialsFile]));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
