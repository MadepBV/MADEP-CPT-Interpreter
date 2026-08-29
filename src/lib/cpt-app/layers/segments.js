// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// layers/segments.js — segment summaries and the similarity scores of the Stage 3
// layer detection.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 6, refactor step 3), lines
// 1988-2135: segmentSummary / segmentTop / familyClass, the six similarity terms,
// isCriticalMarkerLayer, SMART_SLIVER_REF and mergeCandidateScore. The only change:
// segmentSummary takes the layers ctx (layers/context.js) as its third argument instead
// of reading S.useSB260params — everything else never read the active CPT.

import { DEF } from '../model-params/soil-defaults.js';
import { compatLevel, layerTypeCompatScore, subtypeGroup } from './tabel3-compat.js';

/**
 * @param {object} seg        {type, subtype, rows, isFirst?, _top?}
 * @param {object|null} prevSeg
 * @param {{useSB260params?: boolean}} [ctx]  layersCtx(cpt); with useSB260params the
 *        Tabel 3 parameters carried on the classified rows are averaged, else DEF[type]
 */
export function segmentSummary(seg, prevSeg, ctx = {}){
  const r=seg.rows.filter(x=>x.qc>0.02);
  const rows=r.length?r:seg.rows;
  const top=segmentTop(seg, prevSeg);
  const bot=+seg.rows[seg.rows.length-1].z.toFixed(3);
  const avgQc=+(rows.reduce((s,x)=>s+x.qc,0)/rows.length).toFixed(3);
  const fsR=rows.filter(x=>x.fs!=null);
  const avgFs=fsR.length?+(fsR.reduce((s,x)=>s+x.fs,0)/fsR.length).toFixed(5):null;
  const rfR=rows.filter(x=>x.rf!=null);
  const avgRf=rfR.length?+(rfR.reduce((s,x)=>s+(x.rf??0),0)/rfR.length).toFixed(2):null;
  const subtypeCounts={};
  seg.rows.forEach(row=>{const st=row.subtype||'';subtypeCounts[st]=(subtypeCounts[st]||0)+1;});
  const subtype=Object.keys(subtypeCounts).sort((a,b)=>subtypeCounts[b]-subtypeCounts[a])[0]||'';
  let g,gs,phi,c,cu;
  if(ctx.useSB260params){
    const vr=seg.rows.filter(x=>x.g!=null);
    if(vr.length){
      const avg2=fn=>+(vr.reduce((s,x)=>s+fn(x),0)/vr.length).toFixed(1);
      g=+avg2(x=>x.g); gs=+avg2(x=>x.gs); phi=+avg2(x=>x.phi); c=+avg2(x=>x.c); cu=+avg2(x=>x.cu);
    }else{
      const df=DEF[seg.type]||DEF['Sand']; g=df.g; gs=df.gs; phi=df.phi; c=df.c; cu=df.cu;
    }
  }else{
    const df=DEF[seg.type]||DEF['Sand']; g=df.g; gs=df.gs; phi=df.phi; c=df.c; cu=df.cu;
  }
  return{type:seg.type,subtype,avgQc,avgFs,avgRf,g,gs,phi,c,cu,top,bot,thk:+(bot-top).toFixed(3),rows:seg.rows.length};
}

export function segmentTop(seg, prevSeg){
  if(!seg) return 0;
  if(seg._top!=null) return +(+seg._top).toFixed(3);
  if(seg.isFirst) return 0;

  const prevLast=prevSeg?.rows?.[prevSeg.rows.length - 1]?.z;
  const currFirst=seg.rows?.[0]?.z;

  if(Number.isFinite(prevLast) && Number.isFinite(currFirst) && currFirst > prevLast){
    return +(0.5 * (prevLast + currFirst)).toFixed(3);
  }

  if(Number.isFinite(currFirst)){
    return +(currFirst - 0.02).toFixed(3);
  }

  return Number.isFinite(prevLast) ? +prevLast.toFixed(3) : 0;
}

export function familyClass(layer){
  const grp=subtypeGroup(layer.subtype);
  if(grp==='veen'||grp==='klei'||grp==='leem') return 'cohesive';
  if(grp==='zand'||grp==='grind') return 'granular';
  if(layer.type==='Peat / organic'||layer.type==='Clay'||layer.type==='Soft clay'||layer.type==='Sandy clay') return 'cohesive';
  return 'granular';
}

export function qcSimilarity(a,b){
  const qa=Math.max(0.01,a.avgQc), qb=Math.max(0.01,b.avgQc);
  return Math.max(0,1-Math.abs(Math.log(qa/qb))/Math.log(3));
}

