// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// beam/chart.js — the two element-attached Chart.js panels of the beam / slab app plus the geometry
// preview they are built with (01-monolith-map.md §2.9 "Charts" buildStage6BeamCharts, §4.3 chart pattern 3
// `canvas._chartRef`, refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js 12536-12557 (integration-r @ 07f0645); the two
// controller-state reads became the parameters:
//   buildBeamCharts({ analysis, cfg })
//     analysis   S.stage6Cache.beam — compute.js beamAnalysis() (nothing is drawn without it)
//     cfg        S.stage6.beam — read by the geometry preview (the monolith read it inside
//                drawStage6BeamGeometryPreview; now handed in from the same call)
// The Chart.js panels need the page global `Chart` (src/routes/+page.svelte); the geometry preview
// (geometry-preview.js) is drawn either way, as before. stage6CompactNumber → core/format compactNumber.
import { destroyChart } from '../core/chart-host.js';
import { compactNumber } from '../core/format.js';
import { buildBeamDeflectionChartConfig, buildBeamMomentChartConfig } from '../chart-factories.js';
import { drawBeamGeometryPreview } from './geometry-preview.js';

/** Canvas ids of panel.js beamBodyHtml, in render order. */
export const BEAM_CHART_IDS = Object.freeze({
  deflection: 'stage6BeamDeflectionChart',
  moment: 'stage6BeamMomentChart'
});

export function buildBeamCharts({ analysis, cfg }){
  if(!analysis) return;
  if(typeof Chart !== 'undefined'){
    const tickFmt = (value)=>compactNumber(value, 2);
    const defCanvas = destroyChart('stage6BeamDeflectionChart');
    if(defCanvas){
      defCanvas._chartRef = new Chart(defCanvas, buildBeamDeflectionChartConfig({
        analysis,
        tickFormatter:tickFmt
      }));
    }
    const momentCanvas = destroyChart('stage6BeamMomentChart');
    if(momentCanvas){
      momentCanvas._chartRef = new Chart(momentCanvas, buildBeamMomentChartConfig({
        analysis,
        tickFormatter:tickFmt
      }));
    }
  }
  drawBeamGeometryPreview(analysis, cfg);
}
