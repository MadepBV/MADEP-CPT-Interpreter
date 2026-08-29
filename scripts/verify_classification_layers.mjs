#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifier for src/lib/cpt-app/classification/* and src/lib/cpt-app/layers/* — the Stage 2
// classification run and the Stage 3 layer detection moved out of legacy-controller.js in
// refactor step 3 (PR 6): classifyRow(cpt, row, method), classifyCpt(cpt, ctx), the panel
// string builders, the Tabel 3 compatibility helpers, the segment / merge chain and
// detectLayers(cpt, ctx) → layers[] (pure, no render).
//
// Four parts:
//   1. unit checks of the pure functions under plain Node (no Vite, no DOM stub);
//   2. the recorded goldens are the truth — every tests/golden/node/classification/<fx>.<method>.json
//      (+ .metrics.txt, + the qc-only assumed-Rf variants) is recomputed from the fixture's import
//      golden (rows, wt, elev, meta, assumedRf; manifest `inject` applied) with classifyCpt() and the
//      panel builders, and every tests/golden/node/layers/<fx>.{<method>.smart|<method>.simple|
//      minThk*|sens*}.json from the classification golden with detectLayers(); all must be
//      deep-equal after the goldens' normalisation (tolerance class "pure", exact);
//   3. wrapper ⇔ pure agreement: the controller is loaded through the golden Tier-B loader
//      (scripts/golden/lib — DOM stub, no browser) for the demo fixture and the monolith wrappers
//      runClass / detectLayers / segmentSummary / classRob… and the four Stage 2 DOM regions must
//      equal what the pure functions return for the active CPT. Skip with --pure-only.
//   4. extraction complete: the moved bodies are not declared in the controller again, the
//      packages are imported, the wrappers are present, every module carries SPDX + @ts-nocheck.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'tests/golden');
const PURE_ONLY = process.argv.includes('--pure-only');

const {
  classificationMethodLabel, classificationMetricLabel, classificationMetricValue,
  assumedRfValue, cptHasFs, cptHasRf,
  classRob, classRob2016, classCUR3, classCUR, classNEN6740, classSB260, classifyRow,
  classifyCpt,
  classificationMetricsHtml, classificationAssumedRfNoteHtml, classificationTableRowsHtml
} = await import('../src/lib/cpt-app/classification/index.js');
const {
  CAT_GROUPS, COMPAT, compatLevel, subtypeGroup, qcRfFit, suggestSubtype, layerTypeCompatScore,
  segmentSummary, segmentTop, familyClass,
  qcSimilarity, rfSimilarity, subtypeSimilarity, paramSimilarity, compatSimilarity, continuityScore,
  isCriticalMarkerLayer, SMART_SLIVER_REF, mergeCandidateScore,
  simpleUpwardMerge, smartSimilarityReduce, enforceMinThicknessBySimilarity, smartPostMerge,
  layersCtx, classificationSegmentKey, detectLayers
} = await import('../src/lib/cpt-app/layers/index.js');
const { CAT } = await import('../src/lib/cpt-app/eurocode-tabel3.js');
const { DEF } = await import('../src/lib/cpt-app/model-params/soil-defaults.js');
const { stressAt } = await import('../src/lib/cpt-app/model-params/stress.js');
const {
  classifyRobertson1990, classifyTabel3, classifyCUR3: coreCUR3, classifyNEN6740: coreNEN6740, normalizeAssumedRf, DEFAULT_ASSUMED_RF
} = await import('../src/lib/cpt-app/classification-core.js');
const { htmlToText } = await import('./golden/lib/html-text.mjs');

const METHODS = ['robertson', 'robertson2016', 'cur3', 'nen6740', 'sb260'];
/** newCptState() defaults of the detection settings (legacy-controller.js) — the suites
 *  set method / smartMerge / minThk / smartMergeSensitivity explicitly, paramMethod stays. */
const CPT_DEFAULTS = { minThk: 0.50, smartMerge: true, smartMergeSensitivity: 1.10, paramMethod: 'sb260' };

let fails = 0;
let count = 0;
function check(name, fn) {
  count++;
  try { fn(); console.log(`OK    ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n').slice(0, 12).join('\n      ')}`); }
}

/** Same shape the golden normaliser stores: keys sorted, undefined dropped, non-finite as strings. */
function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) { if (v[k] !== undefined && typeof v[k] !== 'function') o[k] = canon(v[k]); }
    return o;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const readTxt = (p) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n').trimEnd();

const row = (z, qc, rf, over = {}) => ({ z, qc, rf, fs: rf == null ? null : qc * rf / 100, u2: null, ...over });
const cptOf = (over = {}) => ({
  wt: 1.7, elev: 10, assumedRf: 3, method: 'sb260', meta: { aRatio: 0.79, hasFs: true, hasRf: true },
  data: [row(0.5, 0.3, 4), row(1.0, 0.4, 3.5), row(1.5, 8, 0.6), row(2.0, 12, 0.5), row(2.5, 1.2, 4.5), row(3.0, 1.1, 5)],
  classified: [], layers: [], useSB260params: false, ...CPT_DEFAULTS, ...over
});

// ------------------------------------------------------------ 1. unit checks
console.log('\n[1] classification/labels.js');
check('classificationMethodLabel: the five methods, raw fallback, "Unknown" for empty', () => {
  assert.equal(classificationMethodLabel('robertson'), 'Robertson (1990)');
  assert.equal(classificationMethodLabel('robertson2016'), 'Robertson (2016)');
  assert.equal(classificationMethodLabel('cur3'), 'CUR 3 layers');
  assert.equal(classificationMethodLabel('nen6740'), 'NEN 6740');
  assert.equal(classificationMethodLabel('sb260'), 'NEN Tabel 3 / EC7');
  assert.equal(classificationMethodLabel('x'), 'x');
  assert.equal(classificationMethodLabel(''), 'Unknown');
});
check('classificationMetricLabel / Value: Ic, Qtn (1 dec), qc,NEN (2 dec), "—" otherwise', () => {
  assert.equal(classificationMetricLabel('robertson'), 'Ic (-)');
  assert.equal(classificationMetricLabel('robertson2016'), 'Qtn (-)');
  assert.equal(classificationMetricLabel('nen6740'), 'qc,NEN (MPa)');
  assert.equal(classificationMetricLabel('sb260'), 'Metric (-)');
  assert.equal(classificationMetricValue('robertson', { Ic: 2.345 }), 2.345);
  assert.equal(classificationMetricValue('robertson', { Ic: null }), '—');
  assert.equal(classificationMetricValue('robertson2016', { Qt: 12.34 }), '12.3');
  assert.equal(classificationMetricValue('nen6740', { Qt: 1.2345 }), '1.23');
  assert.equal(classificationMetricValue('sb260', { Qt: 1 }), '—');
});

