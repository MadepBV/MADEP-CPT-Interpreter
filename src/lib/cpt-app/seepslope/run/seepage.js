// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/run/seepage.js — the seepage FEM run as a request builder and a result reducer.
// Refactor step 9c (01-monolith-map.md §2.11 group "Workers & runs", §5 engine row 2, §6.2 step
// 9c; PLAN §2 row 18c). Moved from legacy-controller.js (integration-r f5b4a9b):
// stage6BishopRunSeepage 4178-4245, the `onmessage` / `onerror` bodies of
// stage6BishopEnsureSeepageWorker 3923-3992, and the state half of stage6BishopStopSeepage
// 3790-3816.
//
//   prepareSeepage(bishop, model)          → { ok, reject:{reason,message}|null, patch, drainValidation }
//   startSeepage(bishop, model, runId)     → { patch, message }   message = the worker message
//   reduceSeepageMessage(bishop, payload)  → { handled, kind, patch, effects }
//   seepageWorkerErrorPatch()              → the onerror writes
//   stopSeepagePatch(bishop, silent)       → the state half of stage6BishopStopSeepage
//   seepageStopMessage(runId)              → the `stop-seepage` message the Stop button posts
//
// The worker protocol (map §5 row 2) is `{type:'run-seepage', runId, input:{model}}` out,
// `{type:'progress'|'result'|'error', runId, …}` back, and `{type:'stop-seepage', runId}` to ask
// a running solve to finish early — the seepage worker keeps the latest solved state, so the stop
// is a request, not a terminate. See seepage/seepage-worker.js.
//
// Patch semantics as in search.js: dotted paths applied in the monolith's write order, in place,
// with `seepage.progress` replaced wholesale by the launch exactly as the monolith replaced it.

import { validateDrains } from '../../seepage/drains.js';
import { seepageCompleteMessage } from './progress.js';

/** Every string the seepage run can put on `seepage.rejectReason` / `seepage.progress.message`. */
export const SEEPAGE_MESSAGES = Object.freeze({
  noModel: 'Draw terrain and place the active CPT marker first.',
  noHeadBc: 'Assign at least one prescribed-head boundary edge before running seepage.',
  noPhreatic: 'Draw a phreatic line or switch seepage to iterative free-surface mode.',
  noWorker: 'Web Worker is not available in this browser context.',
  meshing: 'Building triangulated seepage mesh...',
  running: 'Running seepage...',
  noResult: 'The seepage solver returned no result.',
  failed: 'Seepage solve failed.',
  workerError: 'Seepage worker error.',
  stopping: 'Stopping seepage and keeping the latest solved state...',
  notRunning: 'No seepage run is active.'
});

/** The worker's interrupt error and the message the app shows for it. */
export const SEEPAGE_INTERRUPT_ERROR = 'Seepage run was interrupted before a solution became available.';
export const SEEPAGE_INTERRUPT_MESSAGE = 'Seepage interrupted before the first solution became available.';

const NO_EFFECTS = Object.freeze({ render: false, drawCanvas: false, updateProgressDom: false });
const RENDER_EFFECTS = Object.freeze({ render: true, drawCanvas: false, updateProgressDom: false });

/** The state a rejected attempt writes: the reason and a failed status. */
export function seepageRejectionPatch(rejection){
  return {
    'seepage.rejectReason': rejection.message,
    'seepage.status': 'failed'
  };
}

/**
 * Pre-flight, in the monolith's order: a model, at least one non-orphaned prescribed-head edge,
 * a phreatic line when the free surface is fixed, and finally the drain validation — which is
 * *stored* on the block whether or not it rejects (the drains panel renders it).
 */
export function prepareSeepage(bishop, model){
  const reject = (reason, message) => ({ ok:false, reject:{reason, message}, patch:seepageRejectionPatch({reason, message}), drainValidation:null });
  if(!model) return reject('no-model', SEEPAGE_MESSAGES.noModel);
  const activeBcs = (bishop.seepage.bcs || []).filter((bc)=>bc.status !== 'orphaned');
  const headCount = activeBcs.filter((bc)=>bc.type === 'head').length;
  if(!headCount) return reject('no-head-bc', SEEPAGE_MESSAGES.noHeadBc);
  if(bishop.seepage.options?.freeSurface === 'fixed' && (!bishop.phreatic || bishop.phreatic.length < 2)){
    return reject('no-phreatic', SEEPAGE_MESSAGES.noPhreatic);
  }
  const drainValidation = validateDrains(model);
  const patch = { 'seepage.drainValidation': drainValidation };
  if(drainValidation.errors.length){
    const message = drainValidation.errors[0].message;
    return { ok:false, reject:{reason:'drain-errors', message}, patch:{...patch, ...seepageRejectionPatch({message})}, drainValidation };
  }
  return { ok:true, reject:null, patch, drainValidation };
}

/** The host has no Worker constructor (SSR / Node). */
export function seepageNoWorkerPatch(){
  return seepageRejectionPatch({ reason:'no-worker', message:SEEPAGE_MESSAGES.noWorker });
}

/** The model the worker solves: the app model with any previous mesh / result stripped. */
export function buildSeepageInputModel(model){
  return {
    ...model,
    seepage:{
      ...(model.seepage || {}),
      mesh:null,
      result:null
    }
  };
}

