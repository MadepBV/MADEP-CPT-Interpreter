// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase-0 visual baselines of the documentation site: index + one content page.
import { test } from '@playwright/test';
import { VARIANTS, prepare, settle, shotPage } from './helpers.mjs';

for (const v of VARIANTS) {
  test(`docs — layout [${v.id}]`, async ({ page }) => {
    await prepare(page, v);
    await page.goto('/docs', { waitUntil: 'networkidle' });
    await settle(page, 400);
    await shotPage(page, 'docs-index', v);
    await page.goto('/docs/engineering', { waitUntil: 'networkidle' });
    await settle(page, 400);
    await shotPage(page, 'docs-engineering', v);
  });
}
