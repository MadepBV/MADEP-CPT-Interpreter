// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GPU pipeline v2 — matrix-free, single-handoff entry point.
// =============================================================================
//
// This module contains the production v2 elastoplastic entry point
// (`runFullDeformationAnalysisOnGpuV2`). The full path:
//
//   1. uploads static mesh data once (B-matrices, gpWeights, dofMap,
//      matParams, matIndex, forceIncPtr / forceIncList);
//   2. builds per-GP elastic D and a Jacobi/block-Jacobi preconditioner;
//   3. runs staged geostatic, service-load, and optional safety solves;
//   4. keeps Kx, residuals, internal force, and local return mapping on GPU;
//   5. reads back only the final result contract and scalar diagnostics.
//
// All v2 buffers and pipelines are local to this controller — no v1 state is
// mutated.  The CSR codepath in v1 is unaffected.
//
// The returned shape mirrors the CPU/v1 deformation result fields that
// `solver.js` needs while keeping all v2 buffers private to this module.

import { createV2Context } from './gpu-v2-state.js';
import { runPlasticNewtonOnGpuV2 } from './gpu-v2-newton.js';
import { reduceMaterialStrengthForSafety } from '../../material.js';
import {
  dispatchBuildElasticD,
  readDsVector,
  readU32Vector,
  readFint,
  readBranchKind,
  readMcStats,
  uploadInitialState,
  replaceStorageBufferData,
  recordPlasticResidual,
  recordCommitPlasticState,
  createV2Snapshot,
  destroyV2Snapshot,
  recordSnapshotState,
  recordRestoreState
} from './gpu-v2-dispatch.js';

// =============================================================================
// runFullDeformationAnalysisOnGpuV2 — full elastoplastic GPU pipeline.
// =============================================================================
//
// Single handoff in (mesh + materials + initial state + load), single
// handoff out (final displacement + final stress).  Inside, the solver:
//
//   - Allocates persistent GPU state (`createV2Context`) — one upload of
//     B-matrices, dofMap, gpWeights, matParams, matIndex, incidence list.
//   - Builds elastic D per GP and the preconditioner (block-Jacobi by
//     default; scalar Jacobi as fallback).
//   - For each load step (gravity, then optional surface load):
//       runs modified-Newton on-device (matrix-free K·x, local return
//       mapping at every GP, BiCGStab if non-associated tangent).
//
// Output shape mirrors v1's `runFullDeformationAnalysisOnGpu` so solver.js
// can switch by setting `gpuPipelineVersion: 'v2'` without other changes.
//
function hasNonzeroVector(vector) {
  if (!vector) return false;
  for (let i = 0; i < vector.length; i += 1) {
    if (Math.abs(Number(vector[i]) || 0) > 0) return true;
  }
  return false;
}

function vectorNormF64(vector) {
  let sum = 0;
  let c = 0;
  for (let i = 0; i < (vector?.length || 0); i += 1) {
    const v = Number(vector[i]) || 0;
    const y = v * v - c;
    const t = sum + y;
    c = (t - sum) - y;
    sum = t;
  }
  return Math.sqrt(Math.max(sum, 0));
}

function combineFreeDofVectors(a, b, lambda = 1) {
  const n = a?.length || b?.length || 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = (Number(a?.[i]) || 0) + lambda * (Number(b?.[i]) || 0);
  }
  return out;
}

function blendFreeDofVectors(a, b, lambda = 1) {
  const n = Math.max(a?.length || 0, b?.length || 0);
  const out = new Float64Array(n);
  const t = Math.max(0, Math.min(Number(lambda) || 0, 1));
  for (let i = 0; i < n; i += 1) {
    out[i] = (1 - t) * (Number(a?.[i]) || 0) + t * (Number(b?.[i]) || 0);
  }
  return out;
}

function subtractVectors(a, b) {
  const n = Math.max(a?.length || 0, b?.length || 0);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (Number(a?.[i]) || 0) - (Number(b?.[i]) || 0);
  return out;
}

function expandFreeToFull(ctx, uFreeF64) {
  const out = new Float64Array(ctx.ndof);
  for (let i = 0; i < ctx.numFree; i += 1) out[ctx.pack.freeDofs[i]] = Number(uFreeF64?.[i]) || 0;
  return out;
}

function branchCounts(branchKind) {
  const counts = { elastic: 0, face: 0, edge: 0, apex: 0, tension: 0, plastic: 0, total: branchKind?.length || 0 };
  for (const value of branchKind || []) {
    if (value === 0) counts.elastic += 1;
    else {
      counts.plastic += 1;
      if (value === 1) counts.face += 1;
      else if (value === 2 || value === 3) counts.edge += 1;
      else if (value === 4) counts.apex += 1;
      else if (value >= 5) counts.tension += 1;
    }
  }
  return counts;
}

function summarizeNewtonResult(newton) {
  return {
    converged: newton?.converged === true,
    iterations: Math.max(Math.round(Number(newton?.iterations) || 0), 0),
    linearIterations: Math.max(Math.round(Number(newton?.linearIterations ?? newton?.cgIterations) || 0), 0),
    residualNorm: Number(newton?.residualNorm) || 0,
    rhsNorm: Number(newton?.rhsNorm) || 0,
    targetTol: Number(newton?.targetTol) || 0,
    solverName: newton?.solverName || 'unknown',
    usedFallback: newton?.usedFallback === true,
    tangentMode: newton?.tangentMode || '',
    tangentFallbackFrom: newton?.tangentFallbackFrom || '',
    primaryFailureReason: newton?.primaryFailureReason || '',
    lineSearchEvaluations: Math.max(Math.round(Number(newton?.lineSearchEvaluations) || 0), 0),
    minAcceptedLineSearchAlpha: Number(newton?.minAcceptedLineSearchAlpha) || 1,
    lastAcceptedLineSearchAlpha: Number(newton?.lastAcceptedLineSearchAlpha) || 1,
    localReturnFallbackCount: (newton?.localReturnFallbacks || [])
      .reduce((sum, item) => sum + (Number(item?.count) || 0), 0),
    branchCounts: newton?.branchCounts || null,
    reason: newton?.reason || ''
  };
}

