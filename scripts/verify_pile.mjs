#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 7 / PR 12b (worklog/refactor/15-pr12b-pile.md): the pile package
// (src/lib/cpt-app/pile/**) must be a pure move out of legacy-controller.js. Pattern of
// scripts/verify_stage6_shell.mjs: the controller of a base ref (default `integration-r`) and the
// working-tree controller are each loaded under Node through the Tier-B loader
// (scripts/golden/lib/load-controller.mjs: Vite ssrLoadModule + DOM stub) in their own child
// process, dump the same observations to JSON, and the parent compares the two dumps byte for
// byte (JSON text, key order included):
//
//   (a) demo-anonymous (sb260 → goS(3) → goS(5)) with the pile app selected: #stage6Area innerHTML,
//       the section <svg> markup drawn in the post-render rAF, the four Chart.js configs (the
//       loader's Chart stub keeps them), S.stage6Cache.pile, S.stage6.pile, the canvas state, the
//       rAF errors and alerts — for the defaults, a second renderStage6(), the golden suite's
//       "heavy" / "edge" configs, a square and a rectangular section, the ATG / mechanical-cone /
//       downdrag / typical-curve branches, every <details> accordion open, and the interactive
//       section view driven through the SVG's own listeners (a wheel zoom → light rAF frame; a
//       toe-handle drag → live frames + the drag-end full re-render; a layer popover + snap-to-mid
//       action; a wheel on the pile SVG after switching to another app → the frame does nothing)
//   (b) the same for every CPT of the three project fixtures (tests/golden/fixtures/projects/*)
//   (c) tests/golden/node/stage6-pile/* recomputed from the pure package functions — state.js
//       defaults()/ensure(), compute.js analyzePile()/PILE_CONSTANTS, panel.js renderPileApp() —
//       on the Stage 2–5 chain of the working-tree controller (the layers / wt / rows each golden
//       was recorded from): the file text must be byte-identical to the golden on disk
//   (d) registry / package consistency: stage6/apps/pile-state.js re-exports pile/state.js, the
//       registry's pile entry is the package's state + cardMeta, installPileApp() returns the
//       retaining shape, STAGE6_APP_ORDER
//
// Usage
//   node scripts/verify_pile.mjs                    compare against integration-r
//   node scripts/verify_pile.mjs --base <ref>       compare against another git ref
//   node scripts/verify_pile.mjs --snapshot f.json  dump the working tree only
//   node scripts/verify_pile.mjs --against f.json   compare the working tree with a dump
//
// The base controller is materialised as src/lib/cpt-app/__verify-pile-base.legacy-controller.js
// (its relative imports need that directory). A base that still has ./stage6-pile.js and
// ./stage6-pile-canvas.js (the files this PR moved) gets the base's own copies materialised next
// to it as __verify-pile-base.stage6-pile*.js and its import specifiers rewritten — never the
// working tree's re-exports at the old paths; everything is deleted again, whatever happens.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-pile-base.legacy-controller.js';
// Sibling modules the base controller may import relative to itself that the working tree no
// longer has at that path: [old relative path, import specifier(s) as written in the base].
const MOVED_SIBLINGS = [
  { rel: 'src/lib/cpt-app/stage6-pile.js', base: 'src/lib/cpt-app/__verify-pile-base.stage6-pile.js', specifiers: ['./stage6-pile', './stage6-pile.js'] },
  { rel: 'src/lib/cpt-app/stage6-pile-canvas.js', base: 'src/lib/cpt-app/__verify-pile-base.stage6-pile-canvas.js', specifiers: ['./stage6-pile-canvas', './stage6-pile-canvas.js'] }
];
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
const DEMO_FIXTURE = 'demo-anonymous';
const GOLDEN_SUITE = 'tests/golden/node/stage6-pile';
const CHART_IDS = ['stage6PileDeBeerChart', 'stage6PileShaftChart', 'stage6PileLoadSettlementChart', 'stage6PileAxialForceChart'];
const DETAILS_KEYS = ['pile-factors', 'pile-atg', 'pile-cone', 'pile-downdrag', 'pile-settlement'];

