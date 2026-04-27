// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Deterministic mixed-precision CPU backend. Mirrors the exact data-flow of
// the WebGL2 GPU backend (ELLPACK pack, Float32 matvec, periodic f64
// residual refresh from the solver) but runs entirely on the CPU. This
// exists so the verification script and non-browser contexts can exercise
// the GPU code path without needing a real WebGL context, and so roundoff
// drift introduced by f32 matvec is caught deterministically before it
// reaches production hardware.

import {
  computeEllpackShape,
  createEllpackBuffer,
  ellpackMatvecReference,
  ellpackPatternMatches,
  packEllpackIndices,
  packEllpackValues
} from './ellpack.js';
import {
  elementElasticStiffnessReference,
  elementInternalForceReference,
  elementStrainReference,
  ensureElementKernelBuffer
} from './elements.js';
import {
  elementElasticStiffnessReferenceT6,
  elementInternalForceReferenceT6,
  elementStrainReferenceT6,
  ensureElementKernelBufferT6
} from './elements-t6.js';

function elementCachesKind(elementCaches) {
  const first = elementCaches?.[0]?.kind === 't6' ? 't6' : 't3';
  for (let i = 1; i < (elementCaches?.length || 0); i += 1) {
    const k = elementCaches[i]?.kind === 't6' ? 't6' : 't3';
    if (k !== first) {
      throw new Error('Element-kernel buffer received mixed element types; this configuration is not supported.');
    }
  }
  return first;
}

