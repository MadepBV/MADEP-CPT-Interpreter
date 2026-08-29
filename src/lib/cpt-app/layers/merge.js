// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// layers/merge.js — the two merge chains of the Stage 3 layer detection.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 6, refactor step 3), lines
// 2137-2260: simpleUpwardMerge (baseline: minimum thickness by upward merge) and the
// smart chain smartPostMerge = smartSimilarityReduce → enforceMinThicknessBySimilarity
// with its helpers. The only change: the layers ctx (layers/context.js) is threaded
// through as the last argument — `ctx.minThk` replaces S.minThk, `ctx.smartMergeSensitivity`
// replaces S.smartMergeSensitivity, and segmentSummary receives it for useSB260params.

import { SMART_SLIVER_REF, mergeCandidateScore, segmentSummary, segmentTop } from './segments.js';

export function simpleUpwardMerge(segments, ctx){
  let changed=true;
  let merged=segments.map((seg,i)=>({...seg,isFirst:i===0}));
  while(changed){
    changed=false;
    const next=[];
    for(let i=0;i<merged.length;i++){
      const seg=merged[i];
      const rows=seg.rows;
      const prev=i>0?merged[i-1]:null;
      const thick=segmentSummary(seg, prev, ctx).thk;
      if(thick<ctx.minThk&&next.length>0){
        next[next.length-1].rows.push(...rows);
        changed=true;
      }else{
        next.push({...seg,rows:[...rows]});
      }
    }
    merged=next.map((seg,i)=>({...seg,isFirst:i===0}));
  }
  return merged;
}

export function mergeSegmentInDirection(merged, i, dir){
  const seg=merged[i];
  if(dir==='up'){
    merged[i-1].rows.push(...seg.rows);
    merged.splice(i,1);
  }else{
    merged[i+1].rows.unshift(...seg.rows);
    merged[i+1]._top=segmentTop(seg, i>0?merged[i-1]:null);
    merged.splice(i,1);
  }
  return merged.map((s,idx)=>({...s,isFirst:idx===0}));
}

export function chooseSimilarityMergeDirection(merged, i, margin, ctx){
  const seg=merged[i];
  const layer=segmentSummary(seg, i>0?merged[i-1]:null, ctx);
  const upSeg=i>0?merged[i-1]:null, downSeg=i<merged.length-1?merged[i+1]:null;
  const up=upSeg?segmentSummary(upSeg, i>1?merged[i-2]:null, ctx):null;
  const down=downSeg?segmentSummary(downSeg, seg, ctx):null;
  const upOuter=i>1?segmentSummary(merged[i-2], i>2?merged[i-3]:null, ctx):null;
  const downOuter=i<merged.length-2?segmentSummary(merged[i+2], downSeg, ctx):null;
  const upCand=mergeCandidateScore(layer,up,upOuter);
  const downCand=mergeCandidateScore(layer,down,downOuter);
  if(!upCand.ok&&!downCand.ok) return null;

  if(upCand.ok&&(!downCand.ok||upCand.score>downCand.score+margin)) return 'up';
  if(downCand.ok&&(!upCand.ok||downCand.score>upCand.score+margin)) return 'down';
  if(upCand.ok&&downCand.ok){
    const upThk=up?.thk||0, downThk=down?.thk||0;
    return upThk===downThk?'up':(upThk>downThk?'up':'down');
  }
  return upCand.ok?'up':'down';
}

export function smartSimilarityReduce(segments, sensitivity, ctx){
  let changed=true;
  let merged=segments.map((seg,i)=>({...seg,isFirst:i===0}));
  const sens=Math.max(0,Math.min(6,sensitivity ?? 1.1));
  const pairThreshold=0.90 - 0.275*sens;
  const thicknessRef=SMART_SLIVER_REF;
  while(changed){
    changed=false;
    let bestIdx=-1;
    let bestScore=-Infinity;
    for(let i=0;i<merged.length-1;i++){
      const left=segmentSummary(merged[i], i>0?merged[i-1]:null, ctx);
      const right=segmentSummary(merged[i+1], merged[i], ctx);
      const leftOuter=i>0?segmentSummary(merged[i-1], i>1?merged[i-2]:null, ctx):null;
      const rightOuter=i<merged.length-2?segmentSummary(merged[i+2], merged[i+1], ctx):null;
      const lr=mergeCandidateScore(left,right,rightOuter);
      const rl=mergeCandidateScore(right,left,leftOuter);
      if(!lr.ok||!rl.ok) continue;
      const thinBoundaryFactor=1-Math.max(0,Math.min(1,Math.min(left.thk,right.thk)/thicknessRef));
      const pairScore=+(((lr.score+rl.score)/2 + 0.10*thinBoundaryFactor)).toFixed(3);
      if(pairScore>bestScore){
        bestScore=pairScore;
        bestIdx=i;
      }
    }

    if(bestIdx>=0 && bestScore>=pairThreshold){
      merged[bestIdx].rows.push(...merged[bestIdx+1].rows);
      merged.splice(bestIdx+1,1);
      merged=merged.map((s,idx)=>({...s,isFirst:idx===0}));
      changed=true;
    }
  }
  return merged;
}

export function enforceMinThicknessBySimilarity(segments, sensitivity, ctx){
  let changed=true;
  let merged=segments.map((seg,i)=>({...seg,isFirst:i===0}));
  const sens=Math.max(0,Math.min(6,sensitivity ?? 1.1));
  const margin=Math.max(0, 0.14 - 0.08*sens);
  while(changed){
    changed=false;
    for(let i=0;i<merged.length;i++){
      const layer=segmentSummary(merged[i], i>0?merged[i-1]:null, ctx);
      if(layer.thk>=ctx.minThk) continue;
      const dir=chooseSimilarityMergeDirection(merged, i, margin, ctx);
      if(!dir) continue;
      merged=mergeSegmentInDirection(merged, i, dir);
      changed=true;
      break;
    }
  }
  return merged;
}

export function smartPostMerge(segments, ctx){
  const sensitivity=Math.max(0,Math.min(6,ctx.smartMergeSensitivity ?? 1.1));
  let merged=segments.map((seg,i)=>({...seg,isFirst:i===0}));
  // Intended smart chain:
  //   1. original raw classification-derived layering
  //   2. similarity-driven boundary reduction
  //   3. minimum-thickness enforcement as the final hard merge force
  merged=smartSimilarityReduce(merged, sensitivity, ctx);
  merged=enforceMinThicknessBySimilarity(merged, sensitivity, ctx);
  return merged;
}