function adaptiveContinuationFactor({
  iterations,
  acceptedLineSearchScale,
  targetIterations = 6,
  targetLineSearchScale = 0.9,
  iterationExponent = 0.5,
  lineSearchExponent = 0.25,
  minFactor,
  maxFactor
}) {
  const boundedMin = Math.max(Number(minFactor) || 0, 1e-6);
  const boundedMax = Math.max(Number(maxFactor) || 0, boundedMin);
  const effectiveIterations = Math.max(Number(iterations) || 0, 1);
  const effectiveScale = Math.max(Math.min(Number(acceptedLineSearchScale) || 1, 1), 1e-6);
  const targetIter = Math.max(Number(targetIterations) || 6, 1);
  const targetScale = Math.max(Math.min(Number(targetLineSearchScale) || 0.9, 1), 1e-6);
  const iterExp = Math.max(Number(iterationExponent) || 0.5, 0);
  const scaleExp = Math.max(Number(lineSearchExponent) || 0.25, 0);
  const raw = Math.pow(targetIter / effectiveIterations, iterExp) * Math.pow(effectiveScale / targetScale, scaleExp);
  if (!Number.isFinite(raw) || raw <= 0) return boundedMin;
  return Math.min(Math.max(raw, boundedMin), boundedMax);
}

function useAdaptiveContinuationForV2(options) {
  // Keep v2 conservative by default. The CPU nonlinear solver uses adaptive
  // continuation unless disabled, but v2's last stable behavior used fixed
  // growth/cutback. Only enable adaptive v2 stepping through a v2-specific
  // option so CPU/v1 tuning cannot silently change this experimental route.
  return options?.v2AdaptiveContinuation === true || options?.gpuV2AdaptiveContinuation === true;
}

function v2LineSearchBacktrackCount(value, floor) {
  return Math.max(Math.round(Number(value) || 0), floor);
}

function nextAcceptedStepSize(currentStep, lambda, newton, options, {
  grow,
  cut,
  phase = 'service-load'
}) {
  if (!useAdaptiveContinuationForV2(options)) {
    return Math.min(currentStep * grow, Math.max(1 - lambda, 0) + 1e-12);
  }
  const isInitialGravity = phase === 'initial-gravity';
  const targetIterations = Math.max(
    Number(
      isInitialGravity
        ? (options?.initialGravityContinuationTargetIterations ?? options?.continuationTargetIterations)
        : phase === 'safety-cphi'
          ? (options?.safetyContinuationTargetIterations ?? options?.continuationTargetIterations)
          : options?.continuationTargetIterations
    ) || 6,
    1
  );
  const factor = adaptiveContinuationFactor({
    iterations: Number(newton?.iterations) || 1,
    acceptedLineSearchScale: Number(newton?.minAcceptedLineSearchAlpha ?? newton?.lastAcceptedLineSearchAlpha) || 1,
    targetIterations,
    targetLineSearchScale: Math.max(Math.min(Number(options?.continuationTargetLineSearchScale) || 0.9, 1), 1e-6),
    iterationExponent: Math.max(Number(options?.continuationIterationExponent) || 0.5, 0),
    lineSearchExponent: Math.max(Number(options?.continuationLineSearchExponent) || 0.25, 0),
    minFactor: cut,
    maxFactor: grow
  });
  return Math.min(currentStep * factor, Math.max(1 - lambda, 0) + 1e-12);
}

function shouldRetryWithElasticTangent(newton) {
  if (!newton || newton.converged === true) return false;
  const reason = String(newton.reason || '').toLowerCase();
  return (
    reason.includes('newton did not converge') ||
    reason.includes('line search failed') ||
    reason.includes('linear solver failed to converge')
  );
}

async function runNewtonWithAdaptiveTangent(ctx, args, { options, warnings, phase }) {
  const triedAlgorithmic = ctx.useAlgorithmicTangent === true;
  const fallbackEnabled = options?.v2EnableElasticTangentFallback !== false;
  if (!fallbackEnabled || !triedAlgorithmic) {
    const result = await runPlasticNewtonOnGpuV2(ctx, args);
    result.tangentMode = triedAlgorithmic ? 'algorithmic' : 'elastic';
    return result;
  }

  const baseSnapshot = snapshotCurrentState(ctx, `mf-v2-${phase || 'newton'}-base`);
  const first = await runPlasticNewtonOnGpuV2(ctx, args);
  first.tangentMode = triedAlgorithmic ? 'algorithmic' : 'elastic';
  if (
    first.converged ||
    !shouldRetryWithElasticTangent(first)
  ) {
    if (!first.converged) await restoreSnapshot(ctx, baseSnapshot, `mf-v2-${phase || 'newton'}-restore-after-fail`);
    destroyV2Snapshot(baseSnapshot);
    return first;
  }

  const message = `[GPU v2] Algorithmic tangent Newton stalled during ${phase}; retrying this load step with the elastic tangent and keeping the elastic tangent for the rest of the phase. First reason: ${first.reason || 'unknown'}`;
  if (Array.isArray(warnings) && !warnings.includes(message)) warnings.push(message);

  await restoreSnapshot(ctx, baseSnapshot, `mf-v2-${phase || 'newton'}-restore-before-elastic-retry`);
  ctx.useAlgorithmicTangent = false;
  const retry = await runPlasticNewtonOnGpuV2(ctx, args);
  retry.tangentMode = 'elastic';
  retry.tangentFallbackFrom = 'algorithmic';
  retry.primaryFailureReason = first.reason || '';
  retry.usedFallback = retry.usedFallback === true || first.usedFallback === true;
  retry.linearSolveHistory = [
    ...(first.linearSolveHistory || []).map((item) => ({ ...item, discardedByTangentFallback: true })),
    ...(retry.linearSolveHistory || [])
  ];
  if (!retry.converged) await restoreSnapshot(ctx, baseSnapshot, `mf-v2-${phase || 'newton'}-restore-after-retry-fail`);
  destroyV2Snapshot(baseSnapshot);
  return retry;
}

