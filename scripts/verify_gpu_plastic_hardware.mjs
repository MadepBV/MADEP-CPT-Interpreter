// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Real-hardware smoke test for the FULL GPU plastic pipeline.
// Mirrors verify_gpu_hardware.mjs but loads the plastic-mode test page.
// =============================================================================

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const playwrightBase = process.env.PLAYWRIGHT
  || '/tmp/wgsl-validator-tmp/node_modules/playwright';
if (!existsSync(playwrightBase)) {
  console.error(`Playwright not found at ${playwrightBase}.  Set $PLAYWRIGHT.`);
  process.exit(2);
}
const playwrightModule = await import(`${playwrightBase}/index.mjs`);
const { chromium } = playwrightModule.default ?? playwrightModule;

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
const MIME = {
  '.js':'application/javascript', '.mjs':'application/javascript',
  '.html':'text/html; charset=utf-8', '.css':'text/css', '.json':'application/json'
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
const url = `http://127.0.0.1:${server.address().port}/scripts/gpu_plastic_hardware_smoke.html`;
console.log(`[plastic-smoke] static server on ${url}`);

let browser = null;
let exitCode = 1;
try {
  browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-unsafe-webgpu',
      '--enable-features=Vulkan,WebGPU',
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
  page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message}`));

  await page.goto(url, { waitUntil: 'load' });
  const result = await page.evaluate(() => new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (window.__smokeResult) return resolve(window.__smokeResult);
      if (Date.now() - start > 60000) return reject(new Error('timeout'));
      setTimeout(tick, 100);
    };
    tick();
  }));
  console.log(`[plastic-smoke] result: ${JSON.stringify(result, null, 2)}`);
  exitCode = result?.ok ? 0 : 1;
} catch (err) {
  console.error(`[plastic-smoke] error: ${err?.stack || err?.message || err}`);
} finally {
  if (browser) await browser.close();
  server.close();
}
process.exit(exitCode);
