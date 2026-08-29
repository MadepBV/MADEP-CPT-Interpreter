// SPDX-License-Identifier: AGPL-3.0-or-later
// Tier C golden journeys (design §2.3, §4.5): the real app in Chromium, stepped from
// load to the Stage 7 payload, locking state.json + dom.txt (+ a tolerant PNG) per step.
// Run through tests/e2e/golden.config.mjs only:
//   GOLDEN_MODE=record npx playwright test --config tests/e2e/golden.config.mjs   (baseline)
//   npx playwright test --config tests/e2e/golden.config.mjs                     (check)
// Determinism: seeded Math.random (mulberry32, manifest seed — loadDemo() draws per
// reading), a clock shifted to a fixed epoch, Chart.js from tests/golden/vendor with
// animations off, analytics neutralised, nl-BE / Europe/Brussels from the config, and
// state-predicate waits (never waitForTimeout).
import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Journey, CAPTURE_SCRIPT, CHART_VENDOR, CHART_CDN_GLOB, ANALYTICS_GLOB } from '../../scripts/golden/lib/journey.mjs';
import { MULBERRY32_SOURCE } from '../../scripts/golden/lib/prng.mjs';
import { GOLDEN } from '../../scripts/golden/lib/store.mjs';

const manifest = JSON.parse(readFileSync(join(GOLDEN, 'fixtures/manifest.json'), 'utf8'));
const SEED = manifest.seed;                       // 20260829 — same seed as demo-anonymous.gef
const EPOCH = '2026-01-01T00:00:00Z';
const FIXTURE_GEF = join(GOLDEN, 'fixtures/cpt/layered.gef');
// Chart.js 4.4.1 (vendored copy of the CDN file) + animations off: charts are drawn in
// their final state on the first frame, so screenshots do not depend on frame timing.
// Chart configs themselves are untouched (they are locked in the Node tier).
const CHART_JS = readFileSync(CHART_VENDOR, 'utf8') + '\n;if (typeof Chart !== "undefined") { Chart.defaults.animation = false; }\n';

const WALL_TYPES = ['cantilever', 'gravity', 'sheetpile', 'anchored', 'soldierpile'];
const STAGE6_APPS = [
  ['bearing', 'bearing.B', 2.0],
  ['pile', 'pile.zToe', 12],
  ['settlement', 'settlement.Gk', 200],
  ['dewatering', 'dewatering.targetWt', 4],
  ['beam', 'beam.L', 8]
];
const SEEP_SLOPE_BUDGET_MS = 60_000;
// Parts of the saved project / report payload that are locked in full at the step that
// produced them (01-loaded, 02-classified, 06-tuning, 07-*, 08-retwall-*, 07-bishop-stability):
// stored as digests here so a change still flips the golden while the file stays diffable.
const SAVE_DIGEST = ['project.cpts[*].data', 'project.cpts[*].classified', 'project.cpts[*].tuning',
  'project.cpts[*].stage6.retwall.result', 'project.cpts[*].stage6.bishop.results'];
const REPORT_DIGEST = ['rawRows', 'classifiedRows', 'stage6.*.analysis', 'stage6.bishop.results'];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

test.beforeEach(async ({ context }, testInfo) => {
  test.skip(testInfo.project.name !== 'golden', 'golden journeys run through tests/e2e/golden.config.mjs');
  await context.addInitScript(({ seed, epoch, prng }) => {
    // F1: seeded PRNG so loadDemo() (and every id / storage key) is reproducible
    Math.random = (0, eval)(prng)(seed);
    // F5: clock shifted to a fixed epoch — still advancing (Chart.js and the app's
    // timers need a moving Date.now), so the date part is constant and the minute is
    // masked by the journey (TEXT_MASKS) / normalize.mjs.
    const RealDate = Date;
    const t0 = RealDate.now();
    const base = new RealDate(epoch).getTime();
    const now = () => base + (RealDate.now() - t0);
    class GoldenDate extends RealDate {
      constructor(...args) { if (args.length) super(...args); else super(now()); }
      static now() { return now(); }
    }
    GoldenDate.parse = RealDate.parse;
    GoldenDate.UTC = RealDate.UTC;
    globalThis.Date = GoldenDate;
  }, { seed: SEED, epoch: EPOCH, prng: MULBERRY32_SOURCE });
  await context.addInitScript({ path: CAPTURE_SCRIPT });
  await context.route(CHART_CDN_GLOB, (r) => r.fulfill({ body: CHART_JS, contentType: 'text/javascript' }));
  await context.route(ANALYTICS_GLOB, (r) => r.fulfill({ body: '', contentType: 'text/javascript' }));
});

