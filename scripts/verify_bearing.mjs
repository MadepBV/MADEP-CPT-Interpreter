#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 7, first app (PR 12a, worklog/refactor/14-pr12a-bearing.md): the
// bearing package (src/lib/cpt-app/bearing/**) must be a pure move out of legacy-controller.js.
//
// (A) Render parity, base vs working tree. The controller of a base ref (default `integration-r`,
//     the last commit before the extraction) and the working-tree controller are each loaded under
//     Node through the Tier-B loader (scripts/golden/lib/load-controller.mjs: Vite ssrLoadModule +
//     DOM stub) in their own child process, dump the same observations, and the parent compares
//     the two dumps byte for byte (pattern of scripts/verify_stage6_shell.mjs):
//       · demo-anonymous (classified sb260 → goS(3) → goS(5)) and every CPT of the three project
//         fixtures: #stage6Area innerHTML after setStage6App('bearing'), after every inline
//         `setStage6Field('bearing.…')` the markup carries (select / number inputs through the
//         shell), after the `bearing.Df` slider short-circuit (the five partial-update fragments,
//         the un-rerendered page, the debounced Chart.js config) and after a full renderStage6();
//         the cached profile, the clamped config, rAF errors, alerts.
//       · the window API: layerAtDepth / bearingAtDepth / bearingProfile with the `null` layers
//         fallback, stage6ShapeFactors, the four stage6Bearing*Html builders.
// (B) The pure functions against the goldens (working tree only): for every profile fixture of
//     tests/golden/node/stage6-bearing/, bearingProfile / bearingAtDepth / layerAtDepth from
//     src/lib/cpt-app/bearing/compute.js — imported under plain Node, no controller — recomputed
//     from the goldens' own configs (<fx>.{default,heavy,edge}.config.json) on the working layers
//     and water table the controller reports for that fixture, compared with the golden values
//     through the harness' normalize + compare (tolerance class `pure`) and as JSON text.
//
// Usage
//   node scripts/verify_bearing.mjs                  compare against integration-r + goldens
//   node scripts/verify_bearing.mjs --base <ref>     compare against another git ref
//   node scripts/verify_bearing.mjs --snapshot f.json   dump the working tree only
//   node scripts/verify_bearing.mjs --against f.json    compare the working tree with a dump
//
// The base controller is materialised as src/lib/cpt-app/__verify-bearing-base.legacy-controller.js
// (its relative imports need that directory) and deleted again, whatever happens.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-bearing-base.legacy-controller.js';
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
const DEMO_FIXTURE = 'demo-anonymous';
// Every inline handler of the bearing markup, in page order (renderStage6BearingApp), with a value
// that differs from the defaults so each one re-renders a different page.
const FIELD_STEPS = [
  ['bearing.showMode', 'drained'],
  ['bearing.foundationType', 'footing'],
  ['bearing.B', '2.5'],
  ['bearing.L', '4'],
  ['bearing.shapeMode', 'conservative'],
  ['bearing.eB', '0.3'],
  ['bearing.eL', '0.5'],
  ['bearing.load', '600'],
  ['bearing.ec7Combination', 'da1_2'],
  ['bearing.gammaRd', '1.1'],
  ['bearing.factorMode', 'system'],
  ['bearing.xi', '1.5']
];
const PARTIAL_IDS = ['stage6DfValue', 'stage6SelectedDepth', 'stage6UlsParams', 'stage6DrainedFormula', 'stage6UndrainedFormula'];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// ─────────────────────────────── child: dump one controller ───────────────────────────────
if (args[0] === '--dump') {
  const ctrlRel = args[1];
  const outPath = args[2];
  const { installDomStub } = await import('./golden/lib/load-controller.mjs');
  const { makeContext } = await import('./golden/lib/context.mjs');
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
  const fixtures = (await makeContext()).fixtures;   // fixture lookup only — its own controller is never loaded
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
    const entry = fixtures.entry(name);
    if (!entry) throw new Error(`unknown CPT fixture ${name}`);
    const fileRel = entry.base ? `cpt/${entry.base}` : entry.key;
    const fname = fileRel.split('/').pop();
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
  const area = () => stub.document.getElementById('stage6Area').innerHTML;
  const chartConfig = () => { const c = stub.document.getElementById('stage6BearingChart')._chartRef; return c ? ser(c.config) : null; };
  const errs = () => stub.rafErrors.map((e) => e.split('\n')[0]);

  /** The bearing page of the active CPT through every path the app has. */
  async function observeBearing() {
    const out = {};
    stub.rafErrors.length = 0; stub.alerts.length = 0;
    let error = null;
    try { api.setStage6App('bearing'); } catch (e) { error = String(e?.stack || e); }
    out.initial = { html: area(), htmlLength: area().length, rafErrors: errs(), error, chart: chartConfig(), config: ser(S().stage6.bearing), cache: ser(S().stage6Cache?.bearing ?? null) };
    if (!S().layers.length) { out.noLayers = true; return out; }
    // (1) every inline handler through the shell → full re-render
    out.fields = {};
    for (const [field, value] of FIELD_STEPS) {
      stub.rafErrors.length = 0;
      let err = null;
      try { api.setStage6Field(field, value); } catch (e) { err = String(e?.stack || e); }
      out.fields[field] = { html: area(), htmlLength: area().length, rafErrors: errs(), error: err, config: ser(S().stage6.bearing), chart: chartConfig() };
    }
    // (2) the Df slider short-circuit: partial update, no page re-render, debounced chart rebuild
    const before = area();
    for (const id of PARTIAL_IDS) stub.document.getElementById(id).innerHTML = ''; // clean slate: the fragments must be rewritten
    stub.document.getElementById('stage6DfValue').textContent = '';
    stub.document.getElementById('stage6BearingChart')._chartRef = null;
    stub.rafErrors.length = 0;
    const dfTarget = (Math.max(S().stage6.bearing.Df, 0.2) + 0.85).toFixed(2);
    let dfError = null;
    try { api.setStage6Field('bearing.Df', dfTarget); } catch (e) { dfError = String(e?.stack || e); }
    const chartBeforeDebounce = chartConfig();
    await sleep(60);
    out.df = {
      target: dfTarget,
      pageUnchanged: area() === before,
      dfValue: stub.document.getElementById('stage6DfValue').textContent,
      fragments: Object.fromEntries(PARTIAL_IDS.slice(1).map((id) => [id, stub.document.getElementById(id).innerHTML])),
      chartBeforeDebounce,
      chart: chartConfig(),
      config: ser(S().stage6.bearing),
      cache: ser(S().stage6Cache?.bearing ?? null),
      rafErrors: errs(),
      error: dfError
    };
    // (3) a full render with the moved Df, and the window-API façades
    stub.rafErrors.length = 0;
    api.renderStage6();
    out.rerender = { html: area(), htmlLength: area().length, rafErrors: errs(), chart: chartConfig(), cache: ser(S().stage6Cache?.bearing ?? null) };
    const cfg = S().stage6.bearing;
    const maxDepth = S().layers.at(-1).bot;
    const depths = [0.2, 1.0, 2.5, maxDepth / 2, maxDepth, maxDepth + 1];
    out.api = {
      profileNullLayers: ser(api.bearingProfile(cfg, null)),
      profileWithLayers: ser(api.bearingProfile(cfg, api.buildStage7Payload().stage6.layers)),
      atDepth: ser(depths.map((z) => api.bearingAtDepth(z, cfg, null))),
      atDepthEmptyLayers: ser(api.bearingAtDepth(1.0, cfg, [])),
      layerAtDepth: ser(depths.map((z) => api.layerAtDepth(z))),
      layerAtDepthEmpty: ser(api.layerAtDepth(1.0, [])),
      shapeFactors: ser([[{ ratio: 0.5 }, 30, 18.4, 'hansen'], [{ ratio: 0.5 }, 30, 18.4, 'conservative'], [{ ratio: 0 }, 0, 1, 'hansen'], [null, 25, 10.66, 'hansen']].map((a) => api.stage6ShapeFactors(...a))),
      html: (() => {
        const sel = S().stage6Cache.bearing.selected;
        const governing = Math.min(sel.qdDrained, sel.qdUndrained);
        const governingMode = sel.qdDrained <= sel.qdUndrained ? 'Drained' : 'Undrained';
        return [api.stage6BearingSelectedDepthHtml(sel, governing, governingMode), api.stage6BearingMaterialParamsHtml(sel, cfg), api.stage6BearingDrainedFormulaHtml(sel), api.stage6BearingUndrainedFormulaHtml(sel)];
      })()
    };
    out.alerts = stub.alerts.slice();
    return out;
  }

  const dump = { controller: ctrlRel, render: {}, pure: {} };
  // (A) demo fixture
  await classify(DEMO_FIXTURE);
  dump.render[DEMO_FIXTURE] = await observeBearing();
  // (A) project fixtures, every CPT
  for (const name of PROJECT_FIXTURES) {
    resetProject();
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, `projects/${name}.madep.json`))], `${name}.madep.json`));
    for (let i = 0; i < api.PROJECT.cpts.length; i += 1) {
      api.selectCpt(i);
      dump.render[`${name}[${i}] ${S().id}`] = await observeBearing();
    }
  }
  // (B) the inputs of the pure recomputation: working layers + water table per stage6 fixture,
  //     exactly as the stage6-bearing suite saw them (classified sb260 → goS(3) → goS(5))
  for (const fx of fixtures.stage6Names()) {
    await classify(fx);
    api.setStage6App('bearing');
    dump.pure[fx] = { wt: S().wt, layers: api.buildStage7Payload().stage6.layers, maxDepth: S().layers.at(-1).bot };
  }

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
function firstTextDiff(a, b) {
  if (a === b) return null;
  a = String(a); b = String(b);
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `at char ${i}: …${JSON.stringify(a.slice(Math.max(0, i - 40), i + 60))} vs …${JSON.stringify(b.slice(Math.max(0, i - 40), i + 60))}`;
}
const same = (label, a, b) => check(label, a === b, firstTextDiff(a, b));

