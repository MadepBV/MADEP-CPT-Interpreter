// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// model-params/index.js — public surface of the Stage 4 model-parameters package
// (01-monolith-map.md §6.1 row `model-params/`, extracted in PR 5 / refactor step 2).
//
//   soil-defaults.js   DEF, AE, MC_*, mohrCoulomb*, sb260*, alphaEB      (pure tables + α)
//   stress.js          stressAt(cpt, z, gammaSat, gammaUnsat)           (reads cpt.wt)
//   context.js         cptModelCtx(cpt) → ctx                          (explicit S replacement)
//   hs-params.js       hsParams(layer, ctx)
//   kh-params.js       khParams(layer, ctx)
//   working-layers.js  workingLayers(cpt)                              (= stage6WorkingLayers)
//
// legacy-controller.js keeps the old names as thin wrappers that build the ctx from the
// live active CPT; renderModel / setAlphaMethod & co. (DOM) stay in the controller until
// the panel/handlers split of a later step.

export {
  DEF, AE,
  MC_NU_BY_TYPE, MC_NU_BY_SUBTYPE, MC_RSHEAR_BY_TYPE, MC_RSHEAR_BY_SUBTYPE,
  mohrCoulombNuDefault, mohrCoulombRShearDefault,
  sb260GranularAlpha, sb260TransitionAlpha, sb260AlphaFamily, alphaEB
} from './soil-defaults.js';
export { stressAt } from './stress.js';
export { cptModelCtx } from './context.js';
export { hsParams } from './hs-params.js';
export { khParams } from './kh-params.js';
export { workingLayers } from './working-layers.js';
