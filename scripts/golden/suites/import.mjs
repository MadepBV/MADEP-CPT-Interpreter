// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks Stage 1 (design §1.2): the GEF / CSV / XLSX parsers and applyParsedCpt through the
// controller's real file path (loadGEF → importCptFiles → parse* → import-review →
// applyParsedCpt → selectCpt): parsed rows, water table / elevation / coordinate sources,
// metadata, the import-review dialog text, the Stage-1 meta card, the raw chart configs
// handed to Chart.js, and the seeded loadDemo() itself (finding F1). Also proves the
// committed demo-anonymous.gef reproduces loadDemo() row-for-row.
import { htmlToText } from '../lib/html-text.mjs';
import { mulberry32 } from '../lib/prng.mjs';

export const name = 'import';
export const tolerance = 'pure';
export const description = 'Stage 1 parsers + applyParsedCpt through loadGEF (Tier B)';

const pick = (S) => ({
  id: S.id, data: S.data, wt: S.wt, wtFromFile: S.wtFromFile, wtSource: S.wtSource,
  elev: S.elev, elevFromFile: S.elevFromFile, elevSource: S.elevSource, x: S.x, y: S.y,
  meta: S.meta, assumedRf: S.assumedRf, method: S.method, _maxStage: S._maxStage ?? 0
});
const chartSeries = (chart) => chart?.config ? { datasets: chart.config.data.datasets.map((d) => ({ label: d.label, data: d.data })), scales: chart.config.options?.scales } : null;

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  for (const fx of ctx.fixtures.importNames()) {
    const S = await ctx.loadCpt(fx);
    yield { id: fx, value: pick(S) };
    yield { id: `${fx}.alerts`, value: c.alerts.slice() };
    yield { id: `${fx}.review`, kind: 'txt', value: htmlToText(c.importReviews.at(-1) || '') };
    yield { id: `${fx}.meta-card`, kind: 'txt', value: ['mgrid', 'finfo', 'wt-src', 'elev-src', 'wt-taw'].map((id) => { const el = c.document.getElementById(id); return `[#${id}]\n${htmlToText(el.innerHTML || el.textContent)}`; }).join('') };
    yield { id: `${fx}.raw-charts`, value: { qc: chartSeries(S.charts.qc), fs: chartSeries(S.charts.fs), rf: chartSeries(S.charts.rf), chartsReady: S.chartsReady } };
    yield { id: `${fx}.banner`, kind: 'txt', value: htmlToText(c.document.getElementById('cptTabs').innerHTML) };
  }
  // loadDemo() under a seeded Math.random (the browser tier seeds the same way).
  await ctx.resetProject();
  const real = Math.random;
  Math.random = mulberry32(ctx.manifest.seed);
  try { api.loadDemo(); } finally { Math.random = real; }
  const demo = ctx.S();
  yield { id: 'demo-seeded', value: pick(demo) };
  const demoRows = JSON.stringify(demo.data);
  const gefRows = JSON.stringify((await ctx.loadCpt('demo-anonymous')).data);
  yield { id: 'demo-fixture-parity', value: { seed: ctx.manifest.seed, gefEqualsSeededLoadDemo: demoRows === gefRows, rows: demo.data.length } };
}
