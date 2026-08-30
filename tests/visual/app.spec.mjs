// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase-0 visual baselines of the CPT app (worklog/refactor/02-design-system.md §5.2):
// one deterministic journey per {viewport × colour scheme}, screenshots at every stage/state.
// Layout shots mask canvases (0 px tolerance); canvas shots are separate and tolerant.
import { test } from '@playwright/test';
import { VARIANTS, prepare, collectErrors, settle, shotPage, shotCanvas, loadDemo, goStage, waitText, waitStable, demoCsv } from './helpers.mjs';

const RETWALL_TABS = ['checks', 'branches', 'diagrams', 'structural', 'plaxis', 'drivability', 'vibration', 'note'];

for (const v of VARIANTS) {
  test(`app journey — layout + canvas [${v.id}]`, async ({ page }) => {
    await prepare(page, v);
    const errors = collectErrors(page);

    // ── / empty ─────────────────────────────────────────────────────────────
    await page.goto('/', { waitUntil: 'networkidle' });
    await settle(page, 400);
    await shotPage(page, 'home-empty', v);

    // ── toast queue ─────────────────────────────────────────────────────────
    // Classifying with no CPT loaded is the app's own guard message; running it twice proves the
    // queue coalesces a repeat into one card with a ×n counter instead of stacking duplicates.
    await page.evaluate(() => { window.runClass(); window.runClass(); });
    await page.locator('.toast').waitFor();
    await settle(page, 300);
    await shotPage(page, 'toast', v);
    await page.locator('.toast [data-toast-close]').click();
    await page.locator('.toast').waitFor({ state: 'detached' });
    await page.mouse.move(0, 0);

    // ── Stage 1 after demo load ─────────────────────────────────────────────
    await loadDemo(page);
    await shotPage(page, 'stage1-demo', v);
    await shotCanvas(page.locator('#cQc'), 'canvas-stage1-qc', v);

    // ── Stage 2 classification ──────────────────────────────────────────────
    await page.evaluate(() => { window.goS(1); window.runClass(); });
    await page.locator('#p1.active').waitFor();
    await settle(page, 900);
    await shotPage(page, 'stage2-classification', v);

    // ── Stage 3 layer table ─────────────────────────────────────────────────
    await goStage(page, 2);
    await page.locator('#lt tbody tr').first().waitFor();
    await settle(page, 500);
    await shotPage(page, 'stage3-layers', v);

    // ── Stage 4 model cards ─────────────────────────────────────────────────
    await goStage(page, 3);
    await page.locator('#ma .card').first().waitFor();
    await settle(page, 500);
    await shotPage(page, 'stage4-model', v);

    // ── Stage 5 tuning ──────────────────────────────────────────────────────
    await goStage(page, 4);
    await settle(page, 900);
    await shotPage(page, 'stage5-tuning', v);

    // ── Stage 6 applications ────────────────────────────────────────────────
    await goStage(page, 5);
    await page.locator('#stage6Area .tabs--icon .tab').first().waitFor();
    for (const app of ['bearing', 'pile', 'settlement', 'dewatering', 'beam']) {
      await page.evaluate((a) => window.setStage6App(a), app);
      await settle(page, 1200);
      await shotPage(page, `stage6-${app}`, v);
    }

    // Bishop / seepage workspace with the canvas dock and the "View" inspector card open
    await page.evaluate(() => window.setStage6App('bishop'));
    await settle(page, 1500);
    await page.evaluate(() => { window.stage6BishopToggleCanvasTools(true); window.stage6BishopSetCanvasPanel('view'); });
    await settle(page, 800);
    await shotPage(page, 'stage6-bishop-dock-card', v);

    // Retaining walls: sheet pile + every result tab, then soldier pile drivability
    await page.evaluate(() => window.setStage6App('retwall'));
    await page.locator('#retwallCanvas').waitFor();
    await page.evaluate(() => window.retwallSetType('sheetpile'));
    await waitText(page, '#retwallSummary', /governing values|no result/i);
    await waitStable(page, '#retwallSummary');
    await settle(page, 300);
    await shotPage(page, 'stage6-retwall-sheetpile', v);
    await shotCanvas(page.locator('#retwallCanvas'), 'canvas-retwall-sheetpile', v);
    for (const tab of RETWALL_TABS) {
      await page.evaluate((t) => window.retwallSet('ui.resultTab', t), tab);
      await waitStable(page, '#retwallResultBody');
      await settle(page, 300);
      await shotPage(page, `stage6-retwall-sheetpile--${tab}`, v);
    }

    await page.evaluate(() => window.retwallSetType('soldierpile'));
    await waitText(page, '#retwallSummary', /governing values|no result/i);
    await page.evaluate(() => window.retwallRunDrivability());
    await waitText(page, '#retwallResultBody', /minimum vibrator/i);
    await waitStable(page, '#retwallResultBody', { samples: 4, interval: 400 });
    await settle(page, 300);
    await shotPage(page, 'stage6-retwall-soldierpile-drivability', v);

    // ── Stratigrafie + Doorsnede phases ─────────────────────────────────────
    await page.evaluate(() => window.setPhase('correlation'));
    await page.locator('#phaseCorr').waitFor({ state: 'visible' });
    await settle(page, 900);
    await shotPage(page, 'phase-stratigrafie', v);
    await page.evaluate(() => window.setPhase('section'));
    await page.locator('#phaseSection').waitFor({ state: 'visible' });
    await settle(page, 900);
    await shotPage(page, 'phase-doorsnede', v);
    await page.evaluate(() => window.setPhase('analysis'));

    // ── import-review modal (CSV → dialog → cancel) — last: cancelling still runs selectCpt(), which
    //    resets the stage rail to Stage 1 asynchronously (a race for anything that follows it).
    await page.evaluate(() => window.goS(0));
    await page.locator('#p0.active').waitFor();
    await page.setInputFiles('#fi', { name: 'visual-demo.csv', mimeType: 'text/csv', buffer: Buffer.from(demoCsv()) });
    await page.locator('.import-review-overlay').waitFor();
    await settle(page, 400);
    await shotPage(page, 'import-review', v);
    await page.locator('[data-ir="cancel"]').last().click();
    await page.mouse.move(0, 0);
    await page.locator('.import-review-overlay').waitFor({ state: 'detached' });
    await settle(page, 800);

    test.expect.soft(errors, errors.join('\n')).toEqual([]);
  });
}
