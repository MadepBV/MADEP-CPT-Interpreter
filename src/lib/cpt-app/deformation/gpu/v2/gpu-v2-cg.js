// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GPU pipeline v2 — matrix-free preconditioned CG.
// =============================================================================
//
// Solves K · du = b  with K accessed only through `dispatchMatvec`.  The
// preconditioner is whatever ctx.preconditioner says (scalar Jacobi or
// 2×2 block Jacobi).  All vectors live on-device end-to-end; the only
// readbacks are the three scalars per iteration (rzNew, pAp, ‖r‖²).
//
// Convention: solver writes du into `ctx.buffers.x`; caller is responsible
// for reading it back (via gpu-v2-dispatch readUtotal-style helper) or
// piping it into a Newton update.

import { dsFromF64 } from '../wgsl/ds.js';
import {
  dispatchMatvec, dispatchApplyPreconditioner,
  dispatchAxpy, dispatchAxpby,
  dispatchDotAndRead, dispatchTwoDotsAndRead,
  replaceStorageBufferData
} from './gpu-v2-dispatch.js';

const TRUE_RESID_INTERVAL = 25;
const LINEAR_NO_OP_GUARD_RATIO = 0.75;

function guardedLinearTarget(rawTargetTol, initialResidualNorm, rhsNorm) {
  const residual = Number(initialResidualNorm) || 0;
  const zeroTol = Math.max(1e-14, 1e-12 * Math.max(Number(rhsNorm) || 0, 1));
  if (residual <= zeroTol) return { target: rawTargetTol, capped: false, zeroTol };
  const cappedTarget = Math.min(rawTargetTol, Math.max(zeroTol, LINEAR_NO_OP_GUARD_RATIO * residual));
  return { target: cappedTarget, capped: cappedTarget < rawTargetTol, zeroTol };
}

