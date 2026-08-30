// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// tuning/index.js — public surface of the Stage 5 tuning package
// (01-monolith-map.md §6.1 row `tuning/`, extracted in PR 14 / refactor step 8).
//
//   fit.js     tuningCtx(cpt) · fitLayer(layer, ctx) · runTuningFits(layers, ctx) · acceptFit(cpt, i)
//              · rejectFit(cpt, i) · getTuningPreviewM · tuningSliderBounds · tuningPreviewEoedRef
//              · tuningPreviewLineData · tuningPreviewView(t, raw)                    (all pure)
//   panel.js   tuningAreaHtml(cpt) · tuningLayerCardHtml(cpt, t) · TUNING_PLACEHOLDER_HTML (pure strings)
//   charts.js  buildTuningCharts(document, Chart) · applyTuningPreview(document, i, view, colors)
//              · updateTuningPreviewM(document, tuning, i, raw)                       (DOM + Chart.js)
//
// PR 20 (refactor step 10) added `installTuningApp(ctx)` at the bottom: the seven wrappers over
// the active CPT the controller kept, including the render-after-write and the "re-render Stage 4
// if #p3 is active" of acceptFit (map §3.4 #2/#3), which is now a ctx hook.

export {
  tuningCtx,
  fitLayer,
  runTuningFits,
  acceptFit,
  rejectFit,
  getTuningPreviewM,
  tuningSliderBounds,
  tuningPreviewEoedRef,
  tuningPreviewLineData,
  tuningPreviewView
} from './fit.js';
export { TUNING_PLACEHOLDER_HTML, tuningLayerCardHtml, tuningAreaHtml } from './panel.js';
export { buildTuningCharts, applyTuningPreview, updateTuningPreviewM } from './charts.js';

import {
  tuningCtx,
  fitLayer as fitLayerOf,
  runTuningFits,
  acceptFit as acceptFitOf,
  rejectFit as rejectFitOf
} from './fit.js';
import { tuningAreaHtml } from './panel.js';
import { buildTuningCharts as buildTuningChartsInto, updateTuningPreviewM as updateTuningPreviewInto } from './charts.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// installTuningApp(ctx) — Stage 5 bound to a host (PR 20 / refactor step 10).
//
//   ctx.document, ctx.getActive(), ctx.renderModelIfActive()
//
// `renderModelIfActive` is acceptFit's "re-render Stage 4 in the background so it stays current"
// — the `#p3.active` test the monolith made inline, kept on the host side because it reads the
// stage-visibility DOM (map §3.4 #3).
export function installTuningApp(ctx){
  const { document, getActive } = ctx;
  const app = {
    fitLayer: (l) => fitLayerOf(l, tuningCtx(getActive())),

    runTuning(){
      const S = getActive();
      S.tuning = runTuningFits(S.layers, tuningCtx(S));
      app.renderTuning();
    },

    acceptFit(i){
      if(!acceptFitOf(getActive(), i)) return;
      app.renderTuning();
      // Re-render Stage 4 in background so it stays current
      ctx.renderModelIfActive();
    },

    rejectFit(i){
      if(!rejectFitOf(getActive(), i)) return;
      app.renderTuning();
    },

    updateTuningPreviewM(i, rawValue){
      updateTuningPreviewInto(document, getActive().tuning, i, rawValue);
    },

    renderTuning(){
      const S = getActive();
      const el = document.getElementById('tuningArea');
      el.innerHTML = tuningAreaHtml(S);
      if(!S.tuning) return;
      // Build charts after DOM settles.
      setTimeout(app.buildTuningCharts, 50);
    },

    buildTuningCharts(){
      buildTuningChartsInto(document);
    }
  };
  app.handlers = {
    fitLayer: app.fitLayer,
    runTuning: app.runTuning,
    acceptFit: app.acceptFit,
    rejectFit: app.rejectFit,
    updateTuningPreviewM: app.updateTuningPreviewM,
    renderTuning: app.renderTuning,
    buildTuningCharts: app.buildTuningCharts
  };
  return app;
}
