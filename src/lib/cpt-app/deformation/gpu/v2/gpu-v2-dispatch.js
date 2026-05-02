// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GPU pipeline v2 — dispatch primitives.
// =============================================================================
//
// Pure functions over a v2 ctx (from `gpu-v2-state.js`).  Each function records
// dispatches into the caller-supplied `encoder` so command buffers can be
// batched.  Async functions that need a readback create their own encoder and
// submit; everything else stays sync.
//
// The names match the conceptual operations from the design doc:
//
//   buildElasticDPerGp          one-shot D pack from matParams
//   computeStrain               ε_total = B u
//   computeTrialStress          σ_trial = σ_committed + D_e Δε
//   computeReturnMapping        σ_returned, branchKind ← MC return mapping
//   computeInternalForce        per-element ∑_g w·|J| Bᵀσ → elemScatter
//   scatterFreeRhs              elemScatter → free-DOF vector via incidence list
//   computeResidual             r := b - F_int
//   buildBlockJacobiPrecond     diag(K) + 2×2 inverse blocks (one-shot per Newton step)
//   matvecKx                    matrix-free K·x
//   applyJacobi                 z := mInv · r
//   applyBlockJacobi            z := M_block · r
//   axpy / axpby / dot          DS BLAS over free-DOF vectors
//   resetStatus / convergeFlag  GPU-resident convergence flag
//
// All buffers are referenced by name on `ctx.buffers`; this gives callers
// the flexibility to reuse helpers across CG / BiCGStab / Newton without
// hard-coding which buffer is the "matvec source".

import { unpackDsScalar, packDsVector } from '../resident-buffers.js';
import { WG } from './gpu-v2-state.js';

// Dot kernels store one DS scalar as a storage-buffer vec2<f32> (8 bytes).
// Do not use resident-buffers' DS_SCALAR_BYTES here: that constant is 16 bytes
// for uniform-buffer scalar padding. Mixing the two made paired dot readbacks
// read the padding of the first result as the second result on Metal.
const DS_DOT_RESULT_BYTES = 8;

function usage(name) {
  return typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage[name] : 0;
}

function bg(device, layout, entries) {
  return device.createBindGroup({
    layout,
    entries: entries.map((b, i) => ({ binding: i, resource: { buffer: b } }))
  });
}
function pass1(encoder, pipeline, bindGroup, workgroups) {
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(workgroups);
  pass.end();
}

// -----------------------------------------------------------------------------
// One-shot D-pack precompute (elastic).
// -----------------------------------------------------------------------------
export function dispatchBuildElasticD(ctx, encoder) {
  const { device, pipelines, buffers, uniforms, numWgGp } = ctx;
  const grp = bg(device, pipelines.buildD.bgLayout,
    [buffers.matParams, buffers.matIndex, buffers.dPerGp, uniforms.numGp]);
  pass1(encoder, pipelines.buildD.pipeline, grp, numWgGp);
}

// -----------------------------------------------------------------------------
// Strain ε_total = B · u (one thread per GP).  uvec is whichever DS-packed
// global vector you pass — typically Δu (u - u_committed) for plastic Newton.
// -----------------------------------------------------------------------------
export function dispatchStrain(ctx, encoder, uvecBuf, strainOutBuf) {
  const { device, pipelines, buffers, uniforms, numWgGp } = ctx;
  const grp = bg(device, pipelines.strain.bgLayout,
    [uvecBuf, buffers.bMatrices, buffers.dofMap, strainOutBuf, uniforms.numEl]);
  pass1(encoder, pipelines.strain.pipeline, grp, numWgGp);
}

// -----------------------------------------------------------------------------
// Trial stress: σ_trial = σ_committed + D_e · Δε.
// -----------------------------------------------------------------------------
export function dispatchTrialStress(ctx, encoder) {
  const { device, pipelines, buffers, uniforms, numWgGp } = ctx;
  const grp = bg(device, pipelines.trialStress.bgLayout,
    [buffers.sigmaCommitted, buffers.deltaEps, buffers.matParams, buffers.matIndex,
     buffers.sigmaTrial, uniforms.numGp]);
  pass1(encoder, pipelines.trialStress.pipeline, grp, numWgGp);
}

