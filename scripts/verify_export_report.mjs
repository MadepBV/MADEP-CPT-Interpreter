#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifier for src/lib/cpt-app/export/* and src/lib/cpt-app/report/* — the text exports
// (layer CSV, PLAXIS material commands, simulated CPT) and the Stage 7 report payload
// moved out of legacy-controller.js in refactor step 4 (PR 8,
// worklog/refactor/11-pr8-export-report.md).
//
// Parts:
//   1    unit checks of the export/ helpers and builders under plain Node (no Vite, no DOM);
//   2    unit checks of the report/ helpers and of the Stage 6 / Seep-Slope annex builders on
//        a synthetic state with stub deps — including the capture conditional (the automatic
//        workspace capture is asked for only when an annex exists and no manual capture is
//        stored) and the missing-dep errors;
//   3    the exports goldens are the truth: every tests/golden/node/exports/<fx>.* rebuilt with
//        the pure builders from the upstream goldens (node/import/<fx>.json rows + the
//        exports/<fx>.project.json snapshot — layers, methods, meta) and compared with the
//        golden FILE TEXT (normalizeText / stableJson(normalize()) exactly as the runner writes);
//   4    the report goldens are the truth: for every Stage 6 fixture the recorded Stage 2–6 chain
//        is replayed through the golden Tier-B loader (the controller under Node) to obtain the
//        CPT state; the payload is then built by the PURE buildStage7Payload(project, cpt, deps)
//        with pure deps only (model-params defaults, no ensure, no capture, no controller helper)
//        and must equal node/report/<fx>.json / .valid.json bit for bit (digests as the suite
//        stores them); the state is proven untouched; .open.json and no-layers.json likewise;
//   5    wrapper ⇔ pure through the same loader: exportCSV / exportPlaxisCommands / exportPlaxisCpt
//        downloads, file names and alerts == the pure builders for every profile fixture (demo
//        included); buildStage7Payload() == the pure builder; the no-layers guards; the published names;
//   6    extraction complete (the moved bodies are gone, the wrappers and the import blocks are
//        present (PR 20: in the export/ and report/ installs), the modules carry SPDX + @ts-nocheck and touch
//        neither the DOM nor S).
// Parts 4 and 5 need the Vite dev dependency (as golden:check does); skip them with --pure-only.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'tests/golden');
const PURE_ONLY = process.argv.includes('--pure-only');

const exp = await import('../src/lib/cpt-app/export/index.js');
const rep = await import('../src/lib/cpt-app/report/index.js');
const { cptModelCtx, hsParams, khParams, workingLayers } = await import('../src/lib/cpt-app/model-params/index.js');
const { compatLevel } = await import('../src/lib/cpt-app/layers/index.js');
const { CAT } = await import('../src/lib/cpt-app/eurocode-tabel3.js');
const { isStage7Payload } = await import('../src/lib/cpt-app/report-storage.js');
const { normalize, normalizeText, digest } = await import('./golden/lib/normalize.mjs');
const { stableJson } = await import('./golden/lib/store.mjs');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(GOLDEN, 'fixtures/manifest.json'), 'utf8'));

