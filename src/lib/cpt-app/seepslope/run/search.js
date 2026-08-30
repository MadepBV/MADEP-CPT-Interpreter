// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/run/search.js — the Bishop / Spencer slip-circle search as a request builder and a
// result reducer. Refactor step 9c (01-monolith-map.md §2.11 group "Workers & runs", §5 engine
// row 1, §6.2 step 9c "runs/workers return patches, host re-renders"; PLAN §2 row 18c). Moved
// from legacy-controller.js (integration-r f5b4a9b): stage6BishopRunSearch 4118-4176, the
// `onmessage` / `onerror` bodies of stage6BishopEnsureWorker 3875-3916, and the state half of
// stage6BishopStopSearch 3846-3856.
//
// Contract (the pattern of seepslope/model/invalidate.js, but the writes are returned rather than
// performed — the host applies them with applyRunPatch and then re-renders):
//
//   prepareSearch(bishop, model)              → { ok, reject:{reason,message}|null, patch }
//   startSearch(bishop, model, runId)         → { patch, message }   message = the worker message
//   reduceSearchMessage(bishop, payload)      → { handled, kind, patch, effects }
//   searchWorkerErrorPatch()                  → the onerror writes
//   stopSearchPatch(bishop, silent)           → the state half of stage6BishopStopSearch
//
// A patch is `{ key | dotted.path: value }` in the monolith's write order, applied in place by
// seepslope/model applySoilModelPatch (re-exported as applyRunPatch): every key it names already
// exists after ensure(), so the block's JSON text and key order are the monolith's, and the
// nested objects keep their identity — except `progress`, which stage6BishopRunSearch replaced
// wholesale (it adds `runId`, absent from progressDefaults(), and in its own key order), so the
// start patch replaces it wholesale too.
//
// Nothing here reads `S`, touches the DOM, or knows about the Worker: `startSearch` returns the
// message, the host's worker adapter posts it.

import { sortZone } from '../state/index.js';
import { runningMessage, completeMessage } from './progress.js';

/** Every string the search run can put on `bishop.progress.message`, as data. */
export const SEARCH_MESSAGES = Object.freeze({
  noModel: 'Draw terrain and place the active CPT marker first.',
  noZones: 'Define entry and exit zones on the terrain before running the search.',
  noWorker: 'Web Worker is not available in this browser context.',
  failed: 'Bishop search failed.',
  workerError: 'Bishop worker error.',
  stopped: 'Bishop search stopped.'
});

const NO_EFFECTS = Object.freeze({ render: false, drawCanvas: false, updateProgressDom: false });
const PROGRESS_EFFECTS = Object.freeze({ render: false, drawCanvas: true, updateProgressDom: true });
const RENDER_EFFECTS = Object.freeze({ render: true, drawCanvas: false, updateProgressDom: false });

/** The two pre-flight checks of stage6BishopRunSearch, in the monolith's order. */
export function searchRejection(bishop, model){
  if(!model) return { reason:'no-model', message:SEARCH_MESSAGES.noModel };
  if(!bishop.entryZone || !bishop.exitZone) return { reason:'no-zones', message:SEARCH_MESSAGES.noZones };
  return null;
}

/**
 * The state a rejected attempt writes: the reason on the progress line, and the run flag cleared.
 *
 * `progress.running = false` is a **behaviour fix** (PR 18c commit 2). The monolith's two
 * pre-flight rejections returned before stage6BishopStopSearch(true), so pressing Run on a state
 * that had become un-runnable while a search was in flight left `progress.running = true` with
 * the reason on the line: the progress bar kept animating and the canvas kept drawing the preview
 * circle of a run whose result would be dropped. A run that refuses to start clears its own flag.
 */
export function searchRejectionPatch(rejection){
  return { 'progress.message': rejection.message, 'progress.running': false };
}

/** Pre-flight: may this attempt post, and what does it write either way. */
export function prepareSearch(bishop, model){
  const rejection = searchRejection(bishop, model);
  return { ok: !rejection, reject: rejection, patch: rejection ? searchRejectionPatch(rejection) : {} };
}

