// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-hardware smoke test for the WebGPU v2 matrix-free pipeline.
// Starts a static server, opens a browser page, runs the full v2 path, and
// rejects software adapters by default so Apple/M-series testing exercises
// the actual GPU backend.
// =============================================================================

import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const playwrightBase = process.env.PLAYWRIGHT
  || '/tmp/wgsl-validator-tmp/node_modules/playwright';
if (!existsSync(playwrightBase)) {
  console.error(`Playwright not found at ${playwrightBase}. Set $PLAYWRIGHT.`);
  process.exit(2);
}
const playwrightModule = await import(`${playwrightBase}/index.mjs`);
const { chromium } = playwrightModule.default ?? playwrightModule;

const MIME = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.json': 'application/json'
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost/');
    const path = resolve(projectRoot, `.${url.pathname}`);
    if (!path.startsWith(projectRoot)) {
      res.writeHead(403).end();
      return;
    }
    const buf = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(buf);
  } catch (err) {
    res.writeHead(404).end(String(err?.message || err));
  }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const allowSoftware = process.env.GPU_TEST_SOFTWARE === '1';
const debug = process.env.GPU_TEST_DEBUG === '1';
const solver = /^(cg|bicgstab)$/.test(process.env.GPU_TEST_SOLVER || '')
  ? process.env.GPU_TEST_SOLVER
  : '';
const url = `http://127.0.0.1:${server.address().port}/scripts/gpu_v2_hardware_smoke.html?software=${allowSoftware ? '1' : '0'}&debug=${debug ? '1' : '0'}${solver ? `&solver=${solver}` : ''}`;
console.log(`[v2-hardware-smoke] static server on ${url}`);

let browser = null;
let exitCode = 1;
try {
  const launchOptions = {
    headless: process.env.GPU_TEST_HEADED === '1' ? false : true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=WebGPU',
      '--ignore-gpu-blocklist'
    ]
  };
  if (process.env.GPU_TEST_BUNDLED !== '1') {
    launchOptions.channel = process.env.GPU_TEST_CHANNEL || 'chrome';
  }
  try {
    browser = await chromium.launch(launchOptions);
  } catch (err) {
    if (launchOptions.channel) {
      console.log(`[v2-hardware-smoke] Chrome channel "${launchOptions.channel}" unavailable (${err?.message || err}); falling back to bundled Chromium.`);
      delete launchOptions.channel;
      browser = await chromium.launch(launchOptions);
    } else {
      throw err;
    }
  }
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const type = msg.type();
    const tag = type === 'error' ? '!' : type === 'warning' ? '~' : ' ';
    console.log(`  [browser ${tag}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message}`));

  await page.goto(url, { waitUntil: 'load' });
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.__smokeResult) return resolve(window.__smokeResult);
      if (Date.now() - started > 90000) return reject(new Error('timeout'));
      setTimeout(tick, 100);
    };
    tick();
  }));

  console.log(`[v2-hardware-smoke] result: ${JSON.stringify(result, null, 2)}`);
  if (result?.ok) {
    console.log('[v2-hardware-smoke] OK - v2 WebGPU path produced nonzero verified output.');
    exitCode = 0;
  } else {
    console.log('[v2-hardware-smoke] FAIL - v2 WebGPU path did not verify.');
    exitCode = 1;
  }
} catch (err) {
  console.error(`[v2-hardware-smoke] error: ${err?.stack || err?.message || err}`);
  exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.close();
}
process.exit(exitCode);