let fails = 0;
let count = 0;
function check(name, fn) {
  count++;
  try { fn(); console.log(`OK    ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
}
async function checkAsync(name, fn) {
  count++;
  try { await fn(); console.log(`OK    ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n').slice(0, 14).join('\n      ')}`); }
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const goldenText = (rel) => readFileSync(join(GOLDEN, rel), 'utf8');
/** The text the golden runner writes for a JSON case (normalize → stableJson). */
const goldenJsonText = (v) => stableJson(normalize(v));
/** First differing line of two texts, for readable failures. */
function assertSameText(actual, expected, label) {
  if (actual === expected) return;
  const a = actual.split('\n'), b = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) throw new Error(`${label}: line ${i + 1} differs\n  expected: ${JSON.stringify((b[i] ?? '<eof>').slice(0, 160))}\n  actual:   ${JSON.stringify((a[i] ?? '<eof>').slice(0, 160))}`);
  }
  throw new Error(`${label}: texts differ (${a.length} vs ${b.length} lines)`);
}

const profileNames = Object.entries(manifest.fixtures).filter(([k, e]) => k.startsWith('cpt/') && e.role === 'profile').map(([k]) => k.slice(4).replace(/\.(gef|state\.json)$/, ''));
const stage6Names = profileNames.filter((n) => !['trailing-qc-only', 'wt-above-surface'].includes(n));

// ------------------------------------------------------------------ 1. export/ unit
console.log('\n[1] export/ helpers and builders (pure, no Vite)');
check('safeMaterialToken: NFKD strip, brackets/commas removed, whitespace → _, fallback Layer', () => {
  assert.equal(exp.safeMaterialToken('zand (lh), los'), 'zand_lh_los');
  assert.equal(exp.safeMaterialToken('  Klei matig vast '), 'Klei_matig_vast');
  assert.equal(exp.safeMaterialToken('leem/zand é'), 'leemzand_e');
  assert.equal(exp.safeMaterialToken(''), 'Layer');
  assert.equal(exp.safeMaterialToken(null), 'Layer');
  assert.equal(exp.safeMaterialToken('S1-2.b'), 'S1-2.b');
});
check('plaxisDrainageType: Sand/Gravel drained unless (lh)/(kh)/leemhoudend; everything else Undrained A', () => {
  assert.equal(exp.plaxisDrainageType({ type: 'Sand', subtype: 'zand, dicht' }), 'Drained');
  assert.equal(exp.plaxisDrainageType({ type: 'Gravel', subtype: 'grind, matig' }), 'Drained');
  assert.equal(exp.plaxisDrainageType({ type: 'Sand', subtype: 'zand (lh), los' }), 'Undrained A');
  assert.equal(exp.plaxisDrainageType({ type: 'Sand', subtype: 'Zand (KH)' }), 'Undrained A');
  assert.equal(exp.plaxisDrainageType({ type: 'Sand', subtype: 'leemhoudend zand' }), 'Undrained A');
  assert.equal(exp.plaxisDrainageType({ type: 'Clay', subtype: 'klei, vast' }), 'Undrained A');
  assert.equal(exp.plaxisDrainageType({ type: 'Sand' }), 'Drained');
});
check('plaxisDisplayName / plaxisCommandValue / buildPlaxisSoilmatCommand / msToMday', () => {
  assert.equal(exp.plaxisDisplayName(' a "b"\r\nc '), "a 'b' c");
  assert.equal(exp.plaxisCommandValue(-0), '0');
  assert.equal(exp.plaxisCommandValue(NaN), '0');
  assert.equal(exp.plaxisCommandValue(Infinity), '0');
  assert.equal(exp.plaxisCommandValue(12.5), '12.5');
  assert.equal(exp.plaxisCommandValue('x"y'), "\"x'y\"");
  assert.equal(exp.buildPlaxisSoilmatCommand([['Identification', 'M'], ['SoilModel', 2]]), 'soilmat "Identification" "M" "SoilModel" 2');
  assert.equal(exp.msToMday(3e-6), 0.2592);
  assert.equal(exp.msToMday(1.5e-4), 12.96);
  assert.equal(exp.msToMday(NaN), 0);
  assert.equal(exp.msToMday(1e-12), 0);   // 8.64e-8 → toFixed(6) → 0
});
check('findLayerForDepth: half-open [top, bot) except the last layer which includes bot', () => {
  const layers = [{ top: 0, bot: 1 }, { top: 1, bot: 2.5 }];
  assert.equal(exp.findLayerForDepth(layers, 0), layers[0]);
  assert.equal(exp.findLayerForDepth(layers, 1), layers[1]);
  assert.equal(exp.findLayerForDepth(layers, 2.5), layers[1]);
  assert.equal(exp.findLayerForDepth(layers, 2.6), null);
  assert.equal(exp.findLayerForDepth(layers, -0.1), null);
  assert.equal(exp.findLayerForDepth([], 0), null);
});
check('layerFsIsSynthetic / formatPlaxisCoord', () => {
  assert.equal(exp.layerFsIsSynthetic({ avgFs: null, avgRf: null }), true);
  assert.equal(exp.layerFsIsSynthetic({ avgFs: NaN, avgRf: undefined }), true);
  assert.equal(exp.layerFsIsSynthetic({ avgFs: 0.04, avgRf: null }), false);
  assert.equal(exp.layerFsIsSynthetic({ avgFs: null, avgRf: 1.2 }), false);
  assert.equal(exp.formatPlaxisCoord(null), '0');
  assert.equal(exp.formatPlaxisCoord(NaN), '0');
  assert.equal(exp.formatPlaxisCoord(-1e-12), '0');
  assert.equal(exp.formatPlaxisCoord(-0.00001), '0');   // -0.0000 → '-0' → '0'
  assert.equal(exp.formatPlaxisCoord(123456.78), '123456.78');
  assert.equal(exp.formatPlaxisCoord(10), '10');
  assert.equal(exp.formatPlaxisCoord(2.5), '2.5');
  assert.equal(exp.formatPlaxisCoord(-3.14159), '-3.1416');
});
/** A two-layer CPT state (Stage 3 shape) for the builder checks. */
const miniCpt = () => ({
  id: 'mini', x: 12.5, y: -3, elev: 10, wt: 1.5, alphaMethod: 'B', stiffMethod: 'A', khKvMethod: 'A', assumedRf: 3, method: 'sb260',
  meta: { testid: 'S1 (a)' },
  data: [{ z: 0.5, qc: 2, fs: 0.04, rf: 2 }, { z: 1.5, qc: 8, fs: null, rf: null }, { z: 2.5, qc: 0.5, fs: 0.02, rf: 4 }, { z: 9, qc: 1, fs: null, rf: null }],
  layers: [
    { id: 0, top: 0, bot: 1, type: 'Sand', subtype: 'zand (lh), los', avgQc: 2.228, avgFs: 0.042, avgRf: 1.9, g: 16, gs: 18, phi: 25, c: 0, cu: 0, ovr: {}, rfIndeterminate: false },
    { id: 1, top: 1, bot: 3, type: 'Clay', subtype: 'klei, weinig vast', avgQc: 0.916, avgFs: null, avgRf: null, g: 16, gs: 16, phi: 20, c: 2, cu: 20, ovr: {}, rfIndeterminate: true }
  ]
});
check('buildLayersCsv: header + one row per layer, LF-joined, TAW from elev, hs/kh columns from the ctx', () => {
  const cpt = miniCpt();
  const csv = exp.buildLayersCsv(cpt);
  const lines = csv.split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], exp.LAYERS_CSV_HEADER);
  const ctx = cptModelCtx(cpt);
  const h = hsParams(cpt.layers[0], ctx), k = khParams(cpt.layers[0], ctx);
  assert.ok(lines[1].startsWith('1,Sand,"zand (lh), los",0.000,1.000,10.00,9.00,1.000,2.228,1.9,16,18,25,0,0,'));
  assert.ok(lines[1].includes(`,${h.aE.toFixed(2)},B,${h.Eoed_i},`), 'alphaE + alphaMethod columns');
  assert.ok(lines[1].endsWith(`,${k.kh_rep.toExponential(2)},${k.kv_rep.toExponential(2)},${k.khkv},${k.psi_unsat},"${k.infClass}"`), 'kh columns');
  assert.ok(lines[2].startsWith('2,Clay,"klei, weinig vast",1.000,3.000,9.00,7.00,2.000,0.916,,'), 'avgRf null → empty cell');
  assert.ok(!csv.endsWith('\n'));
  // no elev → empty TAW cells; a ctx override drives both the derivation and the printed method
  assert.ok(exp.buildLayersCsv({ ...cpt, elev: null }).split('\n')[1].startsWith('1,Sand,"zand (lh), los",0.000,1.000,,,1.000'));
  const csvA = exp.buildLayersCsv(cpt, { ...ctx, alphaMethod: 'A' });
  assert.ok(csvA.split('\n')[1].includes(`,${hsParams(cpt.layers[0], { ...ctx, alphaMethod: 'A' }).aE.toFixed(2)},A,`));
  assert.equal(exp.layersCsvFilename(cpt), 'CPT_S1 (a)_layers.csv');
  assert.equal(exp.layersCsvFilename({ meta: {} }), 'CPT_export_layers.csv');
});
check('buildPlaxisCommandsText: two soilmat lines per layer, CRLF, names tokenised, cohesion floor 0.1, k in m/day', () => {
  const cpt = miniCpt();
  const txt = exp.buildPlaxisCommandsText(cpt);
  const lines = txt.split('\r\n');
  assert.equal(lines.length, 4);
  assert.ok(!txt.includes('\n\n'));
  const ctx = cptModelCtx(cpt);
  const h0 = hsParams(cpt.layers[0], ctx), k0 = khParams(cpt.layers[0], ctx);
  assert.equal(lines[0], exp.buildPlaxisSoilmatCommand([['Identification', 'S1_a_L1_zand_lh_los_MC'], ['SoilModel', 2], ['DrainageType', 'Undrained A'], ['gammaUnsat', 16], ['gammaSat', 18],
    ['ERef', h0.Emc], ['nu', h0.nu], ['cRef', 0.1], ['phi', 25], ['psi', h0.psi], ['PermHorizontalPrimary', exp.msToMday(k0.kh_rep)], ['PermVertical', exp.msToMday(k0.kv_rep)]]));
  assert.ok(lines[1].startsWith('soilmat "Identification" "S1_a_L1_zand_lh_los_HS" "SoilModel" 3 "DrainageType" "Undrained A"'));
  assert.ok(lines[1].includes(`"E50Ref" ${h0.E50_ref} "EOedRef" ${h0.Eoed_ref} "EURRef" ${h0.Eur_ref} "PowerM" ${h0.m} "pRef" 100 "cRef" 0.1`));
  assert.ok(lines[2].startsWith('soilmat "Identification" "S1_a_L2_klei_weinig_vast_MC" "SoilModel" 2 "DrainageType" "Undrained A" "gammaUnsat" 16 "gammaSat" 16'));
  assert.ok(lines[2].includes('"cRef" 2 "phi" 20'));
  assert.equal(exp.plaxisCptId(cpt), 'S1 (a)');
  assert.equal(exp.plaxisCptId({ meta: {}, id: 'x1' }), 'x1');
  assert.equal(exp.plaxisCptId({ meta: {} }), 'CPT');
  assert.equal(exp.plaxisCommandsFilename(cpt), 'CPT_S1_a_plaxis_materials_commands.txt');
});
check('plaxisNuDrainageConflicts / plaxisNuDrainageAlertMessage: undrained layers with nu >= 0.35 only', () => {
  const cpt = miniCpt();
  const ctx = cptModelCtx(cpt);
  const conflicts = exp.plaxisNuDrainageConflicts(cpt);
  const expected = cpt.layers.map((l, i) => ({ i: i + 1, dr: exp.plaxisDrainageType(l), nu: hsParams(l, ctx).nu, subtype: l.subtype })).filter((x) => x.dr !== 'Drained' && x.nu >= 0.35);
  assert.deepEqual(conflicts, expected);
  assert.ok(conflicts.length >= 1, 'the soft clay layer conflicts');
  const msg = exp.plaxisNuDrainageAlertMessage(conflicts);
  assert.ok(msg.startsWith('PLAXIS note: nu′ >= 0.35 combined with Undrained A will be flagged by PLAXIS (Material Models Manual 3.3.2).\n\n'));
  assert.ok(msg.includes(`Layer ${conflicts[0].i} (${conflicts[0].subtype}): nu = ${conflicts[0].nu}`));
  assert.ok(msg.endsWith('\n\nThe export is unchanged; review nu or the drainage type in PLAXIS.'));
  // drained sand at nu 0.3 never conflicts; a subtype-less layer reports its type
  assert.deepEqual(exp.plaxisNuDrainageConflicts({ ...cpt, layers: [{ ...cpt.layers[0], subtype: 'zand, dicht' }] }), []);
  assert.equal(exp.plaxisNuDrainageConflicts({ ...cpt, layers: [{ ...cpt.layers[1], subtype: '' }] })[0]?.subtype, 'Clay');
});
check('simulatedCptRows / buildPlaxisCptText: rows inside layers, fs synthesised from the ctx assumed Rf, CRLF, note counts synthetic layers', () => {
  const cpt = miniCpt();
  const rows = exp.simulatedCptRows(cpt);
  assert.equal(rows.length, 3, 'z = 9 lies below the last layer');
  assert.deepEqual(rows.map((r) => r.z), [0.5, 1.5, 2.5]);
  assert.deepEqual(rows.map((r) => r.qc), [2.228, 0.916, 0.916]);
  assert.equal(rows[0].fs, exp.simulatedLayerFs(cpt.layers[0], 3));
  assert.equal(rows[1].fs, exp.simulatedLayerFs(cpt.layers[1], 3));
  // the assumed Rf reaches classification-core (used for types without a representative Rf); measured layers keep their fs
  assert.equal(exp.simulatedLayerFs({ type: 'Mystery', avgQc: 1 }, 5), 0.05);
  assert.equal(exp.simulatedLayerFs({ type: 'Mystery', avgQc: 1 }, 3), 0.03);
  const mystery = { ...cpt, layers: [{ ...cpt.layers[1], type: 'Mystery' }] };
  assert.notEqual(exp.simulatedCptRows(mystery, { ...cptModelCtx(cpt), assumedRf: 5 })[0].fs, exp.simulatedCptRows(mystery)[0].fs, 'the ctx assumed Rf drives the synthetic fs');
  assert.equal(exp.simulatedCptRows(cpt, { ...cptModelCtx(cpt), assumedRf: 5 })[0].fs, rows[0].fs, 'measured layers keep their fs');
  const txt = exp.buildPlaxisCptText(cpt);
  const lines = txt.split('\r\n');
  assert.deepEqual(lines.slice(0, 4), ['X[m] 12.5', 'Y[m] -3', 'Z[m] 10', 'D[m] Q[MPa] F[MPa] x  # depth, qc, fs, Rf(skipped) — fs of 1 layer(s) simulated from soil-type Rf (no measured fs in source CPT)']);
  assert.equal(lines[4], `0.5000 2.228000 ${rows[0].fs.toFixed(6)} 0`);
  assert.equal(lines.length, 7);
  const measured = { ...cpt, layers: cpt.layers.map((l) => ({ ...l, avgFs: 0.03 })) };
  assert.ok(exp.buildPlaxisCptText(measured).split('\r\n')[3].endsWith('Rf(skipped)'), 'no note without synthetic layers');
  assert.equal(exp.buildPlaxisCptText({ ...cpt, data: [{ z: 20, qc: 1 }] }), null, 'no row inside a layer → null (controller alerts)');
  assert.equal(exp.buildPlaxisCptText({ ...cpt, x: null, y: undefined, elev: null }).split('\r\n').slice(0, 3).join('|'), 'X[m] 0|Y[m] 0|Z[m] 0');
  assert.equal(exp.plaxisCptFilename(cpt), 'CPT_S1 (a)_plaxis_simulated.txt');
  assert.equal(exp.plaxisCptFilename({ meta: {}, id: 'mini' }), 'CPT_mini_plaxis_simulated.txt');
  assert.equal(exp.plaxisCptFilename({ meta: {} }), 'CPT_export_plaxis_simulated.txt');
});
check('guard messages are the controller wording', () => {
  assert.equal(exp.NO_LAYERS_MESSAGE, 'No layers to export. Run classification first.');
  assert.equal(exp.NO_LAYER_MODEL_MESSAGE, 'No layer model to export. Run classification and layer identification first.');
  assert.equal(exp.NO_SIMULATED_ROWS_MESSAGE, 'No simulated CPT rows could be generated from the active layer model.');
});

