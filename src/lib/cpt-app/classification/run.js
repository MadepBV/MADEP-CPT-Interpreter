// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// classification/run.js — the Stage 2 classification run as a pure computation.
//
// Extracted from runClass() in src/lib/cpt-app/legacy-controller.js (PR 6, refactor
// step 3), lines 1896-1980: everything runClass computed before it touched the DOM —
// the classified rows, the assumed-Rf bookkeeping, the six metric tiles, the fs/Rf
// coverage note and the metric column label. No DOM, no render, no writes to the CPT:
// the controller's runClass assigns `classified / rfAssumedCount / useSB260params`
// to the active CPT and hands `metrics / assumedRfNote / metricLabel` to panel.js.
//
// Requires cpt.data.length > 0 (runClass guards the empty case with its alert first).

import { assumedRfValue, classifyRow } from './classify.js';
import { classificationMethodLabel, classificationMetricLabel } from './labels.js';

/**
 * @param {object} cpt  CPT state: data, method, wt, meta, assumedRf are read (nothing is written)
 * @param {{method?: string}} [ctx]  optional overrides; `method` defaults to cpt.method
 * @returns {{
 *   method: string,
 *   useSB260params: boolean,
 *   classified: object[],
 *   rfAssumedCount: number,
 *   metrics: {l: string, v: string|number}[],
 *   metricLabel: string,
 *   assumedRfNote: {kind: 'none'|'none-measured'|'partial'|'gaps', missing: number, n: number, assumedRf: number, gaps: string[]}
 * }}
 */
export function classifyCpt(cpt, ctx = {}){
  const method = ctx.method ?? cpt.method;

  const useSB260params=(method==='sb260');

  const classified=cpt.data.map(r=>Object.assign({},r,classifyRow(cpt, r, method)));

  const cl=classified;
  const n=cl.length;
  const fsRows=cl.filter(r=>r.fs!=null);
  const rfRows=cl.filter(r=>r.rf!=null);
  const avg=(rows,fn)=>rows.reduce((s,x)=>s+fn(x),0)/rows.length;

  // Readings classified without measured Rf → the assumed Rf was used.
  const rfAssumedCount=n-rfRows.length;

  const metrics=[
    {l:'avg qc (MPa)',  v:avg(cl,r=>r.qc).toFixed(2)},
    {l:'avg fs (kPa)',  v:fsRows.length?(avg(fsRows,r=>r.fs)*1000).toFixed(1):'—'},
    {l:'avg Rf (%)',    v:rfRows.length?avg(rfRows,r=>r.rf).toFixed(2):'—'},
    {l:'max depth (m)', v:cl[n-1].z.toFixed(2)},
    {l:'readings',      v:n},
    {l:'method',        v:classificationMethodLabel(method)}
  ];

  /* fs/Rf coverage note — severity follows the share of affected readings.
     A fully qc-only file compromises every classification (strong warning);
     a handful of gaps (typically the final reading of a push) only merits a
     quiet data note naming the depths, because the profile IS measured. */
  const missing=rfAssumedCount;
  const noneMeasured=fsRows.length===0&&rfRows.length===0;
  const assumedRf=assumedRfValue(cpt);
  let kind, gaps=[];
  if(missing===0){
    kind='none';
  }else if(noneMeasured){
    kind='none-measured';
  }else if(missing/n>=0.05){
    kind='partial';
  }else{
    kind='gaps';
    gaps=cl.filter(r=>r.rf==null).map(r=>r.z.toFixed(2));
  }

  return {
    method,
    useSB260params,
    classified,
    rfAssumedCount,
    metrics,
    metricLabel: classificationMetricLabel(method),
    assumedRfNote: {kind, missing, n, assumedRf, gaps}
  };
}
