// SPDX-License-Identifier: AGPL-3.0-or-later
// Regenerates tests/visual/fixtures/retaining-note.json: runs the seeded demo journey to Stage 6 →
// Retaining walls → sheet pile (+ drivability + vibration), triggers "Calculation note" and dumps the
// localStorage payload. Requires a dev server on http://localhost:5199 (`npx vite dev --port 5199`).
//   node tests/visual/gen-retaining-note.mjs
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { FIXED_TIME, SEED_SCRIPT, waitText } from './helpers.mjs';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await context.newPage();
await page.clock.setFixedTime(FIXED_TIME);
await page.addInitScript(SEED_SCRIPT);
await page.addInitScript(() => { window.open = () => null; });
await page.goto('http://localhost:5199/', { waitUntil: 'networkidle' });
await page.getByText('Load demo — anonymous profile').click();
await page.waitForTimeout(800);
await page.evaluate(() => { window.goS(1); window.runClass(); });
await page.waitForTimeout(800);
for (const n of [2, 3, 4, 5]) { await page.evaluate((k) => window.goS(k), n); await page.waitForTimeout(500); }
await page.evaluate(() => window.setStage6App('retwall'));
await page.locator('#retwallCanvas').waitFor();
await page.evaluate(() => window.retwallSetType('sheetpile'));
await waitText(page, '#retwallSummary', /governing values|no result/i);
await page.evaluate(() => window.retwallRunDrivability());
await waitText(page, '#retwallResultBody', /minimum vibrator|will it drive/i);
await page.evaluate(() => window.retwallOpenNote());
await page.waitForTimeout(300);
const payload = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => k.startsWith('retaining-note:'));
  return key ? localStorage.getItem(key) : null;
});
if (!payload) throw new Error('no retaining-note payload found in localStorage');
const out = new URL('./fixtures/retaining-note.json', import.meta.url);
writeFileSync(out, payload);
console.log(`wrote ${out.pathname} (${payload.length} bytes)`);
await browser.close();
