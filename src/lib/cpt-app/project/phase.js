// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// project/phase.js — the three phase views: analysis (stage nav + panels), correlation
// (stratigraphy) and section (Doorsnede). 01-monolith-map.md §2.0 `setPhase`.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): setPhase 528-543, verbatim;
// `PROJECT.phase` → `project.phase`, `stratigraphyApp.render()` / `renderSection()` → the two
// host hooks. (The `#bishop` hash of map §3.4 #11 is not handled here — step 10.)

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