// -----------------------------------------------------------------------------
// MC return mapping (reuses v1's KERNEL_MC_RETURN_WGSL).  Reads sigmaTrial,
// writes sigmaReturned, branchKind, tangentVoigt3, mcConverged.
// -----------------------------------------------------------------------------
export function dispatchReturnMapping(ctx, encoder) {
  const { device, pipelines, buffers, uniforms, numWgGp } = ctx;
  const grp = bg(device, pipelines.mcReturn.bgLayout,
    [buffers.sigmaTrial, buffers.matIndex, buffers.matParams,
     buffers.sigmaReturned, buffers.branchKind, buffers.tangentVoigt3,
     buffers.mcConverged, uniforms.numGp]);
  pass1(encoder, pipelines.mcReturn.pipeline, grp, numWgGp);
}

// -----------------------------------------------------------------------------
// Internal force: σ_returned (Voigt-6) → σ_voigt3 (xx, yy, xy) → per-element
// ∑_g w·|J| Bᵀσ → elemScatter → scatter to fInt.
//
// v1's internal-force kernel expects 3 DS per GP (in-plane components only),
// while v2's MC return mapping writes the full Voigt-6 (xx, yy, zz, xy, yz,
// xz).  The slice kernel pulls out (xx, yy, xy) into a dedicated 3-DS-per-GP
// buffer that the internal-force kernel can consume directly.
// -----------------------------------------------------------------------------
export function dispatchInternalForce(ctx, encoder) {
  const { device, pipelines, buffers, uniforms, numWgEl, numWg, numWgGp } = ctx;
  // Step 1: slice Voigt-6 → Voigt-3 in-plane stress.
  const grpSlice = bg(device, pipelines.stressSlice.bgLayout,
    [buffers.sigmaReturned, buffers.sigmaVoigt3, uniforms.numGp]);
  pass1(encoder, pipelines.stressSlice.pipeline, grpSlice, numWgGp);
  // Step 2: per-element ∑_g w·|J| Bᵀσ.
  const grpIF = bg(device, pipelines.internalForce.bgLayout,
    [buffers.bMatrices, buffers.gpWeights, buffers.sigmaVoigt3,
     buffers.elemScatter, uniforms.numEl]);
  pass1(encoder, pipelines.internalForce.pipeline, grpIF, numWgEl);
  // Step 3: scatter element contributions to free DOFs.
  const grpS = bg(device, pipelines.scatter.bgLayout,
    [buffers.elemScatter, buffers.forceIncPtr, buffers.forceIncList,
     buffers.fInt, uniforms.numFree]);
  pass1(encoder, pipelines.scatter.pipeline, grpS, numWg);
}

// -----------------------------------------------------------------------------
// Residual r := b - F_int  (one thread per free DOF, DS subtract).
// -----------------------------------------------------------------------------
export function dispatchResidualFromFint(ctx, encoder) {
  const { device, pipelines, buffers, uniforms, numWg } = ctx;
  const grp = bg(device, pipelines.residFromFint.bgLayout,
    [buffers.b, buffers.fInt, buffers.r, uniforms.numFree]);
  pass1(encoder, pipelines.residFromFint.pipeline, grp, numWg);
}