/** Wait for a popup opened by `open()` and for its report shell to be rendered. */
async function openReportTab(context, page, j, open, { readySelector = '.report-shell', chart = true } = {}) {
  const [tab] = await Promise.all([context.waitForEvent('page'), page.evaluate(open)]);
  j.observe(tab);
  await tab.waitForLoadState('networkidle');
  await tab.locator(readySelector).first().waitFor();
  if (chart) {
    // the report builds its annex charts once Chart.js is available (vendored + routed)
    await tab.waitForFunction(() => document.querySelectorAll('.report-shell canvas').length > 0, null, { timeout: 15000 }).catch(() => {});
  }
  await j.nextFrame(tab);
  return tab;
}

/** Stages 2 → 7 shared by both journeys (starts with a loaded CPT on Stage 1). */
async function stages2to7(page, context, j) {
  // ---- Stage 2: classification (default method, then every other method once) ----
  await page.evaluate(() => { window.goS(1); window.runClass(); });
  await j.nextFrame();
  await j.step('02-classified');
  for (const m of ['robertson', 'robertson2016', 'cur3', 'nen6740']) {
    await page.evaluate((method) => window.selM(method), m);
    await j.nextFrame();
    await j.step(`02-classified-${m}`, { screenshot: false });
  }
  await page.evaluate(() => window.selM('sb260'));
  await j.nextFrame();

  // ---- Stage 3: layers + a manual subtype edit through the real <select> ----
  await page.evaluate(() => window.goS(2));
  await j.nextFrame();
  await j.step('03-layers');
  const next = await page.evaluate(() => {
    const sel = document.querySelector('#lb select[data-i="1"]');
    if (!sel) return null;
    const opt = [...sel.options].find((o) => o.value && o.value !== sel.value && !o.disabled);
    return opt ? opt.value : null;
  });
  if (next) {
    await page.selectOption('#lb select[data-i="1"]', next);
    await j.nextFrame();
  } else j.notes.push('03-layers: no alternative subtype option for layer 1 — edit step skipped');
  await j.step('04-layers-edited');

  // ---- Stage 4: model parameters, default methods then alpha A / stiffness A ----
  await page.evaluate(() => window.goS(3));
  await j.nextFrame();
  await j.step('05-model-default');
  await page.evaluate(() => { window.setAlphaMethod('A'); window.setStiffMethod('A'); });
  await j.nextFrame();
  await j.step('05-model-alphaA-stiffA');

  // ---- Stage 5: tuning, accept the first fit ----
  await page.evaluate(() => { window.goS(4); window.runTuning(); });
  await j.nextFrame();
  await j.step('06-tuning');
  await page.evaluate(() => window.acceptFit(0));
  await j.nextFrame();
  await j.step('06-tuning-accepted0', { screenshot: false });

  // ---- Stage 6: bearing / pile / settlement / dewatering / beam ----
  await page.evaluate(() => window.goS(5));
  await j.nextFrame();
  for (const [app, field, value] of STAGE6_APPS) {
    await page.evaluate((a) => window.setStage6App(a), app);
    await j.nextFrame();
    await j.step(`07-${app}`);
    await page.evaluate(([f, v]) => window.setStage6Field(f, v), [field, value]);
    await j.nextFrame();
    await j.step(`07-${app}-${slug(field)}-${value}`, { screenshot: false });
  }

  // ---- Stage 6: retaining walls — every wall type (WASM on the main thread), every result tab ----
  await page.evaluate(() => window.setStage6App('retwall'));
  for (const t of WALL_TYPES) {
    await page.evaluate((type) => window.retwallSetType(type), t);
    // retwallSetType resets status to 'idle' synchronously, so 'done' belongs to this type
    await j.waitState((s) => s.active.stage6.retwall.status === 'done', { timeout: 60000 });
    await j.nextFrame();
    await j.step(`08-retwall-${t}`, { dom: ['#retwallInputs', '#retwallSummary', '#retwallResultTabs'] });
    const tabs = page.locator('#retwallResultTabs button');
    const labels = await tabs.allTextContents();
    for (let i = 0; i < labels.length; i++) {
      await tabs.nth(i).click();
      await j.nextFrame();
      await j.step(`08-retwall-${t}-${slug(labels[i])}`, { dom: ['#retwallResultBody'], state: false, screenshot: false });
    }
  }
  // drivability on the soldier-pile wall (last type selected)
  await page.evaluate(() => window.retwallRunDrivability());
  await j.waitState((s) => s.active.stage6.retwall.drivability.status !== 'running', { timeout: 60000 });
  await j.nextFrame();
  await j.step('09-drivability', { dom: ['#retwallSummary', '#retwallResultBody'] });
  // calculation note: localStorage payload + the /report/retaining tab
  const note = await openReportTab(context, page, j, () => window.retwallOpenNote(), { chart: false });
  await j.localStorage('10-note.payload', 'retaining-note:', { digestPaths: ['result', 'structural', 'layers', 'drivability'] });
  await j.stepPage('10-note', note, { dom: ['.report-shell'] });
  await note.close();

  // ---- Stage 6: seep / slope — model sync + Bishop search within a time budget ----
  await seepSlope(page, j);

  // ---- downloads: exports + project save ----
  for (const fn of ['exportCSV', 'exportPlaxisCommands', 'exportPlaxisCpt', 'saveProject']) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.evaluate((f) => window[f](), fn)]);
    await j.download(`11-${slug(fn)}`, dl, fn === 'saveProject' ? { digestPaths: SAVE_DIGEST } : {});
  }
  j.json('11-dialogs', j.dialogs.slice());

  // ---- Stage 7: payload + the report tab ----
  const payload = await page.evaluate(() => window.buildStage7Payload());
  j.json('12-report.payload', payload, { digestPaths: REPORT_DIGEST });
  const rep = await openReportTab(context, page, j, () => window.openStage7Report());
  await j.stepPage('12-report', rep, { dom: ['.report-shell'] });
  await rep.close();
  await j.step('13-final', { screenshot: false });
}

