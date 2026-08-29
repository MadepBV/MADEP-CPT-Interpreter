#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 7 / PR 12c (worklog/refactor/17-pr12c-settlement-dewatering-beam.md):
// the settlement, dewatering and beam packages (src/lib/cpt-app/{settlement,dewatering,beam}/**)
// must be pure moves out of legacy-controller.js. Pattern of scripts/verify_bearing.mjs /
// verify_pile.mjs: the controller of a base ref (default `integration-r`) and the working-tree
// controller are each loaded under Node through the Tier-B loader (scripts/golden/lib/
// load-controller.mjs: Vite ssrLoadModule + DOM stub) in their own child process, dump the same
// observations to JSON, and the parent compares the two dumps byte for byte (JSON text, key order
// included):
//
//   (a) demo-anonymous (sb260 → goS(3) → goS(5)), each of the three apps selected: #stage6Area
//       innerHTML, every Chart.js config (the loader's Chart stub keeps them; the beam tick
//       formatters are sampled since JSON drops functions), the cached analysis, the clamped config,
//       cache keys, rAF errors and alerts — for the defaults, a second renderStage6(), the golden
//       suite's "heavy" / "edge" configs, the defaults again, then **every inline
//       `setStage6Field('<app>.…')` handler the markup carries** (16 settlement, 16 dewatering, 36
//       beam — each with a value that differs from the defaults, in an order that also renders the
//       conditional inputs: circular D, time horizon, the three dewatering geometries, Pasternak
//       coupling, patch / point loads), every <details> accordion open and closed again. For the beam
//       app the geometry preview is exercised too: #stage6BeamGeometryCanvas is made a real-looking
//       canvas (instanceof HTMLCanvasElement, a layout box) whose 2D context records every call and
//       property set — the draw log is compared verbatim.
//   (b) the same (defaults + heavy) for every CPT of the three project fixtures
//       (tests/golden/fixtures/projects/*)
//   (c) tests/golden/node/stage6-{settlement,dewatering,beam}/* recomputed from the pure package
//       functions — state.js defaults()/ensure(), compute.js <app>Analysis() (+ subgradeReaction),
//       panel.js <app>BodyHtml() inside the shell package's cards + banner — on the Stage 2–5 chain
//       of the working-tree controller: the file text must be byte-identical to the golden on disk
//   (d) registry / package consistency: stage6/apps/<app>-state.js re-exports <app>/state.js, the
//       registry entry is the package's state + cardMeta, install<App>App() returns the retaining
//       shape, the explicit-input contract of compute.js (no hidden water table / layers)
//
// Usage
//   node scripts/verify_settlement_dewatering_beam.mjs                   compare against integration-r
//   node scripts/verify_settlement_dewatering_beam.mjs --base <ref>      compare against another git ref
//   node scripts/verify_settlement_dewatering_beam.mjs --snapshot f.json dump the working tree only
//   node scripts/verify_settlement_dewatering_beam.mjs --against f.json  compare the working tree with a dump
//
// The base controller is materialised as src/lib/cpt-app/__verify-sdb-base.legacy-controller.js
// (its relative imports need that directory); MOVED_SIBLINGS (pattern of verify_pile.mjs) would hand
// it the base's own copy of any sibling module a PR moves — this PR moves none the base imports
// (stage6/apps/*-state.js stay as re-exports), so the list is empty. Deleted again, whatever happens.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-sdb-base.legacy-controller.js';
// Sibling modules the base controller may import relative to itself that the working tree no
// longer has at that path: [old relative path, import specifier(s) as written in the base].
const MOVED_SIBLINGS = [];
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
const DEMO_FIXTURE = 'demo-anonymous';
/** The apps whose package exists in the working tree (one commit per app; (c)/(d) run for these). */
const PACKAGED = ['settlement', 'dewatering'];

