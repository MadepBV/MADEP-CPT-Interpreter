// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stage 1 "Load" package — refactor step 5 (PR 9, worklog/refactor/10-pr9-load.md).
// Pure parsers (GEF / CSV / Excel → parsed-CPT result), the apply patch, the
// serial multi-file loader with an explicit target CPT, the demo generator and
// the Stage 1 DOM syncs as functions of (document, cpt).
//
// PR 20 (refactor step 10) completed the package: raw-charts.js (the three Stage 1 profile
// charts + the "not recorded" overlays), layer-svgs.js (the two layer SVGs + the preview hover
// card), dropzone.js (the document-level drag & drop) and `installLoadApp(ctx)` at the bottom,
// which owns every Stage 1 handler the composition root used to declare.

export { stripCptFileExtension, isExcelCptFile, isCsvCptFile } from './file-kind.js';
export { parseGEF, GEF_CHANNELS } from './parsers/gef.js';
export { parseCsvCpt, splitDelimitedLine, parseDelimitedText, detectDelimitedTextSeparator } from './parsers/csv.js';
export { parseExcelCpt, loadXlsxModule } from './parsers/excel.js';
export {
  pad2,
  formatExcelHeaderValue,
  normalizeExcelLabel,
  excelHeaderLookup,
  excelHeaderText,
  excelHeaderNumber,
  findExcelSheetName
} from './parsers/excel-headers.js';
export { applyParsedCpt, reviewStaging, NO_DATA_ROWS_MESSAGE } from './apply-parsed-cpt.js';
export { importCptFiles } from './import-files.js';
export { demoRows, demoPatch } from './demo.js';
export {
  syncWaterTableControls,
  syncElevationControl,
  syncCoordinateControls,
  renderElevationSource,
  renderWaterTableDisplay,
  renderAssumedRfControls,
  renderMetaCard,
  showStage1Body,
  syncParsedCptDom,
  syncDemoDom
} from './controls.js';
export {
  arrMax,
  arrSafe,
  buildRawChartSeries,
  updateWTLine,
  setChartEmptyState,
  initCharts as initRawCharts,
  refreshChartData as refreshRawChartData,
  updateRawChartEmptyStates
} from './raw-charts.js';
export { drawLayerColumnSvg, renderLayerPreviewSvg, bindLayerPreviewTooltip } from './layer-svgs.js';
export { bindDropzone } from './dropzone.js';

