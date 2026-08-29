// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// pile/section-live.js — the interactive section view's host glue: the hooks handed to
// canvas.js drawStage6PileSection and the one-frame-at-a-time rAF loop that re-runs analyzePile
// while a handle is dragged (01-monolith-map.md §2.8 rows drawStage6PileSectionLive /
// requestStage6PileLightRedraw, §3.4 "pile canvas hooks"). Moved out of legacy-controller.js
// 11045-11106 (integration-r @ 78a2e02); the bodies are verbatim, the module-level
// `__stage6PileLightRedrawHandle` became the instance's `handle`, and the five reads of the
// controller (`S`, `stage6WorkingLayers()`, `stage6MaxDepth()`, `ensureStage6State()`,
// `renderStage6()`) became the context:
//
//   createPileSectionLive(ctx) → { start, stop, draw, requestRedraw, pending }
//     ctx.getState()       the active CPT (S): wt, data, stage6, stage6Cache
//     ctx.workingLayers()  stage6WorkingLayers() — the Stage 4 → Stage 6 layer contract
//     ctx.layerBottom()    stage6MaxDepth() — depth extent of the section
//     ctx.ensure()         ensureStage6State() — re-clamps the dragged config before each live frame
//     ctx.requestRender()  renderStage6() — the full re-render on drag end (commitChange)
//     ctx.elId             host <svg> id (default 'stage6PileSection', panel.js renderPileVisualsColumn)
//     ctx.appId            the app whose selection keeps the loop alive (default 'pile')
//
//   start()          draw the section now (the post-render entry: drawStage6PileSectionLive)
//   draw()           same, without the start/stop semantics
//   requestRedraw()  schedule one light frame (requestStage6PileLightRedraw): at most one pending
//                    rAF; the frame re-clamps, re-runs analyzePile into S.stage6Cache.pile and
//                    redraws; a frame that fires after the app was switched away does nothing
//   stop()           cancel a pending light frame (nothing is drawn afterwards until start())
//   pending()        whether a light frame is scheduled
//
// Drag-driven writes (hooks.setField) bypass setStage6Field on purpose: they write the path into
// S.stage6 in place and rely on ensure() to re-clamp on the next frame / render — unchanged.
import { drawStage6PileSection, ensurePileCanvasState } from './canvas.js';
import { analyzePile } from './compute.js';

/** The host <svg> of the section view (panel.js renderPileVisualsColumn). */
export const PILE_SECTION_ID = 'stage6PileSection';

export function createPileSectionLive(ctx){
  const {
    getState,
    workingLayers,
    layerBottom,
    ensure,
    requestRender,
    elId = PILE_SECTION_ID,
    appId = 'pile'
  } = ctx;
  let handle = null;

  // Drag-driven writes: bypass the full setStage6Field rebuild for the live
  // drag path, but still go through the same state shape. We update the
  // pile config in place; ensure() re-clamps on next render.
  function setField(path, value){
    const segs = path.split('.');
    let cur = getState().stage6;
    for(let i = 0; i < segs.length - 1; i += 1){
      if(!cur[segs[i]]) cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
  }

  function hooks(){
    return {
      getLayers: () => workingLayers(),
      getWt: () => getState().wt,
      getMaxDepth: () => layerBottom(),
      setField,
      requestRedraw: () => requestRedraw(),
      commitChange: () => {
        // Full re-render on drag-end so the column-3 summary, audit tables and
        // four Chart.js panels also reflect the new state.
        requestRender();
      }
    };
  }

  /** drawStage6PileSectionLive(): draw the section from the cached analysis. */
  function draw(){
    const S = getState();
    const analysis = S.stage6Cache?.pile;
    if(!analysis) return;
    const canvasState = ensurePileCanvasState(S.stage6Cache);
    drawStage6PileSection(elId, analysis, S.stage6.pile, canvasState, hooks());
  }

  /** requestStage6PileLightRedraw(): one pending frame at a time. */
  function requestRedraw(){
    if(handle) return;
    handle = requestAnimationFrame(()=>{
      handle = null;
      const S = getState();
      if(S.stage6.app !== appId) return;
      // Re-clamp config and recompute the analysis so the active-shaft band,
      // downdrag overlay, and per-layer hover tooltips track the live drag.
      // analyzePile is fast (~ms-range on a typical CPT); doing it at 60 Hz
      // is well within budget on modern browsers.
      ensure();
      const analysis = analyzePile(workingLayers(), S.wt, S.data, S.stage6.pile);
      S.stage6Cache.pile = analysis;
      const canvasState = ensurePileCanvasState(S.stage6Cache);
      drawStage6PileSection(elId, analysis, S.stage6.pile, canvasState, hooks());
    });
  }

  function start(){
    draw();
  }

  function stop(){
    if(handle && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
    handle = null;
  }

  function pending(){
    return Boolean(handle);
  }

  return { start, stop, draw, requestRedraw, pending };
}
