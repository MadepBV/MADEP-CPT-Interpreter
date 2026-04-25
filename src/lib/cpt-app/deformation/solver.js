// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { pointInPolygonHalfOpen } from '../soil-regions.js';
import { buildDeformationMesh } from './mesh.js';
import { triangleArea } from './element-t3.js';
import { elementKernelFor, normalizeElementType } from './element-kernel.js';
import { shapeFunctionsT6 } from './element-t6.js';
import {
  cloneMaterialPointState,
  createLinearElasticMaterial,
  createMCPlasticMaterial,
  createMCReducedStiffnessMaterial,
  createMaterialPoint,
  commitMaterialPoint,
  effectiveStress6ToCompressionPositiveStress3D,
  extractStress2DFrom6,
  extractTangent2DFrom6,
  liftPlaneStrainStrainTo6,
  setMaterialPointReferenceState,
  seedMaterialPointStateFromEffectiveStress6,
  seedMaterialPointStateFromInitialStress,
  snapshotMaterialPointState,
} from './material-models.js';
import { prepareMechanicalMaterial, reduceMaterialStrengthForSafety } from './material.js';
import {
  buildFlatK0InitialEffectiveStressFieldAtPoints,
  initialBulkUnitWeightFromPorePressure,
  mohrCoulombIndicator,
  negateNormalAndShear,
  principalStress2DCompressionPositive,
  sampleInitialPorePressure
} from './post.js';
import { createLinearAlgebraBackend, GPU_DEFAULT_MIN_DOF } from './gpu/index.js';

// Residual-refresh cadence: after every BACKEND_RESIDUAL_REFRESH_INTERVAL
// Krylov iterations a mixed-precision backend triggers a CPU f64 recompute
// of r = rhs - A*x to reset accumulated f32 roundoff. Matches the
// CG_CHECKPOINT_INTERVAL cadence by construction.
const BACKEND_RESIDUAL_REFRESH_INTERVAL = 25;

const CG_REL_TOL = 1e-5;
const CG_ABS_TOL = 5e-5;
const CG_NUMERIC_EPS = 1e-14;
const CG_CHECKPOINT_INTERVAL = 25;
const GEOSTATIC_CG_PROGRESS_INTERVAL = 100;
const MAX_CG_ITER = 25000;
const BICGSTAB_CHECKPOINT_INTERVAL = 20;
const GMRES_RESTART = 40;
const GMRES_CHECKPOINT_INTERVAL = 20;
const NONLINEAR_LINEAR_PROGRESS_INTERVAL = 200;
const GEOM_EPS = 1e-6;
const NONLINEAR_RESIDUAL_REL_TOL = 1e-4;
const NONLINEAR_RESIDUAL_ABS_TOL = 1e-3;
const NONLINEAR_DISPLACEMENT_REL_TOL = 1e-5;
const NONLINEAR_DISPLACEMENT_ABS_TOL = 1e-8;
const NONLINEAR_MAX_ITER = 24;
const NONLINEAR_INITIAL_LOAD_STEP = 0.25;
const NONLINEAR_MIN_LOAD_STEP = 1 / 2048;
const NONLINEAR_GROWTH_FACTOR = 1.25;
const NONLINEAR_CUTBACK_FACTOR = 0.5;
const NONLINEAR_MAX_LOAD_STEPS = 256;
const NONLINEAR_CONTINUATION_TARGET_ITERATIONS = 6;
const NONLINEAR_CONTINUATION_TARGET_LINE_SEARCH_SCALE = 0.9;
const NONLINEAR_CONTINUATION_ITERATION_EXPONENT = 0.5;
const NONLINEAR_CONTINUATION_LINE_SEARCH_EXPONENT = 0.25;
const SAFETY_INITIAL_SIGMA_MSF_INCREMENT = 0.1;
const SAFETY_SIGMA_MSF_GROWTH_FACTOR = 1.5;
const SAFETY_SIGMA_MSF_MAX = 3.0;
const SAFETY_SIGMA_MSF_BRACKET_TOL = 0.01;
const SAFETY_MAX_SEARCH_TRIALS = 32;

function pushUniqueWarning(warnings, message) {
  if (!Array.isArray(warnings) || !message) return;
  if (!warnings.includes(message)) warnings.push(message);
}

function isStopRequested(runControl) {
  return typeof runControl?.shouldStop === 'function' ? !!runControl.shouldStop() : false;
}

async function runCheckpoint(runControl, force = false) {
  if (typeof runControl?.checkpoint === 'function') {
    return !!(await runControl.checkpoint({ force }));
  }
  return isStopRequested(runControl);
}

function dot(a, b) {
  let sum = 0;
  let compensation = 0;
  for (let i = 0; i < a.length; i += 1) {
    const term = a[i] * b[i];
    const corrected = term - compensation;
    const next = sum + corrected;
    compensation = (next - sum) - corrected;
    sum = next;
  }
  return sum;
}

function vectorNorm(vector) {
  return Math.sqrt(dot(vector, vector));
}

function addScaledVectorInPlace(target, source, scale = 1) {
  for (let i = 0; i < target.length; i += 1) target[i] += (Number(source?.[i]) || 0) * scale;
}

function cloneScaledVector(vector, scale = 1) {
  const out = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = (Number(vector[i]) || 0) * scale;
  return out;
}

function copyVectorInto(target, source) {
  for (let i = 0; i < target.length; i += 1) target[i] = Number(source?.[i]) || 0;
}

function addSolutionVectors(left, right) {
  const size = Math.max(left?.length || 0, right?.length || 0);
  const out = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    out[i] = (Number(left?.[i]) || 0) + (Number(right?.[i]) || 0);
  }
  return out;
}

function subtractSolutionVectors(left, right) {
  const size = Math.max(left?.length || 0, right?.length || 0);
  const out = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    out[i] = (Number(left?.[i]) || 0) - (Number(right?.[i]) || 0);
  }
  return out;
}

function interpolateVectorFields(start, end, factor = 1) {
  const size = Math.max(start?.length || 0, end?.length || 0);
  const clampedFactor = Math.max(0, Math.min(Number(factor) || 0, 1));
  const out = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    const startValue = Number(start?.[i]) || 0;
    const endValue = Number(end?.[i]) || 0;
    out[i] = startValue + clampedFactor * (endValue - startValue);
  }
  return out;
}

function cloneMaterialParameters(materialParameters) {
  return materialParameters && typeof materialParameters === 'object'
    ? { ...materialParameters }
    : null;
}

function cloneMaterialPoint(materialPoint) {
  if (!materialPoint) return null;
  return {
    ...materialPoint,
    materialParameters: cloneMaterialParameters(materialPoint.materialParameters),
    predictorState: cloneMaterialPointState(materialPoint.predictorState),
    referenceState: cloneMaterialPointState(materialPoint.referenceState),
    committedState: cloneMaterialPointState(materialPoint.committedState),
    trialState: cloneMaterialPointState(materialPoint.trialState),
    diagnostics: materialPoint.diagnostics && typeof materialPoint.diagnostics === 'object'
      ? { ...materialPoint.diagnostics }
      : null
  };
}

function cloneMaterialPointCollection(materialPoints) {
  return (materialPoints || []).map((materialPoint) => cloneMaterialPoint(materialPoint));
}

function createMaterialPointCheckpoint(materialPoints, solution, metadata = {}) {
  return {
    materialPoints: cloneMaterialPointCollection(materialPoints),
    solution: Float64Array.from(solution || []),
    sigmaMsf: Math.max(Number(metadata?.sigmaMsf) || 1, 1),
    label: metadata?.label || ''
  };
}

function createSafetyDisplayPhaseFromCheckpoint(checkpoint, metadata = {}) {
  const sigmaMsf = Math.max(Number(metadata?.sigmaMsf ?? checkpoint?.sigmaMsf) || 1, 1);
  return {
    phaseKind: 'safety-cphi',
    formulationMode: 'total',
    solution: Float64Array.from(checkpoint?.solution || []),
    materialPoints: cloneMaterialPointCollection(checkpoint?.materialPoints),
    sigmaMsfStart: sigmaMsf,
    sigmaMsfTarget: sigmaMsf,
    sigmaMsfCommitted: sigmaMsf,
    sigmaMsfDisplayed: sigmaMsf,
    acceptedSteps: 0,
    rejectedSteps: 0,
    totalNonlinearIterations: 0,
    totalCgIterations: 0,
    residualNorm: 0,
    relativeResidualNorm: 0,
    displacementCorrectionNorm: 0,
    relativeDisplacementCorrectionNorm: 0,
    lastStateChanges: 0,
    finalActiveCount: 0,
    peakActiveCount: 0,
    finalActiveFaceCount: 0,
    finalActiveEdgeCount: 0,
    finalActiveApexCount: 0,
    finalTensionPendingCount: 0,
    peakActiveFaceCount: 0,
    peakActiveEdgeCount: 0,
    peakActiveApexCount: 0,
    peakTensionPendingCount: 0,
    peakEta: 0,
    loadFactorCommitted: 1,
    displayedLoadFactor: 1,
    converged: true,
    convergenceState: 'converged',
    failureCode: 'equilibrium-converged',
    failureOutcomeClass: 'converged',
    displayedStateMode: 'committed',
    loadFactorMeaning: 'safety-strength-reduction',
    failureReason: '',
    loadStepHistory: [],
    residualHistory: []
  };
}

function isExactTensionBranchKind(branchKind) {
  const value = String(branchKind || '');
  return value === 'MC_TENSION_PENDING' || value.startsWith('TENSION_');
}

function isTensionCutoffActiveState(materialState = null, materialDiagnostics = null, mc = null) {
  return (
    materialState?.activeYieldSurface === 'TENSION' ||
    materialDiagnostics?.activeYieldSurface === 'TENSION' ||
    materialDiagnostics?.diagnosticYieldSurface === 'TENSION' ||
    isExactTensionBranchKind(materialState?.exactBranchKind || materialDiagnostics?.exactBranchKind) ||
    mc?.state === 'tension-cutoff'
  );
}

function branchActivityCounts(materialState) {
  const branchKind = String(materialState?.exactBranchKind || '');
  return {
    face: branchKind === 'MC_FACE_F13' ? 1 : 0,
    edge: branchKind === 'MC_EDGE_S23_EQUAL' || branchKind === 'MC_EDGE_S12_EQUAL' ? 1 : 0,
    apex: branchKind === 'MC_APEX_FORMAL' ? 1 : 0,
    tension: isExactTensionBranchKind(branchKind) ? 1 : 0
  };
}

let activeMatvecBackend = null;
let activeBackendInfo = { name: 'cpu-f64', reason: 'gpu-disabled' };
let activeBackendRuntimeWarnings = [];

function backendRequiresResidualRefresh() {
  return !!(activeMatvecBackend && activeMatvecBackend.requiresResidualRefresh);
}

function backendResidualRefreshInterval() {
  return Math.max(
    Math.round(Number(activeMatvecBackend?.residualRefreshInterval) || BACKEND_RESIDUAL_REFRESH_INTERVAL),
    1
  );
}

function handleActiveBackendFailure(operation, error) {
  const operationLabel = String(operation || 'unknown-operation');
  const message = `Linear-algebra backend '${activeMatvecBackend?.name || 'unknown'}' failed during ${operationLabel} (${error?.message || 'unknown'}); falling back to the CPU f64 path for the remainder of the run.`;
  activeBackendInfo = {
    ...activeBackendInfo,
    name: 'cpu-f64',
    reason: `runtime-fallback:${operationLabel}:${error?.message || 'unknown'}`,
    failedFrom: activeMatvecBackend?.name || null,
    failedOperation: operationLabel,
    precisionMode: null,
    supportsElementKernels: false,
    supportsDoubleSingle: false
  };
  try { activeMatvecBackend?.dispose?.(); } catch { /* ignore */ }
  activeMatvecBackend = null;
  pushUniqueWarning(activeBackendRuntimeWarnings, message);
  if (typeof console !== 'undefined' && console?.warn) console.warn(message);
}

function backendEscalatePrecisionMode(nextMode, reason = '', nextResidualRefreshInterval = null) {
  if (!activeMatvecBackend?.setPrecisionMode) return false;
  const resolvedMode = activeMatvecBackend.setPrecisionMode(nextMode);
  if (nextResidualRefreshInterval != null) {
    try { activeMatvecBackend.setResidualRefreshInterval?.(nextResidualRefreshInterval); } catch { /* ignore */ }
  }
  activeBackendInfo = {
    ...activeBackendInfo,
    name: activeMatvecBackend?.name || activeBackendInfo?.name || 'cpu-f64',
    precisionMode: activeMatvecBackend?.precisionMode || resolvedMode || null,
    residualRefreshInterval: backendRequiresResidualRefresh() ? backendResidualRefreshInterval() : 0,
    precisionEscalationReason: reason || activeBackendInfo?.precisionEscalationReason || ''
  };
  return true;
}

function sparseMatVec(rows, vector) {
  if (activeMatvecBackend && typeof activeMatvecBackend.matvec === 'function') {
    try {
      return activeMatvecBackend.matvec(rows, vector);
    } catch (error) {
      handleActiveBackendFailure('matvec', error);
      return sparseMatVecFallback(rows, vector);
    }
  }
  return sparseMatVecFallback(rows, vector);
}

function backendElementStrain(elementCaches, vector) {
  if ((elementCaches || []).some((elementCache) => elementCache?.kind !== 't3')) return null;
  if (!activeMatvecBackend || typeof activeMatvecBackend.elementStrain !== 'function') return null;
  try {
    return activeMatvecBackend.elementStrain(elementCaches, vector);
  } catch (error) {
    handleActiveBackendFailure('element-strain', error);
    return null;
  }
}

function backendElementInternalForce(elementCaches, stressFlat) {
  if ((elementCaches || []).some((elementCache) => elementCache?.kind !== 't3')) return null;
  if (!activeMatvecBackend || typeof activeMatvecBackend.elementInternalForce !== 'function') return null;
  try {
    return activeMatvecBackend.elementInternalForce(elementCaches, stressFlat);
  } catch (error) {
    handleActiveBackendFailure('element-internal-force', error);
    return null;
  }
}

function backendElementElasticStiffness(elementCaches, tangentFlat) {
  if ((elementCaches || []).some((elementCache) => elementCache?.kind !== 't3')) return null;
  if (!activeMatvecBackend || typeof activeMatvecBackend.elementElasticStiffness !== 'function') return null;
  try {
    return activeMatvecBackend.elementElasticStiffness(elementCaches, tangentFlat);
  } catch (error) {
    handleActiveBackendFailure('element-elastic-stiffness', error);
    return null;
  }
}

function sparseMatVecFallback(rows, vector) {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    let sum = 0;
    let compensation = 0;
    const row = rows[i];
    for (let j = 0; j < row.indices.length; j += 1) {
      const term = row.values[j] * vector[row.indices[j]];
      const corrected = term - compensation;
      const next = sum + corrected;
      compensation = (next - sum) - corrected;
      sum = next;
    }
    out[i] = sum;
  }
  return out;
}

function nonlinearToleranceState(residualNorm, rhsNorm, deltaNorm, solutionNorm, {
  residualRelTol = NONLINEAR_RESIDUAL_REL_TOL,
  residualAbsTol = NONLINEAR_RESIDUAL_ABS_TOL,
  displacementRelTol = NONLINEAR_DISPLACEMENT_REL_TOL,
  displacementAbsTol = NONLINEAR_DISPLACEMENT_ABS_TOL
} = {}) {
  const residualTarget = Math.max(Math.max(Number(residualAbsTol) || 0, 0), Math.max(Number(residualRelTol) || 0, 0) * Math.max(Number(rhsNorm) || 0, 0));
  const displacementTarget = Math.max(Math.max(Number(displacementAbsTol) || 0, 0), Math.max(Number(displacementRelTol) || 0, 0) * Math.max(Number(solutionNorm) || 0, 0));
  const relativeResidual = Math.max(Number(rhsNorm) || 0, 0) > CG_NUMERIC_EPS ? residualNorm / rhsNorm : residualNorm > residualTarget ? Infinity : 0;
  const relativeDisplacement = Math.max(Number(solutionNorm) || 0, 0) > CG_NUMERIC_EPS ? deltaNorm / solutionNorm : deltaNorm > displacementTarget ? Infinity : 0;
  return {
    residualTarget,
    displacementTarget,
    relativeResidual,
    relativeDisplacement,
    residualConverged: residualNorm <= residualTarget,
    displacementConverged: deltaNorm <= displacementTarget,
    converged: residualNorm <= residualTarget && deltaNorm <= displacementTarget
  };
}

function evaluateResidualMerit(residualNormOrVector) {
  const residualNorm = typeof residualNormOrVector === 'number'
    ? Math.max(Number(residualNormOrVector) || 0, 0)
    : vectorNorm(residualNormOrVector || []);
  return 0.5 * residualNorm * residualNorm;
}

function approximateNewtonMeritDirectionalDerivative(residualNorm, linearizedResidualNorm = 0) {
  const residual = Math.max(Number(residualNorm) || 0, 0);
  const linearizedResidual = Math.max(Number(linearizedResidualNorm) || 0, 0);
  const effectiveDescent = Math.max(residual - linearizedResidual, 0);
  return -residual * effectiveDescent;
}

function classifyFailureOutcomeClass(code = '') {
  switch (String(code || '')) {
    case 'equilibrium-converged':
      return 'converged';
    case 'no-failure-found':
      return 'stable';
    case 'mechanism-developed':
      return 'mechanism-developed';
    case 'local-constitutive-failure':
      return 'local-constitutive';
    case 'interrupted':
      return 'interrupted';
    case 'global-linear-solve-failure':
    case 'line-search-stall':
    case 'step-budget-exhausted':
    case 'step-below-minimum':
    case 'nonlinear-iterations-exhausted':
    case 'assembly-failure':
    case 'arc-length-limit-point-not-resolved':
      return 'numerical-nonconvergence';
    default:
      return code ? 'unknown-failure' : 'unknown';
  }
}

function classifyFailureCode(reason = '') {
  const text = String(reason || '').toLowerCase();
  if (!text) return '';
  if (text.includes('interrupted')) return 'interrupted';
  if (text.includes('line search stalled')) return 'line-search-stall';
  if (text.includes('linearized solve did not converge')) return 'global-linear-solve-failure';
  if (
    text.includes('exact mc')
    || text.includes('active-set')
    || text.includes('constitutive')
    || text.includes('tangent coupling matrix')
    || text.includes('branch acceptance')
  ) return 'local-constitutive-failure';
  if (text.includes('exceeded the maximum number of load steps')) return 'step-budget-exhausted';
  if (
    text.includes('could not converge the load step')
    || text.includes('could not converge the continuation step')
  ) return 'step-below-minimum';
  if (text.includes('arc-length')) return 'arc-length-limit-point-not-resolved';
  if (text.includes('nonlinear iterations exhausted')) return 'nonlinear-iterations-exhausted';
  return 'assembly-failure';
}

function createFailureRecord(code = '', reason = '') {
  const resolvedCode = code || classifyFailureCode(reason);
  return {
    code: resolvedCode,
    outcomeClass: classifyFailureOutcomeClass(resolvedCode),
    reason: reason || ''
  };
}

function computeAdaptiveContinuationFactor({
  iterationCount,
  acceptedLineSearchScale,
  targetIterations,
  targetLineSearchScale,
  iterationExponent,
  lineSearchExponent,
  minFactor,
  maxFactor
}) {
  const boundedMin = Math.max(Number(minFactor) || 0, 1e-6);
  const boundedMax = Math.max(Number(maxFactor) || 0, boundedMin);
  const effectiveIterations = Math.max(Number(iterationCount) || 0, 1);
  const effectiveScale = Math.max(Math.min(Number(acceptedLineSearchScale) || 1, 1), 1e-6);
  const targetIter = Math.max(Number(targetIterations) || NONLINEAR_CONTINUATION_TARGET_ITERATIONS, 1);
  const targetScale = Math.max(Math.min(Number(targetLineSearchScale) || NONLINEAR_CONTINUATION_TARGET_LINE_SEARCH_SCALE, 1), 1e-6);
  const iterExp = Math.max(Number(iterationExponent) || NONLINEAR_CONTINUATION_ITERATION_EXPONENT, 0);
  const scaleExp = Math.max(Number(lineSearchExponent) || NONLINEAR_CONTINUATION_LINE_SEARCH_EXPONENT, 0);
  const rawFactor = Math.pow(targetIter / effectiveIterations, iterExp) * Math.pow(effectiveScale / targetScale, scaleExp);
  if (!Number.isFinite(rawFactor) || rawFactor <= 0) return boundedMin;
  return Math.min(Math.max(rawFactor, boundedMin), boundedMax);
}

function allowPlasticQuasiConvergence(
  constitutiveModel,
  phaseKind,
  tolerance,
  changedCount,
  iteration
) {
  if (constitutiveModel !== 'mc-plastic' || phaseKind !== 'initial-gravity') return false;
  if ((Number(changedCount) || 0) !== 0) return false;
  if ((Number(iteration) || 0) < 2) return false;
  const residualNorm = Number(tolerance?.residualNorm);
  const residualTarget = Number(tolerance?.residualTarget);
  if (!(Number.isFinite(residualNorm) && Number.isFinite(residualTarget) && residualTarget > 0)) return false;
  return residualNorm <= 1.1 * residualTarget;
}

function cgToleranceState(residualNorm, rhsNorm, relTol = CG_REL_TOL, absTol = CG_ABS_TOL) {
  const absoluteTarget = Math.max(Number(absTol) || 0, 0);
  const relativeTarget = Math.max(Number(relTol) || 0, 0) * Math.max(Number(rhsNorm) || 0, 0);
  const target = Math.max(absoluteTarget, relativeTarget);
  const relativeResidual = Math.max(Number(rhsNorm) || 0, 0) > CG_NUMERIC_EPS
    ? residualNorm / rhsNorm
    : residualNorm > absoluteTarget ? Infinity : 0;
  return {
    target,
    absoluteTarget,
    relativeTarget,
    relativeResidual,
    converged: residualNorm <= target
  };
}

