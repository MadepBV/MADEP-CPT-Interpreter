// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// classification/panel.js — HTML string builders of the Stage 2 panel.
//
// Extracted from runClass() in src/lib/cpt-app/legacy-controller.js (PR 6, refactor
// step 3), lines 1919-1972: the markup runClass wrote into #cmet (metric tiles),
// #classAssumedRfNote (fs/Rf coverage note) and #cbody (classified-row table), as pure
// string functions of the values classifyCpt() returns. The controller still does the
// `innerHTML=` writes. The markup uses the component classes of src/lib/styles/components.css
// (PR 10): .stat tiles, .verdict notes, .tbl rows with .pill soil badges.

import { SOIL_CLASS_NAMES } from '../soil-styles.js';
import { classificationMetricValue } from './labels.js';

/** #cmet — the six metric tiles of classifyCpt().metrics */
export function classificationMetricsHtml(metrics){
  return metrics.map(m=>`<div class="stat"><div class="stat__label">${m.l}</div><div class="stat__value">${m.v}</div></div>`).join('');
}

/** #classAssumedRfNote — '' when every reading has measured Rf */
export function classificationAssumedRfNoteHtml(note){
  const {kind, missing, n, assumedRf, gaps}=note;
  const rfTxt=`R<sub>f</sub> = ${assumedRf.toFixed(1)} %`;
  if(kind==='none'){
    return '';
  }else if(kind==='none-measured'){
    return `<div class="verdict verdict--bad">
          <span class="verdict__tag">Geen gemeten sleeve friction</span>
          <span class="verdict__body">Het bronbestand bevat geen fs/R<sub>f</sub>. De classificatie gebruikt overal een
          <strong>aangenomen ${rfTxt}</strong> (instelbaar hierboven). Grondtypes en afgeleide parameters zijn daardoor
          indicatief — controleer de lagen in Stage 3 tegen boringen of projectkennis.</span>
        </div>`;
  }else if(kind==='partial'){
    return `<div class="verdict verdict--warn">
          <span class="verdict__tag">Sleeve friction deels gemeten</span>
          <span class="verdict__body">${missing} van ${n} metingen hebben geen fs/R<sub>f</sub> in het bronbestand;
          voor die metingen geldt een <strong>aangenomen ${rfTxt}</strong> (instelbaar hierboven).
          Controleer de betreffende lagen in Stage 3.</span>
        </div>`;
  }
  const depthTxt=gaps.length<=3?` (op ${gaps.join(', ')} m)`:'';
  return `<div class="verdict verdict--inline verdict--neutral"><div class="verdict__body"><strong>${missing} van ${n}</strong> metingen zonder gemeten
        fs/R<sub>f</sub>${depthTxt} — daarvoor geldt de aangenomen ${rfTxt}. De overige ${n-missing} metingen
        gebruiken de gemeten waarden.</div></div>`;
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
    <td class="num">${r.z.toFixed(3)}</td>
    <td class="num" style="color:var(--color-ink-2)">${taw(r.z)}</td>
    <td class="num">${r.qc.toFixed(3)}</td>
    <td class="num">${r.fs!=null?(r.fs*1000).toFixed(2):'—'}</td>
    <td class="num">${r.rf!=null?r.rf.toFixed(2):'—'}</td>
    <td><span class="pill ${SC[r.type]||'s-sand'}">${r.type}</span></td>
    <td class="key" style="font-size:var(--fs-xs)">${r.subtype||'—'}</td>
    <td class="num" style="color:var(--color-ink-3)">${classificationMetricValue(method, r)}</td>
  </tr>`).join('');
}
