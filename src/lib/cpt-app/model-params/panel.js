// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// model-params/panel.js — the Stage 4 parameter cards (`#ma`): one card per layer with the
// Mohr-Coulomb, Soilin, Hardening Soil and hydraulic-conductivity columns, plus the four inline
// editors (ν, r_shear, α_E, m). 01-monolith-map.md §6.1 row `model-params/` (`panel.js`), moved
// out of legacy-controller.js in PR 20 / refactor step 10.
//
// `modelCardsHtml` is a pure string builder over (cpt, {hsParams, khParams, hardeningSoilParams});
// `renderModel` writes it and schedules the Stage 5 chart build the monolith scheduled here (the
// data-attribute approach avoids an early tag close). Verbatim, `S` as the `cpt` parameter.

import { SOIL_CLASS_NAMES } from '../soil-styles.js';

const SC = SOIL_CLASS_NAMES;

/** VMM §5.2 infiltration verdict → its colour token. */
const INFILTRATION_COLOURS = {
  'Infiltratie (volledig)':    'var(--ac)',
  'Infiltratie (effectief)':   'var(--ok-text)',
  'Infiltratie + buffer':      'var(--wn)',
  'Buffer (infiltratie marginaal)': 'var(--chart-orange)'
};

export function modelCardsHtml(cpt, {hsParams, khParams, hardeningSoilParams}){
  return cpt.layers.map((l,i)=>{
    const h=hsParams(l);
    const k=khParams(l);
    const thick=(l.bot-l.top).toFixed(2);
    const midZ=(l.top+l.bot)/2;
    const tawStr=cpt.elev!=null?` &nbsp;(${h.topTAW} → ${h.botTAW})`:'';

    // Infiltration class colour
    const infCol=INFILTRATION_COLOURS[k.infClass]||'var(--tx2)';

    return`<div class="card">
      <div class="card__head">
        <span class="pill ${SC[l.type]||'s-sand'}">${l.type}</span>
        <span style="font-size:13px;font-weight:600">Layer ${i+1} &mdash; ${l.top.toFixed(2)}&ndash;${l.bot.toFixed(2)} m${tawStr} &nbsp;(${thick} m)</span>
        ${l.subtype?`<span style="font-size:11px;color:var(--tx2);font-style:italic">${l.subtype}</span>`:''}
        <span style="font-size:11px;color:var(--tx2);margin-left:auto" title="z_mid=${midZ.toFixed(2)}m | &sigma;v0=${h.sigV} kPa | u=${h.u} kPa | &sigma;'v0=${h.sigVeff} kPa">&sigma;v0 ${h.sigV} &minus; u ${h.u} = &sigma;'v0 <strong>${h.sigVeff} kPa</strong> &middot; &alpha;E ${h.aE}</span>
      </div>
      <div style="display:grid;grid-template-columns:${hardeningSoilParams?'1fr 1fr 1fr 1fr':'1fr 1fr 1fr'};gap:14px">
        <div>
          <div class="card__eyebrow">Mohr-Coulomb</div>
          <table class="tbl tbl--kv">
            <tr><td>E_ref (kPa)</td><td>${h.Emc.toLocaleString()}</td></tr>
            <tr class="key">
              <td>&nu; <input class="input input--sm${l.ovr.nu?' ovr':''}" type="number" step="0.01" min="0.05" max="0.49"
                value="${h.nu.toFixed(2)}" style="width:52px;margin-left:4px"
                data-i="${i}" onchange="editNu(this)"></td>
              <td>${h.nu.toFixed(2)}</td>
            </tr>
            <tr class="key">
              <td>r_shear <input class="input input--sm${l.ovr.rShear?' ovr':''}" type="number" step="0.01" min="0.01" max="1.00"
                value="${h.rShear.toFixed(2)}" style="width:52px;margin-left:4px"
                data-i="${i}" onchange="editRShear(this)"></td>
              <td>${h.rShear.toFixed(2)}</td>
            </tr>
            <tr class="key"><td>&phi;' (&deg;)</td><td>${l.phi}</td></tr>
            <tr class="key"><td>c' (kPa)</td><td>${l.c}</td></tr>
            <tr><td>&psi; (&deg;)</td><td>${h.psi}</td></tr>
            <tr><td>&gamma; / &gamma;_sat</td><td>${l.g} / ${l.gs} kN/m&sup3;</td></tr>
            ${l.type==='Soft clay'||l.type==='Clay'?`<tr><td>c_u (kPa)</td><td>${l.cu}</td></tr>`:''}
          </table>
        </div>
        <div>
          <div class="card__eyebrow">Soilin &mdash; deformation modulus</div>
          <table class="tbl tbl--kv">
            <tr><td>&beta; (-)</td><td>${h.beta.toFixed(3)}</td></tr>
            <tr class="key"><td>E_def (kPa)</td><td>${h.Edef.toLocaleString()}</td></tr>
          </table>
          <div style="font-size:9px;color:var(--tx3);margin-top:6px">
            E_def = &beta;&middot;E_oed,i &nbsp;&middot;&nbsp; &beta; = (1+&nu;)(1&minus;2&nu;)/(1&minus;&nu;)<br>
            &#268;SN 73 1001 / Soilin subsoil input &middot; &nu; from Mohr-Coulomb column
          </div>
        </div>
        ${hardeningSoilParams ? `
          <div>
            <div class="card__eyebrow">Hardening Soil &mdash; p_ref = 100 kPa</div>
            <table class="tbl tbl--kv">
              <tr>
                <td style="color:var(--tx3);font-size:10px">&alpha;E (${cpt.alphaMethod==='B'?'SB260':'Sanglerat'})</td>
                <td style="text-align:right">
                  <input class="input input--sm${l.ovr.aE?' ovr':''}" type="number" step="0.5" min="0.5" max="30"
                    value="${h.aE}" style="width:54px"
                    data-i="${i}" onchange="editAlpha(this)">
                </td>
              </tr>
              <tr><td>E_oed,i (kPa)</td><td style="color:var(--tx2)">${h.Eoed_i.toLocaleString()}</td></tr>
              <tr class="key"><td>E_oed,ref (kPa)</td><td>${h.Eoed_ref.toLocaleString()}</td></tr>
              <tr class="key"><td>E_50,ref (kPa) <span style="font-size:9px;color:var(--tx3)">${cpt.stiffMethod==='B'?'=E_oed':'CUR 2003-7'}</span></td><td>${h.E50_ref.toLocaleString()}</td></tr>
              <tr class="key"><td>E_ur,ref (kPa)</td><td>${h.Eur_ref.toLocaleString()}</td></tr>
              <tr class="key">
                <td>m <input class="input input--sm${l.ovr.m?' ovr':''}" type="number" step="0.05" min="0.3" max="1.2"
                  value="${h.m.toFixed(2)}" style="width:48px;margin-left:4px"
                  data-i="${i}" onchange="editM(this)"></td>
                <td>${h.m.toFixed(2)}</td>
              </tr>
              <tr><td>K0_nc</td><td>${h.K0nc}</td></tr>
              <tr><td>&nu;<sub>ur</sub></td><td>${h.nu_ur}</td></tr>
              <tr><td>R_f</td><td>0.90</td></tr>
            </table>
          </div>
        ` : ''}
        <div>
          <div class="card__eyebrow">Hydraulic conductivity</div>
          <table class="tbl tbl--kv">
            <tr><td>k_h (m/s)</td><td style="font-family:monospace;font-size:11px">${k.kh_rep_fmt}</td></tr>
            <tr><td style="color:var(--tx3);font-size:10px">range</td><td style="font-family:monospace;font-size:10px;color:var(--tx3)">${k.kh_min_fmt} – ${k.kh_max_fmt}</td></tr>
            <tr><td>k_h/k_v</td><td>${k.khkv}</td></tr>
            <tr><td>k_v (m/s)</td><td style="font-family:monospace;font-size:11px">${k.kv_rep.toExponential(1)}</td></tr>
            <tr><td>&psi;_unsat (m)</td><td>${k.psi_unsat}</td></tr>
            <tr><td colspan="2" style="padding-top:6px">
              <span style="font-size:10px;font-weight:600;color:${infCol}">${k.infClass}</span>
              <div style="font-size:9px;color:var(--tx3);margin-top:2px">VMM §5.2 richtlijn</div>
            </td></tr>
          </table>
          <div style="font-size:9px;color:var(--tx3);margin-top:6px">Ref: OVAM Tabel 2-44<br>I/RA/11461/15.066/JSW</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

export function renderModel(document, cpt, deps){
  document.getElementById('ma').innerHTML=modelCardsHtml(cpt, deps);
  // Build charts after DOM settles (data-attribute approach avoids early tag close)
  setTimeout(deps.buildTuningCharts, 50);
}

/* Toggle functions for the Stage 4 global method controls. Each writes the CPT, moves the
   `.active` class of its segmented pair and re-renders when there is a layer model. */
export function setAlphaMethod(document, cpt, v, {renderModel}){
  cpt.alphaMethod=v;
  document.getElementById('btnAlphaA').classList.toggle('active',v==='A');
  document.getElementById('btnAlphaB').classList.toggle('active',v==='B');
  if(cpt.layers.length) renderModel();
}

export function setStiffMethod(document, cpt, v, {renderModel}){
  cpt.stiffMethod=v;
  document.getElementById('btnStiffA').classList.toggle('active',v==='A');
  document.getElementById('btnStiffB').classList.toggle('active',v==='B');
  if(cpt.layers.length) renderModel();
}

/* k_h/k_v anisotropy method.
   A — OVAM / I/RA/11461 (default): conservative engineering practice value.
       Silty sand grouped with fine soils → k_h/k_v = 3.
   B — Bear (1979): literature-typical intermediate value for fine/silty sand.
       Silty sand → k_h/k_v = 2.
   Sand and gravel are isotropic (k_h/k_v = 1) under both methods.
   Cohesive soils (clay, sandy clay/leem, peat) get k_h/k_v = 3 under both. */
export function setKhKvMethod(document, cpt, v, {renderModel}){
  cpt.khKvMethod=v;
  document.getElementById('btnKhKvA').classList.toggle('active',v==='A');
  document.getElementById('btnKhKvB').classList.toggle('active',v==='B');
  if(cpt.layers.length) renderModel();
}
