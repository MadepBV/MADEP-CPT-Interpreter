// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Serial multi-file CPT import. Moved from legacy-controller.js
// importCptFiles (old lines 436-488) in refactor step 5 (PR 9) with one
// change: each file is parsed for an EXPLICIT target CPT instead of the
// controller temporarily pointing S (and PROJECT.activeCptIdx) at the target
// around the parse. The importers receive the target CPT, apply the patch to
// it and sync the Stage 1 DOM from it, which is exactly what the swapped S
// used to do; the active CPT and the banner are never re-pointed. Proof of
// equivalence: worklog/refactor/10-pr9-load.md §2.
//
// Files are still read one after the other: the review dialog is modal and
// the parsers drive shared DOM (Stage 1 controls, charts).
//
// ctx:
//   project          { cpts, activeCptIdx, sectionOrder } — the live PROJECT
//   newCptState(id)  fresh CPT state for every file after the first
//   importers        { gef(text, fname, cpt), csv(text, fname, cpt), excel(buffer, fname, cpt) }
//                    → Promise<boolean|undefined>; false = not applied (cancelled / rejected)
//   onImported(targetIdx, isFirst)  after each file (also after a cancelled or failed parse):
//                    the first file's CPT is the active one and is (re)selected, the others only
//                    need the banner
//   renderBanner()   after a successful parse (the CPT got its file name as id)
//   alert(message)   user-facing error
//   FileReader       optional; defaults to the global

import { isCsvCptFile, isExcelCptFile, stripCptFileExtension } from './file-kind.js';

export function importCptFiles(files, ctx){
  if(!files.length)return;
  const {project}=ctx;

  // Build list of target CPT indices before any async work
  const targets=files.map((f,fi)=>{
    if(fi===0) return project.activeCptIdx;
    const idx=project.cpts.length;
    project.cpts.push(ctx.newCptState('CPT-'+(idx+1)));
    project.sectionOrder.push(idx);
    return idx;
  });

  const Reader=ctx.FileReader||globalThis.FileReader;

  // Load serially: each file's reader waits for previous to complete
  function loadNext(fi){
    if(fi>=files.length)return;
    const f=files[fi], targetIdx=targets[fi];
    const reader=new Reader();
    reader.onload=async e=>{
      const target=project.cpts[targetIdx];
      try{
        let ok;
        if(isExcelCptFile(f)) ok=await ctx.importers.excel(e.target.result,f.name,target);
        else if(isCsvCptFile(f)) ok=await ctx.importers.csv(e.target.result,f.name,target);
        else ok=await ctx.importers.gef(e.target.result,f.name,target);
        if(ok!==false){
          target.id=stripCptFileExtension(f.name);
          ctx.renderBanner();
        }
      }catch(err){
        console.error(err);
        ctx.alert(`Error importing ${f.name}: ${err?.message||err}`);
      }
      ctx.onImported(targetIdx, fi===0);
      loadNext(fi+1);
    };
    reader.onerror=()=>{ ctx.alert('Error reading '+f.name); loadNext(fi+1); };
    if(isExcelCptFile(f)) reader.readAsArrayBuffer(f);
    else reader.readAsText(f);
  }
  loadNext(0);
}