export function rfSimilarity(a,b){
  if(a.avgRf==null||b.avgRf==null) return 0.5;
  return Math.max(0,1-Math.abs(a.avgRf-b.avgRf)/3);
}

export function subtypeSimilarity(a,b){
  if(a.subtype&&a.subtype===b.subtype) return 1;
  const ga=subtypeGroup(a.subtype), gb=subtypeGroup(b.subtype);
  if(ga&&gb&&ga===gb) return 0.75;
  const lvl=compatLevel(a.type,gb||'');
  return lvl==='ok'?0.55:lvl==='adj'?0.25:0;
}

export function paramSimilarity(a,b){
  const vals=[
    Math.max(0,1-Math.abs(a.phi-b.phi)/8),
    Math.max(0,1-Math.abs(a.g-b.g)/3),
    Math.max(0,1-Math.abs(a.c-b.c)/15)
  ];
  if(a.cu>0||b.cu>0) vals.push(Math.max(0,1-Math.abs(a.cu-b.cu)/75));
  return vals.reduce((s,v)=>s+v,0)/vals.length;
}

export function compatSimilarity(a,b){
  const grpB=subtypeGroup(b.subtype);
  const lvl=compatLevel(a.type,grpB||'');
  return lvl==='ok'?1:lvl==='adj'?0.5:0;
}

export function continuityScore(neighbor, outer){
  if(!outer) return 0.5;
  return 0.35*(layerTypeCompatScore(neighbor,outer)) + 0.35*qcSimilarity(neighbor,outer) + 0.30*rfSimilarity(neighbor,outer);
}

export function isCriticalMarkerLayer(layer, up, down){
  if(layer.type==='Peat / organic'||layer.type==='Gravel') return true;
  if(layer.avgRf!=null&&layer.avgRf>6) return true;
  if(layer.avgQc<0.35||layer.avgQc>=15) return true;
  if(up&&down){
    const fam=familyClass(layer), fu=familyClass(up), fd=familyClass(down);
    if(fam!==fu&&fam!==fd&&fu===fd) return true;
  }
  return false;
}

export const SMART_SLIVER_REF = 0.25;

export function mergeCandidateScore(layer, neighbor, outer){
  if(!neighbor) return{ok:false,score:0,why:'no-neighbor'};
  const logRatio=Math.abs(Math.log(Math.max(0.01,layer.avgQc)/Math.max(0.01,neighbor.avgQc)));
  const thicknessRef=SMART_SLIVER_REF;
  const thicknessImportance=Math.max(0,Math.min(1,(layer.thk||0)/thicknessRef));
  const sliverBonus=0.14*(1-thicknessImportance);
  const penaltyScale=0.25 + 0.75*thicknessImportance;

  const typeScore=layer.type===neighbor.type?1:layerTypeCompatScore(layer,neighbor);
  const qcScore=qcSimilarity(layer,neighbor);
  const rfScore=rfSimilarity(layer,neighbor);
  const stScore=subtypeSimilarity(layer,neighbor);
  const pScore=paramSimilarity(layer,neighbor);
  const compScore=compatSimilarity(layer,neighbor);
  const corrScore=continuityScore(neighbor,outer);
  let score=0.24*typeScore + 0.20*qcScore + 0.14*rfScore + 0.14*stScore + 0.12*pScore + 0.08*compScore + 0.08*corrScore + sliverBonus;

  // Penalise sharp transitions, but do not fully block the merge.
  // The thickness criterion remains hard; similarity only decides direction.
  if(logRatio>Math.log(2.5)) score-=0.22*penaltyScale;
  else if(logRatio>Math.log(1.8)) score-=0.10*penaltyScale;

  if(layer.avgRf!=null&&neighbor.avgRf!=null){
    const rfDiff=Math.abs(layer.avgRf-neighbor.avgRf);
    if(rfDiff>4) score-=0.16*penaltyScale;
    else if(rfDiff>2.5) score-=0.08*penaltyScale;
  }

  if((layer.type==='Peat / organic')!==(neighbor.type==='Peat / organic')) score-=0.18*penaltyScale;
  if((layer.type==='Gravel')!==(neighbor.type==='Gravel')) score-=0.14*penaltyScale;

  if(isCriticalMarkerLayer(layer,null,null) && layer.type!==neighbor.type) score-=0.10*penaltyScale;

  score=Math.max(0,+score.toFixed(3));
  return{ok:true,score};
}
