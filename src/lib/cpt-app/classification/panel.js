// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// classification/panel.js — HTML string builders of the Stage 2 panel.
//
// Extracted from runClass() in src/lib/cpt-app/legacy-controller.js (PR 6, refactor
// step 3), lines 1919-1972: the markup runClass wrote into #cmet (metric tiles),
// #classAssumedRfNote (fs/Rf coverage note) and #cbody (classified-row table), as pure
// string functions of the values classifyCpt() returns. The controller still does the
// `innerHTML=` writes (the markup itself is restyled once, in the D-stream Stage 2 PR).

import { SOIL_CLASS_NAMES } from '../soil-styles.js';
import { classificationMetricValue } from './labels.js';

/** #cmet — the six metric tiles of classifyCpt().metrics */
export function classificationMetricsHtml(metrics){
  return metrics.map(m=>`<div class="met"><div class="met-l">${m.l}</div><div class="met-v">${m.v}</div></div>`).join('');
}

/** #classAssumedRfNote — '' when every reading has measured Rf */
export function classificationAssumedRfNoteHtml(note){
  const {kind, missing, n, assumedRf, gaps}=note;
  const rfTxt=`R<sub>f</sub> = ${assumedRf.toFixed(1)} %`;
  if(kind==='none'){
    return '';
  }else if(kind==='none-measured'){
    return `<div class="layerwarn layerwarn-bad">
          <span class="layerwarn-k">Geen gemeten sleeve friction</span><br>
          <span class="layerwarn-msg">Het bronbestand bevat geen fs/R<sub>f</sub>. De classificatie gebruikt overal een
          <strong>aangenomen ${rfTxt}</strong> (instelbaar hierboven). Grondtypes en afgeleide parameters zijn daardoor
          indicatief — controleer de lagen in Stage 3 tegen boringen of projectkennis.</span>
        </div>`;
  }else if(kind==='partial'){
    return `<div class="layerwarn layerwarn-adj">
          <span class="layerwarn-k">Sleeve friction deels gemeten</span><br>
          <span class="layerwarn-msg">${missing} van ${n} metingen hebben geen fs/R<sub>f</sub> in het bronbestand;
          voor die metingen geldt een <strong>aangenomen ${rfTxt}</strong> (instelbaar hierboven).
          Controleer de betreffende lagen in Stage 3.</span>
        </div>`;
  }
  const depthTxt=gaps.length<=3?` (op ${gaps.join(', ')} m)`:'';
  return `<div class="data-note"><strong>${missing} van ${n}</strong> metingen zonder gemeten
        fs/R<sub>f</sub>${depthTxt} — daarvoor geldt de aangenomen ${rfTxt}. De overige ${n-missing} metingen
        gebruiken de gemeten waarden.</div>`;
}

/**
 * #cbody — one <tr> per classified reading.
 * @param {object[]} classified  classifyCpt().classified
 * @param {{method: string, elev: number|null}} opts  method for the metric column, surface level for the TAW column
 */
export function classificationTableRowsHtml(classified, {method, elev}){
  const SC=SOIL_CLASS_NAMES;
  const taw=z=>elev!=null?(elev-z).toFixed(2):'—';
  return classified.map(r=>`<tr>
    <td>${r.z.toFixed(3)}</td>
    <td style="color:var(--tx2)">${taw(r.z)}</td>
    <td>${r.qc.toFixed(3)}</td>
    <td>${r.fs!=null?(r.fs*1000).toFixed(2):'—'}</td>
    <td>${r.rf!=null?r.rf.toFixed(2):'—'}</td>
    <td><span class="sb ${SC[r.type]||'s-sand'}">${r.type}</span></td>
    <td style="font-size:10px;color:var(--tx2)">${r.subtype||'—'}</td>
    <td style="color:var(--tx3)">${classificationMetricValue(method, r)}</td>
  </tr>`).join('');
}
