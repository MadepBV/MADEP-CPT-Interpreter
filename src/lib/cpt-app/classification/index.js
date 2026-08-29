// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// classification/index.js — public surface of the Stage 2 classification package
// (01-monolith-map.md §6.1 row `classification/`, extracted in PR 6 / refactor step 3).
//
//   labels.js    classificationMethodLabel / MetricLabel / MetricValue      (pure strings)
//   classify.js  assumedRfValue(cpt), cptHasFs/cptHasRf(cpt), classRob…classSB260(cpt, r),
//                classifyRow(cpt, row, method)                              (dispatch)
//   run.js       classifyCpt(cpt, ctx) → {classified, rfAssumedCount, useSB260params, …}
//   panel.js     classificationMetricsHtml / AssumedRfNoteHtml / TableRowsHtml (pure strings)
//
// stressAt stays in model-params/stress.js (classify.js imports it from there).
// legacy-controller.js keeps the old names as thin wrappers over the active CPT; the
// DOM side of runClass / selM / syncClassificationMethodCards stays there until the
// handlers split of a later step.

export { classificationMethodLabel, classificationMetricLabel, classificationMetricValue } from './labels.js';
export {
  assumedRfValue, cptHasFs, cptHasRf,
  classRob, classRob2016, classCUR3, classCUR, classNEN6740, classSB260,
  classifyRow
} from './classify.js';
export { classifyCpt } from './run.js';
export { classificationMetricsHtml, classificationAssumedRfNoteHtml, classificationTableRowsHtml } from './panel.js';