function appendLinearHistory(target, newton, phase, lambda = null) {
  for (const item of newton?.linearSolveHistory || []) target.push({ ...item, phase, lambda });
}

function buildLinearSummary(history) {
  const countsBySolver = {};
  const countsByPath = {};
  let totalIterations = 0;
  for (const item of history || []) {
    const solver = item?.solver || 'unknown';
    const path = item?.path || `gpu-v2-${solver}`;
    countsBySolver[solver] = (countsBySolver[solver] || 0) + 1;
    countsByPath[path] = (countsByPath[path] || 0) + 1;
    totalIterations += Number(item?.iterations) || 0;
  }
  return {
    solveCount: history?.length || 0,
    countsBySolver,
    countsByPath,
    primaryPath: Object.entries(countsByPath).sort((a, b) => b[1] - a[1])[0]?.[0] || 'gpu-v2',
    totalIterations,
    perSolve: history || []
  };
}

function totalLocalReturnFallbacks(history) {
  return (
    (history?.geostatic || []).reduce((sum, item) => sum + (Number(item?.localReturnFallbackCount) || 0), 0) +
    (history?.loadSteps || []).reduce((sum, item) => sum + (Number(item?.localReturnFallbackCount) || 0), 0) +
    (history?.safety || []).reduce((sum, item) => sum + (Number(item?.localReturnFallbackCount) || 0), 0)
  );
}

function firstPositiveHistoryValue(list, key) {
  for (const item of list || []) {
    const value = Number(item?.[key]) || 0;
    if (value > 0) return value;
  }
  return 0;
}

async function readSigmaCommitted(ctx) {
  return readDsVector(ctx, ctx.buffers.sigmaCommitted, ctx.numGp * 6, 'mf-read-sigmaCommitted');
}

function snapshotCurrentState(ctx, label) {
  const snapshot = createV2Snapshot(ctx, label);
  const enc = ctx.device.createCommandEncoder({ label });
  recordSnapshotState(ctx, enc, snapshot);
  ctx.device.queue.submit([enc.finish()]);
  return snapshot;
}

async function initializeGeostaticReference(ctx, sigmaInitialF64) {
  await uploadInitialState(ctx, {
    uF64: new Float64Array(ctx.numFree),
    sigmaCommittedF64: sigmaInitialF64 || new Float64Array(ctx.numGp * 6),
    bF64: new Float64Array(ctx.numFree)
  });
  {
    const enc = ctx.device.createCommandEncoder({ label: 'mf-v2-geostatic-reference' });
    dispatchBuildElasticD(ctx, enc);
    recordPlasticResidual(ctx, enc);
    recordCommitPlasticState(ctx, enc);
    ctx.device.queue.submit([enc.finish()]);
  }
  const stats = await readMcStats(ctx);
  const failed = Number(stats.failed) || 0;
  if (failed > 0) {
    return {
      converged: false,
      reason: `initial return mapping failed at ${failed} Gauss point(s)`,
      localReturnFallbackCount: failed,
      targetForceBaseF64: await readFint(ctx),
      branchKind: await readBranchKind(ctx)
    };
  }
  return {
    converged: true,
    localReturnFallbackCount: failed,
    targetForceBaseF64: await readFint(ctx),
    branchKind: await readBranchKind(ctx)
  };
}

async function restoreSnapshot(ctx, snapshot, label = 'mf-v2-restore') {
  const enc = ctx.device.createCommandEncoder({ label });
  recordRestoreState(ctx, enc, snapshot);
  ctx.device.queue.submit([enc.finish()]);
}

function packReducedMatParams(pack, regionConstitutiveByRegion, sigmaMsf) {
  const f64 = new Float64Array((pack.numMaterials || 0) * 8);
  for (let matIdx = 0; matIdx < (pack.numMaterials || 0); matIdx += 1) {
    const regionIndex = pack.matToRegion?.[matIdx];
    const constitutive = regionConstitutiveByRegion.get(regionIndex);
    const baseParams = constitutive?.materialParameters || {};
    const reduced = sigmaMsf > 1 + 1e-12 ? reduceMaterialStrengthForSafety(baseParams, sigmaMsf) : baseParams;
    const phi = ((Number(reduced?.phiEffDeg) || 0) * Math.PI) / 180;
    const psi = ((Number(reduced?.psiEffDeg) || 0) * Math.PI) / 180;
    const E = Math.max(Number(reduced?.Emc) || 1000, 1);
    const nu = Math.max(Math.min(Number(reduced?.nu) || 0.3, 0.499), -0.999);
    f64[matIdx * 8 + 0] = Math.sin(phi);
    f64[matIdx * 8 + 1] = Math.cos(phi);
    f64[matIdx * 8 + 2] = Math.sin(psi);
    f64[matIdx * 8 + 3] = Math.cos(psi);
    f64[matIdx * 8 + 4] = Number(reduced?.cEff) || 0;
    f64[matIdx * 8 + 5] = Number(reduced?.sigmaTAllow) || 0;
    f64[matIdx * 8 + 6] = E / (3 * (1 - 2 * nu));
    f64[matIdx * 8 + 7] = E / (2 * (1 + nu));
  }
  const out = new Float32Array(f64.length * 2);
  for (let i = 0; i < f64.length; i += 1) {
    const hi = Math.fround(f64[i]);
    out[2 * i] = hi;
    out[2 * i + 1] = Math.fround(f64[i] - hi);
  }
  return out;
}

