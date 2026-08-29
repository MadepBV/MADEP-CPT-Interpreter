// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// beam/compute.js — the beam / slab-on-Winkler app's analysis with explicit inputs
// (01-monolith-map.md §2.9 "Compute for these three lives in stage6-engineering.js", §6.1 row
// `beam/`, refactor step 7 / PR 12c).
//
// The engines stay where they are, in stage6-engineering.js:
//   analyzeBeamAndReinforcement(layers, wtDepth, config) (:1508) — the 1D strip on Winkler / Pasternak
//     support: the CPT-derived subgrade reaction, the SLS deflection line, the ULS moment line and the
//     EC2 reinforcement + durability cover
//   computeSubgradeReaction(layers, wtDepth, config) (:1141) — the k_s derivation on its own (the
//     `stage6-beam` golden suite locks it separately as `<fx>.subgrade`)
// This module is the package's contract around them, the shape of bearing/compute.js:
//   beamAnalysis(cfg, layers, env) · subgradeReaction(cfg, layers, env)
//     cfg     the `stage6.beam` block (state.js): modelMode, foundationModel, B, b, L, h, Df, Ec,
//             EsMode, zInfluence, gpEta, gpOverride, loadPattern, Gk, QLead, QOther, useCategory,
//             slsCombination, ulsCombination, xLoad, xStart, xEnd, nElements, allowableDeflectionRatio,
//             fck, fyk, exposureClass, phiBar, dG, deltaCdev, cNomOverride, designLifeYears, the five
//             EC2 execution flags, dz
//     layers  the Stage 4 → Stage 6 working layers (model-params workingLayers(cpt)); required
//     env     { wt } — the water-table depth below the surface (m); required, finite, no fallback
// The shell adapter of the monolith called `analyzeBeamAndReinforcement(layers, S.wt, S.stage6.beam)`
// (legacy-controller.js 350 at integration-r @ 07f0645); beam/index.js builds that call from the
// active CPT. Pure: no state, no DOM.
import { analyzeBeamAndReinforcement, computeSubgradeReaction } from '../stage6-engineering.js';

export { analyzeBeamAndReinforcement, computeSubgradeReaction };

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

/** analyzeBeamAndReinforcement on explicit inputs — what the shell caches under `stage6Cache.beam`. */
export function beamAnalysis(cfg, layers, env){
  return analyzeBeamAndReinforcement(layersOf(layers, 'beamAnalysis'), waterTableOf(env, 'beamAnalysis'), cfg);
}

/** computeSubgradeReaction on explicit inputs — the k_s derivation alone (ksInfo of the analysis). */
export function subgradeReaction(cfg, layers, env){
  return computeSubgradeReaction(layersOf(layers, 'subgradeReaction'), waterTableOf(env, 'subgradeReaction'), cfg);
}