console.log('\n[2] classification/classify.js');
check('assumedRfValue / cptHasFs / cptHasRf read the CPT (meta flags first, data fallback)', () => {
  assert.equal(assumedRfValue({ assumedRf: 2.5 }), 2.5);
  assert.equal(assumedRfValue({ assumedRf: null }), DEFAULT_ASSUMED_RF);
  assert.equal(assumedRfValue({ assumedRf: 50 }), normalizeAssumedRf(50));
  assert.equal(cptHasFs({ meta: { hasFs: false }, data: [row(1, 1, 1)] }), false);
  assert.equal(cptHasFs({ meta: {}, data: [row(1, 1, 1)] }), true);
  assert.equal(cptHasRf({ meta: {}, data: [row(1, 1, null)] }), false);
  assert.equal(cptHasRf({ data: [row(1, 1, null), row(2, 1, 2)] }), true);
});
check('classRob / classRob2016 / classNEN6740 use stressAt(cpt, z, 18, 17), meta.aRatio (0.8 default) and the assumed Rf', () => {
  const cpt = cptOf({ wt: 1.0, meta: { aRatio: 0.75 }, assumedRf: 2 });
  const r = row(2.0, 5, null);
  assert.deepEqual(classRob(cpt, r), classifyRobertson1990(r, { ...stressAt(cpt, 2.0, 18, 17), aRatio: 0.75, assumedRf: 2 }));
  assert.deepEqual(classRob({ ...cpt, meta: {} }, r), classifyRobertson1990(r, { ...stressAt(cpt, 2.0, 18, 17), aRatio: 0.8, assumedRf: 2 }));
  assert.deepEqual(classNEN6740(cpt, r), coreNEN6740(r, { sigVeff: stressAt(cpt, 2.0, 18, 17).sigVeff, assumedRf: 2 }));
  assert.notDeepEqual(classRob(cpt, r), classRob({ ...cpt, wt: 5 }, r)); // the water table matters
});
check('classCUR3 (= classCUR) / classSB260 only pass the assumed Rf', () => {
  const cpt = cptOf({ assumedRf: 4 });
  const r = row(1.0, 0.3, null);
  assert.equal(classCUR, classCUR3);
  assert.deepEqual(classCUR3(cpt, r), coreCUR3(r, { assumedRf: 4 }));
  assert.deepEqual(classSB260(cpt, r), classifyTabel3(r, { assumedRf: 4 }));
});
check('classifyRow dispatches on method (default cpt.method) and falls through to Tabel 3', () => {
  const cpt = cptOf({ method: 'robertson' });
  const r = row(1.2, 2, 3);
  assert.deepEqual(classifyRow(cpt, r), classRob(cpt, r));
  assert.deepEqual(classifyRow(cpt, r, 'robertson2016'), classRob2016(cpt, r));
  assert.deepEqual(classifyRow(cpt, r, 'cur3'), classCUR3(cpt, r));
  assert.deepEqual(classifyRow(cpt, r, 'nen6740'), classNEN6740(cpt, r));
  assert.deepEqual(classifyRow(cpt, r, 'sb260'), classSB260(cpt, r));
  assert.deepEqual(classifyRow(cpt, r, 'something-else'), classSB260(cpt, r));
});

console.log('\n[3] classification/run.js — classifyCpt(cpt, ctx)');
check('classified = rows merged with the classifier result; useSB260params only for sb260; no write to the CPT', () => {
  const cpt = cptOf();
  const res = classifyCpt(cpt);
  assert.equal(res.method, 'sb260');
  assert.equal(res.useSB260params, true);
  assert.equal(res.classified.length, 6);
  assert.deepEqual(res.classified[2], { ...cpt.data[2], ...classSB260(cpt, cpt.data[2]) });
  assert.equal(res.rfAssumedCount, 0);
  assert.deepEqual(cpt.classified, []);
  assert.equal(cpt.useSB260params, false);
  assert.equal(classifyCpt(cpt, { method: 'robertson' }).useSB260params, false);
  assert.deepEqual(classifyCpt(cpt, { method: 'robertson' }).classified[0], { ...cpt.data[0], ...classRob(cpt, cpt.data[0]) });
});
check('metrics: avg qc / fs (kPa) / Rf, max depth, readings, method label — with "—" for missing fs/Rf', () => {
  const res = classifyCpt(cptOf());
  assert.deepEqual(res.metrics.map((m) => m.l), ['avg qc (MPa)', 'avg fs (kPa)', 'avg Rf (%)', 'max depth (m)', 'readings', 'method']);
  assert.equal(res.metrics[0].v, ((0.3 + 0.4 + 8 + 12 + 1.2 + 1.1) / 6).toFixed(2));
  assert.equal(res.metrics[2].v, ((4 + 3.5 + 0.6 + 0.5 + 4.5 + 5) / 6).toFixed(2));
  assert.equal(res.metrics[3].v, '3.00');
  assert.equal(res.metrics[4].v, 6);
  assert.equal(res.metrics[5].v, 'NEN Tabel 3 / EC7');
  assert.equal(res.metricLabel, 'Metric (-)');
  const qcOnly = classifyCpt(cptOf({ data: [row(0.5, 1, null), row(1, 2, null)], meta: { hasFs: false, hasRf: false } }));
  assert.equal(qcOnly.metrics[1].v, '—');
  assert.equal(qcOnly.metrics[2].v, '—');
});
check('assumedRfNote: none / none-measured / partial (≥ 5 %) / gaps (< 5 %, depths listed when ≤ 3)', () => {
  const full = classifyCpt(cptOf());
  assert.deepEqual(full.assumedRfNote, { kind: 'none', missing: 0, n: 6, assumedRf: 3, gaps: [] });
  const none = classifyCpt(cptOf({ data: [row(0.5, 1, null), row(1, 2, null)], assumedRf: 2.5 }));
  assert.deepEqual(none.assumedRfNote, { kind: 'none-measured', missing: 2, n: 2, assumedRf: 2.5, gaps: [] });
  assert.equal(none.rfAssumedCount, 2);
  const twenty = Array.from({ length: 20 }, (_, i) => row(0.5 + i * 0.5, 3, i >= 19 ? null : 1));
  const gaps = classifyCpt(cptOf({ data: twenty }));   // 1/20 = 5 % → partial (≥ 0.05)
  assert.equal(gaps.assumedRfNote.kind, 'partial');
  const forty = Array.from({ length: 40 }, (_, i) => row(0.5 + i * 0.5, 3, i >= 39 ? null : 1));
  const g2 = classifyCpt(cptOf({ data: forty }));       // 1/40 = 2.5 % → gaps
  assert.deepEqual(g2.assumedRfNote, { kind: 'gaps', missing: 1, n: 40, assumedRf: 3, gaps: ['20.00'] });
  const fsOnlyMissing = classifyCpt(cptOf({ data: [row(0.5, 1, 2), row(1, 2, null), row(1.5, 2, 2)] }));
  assert.equal(fsOnlyMissing.assumedRfNote.kind, 'partial');
});