async function runStagedGeostaticV2({ ctx, gravityRhsFree, sigmaInitialF64, newtonOptions, options, warnings, history, onProgress }) {
  onProgress({ stage: 'solving', percent: 63, message: 'GPU v2: preparing geostatic reference' });
  const reference = await initializeGeostaticReference(ctx, sigmaInitialF64);
  if (!reference.converged) return reference;
  if (reference.localReturnFallbackCount > 0) {
    history.geostatic.push({
      step: -1,
      lambda: 0,
      phase: 'initial-reference',
      converged: true,
      iterations: 0,
      linearIterations: 0,
      residualNorm: 0,
      solverName: 'none',
      usedFallback: false,
      localReturnFallbackCount: reference.localReturnFallbackCount,
      branchCounts: branchCounts(reference.branchKind),
      reason: ''
    });
  }

  const initialDLambda = Math.max(Math.min(Number(options?.initialGravityInitialLoadStep ?? options?.initialLoadStep) || 0.25, 1), 1e-6);
  const minDLambda = Math.max(Number(options?.initialGravityMinLoadStep ?? options?.minLoadStep) || (1 / 2048), 1e-6);
  const grow = Math.max(Number(options?.initialGravityPlasticLoadStepGrowthFactor ?? options?.plasticLoadStepGrowthFactor) || 1.12, 1);
  const cut = Math.min(Math.max(Number(options?.initialGravityPlasticLoadStepCutbackFactor ?? options?.plasticLoadStepCutbackFactor) || 0.5, 0.05), 0.95);
  const maxSteps = Math.max(Math.round(Number(options?.initialGravityMaxLoadSteps ?? options?.maxLoadSteps) || 256), 1);

  let lambda = 0;
  let dLambda = initialDLambda;
  let acceptedU = new Float64Array(ctx.numFree);
  let lastNewton = null;
  let acceptedSteps = 0;
  let rejectedSteps = 0;

  for (let step = 0; step < maxSteps && lambda < 1 - 1e-12; step += 1) {
    const trialLambda = Math.min(lambda + dLambda, 1);
    const actualStep = Math.max(trialLambda - lambda, 0);
    const bTrial = blendFreeDofVectors(reference.targetForceBaseF64, gravityRhsFree, trialLambda);
    const bTrialNorm = vectorNormF64(bTrial);
    onProgress({ stage: 'solving', percent: Math.min(72, 64 + 8 * trialLambda), message: `GPU v2: geostatic load step ${acceptedSteps + rejectedSteps + 1}, lambda ${trialLambda.toFixed(3)}` });
    const newton = await runNewtonWithAdaptiveTangent(
      ctx,
      {
        bF64: bTrial,
        sigmaInitialF64: null,
        u0F64: acceptedU,
        ...newtonOptions,
        phaseKind: 'initial-gravity'
      },
      { options, warnings, phase: 'geostatic staging' }
    );
    if (newtonOptions?.debug === true) {
      console.log(`[v2-geostatic] step=${step} lambda=${trialLambda.toFixed(3)} host|bTrial|=${bTrialNorm.toExponential(3)} gpu|b|=${(Number(newton?.rhsNorm) || 0).toExponential(3)} resid=${(Number(newton?.residualNorm) || 0).toExponential(3)} converged=${newton?.converged}`);
    }
    history.geostatic.push({ step, lambda: trialLambda, ...summarizeNewtonResult(newton) });
    appendLinearHistory(history.linearSolves, newton, 'geostatic', trialLambda);
    lastNewton = newton;
    if (newton.converged) {
      acceptedU = newton.uFreeF64;
      lambda = trialLambda;
      acceptedSteps += 1;
      dLambda = nextAcceptedStepSize(actualStep, lambda, newton, options, { grow, cut, phase: 'initial-gravity' });
    } else {
      rejectedSteps += 1;
      dLambda *= cut;
      if (dLambda < minDLambda) {
        return { converged: false, reason: `geostatic step below minimum at lambda=${lambda.toExponential(3)}: ${newton.reason || 'Newton failed'}`, uFreeF64: acceptedU, lastNewton, acceptedSteps, rejectedSteps, targetForceBaseF64: reference.targetForceBaseF64, referenceBranchCounts: branchCounts(reference.branchKind) };
      }
    }
  }

  if (lambda < 1 - 1e-12) {
    return { converged: false, reason: `geostatic staging stopped at lambda=${lambda.toExponential(3)}`, uFreeF64: acceptedU, lastNewton, acceptedSteps, rejectedSteps, targetForceBaseF64: reference.targetForceBaseF64, referenceBranchCounts: branchCounts(reference.branchKind) };
  }
  return {
    converged: true,
    uFreeF64: acceptedU,
    uFullF64: expandFreeToFull(ctx, acceptedU),
    lastNewton,
    acceptedSteps,
    rejectedSteps,
    targetForceBaseF64: reference.targetForceBaseF64,
    referenceBranchCounts: branchCounts(reference.branchKind),
    referenceLocalReturnFallbackCount: reference.localReturnFallbackCount
  };
}

