#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 9f / PR 18f (worklog/refactor/28-pr18f-seepslope-panels.md): the
// Seep / Slope panels moved out of legacy-controller.js into src/lib/cpt-app/seepslope/panels/**
// — one module per `data-st6details` group, the tool rail, the eight canvas sheets, the results
// panel, the header, and a layout.js that composes them over one pure view model.
//
// Pattern of scripts/verify_seepslope_{state,model,run,geometry,canvas}.mjs: the controller of a
// base ref (default `integration-r`) and the working-tree controller are each loaded under Node
// through the Tier-B loader in their own child process, dump the same observations to JSON, and
// the parent compares the two dumps byte for byte. Both controllers are materialised as a copy
// with the *same* appended `export { … }` block, so the moved functions — module-local in the
// base, façades in the working tree — are directly comparable.
//
// What a "pure move" means here: **the emitted HTML must be byte-identical**, whitespace, tab
// indentation and attribute order included. So the observation is the whole `#stage6Area`
// innerHTML after `renderStage6()` — not a text extract — recorded as a sha-256 plus a chunked
// hash list (2 000 chars per chunk) so the parent can name the first differing chunk, and the head
// and tail verbatim.
//
//   (a) `#stage6Area` innerHTML over a state matrix — the seeded `loadDemo()` CPT and **every**
//       CPT of the three project fixtures (legacy-v0.5.2, multi-3cpt, single-layered): the empty
//       section, terrain, the zones, the phreatic line, a wall / drain / two surface loads / custom
//       regions, each entity type selected, each of the 14 tools active with and without a draft,
//       each of the three workspaces, the settings panel wide / narrow, and the measurement.
//   (b) every `<details>` open/closed combination the state can express: `S.stage6.ui.details` is
//       a flat map of independent booleans, one per `data-st6details` key, and each key contributes
//       exactly one ` open` attribute. The sweep therefore toggles **each key against both
//       extremes** — every key open with all others closed, and every key closed with all others
//       open — plus all-open, all-closed and the default (absent) map. That is exhaustive over the
//       lattice a single independent attribute per key can generate; 2^26 renders are not.
//   (c) the solved workspaces: a real in-process `analyzeBishopSearch` (the bishop suite's reduced
//       grid) with its selected / second result and its running preview, a real
//       `analyzeSeepageModel` on the app's own model with all five contour modes and every display
//       toggle, and a real js-cpu linear-elastic `analyzeDeformationModel` written in as the run
//       reducer writes it, with all seven contour modes, every display toggle, the three wall
//       overlay quantities, a synthetic wall response and the safety (c-phi) catalogue.
//   (d) the tool rail: each of the seven cards and each of the eight sheets open, in each
//       workspace, plus the hidden rail and the wall-info card.
//   (e) error and warning states: a rejected seepage / deformation run, stale results, solver
//       warnings, drain-validation errors and warnings, orphaned BCs, the HS material warnings and
//       migration prompt, the legacy wall-activation prompt, the partial-load badge and the
//       "no valid circle" search result.
//   (f) every inline handler name still published — `scripts/verify_window_handlers.mjs` is run as
//       a child process, so the panels' `on*="…"` strings are checked against `legacyApi` with the
//       repo's own logic rather than a copy of it.
//   (g) working tree only: the package standalone — the view model is pure (the `bishop` block and
//       the section model it is handed come back byte-identical, and two builds agree), every
//       monolith name survives as a function and is exactly its package function applied to the
//       host state, and every `data-st6details` key the HTML emits has a module that owns it.
//
// Usage
//   node scripts/verify_seepslope_panels.mjs                    compare against integration-r
//   node scripts/verify_seepslope_panels.mjs --base <ref>       compare against another git ref
//   node scripts/verify_seepslope_panels.mjs --snapshot f.json  dump the working tree only
//   node scripts/verify_seepslope_panels.mjs --against f.json   compare the working tree with a dump
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-seepslope-panels-base.legacy-controller.js';
const TREE_REL = 'src/lib/cpt-app/__verify-seepslope-panels-tree.legacy-controller.js';
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
// The bishop golden suite's section and reduced search grid (scripts/golden/suites/bishop.mjs).
const CPT_TERRAIN = { terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], entryZone: { xStart: 1, xEnd: 5 }, exitZone: { xStart: 13, xEnd: 19 } };
const CPT_SEARCH = { nEntry: 4, nExit: 4, nCenter: 6, centerOffsetMin: 0.5, centerOffsetMax: 3, minChordLength: 2, minSlipThickness: 0.75, maxExitAngleDeg: 45, validationSamples: 30, geomTol: 0.001, minSliceWidth: 0.05, targetSlices: 30, keepBest: 3 };
const TOOLS = ['edit', 'terrain', 'phreatic', 'drain', 'region', 'regionHole', 'regionSplit', 'wall', 'measure', 'entry', 'exit', 'load', 'cpt', 'seepageBc'];
const RAIL_PANELS = ['draw', 'structures', 'boundary', 'regions', 'view', 'solve', 'reset'];
const RAIL_SHEETS = ['structures', 'boundary', 'regions', 'view', 'materials', 'workspace', 'reset', 'probe'];
const WORKSPACES = ['stability', 'seepage', 'deformation'];
// The 24 `data-st6details` groups of the settings column and the canvas, plus the two the tool
// rail's View card owns. Written out here so the sweep is the *same* list in both controllers and
// so the rendered union can be asserted against it rather than derived from it.
const DETAILS_KEYS = [
  'bishop-geo-terrain', 'bishop-geo-regions', 'bishop-geo-setup', 'bishop-geo-analysis',
  'bishop-geo-seepage-boundary', 'bishop-geo-deformation', 'bishop-geo-clear', 'bishop-walls',
  'bishop-search', 'bishop-spencer', 'bishop-materials', 'bishop-seepage-perm', 'bishop-seepage-bcs',
  'bishop-seepage-drains', 'bishop-seepage-options', 'bishop-seepage-integration',
  'bishop-deformation-materials', 'bishop-deformation-solve', 'bishop-deformation-diagnostics',
  'bishop-deformation-solver-settings', 'bishop-geo-view', 'bishop-deformation-contour-legend',
  'bishop-seepage-contour-legend', 'bishop-canvas-view-menu',
  // The tool rail's View card owns these two. The card is unreachable from the state as the app
  // stands — `stage6BishopCanvasToolRailHtml` maps `bishopActiveCanvasPanel === 'view'` to `''`, so
  // the dock's View button opens the *sheet* (`viewSectionHtml`) and the card body is never built.
  // They are still swept (the sweep writes the state, and a future PR may revive the card) but the
  // rendered union is asserted against the 24 reachable groups below.
  'bishop-view-quick-snap', 'bishop-view-quick-layers'
];
const REACHABLE_DETAILS_KEYS = DETAILS_KEYS.filter((k) => !k.startsWith('bishop-view-quick-'));

