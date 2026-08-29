#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Generates every committed input fixture under tests/golden/fixtures/ (design §3) from a
// seeded PRNG (mulberry32, seed recorded per fixture in manifest.json) so the set can be
// regenerated bit-identically; the files are committed anyway so goldens never depend on
// this generator. Produces:
//   cpt/*.gef|csv|xlsx|state.json   synthetic CPT profiles (demo-shape copied from loadDemo()
//                                   bands, legacy-controller.js:1825-1836; layered / clay-only /
//                                   sand-only / wt-at-surface / short / qc-only /
//                                   trailing-qc-only / kpa-units / corrected-depth / CSV / XLSX)
//   projects/*.madep.json           saved projects built THROUGH the controller (Tier B) so they
//                                   are in the exact v0.5.3 format, savedAt fixed
//   models/*.json                   solver model fixtures copied from scripts/fixtures/
//   manifest.json                   name → sha256, role, seed, generator notes
// Run: npm run golden:fixtures   (also fetches Chart.js and pins the WASM hashes)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { mulberry32 } from './lib/prng.mjs';
import { writeGef, GEF_DEFAULT_COLUMNS } from './lib/gef-writer.mjs';
import { ROOT, GOLDEN, sha256Hex, stableJson } from './lib/store.mjs';

const SEED = 20260829;
const FX = join(GOLDEN, 'fixtures');
for (const d of ['cpt', 'projects', 'models']) mkdirSync(join(FX, d), { recursive: true });

const manifest = { seed: SEED, generator: 'scripts/golden/make-fixtures.mjs', prng: 'mulberry32', fixtures: {} };
const fixtureSeed = (name) => { let h = SEED; for (const ch of name) h = (Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0); return h >>> 0; };
const record = (rel, meta = {}) => { const bytes = readFileSync(join(FX, rel)); manifest.fixtures[rel] = { sha256: sha256Hex(bytes), bytes: bytes.length, ...meta }; };
const write = (rel, content, meta) => { writeFileSync(join(FX, rel), content); record(rel, meta); };

/* ── profile generators ─────────────────────────────────────────────────── */
const r4 = (v) => +v.toFixed(4), r6 = (v) => +v.toFixed(6), r3 = (v) => +v.toFixed(3);
function bandedRows({ bands, zStart, zEnd, dz, rnd, u2 = null, wt = 1.7 }) {
  const rows = [];
  for (let z = zStart; z <= zEnd + 1e-9; z = +(z + dz).toFixed(3)) {
    const b = bands.find((x) => z < x.to) || bands[bands.length - 1];
    const qc = b.qc[0] + rnd() * (b.qc[1] - b.qc[0]);
    const rf = b.rf[0] + rnd() * (b.rf[1] - b.rf[0]);
    const fs = qc * rf / 100;
    const row = { z: r3(z), qc: r4(qc), fs: r6(fs), rf: r3(rf), u2: null };
    if (u2) row.u2 = r4(Math.max(0, 0.00981 * (z - wt)) * (1 + (b.excess || 0)) + rnd() * 0.002);
    rows.push(row);
  }
  return rows;
}

// The demo profile: exactly loadDemo()'s bands and loop (legacy-controller.js:1823-1836).
function demoRows(rnd) {
  const rows = [];
  for (let z = 0.14; z <= 21.73; z = +(z + 0.02).toFixed(3)) {
    let qc, rf;
    if (z < 0.6) { qc = 0.15 + rnd() * 0.12; rf = 0.7 + rnd() * 0.4; }
    else if (z < 1.5) { qc = 3 + rnd() * 2.5; rf = 0.5 + rnd() * 0.4; }
    else if (z < 3.0) { qc = 7 + rnd() * 3; rf = 0.8 + rnd() * 0.7; }
    else if (z < 5.5) { qc = 1.2 + rnd() * 1; rf = 4 + rnd() * 3; }
    else if (z < 7.0) { qc = 1.5 + rnd() * 0.8; rf = 3.5 + rnd() * 2; }
    else if (z < 9.5) { qc = 4 + rnd() * 4; rf = 1.2 + rnd() * 0.8; }
    else if (z < 11) { qc = 2 + rnd() * 1; rf = 3 + rnd() * 2; }
    else { qc = 3.5 + rnd() * 5; rf = 1.5 + rnd() * 2; }
    const fs = qc * rf / 100;
    rows.push({ z, qc: +qc.toFixed(4), fs: +fs.toFixed(6), rf: +rf.toFixed(3), u2: null });
  }
  return rows;
}