async function runStagedSurfaceV2({ ctx, gravityRhsFree, surfaceLoadRhsFree, initialU, newtonOptions, options, warnings, history, onProgress }) {
  const useStaged = options?.useStagedSurfaceLoad !== false;
  const maxSteps = useStaged ? Math.max(Math.round(Number(options?.maxLoadSteps) || 256), 1) : 1;
  let lambda = 0;
  let dLambda = useStaged ? Math.max(Math.min(Number(options?.initialLoadStep) || 0.25, 1), 1e-6) : 1;
  const minDLambda = Math.max(Number(options?.minLoadStep) || 1e-4, 1e-6);
  const grow = Math.max(Number(options?.plasticLoadStepGrowthFactor) || 1.05, 1);
  const cut = Math.min(Math.max(Number(options?.plasticLoadStepCutbackFactor) || 0.4, 0.05), 0.95);
  let acceptedU = initialU;
  let lastNewton = null;
  let acceptedSteps = 0;
  let rejectedSteps = 0;
  const surfaceLoadNorm = vectorNormF64(surfaceLoadRhsFree);

  for (let step = 0; step < maxSteps && lambda < 1 - 1e-12; step += 1) {
    const trialLambda = Math.min(lambda + dLambda, 1);
    const actualStep = Math.max(trialLambda - lambda, 0);
    const bTrial = combineFreeDofVectors(gravityRhsFree, surfaceLoadRhsFree, trialLambda);
    const bTrialNorm = vectorNormF64(bTrial);
    onProgress({ stage: 'solving', percent: Math.min(82, 73 + 9 * trialLambda), message: `GPU v2: surface load step ${acceptedSteps + rejectedSteps + 1}, lambda ${trialLambda.toFixed(3)}` });
    let newton = await runNewtonWithAdaptiveTangent(
      ctx,
      {
        bF64: bTrial,
        sigmaInitialF64: null,
        u0F64: acceptedU,
        ...newtonOptions,
        phaseKind: 'service-load',
        nonlinearNoOpGuardNorm: actualStep * surfaceLoadNorm,
        nonlinearNoOpGuardRatio: options?.gpuV2NonlinearNoOpGuardRatio
      },
      { options, warnings, phase: 'surface-load staging' }
    );
    if (newtonOptions?.debug === true) {
      console.log(`[v2-surface] step=${step} lambda=${trialLambda.toFixed(3)} host|bTrial|=${bTrialNorm.toExponential(3)} gpu|b|=${(Number(newton?.rhsNorm) || 0).toExponential(3)} resid=${(Number(newton?.residualNorm) || 0).toExponential(3)} converged=${newton?.converged}`);
    }
    if (newton?.converged) {
      const stepIncrementNorm = vectorNormF64(subtractVectors(newton.uFreeF64, acceptedU));
      const appliedSurfaceNorm = Math.max(actualStep, 0) * surfaceLoadNorm;
      if (appliedSurfaceNorm > 1e-12 && stepIncrementNorm <= 1e-18) {
        newton = {
          ...newton,
          converged: false,
          reason: `surface Newton produced zero displacement increment for nonzero surface load step (|dF_surface|=${appliedSurfaceNorm.toExponential(3)}, |du_step|=${stepIncrementNorm.toExponential(3)})`
        };
      }
    }
    history.loadSteps.push({ step, lambda: trialLambda, ...summarizeNewtonResult(newton) });
    appendLinearHistory(history.linearSolves, newton, 'surface-load', trialLambda);
    lastNewton = newton;
    if (newton.converged) {
      acceptedU = newton.uFreeF64;
      lambda = trialLambda;
      acceptedSteps += 1;
      dLambda = useStaged ? nextAcceptedStepSize(actualStep, lambda, newton, options, { grow, cut, phase: 'service-load' }) : 1;
    } else {
      rejectedSteps += 1;
      if (!useStaged) return { converged: false, reason: `surface load failed: ${newton.reason || 'Newton failed'}`, uFreeF64: acceptedU, lastNewton, acceptedSteps, rejectedSteps };
      dLambda *= cut;
      if (dLambda < minDLambda) return { converged: false, reason: `surface load step below minimum at lambda=${lambda.toExponential(3)}: ${newton.reason || 'Newton failed'}`, uFreeF64: acceptedU, lastNewton, acceptedSteps, rejectedSteps };
    }
  }

  if (lambda < 1 - 1e-12) return { converged: false, reason: `surface staging stopped at lambda=${lambda.toExponential(3)}`, uFreeF64: acceptedU, lastNewton, acceptedSteps, rejectedSteps };
  return { converged: true, uFreeF64: acceptedU, uFullF64: expandFreeToFull(ctx, acceptedU), lastNewton, acceptedSteps, rejectedSteps };
}

async function runSafetyV2({ ctx, gravityRhsFree, surfaceLoadRhsFree, baseUFree, regionConstitutiveByRegion, newtonOptions, options, warnings, history, onProgress }) {
  const sigmaMsfMax = Math.max(Number(options?.safetySigmaMsfMax) || 3, 1);
  const bracketTol = Math.max(Number(options?.safetySigmaMsfBracketTolerance) || 0.01, 1e-4);
  const initialIncr = Math.max(Number(options?.safetyInitialSigmaMsfIncrement) || 0.1, 1e-3);
  const growth = Math.max(Number(options?.safetySigmaMsfGrowthFactor) || 1.5, 1.05);
  const maxTrials = Math.max(Math.round(Number(options?.safetyMaxSearchTrials) || 32), 1);
  const bSafety = combineFreeDofVectors(gravityRhsFree, surfaceLoadRhsFree, 1);
  const snapshot = createV2Snapshot(ctx, 'mf-v2-safety-base');
  const acceptedSnapshot = createV2Snapshot(ctx, 'mf-v2-safety-accepted');
  {
    const enc = ctx.device.createCommandEncoder({ label: 'mf-v2-safety-snapshot' });
    recordSnapshotState(ctx, enc, snapshot);
    recordSnapshotState(ctx, enc, acceptedSnapshot);
    ctx.device.queue.submit([enc.finish()]);
  }

  let sigmaLo = 1;
  let sigmaHi = null;
  let sigmaTrial = 1 + initialIncr;
  let dSigma = initialIncr;
  let lastSafeU = baseUFree;
  let lastSafeNewton = null;
  const baseNonAssociated = ctx.hasNonAssociatedPlasticity === true;

  try {
    for (let trial = 0; trial < maxTrials; trial += 1) {
      sigmaTrial = Math.min(sigmaTrial, sigmaMsfMax);
      await replaceStorageBufferData(ctx, 'matParams', packReducedMatParams(ctx.pack, regionConstitutiveByRegion, sigmaTrial), 'mf-v2-upload-safety-matparams');
      // c-phi reduction changes phi while psi is kept from the material model,
      // so an originally associated model can become non-associated during
      // safety trials.  Use BiCGStab when plasticity is active in that phase.
      ctx.hasNonAssociatedPlasticity = baseNonAssociated || sigmaTrial > 1 + 1e-12;
      await restoreSnapshot(ctx, snapshot, 'mf-v2-safety-restore');
      onProgress({ stage: 'solving', percent: 82, message: `GPU v2: safety trial SigmaMsf ${sigmaTrial.toFixed(3)}` });
      const newton = await runNewtonWithAdaptiveTangent(
        ctx,
        { bF64: bSafety, sigmaInitialF64: null, u0F64: baseUFree, ...newtonOptions, phaseKind: 'safety-cphi' },
        { options, warnings, phase: 'c-phi safety search' }
      );
      history.safety.push({ trial, sigmaMsf: sigmaTrial, ...summarizeNewtonResult(newton) });
      appendLinearHistory(history.linearSolves, newton, 'safety-cphi', sigmaTrial);
      if (newton.converged) {
        sigmaLo = sigmaTrial;
        lastSafeU = newton.uFreeF64;
        lastSafeNewton = newton;
        {
          const enc = ctx.device.createCommandEncoder({ label: 'mf-v2-safety-accepted-snapshot' });
          recordSnapshotState(ctx, enc, acceptedSnapshot);
          ctx.device.queue.submit([enc.finish()]);
        }
        if (sigmaHi != null && sigmaHi - sigmaLo <= bracketTol) break;
        if (sigmaHi == null) {
          if (Math.abs(sigmaTrial - sigmaMsfMax) < 1e-12) break;
          dSigma *= growth;
          sigmaTrial = Math.min(sigmaTrial + dSigma, sigmaMsfMax);
        } else {
          sigmaTrial = 0.5 * (sigmaLo + sigmaHi);
        }
      } else {
        sigmaHi = sigmaTrial;
        if (sigmaHi - sigmaLo <= bracketTol) break;
        sigmaTrial = 0.5 * (sigmaLo + sigmaHi);
      }
    }
  } finally {
    await restoreSnapshot(ctx, snapshot, 'mf-v2-safety-final-restore');
    await replaceStorageBufferData(ctx, 'matParams', packReducedMatParams(ctx.pack, regionConstitutiveByRegion, 1), 'mf-v2-upload-base-matparams');
    ctx.hasNonAssociatedPlasticity = baseNonAssociated;
  }

  const sigmaCommittedF64 = await readDsVector(ctx, acceptedSnapshot.sigma, ctx.numGp * 6, 'mf-v2-read-safety-sigma');
  const plasticStrainCommittedF64 = await readDsVector(ctx, acceptedSnapshot.plastic, ctx.numGp * 6, 'mf-v2-read-safety-plastic');
  const plasticEqCommittedF64 = await readDsVector(ctx, acceptedSnapshot.plasticEq, ctx.numGp, 'mf-v2-read-safety-plastic-eq');
  const branchKind = await readU32Vector(ctx, acceptedSnapshot.branch, ctx.numGp, 'mf-v2-read-safety-branch');
  destroyV2Snapshot(snapshot);
  destroyV2Snapshot(acceptedSnapshot);

  return {
    converged: true,
    status: sigmaHi == null ? 'no-failure-found' : 'bracketed',
    factorOfSafety: sigmaLo,
    factorOfSafetyLower: sigmaLo,
    factorOfSafetyUpper: sigmaHi,
    strengthRetained: sigmaLo > 0 ? 1 / sigmaLo : 1,
    uFreeF64: lastSafeU,
    uFullF64: expandFreeToFull(ctx, lastSafeU),
    sigmaCommittedF64,
    plasticStrainCommittedF64,
    plasticEqCommittedF64,
    branchKind,
    lastNewton: lastSafeNewton,
    history: history.safety
  };
}

