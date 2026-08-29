// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// tuning/panel.js — the Stage 5 tuning cards, one per layer, as an HTML string
// (01-monolith-map.md §2.5 `renderTuning`).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): renderTuning 2095-2241.
// The markup is verbatim; `S.tuning` / `S.layers` / `S.alphaMethod` / `S.wt` → the `cpt`
// parameter, `SC` → soil-styles.js SOIL_CLASS_NAMES. The DOM write + the deferred
// `buildTuningCharts` stay in the controller's renderTuning wrapper. Each card carries its
// chart data as JSON in `data-*` attributes of a hidden `[data-chart-pending]` element (its
// last child; charts.js finds it by querySelectorAll) for charts.js. Markup uses the component
// classes of src/lib/styles/components.css (PR 10): .card / .card__head / .tbl--kv / .pill.

import { SOIL_CLASS_NAMES } from '../soil-styles.js';
import { getTuningPreviewM, tuningSliderBounds, tuningPreviewLineData } from './fit.js';

export const TUNING_PLACEHOLDER_HTML='<div style="color:var(--tx2);font-size:13px;padding:20px 0">Klik op "Run fitting" om de regressie per laag te berekenen.</div>';

/** One layer's card (regression + depth chart canvases, numbers, preview slider, accept/reject). */
export function tuningLayerCardHtml(cpt, t){
  const l = cpt.layers[t.i];
  const fit = t.fit;
  const hasAccepted = !!l.ovr.m;
  const badge = SOIL_CLASS_NAMES[l.type]||'s-sand';

  if(!fit){
    return`<div class="card">
        <div class="card__head" style="margin-bottom:0">
          <span class="pill ${badge}">${l.type}</span>
          <span style="font-size:13px;font-weight:600">Laag ${t.i+1} — ${l.top.toFixed(2)}–${l.bot.toFixed(2)} m</span>
          <span style="font-size:11px;color:var(--wn);margin-left:auto">Onvoldoende data voor regressie (n &lt; 5 of geen variatie)</span>
        </div>
      </div>`;
  }

  const qColor = fit.quality==='good'?'var(--ok-text)'
    : fit.quality==='ok'?'var(--wn)'
    : fit.quality==='invalid'?'var(--bad-text)'
    : 'var(--bad-text)';

  // Build scatter chart data
  const chartId = 'tChart'+t.i;
  const previewM = getTuningPreviewM(t);
  const preview = tuningPreviewLineData(fit, previewM);
  const slider = tuningSliderBounds(fit);

  // Default line points stay anchored to the type-default baseline.
  const m_def = fit.mDefault;
  const Eoed_ref_default = fit.Eoed_ref_default;

  // X range for model lines
  const Xmin = Math.min(...fit.Xs)-0.1, Xmax = Math.max(...fit.Xs)+0.1;
  const linePts = 30;
  const defaultLineY = Array.from({length:linePts},(_,k)=>{
    const x=Xmin+(Xmax-Xmin)*k/(linePts-1);
    return{x, y: Math.log(Eoed_ref_default)+m_def*x};
  });
  const scatterData = fit.Xs.map((x,k)=>({x,y:fit.Ys[k]}));

  return`<div class="card">
      <div class="card__head">
        <span class="pill ${badge}">${l.type}</span>
        <span style="font-size:13px;font-weight:600">Laag ${t.i+1} — ${l.top.toFixed(2)}–${l.bot.toFixed(2)} m</span>
        <span style="font-size:11px;font-style:italic;color:var(--tx2)">${l.subtype||''}</span>
        <span style="font-size:11px;font-weight:600;color:${qColor};margin-left:auto">${fit.qMsg}</span>
      </div>
      <!-- 3-column: depth profile | log-log fit | numbers -->
      <div style="display:grid;grid-template-columns:200px 1fr 200px;gap:14px;align-items:start">

        <!-- LEFT: Eoed vs depth (physical space) -->
        <div>
          <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">
            E_oed vs diepte (kPa)
            <span style="margin-left:6px;color:var(--chart-purple)">─ default</span>
            <span style="margin-left:4px;color:var(--chart-green)">─ preview</span>
            <span style="margin-left:4px;color:rgba(53,162,235,0.7)">· CPT</span>
          </div>
          <div style="position:relative;height:280px">
            <canvas id="${chartId+'d'}" role="img" aria-label="Eoed depth profile layer ${t.i+1}"></canvas>
          </div>
        </div>

        <!-- MIDDLE: log-log regression plot -->
        <div>
          <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">
            ln(E_oed,i) vs ln(σ'v0 stress ratio) — regressionvlak
            <span style="margin-left:6px;color:var(--chart-purple)">─ default m=${m_def.toFixed(2)}</span>
            <span style="margin-left:4px;color:var(--chart-green)">─ preview m=${previewM.toFixed(2)}</span>
          </div>
          <div style="position:relative;height:280px">
            <canvas id="${chartId}" role="img" aria-label="m fitting regression layer ${t.i+1}"></canvas>
          </div>
        </div>

        <!-- RIGHT: numbers + accept/reject -->
        <div>
          <table class="tbl tbl--kv" style="margin-bottom:12px">
            <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Type-default</td></tr>
            <tr><td>m</td><td>${m_def.toFixed(2)}</td></tr>
            <tr><td>E_oed,ref</td><td>${Eoed_ref_default.toLocaleString()} kPa</td></tr>
            <tr><td>&alpha;E basis</td><td>${cpt.alphaMethod==='B'?'puntgewijs qc-afhankelijk':'vast per laag'} (${fit.alphaDefault.toFixed(2)})</td></tr>
            <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--ok-text);padding:4px 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);text-transform:uppercase">Auto-fit</td></tr>
            <tr><td>m</td><td style="color:var(--ok-text);font-weight:700">${fit.m_fit.toFixed(3)}</td></tr>
            <tr><td>E_oed,ref</td><td style="color:var(--ok-text);font-weight:600">${fit.Eoed_ref_fit.toLocaleString()} kPa</td></tr>
            <tr><td style="padding-top:6px">R²</td><td style="padding-top:6px">${fit.R2.toFixed(3)}</td></tr>
            <tr><td>n</td><td>${fit.n} punten</td></tr>
            <tr><td>σ' bereik</td><td>×${fit.stressRangeFactor}</td></tr>
            <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--tx2);padding:6px 0 4px;border-top:1px solid var(--bd);text-transform:uppercase">Preview / engineer tweak</td></tr>
            <tr>
              <td>m</td>
              <td>
                <input id="fitPreviewInput${t.i}" type="range" min="${slider.min}" max="${slider.max}" step="${slider.step}" value="${previewM.toFixed(3)}"
                  oninput="updateTuningPreviewM(${t.i}, this.value)"
                  style="width:100%;accent-color:var(--ac)">
                <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tx3);margin-top:2px">
                  <span>${slider.min.toFixed(2)}</span>
                  <span>${slider.max.toFixed(2)}</span>
                </div>
                <div id="fitPreviewNote${t.i}" style="font-size:10px;color:var(--tx2);margin-top:4px">
                  ${fit.invalidSlope?'Auto-fit was ongeldig; slider start vanaf default m':'Preview volgt de auto-fit'}
                </div>
              </td>
            </tr>
            <tr><td>Preview m</td><td id="fitPreviewM${t.i}">${previewM.toFixed(3)}</td></tr>
            <tr><td>Preview E_oed,ref</td><td id="fitPreviewRef${t.i}">${preview.Eoed_ref.toLocaleString()} kPa</td></tr>
          </table>
          ${hasAccepted
            ?`<div style="font-size:11px;color:var(--ok-text);font-weight:600;margin-bottom:8px">✓ Huidige override m = ${l.m_ovr.toFixed(3)}</div>`
            :`<div style="font-size:11px;color:var(--tx2);margin-bottom:8px">Standaard m actief tot je expliciet accepteert</div>`
          }
          <button id="fitAcceptBtn${t.i}" class="btn btn--primary btn--sm" onclick="acceptFit(${t.i})" ${fit.quality==='warn'||fit.quality==='invalid'?'style="background:var(--wn);border-color:var(--wn)"':''}>
            ${fit.quality==='warn'?'⚠ ':''}Accepteer fit
          </button>
          ${hasAccepted?`<button class="btn btn--sm" onclick="rejectFit(${t.i})" style="margin-left:6px">Herstel default m</button>`:''}
        </div>
      </div>
      <div hidden data-chart-pending="${chartId}"
         data-chart-depth="${chartId+'d'}"
         data-scatter='${JSON.stringify(scatterData).replace(/'/g,"&#39;")}'
         data-default-line='${JSON.stringify(defaultLineY).replace(/'/g,"&#39;")}'
         data-fit-line='${JSON.stringify(preview.logLine).replace(/'/g,"&#39;")}'
         data-depth-pts='${JSON.stringify(fit.depthPts).replace(/'/g,"&#39;")}'
         data-eoed-i='${JSON.stringify(fit.EoedI_pts.map(v=>+v.toFixed(0))).replace(/'/g,"&#39;")}'
         data-hs-default='${JSON.stringify(fit.hsDefault_pts.map(v=>+v.toFixed(0))).replace(/'/g,"&#39;")}'
         data-hs-fit='${JSON.stringify(preview.depthLine.map(v=>+v.x.toFixed(0))).replace(/'/g,"&#39;")}'
         data-layer-top="${l.top.toFixed(3)}"
         data-layer-bot="${l.bot.toFixed(3)}"
         data-wt="${cpt.wt.toFixed(3)}"
         data-m-def="${m_def.toFixed(2)}"
         data-m-fit="${previewM.toFixed(2)}"
         data-invalid-slope="0"
         data-quality="${fit.quality}"></div>
    </div>`;
}

/** `#tuningArea` innerHTML for a CPT: the placeholder before a run, else one card per layer. */
export function tuningAreaHtml(cpt){
  if(!cpt.tuning) return TUNING_PLACEHOLDER_HTML;
  return cpt.tuning.map(t=>tuningLayerCardHtml(cpt, t)).join('');
}
