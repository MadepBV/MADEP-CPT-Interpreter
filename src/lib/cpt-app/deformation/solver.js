// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { pointInPolygonHalfOpen } from '../soil-regions.js';
import { buildDeformationMesh } from './mesh.js';
import { triangleArea } from './element-t3.js';
import { elementKernelFor, normalizeElementType } from './element-kernel.js';
import { shapeFunctionsT6, applyBBarToT6BMatrices as T6BarTransform } from './element-t6.js';
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
  mcTolerance,
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
  modelHasSteepSlopeOrWalls,
  mohrCoulombIndicator,
  negateNormalAndShear,
  principalStress2DCompressionPositive,
  resolveNearSurfaceMinConfiningStress,
  sampleInitialPorePressure,
  verticalOverburdenStressAt
} from './post.js';
import { computeDepthBandReport } from './diagnostics-depth-bands.js';
// Additive Schwarz support was removed in favour of a single block-Jacobi
// 2×2 preconditioner path. The Schwarz module is preserved on disk for any
// future reintroduction but is no longer imported here.
import { terrainY } from '../stage6-bishop.js';

// New GPU resident pipeline (engineer-controlled opt-in via
// `options.useNewGpuPipeline`). The controller probes WebGPU at runtime;
// any failure falls back to the CPU path and surfaces a warning.
import { probeGpuPipeline as gpuProbeGpuPipeline, runDeformationOnGpu as gpuRunDeformationOnGpu } from './gpu/gpu-controller.js';

// GPU acceleration is being rebuilt as a separate, fully resident
// double-single pipeline. Until that pipeline lands the deformation solver
// runs CPU f64 only. No backend dispatchers, no precision escalation, no
// resident kernels, no hybrid mode — just the CPU path that the CPU
// regression suite already validates.

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
const NONLINEAR_MAX_ITER = 32;
const NONLINEAR_INITIAL_LOAD_STEP = 0.25;
const NONLINEAR_MIN_LOAD_STEP = 1 / 2048;
const NONLINEAR_GROWTH_FACTOR = 1.25;
const NONLINEAR_CUTBACK_FACTOR = 0.5;
const NONLINEAR_MAX_LOAD_STEPS = 256;
const NONLINEAR_CONTINUATION_TARGET_ITERATIONS = 6;
const NONLINEAR_CONTINUATION_TARGET_LINE_SEARCH_SCALE = 0.9;
const NONLINEAR_CONTINUATION_ITERATION_EXPONENT = 0.5;
const NONLINEAR_CONTINUATION_LINE_SEARCH_EXPONENT = 0.25;
const LINEAR_SOLVE_HISTORY_CAP = 500;
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

// CPU f64 is the only active linear-algebra backend until the new GPU
// resident double-single pipeline is built. The two records below are
// kept so the run record (and any UI) has a stable shape — when the new
// pipeline lands they will report `'gpu-resident-ds'`.
const activeBackendInfo = { name: 'cpu-f64', reason: 'cpu-only' };
const activeBackendRuntimeWarnings = [];

// Sparse matrix-vector product with compensated (Kahan) accumulation.
// CSR rows carry `{ indices: Int32Array, values: Float64Array, diag, ... }`.
// All Krylov solvers in the CPU pipeline use this as their single matvec.
// `sparseMatVec` is async only because the future GPU dispatch will be
// async; today the implementation is synchronous f64 throughout.
async function sparseMatVec(rows, vector) {
  return sparseMatVecFallback(rows, vector);
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
  const selfCoef = new Float64Array(n);
  const prevCoef = new Float64Array(n);
  const nextCoef = new Float64Array(n);
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

// Krylov preconditioner is always nodal block-Jacobi 2×2. The Schwarz
// option used to live here as an additional layer; in practice block-
// Jacobi was the right default for the problem sizes the deformation
// solver targets, and the Schwarz path required extra plumbing
// (partition-of-unity, GPU flattening, fallback chain) that complicated
// every dispatch decision. Removed in favour of a single, predictable
// preconditioner path.
function buildKrylovPreconditioner(rows, options = {}) {
  return buildBlockJacobiPreconditioner(rows, options?.freeDofs || null);
}

function flattenKrylovPreconditionerForResidentGpu(rows, options = {}) {
  return {
    preconditioner: flattenBlockJacobiPreconditioner(buildKrylovPreconditioner(rows, options)),
    label: 'nodal-block-jacobi'
  };
}

export function applyKrylovPreconditioner(precond, r, z) {
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

function decorateLinearSolveResult(result, metadata = {}) {
  const residualNorm = Number(result?.residualNorm) || 0;
  const trueResidualNorm = Number.isFinite(Number(result?.trueResidualNorm))
    ? Number(result.trueResidualNorm)
    : residualNorm;
  const path = metadata.path || result?.path || 'cpu-f64';
  const defaultPrecision = { vector: 'f64', matrix: 'f64', reductions: 'f64', material: 'cpu-f64' };
  return {
    ...result,
    solver: metadata.solver || result?.solver || 'unknown',
    path,
    preconditioner: metadata.preconditioner || result?.preconditioner || 'nodal-block-jacobi',
    precision: metadata.precision || result?.precision || defaultPrecision,
    trueResidualNorm,
    usedTrueResidualAcceptance: result?.usedTrueResidualAcceptance === true || metadata.usedTrueResidualAcceptance === true,
    acceptedInTrueResidualBand: result?.acceptedInTrueResidualBand === true || metadata.acceptedInTrueResidualBand === true,
    trueResidualBandFactor: Number.isFinite(Number(result?.trueResidualBandFactor))
      ? Number(result.trueResidualBandFactor)
      : (Number.isFinite(Number(metadata.trueResidualBandFactor)) ? Number(metadata.trueResidualBandFactor) : null),
    trueResidualSkipped: result?.trueResidualSkipped === true || metadata.trueResidualSkipped === true,
    fallbackReason: metadata.fallbackReason || result?.fallbackReason || '',
    previousPath: metadata.previousPath || result?.previousPath || ''
  };
}

function summarizeLinearSolveResult(result = {}) {
  const residualNorm = Number(result.residualNorm) || 0;
  const trueResidualNorm = Number.isFinite(Number(result.trueResidualNorm))
    ? Number(result.trueResidualNorm)
    : residualNorm;
  return {
    solver: result.solver || 'unknown',
    path: result.path || 'cpu-f64',
    preconditioner: result.preconditioner || 'unknown',
    precision: result.precision || null,
    converged: result.converged === true,
    iterations: Math.max(Math.round(Number(result.iterations) || 0), 0),
    residualNorm,
    trueResidualNorm,
    relativeResidual: Number(result.relativeResidual) || 0,
    toleranceTarget: Number(result.toleranceTarget) || 0,
    usedTrueResidualAcceptance: result.usedTrueResidualAcceptance === true,
    acceptedInTrueResidualBand: result.acceptedInTrueResidualBand === true,
    trueResidualBandFactor: Number.isFinite(Number(result.trueResidualBandFactor)) ? Number(result.trueResidualBandFactor) : null,
    trueResidualSkipped: result.trueResidualSkipped === true,
    fallbackReason: result.fallbackReason || '',
    previousPath: result.previousPath || ''
  };
}

function aggregateLinearSolveHistory(...histories) {
  const flat = histories.flat().filter(Boolean);
  const countsByPath = {};
  const countsBySolver = {};
  const fallbackReasons = [];
  let totalIterations = 0;
  let worstTrueResidualMismatch = 0;
  for (const item of flat) {
    const path = item.path || 'cpu-f64';
    const solver = item.solver || 'unknown';
    countsByPath[path] = (countsByPath[path] || 0) + 1;
    countsBySolver[solver] = (countsBySolver[solver] || 0) + 1;
    totalIterations += Number(item.iterations) || 0;
    const residual = Number(item.residualNorm) || 0;
    const trueResidual = Number.isFinite(Number(item.trueResidualNorm)) ? Number(item.trueResidualNorm) : residual;
    worstTrueResidualMismatch = Math.max(worstTrueResidualMismatch, Math.abs(trueResidual - residual));
    if (item.fallbackReason) fallbackReasons.push(item.fallbackReason);
  }
  const primaryPath = Object.entries(countsByPath)
    .sort((left, right) => right[1] - left[1])[0]?.[0] || 'cpu-f64';
  return {
    solveCount: flat.length,
    countsByPath,
    countsBySolver,
    primaryPath,
    totalIterations,
    fallbackReasons: [...new Set(fallbackReasons)],
    worstTrueResidualMismatch,
    perSolve: flat
  };
}

// Dispatchers. CPU f64 is the only active path until the new GPU resident
// pipeline lands; both dispatchers are thin wrappers that decorate the
// solver result with a stable `path: 'cpu-f64'` label so the run record
// shape stays unchanged.
async function solveCgDispatched(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options = {}) {
  return decorateLinearSolveResult(
    await solveCg(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options),
    { solver: 'cg', path: 'cpu-f64', preconditioner: 'nodal-block-jacobi' }
  );
}

// =============================================================================
// New GPU resident pipeline router for the elastic gravity solve.
//
// Returns either:
//   - a CG-shaped result object  ({ solution, converged, iterations,
//     residualNorm, ...}, decorated with path: 'gpu-resident-elastic'), or
//   - null if the GPU path is not requested or not available, in which case
//     the caller routes to the CPU CG.
//
// All errors are caught and logged to the warnings array; this function
// never throws.
// =============================================================================
async function tryGpuElasticGravitySolve({
  options, mesh, elementCaches, regionConstitutiveByRegion,
  fixedValues, bFreeF64, porePressureByIntegrationPoint, warnings
}) {
  if (options?.useNewGpuPipeline !== true) return null;
  let device = null;
  try {
    const probe = await gpuProbeGpuPipeline();
    if (!probe?.available) {
      pushUniqueWarning(warnings, `New GPU pipeline requested but unavailable (${probe?.reason || 'unknown'}); using CPU.`);
      return null;
    }
    device = probe.device;
    const gpuResult = await gpuRunDeformationOnGpu({
      device,
      mesh,
      elementCaches,
      regionConstitutiveByRegion,
      fixedDofSet: new Set(fixedValues.keys()),
      bF64: bFreeF64,
      porePressureByIntegrationPoint,
      cgOptions: {
        maxIter: MAX_CG_ITER,
        relTol: CG_REL_TOL,
        absTol: CG_ABS_TOL
      },
      warnings
    });
    if (!gpuResult?.converged) {
      pushUniqueWarning(warnings, 'New GPU pipeline elastic CG did not converge; falling back to CPU.');
      return null;
    }
    return decorateLinearSolveResult(
      {
        solution: gpuResult.uFreeF64,
        converged: true,
        iterations: gpuResult.iterations,
        residualNorm: gpuResult.residualNorm,
        relativeResidual: gpuResult.relativeResidual ?? 0,
        rhsNorm: 0,
        toleranceTarget: 0,
        interrupted: false
      },
      {
        solver: 'cg',
        path: 'gpu-resident-elastic',
        preconditioner: 'nodal-block-jacobi-ds',
        gpuDiagnostics: gpuResult.diagnostics
      }
    );
  } catch (err) {
    pushUniqueWarning(warnings, `New GPU pipeline elastic CG failed: ${err?.message || err}; falling back to CPU.`);
    return null;
  }
}

async function solveGmresDispatched(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options = {}) {
  return decorateLinearSolveResult(
    await solveGmresScaled(rows, rhs, initial, maxIter, relTol, absTol, runControl, iterationObserver, options),
    { solver: 'gmres', path: 'cpu-f64', preconditioner: 'nodal-block-jacobi' }
  );
}

async function solveCg(rows, rhs, initial = null, maxIter = MAX_CG_ITER, relTol = CG_REL_TOL, absTol = CG_ABS_TOL, runControl = null, iterationObserver = null, options = {}) {
  const matvec = (rs, v) => Promise.resolve(sparseMatVecFallback(rs, v));
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
    const ax = await matvec(rows, x);
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
  const preconditionerName = 'nodal-block-jacobi';
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
      interrupted: false,
      preconditioner: preconditionerName
    };
  }
  await runCheckpoint(runControl, true);

  for (let iter = 1; iter <= maxIter; iter += 1) {
    const ap = await matvec(rows, p);
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
        interrupted: false,
        preconditioner: preconditionerName
      };
    }
    const alpha = rzOld / denom;
    for (let i = 0; i < n; i += 1) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
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
        interrupted: false,
        preconditioner: preconditionerName
      };
    }
    applyKrylovPreconditioner(precond, r, z);
    const rzNew = dot(r, z);
    const beta = Math.abs(rzOld) > CG_NUMERIC_EPS ? rzNew / rzOld : 0;
    for (let i = 0; i < n; i += 1) p[i] = z[i] + beta * p[i];
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
        interrupted: true,
        preconditioner: preconditionerName
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
    interrupted: false,
    preconditioner: preconditionerName
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
  // CPU f64 matvec is the only path. The new GPU resident pipeline (when
  // it lands) replaces this entire solver function with a resident GMRES
  // kernel; until then there is no hybrid.
  const matvec = (rs, v) => Promise.resolve(sparseMatVecFallback(rs, v));
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
  const preconditionerName = 'nodal-block-jacobi';
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
      interrupted: false,
      preconditioner: preconditionerName
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
        interrupted: false,
        preconditioner: preconditionerName
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
          interrupted: true,
          preconditioner: preconditionerName
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
          interrupted: false,
          preconditioner: preconditionerName
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
    interrupted: false,
    preconditioner: preconditionerName
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

