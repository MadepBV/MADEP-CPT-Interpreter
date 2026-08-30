#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 9g / PR 18g (worklog/refactor/29-pr18g-seepslope-report.md): the
// Stage 7 workspace capture moved out of legacy-controller.js into
// src/lib/cpt-app/seepslope/report/capture.js and now rasterises the Seep / Slope frame to an
// **offscreen** canvas instead of switching the Stage 6 app / bishop workspace, re-rendering and
// photographing the live canvas (01-monolith-map.md §3.4 #10, §6.3 item 7).
//
// Pattern of scripts/verify_seepslope_{state,model,run,geometry,canvas,panels}.mjs: the controller
// of a base ref (default `integration-r`) and the working-tree controller are each loaded under
// Node through the Tier-B loader in their own child process, dump the same observations to JSON,
// and the parent compares the two dumps byte for byte. Both controllers are materialised as a copy
// with the *same* appended `export { … }` block, so the moved functions — module-local in the base,
// façades in the working tree — are directly comparable.
//
// How a **data URL** is compared under Node
// -----------------------------------------
// There is no rasteriser in Node, so this verifier gives both controllers a canvas whose 2D context
// **records** every call and every property assignment in order (the device
// verify_seepslope_canvas.mjs introduced: "the paint *is* the sequence of calls the context
// receives"), and whose `toDataURL(mimeType, quality)` returns a digest of everything that
// determines the encoded image:
//
//     data:<mimeType>;q=<quality>;w=<width>;h=<height>;calls=<n>;sha256=<sha of the call log>
//
// `drawImage(source, …)` records the *source canvas' own* call-log digest, so the down-scale step
// carries the whole painted frame into the final digest: two byte-identical data URLs here mean the
// two controllers issued exactly the same context calls, in the same order, with the same arguments,
// on canvases of the same size, and asked for the same encoding. The **pixels** are proved
// separately in a real browser (report 29 §5.2), which is where a JPEG can actually be encoded.
//
// Both `#stage6BishopCanvas` and every `document.createElement('canvas')` get `HTMLCanvasElement` on
// their prototype, so the monolith's `instanceof` guard passes in both controllers and the base
// really does take its "switch the app, re-render, read the live canvas" path.
//
//   (a) the capture itself — `stage7CaptureBishopWorkspaceView(ws)` over the seeded `loadDemo()`
//       CPT and the first CPT of the three project fixtures, in the states that produce an annex
//       (a real solved Bishop search, a real solved seepage field, a solved deformation field),
//       for all three workspaces × three host states: the app already on that workspace, the app on
//       a *different* workspace (what used to switch `bishop.workspace`) and the app not on Bishop
//       at all (what used to switch `S.stage6.app` and re-render twice). Compared: the whole
//       returned view — workspace, app, capturedAt, display, viewport and
//       image {mimeType, width, height, dataUrl}.
//   (b) `buildStage7Payload()` byte-identical in every one of those host states, with and without a
//       stored manual capture (the payload prefers the manual one and only then calls the automatic
//       capture, so both branches are exercised).
//   (c) the state after a capture: `S.stage6` deep-equal to before, and `S.stage6.app` /
//       `bishop.workspace` unchanged. Per the PLAN §6 verifier convention this is asserted as **the
//       working tree is clean, and the base either shows the defect or already carries the fix** —
//       the case actually seen is printed.
//   (d) the manual capture button (`stage7CaptureWorkspaceView`), which writes `S.stage6` and
//       re-renders on purpose: `bishop.capturedView` identical in both controllers.
//   (e) working tree only: the package standalone — the offscreen frame is the *same draw* as
//       `stage6BishopDrawCanvas` for that workspace, `renderWorkspaceFrame` does not mutate the
//       block or the model it is handed, the two display projections keep their key order, the
//       down-scale arithmetic, the measurement probe's classes are the layout's own, and
//       `report/deps.js` builds the same capture from `over.captureHost`.
//
// Usage
//   node scripts/verify_seepslope_report.mjs                    compare against integration-r
//   node scripts/verify_seepslope_report.mjs --base <ref>       compare against another git ref
//   node scripts/verify_seepslope_report.mjs --snapshot f.json  dump the working tree only
//   node scripts/verify_seepslope_report.mjs --against f.json   compare the working tree with a dump
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-seepslope-report-base.legacy-controller.js';
const TREE_REL = 'src/lib/cpt-app/__verify-seepslope-report-tree.legacy-controller.js';
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
// The bishop golden suite's section and reduced search grid (scripts/golden/suites/bishop.mjs).
const CPT_TERRAIN = { terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], entryZone: { xStart: 1, xEnd: 5 }, exitZone: { xStart: 13, xEnd: 19 } };
const CPT_SEARCH = { nEntry: 4, nExit: 4, nCenter: 6, centerOffsetMin: 0.5, centerOffsetMax: 3, minChordLength: 2, minSlipThickness: 0.75, maxExitAngleDeg: 45, validationSamples: 30, geomTol: 0.001, minSliceWidth: 0.05, targetSlices: 30, keepBest: 3 };
const WORKSPACES = ['stability', 'seepage', 'deformation'];
// The three host states the monolith's capture branched on: same workspace (no switch), another
// workspace (bishop.workspace written), another Stage 6 app (S.stage6.app written + two renders).
const HOSTS = [
  { id: 'same-workspace', app: 'bishop', workspace: null },
  { id: 'other-workspace', app: 'bishop', workspace: 'stability' },
  { id: 'other-app', app: 'bearing', workspace: null }
];
const FROZEN_ISO = '2026-08-30T09:00:00.000Z';

