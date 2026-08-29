// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// core/chart-host.js — lifecycle of the element-attached Chart.js instances
// (`canvas._chartRef`, monolith map §4.3 pattern 3).
//
// Moved verbatim out of src/lib/cpt-app/legacy-controller.js (PR 4, refactor step 1):
//   stage6DestroyChart  16832-16836  → destroyChart
// New, not yet wired into the monolith (a pure move must stay bit-identical;
// the 20 inline `canvas._chartRef = new Chart(...)` sites and the `typeof Chart`
// poll of initCharts (:1670) adopt these in the per-app extraction steps):
//   attachChart(canvas, chart)  — the `canvas._chartRef = chart` idiom
//   chartAvailable()            — `typeof Chart !== 'undefined'`
//   waitForChart(fn, intervalMs)— the 120 ms re-poll used by initCharts

export function destroyChart(id){
  const canvas = document.getElementById(id);
  if(canvas && canvas._chartRef && canvas._chartRef.destroy) canvas._chartRef.destroy();
  return canvas;
}

export function attachChart(canvas, chart){
  if(!canvas) return null;
  canvas._chartRef = chart;
  return chart;
}

export function chartAvailable(){
  return typeof Chart !== 'undefined';
}

export function waitForChart(fn, intervalMs = 120){
  if(chartAvailable()){ fn(); return true; }
  setTimeout(()=>waitForChart(fn, intervalMs), intervalMs);
  return false;
}
