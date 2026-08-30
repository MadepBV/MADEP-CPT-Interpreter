// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// classification/index.js — public surface of the Stage 2 classification package
// (01-monolith-map.md §6.1 row `classification/`, extracted in PR 6 / refactor step 3).
//
//   labels.js        classificationMethodLabel / MetricLabel / MetricValue      (pure strings)
//   classify.js      assumedRfValue(cpt), cptHasFs/cptHasRf(cpt), classRob…classSB260(cpt, r),
//                    classifyRow(cpt, row, method)                              (dispatch)
//   run.js           classifyCpt(cpt, ctx) → {classified, rfAssumedCount, useSB260params, …}
//   panel.js         classificationMetricsHtml / AssumedRfNoteHtml / TableRowsHtml (pure strings)
//   method-cards.js  the five Stage 2 method cards and their `.sel` state        (DOM, PR 20)
//
// stressAt stays in model-params/stress.js (classify.js imports it from there).
// PR 20 (refactor step 10) added `installClassificationApp(ctx)` at the bottom: the DOM half the
// controller kept (selM, runClass, the method-card sync) plus the per-CPT wrappers of the pure
// classifiers, so nothing of Stage 2 is left in the composition root.

export { classificationMethodLabel, classificationMetricLabel, classificationMetricValue } from './labels.js';
export {
  assumedRfValue, cptHasFs, cptHasRf,
  classRob, classRob2016, classCUR3, classCUR, classNEN6740, classSB260,
  classifyRow
} from './classify.js';
export { classifyCpt } from './run.js';
export { classificationMetricsHtml, classificationAssumedRfNoteHtml, classificationTableRowsHtml } from './panel.js';
export { CLASSIFICATION_METHOD_CARDS, syncClassificationMethodCards } from './method-cards.js';

import {
  assumedRfValue as assumedRfValueOf,
  cptHasFs as cptHasFsOf,
  cptHasRf as cptHasRfOf,
  classRob as classRobOf,
  classRob2016 as classRob2016Of,
  classCUR3 as classCUR3Of,
  classNEN6740 as classNEN6740Of,
  classSB260 as classSB260Of
} from './classify.js';
import { classifyCpt as classifyCptOf } from './run.js';
import {
  classificationMetricsHtml as metricsHtml,
  classificationAssumedRfNoteHtml as assumedRfNoteHtml,
  classificationTableRowsHtml as tableRowsHtml
} from './panel.js';
import { syncClassificationMethodCards as syncMethodCards } from './method-cards.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// installClassificationApp(ctx) — Stage 2 bound to a host (PR 20 / refactor step 10).
//
// The DOM half the controller kept — the method-card selector, `selM` and `runClass` (compute →
// assign to the active CPT → write the four Stage 2 regions → hand over to Stage 3) — plus the
// per-CPT wrappers of the pure classifiers. Bodies verbatim; `S` is `ctx.getActive()`.
//
//   ctx.document, ctx.getActive(), ctx.toast(message, opts),
//   ctx.detectLayers(), ctx.renderLayerPreviewSvg(id), ctx.drawLayerColumnSvg(id, layers, maxZ)
export function installClassificationApp(ctx){
  const { document, getActive, toast } = ctx;
  const app = {
    syncMethodCards: (method) => syncMethodCards(document, method),

    selM(m){
      getActive().method=m;
      app.syncMethodCards(m);
    },

    assumedRfValue: () => assumedRfValueOf(getActive()),
    cptHasFs: () => cptHasFsOf(getActive()),
    cptHasRf: () => cptHasRfOf(getActive()),
    classRob: (r) => classRobOf(getActive(), r),
    classRob2016: (r) => classRob2016Of(getActive(), r),
    classCUR3: (r) => classCUR3Of(getActive(), r),
    classNEN6740: (r) => classNEN6740Of(getActive(), r),
    classSB260: (r) => classSB260Of(getActive(), r),

    runClass(){
      const S=getActive();
      if(!S.data.length){toast('Laad eerst een GEF bestand.',{tone:'warn'});return;}

      /* Compute (classification/run.js, pure) → assign to the active CPT → render
         the four Stage 2 regions (classification/panel.js builds the markup). */
      const result=classifyCptOf(S);
      S.useSB260params=result.useSB260params;
      S.classified=result.classified;
      S.rfAssumedCount=result.rfAssumedCount;

      document.getElementById('cmet').innerHTML=metricsHtml(result.metrics);

      const assumedNote=document.getElementById('classAssumedRfNote');
      if(assumedNote) assumedNote.innerHTML=assumedRfNoteHtml(result.assumedRfNote);

      const metricHead=document.getElementById('cmetricHead');
      if(metricHead) metricHead.innerHTML=result.metricLabel;
      document.getElementById('cbody').innerHTML=tableRowsHtml(result.classified,{method:S.method,elev:S.elev});

      document.getElementById('classLayout').style.display='';
      ctx.detectLayers();
      ctx.renderLayerPreviewSvg('layerPreviewSvg');
      ctx.drawLayerColumnSvg('layerColSvg',S.layers,S.data[S.data.length-1].z+0.5);
      document.getElementById('minThkInfo').textContent='-> '+S.layers.length+' layers';
      document.getElementById('btnToLayers').style.display='';
    }
  };
  // `classCUR` is the monolith's alias of classCUR3 (published under both names).
  app.classCUR = app.classCUR3;
  app.handlers = {
    selM: app.selM,
    runClass: app.runClass,
    classRob: app.classRob,
    classCUR: app.classCUR,
    classSB260: app.classSB260
  };
  return app;
}
