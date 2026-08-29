// SPDX-License-Identifier: AGPL-3.0-or-later
// One runner, two modes (design §4.3): `record` writes every case, `check` compares
// against tests/golden/node/** with the suite's tolerance class, reports PASS/FAIL/NEW/
// MISSING per suite (MISSING = golden on disk no suite produces any more — a silently
// dropped output during extraction), writes the normalised actual of every mismatch to
// tests/golden/.actual/ for `git diff --no-index`, and with --update rewrites only the
// failing/new cases. Exit 1 on any FAIL/NEW/MISSING unless --update.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as suites from '../suites/index.mjs';
import { GOLDEN, listGoldens, readGolden, writeActual, writeGolden, clearActual } from './store.mjs';
import { normalize, normalizeText } from './normalize.mjs';
import { compare, formatDiffs, textDiff } from './compare.mjs';
import { makeContext } from './context.mjs';

export const SUITES = Object.values(suites);

export function globToRegExp(glob) {
  return new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
}

function matches(filter, suiteName, id) {
  if (!filter) return true;
  const re = globToRegExp(filter);
  return re.test(suiteName) || re.test(`${suiteName}/${id}`) || (id === undefined && filter.startsWith(suiteName + '/'));
}

export async function run({ mode, filter, update = false, list = false }) {
  if (list) {
    for (const s of SUITES) console.log(`${s.name.padEnd(20)} tolerance=${s.tolerance}  ${s.description || ''}`);
    return 0;
  }
  const tol = JSON.parse(readFileSync(join(GOLDEN, 'tolerances.json'), 'utf8'));
  const ctx = await makeContext();
  if (mode === 'check' && !filter) clearActual();
  const summary = {};
  let failed = 0;
  const t0all = Date.now();
  for (const suite of SUITES) {
    if (!matches(filter, suite.name)) continue;
    const t0 = Date.now();
    const seen = new Set();
    const s = (summary[suite.name] = { pass: 0, fail: 0, new: 0, missing: 0, ms: 0 });
    const tolerance = tol[suite.tolerance || 'pure'];
    if (!tolerance) throw new Error(`suite ${suite.name}: unknown tolerance class ${suite.tolerance}`);
    for await (const c of suite.cases(ctx)) {
      const { id, value, kind = 'json' } = c;
      if (filter && !matches(filter, suite.name, id)) continue;
      const rel = `node/${suite.name}/${id}.${kind}`;
      const actual = kind === 'json' ? normalize(value) : normalizeText(value);
      seen.add(rel);
      if (mode === 'record') { writeGolden(rel, actual); s.pass++; continue; }
      const expected = readGolden(rel);
      if (expected === undefined) {
        s.new++;
        if (update) { writeGolden(rel, actual); console.log(`NEW   ${rel} (written)`); }
        else { failed++; writeActual(rel, actual); console.log(`NEW   ${rel} (no golden yet — record or --update)`); }
        continue;
      }
      const diffs = kind === 'json' ? compare(expected, actual, tolerance) : textDiff(expected, actual);
      if (!diffs.length) { s.pass++; continue; }
      s.fail++;
      writeActual(rel, actual);
      console.log(`FAIL  ${rel}\n${formatDiffs(diffs)}`);
      if (update) { writeGolden(rel, actual); console.log('      updated'); } else failed++;
    }
    if (!filter || matches(filter, suite.name)) {
      for (const rel of listGoldens(`node/${suite.name}`)) {
        if (seen.has(rel)) continue;
        if (filter && !matches(filter, suite.name, rel.replace(`node/${suite.name}/`, '').replace(/\.[a-z]+$/, ''))) continue;
        s.missing++;
        if (mode === 'record' || update) { console.log(`STALE ${rel} (golden exists, no longer produced — delete it)`); }
        else { failed++; console.log(`MISSING ${rel} (golden exists, no longer produced)`); }
      }
    }
    s.ms = Date.now() - t0;
  }
  await ctx.close();
  printTable(summary, Date.now() - t0all);
  return failed && !update ? 1 : 0;
}

function printTable(summary, totalMs) {
  const rows = Object.entries(summary);
  const w = Math.max(10, ...rows.map(([k]) => k.length));
  console.log('\n' + 'suite'.padEnd(w) + '   pass   fail    new  missing      ms');
  let tot = { pass: 0, fail: 0, new: 0, missing: 0 };
  for (const [k, s] of rows) {
    console.log(`${k.padEnd(w)} ${String(s.pass).padStart(6)} ${String(s.fail).padStart(6)} ${String(s.new).padStart(6)} ${String(s.missing).padStart(8)} ${String(s.ms).padStart(7)}`);
    for (const f of Object.keys(tot)) tot[f] += s[f];
  }
  console.log(`${'total'.padEnd(w)} ${String(tot.pass).padStart(6)} ${String(tot.fail).padStart(6)} ${String(tot.new).padStart(6)} ${String(tot.missing).padStart(8)} ${String(totalMs).padStart(7)}`);
}

export function parseArgs(argv) {
  const out = { filter: null, update: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') out.update = true;
    else if (a === '--list') out.list = true;
    else if (a === '--filter') out.filter = argv[++i];
    else if (a.startsWith('--filter=')) out.filter = a.slice(9);
    else if (!a.startsWith('-')) out.filter = a;
  }
  return out;
}
