// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// project/phase.js — the three phase views: analysis (stage nav + panels), correlation
// (stratigraphy) and section (Doorsnede). 01-monolith-map.md §2.0 `setPhase`.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): setPhase 528-543, verbatim;
// `PROJECT.phase` → `project.phase`, `stratigraphyApp.render()` / `renderSection()` → the two
// host hooks. PR 20 (step 10) added the `#bishop` deep link of map §3.4 #11 at the bottom.

export const PHASES=['analysis','correlation','section'];

export function setPhase(document, project, ph, {renderCorrelation, renderSection}){
  project.phase=ph;
  PHASES.forEach(p=>{
    document.getElementById('phase'+p[0].toUpperCase()+p.slice(1))?.classList.toggle('active',p===ph);
  });
  document.getElementById('phaseA').classList.toggle('active',ph==='analysis');
  document.getElementById('phaseB').classList.toggle('active',ph==='correlation');
  document.getElementById('phaseC').classList.toggle('active',ph==='section');
  document.getElementById('nav').style.display    = ph==='analysis'?'flex':'none';
  document.querySelector('.wrap').style.display   = ph==='analysis'?'block':'none';
  document.getElementById('phaseCorr').style.display    = ph==='correlation'?'block':'none';
  document.getElementById('phaseSection').style.display = ph==='section'?'block':'none';
  if(ph==='correlation') renderCorrelation();
  if(ph==='section')     renderSection();
}

/* ── The `#bishop` deep link (01-monolith-map.md §3.4 #11, PLAN step 10) ─────────────────────
   Moved out of legacy-controller.js in PR 20 (composition root): `stage6BishopHashActive`
   (5488-line controller line 2040), `stage6BishopHandleHashChange` (5295) and the `hashchange`
   listener `initLegacyController` bound (5482-5485). It is a *phase* concern — a URL fragment
   that decides which view the app opens on — so it lives next to setPhase() rather than in the
   Seep/Slope package, which never reads `window.location`.

   `applyBishopHash` keeps the monolith's exact semantics: with the hash set, Stage 6 switches to
   the Seep/Slope app; without it, a Stage 6 that *is* on Seep/Slope falls back to bearing; any
   other app is left alone. `handleBishopHashChange` re-renders on every hashchange whenever the
   CPT has Stage 6 state — as the monolith did — whether or not the app actually changed. */

export const BISHOP_HASH = '#bishop';

/** True when the current URL fragment is `#bishop` (false without a window, e.g. under Node). */
export function bishopHashActive(win = typeof window !== 'undefined' ? window : null){
  return !!win && win.location?.hash === BISHOP_HASH;
}

/** Point `cpt.stage6.app` at the app the hash asks for. Returns true when the app changed. */
export function applyBishopHash(cpt, active){
  if(!cpt?.stage6) return false;
  if(active){
    if(cpt.stage6.app !== 'bishop'){ cpt.stage6.app = 'bishop'; return true; }
    return false;
  }
  if(cpt.stage6.app === 'bishop'){ cpt.stage6.app = 'bearing'; return true; }
  return false;
}

/** The `hashchange` handler: sync the app, then re-render Stage 6 (unconditionally, as before). */
export function handleBishopHashChange(cpt, {render, win}){
  if(!cpt?.stage6) return;
  applyBishopHash(cpt, bishopHashActive(win));
  render();
}

/** Bind the listener once; returns true when this call is the one that bound it. */
export function bindBishopHash(win, onHashChange){
  if(!win || typeof win.addEventListener !== 'function') return false;
  win.addEventListener('hashchange', onHashChange);
  return true;
}
