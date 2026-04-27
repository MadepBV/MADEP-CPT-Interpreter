// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// WebGL2 GPU.js backend for the deformation solver. The sparse Krylov matvec
// remains the primary acceleration target, but the same backend also exposes
// batch element-strain, internal-force, and elastic element-stiffness kernels
// so the solver can offload the branch-free assembly arithmetic while keeping
// the exact MC return-map and the scatter on the CPU.

import {
  computeEllpackShape,
  createEllpackBuffer,
  ellpackPatternMatches,
  packEllpackIndices,
  packEllpackValues
} from './ellpack.js';
import {
  ELEMENT_B_STRIDE,
  ELEMENT_FORCE_STRIDE,
  ELEMENT_STIFFNESS_STRIDE,
  ELEMENT_STRAIN_STRIDE,
  elementElasticStiffnessReference,
  elementInternalForceReference,
  elementStrainReference,
  ensureElementKernelBuffer
} from './elements.js';
import {
  T6_ELEMENT_FORCE_STRIDE,
  T6_ELEMENT_STIFFNESS_STRIDE,
  T6_ELEMENT_STRAIN_STRIDE,
  T6_ELEMENT_TANGENT_STRIDE_PER_GP,
  elementElasticStiffnessReferenceT6,
  elementInternalForceReferenceT6,
  elementStrainReferenceT6,
  ensureElementKernelBufferT6
} from './elements-t6.js';

function elementCachesKindFromCache(elementCaches) {
  return elementCaches?.[0]?.kind === 't6' ? 't6' : 't3';
}
import { createFloat32PairArrays, fillFloat32PairArrays } from './double-single.js';
import { loadGpuJs, newProbeCanvas } from './probe.js';

// ELLPACK padding ratio = flatLen / nnz. The f32 GPU matvec iterates
// maxRowLen times per row regardless of the actual row length, so a
// padding ratio of K means the kernel does K× the necessary FLOPs and
// uploads K× the necessary memory.
//
// 2.0 was tuned for T3 (uniform valence). T6 has corner nodes with high
// valence and mid-edge nodes with valence 2 (each mid-edge sits on
// exactly two triangles), giving routine padding ratios of 2.5–3.0
// without indicating any pathology. Even at 4× padding the f32 GPU
// path still beats CPU f64 on the same matvec because the per-flop
// cost is far lower; the guard exists to catch truly degenerate
// configurations (one giant row in a tiny mesh, mesh corruption, etc.)
// rather than to filter out the normal T6 connectivity pattern.
const GPU_MAX_PADDING_RATIO = 4.0;
const GPU_F32_RESIDUAL_REFRESH_INTERVAL = 25;
const GPU_DOUBLE_SINGLE_RESIDUAL_REFRESH_INTERVAL = 10;

function destroyKernel(kernel) {
  if (!kernel) return;
  try { kernel.destroy?.(); } catch { /* ignore */ }
}

function normalizeKernelOutput(rawOut, expectedLength, diagnosticContext = null) {
  if (!Number.isFinite(expectedLength) || expectedLength <= 0) return new Float64Array(0);
  const source = rawOut?.length != null
    ? rawOut
    : (typeof rawOut?.toArray === 'function' ? rawOut.toArray() : []);
  const result = new Float64Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const value = Number(source?.[index]) || 0;
    if (!Number.isFinite(value)) {
      // Build a richer diagnostic if the caller provides input
      // statistics. The message includes the offending row index
      // alongside the matrix and vector magnitude bounds for that row,
      // so a downstream "matrix appears too ill-conditioned" warning
      // points at the specific structural problem rather than at the
      // generic precision question.
      const detail = diagnosticContext
        ? formatKernelOutputNanDetail(diagnosticContext, index, value)
        : '';
      throw new Error(`GPU kernel produced a non-finite value at index ${index}${detail ? ` (${detail})` : ''}; forcing CPU fallback.`);
    }
    result[index] = value;
  }
  return result;
}

function formatKernelOutputNanDetail(context, rowIndex, value) {
  // `context` carries { rows, vector, maxRowLen, kind: 'matvec'|'element-*' }.
  // We surface the row's largest |val| and largest |x[col]| so the run
  // record explains *what* in the row triggered the overflow. If the
  // context fails to provide what we need we silently return '' — the
  // outer error message still names the kind and index.
  if (!context || context.kind !== 'matvec') return '';
  const { rows, vector } = context;
  if (!rows || !vector || rowIndex >= rows.length) return '';
  const row = rows[rowIndex];
  const indices = row?.indices;
  const values = row?.values;
  if (!indices || !values) return '';
  let maxAbsVal = 0;
  let maxAbsValAt = -1;
  let maxAbsVec = 0;
  let maxAbsVecAt = -1;
  for (let k = 0; k < indices.length; k += 1) {
    const v = Math.abs(Number(values[k]) || 0);
    if (v > maxAbsVal) { maxAbsVal = v; maxAbsValAt = indices[k]; }
    const x = Math.abs(Number(vector?.[indices[k]]) || 0);
    if (x > maxAbsVec) { maxAbsVec = x; maxAbsVecAt = indices[k]; }
  }
  const product = maxAbsVal * maxAbsVec;
  return `output ${value}; row max|matrix| ${maxAbsVal.toExponential(2)} at col ${maxAbsValAt}; row max|x| ${maxAbsVec.toExponential(2)} at col ${maxAbsVecAt}; per-term ceiling ${product.toExponential(2)} (f32 max ~3.4e+38)`;
}

function checkTextureBudget(label, flatLength, maxTextureSize) {
  const limit = Math.max(Number(maxTextureSize) || 0, 0);
  if (!(limit > 0)) return;
  if (flatLength > limit * limit) {
    throw new Error(`${label} exceeds the WebGL texture budget (${flatLength} values > ${limit}^2).`);
  }
}