// -----------------------------------------------------------------------------
// Matrix-free matvec: dst := K · src   (element kernel + scatter).
// -----------------------------------------------------------------------------
export function dispatchMatvec(ctx, encoder, srcBuf, dstBuf) {
  const { device, pipelines, buffers, uniforms, numWgEl, numWg } = ctx;
  const kxPipeline = ctx.useAlgorithmicTangent === true ? pipelines.kxTangent : pipelines.kx;
  const tangentBuffer = ctx.useAlgorithmicTangent === true ? buffers.tangentVoigt3 : buffers.dPerGp;
  const grpKx = bg(device, kxPipeline.bgLayout,
    [srcBuf, buffers.bMatrices, buffers.gpWeights, tangentBuffer,
     buffers.dofMap, buffers.elemScatter, uniforms.numEl]);
  pass1(encoder, kxPipeline.pipeline, grpKx, numWgEl);
  const grpS = bg(device, pipelines.scatter.bgLayout,
    [buffers.elemScatter, buffers.forceIncPtr, buffers.forceIncList,
     dstBuf, uniforms.numFree]);
  pass1(encoder, pipelines.scatter.pipeline, grpS, numWg);
}

// -----------------------------------------------------------------------------
// Build preconditioner.  Two flavors gated on ctx.preconditioner:
//   'jacobi'        → diag(K) extract → mInv = 1/diag
//   'block-jacobi'  → per-element K_e build → 2×2 nodal block inverses
// -----------------------------------------------------------------------------
export function dispatchBuildPreconditioner(ctx, encoder) {
  if (ctx.preconditioner === 'block-jacobi') {
    return dispatchBuildBlockJacobi(ctx, encoder);
  }
  return dispatchBuildScalarJacobi(ctx, encoder);
}

export function dispatchBuildScalarJacobi(ctx, encoder) {
  const { device, pipelines, buffers, uniforms, numWgEl, numWg } = ctx;
  const diagPipeline = ctx.useAlgorithmicTangent === true ? pipelines.diagTangent : pipelines.diag;
  const tangentBuffer = ctx.useAlgorithmicTangent === true ? buffers.tangentVoigt3 : buffers.dPerGp;
  // diag element scatter → diag global → recip
  const grpDiag = bg(device, diagPipeline.bgLayout,
    [buffers.bMatrices, buffers.gpWeights, tangentBuffer,
     buffers.elemScatter, uniforms.numEl]);
  pass1(encoder, diagPipeline.pipeline, grpDiag, numWgEl);
  const grpScatter = bg(device, pipelines.scatter.bgLayout,
    [buffers.elemScatter, buffers.forceIncPtr, buffers.forceIncList,
     buffers.diag, uniforms.numFree]);
  pass1(encoder, pipelines.scatter.pipeline, grpScatter, numWg);
  const grpRecip = bg(device, pipelines.recip.bgLayout,
    [buffers.diag, buffers.mInv, uniforms.numFree]);
  pass1(encoder, pipelines.recip.pipeline, grpRecip, numWg);
}

export function dispatchBuildBlockJacobi(ctx, encoder) {
  const { device, pipelines, buffers, uniforms, numWgEl, numWg, numNodePairs } = ctx;
  const buildPipeline = ctx.useAlgorithmicTangent === true ? pipelines.blockBuildTangent : pipelines.blockBuild;
  const tangentBuffer = ctx.useAlgorithmicTangent === true ? buffers.tangentVoigt3 : buffers.dPerGp;
  // 1) Build per-element K_e flat in `kElem`.
  const grpBuild = bg(device, buildPipeline.bgLayout,
	    [buffers.bMatrices, buffers.gpWeights, tangentBuffer,
	     buffers.kElem, uniforms.numEl]);
  pass1(encoder, buildPipeline.pipeline, grpBuild, numWgEl);
  // 2) Extract the diagonal from the already-built K_e scratch. Recomputing
  //    B^T D B through the scalar-Jacobi path doubles block-preconditioner
  //    build cost and can amplify tangent inconsistencies branch-by-branch.
  const grpDiag = bg(device, pipelines.blockDiagFromKElem.bgLayout,
    [buffers.kElem, buffers.elemScatter, uniforms.numEl]);
  pass1(encoder, pipelines.blockDiagFromKElem.pipeline, grpDiag, numWgEl);
  const grpScatter = bg(device, pipelines.scatter.bgLayout,
    [buffers.elemScatter, buffers.forceIncPtr, buffers.forceIncList,
     buffers.diag, uniforms.numFree]);
  pass1(encoder, pipelines.scatter.pipeline, grpScatter, numWg);
  // 3) Build 2×2 inverses per node-pair.
  const grpInv = bg(device, pipelines.blockInvert.bgLayout,
    [buffers.kElem, buffers.diag, buffers.nodePairOffPtr,
     buffers.nodePairOffList, buffers.nodePairOffPtrC,
     buffers.nodePairOffListC, buffers.nodePairFreeIdx,
     buffers.blocks, uniforms.numNodePairs]);
  pass1(encoder, pipelines.blockInvert.pipeline, grpInv, Math.ceil(numNodePairs / WG));
}