function buildDeformationElementCaches(mesh, options = {}) {
  const elementType = normalizeElementType(mesh?.elementType);
  const kernel = elementKernelFor(elementType);
  // B-bar projection for T6 is *opt-in*. T3 has a single Gauss point per
  // element so volumetric locking is impossible there — the transform is
  // never applied to T3 regardless of the option. For T6, B-bar correctly
  // mitigates plastic-incompressibility locking (ψ → 0 cases) at the cost
  // of (a) slightly worse Krylov conditioning from the relaxed volumetric
  // constraint introducing small eigenvalues in the assembled tangent, and
  // (b) bypassing the GPU element-kernel fast path because the packed
  // buffers ship with the standard B. Both are acceptable when the
  // engineer explicitly chooses correctness over speed for incompressible
  // problems; neither should fire silently. Default is off, matching the
  // v0.5.0 behaviour (T3 unchanged, T6 also unchanged unless explicitly
  // opted in via `options.useBBarFormulationT6: true`).
  const useBBarT6 = elementType === 't6' && options?.useBBarFormulationT6 === true;
  let integrationPointCount = 0;
  const caches = mesh.elements.map((element, elementIndex) => {
    const nodes = element.map((nodeId) => mesh.nodes[nodeId]);
    const corners = element.slice(0, 3).map((nodeId) => mesh.nodes[nodeId]);
    const area = triangleArea(corners);
    const centroid = mesh.elementData[elementIndex]?.centroid || mesh.cells[mesh.elementCell[elementIndex]]?.centroid || {
      x: (corners[0].x + corners[1].x + corners[2].x) / 3,
      y: (corners[0].y + corners[1].y + corners[2].y) / 3
    };
    const gaussPoints = kernel.gaussPointsXY(corners);
    const standardBs = gaussPoints.map((gp) => kernel.buildBAtGauss(corners, gp.L1, gp.L2, gp.L3));
    let resolvedBs = standardBs;
    if (useBBarT6) {
      const detJ = 2 * area;
      const weights = gaussPoints.map((gp) => (Number(gp.w) || 0) * detJ);
      resolvedBs = T6BarTransform(standardBs, weights);
    }
    const integrationPoints = gaussPoints.map((gp, gpIndex) => {
      const globalIndex = integrationPointCount;
      integrationPointCount += 1;
      return {
        ...gp,
        gpIndex,
        globalIndex,
        materialPointIndex: globalIndex,
        areaWeight: area * (Number(gp.areaWeightFactor) || 1),
        B: resolvedBs[gpIndex]
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
      // Cache B (or B-bar) per GP so the kernel-level stiffness / internal-
      // force functions reuse the same matrices the strain path uses. This
      // is the variational-consistency contract for B-bar: ε, F_int and K
      // must all integrate the same B across the element.
      bMatricesPerGp: resolvedBs,
      useBBar: useBBarT6,
      centroid,
      integrationPoints,
      dofs: Int32Array.from(elementDofMap(element)),
      freeRowIndices: null,
      assemblyLocalSlots: null
    };
  });
  caches.integrationPointCount = integrationPointCount;
  caches.useBBarT6 = useBBarT6;
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

function isEffectiveStress6McAdmissible(stress6, materialParameters) {
  const mc = mohrCoulombIndicator3D(stress6, materialParameters);
  const tolerance = mcYieldToleranceForStress(stress6, materialParameters);
  return Number.isFinite(Number(mc?.F)) && Number(mc.F) <= tolerance;
}

function buildK0ControlledInitialEffectiveStress6(totalStress6, materialParameters, porePressure = 0, options = {}) {
  // Seed normal stresses are K0-controlled:
  //   σ′ = (σ′_h, σ′_v, σ′_h, τ_xy, 0, 0), with σ′_h = K0 σ′_v.
  //
  // The shear component is slope-aware but admissibility-limited. The
  // elastic gravity recovery supplies a target τ_xy that carries the global
  // equilibrium shear demanded by sloping terrain. We keep as much of that
  // shear as the exact Mohr-Coulomb + tension envelope permits. If the full
  // target would violate the material envelope, a monotone bisection finds
  // the largest scale λ ∈ [0, 1] such that the seed remains admissible.
  //
  // This is intentionally not a plastic correction. It is a statically better
  // elastic/K0 predictor that reduces the artificial residual the nil-step
  // has to equilibrate. The subsequent plastic geostatic phase still owns
  // the final self-weight equilibrium.
  const totalStress = totalStress6ToCompressionPositiveStress3D(totalStress6);
  const u0 = Math.max(Number(porePressure) || 0, 0);
  const sigmaV0Eff = Math.max(totalStress.syy - u0, 0);
  const K0 = Number.isFinite(Number(materialParameters?.K0nc))
    ? Math.max(Number(materialParameters.K0nc), 0)
    : fallbackK0(materialParameters?.phiEffDeg);
  const sigmaH0Eff = K0 * sigmaV0Eff;
  const baseStress6 = [
    -sigmaH0Eff,
    -sigmaV0Eff,
    -sigmaH0Eff,
    0,
    0,
    0
  ];
  const targetShear6 = Number(options?.targetShearStress6);
  const shearTol = Math.max(
    1e-10 * Math.max(Math.abs(sigmaV0Eff), Math.abs(sigmaH0Eff), Math.abs(Number(materialParameters?.cEff) || 0), 1),
    1e-12
  );
  const baseAdmissible = isEffectiveStress6McAdmissible(baseStress6, materialParameters);
  const diagnostics = {
    baseAdmissible,
    targetShear6: Number.isFinite(targetShear6) ? targetShear6 : 0,
    keptShear6: 0,
    shearScale: 0,
    fullTargetAdmissible: false,
    clipped: false,
    inadmissibleAfterClip: !baseAdmissible
  };

  if (!baseAdmissible || !Number.isFinite(targetShear6) || Math.abs(targetShear6) <= shearTol) {
    return { stress6: baseStress6, diagnostics };
  }

  const fullStress6 = baseStress6.slice();
  fullStress6[3] = targetShear6;
  if (isEffectiveStress6McAdmissible(fullStress6, materialParameters)) {
    diagnostics.keptShear6 = targetShear6;
    diagnostics.shearScale = 1;
    diagnostics.fullTargetAdmissible = true;
    return { stress6: fullStress6, diagnostics };
  }

  let lo = 0;
  let hi = 1;
  const trial = baseStress6.slice();
  for (let iter = 0; iter < 48; iter += 1) {
    const mid = 0.5 * (lo + hi);
    trial[3] = mid * targetShear6;
    if (isEffectiveStress6McAdmissible(trial, materialParameters)) lo = mid;
    else hi = mid;
  }

  const clippedStress6 = baseStress6.slice();
  clippedStress6[3] = lo * targetShear6;
  const clippedAdmissible = isEffectiveStress6McAdmissible(clippedStress6, materialParameters);
  diagnostics.keptShear6 = clippedStress6[3];
  diagnostics.shearScale = lo;
  diagnostics.clipped = true;
  diagnostics.inadmissibleAfterClip = !clippedAdmissible;
  if (!clippedAdmissible) {
    return { stress6: baseStress6, diagnostics: { ...diagnostics, keptShear6: 0, shearScale: 0 } };
  }
  return { stress6: clippedStress6, diagnostics };
}

function mcYieldToleranceForStress(stress6, materialParameters) {
  return mcTolerance(materialParameters, mohrCoulombIndicator3D(stress6, materialParameters));
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

// The pipeline has exactly two initial-stress methods:
//   * 'auto' — elastic gravity-step CG followed by K0-controlled stress
//     recovery. Works for flat *and* sloping ground by construction. The
//     elastic solution gives global equilibrium; the recovery yields a
//     K0 admissible state per Gauss point and keeps the largest admissible
//     part of the recovered slope shear. The plastic correction then solves
//     the remaining self-weight residual.
//   * 'gravity-ramp' — zero-stress seed, plastic Newton ramps gravity from
//     λ = 0. Used when starting from a genuine zero-stress state is
//     required (rarely; mostly for construction-stage analyses).
// Every other historical method string maps onto 'auto' for backward
// compatibility with the UI dropdown and existing run records. The
// previous direct-k0 / admissible-k0 / k0-nil-step / sequential-deposition
// / field-stress workflows are gone — they were special cases or
// heuristics that the single elastic-recovery path subsumes cleanly.
const GEOSTATIC_INITIALIZATION_METHODS = new Set([
  'auto',
  'gravity-ramp'
]);

function normalizeGeostaticInitializationMethod(raw) {
  const value = String(raw || 'auto').trim().toLowerCase().replace(/_/g, '-');
  switch (value) {
    case 'gravity':
    case 'gravity-loading':
    case 'gravity-ramp':
    case 'self-weight-ramp':
      return 'gravity-ramp';
    default:
      return 'auto';
  }
}

function buildInitialPhaseStateFields(kind, options = {}) {
  const initialStateKind = [
    'stress-only-reference',
    'equilibrated-self-weight',
    'partial-geostatic',
    'failed'
  ].includes(kind) ? kind : 'failed';
  const equilibriumConverged = options?.equilibriumConverged === true || initialStateKind === 'equilibrated-self-weight';
  const stressOnlyReference = options?.stressOnlyReference === true || initialStateKind === 'stress-only-reference';
  const referenceAccepted = options?.referenceAccepted === true || equilibriumConverged || stressOnlyReference;
  const canStartService = options?.canStartService != null
    ? options.canStartService === true
    : (equilibriumConverged || stressOnlyReference);
  const canStartSafety = equilibriumConverged === true && initialStateKind === 'equilibrated-self-weight';
  return {
    initialStateKind,
    referenceAccepted,
    equilibriumConverged,
    stressOnlyReference,
    canStartService,
    canStartSafety,
    auditResidualNorm: Number.isFinite(Number(options?.auditResidualNorm)) ? Number(options.auditResidualNorm) : null,
    auditRelativeResidual: Number.isFinite(Number(options?.auditRelativeResidual)) ? Number(options.auditRelativeResidual) : null,
    auditWithinTolerance: options?.auditWithinTolerance == null ? null : options.auditWithinTolerance === true
  };
}

function classifyInitialPhaseStateKind(phase) {
  if (phase?.converged === true) return 'equilibrated-self-weight';
  if ((Number(phase?.loadFactorCommitted) || 0) > 0) return 'partial-geostatic';
  return 'failed';
}

function decorateInitialPhaseState(phase, kind = null, options = {}) {
  const stateKind = kind || classifyInitialPhaseStateKind(phase);
  const state = buildInitialPhaseStateFields(stateKind, {
    referenceAccepted: options?.referenceAccepted,
    equilibriumConverged: options?.equilibriumConverged,
    stressOnlyReference: options?.stressOnlyReference,
    canStartService: options?.canStartService,
    auditResidualNorm: options?.auditResidualNorm ?? phase?.residualNorm,
    auditRelativeResidual: options?.auditRelativeResidual ?? phase?.relativeResidualNorm,
    auditWithinTolerance: options?.auditWithinTolerance
      ?? (phase?.converged === true ? true : null)
  });
  return {
    ...phase,
    ...state,
    converged: state.equilibriumConverged === true
  };
}

function resolveGeostaticInitializationWorkflow(model, options = {}, analysisType = 'deformation') {
  // Two methods only:
  //   * 'gravity-ramp' — zero stress + plastic Newton ramp (specialised)
  //   * 'auto'        — elastic gravity-step CG + K0 recovery (everything else)
  // The plastic correction phase runs when an equilibrated self-weight
  // state is required (safety-cphi, plastic-geostatic mode, gravity-ramp).
  // For stress-only deformation queries the audited K0 field is the
  // reference and no Newton solve runs.
  const requestedMethod = normalizeGeostaticInitializationMethod(options?.geostaticInitializationMethod);
  const hasSlopeOrWall = modelHasSteepSlopeOrWalls(model);
  const wantsEquilibratedStart = analysisType === 'safety-cphi'
    || options?.initialStressMode === 'plastic-geostatic';
  if (requestedMethod === 'gravity-ramp') {
    return {
      requestedMethod,
      method: 'gravity-ramp',
      seedMode: 'zero-stress',
      runPlasticCorrection: true,
      stressOnlyReference: false,
      requiresEquilibratedStart: analysisType === 'safety-cphi',
      hasSlopeOrWall,
      reason: 'Pure gravity loading from a zero-stress state.'
    };
  }
  return {
    requestedMethod,
    method: 'elastic-k0-recovery',
    seedMode: 'elastic-k0-recovery',
    runPlasticCorrection: wantsEquilibratedStart,
    stressOnlyReference: !wantsEquilibratedStart,
    requiresEquilibratedStart: analysisType === 'safety-cphi',
    hasSlopeOrWall,
    reason: wantsEquilibratedStart
      ? 'Elastic gravity-step CG with slope-aware K0 stress recovery; plastic Newton correction equilibrates the K0 nil-step.'
      : 'Elastic gravity-step CG with slope-aware K0 stress recovery; audited stress-only in-situ reference.'
  };
}

function buildZeroInitialEffectiveStressFieldForIntegrationPoints(elementCaches) {
  const count = elementCaches.integrationPointCount || elementCaches.length || 0;
  return Array.from({ length: count }, () => [0, 0, 0, 0, 0, 0]);
}

function initialStressFieldHasInvalidStress(initialField) {
  return (initialField || []).some((stress6) => !Array.isArray(stress6) || stress6.some((value) => !Number.isFinite(Number(value))));
}

function createSlopeAwareSeedDiagnostics() {
  return {
    method: 'elastic-k0-recovery-with-admissible-shear',
    pointCount: 0,
    shearTargetPointCount: 0,
    shearKeptFullCount: 0,
    shearClippedCount: 0,
    shearDiscardedCount: 0,
    baseInadmissibleCount: 0,
    inadmissibleAfterClipCount: 0,
    maxAbsTargetShear: 0,
    maxAbsKeptShear: 0,
    minNonzeroShearScale: 1,
    averageShearScale: 0
  };
}

function recordSlopeAwareSeedDiagnostic(summary, diagnostic) {
  if (!summary || !diagnostic) return;
  summary.pointCount += 1;
  const target = Number(diagnostic.targetShear6) || 0;
  const kept = Number(diagnostic.keptShear6) || 0;
  const absTarget = Math.abs(target);
  const absKept = Math.abs(kept);
  const scale = Number(diagnostic.shearScale) || 0;
  summary.maxAbsTargetShear = Math.max(summary.maxAbsTargetShear, absTarget);
  summary.maxAbsKeptShear = Math.max(summary.maxAbsKeptShear, absKept);
  summary.averageShearScale += scale;
  if (diagnostic.baseAdmissible === false) summary.baseInadmissibleCount += 1;
  if (diagnostic.inadmissibleAfterClip === true) summary.inadmissibleAfterClipCount += 1;
  if (absTarget > 1e-12) {
    summary.shearTargetPointCount += 1;
    if (diagnostic.fullTargetAdmissible === true) {
      summary.shearKeptFullCount += 1;
    } else if (diagnostic.clipped === true && absKept > 1e-12) {
      summary.shearClippedCount += 1;
      summary.minNonzeroShearScale = Math.min(summary.minNonzeroShearScale, Math.max(scale, 0));
    } else {
      summary.shearDiscardedCount += 1;
    }
  }
}

function finalizeSlopeAwareSeedDiagnostics(summary) {
  if (!summary || !(summary.pointCount > 0)) return summary || null;
  summary.averageShearScale /= summary.pointCount;
  if (summary.minNonzeroShearScale === 1 && summary.shearClippedCount === 0) {
    summary.minNonzeroShearScale = null;
  }
  return summary;
}

function recoverInitialFieldFromGeostaticSolution(mesh, elementCaches, model, Ugeo, regionConstitutiveByRegion, options, porePressureByIntegrationPoint, warnings) {
  // Single K0-controlled recovery, applied identically for flat and sloping
  // ground. The elastic gravity-step CG solution gives a globally equilibrated
  // predictor; from it we recover σ′_v and the slope shear target τ_xy. The
  // seed then enforces K0 normal stresses while retaining the largest
  // Mohr-Coulomb-admissible part of the recovered shear. Flat ground naturally
  // reduces to the standard zero-shear K0 seed because the recovered target
  // shear is zero apart from roundoff.
  const out = new Array(elementCaches.integrationPointCount || elementCaches.length);
  const seedDiagnostics = createSlopeAwareSeedDiagnostics();
  const precomputedStrainFlat = null;
  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const cell = mesh.cells[elementCache.cellIndex];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    for (const gp of elementCache.integrationPoints || []) {
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
      const recoveredStress6 = response.update?.stressTrial6;
      const u0 = Math.max(Number(porePressureByIntegrationPoint?.[gp.globalIndex]) || 0, 0);
      const seed = buildK0ControlledInitialEffectiveStress6(
        recoveredStress6,
        constitutive.materialParameters,
        u0,
        {
          targetShearStress6: recoveredStress6?.[3]
        }
      );
      out[gp.globalIndex] = seed.stress6;
      recordSlopeAwareSeedDiagnostic(seedDiagnostics, seed.diagnostics);
    }
  }
  return { initialField: out, seedDiagnostics: finalizeSlopeAwareSeedDiagnostics(seedDiagnostics) };
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
  const workflow = resolveGeostaticInitializationWorkflow(model, options, options?.analysisType);
  const samplePluginForWorkflow = (() => {
    for (const c of regionConstitutiveByRegion.values()) {
      if (c?.materialModel?.capabilities) return c.materialModel;
    }
    return null;
  })();

  // 'gravity-ramp' is the one specialised path that bypasses the elastic
  // predictor: it starts from a genuine zero-stress state and asks the
  // plastic Newton phase to ramp gravity from λ = 0. Only available for
  // material models that advertise plastic geostatic support.
  if (workflow.method === 'gravity-ramp') {
    if (samplePluginForWorkflow?.capabilities?.supportsPlasticGeostaticPhase !== true) {
      throw new Error(
        `Gravity-ramp initialization requires a material model that supports plastic geostatic equilibration. The active material "${samplePluginForWorkflow?.displayName || 'unknown'}" does not. Choose the default initialization or switch to a plastic material model.`
      );
    }
    onProgress({
      stage: 'solving',
      percent: 66,
      message: 'Preparing a zero-stress state for staged gravity loading...'
    });
    return {
      initialField: buildZeroInitialEffectiveStressFieldForIntegrationPoints(elementCaches),
      mode: 'gravity-ramp-zero-stress',
      seedMode: 'zero-stress',
      workflow,
      seedDiagnostics: null,
      iterations: 0,
      residualNorm: 0,
      linearSolveHistory: [],
      solution: new Float64Array(ndof)
    };
  }

  // Default elegant unified path: solve the elastic gravity step once with
  // CG (block-Jacobi 2×2 preconditioned), recover the K0-controlled stress
  // field at every Gauss point. Works identically for flat and sloping
  // ground — the elastic solution carries any slope effects, and the recovery
  // keeps the largest MC-admissible part of that shear while enforcing K0
  // normal stresses.
  onProgress({
    stage: 'solving',
    percent: 64,
    message: 'Solving the elastic gravity step for the initial stress field...'
  });
  // New GPU resident pipeline (engineer-controlled).  Tries the GPU first;
  // any failure (no WebGPU, kernel compile error, runtime error, non-
  // convergence) silently falls back to the CPU CG path.  When the GPU
  // path succeeds the result is shape-identical to solveCgDispatched.
  let geostaticCg = await tryGpuElasticGravitySolve({
    options,
    mesh,
    elementCaches,
    regionConstitutiveByRegion,
    fixedValues,
    bFreeF64: gravityCompressedRhs,
    porePressureByIntegrationPoint,
    warnings
  });
  if (!geostaticCg) {
    geostaticCg = await solveCgDispatched(
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
          message: `Elastic gravity step... CG iter ${iterations.toLocaleString()}, relative residual ${relativeResidual.toExponential(2)}`
        });
        await runCheckpoint(runControl);
      },
      { freeDofs }
    );
  }
  if (geostaticCg.interrupted) {
    throw new Error('Deformation run was interrupted before geostatic initialization became available.');
  }
  // The elastic step uses linear-elastic stiffness and Dirichlet BCs from
  // the mesh; non-convergence is essentially impossible for a well-posed
  // mesh and indicates a numerical anomaly. Surface it as a warning and
  // fall back to a hydrostatic K0 reference at every Gauss point so the
  // run still produces an audited stress-only state.
  if (!geostaticCg.converged) {
    if (options?.analysisType === 'safety-cphi') {
      throw new Error(
        `Elastic gravity-step initialization did not converge (residual ${geostaticCg.residualNorm.toExponential(2)} after ${geostaticCg.iterations} iterations). Safety analysis cannot proceed.`
      );
    }
    pushUniqueWarning(
      warnings,
      `Elastic gravity-step initialization did not converge (residual ${geostaticCg.residualNorm.toExponential(2)} after ${geostaticCg.iterations} iterations); falling back to hydrostatic K0 in-situ reference.`
    );
    return {
      initialField: buildFlatK0InitialEffectiveStressFieldForIntegrationPoints(mesh, elementCaches, model, options, warnings),
      mode: 'flat-k0-fallback',
      seedMode: 'flat-k0-fallback',
      workflow: { ...workflow, method: 'flat-k0-fallback', seedMode: 'flat-k0-fallback', runPlasticCorrection: false, stressOnlyReference: true },
      seedDiagnostics: null,
      iterations: geostaticCg.iterations,
      residualNorm: geostaticCg.residualNorm,
      linearSolveHistory: [{ ...summarizeLinearSolveResult(geostaticCg), phaseKind: 'geostatic-predictor' }],
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
  const seedDiagnostics = recoveredInitial.seedDiagnostics;
  if (seedDiagnostics?.shearTargetPointCount > 0) {
    if ((Number(seedDiagnostics.shearClippedCount) || 0) > 0 || (Number(seedDiagnostics.shearDiscardedCount) || 0) > 0) {
      pushUniqueWarning(
        warnings,
        `Slope-aware K0 seed: recovered elastic gravity shear was clipped to the exact Mohr-Coulomb envelope at ${seedDiagnostics.shearClippedCount || 0} integration point(s) and discarded at ${seedDiagnostics.shearDiscardedCount || 0} point(s). The initial plastic self-weight phase will equilibrate only the remaining residual.`
      );
    }
    if ((Number(seedDiagnostics.inadmissibleAfterClipCount) || 0) > 0) {
      pushUniqueWarning(
        warnings,
        `Slope-aware K0 seed: ${seedDiagnostics.inadmissibleAfterClipCount} integration point(s) remained inadmissible after shear clipping. These points will be projected by the material plugin if predictor projection is available.`
      );
    }
  }
  if (initialStressFieldHasInvalidStress(initialField)) {
    if (options?.analysisType === 'safety-cphi') {
      throw new Error('Elastic gravity-step initialization produced an invalid stress state. Safety analysis cannot proceed.');
    }
    pushUniqueWarning(
      warnings,
      'Elastic gravity-step initialization produced an invalid stress state; falling back to hydrostatic K0 in-situ reference.'
    );
    return {
      initialField: buildFlatK0InitialEffectiveStressFieldForIntegrationPoints(mesh, elementCaches, model, options, warnings),
      mode: 'flat-k0-fallback',
      seedMode: 'flat-k0-fallback',
      workflow: { ...workflow, method: 'flat-k0-fallback', seedMode: 'flat-k0-fallback', runPlasticCorrection: false, stressOnlyReference: true },
      seedDiagnostics: null,
      iterations: geostaticCg.iterations,
      residualNorm: geostaticCg.residualNorm,
      linearSolveHistory: [{ ...summarizeLinearSolveResult(geostaticCg), phaseKind: 'geostatic-predictor' }],
      solution: new Float64Array(ndof)
    };
  }

  return {
    initialField,
      mode: 'slope-aware-elastic-k0-recovery',
      seedMode: 'slope-aware-elastic-k0-recovery',
    workflow,
    seedDiagnostics,
    iterations: geostaticCg.iterations,
    residualNorm: geostaticCg.residualNorm,
    linearSolveHistory: [{ ...summarizeLinearSolveResult(geostaticCg), phaseKind: 'geostatic-predictor' }],
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

function buildStallDiagnostics(phase, materialPoints, model, options = {}) {
  const yieldingByBand = NEAR_SURFACE_DEPTH_BANDS.map((band) => ({
    label: band.label,
    max: band.max,
    totalCount: 0,
    yieldingCount: 0,
    tensionCutoffCount: 0,
    plasticGpCount: 0,
    maxAccumulatedPlasticStrain: 0,
    maxEtaMc: 0
  }));
  let yieldingTotal = 0;
  let yieldingMaxBandIndex = -1;
  let yieldingMaxBandCount = 0;
  let plasticTotal = 0;
  let maxAccumulatedPlasticStrain = 0;
  let maxEtaMcOverall = 0;
  let yieldingPointXSum = 0;
  let yieldingPointYSum = 0;
  let yieldingPointWeight = 0;

  for (let index = 0; index < (materialPoints?.length || 0); index += 1) {
    const mp = materialPoints[index];
    if (!mp) continue;
    const point = mp.point || mp.gp || null;
    if (!point) continue;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const depth = model ? depthBelowTerrainAt(model, x, y) : Number.POSITIVE_INFINITY;
    const bandIndex = bandIndexForDepth(depth);
    const band = yieldingByBand[bandIndex];
    if (band) band.totalCount += 1;
    const trial = mp.trialState || mp.committedState || {};
    const eta = Number(trial?.etaMcCurrent) || 0;
    const accPlastic = Number(trial?.accumulatedPlasticStrain) || 0;
    const isYielding = trial?.currentlyMcActive === true || eta >= 0.999;
    const isTension = trial?.activeYieldSurface === 'TENSION';
    const isPlasticActive = isYielding || (accPlastic > 0);
    if (band) {
      if (isYielding) band.yieldingCount += 1;
      if (isTension) band.tensionCutoffCount += 1;
      if (isPlasticActive) band.plasticGpCount += 1;
      band.maxAccumulatedPlasticStrain = Math.max(band.maxAccumulatedPlasticStrain, accPlastic);
      band.maxEtaMc = Math.max(band.maxEtaMc, eta);
    }
    if (isYielding) {
      yieldingTotal += 1;
      yieldingPointXSum += x;
      yieldingPointYSum += y;
      yieldingPointWeight += 1;
    }
    if (isPlasticActive) plasticTotal += 1;
    maxAccumulatedPlasticStrain = Math.max(maxAccumulatedPlasticStrain, accPlastic);
    maxEtaMcOverall = Math.max(maxEtaMcOverall, eta);
  }

  for (let bIndex = 0; bIndex < yieldingByBand.length; bIndex += 1) {
    if (yieldingByBand[bIndex].yieldingCount > yieldingMaxBandCount) {
      yieldingMaxBandCount = yieldingByBand[bIndex].yieldingCount;
      yieldingMaxBandIndex = bIndex;
    }
  }

  const dominantBand = yieldingMaxBandIndex >= 0 ? yieldingByBand[yieldingMaxBandIndex] : null;
  const yieldingCentroid = yieldingPointWeight > 0
    ? { x: yieldingPointXSum / yieldingPointWeight, y: yieldingPointYSum / yieldingPointWeight }
    : null;

  // Mechanism heuristic from the depth distribution of yielding GPs:
  //  - if 70%+ of yielding GPs are within the shallow two bands and the
  //    spread is short along x, classify as "surface-parallel sliding"
  //  - if yielding spans multiple depth bands and is centroidal, classify
  //    as "deep rotational" (Bishop-style)
  //  - otherwise "mixed/wedge"
  const shallowYielding = (yieldingByBand[0]?.yieldingCount || 0) + (yieldingByBand[1]?.yieldingCount || 0);
  const shallowFraction = yieldingTotal > 0 ? shallowYielding / yieldingTotal : 0;
  const deepYielding = (yieldingByBand[3]?.yieldingCount || 0)
    + (yieldingByBand[4]?.yieldingCount || 0)
    + (yieldingByBand[5]?.yieldingCount || 0);
  const deepFraction = yieldingTotal > 0 ? deepYielding / yieldingTotal : 0;
  let mechanism = 'unknown';
  if (yieldingTotal > 0) {
    if (shallowFraction >= 0.7) mechanism = 'surface-parallel-sliding';
    else if (deepFraction >= 0.4) mechanism = 'deep-rotational';
    else mechanism = 'mixed-wedge';
  }

  const lambdaCommitted = Math.max(Number(phase?.loadFactorCommitted) || 0, 0);
  const limitLoadEstimate = lambdaCommitted > 0 ? lambdaCommitted : null;
  const advice = [];
  if (mechanism === 'surface-parallel-sliding') {
    advice.push('Shallow yielding dominates (≥70 % of plastic GPs in the upper two depth bands). The slope is surface-parallel-failing under self-weight; check c′, φ′ and slope angle against the infinite-slope criterion at the controlling depth.');
  } else if (mechanism === 'deep-rotational') {
    advice.push('Yielding spans multiple depth bands with a deep centroid. Consider running stage6-bishop on the same geometry; FoS_Bishop will indicate whether the slope is at limit equilibrium.');
  } else if (mechanism === 'mixed-wedge') {
    advice.push('Yielding shows a mixed/wedge pattern — check for stratigraphy effects, partial undrained zones, or boundary-condition artefacts.');
  }
  if (lambdaCommitted > 0 && lambdaCommitted < 0.6) {
    advice.push(`The committed load factor stalled at ${(lambdaCommitted * 100).toFixed(1)} % of self-weight; this is consistent with a slope at or below the static-equilibrium boundary.`);
  }
  if (Number.isFinite(maxAccumulatedPlasticStrain) && maxAccumulatedPlasticStrain > 0.05) {
    advice.push(`Maximum accumulated plastic strain ${(maxAccumulatedPlasticStrain * 100).toFixed(1)} % indicates a developed failure mechanism; running deformation viewing-only may still be useful but the result is post-equilibrium.`);
  }

  return {
    converged: phase?.converged === true,
    convergenceState: phase?.convergenceState || null,
    failureCode: phase?.failureCode || null,
    failureReason: phase?.failureReason || null,
    lambdaCommitted,
    limitLoadEstimate,
    mechanism,
    yieldingTotal,
    plasticTotal,
    maxAccumulatedPlasticStrain,
    maxEtaMc: maxEtaMcOverall,
    dominantBand: dominantBand ? {
      label: dominantBand.label,
      yieldingCount: dominantBand.yieldingCount,
      totalCount: dominantBand.totalCount
    } : null,
    yieldingByBand,
    yieldingCentroid,
    shallowFraction,
    deepFraction,
    advice
  };
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

function setReferenceStateFromCommittedStates(materialPoints, referenceMode = 'equilibrated-initial') {
  materialPoints.forEach((materialPoint) => {
    setMaterialPointReferenceState(materialPoint, materialPoint.committedState, {
      referenceMode,
      materialParameters: materialPoint.materialParameters
    });
  });
}

function auditStressOnlyGeostaticReference(materialPoints, geostatic, initialPhase, options = {}) {
  const etaLimit = Math.min(Math.max(Number(options?.stressOnlyGeostaticMaxEta) || 1, 0), 1);
  const etaTolerance = etaLimit >= 1 ? 1e-6 : 1e-12;
  const acceptedSteps = Number(initialPhase?.acceptedSteps) || 0;
  const displayedFactor = Math.max(Number(initialPhase?.displayedLoadFactor) || 0, 0);
  const seedDiagnostics = geostatic?.seedDiagnostics || null;
  let pointCount = 0;
  let inadmissibleSeedCount = 0;
  let failedProjectionCount = 0;
  let activeSeedCount = 0;
  let plasticSeedCount = 0;
  let yieldBoundarySeedCount = 0;
  let maxEta = 0;

  (materialPoints || []).forEach((materialPoint) => {
    const seed = materialPoint?.predictorState || materialPoint?.referenceState || materialPoint?.committedState || null;
    if (!seed) return;
    pointCount += 1;
    if (seed.initialStateAdmissible === false) inadmissibleSeedCount += 1;
    if (seed.initialProjectionFailed === true) failedProjectionCount += 1;
    if (seed.currentlyMcActive === true || seed.activeYieldSurface !== 'NONE') activeSeedCount += 1;
    if ((Number(seed.accumulatedPlasticStrain) || 0) > 1e-12) plasticSeedCount += 1;
    const eta = Number(seed.etaMcCurrent ?? seed.initialEtaMc);
    if (Number.isFinite(eta)) {
      maxEta = Math.max(maxEta, eta);
      if (eta >= 1 - 1e-6) yieldBoundarySeedCount += 1;
    }
  });

  const clippedInadmissible = Number(seedDiagnostics?.inadmissibleAfterClipCount) || 0;
  const canUseStressOnlyReference = options?.allowStressOnlyGeostaticReference !== false
    && acceptedSteps === 0
    && displayedFactor <= 1e-10
    && clippedInadmissible === 0
    && inadmissibleSeedCount === 0
    && failedProjectionCount === 0
    && activeSeedCount === 0
    && plasticSeedCount === 0
    && maxEta <= etaLimit + etaTolerance;

  return {
    canUseStressOnlyReference,
    etaLimit,
    maxEta,
    pointCount,
    acceptedSteps,
    displayedFactor,
    clippedInadmissibleCount: clippedInadmissible,
    inadmissibleSeedCount,
    failedProjectionCount,
    activeSeedCount,
    plasticSeedCount,
    yieldBoundarySeedCount
  };
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
  const residualOnly = elementAnalysisOptions?.residualOnly === true;
  const compressedRows = residualOnly ? null : createCompressedRowsFromPattern(assemblyPattern);
  const internalForceFree = new Float64Array(loadRhsFreeBase.length);
  let activeCount = 0;
  let activeFaceCount = 0;
  let activeEdgeCount = 0;
  let activeApexCount = 0;
  let tensionPendingCount = 0;
  let changedCount = 0;
  let maxEta = 0;
  let maxStrengthReserve = 0;
  const precomputedStrainFlat = null;
  // Element-kind dispatch for the backend internal-force path. We only
  // CPU f64 assembly only. The new GPU resident pipeline (when it lands)
  // will replace this entire function with a per-element compute kernel
  // that builds K and F_int in DS arithmetic on GPU buffers.
  const stressContributionFlat = null;

  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const tangentsAtGp = residualOnly ? null : new Array(elementCache.numGaussPoints);
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
        plasticStageType: elementAnalysisOptions?.plasticStageType,
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

      if (!residualOnly) tangentsAtGp[gp.gpIndex] = response.tangent2D;
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

    if (!residualOnly) {
      addMatrixBlockToCompressedRows(
        compressedRows,
        elementCache,
        elementCache.kernel.elementStiffness(elementCache.corners, tangentsAtGp, elementCache.area, elementCache)
      );
    }

    addVectorBlockToFreeRhs(
      internalForceFree,
      elementCache.freeRowIndices,
      elementCache.kernel.elementInternalForce(elementCache.corners, stressContributionAtGp, elementCache.area, elementCache)
    );

    if (elementIndex % 200 === 0 && (await runCheckpoint(runControl))) {
      throw new Error('Deformation run was interrupted during nonlinear assembly.');
    }
  }

  if (!residualOnly) finalizeCompressedRows(compressedRows);
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
      {
        ...(elementAnalysisOptions || {}),
        residualOnly: true
      }
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

function cutbackFactorForFailureKind(failureCode, defaultFactor) {
  // v0.5.0 cutback policy: a single configured cutback factor for every
  // failure mode. The granular dispatch that mapped constitutive failures
  // to steeper cutbacks was removed in favour of behaviour parity with
  // the version known to converge cleanly. Newton direction quality is
  // already encoded in the line-search-derived cutback factor downstream.
  return Math.min(Math.max(Number(defaultFactor) || NONLINEAR_CUTBACK_FACTOR, 0.1), 0.9);
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
  // Initial-gravity Newton schedule. The production default is the exact
  // plastic tangent from the first iteration. Elastic-globalization remains
  // available as an explicit diagnostic fallback, but the slope-aware seed
  // removes the artificial zero-shear residual that previously made elastic
  // globalization necessary on mild slopes.
  const initialGravityTangentSchedule = phaseCanUseElasticGlobalizationTangent
    ? normalizeTangentSchedule(
        options?.initialGravityTangentSchedule,
        options?.initialGravityUseElasticGlobalizationTangent === true ? ['elastic', 'plastic'] : ['plastic']
      )
    : ['plastic'];
  const elasticGlobalizationIterations = Math.max(Math.round(Number(options?.initialGravityElasticGlobalizationIterations) || 4), 0);
  const elasticGlobalizationSwitchRelativeResidual = Math.max(Number(options?.elasticGlobalizationSwitchRelativeResidual) || 0.25, 0);
  const mayNeedUnsymmetricSolver = capabilities.algorithmicTangentMayBeUnsymmetric === true
    && (exactPlasticTangentMayBeUnsymmetric || options?.useUnsymmetricPlasticSolver === true);
  const isInitialGravityPhase = phaseKind === 'initial-gravity';
  const isSensitivePhase = isInitialGravityPhase || phaseKind === 'safety-cphi';
  const phaseInitialLoadStepDefault = isSensitivePhase ? NONLINEAR_INITIAL_LOAD_STEP : 0.25;
  const phaseMinLoadStepDefault = isSensitivePhase ? NONLINEAR_MIN_LOAD_STEP : 1 / 2048;
  const phaseMaxIterationsDefault = isSensitivePhase ? NONLINEAR_MAX_ITER : 24;
  const phaseMaxLoadStepsDefault = isSensitivePhase ? NONLINEAR_MAX_LOAD_STEPS : 256;
  const maxIterations = Math.max(Math.round(Number(options?.nonlinearMaxIterations) || phaseMaxIterationsDefault), 1);
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
      || phaseMinLoadStepDefault,
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
    : Math.min(Math.max(Number(options?.initialLoadStep) || phaseInitialLoadStepDefault, minLoadStep), maximumLoadStep);
  const maxLoadSteps = allowLoadStepping
    ? Math.max(
      Math.round(
        Number(isInitialGravityPhase ? (options?.initialGravityMaxLoadSteps ?? options?.maxLoadSteps) : options?.maxLoadSteps)
          || phaseMaxLoadStepsDefault
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
  const linearSolveHistory = [];
  const preconditionerCache = {
    rebuildCount: 0,
    reuseCount: 0,
    finalLabel: 'none',
    lastDiagonalDrift: null
  };
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
  const plasticStageType = phaseConfig?.plasticStageType
    || (phaseKind === 'initial-gravity'
      ? (usesTargetForceHomotopy ? 'K0_NIL_STEP' : 'GRAVITY_RAMP')
      : phaseKind === 'safety-cphi'
        ? 'SAFETY_REDUCTION'
        : 'ENGINEERING_LOAD');
  const diagnosticModel = phaseConfig?.model || null;
  const computeCurrentDepthBandReport = () => diagnosticModel
    ? computeDepthBandReport(null, materialPoints, diagnosticModel, elementCaches, options)
    : null;
  const trackDepthBandHistory = !!diagnosticModel && (
    options?.trackDepthBandHistory === true ||
    (phaseKind === 'initial-gravity' && geostaticProgressFailFast)
  );
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
    // v0.5.0 binary classification: split assembly errors into two buckets
    // (return-mapping vs other assembly failures). The granular dispatch
    // was removed — every constitutive failure now routes to the single
    // 'local-return-failure' code with the configured cutback factor.
    const classifyAssemblyFailureCode = (message) => (
      String(message || '').toLowerCase().includes('return mapping')
        ? 'local-return-failure'
        : 'assembly-failure'
    );
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
        plasticStageType,
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
        const message = error instanceof Error ? error.message : String(error);
        setStepFailure(classifyAssemblyFailureCode(message), message);
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
      lastDepthBandReport = trackDepthBandHistory ? computeCurrentDepthBandReport() : lastDepthBandReport;
      if (trackDepthBandHistory && lastDepthBandReport) {
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
        depthBandReport: trackDepthBandHistory ? lastDepthBandReport : null
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

      // Use GMRES only when the current tangent actually contains active
      // non-associated plastic points. Elastic and fully admissible trial
      // assemblies stay on PCG, including the early geostatic iterations.
      const usesUnsymmetricSolver = !useElasticGlobalizationTangent
        && mayNeedUnsymmetricSolver
        && assembled.activeCount > 0;
      // Krylov dispatch:
      //   * unsymmetric (mc-plastic + non-associated tangent) →
      //     `solveGmresDispatched` (routes to GPU-resident FGMRES if
      //     CPU GMRES with the
      //     async DS backend matvec).
      //   * symmetric (linear elastic, mc-reduced-stiffness, or any
      //     case where the algorithmic tangent is symmetric) → CG via
      //     `solveCgDispatched`, which routes to the GPU-resident CG
      //     when the active backend exposes it.
      // BiCGStab was removed; GMRES is the canonical unsymmetric Krylov.
      const linearSolve = usesUnsymmetricSolver ? solveGmresDispatched : solveCgDispatched;
      stepUsedUnsymmetricSolver = usesUnsymmetricSolver;
      stepRecord.linearSolver = usesUnsymmetricSolver ? 'gmres-scaled' : 'cg';
      stepRecord.linearSolverPrecisionMode = 'cpu-f64';
      const solverNameForProgress = usesUnsymmetricSolver ? 'GMRES' : 'CG';
      const linearIterationObserver = async ({ iterations, relativeResidual }) => {
        onProgress({
          stage: 'solving',
          percent: 74,
          message: `${nonlinearStepLabel(targetLoadFactor)}; Newton ${iteration}/${maxIterations}, ${solverNameForProgress} iter ${iterations.toLocaleString()}, relative residual ${relativeResidual.toExponential(2)}`
        });
        await runCheckpoint(runControl);
      };
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
        // 2×2 DOF blocks in the compressed-row layout. CPU f64 is the only
        // path until the GPU resident pipeline is built.
        {
          freeDofs,
          elementCaches,
          preconditionerCache,
          enablePreconditionerCache: options?.enablePreconditionerCache,
          preconditionerReuseDiagDriftTolerance: options?.preconditionerReuseDiagDriftTolerance,
          restart: options?.restart
        }
      );
      const maybeRetryWithDoubleSingle = async () => cg;
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
      if (!cg.path) {
        cg = decorateLinearSolveResult(cg, {
          solver: usesUnsymmetricSolver ? 'gmres' : 'cg',
          path: 'cpu-f64',
          preconditioner: 'nodal-block-jacobi'
        });
      }
      const linearSolveSummary = summarizeLinearSolveResult(cg);
      linearSolveSummary.phaseKind = phaseKind;
      linearSolveSummary.loadStep = loadStepCounter;
      linearSolveSummary.newtonIteration = iteration;
      linearSolveHistory.push(linearSolveSummary);
      stepRecord.linearSolve = linearSolveSummary;
      stepRecord.linearSolverPath = linearSolveSummary.path;
      stepRecord.linearSolverPreconditioner = linearSolveSummary.preconditioner;
      stepRecord.linearSolverTrueResidualNorm = linearSolveSummary.trueResidualNorm;
      stepRecord.linearSolverUsedTrueResidualAcceptance = linearSolveSummary.usedTrueResidualAcceptance;
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
          const message = error instanceof Error ? error.message : String(error);
          setStepFailure(classifyAssemblyFailureCode(message), message);
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
            const message = error instanceof Error ? error.message : String(error);
            setStepFailure(classifyAssemblyFailureCode(message), message);
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
        lastDepthBandReport = trackDepthBandHistory ? computeCurrentDepthBandReport() : lastDepthBandReport;
        if (trackDepthBandHistory && lastDepthBandReport) stepRecord.depthBandReport = lastDepthBandReport;
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
        if (!lastDepthBandReport) lastDepthBandReport = computeCurrentDepthBandReport();
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
    const reasonedCutbackFactor = cutbackFactorForFailureKind(failureCode, effectiveCutbackFactor);
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
      ? Math.max(reasonedCutbackFactor, Math.min(0.9, Number(suggestedStepCutbackFactor)))
      : reasonedCutbackFactor;
    const proposedStepSize = actualStep * suggestedCutbackFactor;
    stepRecord.suggestedNextStepFactor = suggestedCutbackFactor;
    stepRecord.suggestedNextStepSize = proposedStepSize < minLoadStep - 1e-12 && actualStep > minLoadStep + 1e-12
      ? minLoadStep
      : proposedStepSize;
    if (isInitialGravityPhase && !lastDepthBandReport && geostaticProgressFailFast) {
      lastDepthBandReport = computeCurrentDepthBandReport();
    }
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
      plasticStageType,
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
    linearSolveAggregate: aggregateLinearSolveHistory(linearSolveHistory),
    linearSolveHistory: linearSolveHistory.slice(-LINEAR_SOLVE_HISTORY_CAP),
    preconditionerStats: {
      rebuildCount: Number(preconditionerCache.rebuildCount) || 0,
      reuseCount: Number(preconditionerCache.reuseCount) || 0,
      reuseRatio: (Number(preconditionerCache.rebuildCount) || 0) + (Number(preconditionerCache.reuseCount) || 0) > 0
        ? (Number(preconditionerCache.reuseCount) || 0) / ((Number(preconditionerCache.rebuildCount) || 0) + (Number(preconditionerCache.reuseCount) || 0))
        : 0,
      finalLabel: preconditionerCache.finalLabel || 'none',
      lastDiagonalDrift: Number.isFinite(Number(preconditionerCache.lastDiagonalDrift)) ? Number(preconditionerCache.lastDiagonalDrift) : null
    },
    depthBandHistory,
    finalDepthBandReport,
    stallDiagnostics: terminatedByFailure
      ? buildStallDiagnostics(
          {
            converged: false,
            convergenceState: 'partial',
            failureCode: phaseFailureRecord.code,
            failureReason: terminalFailureReason || displayedState?.reason || '',
            loadFactorCommitted
          },
          materialPoints,
          phaseConfig?.model || null,
          options
        )
      : null
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

function buildGeostaticSeedEquilibriumAudit(initializedPredictor, gravityRhsFreeBase, geostatic, options = {}) {
  const internalForceFree = initializedPredictor?.targetForceBase || new Float64Array(gravityRhsFreeBase.length);
  const residualFree = Float64Array.from(gravityRhsFreeBase);
  addScaledVectorInPlace(residualFree, internalForceFree, -1);
  const gravityNorm = vectorNorm(gravityRhsFreeBase || []);
  const internalNorm = vectorNorm(internalForceFree || []);
  const residualNorm = vectorNorm(residualFree);
  const denominator = Math.max(gravityNorm, internalNorm, 1);
  const relativeResidual = residualNorm / denominator;
  const tolerance = Math.max(Number(options?.geostaticStressOnlyResidualTolerance) || 0.05, 1e-8);
  return {
    method: geostatic?.workflow?.method || geostatic?.mode || 'unknown',
    seedMode: geostatic?.seedMode || geostatic?.mode || 'unknown',
    residualNormBeforeCorrection: residualNorm,
    gravityForceNorm: gravityNorm,
    internalForceNorm: internalNorm,
    relativeResidualBeforeCorrection: relativeResidual,
    residualTolerance: tolerance,
    residualWithinTolerance: relativeResidual <= tolerance,
    activeCount: Number(initializedPredictor?.activeCount) || 0,
    activeFaceCount: Number(initializedPredictor?.activeFaceCount) || 0,
    activeEdgeCount: Number(initializedPredictor?.activeEdgeCount) || 0,
    activeApexCount: Number(initializedPredictor?.activeApexCount) || 0,
    tensionPendingCount: Number(initializedPredictor?.tensionPendingCount) || 0,
    maxEta: Number(initializedPredictor?.maxEta) || 0
  };
}

function summarizePlasticProvenance(materialPoints = []) {
  const firstPlasticByStageType = {};
  const accumulatedPlasticStrainByStageType = {};
  const accumulatedPlasticWorkByStageType = {};
  let pointCount = 0;
  let pointsWithPlasticHistory = 0;
  (materialPoints || []).forEach((materialPoint) => {
    const state = materialPoint?.committedState || materialPoint?.trialState || null;
    if (!state) return;
    pointCount += 1;
    const accumulated = Number(state.accumulatedPlasticStrain) || 0;
    if (accumulated > 1e-14) pointsWithPlasticHistory += 1;
    const firstType = state.firstPlasticStageType || '';
    if (firstType) firstPlasticByStageType[firstType] = (firstPlasticByStageType[firstType] || 0) + 1;
    Object.entries(state.plasticStrainByStageType || {}).forEach(([stageType, value]) => {
      accumulatedPlasticStrainByStageType[stageType] = (Number(accumulatedPlasticStrainByStageType[stageType]) || 0) + (Number(value) || 0);
    });
    Object.entries(state.plasticWorkByStageType || {}).forEach(([stageType, value]) => {
      accumulatedPlasticWorkByStageType[stageType] = (Number(accumulatedPlasticWorkByStageType[stageType]) || 0) + (Number(value) || 0);
    });
  });
  return {
    pointCount,
    pointsWithPlasticHistory,
    firstPlasticByStageType,
    accumulatedPlasticStrainByStageType,
    accumulatedPlasticWorkByStageType
  };
}

async function prepareStressOnlyGeostaticReference(
  elementCaches,
  assemblyPattern,
  gravityRhsFreeBase,
  materialPoints,
  ndof,
  initialSolution,
  runControl,
  geostatic,
  options = {},
  warnings = []
) {
  const initializedPredictor = await initializePlasticPredictorReferenceState(
    elementCaches,
    assemblyPattern,
    gravityRhsFreeBase,
    materialPoints,
    initialSolution,
    runControl
  );
  const predictorReferenceCheckpoint = createMaterialPointCheckpoint(materialPoints, initialSolution, {
    label: 'stress-only-geostatic-reference',
    referenceMode: 'stress-only-geostatic-seed'
  });
  const audit = buildGeostaticSeedEquilibriumAudit(initializedPredictor, gravityRhsFreeBase, geostatic, options);
  if (!audit.residualWithinTolerance) {
    pushUniqueWarning(
      warnings,
      `Initial stress equilibrium audit: the ${audit.seedMode} stress-only field has relative self-weight residual ${audit.relativeResidualBeforeCorrection.toExponential(2)} (limit ${audit.residualTolerance.toExponential(2)}). Service loading is still started from the K0 in-situ stress reference, but this is not a converged self-weight equilibrium. Set initialStressMode to "plastic-geostatic" when a fully equilibrated initial phase is required.`
    );
  }
  resetMaterialPointTrials(materialPoints);
  setReferenceStateFromCommittedStates(materialPoints, 'predictor');
  return decorateInitialPhaseState({
    phaseKind: 'initial-gravity',
    formulationMode: 'total',
    solution: new Float64Array(ndof),
    acceptedSteps: 0,
    rejectedSteps: 0,
    totalNonlinearIterations: 0,
    totalCgIterations: 0,
    residualNorm: audit.residualNormBeforeCorrection,
    relativeResidualNorm: audit.relativeResidualBeforeCorrection,
    displacementCorrectionNorm: 0,
    relativeDisplacementCorrectionNorm: 0,
    lastStateChanges: 0,
    finalActiveCount: audit.activeCount,
    peakActiveCount: audit.activeCount,
    finalActiveFaceCount: audit.activeFaceCount,
    finalActiveEdgeCount: audit.activeEdgeCount,
    finalActiveApexCount: audit.activeApexCount,
    finalTensionPendingCount: audit.tensionPendingCount,
    peakActiveFaceCount: audit.activeFaceCount,
    peakActiveEdgeCount: audit.activeEdgeCount,
    peakActiveApexCount: audit.activeApexCount,
    peakTensionPendingCount: audit.tensionPendingCount,
    peakEta: audit.maxEta,
    loadFactorCommitted: 1,
    displayedLoadFactor: 1,
    loadFactorMeaning: 'stress-only-equilibrium-audit',
    converged: false,
    convergenceState: audit.residualWithinTolerance ? 'stress-only-audited' : 'stress-only-audit-residual',
    displayedStateMode: 'stress-only-reference',
    failureCode: '',
    failureOutcomeClass: 'none',
    failureReason: '',
    loadStepHistory: [],
    residualHistory: [{
      loadFactor: 1,
      residualNorm: audit.residualNormBeforeCorrection,
      relativeResidualNorm: audit.relativeResidualBeforeCorrection,
      mode: 'stress-only-equilibrium-audit'
    }],
    linearSolveHistory: [],
    depthBandHistory: [],
    finalDepthBandReport: null,
    initializedPredictor,
    predictorReferenceCheckpoint,
    geostaticEquilibriumAudit: audit
  }, 'stress-only-reference', {
    referenceAccepted: true,
    equilibriumConverged: false,
    stressOnlyReference: true,
    canStartService: true,
    auditResidualNorm: audit.residualNormBeforeCorrection,
    auditRelativeResidual: audit.relativeResidualBeforeCorrection,
    auditWithinTolerance: audit.residualWithinTolerance
  });
}

function planGeostaticCorrectionStages(options = {}) {
  const explicit = Number(options?.geostaticCorrectionStages);
  let count = Number.isFinite(explicit) && explicit > 0
    ? Math.round(explicit)
    : 1;
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
  const predictorReferenceCheckpoint = createMaterialPointCheckpoint(materialPoints, initialSolution, {
    label: 'stress-only-geostatic-reference',
    referenceMode: 'stress-only-geostatic-seed'
  });
  const stages = planGeostaticCorrectionStages(options);
  const stageSize = stages.length > 0 ? 1 / stages.length : 1;
  const initializationMethod = normalizeGeostaticInitializationMethod(options?.geostaticInitializationMethod);
  const isPureGravityRamp = initializationMethod === 'gravity-ramp';
  const seedEquilibriumAudit = buildGeostaticSeedEquilibriumAudit(
    initializedPredictor,
    gravityRhsFreeBase,
    {
      mode: isPureGravityRamp ? 'gravity-ramp-zero-stress' : 'k0-nil-step',
      seedMode: isPureGravityRamp ? 'zero-stress' : 'k0-nil-step',
      workflow: {
        method: isPureGravityRamp ? 'gravity-ramp' : 'k0-nil-step',
        seedMode: isPureGravityRamp ? 'zero-stress' : 'k0-nil-step'
      }
    },
    options
  );
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
      initialLoadStep: Math.min(
        Math.max(Number(options?.initialLoadStep) || NONLINEAR_INITIAL_LOAD_STEP, Math.min(stageSize, NONLINEAR_MIN_LOAD_STEP)),
        stageSize
      ),
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
      targetForceBase: isPureGravityRamp ? null : initializedPredictor.targetForceBase,
      plasticStageType: isPureGravityRamp ? 'GRAVITY_RAMP' : 'K0_NIL_STEP',
      initialSolution,
      model
    }
  );
  const phaseWithAudit = {
    ...phase,
    geostaticCorrectionStages: stages,
    initializedPredictor,
    predictorReferenceCheckpoint,
    geostaticEquilibriumAudit: {
      ...seedEquilibriumAudit,
      residualNormAfterCorrection: Number(phase.residualNorm) || 0,
      relativeResidualAfterCorrection: Number(phase.relativeResidualNorm) || 0,
      correctionConverged: phase.converged === true,
      acceptedCorrectionSteps: Number(phase.acceptedSteps) || 0,
      rejectedCorrectionSteps: Number(phase.rejectedSteps) || 0,
      plasticStageType: isPureGravityRamp ? 'GRAVITY_RAMP' : 'K0_NIL_STEP'
    }
  };
  const finalAudit = phaseWithAudit.geostaticEquilibriumAudit;
  return decorateInitialPhaseState(phaseWithAudit, classifyInitialPhaseStateKind(phase), {
    referenceAccepted: phase.converged === true,
    equilibriumConverged: phase.converged === true,
    stressOnlyReference: false,
    canStartService: phase.converged === true,
    auditResidualNorm: finalAudit.residualNormAfterCorrection,
    auditRelativeResidual: finalAudit.relativeResidualAfterCorrection,
    auditWithinTolerance: phase.converged === true
  });
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
  const predictorReferenceCheckpoint = createMaterialPointCheckpoint(materialPoints, initialSolution, {
    label: 'stress-only-geostatic-reference',
    referenceMode: 'stress-only-geostatic-seed'
  });
  const initializationMethod = normalizeGeostaticInitializationMethod(options?.geostaticInitializationMethod);
  const isPureGravityRamp = initializationMethod === 'gravity-ramp';
  const seedEquilibriumAudit = buildGeostaticSeedEquilibriumAudit(
    initializedPredictor,
    gravityRhsFreeBase,
    {
      mode: isPureGravityRamp ? 'gravity-ramp-zero-stress' : 'k0-nil-step',
      seedMode: isPureGravityRamp ? 'zero-stress' : 'k0-nil-step',
      workflow: {
        method: isPureGravityRamp ? 'gravity-ramp' : 'k0-nil-step',
        seedMode: isPureGravityRamp ? 'zero-stress' : 'k0-nil-step'
      }
    },
    options
  );
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
    options,
    {
      phaseKind: 'initial-gravity',
      formulationMode: 'total',
      allowLoadStepping: true,
      targetLoadFactor: 1,
      targetForceBase: isPureGravityRamp ? null : initializedPredictor.targetForceBase,
      plasticStageType: isPureGravityRamp ? 'GRAVITY_RAMP' : 'K0_NIL_STEP',
      initialSolution,
      model
    }
  );
  const phaseWithAudit = {
    ...phase,
    initializedPredictor,
    predictorReferenceCheckpoint,
    geostaticEquilibriumAudit: {
      ...seedEquilibriumAudit,
      residualNormAfterCorrection: Number(phase.residualNorm) || 0,
      relativeResidualAfterCorrection: Number(phase.relativeResidualNorm) || 0,
      correctionConverged: phase.converged === true,
      acceptedCorrectionSteps: Number(phase.acceptedSteps) || 0,
      rejectedCorrectionSteps: Number(phase.rejectedSteps) || 0,
      plasticStageType: isPureGravityRamp ? 'GRAVITY_RAMP' : 'K0_NIL_STEP'
    }
  };
  const finalAudit = phaseWithAudit.geostaticEquilibriumAudit;
  return decorateInitialPhaseState(phaseWithAudit, classifyInitialPhaseStateKind(phase), {
    referenceAccepted: phase.converged === true,
    equilibriumConverged: phase.converged === true,
    stressOnlyReference: false,
    canStartService: phase.converged === true,
    auditResidualNorm: finalAudit.residualNormAfterCorrection,
    auditRelativeResidual: finalAudit.relativeResidualAfterCorrection,
    auditWithinTolerance: phase.converged === true
  });
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
  let preconditionerRebuildCount = 0;
  let preconditionerReuseCount = 0;
  let preconditionerFinalLabel = 'none';
  const acceptedMechanismHistory = [];
  const linearSolveHistory = [];
  const safetyPreconditionerStats = () => ({
    rebuildCount: preconditionerRebuildCount,
    reuseCount: preconditionerReuseCount,
    reuseRatio: preconditionerRebuildCount + preconditionerReuseCount > 0
      ? preconditionerReuseCount / (preconditionerRebuildCount + preconditionerReuseCount)
      : 0,
    finalLabel: preconditionerFinalLabel
  });

  const accumulatePhaseMetrics = (phase) => {
    if (!phase) return;
    totalCgIterations += Number(phase.totalCgIterations) || 0;
    totalNonlinearIterations += Number(phase.totalNonlinearIterations) || 0;
    (phase.linearSolveHistory || []).forEach((item) => linearSolveHistory.push(item));
    totalAcceptedContinuationSteps += Number(phase.acceptedSteps) || 0;
    totalRejectedContinuationSteps += Number(phase.rejectedSteps) || 0;
    peakActiveCount = Math.max(peakActiveCount, Number(phase.peakActiveCount) || 0);
    peakActiveFaceCount = Math.max(peakActiveFaceCount, Number(phase.peakActiveFaceCount) || 0);
    peakActiveEdgeCount = Math.max(peakActiveEdgeCount, Number(phase.peakActiveEdgeCount) || 0);
    peakActiveApexCount = Math.max(peakActiveApexCount, Number(phase.peakActiveApexCount) || 0);
    peakTensionPendingCount = Math.max(peakTensionPendingCount, Number(phase.peakTensionPendingCount) || 0);
    peakEta = Math.max(peakEta, Number(phase.peakEta) || 0);
    const stats = phase.preconditionerStats || {};
    preconditionerRebuildCount += Number(stats.rebuildCount) || 0;
    preconditionerReuseCount += Number(stats.reuseCount) || 0;
    if (stats.finalLabel) preconditionerFinalLabel = stats.finalLabel;
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
        linearSolveHistory,
        preconditionerStats: safetyPreconditionerStats(),
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
          linearSolveHistory,
          preconditionerStats: safetyPreconditionerStats(),
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
      linearSolveHistory,
      preconditionerStats: safetyPreconditionerStats(),
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
    linearSolveHistory,
    preconditionerStats: safetyPreconditionerStats(),
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

function finiteMcEtaForDisplay(item) {
  const contourEta = Number(item?.materialDiagnostics?.etaMcContour);
  if (Number.isFinite(contourEta)) return contourEta;
  let sumEta = 0;
  let sumWeight = 0;
  let maxEta = null;
  (item?.gaussPoints || []).forEach((gp) => {
    if (gp?.tensionCutoffActive === true || gp?.materialDiagnostics?.tensionCutoffActive === true) return;
    const eta = Number(gp?.materialDiagnostics?.etaMcFinal ?? gp?.mc?.eta);
    if (!Number.isFinite(eta)) return;
    const weight = Math.max(Number(gp?.areaWeight) || 1, 0);
    sumEta += weight * eta;
    sumWeight += weight;
    maxEta = Math.max(maxEta ?? 0, eta);
  });
  if (sumWeight > 0) return sumEta / sumWeight;
  if (maxEta != null) return maxEta;
  if (item?.materialDiagnostics?.tensionCutoffActive !== true) {
    const eta = Number(item?.materialDiagnostics?.etaMcFinal ?? item?.mc?.eta);
    if (Number.isFinite(eta)) return eta;
  }
  return null;
}

function finiteMcEtaMax(item) {
  let maxEta = null;
  const collect = (value) => {
    const eta = Number(value);
    if (Number.isFinite(eta)) maxEta = Math.max(maxEta ?? 0, eta);
  };
  (item?.gaussPoints || []).forEach((gp) => {
    if (gp?.tensionCutoffActive === true || gp?.materialDiagnostics?.tensionCutoffActive === true) return;
    collect(gp?.materialDiagnostics?.etaMcFinal ?? gp?.mc?.eta);
  });
  if (maxEta != null) return maxEta;
  if (item?.materialDiagnostics?.tensionCutoffActive !== true) {
    collect(item?.materialDiagnostics?.etaMcFinal);
    collect(item?.mc?.eta);
  }
  return maxEta;
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
    const etaValue = finiteMcEtaMax(item);
    if (!tensionCutoffActive && Number.isFinite(etaValue)) {
      maxMcEta = Math.max(maxMcEta, etaValue);
    } else if (tensionCutoffActive || Number(item?.mc?.eta) > 0 || item?.mc?.state === 'tension-cutoff') {
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
  const precomputedStrainFlat = null;
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
    let etaMcContourNumerator = 0;
    let etaMcContourWeight = 0;

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
      if (!tensionAtGp && Number.isFinite(eta)) {
        etaMcContourNumerator += weight * eta;
        etaMcContourWeight += weight;
      }
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
        etaMcContour: etaMcContourWeight > 0 ? etaMcContourNumerator / etaMcContourWeight : maxEtaMcFinal,
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
      const elementResult = result.elementResults?.[triangleIndex] || null;
      const tensionCutoffActive = elementResult?.materialDiagnostics?.tensionCutoffActive === true;
      const mcEta = finiteMcEtaForDisplay(elementResult);
      return {
        point,
        cellIndex,
        triangleIndex,
        ux,
        uy,
        uTotal: Math.hypot(ux, uy),
        settlement: -uy,
	        epsilonXx: Number(elementResult?.strain?.exx || 0),
	        epsilonYy: Number(elementResult?.strain?.eyy || 0),
	        gammaXy: Number(elementResult?.strain?.gxy || 0),
	        equivalentPlasticStrain: Number(elementResult?.materialState?.accumulatedPlasticStrain || 0),
	        safetyEquivalentPlasticIncrement: Number(elementResult?.materialDiagnostics?.safetyEquivalentPlasticIncrement || 0),
	        deltaSigmaYy: -Number(elementResult?.stressIncrement?.syy || 0),
	        sigmaYyEffInit: Number(elementResult?.initialEffectiveStress?.syy || 0),
	        sigmaYyEff: Number(elementResult?.effectiveStress?.syy || 0),
	        sigmaYyTotalInit: Number(elementResult?.initialTotalStress?.syy || 0),
	        sigmaYyTotal: Number(elementResult?.totalStress?.syy || 0),
	        sigmaXxEffInit: Number(elementResult?.initialEffectiveStress?.sxx || 0),
	        sigmaXxEff: Number(elementResult?.effectiveStress?.sxx || 0),
	        sigmaXxTotalInit: Number(elementResult?.initialTotalStress?.sxx || 0),
	        sigmaXxTotal: Number(elementResult?.totalStress?.sxx || 0),
	        tauXy: Number(elementResult?.effectiveStress?.txy || 0),
	        porePressure: Number(elementResult?.porePressure || 0),
        mcEta: !tensionCutoffActive && Number.isFinite(mcEta) ? mcEta : null,
        tensionCutoffActive
      };
    }
  }
  return null;
}

export async function analyzeDeformationModel(input, onProgress = () => {}, runControl = null) {
  return _analyzeDeformationModelImpl(input, onProgress, runControl);
}

async function _analyzeDeformationModelImpl(input, onProgress = () => {}, runControl = null) {
  const startedAt = performance.now();
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
    initialStressMode: input?.options?.initialStressMode === 'predictor' ? 'predictor' : 'plastic-geostatic',
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
        NONLINEAR_MIN_LOAD_STEP
      ),
      1e-5
    ),
    initialGravityMaxLoadSteps: Math.max(
      Math.round(
        pickFiniteFallback(
          input?.options?.initialGravityMaxLoadSteps,
          input?.options?.maxLoadSteps,
          NONLINEAR_MAX_LOAD_STEPS
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
    geostaticInitializationMethod: normalizeGeostaticInitializationMethod(input?.options?.geostaticInitializationMethod),
    geostaticStressOnlyResidualTolerance: Math.max(Number(input?.options?.geostaticStressOnlyResidualTolerance) || 0.05, 1e-8),
    useStagedGeostaticInit: input?.options?.useStagedGeostaticInit !== false,
    geostaticCorrectionStages: Math.min(Math.max(Math.round(Number(input?.options?.geostaticCorrectionStages) || 1), 1), 64),
    initialGravityTangentSchedule: normalizeTangentSchedule(input?.options?.initialGravityTangentSchedule, ['plastic']),
    initialGravityElasticGlobalizationIterations: Math.max(Math.round(Number(input?.options?.initialGravityElasticGlobalizationIterations) || 4), 0),
    elasticGlobalizationArmijoC1: Math.max(Number(input?.options?.elasticGlobalizationArmijoC1) || 1e-3, 0),
    elasticGlobalizationMinResidualRatio: Math.min(Math.max(Number(input?.options?.elasticGlobalizationMinResidualRatio) || 0.90, 1e-6), 0.999),
    elasticGlobalizationSwitchRelativeResidual: Math.max(Number(input?.options?.elasticGlobalizationSwitchRelativeResidual) || 0.25, 0),
    allowStressOnlyGeostaticReference: input?.options?.allowStressOnlyGeostaticReference === true,
    stressOnlyGeostaticMaxEta: Math.min(Math.max(Number(input?.options?.stressOnlyGeostaticMaxEta) || 1, 0), 1),
    geostaticMinLoadStep: Math.max(Number(input?.options?.geostaticMinLoadStep) || 5e-4, 1e-6),
    geostaticMaxRepeatedBand: Math.max(Math.round(Number(input?.options?.geostaticMaxRepeatedBand) || 3), 1),
    geostaticProgressFailFast: input?.options?.geostaticProgressFailFast === true,
    geostaticProgressFailFastSteps: Math.max(Math.round(Number(input?.options?.geostaticProgressFailFastSteps) || 6), 1),
    geostaticProgressFailFastLoadFactor: Math.min(Math.max(Number(input?.options?.geostaticProgressFailFastLoadFactor) || 0.50, 0), 1),
    geostaticProgressFailFastPlasticFraction: Math.min(Math.max(Number(input?.options?.geostaticProgressFailFastPlasticFraction) || 0.15, 0), 1),
    serviceProgressFailFast: input?.options?.serviceProgressFailFast === true,
    serviceProgressFailFastSteps: Math.max(Math.round(Number(input?.options?.serviceProgressFailFastSteps) || 16), 1),
    serviceProgressFailFastLoadFactor: Math.min(Math.max(Number(input?.options?.serviceProgressFailFastLoadFactor) || 0.20, 0), 1),
    serviceProgressFailFastPlasticFraction: Math.min(Math.max(Number(input?.options?.serviceProgressFailFastPlasticFraction) || 0.35, 0), 1),
    adaptiveContinuation: input?.options?.adaptiveContinuation !== false,
    continuationTargetIterations: Math.max(Number(input?.options?.continuationTargetIterations) || NONLINEAR_CONTINUATION_TARGET_ITERATIONS, 1),
    initialGravityContinuationTargetIterations: Math.max(Number(input?.options?.initialGravityContinuationTargetIterations) || NONLINEAR_CONTINUATION_TARGET_ITERATIONS, 1),
    safetyContinuationTargetIterations: Math.max(Number(input?.options?.safetyContinuationTargetIterations) || NONLINEAR_CONTINUATION_TARGET_ITERATIONS, 1),
    continuationTargetLineSearchScale: Math.max(Math.min(Number(input?.options?.continuationTargetLineSearchScale) || NONLINEAR_CONTINUATION_TARGET_LINE_SEARCH_SCALE, 1), 1e-6),
    continuationIterationExponent: Math.max(Number(input?.options?.continuationIterationExponent) || NONLINEAR_CONTINUATION_ITERATION_EXPONENT, 0),
    continuationLineSearchExponent: Math.max(Number(input?.options?.continuationLineSearchExponent) || NONLINEAR_CONTINUATION_LINE_SEARCH_EXPONENT, 0),
    useUnsymmetricPlasticSolver: input?.options?.useUnsymmetricPlasticSolver !== false,
    unsymmetricLinearSolver: 'gmres-scaled',
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
  };
  // GPU acceleration plumbing has been removed; CPU f64 is the only path
  // until the new resident double-single pipeline is built (Phases 1-12).
  const load = normalizeLoad(model, options, warnings, analysisType === 'deformation' ? 'required' : 'optional');
  addDomainExtentWarnings(model, load, warnings);
  const hasSurfaceLoad = !!load;
  if (analysisType === 'safety-cphi' && options.constitutiveModel !== 'mc-plastic') {
    throw new Error('C-phi reduction safety analysis is only available with the Stage 2 elastoplastic constitutive model.');
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
  const elementCaches = buildDeformationElementCaches(mesh, options);
  const fixedValues = buildFixedDofMap(mesh);
  const freeDofs = [];
  const freeIndexByDof = new Map();
  for (let dof = 0; dof < ndof; dof += 1) {
    if (fixedValues.has(dof)) continue;
    freeIndexByDof.set(dof, freeDofs.length);
    freeDofs.push(dof);
  }
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
  const geostaticWorkflow = geostatic.workflow || resolveGeostaticInitializationWorkflow(model, options, analysisType);
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
  // Plastic geostatic correction runs whenever the workflow asks for it
  // (gravity-ramp, or elastic-k0-recovery with `wantsEquilibratedStart`)
  // *and* the active plugin supports it.
  const canRunPlasticInitialEquilibrium = geostaticWorkflow.runPlasticCorrection === true
    && samplePluginForPhase?.capabilities?.supportsPlasticGeostaticPhase === true;
  let materialPoints = buildElementMaterialPoints(mesh, elementCaches, regionConstitutiveByRegion, geostatic.initialField, options, warnings, model);
  if ((wantsPlasticInitialEquilibrium || geostaticWorkflow.runPlasticCorrection === true) && !canRunPlasticInitialEquilibrium) {
    pushUniqueWarning(
      warnings,
      `Plastic geostatic equilibration is not supported by the ${samplePluginForPhase?.displayName || 'current'} material model, so the solver used the audited geostatic stress reference instead.`
    );
  }

  let initialPhase = {
    ...buildInitialPhaseStateFields('failed', {
      referenceAccepted: false,
      equilibriumConverged: false,
      stressOnlyReference: false,
      canStartService: false
    }),
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
    linearSolveHistory: [],
    depthBandHistory: [],
    finalDepthBandReport: null
  };
  let servicePhase = null;
  let servicePhaseStarted = false;
  let initialBaselineSolution = new Float64Array(ndof);
  let safetyAnalysis = null;
  let safetyBaseCheckpoint = null;
  let stressOnlyGeostaticReferenceAccepted = false;
  let stressOnlyGeostaticReferenceAudit = null;
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
      stressOnlyGeostaticReferenceAudit = auditStressOnlyGeostaticReference(materialPoints, geostatic, initialPhase, options);
      const canStartFromStressOnlyReference = analysisType === 'deformation'
        && wantsServiceLoadPhase
        && options.allowStressOnlyGeostaticReference === true
        && options.initialStressMode !== 'plastic-geostatic'
        && stressOnlyGeostaticReferenceAudit.canUseStressOnlyReference === true
        && initialPhase.predictorReferenceCheckpoint?.materialPoints?.length === materialPoints.length;
      if (canStartFromStressOnlyReference) {
        stressOnlyGeostaticReferenceAccepted = true;
        materialPoints = cloneMaterialPointCollection(initialPhase.predictorReferenceCheckpoint.materialPoints);
        resetMaterialPointTrials(materialPoints);
        setReferenceStateFromCommittedStates(materialPoints, 'predictor');
        initialBaselineSolution = new Float64Array(ndof);
        servicePhaseStarted = true;
        initialPhase = decorateInitialPhaseState({
          ...initialPhase,
          convergenceState: 'stress-only-fallback-after-failed-correction',
          displayedStateMode: 'stress-only-reference',
          loadFactorMeaning: 'stress-only-equilibrium-audit'
        }, 'stress-only-reference', {
          referenceAccepted: true,
          equilibriumConverged: false,
          stressOnlyReference: true,
          canStartService: true,
          auditResidualNorm: initialPhase.geostaticEquilibriumAudit?.residualNormBeforeCorrection ?? initialPhase.residualNorm,
          auditRelativeResidual: initialPhase.geostaticEquilibriumAudit?.relativeResidualBeforeCorrection ?? initialPhase.relativeResidualNorm,
          auditWithinTolerance: initialPhase.geostaticEquilibriumAudit?.residualWithinTolerance ?? null
        });
        pushUniqueWarning(
          warnings,
          `Initial plastic self-weight correction did not converge, but the K0/slope stress seed is admissible (max η_MC ${stressOnlyGeostaticReferenceAudit.maxEta.toFixed(2)} ≤ ${stressOnlyGeostaticReferenceAudit.etaLimit.toFixed(2)}; ${stressOnlyGeostaticReferenceAudit.yieldBoundarySeedCount || 0} point(s) on the MC boundary). Using that stress field as the in-situ reference with zero initial displacement, zero strain, and zero accumulated plasticity; service loading was started from this clean reference.`
        );
      } else {
        const shownInitialPhaseFactor = 100 * Math.max(Number(initialPhase.displayedLoadFactor) || 0, 0);
        const initialPhaseTargetLabel = initialPhase.loadFactorMeaning === 'predictor-to-full-gravity correction'
          ? `${shownInitialPhaseFactor.toFixed(1)}% of the predictor-to-full-gravity correction`
          : `${shownInitialPhaseFactor.toFixed(1)}% gravity`;
        pushUniqueWarning(
          warnings,
          `Showing a non-converged initial plastic self-weight equilibration state at ${initialPhaseTargetLabel}. Service loading was not started. Reason: ${initialPhase.failureReason || 'nonlinear iterations exhausted'}. Use this result qualitatively.`
        );
      }
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
    initialPhase = await prepareStressOnlyGeostaticReference(
      elementCaches,
      nonlinearAssemblyPattern,
      gravityCompressedRhs,
      materialPoints,
      ndof,
      new Float64Array(ndof),
      runControl,
      geostatic,
      options,
      warnings
    );
    stressOnlyGeostaticReferenceAccepted = true;
    stressOnlyGeostaticReferenceAudit = initialPhase.geostaticEquilibriumAudit || null;
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

  const zeroDisplacementSolution = new Float64Array(ndof);
  const predictorDisplacementSolution = canRunPlasticInitialEquilibrium && !stressOnlyGeostaticReferenceAccepted
    ? (geostatic.solution || new Float64Array(ndof))
    : zeroDisplacementSolution;
  const physicalInitialEquilibriumSolution = stressOnlyGeostaticReferenceAccepted
    ? zeroDisplacementSolution
    : canRunPlasticInitialEquilibrium
    ? addSolutionVectors(predictorDisplacementSolution, initialPhase.solution)
    : initialPhase.solution;
  const physicalServiceSolution = servicePhaseStarted
    ? (
        canRunPlasticInitialEquilibrium && !stressOnlyGeostaticReferenceAccepted
          ? addSolutionVectors(predictorDisplacementSolution, servicePhase.solution)
          : servicePhase.solution
      )
    : physicalInitialEquilibriumSolution;

  if (analysisType === 'safety-cphi') {
    if (initialPhase.canStartSafety !== true) {
      const lastBand = initialPhase.finalDepthBandReport
        || (Array.isArray(initialPhase.depthBandHistory) && initialPhase.depthBandHistory.length > 0
              ? initialPhase.depthBandHistory[initialPhase.depthBandHistory.length - 1]
              : null);
      const lastBandLabel = lastBand?.dominantBandLabel
        || lastBand?.dominantBand?.label
        || (lastBand?.dominantBand && Number.isFinite(lastBand.dominantBand.zMin) && Number.isFinite(lastBand.dominantBand.zMax)
              ? `${lastBand.dominantBand.zMin.toFixed(2)}–${lastBand.dominantBand.zMax.toFixed(2)} m below terrain`
              : null);
      const stagesPlanned = Array.isArray(initialPhase.geostaticCorrectionStages)
        ? initialPhase.geostaticCorrectionStages.length
        : 0;
      const committedFraction = Number.isFinite(initialPhase.loadFactorCommitted)
        ? Math.max(0, Math.min(1, Number(initialPhase.loadFactorCommitted)))
        : 0;
      const stagesCommitted = stagesPlanned > 0 ? Math.round(stagesPlanned * committedFraction) : 0;
      const stagedFraction = stagesPlanned > 0
        ? `${stagesCommitted}/${stagesPlanned} staged corrections committed`
        : `${(committedFraction * 100).toFixed(1)}% gravity committed`;
      const reasonText = initialPhase.failureReason || 'nonlinear iterations exhausted';
      const bandText = lastBandLabel ? `; failure concentrated in the ${lastBandLabel} depth band` : '';
      const stateKind = initialPhase.initialStateKind || 'failed';
      if (stateKind === 'stress-only-reference') {
        throw new Error(
          `Safety analysis cannot start from a stress-only initial-stress reference. The current geostatic workflow is "${geostaticWorkflow.method}", which establishes an admissible stress field but does not solve self-weight equilibrium. Set initialStressMode to "plastic-geostatic" or use a plastic material model so the elastic K0 recovery is followed by a plastic correction phase, or use "gravity-ramp" to ramp gravity from a zero-stress state.`
        );
      }
      if (stateKind === 'partial-geostatic') {
        throw new Error(
          `Safety analysis cannot start from a partial geostatic equilibrium (${stagedFraction}; committed load factor ${(100 * committedFraction).toFixed(1)}%). Last reason: ${reasonText}${bandText}. Either relax the geometry/material so geostatic converges, or accept the partial state for deformation viewing only.`
        );
      }
      throw new Error(
        stateKind === 'failed'
          ? `Safety analysis cannot start from a failed geostatic phase (${initialPhase.failureReason || reasonText || 'unknown reason'}${bandText}).`
          : `Safety analysis requires equilibriumConverged === true and initialStateKind === "equilibrated-self-weight". Current initialStateKind: ${stateKind}.`
      );
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
  const linearSolveSummary = aggregateLinearSolveHistory(
    geostatic.linearSolveHistory || [],
    canRunPlasticInitialEquilibrium ? (initialPhase.linearSolveHistory || []) : [],
    servicePhaseStarted ? (servicePhase.linearSolveHistory || []) : [],
    analysisType === 'safety-cphi' ? (safetyAnalysis?.linearSolveHistory || []) : []
  );
  const tagResidualHistory = (history, phaseKind) => (history || []).map((item) => ({
    phaseKind,
    ...item
  }));
  const combinedResidualHistory = analysisType === 'safety-cphi'
    ? [
        ...tagResidualHistory(canRunPlasticInitialEquilibrium ? initialPhase.residualHistory : [], 'initial-gravity'),
        ...tagResidualHistory(servicePhaseStarted ? servicePhase.residualHistory : [], 'service-load'),
        ...tagResidualHistory(activePhase?.residualHistory || [], 'safety-cphi')
      ]
    : [
        ...tagResidualHistory(canRunPlasticInitialEquilibrium ? initialPhase.residualHistory : [], 'initial-gravity'),
        ...tagResidualHistory(servicePhaseStarted ? servicePhase.residualHistory : [], 'service-load')
      ];
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
  let physicalActiveSolution = constitutiveSolution;
  if (analysisType === 'safety-cphi') {
    physicalActiveSolution = constitutiveSolution || (wantsServiceLoadPhase ? physicalServiceSolution : physicalInitialEquilibriumSolution);
  } else if (canRunPlasticInitialEquilibrium && !stressOnlyGeostaticReferenceAccepted) {
    physicalActiveSolution = addSolutionVectors(predictorDisplacementSolution, constitutiveSolution);
  }

  let physicalInitialBaselineSolution = !servicePhaseStarted ? initialPhase.solution : new Float64Array(ndof);
  if (analysisType === 'safety-cphi') {
    physicalInitialBaselineSolution = wantsServiceLoadPhase ? physicalServiceSolution : physicalInitialEquilibriumSolution;
  } else if (stressOnlyGeostaticReferenceAccepted) {
    physicalInitialBaselineSolution = zeroDisplacementSolution;
  } else if (canRunPlasticInitialEquilibrium) {
    physicalInitialBaselineSolution = addSolutionVectors(
      predictorDisplacementSolution,
      initialPhase.converged ? initialBaselineSolution : physicalInitialBaselineSolution
    );
  }

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
    : (servicePhaseStarted && canRunPlasticInitialEquilibrium && (initialPhase.converged || stressOnlyGeostaticReferenceAccepted));
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
      initialStressMode: stressOnlyGeostaticReferenceAccepted
        ? `${geostatic.seedMode || geostatic.mode}-stress-only-reference`
        : canRunPlasticInitialEquilibrium
          ? `${geostatic.seedMode || geostatic.mode}-plastic-equilibration`
          : geostatic.mode,
      geostaticInitializationRequestedMethod: geostaticWorkflow.requestedMethod || options.geostaticInitializationMethod,
      geostaticInitializationMethod: geostaticWorkflow.method || geostatic.mode,
      geostaticInitializationReason: geostaticWorkflow.reason || '',
      geostaticInitializationRequiresPlasticCorrection: geostaticWorkflow.runPlasticCorrection === true,
      geostaticInitializationStressOnlyReference: geostaticWorkflow.stressOnlyReference === true,
      geostaticInitializationRequiresEquilibratedStart: geostaticWorkflow.requiresEquilibratedStart === true,
      initialPredictorMode: geostatic.mode,
      initialPredictorSeedMode: geostatic.seedMode || geostatic.mode,
      initialPredictorSeedDiagnostics: geostatic.seedDiagnostics || null,
      geostaticEquilibriumAudit: initialPhase.geostaticEquilibriumAudit || stressOnlyGeostaticReferenceAudit || null,
      plasticProvenanceSummary: summarizePlasticProvenance(activeMaterialPoints),
      geostaticIterations: geostatic.iterations,
      geostaticResidualNorm: geostatic.residualNorm,
      geostaticCorrectionStages: canRunPlasticInitialEquilibrium ? (initialPhase.geostaticCorrectionStages || []) : [],
      initialPhaseStarted: canRunPlasticInitialEquilibrium || stressOnlyGeostaticReferenceAccepted,
      initialPhaseConverged: canRunPlasticInitialEquilibrium || stressOnlyGeostaticReferenceAccepted ? initialPhase.converged : null,
      initialStateKind: initialPhase.initialStateKind || 'failed',
      initialReferenceAccepted: initialPhase.referenceAccepted === true,
      initialEquilibriumConverged: initialPhase.equilibriumConverged === true,
      initialStressOnlyReference: initialPhase.stressOnlyReference === true,
      initialCanStartService: initialPhase.canStartService === true,
      initialCanStartSafety: initialPhase.canStartSafety === true,
      initialAuditResidualNorm: Number.isFinite(Number(initialPhase.auditResidualNorm)) ? Number(initialPhase.auditResidualNorm) : null,
      initialAuditRelativeResidual: Number.isFinite(Number(initialPhase.auditRelativeResidual)) ? Number(initialPhase.auditRelativeResidual) : null,
      initialAuditWithinTolerance: initialPhase.auditWithinTolerance == null ? null : initialPhase.auditWithinTolerance === true,
      initialPhaseConvergenceState: canRunPlasticInitialEquilibrium || stressOnlyGeostaticReferenceAccepted ? initialPhase.convergenceState : 'skipped',
      initialPhaseFailureCode: canRunPlasticInitialEquilibrium ? initialPhase.failureCode : '',
      initialPhaseFailureOutcomeClass: canRunPlasticInitialEquilibrium ? initialPhase.failureOutcomeClass : 'none',
      initialPhaseFailureReason: canRunPlasticInitialEquilibrium ? initialPhase.failureReason : '',
      initialPhaseAcceptedSteps: canRunPlasticInitialEquilibrium ? initialPhase.acceptedSteps : 0,
      initialPhaseRejectedSteps: canRunPlasticInitialEquilibrium ? initialPhase.rejectedSteps : 0,
      initialPhaseDisplayedGravityFactor: canRunPlasticInitialEquilibrium ? initialPhase.displayedLoadFactor : 1,
      initialPhaseDisplayedContinuationMode: canRunPlasticInitialEquilibrium ? initialPhase.loadFactorMeaning : (initialPhase.loadFactorMeaning || 'stress-only-equilibrium-audit'),
      initialPhaseFinalActiveMcElements: canRunPlasticInitialEquilibrium || stressOnlyGeostaticReferenceAccepted ? initialPhase.finalActiveCount : 0,
      initialPhasePeakActiveMcElements: canRunPlasticInitialEquilibrium || stressOnlyGeostaticReferenceAccepted ? initialPhase.peakActiveCount : 0,
      initialPhaseFinalTensionPendingElements: canRunPlasticInitialEquilibrium || stressOnlyGeostaticReferenceAccepted ? initialPhase.finalTensionPendingCount : 0,
      initialPhasePeakTensionPendingElements: canRunPlasticInitialEquilibrium || stressOnlyGeostaticReferenceAccepted ? initialPhase.peakTensionPendingCount : 0,
      initialPhaseFinalTensionCutoffActiveElements: canRunPlasticInitialEquilibrium || stressOnlyGeostaticReferenceAccepted ? initialPhase.finalTensionPendingCount : 0,
      initialPhasePeakTensionCutoffActiveElements: canRunPlasticInitialEquilibrium || stressOnlyGeostaticReferenceAccepted ? initialPhase.peakTensionPendingCount : 0,
      initialPhaseDepthBandReport: canRunPlasticInitialEquilibrium ? initialPhase.finalDepthBandReport : null,
      stressOnlyGeostaticReferenceAccepted,
      stressOnlyGeostaticReferenceAudit,
      initialReferenceMode: stressOnlyGeostaticReferenceAccepted
        ? (canRunPlasticInitialEquilibrium ? 'stress-only-admissible-seed' : `${geostatic.seedMode || geostatic.mode}-stress-only`)
        : canRunPlasticInitialEquilibrium && initialPhase.converged
          ? 'equilibrated-plastic-geostatic'
          : geostatic.seedMode || geostatic.mode,
      // Audit-record-style aggregate (see Full_GPU_MC.md §3.5.4): a
      // forensic-quality summary of every linear solve that ran inside
      // the initial-gravity phase. The per-solve detail is on
      // `initialPhaseLinearSolveHistory` below; this object provides the
      // O(1) "what did the solver actually do" snapshot at the top level.
      initialPhaseLinearSolveAggregate: canRunPlasticInitialEquilibrium
        ? aggregateLinearSolveHistory(initialPhase.linearSolveHistory || [])
        : aggregateLinearSolveHistory([]),
      initialPhaseLinearSolveHistory: canRunPlasticInitialEquilibrium
        ? (initialPhase.linearSolveHistory || [])
        : [],
      initialPhasePreconditionerLevel: canRunPlasticInitialEquilibrium
        && Array.isArray(initialPhase.linearSolveHistory)
        && initialPhase.linearSolveHistory.length > 0
          ? (initialPhase.linearSolveHistory[initialPhase.linearSolveHistory.length - 1]?.preconditioner || 'unknown')
          : 'none',
      initialPhasePreconditionerStats: canRunPlasticInitialEquilibrium ? (initialPhase.preconditionerStats || null) : null,
      servicePhaseStarted,
      servicePhaseConvergenceState: servicePhaseStarted ? servicePhase.convergenceState : 'not-started',
      servicePhaseFailureCode: servicePhaseStarted ? servicePhase.failureCode : (canRunPlasticInitialEquilibrium ? initialPhase.failureCode : ''),
      servicePhaseFailureOutcomeClass: servicePhaseStarted ? servicePhase.failureOutcomeClass : (canRunPlasticInitialEquilibrium ? initialPhase.failureOutcomeClass : 'unknown'),
      servicePhaseFailureReason: servicePhaseStarted ? servicePhase.failureReason : (canRunPlasticInitialEquilibrium ? initialPhase.failureReason : ''),
      servicePhaseDepthBandReport: servicePhaseStarted ? servicePhase.finalDepthBandReport : null,
      servicePhasePreconditionerStats: servicePhaseStarted ? (servicePhase.preconditionerStats || null) : null,
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
      residualHistory: combinedResidualHistory,
      linearSolveHistory: linearSolveSummary.perSolve,
      linearSolveSummary,
      initialLoadStepHistory: canRunPlasticInitialEquilibrium ? initialPhase.loadStepHistory : [],
      initialResidualHistory: canRunPlasticInitialEquilibrium ? initialPhase.residualHistory : [],
      initialLinearSolveHistory: canRunPlasticInitialEquilibrium ? (initialPhase.linearSolveHistory || []) : [],
      serviceLinearSolveHistory: servicePhaseStarted ? (servicePhase.linearSolveHistory || []) : [],
      safetyLinearSolveHistory: analysisType === 'safety-cphi' ? (safetyAnalysis?.linearSolveHistory || []) : [],
      safetyPreconditionerStats: analysisType === 'safety-cphi' ? (safetyAnalysis?.preconditionerStats || null) : null,
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
        name: activeBackendInfo.name,
        reason: activeBackendInfo.reason,
        precisionMode: 'f64',
        freeDofCount: freeDofs.length,
        elementType: mesh.elementType === 't6' ? 't6' : 't3',
        krylovPath: linearSolveSummary.primaryPath,
        krylovCountsByPath: linearSolveSummary.countsByPath,
        krylovCountsBySolver: linearSolveSummary.countsBySolver,
        krylovFallbackReasons: linearSolveSummary.fallbackReasons,
        worstTrueResidualMismatch: linearSolveSummary.worstTrueResidualMismatch
      }
    },
    timing: {
      totalMs: performance.now() - startedAt
    }
  };
}
