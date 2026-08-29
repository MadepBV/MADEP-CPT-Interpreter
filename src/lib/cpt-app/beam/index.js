// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// beam/index.js — the Stage 6 "Beam / slab on Winkler" application as a package in the retaining/
// style (01-monolith-map.md §6.1 row `beam/`, §6.2 step 7; PLAN §2 row 12, PR 12c).
//
//   state.js             defaults() / ensure(stage6, env)        the `stage6.beam` block
//   compute.js           beamAnalysis(cfg, layers, {wt})         the stage6-engineering engines
//                        subgradeReaction(cfg, layers, {wt})     behind an explicit-input contract
//   options.js           ULS / load-pattern / model-mode / axis copy / exposure wording
//   panel.js             beamBodyHtml, orientationHtml, durabilityHtml   the HTML string builders
//                                                                         (host hook: detailsOpen)
//   chart.js             buildBeamCharts                         the two Chart.js panels + preview
//   geometry-preview.js  drawBeamGeometryPreview                 the view-only 2D-canvas preview
//
// installBeamApp(ctx) → { defaults, ensure, compute, renderBody, postRender, handlers, cardMeta,
//                         buildCharts, drawGeometryPreview }
//   ctx.getState()        the active CPT (layers, wt, stage6, stage6Cache)
//   ctx.detailsOpen(key)  stage6DetailsOpen(key) — the ` open` attribute of a remembered <details>
//
// The install result maps onto the stage6/ shell's adapter without touching the shell:
//   compute(layers)       → adapter.compute (written to S.stage6Cache.beam by the shell)
//   renderBody(analysis)  → adapter.body
//   postRender()          → adapter.postRender (the two charts + the geometry preview)
// buildCharts() / drawGeometryPreview(analysis) are what the legacy names buildStage6BeamCharts /
// drawStage6BeamGeometryPreview keep as façades.
//
// handlers is empty: every inline handler of the beam markup is the shell's setStage6Field; the app
// has no partial-update path (every field re-renders the page through the shell).
import { defaults, ensure } from './state.js';
import { beamAnalysis } from './compute.js';
import { beamBodyHtml } from './panel.js';
import { buildBeamCharts } from './chart.js';
import { drawBeamGeometryPreview } from './geometry-preview.js';

export { defaults, ensure } from './state.js';
export { analyzeBeamAndReinforcement, computeSubgradeReaction, beamAnalysis, subgradeReaction, waterTableOf, layersOf } from './compute.js';
export { ulsOptions, ulsHelp, loadPatternHelp, modelModeOptions, modelModeLabel, beamAxisCopy, momentContextHelp, exposureOptions, exposureHelp } from './options.js';
export { beamBodyHtml, orientationHtml, durabilityHtml } from './panel.js';
export { buildBeamCharts, BEAM_CHART_IDS } from './chart.js';
export { drawBeamGeometryPreview, canvasText, roundedRect, drawDimension, drawLoadArrow, BEAM_GEOMETRY_CANVAS_ID } from './geometry-preview.js';

/** The app card of the Stage 6 app switch (stage6/registry.js adds the glyph). */
export const cardMeta = {
  id: 'beam',
  title: 'Beam / slab on Winkler',
  desc: '1D strip-on-elastic-foundation screening with EC2 reinforcement output.'
};

export function installBeamApp(ctx){
  const cpt = () => ctx.getState();
  const cfg = () => cpt().stage6.beam;
  const env = () => ({ wt: cpt().wt });
  const detailsOpen = (key) => (ctx.detailsOpen ? ctx.detailsOpen(key) : '');

  /** beamAnalysis on the active CPT (the shell's compute step; the result is cached under `beam`). */
  function compute(workingLayers){
    return beamAnalysis(cfg(), workingLayers, env());
  }

  function renderBody(analysis){
    return beamBodyHtml(analysis, cfg(), { detailsOpen });
  }

  /** buildStage6BeamCharts(): the two Chart.js panels + the geometry preview from the cached analysis. */
  function buildCharts(){
    buildBeamCharts({ analysis: cpt().stage6Cache?.beam, cfg: cfg() });
  }

  /** drawStage6BeamGeometryPreview(analysis): the preview alone, on the active CPT's config. */
  function drawGeometryPreview(analysis){
    drawBeamGeometryPreview(analysis, cpt().stage6?.beam);
  }

  function postRender(){
    buildCharts();
  }

  const handlers = {};

  return { defaults, ensure, compute, renderBody, postRender, handlers, cardMeta, buildCharts, drawGeometryPreview };
}
