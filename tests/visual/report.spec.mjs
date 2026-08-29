// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase-0 visual baselines of the rekennota route /report/retaining: screen, emulated print media,
// and page 1 of the real PDF (page.pdf → rasterised) — the 0 px print gate of §5.3.
// The note payload is a frozen fixture (tests/visual/fixtures/retaining-note.json, regenerate with
// `node tests/visual/gen-retaining-note.mjs`) so the gate isolates CSS from engine changes.
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { VARIANTS, prepare, settle, shotPage, rasterisePdfPage1 } from './helpers.mjs';

const FIXTURE_KEY = 'retaining-note:visual-fixture';
const fixture = readFileSync(new URL('./fixtures/retaining-note.json', import.meta.url), 'utf8');

async function openReport(page) {
  await page.addInitScript(({ key, json }) => { window.localStorage.setItem(key, json); }, { key: FIXTURE_KEY, json: fixture });
  await page.goto(`/report/retaining?key=${encodeURIComponent(FIXTURE_KEY)}`, { waitUntil: 'networkidle' });
  await page.locator('.report-sheet').waitFor();
  await settle(page, 500);
}

for (const v of VARIANTS) {
  test(`report retaining — screen [${v.id}]`, async ({ page }) => {
    await prepare(page, v);
    await openReport(page);
    await shotPage(page, 'report-retaining', v);
    await page.emulateMedia({ media: 'print' });
    await settle(page, 300);
    await shotPage(page, 'report-retaining-print-emulated', v);
  });
}

for (const v of VARIANTS.filter((x) => x.id.startsWith('desktop'))) {
  test(`report retaining — print pdf page 1 [${v.id}]`, async ({ page }, testInfo) => {
    await prepare(page, v);
    await openReport(page);
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    const pdfPath = testInfo.outputPath(`report-retaining--${v.id}.pdf`);
    const pngPath = testInfo.outputPath(`report-retaining-p1--${v.id}.png`);
    writeFileSync(pdfPath, pdf);
    const ok = rasterisePdfPage1(pdfPath, pngPath);
    if (!ok) {
      testInfo.annotations.push({ type: 'warning', description: 'No PDF rasteriser (sips / pdftoppm) available — page-1 gate skipped.' });
      test.skip(true, 'no PDF rasteriser available');
    }
    expect(readFileSync(pngPath)).toMatchSnapshot(`report-retaining-print-p1--${v.id}.png`, { maxDiffPixels: 0, threshold: 0.01 });
  });
}