// -----------------------------------------------------------------------------
// Apply preconditioner: dst := M⁻¹ · src.
// -----------------------------------------------------------------------------
export function dispatchApplyPreconditioner(ctx, encoder, srcBuf, dstBuf) {
  if (ctx.preconditioner === 'block-jacobi') {
    return dispatchApplyBlockJacobi(ctx, encoder, srcBuf, dstBuf);
  }
  return dispatchApplyScalarJacobi(ctx, encoder, srcBuf, dstBuf);
}
export function dispatchApplyScalarJacobi(ctx, encoder, srcBuf, dstBuf) {
  const { device, pipelines, buffers, uniforms, numWg } = ctx;
  const grp = bg(device, pipelines.applyJacobi.bgLayout,
    [buffers.mInv, srcBuf, dstBuf, uniforms.numFree]);
  pass1(encoder, pipelines.applyJacobi.pipeline, grp, numWg);
}
export function dispatchApplyBlockJacobi(ctx, encoder, srcBuf, dstBuf) {
  const { device, pipelines, buffers, uniforms, numWg } = ctx;
  const grp = bg(device, pipelines.blockApply.bgLayout,
    [buffers.blocks, buffers.freeToPair, buffers.freeIsSecond,
     buffers.freeMate, srcBuf, dstBuf, uniforms.numFree]);
  pass1(encoder, pipelines.blockApply.pipeline, grp, numWg);
}

// -----------------------------------------------------------------------------
// BLAS dispatchers — caller writes the small storage-backed parameter buffer
// first via ctx.helpers.
// -----------------------------------------------------------------------------
export function dispatchAxpy(ctx, encoder, alphaUniformBuf, srcBuf, dstBuf) {
  const { device, pipelines, numWg } = ctx;
  const grp = bg(device, pipelines.axpy.bgLayout, [srcBuf, dstBuf, alphaUniformBuf]);
  pass1(encoder, pipelines.axpy.pipeline, grp, numWg);
}
export function dispatchAxpby(ctx, encoder, abUniformBuf, srcBuf, dstBuf) {
  const { device, pipelines, numWg } = ctx;
  const grp = bg(device, pipelines.axpby.bgLayout, [srcBuf, dstBuf, abUniformBuf]);
  pass1(encoder, pipelines.axpby.pipeline, grp, numWg);
}

export async function dispatchDotAndRead(ctx, srcA, srcB) {
  const { device, pipelines, buffers, numWg } = ctx;
  const enc = device.createCommandEncoder({ label: 'mf-dot' });
  const grp1 = bg(device, pipelines.dot1.bgLayout,
    [srcA, srcB, buffers.dotPartials]);
  pass1(enc, pipelines.dot1.pipeline, grp1, numWg);
  const grp2 = bg(device, pipelines.dot2.bgLayout,
    [buffers.dotPartials, buffers.dotResult]);
  pass1(enc, pipelines.dot2.pipeline, grp2, 1);
  enc.copyBufferToBuffer(buffers.dotResult, 0, buffers.dotResultRb, 0, DS_DOT_RESULT_BYTES);
  device.queue.submit([enc.finish()]);
  await buffers.dotResultRb.mapAsync(GPUMapMode.READ);
  const view = new Float32Array(buffers.dotResultRb.getMappedRange().slice(0, DS_DOT_RESULT_BYTES));
  buffers.dotResultRb.unmap();
  return unpackDsScalar(view);
}