console.log('\n[4] classification/panel.js');
check('metric tiles, note variants and the row table are the runClass markup', () => {
  const cpt = cptOf();
  const res = classifyCpt(cpt);
  const tiles = classificationMetricsHtml(res.metrics);
  assert.equal((tiles.match(/<div class="met">/g) || []).length, 6);
  assert.ok(tiles.includes('<div class="met-l">avg qc (MPa)</div>'));
  assert.equal(classificationAssumedRfNoteHtml(res.assumedRfNote), '');
  assert.ok(classificationAssumedRfNoteHtml({ kind: 'none-measured', missing: 2, n: 2, assumedRf: 2.5, gaps: [] }).includes('layerwarn-bad'));
  assert.ok(classificationAssumedRfNoteHtml({ kind: 'none-measured', missing: 2, n: 2, assumedRf: 2.5, gaps: [] }).includes('R<sub>f</sub> = 2.5 %'));
  assert.ok(classificationAssumedRfNoteHtml({ kind: 'partial', missing: 3, n: 20, assumedRf: 3, gaps: [] }).includes('3 van 20 metingen'));
  const gaps = classificationAssumedRfNoteHtml({ kind: 'gaps', missing: 1, n: 40, assumedRf: 3, gaps: ['20.00'] });
  assert.ok(gaps.includes('data-note') && gaps.includes('(op 20.00 m)') && gaps.includes('De overige 39 metingen'));
  assert.ok(!classificationAssumedRfNoteHtml({ kind: 'gaps', missing: 4, n: 100, assumedRf: 3, gaps: ['1', '2', '3', '4'] }).includes('(op '));
  const rows = classificationTableRowsHtml(res.classified, { method: 'sb260', elev: 10 });
  assert.equal((rows.match(/<tr>/g) || []).length, 6);
  assert.ok(rows.includes('<td>0.500</td>') && rows.includes('<td style="color:var(--tx2)">9.50</td>'));
  assert.ok(classificationTableRowsHtml(res.classified, { method: 'sb260', elev: null }).includes('<td style="color:var(--tx2)">—</td>'));
  const ic = classificationTableRowsHtml(classifyCpt(cpt, { method: 'robertson' }).classified, { method: 'robertson', elev: null });
  assert.ok(!ic.includes('<td style="color:var(--tx3)">—</td>'));
});

console.log('\n[5] layers/tabel3-compat.js');
check('COMPAT / CAT_GROUPS / compatLevel / subtypeGroup', () => {
  assert.deepEqual(Object.keys(COMPAT), ['Peat / organic', 'Soft clay', 'Clay', 'Sandy clay', 'Silty sand', 'Sand', 'Gravel']);
  assert.deepEqual(Object.keys(CAT_GROUPS), ['veen', 'klei', 'leem', 'zand', 'grind']);
  assert.equal(compatLevel('Sand', 'zand'), 'ok');
  assert.equal(compatLevel('Sand', 'grind'), 'adj');
  assert.equal(compatLevel('Sand', 'veen'), 'bad');
  assert.equal(compatLevel('Nope', 'zand'), 'bad');
  assert.equal(subtypeGroup('zand, matig'), 'zand');
  assert.equal(subtypeGroup('klei, vast'), 'klei');
  assert.equal(subtypeGroup('nope'), '');
});
check('qcRfFit: qc [min, max), Rf < 1 % exclusive, 1–2 % inclusive, other bands inclusive, veen gate, close ±0.3 pp', () => {
  const cleanSand = CAT.find((r) => r.grp === 'zand' && r.rfMin === 0 && r.rfMax === 1);
  const lhSand = CAT.find((r) => r.grp === 'zand' && r.rfMin === 1 && r.rfMax === 2);
  const veen = CAT.find((r) => r.grp === 'veen');
  const klei = CAT.find((r) => r.grp === 'klei' && r.rfMin === 3 && r.rfMax === 6);
  assert.equal(qcRfFit(cleanSand, cleanSand.qcMin, 0.99), 'match');
  assert.equal(qcRfFit(cleanSand, cleanSand.qcMin, 1.0), 'close');
  assert.equal(qcRfFit(cleanSand, cleanSand.qcMax, 0.5), 'out');
  assert.equal(qcRfFit(lhSand, lhSand.qcMin, 2.0), 'match');
  assert.equal(qcRfFit(lhSand, lhSand.qcMin, 2.3), 'close');
  assert.equal(qcRfFit(lhSand, lhSand.qcMin, 2.31), 'out');
  assert.equal(qcRfFit(lhSand, lhSand.qcMin, null), 'match');
  assert.equal(qcRfFit(veen, veen.qcMin, 5.4), 'out');
  assert.equal(qcRfFit(klei, klei.qcMin, 6), 'match');
  assert.equal(qcRfFit(klei, klei.qcMin, 6.3), 'close');
});
check('suggestSubtype: ok-match beats adj-match beats ok-out; veen blocked below Rf 5 %; catalogue argument', () => {
  const sand = suggestSubtype({ type: 'Sand', subtype: '', avgQc: 12, avgRf: 0.7 });
  assert.equal(sand.grp, 'zand');
  assert.equal(qcRfFit(sand, 12, 0.7), 'match');
  const peat = suggestSubtype({ type: 'Peat / organic', subtype: '', avgQc: 0.3, avgRf: 2 });
  assert.equal(peat, null);   // only veen is ok/adj for peat and it is blocked
  const peat2 = suggestSubtype({ type: 'Peat / organic', subtype: '', avgQc: 0.3, avgRf: 8 });
  assert.equal(peat2.grp, 'veen');
  const kleiOnly = CAT.filter((r) => r.grp === 'klei');
  assert.equal(suggestSubtype({ type: 'Sand', subtype: '', avgQc: 12, avgRf: 0.7 }, kleiOnly), null);
  assert.equal(suggestSubtype({ type: 'Clay', subtype: '', avgQc: 1.5, avgRf: 4 }, kleiOnly).grp, 'klei');
});
check('layerTypeCompatScore: 1.0 same type, 0.9 ok group, 0.5 adjacent, 0.4 type table, 0 otherwise', () => {
  assert.equal(layerTypeCompatScore({ type: 'Sand', subtype: '' }, { type: 'Sand', subtype: 'klei, vast' }), 1.0);
  assert.equal(layerTypeCompatScore({ type: 'Sand', subtype: 'zand, matig' }, { type: 'Silty sand', subtype: '' }), 0.9);
  assert.equal(layerTypeCompatScore({ type: 'Clay', subtype: '' }, { type: 'Sand', subtype: 'leem, vast' }), 0.5);
  assert.equal(layerTypeCompatScore({ type: 'Sandy clay', subtype: '' }, { type: 'Silty sand', subtype: '' }), 0.4);
  assert.equal(layerTypeCompatScore({ type: 'Peat / organic', subtype: '' }, { type: 'Gravel', subtype: '' }), 0.0);
});