/** Exports appended to a copy of *both* controllers so the panel region can be called directly. */
const EXPORT_BLOCK = `
/* ── appended by scripts/verify_seepslope_panels.mjs (PR 18f) — exports only ── */
export {
  renderStage6BishopApp,
  stage6BishopCanvasToolRailHtml,
  stage6BishopWallInfoPanelHtml,
  stage6BishopToolIcon,
  stage6BishopCanvasToolButton,
  stage6DepthBandReportHtml,
  stage6BishopSafetyCurveHtml,
  stage6BishopSafetyMechanismHtml,
  stage6BishopModeMeta,
  stage6BishopStrengthSetLabel,
  stage6BishopSeepageTerminationLabel,
  stage6BishopResultMethodLabel,
  stage6BishopWallMechanicalLabel,
  stage6BishopPartialLoadBadgeHtml,
  stage6BishopCommitDrawPoint,
  stage6BishopCanvasState,
  stage6BishopCurrentModel,
  stage6BishopUiState,
  stage6BishopSelectedResult,
  stage6BishopSelectedBoundaryEdge,
  stage6BishopCurrentSeepageBoundary,
  stage6BishopBuildLineProbe,
  stage6BishopLineProbeOptions,
  stage6BishopDisplayRegions,
  stage6BishopReadyMessage,
  stage6BishopAnalysisWallId,
  stage6BishopWallResultForId,
  stage6BishopWallOverlayQuantity,
  stage6DetailsOpen,
  stage6SetDetailsOpen,
  stage6MaxDepth,
  ensureStage6State,
  renderStage6
};
`;

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
  if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;   // worker-only code paths
  const stub = installDomStub();

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
  const G = mod;
  const api = globalThis;
  const FIX = resolve(ROOT, 'tests/golden/fixtures');
  const manifest = JSON.parse(readFileSync(join(FIX, 'manifest.json'), 'utf8'));
  const realNow = Date.now.bind(Date);
  const realRandom = Math.random;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, label, timeout = 30000) {
    const t0 = realNow();
    while (!pred()) { if (realNow() - t0 > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(5); }
  }
  const S = () => api.PROJECT.cpts[api.PROJECT.activeCptIdx];
  const B = () => S().stage6.bishop;
  const ser = (v) => JSON.stringify(v, (k, x) => (x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const sha = (s) => createHash('sha256').update(s).digest('hex');
  const area = () => String(stub.document.getElementById('stage6Area').innerHTML ?? '');

  // Wall-clock durations reach the panels through `seepage.result.timing` /
  // `deformation.result.timing` and are printed by the "Runtime" rows, so they differ between two
  // processes by construction. The two solved results are therefore given fixed timings right
  // after the solve (see `freezeTimings`); nothing else in the HTML is masked, and the mask is
  // applied identically in both controllers.
  const FROZEN_TIMING = { totalMs: 1234.5, meshMs: 111.25, solveMs: 222.5, postMs: 33.75, generatedMs: 1700000000000 };
  const freezeTimings = (result) => {
    if (!result || typeof result !== 'object') return result;
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (typeof value === 'number' && /(?:Ms|^ms)$/.test(key) && !/^max/.test(key)) node[key] = FROZEN_TIMING[key] ?? 7.5;
        else if (value && typeof value === 'object') walk(value);
      }
    };
    walk(result);
    return result;
  };

  const dump = { controller: ctrlRel, states: [], handlers: {}, pure: {} };

  /** Render the app and record the whole `#stage6Area` innerHTML. */
  function record(label) {
    stub.rafErrors.length = 0;
    let error = null;
    try { api.renderStage6(); } catch (e) { error = String(e?.message || e); }
    const html = area();
    const chunks = [];
    for (let i = 0; i < html.length; i += 2000) chunks.push(sha(html.slice(i, i + 2000)).slice(0, 12));
    dump.states.push({
      label,
      error,
      chars: html.length,
      sha: sha(html),
      chunks,
      head: html.slice(0, 2400),
      tail: html.slice(-1200),
      details: (html.match(/data-st6details="([^"]+)"/g) || []).sort().join(' '),
      open: (html.match(/data-st6details="[^"]+" open/g) || []).length,
      rafErrors: stub.rafErrors.map((e) => String(e?.message || e).split('\n')[0])
    });
  }

  // ── fixture helpers (same as verify_seepslope_canvas.mjs) ───────────────────────────────
  function fixtureEntry(name) {
    for (const key of [`cpt/${name}`, `cpt/${name}.gef`, `cpt/${name}.state.json`]) if (manifest.fixtures[key]) return { key, ...manifest.fixtures[key] };
    throw new Error(`unknown CPT fixture ${name}`);
  }
  function resetProject() {
    const P = api.PROJECT;
    P.cpts.splice(0, P.cpts.length, api.newCptState('CPT-1'));
    P.activeCptIdx = 0; P.sectionOrder = [0]; P.name = 'CPT Project'; P.phase = 'analysis'; P.stratigraphy = null;
    api.selectCpt(0);
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

  const { analyzeSeepageModel } = await server.ssrLoadModule('/src/lib/cpt-app/seepage/solver.js');
  const { analyzeDeformationModel } = await server.ssrLoadModule('/src/lib/cpt-app/deformation/solver.js');
  const deformationSuite = await server.ssrLoadModule('/scripts/golden/suites/deformation.mjs');
  const { analyzeBishopSearch } = await server.ssrLoadModule('/src/lib/cpt-app/stage6-bishop.js');

  const DEFORMATION_MODEL = JSON.parse(readFileSync(join(FIX, 'models/deformation-base.json'), 'utf8'));
  const DEFORMATION_OPTIONS = deformationSuite.baseOptions({ analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 0.5, constitutiveModel: 'linear-elastic', useWasmCpuPipeline: false });
  const deformationOut = freezeTimings(await analyzeDeformationModel({ model: clone(DEFORMATION_MODEL), options: DEFORMATION_OPTIONS }));

  let clockT = 1700000000000;
  const rng = mulberry32(0x5eed5eed);
  const seedIds = () => { Date.now = () => { clockT += 1000; return clockT; }; Math.random = () => rng(); };
  const unseedIds = () => { Date.now = realNow; Math.random = realRandom; };
  /** Entity ids come from `Date.now()` / `Math.random()`; only the allocating steps are seeded. */
  const seeded = (fn) => { seedIds(); try { return fn(); } finally { unseedIds(); } };

  const canvasEl = stub.document.getElementById('stage6BishopCanvas');

  /** The drawn section every matrix starts from: terrain, zones, phreatic, wall, drain, 2 loads. */
  function drawSection() {
    api.setStage6App('bishop');
    G.stage6BishopCanvasState.canvas = canvasEl;
    api.stage6BishopClear('terrain');
    B().phreatic = []; B().drains = []; B().walls = []; B().surfaceLoads = []; B().customRegions = [];
    B().entryZone = null; B().exitZone = null; B().measurement = { points: [] };
    B().selectedWallId = null; B().selectedDrainId = ''; B().selectedSurfaceLoadId = ''; B().selectedRegionId = null;
  }

  // ═════════════════════ (a) the geometry / selection / tool matrix ═════════════════════
  async function baseMatrix(fixtureLabel) {
    const push = (label) => record(`${fixtureLabel}/${label}`);
    drawSection();
    push('01-empty');

    Object.assign(B(), clone({ terrain: CPT_TERRAIN.terrain }));
    push('02-terrain');
    B().entryZone = clone(CPT_TERRAIN.entryZone);
    B().exitZone = clone(CPT_TERRAIN.exitZone);
    push('03-zones');
    B().phreatic = [{ x: 0, y: 1.5 }, { x: 10, y: 1.0 }, { x: 20, y: -0.5 }];
    push('04-phreatic');

    api.stage6BishopSetTool('wall');
    seeded(() => { G.stage6BishopCommitDrawPoint(canvasEl, { x: 9, y: 4 }); G.stage6BishopCommitDrawPoint(canvasEl, { x: 9, y: -3 }); });
    push('05-wall');
    api.stage6BishopSetTool('drain');
    seeded(() => { G.stage6BishopCommitDrawPoint(canvasEl, { x: 13, y: -1 }); G.stage6BishopCommitDrawPoint(canvasEl, { x: 17, y: -1 }); });
    push('06-drain');
    api.stage6BishopSetTool('load');
    seeded(() => { G.stage6BishopCommitDrawPoint(canvasEl, { x: 2, y: 4 }); G.stage6BishopCommitDrawPoint(canvasEl, { x: 6, y: 4 }); });
    seeded(() => { G.stage6BishopCommitDrawPoint(canvasEl, { x: 12, y: 3 }); G.stage6BishopCommitDrawPoint(canvasEl, { x: 15, y: 2 }); });
    push('07-two-loads');
    const secondLoad = B().surfaceLoads?.[1];
    if (secondLoad) { api.stage6BishopSetSurfaceLoadField(secondLoad.id, 'active', false); push('08-load-inactive'); }
    if (secondLoad) { api.stage6BishopSetSurfaceLoadField(secondLoad.id, 'loadMode', 'total'); push('08b-load-total-mode'); }

    api.stage6BishopSetTool('edit');
    seeded(() => api.stage6BishopCopyCurrentRegionsToCustom());
    push('09-custom-regions-preview');
    api.stage6BishopSetUseCustomRegions(true);
    push('10-custom-regions-active');

    // each entity type selected in turn
    B().selectedRegionId = B().customRegions?.[0]?.id ?? null;
    push('11-region-selected');
    B().selectedRegionId = null;
    B().selectedWallId = B().walls?.[0]?.id ?? null;
    push('12-wall-selected');
    B().selectedWallId = null;
    B().selectedSurfaceLoadId = B().surfaceLoads?.[0]?.id ?? '';
    push('13-load-selected');
    B().selectedDrainId = B().drains?.[0]?.id ?? '';
    push('14-drain-selected');

    // the measurement line: one point (incomplete) and two (complete)
    B().measurement = { points: [{ x: 2, y: 3 }] };
    push('15-measure-one-point');
    B().measurement = { points: [{ x: 2, y: 3 }, { x: 15, y: 0.5 }] };
    push('16-measure-complete');

    // every tool, with and without the draft it would carry
    for (const tool of TOOLS) {
      api.stage6BishopSetTool(tool);
      push(`17-tool-${tool}`);
      if (tool === 'terrain' || tool === 'phreatic') { B().draft = [{ x: 1, y: 3 }, { x: 5, y: 3.4 }]; B().draftKind = tool; }
      else if (tool === 'drain') { B().draft = [{ x: 4, y: -1 }, { x: 6, y: -1 }]; B().draftKind = 'drain'; }
      else if (tool === 'region' || tool === 'regionHole') { B().draft = [{ x: 3, y: 2 }, { x: 8, y: 2 }, { x: 8, y: -1 }]; B().draftKind = tool; }
      else if (tool === 'regionSplit') { B().draft = [{ x: 4, y: 2, edgeIndex: 0, vertexIndex: null, t: 0.5 }]; B().draftKind = 'regionSplit'; }
      else if (tool === 'wall') { B().draft = [{ x: 12, y: 2.4 }]; B().draftKind = 'wall'; }
      else if (tool === 'entry' || tool === 'exit' || tool === 'load') { B().draft = [{ x: 3, y: 4 }]; B().draftKind = tool; }
      if (B().draft?.length) { push(`18-tool-${tool}-draft`); B().draft = []; B().draftKind = ''; }
    }
    api.stage6BishopSetTool('edit');

    // the three workspaces, each with its analysis tab
    for (const ws of WORKSPACES) {
      api.stage6BishopSetWorkspace(ws);
      push(`19-workspace-${ws}`);
      api.stage6BishopSetAnalysisTab('structure');
      push(`20-workspace-${ws}-structure-tab`);
      api.stage6BishopSetAnalysisTab('line-probe');
    }
    api.stage6BishopSetWorkspace('stability');

    // the two settings-column widths and the two strength sets / method modes
    api.stage6BishopToggleSettingsWidth(true);
    push('21-settings-wide');
    api.stage6BishopToggleSettingsWidth(false);
    push('22-settings-narrow');
    for (const set of ['characteristic', 'da1_1', 'da1_2']) {
      api.stage6BishopSetField('strengthSet', set);
      push(`23-strength-${set}`);
    }
    api.stage6BishopSetField('strengthSet', 'characteristic');
    api.stage6BishopSetField('methodMode', 'bishop_only');
    push('24-method-bishop-only');
    api.stage6BishopSetField('methodMode', 'bishop_spencer');
    // the three polygon display toggles the settings column and the view menu share
    for (const [key, value] of [['display.showRegions', false], ['display.showRegionLabels', false], ['display.showRegionLegend', false], ['display.regionOpacity', 0.5]]) {
      api.stage6BishopSetField(key, value);
      push(`25-display-${key}-${value}`);
    }
    for (const [key, value] of [['display.showRegions', true], ['display.showRegionLabels', true], ['display.showRegionLegend', true], ['display.regionOpacity', 0.22]]) api.stage6BishopSetField(key, value);
  }

  // ═════════════════════ (b) every `<details>` state ═════════════════════
  function detailsMatrix(fixtureLabel, keys) {
    const push = (label) => record(`${fixtureLabel}/${label}`);
    const ui = S().stage6.ui;
    const setAll = (open) => { ui.details = Object.fromEntries(keys.map((k) => [k, open])); };
    ui.details = {};
    push('details/default-absent');
    setAll(false);
    push('details/all-closed');
    setAll(true);
    push('details/all-open');
    for (const key of keys) {
      setAll(false); ui.details[key] = true;
      push(`details/only-${key}-open`);
      setAll(true); ui.details[key] = false;
      push(`details/only-${key}-closed`);
    }
    ui.details = {};
  }

  // ═════════════════════ (c) the solved workspaces ═════════════════════
  async function solvedMatrix(fixtureLabel) {
    const push = (label) => record(`${fixtureLabel}/${label}`);

    // stability: a real Bishop search
    api.stage6BishopSetWorkspace('stability');
    api.renderStage6();
    const model = S().stage6Cache.bishopModel;
    let searchError = null;
    if (model) {
      try {
        const b = B();
        const search = analyzeBishopSearch({
          model, entryZone: b.entryZone, exitZone: b.exitZone, methodMode: b.methodMode,
          searchConfig: { ...b.search, ...CPT_SEARCH }, solverConfig: { ...b.solver },
          spencerConfig: { ...b.spencer, recheckCount: 2 }, soilSource: 'regions'
        });
        if (search?.timing) search.timing = { totalMs: 1234.5, trialCount: search.timing.trialCount };
        b.results = search;
        b.selectedResult = 0;
      } catch (e) { searchError = String(e?.message || e); }
    }
    dump.states.push({ label: `${fixtureLabel}/searchError`, error: searchError, chars: 0, sha: sha(String(searchError)), chunks: [], head: '', tail: '', details: '', open: 0, rafErrors: [] });
    push('30-solved-search');
    B().selectedResult = 1;
    push('31-solved-search-second');
    B().progress.running = true;
    B().progress.message = 'Searching…';
    B().progress.trial = 12; B().progress.total = 96; B().progress.percent = 12;
    push('32-search-running');
    B().progress.running = false; B().progress.message = ''; B().progress.percent = 0;
    B().selectedResult = 0;
    const solvedResults = B().results;
    B().results = { ...clone(solvedResults), allResults: [], summary: null, wallSummary: null };
    push('33-search-no-valid-circle');
    B().results = solvedResults;

    // seepage: two prescribed heads, then a real solve
    api.stage6BishopSetWorkspace('seepage');
    push('34-seepage-bcs-empty');
    api.renderStage6();
    const boundary = S().stage6Cache.bishopSeepageBoundary || [];
    seeded(() => {
      for (const [source, head] of [['side-left', 3.0], ['side-right', -0.5]]) {
        const edge = boundary.find((e) => e.source === source);
        if (!edge) continue;
        api.stage6BishopSelectSeepageBoundary(edge.edgeKey);
        api.stage6BishopSetSeepageBcType('head');
        api.stage6BishopSetSeepageBcHead(head);
      }
    });
    push('35-seepage-bcs');
    for (const type of ['no-flow', 'seepage-face', 'head']) {
      api.stage6BishopSetSeepageBcType(type);
      push(`36-seepage-bc-${type}`);
    }
    api.stage6BishopSetField('seepage.options.freeSurface', 'fixed');
    push('37-seepage-fixed-free-surface');
    api.stage6BishopSetField('seepage.options.freeSurface', 'iterate');
    api.stage6BishopSetField('seepage.options.meshTargetAreaAuto', false);
    push('38-seepage-manual-mesh');
    api.stage6BishopSetField('seepage.options.meshTargetAreaAuto', true);
    api.stage6BishopSetField('seepage.options.meshTargetArea', 1.0);
    let seepageError = null;
    try {
      const seepageModel = S().stage6Cache.bishopModel;
      const out = await analyzeSeepageModel({ model: clone({ ...seepageModel, seepage: { ...(seepageModel.seepage || {}), mesh: null, result: null } }) });
      B().seepage.mesh = out.mesh; B().seepage.result = freezeTimings(out.result);
      B().seepage.status = 'success'; B().seepage.stale = false; B().seepage.rejectReason = '';
    } catch (e) { seepageError = String(e?.message || e); }
    dump.states.push({ label: `${fixtureLabel}/seepageError`, error: seepageError, chars: 0, sha: sha(String(seepageError)), chunks: [], head: '', tail: '', details: '', open: 0, rafErrors: [] });
    push('39-solved-seepage');
    for (const mode of ['head', 'porePressure', 'gradient', 'hydraulicFs', 'flow']) {
      api.stage6BishopSetField('seepage.display.contourMode', mode);
      push(`40-seepage-contour-${mode}`);
    }
    api.stage6BishopSetField('seepage.display.contourMode', 'head');
    const SEEPAGE_TOGGLES = ['seepage.display.showContours', 'seepage.display.showContourLines', 'seepage.display.showContourLegend', 'seepage.display.showBoundaryConditions', 'seepage.display.showBoundaryLabels', 'seepage.display.showPhreatic', 'seepage.display.showDrains', 'seepage.display.showFlowVectors', 'seepage.display.showExitGradient'];
    for (const key of SEEPAGE_TOGGLES) {
      const before = key.endsWith('showFlowVectors') || key.endsWith('showExitGradient');
      api.stage6BishopSetField(key, !before);
      push(`41-seepage-${key}-${!before}`);
      api.stage6BishopSetField(key, before);
    }
    B().seepage.stale = true;
    push('42-seepage-stale');
    B().seepage.stale = false;
    // the line probe over the measurement line, every quantity
    for (const option of (G.stage6BishopLineProbeOptions('seepage') || [])) {
      api.stage6BishopSetField('lineProbe.seepageQuantity', option.id);
      push(`43-seepage-probe-${option.id}`);
    }

    // deformation: a real solved field written in as the run reducer writes it. Any option edit
    // invalidates it (seepslope/model/invalidate.js), exactly as it does in the app, so the field
    // is re-installed before every group that must render a solved deformation state — identically
    // in both controllers.
    api.stage6BishopSetWorkspace('deformation');
    push('44-deformation-unsolved');
    const installDeformation = (extra) => {
      B().deformation.mesh = clone(deformationOut.mesh);
      B().deformation.result = clone(deformationOut);
      B().deformation.status = 'success'; B().deformation.stale = false; B().deformation.rejectReason = ''; B().deformation.warnings = [];
      if (extra) extra(B().deformation.result);
    };
    installDeformation();
    push('45-solved-deformation');
    for (const mode of ['uTotal', 'ux', 'uy', 'settlement', 'sxx', 'syy', 'sxy']) {
      api.stage6BishopSetField('deformation.display.contourMode', mode);
      push(`46-deformation-contour-${mode}`);
    }
    api.stage6BishopSetField('deformation.display.contourMode', 'uTotal');
    const DEF_TOGGLES = [['deformation.display.showContours', false], ['deformation.display.showContourLines', false], ['deformation.display.showContourLegend', false], ['deformation.display.showPlasticPoints', false], ['deformation.display.showDisplacementVectors', true], ['deformation.display.showUndeformedMesh', true], ['deformation.display.showDeformedMesh', false], ['deformation.display.showLoadVectors', false], ['deformation.display.showWallMomentOverlay', true]];
    for (const [key, value] of DEF_TOGGLES) {
      api.stage6BishopSetField(key, value);
      push(`47-deformation-${key}-${value}`);
      api.stage6BishopSetField(key, !value);
    }
    api.stage6BishopSetField('deformation.display.showWallMomentOverlay', true);
    for (const q of ['M', 'V', 'N', 'w', 'theta']) {
      api.stage6BishopSetField('deformation.display.wallOverlayQuantity', q);
      push(`48-deformation-walloverlay-${q}`);
    }
    api.stage6BishopSetField('deformation.display.wallOverlayQuantity', 'M');
    // a synthetic wall response, so the Structure tab's five charts and its ranges are painted
    const overlayWall = B().walls?.[0];
    if (overlayWall) {
      const head = overlayWall.head, tip = overlayWall.tip;
      const span = Math.hypot(tip.x - head.x, tip.y - head.y);
      const stations = Array.from({ length: 11 }, (_, i) => {
        const t = i / 10;
        return {
          x: head.x + (tip.x - head.x) * t, y: head.y + (tip.y - head.y) * t, s: t * span,
          ux: 0.004 * Math.sin(Math.PI * t), uy: -0.001 * t,
          wPassive: 0.003 * Math.sin(Math.PI * t), thetaPassive: 0.0004 * (1 - 2 * t),
          M: 42 * t * t * (1 - t) - 6 * t, V: 30 * (1 - 2 * t), N: -12 * t,
          MPassive: 42 * t * t * (1 - t) - 6 * t, VPassive: 30 * (1 - 2 * t)
        };
      });
      const withWall = (r) => { r.wallResults = [{ wallIndex: 0, wallId: overlayWall.id, passiveSign: 1, stations }]; };
      api.stage6BishopSetWallField(0, 'mechanicalActive', true);
      installDeformation(withWall);
      push('49-wall-response');
      api.stage6BishopOpenAnalysisTab('structure', overlayWall.id);
      installDeformation(withWall);
      push('50-wall-response-structure-tab');
      installDeformation((r) => {
        withWall(r);
        r.solver.convergenceState = 'partial';
        r.solver.servicePhaseStarted = true;
        r.solver.initialPhaseConvergenceState = 'converged';
        r.solver.displayedLoadFactor = 0.62;
      });
      push('51-wall-response-partial-badge');
      installDeformation(withWall);
      B().deformation.wallCopyMessage = 'Wall response copied.';
      push('52-wall-copy-message');
      B().deformation.wallCopyMessage = '';
      api.stage6BishopSetAnalysisTab('line-probe');
    }
    api.stage6BishopSetField('deformation.options.displacementScale', 25);
    installDeformation();
    push('53-deformation-scale-25');
    api.stage6BishopSetField('deformation.options.displacementScale', 1);
    for (const model of ['mc-plastic', 'mc-reduced-stiffness', 'linear-elastic']) {
      api.stage6BishopSetField('deformation.options.constitutiveModel', model);
      installDeformation();
      push(`54-deformation-model-${model}`);
    }
    api.stage6BishopSetField('deformation.options.constitutiveModel', 'mc-plastic');
    for (const mode of ['pressure', 'total']) {
      api.stage6BishopSetField('deformation.options.loadMode', mode);
      installDeformation();
      push(`55-deformation-loadmode-${mode}`);
    }
    api.stage6BishopSetField('deformation.options.loadMode', 'pressure');
    for (const t of ['t3', 't6']) {
      api.stage6BishopSetField('deformation.options.meshElementType', t);
      installDeformation();
      push(`56-deformation-element-${t}`);
    }
    api.stage6BishopSetField('deformation.options.meshElementType', 't3');
    // the safety (c-phi) catalogue
    const withSafety = (r) => {
      r.solver.analysisType = 'safety-cphi';
      r.solver.safetyFactorOfSafetyLower = 1.24;
      r.solver.safetyFactorOfSafetyUpper = 1.31;
      r.solver.safetyDisplayedSigmaMsf = 1.28;
      r.solver.safetyStrengthRetained = 0.78;
      r.solver.safetyAcceptedContinuationSteps = 9;
      r.solver.safetyRejectedContinuationSteps = 2;
      r.solver.safetyCurve = Array.from({ length: 8 }, (_, i) => ({ index: i, trialIndex: i, sigmaMsf: 1 + 0.04 * i, uMaxAbs: 0.002 * (i + 1), nonlinearIterations: 4 + i, linearIterations: 20 + i, activeCount: 3 * i, maxDeltaPlasticStrain: 0.0001 * i }));
      r.solver.safetyResult = { mechanism: { status: 'localized', score: 0.71, activePoints: 42, mechanismLength: 6.5, displacementDirectionCoherence: 0.88 }, finalization: { factorOfSafetyUpper: 1.31, factorOfSafetyIsOpenEnded: false } };
      r.summaries = { ...(r.summaries || {}), maxSafetyEquivalentPlasticIncrement: 0.0123 };
    };
    api.stage6BishopSetField('deformation.options.analysisType', 'safety-cphi');
    installDeformation();
    push('57-deformation-safety');
    installDeformation(withSafety);
    push('58-deformation-safety-solved');
    for (const mode of ['uTotal', 'settlement', 'sxx']) {
      api.stage6BishopSetField('deformation.display.contourMode', mode);
      installDeformation(withSafety);
      push(`59-safety-contour-${mode}`);
    }
    api.stage6BishopSetField('deformation.display.contourMode', 'uTotal');
    installDeformation((r) => { withSafety(r); r.solver.safetyResult.finalization.factorOfSafetyIsOpenEnded = true; });
    push('60-deformation-safety-open-ended');
    api.stage6BishopSetField('deformation.options.analysisType', 'deformation');
    installDeformation();
    // the line probe over the measurement line, every deformation quantity
    for (const option of (G.stage6BishopLineProbeOptions('deformation') || [])) {
      api.stage6BishopSetField('lineProbe.deformationQuantity', option.id);
      installDeformation();
      push(`61-deformation-probe-${option.id}`);
    }
    B().lineProbe = { ...(B().lineProbe || {}), copyMessage: 'Copied 128 samples.', copyTone: 'ok' };
    push('62-probe-copy-ok');
    B().lineProbe.copyTone = 'warn';
    push('63-probe-copy-warn');
    B().lineProbe.copyMessage = ''; B().lineProbe.copyTone = '';
  }

  // ═════════════════════ (d) the tool rail ═════════════════════
  function railMatrix(fixtureLabel) {
    const push = (label) => record(`${fixtureLabel}/${label}`);
    const ui = S().stage6.ui;
    for (const ws of WORKSPACES) {
      api.stage6BishopSetWorkspace(ws);
      for (const panel of RAIL_PANELS) {
        ui.bishopActiveCanvasSheet = '';
        ui.bishopActiveCanvasPanel = panel;
        push(`rail/${ws}-panel-${panel}`);
      }
      for (const sheet of RAIL_SHEETS) {
        ui.bishopActiveCanvasPanel = '';
        ui.bishopActiveCanvasSheet = sheet;
        push(`rail/${ws}-sheet-${sheet}`);
      }
      ui.bishopActiveCanvasPanel = ''; ui.bishopActiveCanvasSheet = '';
    }
    api.stage6BishopSetWorkspace('stability');
    ui.bishopCanvasToolsHidden = true;
    push('rail/hidden');
    ui.bishopCanvasToolsHidden = false;
    // the Structures card with a wall selected — the wall-info panel
    ui.bishopActiveCanvasPanel = 'structures';
    B().selectedWallId = B().walls?.[0]?.id ?? null;
    push('rail/structures-with-selected-wall');
    api.stage6BishopSetWallField(0, 'mechanicalActive', false);
    push('rail/structures-wall-inactive');
    api.stage6BishopSetWallField(0, 'mechanicalActive', true);
    B().selectedWallId = null;
    ui.bishopActiveCanvasPanel = '';
  }

  // ═════════════════════ (e) error and warning states ═════════════════════
  function errorMatrix(fixtureLabel) {
    const push = (label) => record(`${fixtureLabel}/${label}`);
    api.stage6BishopSetWorkspace('seepage');
    B().seepage.status = 'failed';
    B().seepage.rejectReason = 'The seepage mesh could not be built for this section.';
    push('err/seepage-rejected');
    B().seepage.progress = { running: true, message: 'Running seepage…', percent: 41 };
    push('err/seepage-running');
    B().seepage.progress = { running: false, message: '', percent: 0 };
    B().seepage.status = 'success'; B().seepage.rejectReason = '';
    B().seepage.drainValidation = {
      errors: [{ message: 'Drain 1 leaves the section envelope.' }],
      warnings: [{ message: 'Drain 1 is above the phreatic line for most of its length.' }]
    };
    push('err/drain-validation');
    B().seepage.drainValidation = { errors: [], warnings: [] };
    if ((B().seepage.bcs || []).length) {
      const bcs = clone(B().seepage.bcs);
      B().seepage.bcs = bcs.map((bc, i) => (i === 0 ? { ...bc, status: 'orphaned' } : bc));
      push('err/orphaned-bc');
      B().seepage.bcs = bcs;
    }

    api.stage6BishopSetWorkspace('deformation');
    B().deformation.status = 'failed';
    B().deformation.rejectReason = 'The deformation solve did not converge before the step floor.';
    B().deformation.warnings = ['Load step floor reached at 62 % of the service load.', 'Two elements exceeded the tension cut-off.'];
    push('err/deformation-rejected');
    B().deformation.stale = true;
    push('err/deformation-stale');
    B().deformation.stale = false;
    B().deformation.progress = { running: true, message: 'Solving…', percent: 73 };
    push('err/deformation-running');
    B().deformation.progress = { running: false, message: '', percent: 0 };
    B().deformation.status = 'success'; B().deformation.rejectReason = ''; B().deformation.warnings = [];
    if (B().deformation.result?.solver) {
      B().deformation.result.solver.initialPhaseDepthBandReport = {
        depthBands: [{ label: '0–2 m', count: 40, plastic: 12, tension: 3, tauOverStrength: { p95: 0.82 } }, { label: '2–4 m', count: 30, plastic: 4, tension: 0, tauOverStrength: { p95: 0.51 } }]
      };
      B().deformation.result.solver.servicePhaseDepthBandReport = {
        depthBands: [{ label: '0–2 m', count: 40, plastic: 21, tension: 6, tauOverStrength: { p95: 0.95 } }]
      };
      push('err/depth-band-diagnostics');
      B().deformation.result.solver.initialPhaseDepthBandReport = null;
      B().deformation.result.solver.servicePhaseDepthBandReport = null;
    }
    // the legacy wall-activation prompt of the Structures card
    if (B().walls?.[0]) {
      const ui = S().stage6.ui;
      ui.bishopActiveCanvasPanel = 'structures';
      B().walls[0].mechanicalActivationPromptPending = true;
      push('err/wall-activation-prompt');
      delete B().walls[0].mechanicalActivationPromptPending;
      ui.bishopActiveCanvasPanel = '';
    }
    // the Hardening-Soil material warnings and the Simo-Hughes migration prompt (UI-gated, so the
    // states below are only distinguishable when STAGE6_ENABLE_HARDENING_SOIL_UI is on; the render
    // is compared either way)
    const mats = B().materials || [];
    if (mats.length) {
      const saved = clone(mats);
      mats[0].E50_ref = 20000; mats[0].Eur_ref = 10000; mats[0].m = 1.4; mats[0].nu_ur = 0.6; mats[0].K0nc = 1.2;
      mats[0].hs = { Rf: 1.4, OCR: 0.4, p_ref: 100, e_init: -1, e_max: -1, nearSurfaceMinConfiningStress: 0, useConsistentTangent: false };
      B().deformation.options.constitutiveModel = 'hardening-soil';
      B().deformation.options.hsConsistentTangentPromptPending = true;
      push('err/hs-warnings-and-prompt');
      B().deformation.options.hsConsistentTangentPromptPending = false;
      B().deformation.options.constitutiveModel = 'mc-plastic';
      B().materials.splice(0, B().materials.length, ...saved);
    }
    api.stage6BishopSetWorkspace('stability');
    B().progress = { ...B().progress, running: false, message: 'Search stopped by the user.', percent: 0 };
    push('err/search-stopped');
    B().progress.message = '';
  }

  // ───────────────────────────── run the matrices ─────────────────────────────
  {
    resetProject();
    const saved = Math.random;
    Math.random = mulberry32(manifest.seed);
    try { api.loadDemo(); } finally { Math.random = saved; }
    await waitFor(() => S().data.length > 0, 'loadDemo');
    S().method = 'sb260';
    api.runClass();
    api.goS(3); api.goS(5);
    Object.assign(B(), clone(CPT_TERRAIN));
    await baseMatrix('demo');
    detailsMatrix('demo', DETAILS_KEYS);
    railMatrix('demo');
    await solvedMatrix('demo');
    errorMatrix('demo');
  }
  let cptCount = 0;
  for (const fx of PROJECT_FIXTURES) {
    resetProject();
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, `projects/${fx}.madep.json`))], `${fx}.madep.json`));
    for (let idx = 0; idx < api.PROJECT.cpts.length; idx += 1) {
      cptCount += 1;
      api.selectCpt(idx);
      api.goS(3); api.goS(5);
      Object.assign(B(), clone(CPT_TERRAIN));
      await baseMatrix(`${fx}#${idx}`);
      if (idx === 0) { railMatrix(`${fx}#${idx}`); errorMatrix(`${fx}#${idx}`); }
      if (fx === 'legacy-v0.5.2' && idx === 0) { detailsMatrix(`${fx}#${idx}`, DETAILS_KEYS); await solvedMatrix(`${fx}#${idx}`); }
    }
  }
  dump.cptCount = cptCount;
  dump.detailsKeys = DETAILS_KEYS;
  dump.renderedDetailsKeys = [...new Set(dump.states.flatMap((st) => (st.details.match(/data-st6details="([^"]+)"/g) || []).map((m) => m.slice(17, -1))))].sort();
  dump.reachableDetailsKeys = [...REACHABLE_DETAILS_KEYS].sort();

  // ═════════════════════ (g) the package standalone (working tree only) ═════════════════════
  if (pure) {
    const P = {};
    const panels = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/panels/index.js');
    const env = {};   // rebuilt below from the controller's own façades

    // the view model is pure: the bishop block and the model it is handed come back unchanged
    api.setStage6App('bishop');
    api.stage6BishopSetWorkspace('stability');
    api.renderStage6();
    const bishop = B();
    const model = S().stage6Cache.bishopModel;
    const panelsEnv = {
      STAGE6_ENABLE_HARDENING_SOIL_UI: false,
      STAGE6_WALL_RESPONSE_QUANTITIES: [],
      stage6DetailsOpen: G.stage6DetailsOpen,
      stage6MaxDepth: G.stage6MaxDepth,
      stage6BishopUiState: G.stage6BishopUiState,
      cachedSeepageBoundary: () => S().stage6Cache?.bishopSeepageBoundary,
      stage6ActiveBishop: () => B(),
      stage6BishopCurrentSeepageBoundary: G.stage6BishopCurrentSeepageBoundary,
      stage6BishopSelectedBoundaryEdge: G.stage6BishopSelectedBoundaryEdge,
      stage6BishopSeepageBcForEdge: () => null,
      stage6BishopSeepageEdgeLabel: () => '—',
      stage6BishopSeepageBcTypeLabel: () => 'No-flow',
      stage6BishopDisplayRegions: G.stage6BishopDisplayRegions,
      stage6BishopReadyMessage: G.stage6BishopReadyMessage,
      stage6BishopLineProbeOptions: G.stage6BishopLineProbeOptions,
      stage6BishopBuildLineProbe: G.stage6BishopBuildLineProbe,
      stage6BishopAnalysisWallId: G.stage6BishopAnalysisWallId,
      stage6BishopWallResultForId: G.stage6BishopWallResultForId,
      stage6BishopWallResultSeries: () => null,
      stage6BishopSelectedWallResult: () => null,
      stage6BishopWallQuantityStats: () => null,
      stage6BishopWallQuantityFormat: () => '—',
      stage6BishopWallOverlayQuantity: G.stage6BishopWallOverlayQuantity,
      stage6BishopSeepageContourOptions: () => [],
      stage6BishopSeepageContourMeta: () => ({ label: '', unit: '' }),
      stage6BishopSeepageContourDerived: () => null,
      stage6BishopSeepageContourLegendTicks: () => [],
      stage6BishopSeepageContourLegendGradient: () => '',
      stage6BishopSeepageContourLegendValue: () => '',
      stage6BishopDeformationContourOptions: () => [],
      stage6BishopDeformationContourMeta: () => ({ label: '', unit: '' }),
      stage6BishopDeformationContourDerived: () => null,
      stage6BishopDeformationContourLegendTicks: () => [],
      stage6BishopDeformationContourLegendGradient: () => '',
      stage6BishopDeformationContourLegendValue: () => '',
      stage6BishopDeformationVectorMode: () => false
    };
    const beforeBishop = ser(bishop);
    const beforeModel = ser(model);
    const vm1 = panels.buildPanelsViewModel({ bishop, bishopUi: G.stage6BishopUiState(), model, modeMeta: G.stage6BishopModeMeta(), selected: G.stage6BishopSelectedResult() }, panelsEnv);
    const vm2 = panels.buildPanelsViewModel({ bishop, bishopUi: G.stage6BishopUiState(), model, modeMeta: G.stage6BishopModeMeta(), selected: G.stage6BishopSelectedResult() }, panelsEnv);
    P.vmPure = { bishop: ser(bishop) === beforeBishop, model: ser(model) === beforeModel };
    P.vmStable = ser(Object.keys(vm1)) === ser(Object.keys(vm2))
      && Object.keys(vm1).every((k) => typeof vm1[k] === 'function' || ser(vm1[k]) === ser(vm2[k]));
    P.vmKeys = Object.keys(vm1);
    P.vmHtmlPure = (() => {
      const before = ser(bishop);
      panels.bishopAppHtml(vm1, panelsEnv);
      panels.bishopAppHtml(vm1, panelsEnv);
      return ser(bishop) === before;
    })();
    P.layoutStable = panels.bishopAppHtml(vm1, panelsEnv) === panels.bishopAppHtml(vm2, panelsEnv);

    // every monolith name survives as a function and is exactly the package function on host state
    const FACADES = [
      ['stage6BishopStrengthSetLabel', () => G.stage6BishopStrengthSetLabel('da1_2'), () => panels.strengthSetLabel('da1_2')],
      ['stage6BishopSeepageTerminationLabel', () => G.stage6BishopSeepageTerminationLabel('time-limit'), () => panels.seepageTerminationLabel('time-limit')],
      ['stage6BishopResultMethodLabel', () => G.stage6BishopResultMethodLabel({ method: 'spencer' }), () => panels.resultMethodLabel({ method: 'spencer' })],
      ['stage6BishopModeMeta', () => G.stage6BishopModeMeta(), () => panels.modeMeta(B())],
      ['stage6BishopToolIcon', () => G.stage6BishopToolIcon('wall'), () => panels.toolIcon('wall')],
      ['stage6BishopCanvasToolButton', () => G.stage6BishopCanvasToolButton({ label: 'X', icon: 'wall' }), () => panels.canvasToolButton({ label: 'X', icon: 'wall' })],
      ['stage6BishopWallMechanicalLabel', () => G.stage6BishopWallMechanicalLabel(B().walls?.[0]), () => panels.wallMechanicalLabel(B().walls?.[0])],
      ['stage6BishopPartialLoadBadgeHtml', () => G.stage6BishopPartialLoadBadgeHtml({ convergenceState: 'partial', servicePhaseStarted: true, initialPhaseConvergenceState: 'converged', displayedLoadFactor: 0.5 }), () => panels.partialLoadBadgeHtml({ convergenceState: 'partial', servicePhaseStarted: true, initialPhaseConvergenceState: 'converged', displayedLoadFactor: 0.5 })],
      ['stage6DepthBandReportHtml', () => G.stage6DepthBandReportHtml({ depthBands: [{ label: 'a', count: 4, plastic: 2, tension: 1 }] }), () => panels.depthBandReportHtml({ depthBands: [{ label: 'a', count: 4, plastic: 2, tension: 1 }] })],
      ['stage6BishopSafetyCurveHtml', () => G.stage6BishopSafetyCurveHtml(null), () => panels.safetyCurveHtml(null)],
      ['stage6BishopSafetyMechanismHtml', () => G.stage6BishopSafetyMechanismHtml(null), () => panels.safetyMechanismHtml(null)]
    ];
    P.facades = FACADES.map(([name, viaFacade, viaPackage]) => {
      let a, b;
      try { a = ser(viaFacade()); } catch (e) { a = `throw:${e?.message}`; }
      try { b = ser(viaPackage()); } catch (e) { b = `throw:${e?.message}`; }
      return [name, typeof G[name] === 'function', a === b, a === b ? '' : `${a} !== ${b}`];
    });
    P.names = ['renderStage6BishopApp', 'stage6BishopCanvasToolRailHtml', 'stage6BishopWallInfoPanelHtml', 'stage6BishopToolIcon', 'stage6BishopCanvasToolButton', 'stage6DepthBandReportHtml', 'stage6BishopSafetyCurveHtml', 'stage6BishopSafetyMechanismHtml', 'stage6BishopModeMeta', 'stage6BishopStrengthSetLabel', 'stage6BishopSeepageTerminationLabel', 'stage6BishopResultMethodLabel', 'stage6BishopWallMechanicalLabel', 'stage6BishopPartialLoadBadgeHtml'].map((n) => [n, typeof G[n] === 'function']);
    P.panelDetailsKeys = panels.PANEL_DETAILS_KEYS;
    P.toolRailDetailsKeys = panels.TOOL_RAIL_DETAILS_KEYS;
    // every section module emits its own key
    const sectionOwners = [
      ['bishop-geo-terrain', panels.terrainSectionHtml],
      ['bishop-geo-regions', panels.geometryRegionsSectionHtml],
      ['bishop-geo-setup', panels.geometrySetupSectionHtml],
      ['bishop-geo-analysis', panels.analysisInputsSectionHtml],
      ['bishop-geo-seepage-boundary', panels.seepageBoundarySectionHtml],
      ['bishop-geo-deformation', panels.mechanicalInputsSectionHtml],
      ['bishop-geo-clear', panels.geometryClearSectionHtml],
      ['bishop-walls', panels.wallsSectionHtml],
      ['bishop-search', panels.searchSectionHtml],
      ['bishop-spencer', panels.spencerSectionHtml],
      ['bishop-materials', panels.materialsSectionHtml],
      ['bishop-seepage-perm', panels.seepagePermeabilitySectionHtml],
      ['bishop-seepage-bcs', panels.seepageBcsSectionHtml],
      ['bishop-seepage-drains', panels.seepageDrainsSectionHtml],
      ['bishop-seepage-options', panels.seepageOptionsSectionHtml],
      ['bishop-seepage-integration', panels.seepageIntegrationSectionHtml],
      ['bishop-deformation-materials', panels.deformationMaterialsSectionHtml],
      ['bishop-deformation-solve', panels.deformationSolveSectionHtml],
      ['bishop-deformation-diagnostics', panels.deformationDiagnosticsSectionHtml],
      ['bishop-deformation-solver-settings', panels.deformationSolverSettingsSectionHtml],
      ['bishop-geo-view', panels.viewSectionHtml],
      ['bishop-canvas-view-menu', panels.canvasViewMenuSectionHtml]
    ];
    P.sectionOwners = sectionOwners.map(([key, fnRef]) => {
      let html = '';
      try { html = String(fnRef(vm1, panelsEnv, {})); } catch (e) { html = `throw:${e?.message}`; }
      return [key, typeof fnRef === 'function', html.includes(`data-st6details="${key}"`)];
    });
    dump.pure = P;
  }

  writeFileSync(outPath, JSON.stringify(dump));
  await server.close();
  process.exit(0);
}

// ─────────────────────────────── parent: compare two dumps ───────────────────────────────
function runDump(ctrlRel, outPath, extra = []) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--dump', ctrlRel, outPath, ...extra],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=6144' } });
  if (r.status !== 0) { console.error(`dump of ${ctrlRel} failed (exit ${r.status})`); process.exit(2); }
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { pass += 1; return; }
  fail += 1; failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
}
function firstTextDiff(a, b) {
  if (a === b) return '';
  const n = Math.min(a.length, b.length);
  let i = 0; while (i < n && a[i] === b[i]) i += 1;
  return `first difference at char ${i}: …${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} vs …${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`;
}
/** Where two renders first diverge: the chunk index, then the text if it is in the recorded head. */
function stateDiff(o, n) {
  if (o.chars !== n.chars) return `length ${o.chars} → ${n.chars} chars`;
  for (let i = 0; i < Math.max(o.chunks.length, n.chunks.length); i += 1) {
    if (o.chunks[i] !== n.chunks[i]) {
      const head = i * 2000 < 2400 ? firstTextDiff(o.head, n.head) : '';
      return `first differing chunk #${i} (chars ${i * 2000}…${i * 2000 + 1999})${head ? `; ${head}` : '; past the recorded head — rerun with --snapshot to dump both'}`;
    }
  }
  return firstTextDiff(o.head, n.head) || firstTextDiff(o.tail, n.tail) || 'sha differs but every chunk matches (?)';
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-seepslope-panels-'));
const materialised = [];
let oldDump, newDump;
try {
  const against = opt('--against');
  const snapshot = opt('--snapshot');
  const treePath = resolve(ROOT, TREE_REL);
  writeFileSync(treePath, readFileSync(resolve(ROOT, CTRL_REL), 'utf8') + EXPORT_BLOCK);
  materialised.push(treePath);
  console.log('working tree controller …');
  newDump = runDump(TREE_REL, join(tmp, 'new.json'), ['--pure']);
  if (snapshot) { writeFileSync(snapshot, JSON.stringify(newDump)); console.log(`snapshot written: ${snapshot}`); process.exit(0); }
  if (against) {
    oldDump = JSON.parse(readFileSync(against, 'utf8'));
  } else {
    const base = opt('--base') || 'integration-r';
    let text;
    try { text = execFileSync('git', ['show', `${base}:${CTRL_REL}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch (e) { console.error(`cannot read ${CTRL_REL} at ${base} (${e.message.split('\n')[0]}); pass --base <ref> or --against <dump.json>`); process.exit(2); }
    const basePath = resolve(ROOT, BASE_REL);
    writeFileSync(basePath, text + EXPORT_BLOCK); materialised.push(basePath);
    console.log(`base controller (${base}) …`);
    oldDump = runDump(BASE_REL, join(tmp, 'old.json'));
  }
} finally {
  for (const p of materialised) if (existsSync(p)) rmSync(p);
  rmSync(tmp, { recursive: true, force: true });
}

// ── (a)-(e) the rendered HTML ────────────────────────────────────────────────────────────
console.log(`\n(a)-(e) #stage6Area innerHTML — ${newDump.states.length} states over ${newDump.cptCount + 1} CPTs`);
check('same state list', JSON.stringify(oldDump.states.map((s) => s.label)) === JSON.stringify(newDump.states.map((s) => s.label)),
  firstTextDiff(JSON.stringify(oldDump.states.map((s) => s.label)), JSON.stringify(newDump.states.map((s) => s.label))));
let totalChars = 0;
const group = (label) => label.split('/')[1]?.replace(/^\d+[a-z]?-/, '') ?? label;
const seenGroups = new Set();
newDump.states.forEach((n, i) => {
  const o = oldDump.states[i] || {};
  totalChars += n.chars;
  seenGroups.add(group(n.label));
  check(`${n.label}: byte-identical (${n.chars} chars)`, o.sha === n.sha && o.error === n.error, stateDiff(o, n));
  check(`${n.label}: same <details> groups`, o.details === n.details && o.open === n.open, `${o.details} (${o.open} open) → ${n.details} (${n.open} open)`);
});
console.log(`        ${(totalChars / 1e6).toFixed(1)} M characters of HTML compared, ${seenGroups.size} distinct scenarios`);
check('no render raised a rAF error', newDump.states.every((s) => s.rafErrors.length === 0),
  JSON.stringify(newDump.states.filter((s) => s.rafErrors.length).map((s) => [s.label, s.rafErrors])).slice(0, 400));
check('no render threw', newDump.states.every((s) => !s.error), JSON.stringify(newDump.states.filter((s) => s.error).map((s) => [s.label, s.error])).slice(0, 400));
check('the matrix actually rendered the app (> 40 M chars)', totalChars > 40e6, String(totalChars));
check(`all 7 project-fixture CPTs were rendered (${newDump.cptCount})`, newDump.cptCount === oldDump.cptCount && newDump.cptCount === 7, `${oldDump.cptCount} → ${newDump.cptCount}`);
check(`the two controllers agree on the ${newDump.renderedDetailsKeys.length} data-st6details keys the matrix reached`,
  JSON.stringify(oldDump.renderedDetailsKeys) === JSON.stringify(newDump.renderedDetailsKeys), JSON.stringify(newDump.renderedDetailsKeys));
check(`the matrix reached all ${newDump.reachableDetailsKeys.length} reachable <details> groups`,
  JSON.stringify(newDump.renderedDetailsKeys) === JSON.stringify(newDump.reachableDetailsKeys),
  `missing ${JSON.stringify(newDump.reachableDetailsKeys.filter((k) => !newDump.renderedDetailsKeys.includes(k)))}, unexpected ${JSON.stringify(newDump.renderedDetailsKeys.filter((k) => !newDump.reachableDetailsKeys.includes(k)))}`);
check("the tool rail's two View-card groups stay unreachable in both controllers (the dock maps the View button to the sheet)",
  ['bishop-view-quick-snap', 'bishop-view-quick-layers'].every((k) => !newDump.renderedDetailsKeys.includes(k) && !oldDump.renderedDetailsKeys.includes(k)));
{
  const solved = newDump.states.filter((s) => /solved-(search|seepage|deformation)/.test(s.label));
  check(`the three solved workspaces were reached (${solved.length} states)`, solved.length >= 6 && solved.every((s) => s.chars > 1000),
    JSON.stringify(solved.map((s) => [s.label, s.chars])).slice(0, 300));
  const searchOk = newDump.states.find((s) => /\/searchError$/.test(s.label));
  check('the Bishop search ran on both controllers', searchOk && oldDump.states.find((s) => s.label === searchOk.label)?.sha === searchOk.sha);
  const rail = newDump.states.filter((s) => /\/rail\//.test(s.label));
  check(`the tool rail was opened on every card and sheet (${rail.length} states)`, rail.length >= 3 * (7 + 8) + 3, String(rail.length));
  const det = newDump.states.filter((s) => /\/details\//.test(s.label));
  check(`every <details> key was swept against both extremes (${det.length} states)`, det.length >= 2 * newDump.detailsKeys.length + 3, String(det.length));
  const errs = newDump.states.filter((s) => /\/err\//.test(s.label));
  check(`the error and warning states were rendered (${errs.length} states)`, errs.length >= 10, String(errs.length));
}

// ── (f) every inline handler is still published ──────────────────────────────────────────
console.log('\n(f) the inline handler names — scripts/verify_window_handlers.mjs');
{
  const r = spawnSync(process.execPath, [resolve(ROOT, 'scripts/verify_window_handlers.mjs')], { cwd: ROOT, encoding: 'utf8' });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const tail = out.trim().split('\n').slice(-4).join(' | ');
  check('every `on*="name("` in an HTML string is published on legacyApi', r.status === 0, tail);
  console.log(`        ${tail}`);
}

// ── (g) the package standalone ───────────────────────────────────────────────────────────
console.log('\n(g) the package standalone (working tree)');
const P = newDump.pure;
check('(g) the view model does not mutate the bishop block it is handed', P.vmPure.bishop === true);
check('(g) the view model does not mutate the section model it is handed', P.vmPure.model === true);
check('(g) two builds of the view model agree', P.vmStable === true);
check(`(g) the view model exposes its ${P.vmKeys.length} derivations`, P.vmKeys.length >= 190, String(P.vmKeys.length));
check('(g) rendering the panels twice does not write the state', P.vmHtmlPure === true);
check('(g) the layout is a pure function of the view model', P.layoutStable === true);
check(`(g) every monolith panel name survives as a function (${P.names.length})`, P.names.every(([, ok]) => ok),
  JSON.stringify(P.names.filter(([, ok]) => !ok)));
check(`(g) each façade is exactly its package function (${P.facades.length} names)`, P.facades.every(([, isFn, same]) => isFn && same),
  JSON.stringify(P.facades.filter(([, isFn, same]) => !isFn || !same).map(([n, , , d]) => [n, d])).slice(0, 400));
check(`(g) the package names all ${P.panelDetailsKeys.length} panel <details> groups and the rail's ${P.toolRailDetailsKeys.length}`,
  JSON.stringify([...P.panelDetailsKeys, ...P.toolRailDetailsKeys].sort()) === JSON.stringify([...newDump.detailsKeys].sort()),
  `package ${JSON.stringify([...P.panelDetailsKeys, ...P.toolRailDetailsKeys].sort())} vs expected ${JSON.stringify([...newDump.detailsKeys].sort())}`);
check(`(g) every section module emits its own data-st6details key (${P.sectionOwners.length})`,
  P.sectionOwners.every(([, isFn, owns]) => isFn && owns),
  JSON.stringify(P.sectionOwners.filter(([, isFn, owns]) => !isFn || !owns)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures.slice(0, 40)) console.log(`  - ${f}`); if (failures.length > 40) console.log(`  … and ${failures.length - 40} more`); }
process.exit(fail ? 1 : 0);