import { parseGEF } from './parsers/gef.js';
import { parseCsvCpt } from './parsers/csv.js';
import { parseExcelCpt, loadXlsxModule } from './parsers/excel.js';
import { applyParsedCpt as applyParsedCptPatch, reviewStaging, NO_DATA_ROWS_MESSAGE } from './apply-parsed-cpt.js';
import { importCptFiles as importCptFilesSerially } from './import-files.js';
import { demoPatch } from './demo.js';
import {
  renderElevationSource,
  renderWaterTableDisplay,
  renderAssumedRfControls,
  renderMetaCard,
  syncParsedCptDom,
  syncDemoDom
} from './controls.js';
import { presentImportReview } from '../import-review/index.js';
import { normalizeAssumedRf } from '../classification-core.js';
import {
  arrMax,
  arrSafe,
  updateWTLine,
  initCharts as initRawCharts,
  refreshChartData as refreshRawChartData,
  updateRawChartEmptyStates as updateRawChartEmptyStatesOf
} from './raw-charts.js';
import {
  drawLayerColumnSvg as drawLayerColumnSvgInto,
  renderLayerPreviewSvg as renderLayerPreviewSvgInto,
  bindLayerPreviewTooltip as bindLayerPreviewTooltipTo
} from './layer-svgs.js';
import { bindDropzone as bindDropzoneTo } from './dropzone.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// installLoadApp(ctx) — Stage 1 bound to a host (PR 20 / refactor step 10).
//
// Everything the controller still owned of Stage 1 moved here: the parse → review → apply
// handshake and its wrappers over the active CPT, the multi-file loader, the elevation / water
// table / assumed-Rf / min-thickness / smart-merge controls, the three raw charts, the two layer
// SVGs and the dropzone. The bodies are verbatim; every `S` read became `ctx.getActive()` at the
// statement the monolith read it, and what Stage 1 triggers in later stages are hooks.
//
//   ctx.document, ctx.getProject(), ctx.getActive(), ctx.newCptState(id),
//   ctx.selectCpt(idx), ctx.renderBanner(),
//   ctx.runClass(), ctx.detectLayers(), ctx.renderLayers(),      — Stage 2 / 3 re-entry
//   ctx.toast(message, opts), ctx.alert(message)
//
// Returns the monolith's names plus `handlers`, the subset published on `window` (the inline
// `on*=` attributes of the Stage 1 markup and the Svelte `call('…')` bridge).
export function installLoadApp(ctx){
  const { document, getProject, getActive, newCptState, toast, alert } = ctx;

  /* File-kind sniffing and the serial loader live in file-kind.js / import-files.js. Each file is
     parsed for its explicit target CPT — the importers apply the patch to that CPT and sync the
     Stage 1 DOM from it — so S and PROJECT.activeCptIdx are never re-pointed during an import. */
  const cptFileImporters={
    gef:async(txt,fname,cpt)=>app.importParsedCpt(cpt, parseGEF(txt,fname)),
    csv:async(text,fname,cpt)=>app.importParsedCpt(cpt, parseCsvCpt(text,fname)),
    excel:async(buffer,fname,cpt)=>app.importParsedCpt(cpt, parseExcelCpt(await loadXlsxModule(),buffer,fname))
  };

  let classificationRefreshTimer = null;

  const app = {
    cptFileImporters,

    /* Review → apply for an explicit CPT (the seam used by the multi-file loader). */
    async importParsedCpt(cpt, parsed){
      if(!parsed.ok){alert(parsed.error);return false;}
      const review=await presentImportReview(reviewStaging(parsed, normalizeAssumedRf(cpt.assumedRf).toFixed(1)));
      if(!review) return false;
      return app.applyParsedCptTo(cpt, {...parsed, rows:review.rows});
    },

    /* Assign the parsed patch to the CPT and sync the Stage 1 DOM from it; the
       charts are (re)built on the next frame for the CPT active at that time. */
    applyParsedCptTo(cpt, parsed){
      const patch=applyParsedCptPatch(cpt, parsed);
      if(!patch){toast(NO_DATA_ROWS_MESSAGE,{tone:'warn'});return false;}
      Object.assign(cpt, patch);
      syncParsedCptDom(document, cpt);
      requestAnimationFrame(()=>app.initCharts());
      return true;
    },

    applyParsedCpt(parsed){
      return app.applyParsedCptTo(getActive(), parsed);
    },

    async parseGEF(txt,fname){
      return cptFileImporters.gef(txt,fname,getActive());
    },

    async parseCsvCpt(text,fname){
      return cptFileImporters.csv(text,fname,getActive());
    },

    async parseExcelCpt(buffer,fname){
      return cptFileImporters.excel(buffer,fname,getActive());
    },

    /* Reads files serially because parsing still drives shared DOM/chart state. */
    importCptFiles(files){
      importCptFilesSerially(files,{
        project:getProject(),
        newCptState,
        importers:cptFileImporters,
        onImported:(targetIdx,isFirst)=>{
          if(isFirst){
            // First file: stay on this CPT, update display
            ctx.selectCpt(targetIdx);
          } else {
            // Additional files: the active CPT is unchanged, refresh the banner
            ctx.renderBanner();
          }
        },
        renderBanner:ctx.renderBanner,
        // A file that could not be read is reported, not acknowledged: the loader is already
        // moving on to the next file, so a modal would stack in front of the queue (design §3.15).
        notify:(message)=>toast(message,{tone:'bad'})
      });
    },

    importGEFFiles(files){
      app.importCptFiles(files);
    },

    /* Multi-CPT file load — one picker action can create multiple CPT tabs. */
    loadGEF(evt){
      const files=Array.from(evt.target.files||[]);
      evt.target.value='';
      app.importCptFiles(files);
    },

    /* Superseded single-file loader — no caller since the multi-CPT loader landed
       (audit/16 CPT-PARSE-IMPORT-D-01); moved with its file set, deliberately unpublished. */
    loadSingleGEF(evt){
      const f=evt.target.files[0]; if(!f)return;
      const r=new FileReader();
      r.onload=e=>{app.parseGEF(e.target.result,f.name).catch(err=>toast(`Error importing ${f.name}: ${err?.message||err}`,{tone:'bad'}));};
      r.readAsText(f);
    },

    setCptCoord(axis, val){
      const v=parseFloat(val);
      getActive()[axis]=isNaN(v)?null:v;
      // No renderBanner needed — coordinates don't affect banner display
    },

    updateElevSrc(){
      renderElevationSource(document, getActive());
    },
    updateWTDisplay(){
      renderWaterTableDisplay(document, getActive());
    },
    renderMeta(){
      renderMetaCard(document, getActive());
    },

    // ── controls: elevation, water table, assumed Rf, min thickness, smart merge ──
    setElev(v){
      const S=getActive();
      S.elev=(isNaN(v)||v==='')?null:v;
      S.elevFromFile=false;
      S.elevSource=null;
      app.updateElevSrc(); app.updateWTDisplay();
      // Re-render layers if they exist (TAW column changes)
      if(S.layers.length&&document.getElementById('p2').classList.contains('active'))ctx.renderLayers();
    },

    setWT(v,fromInput){
      if(isNaN(v)||v<0)return;
      const S=getActive();
      S.wt=v;
      S.wtFromFile=false;
      S.wtSource=null;
      if(fromInput)document.getElementById('wtR').value=v;
      else document.getElementById('wtN').value=v.toFixed(2);
      app.updateWTDisplay();
      // Update only the WT annotation line on each chart — no rebuild
      if(S.chartsReady){
        const d=S.data;
        const maxZ=d[d.length-1].z+0.5;
        const maxQc=Math.max(1,arrMax(d.map(r=>r.qc)));
        // Same floor as initCharts — without it a qc-only file collapses the fs
        // chart's WT line to a zero-length segment (line disappears).
        const maxFs=Math.max(10,arrMax(d.map(r=>r.fs!=null?r.fs*1000:0)));
        updateWTLine(S.charts.qc, v, maxQc*1.15);
        updateWTLine(S.charts.fs, v, maxFs*1.15);
        updateWTLine(S.charts.rf, v, 12);
      }
    },

    updateWTLine,

    /* ── Assumed Rf (qc-only files) ──
       Shown only when the loaded CPT has readings without measured Rf. The value
       feeds every classification method through assumedRfValue(). */
    setAssumedRf(v){
      const n=Number(v);
      if(!Number.isFinite(n)||n<=0){
        // Rejected input: snap the field back to the value actually in use.
        app.updateAssumedRfControls();
        return;
      }
      getActive().assumedRf=normalizeAssumedRf(n);
      app.updateAssumedRfControls();
      app.updateRawChartEmptyStates();
      // Re-run the full classification chain so table, layers and previews stay
      // consistent with the new assumption.
      if(getActive().classified.length) ctx.runClass();
    },

    updateAssumedRfControls(){
      renderAssumedRfControls(document, getActive());
    },

    cancelClassificationRefresh(){
      if(classificationRefreshTimer!=null){
        clearTimeout(classificationRefreshTimer);
        classificationRefreshTimer=null;
      }
    },

    refreshClassificationDerivedViews(){
      app.cancelClassificationRefresh();
      const S=getActive();
      if(!S.classified.length) return;
      ctx.detectLayers();
      app.renderLayerPreviewSvg('layerPreviewSvg');
      const layerColSvg=document.getElementById('layerColSvg');
      if(layerColSvg) app.drawLayerColumnSvg('layerColSvg',S.layers,S.data[S.data.length-1]?.z+0.5||20);
      if(document.getElementById('p2').classList.contains('active')) ctx.renderLayers();
      const info=document.getElementById('minThkInfo');
      if(info) info.textContent=`→ ${S.layers.length} layers`;
    },

    scheduleClassificationDerivedViews(delay=90){
      app.cancelClassificationRefresh();
      const info=document.getElementById('minThkInfo');
      if(info) info.textContent='Updating...';
      classificationRefreshTimer=setTimeout(()=>{
        classificationRefreshTimer=null;
        app.refreshClassificationDerivedViews();
      }, delay);
    },

    setMinThk(v,fromInput){
      if(isNaN(v)||v<0.05)return;
      const S=getActive();
      S.minThk=v;
      if(fromInput)document.getElementById('minThkR').value=v;
      else document.getElementById('minThkN').value=v.toFixed(2);
      document.getElementById('minThkInfo').textContent='';
      // If already classified, re-run layer detection and update preview
      if(S.classified.length){
        app.refreshClassificationDerivedViews();
      }
    },

    setSmartMerge(v){
      const S=getActive();
      S.smartMerge=!!v;
      const smartMergeControls=document.getElementById('smartMergeControls');
      if(smartMergeControls) smartMergeControls.style.display=S.smartMerge?'':'none';
      if(S.classified.length){
        app.refreshClassificationDerivedViews();
      }
    },

    setSmartMergeSensitivity(v,fromInput){
      if(isNaN(v)) return;
      const val=Math.max(0,Math.min(6,+v));
      const S=getActive();
      S.smartMergeSensitivity=val;
      const range=document.getElementById('smartMergeSensR');
      const num=document.getElementById('smartMergeSensN');
      if(fromInput){
        if(range) range.value=val.toFixed(2);
      }else{
        if(num) num.value=val.toFixed(2);
      }
      if(S.classified.length && S.smartMerge){
        app.scheduleClassificationDerivedViews();
      }
    },

    // ── the three raw-profile charts ──
    arrMax,
    arrSafe,
    initCharts(){
      initRawCharts(document, getActive(), {
        drawLayerColumn:(svgId, layers, maxZ)=>app.drawLayerColumnSvg(svgId, layers, maxZ),
        again:()=>app.initCharts()
      });
    },
    refreshChartData(){
      refreshRawChartData(document, getActive());
    },
    updateRawChartEmptyStates(){
      updateRawChartEmptyStatesOf(document, getActive());
    },

    // ── the two layer SVGs ──
    drawLayerColumnSvg(svgId, layers, maxZ){
      drawLayerColumnSvgInto(document, svgId, layers, maxZ, getActive().wt);
    },
    renderLayerPreviewSvg(svgId){
      renderLayerPreviewSvgInto(document, svgId, getActive(), {bindTooltip:()=>app.bindLayerPreviewTooltip()});
    },
    bindLayerPreviewTooltip(){
      bindLayerPreviewTooltipTo(document);
    },

    loadDemo(){
      Object.assign(getActive(), demoPatch(Math.random));
      syncDemoDom(document, getActive());
      requestAnimationFrame(()=>app.initCharts());
    },

    bindDropzone(){
      bindDropzoneTo(document, (files)=>app.importGEFFiles(files));
    }
  };

  /** The Stage 1 names the inline `on*=` attributes and the Svelte bridge resolve on `window`. */
  app.handlers = {
    loadGEF: app.loadGEF,
    loadDemo: app.loadDemo,
    setCptCoord: app.setCptCoord,
    parseGEF: app.parseGEF,
    updateElevSrc: app.updateElevSrc,
    updateWTDisplay: app.updateWTDisplay,
    renderMeta: app.renderMeta,
    setElev: app.setElev,
    setWT: app.setWT,
    updateWTLine: app.updateWTLine,
    setMinThk: app.setMinThk,
    setSmartMerge: app.setSmartMerge,
    setSmartMergeSensitivity: app.setSmartMergeSensitivity,
    setAssumedRf: app.setAssumedRf,
    arrMax: app.arrMax,
    arrSafe: app.arrSafe,
    initCharts: app.initCharts,
    refreshChartData: app.refreshChartData,
    drawLayerColumnSvg: app.drawLayerColumnSvg,
    renderLayerPreviewSvg: app.renderLayerPreviewSvg,
    bindLayerPreviewTooltip: app.bindLayerPreviewTooltip
  };
  return app;
}