export async function dispatchTwoDotsAndRead(ctx, a0, b0, a1, b1) {
  const { device, pipelines, buffers, numWg } = ctx;
  const enc = device.createCommandEncoder({ label: 'mf-dot-pair' });
  const grpA1 = bg(device, pipelines.dot1.bgLayout,
    [a0, b0, buffers.dotPartials]);
  pass1(enc, pipelines.dot1.pipeline, grpA1, numWg);
  const grpA2 = bg(device, pipelines.dot2.bgLayout,
    [buffers.dotPartials, buffers.dotResult]);
  pass1(enc, pipelines.dot2.pipeline, grpA2, 1);
  const grpB1 = bg(device, pipelines.dot1.bgLayout,
    [a1, b1, buffers.dotPartials2]);
  pass1(enc, pipelines.dot1.pipeline, grpB1, numWg);
  const grpB2 = bg(device, pipelines.dot2.bgLayout,
    [buffers.dotPartials2, buffers.dotResult2]);
  pass1(enc, pipelines.dot2.pipeline, grpB2, 1);
  enc.copyBufferToBuffer(buffers.dotResult, 0, buffers.dotPairRb, 0, DS_DOT_RESULT_BYTES);
  enc.copyBufferToBuffer(buffers.dotResult2, 0, buffers.dotPairRb, DS_DOT_RESULT_BYTES, DS_DOT_RESULT_BYTES);
  device.queue.submit([enc.finish()]);
  await buffers.dotPairRb.mapAsync(GPUMapMode.READ);
  const view = new Float32Array(buffers.dotPairRb.getMappedRange().slice(0, 2 * DS_DOT_RESULT_BYTES));
  buffers.dotPairRb.unmap();
  return [
    unpackDsScalar(view.subarray(0, 2)),
    unpackDsScalar(view.subarray(2, 4))
  ];
}

export async function readDsVector(ctx, srcBuffer, logicalLength, label = 'mf-read-ds') {
  const { device } = ctx;
  const byteLength = Math.max(0, logicalLength | 0) * 8;
  const rb = device.createBuffer({
    size: Math.max(byteLength, 16),
    usage: usage('COPY_DST') | usage('MAP_READ'),
    label
  });
  const enc = device.createCommandEncoder({ label });
  if (byteLength > 0) enc.copyBufferToBuffer(srcBuffer, 0, rb, 0, byteLength);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const view = new Float32Array(rb.getMappedRange().slice(0, byteLength));
  rb.unmap();
  rb.destroy?.();
  const out = new Float64Array(logicalLength);
  for (let i = 0; i < logicalLength; i += 1) out[i] = view[2 * i] + view[2 * i + 1];
  return out;
}

export async function readU32Vector(ctx, srcBuffer, logicalLength, label = 'mf-read-u32') {
  const { device } = ctx;
  const byteLength = Math.max(0, logicalLength | 0) * 4;
  const rb = device.createBuffer({
    size: Math.max(byteLength, 16),
    usage: usage('COPY_DST') | usage('MAP_READ'),
    label
  });
  const enc = device.createCommandEncoder({ label });
  if (byteLength > 0) enc.copyBufferToBuffer(srcBuffer, 0, rb, 0, byteLength);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const out = new Uint32Array(rb.getMappedRange().slice(0, byteLength));
  rb.unmap();
  rb.destroy?.();
  return out;
}

