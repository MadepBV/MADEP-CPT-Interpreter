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
  uploadDsVector, uploadPairIsNodal,
  solveResidentCg,
  dispatchAxpyExternal, dispatchCopyExternal, computeDotExternal,
  dispatchBuildBlockJacobiFromCsr
} from './resident-cg.js';
import { solveResidentGmres } from './resident-gmres.js';
import { dsFromF64 } from './wgsl/ds.js';

export async function runPlasticNewtonOnGpu({
  asmCtx, cgCtx,
  gmresCtx = null,
  useGmres = false,
  bF64,
  maxIter = 32,
  relTol = 1e-4,
  absTol = 1e-3,
  lineSearch = { reduction: 0.5, maxBacktracks: 5, armijoC1: 1e-4 },
  onCgProgress = null,         // ({ iterations, residualNorm, relativeResidual, solverName }) => Promise<void>
  onNewtonProgress = null,     // ({ iter, residualNorm, rhsNorm, target, changedCount }) => void
  cgRelTol = 1e-5,
  cgAbsTol = 5e-5,
  cgMaxIter = 25000,
  // Phase identifier from the controller.  Used to pick the same convergence
  // semantics CPU uses per phase (`solver.js _runPlasticPhase`):
  //   - 'initial-gravity'  → enables 1.1× residualTarget quasi-convergence
  //                          and uses inexact-Newton forcing 0.1..0.6.
  //   - 'service-load'     → strict residualTarget; forcing 0.05..0.4.
  //   - 'safety-cphi'      → strict residualTarget; forcing 0.05..0.4.
  phaseKind = 'service-load'
}) {
  const { device } = asmCtx;
  const numFree = asmCtx.sizes.numFree;
  const numGp = asmCtx.sizes.numGp;
  if (bF64.length !== numFree) {
    throw new Error(`runPlasticNewtonOnGpu: bF64 length ${bF64.length} != numFree ${numFree}`);
  }
  if (useGmres && !gmresCtx) {
    throw new Error('runPlasticNewtonOnGpu: useGmres=true requires a gmresCtx.');
  }
  const isInitialGravity = phaseKind === 'initial-gravity';

  // Static uploads (CSR shape + nodal-pair mask + RHS).  All shape data is
  // constant for the analysis, so we upload once per Newton solve.  The
  // nodal-pair mask drives the on-device block-Jacobi build kernel — with
  // it uploaded, the per-iter CSR-readback / JS-loop / re-upload roundtrip
  // disappears entirely (the only remaining host work in the inner loop is
  // O(1) scalar readbacks for convergence checks).
  device.queue.writeBuffer(cgCtx.buffers.rowPtr, 0, asmCtx.pack.csrRowPtr);
  device.queue.writeBuffer(cgCtx.buffers.colInd, 0, asmCtx.pack.csrColInd);
  uploadPairIsNodal(cgCtx, asmCtx.pack.pairIsNodal);
  if (useGmres) {
    device.queue.writeBuffer(gmresCtx.buffers.rowPtr, 0, asmCtx.pack.csrRowPtr);
    device.queue.writeBuffer(gmresCtx.buffers.colInd, 0, asmCtx.pack.csrColInd);
  }
  uploadDsVector(cgCtx, 'b', bF64);

  // u ← u_committed (start-of-step reference; iter 0 of Newton).
  {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(asmCtx.buffers.uCommitted, 0, asmCtx.buffers.uvec, 0, 8 * numFree);
    device.queue.submit([enc.finish()]);
  }

  // Per-Newton-iter anchor `u^k` used by the line search.  At the start of
  // each iteration we snapshot the current `uvec` into `uIterAnchor`, then
  // each Armijo backtrack resets `uvec ← uIterAnchor + α · δu^k`.
  //
  // This is the fundamental Newton update `u^(k+1) = u^k + α · δu^k` —
  // accumulating onto the previous iterate, NOT onto `u_committed`.
  // u_committed is frozen for the entire Newton solve (it is written only
  // by `recordCommitDisplacement` when Newton converges); using it as the
  // line-search anchor would discard every prior Newton iteration's
  // contribution and force the residual to start from scratch every iter,
  // producing a pathological non-monotone outer iteration that stalls at
  // max-iter.  This buffer is local to the orchestrator (no asmCtx shape
  // change) and destroyed before return.
  const uIterAnchor = device.createBuffer({
    size: 8 * numFree,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });

  const rhsNormSq = await computeDotExternal(cgCtx, cgCtx.buffers.b, cgCtx.buffers.b);
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const target = Math.max(absTol, relTol * rhsNorm);

  const history = [];
  const nnzBytes = 4 * asmCtx.pack.nnz;
  const branchKindBytes = 4 * numGp;

  // Active-set tracking with branch persistence — orchestrator-level
  // mirror of CPU's `previousTrialActive` semantics
  // (material-models.js:2739-2742):
  //
  //   const previousTrialActive = previousTrialState?.currentlyMcActive === true;
  //   const retainedActive       = committed.currentlyMcActive || previousTrialActive;
  //   const currentlyMcActive    = retainedActive || exceedsMcShear;
  //
  // i.e. once a GP is plastic in any iter of this Newton solve, it stays
  // tracked as "active" for subsequent iters.  CPU's `changedCount`
  // (`currentTrialActive !== previousTrialActive` summed per element) then
  // counts ONLY new activations — a GP that flipped to elastic in the
  // current trial doesn't count as a change, because persistence keeps
  // its "active" label.
  //
  // Without this, a GP at the edge of the yield surface oscillates between
  // ELASTIC and FACE_F13 every iter from DS-precision noise alone; the
  // strict `changedCount === 0` gate (required for mc-plastic, which has
  // `requiresStableActiveSetAtConvergence = true`) never fires, and Newton
  // hits max-iter — the textbook "surface-load-step-too-small-at-…"
  // failure pattern on a problem with marginal plasticity at the load
  // corners.
  //
  // The GPU MC kernel doesn't carry committed-branch input, so persistence
  // is implemented here on the host: an `everActive` flag per GP that
  // monotonically grows within each Newton solve.  `changedCount` is the
  // count of GPs whose `everActive` flipped from 0 → 1 THIS iter — i.e.
  // genuine new activations only.  This is the smallest set of changes
  // that mirrors CPU's exact convergence semantics without modifying the
  // MC kernel itself.
  const everActive = new Uint8Array(numGp);
  // Inexact-Newton acceptance state — mirrors CPU's `lastRelativeResidual`,
  // used to compute the forcing term η_k.  Initial value 1.0 forces η_k to
  // its upper bound (0.6 for initial-gravity, 0.4 otherwise) on iter 1,
  // matching CPU's behavior.
  let lastRelativeResidual = 1;

  try {
  for (let iter = 1; iter <= maxIter; iter += 1) {
    // Snapshot the current iterate `u^k` (the displacement at which the
    // residual + tangent we are about to assemble is taken) so the line
    // search below can backtrack against it correctly.  Capturing here —
    // before assembly — is critical: the assembly reads `uvec` through
    // the strain kernel, so `u^k` must equal the displacement under
    // which the tangent K(u^k) and force F_int(u^k) are produced.
    {
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(asmCtx.buffers.uvec, 0, uIterAnchor, 0, 8 * numFree);
      device.queue.submit([enc.finish()]);
    }
    // ---------------------------------------------------------------------
    // Phase 1: assemble K and F_int on GPU; copy CSR to CG; build BJ on GPU;
    // compute r = b − F_int on GPU.
    // ---------------------------------------------------------------------
    {
      const enc = device.createCommandEncoder();
      recordResidualAndTangentPlastic(asmCtx, enc);
      device.queue.submit([enc.finish()]);
    }
    // Copy the assembled CSR values device-to-device into the inner solver
    // contexts, then build the block-Jacobi preconditioner on device using
    // the precomputed nodal-pair mask.  No host round-trip — the JS-side
    // CSR readback / pack-loop / re-upload that previously dominated the
    // per-iter cost (8 × nnz bytes plus a JS loop) is gone.  The build
    // kernel matches the CPU buildBlockJacobiPreconditioner contract
    // exactly (verified by the pair-slot test on the JS-side helper that
    // shares the same mathematical specification).
    {
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(asmCtx.buffers.csrValHi, 0, cgCtx.buffers.valHi, 0, nnzBytes);
      enc.copyBufferToBuffer(asmCtx.buffers.csrValLo, 0, cgCtx.buffers.valLo, 0, nnzBytes);
      if (useGmres) {
        enc.copyBufferToBuffer(asmCtx.buffers.csrValHi, 0, gmresCtx.buffers.valHi, 0, nnzBytes);
        enc.copyBufferToBuffer(asmCtx.buffers.csrValLo, 0, gmresCtx.buffers.valLo, 0, nnzBytes);
      }
      // Build BJ on device into cgCtx.blockJacobi.
      dispatchBuildBlockJacobiFromCsr(cgCtx, enc);
      // Mirror onto gmresCtx.blockJacobi via device-to-device copy when
      // GMRES is the active inner solver (32 × numNodes bytes, no host).
      if (useGmres) {
        enc.copyBufferToBuffer(
          cgCtx.buffers.blockJacobi, 0,
          gmresCtx.buffers.blockJacobi, 0,
          32 * cgCtx.numNodes
        );
      }
      device.queue.submit([enc.finish()]);
    }
    // Active-set readback — single pass over branchKind that derives BOTH
    //   activeCount  = # GPs whose `everActive` flag is set (cumulative
    //                  active-set count for this Newton solve, with
    //                  branch persistence)
    //   changedCount = # GPs whose `everActive` flag flipped from 0 → 1
    //                  THIS iter (genuine new activations only;
    //                  releases are absorbed by persistence, mirroring
    //                  CPU's `currentTrialActive !== previousTrialActive`
    //                  reduction after persistence is applied).
    //
    // MC_BRANCH.ELASTIC === 0 (see wgsl/mc-plastic.js) — branchKindNow != 0
    // identifies a GP currently on a yield surface; persistence then
    // records that fact for the rest of this Newton solve.
    let changedCount = 0;
    let activeCount = 0;
    {
      const branchKindNow = await readbackBufferU32(device, asmCtx.buffers.branchKind, branchKindBytes);
      for (let g = 0; g < numGp; g += 1) {
        if (branchKindNow[g] !== 0) {
          if (everActive[g] === 0) {
            everActive[g] = 1;
            changedCount += 1;
          }
        }
        if (everActive[g] !== 0) activeCount += 1;
      }
    }
    // r = b − F_int  in a single encoder.  The COPY uses paramsCopy, the
    // AXPY uses paramsAxpy — different uniform buffers, so the per-submit
    // uniform-overwrite hazard that forced the two-axpys-share-paramsAxpy
    // split (see resident-cg.js) does not apply here.  One submit instead
    // of two saves a Metal queue-submit round-trip per Newton iter.
    {
      const enc = device.createCommandEncoder();
      dispatchCopyExternal(cgCtx, enc, cgCtx.buffers.b, cgCtx.buffers.r);
      dispatchAxpyExternal(cgCtx, enc, [-1, 0], asmCtx.buffers.rhsFree, cgCtx.buffers.r);
      device.queue.submit([enc.finish()]);
    }

    const rNormSq = await computeDotExternal(cgCtx, cgCtx.buffers.r, cgCtx.buffers.r);
    const residualNorm = Math.sqrt(Math.max(rNormSq, 0));
    history.push({ iter, residualNorm, rhsNorm, changedCount, activeCount });
    if (typeof onNewtonProgress === 'function') {
      onNewtonProgress({ iter, residualNorm, rhsNorm, target, changedCount, activeCount });
    }
    // Convergence test — mirrors `solver.js` lines ~3795-3804 exactly:
    //
    //   assembledConverged = residualConverged
    //                        OR  allowPlasticQuasiConvergence(...)
    //   accept           = iter > 1 AND assembledConverged
    //                        AND (!requiresStableActiveSet OR changedCount === 0)
    //
    // For Mohr-Coulomb (`requiresStableActiveSetAtConvergence = true`) the
    // active-set gate is mandatory.  For the mc-plastic + initial-gravity
    // phase the quasi-convergence path admits residuals up to 1.1 ×
    // residualTarget once the active set is stable — this is the principled
    // fix for residuals that bottom out *just* at the strict tolerance, the
    // textbook "stalls at e-4" symptom.
    const residualConverged = residualNorm <= target;
    const quasiConverged = isInitialGravity && residualNorm <= 1.1 * target;
    if (iter > 1 && (residualConverged || quasiConverged) && changedCount === 0) {
      return makeNewtonResult({ converged: true, iter, residualNorm, history, asmCtx });
    }

    // ---------------------------------------------------------------------
    // Phase 2: solve K δu = r on GPU.
    //
    // Per-iter inner-solver dispatch — mirrors CPU exactly
    // (solver.js:3812-3814):
    //   usesUnsymmetricSolver = !useElasticGlobalizationTangent
    //                           && mayNeedUnsymmetricSolver
    //                           && assembled.activeCount > 0
    //
    // The `activeCount` we carry here uses orchestrator-level branch
    // persistence (the `everActive` flag set above), so it matches CPU's
    // post-persistence `currentlyMcActive` count rather than the raw
    // current-iter branchKind reading — which would otherwise be 0
    // between plastic spikes and systematically under-dispatch GMRES
    // versus CPU.
    //
    // Why this matters for performance:
    //   * GMRES MGS does m·(m+1)/2 sequential dot-readbacks per restart
    //     cycle (~820 host-device sync points at m=40).  Apple Metal
    //     readbacks cost ~100 μs each → ~80 ms of CPU orchestration per
    //     Arnoldi cycle BEFORE any actual GPU work counts.
    //   * CG does 2-3 dots per iter, an order of magnitude fewer sync
    //     points than GMRES.
    //   * For purely elastic Newton iters (which dominate the geostatic
    //     phase and elastic surface-load steps on stiff materials), CG
    //     is dramatically faster wall-clock with identical mathematical
    //     correctness on the SPD operator.
    //
    // Inner-solver tolerances mirror CPU constants
    // (CG_REL_TOL = 1e-5, CG_ABS_TOL = 5e-5, MAX_CG_ITER = 25000).  When
    // the inner solver returns short of strict convergence, the
    // inexact-Newton acceptance below decides whether the result is good
    // enough to keep moving (mirrors solver.js:3870-3905).
    // ---------------------------------------------------------------------
    const useGmresThisIter = useGmres && activeCount > 0;
    const solverNameThisIter = useGmresThisIter ? 'GMRES' : 'CG';
    let inner;
    if (useGmresThisIter) {
      // r → gmresCtx.b  (copy device-to-device).
      {
        const enc = device.createCommandEncoder();
        enc.copyBufferToBuffer(cgCtx.buffers.r, 0, gmresCtx.buffers.b, 0, 8 * numFree);
        device.queue.submit([enc.finish()]);
      }
      inner = await solveResidentGmres(gmresCtx, {
        bF64: null, bAlreadyOnDevice: true, keepSolutionOnDevice: true,
        maxIter: cgMaxIter, relTol: cgRelTol, absTol: cgAbsTol,
        observer: makeCgObserver(onCgProgress, solverNameThisIter)
      });
    } else {
      // r → cgCtx.b  (copy device-to-device).
      {
        const enc = device.createCommandEncoder();
        enc.copyBufferToBuffer(cgCtx.buffers.r, 0, cgCtx.buffers.b, 0, 8 * numFree);
        device.queue.submit([enc.finish()]);
      }
      inner = await solveResidentCg(cgCtx, {
        bF64: null, bAlreadyOnDevice: true, keepSolutionOnDevice: true,
        maxIter: cgMaxIter, relTol: cgRelTol, absTol: cgAbsTol,
        observer: makeCgObserver(onCgProgress, solverNameThisIter)
      });
    }
    // Inexact-Newton acceptance — mirrors solver.js lines ~3870-3905.
    // Even when the inner solver did not strictly converge, accept its
    // result if the linear residual is below the inexact-Newton threshold.
    // The forcing term `η_k` is from Eisenstat-Walker, with phase-dependent
    // bounds matching CPU exactly (initial-gravity uses [0.1, 0.6]; other
    // phases [0.05, 0.4]).  This keeps Newton moving when the inner Krylov
    // solver hits its precision floor on a difficult tangent — CPU's path
    // for the same situation, and the missing piece that previously caused
    // the GPU pipeline to bail with "inner-not-converged" while CPU
    // happily continued.
    const innerRhsNorm = Math.max(Number(inner.rhsNorm) || 0, 0);
    const forcingLo = isInitialGravity ? 0.1 : 0.05;
    const forcingHi = isInitialGravity ? 0.6 : 0.4;
    const inexactNewtonForcing = Math.max(
      forcingLo,
      Math.min(forcingHi, Math.sqrt(Math.max(lastRelativeResidual, 0)))
    );
    const acceptableLinearizedResidual = Math.max(
      cgAbsTol,
      0.25 * absTol,
      inexactNewtonForcing * innerRhsNorm
    );
    const innerAccepted = inner.converged || inner.residualNorm <= acceptableLinearizedResidual;
    if (!innerAccepted) {
      const reason = useGmresThisIter ? 'inner-gmres-not-converged' : 'inner-cg-not-converged';
      return makeNewtonResult({ converged: false, iter, residualNorm, history, asmCtx, reason });
    }
    if (useGmresThisIter) {
      // GMRES wrote δu into gmresCtx.x; mirror onto cgCtx.x so the line
      // search below (which dispatches through cgCtx) reads the right
      // buffer without further branching.  When CG ran, δu is already on
      // cgCtx.x and no copy is needed.
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(gmresCtx.buffers.x, 0, cgCtx.buffers.x, 0, 8 * numFree);
      device.queue.submit([enc.finish()]);
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
    let lastTrialSq = residualNorm * residualNorm;
    const meritCurrent = residualNorm;
    for (let bt = 0; bt <= lineSearch.maxBacktracks; bt += 1) {
      // Each backtrack does:
      //   1. uvec ← u^k                       (buffer copy, no uniform)
      //   2. uvec += α · δu                   (axpy, paramsAxpy = α)
      //   3. assemble F_int(u_trial)          (residual-only kernel chain)
      //   4. r ← b                            (copy, paramsCopy)
      //   5. r −= F_int                       (axpy, paramsAxpy = −1)
      //   6. ‖r‖²                              (dot, paramsDot — separate)
      //
      // Steps 2 and 5 both write the paramsAxpy uniform buffer with
      // different α values.  Within ONE submit, queue.writeBuffer fires
      // before any encoder commands, so two writes to the same buffer
      // collide (the second wins) — that's the historical bug fixed in
      // resident-cg.js.  We therefore split BETWEEN the two axpys but
      // combine everything that doesn't conflict: 1+2 in one encoder,
      // 3+4+5 in another.  Net cost per backtrack: 3 submits + 1 dot
      // (down from 6 submits + 1 dot in the prior version).
      {
        const enc = device.createCommandEncoder();
        enc.copyBufferToBuffer(uIterAnchor, 0, asmCtx.buffers.uvec, 0, 8 * numFree);
        dispatchAxpyExternal(cgCtx, enc, dsFromF64(alpha), cgCtx.buffers.x, asmCtx.buffers.uvec);
        device.queue.submit([enc.finish()]);
      }
      {
        const enc = device.createCommandEncoder();
        recordResidualOnlyPlastic(asmCtx, enc);
        dispatchCopyExternal(cgCtx, enc, cgCtx.buffers.b, cgCtx.buffers.r);
        dispatchAxpyExternal(cgCtx, enc, [-1, 0], asmCtx.buffers.rhsFree, cgCtx.buffers.r);
        device.queue.submit([enc.finish()]);
      }
      const trialSq = await computeDotExternal(cgCtx, cgCtx.buffers.r, cgCtx.buffers.r);
      lastTrialSq = trialSq;
      const trialNorm = Math.sqrt(Math.max(trialSq, 0));
      if (trialNorm <= (1 - lineSearch.armijoC1 * alpha) * meritCurrent) {
        accepted = true;
        break;
      }
      alpha *= lineSearch.reduction;
    }
    // (`accepted === false` falls through with uvec at uIterAnchor + α_min·δu;
    // that is the "best-effort" line-search outcome.)
    // Reuse the line-search's last computed ‖r‖² for `lastRelativeResidual`
    // — same buffer (`cgCtx.r`), same computation, no need for a second
    // dot + readback round-trip.  Mirrors CPU's `lastRelativeResidual`
    // exactly: the post-line-search residual at the iterate we ended on.
    const postNorm = Math.sqrt(Math.max(lastTrialSq, 0));
    lastRelativeResidual = rhsNorm > 0 ? postNorm / rhsNorm : 0;
  }

  // Max-iter exhausted.  Compute final residual for diagnostics.
  // Folded into one encoder: residual-only assembly + r=b copy + r -= F_int.
  // The two interior writeBuffer calls (paramsCopy and paramsAxpy) target
  // distinct uniform buffers, so the per-submit uniform-collision rule
  // does not apply.
  {
    const enc = device.createCommandEncoder();
    recordResidualOnlyPlastic(asmCtx, enc);
    dispatchCopyExternal(cgCtx, enc, cgCtx.buffers.b, cgCtx.buffers.r);
    dispatchAxpyExternal(cgCtx, enc, [-1, 0], asmCtx.buffers.rhsFree, cgCtx.buffers.r);
    device.queue.submit([enc.finish()]);
  }
  const finalSq = await computeDotExternal(cgCtx, cgCtx.buffers.r, cgCtx.buffers.r);
  const finalNorm = Math.sqrt(Math.max(finalSq, 0));
  return makeNewtonResult({ converged: false, iter: maxIter, residualNorm: finalNorm, history, asmCtx, reason: 'max-iter' });
  } finally {
    uIterAnchor.destroy();
  }
}

// Read a Uint32 snapshot — used per Newton iter for the branchKind
// active-set readback (the only large host readback that remains in the
// inner loop).  CSR values are no longer pulled to host: the BJ build is
// resident on device.
async function readbackBufferU32(device, srcBuffer, byteLength) {
  const out = device.createBuffer({ size: byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(srcBuffer, 0, out, 0, byteLength);
  device.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const arr = new Uint32Array(out.getMappedRange().slice(0));
  out.unmap();
  out.destroy();
  return arr;
}

// Wrap an upstream `onCgProgress` so the inner solver's progress messages
// carry the actual solver name (CG vs GMRES) instead of the generic "CG"
// hardcoded in earlier versions of the controller's progress observer.
function makeCgObserver(onCgProgress, solverName) {
  if (typeof onCgProgress !== 'function') return null;
  return async (info) => onCgProgress({ ...info, solverName });
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
