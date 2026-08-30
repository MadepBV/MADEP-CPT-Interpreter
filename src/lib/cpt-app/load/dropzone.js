// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// load/dropzone.js — the whole-document drag & drop of CPT files onto `#dz`.
// 01-monolith-map.md §6.1 row `load/` (`dropzone.js`), moved out of legacy-controller.js in
// PR 20 / refactor step 10 (verbatim; `importGEFFiles` became the `onFiles` hook).
//
// The binding is idempotent through `dz.dataset.bound` — `initLegacyController()` may run more
// than once across a hot reload, and the three listeners live on `document`, not on `#dz`.

export function bindDropzone(document, onFiles){
  const dz=document.getElementById('dz');
  if(!dz || dz.dataset.bound==='1') return;
  document.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag')});
  document.addEventListener('dragleave',e=>{if(!dz.contains(e.relatedTarget))dz.classList.remove('drag')});
  document.addEventListener('drop',e=>{
    e.preventDefault();dz.classList.remove('drag');
    const files=Array.from(e.dataTransfer?.files||[]);
    onFiles(files);
  });
  dz.dataset.bound='1';
}
