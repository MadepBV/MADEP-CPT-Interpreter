// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/model/invalidate.js — the result invalidation of the Seep / Slope app as pure state
// transitions, refactor step 9b (01-monolith-map.md §2.11 "Seepage state" 5453-5472 and "Seepage
// BC handlers + invalidation" 6320-6374 at 462fc50). Moved from legacy-controller.js
// stage6BishopInvalidateSeepage (integration-r 09b9c9b lines 1954-1972), InvalidateDeformation
// (2821-2845), Invalidate (2847-2869), InvalidateWallGeometry (2871-2874), together with the
// state half of the silent worker stops they called first (stage6BishopStopSearch 3986-3996,
// StopSeepage 3930-3956, StopDeformation 3958-3984 with `silent = true`; the worker
// `terminate()` half stays in the host until step 9c).
//
// Contract (the pattern of seepslope/state): each transition takes the `bishop` block, mutates it
// exactly as the monolith did (statement order kept; every key it writes exists after ensure(),
// so the JSON text and key order are those of the monolith) and returns what the host must do:
//
//   { stop:   ['search' | 'seepage' | 'deformation', …]   the workers to terminate
//     rerun:  ['bishop' | 'seepage' | 'deformation', …]   the analyses whose results were discarded
//                                                          (or flagged stale) and must be re-run
//     keptSolvedState: boolean                             seepage / deformation only: the previous
//                                                          mesh + result were kept and flagged stale
//     render: true }                                       the panel must re-render
//
//   invalidateSeepage(bishop, { message, keepMesh, preserveSolvedState })
//   invalidateDeformation(bishop, { message, keepMesh, preserveSolvedState })
//   invalidateBishop(bishop, message)          Bishop results + the deformation result (which
//                                              depends on the same soil model); 22 callers
//   invalidateWallGeometry(bishop, message)    everything: Bishop + deformation + seepage
//   stopSearchState / stopSeepageState / stopDeformationState   the silent-stop state writes
//
// The host façades keep the monolith names and call, in the monolith's order, ensureStage6State,
// the worker stop (terminate + the same state writes) and then the transition here.

const INVALIDATE_SEEPAGE = Object.freeze(['seepage']);
const INVALIDATE_DEFORMATION = Object.freeze(['deformation']);
const INVALIDATE_BISHOP_STOP = Object.freeze(['search', 'deformation']);
const INVALIDATE_BISHOP_RERUN = Object.freeze(['bishop', 'deformation']);
const INVALIDATE_ALL_STOP = Object.freeze(['search', 'deformation', 'seepage']);
const INVALIDATE_ALL_RERUN = Object.freeze(['bishop', 'deformation', 'seepage']);

/** stage6BishopStopSearch(true) minus the worker: the search progress is reset. */
export function stopSearchState(bishop){
  if(!bishop) return;
  bishop.progress.running = false;
  bishop.progress.previewCircle = null;
}

/** stage6BishopStopSeepage(true) minus the worker: progress reset, a running status back to idle. */
export function stopSeepageState(bishop){
  const seepage = bishop?.seepage;
  if(!seepage) return;
  seepage.progress.running = false;
  seepage.progress.percent = 0;
  if(seepage.status === 'meshing' || seepage.status === 'solving') seepage.status = 'idle';
}

/** stage6BishopStopDeformation(true) minus the worker: progress reset, a running status back to idle. */
export function stopDeformationState(bishop){
  const deformation = bishop?.deformation;
  if(!deformation) return;
  deformation.progress.running = false;
  deformation.progress.percent = 0;
  if(['meshing','solving','post'].includes(deformation.status)) deformation.status = 'idle';
}

/**
 * Seepage inputs changed. With `preserveSolvedState` and a solved mesh + result, the result is
 * kept and flagged stale (the panel keeps showing it until the rerun); otherwise the result is
 * discarded, the mesh too unless `keepMesh`, a finished / running status goes back to idle.
 * `message` lands in seepage.rejectReason (the status line).
 */
