// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// dewatering/index.js — the Stage 6 "Dewatering" application as a package in the retaining/ style
// (01-monolith-map.md §6.1 row `dewatering/`, §6.2 step 7; PLAN §2 row 12, PR 12c).
//
//   state.js    defaults() / ensure(stage6, env)         the `stage6.dewatering` block
//   compute.js  dewateringAnalysis(cfg, layers, {wt})    the stage6-engineering analyzeDewatering engine
//                                                        behind an explicit-input contract
//   options.js  combinationOptions / combinationHelp     the "Combination context" wording
//   panel.js    dewateringBodyHtml                       the HTML string builder (reads env.wt)
//   chart.js    buildDewateringCharts                    the four Chart.js panels
//
// installDewateringApp(ctx) → { defaults, ensure, compute, renderBody, postRender, handlers, cardMeta, buildCharts }
//   ctx.getState()        the active CPT (layers, wt, stage6, stage6Cache)
//   ctx.layerBottom()     stage6MaxDepth() — the depth axis of the effective-stress chart
//
// The install result maps onto the stage6/ shell's adapter without touching the shell:
//   compute(layers)       → adapter.compute (written to S.stage6Cache.dewatering by the shell)
//   renderBody(analysis)  → adapter.body
//   postRender()          → adapter.postRender (builds the charts)
// buildCharts() is what the legacy name buildStage6DewateringCharts keeps as a façade.
//
// handlers is empty: every inline handler of the dewatering markup is the shell's setStage6Field; the
// app has no <details> accordion and no partial-update path (every field re-renders the page).
import { defaults, ensure } from './state.js';
import { dewateringAnalysis } from './compute.js';
import { dewateringBodyHtml } from './panel.js';
import { buildDewateringCharts } from './chart.js';

export { defaults, ensure } from './state.js';
export { analyzeDewatering, dewateringAnalysis, waterTableOf, layersOf } from './compute.js';
export { combinationOptions, combinationHelp } from './options.js';
export { dewateringBodyHtml } from './panel.js';
export { buildDewateringCharts, DEWATERING_CHART_IDS } from './chart.js';

/** The app card of the Stage 6 app switch (stage6/registry.js adds the glyph). */
export const cardMeta = {
  id: 'dewatering',
  title: 'Dewatering',
  desc: 'Drawdown screening plus induced stress change and settlement at the CPT.'
};

export function installDewateringApp(ctx){
  const cpt = () => ctx.getState();
  const cfg = () => cpt().stage6.dewatering;
  const env = () => ({ wt: cpt().wt });

  /** dewateringAnalysis on the active CPT (the shell's compute step; the result is cached under `dewatering`). */
  function compute(workingLayers){
    return dewateringAnalysis(cfg(), workingLayers, env());
  }

  function renderBody(analysis){
    return dewateringBodyHtml(analysis, cfg(), env());
  }

  /** buildStage6DewateringCharts(): the four Chart.js panels from the cached analysis. */
  function buildCharts(){
    buildDewateringCharts({ analysis: cpt().stage6Cache?.dewatering, maxDepth: ctx.layerBottom(), originalWt: cpt().wt });
  }

  function postRender(){
    buildCharts();
  }

  const handlers = {};

  return { defaults, ensure, compute, renderBody, postRender, handlers, cardMeta, buildCharts };
}
