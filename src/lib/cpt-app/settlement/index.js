// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// settlement/index.js — the Stage 6 "Settlement" application as a package in the retaining/ style
// (01-monolith-map.md §6.1 row `settlement/`, §6.2 step 7; PLAN §2 row 12, PR 12c).
//
//   state.js    defaults() / ensure(stage6, env)         the `stage6.settlement` block
//   compute.js  settlementAnalysis(cfg, layers, {wt})    the stage6-engineering analyzeSettlement engine
//                                                        behind an explicit-input contract
//   options.js  useCategory* / slsCombination* builders  the Eurocode load-combination wording (shared
//                                                        with the beam app)
//   panel.js    settlementBodyHtml                       the HTML string builder (host hook: detailsOpen)
//   chart.js    buildSettlementCharts                    the three Chart.js panels
//
// installSettlementApp(ctx) → { defaults, ensure, compute, renderBody, postRender, handlers, cardMeta, buildCharts }
//   ctx.getState()        the active CPT (layers, wt, stage6, stage6Cache)
//   ctx.layerBottom()     stage6MaxDepth() — the depth axis of the stress-increase chart
//   ctx.detailsOpen(key)  stage6DetailsOpen(key) — the ` open` attribute of a remembered <details>
//
// The install result maps onto the stage6/ shell's adapter without touching the shell:
//   compute(layers)       → adapter.compute (written to S.stage6Cache.settlement by the shell)
//   renderBody(analysis)  → adapter.body
//   postRender()          → adapter.postRender (builds the charts)
// buildCharts() is what the legacy name buildStage6SettlementCharts keeps as a façade.
//
// handlers is empty: every inline handler of the settlement markup is the shell's setStage6Field; the
// app has no partial-update path (every field re-renders the page through the shell).
import { defaults, ensure } from './state.js';
import { settlementAnalysis } from './compute.js';
import { settlementBodyHtml } from './panel.js';
import { buildSettlementCharts } from './chart.js';

export { defaults, ensure } from './state.js';
export { analyzeSettlement, settlementAnalysis, waterTableOf, layersOf } from './compute.js';
export { useCategoryOptions, useCategoryHelp, slsCombinationOptions, slsCombinationHelp } from './options.js';
export { settlementBodyHtml } from './panel.js';
export { buildSettlementCharts, SETTLEMENT_CHART_IDS } from './chart.js';

/** The app card of the Stage 6 app switch (stage6/registry.js adds the glyph). */
export const cardMeta = {
  id: 'settlement',
  title: 'Settlement',
  desc: 'SLS settlement from CPT-derived E_oed with Boussinesq or 2:1 stress spread.'
};

export function installSettlementApp(ctx){
  const cpt = () => ctx.getState();
  const cfg = () => cpt().stage6.settlement;
  const env = () => ({ wt: cpt().wt });
  const detailsOpen = (key) => (ctx.detailsOpen ? ctx.detailsOpen(key) : '');

  /** settlementAnalysis on the active CPT (the shell's compute step; the result is cached under `settlement`). */
  function compute(workingLayers){
    return settlementAnalysis(cfg(), workingLayers, env());
  }

  function renderBody(analysis){
    return settlementBodyHtml(analysis, cfg(), { detailsOpen });
  }

  /** buildStage6SettlementCharts(): the three Chart.js panels from the cached analysis. */
  function buildCharts(){
    buildSettlementCharts({ analysis: cpt().stage6Cache?.settlement, maxDepth: ctx.layerBottom() });
  }

  function postRender(){
    buildCharts();
  }

  const handlers = {};

  return { defaults, ensure, compute, renderBody, postRender, handlers, cardMeta, buildCharts };
}
