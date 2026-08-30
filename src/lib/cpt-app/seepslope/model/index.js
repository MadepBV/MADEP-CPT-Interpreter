// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/model/index.js — the soil model of the Seep / Slope ("bishop") app: how the state
// becomes the section model the solvers run on, and what a state change invalidates. Refactor
// step 9b (01-monolith-map.md §6.2 step 9b, §6.3 item 5, §3.4 #5 / #9; PLAN §2 row 18b, §4
// defect 3; worklog/refactor/22-pr18b-seepslope-model.md). Pure modules over the `bishop` block
// and the active CPT's working layers; the host (legacy-controller.js until step 9f) keeps the
// monolith names as façades:
//
//   signature.js        materialsSignature, materialsSource, materialsInvalidation — the
//                       "materials ↔ Stage 3/4 layers" contract (sourceLayerSignature /
//                       sourceStrengthSet) as data
//   sync-soil-model.js  syncSoilModel(bishop, layers, env) → { changed, patch, invalidation, … },
//                       applySoilModelPatch, previewState, soilModelFromState (the same model
//                       everywhere), mirrorHsParams (the HS mirror), normalizeSoilGeometry,
//                       pruneSelections, buildBishopModel
//   invalidate.js       invalidateSeepage / invalidateDeformation / invalidateBishop /
//                       invalidateWallGeometry → { stop, rerun, keptSolvedState, render } and the
//                       silent-stop state writes
//
// The engine (stage6-bishop.js: buildBishopModelFromStageLayers, importBishopMaterialsFromLayers,
// bishopLayerSignature, analyzeBishopSearch) stays where it is; the three model builders are
// re-exported here so a consumer of the package has one import point.

export {
  buildBishopModelFromStageLayers,
  importBishopMaterialsFromLayers,
  bishopLayerSignature
} from '../../stage6-bishop.js';
export {
  materialsSignature,
  materialsSource,
  materialsInvalidation,
  MATERIALS_INVALIDATION_MESSAGES
} from './signature.js';
export {
  SOIL_MODEL_PATCH_KEYS,
  HS_PROMPT_PATH,
  mirrorHsParams,
  syncMaterials,
  normalizeSoilGeometry,
  pruneSelections,
  syncSoilModel,
  applySoilModelPatch,
  previewState,
  buildBishopModel,
  soilModelFromState
} from './sync-soil-model.js';
export {
  stopSearchState,
  stopSeepageState,
  stopDeformationState,
  invalidateSeepage,
  invalidateDeformation,
  invalidateBishop,
  invalidateWallGeometry
} from './invalidate.js';
export * as signature from './signature.js';
export * as sync from './sync-soil-model.js';
export * as invalidate from './invalidate.js';
