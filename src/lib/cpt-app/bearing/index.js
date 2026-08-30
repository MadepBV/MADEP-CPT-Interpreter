// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// bearing/index.js — the Stage 6 "Bearing capacity" application as a package in the retaining/
// style (01-monolith-map.md §6.1 row `bearing/`, §6.2 step 7; PLAN §2 row 12, PR 12a).
//
//   state.js    defaults() / ensure(stage6, env)             the `stage6.bearing` block
//   compute.js  bearingAtDepth, bearingProfile, factors, EC7  pure, explicit inputs (cfg, layers, {wt})
//   notes.js    option lists, help texts, result notes        pure text
//   panel.js    the HTML string builders                      pure (host hook: detailsOpen)
//   preview.js  refreshBearingPreview                         partial DOM update on the Df slider
//   chart.js    buildBearingChart, createChartQueue           Chart.js instance + 20 ms debounce
//
// installBearingApp(ctx) → { defaults, ensure, renderBody, postRender, handlers, cardMeta, … }
//   ctx.getState()        the active CPT (layers, wt, stage6, stage6Cache)
//   ctx.ensure()          ensureStage6State() — run before the preview refresh, as the monolith did
//   ctx.workingLayers()   stage6WorkingLayers() — the Stage 4 → Stage 6 layer contract
//   ctx.detailsOpen(key)  stage6DetailsOpen(key) — the ` open` attribute of a remembered <details>
//
// The install result maps onto the stage6/ shell's adapter without touching the shell:
//   compute(layers)       → adapter.compute (written to S.stage6Cache.bearing by the shell)
//   renderBody(profile)   → adapter.body
//   postRender()          → adapter.postRender (builds the chart)
// plus the three entry points the legacy window API keeps as façades: refreshPreview()
// (refreshStage6BearingPreview — the `bearing.Df` short-circuit of setStage6Field), queueChartBuild()
// (queueStage6BearingChartBuild) and buildChart() (buildStage6BearingChart).
//
// handlers is empty: every inline handler of the bearing markup is the shell's setStage6Field, and the
// compute / panel names the window API publishes (layerAtDepth, bearingAtDepth, bearingProfile,
// stage6ShapeFactors, stage6Bearing*Html) stay façades in the host until the composition root (step 10).
import { defaults, ensure } from './state.js';
import { bearingProfile, bearingAtDepth, layerAtDepth, shapeFactors } from './compute.js';
import {
  bearingBodyHtml,
  selectedDepthHtml,
  materialParamsHtml,
  drainedFormulaHtml,
  undrainedFormulaHtml
} from './panel.js';
import { refreshBearingPreview } from './preview.js';
import { buildBearingChart, createChartQueue } from './chart.js';

export { defaults, ensure } from './state.js';
export {
  layerAtDepth,
  bearingGeometry,
  shapeModeLabel,
  ngammaLabel,
  shapeFactors,
  depthFactors,
  ngamma,
  usesEc7Factors,
  capacityLabel,
  factorLabel,
  factorValue,
  ec7Keys,
  ec7Spec,
  bearingAtDepth,
  bearingProfile
} from './compute.js';
export {
  shapeModeDetailHtml,
  shapeModeDetailText,
  ec7Options,
  ec7Help,
  shapeModeOptions,
  shapeModeHelp,
  bearingNotes
} from './notes.js';
export {
  governingResistance,
  selectedDepthHtml,
  materialParamsHtml,
  drainedFormulaHtml,
  undrainedFormulaHtml,
  bearingBodyHtml
} from './panel.js';
export { refreshBearingPreview } from './preview.js';
export { buildBearingChart, createChartQueue, BEARING_CHART_ID } from './chart.js';

/** The app card of the Stage 6 app switch (stage6/registry.js adds the glyph). */
export const cardMeta = {
  id: 'bearing',
  title: 'Bearing capacity',
  desc: 'Drained and undrained shallow-foundation resistance vs founding depth.'
};

export function installBearingApp(ctx) {
  const cpt = () => ctx.getState();
  const cfg = () => cpt().stage6.bearing;
  const layers = () => (ctx.workingLayers && ctx.workingLayers()) || [];
  const env = () => ({ wt: cpt().wt });
  const detailsOpen = (key) => (ctx.detailsOpen ? ctx.detailsOpen(key) : '');

  /** bearingProfile(cfg, layers) as the shell's compute step (the result is cached under `bearing`). */
  function compute(workingLayers) {
    return bearingProfile(cfg(), workingLayers, env());
  }

  function renderBody(profile) {
    return bearingBodyHtml(profile, cfg(), { detailsOpen });
  }

  function buildChart() {
    buildBearingChart(cpt());
  }
  const queueChartBuild = createChartQueue(buildChart);

  function postRender() {
    buildChart();
  }

  /** refreshStage6BearingPreview(): ensure, then the partial update of the bearing page. */
  function refreshPreview() {
    ctx.ensure();
    refreshBearingPreview(cpt(), layers, queueChartBuild);
  }

  /* The Stage 6 bearing names the window API publishes (PR 20 / refactor step 10). The four
     compute entry points keep the monolith signatures: `layers` falls back to the Stage 4 working
     layers and the water table comes from the active CPT. */
  const handlers = {
    layerAtDepth: (z, layers_) => layerAtDepth(z, layers_ || layers()),
    bearingAtDepth: (z, config, layers_) => bearingAtDepth(z, config, layers_ || layers(), env()),
    bearingProfile: (config, layers_) => bearingProfile(config, layers_ || layers(), env()),
    // Backward-compatible alias for callers that still expect the old helper name.
    stage6ShapeFactors: shapeFactors,
    stage6BearingSelectedDepthHtml: selectedDepthHtml,
    stage6BearingMaterialParamsHtml: materialParamsHtml,
    stage6BearingDrainedFormulaHtml: drainedFormulaHtml,
    stage6BearingUndrainedFormulaHtml: undrainedFormulaHtml,
    queueStage6BearingChartBuild: queueChartBuild,
    refreshStage6BearingPreview: refreshPreview,
    buildStage6BearingChart: buildChart
  };

  return { defaults, ensure, renderBody, postRender, handlers, cardMeta, compute, refreshPreview, queueChartBuild, buildChart };
}