export function createCpuF32Backend(setup = {}) {
  let buffer = null;
  let elementBufferT3 = null;
  let elementBufferT6 = null;
  let precisionMode = String(setup?.precisionMode || 'f32').toLowerCase() === 'double-single' ? 'double-single' : 'f32';
  let residualRefreshInterval = Math.max(Math.round(Number(setup?.residualRefreshInterval) || 25), 1);
  let vectorF32Buffer = null;
  let displacementF32Buffer = null;
  let stressF32Buffer = null;
  let tangentF32Buffer = null;

  function ensureBuffer(rows) {
    if (buffer && buffer.rowsRef === rows) return;
    const { numRows, maxRowLen } = computeEllpackShape(rows);
    if (
      buffer
      && buffer.numRows === numRows
      && buffer.maxRowLen === maxRowLen
      && ellpackPatternMatches(buffer, rows)
    ) {
      if (buffer.rowsRef !== rows) packEllpackValues(buffer, rows);
      return;
    }
    if (!buffer || buffer.numRows !== numRows || buffer.maxRowLen !== maxRowLen) {
      buffer = createEllpackBuffer({
        numRows,
        maxRowLen,
        valueDtype: precisionMode === 'double-single' ? 'ds' : 'f32'
      });
    }
    packEllpackIndices(buffer, rows);
    packEllpackValues(buffer, rows);
  }

  function ensureElementBuffer(elementCaches) {
    const kind = elementCachesKind(elementCaches);
    if (kind === 't6') {
      if (elementBufferT6 && elementBufferT6.identityKey === elementCaches) return elementBufferT6;
      elementBufferT6 = ensureElementKernelBufferT6(elementBufferT6, elementCaches);
      return elementBufferT6;
    }
    if (elementBufferT3 && elementBufferT3.identityKey === elementCaches) return elementBufferT3;
    elementBufferT3 = ensureElementKernelBuffer(elementBufferT3, elementCaches);
    return elementBufferT3;
  }

  function ensureFloat32Buffer(source, existing = null) {
    const requiredLength = source?.length || 0;
    const target = existing && existing.length === requiredLength
      ? existing
      : new Float32Array(requiredLength);
    for (let index = 0; index < requiredLength; index += 1) {
      // Coerce non-finite inputs to 0 and re-check post-assignment so a
      // huge finite f64 (>~3.4e38) silently becoming Infinity in f32
      // storage is also caught — mirrors the webgl-backend's defensive
      // check so the cpu-f32 surrogate produces the same outputs.
      const raw = Number(source[index]);
      target[index] = Number.isFinite(raw) ? raw : 0;
      if (!Number.isFinite(target[index])) target[index] = 0;
    }
    return target;
  }

  function matvec(rows, vector) {
    if (!rows.length) return new Float64Array(0);
    ensureBuffer(rows);
    const narrowedVector = precisionMode === 'double-single'
      ? Float64Array.from(vector)
      : (vectorF32Buffer = ensureFloat32Buffer(vector, vectorF32Buffer));
    return ellpackMatvecReference(buffer, narrowedVector);
  }

  function elementStrain(elementCaches, displacementVector) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const typedBuffer = ensureElementBuffer(elementCaches);
    const narrowed = displacementF32Buffer = ensureFloat32Buffer(displacementVector, displacementF32Buffer);
    return typedBuffer.elementType === 't6'
      ? elementStrainReferenceT6(typedBuffer, narrowed)
      : elementStrainReference(typedBuffer, narrowed);
  }

  function elementInternalForce(elementCaches, stressFlat) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const typedBuffer = ensureElementBuffer(elementCaches);
    const narrowed = stressF32Buffer = ensureFloat32Buffer(stressFlat, stressF32Buffer);
    return typedBuffer.elementType === 't6'
      ? elementInternalForceReferenceT6(typedBuffer, narrowed)
      : elementInternalForceReference(typedBuffer, narrowed);
  }

  function elementElasticStiffness(elementCaches, tangentFlat) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const typedBuffer = ensureElementBuffer(elementCaches);
    const narrowed = tangentF32Buffer = ensureFloat32Buffer(tangentFlat, tangentF32Buffer);
    return typedBuffer.elementType === 't6'
      ? elementElasticStiffnessReferenceT6(typedBuffer, narrowed)
      : elementElasticStiffnessReference(typedBuffer, narrowed);
  }

  // CPU surrogate for the WebGL backend's solveCgPreconditionedGpu.
  // Same algorithm; same f32 narrowing of vectors, same residual
  // refresh cadence. The point is bit-comparable behaviour: a
  // verification run in node should reproduce the browser run record
  // exactly modulo determinism that depends on real hardware (which is
  // none in this code path).
  async function solveCgPreconditionedGpu({
    rows,
    rhs,
    initial = null,
    preconditioner,
    maxIter,
    relTol,
    absTol,
    runControl,
    iterationObserver,
    residualRefreshIntervalForCheckpoint
  }) {
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
    ensureBuffer(rows);
    // Narrow to f32 so this surrogate exhibits the same precision
    // behaviour as the WebGL kernels (and our verification can detect
    // any drift the f32 storage introduces).
    const narrow = (src, existing) => {
      const requiredLength = src?.length || 0;
      const target = existing && existing.length === requiredLength
        ? existing
        : new Float32Array(requiredLength);
      for (let i = 0; i < requiredLength; i += 1) {
        const raw = Number(src[i]);
        target[i] = Number.isFinite(raw) ? raw : 0;
        if (!Number.isFinite(target[i])) target[i] = 0;
      }
      return target;
    };
    const matvecF32 = (vec) => ellpackMatvecReference(buffer, vec);
    // Block-Jacobi application matching the WebGL kernel's
    // fixed-offset layout: z[i] uses r[i], r[i-1], r[i+1] only. Index
    // clamping at the boundaries; the prev/next coefficients there are
    // zero by construction so the boundary value contributes nothing.
    const applyPrecond = (rIn, zOut) => {
      const last = n - 1;
      for (let i = 0; i < n; i += 1) {
        const iPrev = i === 0 ? 0 : i - 1;
        const iNext = i === last ? last : i + 1;
        zOut[i] = preconditioner.selfCoef[i] * rIn[i]
          + preconditioner.prevCoef[i] * rIn[iPrev]
          + preconditioner.nextCoef[i] * rIn[iNext];
      }
    };
    // The dot product mirrors the GPU's double-single (DS) reduction
    // *exactly*: every intermediate is rounded to f32 via Math.fround,
    // and accumulation uses twoSum so the running compensation `lo`
    // captures the rounding error of every f32 add. Final scalar is
    // hi + lo in JS f64 (exact). This surrogate is bit-comparable to
    // what the WebGL2 path computes — a bug in the DS algorithm shows
    // up here in node, not just on real GPU.
    const REDUCTION_STRIDE_LOCAL = 64;
    const f32 = Math.fround;
    const dotDsReduce = (a, b) => {
      // Stage 1: f32 elementwise product (one Math.fround per multiply
      // to model the GPU's f32 multiplier). The product texture isn't
      // physically materialised; we feed each product directly into
      // the first reduction pass through a shared closure.
      let pairs = [];
      let pairsCount = Math.max(1, Math.ceil(n / REDUCTION_STRIDE_LOCAL));
      // First pass: f32 input -> DS pair output
      for (let p = 0; p < pairsCount; p += 1) {
        let hi = 0;
        let lo = 0;
        for (let k = 0; k < REDUCTION_STRIDE_LOCAL; k += 1) {
          const idx = p * REDUCTION_STRIDE_LOCAL + k;
          if (idx >= n) break;
          const x = f32(f32(a[idx]) * f32(b[idx]));
          // twoSum(hi, x) in f32
          const s = f32(hi + x);
          const bb = f32(s - hi);
          const e = f32(f32(hi - f32(s - bb)) + f32(x - bb));
          hi = s;
          lo = f32(lo + e);
        }
        // Final renormalise
        const sFinal = f32(hi + lo);
        const bbFinal = f32(sFinal - hi);
        const eFinal = f32(f32(hi - f32(sFinal - bbFinal)) + f32(lo - bbFinal));
        pairs.push(sFinal, eFinal);
      }
      // Subsequent passes: pair input -> pair output
      while (pairsCount > 1) {
        const nextCount = Math.max(1, Math.ceil(pairsCount / REDUCTION_STRIDE_LOCAL));
        const nextPairs = [];
        for (let p = 0; p < nextCount; p += 1) {
          let hi = 0;
          let lo = 0;
          for (let k = 0; k < REDUCTION_STRIDE_LOCAL; k += 1) {
            const idx = p * REDUCTION_STRIDE_LOCAL + k;
            if (idx >= pairsCount) break;
            const xHi = pairs[idx * 2];
            const xLo = pairs[idx * 2 + 1];
            const s = f32(hi + xHi);
            const bb = f32(s - hi);
            const e = f32(f32(hi - f32(s - bb)) + f32(xHi - bb));
            hi = s;
            lo = f32(f32(lo + e) + xLo);
          }
          const sFinal = f32(hi + lo);
          const bbFinal = f32(sFinal - hi);
          const eFinal = f32(f32(hi - f32(sFinal - bbFinal)) + f32(lo - bbFinal));
          nextPairs.push(sFinal, eFinal);
        }
        pairs = nextPairs;
        pairsCount = nextCount;
      }
      const hiFinal = pairs[0];
      const loFinal = pairs[1];
      // hi + lo in JS f64 — exact since both are f32 values and f64
      // has 53 mantissa bits vs f32's 24, so the sum is representable
      // without further loss.
      return hiFinal + loFinal;
    };
    const dotF64 = dotDsReduce;

    const rhsF32 = narrow(rhs, null);
    let xF32 = initial && initial.length === n
      ? narrow(initial, null)
      : new Float32Array(n);
    let rF32 = new Float32Array(n);
    {
      const ax = matvecF32(xF32);
      for (let i = 0; i < n; i += 1) {
        const v = rhsF32[i] - ax[i];
        rF32[i] = Number.isFinite(v) ? v : 0;
      }
    }
    const zF32 = new Float32Array(n);
    applyPrecond(rF32, zF32);
    let pF32 = new Float32Array(n);
    for (let i = 0; i < n; i += 1) pF32[i] = zF32[i];

    let rhsNorm2 = 0;
    for (let i = 0; i < n; i += 1) rhsNorm2 += rhs[i] * rhs[i];
    const rhsNorm = Math.sqrt(rhsNorm2);
    const tolTarget = Math.max(absTol || 0, (relTol || 0) * rhsNorm);
    const isStopRequested = () => {
      if (typeof runControl?.shouldStop === 'function') return !!runControl.shouldStop();
      if (typeof runControl?.shouldInterrupt === 'function') return !!runControl.shouldInterrupt();
      return false;
    };
    const checkpoint = async (force = false) => {
      if (typeof runControl?.checkpoint === 'function') {
        return !!(await runControl.checkpoint({ force }));
      }
      return isStopRequested();
    };
    const trueResidualNormForSolution = (solution) => {
      const ax = ellpackMatvecReference(buffer, solution);
      let r2 = 0;
      for (let i = 0; i < n; i += 1) {
        const ri = rhs[i] - ax[i];
        r2 += ri * ri;
      }
      return Math.sqrt(Math.max(r2, 0));
    };
    const finishWithTrueResidual = (solution, convergedCandidate, iterations, recurrenceResidualNorm, label) => {
      const trueResidualNorm = trueResidualNormForSolution(solution);
      const converged = convergedCandidate === true && trueResidualNorm <= tolTarget;
      return {
        solution,
        converged,
        iterations,
        residualNorm: trueResidualNorm,
        trueResidualNorm,
        recurrenceResidualNorm,
        relativeResidual: rhsNorm > 1e-30 ? trueResidualNorm / rhsNorm : 0,
        rhsNorm,
        toleranceTarget: tolTarget,
        usedTrueResidualAcceptance: true,
        fallbackReason: converged ? '' : `${label}-true-residual-mismatch:${recurrenceResidualNorm}->${trueResidualNorm}`,
        interrupted: false
      };
    };

    let rNorm2 = dotF64(rF32, rF32);
    let residualNorm = Math.sqrt(Math.max(rNorm2, 0));
    if (residualNorm <= tolTarget) {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i += 1) out[i] = xF32[i];
      return finishWithTrueResidual(out, true, 0, residualNorm, 'cpu-f32-resident-cg');
    }
    let rzOld = dotF64(rF32, zF32);

    let iter = 0;
    for (iter = 1; iter <= maxIter; iter += 1) {
      if ((iter === 1 || iter % 25 === 0) && await checkpoint()) {
        const out = new Float64Array(n);
        for (let i = 0; i < n; i += 1) out[i] = xF32[i];
        return {
          solution: out,
          converged: false,
          iterations: iter,
          residualNorm,
          trueResidualNorm: residualNorm,
          relativeResidual: rhsNorm > 1e-30 ? residualNorm / rhsNorm : 0,
          rhsNorm,
          toleranceTarget: tolTarget,
          interrupted: true
        };
      }
      const apF32 = matvecF32(pF32);
      const denom = dotF64(pF32, apF32);
      if (!Number.isFinite(denom) || Math.abs(denom) < 1e-30) {
        break;
      }
      const alpha = rzOld / denom;
      for (let i = 0; i < n; i += 1) {
        xF32[i] = xF32[i] + alpha * pF32[i];
        rF32[i] = rF32[i] - alpha * apF32[i];
      }

      let didRefresh = false;
      if (residualRefreshIntervalForCheckpoint > 0
          && iter % residualRefreshIntervalForCheckpoint === 0) {
        const xCpu = new Float64Array(n);
        for (let i = 0; i < n; i += 1) xCpu[i] = xF32[i];
        const ax = ellpackMatvecReference(buffer, xCpu);
        for (let i = 0; i < n; i += 1) rF32[i] = rhs[i] - ax[i];
        didRefresh = true;
      }

      rNorm2 = dotF64(rF32, rF32);
      residualNorm = Math.sqrt(Math.max(rNorm2, 0));
      if (iterationObserver && (iter === 1 || iter % 25 === 0)) {
        await iterationObserver({
          iterations: iter, residualNorm,
          relativeResidual: rhsNorm > 1e-30 ? residualNorm / rhsNorm : 0,
          rhsNorm, toleranceTarget: tolTarget
        });
      }
      if (residualNorm <= tolTarget) {
        const out = new Float64Array(n);
        for (let i = 0; i < n; i += 1) out[i] = xF32[i];
        return finishWithTrueResidual(out, true, iter, residualNorm, 'cpu-f32-resident-cg');
      }
      applyPrecond(rF32, zF32);
      const rzNew = dotF64(rF32, zF32);
      const beta = didRefresh ? 0 : (Math.abs(rzOld) > 1e-30 ? rzNew / rzOld : 0);
      for (let i = 0; i < n; i += 1) pF32[i] = zF32[i] + beta * pF32[i];
      rzOld = rzNew;
    }

    const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) out[i] = xF32[i];
    return finishWithTrueResidual(out, false, Math.min(iter, maxIter), residualNorm, 'cpu-f32-resident-cg-not-converged');
  }

  function setPrecisionMode(nextMode = 'f32') {
    const normalized = String(nextMode || 'f32').toLowerCase();
    const resolved = normalized === 'double-single' ? 'double-single' : 'f32';
    if (resolved === precisionMode) return precisionMode;
    precisionMode = resolved;
    buffer = null;
    return precisionMode;
  }

  function setResidualRefreshInterval(nextInterval = residualRefreshInterval) {
    residualRefreshInterval = Math.max(Math.round(Number(nextInterval) || residualRefreshInterval), 1);
    return residualRefreshInterval;
  }

  function dispose() {
    buffer = null;
    elementBufferT3 = null;
    elementBufferT6 = null;
    vectorF32Buffer = null;
    displacementF32Buffer = null;
    stressF32Buffer = null;
    tangentF32Buffer = null;
  }

  return {
    get name() {
      return precisionMode === 'double-single' ? 'cpu-double-single' : 'cpu-f32';
    },
    get precision() {
      return precisionMode === 'double-single' ? 'double-single' : 'f32';
    },
    supportsDoubleSingle: true,
    supportsElementKernels: true,
    supportsT3ElementKernels: true,
    supportsT6ElementKernels: true,
    requiresResidualRefresh: true,
    // Match webgl-backend's `matrixMaxAbsValue` / `matrixMaxRowLen`
    // accessors so the solver's adaptive matvec pre-check works
    // identically on both backends. cpu-f32 doesn't enforce f32
    // overflow (the host is f64), so an unset bound is fine — the
    // solver treats `0` as "no information available".
    get matrixMaxAbsValue() { return buffer?.maxAbsValue ?? 0; },
    get matrixMaxRowLen() { return buffer?.maxRowLen ?? 0; },
    // CPU surrogate of the WebGL backend's GPU-resident CG. The solver
    // dispatches through `solveCgPreconditionedGpu` whenever the active
    // backend exposes it; this implementation lets the verification
    // sweep cover the same algorithm in node.
    supportsResidentCg: true,
    supportsResidentGmres: false,
    residentCgCertified: false,
    residentGmresCertified: false,
    capabilities: {
      residentCg: true,
      residentGmres: false,
      residentBicgstab: false,
      t3ElementKernels: true,
      t6ElementKernels: true,
      nonlinearAssembly: false,
      materialKernels: false,
      trueResidualOnGpu: false,
      supportsCancellation: true
    },
    certification: {
      residentCg: 'unit',
      residentGmres: 'none',
      nonlinearAssembly: 'none',
      mcMaterial: 'none'
    },
    solveCgPreconditionedGpu,
    get precisionMode() { return precisionMode; },
    get residualRefreshInterval() { return residualRefreshInterval; },
    matvec,
    elementStrain,
    elementInternalForce,
    elementElasticStiffness,
    setPrecisionMode,
    setResidualRefreshInterval,
    dispose
  };
}
