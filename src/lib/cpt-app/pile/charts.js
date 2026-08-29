// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// pile/charts.js — the four element-attached Chart.js panels of the pile app (01-monolith-map.md
// §4.3 pattern 3, §6.1 row `pile/`). Moved verbatim out of legacy-controller.js
// buildStage6PileCharts 11003-11043 (integration-r @ 78a2e02); the three controller-state reads
// (`S.stage6Cache.pile`, `S.stage6.pile`, `stage6MaxDepth()`) became the parameters.
//
//   buildPileCharts({ analysis, cfg, maxDepth })
//     analysis   S.stage6Cache.pile — analyzePile(...) of compute.js (nothing is drawn without it)
//     cfg        S.stage6.pile
//     maxDepth   stage6MaxDepth() — the layer bottom, the depth axis of the De Beer / shaft charts
//
// Every canvas is looked up by id, its previous instance destroyed (core/chart-host.js
// destroyChart) and the new one attached as `canvas._chartRef`. `Chart` is the global of the
// CDN script (src/routes/+page.svelte); without it the function is a no-op, as before.
import { destroyChart } from '../core/chart-host.js';
import {
  buildPileAxialForceChartConfig,
  buildPileDeBeerChartConfig,
  buildPileLoadSettlementChartConfig,
  buildPileShaftChartConfig
} from '../chart-factories.js';

/** Canvas ids of panel.js renderPileVisualsColumn, in render order. */
export const PILE_CHART_IDS = Object.freeze({
  deBeer: 'stage6PileDeBeerChart',
  shaft: 'stage6PileShaftChart',
  loadSettlement: 'stage6PileLoadSettlementChart',
  axialForce: 'stage6PileAxialForceChart'
});

export function buildPileCharts({ analysis, cfg, maxDepth }){
  if(!analysis || typeof Chart === 'undefined') return;
  const cap = analysis.capacity || {};
  const set = analysis.settlement;
  const deBeerCanvas = destroyChart('stage6PileDeBeerChart');
  if(deBeerCanvas){
    deBeerCanvas._chartRef = new Chart(deBeerCanvas, buildPileDeBeerChartConfig({
      deBeer: cap.deBeer,
      maxDepth,
      zToe: cfg.zToe
    }));
  }
  const shaftCanvas = destroyChart('stage6PileShaftChart');
  if(shaftCanvas){
    shaftCanvas._chartRef = new Chart(shaftCanvas, buildPileShaftChartConfig({
      perLayer: cap.perLayer || [],
      maxDepth
    }));
  }
  const lsCanvas = destroyChart('stage6PileLoadSettlementChart');
  if(lsCanvas && set){
    lsCanvas._chartRef = new Chart(lsCanvas, buildPileLoadSettlementChartConfig({
      curve: set.curve || [],
      Frep: cfg.Frep,
      Rcd: cap.R_c_d,
      sAllowable: cfg.sAllowable
    }));
  }
  const nCanvas = destroyChart('stage6PileAxialForceChart');
  if(nCanvas && set){
    nCanvas._chartRef = new Chart(nCanvas, buildPileAxialForceChartConfig({
      trace: set.trace || [],
      zHead: cfg.zHead,
      zToe: cfg.zToe,
      Frep: cfg.Frep
    }));
  }
}
