// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// load/layer-svgs.js — the two Stage 1/2 layer SVGs and the preview's hover card.
// 01-monolith-map.md §6.1 row `load/` (`layer-svgs.js`), moved out of legacy-controller.js
// in PR 20 / refactor step 10.
//
// The markup builders themselves are report/svg.js (PR 8); what moves here is the DOM half the
// controller kept: sizing the viewBox, writing the markup, and the mousemove tooltip binding of
// the Stage 2 preview. Verbatim, with `S` as the `cpt` parameter.

import { buildLayerColumnSvgMarkup, buildLayerPreviewSvgMarkup } from '../report/svg.js';
import { cptHasRf } from '../classification/classify.js';

/** Stage 1 preview column (`layerColSvg`); `layers` is passed in so initCharts can paint an empty one. */
export function drawLayerColumnSvg(document, svgId, layers, maxZ, wt){
  const svg=document.getElementById(svgId);
  if(!svg)return;
  const W=60,H=400;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.innerHTML=buildLayerColumnSvgMarkup({
    layers,
    maxDepth:maxZ,
    wt,
    width:W,
    height:H,
    emptyLabel:'Run class.'
  });
}

/** Stage 2 side panel (`layerPreviewSvg`) — the full profile with the per-layer hover card. */
export function renderLayerPreviewSvg(document, svgId, cpt, {bindTooltip}){
  const svg=document.getElementById(svgId);
  if(!svg||!cpt.layers.length)return;

  const W=240, H=520;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.innerHTML=buildLayerPreviewSvgMarkup({
    layers:cpt.layers,
    rows:cpt.classified||[],
    wt:cpt.wt,
    width:W,
    height:H,
    showRf:cptHasRf(cpt)
  });
  svg.setAttribute('width','100%');
  bindTooltip();
}

export function bindLayerPreviewTooltip(document){
  const svg=document.getElementById('layerPreviewSvg');
  const wrap=svg?.parentElement;
  const tip=document.getElementById('layerPreviewTip');
  if(!svg||!wrap||!tip||svg.dataset.previewTipBound==='1') return;

  function hideTip(){ tip.style.display='none'; }
  function showTip(target, evt){
    tip.innerHTML=`<strong>${target.dataset.type||''}</strong>
      <div class="mut">${target.dataset.subtype||'—'}</div>
      <div class="row"><span>Depth</span><span>${target.dataset.top}–${target.dataset.bot} m</span></div>
      <div class="row"><span>Thickness</span><span>${target.dataset.thk} m</span></div>
      <div class="row"><span>Original points</span><span>${target.dataset.points}</span></div>
      <div class="row"><span>qc original</span><span>${target.dataset.qcmin}–${target.dataset.qcmax} MPa</span></div>
      <div class="row"><span>qc layer avg</span><span>${target.dataset.qcavg} MPa</span></div>
      <div class="row"><span>Rf original</span><span>${target.dataset.rfmin}–${target.dataset.rfmax} %</span></div>
      <div class="row"><span>Rf layer avg</span><span>${target.dataset.rfavg} %</span></div>
      <div class="row"><span>fs original</span><span>${target.dataset.fsmin}–${target.dataset.fsmax} kPa</span></div>
      <div class="row"><span>fs layer avg</span><span>${target.dataset.fsavg} kPa</span></div>`;
    tip.style.display='block';
    const rect=wrap.getBoundingClientRect();
    const pad=12, tipW=250, tipH=210;
    let left=evt.clientX-rect.left+14;
    let top=evt.clientY-rect.top+14;
    if(left+tipW>rect.width-pad) left=Math.max(pad, evt.clientX-rect.left-tipW-14);
    if(top+tipH>rect.height-pad) top=Math.max(pad, evt.clientY-rect.top-tipH-14);
    tip.style.left=`${left}px`;
    tip.style.top=`${top}px`;
  }

  svg.addEventListener('mousemove',e=>{
    const target=e.target.closest?.('[data-layer-preview]');
    if(!target){ hideTip(); return; }
    showTip(target,e);
  });
  svg.addEventListener('mouseleave',hideTip);
  svg.dataset.previewTipBound='1';
}