// The golden suite's configs (scripts/golden/suites/stage6-pile.mjs), verbatim.
const HEAVY = { pileType: 'screw', shape: 'circular', Ds: 0.6, Db: 0.8, zToe: 14.0, Fcd: 1800, Frep: 1200, loadFromComponents: true, GkPerPile: 800, QLeadPerPile: 300, QOtherPerPile: 50, sltCondition: 'none', nPiles: '4-10', cptDensity: '1/300m2', downdrag: 'none', mechanicalCone: true, coneType: 'M1', settlementMethod: 'transfer' };
const EDGE = (S) => ({ pileType: 'driven', shape: 'square', Ds: 0.2, Db: 0.2, zHead: 0.5, zToe: S.data.at(-1).z + 3, Fcd: 50, Frep: 30, loadFromComponents: false, sAllowable: 2, Ep: 10, pileMaterial: 'steel' });
// Extra render variants: every template branch of panel.js at least once.
const VARIANTS = [
  ['heavy', HEAVY],
  ['edge', EDGE],
  ['square', { shape: 'square', a: 0.35, Ds: 0.35, Db: 0.5, zHead: 0, zToe: 9, Fcd: 600, Frep: 400, sAllowable: 10, Ep: 30, pileMaterial: 'concrete' }],
  ['rectangular', { shape: 'rectangular', a: 0.3, b: 0.6, Ds: 0.4, Db: 0.4 }],
  ['atg-cone-downdrag', { shape: 'circular', useAtg: true, atgAlphaB: 0.9, atgAlphaS: 0.8, atgGammaRd: 1.2, atgGammaB: 1.1, lambdaOverride: 0.8, mechanicalCone: true, coneType: 'M2', downdrag: 'moderate', neutralPlane: null, settlementMethod: 'typical-curve', pileMaterial: 'steel', Ep: 210, qaToggle: true, sltCondition: 'jobsite', nPiles: '>10', cptDensity: '1/10m2', nCpt: 3 }],
  ['severe-downdrag-timber', { downdrag: 'severe', neutralPlane: 4, pileMaterial: 'timber', Ep: 12, MsOverride: 2, MbOverride: 5, EbOverride: 20000, Ap: 0.2 }]
];

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
  // JSON with undefined / NaN / ±Infinity made visible, key order preserved (no sorting); functions
  // (chart tick formatters) are dropped by JSON.stringify as in the golden normaliser.
  const ser = (v) => JSON.stringify(v, (k, x) => (x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
  const area = () => stub.document.getElementById('stage6Area').innerHTML;
  const svg = () => stub.document.getElementById('stage6PileSection');
  const chartConfig = (id) => { const c = stub.document.getElementById(id)._chartRef; return c ? ser(c.config) : null; };
  /** Everything the pile app leaves behind after a render. */
  function observe() {
    const el = svg();
    return {
      selected: S().stage6.app,
      html: area(),
      htmlLength: area().length,
      svg: el.innerHTML,
      svgAttrs: ['viewBox', 'role', 'aria-label'].map((n) => `${n}=${el.getAttribute(n)}`).join(' '),
      charts: Object.fromEntries(CHART_IDS.map((id) => [id, chartConfig(id)])),
      analysis: ser(S().stage6Cache?.pile ?? null),
      cfg: ser(S().stage6.pile),
      canvasState: ser(S().stage6Cache?.pileCanvas ?? null),
      cacheKeys: Object.keys(S().stage6Cache || {}).sort(),
      rafErrors: stub.rafErrors.map((e) => e.split('\n')[0]),
      alerts: stub.alerts.slice()
    };
  }
  function renderWith(label, fn) {
    stub.rafErrors.length = 0; stub.alerts.length = 0;
    let error = null;
    try { fn(); } catch (e) { error = String(e?.stack || e).split('\n').slice(0, 3).join(' | '); }
    return { label, error, ...observe() };
  }
  // Synthetic pointer / wheel events through the listeners canvas.js bound on the SVG stub element
  // (stage6-canvas-utils.js attachPanZoomPointer): `target.closest()` is what the handlers query.
  const targetFor = (attrs) => ({ closest: (sel) => { const m = sel.match(/^\[([a-z-]+)\]$/); return m && attrs[m[1]] != null ? { getAttribute: (n) => (attrs[n] ?? null) } : null; } });
  const fire = (type, evt) => { const l = svg()._listeners[type] || []; if (!l.length) throw new Error(`no ${type} listener on #stage6PileSection`); l.forEach((fn) => fn(evt)); };
  const pointer = (clientY, target, extra = {}) => ({ pointerId: 1, button: 0, clientX: 400, clientY, target, shiftKey: false, preventDefault() {}, ...extra });
  const dump = { controller: ctrlRel, demo: [], projects: {}, pure: null };

  // (a) demo fixture
  resetProject();
  await importCpt(DEMO_FIXTURE);
  S().method = 'sb260';
  api.runClass();
  api.goS(3); api.goS(5);
  dump.demo.push(renderWith('default', () => api.setStage6App('pile')));
  dump.demo.push(renderWith('rerender', () => api.renderStage6()));
  for (const [label, cfg] of VARIANTS) {
    dump.demo.push(renderWith(label, () => { Object.assign(S().stage6.pile, typeof cfg === 'function' ? cfg(S()) : cfg); api.renderStage6(); }));
  }
  dump.demo.push(renderWith('details-open', () => { for (const k of DETAILS_KEYS) S().stage6.ui.details[k] = true; api.renderStage6(); }));
  dump.demo.push(renderWith('details-closed', () => { S().stage6.ui.details = {}; api.renderStage6(); }));
  // interactive section view: wheel zoom → one light frame (ensure + analyzePile + redraw)
  dump.demo.push(renderWith('wheel-zoom', () => fire('wheel', { clientX: 120, clientY: 90, deltaY: -100, preventDefault() {} })));
  dump.demo.push(renderWith('wheel-zoom-out', () => fire('wheel', { clientX: 300, clientY: 250, deltaY: 100, preventDefault() {} })));
  // toe handle drag: pointerdown on the handle, two moves (live frames), pointerup (commitChange → renderStage6)
  const toe = targetFor({ 'data-pile-handle': 'toe' });
  dump.demo.push(renderWith('drag-toe-down', () => fire('pointerdown', pointer(200, toe))));
  dump.demo.push(renderWith('drag-toe-move', () => { fire('pointermove', pointer(260, toe)); fire('pointermove', pointer(330, toe)); }));
  dump.demo.push(renderWith('drag-toe-up', () => fire('pointerup', pointer(330, toe))));
  // head handle with shift (free snap) and a base-edge handle
  const head = targetFor({ 'data-pile-handle': 'head' });
  dump.demo.push(renderWith('drag-head', () => { fire('pointerdown', pointer(40, head, { shiftKey: true })); fire('pointermove', pointer(70, head, { shiftKey: true })); fire('pointerup', pointer(70, head, { shiftKey: true })); }));
  const baseR = targetFor({ 'data-pile-handle': 'baseR' });
  dump.demo.push(renderWith('drag-baseR', () => { fire('pointerdown', { ...pointer(300, baseR), clientX: 430 }); fire('pointermove', { ...pointer(300, baseR), clientX: 470 }); fire('pointerup', { ...pointer(300, baseR), clientX: 470 }); }));
  // pointercancel mid-drag rolls the config back through hooks.setField
  dump.demo.push(renderWith('drag-cancel', () => { fire('pointerdown', pointer(200, toe)); fire('pointermove', pointer(280, toe)); fire('pointercancel', pointer(280, toe)); }));
  // layer popover (click on a layer rect) and its snap-to-mid action (commitChange)
  const layer1 = targetFor({ 'data-pile-layer': '1' });
  dump.demo.push(renderWith('popover-open', () => { fire('pointerdown', pointer(150, layer1)); fire('pointerup', pointer(150, layer1)); }));
  const popMid = targetFor({ 'data-pile-layer': '1', 'data-popover-action': 'mid', 'data-layer-index': '1' });
  dump.demo.push(renderWith('popover-mid', () => { fire('pointerdown', pointer(160, popMid)); fire('pointerup', pointer(160, popMid)); }));
  // a light frame after switching away from the pile app does nothing
  dump.demo.push(renderWith('other-app-wheel', () => { api.setStage6App('bearing'); fire('wheel', { clientX: 120, clientY: 90, deltaY: -100, preventDefault() {} }); }));
  dump.demo.push(renderWith('back-to-pile', () => api.setStage6App('pile')));

  // (b) the project fixtures
  for (const name of PROJECT_FIXTURES) {
    resetProject();
    const rel = `projects/${name}.madep.json`;
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, rel))], `${name}.madep.json`));
    const perCpt = [];
    for (let i = 0; i < api.PROJECT.cpts.length; i += 1) {
      api.selectCpt(i);
      const obs = renderWith(`${name}[${i}]`, () => api.setStage6App('pile'));
      obs.id = S().id; obs.layers = S().layers.length;
      obs.heavy = renderWith(`${name}[${i}].heavy`, () => { Object.assign(S().stage6.pile, HEAVY); api.renderStage6(); });
      perCpt.push(obs);
    }
    dump.projects[name] = perCpt;
  }

  // (c) the golden suite recomputed with the pure package (working tree only)
  if (pure) {
    const { normalize, normalizeText } = await import('./golden/lib/normalize.mjs');
    const { stableJson } = await import('./golden/lib/store.mjs');
    const { htmlToText } = await import('./golden/lib/html-text.mjs');
    const pkg = await import('../src/lib/cpt-app/pile/index.js');
    const { workingLayers } = await import('../src/lib/cpt-app/model-params/index.js');
    const { layerBottom, detailsOpen, createStage6Registry, createStage6Shell } = await import('../src/lib/cpt-app/stage6/index.js');
    // The app switch + shared banner around the body come from the shell package (pure: registry
    // + the active CPT), the same way renderStage6() composes #stage6Area.
    const shell = createStage6Shell({
      registry: createStage6Registry({ retaining: { cardMeta: { id: 'retwall', title: 'Retaining walls', desc: '' }, defaults: () => ({}), ensure: () => {} } }),
      getState: () => S(), ensure() {}, rememberDetailsState() {}, workingLayers: () => [], apps: {}
    });
    const names = Object.entries(manifest.fixtures).filter(([k, e]) => k.startsWith('cpt/') && e.role === 'profile').map(([k]) => k.slice(4).replace(/\.(gef|state\.json)$/, '')).filter((n) => !['trailing-qc-only', 'wt-above-surface'].includes(n));
    const out = { 'constants.json': stableJson(normalize(pkg.PILE_CONSTANTS)) };
    for (const fx of names) {
      resetProject();
      await importCpt(fx);
      S().method = 'sb260';
      api.runClass();
      api.goS(3); api.goS(5);
      const cpt = S();
      const layers = workingLayers(cpt);
      const env = { maxDepth: Math.max(layerBottom(cpt), 0.5) };
      const stage6 = { pile: pkg.defaults(), ui: { details: {} } };
      pkg.ensure(stage6, env);
      const cfg = stage6.pile;
      let analysis = pkg.analyzePile(layers, cpt.wt, cpt.data, cfg);
      out[`${fx}.default.json`] = stableJson(normalize(analysis));
      out[`${fx}.default.config.json`] = stableJson(normalize(cfg));
      const body = pkg.renderPileApp(cfg, analysis, (key) => detailsOpen(stage6, key));
      out[`${fx}.default.dom.txt`] = normalizeText(htmlToText(`${shell.cardsHtml('pile')}${shell.sharedBanner()}${body}`));
      for (const [label, c] of [['heavy', HEAVY], ['edge', EDGE]]) {
        Object.assign(cfg, typeof c === 'function' ? c(cpt) : c);
        pkg.ensure(stage6, env);
        analysis = pkg.analyzePile(layers, cpt.wt, cpt.data, cfg);
        out[`${fx}.${label}.json`] = stableJson(normalize(analysis));
        out[`${fx}.${label}.config.json`] = stableJson(normalize(cfg));
      }
      out[`${fx}.alerts.json`] = stableJson(normalize([]));
    }
    dump.pure = out;
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
function firstTextDiff(a, b) {
  if (a === b) return null;
  a = String(a ?? ''); b = String(b ?? '');
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `at char ${i}: …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`;
}
/** Compare one observation of the base with the same of the working tree. */
function compareObservation(prefix, o, n) {
  check(`${prefix}: no exception in either`, !o.error && !n.error, o.error || n.error || '');
  check(`${prefix}: selected app`, o.selected === n.selected, `${o.selected} → ${n.selected}`);
  check(`${prefix}: #stage6Area innerHTML byte-identical (${o.htmlLength} chars)`, o.html === n.html, firstTextDiff(o.html, n.html));
  check(`${prefix}: section SVG markup byte-identical (${o.svg.length} chars)`, o.svg === n.svg && o.svgAttrs === n.svgAttrs, firstTextDiff(o.svg, n.svg) || `${o.svgAttrs} → ${n.svgAttrs}`);
  for (const id of CHART_IDS) check(`${prefix}: ${id} config identical`, o.charts[id] === n.charts[id], firstDiff(o.charts[id], n.charts[id]));
  check(`${prefix}: analysis (S.stage6Cache.pile) deep-equal + key order`, o.analysis === n.analysis, firstDiff(o.analysis, n.analysis));
  check(`${prefix}: S.stage6.pile deep-equal + key order`, o.cfg === n.cfg, firstDiff(o.cfg, n.cfg));
  check(`${prefix}: canvas state identical`, o.canvasState === n.canvasState, firstDiff(o.canvasState, n.canvasState));
  check(`${prefix}: cache keys identical`, JSON.stringify(o.cacheKeys) === JSON.stringify(n.cacheKeys), `${o.cacheKeys} → ${n.cacheKeys}`);
  check(`${prefix}: rAF errors identical (${o.rafErrors.length})`, JSON.stringify(o.rafErrors) === JSON.stringify(n.rafErrors), `${JSON.stringify(o.rafErrors)} → ${JSON.stringify(n.rafErrors)}`);
  check(`${prefix}: alerts identical`, JSON.stringify(o.alerts) === JSON.stringify(n.alerts));
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-pile-'));
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

console.log(`\n(a) pile app on ${DEMO_FIXTURE} (sb260): defaults, variants, accordions, interactive section view`);
check(`same scenario list (${oldDump.demo.length})`, JSON.stringify(oldDump.demo.map((d) => d.label)) === JSON.stringify(newDump.demo.map((d) => d.label)));
oldDump.demo.forEach((o, i) => { const n = newDump.demo[i] || {}; compareObservation(`demo.${o.label}`, o, n); });
// the interactive scenarios must actually have moved something (otherwise they prove nothing)
const byLabel = Object.fromEntries(newDump.demo.map((d) => [d.label, d]));
check('wheel zoom changed the section markup', byLabel['wheel-zoom'].svg !== byLabel['details-closed'].svg);
check('toe drag changed z_toe and re-rendered the app', JSON.parse(byLabel['drag-toe-up'].cfg).zToe !== JSON.parse(byLabel['wheel-zoom-out'].cfg).zToe && byLabel['drag-toe-up'].html !== byLabel['wheel-zoom-out'].html);
check('drag cancel restored z_toe', JSON.parse(byLabel['drag-cancel'].cfg).zToe === JSON.parse(byLabel['drag-baseR'].cfg).zToe);
check('layer popover appeared in the section markup', /data-popover-action/.test(byLabel['popover-open'].svg) && !/data-popover-action/.test(byLabel['drag-cancel'].svg));
check('light frame after the app switch left the pile cache alone', byLabel['other-app-wheel'].analysis === byLabel['popover-mid'].analysis && byLabel['other-app-wheel'].selected === 'bearing');

console.log('\n(b) pile app on the project fixtures');
for (const name of PROJECT_FIXTURES) {
  const o = oldDump.projects[name], n = newDump.projects[name];
  check(`${name}: same CPT count (${o.length})`, o.length === n.length);
  o.forEach((oc, i) => {
    const nc = n[i] || {};
    check(`${name}[${i}] ${oc.id}: id / layer count`, oc.id === nc.id && oc.layers === nc.layers);
    compareObservation(`${name}[${i}] ${oc.id}`, oc, nc);
    compareObservation(`${name}[${i}] ${oc.id} heavy`, oc.heavy, nc.heavy || {});
  });
}

console.log(`\n(c) ${GOLDEN_SUITE}/* recomputed with the pure package`);
const pure = newDump.pure || {};
const onDisk = (await import('node:fs')).readdirSync(resolve(ROOT, GOLDEN_SUITE)).sort();
check(`golden file set == recomputed set (${onDisk.length})`, JSON.stringify(onDisk) === JSON.stringify(Object.keys(pure).sort()), `disk-only ${onDisk.filter((f) => !(f in pure))} recomputed-only ${Object.keys(pure).filter((f) => !onDisk.includes(f))}`);
for (const f of onDisk) {
  const expected = readFileSync(resolve(ROOT, GOLDEN_SUITE, f), 'utf8');
  check(`${f} byte-identical`, pure[f] === expected, pure[f] == null ? 'not recomputed' : firstTextDiff(expected, pure[f]));
}

console.log('\n(d) registry / package consistency');
const stage6 = await import('../src/lib/cpt-app/stage6/index.js');
const pile = await import('../src/lib/cpt-app/pile/index.js');
check('stage6/apps/pile-state.js re-exports pile/state.js (defaults, ensure)', stage6.pileState.defaults === pile.defaults && stage6.pileState.ensure === pile.ensure);
const stubRetaining = { cardMeta: { id: 'retwall', title: '', desc: '' }, defaults: () => ({}), ensure: () => {} };
const stubCtx = { getState: () => ({}), requestRender() {}, workingLayers: () => [], layerBottom: () => 10, ensure() {}, detailsOpen: () => '' };
const installed = pile.installPileApp(stubCtx);
check('installPileApp() returns the retaining shape', ['defaults', 'ensure', 'renderBody', 'postRender', 'handlers', 'cardMeta'].every((k) => k in installed) && typeof installed.compute === 'function');
check('installPileApp().defaults / ensure / cardMeta are the package exports', installed.defaults === pile.defaults && installed.ensure === pile.ensure && installed.cardMeta === pile.cardMeta);
const reg = stage6.createStage6Registry({ retaining: stubRetaining });
const entry = stage6.registryEntry(reg, 'pile');
check('registry: pile entry state is the package (defaults, ensure)', entry.state.defaults === pile.defaults && entry.state.ensure === pile.ensure);
check('registry: pile card text is the package cardMeta', entry.cardMeta.title === pile.cardMeta.title && entry.cardMeta.desc === pile.cardMeta.desc && entry.cardMeta.id === 'pile' && entry.short === 'Piles' && /rect x="7.5"/.test(entry.cardMeta.icon));
check(`registry order unchanged (${stage6.STAGE6_APP_ORDER.join(' · ')})`, JSON.stringify(reg.map((a) => a.id)) === JSON.stringify(stage6.STAGE6_APP_ORDER));
{
  const a = { pile: { zToe: 99, shape: 'bogus', Ds: 0 } };
  entry.state.ensure(a, { maxDepth: 12 });
  check('registry: pile ensure() clamps through the package', a.pile.zToe === 12 && a.pile.shape === 'circular' && a.pile.Ds === 0.4);
  check('registry: pile defaults() through the package equal pile/state.js defaults()', JSON.stringify(entry.state.defaults()) === JSON.stringify(pile.defaults()));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
