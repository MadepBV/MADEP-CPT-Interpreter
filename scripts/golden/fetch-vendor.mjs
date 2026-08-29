#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Downloads Chart.js once from the exact CDN URL the app loads
// (src/routes/+page.svelte:66, Chart.js 4.4.1) into tests/golden/vendor/chart.umd.js so
// the browser tier can `page.route` the CDN to a local, committed copy (finding F4) and
// CI runs offline. Records the sha256 in fixtures/manifest.json when present. Skips the
// download when the file already exists (pass --force to refresh).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOLDEN, ROOT, sha256Hex, stableJson } from './lib/store.mjs';

const page = readFileSync(join(ROOT, 'src/routes/+page.svelte'), 'utf8');
const m = page.match(/<script src="(https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/[^"]+)"/);
if (!m) { console.error('Chart.js CDN <script> not found in src/routes/+page.svelte'); process.exit(1); }
const url = m[1];
const out = join(GOLDEN, 'vendor/chart.umd.js');
mkdirSync(join(GOLDEN, 'vendor'), { recursive: true });
if (existsSync(out) && !process.argv.includes('--force')) {
  console.log(`vendor/chart.umd.js present (${readFileSync(out).length} bytes) — skip download`);
} else {
  const res = await fetch(url);
  if (!res.ok) { console.error(`download failed: ${res.status} ${res.statusText} (${url})`); process.exit(1); }
  const text = await res.text();
  writeFileSync(out, text);
  console.log(`downloaded ${url} → tests/golden/vendor/chart.umd.js (${text.length} bytes)`);
}
const manifestPath = join(GOLDEN, 'fixtures/manifest.json');
if (existsSync(manifestPath)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.vendor = { 'vendor/chart.umd.js': { url, sha256: sha256Hex(readFileSync(out)) } };
  writeFileSync(manifestPath, stableJson(manifest));
  console.log('manifest.json vendor entry updated');
}
