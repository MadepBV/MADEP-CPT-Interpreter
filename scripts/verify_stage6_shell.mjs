#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 6 (PR 11, worklog/refactor/12-pr11-stage6-shell.md): the Stage 6
// shell package (src/lib/cpt-app/stage6/**) must be a pure move. The controller of a base ref
// (default `integration-r`, the last commit before the extraction) and the working-tree controller
// are each loaded under Node through the Tier-B loader (scripts/golden/lib/load-controller.mjs:
// Vite ssrLoadModule + DOM stub) in their own child process, dump the same observations to JSON,
// and the parent compares the two dumps byte for byte (JSON text, key order included):
//
//   (a) stage6Defaults()                                         deep-equal + key order
//   (b) ensureStage6State() on every CPT of the three project fixtures
//       (tests/golden/fixtures/projects/*.madep.json), twice (idempotence within one controller)
//   (c) #stage6Area innerHTML after setStage6App(app) and after a second renderStage6() for every
//       app on the demo-anonymous fixture (classified sb260 → goS(3) → goS(5)); the "no layers"
//       placeholder; the post-render rAF errors; the cache keys; the clamped S.stage6
//   (d) the app-switch card order of the base == STAGE6_APP_ORDER of the new registry
//
// Usage
//   node scripts/verify_stage6_shell.mjs                 compare against integration-r
//   node scripts/verify_stage6_shell.mjs --base <ref>    compare against another git ref
//   node scripts/verify_stage6_shell.mjs --snapshot f.json   dump the working tree only
//   node scripts/verify_stage6_shell.mjs --against f.json    compare the working tree with a dump
//
// The base controller is materialised as src/lib/cpt-app/__verify-stage6-base.legacy-controller.js
// (its relative imports need that directory) and deleted again, whatever happens.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-stage6-base.legacy-controller.js';
const APPS = ['bearing', 'pile', 'settlement', 'dewatering', 'beam', 'retwall', 'bishop'];
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
const DEMO_FIXTURE = 'demo-anonymous';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// ─────────────────────────────── child: dump one controller ───────────────────────────────
if (args[0] === '--dump') {
  const ctrlRel = args[1];
  const outPath = args[2];
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
  async function importCpt(name) {
    const fname = `${name}.gef`;
    const file = new File([readFileSync(join(FIX, 'cpt', fname))], fname);
    stub.alerts.length = 0;
    const before = stub.alerts.length;
    api.loadGEF({ target: { files: [file], value: '' } });
    await waitFor(() => (S().meta?.fname === fname && S().data.length > 0) || stub.alerts.length > before, `import of ${fname}`);
  }
  // JSON with undefined / NaN / ±Infinity made visible, key order preserved (no sorting).
  const ser = (v) => JSON.stringify(v, (k, x) => (x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));
  const dump = { controller: ctrlRel, defaults: null, ensure: {}, render: {}, cardOrder: null };

  // (a) defaults
  dump.defaults = ser(api.stage6Defaults());
  dump.defaultsTwice = ser(api.stage6Defaults()) === dump.defaults;

  // (b) ensure on the project fixtures
  for (const name of PROJECT_FIXTURES) {
    resetProject();
    const rel = `projects/${name}.madep.json`;
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, rel))], `${name}.madep.json`));
    const perCpt = [];
    for (let i = 0; i < api.PROJECT.cpts.length; i += 1) {
      api.selectCpt(i);
      api.ensureStage6State();
      const once = ser(S().stage6);
      api.ensureStage6State();
      const twice = ser(S().stage6);
      perCpt.push({ id: S().id, layers: S().layers.length, stage6: once, idempotent: once === twice, cacheKeys: Object.keys(S().stage6Cache || {}).sort() });
    }
    dump.ensure[name] = perCpt;
  }
  // (b') ensure on a fresh CPT and on a partial (bogus) state, like the stage6-shared golden
  resetProject();
  api.ensureStage6State();
  dump.ensure.fresh = ser(S().stage6);
  S().stage6 = { app: 'pile', bearing: { B: 0.01, Df: 99, eB: 99, shapeMode: 'bogus' }, beam: { modelMode: 'bogus', gpOverride: '2.5', cNomOverride: '' }, bishop: { schemaVersion: 1, bottomMargin: 7, seepage: { options: { meshTargetArea: 0.5 } } } };
  api.ensureStage6State();
  dump.ensure.partial = ser(S().stage6);
  S().stage6 = { app: 'not-an-app' };
  api.ensureStage6State();
  dump.ensure.unknownApp = ser({ app: S().stage6.app });

  // (c) rendered Stage 6 HTML per app on the demo fixture
  resetProject();
  await importCpt(DEMO_FIXTURE);
  S().method = 'sb260';
  api.runClass();
  api.goS(3); api.goS(5);
  const area = () => stub.document.getElementById('stage6Area').innerHTML;
  for (const app of APPS) {
    stub.rafErrors.length = 0;
    stub.alerts.length = 0;
    let error = null;
    try { api.setStage6App(app); } catch (e) { error = String(e?.stack || e); }
    const first = area();
    const firstRaf = stub.rafErrors.slice();
    let error2 = null;
    try { api.renderStage6(); } catch (e) { error2 = String(e?.stack || e); }
    const second = area();
    dump.render[app] = {
      selected: S().stage6.app,
      html: first,
      htmlLength: first.length,
      rerenderHtml: second,
      rerenderSame: first === second,
      rafErrors: firstRaf.map((e) => e.split('\n')[0]),
      rafErrorsRerender: stub.rafErrors.slice(firstRaf.length).map((e) => e.split('\n')[0]),
      alerts: stub.alerts.slice(),
      error, error2,
      cacheKeys: Object.keys(S().stage6Cache || {}).sort(),
      stage6: ser(S().stage6)
    };
  }
  // unknown app id → the legacy fallback body (the `else` branch of the old chain)
  S().stage6.app = 'not-an-app';
  api.renderStage6();
  dump.render.__unknown = { html: area(), cacheKeys: Object.keys(S().stage6Cache || {}).sort() };
  api.setStage6App('bearing');
  // the "run Stages 2–5 first" placeholder
  const savedLayers = S().layers;
  S().layers = [];
  api.renderStage6();
  dump.render.__noLayers = area();
  S().layers = savedLayers;
  // (d) card order as rendered
  api.renderStage6();
  dump.cardOrder = [...area().matchAll(/onclick="setStage6App\('([^']+)'\)"/g)].map((m) => m[1]);
  // the shared shell helpers in isolation
  dump.shell = { banner: api.stage6SharedBanner ? api.stage6SharedBanner() : null, cards: api.stage6CardsHtml ? api.stage6CardsHtml('pile') : null, icon: api.stage6AppIcon ? APPS.concat('nope').map((id) => api.stage6AppIcon(id)) : null };

  writeFileSync(outPath, JSON.stringify(dump));
  await server.close();
  process.exit(0);
}

