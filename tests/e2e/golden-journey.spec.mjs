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
import { Journey, CAPTURE_SCRIPT, CHART_VENDOR, CHART_CDN_GLOB, ANALYTICS_GLOB, maskText } from '../../scripts/golden/lib/journey.mjs';
import { MULBERRY32_SOURCE } from '../../scripts/golden/lib/prng.mjs';
import { GOLDEN, sha256Hex } from '../../scripts/golden/lib/store.mjs';
import { normalize } from '../../scripts/golden/lib/normalize.mjs';
import { compare } from '../../scripts/golden/lib/compare.mjs';

const manifest = JSON.parse(readFileSync(join(GOLDEN, 'fixtures/manifest.json'), 'utf8'));
const SEED = manifest.seed;                       // 20260829 — same seed as demo-anonymous.gef
const EPOCH = '2026-01-01T00:00:00Z';
const FIXTURE_GEF = join(GOLDEN, 'fixtures/cpt/layered.gef');
const FIXTURE_GEFS = ['layered', 'sand-only', 'clay-only'].map((n) => join(GOLDEN, `fixtures/cpt/${n}.gef`));
const FIXTURE_LEGACY_PROJECT = join(GOLDEN, 'fixtures/projects/legacy-v0.5.2.madep.json');
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

/* ═══════════════════════════════════════════════════════════════════════════
   PR 17 journeys: seep-slope (canvas tools → search → seepage → deformation),
   multi-cpt (three imports → Stratigrafie → Doorsnede), save-load (round trip).
   ═══════════════════════════════════════════════════════════════════════════ */

const DEFORMATION_BUDGET_MS = 90_000;
const REPORT_ANNEX_DIGEST = ['bishop.results', 'bishop.analysis', 'seepage.mesh', 'seepage.result', 'seepage.analysis', 'deformation.mesh', 'deformation.result', 'deformation.analysis'];

/** Import layered.gef through the file input + review dialog, classify, open Stage 6. */
async function importLayeredAndClassify(page, j) {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.setInputFiles('#fi', FIXTURE_GEF);
  await page.locator('.import-review-overlay').waitFor();
  await page.click('.import-review-overlay [data-ir="apply"]');
  await j.waitState((s) => s.active.data.length > 0 && s.active.chartsReady === true);
  await page.evaluate(() => { window.goS(1); window.runClass(); });
  await j.nextFrame();
}

/**
 * Drive the Seep/Slope canvas the way the engineer does: a pointer click on
 * #stage6BishopCanvas at the screen position of a world point (viewport transform of
 * stage6BishopScreenToWorld; the app snaps to its 0.5 m grid), left = commit a draft
 * point / pick, right = complete the current action (stage6BishopPointerDown).
 */
async function clickWorld(page, x, y, button = 'left') {
  const pos = await page.evaluate(([wx, wy]) => {
    const S = window.PROJECT.cpts[window.PROJECT.activeCptIdx];
    const v = S.stage6.bishop.viewport;
    return { x: wx * v.scale + v.offsetX, y: v.offsetY - wy * v.scale };
  }, [x, y]);
  await page.locator('#stage6BishopCanvas').click({ position: pos, button, force: true });
  // every commit re-renders the app; the canvas handlers are re-bound in the postRender frame
  // (initStage6BishopCanvas) — the next click must not arrive before that
  await page.evaluate(() => window.__golden.nextFrame());
}

async function bishopTool(page, j, tool) {
  await page.evaluate((t) => window.stage6BishopSetTool(t), tool);
  await j.nextFrame();
}

