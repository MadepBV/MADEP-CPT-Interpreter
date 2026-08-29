// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks the Stage 7 report payload (design §1.11) — the canonical end-to-end golden:
// buildStage7Payload() after the full chain (sb260 classification, tuning with one accepted
// fit, every Stage 6 app rendered once so all annexes are present, :18087-18118), the
// isStage7Payload() validator verdict, and openStage7Report()'s storage/tab side effects.
import { isStage7Payload } from '../../../src/lib/cpt-app/report-storage.js';
import { digest } from '../lib/normalize.mjs';

export const name = 'report';
export const tolerance = 'pure';
export const description = 'Stage 7 buildStage7Payload() after the full Stage 2–6 chain';

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  for (const fx of ctx.fixtures.stage6Names()) {
    const S = await ctx.classify(fx, 'sb260');
    api.goS(2);
    if (S.layers.length > 1) api.changeSubtype({ dataset: { i: '1' }, value: S.layers[1].type === 'Sand' ? 'zand, vast' : 'klei, vast' });
    api.goS(3); api.goS(4); api.runTuning(); api.acceptFit(0);
    api.goS(5);
    for (const app of ['bearing', 'pile', 'settlement', 'dewatering', 'beam']) api.setStage6App(app);
    api.setStage6App('bearing');
    c.alerts.length = 0; c.opened.length = 0;
    const payload = api.buildStage7Payload();
    // `layered` is kept in full (the canonical Stage 7 golden); for the other fixtures the
    // row tables and the annex analyses — locked in import/classification/stage6-* — are digested.
    const slim = fx === 'layered' ? payload : { ...payload, rawRows: digest(payload.rawRows), classifiedRows: digest(payload.classifiedRows), chartInputs: digest(payload.chartInputs),
      stage6: payload.stage6 && Object.fromEntries(Object.entries(payload.stage6).map(([k, v]) => [k, v && typeof v === 'object' && 'analysis' in v ? { ...v, analysis: digest(v.analysis) } : v])) };
    yield { id: fx, value: slim };
    yield { id: `${fx}.valid`, value: { isStage7Payload: isStage7Payload(payload), alerts: c.alerts.slice() } };
    api.openStage7Report();
    const keys = [...c.document ? globalThis.localStorage._map.keys() : []].filter((k) => k.startsWith('stage7-report:'));
    yield { id: `${fx}.open`, value: { storedKeys: keys, opened: c.opened.map((u) => u.replace(/key=.*$/, 'key=<key>')), alerts: c.alerts.slice() } };
  }
  await ctx.resetProject();
  c.alerts.length = 0;
  yield { id: 'no-layers', value: { payload: api.buildStage7Payload(), alerts: c.alerts.slice() } };
}
