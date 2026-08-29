#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Verifier for refactor step 8 (PR 14, worklog/refactor/16-pr14-project-section-tuning.md): the
// project/ (banner, CPT list, phase, stage nav), section/ (Doorsnede SVG, tooltip, export) and
// tuning/ (Stage 5 fit, cards, charts) packages must be a pure move, and the controller's `S`
// must keep tracking `setActive(idx)`.
//
// Like scripts/verify_stage6_shell.mjs: the controller of a base ref (default `integration-r`, the
// last commit before the extraction) and the working-tree controller are each loaded under Node
// through the Tier-B loader (scripts/golden/lib/load-controller.mjs: Vite ssrLoadModule + DOM
// stub) in their own child process, dump the same observations to JSON, and the parent compares
// the two dumps byte for byte:
//
//   (a) banner — #cptTabs innerHTML + #projName after a fresh load, the demo import, setCptName
//       (trimmed / empty → default id), addCpt (+ the #fi click), removeCpt (+ the single-CPT
//       guard), and after each of the three project fixtures (tests/golden/fixtures/projects/*)
//   (b) selectCpt round trips on multi-3cpt ([0,1,2,0,2,1] + two out-of-range no-ops): active
//       index / id, every stub element (Stage 1 controls, method cards, chart area, nav) and the
//       S façade — a write through an S-based handler (setCptCoord) lands on the selected CPT
//   (c) goS round trips (S._maxStage + the rendered stage bodies)
//   (d) setPhase over the three phases per project fixture, the section SVG (+ viewBox/width/
//       height, a second vertical exaggeration), the tooltip listeners fired with synthetic
//       events (near / flipped / miss / leave / no double binding), exportSectionSVG's download
//       (file name + blob text), and the single-CPT placeholder on the demo import
//   (e) tuning on the demo import and on every CPT of the project fixtures: #tuningArea innerHTML
//       byte-identical, S.tuning, the slider helpers, fitLayer, the two Chart.js configs per card
//       (buildTuningCharts fed the [data-chart-pending] elements the markup describes), the live
//       slider (valid / bigger / ≤ 0 / non-numeric / empty → DOM + chart datasets), accept /
//       reject (+ bogus indices, + the Stage 4 re-render when #p3 is active)
//   (f) Tier A: the pure builders reproduce the working tree's DOM output (bannerTabsHtml,
//       sectionTooltipHtml / Position, sectionSvgFileName) and the pure tuning functions recompute
//       tests/golden/node/tuning/* (63 cases) through the golden context, byte for byte after the
//       harness normalisation — the tuning suite's Tier-A migration (tests/golden/README.md step 8)
//
// Usage
//   node scripts/verify_project_section_tuning.mjs                 compare against integration-r
//   node scripts/verify_project_section_tuning.mjs --base <ref>    compare against another git ref
//   node scripts/verify_project_section_tuning.mjs --snapshot f.json   dump the working tree only
//   node scripts/verify_project_section_tuning.mjs --against f.json    compare the working tree with a dump
//
// The base controller is materialised as src/lib/cpt-app/__verify-pst-base.legacy-controller.js
// (its relative imports need that directory) and deleted again, whatever happens.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CTRL_REL = 'src/lib/cpt-app/legacy-controller.js';
const BASE_REL = 'src/lib/cpt-app/__verify-pst-base.legacy-controller.js';
const PROJECT_FIXTURES = ['legacy-v0.5.2', 'multi-3cpt', 'single-layered'];
const DEMO_FIXTURE = 'demo-anonymous';
const SELECT_SEQUENCE = [0, 1, 2, 0, 2, 1, 3, -1];
const NAV_SEQUENCE = [1, 2, 3, 4, 2, 0];
const PHASE_SEQUENCE = ['analysis', 'correlation', 'section', 'analysis'];

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

