#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 9c / PR 18c (worklog/refactor/24-pr18c-seepslope-run.md): the three
// Seep / Slope runs (Bishop search, seepage FEM, deformation FEM) moved out of
// legacy-controller.js into src/lib/cpt-app/seepslope/run/** as pure request builders + pure
// result reducers, with the worker lifecycle behind one adapter. Pattern of
// scripts/verify_seepslope_state.mjs / verify_seepslope_model.mjs: the controller of a base ref
// (default `integration-r`) and the working-tree controller are each loaded under Node through
// the Tier-B loader in their own child process, dump the same observations to JSON, and the
// parent compares the two dumps byte for byte (JSON text, key order included).
//
// The Tier-B stub sets `globalThis.Worker = undefined`, so the monolith's run handlers never get
// past their "Web Worker is not available" guard and no message is ever posted. This verifier
// installs a **recording Worker stub** instead: every construction (which entry module, which
// options), every `postMessage` (the full message, key order preserved) and every `terminate()`
// is logged, and replies are injected by calling the worker's own `onmessage` / `onerror`. That
// is what makes the message contracts of map §5 rows 1-3 — including the ~60 deformation option
// keys — observable under Node at all.
//
//   (a) the worker messages — for the seeded demo CPT and every CPT of the three project fixtures
//       (legacy-v0.5.2, multi-3cpt, single-layered), each made runnable the way the seep-slope
//       journey makes it runnable (terrain + entry/exit zones, two side head BCs, a surface
//       load): stage6BishopRunSearch / RunSeepage / RunDeformation, and after each the constructed
//       workers, the posted messages (deep-equal), the bishop block, the progress strings and
//       #stage6Area
//   (b) the rejection paths — no model, no zones, no head BC, a fixed free surface without a
//       phreatic line, a drain error, no active surface load, and the no-Worker guard (the stub
//       switched off) — the state each writes and the fact that nothing was posted
//   (c) the replies — a recorded set driven through the worker's onmessage: progress at every
//       stage, success, "no result", the interrupt errors, a generic error, a **stale runId**,
//       and the onerror path, for each of the three runs; plus stop mid-run (the cooperative
//       `stop-seepage` / `stop-deformation` message vs the search terminate) and the Stop button
//       on an idle run
//   (d) the progress strings — #stage6BishopProgress / #stage6BishopProgressBar after every step,
//       and a table of the eight message / label builders over crafted inputs (every branch of
//       the 60-line deformation status message included)
//   (e) terminate-on-CPT-switch (PLAN §4 defect 2, fixed in PR 14) — a deformation run in flight
//       on CPT 0 of multi-3cpt, then selectCpt(1): the deformation worker must be terminated with
//       the search and seepage workers, a late reply for the old run must be dropped, and the
//       originating CPT must not be left at deformation.progress.running = true
//   (f) working tree only: the package standalone — the request builders replayed on the recorded
//       pre-launch states equal the messages the controller posted; the reducers replayed on the
//       recorded pre-reply states equal the blocks the controller produced; stopXPatch is the
//       silent stop of seepslope/model/invalidate.js; the deformation option key list; and the
//       worker adapter driven directly with stub factories (create once, terminate, silent vs
//       cooperative stop, monotonic run ids, no Worker → null, onerror terminates)
//
// Usage
//   node scripts/verify_seepslope_run.mjs                    compare against integration-r
//   node scripts/verify_seepslope_run.mjs --base <ref>       compare against another git ref
//   node scripts/verify_seepslope_run.mjs --snapshot f.json  dump the working tree only
//   node scripts/verify_seepslope_run.mjs --against f.json   compare the working tree with a dump
//
// The base controller is materialised as
// src/lib/cpt-app/__verify-seepslope-run-base.legacy-controller.js and deleted again, whatever
// happens; no MOVED_SIBLINGS are needed (this PR changes no module the base imports).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-seepslope-run-base.legacy-controller.js';
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
const WALK_FIXTURE = 'layered';
// The bishop golden suite's section (scripts/golden/suites/bishop.mjs), verbatim.
const CPT_TERRAIN = { terrain: [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }], entryZone: { xStart: 1, xEnd: 5 }, exitZone: { xStart: 13, xEnd: 19 } };

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// ─────────────────────────────── the recorded worker replies ───────────────────────────────
// The search replies carry a **real** `analyzeBishopSearch` result (the golden bishop suite's
// reduced grid on the `layered` fixture, computed in-process): the results table and the canvas
// then render the shape the worker really sends. The seepage / deformation replies are crafted
// payloads — every branch of the reducers and of the 60-line deformation status message — because
// running those two solvers 20 times would cost minutes; the deformation reply walk therefore
// happens with the Stage 6 shell on the *bearing* app, so a synthetic result never reaches the
// bishop panel's renderers (the trick of verify_seepslope_model.mjs group (b)).
const CPT_SEARCH = { nEntry: 4, nExit: 4, nCenter: 6, centerOffsetMin: 0.5, centerOffsetMax: 3, minChordLength: 2, minSlipThickness: 0.75, maxExitAngleDeg: 45, validationSamples: 30, geomTol: 0.001, minSliceWidth: 0.05, targetSlices: 30, keepBest: 3 };

const SEEPAGE_OUTPUT = {
  mesh: { nodes: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], elements: [[0, 1, 2]] },
  result: { heads: [3, 2.5, 2], flowError: 0.0042, timing: { totalMs: 2500 }, solver: { terminationReason: 'flow-error', iterations: 7 } }
};
const SEEPAGE_OUTPUT_TIME_LIMIT = { mesh: SEEPAGE_OUTPUT.mesh, result: { ...SEEPAGE_OUTPUT.result, solver: { terminationReason: 'time-limit' } } };
const SEEPAGE_OUTPUT_INTERRUPTED = { mesh: SEEPAGE_OUTPUT.mesh, result: { ...SEEPAGE_OUTPUT.result, flowError: null, solver: { terminationReason: 'interrupted' } } };
const SEEPAGE_OUTPUT_FIXED = { mesh: SEEPAGE_OUTPUT.mesh, result: { ...SEEPAGE_OUTPUT.result, solver: { terminationReason: 'fixed-boundary' } } };