// The golden suites' configs (scripts/golden/suites/stage6-{settlement,dewatering,beam}.mjs), verbatim.
const APPS = {
  settlement: {
    chartIds: ['stage6SettlementStressChart', 'stage6SettlementCumulativeChart', 'stage6SettlementTimeChart'],
    details: ['settlement-loads'],
    heavy: { footingType: 'rectangular', B: 6.0, L: 12.0, Df: 2.5, Gk: 600, QLead: 200, QOther: 40, useCategory: 'C', combination: 'char', stressMethod: 'two_to_one', dz: 0.2, includeTime: true, timeDays: 365, allowableSettlement: 15 },
    edge: (S) => ({ footingType: 'circular', B: 0.3, L: 0.3, Df: S.layers.at(-1).bot + 5, Gk: 0, QLead: 0, QOther: 0, dz: 0.5, includeTime: true, timeDays: 0 }),
    // every inline handler of renderStage6SettlementApp, page order, the conditional inputs made visible first
    fields: [
      ['settlement.footingType', 'circular'], ['settlement.D', '3'], ['settlement.footingType', 'strip'], ['settlement.B', '3.5'], ['settlement.L', '5'],
      ['settlement.Df', '1.8'], ['settlement.stressMethod', 'two_to_one'], ['settlement.truncationRule', '10%_sigma_eff'], ['settlement.truncationRule', '20%_q_net'],
      ['settlement.dz', '0.25'], ['settlement.allowableSettlement', '40'], ['settlement.includeTime', true], ['settlement.timeDays', '400'],
      ['settlement.combination', 'frequent'], ['settlement.useCategory', 'E'], ['settlement.Gk', '200'], ['settlement.QLead', '60'], ['settlement.QOther', '15']
    ]
  },
  dewatering: {
    chartIds: ['stage6DewateringDrawdownChart', 'stage6DewateringStressChart', 'stage6DewateringSettlementChart', 'stage6DewateringTimeChart'],
    details: [],
    heavy: { combination: 'quasi-permanent', targetWt: 6.0, geometry: 'equivalent_well_rectangular_excavation', aquiferType: 'confined', rw: 0.2, rCPT: 3.0, LPit: 30, BPit: 20, LTrench: 40, distanceToCPT: 4.0, CSichardt: 2000, sigmaVMode: 'realistic', aquiferBaseDepth: 12, dz: 0.2, timeDays: 30 },
    edge: (S) => ({ geometry: 'line_dewatering_trench', targetWt: S.layers.at(-1).bot + 5, rCPT: 0, distanceToCPT: 0, dz: 0.5, timeDays: 0, aquiferBaseDepth: null }),
    fields: [
      ['dewatering.combination', 'qp'], ['dewatering.targetWt', (S) => (S.wt + 1.5).toFixed(2)], ['dewatering.aquiferType', 'confined'],
      ['dewatering.rw', '0.25'], ['dewatering.rCPT', '4'],
      ['dewatering.geometry', 'equivalent_well_rectangular_excavation'], ['dewatering.LPit', '20'], ['dewatering.BPit', '10'], ['dewatering.rCPT', '6'],
      ['dewatering.geometry', 'line_dewatering_trench'], ['dewatering.LTrench', '30'], ['dewatering.distanceToCPT', '5'],
      ['dewatering.CSichardt', '2000'], ['dewatering.sigmaVMode', 'realistic'], ['dewatering.dz', '0.2'], ['dewatering.timeDays', '60'],
      // last: KNOWN_DEFECTS — the page throws from here on (the state keeps the string)
      ['dewatering.aquiferBaseDepth', '8']
    ]
  },
  beam: {
    chartIds: ['stage6BeamDeflectionChart', 'stage6BeamMomentChart'],
    details: ['beam-loads'],
    geometry: true,
    heavy: { modelMode: 'beam_length', foundationModel: 'winkler', B: 2.0, b: 0.6, L: 12.0, h: 0.6, Df: 1.2, EsMode: 'oedometric', zInfluence: 4.0, gpEta: 0.8, loadPattern: 'point_at_x', Gk: 120, QLead: 60, QOther: 10, useCategory: 'B', ulsCombination: 'A2', xLoad: 4.0, nElements: 200, fck: 35, fyk: 500, exposureClass: 'XD2', phiBar: 16, designLifeYears: 100, isSlabOrPlate: false, castAgainstUnevenSurface: true },
    edge: () => ({ modelMode: 'footing_transverse', L: 0.5, h: 0.1, Gk: 0, QLead: 0, QOther: 0, nElements: 4, loadPattern: 'uniform_patch', xStart: 0.1, xEnd: 0.2, gpOverride: 5, cNomOverride: 60 }),
    fields: [
      ['beam.modelMode', 'beam_length'], ['beam.B', '2'], ['beam.b', '0.6'], ['beam.L', '8'], ['beam.h', '0.5'], ['beam.Df', '1.2'], ['beam.Ec', '30000000'],
      ['beam.gpEta', '0.8'], ['beam.gpOverride', '4000'], ['beam.foundationModel', 'winkler'], ['beam.EsMode', 'young_drained'], ['beam.zInfluence', '4'],
      ['beam.loadPattern', 'uniform_patch'], ['beam.xStart', '2'], ['beam.xEnd', '5'], ['beam.loadPattern', 'point_at_x'], ['beam.xLoad', '2.5'], ['beam.loadPattern', 'point_centre'],
      ['beam.allowableDeflectionRatio', '300'], ['beam.slsCombination', 'characteristic'], ['beam.ulsCombination', 'A2'], ['beam.useCategory', 'B'],
      ['beam.Gk', '60'], ['beam.QLead', '25'], ['beam.QOther', '5'],
      ['beam.fck', '35'], ['beam.fyk', '400'], ['beam.exposureClass', 'XD2'], ['beam.designLifeYears', '100'], ['beam.phiBar', '16'], ['beam.dG', '32'], ['beam.deltaCdev', '5'], ['beam.cNomOverride', '55'],
      ['beam.isSlabOrPlate', false], ['beam.specialQC', true], ['beam.castAgainstUnevenSurface', true], ['beam.castAgainstPreparedGround', true], ['beam.castAgainstUnpreparedGround', true],
      ['beam.modelMode', 'footing_transverse']
    ]
  }
};
const APP_IDS = Object.keys(APPS);
// Monolith defects the pure move keeps (report §6): the scenario throws the same error in the base
// and in the working tree, and the comparison asserts exactly that instead of "no exception".
//   dewatering.aquiferBaseDepth defaults to null, so setStage6Field stores the input's string as-is
//   (stage6/field-setter.js coerces numbers only after a number default) and the next render's
//   `cfg.aquiferBaseDepth.toFixed(2)` throws — every later dewatering render on that CPT too.
const KNOWN_DEFECTS = [
  { step: "setStage6Field('dewatering.aquiferBaseDepth'", error: /cfg\.aquiferBaseDepth\.toFixed is not a function/ }
];
const TICK_SAMPLES = [0, 1.5, 1234.5678, -0.004567, 250000];

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
  // The beam geometry preview draws only on a real <canvas> with a layout box; give the stub element
  // both and a recording 2D context so the draw calls become an observation.
  const drawLog = [];
  const geomCanvas = stub.document.getElementById('stage6BeamGeometryCanvas');
  Object.setPrototypeOf(geomCanvas, globalThis.HTMLCanvasElement.prototype);
  geomCanvas.getBoundingClientRect = () => ({ width: 640, height: 220, left: 0, top: 0, right: 640, bottom: 220, x: 0, y: 0 });
  geomCanvas.width = 0; geomCanvas.height = 0;
  const recCtx = new Proxy({}, {
    get: (t, k) => (typeof k === 'string' ? (...a) => { drawLog.push([k, ...a]); } : undefined),
    set: (t, k, v) => { drawLog.push(['=', k, v]); return true; }
  });
  geomCanvas.getContext = () => recCtx;
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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred, label, timeout = 15000) {
    const t0 = Date.now();
    while (!pred()) { if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}`); await sleep(5); }
  }
  const S = () => api.PROJECT.cpts[api.PROJECT.activeCptIdx];
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
    const fname = basename(fileRel);
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
  // JSON with undefined / NaN / ±Infinity made visible, key order preserved (no sorting); functions
  // (chart tick formatters, dewatering.waterTableAtDistance) are dropped as in the golden normaliser.
  const ser = (v) => JSON.stringify(v, (k, x) => (x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
  const area = () => stub.document.getElementById('stage6Area').innerHTML;
  const chartConfig = (id) => { const c = stub.document.getElementById(id)._chartRef; return c ? ser(c.config) : null; };
  /** The tick / tooltip formatters of a chart config, sampled (JSON drops the functions). */
  const chartFns = (id) => {
    const c = stub.document.getElementById(id)._chartRef;
    if (!c) return null;
    const out = {};
    for (const axis of ['x', 'y']) {
      const cb = c.config?.options?.scales?.[axis]?.ticks?.callback;
      if (typeof cb === 'function') out[`${axis}.ticks`] = TICK_SAMPLES.map((v) => String(cb(v)));
    }
    const label = c.config?.options?.plugins?.tooltip?.callbacks?.label;
    if (typeof label === 'function') out.tooltip = TICK_SAMPLES.map((v) => { try { return String(label({ parsed: { x: v / 3, y: v }, raw: { x: v / 3, y: v }, dataset: { label: 'w' }, label: String(v) })); } catch (e) { return `throws ${e.message}`; } });
    return out;
  };
  /** Everything an app leaves behind after a render. */
  function observe(app) {
    const spec = APPS[app];
    const out = {
      selected: S().stage6.app,
      html: area(),
      htmlLength: area().length,
      charts: Object.fromEntries(spec.chartIds.map((id) => [id, chartConfig(id)])),
      chartFns: Object.fromEntries(spec.chartIds.map((id) => [id, chartFns(id)])),
      analysis: ser(S().stage6Cache?.[app] ?? null),
      cfg: ser(S().stage6[app]),
      cacheKeys: Object.keys(S().stage6Cache || {}).sort(),
      rafErrors: stub.rafErrors.map((e) => e.split('\n')[0]),
      alerts: stub.alerts.slice()
    };
    if (spec.geometry) out.geometry = { calls: drawLog.length, log: ser(drawLog), width: geomCanvas.width, height: geomCanvas.height };
    return out;
  }
  function renderWith(app, label, fn) {
    stub.rafErrors.length = 0; stub.alerts.length = 0; drawLog.length = 0;
    // clean slate for the chart refs: a config left by the previous render must not pass as this one's
    for (const id of APPS[app].chartIds) stub.document.getElementById(id)._chartRef = null;
    let error = null;
    try { fn(); } catch (e) { error = String(e?.stack || e).split('\n').slice(0, 3).join(' | '); }
    return { label, error, ...observe(app) };
  }
  const value = (v) => (typeof v === 'function' ? v(S()) : v);
  /** The app's page through every path it has: defaults, re-render, golden configs, every field, accordions. */
  function walk(app) {
    const spec = APPS[app];
    const steps = [];
    steps.push(renderWith(app, 'default', () => api.setStage6App(app)));
    steps.push(renderWith(app, 'rerender', () => api.renderStage6()));
    steps.push(renderWith(app, 'heavy', () => { Object.assign(S().stage6[app], spec.heavy); api.renderStage6(); }));
    steps.push(renderWith(app, 'edge', () => { Object.assign(S().stage6[app], spec.edge(S())); api.renderStage6(); }));
    steps.push(renderWith(app, 'defaults-again', () => { Object.assign(S().stage6[app], api.stage6Defaults()[app]); api.renderStage6(); }));
    for (const [field, v] of spec.fields) steps.push(renderWith(app, `setStage6Field('${field}', ${JSON.stringify(value(v))})`, () => api.setStage6Field(field, value(v))));
    if (spec.details.length) {
      steps.push(renderWith(app, 'details-open', () => { for (const k of spec.details) S().stage6.ui.details[k] = true; api.renderStage6(); }));
      steps.push(renderWith(app, 'details-closed', () => { S().stage6.ui.details = {}; api.renderStage6(); }));
    }
    return steps;
  }
  const dump = { controller: ctrlRel, demo: {}, projects: {}, pure: {} };

  // (a) demo fixture, the three apps
  await classify(DEMO_FIXTURE);
  for (const app of APP_IDS) dump.demo[app] = walk(app);

  // (b) the project fixtures
  for (const name of PROJECT_FIXTURES) {
    resetProject();
    const rel = `projects/${name}.madep.json`;
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, rel))], `${name}.madep.json`));
    const perCpt = [];
    for (let i = 0; i < api.PROJECT.cpts.length; i += 1) {
      api.selectCpt(i);
      const obs = { id: S().id, layers: S().layers.length, apps: {} };
      for (const app of APP_IDS) {
        obs.apps[app] = {
          default: renderWith(app, `${name}[${i}].${app}`, () => api.setStage6App(app)),
          heavy: renderWith(app, `${name}[${i}].${app}.heavy`, () => { Object.assign(S().stage6[app], APPS[app].heavy); api.renderStage6(); })
        };
      }
      perCpt.push(obs);
    }
    dump.projects[name] = perCpt;
  }

  // (c) the golden suites recomputed with the pure packages (working tree only)
  if (pure) {
    const { normalize, normalizeText, digest } = await import('./golden/lib/normalize.mjs');
    const { stableJson } = await import('./golden/lib/store.mjs');
    const { htmlToText } = await import('./golden/lib/html-text.mjs');
    const { workingLayers } = await import('../src/lib/cpt-app/model-params/index.js');
    const { layerBottom, detailsOpen, createStage6Registry, createStage6Shell } = await import('../src/lib/cpt-app/stage6/index.js');
    // The app switch + shared banner around the body come from the shell package (pure: registry
    // + the active CPT), the same way renderStage6() composes #stage6Area.
    const shell = createStage6Shell({
      registry: createStage6Registry({ retaining: { cardMeta: { id: 'retwall', title: 'Retaining walls', desc: '' }, defaults: () => ({}), ensure: () => {} } }),
      getState: () => S(), ensure() {}, rememberDetailsState() {}, workingLayers: () => [], apps: {}
    });
    const names = Object.entries(manifest.fixtures).filter(([k, e]) => k.startsWith('cpt/') && e.role === 'profile').map(([k]) => k.slice(4).replace(/\.(gef|state\.json)$/, '')).filter((n) => !['trailing-qc-only', 'wt-above-surface'].includes(n));
    const pkgs = {};
    for (const app of PACKAGED) pkgs[app] = await import(`../src/lib/cpt-app/${app}/index.js`);
    // per app: the analysis + body of the package on explicit inputs
    const run = {
      settlement: (pkg, cfg, layers, cpt, stage6) => ({ analysis: pkg.settlementAnalysis(cfg, layers, { wt: cpt.wt }), body: (a) => pkg.settlementBodyHtml(a, cfg, { detailsOpen: (key) => detailsOpen(stage6, key) }) }),
      dewatering: (pkg, cfg, layers, cpt) => ({ analysis: pkg.dewateringAnalysis(cfg, layers, { wt: cpt.wt }), body: (a) => pkg.dewateringBodyHtml(a, cfg, { wt: cpt.wt }) }),
      beam: (pkg, cfg, layers, cpt, stage6) => ({ analysis: pkg.beamAnalysis(cfg, layers, { wt: cpt.wt }), body: (a) => pkg.beamBodyHtml(a, cfg, { detailsOpen: (key) => detailsOpen(stage6, key) }) })
    };
    const slim = { beam: (a) => (a?.ksInfo?.profile ? { ...a, ksInfo: { ...a.ksInfo, profile: digest(a.ksInfo.profile) } } : a) };
    for (const app of PACKAGED) dump.pure[app] = {};
    for (const fx of names) {
      await classify(fx);
      const cpt = S();
      const layers = workingLayers(cpt);
      const env = { maxDepth: Math.max(layerBottom(cpt), 0.5), wt: cpt.wt };
      for (const app of PACKAGED) {
        const pkg = pkgs[app];
        const out = dump.pure[app];
        const stage6 = { [app]: pkg.defaults(), ui: { details: {} } };
        pkg.ensure(stage6, env);
        const cfg = stage6[app];
        let r = run[app](pkg, cfg, layers, cpt, stage6);
        out[`${fx}.default.json`] = stableJson(normalize(r.analysis));
        out[`${fx}.default.config.json`] = stableJson(normalize(cfg));
        out[`${fx}.default.dom.txt`] = normalizeText(htmlToText(`${shell.cardsHtml(app)}${shell.sharedBanner()}${r.body(r.analysis)}`));
        for (const [label, c] of [['heavy', APPS[app].heavy], ['edge', APPS[app].edge]]) {
          Object.assign(cfg, typeof c === 'function' ? c(cpt) : c);
          pkg.ensure(stage6, env);
          r = run[app](pkg, cfg, layers, cpt, stage6);
          out[`${fx}.${label}.json`] = stableJson(normalize(slim[app] ? slim[app](r.analysis) : r.analysis));
          out[`${fx}.${label}.config.json`] = stableJson(normalize(cfg));
        }
        out[`${fx}.alerts.json`] = stableJson(normalize([]));
        if (app === 'beam') {
          // the suite's `extra`: computeSubgradeReaction on the state after the edge render
          out[`${fx}.subgrade.json`] = stableJson(normalize([{}, { B: 3, zInfluence: 2 }, { EsMode: 'E50', gpEta: 0.5 }].map((c) => ({ cfg: c, ks: (({ profile, ...ks }) => ({ ...ks, profile: digest(profile) }))(pkg.subgradeReaction({ ...cfg, ...c }, layers, { wt: cpt.wt })) }))));
        }
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
/** Compare one observation of the base with the same of the working tree. */
const errorMessage = (e) => (e ? String(e).split(' | ')[0] : null);
function compareObservation(app, prefix, o, n) {
  const known = KNOWN_DEFECTS.find((k) => prefix.includes(k.step));
  if (known) check(`${prefix}: both throw the known monolith error (${known.error.source.slice(0, 40)}…)`, known.error.test(o.error || '') && known.error.test(n.error || ''), `${errorMessage(o.error)} → ${errorMessage(n.error)}`);
  else check(`${prefix}: no exception in either`, !o.error && !n.error, o.error || n.error || '');
  check(`${prefix}: exception message identical`, errorMessage(o.error) === errorMessage(n.error), `${errorMessage(o.error)} → ${errorMessage(n.error)}`);
  check(`${prefix}: selected app`, o.selected === n.selected, `${o.selected} → ${n.selected}`);
  check(`${prefix}: #stage6Area innerHTML byte-identical (${o.htmlLength} chars)`, o.html === n.html, firstTextDiff(o.html, n.html));
  for (const id of APPS[app].chartIds) {
    check(`${prefix}: ${id} config identical${o.charts[id] == null ? ' (no chart)' : ''}`, o.charts[id] === n.charts[id], firstDiff(o.charts[id], n.charts[id]));
    check(`${prefix}: ${id} tick / tooltip formatters identical`, JSON.stringify(o.chartFns[id]) === JSON.stringify(n.chartFns[id]), firstDiff(JSON.stringify(o.chartFns[id]), JSON.stringify(n.chartFns[id])));
  }
  check(`${prefix}: analysis (S.stage6Cache.${app}) deep-equal + key order`, o.analysis === n.analysis, firstDiff(o.analysis, n.analysis));
  check(`${prefix}: S.stage6.${app} deep-equal + key order`, o.cfg === n.cfg, firstDiff(o.cfg, n.cfg));
  check(`${prefix}: cache keys identical`, JSON.stringify(o.cacheKeys) === JSON.stringify(n.cacheKeys), `${o.cacheKeys} → ${n.cacheKeys}`);
  check(`${prefix}: rAF errors identical (${o.rafErrors.length})`, JSON.stringify(o.rafErrors) === JSON.stringify(n.rafErrors), `${JSON.stringify(o.rafErrors)} → ${JSON.stringify(n.rafErrors)}`);
  check(`${prefix}: alerts identical`, JSON.stringify(o.alerts) === JSON.stringify(n.alerts));
  if (APPS[app].geometry) {
    check(`${prefix}: geometry preview draw log identical (${o.geometry.calls} calls, ${o.geometry.width}×${o.geometry.height})`, o.geometry.log === n.geometry.log && o.geometry.width === n.geometry.width && o.geometry.height === n.geometry.height, firstDiff(o.geometry.log, n.geometry.log) || `${o.geometry.width}×${o.geometry.height} → ${n.geometry.width}×${n.geometry.height}`);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-sdb-'));
const basePath = resolve(ROOT, BASE_REL);
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
      // Always the base's own copy (a re-export left at the old path would hand the base the new code).
      let sibText = null;
      try { sibText = show(sib.rel); } catch { /* the base already has the package: its imports resolve */ }
      if (sibText == null) continue;
      const p = resolve(ROOT, sib.base);
      writeFileSync(p, sibText); materialised.push(p);
      for (const spec of sib.specifiers) text = text.split(`'${spec}'`).join(`'./${basename(sib.base)}'`);
    }
    writeFileSync(basePath, text); materialised.push(basePath);
    console.log(`base controller (${base}) …`);
    oldDump = runDump(BASE_REL, join(tmp, 'old.json'));
  }
} finally {
  for (const p of materialised) if (existsSync(p)) rmSync(p);
  rmSync(tmp, { recursive: true, force: true });
}

