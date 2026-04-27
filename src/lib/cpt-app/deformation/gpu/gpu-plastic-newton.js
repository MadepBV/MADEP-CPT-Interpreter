// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Device-bound plastic Newton orchestrator.
// =============================================================================
//
// Drives one accepted load increment of plastic Newton on the GPU.  Per
// Newton iteration:
//
//   1. Assemble residual + tangent (recordResidualAndTangentPlastic).
//   2. Compute r = b − rhsFree (host-recorded axpy).
//   3. Read back ‖r‖, check convergence.
//   4. Read back the assembled CSR, update the resident-CG context.
//   5. Solve K δu = r via the resident CG.
//   6. Armijo line search:
//        α ∈ {1, 1/2, ...}: assemble residual-only, compute trial ‖r‖,
//                            accept first α with sufficient decrease.
//   7. u ← u_trial.
//
// On Newton convergence: the caller dispatches recordCommitState via the
// returned `commit()` closure.  Until commit, σ_committed/ε_committed/u_committed
// remain at the start-of-step reference, so any failure leaves device state
// safely reusable.
//
// Inputs:
//   asmCtx   — gpu-assembly context (owns the pack + per-iteration buffers)
//   cgCtx    — resident-cg context (owns CG buffers + pipelines)
//   bF64     — Float64Array of length numFree, the assembled external load
//
// Returns: { converged, iterations, residualNorm, history, commit() }
//   commit() schedules state-commit + u_committed update for the caller to
//   submit in their own encoder when they're ready to advance.
// =============================================================================

import {
  recordResidualAndTangentPlastic,
  recordResidualOnlyPlastic,
  recordCommitState,
  recordCommitDisplacement,
  uploadDisplacement,
  readbackCsr,
  readbackRhsFree
} from './gpu-assembly.js';
import {
  uploadDsCsr, uploadBlockJacobi, solveResidentCg, uploadDsVector
} from './resident-cg.js';
import {
  buildBlockJacobiPackForFreeDofs, packFreeDofVector, unpackFreeDofVector
} from './gpu-mesh-pack.js';
import { dsFromF64 } from './wgsl/ds.js';

const WG_SIZE = 64;

// =============================================================================
// Generic device-bound BLAS dispatchers used by the Newton orchestrator.
// They piggy-back on the resident-CG context's buffers — the CG doesn't run
// at the same time as the Newton iter assembly, so the buffers are free to
// reuse.  Each dispatcher uses a uniform of size 32 (vec3<u32> padding).
// =============================================================================

function bg(device, layout, entries) { return device.createBindGroup({ layout, entries }); }
function bge(binding, buffer) { return { binding, resource: { buffer } }; }
function GPU_COMPUTE() { return typeof GPUShaderStage !== 'undefined' ? GPUShaderStage.COMPUTE : 0x4; }

// Compile/cache a generic free-DOF BLAS pipeline (axpy, copy, dot) lazily on
// the device.  We need these for the Newton iter even though they live in
// the CG runtime — we just reuse the cached ones from createResidentCgContext.

// Sub-routine: dispatch r = b - rhsFree (one axpy with alpha=-1 on top of a copy).
async function recordResidualSubtract(asmCtx, cgCtx, encoder) {
  // r = b - rhsFree   (b in cgCtx.buffers.b, rhsFree in asmCtx.buffers.rhsFree, r in cgCtx.buffers.r)
  // Since r/b/rhsFree have the same DS-vec layout (length numFree), we use:
  //   step 1: copy b → r
  //   step 2: axpy(-1, rhsFree → r)
  // Both use distinct uniform buffers (paramsCopy, paramsAxpy) — no aliasing.
  // We borrow the dispatch helpers from the CG runtime by replaying its
  // record patterns inline:
  dispatchCopy(cgCtx, encoder, asmCtxRhsAlias(cgCtx, asmCtx).b, cgCtx.buffers.r);
  dispatchAxpyExternal(cgCtx, encoder, [-1, 0], asmCtx.buffers.rhsFree, cgCtx.buffers.r);
}