export async function replaceStorageBufferData(ctx, key, srcTypedArray, label = `mf-replace-${key}`) {
  const { device, buffers } = ctx;
  if (!buffers || !key) throw new Error('replaceStorageBufferData: missing ctx.buffers/key');
  if (!srcTypedArray || srcTypedArray.byteLength === 0) return buffers[key];
  if (srcTypedArray instanceof Float64Array) {
    throw new Error(`replaceStorageBufferData(${key}): raw Float64Array cannot be uploaded to WebGPU; pack it to DS Float32Array first.`);
  }
  // Drain any in-flight work that may still be reading the buffer.
  if (typeof device.queue.onSubmittedWorkDone === 'function') {
    await device.queue.onSubmittedWorkDone();
  }
  const target = buffers[key];
  if (!target) {
    throw new Error(`replaceStorageBufferData: ctx.buffers.${key} is missing — was the context built?`);
  }
  // Belt-and-suspenders: try BOTH `queue.writeBuffer` and a staged
  // copyBufferToBuffer through a fresh mappedAtCreation source.  Either path
  // alone has been observed to silently drop bytes on Apple Metal in the
  // deformation worker context; combined, the result should always reflect
  // the intended data.  WebGPU serializes these in queue order, so the
  // staged copy lands second and is what the next compute kernel reads.
  device.queue.writeBuffer(target, 0, srcTypedArray);
  // Staged copy from a fresh mapped-at-creation buffer.  We keep the source
  // separate from `target` (which is STORAGE) and dispose it after the
  // submit completes.
  const byteLength = srcTypedArray.byteLength;
  const stagingSize = Math.max((byteLength + 3) & ~3, 4);
  const STAGING = (typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage.COPY_SRC : 0x4);
  const staging = device.createBuffer({
    size: stagingSize,
    usage: STAGING,
    mappedAtCreation: true,
    label: `${label}-staging`
  });
  // Copy bytes into the mapped range, regardless of source TypedArray view.
  const range = staging.getMappedRange();
  if (srcTypedArray instanceof Float32Array) {
    new Float32Array(range).set(srcTypedArray);
  } else if (srcTypedArray instanceof Uint32Array) {
    new Uint32Array(range).set(srcTypedArray);
  } else if (srcTypedArray instanceof Int32Array) {
    new Int32Array(range).set(srcTypedArray);
  } else {
    new Uint8Array(range).set(new Uint8Array(srcTypedArray.buffer, srcTypedArray.byteOffset, byteLength));
  }
  staging.unmap();
  const enc = device.createCommandEncoder({ label: `${label}-staging-enc` });
  enc.copyBufferToBuffer(staging, 0, target, 0, byteLength);
  device.queue.submit([enc.finish()]);
  // Free the staging buffer once the submit drains.
  if (typeof device.queue.onSubmittedWorkDone === 'function') {
    await device.queue.onSubmittedWorkDone();
    if (staging.destroy) staging.destroy();
  }
  return target;
}

export async function readFint(ctx) {
  return readDsVector(ctx, ctx.buffers.fInt, ctx.numFree, 'mf-read-fint');
}

export async function readBranchKind(ctx) {
  return readU32Vector(ctx, ctx.buffers.branchKind, ctx.numGp, 'mf-read-branchKind');
}

export async function readMcConverged(ctx) {
  return readU32Vector(ctx, ctx.buffers.mcConverged, ctx.numGp, 'mf-read-mcConv');
}

export async function readMcStats(ctx) {
  const { device, pipelines, buffers, numWgGp } = ctx;
  const enc = device.createCommandEncoder({ label: 'mf-read-mc-stats' });
  const grp = bg(device, pipelines.mcStats.bgLayout,
    [buffers.mcConverged, buffers.branchKind, buffers.mcStatsPartials]);
  pass1(enc, pipelines.mcStats.pipeline, grp, Math.max(numWgGp, 1));
  const grpFinal = bg(device, pipelines.mcStatsFinal.bgLayout,
    [buffers.mcStatsPartials, buffers.mcStats]);
  pass1(enc, pipelines.mcStatsFinal.pipeline, grpFinal, 1);
  enc.copyBufferToBuffer(buffers.mcStats, 0, buffers.mcStatsRb, 0, 16);
  device.queue.submit([enc.finish()]);
  await buffers.mcStatsRb.mapAsync(GPUMapMode.READ);
  const view = new Uint32Array(buffers.mcStatsRb.getMappedRange().slice(0));
  buffers.mcStatsRb.unmap();
  return {
    failed: view[0] >>> 0,
    plastic: view[1] >>> 0,
    total: view[2] >>> 0
  };
}