console.log('\n[6] layers/segments.js');
const seg = (type, rows, extra = {}) => ({ type, subtype: rows[0]?.subtype || '', rows, ...extra });
const cRows = (n, z0, qc, rf, subtype, params) => Array.from({ length: n }, (_, i) => ({ ...row(z0 + i * 0.02, qc, rf), type: 'Sand', subtype, ...(params || {}) }));
check('segmentTop: 0 for the first, _top override, midpoint to the previous, −0.02 m fallback', () => {
  assert.equal(segmentTop(null), 0);
  assert.equal(segmentTop({ isFirst: true, rows: [row(0.5, 1, 1)] }), 0);
  assert.equal(segmentTop({ _top: 1.23456, rows: [] }), 1.235);
  assert.equal(segmentTop({ rows: [row(2.0, 1, 1)] }, { rows: [row(1.9, 1, 1)] }), 1.95);
  assert.equal(segmentTop({ rows: [row(2.0, 1, 1)] }, null), 1.98);
});
check('segmentSummary: averages skip qc ≤ 0.02, DEF params without ctx, Tabel 3 row params with useSB260params', () => {
  const rows = cRows(5, 1.0, 10, 0.6, 'zand, matig', { g: 18, gs: 20, phi: 32.5, c: 0, cu: 0 });
  rows[0] = { ...rows[0], qc: 0.01 };
  const s = segmentSummary(seg('Sand', rows, { isFirst: true }), null);
  assert.equal(s.avgQc, 10);
  assert.equal(s.avgRf, 0.6);
  assert.deepEqual([s.g, s.gs, s.phi, s.c, s.cu], [DEF.Sand.g, DEF.Sand.gs, DEF.Sand.phi, DEF.Sand.c, DEF.Sand.cu]);
  assert.deepEqual([s.top, s.bot, s.thk, s.rows, s.subtype], [0, 1.08, 1.08, 5, 'zand, matig']);
  const t = segmentSummary(seg('Sand', rows, { isFirst: true }), null, { useSB260params: true });
  assert.deepEqual([t.g, t.gs, t.phi, t.c, t.cu], [18, 20, 32.5, 0, 0]);
  const u = segmentSummary(seg('Sand', cRows(3, 1, 5, null, ''), { isFirst: true }), null, { useSB260params: true });
  assert.equal(u.avgRf, null);
  assert.equal(u.g, DEF.Sand.g);   // no Tabel 3 params on the rows → DEF fallback
});
check('similarity terms are in [0, 1] and saturate as documented', () => {
  const a = { type: 'Sand', subtype: 'zand, matig', avgQc: 10, avgRf: 0.6, g: 18, gs: 20, phi: 32, c: 0, cu: 0, thk: 1 };
  const b = { ...a, avgQc: 30, avgRf: 1.2, subtype: 'zand, dicht' };
  assert.equal(qcSimilarity(a, a), 1);
  assert.equal(qcSimilarity(a, b), 0);
  assert.equal(rfSimilarity(a, { ...a, avgRf: null }), 0.5);
  assert.equal(rfSimilarity(a, b), 1 - 0.6 / 3);
  assert.equal(subtypeSimilarity(a, a), 1);
  assert.equal(subtypeSimilarity(a, b), 0.75);
  assert.equal(subtypeSimilarity(a, { ...b, subtype: 'grind, matig' }), 0.25);
  assert.equal(paramSimilarity(a, a), 1);
  assert.equal(compatSimilarity(a, { ...a, subtype: 'klei, vast' }), 0);
  assert.equal(continuityScore(a, null), 0.5);
  assert.equal(familyClass({ type: 'Sand', subtype: 'klei, vast' }), 'cohesive');
  assert.equal(familyClass({ type: 'Sandy clay', subtype: '' }), 'cohesive');
  assert.equal(familyClass({ type: 'Silty sand', subtype: '' }), 'granular');
  assert.equal(isCriticalMarkerLayer({ type: 'Gravel', avgQc: 5 }), true);
  assert.equal(isCriticalMarkerLayer({ type: 'Sand', avgQc: 5, avgRf: 1 }), false);
  assert.equal(isCriticalMarkerLayer({ type: 'Sand', avgQc: 5, avgRf: 1, subtype: '' }, { type: 'Clay', subtype: '' }, { type: 'Clay', subtype: '' }), true);
  assert.equal(SMART_SLIVER_REF, 0.25);
  assert.deepEqual(mergeCandidateScore(a, null, null), { ok: false, score: 0, why: 'no-neighbor' });
  const same = mergeCandidateScore(a, a, null);
  assert.ok(same.ok && same.score > 0.9 && same.score <= 1.1, String(same.score));
});

