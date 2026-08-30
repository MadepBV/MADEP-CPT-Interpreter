#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifier for src/lib/cpt-app/load/* — the Stage 1 parsers, the apply patch, the serial
// multi-file loader, the demo generator and the Stage 1 DOM syncs moved out of
// legacy-controller.js in refactor step 5 (PR 9, worklog/refactor/10-pr9-load.md).
//
// Parts:
//   1-5  unit checks of the pure modules under plain Node (no Vite, no DOM stub):
//        file kinds, Excel header lookups, delimited text, GEF reading loop, apply patch;
//   6    the demo generator against a seeded PRNG: demoRows(mulberry32(seed)) must equal the
//        recorded golden node/import/demo-seeded.json bit for bit;
//   7    the recorded goldens are the truth: every CPT fixture under tests/golden/fixtures/cpt/
//        (GEF / CSV / XLSX, plus the state-injected variant) is parsed with the pure parser,
//        applied to a fresh CPT with applyParsedCpt(cpt, parsed) and must deep-equal
//        node/import/<fixture>.json (tolerance class "pure": exact); the review descriptor
//        must match the recorded dialog text and the recorded alerts must be empty ⇔ ok;
//   8    wrapper ⇔ pure agreement through the golden Tier-B loader (controller under Node,
//        DOM stub, auto-confirmed review): single import, the multi-file loader with an
//        explicit target CPT (no S swap), a failing file in the middle, seeded loadDemo,
//        legacyApi names. Skip with --pure-only.
//   9    extraction complete (the moved bodies are gone from the controller, the wrappers and
//        the import block are present, the modules carry SPDX + @ts-nocheck).
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = join(ROOT, 'tests/golden');
const FIXTURES = join(GOLDEN, 'fixtures');
const IMPORT_GOLDEN = join(GOLDEN, 'node/import');
const PURE_ONLY = process.argv.includes('--pure-only');

const load = await import('../src/lib/cpt-app/load/index.js');
const {
  stripCptFileExtension, isExcelCptFile, isCsvCptFile,
  parseGEF, GEF_CHANNELS, parseCsvCpt, splitDelimitedLine, parseDelimitedText, detectDelimitedTextSeparator,
  parseExcelCpt, loadXlsxModule,
  pad2, formatExcelHeaderValue, normalizeExcelLabel, excelHeaderLookup, excelHeaderText, excelHeaderNumber, findExcelSheetName,
  applyParsedCpt, reviewStaging, NO_DATA_ROWS_MESSAGE,
  demoRows, demoPatch
} = load;
const { DEFAULT_ASSUMED_RF } = await import('../src/lib/cpt-app/classification-core.js');
const { mulberry32 } = await import('./golden/lib/prng.mjs');
const { htmlToText } = await import('./golden/lib/html-text.mjs');

let fails = 0;
let count = 0;
function check(name, fn) {
  count++;
  try { fn(); console.log(`OK    ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n').slice(0, 12).join('\n      ')}`); }
}
async function checkAsync(name, fn) {
  count++;
  try { await fn(); console.log(`OK    ${name}`); }
  catch (e) { fails++; console.log(`FAIL  ${name}\n      ${String(e.message || e).split('\n').slice(0, 12).join('\n      ')}`); }
}

/** Same shape the golden normaliser stores: keys sorted, undefined/functions dropped, non-finite as strings. */
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
const manifest = readJson(join(FIXTURES, 'manifest.json'));

/** The Stage 1 half of newCptState() (legacy-controller.js) — what a fresh tab carries before an import. */
const freshCpt = () => ({
  id: 'CPT-1', x: null, y: null, data: [], wt: 1.7, wtFromFile: false, wtSource: null,
  elev: null, elevFromFile: false, elevSource: null, assumedRf: DEFAULT_ASSUMED_RF, method: 'robertson2016', meta: {}
});
/** The import suite's `pick(S)` (scripts/golden/suites/import.mjs). */
const pick = (S) => ({
  id: S.id, data: S.data, wt: S.wt, wtFromFile: S.wtFromFile, wtSource: S.wtSource,
  elev: S.elev, elevFromFile: S.elevFromFile, elevSource: S.elevSource, x: S.x, y: S.y,
  meta: S.meta, assumedRf: S.assumedRf, method: S.method, _maxStage: S._maxStage ?? 0
});

/** Pure parse of a fixture file by extension (what the controller's importers do before the dialog). */
async function parseFixture(fname) {
  const path = join(FIXTURES, 'cpt', fname);
  if (isExcelCptFile({ name: fname })) return parseExcelCpt(await loadXlsxModule(), new Uint8Array(readFileSync(path)), fname);
  if (isCsvCptFile({ name: fname })) return parseCsvCpt(readFileSync(path, 'utf8'), fname);
  return parseGEF(readFileSync(path, 'utf8'), fname);
}
/** Parse + apply to a fresh CPT + the loader's id rule — the state a single-file import leaves behind. */
async function importPure(fname) {
  const parsed = await parseFixture(fname);
  const cpt = freshCpt();
  if (!parsed.ok) return { parsed, cpt, applied: false };
  const patch = applyParsedCpt(cpt, parsed);
  if (!patch) return { parsed, cpt, applied: false };
  Object.assign(cpt, patch);
  cpt.id = stripCptFileExtension(fname);
  return { parsed, cpt, applied: true };
}