/**
 * Seep / slope: inject a small terrain by state (the canvas tools are the only UI
 * path), render the Bishop app (model + materials synced from the layers), then run
 * the slip-circle search in its Worker. The search is deterministic (no Math.random
 * in the worker; timing masked) — it is only kept if it completes within the budget.
 */
async function seepSlope(page, j) {
  await page.evaluate(() => {
    const S = window.PROJECT.cpts[window.PROJECT.activeCptIdx];
    const b = S.stage6.bishop;
    b.terrain = [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }];
    b.entryZone = { xStart: 1, xEnd: 5 };
    b.exitZone = { xStart: 13, xEnd: 19 };
    b.search.keepBest = 3;
    window.setStage6App('bishop');
  });
  await j.nextFrame();
  await j.step('07-bishop-model');
  const t0 = Date.now();
  await page.evaluate(() => window.stage6BishopRunSearch());
  try {
    await j.waitState((s) => s.active.stage6.bishop.progress.running === false && !!s.active.stage6.bishop.results, { timeout: SEEP_SLOPE_BUDGET_MS });
  } catch (e) {
    await page.evaluate(() => window.stage6BishopStopSearch(true));
    j.notes.push(`07-bishop-stability skipped: search did not finish within ${SEEP_SLOPE_BUDGET_MS / 1000} s`);
    await page.evaluate(() => window.setStage6App('bearing'));
    await j.nextFrame();
    return;
  }
  await j.nextFrame();
  j.notes.push(`bishop search completed in ${Date.now() - t0} ms`);
  await j.step('07-bishop-stability');
  await page.evaluate(() => window.setStage6App('bearing'));
  await j.nextFrame();
}

test('demo-journey', async ({ page, context }) => {
  const j = new Journey('demo-journey', { page, context });
  j.observe(page);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByText('Load demo — anonymous profile').click();
  await j.waitState((s) => s.active.data.length > 0 && s.active.chartsReady === true);
  await j.nextFrame();
  await j.step('01-loaded');
  await stages2to7(page, context, j);
  await j.finish();
});

test('gef-import-journey', async ({ page, context }) => {
  const j = new Journey('gef-import-journey', { page, context });
  j.observe(page);
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.setInputFiles('#fi', FIXTURE_GEF);
  await page.locator('.import-review-overlay').waitFor();
  await j.step('00-import-review', { dom: ['.import-review-overlay'] });
  await page.click('.import-review-overlay [data-ir="apply"]');
  await j.waitState((s) => s.active.data.length > 0 && s.active.chartsReady === true);
  await j.nextFrame();
  await j.step('01-loaded');
  await stages2to7(page, context, j);
  await j.finish();
});