async function solveCg(rows, rhs, initial = null, maxIter = MAX_CG_ITER, relTol = CG_REL_TOL, absTol = CG_ABS_TOL, runControl = null, iterationObserver = null) {
  const n = rows.length;
  if (!n) {
    return {
      solution: new Float64Array(0),
      converged: true,
      iterations: 0,
      residualNorm: 0,
      relativeResidual: 0,
      rhsNorm: 0,
      toleranceTarget: 0,
      interrupted: false
    };
  }
  const x = initial && initial.length === n ? Float64Array.from(initial) : new Float64Array(n);
  let r = rhs;
  if (initial) {
    // The initial residual sets convergence expectations for the rest of the
    // solve. Use the f64 fallback when a mixed-precision backend is active
    // so warm-start convergence is not judged against a narrowed residual.
    const ax = backendRequiresResidualRefresh()
      ? sparseMatVecFallback(rows, x)
      : sparseMatVec(rows, x);
    r = new Float64Array(n);
    for (let i = 0; i < n; i += 1) r[i] = rhs[i] - ax[i];
  } else {
    r = Float64Array.from(rhs);
  }
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const rhsNorm = Math.sqrt(dot(rhs, rhs));

  for (let i = 0; i < n; i += 1) {
    const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
    z[i] = r[i] / diag;
    p[i] = z[i];
  }

  let rzOld = dot(r, z);
  let residualNorm = Math.sqrt(dot(r, r));
  let tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  if (tolerance.converged) {
    return {
      solution: x,
      converged: true,
      iterations: 0,
      residualNorm,
      relativeResidual: tolerance.relativeResidual,
      rhsNorm,
      toleranceTarget: tolerance.target,
      interrupted: false
    };
  }
  await runCheckpoint(runControl, true);

  for (let iter = 1; iter <= maxIter; iter += 1) {
    const ap = sparseMatVec(rows, p);
    const denom = dot(p, ap);
    if (!(Math.abs(denom) > CG_NUMERIC_EPS)) {
      tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: tolerance.converged,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    const alpha = rzOld / denom;
    for (let i = 0; i < n; i += 1) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    let didResidualRefresh = false;
    if (backendRequiresResidualRefresh() && iter % backendResidualRefreshInterval() === 0) {
      const axRefresh = sparseMatVecFallback(rows, x);
      for (let i = 0; i < n; i += 1) r[i] = rhs[i] - axRefresh[i];
      didResidualRefresh = true;
    }
    residualNorm = Math.sqrt(dot(r, r));
    tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
    if (iterationObserver && (iter === 1 || iter % GEOSTATIC_CG_PROGRESS_INTERVAL === 0)) {
      await iterationObserver({
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target
      });
    }
    if (tolerance.converged) {
      return {
        solution: x,
        converged: true,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    for (let i = 0; i < n; i += 1) {
      const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
      z[i] = r[i] / diag;
    }
    const rzNew = dot(r, z);
    // After a residual refresh we restart the Krylov subspace (p = z) so the
    // momentum term does not drag in stale pre-refresh direction vectors.
    const beta = didResidualRefresh
      ? 0
      : (Math.abs(rzOld) > CG_NUMERIC_EPS ? rzNew / rzOld : 0);
    for (let i = 0; i < n; i += 1) p[i] = didResidualRefresh ? z[i] : z[i] + beta * p[i];
    rzOld = rzNew;
    if (iter % CG_CHECKPOINT_INTERVAL === 0 && (await runCheckpoint(runControl))) {
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: true
      };
    }
  }

  tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  return {
    solution: x,
    converged: false,
    iterations: maxIter,
    residualNorm,
    relativeResidual: tolerance.relativeResidual,
    rhsNorm,
    toleranceTarget: tolerance.target,
    interrupted: false
  };
}

async function solveBiCgStab(rows, rhs, initial = null, maxIter = MAX_CG_ITER, relTol = CG_REL_TOL, absTol = CG_ABS_TOL, runControl = null, iterationObserver = null) {
  const n = rows.length;
  if (!n) {
    return {
      solution: new Float64Array(0),
      converged: true,
      iterations: 0,
      residualNorm: 0,
      relativeResidual: 0,
      rhsNorm: 0,
      toleranceTarget: 0,
      interrupted: false
    };
  }
  const x = initial && initial.length === n ? Float64Array.from(initial) : new Float64Array(n);
  const rhsNorm = Math.sqrt(dot(rhs, rhs));
  const ax0 = initial
    ? (backendRequiresResidualRefresh()
        ? sparseMatVecFallback(rows, x)
        : sparseMatVec(rows, x))
    : new Float64Array(n);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i += 1) r[i] = rhs[i] - ax0[i];
  let rHat = Float64Array.from(r);
  let residualNorm = Math.sqrt(dot(r, r));
  let tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  if (tolerance.converged) {
    return {
      solution: x,
      converged: true,
      iterations: 0,
      residualNorm,
      relativeResidual: tolerance.relativeResidual,
      rhsNorm,
      toleranceTarget: tolerance.target,
      interrupted: false
    };
  }

  const p = new Float64Array(n);
  const v = new Float64Array(n);
  const s = new Float64Array(n);
  const t = new Float64Array(n);
  const phat = new Float64Array(n);
  const shat = new Float64Array(n);
  let rhoOld = 1;
  let alpha = 1;
  let omega = 1;
  let restartCount = 0;
  const maxRestarts = 8;

  const restartIteration = () => {
    restartCount += 1;
    if (restartCount > maxRestarts) return false;
    rHat = Float64Array.from(r);
    p.fill(0);
    v.fill(0);
    rhoOld = 1;
    alpha = 1;
    omega = 1;
    return true;
  };

  await runCheckpoint(runControl, true);

  for (let iter = 1; iter <= maxIter; iter += 1) {
    const rhoNew = dot(rHat, r);
    if (!(Number.isFinite(rhoNew) && Math.abs(rhoNew) > CG_NUMERIC_EPS)) {
      if (restartIteration()) continue;
      tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: tolerance.converged,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    const beta = (rhoNew / rhoOld) * (alpha / omega);
    for (let i = 0; i < n; i += 1) {
      p[i] = r[i] + beta * (p[i] - omega * v[i]);
      const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
      phat[i] = p[i] / diag;
    }
    const vNext = sparseMatVec(rows, phat);
    v.set(vNext);
    const rHatDotV = dot(rHat, v);
    if (!(Number.isFinite(rHatDotV) && Math.abs(rHatDotV) > CG_NUMERIC_EPS)) {
      if (restartIteration()) continue;
      tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    alpha = rhoNew / rHatDotV;
    for (let i = 0; i < n; i += 1) s[i] = r[i] - alpha * v[i];
    const sNorm = Math.sqrt(dot(s, s));
    const sTolerance = cgToleranceState(sNorm, rhsNorm, relTol, absTol);
    if (sTolerance.converged) {
      for (let i = 0; i < n; i += 1) x[i] += alpha * phat[i];
      return {
        solution: x,
        converged: true,
        iterations: iter,
        residualNorm: sNorm,
        relativeResidual: sTolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: sTolerance.target,
        interrupted: false
      };
    }
    for (let i = 0; i < n; i += 1) {
      const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
      shat[i] = s[i] / diag;
    }
    const tNext = sparseMatVec(rows, shat);
    t.set(tNext);
    const tDotT = dot(t, t);
    if (!(Number.isFinite(tDotT) && tDotT > CG_NUMERIC_EPS)) {
      for (let i = 0; i < n; i += 1) {
        x[i] += alpha * phat[i];
        r[i] = s[i];
      }
      residualNorm = sNorm;
      if (restartIteration()) continue;
      tolerance = cgToleranceState(sNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm: sNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    omega = dot(t, s) / tDotT;
    if (!(Number.isFinite(omega) && Math.abs(omega) > CG_NUMERIC_EPS)) {
      for (let i = 0; i < n; i += 1) {
        x[i] += alpha * phat[i];
        r[i] = s[i];
      }
      residualNorm = sNorm;
      if (restartIteration()) continue;
      tolerance = cgToleranceState(sNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm: sNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    for (let i = 0; i < n; i += 1) {
      x[i] += alpha * phat[i] + omega * shat[i];
      r[i] = s[i] - omega * t[i];
    }
    if (backendRequiresResidualRefresh() && iter % backendResidualRefreshInterval() === 0) {
      const axRefresh = sparseMatVecFallback(rows, x);
      for (let i = 0; i < n; i += 1) r[i] = rhs[i] - axRefresh[i];
      // Restart the biorthogonalisation: fresh r implies fresh shadow rHat,
      // zeroed search directions and unit scalars. x is preserved.
      rHat = Float64Array.from(r);
      p.fill(0);
      v.fill(0);
      rhoOld = 1;
      alpha = 1;
      omega = 1;
    }
    residualNorm = Math.sqrt(dot(r, r));
    tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
    if (iterationObserver && (iter === 1 || iter % NONLINEAR_LINEAR_PROGRESS_INTERVAL === 0)) {
      await iterationObserver({
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target
      });
    }
    if (tolerance.converged) {
      return {
        solution: x,
        converged: true,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    rhoOld = rhoNew;
    if (iter % BICGSTAB_CHECKPOINT_INTERVAL === 0 && (await runCheckpoint(runControl))) {
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: true
      };
    }
  }

  tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  return {
    solution: x,
    converged: false,
    iterations: maxIter,
    residualNorm,
    relativeResidual: tolerance.relativeResidual,
    rhsNorm,
    toleranceTarget: tolerance.target,
    interrupted: false
  };
}

function buildScaledLinearSystem(rows, rhs, options = {}) {
  const n = rows.length;
  const rowScaling = options?.rowScaling !== false;
  const columnScaling = options?.columnScaling !== false;
  const scaleFloor = Math.max(Number(options?.scaleFloor) || 1e-12, 1e-16);
  const rowScale = new Float64Array(n);
  const columnScale = new Float64Array(n);
  rowScale.fill(1);
  columnScale.fill(1);

  if (columnScaling) {
    const columnMax = new Float64Array(n);
    for (let rowIndex = 0; rowIndex < n; rowIndex += 1) {
      const row = rows[rowIndex];
      for (let entryIndex = 0; entryIndex < row.indices.length; entryIndex += 1) {
        const colIndex = row.indices[entryIndex];
        columnMax[colIndex] = Math.max(columnMax[colIndex], Math.abs(Number(row.values?.[entryIndex]) || 0));
      }
    }
    for (let colIndex = 0; colIndex < n; colIndex += 1) {
      columnScale[colIndex] = 1 / Math.max(columnMax[colIndex], scaleFloor);
    }
  }

  if (rowScaling) {
    for (let rowIndex = 0; rowIndex < n; rowIndex += 1) {
      const row = rows[rowIndex];
      let maxRowAbs = 0;
      for (let entryIndex = 0; entryIndex < row.indices.length; entryIndex += 1) {
        const colIndex = row.indices[entryIndex];
        maxRowAbs = Math.max(
          maxRowAbs,
          Math.abs((Number(row.values?.[entryIndex]) || 0) * (columnScaling ? columnScale[colIndex] : 1))
        );
      }
      rowScale[rowIndex] = 1 / Math.max(maxRowAbs, scaleFloor);
    }
  }

  const scaledRows = Array.from({ length: n }, () => ({ indices: [], values: [], diag: 0 }));
  for (let rowIndex = 0; rowIndex < n; rowIndex += 1) {
    const row = rows[rowIndex];
    const scaledRow = scaledRows[rowIndex];
    const rowFactor = rowScale[rowIndex];
    scaledRow.indices = row.indices.slice();
    scaledRow.values = row.values.map((value, entryIndex) => {
      const colIndex = row.indices[entryIndex];
      const scaledValue = rowFactor * (Number(value) || 0) * columnScale[colIndex];
      if (colIndex === rowIndex) scaledRow.diag = scaledValue;
      return scaledValue;
    });
  }

  const scaledRhs = new Float64Array(n);
  for (let rowIndex = 0; rowIndex < n; rowIndex += 1) {
    scaledRhs[rowIndex] = rowScale[rowIndex] * (Number(rhs?.[rowIndex]) || 0);
  }

  return {
    rows: scaledRows,
    rhs: scaledRhs,
    rowScale,
    columnScale,
    scaleSolution(solutionScaled) {
      const solution = new Float64Array(n);
      for (let index = 0; index < n; index += 1) {
        solution[index] = (Number(solutionScaled?.[index]) || 0) * columnScale[index];
      }
      return solution;
    },
    unscaleInitialSolution(initialSolution) {
      if (!initialSolution || initialSolution.length !== n) return null;
      const scaled = new Float64Array(n);
      for (let index = 0; index < n; index += 1) {
        scaled[index] = (Number(initialSolution[index]) || 0) / Math.max(columnScale[index], scaleFloor);
      }
      return scaled;
    }
  };
}

function applyGivensRotation(x, y, cosine, sine) {
  return [
    cosine * x + sine * y,
    -sine * x + cosine * y
  ];
}

function computeGivensRotation(a, b) {
  if (!(Math.abs(b) > CG_NUMERIC_EPS)) return { cosine: 1, sine: 0 };
  if (!(Math.abs(a) > CG_NUMERIC_EPS)) return { cosine: 0, sine: 1 };
  const radius = Math.hypot(a, b);
  return {
    cosine: a / radius,
    sine: b / radius
  };
}

function solveUpperTriangularFromHessenberg(hessenberg, rhs, dimension) {
  const solution = new Float64Array(dimension);
  for (let rowIndex = dimension - 1; rowIndex >= 0; rowIndex -= 1) {
    let sum = Number(rhs?.[rowIndex]) || 0;
    for (let colIndex = rowIndex + 1; colIndex < dimension; colIndex += 1) {
      sum -= (Number(hessenberg?.[rowIndex]?.[colIndex]) || 0) * solution[colIndex];
    }
    const diagonal = Number(hessenberg?.[rowIndex]?.[rowIndex]) || 0;
    if (!(Math.abs(diagonal) > CG_NUMERIC_EPS)) return null;
    solution[rowIndex] = sum / diagonal;
  }
  return solution;
}

async function solveGmresScaled(rows, rhs, initial = null, maxIter = MAX_CG_ITER, relTol = CG_REL_TOL, absTol = CG_ABS_TOL, runControl = null, iterationObserver = null, options = {}) {
  const n = rows.length;
  if (!n) {
    return {
      solution: new Float64Array(0),
      converged: true,
      iterations: 0,
      residualNorm: 0,
      relativeResidual: 0,
      rhsNorm: 0,
      toleranceTarget: 0,
      interrupted: false
    };
  }

  const scaledSystem = buildScaledLinearSystem(rows, rhs, options);
  const scaledRows = scaledSystem.rows;
  const scaledRhs = scaledSystem.rhs;
  const rhsNorm = Math.sqrt(dot(scaledRhs, scaledRhs));
  const restart = Math.max(Math.round(Number(options?.restart) || GMRES_RESTART), 4);
  let x = scaledSystem.unscaleInitialSolution(initial) || new Float64Array(n);
  let ax = backendRequiresResidualRefresh()
    ? sparseMatVecFallback(scaledRows, x)
    : sparseMatVec(scaledRows, x);
  let residual = new Float64Array(n);
  for (let i = 0; i < n; i += 1) residual[i] = scaledRhs[i] - ax[i];
  let residualNorm = Math.sqrt(dot(residual, residual));
  let tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  if (tolerance.converged) {
    return {
      solution: scaledSystem.scaleSolution(x),
      converged: true,
      iterations: 0,
      residualNorm,
      relativeResidual: tolerance.relativeResidual,
      rhsNorm,
      toleranceTarget: tolerance.target,
      interrupted: false
    };
  }

  await runCheckpoint(runControl, true);
  let totalIterations = 0;

  while (totalIterations < maxIter) {
    const beta = Math.sqrt(dot(residual, residual));
    if (!(beta > CG_NUMERIC_EPS)) {
      tolerance = cgToleranceState(0, rhsNorm, relTol, absTol);
      return {
        solution: scaledSystem.scaleSolution(x),
        converged: true,
        iterations: totalIterations,
        residualNorm: 0,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }

    const krylovDim = Math.min(restart, maxIter - totalIterations);
    const basis = Array.from({ length: krylovDim + 1 }, () => new Float64Array(n));
    const hessenberg = Array.from({ length: krylovDim + 1 }, () => new Float64Array(krylovDim));
    const givensCos = new Float64Array(krylovDim);
    const givensSin = new Float64Array(krylovDim);
    const g = new Float64Array(krylovDim + 1);
    g[0] = beta;
    for (let i = 0; i < n; i += 1) basis[0][i] = residual[i] / beta;

    let solvedThisRestart = false;
    let completedColumns = 0;

    for (let columnIndex = 0; columnIndex < krylovDim; columnIndex += 1) {
      totalIterations += 1;
      completedColumns = columnIndex + 1;
      const arnoldiVector = sparseMatVec(scaledRows, basis[columnIndex]);
      for (let rowIndex = 0; rowIndex <= columnIndex; rowIndex += 1) {
        const projection = dot(arnoldiVector, basis[rowIndex]);
        hessenberg[rowIndex][columnIndex] = projection;
        for (let entryIndex = 0; entryIndex < n; entryIndex += 1) {
          arnoldiVector[entryIndex] -= projection * basis[rowIndex][entryIndex];
        }
      }
      const nextNorm = Math.sqrt(dot(arnoldiVector, arnoldiVector));
      hessenberg[columnIndex + 1][columnIndex] = nextNorm;
      if (nextNorm > CG_NUMERIC_EPS && columnIndex + 1 < basis.length) {
        for (let entryIndex = 0; entryIndex < n; entryIndex += 1) {
          basis[columnIndex + 1][entryIndex] = arnoldiVector[entryIndex] / nextNorm;
        }
      }

      for (let rotationIndex = 0; rotationIndex < columnIndex; rotationIndex += 1) {
        const [rotatedUpper, rotatedLower] = applyGivensRotation(
          hessenberg[rotationIndex][columnIndex],
          hessenberg[rotationIndex + 1][columnIndex],
          givensCos[rotationIndex],
          givensSin[rotationIndex]
        );
        hessenberg[rotationIndex][columnIndex] = rotatedUpper;
        hessenberg[rotationIndex + 1][columnIndex] = rotatedLower;
      }

      const { cosine, sine } = computeGivensRotation(
        hessenberg[columnIndex][columnIndex],
        hessenberg[columnIndex + 1][columnIndex]
      );
      givensCos[columnIndex] = cosine;
      givensSin[columnIndex] = sine;
      const [newDiag, newSubdiag] = applyGivensRotation(
        hessenberg[columnIndex][columnIndex],
        hessenberg[columnIndex + 1][columnIndex],
        cosine,
        sine
      );
      hessenberg[columnIndex][columnIndex] = newDiag;
      hessenberg[columnIndex + 1][columnIndex] = newSubdiag;
      const [newG, newNextG] = applyGivensRotation(g[columnIndex], g[columnIndex + 1], cosine, sine);
      g[columnIndex] = newG;
      g[columnIndex + 1] = newNextG;

      residualNorm = Math.abs(g[columnIndex + 1]);
      tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
      if (iterationObserver && (totalIterations === 1 || totalIterations % NONLINEAR_LINEAR_PROGRESS_INTERVAL === 0)) {
        await iterationObserver({
          iterations: totalIterations,
          residualNorm,
          relativeResidual: tolerance.relativeResidual,
          rhsNorm,
          toleranceTarget: tolerance.target
        });
      }
      if (tolerance.converged || totalIterations >= maxIter || !(nextNorm > CG_NUMERIC_EPS)) {
        const y = solveUpperTriangularFromHessenberg(hessenberg, g, completedColumns);
        if (y) {
          for (let basisIndex = 0; basisIndex < completedColumns; basisIndex += 1) {
            const coefficient = y[basisIndex];
            for (let entryIndex = 0; entryIndex < n; entryIndex += 1) {
              x[entryIndex] += coefficient * basis[basisIndex][entryIndex];
            }
          }
        }
        // Residual recomputes at restart boundaries always use the f64
        // fallback when a mixed-precision backend is active. Arnoldi steps
        // inside the restart may have been evaluated in f32; we reset the
        // convergence residual with full precision here.
        ax = backendRequiresResidualRefresh()
          ? sparseMatVecFallback(scaledRows, x)
          : sparseMatVec(scaledRows, x);
        for (let entryIndex = 0; entryIndex < n; entryIndex += 1) {
          residual[entryIndex] = scaledRhs[entryIndex] - ax[entryIndex];
        }
        residualNorm = Math.sqrt(dot(residual, residual));
        tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
        solvedThisRestart = tolerance.converged;
        break;
      }

      if (totalIterations % GMRES_CHECKPOINT_INTERVAL === 0 && (await runCheckpoint(runControl))) {
        return {
          solution: scaledSystem.scaleSolution(x),
          converged: false,
          iterations: totalIterations,
          residualNorm,
          relativeResidual: tolerance.relativeResidual,
          rhsNorm,
          toleranceTarget: tolerance.target,
          interrupted: true
        };
      }
    }

    if (!solvedThisRestart && completedColumns > 0) {
      const y = solveUpperTriangularFromHessenberg(hessenberg, g, completedColumns);
      if (y) {
        for (let basisIndex = 0; basisIndex < completedColumns; basisIndex += 1) {
          const coefficient = y[basisIndex];
          for (let entryIndex = 0; entryIndex < n; entryIndex += 1) {
            x[entryIndex] += coefficient * basis[basisIndex][entryIndex];
          }
        }
      }
    }

    if (solvedThisRestart || tolerance.converged) {
      return {
        solution: scaledSystem.scaleSolution(x),
        converged: true,
        iterations: totalIterations,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }

    // Between restarts: full-precision residual recompute when mixed.
    ax = backendRequiresResidualRefresh()
      ? sparseMatVecFallback(scaledRows, x)
      : sparseMatVec(scaledRows, x);
    for (let entryIndex = 0; entryIndex < n; entryIndex += 1) {
      residual[entryIndex] = scaledRhs[entryIndex] - ax[entryIndex];
    }
    residualNorm = Math.sqrt(dot(residual, residual));
    tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
    if (totalIterations >= maxIter) break;
  }

  tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  return {
    solution: scaledSystem.scaleSolution(x),
    converged: false,
    iterations: totalIterations,
    residualNorm,
    relativeResidual: tolerance.relativeResidual,
    rhsNorm,
    toleranceTarget: tolerance.target,
    interrupted: false
  };
}

function compressMatrixRows(rows, freeDofs, freeIndexByDof) {
  return freeDofs.map((dofId, rowIndex) => {
    const out = { indices: [], values: [], diag: 0 };
    rows[dofId].forEach((value, colId) => {
      const colIndex = freeIndexByDof.get(colId);
      if (colIndex == null) return;
      out.indices.push(colIndex);
      out.values.push(value);
      if (colIndex === rowIndex) out.diag = value;
    });
    return out;
  });
}

function compressRhs(rows, freeDofs, fixedValues, fullRhs) {
  const rhs = new Float64Array(freeDofs.length);
  freeDofs.forEach((dofId, rowIndex) => {
    rhs[rowIndex] = fullRhs[dofId] || 0;
    rows[dofId].forEach((value, colId) => {
      if (!fixedValues.has(colId)) return;
      rhs[rowIndex] -= value * fixedValues.get(colId);
    });
  });
  return rhs;
}

function gatherFreeVector(fullVector, freeDofs) {
  const rhs = new Float64Array(freeDofs.length);
  freeDofs.forEach((dofId, rowIndex) => {
    rhs[rowIndex] = Number(fullVector?.[dofId]) || 0;
  });
  return rhs;
}

function addMatrixBlock(rows, dofs, localK) {
  for (let i = 0; i < dofs.length; i += 1) {
    const row = rows[dofs[i]];
    for (let j = 0; j < dofs.length; j += 1) {
      row.set(dofs[j], (row.get(dofs[j]) || 0) + localK[i][j]);
    }
  }
}

function addVectorBlock(rhs, dofs, localF) {
  for (let i = 0; i < dofs.length; i += 1) rhs[dofs[i]] += localF[i];
}

function addMatrixBlockFlat(rows, dofs, localKFlat, base = 0) {
  const localDofCount = dofs.length;
  for (let localRow = 0; localRow < localDofCount; localRow += 1) {
    const row = rows[dofs[localRow]];
    const rowBase = base + localRow * localDofCount;
    for (let localCol = 0; localCol < localDofCount; localCol += 1) {
      row.set(dofs[localCol], (row.get(dofs[localCol]) || 0) + (Number(localKFlat?.[rowBase + localCol]) || 0));
    }
  }
}

function addMatrixBlockToCompressedRows(rows, elementCache, localK) {
  const localDofCount = elementCache.dofs.length;
  for (let localRow = 0; localRow < localDofCount; localRow += 1) {
    const freeRowIndex = elementCache.freeRowIndices?.[localRow] ?? -1;
    if (freeRowIndex < 0) continue;
    const rowValues = rows[freeRowIndex].values;
    for (let localCol = 0; localCol < localDofCount; localCol += 1) {
      const slotIndex = elementCache.assemblyLocalSlots?.[localRow * localDofCount + localCol] ?? -1;
      if (slotIndex < 0) continue;
      rowValues[slotIndex] += localK[localRow][localCol];
    }
  }
}

function addMatrixBlockFlatToCompressedRows(rows, elementCache, localKFlat, base = 0) {
  const localDofCount = elementCache.dofs.length;
  for (let localRow = 0; localRow < localDofCount; localRow += 1) {
    const freeRowIndex = elementCache.freeRowIndices?.[localRow] ?? -1;
    if (freeRowIndex < 0) continue;
    const rowValues = rows[freeRowIndex].values;
    for (let localCol = 0; localCol < localDofCount; localCol += 1) {
      const slotIndex = elementCache.assemblyLocalSlots?.[localRow * localDofCount + localCol] ?? -1;
      if (slotIndex < 0) continue;
      rowValues[slotIndex] += Number(localKFlat?.[base + localRow * localDofCount + localCol]) || 0;
    }
  }
}

function addVectorBlockToFreeRhs(rhs, freeRowIndices, localF) {
  const localDofCount = Math.min(freeRowIndices?.length || 0, localF?.length || 0);
  for (let i = 0; i < localDofCount; i += 1) {
    const freeRowIndex = freeRowIndices?.[i] ?? -1;
    if (freeRowIndex < 0) continue;
    rhs[freeRowIndex] += localF[i];
  }
}

function addVectorBlockFlatToFreeRhs(rhs, freeRowIndices, localFFlat, base = 0) {
  for (let localIndex = 0; localIndex < (freeRowIndices?.length || 0); localIndex += 1) {
    const freeRowIndex = freeRowIndices?.[localIndex] ?? -1;
    if (freeRowIndex < 0) continue;
    rhs[freeRowIndex] += Number(localFFlat?.[base + localIndex]) || 0;
  }
}

function overlapRange(a0, a1, b0, b1) {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return hi > lo + GEOM_EPS ? { lo, hi } : null;
}

function normalizeLoad(model, options, warnings, mode = 'required') {
  const surfaceLoad = model?.surfaceLoad || null;
  const loadMode = options?.loadMode === 'total' ? 'total' : 'pressure';
  const hasPositiveTotalLoad = loadMode === 'total' && (Math.max(Number(options?.totalLoad) || 0, 0) > 0);
  const hasPositivePressure = loadMode === 'pressure' && (Math.max(Number(surfaceLoad?.q) || 0, 0) > 0);
  const requiresLoad = mode === 'required';
  const validInterval = surfaceLoad?.xEnd > surfaceLoad?.xStart + GEOM_EPS;
  if (!validInterval) {
    if (!requiresLoad && !hasPositiveTotalLoad && !hasPositivePressure) return null;
    throw new Error(
      requiresLoad
        ? 'Draw a load interval on the terrain before running deformation.'
        : 'Draw a load interval on the terrain before applying an external surface load in the safety analysis.'
    );
  }
  const width = surfaceLoad.xEnd - surfaceLoad.xStart;
  const outOfPlaneLength = Math.max(Number(options?.outOfPlaneLength) || 10, 0.1);
  let q = Math.max(Number(surfaceLoad?.q) || 0, 0);
  let totalLoad = null;
  if (loadMode === 'total') {
    totalLoad = Math.max(Number(options?.totalLoad) || 0, 0);
    if (requiresLoad && !(totalLoad > 0)) {
      throw new Error('Enter a positive total load before running deformation in total-load mode.');
    }
    if (!requiresLoad && !(totalLoad > 0)) return null;
    q = totalLoad / Math.max(width * outOfPlaneLength, 1e-6);
  }
  if (requiresLoad && !(q > 0)) {
    throw new Error(loadMode === 'pressure'
      ? 'Enter a positive surface load q before running deformation.'
      : 'The derived pressure from total load is zero or negative.');
  }
  if (!requiresLoad && !(q > 0)) return null;
  if (loadMode === 'pressure' && Number(options?.totalLoad) > 0) {
    totalLoad = q * width * outOfPlaneLength;
  }
  if (outOfPlaneLength / width < 4 - 1e-9) {
    warnings.push('Out-of-plane length is less than 4 times the loaded width, so the plane-strain deformation result should be treated as a 2D screening approximation.');
  }
  return {
    xStart: surfaceLoad.xStart,
    xEnd: surfaceLoad.xEnd,
    width,
    q,
    loadMode,
    totalLoad,
    outOfPlaneLength
  };
}

function addDomainExtentWarnings(model, load, warnings) {
  const terrain = model?.terrain?.vertices || [];
  if (terrain.length < 2 || !(load?.width > 0)) return;
  const leftMargin = load.xStart - terrain[0].x;
  const rightMargin = terrain[terrain.length - 1].x - load.xEnd;
  const below = terrain.reduce((sum, point) => sum + point.y, 0) / terrain.length - Number(model.analysisBottomY || 0);
  const target = 5 * load.width;
  if (leftMargin < target || rightMargin < target || below < target) {
    warnings.push(
      `The current domain is smaller than the recommended 5*B buffer (${target.toFixed(2)} m) on one or more sides, so settlements and MC utilization near the boundaries may be optimistic.`
    );
  }
}

function buildConstraintSets(mesh) {
  const fixUx = new Set();
  const fixUy = new Set();
  (mesh.constraintEdges || []).forEach((edge) => {
    if (edge?.markerType !== 'outer') return;
    const nodeIds = edge.nodeIds || [edge.n1, edge.n2];
    if (edge.source === 'side-left' || edge.source === 'side-right') {
      nodeIds.forEach((nodeId) => fixUx.add(nodeId));
    }
    if (edge.source === 'base') {
      nodeIds.forEach((nodeId) => fixUy.add(nodeId));
    }
  });
  return { fixUx, fixUy };
}

function buildFixedDofMap(mesh) {
  const { fixUx, fixUy } = buildConstraintSets(mesh);
  const fixed = new Map();
  [...fixUx].forEach((nodeId) => fixed.set(2 * nodeId, 0));
  [...fixUy].forEach((nodeId) => fixed.set(2 * nodeId + 1, 0));
  return fixed;
}

function loadedTerrainEdges(mesh, load) {
  if (!(load?.xEnd > load?.xStart + GEOM_EPS)) return [];
  return (mesh.constraintEdges || []).filter((edge) => {
    if (edge?.markerType !== 'outer' || edge?.source !== 'terrain') return false;
    return !!overlapRange(edge.a.x, edge.b.x, load.xStart, load.xEnd);
  });
}

function createMaterialModelForOptions(materialParameters, options, warnings) {
  const constitutiveModel = options?.constitutiveModel === 'linear-elastic'
    ? 'linear-elastic'
    : options?.constitutiveModel === 'mc-plastic'
      ? 'mc-plastic'
      : 'mc-reduced-stiffness';
  if (constitutiveModel === 'linear-elastic') return createLinearElasticMaterial(materialParameters, warnings);
  if (constitutiveModel === 'mc-plastic') return createMCPlasticMaterial(materialParameters, warnings);
  return createMCReducedStiffnessMaterial(materialParameters, warnings);
}

function prepareRegionConstitutiveModels(mesh, options, warnings) {
  const byRegion = new Map();
  mesh.cells.forEach((cell) => {
    if (cell?.regionIndex == null || cell.regionIndex < 0 || byRegion.has(cell.regionIndex)) return;
    const materialParameters = prepareMechanicalMaterial(cell.material, warnings);
    byRegion.set(cell.regionIndex, {
      materialParameters,
      materialModel: createMaterialModelForOptions(materialParameters, options, warnings)
    });
  });
  return byRegion;
}

function buildSafetyReducedRegionParameters(regionConstitutiveByRegion, sigmaMsf) {
  const reducedByRegion = new Map();
  regionConstitutiveByRegion.forEach((constitutive, regionIndex) => {
    reducedByRegion.set(
      regionIndex,
      reduceMaterialStrengthForSafety(constitutive?.materialParameters, sigmaMsf)
    );
  });
  return reducedByRegion;
}

function assignMaterialParametersByRegion(materialPoints, materialParametersByRegion) {
  materialPoints.forEach((materialPoint) => {
    if (!materialPoint) return;
    const override = materialParametersByRegion?.get(materialPoint.regionIndex);
    if (override) materialPoint.materialParameters = cloneMaterialParameters(override);
  });
}

function regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings) {
  const cached = regionConstitutiveByRegion.get(cell?.regionIndex);
  if (cached) return cached;
  const materialParameters = prepareMechanicalMaterial(cell?.material, warnings);
  return {
    materialParameters,
    materialModel: createMaterialModelForOptions(materialParameters, options, warnings)
  };
}

function elementDofMap(element) {
  const dofs = new Array(2 * element.length);
  for (let i = 0; i < element.length; i += 1) {
    dofs[2 * i] = 2 * element[i];
    dofs[2 * i + 1] = 2 * element[i] + 1;
  }
  return dofs;
}

function buildDeformationElementCaches(mesh) {
  const elementType = normalizeElementType(mesh?.elementType);
  const kernel = elementKernelFor(elementType);
  let integrationPointCount = 0;
  const caches = mesh.elements.map((element, elementIndex) => {
    const nodes = element.map((nodeId) => mesh.nodes[nodeId]);
    const corners = element.slice(0, 3).map((nodeId) => mesh.nodes[nodeId]);
    const area = triangleArea(corners);
    const centroid = mesh.elementData[elementIndex]?.centroid || mesh.cells[mesh.elementCell[elementIndex]]?.centroid || {
      x: (corners[0].x + corners[1].x + corners[2].x) / 3,
      y: (corners[0].y + corners[1].y + corners[2].y) / 3
    };
    const integrationPoints = kernel.gaussPointsXY(corners).map((gp, gpIndex) => {
      const B = kernel.buildBAtGauss(corners, gp.L1, gp.L2, gp.L3);
      const globalIndex = integrationPointCount;
      integrationPointCount += 1;
      return {
        ...gp,
        gpIndex,
        globalIndex,
        materialPointIndex: globalIndex,
        areaWeight: area * (Number(gp.areaWeightFactor) || 1),
        B
      };
    });
    return {
      elementIndex,
      cellIndex: mesh.elementCell[elementIndex],
      element,
      kind: elementType,
      kernel,
      localDofCount: kernel.numDofs,
      numGaussPoints: kernel.numGaussPoints,
      nodes,
      corners,
      area,
      B: integrationPoints[0]?.B || null,
      centroid,
      integrationPoints,
      dofs: Int32Array.from(elementDofMap(element)),
      freeRowIndices: null,
      assemblyLocalSlots: null
    };
  });
  caches.integrationPointCount = integrationPointCount;
  return caches;
}

function buildCompressedAssemblyPattern(elementCaches, freeIndexByDof, freeDofCount) {
  const rowColSets = Array.from({ length: freeDofCount }, () => new Set());

  elementCaches.forEach((elementCache) => {
    const localDofCount = elementCache.dofs.length;
    const freeRowIndices = new Int32Array(localDofCount);
    freeRowIndices.fill(-1);
    for (let localIndex = 0; localIndex < localDofCount; localIndex += 1) {
      const freeRowIndex = freeIndexByDof.get(elementCache.dofs[localIndex]);
      if (freeRowIndex != null) freeRowIndices[localIndex] = freeRowIndex;
    }
    elementCache.freeRowIndices = freeRowIndices;
    elementCache.assemblyLocalSlots = new Int32Array(localDofCount * localDofCount);
    elementCache.assemblyLocalSlots.fill(-1);
    for (let localRow = 0; localRow < localDofCount; localRow += 1) {
      const freeRowIndex = freeRowIndices[localRow];
      if (freeRowIndex < 0) continue;
      for (let localCol = 0; localCol < localDofCount; localCol += 1) {
        const freeColIndex = freeRowIndices[localCol];
        if (freeColIndex < 0) continue;
        rowColSets[freeRowIndex].add(freeColIndex);
      }
    }
  });

  const rowTemplates = rowColSets.map((rowSet, rowIndex) => {
    const indices = Int32Array.from([...rowSet].sort((left, right) => left - right));
    const slotByCol = new Map();
    let diagIndex = -1;
    for (let slotIndex = 0; slotIndex < indices.length; slotIndex += 1) {
      slotByCol.set(indices[slotIndex], slotIndex);
      if (indices[slotIndex] === rowIndex) diagIndex = slotIndex;
    }
    return { indices, diagIndex, slotByCol };
  });

  elementCaches.forEach((elementCache) => {
    const localDofCount = elementCache.dofs.length;
    for (let localRow = 0; localRow < localDofCount; localRow += 1) {
      const freeRowIndex = elementCache.freeRowIndices[localRow];
      if (freeRowIndex < 0) continue;
      const template = rowTemplates[freeRowIndex];
      for (let localCol = 0; localCol < localDofCount; localCol += 1) {
        const freeColIndex = elementCache.freeRowIndices[localCol];
        if (freeColIndex < 0) continue;
        const slotIndex = template.slotByCol.get(freeColIndex);
        if (slotIndex != null) elementCache.assemblyLocalSlots[localRow * localDofCount + localCol] = slotIndex;
      }
    }
  });

  return {
    rows: rowTemplates.map((rowTemplate) => ({
      indices: rowTemplate.indices,
      diagIndex: rowTemplate.diagIndex
    }))
  };
}

function createCompressedRowsFromPattern(pattern) {
  return pattern.rows.map((rowTemplate) => ({
    indices: rowTemplate.indices,
    values: new Float64Array(rowTemplate.indices.length),
    diagIndex: rowTemplate.diagIndex,
    diag: 0
  }));
}

function finalizeCompressedRows(rows) {
  rows.forEach((row) => {
    row.diag = row.diagIndex >= 0 ? row.values[row.diagIndex] || 0 : 0;
  });
}

function expandSolutionVector(ndof, freeDofs, fixedValues, freeSolution) {
  const U = new Float64Array(ndof);
  fixedValues.forEach((value, dof) => {
    U[dof] = value;
  });
  freeDofs.forEach((dof, index) => {
    U[dof] = freeSolution[index];
  });
  return U;
}

function multiplyBDisplacement(matrix, displacementVector, dofs) {
  const out = { exx: 0, eyy: 0, gxy: 0 };
  for (let i = 0; i < dofs.length; i += 1) {
    const u = Number(displacementVector?.[dofs[i]]) || 0;
    out.exx += (Number(matrix?.[0]?.[i]) || 0) * u;
    out.eyy += (Number(matrix?.[1]?.[i]) || 0) * u;
    out.gxy += (Number(matrix?.[2]?.[i]) || 0) * u;
  }
  return out;
}

function gatherElementDisplacements(displacementVector, dofs) {
  const out = new Float64Array(dofs.length);
  for (let i = 0; i < dofs.length; i += 1) out[i] = Number(displacementVector?.[dofs[i]]) || 0;
  return out;
}

function multiplyMat3x6Displacement(matrix, displacementVector, dofs) {
  if ((dofs?.length || 0) !== 6) return multiplyBDisplacement(matrix, displacementVector, dofs || []);
  const u0 = displacementVector[dofs[0]];
  const u1 = displacementVector[dofs[1]];
  const u2 = displacementVector[dofs[2]];
  const u3 = displacementVector[dofs[3]];
  const u4 = displacementVector[dofs[4]];
  const u5 = displacementVector[dofs[5]];
  return {
    exx: matrix[0][0] * u0 + matrix[0][1] * u1 + matrix[0][2] * u2 + matrix[0][3] * u3 + matrix[0][4] * u4 + matrix[0][5] * u5,
    eyy: matrix[1][0] * u0 + matrix[1][1] * u1 + matrix[1][2] * u2 + matrix[1][3] * u3 + matrix[1][4] * u4 + matrix[1][5] * u5,
    gxy: matrix[2][0] * u0 + matrix[2][1] * u1 + matrix[2][2] * u2 + matrix[2][3] * u3 + matrix[2][4] * u4 + matrix[2][5] * u5
  };
}

function buildIntegrationPointAnalysisStateFromStrain(elementCache, gp, strain, ue = null) {
  return {
    element: elementCache.element,
    nodes: elementCache.nodes,
    corners: elementCache.corners,
    ue,
    area: elementCache.area,
    areaWeight: gp?.areaWeight ?? elementCache.area,
    B: gp?.B || elementCache.B,
    gpIndex: gp?.gpIndex ?? 0,
    integrationPointIndex: gp?.globalIndex ?? gp?.materialPointIndex ?? elementCache.elementIndex,
    x: gp?.x ?? elementCache.centroid?.x ?? 0,
    y: gp?.y ?? elementCache.centroid?.y ?? 0,
    strain,
    strainTrial6: liftPlaneStrainStrainTo6(strain)
  };
}

function buildIntegrationPointAnalysisState(elementCache, gp, U, precomputedStrain = null) {
  if (precomputedStrain) {
    return buildIntegrationPointAnalysisStateFromStrain(elementCache, gp, precomputedStrain, null);
  }
  const strain = multiplyBDisplacement(gp?.B || elementCache.B, U, elementCache.dofs);
  return buildIntegrationPointAnalysisStateFromStrain(elementCache, gp, strain, gatherElementDisplacements(U, elementCache.dofs));
}

function buildElementAnalysisState(elementCache, U, precomputedStrain = null) {
  const gp = elementCache.integrationPoints?.[0] || {
    gpIndex: 0,
    globalIndex: elementCache.elementIndex,
    areaWeight: elementCache.area,
    B: elementCache.B,
    x: elementCache.centroid?.x ?? 0,
    y: elementCache.centroid?.y ?? 0
  };
  return buildIntegrationPointAnalysisState(elementCache, gp, U, precomputedStrain);
}

function addElementInternalForceContributionToFreeRhs(target, elementCache, stress2D) {
  const freeRowIndices = elementCache?.freeRowIndices;
  const B = elementCache?.B;
  const area = Number(elementCache?.area) || 0;
  const sxx = Number(stress2D?.sxx) || 0;
  const syy = Number(stress2D?.syy) || 0;
  const txy = Number(stress2D?.txy) || 0;
  for (let localIndex = 0; localIndex < 6; localIndex += 1) {
    const freeRowIndex = freeRowIndices?.[localIndex];
    if (freeRowIndex < 0) continue;
    target[freeRowIndex] += area * (
      (Number(B?.[0]?.[localIndex]) || 0) * sxx
      + (Number(B?.[1]?.[localIndex]) || 0) * syy
      + (Number(B?.[2]?.[localIndex]) || 0) * txy
    );
  }
}

function recoverIntegrationPointMaterialResponse(elementCache, gp, U, materialPoint, analysisContext = null, precomputedStrain = null) {
  const elementState = buildIntegrationPointAnalysisState(elementCache, gp, U, precomputedStrain);
  const previousTrialState = materialPoint.trialState ? cloneMaterialPointState(materialPoint.trialState) : cloneMaterialPointState(materialPoint.committedState);
  const materialParametersOverride = analysisContext?.materialParametersOverride || null;
  const update = materialPoint.materialModel.update({
    strainTrial6: elementState.strainTrial6,
    committedState: materialPoint.committedState,
    materialParameters: materialParametersOverride || materialPoint.materialParameters,
    analysisContext: {
      ...analysisContext,
      previousTrialState,
      elementIndex: elementCache.elementIndex,
      gpIndex: gp?.gpIndex ?? 0,
      integrationPointIndex: gp?.globalIndex ?? gp?.materialPointIndex ?? elementCache.elementIndex,
      regionIndex: materialPoint.regionIndex
    }
  });
  const globalizationTangent6x6 = analysisContext?.useElasticGlobalizationTangent === true &&
    materialPoint.materialModel?.kind === 'mc-plastic' &&
    Array.isArray(materialPoint.materialModel?.elasticTangent6x6)
    ? materialPoint.materialModel.elasticTangent6x6
    : update.tangent6x6;
  return {
    ...elementState,
    stress2D: extractStress2DFrom6(update.stressTrial6),
    tangent2D: extractTangent2DFrom6(globalizationTangent6x6),
    update,
    materialParameters: materialParametersOverride || materialPoint.materialParameters
  };
}

function recoverElementMaterialResponse(elementCache, U, materialPoint, analysisContext = null, precomputedStrain = null) {
  const gp = elementCache.integrationPoints?.[0] || {
    gpIndex: 0,
    globalIndex: elementCache.elementIndex,
    areaWeight: elementCache.area,
    B: elementCache.B,
    x: elementCache.centroid?.x ?? 0,
    y: elementCache.centroid?.y ?? 0
  };
  return recoverIntegrationPointMaterialResponse(elementCache, gp, U, materialPoint, analysisContext, precomputedStrain);
}

function fallbackK0(phiEffDeg) {
  const phi = (Math.max(Number(phiEffDeg) || 0, 0) * Math.PI) / 180;
  return Math.max(1 - Math.sin(phi), 0);
}

function totalStress6ToCompressionPositiveStress3D(stress6) {
  return {
    sxx: -(Number(stress6?.[0]) || 0),
    syy: -(Number(stress6?.[1]) || 0),
    szz: -(Number(stress6?.[2]) || 0),
    txy: -(Number(stress6?.[3]) || 0)
  };
}

function buildK0ControlledInitialEffectiveStress6(totalStress6, materialParameters, porePressure = 0) {
  const totalStress = totalStress6ToCompressionPositiveStress3D(totalStress6);
  const u0 = Math.max(Number(porePressure) || 0, 0);
  const sigmaV0Eff = Math.max(totalStress.syy - u0, 0);
  const K0 = Number.isFinite(Number(materialParameters?.K0nc))
    ? Math.max(Number(materialParameters.K0nc), 0)
    : fallbackK0(materialParameters?.phiEffDeg);
  const sigmaH0Eff = K0 * sigmaV0Eff;
  return [
    -sigmaH0Eff,
    -sigmaV0Eff,
    -sigmaH0Eff,
    -(Number(totalStress.txy) || 0),
    0,
    0
  ];
}

function integrationPointStressSeedPoints(mesh, elementCaches) {
  const out = [];
  elementCaches.forEach((elementCache) => {
    const cell = mesh.cells[elementCache.cellIndex];
    (elementCache.integrationPoints || []).forEach((gp) => {
      out[gp.globalIndex] = {
        x: gp.x,
        y: gp.y,
        regionIndex: cell?.regionIndex ?? -1,
        material: cell?.material || null
      };
    });
  });
  return out;
}

function buildFlatK0InitialEffectiveStressFieldForIntegrationPoints(mesh, elementCaches, model, options, warnings) {
  return buildFlatK0InitialEffectiveStressFieldAtPoints(
    integrationPointStressSeedPoints(mesh, elementCaches),
    model,
    options,
    warnings
  );
}

function recoverInitialFieldFromGeostaticSolution(mesh, elementCaches, Ugeo, regionConstitutiveByRegion, options, porePressureByIntegrationPoint, warnings) {
  const out = new Array(elementCaches.integrationPointCount || elementCaches.length);
  const precomputedStrainFlat = backendElementStrain(elementCaches, Ugeo);
  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const cell = mesh.cells[elementCache.cellIndex];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    for (const gp of elementCache.integrationPoints || []) {
      const materialPoint = createMaterialPoint({
        materialModel: createLinearElasticMaterial(constitutive.materialParameters, warnings),
        materialParameters: constitutive.materialParameters,
        elementIndex,
        integrationPointIndex: gp.globalIndex,
        gpIndex: gp.gpIndex,
        regionIndex: cell?.regionIndex ?? -1
      });
      const precomputedStrain = precomputedStrainFlat && elementCache.kind === 't3'
        ? {
            exx: Number(precomputedStrainFlat[elementIndex * 3]) || 0,
            eyy: Number(precomputedStrainFlat[elementIndex * 3 + 1]) || 0,
            gxy: Number(precomputedStrainFlat[elementIndex * 3 + 2]) || 0
          }
        : null;
      const response = recoverIntegrationPointMaterialResponse(elementCache, gp, Ugeo, materialPoint, {
        stage: 'geostatic-initialization'
      }, precomputedStrain);
      const u0 = Math.max(Number(porePressureByIntegrationPoint?.[gp.globalIndex]) || 0, 0);
      out[gp.globalIndex] = buildK0ControlledInitialEffectiveStress6(response.update?.stressTrial6, constitutive.materialParameters, u0);
    }
  }
  return out;
}

async function buildGeostaticInitialization(
  mesh,
  elementCaches,
  model,
  options,
  warnings,
  regionConstitutiveByRegion,
  ndof,
  compressedRows,
  freeDofs,
  fixedValues,
  gravityCompressedRhs,
  porePressureByIntegrationPoint,
  runControl,
  onProgress
) {
  onProgress({
    stage: 'solving',
    percent: 64,
    message: 'Solving the geostatic gravity step for the initial stress field...'
  });

  const geostaticCg = await solveCg(
    compressedRows,
    gravityCompressedRhs,
    null,
    MAX_CG_ITER,
    CG_REL_TOL,
    CG_ABS_TOL,
    runControl,
    async ({ iterations, relativeResidual }) => {
      const percent = Math.min(69, 64 + Math.min(iterations / GEOSTATIC_CG_PROGRESS_INTERVAL, 5));
      onProgress({
        stage: 'solving',
        percent,
        message: `Solving the geostatic gravity step for the initial stress field... CG iter ${iterations.toLocaleString()}, relative residual ${relativeResidual.toExponential(2)}`
      });
      await runCheckpoint(runControl);
    }
  );
  if (geostaticCg.interrupted) {
    throw new Error('Deformation run was interrupted before geostatic initialization became available.');
  }

  if (!geostaticCg.converged) {
    pushUniqueWarning(
      warnings,
      `Geostatic gravity-step initialization did not converge (residual ${geostaticCg.residualNorm.toExponential(2)} after ${geostaticCg.iterations} iterations), so the deformation screen fell back to flat-ground K0 initial stress.`
    );
    return {
      initialField: buildFlatK0InitialEffectiveStressFieldForIntegrationPoints(mesh, elementCaches, model, options, warnings),
      mode: 'flat-k0-fallback',
      iterations: geostaticCg.iterations,
      residualNorm: geostaticCg.residualNorm,
      solution: new Float64Array(ndof)
    };
  }

  const Ugeo = expandSolutionVector(ndof, freeDofs, fixedValues, geostaticCg.solution);
  const initialField = recoverInitialFieldFromGeostaticSolution(mesh, elementCaches, Ugeo, regionConstitutiveByRegion, options, porePressureByIntegrationPoint, warnings);
  const hasInvalidStress = initialField.some((stress6) => !Array.isArray(stress6) || stress6.some((value) => !Number.isFinite(Number(value))));
  if (hasInvalidStress) {
    pushUniqueWarning(
      warnings,
      'Geostatic gravity-step initialization produced an invalid stress state, so the deformation screen fell back to flat-ground K0 initial stress.'
    );
    return {
      initialField: buildFlatK0InitialEffectiveStressFieldForIntegrationPoints(mesh, elementCaches, model, options, warnings),
      mode: 'flat-k0-fallback',
      iterations: geostaticCg.iterations,
      residualNorm: geostaticCg.residualNorm,
      solution: new Float64Array(ndof)
    };
  }

  return {
    initialField,
    mode: 'gravity-step-k0nc',
    iterations: geostaticCg.iterations,
    residualNorm: geostaticCg.residualNorm,
    solution: Ugeo
  };
}

function buildElementMaterialPoints(mesh, elementCaches, regionConstitutiveByRegion, initialField, options, warnings) {
  const materialPoints = new Array(elementCaches.integrationPointCount || elementCaches.length);
  elementCaches.forEach((elementCache) => {
    const elementIndex = elementCache.elementIndex;
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    (elementCache.integrationPoints || []).forEach((gp) => {
      const initialStress6 = initialField?.[gp.globalIndex];
      const committedState = Array.isArray(initialStress6)
        ? seedMaterialPointStateFromEffectiveStress6(initialStress6, constitutive.materialParameters)
        : seedMaterialPointStateFromInitialStress(initialStress6, constitutive.materialParameters);
      materialPoints[gp.globalIndex] = createMaterialPoint({
        materialModel: constitutive.materialModel,
        materialParameters: constitutive.materialParameters,
        committedState,
        elementIndex,
        integrationPointIndex: gp.globalIndex,
        gpIndex: gp.gpIndex,
        regionIndex: cell?.regionIndex ?? -1
      });
    });
  });
  return materialPoints;
}

function resetMaterialPointTrials(materialPoints) {
  materialPoints.forEach((materialPoint) => {
    materialPoint.trialState = cloneMaterialPointState(materialPoint.committedState);
    materialPoint.diagnostics = null;
  });
}

function setReferenceStateFromCommittedStates(materialPoints) {
  materialPoints.forEach((materialPoint) => {
    setMaterialPointReferenceState(materialPoint, materialPoint.committedState, {
      referenceMode: 'equilibrated-initial',
      materialParameters: materialPoint.materialParameters
    });
  });
}

async function assembleNonlinearSystem(
  elementCaches,
  assemblyPattern,
  UTrial,
  materialPoints,
  loadRhsFreeBase,
  loadFactor,
  runControl,
  stageLabel = 'nonlinear-stage',
  formulationMode = 'incremental',
  targetForceFreeOverride = null,
  elementAnalysisOptions = null
) {
  const compressedRows = createCompressedRowsFromPattern(assemblyPattern);
  const internalForceFree = new Float64Array(loadRhsFreeBase.length);
  let activeCount = 0;
  let activeFaceCount = 0;
  let activeEdgeCount = 0;
  let activeApexCount = 0;
  let tensionPendingCount = 0;
  let changedCount = 0;
  let maxEta = 0;
  let maxStrengthReserve = 0;
  const precomputedStrainFlat = backendElementStrain(elementCaches, UTrial);
  const usesBackendInternalForce = !!(
    activeMatvecBackend &&
    typeof activeMatvecBackend.elementInternalForce === 'function' &&
    elementCaches.every((elementCache) => elementCache?.kind === 't3')
  );
  const stressContributionFlat = usesBackendInternalForce
    ? new Float64Array(elementCaches.length * 3)
    : null;

  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const tangentsAtGp = new Array(elementCache.numGaussPoints);
    const stressContributionAtGp = new Array(elementCache.numGaussPoints);
    let elementActive = false;
    let elementFaceActive = false;
    let elementEdgeActive = false;
    let elementApexActive = false;
    let elementTensionPending = false;
    let elementChanged = false;

    for (const gp of elementCache.integrationPoints || []) {
      const materialPoint = materialPoints[gp.globalIndex];
      const previousTrialActive = materialPoint.trialState?.currentlyMcActive === true;
      const materialParametersOverride = elementAnalysisOptions?.regionMaterialParametersByRegion?.get(materialPoint.regionIndex)
        || null;
      const precomputedStrain = precomputedStrainFlat && elementCache.kind === 't3'
        ? {
            exx: Number(precomputedStrainFlat[elementIndex * 3]) || 0,
            eyy: Number(precomputedStrainFlat[elementIndex * 3 + 1]) || 0,
            gxy: Number(precomputedStrainFlat[elementIndex * 3 + 2]) || 0
          }
        : null;
      const response = recoverIntegrationPointMaterialResponse(elementCache, gp, UTrial, materialPoint, {
        stage: stageLabel,
        loadFactor,
        useElasticGlobalizationTangent: elementAnalysisOptions?.useElasticGlobalizationTangent === true,
        materialParametersOverride
      }, precomputedStrain);
      materialPoint.trialState = response.update.trialState;
      materialPoint.diagnostics = response.update.diagnostics;
      const currentTrialActive = response.update.trialState?.currentlyMcActive === true;
      elementActive = elementActive || currentTrialActive;
      const branchCounts = branchActivityCounts(response.update.trialState);
      elementFaceActive = elementFaceActive || branchCounts.face > 0;
      elementEdgeActive = elementEdgeActive || branchCounts.edge > 0;
      elementApexActive = elementApexActive || branchCounts.apex > 0;
      elementTensionPending = elementTensionPending || branchCounts.tension > 0;
      elementChanged = elementChanged || currentTrialActive !== previousTrialActive;
      maxEta = Math.max(maxEta, Number(response.update.diagnostics?.etaMcFinal) || 0);
      maxStrengthReserve = Math.max(maxStrengthReserve, Number(response.update.diagnostics?.localStrengthReserve) || 0);

      tangentsAtGp[gp.gpIndex] = response.tangent2D;
      const referenceStress2D = extractStress2DFrom6(materialPoint.referenceState?.effectiveStress6);
      stressContributionAtGp[gp.gpIndex] = formulationMode === 'total'
        ? response.stress2D
        : {
            sxx: response.stress2D.sxx - referenceStress2D.sxx,
            syy: response.stress2D.syy - referenceStress2D.syy,
            txy: response.stress2D.txy - referenceStress2D.txy
          };
    }

    if (elementActive) activeCount += 1;
    if (elementFaceActive) activeFaceCount += 1;
    if (elementEdgeActive) activeEdgeCount += 1;
    if (elementApexActive) activeApexCount += 1;
    if (elementTensionPending) tensionPendingCount += 1;
    if (elementChanged) changedCount += 1;

    addMatrixBlockToCompressedRows(
      compressedRows,
      elementCache,
      elementCache.kernel.elementStiffness(elementCache.corners, tangentsAtGp, elementCache.area, elementCache)
    );

    if (stressContributionFlat && elementCache.kind === 't3') {
      const stressContribution2D = stressContributionAtGp[0];
      const stressBase = elementIndex * 3;
      stressContributionFlat[stressBase] = Number(stressContribution2D.sxx) || 0;
      stressContributionFlat[stressBase + 1] = Number(stressContribution2D.syy) || 0;
      stressContributionFlat[stressBase + 2] = Number(stressContribution2D.txy) || 0;
    } else {
      addVectorBlockToFreeRhs(
        internalForceFree,
        elementCache.freeRowIndices,
        elementCache.kernel.elementInternalForce(elementCache.corners, stressContributionAtGp, elementCache.area, elementCache)
      );
    }

    if (elementIndex % 200 === 0 && (await runCheckpoint(runControl))) {
      throw new Error('Deformation run was interrupted during nonlinear assembly.');
    }
  }

  if (stressContributionFlat) {
    const elementForceFlat = backendElementInternalForce(elementCaches, stressContributionFlat);
    if (elementForceFlat) {
      for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
        addVectorBlockFlatToFreeRhs(
          internalForceFree,
          elementCaches[elementIndex].freeRowIndices,
          elementForceFlat,
          elementIndex * 6
        );
      }
    } else {
      for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
        const elementCache = elementCaches[elementIndex];
        const stressBase = elementIndex * 3;
        addElementInternalForceContributionToFreeRhs(internalForceFree, elementCache, {
          sxx: stressContributionFlat[stressBase],
          syy: stressContributionFlat[stressBase + 1],
          txy: stressContributionFlat[stressBase + 2]
        });
      }
    }
  }

  finalizeCompressedRows(compressedRows);
  const targetForceFree = targetForceFreeOverride && targetForceFreeOverride.length === loadRhsFreeBase.length
    ? Float64Array.from(targetForceFreeOverride)
    : cloneScaledVector(loadRhsFreeBase, loadFactor);
  const residualFree = cloneScaledVector(targetForceFree, 1);
  addScaledVectorInPlace(residualFree, internalForceFree, -1);
  let residualNorm2 = 0;
  let rhsNorm2 = 0;
  for (let index = 0; index < residualFree.length; index += 1) {
    const residualValue = residualFree[index];
    const rhsValue = targetForceFree[index];
    residualNorm2 += residualValue * residualValue;
    rhsNorm2 += rhsValue * rhsValue;
  }

  return {
    compressedRows,
    internalForceFree,
    residualFree,
    targetForceFree,
    residualNorm: Math.sqrt(residualNorm2),
    rhsNorm: Math.sqrt(rhsNorm2),
    activeCount,
    activeFaceCount,
    activeEdgeCount,
    activeApexCount,
    tensionPendingCount,
    changedCount,
    maxEta,
    maxStrengthReserve
  };
}

async function performArmijoLineSearch(
  elementCaches,
  assemblyPattern,
  uBase,
  correction,
  currentResidualNorm,
  linearizedResidualNorm,
  materialPoints,
  loadRhsFreeBase,
  targetLoadFactor,
  runControl,
  analysisStageLabel,
  formulationMode = 'incremental',
  targetForceFreeOverride = null,
  elementAnalysisOptions = null,
  lineSearchOptions = {}
) {
  const reductionFactor = Math.min(Math.max(Number(lineSearchOptions?.reductionFactor) || 0.5, 0.1), 0.95);
  const minStepScale = Math.min(Math.max(Number(lineSearchOptions?.minStepScale) || 1 / 64, 1e-4), 1);
  const maxBacktracks = Math.max(Math.round(Number(lineSearchOptions?.maxBacktracks) || 5), 1);
  const armijoCoefficient = Math.max(Number(lineSearchOptions?.armijoCoefficient ?? lineSearchOptions?.sufficientDecreaseFactor) || 1e-4, 0);
  const currentMerit = evaluateResidualMerit(currentResidualNorm);
  const directionalDerivative = approximateNewtonMeritDirectionalDerivative(currentResidualNorm, linearizedResidualNorm);
  let best = null;
  let stepScale = 1;
  let evaluations = 0;

  for (let index = 0; index < maxBacktracks; index += 1) {
    evaluations += 1;
    const uCandidate = Float64Array.from(uBase);
    addScaledVectorInPlace(uCandidate, correction, stepScale);
    resetMaterialPointTrials(materialPoints);
    const assembly = await assembleNonlinearSystem(
      elementCaches,
      assemblyPattern,
      uCandidate,
      materialPoints,
      loadRhsFreeBase,
      targetLoadFactor,
      runControl,
      analysisStageLabel,
      formulationMode,
      targetForceFreeOverride,
      elementAnalysisOptions
    );
    const residualNorm = Number.isFinite(Number(assembly?.residualNorm))
      ? Number(assembly.residualNorm)
      : vectorNorm(assembly.residualFree);
    const candidateMerit = evaluateResidualMerit(residualNorm);
    const improved = candidateMerit < currentMerit - Math.max(1e-16, 1e-12 * Math.max(currentMerit, 1));
    const armijoTarget = currentMerit + armijoCoefficient * stepScale * Math.min(directionalDerivative, 0);
    const accepted = candidateMerit <= Math.max(armijoTarget, 0);
    if (
      !best
      || candidateMerit < best.candidateMerit - Math.max(1e-16, 1e-12 * Math.max(best.candidateMerit, 1))
      || (
        Math.abs(candidateMerit - best.candidateMerit) <= Math.max(1e-16, 1e-12 * Math.max(candidateMerit, best.candidateMerit, 1))
        && residualNorm < best.residualNorm
      )
    ) {
      best = {
        stepScale,
        residualNorm,
        candidateMerit,
        uCandidate,
        assembly,
        improved,
        accepted,
        currentMerit,
        directionalDerivative,
        armijoTarget,
        evaluations
      };
    }
    if (accepted) return best;
    if (stepScale <= minStepScale + 1e-12) break;
    stepScale = Math.max(stepScale * reductionFactor, minStepScale);
  }

  return best
    ? {
        ...best,
        accepted: false,
        evaluations
      }
    : null;
}

function shouldPreferDisplayCandidate(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  if ((Number(candidate.loadFactor) || 0) > (Number(current.loadFactor) || 0) + 1e-10) return true;
  if ((Number(candidate.loadFactor) || 0) < (Number(current.loadFactor) || 0) - 1e-10) return false;
  return (Number(candidate.residualNorm) || Number.POSITIVE_INFINITY) < (Number(current.residualNorm) || Number.POSITIVE_INFINITY) - 1e-12;
}

function snapshotDisplayedState(solution, loadFactor, assembly, mode, reason = '') {
  if (!solution || !(solution.length > 0)) return null;
  const targetForceFree = assembly?.targetForceFree;
  const residualFree = assembly?.residualFree;
  const residualNorm = Number.isFinite(Number(assembly?.residualNorm))
    ? Number(assembly.residualNorm)
    : (residualFree ? vectorNorm(residualFree) : Number.POSITIVE_INFINITY);
  const rhsNorm = Number.isFinite(Number(assembly?.rhsNorm))
    ? Number(assembly.rhsNorm)
    : (targetForceFree ? vectorNorm(targetForceFree) : 0);
  const relativeResidualNorm = rhsNorm > CG_NUMERIC_EPS
    ? residualNorm / rhsNorm
    : (Number.isFinite(Number(assembly?.relativeResidualNorm)) ? Number(assembly.relativeResidualNorm) : (residualNorm > 0 ? Number.POSITIVE_INFINITY : 0));
  return {
    solution: Float64Array.from(solution),
    loadFactor: Math.max(Number(loadFactor) || 0, 0),
    residualNorm,
    relativeResidualNorm,
    activeCount: Number(assembly?.activeCount) || 0,
    activeFaceCount: Number(assembly?.activeFaceCount) || 0,
    activeEdgeCount: Number(assembly?.activeEdgeCount) || 0,
    activeApexCount: Number(assembly?.activeApexCount) || 0,
    tensionPendingCount: Number(assembly?.tensionPendingCount) || 0,
    maxEta: Number(assembly?.maxEta) || 0,
    stateChanges: Number(assembly?.changedCount) || 0,
    mode,
    reason
  };
}

async function solveNonlinearPhase(
  elementCaches,
  assemblyPattern,
  loadRhsFreeBase,
  materialPoints,
  ndof,
  freeDofs,
  fixedValues,
  runControl,
  onProgress,
  options = {},
  phaseConfig = {}
) {
  const constitutiveModel = options?.constitutiveModel === 'linear-elastic'
    ? 'linear-elastic'
    : options?.constitutiveModel === 'mc-plastic'
      ? 'mc-plastic'
      : 'mc-reduced-stiffness';
  const phaseKind = phaseConfig?.phaseKind === 'initial-gravity'
    ? 'initial-gravity'
    : phaseConfig?.phaseKind === 'safety-cphi'
      ? 'safety-cphi'
      : 'service-load';
  const formulationMode = phaseConfig?.formulationMode === 'total' ? 'total' : 'incremental';
  const allowLoadStepping = phaseConfig?.allowLoadStepping !== false;
  const targetLoadFactorFinal = Math.max(Number(phaseConfig?.targetLoadFactor) || 1, 0);
  const initialCommittedLoadFactor = Math.max(Math.min(Number(phaseConfig?.initialLoadFactorCommitted) || 0, targetLoadFactorFinal), 0);
  const initialSolutionInput = phaseConfig?.initialSolution;
  const isLinearElastic = constitutiveModel === 'linear-elastic';
  const requiresStableActiveSet = constitutiveModel === 'mc-reduced-stiffness';
  const requiresDisplacementTolerance = constitutiveModel !== 'mc-plastic';
  const exactPlasticTangentMayBeUnsymmetric = constitutiveModel === 'mc-plastic' &&
    materialPoints.some((materialPoint) => materialPoint?.materialParameters?.symmetrizeEpTangent !== true);
  // The modified-Newton elastic globalization tangent is a robustness fallback
  // for difficult initial-gravity runs, but it is much slower and should not
  // be the default Phase 0b path.
  const phaseUsesElasticGlobalizationTangent = constitutiveModel === 'mc-plastic' &&
    phaseKind === 'initial-gravity' &&
    options?.initialGravityUseElasticGlobalizationTangent === true;
  const mayNeedUnsymmetricSolver = constitutiveModel === 'mc-plastic' && !phaseUsesElasticGlobalizationTangent && (
    exactPlasticTangentMayBeUnsymmetric ||
    options?.useUnsymmetricPlasticSolver === true
  );
  const unsymmetricLinearSolverMode = options?.unsymmetricLinearSolver === 'bicgstab'
    ? 'bicgstab'
    : 'gmres-scaled';
  const isInitialGravityPhase = phaseKind === 'initial-gravity';
  const maxIterations = Math.max(Math.round(Number(options?.nonlinearMaxIterations) || NONLINEAR_MAX_ITER), 1);
  const growthFactor = Math.max(Number(options?.loadStepGrowthFactor) || NONLINEAR_GROWTH_FACTOR, 1);
  const cutbackFactor = Math.min(Math.max(Number(options?.loadStepCutbackFactor) || NONLINEAR_CUTBACK_FACTOR, 0.1), 0.9);
  const plasticGrowthFactor = Math.max(
    Number(
      isInitialGravityPhase
        ? (options?.initialGravityPlasticLoadStepGrowthFactor ?? options?.plasticLoadStepGrowthFactor)
        : options?.plasticLoadStepGrowthFactor
    ) || (isInitialGravityPhase ? 1.12 : 1.05),
    1
  );
  const plasticCutbackFactor = Math.min(
    Math.max(
      Number(
        isInitialGravityPhase
          ? (options?.initialGravityPlasticLoadStepCutbackFactor ?? options?.plasticLoadStepCutbackFactor)
          : options?.plasticLoadStepCutbackFactor
      ) || (isInitialGravityPhase ? 0.5 : 0.4),
      0.1
    ),
    0.9
  );
  const minLoadStep = Math.max(
    Number(isInitialGravityPhase ? (options?.initialGravityMinLoadStep ?? options?.minLoadStep) : options?.minLoadStep)
      || (isInitialGravityPhase ? (1 / 8192) : NONLINEAR_MIN_LOAD_STEP),
    1e-5
  );
  let stepSize = isLinearElastic
    ? 1
    : Math.min(Math.max(Number(options?.initialLoadStep) || NONLINEAR_INITIAL_LOAD_STEP, minLoadStep), 1);
  const maxLoadSteps = allowLoadStepping
    ? Math.max(
      Math.round(
        Number(isInitialGravityPhase ? (options?.initialGravityMaxLoadSteps ?? options?.maxLoadSteps) : options?.maxLoadSteps)
          || (isInitialGravityPhase ? 512 : NONLINEAR_MAX_LOAD_STEPS)
      ),
      1
    )
    : 1;
  const plasticLineSearchOptions = {
    reductionFactor: Number(options?.plasticLineSearchReductionFactor) || 0.5,
    minStepScale: Number(isInitialGravityPhase ? (options?.initialGravityPlasticLineSearchMinScale ?? options?.plasticLineSearchMinScale) : options?.plasticLineSearchMinScale)
      || (isInitialGravityPhase ? 1 / 32 : 1 / 64),
    maxBacktracks: Math.max(
      Math.round(
        Number(isInitialGravityPhase ? (options?.initialGravityPlasticLineSearchMaxBacktracks ?? options?.plasticLineSearchMaxBacktracks) : options?.plasticLineSearchMaxBacktracks)
          || (isInitialGravityPhase ? 5 : 4)
      ),
      1
    ),
    armijoCoefficient: Number(isInitialGravityPhase
      ? (options?.initialGravityPlasticLineSearchArmijoCoefficient
          ?? options?.initialGravityPlasticLineSearchSufficientDecreaseFactor
          ?? options?.plasticLineSearchArmijoCoefficient
          ?? options?.plasticLineSearchSufficientDecreaseFactor)
      : (options?.plasticLineSearchArmijoCoefficient ?? options?.plasticLineSearchSufficientDecreaseFactor)) || 1e-4
  };
  const useAdaptiveContinuation = options?.adaptiveContinuation !== false;
  const continuationTargetIterations = Math.max(
    Number(
      isInitialGravityPhase
        ? (options?.initialGravityContinuationTargetIterations ?? options?.continuationTargetIterations)
        : phaseKind === 'safety-cphi'
          ? (options?.safetyContinuationTargetIterations ?? options?.continuationTargetIterations)
          : options?.continuationTargetIterations
    ) || NONLINEAR_CONTINUATION_TARGET_ITERATIONS,
    1
  );
  const continuationTargetLineSearchScale = Math.max(
    Math.min(Number(options?.continuationTargetLineSearchScale) || NONLINEAR_CONTINUATION_TARGET_LINE_SEARCH_SCALE, 1),
    1e-6
  );
  const continuationIterationExponent = Math.max(Number(options?.continuationIterationExponent) || NONLINEAR_CONTINUATION_ITERATION_EXPONENT, 0);
  const continuationLineSearchExponent = Math.max(Number(options?.continuationLineSearchExponent) || NONLINEAR_CONTINUATION_LINE_SEARCH_EXPONENT, 0);

  if (!allowLoadStepping) stepSize = targetLoadFactorFinal;

  let loadFactorCommitted = initialCommittedLoadFactor;
  let uCommitted = initialSolutionInput
    ? Float64Array.from(initialSolutionInput)
    : new Float64Array(ndof);
  let acceptedSteps = 0;
  let rejectedSteps = 0;
  let totalNonlinearIterations = 0;
  let totalCgIterations = 0;
  let lastResidualNorm = 0;
  let lastRelativeResidual = 0;
  let lastDisplacementNorm = 0;
  let lastRelativeDisplacement = 0;
  let lastStateChanges = 0;
  let finalActiveCount = 0;
  let peakActiveCount = 0;
  let finalActiveFaceCount = 0;
  let finalActiveEdgeCount = 0;
  let finalActiveApexCount = 0;
  let finalTensionPendingCount = 0;
  let peakActiveFaceCount = 0;
  let peakActiveEdgeCount = 0;
  let peakActiveApexCount = 0;
  let peakTensionPendingCount = 0;
  let peakEta = 0;
  let loadStepCounter = 0;
  const loadStepHistory = [];
  const residualHistory = [];
  let terminalFailureReason = '';
  let terminalFailureCode = '';
  let terminatedByFailure = false;
  let bestDisplayedState = null;
  let warmStartFreeCorrection = null;
  const phaseDisplayName = phaseKind === 'initial-gravity'
    ? 'Stage 2 initial plastic equilibration'
    : phaseKind === 'safety-cphi'
      ? 'Safety c-phi reduction'
    : constitutiveModel === 'mc-plastic'
      ? 'Stage 2 elastoplastic'
      : constitutiveModel === 'linear-elastic'
        ? 'Linear elastic'
        : 'Stage 1 MC-active reduced-stiffness';
  const analysisStageLabel = phaseKind === 'initial-gravity'
    ? 'initial-gravity-stage-2'
    : phaseKind === 'safety-cphi'
      ? 'safety-cphi-stage'
    : constitutiveModel === 'mc-plastic'
      ? 'nonlinear-stage-2'
      : constitutiveModel === 'linear-elastic'
        ? 'nonlinear-elastic'
        : 'nonlinear-stage-1';
  const targetForceBaseInput = phaseConfig?.targetForceBase;
  const targetForceBase = (Array.isArray(targetForceBaseInput) || ArrayBuffer.isView(targetForceBaseInput))
    ? Float64Array.from(targetForceBaseInput)
    : null;
  const finalTargetForceFree = cloneScaledVector(loadRhsFreeBase, targetLoadFactorFinal);
  const usesTargetForceHomotopy = targetForceBase && targetForceBase.length === finalTargetForceFree.length;
  const loadFactorMeaning = phaseKind === 'initial-gravity'
    ? (usesTargetForceHomotopy ? 'predictor-to-full-gravity correction' : 'gravity')
    : phaseKind === 'safety-cphi'
      ? 'safety-strength-reduction'
    : 'load';
  const customTargetForceBuilder = typeof phaseConfig?.buildTargetForceFree === 'function'
    ? phaseConfig.buildTargetForceFree
    : null;
  const customProgressLabel = typeof phaseConfig?.progressLabel === 'function'
    ? phaseConfig.progressLabel
    : null;
  const buildElementAnalysisOptions = typeof phaseConfig?.buildElementAnalysisOptions === 'function'
    ? phaseConfig.buildElementAnalysisOptions
    : null;
  const commitPhaseState = typeof phaseConfig?.commitPhaseState === 'function'
    ? phaseConfig.commitPhaseState
    : null;
  const buildTargetForceFree = (loadFactor) => {
    if (customTargetForceBuilder) return customTargetForceBuilder(loadFactor);
    if (!usesTargetForceHomotopy) return cloneScaledVector(loadRhsFreeBase, loadFactor);
    const progress = targetLoadFactorFinal > 1e-12 ? loadFactor / targetLoadFactorFinal : 1;
    return interpolateVectorFields(targetForceBase, finalTargetForceFree, progress);
  };
  const nonlinearStepLabel = (targetLoadFactor) => {
    if (customProgressLabel) return customProgressLabel(targetLoadFactor, acceptedSteps, rejectedSteps);
    if (phaseKind === 'initial-gravity') {
      return usesTargetForceHomotopy
        ? `${phaseDisplayName}: step ${acceptedSteps + rejectedSteps + 1}, target ${(100 * targetLoadFactor).toFixed(0)}% of the predictor-to-full-gravity correction`
        : `${phaseDisplayName}: correcting the full gravity state`;
    }
    if (phaseKind === 'safety-cphi') {
      return `${phaseDisplayName}: continuation step ${acceptedSteps + rejectedSteps + 1}`;
    }
    return `${phaseDisplayName} solve: load step ${acceptedSteps + rejectedSteps + 1}, target ${(100 * targetLoadFactor).toFixed(0)}%`;
  };

  resetMaterialPointTrials(materialPoints);

  while (loadFactorCommitted < targetLoadFactorFinal - 1e-10) {
    loadStepCounter += 1;
    if (loadStepCounter > maxLoadSteps) {
      terminalFailureReason = `${
        phaseKind === 'initial-gravity'
          ? 'Initial plastic equilibration'
          : phaseKind === 'safety-cphi'
            ? 'Safety c-phi reduction phase'
            : `${constitutiveModel === 'mc-plastic' ? 'Stage 2' : 'Stage 1'} deformation solve`
      } exceeded the maximum number of load steps (${maxLoadSteps}).`;
      terminalFailureCode = 'step-budget-exhausted';
      terminatedByFailure = true;
      break;
    }
    const remaining = targetLoadFactorFinal - loadFactorCommitted;
    const actualStep = allowLoadStepping ? Math.min(stepSize, remaining) : remaining;
    const targetLoadFactor = loadFactorCommitted + actualStep;
    const targetForceFree = buildTargetForceFree(targetLoadFactor);
    const uTrial = Float64Array.from(uCommitted);
    resetMaterialPointTrials(materialPoints);
    const stepRecord = {
      index: loadStepCounter,
      targetLoadFactor,
      attemptedStep: actualStep,
      constitutiveModel,
      continuationStrategy: useAdaptiveContinuation ? 'adaptive-pi' : 'fixed-factor',
      status: 'running',
      iterations: 0,
      accepted: false,
      rejected: false,
      peakActiveCount: 0,
      peakActiveFaceCount: 0,
      peakActiveEdgeCount: 0,
      peakActiveApexCount: 0,
      peakTensionPendingCount: 0,
      peakEta: 0,
      finalResidualNorm: null,
      relativeResidualNorm: null,
      failureCode: '',
      failureOutcomeClass: '',
      reason: '',
      lineSearchAccepted: false,
      lineSearchAcceptedScale: 1,
      lineSearchBestScale: 1,
      lineSearchEvaluations: 0,
      lineSearchCurrentMerit: 0,
      lineSearchBestMerit: 0,
      suggestedNextStepFactor: 1,
      suggestedNextStepSize: actualStep
    };

    let converged = false;
    let failureReason = '';
    let failureCode = '';
    let suggestedStepCutbackFactor = null;
    let lastCorrection = new Float64Array(ndof);
    let stepBestState = null;
    const shouldWarmStartLinearSolve = constitutiveModel === 'mc-plastic';
    let stepUsedUnsymmetricSolver = false;
    let iterationLinearGuess = warmStartFreeCorrection && warmStartFreeCorrection.length === freeDofs.length
      ? (shouldWarmStartLinearSolve ? Float64Array.from(warmStartFreeCorrection) : null)
      : null;
    const setStepFailure = (code, reason) => {
      const record = createFailureRecord(code, reason);
      failureCode = record.code;
      failureReason = record.reason;
      return record;
    };

    onProgress({
      stage: 'solving',
      percent: 74,
      message: `${nonlinearStepLabel(targetLoadFactor)}...`
    });

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      totalNonlinearIterations += 1;
      const elementAnalysisOptionsForTarget = {
        ...(buildElementAnalysisOptions ? (buildElementAnalysisOptions(targetLoadFactor) || {}) : {}),
        useElasticGlobalizationTangent: phaseUsesElasticGlobalizationTangent
      };
      let assembled;
      try {
        assembled = await assembleNonlinearSystem(
          elementCaches,
          assemblyPattern,
          uTrial,
          materialPoints,
          loadRhsFreeBase,
          targetLoadFactor,
          runControl,
          analysisStageLabel,
          formulationMode,
          targetForceFree,
          elementAnalysisOptionsForTarget
        );
      } catch (error) {
        setStepFailure('assembly-failure', error instanceof Error ? error.message : String(error));
        break;
      }
      finalActiveCount = assembled.activeCount;
      finalActiveFaceCount = assembled.activeFaceCount;
      finalActiveEdgeCount = assembled.activeEdgeCount;
      finalActiveApexCount = assembled.activeApexCount;
      finalTensionPendingCount = assembled.tensionPendingCount;
      peakActiveCount = Math.max(peakActiveCount, assembled.activeCount);
      peakActiveFaceCount = Math.max(peakActiveFaceCount, assembled.activeFaceCount);
      peakActiveEdgeCount = Math.max(peakActiveEdgeCount, assembled.activeEdgeCount);
      peakActiveApexCount = Math.max(peakActiveApexCount, assembled.activeApexCount);
      peakTensionPendingCount = Math.max(peakTensionPendingCount, assembled.tensionPendingCount);
      peakEta = Math.max(peakEta, assembled.maxEta);
      const residualNorm = Number.isFinite(Number(assembled.residualNorm))
        ? Number(assembled.residualNorm)
        : vectorNorm(assembled.residualFree);
      const rhsNorm = Number.isFinite(Number(assembled.rhsNorm))
        ? Number(assembled.rhsNorm)
        : vectorNorm(assembled.targetForceFree);
      const deltaNorm = vectorNorm(lastCorrection);
      const solutionNorm = vectorNorm(uTrial);
      const tolerance = nonlinearToleranceState(
        residualNorm,
        rhsNorm,
        deltaNorm,
        solutionNorm,
        options
      );
      const toleranceWithResidual = {
        ...tolerance,
        residualNorm
      };
      lastResidualNorm = residualNorm;
      lastRelativeResidual = tolerance.relativeResidual;
      lastDisplacementNorm = deltaNorm;
      lastRelativeDisplacement = tolerance.relativeDisplacement;
      lastStateChanges = assembled.changedCount;
      stepRecord.iterations = iteration;
      stepRecord.peakActiveCount = Math.max(stepRecord.peakActiveCount, assembled.activeCount);
      stepRecord.peakActiveFaceCount = Math.max(stepRecord.peakActiveFaceCount, assembled.activeFaceCount);
      stepRecord.peakActiveEdgeCount = Math.max(stepRecord.peakActiveEdgeCount, assembled.activeEdgeCount);
      stepRecord.peakActiveApexCount = Math.max(stepRecord.peakActiveApexCount, assembled.activeApexCount);
      stepRecord.peakTensionPendingCount = Math.max(stepRecord.peakTensionPendingCount, assembled.tensionPendingCount);
      stepRecord.peakEta = Math.max(stepRecord.peakEta, assembled.maxEta);
      residualHistory.push({
        loadStepIndex: loadStepCounter,
        iteration,
        targetLoadFactor,
        residualNorm,
        residualMerit: evaluateResidualMerit(residualNorm),
        relativeResidualNorm: tolerance.relativeResidual,
        displacementCorrectionNorm: deltaNorm,
        relativeDisplacementCorrectionNorm: tolerance.relativeDisplacement,
        activeCount: assembled.activeCount,
        activeFaceCount: assembled.activeFaceCount,
        activeEdgeCount: assembled.activeEdgeCount,
        activeApexCount: assembled.activeApexCount,
        tensionPendingCount: assembled.tensionPendingCount,
        stateChanges: assembled.changedCount
      });
      onProgress({
        stage: 'solving',
        percent: 74,
        message: `${nonlinearStepLabel(targetLoadFactor)}; Newton ${iteration}/${maxIterations}, residual ${residualNorm.toExponential(2)}, active ${assembled.activeCount}`
      });
      const assembledState = snapshotDisplayedState(uTrial, targetLoadFactor, assembled, 'failed-step-iteration', failureReason);
      if (shouldPreferDisplayCandidate(assembledState, stepBestState)) stepBestState = assembledState;

      const assembledConverged = (
        tolerance.residualConverged && (!requiresDisplacementTolerance || tolerance.displacementConverged)
      ) || allowPlasticQuasiConvergence(
        constitutiveModel,
        phaseKind,
        toleranceWithResidual,
        assembled.changedCount,
        iteration
      );
      if (iteration > 1 && assembledConverged && (!requiresStableActiveSet || assembled.changedCount === 0)) {
        converged = true;
        break;
      }

      const usesUnsymmetricSolver = mayNeedUnsymmetricSolver && (assembled.activeCount > 0);
      const linearSolve = usesUnsymmetricSolver
        ? (
            unsymmetricLinearSolverMode === 'bicgstab'
              ? solveBiCgStab
              : solveGmresScaled
          )
        : solveCg;
      stepUsedUnsymmetricSolver = usesUnsymmetricSolver;
      stepRecord.linearSolver = usesUnsymmetricSolver
        ? (unsymmetricLinearSolverMode === 'bicgstab' ? 'bicgstab' : 'gmres-scaled')
        : 'cg';
      stepRecord.linearSolverPrecisionMode = activeMatvecBackend?.precisionMode || 'cpu-f64';
      const linearIterationObserver = phaseKind === 'initial-gravity'
        ? async ({ iterations, relativeResidual }) => {
            onProgress({
              stage: 'solving',
              percent: 74,
              message: `${nonlinearStepLabel(targetLoadFactor)}; Newton ${iteration}/${maxIterations}, ${usesUnsymmetricSolver ? (unsymmetricLinearSolverMode === 'bicgstab' ? 'BiCGStab' : 'GMRES') : 'CG'} iter ${iterations.toLocaleString()}, relative residual ${relativeResidual.toExponential(2)}`
            });
            await runCheckpoint(runControl);
          }
        : null;
      let cg = await linearSolve(
        assembled.compressedRows,
        assembled.residualFree,
        shouldWarmStartLinearSolve ? iterationLinearGuess : null,
        MAX_CG_ITER,
        CG_REL_TOL,
        CG_ABS_TOL,
        runControl,
        linearIterationObserver
      );
      const maybeRetryWithDoubleSingle = async () => {
        if (
          !usesUnsymmetricSolver
          || constitutiveModel !== 'mc-plastic'
          || !activeMatvecBackend?.supportsDoubleSingle
          || activeMatvecBackend?.precisionMode === 'double-single'
        ) return cg;
        backendEscalatePrecisionMode(
          'double-single',
          'Stage 2 unsymmetric solve escalated from f32 to double-single after a non-converged mixed-precision Krylov step.',
          10
        );
        stepRecord.linearSolverPrecisionMode = activeMatvecBackend?.precisionMode || 'double-single';
        return linearSolve(
          assembled.compressedRows,
          assembled.residualFree,
          shouldWarmStartLinearSolve ? iterationLinearGuess : null,
          MAX_CG_ITER,
          CG_REL_TOL,
          CG_ABS_TOL,
          runControl,
          linearIterationObserver
        );
      };
      totalCgIterations += cg.iterations;
      if (cg.interrupted) {
        throw new Error(`Deformation run was interrupted during ${
          phaseKind === 'initial-gravity'
            ? 'the initial plastic equilibration phase'
            : phaseKind === 'safety-cphi'
              ? 'the c-phi reduction safety phase'
              : `the ${constitutiveModel === 'mc-plastic' ? 'Stage 2 elastoplastic' : 'Stage 1 nonlinear'} solve`
        }.`);
      }
      const inexactNewtonForcing = isLinearElastic
        ? 1e-8
        : Math.max(
          phaseKind === 'initial-gravity' ? 0.1 : 0.05,
          Math.min(
            phaseKind === 'initial-gravity'
              ? 0.6
              : 0.4,
            Math.sqrt(Math.max(Number(lastRelativeResidual) || 0, 0))
          )
        );
      const acceptableLinearizedResidual = isLinearElastic
        ? Math.max(CG_ABS_TOL, inexactNewtonForcing * Math.max(Number(cg.rhsNorm) || 0, 0))
        : Math.max(
          CG_ABS_TOL,
          0.25 * Math.max(Number(options?.residualAbsTol) || NONLINEAR_RESIDUAL_ABS_TOL, NONLINEAR_RESIDUAL_ABS_TOL),
          inexactNewtonForcing * Math.max(Number(cg.rhsNorm) || 0, 0)
        );
      let allowInexactLinearizedSolve = cg.residualNorm <= acceptableLinearizedResidual;
      if (!cg.converged && !allowInexactLinearizedSolve) {
        const retried = await maybeRetryWithDoubleSingle();
        if (retried !== cg) {
          totalCgIterations += retried.iterations;
          cg = retried;
          if (cg.interrupted) {
            throw new Error(`Deformation run was interrupted during ${
              phaseKind === 'initial-gravity'
                ? 'the initial plastic equilibration phase'
                : phaseKind === 'safety-cphi'
                  ? 'the c-phi reduction safety phase'
                  : `the ${constitutiveModel === 'mc-plastic' ? 'Stage 2 elastoplastic' : 'Stage 1 nonlinear'} solve`
            }.`);
          }
          allowInexactLinearizedSolve = cg.residualNorm <= acceptableLinearizedResidual;
        }
      }
      if (!cg.converged && !allowInexactLinearizedSolve) {
        setStepFailure('global-linear-solve-failure', `linearized solve did not converge (residual ${cg.residualNorm.toExponential(2)} after ${cg.iterations} iterations)`);
        break;
      }
      lastCorrection = expandSolutionVector(ndof, freeDofs, fixedValues, cg.solution);
      let correctionNorm = vectorNorm(lastCorrection);
      let refreshed = null;
      let lineSearchStepScale = 1;
      if (constitutiveModel === 'mc-plastic' && correctionNorm > 0) {
        try {
          const lineSearch = await performArmijoLineSearch(
            elementCaches,
            assemblyPattern,
            uTrial,
            lastCorrection,
            residualNorm,
            cg.residualNorm,
            materialPoints,
            loadRhsFreeBase,
            targetLoadFactor,
            runControl,
            analysisStageLabel,
            formulationMode,
            targetForceFree,
            elementAnalysisOptionsForTarget,
            plasticLineSearchOptions
          );
          if (lineSearch) {
            suggestedStepCutbackFactor = Number.isFinite(Number(lineSearch.stepScale)) && Number(lineSearch.stepScale) > 0
              ? Number(lineSearch.stepScale)
              : suggestedStepCutbackFactor;
            stepRecord.lineSearchAccepted = !!lineSearch.accepted;
            stepRecord.lineSearchAcceptedScale = lineSearch.accepted ? Number(lineSearch.stepScale) || 1 : 0;
            stepRecord.lineSearchBestScale = Number(lineSearch.stepScale) || 1;
            stepRecord.lineSearchEvaluations = Number(lineSearch.evaluations) || 0;
            stepRecord.lineSearchCurrentMerit = Number(lineSearch.currentMerit) || 0;
            stepRecord.lineSearchBestMerit = Number(lineSearch.candidateMerit) || 0;
            if (!lineSearch.accepted) {
              const candidateCorrection = cloneScaledVector(lastCorrection, lineSearch.stepScale);
              const candidateCorrectionNorm = vectorNorm(candidateCorrection);
              const candidateSolutionNorm = vectorNorm(lineSearch.uCandidate);
              const candidateResidualNorm = Number.isFinite(Number(lineSearch.assembly?.residualNorm))
                ? Number(lineSearch.assembly.residualNorm)
                : vectorNorm(lineSearch.assembly?.residualFree);
              const candidateRhsNorm = Number.isFinite(Number(lineSearch.assembly?.rhsNorm))
                ? Number(lineSearch.assembly.rhsNorm)
                : vectorNorm(lineSearch.assembly?.targetForceFree);
              const candidateTolerance = nonlinearToleranceState(
                candidateResidualNorm,
                candidateRhsNorm,
                candidateCorrectionNorm,
                candidateSolutionNorm,
                options
              );
              const candidateToleranceWithResidual = {
                ...candidateTolerance,
                residualNorm: candidateResidualNorm
              };
              const stalledCandidateAcceptable = (
                candidateTolerance.residualConverged && (!requiresDisplacementTolerance || candidateTolerance.displacementConverged)
              ) || allowPlasticQuasiConvergence(
                constitutiveModel,
                phaseKind,
                candidateToleranceWithResidual,
                lineSearch.assembly?.changedCount,
                iteration
              );
              if (stalledCandidateAcceptable && (!requiresStableActiveSet || (Number(lineSearch.assembly?.changedCount) || 0) === 0)) {
                copyVectorInto(uTrial, lineSearch.uCandidate);
                lastCorrection = candidateCorrection;
                correctionNorm = candidateCorrectionNorm;
                refreshed = lineSearch.assembly;
                converged = true;
                break;
              }
              if (allowPlasticQuasiConvergence(
                constitutiveModel,
                phaseKind,
                toleranceWithResidual,
                assembled.changedCount,
                iteration
              )) {
                converged = true;
                break;
              }
              setStepFailure('line-search-stall', 'plastic line search stalled');
              break;
            }
            copyVectorInto(uTrial, lineSearch.uCandidate);
            lastCorrection = cloneScaledVector(lastCorrection, lineSearch.stepScale);
            correctionNorm = vectorNorm(lastCorrection);
            refreshed = lineSearch.assembly;
            lineSearchStepScale = lineSearch.stepScale;
          } else {
            addScaledVectorInPlace(uTrial, lastCorrection, 1);
          }
        } catch (error) {
          setStepFailure('assembly-failure', error instanceof Error ? error.message : String(error));
          break;
        }
      } else {
        addScaledVectorInPlace(uTrial, lastCorrection, 1);
      }
      iterationLinearGuess = shouldWarmStartLinearSolve ? Float64Array.from(cg.solution) : null;
      if (shouldWarmStartLinearSolve && lineSearchStepScale !== 1) {
        for (let i = 0; i < iterationLinearGuess.length; i += 1) iterationLinearGuess[i] *= lineSearchStepScale;
      }
      const updatedSolutionNorm = vectorNorm(uTrial);
      const postSolveTolerance = nonlinearToleranceState(
        residualNorm,
        rhsNorm,
        correctionNorm,
        updatedSolutionNorm,
        options
      );
      const postSolveToleranceWithResidual = {
        ...postSolveTolerance,
        residualNorm
      };
      lastDisplacementNorm = correctionNorm;
      lastRelativeDisplacement = postSolveTolerance.relativeDisplacement;
      const postSolveConverged = (
        postSolveTolerance.residualConverged && (!requiresDisplacementTolerance || postSolveTolerance.displacementConverged)
      ) || allowPlasticQuasiConvergence(
        constitutiveModel,
        phaseKind,
        postSolveToleranceWithResidual,
        assembled.changedCount,
        iteration
      );
      if ((isLinearElastic || postSolveConverged) && (!requiresStableActiveSet || assembled.changedCount === 0)) {
        if (!refreshed) {
          resetMaterialPointTrials(materialPoints);
          try {
            refreshed = await assembleNonlinearSystem(
              elementCaches,
              assemblyPattern,
              uTrial,
              materialPoints,
              loadRhsFreeBase,
              targetLoadFactor,
              runControl,
              analysisStageLabel,
              formulationMode,
              targetForceFree,
              elementAnalysisOptionsForTarget
            );
          } catch (error) {
            setStepFailure('assembly-failure', error instanceof Error ? error.message : String(error));
            break;
          }
        }
        finalActiveCount = refreshed.activeCount;
        finalActiveFaceCount = refreshed.activeFaceCount;
        finalActiveEdgeCount = refreshed.activeEdgeCount;
        finalActiveApexCount = refreshed.activeApexCount;
        finalTensionPendingCount = refreshed.tensionPendingCount;
        peakActiveCount = Math.max(peakActiveCount, refreshed.activeCount);
        peakActiveFaceCount = Math.max(peakActiveFaceCount, refreshed.activeFaceCount);
        peakActiveEdgeCount = Math.max(peakActiveEdgeCount, refreshed.activeEdgeCount);
        peakActiveApexCount = Math.max(peakActiveApexCount, refreshed.activeApexCount);
        peakTensionPendingCount = Math.max(peakTensionPendingCount, refreshed.tensionPendingCount);
        peakEta = Math.max(peakEta, refreshed.maxEta);
        const refreshedResidualNorm = Number.isFinite(Number(refreshed.residualNorm))
          ? Number(refreshed.residualNorm)
          : vectorNorm(refreshed.residualFree);
        const refreshedRhsNorm = Number.isFinite(Number(refreshed.rhsNorm))
          ? Number(refreshed.rhsNorm)
          : vectorNorm(refreshed.targetForceFree);
        const refreshedTolerance = nonlinearToleranceState(
          refreshedResidualNorm,
          refreshedRhsNorm,
          correctionNorm,
          updatedSolutionNorm,
          options
        );
        const refreshedToleranceWithResidual = {
          ...refreshedTolerance,
          residualNorm: refreshedResidualNorm
        };
        const refreshedState = snapshotDisplayedState(uTrial, targetLoadFactor, refreshed, 'failed-step-refresh', failureReason);
        if (shouldPreferDisplayCandidate(refreshedState, stepBestState)) stepBestState = refreshedState;
        lastResidualNorm = refreshedResidualNorm;
        lastRelativeResidual = refreshedTolerance.relativeResidual;
        lastDisplacementNorm = correctionNorm;
        lastRelativeDisplacement = refreshedTolerance.relativeDisplacement;
        lastStateChanges = refreshed.changedCount;
        const refreshedConverged = (
          refreshedTolerance.residualConverged && (!requiresDisplacementTolerance || refreshedTolerance.displacementConverged)
        ) || allowPlasticQuasiConvergence(
          constitutiveModel,
          phaseKind,
          refreshedToleranceWithResidual,
          refreshed.changedCount,
          iteration
        );
        if ((!requiresStableActiveSet || refreshed.changedCount === 0) && refreshedConverged) {
          converged = true;
          break;
        }
      }

      if (await runCheckpoint(runControl)) {
        throw new Error(`Deformation run was interrupted during ${
          phaseKind === 'initial-gravity'
            ? 'the initial plastic equilibration phase'
            : phaseKind === 'safety-cphi'
              ? 'the c-phi reduction safety phase'
              : `the ${constitutiveModel === 'mc-plastic' ? 'Stage 2 elastoplastic' : 'Stage 1 nonlinear'} solve`
        }.`);
      }
    }

    if (converged) {
      materialPoints.forEach((materialPoint) => commitMaterialPoint(materialPoint));
      if (commitPhaseState) commitPhaseState(targetLoadFactor, materialPoints);
      uCommitted = Float64Array.from(uTrial);
      loadFactorCommitted = targetLoadFactor;
      const committedAssembly = stepBestState && Math.abs((Number(stepBestState.loadFactor) || 0) - targetLoadFactor) <= 1e-10
        ? {
            residualFree: null,
            targetForceFree: null,
            activeCount: stepBestState.activeCount,
            activeFaceCount: stepBestState.activeFaceCount,
            activeEdgeCount: stepBestState.activeEdgeCount,
            activeApexCount: stepBestState.activeApexCount,
            tensionPendingCount: stepBestState.tensionPendingCount,
            maxEta: stepBestState.maxEta,
            changedCount: stepBestState.stateChanges
          }
        : null;
      const committedState = snapshotDisplayedState(
        uCommitted,
        loadFactorCommitted,
        committedAssembly || {
          residualFree: new Float64Array([lastResidualNorm]),
          targetForceFree: new Float64Array([Math.max(lastResidualNorm / Math.max(lastRelativeResidual || 0, 1e-12), 0)]),
          activeCount: finalActiveCount,
          activeFaceCount: finalActiveFaceCount,
          activeEdgeCount: finalActiveEdgeCount,
          activeApexCount: finalActiveApexCount,
          tensionPendingCount: finalTensionPendingCount,
          maxEta: peakEta,
          changedCount: lastStateChanges
        },
        'committed'
      );
      if (shouldPreferDisplayCandidate(committedState, bestDisplayedState)) bestDisplayedState = committedState;
      acceptedSteps += 1;
      stepRecord.status = 'accepted';
      stepRecord.accepted = true;
      stepRecord.finalResidualNorm = lastResidualNorm;
      stepRecord.relativeResidualNorm = lastRelativeResidual;
      stepRecord.failureCode = 'equilibrium-converged';
      stepRecord.failureOutcomeClass = 'converged';
      stepRecord.reason = '';
      warmStartFreeCorrection = shouldWarmStartLinearSolve && stepUsedUnsymmetricSolver && iterationLinearGuess ? Float64Array.from(iterationLinearGuess) : null;
      if (!allowLoadStepping) {
        loadStepHistory.push(stepRecord);
        continue;
      }
      const effectiveGrowthFactor = constitutiveModel === 'mc-plastic' && stepRecord.peakActiveCount > 0
        ? Math.min(growthFactor, plasticGrowthFactor)
        : growthFactor;
      const effectiveCutbackFactor = constitutiveModel === 'mc-plastic' && stepRecord.peakActiveCount > 0
        ? Math.min(cutbackFactor, plasticCutbackFactor)
        : cutbackFactor;
      const acceptedLineSearchScale = stepRecord.lineSearchAccepted
        ? Math.max(Number(stepRecord.lineSearchAcceptedScale) || 0, 1e-6)
        : 1;
      const nextStepFactor = useAdaptiveContinuation
        ? computeAdaptiveContinuationFactor({
            iterationCount: stepRecord.iterations,
            acceptedLineSearchScale,
            targetIterations: continuationTargetIterations,
            targetLineSearchScale: continuationTargetLineSearchScale,
            iterationExponent: continuationIterationExponent,
            lineSearchExponent: continuationLineSearchExponent,
            minFactor: effectiveCutbackFactor,
            maxFactor: effectiveGrowthFactor
          })
        : effectiveGrowthFactor;
      stepRecord.suggestedNextStepFactor = nextStepFactor;
      stepRecord.suggestedNextStepSize = Math.min(actualStep * nextStepFactor, targetLoadFactorFinal - loadFactorCommitted || actualStep);
      loadStepHistory.push(stepRecord);
      stepSize = stepRecord.suggestedNextStepSize;
      continue;
    }

    rejectedSteps += 1;
    stepRecord.status = 'rejected';
    stepRecord.rejected = true;
    stepRecord.finalResidualNorm = lastResidualNorm;
    stepRecord.relativeResidualNorm = lastRelativeResidual;
    if (!failureReason) {
      const failureRecord = createFailureRecord('nonlinear-iterations-exhausted', 'nonlinear iterations exhausted');
      failureCode = failureRecord.code;
      failureReason = failureRecord.reason;
    }
    stepRecord.failureCode = failureCode;
    stepRecord.failureOutcomeClass = classifyFailureOutcomeClass(failureCode);
    stepRecord.reason = failureReason;
    if (shouldPreferDisplayCandidate(stepBestState, bestDisplayedState)) {
      bestDisplayedState = {
        ...stepBestState,
        reason: stepRecord.reason
      };
    }
    warmStartFreeCorrection = shouldWarmStartLinearSolve && iterationLinearGuess
      ? Float64Array.from(iterationLinearGuess)
      : warmStartFreeCorrection;
    if (!allowLoadStepping) {
      terminalFailureReason = phaseKind === 'initial-gravity'
        ? `Initial plastic equilibration could not converge the full gravity state (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`
        : phaseKind === 'safety-cphi'
          ? `Safety c-phi reduction could not converge the target strength-reduced state (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`
          : `${constitutiveModel === 'mc-plastic' ? 'Stage 2' : 'Stage 1'} deformation solve could not converge the target state (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`;
      terminalFailureCode = failureCode || 'nonlinear-iterations-exhausted';
      loadStepHistory.push(stepRecord);
      terminatedByFailure = true;
      break;
    }
    const effectiveCutbackFactor = constitutiveModel === 'mc-plastic' && stepRecord.peakActiveCount > 0
      ? Math.min(cutbackFactor, plasticCutbackFactor)
      : cutbackFactor;
    const suggestedCutbackFactor = constitutiveModel === 'mc-plastic' &&
      Number.isFinite(Number(suggestedStepCutbackFactor)) &&
      Number(suggestedStepCutbackFactor) > 0
      ? Math.min(effectiveCutbackFactor, Number(suggestedStepCutbackFactor))
      : effectiveCutbackFactor;
    const proposedStepSize = actualStep * suggestedCutbackFactor;
    stepRecord.suggestedNextStepFactor = suggestedCutbackFactor;
    stepRecord.suggestedNextStepSize = proposedStepSize < minLoadStep - 1e-12 && actualStep > minLoadStep + 1e-12
      ? minLoadStep
      : proposedStepSize;
    loadStepHistory.push(stepRecord);
    stepSize = stepRecord.suggestedNextStepSize;
    resetMaterialPointTrials(materialPoints);
    if (stepSize < minLoadStep - 1e-12) {
      terminalFailureReason = phaseKind === 'initial-gravity'
        ? `Initial plastic equilibration could not converge the load step to ${(100 * targetLoadFactor).toFixed(1)}% (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`
        : phaseKind === 'safety-cphi'
          ? `Safety c-phi reduction could not converge the continuation step (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`
          : `${constitutiveModel === 'mc-plastic' ? 'Stage 2' : 'Stage 1'} deformation solve could not converge the load step to ${(100 * targetLoadFactor).toFixed(1)}% (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`;
      terminalFailureCode = 'step-below-minimum';
      terminatedByFailure = true;
      break;
    }
  }

  const fallbackCommittedState = snapshotDisplayedState(
    uCommitted,
    loadFactorCommitted,
    {
      residualFree: new Float64Array([lastResidualNorm]),
      targetForceFree: new Float64Array([Math.max(lastResidualNorm / Math.max(lastRelativeResidual || 0, 1e-12), 0)]),
      activeCount: finalActiveCount,
      activeFaceCount: finalActiveFaceCount,
      activeEdgeCount: finalActiveEdgeCount,
      activeApexCount: finalActiveApexCount,
      tensionPendingCount: finalTensionPendingCount,
      maxEta: peakEta,
      changedCount: lastStateChanges
    },
    'committed',
    terminalFailureReason
  );
  if (shouldPreferDisplayCandidate(fallbackCommittedState, bestDisplayedState)) bestDisplayedState = fallbackCommittedState;

  if (terminatedByFailure && !bestDisplayedState) {
    throw new Error(terminalFailureReason || `${constitutiveModel === 'mc-plastic' ? 'Stage 2' : 'Stage 1'} deformation solve failed before a usable displacement state became available.`);
  }

  // The initial plastic geostatic phase is an initialization problem, not a service-loading
  // near-failure visualization pass. When it fails, only committed correction states are
  // mathematically admissible as displayed reference fields.
  const displayedState = terminatedByFailure
    ? (
        phaseKind === 'initial-gravity'
          ? fallbackCommittedState
          : (bestDisplayedState || fallbackCommittedState)
      )
    : (fallbackCommittedState || bestDisplayedState);
  const displayedSolution = displayedState?.solution || uCommitted;
  const displayedLoadFactor = Math.max(Number(displayedState?.loadFactor) || loadFactorCommitted || 0, 0);
  const displayedTargetForceFree = buildTargetForceFree(displayedLoadFactor);

  resetMaterialPointTrials(materialPoints);
  if (commitPhaseState) commitPhaseState(displayedLoadFactor, materialPoints);
  const finalAssembly = await assembleNonlinearSystem(
    elementCaches,
    assemblyPattern,
    displayedSolution,
    materialPoints,
    loadRhsFreeBase,
    displayedLoadFactor,
    runControl,
    analysisStageLabel,
    formulationMode,
    displayedTargetForceFree,
    {
      ...(buildElementAnalysisOptions ? (buildElementAnalysisOptions(displayedLoadFactor) || {}) : {}),
      useElasticGlobalizationTangent: phaseUsesElasticGlobalizationTangent
    }
  );
  finalActiveCount = finalAssembly.activeCount;
  finalActiveFaceCount = finalAssembly.activeFaceCount;
  finalActiveEdgeCount = finalAssembly.activeEdgeCount;
  finalActiveApexCount = finalAssembly.activeApexCount;
  finalTensionPendingCount = finalAssembly.tensionPendingCount;
  peakActiveCount = Math.max(peakActiveCount, finalAssembly.activeCount);
  peakActiveFaceCount = Math.max(peakActiveFaceCount, finalAssembly.activeFaceCount);
  peakActiveEdgeCount = Math.max(peakActiveEdgeCount, finalAssembly.activeEdgeCount);
  peakActiveApexCount = Math.max(peakActiveApexCount, finalAssembly.activeApexCount);
  peakTensionPendingCount = Math.max(peakTensionPendingCount, finalAssembly.tensionPendingCount);
  peakEta = Math.max(peakEta, finalAssembly.maxEta);
  lastResidualNorm = vectorNorm(finalAssembly.residualFree);
  const finalRhsNorm = vectorNorm(finalAssembly.targetForceFree);
  const finalTolerance = nonlinearToleranceState(
    lastResidualNorm,
    finalRhsNorm,
    lastDisplacementNorm,
    vectorNorm(uCommitted),
    options
  );
  lastRelativeResidual = finalTolerance.relativeResidual;
  lastRelativeDisplacement = finalTolerance.relativeDisplacement;
  lastStateChanges = finalAssembly.changedCount;
  const phaseFailureRecord = terminatedByFailure
    ? createFailureRecord(terminalFailureCode, displayedState?.reason || terminalFailureReason)
    : createFailureRecord('equilibrium-converged', '');

  return {
    solution: displayedSolution,
    acceptedSteps,
    rejectedSteps,
    totalNonlinearIterations,
    totalCgIterations,
    residualNorm: lastResidualNorm,
    relativeResidualNorm: lastRelativeResidual,
    displacementCorrectionNorm: lastDisplacementNorm,
    relativeDisplacementCorrectionNorm: lastRelativeDisplacement,
    lastStateChanges,
    finalActiveCount,
    peakActiveCount,
    finalActiveFaceCount,
    finalActiveEdgeCount,
    finalActiveApexCount,
    finalTensionPendingCount,
    peakActiveFaceCount,
    peakActiveEdgeCount,
    peakActiveApexCount,
    peakTensionPendingCount,
    peakEta,
    loadFactorCommitted,
    displayedLoadFactor,
    phaseKind,
    formulationMode,
    loadFactorMeaning,
    converged: !terminatedByFailure,
    convergenceState: terminatedByFailure ? 'partial' : 'converged',
    failureCode: phaseFailureRecord.code,
    failureOutcomeClass: phaseFailureRecord.outcomeClass,
    displayedStateMode: displayedState?.mode || 'committed',
    failureReason: terminatedByFailure ? (displayedState?.reason || terminalFailureReason) : '',
    loadStepHistory,
    residualHistory
  };
}

async function initializePlasticPredictorReferenceState(
  elementCaches,
  assemblyPattern,
  gravityRhsFreeBase,
  materialPoints,
  initialSolution,
  runControl
) {
  resetMaterialPointTrials(materialPoints);
  const zeroTargetForce = new Float64Array(gravityRhsFreeBase.length);
  const initializedAssembly = await assembleNonlinearSystem(
    elementCaches,
    assemblyPattern,
    initialSolution,
    materialPoints,
    gravityRhsFreeBase,
    0,
    runControl,
    'initial-gravity-predictor-reference',
    'total',
    zeroTargetForce
  );
  materialPoints.forEach((materialPoint) => {
    commitMaterialPoint(materialPoint);
  });
  resetMaterialPointTrials(materialPoints);
  return {
    targetForceBase: Float64Array.from(initializedAssembly.internalForceFree),
    activeCount: Number(initializedAssembly.activeCount) || 0,
    activeFaceCount: Number(initializedAssembly.activeFaceCount) || 0,
    activeEdgeCount: Number(initializedAssembly.activeEdgeCount) || 0,
    activeApexCount: Number(initializedAssembly.activeApexCount) || 0,
    tensionPendingCount: Number(initializedAssembly.tensionPendingCount) || 0,
    maxEta: Number(initializedAssembly.maxEta) || 0
  };
}

async function solveInitialPlasticEquilibrium(
  elementCaches,
  assemblyPattern,
  gravityRhsFreeBase,
  materialPoints,
  ndof,
  freeDofs,
  fixedValues,
  initialSolution,
  runControl,
  onProgress,
  options = {}
) {
  const initializedPredictor = await initializePlasticPredictorReferenceState(
    elementCaches,
    assemblyPattern,
    gravityRhsFreeBase,
    materialPoints,
    initialSolution,
    runControl
  );
  return solveNonlinearPhase(
    elementCaches,
    assemblyPattern,
    gravityRhsFreeBase,
    materialPoints,
    ndof,
    freeDofs,
    fixedValues,
    runControl,
    onProgress,
    options,
    {
      phaseKind: 'initial-gravity',
      formulationMode: 'total',
      allowLoadStepping: true,
      targetLoadFactor: 1,
      targetForceBase: initializedPredictor.targetForceBase,
      initialSolution
    }
  );
}

async function solveServiceLoadPhase(
  elementCaches,
  assemblyPattern,
  loadRhsFreeBase,
  materialPoints,
  ndof,
  freeDofs,
  fixedValues,
  initialSolution,
  runControl,
  onProgress,
  options = {}
) {
  return solveNonlinearPhase(
    elementCaches,
    assemblyPattern,
    loadRhsFreeBase,
    materialPoints,
    ndof,
    freeDofs,
    fixedValues,
    runControl,
    onProgress,
    options,
    {
      phaseKind: 'service-load',
      formulationMode: 'incremental',
      allowLoadStepping: true,
      targetLoadFactor: 1,
      initialSolution
    }
  );
}

function safetySigmaMsfAtProgress(sigmaStart, sigmaTarget, progress) {
  const clampedProgress = Math.max(0, Math.min(Number(progress) || 0, 1));
  return sigmaStart + (sigmaTarget - sigmaStart) * clampedProgress;
}

function extractIncrementalMechanismMetrics(fromCheckpoint, toPhase) {
  const displacementIncrement = subtractSolutionVectors(toPhase?.solution, fromCheckpoint?.solution);
  let incrementalDisplacementMaxAbs = 0;
  for (let index = 0; index < displacementIncrement.length; index += 1) {
    incrementalDisplacementMaxAbs = Math.max(incrementalDisplacementMaxAbs, Math.abs(Number(displacementIncrement[index]) || 0));
  }
  let maxAccumulatedPlasticIncrement = 0;
  let totalAccumulatedPlasticIncrement = 0;
  const fromMaterialPoints = fromCheckpoint?.materialPoints || [];
  const toMaterialPoints = toPhase?.materialPoints || [];
  const pointCount = Math.max(fromMaterialPoints.length, toMaterialPoints.length);
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += 1) {
    const fromPlastic = Math.max(Number(fromMaterialPoints?.[pointIndex]?.committedState?.accumulatedPlasticStrain) || 0, 0);
    const toPlastic = Math.max(Number(toMaterialPoints?.[pointIndex]?.committedState?.accumulatedPlasticStrain) || 0, 0);
    const increment = Math.max(toPlastic - fromPlastic, 0);
    maxAccumulatedPlasticIncrement = Math.max(maxAccumulatedPlasticIncrement, increment);
    totalAccumulatedPlasticIncrement += increment;
  }
  return {
    incrementalDisplacementNorm: vectorNorm(displacementIncrement),
    incrementalDisplacementMaxAbs,
    maxAccumulatedPlasticIncrement,
    totalAccumulatedPlasticIncrement
  };
}

function safetyMechanismPlateauDetected(acceptedHistory, options = {}) {
  const plateauWindow = Math.max(Math.round(Number(options?.safetyMechanismPlateauWindow) || 3), 2);
  const plateauRelativeTolerance = Math.max(Number(options?.safetyMechanismPlateauRelativeTolerance) || 0.01, 1e-4);
  const minIncrementalDisplacementNorm = Math.max(Number(options?.safetyMechanismMinIncrementalDisplacementNorm) || 1e-8, 0);
  const minPlasticIncrement = Math.max(Number(options?.safetyMechanismMinPlasticIncrement) || 1e-8, 0);
  if (!Array.isArray(acceptedHistory) || acceptedHistory.length < plateauWindow) return false;
  const window = acceptedHistory.slice(-plateauWindow);
  const sigmaLow = Number(window[0]?.sigmaMsfCommitted) || 0;
  const sigmaHigh = Number(window[window.length - 1]?.sigmaMsfCommitted) || 0;
  if (!(sigmaHigh > 0)) return false;
  if (((sigmaHigh - sigmaLow) / sigmaHigh) > plateauRelativeTolerance) return false;
  let displacementGrows = false;
  let plasticGrows = false;
  for (let index = 1; index < window.length; index += 1) {
    const previousDisplacement = Number(window[index - 1]?.incrementalDisplacementNorm) || 0;
    const currentDisplacement = Number(window[index]?.incrementalDisplacementNorm) || 0;
    if (currentDisplacement > previousDisplacement + 1e-12) displacementGrows = true;
    const previousPlastic = Number(window[index - 1]?.maxAccumulatedPlasticIncrement) || 0;
    const currentPlastic = Number(window[index]?.maxAccumulatedPlasticIncrement) || 0;
    if (currentPlastic > previousPlastic + 1e-12) plasticGrows = true;
  }
  const latest = window[window.length - 1];
  const mechanismLargeEnough =
    (Number(latest?.incrementalDisplacementNorm) || 0) >= minIncrementalDisplacementNorm ||
    (Number(latest?.maxAccumulatedPlasticIncrement) || 0) >= minPlasticIncrement;
  return mechanismLargeEnough && (displacementGrows || plasticGrows);
}

async function solveSafetyReductionPhase(
  elementCaches,
  assemblyPattern,
  fullExternalForceFree,
  stableCheckpoint,
  regionConstitutiveByRegion,
  ndof,
  freeDofs,
  fixedValues,
  runControl,
  onProgress,
  options,
  sigmaMsfStart,
  sigmaMsfTarget
) {
  const workingMaterialPoints = cloneMaterialPointCollection(stableCheckpoint.materialPoints);
  const applySafetyParameters = (progress, materialPoints) => {
    const sigmaMsf = safetySigmaMsfAtProgress(sigmaMsfStart, sigmaMsfTarget, progress);
    assignMaterialParametersByRegion(materialPoints, buildSafetyReducedRegionParameters(regionConstitutiveByRegion, sigmaMsf));
    return sigmaMsf;
  };
  applySafetyParameters(0, workingMaterialPoints);
  const safetyPhase = await solveNonlinearPhase(
    elementCaches,
    assemblyPattern,
    fullExternalForceFree,
    workingMaterialPoints,
    ndof,
    freeDofs,
    fixedValues,
    runControl,
    onProgress,
    options,
    {
      phaseKind: 'safety-cphi',
      formulationMode: 'total',
      allowLoadStepping: true,
      targetLoadFactor: 1,
      initialSolution: stableCheckpoint.solution,
      buildTargetForceFree: () => Float64Array.from(fullExternalForceFree),
      buildElementAnalysisOptions: (progress) => ({
        regionMaterialParametersByRegion: buildSafetyReducedRegionParameters(
          regionConstitutiveByRegion,
          safetySigmaMsfAtProgress(sigmaMsfStart, sigmaMsfTarget, progress)
        )
      }),
      progressLabel: (targetLoadFactor, acceptedSteps, rejectedSteps) =>
        `Safety c-phi reduction: continuation step ${acceptedSteps + rejectedSteps + 1}, target ΣMsf ${safetySigmaMsfAtProgress(sigmaMsfStart, sigmaMsfTarget, targetLoadFactor).toFixed(3)}`,
      commitPhaseState: (progress, materialPoints) => applySafetyParameters(progress, materialPoints)
    }
  );
  return {
    ...safetyPhase,
    materialPoints: workingMaterialPoints,
    sigmaMsfStart,
    sigmaMsfTarget,
    sigmaMsfCommitted: safetySigmaMsfAtProgress(sigmaMsfStart, sigmaMsfTarget, safetyPhase.loadFactorCommitted),
    sigmaMsfDisplayed: safetySigmaMsfAtProgress(sigmaMsfStart, sigmaMsfTarget, safetyPhase.displayedLoadFactor)
  };
}

async function solveSafetyReductionSearch(
  elementCaches,
  assemblyPattern,
  fullExternalForceFree,
  baseCheckpoint,
  regionConstitutiveByRegion,
  ndof,
  freeDofs,
  fixedValues,
  runControl,
  onProgress,
  options
) {
  const sigmaMax = Math.max(Number(options?.safetySigmaMsfMax) || SAFETY_SIGMA_MSF_MAX, 1);
  const sigmaBracketTolerance = Math.max(Number(options?.safetySigmaMsfBracketTolerance) || SAFETY_SIGMA_MSF_BRACKET_TOL, 1e-4);
  const sigmaGrowthFactor = Math.max(Number(options?.safetySigmaMsfGrowthFactor) || SAFETY_SIGMA_MSF_GROWTH_FACTOR, 1.05);
  const maxSearchTrials = Math.max(Math.round(Number(options?.safetyMaxSearchTrials) || SAFETY_MAX_SEARCH_TRIALS), 1);
  const sigmaCutbackFactor = Math.min(Math.max(Number(options?.safetySigmaMsfCutbackFactor) || 0.5, 0.1), 0.95);
  const sigmaMinIncrement = Math.max(Number(options?.safetyMinSigmaMsfIncrement) || Math.min(sigmaBracketTolerance, 0.01), 1e-4);
  let sigmaIncrement = Math.max(Number(options?.safetyInitialSigmaMsfIncrement) || SAFETY_INITIAL_SIGMA_MSF_INCREMENT, sigmaMinIncrement);
  let stableCheckpoint = createMaterialPointCheckpoint(baseCheckpoint.materialPoints, baseCheckpoint.solution, {
    sigmaMsf: Math.max(Number(baseCheckpoint?.sigmaMsf) || 1, 1),
    label: 'safety-base'
  });
  const baseDisplayPhase = createSafetyDisplayPhaseFromCheckpoint(stableCheckpoint);
  let lowerBoundPhase = null;
  let lowerSigmaMsf = stableCheckpoint.sigmaMsf;
  let upperSigmaMsf = null;
  let failurePhase = null;
  const trialHistory = [];
  let totalCgIterations = 0;
  let totalNonlinearIterations = 0;
  let totalAcceptedContinuationSteps = 0;
  let totalRejectedContinuationSteps = 0;
  let peakActiveCount = 0;
  let peakActiveFaceCount = 0;
  let peakActiveEdgeCount = 0;
  let peakActiveApexCount = 0;
  let peakTensionPendingCount = 0;
  let peakEta = 0;
  const acceptedMechanismHistory = [];

  const accumulatePhaseMetrics = (phase) => {
    if (!phase) return;
    totalCgIterations += Number(phase.totalCgIterations) || 0;
    totalNonlinearIterations += Number(phase.totalNonlinearIterations) || 0;
    totalAcceptedContinuationSteps += Number(phase.acceptedSteps) || 0;
    totalRejectedContinuationSteps += Number(phase.rejectedSteps) || 0;
    peakActiveCount = Math.max(peakActiveCount, Number(phase.peakActiveCount) || 0);
    peakActiveFaceCount = Math.max(peakActiveFaceCount, Number(phase.peakActiveFaceCount) || 0);
    peakActiveEdgeCount = Math.max(peakActiveEdgeCount, Number(phase.peakActiveEdgeCount) || 0);
    peakActiveApexCount = Math.max(peakActiveApexCount, Number(phase.peakActiveApexCount) || 0);
    peakTensionPendingCount = Math.max(peakTensionPendingCount, Number(phase.peakTensionPendingCount) || 0);
    peakEta = Math.max(peakEta, Number(phase.peakEta) || 0);
  };

  for (let trialIndex = 1; trialIndex <= maxSearchTrials; trialIndex += 1) {
    if (upperSigmaMsf != null && (upperSigmaMsf - lowerSigmaMsf) <= sigmaBracketTolerance) {
      return {
        status: 'bracketed',
        failureCode: failurePhase?.failureCode || 'step-below-minimum',
        failureOutcomeClass: classifyFailureOutcomeClass(failurePhase?.failureCode || 'step-below-minimum'),
        factorOfSafety: lowerSigmaMsf,
        factorOfSafetyLower: lowerSigmaMsf,
        factorOfSafetyUpper: upperSigmaMsf,
        strengthRetained: 1 / Math.max(lowerSigmaMsf, 1),
        displayedPhase: failurePhase || lowerBoundPhase || baseDisplayPhase,
        lowerBoundPhase,
        lowerBoundCheckpoint: stableCheckpoint,
        failurePhase,
        history: trialHistory,
        totalCgIterations,
        totalNonlinearIterations,
        totalAcceptedContinuationSteps,
        totalRejectedContinuationSteps,
        peakActiveCount,
        peakActiveFaceCount,
        peakActiveEdgeCount,
        peakActiveApexCount,
        peakTensionPendingCount,
        peakEta
      };
    }
    if (lowerSigmaMsf >= sigmaMax - sigmaBracketTolerance) break;
    const sigmaTarget = Math.min(lowerSigmaMsf + sigmaIncrement, sigmaMax);
    const phase = await solveSafetyReductionPhase(
      elementCaches,
      assemblyPattern,
      fullExternalForceFree,
      stableCheckpoint,
      regionConstitutiveByRegion,
      ndof,
      freeDofs,
      fixedValues,
      runControl,
      onProgress,
      options,
      lowerSigmaMsf,
      sigmaTarget
    );
    const mechanismMetrics = extractIncrementalMechanismMetrics(stableCheckpoint, phase);
    trialHistory.push({
      index: trialHistory.length + 1,
      sigmaMsfStart: lowerSigmaMsf,
      sigmaMsfTarget: sigmaTarget,
      sigmaMsfCommitted: phase.sigmaMsfCommitted,
      sigmaMsfDisplayed: phase.sigmaMsfDisplayed,
      converged: phase.converged,
      failureCode: phase.failureCode || '',
      failureOutcomeClass: phase.failureOutcomeClass || 'unknown',
      failureReason: phase.failureReason || '',
      incrementalDisplacementNorm: mechanismMetrics.incrementalDisplacementNorm,
      incrementalDisplacementMaxAbs: mechanismMetrics.incrementalDisplacementMaxAbs,
      maxAccumulatedPlasticIncrement: mechanismMetrics.maxAccumulatedPlasticIncrement,
      totalAccumulatedPlasticIncrement: mechanismMetrics.totalAccumulatedPlasticIncrement,
      acceptedContinuationSteps: phase.acceptedSteps,
      rejectedContinuationSteps: phase.rejectedSteps
    });
    accumulatePhaseMetrics(phase);
    if (phase.converged) {
      lowerSigmaMsf = sigmaTarget;
      lowerBoundPhase = phase;
      stableCheckpoint = createMaterialPointCheckpoint(phase.materialPoints, phase.solution, {
        sigmaMsf: sigmaTarget,
        label: `stable-${sigmaTarget.toFixed(3)}`
      });
      acceptedMechanismHistory.push({
        sigmaMsfCommitted: sigmaTarget,
        ...mechanismMetrics
      });
      if (safetyMechanismPlateauDetected(acceptedMechanismHistory, options)) {
        return {
          status: 'mechanism-developed',
          failureCode: 'mechanism-developed',
          failureOutcomeClass: classifyFailureOutcomeClass('mechanism-developed'),
          factorOfSafety: lowerSigmaMsf,
          factorOfSafetyLower: lowerSigmaMsf,
          factorOfSafetyUpper: upperSigmaMsf,
          strengthRetained: 1 / Math.max(lowerSigmaMsf, 1),
          displayedPhase: lowerBoundPhase || baseDisplayPhase,
          lowerBoundPhase,
          lowerBoundCheckpoint: stableCheckpoint,
          failurePhase,
          history: trialHistory,
          totalCgIterations,
          totalNonlinearIterations,
          totalAcceptedContinuationSteps,
          totalRejectedContinuationSteps,
          peakActiveCount,
          peakActiveFaceCount,
          peakActiveEdgeCount,
          peakActiveApexCount,
          peakTensionPendingCount,
          peakEta
        };
      }
      sigmaIncrement = Math.min(Math.max(sigmaIncrement * sigmaGrowthFactor, sigmaMinIncrement), Math.max(sigmaMax - lowerSigmaMsf, sigmaMinIncrement));
      continue;
    }
    upperSigmaMsf = upperSigmaMsf == null ? sigmaTarget : Math.min(upperSigmaMsf, sigmaTarget);
    failurePhase = phase;
    sigmaIncrement = Math.max(Math.min(sigmaIncrement * sigmaCutbackFactor, Math.max((upperSigmaMsf - lowerSigmaMsf) * 0.5, sigmaMinIncrement)), sigmaMinIncrement);
  }

  if (upperSigmaMsf == null) {
    return {
      status: 'no-failure-found',
      failureCode: 'no-failure-found',
      failureOutcomeClass: classifyFailureOutcomeClass('no-failure-found'),
      factorOfSafety: lowerSigmaMsf,
      factorOfSafetyLower: lowerSigmaMsf,
      factorOfSafetyUpper: null,
      strengthRetained: 1 / Math.max(lowerSigmaMsf, 1),
      displayedPhase: lowerBoundPhase || baseDisplayPhase,
      lowerBoundPhase,
      lowerBoundCheckpoint: stableCheckpoint,
      failurePhase: null,
      history: trialHistory,
      totalCgIterations,
      totalNonlinearIterations,
      totalAcceptedContinuationSteps,
      totalRejectedContinuationSteps,
      peakActiveCount,
      peakActiveFaceCount,
      peakActiveEdgeCount,
      peakActiveApexCount,
      peakTensionPendingCount,
      peakEta
    };
  }

  return {
    status: 'bracketed',
    failureCode: failurePhase?.failureCode || 'step-below-minimum',
    failureOutcomeClass: classifyFailureOutcomeClass(failurePhase?.failureCode || 'step-below-minimum'),
    factorOfSafety: lowerSigmaMsf,
    factorOfSafetyLower: lowerSigmaMsf,
    factorOfSafetyUpper: upperSigmaMsf,
    strengthRetained: 1 / Math.max(lowerSigmaMsf, 1),
    displayedPhase: failurePhase || lowerBoundPhase || baseDisplayPhase,
    lowerBoundPhase,
    lowerBoundCheckpoint: stableCheckpoint,
    failurePhase,
    history: trialHistory,
    totalCgIterations,
    totalNonlinearIterations,
    totalAcceptedContinuationSteps,
    totalRejectedContinuationSteps,
    peakActiveCount,
    peakActiveFaceCount,
    peakActiveEdgeCount,
    peakActiveApexCount,
    peakTensionPendingCount,
    peakEta
  };
}

function buildNodalDisplacements(mesh, solution) {
  const U = solution || new Float64Array(2 * (mesh?.nodes?.length || 0));
  return (mesh?.nodes || []).map((_node, nodeId) => ({
    ux: Number(U[2 * nodeId]) || 0,
    uy: Number(U[2 * nodeId + 1]) || 0
  }));
}

function subtractNodalDisplacementFields(totalDisplacements, baselineDisplacements) {
  const count = Math.max(totalDisplacements?.length || 0, baselineDisplacements?.length || 0);
  return Array.from({ length: count }, (_item, index) => ({
    ux: (Number(totalDisplacements?.[index]?.ux) || 0) - (Number(baselineDisplacements?.[index]?.ux) || 0),
    uy: (Number(totalDisplacements?.[index]?.uy) || 0) - (Number(baselineDisplacements?.[index]?.uy) || 0)
  }));
}

function buildTerrainSettlementProfile(mesh, nodalDisplacements) {
  const terrainNodeIds = new Set();
  (mesh.constraintEdges || []).forEach((edge) => {
    if (edge?.markerType !== 'outer' || edge?.source !== 'terrain') return;
    (edge.nodeIds || [edge.n1, edge.n2]).forEach((nodeId) => terrainNodeIds.add(nodeId));
  });
  return [...terrainNodeIds]
    .map((nodeId) => ({
      x: mesh.nodes[nodeId]?.x ?? 0,
      y: mesh.nodes[nodeId]?.y ?? 0,
      settlement: -(nodalDisplacements[nodeId]?.uy || 0),
      ux: nodalDisplacements[nodeId]?.ux || 0
    }))
    .sort((a, b) => a.x - b.x || b.y - a.y);
}

function summarizeDeformation(nodalDisplacements, elementResults) {
  let maxSettlement = 0;
  let maxHorizontalDisplacement = 0;
  let maxInitialSettlement = 0;
  let activeMcElementCount = 0;
  let activeMcFaceElementCount = 0;
  let activeMcEdgeElementCount = 0;
  let activeMcApexElementCount = 0;
  let tensionCutoffActiveElementCount = 0;
  let exceededMcElementCount = 0;
  let inadmissibleInitialElementCount = 0;
  let maxEquivalentPlasticStrain = 0;
  let maxSafetyEquivalentPlasticIncrement = 0;
  let maxInitialEquivalentPlasticStrain = 0;
  let initialPlasticElementCount = 0;
  let maxInitialEtaMcPredictor = 0;
  let maxInitialEtaMcEquilibrated = 0;
  nodalDisplacements.forEach((item) => {
    maxSettlement = Math.max(maxSettlement, -(item?.uy || 0));
    maxHorizontalDisplacement = Math.max(maxHorizontalDisplacement, Math.abs(item?.ux || 0));
  });
  let maxMcEta = 0;
  let hasInfiniteMcEta = false;
  let maxDeltaSigmaYy = 0;
  elementResults.forEach((item) => {
    const tensionCutoffActive = isTensionCutoffActiveState(item?.materialState, item?.materialDiagnostics, item?.mc);
    const etaValue = Number(item?.mc?.eta);
    if (!tensionCutoffActive && Number.isFinite(etaValue)) {
      maxMcEta = Math.max(maxMcEta, etaValue);
    } else if (tensionCutoffActive || etaValue > 0 || item?.mc?.state === 'tension-cutoff') {
      hasInfiniteMcEta = true;
    }
    maxDeltaSigmaYy = Math.max(maxDeltaSigmaYy, -Number(item?.stressIncrement?.syy || 0));
    if (item?.materialDiagnostics?.currentlyMcActive) activeMcElementCount += 1;
    if (item?.materialDiagnostics?.exactBranchKind === 'MC_FACE_F13') activeMcFaceElementCount += 1;
    if (item?.materialDiagnostics?.exactBranchKind === 'MC_EDGE_S23_EQUAL' || item?.materialDiagnostics?.exactBranchKind === 'MC_EDGE_S12_EQUAL') activeMcEdgeElementCount += 1;
    if (item?.materialDiagnostics?.exactBranchKind === 'MC_APEX_FORMAL') activeMcApexElementCount += 1;
    if (tensionCutoffActive) tensionCutoffActiveElementCount += 1;
    if (item?.materialDiagnostics?.hasEverExceededMc) exceededMcElementCount += 1;
    if (item?.materialDiagnostics?.initialStateAdmissible === false) inadmissibleInitialElementCount += 1;
    maxEquivalentPlasticStrain = Math.max(maxEquivalentPlasticStrain, Number(item?.materialState?.accumulatedPlasticStrain) || 0);
    maxSafetyEquivalentPlasticIncrement = Math.max(maxSafetyEquivalentPlasticIncrement, Number(item?.materialDiagnostics?.safetyEquivalentPlasticIncrement) || 0);
    const predictorEta = Number(item?.predictorMaterialState?.etaMcCurrent ?? item?.predictorMaterialState?.initialEtaMc);
    if (Number.isFinite(predictorEta)) maxInitialEtaMcPredictor = Math.max(maxInitialEtaMcPredictor, predictorEta);
    const equilibratedEta = Number(item?.referenceMaterialState?.equilibratedInitialEtaMc ?? item?.referenceMaterialState?.etaMcCurrent);
    if (Number.isFinite(equilibratedEta)) maxInitialEtaMcEquilibrated = Math.max(maxInitialEtaMcEquilibrated, equilibratedEta);
    const initialEquivalentPlastic = Number(item?.referenceMaterialState?.accumulatedPlasticStrain) || 0;
    maxInitialEquivalentPlasticStrain = Math.max(maxInitialEquivalentPlasticStrain, initialEquivalentPlastic);
    if (initialEquivalentPlastic > 0) initialPlasticElementCount += 1;
  });
  return {
    maxSettlement,
    maxHorizontalDisplacement,
    maxInitialSettlement,
    maxMcEta,
    hasInfiniteMcEta,
    maxDeltaSigmaYy,
    maxEquivalentPlasticStrain,
    maxSafetyEquivalentPlasticIncrement,
    maxInitialEquivalentPlasticStrain,
    initialPlasticElementCount,
    maxInitialEtaMcPredictor,
    maxInitialEtaMcEquilibrated,
    activeMcElementCount,
    activeMcFaceElementCount,
    activeMcEdgeElementCount,
    activeMcApexElementCount,
    tensionCutoffActiveElementCount,
    tensionPendingElementCount: tensionCutoffActiveElementCount,
    exceededMcElementCount,
    inadmissibleInitialElementCount
  };
}

function recoverElementResults(mesh, elementCaches, U, materialPoints, porePressureByElement = null, comparisonMaterialPoints = null) {
  const out = [];
  const precomputedStrainFlat = backendElementStrain(elementCaches, U);
  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const cell = mesh.cells[elementCache.cellIndex];
    const gpRecords = [];
    const avgStrain = { exx: 0, eyy: 0, gxy: 0 };
    const avgStress2D = { sxx: 0, syy: 0, txy: 0 };
    const avgInitialStress2D = { sxx: 0, syy: 0, txy: 0 };
    const avgStress6 = [0, 0, 0, 0, 0, 0];
    const avgInitialStress6 = [0, 0, 0, 0, 0, 0];
    const area = Math.max(Number(elementCache.area) || 0, 1e-12);
    let representative = null;
    let representativeScore = Number.NEGATIVE_INFINITY;
    let anyActive = false;
    let anyExceeded = false;
    let anyTension = false;
    let anyInitialInadmissible = false;
    let safetyEquivalentPlasticIncrement = 0;
    let maxLocalStrengthReserve = 0;
    let maxEtaMcFinal = 0;

    for (const gp of elementCache.integrationPoints || []) {
      const materialPoint = materialPoints[gp.globalIndex];
      const precomputedStrain = precomputedStrainFlat && elementCache.kind === 't3'
        ? {
            exx: Number(precomputedStrainFlat[elementIndex * 3]) || 0,
            eyy: Number(precomputedStrainFlat[elementIndex * 3 + 1]) || 0,
            gxy: Number(precomputedStrainFlat[elementIndex * 3 + 2]) || 0
          }
        : null;
      const response = recoverIntegrationPointMaterialResponse(elementCache, gp, U, materialPoint, {
        stage: 'final-recovery'
      }, precomputedStrain);
      materialPoint.trialState = response.update.trialState;
      materialPoint.diagnostics = response.update.diagnostics;
      const weight = (Number(gp.areaWeight) || 0) / area;
      const initialStressFe = extractStress2DFrom6(materialPoint.referenceState.effectiveStress6);
      const stress6 = response.update.stressTrial6 || [];
      const initialStress6 = materialPoint.referenceState.effectiveStress6 || [];
      avgStrain.exx += weight * (Number(response.strain?.exx) || 0);
      avgStrain.eyy += weight * (Number(response.strain?.eyy) || 0);
      avgStrain.gxy += weight * (Number(response.strain?.gxy) || 0);
      avgStress2D.sxx += weight * (Number(response.stress2D?.sxx) || 0);
      avgStress2D.syy += weight * (Number(response.stress2D?.syy) || 0);
      avgStress2D.txy += weight * (Number(response.stress2D?.txy) || 0);
      avgInitialStress2D.sxx += weight * (Number(initialStressFe?.sxx) || 0);
      avgInitialStress2D.syy += weight * (Number(initialStressFe?.syy) || 0);
      avgInitialStress2D.txy += weight * (Number(initialStressFe?.txy) || 0);
      for (let k = 0; k < 6; k += 1) {
        avgStress6[k] += weight * (Number(stress6[k]) || 0);
        avgInitialStress6[k] += weight * (Number(initialStress6[k]) || 0);
      }
      const comparisonMaterialState = comparisonMaterialPoints?.[gp.globalIndex]
        ? snapshotMaterialPointState(
          comparisonMaterialPoints[gp.globalIndex].committedState || comparisonMaterialPoints[gp.globalIndex].trialState
        )
        : null;
      const displayedMaterialState = snapshotMaterialPointState(materialPoint.trialState);
      const increment = Math.max(
        (Number(displayedMaterialState?.accumulatedPlasticStrain) || 0) - (Number(comparisonMaterialState?.accumulatedPlasticStrain) || 0),
        0
      );
      safetyEquivalentPlasticIncrement = Math.max(safetyEquivalentPlasticIncrement, increment);
      const principalAtGp = response.update.diagnostics?.principal || principalStress2DCompressionPositive(negateNormalAndShear(response.stress2D));
      const mcAtGp = response.update.diagnostics?.mc || mohrCoulombIndicator(principalAtGp, materialPoint.materialParameters);
      const tensionAtGp = isTensionCutoffActiveState(response.update.trialState, response.update.diagnostics, mcAtGp);
      const eta = Number(response.update.diagnostics?.etaMcFinal ?? mcAtGp?.eta);
      const active = displayedMaterialState?.currentlyMcActive === true;
      const score = (tensionAtGp ? 3e9 : 0) + (active ? 2e9 : 0) + (Number.isFinite(eta) ? eta : 1e9);
      if (!representative || score > representativeScore) {
        representativeScore = score;
        representative = {
          gp,
          response,
          materialPoint,
          comparisonMaterialState,
          displayedMaterialState,
          committedMaterialState: snapshotMaterialPointState(materialPoint.committedState),
          predictorMaterialState: snapshotMaterialPointState(materialPoint.predictorState),
          referenceMaterialState: snapshotMaterialPointState(materialPoint.referenceState),
          mcAtGp,
          tensionAtGp
        };
      }
      anyActive = anyActive || active;
      anyExceeded = anyExceeded || displayedMaterialState?.hasEverExceededMc === true;
      anyTension = anyTension || tensionAtGp;
      anyInitialInadmissible = anyInitialInadmissible || materialPoint.predictorState?.initialStateAdmissible === false;
      maxLocalStrengthReserve = Math.max(maxLocalStrengthReserve, Number(response.update.diagnostics?.localStrengthReserve) || 0);
      maxEtaMcFinal = Math.max(maxEtaMcFinal, Number.isFinite(eta) ? eta : 0);
      gpRecords.push({
        gpIndex: gp.gpIndex,
        integrationPointIndex: gp.globalIndex,
        x: gp.x,
        y: gp.y,
        areaWeight: gp.areaWeight,
        strain: response.strain,
        stress2D: response.stress2D,
        effectiveStress: negateNormalAndShear(response.stress2D),
        materialState: displayedMaterialState,
        materialDiagnostics: response.update.diagnostics,
        mc: mcAtGp,
        tensionCutoffActive: tensionAtGp
      });
    }

    const rep = representative || {};
    const response = rep.response || {};
    const materialPoint = rep.materialPoint || materialPoints[elementIndex];
    const displayedMaterialState = rep.displayedMaterialState || snapshotMaterialPointState(materialPoint?.trialState);
    const committedMaterialState = rep.committedMaterialState || snapshotMaterialPointState(materialPoint?.committedState);
    const initialStress = negateNormalAndShear(avgInitialStress2D);
    const initialStress3D = effectiveStress6ToCompressionPositiveStress3D(avgInitialStress6);
    const stressIncrement = {
      sxx: avgStress2D.sxx - avgInitialStress2D.sxx,
      syy: avgStress2D.syy - avgInitialStress2D.syy,
      txy: avgStress2D.txy - avgInitialStress2D.txy
    };
    const sigmaIncrementGeo = negateNormalAndShear(stressIncrement);
    const sigmaEff = negateNormalAndShear(avgStress2D);
    const sigmaEff3D = effectiveStress6ToCompressionPositiveStress3D(avgStress6);
    const porePressure = Math.max(Number(porePressureByElement?.[elementIndex]) || 0, 0);
    const initialTotalStress = {
      sxx: (Number(initialStress?.sxx) || 0) + porePressure,
      syy: (Number(initialStress?.syy) || 0) + porePressure,
      txy: Number(initialStress?.txy) || 0
    };
    const initialTotalStress3D = {
      sxx: (Number(initialStress3D?.sxx) || 0) + porePressure,
      syy: (Number(initialStress3D?.syy) || 0) + porePressure,
      szz: (Number(initialStress3D?.szz) || 0) + porePressure,
      txy: Number(initialStress3D?.txy) || 0
    };
    const totalStress = {
      sxx: (Number(sigmaEff?.sxx) || 0) + porePressure,
      syy: (Number(sigmaEff?.syy) || 0) + porePressure,
      txy: Number(sigmaEff?.txy) || 0
    };
    const totalStress3D = {
      sxx: (Number(sigmaEff3D?.sxx) || 0) + porePressure,
      syy: (Number(sigmaEff3D?.syy) || 0) + porePressure,
      szz: (Number(sigmaEff3D?.szz) || 0) + porePressure,
      txy: Number(sigmaEff3D?.txy) || 0
    };
    const principal = principalStress2DCompressionPositive(sigmaEff);
    const mc = mohrCoulombIndicator(principal, materialPoint?.materialParameters);
    const tensionCutoffActive = anyTension || isTensionCutoffActiveState(displayedMaterialState, response.update?.diagnostics, mc);
    out.push({
      elementIndex,
      regionIndex: cell?.regionIndex ?? -1,
      area: elementCache.area,
      centroid: elementCache.centroid || cell?.centroid || { x: 0, y: 0 },
      strain: avgStrain,
      stressIncrement,
      stressIncrementGeo: sigmaIncrementGeo,
      porePressure,
      initialEffectiveStress: initialStress,
      initialEffectiveStress3D: initialStress3D,
      initialTotalStress,
      initialTotalStress3D,
      effectiveStress: sigmaEff,
      effectiveStress3D: sigmaEff3D,
      totalStress,
      totalStress3D,
      principal,
      mc,
      gaussPoints: gpRecords,
      predictorMaterialState: rep.predictorMaterialState || snapshotMaterialPointState(materialPoint?.predictorState),
      comparisonMaterialState: rep.comparisonMaterialState || null,
      referenceMaterialState: rep.referenceMaterialState || snapshotMaterialPointState(materialPoint?.referenceState),
      committedMaterialState,
      materialState: displayedMaterialState,
      materialDiagnostics: {
        constitutiveModel: response.update?.diagnostics?.constitutiveModel || materialPoint?.materialModel?.kind || 'linear-elastic',
        activeYieldSurface: displayedMaterialState?.activeYieldSurface || response.update?.diagnostics?.activeYieldSurface || 'NONE',
        diagnosticYieldSurface: response.update?.diagnostics?.diagnosticYieldSurface || 'NONE',
        exactBranchKind: displayedMaterialState?.exactBranchKind || response.update?.diagnostics?.exactBranchKind || 'ELASTIC',
        multiplicityKind: displayedMaterialState?.multiplicityKind || response.update?.diagnostics?.finalMultiplicityKind || 'DISTINCT',
        trialBranchKind: response.update?.diagnostics?.trialBranchKind || displayedMaterialState?.exactBranchKind || 'ELASTIC',
        trialMultiplicityKind: response.update?.diagnostics?.trialMultiplicityKind || displayedMaterialState?.multiplicityKind || 'DISTINCT',
        representativeBasisSource: displayedMaterialState?.representativeBasisSource || response.update?.diagnostics?.representativeBasisSource || 'trial',
        localReturnMode: displayedMaterialState?.localReturnMode || response.update?.diagnostics?.localReturnMode || 'elastic',
        localFallbackUsed: displayedMaterialState?.localFallbackUsed === true || response.update?.diagnostics?.localFallbackUsed === true,
        edgeTotalMultiplier: Number(displayedMaterialState?.edgeTotalMultiplier ?? response.update?.diagnostics?.edgeTotalMultiplier) || 0,
        edgeMixWeight: Number(displayedMaterialState?.edgeMixWeight ?? response.update?.diagnostics?.edgeMixWeight) || 0,
        plasticMultipliers: Array.isArray(response.update?.diagnostics?.plasticMultipliers) ? [...response.update.diagnostics.plasticMultipliers] : [],
        branchAcceptanceResidual: Number(response.update?.diagnostics?.branchAcceptanceResidual) || 0,
        tangentConditionNumber: Number(response.update?.diagnostics?.tangentConditionNumber) || Number.POSITIVE_INFINITY,
        tangentQuality: response.update?.diagnostics?.tangentQuality || 'unknown',
        apexAdmissibilityReason: response.update?.diagnostics?.apexAdmissibilityReason || '',
        localFailureClassification: response.update?.diagnostics?.localFailureClassification || '',
        fallbackSourceReason: response.update?.diagnostics?.fallbackSourceReason || '',
        localResidualsBySurface: response.update?.diagnostics?.localResidualsBySurface ? { ...response.update.diagnostics.localResidualsBySurface } : {},
        currentlyMcActive: anyActive,
        hasEverExceededMc: anyExceeded,
        committedActiveYieldSurface: committedMaterialState?.activeYieldSurface || 'NONE',
        committedExactBranchKind: committedMaterialState?.exactBranchKind || 'ELASTIC',
        committedCurrentlyMcActive: committedMaterialState?.currentlyMcActive === true,
        committedHasEverExceededMc: committedMaterialState?.hasEverExceededMc === true,
        initialStateAdmissible: !anyInitialInadmissible,
        initialEtaMc: Number(materialPoint?.predictorState?.initialEtaMc),
        initialFMc: Number(materialPoint?.predictorState?.initialFMc),
        predictorDiagnosticYieldSurface: materialPoint?.predictorState?.initialDiagnosticYieldSurface || 'NONE',
        predictorEtaMc: Number(materialPoint?.predictorState?.etaMcCurrent ?? materialPoint?.predictorState?.initialEtaMc),
        equilibratedInitialStateAvailable: materialPoint?.referenceState?.equilibratedInitialStateAvailable === true,
        equilibratedInitialStateAdmissible: materialPoint?.referenceState?.equilibratedInitialStateAdmissible !== false,
        equilibratedInitialFMc: Number(materialPoint?.referenceState?.equilibratedInitialFMc),
        equilibratedInitialEtaMc: Number(materialPoint?.referenceState?.equilibratedInitialEtaMc ?? materialPoint?.referenceState?.etaMcCurrent),
        equilibratedInitialDiagnosticYieldSurface: materialPoint?.referenceState?.equilibratedInitialDiagnosticYieldSurface || 'NONE',
        tensionCutoffActive,
        localStrengthReserve: maxLocalStrengthReserve,
        etaMcFinal: maxEtaMcFinal,
        safetyEquivalentPlasticIncrement,
        stateChanged: false
      }
    });
  }
  return out;
}

function samplePointCandidates(mesh, x, y) {
  if (mesh?.sampleGrid && mesh?.sampleBins) {
    const cellSize = Math.max(Number(mesh.sampleGrid.cellSize) || 0, 0.05);
    const ix = Math.floor((x - Number(mesh.sampleGrid.xMin || 0)) / cellSize);
    const iy = Math.floor((y - Number(mesh.sampleGrid.yMin || 0)) / cellSize);
    const keys = new Set();
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const key = `${ix + dx}:${iy + dy}`;
        if (mesh.sampleBins[key]) keys.add(key);
      }
    }
    return [...keys].flatMap((key) => mesh.sampleBins[key] || []);
  }
  return Array.from({ length: mesh?.cells?.length || 0 }, (_item, index) => index);
}

