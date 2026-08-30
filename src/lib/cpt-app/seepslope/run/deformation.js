// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/run/deformation.js — the deformation FEM run as a request builder and a result
// reducer. Refactor step 9c (01-monolith-map.md §2.11 group "Workers & runs", §5 engine row 3,
// §6.2 step 9c; PLAN §2 row 18c). Moved from legacy-controller.js (integration-r f5b4a9b):
// stage6BishopRunDeformation 4247-4371 (incl. the ~60-key option block 4307-4368), the
// `onmessage` / `onerror` bodies of stage6BishopEnsureDeformationWorker 3999-4114, and the state
// half of stage6BishopStopDeformation 3818-3844.
//
//   prepareDeformation(bishop, model)          → { ok, reject:{reason,message}|null, patch }
//   startDeformation(bishop, model, runId)     → { patch, message }
//   buildDeformationOptions(bishop)            → the option block of the message (pure)
//   reduceDeformationMessage(bishop, payload)  → { handled, kind, patch, effects }
//   deformationWorkerErrorPatch()              → the onerror writes
//   stopDeformationPatch(bishop, silent)       → the state half of stage6BishopStopDeformation
//   deformationStopMessage(runId)              → the `stop-deformation` message
//
// The worker protocol (map §5 row 3) is `{type:'run-deformation', runId, input:{model, options}}`
// out, `{type:'progress'|'result'|'error', runId, …}` back, `{type:'stop-deformation', runId}` to
// ask a running solve to stop. See deformation/deformation-worker.js.
//
// `lastWallInputs` is the wall snapshot taken at launch: deformation/wall-result-staleness.js
// compares it with the current walls to decide whether the wall response on screen still belongs
// to the geometry the user is looking at. It is written by the launch patch — a key the schema
// does not declare, appended to `deformation` exactly where the monolith appended it.

import { activeSurfaceLoads, resolvedDeformationMeshTargetArea } from '../state/index.js';
import { deformationCompleteMessage } from './progress.js';

/** Every string the deformation run can put on its reject reason / progress message. */
export const DEFORMATION_MESSAGES = Object.freeze({
  noModel: 'Draw terrain and place the active CPT marker first.',
  noLoads: 'Draw or enable at least one positive surface load before running deformation.',
  noWorker: 'Web Worker is not available in this browser context.',
  meshing: 'Building triangulated deformation mesh...',
  running: 'Running deformation...',
  noResult: 'The deformation solver returned no result.',
  failed: 'Deformation solve failed.',
  workerError: 'Deformation worker error.',
  stopping: 'Stopping deformation and keeping the latest solved state...',
  notRunning: 'No deformation run is active.'
});

/** The two interrupt errors of the solver and the message the app shows for each. */
export const DEFORMATION_INTERRUPT = Object.freeze({
  'Deformation run was interrupted before the first displacement solution became available.':
    'Deformation interrupted before the first displacement solution became available.',
  'Deformation run was interrupted before geostatic initialization became available.':
    'Deformation interrupted before the geostatic initialization solution became available.'
});

const RUNNING_STATUSES = ['meshing','solving','post'];
const NO_EFFECTS = Object.freeze({ render: false, drawCanvas: false, updateProgressDom: false });
const RENDER_EFFECTS = Object.freeze({ render: true, drawCanvas: false, updateProgressDom: false });

/** `'safety-cphi'` or `'deformation'` — the analysis the option block and the messages branch on. */
export function deformationAnalysisType(bishop){
  return bishop.deformation?.options?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
}

/** The state a rejected attempt writes: the reason and a failed status. */
export function deformationRejectionPatch(rejection){
  return {
    'deformation.rejectReason': rejection.message,
    'deformation.status': 'failed'
  };
}

/**
 * Pre-flight, in the monolith's order: a model, and — for a deformation (not a c-phi safety)
 * analysis — at least one active surface load.
 */