const LAYERED_BANDS = [
  { to: 1.0, qc: [1.5, 3.0], rf: [1.5, 2.5] },          // fill
  { to: 4.0, qc: [8, 14], rf: [0.5, 1.0] },             // sand
  { to: 8.0, qc: [0.6, 1.2], rf: [3.5, 5.5], excess: 0.4 },   // clay
  { to: 11.0, qc: [1.5, 3.0], rf: [2.0, 3.2], excess: 0.15 }, // sandy clay
  { to: 15.0, qc: [12, 22], rf: [0.4, 0.9] },           // sand
  { to: 18.0, qc: [1.0, 1.8], rf: [3.0, 4.5], excess: 0.4 }   // clay
];
const HDR = { project: 'Golden Project', testid: 'S1', date: '2026, 1, 15', owner: 'MADEP golden', location: 'Golden site', wt: 1.7, zid: 10.0, aRatio: 0.8 };
const U2_COL = { qid: 6, unit: 'MPa', desc: 'Waterspanning u2', key: 'u2', dec: 4 };

const profiles = {};
profiles.layered = bandedRows({ bands: LAYERED_BANDS, zStart: 0.05, zEnd: 18.0, dz: 0.05, rnd: mulberry32(fixtureSeed('layered')), u2: true });
profiles['clay-only'] = bandedRows({ bands: [{ to: 99, qc: [0.4, 1.5], rf: [3, 6] }], zStart: 0.05, zEnd: 12.0, dz: 0.05, rnd: mulberry32(fixtureSeed('clay-only')), wt: 1.0 });
profiles['sand-only'] = bandedRows({ bands: [{ to: 99, qc: [8, 30], rf: [0.4, 1.2] }], zStart: 0.05, zEnd: 15.0, dz: 0.05, rnd: mulberry32(fixtureSeed('sand-only')), wt: 2.5 });
{
  // 2.0 m push, 0.02 m step; the first 6 readings have qc < 0.02 (cone not engaged) and are skipped by the parser.
  const rnd = mulberry32(fixtureSeed('short'));
  const rows = bandedRows({ bands: [{ to: 99, qc: [2, 5], rf: [1, 2] }], zStart: 0.02, zEnd: 2.0, dz: 0.02, rnd });
  rows.slice(0, 6).forEach((r) => { r.qc = 0.01; r.fs = 0.0001; r.rf = 1.0; });
  profiles.short = rows;
}
profiles['demo-anonymous'] = demoRows(mulberry32(SEED));

/* ── GEF files ──────────────────────────────────────────────────────────── */
const COLS_U2 = [...GEF_DEFAULT_COLUMNS, U2_COL];
const gef = (name, rows, header, columns, meta) => write(`cpt/${name}.gef`, writeGef({ rows, header, columns }), { role: 'profile', seed: fixtureSeed(name), ...meta });

