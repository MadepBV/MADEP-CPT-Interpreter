// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GPU pipeline v2 — matrix-free preconditioned BiCGStab.
// =============================================================================
//
// van der Vorst (1992).  Used when the algorithmic tangent is non-symmetric
// (non-associated MC plasticity, ψ ≠ φ).  Same matrix-free K·x and same
// preconditioner contract as the CG driver — only the outer loop differs.
//
// Buffers consumed (from ctx.buffers):
//   x, r, b, p, v, s, t, y, z, rhat   — 10 free-DOF DS vectors
//
// All scalars are read back via DS dot for f64-equivalent precision (matches
// v1's CG / GMRES drivers).

import { dsFromF64 } from '../wgsl/ds.js';
import {
  dispatchMatvec, dispatchApplyPreconditioner,
  dispatchAxpy, dispatchAxpby, dispatchDotAndRead, dispatchTwoDotsAndRead,
  replaceStorageBufferData
} from './gpu-v2-dispatch.js';

const LINEAR_NO_OP_GUARD_RATIO = 0.75;
const TRUE_RESID_INTERVAL = 25;

function guardedLinearTarget(rawTargetTol, initialResidualNorm, rhsNorm) {
  const residual = Number(initialResidualNorm) || 0;
  const zeroTol = Math.max(1e-14, 1e-12 * Math.max(Number(rhsNorm) || 0, 1));
  if (residual <= zeroTol) return { target: rawTargetTol, capped: false, zeroTol };
  const cappedTarget = Math.min(rawTargetTol, Math.max(zeroTol, LINEAR_NO_OP_GUARD_RATIO * residual));
  return { target: cappedTarget, capped: cappedTarget < rawTargetTol, zeroTol };
}