export function prepareDeformation(bishop, model){
  const reject = (reason, message) => ({ ok:false, reject:{reason, message}, patch:deformationRejectionPatch({reason, message}) });
  if(!model) return reject('no-model', DEFORMATION_MESSAGES.noModel);
  if(deformationAnalysisType(bishop) === 'deformation' && !activeSurfaceLoads(bishop, 'deformation').length){
    return reject('no-loads', DEFORMATION_MESSAGES.noLoads);
  }
  return { ok:true, reject:null, patch:{} };
}

/** The host has no Worker constructor (SSR / Node). */
export function deformationNoWorkerPatch(){
  return deformationRejectionPatch({ reason:'no-worker', message:DEFORMATION_MESSAGES.noWorker });
}

/** The wall snapshot the staleness check compares the current walls with. */
export function buildLastWallInputs(model){
  return (model.walls || []).map((wall)=>({
    id:wall.id,
    head:wall.head ? {...wall.head} : null,
    tip:wall.tip ? {...wall.tip} : null,
    x:wall.x,
    yTop:wall.yTop,
    yTip:wall.yTip,
    passiveSide:wall.passiveSide,
    mechanicalActive:wall.mechanicalActive === true
  }));
}

/**
 * The `options` block of the `run-deformation` message — the ~60 keys of map §5 row 3, read off
 * `bishop.deformation.options` in the monolith's order, with its coercions and its three pinned
 * values (`initialStressMode`, `useStagedGeostaticInit`, `useNewGpuPipeline` / `gpuPipelineVersion`
 * / `wasmRobustNonlinearMode`). Every key is part of the solver contract: adding, removing or
 * reordering one is a behaviour change, so the verifier deep-equals this block.
 */