// JSON with undefined / NaN / ±Infinity made visible, key order preserved (no sorting).
const ser = (v) => JSON.stringify(v, (k, x) => (x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x));

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
  const P = () => api.PROJECT;
  const S = () => P().cpts[P().activeCptIdx];
  const el = (id) => stub.document.getElementById(id);
  function resetProject() {
    const proj = P();
    proj.cpts.splice(0, proj.cpts.length, api.newCptState('CPT-1'));
    proj.activeCptIdx = 0; proj.sectionOrder = [0]; proj.name = 'CPT Project'; proj.phase = 'analysis'; proj.stratigraphy = null;
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
  async function loadProject(name) {
    const rel = `projects/${name}.madep.json`;
    await api.loadProjectFromFile(new File([readFileSync(join(FIX, rel))], `${name}.madep.json`));
  }
  // Every stub element the controller touched, by id (or `sel:` selector key), as plain data.
  function elSnap(e) {
    const o = { innerHTML: e.innerHTML, textContent: e.textContent, value: e.value, checked: e.checked, disabled: e.disabled, className: e.className, classes: e.classList.value, style: { ...e.style }, dataset: { ...e.dataset } };
    for (const a of ['viewBox', 'width', 'height']) { const v = e.getAttribute(a); if (v != null) (o.attrs ??= {})[a] = v; }
    return o;
  }
  function domSnapshot() {
    const out = {};
    for (const k of [...stub.els.keys()].sort()) out[k] = elSnap(stub.els.get(k));
    return out;
  }
  const bannerObs = () => ({
    tabs: el('cptTabs').innerHTML,
    projName: el('projName').value,
    shape: { name: P().name, activeCptIdx: P().activeCptIdx, cpts: P().cpts.map((c) => ({ id: c.id, data: c.data.length, layers: c.layers.length })) }
  });
  const dump = { controller: ctrlRel, banner: {}, select: [], nav: [], section: {}, tuning: {} };

  // (a) banner
  dump.banner.fresh = bannerObs();
  resetProject(); await importCpt(DEMO_FIXTURE);
  dump.banner.demo = bannerObs();
  api.setCptName(0, '  Sondering A  '); dump.banner.renamed = bannerObs();
  api.setCptName(0, '   '); dump.banner.renamedEmpty = bannerObs();
  let fiClicks = 0;
  el('fi').click = () => { fiClicks += 1; };
  stub.rafErrors.length = 0;
  api.addCpt();
  dump.banner.added = { ...bannerObs(), fiClicks, sectionOrder: [...P().sectionOrder], rafErrors: stub.rafErrors.slice(), dom: domSnapshot() };
  api.setCptName(1, 'B');
  dump.banner.addedRenamed = bannerObs();
  api.removeCpt(1);
  dump.banner.removed = { ...bannerObs(), sectionOrder: [...P().sectionOrder], dom: domSnapshot() };
  api.removeCpt(0);
  dump.banner.removeLast = { ...bannerObs(), sectionOrder: [...P().sectionOrder] };
  for (const name of PROJECT_FIXTURES) {
    resetProject(); await loadProject(name);
    dump.banner[name] = { ...bannerObs(), phase: P().phase, sectionOrder: [...P().sectionOrder], dom: domSnapshot() };
  }

  // (b) selectCpt round trips
  resetProject(); await loadProject('multi-3cpt');
  api.setPhase('analysis');
  for (const idx of SELECT_SEQUENCE) {
    stub.rafErrors.length = 0;
    api.selectCpt(idx);
    const active = P().activeCptIdx;
    const probe = 123.5 + idx;
    const before = P().cpts[active].x;
    api.setCptCoord('x', String(probe));
    const tracks = P().cpts[active].x === probe;
    P().cpts[active].x = before;
    dump.select.push({ idx, active, id: S().id, tracks, chartsReady: S().chartsReady, chartKeys: Object.keys(S().charts || {}), rafErrors: stub.rafErrors.map((e) => e.split('\n')[0]), dom: domSnapshot() });
  }
  // (c) goS round trips on the CPT the sequence left active
  for (const n of NAV_SEQUENCE) {
    api.goS(n);
    dump.nav.push({ n, maxStage: S()._maxStage, dom: domSnapshot() });
  }

  // (d) phases + section
  function tooltipObs() {
    const svg = el('sectionSvg'), tip = el('sectionTip');
    const m = svg.innerHTML.match(/<rect class="section-layer-hit"[\s\S]*?\/>/);
    const listeners = svg._listeners || {};
    const move = (listeners.mousemove || [])[0];
    const leave = (listeners.mouseleave || [])[0];
    const out = { bound: svg.dataset.tipBound || null, listeners: Object.fromEntries(Object.entries(listeners).map(([k, v]) => [k, v.length])), hasRect: !!m };
    if (!m || !move) return out;
    const dataset = {};
    for (const [, k, v] of m[0].matchAll(/data-([a-z]+)="([^"]*)"/g)) dataset[k] = v;
    out.dataset = dataset;
    const target = { dataset };
    const evt = (x, y, hit) => ({ clientX: x, clientY: y, target: { closest: () => (hit ? target : null) } });
    const fire = (ev) => { move(ev); return { display: tip.style.display, left: tip.style.left, top: tip.style.top, html: tip.innerHTML }; };
    out.near = fire(evt(100, 120, true));
    out.farRight = fire(evt(790, 390, true));
    out.miss = fire(evt(10, 10, false));
    if (leave) { leave(); out.leave = { display: tip.style.display }; }
    api.renderSection();
    out.listenersAfterRerender = Object.fromEntries(Object.entries(svg._listeners || {}).map(([k, v]) => [k, v.length]));
    return out;
  }
  for (const name of PROJECT_FIXTURES) {
    resetProject(); await loadProject(name);
    const rec = { phases: [] };
    for (const ph of PHASE_SEQUENCE) { api.setPhase(ph); rec.phases.push({ ph, phase: P().phase, dom: domSnapshot() }); }
    api.setPhase('section');
    rec.svg = elSnap(el('sectionSvg'));
    el('vexag').value = '3'; api.renderSection(); rec.vex3 = elSnap(el('sectionSvg')); el('vexag').value = '';
    api.renderSection();
    rec.tooltip = tooltipObs();
    stub.captured.length = 0;
    const svgEl = el('sectionSvg'); svgEl.outerHTML = `<svg>${svgEl.innerHTML}</svg>`;
    api.exportSectionSVG();
    const cap = stub.captured[0];
    rec.export = cap ? { download: cap.download, projectName: P().name, text: cap.blob ? await cap.blob.text() : null } : null;
    api.setPhase('analysis');
    dump.section[name] = rec;
  }
  resetProject(); await importCpt(DEMO_FIXTURE);
  api.setPhase('section');
  dump.section.demo = { phase: P().phase, svg: elSnap(el('sectionSvg')), tooltip: tooltipObs() };
  api.setPhase('analysis');

  // (e) tuning
  function pendingElements(html) {
    const out = [];
    for (const block of html.matchAll(/<div data-chart-pending="[\s\S]*?>\s*<\/div>/g)) {
      const dataset = {};
      for (const m of block[0].matchAll(/data-([a-z-]+)=(?:"([^"]*)"|'([^']*)')/g)) {
        dataset[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = (m[2] ?? m[3]).replace(/&#39;/g, "'");
      }
      out.push({ dataset });
    }
    return out;
  }
  const chartObs = (canvas) => ({ built: !!canvas._built, config: canvas._chartRef ? JSON.parse(ser(canvas._chartRef.config)) : null });
  const previewDom = (i) => ['fitPreviewInput', 'fitPreviewM', 'fitPreviewRef', 'fitPreviewNote', 'fitAcceptBtn'].map((id) => [id + i, elSnap(el(id + i))]);
  const overrides = () => S().layers.map((l) => ({ m_ovr: l.m_ovr ?? null, ovr: l.ovr }));
  const hs = () => S().layers.map((l) => api.hsParams(l));
  function tuningFlow() {
    S().method = 'sb260'; api.runClass(); api.goS(3); api.goS(4);
    const rec = { id: S().id, layers: S().layers.length };
    rec.before = { tuning: S().tuning, area: el('tuningArea').innerHTML };
    api.runTuning();
    rec.run = { tuning: ser(S().tuning), area: el('tuningArea').innerHTML };
    rec.helpers = S().tuning.map((t) => ({ i: t.i, previewM: api.getTuningPreviewM(t), bounds: t.fit ? api.tuningSliderBounds(t.fit) : null, eoedRef: t.fit ? api.tuningPreviewEoedRef(t.fit, api.getTuningPreviewM(t)) : null, line: t.fit ? api.tuningPreviewLineData(t.fit, api.getTuningPreviewM(t)) : null }));
    rec.fitLayerDirect = ser(S().layers.map((l) => api.fitLayer(l)));
    const pending = pendingElements(el('tuningArea').innerHTML);
    const origQSA = stub.document.querySelectorAll;
    stub.document.querySelectorAll = (sel) => (sel === '[data-chart-pending]' ? pending : []);
    try { api.buildTuningCharts(); api.buildTuningCharts(); } finally { stub.document.querySelectorAll = origQSA; }
    rec.charts = pending.map((p) => ({ id: p.dataset.chartPending, reg: chartObs(el(p.dataset.chartPending)), dep: chartObs(el(p.dataset.chartDepth)) }));
    const t0 = S().tuning[0];
    rec.preview = [];
    if (t0?.fit) {
      for (const raw of [String(+(api.getTuningPreviewM(t0) * 1.1).toFixed(3)), '0.25', '-1', 'abc', '']) {
        api.updateTuningPreviewM(0, raw);
        rec.preview.push({ raw, previewM: ser(t0.previewM), dom: previewDom(0), reg: chartObs(el('tChart0')), dep: chartObs(el('tChart0d')) });
      }
    }
    api.updateTuningPreviewM(99, '1');
    api.acceptFit(0); rec.accepted0 = { layers: overrides(), area: el('tuningArea').innerHTML, hs: hs() };
    S().tuning.forEach((t) => api.acceptFit(t.i)); rec.acceptedAll = { layers: overrides(), area: el('tuningArea').innerHTML, hs: hs() };
    api.acceptFit(99); rec.acceptBogus = overrides();
    S().tuning.forEach((t) => api.rejectFit(t.i)); rec.rejectedAll = { layers: overrides(), area: el('tuningArea').innerHTML, hs: hs() };
    api.rejectFit(99); rec.rejectBogus = overrides();
    el('p3').classList.add('active');
    api.acceptFit(0); rec.acceptWithStage4 = { layers: overrides(), dom: domSnapshot() };
    el('p3').classList.remove('active');
    rec.tuningFinal = ser(S().tuning);
    return rec;
  }
  resetProject(); await importCpt(DEMO_FIXTURE);
  dump.tuning.demo = tuningFlow();
  for (const name of PROJECT_FIXTURES) {
    resetProject(); await loadProject(name);
    api.setPhase('analysis');
    for (let i = 0; i < P().cpts.length; i += 1) {
      api.selectCpt(i);
      dump.tuning[`${name}[${i}]`] = tuningFlow();
    }
  }

  writeFileSync(outPath, JSON.stringify(dump));
  await server.close();
  process.exit(0);
}

// ─────────────────────────────── child: Tier A recompute of the tuning goldens ───────────────────────────────
if (args[0] === '--tier-a') {
  const { makeContext } = await import('./golden/lib/context.mjs');
  const { readGolden } = await import('./golden/lib/store.mjs');
  const { normalize, normalizeText } = await import('./golden/lib/normalize.mjs');
  const { htmlToText } = await import('./golden/lib/html-text.mjs');
  const tuning = await import('../src/lib/cpt-app/tuning/index.js');
  const { hsParams, cptModelCtx } = await import('../src/lib/cpt-app/model-params/index.js');
  const ctx = await makeContext();
  const { api } = await ctx.controller();
  const results = [];
  const cmp = (id, value) => { const exp = readGolden(`node/tuning/${id}.json`); results.push({ id, ok: exp !== undefined && JSON.stringify(exp) === JSON.stringify(normalize(value)) }); };
  const cmpTxt = (id, text) => { const exp = readGolden(`node/tuning/${id}.txt`); results.push({ id, ok: exp !== undefined && exp === normalizeText(text) }); };
  for (const fx of ctx.fixtures.cptNames()) {
    const live = await ctx.classify(fx, 'sb260');
    api.goS(3); api.goS(4);
    // A plain copy of the CPT state: the pure functions get layers they may mutate (accept/reject)
    // and never touch the controller's S.
    const cpt = { ...live, layers: live.layers.map((l) => ({ ...l, ovr: { ...l.ovr } })), tuning: null };
    const tctx = tuning.tuningCtx(cpt);
    cpt.tuning = tuning.runTuningFits(cpt.layers, tctx);
    cmp(fx, cpt.tuning);
    cmpTxt(`${fx}.dom`, htmlToText(tuning.tuningAreaHtml(cpt)));
    cmp(`${fx}.helpers`, cpt.tuning.map((t) => ({ i: t.i, previewM: tuning.getTuningPreviewM(t), bounds: t.fit ? tuning.tuningSliderBounds(t.fit) : null, eoedRef: t.fit ? tuning.tuningPreviewEoedRef(t.fit, tuning.getTuningPreviewM(t)) : null, line: t.fit ? tuning.tuningPreviewLineData(t.fit, tuning.getTuningPreviewM(t)) : null })));
    const hs = () => cpt.layers.map((l) => hsParams(l, cptModelCtx(cpt)));
    const ovr = () => cpt.layers.map((l) => ({ m_ovr: l.m_ovr ?? null, ovr: l.ovr }));
    tuning.acceptFit(cpt, 0);
    cmp(`${fx}.accepted0`, { layers: ovr(), hs: hs() });
    cpt.tuning.forEach((t) => tuning.acceptFit(cpt, t.i));
    cmp(`${fx}.accepted-all`, { layers: ovr(), hs: hs() });
    cpt.tuning.forEach((t) => tuning.rejectFit(cpt, t.i));
    cmp(`${fx}.rejected-all`, { layers: ovr(), hs: hs() });
    if (cpt.tuning[0]?.fit) {
      const raw = String(+(tuning.getTuningPreviewM(cpt.tuning[0]) * 1.1).toFixed(3));
      cpt.tuning[0].previewM = tuning.tuningPreviewView(cpt.tuning[0], raw).parsed;
      cmp(`${fx}.preview-slider`, { previewM: cpt.tuning[0].previewM, hs0: hsParams(cpt.layers[0], cptModelCtx(cpt)) });
    }
  }
  writeFileSync(args[1], JSON.stringify(results));
  await ctx.close();
  process.exit(0);
}

// ─────────────────────────────── parent: run + compare ───────────────────────────────
function runChild(mode, childArgs) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode, ...childArgs], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${mode} ${childArgs[0]} failed (exit ${r.status})`);
}
function runDump(ctrlRel, outPath) {
  runChild('--dump', [ctrlRel, outPath]);
  return JSON.parse(readFileSync(outPath, 'utf8'));
}

let pass = 0, fail = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; failures.push(label); console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** First differing path between two JSON-able values. */
function firstDiff(x, y, path = '') {
  if (x === y) return null;
  if (typeof x === 'string' && typeof y === 'string') {
    let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i += 1;
    return `${path || '<root>'} at char ${i}: …${JSON.stringify(x.slice(Math.max(0, i - 40), i + 60))} vs …${JSON.stringify(y.slice(Math.max(0, i - 40), i + 60))}`;
  }
  if (typeof x !== typeof y || x === null || y === null || typeof x !== 'object') return `${path || '<root>'}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`;
  const kx = Object.keys(x), ky = Object.keys(y);
  if (kx.join(' ') !== ky.join(' ')) {
    const missing = kx.filter((k) => !ky.includes(k)), extra = ky.filter((k) => !kx.includes(k));
    if (missing.length || extra.length) return `${path || '<root>'}: keys missing ${JSON.stringify(missing)} extra ${JSON.stringify(extra)}`;
    return `${path || '<root>'}: key order ${JSON.stringify(kx)} → ${JSON.stringify(ky)}`;
  }
  for (const k of kx) { const d = firstDiff(x[k], y[k], path ? `${path}.${k}` : k); if (d) return d; }
  return null;
}
const same = (label, a, b) => check(label, JSON.stringify(a) === JSON.stringify(b), firstDiff(a, b) || '');

const tmp = mkdtempSync(join(tmpdir(), 'verify-pst-'));
const basePath = resolve(ROOT, BASE_REL);
let oldDump, newDump, tierA;
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
  console.log('tier A: tuning goldens through the pure functions …');
  runChild('--tier-a', [join(tmp, 'tier-a.json')]);
  tierA = JSON.parse(readFileSync(join(tmp, 'tier-a.json'), 'utf8'));
} finally {
  if (existsSync(basePath)) rmSync(basePath);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n(a) banner');
for (const key of Object.keys(oldDump.banner)) {
  const o = oldDump.banner[key], n = newDump.banner[key] || {};
  same(`${key}: #cptTabs innerHTML byte-identical (${o.tabs.length} chars)`, o.tabs, n.tabs);
  same(`${key}: #projName + project shape`, [o.projName, o.shape, o.sectionOrder ?? null, o.phase ?? null, o.fiClicks ?? null, o.rafErrors ?? null], [n.projName, n.shape, n.sectionOrder ?? null, n.phase ?? null, n.fiClicks ?? null, n.rafErrors ?? null]);
  if (o.dom) same(`${key}: every stub element identical (${Object.keys(o.dom).length} ids)`, o.dom, n.dom);
}

console.log('\n(b) selectCpt round trips on multi-3cpt');
check(`sequence length ${SELECT_SEQUENCE.length}`, oldDump.select.length === newDump.select.length && newDump.select.length === SELECT_SEQUENCE.length);
oldDump.select.forEach((o, k) => {
  const n = newDump.select[k] || {};
  same(`selectCpt(${o.idx}): active ${o.active} "${o.id}", charts, rAF errors`, [o.active, o.id, o.chartsReady, o.chartKeys, o.rafErrors], [n.active, n.id, n.chartsReady, n.chartKeys, n.rafErrors]);
  check(`selectCpt(${o.idx}): S façade tracks setActive (old ${o.tracks} / new ${n.tracks})`, o.tracks === true && n.tracks === true);
  same(`selectCpt(${o.idx}): every stub element identical`, o.dom, n.dom);
});

console.log('\n(c) goS round trips');
oldDump.nav.forEach((o, k) => {
  const n = newDump.nav[k] || {};
  same(`goS(${o.n}): _maxStage ${o.maxStage} + every stub element identical`, [o.maxStage, o.dom], [n.maxStage, n.dom]);
});

console.log('\n(d) phases, section SVG, tooltip, export');
for (const name of [...PROJECT_FIXTURES, 'demo']) {
  const o = oldDump.section[name], n = newDump.section[name] || {};
  if (o.phases) o.phases.forEach((p, k) => same(`${name}: setPhase('${p.ph}') #${k}: phase + every stub element identical`, p, (n.phases || [])[k]));
  same(`${name}: #sectionSvg innerHTML + viewBox/width/height (${o.svg.innerHTML.length} chars)`, o.svg, n.svg);
  if (o.vex3) same(`${name}: section at vex 3`, o.vex3, n.vex3);
  same(`${name}: tooltip listeners, near / flipped / miss / leave, no double binding`, o.tooltip, n.tooltip);
  if (o.export !== undefined) same(`${name}: exportSectionSVG download (${o.export?.download})`, o.export, n.export);
  if (o.phase !== undefined) same(`${name}: phase`, o.phase, n.phase);
}

console.log('\n(e) tuning');
for (const key of Object.keys(oldDump.tuning)) {
  const o = oldDump.tuning[key], n = newDump.tuning[key] || {};
  same(`${key} (${o.id}, ${o.layers} layers): placeholder before the run`, o.before, n.before);
  same(`${key}: runTuning → S.tuning`, o.run.tuning, n.run.tuning);
  same(`${key}: #tuningArea innerHTML byte-identical (${o.run.area.length} chars)`, o.run.area, n.run.area);
  same(`${key}: slider helpers`, o.helpers, n.helpers);
  same(`${key}: fitLayer per layer`, o.fitLayerDirect, n.fitLayerDirect);
  same(`${key}: Chart.js configs of ${o.charts.length} cards (built once)`, o.charts, n.charts);
  same(`${key}: live slider ×${o.preview.length} (previewM, DOM, chart datasets)`, o.preview, n.preview);
  same(`${key}: acceptFit(0)`, o.accepted0, n.accepted0);
  same(`${key}: accept all / bogus index`, [o.acceptedAll, o.acceptBogus], [n.acceptedAll, n.acceptBogus]);
  same(`${key}: reject all / bogus index`, [o.rejectedAll, o.rejectBogus], [n.rejectedAll, n.rejectBogus]);
  same(`${key}: acceptFit with #p3 active re-renders Stage 4 (every stub element identical)`, o.acceptWithStage4, n.acceptWithStage4);
  same(`${key}: final S.tuning`, o.tuningFinal, n.tuningFinal);
}

console.log('\n(f) tier A — pure builders vs the working tree, tuning goldens recomputed');
{
  const { bannerTabsHtml } = await import('../src/lib/cpt-app/project/banner.js');
  const { sectionTooltipHtml, sectionTooltipPosition, sectionSvgFileName } = await import('../src/lib/cpt-app/section/index.js');
  for (const key of Object.keys(newDump.banner)) {
    const b = newDump.banner[key];
    const project = { activeCptIdx: b.shape.activeCptIdx, cpts: b.shape.cpts.map((c) => ({ id: c.id, data: new Array(c.data), layers: new Array(c.layers) })) };
    same(`bannerTabsHtml == #cptTabs (${key})`, bannerTabsHtml(project), b.tabs);
  }
  for (const name of PROJECT_FIXTURES) {
    const s = newDump.section[name];
    if (s.tooltip?.dataset) {
      same(`sectionTooltipHtml == #sectionTip (${name})`, sectionTooltipHtml(s.tooltip.dataset), s.tooltip.near.html);
      const rect = { left: 0, top: 0, width: 800, height: 400 };
      const near = sectionTooltipPosition({ clientX: 100, clientY: 120, rect, scrollLeft: 0, scrollTop: 0 });
      const far = sectionTooltipPosition({ clientX: 790, clientY: 390, rect, scrollLeft: 0, scrollTop: 0 });
      same(`sectionTooltipPosition == tip left/top (${name})`, [`${near.left}px`, `${near.top}px`, `${far.left}px`, `${far.top}px`], [s.tooltip.near.left, s.tooltip.near.top, s.tooltip.farRight.left, s.tooltip.farRight.top]);
    }
    if (s.export) same(`sectionSvgFileName == download name (${name})`, sectionSvgFileName(s.export.projectName), s.export.download);
  }
  const bad = tierA.filter((r) => !r.ok).map((r) => r.id);
  check(`tests/golden/node/tuning/* recomputed with tuning/fit.js + panel.js: ${tierA.length - bad.length} / ${tierA.length}`, tierA.length >= 63 && bad.length === 0, bad.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failed: ' + failures.join('; ')); process.exit(1); }