export async function solveCgV2(ctx, {
  rhsBuf,
  x0Buf = null,
  maxIter = 5000,
  relTol = 1e-10,
  absTol = 1e-12,
  targetTol = null,
  stagnationWindow = 24,
  stagnationRatio = 0.995,
  stopOnNonPositiveCurvature = true,
  debug = false
}) {
  const { device, buffers, uniforms, numFree, helpers } = ctx;
  const log = debug ? (msg) => console.log(`[v2-cg] ${msg}`) : () => {};

  // Initialise: x = x0 (or zero); r = rhsBuf - A·x ; z = M^{-1} r ; p = z
  if (!x0Buf) {
    const zero = helpers.packDsVector(new Float64Array(numFree));
    await replaceStorageBufferData(ctx, 'x', zero, 'mf-cg-x-zero');
  } else {
    const enc = device.createCommandEncoder();
    helpers.writeAxpbyParams(uniforms.axpbyInit, dsFromF64(1), dsFromF64(0), numFree);
    dispatchAxpby(ctx, enc, uniforms.axpbyInit, x0Buf, buffers.x);
    device.queue.submit([enc.finish()]);
  }

  // r = rhsBuf  (since x=0). `rhsBuf` must be immutable for this solve:
  // `buffers.r` is the mutable Krylov residual workspace and true-residual
  // recomputes below need the original RHS.
  // If x0Buf is non-zero this still works because
  // we set r := rhsBuf, then r -= A·x0 below.
  {
    const enc = device.createCommandEncoder();
    helpers.writeAxpbyParams(uniforms.axpbyInit, dsFromF64(1), dsFromF64(0), numFree);
    dispatchAxpby(ctx, enc, uniforms.axpbyInit, rhsBuf, buffers.r);
    if (x0Buf) {
      // r -= A·x0
      dispatchMatvec(ctx, enc, x0Buf, buffers.Ap);
      helpers.writeAxpyParams(uniforms.axpyNegOne, dsFromF64(-1), numFree);
      dispatchAxpy(ctx, enc, uniforms.axpyNegOne, buffers.Ap, buffers.r);
    }
    // z = M⁻¹ r
    dispatchApplyPreconditioner(ctx, enc, buffers.r, buffers.z);
    // p = z
    helpers.writeAxpbyParams(uniforms.axpbyInit, dsFromF64(1), dsFromF64(0), numFree);
    dispatchAxpby(ctx, enc, uniforms.axpbyInit, buffers.z, buffers.p);
    device.queue.submit([enc.finish()]);
  }

  const [rz0, rhsNormSq] = await dispatchTwoDotsAndRead(ctx, buffers.r, buffers.z, rhsBuf, rhsBuf);
  let rz = rz0;
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const strictTargetTol = Math.max(absTol, relTol * rhsNorm);
  const requestedTargetTol = finitePositive(targetTol, 0);
  const rawEffectiveTargetTol = requestedTargetTol > 0
    ? Math.max(strictTargetTol, requestedTargetTol)
    : strictTargetTol;
  let residualNorm = Math.sqrt(Math.max(await dispatchDotAndRead(ctx, buffers.r, buffers.r), 0));
  const guardedTarget = guardedLinearTarget(rawEffectiveTargetTol, residualNorm, rhsNorm);
  const effectiveTargetTol = guardedTarget.target;
  let iter = 0;
  let converged = residualNorm <= effectiveTargetTol;
  let stopReason = converged ? 'initial-converged' : 'max-iter';
  let bestResidualNorm = residualNorm;
  let staleIterations = 0;
  log(`init: rhsNorm=${rhsNorm.toExponential(3)} resid=${residualNorm.toExponential(3)} rz=${rz.toExponential(3)} target=${effectiveTargetTol.toExponential(3)} strict=${strictTargetTol.toExponential(3)}`);

  // Sanity test: if rhsNorm is zero or non-finite, the linear solve is
  // trivially x=0 — and CG would otherwise stall.  This often happens when
  // F_int already balances b at the start of a Newton iteration.
  if (!Number.isFinite(rhsNorm) || rhsNorm === 0) {
    return { iterations: 0, residualNorm: 0, rhsNorm, targetTol: effectiveTargetTol, rawTargetTol: rawEffectiveTargetTol, targetWasCapped: guardedTarget.capped, strictTargetTol, relTol, absTol, converged: true, convergedStrict: true, stopReason: 'zero-rhs' };
  }
  for (iter = 1; iter <= maxIter && !converged; iter += 1) {
    // Ap = K p
    {
      const enc = device.createCommandEncoder();
      dispatchMatvec(ctx, enc, buffers.p, buffers.Ap);
      device.queue.submit([enc.finish()]);
    }
    const pAp = await dispatchDotAndRead(ctx, buffers.p, buffers.Ap);
    if (!Number.isFinite(pAp) || Math.abs(pAp) < 1e-300 || (stopOnNonPositiveCurvature && pAp <= 0)) {
      stopReason = pAp <= 0 ? 'non-positive-curvature' : 'degenerate-pAp';
      log(`stop iter ${iter}: pAp=${pAp} (${stopReason})`);
      break;
    }
    const alpha = rz / pAp;
    if (debug && iter <= 3) log(`iter ${iter}: alpha=${alpha.toExponential(3)} rz=${rz.toExponential(3)} pAp=${pAp.toExponential(3)} resid=${residualNorm.toExponential(3)}`);
    // x += α p ; r -= α Ap
    {
      const enc = device.createCommandEncoder();
      helpers.writeAxpyParams(uniforms.axpyAlpha,    dsFromF64(alpha),  numFree);
      helpers.writeAxpyParams(uniforms.axpyNegA,     dsFromF64(-alpha), numFree);
      dispatchAxpy(ctx, enc, uniforms.axpyAlpha, buffers.p,  buffers.x);
      dispatchAxpy(ctx, enc, uniforms.axpyNegA,  buffers.Ap, buffers.r);
      device.queue.submit([enc.finish()]);
    }
    if (iter % TRUE_RESID_INTERVAL === 0) {
      // r := rhsBuf - K x  (clear DS drift)
      const enc = device.createCommandEncoder();
      dispatchMatvec(ctx, enc, buffers.x, buffers.Ap);
      helpers.writeAxpbyParams(uniforms.axpbyInit, dsFromF64(1), dsFromF64(0), numFree);
      dispatchAxpby(ctx, enc, uniforms.axpbyInit, rhsBuf, buffers.r);
      dispatchAxpy (ctx, enc, uniforms.axpyNegOne, buffers.Ap, buffers.r);
      device.queue.submit([enc.finish()]);
    }
    // z = M⁻¹ r.  Compute both r·r and r·z in one scalar readback; this
    // deliberately applies M once even if r is already below target, because
    // avoiding one WebGPU mapAsync is worth more than skipping this dispatch
    // on hard high-iteration cases.
    {
      const enc = device.createCommandEncoder();
      dispatchApplyPreconditioner(ctx, enc, buffers.r, buffers.z);
      device.queue.submit([enc.finish()]);
    }
    const [rrNew, rzNew] = await dispatchTwoDotsAndRead(ctx, buffers.r, buffers.r, buffers.r, buffers.z);
    residualNorm = Math.sqrt(Math.max(rrNew, 0));
    if (debug && (iter <= 5 || iter % 50 === 0)) {
      log(`iter ${iter}: resid=${residualNorm.toExponential(3)} (target ${effectiveTargetTol.toExponential(3)})`);
    }
    if (residualNorm <= effectiveTargetTol) {
      converged = true;
      stopReason = residualNorm <= strictTargetTol ? 'strict-converged' : 'inexact-converged';
      break;
    }
    if (residualNorm < bestResidualNorm * stagnationRatio) {
      bestResidualNorm = residualNorm;
      staleIterations = 0;
    } else {
      staleIterations += 1;
      if (staleIterations >= Math.max(Math.round(Number(stagnationWindow) || 0), 1)) {
        stopReason = 'stagnated';
        log(`stop iter ${iter}: resid=${residualNorm.toExponential(3)} best=${bestResidualNorm.toExponential(3)} (${stopReason})`);
        break;
      }
    }
    const beta = Math.abs(rz) > 1e-300 ? rzNew / rz : 0;
    rz = rzNew;
    // p = z + β p
    {
      const enc = device.createCommandEncoder();
      helpers.writeAxpbyParams(uniforms.axpbyP, dsFromF64(1), dsFromF64(beta), numFree);
      dispatchAxpby(ctx, enc, uniforms.axpbyP, buffers.z, buffers.p);
      device.queue.submit([enc.finish()]);
    }
  }
  return {
    iterations: iter,
    residualNorm,
    rhsNorm,
    targetTol: effectiveTargetTol,
    rawTargetTol: rawEffectiveTargetTol,
    targetWasCapped: guardedTarget.capped,
    strictTargetTol,
    relTol,
    absTol,
    converged,
    convergedStrict: residualNorm <= strictTargetTol,
    stopReason
  };
}

function finitePositive(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