export async function runFullDeformationAnalysisOnGpuV2({
  device,
  mesh,
  elementCaches,
  regionConstitutiveByRegion,
  fixedDofSet,
  gravityRhsFree,
  surfaceLoadRhsFree = null,
  sigmaInitialF64 = null,
  porePressureByIntegrationPoint = null,
  options = {},
  warnings = [],
  onProgress = () => {}
}) {
  if (!device) throw new Error('runFullDeformationAnalysisOnGpuV2: GPUDevice required');

  const preconditioner = options?.preconditioner === 'jacobi' ? 'jacobi' : 'block-jacobi';
  const forceSolver = options?.v2LinearSolver === 'bicgstab' || options?.forceSolver === 'bicgstab'
    ? 'bicgstab'
    : (options?.v2LinearSolver === 'cg' || options?.forceSolver === 'cg' ? 'cg' : null);
  const ctx = createV2Context({
    device,
    mesh,
    elementCaches,
    regionConstitutiveByRegion,
    fixedDofSet,
    porePressureByIntegrationPoint,
    preconditioner,
    forceSolver,
    useUnsymmetricPlasticSolver: options?.useUnsymmetricPlasticSolver === true,
    useAlgorithmicTangent: options?.v2UseElasticTangent === true || options?.useAlgorithmicTangent === false ? false : true,
    useLineSearch: options?.v2LineSearch === false ? false : true,
    warnings
  });
  if (typeof device.queue.onSubmittedWorkDone === 'function') {
    await device.queue.onSubmittedWorkDone();
  }

  const cgOptions = {
    maxIter: Math.max(Math.round(Number(options?.cgMaxIter) || 25000), 1),
    relTol: Math.max(Number(options?.cgRelTol) || 1e-5, 1e-12),
    absTol: Math.max(Number(options?.cgAbsTol) || 5e-5, 1e-12),
    bicgstabStagnationWindow: Math.max(Math.round(Number(options?.v2BicgstabStagnationWindow ?? options?.bicgstabStagnationWindow) || 64), 1),
    bicgstabStagnationRatio: Math.min(Math.max(Number(options?.v2BicgstabStagnationRatio ?? options?.bicgstabStagnationRatio) || 0.9995, 0.9), 0.999999)
  };
  const newtonOptions = {
    maxNewton: Math.max(Math.round(Number(options?.nonlinearMaxIterations ?? options?.maxNewton) || 32), 1),
    residTol: Math.max(Number(options?.residualAbsTol ?? options?.residTol) || 1e-3, 1e-12),
    residRelTol: Math.max(Number(options?.residualRelTol ?? options?.residRelTol) || 1e-4, 1e-12),
    nonlinearAcceptanceSlack: Math.min(Math.max(Number(options?.v2NonlinearAcceptanceSlack) || 0, 0), 0.02),
    cgOptions,
    lineSearchOptions: {
      reductionFactor: options?.plasticLineSearchReductionFactor,
      maxBacktracks: v2LineSearchBacktrackCount(options?.plasticLineSearchMaxBacktracks, 7),
      minStepScale: options?.plasticLineSearchMinScale,
      armijoCoefficient: options?.plasticLineSearchArmijoCoefficient ?? options?.plasticLineSearchSufficientDecreaseFactor,
      initialGravityPlasticLineSearchMaxBacktracks: v2LineSearchBacktrackCount(options?.initialGravityPlasticLineSearchMaxBacktracks, 6),
      initialGravityPlasticLineSearchMinScale: options?.initialGravityPlasticLineSearchMinScale,
      initialGravityPlasticLineSearchArmijoCoefficient: options?.initialGravityPlasticLineSearchArmijoCoefficient ?? options?.initialGravityPlasticLineSearchSufficientDecreaseFactor,
      elasticGlobalizationArmijoC1: options?.elasticGlobalizationArmijoC1,
      elasticGlobalizationMinResidualRatio: options?.elasticGlobalizationMinResidualRatio
    },
    debug: options?.gpuV2Debug === true
  };
  const history = { geostatic: [], loadSteps: [], safety: [], linearSolves: [] };
  const analysisType = options?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
  const hasSurfaceLoad = options?.hasSurfaceLoad === true || hasNonzeroVector(surfaceLoadRhsFree);

  const geostatic = await runStagedGeostaticV2({ ctx, gravityRhsFree, sigmaInitialF64, newtonOptions, options, warnings, history, onProgress });
  if (!geostatic.converged) {
    const uFree = geostatic.uFreeF64 || new Float64Array(ctx.numFree);
    return {
      converged: false,
      reason: geostatic.reason || 'v2 geostatic staging failed',
      uFreeF64: uFree,
      uFullF64: expandFreeToFull(ctx, uFree),
      pack: ctx.pack,
      diagnostics: {
        strategy: 'gpu-v2-full-plastic',
        analysisType,
        elementType: ctx.elementType,
        numFree: ctx.numFree,
        ndof: ctx.ndof,
        numElements: ctx.numElements,
        numGp: ctx.numGp,
        preconditioner,
        tangentMode: ctx.useAlgorithmicTangent === true ? 'algorithmic' : 'elastic',
        lineSearch: ctx.useLineSearch === true,
        history,
        linearSolveSummary: buildLinearSummary(history.linearSolves)
      }
    };
  }

  const gravityUFreeF64 = geostatic.uFreeF64;
  const gravityUFullF64 = geostatic.uFullF64;
  const gravitySnapshot = snapshotCurrentState(ctx, 'mf-v2-gravity-state');
  let service = { converged: true, uFreeF64: gravityUFreeF64, uFullF64: gravityUFullF64, acceptedSteps: 0, rejectedSteps: 0, lastNewton: null };
  if (hasSurfaceLoad) {
    service = await runStagedSurfaceV2({ ctx, gravityRhsFree, surfaceLoadRhsFree, initialU: gravityUFreeF64, newtonOptions, options, warnings, history, onProgress });
    if (!service.converged) {
      const uFree = service.uFreeF64 || gravityUFreeF64;
      destroyV2Snapshot(gravitySnapshot);
      return {
        converged: false,
        reason: service.reason || 'v2 surface-load staging failed',
        uFreeF64: uFree,
        uFullF64: expandFreeToFull(ctx, uFree),
        uGravityFreeF64: gravityUFreeF64,
        uGravityFullF64: gravityUFullF64,
        pack: ctx.pack,
        diagnostics: {
          strategy: 'gpu-v2-full-plastic',
          analysisType,
          elementType: ctx.elementType,
          numFree: ctx.numFree,
          ndof: ctx.ndof,
          numElements: ctx.numElements,
          numGp: ctx.numGp,
          preconditioner,
          tangentMode: ctx.useAlgorithmicTangent === true ? 'algorithmic' : 'elastic',
          lineSearch: ctx.useLineSearch === true,
          history,
          linearSolveSummary: buildLinearSummary(history.linearSolves)
        }
      };
    }
  }
  const serviceSnapshot = snapshotCurrentState(ctx, 'mf-v2-service-state');

  let safety = null;
  if (analysisType === 'safety-cphi') {
    safety = await runSafetyV2({ ctx, gravityRhsFree, surfaceLoadRhsFree, baseUFree: service.uFreeF64, regionConstitutiveByRegion, newtonOptions, options, warnings, history, onProgress });
  }

  const sigmaGravityCommittedF64 = await readDsVector(ctx, gravitySnapshot.sigma, ctx.numGp * 6, 'mf-v2-read-gravity-sigma');
  const branchGravityKind = await readU32Vector(ctx, gravitySnapshot.branch, ctx.numGp, 'mf-v2-read-gravity-branch');
  const sigmaServiceCommittedF64 = await readDsVector(ctx, serviceSnapshot.sigma, ctx.numGp * 6, 'mf-v2-read-service-sigma');
  const plasticStrainServiceCommittedF64 = await readDsVector(ctx, serviceSnapshot.plastic, ctx.numGp * 6, 'mf-v2-read-service-plastic');
  const plasticEqServiceCommittedF64 = await readDsVector(ctx, serviceSnapshot.plasticEq, ctx.numGp, 'mf-v2-read-service-plastic-eq');
  const branchServiceKind = await readU32Vector(ctx, serviceSnapshot.branch, ctx.numGp, 'mf-v2-read-service-branch');
  destroyV2Snapshot(gravitySnapshot);
  destroyV2Snapshot(serviceSnapshot);

  const activeUFreeF64 = safety?.uFreeF64 || service.uFreeF64;
  const activeUFullF64 = safety?.uFullF64 || service.uFullF64;
  const sigmaCommittedF64 = safety?.sigmaCommittedF64 || sigmaServiceCommittedF64;
  const plasticStrainCommittedF64 = safety?.plasticStrainCommittedF64 || plasticStrainServiceCommittedF64;
  const plasticEqCommittedF64 = safety?.plasticEqCommittedF64 || plasticEqServiceCommittedF64;
  const branchKind = safety?.branchKind || branchServiceKind;
  const uServiceIncrementFreeF64 = subtractVectors(service.uFreeF64, gravityUFreeF64);
  const uServiceIncrementFullF64 = expandFreeToFull(ctx, uServiceIncrementFreeF64);
  const safetyDisplayFree = safety?.uFreeF64 ? subtractVectors(safety.uFreeF64, service.uFreeF64) : null;
  const safetyDisplayFull = safetyDisplayFree ? expandFreeToFull(ctx, safetyDisplayFree) : null;
  const uDisplayFullF64 = analysisType === 'safety-cphi'
    ? (safetyDisplayFull || uServiceIncrementFullF64)
    : (hasSurfaceLoad ? uServiceIncrementFullF64 : service.uFullF64);
  const linearSolveSummary = buildLinearSummary(history.linearSolves);
  const localReturnFallbackCount = totalLocalReturnFallbacks(history);
  if (localReturnFallbackCount > 0) {
    const message = `[GPU v2] Local return mapping used fallback branches at ${localReturnFallbackCount} Gauss-point evaluations; analysis continued with sigmaReturned from the MC kernel.`;
    if (Array.isArray(warnings) && !warnings.includes(message)) warnings.push(message);
  }

  const norms = {
    gravityRhs: vectorNormF64(gravityRhsFree),
    surfaceRhs: vectorNormF64(surfaceLoadRhsFree),
    geostaticReferenceForce: vectorNormF64(geostatic.targetForceBaseF64),
    geostaticResidualTargetDelta: vectorNormF64(subtractVectors(gravityRhsFree, geostatic.targetForceBaseF64)),
    gravityU: vectorNormF64(gravityUFullF64),
    serviceU: vectorNormF64(service.uFullF64),
    activeU: vectorNormF64(activeUFullF64),
    serviceIncrementU: vectorNormF64(uServiceIncrementFullF64),
    safetyIncrementU: vectorNormF64(safetyDisplayFull),
    displayU: vectorNormF64(uDisplayFullF64),
    sigmaInitial: vectorNormF64(sigmaGravityCommittedF64),
    sigmaService: vectorNormF64(sigmaServiceCommittedF64),
    sigmaActive: vectorNormF64(sigmaCommittedF64),
    surfaceStepCount: history.loadSteps.length,
    geostaticStepCount: history.geostatic.length,
    hasSurfaceLoad: hasSurfaceLoad ? 1 : 0,
    gpuFirstGravityRhs: firstPositiveHistoryValue(history.geostatic, 'rhsNorm'),
    gpuFirstGravityResidual: firstPositiveHistoryValue(history.geostatic, 'residualNorm'),
    gpuFirstSurfaceRhs: firstPositiveHistoryValue(history.loadSteps, 'rhsNorm'),
    gpuFirstSurfaceResidual: firstPositiveHistoryValue(history.loadSteps, 'residualNorm')
  };
  if (Array.isArray(warnings) && norms.surfaceRhs > 1e-10 && norms.serviceIncrementU <= 1e-18) {
    const message = `[GPU v2] Surface-load RHS is nonzero but the committed service displacement increment is zero. Check solver.gpuDiagnostics.norms to distinguish a constrained/no-load mesh from a GPU state-update issue.`;
    if (!warnings.includes(message)) warnings.push(message);
  }
  if (Array.isArray(warnings) && norms.gravityRhs > 1e-10 && norms.sigmaActive <= 1e-18) {
    const message = `[GPU v2] Gravity RHS is nonzero but the active stress norm is zero. Check solver.gpuDiagnostics.norms; this indicates the final stress handoff did not receive a physical state.`;
    if (!warnings.includes(message)) warnings.push(message);
  }

  return {
    converged: true,
    reason: null,
    uFreeF64: activeUFreeF64,
    uFullF64: activeUFullF64,
    uDisplayFullF64,
    uGravityFreeF64: gravityUFreeF64,
    uGravityFullF64: gravityUFullF64,
    uServiceFreeF64: service.uFreeF64,
    uServiceFullF64: service.uFullF64,
    uServiceIncrementFreeF64,
    uServiceIncrementFullF64,
    uSafetyFreeF64: safety?.uFreeF64 || null,
    uSafetyFullF64: safety?.uFullF64 || null,
    sigmaInitialF64: sigmaGravityCommittedF64,
    sigmaGravityCommittedF64,
    sigmaServiceCommittedF64,
    sigmaCommittedF64,
    plasticStrainServiceCommittedF64,
    plasticEqServiceCommittedF64,
    plasticStrainCommittedF64,
    plasticEqCommittedF64,
    branchInitialKind: branchGravityKind,
    branchServiceKind,
    branchKind,
    branchCounts: branchCounts(branchKind),
    pack: ctx.pack,
    safety,
    diagnostics: {
      strategy: 'gpu-v2-full-plastic',
      analysisType,
      elementType: ctx.elementType,
      numFree: ctx.numFree,
      ndof: ctx.ndof,
      numElements: ctx.numElements,
      numGp: ctx.numGp,
      preconditioner,
      forceSolver,
      primarySolver: forceSolver || (ctx.useAlgorithmicTangent && ctx.hasNonAssociatedPlasticity ? 'bicgstab-when-plastic' : 'cg'),
      tangentMode: ctx.useAlgorithmicTangent === true ? 'algorithmic' : 'elastic',
      lineSearch: ctx.useLineSearch === true,
      branchCounts: branchCounts(branchKind),
      norms,
      geostaticAcceptedSteps: geostatic.acceptedSteps,
      geostaticRejectedSteps: geostatic.rejectedSteps,
      surfaceAcceptedSteps: service.acceptedSteps,
      surfaceRejectedSteps: service.rejectedSteps,
      gravityNewtonIters: history.geostatic.reduce((sum, item) => sum + (Number(item.iterations) || 0), 0),
      surfaceNewtonIters: history.loadSteps.reduce((sum, item) => sum + (Number(item.iterations) || 0), 0),
      safetyNewtonIters: history.safety.reduce((sum, item) => sum + (Number(item.iterations) || 0), 0),
      linearIterations: linearSolveSummary.totalIterations,
      localReturnFallbackCount,
      linearSolveHistory: history.linearSolves,
      linearSolveSummary,
      history
    }
  };
}
