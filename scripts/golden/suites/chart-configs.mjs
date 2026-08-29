// SPDX-License-Identifier: AGPL-3.0-or-later
// Locks the Chart.js configuration objects (design §2.1 `chart-configs`): what the app
// hands to `new Chart(canvas, config)` for the Stage 1 raw-profile charts (S.charts.*,
// kept by the Chart stub of load-controller.mjs), the Stage 5 tuning charts (built from
// the `data-*` attributes tuning/panel.js writes for tuning/charts.js — the stub has no
// querySelectorAll, so the two chart-factories builders are called on the parsed
// attributes exactly as buildTuningCharts does) and the Stage 6 app charts read back from
// `canvas._chartRef.config` after setStage6App() (bearing, settlement, dewatering, beam
// and the four pile panels), plus the line-probe chart config on a synthetic probe.
// Functions inside the configs (tick formatters, tooltip callbacks) are dropped by the
// normaliser; datasets, scales and labels are what gets locked.
import { buildTuningRegressionChartConfig, buildTuningDepthChartConfig, buildLineProbeChartConfig } from '../../../src/lib/cpt-app/chart-factories.js';

export const name = 'chart-configs';
export const tolerance = 'pure';
export const description = 'Chart.js configs of Stages 1, 5 and 6 (build*ChartConfig via the controller + direct builders)';

const STAGE6_CANVASES = {
  bearing: ['stage6BearingChart'],
  pile: ['stage6PileDeBeerChart', 'stage6PileShaftChart', 'stage6PileLoadSettlementChart', 'stage6PileAxialForceChart'],
  settlement: ['stage6SettlementStressChart', 'stage6SettlementCumulativeChart', 'stage6SettlementTimeChart'],
  dewatering: ['stage6DewateringDrawdownChart', 'stage6DewateringStressChart', 'stage6DewateringSettlementChart', 'stage6DewateringTimeChart'],
  beam: ['stage6BeamDeflectionChart', 'stage6BeamMomentChart']
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unesc = (s) => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** The `<div data-chart-pending …>` blocks of #tuningArea → one attribute map per layer card. */
export function parseTuningChartBlocks(html) {
  const blocks = [];
  const re = /<div(?:\s+hidden)?\s+data-chart-pending="([^"]+)"([\s\S]*?)>\s*<\/div>/g;   // `hidden` added by the Stage 5 restyle (PR 10)
  let m;
  while ((m = re.exec(html))) {
    const attrs = { chartPending: m[1] };
    const attrRe = /data-([a-z-]+)=(?:'([^']*)'|"([^"]*)")/g;
    let a;
    while ((a = attrRe.exec(m[2]))) attrs[a[1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = unesc(a[2] ?? a[3]);
    blocks.push(attrs);
  }
  return blocks;
}

export async function* cases(ctx) {
  const c = await ctx.controller();
  const { api } = c;
  for (const fx of ctx.fixtures.stage6Names()) {
    const S = await ctx.classify(fx, 'sb260');
    // Stage 1 raw profile charts (kept by the Chart stub)
    for (const key of Object.keys(S.charts || {}).sort()) {
      yield { id: `${fx}.raw.${key}`, value: S.charts[key]?.config ?? null };
    }
    // Stage 5 tuning charts from the card data attributes
    api.goS(3); api.goS(4); api.runTuning();
    const blocks = parseTuningChartBlocks(c.document.getElementById('tuningArea').innerHTML);
    yield { id: `${fx}.tuning.blocks`, value: blocks.map((b) => ({ ...b, scatter: undefined, defaultLine: undefined, fitLine: undefined, depthPts: undefined, eoedI: undefined, hsDefault: undefined, hsFit: undefined })) };
    for (const el of blocks) {
      const regression = buildTuningRegressionChartConfig({ scatter: JSON.parse(el.scatter), defaultLine: JSON.parse(el.defaultLine), previewLine: JSON.parse(el.fitLine), mDefault: el.mDef, mPreview: el.mFit, quality: el.quality, invalidSlope: el.invalidSlope === '1' });
      yield { id: `${fx}.tuning.${el.chartPending}.regression`, value: regression };
      const depth = buildTuningDepthChartConfig({ depths: JSON.parse(el.depthPts), eoedI: JSON.parse(el.eoedI), hsDefault: JSON.parse(el.hsDefault), hsPreview: JSON.parse(el.hsFit), layerTop: parseFloat(el.layerTop), layerBot: parseFloat(el.layerBot), wt: parseFloat(el.wt), mDefault: el.mDef, mPreview: el.mFit, quality: el.quality, invalidSlope: el.invalidSlope === '1' });
      yield { id: `${fx}.tuning.${el.chartDepth}.depth`, value: depth };
    }
    // Stage 6 app charts
    api.goS(5);
    for (const [app, ids] of Object.entries(STAGE6_CANVASES)) {
      api.setStage6App(app);
      await sleep(40);        // bearing/chart.js createChartQueue debounces the slider-driven rebuild by 20 ms
      for (const id of ids) {
        const canvas = c.document.getElementById(id);
        yield { id: `${fx}.stage6.${app}.${id}`, value: canvas?._chartRef?.config ?? null };
      }
    }
  }
  // line-probe chart on a synthetic probe (the Seep/Slope measurement line)
  const points = Array.from({ length: 21 }, (_, i) => ({ s: i * 0.5, value: 3 - 0.1 * i + 0.02 * Math.sin(i) }));
  yield { id: 'line-probe.synthetic', value: buildLineProbeChartConfig({ points, title: 'Head along measurement line', seriesLabel: 'Head', color: '#4F8584', xAxisTitle: 'Distance along line s (m)', yAxisTitle: 'Head (m)', xTickFormatter: (v) => String(v), yTickFormatter: (v) => String(v), tooltipLabel: (v) => String(v) }) };
}