console.log('\n[7] layers/merge.js + detect.js');
const sampleCpt = () => {
  // 0-1 m sand, 1-1.2 m clay sliver, 1.2-3 m sand, 3-5 m clay — classified with Tabel 3 params
  const mk = (z0, n, type, subtype, qc, rf) => Array.from({ length: n }, (_, i) => ({ ...row(+(z0 + i * 0.02).toFixed(2), qc, rf), ...classifyTabel3(row(z0, qc, rf), { assumedRf: 3 }) }));
  const classified = [...mk(0.02, 50, 'Sand', '', 8, 0.6), ...mk(1.02, 10, 'Clay', '', 0.8, 4), ...mk(1.22, 90, 'Sand', '', 9, 0.7), ...mk(3.02, 100, 'Clay', '', 1.5, 4.5)];
  return cptOf({ classified, useSB260params: true, method: 'sb260' });
};
check('simpleUpwardMerge folds slivers thinner than ctx.minThk into the segment above', () => {
  const cpt = sampleCpt();
  const rawSegs = (() => { const out = []; let cur = null; for (const r of cpt.classified) { const k = classificationSegmentKey(r, 'sb260'); if (cur && cur.key === k) cur.rows.push(r); else { cur = { type: r.type, subtype: r.subtype || '', key: k, rows: [r] }; out.push(cur); } } return out; })();
  assert.equal(rawSegs.length, 4);
  const m1 = simpleUpwardMerge(rawSegs.map((s) => ({ ...s, rows: [...s.rows] })), layersCtx(cpt, { minThk: 0.5 }));
  assert.equal(m1.length, 3);
  const m0 = simpleUpwardMerge(rawSegs.map((s) => ({ ...s, rows: [...s.rows] })), layersCtx(cpt, { minThk: 0.1 }));
  assert.equal(m0.length, 4);
});
check('smartPostMerge = smartSimilarityReduce → enforceMinThicknessBySimilarity with the clamped sensitivity', () => {
  const cpt = sampleCpt();
  const segsOf = () => { const out = []; let cur = null; for (const r of cpt.classified) { const k = classificationSegmentKey(r, 'sb260'); if (cur && cur.key === k) cur.rows.push(r); else { cur = { type: r.type, subtype: r.subtype || '', key: k, rows: [r] }; out.push(cur); } } return out; };
  const ctx = layersCtx(cpt, { smartMergeSensitivity: 1.3 });
  const a = smartPostMerge(segsOf(), ctx);
  const b = enforceMinThicknessBySimilarity(smartSimilarityReduce(segsOf(), 1.3, ctx), 1.3, ctx);
  assert.deepEqual(canon(a), canon(b));
  const c = smartPostMerge(segsOf(), layersCtx(cpt, { smartMergeSensitivity: 99 }));
  const d = smartPostMerge(segsOf(), layersCtx(cpt, { smartMergeSensitivity: 6 }));
  assert.deepEqual(canon(c), canon(d));
});
check('classificationSegmentKey: type::subtype for sb260, type otherwise', () => {
  assert.equal(classificationSegmentKey({ type: 'Sand', subtype: 'zand, matig' }, 'sb260'), 'Sand::zand, matig');
  assert.equal(classificationSegmentKey({ type: 'Sand' }, 'sb260'), 'Sand::');
  assert.equal(classificationSegmentKey({ type: 'Sand', subtype: 'zand, matig' }, 'robertson'), 'Sand');
});
check('layersCtx copies the six settings + CAT and applies defined overrides only', () => {
  const cpt = cptOf({ method: 'cur3', paramMethod: 'def', useSB260params: false, smartMerge: false, minThk: 0.3, smartMergeSensitivity: 0.9 });
  assert.deepEqual(layersCtx(cpt), { catalogue: CAT, method: 'cur3', paramMethod: 'def', useSB260params: false, smartMerge: false, minThk: 0.3, smartMergeSensitivity: 0.9 });
  assert.equal(layersCtx(cpt, { minThk: 1, method: undefined }).minThk, 1);
  assert.equal(layersCtx(cpt, { minThk: 1, method: undefined }).method, 'cur3');
});
check('detectLayers returns fresh layers (id/top/bot/type/subtype/avg*/rfIndeterminate/params/ovr), writes nothing', () => {
  const cpt = sampleCpt();
  const layers = detectLayers(cpt);
  assert.ok(layers.length >= 2 && layers.length <= 4, String(layers.length));
  assert.deepEqual(cpt.layers, []);
  assert.deepEqual(Object.keys(layers[0]), ['id', 'top', 'bot', 'type', 'subtype', 'avgQc', 'avgFs', 'avgRf', 'rfIndeterminate', 'g', 'gs', 'phi', 'c', 'cu', 'ovr']);
  assert.equal(layers[0].top, 0);
  for (let i = 1; i < layers.length; i++) assert.equal(layers[i].top, layers[i - 1].bot);
  assert.notEqual(detectLayers(cpt)[0], layers[0]);
  assert.deepEqual(canon(detectLayers(cpt)), canon(layers));
});
check('ctx overrides: smartMerge false = simple chain; paramMethod def keeps the DEF/row params; minThk & catalogue', () => {
  const cpt = sampleCpt();
  const simple = detectLayers(cpt, { smartMerge: false });
  assert.deepEqual(canon(simple), canon(detectLayers({ ...cpt, smartMerge: false })));
  const def = detectLayers(cpt, { paramMethod: 'def' });
  const sb = detectLayers(cpt);
  assert.equal(def.length, sb.length);
  assert.equal(def[0].subtype, sb[0].subtype);          // the suggestion still names the subtype
  const sug = suggestSubtype({ type: sb[0].type, subtype: '', avgQc: sb[0].avgQc, avgRf: sb[0].avgRf });
  assert.deepEqual([sb[0].g, sb[0].gs, sb[0].phi, sb[0].c, sb[0].cu], [sug.g, sug.gs, sug.phi, sug.c, sug.cu]);
  const sum = segmentSummary({ type: sb[0].type, rows: cpt.classified.filter((r) => r.z <= sb[0].bot), isFirst: true }, null, layersCtx(cpt));
  assert.deepEqual([def[0].g, def[0].gs, def[0].phi, def[0].c, def[0].cu], [sum.g, sum.gs, Math.round(sum.phi), Math.round(sum.c), Math.round(sum.cu)]);
  assert.ok(detectLayers(cpt, { minThk: 0.05, smartMerge: false }).length >= simple.length);
  const kleiOnly = CAT.filter((r) => r.grp === 'klei');
  const restricted = detectLayers(cpt, { catalogue: kleiOnly });
  for (const l of restricted) {
    const sug = suggestSubtype({ type: l.type, subtype: '', avgQc: l.avgQc, avgRf: l.avgRf }, kleiOnly);
    if (sug) assert.equal(l.subtype, sug.subtype);                 // Clay layers: scored against klei rows only
    else assert.ok(subtypeGroup(l.subtype) === 'zand' || l.subtype === '', l.subtype); // Sand: no klei row is ok/adj → the classified subtype stays
  }
  assert.ok(restricted.some((l) => l.type === 'Clay' && subtypeGroup(l.subtype) === 'klei'));
});
check('qc-only rows: rfIndeterminate flags Tabel 3 ties, avgRf null', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ ...row(+(0.02 + i * 0.02).toFixed(2), 2.2, null), ...classifyTabel3(row(0.5, 2.2, null), { assumedRf: 3 }) }));
  const layers = detectLayers(cptOf({ classified: rows, useSB260params: true }));
  assert.equal(layers.length, 1);
  assert.equal(layers[0].avgRf, null);
  assert.equal(layers[0].rfIndeterminate, true);
});