// ------------------------------------------------------------------ 1. file kinds
console.log('\n[1] file kinds');
check('stripCptFileExtension strips gef/txt/csv/xls/xlsx (case-insensitive), keeps the rest', () => {
  assert.equal(stripCptFileExtension('S1.GEF'), 'S1');
  assert.equal(stripCptFileExtension('site.a.xlsx'), 'site.a');
  assert.equal(stripCptFileExtension('notes.txt'), 'notes');
  assert.equal(stripCptFileExtension('trace.dat'), 'trace.dat');
  assert.equal(stripCptFileExtension(''), 'CPT');
  assert.equal(stripCptFileExtension(undefined), 'CPT');
});
check('isExcelCptFile / isCsvCptFile by extension or MIME type', () => {
  assert.equal(isExcelCptFile({ name: 'a.XLS' }), true);
  assert.equal(isExcelCptFile({ name: 'a.bin', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), true);
  assert.equal(isExcelCptFile({ name: 'a.bin', type: 'application/vnd.ms-excel' }), true);
  assert.equal(isExcelCptFile({ name: 'a.gef', type: 'text/plain' }), false);
  assert.equal(isCsvCptFile({ name: 'a.csv' }), true);
  assert.equal(isCsvCptFile({ name: 'a.txt', type: 'text/csv' }), true);
  assert.equal(isCsvCptFile({ name: 'a.gef' }), false);
  assert.equal(isCsvCptFile(null), false);
});

// ------------------------------------------------------------------ 2. Excel header lookups
console.log('\n[2] Excel header lookups');
check('pad2 / formatExcelHeaderValue: date → dd/mm/yyyy, time key → hh:mm:ss, number/string/null', () => {
  assert.equal(pad2(7), '07');
  const d = new Date(2026, 0, 15, 9, 5, 3);
  assert.equal(formatExcelHeaderValue(d, 'Datum'), '15/01/2026');
  assert.equal(formatExcelHeaderValue(d, 'Tijd'), '09:05:03');
  assert.equal(formatExcelHeaderValue(d, 'Start time'), '09:05:03');
  assert.equal(formatExcelHeaderValue(new Date(NaN), 'Datum'), 'Invalid Date');
  assert.equal(formatExcelHeaderValue(12.5), '12.5');
  assert.equal(formatExcelHeaderValue(3), '3');
  assert.equal(formatExcelHeaderValue('  S1 '), 'S1');
  assert.equal(formatExcelHeaderValue(null), '');
});
check('normalizeExcelLabel: trim, lower, strip diacritics, non-alphanumerics → single space', () => {
  assert.equal(normalizeExcelLabel(' Sondering  Nummer '), 'sondering nummer');
  assert.equal(normalizeExcelLabel('Locatie (één)'), 'locatie een ');
  assert.equal(normalizeExcelLabel(null), '');
});
const HEADER_ROWS = [['Taak Nummer', 'P-1'], ['Sondering Nummer', ' S1-X '], ['Waterniveau', '-1,70'], ['Grondniveau', 10], ['Datum', new Date(2026, 0, 15)], ['Beta Factor', 'n/a']];
check('excelHeaderLookup / excelHeaderText / excelHeaderNumber (first matching label wins, comma decimals, unparseable → null)', () => {
  assert.equal(excelHeaderLookup(HEADER_ROWS, ['Project', 'Taak Nummer']), 'P-1');
  assert.equal(excelHeaderLookup(HEADER_ROWS, ['Missing']), null);
  assert.equal(excelHeaderText(HEADER_ROWS, ['Sondering Nummer', 'Test ID']), 'S1-X');
  assert.equal(excelHeaderText(HEADER_ROWS, ['Datum', 'Date']), '15/01/2026');
  assert.equal(excelHeaderText(HEADER_ROWS, ['Client Naam']), null);
  assert.equal(excelHeaderNumber(HEADER_ROWS, ['Waterniveau']), -1.7);
  assert.equal(excelHeaderNumber(HEADER_ROWS, ['Grondniveau']), 10);
  assert.equal(excelHeaderNumber(HEADER_ROWS, ['Beta Factor']), null);
});
check('findExcelSheetName: exact normalised match before substring match', () => {
  const wb = { SheetNames: ['Header info', 'DATA', 'data-raw'] };
  assert.equal(findExcelSheetName(wb, 'Data'), 'DATA');
  assert.equal(findExcelSheetName(wb, 'Header'), 'Header info');
  assert.equal(findExcelSheetName(wb, 'Summary'), undefined);
});

// ------------------------------------------------------------------ 3. delimited text
console.log('\n[3] delimited text (CSV)');
check('splitDelimitedLine: quotes, escaped quotes, trimming', () => {
  assert.deepEqual(splitDelimitedLine('a, "b,c" ,"d""e"', ','), ['a', 'b,c', 'd"e']);
  assert.deepEqual(splitDelimitedLine('1;2;', ';'), ['1', '2', '']);
});
check('parseDelimitedText: BOM stripped, CRLF, blank rows dropped', () => {
  assert.deepEqual(parseDelimitedText('﻿depth,qc\r\n\r\n0.1,2\r\n , \n', ','), [['depth', 'qc'], ['0.1', '2']]);
});
check('detectDelimitedTextSeparator: tab and semicolon files, header row wins', () => {
  assert.equal(detectDelimitedTextSeparator('depth\tqc\tfs\n0.1\t2.5\t0.04\n'), '\t');
  assert.equal(detectDelimitedTextSeparator('depth;qc;fs\n0.1;2.5;0.04\n0.2;2.6;0.05\n'), ';');
  assert.equal(detectDelimitedTextSeparator(''), ',');
});
check('known behaviour (README, follow-up): `;`-separated with comma decimals is scored as `,`-delimited', () => {
  assert.equal(detectDelimitedTextSeparator('depth;qc;fs\n0,10;2,50;0,04\n0,20;2,60;0,05\n'), ',');
});
check('parseCsvCpt: rows/meta/review for a README-format file; testid from the file name', () => {
  const p = parseCsvCpt('depth,qc,fs\n0.10,2.5,0.04\n0.05,2.4,0.03\n0.15,0.01,0.001\n', 'site-7.csv');
  assert.equal(p.ok, true);
  assert.equal(p.format, 'CSV');
  assert.equal(p.delimiter, ',');
  assert.deepEqual(p.rows.map((r) => r.z), [0.05, 0.1]);              // sorted; qc < 0.02 skipped
  assert.equal(p.skipped.length, 1);
  assert.equal(p.rows[1].rf, +((0.04 / 2.5) * 100).toFixed(3));
  assert.deepEqual(p.meta, { fname: 'site-7.csv', importFormat: 'CSV', project: null, testid: 'site-7', owner: null, location: null, date: null, aRatio: 0.8, zid: null });
  assert.deepEqual(Object.keys(p.review), ['fileName', 'format', 'grid', 'headerIdx', 'cols', 'context']);
  assert.deepEqual(p.review.cols, { z: 0, qc: 1, fs: 2, rf: -1 });
  assert.deepEqual(p.review.context, { waterLevel: null, elevation: null, x: null, y: null, testid: 'site-7', project: null });
  assert.equal(p.waterLevel, null); assert.equal(p.elevation, null);
  assert.ok(!('x' in p) && !('coordinateSource' in p), 'CSV carries no coordinates');
});
check('parseCsvCpt: error results carry the old alert texts', () => {
  assert.deepEqual(parseCsvCpt('a;b;c\n1;2;3\n', 'g.csv'), { ok: false, error: 'Could not find depth/qc columns in the CSV file.' });
  assert.deepEqual(parseCsvCpt('depth,qc\n', 'e.csv').ok, true);
});

// ------------------------------------------------------------------ 4. GEF
console.log('\n[4] GEF reading loop');
const GEF = [
  '#GEFID= 1, 1, 0', '#PROJECTID= P-9', '#TESTID= S9', '#STARTDATE= 2026, 1, 15', '#FILEOWNER= Owner X',
  '#MEASUREMENTTEXT= 9, Site Y, lokatie', '#ZID= 31000, 4.25', '#MEASUREMENTVAR= 14, -1.30, m, water',
  '#MEASUREMENTVAR= 3, 0.75, -, area ratio',
  '#COLUMNINFO= 1, m, penetration length, 1', '#COLUMNINFO= 2, kPa, qc, 2', '#COLUMNINFO= 3, kPa, fs, 3',
  '#COLUMNINFO= 4, m, corrected depth, 11', '#COLUMNINFO= 5, MPa, u2, 6',
  '#EOH=',
  '! comment',
  '0.05  10   1     0.02  0.001',      // qc 0.01 MPa → cone not engaged, skipped
  '0.10  2500 40    0.08  0.002',      // kPa → MPa; rf from fs
  '0.15  3000 900   0.13  x',          // non-numeric → skipped
  '0.20  1000 300   0.18  0.003',      // fs/qc = 30 % → rf clamped to 20
  '0.25'
].join('\n');
check('parseGEF: header fields, units, corrected depth, cone-engaged skip, rf clamp, u2', () => {
  const p = parseGEF(GEF, 'S9.gef');
  assert.equal(p.ok, true); assert.equal(p.format, 'GEF');
  assert.deepEqual(p.rows, [
    { z: 0.08, qc: 2.5, fs: 0.04, rf: 1.6, u2: 0.002 },
    { z: 0.18, qc: 1, fs: 0.3, rf: 20, u2: 0.003 }
  ]);
  assert.deepEqual(p.meta, { fname: 'S9.gef', project: 'P-9', testid: 'S9', date: '2026, 1, 15', owner: 'Owner X', location: 'Site Y', importFormat: 'GEF', aRatio: 0.75, zid: 4.25 });
  assert.equal(p.waterLevel, 1.3); assert.equal(p.waterSource, 'MEASUREMENTVAR 14');
  assert.equal(p.elevation, 4.25); assert.equal(p.elevationSource, 'ZID');
  assert.deepEqual(p.columns.colMap, { 1: 0, 2: 1, 3: 2, 11: 3, 6: 4 });
  assert.deepEqual(p.review.channels.map((c) => c.source), ['kolom 4 (GEF #11)', 'kolom 2 (GEF #2)', 'kolom 3 (GEF #3)', 'niet in bestand', 'kolom 5 (GEF #6)']);
  assert.deepEqual(p.review.channels.map((c) => c.unit), ['m', 'kPa', 'kPa', '', 'MPa']);
  assert.deepEqual(p.review.context, { waterLevel: 1.3, waterSource: 'MEASUREMENTVAR 14', elevation: 4.25, elevationSource: 'ZID', x: null, y: null, testid: 'S9', project: 'P-9' });
  assert.equal(GEF_CHANNELS.length, 5);
});
check('parseGEF: no header → defaults (aRatio 0.8, no wt/zid), depth from quantity 1, Rf column preferred over fs', () => {
  const p = parseGEF('#COLUMNINFO= 1, m, d, 1\n#COLUMNINFO= 2, MPa, qc, 2\n#COLUMNINFO= 3, MPa, fs, 3\n#COLUMNINFO= 4, %, rf, 4\n#EOH=\n1.0 5 0.1 1.5\n2.0 5 0.1 60\n', 'x.gef');
  assert.deepEqual(p.rows.map((r) => r.rf), [1.5, 2]);           // 60 % is out of range → derived from fs
  assert.deepEqual(p.meta, { fname: 'x.gef', importFormat: 'GEF', aRatio: 0.8, zid: null });
  assert.equal(p.waterLevel, null); assert.equal(p.waterSource, null); assert.equal(p.elevationSource, null);
  assert.equal(p.review.context.testid, null);
});

// ------------------------------------------------------------------ 5. apply patch
console.log('\n[5] applyParsedCpt(cpt, parsed) → patch, reviewStaging');
const ROWS = [{ z: 0.1, qc: 2, fs: null, rf: null, u2: null }, { z: 0.2, qc: 3, fs: 0.03, rf: 1, u2: 0.01 }];
check('null when no rows; the wrapper alerts NO_DATA_ROWS_MESSAGE', () => {
  assert.equal(applyParsedCpt(freshCpt(), { rows: [], meta: {} }), null);
  assert.equal(NO_DATA_ROWS_MESSAGE, 'No valid data rows found.');
});
check('water table / elevation: file values with source fallback "file"; default wt 1.5 when absent', () => {
  const a = applyParsedCpt(freshCpt(), { rows: ROWS, meta: { fname: 'a' }, waterLevel: 0, elevation: 3.5 });
  assert.equal(a.wt, 0); assert.equal(a.wtFromFile, true); assert.equal(a.wtSource, 'file');
  assert.equal(a.elev, 3.5); assert.equal(a.elevFromFile, true); assert.equal(a.elevSource, 'file');
  const b = applyParsedCpt(freshCpt(), { rows: ROWS, meta: {}, waterLevel: null, elevation: null });
  assert.equal(b.wt, 1.5); assert.equal(b.wtFromFile, false); assert.equal(b.wtSource, null);
  assert.equal(b.elev, null); assert.equal(b.elevFromFile, false); assert.equal(b.elevSource, null);
  const c = applyParsedCpt(freshCpt(), { rows: ROWS, meta: {}, waterLevel: 1.2, waterSource: 'MEASUREMENTVAR 14', elevation: 2, elevationSource: 'ZID' });
  assert.equal(c.wtSource, 'MEASUREMENTVAR 14'); assert.equal(c.elevSource, 'ZID');
});
check('coordinates: real pair replaces, origin pair ignored, declared-but-absent clears, otherwise the CPT keeps its own', () => {
  const cpt = { ...freshCpt(), x: 5, y: 6 };
  assert.deepEqual([applyParsedCpt(cpt, { rows: ROWS, meta: {}, x: 1, y: 2 }).x, applyParsedCpt(cpt, { rows: ROWS, meta: {}, x: 1, y: 2 }).y], [1, 2]);
  const origin = applyParsedCpt(cpt, { rows: ROWS, meta: {}, x: 0, y: 0, coordinateSource: 'Header coordinates' });
  assert.deepEqual([origin.x, origin.y], [null, null]);
  const declared = applyParsedCpt(cpt, { rows: ROWS, meta: {}, x: null, y: 7, coordinateSource: 'Header coordinates' });
  assert.deepEqual([declared.x, declared.y], [null, null]);
  const kept = applyParsedCpt(cpt, { rows: ROWS, meta: {}, x: null, y: 7 });
  assert.deepEqual([kept.x, kept.y], [5, 6]);
  const csv = applyParsedCpt(cpt, { rows: ROWS, meta: {} });
  assert.deepEqual([csv.x, csv.y], [5, 6]);
});
check('meta: parser meta + nRows/depthMin/depthMax/hasU2/hasFs/hasRf; patch key set = the fields applyParsedCpt set', () => {
  const p = applyParsedCpt(freshCpt(), { rows: ROWS, meta: { fname: 'f', importFormat: 'GEF', aRatio: 0.8 } });
  assert.deepEqual(p.meta, { fname: 'f', importFormat: 'GEF', aRatio: 0.8, nRows: 2, depthMin: 0.1, depthMax: 0.2, hasU2: true, hasFs: true, hasRf: true });
  assert.deepEqual(Object.keys(p), ['data', 'wt', 'wtFromFile', 'wtSource', 'elev', 'elevFromFile', 'elevSource', 'x', 'y', 'meta']);
  assert.equal(p.data, ROWS);
});
check('reviewStaging: the parser\'s review descriptor with assumedRf appended to the context', () => {
  const parsed = parseGEF(GEF, 'S9.gef');
  const staged = reviewStaging(parsed, '3.0');
  assert.deepEqual(Object.keys(staged), ['fileName', 'format', 'rows', 'channels', 'context']);
  assert.deepEqual(Object.keys(staged.context), ['waterLevel', 'waterSource', 'elevation', 'elevationSource', 'x', 'y', 'testid', 'project', 'assumedRf']);
  assert.equal(staged.context.assumedRf, '3.0');
  assert.equal(staged.rows, parsed.rows);
  assert.ok(!('assumedRf' in parsed.review.context), 'the parser result stays free of the CPT setting');
});

// ------------------------------------------------------------------ 6. demo
console.log('\n[6] demo generator against the seeded PRNG');
const demoGolden = readJson(join(IMPORT_GOLDEN, 'demo-seeded.json'));
check(`demoRows(mulberry32(${manifest.seed})) == golden demo-seeded.json data (${demoGolden.data.length} rows, exact)`, () => {
  const rows = demoRows(mulberry32(manifest.seed));
  assert.equal(rows.length, demoGolden.data.length);
  assert.deepStrictEqual(canon(rows), demoGolden.data);
});
check('demoPatch(seeded) applied to a fresh CPT == golden demo-seeded.json (pick), depthMax stays the loop bound 21.73', () => {
  const cpt = freshCpt();
  Object.assign(cpt, demoPatch(mulberry32(manifest.seed)));
  assert.deepStrictEqual(canon(pick(cpt)), demoGolden);
  assert.equal(cpt.meta.depthMax, 21.73);
  assert.equal(cpt.data.at(-1).z, 21.72);
});
check('demoRows draws qc then rf per reading (2 calls / row) and keeps the band edges', () => {
  let calls = 0;
  const rows = demoRows(() => { calls++; return 0; });
  assert.equal(calls, rows.length * 2);
  assert.equal(rows.length, 1080);
  const at = (z) => rows.find((r) => Math.abs(r.z - z) < 1e-9);
  assert.deepEqual([at(0.58).qc, at(0.6).qc, at(1.48).qc, at(1.5).qc, at(2.98).qc, at(3).qc], [0.15, 3, 3, 7, 7, 1.2]);
  assert.deepEqual([at(5.48).rf, at(5.5).rf, at(6.98).rf, at(7).rf, at(9.48).rf, at(9.5).rf, at(10.98).rf, at(11).rf], [4, 3.5, 3.5, 1.2, 1.2, 3, 3, 1.5]);
  assert.equal(demoRows.length, 0);   // random has a default (Math.random) — injectable
});

// ------------------------------------------------------------------ 7. goldens are the truth
console.log('\n[7] tests/golden/node/import/* recomputed with the pure parsers + applyParsedCpt');
const cptEntries = Object.entries(manifest.fixtures).filter(([k, e]) => k.startsWith('cpt/') && e.role !== 'aux');
const fixtureFiles = readdirSync(join(FIXTURES, 'cpt')).sort();
check(`every file under fixtures/cpt/ is in the manifest and covered (${fixtureFiles.length} files)`, () => {
  assert.deepEqual(fixtureFiles, cptEntries.map(([k]) => k.slice(4)).sort());
});
for (const [key, entry] of cptEntries) {
  const name = key.slice(4).replace(/\.state\.json$/, '');
  const fname = entry.base || key.slice(4);
  await checkAsync(`${name}: pure ${basename(fname).split('.').pop().toUpperCase()} parse + apply == node/import/${name}.json${entry.inject ? ' (with manifest inject)' : ''}`, async () => {
    const golden = readJson(join(IMPORT_GOLDEN, `${name}.json`));
    const { parsed, cpt, applied } = await importPure(fname);
    assert.equal(applied, true, parsed.error);
    if (entry.inject) Object.assign(cpt, entry.inject);
    assert.deepStrictEqual(canon(pick(cpt)), golden);
    // the recorded dialog reflects the pure review descriptor
    const review = htmlToText(readFileSync(join(IMPORT_GOLDEN, `${name}.review.txt`), 'utf8'));
    assert.ok(review.includes(`Importeer ${parsed.rows.length} metingen`), 'row count in the dialog');
    assert.ok(review.includes(`${parsed.fileName} · ${parsed.format}`), 'file line in the dialog');
    if (parsed.format === 'GEF') for (const ch of parsed.review.channels) assert.ok(review.includes(ch.source), `channel ${ch.label}: ${ch.source}`);
    else assert.ok(parsed.review.grid.length > parsed.review.headerIdx, 'grid + header row');
    assert.deepEqual(readJson(join(IMPORT_GOLDEN, `${name}.alerts.json`)), [], 'no alert was recorded');
  });
}
check('known behaviour locked: layered-comma.csv (`;` + comma decimals) parses with `,` → 341 rows of column-count garbage (follow-up)', () => {
  const p = parseCsvCpt(readFileSync(join(FIXTURES, 'cpt/layered-comma.csv'), 'utf8'), 'layered-comma.csv');
  assert.equal(p.delimiter, ',');
  assert.equal(p.rows.length, 341);
  assert.deepEqual(p.rows[0], { z: 1, qc: 1, fs: 1, rf: 1, u2: null });
});

// ------------------------------------------------------------------ 8. controller wrappers ⇔ pure (Tier-B loader)
console.log('\n[8] controller wrappers ⇔ pure modules (Tier-B loader, DOM stub, auto-confirmed review)');
if (PURE_ONLY) {
  console.log('SKIP  --pure-only');
} else {
  const { makeContext, waitFor } = await import('./golden/lib/context.mjs');
  const gctx = await makeContext();
  try {
    const c = await gctx.controller();
    const { api } = c;
    const doc = c.document;
    const fixtureFile = (fname) => new File([readFileSync(join(FIXTURES, 'cpt', fname))], fname);
    const stage1Dom = () => Object.fromEntries(['wtR', 'wtN', 'elevN', 'cptX', 'cptY'].map((id) => [id, doc.getElementById(id).value])
      .concat(['elev-src', 'wt-src', 'wt-taw', 'finfo'].map((id) => [id, doc.getElementById(id).textContent]))
      .concat([['mgrid', doc.getElementById('mgrid').innerHTML], ['s1body', doc.getElementById('s1body').style.display]]));

    await checkAsync('loadGEF (single file) through the wrappers == pure parse + apply for GEF, CSV and XLSX', async () => {
      for (const fname of ['layered.gef', 'layered.csv', 'layered.xlsx']) {
        const S = await gctx.loadCpt(fname.replace(/\.gef$/, ''));
        const { cpt } = await importPure(fname);
        assert.deepStrictEqual(canon(pick(S)), canon(pick(cpt)), fname);
        assert.deepEqual(c.alerts, []);
      }
    });

    await checkAsync('multi-file loadGEF: explicit targets, no S swap — active tab stays, each CPT == pure parse + apply, ids from file names', async () => {
      await gctx.resetProject();
      c.alerts.length = 0; c.importReviews.length = 0;
      const files = ['layered.gef', 'clay-only.gef', 'layered.xlsx', 'layered.csv'];
      api.loadGEF({ target: { files: files.map(fixtureFile), value: '' } });
      await waitFor(() => api.PROJECT.cpts.length === 4 && api.PROJECT.cpts.every((p) => p.data.length > 0), { label: 'multi-file import', timeout: 20000 });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(api.PROJECT.activeCptIdx, 0);
      assert.equal(gctx.S(), api.PROJECT.cpts[0], 'S is the first (active) CPT');
      assert.deepEqual(api.PROJECT.sectionOrder, [0, 1, 2, 3]);
      for (let i = 0; i < files.length; i++) {
        const { cpt } = await importPure(files[i]);
        assert.deepStrictEqual(canon(pick(api.PROJECT.cpts[i])), canon(pick(cpt)), files[i]);
      }
      assert.deepEqual(c.alerts, []);
      assert.equal(c.importReviews.length, 4);
      const banner = htmlToText(doc.getElementById('cptTabs').innerHTML);
      for (const id of ['layered', 'clay-only']) assert.ok(banner.includes(id), `banner lists ${id}`);
      assert.ok(/cpt-tab active[^>]*data-cpt-index="0"/.test(doc.getElementById('cptTabs').innerHTML), 'first tab rendered active');
      // Stage 1 DOM was synced from each target in turn (the last file's values remain, as before the move)
      const last = api.PROJECT.cpts[3];
      const dom = stage1Dom();
      assert.equal(dom.wtN, last.wt.toFixed(2));
      assert.equal(dom.finfo, `${last.meta.fname} — ${last.meta.nRows} readings`);
      assert.equal(dom.s1body, 'block');
    });

    await checkAsync('multi-file loadGEF with a rejected file in the middle: alert, empty tab kept, later files still imported', async () => {
      await gctx.resetProject();
      c.alerts.length = 0;
      api.loadGEF({ target: { files: [fixtureFile('short.gef'), new File(['a;b;c\n1;2;3\n'], 'garbage.csv'), fixtureFile('qc-only.gef')], value: '' } });
      await waitFor(() => api.PROJECT.cpts.length === 3 && api.PROJECT.cpts[2].data.length > 0, { label: 'import with a bad file', timeout: 20000 });
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(c.alerts, ['Could not find depth/qc columns in the CSV file.']);
      assert.deepEqual(api.PROJECT.cpts.map((p) => [p.id, p.data.length]), [['short', 94], ['CPT-2', 0], ['qc-only', 360]]);
      assert.equal(api.PROJECT.activeCptIdx, 0);
      assert.equal(gctx.S(), api.PROJECT.cpts[0]);
    });

    await checkAsync('import into a non-first tab: the first file lands on the active CPT, the others append', async () => {
      await gctx.resetProject();
      api.loadGEF({ target: { files: [fixtureFile('layered.gef'), fixtureFile('clay-only.gef')], value: '' } });
      await waitFor(() => api.PROJECT.cpts.length === 2 && api.PROJECT.cpts[1].data.length > 0, { label: 'seed project', timeout: 20000 });
      api.selectCpt(1);
      c.alerts.length = 0;
      api.loadGEF({ target: { files: [fixtureFile('sand-only.gef'), fixtureFile('wt-at-surface.gef')], value: '' } });
      await waitFor(() => api.PROJECT.cpts.length === 3 && api.PROJECT.cpts[2].data.length > 0, { label: 'second import', timeout: 20000 });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(api.PROJECT.activeCptIdx, 1);
      assert.equal(gctx.S(), api.PROJECT.cpts[1]);
      assert.deepEqual(api.PROJECT.cpts.map((p) => p.id), ['layered', 'sand-only', 'wt-at-surface']);
      assert.deepStrictEqual(canon(pick(api.PROJECT.cpts[1])), canon(pick((await importPure('sand-only.gef')).cpt)));
      assert.deepStrictEqual(canon(pick(api.PROJECT.cpts[2])), canon(pick((await importPure('wt-at-surface.gef')).cpt)));
      assert.deepEqual(c.alerts, []);
    });

    await checkAsync('parseGEF / loadDemo wrappers: legacyApi names, seeded loadDemo == demoPatch(seeded), DOM synced', async () => {
      await gctx.resetProject();
      for (const n of ['loadGEF', 'loadDemo', 'parseGEF', 'updateElevSrc', 'updateWTDisplay', 'renderMeta', 'initCharts', 'setCptCoord']) assert.equal(typeof api[n], 'function', n);
      const real = Math.random;
      Math.random = mulberry32(manifest.seed);
      try { api.loadDemo(); } finally { Math.random = real; }
      const S = gctx.S();
      assert.deepStrictEqual(canon(pick(S)), demoGolden);
      const expected = freshCpt();
      Object.assign(expected, demoPatch(mulberry32(manifest.seed)));
      assert.deepStrictEqual(canon(S.data), canon(expected.data));
      const dom = stage1Dom();
      assert.equal(dom.wtR, 1.7); assert.equal(dom.wtN, '1.70'); assert.equal(dom.elevN, '69.97');
      assert.equal(dom['elev-src'], '(from demo)'); assert.equal(dom['wt-src'], '(demo)'); assert.equal(dom['wt-taw'], '= 68.27 m TAW');
      assert.equal(dom.finfo, 'demo-anonymous.GEF — 1080 readings');
      assert.ok(dom.mgrid.includes('Demo Project A'));
      assert.equal(dom.s1body, 'block');
      // parseGEF (legacyApi) still targets the active CPT and resolves true
      const ok = await api.parseGEF(readFileSync(join(FIXTURES, 'cpt/short.gef'), 'utf8'), 'short.gef');
      assert.equal(ok, true);
      assert.equal(S.meta.fname, 'short.gef');
      assert.equal(S.data.length, 94);
    });
  } finally {
    await gctx.close();
  }
}

// ------------------------------------------------------------------ 9. extraction complete
console.log('\n[9] extraction complete');
check('legacy-controller.js no longer declares the moved bodies and imports load/', () => {
  const src = readFileSync(join(ROOT, 'src/lib/cpt-app/legacy-controller.js'), 'utf8');
  for (const decl of ['function pad2(', 'function formatExcelHeaderValue(', 'function normalizeExcelLabel(', 'function excelHeaderLookup(',
    'function findExcelSheetName(', 'function loadXlsxModule(', 'let xlsxModulePromise', 'function splitDelimitedLine(', 'function parseDelimitedText(',
    'function detectDelimitedTextSeparator(', 'function stripCptFileExtension(', 'function isExcelCptFile(', 'function isCsvCptFile(',
    'const GEF_CHANNELS', "XLSX.read(buffer", "l.startsWith('#COLUMNINFO')", 'const prevS=S;', 'S=PROJECT.cpts[targetIdx];',
    "for(let z=0.14;z<=21.73;", "{l:'Area ratio a'", "document.getElementById('wtR').value=1.7;"]) {
    assert.ok(!src.includes(decl), `still contains ${decl}`);
  }
  assert.ok(src.includes("import { installLoadApp } from './load/index.js';"), 'load install import missing');
  assert.ok(/import \{ readCssToken \} from '\.\/core\/css-tokens\.js';\n\nimport \{ installLoadApp \} from '\.\/load\/index\.js';/.test(src), 'the load install is imported directly after the core/ imports');
  // PR 20 (composition root): the Stage 1 wrappers moved into installLoadApp(ctx). The controller
  // installs the package once and keeps the monolith names as bindings of that install, so the
  // inline `on*=` attributes and the Node verifiers still resolve them at module scope.
  assert.ok(/const loadApp = installLoadApp\(\{\n  document,\n  getProject: \(\) => PROJECT,\n  getActive: \(\) => S,\n  newCptState,/.test(src), 'installLoadApp(ctx) call missing');
  const loadBindings = src.slice(src.indexOf('} = loadApp;') - 1200, src.indexOf('} = loadApp;'));
  for (const name of ['importParsedCpt', 'applyParsedCptTo', 'applyParsedCpt', 'parseGEF', 'parseCsvCpt', 'parseExcelCpt',
    'importCptFiles', 'importGEFFiles', 'loadGEF', 'setCptCoord', 'updateElevSrc', 'updateWTDisplay', 'renderMeta',
    'setElev', 'setWT', 'updateWTLine', 'setAssumedRf', 'updateAssumedRfControls', 'cancelClassificationRefresh',
    'refreshClassificationDerivedViews', 'scheduleClassificationDerivedViews', 'setMinThk', 'setSmartMerge',
    'setSmartMergeSensitivity', 'arrMax', 'arrSafe', 'initCharts', 'refreshChartData', 'drawLayerColumnSvg',
    'renderLayerPreviewSvg', 'bindLayerPreviewTooltip', 'loadDemo', 'bindDropzone']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(loadBindings), `${name} is not bound from loadApp`);
    assert.ok(!new RegExp(`^(async )?function ${name}\\(`, 'm').test(src), `${name} is still declared in legacy-controller.js`);
  }
  // The bodies now live in the package, one file per concern.
  const pkg = (f) => readFileSync(join(ROOT, 'src/lib/cpt-app/load', f), 'utf8');
  const install = pkg('index.js');
  for (const w of ['importCptFilesSerially(files,{', 'async importParsedCpt(cpt, parsed){', 'applyParsedCptTo(cpt, parsed){',
    'applyParsedCpt(parsed){\n      return app.applyParsedCptTo(getActive(), parsed);', 'async parseGEF(txt,fname){\n      return cptFileImporters.gef(txt,fname,getActive());',
    'async parseCsvCpt(text,fname){\n      return cptFileImporters.csv(text,fname,getActive());', 'async parseExcelCpt(buffer,fname){\n      return cptFileImporters.excel(buffer,fname,getActive());',
    'updateElevSrc(){\n      renderElevationSource(document, getActive());', 'updateWTDisplay(){\n      renderWaterTableDisplay(document, getActive());',
    'updateAssumedRfControls(){\n      renderAssumedRfControls(document, getActive());', 'renderMeta(){\n      renderMetaCard(document, getActive());',
    'loadDemo(){\n      Object.assign(getActive(), demoPatch(Math.random));\n      syncDemoDom(document, getActive());\n      requestAnimationFrame(()=>app.initCharts());']) {
    assert.ok(install.includes(w), `load/index.js wrapper missing: ${w.split('\n')[0]}`);
  }
  assert.ok(pkg('raw-charts.js').includes('export function initCharts(document, cpt, {drawLayerColumn, again}){'), 'raw-charts.js owns initCharts');
  assert.ok(pkg('layer-svgs.js').includes('export function drawLayerColumnSvg(document, svgId, layers, maxZ, wt){'), 'layer-svgs.js owns drawLayerColumnSvg');
  assert.ok(pkg('dropzone.js').includes('export function bindDropzone(document, onFiles){'), 'dropzone.js owns bindDropzone');
  // PR 14 (step 8): the selectCpt / removeCpt reassignments moved behind setActive(idx)
  // (core/state.js setActiveCpt) — S is written at its declaration and there only.
  assert.equal((src.match(/\bS=PROJECT\.cpts\[/g) || []).length, 1, 'S is assigned from PROJECT.cpts only at its declaration');
  assert.equal((src.match(/\bS=setActiveCpt\(PROJECT, idx\);/g) || []).length, 1, 'S is re-pointed only in setActive(idx)');
  assert.ok(/^let S=PROJECT\.cpts\[0\];$/m.test(src), 'S declared as let S=PROJECT.cpts[0]');
  assert.equal((src.match(/^\s*S\s*=[^=]/gm) || []).length, 1, 'no other statement assigns S');
});
check('load/ modules carry the SPDX header and @ts-nocheck; parsers import no DOM module', () => {
  const dir = join(ROOT, 'src/lib/cpt-app/load');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(files, ['apply-parsed-cpt.js', 'controls.js', 'demo.js', 'dropzone.js', 'file-kind.js', 'import-files.js', 'index.js', 'layer-svgs.js', 'raw-charts.js']);
  const parsers = readdirSync(join(dir, 'parsers')).filter((f) => f.endsWith('.js')).sort();
  assert.deepEqual(parsers, ['csv.js', 'excel-headers.js', 'excel.js', 'gef.js']);
  for (const f of [...files.map((f) => join(dir, f)), ...parsers.map((f) => join(dir, 'parsers', f))]) {
    const text = readFileSync(f, 'utf8');
    const head = text.split('\n').slice(0, 2);
    assert.equal(head[0], '// SPDX-License-Identifier: AGPL-3.0-or-later', f);
    assert.equal(head[1], '// @ts-nocheck', f);
    if (f.includes('/parsers/') || /apply-parsed-cpt|demo|file-kind/.test(f)) {
      assert.ok(!/\bdocument\b|\bwindow\b|\bS\./.test(text.replace(/\/\/.*$/gm, '')), `${f} must not touch the DOM or S`);
      assert.ok(!text.includes('import-review/modal') && !text.includes('import-review/index'), `${f} must not import the dialog`);
    }
  }
  assert.ok(existsSync(join(dir, 'index.js')));
});

console.log(`\n${count - fails}/${count} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
