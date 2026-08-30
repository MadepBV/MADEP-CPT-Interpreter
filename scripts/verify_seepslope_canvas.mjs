#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 9e / PR 18e (worklog/refactor/27-pr18e-seepslope-canvas.md): the
// Seep / Slope canvas moved out of legacy-controller.js into src/lib/cpt-app/seepslope/canvas/**
// — the viewport, the picking and snapping, the pointer state machine, the pure view model and the
// fourteen draw layers behind one sequencer.
//
// Pattern of scripts/verify_seepslope_{state,model,run,geometry}.mjs: the controller of a base ref
// (default `integration-r`) and the working-tree controller are each loaded under Node through the
// Tier-B loader in their own child process, dump the same observations to JSON, and the parent
// compares the two dumps byte for byte. Like the 18d verifier, **both** controllers are
// materialised as a copy with the *same* appended `export { … }` block (`EXPORT_BLOCK`), so the
// moved functions — module-local in the base, façades in the working tree — can be called directly.
//
// **The one new idea: a recording 2D context.** The Tier-B DOM stub hands every canvas the same
// `new Proxy({}, …)` whose methods swallow their arguments, so `stage6BishopDrawCanvas` runs to
// completion under Node but leaves no trace. This verifier replaces the bishop canvas' context
// with one that logs every call and every property assignment — `fillStyle`, `strokeStyle`,
// `globalAlpha`, `setLineDash`, every `moveTo` / `lineTo` / `arc` coordinate — in order, and
// compares the two logs. That is what makes "the rendered pixels must not change" checkable
// without a browser: the paint is exactly the sequence of calls the context receives.
// (`verify_settlement_dewatering_beam.mjs` introduced the idea for the beam geometry preview.)
//
//   (a) the draw-call log — the seeded loadDemo() CPT and the first CPT of each project fixture
//       (legacy-v0.5.2, multi-3cpt, single-layered), each driven through a matrix of states:
//       empty, terrain only, zones, phreatic, custom regions, walls / drains / loads, every
//       selection, every tool's hover preview, three viewports (fitted, zoomed, panned), and the
//       three solved workspaces — a real in-process `analyzeBishopSearch`, a real
//       `analyzeSeepageModel` on the app's own model, and one js-cpu linear-elastic
//       `analyzeDeformationModel` written in as the run reducer writes it — each with its display
//       toggles and contour modes. Per frame: the sha-256 of the whole call log, its length, the
//       per-method call counts, a chunked hash list (100 calls per chunk, so the parent can name
//       the first differing chunk), the head of the log verbatim, and the model the frame cached.
//   (b) the pointer state machine — recorded event sequences on the `layered` fixture under a
//       seeded clock and PRNG: draw a region, drag a wall, snap to a boundary vertex, cancel a
//       draft, a `pointercancel` mid-drag, a middle-button pan, a wheel zoom, the three edit-mode
//       selections and a click-without-drag on a handle. After every event: `S.stage6.bishop`
//       (deep-equal + key order), `S.stage6.ui`, the canvas state, the tooltip and readout DOM,
//       the draw-log sha, the alerts and the id-call count.
//   (c) the draw path does not write — N frames in five scenarios must leave `S.stage6.bishop`
//       byte-identical (PLAN §4 defect 3 / PR 18b's fix, now structural: the view model is pure).
//   (d) working tree only: the packages standalone — the controller names are the package's own
//       function objects, the viewport round-trips, the fourteen layers are sequenced in the
//       documented order, the view model never mutates its input, and the pointer machine's effect
//       log matches what it asked the host to do.
//
// Usage
//   node scripts/verify_seepslope_canvas.mjs                  compare against integration-r
//   node scripts/verify_seepslope_canvas.mjs --base <ref>     compare against another git ref
//   node scripts/verify_seepslope_canvas.mjs --snapshot f.json    dump the working tree only
//   node scripts/verify_seepslope_canvas.mjs --against f.json     compare the working tree with a dump
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-seepslope-canvas-base.legacy-controller.js';
const TREE_REL = 'src/lib/cpt-app/__verify-seepslope-canvas-tree.legacy-controller.js';
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
// The bishop golden suite's section and reduced search grid (scripts/golden/suites/bishop.mjs).
const CPT_TERRAIN = { terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], entryZone: { xStart: 1, xEnd: 5 }, exitZone: { xStart: 13, xEnd: 19 } };
const CPT_SEARCH = { nEntry: 4, nExit: 4, nCenter: 6, centerOffsetMin: 0.5, centerOffsetMax: 3, minChordLength: 2, minSlipThickness: 0.75, maxExitAngleDeg: 45, validationSamples: 30, geomTol: 0.001, minSliceWidth: 0.05, targetSlices: 30, keepBest: 3 };
const TOOLS = ['edit', 'terrain', 'phreatic', 'drain', 'region', 'regionHole', 'regionSplit', 'wall', 'measure', 'entry', 'exit', 'load', 'cpt', 'seepageBc'];

