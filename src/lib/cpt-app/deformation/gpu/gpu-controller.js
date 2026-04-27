// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Top-level GPU controller for the deformation solver.
// ============================================================================
//
// Public surface:
//
//   probeGpuPipeline()            → Promise<{ available, device?, reason? }>
//                                   Detects WebGPU, requests an adapter and a
//                                   device, returns either a ready device or a
//                                   structured "not available" reason.
//
//   runDeformationOnGpu(input)    → Promise<analysisResult>
//                                   End-to-end GPU pipeline for the linear-
//                                   elastic deformation analysis.  Mirrors
//                                   the relevant subset of analyzeDeformation-
//                                   Model's contract.  Throws or rejects on
//                                   any error; the caller routes to CPU.
//
// Mathematical scope at first delivery:
//   - Linear-elastic plane-strain solve (any region material).
//   - K0-controlled initial stress recovery.
//   - Surface load + gravity.
//   - Free DOFs only.  Constrained (Dirichlet) DOFs treated as fixed-zero
//     displacement, identical to the CPU path.
//
// The caller (solver.js) provides the assembled CPU-side state (mesh,
// elementCaches, regionConstitutiveByRegion, fixedDofs, b vector).  The
// controller builds the device pack, runs the entire solve on GPU, and
// returns the displacement field plus diagnostics.
// ============================================================================

import { buildGpuMeshPack, packFreeDofVector, unpackFreeDofVector, buildBlockJacobiPackForFreeDofs } from './gpu-mesh-pack.js';
import {
  createGpuAssemblyContext,
  recordResidualAndTangent,
  uploadDisplacement,
  readbackCsr,
  readbackRhsFree,
  clearCommittedState,
  uploadCommittedSigmaFromF64,
  snapshotCommittedState,
  restoreCommittedState,
  readbackCommittedSigma,
  readbackCommittedDisplacement,
  recordK0Recovery,
  recordStrainOnly,
  recordZeroUvec
} from './gpu-assembly.js';
import {
  createResidentCgContext, uploadDsCsr, uploadBlockJacobi, uploadDsVector,
  solveResidentCg
} from './resident-cg.js';
import { runPlasticNewtonOnGpu } from './gpu-plastic-newton.js';

// ---------------------------------------------------------------------------
// Probe.
// ---------------------------------------------------------------------------
export async function probeGpuPipeline() {
  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return { available: false, reason: 'webgpu-unavailable' };
  }
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (err) {
    return { available: false, reason: 'adapter-request-failed', error: err };
  }
  if (!adapter) return { available: false, reason: 'no-adapter' };
  let device = null;
  try {
    device = await adapter.requestDevice();
  } catch (err) {
    return { available: false, reason: 'device-request-failed', error: err };
  }
  if (!device) return { available: false, reason: 'no-device' };
  return {
    available: true,
    device,
    adapter,
    info: {
      vendor: adapter.info?.vendor || null,
      architecture: adapter.info?.architecture || null,
      device: adapter.info?.device || null,
      description: adapter.info?.description || null,
      features: [...(device.features || [])],
      limits: { ...(device.limits || {}) }
    }
  };
}

