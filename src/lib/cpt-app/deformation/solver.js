// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { pointInPolygonHalfOpen } from '../soil-regions.js';
import { buildDeformationMesh } from './mesh.js';
import { triangleArea } from './element-t3.js';
import { elementKernelFor, normalizeElementType } from './element-kernel.js';
import { shapeFunctionsT6 } from './element-t6.js';
// material-models.js is also imported for its side effect: it calls
// `registerMaterialPlugin('linear-elastic' | 'mc-reduced-stiffness' |
// 'mc-plastic', factory)` at module load time. The solver itself
// dispatches via the plugin registry (see materialPluginFor below); the
// concrete factories are not referenced from solver.js any more, so a
// future plugin (Hardening Soil, Cam-Clay, ...) can be added without
// any solver edits.
import {
  cloneMaterialPointState,
  createMaterialPoint,
  commitMaterialPoint,
  effectiveStress6ToCompressionPositiveStress3D,
  extractStress2DFrom6,
  extractTangent2DFrom6,
  liftPlaneStrainStrainTo6,
  mohrCoulombIndicator3D,
  setMaterialPointReferenceState,
  seedMaterialPointStateFromEffectiveStress6,
  seedMaterialPointStateFromInitialStress,
  snapshotMaterialPointState,
} from './material-models.js';
import { prepareMechanicalMaterial, reduceMaterialStrengthForSafety } from './material.js';
import { hasMaterialPlugin, materialPluginFor } from './material-plugin.js';
import {
  buildFlatK0InitialEffectiveStressFieldAtPoints,
  initialBulkUnitWeightFromPorePressure,
  mohrCoulombIndicator,
  negateNormalAndShear,
  principalStress2DCompressionPositive,
  sampleInitialPorePressure,
  verticalOverburdenStressAt
} from './post.js';
import { computeDepthBandReport } from './diagnostics-depth-bands.js';
import {
  applyAdditiveSchwarzPreconditioner,
  buildAdditiveSchwarzPreconditioner
} from './preconditioners/additive-schwarz.js';
import { terrainY } from '../stage6-bishop.js';
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

function pickFiniteFallback(...values) {
  for (let index = 0; index < values.length; index += 1) {
    const numeric = Number(values[index]);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

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

// f32 IEEE-754 maximum is 3.4028235e38. The headroom factor is the
// fraction of f32_max we leave for accumulator margin during the row's
// multiply-add reduction. The pre-check at this ceiling is purely
// advisory — its job is to *avoid invoking the GPU* on a matvec we
// already know will overflow, sparing the cost of an unsuccessful
// kernel launch and (more importantly) the cost of a downstream NaN
// detection cascade. Anything above this ceiling still gets a soft
// per-call CPU fallback inside sparseMatVec, with the backend kept
// live for subsequent matvecs whose iterate is back within range.
//
// We use a 0.5× headroom (was 0.125×). Krylov accumulators benefit
// from sign cancellation in symmetric positive-definite systems
// (residuals tend to oscillate in sign), so the worst-case all-positive
// row-sum bound is overly pessimistic. 0.5× still gives a 2× safety
// margin against the actual per-term limit.
const GPU_F32_PRODUCT_HEADROOM = 0.5;
const GPU_F32_MAX = 3.4028235e38;

function vectorAbsMax(vector) {
  let maxAbs = 0;
  for (let i = 0; i < vector.length; i += 1) {
    const a = Math.abs(Number(vector[i]) || 0);
    if (a > maxAbs) maxAbs = a;
  }
  return maxAbs;
}

// Compute the precise safe |x| ceiling for the active backend's packed
// matrix. The math is exact: the kernel computes
//   sum_k vals[base+k] * x[col_k]
// for k in [0, rowLen). For each term to be representable in f32:
//   |vals[base+k]| · |x[col_k]| < f32_max / rowLen (with headroom)
// Therefore |x| ≤ f32_max · headroom / (max|vals| · rowLen). When the
// backend doesn't expose its matrix bounds (cpu-f64 fallback or before
// the first pack), we fall back to a generous 1e30 ceiling — that
// covers any realistic Krylov iterate without rejecting normal inputs.
function gpuMatvecSafeVectorCeiling(backend) {
  const maxVal = Number(backend?.matrixMaxAbsValue) || 0;
  const rowLen = Math.max(Number(backend?.matrixMaxRowLen) || 0, 1);
  if (!(maxVal > 0)) return 1e30;
  return (GPU_F32_MAX * GPU_F32_PRODUCT_HEADROOM) / (maxVal * rowLen);
}

let gpuVectorMagnitudeFallbacksReported = 0;
const GPU_VECTOR_MAGNITUDE_FALLBACK_REPORT_LIMIT = 3;

function reportGpuVectorMagnitudeFallback(absMax, ceiling) {
  gpuVectorMagnitudeFallbacksReported += 1;
  if (gpuVectorMagnitudeFallbacksReported <= GPU_VECTOR_MAGNITUDE_FALLBACK_REPORT_LIMIT) {
    const message = `Krylov iterate magnitude reached ${absMax.toExponential(2)} (f32 safe ceiling ${ceiling.toExponential(2)} for max|matrix|=${(Number(activeMatvecBackend?.matrixMaxAbsValue) || 0).toExponential(2)} × row=${activeMatvecBackend?.matrixMaxRowLen ?? '?'}); routing this matvec to CPU f64 to avoid an f32 overflow. The matrix has a near-singular row that the Jacobi preconditioner cannot keep bounded; the GPU stays active for subsequent matvecs.`;
    pushUniqueWarning(activeBackendRuntimeWarnings, message);
    if (typeof console !== 'undefined' && console?.warn) console.warn(message);
  }
}

// Soft NaN-failure budget: how many f32 matvec NaNs we tolerate per run
// before concluding the backend itself is broken (kernel compilation
// quirk on this hardware, driver bug, etc.) and tearing it down. Below
// this budget, each matvec NaN is treated as "this iterate doesn't fit
// in f32" and silently routes that single call to CPU; the GPU stays
// live for every other matvec.
const GPU_MATVEC_SOFT_NAN_BUDGET = 16;
let gpuMatvecSoftNanCount = 0;

// `sparseMatVec` is async because the WebGPU backend's matvec is
// inherently async (no synchronous GPU readback exists in WebGPU);
// the WebGL2 + GPU.js backend is sync but returning a Promise from it
// is harmless (Promise.resolve of a Float64Array). All call sites in
// this file `await` the result. Keeping a single async return contract
// avoids the silent-NaN trap where `dot(p, await-needed-Promise)` ran
// numeric arithmetic on a Promise instance.
async function sparseMatVec(rows, vector) {
  if (activeMatvecBackend && typeof activeMatvecBackend.matvec === 'function') {
    // Adaptive pre-check. The GPU matvec produces Infinity/NaN only
    // when |val|·|x| · rowLen exceeds f32 max during a per-row
    // accumulation. With the matrix's actual max value reported by the
    // backend, the safe |x| ceiling is exact arithmetic — we route a
    // single matvec to CPU f64 only when an iterate is genuinely
    // beyond what f32 multiplication can represent for THIS matrix.
    // The check is now PURELY ADVISORY: anything above the ceiling
    // gets a per-call CPU fallback, but the soft NaN-budget below
    // ensures that even an iterate that slips past the pre-check and
    // produces a NaN inside the kernel does NOT tear down the backend.
    // Net effect: the GPU runs every matvec it can physically handle,
    // and those that genuinely cannot fit in f32 silently route to
    // CPU without losing GPU acceleration on subsequent calls.
    const ceiling = gpuMatvecSafeVectorCeiling(activeMatvecBackend);
    const absMax = vectorAbsMax(vector);
    if (absMax > ceiling) {
      reportGpuVectorMagnitudeFallback(absMax, ceiling);
      return sparseMatVecFallback(rows, vector);
    }
    const startedPrecisionMode = activeMatvecBackend.precisionMode || 'f32';
    try {
      return await activeMatvecBackend.matvec(rows, vector);
    } catch (error) {
      // f32 matvec hit a non-finite value. Don't immediately abandon the
      // GPU: the double-single path uses the same WebGL kernel with
      // higher-precision intermediate accumulation and can usually
      // survive what kills the f32 path (a near-singular tangent during
      // an active-set transition, a heavy plastic correction pushing a
      // residual entry past f32 dynamic range, etc.). Only fall back to
      // CPU when the escalated GPU path also fails — that is the cheapest
      // recovery and keeps the GPU live for the rest of the run.
      const canEscalate = !!activeMatvecBackend
        && activeMatvecBackend.supportsDoubleSingle === true
        && activeMatvecBackend.precisionMode !== 'double-single'
        && typeof activeMatvecBackend.setPrecisionMode === 'function';
      if (canEscalate) {
        const escalated = backendEscalatePrecisionMode(
          'double-single',
          `f32 matvec produced a non-finite value (${error?.message || 'unknown'}); escalated to double-single in-place to keep the GPU active.`,
          10
        );
        if (escalated) {
          try {
            return await activeMatvecBackend.matvec(rows, vector);
          } catch (retryError) {
            // Both f32 and double-single produced NaN. Two
            // possibilities: (a) the iterate genuinely doesn't fit in
            // f32 (per-call problem; CPU fallback for THIS matvec is
            // correct), or (b) the kernel itself has a problem (a
            // permanent issue; fall back the whole run). We
            // distinguish using the soft NaN-budget: under it, treat
            // as per-call; over it, tear down the backend. This keeps
            // the GPU live for the overwhelming majority of cases
            // while still recovering from a truly broken kernel.
            gpuMatvecSoftNanCount += 1;
            if (gpuMatvecSoftNanCount <= GPU_MATVEC_SOFT_NAN_BUDGET) {
              reportGpuMatvecSoftNanFallback(error, retryError);
              return sparseMatVecFallback(rows, vector);
            }
            handleActiveBackendFailure(
              'matvec',
              new Error(
                `${gpuMatvecSoftNanCount} matvecs produced non-finite GPU output (last: f32 ${error?.message || 'unknown'}; double-single ${retryError?.message || 'unknown'}). Exceeded the soft-fallback budget of ${GPU_MATVEC_SOFT_NAN_BUDGET}; treating the GPU backend as broken for this run and switching to CPU f64.`
              )
            );
            return sparseMatVecFallback(rows, vector);
          }
        }
      }
      // Either escalation was not possible (already double-single, or
      // backend doesn't expose it) or backendEscalatePrecisionMode
      // returned false. Apply the same soft NaN-budget as above so a
      // single overflowing iterate doesn't tear down the GPU.
      gpuMatvecSoftNanCount += 1;
      if (gpuMatvecSoftNanCount <= GPU_MATVEC_SOFT_NAN_BUDGET) {
        reportGpuMatvecSoftNanFallback(error, null);
        return sparseMatVecFallback(rows, vector);
      }
      handleActiveBackendFailure(
        'matvec',
        new Error(
          `${gpuMatvecSoftNanCount} matvecs produced non-finite GPU output (last: ${startedPrecisionMode} ${error?.message || 'unknown'}); GPU escalation was unavailable (supportsDoubleSingle=${activeMatvecBackend?.supportsDoubleSingle === true}, currentPrecision=${activeMatvecBackend?.precisionMode || 'unknown'}). Exceeded the soft-fallback budget of ${GPU_MATVEC_SOFT_NAN_BUDGET}; treating the GPU backend as broken and switching to CPU f64.`
        )
      );
      return sparseMatVecFallback(rows, vector);
    }
  }
  return sparseMatVecFallback(rows, vector);
}

let gpuMatvecSoftNanReported = 0;
const GPU_MATVEC_SOFT_NAN_REPORT_LIMIT = 3;

function reportGpuMatvecSoftNanFallback(primaryError, retryError) {
  gpuMatvecSoftNanReported += 1;
  if (gpuMatvecSoftNanReported > GPU_MATVEC_SOFT_NAN_REPORT_LIMIT) return;
  const message = retryError
    ? `GPU matvec produced a non-finite value at f32 (${primaryError?.message || 'unknown'}) and again at double-single (${retryError?.message || 'unknown'}); routing this matvec to CPU f64 (soft NaN budget ${gpuMatvecSoftNanCount}/${GPU_MATVEC_SOFT_NAN_BUDGET}). The GPU stays active for subsequent matvecs.`
    : `GPU matvec produced a non-finite value (${primaryError?.message || 'unknown'}); routing this matvec to CPU f64 (soft NaN budget ${gpuMatvecSoftNanCount}/${GPU_MATVEC_SOFT_NAN_BUDGET}). The GPU stays active for subsequent matvecs.`;
  pushUniqueWarning(activeBackendRuntimeWarnings, message);
  if (typeof console !== 'undefined' && console?.warn) console.warn(message);
}

function elementCachesAreUniformKind(elementCaches) {
  if (!(elementCaches?.length > 0)) return false;
  const first = elementCaches[0]?.kind === 't6' ? 't6' : 't3';
  for (let i = 1; i < elementCaches.length; i += 1) {
    const k = elementCaches[i]?.kind === 't6' ? 't6' : 't3';
    if (k !== first) return false;
  }
  return true;
}

function backendSupportsKind(backend, kind) {
  if (!backend) return false;
  if (kind === 't6') return backend.supportsT6ElementKernels !== false;
  return backend.supportsT3ElementKernels !== false;
}

// Per-run, per-element-type kernel disable flags. Element kernels can hit
// non-finite values during transient states (e.g. an iterate about to be
// backed off by line search) without indicating that the matvec — which
// is the primary GPU win — is unsafe. So we disable just the offending
// element-kernel call, route subsequent calls of the same kind to the
// CPU element path, and leave the matvec on GPU.
const disabledElementKernels = { t3: false, t6: false };

function disableBackendElementKernel(kind, operation, error) {
  if (kind !== 't3' && kind !== 't6') return;
  if (disabledElementKernels[kind]) return;
  disabledElementKernels[kind] = true;
  const message = `Linear-algebra backend '${activeMatvecBackend?.name || 'unknown'}' element kernel '${operation}' produced a non-finite value for ${kind.toUpperCase()} elements (${error?.message || 'unknown'}). Routing ${kind.toUpperCase()} element kernels to the CPU path for the remainder of the run; the matvec stays on the active backend.`;
  pushUniqueWarning(activeBackendRuntimeWarnings, message);
  if (typeof console !== 'undefined' && console?.warn) console.warn(message);
}

function backendElementStrain(elementCaches, vector) {
  if (!elementCachesAreUniformKind(elementCaches)) return null;
  if (!activeMatvecBackend || typeof activeMatvecBackend.elementStrain !== 'function') return null;
  const kind = elementCaches[0].kind === 't6' ? 't6' : 't3';
  if (!backendSupportsKind(activeMatvecBackend, kind)) return null;
  if (disabledElementKernels[kind]) return null;
  try {
    return activeMatvecBackend.elementStrain(elementCaches, vector);
  } catch (error) {
    disableBackendElementKernel(kind, 'element-strain', error);
    return null;
  }
}

function backendElementInternalForce(elementCaches, stressFlat) {
  if (!elementCachesAreUniformKind(elementCaches)) return null;
  if (!activeMatvecBackend || typeof activeMatvecBackend.elementInternalForce !== 'function') return null;
  const kind = elementCaches[0].kind === 't6' ? 't6' : 't3';
  if (!backendSupportsKind(activeMatvecBackend, kind)) return null;
  if (disabledElementKernels[kind]) return null;
  try {
    return activeMatvecBackend.elementInternalForce(elementCaches, stressFlat);
  } catch (error) {
    disableBackendElementKernel(kind, 'element-internal-force', error);
    return null;
  }
}

function backendElementElasticStiffness(elementCaches, tangentFlat) {
  if (!elementCachesAreUniformKind(elementCaches)) return null;
  if (!activeMatvecBackend || typeof activeMatvecBackend.elementElasticStiffness !== 'function') return null;
  const kind = elementCaches[0].kind === 't6' ? 't6' : 't3';
  if (!backendSupportsKind(activeMatvecBackend, kind)) return null;
  if (disabledElementKernels[kind]) return null;
  try {
    return activeMatvecBackend.elementElasticStiffness(elementCaches, tangentFlat);
  } catch (error) {
    disableBackendElementKernel(kind, 'element-elastic-stiffness', error);
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
    case 'geostatic-numerically-stuck':
      return 'numerically-stuck';
    case 'geostatic-shallow-free-surface-yielding':
      return 'shallow-free-surface-yielding';
    case 'geostatic-likely-unstable-self-weight':
      return 'likely-unstable-self-weight';
    default:
      return code ? 'unknown-failure' : 'unknown';
  }
}

function classifyGeostaticNonconvergence(depthBandReport, stepRecord = {}, context = {}) {
  const dominant = depthBandReport?.dominantBand || null;
  const shallowPlastic = Number(depthBandReport?.shallowPlasticCount) || 0;
  const plasticCount = Number(depthBandReport?.plasticCount) || 0;
  const tensionCount = Number(depthBandReport?.tensionCount) || 0;
  const maxTau = Number(depthBandReport?.maxTauOverStrength) || 0;
  const committedFactor = Number(context?.loadFactorCommitted) || 0;
  const repeated = Number(context?.repeatedBandCount) || 0;
  const reasonSuffix = dominant?.label ? ` Dominant depth band: ${dominant.label}.` : '';
  if (plasticCount > 0 && shallowPlastic / Math.max(plasticCount, 1) >= 0.65 && repeated >= 2) {
    return createFailureRecord(
      'geostatic-shallow-free-surface-yielding',
      `Initial self-weight equilibration repeatedly yielded the shallow free-surface band after cutbacks.${reasonSuffix}`
    );
  }
  if (
    committedFactor <= 0.05 &&
    plasticCount > 0 &&
    (maxTau >= 0.98 || tensionCount > 0 || (Number(dominant?.plasticFraction) || 0) >= 0.5)
  ) {
    return createFailureRecord(
      'geostatic-likely-unstable-self-weight',
      `Initial self-weight equilibration could not accept a stable correction increment and the active stress state is already at its strength envelope.${reasonSuffix}`
    );
  }
  return createFailureRecord(
    'geostatic-numerically-stuck',
    `Initial self-weight equilibration became numerically stuck after repeated cutbacks.${reasonSuffix || ` Last step: ${stepRecord?.reason || 'nonlinear iterations exhausted'}.`}`
  );
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

function normalizeTangentSchedule(input, fallback = ['plastic']) {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,\s]+/)
      : fallback;
  const out = [];
  raw.forEach((item) => {
    const mode = String(item || '').toLowerCase();
    if ((mode === 'elastic' || mode === 'plastic') && !out.includes(mode)) out.push(mode);
  });
  return out.length ? out : fallback;
}

// =============================================================================
// Block Jacobi preconditioner (per-node 2×2 blocks)
// =============================================================================
//
// The Jacobi preconditioner z = r / diag fails on near-orphan T6 mid-edge
// nodes: a node connected to only one element has tiny scalar diagonals,
// and dividing by them amplifies the residual by 1e+20 to 1e+30, which
// then flows through CG iterates until they overflow f32. Block Jacobi
// with 2×2 blocks (one per FE node, x and y DOFs together) is the
// principled fix — even at a one-element midpoint, the 2×2 block from
// that element's local stiffness is well-conditioned by construction
// (the element matrix is SPD for any non-degenerate element), so
// inv(B_n) bounds the iterate magnitude regardless of the scalar
// diagonal value. Mathematically the preconditioner is symmetric and
// positive definite for symmetric A (CG), so PCG convergence proofs
// carry through unchanged. For unsymmetric A (non-associated MC) the
// 2×2 inverse is still well defined and the preconditioner is bounded.
//
// The preconditioner is built once at the top of each Krylov solve. The
// `freeDofs` array tells us which compressed-row pairs (i, i+1)
// correspond to the same FE node (consecutive original DOFs that are
// both unconstrained). When a node has only one DOF free (mixed
// boundary condition) the preconditioner falls back to scalar Jacobi
// for that DOF; when a 2×2 block is itself singular (det ≈ 0, which
// can happen on truly degenerate elements) we fall back to identity for
// that pair so Newton/CG never divides by zero.

const BLOCK_JACOBI_DET_EPS = CG_NUMERIC_EPS;

function findRowEntryValue(row, columnIndex) {
  // Linear search in the row's indices array — rows are short (~15-60
  // entries) so this is faster than a map lookup. Returns 0 if the
  // entry is not stored (i.e. the matrix is structurally zero there).
  const indices = row?.indices;
  const values = row?.values;
  if (!indices || !values) return 0;
  for (let k = 0; k < indices.length; k += 1) {
    if (indices[k] === columnIndex) return Number(values[k]) || 0;
  }
  return 0;
}

function safeScalarInvDiag(diag) {
  const value = Math.abs(diag) > CG_NUMERIC_EPS ? diag : 1;
  return 1 / value;
}

export function buildBlockJacobiPreconditioner(rows, freeDofs) {
  // Returns an array of length `rows.length`, one entry per compressed
  // row. Each entry is one of three kinds:
  //   { kind: 'block-first', a, b }  — first row of a 2×2 node block
  //   { kind: 'block-second', c, d } — second row of the same block
  //   { kind: 'scalar',  invDiag }   — solitary row (single-DOF-free node)
  // The block coefficients are the inverse of the 2×2 block stored as
  //   inv(B) = [a b; c d] so that z[i]   = a*r[i] + b*r[i+1]
  //                              z[i+1] = c*r[i] + d*r[i+1]
  // For a 2×2 [[A00 A01];[A10 A11]] the inverse is (1/det) [[A11 -A01];[-A10 A00]].
  // When det is too small the block is treated as singular and we fall
  // back to scalar Jacobi for both rows so the preconditioner remains
  // bounded; the underlying mesh issue still warrants attention but the
  // solver does not collapse on a degenerate element.
  const n = rows.length;
  const precond = new Array(n);
  const safeFreeDofs = Array.isArray(freeDofs) || ArrayBuffer.isView(freeDofs) ? freeDofs : null;
  let i = 0;
  while (i < n) {
    const dofI = safeFreeDofs ? Number(safeFreeDofs[i]) : -1;
    const dofIp1 = safeFreeDofs && (i + 1 < n) ? Number(safeFreeDofs[i + 1]) : -1;
    const isCoupledNodeBlock = safeFreeDofs
      && Number.isFinite(dofI)
      && Number.isFinite(dofIp1)
      && dofI % 2 === 0
      && dofIp1 === dofI + 1;
    if (isCoupledNodeBlock) {
      const a00 = Number(rows[i].diag) || 0;
      const a11 = Number(rows[i + 1].diag) || 0;
      const a01 = findRowEntryValue(rows[i], i + 1);
      const a10 = findRowEntryValue(rows[i + 1], i);
      const det = a00 * a11 - a01 * a10;
      if (Math.abs(det) > BLOCK_JACOBI_DET_EPS) {
        const invDet = 1 / det;
        precond[i]     = { kind: 'block-first',  a:  invDet * a11, b: -invDet * a01 };
        precond[i + 1] = { kind: 'block-second', c: -invDet * a10, d:  invDet * a00 };
        i += 2;
        continue;
      }
      // Block is itself singular — fall through to two scalar entries.
    }
    precond[i] = { kind: 'scalar', invDiag: safeScalarInvDiag(rows[i].diag) };
    i += 1;
  }
  return precond;
}

// Convert the object-array preconditioner into a fixed-offset flat
// form the GPU kernel can consume without dependent texture reads.
// Block-Jacobi entries always reference one of three neighbours: the
// row itself (scalar), one row above (block-second reads r[i-1]), or
// one row below (block-first reads r[i+1]). We split the cross-row
// coupling into two arrays (prevCoef, nextCoef) so the shader can
// compose `z[i]` from `r[i-1], r[i], r[i+1]` with three texture fetches
// at compile-time-known offsets — Apple Metal's WebGL2 driver returns
// zeros for an `r[idx[i]]`-style dependent read, so a kernel that
// uses one would silently produce z = 0 and CG would never make
// progress.
//
// Boundary handling: prevCoef[0] = 0 (so the read of r[-1] clamped to
// r[0] is multiplied by zero) and nextCoef[n-1] = 0 (same for r[n]).
export function flattenBlockJacobiPreconditioner(precond) {
  const n = precond.length;
  const selfCoef = new Float32Array(n);
  const prevCoef = new Float32Array(n);
  const nextCoef = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const entry = precond[i];
    if (!entry || entry.kind === 'scalar') {
      selfCoef[i] = entry?.invDiag ?? 1;
    } else if (entry.kind === 'block-first') {
      // z[i] = a · r[i] + b · r[i+1]
      selfCoef[i] = entry.a;
      nextCoef[i] = entry.b;
    } else if (entry.kind === 'block-second') {
      // z[i] = d · r[i] + c · r[i-1]
      selfCoef[i] = entry.d;
      prevCoef[i] = entry.c;
    } else {
      selfCoef[i] = 1;
    }
  }
  // Defensive boundary zeroing.
  prevCoef[0] = 0;
  nextCoef[n - 1] = 0;
  return { selfCoef, prevCoef, nextCoef };
}