// "asmCtxRhsAlias" is conceptual: we just need cgCtx.buffers.b which is
// already the right shape.  Returns cgCtx.buffers; provided for readability.
function asmCtxRhsAlias(cgCtx, _asmCtx) { return cgCtx.buffers; }

// Generic copy: copy y = x for two device-side DS-vec buffers of length N.
// Compiled once per ctx.  Same kernel as resident-CG's COPY.
function dispatchCopy(cgCtx, encoder, srcBuf, dstBuf) {
  const u = new ArrayBuffer(32);
  new Uint32Array(u, 0, 1)[0] = cgCtx.N;
  cgCtx.device.queue.writeBuffer(cgCtx.buffers.paramsCopy, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(cgCtx.pipelines.copy.pipeline);
  pass.setBindGroup(0, bg(cgCtx.device, cgCtx.pipelines.copy.bgLayout, [
    bge(0, srcBuf), bge(1, dstBuf), bge(2, cgCtx.buffers.paramsCopy)
  ]));
  pass.dispatchWorkgroups(cgCtx.numWorkgroupsBlas);
  pass.end();
}

// Like resident-CG's dispatchAxpy but lets us use buffers that live OUTSIDE
// the CG context (e.g. asmCtx.buffers.rhsFree).
function dispatchAxpyExternal(cgCtx, encoder, alphaDs, srcBuf, dstBuf) {
  const u = new ArrayBuffer(32);
  const fv = new Float32Array(u);
  fv[0] = alphaDs[0]; fv[1] = alphaDs[1];
  new Uint32Array(u, 8, 1)[0] = cgCtx.N;
  cgCtx.device.queue.writeBuffer(cgCtx.buffers.paramsAxpy, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(cgCtx.pipelines.axpy.pipeline);
  pass.setBindGroup(0, bg(cgCtx.device, cgCtx.pipelines.axpy.bgLayout, [
    bge(0, srcBuf), bge(1, dstBuf), bge(2, cgCtx.buffers.paramsAxpy)
  ]));
  pass.dispatchWorkgroups(cgCtx.numWorkgroupsBlas);
  pass.end();
}

// Compute r·r on device, return f64 norm-squared.
async function readbackDotSelf(cgCtx, bufA, bufB) {
  // Use the cgCtx's dot pipeline.  Recreate the dispatch logic inline.
  const enc = cgCtx.device.createCommandEncoder();
  // Pass 1.
  {
    const u = new ArrayBuffer(32);
    new Uint32Array(u, 0, 1)[0] = cgCtx.N;
    cgCtx.device.queue.writeBuffer(cgCtx.buffers.paramsDot, 0, u);
    const pass = enc.beginComputePass();
    pass.setPipeline(cgCtx.pipelines.dot1.pipeline);
    pass.setBindGroup(0, bg(cgCtx.device, cgCtx.pipelines.dot1.bgLayout, [
      bge(0, bufA), bge(1, bufB),
      bge(2, cgCtx.buffers.dotPartials),
      bge(3, cgCtx.buffers.paramsDot)
    ]));
    pass.dispatchWorkgroups(cgCtx.numWorkgroupsBlas);
    pass.end();
  }
  // Pass 2.
  {
    const u = new ArrayBuffer(32);
    new Uint32Array(u, 0, 1)[0] = cgCtx.numWorkgroupsBlas;
    cgCtx.device.queue.writeBuffer(cgCtx.buffers.paramsDotP2, 0, u);
    const pass = enc.beginComputePass();
    pass.setPipeline(cgCtx.pipelines.dot2.pipeline);
    pass.setBindGroup(0, bg(cgCtx.device, cgCtx.pipelines.dot2.bgLayout, [
      bge(0, cgCtx.buffers.dotPartials),
      bge(1, cgCtx.buffers.dotResult),
      bge(2, cgCtx.buffers.paramsDotP2)
    ]));
    pass.dispatchWorkgroups(1);
    pass.end();
  }
  enc.copyBufferToBuffer(cgCtx.buffers.dotResult, 0, cgCtx.buffers.readback, 0, 8);
  cgCtx.device.queue.submit([enc.finish()]);
  await cgCtx.buffers.readback.mapAsync(GPUMapMode.READ);
  const arr = new Float32Array(cgCtx.buffers.readback.getMappedRange().slice(0));
  cgCtx.buffers.readback.unmap();
  return arr[0] + arr[1];
}

// =============================================================================
// runPlasticNewtonOnGpu
// =============================================================================
export async function runPlasticNewtonOnGpu({
  asmCtx, cgCtx,
  bF64,
  maxIter = 32,
  relTol = 1e-4,
  absTol = 1e-3,
  lineSearch = { reduction: 0.5, maxBacktracks: 5, armijoC1: 1e-4 }
}) {
  const { device } = asmCtx;
  const numFree = asmCtx.sizes.numFree;
  if (bF64.length !== numFree) {
    throw new Error(`runPlasticNewtonOnGpu: bF64 length ${bF64.length} != numFree ${numFree}`);
  }

  // Upload b into the CG context.
  uploadDsVector(cgCtx, 'b', bF64);
  // u_current ← u_committed (start-of-step reference).
  {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(asmCtx.buffers.uCommitted, 0, asmCtx.buffers.uvec, 0, 8 * numFree);
    device.queue.submit([enc.finish()]);
  }

  const rhsNormSq = await readbackDotSelf(cgCtx, cgCtx.buffers.b, cgCtx.buffers.b);
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const target = Math.max(absTol, relTol * rhsNorm);

  const history = [];

  for (let iter = 1; iter <= maxIter; iter += 1) {
    // 1. Assemble residual + tangent.  This dispatches the full plastic chain.
    {
      const enc = device.createCommandEncoder();
      recordResidualAndTangentPlastic(asmCtx, enc);
      // 2. r = b − rhsFree.
      await recordResidualSubtract(asmCtx, cgCtx, enc);
      device.queue.submit([enc.finish()]);
    }
    // 3. Residual norm.
    const rNormSq = await readbackDotSelf(cgCtx, cgCtx.buffers.r, cgCtx.buffers.r);
    const residualNorm = Math.sqrt(Math.max(rNormSq, 0));
    history.push({ iter, residualNorm, rhsNorm });
    if (residualNorm <= target) {
      const u = await readbackUvec(asmCtx);
      return makeNewtonResult({ converged: true, iter, residualNorm, history, u, asmCtx });
    }

    // 4. Read back the assembled CSR, build block-Jacobi, upload to CG.
    const csrPacked = await readbackCsr(asmCtx);
    const blockJacobiPacked = buildBlockJacobiPackForFreeDofs({
      freeDofs: asmCtx.pack.freeDofs,
      csrRowPtr: csrPacked.rowPtr,
      csrColInd: csrPacked.colInd,
      csrValHi:  csrPacked.valHi,
      csrValLo:  csrPacked.valLo
    });
    uploadDsCsr(cgCtx, csrPacked);
    uploadBlockJacobi(cgCtx, blockJacobiPacked);

    // 5. Solve K δu = r.  We need to feed r as the CG's right-hand side.
    //    Read r back from device, pass it to solveResidentCg as bF64 (which
    //    uploads it into cgCtx.buffers.b), then read the solution.
    const rF64 = await readbackResidual(cgCtx);
    const cg = await solveResidentCg(cgCtx, {
      bF64: rF64,
      maxIter: 5000, relTol: 1e-10, absTol: 1e-12
    });
    if (!cg.converged) {
      const u = await readbackUvec(asmCtx);
      return makeNewtonResult({ converged: false, iter, residualNorm, history, u, asmCtx, reason: 'inner-cg-not-converged' });
    }
    const deltaU = cg.solution;     // Float64Array length numFree

    // Restore b to the original external load (CG overwrote it).
    uploadDsVector(cgCtx, 'b', bF64);

    // 6. Armijo line search.
    let alpha = 1;
    let accepted = false;
    const meritCurrent = residualNorm;
    let uCurrent = await readbackUvec(asmCtx);
    for (let bt = 0; bt <= lineSearch.maxBacktracks; bt += 1) {
      const uTrial = new Float64Array(numFree);
      for (let i = 0; i < numFree; i += 1) uTrial[i] = uCurrent[i] + alpha * deltaU[i];
      uploadDisplacement(asmCtx, uTrial);
      // Residual-only re-pass + r = b − rhsFree.
      {
        const enc = device.createCommandEncoder();
        recordResidualOnlyPlastic(asmCtx, enc);
        await recordResidualSubtract(asmCtx, cgCtx, enc);
        device.queue.submit([enc.finish()]);
      }
      const trialSq = await readbackDotSelf(cgCtx, cgCtx.buffers.r, cgCtx.buffers.r);
      const trialNorm = Math.sqrt(Math.max(trialSq, 0));
      if (trialNorm <= (1 - lineSearch.armijoC1 * alpha) * meritCurrent) {
        accepted = true;
        // u stays at uTrial on the device.
        break;
      }
      alpha *= lineSearch.reduction;
    }
    if (!accepted) {
      // Best-effort: take last α — u is already at uTrial via the most-recent
      // upload above.  Continue to next iter.
    }
  }

  // Max iterations exhausted.
  // Final residual evaluation.
  {
    const enc = device.createCommandEncoder();
    recordResidualOnlyPlastic(asmCtx, enc);
    await recordResidualSubtract(asmCtx, cgCtx, enc);
    device.queue.submit([enc.finish()]);
  }
  const finalSq = await readbackDotSelf(cgCtx, cgCtx.buffers.r, cgCtx.buffers.r);
  const finalNorm = Math.sqrt(Math.max(finalSq, 0));
  const u = await readbackUvec(asmCtx);
  return makeNewtonResult({ converged: false, iter: maxIter, residualNorm: finalNorm, history, u, asmCtx, reason: 'max-iter' });
}

async function readbackResidual(cgCtx) {
  const { device, buffers, N } = cgCtx;
  const out = device.createBuffer({ size: 8 * N, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buffers.r, 0, out, 0, 8 * N);
  device.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const packed = new Float32Array(out.getMappedRange().slice(0));
  out.unmap(); out.destroy();
  const f64 = new Float64Array(N);
  for (let i = 0; i < N; i += 1) f64[i] = packed[2 * i] + packed[2 * i + 1];
  return f64;
}

async function readbackUvec(asmCtx) {
  const { device, buffers, sizes } = asmCtx;
  const out = device.createBuffer({ size: 8 * sizes.numFree, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buffers.uvec, 0, out, 0, 8 * sizes.numFree);
  device.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const packed = new Float32Array(out.getMappedRange().slice(0));
  out.unmap(); out.destroy();
  const f64 = new Float64Array(sizes.numFree);
  for (let i = 0; i < sizes.numFree; i += 1) f64[i] = packed[2 * i] + packed[2 * i + 1];
  return f64;
}

function makeNewtonResult({ converged, iter, residualNorm, history, u, asmCtx, reason }) {
  // Build a `commit()` closure that the caller submits when they accept the
  // load step.  Commit dispatches recordCommitState + recordCommitDisplacement.
  const commit = () => {
    const enc = asmCtx.device.createCommandEncoder();
    recordCommitState(asmCtx, enc);
    recordCommitDisplacement(asmCtx, enc);
    asmCtx.device.queue.submit([enc.finish()]);
  };
  return {
    converged,
    iterations: iter,
    residualNorm,
    history,
    solution: u,
    commit,
    reason: reason || null
  };
}