// ---------------------------------------------------------------------------
// Run.  Single-step linear-elastic GPU solve.
//
// Inputs (all CPU-side, from solver.js):
//   device:        GPUDevice from probeGpuPipeline()
//   mesh, elementCaches, regionConstitutiveByRegion: as built by solver.js
//   fixedDofSet:   Set<number> of Dirichlet-fixed global DOFs
//   bF64:          Float64Array length numFree — the assembled free-DOF RHS
//                  (gravity + surface load), already compressed via the same
//                  freeIndexByDof mapping the controller will use
//   options:       { maxIter, relTol, absTol, ... } passed to CG
//
// Output:
//   {
//     converged: bool,
//     iterations: number,
//     residualNorm: number,
//     uFreeF64: Float64Array (length numFree),
//     uFullF64: Float64Array (length ndof),
//     csrPacked: { rowPtr, colInd, valHi, valLo, nnz, dim },
//     diagnostics: { strategy: 'gpu-resident-elastic', ... }
//   }
// ---------------------------------------------------------------------------
export async function runDeformationOnGpu({
  device,
  mesh,
  elementCaches,
  regionConstitutiveByRegion,
  fixedDofSet,
  bF64,
  porePressureByIntegrationPoint = null,
  cgOptions = { maxIter: 5000, relTol: 1e-10, absTol: 1e-12 },
  warnings = []
}) {
  if (!device) throw new Error('runDeformationOnGpu: a GPUDevice is required.');
  // --- 1. Build the device pack.
  const pack = buildGpuMeshPack({
    mesh, elementCaches, regionConstitutiveByRegion,
    fixedDofSet, porePressureByIntegrationPoint, warnings
  });
  if (pack.numFree === 0) {
    throw new Error('runDeformationOnGpu: no free DOFs in mesh.');
  }

  // --- 2. Build the assembly context, upload static data.
  const elementType = elementCaches[0]?.kind === 't6' ? 't6' : 't3';
  const asm = createGpuAssemblyContext({ device, pack, elementType });

  // --- 3. Assemble K via a single u = 0 pass.  Because the assembly is
  //        configured for a linear-elastic D, this gives the constant K
  //        with one matvec.  Internal-force at u = 0 is zero; r = b.
  const zeroU = new Float64Array(pack.numFree);
  uploadDisplacement(asm, zeroU);
  {
    const enc = device.createCommandEncoder();
    recordResidualAndTangent(asm, enc);
    device.queue.submit([enc.finish()]);
  }
  // Wait for the assembly to finish (queue.onSubmittedWorkDone).
  if (typeof device.queue.onSubmittedWorkDone === 'function') {
    await device.queue.onSubmittedWorkDone();
  }
  const csrPacked = await readbackCsr(asm);

  // --- 4. Build the block-Jacobi pre-conditioner from the assembled CSR.
  const blockJacobiPacked = buildBlockJacobiPackForFreeDofs({
    freeDofs: pack.freeDofs,
    csrRowPtr: csrPacked.rowPtr,
    csrColInd: csrPacked.colInd,
    csrValHi:  csrPacked.valHi,
    csrValLo:  csrPacked.valLo
  });

  // --- 5. CG solve.
  const cgCtx = createResidentCgContext({
    device,
    ndof: pack.numFree,
    numNonzeros: pack.nnz
  });
  uploadDsCsr(cgCtx, csrPacked);
  uploadBlockJacobi(cgCtx, blockJacobiPacked);
  const cg = await solveResidentCg(cgCtx, {
    bF64,
    maxIter: cgOptions.maxIter,
    relTol: cgOptions.relTol,
    absTol: cgOptions.absTol
  });

  // --- 6. Expand the free-DOF solution to full DOF space (constrained DOFs
  //        are zero by Dirichlet BC).
  const uFullF64 = new Float64Array(pack.ndof);
  for (let i = 0; i < pack.numFree; i += 1) {
    uFullF64[pack.freeDofs[i]] = cg.solution[i];
  }

  return {
    converged: !!cg.converged,
    iterations: cg.iterations,
    residualNorm: cg.residualNorm,
    relativeResidual: cg.relativeResidual,
    uFreeF64: cg.solution,
    uFullF64,
    csrPacked,
    pack,
    diagnostics: {
      strategy: 'gpu-resident-elastic',
      elementType,
      numFree: pack.numFree,
      ndof: pack.ndof,
      nnz: pack.nnz,
      numGp: pack.numGp,
      cgPath: cg.path
    }
  };
}

// =============================================================================
// CPU-equivalent assembly: build the same CSR + block-Jacobi pack on host
// from an existing mesh + elementCaches + regionConstitutiveByRegion +
// fixedDofSet.  Used by tests (and by the host fallback when WebGPU is not
// available) to verify that the GPU CSR matches the CPU CSR bit-for-bit.
//
// Returns { csrPacked, blockJacobiPacked, pack } — the same shape as the
// device-side pipeline above, computed entirely on CPU.
// =============================================================================
import {
  cpuRefElementStrain, cpuRefElementInternalForce, cpuRefElementStiffness,
  cpuRefScatterFreeRhs, cpuRefScatterCsr
} from './wgsl/elements.js';
import { dsAdd, dsMul, dsFromF64, dsToF64, dsNeg, dsRecip } from './wgsl/ds.js';