gef('layered', profiles.layered, HDR, COLS_U2, { note: '6 layers 0–18 m, u2 column (quantity 6)' });
gef('clay-only', profiles['clay-only'], { ...HDR, testid: 'S2-CLAY', wt: 1.0, zid: 5.2 }, GEF_DEFAULT_COLUMNS, { note: 'qc 0.4–1.5 MPa, Rf 3–6 %, 0–12 m' });
gef('sand-only', profiles['sand-only'], { ...HDR, testid: 'S3-SAND', wt: 2.5, zid: 12.5 }, GEF_DEFAULT_COLUMNS, { note: 'qc 8–30 MPa, Rf 0.4–1.2 %, 0–15 m' });
gef('wt-at-surface', profiles.layered, { ...HDR, testid: 'S1-WT0', wt: 0.0 }, COLS_U2, { note: 'layered with MEASUREMENTVAR 14 = 0.0' });
gef('short', profiles.short, { ...HDR, testid: 'S4-SHORT', wt: 0.8, zid: 8.1 }, GEF_DEFAULT_COLUMNS, { note: '2.0 m at 0.02 m; first 6 readings qc < 0.02 skipped' });
gef('qc-only', profiles.layered.map((r) => ({ z: r.z, qc: r.qc })), { ...HDR, testid: 'S1-QC' }, GEF_DEFAULT_COLUMNS.slice(0, 2), { note: 'layered without COLUMNINFO 3/4' });
{
  // trailing rows carry only depth + qc (fewer columns → fs/Rf null in the parser, :1405-1409)
  const rows = profiles.layered;
  const text = writeGef({ rows: rows.slice(0, -3), header: { ...HDR, testid: 'S1-TRAIL' }, columns: GEF_DEFAULT_COLUMNS })
    + rows.slice(-3).map((r) => `${r.z.toFixed(3)} ${r.qc.toFixed(4)}\r\n`).join('');
  write('cpt/trailing-qc-only.gef', text, { role: 'profile', seed: fixtureSeed('layered'), note: 'layered; last 3 rows lack fs/Rf' });
}
gef('kpa-units', profiles.layered, { ...HDR, testid: 'S1-KPA' }, [
  GEF_DEFAULT_COLUMNS[0],
  { ...GEF_DEFAULT_COLUMNS[1], unit: 'kPa', dec: 1, scale: 1000 },
  { ...GEF_DEFAULT_COLUMNS[2], unit: 'kPa', dec: 3, scale: 1000 },
  GEF_DEFAULT_COLUMNS[3]
], { role: 'import', note: 'layered with qc/fs declared in kPa' });
gef('corrected-depth', profiles.layered, { ...HDR, testid: 'S1-CORR' }, [
  { qid: 1, unit: 'm', desc: 'Sondeerlengte', key: 'zPen', dec: 3 },
  ...GEF_DEFAULT_COLUMNS.slice(1),
  { qid: 11, unit: 'm', desc: 'Gecorrigeerde diepte', key: 'z', dec: 3 }
].map((c) => c), { role: 'import', note: 'quantity 11 (corrected) and 1 (penetration length = z + 0.05): parser must prefer 11' });
// corrected-depth needs the zPen field on the rows:
{
  const rows = profiles.layered.map((r) => ({ ...r, zPen: r3(r.z + 0.05) }));
  const cols = [{ qid: 1, unit: 'm', desc: 'Sondeerlengte', key: 'zPen', dec: 3 }, ...GEF_DEFAULT_COLUMNS.slice(1), { qid: 11, unit: 'm', desc: 'Gecorrigeerde diepte', key: 'z', dec: 3 }];
  write('cpt/corrected-depth.gef', writeGef({ rows, header: { ...HDR, testid: 'S1-CORR' }, columns: cols }), { role: 'import', seed: fixtureSeed('layered'), note: 'quantity 11 (corrected) and 1 (penetration length = z + 0.05): parser must prefer 11' });
}
gef('demo-anonymous', profiles['demo-anonymous'], { project: 'Demo Project A', testid: 'CPT-1 (demo)', date: '2025, 7, 7', owner: 'Anonymous source', location: 'Reference site — anonymised', wt: 1.7, zid: 69.97, aRatio: 0.79 }, GEF_DEFAULT_COLUMNS.map((c) => c.key === 'z' ? { ...c, dec: 3 } : c), { seed: SEED, note: 'loadDemo() bands with Math.random = mulberry32(seed); 1080 rows' });
manifest.fixtures['cpt/kpa-units.gef'].role = 'import';

