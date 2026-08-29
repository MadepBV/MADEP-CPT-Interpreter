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
// legacy-controller.js keeps runTuning, acceptFit, rejectFit, updateTuningPreviewM, renderTuning,
// buildTuningCharts and fitLayer as wrappers over the active CPT (the render-after-write and the
// "re-render Stage 4 if #p3 is active" of acceptFit stay there — map §3.4 #2/#3).

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