const tmp = mkdtempSync(join(tmpdir(), 'verify-bearing-'));
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

console.log('\n(A) rendered bearing app: base vs working tree');
for (const key of Object.keys(oldDump.render)) {
  const o = oldDump.render[key], n = newDump.render[key];
  check(`${key}: observed in both`, !!n);
  if (!n) continue;
  same(`${key}: setStage6App('bearing') innerHTML byte-identical (${o.initial.htmlLength} chars)`, o.initial.html, n.initial.html);
  same(`${key}: initial rAF errors / exception / config / cache identical`, ser4(o.initial), ser4(n.initial));
  same(`${key}: initial chart config identical`, o.initial.chart, n.initial.chart);
  if (o.noLayers || n.noLayers) { check(`${key}: no-layers placeholder in both`, o.noLayers === n.noLayers); continue; }
  for (const [field] of FIELD_STEPS) {
    const of = o.fields[field], nf = n.fields[field];
    same(`${key}: setStage6Field('${field}') innerHTML byte-identical (${of.htmlLength} chars)`, of.html, nf.html);
    same(`${key}: setStage6Field('${field}') config / chart / rAF identical`, JSON.stringify([of.config, of.chart, of.rafErrors, of.error]), JSON.stringify([nf.config, nf.chart, nf.rafErrors, nf.error]));
  }
  check(`${key}: bearing.Df short-circuit leaves the page un-rerendered (both)`, o.df.pageUnchanged && n.df.pageUnchanged, `${o.df.pageUnchanged} → ${n.df.pageUnchanged}`);
  same(`${key}: bearing.Df → #stage6DfValue identical (${n.df.dfValue})`, o.df.dfValue, n.df.dfValue);
  for (const id of PARTIAL_IDS.slice(1)) same(`${key}: bearing.Df → #${id} innerHTML byte-identical (${o.df.fragments[id].length} chars)`, o.df.fragments[id], n.df.fragments[id]);
  same(`${key}: bearing.Df → chart rebuilt only after the 20 ms debounce, identical config`, JSON.stringify([o.df.chartBeforeDebounce, o.df.chart]), JSON.stringify([n.df.chartBeforeDebounce, n.df.chart]));
  check(`${key}: bearing.Df → chart rebuilt (new)`, n.df.chartBeforeDebounce === null && n.df.chart !== null);
  same(`${key}: bearing.Df → cache / config / rAF / exception identical`, JSON.stringify([o.df.cache, o.df.config, o.df.rafErrors, o.df.error]), JSON.stringify([n.df.cache, n.df.config, n.df.rafErrors, n.df.error]));
  same(`${key}: renderStage6() after Df innerHTML byte-identical (${o.rerender.htmlLength} chars)`, o.rerender.html, n.rerender.html);
  same(`${key}: renderStage6() after Df cache / chart / rAF identical`, JSON.stringify([o.rerender.cache, o.rerender.chart, o.rerender.rafErrors]), JSON.stringify([n.rerender.cache, n.rerender.chart, n.rerender.rafErrors]));
  for (const k of Object.keys(o.api)) same(`${key}: window API ${k} identical`, JSON.stringify(o.api[k]), JSON.stringify(n.api[k]));
  same(`${key}: alerts identical`, JSON.stringify(o.alerts), JSON.stringify(n.alerts));
}
function ser4(x) { return JSON.stringify([x.rafErrors, x.error, x.config, x.cache]); }