/** Exports appended to a copy of *both* controllers so the capture region can be called directly. */
const EXPORT_BLOCK = `
/* ── appended by scripts/verify_seepslope_report.mjs (PR 18g) — exports only ── */
export {
  stage7CaptureCanvasImage,
  stage7CaptureWorkspaceView,
  stage7ClearWorkspaceCapture,
  stage7CaptureBishopWorkspaceView,
  stage7ControllerDeps,
  buildStage7Payload,
  stage6BishopDrawCanvas,
  stage6BishopCanvasState,
  stage6BishopCommitDrawPoint,
  stage6BishopUiState,
  stage6BishopCurrentModel,
  stage6WorkingLayers,
  SEEPSLOPE_CANVAS_ENV,
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
  const sha = (s) => createHash('sha256').update(s).digest('hex');

  // ── the recording canvas ───────────────────────────────────────────────────────────────
  // One class for the on-screen canvas and for every offscreen one the capture creates. Method
  // calls return the DOM stub's `{width: 0}` so `ctx.measureText(t).width` keeps reading 0, and
  // every property *get* is a function so `typeof ctx.roundRect === 'function'` stays true.
  const num = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? (Object.is(v, -0) ? '0' : String(v)) : String(v)) : null);
  const arg = (v) => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (v && v.__recordingCanvas) return `canvas(${v.width}x${v.height},${sha(v.__log.join('\n')).slice(0, 24)})`;
    const n = num(v);
    if (n !== null) return n;
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `[${v.map(arg).join(',')}]`;
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };
  // `setTransform` delimits a frame: the host issues it exactly once, at the top of every frame
  // (`stage6BishopDrawCanvas` 4764-4810 and `renderWorkspaceFrame`), and nothing in
  // seepslope/canvas/** ever touches the transform. Recording it resets the log, so a canvas' log
  // is always **the calls that produced the pixels it holds now** — which is what makes a live
  // canvas drawn three times (the base re-renders) comparable with a freshly created offscreen one.
  const realCreateElement = stub.document.createElement;
  function attachRecorder(el, width, height) {
    const log = [];
    el.__recordingCanvas = true;
    el.__log = log;
    if (width !== undefined) el.width = width;
    if (height !== undefined) el.height = height;
    el.toDataURL = (mimeType = 'image/png', quality) => `data:${mimeType};q=${arg(quality)};w=${el.width};h=${el.height};calls=${log.length};sha256=${sha(log.join('\n'))}`;
    el.getContext = () => new Proxy({}, {
      get: (t, k) => {
        if (typeof k !== 'string') return undefined;
        if (k === 'canvas') return el;
        return (...a) => {
          if (k === 'setTransform') log.length = 0;
          log.push(`${k}(${a.map(arg).join(',')})`);
          return { width: 0 };
        };
      },
      set: (t, k, v) => { log.push(`${String(k)}=${arg(v)}`); return true; }
    });
    Object.setPrototypeOf(el, globalThis.HTMLCanvasElement.prototype);
    return el;
  }
  const makeRecordingCanvas = (width = 0, height = 0) => attachRecorder(realCreateElement('canvas'), width, height);
  stub.document.createElement = (tag) => (String(tag).toLowerCase() === 'canvas' ? makeRecordingCanvas() : realCreateElement(tag));
  // The live canvas: the element every getElementById('stage6BishopCanvas') hands back.
  const liveCanvas = attachRecorder(stub.document.getElementById('stage6BishopCanvas'));
  liveCanvas.parentElement = liveCanvas.parentNode = realCreateElement('div');
  // The re-render counter. The monolith's capture restored `S.stage6.app` / `bishop.workspace` in a
  // `finally`, so the *state* comes back — what it could not undo is the work: it rewrote
  // `#stage6Area` up to three times per capture (map §3.4 #10, "report generation is not
  // side-effect free"). Counting the writes is what actually separates the two controllers.
  const areaEl = stub.document.getElementById('stage6Area');
  let areaWrites = 0;
  let areaHtml = '';
  Object.defineProperty(areaEl, 'innerHTML', {
    get: () => areaHtml,
    set: (v) => { areaWrites += 1; areaHtml = String(v); },
    configurable: true
  });

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
  const RealDate = Date;
  const realNow = RealDate.now.bind(RealDate);
  const realRandom = Math.random;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, label, timeout = 30000) {
    const t0 = realNow();
    while (!pred()) { if (realNow() - t0 > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(5); }
  }
  const S = () => api.PROJECT.cpts[api.PROJECT.activeCptIdx];
  const B = () => S().stage6.bishop;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  // `max…Ms` is a configured budget, not a measurement — it stays compared.
  const TIMING_KEY = (k) => /(?:Ms|^ms)$/.test(k) && !/^max/.test(k);
  const maskedKeys = new Set();
  const ser = (v) => JSON.stringify(v, (k, x) => {
    if (typeof x === 'number' && TIMING_KEY(k)) { maskedKeys.add(k); return '<time>'; }
    return x === undefined ? '<undefined>' : (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x);
  });

  // Everything the capture stamps with the clock (`capturedAt`, the payload's `generatedAt`) runs
  // under a frozen `Date`, so the two child processes are comparable without masking the field.
  const FROZEN_MS = RealDate.parse(FROZEN_ISO);
  class FrozenDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(FROZEN_MS); else super(...a); }
    static now() { return FROZEN_MS; }
  }
  const frozen = (fn) => { globalThis.Date = FrozenDate; try { return fn(); } finally { globalThis.Date = RealDate; } };

  const dump = { controller: ctrlRel, captures: [], payloads: [], manual: [], pure: {} };

  // ── fixture helpers (same as verify_seepslope_{canvas,panels}.mjs) ──────────────────────
  function resetProject() {
    const P = api.PROJECT;
    P.cpts.splice(0, P.cpts.length, api.newCptState('CPT-1'));
    P.activeCptIdx = 0; P.sectionOrder = [0]; P.name = 'CPT Project'; P.phase = 'analysis'; P.stratigraphy = null;
    api.selectCpt(0);
  }
  let clockT = 1700000000000;
  const rng = mulberry32(0x5eed5eed);
  const seeded = (fn) => {
    Date.now = () => { clockT += 1000; return clockT; }; Math.random = () => rng();
    try { return fn(); } finally { Date.now = realNow; Math.random = realRandom; }
  };

  const { analyzeSeepageModel } = await server.ssrLoadModule('/src/lib/cpt-app/seepage/solver.js');
  const { analyzeDeformationModel } = await server.ssrLoadModule('/src/lib/cpt-app/deformation/solver.js');
  const deformationSuite = await server.ssrLoadModule('/scripts/golden/suites/deformation.mjs');
  const { analyzeBishopSearch } = await server.ssrLoadModule('/src/lib/cpt-app/stage6-bishop.js');
  const DEFORMATION_MODEL = JSON.parse(readFileSync(join(FIX, 'models/deformation-base.json'), 'utf8'));
  const DEFORMATION_OPTIONS = deformationSuite.baseOptions({ analysisType: 'deformation', meshElementType: 't3', meshTargetArea: 0.5, constitutiveModel: 'linear-elastic', useWasmCpuPipeline: false });
  const deformationOut = await analyzeDeformationModel({ model: clone(DEFORMATION_MODEL), options: DEFORMATION_OPTIONS });

  /** Draw the section, then solve all three analyses — the state in which an annex exists. */
  async function solveAll(label) {
    api.setStage6App('bishop');
    G.stage6BishopCanvasState.canvas = liveCanvas;
    api.stage6BishopClear('terrain');
    B().phreatic = []; B().drains = []; B().walls = []; B().surfaceLoads = []; B().customRegions = [];
    B().entryZone = null; B().exitZone = null; B().measurement = { points: [] };
    Object.assign(B(), clone(CPT_TERRAIN));
    B().phreatic = [{ x: 0, y: 1.5 }, { x: 10, y: 1.0 }, { x: 20, y: -0.5 }];
    // A short wall: deep enough to be drawn (and to carry a wall reaction on the circles it meets),
    // shallow enough that the search still finds circles — a 7 m wall makes every trial "stable by
    // wall alone" and the stability annex would never have a result to photograph.
    api.stage6BishopSetTool('wall');
    seeded(() => { G.stage6BishopCommitDrawPoint(liveCanvas, { x: 9, y: 4 }); G.stage6BishopCommitDrawPoint(liveCanvas, { x: 9, y: 3.2 }); });
    api.stage6BishopSetTool('edit');

    // The soil-model sync converges after a few passes (PLAN §6); render until the block is a
    // fixed point, so the base's capture-time re-render cannot legitimately change the model.
    api.stage6BishopSetWorkspace('stability');
    for (let i = 0; i < 4; i += 1) api.renderStage6();

    const errors = {};
    const model = S().stage6Cache.bishopModel;
    try {
      const b = B();
      const search = analyzeBishopSearch({
        model, entryZone: b.entryZone, exitZone: b.exitZone, methodMode: b.methodMode,
        searchConfig: { ...b.search, ...CPT_SEARCH }, solverConfig: { ...b.solver },
        spencerConfig: { ...b.spencer, recheckCount: 2 }, soilSource: 'regions'
      });
      if (search?.timing) search.timing = { totalMs: 1234.5, trialCount: search.timing.trialCount };
      b.results = search; b.selectedResult = 0;
    } catch (e) { errors.search = String(e?.message || e); }

    api.stage6BishopSetWorkspace('seepage');
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
    try {
      const seepageModel = S().stage6Cache.bishopModel;
      const out = await analyzeSeepageModel({ model: clone({ ...seepageModel, seepage: { ...(seepageModel.seepage || {}), mesh: null, result: null } }) });
      B().seepage.mesh = out.mesh; B().seepage.result = out.result;
      B().seepage.status = 'success'; B().seepage.stale = false; B().seepage.rejectReason = '';
    } catch (e) { errors.seepage = String(e?.message || e); }

    // The deformation field, written in as the run reducer writes it. Any option edit invalidates
    // it (seepslope/model/invalidate.js), so it is installed last and nothing is set afterwards.
    api.stage6BishopSetWorkspace('deformation');
    B().deformation.mesh = clone(deformationOut.mesh);
    B().deformation.result = clone(deformationOut);
    B().deformation.status = 'success'; B().deformation.stale = false; B().deformation.rejectReason = ''; B().deformation.warnings = [];
    api.stage6BishopSetWorkspace('stability');
    api.setStage6App('bishop');
    api.renderStage6();
    dump.captures.push({
      label: `${label}/solve-errors`, kind: 'errors',
      value: ser({ ...errors, results: B().results?.allResults?.length || 0, rejections: B().results?.rejectionCounts || null, seepage: B().seepage?.status, deformation: B().deformation?.status })
    });
    return errors;
  }

  /** Put the host in one of the three states the monolith's capture branched on. */
  function setHost(host, workspace) {
    api.setStage6App('bishop');
    api.stage6BishopSetWorkspace(host.workspace || workspace);
    if (host.app !== 'bishop') api.setStage6App(host.app);
    api.renderStage6();
  }

  /** One capture, with the state before and after it. */
  function capture(label, host, workspace) {
    setHost(host, workspace);
    const before = { stage6: ser(S().stage6), app: S().stage6.app, workspace: B().workspace, cptIdx: api.PROJECT.activeCptIdx, writes: areaWrites };
    let view = null, error = null;
    try { view = frozen(() => G.stage7CaptureBishopWorkspaceView(workspace)); } catch (e) { error = String(e?.message || e); }
    const after = { stage6: ser(S().stage6), app: S().stage6.app, workspace: B().workspace, cptIdx: api.PROJECT.activeCptIdx, writes: areaWrites };
    dump.captures.push({
      label, kind: 'capture', error,
      content: `${B().results?.allResults?.length || 0}/${B().seepage?.mesh && B().seepage?.result ? 1 : 0}/${B().deformation?.result ? 1 : 0}`,
      view: ser(view),
      dataUrl: view?.image?.dataUrl ?? null,
      imageMeta: view?.image ? ser({ mimeType: view.image.mimeType, width: view.image.width, height: view.image.height }) : null,
      stateChanged: before.stage6 !== after.stage6,
      appChanged: before.app !== after.app,
      workspaceChanged: before.workspace !== after.workspace,
      cptChanged: before.cptIdx !== after.cptIdx,
      renders: after.writes - before.writes
    });
    return view;
  }

  /** buildStage7Payload() in the same host state. */
  function payload(label) {
    const stateBefore = ser(S().stage6);
    const writesBefore = areaWrites;
    let value = null, error = null;
    try { value = frozen(() => api.buildStage7Payload()); } catch (e) { error = String(e?.message || e); }
    const text = ser(value);
    const chunks = [];
    for (let i = 0; i < text.length; i += 2000) chunks.push(sha(text.slice(i, i + 2000)).slice(0, 12));
    dump.payloads.push({
      label, error, chars: text.length, sha: sha(text), chunks, head: text.slice(0, 2400), tail: text.slice(-1200),
      renders: areaWrites - writesBefore, stateChanged: stateBefore !== ser(S().stage6)
    });
  }

  /** The whole matrix for one CPT. */
  async function fixtureMatrix(label) {
    await solveAll(label);
    for (const host of HOSTS) {
      for (const workspace of WORKSPACES) capture(`${label}/${host.id}/${workspace}`, host, workspace);
    }
    // the payload, without and with stored manual captures
    for (const host of HOSTS) {
      setHost(host, 'stability');
      payload(`${label}/${host.id}/payload-auto`);
    }
    // the manual capture button — writes S.stage6 and re-renders on purpose (unchanged behaviour)
    api.setStage6App('bishop');
    for (const workspace of WORKSPACES) {
      api.stage6BishopSetWorkspace(workspace);
      api.renderStage6();
      G.stage6BishopCanvasState.canvas = liveCanvas;
      G.stage6BishopDrawCanvas();
      frozen(() => api.stage7CaptureWorkspaceView(workspace));
      dump.manual.push({ label: `${label}/manual/${workspace}`, value: ser(B().capturedView) });
    }
    for (const host of HOSTS) {
      setHost(host, 'stability');
      payload(`${label}/${host.id}/payload-manual`);
    }
    // and back to no manual capture, so the next fixture starts clean
    api.setStage6App('bishop');
    for (const workspace of WORKSPACES) frozen(() => api.stage7ClearWorkspaceCapture(workspace));
    dump.manual.push({ label: `${label}/manual/cleared`, value: ser(B().capturedView) });
  }

  // ───────────────────────────── run the matrix ─────────────────────────────
  {
    resetProject();
    const saved = Math.random;
    Math.random = mulberry32(manifest.seed);
    try { api.loadDemo(); } finally { Math.random = saved; }
    await waitFor(() => S().data.length > 0, 'loadDemo');
    S().method = 'sb260';
    api.runClass();
    api.goS(3); api.goS(5);
    await fixtureMatrix('demo');
  }
  for (const fx of PROJECT_FIXTURES) {
    resetProject();
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, `projects/${fx}.madep.json`))], `${fx}.madep.json`));
    api.selectCpt(0);
    api.goS(3); api.goS(5);
    await fixtureMatrix(`${fx}#0`);
  }
  dump.maskedKeys = [...maskedKeys].sort();

  // ═════════════════════ (e) the package standalone (working tree only) ═════════════════════
  if (pure) {
    const P = {};
    const capturePkg = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/report/index.js');
    const panels = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/panels/index.js');
    const deps = await server.ssrLoadModule('/src/lib/cpt-app/report/deps.js');

    api.setStage6App('bishop');
    api.stage6BishopSetWorkspace('stability');
    api.renderStage6();
    const bishop = B();
    const model = S().stage6Cache.bishopModel;

    // 1. the offscreen frame is the same draw as the live one, for every workspace. The theme is
    // the host's own resolver, so the two frames are compared with identical colours; the draw log
    // carries every colour string, so a different theme would show up at once.
    const theme = (await server.ssrLoadModule('/src/lib/styles/theme.ts')).seepslopeVizSeries();
    P.sameDraw = WORKSPACES.map((workspace) => {
      api.stage6BishopSetWorkspace(workspace);
      api.renderStage6();
      G.stage6BishopCanvasState.canvas = liveCanvas;
      G.stage6BishopDrawCanvas();
      const live = liveCanvas.__log.join('\n');
      const off = capturePkg.renderWorkspaceFrame(
        { bishop: B(), model: S().stage6Cache.bishopModel },
        { workspace, width: 800, height: 400, dpr: 1 },
        { createCanvas: (w, h) => makeRecordingCanvas(w, h), theme, env: G.SEEPSLOPE_CANVAS_ENV }
      );
      const offText = off ? off.__log.join('\n') : '';
      return [workspace, live.length, offText.length, sha(live) === sha(offText)];
    });
    P.viewportFitted = B().viewport?.fitted === true;
    api.stage6BishopSetWorkspace('stability');

    // 2. purity: the frame does not write the block or the model it is handed
    {
      const beforeBishop = ser(B());
      const beforeModel = ser(S().stage6Cache.bishopModel);
      const a = capturePkg.renderWorkspaceFrame({ bishop: B(), model: S().stage6Cache.bishopModel }, { workspace: 'stability', width: 800, height: 400, dpr: 1 },
        { createCanvas: (w, h) => makeRecordingCanvas(w, h), theme, env: G.SEEPSLOPE_CANVAS_ENV });
      const b = capturePkg.renderWorkspaceFrame({ bishop: B(), model: S().stage6Cache.bishopModel }, { workspace: 'stability', width: 800, height: 400, dpr: 1 },
        { createCanvas: (w, h) => makeRecordingCanvas(w, h), theme, env: G.SEEPSLOPE_CANVAS_ENV });
      P.framePure = { bishop: ser(B()) === beforeBishop, model: ser(S().stage6Cache.bishopModel) === beforeModel, stable: sha(a.__log.join('\n')) === sha(b.__log.join('\n')) };
    }

    // 3. the two display projections and the workspace switch
    P.workspaceSwitch = ['stability', 'seepage', 'deformation', 'bishop', '', null, undefined, 'nonsense'].map((w) => [String(w), capturePkg.captureWorkspace(w)]);
    P.isCaptureWorkspace = ['stability', 'seepage', 'deformation', 'bishop', ''].map((w) => [w, capturePkg.isCaptureWorkspace(w)]);
    P.autoDisplay = WORKSPACES.map((w) => [w, ser(capturePkg.autoCaptureDisplay(bishop, w))]);
    P.manualDisplay = [...WORKSPACES, 'nonsense'].map((w) => [w, ser(capturePkg.manualCaptureDisplay(bishop, w))]);
    P.hasContent = WORKSPACES.map((w) => [w, capturePkg.workspaceHasContent(bishop, w), capturePkg.workspaceHasContent({}, w)]);

    // 4. the down-scale arithmetic of stage7CaptureCanvasImage
    P.rasterise = [[800, 400], [1400, 700], [2800, 1120], [3000, 1], [1, 1], [0, 0]].map(([w, h]) => {
      const src = makeRecordingCanvas(w, h);
      const out = capturePkg.rasteriseCanvas(src, { createCanvas: (a, b) => makeRecordingCanvas(a, b) });
      return [`${w}x${h}`, out ? `${out.width}x${out.height} ${out.mimeType}` : 'null'];
    });
    P.rasteriseNoFactory = capturePkg.rasteriseCanvas(makeRecordingCanvas(800, 400), {}) === null;
    P.imageDefaults = ser(capturePkg.CAPTURE_IMAGE_DEFAULTS);
    P.captureWorkspaces = ser(capturePkg.CAPTURE_WORKSPACES);

    // 5. the measurement probe uses the layout's own classes
    {
      const probe = capturePkg.bishopCanvasProbeHtml({ settingsWide: false });
      const wide = capturePkg.bishopCanvasProbeHtml({ settingsWide: true });
      const appHtml = String(stub.document.getElementById('stage6Area').innerHTML || '');
      P.probeClasses = ['mc2 st6-bishop', 'st6-bishop-layout', 'st6-bishop-layout--settings-collapsed',
        'st6-bishop-side st6-bishop-settings-panel', 'st6-bishop-main', 'st6-bishop-canvas-wrap',
        'st6-bishop-canvas-stage', 'st6-bishop-canvas'].map((cls) => [cls, probe.includes(cls), appHtml.includes(cls)]);
      P.probeWide = wide.includes('st6-bishop-layout--settings-wide') && !probe.includes('st6-bishop-layout--settings-wide');
      P.probeHasOneCanvas = (probe.match(/<canvas/g) || []).length === 1;
    }

    // 6. report/deps.js builds the same capture from over.captureHost
    {
      const host = {
        ensure: () => api.ensureStage6State(),
        box: () => ({ width: 800, height: 400, dpr: 1 }),
        model: () => S().stage6Cache.bishopModel,
        createCanvas: (w, h) => makeRecordingCanvas(w, h),
        theme, env: G.SEEPSLOPE_CANVAS_ENV
      };
      const viaDeps = deps.stage7Deps(S(), { captureHost: host }).captureBishopWorkspaceView;
      const viaPkg = capturePkg.bishopWorkspaceCapture(S(), host);
      P.depsCapture = WORKSPACES.map((w) => [w, ser(frozen(() => viaDeps(w))) === ser(frozen(() => viaPkg(w)))]);
      P.depsNoHost = deps.stage7Deps(S(), {}).captureBishopWorkspaceView('stability') === null;
      P.depsOverride = deps.stage7Deps(S(), { captureBishopWorkspaceView: () => 'override' }).captureBishopWorkspaceView('stability') === 'override';
      P.captureNoBlock = capturePkg.bishopWorkspaceCapture({}, host)('stability') === null;
      P.captureNoBox = capturePkg.bishopWorkspaceCapture(S(), { ...host, box: () => null })('stability') === null;
      P.captureNoCanvas = capturePkg.bishopWorkspaceCapture(S(), { ...host, createCanvas: () => null })('stability') === null;
    }

    // 7. the monolith names survive
    P.names = ['stage7CaptureCanvasImage', 'stage7CaptureWorkspaceView', 'stage7ClearWorkspaceCapture', 'stage7CaptureBishopWorkspaceView', 'buildStage7Payload']
      .map((n) => [n, typeof G[n] === 'function']);
    // and the capture no longer reaches for the render / init path
    P.controllerSource = (() => {
      const src = readFileSync(resolve(ROOT, CTRL_REL), 'utf8');
      const start = src.indexOf('function stage7CaptureBishopWorkspaceView');
      const end = src.indexOf('function stage7ControllerDeps');
      const region = start >= 0 && end > start ? src.slice(start, end) : '';
      return {
        found: region.length > 0,
        noRender: !/renderStage6\(\)/.test(region),
        noAppWrite: !/stage6\.app\s*=/.test(region) && !/\.workspace\s*=/.test(region),
        noInit: !/initStage6BishopCanvas/.test(region)
      };
    })();
    P.panelsLayoutOwnsCanvas = typeof panels.bishopAppHtml === 'function';
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
  a = String(a); b = String(b);
  const n = Math.min(a.length, b.length);
  let i = 0; while (i < n && a[i] === b[i]) i += 1;
  return `first difference at char ${i}: …${JSON.stringify(a.slice(Math.max(0, i - 60), i + 60))} vs …${JSON.stringify(b.slice(Math.max(0, i - 60), i + 60))}`;
}
function payloadDiff(o, n) {
  if (o.chars !== n.chars) return `length ${o.chars} → ${n.chars} chars`;
  for (let i = 0; i < Math.max(o.chunks.length, n.chunks.length); i += 1) {
    if (o.chunks[i] !== n.chunks[i]) {
      const head = i * 2000 < 2400 ? firstTextDiff(o.head, n.head) : '';
      return `first differing chunk #${i} (chars ${i * 2000}…${i * 2000 + 1999})${head ? `; ${head}` : '; past the recorded head — rerun with --snapshot to dump both'}`;
    }
  }
  return firstTextDiff(o.head, n.head) || firstTextDiff(o.tail, n.tail) || 'sha differs but every chunk matches (?)';
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-seepslope-report-'));
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

// ── (a) the capture ──────────────────────────────────────────────────────────────────────
console.log(`\n(a) stage7CaptureBishopWorkspaceView — ${newDump.captures.filter((c) => c.kind === 'capture').length} captures`);
check('same capture list', JSON.stringify(oldDump.captures.map((c) => c.label)) === JSON.stringify(newDump.captures.map((c) => c.label)),
  firstTextDiff(JSON.stringify(oldDump.captures.map((c) => c.label)), JSON.stringify(newDump.captures.map((c) => c.label))));
let withImage = 0;
newDump.captures.forEach((n, i) => {
  const o = oldDump.captures[i] || {};
  if (n.kind === 'errors') {
    check(`${n.label}: the three solvers behaved the same`, o.value === n.value, firstTextDiff(o.value, n.value));
    return;
  }
  if (n.dataUrl) withImage += 1;
  check(`${n.label}: the captured data URL is byte-identical`, o.dataUrl === n.dataUrl, firstTextDiff(o.dataUrl, n.dataUrl));
  check(`${n.label}: the whole captured view is byte-identical`, o.view === n.view && o.error === n.error, payloadDiff({ chars: String(o.view).length, chunks: [] }, { chars: String(n.view).length, chunks: [] }) || firstTextDiff(o.view, n.view));
  check(`${n.label}: same image metadata`, o.imageMeta === n.imageMeta, `${o.imageMeta} → ${n.imageMeta}`);
});
check(`every capture produced an image (${withImage})`, withImage === newDump.captures.filter((c) => c.kind === 'capture').length && withImage >= 36, String(withImage));
check('the recording canvas really painted (data URLs carry a non-empty call log)',
  newDump.captures.filter((c) => c.kind === 'capture').every((c) => /calls=[1-9]/.test(String(c.dataUrl))),
  JSON.stringify(newDump.captures.filter((c) => c.kind === 'capture' && !/calls=[1-9]/.test(String(c.dataUrl))).map((c) => [c.label, c.dataUrl])).slice(0, 300));

// ── (b) buildStage7Payload() ─────────────────────────────────────────────────────────────
console.log(`\n(b) buildStage7Payload() — ${newDump.payloads.length} builds`);
newDump.payloads.forEach((n, i) => {
  const o = oldDump.payloads[i] || {};
  check(`${n.label}: byte-identical (${n.chars} chars)`, o.sha === n.sha && o.error === n.error, payloadDiff(o, n));
});
check('the payloads are substantial (> 200 kB each)', newDump.payloads.every((p) => p.chars > 200000),
  JSON.stringify(newDump.payloads.map((p) => [p.label, p.chars])).slice(0, 300));
check('the same wall-clock keys were masked in both controllers', JSON.stringify(oldDump.maskedKeys) === JSON.stringify(newDump.maskedKeys),
  `${JSON.stringify(oldDump.maskedKeys)} → ${JSON.stringify(newDump.maskedKeys)}`);
console.log(`        masked (wall-clock only): ${JSON.stringify(newDump.maskedKeys)}`);

// ── (c) the capture no longer perturbs the UI state ──────────────────────────────────────
// PLAN §6 verifier convention: assert the working tree is clean, and report whether the base shows
// the historical defect (01-monolith-map.md §3.4 #10) or already carries the fix.
console.log('\n(c) S.stage6 and the active app / workspace after a capture');
{
  const treeCaptures = newDump.captures.filter((c) => c.kind === 'capture');
  const baseCaptures = oldDump.captures.filter((c) => c.kind === 'capture');
  check(`the working tree leaves S.stage6 byte-identical across all ${treeCaptures.length} captures`,
    treeCaptures.every((c) => !c.stateChanged),
    JSON.stringify(treeCaptures.filter((c) => c.stateChanged).map((c) => c.label)).slice(0, 400));
  check('the working tree leaves S.stage6.app unchanged', treeCaptures.every((c) => !c.appChanged),
    JSON.stringify(treeCaptures.filter((c) => c.appChanged).map((c) => c.label)).slice(0, 400));
  check('the working tree leaves bishop.workspace unchanged', treeCaptures.every((c) => !c.workspaceChanged),
    JSON.stringify(treeCaptures.filter((c) => c.workspaceChanged).map((c) => c.label)).slice(0, 400));
  check('the working tree leaves the active CPT unchanged', treeCaptures.every((c) => !c.cptChanged));
  check(`the working tree re-renders #stage6Area zero times per capture (${treeCaptures.length} captures)`,
    treeCaptures.every((c) => c.renders === 0),
    JSON.stringify(treeCaptures.filter((c) => c.renders).map((c) => [c.label, c.renders])).slice(0, 400));
  check(`the working tree re-renders #stage6Area zero times per buildStage7Payload() (${newDump.payloads.length} builds)`,
    newDump.payloads.every((p) => p.renders === 0 && !p.stateChanged),
    JSON.stringify(newDump.payloads.filter((p) => p.renders || p.stateChanged).map((p) => [p.label, p.renders, p.stateChanged])).slice(0, 400));
  // The monolith restored `S.stage6.app` / `bishop.workspace` in a `finally`, so what its capture
  // leaves behind is not a changed state but the work: up to three rewrites of #stage6Area, each a
  // full Stage 6 render with everything that hangs off it (map §3.4 #10).
  const perturbing = baseCaptures.filter((c) => c.stateChanged || c.appChanged || c.workspaceChanged || c.renders > 0);
  const baseRenders = baseCaptures.reduce((n, c) => n + (c.renders || 0), 0);
  if (perturbing.length) {
    console.log(`        the base perturbs the UI in ${perturbing.length} of ${baseCaptures.length} captures — the defect of 01-monolith-map.md §3.4 #10, reproduced`);
    console.log(`        ${baseRenders} re-renders of #stage6Area in the base, 0 in the working tree; residual state changes: ${baseCaptures.filter((c) => c.stateChanged).length}`);
    console.log(`        e.g. ${JSON.stringify(perturbing.slice(0, 3).map((c) => [c.label, { renders: c.renders, state: c.stateChanged, app: c.appChanged, workspace: c.workspaceChanged }]))}`);
  } else {
    console.log('        the base perturbs nothing either — it already carries the fix; rerun with --base <sha before PR 18g> for the historical proof');
  }
  check('the base either shows the defect or already carries the fix (never a third case)',
    baseCaptures.length === treeCaptures.length && (perturbing.length === 0 || baseRenders > 0 || baseCaptures.some((c) => c.stateChanged)));
}

// ── (d) the manual capture button ────────────────────────────────────────────────────────
console.log(`\n(d) stage7CaptureWorkspaceView — ${newDump.manual.length} states`);
newDump.manual.forEach((n, i) => {
  const o = oldDump.manual[i] || {};
  check(`${n.label}: bishop.capturedView identical`, o.value === n.value, firstTextDiff(o.value, n.value));
});

// ── (e) the package standalone ───────────────────────────────────────────────────────────
console.log('\n(e) the package standalone (working tree)');
const P = newDump.pure;
check('(e) the offscreen frame issues exactly the live frame\'s draw calls, in every workspace',
  P.sameDraw.every(([, live, off, same]) => same && live > 1000 && off > 1000),
  JSON.stringify(P.sameDraw));
console.log(`        draw-call log: ${P.sameDraw.map(([w, live]) => `${w} ${live} chars`).join(', ')} — identical offscreen`);
check('(e) the viewport was already fitted, so no capture-time auto-fit was needed', P.viewportFitted === true);
check('(e) seepslope/panels still owns the canvas layout the probe copies', P.panelsLayoutOwnsCanvas === true);
check('(e) renderWorkspaceFrame does not mutate the bishop block it is handed', P.framePure.bishop === true);
check('(e) renderWorkspaceFrame does not mutate the section model it is handed', P.framePure.model === true);
check('(e) two offscreen frames of the same state are identical', P.framePure.stable === true);
check('(e) the three-way workspace switch is the monolith\'s',
  JSON.stringify(P.workspaceSwitch) === JSON.stringify([['stability', 'stability'], ['seepage', 'seepage'], ['deformation', 'deformation'], ['bishop', 'stability'], ['', 'stability'], ['null', 'stability'], ['undefined', 'stability'], ['nonsense', 'stability']]),
  JSON.stringify(P.workspaceSwitch));
check('(e) isCaptureWorkspace is the monolith\'s `valid` array',
  JSON.stringify(P.isCaptureWorkspace) === JSON.stringify([['stability', true], ['seepage', true], ['deformation', true], ['bishop', false], ['', false]]),
  JSON.stringify(P.isCaptureWorkspace));
check('(e) the automatic seepage display is the nine-flag projection, in order',
  JSON.parse(P.autoDisplay.find(([w]) => w === 'seepage')[1]) && Object.keys(JSON.parse(P.autoDisplay.find(([w]) => w === 'seepage')[1])).join(',') === 'contourMode,showContours,showContourLines,showContourLegend,showBoundaryConditions,showBoundaryLabels,showPhreatic,showFlowVectors,showExitGradient',
  P.autoDisplay.find(([w]) => w === 'seepage')[1]);
check('(e) the automatic stability display is {selectedResult, methodMode}',
  Object.keys(JSON.parse(P.autoDisplay.find(([w]) => w === 'stability')[1])).join(',') === 'selectedResult,methodMode',
  P.autoDisplay.find(([w]) => w === 'stability')[1]);
check('(e) the manual display differs from the automatic one for seepage (it clones the state)',
  P.manualDisplay.find(([w]) => w === 'seepage')[1] !== P.autoDisplay.find(([w]) => w === 'seepage')[1]);
check('(e) manualCaptureDisplay returns null for an unknown workspace', P.manualDisplay.find(([w]) => w === 'nonsense')[1] === 'null');
check('(e) workspaceHasContent is true for the solved state and false for an empty block',
  P.hasContent.every(([, solved, empty]) => solved === true && empty === false), JSON.stringify(P.hasContent));
check('(e) the down-scale arithmetic of stage7CaptureCanvasImage is unchanged',
  JSON.stringify(P.rasterise) === JSON.stringify([['800x400', '800x400 image/jpeg'], ['1400x700', '1400x700 image/jpeg'], ['2800x1120', '1400x560 image/jpeg'], ['3000x1', '1400x1 image/jpeg'], ['1x1', '1x1 image/jpeg'], ['0x0', 'null']]),
  JSON.stringify(P.rasterise));
check('(e) rasteriseCanvas without a canvas factory is null', P.rasteriseNoFactory === true);
check('(e) the image defaults are 1400 px / 0.9 / image/jpeg', P.imageDefaults === '{"maxWidth":1400,"quality":0.9,"mimeType":"image/jpeg"}', P.imageDefaults);
check('(e) CAPTURE_WORKSPACES is the monolith\'s array', P.captureWorkspaces === '["stability","seepage","deformation"]', P.captureWorkspaces);
check('(e) the measurement probe uses the layout\'s own classes, and the layout really emits them',
  P.probeClasses.every(([, inProbe, inApp]) => inProbe && inApp),
  JSON.stringify(P.probeClasses.filter(([, a, b]) => !a || !b)));
check('(e) the probe carries the --settings-wide modifier only when asked', P.probeWide === true);
check('(e) the probe has exactly one canvas to measure', P.probeHasOneCanvas === true);
check('(e) report/deps.js builds the same capture from over.captureHost', P.depsCapture.every(([, same]) => same), JSON.stringify(P.depsCapture));
check('(e) without a captureHost the dep is still () => null', P.depsNoHost === true);
check('(e) an explicit captureBishopWorkspaceView still wins', P.depsOverride === true);
check('(e) no bishop block → null', P.captureNoBlock === true);
check('(e) no frame box (Stage 6 not laid out) → null', P.captureNoBox === true);
check('(e) no real canvas (SSR / the Node harness) → null', P.captureNoCanvas === true);
check(`(e) every monolith Stage 7 capture name survives as a function (${P.names.length})`, P.names.every(([, ok]) => ok), JSON.stringify(P.names.filter(([, ok]) => !ok)));
check('(e) the controller\'s capture region no longer renders, switches the app or re-inits the canvas',
  P.controllerSource.found && P.controllerSource.noRender && P.controllerSource.noAppWrite && P.controllerSource.noInit,
  JSON.stringify(P.controllerSource));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('\nfailures:'); for (const f of failures.slice(0, 40)) console.log(`  - ${f}`); if (failures.length > 40) console.log(`  … and ${failures.length - 40} more`); }
process.exit(fail ? 1 : 0);