// ─────────────────────────────── parent: run + compare ───────────────────────────────
function runDump(ctrlRel, outPath) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--dump', ctrlRel, outPath], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`dump of ${ctrlRel} failed (exit ${r.status})`);
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** First differing JSON path between two serialised values (both strings of JSON). */
function firstDiff(aJson, bJson) {
  if (aJson === bJson) return null;
  let a, b;
  try { a = JSON.parse(aJson); b = JSON.parse(bJson); } catch { return 'unparseable'; }
  const walk = (x, y, path) => {
    if (x === y) return null;
    if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object') return `${path || '<root>'}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`;
    const kx = Object.keys(x), ky = Object.keys(y);
    if (kx.join(' ') !== ky.join(' ')) {
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
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `at char ${i}: …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`;
}

const tmp = mkdtempSync(join(tmpdir(), 'verify-stage6-'));
const basePath = resolve(ROOT, BASE_REL);
let oldDump, newDump;
try {
  const against = opt('--against');
  const snapshot = opt('--snapshot');
  console.log('working tree controller …');
  newDump = runDump(CTRL_REL, join(tmp, 'new.json'));
  if (snapshot) { writeFileSync(snapshot, JSON.stringify(newDump)); console.log(`snapshot written: ${snapshot}`); process.exit(0); }
  if (against) {
    oldDump = JSON.parse(readFileSync(against, 'utf8'));
  } else {
    const base = opt('--base') || 'integration-r';
    let text;
    try { text = execFileSync('git', ['show', `${base}:${CTRL_REL}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }
    catch (e) { console.error(`cannot read ${CTRL_REL} at ${base} (${e.message.split('\n')[0]}); pass --base <ref> or --against <dump.json>`); process.exit(2); }
    writeFileSync(basePath, text);
    console.log(`base controller (${base}) …`);
    oldDump = runDump(BASE_REL, join(tmp, 'old.json'));
  }
} finally {
  if (existsSync(basePath)) rmSync(basePath);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n(a) stage6Defaults()');
check('defaults deep-equal + key order', oldDump.defaults === newDump.defaults, firstDiff(oldDump.defaults, newDump.defaults));
check('defaults() is a fresh identical object each call', newDump.defaultsTwice);

console.log('\n(b) ensureStage6State() on the project fixtures');
for (const name of PROJECT_FIXTURES) {
  const o = oldDump.ensure[name], n = newDump.ensure[name];
  check(`${name}: same CPT count (${o.length})`, o.length === n.length);
  o.forEach((oc, i) => {
    const nc = n[i] || {};
    check(`${name}[${i}] ${oc.id}: stage6 deep-equal + key order`, oc.stage6 === nc.stage6, firstDiff(oc.stage6, nc.stage6 || 'null'));
    check(`${name}[${i}] ${oc.id}: ensure is idempotent (new)`, nc.idempotent === true);
    check(`${name}[${i}] ${oc.id}: cache keys`, JSON.stringify(oc.cacheKeys) === JSON.stringify(nc.cacheKeys));
  });
}
for (const k of ['fresh', 'partial', 'unknownApp']) check(`${k} state: deep-equal + key order`, oldDump.ensure[k] === newDump.ensure[k], firstDiff(oldDump.ensure[k], newDump.ensure[k]));

console.log(`\n(c) rendered #stage6Area on ${DEMO_FIXTURE} (sb260)`);
for (const app of APPS) {
  const o = oldDump.render[app], n = newDump.render[app];
  check(`${app}: selected app`, o.selected === n.selected, `${o.selected} → ${n.selected}`);
  check(`${app}: innerHTML byte-identical (${o.htmlLength} chars)`, o.html === n.html, firstTextDiff(o.html, n.html));
  check(`${app}: second renderStage6() byte-identical`, o.rerenderHtml === n.rerenderHtml, firstTextDiff(o.rerenderHtml, n.rerenderHtml));
  check(`${app}: post-render rAF errors identical (${o.rafErrors.length})`, JSON.stringify(o.rafErrors) === JSON.stringify(n.rafErrors), `${JSON.stringify(o.rafErrors)} → ${JSON.stringify(n.rafErrors)}`);
  check(`${app}: re-render rAF errors identical (${o.rafErrorsRerender.length})`, JSON.stringify(o.rafErrorsRerender) === JSON.stringify(n.rafErrorsRerender));
  check(`${app}: alerts identical`, JSON.stringify(o.alerts) === JSON.stringify(n.alerts));
  check(`${app}: no render exception in either`, !o.error && !n.error && !o.error2 && !n.error2, (o.error || n.error || o.error2 || n.error2 || '').split('\n')[0]);
  check(`${app}: stage6Cache keys identical`, JSON.stringify(o.cacheKeys) === JSON.stringify(n.cacheKeys), `${o.cacheKeys} → ${n.cacheKeys}`);
  check(`${app}: S.stage6 after render deep-equal`, o.stage6 === n.stage6, firstDiff(o.stage6, n.stage6));
}
check('unknown app id renders the legacy fallback identically', oldDump.render.__unknown.html === newDump.render.__unknown.html && JSON.stringify(oldDump.render.__unknown.cacheKeys) === JSON.stringify(newDump.render.__unknown.cacheKeys), firstTextDiff(oldDump.render.__unknown.html, newDump.render.__unknown.html));
check('no-layers placeholder identical', oldDump.render.__noLayers === newDump.render.__noLayers, firstTextDiff(oldDump.render.__noLayers, newDump.render.__noLayers));
check('stage6SharedBanner() identical', oldDump.shell.banner === newDump.shell.banner, firstTextDiff(oldDump.shell.banner || '', newDump.shell.banner || ''));
check('stage6CardsHtml() identical', oldDump.shell.cards === newDump.shell.cards, firstTextDiff(oldDump.shell.cards || '', newDump.shell.cards || ''));
check('stage6AppIcon() identical for every app + unknown id', JSON.stringify(oldDump.shell.icon) === JSON.stringify(newDump.shell.icon));

console.log('\n(d) registry order');
const { STAGE6_APP_ORDER, createStage6Registry } = await import('../src/lib/cpt-app/stage6/registry.js');
const registryIds = createStage6Registry({ retaining: { cardMeta: { id: 'retwall', title: '', desc: '' }, defaults: () => ({}), ensure: () => {} } }).map((a) => a.id);
check(`base card order == STAGE6_APP_ORDER (${STAGE6_APP_ORDER.join(' · ')})`, JSON.stringify(oldDump.cardOrder) === JSON.stringify(STAGE6_APP_ORDER), `${oldDump.cardOrder} vs ${STAGE6_APP_ORDER}`);
check('registry order == STAGE6_APP_ORDER', JSON.stringify(registryIds) === JSON.stringify(STAGE6_APP_ORDER));
check('new card order == base card order', JSON.stringify(newDump.cardOrder) === JSON.stringify(oldDump.cardOrder));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