console.log('\n(B) pure compute.js against tests/golden/node/stage6-bearing');
const { normalize } = await import('./golden/lib/normalize.mjs');
const { compare, formatDiffs } = await import('./golden/lib/compare.mjs');
const { readGolden, stableJson } = await import('./golden/lib/store.mjs');
const compute = await import('../src/lib/cpt-app/bearing/compute.js');
const TOL = JSON.parse(readFileSync(resolve(ROOT, 'tests/golden/tolerances.json'), 'utf8')).pure;
function golden(label, rel, actual) {
  const expected = readGolden(rel);
  check(`${label}: golden ${rel} exists`, expected !== undefined);
  if (expected === undefined) return;
  const norm = normalize(actual);
  const diffs = compare(expected, norm, TOL);
  check(`${label}: within the pure tolerance`, diffs.length === 0, diffs.length ? '\n' + formatDiffs(diffs, 8) : '');
  check(`${label}: JSON text identical`, stableJson(norm) === stableJson(expected));
}
for (const [fx, inp] of Object.entries(newDump.pure)) {
  const env = { wt: inp.wt };
  const layers = inp.layers;
  check(`${fx}: working layers + water table captured (${layers.length} layers, wt ${inp.wt})`, layers.length > 0 && Number.isFinite(inp.wt));
  for (const variant of ['default', 'heavy', 'edge']) {
    const cfg = readGolden(`node/stage6-bearing/${fx}.${variant}.config.json`);
    check(`${fx}.${variant}: config golden exists`, cfg !== undefined);
    if (!cfg) continue;
    golden(`${fx}.${variant} bearingProfile(cfg, layers, {wt})`, `node/stage6-bearing/${fx}.${variant}.json`, compute.bearingProfile(cfg, layers, env));
  }
  // extra cases of the suite (scripts/golden/suites/stage6-bearing.mjs): the state after the edge render
  const edgeCfg = readGolden(`node/stage6-bearing/${fx}.edge.config.json`);
  if (edgeCfg) {
    const cfg = { ...edgeCfg, Df: 1.0, B: 1.5, L: 1.5, eB: 0, eL: 0, load: 150 };
    const maxDepth = inp.maxDepth;
    golden(`${fx}.at-depth bearingAtDepth(z, cfg, layers, {wt})`, `node/stage6-bearing/${fx}.at-depth.json`, [0.2, 1.0, 2.5, maxDepth / 2, maxDepth].map((z) => ({ z, result: compute.bearingAtDepth(z, cfg, layers, env) })));
    golden(`${fx}.layer-at-depth layerAtDepth(z, layers)`, `node/stage6-bearing/${fx}.layer-at-depth.json`, [0, 0.5, 3.0, maxDepth - 0.01, maxDepth + 1].map((z) => ({ z, layer: compute.layerAtDepth(z, layers) })));
  }
}
// explicit-input contract of the pure functions
check('bearingAtDepth without env.wt throws (no hidden water table)', (() => { try { compute.bearingAtDepth(1, { B: 1.5, L: 1.5, Df: 1 }, newDump.pure[DEMO_FIXTURE].layers); return false; } catch (e) { return /env\.wt/.test(String(e.message)); } })());
check('bearingProfile / layerAtDepth without layers return null', compute.bearingProfile({ Df: 1 }, [], { wt: 1 }) === null && compute.bearingProfile({ Df: 1 }, null, { wt: 1 }) === null && compute.layerAtDepth(1, []) === null && compute.layerAtDepth(1, null) === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
