// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// settlement/chart.js — the three element-attached Chart.js panels of the settlement app
// (01-monolith-map.md §2.9 "Charts" buildStage6SettlementCharts, §4.3 chart pattern 3 `canvas._chartRef`,
// refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js 12485-12505 (integration-r @ 07f0645); the two controller-state
// reads became the parameters:
//   buildSettlementCharts({ analysis, maxDepth })
//     analysis   S.stage6Cache.settlement — compute.js settlementAnalysis() (nothing is drawn without it)
//     maxDepth   stage6MaxDepth() — the layer bottom, depth axis of the stress-increase chart
// Every canvas is looked up by id, its previous instance destroyed (core/chart-host.js destroyChart)
// and the new one attached as `canvas._chartRef`. `Chart` is the page global of the CDN script
// (src/routes/+page.svelte); without it the function is a no-op, as before. The time-curve panel is
// only built when the analysis carries a curve (panel.js renders its canvas under the same condition).
import { destroyChart } from '../core/chart-host.js';
import { buildSettlementCumulativeChartConfig, buildSettlementStressChartConfig, buildTimeChartConfig } from '../chart-factories.js';

/** Canvas ids of panel.js settlementBodyHtml, in render order. */
export const SETTLEMENT_CHART_IDS = Object.freeze({
  stress: 'stage6SettlementStressChart',
  cumulative: 'stage6SettlementCumulativeChart',
  time: 'stage6SettlementTimeChart'
});

export function buildSettlementCharts({ analysis, maxDepth }){
  if(!analysis || typeof Chart === 'undefined') return;
  const stressCanvas = destroyChart('stage6SettlementStressChart');
  if(stressCanvas){
    stressCanvas._chartRef = new Chart(stressCanvas, buildSettlementStressChartConfig({
      analysis,
      maxDepth
    }));
  }
  const cumCanvas = destroyChart('stage6SettlementCumulativeChart');
  if(cumCanvas){
    cumCanvas._chartRef = new Chart(cumCanvas, buildSettlementCumulativeChartConfig({analysis}));
  }
  const timeCanvas = destroyChart('stage6SettlementTimeChart');
  if(timeCanvas && analysis.timeCurve){
    timeCanvas._chartRef = new Chart(timeCanvas, buildTimeChartConfig({
      curve:analysis.timeCurve
    }));
  }
}