export function recordCopyBuffer(ctx, encoder, srcBuffer, dstBuffer, byteLength) {
  if (byteLength > 0) encoder.copyBufferToBuffer(srcBuffer, 0, dstBuffer, 0, byteLength);
}

export function createV2Snapshot(ctx, label = 'mf-snapshot') {
  const { device, numFree, numGp } = ctx;
  const C = usage('COPY_SRC') | usage('COPY_DST');
  return {
    u: device.createBuffer({ size: Math.max(numFree * 8, 16), usage: C, label: `${label}-u` }),
    sigma: device.createBuffer({ size: Math.max(numGp * 6 * 8, 16), usage: C, label: `${label}-sigma` }),
    branch: device.createBuffer({ size: Math.max(numGp * 4, 16), usage: C, label: `${label}-branch` })
  };
}

export function destroyV2Snapshot(snapshot) {
  snapshot?.u?.destroy?.();
  snapshot?.sigma?.destroy?.();
  snapshot?.branch?.destroy?.();
}

export function recordSnapshotState(ctx, encoder, snapshot) {
  const { buffers, numFree, numGp } = ctx;
  recordCopyBuffer(ctx, encoder, buffers.utotal, snapshot.u, numFree * 8);
  recordCopyBuffer(ctx, encoder, buffers.sigmaCommitted, snapshot.sigma, numGp * 6 * 8);
  recordCopyBuffer(ctx, encoder, buffers.branchKind, snapshot.branch, numGp * 4);
}

export function recordRestoreState(ctx, encoder, snapshot) {
  const { buffers, numFree, numGp } = ctx;
  recordCopyBuffer(ctx, encoder, snapshot.u, buffers.utotal, numFree * 8);
  recordCopyBuffer(ctx, encoder, snapshot.u, buffers.uPrev, numFree * 8);
  recordCopyBuffer(ctx, encoder, snapshot.sigma, buffers.sigmaCommitted, numGp * 6 * 8);
  recordCopyBuffer(ctx, encoder, snapshot.branch, buffers.branchKind, numGp * 4);
}

export function recordDisplacementIncrement(ctx, encoder) {
  const { buffers, uniforms } = ctx;
  dispatchAxpby(ctx, encoder, uniforms.axpbyInit, buffers.utotal, buffers.du);
  dispatchAxpy(ctx, encoder, uniforms.axpyNegOne, buffers.uPrev, buffers.du);
}

export function recordPlasticResidual(ctx, encoder) {
  recordDisplacementIncrement(ctx, encoder);
  dispatchStrain(ctx, encoder, ctx.buffers.du, ctx.buffers.deltaEps);
  dispatchTrialStress(ctx, encoder);
  dispatchReturnMapping(ctx, encoder);
  dispatchInternalForce(ctx, encoder);
  dispatchResidualFromFint(ctx, encoder);
}

export function recordCommitPlasticState(ctx, encoder) {
  const { buffers, numFree, numGp } = ctx;
  recordCopyBuffer(ctx, encoder, buffers.sigmaReturned, buffers.sigmaCommitted, numGp * 6 * 8);
  recordCopyBuffer(ctx, encoder, buffers.utotal, buffers.uPrev, numFree * 8);
}

// Dot whose result lives on-device in `buffers.dotResult`.  No readback.
export function dispatchDotOnDevice(ctx, encoder, srcA, srcB) {
  const { device, pipelines, buffers, numWg } = ctx;
  const grp1 = bg(device, pipelines.dot1.bgLayout,
    [srcA, srcB, buffers.dotPartials]);
  pass1(encoder, pipelines.dot1.pipeline, grp1, numWg);
  const grp2 = bg(device, pipelines.dot2.bgLayout,
    [buffers.dotPartials, buffers.dotResult]);
  pass1(encoder, pipelines.dot2.pipeline, grp2, 1);
}