function sampleTriangleValue(point, triPoints, triValues, elementType = 't3') {
  const [a, b, c] = triPoints;
  const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (!(Math.abs(denom) > GEOM_EPS)) return null;
  const l1 = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denom;
  const l2 = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denom;
  const l3 = 1 - l1 - l2;
  if (l1 < -GEOM_EPS || l2 < -GEOM_EPS || l3 < -GEOM_EPS) return null;
  if (normalizeElementType(elementType) === 't6' && triValues.length >= 6) {
    const N = shapeFunctionsT6(l1, l2, l3);
    let out = 0;
    for (let i = 0; i < 6; i += 1) out += N[i] * (Number(triValues[i]) || 0);
    return out;
  }
  return l1 * triValues[0] + l2 * triValues[1] + l3 * triValues[2];
}

export function sampleDeformationState(mesh, result, x, y) {
  if (!mesh?.cells?.length || !result?.nodalDisplacements?.length) return null;
  if (!pointInPolygonHalfOpen(mesh.domainPolygon || [], x, y)) return null;
  const point = { x: Number(x), y: Number(y) };
  const candidateCells = samplePointCandidates(mesh, point.x, point.y);
  for (let i = 0; i < candidateCells.length; i += 1) {
    const cellIndex = candidateCells[i];
    const cell = mesh.cells[cellIndex];
    if (!cell) continue;
    if (
      point.x < cell.bbox.xMin - GEOM_EPS ||
      point.x > cell.bbox.xMax + GEOM_EPS ||
      point.y < cell.bbox.yMin - GEOM_EPS ||
      point.y > cell.bbox.yMax + GEOM_EPS
    ) continue;
    if (!pointInPolygonHalfOpen(cell.polygon, point.x, point.y)) continue;
    for (let j = 0; j < cell.triangleIndices.length; j += 1) {
      const triangleIndex = cell.triangleIndices[j];
      const element = mesh.elements[triangleIndex];
      if (!element) continue;
      const triPoints = element.slice(0, 3).map((nodeId) => mesh.nodes[nodeId]);
      const ux = sampleTriangleValue(point, triPoints, element.map((nodeId) => result.nodalDisplacements[nodeId]?.ux || 0), mesh.elementType);
      const uy = sampleTriangleValue(point, triPoints, element.map((nodeId) => result.nodalDisplacements[nodeId]?.uy || 0), mesh.elementType);
      if (!(Number.isFinite(ux) && Number.isFinite(uy))) continue;
      const tensionCutoffActive = result.elementResults?.[triangleIndex]?.materialDiagnostics?.tensionCutoffActive === true;
      const mcEta = Number(result.elementResults?.[triangleIndex]?.mc?.eta);
      return {
        point,
        cellIndex,
        triangleIndex,
        ux,
        uy,
        uTotal: Math.hypot(ux, uy),
        settlement: -uy,
        epsilonXx: Number(result.elementResults?.[triangleIndex]?.strain?.exx || 0),
        epsilonYy: Number(result.elementResults?.[triangleIndex]?.strain?.eyy || 0),
        gammaXy: Number(result.elementResults?.[triangleIndex]?.strain?.gxy || 0),
        equivalentPlasticStrain: Number(result.elementResults?.[triangleIndex]?.materialState?.accumulatedPlasticStrain || 0),
        safetyEquivalentPlasticIncrement: Number(result.elementResults?.[triangleIndex]?.materialDiagnostics?.safetyEquivalentPlasticIncrement || 0),
        deltaSigmaYy: -Number(result.elementResults?.[triangleIndex]?.stressIncrement?.syy || 0),
        sigmaYyEffInit: Number(result.elementResults?.[triangleIndex]?.initialEffectiveStress?.syy || 0),
        sigmaYyEff: Number(result.elementResults?.[triangleIndex]?.effectiveStress?.syy || 0),
        sigmaYyTotalInit: Number(result.elementResults?.[triangleIndex]?.initialTotalStress?.syy || 0),
        sigmaYyTotal: Number(result.elementResults?.[triangleIndex]?.totalStress?.syy || 0),
        sigmaXxEffInit: Number(result.elementResults?.[triangleIndex]?.initialEffectiveStress?.sxx || 0),
        sigmaXxEff: Number(result.elementResults?.[triangleIndex]?.effectiveStress?.sxx || 0),
        sigmaXxTotalInit: Number(result.elementResults?.[triangleIndex]?.initialTotalStress?.sxx || 0),
        sigmaXxTotal: Number(result.elementResults?.[triangleIndex]?.totalStress?.sxx || 0),
        tauXy: Number(result.elementResults?.[triangleIndex]?.effectiveStress?.txy || 0),
        porePressure: Number(result.elementResults?.[triangleIndex]?.porePressure || 0),
        mcEta: !tensionCutoffActive && Number.isFinite(mcEta) ? mcEta : null,
        tensionCutoffActive
      };
    }
  }
  return null;
}