// ---------------------------------------------- 2. the recorded goldens are the truth
console.log('\n[8] tests/golden/node/classification/* recomputed from the import goldens');
const manifest = readJson(join(GOLDEN, 'fixtures/manifest.json'));
const profileNames = Object.entries(manifest.fixtures).filter(([k, e]) => k.startsWith('cpt/') && e.role === 'profile').map(([k]) => k.slice(4).replace(/\.(gef|state\.json)$/, ''));
/** The CPT state a fixture has after import (import golden + manifest injection), before runClass. */
function fixtureCpt(fx) {
  const entry = manifest.fixtures[`cpt/${fx}.gef`] || manifest.fixtures[`cpt/${fx}.state.json`];
  const base = entry?.base ? entry.base.replace(/\.gef$/, '') : fx;
  const imp = readJson(join(GOLDEN, 'node/import', `${base}.gef.json`));
  return { data: imp.data, wt: imp.wt, elev: imp.elev, assumedRf: imp.assumedRf, meta: imp.meta, method: imp.method, ...CPT_DEFAULTS, classified: [], layers: [], useSB260params: false, ...(entry?.inject || {}) };
}
const classDir = join(GOLDEN, 'node/classification');
const layersDir = join(GOLDEN, 'node/layers');
const classifiedGolden = new Map();   // `${fx}.${method}` → classified rows (from the golden, for the layers part)
{
  let cases = 0;
  for (const fx of profileNames) {
    const cpt = fixtureCpt(fx);
    for (const method of METHODS) {
      const expected = readJson(join(classDir, `${fx}.${method}.json`));
      classifiedGolden.set(`${fx}.${method}`, expected.classified);
      check(`classification/${fx}.${method}.json (${expected.classified.length} rows)`, () => {
        const res = classifyCpt({ ...cpt, method });
        assert.deepStrictEqual(canon(res.classified), canon(expected.classified));
        assert.equal(res.rfAssumedCount, expected.rfAssumedCount);
        assert.equal(res.useSB260params, expected.useSB260params);
        const rowsHtml = classificationTableRowsHtml(res.classified, { method, elev: cpt.elev });
        assert.equal((rowsHtml.match(/<tr>/g) || []).length, expected.cbodyRows);
        const layers = detectLayers({ ...cpt, method, classified: res.classified, useSB260params: res.useSB260params });
        assert.equal(layers.length, expected.layerCount);
      });
      check(`classification/${fx}.${method}.metrics.txt`, () => {
        const res = classifyCpt({ ...cpt, method });
        const layers = detectLayers({ ...cpt, method, classified: res.classified, useSB260params: res.useSB260params });
        const parts = {
          cmet: classificationMetricsHtml(res.metrics),
          cmetricHead: res.metricLabel,
          classAssumedRfNote: classificationAssumedRfNoteHtml(res.assumedRfNote),
          minThkInfo: '-> ' + layers.length + ' layers'
        };
        const actual = Object.entries(parts).map(([id, html]) => `[#${id}]\n${htmlToText(html)}`).join('');
        assert.equal(actual.trimEnd(), readTxt(join(classDir, `${fx}.${method}.metrics.txt`)));
      });
      cases += 2;
    }
    if (fx === 'qc-only') {
      for (const rf of [2, 5]) {
        check(`classification/${fx}.sb260.assumedRf${rf}.json`, () => {
          const expected = readJson(join(classDir, `${fx}.sb260.assumedRf${rf}.json`));
          const c2 = { ...cpt, method: 'sb260', assumedRf: rf };
          const res = classifyCpt(c2);
          assert.deepStrictEqual(canon(res.classified), canon(expected.classified));
          assert.equal(res.rfAssumedCount, expected.rfAssumedCount);
          assert.deepStrictEqual(canon(detectLayers({ ...c2, classified: res.classified, useSB260params: res.useSB260params })), canon(expected.layers));
        });
        cases++;
      }
    }
  }
  check(`covered ${cases} classification golden cases over ${profileNames.length} profile fixtures × 5 methods`, () => {
    assert.ok(profileNames.includes('demo-anonymous') && profileNames.includes('qc-only') && profileNames.includes('wt-above-surface'));
    assert.equal(cases, profileNames.length * METHODS.length * 2 + 2);
  });
}

console.log('\n[9] tests/golden/node/layers/* recomputed from the classification goldens');
{
  let cases = 0;
  for (const fx of profileNames) {
    const cpt = fixtureCpt(fx);
    const base = (method) => ({ ...cpt, method, classified: classifiedGolden.get(`${fx}.${method}`), useSB260params: method === 'sb260', smartMerge: true, minThk: 0.5, smartMergeSensitivity: 1.1 });
    for (const method of METHODS) {
      check(`layers/${fx}.${method}.smart.json`, () => {
        assert.deepStrictEqual(canon(detectLayers(base(method))), canon(readJson(join(layersDir, `${fx}.${method}.smart.json`))));
      });
      check(`layers/${fx}.${method}.simple.json`, () => {
        assert.deepStrictEqual(canon(detectLayers({ ...base(method), smartMerge: false })), canon(readJson(join(layersDir, `${fx}.${method}.simple.json`))));
      });
      cases += 2;
    }
    for (const minThk of [0.3, 1]) {
      check(`layers/${fx}.minThk${minThk}.json`, () => {
        assert.deepStrictEqual(canon(detectLayers({ ...base('sb260'), minThk })), canon(readJson(join(layersDir, `${fx}.minThk${minThk}.json`))));
      });
      cases++;
    }
    for (const sens of [0.9, 1.3]) {
      check(`layers/${fx}.sens${sens}.json`, () => {
        assert.deepStrictEqual(canon(detectLayers({ ...base('sb260'), smartMergeSensitivity: sens })), canon(readJson(join(layersDir, `${fx}.sens${sens}.json`))));
      });
      cases++;
    }
  }
  const pureFiles = readdirSync(layersDir).filter((f) => /\.(smart|simple|minThk0\.3|minThk1|sens0\.9|sens1\.3)\.json$/.test(f));
  check(`covered ${cases} layers golden cases = every detectLayers() golden (${pureFiles.length} files; the edit-path / #lb / warnings goldens stay with the controller)`, () => {
    assert.equal(cases, pureFiles.length);
  });
}

