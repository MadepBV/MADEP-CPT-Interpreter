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
//
// PR 13 (style, 02-design-system.md §3.13 / §5.2 row 2e): the series colours come from the `--viz-*`
// tokens through theme.ts pileVizSeries() — chart-factories.js still builds the configs with its legacy
// literal rgba() set (that file is outside the style PRs), so the datasets are recoloured here, by
// label, before Chart.js reads the config. Data, labels, dashes and widths are untouched.
import { destroyChart } from '../core/chart-host.js';
import { pileVizSeries } from '../../styles/theme.ts';
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

/** Dataset label → series role of the De Beer chain and the load / settlement lines. */
const SERIES_BY_LABEL = Object.freeze({
  'q_c (cone)': 'qc',
  'q_h (homogeneous)': 'qh',
  'q_d (downward)': 'qd',
  'q_u (upward)': 'qu',
  'q_p (mixed)': 'qp',
  'Pile toe': 'toe',
  'Load–settlement': 'curve',
  'N(z)': 'curve',
  'F_rep': 'frep',
  'R_c,d': 'rcd',
  's_allow': 'sAllow'
});

/** Recolours the line datasets of a factory config from the resolved `--viz-*` series (§3.13). */
export function applyPileSeriesColours(config, series){
  const datasets = config?.data?.datasets || [];
  for(const ds of datasets){
    const role = SERIES_BY_LABEL[ds.label];
    if(!role || !series[role]) continue;
    ds.borderColor = series[role];
    if(ds.fill === 'origin') ds.backgroundColor = series.curveSoft;
  }
  return config;
}

/** Recolours the per-layer shaft scatter (one colour per point: excluded / above N.P. / contributing). */
export function applyPileShaftColours(config, perLayer, series){
  const ds = config?.data?.datasets?.[0];
  if(!ds) return config;
  const colours = (perLayer || []).map((row) => row.excluded ? series.excluded : row.aboveNeutral ? series.aboveNeutral : series.contributing);
  ds.backgroundColor = colours;
  ds.borderColor = colours;
  return config;
}

export function buildPileCharts({ analysis, cfg, maxDepth }){
  if(!analysis || typeof Chart === 'undefined') return;
  const cap = analysis.capacity || {};
  const set = analysis.settlement;
  const series = pileVizSeries();
  const deBeerCanvas = destroyChart('stage6PileDeBeerChart');
  if(deBeerCanvas){
    deBeerCanvas._chartRef = new Chart(deBeerCanvas, applyPileSeriesColours(buildPileDeBeerChartConfig({
      deBeer: cap.deBeer,
      maxDepth,
      zToe: cfg.zToe
    }), series));
  }
  const shaftCanvas = destroyChart('stage6PileShaftChart');
  if(shaftCanvas){
    shaftCanvas._chartRef = new Chart(shaftCanvas, applyPileShaftColours(buildPileShaftChartConfig({
      perLayer: cap.perLayer || [],
      maxDepth
    }), cap.perLayer || [], series));
  }
  const lsCanvas = destroyChart('stage6PileLoadSettlementChart');
  if(lsCanvas && set){
    lsCanvas._chartRef = new Chart(lsCanvas, applyPileSeriesColours(buildPileLoadSettlementChartConfig({
      curve: set.curve || [],
      Frep: cfg.Frep,
      Rcd: cap.R_c_d,
      sAllowable: cfg.sAllowable
    }), series));
  }
  const nCanvas = destroyChart('stage6PileAxialForceChart');
  if(nCanvas && set){
    nCanvas._chartRef = new Chart(nCanvas, applyPileSeriesColours(buildPileAxialForceChartConfig({
      trace: set.trace || [],
      zHead: cfg.zHead,
      zToe: cfg.zToe,
      Frep: cfg.Frep
    }), series));
  }
}