/* ── CSV / XLSX ─────────────────────────────────────────────────────────── */
write('cpt/layered.csv', 'depth,qc,fs\n' + profiles.layered.map((r) => `${r.z.toFixed(3)},${r.qc.toFixed(4)},${r.fs.toFixed(6)}`).join('\n') + '\n', { role: 'import', seed: fixtureSeed('layered'), note: 'README format depth,qc,fs (m, MPa, MPa)' });
write('cpt/layered-comma.csv', 'Diepte (m);qc (MPa);fs (kPa);Rf (%)\n' + profiles.layered.map((r) => `${r.z.toFixed(3).replace('.', ',')};${r.qc.toFixed(4).replace('.', ',')};${(r.fs * 1000).toFixed(3).replace('.', ',')};${r.rf.toFixed(3).replace('.', ',')}`).join('\r\n') + '\r\n', { role: 'import', seed: fixtureSeed('layered'), note: 'semicolon-separated, comma decimals, fs in kPa, CRLF' });
{
  const XLSX = (await import('xlsx')).default;
  const wb = XLSX.utils.book_new();
  const data = [['Depth (m)', 'qc (MPa)', 'fs (MPa)', 'Rf (%)'], ...profiles.layered.map((r) => [r.z, r.qc, r.fs, r.rf])];
  const header = [['Taak Nummer', 'Golden Project'], ['Sondering Nummer', 'S1-XLSX'], ['Client Naam', 'MADEP golden'], ['Operator', 'golden-bot'], ['Locatie', 'Golden site'], ['Datum', '2026-01-15'], ['Waterniveau', 1.7], ['Grondniveau', 10.0], ['E Coordinate', 150000], ['N Coordinate', 200000], ['Alpha Factor', 0.8], ['Conus Nummer', 'C-42'], ['Penetratiediepte', 18.0]];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), 'Data');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(header), 'Header');
  wb.Props = { Title: 'layered', Author: 'golden', CreatedDate: new Date('2026-01-01T00:00:00Z'), ModifiedDate: new Date('2026-01-01T00:00:00Z') };
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: false });
  write('cpt/layered.xlsx', buf, { role: 'import', seed: fixtureSeed('layered'), note: 'Data + Header sheets (xlsx dependency)' });
}
write('cpt/wt-above-surface.state.json', stableJson({ base: 'layered.gef', inject: { wt: -0.5, wtFromFile: false, wtSource: null } }), { role: 'profile', base: 'layered.gef', inject: { wt: -0.5, wtFromFile: false, wtSource: null }, note: 'F11: water table above surface is only reachable by state injection' });

/* ── solver models (copied, not invented) ───────────────────────────────── */
for (const f of readdirSync(join(ROOT, 'scripts/fixtures/bishop-phase-a')).filter((n) => n.endsWith('.json')).sort()) {
  copyFileSync(join(ROOT, 'scripts/fixtures/bishop-phase-a', f), join(FX, 'models', `bishop-${f}`));
  record(`models/bishop-${f}`, { role: 'aux', source: `scripts/fixtures/bishop-phase-a/${f}` });
}
for (const f of readdirSync(join(ROOT, 'scripts/fixtures')).filter((n) => n.endsWith('.json')).sort()) {
  copyFileSync(join(ROOT, 'scripts/fixtures', f), join(FX, 'models', f));
  record(`models/${f}`, { role: 'aux', source: `scripts/fixtures/${f}` });
}
// seepage / deformation / HS models lifted from the verify scripts as pure functions of
// constants (lib/solver-models.mjs) — serialised so the solver suites read committed JSON
{
  const { MODELS } = await import('./lib/solver-models.mjs');
  for (const [name, { model, source, note }] of Object.entries(MODELS)) {
    write(`models/${name}.json`, stableJson(model), { role: 'aux', source, note });
  }
}

/* ── manifest (first pass: CPT fixtures) so the controller context can load them ── */
writeFileSync(join(FX, 'manifest.json'), stableJson(sortManifest(manifest)));

/* ── project fixtures through the controller (Tier B) ───────────────────── */
const { makeContext } = await import('./lib/context.mjs');
const { buildProjectSnapshot } = await import('../../src/lib/cpt-app/project-io/snapshot.js');
const { createStratigraphyStore } = await import('../../src/lib/cpt-app/stratigraphy/store.js');
const ctx = await makeContext();
const { api } = await ctx.controller();
const SAVED_AT = '2026-01-01T00:00:00.000Z';
const APP_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const projectJson = (snapshot) => JSON.stringify(snapshot, null, 1) + '\n';   // saveProject() layout (project-io/index.js:44)