const deformationOutput = (solver, summaries = {}, extra = {}) => ({
  mesh: { nodes: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], elements: [[0, 1, 2]] },
  solver,
  summaries: { maxSettlement: 0.0123, maxMcEta: 0.87, ...summaries },
  warnings: ['a warning'],
  timing: { totalMs: 3210 },
  ...extra
});
const DEFORMATION_OUTPUTS = [
  ['converged deformation', deformationOutput({ analysisType: 'deformation', convergenceState: 'converged', displayedLoadFactor: 1, loadFactorCommitted: 1 })],
  ['partial, service phase started', deformationOutput({ analysisType: 'deformation', convergenceState: 'partial', displayedLoadFactor: 0.62, loadFactorCommitted: 0.5, initialPhaseStarted: true, servicePhaseStarted: true })],
  ['partial, service phase started, no gap', deformationOutput({ analysisType: 'deformation', convergenceState: 'partial', displayedLoadFactor: 0.5, loadFactorCommitted: 0.5, initialPhaseStarted: true, servicePhaseStarted: true })],
  ['partial, initial phase only (gravity)', deformationOutput({ analysisType: 'deformation', convergenceState: 'partial', initialPhaseStarted: true, servicePhaseStarted: false, initialPhaseDisplayedGravityFactor: 0.43 })],
  ['partial, initial phase only (predictor correction)', deformationOutput({ analysisType: 'deformation', convergenceState: 'partial', initialPhaseStarted: true, servicePhaseStarted: false, initialPhaseDisplayedGravityFactor: 0.77, initialPhaseDisplayedContinuationMode: 'predictor-to-full-gravity correction' })],
  ['tension cut-off active (initial phase)', deformationOutput({ analysisType: 'deformation', convergenceState: 'converged', initialPhaseStarted: true, servicePhaseStarted: false, initialPhasePeakTensionCutoffActiveElements: 4 })],
  ['tension cut-off active (service phase)', deformationOutput({ analysisType: 'deformation', convergenceState: 'converged', initialPhaseStarted: true, servicePhaseStarted: true, peakTensionPendingElements: 2 })],
  ['infinite mc eta', deformationOutput({ analysisType: 'deformation', convergenceState: 'converged' }, { hasInfiniteMcEta: true })],
  ['one inadmissible predictor element', deformationOutput({ analysisType: 'deformation', convergenceState: 'converged' }, { inadmissibleInitialElementCount: 1 })],
  ['three inadmissible predictor elements', deformationOutput({ analysisType: 'deformation', convergenceState: 'converged' }, { inadmissibleInitialElementCount: 3 })],
  ['safety bracketed failure', deformationOutput({ analysisType: 'safety-cphi', safetyFactorOfSafetyLower: 1.412, safetyFactorOfSafetyUpper: 1.455, safetyDisplayedSigmaMsf: 1.44, safetyResult: { finalization: { status: 'bracketed-failure' } } }, { maxSafetyEquivalentPlasticIncrement: 0.0031 })],
  ['safety mechanism developed', deformationOutput({ analysisType: 'safety-cphi', safetyFactorOfSafetyLower: 1.2, safetyResult: { finalization: { status: 'mechanism-developed' } } }, { maxSafetyEquivalentPlasticIncrement: 0.02 })],
  ['safety open ended (no failure found)', deformationOutput({ analysisType: 'safety-cphi', safetyFactorOfSafetyLower: 3.5, safetyResult: { finalization: { status: 'no-failure-found' } } })],
  ['safety open ended (flag)', deformationOutput({ analysisType: 'safety-cphi', safetyFactorOfSafetyLower: 2.25, safetyResult: { finalization: { status: 'step-limit', factorOfSafetyIsOpenEnded: true } } })],
  ['safety other status', deformationOutput({ analysisType: 'safety-cphi', safetyFactorOfSafetyLower: 1.05, safetyResult: { finalization: { status: 'load-step-floor' } } })],
  ['safety legacy bracketed status', deformationOutput({ analysisType: 'safety-cphi', safetyFactorOfSafetyLower: 1.31, safetyStatus: 'bracketed' })],
  ['safety legacy unknown status', deformationOutput({ analysisType: 'safety-cphi', safetyFactorOfSafetyLower: 1.11, safetyStatus: 'aborted' })],
  ['safety with no status at all', deformationOutput({ analysisType: 'safety-cphi', safetyFactorOfSafetyLower: 1.02 })],
  ['no solver block', deformationOutput(undefined)],
  ['warnings not an array', deformationOutput({ analysisType: 'deformation' }, {}, { warnings: 'oops' })]
];
const DEFORMATION_INTERRUPT_ERRORS = [
  'Deformation run was interrupted before the first displacement solution became available.',
  'Deformation run was interrupted before geostatic initialization became available.'
];

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

  // ── the recording Worker stub: the whole point of this verifier ──
  const workerLog = [];      // one entry per construction
  const workerEvents = [];   // post / terminate, in order
  const live = [];
  let workerSeq = 0;
  let workerAvailable = true;
  const ser = (v) => JSON.stringify(v, (k, x) => (x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
  const clone = (v) => JSON.parse(JSON.stringify(v));
  class RecordingWorker {
    constructor(url, options){
      this.seq = ++workerSeq;
      this.href = String(url?.href ?? url);
      this.file = this.href.split('?')[0].split('/').pop();
      this.options = options ? clone(options) : null;
      this.terminated = false;
      this.onmessage = null;
      this.onerror = null;
      workerLog.push({ seq: this.seq, file: this.file, options: this.options });
      live.push(this);
    }
    postMessage(message){
      workerEvents.push({ seq: this.seq, file: this.file, kind: 'post', message: ser(message) });
    }
    terminate(){
      this.terminated = true;
      workerEvents.push({ seq: this.seq, file: this.file, kind: 'terminate' });
    }
  }
  const installWorker = () => { globalThis.Worker = RecordingWorker; workerAvailable = true; };
  const removeWorker = () => { globalThis.Worker = undefined; workerAvailable = false; };
  installWorker();
  /** The newest live worker built from `file`, or null. */
  const workerFor = (file) => [...live].reverse().find((w) => w.file === file && !w.terminated) || null;
  const WORKER_FILES = { search: 'stage6-bishop-worker.js', seepage: 'seepage-worker.js', deformation: 'deformation-worker.js' };

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
  const realRandom = Math.random;
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

  const dump = { controller: ctrlRel, steps: [], labels: {}, pure: {} };

  // seeded clock + PRNG (bc-/wall-/drain-/region- ids and the demo)
  const idEvents = [];
  let clockT = 1700000000000;
  const rng = mulberry32(0x5eed5eed);
  const seedIds = () => { Date.now = () => { clockT += 1000; idEvents.push(['now', clockT]); return clockT; }; Math.random = () => { const v = rng(); idEvents.push(['random', v]); return v; }; };
  const unseedIds = () => { Date.now = realNow; Math.random = realRandom; };

  const replay = [];   // pre-state snapshots for (f)
  /**
   * One observation. Everything a run or a reply can move: the block, the four status strings,
   * the progress DOM, the constructed workers and posted messages since the previous step,
   * #stage6Area, the alerts / rAF errors, the id-consumption count.
   */
  function observe(label, fn, { area = false, record = null } = {}) {
    stub.rafErrors.length = 0; stub.alerts.length = 0;
    const logMark = workerLog.length;
    const eventMark = workerEvents.length;
    const pre = S()?.stage6?.bishop ? clone(B()) : null;
    let error = null;
    try { fn(); } catch (e) { error = String(e?.stack || e).split('\n').slice(0, 3).join(' | '); }
    api.stage6BishopUpdateProgressDom?.();
    const obs = {
      label, error,
      bishop: S()?.stage6?.bishop ? ser(B()) : null,
      message: B()?.progress?.message ?? null,
      seepageReason: B()?.seepage?.rejectReason ?? null,
      seepageStatus: B()?.seepage?.status ?? null,
      deformationReason: B()?.deformation?.rejectReason ?? null,
      deformationStatus: B()?.deformation?.status ?? null,
      deformationMessage: B()?.deformation?.progress?.message ?? null,
      progressDom: stub.document.getElementById('stage6BishopProgress').textContent,
      progressBar: stub.document.getElementById('stage6BishopProgressBar').style.width,
      workersBuilt: workerLog.slice(logMark),
      workerEvents: workerEvents.slice(eventMark),
      app: S()?.stage6?.app ?? null,
      rafErrors: stub.rafErrors.map((e) => e.split('\n')[0]),
      alerts: stub.alerts.slice(),
      idEvents: idEvents.length
    };
    if (area) obs.area = stub.document.getElementById('stage6Area').innerHTML;
    dump.steps.push(obs);
    if (record) replay.push({ key: record, label, pre, post: obs.bishop, posted: obs.workerEvents.filter((e) => e.kind === 'post').map((e) => e.message) });
    return obs;
  }

  /** Make the active CPT runnable the way the seep-slope journey does. */
  function makeRunnable({ bcs = true, load = true } = {}) {
    Object.assign(B(), clone(CPT_TERRAIN));
    api.setStage6App('bishop');
    if (bcs) {
      api.stage6BishopSetWorkspace('seepage');
      const boundary = S().stage6Cache.bishopSeepageBoundary || [];
      for (const [source, head] of [['side-left', 3.0], ['side-right', -0.5]]) {
        const edge = boundary.find((e) => e.source === source);
        if (!edge) continue;
        api.stage6BishopSelectSeepageBoundary(edge.edgeKey);
        api.stage6BishopSetSeepageBcType('head');
        api.stage6BishopSetSeepageBcHead(head);
      }
      api.stage6BishopSetField('seepage.options.meshTargetArea', 1.0);
    }
    if (load) {
      // The load tool of the canvas builds exactly this entry (state/surface-loads.js
      // normalizeSurfaceLoad); stage6BishopSetField('surfaceLoad.*') cannot create one — with an
      // empty `surfaceLoads` it only writes the legacy mirror, which the next sync overwrites.
      B().surfaceLoads = [{ id: 'load-1', label: 'Load 1', xStart: 10, xEnd: 14, q: 20, totalLoad: 0, loadMode: 'pressure', active: true }];
      B().selectedSurfaceLoadId = 'load-1';
      api.stage6BishopSetField('deformation.options.meshTargetArea', 2.0);
    }
    api.stage6BishopSetWorkspace('stability');
  }

  /** A real analyzeBishopSearch result for the active CPT (the golden bishop suite's reduced grid). */
  async function realSearchResult() {
    const engine = await server.ssrLoadModule('/src/lib/cpt-app/stage6-bishop.js');
    const b = B();
    const model = S().stage6Cache.bishopModel || api.stage6BishopCurrentModel();
    return engine.analyzeBishopSearch({
      model, entryZone: b.entryZone, exitZone: b.exitZone, methodMode: b.methodMode,
      searchConfig: { ...b.search, ...CPT_SEARCH }, solverConfig: { ...b.solver },
      spencerConfig: { ...b.spencer, recheckCount: 2 }, soilSource: 'regions'
    });
  }

  /** The three launches, in order, on the state as it stands. */
  function launchAll(prefix) {
    observe(`${prefix}: RunSearch`, () => api.stage6BishopRunSearch(), { record: 'search' });
    observe(`${prefix}: RunSeepage`, () => api.stage6BishopRunSeepage(), { record: 'seepage' });
    observe(`${prefix}: RunDeformation`, () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  }

  /** Feed one reply to the newest live worker of `kind`. */
  function reply(kind, label, payload, { onerror = false } = {}) {
    observe(label, () => {
      const w = workerFor(WORKER_FILES[kind]);
      if (!w) throw new Error(`no live ${kind} worker`);
      if (onerror) w.onerror({ message: 'boom' });
      else w.onmessage({ data: payload });
    }, { record: `${kind}-reply` });
  }
  const currentRunId = (kind) => (kind === 'search' ? B().progress.runId : B()[kind].progress.runId);

  seedIds();

  // ── (a) the demo
  {
    resetProject();
    const seeded = mulberry32(manifest.seed);
    Math.random = () => { const v = seeded(); idEvents.push(['random', v]); return v; };
    api.loadDemo();
    seedIds();
    S().method = 'sb260'; api.runClass(); api.goS(3); api.goS(5);
    makeRunnable();
    launchAll('demo');
    observe('demo: state after the three launches', () => api.renderStage6(), { area: true });
  }

  // ── (a) the three project fixtures, every CPT
  for (const name of PROJECT_FIXTURES) {
    resetProject();
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, `projects/${name}.madep.json`))], `${name}.madep.json`));
    for (let i = 0; i < api.PROJECT.cpts.length; i += 1) {
      api.selectCpt(i);
      makeRunnable();
      launchAll(`${name}[${i}] ${S().id}`);
    }
  }

  // ── (b) the rejection paths, on the layered fixture
  await classify(WALK_FIXTURE);
  makeRunnable();
  observe('reject: RunSearch without terrain', () => { B().terrain = [{ x: 0, y: 4 }]; api.stage6BishopRunSearch(); }, { record: 'search' });
  observe('reject: RunSeepage without terrain', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  observe('reject: RunDeformation without terrain', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  observe('reject: terrain back, entry zone cleared', () => { Object.assign(B(), clone(CPT_TERRAIN)); B().entryZone = null; });
  observe('reject: RunSearch without zones', () => api.stage6BishopRunSearch(), { record: 'search' });
  observe('reject: exit zone cleared too', () => { B().exitZone = null; });
  observe('reject: RunSearch with neither zone', () => api.stage6BishopRunSearch(), { record: 'search' });
  observe('reject: zones back', () => { Object.assign(B(), clone(CPT_TERRAIN)); });
  // `bc.status = 'orphaned'` does not stick — stage6BishopSyncSeepageState re-derives the status
  // from the boundary on the next sync — so the two "no head BC" scenarios are a type change and
  // an empty list, both of which survive to the pre-flight.
  let savedBcs = null;
  observe('reject: BCs turned into flux BCs', () => { for (const bc of B().seepage.bcs) bc.type = 'flux'; });
  observe('reject: RunSeepage without a head BC', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  observe('reject: BCs removed altogether', () => { savedBcs = clone(B().seepage.bcs); B().seepage.bcs = []; });
  observe('reject: RunSeepage without any BC', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  observe('reject: head BCs back, free surface fixed without a phreatic line', () => {
    B().seepage.bcs = clone(savedBcs);
    for (const bc of B().seepage.bcs) bc.type = 'head';
    B().seepage.options.freeSurface = 'fixed';
    B().phreatic = [];
  });
  observe('reject: RunSeepage with a fixed free surface and no phreatic line', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  observe('reject: a one-point phreatic line', () => { B().phreatic = [{ x: 0, y: 2 }]; });
  observe('reject: RunSeepage with a one-point phreatic line', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  observe('reject: free surface back to iterate, a drain above the terrain', () => {
    B().seepage.options.freeSurface = 'iterate';
    B().drains = [{ id: 'drain_bad', vertices: [{ x: 4, y: 9 }, { x: 6, y: 9 }], head: 0, active: true }];
  });
  observe('reject: RunSeepage with an invalid drain', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  observe('reject: drains cleared, surface loads cleared', () => { B().drains = []; B().surfaceLoads = []; B().surfaceLoad = { xStart: null, xEnd: null, q: 0 }; });
  observe('reject: RunDeformation without an active surface load', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  observe('reject: safety-cphi needs no surface load', () => { B().deformation.options.analysisType = 'safety-cphi'; });
  observe('reject: RunDeformation as safety-cphi without a load (accepted)', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  observe('reject: back to a deformation analysis with a load', () => {
    B().deformation.options.analysisType = 'deformation';
    B().surfaceLoads = [{ id: 'load-1', label: 'Load 1', xStart: 10, xEnd: 14, q: 20, totalLoad: 0, loadMode: 'pressure', active: true }];
    B().selectedSurfaceLoadId = 'load-1';
    api.renderStage6();
  });
  // the no-Worker guard: the stub switched off, exactly the environment the golden Tier B has
  observe('reject: Worker removed from the environment', () => { removeWorker(); });
  observe('no-worker: RunSearch', () => api.stage6BishopRunSearch(), { record: 'search' });
  observe('no-worker: RunSeepage', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  observe('no-worker: RunDeformation', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  observe('no-worker: Worker back', () => { installWorker(); });

  // ── (b2) the behaviour fix of PR 18c commit 2: a rejected attempt clears its own run flag.
  // Every pre-flight rejection of the monolith returned *before* the silent stop the handler
  // makes on its way to the worker, so a Run pressed on a state that had become un-runnable
  // while a run was in flight left `progress.running = true` next to the failure reason. These
  // steps are the only ones where base and working tree may differ, and only in that flag.
  await classify(WALK_FIXTURE);
  makeRunnable();
  dump.runningFix = {};
  const launched = {};
  observe('running-fix: RunSearch launched (a search is now in flight)', () => api.stage6BishopRunSearch());
  launched.search = B().progress.running;
  observe('running-fix: terrain removed under the running search', () => { B().terrain = [{ x: 0, y: 4 }]; });
  observe('running-fix: RunSearch rejected while a search is in flight', () => api.stage6BishopRunSearch());
  dump.runningFix.search = { launched: launched.search, afterReject: B().progress.running, message: B().progress.message };
  // a silent stop brings both trees back together, so the divergence cannot leak into later steps
  observe('running-fix: silent stop after the search rejection (both trees converge)', () => { api.stage6BishopStopSearch(true); api.renderStage6(); });
  observe('running-fix: terrain back', () => { Object.assign(B(), clone(CPT_TERRAIN)); api.renderStage6(); });
  observe('running-fix: RunSeepage launched (a solve is now in flight)', () => api.stage6BishopRunSeepage());
  launched.seepage = B().seepage.progress.running;
  observe('running-fix: terrain removed under the running solve', () => { B().terrain = [{ x: 0, y: 4 }]; });
  observe('running-fix: RunSeepage rejected while a solve is in flight', () => api.stage6BishopRunSeepage());
  dump.runningFix.seepage = { launched: launched.seepage, afterReject: B().seepage.progress.running, status: B().seepage.status, message: B().seepage.rejectReason };
  observe('running-fix: silent stop after the seepage rejection (both trees converge)', () => { api.stage6BishopStopSeepage(true); api.renderStage6(); });
  observe('running-fix: terrain back for the deformation scenario', () => { Object.assign(B(), clone(CPT_TERRAIN)); api.renderStage6(); });
  observe('running-fix: RunDeformation launched (a solve is now in flight)', () => api.stage6BishopRunDeformation());
  launched.deformation = B().deformation.progress.running;
  observe('running-fix: terrain removed under the running deformation solve', () => { B().terrain = [{ x: 0, y: 4 }]; });
  observe('running-fix: RunDeformation rejected while a solve is in flight', () => api.stage6BishopRunDeformation());
  dump.runningFix.deformation = { launched: launched.deformation, afterReject: B().deformation.progress.running, status: B().deformation.status, message: B().deformation.rejectReason };
  observe('running-fix: silent stop after the deformation rejection (both trees converge)', () => { api.stage6BishopStopDeformation(true); api.renderStage6(); });

  // ── (c) the replies, run by run
  await classify(WALK_FIXTURE);
  makeRunnable();
  // `timing` is wall-clock, so it is replaced by fixed numbers with the same key set — the golden
  // normaliser masks it for the same reason. Everything else analyzeBishopSearch returns is
  // deterministic given the model, and the model is compared in group (a).
  const fixTiming = (t) => Object.fromEntries(Object.keys(t || {}).map((k, i) => [k, 1000 + i]));
  const SEARCH_RESULT = clone(await realSearchResult());
  SEARCH_RESULT.timing = { ...fixTiming(SEARCH_RESULT.timing), totalMs: 1234.56 };
  const SEARCH_RESULT_BISHOP_ONLY = { ...SEARCH_RESULT, methodMode: 'bishop', spencerConverged: 0, timing: { ...SEARCH_RESULT.timing, totalMs: 987 } };
  const SEARCH_RESULT_SPENCER_FALLBACK = { ...SEARCH_RESULT, methodMode: 'bishop_spencer', spencerConverged: 0, timing: { ...SEARCH_RESULT.timing, totalMs: 4321 } };
  const SEARCH_RESULT_NO_CRITICAL = { ...SEARCH_RESULT, critical: null, allResults: [], timing: { ...SEARCH_RESULT.timing, totalMs: 12 } };
  dump.realSearch = { methodMode: SEARCH_RESULT.methodMode, hasCritical: !!SEARCH_RESULT.critical, results: (SEARCH_RESULT.allResults || []).length, spencerConverged: SEARCH_RESULT.spencerConverged ?? null, keys: Object.keys(SEARCH_RESULT) };

  observe('search: launch', () => api.stage6BishopRunSearch(), { record: 'search' });
  // the preview circle the worker sends is one of the search's own circles — the canvas draws it
  reply('search', 'search: progress 10 %', { type: 'progress', runId: currentRunId('search'), progress: { trial: 150, total: 1500, percent: 10, previewCircle: SEARCH_RESULT.critical } });
  reply('search', 'search: progress 60 % without a preview circle', { type: 'progress', runId: currentRunId('search'), progress: { trial: 900, total: 1500, percent: 60.4 } });
  reply('search', 'search: progress with an empty payload', { type: 'progress', runId: currentRunId('search') });
  reply('search', 'search: a stale runId is dropped', { type: 'progress', runId: currentRunId('search') + 100, progress: { trial: 1, total: 2, percent: 99, previewCircle: SEARCH_RESULT.critical } });
  reply('search', 'search: result (bishop + spencer)', { type: 'result', runId: currentRunId('search'), result: SEARCH_RESULT });
  // The guard is `payload.runId !== progress.runId`, and the run id survives the result, so a
  // progress message that arrives *after* the result is still accepted and re-arms
  // progress.running (monolith behaviour; the real worker stops sending after the result).
  reply('search', 'search: a progress reply after the result is still accepted (runId unchanged)', { type: 'progress', runId: currentRunId('search'), progress: { trial: 1, total: 2, percent: 50 } });
  observe('search: relaunch', () => api.stage6BishopRunSearch(), { record: 'search' });
  reply('search', 'search: result (bishop only)', { type: 'result', runId: currentRunId('search'), result: SEARCH_RESULT_BISHOP_ONLY });
  observe('search: relaunch for the spencer fallback', () => api.stage6BishopRunSearch(), { record: 'search' });
  reply('search', 'search: result (spencer fell back)', { type: 'result', runId: currentRunId('search'), result: SEARCH_RESULT_SPENCER_FALLBACK });
  observe('search: relaunch for the no-circle result', () => api.stage6BishopRunSearch(), { record: 'search' });
  reply('search', 'search: result without a critical circle', { type: 'result', runId: currentRunId('search'), result: SEARCH_RESULT_NO_CRITICAL });
  observe('search: relaunch for the error', () => api.stage6BishopRunSearch(), { record: 'search' });
  reply('search', 'search: error with a message', { type: 'error', runId: currentRunId('search'), error: 'Bishop solver blew up.' });
  observe('search: relaunch for the empty error', () => api.stage6BishopRunSearch(), { record: 'search' });
  reply('search', 'search: error without a message', { type: 'error', runId: currentRunId('search') });
  observe('search: relaunch for the unknown type', () => api.stage6BishopRunSearch(), { record: 'search' });
  reply('search', 'search: an unknown message type falls through to the error branch', { type: 'nonsense', runId: currentRunId('search') });
  observe('search: relaunch for onerror', () => api.stage6BishopRunSearch(), { record: 'search' });
  reply('search', 'search: onerror', null, { onerror: true });
  observe('search: relaunch for the Stop button', () => api.stage6BishopRunSearch(), { record: 'search' });
  observe('search: Stop button while running', () => { api.stage6BishopStopSearch(); api.renderStage6(); });
  observe('search: Stop button while idle', () => { api.stage6BishopStopSearch(); api.renderStage6(); });

  observe('seepage: launch', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: progress meshing', { type: 'progress', runId: currentRunId('seepage'), progress: { percent: 12, message: 'Meshing...', stage: 'meshing' } });
  reply('seepage', 'seepage: progress solving', { type: 'progress', runId: currentRunId('seepage'), progress: { percent: 44, message: 'Solving...', stage: 'solving' } });
  reply('seepage', 'seepage: progress post', { type: 'progress', runId: currentRunId('seepage'), progress: { percent: 90, message: 'Post-processing...', stage: 'post' } });
  reply('seepage', 'seepage: progress with an unknown stage and no message', { type: 'progress', runId: currentRunId('seepage'), progress: { percent: 95, stage: 'whatever' } });
  reply('seepage', 'seepage: a stale runId is dropped', { type: 'progress', runId: currentRunId('seepage') + 100, progress: { percent: 1, message: 'nope', stage: 'meshing' } });
  observe('seepage: every contour overlay switched off', () => {
    const d = B().seepage.display;
    d.showContours = false; d.showContourLines = false; d.showFlowVectors = false; d.showExitGradient = false; d.contourMode = 'porePressure';
  });
  reply('seepage', 'seepage: result (auto-enables the head contours)', { type: 'result', runId: currentRunId('seepage'), output: SEEPAGE_OUTPUT });
  observe('seepage: relaunch (contours already on)', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: result with the contours already on', { type: 'result', runId: currentRunId('seepage'), output: SEEPAGE_OUTPUT });
  observe('seepage: relaunch for the time limit', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: result at the runtime limit', { type: 'result', runId: currentRunId('seepage'), output: SEEPAGE_OUTPUT_TIME_LIMIT });
  observe('seepage: relaunch for the interrupted result', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: result after an interruption (no flow error)', { type: 'result', runId: currentRunId('seepage'), output: SEEPAGE_OUTPUT_INTERRUPTED });
  observe('seepage: relaunch for the fixed boundary', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: result with a fixed phreatic boundary', { type: 'result', runId: currentRunId('seepage'), output: SEEPAGE_OUTPUT_FIXED });
  observe('seepage: relaunch for the empty result', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: result without a mesh', { type: 'result', runId: currentRunId('seepage'), output: { mesh: null, result: SEEPAGE_OUTPUT.result } });
  observe('seepage: relaunch for the interrupt error', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: the interrupt error', { type: 'error', runId: currentRunId('seepage'), error: 'Seepage run was interrupted before a solution became available.' });
  observe('seepage: relaunch for the generic error', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: a generic error', { type: 'error', runId: currentRunId('seepage'), error: 'Triangle failed to mesh the domain.' });
  observe('seepage: relaunch for the empty error', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: an error without a message', { type: 'error', runId: currentRunId('seepage') });
  observe('seepage: relaunch for onerror', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  reply('seepage', 'seepage: onerror', null, { onerror: true });
  observe('seepage: relaunch for the Stop button', () => api.stage6BishopRunSeepage(), { record: 'seepage' });
  observe('seepage: Stop button while running (cooperative stop)', () => { api.stage6BishopStopSeepage(); api.renderStage6(); });
  reply('seepage', 'seepage: result after the cooperative stop', { type: 'result', runId: currentRunId('seepage'), output: SEEPAGE_OUTPUT_INTERRUPTED });
  observe('seepage: Stop button while idle', () => { api.stage6BishopStopSeepage(); api.renderStage6(); });
  observe('seepage: silent stop terminates', () => { api.stage6BishopStopSeepage(true); api.renderStage6(); });

  // The deformation replies carry synthetic solver output, which the bishop panel's contour and
  // wall-response renderers would choke on; the shell moves to the bearing app for the walk so
  // renderStage6() renders another panel while the run state is exercised in full.
  observe("deformation: shell on 'bearing' for the synthetic replies", () => { S().stage6.app = 'bearing'; api.renderStage6(); });
  observe('deformation: launch', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  reply('deformation', 'deformation: progress meshing', { type: 'progress', runId: currentRunId('deformation'), progress: { percent: 8, message: 'Meshing...', stage: 'meshing' } });
  reply('deformation', 'deformation: progress solving', { type: 'progress', runId: currentRunId('deformation'), progress: { percent: 55, message: 'Solving...', stage: 'solving' } });
  reply('deformation', 'deformation: progress post', { type: 'progress', runId: currentRunId('deformation'), progress: { percent: 92, message: 'Post-processing...', stage: 'post' } });
  reply('deformation', 'deformation: progress with an unknown stage and no message', { type: 'progress', runId: currentRunId('deformation'), progress: { percent: 96, stage: 'whatever' } });
  reply('deformation', 'deformation: a stale runId is dropped', { type: 'progress', runId: currentRunId('deformation') + 100, progress: { percent: 1, message: 'nope', stage: 'meshing' } });
  for (const [label, output] of DEFORMATION_OUTPUTS) {
    reply('deformation', `deformation: result — ${label}`, { type: 'result', runId: currentRunId('deformation'), output });
    observe(`deformation: relaunch after "${label}"`, () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  }
  reply('deformation', 'deformation: result without a mesh', { type: 'result', runId: currentRunId('deformation'), output: { mesh: null, solver: { analysisType: 'deformation' }, summaries: {} } });
  observe('deformation: relaunch after the empty result', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  reply('deformation', 'deformation: result without an output at all', { type: 'result', runId: currentRunId('deformation') });
  for (const error of DEFORMATION_INTERRUPT_ERRORS) {
    observe(`deformation: relaunch for "${error.slice(0, 48)}…"`, () => api.stage6BishopRunDeformation(), { record: 'deformation' });
    reply('deformation', `deformation: ${error}`, { type: 'error', runId: currentRunId('deformation'), error });
  }
  observe('deformation: relaunch for the generic error', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  reply('deformation', 'deformation: a generic error', { type: 'error', runId: currentRunId('deformation'), error: 'The tangent matrix is singular.' });
  observe('deformation: relaunch for the empty error', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  reply('deformation', 'deformation: an error without a message', { type: 'error', runId: currentRunId('deformation') });
  observe('deformation: relaunch for onerror', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  reply('deformation', 'deformation: onerror', null, { onerror: true });
  observe('deformation: relaunch for the Stop button', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  observe('deformation: Stop button while running (cooperative stop)', () => { api.stage6BishopStopDeformation(); api.renderStage6(); });
  observe('deformation: Stop button while idle', () => { api.stage6BishopStopDeformation(); api.renderStage6(); });
  observe('deformation: silent stop terminates', () => { api.stage6BishopStopDeformation(true); api.renderStage6(); });

  // the T6 / js-cpu / total-load / production-msf option variants (the ~60-key block)
  observe('options: T6 mesh, js-cpu backend, total load, production-msf, staged off', () => {
    const o = B().deformation.options;
    o.meshElementType = 'T6';
    o.solverBackend = 'js-cpu';
    o.loadMode = 'total';
    o.totalLoad = 250;
    o.safetyFinalizationMode = 'production-msf';
    o.useStagedExcavation = false;
    o.useWallInterface = false;
    o.useSeepagePorePressures = true;
    o.allowStressOnlyGeostaticReference = true;
    o.geostaticProgressFailFast = true;
    o.serviceProgressFailFast = true;
    o.useUnsymmetricPlasticSolver = true;
  });
  observe('options: RunDeformation with the variant options', () => api.stage6BishopRunDeformation(), { record: 'deformation' });
  observe('options: a wall for lastWallInputs', () => {
    B().walls = [{ id: 'wall-1', head: { x: 6, y: 4 }, tip: { x: 6, y: -2 }, passiveSide: 'right', mechanicalActive: true }];
    api.renderStage6();
  });
  observe('options: RunDeformation with a wall', () => api.stage6BishopRunDeformation(), { record: 'deformation' });

  // ── (e) terminate on CPT switch (PLAN §4 defect 2)
  // Each run is tested on its own, because every run handler silently stops the other two before
  // it launches: after RunDeformation only the deformation worker is still alive.
  dump.switch = {};
  for (const kind of ['search', 'seepage', 'deformation']) {
    resetProject();
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, 'projects/multi-3cpt.madep.json'))], 'multi-3cpt.madep.json'));
    api.selectCpt(0);
    makeRunnable();
    S().stage6.app = 'bearing';
    observe(`switch/${kind}: launch on CPT 0`, () => {
      if (kind === 'search') api.stage6BishopRunSearch();
      else if (kind === 'seepage') api.stage6BishopRunSeepage();
      else api.stage6BishopRunDeformation();
    }, { record: kind });
    const worker = workerFor(WORKER_FILES[kind]);
    const runId = kind === 'search' ? B().progress.runId : B()[kind].progress.runId;
    const running = kind === 'search' ? B().progress.running : B()[kind].progress.running;
    observe(`switch/${kind}: selectCpt(1) — the worker of the CPT being left must be terminated`, () => api.selectCpt(1));
    const terminated = !!worker?.terminated;
    // The run-id guard in its real setting: a message from the abandoned run arrives while
    // *another* CPT is active. It must not touch CPT 1's block (map §3.4 #8).
    observe(`switch/${kind}: a late reply from the abandoned run while CPT 1 is active is dropped`, () => {
      if (!worker) return;
      worker.onmessage({ data: { type: 'progress', runId, progress: { percent: 90, message: 'late', stage: 'solving', trial: 9, total: 10 } } });
    });
    observe(`switch/${kind}: back to CPT 0`, () => api.selectCpt(0));
    const left = {
      running: kind === 'search' ? B().progress.running : B()[kind].progress.running,
      status: kind === 'search' ? null : B()[kind].status
    };
    dump.switch[kind] = { hadWorker: !!worker, wasRunning: running, terminated, left };
  }

  dump.workerLog = workerLog;
  dump.workerEvents = workerEvents;
  dump.idEvents = idEvents.length;
  unseedIds();

  // ── (f) working tree only: the package standalone
  if (pure) {
    const run = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/run/index.js');
    const model = await server.ssrLoadModule('/src/lib/cpt-app/seepslope/model/index.js');
    const p = {};

    // the eight pure builders over the same crafted inputs
    p.progress = {
      methodMode: ['bishop_spencer', 'bishop', '', null, undefined, 'nonsense'].map((m) => run.methodModeLabel(m)),
      seconds: [0, 1, 1234.56, -5, 1e9, NaN, null, undefined, 'x'].map((v) => run.secondsLabelFromMs(v)),
      flowError: [null, undefined, { flowError: 0 }, { flowError: 0.0042 }, { flowError: 1 }, {}].map((r) => run.seepageFlowErrorLabel(r)),
      safetyStatus: [undefined, {}, { safetyStatus: 'bracketed' }, { safetyStatus: 'aborted' }, { safetyResult: { finalization: { status: 'mechanism-developed' } }, safetyStatus: 'bracketed' }].map((s) => run.safetyFinalizationStatusFromSolver(s)),
      running: [{ methodMode: 'bishop_spencer' }, { methodMode: 'bishop' }, {}, null].map((b) => run.runningMessage(b)),
      ready: [[{ methodMode: 'bishop_spencer' }, true], [{ methodMode: 'bishop' }, true], [{}, false], [null, true]].map(([b, r]) => run.readyMessage(b, r)),
      complete: [[SEARCH_RESULT, SEARCH_RESULT.timing], [SEARCH_RESULT_BISHOP_ONLY, SEARCH_RESULT_BISHOP_ONLY.timing], [SEARCH_RESULT_SPENCER_FALLBACK, SEARCH_RESULT_SPENCER_FALLBACK.timing], [SEARCH_RESULT_NO_CRITICAL, null], [SEARCH_RESULT, {}], [SEARCH_RESULT, { totalMs: '900' }]].map(([r, t]) => run.completeMessage(r, t)),
      seepageComplete: [SEEPAGE_OUTPUT.result, SEEPAGE_OUTPUT_TIME_LIMIT.result, SEEPAGE_OUTPUT_INTERRUPTED.result, SEEPAGE_OUTPUT_FIXED.result, { ...SEEPAGE_OUTPUT_TIME_LIMIT.result, flowError: null }, null].map((r) => run.seepageCompleteMessage(r)),
      deformationComplete: DEFORMATION_OUTPUTS.map(([label, output]) => [label, run.deformationCompleteMessage('success', output)]).concat([['failed', run.deformationCompleteMessage('failed', DEFORMATION_OUTPUTS[0][1])]]),
      progressDom: [
        { progress: { running: true, trial: 12, total: 100, percent: 12.4, message: 'x' }, methodMode: 'bishop_spencer' },
        { progress: { running: false, message: 'Idle-ish', percent: 42 }, methodMode: 'bishop' },
        { progress: { running: false, message: '', percent: -5 }, methodMode: 'bishop' },
        { progress: { running: true, percent: 250 }, methodMode: 'bishop' }
      ].map((b) => run.searchProgressDom(b))
    };

    // the request builders replayed on the recorded pre-launch states
    p.requests = {};
    for (const snap of replay) {
      if (!['search', 'seepage', 'deformation'].includes(snap.key) || !snap.pre) continue;
      p.requests[snap.label] = { posted: snap.posted, controller: snap.post };
    }

    // the reducers replayed on the recorded pre-reply states
    p.reduce = {};
    // the stop patches vs the invalidation package's silent stops
    p.stopEquivalence = (() => {
      const make = () => ({
        progress: { running: true, percent: 40, previewCircle: { x: 1 }, message: 'm', runId: 3 },
        seepage: { status: 'solving', progress: { running: true, percent: 40, runId: 3 }, rejectReason: 'r' },
        deformation: { status: 'post', progress: { running: true, percent: 40, runId: 3 }, rejectReason: 'r' }
      });
      const out = {};
      for (const [kind, patchFn, stateFn] of [['search', run.stopSearchPatch, model.stopSearchState], ['seepage', run.stopSeepagePatch, model.stopSeepageState], ['deformation', run.stopDeformationPatch, model.stopDeformationState]]) {
        for (const status of ['idle', 'meshing', 'solving', 'post', 'success', 'failed']) {
          const a = make(); const b = make();
          if (kind !== 'search') { a[kind].status = status; b[kind].status = status; }
          run.applyRunPatch(a, patchFn(a, true));
          stateFn(b);
          out[`${kind}/${status}`] = { patched: JSON.stringify(a), stateWriter: JSON.stringify(b), equal: JSON.stringify(a) === JSON.stringify(b) };
        }
      }
      out.nonSilent = {
        seepageRunning: run.stopSeepagePatch({ seepage: { status: 'solving', progress: { running: true } } }, false),
        seepageIdle: run.stopSeepagePatch({ seepage: { status: 'idle', progress: { running: false } } }, false),
        deformationRunning: run.stopDeformationPatch({ deformation: { status: 'post', progress: { running: true } } }, false),
        deformationIdle: run.stopDeformationPatch({ deformation: { status: 'idle', progress: { running: false } } }, false),
        searchSilent: run.stopSearchPatch({ progress: {} }, true),
        searchLoud: run.stopSearchPatch({ progress: {} }, false),
        noBlock: [run.stopSearchPatch(null, true), run.stopSeepagePatch(null, true), run.stopDeformationPatch({}, true)]
      };
      return out;
    })();

    // the ~60 deformation option keys
    p.optionKeys = (() => {
      const bishop = { deformation: { options: {} } };
      const built = run.buildDeformationOptions(bishop);
      return { keys: Object.keys(built), count: Object.keys(built).length, defaults: built };
    })();
    p.messageShapes = {
      search: run.searchRequest(7, { a: 1 }),
      seepage: run.seepageRequest(8, { m: 1 }),
      deformation: run.deformationRequest(9, { m: 1 }, { o: 1 }),
      seepageStop: run.seepageStopMessage(8),
      deformationStop: run.deformationStopMessage(9),
      stopTypes: run.WORKER_STOP_TYPES,
      kinds: run.WORKER_KINDS,
      seepageInputModel: run.buildSeepageInputModel({ a: 1, seepage: { keep: 1, mesh: { nodes: [] }, result: { heads: [] } } }),
      seepageInputModelNoSeepage: run.buildSeepageInputModel({ a: 1 }),
      lastWallInputs: run.buildLastWallInputs({ walls: [{ id: 'w1', head: { x: 1, y: 2 }, tip: { x: 1, y: -3 }, passiveSide: 'left', mechanicalActive: true, extra: 'dropped' }, { id: 'w2', x: 5, yTop: 4, yTip: 0 }] }),
      lastWallInputsEmpty: run.buildLastWallInputs({})
    };

    // the worker adapter, driven directly with stub factories
    p.adapter = (() => {
      const built = [];
      const acts = [];
      class Stub {
        constructor(kind){ this.kind = kind; this.alive = true; built.push(kind); }
        postMessage(m){ acts.push(['post', this.kind, JSON.stringify(m)]); }
        terminate(){ this.alive = false; acts.push(['terminate', this.kind]); }
      }
      const factories = { search: () => new Stub('search'), seepage: () => new Stub('seepage'), deformation: () => new Stub('deformation') };
      const a = run.createWorkerAdapter({ factories, hasWorker: () => true });
      const messages = [];
      const w1 = a.ensure('search', { onMessage: (payload) => messages.push(['search', JSON.stringify(payload)]), onError: () => messages.push(['search', 'error']) });
      const w1again = a.ensure('search', {});
      w1.onmessage({ data: { type: 'progress', runId: 1 } });
      w1.onmessage({});
      const runIds = [a.runId('search'), a.nextRunId('search'), a.nextRunId('search'), a.runId('search'), a.runId('seepage')];
      a.post('search', { type: 'analyze', runId: 2 });
      const stops = [
        a.stop('search', { silent: false, runId: 2 }),   // no stop protocol → terminate
        a.stop('search', { silent: true })               // already gone
      ];
      a.ensure('seepage', {});
      stops.push(a.stop('seepage', { silent: false, runId: 5 }));   // cooperative
      stops.push(a.stop('seepage', { silent: false, runId: null })); // nothing to ask
      stops.push(a.stop('seepage', { silent: true }));               // terminate
      stops.push(a.stop('seepage', { silent: true }));               // gone
      const wErr = a.ensure('deformation', { onError: () => messages.push(['deformation', 'error']) });
      wErr.onerror(new Error('x'));
      const afterError = a.get('deformation');
      a.ensure('search', {}); a.ensure('seepage', {}); a.ensure('deformation', {});
      const terminatedAll = a.terminateAll();
      const noWorker = run.createWorkerAdapter({ factories, hasWorker: () => false });
      let unknown = null;
      try { a.ensure('nope', {}); } catch (e) { unknown = String(e.message); }
      return {
        built, acts, messages, runIds, stops,
        sameInstance: w1 === w1again,
        afterErrorIsNull: afterError === null,
        terminatedAll,
        noWorkerEnsure: noWorker.ensure('search', {}),
        noWorkerPost: noWorker.post('search', {}),
        noWorkerStop: noWorker.stop('search', { silent: true }),
        snapshot: a.snapshot(),
        unknown,
        defaultFactoryKinds: Object.keys(run.DEFAULT_WORKER_FACTORIES)
      };
    })();

    // the rejection helpers on synthetic blocks
    p.rejections = {
      searchNoModel: run.searchRejection({ entryZone: {}, exitZone: {} }, null),
      searchNoZones: run.searchRejection({ entryZone: null, exitZone: {} }, { a: 1 }),
      searchNoExit: run.searchRejection({ entryZone: {}, exitZone: null }, { a: 1 }),
      searchOk: run.searchRejection({ entryZone: {}, exitZone: {} }, { a: 1 }),
      searchNoWorker: run.searchNoWorkerPatch(),
      seepageNoWorker: run.seepageNoWorkerPatch(),
      deformationNoWorker: run.deformationNoWorkerPatch(),
      deformationAnalysisType: [{ deformation: { options: { analysisType: 'safety-cphi' } } }, { deformation: { options: { analysisType: 'deformation' } } }, {}].map((b) => run.deformationAnalysisType(b)),
      messages: [run.SEARCH_MESSAGES, run.SEEPAGE_MESSAGES, run.DEFORMATION_MESSAGES, run.DEFORMATION_INTERRUPT, run.SEEPAGE_INTERRUPT_ERROR, run.SEEPAGE_INTERRUPT_MESSAGE]
    };
    dump.pure = p;
    dump.replay = replay;
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
/** Every leaf difference between two JSON texts (firstDiff, but exhaustive). */
function allDiffs(aJson, bJson) {
  if (aJson === bJson) return [];
  let a, b;
  try { a = JSON.parse(aJson); b = JSON.parse(bJson); } catch { return ['<unparseable>']; }
  const out = [];
  const walk = (x, y, path) => {
    if (x === y) return;
    if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object') { out.push(`${path || '<root>'}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`); return; }
    const kx = Object.keys(x), ky = Object.keys(y);
    if (kx.join(' ') !== ky.join(' ')) { out.push(`${path || '<root>'}: key set/order ${JSON.stringify(kx)} → ${JSON.stringify(ky)}`); return; }
    for (const k of kx) walk(x[k], y[k], path ? `${path}.${k}` : k);
  };
  walk(a, b, '');
  return out;
}
const errorMessage = (e) => (e ? String(e).split(' | ')[0] : null);
const j = (v) => JSON.stringify(v);
// PR 18c commit 2: the only steps where the working tree is allowed to differ from the base, and
// only by clearing the run's own `progress.running` (see the "running-fix" group in the child).
const RUNNING_FIX_STEP = /^running-fix: Run\w+ rejected while a (search|solve) is in flight$/;
const RUNNING_FIX_PATH = { RunSearch: 'progress.running', RunSeepage: 'seepage.progress.running', RunDeformation: 'deformation.progress.running' };

const tmp = mkdtempSync(join(tmpdir(), 'verify-seepslope-run-'));
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

// ── (a)-(e) step by step
console.log(`\n(a)-(e) the runs, the replies and the stops — ${oldDump.steps.length} steps`);
check(`same step list (${oldDump.steps.length})`, j(oldDump.steps.map((d) => d.label)) === j(newDump.steps.map((d) => d.label)));
oldDump.steps.forEach((o, i) => {
  const n = newDump.steps[i] || {};
  const p = `step ${String(i + 1).padStart(3, '0')} ${o.label}`;
  check(`${p}: exception identical (${errorMessage(o.error) || 'none'})`, errorMessage(o.error) === errorMessage(n.error), `${errorMessage(o.error)} → ${errorMessage(n.error)}`);
  if (RUNNING_FIX_STEP.test(o.label)) {
    // The one intended behaviour change: the run flag, and nothing else.
    const path = RUNNING_FIX_PATH[o.label.split(' ')[1]];
    const diffs = allDiffs(o.bishop, n.bishop);
    check(`${p}: differs from the base ONLY by clearing ${path} (the PR 18c commit 2 fix)`,
      diffs.length === 1 && diffs[0] === `${path}: true → false`, j(diffs));
  } else {
    check(`${p}: S.stage6.bishop deep-equal + key order`, o.bishop === n.bishop, firstDiff(o.bishop, n.bishop));
  }
  check(`${p}: worker messages posted deep-equal (${o.workerEvents.length} events)`, j(o.workerEvents) === j(n.workerEvents), firstDiff(j(o.workerEvents), j(n.workerEvents)));
  check(`${p}: workers built identical`, j(o.workersBuilt.map((w) => w.file)) === j(n.workersBuilt.map((w) => w.file)) && j(o.workersBuilt.map((w) => w.options)) === j(n.workersBuilt.map((w) => w.options)),
    `${j(o.workersBuilt)} → ${j(n.workersBuilt)}`);
  const statusStrings = (s) => [s.message, s.seepageReason, s.seepageStatus, s.deformationReason, s.deformationStatus, s.deformationMessage, s.progressBar];
  if (RUNNING_FIX_STEP.test(o.label)) {
    // Clearing the search flag also changes what the progress line shows: the base keeps
    // rendering the "N/M Bishop trials" line of a run that is not coming back, the working tree
    // shows the rejection message. That is the visible half of the fix.
    check(`${p}: status strings identical; the progress line either matches or shows the message instead of a dead trial counter`,
      j(statusStrings(o)) === j(statusStrings(n))
      && (o.progressDom === n.progressDom || (/Bishop trials/.test(o.progressDom) && n.progressDom === n.message)),
      `${j([statusStrings(o), o.progressDom])} → ${j([statusStrings(n), n.progressDom])}`);
  } else {
    check(`${p}: status strings + progress DOM identical`,
      j(statusStrings(o).concat(o.progressDom)) === j(statusStrings(n).concat(n.progressDom)),
      `${j([o.message, o.deformationMessage, o.progressDom, o.progressBar])} → ${j([n.message, n.deformationMessage, n.progressDom, n.progressBar])}`);
  }
  check(`${p}: app / rAF errors / alerts / id events identical`, j([o.app, o.rafErrors, o.alerts, o.idEvents]) === j([n.app, n.rafErrors, n.alerts, n.idEvents]),
    `${j([o.app, o.rafErrors, o.alerts, o.idEvents])} → ${j([n.app, n.rafErrors, n.alerts, n.idEvents])}`);
  if ('area' in o) check(`${p}: #stage6Area byte-identical (${String(o.area).length} chars)`, o.area === n.area, firstTextDiff(o.area, n.area));
});
check('the full worker construction log is identical', j(oldDump.workerLog.map((w) => [w.file, w.options])) === j(newDump.workerLog.map((w) => [w.file, w.options])),
  `${j(oldDump.workerLog.map((w) => w.file))} → ${j(newDump.workerLog.map((w) => w.file))}`);
check('the full worker event log is identical', j(oldDump.workerEvents) === j(newDump.workerEvents), firstDiff(j(oldDump.workerEvents), j(newDump.workerEvents)));
check('same number of Date.now() / Math.random() calls over the whole walk', oldDump.idEvents === newDump.idEvents, `${oldDump.idEvents} → ${newDump.idEvents}`);

// what the walk actually proves
{
  const posts = newDump.workerEvents.filter((e) => e.kind === 'post').map((e) => JSON.parse(e.message));
  const byType = (t) => posts.filter((m) => m.type === t);
  check(`the walk posted every message type of map §5 (analyze ${byType('analyze').length}, run-seepage ${byType('run-seepage').length}, run-deformation ${byType('run-deformation').length}, stop-seepage ${byType('stop-seepage').length}, stop-deformation ${byType('stop-deformation').length})`,
    byType('analyze').length >= 12 && byType('run-seepage').length >= 12 && byType('run-deformation').length >= 25 && byType('stop-seepage').length >= 1 && byType('stop-deformation').length >= 1,
    j(posts.map((m) => m.type)));
  const deformation = byType('run-deformation');
  const optionKeys = deformation.map((m) => Object.keys(m.input.options).join(','));
  check(`every run-deformation message carries the same ~60 option keys (${deformation[0] ? Object.keys(deformation[0].input.options).length : 0})`,
    deformation.length > 0 && new Set(optionKeys).size === 1 && Object.keys(deformation[0].input.options).length >= 55,
    j([...new Set(optionKeys)].map((k) => k.split(',').length)));
  const search = byType('analyze');
  check('every analyze message carries model / entryZone / exitZone / methodMode / searchConfig / solverConfig / spencerConfig',
    search.length > 0 && search.every((m) => j(Object.keys(m.input)) === j(['model', 'entryZone', 'exitZone', 'methodMode', 'searchConfig', 'solverConfig', 'spencerConfig'])),
    j(search[0] && Object.keys(search[0].input)));
  const seepage = byType('run-seepage');
  check('every run-seepage message strips the previous mesh and result from the model',
    seepage.length > 0 && seepage.every((m) => m.input.model.seepage.mesh === null && m.input.model.seepage.result === null),
    j(seepage.map((m) => [m.input.model?.seepage?.mesh, m.input.model?.seepage?.result]).slice(0, 3)));
  const runIds = { analyze: search.map((m) => m.runId), seepage: seepage.map((m) => m.runId), deformation: deformation.map((m) => m.runId) };
  check('run ids are per kind and strictly increasing', Object.values(runIds).every((ids) => ids.every((v, i) => i === 0 ? v === 1 : v === ids[i - 1] + 1)), j(runIds));
  const noWorkerSteps = newDump.steps.filter((s) => s.label.startsWith('no-worker: Run'));
  check(`the no-Worker guard posts nothing and writes the same three rejections (${noWorkerSteps.length} steps)`,
    // Nothing is *posted* and no worker is built; a leftover worker from before the stub was
    // removed may still be terminated by the silent stops the handler makes on its way.
    noWorkerSteps.length === 3 && noWorkerSteps.every((s) => s.workerEvents.every((e) => e.kind === 'terminate') && s.workersBuilt.length === 0)
      && noWorkerSteps[0].message === 'Web Worker is not available in this browser context.'
      && noWorkerSteps[1].seepageReason === 'Web Worker is not available in this browser context.'
      && noWorkerSteps[2].deformationReason === 'Web Worker is not available in this browser context.',
    j(noWorkerSteps.map((s) => [s.workerEvents.length, s.message, s.seepageReason, s.deformationReason])));
  const stale = newDump.steps.filter((s) => /stale runId is dropped|late .*reply .* dropped/.test(s.label));
  const staleUnchanged = stale.filter((s) => {
    const idx = newDump.steps.indexOf(s);
    return newDump.steps[idx - 1].bishop === s.bishop;
  });
  check(`a reply whose runId is not the block's current one changes nothing (${stale.length} steps)`, stale.length >= 5 && staleUnchanged.length === stale.length,
    stale.filter((s) => !staleUnchanged.includes(s)).map((s) => `${s.label}: ${firstDiff(newDump.steps[newDump.steps.indexOf(s) - 1].bishop, s.bishop)}`).join('; '));
}

// ── (b2) the behaviour fix of PR 18c commit 2
console.log('\n(b2) a rejected run clears its own progress.running (PR 18c commit 2)');
for (const kind of ['search', 'seepage', 'deformation']) {
  const o = oldDump.runningFix[kind];
  const n = newDump.runningFix[kind];
  check(`${kind}: the scenario really had a run in flight and produced the same rejection in both trees`,
    o.launched === true && n.launched === true && o.message === n.message && o.message !== '' && (o.status ?? null) === (n.status ?? null),
    `${j(o)} → ${j(n)}`);
  check(`${kind}: the base leaves progress.running = true after the rejection (the defect) and the working tree clears it`,
    o.afterReject === true && n.afterReject === false, `base ${o.afterReject} → tree ${n.afterReject}`);
}

// ── (e) terminate on CPT switch — PLAN §4 defect 2 (fixed in PR 14, must still hold)
console.log('\n(e) terminate on CPT switch (PLAN §4 defect 2)');
check('base and working tree agree on the CPT-switch behaviour of all three runs', j(oldDump.switch) === j(newDump.switch), `${j(oldDump.switch)} → ${j(newDump.switch)}`);
for (const kind of ['search', 'seepage', 'deformation']) {
  const s = newDump.switch[kind];
  check(`selectCpt terminates the ${kind} worker of the CPT being left, and leaves no run running on it`,
    s.hadWorker === true && s.wasRunning === true && s.terminated === true && s.left.running === false,
    j(s));
}
check("the deformation worker in particular is terminated (PLAN §4 defect 2 — PR 14's fix still holds through the adapter)",
  newDump.switch.deformation.terminated === true && newDump.switch.deformation.left.running === false && newDump.switch.deformation.left.status !== 'solving',
  j(newDump.switch.deformation));

// ── (f) the package standalone
console.log('\n(f) the package standalone (working tree)');
{
  const p = newDump.pure;
  check('progress.js: methodModeLabel / secondsLabelFromMs / seepageFlowErrorLabel / safetyFinalizationStatusFromSolver over the crafted inputs',
    j(p.progress.methodMode) === j(['Bishop + Spencer check', 'Bishop only', 'Bishop only', 'Bishop only', 'Bishop only', 'Bishop only'])
    // [0, 1, 1234.56, -5, 1e9, NaN, null, undefined, 'x'] — Number(null) is 0, so null is "0 s"
    && j(p.progress.seconds) === j(['0 s', '1.00E-3 s', '1.235 s', '-5.00E-3 s', '1.00E+6 s', '—', '0 s', '—', '—'])
    // [null, undefined, {flowError:0}, {flowError:0.0042}, {flowError:1}, {}] — `!= null` is the gate
    && j(p.progress.flowError) === j(['—', '—', '0 %', '0.42 %', '100 %', '—'])
    && j(p.progress.safetyStatus) === j(['not-applicable', 'not-applicable', 'bracketed-failure', 'aborted', 'mechanism-developed']),
    j([p.progress.methodMode, p.progress.seconds, p.progress.flowError, p.progress.safetyStatus]));
  check('progress.js: runningMessage / readyMessage branch on methodMode and never read `S`',
    p.progress.running[0].startsWith('Running Bishop search; Spencer') && p.progress.running[1] === 'Running Bishop search...' && p.progress.running[3] === 'Running Bishop search...'
    && p.progress.ready[0] === 'Ready to run Bishop + Spencer check.' && p.progress.ready[1] === 'Ready to run Bishop search.' && p.progress.ready[2].startsWith('Draw terrain, place the active CPT'),
    j([p.progress.running, p.progress.ready]));
  check('progress.js: completeMessage covers the four search outcomes',
    p.progress.complete[0] === 'Search + Spencer check complete in 1235 ms.' && p.progress.complete[1] === 'Search complete in 987 ms.'
    && p.progress.complete[2] === 'Bishop search complete in 4321 ms; Spencer fell back to Bishop results.' && p.progress.complete[3] === 'Search completed with no valid slip circles.'
    && p.progress.complete[4] === 'Search + Spencer check complete in 0 ms.' && p.progress.complete[5] === 'Search + Spencer check complete in 900 ms.',
    j(p.progress.complete));
  check('progress.js: seepageCompleteMessage covers the four termination reasons and the missing flow error',
    p.progress.seepageComplete[0].startsWith('Seepage solved in') && p.progress.seepageComplete[1].includes('at the configured runtime limit. Latest flow-rate error')
    && p.progress.seepageComplete[2].includes('interrupted after') && p.progress.seepageComplete[3].includes('fixed phreatic boundary')
    && p.progress.seepageComplete[4].includes('showing the best available result') && p.progress.seepageComplete[5] === 'Seepage solved in — with flow-rate error —.',
    j(p.progress.seepageComplete));
  const dmsgs = Object.fromEntries(p.progress.deformationComplete);
  check(`progress.js: deformationCompleteMessage reaches every branch (${p.progress.deformationComplete.length} cases, all distinct where they must be)`,
    dmsgs['converged deformation'].startsWith('Deformation screen ready.')
    && dmsgs['partial, service phase started'].includes('last fully converged state')
    && !dmsgs['partial, service phase started, no gap'].includes('last fully converged state')
    && dmsgs['partial, initial phase only (gravity)'].includes('% gravity')
    && dmsgs['partial, initial phase only (predictor correction)'].includes('predictor-to-full-gravity correction')
    && dmsgs['tension cut-off active (initial phase)'].includes('n/a (tension cut-off active)')
    && dmsgs['tension cut-off active (service phase)'].includes('n/a (tension cut-off active)')
    && dmsgs['infinite mc eta'].includes('∞')
    && dmsgs['one inadmissible predictor element'].includes('1 inadmissible predictor element.')
    && dmsgs['three inadmissible predictor elements'].includes('3 inadmissible predictor elements.')
    && dmsgs['safety bracketed failure'].startsWith('C-phi reduction bracketed failure between')
    && dmsgs['safety mechanism developed'].startsWith('C-phi reduction developed a coherent mechanism')
    && dmsgs['safety open ended (no failure found)'].includes('remained stable up to')
    && dmsgs['safety open ended (flag)'].includes('remained stable up to')
    && dmsgs['safety other status'].includes('with status load step floor')
    && dmsgs['safety legacy bracketed status'].startsWith('C-phi reduction bracketed failure')
    && dmsgs['safety legacy unknown status'].includes('with status aborted')
    && dmsgs['safety with no status at all'].includes('with status not applicable')
    && dmsgs.failed === 'Deformation solve failed.',
    j(p.progress.deformationComplete.slice(0, 4)));
  check('progress.js: searchProgressDom text and bar width (running, idle, empty message, clamped percent)',
    j(p.progress.progressDom) === j([
      { text: 'Bishop + Spencer check · 12/100 Bishop trials (12%)', width: '12.4%' },
      { text: 'Idle-ish', width: '42%' },
      { text: 'Idle', width: '0%' },
      { text: 'Bishop only · 0/0 Bishop trials (250%)', width: '100%' }
    ]), j(p.progress.progressDom));

  const stopEq = Object.entries(p.stopEquivalence).filter(([k]) => k.includes('/'));
  check(`stopSearchPatch / stopSeepagePatch / stopDeformationPatch (silent) == seepslope/model's stop*State (${stopEq.length} combinations)`,
    stopEq.every(([, v]) => v.equal), stopEq.filter(([, v]) => !v.equal).map(([k, v]) => `${k}: ${firstDiff(v.stateWriter, v.patched)}`).join('; '));
  const ns = p.stopEquivalence.nonSilent;
  check('the Stop button (non-silent) writes only the message + reason, and a missing block patches nothing',
    ns.seepageRunning['seepage.progress.message'] === 'Stopping seepage and keeping the latest solved state...' && ns.seepageIdle['seepage.progress.message'] === 'No seepage run is active.'
    && ns.deformationRunning['deformation.progress.message'] === 'Stopping deformation and keeping the latest solved state...' && ns.deformationIdle['deformation.progress.message'] === 'No deformation run is active.'
    && ns.searchSilent['progress.message'] === undefined && ns.searchLoud['progress.message'] === 'Bishop search stopped.'
    && j(ns.noBlock) === j([{}, {}, {}]),
    j(ns));

  check(`the deformation option block has ${p.optionKeys.count} keys in the monolith's order`,
    p.optionKeys.count === 55 && p.optionKeys.keys[0] === 'analysisType' && p.optionKeys.keys[p.optionKeys.count - 1] === 'wasmRobustNonlinearMode'
    && p.optionKeys.defaults.initialStressMode === 'plastic-geostatic' && p.optionKeys.defaults.useStagedGeostaticInit === true
    && p.optionKeys.defaults.useNewGpuPipeline === false && p.optionKeys.defaults.gpuPipelineVersion === 'v1' && p.optionKeys.defaults.wasmRobustNonlinearMode === false
    && p.optionKeys.defaults.useStagedExcavation === true && p.optionKeys.defaults.useWallInterface === true
    && p.optionKeys.defaults.solverBackend === 'wasm-cpu' && p.optionKeys.defaults.useWasmCpuPipeline === true
    && p.optionKeys.defaults.meshElementType === 't3' && p.optionKeys.defaults.loadMode === 'pressure' && p.optionKeys.defaults.safetyFinalizationMode === 'legacy-bracket',
    `${p.optionKeys.count} keys: ${j(p.optionKeys.keys)}`);
  const ms = p.messageShapes;
  check('the message shapes are exactly the worker contracts of map §5',
    j(ms.search) === j({ type: 'analyze', runId: 7, input: { a: 1 } })
    && j(ms.seepage) === j({ type: 'run-seepage', runId: 8, input: { model: { m: 1 } } })
    && j(ms.deformation) === j({ type: 'run-deformation', runId: 9, input: { model: { m: 1 }, options: { o: 1 } } })
    && j(ms.seepageStop) === j({ type: 'stop-seepage', runId: 8 })
    && j(ms.deformationStop) === j({ type: 'stop-deformation', runId: 9 })
    && j(ms.stopTypes) === j({ search: null, seepage: 'stop-seepage', deformation: 'stop-deformation' })
    && j(ms.kinds) === j(['search', 'seepage', 'deformation']),
    j([ms.search, ms.seepage, ms.deformation, ms.stopTypes]));
  check('buildSeepageInputModel keeps the model and nulls mesh + result; buildLastWallInputs keeps the eight snapshot fields',
    j(ms.seepageInputModel) === j({ a: 1, seepage: { keep: 1, mesh: null, result: null } })
    && j(ms.seepageInputModelNoSeepage) === j({ a: 1, seepage: { mesh: null, result: null } })
    && j(ms.lastWallInputs) === j([
      { id: 'w1', head: { x: 1, y: 2 }, tip: { x: 1, y: -3 }, x: undefined, yTop: undefined, yTip: undefined, passiveSide: 'left', mechanicalActive: true },
      { id: 'w2', head: null, tip: null, x: 5, yTop: 4, yTip: 0, passiveSide: undefined, mechanicalActive: false }
    ].map((o) => JSON.parse(JSON.stringify(o))))
    && j(ms.lastWallInputsEmpty) === j([]),
    j([ms.seepageInputModel, ms.lastWallInputs]));

  const a = newDump.pure.adapter;
  check('the adapter builds one worker per kind on demand and hands the same instance back',
    a.sameInstance === true && j(a.built) === j(['search', 'seepage', 'deformation', 'search', 'seepage', 'deformation']) && j(a.defaultFactoryKinds) === j(['search', 'seepage', 'deformation']),
    j([a.sameInstance, a.built]));
  check('the adapter routes onmessage to the handler with the payload (an empty event → {})',
    j(a.messages) === j([['search', j({ type: 'progress', runId: 1 })], ['search', '{}'], ['deformation', 'error']]), j(a.messages));
  check('run ids are per kind, start at 0 and are monotonic', j(a.runIds) === j([0, 1, 2, 2, 0]), j(a.runIds));
  check('stop(): the search worker is terminated whatever the flag; seepage asks cooperatively, then terminates',
    j(a.stops) === j(['terminated', 'none', 'requested', 'none', 'terminated', 'none']), j(a.stops));
  check('onerror terminates the worker after the host handler has run; terminateAll clears every kind',
    a.afterErrorIsNull === true && j(a.terminatedAll) === j(['search', 'seepage', 'deformation']) && j(a.snapshot) === j({ search: { alive: false, runId: 2 }, seepage: { alive: false, runId: 0 }, deformation: { alive: false, runId: 0 } }),
    j([a.afterErrorIsNull, a.terminatedAll, a.snapshot]));
  check('without a Worker constructor ensure() returns null and post/stop are no-ops; an unknown kind throws',
    a.noWorkerEnsure === null && a.noWorkerPost === false && a.noWorkerStop === 'none' && /unknown worker kind: nope/.test(a.unknown || ''), j([a.noWorkerEnsure, a.noWorkerPost, a.noWorkerStop, a.unknown]));

  const r = p.rejections;
  check('the pure rejections match the monolith strings and the pre-flight order',
    r.searchNoModel.reason === 'no-model' && r.searchNoZones.reason === 'no-zones' && r.searchNoExit.reason === 'no-zones' && r.searchOk === null
    // the `*.progress.running: false` is the PR 18c commit 2 fix
    && j(r.searchNoWorker) === j({ 'progress.message': 'Web Worker is not available in this browser context.', 'progress.running': false })
    && j(r.seepageNoWorker) === j({ 'seepage.rejectReason': 'Web Worker is not available in this browser context.', 'seepage.status': 'failed', 'seepage.progress.running': false })
    && j(r.deformationNoWorker) === j({ 'deformation.rejectReason': 'Web Worker is not available in this browser context.', 'deformation.status': 'failed', 'deformation.progress.running': false })
    && j(r.deformationAnalysisType) === j(['safety-cphi', 'deformation', 'deformation']),
    j(r));
}

// ── the request builders replayed against what the controller posted
console.log('\n(f) request builders vs the messages the controller posted');
{
  const KIND_TYPE = { search: 'analyze', seepage: 'run-seepage', deformation: 'run-deformation' };
  const snaps = newDump.replay.filter((s) => KIND_TYPE[s.key] && s.posted.length);
  check(`every launch that posted was recorded with its pre-state (${snaps.length})`, snaps.length >= 40, `${snaps.length}`);
  let mismatched = 0;
  for (const snap of snaps) {
    const posted = JSON.parse(snap.posted[0]);
    if (posted.type !== KIND_TYPE[snap.key]) mismatched += 1;
  }
  check('every recorded launch posted exactly one message of its own type', mismatched === 0, `${mismatched} mismatched`);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
