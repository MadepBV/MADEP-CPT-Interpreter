// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared helpers for the visual-regression suite (phase 0 of worklog/refactor/02-design-system.md §5.2).
// Every journey is made deterministic here: seeded Math.random (the demo profile is random),
// a fixed wall clock (report time stamps), reduced motion, and the Chromium font pipeline settled.
import { expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXED_TIME = new Date('2026-08-29T10:00:00.000+02:00');

/** mulberry32 — a tiny seeded PRNG installed over Math.random before any app script runs. */
export const SEED_SCRIPT = `(() => {
  let a = (0x9E3779B9 ^ 20260829) | 0;
  Math.random = function seededRandom() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

export const VARIANTS = [
  { id: 'desktop-light', viewport: { width: 1500, height: 950 }, colorScheme: 'light' },
  { id: 'desktop-dark', viewport: { width: 1500, height: 950 }, colorScheme: 'dark' },
  { id: 'mobile-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
  { id: 'mobile-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark' }
];

/** Viewport, colour scheme, reduced motion, fixed clock and the seeded PRNG — call before the first goto. */
export async function prepare(page, variant) {
  await page.setViewportSize(variant.viewport);
  await page.emulateMedia({ colorScheme: variant.colorScheme, reducedMotion: 'reduce' });
  await page.clock.setFixedTime(FIXED_TIME);
  await page.addInitScript(SEED_SCRIPT);
}

/** Collects uncaught page errors; the journey asserts the list is empty at the end. */
export function collectErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

/** Fonts loaded + a short idle so string-rendered DOM and Chart.js have painted. */
export async function settle(page, ms = 250) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}

const SCREENSHOT_CSS = fileURLToPath(new URL('./screenshot.css', import.meta.url));

/** Layout baseline: full page, canvases hidden via stylePath (chart anti-aliasing is GPU-dependent; layout is not).
 *  `visibility:hidden` keeps the canvas box and leaves the glass overlays that float over it visible — a mask would paint over them. */
export async function shotPage(page, name, variant, opts = {}) {
  // goS() scrolls the stage into view; a full-page capture places sticky chrome at the *current* scroll
  // offset, so pin the scroll position first (behaviour 'instant' also defeats html{scroll-behavior:smooth}).
  await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
  await page.waitForTimeout(120);
  await expect.soft(page).toHaveScreenshot(`${name}--${variant.id}.png`, {
    fullPage: true,
    stylePath: SCREENSHOT_CSS,
    ...opts
  });
}

/** Canvas-only baseline: tolerant (maxDiffPixelRatio 0.02) because raster output differs across GPUs. */
export async function shotCanvas(locator, name, variant) {
  await expect.soft(locator).toHaveScreenshot(`${name}--${variant.id}.png`, {
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
    animations: 'disabled'
  });
}

/** Demo CPT → classification → layers → model → tuning → Stage 6 (mirrors tests/e2e/retaining-walls.spec.mjs). */
export async function loadDemo(page) {
  await page.getByText('Load demo — anonymous profile').click();
  await page.mouse.move(0, 0); // park the pointer: Chromium re-evaluates :hover asynchronously after layout changes
  await page.waitForFunction(() => {
    const c = document.getElementById('cQc');
    return !!(window.Chart && c && window.Chart.getChart(c));
  }, null, { timeout: 30_000 });
  await settle(page, 1200);
}

export async function goStage(page, n) {
  await page.evaluate((k) => window.goS(k), n);
  await page.locator(`#p${n}.active`).waitFor();
}

export async function waitText(page, selector, re, timeout = 60_000) {
  await page.waitForFunction(
    ({ selector, source, flags }) => new RegExp(source, flags).test(document.querySelector(selector)?.innerText || ''),
    { selector, source: re.source, flags: re.flags },
    { timeout }
  );
}

/** Waits until an element's text has stopped changing (async result panels that keep appending rows). */
export async function waitStable(page, selector, { samples = 3, interval = 300, timeout = 30_000 } = {}) {
  const t0 = Date.now();
  let last = null, stable = 0;
  while (Date.now() - t0 < timeout) {
    const cur = await page.evaluate((sel) => document.querySelector(sel)?.innerText ?? null, selector);
    stable = cur === last ? stable + 1 : 0;
    if (stable >= samples - 1) return;
    last = cur;
    await page.waitForTimeout(interval);
  }
  throw new Error(`waitStable(${selector}): text kept changing for ${timeout} ms`);
}

/**
 * Rasterises page 1 of a PDF to PNG. macOS: `sips` (always present, deterministic 72 dpi). Elsewhere: poppler `pdftoppm` at 96 dpi.
 * Returns false when no rasteriser is available so the caller can annotate instead of failing blind.
 */
export function rasterisePdfPage1(pdfPath, pngPath) {
  const tryRun = (cmd, args) => { try { execFileSync(cmd, args, { stdio: 'ignore' }); return existsSync(pngPath); } catch { return false; } };
  if (process.platform === 'darwin' && tryRun('sips', ['-s', 'format', 'png', pdfPath, '--out', pngPath])) return true;
  if (tryRun('pdftoppm', ['-r', '96', '-f', '1', '-l', '1', '-png', '-singlefile', pdfPath, pngPath.replace(/\.png$/, '')])) return true;
  return false;
}

/** A tiny CSV CPT file that opens the import-review dialog (columns detected from headers). */
export function demoCsv() {
  const lines = ['Diepte [m];qc [MPa];fs [MPa]'];
  for (let i = 0; i < 60; i++) {
    const z = 0.2 + i * 0.25;
    const qc = z < 3 ? 6 + (i % 5) * 0.4 : z < 8 ? 1.4 + (i % 4) * 0.2 : 4 + (i % 6) * 0.6;
    const fs = qc * (z < 3 ? 0.008 : z < 8 ? 0.045 : 0.014);
    lines.push(`${z.toFixed(2)};${qc.toFixed(3)};${fs.toFixed(4)}`);
  }
  return lines.join('\n');
}