/** Exports appended to a copy of *both* controllers so the canvas can be driven directly. */
const EXPORT_BLOCK = `
/* ── appended by scripts/verify_seepslope_canvas.mjs (PR 18e) — exports only ── */
export {
  stage6BishopDrawCanvas,
  stage6BishopDrawGrid,
  initStage6BishopCanvas,
  stage6BishopCanvasState,
  stage6BishopScreenToWorld,
  stage6BishopWorldToScreen,
  stage6BishopSnapToleranceWorld,
  stage6BishopBoundaryPickToleranceWorld,
  stage6BishopCurrentDragKey,
  stage6BishopSnapPointKey,
  stage6BishopCollectSnapPoints,
  stage6BishopNearestPointSnap,
  stage6BishopSnapWorldPoint,
  stage6BishopCanvasWorldBounds,
  stage6BishopAutoFitViewportIfNeeded,
  stage6BishopNearestHandle,
  stage6BishopPickSurfaceLoadAtWorld,
  stage6BishopPickWallAtWorld,
  stage6BishopCommitDrawPoint,
  stage6BishopCompleteCurrentActionAt,
  stage6BishopPointerDown,
  stage6BishopPointerMove,
  stage6BishopPointerUp,
  stage6BishopPointerLeave,
  stage6BishopWheel,
  stage6BishopHideHoverDom,
  stage6BishopUpdateHoverDom,
  stage6BishopCurrentModel,
  stage6BishopClearMeasurement,
  stage6BishopSelectedCustomRegion,
  stage6BishopSelectedResult,
  stage6BishopDisplayRegions,
  stage6WorkingLayers,
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

  // ── the recording 2D context ───────────────────────────────────────────────────────────
  // Every method call and every property assignment, in order, one line each. The return value
  // of a method is the DOM stub's own `{width: 0}` so `ctx.measureText(t).width` keeps reading 0
  // in both controllers, and every property *get* is a function so `typeof ctx.roundRect ===
  // 'function'` stays true (the monolith branches on it).
  const drawLog = [];
  const num = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? (Object.is(v, -0) ? '0' : String(v)) : String(v)) : null);
  const arg = (v) => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const n = num(v);
    if (n !== null) return n;
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[${v.map(arg).join(',')}]`;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  const recCtx = new Proxy({}, {
    get: (t, k) => {
      if (typeof k !== 'string') return undefined;
      if (k === 'canvas') return {};
      return (...a) => { drawLog.push(`${k}(${a.map(arg).join(',')})`); return { width: 0 }; };
    },
    set: (t, k, v) => { drawLog.push(`${String(k)}=${arg(v)}`); return true; }
  });
  const canvasEl = stub.document.getElementById('stage6BishopCanvas');
  Object.setPrototypeOf(canvasEl, globalThis.HTMLCanvasElement.prototype);
  canvasEl.getContext = () => recCtx;
  // What the pointer handlers touch: pointer capture and the wrapper the tooltip is placed in.
  const captures = [];
  canvasEl.setPointerCapture = (id) => { captures.push(['set', id]); };
  canvasEl.releasePointerCapture = (id) => { captures.push(['release', id]); };
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
  // The frame caches `S.stage6Cache.bishopModel`, and `buildBishopModelFromStageLayers` copies the
  // whole `bishop.seepage` / `bishop.deformation` block into it — solver output included, and that
  // carries wall-clock durations (`elapsedMs`, `timing.totalMs`, `timing.solveMs`, …) which differ
  // between two processes by construction. Only keys ending in `Ms` (and a bare `ms`) are masked,
  // and every masked key name is dumped so the mask itself is compared; every other number in the
  // model — every node, every head, every stress — stays compared byte for byte.
  const maskedModelKeys = new Set();
  // `max…Ms` is a configured budget, not a measurement — it stays compared.
  const TIMING_KEY = (k) => /(?:Ms|^ms)$/.test(k) && !/^max/.test(k);
  const modelHash = (m) => sha(JSON.stringify(m, (k, x) => {
    if (typeof x === 'number' && TIMING_KEY(k)) { maskedModelKeys.add(k); return '<time>'; }
    return x === undefined ? '<undefined>' : (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x);
  }));

  const dump = { controller: ctrlRel, frames: [], pointer: [], purity: [], pure: {} };

  /**
   * Draw one frame with a recording context and observe it: the whole call log (as a sha-256 plus
   * a chunked hash list so the parent can name the first differing chunk), the per-method counts,
   * the head of the log verbatim, the model the frame cached, and whether the state survived.
   */
  function frame(label) {
    drawLog.length = 0;
    stub.rafErrors.length = 0;
    const before = ser(B());
    let error = null;
    try { G.stage6BishopDrawCanvas(); } catch (e) { error = String(e?.message || e); }
    const after = ser(B());
    const text = drawLog.join('\n');
    const counts = {};
    for (const line of drawLog) {
      const key = /^([A-Za-z0-9_]+)/.exec(line)?.[1] ?? '?';
      counts[key] = (counts[key] || 0) + 1;
    }
    const chunks = [];
    for (let i = 0; i < drawLog.length; i += 100) chunks.push(sha(drawLog.slice(i, i + 100).join('\n')).slice(0, 12));
    return {
      label,
      error,
      calls: drawLog.length,
      chars: text.length,
      sha: sha(text),
      counts,
      chunks,
      head: text.slice(0, 2400),
      tail: text.slice(-600),
      model: modelHash(S().stage6Cache?.bishopModel ?? null),
      stateUnchanged: before === after,
      rafErrors: stub.rafErrors.map((e) => String(e?.message || e).split('\n')[0])
    };
  }

  // ── fixture helpers (same as verify_seepslope_geometry.mjs) ─────────────────────────────
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
  async function classify(name) {
    resetProject();
    await importCpt(name);
    S().method = 'sb260';
    api.runClass();
    api.goS(3); api.goS(5);
  }

  const { analyzeSeepageModel } = await server.ssrLoadModule('/src/lib/cpt-app/seepage/solver.js');
  const { analyzeDeformationModel } = await server.ssrLoadModule('/src/lib/cpt-app/deformation/solver.js');
  const deformationSuite = await server.ssrLoadModule('/scripts/golden/suites/deformation.mjs');
  const { analyzeBishopSearch } = await server.ssrLoadModule('/src/lib/cpt-app/stage6-bishop.js');

  // One js-cpu linear-elastic deformation field, solved once and written into every CPT's
  // bishop.deformation the way the run reducer writes it (`mesh = output.mesh`, `result = output`).
  // It is a *real* solved field with nodal displacements, plastic points and wall results, which is
  // what the deformation draw layer needs; both controllers get the identical object.
  const DEFORMATION_MODEL = JSON.parse(readFileSync(join(FIX, 'models/deformation-base.json'), 'utf8'));
  const DEFORMATION_OPTIONS = deformationSuite.baseOptions({ analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 0.5, constitutiveModel: 'linear-elastic', useWasmCpuPipeline: false });
  const deformationOut = await analyzeDeformationModel({ model: clone(DEFORMATION_MODEL), options: DEFORMATION_OPTIONS });
  dump.deformationWallResults = (deformationOut.wallResults || deformationOut.retainingWallResults || []).length;

  const idEvents = [];
  let clockT = 1700000000000;
  const rng = mulberry32(0x5eed5eed);
  const seedIds = () => { Date.now = () => { clockT += 1000; idEvents.push(['now', clockT]); return clockT; }; Math.random = () => { const v = rng(); idEvents.push(['random', v]); return v; }; };
  const unseedIds = () => { Date.now = realNow; Math.random = realRandom; };
  /**
   * Entity ids (`wall_…`, `drain_…`, `load-…`, `region_…`) are built from `Date.now()` and
   * `Math.random()`, so a step that allocates one must run under the seeded clock and PRNG or the
   * two processes disagree on the id — visible in the cached model, though never in the paint.
   * Only the allocating steps are seeded: the three solvers keep the real clock, so none of their
   * internal time budgets is disturbed.
   */
  const seeded = (fn) => { seedIds(); try { return fn(); } finally { unseedIds(); } };

  /** The pointer event shape the canvas handlers read. */
  const vp = () => B().viewport;
  const screen = (x, y) => ({ clientX: x * vp().scale + vp().offsetX, clientY: vp().offsetY - y * vp().scale });
  const pointerEvent = (x, y, button = 0, extra = {}) => ({
    currentTarget: canvasEl, target: canvasEl, ...screen(x, y), button,
    buttons: button === 0 ? 1 : button === 1 ? 4 : 2, pointerId: 1,
    preventDefault() {}, stopPropagation() {}, ...extra
  });

  // ═════════════════════ (a) the draw-call log over a matrix of states ═════════════════════
  /** Every scenario for one CPT: mutate the state, optionally hover, then record the frame. */
  async function frameMatrix(fixtureLabel) {
    const frames = [];
    const push = (label) => frames.push(frame(`${fixtureLabel}/${label}`));
    const hoverAt = (x, y) => { G.stage6BishopCanvasState.hoverWorld = { x, y }; };
    const noHover = () => { G.stage6BishopCanvasState.hoverWorld = null; };

    api.setStage6App('bishop');
    G.stage6BishopCanvasState.canvas = canvasEl;

    // 1. the empty section (no terrain at all)
    api.stage6BishopClear('terrain');
    B().phreatic = []; B().drains = []; B().walls = []; B().surfaceLoads = []; B().customRegions = [];
    B().entryZone = null; B().exitZone = null; B().measurement = { points: [] };
    noHover();
    push('01-empty');

    // 2. terrain only, then the zones
    Object.assign(B(), clone({ terrain: CPT_TERRAIN.terrain }));
    api.renderStage6();
    push('02-terrain');
    B().entryZone = clone(CPT_TERRAIN.entryZone);
    B().exitZone = clone(CPT_TERRAIN.exitZone);
    api.renderStage6();
    push('03-zones');

    // 3. the three viewports (fitted / zoomed in / panned) on the same state
    const fitted = clone(vp());
    Object.assign(vp(), { scale: fitted.scale * 3.5, offsetX: fitted.offsetX - 120, offsetY: fitted.offsetY + 40 });
    push('04-zoomed');
    Object.assign(vp(), { scale: 6, offsetX: 500, offsetY: -30 });
    push('05-panned-out');
    Object.assign(vp(), fitted);
    push('06-fitted-again');

    // 4. the phreatic line, a wall, a drain and two surface loads
    B().phreatic = [{ x: 0, y: 1.5 }, { x: 10, y: 1.0 }, { x: 20, y: -0.5 }];
    api.renderStage6();
    push('07-phreatic');
    api.stage6BishopSetTool('wall');
    seeded(() => { G.stage6BishopCommitDrawPoint(canvasEl, { x: 9, y: 4 }); G.stage6BishopCommitDrawPoint(canvasEl, { x: 9, y: -3 }); });
    push('08-wall');
    api.stage6BishopSetTool('drain');
    seeded(() => { G.stage6BishopCommitDrawPoint(canvasEl, { x: 13, y: -1 }); G.stage6BishopCommitDrawPoint(canvasEl, { x: 17, y: -1 }); });
    push('09-drain');
    api.stage6BishopSetTool('load');
    seeded(() => { G.stage6BishopCommitDrawPoint(canvasEl, { x: 2, y: 4 }); G.stage6BishopCommitDrawPoint(canvasEl, { x: 6, y: 4 }); });
    push('10-load');
    api.stage6BishopSetTool('edit');
    push('11-edit-handles');

    // 5. the custom-region preview and the committed custom set
    seeded(() => api.stage6BishopCopyCurrentRegionsToCustom());
    push('12-custom-regions-preview');
    api.stage6BishopSetUseCustomRegions(true);
    push('13-custom-regions');
    const firstRegion = B().customRegions?.[0]?.id ?? '';
    G.stage6BishopSetSelectedRegion?.(firstRegion);
    B().selectedRegionId = firstRegion;
    api.renderStage6();
    push('14-region-selected');
    B().selectedRegionId = null;
    B().selectedWallId = B().walls?.[0]?.id ?? null;
    api.renderStage6();
    push('15-wall-selected');
    B().selectedWallId = null;
    B().selectedSurfaceLoadId = B().surfaceLoads?.[0]?.id ?? '';
    api.renderStage6();
    push('16-load-selected');
    B().selectedDrainId = B().drains?.[0]?.id ?? '';
    api.renderStage6();
    push('17-drain-selected');

    // 6. every tool's hover preview, with the draft the tool would have
    for (const tool of TOOLS) {
      api.stage6BishopSetTool(tool);
      noHover();
      push(`18-tool-${tool}-nohover`);
      hoverAt(11, 2.4);
      push(`19-tool-${tool}-hover`);
      if (tool === 'terrain' || tool === 'phreatic') { B().draft = [{ x: 1, y: 3 }, { x: 5, y: 3.4 }]; B().draftKind = tool; }
      else if (tool === 'drain') { B().draft = [{ x: 4, y: -1 }]; B().draftKind = 'drain'; }
      else if (tool === 'region' || tool === 'regionHole') { B().draft = [{ x: 3, y: 2 }, { x: 8, y: 2 }, { x: 8, y: -1 }]; B().draftKind = tool; }
      else if (tool === 'regionSplit') { B().draft = [{ x: 4, y: 2, edgeIndex: 0, vertexIndex: null, t: 0.5 }]; B().draftKind = 'regionSplit'; }
      else if (tool === 'wall') { B().draft = [{ x: 12, y: 2.4 }]; B().draftKind = 'wall'; }
      else if (tool === 'entry' || tool === 'exit' || tool === 'load') { B().draft = [{ x: 3, y: 4 }]; B().draftKind = tool; }
      else if (tool === 'measure') { B().measurement = { points: [{ x: 2, y: 3 }] }; }
      push(`20-tool-${tool}-draft`);
      B().draft = []; B().draftKind = '';
    }
    B().measurement = { points: [{ x: 2, y: 3 }, { x: 15, y: 0.5 }] };
    api.stage6BishopSetTool('edit');
    noHover();
    push('21-measurement');

    // 7. the display toggles of the stability workspace
    api.stage6BishopSetWorkspace('stability');
    for (const [key, value] of [['display.showRegions', false], ['display.showRegionLabels', false], ['display.regionOpacity', 0.5]]) {
      api.stage6BishopSetField(key, value);
      push(`22-display-${key}-${value}`);
    }
    api.stage6BishopSetField('display.showRegions', true);
    api.stage6BishopSetField('display.showRegionLabels', true);
    api.stage6BishopSetField('display.regionOpacity', 0.22);

    // 8. a real Bishop search, drawn with its circles, slices and wall reactions
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
        b.results = search;
        b.selectedResult = 0;
      } catch (e) { searchError = String(e?.message || e); }
    }
    frames.push({ label: `${fixtureLabel}/searchError`, error: searchError, calls: 0, chars: 0, sha: sha(String(searchError)), counts: {}, chunks: [], head: '', tail: '', model: '', stateUnchanged: true, rafErrors: [] });
    push('23-solved-search');
    B().selectedResult = 1;
    push('24-solved-search-second');
    B().progress.running = true;
    B().progress.previewCircle = B().results?.allResults?.[0]?.circle ?? null;
    push('25-search-preview-circle');
    B().progress.running = false;
    B().progress.previewCircle = null;
    B().selectedResult = 0;

    // 9. the seepage workspace: the boundary conditions, then a real solve
    api.stage6BishopSetWorkspace('seepage');
    push('26-seepage-bcs-empty');
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
    push('27-seepage-bcs');
    api.stage6BishopSetTool('seepageBc');
    hoverAt(0, 1.5);
    push('28-seepage-bc-hover');
    noHover();
    api.stage6BishopSetTool('edit');
    api.stage6BishopSetField('seepage.display.showBoundaryLabels', false);
    push('29-seepage-bc-nolabels');
    api.stage6BishopSetField('seepage.display.showBoundaryLabels', true);
    api.stage6BishopSetField('seepage.options.meshTargetArea', 1.0);
    let seepageError = null;
    try {
      const seepageModel = S().stage6Cache.bishopModel;
      const out = await analyzeSeepageModel({ model: clone({ ...seepageModel, seepage: { ...(seepageModel.seepage || {}), mesh: null, result: null } }) });
      B().seepage.mesh = out.mesh; B().seepage.result = out.result;
      B().seepage.status = 'success'; B().seepage.stale = false; B().seepage.rejectReason = '';
    } catch (e) { seepageError = String(e?.message || e); }
    frames.push({ label: `${fixtureLabel}/seepageError`, error: seepageError, calls: 0, chars: 0, sha: sha(String(seepageError)), counts: {}, chunks: [], head: '', tail: '', model: '', stateUnchanged: true, rafErrors: [] });
    push('30-solved-seepage');
    for (const mode of ['head', 'porePressure', 'gradient', 'hydraulicFs', 'flow']) {
      api.stage6BishopSetField('seepage.display.contourMode', mode);
      push(`31-seepage-contour-${mode}`);
    }
    api.stage6BishopSetField('seepage.display.contourMode', 'head');
    for (const [key, value] of [['seepage.display.showContours', false], ['seepage.display.showContourLines', false], ['seepage.display.showPhreatic', false], ['seepage.display.showFlowVectors', true], ['seepage.display.showExitGradient', true], ['seepage.display.showDrains', false], ['seepage.display.showBoundaryConditions', false]]) {
      api.stage6BishopSetField(key, value);
      push(`32-seepage-${key}-${value}`);
    }
    for (const [key, value] of [['seepage.display.showContours', true], ['seepage.display.showContourLines', true], ['seepage.display.showPhreatic', true], ['seepage.display.showFlowVectors', false], ['seepage.display.showExitGradient', false], ['seepage.display.showDrains', true], ['seepage.display.showBoundaryConditions', true]]) {
      api.stage6BishopSetField(key, value);
    }

    // 10. the deformation workspace on a real solved field
    api.stage6BishopSetWorkspace('deformation');
    push('33-deformation-unsolved');
    B().deformation.mesh = clone(deformationOut.mesh);
    B().deformation.result = clone(deformationOut);
    B().deformation.status = 'success'; B().deformation.stale = false; B().deformation.rejectReason = ''; B().deformation.warnings = [];
    push('34-solved-deformation');
    for (const mode of ['uTotal', 'ux', 'uy', 'settlement', 'sxx', 'syy', 'sxy']) {
      api.stage6BishopSetField('deformation.display.contourMode', mode);
      push(`35-deformation-contour-${mode}`);
    }
    api.stage6BishopSetField('deformation.display.contourMode', 'uTotal');
    for (const [key, value] of [['deformation.display.showContours', false], ['deformation.display.showContourLines', false], ['deformation.display.showPlasticPoints', false], ['deformation.display.showDisplacementVectors', true], ['deformation.display.showUndeformedMesh', true], ['deformation.display.showDeformedMesh', false], ['deformation.display.showLoadVectors', false], ['deformation.display.showWallMomentOverlay', true]]) {
      api.stage6BishopSetField(key, value);
      push(`36-deformation-${key}-${value}`);
    }
    for (const q of ['M', 'V', 'N']) {
      api.stage6BishopSetField('deformation.display.wallOverlayQuantity', q);
      push(`37-deformation-walloverlay-${q}`);
    }
    // A synthetic wall response, so the deflected axis, the overlay diagram, its station dots and
    // both extremum callouts are actually painted: the base deformation fixture carries no
    // `wallResults` of its own (checked — `deformationWallResults` is 0), and a staged solve on
    // every CPT would dominate the runtime. Both controllers receive the identical object, so the
    // comparison is exactly as strict; only the *source* of the numbers is synthetic.
    const overlayWall = B().walls?.[0];
    if (overlayWall) {
      const head = overlayWall.head, tip = overlayWall.tip;
      const span = Math.hypot(tip.x - head.x, tip.y - head.y);
      const stations = Array.from({ length: 11 }, (_, i) => {
        const t = i / 10;
        return {
          x: head.x + (tip.x - head.x) * t, y: head.y + (tip.y - head.y) * t, s: t * span,
          ux: 0.004 * Math.sin(Math.PI * t), uy: -0.001 * t,
          M: 42 * t * t * (1 - t) - 6 * t, V: 30 * (1 - 2 * t), N: -12 * t
        };
      });
      const wallResult = (passiveSign, ss) => ({ wallIndex: 0, wallId: overlayWall.id, passiveSign, stations: ss });
      B().deformation.result.wallResults = [wallResult(1, stations)];
      for (const q of ['M', 'V', 'N']) {
        api.stage6BishopSetField('deformation.display.wallOverlayQuantity', q);
        push(`37b-wall-response-${q}`);
      }
      api.stage6BishopSetField('deformation.display.wallOverlayQuantity', 'M');
      B().deformation.result.wallResults = [wallResult(-1, stations)];
      push('37c-wall-response-passive-left');
      B().deformation.result.wallResults = [wallResult(1, stations.map((st) => ({ ...st, M: 0, V: 0, N: 0 })))];
      push('37d-wall-response-flat-overlay');
      api.stage6BishopSetField('deformation.display.showWallMomentOverlay', false);
      B().deformation.result.wallResults = [wallResult(1, stations)];
      push('37e-wall-response-overlay-off');
      api.stage6BishopSetField('deformation.display.showWallMomentOverlay', true);
      // the staleness guard: a snapshot taken at a different head hides the whole overlay
      B().deformation.lastWallInputs = [{ id: overlayWall.id, head: { x: head.x + 1, y: head.y }, tip }];
      push('37f-wall-response-stale');
      B().deformation.lastWallInputs = [{ id: overlayWall.id, head, tip }];
      push('37g-wall-response-fresh-snapshot');
      B().deformation.lastWallInputs = [];
    }
    api.stage6BishopSetField('deformation.options.displacementScale', 25);
    push('38-deformation-scale-25');
    api.stage6BishopSetField('deformation.options.analysisType', 'safety-cphi');
    push('39-deformation-safety');
    api.stage6BishopSetField('deformation.options.analysisType', 'deformation');
    // hover in the deformation workspace picks a wall (its own tooltip branch)
    hoverAt(9, 1);
    push('40-deformation-hover-wall');
    noHover();
    return frames;
  }

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
    dump.frames.push(...await frameMatrix('demo'));
  }
  for (const fx of PROJECT_FIXTURES) {
    resetProject();
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, `projects/${fx}.madep.json`))], `${fx}.madep.json`));
    api.selectCpt(0);
    api.goS(3); api.goS(5);
    Object.assign(B(), clone(CPT_TERRAIN));
    dump.frames.push(...await frameMatrix(`${fx}#0`));
  }

  // ═════════════════════ (b) the pointer state machine ═════════════════════

  function pointerStep(label, fn) {
    stub.rafErrors.length = 0; stub.alerts.length = 0; captures.length = 0; drawLog.length = 0;
    let error = null;
    try { fn(); } catch (e) { error = String(e?.message || e); }
    const tip = stub.document.getElementById('stage6BishopTip');
    const coord = stub.document.getElementById('stage6BishopCoord');
    dump.pointer.push({
      label, error,
      bishop: ser(B()),
      ui: ser(S().stage6.ui),
      drag: ser(G.stage6BishopCanvasState.pointerDrag),
      hoverWorld: ser(G.stage6BishopCanvasState.hoverWorld),
      captures: clone(captures),
      tip: { display: tip.style.display ?? null, left: tip.style.left ?? null, top: tip.style.top ?? null, html: String(tip.innerHTML ?? '') },
      coord: String(coord.textContent ?? ''),
      drawSha: sha(drawLog.join('\n')),
      drawCalls: drawLog.length,
      alerts: stub.alerts.slice(),
      rafErrors: stub.rafErrors.map((e) => String(e?.message || e).split('\n')[0]),
      idEvents: idEvents.length
    });
  }

  await classify('layered');
  Object.assign(B(), clone(CPT_TERRAIN));
  api.setStage6App('bishop');
  G.initStage6BishopCanvas();
  const pointerIdEventsBefore = idEvents.length;
  seedIds();
  try {
    const down = (x, y, button = 0, extra = {}) => canvasEl.onpointerdown(pointerEvent(x, y, button, extra));
    const move = (x, y, extra = {}) => canvasEl.onpointermove(pointerEvent(x, y, 0, extra));
    const up = (x, y, button = 0, extra = {}) => canvasEl.onpointerup(pointerEvent(x, y, button, extra));
    const cancel = (x, y) => canvasEl.onpointercancel(pointerEvent(x, y));
    const click = (x, y, button = 0) => { down(x, y, button); up(x, y, button); };

    pointerStep('00-initial frame', () => G.stage6BishopDrawCanvas());
    pointerStep('01-hover over the section', () => move(10, 2));
    pointerStep('02-hover off the section', () => move(30, 12));
    pointerStep('03-pointer leave', () => canvasEl.onpointerleave({ currentTarget: canvasEl }));

    // draw a region: four clicks, then close on the first point
    pointerStep('04-tool region', () => api.stage6BishopSetTool('region'));
    pointerStep('05-region click 1', () => click(2, 2));
    pointerStep('06-region click 2', () => click(10, 2));
    pointerStep('07-region click 3', () => click(10, -2));
    pointerStep('08-region click 4', () => click(2, -2));
    pointerStep('09-region close on the first point', () => click(2, 2));

    // a draft that is cancelled with the right button, and one popped point at a time
    pointerStep('10-region draft again', () => { click(3, 1); click(7, 1); click(7, -1); });
    pointerStep('11-right click completes the draft', () => click(3, -1, 2));
    pointerStep('12-terrain draft', () => { api.stage6BishopSetTool('terrain'); click(0, 5); click(6, 4.5); });
    pointerStep('13-pop draft point', () => api.stage6BishopPopDraftPoint());
    pointerStep('14-clear the draft', () => api.stage6BishopClear('draft'));

    // a wall, then a drag of its head handle
    pointerStep('15-tool wall', () => api.stage6BishopSetTool('wall'));
    pointerStep('16-wall click 1', () => click(9, 4));
    pointerStep('17-wall click 2', () => click(9, -3));
    pointerStep('18-tool edit', () => api.stage6BishopSetTool('edit'));
    const wallHead = () => B().walls[0].head;
    pointerStep('19-grab the wall head', () => down(wallHead().x, wallHead().y));
    pointerStep('20-drag the wall head', () => { move(9.6, 3.6); move(10.2, 3.2); });
    pointerStep('21-release the wall head', () => up(10.2, 3.2));

    // a click-without-drag on a handle: selection only, results survive (PR 18b)
    pointerStep('22-fake a solved seepage result', () => {
      B().seepage.mesh = { cells: [], nodes: [] };
      B().seepage.result = { headAtNode: [] };
      B().seepage.status = 'success'; B().seepage.stale = false;
    });
    pointerStep('23-click a handle without dragging', () => click(B().terrain[0].x, B().terrain[0].y));

    // snapping: point snap on, click just off a terrain vertex
    pointerStep('24-point snap on, grid snap off', () => { api.stage6BishopSetField('pointSnap', true); api.stage6BishopSetField('gridSnap', false); });
    pointerStep('25-tool phreatic', () => api.stage6BishopSetTool('phreatic'));
    pointerStep('26-click just off the terrain start', () => click(0.08, 4.05));
    pointerStep('27-click just off the terrain knee', () => click(8.06, 3.95));
    pointerStep('28-grid snap on too', () => { api.stage6BishopSetField('gridSnap', true); api.stage6BishopClear('draft'); });
    pointerStep('29-click on a grid-ish point', () => click(12.13, 1.87));
    pointerStep('30-clear the draft', () => api.stage6BishopClear('draft'));

    // pointercancel mid-drag
    pointerStep('31-tool edit', () => api.stage6BishopSetTool('edit'));
    pointerStep('32-grab a terrain vertex', () => down(B().terrain[1].x, B().terrain[1].y));
    pointerStep('33-drag it', () => move(8.4, 3.2));
    pointerStep('34-pointercancel mid-drag', () => cancel(8.4, 3.2));
    pointerStep('35-a move after the cancel does nothing', () => move(9, 3));

    // pan (middle button) and wheel zoom
    pointerStep('36-middle-button pan down', () => down(10, 2, 1));
    pointerStep('37-pan move', () => { move(12, 3); move(14, 4); });
    pointerStep('38-pan up', () => up(14, 4, 1));
    pointerStep('39-wheel in', () => canvasEl.onwheel({ ...pointerEvent(10, 2), deltaY: -120 }));
    pointerStep('40-wheel out', () => canvasEl.onwheel({ ...pointerEvent(10, 2), deltaY: 240 }));
    pointerStep('41-wheel to the clamp', () => { for (let i = 0; i < 60; i += 1) canvasEl.onwheel({ ...pointerEvent(10, 2), deltaY: -120 }); });
    pointerStep('42-fit the viewport again', () => api.fitStage6BishopViewport());

    // the three edit-mode selections
    pointerStep('43-add a surface load', () => { api.stage6BishopSetTool('load'); click(2, 4); click(6, 4); api.stage6BishopSetTool('edit'); });
    pointerStep('44-click the load', () => click(4, 4.1));
    pointerStep('45-click the wall', () => click(B().walls[0].head.x, 1));
    pointerStep('46-custom regions, then click one', () => { api.stage6BishopCopyCurrentRegionsToCustom(); api.stage6BishopSetUseCustomRegions(true); click(4, 1); });
    pointerStep('47-click empty space (starts a pan)', () => down(19.5, -8));
    pointerStep('48-release the pan', () => up(19.5, -8));

    // the measure tool, and a right click with nothing to complete
    pointerStep('49-measure two points', () => { api.stage6BishopSetTool('measure'); click(2, 3); click(15, 0.5); });
    pointerStep('50-right click with no draft', () => click(10, 1, 2));
    pointerStep('51-clear the measurement', () => G.stage6BishopClearMeasurement());
  } finally { unseedIds(); }
  dump.pointerIdEvents = idEvents.length - pointerIdEventsBefore;

  // ═════════════════════ (c) N frames leave the state byte-identical ═════════════════════
  {
    const scenarios = [
      ['synced', () => {}],
      ['layers changed underneath', () => { const l = S().layers?.[0]; if (l) l.top = (Number(l.top) || 0) + 0.25; }],
      ['strength set changed underneath', () => { B().strengthSet = B().strengthSet === 'da1_1' ? 'characteristic' : 'da1_1'; }],
      ['hover on', () => { G.stage6BishopCanvasState.hoverWorld = { x: 10, y: 2 }; }],
      ['edit tool with a selection', () => { api.stage6BishopSetTool('edit'); B().selectedWallId = B().walls?.[0]?.id ?? null; }]
    ];
    for (const [label, setup] of scenarios) {
      setup();
      const before = ser(B());
      const shas = [];
      for (let i = 0; i < 8; i += 1) { const f = frame(`${label}#${i}`); shas.push(f.sha); }
      dump.purity.push({ label, unchanged: ser(B()) === before, identicalFrames: new Set(shas).size, before: sha(before), after: sha(ser(B())) });
    }
    api.renderStage6();
  }

  // ═════════════════════ (d) the package standalone (working tree only) ═════════════════════
  if (pure) {
    const canvas = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/canvas/index.js');
    const viewport = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/canvas/viewport.js');
    const picking = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/canvas/picking.js');
    const pointer = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/canvas/pointer.js');
    const viewModel = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/canvas/view-model.js');
    const draw = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/canvas/draw/index.js');

    dump.pure.namespaces = ['viewport', 'picking', 'pointer', 'viewModel', 'draw'].map((n) => [n, typeof canvas[n] === 'object' && canvas[n] !== null]);
    dump.pure.layerOrder = draw.DRAW_LAYERS.map(([name]) => name);
    dump.pure.layerFns = draw.DRAW_LAYERS.every(([, fn]) => typeof fn === 'function');
    dump.pure.canvasKeys = Object.keys(canvas).sort();

    // the viewport round-trips, and every tolerance is the monolith's literal at every scale
    const VP = { scale: 24, offsetX: 100, offsetY: 300, fitted: true };
    dump.pure.viewport = {
      roundTrip: [{ x: 0, y: 0 }, { x: 3.5, y: -2.25 }, { x: -10, y: 7 }].map((p) => {
        const s = viewport.worldToScreen(p, VP);
        const w = viewport.screenToWorld(s.x, s.y, VP);
        return [ser(p), ser(s), ser(w), Math.abs(w.x - p.x) < 1e-12 && Math.abs(w.y - p.y) < 1e-12];
      }),
      tolerances: [0, 1, 8, 24, 220, NaN, undefined].map((scale) => [
        String(scale),
        viewport.snapToleranceWorld({ scale }),
        viewport.boundaryPickToleranceWorld({ scale }),
        viewport.surfaceLoadPickHeightWorld({ scale }),
        viewport.measurementLabelOffsetWorld({ scale })
      ]).concat([['noViewport', viewport.snapToleranceWorld(null), viewport.boundaryPickToleranceWorld(undefined), viewport.surfaceLoadPickHeightWorld(null), viewport.measurementLabelOffsetWorld(undefined)]]),
      zoomKeepsThePointUnderTheCursor: (() => {
        const before = viewport.screenToWorld(240, 160, VP);
        const next = { ...VP, ...viewport.zoomAtPoint(VP, 240, 160, -120) };
        const after = viewport.screenToWorld(240, 160, next);
        return [Math.abs(after.x - before.x) < 1e-9, Math.abs(after.y - before.y) < 1e-9, next.scale];
      })(),
      fit: ser(viewport.fitViewport({ minX: 0, maxX: 20, minY: -10, maxY: 5 }, 800, 400)),
      fitFloor: ser(viewport.fitViewport({ minX: 0, maxX: 1000, minY: 0, maxY: 1000 }, 100, 100)),
      grid: [1, 5, 0.01].map((step) => ser(viewport.gridSpec(VP, 800, 400, step))),
      bounds: ser(viewport.canvasWorldBounds({ terrain: [], walls: [], drains: [] }, null))
    };

    // the controller names are the package's own function objects
    const ALIASES = [
      ['worldToScreen', 'stage6BishopWorldToScreen'], ['snapToleranceWorld', 'stage6BishopSnapToleranceWorld'],
      ['canvasWorldBounds', 'stage6BishopCanvasWorldBounds'], ['collectSnapPoints', 'stage6BishopCollectSnapPoints'],
      ['snapWorldPoint', 'stage6BishopSnapWorldPoint'], ['nearestHandle', 'stage6BishopNearestHandle'],
      ['pickSurfaceLoadAtWorld', 'stage6BishopPickSurfaceLoadAtWorld'], ['pickWallAtWorld', 'stage6BishopPickWallAtWorld'],
      ['commitDrawPoint', 'stage6BishopCommitDrawPoint'], ['pointerDown', 'stage6BishopPointerDown']
    ];
    dump.pure.facades = ALIASES.map(([pkg, ctrl]) => [pkg, ctrl, typeof G[ctrl] === 'function', typeof canvas[pkg] === 'function']);
    // Every canvas name reads `S`, the canvas element or the drag state, so none of them can be a
    // bare import alias the way the geometry package's 29 pure names were. What is checkable is
    // that each façade is exactly its package function applied to the host's state.
    dump.pure.delegation = [
      ['snapToleranceWorld', G.stage6BishopSnapToleranceWorld(), viewport.snapToleranceWorld(B().viewport)],
      ['boundaryPickToleranceWorld', G.stage6BishopBoundaryPickToleranceWorld(), viewport.boundaryPickToleranceWorld(B().viewport)],
      ['worldToScreen', ser(G.stage6BishopWorldToScreen({ x: 3, y: 2 })), ser(viewport.worldToScreen({ x: 3, y: 2 }, B().viewport))],
      ['canvasWorldBounds', ser(G.stage6BishopCanvasWorldBounds(null)), ser(viewport.canvasWorldBounds(B(), null))],
      ['collectSnapPoints', ser(G.stage6BishopCollectSnapPoints()), ser(picking.collectSnapPoints(B(), ''))],
      ['snapWorldPoint', ser(G.stage6BishopSnapWorldPoint({ x: 4.13, y: 2.07 }, 'free')), ser(picking.snapWorldPoint({ x: 4.13, y: 2.07 }, 'free', B(), B().viewport, ''))],
      ['pickWallAtWorld', ser(G.stage6BishopPickWallAtWorld({ x: 9, y: 1 })?.id ?? null), ser(picking.pickWallAtWorld(B(), { x: 9, y: 1 }, B().viewport)?.id ?? null)],
      ['pickSurfaceLoadAtWorld', ser(G.stage6BishopPickSurfaceLoadAtWorld({ x: 4, y: 4 })?.id ?? null), ser(picking.pickSurfaceLoadAtWorld(B(), { x: 4, y: 4 }, B().viewport)?.id ?? null)],
      ['currentDragKey', G.stage6BishopCurrentDragKey(), picking.currentDragKey(G.stage6BishopCanvasState.pointerDrag)],
      ['snapPointKey', G.stage6BishopSnapPointKey('wallTop', 1, null), picking.snapPointKey('wallTop', 1, null)]
    ];

    // the view model never mutates its input, and its shape is stable
    const bishopCopy = clone(B());
    const bishopText = ser(bishopCopy);
    const envCalls = [];
    const stubEnv = new Proxy({}, { get: (t, k) => (...a) => { envCalls.push(String(k)); return k === 'normalizedDeformationAnalysisType' ? 'deformation' : null; } });
    const vmOut = viewModel.buildCanvasViewModel({
      bishop: bishopCopy, model: clone(S().stage6Cache.bishopModel ?? null), viewport: clone(bishopCopy.viewport),
      width: 800, height: 400, hoverWorld: { x: 5, y: 1 }, excludeKey: ''
    }, stubEnv);
    dump.pure.viewModel = {
      untouched: ser(bishopCopy) === bishopText,
      keys: Object.keys(vmOut).sort(),
      envCalls: envCalls.slice().sort(),
      workspace: vmOut.workspace,
      gridShow: vmOut.grid.show,
      handleCount: (viewModel.handlePoints(bishopCopy) || []).length
    };

    // the pointer machine's effect log: what it asked the host to do, in order
    const effectRuns = [];
    const runMachine = (label, fn) => {
      const calls = [];
      const env = new Proxy({}, {
        get: (t, k) => (...a) => {
          calls.push(String(k));
          if (k === 'model') return null;
          if (k === 'selectedCustomRegion') return null;
          if (k === 'seepageBoundary') return [];
          if (k === 'pickSeepageBoundaryEdge') return null;
          if (k === 'createDrainFromVertices') return false;
          if (k === 'wallId') return 'wall_test';
          if (k === 'defaultPassiveSide') return 'right';
          if (k === 'defaultWallMaterial') return { id: 'm' };
          if (k === 'regionAtInModel') return null;
          return undefined;
        }
      });
      const state = clone(B());
      const canvasState = { canvas: null, pointerDrag: null, hoverWorld: null };
      const ctx = { bishop: state, viewport: state.viewport, canvasState, rect: () => ({ left: 0, top: 0, width: 800, height: 400 }) };
      const effects = fn(ctx, env);
      effectRuns.push([label, ser(effects), calls.join('|'), ser(canvasState.pointerDrag)]);
    };
    runMachine('down: draw tool', (ctx, env) => { ctx.bishop.tool = 'terrain'; return pointer.pointerDown(ctx, { button: 0, clientX: 100, clientY: 100, pointerId: 1 }, env); });
    runMachine('down: middle button pans', (ctx, env) => pointer.pointerDown(ctx, { button: 1, clientX: 100, clientY: 100, pointerId: 1 }, env));
    runMachine('down: right button completes', (ctx, env) => pointer.pointerDown(ctx, { button: 2, clientX: 100, clientY: 100, pointerId: 1 }, env));
    runMachine('move: no drag', (ctx, env) => pointer.pointerMove(ctx, { clientX: 100, clientY: 100, pointerId: 1 }, env));
    runMachine('up: no drag', (ctx, env) => pointer.pointerUp(ctx, { clientX: 100, clientY: 100, pointerId: 1 }, env));
    runMachine('leave', (ctx, env) => pointer.pointerLeave(ctx, env));
    runMachine('wheel', (ctx, env) => pointer.wheel(ctx, { clientX: 100, clientY: 100, deltaY: -120 }, env));
    dump.pure.effects = effectRuns;
    dump.pure.cancelIsUp = pointer.pointerCancel === pointer.pointerUp;
    dump.pure.tipLayout = ser(pointer.TIP_LAYOUT);
    dump.pure.viewportLimits = ser(viewport.VIEWPORT_LIMITS);

    // picking is pure: the whole grid must not touch the block it is handed
    const pickCopy = clone(B());
    const pickText = ser(pickCopy);
    for (const mode of ['free', 'terrain-x']) {
      for (const p of [{ x: 0, y: 0 }, { x: 5, y: 2 }, { x: -3, y: 9 }]) {
        picking.snapWorldPoint(p, mode, pickCopy, pickCopy.viewport, '');
        picking.nearestPointSnap(p, mode, pickCopy, pickCopy.viewport, '');
      }
      picking.collectSnapPoints(pickCopy, '');
      picking.pickSurfaceLoadAtWorld(pickCopy, { x: 4, y: 4 }, pickCopy.viewport);
      picking.pickWallAtWorld(pickCopy, { x: 9, y: 1 }, pickCopy.viewport);
      picking.nearestHandle(pickCopy, pickCopy.viewport, { left: 0, top: 0 }, 200, 100, null);
    }
    dump.pure.pickingImmutable = ser(pickCopy) === pickText;
    dump.pure.dragKeys = [
      picking.currentDragKey(null),
      picking.currentDragKey({ kind: 'terrain', index: 2 }),
      picking.currentDragKey({ kind: 'drainVertex', index: 0, vertexIndex: 1, regionId: 'drain_1' }),
      picking.currentDragKey({ kind: 'loadStart', loadId: 'load-1' }),
      picking.snapPointKey('terrain', 2, null),
      picking.snapPointKey('drainVertex', 1, 'drain_1')
    ];
  }

  dump.maskedModelKeys = [...maskedModelKeys].sort();
  writeFileSync(outPath, JSON.stringify(dump));
  await server.close();
  process.exit(0);
}

