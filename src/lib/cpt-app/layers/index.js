// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// layers/index.js — public surface of the Stage 3 layer-detection package
// (01-monolith-map.md §6.1 row `layers/`, extracted in PR 6 / refactor step 3).
//
//   tabel3-compat.js  CAT_GROUPS, COMPAT, compatLevel, subtypeGroup, qcRfFit,
//                     suggestSubtype(l, catalogue), layerTypeCompatScore        (pure)
//   segments.js       segmentSummary(seg, prev, ctx), segmentTop, familyClass,
//                     similarity terms, isCriticalMarkerLayer, mergeCandidateScore
//   merge.js          simpleUpwardMerge(segs, ctx), smartPostMerge(segs, ctx) + helpers
//   context.js        layersCtx(cpt, over) → ctx                              (explicit S replacement)
//   detect.js         classificationSegmentKey(row, method),
//                     detectLayers(cpt, ctx) → layers[]                        (pure, no render)
//   table.js          buildSubtypeDropdown, renderLayerRowsHtml, compatWarnings(+Html),
//                     renderLayers(document, cpt), renderCompatWarnings         (PR 20)
//   handlers.js       editL, changeSubtype, editAlpha/M/RShear/Nu, setParamMethod (PR 20)
//
// PR 20 (refactor step 10) finished the package: the table render and the per-layer editors
// left the controller, and `installLayersApp(ctx)` at the bottom binds them to the active CPT.

export {
  CAT_GROUPS, COMPAT, compatLevel, subtypeGroup, qcRfFit, suggestSubtype, layerTypeCompatScore
} from './tabel3-compat.js';
export {
  segmentSummary, segmentTop, familyClass,
  qcSimilarity, rfSimilarity, subtypeSimilarity, paramSimilarity, compatSimilarity, continuityScore,
  isCriticalMarkerLayer, SMART_SLIVER_REF, mergeCandidateScore
} from './segments.js';
export {
  simpleUpwardMerge, mergeSegmentInDirection, chooseSimilarityMergeDirection,
  smartSimilarityReduce, enforceMinThicknessBySimilarity, smartPostMerge
} from './merge.js';
export { layersCtx } from './context.js';
export { classificationSegmentKey, detectLayers } from './detect.js';

import { layersCtx } from './context.js';
import { detectLayers as detectLayersOf } from './detect.js';
import { segmentSummary as segmentSummaryOf } from './segments.js';
import {
  buildSubtypeDropdown as buildSubtypeDropdownFor,
  renderLayers as renderLayersInto,
  renderCompatWarnings as renderCompatWarningsInto
} from './table.js';
import {
  editL as editLayerField,
  changeSubtype as changeSubtypeOf,
  editAlpha as editAlphaOf,
  editM as editMOf,
  editRShear as editRShearOf,
  editNu as editNuOf,
  setParamMethod as setParamMethodOf
} from './handlers.js';

export {
  buildSubtypeDropdown, renderLayerRowsHtml, compatWarnings, compatWarningsHtml,
  renderCompatWarnings, renderLayers
} from './table.js';
export {
  editL, changeSubtype, editAlpha, editM, editRShear, editNu,
  setParamMethod, PARAM_METHOD_DESCRIPTIONS
} from './handlers.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// installLayersApp(ctx) — Stage 3 bound to a host (PR 20 / refactor step 10).
//
// The detection wrappers over the active CPT, the table render and the seven editors. Bodies are
// verbatim; `S` is `ctx.getActive()` and the Stage 4 refresh the four parameter editors trigger
// is `ctx.renderModel()`.
//
//   ctx.document, ctx.getActive(), ctx.renderModel()
export function installLayersApp(ctx){
  const { document, getActive } = ctx;
  const app = {
    segmentSummary: (seg, prevSeg) => segmentSummaryOf(seg, prevSeg, layersCtx(getActive())),

    /* Assigns the result; rendering stays with the callers (goS(2), setParamMethod,
       refreshClassificationDerivedViews) exactly as in the monolith. */
    detectLayers(){
      const S = getActive();
      S.layers = detectLayersOf(S, layersCtx(S));
    },

    renderLayers: () => renderLayersInto(document, getActive()),
    renderCompatWarnings: () => renderCompatWarningsInto(document, getActive()),

    editL: (el) => editLayerField(getActive(), el),
    changeSubtype: (sel) => changeSubtypeOf(getActive(), sel, { renderLayers: app.renderLayers }),
    editAlpha: (el) => editAlphaOf(getActive(), el, { renderModel: ctx.renderModel }),
    editM: (el) => editMOf(getActive(), el, { renderModel: ctx.renderModel }),
    editRShear: (el) => editRShearOf(getActive(), el, { renderModel: ctx.renderModel }),
    editNu: (el) => editNuOf(getActive(), el, { renderModel: ctx.renderModel }),
    setParamMethod: (v) => setParamMethodOf(document, getActive(), v, {
      detectLayers: app.detectLayers,
      renderLayers: app.renderLayers
    })
  };
  app.handlers = {
    segmentSummary: app.segmentSummary,
    detectLayers: app.detectLayers,
    renderLayers: app.renderLayers,
    renderCompatWarnings: app.renderCompatWarnings,
    buildSubtypeDropdown: buildSubtypeDropdownFor,
    changeSubtype: app.changeSubtype,
    editL: app.editL,
    editAlpha: app.editAlpha,
    editM: app.editM,
    editRShear: app.editRShear,
    editNu: app.editNu,
    setParamMethod: app.setParamMethod
  };
  return app;
}
