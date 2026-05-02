// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GPU pipeline v2 -- modified Newton outer loop with local return mapping.
// =============================================================================
//
// Device-resident state contract:
//   u_total, u_prev, sigma_committed, b are GPU buffers.
//   Each Newton iteration records, on GPU:
//     du = u_total - u_prev
//     delta_eps = B du
//     sigma_trial = sigma_committed + D_e delta_eps
//     sigma_returned = local MC return(sigma_trial)
//     f_int = integral(B^T sigma_returned)
//     r = b - f_int
//   The matrix-free Krylov solver writes the correction into buffers.x, then
//   this loop updates u_total += x.  On convergence, sigma_returned and
//   u_total are committed for the next load step.

import { dsFromF64 } from '../wgsl/ds.js';
import {
  dispatchBuildElasticD,
  dispatchBuildPreconditioner,
  dispatchAxpy,
  dispatchDotAndRead,
  uploadInitialState,
  readUtotal,
  readBranchKind,
  readMcStats,
  recordPlasticResidual,
  recordCommitPlasticState,
  recordCopyBuffer
} from './gpu-v2-dispatch.js';
import { solveCgV2 } from './gpu-v2-cg.js';
import { solveBicgstabV2 } from './gpu-v2-bicgstab.js';

function pickPrimarySolver(ctx, plasticCount = 0) {
  if (ctx.forceSolver === 'bicgstab') return 'bicgstab';
  if (ctx.forceSolver === 'cg') return 'cg';
  if (
    ctx.useAlgorithmicTangent === true &&
    plasticCount > 0 &&
    (ctx.useUnsymmetricPlasticSolver === true || ctx.hasNonAssociatedPlasticity === true)
  ) {
    return 'bicgstab';
  }
  return 'cg';
}