// ------------------------------------------------- 3. wrapper ⇔ pure agreement
console.log('\n[10] controller wrappers ⇔ pure functions (demo + qc-only fixtures, Tier-B loader)');
if (PURE_ONLY) {
  console.log('SKIP  --pure-only');
} else {
  const { makeContext } = await import('./golden/lib/context.mjs');
  const gctx = await makeContext();
  try {
    const c = await gctx.controller();
    const { api } = c;
    const el = (id) => c.document.getElementById(id);
    const stage2 = (S) => {
      const res = classifyCpt(S);
      assert.deepStrictEqual(canon(S.classified), canon(res.classified));
      assert.equal(S.rfAssumedCount, res.rfAssumedCount);
      assert.equal(S.useSB260params, res.useSB260params);
      assert.equal(el('cmet').innerHTML, classificationMetricsHtml(res.metrics));
      assert.equal(el('cmetricHead').innerHTML, res.metricLabel);
      assert.equal(el('classAssumedRfNote').innerHTML, classificationAssumedRfNoteHtml(res.assumedRfNote));
      assert.equal(el('cbody').innerHTML, classificationTableRowsHtml(res.classified, { method: S.method, elev: S.elev }));
      assert.deepStrictEqual(canon(S.layers), canon(detectLayers(S)));
      assert.equal(el('minThkInfo').textContent, '-> ' + detectLayers(S).length + ' layers');
      return res;
    };
    for (const method of METHODS) {
      const S = await gctx.classify('demo-anonymous', method);
      check(`demo-anonymous.${method}: runClass() state + the four Stage 2 regions == classifyCpt(S) + panel builders; S.layers == detectLayers(S)`, () => {
        const res = stage2(S);
        assert.equal(res.assumedRfNote.kind, 'none');
      });
    }
    {
      const S = await gctx.classify('qc-only', 'sb260');
      check('qc-only.sb260: the "no measured sleeve friction" note and the assumed-Rf bookkeeping agree', () => {
        const res = stage2(S);
        assert.equal(res.assumedRfNote.kind, 'none-measured');
        assert.equal(res.rfAssumedCount, S.data.length);
      });
      S.assumedRf = 2; api.runClass();
      check('qc-only.sb260 with assumedRf 2: wrapper re-run == pure re-run', () => { stage2(S); });
    }
    {
      const S = await gctx.classify('trailing-qc-only', 'robertson2016');
      check('trailing-qc-only.robertson2016: the partial-coverage note agrees', () => {
        const res = stage2(S);
        assert.ok(['partial', 'gaps'].includes(res.assumedRfNote.kind), res.assumedRfNote.kind);
      });
    }
    const S = await gctx.classify('demo-anonymous', 'sb260');
    check('detectLayers wrapper == pure for smartMerge off, minThk 0.3 / 1.0, sensitivity 0.9 / 1.3, paramMethod def', () => {
      for (const patch of [{ smartMerge: false }, { smartMerge: true, minThk: 0.3 }, { minThk: 1.0 }, { minThk: 0.5, smartMergeSensitivity: 0.9 }, { smartMergeSensitivity: 1.3 }, { smartMergeSensitivity: 1.1, paramMethod: 'def' }]) {
        Object.assign(S, patch);
        api.detectLayers();
        assert.deepStrictEqual(canon(S.layers), canon(detectLayers(S)));
        assert.deepStrictEqual(canon(S.layers), canon(detectLayers(S, layersCtx(S))));
      }
      Object.assign(S, { smartMerge: true, minThk: 0.5, smartMergeSensitivity: 1.1, paramMethod: 'sb260' });
      api.detectLayers();
    });
    check('segmentSummary wrapper == pure(seg, prev, layersCtx(S)) — with and without useSB260params', () => {
      const rows = S.classified.slice(0, 30), rows2 = S.classified.slice(30, 55);
      const segA = { type: rows[0].type, subtype: rows[0].subtype || '', rows, isFirst: true };
      const segB = { type: rows2[0].type, subtype: rows2[0].subtype || '', rows: rows2 };
      assert.deepStrictEqual(api.segmentSummary(segA, null), segmentSummary(segA, null, layersCtx(S)));
      assert.deepStrictEqual(api.segmentSummary(segB, segA), segmentSummary(segB, segA, layersCtx(S)));
      S.useSB260params = false;
      assert.deepStrictEqual(api.segmentSummary(segB, segA), segmentSummary(segB, segA, layersCtx(S)));
      S.useSB260params = true;
    });
    check('classRob / classCUR / classSB260 / stressAt wrappers == pure(S, r) on the row grid', () => {
      for (const r of S.data.filter((_, i) => i % 11 === 0)) {
        assert.deepStrictEqual(api.classRob(r), classRob(S, r));
        assert.deepStrictEqual(api.classCUR(r), classCUR3(S, r));
        assert.deepStrictEqual(api.classSB260(r), classSB260(S, r));
        assert.deepStrictEqual(api.stressAt(r.z, 18, 17), stressAt(S, r.z, 18, 17));
      }
    });
    check('the S-free Stage 3 helpers on legacyApi return what the package returns', () => {
      for (const l of S.layers) {
        assert.deepStrictEqual(api.suggestSubtype(l), suggestSubtype(l));
        for (const e of CAT.filter((_, i) => i % 5 === 0)) {
          assert.equal(api.compatLevel(l.type, e.grp), compatLevel(l.type, e.grp));
          assert.equal(api.qcRfFit(e, l.avgQc, l.avgRf), qcRfFit(e, l.avgQc, l.avgRf));
        }
        assert.equal(api.familyClass(l), familyClass(l));
        assert.equal(api.subtypeGroup(l.subtype), subtypeGroup(l.subtype));
      }
      for (let i = 1; i < S.layers.length; i++) {
        const a = S.layers[i - 1], b = S.layers[i];
        assert.equal(api.layerTypeCompatScore(a, b), layerTypeCompatScore(a, b));
        assert.equal(api.qcSimilarity(a, b), qcSimilarity(a, b));
        assert.equal(api.rfSimilarity(a, b), rfSimilarity(a, b));
        assert.equal(api.subtypeSimilarity(a, b), subtypeSimilarity(a, b));
        assert.equal(api.paramSimilarity(a, b), paramSimilarity(a, b));
        assert.equal(api.compatSimilarity(a, b), compatSimilarity(a, b));
        assert.equal(api.continuityScore(a, b), continuityScore(a, b));
        assert.equal(api.isCriticalMarkerLayer(a, null, b), isCriticalMarkerLayer(a, null, b));
        assert.deepStrictEqual(api.mergeCandidateScore(a, b, null), mergeCandidateScore(a, b, null));
      }
    });
    check('a second CPT state classifies and detects independently (no S involved)', () => {
      const other = { ...S, wt: 0.3, assumedRf: 2, method: 'robertson', smartMerge: false, minThk: 1.0, paramMethod: 'def' };
      const res = classifyCpt(other);
      assert.equal(res.useSB260params, false);
      assert.notDeepStrictEqual(canon(res.classified), canon(S.classified));
      const layers = detectLayers({ ...other, classified: res.classified, useSB260params: res.useSB260params });
      assert.ok(layers.length >= 1);
      assert.deepStrictEqual(canon(S.layers), canon(detectLayers(S)));   // the active CPT is untouched
    });
    check('legacyApi still publishes the Stage 2 / Stage 3 names', () => {
      for (const n of ['selM', 'stressAt', 'classRob', 'classCUR', 'classSB260', 'runClass', 'segmentSummary', 'subtypeGroup', 'familyClass', 'qcSimilarity', 'rfSimilarity',
        'subtypeSimilarity', 'paramSimilarity', 'compatSimilarity', 'continuityScore', 'isCriticalMarkerLayer', 'mergeCandidateScore', 'detectLayers', 'compatLevel', 'qcRfFit',
        'suggestSubtype', 'buildSubtypeDropdown', 'renderLayers', 'changeSubtype', 'renderCompatWarnings', 'editL', 'layerTypeCompatScore']) {
        assert.equal(typeof api[n], 'function', n);
      }
    });
  } finally {
    await gctx.close();
  }
}

