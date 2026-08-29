// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// project/banner.js — the CPT tab strip + project name of the top banner
// (01-monolith-map.md §2.0 `renderBanner`, §6.1 row `project/`).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): renderBanner 484-514.
// The markup is verbatim (the CPT id is interpolated unescaped, as before); the innerHTML is
// now a pure string builder, `bannerTabsHtml(project)`, and the DOM write + the two delegated
// listeners (remove "x", Enter/Space on a tab) are the thin `renderBanner(document, project,
// handlers)`. The inline `onclick="selectCpt(i)"` keeps resolving through window (legacyApi).

/** `#cptTabs` innerHTML: one `.cpt-tab` per CPT, the active one marked, a remove "x" when > 1. */
export function bannerTabsHtml(project){
  return project.cpts.map((cpt,i)=>{
    const isActive=i===project.activeCptIdx;
    const status=cpt.layers.length?'Ready':cpt.data.length?'Data':'Empty';
    const statusClass=cpt.layers.length?'ready':cpt.data.length?'data':'empty';
    return`<div class="cpt-tab ${isActive?'active':''}" data-cpt-index="${i}" role="button" tabindex="0" onclick="selectCpt(${i})" aria-label="Select ${cpt.id}">
      <span class="cpt-tab__status cpt-tab__status--${statusClass}">${status}</span>
      <span>${cpt.id}</span>
      ${project.cpts.length>1?`<span data-remove="${i}"
        class="cpt-tab__remove" title="Verwijder CPT" aria-label="Verwijder ${cpt.id}">x</span>`:''}
    </div>`;
  }).join('');
}

/** Delegated listeners on a freshly written tab strip (remove buttons, keyboard activation). */
export function bindBannerTabs(tabs, {selectCpt, removeCpt}){
  // Event delegation for remove buttons (avoids nested onclick issues)
  tabs.querySelectorAll('[data-remove]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const i=+el.dataset.remove;
      removeCpt(i);
    });
  });
  tabs.querySelectorAll('.cpt-tab').forEach(el=>{
    el.addEventListener('keydown', e=>{
      if(e.key!=='Enter'&&e.key!==' ') return;
      e.preventDefault();
      selectCpt(+el.dataset.cptIndex || 0);
    });
  });
}

/** Write the banner: `#cptTabs` innerHTML, `#projName` value, then bind the tab listeners. */
export function renderBanner(document, project, handlers){
  const tabs=document.getElementById('cptTabs');
  if(!tabs)return;
  tabs.innerHTML=bannerTabsHtml(project);
  document.getElementById('projName').value=project.name;
  bindBannerTabs(tabs, handlers);
}