function buildMatvecKernelF32(gpu, numRows, maxRowLen) {
  return gpu.createKernel(function (cols, vals, x, maxLen) {
    const row = this.thread.x;
    let sum = 0.0;
    for (let k = 0; k < this.constants.MAX_LOOP; k++) {
      if (k >= maxLen) break;
      const col = cols[row * this.constants.MAX_LOOP + k];
      sum += vals[row * this.constants.MAX_LOOP + k] * x[col];
    }
    return sum;
  }, {
    constants: { MAX_LOOP: Math.max(maxRowLen, 1) },
    loopMaxIterations: Math.max(maxRowLen, 1),
    output: [numRows],
    pipeline: false,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

function buildMatvecKernelDoubleSingle(gpu, numRows, maxRowLen) {
  return gpu.createKernel(function (cols, valsHi, valsLo, xHi, xLo, maxLen) {
    const row = this.thread.x;
    let sum = 0.0;
    for (let k = 0; k < this.constants.MAX_LOOP; k++) {
      if (k >= maxLen) break;
      const entry = row * this.constants.MAX_LOOP + k;
      const col = cols[entry];
      const aHi = valsHi[entry];
      const aLo = valsLo[entry];
      const xh = xHi[col];
      const xl = xLo[col];
      sum += (aHi * xh) + (aHi * xl) + (aLo * xh) + (aLo * xl);
    }
    return sum;
  }, {
    constants: { MAX_LOOP: Math.max(maxRowLen, 1) },
    loopMaxIterations: Math.max(maxRowLen, 1),
    output: [numRows],
    pipeline: false,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

function buildElementStrainKernel(gpu, flatLength) {
  return gpu.createKernel(function (bFlat, dofsFlat, displacement) {
    const flatIndex = this.thread.x;
    const elementIndex = Math.floor(flatIndex / 3.0);
    const component = flatIndex - elementIndex * 3;
    const bBase = elementIndex * 18;
    const dofBase = elementIndex * 6;
    const u0 = displacement[dofsFlat[dofBase]];
    const u1 = displacement[dofsFlat[dofBase + 1]];
    const u2 = displacement[dofsFlat[dofBase + 2]];
    const u3 = displacement[dofsFlat[dofBase + 3]];
    const u4 = displacement[dofsFlat[dofBase + 4]];
    const u5 = displacement[dofsFlat[dofBase + 5]];
    const rowBase = component * 6;
    return bFlat[bBase + rowBase] * u0
      + bFlat[bBase + rowBase + 1] * u1
      + bFlat[bBase + rowBase + 2] * u2
      + bFlat[bBase + rowBase + 3] * u3
      + bFlat[bBase + rowBase + 4] * u4
      + bFlat[bBase + rowBase + 5] * u5;
  }, {
    output: [Math.max(flatLength, 1)],
    pipeline: false,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

function buildElementInternalForceKernel(gpu, flatLength) {
  return gpu.createKernel(function (bFlat, areaFlat, stressFlat) {
    const flatIndex = this.thread.x;
    const elementIndex = Math.floor(flatIndex / 6.0);
    const localIndex = flatIndex - elementIndex * 6;
    const bBase = elementIndex * 18;
    const sigmaBase = elementIndex * 3;
    const area = areaFlat[elementIndex];
    const sxx = stressFlat[sigmaBase];
    const syy = stressFlat[sigmaBase + 1];
    const txy = stressFlat[sigmaBase + 2];
    return area * (
      bFlat[bBase + localIndex] * sxx
      + bFlat[bBase + 6 + localIndex] * syy
      + bFlat[bBase + 12 + localIndex] * txy
    );
  }, {
    output: [Math.max(flatLength, 1)],
    pipeline: false,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

function buildElementElasticStiffnessKernel(gpu, flatLength) {
  return gpu.createKernel(function (bFlat, areaFlat, tangentFlat, broadcastTangent) {
    const flatIndex = this.thread.x;
    const elementIndex = Math.floor(flatIndex / 36.0);
    const localOffset = flatIndex - elementIndex * 36;
    const localRow = Math.floor(localOffset / 6.0);
    const localCol = localOffset - localRow * 6;
    const bBase = elementIndex * 18;
    const dBase = broadcastTangent > 0.5 ? 0 : elementIndex * 9;
    const area = areaFlat[elementIndex];

    const bi0 = bFlat[bBase + localRow];
    const bi1 = bFlat[bBase + 6 + localRow];
    const bi2 = bFlat[bBase + 12 + localRow];

    const bj0 = bFlat[bBase + localCol];
    const bj1 = bFlat[bBase + 6 + localCol];
    const bj2 = bFlat[bBase + 12 + localCol];

    const db0 = tangentFlat[dBase] * bj0 + tangentFlat[dBase + 1] * bj1 + tangentFlat[dBase + 2] * bj2;
    const db1 = tangentFlat[dBase + 3] * bj0 + tangentFlat[dBase + 4] * bj1 + tangentFlat[dBase + 5] * bj2;
    const db2 = tangentFlat[dBase + 6] * bj0 + tangentFlat[dBase + 7] * bj1 + tangentFlat[dBase + 8] * bj2;
    return area * (bi0 * db0 + bi1 * db1 + bi2 * db2);
  }, {
    output: [Math.max(flatLength, 1)],
    pipeline: false,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

// T6 kernels. T6 has 12 DOFs / element, 3 Gauss points, B is 3×12 per GP
// (=36 floats per GP × 3 GP = 108 floats per element). Each kernel
// computes one output value per (this.thread.x): the strain kernel
// outputs (gp, component); the internal-force and stiffness kernels
// sum over Gauss points internally so the host doesn't reduce. The
// w·detJ scale is hard-coded as (1/6)·(2·area) per the 3-point rule.

function buildElementStrainKernelT6(gpu, flatLength) {
  return gpu.createKernel(function (bFlat, dofsFlat, displacement) {
    const flatIndex = this.thread.x;
    const elementIndex = Math.floor(flatIndex / 9.0);
    const remainder = flatIndex - elementIndex * 9;
    const gpIndex = Math.floor(remainder / 3.0);
    const component = remainder - gpIndex * 3;

    const bElementBase = elementIndex * 108;
    const bGpBase = bElementBase + gpIndex * 36;
    const bRowBase = bGpBase + component * 12;
    const dofBase = elementIndex * 12;

    let sum = 0.0;
    for (let k = 0; k < 12; k++) {
      sum += bFlat[bRowBase + k] * displacement[dofsFlat[dofBase + k]];
    }
    return sum;
  }, {
    output: [Math.max(flatLength, 1)],
    pipeline: false,
    precision: 'single',
    optimizeFloatMemory: true,
    loopMaxIterations: 12
  });
}

function buildElementInternalForceKernelT6(gpu, flatLength) {
  return gpu.createKernel(function (bFlat, areaFlat, stressFlat) {
    const flatIndex = this.thread.x;
    const elementIndex = Math.floor(flatIndex / 12.0);
    const localDof = flatIndex - elementIndex * 12;
    const bElementBase = elementIndex * 108;
    const sigmaElementBase = elementIndex * 9;
    const detJ = 2.0 * areaFlat[elementIndex];
    const wDet = (1.0 / 6.0) * detJ;
    let sum = 0.0;
    for (let g = 0; g < 3; g++) {
      const bGpBase = bElementBase + g * 36;
      const sigmaBase = sigmaElementBase + g * 3;
      const sxx = stressFlat[sigmaBase];
      const syy = stressFlat[sigmaBase + 1];
      const txy = stressFlat[sigmaBase + 2];
      sum += wDet * (
        bFlat[bGpBase + localDof] * sxx
        + bFlat[bGpBase + 12 + localDof] * syy
        + bFlat[bGpBase + 24 + localDof] * txy
      );
    }
    return sum;
  }, {
    output: [Math.max(flatLength, 1)],
    pipeline: false,
    precision: 'single',
    optimizeFloatMemory: true,
    loopMaxIterations: 3
  });
}

// =============================================================================
// GPU-resident Krylov primitives
// =============================================================================
//
// These kernels exist so the entire CG inner loop can stay on the GPU.
// Per-iteration vector data (x, r, z, p, ap) lives as f32 textures and
// only flows back to CPU when (a) the run finishes, (b) the residual
// refresh interval triggers an f64 recompute, or (c) the host needs a
// scalar (alpha/beta numerator/denominator, ‖r‖² for convergence).
// Everything else stays on the GPU pipeline, eliminating the per-matvec
// upload/download round trip that produced the "bursty" GPU usage on
// the user's M3 Pro.
//
// All kernels declare `pipeline: true` so their outputs are returned as
// GPU.Texture objects. They are chained directly into the next kernel
// without an intervening CPU readback. The GPU's command queue absorbs
// multiple submissions before any sync is required, so M3 Pro Metal can
// run them back-to-back.

// Matvec resident form: takes the input vector AS A TEXTURE (or a
// CPU-side Float32Array — GPU.js auto-uploads either) and returns the
// result as a texture. Identical math to buildMatvecKernelF32 but the
// pipeline flag is true.
function buildMatvecKernelF32Pipelined(gpu, numRows, maxRowLen) {
  // immutable: true is required for the resident-CG path. Without it,
  // GPU.js reuses a single output texture per kernel; calling the same
  // kernel back-to-back with its previous output as input triggers the
  // Safari WebGL2 driver's source-equals-destination guard ("Source and
  // destination textures are the same"). Immutable means each call
  // allocates a fresh output texture; we own its lifecycle and call
  // .delete() once we no longer need it.
  return gpu.createKernel(function (cols, vals, x, maxLen) {
    const row = this.thread.x;
    let sum = 0.0;
    for (let k = 0; k < this.constants.MAX_LOOP; k++) {
      if (k >= maxLen) break;
      const col = cols[row * this.constants.MAX_LOOP + k];
      sum += vals[row * this.constants.MAX_LOOP + k] * x[col];
    }
    return sum;
  }, {
    constants: { MAX_LOOP: Math.max(maxRowLen, 1) },
    loopMaxIterations: Math.max(maxRowLen, 1),
    output: [Math.max(numRows, 1)],
    pipeline: true,
    immutable: true,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

// axby: out[i] = alpha * a[i] + beta * b[i]
//
// Drives every CG vector update. We pass alpha and beta as 1-element
// Float32Arrays so GPU.js can supply them as uniform-style inputs the
// shader reads directly.
function buildAxbyKernel(gpu, n) {
  return gpu.createKernel(function (a, b, alphaScalar, betaScalar) {
    const i = this.thread.x;
    return alphaScalar[0] * a[i] + betaScalar[0] * b[i];
  }, {
    output: [Math.max(n, 1)],
    pipeline: true,
    immutable: true,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

// dotElementWise: produces `c[i] = a[i] * b[i]` as a texture. We then
// reduce `c` to a scalar via the reduction kernel below. Splitting the
// elementwise multiply from the reduction lets us reuse the same
// reduction kernel for ‖x‖² (call with a==b).
function buildDotElementwiseKernel(gpu, n) {
  return gpu.createKernel(function (a, b) {
    const i = this.thread.x;
    return a[i] * b[i];
  }, {
    output: [Math.max(n, 1)],
    pipeline: true,
    immutable: true,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

// reduceSum: reduces a length-N input to length-ceil(N/STRIDE). Repeat
// log_STRIDE(N) times to get a scalar. We use a stride of 64 because
// it's a typical GPU warp size that maps well to WebGL's hardware.
const REDUCTION_STRIDE = 64;
function buildReduceSumKernel(gpu, inputLength, outputLength) {
  return gpu.createKernel(function (input, validLen) {
    const i = this.thread.x;
    const stride = this.constants.STRIDE;
    let sum = 0.0;
    for (let k = 0; k < stride; k++) {
      const idx = i * stride + k;
      if (idx >= validLen) break;
      sum += input[idx];
    }
    return sum;
  }, {
    constants: { STRIDE: REDUCTION_STRIDE },
    loopMaxIterations: REDUCTION_STRIDE,
    output: [Math.max(outputLength, 1)],
    pipeline: true,
    immutable: true,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

// vectorAbsMaxElementwise: |x[i]|. Reduce with max-reduction kernel
// below. Same two-pass pattern as dot.
function buildAbsKernel(gpu, n) {
  return gpu.createKernel(function (x) {
    return Math.abs(x[this.thread.x]);
  }, {
    output: [Math.max(n, 1)],
    pipeline: true,
    immutable: true,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

function buildReduceMaxKernel(gpu, inputLength, outputLength) {
  return gpu.createKernel(function (input, validLen) {
    const i = this.thread.x;
    const stride = this.constants.STRIDE;
    let maxVal = 0.0;
    for (let k = 0; k < stride; k++) {
      const idx = i * stride + k;
      if (idx >= validLen) break;
      const v = input[idx];
      if (v > maxVal) maxVal = v;
    }
    return maxVal;
  }, {
    constants: { STRIDE: REDUCTION_STRIDE },
    loopMaxIterations: REDUCTION_STRIDE,
    output: [Math.max(outputLength, 1)],
    pipeline: true,
    immutable: true,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

// ---------------------------------------------------------------------------
// Double-single (DS) reduction kernels: f64-grade dot products in WebGL2 f32
// ---------------------------------------------------------------------------
//
// Naive f32 summation accumulates ~O(N · ULP) error over a row of 4000
// elements — roughly 1e-4 relative on a CG iterate, which is too coarse
// to drive the outer Newton residual below 1e-6. The fix is to carry a
// compensation term `lo` alongside the running sum `hi` so that
// `hi + lo` represents the true sum to ~14 decimal digits, and to combine
// running sums with Knuth's twoSum so the new compensation captures the
// rounding error of every f32 add. Final precision: ~K · 2^-48 relative
// where K is the number of additions. For 4000 elements that's ~1.4e-11,
// effectively f64.
//
// Output layout: interleaved (hi, lo) pairs in a single f32 texture of
// length 2 · M, where M is the number of partitions for that pass. The
// even-indexed threads emit `hi`, odd-indexed threads emit `lo`. Both
// run the same scan internally and select one component to return — a
// 2× compute factor, but trivial on a GPU with parallelism to spare.

function buildDsReduceFromF32Kernel(gpu, outputPairsLength) {
  // First DS pass: f32 input → interleaved DS pair output.
  // Each pair represents a partition of STRIDE input values summed via
  // twoSum-cumulate. The kernel uses Knuth twoSum:
  //   s = hi + x
  //   bb = s - hi
  //   e = (hi - (s - bb)) + (x - bb)
  //   hi := s ; lo += e
  // and a final renormalisation so |lo| ≤ 0.5 · ULP(hi).
  return gpu.createKernel(function (input, validLen) {
    const flat = this.thread.x;
    const partition = Math.floor(flat * 0.5);
    const isLo = flat - partition * 2;
    let hi = 0.0;
    let lo = 0.0;
    for (let k = 0; k < this.constants.STRIDE; k++) {
      const idx = partition * this.constants.STRIDE + k;
      if (idx >= validLen) break;
      const x = input[idx];
      const s = hi + x;
      const bb = s - hi;
      const e = (hi - (s - bb)) + (x - bb);
      hi = s;
      lo = lo + e;
    }
    const sFinal = hi + lo;
    const bbFinal = sFinal - hi;
    const eFinal = (hi - (sFinal - bbFinal)) + (lo - bbFinal);
    if (isLo > 0.5) return eFinal;
    return sFinal;
  }, {
    constants: { STRIDE: REDUCTION_STRIDE },
    loopMaxIterations: REDUCTION_STRIDE,
    output: [Math.max(2 * outputPairsLength, 1)],
    pipeline: true,
    immutable: true,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

function buildDsReducePairsKernel(gpu, outputPairsLength) {
  // Subsequent DS pass: interleaved DS pair input → interleaved DS pair
  // output. Each thread DS-adds STRIDE input pairs into one output pair
  // using
  //   twoSum(hi, xHi) → (s, e)
  //   lo := lo + e + xLo
  //   renormalise (s, lo) at the end.
  // The xLo terms accumulate naively (they are O(ULP) and their sum
  // remains O(ULP · stride)) — the renormalisation absorbs them into
  // the high-precision pair before the next pass reads them.
  return gpu.createKernel(function (inputPairs, validPairLen) {
    const flat = this.thread.x;
    const partition = Math.floor(flat * 0.5);
    const isLo = flat - partition * 2;
    let hi = 0.0;
    let lo = 0.0;
    for (let k = 0; k < this.constants.STRIDE; k++) {
      const idx = partition * this.constants.STRIDE + k;
      if (idx >= validPairLen) break;
      const xHi = inputPairs[idx * 2];
      const xLo = inputPairs[idx * 2 + 1];
      const s = hi + xHi;
      const bb = s - hi;
      const e = (hi - (s - bb)) + (xHi - bb);
      hi = s;
      lo = lo + e + xLo;
    }
    const sFinal = hi + lo;
    const bbFinal = sFinal - hi;
    const eFinal = (hi - (sFinal - bbFinal)) + (lo - bbFinal);
    if (isLo > 0.5) return eFinal;
    return sFinal;
  }, {
    constants: { STRIDE: REDUCTION_STRIDE },
    loopMaxIterations: REDUCTION_STRIDE,
    output: [Math.max(2 * outputPairsLength, 1)],
    pipeline: true,
    immutable: true,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

// applyBlockJacobi: z[i] = selfCoef[i]·r[i] + prevCoef[i]·r[i-1] + nextCoef[i]·r[i+1]
//
// Branchless block-Jacobi application using ONLY fixed-offset reads
// (i-1, i, i+1). The earlier formulation `z[i] = self·r[i] + other·r[idx[i]]`
// looked branchless in JS but compiled to a *dependent texture read*
// in GLSL — the kernel had to sample `idx` to get an integer, then
// sample `r` at that integer. Apple Metal's WebGL2 driver returns
// stale or zero values for that pattern under some optimisation
// settings, producing z = 0, then p = 0, then K·p = 0, then
// `Math.abs(denom) < eps` → CG returns the initial zero solution.
// Splitting the cross-row coupling into separate prev/next channels
// avoids the dependent read entirely and works on every WebGL2
// driver we've tested.
function buildBlockJacobiKernel(gpu, n) {
  return gpu.createKernel(function (selfCoef, prevCoef, nextCoef, r) {
    const i = this.thread.x;
    // Clamp neighbour indices at the boundaries — `i = 0` reads r[0]
    // for `prev` (multiplied by 0 thanks to the clamped prevCoef) and
    // `i = n - 1` reads r[n-1] for `next`. The shader still touches
    // valid memory; the boundary correctness is enforced by the
    // builder zeroing prevCoef[0] and nextCoef[n-1].
    const last = this.constants.LAST_INDEX;
    let iPrev = i - 1;
    if (iPrev < 0) iPrev = 0;
    let iNext = i + 1;
    if (iNext > last) iNext = last;
    return selfCoef[i] * r[i] + prevCoef[i] * r[iPrev] + nextCoef[i] * r[iNext];
  }, {
    constants: { LAST_INDEX: Math.max(n - 1, 0) },
    output: [Math.max(n, 1)],
    pipeline: true,
    immutable: true,
    precision: 'single',
    optimizeFloatMemory: true
  });
}

function buildElementElasticStiffnessKernelT6(gpu, flatLength) {
  return gpu.createKernel(function (bFlat, areaFlat, tangentFlat, broadcastTangent) {
    const flatIndex = this.thread.x;
    const elementIndex = Math.floor(flatIndex / 144.0);
    const localOffset = flatIndex - elementIndex * 144;
    const i = Math.floor(localOffset / 12.0);
    const j = localOffset - i * 12;

    const bElementBase = elementIndex * 108;
    const detJ = 2.0 * areaFlat[elementIndex];
    const wDet = (1.0 / 6.0) * detJ;

    let sum = 0.0;
    for (let g = 0; g < 3; g++) {
      const bGpBase = bElementBase + g * 36;
      let dBase = 0.0;
      if (broadcastTangent < 0.5) {
        dBase = elementIndex * 27 + g * 9;
      }

      const bi0 = bFlat[bGpBase + i];
      const bi1 = bFlat[bGpBase + 12 + i];
      const bi2 = bFlat[bGpBase + 24 + i];
      const bj0 = bFlat[bGpBase + j];
      const bj1 = bFlat[bGpBase + 12 + j];
      const bj2 = bFlat[bGpBase + 24 + j];

      const db0 = tangentFlat[dBase    ] * bj0 + tangentFlat[dBase + 1] * bj1 + tangentFlat[dBase + 2] * bj2;
      const db1 = tangentFlat[dBase + 3] * bj0 + tangentFlat[dBase + 4] * bj1 + tangentFlat[dBase + 5] * bj2;
      const db2 = tangentFlat[dBase + 6] * bj0 + tangentFlat[dBase + 7] * bj1 + tangentFlat[dBase + 8] * bj2;

      sum += wDet * (bi0 * db0 + bi1 * db1 + bi2 * db2);
    }
    return sum;
  }, {
    output: [Math.max(flatLength, 1)],
    pipeline: false,
    precision: 'single',
    optimizeFloatMemory: true,
    loopMaxIterations: 3
  });
}

export async function tryCreateWebglBackend(setup = {}) {
  const {
    initialPrecisionMode = 'f32',
    maxPaddingRatio = GPU_MAX_PADDING_RATIO
  } = setup;

  const GPU = await loadGpuJs();
  if (!GPU) return { backend: null, reason: 'gpu-js-load-failed' };

  const canvas = newProbeCanvas();
  if (!canvas) return { backend: null, reason: 'no-canvas-in-context' };

  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: false });
  if (!gl) return { backend: null, reason: 'webgl2-float-rt-missing' };
  if (!gl.getExtension('EXT_color_buffer_float')) return { backend: null, reason: 'webgl2-float-rt-missing' };
  const maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0;

  let gpu;
  try {
    gpu = new GPU({ mode: 'webgl2', canvas });
  } catch (error) {
    return { backend: null, reason: `gpu-context-init:${error?.message || 'unknown'}` };
  }

  try {
    const probe = gpu.createKernel(function (a) {
      return a[this.thread.x] * 2.0;
    }).setOutput([4]);
    const probeOut = probe([1, 2, 3, 4]);
    const ok = Math.abs((Number(probeOut?.[0]) || 0) - 2) < 1e-4
      && Math.abs((Number(probeOut?.[1]) || 0) - 4) < 1e-4
      && Math.abs((Number(probeOut?.[2]) || 0) - 6) < 1e-4
      && Math.abs((Number(probeOut?.[3]) || 0) - 8) < 1e-4;
    destroyKernel(probe);
    if (!ok) {
      gpu.destroy();
      return { backend: null, reason: 'probe-kernel-mismatch' };
    }
  } catch (error) {
    try { gpu.destroy(); } catch { /* ignore */ }
    return { backend: null, reason: `probe-kernel-threw:${error?.message || 'unknown'}` };
  }

  let precisionMode = String(initialPrecisionMode || 'f32').toLowerCase() === 'double-single'
    ? 'double-single'
    : 'f32';
  let residualRefreshInterval = precisionMode === 'double-single'
    ? GPU_DOUBLE_SINGLE_RESIDUAL_REFRESH_INTERVAL
    : GPU_F32_RESIDUAL_REFRESH_INTERVAL;

  let matrixBuffer = null;
  let matrixShapeKey = '';
  let matrixPrecisionKey = '';
  let matvecKernelF32 = null;
  let matvecKernelDoubleSingle = null;
  let vectorNarrowF32 = null;
  let vectorNarrowPair = null;

  let elementBufferT3 = null;
  let elementShapeKeyT3 = '';
  let elementStrainKernelT3 = null;
  let elementInternalForceKernelT3 = null;
  let elementElasticStiffnessKernelT3 = null;
  let elementBufferT6 = null;
  let elementShapeKeyT6 = '';
  let elementStrainKernelT6 = null;
  let elementInternalForceKernelT6 = null;
  let elementElasticStiffnessKernelT6 = null;
  let elementDisplacementBuffer = null;
  let elementStressBuffer = null;
  let elementTangentBuffer = null;
  let supportsT6ElementKernels = true;

  // GPU-resident CG kernel cache. These persist across solve calls and
  // are rebuilt only when the problem dimension changes. The CG inner
  // loop dispatches them in a chain so the GPU command queue stays
  // saturated; CPU only sees three scalar downloads per iteration
  // (denom, rzNew, ‖r‖²), which is the irreducible synchronization
  // point of preconditioned conjugate gradients.
  let residentDimensionKey = '';
  let pipelinedMatvecKernel = null;
  let axbyKernel = null;
  let dotElementwiseKernel = null;
  let absKernel = null;
  let blockJacobiKernel = null;
  // Reduction kernels are size-dependent; we cache one per output
  // length, since each pass shrinks the input by REDUCTION_STRIDE.
  // For N=4000 we typically need 2 sum-reduce kernels (4000 → 63 → 1)
  // and 2 max-reduce kernels.
  let reduceSumKernels = [];
  let reduceMaxKernels = [];
  // Double-single reduction chain. The first pass converts f32 input
  // into interleaved (hi, lo) pairs; subsequent passes operate on pair
  // textures. We build one of each per problem size.
  let dsReduceFromF32Kernel = null;
  let dsReducePairsKernels = [];
  // Persistent f32 input buffers for the resident path. The GPU
  // textures themselves live inside the pipelined Texture handles
  // returned by each kernel; these CPU mirrors exist solely so we can
  // upload `rhs` and the preconditioner once per solve.
  let residentRhsBuffer = null;
  let residentInitialBuffer = null;
  let residentPrecondSelfBuffer = null;
  let residentPrecondPrevCoefBuffer = null;
  let residentPrecondNextCoefBuffer = null;
  let residentScalarAlphaBuffer = null;   // Float32Array(1)
  let residentScalarBetaBuffer = null;    // Float32Array(1)
  let residentScalarNegAlphaBuffer = null;// Float32Array(1)

  function disposeResidentKernels() {
    destroyKernel(pipelinedMatvecKernel);
    destroyKernel(axbyKernel);
    destroyKernel(dotElementwiseKernel);
    destroyKernel(absKernel);
    destroyKernel(blockJacobiKernel);
    pipelinedMatvecKernel = null;
    axbyKernel = null;
    dotElementwiseKernel = null;
    absKernel = null;
    blockJacobiKernel = null;
    for (const k of reduceSumKernels) destroyKernel(k);
    for (const k of reduceMaxKernels) destroyKernel(k);
    destroyKernel(dsReduceFromF32Kernel);
    for (const k of dsReducePairsKernels) destroyKernel(k);
    reduceSumKernels = [];
    reduceMaxKernels = [];
    dsReduceFromF32Kernel = null;
    dsReducePairsKernels = [];
    residentDimensionKey = '';
  }

  function disposeKernels() {
    destroyKernel(matvecKernelF32);
    destroyKernel(matvecKernelDoubleSingle);
    destroyKernel(elementStrainKernelT3);
    destroyKernel(elementInternalForceKernelT3);
    destroyKernel(elementElasticStiffnessKernelT3);
    destroyKernel(elementStrainKernelT6);
    destroyKernel(elementInternalForceKernelT6);
    destroyKernel(elementElasticStiffnessKernelT6);
    disposeResidentKernels();
    matvecKernelF32 = null;
    matvecKernelDoubleSingle = null;
    elementStrainKernelT3 = null;
    elementInternalForceKernelT3 = null;
    elementElasticStiffnessKernelT3 = null;
    elementStrainKernelT6 = null;
    elementInternalForceKernelT6 = null;
    elementElasticStiffnessKernelT6 = null;
  }

  function ensureMatrixBuffer(rows) {
    if (
      matrixBuffer
      && matrixPrecisionKey === precisionMode
      && matrixBuffer.rowsRef === rows
    ) {
      return;
    }
    const shape = computeEllpackShape(rows);
    if (shape.paddingRatio > maxPaddingRatio) {
      throw new Error(`ELLPACK padding ratio ${shape.paddingRatio.toFixed(2)} exceeds the GPU guard ${maxPaddingRatio.toFixed(2)}.`);
    }
    checkTextureBudget('ELLPACK matvec buffer', shape.flatLen, maxTextureSize);
    const precisionKey = precisionMode;
    if (
      !matrixBuffer
      || matrixBuffer.numRows !== shape.numRows
      || matrixBuffer.maxRowLen !== shape.maxRowLen
      || matrixPrecisionKey !== precisionKey
    ) {
      matrixBuffer = createEllpackBuffer({
        numRows: shape.numRows,
        maxRowLen: shape.maxRowLen,
        valueDtype: precisionMode === 'double-single' ? 'ds' : 'f32'
      });
      matrixShapeKey = '';
      matrixPrecisionKey = precisionKey;
    }
    if (
      !ellpackPatternMatches(matrixBuffer, rows)
      || matrixBuffer.rowsRef !== rows
    ) {
      packEllpackIndices(matrixBuffer, rows);
      packEllpackValues(matrixBuffer, rows);
    }

    const shapeKey = `${shape.numRows}x${shape.maxRowLen}`;
    if (matrixShapeKey !== shapeKey) {
      destroyKernel(matvecKernelF32);
      destroyKernel(matvecKernelDoubleSingle);
      matvecKernelF32 = buildMatvecKernelF32(gpu, shape.numRows, shape.maxRowLen);
      matvecKernelDoubleSingle = buildMatvecKernelDoubleSingle(gpu, shape.numRows, shape.maxRowLen);
      matrixShapeKey = shapeKey;
    }
  }

  function ensureElementBufferT3(elementCaches) {
    if (elementBufferT3 && elementBufferT3.identityKey === elementCaches) return elementBufferT3;
    elementBufferT3 = ensureElementKernelBuffer(elementBufferT3, elementCaches);
    const elementCount = elementBufferT3.elementCount;
    checkTextureBudget('T3 element strain buffer', elementCount * ELEMENT_STRAIN_STRIDE, maxTextureSize);
    checkTextureBudget('T3 element internal-force buffer', elementCount * ELEMENT_FORCE_STRIDE, maxTextureSize);
    checkTextureBudget('T3 element stiffness buffer', elementCount * ELEMENT_STIFFNESS_STRIDE, maxTextureSize);
    const shapeKey = `${elementCount}`;
    if (elementShapeKeyT3 !== shapeKey) {
      destroyKernel(elementStrainKernelT3);
      destroyKernel(elementInternalForceKernelT3);
      destroyKernel(elementElasticStiffnessKernelT3);
      elementStrainKernelT3 = buildElementStrainKernel(gpu, elementCount * ELEMENT_STRAIN_STRIDE);
      elementInternalForceKernelT3 = buildElementInternalForceKernel(gpu, elementCount * ELEMENT_FORCE_STRIDE);
      elementElasticStiffnessKernelT3 = buildElementElasticStiffnessKernel(gpu, elementCount * ELEMENT_STIFFNESS_STRIDE);
      elementShapeKeyT3 = shapeKey;
    }
    return elementBufferT3;
  }

  function ensureElementBufferT6(elementCaches) {
    if (elementBufferT6 && elementBufferT6.identityKey === elementCaches) return elementBufferT6;
    elementBufferT6 = ensureElementKernelBufferT6(elementBufferT6, elementCaches);
    const elementCount = elementBufferT6.elementCount;
    checkTextureBudget('T6 element strain buffer', elementCount * T6_ELEMENT_STRAIN_STRIDE, maxTextureSize);
    checkTextureBudget('T6 element internal-force buffer', elementCount * T6_ELEMENT_FORCE_STRIDE, maxTextureSize);
    checkTextureBudget('T6 element stiffness buffer', elementCount * T6_ELEMENT_STIFFNESS_STRIDE, maxTextureSize);
    const shapeKey = `${elementCount}`;
    if (elementShapeKeyT6 !== shapeKey) {
      destroyKernel(elementStrainKernelT6);
      destroyKernel(elementInternalForceKernelT6);
      destroyKernel(elementElasticStiffnessKernelT6);
      elementStrainKernelT6 = buildElementStrainKernelT6(gpu, elementCount * T6_ELEMENT_STRAIN_STRIDE);
      elementInternalForceKernelT6 = buildElementInternalForceKernelT6(gpu, elementCount * T6_ELEMENT_FORCE_STRIDE);
      elementElasticStiffnessKernelT6 = buildElementElasticStiffnessKernelT6(gpu, elementCount * T6_ELEMENT_STIFFNESS_STRIDE);
      elementShapeKeyT6 = shapeKey;
    }
    return elementBufferT6;
  }

  function ensureFloat32VectorBuffer(source, existing = null) {
    const requiredLength = source?.length || 0;
    const target = existing && existing.length === requiredLength
      ? existing
      : new Float32Array(requiredLength);
    for (let index = 0; index < requiredLength; index += 1) {
      // Coerce to a finite f32-representable scalar at upload time. Two
      // hazards must be filtered:
      //   1. NaN / Infinity in the f64 source (handled by isFinite(raw)).
      //   2. Finite f64 values whose magnitude exceeds f32 range (~3.4e38)
      //      — Float32Array's implicit conversion silently maps these to
      //      ±Infinity in storage, which then poisons the GPU matvec
      //      (Inf · finite = Inf; Inf + (-Inf) = NaN). We re-check the
      //      stored value after assignment so an f32 overflow never
      //      reaches the kernel.
      const raw = Number(source[index]);
      target[index] = Number.isFinite(raw) ? raw : 0;
      if (!Number.isFinite(target[index])) target[index] = 0;
    }
    return target;
  }

  function ensureFloat32PairBuffer(source, existing = null) {
    const requiredLength = source?.length || 0;
    const target = existing && existing.hi?.length === requiredLength && existing.lo?.length === requiredLength
      ? existing
      : createFloat32PairArrays(requiredLength);
    fillFloat32PairArrays(source, target.hi, target.lo, requiredLength);
    return target;
  }

  function matvec(rows, vector) {
    if (!rows.length) return new Float64Array(0);
    ensureMatrixBuffer(rows);
    const diagnosticContext = { kind: 'matvec', rows, vector };
    if (precisionMode === 'double-single') {
      vectorNarrowPair = ensureFloat32PairBuffer(vector, vectorNarrowPair);
      return normalizeKernelOutput(
        matvecKernelDoubleSingle(
          matrixBuffer.cols,
          matrixBuffer.valsHi,
          matrixBuffer.valsLo,
          vectorNarrowPair.hi,
          vectorNarrowPair.lo,
          matrixBuffer.maxRowLen
        ),
        matrixBuffer.numRows,
        diagnosticContext
      );
    }
    vectorNarrowF32 = ensureFloat32VectorBuffer(vector, vectorNarrowF32);
    return normalizeKernelOutput(
      matvecKernelF32(matrixBuffer.cols, matrixBuffer.vals, vectorNarrowF32, matrixBuffer.maxRowLen),
      matrixBuffer.numRows,
      diagnosticContext
    );
  }

  function elementStrain(elementCaches, displacementVector) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const kind = elementCachesKindFromCache(elementCaches);
    if (kind === 't6') {
      const buffer = ensureElementBufferT6(elementCaches);
      elementDisplacementBuffer = ensureFloat32VectorBuffer(displacementVector, elementDisplacementBuffer);
      return normalizeKernelOutput(
        elementStrainKernelT6(buffer.B, buffer.dofs, elementDisplacementBuffer),
        buffer.elementCount * T6_ELEMENT_STRAIN_STRIDE
      );
    }
    const buffer = ensureElementBufferT3(elementCaches);
    elementDisplacementBuffer = ensureFloat32VectorBuffer(displacementVector, elementDisplacementBuffer);
    return normalizeKernelOutput(
      elementStrainKernelT3(buffer.B, buffer.dofs, elementDisplacementBuffer),
      buffer.elementCount * ELEMENT_STRAIN_STRIDE
    );
  }

  function elementInternalForce(elementCaches, stressFlat) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const kind = elementCachesKindFromCache(elementCaches);
    if (kind === 't6') {
      const buffer = ensureElementBufferT6(elementCaches);
      elementStressBuffer = ensureFloat32VectorBuffer(stressFlat, elementStressBuffer);
      return normalizeKernelOutput(
        elementInternalForceKernelT6(buffer.B, buffer.area, elementStressBuffer),
        buffer.elementCount * T6_ELEMENT_FORCE_STRIDE
      );
    }
    const buffer = ensureElementBufferT3(elementCaches);
    elementStressBuffer = ensureFloat32VectorBuffer(stressFlat, elementStressBuffer);
    return normalizeKernelOutput(
      elementInternalForceKernelT3(buffer.B, buffer.area, elementStressBuffer),
      buffer.elementCount * ELEMENT_FORCE_STRIDE
    );
  }

  function elementElasticStiffness(elementCaches, tangentFlat) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const kind = elementCachesKindFromCache(elementCaches);
    if (kind === 't6') {
      const buffer = ensureElementBufferT6(elementCaches);
      elementTangentBuffer = ensureFloat32VectorBuffer(tangentFlat, elementTangentBuffer);
      return normalizeKernelOutput(
        elementElasticStiffnessKernelT6(
          buffer.B,
          buffer.area,
          elementTangentBuffer,
          tangentFlat.length === T6_ELEMENT_TANGENT_STRIDE_PER_GP ? 1 : 0
        ),
        buffer.elementCount * T6_ELEMENT_STIFFNESS_STRIDE
      );
    }
    const buffer = ensureElementBufferT3(elementCaches);
    elementTangentBuffer = ensureFloat32VectorBuffer(tangentFlat, elementTangentBuffer);
    return normalizeKernelOutput(
      elementElasticStiffnessKernelT3(buffer.B, buffer.area, elementTangentBuffer, tangentFlat.length === 9 ? 1 : 0),
      buffer.elementCount * ELEMENT_STIFFNESS_STRIDE
    );
  }

  // =========================================================================
  // GPU-resident CG: full Krylov inner-loop on the GPU
  // =========================================================================

  function ensureResidentKernels(numRows, maxRowLen) {
    const dimensionKey = `${numRows}x${maxRowLen}`;
    if (residentDimensionKey === dimensionKey) return;
    disposeResidentKernels();
    pipelinedMatvecKernel = buildMatvecKernelF32Pipelined(gpu, numRows, maxRowLen);
    axbyKernel = buildAxbyKernel(gpu, numRows);
    dotElementwiseKernel = buildDotElementwiseKernel(gpu, numRows);
    absKernel = buildAbsKernel(gpu, numRows);
    blockJacobiKernel = buildBlockJacobiKernel(gpu, numRows);
    // Build a chain of reduction kernels that successively shrinks N
    // by REDUCTION_STRIDE per pass until the output is length 1. Cache
    // them in order so consecutive `reduceSum`/`reduceMax` calls find
    // the right kernel for each pass.
    let length = numRows;
    while (length > 1) {
      const nextLength = Math.max(1, Math.ceil(length / REDUCTION_STRIDE));
      reduceSumKernels.push(buildReduceSumKernel(gpu, length, nextLength));
      reduceMaxKernels.push(buildReduceMaxKernel(gpu, length, nextLength));
      length = nextLength;
    }
    // DS reduction chain: first pass takes f32 input of length numRows
    // and produces ceil(numRows/STRIDE) DS pairs. Subsequent passes
    // shrink by STRIDE until we have one pair. Output length is always
    // 2 × pairCount (interleaved hi/lo).
    let dsPairLength = Math.max(1, Math.ceil(numRows / REDUCTION_STRIDE));
    dsReduceFromF32Kernel = buildDsReduceFromF32Kernel(gpu, dsPairLength);
    while (dsPairLength > 1) {
      const nextPairs = Math.max(1, Math.ceil(dsPairLength / REDUCTION_STRIDE));
      dsReducePairsKernels.push(buildDsReducePairsKernel(gpu, nextPairs));
      dsPairLength = nextPairs;
    }
    residentDimensionKey = dimensionKey;
  }

  // Cleanup helpers for the resident CG path. Each call to a kernel
  // with `immutable: true` allocates a fresh GPU texture; we own its
  // lifecycle, and leaking textures across iterations exhausts GPU
  // memory in dozens of solves. `safeDelete` tolerates non-texture
  // inputs (e.g. CPU Float32Arrays passed in as the very first
  // iteration's seed) so the caller can use the same disposal pattern
  // for every handle without branching.
  function safeDelete(handle) {
    if (handle && typeof handle.delete === 'function') {
      try { handle.delete(); } catch { /* GPU.js sometimes double-frees benign */ }
    }
  }

  function reduceTextureToScalar(kernels, inputTexture, lastValidLength, ownsInput = true) {
    // Walk the reduction-kernel chain, disposing each intermediate
    // texture after the next pass consumes it. The input may or may
    // not be ours to delete — the caller controls via ownsInput. The
    // final 1-element texture is always disposed after we read its
    // scalar value, since no further kernel needs it.
    let texture = inputTexture;
    let validLen = lastValidLength;
    let ownsCurrent = ownsInput;
    for (const kernel of kernels) {
      const next = kernel(texture, validLen);
      if (ownsCurrent) safeDelete(texture);
      texture = next;
      ownsCurrent = true;
      validLen = Math.max(1, Math.ceil(validLen / REDUCTION_STRIDE));
    }
    const downloaded = typeof texture.toArray === 'function'
      ? texture.toArray()
      : texture;
    if (ownsCurrent) safeDelete(texture);
    return Number(downloaded?.[0]) || 0;
  }

  function reduceTextureToScalarDs(elementwiseTexture, n, ownsInput = true) {
    // Run the DS reduction chain. The first kernel reads f32 input
    // and produces an interleaved (hi, lo) pair texture; subsequent
    // kernels consume and produce DS pair textures. The final pair
    // is downloaded as Float32Array of length 2; the scalar result is
    // `hi + lo` in JS f64 (which is exact since both are representable
    // f32 values and f64 has more than enough precision to hold their
    // sum).
    let pairTex = dsReduceFromF32Kernel(elementwiseTexture, n);
    if (ownsInput) safeDelete(elementwiseTexture);
    let pairCount = Math.max(1, Math.ceil(n / REDUCTION_STRIDE));
    for (const kernel of dsReducePairsKernels) {
      const next = kernel(pairTex, pairCount);
      safeDelete(pairTex);
      pairTex = next;
      pairCount = Math.max(1, Math.ceil(pairCount / REDUCTION_STRIDE));
    }
    const downloaded = typeof pairTex.toArray === 'function'
      ? pairTex.toArray()
      : pairTex;
    safeDelete(pairTex);
    const hi = Number(downloaded?.[0]) || 0;
    const lo = Number(downloaded?.[1]) || 0;
    return hi + lo;
  }

  function ensureScalarBuffers() {
    if (!residentScalarAlphaBuffer) residentScalarAlphaBuffer = new Float32Array(1);
    if (!residentScalarBetaBuffer) residentScalarBetaBuffer = new Float32Array(1);
    if (!residentScalarNegAlphaBuffer) residentScalarNegAlphaBuffer = new Float32Array(1);
  }

  // Solve K x = b on the GPU, with vectors x, r, z, p, ap held as
  // pipelined Texture handles between iterations. CPU only handles the
  // three scalars (denom, rzNew, ‖r‖²) per iteration plus the
  // residual-refresh f64 recompute on a fixed cadence.
  //
  // Returns the same shape as the CPU solveCg so the caller can swap
  // implementations without changing convergence semantics.
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
    ensureMatrixBuffer(rows);
    ensureResidentKernels(matrixBuffer.numRows, matrixBuffer.maxRowLen);
    ensureScalarBuffers();

    // RHS upload (defensive: re-zero non-finite values).
    residentRhsBuffer = ensureFloat32VectorBuffer(rhs, residentRhsBuffer);

    // Preconditioner upload. New flat layout: (self, prev, next) so the
    // shader uses only fixed-offset reads (i-1, i, i+1) and avoids the
    // dependent-texture-read pattern that returns zero on Apple Metal
    // WebGL2 drivers.
    const { selfCoef, prevCoef, nextCoef } = preconditioner;
    residentPrecondSelfBuffer = residentPrecondSelfBuffer && residentPrecondSelfBuffer.length === n
      ? residentPrecondSelfBuffer : new Float32Array(n);
    residentPrecondPrevCoefBuffer = residentPrecondPrevCoefBuffer && residentPrecondPrevCoefBuffer.length === n
      ? residentPrecondPrevCoefBuffer : new Float32Array(n);
    residentPrecondNextCoefBuffer = residentPrecondNextCoefBuffer && residentPrecondNextCoefBuffer.length === n
      ? residentPrecondNextCoefBuffer : new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      residentPrecondSelfBuffer[i] = Number(selfCoef[i]) || 0;
      residentPrecondPrevCoefBuffer[i] = Number(prevCoef[i]) || 0;
      residentPrecondNextCoefBuffer[i] = Number(nextCoef[i]) || 0;
    }

    // Initial guess upload (or zero).
    let initialF32;
    if (initial && initial.length === n) {
      residentInitialBuffer = ensureFloat32VectorBuffer(initial, residentInitialBuffer);
      initialF32 = residentInitialBuffer;
    } else {
      residentInitialBuffer = residentInitialBuffer && residentInitialBuffer.length === n
        ? residentInitialBuffer : new Float32Array(n);
      residentInitialBuffer.fill(0);
      initialF32 = residentInitialBuffer;
    }

    // Compute ‖rhs‖² on CPU (used for relative-residual tolerance) — single
    // pass, not on the hot path.
    let rhsNorm2 = 0;
    for (let i = 0; i < n; i += 1) rhsNorm2 += rhs[i] * rhs[i];
    const rhsNorm = Math.sqrt(rhsNorm2);
    const tolTarget = Math.max(absTol || 0, (relTol || 0) * rhsNorm);

    // Persistent vector textures live in this object so the cleanup
    // path at the bottom can dispose any that still exist (e.g. on
    // exception or early return). `swap` deletes the previous texture
    // before assigning the new one — that's the standard "I produced
    // a fresh immutable texture; the old one is now orphaned" pattern.
    const live = { xTex: null, rTex: null, zTex: null, pTex: null };
    const swap = (key, newTex) => {
      const old = live[key];
      live[key] = newTex;
      if (old) safeDelete(old);
    };
    const finish = (result) => {
      // Dispose any remaining persistent textures before returning so
      // a single solve never leaks beyond its scope. Temporary
      // textures inside the iteration body are disposed inline.
      safeDelete(live.xTex);
      safeDelete(live.rTex);
      safeDelete(live.zTex);
      safeDelete(live.pTex);
      live.xTex = live.rTex = live.zTex = live.pTex = null;
      return result;
    };
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
      const ax = sparseMatVecCpu(rows, solution);
      let r2 = 0;
      for (let i = 0; i < n; i += 1) {
        const ri = rhs[i] - ax[i];
        r2 += ri * ri;
      }
      return Math.sqrt(Math.max(r2, 0));
    };
    const finishWithTrueResidual = (solution, iterations, recurrenceResidualNorm, label) => {
      const trueResidualNorm = trueResidualNormForSolution(solution);
      const converged = trueResidualNorm <= tolTarget;
      return finish({
        solution,
        converged,
        iterations,
        residualNorm: trueResidualNorm,
        trueResidualNorm,
        recurrenceResidualNorm,
        relativeResidual: rhsNorm > CG_NUMERIC_EPS_F32 ? trueResidualNorm / rhsNorm : 0,
        rhsNorm,
        toleranceTarget: tolTarget,
        usedTrueResidualAcceptance: true,
        fallbackReason: converged ? '' : `${label}-true-residual-mismatch:${recurrenceResidualNorm}->${trueResidualNorm}`,
        interrupted: false
      });
    };

    try {
      // Seed: x = initial (copy via axby with identity), ap = K · x,
      // r = rhs − ap. The intermediate apTex is consumed by the next
      // axby and immediately disposed.
      swap('xTex', axbyKernel(initialF32, initialF32, _scalarOne(), _scalarZero()));
      let apSeed = pipelinedMatvecKernel(
        matrixBuffer.cols,
        matrixBuffer.vals,
        initialF32,
        matrixBuffer.maxRowLen
      );
      swap('rTex', axbyKernel(residentRhsBuffer, apSeed, _scalarOne(), _scalarMinusOne()));
      safeDelete(apSeed);
      apSeed = null;

      // ‖r‖² → CPU; the elementwise dot output is consumed by the
      // reduction chain and disposed inside reduceTextureToScalar.
      let dotE = dotElementwiseKernel(live.rTex, live.rTex);
      let rNorm2 = reduceTextureToScalarDs(dotE, n, true);
      let residualNorm = Math.sqrt(Math.max(rNorm2, 0));
      if (residualNorm <= tolTarget) {
        return finishWithTrueResidual(downloadTextureToFloat64(live.xTex, n), 0, residualNorm, 'webgl-resident-cg');
      }

      // z = M⁻¹ r ;  p = z (copy)
      swap('zTex', blockJacobiKernel(
        residentPrecondSelfBuffer,
        residentPrecondPrevCoefBuffer,
        residentPrecondNextCoefBuffer,
        live.rTex
      ));
      swap('pTex', axbyKernel(live.zTex, live.zTex, _scalarOne(), _scalarZero()));

      let dotRZ = dotElementwiseKernel(live.rTex, live.zTex);
      let rzOld = reduceTextureToScalarDs(dotRZ, n, true);

      let iter = 0;
      for (iter = 1; iter <= maxIter; iter += 1) {
        if ((iter === 1 || iter % 25 === 0) && await checkpoint()) {
          return finish({
            solution: downloadTextureToFloat64(live.xTex, n),
            converged: false,
            iterations: iter,
            residualNorm,
            trueResidualNorm: residualNorm,
            relativeResidual: rhsNorm > CG_NUMERIC_EPS_F32 ? residualNorm / rhsNorm : 0,
            rhsNorm,
            toleranceTarget: tolTarget,
            interrupted: true
          });
        }
        // ap = K · p — apTex is a fresh texture each iter; disposed
        // after the dot product reduces it via axby (which references
        // it) and the second axby completes.
        let apTex = pipelinedMatvecKernel(
          matrixBuffer.cols,
          matrixBuffer.vals,
          live.pTex,
          matrixBuffer.maxRowLen
        );
        let dotPAp = dotElementwiseKernel(live.pTex, apTex);
        const denom = reduceTextureToScalarDs(dotPAp, n, true);
        if (!Number.isFinite(denom) || Math.abs(denom) < CG_NUMERIC_EPS_F32) {
          safeDelete(apTex);
          residualNorm = Math.sqrt(Math.max(rNorm2, 0));
          return finishWithTrueResidual(downloadTextureToFloat64(live.xTex, n), iter, residualNorm, 'webgl-resident-cg-breakdown');
        }
        const alpha = rzOld / denom;
        residentScalarAlphaBuffer[0] = alpha;
        residentScalarNegAlphaBuffer[0] = -alpha;

        // x = x + α p ; r = r − α ap
        swap('xTex', axbyKernel(live.xTex, live.pTex, _scalarOne(), residentScalarAlphaBuffer));
        swap('rTex', axbyKernel(live.rTex, apTex, _scalarOne(), residentScalarNegAlphaBuffer));
        safeDelete(apTex);
        apTex = null;

        // Periodic residual refresh on CPU f64 — same cadence as the
        // CPU CG path. We download x, recompute b − Ax in f64, then
        // re-upload r and discard any drift the f32 path accumulated.
        let didRefresh = false;
        if (residualRefreshIntervalForCheckpoint > 0
            && iter % residualRefreshIntervalForCheckpoint === 0) {
          const xCpu = downloadTextureToFloat64(live.xTex, n);
          const ax = sparseMatVecCpu(rows, xCpu);
          const rRefreshed = new Float64Array(n);
          for (let i = 0; i < n; i += 1) rRefreshed[i] = rhs[i] - ax[i];
          const rRefreshedF32 = ensureFloat32VectorBuffer(rRefreshed, null);
          // axby with α=1, β=0 is just a copy onto a fresh texture.
          swap('rTex', axbyKernel(rRefreshedF32, rRefreshedF32, _scalarOne(), _scalarZero()));
          didRefresh = true;
        }

        let dotRR = dotElementwiseKernel(live.rTex, live.rTex);
        rNorm2 = reduceTextureToScalarDs(dotRR, n, true);
        residualNorm = Math.sqrt(Math.max(rNorm2, 0));

        if (iterationObserver && (iter === 1 || iter % 25 === 0)) {
          await iterationObserver({
            iterations: iter,
            residualNorm,
            relativeResidual: rhsNorm > CG_NUMERIC_EPS_F32 ? residualNorm / rhsNorm : 0,
            rhsNorm,
            toleranceTarget: tolTarget
          });
        }

        if (residualNorm <= tolTarget) {
          return finishWithTrueResidual(downloadTextureToFloat64(live.xTex, n), iter, residualNorm, 'webgl-resident-cg');
        }

        // z = M⁻¹ r ; β = (rzNew/rzOld) ; p = z + β p
        swap('zTex', blockJacobiKernel(
          residentPrecondSelfBuffer,
          residentPrecondPrevCoefBuffer,
          residentPrecondNextCoefBuffer,
          live.rTex
        ));
        let dotRZNew = dotElementwiseKernel(live.rTex, live.zTex);
        const rzNew = reduceTextureToScalarDs(dotRZNew, n, true);
        const beta = didRefresh ? 0 : (Math.abs(rzOld) > CG_NUMERIC_EPS_F32 ? rzNew / rzOld : 0);
        residentScalarBetaBuffer[0] = beta;
        swap('pTex', axbyKernel(live.zTex, live.pTex, _scalarOne(), residentScalarBetaBuffer));
        rzOld = rzNew;
      }

      // Iteration budget exhausted — return the best-effort solution.
      return finishWithTrueResidual(downloadTextureToFloat64(live.xTex, n), maxIter, residualNorm, 'webgl-resident-cg-not-converged');
    } catch (error) {
      // Any thrown error inside the resident loop must still dispose
      // the live textures before propagating, otherwise GPU memory
      // leaks across falled-back solves.
      finish(null);
      throw error;
    }
  }

  // Shared scalar 1-element buffers — reused across calls so we are not
  // allocating Float32Array(1) on every kernel invocation.
  const _scalarOneBuf = new Float32Array([1]);
  const _scalarZeroBuf = new Float32Array([0]);
  const _scalarMinusOneBuf = new Float32Array([-1]);
  function _scalarOne() { return _scalarOneBuf; }
  function _scalarZero() { return _scalarZeroBuf; }
  function _scalarMinusOne() { return _scalarMinusOneBuf; }

  function downloadTextureToFloat64(texture, length) {
    const arr = typeof texture.toArray === 'function' ? texture.toArray() : texture;
    const out = new Float64Array(length);
    for (let i = 0; i < length; i += 1) out[i] = Number(arr?.[i]) || 0;
    return out;
  }

  // CPU f64 reference matvec for the residual refresh inside the
  // resident solver. Identical math to sparseMatVecFallback in
  // solver.js but local so this module stays self-contained.
  function sparseMatVecCpu(rows, vector) {
    const out = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      let sum = 0;
      const row = rows[i];
      const indices = row.indices;
      const values = row.values;
      for (let k = 0; k < indices.length; k += 1) {
        sum += (Number(values[k]) || 0) * (Number(vector[indices[k]]) || 0);
      }
      out[i] = sum;
    }
    return out;
  }

  const CG_NUMERIC_EPS_F32 = 1e-30;

  function setPrecisionMode(nextMode = 'f32') {
    const normalized = String(nextMode || 'f32').toLowerCase();
    const resolved = normalized === 'double-single' ? 'double-single' : 'f32';
    precisionMode = resolved;
    residualRefreshInterval = resolved === 'double-single'
      ? GPU_DOUBLE_SINGLE_RESIDUAL_REFRESH_INTERVAL
      : GPU_F32_RESIDUAL_REFRESH_INTERVAL;
    matrixBuffer = null;
    matrixPrecisionKey = '';
    return precisionMode;
  }

  function setResidualRefreshInterval(nextInterval = residualRefreshInterval) {
    residualRefreshInterval = Math.max(Math.round(Number(nextInterval) || residualRefreshInterval), 1);
    return residualRefreshInterval;
  }

  function dispose() {
    disposeKernels();
    matrixBuffer = null;
    elementBufferT3 = null;
    elementBufferT6 = null;
    vectorNarrowF32 = null;
    vectorNarrowPair = null;
    elementDisplacementBuffer = null;
    elementStressBuffer = null;
    elementTangentBuffer = null;
    matrixShapeKey = '';
    matrixPrecisionKey = '';
    elementShapeKeyT3 = '';
    elementShapeKeyT6 = '';
    try { gpu.destroy?.(); } catch { /* ignore */ }
  }

  try {
    // 3×3 1D-Laplacian-like matrix
    //   [[ 2,-1, 0],
    //    [-1, 2,-1],
    //    [ 0,-1, 2]]
    // applied to x = [1, 2, 3] gives A·x = [0, 0, 4]. The interior row 1
    // satisfies the second-difference identity (linear input → zero), and
    // the outer rows give the 1D Laplacian boundary values.
    const sampleRows = [
      { indices: new Int32Array([0, 1]), values: new Float64Array([2, -1]), diagIndex: 0, diag: 2 },
      { indices: new Int32Array([0, 1, 2]), values: new Float64Array([-1, 2, -1]), diagIndex: 1, diag: 2 },
      { indices: new Int32Array([1, 2]), values: new Float64Array([-1, 2]), diagIndex: 1, diag: 2 }
    ];
    const got = matvec(sampleRows, new Float64Array([1, 2, 3]));
    const expected = [0, 0, 4];
    for (let index = 0; index < expected.length; index += 1) {
      if (Math.abs(got[index] - expected[index]) > 1e-3) {
        dispose();
        return { backend: null, reason: 'kernel-integration-test-mismatch' };
      }
    }

    const sampleElementCaches = [{
      B: [
        [1, 0, 2, 0, -1, 0],
        [0, 3, 0, -2, 0, 1],
        [4, 5, 6, 7, 8, 9]
      ],
      dofs: Int32Array.from([0, 1, 2, 3, 4, 5]),
      area: 2
    }];
    const sampleElementBuffer = ensureElementKernelBuffer(null, sampleElementCaches);
    const sampleDisplacement = new Float64Array([1, 2, 3, 4, 5, 6]);
    const sampleStress = new Float64Array([1, 2, 3]);
    const sampleTangent = new Float64Array([
      2, 0.5, 0,
      0.5, 3, 0,
      0, 0, 1.5
    ]);

    const sampleStrain = elementStrain(sampleElementCaches, sampleDisplacement);
    const expectedStrain = elementStrainReference(sampleElementBuffer, sampleDisplacement);
    for (let index = 0; index < expectedStrain.length; index += 1) {
      if (Math.abs(sampleStrain[index] - expectedStrain[index]) > 1e-3) {
        dispose();
        return { backend: null, reason: 'element-strain-kernel-mismatch' };
      }
    }

    const sampleForce = elementInternalForce(sampleElementCaches, sampleStress);
    const expectedForce = elementInternalForceReference(sampleElementBuffer, sampleStress);
    for (let index = 0; index < expectedForce.length; index += 1) {
      if (Math.abs(sampleForce[index] - expectedForce[index]) > 1e-3) {
        dispose();
        return { backend: null, reason: 'element-force-kernel-mismatch' };
      }
    }

    const sampleKe = elementElasticStiffness(sampleElementCaches, sampleTangent);
    const expectedKe = elementElasticStiffnessReference(sampleElementBuffer, sampleTangent);
    for (let index = 0; index < expectedKe.length; index += 1) {
      if (Math.abs(sampleKe[index] - expectedKe[index]) > 1e-3) {
        dispose();
        return { backend: null, reason: 'element-stiffness-kernel-mismatch' };
      }
    }

    if (!(sampleForce.length === 6) || sampleForce.some((value) => !Number.isFinite(value))) {
      dispose();
      return { backend: null, reason: 'element-force-kernel-mismatch' };
    }
    if (!(sampleKe.length === 36) || sampleKe.some((value) => !Number.isFinite(value))) {
      dispose();
      return { backend: null, reason: 'element-stiffness-kernel-mismatch' };
    }

    // T6 sanity probe. Build a single-element T6 cache with corner-only B
    // material (the integration weights and per-GP B-matrix come from
    // element-t6.js itself via packElementKernelBufferT6). If the GPU
    // kernel diverges from the CPU reference for any of the three
    // outputs, mark T6 as unsupported on this backend; the solver then
    // routes T6 calls to the CPU element path while keeping T3 GPU
    // active. Mixed-element-type meshes are explicitly rejected at
    // dispatch time, so the partial degradation is safe.
    try {
      const t6Caches = [{
        kind: 't6',
        corners: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 }
        ],
        dofs: Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
        area: 0.5
      }];
      const t6RefBuffer = ensureElementKernelBufferT6(null, t6Caches);
      const t6Disp = new Float64Array([1, 0, 2, 0, 0, 1, 1.5, 0.25, -0.25, 0.5, 0.75, 0.5]);
      const t6Stress = new Float64Array([1, 2, 0.5, 0.75, 1.25, -0.5, -0.25, 1, 0.25]);
      const t6Tangent = new Float64Array([
        2, 0.5, 0,
        0.5, 3, 0,
        0, 0, 1.5
      ]);

      const t6StrainGpu = elementStrain(t6Caches, t6Disp);
      const t6StrainRef = elementStrainReferenceT6(t6RefBuffer, t6Disp);
      for (let index = 0; index < t6StrainRef.length; index += 1) {
        if (Math.abs(t6StrainGpu[index] - t6StrainRef[index]) > 1e-3) {
          supportsT6ElementKernels = false;
          break;
        }
      }
      if (supportsT6ElementKernels) {
        const t6ForceGpu = elementInternalForce(t6Caches, t6Stress);
        const t6ForceRef = elementInternalForceReferenceT6(t6RefBuffer, t6Stress);
        for (let index = 0; index < t6ForceRef.length; index += 1) {
          if (Math.abs(t6ForceGpu[index] - t6ForceRef[index]) > 1e-3) {
            supportsT6ElementKernels = false;
            break;
          }
        }
      }
      if (supportsT6ElementKernels) {
        const t6KeGpu = elementElasticStiffness(t6Caches, t6Tangent);
        const t6KeRef = elementElasticStiffnessReferenceT6(t6RefBuffer, t6Tangent);
        for (let index = 0; index < t6KeRef.length; index += 1) {
          if (Math.abs(t6KeGpu[index] - t6KeRef[index]) > 1e-3) {
            supportsT6ElementKernels = false;
            break;
          }
        }
      }
    } catch {
      supportsT6ElementKernels = false;
    }
  } catch (error) {
    try { dispose(); } catch { /* ignore */ }
    return { backend: null, reason: `kernel-integration-test-threw:${error?.message || 'unknown'}` };
  }

  return {
    backend: {
      get name() {
        return precisionMode === 'double-single' ? 'webgl2-double-single' : 'webgl2-f32';
      },
      get precision() {
        return precisionMode === 'double-single' ? 'double-single' : 'f32';
      },
      supportsDoubleSingle: true,
      supportsElementKernels: true,
      get supportsT3ElementKernels() { return true; },
      get supportsT6ElementKernels() { return supportsT6ElementKernels; },
      requiresResidualRefresh: true,
      get precisionMode() { return precisionMode; },
      get residualRefreshInterval() { return residualRefreshInterval; },
      get maxTextureSize() { return maxTextureSize; },
      // Expose the packed matrix's largest absolute value AND its
      // maxRowLen so the solver's per-call magnitude pre-check can
      // compute the exact safe vector ceiling: |val|·|x|·rowLen <
      // f32_max means |x| < f32_max / (max|val| · rowLen). This is
      // sharper than a fixed conservative threshold and lets every
      // matvec the GPU can physically handle stay on GPU.
      get matrixMaxAbsValue() { return matrixBuffer?.maxAbsValue ?? 0; },
      get matrixMaxRowLen() { return matrixBuffer?.maxRowLen ?? 0; },
      // GPU-resident CG: keeps the iterate vectors as f32 textures
      // across iterations and runs the entire inner loop on the GPU.
      // The solver-side code consults `supportsResidentCg` to decide
      // whether to dispatch through this path or the legacy hybrid
      // path. Always present on this backend; the cpu-f32-backend
      // exposes a deterministic CPU surrogate with the same name so
      // verification can exercise the algorithm without WebGL2.
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
        residentCg: 'none',
        residentGmres: 'none',
        nonlinearAssembly: 'none',
        mcMaterial: 'none'
      },
      solveCgPreconditionedGpu,
      matvec,
      elementStrain,
      elementInternalForce,
      elementElasticStiffness,
      setPrecisionMode,
      setResidualRefreshInterval,
      dispose
    },
    reason: '',
    maxTextureSize
  };
}
