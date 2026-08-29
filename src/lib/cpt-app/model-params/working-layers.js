// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// model-params/working-layers.js — the Stage 6 / Stage 7 "working layers": a copy of the
// Stage 3 layers enriched with the derived HS/MC stiffness and permeability fields.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 5, refactor step 2), lines 4168-4190
// (`stage6WorkingLayers()`). `S.layers` became `cpt.layers` and the per-layer derivation
// runs with the ctx of that same CPT (cptModelCtx). Field set unchanged.

import { cptModelCtx } from './context.js';
import { hsParams } from './hs-params.js';
import { khParams } from './kh-params.js';

export function workingLayers(cpt){
  const ctx = cptModelCtx(cpt);
  return cpt.layers.map((layer, index)=>{
    const h = hsParams(layer, ctx);
    const k = khParams(layer, ctx);
    return{
      ...layer,
      index,
      Eoed_ref:h.Eoed_ref,
      Eoed_i:h.Eoed_i,
      E50_ref:h.E50_ref,
      Eur_ref:h.Eur_ref,
      m:h.m,
      Emc:h.Emc,
      nu:h.nu,
      K0nc:h.K0nc,
      rShear:h.rShear,
      psi:h.psi,
      kh:k.kh_rep,
      kv:k.kv_rep,
      nu_ur:h.nu_ur
    };
  });
}