function resolvePreconditionerLevel(options = {}) {
  const level = String(options?.preconditionerLevel || 'jacobi').toLowerCase();
  if (level === 'schwarz' || level === 'additive-schwarz') return 'schwarz';
  if (level === 'ilu0') return 'ilu0';
  return 'jacobi';
}

function buildKrylovPreconditioner(rows, options = {}) {
  const blockJacobi = buildBlockJacobiPreconditioner(rows, options?.freeDofs || null);
  const level = resolvePreconditionerLevel(options);
  if (level !== 'schwarz' || options?.allowSchwarzPreconditioner !== true) return blockJacobi;
  const schwarz = buildAdditiveSchwarzPreconditioner(
    rows,
    options?.freeDofs || null,
    options?.elementCaches || null,
    options
  );
  if (!schwarz) return blockJacobi;
  return {
    kind: 'schwarz-with-block-jacobi-fallback',
    schwarz,
    fallback: blockJacobi
  };
}

export function applyKrylovPreconditioner(precond, r, z) {
  if (precond?.kind === 'schwarz-with-block-jacobi-fallback') {
    if (applyAdditiveSchwarzPreconditioner(precond.schwarz, r, z)) return;
    applyKrylovPreconditioner(precond.fallback, r, z);
    return;
  }
  // Computes z = M^(-1) r where M^(-1) is given block-by-block. Block
  // entries reference the residual at the paired row (i+1 for first,
  // i-1 for second), so we read r before writing z. The two arrays may
  // alias — we write z[i] only after reading r[i+1] for first-row
  // blocks, which is safe because z is a separate buffer.
  const n = r.length;
  for (let i = 0; i < n; i += 1) {
    const entry = precond[i];
    if (!entry) {
      z[i] = r[i];
      continue;
    }
    if (entry.kind === 'scalar') {
      z[i] = entry.invDiag * r[i];
    } else if (entry.kind === 'block-first') {
      // The companion (i+1) is guaranteed to exist when the builder
      // emitted a block-first entry — we never produce a dangling block
      // first at the last row.
      z[i] = entry.a * r[i] + entry.b * r[i + 1];
    } else if (entry.kind === 'block-second') {
      z[i] = entry.c * r[i - 1] + entry.d * r[i];
    } else {
      z[i] = r[i];
    }
  }
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

// Dispatcher: when the active backend exposes a GPU-resident CG, route
// through it. The GPU-resident path keeps x, r, z, p, ap as f32 textures
// across iterations and only crosses the CPU↔GPU boundary at scalar
// reductions and the periodic residual refresh — eliminating the
// per-matvec upload/download round-trip that dominated the user's
// "bursty" GPU usage. Falls back to the legacy hybrid `solveCg` (matvec
// on GPU, axpy/dot on CPU) when the backend does not support resident
// CG, when no backend is active, or when the caller's options indicate
// a path the resident kernel cannot handle (e.g., unsymmetric algorithm).
async function solveCgDispatched(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options = {}) {
  // The GPU-resident CG path keeps every vector (x, r, z, p, ap) as
  // f32 textures across iterations and runs the entire CG inner loop
  // on the GPU. It eliminates the upload/download round-trip per
  // matvec — *but* it computes dot products in pure f32 (a multi-pass
  // reduction with stride 64), and the cumulative ULP error on a
  // 4000-DOF problem is ~1e-5 relative. That coarse residual stalls
  // the outer Newton loop on tight problems (low cohesion, near-MC
  // initial states, anything where the Newton tolerance demands more
  // than ~1e-4 relative residual). Until we ship a higher-precision
  // dot product (Kahan reduction, double-single accumulation, or CPU
  // f64 dots downloaded per iter), the resident path is opt-in only.
  // The hybrid path (matvec on GPU, axpy/dot on CPU f64) remains the
  // default — this is what every passing run on this branch has
  // exercised so far, and it already delivers the bulk of the GPU
  // speedup on real WebGL2 hardware.
  // Resident CG dispatch is gated on a *certification* flag, not just
  // "the dot kernel happens to be DS." `residentCgCertified` only
  // flips to `true` after the backend's full operator chain (matvec,
  // axpy, dot, preconditioner, residual) has been verified to give
  // the same convergence decisions as CPU f64 across the engineering
  // test sweep. Round 1 of the WebGPU backend has DS dot but f32
  // matvec, so it ships with `residentCgCertified: false` and the
  // resident path is opt-in via `options.useResidentCg === true`.
  // Round 2 (DS matvec + DS axpy + true residual replacement) flips
  // the flag to `true` and the resident path becomes the default.
  // `useResidentCg === false` (an explicit decline) always wins.
  const residentExplicit = options?.useResidentCg;
  const residentDefault = activeMatvecBackend?.residentCgCertified === true;
  const wantsResidentPath = activeMatvecBackend?.supportsResidentCg === true
    && typeof activeMatvecBackend?.solveCgPreconditionedGpu === 'function'
    && rows.length > 0
    && (residentExplicit === true || (residentExplicit !== false && residentDefault));
  if (wantsResidentPath) {
    const precond = buildBlockJacobiPreconditioner(rows, options?.freeDofs || null);
    const flat = flattenBlockJacobiPreconditioner(precond);
    const refreshInterval = backendRequiresResidualRefresh()
      ? backendResidualRefreshInterval()
      : 0;
    try {
      const result = await activeMatvecBackend.solveCgPreconditionedGpu({
        rows,
        rhs,
        initial,
        preconditioner: flat,
        maxIter,
        relTol,
        absTol,
        runControl,
        iterationObserver,
        residualRefreshIntervalForCheckpoint: refreshInterval
      });
      // Defensive correctness check: the resident path's f32 storage
      // can in principle produce a non-finite scalar mid-iteration on
      // a pathologically ill-conditioned matrix. The CPU CG below has
      // f64 dynamic range and recovers cleanly; route there if we see
      // any infected output.
      if (!result
          || !Number.isFinite(result.residualNorm)
          || (result.solution && Array.from(result.solution).some((v) => !Number.isFinite(v)))) {
        if (typeof console !== 'undefined' && console?.warn) {
          console.warn('GPU-resident CG produced a non-finite output; falling back to CPU CG for this solve.');
        }
        return solveCg(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options);
      }
      return result;
    } catch (error) {
      // Resident kernel threw (compilation, OOB, driver error). Fall
      // back to CPU CG for this single solve. Don't tear down the
      // backend — the next solve might be smaller and work fine.
      if (typeof console !== 'undefined' && console?.warn) {
        console.warn(`GPU-resident CG threw (${error?.message || 'unknown'}); falling back to CPU CG for this solve.`);
      }
      return solveCg(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options);
    }
  }
  return solveCg(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options);
}

// Dispatcher for GMRES. Mirrors `solveCgDispatched`. Routes to the
// GPU-resident FGMRES (DS operator chain, MGS with GPU-resident
// scalars, true-residual restart) when the active backend self-reports
// `residentGmresCertified` and exposes `solveGmresPreconditionedGpu`.
// Falls back to the legacy CPU `solveGmresScaled` (which uses the
// async backend matvec — also DS via the WebGPU `matvec` API — and
// does Arnoldi + Givens on CPU) when the resident path is unavailable
// or fails for a single solve.
async function solveGmresDispatched(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options = {}) {
  const residentExplicit = options?.useResidentGmres;
  const residentDefault = activeMatvecBackend?.residentGmresCertified === true;
  const wantsResidentPath = activeMatvecBackend?.supportsResidentCg === true
    && typeof activeMatvecBackend?.solveGmresPreconditionedGpu === 'function'
    && rows.length > 0
    && (residentExplicit === true || (residentExplicit !== false && residentDefault));
  if (wantsResidentPath) {
    const precond = buildBlockJacobiPreconditioner(rows, options?.freeDofs || null);
    const flat = flattenBlockJacobiPreconditioner(precond);
    try {
      const result = await activeMatvecBackend.solveGmresPreconditionedGpu({
        rows,
        rhs,
        initial,
        preconditioner: flat,
        maxIter,
        relTol,
        absTol,
        runControl,
        iterationObserver,
        restart: Math.max(Math.round(Number(options?.restart) || GMRES_RESTART), 4)
      });
      if (!result
          || !Number.isFinite(result.residualNorm)
          || (result.solution && Array.from(result.solution).some((v) => !Number.isFinite(v)))) {
        if (typeof console !== 'undefined' && console?.warn) {
          console.warn('GPU-resident FGMRES produced a non-finite output; falling back to CPU GMRES for this solve.');
        }
        return solveGmresScaled(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options);
      }
      return result;
    } catch (error) {
      if (typeof console !== 'undefined' && console?.warn) {
        console.warn(`GPU-resident FGMRES threw (${error?.message || 'unknown'}); falling back to CPU GMRES for this solve.`);
      }
      return solveGmresScaled(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options);
    }
  }
  return solveGmresScaled(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options);
}

async function solveCg(rows, rhs, initial = null, maxIter = MAX_CG_ITER, relTol = CG_REL_TOL, absTol = CG_ABS_TOL, runControl = null, iterationObserver = null, options = {}) {
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
      : await sparseMatVec(rows, x);
    r = new Float64Array(n);
    for (let i = 0; i < n; i += 1) r[i] = rhs[i] - ax[i];
  } else {
    r = Float64Array.from(rhs);
  }
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const rhsNorm = Math.sqrt(dot(rhs, rhs));

  // Build the block-Jacobi preconditioner once per solve. When the caller
  // supplies `freeDofs`, the builder emits 2×2 blocks for nodal DOF pairs
  // and falls back to scalar Jacobi for solitary rows; without it (legacy
  // call sites that have not yet been updated), the builder degrades to
  // pure scalar Jacobi, preserving prior behaviour.
  const precond = buildKrylovPreconditioner(rows, options);
  applyKrylovPreconditioner(precond, r, z);
  for (let i = 0; i < n; i += 1) p[i] = z[i];

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
    const ap = await sparseMatVec(rows, p);
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
    applyKrylovPreconditioner(precond, r, z);
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

async function solveBiCgStab(rows, rhs, initial = null, maxIter = MAX_CG_ITER, relTol = CG_REL_TOL, absTol = CG_ABS_TOL, runControl = null, iterationObserver = null, options = {}) {
  // Same async/sync impedance as solveGmresScaled (see comment there).
  // Default is pure CPU f64. Hybrid (CPU BiCGStab + GPU matvec) is
  // explicit opt-in via `allowHybridGpuMatvecForCpuKrylov`.
  const allowHybridGpu = options?.allowHybridGpuMatvecForCpuKrylov === true;
  const matvec = allowHybridGpu
    ? (rs, v) => sparseMatVec(rs, v)
    : (rs, v) => Promise.resolve(sparseMatVecFallback(rs, v));
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
  const ax0 = initial ? await matvec(rows, x) : new Float64Array(n);
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
  // Block-Jacobi preconditioner — same construction as solveCg. The
  // BiCGStab updates `phat = M^{-1} (p_new)` and `shat = M^{-1} s` once
  // per iteration; the application takes one pass over the residual
  // and produces a bounded preconditioned vector even when individual
  // diagonals are tiny.
  const precond = buildKrylovPreconditioner(rows, options);
  const phatScratchTarget = phat;
  const shatScratchTarget = shat;
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
    }
    applyKrylovPreconditioner(precond, p, phatScratchTarget);
    const vNext = await matvec(rows, phat);
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
    applyKrylovPreconditioner(precond, s, shatScratchTarget);
    const tNext = await matvec(rows, shat);
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
  // GMRES on the CPU side has a hard impedance mismatch with the
  // WebGPU async matvec: every Arnoldi step round-trips a vector
  // (writeBuffer + dispatch + mapAsync + unmap) and the latency
  // dominates the wall-clock on every browser-sized problem we have
  // measured. Default behaviour is therefore *pure CPU f64* — we do
  // NOT use `activeMatvecBackend.matvec` here unless the user
  // explicitly opts into the experimental hybrid via
  // `allowHybridGpuMatvecForCpuKrylov: true`. The fast GPU path for
  // unsymmetric / plastic / c-phi solves is the resident FGMRES
  // (gated by `residentGmresCertified`); this CPU GMRES is the
  // honest fallback when resident is not available.
  const allowHybridGpu = options?.allowHybridGpuMatvecForCpuKrylov === true;
  const matvec = allowHybridGpu
    ? (rs, v) => sparseMatVec(rs, v)
    : (rs, v) => Promise.resolve(sparseMatVecFallback(rs, v));
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
  const rawRhsNorm = Math.sqrt(dot(scaledRhs, scaledRhs));
  const precond = buildKrylovPreconditioner(scaledRows, options);
  const preconditionVector = (vector) => {
    const out = new Float64Array(n);
    applyKrylovPreconditioner(precond, vector, out);
    return out;
  };
  const preconditionedMatvec = async (rs, vector) => preconditionVector(await matvec(rs, vector));
  const preconditionedRhs = preconditionVector(scaledRhs);
  const rhsNorm = Math.sqrt(dot(preconditionedRhs, preconditionedRhs));
  const rawResidualState = async (solutionScaled) => {
    const axRaw = await matvec(scaledRows, solutionScaled);
    const rawResidual = new Float64Array(n);
    for (let entryIndex = 0; entryIndex < n; entryIndex += 1) {
      rawResidual[entryIndex] = scaledRhs[entryIndex] - axRaw[entryIndex];
    }
    const rawResidualNorm = Math.sqrt(dot(rawResidual, rawResidual));
    const rawTolerance = cgToleranceState(rawResidualNorm, rawRhsNorm, relTol, absTol);
    return { rawResidual, rawResidualNorm, rawTolerance };
  };
  const restart = Math.max(Math.round(Number(options?.restart) || GMRES_RESTART), 4);
  let x = scaledSystem.unscaleInitialSolution(initial) || new Float64Array(n);
  let rawState = await rawResidualState(x);
  let residual = preconditionVector(rawState.rawResidual);
  let residualNorm = Math.sqrt(dot(residual, residual));
  let tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  if (tolerance.converged && rawState.rawTolerance.converged) {
    return {
      solution: scaledSystem.scaleSolution(x),
      converged: true,
      iterations: 0,
      residualNorm: rawState.rawResidualNorm,
      relativeResidual: rawState.rawTolerance.relativeResidual,
      rhsNorm: rawRhsNorm,
      toleranceTarget: rawState.rawTolerance.target,
      interrupted: false
    };
  }

  await runCheckpoint(runControl, true);
  let totalIterations = 0;

  while (totalIterations < maxIter) {
    const beta = Math.sqrt(dot(residual, residual));
    if (!(beta > CG_NUMERIC_EPS)) {
      rawState = await rawResidualState(x);
      tolerance = cgToleranceState(0, rhsNorm, relTol, absTol);
      return {
        solution: scaledSystem.scaleSolution(x),
        converged: rawState.rawTolerance.converged,
        iterations: totalIterations,
        residualNorm: rawState.rawResidualNorm,
        relativeResidual: rawState.rawTolerance.relativeResidual,
        rhsNorm: rawRhsNorm,
        toleranceTarget: rawState.rawTolerance.target,
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
      const arnoldiVector = await preconditionedMatvec(scaledRows, basis[columnIndex]);
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
        rawState = await rawResidualState(x);
        residual = preconditionVector(rawState.rawResidual);
        residualNorm = Math.sqrt(dot(residual, residual));
        tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
        solvedThisRestart = tolerance.converged && rawState.rawTolerance.converged;
        break;
      }

      if (totalIterations % GMRES_CHECKPOINT_INTERVAL === 0 && (await runCheckpoint(runControl))) {
        return {
          solution: scaledSystem.scaleSolution(x),
          converged: false,
          iterations: totalIterations,
          residualNorm: rawState?.rawResidualNorm ?? residualNorm,
          relativeResidual: rawState?.rawTolerance?.relativeResidual ?? tolerance.relativeResidual,
          rhsNorm: rawRhsNorm,
          toleranceTarget: rawState?.rawTolerance?.target ?? tolerance.target,
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
      rawState = await rawResidualState(x);
      if (!rawState.rawTolerance.converged) {
        residual = preconditionVector(rawState.rawResidual);
        residualNorm = Math.sqrt(dot(residual, residual));
        tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
        if (totalIterations >= maxIter) break;
      } else {
        tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
        return {
          solution: scaledSystem.scaleSolution(x),
          converged: true,
          iterations: totalIterations,
          residualNorm: rawState.rawResidualNorm,
          relativeResidual: rawState.rawTolerance.relativeResidual,
          rhsNorm: rawRhsNorm,
          toleranceTarget: rawState.rawTolerance.target,
          interrupted: false
        };
      }
    }

    // Between restarts: full-precision raw residual recompute, then apply
    // the selected left preconditioner for the next Arnoldi cycle.
    rawState = await rawResidualState(x);
    residual = preconditionVector(rawState.rawResidual);
    residualNorm = Math.sqrt(dot(residual, residual));
    tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
    if (totalIterations >= maxIter) break;
  }

  rawState = await rawResidualState(x);
  residual = preconditionVector(rawState.rawResidual);
  residualNorm = Math.sqrt(dot(residual, residual));
  tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  return {
    solution: scaledSystem.scaleSolution(x),
    converged: tolerance.converged && rawState.rawTolerance.converged,
    iterations: totalIterations,
    residualNorm: rawState.rawResidualNorm,
    relativeResidual: rawState.rawTolerance.relativeResidual,
    rhsNorm: rawRhsNorm,
    toleranceTarget: rawState.rawTolerance.target,
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

function findOrphanedNodeIds(mesh) {
  // A node is orphaned when it appears in mesh.nodes (and therefore counts
  // toward the global ndof) but no kept element references it. This happens
  // when section-mesh's centroid-in-polygon filter silently drops a thin
  // T6 boundary triangle on sloping terrain; the dropped triangle's corner
  // and midpoint nodes remain in mesh.nodes but have zero stiffness
  // contribution in the global K, leaving zero rows that would otherwise
  // make the matrix singular and cause CG to stagnate.
  const referenced = new Set();
  const elements = mesh?.elements || [];
  for (let elementIndex = 0; elementIndex < elements.length; elementIndex += 1) {
    const element = elements[elementIndex];
    if (!element) continue;
    for (let localIndex = 0; localIndex < element.length; localIndex += 1) {
      const nodeId = Number(element[localIndex]);
      if (Number.isInteger(nodeId)) referenced.add(nodeId);
    }
  }
  const orphans = new Set();
  const totalNodes = mesh?.nodes?.length || 0;
  for (let nodeId = 0; nodeId < totalNodes; nodeId += 1) {
    if (!referenced.has(nodeId)) orphans.add(nodeId);
  }
  return orphans;
}

function buildFixedDofMap(mesh) {
  const { fixUx, fixUy } = buildConstraintSets(mesh);
  const fixed = new Map();
  [...fixUx].forEach((nodeId) => fixed.set(2 * nodeId, 0));
  [...fixUy].forEach((nodeId) => fixed.set(2 * nodeId + 1, 0));
  // Pin orphaned nodes (referenced in mesh.nodes but in no kept element)
  // to zero displacement on both axes. Without this guard, their global
  // K rows are entirely zero and the linear solver sees a singular system.
  const orphans = findOrphanedNodeIds(mesh);
  orphans.forEach((nodeId) => {
    if (!fixed.has(2 * nodeId)) fixed.set(2 * nodeId, 0);
    if (!fixed.has(2 * nodeId + 1)) fixed.set(2 * nodeId + 1, 0);
  });
  if (orphans.size && Array.isArray(mesh?.warnings)) {
    pushUniqueWarning(
      mesh.warnings,
      `Pinned ${orphans.size} orphaned mesh node(s) at zero displacement to keep the global stiffness matrix non-singular. The orphans came from ${mesh.elementType === 't6' ? 'T6 ' : ''}boundary triangles whose centroids landed marginally outside the section polygon and were filtered out by the post-Triangle safety net.`
    );
  }
  return fixed;
}

function loadedTerrainEdges(mesh, load) {
  if (!(load?.xEnd > load?.xStart + GEOM_EPS)) return [];
  return (mesh.constraintEdges || []).filter((edge) => {
    if (edge?.markerType !== 'outer' || edge?.source !== 'terrain') return false;
    return !!overlapRange(edge.a.x, edge.b.x, load.xStart, load.xEnd);
  });
}

function resolveConstitutiveModelName(options) {
  // The UI emits one of three known strings; anything else is normalised
  // to mc-reduced-stiffness (Stage 1) for backwards compatibility with
  // pre-plugin run records that did not always set the option.
  const requested = String(options?.constitutiveModel || '').toLowerCase();
  if (hasMaterialPlugin(requested)) return requested;
  if (requested === 'linear-elastic') return 'linear-elastic';
  if (requested === 'mc-plastic') return 'mc-plastic';
  return 'mc-reduced-stiffness';
}

function createMaterialModelForOptions(materialParameters, options, warnings) {
  // Single source of truth: the plugin registry. The solver does not
  // import the concrete factories any more; new constitutive models are
  // discovered via `registerMaterialPlugin(name, factory)` from the
  // plugin's own module (see material-plugin.js for the contract).
  const name = resolveConstitutiveModelName(options);
  return materialPluginFor(name, materialParameters, warnings);
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
  // The elastic-globalization tangent path is only safe for plugins
  // with an exact return mapping (mc-plastic): the elastic tangent is
  // returned to Newton instead of the algorithmic one to soften
  // ill-conditioned active-set transitions during early globalisation.
  // Other plugins should not be coerced into this path.
  const globalizationTangent6x6 = analysisContext?.useElasticGlobalizationTangent === true &&
    materialPoint.materialModel?.capabilities?.supportsExactReturnMapping === true &&
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

function buildCompressionPositiveStress6(sigmaH0Eff, sigmaV0Eff, tauXY = 0) {
  return [
    -Math.max(Number(sigmaH0Eff) || 0, 0),
    -Math.max(Number(sigmaV0Eff) || 0, 0),
    -Math.max(Number(sigmaH0Eff) || 0, 0),
    -(Number(tauXY) || 0),
    0,
    0
  ];
}

function mcYieldToleranceForStress(stress6, materialParameters) {
  const scale = Math.max(
    Math.abs(Number(stress6?.[0]) || 0),
    Math.abs(Number(stress6?.[1]) || 0),
    Math.abs(Number(stress6?.[2]) || 0),
    Math.abs(Number(stress6?.[3]) || 0),
    Number(materialParameters?.cEff) || 0,
    100
  );
  return Math.max(Number(materialParameters?.yieldTolerance) || 0, (Number(materialParameters?.yieldToleranceScale) || 1e-8) * scale);
}

function isStress6AdmissibleForMc(stress6, materialParameters, tolerance = null) {
  const mc = mohrCoulombIndicator3D(stress6, materialParameters);
  const tol = Number.isFinite(Number(tolerance)) ? Math.max(Number(tolerance), 0) : mcYieldToleranceForStress(stress6, materialParameters);
  return mc?.tensionViolation !== true && (Number(mc?.F) || 0) <= tol;
}

function terrainSlopeAngleAt(model, x) {
  const verts = model?.terrain?.vertices || [];
  if (verts.length < 2) return 0;
  const numericX = Number(x) || 0;
  let segmentIndex = 0;
  if (numericX <= verts[0].x) {
    segmentIndex = 0;
  } else if (numericX >= verts[verts.length - 1].x) {
    segmentIndex = verts.length - 2;
  } else {
    for (let index = 0; index < verts.length - 1; index += 1) {
      if (numericX >= verts[index].x && numericX <= verts[index + 1].x) {
        segmentIndex = index;
        break;
      }
    }
  }
  const a = verts[segmentIndex];
  const b = verts[Math.min(segmentIndex + 1, verts.length - 1)];
  const dx = Number(b?.x) - Number(a?.x);
  const dy = Number(b?.y) - Number(a?.y);
  return Math.atan2(Number.isFinite(dy) ? dy : 0, Math.abs(dx) > GEOM_EPS ? dx : GEOM_EPS);
}

function clipHorizontalStressToAdmissibleEnvelope(sigmaV0Eff, sigmaH0TargetEff, materialParameters) {
  const sigmaV = Math.max(Number(sigmaV0Eff) || 0, 0);
  const target = Math.max(Number(sigmaH0TargetEff) || 0, 0);
  const targetStress = buildCompressionPositiveStress6(target, sigmaV, 0);
  const targetTol = mcYieldToleranceForStress(targetStress, materialParameters);
  if (isStress6AdmissibleForMc(targetStress, materialParameters, targetTol)) {
    return {
      sigmaH: target,
      clipped: false,
      deficit: 0
    };
  }
  const hydrostaticStress = buildCompressionPositiveStress6(sigmaV, sigmaV, 0);
  if (!isStress6AdmissibleForMc(hydrostaticStress, materialParameters)) {
    return {
      sigmaH: sigmaV,
      clipped: true,
      deficit: Math.abs(target - sigmaV),
      hydrostaticFallback: true
    };
  }
  let lo = 0;
  let hi = 1;
  for (let iter = 0; iter < 60; iter += 1) {
    const mid = 0.5 * (lo + hi);
    const candidate = sigmaV + mid * (target - sigmaV);
    const stress = buildCompressionPositiveStress6(candidate, sigmaV, 0);
    if (isStress6AdmissibleForMc(stress, materialParameters)) lo = mid;
    else hi = mid;
  }
  const sigmaH = sigmaV + lo * (target - sigmaV);
  return {
    sigmaH,
    clipped: true,
    deficit: Math.abs(target - sigmaH)
  };
}

function largestAdmissibleShearByBisection(sigmaV0Eff, sigmaH0Eff, tauSign, materialParameters) {
  const sign = Math.sign(Number(tauSign) || 0);
  if (!sign) return 0;
  const zeroStress = buildCompressionPositiveStress6(sigmaH0Eff, sigmaV0Eff, 0);
  if (!isStress6AdmissibleForMc(zeroStress, materialParameters)) return 0;
  const stressScale = Math.max(
    Math.abs(Number(sigmaV0Eff) || 0),
    Math.abs(Number(sigmaH0Eff) || 0),
    Math.max(Number(materialParameters?.cEff) || 0, 0),
    1
  );
  let lo = 0;
  let hi = stressScale;
  for (let grow = 0; grow < 32; grow += 1) {
    const candidate = buildCompressionPositiveStress6(sigmaH0Eff, sigmaV0Eff, sign * hi);
    if (!isStress6AdmissibleForMc(candidate, materialParameters)) break;
    lo = hi;
    hi *= 2;
  }
  for (let iter = 0; iter < 64; iter += 1) {
    const mid = 0.5 * (lo + hi);
    const candidate = buildCompressionPositiveStress6(sigmaH0Eff, sigmaV0Eff, sign * mid);
    if (isStress6AdmissibleForMc(candidate, materialParameters)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function chooseSlopeShearTarget(point, elasticGeostaticStress6, slopeAngleRad, sigmaV0Eff) {
  const elasticTau = -(Number(elasticGeostaticStress6?.[3]) || 0);
  const slopeTauEstimate = Math.max(Number(sigmaV0Eff) || 0, 0) * Math.sin(slopeAngleRad) * Math.cos(slopeAngleRad);
  if (Math.abs(slopeAngleRad) < 1e-5) return 0;
  const sign = Math.sign(elasticTau) || Math.sign(slopeTauEstimate) || 0;
  if (!sign) return 0;
  const terrainBound = Math.max(Math.abs(slopeTauEstimate) * 2, 0.05 * Math.max(Number(sigmaV0Eff) || 0, 0), 1e-9);
  if (Math.abs(elasticTau) > 1e-12) return sign * Math.min(Math.abs(elasticTau), terrainBound);
  return sign * Math.abs(slopeTauEstimate);
}

function clipShearToAdmissibleEnvelope(sigmaV0Eff, sigmaH0Eff, tauTarget, materialParameters) {
  const sign = Math.sign(Number(tauTarget) || 0);
  if (!sign) {
    return {
      tau: 0,
      clipped: false,
      deficit: 0,
      tauMax: 0
    };
  }
  const tauMax = largestAdmissibleShearByBisection(sigmaV0Eff, sigmaH0Eff, sign, materialParameters);
  const targetAbs = Math.abs(Number(tauTarget) || 0);
  const tauAbs = Math.min(targetAbs, tauMax);
  return {
    tau: sign * tauAbs,
    clipped: targetAbs > tauMax + 1e-10,
    deficit: Math.max(targetAbs - tauAbs, 0),
    tauMax
  };
}

function createSeedDiagnosticsAccumulator() {
  return {
    pointCount: 0,
    shearClippedCount: 0,
    horizontalClippedCount: 0,
    hydrostaticFallbackCount: 0,
    inadmissibleAfterClipCount: 0,
    maxShearDeficit: 0,
    maxHorizontalDeficit: 0,
    depthBands: NEAR_SURFACE_DEPTH_BANDS.map((band) => ({
      label: band.label,
      max: band.max,
      count: 0,
      shearClipped: 0,
      horizontalClipped: 0,
      inadmissibleAfterClip: 0
    }))
  };
}

function recordSeedDiagnostic(accumulator, model, point, diagnostic) {
  if (!accumulator) return;
  accumulator.pointCount += 1;
  const depth = model ? depthBelowTerrainAt(model, point.x, point.y) : Number.POSITIVE_INFINITY;
  const band = accumulator.depthBands[bandIndexForDepth(depth)];
  if (band) band.count += 1;
  if (diagnostic?.shearClipped) {
    accumulator.shearClippedCount += 1;
    accumulator.maxShearDeficit = Math.max(accumulator.maxShearDeficit, Number(diagnostic.shearDeficit) || 0);
    if (band) band.shearClipped += 1;
  }
  if (diagnostic?.horizontalClipped) {
    accumulator.horizontalClippedCount += 1;
    accumulator.maxHorizontalDeficit = Math.max(accumulator.maxHorizontalDeficit, Number(diagnostic.horizontalDeficit) || 0);
    if (band) band.horizontalClipped += 1;
  }
  if (diagnostic?.hydrostaticFallback) accumulator.hydrostaticFallbackCount += 1;
  if (diagnostic?.inadmissibleAfterClip) {
    accumulator.inadmissibleAfterClipCount += 1;
    if (band) band.inadmissibleAfterClip += 1;
  }
}

function buildAdmissibleSlopeInitialEffectiveStress6(point, materialParameters, model, options, elasticGeostaticStress6, warnings = null) {
  const sigmaVTotal = verticalOverburdenStressAt(model, point.x, point.y);
  const porePressure = sampleInitialPorePressure(model, point.x, point.y, options, warnings);
  const sigmaV0Eff = Math.max((Number(sigmaVTotal) || 0) - Math.max(Number(porePressure) || 0, 0), 0);
  const K0 = Number.isFinite(Number(materialParameters?.K0nc))
    ? Math.max(Number(materialParameters.K0nc), 0)
    : fallbackK0(materialParameters?.phiEffDeg);
  const horizontal = clipHorizontalStressToAdmissibleEnvelope(sigmaV0Eff, K0 * sigmaV0Eff, materialParameters);
  const slopeAngle = terrainSlopeAngleAt(model, point.x);
  const tauTarget = chooseSlopeShearTarget(point, elasticGeostaticStress6, slopeAngle, sigmaV0Eff);
  const shear = clipShearToAdmissibleEnvelope(sigmaV0Eff, horizontal.sigmaH, tauTarget, materialParameters);
  const stress6 = buildCompressionPositiveStress6(horizontal.sigmaH, sigmaV0Eff, shear.tau);
  const inadmissibleAfterClip = !isStress6AdmissibleForMc(stress6, materialParameters);
  return {
    stress6,
    diagnostic: {
      sigmaV0Eff,
      sigmaH0Eff: horizontal.sigmaH,
      porePressure,
      slopeAngle,
      tauTarget,
      tauSeed: shear.tau,
      tauMax: shear.tauMax,
      shearClipped: shear.clipped,
      shearDeficit: shear.deficit,
      horizontalClipped: horizontal.clipped,
      horizontalDeficit: horizontal.deficit,
      hydrostaticFallback: horizontal.hydrostaticFallback === true,
      inadmissibleAfterClip
    }
  };
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

function recoverInitialFieldFromGeostaticSolution(mesh, elementCaches, model, Ugeo, regionConstitutiveByRegion, options, porePressureByIntegrationPoint, warnings) {
  const out = new Array(elementCaches.integrationPointCount || elementCaches.length);
  const precomputedStrainFlat = backendElementStrain(elementCaches, Ugeo);
  const useAdmissibleSlopeSeed = options?.useAdmissibleSlopeSeed !== false;
  const seedDiagnostics = useAdmissibleSlopeSeed ? createSeedDiagnosticsAccumulator() : null;
  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const cell = mesh.cells[elementCache.cellIndex];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    for (const gp of elementCache.integrationPoints || []) {
      // Geostatic recovery deliberately uses the linear-elastic plugin
      // (regardless of the run's chosen constitutive model) to back out
      // the K0-controlled initial stress from the gravity displacement
      // solution: the recovery is by construction elastic, even when the
      // service phase will be exact MC. The registry lookup makes the
      // dependency on the plugin name explicit and routes through the
      // same shape-validated path as every other plugin instantiation.
      const materialPoint = createMaterialPoint({
        materialModel: materialPluginFor('linear-elastic', constitutive.materialParameters, warnings),
        materialParameters: constitutive.materialParameters,
        elementIndex,
        integrationPointIndex: gp.globalIndex,
        gpIndex: gp.gpIndex,
        regionIndex: cell?.regionIndex ?? -1
      });
      const precomputedStrain = precomputedStrainFlat
        ? (elementCache.kind === 't6'
            ? {
                exx: Number(precomputedStrainFlat[elementIndex * 9 + gp.gpIndex * 3]) || 0,
                eyy: Number(precomputedStrainFlat[elementIndex * 9 + gp.gpIndex * 3 + 1]) || 0,
                gxy: Number(precomputedStrainFlat[elementIndex * 9 + gp.gpIndex * 3 + 2]) || 0
              }
            : {
                exx: Number(precomputedStrainFlat[elementIndex * 3]) || 0,
                eyy: Number(precomputedStrainFlat[elementIndex * 3 + 1]) || 0,
                gxy: Number(precomputedStrainFlat[elementIndex * 3 + 2]) || 0
              })
        : null;
      const response = recoverIntegrationPointMaterialResponse(elementCache, gp, Ugeo, materialPoint, {
        stage: 'geostatic-initialization'
      }, precomputedStrain);
      const u0 = Math.max(Number(porePressureByIntegrationPoint?.[gp.globalIndex]) || 0, 0);
      if (useAdmissibleSlopeSeed) {
        const seed = buildAdmissibleSlopeInitialEffectiveStress6(
          { x: Number(gp.x) || 0, y: Number(gp.y) || 0 },
          constitutive.materialParameters,
          model,
          options,
          response.update?.stressTrial6,
          warnings
        );
        out[gp.globalIndex] = seed.stress6;
        recordSeedDiagnostic(
          seedDiagnostics,
          model,
          { x: Number(gp.x) || 0, y: Number(gp.y) || 0 },
          seed.diagnostic
        );
      } else {
        out[gp.globalIndex] = buildK0ControlledInitialEffectiveStress6(response.update?.stressTrial6, constitutive.materialParameters, u0);
      }
    }
  }
  return { initialField: out, seedDiagnostics };
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

  const geostaticCg = await solveCgDispatched(
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
    },
    // Pass freeDofs so the block-Jacobi preconditioner can identify
    // nodal (x, y) DOF pairs in the compressed-row layout. Without
    // this hint the preconditioner falls back to scalar Jacobi —
    // mathematically valid but susceptible to the near-orphan T6
    // mid-edge ill-conditioning that motivated this whole refactor.
    //
    // Pass `useResidentCg`, `useResidentGmres`, and the hybrid-opt-in
    // as-is (do NOT coerce to strict booleans). The dispatcher uses
    // three-state logic where `undefined` means "use the backend's
    // default", and `false` forces the safe path. Coercion would
    // erase the third state.
    {
      freeDofs,
      useResidentCg: options?.useResidentCg,
      useResidentGmres: options?.useResidentGmres,
      allowHybridGpuMatvecForCpuKrylov: options?.allowHybridGpuMatvecForCpuKrylov
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
      seedMode: 'flat-k0-fallback',
      seedDiagnostics: null,
      iterations: geostaticCg.iterations,
      residualNorm: geostaticCg.residualNorm,
      solution: new Float64Array(ndof)
    };
  }

  const Ugeo = expandSolutionVector(ndof, freeDofs, fixedValues, geostaticCg.solution);
  const recoveredInitial = recoverInitialFieldFromGeostaticSolution(
    mesh,
    elementCaches,
    model,
    Ugeo,
    regionConstitutiveByRegion,
    options,
    porePressureByIntegrationPoint,
    warnings
  );
  const initialField = recoveredInitial.initialField;
  const seedDiagnostics = recoveredInitial.seedDiagnostics || null;
  const hasInvalidStress = initialField.some((stress6) => !Array.isArray(stress6) || stress6.some((value) => !Number.isFinite(Number(value))));
  if (hasInvalidStress) {
    pushUniqueWarning(
      warnings,
      'Geostatic gravity-step initialization produced an invalid stress state, so the deformation screen fell back to flat-ground K0 initial stress.'
    );
    return {
      initialField: buildFlatK0InitialEffectiveStressFieldForIntegrationPoints(mesh, elementCaches, model, options, warnings),
      mode: 'flat-k0-fallback',
      seedMode: 'flat-k0-fallback',
      seedDiagnostics: null,
      iterations: geostaticCg.iterations,
      residualNorm: geostaticCg.residualNorm,
      solution: new Float64Array(ndof)
    };
  }
  if (seedDiagnostics?.shearClippedCount > 0 || seedDiagnostics?.horizontalClippedCount > 0) {
    const activeBands = (seedDiagnostics.depthBands || [])
      .filter((band) => (Number(band.shearClipped) || 0) > 0 || (Number(band.horizontalClipped) || 0) > 0 || (Number(band.inadmissibleAfterClip) || 0) > 0)
      .map((band) => `${band.label}: ${band.shearClipped || 0} shear, ${band.horizontalClipped || 0} K0`)
      .join('; ');
    pushUniqueWarning(
      warnings,
      `Admissible slope geostatic seed clipped ${seedDiagnostics.shearClippedCount} shear target(s) and ${seedDiagnostics.horizontalClippedCount} K0 horizontal target(s) to stay inside the exact Mohr-Coulomb/tension envelope${activeBands ? ` (${activeBands})` : ''}. The staged plastic correction then restores global equilibrium gradually.`
    );
  }
  if (seedDiagnostics?.inadmissibleAfterClipCount > 0) {
    pushUniqueWarning(
      warnings,
      `${seedDiagnostics.inadmissibleAfterClipCount} initial geostatic seed point(s) remained inadmissible after shear/K0 clipping. The predictor projection fallback will try the exact return map before plastic equilibration starts.`
    );
  }

  return {
    initialField,
    mode: 'gravity-step-k0nc',
    seedMode: options?.useAdmissibleSlopeSeed === false ? 'legacy-k0-elastic-shear' : 'admissible-slope-k0nc',
    seedDiagnostics,
    iterations: geostaticCg.iterations,
    residualNorm: geostaticCg.residualNorm,
    solution: Ugeo
  };
}

// Depth bands for predictor-projection diagnostics. The bands are the
// natural geotechnical decomposition: the topmost band collects the
// classic free-surface boundary (where K0 plus elastic shear can sit
// just outside MC because p ≈ c·cot phi); the deeper bands surface
// projections that should not normally happen and indicate either a
// material configuration problem or a slope geometry the K0 predictor
// cannot represent at all.
const NEAR_SURFACE_DEPTH_BANDS = [
  { label: '0.00–0.25 m', max: 0.25 },
  { label: '0.25–0.50 m', max: 0.50 },
  { label: '0.50–1.00 m', max: 1.00 },
  { label: '1.00–2.00 m', max: 2.00 },
  { label: '2.00–4.00 m', max: 4.00 },
  { label: '> 4.00 m',    max: Number.POSITIVE_INFINITY }
];

function depthBelowTerrainAt(model, x, y) {
  if (!model?.terrain?.vertices?.length) return Number.POSITIVE_INFINITY;
  const ySurface = terrainY(model.terrain, x);
  if (!Number.isFinite(ySurface)) return Number.POSITIVE_INFINITY;
  return Math.max(ySurface - y, 0);
}

function bandIndexForDepth(depth) {
  for (let index = 0; index < NEAR_SURFACE_DEPTH_BANDS.length; index += 1) {
    if (depth <= NEAR_SURFACE_DEPTH_BANDS[index].max) return index;
  }
  return NEAR_SURFACE_DEPTH_BANDS.length - 1;
}

function summarizePredictorProjectionByDepth(bandCounts) {
  const lines = [];
  for (let index = 0; index < NEAR_SURFACE_DEPTH_BANDS.length; index += 1) {
    const count = bandCounts[index] || 0;
    if (count > 0) lines.push(`${count} at ${NEAR_SURFACE_DEPTH_BANDS[index].label}`);
  }
  return lines.length ? lines.join(', ') : 'no projections';
}

function buildElementMaterialPoints(mesh, elementCaches, regionConstitutiveByRegion, initialField, options, warnings, model = null) {
  const materialPoints = new Array(elementCaches.integrationPointCount || elementCaches.length);
  // Project the K0 predictor onto MC at seed time when the constitutive
  // model is exact MC plasticity. This is the only place the deformation
  // workflow has to deal with seeds outside the MC surface; the rest of
  // the pipeline assumes admissible state. Without projection the
  // plastic-geostatic phase has to correct both yield and equilibrium
  // simultaneously and stalls on weak shallow soils on sloping terrain.
  // Predictor projection is only meaningful for plugins that can map an
  // inadmissible K0 stress onto their yield surface. The capability flag
  // makes the dependency explicit; flip-flopping the option without
  // adding the flag would silently ignore the request.
  const samplePluginForSeed = (() => {
    for (const constitutive of regionConstitutiveByRegion.values()) {
      if (constitutive?.materialModel?.capabilities) return constitutive.materialModel;
    }
    return null;
  })();
  const projectInadmissibleOntoMc = samplePluginForSeed?.capabilities?.supportsPredictorProjection === true;
  const seedOptions = projectInadmissibleOntoMc ? { projectInadmissibleOntoMc: true } : undefined;
  let projectedSeedCount = 0;
  let failedProjectionCount = 0;
  // Bin projections by depth-below-terrain so the engineer can tell
  // shallow free-surface activity (expected) from deep inadmissibility
  // (configuration problem). Indexed by NEAR_SURFACE_DEPTH_BANDS.
  const projectedBandCounts = new Array(NEAR_SURFACE_DEPTH_BANDS.length).fill(0);
  const failedBandCounts = new Array(NEAR_SURFACE_DEPTH_BANDS.length).fill(0);
  let deepProjectionCount = 0;
  elementCaches.forEach((elementCache) => {
    const elementIndex = elementCache.elementIndex;
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    (elementCache.integrationPoints || []).forEach((gp) => {
      const initialStress6 = initialField?.[gp.globalIndex];
      const committedState = Array.isArray(initialStress6)
        ? seedMaterialPointStateFromEffectiveStress6(initialStress6, constitutive.materialParameters, seedOptions)
        : seedMaterialPointStateFromInitialStress(initialStress6, constitutive.materialParameters);
      if (committedState?.initialProjectedFromInadmissible || committedState?.initialProjectionFailed) {
        const depth = model
          ? depthBelowTerrainAt(model, Number(gp.x) || 0, Number(gp.y) || 0)
          : Number.POSITIVE_INFINITY;
        const band = bandIndexForDepth(depth);
        if (committedState?.initialProjectedFromInadmissible) {
          projectedSeedCount += 1;
          projectedBandCounts[band] += 1;
          if (depth > NEAR_SURFACE_DEPTH_BANDS[2].max) deepProjectionCount += 1;
        }
        if (committedState?.initialProjectionFailed) {
          failedProjectionCount += 1;
          failedBandCounts[band] += 1;
        }
      }
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
  if (projectedSeedCount > 0) {
    const distribution = summarizePredictorProjectionByDepth(projectedBandCounts);
    pushUniqueWarning(
      warnings,
      `Initial Mohr-Coulomb predictor projection: ${projectedSeedCount} integration point(s) had K0-controlled seed stresses outside the MC surface and were projected onto the exact yield surface before plastic-geostatic equilibration (depth distribution: ${distribution}). This is normal on sloping terrain and shallow weak-soil layers near the surface; deeper projections may indicate a configuration mismatch.`
    );
    if (deepProjectionCount > 0) {
      pushUniqueWarning(
        warnings,
        `${deepProjectionCount} integration point(s) deeper than 1 m below the terrain required predictor projection. This is unusual for the K0 closure and may indicate inconsistent material parameters (c', phi', K0nc) or a strongly inclined region boundary that the flat-ground K0 predictor cannot represent. Review the material card and region polygons.`
      );
    }
  }
  if (failedProjectionCount > 0) {
    const distribution = summarizePredictorProjectionByDepth(failedBandCounts);
    pushUniqueWarning(
      warnings,
      `${failedProjectionCount} integration point(s) had inadmissible K0 predictor stresses that could not be projected onto the MC surface (depth distribution: ${distribution}). These points start outside yield and the plastic-geostatic phase will treat them as initially active. Check material parameters (c', phi'), the K0 value, and any user-supplied initial stress overrides.`
    );
  }
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
  // Element-kind dispatch for the backend internal-force path. We only
  // attempt the flat-array round-trip when (a) every cache is the same
  // kind (mixed meshes are not supported by the backend) and (b) the
  // active backend advertises the kind. The stride is 3 floats per T3
  // element (one Gauss point) and 9 per T6 element (three Gauss points,
  // each carrying sxx, syy, txy).
  const elementsKindUniform = elementCachesAreUniformKind(elementCaches);
  const elementsKind = elementsKindUniform ? (elementCaches[0]?.kind === 't6' ? 't6' : 't3') : null;
  const usesBackendInternalForce = !!(
    elementsKindUniform &&
    activeMatvecBackend &&
    typeof activeMatvecBackend.elementInternalForce === 'function' &&
    backendSupportsKind(activeMatvecBackend, elementsKind)
  );
  const stressFlatStride = elementsKind === 't6' ? 9 : 3;
  const internalForceStride = elementsKind === 't6' ? 12 : 6;
  const stressContributionFlat = usesBackendInternalForce
    ? new Float64Array(elementCaches.length * stressFlatStride)
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
      const precomputedStrain = precomputedStrainFlat
        ? (elementCache.kind === 't6'
            ? {
                exx: Number(precomputedStrainFlat[elementIndex * 9 + gp.gpIndex * 3]) || 0,
                eyy: Number(precomputedStrainFlat[elementIndex * 9 + gp.gpIndex * 3 + 1]) || 0,
                gxy: Number(precomputedStrainFlat[elementIndex * 9 + gp.gpIndex * 3 + 2]) || 0
              }
            : {
                exx: Number(precomputedStrainFlat[elementIndex * 3]) || 0,
                eyy: Number(precomputedStrainFlat[elementIndex * 3 + 1]) || 0,
                gxy: Number(precomputedStrainFlat[elementIndex * 3 + 2]) || 0
              })
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

    if (stressContributionFlat) {
      // T3: 1 GP × (sxx, syy, txy) = 3 floats; T6: 3 GPs × (sxx, syy, txy) = 9 floats.
      const stressBase = elementIndex * stressFlatStride;
      const gpCount = stressContributionAtGp.length;
      for (let g = 0; g < gpCount; g += 1) {
        const stress2D = stressContributionAtGp[g];
        stressContributionFlat[stressBase + g * 3] = Number(stress2D?.sxx) || 0;
        stressContributionFlat[stressBase + g * 3 + 1] = Number(stress2D?.syy) || 0;
        stressContributionFlat[stressBase + g * 3 + 2] = Number(stress2D?.txy) || 0;
      }
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
          elementIndex * internalForceStride
        );
      }
    } else {
      // Backend dropped out (precision escalation, kernel failure, etc.).
      // Reconstruct the per-Gauss stress array from the flat buffer and
      // call the CPU element kernel with the same per-element layout it
      // expects (T3: one stress entry; T6: three).
      for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
        const elementCache = elementCaches[elementIndex];
        const stressBase = elementIndex * stressFlatStride;
        const gpCount = elementCache.numGaussPoints || (elementsKind === 't6' ? 3 : 1);
        const stressAtGp = new Array(gpCount);
        for (let g = 0; g < gpCount; g += 1) {
          stressAtGp[g] = {
            sxx: stressContributionFlat[stressBase + g * 3],
            syy: stressContributionFlat[stressBase + g * 3 + 1],
            txy: stressContributionFlat[stressBase + g * 3 + 2]
          };
        }
        addVectorBlockToFreeRhs(
          internalForceFree,
          elementCache.freeRowIndices,
          elementCache.kernel.elementInternalForce(elementCache.corners, stressAtGp, elementCache.area, elementCache)
        );
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
  const minResidualRatio = Number(lineSearchOptions?.minResidualRatio);
  const requiresResidualImprovement = Number.isFinite(minResidualRatio) && minResidualRatio > 0 && minResidualRatio < 1;
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
    const residualImprovementAccepted = !requiresResidualImprovement
      || residualNorm <= minResidualRatio * Math.max(Number(currentResidualNorm) || 0, 0)
      || stepScale <= minStepScale + 1e-12;
    const accepted = candidateMerit <= Math.max(armijoTarget, 0) && residualImprovementAccepted;
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
        residualImprovementAccepted,
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
  const constitutiveModel = resolveConstitutiveModelName(options);
  // Capability snapshot for the plugin in use. The solver gates every
  // model-specific code path below on these flags rather than on string
  // comparisons, so a future plugin (e.g. Hardening Soil) plugs in with
  // no solver edits — only its own capability declaration. We read the
  // capabilities from any one material point because a single run uses
  // a uniform plugin across regions; if a future change introduces
  // per-region plugin selection, this becomes a per-element-cache
  // lookup instead.
  const samplePlugin = materialPoints.find((materialPoint) => materialPoint?.materialModel?.capabilities)?.materialModel
    || null;
  const capabilities = samplePlugin?.capabilities || {};
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
  const isLinearElastic = capabilities.isLinearElastic === true;
  const requiresStableActiveSet = capabilities.requiresStableActiveSetAtConvergence === true;
  // Displacement-norm tolerance is dropped for plugins with an exact
  // return mapping: the residual is already certified by the per-Gauss
  // active-set, so adding a displacement gate just delays acceptance of
  // converged states with small but non-zero correction (typical of
  // late-iteration line-search-stalled steps that are nonetheless at
  // the residual tolerance).
  const requiresDisplacementTolerance = capabilities.supportsExactReturnMapping !== true;
  const exactPlasticTangentMayBeUnsymmetric = capabilities.algorithmicTangentMayBeUnsymmetric === true &&
    materialPoints.some((materialPoint) => materialPoint?.materialParameters?.symmetrizeEpTangent !== true);
  // The initial-gravity phase can use a scheduled elastic-globalization
  // tangent before switching to the algorithmic plastic tangent. The
  // elastic tangent is a globalization device only; the residual and
  // material updates are still the exact plastic ones.
  const phaseCanUseElasticGlobalizationTangent = capabilities.supportsExactReturnMapping === true &&
    capabilities.supportsPlasticGeostaticPhase === true &&
    phaseKind === 'initial-gravity';
  const initialGravityTangentSchedule = phaseCanUseElasticGlobalizationTangent
    ? normalizeTangentSchedule(
        options?.initialGravityTangentSchedule,
        options?.initialGravityUseElasticGlobalizationTangent === true ? ['elastic', 'plastic'] : ['elastic', 'plastic']
      )
    : ['plastic'];
  const elasticGlobalizationIterations = Math.max(Math.round(Number(options?.initialGravityElasticGlobalizationIterations) || 4), 0);
  const elasticGlobalizationSwitchRelativeResidual = Math.max(Number(options?.elasticGlobalizationSwitchRelativeResidual) || 0.25, 0);
  const mayNeedUnsymmetricSolver = capabilities.algorithmicTangentMayBeUnsymmetric === true
    && (exactPlasticTangentMayBeUnsymmetric || options?.useUnsymmetricPlasticSolver === true);
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
  const maximumLoadStep = Math.min(
    Math.max(
      Number(isInitialGravityPhase ? (options?.initialGravityMaxLoadStep ?? options?.maxLoadStep) : options?.maxLoadStep) || 1,
      minLoadStep
    ),
    1
  );
  const geostaticFailFastMinLoadStep = Math.max(Number(options?.geostaticMinLoadStep) || 1e-3, minLoadStep);
  const geostaticMaxRepeatedBand = Math.max(Math.round(Number(options?.geostaticMaxRepeatedBand) || 3), 1);
  const geostaticProgressFailFast = options?.geostaticProgressFailFast !== false;
  const geostaticProgressFailFastSteps = Math.max(Math.round(Number(options?.geostaticProgressFailFastSteps) || 6), 1);
  const geostaticProgressFailFastLoadFactor = Math.min(Math.max(Number(options?.geostaticProgressFailFastLoadFactor) || 0.50, 0), 1);
  const geostaticProgressFailFastPlasticFraction = Math.min(Math.max(Number(options?.geostaticProgressFailFastPlasticFraction) || 0.15, 0), 1);
  const serviceProgressFailFast = options?.serviceProgressFailFast !== false;
  const serviceProgressFailFastSteps = Math.max(Math.round(Number(options?.serviceProgressFailFastSteps) || 16), 1);
  const serviceProgressFailFastLoadFactor = Math.min(Math.max(Number(options?.serviceProgressFailFastLoadFactor) || 0.20, 0), 1);
  const serviceProgressFailFastPlasticFraction = Math.min(Math.max(Number(options?.serviceProgressFailFastPlasticFraction) || 0.35, 0), 1);
  let stepSize = isLinearElastic
    ? 1
    : Math.min(Math.max(Number(options?.initialLoadStep) || NONLINEAR_INITIAL_LOAD_STEP, minLoadStep), maximumLoadStep);
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
  let finalDepthBandReport = null;
  let lastDepthBandReport = null;
  let previousRejectedDominantBandLabel = '';
  let repeatedRejectedDominantBandCount = 0;
  const depthBandHistory = [];
  // Display labels are pulled from the plugin so a future plugin gets
  // consistent error/progress messages without solver edits. The
  // initial-gravity and safety-cphi labels are phase-level (not
  // plugin-level), so they stay hardcoded; the phase only runs when the
  // plugin's capability flag advertises support.
  const pluginDisplayName = samplePlugin?.displayName || 'Material';
  const phaseDisplayName = phaseKind === 'initial-gravity'
    ? 'Stage 2 initial plastic equilibration'
    : phaseKind === 'safety-cphi'
      ? 'Safety c-phi reduction'
      : pluginDisplayName;
  const analysisStageLabel = phaseKind === 'initial-gravity'
    ? 'initial-gravity-stage-2'
    : phaseKind === 'safety-cphi'
      ? 'safety-cphi-stage'
      : `nonlinear-${samplePlugin?.kind || 'unknown'}`;
  // Short solver label used in error / failure messages. Avoids the
  // explicit `mc-plastic ? 'Stage 2' : 'Stage 1'` branches scattered
  // throughout this function — the plugin owns its label.
  const solveLabel = `${pluginDisplayName} deformation solve`;
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
  const diagnosticModel = phaseConfig?.model || null;
  const computeCurrentDepthBandReport = () => diagnosticModel
    ? computeDepthBandReport(null, materialPoints, diagnosticModel, elementCaches, options)
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
            : `${solveLabel}`
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
      tangentModesUsed: [],
      suggestedNextStepFactor: 1,
      suggestedNextStepSize: actualStep
    };

    let converged = false;
    let failureReason = '';
    let failureCode = '';
    let suggestedStepCutbackFactor = null;
    let lastCorrection = new Float64Array(ndof);
    let stepBestState = null;
    let latestRelativeResidualForSchedule = Number.POSITIVE_INFINITY;
    let stepElasticGlobalizationStalled = false;
    // Warm-starting the linear solve carries the previous Newton's
    // step as the initial guess for the next iteration's Krylov solve.
    // Worth doing whenever the plugin's algorithmic tangent can be
    // unsymmetric (so we'd be running GMRES, where a good warm start
    // saves several iterations). Linear elastic skips it because the
    // first solve already converges in 1 Newton.
    const shouldWarmStartLinearSolve = capabilities.algorithmicTangentMayBeUnsymmetric === true;
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
      const scheduleWantsElastic = initialGravityTangentSchedule.includes('elastic');
      const scheduleWantsPlastic = initialGravityTangentSchedule.includes('plastic');
      const useElasticGlobalizationTangent = phaseCanUseElasticGlobalizationTangent &&
        scheduleWantsElastic &&
        !stepElasticGlobalizationStalled &&
        (
          !scheduleWantsPlastic ||
          iteration <= elasticGlobalizationIterations ||
          latestRelativeResidualForSchedule > elasticGlobalizationSwitchRelativeResidual
        );
      const tangentMode = useElasticGlobalizationTangent ? 'elastic' : 'plastic';
      if (!stepRecord.tangentModesUsed.includes(tangentMode)) stepRecord.tangentModesUsed.push(tangentMode);
      const elementAnalysisOptionsForTarget = {
        ...(buildElementAnalysisOptions ? (buildElementAnalysisOptions(targetLoadFactor) || {}) : {}),
        useElasticGlobalizationTangent
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
      lastDepthBandReport = computeCurrentDepthBandReport();
      if (lastDepthBandReport) {
        depthBandHistory.push({
          loadStepIndex: loadStepCounter,
          iteration,
          targetLoadFactor,
          report: lastDepthBandReport
        });
        stepRecord.depthBandReport = lastDepthBandReport;
      }
      if (Number.isFinite(Number(tolerance.relativeResidual))) {
        latestRelativeResidualForSchedule = Number(tolerance.relativeResidual);
      }
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
        stateChanges: assembled.changedCount,
        depthBandReport: lastDepthBandReport
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

      // The unsymmetric scaled solver (GMRES with row/column scaling) is
      // forced under any of the following conditions:
      //   1. activeCount > 0 — any plastic Gauss point in the trial
      //      assembly. The algorithmic tangent is then guaranteed
      //      unsymmetric for non-associated MC.
      //   2. The phase is plastic geostatic equilibration (initial-gravity
      //      with mc-plastic). Even when an iteration's trial happens to
      //      be elastic, this phase carries a large unbalanced predictor
      //      residual and the committed plastic state can flip the
      //      algorithmic tangent unsymmetric mid-line-search. CG with
      //      Jacobi preconditioning is unreliable here regardless of
      //      element type. T6 makes it much worse because mid-edge DOFs
      //      have very different diagonal magnitudes from corner DOFs.
      const isPlasticGeostatic = capabilities.supportsPlasticGeostaticPhase === true
        && phaseKind === 'initial-gravity';
      const usesUnsymmetricSolver = !useElasticGlobalizationTangent && mayNeedUnsymmetricSolver && (
        assembled.activeCount > 0
        || isPlasticGeostatic
      );
      // Krylov dispatch:
      //   * unsymmetric (mc-plastic + non-associated tangent) →
      //     `solveGmresDispatched` (routes to GPU-resident FGMRES if
      //     `residentGmresCertified` is true, else CPU GMRES with the
      //     async DS backend matvec) or BiCGStab.
      //   * symmetric (linear elastic, mc-reduced-stiffness, or any
      //     case where the algorithmic tangent is symmetric) → CG via
      //     `solveCgDispatched`, which routes to the GPU-resident CG
      //     when the active backend exposes it.
      const linearSolve = usesUnsymmetricSolver
        ? (
            unsymmetricLinearSolverMode === 'bicgstab'
              ? solveBiCgStab
              : solveGmresDispatched
          )
        : solveCgDispatched;
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
        linearIterationObserver,
        // freeDofs lets the block-Jacobi preconditioner identify nodal
        // 2×2 DOF blocks in the compressed-row layout. Both solveCg and
        // solveBiCgStab honour this option; solveGmresScaled does its
        // own row equilibration scaling and ignores extra options
        // beyond the iteration-observer signature it documents.
        // `useResidentCg` and `useResidentGmres` are passed through
        // (not coerced to boolean) so the dispatcher's three-state
        // logic can pick the backend default when the user has not
        // made a manual choice. `allowHybridGpuMatvecForCpuKrylov` is
        // forwarded so the GMRES dispatcher can route uncertified
        // resident solves to *pure CPU f64* (the safe default) rather
        // than the slow CPU-GMRES-with-GPU-matvec hybrid.
        {
          freeDofs,
          elementCaches,
          allowSchwarzPreconditioner: usesUnsymmetricSolver,
          preconditionerLevel: options?.preconditionerLevel,
          schwarzMinFreeDofs: options?.schwarzMinFreeDofs,
          schwarzOverlap: options?.schwarzOverlap,
          schwarzMaxPatchDofs: options?.schwarzMaxPatchDofs,
          schwarzDamping: options?.schwarzDamping,
          useResidentCg: options?.useResidentCg,
          useResidentGmres: options?.useResidentGmres,
          allowHybridGpuMatvecForCpuKrylov: options?.allowHybridGpuMatvecForCpuKrylov,
          restart: options?.restart
        }
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
          linearIterationObserver,
          {
            freeDofs,
            elementCaches,
            allowSchwarzPreconditioner: usesUnsymmetricSolver,
            preconditionerLevel: options?.preconditionerLevel,
            schwarzMinFreeDofs: options?.schwarzMinFreeDofs,
            schwarzOverlap: options?.schwarzOverlap,
            schwarzMaxPatchDofs: options?.schwarzMaxPatchDofs,
            schwarzDamping: options?.schwarzDamping,
            useResidentCg: options?.useResidentCg,
            useResidentGmres: options?.useResidentGmres,
            allowHybridGpuMatvecForCpuKrylov: options?.allowHybridGpuMatvecForCpuKrylov,
            restart: options?.restart
          }
        );
      };
      totalCgIterations += cg.iterations;
      if (cg.interrupted) {
        throw new Error(`Deformation run was interrupted during ${
          phaseKind === 'initial-gravity'
            ? 'the initial plastic equilibration phase'
            : phaseKind === 'safety-cphi'
              ? 'the c-phi reduction safety phase'
              : `the ${pluginDisplayName} solve`
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
                  : `the ${pluginDisplayName} solve`
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
      if (capabilities.requiresPlasticLineSearch === true && correctionNorm > 0) {
        try {
          const lineSearchOptionsForTarget = useElasticGlobalizationTangent
            ? {
                ...plasticLineSearchOptions,
                armijoCoefficient: Math.max(Number(options?.elasticGlobalizationArmijoC1) || 1e-3, 0),
                minResidualRatio: Math.min(Math.max(Number(options?.elasticGlobalizationMinResidualRatio) || 0.90, 1e-6), 0.999)
              }
            : plasticLineSearchOptions;
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
            lineSearchOptionsForTarget
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
            stepRecord.lineSearchResidualImprovementAccepted = lineSearch.residualImprovementAccepted !== false;
            if (!lineSearch.accepted) {
              if (useElasticGlobalizationTangent && scheduleWantsPlastic) {
                stepElasticGlobalizationStalled = true;
                resetMaterialPointTrials(materialPoints);
                continue;
              }
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
        lastDepthBandReport = computeCurrentDepthBandReport();
        if (lastDepthBandReport) stepRecord.depthBandReport = lastDepthBandReport;
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
              : `the ${pluginDisplayName} solve`
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
      // The conservative `plasticGrowthFactor` cap exists for when the active
      // set keeps flipping or the line search has to back off — both signs
      // that an aggressive step could overshoot a yield branch transition.
      // Once a service step converges in well under the target Newton count
      // *and* the line search accepts at full scale, the step is in a
      // quasi-steady plastic regime: the algorithmic tangent is locally
      // accurate, and capping growth at 1.05/step strands the solve well
      // before the target load (the adaptive formula would otherwise
      // compute ~sqrt(target/iter) ≈ 1.7×). Detect this benign regime
      // and fall back to the elastic growth limit; the adaptive formula
      // still throttles naturally if iterations rise. Near a bearing
      // limit, the rejection-cutback pair (harsh `Math.min` of default
      // and line-search-derived factor) restores conservative stepping
      // until the system settles again.
      // The plastic growth / cutback caps are only relevant when the
      // active set is changing — i.e. for plugins that track a yield
      // surface and may switch a Gauss point's branch between
      // iterations. Linear-elastic skips this path entirely; reduced
      // stiffness and exact MC use it.
      const benignPlasticStep = capabilities.tracksYieldSurface === true
        && stepRecord.peakActiveCount > 0
        && stepRecord.iterations > 0
        && stepRecord.iterations * 2 <= continuationTargetIterations
        && (!stepRecord.lineSearchEvaluations
            || (stepRecord.lineSearchAccepted
                && (Number(stepRecord.lineSearchAcceptedScale) || 0) >= 0.999));
      const effectiveGrowthFactor = capabilities.tracksYieldSurface === true
        && stepRecord.peakActiveCount > 0
        && !benignPlasticStep
        ? Math.min(growthFactor, plasticGrowthFactor)
        : growthFactor;
      const effectiveCutbackFactor = capabilities.tracksYieldSurface === true
        && stepRecord.peakActiveCount > 0
        && !benignPlasticStep
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
      stepRecord.suggestedNextStepSize = Math.min(
        actualStep * nextStepFactor,
        maximumLoadStep,
        targetLoadFactorFinal - loadFactorCommitted || actualStep
      );
      loadStepHistory.push(stepRecord);
      if (
        isInitialGravityPhase &&
        geostaticProgressFailFast &&
        acceptedSteps >= geostaticProgressFailFastSteps &&
        loadFactorCommitted < geostaticProgressFailFastLoadFactor &&
        (Number(stepRecord.peakActiveCount) || 0) / Math.max(elementCaches.length || 1, 1) >= geostaticProgressFailFastPlasticFraction
      ) {
        const classification = classifyGeostaticNonconvergence(lastDepthBandReport || stepRecord.depthBandReport, stepRecord, {
          loadFactorCommitted,
          repeatedBandCount: geostaticMaxRepeatedBand
        });
        terminalFailureReason = classification.reason || `Initial self-weight equilibration was stopped because ${acceptedSteps} accepted correction steps reached only ${(100 * loadFactorCommitted).toFixed(1)}% while a large plastic zone stayed active.`;
        terminalFailureCode = classification.code || 'geostatic-numerically-stuck';
        terminatedByFailure = true;
        break;
      }
      if (
        phaseKind === 'service-load' &&
        serviceProgressFailFast &&
        capabilities.requiresPlasticLineSearch === true &&
        acceptedSteps >= serviceProgressFailFastSteps &&
        loadFactorCommitted < serviceProgressFailFastLoadFactor &&
        (Number(stepRecord.peakActiveCount) || 0) / Math.max(elementCaches.length || 1, 1) >= serviceProgressFailFastPlasticFraction
      ) {
        terminalFailureReason = `Service loading was stopped early because ${acceptedSteps} accepted continuation steps advanced only ${(100 * loadFactorCommitted).toFixed(1)}% load while a large plastic zone stayed active.`;
        terminalFailureCode = 'step-budget-exhausted';
        terminatedByFailure = true;
        break;
      }
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
          : `${solveLabel} could not converge the target state (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`;
      terminalFailureCode = failureCode || 'nonlinear-iterations-exhausted';
      loadStepHistory.push(stepRecord);
      terminatedByFailure = true;
      break;
    }
    const effectiveCutbackFactor = capabilities.tracksYieldSurface === true && stepRecord.peakActiveCount > 0
      ? Math.min(cutbackFactor, plasticCutbackFactor)
      : cutbackFactor;
    // The line-search-derived cutback (lineSearch.stepScale) is a Newton
    // *direction* quality signal, not a load-magnitude one — using the
    // raw 0.5^k backtrack as the load step factor over-corrects badly
    // (e.g. a 3-backtrack scale of 0.125 cuts the load 8×, then needs
    // ~21 accept steps to climb back, eating the load-step budget).
    // Cap the cutback below at the engineering default
    // `effectiveCutbackFactor` and above at 0.9; the line-search signal
    // can soften the cutback (when the Newton step was nearly
    // admissible) but never deepen it beyond the configured plastic
    // cutback. Subsequent rejections compound naturally if the larger
    // cutback was insufficient.
    const suggestedCutbackFactor = capabilities.requiresPlasticLineSearch === true &&
      Number.isFinite(Number(suggestedStepCutbackFactor)) &&
      Number(suggestedStepCutbackFactor) > 0
      ? Math.max(effectiveCutbackFactor, Math.min(0.9, Number(suggestedStepCutbackFactor)))
      : effectiveCutbackFactor;
    const proposedStepSize = actualStep * suggestedCutbackFactor;
    stepRecord.suggestedNextStepFactor = suggestedCutbackFactor;
    stepRecord.suggestedNextStepSize = proposedStepSize < minLoadStep - 1e-12 && actualStep > minLoadStep + 1e-12
      ? minLoadStep
      : proposedStepSize;
    if (isInitialGravityPhase && lastDepthBandReport) {
      const dominantLabel = lastDepthBandReport.dominantBand?.label || '';
      if (dominantLabel && dominantLabel === previousRejectedDominantBandLabel) {
        repeatedRejectedDominantBandCount += 1;
      } else {
        previousRejectedDominantBandLabel = dominantLabel;
        repeatedRejectedDominantBandCount = dominantLabel ? 1 : 0;
      }
      stepRecord.repeatedDominantDepthBandCount = repeatedRejectedDominantBandCount;
      const failFastStep = Math.min(stepRecord.suggestedNextStepSize, actualStep);
      if (
        repeatedRejectedDominantBandCount >= geostaticMaxRepeatedBand ||
        failFastStep <= geostaticFailFastMinLoadStep + 1e-12
      ) {
        const classification = classifyGeostaticNonconvergence(lastDepthBandReport, stepRecord, {
          loadFactorCommitted,
          repeatedBandCount: repeatedRejectedDominantBandCount
        });
        terminalFailureReason = classification.reason;
        terminalFailureCode = classification.code;
        stepRecord.failureCode = classification.code;
        stepRecord.failureOutcomeClass = classification.outcomeClass;
        stepRecord.reason = classification.reason;
        loadStepHistory.push(stepRecord);
        stepSize = stepRecord.suggestedNextStepSize;
        resetMaterialPointTrials(materialPoints);
        terminatedByFailure = true;
        break;
      }
    }
    loadStepHistory.push(stepRecord);
    stepSize = stepRecord.suggestedNextStepSize;
    resetMaterialPointTrials(materialPoints);
    if (stepSize < minLoadStep - 1e-12) {
      terminalFailureReason = phaseKind === 'initial-gravity'
        ? `Initial plastic equilibration could not converge the load step to ${(100 * targetLoadFactor).toFixed(1)}% (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`
        : phaseKind === 'safety-cphi'
          ? `Safety c-phi reduction could not converge the continuation step (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`
          : `${solveLabel} could not converge the load step to ${(100 * targetLoadFactor).toFixed(1)}% (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`;
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
    throw new Error(terminalFailureReason || `${solveLabel} failed before a usable displacement state became available.`);
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
      useElasticGlobalizationTangent: false
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
  finalDepthBandReport = computeCurrentDepthBandReport();
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
    ? createFailureRecord(terminalFailureCode, terminalFailureReason || displayedState?.reason)
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
    failureReason: terminatedByFailure ? (terminalFailureReason || displayedState?.reason || '') : '',
    loadStepHistory,
    residualHistory,
    depthBandHistory,
    finalDepthBandReport
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

function maxTerrainSlopeAngle(model) {
  const verts = model?.terrain?.vertices || [];
  let maxAngle = 0;
  for (let index = 0; index < verts.length - 1; index += 1) {
    const dx = Number(verts[index + 1]?.x) - Number(verts[index]?.x);
    const dy = Number(verts[index + 1]?.y) - Number(verts[index]?.y);
    if (Math.abs(dx) <= GEOM_EPS) continue;
    maxAngle = Math.max(maxAngle, Math.abs(Math.atan2(dy, dx)));
  }
  return maxAngle;
}

function planGeostaticCorrectionStages(model, options = {}) {
  const explicit = Number(options?.geostaticCorrectionStages);
  let count = Number.isFinite(explicit) && explicit > 0
    ? Math.round(explicit)
    : 8;
  const slopeAngle = maxTerrainSlopeAngle(model);
  if (!(Number.isFinite(explicit) && explicit > 0)) {
    if (slopeAngle > 30 * Math.PI / 180) count = Math.max(count, 12);
    else if (slopeAngle > 15 * Math.PI / 180) count = Math.max(count, 10);
  }
  count = Math.min(Math.max(count, 1), 64);
  return Array.from({ length: count }, (_item, index) => ({
    kind: 'geostatic-correction',
    index: index + 1,
    lambda: (index + 1) / count
  }));
}

async function solveStagedGeostaticEquilibrium(
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
  options = {},
  model = null
) {
  const initializedPredictor = await initializePlasticPredictorReferenceState(
    elementCaches,
    assemblyPattern,
    gravityRhsFreeBase,
    materialPoints,
    initialSolution,
    runControl
  );
  const stages = planGeostaticCorrectionStages(model, options);
  const stageSize = stages.length > 0 ? 1 / stages.length : 1;
  const phase = await solveNonlinearPhase(
    elementCaches,
    assemblyPattern,
    gravityRhsFreeBase,
    materialPoints,
    ndof,
    freeDofs,
    fixedValues,
    runControl,
    onProgress,
    {
      ...options,
      initialLoadStep: Math.min(Math.max(Number(options?.initialLoadStep) || NONLINEAR_INITIAL_LOAD_STEP, stageSize), stageSize),
      initialGravityMaxLoadStep: Math.min(
        Math.max(Number(options?.initialGravityMaxLoadStep) || stageSize, stageSize),
        stageSize
      )
    },
    {
      phaseKind: 'initial-gravity',
      formulationMode: 'total',
      allowLoadStepping: true,
      targetLoadFactor: 1,
      targetForceBase: initializedPredictor.targetForceBase,
      initialSolution,
      model
    }
  );
  return {
    ...phase,
    geostaticCorrectionStages: stages,
    initializedPredictor
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
  options = {},
  model = null
) {
  if (options?.useStagedGeostaticInit !== false) {
    return solveStagedGeostaticEquilibrium(
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
      options,
      model
    );
  }
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
      initialSolution,
      model
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
  options = {},
  model = null
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
      initialSolution,
      model
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
  model,
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
      commitPhaseState: (progress, materialPoints) => applySafetyParameters(progress, materialPoints),
      model
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
  options,
  model = null
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
      model,
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
      const precomputedStrain = precomputedStrainFlat
        ? (elementCache.kind === 't6'
            ? {
                exx: Number(precomputedStrainFlat[elementIndex * 9 + gp.gpIndex * 3]) || 0,
                eyy: Number(precomputedStrainFlat[elementIndex * 9 + gp.gpIndex * 3 + 1]) || 0,
                gxy: Number(precomputedStrainFlat[elementIndex * 9 + gp.gpIndex * 3 + 2]) || 0
              }
            : {
                exx: Number(precomputedStrainFlat[elementIndex * 3]) || 0,
                eyy: Number(precomputedStrainFlat[elementIndex * 3 + 1]) || 0,
                gxy: Number(precomputedStrainFlat[elementIndex * 3 + 2]) || 0
              })
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
  // Per-run flags. The element kernels are disabled per element type if
  // they produce a non-finite value during the run; the backend's matvec
  // stays live regardless. Reset here so a previous run's T6 disable
  // doesn't carry into a fresh analysis.
  disabledElementKernels.t3 = false;
  disabledElementKernels.t6 = false;
  // The vector-magnitude warning is cap-limited to a few emissions per
  // run (otherwise an ill-conditioned solve produces hundreds of
  // identical lines). Reset the counter so the cap applies per-run.
  gpuVectorMagnitudeFallbacksReported = 0;
  // Reset the soft NaN-budget too. The budget is per-run: a single bad
  // run cannot poison the next one's GPU.
  gpuMatvecSoftNanCount = 0;
  gpuMatvecSoftNanReported = 0;
  const model = input?.model;
  if (!model?.terrain?.vertices?.length || !model?.regions?.length) {
    throw new Error('The deformation screen needs a valid Bishop section model first.');
  }

  const warnings = [];
  const analysisType = input?.options?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
  const constitutiveModel = resolveConstitutiveModelName(input?.options);
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
    // Resolution chain: explicit initial-gravity override → generic
    // minLoadStep / maxLoadSteps → conservative initial-gravity defaults.
    // The previous form short-circuited to the conservative default
    // unconditionally, which silently overrode a user-supplied
    // `minLoadStep: 0.0005` and let initial plastic equilibration grind
    // for hundreds of tiny steps the user had asked the solver to skip.
    initialGravityMinLoadStep: Math.max(
      pickFiniteFallback(
        input?.options?.initialGravityMinLoadStep,
        input?.options?.minLoadStep,
        1 / 8192
      ),
      1e-5
    ),
    initialGravityMaxLoadSteps: Math.max(
      Math.round(
        pickFiniteFallback(
          input?.options?.initialGravityMaxLoadSteps,
          input?.options?.maxLoadSteps,
          512
        )
      ),
      1
    ),
    plasticLineSearchReductionFactor: Math.min(Math.max(Number(input?.options?.plasticLineSearchReductionFactor) || 0.5, 0.1), 0.95),
    plasticLineSearchMaxBacktracks: Math.max(Math.round(Number(input?.options?.plasticLineSearchMaxBacktracks) || 4), 1),
    plasticLineSearchMinScale: Math.min(Math.max(Number(input?.options?.plasticLineSearchMinScale) || (1 / 64), 1e-4), 1),
    plasticLineSearchSufficientDecreaseFactor: Math.max(Number(input?.options?.plasticLineSearchSufficientDecreaseFactor) || 1e-3, 0),
    plasticLineSearchArmijoCoefficient: Math.max(Number(input?.options?.plasticLineSearchArmijoCoefficient) || 1e-4, 0),
    initialGravityPlasticLineSearchMaxBacktracks: Math.max(Math.round(Number(input?.options?.initialGravityPlasticLineSearchMaxBacktracks) || 5), 1),
    initialGravityPlasticLineSearchMinScale: Math.min(Math.max(Number(input?.options?.initialGravityPlasticLineSearchMinScale) || (1 / 32), 1e-4), 1),
    initialGravityPlasticLineSearchSufficientDecreaseFactor: Math.max(Number(input?.options?.initialGravityPlasticLineSearchSufficientDecreaseFactor) || 1e-3, 0),
    initialGravityPlasticLineSearchArmijoCoefficient: Math.max(Number(input?.options?.initialGravityPlasticLineSearchArmijoCoefficient) || 1e-4, 0),
    useAdmissibleSlopeSeed: input?.options?.useAdmissibleSlopeSeed !== false,
    useStagedGeostaticInit: input?.options?.useStagedGeostaticInit !== false,
    geostaticCorrectionStages: Math.min(Math.max(Math.round(Number(input?.options?.geostaticCorrectionStages) || 8), 1), 64),
    initialGravityTangentSchedule: normalizeTangentSchedule(input?.options?.initialGravityTangentSchedule, ['elastic', 'plastic']),
    initialGravityElasticGlobalizationIterations: Math.max(Math.round(Number(input?.options?.initialGravityElasticGlobalizationIterations) || 4), 0),
    elasticGlobalizationArmijoC1: Math.max(Number(input?.options?.elasticGlobalizationArmijoC1) || 1e-3, 0),
    elasticGlobalizationMinResidualRatio: Math.min(Math.max(Number(input?.options?.elasticGlobalizationMinResidualRatio) || 0.90, 1e-6), 0.999),
    elasticGlobalizationSwitchRelativeResidual: Math.max(Number(input?.options?.elasticGlobalizationSwitchRelativeResidual) || 0.25, 0),
    geostaticMinLoadStep: Math.max(Number(input?.options?.geostaticMinLoadStep) || 1e-3, 1e-6),
    geostaticMaxRepeatedBand: Math.max(Math.round(Number(input?.options?.geostaticMaxRepeatedBand) || 3), 1),
    geostaticProgressFailFast: input?.options?.geostaticProgressFailFast !== false,
    geostaticProgressFailFastSteps: Math.max(Math.round(Number(input?.options?.geostaticProgressFailFastSteps) || 6), 1),
    geostaticProgressFailFastLoadFactor: Math.min(Math.max(Number(input?.options?.geostaticProgressFailFastLoadFactor) || 0.50, 0), 1),
    geostaticProgressFailFastPlasticFraction: Math.min(Math.max(Number(input?.options?.geostaticProgressFailFastPlasticFraction) || 0.15, 0), 1),
    serviceProgressFailFast: input?.options?.serviceProgressFailFast !== false,
    serviceProgressFailFastSteps: Math.max(Math.round(Number(input?.options?.serviceProgressFailFastSteps) || 16), 1),
    serviceProgressFailFastLoadFactor: Math.min(Math.max(Number(input?.options?.serviceProgressFailFastLoadFactor) || 0.20, 0), 1),
    serviceProgressFailFastPlasticFraction: Math.min(Math.max(Number(input?.options?.serviceProgressFailFastPlasticFraction) || 0.35, 0), 1),
    preconditionerLevel: ['jacobi', 'schwarz', 'additive-schwarz'].includes(String(input?.options?.preconditionerLevel || '').toLowerCase())
      ? String(input.options.preconditionerLevel).toLowerCase()
      : 'schwarz',
    schwarzMinFreeDofs: Math.max(Math.round(Number(input?.options?.schwarzMinFreeDofs) || 5000), 0),
    schwarzOverlap: Math.max(Math.round(Number(input?.options?.schwarzOverlap) || 1), 0),
    schwarzMaxPatchDofs: Math.max(Math.round(Number(input?.options?.schwarzMaxPatchDofs) || 48), 4),
    schwarzDamping: Math.min(Math.max(Number(input?.options?.schwarzDamping) || 0.65, 0.05), 1),
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
    // `useResidentCg` is three-valued: `true` forces resident, `false`
    // forces hybrid, `undefined` lets the backend decide. The WebGPU
    // backend self-reports `residentCgCertified`, which the dispatcher
    // uses to default-on the resident path. Preserve `undefined`
    // here — coercing to `false` would erase the backend default.
    useResidentCg: typeof input?.options?.useResidentCg === 'boolean'
      ? input.options.useResidentCg
      : undefined,
    // `useResidentGmres` mirrors `useResidentCg` for the unsymmetric
    // / plastic / c-phi solver path. The WebGPU resident FGMRES
    // implementation exists but is gated by `residentGmresCertified`
    // (currently `false` — flipped to `true` only after the browser
    // certification harness passes against CPU f64). Until certified,
    // GMRES routes to the *pure CPU f64* path, NOT to the hybrid
    // (CPU GMRES + GPU matvec) path — that hybrid is the slow
    // pattern the user diagnosed and we no longer accept it as a
    // silent default.
    useResidentGmres: typeof input?.options?.useResidentGmres === 'boolean'
      ? input.options.useResidentGmres
      : undefined,
    // `allowHybridGpuMatvecForCpuKrylov` is the explicit, opt-in
    // escape hatch for users who want the experimental hybrid path
    // (CPU GMRES/BiCGStab + GPU async matvec). Default off because
    // the per-Arnoldi-step round-trip dominates wall-clock on every
    // browser-sized problem we have measured.
    allowHybridGpuMatvecForCpuKrylov: input?.options?.allowHybridGpuMatvecForCpuKrylov === true,
    gpuPrecisionMode: String(input?.options?.gpuPrecisionMode || 'auto').toLowerCase() === 'double-single'
      ? 'double-single'
      : 'auto',
    linearAlgebraBackend: typeof input?.options?.linearAlgebraBackend === 'string'
      ? input.options.linearAlgebraBackend
      : null,
    gpuMinDof: Math.max(Math.round(Number(input?.options?.gpuMinDof) || GPU_DEFAULT_MIN_DOF), 0)
  };
  // T6 + GPU is now supported via the dedicated T6 element kernels. The
  // backend probe (webgl-backend.js / cpu-f32-backend.js) reports
  // supportsT6ElementKernels separately, so a partial degradation is
  // possible if the GPU.js compilation of the T6 kernels fails on the
  // current hardware — the per-call dispatcher in
  // backendElement{Strain,InternalForce,ElasticStiffness} routes to CPU
  // automatically in that case.
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
  // Surface mesh-build warnings (sanity guard, orphan diagnostics) to the
  // run-level warnings list before any solver work begins.
  (mesh?.warnings || []).forEach((message) => pushUniqueWarning(warnings, message));

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
    if (elasticStiffnessFlat) {
      // T3: 6×6 = 36 floats per element; T6: 12×12 = 144.
      const stiffnessStride = elementCache.kind === 't6' ? 144 : 36;
      addMatrixBlockFlat(rows, elementCache.dofs, elasticStiffnessFlat, elementIndex * stiffnessStride);
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
  // Plastic geostatic equilibration runs only when the active plugin
  // advertises support for it. The capability flag is the single source
  // of truth — adding a future plugin (e.g. Hardening Soil) that also
  // supports the phase just sets the flag in its capabilities object.
  const samplePluginForPhase = (() => {
    for (const c of regionConstitutiveByRegion.values()) {
      if (c?.materialModel?.capabilities) return c.materialModel;
    }
    return null;
  })();
  const canRunPlasticInitialEquilibrium = wantsPlasticInitialEquilibrium
    && samplePluginForPhase?.capabilities?.supportsPlasticGeostaticPhase === true;
  const materialPoints = buildElementMaterialPoints(mesh, elementCaches, regionConstitutiveByRegion, geostatic.initialField, options, warnings, model);
  if (wantsPlasticInitialEquilibrium && !canRunPlasticInitialEquilibrium) {
    pushUniqueWarning(
      warnings,
      `Plastic geostatic equilibration is not supported by the ${samplePluginForPhase?.displayName || 'current'} material model, so the solver used the fast geostatic predictor instead.`
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
    residualHistory: [],
    depthBandHistory: [],
    finalDepthBandReport: null
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
      options,
      model
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
      message: `Solving ${freeDofs.length.toLocaleString()} free deformation DOFs with the ${samplePluginForPhase?.displayName || 'current'} material model...`
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
      options,
      model
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
      options,
      model
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
      initialPredictorSeedMode: geostatic.seedMode || geostatic.mode,
      initialPredictorSeedDiagnostics: geostatic.seedDiagnostics || null,
      geostaticIterations: geostatic.iterations,
      geostaticResidualNorm: geostatic.residualNorm,
      geostaticCorrectionStages: canRunPlasticInitialEquilibrium ? (initialPhase.geostaticCorrectionStages || []) : [],
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
      initialPhaseDepthBandReport: canRunPlasticInitialEquilibrium ? initialPhase.finalDepthBandReport : null,
      servicePhaseStarted,
      servicePhaseConvergenceState: servicePhaseStarted ? servicePhase.convergenceState : 'not-started',
      servicePhaseFailureCode: servicePhaseStarted ? servicePhase.failureCode : (canRunPlasticInitialEquilibrium ? initialPhase.failureCode : ''),
      servicePhaseFailureOutcomeClass: servicePhaseStarted ? servicePhase.failureOutcomeClass : (canRunPlasticInitialEquilibrium ? initialPhase.failureOutcomeClass : 'unknown'),
      servicePhaseFailureReason: servicePhaseStarted ? servicePhase.failureReason : (canRunPlasticInitialEquilibrium ? initialPhase.failureReason : ''),
      servicePhaseDepthBandReport: servicePhaseStarted ? servicePhase.finalDepthBandReport : null,
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
      initialDepthBandHistory: canRunPlasticInitialEquilibrium ? initialPhase.depthBandHistory : [],
      activeDepthBandReport: activePhase?.finalDepthBandReport || null,
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
        // Per-element-type capability flags: the WebGL probe runs a tiny
        // kernel for each, so a hardware quirk that breaks T6 (or T3) on
        // a specific GPU is reported here without disabling the other.
        supportsT3ElementKernels: activeBackendInfo?.supportsT3ElementKernels !== false,
        supportsT6ElementKernels: activeBackendInfo?.supportsT6ElementKernels !== false,
        // True iff the active backend's element kernels are actually
        // engaged for this run's element type. The UI surfaces this so
        // the user can see at a glance whether T6 GPU acceleration is
        // live (vs. e.g. silently degraded to CPU because the per-kernel
        // sanity probe failed on the user's hardware, or runtime
        // disabled mid-run after a non-finite value).
        elementKernelsActive: !!activeMatvecBackend
          && backendSupportsKind(activeMatvecBackend, mesh.elementType === 't6' ? 't6' : 't3')
          && !disabledElementKernels[mesh.elementType === 't6' ? 't6' : 't3'],
        supportsDoubleSingle: activeBackendInfo?.supportsDoubleSingle === true,
        failedFrom: activeBackendInfo?.failedFrom || null,
        failedOperation: activeBackendInfo?.failedOperation || null,
        freeDofCount: freeDofs.length,
        elementType: mesh.elementType === 't6' ? 't6' : 't3',
        residualRefreshInterval: backendRequiresResidualRefresh() ? backendResidualRefreshInterval() : 0,
        // Honest path label resolved from active backend + dispatch
        // gates. Tells the user *exactly* which solver path actually
        // ran, in plain language. The previous run record only said
        // "GPU enabled" which was true even when the slow CPU-Krylov
        // + GPU-matvec hybrid was running — the user could not tell
        // resident from hybrid from pure-CPU at a glance.
        //
        // Resolution order:
        //   - 'cpu-f64' if no GPU backend is active.
        //   - 'gpu-resident-cg' if the symmetric path went through
        //     the WebGPU resident CG (DS chain, true-residual
        //     replacement, full GPU residence).
        //   - 'gpu-resident-gmres' if the unsymmetric path went
        //     through the WebGPU resident FGMRES.
        //   - 'gpu-cpu-cg' / 'gpu-cpu-gmres' / 'gpu-cpu-bicgstab' for
        //     CPU Krylov with GPU async DS matvec (only reachable
        //     when the user explicitly opts in via
        //     `allowHybridGpuMatvecForCpuKrylov: true`).
        krylovPath: !activeMatvecBackend
          ? 'cpu-f64'
          : activeMatvecBackend.residentCgCertified === true && options.useResidentCg !== false
            ? (activeMatvecBackend.residentGmresCertified === true || options.useResidentGmres === true
                ? 'gpu-resident-cg+gmres'
                : 'gpu-resident-cg')
            : (options.useResidentGmres === true && activeMatvecBackend.residentGmresCertified === true
                ? 'gpu-resident-gmres'
                : (options.allowHybridGpuMatvecForCpuKrylov === true
                    ? 'hybrid-cpu-krylov-gpu-matvec'
                    : 'cpu-f64'))
      }
    },
    timing: {
      totalMs: performance.now() - startedAt
    }
  };
}
