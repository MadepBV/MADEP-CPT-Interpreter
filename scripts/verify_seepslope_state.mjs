#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 9a / PR 18a (worklog/refactor/21-pr18a-seepslope-state.md): the
// Seep / Slope state package (src/lib/cpt-app/seepslope/state/**) must be a pure move out of
// legacy-controller.js + stage6/apps/bishop-state.js. Pattern of scripts/verify_stage6_shell.mjs:
// the controller of a base ref (default `integration-r`) and the working-tree controller are each
// loaded under Node through the Tier-B loader (scripts/golden/lib/load-controller.mjs: Vite
// ssrLoadModule + DOM stub) in their own child process, dump the same observations to JSON, and
// the parent compares the two dumps byte for byte (JSON text, key order included):
//
//   (a) stage6Defaults()                              deep-equal + key order, twice
//   (b) ensureStage6State() on every CPT of the three project fixtures (legacy-v0.5.2 = the
//       forward-compat fixture, multi-3cpt, single-layered), on a fresh CPT, on the stage6-shared
//       "partial" state, and on two synthetic legacy bishop blocks (v1: bottomMargin, FfTolerance,
//       single surfaceLoad, legacy x/yTop/yTip walls, manual 0.5 m² mesh, predictor initial mode …;
//       v2: schwarz / GPU option carriers, 'syy' / 'mc' contour ids, old solver defaults, missing
//       safetyFinalizationMode …) — every migration step of ensure.js fires at least once;
//       idempotence within each controller
//   (c) every surface-load / wall / drain / region state operation driven through the
//       controller's own handlers on the `layered` fixture under a seeded clock + PRNG (so the
//       wall_/drain_/region_ ids are deterministic and compared verbatim): the canvas tools by
//       synthetic pointer events on #stage6BishopCanvas (wall, load, drain, region, region split,
//       terrain draft + PopDraftPoint = the only undo), the panel setters by their window handlers
//       (SetWallField / SetWallMaterialField × every field incl. rejected values, Select / Delete,
//       SetSurfaceLoadField × every field, SetField('surfaceLoad.*'), SetDrainField, the region
//       handlers, Clear(kind)) — after every step S.stage6.bishop, S.stage6.ui, progress.message,
//       #stage6Area innerHTML, cache keys, rAF errors, alerts and the exception (if any) are
//       compared
//   (d) working tree only: the un-wired "add" operations of the package (addWall, addCustomRegion,
//       createDrainFromVertices) replayed on a copy of the pre-step state with the ids the
//       controller consumed give the same walls / drains / regions as the controller's own pointer
//       / FinishDraft path; the package ensure() run standalone (no shell, no registry) on a copy
//       of every (b) state equals the controller's bishop block; the package defaults() equals
//       stage6Defaults().bishop; stage6/apps/bishop-state.js and the registry hand out the package
//   (e) working tree only: tests/golden/node/bishop/cpt.<fx>.{model,materials,search,run-handler}.json
//       recomputed with the bishop state seeded from the package's defaults() + ensure() must be
//       byte-identical to the files on disk
//
// Usage
//   node scripts/verify_seepslope_state.mjs                 compare against integration-r
//   node scripts/verify_seepslope_state.mjs --base <ref>    compare against another git ref
//   node scripts/verify_seepslope_state.mjs --snapshot f.json   dump the working tree only
//   node scripts/verify_seepslope_state.mjs --against f.json    compare the working tree with a dump
//
// The base controller is materialised as src/lib/cpt-app/__verify-seepslope-base.legacy-controller.js
// together with the base's own stage6/index.js, stage6/registry.js and stage6/apps/bishop-state.js
// (MOVED_SIBLINGS, pattern of verify_pile.mjs) so the base really runs its own defaults /
// migration and not the working tree's re-export; all of them are deleted again, whatever happens.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-seepslope-base.legacy-controller.js';
// [base path in git, materialised path, [specifier as written in that base file → replacement]]
const MOVED_SIBLINGS = [
  { rel: 'src/lib/cpt-app/stage6/index.js', base: 'src/lib/cpt-app/stage6/__verify-seepslope-base-index.js',
    specifiers: [["'./registry.js'", "'./__verify-seepslope-base-registry.js'"], ["'./apps/bishop-state.js'", "'./apps/__verify-seepslope-base-bishop-state.js'"]] },
  { rel: 'src/lib/cpt-app/stage6/registry.js', base: 'src/lib/cpt-app/stage6/__verify-seepslope-base-registry.js',
    specifiers: [["'./apps/bishop-state.js'", "'./apps/__verify-seepslope-base-bishop-state.js'"]] },
  { rel: 'src/lib/cpt-app/stage6/apps/bishop-state.js', base: 'src/lib/cpt-app/stage6/apps/__verify-seepslope-base-bishop-state.js', specifiers: [] }
];
const CONTROLLER_SPECIFIERS = [["'./stage6/index.js'", "'./stage6/__verify-seepslope-base-index.js'"]];
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
const WALK_FIXTURE = 'layered';
// The bishop golden suite's section (scripts/golden/suites/bishop.mjs), verbatim.
const CPT_TERRAIN = { terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], entryZone: { xStart: 1, xEnd: 5 }, exitZone: { xStart: 13, xEnd: 19 } };
const CPT_SEARCH = { nEntry: 4, nExit: 4, nCenter: 6, centerOffsetMin: 0.5, centerOffsetMax: 3, minChordLength: 2, minSlipThickness: 0.75, maxExitAngleDeg: 45, validationSamples: 30, geomTol: 0.001, minSliceWidth: 0.05, targetSlices: 30, keepBest: 3 };