function packDsFloat32Array(f64) {
  const n = f64.length;
  const out = new Float32Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    const hi = Math.fround(f64[i]);
    out[2 * i] = hi;
    out[2 * i + 1] = Math.fround(f64[i] - hi);
  }
  return out;
}

export function cpuReferenceAssemble({ mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet, porePressureByIntegrationPoint = null, warnings = [] }) {
  const pack = buildGpuMeshPack({
    mesh, elementCaches, regionConstitutiveByRegion,
    fixedDofSet, porePressureByIntegrationPoint, warnings
  });
  const STRAIN_DIM = 3;
  // Build DS bMatrices (already packed as Float32Array; lift to DS pairs).
  const bMatricesDs = new Array(pack.bMatricesPacked.length >> 1);
  for (let i = 0; i < bMatricesDs.length; i += 1) {
    bMatricesDs[i] = [pack.bMatricesPacked[2 * i], pack.bMatricesPacked[2 * i + 1]];
  }
  const gpWeightsDs = new Array(pack.gpWeightsPacked.length >> 1);
  for (let i = 0; i < gpWeightsDs.length; i += 1) {
    gpWeightsDs[i] = [pack.gpWeightsPacked[2 * i], pack.gpWeightsPacked[2 * i + 1]];
  }
  // Strain at u = 0 is 0 (used to confirm the assembly chain produces zero
  // internal force).  We assemble the *tangent* (D · B per GP) by computing
  // tangent = D_e for each GP from matParams and running the stiffness
  // kernel reference once.
  const tangents = new Array(pack.numGp * 9);
  for (let gp = 0; gp < pack.numGp; gp += 1) {
    const mi = pack.matIndex[gp];
    const KBulk = pack.matParamsPacked[2 * (mi * 8 + 6)] + pack.matParamsPacked[2 * (mi * 8 + 6) + 1];
    const G     = pack.matParamsPacked[2 * (mi * 8 + 7)] + pack.matParamsPacked[2 * (mi * 8 + 7) + 1];
    const D11 = KBulk + (4 / 3) * G;
    const D12 = KBulk - (2 / 3) * G;
    const D33 = G;
    tangents[gp * 9 + 0] = dsFromF64(D11);
    tangents[gp * 9 + 1] = dsFromF64(D12);
    tangents[gp * 9 + 2] = dsFromF64(0);
    tangents[gp * 9 + 3] = dsFromF64(D12);
    tangents[gp * 9 + 4] = dsFromF64(D11);
    tangents[gp * 9 + 5] = dsFromF64(0);
    tangents[gp * 9 + 6] = dsFromF64(0);
    tangents[gp * 9 + 7] = dsFromF64(0);
    tangents[gp * 9 + 8] = dsFromF64(D33);
  }
  const kOut = cpuRefElementStiffness({
    bMatrices: bMatricesDs, gpWeights: gpWeightsDs, tangents,
    numElements: pack.numElements, gpsPerElem: pack.gpsPerElem,
    numLocalDofs: pack.numLocalDofs
  });
  const csr = cpuRefScatterCsr({
    kOutDs: kOut, csrIncPtr: pack.csrIncPtr, csrIncList: pack.csrIncList, nnz: pack.nnz
  });
  const csrPacked = {
    rowPtr: pack.csrRowPtr,
    colInd: pack.csrColInd,
    valHi: csr.valHi,
    valLo: csr.valLo,
    nnz: pack.nnz,
    dim: pack.numFree
  };
  const blockJacobiPacked = buildBlockJacobiPackForFreeDofs({
    freeDofs: pack.freeDofs,
    csrRowPtr: csrPacked.rowPtr,
    csrColInd: csrPacked.colInd,
    csrValHi:  csrPacked.valHi,
    csrValLo:  csrPacked.valLo
  });
  return { pack, csrPacked, blockJacobiPacked };
}

// =============================================================================
// CPU-side end-to-end run (no WebGPU required).
//
// Mirrors `runDeformationOnGpu` exactly using the CPU-reference resident-CG
// implementation.  Used when WebGPU is unavailable but the engineer still
// wants to exercise the resident DS pipeline end-to-end (e.g. in CI).
// =============================================================================
import { cpuReferenceResidentCg } from './resident-cg.js';