export function invalidateSeepage(bishop, {message, keepMesh, preserveSolvedState} = {}){
  stopSeepageState(bishop);
  const seepage = bishop.seepage;
  const keepSolvedState = !!preserveSolvedState && !!seepage.mesh && !!seepage.result;
  seepage.progress.running = false;
  seepage.progress.percent = 0;
  if(keepSolvedState){
    seepage.stale = true;
    seepage.status = 'success';
    if(message) seepage.rejectReason = message;
    return {stop:INVALIDATE_SEEPAGE, rerun:INVALIDATE_SEEPAGE, keptSolvedState:true, render:true};
  }
  if(!keepMesh) seepage.mesh = null;
  seepage.result = null;
  seepage.stale = false;
  if(seepage.status === 'success' || seepage.status === 'meshing' || seepage.status === 'solving') seepage.status = 'idle';
  if(message) seepage.rejectReason = message;
  return {stop:INVALIDATE_SEEPAGE, rerun:INVALIDATE_SEEPAGE, keptSolvedState:false, render:true};
}

/**
 * Deformation inputs changed — the seepage counterpart, plus the warnings cleared and the
 * status-bar message overwritten with the reason (status honesty: the bar renders
 * deformation.progress.message and must not keep advertising a discarded screen).
 */
export function invalidateDeformation(bishop, {message, keepMesh, preserveSolvedState} = {}){
  stopDeformationState(bishop);
  const deformation = bishop.deformation;
  const keepSolvedState = !!preserveSolvedState && !!deformation.mesh && !!deformation.result;
  deformation.progress.running = false;
  deformation.progress.percent = 0;
  if(keepSolvedState){
    deformation.stale = true;
    deformation.status = 'success';
    if(message) deformation.rejectReason = message;
    return {stop:INVALIDATE_DEFORMATION, rerun:INVALIDATE_DEFORMATION, keptSolvedState:true, render:true};
  }
  if(!keepMesh) deformation.mesh = null;
  deformation.result = null;
  deformation.stale = false;
  deformation.warnings = [];
  if(['success','meshing','solving','post'].includes(deformation.status)) deformation.status = 'idle';
  deformation.rejectReason = message || '';
  // Status honesty: the deformation status bar renders `deformation.progress.message`
  // (e.g. "Deformation screen ready…"). Clearing `result` without updating that string
  // leaves the bar advertising a screen that no longer exists. Overwrite it with the
  // invalidation reason so the bar truthfully reflects that the run was discarded.
  deformation.progress.message = message || 'Deformation result cleared; rerun deformation analysis.';
  return {stop:INVALIDATE_DEFORMATION, rerun:INVALIDATE_DEFORMATION, keptSolvedState:false, render:true};
}

/**
 * The soil model / geometry / search inputs changed: the Bishop results are discarded (stale =
 * true keeps the "rerun" hint), the deformation result with them (it depends on the same model —
 * mesh, result, warnings, progress reset, status idle, the reason in its status bar), and
 * `message` becomes the Bishop progress message.
 */
export function invalidateBishop(bishop, message){
  stopSearchState(bishop);
  stopDeformationState(bishop);
  bishop.results = null;
  bishop.selectedResult = 0;
  bishop.stale = true;
  if(bishop.deformation){
    bishop.deformation.mesh = null;
    bishop.deformation.result = null;
    bishop.deformation.stale = false;
    bishop.deformation.warnings = [];
    bishop.deformation.progress.running = false;
    bishop.deformation.progress.percent = 0;
    if(['success','meshing','solving','post'].includes(bishop.deformation.status)) bishop.deformation.status = 'idle';
    bishop.deformation.rejectReason = '';
    // Status honesty: keep the deformation status bar from advertising a stale
    // "Deformation screen ready…" after its result has been discarded here.
    bishop.deformation.progress.message = message || 'Deformation result cleared; rerun deformation analysis.';
  }
  if(message) bishop.progress.message = message;
  return {stop:INVALIDATE_BISHOP_STOP, rerun:INVALIDATE_BISHOP_RERUN, render:true};
}

/** A wall was added / moved / removed: Bishop + deformation (invalidateBishop) and seepage, mesh discarded. */
export function invalidateWallGeometry(bishop, message){
  invalidateBishop(bishop, message || 'Retaining wall geometry changed; rerun Bishop search.');
  invalidateSeepage(bishop, {message:'Wall geometry changed; rerun seepage.', keepMesh:false, preserveSolvedState:false});
  return {stop:INVALIDATE_ALL_STOP, rerun:INVALIDATE_ALL_RERUN, render:true};
}
