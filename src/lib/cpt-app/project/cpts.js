// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// project/cpts.js — the CPT list of a project: select / add / remove / rename
// (01-monolith-map.md §2.0, §3.4 #1 "S closure + reassignment", §3.4 #8 workers).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): selectCpt 395-464,
// addCpt 466-474, setCptName 476-479, removeCpt 516-526. Every function takes the project
// explicitly; the module-level `S` of the controller is re-pointed only through `ctx.setActive(idx)`
// (core/state.js `setActiveCpt`), and read through `ctx.getActive()` where the old body read `S`
// *before* the switch (the Chart.js instances of the CPT being left). The Stage 1/2/4 control
// sync of selectCpt (old 421-449) is `syncCptControls(document, cpt, ctx)`, reusing the
// load/controls.js writers where the writes are the same statements.
//
// selectCpt ctx:
//   document                       the DOM (stub under Node)
//   getActive()                    the controller's S before the switch
//   setActive(idx)                 re-point PROJECT.activeCptIdx + S; returns the CPT
//   stopWorkers()                  stage6BishopStopSearch(true) + stage6BishopStopSeepage(true)
//                                  (+ stage6BishopStopDeformation(true) — PLAN §4 defect 2, the
//                                  fix commit of PR 14)
//   cancelClassificationRefresh()  clears the Stage 2 debounce timer
//   renderBanner()                 the banner for the new active CPT
//   syncClassificationMethodCards(method)   Stage 2 method cards (.sel)
//   initCharts()                   Stage 1 raw charts (scheduled on a frame, reads S at that time)
//   drawLayerColumnSvg(svgId, layers, maxZ)   the Stage 1 layer column

import {
  syncWaterTableControls,
  syncElevationControl,
  syncCoordinateControls,
  renderElevationSource,
  renderWaterTableDisplay,
  renderAssumedRfControls,
  renderMetaCard
} from '../load/controls.js';
import { resetStageNav } from './nav.js';

/** The fresh `#chartArea` markup selectCpt writes so the Stage 1 canvases are new elements. */
export const CHART_AREA_HTML=`
      <div class="viz"><div class="viz__title">layers</div><svg id="layerColSvg" viewBox="0 0 60 400"></svg></div>
      <div class="viz"><div class="viz__title">qc (MPa)</div><div style="position:relative;height:380px"><canvas id="cQc" role="img" aria-label="qc vs depth">qc profile</canvas></div></div>
      <div class="viz"><div class="viz__title">fs (kPa)</div><div style="position:relative;height:380px"><canvas id="cFs" role="img" aria-label="fs vs depth">fs profile</canvas></div></div>
      <div class="viz"><div class="viz__title">Rf (%)</div><div style="position:relative;height:380px"><canvas id="cRf" role="img" aria-label="Rf vs depth">Rf profile</canvas></div></div>`;

/** Sync the Stage 1 / 2 / 4 controls to a CPT's values (selectCpt old 421-449, same order). */
export function syncCptControls(document, cpt, {syncClassificationMethodCards}){
  syncWaterTableControls(document, cpt);
  syncElevationControl(document, cpt);
  const smartMergeEl=document.getElementById('smartMergeChk');
  if(smartMergeEl) smartMergeEl.checked=!!cpt.smartMerge;
  const smartSensRange=document.getElementById('smartMergeSensR');
  const smartSensNum=document.getElementById('smartMergeSensN');
  if(smartSensRange) smartSensRange.value=(cpt.smartMergeSensitivity ?? 1.1).toFixed(2);
  if(smartSensNum) smartSensNum.value=(cpt.smartMergeSensitivity ?? 1.1).toFixed(2);
  const smartMergeControls=document.getElementById('smartMergeControls');
  if(smartMergeControls) smartMergeControls.style.display=cpt.smartMerge?'':'none';
  syncCoordinateControls(document, cpt);
  renderElevationSource(document, cpt); renderWaterTableDisplay(document, cpt); renderAssumedRfControls(document, cpt);
  document.getElementById('btnAlphaA').classList.toggle('active',cpt.alphaMethod==='A');
  document.getElementById('btnAlphaB').classList.toggle('active',cpt.alphaMethod==='B');
  document.getElementById('btnStiffA').classList.toggle('active',cpt.stiffMethod==='A');
  document.getElementById('btnStiffB').classList.toggle('active',cpt.stiffMethod==='B');
  // khKvMethod buttons are added in Stage 4; tolerate missing nodes during early init.
  const btnKhKvA = document.getElementById('btnKhKvA');
  const btnKhKvB = document.getElementById('btnKhKvB');
  if (btnKhKvA) btnKhKvA.classList.toggle('active', cpt.khKvMethod==='A');
  if (btnKhKvB) btnKhKvB.classList.toggle('active', cpt.khKvMethod==='B');
  syncClassificationMethodCards(cpt.method);
}

/** Make CPT `idx` the active one: stop the Stage 6 workers, drop the old CPT's charts, re-point
    S, banner, Stage 1 nav + controls, fresh chart canvases when the CPT has data. */
export function selectCpt(project, idx, ctx){
  if(idx<0||idx>=project.cpts.length)return;
  const {document}=ctx;
  ctx.stopWorkers();
  ctx.cancelClassificationRefresh();

  // Destroy any existing Chart.js instances tied to the DOM canvases
  // (they are shared DOM elements, but each CPT has its own chart state)
  try{
    Object.values(ctx.getActive().charts||{}).forEach(c=>{if(c&&c.destroy)c.destroy();});
  }catch(e){}

  const cpt=ctx.setActive(idx);
  ctx.renderBanner();

  // Reset stage nav to Stage 1
  resetStageNav(document);

  // Sync controls to this CPT's values
  syncCptControls(document, cpt, ctx);

  if(cpt.data.length){
    renderMetaCard(document, cpt);
    document.getElementById('s1body').style.display='block';
    // Force fresh chart creation for this CPT
    cpt.chartsReady=false;
    cpt.charts={};
    // Rebuild chart area DOM so canvases are fresh
    const cr=document.getElementById('chartArea');
    if(cr) cr.innerHTML=CHART_AREA_HTML;
    requestAnimationFrame(()=>ctx.initCharts());
    ctx.drawLayerColumnSvg('layerColSvg', cpt.layers, cpt.data[cpt.data.length-1]?.z+0.5||20);
  } else {
    document.getElementById('s1body').style.display='none';
  }
}

/** Append an empty CPT, select it and open the file picker for it. */
export function addCpt(project, {document, newCptState, selectCpt}){
  const idx=project.cpts.length;
  const cpt=newCptState('CPT-'+(idx+1));
  project.cpts.push(cpt);
  project.sectionOrder.push(idx);
  selectCpt(idx);
  // Open file picker for the new CPT
  document.getElementById('fi').click();
}

export function setCptName(project, idx, name, {renderBanner}){
  project.cpts[idx].id=name.trim()||('CPT-'+(idx+1));
  renderBanner();
}

/** Remove CPT `idx` after confirmation (never the last one); the active index is clamped. */
export function removeCpt(project, idx, {confirm, setActive, renderBanner, selectCpt}){
  if(project.cpts.length<=1)return;
  if(!confirm(`CPT "${project.cpts[idx].id}" verwijderen?`))return;
  project.cpts.splice(idx,1);
  project.sectionOrder=project.sectionOrder.filter(i=>i!==idx).map(i=>i>idx?i-1:i);
  const newActive=Math.min(project.activeCptIdx,project.cpts.length-1);
  setActive(newActive);
  renderBanner();
  selectCpt(newActive);
}
