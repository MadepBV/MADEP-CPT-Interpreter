// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Device-resident plastic Newton orchestrator.
// =============================================================================
//
// Conservative GPU-resident rewrite.  The biggest CPU cost in the previous
// version was the per-iteration CSR readback + JS-side block-Jacobi rebuild
// + CSR re-upload (4 buffer round-trips through the host every Newton iter).
//
// Changes from the previous version:
//   - CSR rowPtr/colInd are uploaded ONCE (they don't change during a solve).
//   - Per-iter, csrValHi/Lo are copied device-to-device (asm → cg) — no host.
//   - Block-Jacobi is rebuilt on GPU via KERNEL_BUILD_BLOCK_JACOBI_FROM_CSR.
//   - The CG accepts the residual as `bAlreadyOnDevice` (one device copy
//     instead of a full host round-trip) and leaves the solution on device
//     (`keepSolutionOnDevice`).
//   - δu is consumed on device for the line-search axpy (no readback).
//
// What still crosses to CPU per iteration:
//   - 1 scalar readback for ‖r‖² (convergence check) — 8 bytes.
//   - 1 scalar readback per line-search backtrack for ‖r_trial‖² — 8 bytes.
//   - 1 host-upload to restore cgCtx.b (small, length numFree).  This is the
//     last remaining CPU round-trip; future work could keep a `bSaved`
//     device buffer to eliminate it.
//
// All values flowing across kernels are double-single (vec2<f32> = ~46 bits
// of mantissa, f64-equivalent for engineering math).  Every arithmetic op
// uses dsAdd / dsMul / dsRecip etc.
// =============================================================================

import {
  recordResidualAndTangentPlastic,
  recordResidualOnlyPlastic,
  recordCommitState,
  recordCommitDisplacement,
  uploadDisplacement
} from './gpu-assembly.js';
import {
  uploadDsCsr, uploadDsVector, solveResidentCg,
  dispatchAxpyExternal, dispatchCopyExternal,
  dispatchBuildBlockJacobiFromCsr, computeDotExternal
} from './resident-cg.js';
import { dsFromF64 } from './wgsl/ds.js';

