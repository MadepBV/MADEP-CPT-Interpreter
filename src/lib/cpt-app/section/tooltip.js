// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// section/tooltip.js — the layer tooltip of the section view (01-monolith-map.md §2.12).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): bindSectionTooltip 815-855.
// The tooltip markup is the pure `sectionTooltipHtml(dataset)` (the `data-*` of a
// `.section-layer-hit` rect), its placement inside the scrolling `#sectionCanvas` the pure
// `sectionTooltipPosition(...)`; `bindSectionTooltip(document)` is the listener glue, bound once
// per `#sectionSvg` (`data-tip-bound`).

export const SECTION_TIP_W=260;
export const SECTION_TIP_H=190;
export const SECTION_TIP_PAD=14;

export function sectionTooltipHtml(d){
  return `<strong>${d.cpt||'CPT'} — ${d.type||''}</strong>
      <div class="mut">${d.subtype||'—'}</div>
      <div class="row"><span>Depth</span><span>${d.top}–${d.bot} m</span></div>
      <div class="row"><span>TAW</span><span>${d.toptaw} to ${d.bottaw}</span></div>
      <div class="row"><span>Thickness</span><span>${d.thk} m</span></div>
      <div class="row"><span>avg qc</span><span>${d.qc} MPa</span></div>
      <div class="row"><span>avg fs</span><span>${d.fs} kPa</span></div>
      <div class="row"><span>avg Rf</span><span>${d.rf} %</span></div>
      <div class="row"><span>γ / γ_sat</span><span>${d.g} / ${d.gs}</span></div>
      <div class="row"><span>φ' / c' / cu</span><span>${d.phi}° / ${d.c} / ${d.cu}</span></div>`;
}

/** Tooltip top-left (px, in the canvas' scroll space) next to the pointer, flipped when it
    would leave the visible canvas. `rect` is the canvas' bounding client rect. */
export function sectionTooltipPosition({clientX, clientY, rect, scrollLeft, scrollTop}){
  const pad=SECTION_TIP_PAD;
  const tipW=SECTION_TIP_W;
  const tipH=SECTION_TIP_H;
  let left=clientX-rect.left+16+scrollLeft;
  let top =clientY-rect.top +16+scrollTop;
  const maxLeft=scrollLeft+rect.width-tipW-pad;
  const maxTop =scrollTop +rect.height-tipH-pad;
  if(left>maxLeft) left=Math.max(scrollLeft+pad, clientX-rect.left-tipW-16+scrollLeft);
  if(top>maxTop)   top =Math.max(scrollTop+pad, clientY-rect.top-tipH-16+scrollTop);
  return {left, top};
}

export function bindSectionTooltip(document){
  const svg=document.getElementById('sectionSvg');
  const canvas=document.getElementById('sectionCanvas');
  const tip=document.getElementById('sectionTip');
  if(!svg||!canvas||!tip||svg.dataset.tipBound==='1') return;

  function hideTip(){ tip.style.display='none'; }
  function showTip(target, evt){
    tip.innerHTML=sectionTooltipHtml(target.dataset);
    tip.style.display='block';
    const rect=canvas.getBoundingClientRect();
    const {left, top}=sectionTooltipPosition({clientX:evt.clientX, clientY:evt.clientY, rect, scrollLeft:canvas.scrollLeft, scrollTop:canvas.scrollTop});
    tip.style.left=`${left}px`;
    tip.style.top=`${top}px`;
  }

  svg.addEventListener('mousemove',e=>{
    const target=e.target.closest?.('[data-section-layer]');
    if(!target){ hideTip(); return; }
    showTip(target,e);
  });
  svg.addEventListener('mouseleave',hideTip);
  svg.dataset.tipBound='1';
}
