// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks the Stage 6 shared state (design §1.7): stage6Defaults() in full (any extraction
// that changes a default is a behaviour change), ensureStage6State() on a fresh CPT and on
// a v0.5.2-style saved project (forward-compat merge), the app switch and the shared
// banner / app-switch text of #stage6Area.
import { htmlToText } from '../lib/html-text.mjs';

export const name = 'stage6-shared';
export const tolerance = 'pure';
export const description = 'stage6Defaults, ensureStage6State migration, app switch';

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  yield { id: 'defaults', value: api.stage6Defaults() };
  await ctx.resetProject();
  api.ensureStage6State();
  yield { id: 'ensure.fresh', value: ctx.S().stage6 };
  ctx.S().stage6 = { app: 'pile', bearing: { B: 0.01, Df: 99, eB: 99, shapeMode: 'bogus' }, beam: { modelMode: 'bogus', gpOverride: '2.5', cNomOverride: '' } };
  api.ensureStage6State();
  yield { id: 'ensure.partial', value: ctx.S().stage6 };
  // legacy saved project → forward-compat merge (snapshot.js:74-85 + ensureStage6State)
  await ctx.resetProject();
  await api.loadProjectFromFile(new File([ctx.fixtures.read('projects/legacy-v0.5.2.madep.json')], 'legacy-v0.5.2.madep.json'));
  api.ensureStage6State();
  yield { id: 'ensure.legacy-v0.5.2', value: api.PROJECT.cpts.map((cpt) => cpt.stage6) };
  // app switch on a classified profile
  await ctx.classify('layered', 'sb260');
  api.goS(3); api.goS(5);
  for (const app of ['bearing', 'pile', 'settlement', 'dewatering', 'beam']) {
    api.setStage6App(app);
    const html = c.document.getElementById('stage6Area').innerHTML;
    const head = html.slice(0, Math.max(0, html.indexOf('<div class="mc2')));   // cards + shared banner precede the app body
    yield { id: `switch.${app}`, value: { app: ctx.S().stage6.app, cacheKeys: Object.keys(ctx.S().stage6Cache).sort() } };
    yield { id: `switch.${app}.head`, kind: 'txt', value: htmlToText(head || html.slice(0, 4000)) };
  }
  yield { id: 'switch.no-layers', kind: 'txt', value: (await (async () => { await ctx.resetProject(); api.renderStage6(); return htmlToText(c.document.getElementById('stage6Area').innerHTML); })()) };
}