// ═══════════════════════════════ parent: run + compare ═══════════════════════════════
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
/** Where two draw logs first diverge: the chunk index, then the head text if it is in range. */
function frameDiff(o, n) {
  if (o.calls !== n.calls) return `call count ${o.calls} → ${n.calls}`;
  if (o.chars !== n.chars) return `log length ${o.chars} → ${n.chars} chars`;
  const counts = firstDiff(JSON.stringify(o.counts), JSON.stringify(n.counts));
  if (counts) return `method counts: ${counts}`;
  for (let i = 0; i < Math.max(o.chunks.length, n.chunks.length); i += 1) {
    if (o.chunks[i] !== n.chunks[i]) {
      const head = firstTextDiff(o.head, n.head);
      return `first differing chunk #${i} (calls ${i * 100}…${i * 100 + 99})${head ? `; head ${head}` : '; the divergence is past the recorded head'}`;
    }
  }
  return firstTextDiff(o.head, n.head) || firstTextDiff(o.tail, n.tail) || 'sha differs but every chunk matches (?)';
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-seepslope-canvas-'));
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

// ── (a) the draw-call log ────────────────────────────────────────────────────────────────
console.log(`\n(a) the draw-call log — ${newDump.frames.length} frames`);
check('(a) same frame list', JSON.stringify(oldDump.frames.map((f) => f.label)) === JSON.stringify(newDump.frames.map((f) => f.label)),
  firstTextDiff(JSON.stringify(oldDump.frames.map((f) => f.label)), JSON.stringify(newDump.frames.map((f) => f.label))));
let totalCalls = 0, drawnFrames = 0;
newDump.frames.forEach((n, i) => {
  const o = oldDump.frames[i] || {};
  totalCalls += n.calls;
  if (n.calls > 0) drawnFrames += 1;
  check(`frame ${n.label}: ${n.calls} draw calls, byte-identical`, o.sha === n.sha && o.error === n.error, frameDiff(o, n));
  check(`frame ${n.label}: same cached model`, o.model === n.model, `${o.model} → ${n.model}`);
});
console.log(`       ${totalCalls} recorded draw calls over ${drawnFrames} frames`);
check(`(a) the only model keys masked as wall-clock are ${JSON.stringify(newDump.maskedModelKeys)}`,
  JSON.stringify(oldDump.maskedModelKeys) === JSON.stringify(newDump.maskedModelKeys)
  && newDump.maskedModelKeys.every((k) => /(?:Ms|^ms)$/.test(k) && !/^max/.test(k)),
  `${JSON.stringify(oldDump.maskedModelKeys)} → ${JSON.stringify(newDump.maskedModelKeys)}`);
check(`(a) the matrix actually drew (> 200 000 calls over ${drawnFrames} frames)`, totalCalls > 200000, String(totalCalls));
check('(a) no frame raised a rAF error', newDump.frames.every((f) => f.rafErrors.length === 0), JSON.stringify(newDump.frames.filter((f) => f.rafErrors.length).map((f) => [f.label, f.rafErrors])).slice(0, 400));
check(`(a) the wall-response overlay was painted (the base fixture carries ${newDump.deformationWallResults} wall results of its own, so the matrix injects one)`,
  newDump.frames.some((f) => /37b-wall-response-M/.test(f.label) && f.calls > 0) && oldDump.deformationWallResults === newDump.deformationWallResults,
  String(newDump.deformationWallResults));
check('(a) no frame threw', newDump.frames.every((f) => !f.error || f.label.endsWith('Error')), JSON.stringify(newDump.frames.filter((f) => f.error && !f.label.endsWith('Error')).map((f) => [f.label, f.error])).slice(0, 400));
{
  const solved = newDump.frames.filter((f) => /solved-(seepage|deformation|search)/.test(f.label));
  check(`(a) the three solved workspaces were reached and drew (${solved.length} frames, ${solved.reduce((s, f) => s + f.calls, 0)} calls)`,
    solved.length >= 12 && solved.every((f) => f.calls > 100), JSON.stringify(solved.map((f) => [f.label, f.calls])).slice(0, 400));
  const colours = new Set();
  for (const f of newDump.frames) for (const m of f.head.matchAll(/^(?:fillStyle|strokeStyle)=("[^"]*")$/gm)) colours.add(m[1]);
  check(`(a) the recorded logs carry ${colours.size} distinct fill / stroke colours (the theme is observable)`, colours.size >= 12, [...colours].slice(0, 12).join(' '));
}

// ── (b) the pointer state machine ────────────────────────────────────────────────────────
console.log(`\n(b) the pointer state machine — ${newDump.pointer.length} events`);
check('(b) same event list', JSON.stringify(oldDump.pointer.map((p) => p.label)) === JSON.stringify(newDump.pointer.map((p) => p.label)));
newDump.pointer.forEach((n, i) => {
  const o = oldDump.pointer[i] || {};
  check(`pointer ${n.label}: same exception`, o.error === n.error, `${o.error} → ${n.error}`);
  check(`pointer ${n.label}: S.stage6.bishop deep-equal + key order`, o.bishop === n.bishop, firstDiff(o.bishop, n.bishop));
  check(`pointer ${n.label}: canvas state + DOM + draw log`,
    o.ui === n.ui && o.drag === n.drag && o.hoverWorld === n.hoverWorld && JSON.stringify(o.captures) === JSON.stringify(n.captures)
    && JSON.stringify(o.tip) === JSON.stringify(n.tip) && o.coord === n.coord && o.drawSha === n.drawSha && o.drawCalls === n.drawCalls
    && JSON.stringify(o.alerts) === JSON.stringify(n.alerts) && JSON.stringify(o.rafErrors) === JSON.stringify(n.rafErrors) && o.idEvents === n.idEvents,
    firstDiff(JSON.stringify([o.ui, o.drag, o.hoverWorld, o.captures, o.tip, o.coord, o.drawSha, o.drawCalls, o.alerts, o.rafErrors, o.idEvents]),
      JSON.stringify([n.ui, n.drag, n.hoverWorld, n.captures, n.tip, n.coord, n.drawSha, n.drawCalls, n.alerts, n.rafErrors, n.idEvents])));
});
check(`(b) the same number of id allocations (${newDump.pointerIdEvents})`, oldDump.pointerIdEvents === newDump.pointerIdEvents,
  `${oldDump.pointerIdEvents} → ${newDump.pointerIdEvents}`);
{
  const by = (frag) => newDump.pointer.find((p) => p.label.includes(frag)) || {};
  const parse = (p) => { try { return JSON.parse(p.bishop); } catch { return {}; } };
  check('(b) the region tool really added a custom polygon', (parse(by('09-region close')).customRegions || []).length > 0,
    String((parse(by('09-region close')).customRegions || []).length));
  check('(b) the wall tool really added a wall', (parse(by('17-wall click 2')).walls || []).length > 0);
  check('(b) the handle drag really moved the wall head', ser2(parse(by('19-grab')).walls?.[0]?.head) !== ser2(parse(by('21-release')).walls?.[0]?.head),
    `${ser2(parse(by('19-grab')).walls?.[0]?.head)} → ${ser2(parse(by('21-release')).walls?.[0]?.head)}`);
  check('(b) a drag ends with no drag left and the capture released',
    by('21-release').drag === 'null' && JSON.stringify(by('21-release').captures) === JSON.stringify([['release', 1]]),
    `${by('21-release').drag} ${JSON.stringify(by('21-release').captures)}`);
  check('(b) a click-without-drag on a handle keeps the solved seepage result',
    parse(by('23-click a handle')).seepage?.status === 'success', String(parse(by('23-click a handle')).seepage?.status));
  check('(b) pointercancel mid-drag ends the drag (the monolith binds it to pointerup)',
    by('34-pointercancel').drag === 'null' && by('35-a move after the cancel').drag === 'null');
  check('(b) snapping really snapped a click onto a terrain vertex',
    (parse(by('26-click just off the terrain start')).draft || []).some((p) => Math.abs(p.x - 0) < 1e-9 && Math.abs(p.y - 4) < 1e-9),
    JSON.stringify(parse(by('26-click just off the terrain start')).draft));
  check('(b) the wheel clamps the scale at 220 px/m', Math.abs((parse(by('41-wheel to the clamp')).viewport?.scale ?? 0) - 220) < 1e-9,
    String(parse(by('41-wheel to the clamp')).viewport?.scale));
  check('(b) panning moved the viewport offsets', ser2(parse(by('36-middle-button')).viewport) !== ser2(parse(by('38-pan up')).viewport));
  check('(b) the three edit-mode selections landed',
    !!parse(by('44-click the load')).selectedSurfaceLoadId && !!parse(by('45-click the wall')).selectedWallId && !!parse(by('46-custom regions')).selectedRegionId,
    JSON.stringify([parse(by('44-click the load')).selectedSurfaceLoadId, parse(by('45-click the wall')).selectedWallId, parse(by('46-custom regions')).selectedRegionId]));
  check('(b) a hover over the section wrote the readout and a hover off it did not show a tip',
    /^x = /.test(by('01-hover over the section').coord) && by('03-pointer leave').coord === '' && by('03-pointer leave').tip.display === 'none',
    JSON.stringify([by('01-hover over the section').coord, by('03-pointer leave').coord, by('03-pointer leave').tip.display]));
}
function ser2(v) { return JSON.stringify(v ?? null); }

// ── (c) the draw path does not write ─────────────────────────────────────────────────────
console.log(`\n(c) the draw path does not write — ${newDump.purity.length} scenarios × 8 frames`);
newDump.purity.forEach((n, i) => {
  const o = oldDump.purity[i] || {};
  check(`purity ${n.label}: 8 frames leave S.stage6.bishop byte-identical`, n.unchanged === true, `${n.before} → ${n.after}`);
  check(`purity ${n.label}: the 8 frames are identical to each other`, n.identicalFrames === 1, `${n.identicalFrames} distinct frames`);
  check(`purity ${n.label}: the base agrees`, o.unchanged === n.unchanged && o.identicalFrames === n.identicalFrames,
    `base ${o.unchanged}/${o.identicalFrames} → tree ${n.unchanged}/${n.identicalFrames}`);
});

// ── (d) the package standalone ───────────────────────────────────────────────────────────
console.log('\n(d) the package standalone (working tree)');
const P = newDump.pure;
check('(d) the index exposes the five namespaces', P.namespaces.every(([, ok]) => ok), JSON.stringify(P.namespaces));
check(`(d) the fourteen layers are sequenced in the documented order (${P.layerOrder.length} entries)`,
  JSON.stringify(P.layerOrder) === JSON.stringify(['background', 'grid', 'regions', 'seepage', 'deformation', 'phreatic', 'drains', 'draft', 'hover', 'zonesAndLoads', 'walls', 'wallResponses', 'measurement', 'slipCircles', 'terrain', 'boundaryConditions', 'cptMarker', 'editHandles']),
  JSON.stringify(P.layerOrder));
check('(d) every layer is a function', P.layerFns === true);
check('(d) every monolith canvas name survives, and the package exports its body', P.facades.every(([, , isFn, isPkgFn]) => isFn && isPkgFn),
  JSON.stringify(P.facades.filter(([, , isFn, isPkgFn]) => !isFn || !isPkgFn)));
check(`(d) each façade is its package function applied to the host state (${P.delegation.length} names)`,
  P.delegation.every(([, viaFacade, viaPackage]) => JSON.stringify(viaFacade) === JSON.stringify(viaPackage)),
  JSON.stringify(P.delegation.filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b))).slice(0, 400));
check('(d) world → screen → world round-trips exactly', P.viewport.roundTrip.every(([, , , ok]) => ok), JSON.stringify(P.viewport.roundTrip));
check('(d) the snap tolerance is 14 px / scale with the monolith\'s `|| 24` and `max(…, 1)` fallbacks',
  P.viewport.tolerances.every(([label, snap, pick]) => snap === pick && snap > 0)
  && P.viewport.tolerances.find(([l]) => l === '24')[1] === 14 / 24
  && P.viewport.tolerances.find(([l]) => l === '0')[1] === 14 / 24
  && P.viewport.tolerances.find(([l]) => l === 'NaN')[1] === 14 / 24
  && P.viewport.tolerances.find(([l]) => l === '1')[1] === 14,
  JSON.stringify(P.viewport.tolerances));
check('(d) zooming keeps the world point under the cursor', P.viewport.zoomKeepsThePointUnderTheCursor[0] && P.viewport.zoomKeepsThePointUnderTheCursor[1],
  JSON.stringify(P.viewport.zoomKeepsThePointUnderTheCursor));
check('(d) fitViewport centres the box with a 28 px margin and never below 8 px/m',
  JSON.parse(P.viewport.fit).fitted === true && JSON.parse(P.viewport.fitFloor).scale === 8, `${P.viewport.fit} / ${P.viewport.fitFloor}`);
check('(d) the grid hides itself below 18 px spacing', JSON.parse(P.viewport.grid[2]).show === false && JSON.parse(P.viewport.grid[0]).show === true,
  P.viewport.grid.join(' '));
check('(d) canvasWorldBounds falls back to the monolith\'s empty box', P.viewport.bounds === '{"minX":0,"maxX":20,"minY":-10,"maxY":5}', P.viewport.bounds);
check('(d) the view model does not mutate the bishop block it is handed', P.viewModel.untouched === true);
check(`(d) the view model exposes its ${P.viewModel.keys.length} derivations`, P.viewModel.keys.length >= 20, JSON.stringify(P.viewModel.keys));
check('(d) picking never mutates the bishop block', P.pickingImmutable === true);
check('(d) the drag keys are the monolith\'s strings',
  JSON.stringify(P.dragKeys) === JSON.stringify(['', 'terrain::2', 'drainVertex:drain_1:1', 'loadStart:load-1:', 'terrain::2', 'drainVertex:drain_1:1']),
  JSON.stringify(P.dragKeys));
check('(d) pointercancel is the very same transition as pointerup', P.cancelIsUp === true);
check('(d) the pointer machine logs the effects it asked for', P.effects.length === 7 && P.effects.every(([, effects]) => typeof effects === 'string'),
  JSON.stringify(P.effects.map(([l, e, c]) => [l, e, c])).slice(0, 600));
{
  const byLabel = Object.fromEntries(P.effects.map(([l, e, c, drag]) => [l, { e, c, drag }]));
  check('(d) `down` with the middle button previews the pan and takes the capture',
    /preventDefault/.test(byLabel['down: middle button pans'].e) && /setPointerCapture/.test(byLabel['down: middle button pans'].c)
    && JSON.parse(byLabel['down: middle button pans'].drag).kind === 'pan',
    JSON.stringify(byLabel['down: middle button pans']));
  check('(d) `move` without a drag only refreshes the hover', byLabel['move: no drag'].c === 'updateHover', byLabel['move: no drag'].c);
  check('(d) `up` without a drag does nothing at all', byLabel['up: no drag'].c === '' && byLabel['up: no drag'].e === '[]', JSON.stringify(byLabel['up: no drag']));
  check('(d) `leave` hides the hover and redraws', byLabel.leave.c === 'hideHover|draw', byLabel.leave.c);
  check('(d) `wheel` prevents the default and redraws', byLabel.wheel.c === 'draw' && /preventDefault/.test(byLabel.wheel.e), JSON.stringify(byLabel.wheel));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures) console.log(`  - ${f}`); }
process.exit(fail ? 1 : 0);