export function runDeformationOnGpuCpuReference({
  mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet,
  bF64, porePressureByIntegrationPoint = null,
  cgOptions = { maxIter: 5000, relTol: 1e-10, absTol: 1e-12 },
  warnings = []
}) {
  const ref = cpuReferenceAssemble({
    mesh, elementCaches, regionConstitutiveByRegion,
    fixedDofSet, porePressureByIntegrationPoint, warnings
  });
  // Re-shape CSR into the rows-array format the CPU-reference CG expects.
  const rows = new Array(ref.pack.numFree);
  for (let i = 0; i < ref.pack.numFree; i += 1) {
    const begin = ref.csrPacked.rowPtr[i];
    const end = ref.csrPacked.rowPtr[i + 1];
    const indices = new Int32Array(end - begin);
    const values = new Float64Array(end - begin);
    for (let k = 0; k < end - begin; k += 1) {
      indices[k] = ref.csrPacked.colInd[begin + k];
      values[k] = ref.csrPacked.valHi[begin + k] + ref.csrPacked.valLo[begin + k];
    }
    rows[i] = { indices, values };
  }
  const csr = { rowPtr: ref.csrPacked.rowPtr, colInd: ref.csrPacked.colInd,
                valHi: ref.csrPacked.valHi, valLo: ref.csrPacked.valLo, dim: ref.pack.numFree };
  const numNodes = Math.ceil(ref.pack.numFree / 2);
  const blocksDs = new Array(4 * numNodes);
  for (let n = 0; n < numNodes; n += 1) {
    for (let k = 0; k < 4; k += 1) {
      blocksDs[4 * n + k] = [
        ref.blockJacobiPacked[8 * n + 2 * k],
        ref.blockJacobiPacked[8 * n + 2 * k + 1]
      ];
    }
  }
  const cg = cpuReferenceResidentCg({
    csr, blockJacobiDs: blocksDs, bF64,
    maxIter: cgOptions.maxIter, relTol: cgOptions.relTol, absTol: cgOptions.absTol
  });
  const uFullF64 = new Float64Array(ref.pack.ndof);
  for (let i = 0; i < ref.pack.numFree; i += 1) {
    uFullF64[ref.pack.freeDofs[i]] = cg.solution[i];
  }
  return {
    converged: !!cg.converged,
    iterations: cg.iterations,
    residualNorm: cg.residualNorm,
    uFreeF64: cg.solution,
    uFullF64,
    csrPacked: ref.csrPacked,
    pack: ref.pack,
    diagnostics: { strategy: 'gpu-cpu-reference-elastic' }
  };
}