// ------------------------------------------------------------------ 2. report/ unit
console.log('\n[2] report/ helpers, Stage 6 / Seep-Slope annexes on a synthetic state (stub deps)');
check('safeClone: JSON clone, null/undefined pass through, functions and undefined dropped', () => {
  assert.equal(rep.safeClone(null), null);
  assert.equal(rep.safeClone(undefined), undefined);
  const src = { a: 1, f: () => 1, u: undefined, n: [1, { b: NaN }] };
  const c = rep.safeClone(src);
  assert.deepEqual(c, { a: 1, n: [1, { b: null }] });
  assert.notEqual(c.n, src.n);
});
check('label helpers', () => {
  assert.equal(rep.stage7MethodLabel('sb260'), 'NEN Tabel 3 / EC7');
  assert.equal(rep.stage7ParamMethodLabel('def'), 'Generic (DEF)');
  assert.equal(rep.stage7ParamMethodLabel('sb260'), 'NEN Tabel 3 / EC7');
  assert.equal(rep.stage7AlphaMethodLabel('A'), 'A - Sanglerat (fixed)');
  assert.equal(rep.stage7AlphaMethodLabel('B'), 'B - SB260 qc-dependent');
  assert.equal(rep.stage7StiffMethodLabel('A'), 'A - CUR 2003-7 ratios');
  assert.equal(rep.stage7StiffMethodLabel('B'), 'B - E50 = Eoed');
  assert.equal(rep.stage7WtSourceLabel({ wtFromFile: true, wtSource: 'GEF' }), 'GEF');
  assert.equal(rep.stage7WtSourceLabel({ wtFromFile: true, wtSource: null }), 'File');
  assert.equal(rep.stage7WtSourceLabel({ wtFromFile: false, wtSource: 'x' }), 'Manual / default');
  assert.equal(rep.stage7ElevSourceLabel({ elevFromFile: true, elevSource: 'ZID' }), 'ZID');
  assert.equal(rep.stage7ElevSourceLabel({ elevFromFile: true }), 'File');
  assert.equal(rep.stage7ElevSourceLabel({ elevFromFile: false, elev: 3 }), 'Manual');
  assert.equal(rep.stage7ElevSourceLabel({ elevFromFile: false, elev: null }), 'Not set');
});
check('stage7LayerWarnings: compat level per Tabel 3 row, rfIndeterminate note, overridden / unknown subtypes skipped, catalogue argument', () => {
  const zand = CAT.find((r) => r.subtype === 'zand, dicht');
  const klei = CAT.find((r) => r.subtype === 'klei, weinig vast');
  const layers = [
    { type: 'Peat', subtype: 'zand, dicht', ovr: {} },                       // bad
    { type: 'Clay', subtype: 'klei, weinig vast', ovr: {} },                 // ok → no warning
    { type: 'Clay', subtype: 'klei, weinig vast', ovr: {}, rfIndeterminate: true },   // adj note (qc-only)
    { type: 'Clay', subtype: 'klei, weinig vast', ovr: { subtype: true }, rfIndeterminate: true },   // user picked it → no note
    { type: 'Sand', subtype: '(overridden)', ovr: {} },
    { type: 'Sand', subtype: '', ovr: {} },
    { type: 'Sand', subtype: 'not in the catalogue', ovr: {} }
  ];
  assert.equal(compatLevel('Peat', zand.grp), 'bad');
  assert.equal(compatLevel('Clay', klei.grp), 'ok');
  const w = rep.stage7LayerWarnings({ layers });
  assert.deepEqual(w, [
    { layer: 1, level: 'bad', type: 'Peat', subtype: 'zand, dicht', message: 'Peat is not directly compatible with zand, dicht.' },
    { layer: 3, level: 'adj', type: 'Clay', subtype: 'klei, weinig vast', message: 'klei, weinig vast was selected without measured Rf (no fs in the source CPT); several Tabel 3 rows share this qc band, so the catalogue-order row was applied. Review against borings or project knowledge.' }
  ]);
  const adjType = Object.keys({ Sand: 1, Clay: 1, Silt: 1, Peat: 1, Gravel: 1 }).find((t) => compatLevel(t, klei.grp) === 'adj');
  if (adjType) assert.deepEqual(rep.stage7LayerWarnings({ layers: [{ type: adjType, subtype: 'klei, weinig vast', ovr: {} }] })[0].message, `klei, weinig vast sits in an adjacent transition family for ${adjType}.`);
  assert.deepEqual(rep.stage7LayerWarnings({ layers: [layers[0]] }, []), [], 'an empty catalogue yields no compat warnings');
  assert.deepEqual(rep.stage7LayerWarnings({ layers: [] }), []);
});
check('stage7TuningPayload: null without tuning, one entry per tuning item with the fit mapped', () => {
  assert.equal(rep.stage7TuningPayload({ layers: [] }), null);
  const fit = { m_fit: 0.6, Eoed_ref_fit: 1000, R2: 0.9, n: 12, stressRangeFactor: 2, quality: 'good', qMsg: 'ok', mDefault: 0.5, Eoed_ref_default: 900, meanX: 1, meanY: 2, alphaDefault: 3, depthPts: [1], EoedI_pts: [2], hsDefault_pts: [3], hsFit_pts: [4], Xs: [5], Ys: [6] };
  const cpt = { layers: [{ top: 0, bot: 1, type: 'Sand', subtype: 'zand, dicht', ovr: { m: 0.6 } }, { top: 1, bot: 2, type: 'Clay', ovr: {} }], tuning: [{ i: 0, fit, previewM: '0.55' }, { i: 1, fit: null, previewM: 'x' }] };
  const t = rep.stage7TuningPayload(cpt);
  assert.deepEqual(t[0], { index: 0, layerIndex: 1, layerLabel: 'Layer 1', top: 0, bot: 1, type: 'Sand', subtype: 'zand, dicht', accepted: true, previewM: 0.55,
    fit: { mFit: 0.6, eOedRefFit: 1000, r2: 0.9, n: 12, stressRangeFactor: 2, quality: 'good', message: 'ok', mDefault: 0.5, eOedRefDefault: 900, meanX: 1, meanY: 2, alphaDefault: 3, depthPts: [1], eOedIPts: [2], hsDefaultPts: [3], hsFitPts: [4], xs: [5], ys: [6] } });
  assert.deepEqual(t[1], { index: 1, layerIndex: 2, layerLabel: 'Layer 2', top: 1, bot: 2, type: 'Clay', subtype: '', accepted: false, previewM: null, fit: null });
});
check('stage7WorkingLayerPayload: deps.hsParams / khParams drive the hs & hydraulic blocks; tuning flags', () => {
  const cpt = miniCpt();
  cpt.layers[0].ovr = { m: 0.7 };
  cpt.tuning = [{ i: 0, fit: { m_fit: 0.7 } }];
  const hs = { aE: 1, Eoed_i: 2, Eoed_ref: 3, E50_ref: 4, Eur_ref: 5, m: 6, K0nc: 7, nu: 8, nu_ur: 9, beta: 10, Edef: 11, rShear: 12, psi: 13, Emc: 14, sigV: 15, u: 16, sigVeff: 17 };
  const kh = { kh_rep: 1e-5, kv_rep: 2e-6, khkv: 5, psi_unsat: 0.1, infClass: 'X' };
  const calls = [];
  const p = rep.stage7WorkingLayerPayload(cpt, cpt.layers[0], 0, { hsParams: (l) => { calls.push(['hs', l]); return hs; }, khParams: (l) => { calls.push(['kh', l]); return kh; } });
  assert.deepEqual(calls, [['hs', cpt.layers[0]], ['kh', cpt.layers[0]]]);
  assert.deepEqual(p.hs, { alphaE: 1, eOedI: 2, eOedRef: 3, e50Ref: 4, eurRef: 5, m: 6, k0nc: 7, nu: 8, nuUr: 9, beta: 10, eDef: 11, rShear: 12, psi: 13, eMc: 14, sigmaV: 15, porePressure: 16, sigmaVEff: 17 });
  assert.deepEqual(p.hydraulic, { kh: 1e-5, kv: 2e-6, khkv: 5, psiUnsat: 0.1, infiltrationClass: 'X' });
  assert.equal(p.index, 1); assert.equal(p.topTaw, 10); assert.equal(p.botTaw, 9); assert.equal(p.thickness, 1); assert.equal(p.avgFsKPa, 42);
  assert.equal(p.hasAcceptedTuning, true); assert.equal(p.manualMOverride, false);
  assert.deepEqual(p.overrides, { m: 0.7 }); assert.notEqual(p.overrides, cpt.layers[0].ovr);
  const q = rep.stage7WorkingLayerPayload({ ...cpt, tuning: null, elev: null }, cpt.layers[0], 0, { hsParams: () => hs, khParams: () => kh });
  assert.equal(q.hasAcceptedTuning, false); assert.equal(q.manualMOverride, true); assert.equal(q.topTaw, null); assert.equal(q.botTaw, null);
  const r = rep.stage7WorkingLayerPayload(cpt, cpt.layers[1], 1, { hsParams: () => hs, khParams: () => kh });
  assert.equal(r.avgFsKPa, null); assert.equal(r.hasAcceptedTuning, false); assert.equal(r.manualMOverride, false);
  // the default deps are the pure model-params functions with cptModelCtx(cpt)
  const d = rep.stage7WorkingLayerPayload(cpt, cpt.layers[1], 1);
  assert.deepEqual(d.hs.eOedRef, hsParams(cpt.layers[1], cptModelCtx(cpt)).Eoed_ref);
  assert.deepEqual(d.hydraulic.kh, khParams(cpt.layers[1], cptModelCtx(cpt)).kh_rep);
});
check('stage7Deps: defaults (model-params, no-op ensure, null capture, appVersion), overrides pass through, idempotent, seepslope throwers', () => {
  const cpt = miniCpt();
  const d = rep.stage7Deps(cpt);
  assert.deepEqual(d.hsParams(cpt.layers[0]), hsParams(cpt.layers[0], cptModelCtx(cpt)));
  assert.deepEqual(d.khParams(cpt.layers[0]), khParams(cpt.layers[0], cptModelCtx(cpt)));
  assert.deepEqual(d.workingLayers(), workingLayers(cpt));
  assert.equal(d.ensureStage6State(), undefined);
  assert.equal(d.captureBishopWorkspaceView('stability'), null);
  assert.equal(d.appVersion, typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.5.x');
  assert.throws(() => d.seepslope.resultMethodLabel({}), /deps\.seepslope\.resultMethodLabel is required/);
  assert.throws(() => d.seepslope.resolvedSeepageMeshTargetArea({}), /resolvedSeepageMeshTargetArea/);
  const f = () => 'x';
  const o = rep.stage7Deps(cpt, { hsParams: f, appVersion: '9.9.9', seepslope: { drainGatingLabel: f } });
  assert.equal(o.hsParams, f); assert.equal(o.appVersion, '9.9.9'); assert.equal(o.seepslope.drainGatingLabel, f);
  const oo = rep.stage7Deps(cpt, o);
  assert.equal(oo.hsParams, f); assert.equal(oo.seepslope.drainGatingLabel, f); assert.equal(oo.appVersion, '9.9.9');
  assert.deepEqual(Object.keys(rep.seepslopeDeps()).sort(), ['drainGatingLabel', 'resolvedSeepageMeshTargetArea', 'seepageBcTypeLabel', 'seepageEdgeLabel', 'resultMethodLabel'].sort());
});
/** Stub Seep/Slope helpers (the controller's stay there until step 9). */
const slStub = () => ({
  resultMethodLabel: (r) => `L:${r.method || '?'}`,
  seepageEdgeLabel: (e) => `E:${e.source}:${e.index}`,
  seepageBcTypeLabel: (t) => `T:${t}`,
  drainGatingLabel: (g) => `G:${g}`,
  resolvedSeepageMeshTargetArea: () => 0.5
});
const bishopResults = () => [{ FS: 1.2, method: 'bishop', circle: { x: 1, y: 2, r: 3 }, entry: { x: 0 }, exit: { x: 5 }, wallForces: [1] }, { FS: 1.3, method: 'spencer', spencerAttempted: true }, { FS: 1.4, method: 'bishop' }];
check('stage7BishopPayload: null without results; selectedIndex clamped; keepBest slice; labels via deps; config/summary cloned', () => {
  assert.equal(rep.stage7BishopPayload({ stage6: { bishop: { results: { allResults: [] } } } }, { seepslope: slStub() }), null);
  assert.equal(rep.stage7BishopPayload({ stage6: {} }, { seepslope: slStub() }), null);
  const bishop = { strengthSet: 'char', methodMode: 'bishop_spencer', analysisDepth: 8, walls: [{ id: 'w' }], search: { keepBest: 2 }, solver: { a: 1 }, selectedResult: 7,
    results: { allResults: bishopResults(), summary: { min: 1.2 }, wallSummary: null, methodMode: 'bishop_spencer', spencerRechecked: 2, spencerConverged: 1, rejectionCounts: { deep: 3 }, timing: { totalMs: 5 } } };
  const cpt = { stage6: { bishop } };
  const p = rep.stage7BishopPayload(cpt, { seepslope: slStub() });
  assert.equal(p.selectedIndex, 2, 'selectedResult 7 clamps to the last result');
  assert.equal(p.selected.FS, 1.4); assert.equal(p.selected.methodLabel, 'L:bishop');
  assert.equal(p.topResults.length, 2, 'keepBest');
  assert.deepEqual(p.topResults.map((r) => [r.rank, r.FS, r.methodLabel]), [[1, 1.2, 'L:bishop'], [2, 1.3, 'L:spencer']]);
  assert.deepEqual(p.topResults[0].circle, { x: 1, y: 2, r: 3 }); assert.notEqual(p.topResults[0].circle, bishop.results.allResults[0].circle);
  assert.equal('entry' in p.topResults[0], false, 'topResults omit entry/exit/wallForces');
  assert.deepEqual(p.selected.entry, undefined, 'the selected (bishop-only) result has no entry key after JSON clone when absent');
  assert.deepEqual(p.config, { strengthSet: 'char', methodMode: 'bishop_spencer', analysisDepth: 8, walls: [{ id: 'w' }], search: { keepBest: 2 }, solver: { a: 1 } });
  assert.deepEqual(p.summary, { min: 1.2 }); assert.equal(p.wallSummary, null); assert.equal(p.methodMode, 'bishop_spencer');
  assert.equal(p.spencerRechecked, 2); assert.equal(p.spencerConverged, 1); assert.deepEqual(p.rejectionCounts, { deep: 3 }); assert.deepEqual(p.timing, { totalMs: 5 });
  const q = rep.stage7BishopPayload({ stage6: { bishop: { results: { allResults: bishopResults() }, selectedResult: -3 } } }, { seepslope: slStub() });
  assert.equal(q.selectedIndex, 0); assert.equal(q.topResults.length, 3, 'keepBest defaults to 10'); assert.equal(q.methodMode, 'bishop_only');
  assert.throws(() => rep.stage7BishopPayload(cpt, {}), /deps\.seepslope\.resultMethodLabel is required/);
});
const seepageState = () => ({
  stage6: { bishop: {
    useCustomRegions: false, useFemPorePressure: true, terrain: [{ x: 0, y: 0 }, { x: 10, y: 0 }], phreatic: [{ x: 0, y: -1 }],
    walls: [{ id: 'w1', x: 1, yTop: 5, yTip: 0, passiveSide: 'left', material: { id: 'impermeable' } }],
    drains: [{ id: 'd1', label: 'Drain A', vertices: [{ x: 0, y: 0 }, { x: 3, y: 4 }], head: { kind: 'constant', value: 1 }, gating: 'always' }, { vertices: [] }],
    materials: [{ id: 'm1', label: 'M', kx: 1e-5, ky: '2e-6', kSource: 'manual' }, { id: '' }],
    seepage: {
      status: 'done', rejectReason: '',
      options: { freeSurface: 'iterate', usePhreaticAsSeed: false, flowErrorTolerance: 0.001, maxRuntimeMs: 5000, meshTargetAreaAuto: false, drains: { gatingTolerances: { a: 1 }, reportPerSegmentInflow: false } },
      bcs: [{ id: 'bc-a', edgeKey: 'terrain:0', type: 'head', head: '2', status: 'active' }, { id: 'bc-b', edgeKey: 'base:0', type: 'no-flow', status: 'orphaned', anchor: { source: 'base', mid: { x: 5, y: -8 } } }, { edgeKey: '', type: 'seepage-face', anchor: { source: 'side-left' } }],
      mesh: { nodes: [1, 2, 3], elements: [1], cells: [], boundaryFaces: [1, 2], drainEdgesByDrain: new Map([['d1', [1, 2]]]), generatedMs: '12' },
      result: { headMin: 0, headMax: 2, throughFlow: 0.3, flowError: 0.01, equipotentialSegments: [1, 2, 3], phreaticSegments: [1],
        drains: [{ drainId: 'd1', totalInflow: 0.1, nodes: [{ isActive: true }, { isActive: false }], perSegmentInflow: [0.1] }],
        solver: { activeSetSummary: { drains: { activeNodes: 1, totalNodes: 2 } } }, timing: { solveMs: 3 } }
    }
  } },
  stage6Cache: { bishopModel: { regionMode: 'auto', regions: [1, 2], autoRegions: [1, 2], customRegions: [] }, bishopSeepageBoundary: [{ edgeKey: 'terrain:0', source: 'terrain', index: 0, length: 10, mid: { x: 5, y: 0 } }] }
});
check('stage7SeepagePayload: null without bishop/seepage/setup; counts, geometry, walls, drains, materials, BCs, mesh, result', () => {
  assert.equal(rep.stage7SeepagePayload({ stage6: {} }, { seepslope: slStub() }), null);
  assert.equal(rep.stage7SeepagePayload({ stage6: { bishop: { seepage: { bcs: [], mesh: null, result: null, rejectReason: '' } } } }, { seepslope: slStub() }), null, 'no setup → null');
  assert.ok(rep.stage7SeepagePayload({ stage6: { bishop: { seepage: { bcs: [], rejectReason: 'x' } } } }, { seepslope: slStub() }), 'a reject reason counts as setup');
  const p = rep.stage7SeepagePayload(seepageState(), { seepslope: slStub() });
  assert.deepEqual(p.config, { freeSurface: 'iterate', usePhreaticAsSeed: false, flowErrorTolerance: 0.001, maxRuntimeMs: 5000, meshTargetArea: 0.5, meshTargetAreaAuto: false, drains: { gatingTolerances: { a: 1 }, reportPerSegmentInflow: false }, useFemPorePressure: true });
  assert.deepEqual(p.summary, { status: 'done', solved: true, rejectReason: '', explicitBcCount: 3, activeBcCount: 2, orphanedBcCount: 1, prescribedHeadCount: 1, seepageFaceCount: 1, noFlowCount: 0, drainCount: 2, activeDrainNodeCount: 1, totalDrainNodeCount: 2 });
  assert.deepEqual(p.geometry, { regionMode: 'auto', regionCount: 2, autoRegionCount: 2, customRegionCount: 0, terrainVertexCount: 2, phreaticVertexCount: 1, drainCount: 2, wallCount: 1, boundaryEdgeCount: 1 });
  assert.equal(p.walls.length, 1);
  assert.deepEqual(p.walls[0].head, { x: 1, y: 5 }); assert.deepEqual(p.walls[0].tip, { x: 1, y: 0 }); assert.equal(p.walls[0].passiveSide, 'left'); assert.equal(p.walls[0].label, 'Wall 1');
  assert.equal(typeof p.walls[0].material.kSourceLabel, 'string'); assert.equal(p.walls[0].material.id, 'impermeable');
  assert.deepEqual(p.drains[0], { id: 'd1', label: 'Drain A', vertices: [{ x: 0, y: 0 }, { x: 3, y: 4 }], vertexCount: 2, closed: false, length: 5, head: { kind: 'constant', value: 1 }, gating: 'always', gatingLabel: 'G:always', result: { totalInflow: 0.1, activeNodes: 1, totalNodes: 2, perSegmentInflow: [0.1] } });
  assert.deepEqual(p.drains[1], { id: 'drain-2', label: 'Drain 2', vertices: [], vertexCount: 0, closed: false, length: 0, head: { kind: 'constant', value: 0 }, gating: 'when-saturated', gatingLabel: 'G:undefined', result: null });
  assert.deepEqual(p.materials[0], { id: 'm1', label: 'M', kx: 1e-5, ky: 2e-6, kSource: 'manual', kSourceLabel: p.materials[0].kSourceLabel });
  assert.deepEqual(p.materials[1], { id: '', label: 'Material', kx: null, ky: null, kSource: 'sbtn-default', kSourceLabel: p.materials[1].kSourceLabel });
  assert.deepEqual(p.boundaryConditions[0], { id: 'bc-a', edgeKey: 'terrain:0', edgeLabel: 'E:terrain:0', source: 'terrain', index: 0, type: 'head', typeLabel: 'T:head', head: 2, status: 'active', length: 10, midpoint: { x: 5, y: 0 } });
  assert.deepEqual(p.boundaryConditions[1], { id: 'bc-b', edgeKey: 'base:0', edgeLabel: 'E:base:0', source: 'base', index: null, type: 'no-flow', typeLabel: 'T:no-flow', head: null, status: 'orphaned', length: null, midpoint: { x: 5, y: -8 } });
  assert.deepEqual(p.boundaryConditions[2], { id: 'bc-3', edgeKey: '', edgeLabel: 'side-left edge', source: 'side-left', index: null, type: 'seepage-face', typeLabel: 'T:seepage-face', head: null, status: 'active', length: null, midpoint: null });
  assert.deepEqual(p.mesh, { nodes: 3, elements: 1, cells: 0, boundaryFaces: 2, drainEdges: 2, generatedMs: 12 });
  assert.deepEqual(p.result, { headMin: 0, headMax: 2, throughFlow: 0.3, flowError: 0.01, equipotentialLevelCount: 3, phreaticSegmentCount: 1, drains: [{ drainId: 'd1', totalInflow: 0.1, nodes: [{ isActive: true }, { isActive: false }], perSegmentInflow: [0.1] }], solver: { activeSetSummary: { drains: { activeNodes: 1, totalNodes: 2 } } }, timing: { solveMs: 3 } });
  // a missing helper inside the assembly is caught (degraded payload, see below); one the catch branch needs as well propagates
  const err = console.error; let logged = 0; console.error = () => { logged++; };
  try {
    assert.throws(() => rep.stage7SeepagePayload(seepageState(), { seepslope: { ...slStub(), resolvedSeepageMeshTargetArea: undefined } }), /resolvedSeepageMeshTargetArea is required/);
    const degraded = rep.stage7SeepagePayload(seepageState(), { seepslope: { ...slStub(), seepageEdgeLabel: undefined } });
    assert.equal(degraded.summary.solved, false); assert.deepEqual(degraded.boundaryConditions, []);
  } finally { console.error = err; }
  assert.equal(logged, 2);
});
check('stage7SeepagePayload: a failure inside the assembly falls back to the degraded payload (console.error)', () => {
  const s = seepageState();
  s.stage6.bishop.seepage.mesh.drainEdgesByDrain = { values() { throw new Error('boom'); } };
  const err = console.error; const logged = []; console.error = (...a) => logged.push(a);
  let p; try { p = rep.stage7SeepagePayload(s, { seepslope: slStub() }); } finally { console.error = err; }
  assert.equal(logged.length, 1); assert.equal(logged[0][0], 'Stage 7 seepage payload build failed:');
  assert.deepEqual(p.config, { freeSurface: 'iterate', usePhreaticAsSeed: false, flowErrorTolerance: 0.001, maxRuntimeMs: 5000, meshTargetArea: 0.5, meshTargetAreaAuto: false, useFemPorePressure: true });
  assert.deepEqual(p.summary, { status: 'done', solved: false, rejectReason: 'Seepage report payload could not be fully assembled.', explicitBcCount: 3, activeBcCount: 0, orphanedBcCount: 0, prescribedHeadCount: 0, seepageFaceCount: 0, noFlowCount: 0 });
  assert.deepEqual(p.geometry, { regionMode: 'auto', regionCount: 0, autoRegionCount: 0, customRegionCount: 0, terrainVertexCount: 2, phreaticVertexCount: 1, wallCount: 1, boundaryEdgeCount: 0 });
  assert.deepEqual([p.materials, p.boundaryConditions, p.mesh, p.result], [[], [], null, null]);
});
const deformationState = (manual) => ({ stage6: { bishop: { capturedView: { deformation: manual }, deformation: { options: { analysisType: 'safety', constitutiveModel: 'mc', meshElementType: 't6' }, warnings: ['w'],
  result: { solver: { convergenceState: 'converged', iterations: '7', safetyFactorOfSafetyLower: 1.1, safetyFactorOfSafetyUpper: 1.3, safetyStatus: 'ok', safetyResult: { finalization: { status: 'closed', factorOfSafetyIsOpenEnded: false } } }, loadFactor: '2', mesh: { nodes: [1, 2], triangles: [1] }, summary: { maxSettlementMm: 3 }, timing: { totalMs: 4 } } } } } });
check('stage7DeformationPayload: null without result / without a view; manual view wins (no capture); auto capture through deps; ensure called', () => {
  const calls = [];
  const deps = { ensureStage6State: () => calls.push('ensure'), captureBishopWorkspaceView: (w) => { calls.push(`capture:${w}`); return { workspace: w, image: { dataUrl: 'x' } }; } };
  assert.equal(rep.stage7DeformationPayload({ stage6: {} }, deps), null);
  assert.equal(rep.stage7DeformationPayload({ stage6: { bishop: { deformation: { result: null } } } }, deps), null);
  assert.deepEqual(calls, ['ensure', 'ensure']);
  calls.length = 0;
  const manual = rep.stage7DeformationPayload(deformationState({ workspace: 'deformation', image: { dataUrl: 'm' } }), deps);
  assert.deepEqual(calls, ['ensure'], 'no capture when a manual view exists');
  assert.deepEqual(manual.view, { workspace: 'deformation', image: { dataUrl: 'm' }, source: 'manual' });
  assert.deepEqual(manual.config, { analysisType: 'safety', constitutiveModel: 'mc', meshElementType: 't6' });
  assert.deepEqual(manual.warnings, ['w']);
  assert.deepEqual(manual.summary, { analysisType: 'safety', constitutiveModel: 'mc', elementType: 't6', converged: true, convergenceState: 'converged', loadFactor: 2, loadFactorMeaning: null, safetyStatus: 'ok', safetyFinalizationStatus: 'closed', safetyFactorOfSafetyIsOpenEnded: false, safetyFactorOfSafetyLower: 1.1, safetyFactorOfSafetyUpper: 1.3, safetyLoadFactor: 1.1, initialPhaseConvergenceState: null, servicePhaseConvergenceState: null, iterations: 7, timing: { totalMs: 4 }, nodeCount: 2, elementCount: 1, maxSettlementMm: 3, maxDisplacementMm: null });
  calls.length = 0;
  const auto = rep.stage7DeformationPayload(deformationState(null), deps);
  assert.deepEqual(calls, ['ensure', 'capture:deformation']);
  assert.deepEqual(auto.view, { workspace: 'deformation', image: { dataUrl: 'x' }, source: 'auto' });
  assert.equal(rep.stage7DeformationPayload(deformationState(null), { captureBishopWorkspaceView: () => null }), null, 'no capture → no annex');
  assert.equal(rep.stage7DeformationPayload(deformationState(null)), null, 'default deps: no canvas → no annex');
});
check('stage7Stage6Payload: annexes by cache content, order, cloned layers; capture only when an annex exists and no manual view', () => {
  const calls = [];
  const capture = (w) => { calls.push(w); return { workspace: w }; };
  const layers = [{ id: 0 }];
  assert.equal(rep.stage7Stage6Payload({ stage6: { app: 'bishop' }, stage6Cache: {} }, layers, { captureBishopWorkspaceView: capture, seepslope: slStub() }), null);
  assert.deepEqual(calls, [], 'nothing to capture without results');
  const base = {
    stage6: { app: 'pile', bearing: { B: 1 }, settlement: { s: 1 }, dewatering: { d: 1 }, beam: { b: 1 }, pile: { p: 1 }, bishop: { results: { allResults: bishopResults() }, capturedView: { stability: null, seepage: null } } },
    stage6Cache: { bearing: { selected: { q: 1 } }, settlement: { sublayers: [1] }, dewatering: { sublayers: [], drawdownCurve: [1], waterTableAtDistance: () => 1 }, beam: { sls: { xSamples: [1] } }, pile: { capacity: { r: 1 } } }
  };
  const p = rep.stage7Stage6Payload(base, layers, { captureBishopWorkspaceView: capture, seepslope: slStub() });
  assert.deepEqual(calls, ['stability']);
  assert.deepEqual(p.available, ['bearing', 'settlement', 'dewatering', 'beam', 'pile', 'bishop']);
  assert.equal(p.currentApp, 'pile');
  assert.deepEqual(p.layers, layers); assert.notEqual(p.layers, layers);
  assert.deepEqual(p.bearing, { config: { B: 1 }, analysis: { selected: { q: 1 } } });
  assert.deepEqual(p.dewatering, { config: { d: 1 }, analysis: { sublayers: [], drawdownCurve: [1] } }, 'functions dropped by the clone');
  assert.deepEqual(p.bishop.view, { workspace: 'stability', source: 'auto' });
  calls.length = 0;
  base.stage6.bishop.capturedView.stability = { workspace: 'stability', image: 'm' };
  const m = rep.stage7Stage6Payload(base, layers, { captureBishopWorkspaceView: capture, seepslope: slStub() });
  assert.deepEqual(calls, [], 'manual stability view → no capture');
  assert.deepEqual(m.bishop.view, { workspace: 'stability', image: 'm', source: 'manual' });
  // seepage annex: auto capture asked for 'seepage'; a null capture leaves the annex without a view
  const s = seepageState(); s.stage6.bishop.capturedView = {};
  const sp = rep.stage7Stage6Payload(s, layers, { captureBishopWorkspaceView: capture, seepslope: slStub() });
  assert.deepEqual(calls, ['seepage']); assert.deepEqual(sp.available, ['seepage']); assert.deepEqual(sp.seepage.view, { workspace: 'seepage', source: 'auto' });
  const sn = rep.stage7Stage6Payload(s, layers, { captureBishopWorkspaceView: () => null, seepslope: slStub() });
  assert.equal('view' in sn.seepage, false);
  // the empty-cache thresholds
  const t = rep.stage7Stage6Payload({ stage6: {}, stage6Cache: { bearing: {}, settlement: { sublayers: [] }, dewatering: { sublayers: [], drawdownCurve: [] }, beam: { sls: { xSamples: [] } }, pile: {} } }, layers, { seepslope: slStub() });
  assert.equal(t, null);
});
check('buildStage7Payload: guard → null; deps order (ensure before workingLayers); project / cpt / metadata / replication / summary / rows; the state is not mutated', () => {
  const cpt = miniCpt();
  cpt.classified = [{ z: 0.5, qc: 2, fs: 0.04, rf: 2, type: 'Sand', subtype: 'zand, dicht', Ic: 1.9, Qt: 20 }, { z: 1.5, qc: 8, fs: null, rf: null, type: 'Sand', subtype: '' }];
  cpt.wtFromFile = true; cpt.wtSource = 'GEF'; cpt.elevFromFile = false; cpt.paramMethod = 'sb260'; cpt.smartMerge = true; cpt.smartMergeSensitivity = 1.23456; cpt.minThk = 0.5;
  cpt.meta = { testid: 'S1', fname: 'a.gef', nRows: 4, depthMin: 0.5, depthMax: 9, hasFs: true, hasRf: true };
  cpt.stage6 = { app: 'bearing', bearing: { B: 2 } }; cpt.stage6Cache = { bearing: { selected: { q: 5 } } };
  assert.equal(rep.buildStage7Payload({ name: 'P', phase: 'analysis' }, { ...cpt, layers: [] }), null);
  assert.equal(rep.buildStage7Payload({ name: 'P', phase: 'analysis' }, { ...cpt, data: [] }), null);
  const before = JSON.stringify(cpt);
  const calls = [];
  const deps = { ensureStage6State: () => calls.push('ensure'), workingLayers: () => { calls.push('working'); return [{ id: 'wl' }]; }, appVersion: '1.2.3', captureBishopWorkspaceView: () => { calls.push('capture'); return null; }, seepslope: slStub() };
  const p = rep.buildStage7Payload({ name: 'P', phase: 'analysis', extra: 1 }, cpt, deps);
  assert.equal(JSON.stringify(cpt), before, 'input state untouched');
  assert.deepEqual(calls, ['ensure', 'working', 'ensure'], 'ensure before workingLayers, and again in the deformation annex — as the monolith did');
  assert.equal(p.version, 4); assert.equal(p.stage, 'stage7'); assert.equal(p.appVersion, '1.2.3');
  assert.match(p.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(p.project, { name: 'P', phase: 'analysis' });
  assert.deepEqual(p.cpt, { id: 'mini', displayId: 'S1', coordinates: { x: 12.5, y: -3 } });
  assert.deepEqual(p.metadata, { testid: 'S1', fname: 'a.gef', nRows: 4, depthMin: 0.5, depthMax: 9, hasFs: true, hasRf: true, sourceFile: 'a.gef', assumedRf: 3, rfAssumedCount: 2 });
  assert.deepEqual(p.replication, { method: 'sb260', methodLabel: 'NEN Tabel 3 / EC7', smartMerge: true, smartMergeSensitivity: 1.235, minThickness: 0.5, parameterMethod: 'sb260', parameterMethodLabel: 'NEN Tabel 3 / EC7', alphaMethod: 'B', alphaMethodLabel: 'B - SB260 qc-dependent', stiffnessMethod: 'A', stiffnessMethodLabel: 'A - CUR 2003-7 ratios', waterTable: 1.5, waterTableTaw: 8.5, waterTableSource: 'GEF', surfaceElevation: 10, surfaceElevationSource: 'Manual' });
  assert.deepEqual(p.summary, { layerCount: 2, depthMin: 0.5, depthMax: 9, acceptedTuningCount: 0, manualOverrideCount: 0, stage6Annexes: ['bearing'] });
  assert.deepEqual(p.chartInputs, { raw: { maxDepth: 9.5, maxQc: 8 * 1.15, maxFs: 40 * 1.15 } });
  assert.deepEqual(p.rawRows[1], { depth: 1.5, taw: 8.5, qc: 8, fsMPa: null, fsKPa: null, rf: null, u2: null });
  assert.deepEqual(p.rawRows[0], { depth: 0.5, taw: 9.5, qc: 2, fsMPa: 0.04, fsKPa: 40, rf: 2, u2: null });
  assert.deepEqual(p.classifiedRows, [{ depth: 0.5, taw: 9.5, qc: 2, fsKPa: 40, rf: 2, type: 'Sand', subtype: 'zand, dicht', ic: 1.9, qtOrQcNen: 20 }, { depth: 1.5, taw: 8.5, qc: 8, fsKPa: null, rf: null, type: 'Sand', subtype: '', ic: null, qtOrQcNen: null }]);
  assert.equal(p.layers.length, 2); assert.equal(p.layers[1].hs.eOedRef, hsParams(cpt.layers[1], cptModelCtx(cpt)).Eoed_ref);
  assert.deepEqual(p.layerWarnings, rep.stage7LayerWarnings(cpt)); assert.equal(p.tuning, null);
  assert.deepEqual(p.stage6, { currentApp: 'bearing', available: ['bearing'], layers: [{ id: 'wl' }], bearing: { config: { B: 2 }, analysis: { selected: { q: 5 } } } });
  assert.equal(p.visuals.layerColumn.width, 72); assert.equal(p.visuals.layerColumn.height, 420); assert.equal(p.visuals.layerColumn.markup, rep.buildLayerColumnSvgMarkup({ layers: cpt.layers, maxDepth: 9.5, wt: 1.5, width: 72, height: 420, emptyLabel: 'No layers' }));
  assert.equal(p.visuals.layerProfile.width, 210); assert.equal(p.visuals.layerProfile.height, 520); assert.ok(/<rect|<text/.test(p.visuals.layerProfile.markup));
  assert.equal(p.visuals.layerProfile.markup, rep.buildLayerPreviewSvgMarkup({ layers: cpt.layers, rows: cpt.classified, wt: 1.5, width: 210, height: 520, showRf: false, showFs: true }));
  // no classified rows → the raw rows feed the profile; no fs in the source → no fs track
  const q = rep.buildStage7Payload({ name: 'P', phase: 'x' }, { ...cpt, classified: null, meta: { hasFs: false, hasRf: false }, data: cpt.data.map((r) => ({ z: r.z, qc: r.qc })), stage6Cache: {} }, { seepslope: slStub() });
  assert.equal(q.visuals.layerProfile.markup, rep.buildLayerPreviewSvgMarkup({ layers: cpt.layers, rows: q.rawRows.length ? cpt.data.map((r) => ({ z: r.z, qc: r.qc })) : [], wt: 1.5, width: 210, height: 520, showRf: false, showFs: false }));
  assert.deepEqual(q.classifiedRows, []); assert.equal(q.metadata.hasFs, false); assert.equal(q.metadata.nRows, 4); assert.equal(q.stage6, null); assert.deepEqual(q.summary.stage6Annexes, []);
  assert.equal(isStage7Payload(p), true);
  assert.equal(rep.STAGE7_GUARD_MESSAGE, 'Run the CPT through layers and model parameters before opening the Stage 7 report.');
});

// ------------------------------------------------------------------ 3. exports goldens are the truth
console.log('\n[3] exports goldens rebuilt with the pure builders from the import + project goldens');
/** The CPT state the exports suite had (classify sb260 → goS(3)): the saved-project snapshot carries everything but the rows. */
function exportsState(fx) {
  const entry = manifest.fixtures[`cpt/${fx}.gef`] || manifest.fixtures[`cpt/${fx}.state.json`];
  const importGolden = readJson(join(GOLDEN, `node/import/${entry?.base ? fx : `${fx}.gef`}.json`));
  const snap = readJson(join(GOLDEN, `node/exports/${fx}.project.json`));
  const cpt = snap.project.cpts[snap.project.activeCptIdx];
  assert.equal(cpt.data['<digest>'], digest(importGolden.data)['<digest>'], `${fx}: the project snapshot digests the import golden rows`);
  return { ...cpt, data: importGolden.data };
}
for (const fx of profileNames) {
  check(`exports/${fx}.* == pure builders (csv, plaxis, plaxis-alerts, plaxis-cpt, filenames)`, () => {
    const cpt = exportsState(fx);
    assert.equal(cpt.method, 'sb260');
    assertSameText(normalizeText(exp.buildLayersCsv(cpt)), goldenText(`node/exports/${fx}.layers.csv`), 'layers.csv');
    assertSameText(normalizeText(exp.buildPlaxisCommandsText(cpt)), goldenText(`node/exports/${fx}.plaxis.txt`), 'plaxis.txt');
    const conflicts = exp.plaxisNuDrainageConflicts(cpt);
    assertSameText(goldenJsonText(conflicts.length ? [exp.plaxisNuDrainageAlertMessage(conflicts)] : []), goldenText(`node/exports/${fx}.plaxis-alerts.json`), 'plaxis-alerts.json');
    assertSameText(normalizeText(exp.buildPlaxisCptText(cpt)), goldenText(`node/exports/${fx}.plaxis-cpt.txt`), 'plaxis-cpt.txt');
    const names = readJson(join(GOLDEN, `node/exports/${fx}.filenames.json`));
    assert.deepEqual({ csv: exp.layersCsvFilename(cpt), plaxis: exp.plaxisCommandsFilename(cpt), plaxisCpt: exp.plaxisCptFilename(cpt) }, { csv: names.csv, plaxis: names.plaxis, plaxisCpt: names.plaxisCpt });
    assert.match(names.project, /^CPT_Project_<stamp>\.madep\.json$/, 'saveProject is not part of this move');
  });
}
check('exports/no-layers.alerts.json == the three guard messages, no download', () => {
  assertSameText(goldenJsonText({ alerts: [exp.NO_LAYERS_MESSAGE, exp.NO_LAYERS_MESSAGE, exp.NO_LAYER_MODEL_MESSAGE], downloads: 0 }), goldenText('node/exports/no-layers.alerts.json'), 'no-layers.alerts.json');
});
check('every exports golden on disk is covered', () => {
  const files = readdirSync(join(GOLDEN, 'node/exports')).sort();
  const expected = [...profileNames.flatMap((fx) => ['filenames.json', 'layers.csv', 'plaxis-alerts.json', 'plaxis-cpt.txt', 'plaxis.txt', 'project.json'].map((s) => `${fx}.${s}`)), 'no-layers.alerts.json'].sort();
  assert.deepEqual(files, expected);
  assert.equal(files.length, 55);
});
check('report/no-layers.json == pure guard (null) + the controller alert text', () => {
  assertSameText(goldenJsonText({ payload: rep.buildStage7Payload({ name: 'CPT Project', phase: 'analysis' }, { layers: [], data: [] }), alerts: [rep.STAGE7_GUARD_MESSAGE] }), goldenText('node/report/no-layers.json'), 'no-layers.json');
});

// ------------------------------------------------------------------ 4 + 5. Tier-B loader
console.log('\n[4] report goldens rebuilt by the PURE builder from the recorded Stage 2–6 chain state (Tier-B loader)');
if (PURE_ONLY) {
  console.log('SKIP  --pure-only');
  console.log('\n[5] controller wrappers ⇔ pure builders (Tier-B loader)');
  console.log('SKIP  --pure-only');
} else {
  const { makeContext } = await import('./golden/lib/context.mjs');
  const gctx = await makeContext();
  try {
    const c = await gctx.controller();
    const { api } = c;
    const P = api.PROJECT;
    /** The report suite's chain (scripts/golden/suites/report.mjs). */
    async function reportChain(fx) {
      const S = await gctx.classify(fx, 'sb260');
      api.goS(2);
      if (S.layers.length > 1) api.changeSubtype({ dataset: { i: '1' }, value: S.layers[1].type === 'Sand' ? 'zand, vast' : 'klei, vast' });
      api.goS(3); api.goS(4); api.runTuning(); api.acceptFit(0);
      api.goS(5);
      for (const app of ['bearing', 'pile', 'settlement', 'dewatering', 'beam']) api.setStage6App(app);
      api.setStage6App('bearing');
      c.alerts.length = 0; c.opened.length = 0;
      return S;
    }
    /** The suite's slimming for fixtures other than `layered` (digests of the rows / annex analyses). */
    const slim = (fx, payload) => fx === 'layered' ? payload : { ...payload, rawRows: digest(payload.rawRows), classifiedRows: digest(payload.classifiedRows), chartInputs: digest(payload.chartInputs),
      stage6: payload.stage6 && Object.fromEntries(Object.entries(payload.stage6).map(([k, v]) => [k, v && typeof v === 'object' && 'analysis' in v ? { ...v, analysis: digest(v.analysis) } : v])) };
    /** Pure deps: model-params defaults, no ensure, no capture, the seepslope throwers, the version the loader defines. */
    const pureDeps = () => ({ appVersion: pkg.version });
    const stateText = (S) => JSON.stringify({ ...S, charts: undefined, chartsReady: undefined });

    for (const fx of stage6Names) {
      await checkAsync(`report/${fx}.json + .valid.json == pure buildStage7Payload(project, S, pure deps) — bit-identical, state untouched`, async () => {
        const S = await reportChain(fx);
        const before = stateText(S);
        const payload = rep.buildStage7Payload({ name: P.name, phase: P.phase }, S, pureDeps());
        assert.equal(stateText(S), before, 'the pure builder must not touch the state');
        assert.equal(c.alerts.length, 0);
        assertSameText(goldenJsonText(slim(fx, payload)), goldenText(`node/report/${fx}.json`), `${fx}.json`);
        assertSameText(goldenJsonText({ isStage7Payload: isStage7Payload(payload), alerts: c.alerts.slice() }), goldenText(`node/report/${fx}.valid.json`), `${fx}.valid.json`);
        // the controller wrapper (its own deps: hsParams/khParams/stage6WorkingLayers, ensureStage6State, the capture) builds the same payload
        const viaWrapper = api.buildStage7Payload();
        assert.equal(c.alerts.length, 0);
        assert.deepEqual(normalize(viaWrapper), normalize(payload), 'wrapper ⇔ pure');
        // openStage7Report (unchanged) still stores the payload and opens the report tab
        api.openStage7Report();
        const keys = [...globalThis.localStorage._map.keys()].filter((k) => k.startsWith('stage7-report:'));
        assertSameText(goldenJsonText({ storedKeys: keys, opened: c.opened.map((u) => u.replace(/key=.*$/, 'key=<key>')), alerts: c.alerts.slice() }), goldenText(`node/report/${fx}.open.json`), `${fx}.open.json`);
      });
    }
    await checkAsync('report/no-layers.json through the wrapper (alert) and the pure builder (null, silent)', async () => {
      await gctx.resetProject();
      c.alerts.length = 0;
      assertSameText(goldenJsonText({ payload: api.buildStage7Payload(), alerts: c.alerts.slice() }), goldenText('node/report/no-layers.json'), 'no-layers.json');
      c.alerts.length = 0;
      assert.equal(rep.buildStage7Payload({ name: P.name, phase: P.phase }, gctx.S(), pureDeps()), null);
      assert.deepEqual(c.alerts, []);
    });
    check('every report golden on disk is covered', () => {
      const files = readdirSync(join(GOLDEN, 'node/report')).sort();
      assert.deepEqual(files, [...stage6Names.flatMap((fx) => ['json', 'open.json', 'valid.json'].map((s) => `${fx}.${s}`)), 'no-layers.json'].sort());
      assert.equal(files.length, 22);
    });

    console.log('\n[5] controller wrappers ⇔ pure builders (Tier-B loader)');
    const decode = (entry) => entry?.href?.startsWith('data:') ? decodeURIComponent(entry.href.slice(entry.href.indexOf(',') + 1)) : null;
    for (const fx of profileNames) {
      await checkAsync(`exportCSV / exportPlaxisCommands / exportPlaxisCpt on ${fx} == pure text, file names, alerts, MIME`, async () => {
        const S = await gctx.classify(fx, 'sb260');
        api.goS(3);
        c.captured.length = 0; c.alerts.length = 0;
        api.exportCSV();
        let dl = c.captured.at(-1);
        assert.ok(dl.href.startsWith('data:text/csv;charset=utf-8,'));
        assert.equal(decode(dl), exp.buildLayersCsv(S)); assert.equal(dl.download, exp.layersCsvFilename(S));
        api.exportPlaxisCommands();
        dl = c.captured.at(-1);
        assert.ok(dl.href.startsWith('data:text/plain;charset=utf-8,'));
        assert.equal(decode(dl), exp.buildPlaxisCommandsText(S)); assert.equal(dl.download, exp.plaxisCommandsFilename(S));
        const conflicts = exp.plaxisNuDrainageConflicts(S);
        assert.deepEqual(c.alerts, conflicts.length ? [exp.plaxisNuDrainageAlertMessage(conflicts)] : []);
        api.exportPlaxisCpt();
        dl = c.captured.at(-1);
        assert.ok(dl.href.startsWith('data:text/plain;charset=utf-8,'));
        assert.equal(decode(dl), exp.buildPlaxisCptText(S)); assert.equal(dl.download, exp.plaxisCptFilename(S));
        assert.equal(c.captured.length, 3);
        // the wrappers hand the pure builders the same ctx the controller's hsParams/khParams use
        assert.deepEqual(S.layers.map((l) => api.hsParams(l)), S.layers.map((l) => hsParams(l, cptModelCtx(S))));
        assert.deepEqual(S.layers.map((l) => api.khParams(l)), S.layers.map((l) => khParams(l, cptModelCtx(S))));
      });
    }
    await checkAsync('the no-layers guards: three alerts, no download; the no-rows guard of exportPlaxisCpt', async () => {
      await gctx.resetProject();
      c.captured.length = 0; c.alerts.length = 0;
      api.exportCSV(); api.exportPlaxisCommands(); api.exportPlaxisCpt();
      assert.deepEqual(c.alerts, [exp.NO_LAYERS_MESSAGE, exp.NO_LAYERS_MESSAGE, exp.NO_LAYER_MODEL_MESSAGE]);
      assert.equal(c.captured.length, 0);
      const S = gctx.S();
      S.layers = [{ top: 100, bot: 101, type: 'Sand', subtype: 'zand, dicht', avgQc: 5, g: 18, gs: 20, phi: 30, c: 0, cu: 0, ovr: {} }];
      S.data = [{ z: 1, qc: 5, fs: 0.05, rf: 1 }];
      c.captured.length = 0; c.alerts.length = 0;
      api.exportPlaxisCpt();
      assert.deepEqual(c.alerts, [exp.NO_SIMULATED_ROWS_MESSAGE]);
      assert.equal(c.captured.length, 0);
      assert.equal(exp.buildPlaxisCptText(S), null);
      await gctx.resetProject();
    });
    check('the export / report names are still published on window', () => {
      for (const n of ['exportCSV', 'exportPlaxisCommands', 'exportPlaxisCpt', 'buildStage7Payload', 'openStage7Report', 'stage7CaptureWorkspaceView', 'stage7ClearWorkspaceCapture']) assert.equal(typeof api[n], 'function', n);
    });
  } finally {
    await gctx.close();
  }
}

// ------------------------------------------------------------------ 6. extraction complete
console.log('\n[6] extraction complete');
const CTRL = join(ROOT, 'src/lib/cpt-app/legacy-controller.js');
check('legacy-controller.js no longer declares the moved bodies', () => {
  const src = readFileSync(CTRL, 'utf8');
  for (const decl of ['function safeMaterialToken(', 'function plaxisDrainageType(', 'function plaxisDisplayName(', 'function plaxisCommandValue(', 'function buildPlaxisSoilmatCommand(', 'function msToMday(',
    'function findLayerForDepth(', 'function simulatedLayerFs(', 'function layerFsIsSynthetic(', 'function formatPlaxisCoord(', 'function safeClone(',
    'function stage7MethodLabel(', 'function stage7ParamMethodLabel(', 'function stage7AlphaMethodLabel(', 'function stage7StiffMethodLabel(', 'function stage7WtSourceLabel(', 'function stage7ElevSourceLabel(',
    'function stage7LayerWarnings(', 'function stage7TuningPayload(', 'function stage7WorkingLayerPayload(', 'function stage7BishopPayload(', 'function stage7SeepagePayload(', 'function stage7DeformationPayload(', 'function stage7Stage6Payload(',
    "const hdr='Layer,Type,Subtype", 'soilmat ${', "`X[m] ${", 'version:4,', "'Stage 7 seepage payload build failed:'", "from './report-svg'", 'simulatedLayerFsValue']) {
    assert.ok(!src.includes(decl), `still contains ${decl}`);
  }
});
check('the export/ and report/ installs own the wrappers, and the composition root wires them', () => {
  const src = readFileSync(CTRL, 'utf8');
  // PR 20 (composition root): the three download handlers and the Stage 7 payload / report
  // window moved into installExportApp(ctx) / installReportApp(ctx); the controller installs
  // them and spreads their `handlers` into the one published surface.
  assert.ok(/import \{ installLoadApp \} from '\.\/load\/index\.js';\nimport \{ installExportApp \} from '\.\/export\/index\.js';\nimport \{ installReportApp \} from '\.\/report\/index\.js';/.test(src),
    'the export/ and report/ installs are imported right after load/');
  assert.ok(src.includes('...exportApp.handlers'), 'exportApp.handlers is spread into the published surface');
  assert.ok(src.includes('...reportApp.handlers'), 'reportApp.handlers is spread into the published surface');
  assert.ok(src.includes('captureBishopWorkspaceView: stage7CaptureBishopWorkspaceView,'), 'the capture dep is wired');
  assert.ok(src.includes('resolvedSeepageMeshTargetArea: stage6BishopResolvedSeepageMeshTargetArea'), 'the seepslope deps are wired');
  assert.ok(src.includes('const { deps: stage7ControllerDeps, buildStage7Payload, openStage7Report } = reportApp;'), 'the report bindings');
  for (const name of ['exportCSV', 'exportPlaxisCommands', 'exportPlaxisCpt', 'buildStage7Payload', 'openStage7Report', 'stage7ControllerDeps']) {
    assert.ok(!new RegExp(`^function ${name}\\(`, 'm').test(src), `${name} is still declared in legacy-controller.js`);
  }
  // PR 20: the two SVG markup builders are consumed by load/layer-svgs.js, not by the host.
  assert.ok(readFileSync(join(ROOT, 'src/lib/cpt-app/load/layer-svgs.js'), 'utf8')
    .includes("import { buildLayerColumnSvgMarkup, buildLayerPreviewSvgMarkup } from '../report/svg.js';"), 'svg import moved');
  // The bodies, verbatim, in the packages that own them.
  const exp = readFileSync(join(ROOT, 'src/lib/cpt-app/export/index.js'), 'utf8');
  for (const w of [
    "exportCSV(){\n      const S=getActive();\n      if(!S.layers.length){alert(NO_LAYERS_MESSAGE);return;}\n      const csv=buildLayersCsv(S, ctx.modelCtx());",
    "const txt=buildPlaxisCommandsText(S, ctx.modelCtx());\n      const nuDrainageConflicts=plaxisNuDrainageConflicts(S, ctx.modelCtx());\n      if(nuDrainageConflicts.length){\n        alert(plaxisNuDrainageAlertMessage(nuDrainageConflicts));\n      }",
    "if(!S.layers.length || !S.data.length){\n        alert(NO_LAYER_MODEL_MESSAGE);\n        return;\n      }\n      const txt=buildPlaxisCptText(S, ctx.modelCtx());\n      if(txt==null){\n        alert(NO_SIMULATED_ROWS_MESSAGE);\n        return;\n      }",
    "a.href=href;\n    a.download=name;\n    a.click();"]) {
    assert.ok(exp.includes(w), `export/index.js wrapper missing: ${w.split('\n')[0]}`);
  }
  const rep = readFileSync(join(ROOT, 'src/lib/cpt-app/report/index.js'), 'utf8');
  for (const w of [
    "if(!S.layers.length || !S.data.length){\n        alert(STAGE7_GUARD_MESSAGE);\n        return null;\n      }\n      return buildStage7PayloadPure(getProject(), S, app.deps());",
    'openStage7Report(){', 'cleanupStage7Payloads(win.localStorage, key);']) {
    assert.ok(rep.includes(w), `report/index.js wrapper missing: ${w.split('\n')[0]}`);
  }
  // PR 20 moved the Stage 7 workspace capture into the Seep/Slope host layer; the controller
  // binds the four names from that install and hands them to report/deps.js unchanged.
  const host = readFileSync(join(ROOT, 'src/lib/cpt-app/seepslope/host.js'), 'utf8');
  for (const w of ['function stage7CaptureCanvasImage(', 'function stage7CaptureWorkspaceView(',
    'function stage7ClearWorkspaceCapture(', 'function stage7CaptureBishopWorkspaceView(']) {
    assert.ok(host.includes(w), `seepslope/host.js missing: ${w}`);
  }
});
check('export/ and report/ modules: SPDX + @ts-nocheck, no DOM / alert / S; report-svg.js moved, report-storage.js in place', () => {
  // PR 20: index.js is each package's install — it owns the browser half (the `<a download>`
  // click, the blocking guards, localStorage + window.open). Every *other* module stays pure.
  const dirs = { export: ['csv.js', 'index.js', 'plaxis-commands.js', 'plaxis-cpt.js'], report: ['clone.js', 'deps.js', 'index.js', 'payload-seepslope.js', 'payload-stage6.js', 'payload.js', 'svg.js'] };
  for (const [dir, expected] of Object.entries(dirs)) {
    const base = join(ROOT, 'src/lib/cpt-app', dir);
    assert.deepEqual(readdirSync(base).filter((f) => f.endsWith('.js')).sort(), expected, dir);
    for (const f of expected) {
      const text = readFileSync(join(base, f), 'utf8');
      const head = text.split('\n').slice(0, 2);
      assert.equal(head[0], '// SPDX-License-Identifier: AGPL-3.0-or-later', f);
      assert.equal(head[1], '// @ts-nocheck', f);
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const m of code.matchAll(/from '(\.[^']+)'/g)) assert.ok(m[1].endsWith('.js'), `${dir}/${f}: plain-Node import ${m[1]}`);
      if (f === 'index.js') continue;
      assert.ok(!/\bdocument\b|\bwindow\b|\balert\(|\blocalStorage\b|\bS\.|\bPROJECT\b/.test(code), `${dir}/${f} must not touch the DOM, alert, S or PROJECT`);
    }
  }
  assert.ok(!existsSync(join(ROOT, 'src/lib/cpt-app/report-svg.js')), 'report-svg.js moved to report/svg.js');
  assert.ok(existsSync(join(ROOT, 'src/lib/cpt-app/report-storage.js')), 'report-storage.js stays (report routes + the golden suite import it)');
  for (const route of ['src/routes/report/+page.svelte', 'src/routes/report/stage7/+page.svelte']) assert.ok(readFileSync(join(ROOT, route), 'utf8').includes("'$lib/cpt-app/report-storage'"), route);
  assert.ok(!readFileSync(join(ROOT, 'src/lib/cpt-app/report/svg.js'), 'utf8').includes("from './soil-styles'"), 'svg.js import re-pointed');
});

console.log(`\n${count - fails}/${count} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
