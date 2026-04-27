// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-hardware WebGPU smoke test.
//
// Launches a headless Chromium with WebGPU enabled, navigates to a test
// HTML page that runs the entire GPU resident pipeline (mesh-pack →
// assembly → resident CG) on a small mesh, and verifies the result against
// the CPU baseline.  Exits non-zero on any failure.
//
// Run via:  PLAYWRIGHT=/tmp/wgsl-validator-tmp/node_modules/playwright \
//           ~/.nvm/versions/node/v25.6.0/bin/node scripts/verify_gpu_hardware.mjs
// =============================================================================

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

// Resolve playwright module location.
const playwrightBase = process.env.PLAYWRIGHT
  || '/tmp/wgsl-validator-tmp/node_modules/playwright';
if (!existsSync(playwrightBase)) {
  console.error(`Playwright not found at ${playwrightBase}.  Set $PLAYWRIGHT.`);
  process.exit(2);
}
const playwrightImport = `${playwrightBase}/index.mjs`;
const playwrightModule = await import(playwrightImport);
const { chromium } = playwrightModule.default ?? playwrightModule;

// Start a tiny static-file server rooted at projectRoot.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
const MIME = {
  '.js':  'application/javascript',
  '.mjs': 'application/javascript',
  '.html':'text/html; charset=utf-8',
  '.css': 'text/css',
  '.json':'application/json'
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost/');
    const path = resolve(projectRoot, '.' + url.pathname);
    if (!path.startsWith(projectRoot)) { res.writeHead(403).end(); return; }
    const buf = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(buf);
  } catch (err) {
    res.writeHead(404).end(String(err.message || err));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/scripts/gpu_hardware_smoke.html`;

console.log(`[hardware-smoke] static server on ${url}`);

let browser = null;
let exitCode = 1;
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan',
      '--enable-features=WebGPU',
      '--use-vulkan=swiftshader',
      '--use-angle=swiftshader',
      '--use-gl=angle',
      '--ignore-gpu-blocklist'
    ]
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const t = msg.type();
    const tag = t === 'error' ? '!' : t === 'warning' ? '~' : ' ';
    console.log(`  [browser ${tag}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => {
    console.log(`  [pageerror] ${err.message}`);
  });

  await page.goto(url, { waitUntil: 'load' });
  // Wait up to 30 s for the smoke harness to populate window.__smokeResult.
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (window.__smokeResult) return resolve(window.__smokeResult);
      if (Date.now() - start > 30000) return reject(new Error('timeout'));
      setTimeout(tick, 100);
    };
    tick();
  }));

  console.log(`[hardware-smoke] result: ${JSON.stringify(result, null, 2)}`);
  if (result?.ok) {
    console.log('[hardware-smoke] OK — full GPU pipeline ran on real hardware.');
    exitCode = 0;
  } else {
    console.log('[hardware-smoke] FAIL — GPU pipeline did not produce a verified result.');
    exitCode = 1;
  }
} catch (err) {
  console.error(`[hardware-smoke] error: ${err?.stack || err?.message || err}`);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
process.exit(exitCode);
