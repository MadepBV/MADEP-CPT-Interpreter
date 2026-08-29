#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Pins the SHA-256 of the committed WASM binaries (static/wasm/**/*.wasm) in
// tests/golden/wasm.sha256.json (design §2.4). `--write` records, `--check` (default)
// fails when a binary changed without the pin being updated — this is what makes
// "1e-6 across WASM" an honest tolerance: the same engine is under test everywhere.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, sha256Hex, writeGolden, readGolden } from './lib/store.mjs';

const write = process.argv.includes('--write');
const base = join(ROOT, 'static/wasm');
const hashes = {};
for (const dir of readdirSync(base).sort()) {
  const d = join(base, dir);
  if (!statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d).sort()) {
    if (!/\.(wasm|js)$/.test(f)) continue;
    const p = join(d, f);
    hashes[relative(ROOT, p).split('\\').join('/')] = { sha256: sha256Hex(readFileSync(p)), bytes: statSync(p).size };
  }
}
if (write) {
  writeGolden('wasm.sha256.json', hashes);
  console.log(`wrote tests/golden/wasm.sha256.json (${Object.keys(hashes).length} files)`);
  process.exit(0);
}
const pinned = readGolden('wasm.sha256.json');
if (!pinned) { console.error('tests/golden/wasm.sha256.json missing — run `node scripts/golden/wasm-hash.mjs --write`'); process.exit(1); }
let bad = 0;
for (const k of new Set([...Object.keys(pinned), ...Object.keys(hashes)])) {
  const a = pinned[k]?.sha256, b = hashes[k]?.sha256;
  if (a !== b) { bad++; console.error(`WASM CHANGED ${k}: pinned ${a ?? '<none>'} → on disk ${b ?? '<none>'}`); }
}
console.log(bad ? `${bad} WASM artefact(s) differ from the pin` : `WASM pins OK (${Object.keys(hashes).length} files)`);
process.exit(bad ? 1 : 0);