for (const app of APP_IDS) {
  console.log(`\n(a) ${app} app on ${DEMO_FIXTURE} (sb260): defaults, golden configs, every inline handler, accordions`);
  const o = oldDump.demo[app], n = newDump.demo[app] || [];
  check(`${app}: same scenario list (${o.length})`, JSON.stringify(o.map((d) => d.label)) === JSON.stringify(n.map((d) => d.label)));
  o.forEach((os, i) => compareObservation(app, `demo.${app}.${os.label}`, os, n[i] || {}));
  // the field steps must actually have changed the page (otherwise they prove nothing)
  const pages = new Set(n.map((d) => d.html));
  const known = n.filter((d) => KNOWN_DEFECTS.some((k) => d.label.includes(k.step))).length;
  check(`${app}: every scenario rendered a distinct page except the re-renders (${pages.size} distinct of ${n.length}${known ? `, ${known} known-defect step` : ''})`, pages.size >= n.length - 3 - known, `${pages.size} distinct`);
  if (APPS[app].geometry) check(`${app}: the geometry preview drew on every render`, n.every((d) => d.geometry.calls > 50), n.map((d) => d.geometry.calls).join(','));
}

console.log('\n(b) the three apps on the project fixtures');
for (const name of PROJECT_FIXTURES) {
  const o = oldDump.projects[name], n = newDump.projects[name] || [];
  check(`${name}: same CPT count (${o.length})`, o.length === n.length);
  o.forEach((oc, i) => {
    const nc = n[i] || { apps: {} };
    check(`${name}[${i}] ${oc.id}: id / layer count`, oc.id === nc.id && oc.layers === nc.layers);
    for (const app of APP_IDS) {
      compareObservation(app, `${name}[${i}] ${oc.id} ${app}`, oc.apps[app].default, nc.apps[app]?.default || {});
      compareObservation(app, `${name}[${i}] ${oc.id} ${app} heavy`, oc.apps[app].heavy, nc.apps[app]?.heavy || {});
    }
  });
}

