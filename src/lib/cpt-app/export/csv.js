// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// export/csv.js — the Stage 3/4 layer table as CSV (one row per layer with the
// Hardening-Soil and hydraulic parameters of model-params/).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 8, refactor step 4): the text
// half of `exportCSV` (old lines 15619-15640 at c989770). The only change: the CPT state
// is a parameter instead of the module-level active CPT `S`, and hsParams/khParams get
// the explicit model ctx (cptModelCtx) instead of reading `S`. The `<a download>` click
// stays in the controller wrapper.

import { cptModelCtx, hsParams, khParams } from '../model-params/index.js';

/** The controller's guard message when there is nothing to export. */
export const NO_LAYERS_MESSAGE = 'No layers to export. Run classification first.';

export const LAYERS_CSV_HEADER = 'Layer,Type,Subtype,Top_m,Bot_m,Top_TAW,Bot_TAW,Thick_m,avgQc_MPa,avgRf_pct,gamma,gamma_sat,phi,c,cu,alphaE,alphaMethod,Eoed_i_kPa,Eoed_ref_kPa,E50_ref_kPa,Eur_ref_kPa,E_mc_kPa,nu,beta,Edef_kPa,rShear,m,K0nc,nu_ur,stiffMethod,kh_ms,kv_ms,khkv,psi_unsat_m,Infiltratie_klasse';

/**
 * Layer table CSV text (LF-joined, no trailing newline — as the controller wrote it).
 * @param {object} cpt  CPT state: layers, elev are read.
 * @param {object} ctx  model ctx (cptModelCtx(cpt) by default): alphaMethod / stiffMethod
 *                      are printed from it so the columns match the h values it produced.
 */
export function buildLayersCsv(cpt, ctx = cptModelCtx(cpt)){
  const taw=z=>cpt.elev!=null?(cpt.elev-z).toFixed(2):'';
  const hdr=LAYERS_CSV_HEADER;
  const rows=cpt.layers.map((l,i)=>{
    const h=hsParams(l, ctx);
    const k=khParams(l, ctx);
    return[i+1,l.type,`"${l.subtype||''}"`,
      l.top.toFixed(3),l.bot.toFixed(3),taw(l.top),taw(l.bot),
      (l.bot-l.top).toFixed(3),l.avgQc,l.avgRf??'',
      l.g,l.gs,l.phi,l.c,l.cu,
      h.aE.toFixed(2),ctx.alphaMethod,
      h.Eoed_i,h.Eoed_ref,h.E50_ref,h.Eur_ref,h.Emc,h.nu,h.beta,h.Edef,h.rShear.toFixed(2),h.m.toFixed(2),h.K0nc,h.nu_ur,ctx.stiffMethod,
      k.kh_rep.toExponential(2),k.kv_rep.toExponential(2),k.khkv,k.psi_unsat,
      `"${k.infClass}"`].join(',');
  });
  return [hdr,...rows].join('\n');
}

/** Download file name of the layer CSV. */
export function layersCsvFilename(cpt){
  return `CPT_${cpt.meta.testid||'export'}_layers.csv`;
}