// -----------------------------------------------------------------------------
// GPU-resident convergence test.
// -----------------------------------------------------------------------------
export function dispatchResetStatus(ctx, encoder) {
  const { device, pipelines, buffers } = ctx;
  const grp = bg(device, pipelines.resetStatus.bgLayout, [buffers.status]);
  pass1(encoder, pipelines.resetStatus.pipeline, grp, 1);
}
export function dispatchConvergeFlag(ctx, encoder) {
  const { device, pipelines, buffers, uniforms } = ctx;
  const grp = bg(device, pipelines.convergeFlag.bgLayout,
    [buffers.dotResult, buffers.status, uniforms.converge]);
  pass1(encoder, pipelines.convergeFlag.pipeline, grp, 1);
}
export async function readStatus(ctx) {
  const { device, buffers } = ctx;
  const enc = device.createCommandEncoder({ label: 'mf-readStatus' });
  enc.copyBufferToBuffer(buffers.status, 0, buffers.statusRb, 0, 16);
  device.queue.submit([enc.finish()]);
  await buffers.statusRb.mapAsync(GPUMapMode.READ);
  const view = new Uint32Array(buffers.statusRb.getMappedRange().slice(0));
  buffers.statusRb.unmap();
  return { converged: view[0] === 1, iter: view[1] };
}

// -----------------------------------------------------------------------------
// Initial-state uploads (helpers used by entry points).
// -----------------------------------------------------------------------------
export async function uploadInitialState(ctx, { uF64, sigmaCommittedF64, bF64, preserveSigmaCommitted = false }) {
  const { numFree, numGp } = ctx;
  const u8 = packDsVector(uF64 || new Float64Array(numFree));
  await replaceStorageBufferData(ctx, 'utotal', u8, 'mf-upload-utotal');
  // Seed uPrev = utotal at the start of a new load step (separate copy so
  // utotal stays writable independently).
  await replaceStorageBufferData(ctx, 'uPrev', u8, 'mf-upload-uprev');
  if (sigmaCommittedF64) {
    await replaceStorageBufferData(ctx, 'sigmaCommitted', packDsVector(sigmaCommittedF64), 'mf-upload-sigma-committed');
  } else if (!preserveSigmaCommitted) {
    // Default: zero σ_committed unless caller explicitly asks to preserve
    // (e.g., second load step after gravity has committed σ on-device).
    await replaceStorageBufferData(ctx, 'sigmaCommitted', packDsVector(new Float64Array(numGp * 6)), 'mf-upload-sigma-zero');
  }
  if (bF64) {
    await replaceStorageBufferData(ctx, 'b', packDsVector(bF64), 'mf-upload-rhs-b');
  }
}

// -----------------------------------------------------------------------------
// Read u back to host as Float64Array (final solution after Newton).
// -----------------------------------------------------------------------------
export async function readUtotal(ctx) {
  const { device, buffers, numFree } = ctx;
  const RB = (typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage : { COPY_DST: 8, MAP_READ: 1 });
  const rb = device.createBuffer({
    size: numFree * 8, usage: RB.COPY_DST | RB.MAP_READ, label: 'mf-uRb'
  });
  const enc = device.createCommandEncoder({ label: 'mf-readU' });
  enc.copyBufferToBuffer(buffers.utotal, 0, rb, 0, numFree * 8);
  device.queue.submit([enc.finish()]);
  await rb.mapAsync(GPUMapMode.READ);
  const view = new Float32Array(rb.getMappedRange().slice(0));
  rb.unmap();
  rb.destroy?.();
  const out = new Float64Array(numFree);
  for (let i = 0; i < numFree; i += 1) out[i] = view[2 * i] + view[2 * i + 1];
  return out;
}