export function buildDeformationOptions(bishop){
  return {
    analysisType:deformationAnalysisType(bishop),
    meshTargetArea:resolvedDeformationMeshTargetArea(bishop),
    meshElementType:String(bishop.deformation?.options?.meshElementType || '').toLowerCase() === 't6' ? 't6' : 't3',
    constitutiveModel:bishop.deformation?.options?.constitutiveModel,
    initialStressMode:'plastic-geostatic',
    loadMode:bishop.deformation?.options?.loadMode === 'total' ? 'total' : 'pressure',
    totalLoad:bishop.deformation?.options?.totalLoad,
    outOfPlaneLength:bishop.deformation?.options?.outOfPlaneLength,
    useSeepagePorePressures:bishop.deformation?.options?.useSeepagePorePressures === true,
    nonlinearMaxIterations:bishop.deformation?.options?.nonlinearMaxIterations,
    initialLoadStep:bishop.deformation?.options?.initialLoadStep,
    minLoadStep:bishop.deformation?.options?.minLoadStep,
    maxLoadSteps:bishop.deformation?.options?.maxLoadSteps,
    residualRelTol:bishop.deformation?.options?.residualRelTol,
    residualAbsTol:bishop.deformation?.options?.residualAbsTol,
    displacementRelTol:bishop.deformation?.options?.displacementRelTol,
    displacementAbsTol:bishop.deformation?.options?.displacementAbsTol,
    loadStepGrowthFactor:bishop.deformation?.options?.loadStepGrowthFactor,
    loadStepCutbackFactor:bishop.deformation?.options?.loadStepCutbackFactor,
    plasticLoadStepGrowthFactor:bishop.deformation?.options?.plasticLoadStepGrowthFactor,
    plasticLoadStepCutbackFactor:bishop.deformation?.options?.plasticLoadStepCutbackFactor,
    geostaticInitializationMethod:bishop.deformation?.options?.geostaticInitializationMethod,
    geostaticStressOnlyResidualTolerance:bishop.deformation?.options?.geostaticStressOnlyResidualTolerance,
    useStagedGeostaticInit:true,
    // Staged construction (model C): default ON (physically-correct for a
    // retaining wall; inert for non-wall / non-MC). Toggle off for the
    // legacy wall-free geostatic.
    useStagedExcavation:bishop.deformation?.options?.useStagedExcavation !== false,
    // Phase 2 soil-wall interface: default ON (engages only for MC + wall +
    // staged; the solver downgrades safety-cphi runs to the bonded wall).
    useWallInterface:bishop.deformation?.options?.useWallInterface !== false,
    allowStressOnlyGeostaticReference:bishop.deformation?.options?.allowStressOnlyGeostaticReference === true,
    stressOnlyGeostaticMaxEta:bishop.deformation?.options?.stressOnlyGeostaticMaxEta,
    geostaticCorrectionStages:bishop.deformation?.options?.geostaticCorrectionStages,
    initialGravityTangentSchedule:bishop.deformation?.options?.initialGravityTangentSchedule,
    initialGravityElasticGlobalizationIterations:bishop.deformation?.options?.initialGravityElasticGlobalizationIterations,
    elasticGlobalizationArmijoC1:bishop.deformation?.options?.elasticGlobalizationArmijoC1,
    elasticGlobalizationMinResidualRatio:bishop.deformation?.options?.elasticGlobalizationMinResidualRatio,
    geostaticMinLoadStep:bishop.deformation?.options?.geostaticMinLoadStep,
    geostaticMaxRepeatedBand:bishop.deformation?.options?.geostaticMaxRepeatedBand,
    geostaticProgressFailFast:bishop.deformation?.options?.geostaticProgressFailFast === true,
    geostaticProgressFailFastSteps:bishop.deformation?.options?.geostaticProgressFailFastSteps,
    geostaticProgressFailFastLoadFactor:bishop.deformation?.options?.geostaticProgressFailFastLoadFactor,
    geostaticProgressFailFastPlasticFraction:bishop.deformation?.options?.geostaticProgressFailFastPlasticFraction,
    serviceProgressFailFast:bishop.deformation?.options?.serviceProgressFailFast === true,
    serviceProgressFailFastSteps:bishop.deformation?.options?.serviceProgressFailFastSteps,
    serviceProgressFailFastLoadFactor:bishop.deformation?.options?.serviceProgressFailFastLoadFactor,
    serviceProgressFailFastPlasticFraction:bishop.deformation?.options?.serviceProgressFailFastPlasticFraction,
    safetyInitialSigmaMsfIncrement:bishop.deformation?.options?.safetyInitialSigmaMsfIncrement,
    safetySigmaMsfGrowthFactor:bishop.deformation?.options?.safetySigmaMsfGrowthFactor,
    safetySigmaMsfMax:bishop.deformation?.options?.safetySigmaMsfMax,
    safetySigmaMsfBracketTolerance:bishop.deformation?.options?.safetySigmaMsfBracketTolerance,
    safetyMaxSearchTrials:bishop.deformation?.options?.safetyMaxSearchTrials,
    safetyFinalizationMode:bishop.deformation?.options?.safetyFinalizationMode === 'production-msf' ? 'production-msf' : 'legacy-bracket',
    useUnsymmetricPlasticSolver:bishop.deformation?.options?.useUnsymmetricPlasticSolver === true,
    solverBackend:bishop.deformation?.options?.solverBackend === 'js-cpu' ? 'js-cpu' : 'wasm-cpu',
    useNewGpuPipeline:false,
    gpuPipelineVersion:'v1',
    useWasmCpuPipeline:bishop.deformation?.options?.solverBackend !== 'js-cpu',
    wasmRobustNonlinearMode:false
  };
}

/** The `run-deformation` message around an already-built option block. */
export function deformationRequest(runId, model, options){
  return {
    type:'run-deformation',
    runId,
    input:{
      model,
      options
    }
  };
}

/**
 * State → worker message in one call. The host builds the options at the post, where the monolith
 * built them (inline in the postMessage literal, after the pre-post render).
 */
export function buildDeformationRequest(bishop, model, runId){
  return deformationRequest(runId, model, buildDeformationOptions(bishop));
}

/**
 * The launch patch: status, reason cleared, warnings cleared, the wall snapshot, and progress
 * replaced wholesale.
 */
export function startDeformationPatch(model, runId){
  return {
    'deformation.status':'meshing',
    'deformation.rejectReason':'',
    'deformation.warnings':[],
    'deformation.lastWallInputs':buildLastWallInputs(model),
    'deformation.progress':{
      running:true,
      percent:0,
      message:DEFORMATION_MESSAGES.meshing,
      runId
    }
  };
}

