// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/run/index.js — the three runs of the Seep / Slope ("bishop") app: how a state becomes
// a worker message, what a worker reply does to the state, and who owns the workers. Refactor
// step 9c (01-monolith-map.md §2.11 group "Workers & runs" 7582-8178 at 462fc50, §5 engine rows
// 1-3, §3.4 #8, §6.2 step 9c "runs/workers return patches, host re-renders"; PLAN §2 row 18c;
// worklog/refactor/24-pr18c-seepslope-run.md).
//
//   search.js       Bishop / Spencer slip-circle search  — `analyze`
//   seepage.js      seepage FEM                          — `run-seepage` / `stop-seepage`
//   deformation.js  deformation FEM                      — `run-deformation` / `stop-deformation`
//   workers.js      createWorkerAdapter — create / terminate / post / stop, one run id per kind
//   progress.js     every string the runs put on screen, as pure functions
//
// Every run is the same three pure pieces, so the host reads the same for all three:
//
//   const prep = prepareX(bishop, model);          // pre-flight → { ok, reject, patch }
//   applyRunPatch(bishop, prep.patch);
//   if(!prep.ok){ render(); return; }
//   … silent stops …
//   const worker = workers.ensure('x', handlers);
//   if(!worker){ applyRunPatch(bishop, xNoWorkerPatch()); render(); return; }
//   applyRunPatch(bishop, startXPatch(…, workers.nextRunId('x')));
//   render();
//   workers.post('x', buildXRequest(…));           // state → message, no DOM, no `S`
//
// and, on a reply,
//
//   const r = reduceXMessage(bishop, payload);     // message → { handled, kind, patch, effects }
//   if(!r.handled) return;                          //   ← the run-id guard, map §3.4 #8
//   applyRunPatch(bishop, r.patch);
//   … r.effects.updateProgressDom / drawCanvas / render …
//
// `applyRunPatch` is seepslope/model's `applySoilModelPatch` under the name this package uses: a
// patch is `{ key | dotted.path: value }` applied in place, in insertion order, so the block and
// its nested objects keep their identity and the JSON text keeps the monolith's key order.

export { applySoilModelPatch as applyRunPatch } from '../model/sync-soil-model.js';
export {
  SEARCH_MESSAGES,
  searchRejection,
  searchRejectionPatch,
  prepareSearch,
  searchNoWorkerPatch,
  buildSearchInput,
  searchRequest,
  buildSearchRequest,
  startSearchPatch,
  reduceSearchMessage,
  searchWorkerErrorPatch,
  stopSearchPatch
} from './search.js';
export {
  SEEPAGE_MESSAGES,
  SEEPAGE_INTERRUPT_ERROR,
  SEEPAGE_INTERRUPT_MESSAGE,
  seepageRejectionPatch,
  prepareSeepage,
  seepageNoWorkerPatch,
  buildSeepageInputModel,
  seepageRequest,
  buildSeepageRequest,
  startSeepagePatch,
  seepageStopMessage,
  reduceSeepageMessage,
  seepageWorkerErrorPatch,
  stopSeepagePatch
} from './seepage.js';
export {
  DEFORMATION_MESSAGES,
  DEFORMATION_INTERRUPT,
  deformationAnalysisType,
  deformationRejectionPatch,
  prepareDeformation,
  deformationNoWorkerPatch,
  buildLastWallInputs,
  buildDeformationOptions,
  deformationRequest,
  buildDeformationRequest,
  startDeformationPatch,
  deformationStopMessage,
  reduceDeformationMessage,
  deformationWorkerErrorPatch,
  stopDeformationPatch
} from './deformation.js';
export {
  WORKER_KINDS,
  WORKER_STOP_TYPES,
  DEFAULT_WORKER_FACTORIES,
  createWorkerAdapter
} from './workers.js';
export {
  methodModeLabel,
  secondsLabelFromMs,
  seepageFlowErrorLabel,
  safetyFinalizationStatusFromSolver,
  runningMessage,
  readyMessage,
  completeMessage,
  seepageCompleteMessage,
  deformationCompleteMessage,
  searchProgressDom
} from './progress.js';
export * as search from './search.js';
export * as seepage from './seepage.js';
export * as deformation from './deformation.js';
export * as workers from './workers.js';
export * as progress from './progress.js';
