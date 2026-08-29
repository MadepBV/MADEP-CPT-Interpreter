// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stage 1 DOM syncs after a CPT is loaded. The DOM half of
// legacy-controller.js applyParsedCpt (old lines 945-959) plus the bodies of
// updateElevSrc / updateWTDisplay / updateAssumedRfControls / renderMeta
// (old lines 1277-1312, 1368-1374), moved in refactor step 5 (PR 9). Every
// function takes `document` and the CPT explicitly so the loader can sync
// for a target CPT without swapping the controller's S; the controller keeps
// the old no-argument names as wrappers over the active CPT.
//
// The element ids written here (wtR, wtN, elevN, cptX, cptY, elev-src,
// wt-src, wt-taw, assumedRfCtrl, assumedRfN, mgrid, finfo, s1body) are the
// Stage 1 markup of src/lib/components/cpt/stages/Stage1Load.svelte.

import { normalizeAssumedRf } from '../classification-core.js';

export function syncWaterTableControls(document, cpt){
  document.getElementById('wtR').value=cpt.wt;
  document.getElementById('wtN').value=cpt.wt.toFixed(2);
}

export function syncElevationControl(document, cpt){
  document.getElementById('elevN').value=cpt.elev!=null?cpt.elev.toFixed(2):'';
}

export function syncCoordinateControls(document, cpt){
  const cptXEl=document.getElementById('cptX');
  const cptYEl=document.getElementById('cptY');
  if(cptXEl) cptXEl.value=cpt.x!=null?cpt.x:'';
  if(cptYEl) cptYEl.value=cpt.y!=null?cpt.y:'';
}

/** "(from ZID)" / "(manually set)" / "(not set — …)" next to the surface level. */
export function renderElevationSource(document, cpt){
  const src=cpt.elevSource || 'ZID';
  document.getElementById('elev-src').textContent=
    cpt.elevFromFile?`(from ${src})`:cpt.elev!=null?'(manually set)':'(not set — enter for TAW output)';
}

/** Water-table source tag and its m TAW equivalent (when the surface level is known). */
export function renderWaterTableDisplay(document, cpt){
  document.getElementById('wt-src').textContent=cpt.wtFromFile?`(${cpt.wtSource || 'file'})`:'(default)';
  const tawEl=document.getElementById('wt-taw');
  if(cpt.elev!=null){
    const wtTaw=(cpt.elev-cpt.wt).toFixed(2);
    tawEl.textContent=`= ${wtTaw} m TAW`;
  }else{tawEl.textContent='';}
}

/** Assumed-Rf control: shown only when readings without Rf exist. */
export function renderAssumedRfControls(document, cpt){
  const show=cpt.data.length>0 && cpt.data.some(r=>r.rf==null);
  const wrap=document.getElementById('assumedRfCtrl');
  if(wrap) wrap.style.display=show?'inline-flex':'none';
  const inp=document.getElementById('assumedRfN');
  if(inp) inp.value=normalizeAssumedRf(cpt.assumedRf).toFixed(1);
}

/** Stage 1 meta card (#mgrid) and file line (#finfo). */
export function renderMetaCard(document, cpt){
  const m=cpt.meta, d=cpt.data;
  const maxQc=d.reduce((mx,r)=>Math.max(mx,r.qc),0).toFixed(2);
  const items=[
    {l:'Project',v:m.project||'—'},{l:'Test ID',v:m.testid||'—'},
    {l:'Location',v:m.location||'—'},{l:'Owner',v:m.owner||'—'},
    {l:'Date',v:m.date||'—'},{l:'Readings',v:m.nRows},
    {l:'Depth (m)',v:`${(+m.depthMin).toFixed(2)}–${(+m.depthMax).toFixed(2)}`},
    {l:'Surface (m TAW)',v:m.zid!=null?m.zid.toFixed(2):'—'},
    {l:'Area ratio a',v:m.aRatio.toFixed(3)},
    {l:'Sleeve fric. fs',v:(m.hasFs??d.some(r=>r.fs!=null))?'Present':'—'},
    {l:'Pore pres. u2',v:m.hasU2?'Present':'—'},
    {l:'max qc (MPa)',v:maxQc},
  ];
  document.getElementById('mgrid').innerHTML=items.map(i=>
    `<div class="mi"><div class="mi-l">${i.l}</div><div class="mi-v">${i.v}</div></div>`).join('');
  document.getElementById('finfo').textContent=`${m.fname||''} — ${m.nRows} readings`;
}

export function showStage1Body(document){
  document.getElementById('s1body').style.display='block';
}

/** The DOM syncs applyParsedCpt performed after writing the CPT, in the
    same order (the chart init that followed stays with the controller: it
    is scheduled on a frame and reads the active CPT at that time). */
export function syncParsedCptDom(document, cpt){
  syncWaterTableControls(document, cpt);
  syncElevationControl(document, cpt);
  syncCoordinateControls(document, cpt);
  renderElevationSource(document, cpt);
  renderWaterTableDisplay(document, cpt);
  renderAssumedRfControls(document, cpt);
  renderMetaCard(document, cpt);
  showStage1Body(document);
}

/** The DOM syncs of loadDemo (as applyParsedCpt's, without the coordinate inputs). */
export function syncDemoDom(document, cpt){
  syncWaterTableControls(document, cpt);
  syncElevationControl(document, cpt);
  renderElevationSource(document, cpt);
  renderWaterTableDisplay(document, cpt);
  renderAssumedRfControls(document, cpt);
  renderMetaCard(document, cpt);
  showStage1Body(document);
}
