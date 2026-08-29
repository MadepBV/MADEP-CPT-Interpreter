// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// pile/index.js — the Stage 6 "Piles" application in the retaining/ style (01-monolith-map.md
// §6.1 row `pile/`, §6.2 step 7, PLAN §0.4): pure modules, a `defaults()/ensure()` state
// schema, string-building panels, and one `installPileApp(ctx)` that returns the shape the
// Stage 6 registry / shell consume.
//
//   state.js         defaults(), ensure(stage6, env)            the `pile` block of S.stage6
//   compute.js       analyzePile(layers, wt, data, cfg), PILE_CONSTANTS, … (was stage6-pile.js)
//   panel.js         renderPileApp(cfg, analysis, detailsOpen) + the four column / table builders
//   charts.js        buildPileCharts({analysis, cfg, maxDepth})  the four Chart.js panels
//   canvas.js        drawStage6PileSection, ensurePileCanvasState, stage6PileSnapZ,
//                    buildPileSectionMarkup                       (was stage6-pile-canvas.js)
//   section-live.js  createPileSectionLive(ctx)                  the drag rAF loop + hooks
//
// installPileApp(ctx) → { defaults, ensure, compute, renderBody, postRender, handlers, cardMeta,
//                         buildCharts, sectionLive }
//   ctx.getState()        the active CPT (S)
//   ctx.requestRender()   renderStage6() — full Stage 6 re-render (drag end)
//   ctx.workingLayers()   stage6WorkingLayers()
//   ctx.layerBottom()     stage6MaxDepth()
//   ctx.ensure()          ensureStage6State() — before each live drag frame
//   ctx.detailsOpen(key)  stage6DetailsOpen(key) → ' open' | '' for the <details data-st6details>
//
//   defaults / ensure     the registry entry's `state` — stage6/registry.js imports this module
//                         directly for them and for `cardMeta`, the pattern of bearing/index.js
//   compute(layers)       the shell adapter's compute: analyzePile on the active CPT's config;
//                         the shell caches the result in S.stage6Cache.pile before renderBody
//   renderBody(analysis)  the app body html (also lazily creates the canvas state in S.stage6Cache)
//   postRender()          section view + the four charts, inside the shell's post-render rAF
//   handlers              {} — the app's inputs go through the shell's setStage6Field, the
//                         section view through its own DOM listeners (canvas.js)
//   cardMeta              { id, title, desc } of the app-switch card (the icon lives in the registry)
import { defaults, ensure } from './state.js';
import { analyzePile } from './compute.js';
import { ensurePileCanvasState } from './canvas.js';
import { renderPileApp } from './panel.js';
import { buildPileCharts } from './charts.js';
import { createPileSectionLive } from './section-live.js';

/** The app card of the Stage 6 app switch (stage6/registry.js adds the glyph). */
export const cardMeta = {
  id: 'pile',
  title: 'Pile capacity',
  desc: 'Axial pile resistance and settlement from CPT (DM20 / De Beer).'
};

export function installPileApp(ctx){
  const { getState, requestRender, workingLayers, layerBottom, ensure: ensureHost, detailsOpen } = ctx;

  const sectionLive = createPileSectionLive({
    getState,
    workingLayers,
    layerBottom,
    ensure: ensureHost,
    requestRender
  });

  /** analyzePile on the active CPT (the shell's `compute`). */
  function compute(layers){
    const S = getState();
    return analyzePile(layers, S.wt, S.data, S.stage6.pile);
  }

  function renderBody(analysis){
    const S = getState();
    ensurePileCanvasState(S.stage6Cache);
    return renderPileApp(S.stage6.pile, analysis, detailsOpen);
  }

  /** buildStage6PileCharts(): the four Chart.js panels from the cached analysis. */
  function buildCharts(){
    const S = getState();
    buildPileCharts({ analysis: S.stage6Cache?.pile, cfg: S.stage6.pile, maxDepth: layerBottom() });
  }

  function postRender(){
    sectionLive.start();
    buildCharts();
  }

  return {
    defaults,
    ensure,
    compute,
    renderBody,
    postRender,
    handlers: {},
    cardMeta,
    buildCharts,
    sectionLive
  };
}

export { defaults, ensure } from './state.js';
export { analyzePile, PILE_CONSTANTS } from './compute.js';
export { renderPileApp } from './panel.js';
export { buildPileCharts, PILE_CHART_IDS } from './charts.js';
export { createPileSectionLive, PILE_SECTION_ID } from './section-live.js';
export { drawStage6PileSection, ensurePileCanvasState, stage6PileSnapZ, buildPileSectionMarkup } from './canvas.js';