// ------------------------------------------------------ 4. extraction complete
console.log('\n[11] extraction complete');
check('legacy-controller.js no longer declares the moved bodies and imports classification/ + layers/', () => {
  const src = readFileSync(join(ROOT, 'src/lib/cpt-app/legacy-controller.js'), 'utf8');
  for (const name of ['classificationMethodLabel', 'classificationMetricLabel', 'classificationMetricValue', 'layerTypeCompatScore', 'segmentTop', 'subtypeGroup', 'familyClass',
    'qcSimilarity', 'rfSimilarity', 'subtypeSimilarity', 'paramSimilarity', 'compatSimilarity', 'continuityScore', 'isCriticalMarkerLayer', 'mergeCandidateScore',
    'simpleUpwardMerge', 'mergeSegmentInDirection', 'chooseSimilarityMergeDirection', 'smartSimilarityReduce', 'enforceMinThicknessBySimilarity', 'smartPostMerge',
    'classificationSegmentKey', 'compatLevel', 'qcRfFit', 'suggestSubtype']) {
    assert.ok(!new RegExp(`^function ${name}\\(`, 'm').test(src), `${name} is still declared in legacy-controller.js`);
  }
  for (const decl of ['const CAT_GROUPS={', 'const COMPAT={', 'const SMART_SLIVER_REF', "S.method==='robertson')     res=classRob(r)", 'const thick=segmentSummary(seg, prev).thk', 'S.layers=merged.map(']) {
    assert.ok(!src.includes(decl), `still contains: ${decl}`);
  }
  assert.ok(src.includes("} from './classification/index.js';"), 'classification import missing');
  assert.ok(src.includes("} from './layers/index.js';"), 'layers import missing');
  const mp = src.indexOf("} from './model-params/index.js';"), cl = src.indexOf("import {\n  classificationMethodLabel,"), core = src.indexOf("} from './core/chart-host.js';");
  assert.ok(core < mp && mp < cl && cl - mp < 40, 'the classification/layers imports must directly follow the model-params import block');
  for (const w of [
    'function assumedRfValue(){\n  return assumedRfValuePure(S);',
    'function cptHasFs(){\n  return cptHasFsPure(S);',
    'function cptHasRf(){\n  return cptHasRfPure(S);',
    'function classRob(r){\n  return classRobPure(S, r);',
    'function classSB260(r){\n  return classSB260Pure(S, r);',
    'const classCUR = classCUR3;',
    'const result=classifyCpt(S);\n  S.useSB260params=result.useSB260params;\n  S.classified=result.classified;\n  S.rfAssumedCount=result.rfAssumedCount;',
    "document.getElementById('cmet').innerHTML=classificationMetricsHtml(result.metrics);",
    "document.getElementById('cbody').innerHTML=classificationTableRowsHtml(result.classified,{method:S.method,elev:S.elev});",
    'function segmentSummary(seg, prevSeg){\n  return segmentSummaryPure(seg, prevSeg, layersCtx(S));',
    'function detectLayers(){\n  S.layers=detectLayersPure(S, layersCtx(S));\n}'
  ]) {
    assert.ok(src.includes(w), `wrapper missing: ${w.split('\n')[0]}`);
  }
  // the render tail of runClass is unchanged
  assert.ok(src.includes("  document.getElementById('classLayout').style.display='';\n  detectLayers();\n  renderLayerPreviewSvg('layerPreviewSvg');\n  drawLayerColumnSvg('layerColSvg',S.layers,S.data[S.data.length-1].z+0.5);\n  document.getElementById('minThkInfo').textContent='-> '+S.layers.length+' layers';\n  document.getElementById('btnToLayers').style.display='';\n}"), 'runClass render tail changed');
  // renderLayers is still called by the callers, never by detectLayers
  const detectBody = src.slice(src.indexOf('function detectLayers(){'), src.indexOf('function detectLayers(){') + 80);
  assert.ok(!detectBody.includes('renderLayers'), 'detectLayers wrapper must not render');
});
check('classification/ and layers/ modules carry the SPDX header and @ts-nocheck; no DOM, no S in the pure modules', () => {
  const expect = {
    classification: ['classify.js', 'index.js', 'labels.js', 'panel.js', 'run.js'],
    layers: ['context.js', 'detect.js', 'index.js', 'merge.js', 'segments.js', 'tabel3-compat.js']
  };
  for (const [pkg, files] of Object.entries(expect)) {
    const dir = join(ROOT, 'src/lib/cpt-app', pkg);
    assert.ok(existsSync(join(dir, 'index.js')), `${pkg}/index.js`);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.js')).sort(), files, pkg);
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      const head = text.split('\n').slice(0, 2);
      assert.equal(head[0], '// SPDX-License-Identifier: AGPL-3.0-or-later', `${pkg}/${f}`);
      assert.equal(head[1], '// @ts-nocheck', `${pkg}/${f}`);
      assert.ok(!/\bdocument\b|\bwindow\b|\balert\(/.test(text), `${pkg}/${f} touches the DOM`);
      assert.ok(!/(^|[^A-Za-z0-9_.$])S\.[a-zA-Z]/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${pkg}/${f} reads S`);
    }
  }
});

console.log(`\n${count - fails}/${count} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
