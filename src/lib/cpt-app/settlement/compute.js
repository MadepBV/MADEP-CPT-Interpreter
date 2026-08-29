// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// settlement/compute.js — the settlement app's analysis with explicit inputs
// (01-monolith-map.md §2.9 "Compute for these three lives in stage6-engineering.js", §6.1 row
// `settlement/`, refactor step 7 / PR 12c).
//
// The engine stays where it is: analyzeSettlement(layers, wtDepth, config) of stage6-engineering.js
// (:529) — CPT-derived E_oed, Boussinesq / 2:1 stress spread, sublayer integration below Df, the
// optional consolidation time curve. This module is the package's contract around it, the shape of
// bearing/compute.js:
//   settlementAnalysis(cfg, layers, env)
//     cfg     the `stage6.settlement` block (state.js): footingType, B, L, D, Df, Gk, QLead, QOther,
//             useCategory, combination, stressMethod, truncationRule, dz, includeTime, timeDays,
//             allowableSettlement
//     layers  the Stage 4 → Stage 6 working layers (model-params workingLayers(cpt)); required
//     env     { wt } — the water-table depth below the surface (m); required, finite, no fallback
// The shell adapter of the monolith called `analyzeSettlement(layers, S.wt, S.stage6.settlement)`
// (legacy-controller.js 340 at integration-r @ 07f0645); settlement/index.js builds that call from the
// active CPT. Pure: no state, no DOM.
import { analyzeSettlement } from '../stage6-engineering.js';

export { analyzeSettlement };

/** The water-table input of the compute functions: explicit, finite, no fallback. */
export function waterTableOf(env, fn){
  const wt = env ? env.wt : undefined;
  if(!Number.isFinite(wt)) throw new Error(`${fn}: env.wt (water-table depth below the surface, m) is required`);
  return wt;
}

/** The working-layer input: an array (possibly empty — the engine reports the empty profile), never implicit. */
export function layersOf(layers, fn){
  if(!Array.isArray(layers)) throw new Error(`${fn}: layers (the Stage 4 → Stage 6 working layers) are required`);
  return layers;
}

/** analyzeSettlement on explicit inputs — what the shell caches under `stage6Cache.settlement`. */
export function settlementAnalysis(cfg, layers, env){
  return analyzeSettlement(layersOf(layers, 'settlementAnalysis'), waterTableOf(env, 'settlementAnalysis'), cfg);
}
