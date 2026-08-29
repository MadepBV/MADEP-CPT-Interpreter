// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// model-params/context.js — builds the explicit parameter context of one CPT state.
//
// New in PR 5 (refactor step 2). Collects everything hsParams/khParams/stressAt used to read
// from the module-level active CPT `S` in src/lib/cpt-app/legacy-controller.js (the S.wt read
// of stressAt 1941, S.alphaMethod/S.stiffMethod/S.elev of hsParams 3084/3126/3149, S.khKvMethod
// of khParams 3007, assumedRfValue() 1994-1996) into one plain object, so the derivation runs
// for any CPT — the stratigraphy `layerParamsFor` no longer has to swap `S`.

import { normalizeAssumedRf } from '../classification-core.js';

/**
 * @param {object} cpt  CPT state (newCptState shape): wt, elev, alphaMethod, stiffMethod,
 *                      khKvMethod, assumedRf are read; nothing else.
 * @returns {{wt:number, elev:number|null, alphaMethod:string, stiffMethod:string, khKvMethod:string, assumedRf:number}}
 */
export function cptModelCtx(cpt){
  return {
    wt: cpt.wt,
    elev: cpt.elev,
    alphaMethod: cpt.alphaMethod,
    stiffMethod: cpt.stiffMethod,
    khKvMethod: cpt.khKvMethod,
    assumedRf: normalizeAssumedRf(cpt.assumedRf)
  };
}
