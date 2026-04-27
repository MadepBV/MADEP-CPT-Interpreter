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
  readbackRhsFree
} from './gpu-assembly.js';
import {
  createResidentCgContext, uploadDsCsr, uploadBlockJacobi, uploadDsVector,
  solveResidentCg
} from './resident-cg.js';

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
