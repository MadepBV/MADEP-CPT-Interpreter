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
//
// legacy-controller.js keeps the old names: the S-free functions are imported as they
// are, segmentSummary / detectLayers get thin wrappers over the active CPT. The table
// render (renderLayers, buildSubtypeDropdown, renderCompatWarnings) and the editors
// (changeSubtype, editL, editAlpha/M/RShear/Nu) stay in the controller until the
// panel/handlers split of a later step.

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
