// SPDX-License-Identifier: AGPL-3.0-or-later
// Stage 6 "Retaining walls": the real app in Chromium — demo CPT → classification → layers → model →
// Stage 6, every wall type and result tab renders without console errors, the section handles drag,
// drivability and vibration run, and the calculation note opens with content.
import { test, expect } from '@playwright/test';

async function openRetainingWalls(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByText('Load demo — anonymous profile').click();
  await page.waitForTimeout(800);
  await page.evaluate(() => { window.goS(1); window.runClass(); });
  await page.waitForTimeout(800);
  for (const n of [2, 3, 4, 5]) { await page.evaluate((k) => window.goS(k), n); await page.waitForTimeout(500); }
  await page.evaluate(() => window.setStage6App('retwall'));
  await page.waitForTimeout(1500);
  return errors;
}

test('every wall type and result tab renders without errors', async ({ page }) => {
  const errors = await openRetainingWalls(page);
  await expect(page.locator('#retwallCanvas')).toBeVisible();
  for (const type of ['cantilever', 'gravity', 'sheetpile', 'anchored', 'soldierpile']) {
    await page.evaluate((t) => window.retwallSetType(t), type);
    await page.waitForTimeout(1200);
    await expect(page.locator('#retwallSummary')).toContainText(/Governing values|COMPUTING|NO RESULT/);
    const tabs = await page.locator('#retwallResultTabs button').allTextContents();
    for (const tab of tabs) {
      await page.locator('#retwallResultTabs button', { hasText: tab }).click();
      await page.waitForTimeout(400);
      const body = await page.locator('#retwallResultBody').innerText();
      expect(body.length, `${type}/${tab} body`).toBeGreaterThan(20);
    }
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('section handle drag updates the embedment and re-runs the analysis', async ({ page }) => {
  await openRetainingWalls(page);
  await page.evaluate(() => window.retwallSetType('sheetpile'));
  await page.waitForTimeout(1200);
  const before = await page.evaluate(() => Number(document.querySelectorAll('#retwallInputs input')[1].value));
  const h = await page.evaluate(() => { const c = document.getElementById('retwallCanvas'); const t = c.__rwTest; const hd = t.handles.find((x) => x.id === 'embedTip'); const s = t.screen(hd.x, hd.y); const r = c.getBoundingClientRect(); return { x: r.left + s.x, y: r.top + s.y }; });
  await page.mouse.move(h.x, h.y); await page.mouse.down(); await page.mouse.move(h.x, h.y + 40, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => Number(document.querySelectorAll('#retwallInputs input')[1].value));
  expect(after).toBeGreaterThan(before);
  expect(Math.round(after * 100) / 100).toBe(after);
});

test('drivability, vibration and the calculation note', async ({ page, context }) => {
  await openRetainingWalls(page);
  await page.evaluate(() => { window.retwallSetType('soldierpile'); });
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.retwallRunDrivability());
  await page.waitForTimeout(3500);
  await expect(page.locator('#retwallResultBody')).toContainText('Minimum vibrator');
  // describe the vibrator by a supplier data sheet (SAES HST070) and re-run: verdict + carrier check + section marker
  await page.evaluate(() => {
    const set = window.retwallSet;
    set('drivability.vibrator.source', 'sheet');
    set('drivability.vibrator.sheet.name', 'SAES HST070');
    for (const [k, v] of Object.entries({ force_kN: 205, rpmMax: 2900, rpmMin: 2400, amplitude_mm: 12, totalMass_kg: 965, flow_lmin: 175, flowMax_lmin: 215, pressure_bar: 200, pressureMax_bar: 230, power_kW: 66, carrierMin_t: 22, carrierMax_t: 37 })) set(`drivability.vibrator.sheet.${k}`, v);
    for (const [k, v] of Object.entries({ mass_t: 30, flow_lmin: 200, pressure_bar: 220 })) set(`drivability.vibrator.carrier.${k}`, v);
    window.retwallRunDrivability();
  });
  await page.waitForTimeout(3500);
  await expect(page.locator('#retwallResultBody')).toContainText('Achievable depth —');
  await expect(page.locator('#retwallResultBody')).toContainText('Carrier check');
  const inputsScroll = await page.evaluate(() => { const el = document.getElementById('retwallInputs'); el.scrollTop = 300; return el.scrollTop; });
  await page.evaluate(() => window.retwallSet('drivability.vibrator.sheet.rpmOperating', 2600));
  await page.waitForTimeout(400);
  const afterScroll = await page.evaluate(() => document.getElementById('retwallInputs').scrollTop);
  expect(Math.abs(afterScroll - inputsScroll)).toBeLessThan(2);
  await page.evaluate(() => window.retwallSet('ui.resultTab', 'vibration'));
  await page.waitForTimeout(800);
  await expect(page.locator('#retwallResultBody')).toContainText('Receiver assessment');
  const [note] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => window.retwallOpenNote())]);
  await note.waitForLoadState('networkidle');
  await expect(note.locator('h1')).toContainText(/Verificatie/);
  await expect(note.locator('body')).toContainText('Laterale weerstand');
  await expect(note.locator('body')).toContainText('Toetsingen');
});
