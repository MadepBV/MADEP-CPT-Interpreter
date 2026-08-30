// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// layers/handlers.js — the Stage 3 / Stage 4 per-layer editors. 01-monolith-map.md §6.1 row
// `layers/` (`handlers.js`), moved out of legacy-controller.js in PR 20 / refactor step 10.
//
// Each writes one layer of the active CPT and marks the matching `ovr.*` flag, so the value
// survives a re-detection. `changeSubtype` additionally re-proposes the Poisson default, and
// the four Stage 4 editors ask the host to re-render the model cards. Bodies are verbatim; the
// `el` they take is the `<input>` / `<select>` the inline `on*=` attribute fired on.

import { CAT } from '../eurocode-tabel3.js';

/** Stage 3 table cell (γ, γ_sat, φ', c', c_u): store the value and flag the override. */
export function editL(cpt, el){
  const i=+el.dataset.i,f=el.dataset.f;
  cpt.layers[i][f]=+el.value; cpt.layers[i].ovr[f]=true; el.classList.add('ovr');
}

/** Subtype dropdown: adopt the catalogue entry, auto-fill the un-overridden DEF params. */
export function changeSubtype(cpt, sel, {renderLayers}){
  const i=+sel.dataset.i;
  const subtype=sel.value;
  if(!subtype) return;
  const l=cpt.layers[i];
  const entry=CAT.find(r=>r.subtype===subtype);
  if(!entry) return;

  const prevType=l.type;
  l.type=entry.type;
  l.subtype=entry.subtype;
  l.ovr.type=true;
  l.ovr.subtype=true;

  // Auto-fill DEF params — only fields not yet manually overridden
  ['g','gs','phi','c','cu'].forEach(f=>{
    if(!l.ovr[f]){ l[f]=entry[f]; }
  });

  // The soil-type pick drives the nu proposal: ANY new dropdown selection —
  // including a consistency-only refinement within the same family, since the
  // nu defaults are graded per subtype — invalidates a manual Poisson
  // override and re-proposes the subtype default (the engineer can override
  // nu again afterwards in Stage 4).
  l.ovr.nu=false;
  delete l.nu_ovr;

  renderLayers();
}

/** Stage 4 α_E override. */
export function editAlpha(cpt, el, {renderModel}){
  const i=+el.dataset.i;
  cpt.layers[i].aE_ovr=+el.value; cpt.layers[i].ovr.aE=true;
  el.classList.add('ovr');
  renderModel();
}

/** Stage 4 stress-exponent (m) override. */
export function editM(cpt, el, {renderModel}){
  const i=+el.dataset.i;
  cpt.layers[i].m_ovr=+el.value; cpt.layers[i].ovr.m=true;
  el.classList.add('ovr');
  renderModel();
}

/** Stage 4 interface strength reduction (R_inter) override, clamped to (0.01, 1]. */
export function editRShear(cpt, el, {renderModel}){
  const i=+el.dataset.i;
  const numeric=Number(el.value);
  if(!Number.isFinite(numeric)) return;
  cpt.layers[i].rShear_ovr=Math.max(Math.min(numeric, 1), 0.01);
  cpt.layers[i].ovr.rShear=true;
  el.classList.add('ovr');
  renderModel();
}

/** Stage 4 Poisson override; an empty field returns to the soil-type proposal. */
export function editNu(cpt, el, {renderModel}){
  const i=+el.dataset.i;
  const raw=String(el.value).trim();
  if(raw===''){
    /* A cleared (or browser-invalid) number input reports value="" — treat it
       as "return to the soil-type proposal", never as 0 (which would clamp to
       an extreme 0.05 override). */
    cpt.layers[i].ovr.nu=false;
    delete cpt.layers[i].nu_ovr;
    renderModel();
    return;
  }
  const numeric=Number(raw);
  if(!Number.isFinite(numeric)) return;
  /* nu < 0.5 strictly: beta = (1+nu)(1-2nu)/(1-nu) degenerates to 0 at 0.5.
     Rounded to 2 decimals so the stored override always equals the display. */
  cpt.layers[i].nu_ovr=Math.max(Math.min(Math.round(numeric*100)/100, 0.49), 0.05);
  cpt.layers[i].ovr.nu=true;
  el.classList.add('ovr');
  renderModel();
}

/* ── Parameter method selector (Stage 3 global) ──
   cpt.paramMethod: 'sb260' | 'def'. Set from the segmented control rendered above the table;
   re-runs the detection so the new suggestions land, then re-renders. */
export const PARAM_METHOD_DESCRIPTIONS = {
  sb260:'Grondsoort en consistentie uit NEN Tabel 3 — aanbevolen',
  def:'Generieke parameters op basis van CPT-type (DEF tabel)'
};

export function setParamMethod(document, cpt, v, {detectLayers, renderLayers}){
  cpt.paramMethod=v;
  document.getElementById('pmSB260').classList.toggle('active',v==='sb260');
  document.getElementById('pmDEF').classList.toggle('active',v==='def');
  document.getElementById('pmDesc').textContent=PARAM_METHOD_DESCRIPTIONS[v]||'';
  // Re-run detectLayers to apply new suggestions, then re-render
  if(cpt.classified.length){ detectLayers(); renderLayers(); }
}
