#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verification of the tabular CPT import core (import-review module):
//   - header-row and column auto-detection (EN/NL labels)
//   - unit conversion from column labels (MPa/kPa) and magnitude fallbacks
//   - tolerant number parsing (comma decimals)
//   - row building parity with the historical Excel/CSV import loop
//   - skip reasons (non-numeric, cone-not-engaged)
//   - data-quality summary: trailing fs/Rf gap detection (the 2306609_S1.xls
//     case: final reading carries qc only)
//   - column remapping re-derivation

import {
  buildRowsFromGrid,
  columnSamples,
  detectColumns,
  findDataHeaderRow,
  parseCptNumber,
  cptValueToMPa,
  summarizeRows
} from '../src/lib/cpt-app/import-review/tabular.js';

let failures = 0;
function check(label, ok, detail = '') {
  if (ok) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n[1] number parsing');
check('plain', parseCptNumber('1.25') === 1.25);
check('comma decimal', parseCptNumber('1,25') === 1.25);
check('thousands + comma decimal', parseCptNumber('1.234,5') === 1234.5);
check('blank → null', parseCptNumber('  ') === null);
check('non-numeric → null', parseCptNumber('n/a') === null);
check('number passthrough', parseCptNumber(3.7) === 3.7);

console.log('\n[2] unit conversion');
check('label MPa passthrough', cptValueToMPa(12, 'Cone resistance (qc) in MPa', 'qc') === 12);
const near = (a, b) => Math.abs(a - b) < 1e-12;
check('label kPa → MPa', near(cptValueToMPa(64.1, 'Sleeve friction (fs) in kPa', 'fs'), 0.0641));
check('qc magnitude fallback (kPa-like)', near(cptValueToMPa(12000, 'qc', 'qc'), 12));
check('fs magnitude fallback (kPa-like)', near(cptValueToMPa(64.1, 'fs', 'fs'), 0.0641));

// Grid mirroring the structure of 2306609_S1.xls: header row with units in
// the labels, a pre-push zero reading, and a final reading with qc only.
const GRID = [
  ['Depth [m]', 'Cone resistance (qc) in MPa', 'Sleeve friction (fs) in MPa', 'Friction ratio (Rf) in %', 'Opmerking'],
  [0, -0.001, 0, 0, null],
  [0.1, 0.603, 0.0098, 1.68, null],
  [0.2, 0.717, 0.0206, 2.35, 'x'],
  [0.3, 3.654, 0.0465, 1.63, null],
  [0.4, '5,529', '0.0386', 0.8, null], // comma/string cells still parse
  [21.9, 43.7054, null, null, null] // trailing reading: qc only
];

console.log('\n[3] detection');
check('header row found', findDataHeaderRow(GRID) === 0);
const cols = detectColumns(GRID[0]);
check('columns detected', cols.z === 0 && cols.qc === 1 && cols.fs === 2 && cols.rf === 3, JSON.stringify(cols));
check('samples skip blanks', columnSamples(GRID, 0, 2, 2).join(',') === '0,0.0098');

console.log('\n[4] row building (parity with historical import loop)');
const { rows, skipped } = buildRowsFromGrid(GRID, 0, cols);
check('5 readings built', rows.length === 5, `got ${rows.length}`);
check('pre-push zero reading skipped', skipped.length === 1 && skipped[0].reason.includes('qc'), JSON.stringify(skipped));
check('comma-decimal row parsed', rows.some((r) => r.z === 0.4 && r.qc === 5.529));
check('Rf preferred from Rf column', rows.find((r) => r.z === 0.1).rf === 1.68);
const last = rows[rows.length - 1];
check('trailing reading kept with qc only', last.z === 21.9 && last.fs == null && last.rf == null);

console.log('\n[5] data-quality summary — the "1 van N" case');
const summary = summarizeRows(rows);
check('one reading without fs/Rf', summary.missingFsRfCount === 1);
check('fs measured on the rest', summary.fsCount === 4 && summary.rfCount === 4);
check('gap recognised as trailing-only', summary.missingOnlyTrailing === true);
check('gap depth reported', summary.missingFsRfDepths[0] === 21.9);

// Realistic profile size (252 readings, 1 trailing gap, the screenshot case):
// the share must fall in the quiet-note tier of the Stage 2 presentation.
const bigGrid = [GRID[0]];
for (let i = 1; i <= 252; i++) {
  const z = +(i * 0.1).toFixed(1);
  bigGrid.push(i === 252 ? [z, 43.7, null, null, null] : [z, 5 + (i % 7), 0.05, 1.5, null]);
}
const bigSummary = summarizeRows(buildRowsFromGrid(bigGrid, 0, cols).rows);
check('1 of 252 without fs/Rf', bigSummary.missingFsRfCount === 1 && bigSummary.n === 252);
check('share lands in quiet-note tier (< 5%)', bigSummary.missingFsRfCount / bigSummary.n < 0.05);
check('trailing-only on realistic profile', bigSummary.missingOnlyTrailing === true);

console.log('\n[6] interior gap is NOT trailing');
const gappy = [
  { z: 1, qc: 5, fs: 0.05, rf: 1, u2: null },
  { z: 2, qc: 5, fs: null, rf: null, u2: null },
  { z: 3, qc: 5, fs: 0.05, rf: 1, u2: null }
];
check('interior gap flagged as non-trailing', summarizeRows(gappy).missingOnlyTrailing === false);

console.log('\n[7] column remapping re-derives');
// Swap fs to the "Opmerking" column: fs becomes unparseable → fewer fs rows.
const remapped = buildRowsFromGrid(GRID, 0, { ...cols, fs: 4 });
const remapSummary = summarizeRows(remapped.rows);
check('remap changes fs coverage', remapSummary.fsCount === 0, `got ${remapSummary.fsCount}`);
check('Rf column still carries Rf', remapSummary.rfCount === 4);
check('depth/qc unaffected by remap', remapped.rows.length === rows.length);

console.log('\n[8] no-fs file (qc-only) summary');
const qcOnly = buildRowsFromGrid(
  [['Diepte', 'Conusweerstand qc'], [0.1, 1.2], [0.2, 1.4]],
  0,
  detectColumns(['Diepte', 'Conusweerstand qc'])
);
const qcOnlySummary = summarizeRows(qcOnly.rows);
check('NL headers detected', qcOnly.rows.length === 2);
check('zero fs/Rf coverage flagged', qcOnlySummary.fsCount === 0 && qcOnlySummary.missingFsRfCount === 2);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll import-review checks passed.');
process.exit(failures ? 1 : 0);