// =============================================================================
// runFullDeformationAnalysisOnGpu
//
// End-to-end GPU pipeline: elastic gravity → K0 stress recovery → plastic
// geostatic correction → surface-load increments → (optional) c-φ safety.
//
// Inputs (CPU-side, all from solver.js):
//   device, mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet
//   gravityRhsFree     — assembled gravity load, free-DOF
//   surfaceLoadRhsFree — assembled surface load (full intensity), free-DOF
//                        (or null/zero array if no surface load)
//   sigmaInitialF64    — Voigt-6 initial σ_committed seed at every GP
//                        (length 6 * numGp).  Typically built from K0 recovery
//                        already on CPU; we just upload it.
//   options            — { analysisType, useStagedSurfaceLoad, safety… }
//
// Output (compatible shape with solver.js's existing CPU result):
//   {
//     converged, reason,
//     uFreeF64,                  // length numFree
//     uFullF64,                  // length ndof (Dirichlet DOFs zero)
//     sigmaCommittedF64,         // length 6 * numGp
//     csrPacked, pack,
//     diagnostics, history
//   }
// =============================================================================
export async function runFullDeformationAnalysisOnGpu({
  device,
  mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet,
  gravityRhsFree,
  surfaceLoadRhsFree = null,
  sigmaInitialF64 = null,
  porePressureByIntegrationPoint = null,
  options = {},
  warnings = [],
  onProgress = () => {}
}) {
  if (!device) throw new Error('runFullDeformationAnalysisOnGpu: a GPUDevice is required.');
  // 1. Build pack + assembly context.
  const pack = buildGpuMeshPack({
    mesh, elementCaches, regionConstitutiveByRegion,
    fixedDofSet, porePressureByIntegrationPoint, warnings
  });
  if (pack.numFree === 0) {
    throw new Error('runFullDeformationAnalysisOnGpu: no free DOFs.');
  }
  const elementType = elementCaches[0]?.kind === 't6' ? 't6' : 't3';
  const asmCtx = createGpuAssemblyContext({ device, pack, elementType });

  // 2. Initialize committed state.  σ_initial seed is REQUIRED — the caller
  //    (solver.js) plumbs `geostatic.initialField` from the standard
  //    pre-solve K0 recovery.  This is data piped through, not a CPU
  //    algorithm change: geostatic.initialField is computed unconditionally
  //    by the existing analysis prep regardless of which solver path runs.
  clearCommittedState(asmCtx);
  if (!sigmaInitialF64 || sigmaInitialF64.length !== 6 * pack.numGp) {
    throw new Error(
      `runFullDeformationAnalysisOnGpu: sigmaInitialF64 (length ${6 * pack.numGp}) is required.  ` +
      `Pass the flattened geostatic.initialField from the analysis prep.`
    );
  }
  uploadCommittedSigmaFromF64(asmCtx, sigmaInitialF64);

  // 3. Build the resident CG context (used by every linear solve below).
  const cgCtx = createResidentCgContext({
    device, ndof: pack.numFree, numNonzeros: pack.nnz
  });

  const history = { newton: [], loadSteps: [], safety: [] };
  const analysisType = options?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
  const requireSurfaceLoad = !!surfaceLoadRhsFree && surfaceLoadRhsFree.some((v) => v !== 0);

  // Progress-observer factory.  Each phase passes a label so the UI sees
  // "GPU geostatic Newton 3, ‖r‖=…" and "GPU CG iter 600, rel residual=…"
  // — matching the granularity of the CPU pipeline's progress messages.
  const makeProgressObservers = (phaseLabel, basePercent) => ({
    onNewtonProgress: ({ iter, residualNorm, rhsNorm }) => {
      const rel = rhsNorm > 0 ? residualNorm / rhsNorm : 0;
      onProgress({
        stage: 'solving',
        percent: Math.min(95, basePercent + Math.min(iter / 4, 5)),
        message: `GPU ${phaseLabel} Newton iter ${iter}, ‖r‖ = ${residualNorm.toExponential(2)} (rel ${rel.toExponential(2)})`
      });
    },
    onCgProgress: async ({ iterations, residualNorm, relativeResidual }) => {
      onProgress({
        stage: 'solving',
        percent: Math.min(95, basePercent + Math.min(iterations / 250, 4)),
        message: `GPU ${phaseLabel} CG iter ${iterations.toLocaleString()}, relative residual ${relativeResidual.toExponential(2)}`
      });
    }
  });

  // ---------------------------------------------------------------------------
  // Phase A — plastic geostatic correction (gravity-only Newton).
  //
  // The σ_initial seed encodes the engineer's reference state (K0).  We
  // verify it is consistent with the gravity RHS by running a full plastic
  // Newton with b = gravityRhs.  If σ_initial is admissible, this typically
  // converges in 1–2 iterations (residual is already near zero).
  // ---------------------------------------------------------------------------
  {
    const newton = await runPlasticNewtonOnGpu({
      asmCtx, cgCtx,
      bF64: gravityRhsFree,
      maxIter: Math.max(Math.round(options?.geostaticMaxIter || 32), 1),
      relTol: options?.residualRelTol ?? 1e-4,
      absTol: options?.residualAbsTol ?? 1e-3,
      ...makeProgressObservers('geostatic', 65)
    });
    history.newton.push({ phase: 'geostatic', ...summarizeNewton(newton) });
    if (!newton.converged) {
      return {
        converged: false, reason: `geostatic-plastic-correction-${newton.reason || 'failed'}`,
        diagnostics: { history }, pack
      };
    }
    newton.commit();
  }

  // ---------------------------------------------------------------------------
  // Phase B — surface load (if any).  Single-step or staged based on options.
  // ---------------------------------------------------------------------------
  if (requireSurfaceLoad) {
    const useStaged = options?.useStagedSurfaceLoad !== false;
    if (!useStaged) {
      // Direct full-load step.
      const bFull = combineFreeDofVectors(gravityRhsFree, surfaceLoadRhsFree, 1);
      const newton = await runPlasticNewtonOnGpu({
        asmCtx, cgCtx, bF64: bFull,
        maxIter: Math.max(Math.round(options?.nonlinearMaxIterations || 32), 1),
        relTol: options?.residualRelTol ?? 1e-4,
        absTol: options?.residualAbsTol ?? 1e-3,
        ...makeProgressObservers('surface-load', 75)
      });
      history.newton.push({ phase: 'load-direct', lambda: 1, ...summarizeNewton(newton) });
      if (!newton.converged) {
        return {
          converged: false, reason: `surface-load-direct-${newton.reason || 'failed'}`,
          diagnostics: { history }, pack
        };
      }
      newton.commit();
    } else {
      // Staged surface-load loop.
      const stagedResult = await runStagedSurfaceLoadOnGpu({
        asmCtx, cgCtx, gravityRhsFree, surfaceLoadRhsFree, options, history,
        makeProgressObservers
      });
      if (!stagedResult.converged) {
        return {
          converged: false, reason: stagedResult.reason,
          diagnostics: { history }, pack
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Phase C — c-φ safety (only when analysisType === 'safety-cphi').
  // ---------------------------------------------------------------------------
  let safetyResult = null;
  if (analysisType === 'safety-cphi') {
    safetyResult = await runSafetyOnGpu({
      asmCtx, cgCtx, gravityRhsFree, surfaceLoadRhsFree,
      pack, regionConstitutiveByRegion, options, history,
      makeProgressObservers
    });
  }

  // ---------------------------------------------------------------------------
  // Read back the final committed state.
  // ---------------------------------------------------------------------------
  const uFreeF64 = await readbackCommittedDisplacement(asmCtx);
  const sigmaCommittedF64 = await readbackCommittedSigma(asmCtx);
  const uFullF64 = new Float64Array(pack.ndof);
  for (let i = 0; i < pack.numFree; i += 1) uFullF64[pack.freeDofs[i]] = uFreeF64[i];

  return {
    converged: true,
    uFreeF64,
    uFullF64,
    sigmaCommittedF64,
    pack,
    safety: safetyResult,
    diagnostics: {
      strategy: 'gpu-resident-full',
      analysisType,
      elementType,
      numFree: pack.numFree,
      ndof: pack.ndof,
      numGp: pack.numGp,
      history
    }
  };
}

// =============================================================================
// Helper: combine two free-DOF vectors as a + λ b.
// =============================================================================
function combineFreeDofVectors(a, b, lambda) {
  const n = a.length;
  const out = new Float64Array(n);
  if (b && b.length === n) {
    for (let i = 0; i < n; i += 1) out[i] = a[i] + lambda * b[i];
  } else {
    for (let i = 0; i < n; i += 1) out[i] = a[i];
  }
  return out;
}

function summarizeNewton(newton) {
  return {
    converged: newton.converged,
    iterations: newton.iterations,
    residualNorm: newton.residualNorm,
    reason: newton.reason || null
  };
}

// =============================================================================
// Staged surface-load loop on GPU.  Mirrors the CPU adaptive-continuation
// pattern: grow load step on success, cut back on failure.
//
// Per accepted increment: commit() persists state, lambda advances.  On
// rejection: state is NOT committed, so the trial is rolled back simply by
// not committing.
// =============================================================================
async function runStagedSurfaceLoadOnGpu({
  asmCtx, cgCtx, gravityRhsFree, surfaceLoadRhsFree, options, history,
  makeProgressObservers = () => ({})
}) {
  let lambda = 0;
  let dLambda = Math.max(Math.min(Number(options?.initialLoadStep) || 0.25, 1), 1e-6);
  const minLoadStep = Math.max(Number(options?.minLoadStep) || 1e-4, 1e-6);
  const maxSteps = Math.max(Math.round(Number(options?.maxLoadSteps) || 256), 1);
  const grow = Math.max(Number(options?.plasticLoadStepGrowthFactor) || 1.05, 1);
  const cut  = Math.min(Math.max(Number(options?.plasticLoadStepCutbackFactor) || 0.4, 0.05), 0.95);

  for (let step = 0; step < maxSteps; step += 1) {
    if (lambda >= 1 - 1e-12) break;
    const trialLambda = Math.min(lambda + dLambda, 1);
    const bTrial = combineFreeDofVectors(gravityRhsFree, surfaceLoadRhsFree, trialLambda);
    const newton = await runPlasticNewtonOnGpu({
      asmCtx, cgCtx, bF64: bTrial,
      maxIter: Math.max(Math.round(options?.nonlinearMaxIterations || 32), 1),
      relTol: options?.residualRelTol ?? 1e-4,
      absTol: options?.residualAbsTol ?? 1e-3,
      ...makeProgressObservers(`load-step λ=${trialLambda.toFixed(2)}`, 75)
    });
    history.loadSteps.push({ step, lambda: trialLambda, ...summarizeNewton(newton) });
    if (newton.converged) {
      newton.commit();
      lambda = trialLambda;
      dLambda = Math.min(dLambda * grow, 1 - lambda + 1e-12);
    } else {
      dLambda *= cut;
      if (dLambda < minLoadStep) {
        return { converged: false, reason: `surface-load-step-too-small-at-${lambda.toExponential(2)}` };
      }
    }
  }
  return { converged: true, finalLambda: lambda };
}

// =============================================================================
// c-φ safety on GPU.  Outer ΣMsf bracket loop.
//
// For each ΣMsf trial:
//   1. Reduce material strengths (cohesion, tan φ) → repack matParams.
//   2. Restore committed state to the pre-safety reference snapshot.
//   3. Run plastic Newton with the (gravity + load) RHS.
//   4. If Newton converges, the slope is safe at this ΣMsf — try larger.
//      If it fails, the slope is unsafe — try smaller.
//   5. Bisect until bracket is < bracketTol.
// =============================================================================
import { reduceMaterialStrengthForSafety } from '../material.js';

async function runSafetyOnGpu({
  asmCtx, cgCtx, gravityRhsFree, surfaceLoadRhsFree,
  pack, regionConstitutiveByRegion, options, history,
  makeProgressObservers = () => ({})
}) {
  const sigmaMsfMax = Math.max(Number(options?.safetySigmaMsfMax) || 3.0, 1);
  const bracketTol  = Math.max(Number(options?.safetySigmaMsfBracketTolerance) || 0.01, 1e-4);
  const initialIncr = Math.max(Number(options?.safetyInitialSigmaMsfIncrement) || 0.10, 1e-3);
  const growth      = Math.max(Number(options?.safetySigmaMsfGrowthFactor) || 1.50, 1.05);
  const maxTrials   = Math.max(Math.round(Number(options?.safetyMaxSearchTrials) || 32), 1);

  // 1. Save the pre-safety committed state.
  const snapshot = await snapshotCommittedState(asmCtx);

  // Build the b vector for each safety run (gravity + full surface load).
  const bSafety = combineFreeDofVectors(gravityRhsFree, surfaceLoadRhsFree, 1);

  let sigmaLo = 1;            // safe (we know the unreduced state is safe by hypothesis)
  let sigmaHi = null;          // unsafe (to be bracketed)
  let sigmaTrial = 1 + initialIncr;
  let dIncr = initialIncr;
  let lastConvergedSigma = 1;

  for (let t = 0; t < maxTrials; t += 1) {
    if (sigmaTrial > sigmaMsfMax) sigmaTrial = sigmaMsfMax;
    // Repack reduced material params.
    const reducedMat = packReducedMatParams(pack, regionConstitutiveByRegion, sigmaTrial);
    asmCtx.device.queue.writeBuffer(asmCtx.buffers.matParams, 0, reducedMat);
    // Restore committed state.
    await restoreCommittedState(asmCtx, snapshot);
    // Run plastic Newton.
    const newton = await runPlasticNewtonOnGpu({
      asmCtx, cgCtx, bF64: bSafety,
      maxIter: Math.max(Math.round(options?.nonlinearMaxIterations || 32), 1),
      relTol: options?.residualRelTol ?? 1e-4,
      absTol: options?.residualAbsTol ?? 1e-3,
      ...makeProgressObservers(`safety ΣMsf=${sigmaTrial.toFixed(3)}`, 80)
    });
    history.safety.push({ trial: t, sigmaMsf: sigmaTrial, ...summarizeNewton(newton) });
    if (newton.converged) {
      // Safe at this Σ.  Try larger.
      lastConvergedSigma = sigmaTrial;
      sigmaLo = sigmaTrial;
      if (sigmaHi !== null && (sigmaHi - sigmaLo) < bracketTol) {
        break;
      }
      // Note: do NOT commit — we want the snapshot to be the pre-safety state,
      // not the converged state at this Σ.
      if (sigmaHi === null) {
        dIncr *= growth;
        sigmaTrial = Math.min(sigmaTrial + dIncr, sigmaMsfMax);
      } else {
        sigmaTrial = 0.5 * (sigmaLo + sigmaHi);
      }
    } else {
      // Unsafe at this Σ.  Bracket from above.
      sigmaHi = sigmaTrial;
      if ((sigmaHi - sigmaLo) < bracketTol) break;
      sigmaTrial = 0.5 * (sigmaLo + sigmaHi);
    }
    if (Math.abs(sigmaTrial - sigmaMsfMax) < 1e-12 && sigmaHi === null) break;
  }
  // Restore committed state to the converged-at-final-Σ run isn't kept; we
  // restore the pre-safety reference so reading-back σ gives the unreduced state.
  await restoreCommittedState(asmCtx, snapshot);
  // Restore the original (unreduced) matParams.
  const originalMat = packReducedMatParams(pack, regionConstitutiveByRegion, 1);
  asmCtx.device.queue.writeBuffer(asmCtx.buffers.matParams, 0, originalMat);

  return {
    fos: lastConvergedSigma,
    bracket: sigmaHi !== null ? [sigmaLo, sigmaHi] : [sigmaLo, null],
    converged: true
  };
}

// Pack reduced material params (sin φ, cos φ, sin ψ, cos ψ, c, σ_T, K, G) for
// every region into a Float32Array of DS pairs, ready to be uploaded to the
// matParams buffer.
function packReducedMatParams(pack, regionConstitutiveByRegion, sigmaMsf) {
  const numMaterials = pack.numMaterials;
  const out = new Float32Array(2 * 8 * numMaterials);
  const f64 = new Float64Array(8 * numMaterials);
  for (let matIdx = 0; matIdx < numMaterials; matIdx += 1) {
    const regionIndex = pack.matToRegion[matIdx];
    const constitutive = regionConstitutiveByRegion.get(regionIndex);
    const baseParams = constitutive?.materialParameters || {};
    const reduced = sigmaMsf > 1 + 1e-12
      ? reduceMaterialStrengthForSafety(baseParams, sigmaMsf)
      : baseParams;
    const phi = ((Number(reduced?.phiEffDeg) || 0) * Math.PI) / 180;
    const psi = ((Number(reduced?.psiEffDeg) || 0) * Math.PI) / 180;
    const c = Number(reduced?.cEff) || 0;
    const sigmaT = Number(reduced?.sigmaTAllow) || 0;
    const E = Math.max(Number(reduced?.Emc) || 1000, 1);
    const nu = Math.max(Math.min(Number(reduced?.nu) || 0.3, 0.499), -0.999);
    const KBulk = E / (3 * (1 - 2 * nu));
    const G = E / (2 * (1 + nu));
    f64[matIdx * 8 + 0] = Math.sin(phi);
    f64[matIdx * 8 + 1] = Math.cos(phi);
    f64[matIdx * 8 + 2] = Math.sin(psi);
    f64[matIdx * 8 + 3] = Math.cos(psi);
    f64[matIdx * 8 + 4] = c;
    f64[matIdx * 8 + 5] = sigmaT;
    f64[matIdx * 8 + 6] = KBulk;
    f64[matIdx * 8 + 7] = G;
  }
  for (let i = 0; i < f64.length; i += 1) {
    const v = f64[i];
    const hi = Math.fround(v);
    out[2 * i] = hi;
    out[2 * i + 1] = Math.fround(v - hi);
  }
  return out;
}