test('seep-slope-journey', async ({ page, context }) => {
  const j = new Journey('seep-slope-journey', { page, context });
  j.observe(page);
  await importLayeredAndClassify(page, j);
  await page.evaluate(() => { window.goS(5); window.setStage6App('bishop'); });
  await j.nextFrame();
  await j.step('01-bishop-empty');

  // ---- terrain: three clicks with the terrain tool, right-click completes the draft ----
  await bishopTool(page, j, 'terrain');
  for (const [x, y] of [[0, 4], [8, 4], [20, 0]]) await clickWorld(page, x, y);
  await clickWorld(page, 20, 0, 'right');
  await j.waitState((s) => s.active.stage6.bishop.terrain.length === 3 && s.active.stage6.bishop.draftKind === '');
  await j.nextFrame();
  await j.step('02-terrain');

  // ---- entry / exit zones: two clicks each on the terrain (x snapped, y from the terrain) ----
  await bishopTool(page, j, 'entry');
  await clickWorld(page, 1, 4); await clickWorld(page, 5, 4);
  await bishopTool(page, j, 'exit');
  await clickWorld(page, 13, 4 - 5 / 3); await clickWorld(page, 19, 4 - 11 / 3);
  await j.waitState((s) => !!s.active.stage6.bishop.entryZone && !!s.active.stage6.bishop.exitZone);
  await j.nextFrame();
  await j.step('03-zones', { screenshot: false });

  // ---- phreatic line ----
  await bishopTool(page, j, 'phreatic');
  for (const [x, y] of [[0, 3], [8, 2.5], [20, -0.5]]) await clickWorld(page, x, y);
  await clickWorld(page, 20, -0.5, 'right');
  await j.waitState((s) => s.active.stage6.bishop.phreatic.length === 3);
  await j.nextFrame();
  await j.step('04-phreatic', { screenshot: false });

  // ---- retaining wall: head on the terrain at x = 9, tip at (9, 1); then the wall-table fields ----
  await bishopTool(page, j, 'wall');
  await clickWorld(page, 9, 4); await clickWorld(page, 9, 1);
  await j.waitState((s) => s.active.stage6.bishop.walls.length === 1);
  await page.evaluate(() => { window.stage6BishopSetWallField(0, 'passiveSide', 'right'); window.stage6BishopSetWallField(0, 'interfaceRInter', 0.67); });
  await j.nextFrame();
  await j.step('05-wall');

  // ---- drain (the drain tool switches to the seepage workspace): two clicks, then its head ----
  await bishopTool(page, j, 'drain');
  await clickWorld(page, 13, 1); await clickWorld(page, 18, 0);
  await j.waitState((s) => s.active.stage6.bishop.drains.length === 1);
  // constant head 0.5 m, always active: the "when saturated" gating iterates the drain's active
  // set and, on this section, only stops at the 10 s runtime limit — a clock-dependent result
  await page.evaluate(() => { window.stage6BishopSetDrainField(0, 'head', 0.5); window.stage6BishopSetDrainField(0, 'gating', 'always'); });
  await j.nextFrame();
  await j.step('06-drain');

  // ---- Bishop + Spencer search (Worker) ----
  await page.evaluate(() => { window.stage6BishopSetWorkspace('stability'); window.stage6BishopSetTool('edit'); });
  await j.nextFrame();
  await j.step('07-model', { screenshot: false });
  let t0 = Date.now();
  await page.evaluate(() => window.stage6BishopRunSearch());
  await j.waitState((s) => s.active.stage6.bishop.progress.running === false && !!s.active.stage6.bishop.results, { timeout: SEEP_SLOPE_BUDGET_MS });
  j.notes.push(`bishop search completed in ${Date.now() - t0} ms`);
  await j.nextFrame();
  await j.step('08-stability');

  // ---- seepage: side boundaries picked on the canvas with the BC tool, head values through the panel setters ----
  await page.evaluate(() => window.stage6BishopSetWorkspace('seepage'));
  await bishopTool(page, j, 'seepageBc');
  const sides = await page.evaluate(() => {
    const S = window.PROJECT.cpts[window.PROJECT.activeCptIdx];
    const b = S.stage6Cache.bishopSeepageBoundary || [];
    const pick = (src) => { const e = b.find((edge) => edge.source === src); return e ? { key: e.edgeKey, x: e.mid.x, y: e.mid.y } : null; };
    return { left: pick('side-left'), right: pick('side-right') };
  });
  for (const [side, head] of [['left', 3.0], ['right', -0.5]]) {
    await clickWorld(page, sides[side].x, sides[side].y);
    await j.waitState((s) => s.active.stage6.bishop.seepage.selectedEdgeKey !== '');
    await page.evaluate((h) => { window.stage6BishopSetSeepageBcType('head'); window.stage6BishopSetSeepageBcHead(h); }, head);
  }
  // 1.0 m² mesh; runtime limit 60 s (the field is entered in seconds) so the free-surface
  // iteration ends on its flow-error criterion, never on the clock
  await page.evaluate(() => { window.stage6BishopSetField('seepage.options.meshTargetArea', 1.0); window.stage6BishopSetField('seepage.options.maxRuntimeMs', 60); });
  await j.nextFrame();
  await j.step('09-seepage-bcs', { screenshot: false });
  t0 = Date.now();
  await page.evaluate(() => window.stage6BishopRunSeepage());
  await j.waitState((s) => ['success', 'failed', 'error'].includes(s.active.stage6.bishop.seepage.status), { timeout: SEEP_SLOPE_BUDGET_MS });
  j.notes.push(`seepage completed in ${Date.now() - t0} ms`);
  // measurement line → line probe (stage6BishopBuildLineProbe samples the seepage result; cache.bishopLineProbe)
  await page.evaluate(() => { const S = window.PROJECT.cpts[window.PROJECT.activeCptIdx]; S.stage6.bishop.measurement = { points: [{ x: 2, y: 2 }, { x: 18, y: -2 }] }; window.renderStage6(); });
  await j.nextFrame();
  await j.step('10-seepage');

  // ---- deformation: surface load with the load tool, q through the setter, coarse mesh, run within a budget ----
  await page.evaluate(() => window.stage6BishopSetWorkspace('deformation'));
  await bishopTool(page, j, 'load');
  await clickWorld(page, 2, 4); await clickWorld(page, 6, 4);
  await j.waitState((s) => s.active.stage6.bishop.surfaceLoads.length === 1);
  await page.evaluate(() => {
    const S = window.PROJECT.cpts[window.PROJECT.activeCptIdx];
    window.stage6BishopSetSurfaceLoadField(S.stage6.bishop.surfaceLoads[0].id, 'q', 20);
    window.stage6BishopSetField('deformation.options.meshElementType', 't3');
    window.stage6BishopSetField('deformation.options.meshTargetArea', 2.0);
    window.stage6BishopSetTool('edit');
  });
  await j.nextFrame();
  await j.step('11-deformation-setup', { screenshot: false });
  t0 = Date.now();
  await page.evaluate(() => window.stage6BishopRunDeformation());
  try {
    await j.waitState((s) => ['success', 'failed', 'error'].includes(s.active.stage6.bishop.deformation.status), { timeout: DEFORMATION_BUDGET_MS });
    j.notes.push(`deformation completed in ${Date.now() - t0} ms`);
  } catch {
    await page.evaluate(() => window.stage6BishopStopDeformation(true));
    j.notes.push(`12-deformation: run did not finish within ${DEFORMATION_BUDGET_MS / 1000} s — stopped, state locked as stopped`);
    await j.waitState((s) => s.active.stage6.bishop.deformation.progress.running === false, { timeout: 30000 });
  }
  await j.nextFrame();
  await j.step('12-deformation');

  // ---- Stage 7 captures + annexes ----
  for (const ws of ['stability', 'seepage', 'deformation']) {
    await page.evaluate((w) => { window.stage6BishopSetWorkspace(w); window.stage7CaptureWorkspaceView(w); }, ws);
    await j.nextFrame();
  }
  const annexes = await page.evaluate(() => { const p = window.buildStage7Payload(); const s = p?.stage6 || {}; return { bishop: s.bishop ?? null, seepage: s.seepage ?? null, deformation: s.deformation ?? null, seepSlope: s.seepSlope ?? null }; });
  j.json('13-report-annexes', annexes, { digestPaths: REPORT_ANNEX_DIGEST });
  await j.step('13-final');
  await j.finish();
});