/** The `run-seepage` message around an already-stripped model. */
export function seepageRequest(runId, inputModel){
  return {
    type:'run-seepage',
    runId,
    input:{model:inputModel}
  };
}

/** State → worker message in one call (the host keeps the monolith's two-step timing). */
export function buildSeepageRequest(model, runId){
  return seepageRequest(runId, buildSeepageInputModel(model));
}

/** The launch patch: status, reason cleared, progress replaced wholesale. */
export function startSeepagePatch(runId){
  return {
    'seepage.status':'meshing',
    'seepage.rejectReason':'',
    'seepage.progress':{
      running:true,
      percent:0,
      message:SEEPAGE_MESSAGES.meshing,
      runId
    }
  };
}

/** The cooperative stop the Stop button posts while a solve is running. */
export function seepageStopMessage(runId){
  return { type:'stop-seepage', runId };
}

/**
 * One message from the seepage worker; the run-id guard is the `handled:false` branch. A
 * successful solve that finds every contour overlay switched off turns the head contours back on
 * (the monolith's "you just solved, so show something" rule).
 */
export function reduceSeepageMessage(bishop, payload = {}){
  const seepage = bishop?.seepage;
  if(!seepage || payload.runId !== seepage.progress?.runId){
    return { handled:false, kind:'stale', patch:null, effects:NO_EFFECTS };
  }
  if(payload.type === 'progress'){
    const patch = {
      'seepage.progress.running':true,
      'seepage.progress.percent':payload.progress?.percent || 0,
      'seepage.progress.message':payload.progress?.message || SEEPAGE_MESSAGES.running
    };
    if(payload.progress?.stage === 'meshing') patch['seepage.status'] = 'meshing';
    else if(payload.progress?.stage === 'solving' || payload.progress?.stage === 'post') patch['seepage.status'] = 'solving';
    return { handled:true, kind:'progress', patch, effects:RENDER_EFFECTS };
  }
  const patch = {
    'seepage.progress.running':false,
    'seepage.progress.percent':100
  };
  if(payload.type === 'result'){
    const mesh = payload.output?.mesh || null;
    const result = payload.output?.result || null;
    const status = mesh && result ? 'success' : 'failed';
    patch['seepage.mesh'] = mesh;
    patch['seepage.result'] = result;
    patch['seepage.stale'] = false;
    patch['seepage.status'] = status;
    patch['seepage.rejectReason'] = status === 'success' ? '' : SEEPAGE_MESSAGES.noResult;
    if(
      status === 'success' &&
      !seepage.display?.showContours &&
      !seepage.display?.showContourLines &&
      !seepage.display?.showFlowVectors &&
      !seepage.display?.showExitGradient
    ){
      patch['seepage.display.showContours'] = true;
      patch['seepage.display.showContourLines'] = true;
      patch['seepage.display.showContourLegend'] = true;
      patch['seepage.display.contourMode'] = 'head';
    }
    patch['seepage.progress.message'] = status === 'success'
      ? seepageCompleteMessage(result)
      : SEEPAGE_MESSAGES.failed;
    return { handled:true, kind:'result', patch, effects:RENDER_EFFECTS };
  }
  if(payload.error === SEEPAGE_INTERRUPT_ERROR){
    patch['seepage.status'] = 'idle';
    patch['seepage.rejectReason'] = '';
    patch['seepage.progress.message'] = SEEPAGE_INTERRUPT_MESSAGE;
    patch['seepage.progress.percent'] = 0;
    return { handled:true, kind:'interrupted', patch, effects:RENDER_EFFECTS };
  }
  const rejectReason = payload.error || SEEPAGE_MESSAGES.failed;
  patch['seepage.status'] = 'failed';
  patch['seepage.rejectReason'] = rejectReason;
  patch['seepage.progress.message'] = rejectReason;
  patch['seepage.progress.percent'] = 0;
  return { handled:true, kind:'error', patch, effects:RENDER_EFFECTS };
}

/** The worker's `onerror`. */
export function seepageWorkerErrorPatch(){
  return {
    'seepage.progress.running':false,
    'seepage.progress.percent':0,
    'seepage.status':'failed',
    'seepage.rejectReason':SEEPAGE_MESSAGES.workerError,
    'seepage.progress.message':SEEPAGE_MESSAGES.workerError
  };
}

/**
 * The state half of stage6BishopStopSeepage. Silent (an invalidation, a CPT switch, the start of
 * another run — the worker is terminated) resets the progress and takes a running status back to
 * idle; identical to seepslope/model/invalidate.js stopSeepageState, which the invalidation
 * transitions call. The Stop button (silent = false) only writes the message: the worker is asked
 * to stop and keeps its latest solved state, so `running` is cleared by its reply, not here.
 */
export function stopSeepagePatch(bishop, silent){
  const seepage = bishop?.seepage;
  if(!seepage) return {};
  if(silent){
    const patch = {
      'seepage.progress.running':false,
      'seepage.progress.percent':0
    };
    if(seepage.status === 'meshing' || seepage.status === 'solving') patch['seepage.status'] = 'idle';
    return patch;
  }
  return {
    'seepage.progress.message':seepage.progress?.running ? SEEPAGE_MESSAGES.stopping : SEEPAGE_MESSAGES.notRunning,
    'seepage.rejectReason':''
  };
}