export async function solveBicgstabV2(ctx, {
  rhsBuf,
  x0Buf = null,
  maxIter = 5000,
  relTol = 1e-10,
  absTol = 1e-12,
  targetTol = null,
  stagnationWindow = 32,
  stagnationRatio = 0.995,
  debug = false
}) {
  const { device, buffers, uniforms, numFree, helpers } = ctx;
  const log = debug ? (msg) => console.log(`[v2-bicgstab] ${msg}`) : () => {};

  // x = x0 (or zero); r = rhs - A·x. `rhsBuf` must be immutable for this
  // solve because `buffers.r` is the mutable Krylov residual workspace.
  if (!x0Buf) {
    const zero = helpers.packDsVector(new Float64Array(numFree));
    await replaceStorageBufferData(ctx, 'x', zero, 'mf-bicgstab-x-zero');
  } else {
    const enc = device.createCommandEncoder();
    helpers.writeAxpbyParams(uniforms.axpbyInit, dsFromF64(1), dsFromF64(0), numFree);
    dispatchAxpby(ctx, enc, uniforms.axpbyInit, x0Buf, buffers.x);
    device.queue.submit([enc.finish()]);
  }
  {
    const enc = device.createCommandEncoder();
    helpers.writeAxpbyParams(uniforms.axpbyInit, dsFromF64(1), dsFromF64(0), numFree);
    dispatchAxpby(ctx, enc, uniforms.axpbyInit, rhsBuf, buffers.r);
    if (x0Buf) {
      dispatchMatvec(ctx, enc, x0Buf, buffers.Ap);
      helpers.writeAxpyParams(uniforms.axpyNegOne, dsFromF64(-1), numFree);
      dispatchAxpy(ctx, enc, uniforms.axpyNegOne, buffers.Ap, buffers.r);
    }
    // rhat = r ; p = 0 ; v = 0 (zeros via zero-pack)
    dispatchAxpby(ctx, enc, uniforms.axpbyInit, buffers.r, buffers.rhat);
    device.queue.submit([enc.finish()]);
  }
  // Zero p, v.
  const zeroVec = helpers.packDsVector(new Float64Array(numFree));
  await replaceStorageBufferData(ctx, 'p', zeroVec, 'mf-bicgstab-p-zero');
  await replaceStorageBufferData(ctx, 'v', zeroVec, 'mf-bicgstab-v-zero');

  let rho = 1, alpha = 1, omega = 1;
  const [rhsNormSq, initialRr] = await dispatchTwoDotsAndRead(ctx, rhsBuf, rhsBuf, buffers.r, buffers.r);
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const strictTargetTol = Math.max(absTol, relTol * rhsNorm);
  const requestedTargetTol = finitePositive(targetTol, 0);
  const rawEffectiveTargetTol = requestedTargetTol > 0
    ? Math.max(strictTargetTol, requestedTargetTol)
    : strictTargetTol;
  let residualNorm = Math.sqrt(Math.max(initialRr, 0));
  const guardedTarget = guardedLinearTarget(rawEffectiveTargetTol, residualNorm, rhsNorm);
  const effectiveTargetTol = guardedTarget.target;
  let iter = 0;
  let converged = residualNorm <= effectiveTargetTol;
  let stopReason = converged ? 'initial-converged' : 'max-iter';
  let bestResidualNorm = residualNorm;
  let staleIterations = 0;
  log(`init: rhsNorm=${rhsNorm.toExponential(3)} resid=${residualNorm.toExponential(3)} target=${effectiveTargetTol.toExponential(3)} strict=${strictTargetTol.toExponential(3)}`);

  if (!Number.isFinite(rhsNorm) || rhsNorm === 0) {
    return { iterations: 0, residualNorm: 0, rhsNorm, targetTol: effectiveTargetTol, rawTargetTol: rawEffectiveTargetTol, targetWasCapped: guardedTarget.capped, strictTargetTol, relTol, absTol, converged: true, convergedStrict: true, stopReason: 'zero-rhs' };
  }

  for (iter = 1; iter <= maxIter && !converged; iter += 1) {
    const rhoNew = await dispatchDotAndRead(ctx, buffers.rhat, buffers.r);
    if (!Number.isFinite(rhoNew) || Math.abs(rhoNew) < 1e-300) {
      stopReason = 'rho-breakdown';
      log(`stop iter ${iter}: rho=${rhoNew} (breakdown)`);
      break;
    }
    const beta = (rhoNew / rho) * (alpha / omega);
    if (!Number.isFinite(beta)) {
      stopReason = 'beta-breakdown';
      log(`stop iter ${iter}: beta=${beta} rho=${rhoNew} alpha=${alpha} omega=${omega} (breakdown)`);
      break;
    }
    rho = rhoNew;
    // p := r + β (p − ω v)    — encoded as:   p := p − ω v ;  p := r + β·p
    // CRITICAL: each axpby must read its own parameter buffer. Dynamic parameter
    // uploads are queued before the submitted compute command executes, so
    // aliasing one uniform across two dispatches would make both reads see
    // the last-uploaded value.
    helpers.writeAxpbyParams(uniforms.axpbyPV,  dsFromF64(-omega), dsFromF64(1),    numFree);
    helpers.writeAxpbyParams(uniforms.axpbyPMix, dsFromF64(1),     dsFromF64(beta), numFree);
    {
      const enc = device.createCommandEncoder();
      dispatchAxpby(ctx, enc, uniforms.axpbyPV,  buffers.v, buffers.p);   // p := −ω v + 1·p
      dispatchAxpby(ctx, enc, uniforms.axpbyPMix, buffers.r, buffers.p);  // p := 1·r + β·p
      device.queue.submit([enc.finish()]);
    }
    // y = M⁻¹ p ; v = A y
    {
      const enc = device.createCommandEncoder();
      dispatchApplyPreconditioner(ctx, enc, buffers.p, buffers.y);
      dispatchMatvec(ctx, enc, buffers.y, buffers.v);
      device.queue.submit([enc.finish()]);
    }
    const rhatV = await dispatchDotAndRead(ctx, buffers.rhat, buffers.v);
    if (!Number.isFinite(rhatV) || Math.abs(rhatV) < 1e-300) {
      stopReason = 'rhat-v-breakdown';
      log(`stop iter ${iter}: rhatV=${rhatV} (breakdown)`);
      break;
    }
    alpha = rho / rhatV;
    if (!Number.isFinite(alpha)) {
      stopReason = 'alpha-breakdown';
      log(`stop iter ${iter}: alpha=${alpha} rho=${rho} rhatV=${rhatV} (breakdown)`);
      break;
    }
    // s = r − α v
    // s = r − α v.  axpbyInit holds (1, 0, n) statically (mappedAtCreation).
    helpers.writeAxpyParams(uniforms.axpyNegA, dsFromF64(-alpha), numFree);
    {
      const enc = device.createCommandEncoder();
      dispatchAxpby(ctx, enc, uniforms.axpbyInit, buffers.r, buffers.s);   // s := r
      dispatchAxpy (ctx, enc, uniforms.axpyNegA,  buffers.v, buffers.s);   // s -= α v
      device.queue.submit([enc.finish()]);
    }
    const sNorm = Math.sqrt(Math.max(await dispatchDotAndRead(ctx, buffers.s, buffers.s), 0));
    if (sNorm <= effectiveTargetTol) {
      // x := x + α y
      const enc = device.createCommandEncoder();
      helpers.writeAxpyParams(uniforms.axpyAlpha, dsFromF64(alpha), numFree);
      dispatchAxpy(ctx, enc, uniforms.axpyAlpha, buffers.y, buffers.x);
      device.queue.submit([enc.finish()]);
      residualNorm = sNorm;
      converged = true;
      stopReason = residualNorm <= strictTargetTol ? 'strict-converged' : 'inexact-converged';
      break;
    }
    // z = M⁻¹ s ; t = A z
    {
      const enc = device.createCommandEncoder();
      dispatchApplyPreconditioner(ctx, enc, buffers.s, buffers.z);
      dispatchMatvec(ctx, enc, buffers.z, buffers.t);
      device.queue.submit([enc.finish()]);
    }
    const [ts, tt] = await dispatchTwoDotsAndRead(ctx, buffers.t, buffers.s, buffers.t, buffers.t);
    if (!Number.isFinite(ts) || !Number.isFinite(tt) || tt < 1e-300) {
      stopReason = 'tt-breakdown';
      log(`stop iter ${iter}: ts=${ts} tt=${tt} (breakdown)`);
      break;
    }
    omega = ts / tt;
    if (!Number.isFinite(omega) || Math.abs(omega) < 1e-300) {
      stopReason = 'omega-breakdown';
      log(`stop iter ${iter}: omega=${omega} ts=${ts} tt=${tt} (breakdown)`);
      break;
    }
    // x := x + α y + ω z ;  r := s − ω t
    // CRITICAL: each dispatch in this batch must read its own parameter buffer.
    helpers.writeAxpyParams(uniforms.axpyAlphaY,    dsFromF64(alpha),  numFree);
    helpers.writeAxpyParams(uniforms.axpyOmegaZ,    dsFromF64(omega),  numFree);
    helpers.writeAxpyParams(uniforms.axpyNegOmegaT, dsFromF64(-omega), numFree);
    {
      const enc = device.createCommandEncoder();
      dispatchAxpy (ctx, enc, uniforms.axpyAlphaY,    buffers.y, buffers.x);   // x += α y
      dispatchAxpy (ctx, enc, uniforms.axpyOmegaZ,    buffers.z, buffers.x);   // x += ω z
      dispatchAxpby(ctx, enc, uniforms.axpbyInit,     buffers.s, buffers.r);   // r := s
      dispatchAxpy (ctx, enc, uniforms.axpyNegOmegaT, buffers.t, buffers.r);   // r -= ω t
      device.queue.submit([enc.finish()]);
    }
    if (iter % TRUE_RESID_INTERVAL === 0) {
      // r := rhsBuf - A x. BiCGStab updates r recursively, so DS roundoff
      // can make the reported residual drift on long hard-plastic solves.
      const enc = device.createCommandEncoder();
      dispatchMatvec(ctx, enc, buffers.x, buffers.Ap);
      helpers.writeAxpbyParams(uniforms.axpbyInit, dsFromF64(1), dsFromF64(0), numFree);
      dispatchAxpby(ctx, enc, uniforms.axpbyInit, rhsBuf, buffers.r);
      dispatchAxpy(ctx, enc, uniforms.axpyNegOne, buffers.Ap, buffers.r);
      device.queue.submit([enc.finish()]);
    }
    residualNorm = Math.sqrt(Math.max(await dispatchDotAndRead(ctx, buffers.r, buffers.r), 0));
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