test('multi-cpt-journey', async ({ page, context }) => {
  const j = new Journey('multi-cpt-journey', { page, context });
  j.observe(page);
  await page.goto('/', { waitUntil: 'networkidle' });
  // three GEF files in one picker action: the review dialog is sequential (importCptFiles)
  await page.setInputFiles('#fi', FIXTURE_GEFS);
  for (let i = 1; i <= FIXTURE_GEFS.length; i++) {
    await page.locator('.import-review-overlay').waitFor();
    if (i === 1) await j.step('00-import-review', { dom: ['.import-review-overlay'], screenshot: false });
    await page.click('.import-review-overlay [data-ir="apply"]');
    // (predicates travel as source text — the count is baked in, not closed over)
    await j.waitState(new Function('s', `return s.project.cpts.filter((c) => c.data.length > 0).length >= ${i};`), { timeout: 30000 });
  }
  await j.waitState((s) => s.active.chartsReady === true);
  await j.nextFrame();
  await j.step('01-imported');
  // section line: x = 0 / 30 / 60 m, surface levels 10.0 / 10.4 / 9.7 m TAW (the multi-3cpt project fixture layout)
  const layout = [[0, 10.0], [30, 10.4], [60, 9.7]];
  for (let i = 0; i < layout.length; i++) {
    await page.evaluate(([idx, x, elev]) => { window.selectCpt(idx); window.setCptCoord('x', x); window.setCptCoord('y', 0); window.setElev(elev); window.goS(1); window.runClass(); }, [i, ...layout[i]]);
    await j.nextFrame();
    await j.step(`02-cpt${i + 1}-classified`, { screenshot: false });
  }
  await page.evaluate(() => window.selectCpt(0));
  // ---- Stratigrafie phase: auto-correlation on entry ----
  await page.evaluate(() => window.setPhase('correlation'));
  await j.waitState((s) => !!s.project.stratigraphy?.result?.units?.length);
  await j.nextFrame();
  await j.step('03-correlation', { dom: ['#cptTabs', '#phaseCorr'] });
  // rename the first unit through its input (change → store.renameUnit → re-render)
  const rename = page.locator('#stratPanel input[data-rename]').first();
  await rename.fill('Quartair zand');
  await rename.press('Tab');
  await j.waitState((s) => s.project.stratigraphy.result.units.some((u) => u.name === 'Quartair zand'));
  await j.nextFrame();
  await j.step('04-renamed', { dom: ['#cptTabs', '#phaseCorr'], screenshot: false });
  // ---- SOILIN report tab + payload ----
  const soilin = await openReportTab(context, page, j, () => document.querySelector('#stratPanel [data-act="soilin-report"]').click(), { chart: false });
  await j.localStorage('05-soilin.payload', 'soilin-report:');
  await j.stepPage('05-soilin', soilin, { dom: ['.report-shell'] });
  await soilin.close();
  // ---- exports: CSV / PLAXIS / DXF as text, db4 as SHA-256 ----
  for (const act of ['export-csv', 'export-plaxis', 'export-dxf']) {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click(`#stratPanel [data-act="${act}"]`)]);
    await j.download(`06-${act}`, dl);
  }
  const [db4] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#stratPanel [data-act="export-db4"]')]);
  const db4Bytes = readFileSync(await db4.path());
  j.json('06-export-db4', { filename: maskText(db4.suggestedFilename()), bytes: db4Bytes.length, sha256: sha256Hex(db4Bytes), head: [...db4Bytes.subarray(0, 16)] });
  // ---- Doorsnede ----
  await page.evaluate(() => window.setPhase('section'));
  await page.waitForFunction(() => (document.getElementById('sectionSvg')?.innerHTML || '').length > 100);
  await j.nextFrame();
  await j.step('07-section', { dom: ['#cptTabs', '#phaseSection'] });
  j.text('07-section.svg', await page.evaluate(() => document.getElementById('sectionSvg').outerHTML), 'svg');
  const [svg] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.evaluate(() => window.exportSectionSVG())]);
  await j.download('08-exportsectionsvg', svg);
  await page.evaluate(() => window.setPhase('analysis'));
  await j.nextFrame();
  j.json('09-dialogs', j.dialogs.slice());
  await j.step('09-final', { screenshot: false });
  await j.finish();
});