/** The cooperative stop the Stop button posts while a solve is running. */
export function deformationStopMessage(runId){
  return { type:'stop-deformation', runId };
}

/** One message from the deformation worker; the run-id guard is the `handled:false` branch. */
export function reduceDeformationMessage(bishop, payload = {}){
  const deformation = bishop?.deformation;
  if(!deformation || payload.runId !== deformation.progress?.runId){
    return { handled:false, kind:'stale', patch:null, effects:NO_EFFECTS };
  }
  if(payload.type === 'progress'){
    const patch = {
      'deformation.progress.running':true,
      'deformation.progress.percent':payload.progress?.percent || 0,
      'deformation.progress.message':payload.progress?.message || DEFORMATION_MESSAGES.running
    };
    if(payload.progress?.stage === 'meshing') patch['deformation.status'] = 'meshing';
    else if(payload.progress?.stage === 'solving') patch['deformation.status'] = 'solving';
    else if(payload.progress?.stage === 'post') patch['deformation.status'] = 'post';
    return { handled:true, kind:'progress', patch, effects:RENDER_EFFECTS };
  }
  const patch = {
    'deformation.progress.running':false,
    'deformation.progress.percent':100
  };
  if(payload.type === 'result'){
    const mesh = payload.output?.mesh || null;
    const result = payload.output || null;
    const status = mesh && result ? 'success' : 'failed';
    patch['deformation.mesh'] = mesh;
    patch['deformation.result'] = result;
    patch['deformation.stale'] = false;
    patch['deformation.warnings'] = Array.isArray(payload.output?.warnings) ? payload.output.warnings : [];
    patch['deformation.status'] = status;
    patch['deformation.rejectReason'] = status === 'success' ? '' : DEFORMATION_MESSAGES.noResult;
    patch['deformation.progress.message'] = deformationCompleteMessage(status, payload.output);
    return { handled:true, kind:'result', patch, effects:RENDER_EFFECTS };
  }
  if(Object.prototype.hasOwnProperty.call(DEFORMATION_INTERRUPT, payload.error)){
    patch['deformation.status'] = 'idle';
    patch['deformation.rejectReason'] = '';
    patch['deformation.progress.message'] = DEFORMATION_INTERRUPT[payload.error];
    patch['deformation.progress.percent'] = 0;
    return { handled:true, kind:'interrupted', patch, effects:RENDER_EFFECTS };
  }
  const rejectReason = payload.error || DEFORMATION_MESSAGES.failed;
  patch['deformation.status'] = 'failed';
  patch['deformation.rejectReason'] = rejectReason;
  patch['deformation.progress.message'] = rejectReason;
  patch['deformation.progress.percent'] = 0;
  return { handled:true, kind:'error', patch, effects:RENDER_EFFECTS };
}

/** The worker's `onerror`. */
export function deformationWorkerErrorPatch(){
  return {
    'deformation.progress.running':false,
    'deformation.progress.percent':0,
    'deformation.status':'failed',
    'deformation.rejectReason':DEFORMATION_MESSAGES.workerError,
    'deformation.progress.message':DEFORMATION_MESSAGES.workerError
  };
}

/**
 * The state half of stage6BishopStopDeformation — the seepage counterpart, with `post` counted as
 * a running status. Silent is identical to seepslope/model/invalidate.js stopDeformationState.
 */
export function stopDeformationPatch(bishop, silent){
  const deformation = bishop?.deformation;
  if(!deformation) return {};
  if(silent){
    const patch = {
      'deformation.progress.running':false,
      'deformation.progress.percent':0
    };
    if(RUNNING_STATUSES.includes(deformation.status)) patch['deformation.status'] = 'idle';
    return patch;
  }
  return {
    'deformation.progress.message':deformation.progress?.running ? DEFORMATION_MESSAGES.stopping : DEFORMATION_MESSAGES.notRunning,
    'deformation.rejectReason':''
  };
}
