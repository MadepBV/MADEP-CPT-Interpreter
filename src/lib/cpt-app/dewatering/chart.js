// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// dewatering/chart.js — the four element-attached Chart.js panels of the dewatering app
// (01-monolith-map.md §2.9 "Charts" buildStage6DewateringCharts, §4.3 chart pattern 3 `canvas._chartRef`,
// refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js 12507-12534 (integration-r @ 07f0645); the three controller-state
// reads became the parameters:
//   buildDewateringCharts({ analysis, maxDepth, originalWt })
//     analysis    S.stage6Cache.dewatering — compute.js dewateringAnalysis() (nothing is drawn without it)
//     maxDepth    stage6MaxDepth() — the layer bottom, depth axis of the effective-stress chart
//     originalWt  S.wt — the undisturbed water table of the drawdown-profile chart
// Every canvas is looked up by id, its previous instance destroyed (core/chart-host.js destroyChart)
// and the new one attached as `canvas._chartRef`. `Chart` is the page global of the CDN script
// (src/routes/+page.svelte); without it the function is a no-op, as before. The time-curve panel is
// only built when the analysis carries a curve (panel.js renders its canvas under the same condition).
import { destroyChart } from '../core/chart-host.js';
import {
  buildDewateringDrawdownChartConfig,
  buildDewateringSettlementChartConfig,
  buildDewateringStressChartConfig,
  buildTimeChartConfig
} from '../chart-factories.js';

/** Canvas ids of panel.js dewateringBodyHtml, in render order. */
export const DEWATERING_CHART_IDS = Object.freeze({
  drawdown: 'stage6DewateringDrawdownChart',
  stress: 'stage6DewateringStressChart',
  settlement: 'stage6DewateringSettlementChart',
  time: 'stage6DewateringTimeChart'
});

export function buildDewateringCharts({ analysis, maxDepth, originalWt }){
  if(!analysis || typeof Chart === 'undefined') return;
  const drawCanvas = destroyChart('stage6DewateringDrawdownChart');
  if(drawCanvas){
    drawCanvas._chartRef = new Chart(drawCanvas, buildDewateringDrawdownChartConfig({
      analysis,
      originalWt
    }));
  }
  const stressCanvas = destroyChart('stage6DewateringStressChart');
  if(stressCanvas){
    stressCanvas._chartRef = new Chart(stressCanvas, buildDewateringStressChartConfig({
      analysis,
      maxDepth
    }));
  }
  const setCanvas = destroyChart('stage6DewateringSettlementChart');
  if(setCanvas){
    setCanvas._chartRef = new Chart(setCanvas, buildDewateringSettlementChartConfig({analysis}));
  }
  const timeCanvas = destroyChart('stage6DewateringTimeChart');
  if(timeCanvas && analysis.timeCurve){
    timeCanvas._chartRef = new Chart(timeCanvas, buildTimeChartConfig({
      curve:analysis.timeCurve
    }));
  }
}