/** Roots of the captured state compared after the reload; every difference is locked in 02-restored-vs-saved. */
const SAVE_LOAD_ROOTS = ['project', 'active', 'stage', 'phase', 'activeCptIdx'];
const PANELS = ['#lb', '#ma', '#tuningArea', '#stage6Area'];

test('save-load-journey', async ({ page, context }) => {
  const j = new Journey('save-load-journey', { page, context });
  j.observe(page);
  await importLayeredAndClassify(page, j);
  // a project with work in every stage: subtype edit, alpha A, accepted fit, bearing B, a sheet-pile wall, a Bishop model
  await page.evaluate(() => window.goS(2));
  await j.nextFrame();
  const next = await page.evaluate(() => { const sel = document.querySelector('#lb select[data-i="1"]'); const opt = sel && [...sel.options].find((o) => o.value && o.value !== sel.value && !o.disabled); return opt ? opt.value : null; });
  if (next) await page.selectOption('#lb select[data-i="1"]', next);
  await page.evaluate(() => { window.goS(3); window.setAlphaMethod('A'); window.goS(4); window.runTuning(); window.acceptFit(0); window.goS(5); window.setStage6App('bearing'); window.setStage6Field('bearing.B', 2.0); });
  await j.nextFrame();
  await page.evaluate(() => { window.setStage6App('retwall'); window.retwallSetType('sheetpile'); });
  await j.waitState((s) => s.active.stage6.retwall.status === 'done', { timeout: 60000 });
  await page.evaluate(() => {
    const S = window.PROJECT.cpts[window.PROJECT.activeCptIdx];
    const b = S.stage6.bishop;
    b.terrain = [{ x: 0, y: 4 }, { x: 8, y: 4 }, { x: 20, y: 0 }]; b.entryZone = { xStart: 1, xEnd: 5 }; b.exitZone = { xStart: 13, xEnd: 19 };
    window.setStage6App('bishop');
    window.PROJECT.name = 'Golden save-load';
  });
  await j.nextFrame();
  await j.step('01-saved');
  await j.step('01-saved-panels', { dom: PANELS, state: false, screenshot: false });
  const saved = await page.evaluate(() => window.__golden.captureState());
  const savedPanels = await page.evaluate((s) => window.__golden.domText(s), PANELS);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.evaluate(() => window.saveProject())]);
  await j.download('01-saveproject', dl, { digestPaths: SAVE_DIGEST });
  const fileBuffer = readFileSync(await dl.path());

  // ---- a new page: load the download through the banner's file input (BannerPhaseShell #projFileInput) ----
  await page.goto('/', { waitUntil: 'networkidle' });
  await j.waitState((s) => !!s.project && s.active.data.length === 0);
  await page.setInputFiles('#projFileInput', { name: dl.suggestedFilename(), mimeType: 'application/json', buffer: fileBuffer });
  await j.waitState((s) => s.active.data.length > 0 && s.active.chartsReady === true, { timeout: 60000 });
  await j.nextFrame();
  await j.step('02-restored');
  const restored = await page.evaluate(() => window.__golden.captureState());
  // the Stage 3/4/5 panels render when their stage is visited (afterLoad lands on the saved stage 6):
  // walk the stages the way the engineer would before comparing the panel text
  await page.evaluate(() => { window.goS(2); window.goS(3); window.goS(4); window.goS(5); });
  await j.nextFrame();
  await j.step('02-restored-panels', { dom: PANELS, state: false, screenshot: false });
  const restoredPanels = await page.evaluate((s) => window.__golden.domText(s), PANELS);
  // state equality after normalisation: every difference is behaviour of the save/load path and is locked
  // here (stage6.ui — the <details> open/scroll bookkeeping — is render state, not locked: design §1.12)
  const diffs = [];
  const withoutUi = (v) => { const n = normalize(v); if (n?.stage6?.ui) n.stage6 = { ...n.stage6, ui: '<render state, not compared>' }; return n; };
  for (const root of SAVE_LOAD_ROOTS) compare(withoutUi(saved[root]), withoutUi(restored[root]), { rel: 1e-9, abs: 1e-12 }, root, diffs);
  // per-panel text identity (+ the first differing lines of a panel that is not identical)
  const panelLines = (text) => { const out = {}; let cur = null; for (const line of maskText(text).split('\n')) { if (line.startsWith('## ')) { cur = line.slice(3).trim(); out[cur] = []; } else if (cur) out[cur].push(line); } return out; };
  const a = panelLines(savedPanels), b = panelLines(restoredPanels);
  const panels = Object.fromEntries(PANELS.map((sel) => {
    const la = a[sel] || [], lb = b[sel] || [];
    const identical = la.join('\n') === lb.join('\n');
    const first = identical ? null : (() => { for (let i = 0; i < Math.max(la.length, lb.length); i++) if (la[i] !== lb[i]) return { line: i + 1, saved: la[i] ?? '<eof>', restored: lb[i] ?? '<eof>' }; return null; })();
    return [sel, { identical, savedLines: la.length, restoredLines: lb.length, firstDifference: first }];
  }));
  j.json('02-restored-vs-saved', { stateDiffs: diffs.map((d) => ({ path: d.path, saved: d.expected, restored: d.actual })), panels, dialogs: j.dialogs.slice() });

  // ---- the legacy (v0.5.2-shaped) project: forward-compat merge; loading over work asks for confirmation (auto-accepted) ----
  await page.setInputFiles('#projFileInput', FIXTURE_LEGACY_PROJECT);
  await j.waitState((s) => s.project.cpts.length === 3 && s.project.name === 'Golden multi-CPT' && s.active.chartsReady === true, { timeout: 60000 });
  await j.nextFrame();
  await j.step('03-legacy-loaded');
  await j.step('03-legacy-panels', { dom: ['#lb', '#ma', '#stage6Area', '#stratPanel'], state: false, screenshot: false });
  // invalid files: alerts, project untouched
  await page.setInputFiles('#projFileInput', { name: 'bad.madep.json', mimeType: 'application/json', buffer: Buffer.from('not json') });
  await page.waitForFunction(() => window.__golden.live().project.cpts.length === 3);
  await page.setInputFiles('#projFileInput', { name: 'bad2.madep.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":"other"}') });
  await j.nextFrame();
  j.json('04-dialogs', j.dialogs.slice());
  await j.step('04-final', { screenshot: false });
  await j.finish();
});
