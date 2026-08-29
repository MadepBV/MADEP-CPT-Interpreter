// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// layers/detect.js — Stage 3 layer detection as a pure function of the classified rows.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 6, refactor step 3), lines
// 2262-2330 (classificationSegmentKey + detectLayers). Changes: the classified rows come
// from the `cpt` argument, the settings from the layers ctx (layers/context.js), and the
// layer table is RETURNED instead of being assigned to S.layers — the controller's
// detectLayers() wrapper does the assignment (it never rendered: renderLayers() is
// called by its callers, goS(2) / setParamMethod / refreshClassificationDerivedViews).

import { layersCtx } from './context.js';
import { simpleUpwardMerge, smartPostMerge } from './merge.js';
import { segmentSummary } from './segments.js';
import { compatLevel, qcRfFit, suggestSubtype } from './tabel3-compat.js';

export function classificationSegmentKey(row, method){
  if(method==='sb260') return `${row.type}::${row.subtype||''}`;
  return row.type;
}

/**
 * @param {object} cpt  CPT state: `classified` is read (plus the ctx defaults, see layersCtx)
 * @param {object} [ctx]  layersCtx(cpt) or a partial override of it:
 *        {catalogue, method, paramMethod, useSB260params, smartMerge, minThk, smartMergeSensitivity}
 * @returns {object[]} the layer table (fresh objects, `ovr: {}` on each)
 */
export function detectLayers(cpt, ctx){
  const cfg = layersCtx(cpt, ctx || {});
  const CAT = cfg.catalogue;
  const d=cpt.classified;
  const raw=[];
  let cur={type:d[0].type, subtype:d[0].subtype||'', key:classificationSegmentKey(d[0], cfg.method), rows:[d[0]]};
  for(let i=1;i<d.length;i++){
    const key=classificationSegmentKey(d[i], cfg.method);
    if(key===cur.key) cur.rows.push(d[i]);
    else{
      raw.push(cur);
      cur={type:d[i].type, subtype:d[i].subtype||'', key, rows:[d[i]]};
    }
  }
  raw.push(cur);

  // Important: the original raw layering is always created first from the
  // unmodified point-by-point classification sequence above.
  // Then:
  //   - baseline mode: enforce minimum thickness by upward merge
  //   - smart mode: reduce by similarity first, enforce minimum thickness last
  const merged=cfg.smartMerge ? smartPostMerge(raw, cfg) : simpleUpwardMerge(raw, cfg);

  const mergedSummaries=merged.map((seg,i)=>segmentSummary({...seg,isFirst:i===0}, i>0?merged[i-1]:null, cfg));
  let prevBot=null;
  return merged.map((seg,i)=>{
    const sum=mergedSummaries[i];
    const top=prevBot==null?sum.top:+prevBot.toFixed(3);
    const bot=Math.max(top,+sum.bot.toFixed(3));
    prevBot=bot;
    const {avgQc,avgFs,avgRf,subtype}=sum;
    let {g,gs,phi,c,cu}=sum;
    // Auto-suggest best Eurocode Table 3 subtype from catalogue based on avgQc + avgRf
    // Only if subtype not already forced by the classification itself
    const tmpLayer={type:seg.type,subtype,avgQc,avgRf};
    const suggestion=suggestSubtype(tmpLayer, CAT);
    const suggestedSubtype=suggestion?suggestion.subtype:subtype;
    // Without measured Rf, Tabel 3 rows that share a qc band cannot be told
    // apart — the suggestion falls back to catalogue order (conservative for
    // the common Flanders profiles, and the engineer reviews/overrides in
    // Stage 3). Flag the layer so that fallback is visible, not silent.
    const rfIndeterminate=avgRf==null && !!suggestion &&
      CAT.filter(r=>compatLevel(seg.type,r.grp)==='ok' && qcRfFit(r,avgQc,null)==='match').length>1;
    // If suggestion differs from classification subtype, apply suggestion params
    // but mark it as a suggestion (not a manual override)
    let sg=g,sgs=gs,sphi=Math.round(phi),sc=Math.round(c),scu=Math.round(cu);
    if(suggestion&&cfg.paramMethod==='sb260'){
      sg=suggestion.g; sgs=suggestion.gs;
      sphi=suggestion.phi; sc=suggestion.c; scu=suggestion.cu;
    }
    return{id:i,top,bot,type:seg.type,subtype:suggestedSubtype,avgQc,avgFs,avgRf,
      rfIndeterminate,
      g:sg,gs:sgs,phi:sphi,c:sc,cu:scu,ovr:{}};
  });
}
