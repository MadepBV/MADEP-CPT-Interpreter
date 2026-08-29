// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// dewatering/compute.js — the dewatering app's analysis with explicit inputs
// (01-monolith-map.md §2.9 "Compute for these three lives in stage6-engineering.js", §6.1 row
// `dewatering/`, refactor step 7 / PR 12c).
//
// The engine stays where it is: analyzeDewatering(layers, wtDepth, config) of stage6-engineering.js
// (:950) — the transmissivity-based drawdown screening (single well / equivalent well / trench),
// the effective-stress change at the CPT, the settlement-vs-distance curve, the optional time curve.
// This module is the package's contract around it, the shape of bearing/compute.js:
//   dewateringAnalysis(cfg, layers, env)
//     cfg     the `stage6.dewatering` block (state.js): combination, targetWt, geometry, aquiferType,
//             rw, rCPT, LPit, BPit, LTrench, distanceToCPT, CSichardt, sigmaVMode, aquiferBaseDepth,
//             dz, timeDays
//     layers  the Stage 4 → Stage 6 working layers (model-params workingLayers(cpt)); required
//     env     { wt } — the undisturbed water-table depth below the surface (m); required, finite,
//             no fallback (panel.js reads the same value for the audit row and the input's `min`)
// The shell adapter of the monolith called `analyzeDewatering(layers, S.wt, S.stage6.dewatering)`
// (legacy-controller.js 345 at integration-r @ 07f0645); dewatering/index.js builds that call from
// the active CPT. Pure: no state, no DOM. The result carries a `waterTableAtDistance` function (the
// golden normaliser drops it).
import { analyzeDewatering } from '../stage6-engineering.js';

export { analyzeDewatering };

/** The water-table input of the compute / panel functions: explicit, finite, no fallback. */
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

/** analyzeDewatering on explicit inputs — what the shell caches under `stage6Cache.dewatering`. */
export function dewateringAnalysis(cfg, layers, env){
  return analyzeDewatering(layersOf(layers, 'dewateringAnalysis'), waterTableOf(env, 'dewateringAnalysis'), cfg);
}
