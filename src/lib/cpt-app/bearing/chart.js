// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// bearing/chart.js — the q_d / q_allow vs founding-depth Chart.js instance of the bearing app
// (01-monolith-map.md §2.7 "Render" buildStage6BearingChart / queueStage6BearingChartBuild, §4.3 chart
// pattern 3 `canvas._chartRef`; refactor step 7 / PR 12a).
//
// Moved verbatim out of legacy-controller.js (integration-r line numbers):
//   buildStage6BearingChart      14217-14230 → buildBearingChart(cpt) (`S` → cpt; stage6DestroyChart → core/chart-host destroyChart)
//   queueStage6BearingChartBuild 10656-10662 (+ the module-level timer 10655) → createChartQueue(build, delayMs = 20)
//                                the 20 ms debounce of the slider-driven rebuild, now a closure per installed app
// Chart.js is the page global `Chart` (src/routes/+page.svelte); without it the build is a no-op, as before.
import { destroyChart } from '../core/chart-host.js';
import { buildBearingChartConfig } from '../chart-factories.js';
import { capacityLabel } from './compute.js';

/** Canvas id of the bearing chart (panel.js renders it). */
export const BEARING_CHART_ID = 'stage6BearingChart';

export function buildBearingChart(cpt){
  const canvas = destroyChart(BEARING_CHART_ID);
  const data = cpt.stage6Cache?.bearing;
  if(!canvas || !data || typeof Chart === 'undefined') return;
  const cfg = cpt.stage6.bearing;
  const chart = new Chart(canvas, buildBearingChartConfig({
    data,
    cfg,
    capacityAxisTitle:capacityLabel(cfg)==='q_d'
      ? 'Design bearing capacity q_d (kPa)'
      : 'Allowable bearing capacity q_allow (kPa)'
  }));
  canvas._chartRef = chart;
}

export function createChartQueue(build, delayMs = 20){
  let timer = null;
  return function queueChartBuild(){
    if(timer) clearTimeout(timer);
    timer = setTimeout(()=>{
      timer = null;
      build();
    }, delayMs);
  };
}