function summarizeBranches(branchKind) {
  const counts = {
    elastic: 0,
    face: 0,
    edge: 0,
    apex: 0,
    tension: 0,
    plastic: 0,
    total: branchKind?.length || 0
  };
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

function finiteNonnegative(value, fallback = Infinity) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function finitePositive(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function linearResidualNorm(result) {
  return finiteNonnegative(result?.residualNorm, Infinity);
}

export function computeNonlinearTargetTolV2({
  residTol = 0,
  residRelTol = 0,
  rhsNorm = 0,
  noOpGuardNorm = 0,
  noOpGuardRatio = 0.05,
  noOpGuardMinTarget = 0
} = {}) {
  const absTarget = Math.max(Number(residTol) || 0, 0);
  const relTarget = Math.max(Number(residRelTol) || 0, 0) * Math.max(Number(rhsNorm) || 0, 0);
  const baseTarget = Math.max(absTarget, relTarget);
  const guardNorm = finitePositive(noOpGuardNorm, 0);
  if (guardNorm <= 0) return baseTarget;
  const ratio = Math.min(Math.max(Number(noOpGuardRatio) || 0.05, 1e-6), 0.95);
  const guardFloor = finitePositive(noOpGuardMinTarget, 0);
  const guardedTarget = Math.max(Number.EPSILON, guardFloor, ratio * guardNorm);
  return Math.min(baseTarget, guardedTarget);
}

function copyBuffer(ctx, src, dst, byteLength, label) {
  const enc = ctx.device.createCommandEncoder({ label });
  if (byteLength > 0) enc.copyBufferToBuffer(src, 0, dst, 0, byteLength);
  ctx.device.queue.submit([enc.finish()]);
}

function computeInexactLinearTarget({
  phaseKind,
  nonlinearResidualNorm,
  nonlinearRhsNorm,
  nonlinearTargetTol = 0,
  nonlinearAbsTol,
  linearRhsNorm = nonlinearResidualNorm,
  cgOptions
}) {
  const rhs = finiteNonnegative(linearRhsNorm, Math.max(nonlinearResidualNorm, 0));
  const base = Math.max(finiteNonnegative(nonlinearRhsNorm, 0), Number.EPSILON);
  const relativeNonlinearResidual = Math.max(nonlinearResidualNorm, 0) / base;
  const isInitialGravity = phaseKind === 'initial-gravity';
  const isLinearElastic = phaseKind === 'linear-elastic';
  const forcing = isLinearElastic
    ? 1e-8
    : Math.max(
        isInitialGravity ? 0.1 : 0.05,
        Math.min(isInitialGravity ? 0.6 : 0.4, Math.sqrt(Math.max(relativeNonlinearResidual, 0)))
      );
  const target = isLinearElastic
    ? Math.max(Number(cgOptions?.absTol) || 0, forcing * rhs)
    : Math.max(
        Number(cgOptions?.absTol) || 0,
        0.25 * Math.max(Number(nonlinearAbsTol) || 0, 0),
        forcing * rhs
      );
  const noOpGuardRatio = isInitialGravity ? 0.85 : 0.75;
  const guardedTarget = rhs > 0
    ? Math.min(target, Math.max(Number.EPSILON, noOpGuardRatio * rhs))
    : target;
  const nonlinearTarget = finitePositive(nonlinearTargetTol, 0);
  const nearNonlinearTarget = !isLinearElastic &&
    nonlinearTarget > 0 &&
    nonlinearResidualNorm <= 4 * nonlinearTarget;
  let nearTargetCap = Infinity;
  let finalTarget = guardedTarget;
  if (nearNonlinearTarget) {
    const excess = Math.max(nonlinearResidualNorm - nonlinearTarget, 0);
    const targetScaleCap = 0.02 * nonlinearTarget;
    const excessScaleCap = excess > 0 ? 0.25 * excess : targetScaleCap;
    nearTargetCap = Math.max(
      Number(cgOptions?.absTol) || 0,
      Number.EPSILON,
      Math.min(targetScaleCap, excessScaleCap)
    );
    finalTarget = Math.min(finalTarget, nearTargetCap);
  }
  return {
    target: finalTarget,
    rawTarget: target,
    targetWasCapped: finalTarget < target,
    forcing,
    linearRhsNorm: rhs,
    noOpGuardRatio,
    nonlinearTargetTol: nonlinearTarget,
    nearTargetCap: Number.isFinite(nearTargetCap) ? nearTargetCap : null
  };
}

function evaluateResidualMerit(residualNorm) {
  const r = Math.max(Number(residualNorm) || 0, 0);
  return 0.5 * r * r;
}

function approximateNewtonMeritDirectionalDerivative(residualNorm, linearizedResidualNorm = 0) {
  const residual = Math.max(Number(residualNorm) || 0, 0);
  const linearizedResidual = Math.max(Number(linearizedResidualNorm) || 0, 0);
  const effectiveDescent = Math.max(residual - linearizedResidual, 0);
  return -residual * effectiveDescent;
}

function inexactLinearAcceptance({
  phaseKind,
  nonlinearResidualNorm,
  nonlinearRhsNorm,
  nonlinearTargetTol = 0,
  nonlinearAbsTol,
  linearResult,
  cgOptions
}) {
  const residualNorm = linearResidualNorm(linearResult);
  if (!Number.isFinite(residualNorm)) {
    return { accepted: false, target: 0, forcing: 0, residualNorm };
  }
  const target = computeInexactLinearTarget({
    phaseKind,
    nonlinearResidualNorm,
    nonlinearRhsNorm,
    nonlinearTargetTol,
    nonlinearAbsTol,
    linearRhsNorm: finiteNonnegative(linearResult?.rhsNorm, Math.max(nonlinearResidualNorm, 0)),
    cgOptions
  });
  return { accepted: residualNorm <= target.target, residualNorm, ...target };
}

function nonlinearZeroResidualTolerance(bNorm) {
  return Math.max(1e-14, 1e-12 * Math.max(Number(bNorm) || 0, 1));
}

function relaxedNonlinearTarget(targetTol, acceptanceSlack = 0) {
  const target = Math.max(Number(targetTol) || 0, 0);
  const slack = Math.min(Math.max(Number(acceptanceSlack) || 0, 0), 0.02);
  return target * (1 + slack);
}

function canAcceptNonlinearResidual({
  iter,
  residualNorm,
  targetTol,
  bNorm,
  acceptanceSlack = 0,
  requireProgressBeforeAccept = false
}) {
  const strict = residualNorm <= targetTol;
  const relaxed = !strict && iter > 0 && residualNorm <= relaxedNonlinearTarget(targetTol, acceptanceSlack);
  if (!strict && !relaxed) return false;

  const zeroTol = nonlinearZeroResidualTolerance(bNorm);
  if (residualNorm <= zeroTol) return true;

  // Do not allow a loose absolute tolerance to declare success before the
  // first correction has done any work.  This is especially important for
  // staged service loading, where the total RHS can be dominated by the
  // already-balanced gravity force while the incremental surface residual is
  // still physically meaningful.
  if (requireProgressBeforeAccept && iter === 0 && bNorm > zeroTol) return false;

  return true;
}

function resolveLineSearchOptions(options = {}, phaseKind = 'service-load', usingAlgorithmicTangent = true) {
  const isInitialGravity = phaseKind === 'initial-gravity';
  const reductionFactor = Number(options?.reductionFactor ?? options?.plasticLineSearchReductionFactor) || 0.5;
  const maxBacktracks = Math.max(
    Math.round(Number(
      isInitialGravity
        ? (options?.initialGravityPlasticLineSearchMaxBacktracks ?? options?.maxBacktracks)
        : (options?.plasticLineSearchMaxBacktracks ?? options?.maxBacktracks)
    ) || (isInitialGravity ? 5 : 4)),
    1
  );
  const minStepScale = Number(
    isInitialGravity
      ? (options?.initialGravityPlasticLineSearchMinScale ?? options?.minStepScale)
      : (options?.plasticLineSearchMinScale ?? options?.minStepScale)
  ) || (isInitialGravity ? 1 / 32 : 1 / 64);
  const plasticArmijo = Number(
    isInitialGravity
      ? (
          options?.initialGravityPlasticLineSearchArmijoCoefficient ??
          options?.initialGravityPlasticLineSearchSufficientDecreaseFactor ??
          options?.armijoCoefficient
        )
      : (
          options?.plasticLineSearchArmijoCoefficient ??
          options?.plasticLineSearchSufficientDecreaseFactor ??
          options?.armijoCoefficient
        )
  ) || 1e-4;
  const elasticArmijo = Math.max(Number(options?.elasticGlobalizationArmijoC1) || 1e-3, 0);
  const elasticMinResidualRatio = Math.min(Math.max(Number(options?.elasticGlobalizationMinResidualRatio) || 0.90, 1e-6), 0.999);
  return {
    reductionFactor,
    maxBacktracks,
    minStepScale,
    armijoCoefficient: usingAlgorithmicTangent ? plasticArmijo : elasticArmijo,
    minResidualRatio: usingAlgorithmicTangent ? options?.minResidualRatio : elasticMinResidualRatio
  };
}

async function solveLinearWithFallback(ctx, rhsBuf, primarySolver, cgOptions, debug) {
  const history = [];
  let selectedHistoryIndex = 0;
  // The Newton residual buffer (`buffers.r`) is also the Krylov residual
  // workspace. Preserve the linear RHS in a dedicated GPU buffer so periodic
  // true-residual recomputes and fallback solvers always see the original RHS.
  const immutableRhsBuf = ctx.buffers.linearRhs || rhsBuf;
  if (immutableRhsBuf !== rhsBuf) {
    copyBuffer(ctx, rhsBuf, immutableRhsBuf, ctx.numFree * 8, 'mf-linear-save-rhs');
  }
  const run = async (solverName, fallbackFrom = '') => {
    const result = solverName === 'bicgstab'
      ? await solveBicgstabV2(ctx, { rhsBuf: immutableRhsBuf, ...cgOptions, debug })
      : await solveCgV2(ctx, { rhsBuf: immutableRhsBuf, ...cgOptions, debug });
    history.push({
      solver: solverName,
      path: `gpu-v2-${solverName}`,
      preconditioner: ctx.preconditioner,
      iterations: Math.max(Math.round(Number(result?.iterations) || 0), 0),
      residualNorm: Number(result?.residualNorm) || 0,
      rhsNorm: Number(result?.rhsNorm) || 0,
      toleranceTarget: Number(result?.targetTol) || 0,
      rawToleranceTarget: Number(result?.rawTargetTol ?? result?.targetTol) || 0,
      toleranceTargetWasCapped: result?.targetWasCapped === true,
      strictToleranceTarget: Number(result?.strictTargetTol ?? result?.targetTol) || 0,
      effectiveToleranceTarget: Number(result?.targetTol) || 0,
      convergedStrict: result?.convergedStrict === true,
      converged: result?.converged === true,
      stopReason: result?.stopReason || '',
      fallbackFrom
    });
    return result;
  };

  const primary = await run(primarySolver);
  if (primary?.converged || primarySolver === 'bicgstab') {
    history[0].selected = true;
    return {
      converged: primary?.converged === true,
      result: primary,
      solverName: primarySolver,
      usedFallback: false,
      selectedHistoryIndex,
      history
    };
  }

  copyBuffer(ctx, ctx.buffers.x, ctx.buffers.xCandidate, ctx.numFree * 8, 'mf-linear-save-primary-x');
  const fallback = await run('bicgstab', primarySolver);
  selectedHistoryIndex = 1;
  let selectedResult = fallback;
  let selectedSolver = 'bicgstab';
  let selectedUsedFallback = true;
  const primaryResidual = linearResidualNorm(primary);
  const fallbackResidual = linearResidualNorm(fallback);
  if (!fallback?.converged && primaryResidual <= fallbackResidual) {
    copyBuffer(ctx, ctx.buffers.xCandidate, ctx.buffers.x, ctx.numFree * 8, 'mf-linear-restore-primary-x');
    selectedHistoryIndex = 0;
    selectedResult = primary;
    selectedSolver = primarySolver;
    selectedUsedFallback = false;
  }
  history[selectedHistoryIndex].selected = true;
  return {
    converged: selectedResult?.converged === true,
    result: selectedResult,
    solverName: selectedSolver,
    usedFallback: selectedUsedFallback,
    selectedHistoryIndex,
    history
  };
}

function expandFreeToFull(ctx, uFreeF64) {
  const uFullF64 = new Float64Array(ctx.ndof);
  for (let i = 0; i < ctx.numFree; i += 1) {
    uFullF64[ctx.pack.freeDofs[i]] = uFreeF64[i] || 0;
  }
  return uFullF64;
}

async function restoreLineSearchBase(ctx) {
  const enc = ctx.device.createCommandEncoder({ label: 'mf-newton-line-restore-u' });
  recordCopyBuffer(ctx, enc, ctx.buffers.uCandidate, ctx.buffers.utotal, ctx.numFree * 8);
  ctx.device.queue.submit([enc.finish()]);
}

async function evaluateLineSearchCandidate(ctx, alpha, targetTol, { readStats = false } = {}) {
  const { device, buffers, uniforms, numFree, helpers } = ctx;
  {
    const enc = device.createCommandEncoder({ label: 'mf-newton-line-candidate' });
    recordCopyBuffer(ctx, enc, buffers.uCandidate, buffers.utotal, numFree * 8);
    helpers.writeAxpyParams(uniforms.axpyAlpha, dsFromF64(alpha), numFree);
    dispatchAxpy(ctx, enc, uniforms.axpyAlpha, buffers.x, buffers.utotal);
    recordPlasticResidual(ctx, enc);
    device.queue.submit([enc.finish()]);
  }
  const resNormSq = await dispatchDotAndRead(ctx, buffers.r, buffers.r);
  const residualNorm = Math.sqrt(Math.max(resNormSq, 0));
  const stats = readStats ? await readMcStats(ctx) : null;
  const failedLocalReturns = Number(stats?.failed) || 0;
  return {
    alpha,
    residualNorm,
    converged: residualNorm <= targetTol,
    failedLocalReturns,
    plasticCount: Number(stats?.plastic) || 0
  };
}

async function applyCorrectionWithLineSearch(ctx, {
  previousResidualNorm,
  linearizedResidualNorm = 0,
  targetTol,
  nonlinearAcceptanceSlack = 0,
  lineSearchOptions = {},
  debug = false
}) {
  const { device, buffers, numFree } = ctx;
  const log = debug ? (msg) => console.log(`[v2-line-search] ${msg}`) : () => {};
  {
    const enc = device.createCommandEncoder({ label: 'mf-newton-line-save-u' });
    recordCopyBuffer(ctx, enc, buffers.utotal, buffers.uCandidate, numFree * 8);
    device.queue.submit([enc.finish()]);
  }

  let best = null;
  const base = Math.max(Number(previousResidualNorm) || 0, 0);
  const reductionFactor = Math.min(Math.max(Number(lineSearchOptions?.reductionFactor) || 0.5, 0.1), 0.95);
  const minStepScale = Math.min(Math.max(Number(lineSearchOptions?.minStepScale) || (1 / 64), 1e-4), 1);
  const maxTrials = Math.max(Math.round(Number(lineSearchOptions?.maxBacktracks) || 6), 1);
  const armijoCoefficient = Math.max(Number(lineSearchOptions?.armijoCoefficient) || 1e-4, 0);
  const minResidualRatio = Number(lineSearchOptions?.minResidualRatio);
  const requiresResidualImprovement = Number.isFinite(minResidualRatio) && minResidualRatio > 0 && minResidualRatio < 1;
  const currentMerit = evaluateResidualMerit(base);
  const directionalDerivative = approximateNewtonMeritDirectionalDerivative(base, linearizedResidualNorm);
  const relaxedTarget = relaxedNonlinearTarget(targetTol, nonlinearAcceptanceSlack);
  const minActualDecrease = Math.max(
    1e-12,
    1e-10 * Math.max(base, targetTol, 1)
  );
  let alpha = 1;
  for (let trial = 0; trial < maxTrials; trial += 1) {
    const candidate = await evaluateLineSearchCandidate(ctx, alpha, targetTol, { readStats: true });
    if (!best || candidate.residualNorm < best.residualNorm) best = candidate;
    const candidateMerit = evaluateResidualMerit(candidate.residualNorm);
    const armijoTarget = currentMerit + armijoCoefficient * alpha * Math.min(directionalDerivative, 0);
    const residualImprovementAccepted = !requiresResidualImprovement ||
      candidate.residualNorm <= minResidualRatio * base ||
      alpha <= minStepScale + 1e-12;
    const localReturnOk = candidate.failedLocalReturns === 0;
    const withinRelaxedTarget = candidate.residualNorm <= relaxedTarget;
    const hasActualDecrease = candidate.residualNorm < base - minActualDecrease;
    const convergedWithProgress = candidate.converged && (
      hasActualDecrease ||
      candidate.residualNorm <= nonlinearZeroResidualTolerance(base)
    );
    const accepted = localReturnOk && (
      convergedWithProgress ||
      (hasActualDecrease && (
        withinRelaxedTarget ||
        (candidateMerit <= Math.max(armijoTarget, 0) && residualImprovementAccepted)
      ))
    );
    if (accepted) {
      log(`accepted alpha=${alpha.toExponential(3)} residual=${candidate.residualNorm.toExponential(3)} previous=${base.toExponential(3)}`);
      return {
        accepted: true,
        ...candidate,
        trials: trial + 1,
        currentMerit,
        candidateMerit,
        armijoTarget,
        directionalDerivative,
        residualImprovementAccepted,
        withinRelaxedTarget,
        hasActualDecrease
      };
    }
    log(`reject alpha=${alpha.toExponential(3)} residual=${candidate.residualNorm.toExponential(3)} previous=${base.toExponential(3)} failedLocalReturns=${candidate.failedLocalReturns}`);
    if (alpha <= minStepScale + 1e-12) break;
    alpha = Math.max(alpha * reductionFactor, minStepScale);
  }

  await restoreLineSearchBase(ctx);
  return { accepted: false, ...(best || {}), trials: maxTrials, currentMerit, directionalDerivative };
}

export async function runPlasticNewtonOnGpuV2(ctx, {
  bF64,
  sigmaInitialF64 = null,
  u0F64 = null,
  maxNewton = 50,
  residTol = 1e-7,
  residRelTol = 1e-7,
  nonlinearAcceptanceSlack = 0,
  cgOptions = { maxIter: 5000, relTol: 1e-10, absTol: 1e-12 },
  lineSearchOptions = {},
  phaseKind = 'service-load',
  nonlinearNoOpGuardNorm = 0,
  nonlinearNoOpGuardRatio = 0.05,
  debug = false
} = {}) {
  const { device, buffers, uniforms, numFree, helpers } = ctx;
  const log = debug ? (msg) => console.log(`[v2-newton] ${msg}`) : () => {};

  if (!bF64 || bF64.length !== numFree) {
    throw new Error(`runPlasticNewtonOnGpuV2: bF64 length ${bF64?.length || 0} != numFree ${numFree}`);
  }

  await uploadInitialState(ctx, {
    uF64: u0F64,
    sigmaCommittedF64: sigmaInitialF64,
    bF64,
    preserveSigmaCommitted: sigmaInitialF64 == null
  });

  {
    const enc = device.createCommandEncoder({ label: 'mf-newton-precompute' });
    dispatchBuildElasticD(ctx, enc);
    if (ctx.useAlgorithmicTangent !== true) {
      dispatchBuildPreconditioner(ctx, enc);
    }
    device.queue.submit([enc.finish()]);
  }

  const bNormSq = await dispatchDotAndRead(ctx, buffers.b, buffers.b);
  const bNorm = Math.sqrt(Math.max(bNormSq, 0));
  const targetTol = computeNonlinearTargetTolV2({
    residTol,
    residRelTol,
    rhsNorm: bNorm,
    noOpGuardNorm: nonlinearNoOpGuardNorm,
    noOpGuardRatio: nonlinearNoOpGuardRatio,
    noOpGuardMinTarget: cgOptions?.absTol
  });

  const residualNorms = [];
  const linearSolveHistory = [];
  const localReturnFallbacks = [];
  const requireProgressBeforeAccept = finitePositive(nonlinearNoOpGuardNorm, 0) > 0;
  let linearIterations = 0;
  let lineSearchEvaluations = 0;
  let minAcceptedLineSearchAlpha = 1;
  let lastAcceptedLineSearchAlpha = 1;
  let solverName = pickPrimarySolver(ctx, 0);
  let usedFallback = false;
  let residualNorm = Infinity;
  let branchKind = new Uint32Array(ctx.numGp);

  log(`start: numFree=${numFree} bNorm=${bNorm.toExponential(3)} target=${targetTol.toExponential(3)} solver=${solverName} preconditioner=${ctx.preconditioner} tangent=${ctx.useAlgorithmicTangent === true ? 'algorithmic' : 'elastic'}`);

  for (let iter = 0; iter < maxNewton; iter += 1) {
    {
      const enc = device.createCommandEncoder({ label: `mf-newton-residual-${iter}` });
      recordPlasticResidual(ctx, enc);
      if (ctx.useAlgorithmicTangent === true) {
        dispatchBuildPreconditioner(ctx, enc);
      }
      device.queue.submit([enc.finish()]);
    }

    const mcStats = await readMcStats(ctx);
    const failedLocalReturns = Number(mcStats.failed) || 0;
    const plasticCount = Number(mcStats.plastic) || 0;
    if (failedLocalReturns > 0) {
      localReturnFallbacks.push({ iter, count: failedLocalReturns });
      log(`iter ${iter}: ${failedLocalReturns} local return(s) failed`);
    }

    const resNormSq = await dispatchDotAndRead(ctx, buffers.r, buffers.r);
    residualNorm = Math.sqrt(Math.max(resNormSq, 0));
    residualNorms.push(residualNorm);
    log(`iter ${iter}: residual=${residualNorm.toExponential(3)} target=${targetTol.toExponential(3)}`);

    if (failedLocalReturns > 0) {
      const uFreeF64 = await readUtotal(ctx);
      branchKind = await readBranchKind(ctx);
      return {
        converged: false,
        reason: `local return mapping failed at ${failedLocalReturns} Gauss point(s) during Newton iter ${iter}`,
        iterations: iter + 1,
        cgIterations: linearIterations,
        linearIterations,
        residualNorm,
        rhsNorm: bNorm,
        targetTol,
        residualNorms,
        solverName,
        usedFallback,
        linearSolveHistory,
        localReturnFallbacks,
        lineSearchEvaluations,
        minAcceptedLineSearchAlpha,
        lastAcceptedLineSearchAlpha,
        branchKind,
        branchCounts: summarizeBranches(branchKind),
        uFreeF64,
        uFullF64: expandFreeToFull(ctx, uFreeF64),
        pack: ctx.pack
      };
    }

    if (iter === 0 && bNorm > Math.max(targetTol, 1e-12) && residualNorm <= targetTol) {
      const fIntNormSq = await dispatchDotAndRead(ctx, ctx.buffers.fInt, ctx.buffers.fInt);
      const fIntNorm = Math.sqrt(Math.max(fIntNormSq, 0));
      if (fIntNorm <= Math.max(1e-18, 1e-12 * bNorm)) {
        const uFreeF64 = await readUtotal(ctx);
        return {
          converged: false,
          reason: `GPU v2 residual assembly produced zero residual and zero internal force for nonzero RHS (|b|=${bNorm.toExponential(3)}). This indicates a WebGPU kernel dispatch/state issue, not physical convergence.`,
          iterations: iter + 1,
          cgIterations: linearIterations,
          linearIterations,
          residualNorm,
          rhsNorm: bNorm,
          targetTol,
          residualNorms,
          solverName,
          usedFallback,
          linearSolveHistory,
          localReturnFallbacks,
          branchKind,
          branchCounts: summarizeBranches(branchKind),
          uFreeF64,
          uFullF64: expandFreeToFull(ctx, uFreeF64),
          pack: ctx.pack
        };
      }
    }

    if (canAcceptNonlinearResidual({ iter, residualNorm, targetTol, bNorm, acceptanceSlack: nonlinearAcceptanceSlack, requireProgressBeforeAccept })) {
      const enc = device.createCommandEncoder({ label: 'mf-newton-commit' });
      recordCommitPlasticState(ctx, enc);
      device.queue.submit([enc.finish()]);
      branchKind = await readBranchKind(ctx);
      const uFreeF64 = await readUtotal(ctx);
      return {
        converged: true,
        reason: null,
        iterations: iter + 1,
        cgIterations: linearIterations,
        linearIterations,
        residualNorm,
        rhsNorm: bNorm,
        targetTol,
        residualNorms,
        solverName,
        usedFallback,
        linearSolveHistory,
        localReturnFallbacks,
        lineSearchEvaluations,
        minAcceptedLineSearchAlpha,
        lastAcceptedLineSearchAlpha,
        branchKind,
        branchCounts: summarizeBranches(branchKind),
        uFreeF64,
        uFullF64: expandFreeToFull(ctx, uFreeF64),
        pack: ctx.pack
      };
    }

    const primarySolver = pickPrimarySolver(ctx, plasticCount);
    const inexactTarget = computeInexactLinearTarget({
      phaseKind,
      nonlinearResidualNorm: residualNorm,
      nonlinearRhsNorm: bNorm,
      nonlinearTargetTol: targetTol,
      nonlinearAbsTol: residTol,
      linearRhsNorm: residualNorm,
      cgOptions
    });
    const linearOptions = {
      ...cgOptions,
      targetTol: inexactTarget.target,
      stagnationWindow: ctx.useAlgorithmicTangent === true ? 12 : 24,
      stopOnNonPositiveCurvature: true
    };
    const linear = await solveLinearWithFallback(ctx, buffers.r, primarySolver, linearOptions, debug);
    solverName = linear.solverName;
    usedFallback = usedFallback || linear.usedFallback;
    const selected = linear.history?.[linear.selectedHistoryIndex];
    const selectedResidual = linearResidualNorm(linear.result);
    const strictTarget = Number(linear.result?.strictTargetTol ?? linear.result?.targetTol) || 0;
    const inexact = !linear.converged
      ? inexactLinearAcceptance({
          phaseKind,
          nonlinearResidualNorm: residualNorm,
          nonlinearRhsNorm: bNorm,
          nonlinearTargetTol: targetTol,
          nonlinearAbsTol: residTol,
          linearResult: linear.result,
          cgOptions
        })
      : {
          accepted: selectedResidual > strictTarget && selectedResidual <= inexactTarget.target,
          target: inexactTarget.target,
          rawTarget: inexactTarget.rawTarget,
          targetWasCapped: inexactTarget.targetWasCapped,
          noOpGuardRatio: inexactTarget.noOpGuardRatio,
          forcing: inexactTarget.forcing,
          nearTargetCap: inexactTarget.nearTargetCap,
          nonlinearTargetTol: inexactTarget.nonlinearTargetTol,
          residualNorm: selectedResidual
        };
    if (inexact.accepted && selected) {
      selected.acceptedInexact = true;
      selected.inexactTarget = inexact.target;
      selected.rawInexactTarget = inexact.rawTarget;
      selected.inexactTargetWasCapped = inexact.targetWasCapped === true;
      selected.inexactNoOpGuardRatio = inexact.noOpGuardRatio;
      selected.inexactForcing = inexact.forcing;
      selected.inexactNearTargetCap = inexact.nearTargetCap;
      selected.nonlinearTargetTol = inexact.nonlinearTargetTol;
      log(`iter ${iter}: accepted inexact ${solverName} correction residual=${inexact.residualNorm.toExponential(3)} target=${inexact.target.toExponential(3)} forcing=${inexact.forcing.toExponential(3)}`);
    }
    linearSolveHistory.push(...linear.history);
    const iters = linear.history.reduce((sum, item) => sum + (Number(item.iterations) || 0), 0);
    linearIterations += iters;
    if (!linear.converged && !inexact.accepted) {
      const uFreeF64 = await readUtotal(ctx);
      branchKind = await readBranchKind(ctx);
      const bestResidual = linearResidualNorm(linear.result);
      const linearTarget = Number(linear.result?.targetTol) || 0;
      return {
        converged: false,
        reason: `linear solver failed to converge at Newton iter ${iter} (best ${solverName} residual ${Number.isFinite(bestResidual) ? bestResidual.toExponential(3) : 'non-finite'}, Krylov target ${linearTarget.toExponential(3)}, inexact target ${inexact.target.toExponential(3)})`,
        iterations: iter + 1,
        cgIterations: linearIterations,
        linearIterations,
        residualNorm,
        rhsNorm: bNorm,
        targetTol,
        residualNorms,
        solverName,
        usedFallback,
        linearSolveHistory,
        localReturnFallbacks,
        lineSearchEvaluations,
        minAcceptedLineSearchAlpha,
        lastAcceptedLineSearchAlpha,
        branchKind,
        branchCounts: summarizeBranches(branchKind),
        uFreeF64,
        uFullF64: expandFreeToFull(ctx, uFreeF64),
        pack: ctx.pack
      };
    }

    const shouldUsePlasticLineSearch = ctx.useLineSearch === true && plasticCount > 0;
    if (shouldUsePlasticLineSearch) {
      const line = await applyCorrectionWithLineSearch(ctx, {
        previousResidualNorm: residualNorm,
        linearizedResidualNorm: selectedResidual,
        targetTol,
        nonlinearAcceptanceSlack,
        lineSearchOptions: resolveLineSearchOptions(lineSearchOptions, phaseKind, ctx.useAlgorithmicTangent === true),
        debug
      });
      lineSearchEvaluations += Math.max(Math.round(Number(line.trials) || 0), 0);
      if (!line.accepted) {
        const uFreeF64 = await readUtotal(ctx);
        branchKind = await readBranchKind(ctx);
        return {
          converged: false,
          reason: `line search failed at Newton iter ${iter} (best residual ${finiteNonnegative(line.residualNorm, Infinity).toExponential(3)}, previous ${residualNorm.toExponential(3)}, failed local returns ${Number(line.failedLocalReturns) || 0})`,
          iterations: iter + 1,
          cgIterations: linearIterations,
          linearIterations,
          residualNorm,
          rhsNorm: bNorm,
          targetTol,
          residualNorms,
          solverName,
          usedFallback,
          linearSolveHistory,
          localReturnFallbacks,
          lineSearchEvaluations,
          minAcceptedLineSearchAlpha,
          lastAcceptedLineSearchAlpha,
          branchKind,
          branchCounts: summarizeBranches(branchKind),
          uFreeF64,
          uFullF64: expandFreeToFull(ctx, uFreeF64),
          pack: ctx.pack
        };
      }
      if (line.failedLocalReturns > 0) {
        localReturnFallbacks.push({ iter, count: line.failedLocalReturns, lineSearch: true });
      }
      minAcceptedLineSearchAlpha = Math.min(minAcceptedLineSearchAlpha, Math.max(Number(line.alpha) || 0, 0));
      lastAcceptedLineSearchAlpha = Math.max(Number(line.alpha) || 0, 0);
      if (canAcceptNonlinearResidual({
        iter: iter + 1,
        residualNorm: finiteNonnegative(line.residualNorm, Infinity),
        targetTol,
        bNorm,
        acceptanceSlack: nonlinearAcceptanceSlack,
        requireProgressBeforeAccept
      })) {
        const enc = device.createCommandEncoder({ label: 'mf-newton-line-commit' });
        recordCommitPlasticState(ctx, enc);
        device.queue.submit([enc.finish()]);
        branchKind = await readBranchKind(ctx);
        const uFreeF64 = await readUtotal(ctx);
        residualNorms.push(line.residualNorm);
        return {
          converged: true,
          reason: null,
          iterations: iter + 1,
          cgIterations: linearIterations,
          linearIterations,
          residualNorm: line.residualNorm,
          rhsNorm: bNorm,
          targetTol,
          residualNorms,
          solverName,
          usedFallback,
          linearSolveHistory,
          localReturnFallbacks,
          lineSearchEvaluations,
          minAcceptedLineSearchAlpha,
          lastAcceptedLineSearchAlpha,
          branchKind,
          branchCounts: summarizeBranches(branchKind),
          uFreeF64,
          uFullF64: expandFreeToFull(ctx, uFreeF64),
          pack: ctx.pack
        };
      }
    } else {
      const enc = device.createCommandEncoder({ label: 'mf-newton-update-u' });
      helpers.writeAxpyParams(uniforms.axpyOne, dsFromF64(1), numFree);
      dispatchAxpy(ctx, enc, uniforms.axpyOne, buffers.x, buffers.utotal);
      device.queue.submit([enc.finish()]);
    }
  }

  const uFreeF64 = await readUtotal(ctx);
  branchKind = await readBranchKind(ctx);
  const finiteResiduals = residualNorms.filter((value) => Number.isFinite(value));
  const firstResidual = finiteResiduals.length > 0 ? finiteResiduals[0] : residualNorm;
  const bestResidual = finiteResiduals.length > 0 ? Math.min(...finiteResiduals) : residualNorm;
  const finalResidual = finiteResiduals.length > 0 ? finiteResiduals[finiteResiduals.length - 1] : residualNorm;
  return {
    converged: false,
    reason: `Newton did not converge within maxNewton (first residual ${Number.isFinite(firstResidual) ? firstResidual.toExponential(3) : 'non-finite'}, best ${Number.isFinite(bestResidual) ? bestResidual.toExponential(3) : 'non-finite'}, final ${Number.isFinite(finalResidual) ? finalResidual.toExponential(3) : 'non-finite'}, target ${targetTol.toExponential(3)}, tangent ${ctx.useAlgorithmicTangent === true ? 'algorithmic' : 'elastic'})`,
    iterations: maxNewton,
    cgIterations: linearIterations,
    linearIterations,
    residualNorm,
    rhsNorm: bNorm,
    targetTol,
    residualNorms,
    solverName,
    usedFallback,
    linearSolveHistory,
    localReturnFallbacks,
    lineSearchEvaluations,
    minAcceptedLineSearchAlpha,
    lastAcceptedLineSearchAlpha,
    branchKind,
    branchCounts: summarizeBranches(branchKind),
    uFreeF64,
    uFullF64: expandFreeToFull(ctx, uFreeF64),
    pack: ctx.pack
  };
}
