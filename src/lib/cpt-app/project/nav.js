// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// project/nav.js — stage navigation (01-monolith-map.md §2.0 `goS` + the `.si` binding,
// §3.4 #3 "stage visibility lives only in the DOM").
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): goS 876-895 and the
// module-scope `.si` click binding 896-900. Split into the state part (`trackMaxStage`: the
// `_maxStage` mirror on the CPT), the DOM part (`applyStageNav`: `.panel.active` and the
// `.si` active/done/locked classes) and the render dispatch the host passes in
// (`renderStage(n)`: 2 → renderLayers, 3 → renderModel, 4 → renderTuning, 5 → renderStage6).
// `resetStageNav` is selectCpt's "back to Stage 1" loop (old 411-416), which is exactly
// `applyStageNav(document, 0, 0)` — the same classList calls in the same order.

/** Track the highest stage reached on the CPT (nav tabs stay unlocked); returns it. */
export function trackMaxStage(cpt, n){
  if(!cpt._maxStage) cpt._maxStage=0;
  if(n>cpt._maxStage) cpt._maxStage=n;
  return cpt._maxStage;
}

/** Show panel `n`; mark stage tabs active / done (reached) / locked. */
export function applyStageNav(document, n, maxReached){
  document.querySelectorAll('.panel').forEach((p,i)=>p.classList.toggle('active',i===n));
  document.querySelectorAll('.si').forEach((s,i)=>{
    s.classList.remove('active','locked','done');
    if(i===n) s.classList.add('active');
    else if(i<=maxReached) s.classList.add('done');  // all reached stages stay clickable
    else s.classList.add('locked');
  });
}

/** Back to Stage 1 with every other stage locked (what selectCpt does on a CPT switch). */
export function resetStageNav(document){
  applyStageNav(document, 0, 0);
}

/** goS(n): track the CPT's max stage, switch the DOM, render the stage's body. */
export function goS(document, cpt, n, renderStage){
  const maxReached=trackMaxStage(cpt, n);
  applyStageNav(document, n, maxReached);
  renderStage(n);
}

/** The stage-rail click binding (unlocked tabs only). The host calls this once at load. */
export function bindStageNav(document, goS){
  document.querySelectorAll('.si').forEach(s=>{
    s.addEventListener('click',()=>{
      if(!s.classList.contains('locked'))goS(+s.dataset.s);
    });
  });
}
