// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// layers/context.js — the explicit detection context of one CPT state.
//
// New in PR 6 (refactor step 3). Collects everything the Stage 3 detection used to read
// from the module-level active CPT `S` in src/lib/cpt-app/legacy-controller.js
// (S.useSB260params in segmentSummary 2002, S.minThk in simpleUpwardMerge 2147 and
// enforceMinThicknessBySimilarity 2238, S.smartMergeSensitivity in smartPostMerge 2251,
// S.method in classificationSegmentKey 2263, S.smartMerge / S.paramMethod in
// detectLayers 2286 / 2318) into one plain object, plus the Tabel 3 catalogue the
// subtype suggestion scores against.

import { CAT } from '../eurocode-tabel3.js';

/**
 * @param {object} cpt  CPT state (newCptState shape): method, paramMethod, useSB260params,
 *                      smartMerge, minThk, smartMergeSensitivity are read; nothing else.
 * @param {object} [over]  per-key overrides (undefined values are ignored), e.g. {catalogue, paramMethod}
 * @returns {{catalogue: object[], method: string, paramMethod: string, useSB260params: boolean,
 *            smartMerge: boolean, minThk: number, smartMergeSensitivity: number}}
 */
export function layersCtx(cpt, over = {}){
  const ctx = {
    catalogue: CAT,
    method: cpt.method,
    paramMethod: cpt.paramMethod,
    useSB260params: cpt.useSB260params,
    smartMerge: cpt.smartMerge,
    minThk: cpt.minThk,
    smartMergeSensitivity: cpt.smartMergeSensitivity
  };
  for (const k of Object.keys(over)) { if (over[k] !== undefined) ctx[k] = over[k]; }
  return ctx;
}
