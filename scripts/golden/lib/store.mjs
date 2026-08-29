// SPDX-License-Identifier: AGPL-3.0-or-later
// Golden file store: paths, stable JSON serialisation, read/write of goldens under
// tests/golden/, the git-ignored .actual/ mirror written on mismatch, and directory
// walking for the MISSING check (a golden on disk that no suite produces any more).
// Design: worklog/refactor/03-characterization-tests.md §4.1.
//
// Serialisation: keys are already sorted by normalize(); nesting is pretty-printed
// with 2-space indent, but arrays of *flat* values (rows of primitives, short numeric
// vectors) are written one element per line so a 1000-row CPT table stays diffable
// AND compact. JSON.parse() of the file is unaffected by the layout.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const GOLDEN = resolve(ROOT, 'tests/golden');
export const ACTUAL = resolve(GOLDEN, '.actual');

const isPrim = (v) => v === null || typeof v !== 'object';
const isFlat = (v) => isPrim(v) || (Array.isArray(v) ? v.every(isPrim) : Object.values(v).every(isPrim));

function ser(v, indent) {
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    const inner = indent + '  ';
    if (v.every(isPrim)) {
      const one = JSON.stringify(v);
      if (one.length <= 100) return one;
      // long vectors: several values per line (≈100 chars) — compact, still line-diffable
      const lines = []; let cur = '';
      for (const x of v) { const t = JSON.stringify(x); if (cur && cur.length + t.length + 2 > 100) { lines.push(cur); cur = ''; } cur += (cur ? ', ' : '') + t; }
      if (cur) lines.push(cur);
      return '[\n' + lines.map((l) => inner + l).join(',\n') + '\n' + indent + ']';
    }
    if (v.every(isFlat)) return '[\n' + v.map((x) => inner + JSON.stringify(x)).join(',\n') + '\n' + indent + ']';
    return '[\n' + v.map((x) => inner + ser(x, inner)).join(',\n') + '\n' + indent + ']';
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    const inner = indent + '  ';
    return '{\n' + keys.map((k) => `${inner}${JSON.stringify(k)}: ${ser(v[k], inner)}`).join(',\n') + '\n' + indent + '}';
  }
  return JSON.stringify(v);
}

/** Stable JSON text with a trailing newline (see header for the layout rule). */
export const stableJson = (v) => ser(v, '') + '\n';

export function readGolden(rel) {
  const p = join(GOLDEN, rel);
  if (!existsSync(p)) return undefined;
  const text = readFileSync(p, 'utf8');
  return rel.endsWith('.json') ? JSON.parse(text) : text;
}

export function writeGolden(rel, v) {
  const p = join(GOLDEN, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof v === 'string' ? v : stableJson(v));
  return p;
}

export function writeActual(rel, v) {
  return writeGolden(join('.actual', rel), v);
}

export function clearActual() {
  rmSync(ACTUAL, { recursive: true, force: true });
}

/** Relative paths (POSIX separators) of every file below tests/golden/<prefix>. */
export function listGoldens(prefix) {
  const base = join(GOLDEN, prefix);
  if (!existsSync(base)) return [];
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(GOLDEN, p).split('\\').join('/'));
    }
  };
  walk(base);
  return out;
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