// single-layered: layered.gef through Stages 2–6 (bearing + pile + settlement configured,
// retwall soldierpile with one override), one accepted tuning fit, one manual subtype edit.
{
  const S = await ctx.classify('layered', 'sb260');
  api.goS(2);
  api.changeSubtype({ dataset: { i: '2' }, value: 'klei, vast' });
  api.goS(3); api.goS(4); api.runTuning(); api.acceptFit(1);
  api.goS(5);
  Object.assign(S.stage6.bearing, { B: 2.0, L: 4.0, load: 220, Df: 1.5 });
  Object.assign(S.stage6.pile, { Ds: 0.5, Db: 0.5, zToe: 12.0, Fcd: 900 });
  Object.assign(S.stage6.settlement, { B: 3.0, L: 3.0, Gk: 200, QLead: 60 });
  for (const app of ['bearing', 'pile', 'settlement']) api.setStage6App(app);
  S.stage6.retwall.wallType = 'soldierpile';
  S.stage6.retwall.embedded.retainedHeight = 3.0;
  S.stage6.retwall.profile.overrides = { 'Clay:4.00-8.00#2': { c: 0.5, drained: true } };
  api.ensureStage6State();
  S.stage6.app = 'bearing';
  const snapshot = buildProjectSnapshot(api.PROJECT, { activeStage: 5, savedAt: SAVED_AT, appVersion: APP_VERSION });
  write('projects/single-layered.madep.json', projectJson(snapshot), { role: 'project', note: 'layered.gef through Stages 2–6 via the controller; savedAt fixed' });
}

// multi-3cpt: layered / sand-only / clay-only at 30 m spacing, elevation offsets 0 / +0.4 / −0.3,
// phase 'correlation' with the stratigraphy correlated and one manual unit rename.
{
  await ctx.resetProject();
  const cfg = [['layered', 0, 10.0], ['sand-only', 30, 10.4], ['clay-only', 60, 9.7]];
  for (let i = 0; i < cfg.length; i++) {
    const [name, x, elev] = cfg[i];
    if (i > 0) api.addCpt();
    const S = await ctx.importCpt(name);
    S.x = x; S.y = 0; S.elev = elev; S.elevFromFile = false; S.elevSource = null;
    S.method = 'robertson2016';
    api.runClass();
  }
  api.selectCpt(0);
  api.setPhase('correlation');    // stratigraphyApp.render() → store.ensureRun() (stratigraphy/index.js:100)
  const store = createStratigraphyStore({ getProject: () => api.PROJECT, layerParamsFor: null });
  store.renameUnit(api.PROJECT.stratigraphy.result.units[0].id, 'Quartair zand');
  api.PROJECT.name = 'Golden multi-CPT';
  const snapshot = buildProjectSnapshot(api.PROJECT, { activeStage: 2, savedAt: SAVED_AT, appVersion: APP_VERSION });
  write('projects/multi-3cpt.madep.json', projectJson(snapshot), { role: 'project', note: '3 CPTs, correlated stratigraphy with one manual rename, phase correlation' });

  // legacy-v0.5.2: same project with the keys that were added after v0.5.2 removed, to lock
  // the forward-compat merge (snapshot.js:74-85, wall-state.js:84 ensure, store.js:37).
  const legacy = JSON.parse(JSON.stringify(snapshot));
  legacy.appVersion = '0.5.2';
  for (const cpt of legacy.project.cpts) {
    delete cpt.stage6.retwall.drivability;
    delete cpt.stage6.retwall.vibration;
    delete cpt.stage6.bishop.deformation.options.useWallInterface;
    delete cpt.assumedRf;
    delete cpt.smartMergeSensitivity;
  }
  delete legacy.project.stratigraphy.settings.characteristic;
  write('projects/legacy-v0.5.2.madep.json', projectJson(legacy), { role: 'project', note: 'multi-3cpt with post-0.5.2 keys removed (retwall.drivability/vibration, deformation.options.useWallInterface, assumedRf, smartMergeSensitivity, stratigraphy.settings.characteristic)' });
}
await ctx.close();

/* ── final manifest ─────────────────────────────────────────────────────── */
const prev = existsSync(join(FX, 'manifest.json')) ? JSON.parse(readFileSync(join(FX, 'manifest.json'), 'utf8')) : {};
if (prev.vendor) manifest.vendor = prev.vendor;
writeFileSync(join(FX, 'manifest.json'), stableJson(sortManifest(manifest)));
console.log(`fixtures written: ${Object.keys(manifest.fixtures).length} files → tests/golden/fixtures/`);

function sortManifest(m) {
  const sorted = {};
  for (const k of Object.keys(m.fixtures).sort()) sorted[k] = m.fixtures[k];
  return { ...m, fixtures: sorted };
}
