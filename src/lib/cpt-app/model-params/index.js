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
//   panel.js           modelCardsHtml / renderModel + setAlphaMethod / setStiffMethod /
//                      setKhKvMethod                                    (DOM, PR 20)
//
// PR 20 (refactor step 10) finished the package: the Stage 4 cards and the three global method
// toggles left the controller, and `installModelParamsApp(ctx)` at the bottom builds the ctx
// from the live active CPT so nothing of Stage 4 is left in the composition root.

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

import { cptModelCtx } from './context.js';
import { stressAt as stressAtOf } from './stress.js';
import { hsParams as hsParamsOf } from './hs-params.js';
import { khParams as khParamsOf } from './kh-params.js';
import { workingLayers as workingLayersOf } from './working-layers.js';
import {
  renderModel as renderModelInto,
  setAlphaMethod as setAlphaMethodOf,
  setStiffMethod as setStiffMethodOf,
  setKhKvMethod as setKhKvMethodOf
} from './panel.js';

export { modelCardsHtml, renderModel, setAlphaMethod, setStiffMethod, setKhKvMethod } from './panel.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// installModelParamsApp(ctx) — Stage 4 bound to a host (PR 20 / refactor step 10).
//
// `modelCtx()` is the one place the derivation context is built from the active CPT; every other
// name is the monolith's wrapper over it. Bodies verbatim; `S` is `ctx.getActive()`.
//
//   ctx.document, ctx.getActive(),
//   ctx.hardeningSoilParams          — STAGE4_ENABLE_HARDENING_SOIL_PARAMS, the fourth card's gate
//   ctx.buildTuningCharts()          — the Stage 5 chart build renderModel schedules
export function installModelParamsApp(ctx){
  const { document, getActive } = ctx;
  const app = {
    modelCtx: () => cptModelCtx(getActive()),
    stressAt: (z, gammaSat, gammaUnsat) => stressAtOf(getActive(), z, gammaSat, gammaUnsat),
    hsParams: (l) => hsParamsOf(l, app.modelCtx()),
    khParams: (l) => khParamsOf(l, app.modelCtx()),
    workingLayers: () => workingLayersOf(getActive()),

    renderModel: () => renderModelInto(document, getActive(), {
      hsParams: app.hsParams,
      khParams: app.khParams,
      hardeningSoilParams: ctx.hardeningSoilParams,
      buildTuningCharts: ctx.buildTuningCharts
    }),
    setAlphaMethod: (v) => setAlphaMethodOf(document, getActive(), v, { renderModel: app.renderModel }),
    setStiffMethod: (v) => setStiffMethodOf(document, getActive(), v, { renderModel: app.renderModel }),
    setKhKvMethod: (v) => setKhKvMethodOf(document, getActive(), v, { renderModel: app.renderModel })
  };
  app.handlers = {
    stressAt: app.stressAt,
    hsParams: app.hsParams,
    khParams: app.khParams,
    renderModel: app.renderModel,
    setAlphaMethod: app.setAlphaMethod,
    setStiffMethod: app.setStiffMethod,
    setKhKvMethod: app.setKhKvMethod
  };
  return app;
}