const stage6 = await import('../src/lib/cpt-app/stage6/index.js');
const stubRetaining = { cardMeta: { id: 'retwall', title: '', desc: '' }, defaults: () => ({}), ensure: () => {} };
const reg = stage6.createStage6Registry({ retaining: stubRetaining });
for (const app of PACKAGED) {
  const suite = `tests/golden/node/stage6-${app}`;
  console.log(`\n(c) ${suite}/* recomputed with the pure ${app}/ package`);
  const pure = newDump.pure[app] || {};
  const onDisk = readdirSync(resolve(ROOT, suite)).sort();
  check(`${app}: golden file set == recomputed set (${onDisk.length})`, JSON.stringify(onDisk) === JSON.stringify(Object.keys(pure).sort()), `disk-only ${onDisk.filter((f) => !(f in pure))} recomputed-only ${Object.keys(pure).filter((f) => !onDisk.includes(f))}`);
  for (const f of onDisk) {
    const expected = readFileSync(resolve(ROOT, suite, f), 'utf8');
    check(`${app}: ${f} byte-identical`, pure[f] === expected, pure[f] == null ? 'not recomputed' : firstTextDiff(expected, pure[f]));
  }

  console.log(`\n(d) registry / ${app} package consistency`);
  const pkg = await import(`../src/lib/cpt-app/${app}/index.js`);
  const Cap = app[0].toUpperCase() + app.slice(1);
  check(`stage6/apps/${app}-state.js re-exports ${app}/state.js (defaults, ensure)`, stage6[`${app}State`].defaults === pkg.defaults && stage6[`${app}State`].ensure === pkg.ensure);
  const stubCtx = { getState: () => ({}), workingLayers: () => [], layerBottom: () => 10, ensure() {}, detailsOpen: () => '' };
  const installed = pkg[`install${Cap}App`](stubCtx);
  check(`install${Cap}App() returns the retaining shape`, ['defaults', 'ensure', 'renderBody', 'postRender', 'handlers', 'cardMeta'].every((k) => k in installed) && typeof installed.compute === 'function' && typeof installed.buildCharts === 'function');
  check(`install${Cap}App().defaults / ensure / cardMeta are the package exports`, installed.defaults === pkg.defaults && installed.ensure === pkg.ensure && installed.cardMeta === pkg.cardMeta);
  const entry = stage6.registryEntry(reg, app);
  check(`registry: ${app} entry state is the package (defaults, ensure)`, entry.state.defaults === pkg.defaults && entry.state.ensure === pkg.ensure);
  check(`registry: ${app} card text is the package cardMeta`, entry.cardMeta.title === pkg.cardMeta.title && entry.cardMeta.desc === pkg.cardMeta.desc && entry.cardMeta.id === app && typeof entry.cardMeta.icon === 'string' && entry.cardMeta.icon.length > 20);
  check(`registry: ${app} defaults() through the package equal ${app}/state.js defaults()`, JSON.stringify(entry.state.defaults()) === JSON.stringify(pkg.defaults()));
  const cfgs = { settlement: { Df: 99 }, dewatering: { targetWt: 0.1 }, beam: { Df: 99, modelMode: 'bogus', gpOverride: '', cNomOverride: '12' } };
  const clamped = { settlement: (a) => a.settlement.Df === 12, dewatering: (a) => a.dewatering.targetWt === 2.5, beam: (a) => a.beam.Df === 12 && a.beam.modelMode === 'slab_strip' && a.beam.gpOverride === null && a.beam.cNomOverride === 12 };
  const a = { [app]: cfgs[app] };
  entry.state.ensure(a, { maxDepth: 12, wt: 2.5 });
  check(`registry: ${app} ensure() clamps through the package`, clamped[app](a), JSON.stringify(a));
  // explicit-input contract of compute.js
  const fn = pkg[`${app}Analysis`];
  const cfg = pkg.defaults();
  check(`${app}Analysis without env.wt throws (no hidden water table)`, (() => { try { fn(cfg, [], {}); return false; } catch (e) { return /env\.wt/.test(String(e.message)); } })());
  check(`${app}Analysis without layers throws (no hidden working layers)`, (() => { try { fn(cfg, null, { wt: 1 }); return false; } catch (e) { return /layers/.test(String(e.message)); } })());
}
check(`registry order unchanged (${stage6.STAGE6_APP_ORDER.join(' · ')})`, JSON.stringify(reg.map((a) => a.id)) === JSON.stringify(stage6.STAGE6_APP_ORDER));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