/** The host has no Worker constructor (SSR / Node): the same rejection shape. */
export function searchNoWorkerPatch(){
  return searchRejectionPatch({ reason:'no-worker', message:SEARCH_MESSAGES.noWorker });
}

/** `input` of the `analyze` message: the model, the sorted zones and the three config blocks. */
export function buildSearchInput(bishop, model){
  const entryZone = sortZone(bishop.entryZone);
  const exitZone = sortZone(bishop.exitZone);
  const span = Math.abs((exitZone?.xEnd || 0) - (entryZone?.xStart || 0));
  return {
    model,
    entryZone,
    exitZone,
    methodMode:bishop.methodMode,
    searchConfig:{
      ...bishop.search,
      minSliceWidth:Math.max(+bishop.search.minSliceWidth || 0.05, span/300 || 0.05, 0.05)
    },
    solverConfig:{...bishop.solver},
    spencerConfig:{...bishop.spencer}
  };
}

/** The `analyze` message around an already-built input. */
export function searchRequest(runId, input){
  return {
    type:'analyze',
    runId,
    input
  };
}

/**
 * State → worker message in one call. The host builds the input *before* the silent stops (where
 * the monolith built it) and assembles the message after the pre-post render, so it keeps the two
 * halves apart; this composition is the contract a verifier and a future host read.
 */
export function buildSearchRequest(bishop, model, runId){
  return searchRequest(runId, buildSearchInput(bishop, model));
}

/**
 * The launch patch: progress replaced wholesale (it gains `runId`, absent from progressDefaults(),
 * in the monolith's key order), the previous results discarded and the block flagged stale.
 */
export function startSearchPatch(bishop, runId){
  return {
    progress:{
      running:true,
      percent:0,
      trial:0,
      total:0,
      runId,
      message:runningMessage(bishop),
      previewCircle:null
    },
    results:null,
    selectedResult:0,
    stale:true
  };
}

/**
 * One message from the search worker. The run-id guard (map §3.4 #8) is the `handled:false`
 * branch: a reply for a run that is no longer the block's current one — a CPT switch, a rerun,
 * a state with no search yet — is dropped without a write.
 */
export function reduceSearchMessage(bishop, payload = {}){
  if(!bishop || payload.runId !== bishop.progress.runId){
    return { handled:false, kind:'stale', patch:null, effects:NO_EFFECTS };
  }
  if(payload.type === 'progress'){
    return {
      handled:true,
      kind:'progress',
      patch:{
        'progress.running':true,
        'progress.trial':payload.progress?.trial || 0,
        'progress.total':payload.progress?.total || 0,
        'progress.percent':payload.progress?.percent || 0,
        'progress.previewCircle':payload.progress?.previewCircle || null,
        'progress.message':runningMessage(bishop)
      },
      effects:PROGRESS_EFFECTS
    };
  }
  if(payload.type === 'result'){
    return {
      handled:true,
      kind:'result',
      patch:{
        'progress.running':false,
        'progress.previewCircle':null,
        results:payload.result || null,
        selectedResult:0,
        stale:false,
        'progress.message':completeMessage(payload.result, payload.result?.timing)
      },
      effects:RENDER_EFFECTS
    };
  }
  return {
    handled:true,
    kind:'error',
    patch:{
      'progress.running':false,
      'progress.previewCircle':null,
      'progress.message':payload.error || SEARCH_MESSAGES.failed
    },
    effects:RENDER_EFFECTS
  };
}

/** The worker's `onerror`: the run is over and the progress line says so. */
export function searchWorkerErrorPatch(){
  return {
    'progress.running':false,
    'progress.previewCircle':null,
    'progress.message':SEARCH_MESSAGES.workerError
  };
}

/**
 * The state half of stage6BishopStopSearch. Silent (an invalidation, a CPT switch, the start of
 * another run) leaves the message alone; the Stop button writes it. The worker half is always a
 * terminate() — the search worker has no stop protocol.
 */
export function stopSearchPatch(bishop, silent){
  if(!bishop) return {};
  const patch = {
    'progress.running':false,
    'progress.previewCircle':null
  };
  if(!silent) patch['progress.message'] = SEARCH_MESSAGES.stopped;
  return patch;
}