export async function runPlasticNewtonOnGpu({
  asmCtx, cgCtx,
  bF64,
  maxIter = 32,
  relTol = 1e-4,
  absTol = 1e-3,
  lineSearch = { reduction: 0.5, maxBacktracks: 5, armijoC1: 1e-4 },
  onCgProgress = null,         // ({ iterations, residualNorm, relativeResidual }) => Promise<void>
  onNewtonProgress = null,     // ({ iter, residualNorm, rhsNorm, target }) => void
  cgRelTol = 1e-5,
  cgAbsTol = 5e-5,
  cgMaxIter = 25000
}) {
  const { device } = asmCtx;
  const numFree = asmCtx.sizes.numFree;
  if (bF64.length !== numFree) {
    throw new Error(`runPlasticNewtonOnGpu: bF64 length ${bF64.length} != numFree ${numFree}`);
  }

  // Static uploads (pattern + RHS).  Pattern is constant for the analysis;
  // RHS is constant for this Newton solve.
  device.queue.writeBuffer(cgCtx.buffers.rowPtr, 0, asmCtx.pack.csrRowPtr);
  device.queue.writeBuffer(cgCtx.buffers.colInd, 0, asmCtx.pack.csrColInd);
  uploadDsVector(cgCtx, 'b', bF64);

  // u ← u_committed (start-of-step reference).
  {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(asmCtx.buffers.uCommitted, 0, asmCtx.buffers.uvec, 0, 8 * numFree);
    device.queue.submit([enc.finish()]);
  }

  const rhsNormSq = await computeDotExternal(cgCtx, cgCtx.buffers.b, cgCtx.buffers.b);
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const target = Math.max(absTol, relTol * rhsNorm);

  const history = [];
  const nnzBytes = 4 * asmCtx.pack.nnz;

  for (let iter = 1; iter <= maxIter; iter += 1) {
    // ---------------------------------------------------------------------
    // Phase 1: assemble K and F_int on GPU; copy CSR to CG; build BJ on GPU;
    // compute r = b − F_int on GPU.
    // ---------------------------------------------------------------------
    {
      const enc = device.createCommandEncoder();
      recordResidualAndTangentPlastic(asmCtx, enc);
      device.queue.submit([enc.finish()]);
    }
    {
      const enc = device.createCommandEncoder();
      // Device-to-device: assembled CSR values into the CG matrix slot.
      enc.copyBufferToBuffer(asmCtx.buffers.csrValHi, 0, cgCtx.buffers.valHi, 0, nnzBytes);
      enc.copyBufferToBuffer(asmCtx.buffers.csrValLo, 0, cgCtx.buffers.valLo, 0, nnzBytes);
      // GPU block-Jacobi build from CSR.
      dispatchBuildBlockJacobiFromCsr(cgCtx, enc);
      device.queue.submit([enc.finish()]);
    }
    {
      const enc = device.createCommandEncoder();
      // r = b − F_int  (copy b→r, then r −= F_int).
      dispatchCopyExternal(cgCtx, enc, cgCtx.buffers.b, cgCtx.buffers.r);
      device.queue.submit([enc.finish()]);
    }
    {
      const enc = device.createCommandEncoder();
      dispatchAxpyExternal(cgCtx, enc, [-1, 0], asmCtx.buffers.rhsFree, cgCtx.buffers.r);
      device.queue.submit([enc.finish()]);
    }

    const rNormSq = await computeDotExternal(cgCtx, cgCtx.buffers.r, cgCtx.buffers.r);
    const residualNorm = Math.sqrt(Math.max(rNormSq, 0));
    history.push({ iter, residualNorm, rhsNorm });
    if (typeof onNewtonProgress === 'function') {
      onNewtonProgress({ iter, residualNorm, rhsNorm, target });
    }
    if (residualNorm <= target) {
      return makeNewtonResult({ converged: true, iter, residualNorm, history, asmCtx });
    }

    // ---------------------------------------------------------------------
    // Phase 2: solve K δu = r on GPU.  We copy r → cgCtx.b on device and
    // tell the CG that b is already on device.  CG keeps δu in cgCtx.x.
    // ---------------------------------------------------------------------
    {
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(cgCtx.buffers.r, 0, cgCtx.buffers.b, 0, 8 * numFree);
      device.queue.submit([enc.finish()]);
    }
    // Inner-CG tolerances default to the CPU pipeline's values
    // (CG_REL_TOL = 1e-5, CG_ABS_TOL = 5e-5, MAX_CG_ITER = 25000).  Tighter
    // tolerances at DS precision (~46 mantissa bits) cause CG to stagnate
    // near the precision floor on ill-conditioned operators — the symptom
    // is "inner-cg-not-converged" at max-iter even though Newton's outer
    // tolerance (1e-4 default) would be reached easily.
    const cg = await solveResidentCg(cgCtx, {
      bF64: null, bAlreadyOnDevice: true, keepSolutionOnDevice: true,
      maxIter: cgMaxIter, relTol: cgRelTol, absTol: cgAbsTol,
      observer: onCgProgress
    });
    if (!cg.converged) {
      return makeNewtonResult({ converged: false, iter, residualNorm, history, asmCtx, reason: 'inner-cg-not-converged' });
    }
    // Restore cgCtx.b so the next iter's residual subtract uses the original RHS.
    uploadDsVector(cgCtx, 'b', bF64);

    // ---------------------------------------------------------------------
    // Phase 3: Armijo line search on GPU.  Each backtrack:
    //   uvec ← u_committed; uvec += α · δu  (two device dispatches)
    //   re-eval residual via residual-only assembly  (one encoder)
    //   readback ‖r_trial‖²  (one scalar)
    // ---------------------------------------------------------------------
    let alpha = 1;
    let accepted = false;
    const meritCurrent = residualNorm;
    for (let bt = 0; bt <= lineSearch.maxBacktracks; bt += 1) {
      // u_trial = u_committed + α · δu  (all on device).
      {
        const enc = device.createCommandEncoder();
        enc.copyBufferToBuffer(asmCtx.buffers.uCommitted, 0, asmCtx.buffers.uvec, 0, 8 * numFree);
        device.queue.submit([enc.finish()]);
      }
      {
        const enc = device.createCommandEncoder();
        dispatchAxpyExternal(cgCtx, enc, dsFromF64(alpha), cgCtx.buffers.x, asmCtx.buffers.uvec);
        device.queue.submit([enc.finish()]);
      }
      // Residual-only re-eval.
      {
        const enc = device.createCommandEncoder();
        recordResidualOnlyPlastic(asmCtx, enc);
        device.queue.submit([enc.finish()]);
      }
      {
        const enc = device.createCommandEncoder();
        dispatchCopyExternal(cgCtx, enc, cgCtx.buffers.b, cgCtx.buffers.r);
        device.queue.submit([enc.finish()]);
      }
      {
        const enc = device.createCommandEncoder();
        dispatchAxpyExternal(cgCtx, enc, [-1, 0], asmCtx.buffers.rhsFree, cgCtx.buffers.r);
        device.queue.submit([enc.finish()]);
      }
      const trialSq = await computeDotExternal(cgCtx, cgCtx.buffers.r, cgCtx.buffers.r);
      const trialNorm = Math.sqrt(Math.max(trialSq, 0));
      if (trialNorm <= (1 - lineSearch.armijoC1 * alpha) * meritCurrent) {
        accepted = true;
        break;
      }
      alpha *= lineSearch.reduction;
    }
    if (!accepted) {
      // Best-effort: keep last α; uvec is at u_committed + α_min · δu already.
    }
  }

  // Max-iter exhausted.  Compute final residual for diagnostics.
  {
    const enc = device.createCommandEncoder();
    recordResidualOnlyPlastic(asmCtx, enc);
    device.queue.submit([enc.finish()]);
  }
  {
    const enc = device.createCommandEncoder();
    dispatchCopyExternal(cgCtx, enc, cgCtx.buffers.b, cgCtx.buffers.r);
    device.queue.submit([enc.finish()]);
  }
  {
    const enc = device.createCommandEncoder();
    dispatchAxpyExternal(cgCtx, enc, [-1, 0], asmCtx.buffers.rhsFree, cgCtx.buffers.r);
    device.queue.submit([enc.finish()]);
  }
  const finalSq = await computeDotExternal(cgCtx, cgCtx.buffers.r, cgCtx.buffers.r);
  const finalNorm = Math.sqrt(Math.max(finalSq, 0));
  return makeNewtonResult({ converged: false, iter: maxIter, residualNorm: finalNorm, history, asmCtx, reason: 'max-iter' });
}

function makeNewtonResult({ converged, iter, residualNorm, history, asmCtx, reason }) {
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
    solution: null,
    commit,
    reason: reason || null
  };
}