/** A v1-era bishop block (schemaVersion 1): every legacy shape the migration knows. */
const LEGACY_BISHOP_V1 = {
  schemaVersion: 1,
  bottomMargin: 7,
  analysisDepth: '',   // the shell's merge fills null / undefined from the defaults first; '' is the only value that still reaches the bottomMargin branch
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
/** A v2-era bishop block (schemaVersion 2): the later migrations. */
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
  const { createServer } = await import('vite');
  const stub = installDomStub();
  // The canvas stub needs what the pointer handlers touch: pointer capture and the wrapper element
  // the hover tooltip is positioned in (stage6BishopUpdateHoverDom reads canvas.parentElement).
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
  const FIX = resolve(ROOT, 'tests/golden/fixtures');
  const manifest = JSON.parse(readFileSync(join(FIX, 'manifest.json'), 'utf8'));
  const realNow = Date.now.bind(Date);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, label, timeout = 15000) {
    const t0 = realNow();
    while (!pred()) { if (realNow() - t0 > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(5); }
  }
  const S = () => api.PROJECT.cpts[api.PROJECT.activeCptIdx];
  const B = () => S().stage6.bishop;
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
  /** Import a CPT fixture the way scripts/golden/lib/context.mjs does (loadGEF + state injection). */
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
  const area = () => stub.document.getElementById('stage6Area').innerHTML;
  const dump = { controller: ctrlRel, defaults: null, defaultsTwice: null, ensure: {}, walk: [], pure: {} };

  // (a) defaults
  dump.defaults = ser(api.stage6Defaults());
  dump.defaultsTwice = ser(api.stage6Defaults()) === dump.defaults;

  // (b) ensure on the project fixtures + synthetic states; the pre-ensure bishop block is kept for (d)
  const preEnsure = {};
  function observeEnsure(label) {
    const cpt = S();
    preEnsure[label] = cpt.stage6?.bishop ? clone(cpt.stage6.bishop) : null;
    const rawMaxDepth = cpt.layers.length ? cpt.layers[cpt.layers.length - 1].bot : 10;
    api.ensureStage6State();
    const once = ser(cpt.stage6);
    api.ensureStage6State();
    return { id: cpt.id, layers: cpt.layers.length, rawMaxDepth, stage6: once, idempotent: ser(cpt.stage6) === once, cacheKeys: Object.keys(cpt.stage6Cache || {}).sort() };
  }
  for (const name of PROJECT_FIXTURES) {
    resetProject();
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, `projects/${name}.madep.json`))], `${name}.madep.json`));
    const perCpt = [];
    for (let i = 0; i < api.PROJECT.cpts.length; i += 1) {
      api.selectCpt(i);
      perCpt.push(observeEnsure(`${name}[${i}]`));
    }
    dump.ensure[name] = perCpt;
  }
  resetProject();
  dump.ensure.fresh = observeEnsure('fresh');
  S().stage6 = { app: 'pile', bearing: { B: 0.01, Df: 99, eB: 99, shapeMode: 'bogus' }, beam: { modelMode: 'bogus', gpOverride: '2.5', cNomOverride: '' }, bishop: { bottomMargin: 2.5, seepage: { options: { meshTargetArea: 0.3 } } } };
  dump.ensure.partial = observeEnsure('partial');
  S().stage6 = { app: 'bishop', bishop: clone(LEGACY_BISHOP_V1) };
  dump.ensure.legacyV1 = observeEnsure('legacyV1');
  S().stage6 = { app: 'bishop', bishop: clone(LEGACY_BISHOP_V2) };
  dump.ensure.legacyV2 = observeEnsure('legacyV2');
  // the same two blocks on a layered CPT (rawMaxDepth from real layers, the HS mirror in play)
  await classify(WALK_FIXTURE);
  S().stage6 = { app: 'bishop', bishop: clone(LEGACY_BISHOP_V1) };
  dump.ensure.legacyV1Layered = observeEnsure('legacyV1Layered');
  S().stage6 = { app: 'bishop', bishop: clone(LEGACY_BISHOP_V2) };
  dump.ensure.legacyV2Layered = observeEnsure('legacyV2Layered');

  // (c) the state-operation walk under a seeded clock + PRNG
  const idEvents = [];   // every Date.now() / Math.random() value handed out, in order
  let clockT = 1700000000000;
  let rngState = 0x5eed5eed;
  const mulberry = () => { rngState = (rngState + 0x6D2B79F5) | 0; let t = rngState; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const realRandom = Math.random;
  Date.now = () => { clockT += 1000; idEvents.push(['now', clockT]); return clockT; };
  Math.random = () => { const v = mulberry(); idEvents.push(['random', v]); return v; };

  await classify(WALK_FIXTURE);
  Object.assign(B(), clone(CPT_TERRAIN));
  const vp = () => B().viewport;
  const screen = (x, y) => ({ clientX: x * vp().scale + vp().offsetX, clientY: vp().offsetY - y * vp().scale });
  const pointerEvent = (x, y, button) => ({ currentTarget: canvasEl, target: canvasEl, ...screen(x, y), button, buttons: button === 0 ? 1 : button === 1 ? 4 : 2, pointerId: 1, preventDefault() {}, stopPropagation() {} });
  function click(x, y, button = 0) {
    if (typeof canvasEl.onpointerdown !== 'function') throw new Error('canvas handlers not bound (initStage6BishopCanvas did not run)');
    canvasEl.onpointerdown(pointerEvent(x, y, button));
    canvasEl.onpointerup(pointerEvent(x, y, button));
  }
  const pureSnapshots = [];   // (d): the pre-step state of the three "add" paths + the event index
  function snapshotFor(label) { pureSnapshots.push({ label, pre: clone(B()), model: clone(S().stage6Cache?.bishopModel ?? null), eventIndex: idEvents.length }); }
  function step(label, fn) {
    stub.rafErrors.length = 0; stub.alerts.length = 0;
    let error = null;
    try { fn(); } catch (e) { error = String(e?.stack || e).split('\n').slice(0, 3).join(' | '); }
    const obs = {
      label, error,
      bishop: ser(B()),
      ui: ser(S().stage6.ui),
      message: B().progress?.message ?? null,
      app: S().stage6.app,
      html: area(),
      htmlLength: area().length,
      cacheKeys: Object.keys(S().stage6Cache || {}).sort(),
      rafErrors: stub.rafErrors.map((e) => e.split('\n')[0]),
      alerts: stub.alerts.slice()
    };
    dump.walk.push(obs);
    return obs;
  }
  const wallIds = () => B().walls.map((w) => w.id);
  const loadIds = () => (B().surfaceLoads || []).map((l) => l.id);
  const drainIds = () => B().drains.map((d) => d.id);

  step('open bishop app', () => api.setStage6App('bishop'));
  step('rerender', () => api.renderStage6());
  step('run-handler guard (no Worker)', () => api.stage6BishopRunSearch());
  // walls: two added with the wall tool, every field of SetWallField / SetWallMaterialField
  step("SetTool('wall')", () => api.stage6BishopSetTool('wall'));
  step('wall tool: head click (3, 4)', () => click(3, 4));
  snapshotFor('addWall #1');
  step('wall tool: tip click (3, 0) → wall #1', () => click(3, 0));
  step('wall tool: head click (6, 4)', () => click(6, 4));
  snapshotFor('addWall #2');
  step('wall tool: tip click (6, -1) → wall #2', () => click(6, -1));
  for (const [field, value] of [['passiveSide', 'left'], ['passiveSide', 'bogus'], ['maxShearForce', '120'], ['maxShearForce', ''], ['interfaceRInter', '0.5'], ['interfaceRInter', '3'], ['interfaceRInter', ''],
    ['mechanicalActive', 'false'], ['mechanicalActive', true], ['head.x', '3.5'], ['tip.y', '-2'], ['x', '4'], ['x', ''], ['yTop', '3.5'], ['yTip', '-2.5'], ['anchorsCount', '2']]) {
    step(`SetWallField(0, '${field}', ${JSON.stringify(value)})`, () => api.stage6BishopSetWallField(0, field, value));
  }
  step("SetWallField(99, 'x', '1') (no wall)", () => api.stage6BishopSetWallField(99, 'x', '1'));
  for (const [field, value] of [['preset', 'sheetPile'], ['preset', 'bogus'], ['preset', 'steel-sheet-pile-AZ-26'], ['mechanical.model', 'section-properties'], ['mechanical.EA', '1e6'], ['mechanical.EI', '-1'], ['mechanical.GA', ''],
    ['mechanical.model', 'rectangular'], ['mechanical.E', '2e7'], ['mechanical.nu', '0.6'], ['mechanical.nu', '0.3'], ['mechanical.thickness', '0.4'], ['mechanical.kappa', '0.9'], ['mechanical.bogus', '1'],
    ['label', '  My wall '], ['label', ''], ['kAcross', '1e-8'], ['kAlong', '0'], ['kAlong', '1e-7'], ['preset', 'concrete-diaphragm'], ['unknown', '1']]) {
    step(`SetWallMaterialField(1, '${field}', ${JSON.stringify(value)})`, () => api.stage6BishopSetWallMaterialField(1, field, value));
  }
  step("SetWallMaterialField(99, 'label', 'x') (no wall)", () => api.stage6BishopSetWallMaterialField(99, 'label', 'x'));
  step('SelectWall(wall #2)', () => api.stage6BishopSelectWall(wallIds()[1]));
  step("SelectWall('nope')", () => api.stage6BishopSelectWall('nope'));
  step('SelectWall(wall #1)', () => api.stage6BishopSelectWall(wallIds()[0]));
  step('ToggleWallMomentOverlay', () => api.stage6BishopToggleWallMomentOverlay());
  step('DeleteWall(0) (the selected one)', () => api.stage6BishopDeleteWall(0));
  step('DeleteWall(99)', () => api.stage6BishopDeleteWall(99));
  // surface loads: the load tool, every field, the legacy surfaceLoad.* setter path
  step("SetTool('load')", () => api.stage6BishopSetTool('load'));
  step('load tool: start click (10, 3)', () => click(10, 3));
  step('load tool: end click (14, 3) → load #1', () => click(14, 3));
  for (const [field, value] of [['q', '20'], ['label', 'Strip footing'], ['active', false], ['active', 1], ['loadMode', 'total'], ['totalLoad', '500'], ['loadMode', 'pressure'], ['xStart', '9'], ['xEnd', '30'], ['xEnd', 'abc'], ['bogus', 'x']]) {
    step(`SetSurfaceLoadField(load #1, '${field}', ${JSON.stringify(value)})`, () => api.stage6BishopSetSurfaceLoadField(loadIds()[0], field, value));
  }
  step("SetSurfaceLoadField('nope', 'q', '1')", () => api.stage6BishopSetSurfaceLoadField('nope', 'q', '1'));
  step("SetField('surfaceLoad.q', 30)", () => api.stage6BishopSetField('surfaceLoad.q', 30));
  step("SetField('deformation.options.loadMode', 'total')", () => api.stage6BishopSetField('deformation.options.loadMode', 'total'));
  step("SetField('surfaceLoad.q', 12) (total mode → totalLoad)", () => api.stage6BishopSetField('surfaceLoad.q', 12));
  step("SetField('deformation.options.totalLoad', 800)", () => api.stage6BishopSetField('deformation.options.totalLoad', 800));
  step("SetField('surfaceLoad.xStart', 8)", () => api.stage6BishopSetField('surfaceLoad.xStart', 8));
  step("SetTool('load') again", () => api.stage6BishopSetTool('load'));
  step('load tool: start click (1, 4)', () => click(1, 4));
  step('load tool: end click (5, 4) → load #2', () => click(5, 4));
  step('SelectSurfaceLoad(load #1)', () => api.stage6BishopSelectSurfaceLoad(loadIds()[0]));
  step('SelectSurfaceLoad(null)', () => api.stage6BishopSelectSurfaceLoad(null));
  step('SelectSurfaceLoad(load #2)', () => api.stage6BishopSelectSurfaceLoad(loadIds()[1]));
  step('DeleteSurfaceLoad(load #2)', () => api.stage6BishopDeleteSurfaceLoad(loadIds()[1]));
  step("DeleteSurfaceLoad('nope')", () => api.stage6BishopDeleteSurfaceLoad('nope'));
  step("Clear('load')", () => api.stage6BishopClear('load'));
  step("SetField('surfaceLoad.xStart', 2) without loads (legacy mirror)", () => api.stage6BishopSetField('surfaceLoad.xStart', 2));
  step("SetField('surfaceLoad.xEnd', 6) without loads (legacy mirror)", () => api.stage6BishopSetField('surfaceLoad.xEnd', 6));
  step('rerender (mirror → load seed)', () => api.renderStage6());
  // drains: the drain tool (one valid, one rejected by the validator), every field
  step("SetTool('drain')", () => api.stage6BishopSetTool('drain'));
  // (the second wall stands at x = 6: a drain touching it is rejected — the drains stay left of it)
  step('drain tool: start click (1.5, 2)', () => click(1.5, 2));
  snapshotFor('createDrainFromVertices');
  step('drain tool: end click (4.5, 2) → drain #1', () => click(4.5, 2));
  step('drain tool: start click (1.5, 8) (above terrain)', () => click(1.5, 8));
  step('drain tool: end click (4.5, 8) → rejected by validateDrains', () => click(4.5, 8));
  step("Clear('draft')", () => api.stage6BishopClear('draft'));
  for (const [field, value] of [['label', '  Toe drain '], ['label', ''], ['head', '1.5'], ['head', 'abc'], ['head', ''], ['gating', 'always'], ['gating', 'head-cap'], ['gating', 'bogus'], ['bogus', 'x']]) {
    step(`SetDrainField(0, '${field}', ${JSON.stringify(value)})`, () => api.stage6BishopSetDrainField(0, field, value));
  }
  step("SetDrainField(99, 'label', 'x') (no drain)", () => api.stage6BishopSetDrainField(99, 'label', 'x'));
  step('SelectDrain(drain #1)', () => api.stage6BishopSelectDrain(drainIds()[0]));
  step("SelectDrain('')", () => api.stage6BishopSelectDrain(''));
  step('SelectDrain(drain #1) again', () => api.stage6BishopSelectDrain(drainIds()[0]));
  step('DeleteDrain(99)', () => api.stage6BishopDeleteDrain(99));
  step('DeleteDrain(0)', () => api.stage6BishopDeleteDrain(0));
  step("SetWorkspace('stability')", () => api.stage6BishopSetWorkspace('stability'));
  // regions: copy, material, coarseness, enable / disable, the region tool, the split tool, delete, clear
  step('CopyCurrentRegionsToCustom', () => api.stage6BishopCopyCurrentRegionsToCustom());
  step('SetSelectedRegionMaterial(materials[1])', () => api.stage6BishopSetSelectedRegionMaterial(B().materials[1]?.id || B().materials[0]?.id));
  step("SetSelectedRegionCoarseness('0.5')", () => api.stage6BishopSetSelectedRegionCoarseness('0.5'));
  step("SetSelectedRegionCoarseness('abc')", () => api.stage6BishopSetSelectedRegionCoarseness('abc'));
  step('SetUseCustomRegions(false)', () => api.stage6BishopSetUseCustomRegions(false));
  step("SetSelectedRegionCoarseness('2') (custom set disabled)", () => api.stage6BishopSetSelectedRegionCoarseness('2'));
  step('SetUseCustomRegions(true)', () => api.stage6BishopSetUseCustomRegions(true));
  step("SetTool('region')", () => api.stage6BishopSetTool('region'));
  for (const [x, y] of [[2, 3], [6, 3], [6, 1], [2, 1]]) step(`region tool: click (${x}, ${y})`, () => click(x, y));
  step('PopDraftPoint (undo the last vertex)', () => api.stage6BishopPopDraftPoint());
  step('region tool: click (2, 1) again', () => click(2, 1));
  snapshotFor('addCustomRegion');
  step('region tool: right click → FinishDraft → region added', () => click(2, 1, 2));
  step("SetTool('regionSplit')", () => api.stage6BishopSetTool('regionSplit'));
  {
    // the two boundary points: the mid-points of the left-most and right-most edges of the selected polygon
    const edges = () => { const p = B().customRegions.find((r) => r.id === B().selectedRegionId)?.polygon || []; return p.map((a, i) => { const b = p[(i + 1) % p.length]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }); };
    step('split tool: first boundary click (left edge)', () => { const e = edges().sort((a, b) => a.x - b.x); click(e[0].x, e[0].y); });
    step('split tool: second boundary click (right edge) → SplitSelectedRegion', () => { const e = edges().sort((a, b) => b.x - a.x); click(e[0].x, e[0].y); });
  }
  step('DeleteSelectedRegion', () => api.stage6BishopDeleteSelectedRegion());
  step("SetTool('regionSplit') again", () => api.stage6BishopSetTool('regionSplit'));
  step('split tool: click far from the boundary (5, -8)', () => click(5, -8));
  step("Clear('customRegions')", () => api.stage6BishopClear('customRegions'));
  step('DeleteSelectedRegion without selection', () => api.stage6BishopDeleteSelectedRegion());
  step('SetUseCustomRegions(true) without regions', () => api.stage6BishopSetUseCustomRegions(true));
  step("SetSelectedRegionMaterial without selection", () => api.stage6BishopSetSelectedRegionMaterial('x'));
  // the terrain draft + undo, then the clears
  step("SetTool('terrain')", () => api.stage6BishopSetTool('terrain'));
  step('terrain tool: click (0, 3)', () => click(0, 3));
  step('terrain tool: click (10, 3)', () => click(10, 3));
  step('PopDraftPoint (undo)', () => api.stage6BishopPopDraftPoint());
  step("Clear('draft')", () => api.stage6BishopClear('draft'));
  step("Clear('walls')", () => api.stage6BishopClear('walls'));
  step("Clear('drains')", () => api.stage6BishopClear('drains'));
  step("Clear('terrain')", () => api.stage6BishopClear('terrain'));
  step('final rerender', () => api.renderStage6());
  dump.idEvents = idEvents.length;
  Date.now = realNow; Math.random = realRandom;

  // (d) + (e): working tree only — the package standalone
  if (pure) {
    const pkg = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/state/index.js');
    const stage6Pkg = await server.ssrLoadModule('/src/lib/cpt-app/stage6/index.js');
    const soilRegions = await server.ssrLoadModule('/src/lib/cpt-app/soil-regions.js');
    // stage6BishopDeformationQuantityIds (deformation-contours region, still a host hook of ensure): the
    // list depends only on the analysis type and the HS flag; the controller's fallback for an unknown
    // type reads the same block's analysisType, which is then unknown too → 'deformation'.
    const deformationQuantityIds = (analysisType = null, hasHs = false) => {
      const ids = ['uTotal', 'settlement', 'ux', 'uy', 'epsilonXx', 'epsilonYy', 'gammaXy', 'equivalentPlasticStrain', 'deltaSigmaYy', 'sigmaYyEffInit', 'sigmaYyEff', 'sigmaYyTotalInit', 'sigmaYyTotal', 'sigmaXxEffInit', 'sigmaXxEff', 'sigmaXxTotalInit', 'sigmaXxTotal', 'tauXy', 'mcEta'];
      if (analysisType === 'safety-cphi') ids.splice(8, 0, 'safetyEquivalentPlasticIncrement');
      if (hasHs === true) ids.push('hsGammaP', 'hsPP', 'hsEpsVPDilative', 'hsLastActiveSet');
      return ids;
    };
    // ensure() standalone on every (b) state: merge of the package defaults + ensure with the CPT's layer bottom
    dump.pure.ensure = {};
    const ensureStandalone = (preBishop, rawMaxDepth) => {
      const st = { bishop: preBishop == null ? pkg.defaults() : clone(preBishop) };
      stage6Pkg.merge(st, { bishop: pkg.defaults() });
      pkg.ensure(st, { rawMaxDepth, maxDepth: Math.max(rawMaxDepth, 0.5), hardeningSoilUi: false, deformationQuantityIds });
      const once = ser(st.bishop);
      pkg.ensure(st, { rawMaxDepth, maxDepth: Math.max(rawMaxDepth, 0.5), hardeningSoilUi: false, deformationQuantityIds });
      return { bishop: once, idempotent: ser(st.bishop) === once };
    };
    const ensured = (label) => label in dump.ensure ? dump.ensure[label] : null;
    for (const [label, obs] of Object.entries(dump.ensure)) {
      if (Array.isArray(obs)) obs.forEach((o, i) => { dump.pure.ensure[`${label}[${i}]`] = { ...ensureStandalone(preEnsure[`${label}[${i}]`], o.rawMaxDepth), controller: ser(JSON.parse(o.stage6).bishop) }; });
      else dump.pure.ensure[label] = { ...ensureStandalone(preEnsure[label], obs.rawMaxDepth), controller: ser(JSON.parse(obs.stage6).bishop) };
    }
    void ensured;
    dump.pure.defaults = ser(pkg.defaults());
    dump.pure.defaultsOfController = ser(JSON.parse(dump.defaults).bishop);
    // the three "add" paths replayed with the ids the controller consumed
    const replayIds = (fromIndex) => {
      let i = fromIndex;
      const take = (kind) => { while (i < idEvents.length && idEvents[i][0] !== kind) i += 1; if (i >= idEvents.length) throw new Error(`no ${kind} event after ${fromIndex}`); return idEvents[i++][1]; };
      return { now: () => take('now'), random: () => take('random') };
    };
    dump.pure.adds = {};
    const walkAt = (label) => dump.walk[dump.walk.findIndex((o) => o.label.startsWith(label))];
    {
      const snap = pureSnapshots.find((s) => s.label === 'addWall #1');
      const post = JSON.parse(walkAt('wall tool: tip click (3, 0)').bishop);
      const pre = clone(snap.pre);
      const id = pkg.addWall(pre, { x: 3, y: 4 }, { x: 3, y: 0 }, replayIds(snap.eventIndex));
      dump.pure.adds.wall1 = { id, walls: ser(pre.walls), selected: pre.selectedWallId, controllerWalls: ser(post.walls), controllerSelected: post.selectedWallId };
    }
    {
      const snap = pureSnapshots.find((s) => s.label === 'addWall #2');
      const post = JSON.parse(walkAt('wall tool: tip click (6, -1)').bishop);
      const pre = clone(snap.pre);
      const id = pkg.addWall(pre, { x: 6, y: 4 }, { x: 6, y: -1 }, replayIds(snap.eventIndex));
      dump.pure.adds.wall2 = { id, walls: ser(pre.walls), selected: pre.selectedWallId, controllerWalls: ser(post.walls), controllerSelected: post.selectedWallId };
    }
    {
      const snap = pureSnapshots.find((s) => s.label === 'createDrainFromVertices');
      const post = JSON.parse(walkAt('drain tool: end click (4.5, 2)').bishop);
      const pre = clone(snap.pre);
      const outcome = pkg.createDrainFromVertices(pre, [{ x: 1.5, y: 2 }, { x: 4.5, y: 2 }], { model: snap.model, ids: replayIds(snap.eventIndex) });
      dump.pure.adds.drain = { ok: outcome.ok, id: outcome.drainId, drains: ser(pre.drains), selected: pre.selectedDrainId, workspace: pre.workspace, validation: ser(pre.seepage.drainValidation),
        controllerDrains: ser(post.drains), controllerSelected: post.selectedDrainId, controllerWorkspace: post.workspace, controllerValidation: ser(post.seepage.drainValidation), controllerMessage: walkAt('drain tool: end click (4.5, 2)').message };
      const rejected = pkg.createDrainFromVertices(clone(snap.pre), [{ x: 1.5, y: 8 }, { x: 4.5, y: 8 }], { model: snap.model, ids: replayIds(snap.eventIndex) });
      dump.pure.adds.drainRejected = { ok: rejected.ok, errors: rejected.validation.errors.length, controllerMessage: walkAt('drain tool: end click (4.5, 8)').message };
    }
    {
      const snap = pureSnapshots.find((s) => s.label === 'addCustomRegion');
      const post = JSON.parse(walkAt('region tool: right click').bishop);
      const pre = clone(snap.pre);
      const id = pkg.addCustomRegion(pre, soilRegions.normalizeRegionPolygon(pre.draft), replayIds(snap.eventIndex));
      dump.pure.adds.region = { id, regions: ser(pre.customRegions), use: pre.useCustomRegions, selected: pre.selectedRegionId, controllerRegions: ser(post.customRegions), controllerUse: post.useCustomRegions, controllerSelected: post.selectedRegionId };
    }

    // (e) the bishop goldens that build models from state, with the state seeded from the package
    const { normalize, digest } = await import('./golden/lib/normalize.mjs');
    const { stableJson } = await import('./golden/lib/store.mjs');
    const { analyzeBishopSearch } = await server.ssrLoadModule('/src/lib/cpt-app/stage6-bishop.js');
    const slimSearch = (result) => {
      if (!result) return result;
      const slimCircle = (r) => (r && typeof r === 'object' && Array.isArray(r.slices) ? { ...r, slices: digest(r.slices), sliceCount: r.slices.length } : r);
      const criticalText = JSON.stringify(result.critical ?? null);
      const dedupe = (r) => (r && JSON.stringify(r) === criticalText ? '<same as critical>' : r);
      return { ...result, criticalOverall: dedupe(result.criticalOverall), criticalThroughWall: dedupe(result.criticalThroughWall), criticalBelowWall: dedupe(result.criticalBelowWall), allResults: (result.allResults || []).map(slimCircle) };
    };
    const names = Object.entries(manifest.fixtures).filter(([k, e]) => k.startsWith('cpt/') && e.role === 'profile').map(([k]) => k.slice(4).replace(/\.(gef|state\.json)$/, '')).filter((n) => !['trailing-qc-only', 'wt-above-surface'].includes(n));
    dump.pure.goldens = {};
    for (const fx of names) {
      await classify(fx);
      api.ensureStage6State();
      const cpt = S();
      const rawMaxDepth = cpt.layers.length ? cpt.layers[cpt.layers.length - 1].bot : 10;
      cpt.stage6.bishop = pkg.defaults();
      pkg.ensure(cpt.stage6, { rawMaxDepth, maxDepth: Math.max(rawMaxDepth, 0.5), hardeningSoilUi: false, deformationQuantityIds });
      Object.assign(cpt.stage6.bishop, clone(CPT_TERRAIN));
      api.setStage6App('bishop');
      const model = cpt.stage6Cache.bishopModel;
      const out = dump.pure.goldens;
      out[`cpt.${fx}.model.json`] = stableJson(normalize(model));
      out[`cpt.${fx}.materials.json`] = stableJson(normalize(cpt.stage6.bishop.materials));
      if (model) {
        const b = cpt.stage6.bishop;
        const search = analyzeBishopSearch({ model, entryZone: b.entryZone, exitZone: b.exitZone, methodMode: b.methodMode, searchConfig: { ...b.search, ...CPT_SEARCH }, solverConfig: { ...b.solver }, spencerConfig: { ...b.spencer, recheckCount: 2 }, soilSource: 'regions' });
        out[`cpt.${fx}.search.json`] = stableJson(normalize(slimSearch(search)));
        api.stage6BishopRunSearch();
        out[`cpt.${fx}.run-handler.json`] = stableJson(normalize({ message: b.progress.message, running: b.progress.running, results: b.results }));
      }
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

const tmp = mkdtempSync(join(tmpdir(), 'verify-seepslope-'));
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
    const show = (rel) => execFileSync('git', ['show', `${base}:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    let text;
    try { text = show(CTRL_REL); }
    catch (e) { console.error(`cannot read ${CTRL_REL} at ${base} (${e.message.split('\n')[0]}); pass --base <ref> or --against <dump.json>`); process.exit(2); }
    for (const sib of MOVED_SIBLINGS) {
      // Always the base's own copy: the working tree's file at the old path is a re-export of the new package.
      let sibText = null;
      try { sibText = show(sib.rel); } catch { /* the base has no such file: nothing to materialise */ }
      if (sibText == null) continue;
      for (const [from, to] of sib.specifiers) sibText = sibText.split(from).join(to);
      const p = resolve(ROOT, sib.base);
      writeFileSync(p, sibText); materialised.push(p);
    }
    for (const [from, to] of CONTROLLER_SPECIFIERS) text = text.split(from).join(to);
    const basePath = resolve(ROOT, BASE_REL);
    writeFileSync(basePath, text); materialised.push(basePath);
    console.log(`base controller (${base}) …`);
    oldDump = runDump(BASE_REL, join(tmp, 'old.json'));
  }
} finally {
  for (const p of materialised) if (existsSync(p)) rmSync(p);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n(a) stage6Defaults()');
check('defaults deep-equal + key order', oldDump.defaults === newDump.defaults, firstDiff(oldDump.defaults, newDump.defaults));
check('defaults() is a fresh identical object each call', newDump.defaultsTwice === true);

console.log('\n(b) ensureStage6State() on the project fixtures + the legacy states');
for (const name of PROJECT_FIXTURES) {
  const o = oldDump.ensure[name], n = newDump.ensure[name] || [];
  check(`${name}: same CPT count (${o.length})`, o.length === n.length);
  o.forEach((oc, i) => {
    const nc = n[i] || {};
    check(`${name}[${i}] ${oc.id}: stage6 deep-equal + key order`, oc.stage6 === nc.stage6, firstDiff(oc.stage6, nc.stage6 || 'null'));
    check(`${name}[${i}] ${oc.id}: ensure is idempotent (new)`, nc.idempotent === true);
    check(`${name}[${i}] ${oc.id}: cache keys`, JSON.stringify(oc.cacheKeys) === JSON.stringify(nc.cacheKeys));
  });
}
for (const k of ['fresh', 'partial', 'legacyV1', 'legacyV2', 'legacyV1Layered', 'legacyV2Layered']) {
  check(`${k} state: deep-equal + key order`, oldDump.ensure[k].stage6 === newDump.ensure[k]?.stage6, firstDiff(oldDump.ensure[k].stage6, newDump.ensure[k]?.stage6 || 'null'));
  check(`${k} state: ensure is idempotent (new)`, newDump.ensure[k]?.idempotent === true);
}
{
  // the legacy fixtures really exercised the migrations (else the deep-equal proves little)
  const v1 = JSON.parse(newDump.ensure.legacyV1.stage6).bishop;
  const v2 = JSON.parse(newDump.ensure.legacyV2.stage6).bishop;
  // The shell merges the defaults before the migration, so a *missing* momentTolerance / FBracketLow /
  // safetyFinalizationMode / meshTargetAreaAuto is filled from the defaults and the legacy FfTolerance /
  // FfBracket* / "missing mode" / "0.5 m² manual" branches never see it (report §6) — the values below
  // are the defaults, and the fixtures only reach the bottomMargin branch through analysisDepth: ''.
  check('legacyV1: schemaVersion → 3, bottomMargin → analysisDepth, spencer filled from the defaults (FfTolerance ignored under the merge), single surfaceLoad → surfaceLoads[], dangling selection cleared',
    v1.schemaVersion === 3 && v1.analysisDepth === 17 && v1.spencer.momentTolerance === 0.001 && v1.spencer.forceTolerance === 0.001 && v1.spencer.FBracketLow === 0.1 && v1.spencer.FBracketHigh === 10 && v1.spencer.recheckCount === 3
      && v1.surfaceLoads.length === 1 && v1.surfaceLoads[0].xStart === 2 && v1.surfaceLoads[0].q === 12 && v1.selectedSurfaceLoadId === null && v1.surfaceLoad.q === 12,
    JSON.stringify({ schemaVersion: v1.schemaVersion, analysisDepth: v1.analysisDepth, spencer: v1.spencer, surfaceLoads: v1.surfaceLoads }));
  check('legacyV1: schwarz / GPU carriers stripped, solverBackend derived, geostatic method → auto, HS prompt pending, HS model hidden → mc-plastic, re-tuned defaults, contour syy → deltaSigmaYy, mesh areas → auto',
    !('schwarzOverlap' in v1.deformation.options) && !('useGpuAcceleration' in v1.deformation.options) && v1.deformation.options.solverBackend === 'wasm-cpu' && v1.deformation.options.useWasmCpuPipeline === true
      && v1.deformation.options.geostaticInitializationMethod === 'auto' && v1.deformation.options.hsConsistentTangentPromptPending === true && v1.deformation.options.constitutiveModel === 'mc-plastic'
      && v1.deformation.options.residualRelTol === 1e-4 && v1.deformation.options.maxLoadSteps === 384 && v1.deformation.options.safetyFinalizationMode === 'production-msf'
      && v1.deformation.options.meshElementType === 't6' && v1.deformation.options.initialStressMode === 'plastic-geostatic' && v1.deformation.options.useStagedGeostaticInit === true
      && JSON.stringify(v1.deformation.options.initialGravityTangentSchedule) === '["plastic","elastic"]' && v1.deformation.options.preconditionerLevel === 'jacobi'
      && v1.seepage.options.meshTargetAreaAuto === true && v1.deformation.options.meshTargetAreaAuto === true && v1.deformation.display.contourMode === 'deltaSigmaYy'
      && v1.deformation.display.wallOverlayQuantity === 'M' && v1.workspace === 'stability' && v1.strengthSet === 'characteristic' && v1.measurement.points.length === 2 && v1.walls.length === 2 && v1.drains.length === 2,
    JSON.stringify({ options: v1.deformation.options, seepage: v1.seepage.options, display: v1.deformation.display, points: v1.measurement.points, walls: v1.walls.length, drains: v1.drains.length }));
  check('legacyV2: duplicate / degenerate loads de-duplicated and renumbered, gravity-ramp without mc-plastic → auto, solverBackend gpu → wasm-cpu, contour mc → mcEta, safety quantity kept, manual 0.7 m² seepage mesh kept, F bracket ordered',
    v2.surfaceLoads.length === 2 && v2.surfaceLoads[0].id === 'load-2' && v2.surfaceLoads[0].xStart === 4 && v2.surfaceLoads[0].xEnd === 8 && v2.surfaceLoads[0].label === 'Load 1' && v2.surfaceLoads[1].id === 'load-3' && v2.surfaceLoads[1].label === 'Load 2' && v2.selectedSurfaceLoadId === null
      && v2.deformation.options.geostaticInitializationMethod === 'auto' && v2.deformation.options.solverBackend === 'wasm-cpu' && v2.deformation.display.contourMode === 'mcEta' && v2.lineProbe.deformationQuantity === 'safetyEquivalentPlasticIncrement'
      && v2.seepage.options.meshTargetAreaAuto === false && v2.seepage.options.meshTargetArea === 0.7 && v2.deformation.options.meshTargetAreaAuto === true && v2.analysisDepth === 15
      && v2.spencer.momentTolerance === 0.5 && v2.spencer.FBracketLow === 3 && v2.spencer.FBracketHigh === 3.1 && v2.deformation.options.hsConsistentTangentPromptPending === true && v2.deformation.status === 'post',
    JSON.stringify({ surfaceLoads: v2.surfaceLoads, options: v2.deformation.options, seepage: v2.seepage.options, spencer: v2.spencer, lineProbe: v2.lineProbe }));
}

console.log(`\n(c) the state operations on ${WALK_FIXTURE} (seeded ids) — ${oldDump.walk.length} steps`);
check(`same step list (${oldDump.walk.length})`, JSON.stringify(oldDump.walk.map((d) => d.label)) === JSON.stringify(newDump.walk.map((d) => d.label)));
check('same number of Date.now() / Math.random() calls during the walk', oldDump.idEvents === newDump.idEvents, `${oldDump.idEvents} → ${newDump.idEvents}`);
oldDump.walk.forEach((o, i) => {
  const n = newDump.walk[i] || {};
  const p = `step ${String(i + 1).padStart(3, '0')} ${o.label}`;
  check(`${p}: no exception in either`, !o.error && !n.error, o.error || n.error || '');
  check(`${p}: exception message identical`, errorMessage(o.error) === errorMessage(n.error), `${errorMessage(o.error)} → ${errorMessage(n.error)}`);
  check(`${p}: S.stage6.bishop deep-equal + key order`, o.bishop === n.bishop, firstDiff(o.bishop, n.bishop));
  check(`${p}: S.stage6.ui deep-equal`, o.ui === n.ui, firstDiff(o.ui, n.ui));
  check(`${p}: progress.message identical`, o.message === n.message, `${JSON.stringify(o.message)} → ${JSON.stringify(n.message)}`);
  check(`${p}: #stage6Area innerHTML byte-identical (${o.htmlLength} chars)`, o.html === n.html && o.app === n.app, firstTextDiff(o.html, n.html));
  check(`${p}: cache keys / rAF errors / alerts identical`, JSON.stringify([o.cacheKeys, o.rafErrors, o.alerts]) === JSON.stringify([n.cacheKeys, n.rafErrors, n.alerts]), `${JSON.stringify([o.cacheKeys, o.rafErrors, o.alerts])} → ${JSON.stringify([n.cacheKeys, n.rafErrors, n.alerts])}`);
});
{
  // the walk really did what its labels say (in the new tree)
  const at = (label) => JSON.parse(newDump.walk.find((o) => o.label.startsWith(label)).bishop);
  const wall2 = at('wall tool: tip click (6, -1)');
  check('walk: two walls with wall_ ids after the wall tool', wall2.walls.length === 2 && wall2.walls.every((w) => /^wall_[0-9a-z]+_[0-9a-z]{5}$/.test(w.id)) && wall2.selectedWallId === wall2.walls[1].id, JSON.stringify(wall2.walls.map((w) => w.id)));
  const load1 = at('load tool: end click (14, 3)');
  check('walk: a load-1 over 10–14 m after the load tool, tool → edit', load1.surfaceLoads.length === 1 && load1.surfaceLoads[0].id === 'load-1' && load1.surfaceLoads[0].xStart === 10 && load1.surfaceLoads[0].xEnd === 14 && load1.tool === 'edit', JSON.stringify(load1.surfaceLoads));
  const drain1Step = newDump.walk.find((o) => o.label.startsWith('drain tool: end click (4.5, 2)'));
  const drain1 = JSON.parse(drain1Step.bishop);
  check('walk: a drain_ id after the drain tool, workspace → seepage', drain1.drains.length === 1 && /^drain_/.test(drain1.drains[0].id) && drain1.selectedDrainId === drain1.drains[0].id && drain1.workspace === 'seepage', `${JSON.stringify(drain1.drains.map((d) => d.id))} ${drain1Step.message}`);
  const rejected = newDump.walk.find((o) => o.label.startsWith('drain tool: end click (4.5, 8)'));
  check('walk: the drain above the terrain was rejected by validateDrains', JSON.parse(rejected.bishop).drains.length === 1 && /outside the seepage analysis domain/.test(rejected.message), rejected.message);
  const copied = at('CopyCurrentRegionsToCustom');
  check('walk: CopyCurrentRegionsToCustom produced region_ ids and enabled the custom set', copied.customRegions.length >= 2 && copied.customRegions.every((r) => /^region_/.test(r.id)) && copied.useCustomRegions === true, JSON.stringify(copied.customRegions.map((r) => r.id)));
  const added = at('region tool: right click');
  check('walk: the region tool added one custom polygon', added.customRegions.length === copied.customRegions.length + 1 && added.draft.length === 0, `${copied.customRegions.length} → ${added.customRegions.length}`);
  const split = newDump.walk.find((o) => o.label.startsWith('split tool: second boundary click'));
  const splitState = JSON.parse(split.bishop);
  check('walk: the split tool split the selected polygon (or reported why not)', (splitState.customRegions.length === added.customRegions.length + 1 && splitState.tool === 'edit') || /split|boundary/i.test(split.message), `${added.customRegions.length} → ${splitState.customRegions.length}: ${split.message}`);
  const setWallSteps = newDump.walk.filter((o) => o.label.startsWith('SetWallField(0'));
  check(`walk: the SetWallField steps changed the state every time except the rejected / no-op ones (${setWallSteps.length} steps)`, new Set(setWallSteps.map((o) => o.bishop)).size >= setWallSteps.length - 5, `${new Set(setWallSteps.map((o) => o.bishop)).size} distinct`);
}

console.log('\n(d) the package standalone (working tree)');
check('package defaults() == stage6Defaults().bishop (deep-equal + key order)', newDump.pure.defaults === newDump.pure.defaultsOfController, firstDiff(newDump.pure.defaults, newDump.pure.defaultsOfController));
for (const [label, o] of Object.entries(newDump.pure.ensure)) {
  check(`ensure() standalone on ${label} == the controller's bishop block`, o.bishop === o.controller, firstDiff(o.bishop, o.controller));
  check(`ensure() standalone on ${label} is idempotent`, o.idempotent === true);
}
{
  const a = newDump.pure.adds;
  check(`addWall #1 replay == the wall tool's wall (${a.wall1.id})`, a.wall1.walls === a.wall1.controllerWalls && a.wall1.selected === a.wall1.controllerSelected && a.wall1.id === a.wall1.selected, firstDiff(a.wall1.walls, a.wall1.controllerWalls));
  check(`addWall #2 replay == the wall tool's wall (${a.wall2.id})`, a.wall2.walls === a.wall2.controllerWalls && a.wall2.selected === a.wall2.controllerSelected, firstDiff(a.wall2.walls, a.wall2.controllerWalls));
  check(`createDrainFromVertices replay == the drain tool's drain (${a.drain.id})`, a.drain.ok === true && a.drain.drains === a.drain.controllerDrains && a.drain.selected === a.drain.controllerSelected && a.drain.workspace === a.drain.controllerWorkspace && a.drain.validation === a.drain.controllerValidation, firstDiff(a.drain.drains, a.drain.controllerDrains) || `${a.drain.selected} / ${a.drain.workspace}`);
  check('createDrainFromVertices rejects the drain above the terrain like the controller', a.drainRejected.ok === false && a.drainRejected.errors > 0 && /outside the seepage analysis domain/.test(a.drainRejected.controllerMessage), JSON.stringify(a.drainRejected));
  check(`addCustomRegion replay == FinishDraft's region (${a.region.id})`, a.region.regions === a.region.controllerRegions && a.region.use === a.region.controllerUse && a.region.selected === a.region.controllerSelected && a.region.id === a.region.selected, firstDiff(a.region.regions, a.region.controllerRegions));
}
{
  const pkg = await import('../src/lib/cpt-app/seepslope/state/index.js');
  const stage6 = await import('../src/lib/cpt-app/stage6/index.js');
  const bishopState = await import('../src/lib/cpt-app/stage6/apps/bishop-state.js');
  check('stage6/apps/bishop-state.js re-exports the package (defaults, ensure, domain helpers)', bishopState.defaults === pkg.defaults && bishopState.ensure === pkg.ensure && bishopState.sortedPolyline === pkg.sortedPolyline && bishopState.resolvedSeepageMeshTargetArea === pkg.resolvedSeepageMeshTargetArea);
  const reg = stage6.createStage6Registry({ retaining: { cardMeta: { id: 'retwall', title: '', desc: '' }, defaults: () => ({}), ensure: () => {} } });
  const entry = stage6.registryEntry(reg, 'bishop');
  check('registry: the bishop entry state is the package (defaults, ensure)', entry.state.defaults === pkg.defaults && entry.state.ensure === pkg.ensure);
  check('entityId: seeded {now: 1000, random: 0.5} → wall_rs_i / drain_rs_i / region_rs_i', pkg.wallId({ now: () => 1000, random: () => 0.5 }) === 'wall_rs_i' && pkg.drainId({ now: () => 1000, random: () => 0.5 }) === 'drain_rs_i' && pkg.regionId({ now: () => 1000, random: () => 0.5 }) === 'region_rs_i');
  const steps = Object.keys(pkg.ensureSteps).filter((k) => k !== 'ensure');
  check(`ensure.js exposes the migration as named steps (${steps.length})`, steps.length >= 25 &&steps.includes('migrateSchemaVersion') && steps.includes('migrateSpencer') && steps.includes('migrateSolverBackend') && steps.includes('migrateSurfaceLoads'));
  const d = pkg.defaults();
  check('defaults() composes fresh objects (no shared references)', pkg.defaults().seepage !== d.seepage && pkg.defaults().deformation.options !== d.deformation.options && JSON.stringify(pkg.defaults()) === JSON.stringify(d));
  // the un-wired ops on a minimal state with fixed ids
  const st = { ...pkg.defaults(), terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], materials: [{ id: 'm1' }] };
  const fixed = { now: () => 1000, random: () => 0.5 };
  check('addWall(bishop, head, tip, ids) threads the ids and selects the wall', pkg.addWall(st, { x: 3, y: 4 }, { x: 3, y: 0 }, fixed) === 'wall_rs_i' && st.walls.length === 1 && st.walls[0].id === 'wall_rs_i' && st.selectedWallId === 'wall_rs_i' && st.walls[0].material.id === 'wall-material-wall_rs_i');
  check('addCustomRegion(bishop, polygon, ids) threads the ids and enables the custom set', pkg.addCustomRegion(st, [{ x: 1, y: 3 }, { x: 5, y: 3 }, { x: 5, y: 1 }, { x: 1, y: 1 }], fixed) === 'region_rs_i' && st.customRegions.length === 1 && st.useCustomRegions === true && st.selectedRegionId === 'region_rs_i');
  check('setWallField / setWallMaterialField report the invalidation class', pkg.setWallField(st, 0, 'mechanicalActive', 'false') === 'mechanical' && pkg.setWallField(st, 0, 'tip.y', '-1') === 'geometry' && pkg.setWallField(st, 0, 'passiveSide', 'left') === 'other' && pkg.setWallField(st, 9, 'x', '1') === null
    && JSON.stringify(pkg.setWallMaterialField(st, 0, 'preset', 'sheetPile')) === '{"seepage":true,"deformation":true}' && JSON.stringify(pkg.setWallMaterialField(st, 0, 'kAlong', '1e-6')) === '{"seepage":true,"deformation":false}' && pkg.setWallMaterialField(st, 0, 'kAlong', '0') === null);
  check('selectWall(bishop, id, ui) opens the structures panel; deleteWall clears the selection', (() => { const ui = {}; return pkg.selectWall(st, 'wall_rs_i', ui)?.id === 'wall_rs_i' && ui.bishopActiveCanvasPanel === 'structures' && pkg.deleteWall(st, 0)?.id === 'wall_rs_i' && st.selectedWallId === null && st.walls.length === 0; })());
  check('surface loads: createSurfaceLoadFromZone / setSurfaceLoadField / deleteSurfaceLoad', (() => { const l = pkg.createSurfaceLoadFromZone(st, { xStart: 10, xEnd: 14 }); return l?.id === 'load-1' && l.xStart === 10 && st.tool === 'edit' && pkg.setSurfaceLoadField(st, 'load-1', 'q', '7')?.q === 7 && pkg.setSurfaceLoadField(st, 'load-1', 'xEnd', 'abc') === null && pkg.setSurfaceLoadField(st, 'load-1', 'nope', 1) === null && st.surfaceLoad.q === 7 && pkg.deleteSurfaceLoad(st, 'load-1') === true && pkg.deleteSurfaceLoad(st, 'load-1') === false; })());
  check('regions: setSelectedRegion / setSelectedRegionCoarseness / setUseCustomRegions / deleteSelectedRegion / clearCustomRegions', (() => { pkg.setSelectedRegion(st, 'region_rs_i'); const r = pkg.setSelectedRegionCoarseness(st, '0.25'); return r?.coarseness === 0.25 && pkg.setUseCustomRegions(st, false) === false && pkg.setUseCustomRegions(st, true) === true && pkg.deleteSelectedRegion(st) === true && st.useCustomRegions === false && pkg.deleteSelectedRegion(st) === false && (pkg.clearCustomRegions(st), st.customRegions.length === 0); })());
}

console.log('\n(e) tests/golden/node/bishop/cpt.* recomputed with the package state');
{
  const suite = 'tests/golden/node/bishop';
  const onDisk = readdirSync(resolve(ROOT, suite)).filter((f) => f.startsWith('cpt.')).sort();
  const pure = newDump.pure.goldens || {};
  check(`golden cpt.* file set == recomputed set (${onDisk.length})`, JSON.stringify(onDisk) === JSON.stringify(Object.keys(pure).sort()), `disk-only ${onDisk.filter((f) => !(f in pure))} recomputed-only ${Object.keys(pure).filter((f) => !onDisk.includes(f))}`);
  for (const f of onDisk) {
    const expected = readFileSync(resolve(ROOT, suite, f), 'utf8');
    check(`${f} byte-identical`, pure[f] === expected, pure[f] == null ? 'not recomputed' : firstTextDiff(expected, pure[f]));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