export async function analyzeDeformationModel(input, onProgress = () => {}, runControl = null) {
  try {
    return await _analyzeDeformationModelImpl(input, onProgress, runControl);
  } finally {
    // The inner implementation disposes the backend on the happy path, but
    // we belt-and-suspender the release here so a throw mid-run cannot leak
    // a WebGL context or GPU.js kernel cache into a subsequent invocation.
    try { activeMatvecBackend?.dispose?.(); } catch { /* ignore */ }
    activeMatvecBackend = null;
    activeBackendInfo = { name: 'cpu-f64', reason: 'gpu-disabled' };
    activeBackendRuntimeWarnings = [];
  }
}

async function _analyzeDeformationModelImpl(input, onProgress = () => {}, runControl = null) {
  const startedAt = performance.now();
  activeBackendRuntimeWarnings = [];
  const model = input?.model;
  if (!model?.terrain?.vertices?.length || !model?.regions?.length) {
    throw new Error('The deformation screen needs a valid Bishop section model first.');
  }

  const warnings = [];
  const analysisType = input?.options?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
  const constitutiveModel = input?.options?.constitutiveModel === 'linear-elastic'
    ? 'linear-elastic'
    : input?.options?.constitutiveModel === 'mc-plastic'
      ? 'mc-plastic'
      : 'mc-reduced-stiffness';
  const options = {
    analysisType,
    meshElementType: normalizeElementType(input?.options?.meshElementType ?? input?.options?.elementOrder),
    meshTargetArea: Math.max(Number(input?.options?.meshTargetArea) || 0.05, 0.01),
    loadMode: input?.options?.loadMode === 'total' ? 'total' : 'pressure',
    totalLoad: input?.options?.totalLoad,
    outOfPlaneLength: Math.max(Number(input?.options?.outOfPlaneLength) || 10, 0.1),
    useSeepagePorePressures: input?.options?.useSeepagePorePressures === true,
    initialStressMode: input?.options?.initialStressMode === 'plastic-geostatic' ? 'plastic-geostatic' : 'predictor',
    constitutiveModel,
    nonlinearMaxIterations: Math.max(Math.round(Number(input?.options?.nonlinearMaxIterations) || NONLINEAR_MAX_ITER), 1),
    initialLoadStep: Math.min(Math.max(Number(input?.options?.initialLoadStep) || NONLINEAR_INITIAL_LOAD_STEP, NONLINEAR_MIN_LOAD_STEP), 1),
    minLoadStep: Math.max(Number(input?.options?.minLoadStep) || NONLINEAR_MIN_LOAD_STEP, 1e-4),
    maxLoadSteps: Math.max(Math.round(Number(input?.options?.maxLoadSteps) || NONLINEAR_MAX_LOAD_STEPS), 1),
    residualRelTol: Math.max(Number(input?.options?.residualRelTol) || NONLINEAR_RESIDUAL_REL_TOL, 1e-8),
    residualAbsTol: Math.max(Number(input?.options?.residualAbsTol) || NONLINEAR_RESIDUAL_ABS_TOL, 1e-9),
    displacementRelTol: Math.max(Number(input?.options?.displacementRelTol) || NONLINEAR_DISPLACEMENT_REL_TOL, 1e-8),
    displacementAbsTol: Math.max(Number(input?.options?.displacementAbsTol) || NONLINEAR_DISPLACEMENT_ABS_TOL, 1e-12),
    loadStepGrowthFactor: Math.max(Number(input?.options?.loadStepGrowthFactor) || NONLINEAR_GROWTH_FACTOR, 1),
    loadStepCutbackFactor: Math.min(Math.max(Number(input?.options?.loadStepCutbackFactor) || NONLINEAR_CUTBACK_FACTOR, 0.1), 0.9),
    plasticLoadStepGrowthFactor: Math.max(Number(input?.options?.plasticLoadStepGrowthFactor) || 1.05, 1),
    plasticLoadStepCutbackFactor: Math.min(Math.max(Number(input?.options?.plasticLoadStepCutbackFactor) || 0.4, 0.1), 0.9),
    initialGravityPlasticLoadStepGrowthFactor: Math.max(Number(input?.options?.initialGravityPlasticLoadStepGrowthFactor) || 1.12, 1),
    initialGravityPlasticLoadStepCutbackFactor: Math.min(Math.max(Number(input?.options?.initialGravityPlasticLoadStepCutbackFactor) || 0.5, 0.1), 0.9),
    initialGravityMinLoadStep: Math.max(Number(input?.options?.initialGravityMinLoadStep) || (1 / 8192), 1e-5),
    initialGravityMaxLoadSteps: Math.max(Math.round(Number(input?.options?.initialGravityMaxLoadSteps) || 512), 1),
    plasticLineSearchReductionFactor: Math.min(Math.max(Number(input?.options?.plasticLineSearchReductionFactor) || 0.5, 0.1), 0.95),
    plasticLineSearchMaxBacktracks: Math.max(Math.round(Number(input?.options?.plasticLineSearchMaxBacktracks) || 4), 1),
    plasticLineSearchMinScale: Math.min(Math.max(Number(input?.options?.plasticLineSearchMinScale) || (1 / 64), 1e-4), 1),
    plasticLineSearchSufficientDecreaseFactor: Math.max(Number(input?.options?.plasticLineSearchSufficientDecreaseFactor) || 1e-3, 0),
    plasticLineSearchArmijoCoefficient: Math.max(Number(input?.options?.plasticLineSearchArmijoCoefficient) || 1e-4, 0),
    initialGravityPlasticLineSearchMaxBacktracks: Math.max(Math.round(Number(input?.options?.initialGravityPlasticLineSearchMaxBacktracks) || 5), 1),
    initialGravityPlasticLineSearchMinScale: Math.min(Math.max(Number(input?.options?.initialGravityPlasticLineSearchMinScale) || (1 / 32), 1e-4), 1),
    initialGravityPlasticLineSearchSufficientDecreaseFactor: Math.max(Number(input?.options?.initialGravityPlasticLineSearchSufficientDecreaseFactor) || 1e-3, 0),
    initialGravityPlasticLineSearchArmijoCoefficient: Math.max(Number(input?.options?.initialGravityPlasticLineSearchArmijoCoefficient) || 1e-4, 0),
    adaptiveContinuation: input?.options?.adaptiveContinuation !== false,
    continuationTargetIterations: Math.max(Number(input?.options?.continuationTargetIterations) || NONLINEAR_CONTINUATION_TARGET_ITERATIONS, 1),
    initialGravityContinuationTargetIterations: Math.max(Number(input?.options?.initialGravityContinuationTargetIterations) || NONLINEAR_CONTINUATION_TARGET_ITERATIONS, 1),
    safetyContinuationTargetIterations: Math.max(Number(input?.options?.safetyContinuationTargetIterations) || NONLINEAR_CONTINUATION_TARGET_ITERATIONS, 1),
    continuationTargetLineSearchScale: Math.max(Math.min(Number(input?.options?.continuationTargetLineSearchScale) || NONLINEAR_CONTINUATION_TARGET_LINE_SEARCH_SCALE, 1), 1e-6),
    continuationIterationExponent: Math.max(Number(input?.options?.continuationIterationExponent) || NONLINEAR_CONTINUATION_ITERATION_EXPONENT, 0),
    continuationLineSearchExponent: Math.max(Number(input?.options?.continuationLineSearchExponent) || NONLINEAR_CONTINUATION_LINE_SEARCH_EXPONENT, 0),
    useUnsymmetricPlasticSolver: input?.options?.useUnsymmetricPlasticSolver === true,
    unsymmetricLinearSolver: input?.options?.unsymmetricLinearSolver === 'bicgstab' ? 'bicgstab' : 'gmres-scaled',
    safetyInitialSigmaMsfIncrement: Math.max(Number(input?.options?.safetyInitialSigmaMsfIncrement) || SAFETY_INITIAL_SIGMA_MSF_INCREMENT, 1e-3),
    safetySigmaMsfGrowthFactor: Math.max(Number(input?.options?.safetySigmaMsfGrowthFactor) || SAFETY_SIGMA_MSF_GROWTH_FACTOR, 1.05),
    safetySigmaMsfCutbackFactor: Math.min(Math.max(Number(input?.options?.safetySigmaMsfCutbackFactor) || 0.5, 0.1), 0.95),
    safetyMinSigmaMsfIncrement: Math.max(Number(input?.options?.safetyMinSigmaMsfIncrement) || 1e-4, 1e-4),
    safetySigmaMsfMax: Math.max(Number(input?.options?.safetySigmaMsfMax) || SAFETY_SIGMA_MSF_MAX, 1),
    safetySigmaMsfBracketTolerance: Math.max(Number(input?.options?.safetySigmaMsfBracketTolerance) || SAFETY_SIGMA_MSF_BRACKET_TOL, 1e-4),
    safetyMaxSearchTrials: Math.max(Math.round(Number(input?.options?.safetyMaxSearchTrials) || SAFETY_MAX_SEARCH_TRIALS), 1),
    safetyMechanismPlateauWindow: Math.max(Math.round(Number(input?.options?.safetyMechanismPlateauWindow) || 3), 2),
    safetyMechanismPlateauRelativeTolerance: Math.max(Number(input?.options?.safetyMechanismPlateauRelativeTolerance) || 0.01, 1e-4),
    safetyMechanismMinIncrementalDisplacementNorm: Math.max(Number(input?.options?.safetyMechanismMinIncrementalDisplacementNorm) || 1e-8, 0),
    safetyMechanismMinPlasticIncrement: Math.max(Number(input?.options?.safetyMechanismMinPlasticIncrement) || 1e-8, 0),
    useGpuAcceleration: input?.options?.useGpuAcceleration === true,
    gpuPrecisionMode: String(input?.options?.gpuPrecisionMode || 'auto').toLowerCase() === 'double-single'
      ? 'double-single'
      : 'auto',
    linearAlgebraBackend: typeof input?.options?.linearAlgebraBackend === 'string'
      ? input.options.linearAlgebraBackend
      : null,
    gpuMinDof: Math.max(Math.round(Number(input?.options?.gpuMinDof) || GPU_DEFAULT_MIN_DOF), 0)
  };
  if (options.meshElementType === 't6' && options.useGpuAcceleration) {
    pushUniqueWarning(
      warnings,
      'T6 deformation currently uses the CPU f64 element path because the mixed-precision element kernels are T3-only.'
    );
    options.useGpuAcceleration = false;
    options.linearAlgebraBackend = null;
  }
  const load = normalizeLoad(model, options, warnings, analysisType === 'deformation' ? 'required' : 'optional');
  addDomainExtentWarnings(model, load, warnings);
  const hasSurfaceLoad = !!load;
  if (analysisType === 'safety-cphi') {
    if (options.constitutiveModel !== 'mc-plastic') {
      throw new Error('C-phi reduction safety analysis is only available with the Stage 2 elastoplastic constitutive model.');
    }
    if (options.initialStressMode !== 'plastic-geostatic') {
      throw new Error('C-phi reduction safety analysis requires the plastic geostatic initial stress mode so the base state is a converged elastoplastic equilibrium.');
    }
  }

  if (await runCheckpoint(runControl, true)) {
    throw new Error('Deformation run was interrupted before meshing started.');
  }

  const mesh = await buildDeformationMesh(
    model,
    model.regions,
    {
      ...options,
      load
    },
    (progress) => onProgress(progress)
  );

  const ndof = 2 * mesh.nodes.length;
  const elementCaches = buildDeformationElementCaches(mesh);
  const fixedValues = buildFixedDofMap(mesh);
  const freeDofs = [];
  const freeIndexByDof = new Map();
  for (let dof = 0; dof < ndof; dof += 1) {
    if (fixedValues.has(dof)) continue;
    freeIndexByDof.set(dof, freeDofs.length);
    freeDofs.push(dof);
  }
  const backendSetup = await createLinearAlgebraBackend({
    useGpuAcceleration: options.useGpuAcceleration,
    linearAlgebraBackend: options.linearAlgebraBackend,
    ndof: freeDofs.length,
    gpuMinDof: options.gpuMinDof,
    gpuPrecisionMode: options.gpuPrecisionMode
  }, warnings);
  activeMatvecBackend = backendSetup.backend;
  activeBackendInfo = backendSetup.info;
  const rows = Array.from({ length: ndof }, () => new Map());
  const loadRhs = new Float64Array(ndof);
  const gravityRhs = new Float64Array(ndof);
  const porePressureByElement = new Float64Array(mesh.elements.length);
  const porePressureByIntegrationPoint = new Float64Array(elementCaches.integrationPointCount || mesh.elements.length);
  const regionConstitutiveByRegion = prepareRegionConstitutiveModels(mesh, options, warnings);

  onProgress({
    stage: 'solving',
    percent: 46,
    message: 'Assembling the plane-strain stiffness matrix and geostatic gravity load...'
  });

  const elasticStiffnessTangentFlat = activeMatvecBackend?.elementElasticStiffness
    ? new Float64Array(elementCaches.length * 9)
    : null;
  if (elasticStiffnessTangentFlat) {
    for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
      const elementCache = elementCaches[elementIndex];
      const cell = mesh.cells[elementCache.cellIndex];
      const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
      const tangent2D = extractTangent2DFrom6(constitutive.materialModel.initialTangent6x6);
      const base = elementIndex * 9;
      elasticStiffnessTangentFlat[base] = tangent2D[0][0];
      elasticStiffnessTangentFlat[base + 1] = tangent2D[0][1];
      elasticStiffnessTangentFlat[base + 2] = tangent2D[0][2];
      elasticStiffnessTangentFlat[base + 3] = tangent2D[1][0];
      elasticStiffnessTangentFlat[base + 4] = tangent2D[1][1];
      elasticStiffnessTangentFlat[base + 5] = tangent2D[1][2];
      elasticStiffnessTangentFlat[base + 6] = tangent2D[2][0];
      elasticStiffnessTangentFlat[base + 7] = tangent2D[2][1];
      elasticStiffnessTangentFlat[base + 8] = tangent2D[2][2];
    }
  }
  const elasticStiffnessFlat = elasticStiffnessTangentFlat
    ? backendElementElasticStiffness(elementCaches, elasticStiffnessTangentFlat)
    : null;

  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const cell = mesh.cells[elementCache.cellIndex];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    let porePressureSum = 0;
    let gammaSum = 0;
    const gpCount = Math.max(elementCache.integrationPoints?.length || 0, 1);
    for (const gp of elementCache.integrationPoints || []) {
      const porePressure = sampleInitialPorePressure(model, gp.x, gp.y, options, warnings);
      porePressureByIntegrationPoint[gp.globalIndex] = porePressure;
      porePressureSum += porePressure;
      gammaSum += initialBulkUnitWeightFromPorePressure(constitutive.materialParameters, porePressure);
    }
    const initialPorePressure = porePressureSum / gpCount;
    const gammaBulk = gammaSum / gpCount;
    if (elasticStiffnessFlat && elementCache.kind === 't3') {
      addMatrixBlockFlat(rows, elementCache.dofs, elasticStiffnessFlat, elementIndex * 36);
    } else {
      addMatrixBlock(
        rows,
        elementCache.dofs,
        elementCache.kernel.elementStiffness(
          elementCache.corners,
          Array.from({ length: elementCache.numGaussPoints }, () => extractTangent2DFrom6(constitutive.materialModel.initialTangent6x6)),
          elementCache.area,
          elementCache
        )
      );
    }
    addVectorBlock(gravityRhs, elementCache.dofs, elementCache.kernel.elementBodyForceFromArea(elementCache.area, 0, -Math.max(gammaBulk, 0)));
    porePressureByElement[elementIndex] = initialPorePressure;
    if (elementIndex % 250 === 0 && (await runCheckpoint(runControl))) {
      throw new Error('Deformation run was interrupted during stiffness assembly.');
    }
  }

  onProgress({
    stage: 'solving',
    percent: 58,
    message: hasSurfaceLoad
      ? 'Applying the surface traction and support constraints...'
      : 'Applying the support constraints for the self-weight analysis...'
  });

  loadedTerrainEdges(mesh, load).forEach((edge) => {
    const dofs = mesh.elementType === 't6'
      ? [2 * edge.n1, 2 * edge.n1 + 1, 2 * edge.n2, 2 * edge.n2 + 1, 2 * edge.nMid, 2 * edge.nMid + 1]
      : [2 * edge.n1, 2 * edge.n1 + 1, 2 * edge.n2, 2 * edge.n2 + 1];
    addVectorBlock(loadRhs, dofs, elementKernelFor(mesh.elementType).edgeTraction(edge, 0, -load.q));
  });

  const compressedRows = compressMatrixRows(rows, freeDofs, freeIndexByDof);
  const gravityCompressedRhs = gatherFreeVector(gravityRhs, freeDofs);
  const loadRhsFreeBase = gatherFreeVector(loadRhs, freeDofs);
  const totalExternalForceFree = addSolutionVectors(gravityCompressedRhs, loadRhsFreeBase);
  const nonlinearAssemblyPattern = buildCompressedAssemblyPattern(elementCaches, freeIndexByDof, freeDofs.length);
  const geostatic = await buildGeostaticInitialization(
    mesh,
    elementCaches,
    model,
    options,
    warnings,
    regionConstitutiveByRegion,
    ndof,
    compressedRows,
    freeDofs,
    fixedValues,
    gravityCompressedRhs,
    porePressureByIntegrationPoint,
    runControl,
    onProgress
  );
  const wantsPlasticInitialEquilibrium = options.initialStressMode === 'plastic-geostatic';
  const canRunPlasticInitialEquilibrium = wantsPlasticInitialEquilibrium && options.constitutiveModel === 'mc-plastic';
  const materialPoints = buildElementMaterialPoints(mesh, elementCaches, regionConstitutiveByRegion, geostatic.initialField, options, warnings);
  if (wantsPlasticInitialEquilibrium && !canRunPlasticInitialEquilibrium) {
    pushUniqueWarning(
      warnings,
      'Plastic geostatic equilibration is only available with the Stage 2 elastoplastic deformation model, so the solver used the fast geostatic predictor instead.'
    );
  }

  let initialPhase = {
    phaseKind: 'initial-gravity',
    formulationMode: 'total',
    solution: geostatic.solution || new Float64Array(ndof),
    acceptedSteps: 0,
    rejectedSteps: 0,
    totalNonlinearIterations: 0,
    totalCgIterations: 0,
    residualNorm: 0,
    relativeResidualNorm: 0,
    displacementCorrectionNorm: 0,
    relativeDisplacementCorrectionNorm: 0,
    lastStateChanges: 0,
    finalActiveCount: 0,
    peakActiveCount: 0,
    finalActiveFaceCount: 0,
    finalActiveEdgeCount: 0,
    finalActiveApexCount: 0,
    finalTensionPendingCount: 0,
    peakActiveFaceCount: 0,
    peakActiveEdgeCount: 0,
    peakActiveApexCount: 0,
    peakTensionPendingCount: 0,
    peakEta: 0,
    loadFactorCommitted: 1,
    displayedLoadFactor: 1,
    converged: false,
    convergenceState: 'skipped',
    displayedStateMode: 'predictor',
    failureReason: '',
    loadStepHistory: [],
    residualHistory: []
  };
  let servicePhase = null;
  let servicePhaseStarted = false;
  let initialBaselineSolution = new Float64Array(ndof);
  let safetyAnalysis = null;
  let safetyBaseCheckpoint = null;
  const wantsServiceLoadPhase = hasSurfaceLoad;

  if (canRunPlasticInitialEquilibrium) {
    onProgress({
      stage: 'solving',
      percent: 72,
      message: 'Running the initial Stage 2 plastic equilibration under full gravity...'
    });
    // Phase 0b solves only the correction about the predictor stress seed.
    // Replaying the predictor displacement here would double-apply gravity strain.
    initialPhase = await solveInitialPlasticEquilibrium(
      elementCaches,
      nonlinearAssemblyPattern,
      gravityCompressedRhs,
      materialPoints,
      ndof,
      freeDofs,
      fixedValues,
      new Float64Array(ndof),
      runControl,
      onProgress,
      options
    );
    if (!initialPhase.converged) {
      const shownInitialPhaseFactor = 100 * Math.max(Number(initialPhase.displayedLoadFactor) || 0, 0);
      const initialPhaseTargetLabel = initialPhase.loadFactorMeaning === 'predictor-to-full-gravity correction'
        ? `${shownInitialPhaseFactor.toFixed(1)}% of the predictor-to-full-gravity correction`
        : `${shownInitialPhaseFactor.toFixed(1)}% gravity`;
      pushUniqueWarning(
        warnings,
        `Showing a non-converged initial plastic self-weight equilibration state at ${initialPhaseTargetLabel}. Service loading was not started. Reason: ${initialPhase.failureReason || 'nonlinear iterations exhausted'}. Use this result qualitatively.`
      );
      if ((Number(initialPhase.peakTensionPendingCount) || 0) > 0) {
        pushUniqueWarning(
          warnings,
          `Initial plastic geostatic equilibration activated the exact Stage 2.4 tension cut-off branch in ${Math.round(Number(initialPhase.peakTensionPendingCount) || 0)} element${Math.round(Number(initialPhase.peakTensionPendingCount) || 0) === 1 ? '' : 's'}. In those zones the tension cut-off, not η_MC, governs admissibility.`
        );
      }
    } else {
      initialBaselineSolution = Float64Array.from(initialPhase.solution);
      setReferenceStateFromCommittedStates(materialPoints);
      servicePhaseStarted = wantsServiceLoadPhase;
    }
  } else {
    initialPhase = {
      ...initialPhase,
      converged: true,
      convergenceState: 'skipped',
      displayedStateMode: 'predictor',
      solution: geostatic.solution || new Float64Array(ndof)
    };
    servicePhaseStarted = wantsServiceLoadPhase;
  }

  if (servicePhaseStarted) {
    onProgress({
      stage: 'solving',
      percent: 74,
      message: `Solving ${freeDofs.length.toLocaleString()} free deformation DOFs with the ${options.constitutiveModel === 'linear-elastic' ? 'elastic' : options.constitutiveModel === 'mc-plastic' ? 'Stage 2 elastoplastic' : 'Stage 1 MC-active reduced-stiffness'} material model...`
    });
    servicePhase = await solveServiceLoadPhase(
      elementCaches,
      nonlinearAssemblyPattern,
      loadRhsFreeBase,
      materialPoints,
      ndof,
      freeDofs,
      fixedValues,
      canRunPlasticInitialEquilibrium ? initialBaselineSolution : new Float64Array(ndof),
      runControl,
      onProgress,
      options
    );
    if (!servicePhase.converged) {
      const shownLoadFactor = 100 * Math.max(Number(servicePhase.displayedLoadFactor) || 0, 0);
      const stableLoadFactor = 100 * Math.max(Number(servicePhase.loadFactorCommitted) || 0, 0);
      const showingNearFailureState = (Number(servicePhase.displayedLoadFactor) || 0) > (Number(servicePhase.loadFactorCommitted) || 0) + 1e-8;
      pushUniqueWarning(
        warnings,
        showingNearFailureState
          ? `Showing a non-converged near-failure deformation state at ${shownLoadFactor.toFixed(1)}% load. The last fully converged state reached ${stableLoadFactor.toFixed(1)}%. Reason: ${servicePhase.failureReason || 'nonlinear iterations exhausted'}. Use this result qualitatively.`
          : `Showing a non-converged near-failure deformation state at the last fully converged ${stableLoadFactor.toFixed(1)}% load because no stable state beyond that point was accepted. Reason: ${servicePhase.failureReason || 'nonlinear iterations exhausted'}. Use this result qualitatively.`
      );
    }
  }

  const predictorDisplacementSolution = canRunPlasticInitialEquilibrium
    ? (geostatic.solution || new Float64Array(ndof))
    : new Float64Array(ndof);
  const physicalInitialEquilibriumSolution = canRunPlasticInitialEquilibrium
    ? addSolutionVectors(predictorDisplacementSolution, initialPhase.solution)
    : initialPhase.solution;
  const physicalServiceSolution = servicePhaseStarted
    ? (
        canRunPlasticInitialEquilibrium
          ? addSolutionVectors(predictorDisplacementSolution, servicePhase.solution)
          : servicePhase.solution
      )
    : physicalInitialEquilibriumSolution;

  if (analysisType === 'safety-cphi') {
    if (!initialPhase.converged) {
      throw new Error('C-phi reduction safety analysis requires the initial plastic self-weight equilibration phase to converge fully before strength reduction starts.');
    }
    if (wantsServiceLoadPhase && (!servicePhaseStarted || !servicePhase?.converged)) {
      throw new Error('C-phi reduction safety analysis requires the full service-loading phase to converge before strength reduction starts.');
    }
    onProgress({
      stage: 'solving',
      percent: 78,
      message: `Running the c-phi reduction safety phase from the ${wantsServiceLoadPhase ? 'end-of-service' : 'self-weight-only'} equilibrium state...`
    });
    safetyBaseCheckpoint = createMaterialPointCheckpoint(
      materialPoints,
      wantsServiceLoadPhase ? physicalServiceSolution : physicalInitialEquilibriumSolution,
      {
        sigmaMsf: 1,
        label: wantsServiceLoadPhase ? 'service-base' : 'initial-equilibrium-base'
      }
    );
    safetyAnalysis = await solveSafetyReductionSearch(
      elementCaches,
      nonlinearAssemblyPattern,
      totalExternalForceFree,
      safetyBaseCheckpoint,
      regionConstitutiveByRegion,
      ndof,
      freeDofs,
      fixedValues,
      runControl,
      onProgress,
      options
    );
  }

  const activePhase = analysisType === 'safety-cphi'
    ? (safetyAnalysis?.displayedPhase || safetyAnalysis?.lowerBoundPhase || initialPhase)
    : (servicePhaseStarted ? servicePhase : initialPhase);
  const activeMaterialPoints = analysisType === 'safety-cphi'
    ? (activePhase?.materialPoints || safetyAnalysis?.lowerBoundCheckpoint?.materialPoints || materialPoints)
    : materialPoints;
  const totalLinearIterations =
    (canRunPlasticInitialEquilibrium ? Number(initialPhase.totalCgIterations) || 0 : 0) +
    (servicePhaseStarted ? Number(servicePhase.totalCgIterations) || 0 : 0) +
    (analysisType === 'safety-cphi' ? Number(safetyAnalysis?.totalCgIterations) || 0 : 0);
  const totalNonlinearIterations =
    (canRunPlasticInitialEquilibrium ? Number(initialPhase.totalNonlinearIterations) || 0 : 0) +
    (servicePhaseStarted ? Number(servicePhase.totalNonlinearIterations) || 0 : 0) +
    (analysisType === 'safety-cphi' ? Number(safetyAnalysis?.totalNonlinearIterations) || 0 : 0);
  const overallPeakActiveCount = Math.max(
    canRunPlasticInitialEquilibrium ? Number(initialPhase.peakActiveCount) || 0 : 0,
    servicePhaseStarted ? Number(servicePhase.peakActiveCount) || 0 : 0,
    analysisType === 'safety-cphi' ? Number(safetyAnalysis?.peakActiveCount) || 0 : 0
  );
  const overallPeakActiveFaceCount = Math.max(
    canRunPlasticInitialEquilibrium ? Number(initialPhase.peakActiveFaceCount) || 0 : 0,
    servicePhaseStarted ? Number(servicePhase.peakActiveFaceCount) || 0 : 0,
    analysisType === 'safety-cphi' ? Number(safetyAnalysis?.peakActiveFaceCount) || 0 : 0
  );
  const overallPeakActiveEdgeCount = Math.max(
    canRunPlasticInitialEquilibrium ? Number(initialPhase.peakActiveEdgeCount) || 0 : 0,
    servicePhaseStarted ? Number(servicePhase.peakActiveEdgeCount) || 0 : 0,
    analysisType === 'safety-cphi' ? Number(safetyAnalysis?.peakActiveEdgeCount) || 0 : 0
  );
  const overallPeakActiveApexCount = Math.max(
    canRunPlasticInitialEquilibrium ? Number(initialPhase.peakActiveApexCount) || 0 : 0,
    servicePhaseStarted ? Number(servicePhase.peakActiveApexCount) || 0 : 0,
    analysisType === 'safety-cphi' ? Number(safetyAnalysis?.peakActiveApexCount) || 0 : 0
  );
  const overallPeakTensionPendingCount = Math.max(
    canRunPlasticInitialEquilibrium ? Number(initialPhase.peakTensionPendingCount) || 0 : 0,
    servicePhaseStarted ? Number(servicePhase.peakTensionPendingCount) || 0 : 0,
    analysisType === 'safety-cphi' ? Number(safetyAnalysis?.peakTensionPendingCount) || 0 : 0
  );
  const overallPeakEta = Math.max(
    canRunPlasticInitialEquilibrium ? Number(initialPhase.peakEta) || 0 : 0,
    servicePhaseStarted ? Number(servicePhase.peakEta) || 0 : 0,
    analysisType === 'safety-cphi' ? Number(safetyAnalysis?.peakEta) || 0 : 0
  );
  const constitutiveSolution = activePhase.solution;
  const physicalActiveSolution = analysisType === 'safety-cphi'
    ? (constitutiveSolution || (wantsServiceLoadPhase ? physicalServiceSolution : physicalInitialEquilibriumSolution))
    : (
        canRunPlasticInitialEquilibrium
          ? addSolutionVectors(predictorDisplacementSolution, constitutiveSolution)
          : constitutiveSolution
      );
  const physicalInitialBaselineSolution = analysisType === 'safety-cphi'
    ? (wantsServiceLoadPhase ? physicalServiceSolution : physicalInitialEquilibriumSolution)
    : (
        canRunPlasticInitialEquilibrium
          ? addSolutionVectors(
            predictorDisplacementSolution,
            initialPhase.converged
              ? initialBaselineSolution
              : (!servicePhaseStarted ? initialPhase.solution : new Float64Array(ndof))
          )
          : (!servicePhaseStarted ? initialPhase.solution : new Float64Array(ndof))
      );

  onProgress({
    stage: 'post',
    percent: 86,
    message: 'Recovering stresses, settlements, and MC utilization...'
  });

  const recoverySolution = analysisType === 'safety-cphi' ? physicalActiveSolution : constitutiveSolution;
  const safetyComparisonMaterialPoints = analysisType === 'safety-cphi'
    ? (
        safetyAnalysis?.status === 'bracketed'
          ? (safetyAnalysis?.lowerBoundCheckpoint?.materialPoints || null)
          : (safetyBaseCheckpoint?.materialPoints || null)
      )
    : null;
  const elementResults = recoverElementResults(
    mesh,
    elementCaches,
    recoverySolution,
    activeMaterialPoints,
    porePressureByElement,
    safetyComparisonMaterialPoints
  );
  const totalNodalDisplacements = buildNodalDisplacements(mesh, physicalActiveSolution);
  const initialNodalDisplacements = buildNodalDisplacements(mesh, physicalInitialBaselineSolution);
  const serviceIncrementNodalDisplacements = servicePhaseStarted
    ? subtractNodalDisplacementFields(
      buildNodalDisplacements(mesh, physicalServiceSolution),
      buildNodalDisplacements(mesh, physicalInitialEquilibriumSolution)
    )
    : [];
  const displayUsesServiceIncrement = analysisType === 'safety-cphi'
    ? true
    : (servicePhaseStarted && canRunPlasticInitialEquilibrium && initialPhase.converged);
  const nodalDisplacements = displayUsesServiceIncrement
    ? subtractNodalDisplacementFields(totalNodalDisplacements, initialNodalDisplacements)
    : totalNodalDisplacements;
  if (analysisType === 'safety-cphi') {
    const sigmaLower = Number(safetyAnalysis?.factorOfSafetyLower) || 1;
    const sigmaUpper = Number(safetyAnalysis?.factorOfSafetyUpper);
    if (safetyAnalysis?.status === 'bracketed') {
      pushUniqueWarning(
        warnings,
        Number.isFinite(sigmaUpper)
          ? `C-phi reduction bracketed failure between ΣMsf=${sigmaLower.toFixed(3)} and ΣMsf=${sigmaUpper.toFixed(3)}. Report the conservative lower bound ΣMsf=${sigmaLower.toFixed(3)} as the factor of safety.`
          : `C-phi reduction bracketed a near-failure state at ΣMsf=${sigmaLower.toFixed(3)}. Report the conservative lower bound ΣMsf=${sigmaLower.toFixed(3)} as the factor of safety.`
      );
    } else if (safetyAnalysis?.status === 'mechanism-developed') {
      pushUniqueWarning(
        warnings,
        `C-phi reduction developed a persistent failure mechanism at ΣMsf=${sigmaLower.toFixed(3)}. Report ΣMsf=${sigmaLower.toFixed(3)} as the factor of safety, and interpret the final incremental fields as the governing mechanism.`
      );
    } else if (safetyAnalysis?.status === 'no-failure-found') {
      pushUniqueWarning(
        warnings,
        `C-phi reduction did not find failure up to ΣMsf=${sigmaLower.toFixed(3)}. Report the result conservatively as FoS > ${sigmaLower.toFixed(3)}.`
      );
    }
  } else if (activePhase?.convergenceState === 'partial') {
    if (servicePhaseStarted) {
      const shownLoadFactor = 100 * Math.max(Number(servicePhase?.displayedLoadFactor) || 0, 0);
      const stableLoadFactor = 100 * Math.max(Number(servicePhase?.loadFactorCommitted) || 0, 0);
      const showingNearFailureState = (Number(servicePhase?.displayedLoadFactor) || 0) > (Number(servicePhase?.loadFactorCommitted) || 0) + 1e-8;
      pushUniqueWarning(
        warnings,
        showingNearFailureState
          ? `Showing a non-converged near-failure deformation state at ${shownLoadFactor.toFixed(1)}% load. The last fully converged state reached ${stableLoadFactor.toFixed(1)}%. Reason: ${servicePhase?.failureReason || 'nonlinear iterations exhausted'}. Use this result qualitatively.`
          : `Showing a non-converged near-failure deformation state at the last fully converged ${stableLoadFactor.toFixed(1)}% load because no stable state beyond that point was accepted. Reason: ${servicePhase?.failureReason || 'nonlinear iterations exhausted'}. Use this result qualitatively.`
      );
    } else if (canRunPlasticInitialEquilibrium) {
      const shownGravityFactor = 100 * Math.max(Number(initialPhase?.displayedLoadFactor) || 0, 0);
      const initialPhaseTargetLabel = initialPhase?.loadFactorMeaning === 'predictor-to-full-gravity correction'
        ? `${shownGravityFactor.toFixed(1)}% of the predictor-to-full-gravity correction`
        : `${shownGravityFactor.toFixed(1)}% gravity`;
      pushUniqueWarning(
        warnings,
        `Showing a non-converged initial plastic self-weight equilibration state at ${initialPhaseTargetLabel}. Service loading was not started. Reason: ${initialPhase?.failureReason || 'nonlinear iterations exhausted'}. Use this result qualitatively.`
      );
    }
  }
  const terrainSettlementProfile = buildTerrainSettlementProfile(mesh, nodalDisplacements);
  const summaries = summarizeDeformation(nodalDisplacements, elementResults);
  summaries.maxInitialSettlement = Math.max(0, ...initialNodalDisplacements.map((item) => -(item?.uy || 0)));
  summaries.serviceSettlementIncrement = analysisType === 'safety-cphi'
    ? Math.max(0, ...serviceIncrementNodalDisplacements.map((item) => -(item?.uy || 0)))
    : (servicePhaseStarted ? summaries.maxSettlement : 0);
  summaries.safetySettlementIncrement = analysisType === 'safety-cphi' ? summaries.maxSettlement : 0;
  activeBackendRuntimeWarnings.forEach((warning) => pushUniqueWarning(warnings, warning));

  onProgress({
    stage: 'post',
    percent: 96,
    message: 'Finalizing deformation output...'
  });

  return {
    mesh,
    load,
    warnings,
    nodalDisplacements,
    totalNodalDisplacements,
    initialNodalDisplacements,
    terrainSettlementProfile,
    elementResults,
    summaries,
    solver: {
      method: analysisType === 'safety-cphi'
        ? `stage-2-mc-plastic-plane-strain-${options.meshElementType}-safety-cphi`
        : options.constitutiveModel === 'linear-elastic'
        ? `nonlinear-elastic-plane-strain-${options.meshElementType}`
        : options.constitutiveModel === 'mc-plastic'
          ? `stage-2-mc-plastic-plane-strain-${options.meshElementType}`
          : `stage-1-mc-reduced-stiffness-plane-strain-${options.meshElementType}`,
      analysisType,
      elementType: options.meshElementType,
      integrationPointsPerElement: options.meshElementType === 't6' ? 3 : 1,
      constitutiveModel: options.constitutiveModel === 'linear-elastic'
        ? 'linear-elastic-material-point'
        : options.constitutiveModel === 'mc-plastic'
          ? 'mc-plastic-material-point'
          : 'mc-reduced-stiffness-material-point',
      materialPointCount: materialPoints.length,
      integrationPointCount: materialPoints.length,
      initialStressMode: canRunPlasticInitialEquilibrium
        ? 'gravity-step-k0nc-plastic-equilibration'
        : geostatic.mode,
      initialPredictorMode: geostatic.mode,
      geostaticIterations: geostatic.iterations,
      geostaticResidualNorm: geostatic.residualNorm,
      initialPhaseStarted: canRunPlasticInitialEquilibrium,
      initialPhaseConverged: canRunPlasticInitialEquilibrium ? initialPhase.converged : null,
      initialPhaseConvergenceState: canRunPlasticInitialEquilibrium ? initialPhase.convergenceState : 'skipped',
      initialPhaseFailureCode: canRunPlasticInitialEquilibrium ? initialPhase.failureCode : '',
      initialPhaseFailureOutcomeClass: canRunPlasticInitialEquilibrium ? initialPhase.failureOutcomeClass : 'unknown',
      initialPhaseFailureReason: canRunPlasticInitialEquilibrium ? initialPhase.failureReason : '',
      initialPhaseAcceptedSteps: canRunPlasticInitialEquilibrium ? initialPhase.acceptedSteps : 0,
      initialPhaseRejectedSteps: canRunPlasticInitialEquilibrium ? initialPhase.rejectedSteps : 0,
      initialPhaseDisplayedGravityFactor: canRunPlasticInitialEquilibrium ? initialPhase.displayedLoadFactor : 1,
      initialPhaseDisplayedContinuationMode: canRunPlasticInitialEquilibrium ? initialPhase.loadFactorMeaning : 'gravity',
      initialPhaseFinalActiveMcElements: canRunPlasticInitialEquilibrium ? initialPhase.finalActiveCount : 0,
      initialPhasePeakActiveMcElements: canRunPlasticInitialEquilibrium ? initialPhase.peakActiveCount : 0,
      initialPhaseFinalTensionPendingElements: canRunPlasticInitialEquilibrium ? initialPhase.finalTensionPendingCount : 0,
      initialPhasePeakTensionPendingElements: canRunPlasticInitialEquilibrium ? initialPhase.peakTensionPendingCount : 0,
      initialPhaseFinalTensionCutoffActiveElements: canRunPlasticInitialEquilibrium ? initialPhase.finalTensionPendingCount : 0,
      initialPhasePeakTensionCutoffActiveElements: canRunPlasticInitialEquilibrium ? initialPhase.peakTensionPendingCount : 0,
      servicePhaseStarted,
      servicePhaseConvergenceState: servicePhaseStarted ? servicePhase.convergenceState : 'not-started',
      servicePhaseFailureCode: servicePhaseStarted ? servicePhase.failureCode : (canRunPlasticInitialEquilibrium ? initialPhase.failureCode : ''),
      servicePhaseFailureOutcomeClass: servicePhaseStarted ? servicePhase.failureOutcomeClass : (canRunPlasticInitialEquilibrium ? initialPhase.failureOutcomeClass : 'unknown'),
      servicePhaseFailureReason: servicePhaseStarted ? servicePhase.failureReason : (canRunPlasticInitialEquilibrium ? initialPhase.failureReason : ''),
      initialDisplacementResetApplied: displayUsesServiceIncrement,
      linearIterations: totalLinearIterations,
      nonlinearIterations: totalNonlinearIterations,
      acceptedLoadSteps: analysisType === 'safety-cphi' ? 0 : (servicePhaseStarted ? servicePhase.acceptedSteps : 0),
      rejectedLoadSteps: analysisType === 'safety-cphi' ? 0 : (servicePhaseStarted ? servicePhase.rejectedSteps : 0),
      loadFactorCommitted: analysisType === 'safety-cphi' ? 0 : (servicePhaseStarted ? servicePhase.loadFactorCommitted : 0),
      displayedLoadFactor: analysisType === 'safety-cphi' ? 0 : (servicePhaseStarted ? servicePhase.displayedLoadFactor : 0),
      converged: analysisType === 'safety-cphi'
        ? safetyAnalysis != null
        : (servicePhaseStarted ? servicePhase.converged : initialPhase.converged),
      convergenceState: analysisType === 'safety-cphi'
        ? (safetyAnalysis?.status || 'unknown')
        : (servicePhaseStarted ? servicePhase.convergenceState : initialPhase.convergenceState),
      failureCode: analysisType === 'safety-cphi'
        ? (safetyAnalysis?.failureCode || '')
        : (servicePhaseStarted ? servicePhase.failureCode : initialPhase.failureCode),
      failureOutcomeClass: analysisType === 'safety-cphi'
        ? (safetyAnalysis?.failureOutcomeClass || 'unknown')
        : (servicePhaseStarted ? servicePhase.failureOutcomeClass : initialPhase.failureOutcomeClass),
      displayedStateMode: activePhase.displayedStateMode,
      displayedLoadFactorMeaning: analysisType === 'safety-cphi'
        ? 'safety-strength-reduction'
        : (activePhase.loadFactorMeaning || (servicePhaseStarted ? 'load' : 'gravity')),
      failureReason: analysisType === 'safety-cphi'
        ? (safetyAnalysis?.failurePhase?.failureReason || '')
        : (servicePhaseStarted ? servicePhase.failureReason : initialPhase.failureReason),
      residualNorm: activePhase.residualNorm,
      relativeResidualNorm: activePhase.relativeResidualNorm,
      displacementCorrectionNorm: activePhase.displacementCorrectionNorm,
      relativeDisplacementCorrectionNorm: activePhase.relativeDisplacementCorrectionNorm,
      finalActiveMcElements: activePhase.finalActiveCount,
      peakActiveMcElements: overallPeakActiveCount,
      finalActiveMcFaceElements: activePhase.finalActiveFaceCount,
      finalActiveMcEdgeElements: activePhase.finalActiveEdgeCount,
      finalActiveMcApexElements: activePhase.finalActiveApexCount,
      finalTensionPendingElements: activePhase.finalTensionPendingCount,
      finalTensionCutoffActiveElements: activePhase.finalTensionPendingCount,
      peakActiveMcFaceElements: overallPeakActiveFaceCount,
      peakActiveMcEdgeElements: overallPeakActiveEdgeCount,
      peakActiveMcApexElements: overallPeakActiveApexCount,
      peakTensionPendingElements: overallPeakTensionPendingCount,
      peakTensionCutoffActiveElements: overallPeakTensionPendingCount,
      peakMcEta: overallPeakEta,
      lastStateChanges: activePhase.lastStateChanges,
      freeDofs: freeDofs.length,
      loadStepHistory: analysisType === 'safety-cphi'
        ? (activePhase?.loadStepHistory || [])
        : (servicePhaseStarted ? servicePhase.loadStepHistory : []),
      residualHistory: analysisType === 'safety-cphi'
        ? (activePhase?.residualHistory || [])
        : (servicePhaseStarted ? servicePhase.residualHistory : []),
      initialLoadStepHistory: canRunPlasticInitialEquilibrium ? initialPhase.loadStepHistory : [],
      initialResidualHistory: canRunPlasticInitialEquilibrium ? initialPhase.residualHistory : [],
      safetyStarted: analysisType === 'safety-cphi',
      safetyBaseState: analysisType === 'safety-cphi'
        ? (wantsServiceLoadPhase ? 'end-of-service' : 'initial-equilibrium')
        : 'not-applicable',
      safetyStatus: analysisType === 'safety-cphi' ? (safetyAnalysis?.status || 'unknown') : 'not-applicable',
      safetyFailureCode: analysisType === 'safety-cphi' ? (safetyAnalysis?.failureCode || '') : '',
      safetyFailureOutcomeClass: analysisType === 'safety-cphi' ? (safetyAnalysis?.failureOutcomeClass || 'unknown') : 'not-applicable',
      safetyFactorOfSafety: analysisType === 'safety-cphi' ? Number(safetyAnalysis?.factorOfSafety) || 1 : null,
      safetyFactorOfSafetyLower: analysisType === 'safety-cphi' ? Number(safetyAnalysis?.factorOfSafetyLower) || 1 : null,
      safetyFactorOfSafetyUpper: analysisType === 'safety-cphi' && safetyAnalysis?.factorOfSafetyUpper != null && Number.isFinite(Number(safetyAnalysis?.factorOfSafetyUpper))
        ? Number(safetyAnalysis?.factorOfSafetyUpper)
        : null,
      safetyStrengthRetained: analysisType === 'safety-cphi' ? Number(safetyAnalysis?.strengthRetained) || 1 : null,
      safetyDisplayedSigmaMsf: analysisType === 'safety-cphi' ? Number(activePhase?.sigmaMsfDisplayed ?? safetyAnalysis?.factorOfSafetyLower) || 1 : null,
      safetyCommittedSigmaMsf: analysisType === 'safety-cphi'
        ? Number(safetyAnalysis?.lowerBoundCheckpoint?.sigmaMsf ?? safetyAnalysis?.factorOfSafetyLower) || 1
        : null,
      safetyTrialHistory: analysisType === 'safety-cphi' ? (safetyAnalysis?.history || []) : [],
      safetyAcceptedContinuationSteps: analysisType === 'safety-cphi' ? Number(safetyAnalysis?.totalAcceptedContinuationSteps) || 0 : 0,
      safetyRejectedContinuationSteps: analysisType === 'safety-cphi' ? Number(safetyAnalysis?.totalRejectedContinuationSteps) || 0 : 0,
      linearAlgebraBackend: {
        name: activeBackendInfo?.name || 'cpu-f64',
        reason: activeBackendInfo?.reason || '',
        requested: !!options.useGpuAcceleration,
        requestedPrecisionMode: options.gpuPrecisionMode || 'auto',
        override: options.linearAlgebraBackend || null,
        probeMode: activeBackendInfo?.probeMode || null,
        probeContext: activeBackendInfo?.probeContext || null,
        precisionMode: activeBackendInfo?.precisionMode || activeMatvecBackend?.precisionMode || null,
        maxTextureSize: activeBackendInfo?.maxTextureSize || null,
        supportsElementKernels: activeBackendInfo?.supportsElementKernels === true,
        supportsDoubleSingle: activeBackendInfo?.supportsDoubleSingle === true,
        failedFrom: activeBackendInfo?.failedFrom || null,
        failedOperation: activeBackendInfo?.failedOperation || null,
        freeDofCount: freeDofs.length,
        residualRefreshInterval: backendRequiresResidualRefresh() ? backendResidualRefreshInterval() : 0
      }
    },
    timing: {
      totalMs: performance.now() - startedAt
    }
  };
}
