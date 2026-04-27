// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// STATUS: experimental. This backend is available for verification and
// explicitly opted-in resident WebGPU experiments, but it is not yet certified
// as a production substitute for the CPU f64 deformation path.

// WebGPU backend for the deformation Krylov solver. Replaces the
// WebGL2 + GPU.js path on hardware that supports the modern compute
// API (Apple M-series via Safari 18+, every Chromium-based browser
// since 113). Two architectural reasons WebGPU is the right tool here
// instead of WebGL2:
//
//   * Per-dispatch latency. WebGL2 dispatches go through a graphics
//     pipeline with bind-state plumbing; even an empty kernel takes
//     several milliseconds on Apple Metal-via-ANGLE. WebGPU compute
//     dispatches use a dedicated pipeline and queue, with sub-100 µs
//     submission latency on the same hardware. The Krylov inner loop
//     issues 8–10 small dispatches per iteration; the latency
//     difference compounds into ≥10× wall-clock improvement on
//     small / medium problems.
//
//   * Command-buffer batching. WebGPU lets us encode an entire CG
//     iteration into one command-encoder, then submit it as a single
//     unit. The GPU sees the dependency graph and can pipeline
//     dispatches without waiting for CPU between them. WebGL2 has no
//     equivalent — each draw / dispatch is its own state-machine
//     transaction.
//
// Precision: vectors and the matrix live as f32 in storage buffers
// (fast, low memory). Dot products — the precision-critical reduction
// in CG — use a *double-single* (DS) accumulator pair `(hi, lo)` with
// twoSum-based combining, so a 4000-element dot retains ~14-digit
// precision instead of f32's ~5–7 digits. WGSL supports the strict
// IEEE-754 ordering twoSum needs without an optimiser-collapse risk
// (unlike GPU.js's GLSL output, where compensation terms could be
// algebraically simplified into 0).
//
// State machine:
//   tryCreateWebgpuBackend()   — probe and acquire device
//   ensureMatrixBuffers(rows)  — pack ELLPACK into GPU storage buffers
//   ensureVectorBuffers(n)     — pre-allocate persistent x, r, z, p, ap
//   solveCgPreconditionedWebgpu({...})  — run the resident CG loop
//   matvec(rows, vector)       — single-shot matvec (legacy hybrid path
//                                kept for parity with the WebGL2 backend)
//   dispose()                  — release device, buffers, pipelines

import {
  computeEllpackShape,
  packEllpackIndices as packIndicesIntoBuffer,
  packEllpackValues as packValuesIntoBuffer,
  ellpackPatternMatches,
  createEllpackBuffer
} from './ellpack.js';

const WORKGROUP_SIZE = 64;

// =============================================================================
// WGSL kernels — full double-single (DS) operator chain
// =============================================================================
//
// Storage layout. Vectors and matrix values live as paired f32 buffers
// (hi + lo); `lo` captures the f64→f32 narrowing residual so the
// effective precision is ~2*mantissa(f32) ≈ 14 decimal digits, which
// matches the CPU f64 oracle for engineering tolerances. Column
// indices are i32 with -1 marking ELLPACK row padding.
//
// DS arithmetic primitives:
//   twoSum(a, b)   — error-free addition: returns (s, e) with s + e = a + b exactly
//                    (Knuth's two-sum, IEEE-754 round-to-nearest)
//   twoProd(a, b)  — error-free multiplication via fma:
//                    p = a * b (rounded), e = fma(a, b, -p) is the rounding error
//   dsAdd(a, b)    — DS pair + DS pair, renormalised
//   dsMul(a, b)    — DS pair * DS pair, drops O(eps^2) cross terms then renormalises
//
// WGSL's `fma(a, b, c) = a*b + c` is mandated to be a single rounded
// op, so twoProd is exact. The optimiser cannot collapse the
// compensation arithmetic the way GLSL drivers can, so the DS chain
// is provably preserved end-to-end.

const DS_HELPERS_WGSL = /* wgsl */`
fn twoSum(a: f32, b: f32) -> vec2<f32> {
  let s = a + b;
  let bb = s - a;
  let e = (a - (s - bb)) + (b - bb);
  return vec2<f32>(s, e);
}
fn twoProd(a: f32, b: f32) -> vec2<f32> {
  let p = a * b;
  let e = fma(a, b, -p);
  return vec2<f32>(p, e);
}
fn dsAdd(aHi: f32, aLo: f32, bHi: f32, bLo: f32) -> vec2<f32> {
  let s = twoSum(aHi, bHi);
  let lo = (aLo + bLo) + s.y;
  return twoSum(s.x, lo);
}
fn dsMul(aHi: f32, aLo: f32, bHi: f32, bLo: f32) -> vec2<f32> {
  let p = twoProd(aHi, bHi);
  let cross = fma(aHi, bLo, aLo * bHi);
  return twoSum(p.x, p.y + cross);
}
`;

// y = K · x  (full DS: matrix DS pairs × vector DS pairs, accumulated DS)
const MATVEC_WGSL = /* wgsl */`
${DS_HELPERS_WGSL}
struct Params {
  numRows: u32,
  maxRowLen: u32,
};
@group(0) @binding(0) var<storage, read>       cols   : array<i32>;
@group(0) @binding(1) var<storage, read>       valsHi : array<f32>;
@group(0) @binding(2) var<storage, read>       valsLo : array<f32>;
@group(0) @binding(3) var<storage, read>       xHi    : array<f32>;
@group(0) @binding(4) var<storage, read>       xLo    : array<f32>;
@group(0) @binding(5) var<storage, read_write> yHi    : array<f32>;
@group(0) @binding(6) var<storage, read_write> yLo    : array<f32>;
@group(0) @binding(7) var<uniform>             params : Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let row = gid.x;
  if (row >= params.numRows) { return; }
  var sumHi: f32 = 0.0;
  var sumLo: f32 = 0.0;
  let base: u32 = row * params.maxRowLen;
  for (var k: u32 = 0u; k < params.maxRowLen; k = k + 1u) {
    let col = cols[base + k];
    if (col < 0) { continue; }
    let cu = u32(col);
    let prod = dsMul(valsHi[base + k], valsLo[base + k], xHi[cu], xLo[cu]);
    let acc  = dsAdd(sumHi, sumLo, prod.x, prod.y);
    sumHi = acc.x;
    sumLo = acc.y;
  }
  yHi[row] = sumHi;
  yLo[row] = sumLo;
}
`;

// out_DS[i] = alpha_DS · a_DS[i] + beta_DS · b_DS[i].
// Scalars arrive as DS pairs (alphaHi, alphaLo) and (betaHi, betaLo),
// computed CPU-side from DS-grade dot products. With α/β stored as
// DS pairs, an axby step preserves DS precision end-to-end — the
// CPU never narrows the scalar to f32 before passing it back.
const AXBY_WGSL = /* wgsl */`
${DS_HELPERS_WGSL}
struct Scalars {
  alphaHi: f32, alphaLo: f32,
  betaHi:  f32, betaLo:  f32,
  n:       u32, _pad0: u32, _pad1: u32, _pad2: u32,
};
@group(0) @binding(0) var<storage, read>       aHi : array<f32>;
@group(0) @binding(1) var<storage, read>       aLo : array<f32>;
@group(0) @binding(2) var<storage, read>       bHi : array<f32>;
@group(0) @binding(3) var<storage, read>       bLo : array<f32>;
@group(0) @binding(4) var<storage, read_write> outHi : array<f32>;
@group(0) @binding(5) var<storage, read_write> outLo : array<f32>;
@group(0) @binding(6) var<uniform>             s   : Scalars;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= s.n) { return; }
  let aTerm = dsMul(s.alphaHi, s.alphaLo, aHi[i], aLo[i]);
  let bTerm = dsMul(s.betaHi,  s.betaLo,  bHi[i], bLo[i]);
  let sum   = dsAdd(aTerm.x, aTerm.y, bTerm.x, bTerm.y);
  outHi[i] = sum.x;
  outLo[i] = sum.y;
}
`;

// Dot product, stage 1 (first reduction).
// Inputs are DS vectors (xHi, xLo) and (yHi, yLo); each per-element
// product is a DS pair (twoProd + cross terms), and the per-thread
// accumulator is also DS. Output: 2·ceil(N/STRIDE) f32 entries laid
// out as interleaved (hi, lo) pairs.
const DOT_REDUCE_FIRST_WGSL = /* wgsl */`
${DS_HELPERS_WGSL}
const STRIDE: u32 = ${WORKGROUP_SIZE}u;
struct Params { n: u32, _pad0: u32, _pad1: u32, _pad2: u32, };
@group(0) @binding(0) var<storage, read>       xHi     : array<f32>;
@group(0) @binding(1) var<storage, read>       xLo     : array<f32>;
@group(0) @binding(2) var<storage, read>       yHi     : array<f32>;
@group(0) @binding(3) var<storage, read>       yLo     : array<f32>;
@group(0) @binding(4) var<storage, read_write> outPairs: array<f32>;
@group(0) @binding(5) var<uniform>             params  : Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let partition = gid.x;
  var hi: f32 = 0.0;
  var lo: f32 = 0.0;
  for (var k: u32 = 0u; k < STRIDE; k = k + 1u) {
    let idx = partition * STRIDE + k;
    if (idx >= params.n) { break; }
    let p = dsMul(xHi[idx], xLo[idx], yHi[idx], yLo[idx]);
    let acc = dsAdd(hi, lo, p.x, p.y);
    hi = acc.x;
    lo = acc.y;
  }
  outPairs[partition * 2u]      = hi;
  outPairs[partition * 2u + 1u] = lo;
}
`;

// Dot product, stage N (subsequent reductions). Each invocation
// DS-adds STRIDE pair entries into one output pair.
const DOT_REDUCE_PAIRS_WGSL = /* wgsl */`
${DS_HELPERS_WGSL}
const STRIDE: u32 = ${WORKGROUP_SIZE}u;
struct Params { pairCount: u32, _pad0: u32, _pad1: u32, _pad2: u32, };
@group(0) @binding(0) var<storage, read>       inPairs : array<f32>;
@group(0) @binding(1) var<storage, read_write> outPairs: array<f32>;
@group(0) @binding(2) var<uniform>             params  : Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let partition = gid.x;
  var hi: f32 = 0.0;
  var lo: f32 = 0.0;
  for (var k: u32 = 0u; k < STRIDE; k = k + 1u) {
    let idx = partition * STRIDE + k;
    if (idx >= params.pairCount) { break; }
    let xH = inPairs[idx * 2u];
    let xL = inPairs[idx * 2u + 1u];
    let acc = dsAdd(hi, lo, xH, xL);
    hi = acc.x;
    lo = acc.y;
  }
  outPairs[partition * 2u]      = hi;
  outPairs[partition * 2u + 1u] = lo;
}
`;

// =============================================================================
// FGMRES-only kernels
// =============================================================================
//
// To keep an entire MGS inner iteration on the GPU, FGMRES needs the
// dot product to write its result into a *Hessenberg storage buffer*
// rather than to the readbackPair, and the next axby to read its
// scalar from that same Hessenberg buffer. CPU stays out of the loop
// — only the post-iteration Givens / least-squares uses CPU readback.
//
//   DS_COPY_PAIR_WGSL   — copies one DS pair from src[srcOff..+1]
//                         to dst[dstOff..+1]. Used to move the final
//                         dot-reduction pair into the Hessenberg
//                         matrix at H[i, j].
//   DS_AXBY_HESS_NEG_WGSL — in-place "w := w − H[i, j]·V[i]" with the
//                         scalar read from the Hessenberg storage
//                         buffer. Saves the CPU readback that the
//                         normal encodeAxby would need.

const DS_COPY_PAIR_WGSL = /* wgsl */`
struct Params {
  srcOffset: u32, dstOffset: u32, _pad0: u32, _pad1: u32,
};
@group(0) @binding(0) var<storage, read>       src : array<f32>;
@group(0) @binding(1) var<storage, read_write> dst : array<f32>;
@group(0) @binding(2) var<uniform>             p   : Params;

@compute @workgroup_size(1)
fn main() {
  dst[p.dstOffset]       = src[p.srcOffset];
  dst[p.dstOffset + 1u]  = src[p.srcOffset + 1u];
}
`;

const DS_AXBY_HESS_NEG_WGSL = /* wgsl */`
${DS_HELPERS_WGSL}
struct Params {
  hessOffset: u32,   // index into hessenberg as f32 (DS pair starts here)
  n:          u32,
  _pad0: u32, _pad1: u32,
};
@group(0) @binding(0) var<storage, read>       hessenberg: array<f32>;
@group(0) @binding(1) var<storage, read>       vHi : array<f32>;
@group(0) @binding(2) var<storage, read>       vLo : array<f32>;
@group(0) @binding(3) var<storage, read_write> wHi : array<f32>;
@group(0) @binding(4) var<storage, read_write> wLo : array<f32>;
@group(0) @binding(5) var<uniform>             params : Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let hHi = hessenberg[params.hessOffset];
  let hLo = hessenberg[params.hessOffset + 1u];
  let prod = dsMul(hHi, hLo, vHi[i], vLo[i]);
  // w := w − prod, in DS.
  let sum = dsAdd(wHi[i], wLo[i], -prod.x, -prod.y);
  wHi[i] = sum.x;
  wLo[i] = sum.y;
}
`;

// Block-Jacobi preconditioner.
// Inputs: residual r as DS pair (rHi, rLo).
// Coefficients (selfCoef, prevCoef, nextCoef) are stored as packed
// vec2<f32> DS pairs: x = hi, y = lo. This keeps the binding count at
// the portable WebGPU limit while preserving the f64 CPU coefficient
// information in the resident Krylov chain.
// `selfCoef[i]·r[i] + prevCoef[i]·r[i-1] + nextCoef[i]·r[i+1]` with
// per-term DS multiplication and DS accumulation, so the application
// keeps coefficient and residual precision in the same DS format.
// Fixed-offset reads at i±1 (no dependent texture reads — same Apple
// Metal compatibility fix as the WebGL2 path).
const BLOCK_JACOBI_WGSL = /* wgsl */`
${DS_HELPERS_WGSL}
struct Params { n: u32, _pad0: u32, _pad1: u32, _pad2: u32, };
@group(0) @binding(0) var<storage, read>       selfCoef: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       prevCoef: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read>       nextCoef: array<vec2<f32>>;
@group(0) @binding(3) var<storage, read>       rHi     : array<f32>;
@group(0) @binding(4) var<storage, read>       rLo     : array<f32>;
@group(0) @binding(5) var<storage, read_write> zHi     : array<f32>;
@group(0) @binding(6) var<storage, read_write> zLo     : array<f32>;
@group(0) @binding(7) var<uniform>             params  : Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.n) { return; }
  let last = params.n - 1u;
  var iPrev: u32 = i;
  if (i > 0u) { iPrev = i - 1u; }
  var iNext: u32 = i;
  if (i < last) { iNext = i + 1u; }
  let selfTerm = dsMul(selfCoef[i].x, selfCoef[i].y, rHi[i],     rLo[i]);
  let prevTerm = dsMul(prevCoef[i].x, prevCoef[i].y, rHi[iPrev], rLo[iPrev]);
  let nextTerm = dsMul(nextCoef[i].x, nextCoef[i].y, rHi[iNext], rLo[iNext]);
  let s1 = dsAdd(selfTerm.x, selfTerm.y, prevTerm.x, prevTerm.y);
  let s2 = dsAdd(s1.x,       s1.y,       nextTerm.x, nextTerm.y);
  zHi[i] = s2.x;
  zLo[i] = s2.y;
}
`;

const SCHWARZ_PATCH_APPLY_WGSL = /* wgsl */`
${DS_HELPERS_WGSL}
struct Params { numPatches: u32, _pad0: u32, _pad1: u32, _pad2: u32, };
@group(0) @binding(0) var<storage, read>       patchOffsets  : array<i32>;
@group(0) @binding(1) var<storage, read>       localRows     : array<i32>;
@group(0) @binding(2) var<storage, read>       inverseOffsets: array<i32>;
@group(0) @binding(3) var<storage, read>       inverseValues : array<vec2<f32>>;
@group(0) @binding(4) var<storage, read>       rHi           : array<f32>;
@group(0) @binding(5) var<storage, read>       rLo           : array<f32>;
@group(0) @binding(6) var<storage, read_write> patchSolHi    : array<f32>;
@group(0) @binding(7) var<storage, read_write> patchSolLo    : array<f32>;
@group(0) @binding(8) var<uniform>             params        : Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let patch = gid.x;
  if (patch >= params.numPatches) { return; }
  let rowStart = u32(patchOffsets[patch]);
  let rowEnd = u32(patchOffsets[patch + 1u]);
  let nLocal = rowEnd - rowStart;
  let inverseBase = u32(inverseOffsets[patch]);
  for (var localRow: u32 = 0u; localRow < nLocal; localRow = localRow + 1u) {
    var sumHi: f32 = 0.0;
    var sumLo: f32 = 0.0;
    for (var localCol: u32 = 0u; localCol < nLocal; localCol = localCol + 1u) {
      let globalCol = u32(localRows[rowStart + localCol]);
      let invPair = inverseValues[inverseBase + localRow * nLocal + localCol];
      let term = dsMul(invPair.x, invPair.y, rHi[globalCol], rLo[globalCol]);
      let acc = dsAdd(sumHi, sumLo, term.x, term.y);
      sumHi = acc.x;
      sumLo = acc.y;
    }
    patchSolHi[rowStart + localRow] = sumHi;
    patchSolLo[rowStart + localRow] = sumLo;
  }
}
`;

const SCHWARZ_DOF_GATHER_WGSL = /* wgsl */`
${DS_HELPERS_WGSL}
struct Params { n: u32, _pad0: u32, _pad1: u32, _pad2: u32, };
@group(0) @binding(0) var<storage, read>       dofOffsets : array<i32>;
@group(0) @binding(1) var<storage, read>       dofEntries : array<i32>;
@group(0) @binding(2) var<storage, read>       dofWeights : array<vec2<f32>>;
@group(0) @binding(3) var<storage, read>       patchSolHi : array<f32>;
@group(0) @binding(4) var<storage, read>       patchSolLo : array<f32>;
@group(0) @binding(5) var<storage, read_write> zHi        : array<f32>;
@group(0) @binding(6) var<storage, read_write> zLo        : array<f32>;
@group(0) @binding(7) var<uniform>             params     : Params;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let row = gid.x;
  if (row >= params.n) { return; }
  let start = u32(dofOffsets[row]);
  let end = u32(dofOffsets[row + 1u]);
  var sumHi: f32 = 0.0;
  var sumLo: f32 = 0.0;
  for (var entry: u32 = start; entry < end; entry = entry + 1u) {
    let solIndex = u32(dofEntries[entry]);
    let weight = dofWeights[entry];
    let term = dsMul(weight.x, weight.y, patchSolHi[solIndex], patchSolLo[solIndex]);
    let acc = dsAdd(sumHi, sumLo, term.x, term.y);
    sumHi = acc.x;
    sumLo = acc.y;
  }
  zHi[row] = sumHi;
  zLo[row] = sumLo;
}
`;

// =============================================================================
// Backend lifecycle
// =============================================================================

function isWebgpuAvailable() {
  return typeof navigator !== 'undefined'
    && typeof navigator.gpu !== 'undefined'
    && typeof navigator.gpu.requestAdapter === 'function';
}

export async function probeWebgpuBackend() {
  if (!isWebgpuAvailable()) return { ok: false, reason: 'webgpu-unavailable' };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: 'webgpu-no-adapter' };
    const device = await adapter.requestDevice();
    if (!device) return { ok: false, reason: 'webgpu-no-device' };
    // Free immediately; the actual run-time backend re-acquires.
    if (typeof device.destroy === 'function') {
      try { device.destroy(); } catch { /* ignore */ }
    }
    return {
      ok: true,
      reason: '',
      mode: 'webgpu',
      context: 'navigator-gpu',
      maxTextureSize: 0
    };
  } catch (error) {
    return { ok: false, reason: `webgpu-probe-threw:${error?.message || 'unknown'}` };
  }
}

export async function tryCreateWebgpuBackend(setup = {}) {
  if (!isWebgpuAvailable()) return { backend: null, reason: 'webgpu-unavailable' };

  let adapter;
  try {
    adapter = await navigator.gpu.requestAdapter({
      powerPreference: setup?.powerPreference || 'high-performance'
    });
  } catch (error) {
    return { backend: null, reason: `webgpu-adapter-threw:${error?.message || 'unknown'}` };
  }
  if (!adapter) return { backend: null, reason: 'webgpu-no-adapter' };

  let device;
  try {
    // Default limits are sufficient for our 4 k–500 k DOF range; we do
    // not need any optional features.
    device = await adapter.requestDevice();
  } catch (error) {
    return { backend: null, reason: `webgpu-device-threw:${error?.message || 'unknown'}` };
  }
  if (!device) return { backend: null, reason: 'webgpu-no-device' };

  // Compile compute pipelines once at creation time. WGSL compilation
  // is O(ms) and we want zero per-solve cost.
  let matvecPipeline = null;
  let axbyPipeline = null;
  let dotReduceFirstPipeline = null;
  let dotReducePairsPipeline = null;
  let blockJacobiPipeline = null;
  let schwarzPatchApplyPipeline = null;
  let schwarzDofGatherPipeline = null;
  let copyPairPipeline = null;
  let axbyHessNegPipeline = null;
  try {
    matvecPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: MATVEC_WGSL }), entryPoint: 'main' }
    });
    axbyPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: AXBY_WGSL }), entryPoint: 'main' }
    });
    dotReduceFirstPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: DOT_REDUCE_FIRST_WGSL }), entryPoint: 'main' }
    });
    dotReducePairsPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: DOT_REDUCE_PAIRS_WGSL }), entryPoint: 'main' }
    });
    blockJacobiPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: BLOCK_JACOBI_WGSL }), entryPoint: 'main' }
    });
    schwarzPatchApplyPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: SCHWARZ_PATCH_APPLY_WGSL }), entryPoint: 'main' }
    });
    schwarzDofGatherPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: SCHWARZ_DOF_GATHER_WGSL }), entryPoint: 'main' }
    });
    copyPairPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: DS_COPY_PAIR_WGSL }), entryPoint: 'main' }
    });
    axbyHessNegPipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: DS_AXBY_HESS_NEG_WGSL }), entryPoint: 'main' }
    });
  } catch (error) {
    if (typeof device.destroy === 'function') {
      try { device.destroy(); } catch { /* ignore */ }
    }
    return { backend: null, reason: `webgpu-pipeline-create-threw:${error?.message || 'unknown'}` };
  }

  // ---------------------------------------------------------------------------
  // Persistent buffer pool. We allocate by length-class (rounded up to
  // the next 64-element boundary) and reuse across solves so the steady
  // state has zero allocation overhead.
  // ---------------------------------------------------------------------------
  const buffers = {
    // Sparse matrix in DS-ELLPACK layout: cols (i32), valsHi/valsLo (f32 pairs).
    cols: null,
    valsHi: null,
    valsLo: null,
    // CG vectors as DS pairs.
    rhsHi: null, rhsLo: null,
    xHi:   null, xLo:   null,
    rHi:   null, rLo:   null,
    zHi:   null, zLo:   null,
    pHi:   null, pLo:   null,
    apHi:  null, apLo:  null,
    // Scratch for true residual replacement (b - K·x periodic recompute).
    refHi: null, refLo: null,
    // Block-Jacobi preconditioner coefficients as packed DS vec2<f32>
    // arrays (hi, lo) so the resident preconditioner does not narrow
    // CPU-f64 inverse-block coefficients to a single f32.
    selfCoef: null, prevCoef: null, nextCoef: null,
    // Additive Schwarz PoU preconditioner. Local dense inverses are
    // stored as packed DS vec2<f32> with the symmetric gather weights
    // pre-multiplied into their columns; the per-DOF gather applies
    // the matching symmetric scatter weights, so no float atomics are
    // required and the CG preconditioner remains symmetric.
    schwarzPatchOffsets: null,
    schwarzLocalRows: null,
    schwarzInverseOffsets: null,
    schwarzInverseValues: null,
    schwarzDofOffsets: null,
    schwarzDofEntries: null,
    schwarzDofWeights: null,
    schwarzPatchSolHi: null,
    schwarzPatchSolLo: null,
    schwarzPatchParams: null,
    schwarzGatherParams: null,
    // Reduction ping-pong (interleaved DS pairs).
    dotPairsA: null,
    dotPairsB: null,
    // Constants per solve.
    matvecParams: null,      // uniform: numRows, maxRowLen
    blockJacobiParams: null, // uniform: n
    readbackPair: null,      // 8-byte mappable staging for scalar downloads
    // Mappable staging buffer for full-vector readback (matvec API).
    readbackVecHi: null,
    readbackVecLo: null
  };

  // Uniform-buffer pool. WebGPU queues `writeBuffer` ops on the queue
  // timeline, *not* the command-encoder timeline — so when an encoder
  // contains two dispatches that bind the same uniform buffer with
  // different writes between them, the GPU sees only the *last* write
  // by the time the submit runs. That made `encodeAxby(..., +α)`
  // followed by `encodeAxby(..., -α)` in one submit silently produce
  // `x = x + (-α)p` for the first dispatch — a correctness bug that
  // would diverge CG. The pool gives each dispatch its own dedicated
  // uniform buffer (16 bytes apiece, single allocation), and a counter
  // that resets at the start of each encoder ensures we never alias.
  // Uniform pool slots are sized to fit the largest uniform struct in
  // the kernel set: the axby Scalars (4 f32 + 1 u32 + 3 u32 pad =
  // 32 bytes). All other kernels' uniform structs are smaller and
  // bind the same slots without issue (WGSL only validates the
  // declared struct size against the buffer; binding extra bytes is
  // permitted).
  const UNIFORM_POOL_SLOT_BYTES = 32;
  // FGMRES inner iteration j has ~ (j+1) * 5 dispatches that consume
  // uniform slots (multi-stage dot, copy-pair, axby-hess-neg per MGS
  // step). At j = 30 that is ~ 150 slots; we round generously to 256
  // so the pool never exhausts within a single submitted encoder.
  const UNIFORM_POOL_SIZE = 256;
  const uniformPool = [];
  let uniformPoolIdx = 0;
  function ensureUniformPool() {
    if (uniformPool.length > 0) return;
    for (let i = 0; i < UNIFORM_POOL_SIZE; i += 1) {
      uniformPool.push(device.createBuffer({
        label: `cg-uniform-pool-${i}`,
        size: UNIFORM_POOL_SLOT_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }));
    }
  }
  function nextUniform() {
    if (uniformPoolIdx >= UNIFORM_POOL_SIZE) {
      throw new Error(`webgpu-uniform-pool-exhausted:size=${UNIFORM_POOL_SIZE}`);
    }
    const buf = uniformPool[uniformPoolIdx];
    uniformPoolIdx += 1;
    return buf;
  }
  // Alias for clarity — the 32-byte axby uniform is the largest.
  function nextUniform32() { return nextUniform(); }

  // Split a JS f64 number into a (hi, lo) DS pair. `hi` is the
  // f32-rounded value, `lo` captures the f64→f32 narrowing residual
  // (also expressed in f32 — exactly representable since the magnitude
  // gap between consecutive f32 values is well above the residual).
  // Used to feed CPU-computed scalars (alpha, beta) into DS kernels
  // without losing the part of the value that doesn't fit in f32.
  function splitToDsPair(value) {
    if (!Number.isFinite(value)) {
      throw new Error(`splitToDsPair: non-finite scalar ${value}`);
    }
    const hi = Math.fround(value);
    const lo = Math.fround(value - hi);
    return { hi, lo };
  }
  function beginEncoder() {
    // Each new encoder starts a fresh "submit window" — the previous
    // submit's uniforms are no longer in flight (we always await a
    // readback before encoding the next iteration's first half), so
    // we can recycle every slot from index 0.
    uniformPoolIdx = 0;
    return device.createCommandEncoder();
  }
  function isRunControlStopped(runControl) {
    if (typeof runControl?.shouldStop === 'function') return !!runControl.shouldStop();
    // Historical compatibility only. New solver run controls expose
    // `shouldStop` and `checkpoint`; `shouldInterrupt` belonged to an
    // earlier worker contract.
    if (typeof runControl?.shouldInterrupt === 'function') return !!runControl.shouldInterrupt();
    return false;
  }
  async function checkpointRunControl(runControl, force = false) {
    if (typeof runControl?.checkpoint === 'function') {
      return !!(await runControl.checkpoint({ force }));
    }
    return isRunControlStopped(runControl);
  }
  let cachedRowsRef = null;
  let cachedShape = null;
  let cachedDimension = 0;
  let cachedHostMatrix = null;
  let cachedSchwarzRef = null;

  function disposeBuffer(b) {
    if (b && typeof b.destroy === 'function') {
      try { b.destroy(); } catch { /* ignore */ }
    }
  }

  function freeAll() {
    for (const key of Object.keys(buffers)) {
      disposeBuffer(buffers[key]);
      buffers[key] = null;
    }
    for (const buf of uniformPool) disposeBuffer(buf);
    uniformPool.length = 0;
    uniformPoolIdx = 0;
    freeKrylov();
    cachedRowsRef = null;
    cachedShape = null;
    cachedDimension = 0;
    cachedHostMatrix = null;
    cachedSchwarzRef = null;
  }

  function makeStorageBuffer(byteLength, label) {
    return device.createBuffer({
      label,
      size: Math.max(byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });
  }
  function makeUniformBuffer(byteLength, label) {
    return device.createBuffer({
      label,
      size: Math.max(byteLength, 16),
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }
  function makeReadbackBuffer(byteLength, label) {
    return device.createBuffer({
      label,
      size: Math.max(byteLength, 16),
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
  }

  // Allocate the always-needed fixed-size uniforms and the per-dispatch
  // pool up-front. This used to be lazy inside `ensureVectorBuffers`,
  // but `ensureMatrixBuffers` writes to `matvecParams` and is called
  // first by both `matvec` and the resident solver — calling it before
  // any vector setup left `matvecParams` null and threw a TypeError on
  // `queue.writeBuffer`. Allocating eagerly is cheap (≈ 1 KB total) and
  // removes the ordering trap.
  buffers.matvecParams = makeUniformBuffer(16, 'cg-matvec-params');
  buffers.blockJacobiParams = makeUniformBuffer(16, 'cg-block-jacobi-params');
  buffers.readbackPair = makeReadbackBuffer(8, 'cg-readback-pair');
  ensureUniformPool();

  function ensureVectorBuffers(n) {
    if (cachedDimension === n && buffers.xHi) return;
    if (cachedDimension !== n) {
      // Vector dimension changed (different mesh / DOF count). Free
      // every DS-pair vector buffer and reallocate at the new size.
      const vecKeys = [
        'rhsHi','rhsLo','xHi','xLo','rHi','rLo','zHi','zLo','pHi','pLo',
        'apHi','apLo','refHi','refLo',
        'selfCoef','prevCoef','nextCoef',
        'schwarzPatchOffsets','schwarzLocalRows','schwarzInverseOffsets','schwarzInverseValues',
        'schwarzDofOffsets','schwarzDofEntries','schwarzDofWeights',
        'schwarzPatchSolHi','schwarzPatchSolLo','schwarzPatchParams','schwarzGatherParams',
        'dotPairsA','dotPairsB',
        'readbackVecHi','readbackVecLo'
      ];
      for (const key of vecKeys) {
        disposeBuffer(buffers[key]);
        buffers[key] = null;
      }
      cachedSchwarzRef = null;
    }
    const vecBytes = n * 4;
    const allocVec = (label) => makeStorageBuffer(vecBytes, label);
    buffers.rhsHi = allocVec('cg-rhs-hi');  buffers.rhsLo = allocVec('cg-rhs-lo');
    buffers.xHi   = allocVec('cg-x-hi');    buffers.xLo   = allocVec('cg-x-lo');
    buffers.rHi   = allocVec('cg-r-hi');    buffers.rLo   = allocVec('cg-r-lo');
    buffers.zHi   = allocVec('cg-z-hi');    buffers.zLo   = allocVec('cg-z-lo');
    buffers.pHi   = allocVec('cg-p-hi');    buffers.pLo   = allocVec('cg-p-lo');
    buffers.apHi  = allocVec('cg-ap-hi');   buffers.apLo  = allocVec('cg-ap-lo');
    buffers.refHi = allocVec('cg-ref-hi');  buffers.refLo = allocVec('cg-ref-lo');
    buffers.selfCoef = makeStorageBuffer(vecBytes * 2, 'cg-precond-self-ds');
    buffers.prevCoef = makeStorageBuffer(vecBytes * 2, 'cg-precond-prev-ds');
    buffers.nextCoef = makeStorageBuffer(vecBytes * 2, 'cg-precond-next-ds');

    // Reduction ping-pong. Each pass halves the input pair count by
    // STRIDE; worst case we need a buffer that holds 2 entries per
    // partition (DS pair) and another the same size. Sized for n
    // input elements at the largest stage.
    const maxPairBytes = Math.max(2 * Math.ceil(n / WORKGROUP_SIZE), 2) * 4;
    const reduceBytes = Math.max(n * 4, maxPairBytes * 2);
    buffers.dotPairsA = makeStorageBuffer(reduceBytes, 'cg-dot-pairs-a');
    buffers.dotPairsB = makeStorageBuffer(reduceBytes, 'cg-dot-pairs-b');

    // Mappable staging for the public matvec readback (DS pair → f64).
    buffers.readbackVecHi = makeReadbackBuffer(vecBytes, 'cg-readback-vec-hi');
    buffers.readbackVecLo = makeReadbackBuffer(vecBytes, 'cg-readback-vec-lo');

    // Block-Jacobi `n` is constant for the duration of a solve; write
    // it here once so the per-iteration encoder doesn't have to.
    device.queue.writeBuffer(buffers.blockJacobiParams, 0, new Uint32Array([n, 0, 0, 0]));

    cachedDimension = n;
  }

  function ensureMatrixBuffers(rows) {
    if (cachedRowsRef === rows && buffers.cols) return cachedShape;
    const shape = computeEllpackShape(rows);
    if (!cachedShape || cachedShape.numRows !== shape.numRows || cachedShape.maxRowLen !== shape.maxRowLen) {
      disposeBuffer(buffers.cols);   buffers.cols = null;
      disposeBuffer(buffers.valsHi); buffers.valsHi = null;
      disposeBuffer(buffers.valsLo); buffers.valsLo = null;
      const flatLen = shape.numRows * shape.maxRowLen;
      buffers.cols = device.createBuffer({
        label: 'cg-matrix-cols',
        size: Math.max(flatLen * 4, 16),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
      });
      buffers.valsHi = makeStorageBuffer(flatLen * 4, 'cg-matrix-vals-hi');
      buffers.valsLo = makeStorageBuffer(flatLen * 4, 'cg-matrix-vals-lo');
      cachedShape = shape;
      // DS host buffer: f64 values are split into (hi, lo) f32 pairs
      // by `packEllpackValues` so the kernel can use compensated
      // arithmetic. The CPU-f32 surrogate uses the same packer and is
      // verified to give f64-equivalent matvec results in the
      // CPU-f32 backend's regression case.
      cachedHostMatrix = createEllpackBuffer({
        numRows: shape.numRows,
        maxRowLen: shape.maxRowLen,
        valueDtype: 'ds'
      });
    } else if (!cachedHostMatrix) {
      cachedHostMatrix = createEllpackBuffer({
        numRows: shape.numRows,
        maxRowLen: shape.maxRowLen,
        valueDtype: 'ds'
      });
    }
    if (!ellpackPatternMatches(cachedHostMatrix, rows) || cachedHostMatrix.rowsRef !== rows) {
      packIndicesIntoBuffer(cachedHostMatrix, rows);
      packValuesIntoBuffer(cachedHostMatrix, rows);
    }
    // Upload — single submit even for the largest mesh.
    device.queue.writeBuffer(buffers.cols,   0, cachedHostMatrix.cols);
    device.queue.writeBuffer(buffers.valsHi, 0, cachedHostMatrix.valsHi);
    device.queue.writeBuffer(buffers.valsLo, 0, cachedHostMatrix.valsLo);
    device.queue.writeBuffer(buffers.matvecParams, 0, new Uint32Array([shape.numRows, shape.maxRowLen, 0, 0]));
    cachedRowsRef = rows;
    return shape;
  }

  function dispatchSize(n) {
    return Math.max(1, Math.ceil(n / WORKGROUP_SIZE));
  }

  // y = K · x, both as DS pairs.
  function encodeMatvec(encoder, xHiBuf, xLoBuf, yHiBuf, yLoBuf, n) {
    const pass = encoder.beginComputePass();
    pass.setPipeline(matvecPipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: matvecPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.cols } },
        { binding: 1, resource: { buffer: buffers.valsHi } },
        { binding: 2, resource: { buffer: buffers.valsLo } },
        { binding: 3, resource: { buffer: xHiBuf } },
        { binding: 4, resource: { buffer: xLoBuf } },
        { binding: 5, resource: { buffer: yHiBuf } },
        { binding: 6, resource: { buffer: yLoBuf } },
        { binding: 7, resource: { buffer: buffers.matvecParams } }
      ]
    }));
    pass.dispatchWorkgroups(dispatchSize(n));
    pass.end();
  }

  // out_DS = alpha_DS · a_DS + beta_DS · b_DS. Scalars come from CPU
  // as DS pairs computed from DS dot products; passing them as DS
  // pairs avoids narrowing the loop's most precision-sensitive
  // numbers (rzOld/denom and rzNew/rzOld) to f32.
  function encodeAxby(encoder, aHiBuf, aLoBuf, bHiBuf, bLoBuf, outHiBuf, outLoBuf, alpha, beta, n) {
    const params = nextUniform32(); // 32-byte uniform: 4 f32 + u32 n + 12 bytes pad
    const aPair = splitToDsPair(alpha);
    const bPair = splitToDsPair(beta);
    const f32View = new Float32Array([aPair.hi, aPair.lo, bPair.hi, bPair.lo]);
    const u32View = new Uint32Array([n, 0, 0, 0]);
    device.queue.writeBuffer(params, 0, f32View);
    device.queue.writeBuffer(params, 16, u32View);
    const pass = encoder.beginComputePass();
    pass.setPipeline(axbyPipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: axbyPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: aHiBuf } },
        { binding: 1, resource: { buffer: aLoBuf } },
        { binding: 2, resource: { buffer: bHiBuf } },
        { binding: 3, resource: { buffer: bLoBuf } },
        { binding: 4, resource: { buffer: outHiBuf } },
        { binding: 5, resource: { buffer: outLoBuf } },
        { binding: 6, resource: { buffer: params } }
      ]
    }));
    pass.dispatchWorkgroups(dispatchSize(n));
    pass.end();
  }

  function encodeBlockJacobi(encoder, rHiBuf, rLoBuf, zHiBuf, zLoBuf, n) {
    // n was uploaded once in ensureVectorBuffers; no per-call write.
    const pass = encoder.beginComputePass();
    pass.setPipeline(blockJacobiPipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: blockJacobiPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers.selfCoef } },
        { binding: 1, resource: { buffer: buffers.prevCoef } },
        { binding: 2, resource: { buffer: buffers.nextCoef } },
        { binding: 3, resource: { buffer: rHiBuf } },
        { binding: 4, resource: { buffer: rLoBuf } },
        { binding: 5, resource: { buffer: zHiBuf } },
        { binding: 6, resource: { buffer: zLoBuf } },
        { binding: 7, resource: { buffer: buffers.blockJacobiParams } }
      ]
    }));
    pass.dispatchWorkgroups(dispatchSize(n));
    pass.end();
  }

  function encodeSchwarz(encoder, rHiBuf, rLoBuf, zHiBuf, zLoBuf, preconditioner, n) {
    if (!ensureSchwarzBuffers(preconditioner, n)) {
      throw new Error('webgpu-schwarz-preconditioner-invalid');
    }
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(schwarzPatchApplyPipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout: schwarzPatchApplyPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buffers.schwarzPatchOffsets } },
          { binding: 1, resource: { buffer: buffers.schwarzLocalRows } },
          { binding: 2, resource: { buffer: buffers.schwarzInverseOffsets } },
          { binding: 3, resource: { buffer: buffers.schwarzInverseValues } },
          { binding: 4, resource: { buffer: rHiBuf } },
          { binding: 5, resource: { buffer: rLoBuf } },
          { binding: 6, resource: { buffer: buffers.schwarzPatchSolHi } },
          { binding: 7, resource: { buffer: buffers.schwarzPatchSolLo } },
          { binding: 8, resource: { buffer: buffers.schwarzPatchParams } }
        ]
      }));
      pass.dispatchWorkgroups(dispatchSize(preconditioner.patchCount));
      pass.end();
    }
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(schwarzDofGatherPipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout: schwarzDofGatherPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buffers.schwarzDofOffsets } },
          { binding: 1, resource: { buffer: buffers.schwarzDofEntries } },
          { binding: 2, resource: { buffer: buffers.schwarzDofWeights } },
          { binding: 3, resource: { buffer: buffers.schwarzPatchSolHi } },
          { binding: 4, resource: { buffer: buffers.schwarzPatchSolLo } },
          { binding: 5, resource: { buffer: zHiBuf } },
          { binding: 6, resource: { buffer: zLoBuf } },
          { binding: 7, resource: { buffer: buffers.schwarzGatherParams } }
        ]
      }));
      pass.dispatchWorkgroups(dispatchSize(n));
      pass.end();
    }
  }

  function encodePreconditioner(encoder, preconditioner, rHiBuf, rLoBuf, zHiBuf, zLoBuf, n) {
    if (preconditioner?.kind === 'gpu-additive-schwarz-pou') {
      encodeSchwarz(encoder, rHiBuf, rLoBuf, zHiBuf, zLoBuf, preconditioner, n);
      return;
    }
    encodeBlockJacobi(encoder, rHiBuf, rLoBuf, zHiBuf, zLoBuf, n);
  }

  // Full DS dot product over DS vectors, with the final pair copied
  // to the mappable readbackPair so the caller can `await readPair()`.
  function encodeDot(encoder, xHiBuf, xLoBuf, yHiBuf, yLoBuf, n) {
    const finalBuf = encodeDotInternal(encoder, xHiBuf, xLoBuf, yHiBuf, yLoBuf, n);
    encoder.copyBufferToBuffer(finalBuf, 0, buffers.readbackPair, 0, 8);
    return finalBuf;
  }

  // ---------------------------------------------------------------------------
  // FGMRES encode helpers + Krylov buffer pool.
  // ---------------------------------------------------------------------------
  // Krylov basis. V[0..m] (m = restart, so V has m+1 vectors) and
  // Z[0..m-1] (preconditioned vectors) live in their own GPU buffers.
  // The Hessenberg matrix is a single storage buffer holding (m+1)·m
  // DS pairs in row-major (h[i,j] at f32 offset 2·(i·m + j)).
  const krylov = {
    V: [],     // each entry: { hi, lo } GPU buffers
    Z: [],     // each entry: { hi, lo }
    wHi: null, wLo: null,         // working DS pair
    refHi: null, refLo: null,     // K·x scratch for true-residual recompute
    hessenberg: null,             // (m+1) × m DS pairs (storage buffer)
    hessenbergStaging: null,      // mappable readback
    hessenbergStagingBytes: 0
  };
  let krylovDimension = 0;
  let krylovRestart = 0;

  function freeKrylov() {
    for (const v of krylov.V) {
      disposeBuffer(v.hi); disposeBuffer(v.lo);
    }
    krylov.V.length = 0;
    for (const z of krylov.Z) {
      disposeBuffer(z.hi); disposeBuffer(z.lo);
    }
    krylov.Z.length = 0;
    disposeBuffer(krylov.wHi);   krylov.wHi = null;
    disposeBuffer(krylov.wLo);   krylov.wLo = null;
    disposeBuffer(krylov.refHi); krylov.refHi = null;
    disposeBuffer(krylov.refLo); krylov.refLo = null;
    disposeBuffer(krylov.hessenberg); krylov.hessenberg = null;
    disposeBuffer(krylov.hessenbergStaging); krylov.hessenbergStaging = null;
    krylov.hessenbergStagingBytes = 0;
    krylovDimension = 0;
    krylovRestart = 0;
  }

  function ensureKrylovBuffers(n, restart) {
    if (krylovDimension === n && krylovRestart === restart && krylov.wHi) return;
    freeKrylov();
    const vecBytes = n * 4;
    for (let i = 0; i <= restart; i += 1) {
      krylov.V.push({
        hi: makeStorageBuffer(vecBytes, `gmres-V-${i}-hi`),
        lo: makeStorageBuffer(vecBytes, `gmres-V-${i}-lo`)
      });
    }
    for (let i = 0; i < restart; i += 1) {
      krylov.Z.push({
        hi: makeStorageBuffer(vecBytes, `gmres-Z-${i}-hi`),
        lo: makeStorageBuffer(vecBytes, `gmres-Z-${i}-lo`)
      });
    }
    krylov.wHi = makeStorageBuffer(vecBytes, 'gmres-w-hi');
    krylov.wLo = makeStorageBuffer(vecBytes, 'gmres-w-lo');
    krylov.refHi = makeStorageBuffer(vecBytes, 'gmres-ref-hi');
    krylov.refLo = makeStorageBuffer(vecBytes, 'gmres-ref-lo');
    // Hessenberg: (restart+1) × restart DS pairs = 2·restart·(restart+1) f32.
    const hessBytes = 8 * restart * (restart + 1);
    krylov.hessenberg = device.createBuffer({
      label: 'gmres-hessenberg',
      size: Math.max(hessBytes, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    });
    krylov.hessenbergStaging = makeReadbackBuffer(hessBytes, 'gmres-hessenberg-staging');
    krylov.hessenbergStagingBytes = hessBytes;
    krylovDimension = n;
    krylovRestart = restart;
  }

  // Encode a copy of the final DS pair from `srcBuf[srcOffPair*2..]`
  // to `dstBuf[dstOffPair*2..]`. `*Pair` indices count DS *pairs*,
  // not f32 entries. Used to move the final dot-reduction pair into
  // the Hessenberg matrix at H[i, j].
  function encodeCopyPair(encoder, srcBuf, srcOffPair, dstBuf, dstOffPair) {
    const params = nextUniform32();
    device.queue.writeBuffer(params, 0, new Uint32Array([
      srcOffPair * 2, dstOffPair * 2, 0, 0
    ]));
    const pass = encoder.beginComputePass();
    pass.setPipeline(copyPairPipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: copyPairPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: srcBuf } },
        { binding: 1, resource: { buffer: dstBuf } },
        { binding: 2, resource: { buffer: params } }
      ]
    }));
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  // In-place "w := w − H[hessOffPair] · v" with the scalar read from
  // the Hessenberg storage buffer (no CPU readback). `hessOffPair` is
  // the DS-pair index (h[i, j] at row-major i·m + j).
  function encodeAxbyHessNeg(encoder, vHiBuf, vLoBuf, wHiBuf, wLoBuf, hessOffPair, n) {
    const params = nextUniform32();
    device.queue.writeBuffer(params, 0, new Uint32Array([hessOffPair * 2, n, 0, 0]));
    const pass = encoder.beginComputePass();
    pass.setPipeline(axbyHessNegPipeline);
    pass.setBindGroup(0, device.createBindGroup({
      layout: axbyHessNegPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: krylov.hessenberg } },
        { binding: 1, resource: { buffer: vHiBuf } },
        { binding: 2, resource: { buffer: vLoBuf } },
        { binding: 3, resource: { buffer: wHiBuf } },
        { binding: 4, resource: { buffer: wLoBuf } },
        { binding: 5, resource: { buffer: params } }
      ]
    }));
    pass.dispatchWorkgroups(dispatchSize(n));
    pass.end();
  }

  // Encode a DS dot product whose final pair lands at Hessenberg
  // offset `hessOffPair` (rather than the readbackPair). The
  // intermediate stages still ping-pong dotPairsA / dotPairsB; only
  // the *last* pair is copied into the Hessenberg buffer.
  function encodeDotToHessenberg(encoder, xHiBuf, xLoBuf, yHiBuf, yLoBuf, n, hessOffPair) {
    const finalBuf = encodeDotInternal(encoder, xHiBuf, xLoBuf, yHiBuf, yLoBuf, n);
    encodeCopyPair(encoder, finalBuf, 0, krylov.hessenberg, hessOffPair);
  }

  // Internal: same as encodeDot but does NOT copy the final pair to
  // the readbackPair. Returns the GPU buffer holding the final pair
  // (caller decides where to copy it).
  function encodeDotInternal(encoder, xHiBuf, xLoBuf, yHiBuf, yLoBuf, n) {
    let pairCount = Math.max(1, Math.ceil(n / WORKGROUP_SIZE));
    const firstParams = nextUniform();
    device.queue.writeBuffer(firstParams, 0, new Uint32Array([n, 0, 0, 0]));
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(dotReduceFirstPipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout: dotReduceFirstPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: xHiBuf } },
          { binding: 1, resource: { buffer: xLoBuf } },
          { binding: 2, resource: { buffer: yHiBuf } },
          { binding: 3, resource: { buffer: yLoBuf } },
          { binding: 4, resource: { buffer: buffers.dotPairsA } },
          { binding: 5, resource: { buffer: firstParams } }
        ]
      }));
      pass.dispatchWorkgroups(dispatchSize(pairCount));
      pass.end();
    }
    let inBuf = buffers.dotPairsA;
    let outBuf = buffers.dotPairsB;
    while (pairCount > 1) {
      const nextPairs = Math.max(1, Math.ceil(pairCount / WORKGROUP_SIZE));
      const stageParams = nextUniform();
      device.queue.writeBuffer(stageParams, 0, new Uint32Array([pairCount, 0, 0, 0]));
      const pass = encoder.beginComputePass();
      pass.setPipeline(dotReducePairsPipeline);
      pass.setBindGroup(0, device.createBindGroup({
        layout: dotReducePairsPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: inBuf } },
          { binding: 1, resource: { buffer: outBuf } },
          { binding: 2, resource: { buffer: stageParams } }
        ]
      }));
      pass.dispatchWorkgroups(dispatchSize(nextPairs));
      pass.end();
      const swap = inBuf; inBuf = outBuf; outBuf = swap;
      pairCount = nextPairs;
    }
    return inBuf;
  }

  // Read back the final 1-pair DS scalar from the dot reduction's
  // mappable buffer and combine to f64 on the CPU. Returns
  // `Number(hi) + Number(lo)` which is the f64 reconstruction of the
  // DS pair — same trick used by the CPU-f32 surrogate.
  async function readPair() {
    await buffers.readbackPair.mapAsync(GPUMapMode.READ);
    const arr = new Float32Array(buffers.readbackPair.getMappedRange().slice(0));
    buffers.readbackPair.unmap();
    return Number(arr[0]) + Number(arr[1]);
  }

  // Upload an f64 vector as a DS pair (hiBuffer, loBuffer). `hi` is
  // the f32 narrowing of each value; `lo` is the residual. Both are
  // f32 storage but together they reconstruct the f64 value exactly
  // (provided |v| < 2^150, which is the entire engineering range).
  function uploadDsVector(hiBuf, loBuf, source, label) {
    const len = source?.length || 0;
    const hi = new Float32Array(len);
    const lo = new Float32Array(len);
    for (let i = 0; i < len; i += 1) {
      const v = Number(source[i]);
      if (!Number.isFinite(v)) {
        throw new Error(
          `webgpu-backend.uploadDsVector(${label || 'vector'}): non-finite value at index ${i} (${v})`
        );
      }
      const h = Math.fround(v);
      const l = Math.fround(v - h);
      if (!Number.isFinite(h) || !Number.isFinite(l)) {
        throw new Error(
          `webgpu-backend.uploadDsVector(${label || 'vector'}): f64→f32 narrowing produced non-finite at index ${i} (|v|=${Math.abs(v).toExponential(3)})`
        );
      }
      hi[i] = h;
      lo[i] = l;
    }
    device.queue.writeBuffer(hiBuf, 0, hi);
    device.queue.writeBuffer(loBuf, 0, lo);
  }
  function uploadDsVec2Buffer(buf, source, label) {
    const len = source?.length || 0;
    const out = new Float32Array(len * 2);
    for (let i = 0; i < len; i += 1) {
      const v = Number(source[i]);
      if (!Number.isFinite(v)) {
        throw new Error(
          `webgpu-backend.uploadDsVec2Buffer(${label || 'vector'}): non-finite value at index ${i} (${v})`
        );
      }
      const h = Math.fround(v);
      const l = Math.fround(v - h);
      if (!Number.isFinite(h) || !Number.isFinite(l)) {
        throw new Error(
          `webgpu-backend.uploadDsVec2Buffer(${label || 'vector'}): f64→f32 narrowing produced non-finite at index ${i} (|v|=${Math.abs(v).toExponential(3)})`
        );
      }
      out[2 * i] = h;
      out[2 * i + 1] = l;
    }
    device.queue.writeBuffer(buf, 0, out);
  }
  function uploadInt32Buffer(buf, source) {
    device.queue.writeBuffer(buf, 0, source instanceof Int32Array ? source : new Int32Array(source || []));
  }
  function freeSchwarzBuffers() {
    const keys = [
      'schwarzPatchOffsets','schwarzLocalRows','schwarzInverseOffsets','schwarzInverseValues',
      'schwarzDofOffsets','schwarzDofEntries','schwarzDofWeights',
      'schwarzPatchSolHi','schwarzPatchSolLo','schwarzPatchParams','schwarzGatherParams'
    ];
    for (const key of keys) {
      disposeBuffer(buffers[key]);
      buffers[key] = null;
    }
    cachedSchwarzRef = null;
  }
  function ensureSchwarzBuffers(preconditioner, n) {
    if (preconditioner?.kind !== 'gpu-additive-schwarz-pou') return false;
    if (cachedSchwarzRef === preconditioner && buffers.schwarzPatchOffsets) return true;
    freeSchwarzBuffers();
    const patchCount = Math.max(Math.round(Number(preconditioner.patchCount) || 0), 0);
    const totalLocalRows = Math.max(Math.round(Number(preconditioner.totalLocalRows) || 0), 0);
    const totalInverseEntries = Math.max(Math.round(Number(preconditioner.totalInverseEntries) || 0), 0);
    if (!patchCount || !totalLocalRows || !totalInverseEntries || preconditioner.n !== n) return false;
    buffers.schwarzPatchOffsets = makeStorageBuffer((patchCount + 1) * 4, 'schwarz-patch-offsets');
    buffers.schwarzLocalRows = makeStorageBuffer(totalLocalRows * 4, 'schwarz-local-rows');
    buffers.schwarzInverseOffsets = makeStorageBuffer((patchCount + 1) * 4, 'schwarz-inverse-offsets');
    buffers.schwarzInverseValues = makeStorageBuffer(totalInverseEntries * 8, 'schwarz-inverse-values-ds');
    buffers.schwarzDofOffsets = makeStorageBuffer((n + 1) * 4, 'schwarz-dof-offsets');
    buffers.schwarzDofEntries = makeStorageBuffer((preconditioner.dofEntries?.length || 0) * 4, 'schwarz-dof-entries');
    buffers.schwarzDofWeights = makeStorageBuffer((preconditioner.dofWeights?.length || 0) * 8, 'schwarz-dof-weights-ds');
    buffers.schwarzPatchSolHi = makeStorageBuffer(totalLocalRows * 4, 'schwarz-patch-sol-hi');
    buffers.schwarzPatchSolLo = makeStorageBuffer(totalLocalRows * 4, 'schwarz-patch-sol-lo');
    buffers.schwarzPatchParams = makeUniformBuffer(16, 'schwarz-patch-params');
    buffers.schwarzGatherParams = makeUniformBuffer(16, 'schwarz-gather-params');

    uploadInt32Buffer(buffers.schwarzPatchOffsets, preconditioner.patchOffsets);
    uploadInt32Buffer(buffers.schwarzLocalRows, preconditioner.localRows);
    uploadInt32Buffer(buffers.schwarzInverseOffsets, preconditioner.inverseOffsets);
    uploadDsVec2Buffer(buffers.schwarzInverseValues, preconditioner.inverseValues, 'schwarz.inverseValues');
    uploadInt32Buffer(buffers.schwarzDofOffsets, preconditioner.dofOffsets);
    uploadInt32Buffer(buffers.schwarzDofEntries, preconditioner.dofEntries);
    uploadDsVec2Buffer(buffers.schwarzDofWeights, preconditioner.dofWeights, 'schwarz.dofWeights');
    device.queue.writeBuffer(buffers.schwarzPatchParams, 0, new Uint32Array([patchCount, 0, 0, 0]));
    device.queue.writeBuffer(buffers.schwarzGatherParams, 0, new Uint32Array([n, 0, 0, 0]));
    cachedSchwarzRef = preconditioner;
    return true;
  }
  function uploadZeroDsVector(hiBuf, loBuf, n) {
    const z = new Float32Array(n);
    device.queue.writeBuffer(hiBuf, 0, z);
    device.queue.writeBuffer(loBuf, 0, z);
  }
  function uploadFloat32StrictNoLo(buf, source, label) {
    const out = toFloat32Strict(source, label);
    device.queue.writeBuffer(buf, 0, out);
  }

  // -------------------------------------------------------------------
  // Resident preconditioned CG, full DS operator chain.
  //
  //   * Matrix is stored as DS pairs (valsHi, valsLo).
  //   * Vectors (rhs, x, r, z, p, ap) are DS pairs.
  //   * Per-element matvec accumulation is DS (twoProd + twoSum).
  //   * Dot products are DS reductions of DS products.
  //   * α and β are computed CPU-side from DS dot results and
  //     re-uploaded as DS pairs to the next axby.
  //   * True residual replacement: every TRUE_RESIDUAL_INTERVAL
  //     iterations we recompute r := b − K·x with the DS matvec so
  //     the recurrence-accumulated rounding error in r doesn't drift
  //     past tolerance unnoticed (the classical CG residual-drift
  //     fix).
  // -------------------------------------------------------------------
  const TRUE_RESIDUAL_INTERVAL = 25;

  async function solveCgPreconditionedWebgpu({
    rows,
    rhs,
    initial = null,
    preconditioner,
    maxIter,
    relTol,
    absTol,
    runControl,
    iterationObserver,
    residualRefreshIntervalForCheckpoint: _residualRefreshIntervalForCheckpoint,
    residentTrueResidualAcceptanceBand = 1.5,
    residentTrueResidualSkipRatio = 0.1
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
    ensureMatrixBuffers(rows);
    ensureVectorBuffers(n);

    // Upload RHS and initial guess as DS pairs so the entire operator
    // chain runs at DS precision from the very first matvec.
    uploadDsVector(buffers.rhsHi, buffers.rhsLo, rhs, 'rhs');
    if (initial && initial.length === n) {
      uploadDsVector(buffers.xHi, buffers.xLo, initial, 'initial');
    } else {
      uploadZeroDsVector(buffers.xHi, buffers.xLo, n);
    }
    if (preconditioner?.kind === 'gpu-additive-schwarz-pou') {
      if (!ensureSchwarzBuffers(preconditioner, n)) throw new Error('webgpu-resident-cg-invalid-schwarz-preconditioner');
    } else {
      uploadDsVec2Buffer(buffers.selfCoef, preconditioner.selfCoef, 'preconditioner.selfCoef');
      uploadDsVec2Buffer(buffers.prevCoef, preconditioner.prevCoef, 'preconditioner.prevCoef');
      uploadDsVec2Buffer(buffers.nextCoef, preconditioner.nextCoef, 'preconditioner.nextCoef');
    }

    // Compute ‖rhs‖ in f64 on CPU — single pass, off the hot path.
    let rhsNorm2 = 0;
    for (let i = 0; i < n; i += 1) rhsNorm2 += rhs[i] * rhs[i];
    const rhsNorm = Math.sqrt(rhsNorm2);
    const tolTarget = Math.max(absTol || 0, (relTol || 0) * rhsNorm);
    const trueResidualAcceptanceBand = Math.max(Number(residentTrueResidualAcceptanceBand) || 1.5, 1);
    const trueResidualSkipRatio = Math.min(Math.max(Number(residentTrueResidualSkipRatio) || 0.1, 0), 1);

    // Seed (encoder 1):
    //   ap = K · x   (DS matvec)
    //   r  = 1·rhs + (−1)·ap
    //   z  = M^{-1} · r
    //   p  = 1·z + 0·z
    //   readback ‖r‖² via DS dot
    {
      const enc = beginEncoder();
      encodeMatvec(enc, buffers.xHi, buffers.xLo, buffers.apHi, buffers.apLo, n);
      encodeAxby(enc,
        buffers.rhsHi, buffers.rhsLo,
        buffers.apHi,  buffers.apLo,
        buffers.rHi,   buffers.rLo,
        1, -1, n);
      encodePreconditioner(enc, preconditioner, buffers.rHi, buffers.rLo, buffers.zHi, buffers.zLo, n);
      encodeAxby(enc,
        buffers.zHi, buffers.zLo,
        buffers.zHi, buffers.zLo,
        buffers.pHi, buffers.pLo,
        1, 0, n);
      encodeDot(enc, buffers.rHi, buffers.rLo, buffers.rHi, buffers.rLo, n);
      device.queue.submit([enc.finish()]);
    }
    let rNorm2 = await readPair();
    let residualNorm = Math.sqrt(Math.max(rNorm2, 0));
    if (!Number.isFinite(residualNorm)) {
      throw new Error('webgpu-resident-cg-non-finite-seed-residual');
    }
    if (residualNorm <= tolTarget) {
      return await downloadSolution({
        n, converged: true, iterations: 0,
        residualNorm, rhsNorm, tolTarget,
        trueResidualNorm: residualNorm,
        recurrenceResidualNorm: residualNorm,
        usedTrueResidualAcceptance: true
      });
    }

    // Initial r·z (DS).
    {
      const enc = beginEncoder();
      encodeDot(enc, buffers.rHi, buffers.rLo, buffers.zHi, buffers.zLo, n);
      device.queue.submit([enc.finish()]);
    }
    let rzOld = await readPair();

    let iter = 0;
    let interrupted = false;
    for (iter = 1; iter <= maxIter; iter += 1) {
      if (await checkpointRunControl(runControl)) {
        interrupted = true;
        break;
      }
      // First half: ap = K·p ; denom = p · ap.
      {
        const enc = beginEncoder();
        encodeMatvec(enc, buffers.pHi, buffers.pLo, buffers.apHi, buffers.apLo, n);
        encodeDot(enc, buffers.pHi, buffers.pLo, buffers.apHi, buffers.apLo, n);
        device.queue.submit([enc.finish()]);
      }
      const denom = await readPair();
      if (!Number.isFinite(denom) || Math.abs(denom) < 1e-300) {
        // Negative or vanishing denominator → CG breakdown. Surface
        // the current x; the solver wrapper handles convergence
        // accounting.
        const trueResidualNorm = await computeTrueResidualNormFromCurrentX(n);
        return await downloadSolution({
          n, converged: trueResidualNorm <= tolTarget, iterations: iter,
          residualNorm: trueResidualNorm,
          rhsNorm,
          tolTarget,
          trueResidualNorm,
          recurrenceResidualNorm: residualNorm,
          usedTrueResidualAcceptance: true,
          fallbackReason: trueResidualNorm <= tolTarget
            ? ''
            : `resident-cg-breakdown:${residualNorm}->${trueResidualNorm}`
        });
      }
      const alpha = rzOld / denom;

      // Second half: x += α·p ; r -= α·ap.
      // Optionally refresh r := b − K·x every TRUE_RESIDUAL_INTERVAL
      // iterations (residual replacement). The recurrence-accumulated
      // r drifts at ~ε·κ(K)·iter and can over-estimate convergence
      // on tight Newton tolerances; the true residual recompute is
      // the standard mitigation. The recompute is itself a DS matvec
      // → DS axby chain, so it costs one extra matvec per refresh
      // window (≈ 4% overhead at TRUE_RESIDUAL_INTERVAL=25).
      const doTrueResidual = iter > 0 && iter % TRUE_RESIDUAL_INTERVAL === 0;
      {
        const enc = beginEncoder();
        encodeAxby(enc,
          buffers.xHi, buffers.xLo,
          buffers.pHi, buffers.pLo,
          buffers.xHi, buffers.xLo,
          1, alpha, n);
        if (doTrueResidual) {
          // ap = K · x_new (refHi/Lo holds K·x for the refresh).
          encodeMatvec(enc, buffers.xHi, buffers.xLo, buffers.refHi, buffers.refLo, n);
          // r = 1·rhs + (−1)·(K·x_new)
          encodeAxby(enc,
            buffers.rhsHi, buffers.rhsLo,
            buffers.refHi, buffers.refLo,
            buffers.rHi,   buffers.rLo,
            1, -1, n);
        } else {
          // r = 1·r + (−α)·ap   (cheap recurrence update)
          encodeAxby(enc,
            buffers.rHi,  buffers.rLo,
            buffers.apHi, buffers.apLo,
            buffers.rHi,  buffers.rLo,
            1, -alpha, n);
        }
        encodeDot(enc, buffers.rHi, buffers.rLo, buffers.rHi, buffers.rLo, n);
        device.queue.submit([enc.finish()]);
      }
      rNorm2 = await readPair();
      residualNorm = Math.sqrt(Math.max(rNorm2, 0));

      if (!Number.isFinite(residualNorm)) {
        throw new Error(`webgpu-resident-cg-non-finite-residual:iter=${iter}`);
      }

      if (iterationObserver && (iter === 1 || iter % 25 === 0)) {
        await iterationObserver({
          iterations: iter,
          residualNorm,
          relativeResidual: rhsNorm > 1e-30 ? residualNorm / rhsNorm : 0,
          rhsNorm,
          toleranceTarget: tolTarget
        });
      }
      if (residualNorm <= tolTarget) {
        return await downloadWithTrueResidualAcceptance({
          n,
          iterations: iter,
          recurrenceResidualNorm: residualNorm,
          rhsNorm,
          tolTarget,
          solverLabel: 'resident-cg'
        });
      }

      // Third half: z = M^{-1}·r ; rzNew = r · z.
      {
        const enc = beginEncoder();
        encodePreconditioner(enc, preconditioner, buffers.rHi, buffers.rLo, buffers.zHi, buffers.zLo, n);
        encodeDot(enc, buffers.rHi, buffers.rLo, buffers.zHi, buffers.zLo, n);
        device.queue.submit([enc.finish()]);
      }
      const rzNew = await readPair();
      const beta = Math.abs(rzOld) > 1e-300 ? rzNew / rzOld : 0;

      // Fourth half: p = z + β·p.
      {
        const enc = beginEncoder();
        encodeAxby(enc,
          buffers.zHi, buffers.zLo,
          buffers.pHi, buffers.pLo,
          buffers.pHi, buffers.pLo,
          1, beta, n);
        device.queue.submit([enc.finish()]);
      }
      rzOld = rzNew;
    }
    const trueResidualNorm = await computeTrueResidualNormFromCurrentX(n);
    return await downloadSolution({
      n,
      converged: trueResidualNorm <= tolTarget,
      iterations: interrupted ? iter : maxIter,
      residualNorm: trueResidualNorm,
      rhsNorm,
      tolTarget,
      interrupted,
      trueResidualNorm,
      recurrenceResidualNorm: residualNorm,
      usedTrueResidualAcceptance: true,
      fallbackReason: trueResidualNorm <= tolTarget
        ? ''
        : `resident-cg-not-converged:${residualNorm}->${trueResidualNorm}`
    });
  }

  async function computeTrueResidualNormFromCurrentX(n) {
    const enc = beginEncoder();
    encodeMatvec(enc, buffers.xHi, buffers.xLo, buffers.refHi, buffers.refLo, n);
    encodeAxby(enc,
      buffers.rhsHi, buffers.rhsLo,
      buffers.refHi, buffers.refLo,
      buffers.rHi, buffers.rLo,
      1, -1, n);
    encodeDot(enc, buffers.rHi, buffers.rLo, buffers.rHi, buffers.rLo, n);
    device.queue.submit([enc.finish()]);
    const rNorm2 = await readPair();
    const residualNorm = Math.sqrt(Math.max(rNorm2, 0));
    if (!Number.isFinite(residualNorm)) {
      throw new Error('webgpu-true-residual-non-finite');
    }
    return residualNorm;
  }

  async function downloadWithTrueResidualAcceptance({
    n,
    iterations,
    rhsNorm,
    tolTarget,
    recurrenceResidualNorm,
    solverLabel
  }) {
    if (recurrenceResidualNorm <= trueResidualSkipRatio * tolTarget) {
      return await downloadSolution({
        n,
        converged: true,
        iterations,
        residualNorm: recurrenceResidualNorm,
        rhsNorm,
        tolTarget,
        trueResidualNorm: recurrenceResidualNorm,
        recurrenceResidualNorm,
        usedTrueResidualAcceptance: false,
        trueResidualSkipped: true,
        fallbackReason: ''
      });
    }
    const trueResidualNorm = await computeTrueResidualNormFromCurrentX(n);
    const trueResidualBandFactor = trueResidualNorm / Math.max(tolTarget, 1e-30);
    const converged = trueResidualNorm <= trueResidualAcceptanceBand * tolTarget;
    return await downloadSolution({
      n,
      converged,
      iterations,
      residualNorm: trueResidualNorm,
      rhsNorm,
      tolTarget,
      trueResidualNorm,
      recurrenceResidualNorm,
      usedTrueResidualAcceptance: true,
      acceptedInTrueResidualBand: converged && trueResidualNorm > tolTarget,
      trueResidualBandFactor,
      fallbackReason: converged
        ? ''
        : `${solverLabel}-true-residual-mismatch:${recurrenceResidualNorm}->${trueResidualNorm}`
    });
  }

  async function downloadSolution({
    n,
    converged,
    iterations,
    residualNorm,
    rhsNorm,
    tolTarget,
    interrupted = false,
    trueResidualNorm = null,
    recurrenceResidualNorm = null,
    usedTrueResidualAcceptance = false,
    acceptedInTrueResidualBand = false,
    trueResidualBandFactor = null,
    trueResidualSkipped = false,
    fallbackReason = ''
  }) {
    // Copy xHi and xLo into mappable buffers, then combine to f64.
    // The DS combination `Number(hi) + Number(lo)` reconstructs the
    // full DS precision in f64 — exactly the inverse of the (hi, lo)
    // split used during upload.
    const stagingSize = n * 4;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(buffers.xHi, 0, buffers.readbackVecHi, 0, stagingSize);
    enc.copyBufferToBuffer(buffers.xLo, 0, buffers.readbackVecLo, 0, stagingSize);
    device.queue.submit([enc.finish()]);
    await Promise.all([
      buffers.readbackVecHi.mapAsync(GPUMapMode.READ),
      buffers.readbackVecLo.mapAsync(GPUMapMode.READ)
    ]);
    const hi = new Float32Array(buffers.readbackVecHi.getMappedRange().slice(0));
    const lo = new Float32Array(buffers.readbackVecLo.getMappedRange().slice(0));
    buffers.readbackVecHi.unmap();
    buffers.readbackVecLo.unmap();

    const solution = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      solution[i] = Number(hi[i]) + Number(lo[i]);
    }
    return {
      solution,
      converged,
      iterations,
      residualNorm,
      relativeResidual: rhsNorm > 1e-30 ? residualNorm / rhsNorm : 0,
      rhsNorm,
      toleranceTarget: tolTarget,
      interrupted,
      trueResidualNorm: Number.isFinite(trueResidualNorm) ? trueResidualNorm : residualNorm,
      recurrenceResidualNorm: Number.isFinite(recurrenceResidualNorm) ? recurrenceResidualNorm : residualNorm,
      usedTrueResidualAcceptance: usedTrueResidualAcceptance === true,
      acceptedInTrueResidualBand: acceptedInTrueResidualBand === true,
      trueResidualBandFactor: Number.isFinite(Number(trueResidualBandFactor)) ? Number(trueResidualBandFactor) : null,
      trueResidualSkipped: trueResidualSkipped === true,
      fallbackReason: fallbackReason || ''
    };
  }

  // -------------------------------------------------------------------
  // Resident preconditioned FGMRES, full DS operator chain.
  //
  // Restarted GMRES with a flexible (varying) preconditioner. Used by
  // the unsymmetric / plastic / c-phi paths where CG breaks down.
  //
  //   * Krylov basis V[0..m] and preconditioned vectors Z[0..m-1]
  //     live in their own GPU buffer pairs (DS hi + lo).
  //   * Hessenberg matrix H is a single GPU storage buffer of DS
  //     pairs in row-major (h[i, j] at offset 2·(i·m + j)). Modified
  //     Gram-Schmidt writes h[i, j] directly to GPU storage and the
  //     next axby reads it back from there — no CPU↔GPU round-trip
  //     within an inner iteration.
  //   * After each inner iteration we readback the new column of H
  //     plus the norm scalar, apply Givens rotations on the CPU, and
  //     update the rotated rhs s. Per inner iter: 4 submits + 2
  //     readbacks (norm + H column).
  //   * After a restart cycle (or convergence) we solve the small
  //     upper-triangular Hessenberg system on CPU, then update x on
  //     the GPU as x = x_0 + Σ y_i · Z[i] (sequential axby chain in
  //     one encoder).
  //   * True residual replacement at every restart: r := b − K · x_new.
  //
  // The MGS variant is used (modified Gram-Schmidt) — slightly more
  // numerically stable than CGS for ill-conditioned problems and the
  // GPU-resident scalar pattern doesn't need CGS's batched dots.
  // -------------------------------------------------------------------
  async function solveGmresPreconditionedWebgpu({
    rows,
    rhs,
    initial = null,
    preconditioner,
    maxIter,
    relTol,
    absTol,
    runControl,
    iterationObserver,
    restart = 30
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
    const m = Math.max(4, Math.min(Math.round(restart) || 30, 60));
    ensureMatrixBuffers(rows);
    ensureVectorBuffers(n);
    ensureKrylovBuffers(n, m);

    // Initial uploads (rhs / x0 / preconditioner). The rhs is also
    // copied into rhsHi/rhsLo for the true-residual recompute path.
    uploadDsVector(buffers.rhsHi, buffers.rhsLo, rhs, 'gmres.rhs');
    if (initial && initial.length === n) {
      uploadDsVector(buffers.xHi, buffers.xLo, initial, 'gmres.initial');
    } else {
      uploadZeroDsVector(buffers.xHi, buffers.xLo, n);
    }
    if (preconditioner?.kind === 'gpu-additive-schwarz-pou') {
      if (!ensureSchwarzBuffers(preconditioner, n)) throw new Error('webgpu-resident-gmres-invalid-schwarz-preconditioner');
    } else {
      uploadDsVec2Buffer(buffers.selfCoef, preconditioner.selfCoef, 'preconditioner.selfCoef');
      uploadDsVec2Buffer(buffers.prevCoef, preconditioner.prevCoef, 'preconditioner.prevCoef');
      uploadDsVec2Buffer(buffers.nextCoef, preconditioner.nextCoef, 'preconditioner.nextCoef');
    }

    let rhsNorm2 = 0;
    for (let i = 0; i < n; i += 1) rhsNorm2 += rhs[i] * rhs[i];
    const rhsNorm = Math.sqrt(rhsNorm2);
    const tolTarget = Math.max(absTol || 0, (relTol || 0) * rhsNorm);

    // CPU mirrors: H column staging, Givens scalars, rotated rhs s.
    const hessF32 = new Float32Array(2 * m * (m + 1));
    const hCpu = new Float64Array(m * (m + 1)); // row-major, (m+1) × m
    const cs = new Float64Array(m);
    const ss = new Float64Array(m);
    const sVec = new Float64Array(m + 1);

    let totalIterations = 0;
    let interrupted = false;
    let lastResidualNorm = Infinity;

    for (let outer = 0; outer < maxIter; outer += 1) {
      if (await checkpointRunControl(runControl)) {
        interrupted = true;
        break;
      }

      // Compute true residual r = b − K · x and seed V[0] = r / β.
      // Reuse pHi/pLo as a working "ap = K x" scratch.
      let beta;
      {
        const enc = beginEncoder();
        encodeMatvec(enc, buffers.xHi, buffers.xLo, buffers.apHi, buffers.apLo, n);
        encodeAxby(enc,
          buffers.rhsHi, buffers.rhsLo,
          buffers.apHi,  buffers.apLo,
          buffers.rHi,   buffers.rLo,
          1, -1, n);
        encodeDot(enc, buffers.rHi, buffers.rLo, buffers.rHi, buffers.rLo, n);
        device.queue.submit([enc.finish()]);
      }
      const rNorm2 = await readPair();
      beta = Math.sqrt(Math.max(rNorm2, 0));
      lastResidualNorm = beta;

      if (!Number.isFinite(beta)) {
        throw new Error(`webgpu-resident-gmres-non-finite-seed-residual:outer=${outer}`);
      }
      if (beta <= tolTarget) {
        return await downloadSolution({
          n, converged: true, iterations: totalIterations,
          residualNorm: beta, rhsNorm, tolTarget,
          trueResidualNorm: beta,
          recurrenceResidualNorm: beta,
          usedTrueResidualAcceptance: true
        });
      }

      // V[0] = r / β.
      {
        const enc = beginEncoder();
        encodeAxby(enc,
          buffers.rHi, buffers.rLo,
          buffers.rHi, buffers.rLo,
          krylov.V[0].hi, krylov.V[0].lo,
          1 / beta, 0, n);
        device.queue.submit([enc.finish()]);
      }

      sVec.fill(0);
      sVec[0] = beta;

      let solvedThisRestart = false;
      let inner = 0;
      for (let j = 0; j < m; j += 1) {
        if (await checkpointRunControl(runControl)) {
          interrupted = true;
          break;
        }
        totalIterations += 1;
        inner = j + 1;

        // (a) Z[j] = M^{-1} V[j]; w = K Z[j]; then j+1 MGS steps —
        // each writes h[i, j] to the Hessenberg buffer (no CPU
        // readback) and the next dispatch subtracts h[i, j]·V[i]
        // from w in place. Final dispatch: ‖w‖² → readback.
        {
          const enc = beginEncoder();
          encodePreconditioner(enc, preconditioner,
            krylov.V[j].hi, krylov.V[j].lo,
            krylov.Z[j].hi, krylov.Z[j].lo, n);
          encodeMatvec(enc,
            krylov.Z[j].hi, krylov.Z[j].lo,
            krylov.wHi, krylov.wLo, n);
          for (let i = 0; i <= j; i += 1) {
            // h[i, j] = <w, V[i]>
            encodeDotToHessenberg(enc,
              krylov.wHi, krylov.wLo,
              krylov.V[i].hi, krylov.V[i].lo,
              n,
              i * m + j);
            // w := w − h[i, j] · V[i]
            encodeAxbyHessNeg(enc,
              krylov.V[i].hi, krylov.V[i].lo,
              krylov.wHi, krylov.wLo,
              i * m + j, n);
          }
          // ‖w‖² → readbackPair
          encodeDot(enc, krylov.wHi, krylov.wLo, krylov.wHi, krylov.wLo, n);
          device.queue.submit([enc.finish()]);
        }
        const wNorm2 = await readPair();
        const hNext = Math.sqrt(Math.max(wNorm2, 0));
        if (!Number.isFinite(hNext)) {
          throw new Error(`webgpu-resident-gmres-non-finite-h-next:outer=${outer},j=${j}`);
        }

        // Readback the new column of H to apply Givens on CPU. Bytes
        // 0..(j+1) DS pairs of column j are the relevant entries; we
        // read the whole H buffer (small) for simplicity.
        {
          const enc = device.createCommandEncoder();
          enc.copyBufferToBuffer(krylov.hessenberg, 0,
            krylov.hessenbergStaging, 0,
            krylov.hessenbergStagingBytes);
          device.queue.submit([enc.finish()]);
        }
        await krylov.hessenbergStaging.mapAsync(GPUMapMode.READ);
        const hessView = new Float32Array(krylov.hessenbergStaging.getMappedRange().slice(0));
        krylov.hessenbergStaging.unmap();
        for (let i = 0; i <= j; i += 1) {
          const offset = (i * m + j) * 2;
          hCpu[i * m + j] = Number(hessView[offset]) + Number(hessView[offset + 1]);
        }
        // h[j+1, j] = hNext (the f64-reconstructed norm).
        // Stored in row-major H mirror; not yet on the GPU buffer
        // (not needed since axby_hess_neg only reads i ≤ j entries).
        const hJplus1J = hNext;

        // Apply previously-computed Givens rotations to column j.
        for (let i = 0; i < j; i += 1) {
          const ti = cs[i] * hCpu[i * m + j] + ss[i] * hCpu[(i + 1) * m + j];
          hCpu[(i + 1) * m + j] = -ss[i] * hCpu[i * m + j] + cs[i] * hCpu[(i + 1) * m + j];
          hCpu[i * m + j] = ti;
        }
        // Compute new Givens to zero H[j+1, j].
        const Hjj = hCpu[j * m + j];
        const denom = Math.hypot(Hjj, hJplus1J);
        const cj = denom > 1e-300 ? Hjj / denom : 1;
        const sj = denom > 1e-300 ? hJplus1J / denom : 0;
        cs[j] = cj;
        ss[j] = sj;
        hCpu[j * m + j] = cj * Hjj + sj * hJplus1J;

        // Apply rotation to the rotated-rhs vector s.
        const sJ = sVec[j];
        sVec[j] = cj * sJ;
        sVec[j + 1] = -sj * sJ;
        const approxResidual = Math.abs(sVec[j + 1]);
        lastResidualNorm = approxResidual;

        if (iterationObserver && (totalIterations === 1 || totalIterations % 25 === 0)) {
          await iterationObserver({
            iterations: totalIterations,
            residualNorm: approxResidual,
            relativeResidual: rhsNorm > 1e-30 ? approxResidual / rhsNorm : 0,
            rhsNorm,
            toleranceTarget: tolTarget
          });
        }

        if (approxResidual <= tolTarget) {
          solvedThisRestart = true;
          inner = j + 1;
          break;
        }

        // Lucky breakdown — h[j+1, j] is small enough that V[j+1] is
        // effectively undefined; surrender and let the outer loop
        // recompute the residual.
        if (hJplus1J <= 1e-300) {
          inner = j + 1;
          break;
        }

        // V[j+1] = w / h[j+1, j].
        {
          const enc = beginEncoder();
          encodeAxby(enc,
            krylov.wHi, krylov.wLo,
            krylov.wHi, krylov.wLo,
            krylov.V[j + 1].hi, krylov.V[j + 1].lo,
            1 / hJplus1J, 0, n);
          device.queue.submit([enc.finish()]);
        }
      }

      // Solve H[0:k, 0:k] · y = s[0:k] (upper triangular after Givens).
      const k = inner;
      const y = new Float64Array(k);
      for (let i = k - 1; i >= 0; i -= 1) {
        let acc = sVec[i];
        for (let jj = i + 1; jj < k; jj += 1) {
          acc -= hCpu[i * m + jj] * y[jj];
        }
        const diag = hCpu[i * m + i];
        y[i] = Math.abs(diag) > 1e-300 ? acc / diag : 0;
      }

      // Update x = x + Σ_{i=0..k-1} y_i · Z[i].  Sequential axby
      // chain in one encoder (no CPU sync between additions).
      {
        const enc = beginEncoder();
        for (let i = 0; i < k; i += 1) {
          encodeAxby(enc,
            buffers.xHi, buffers.xLo,
            krylov.Z[i].hi, krylov.Z[i].lo,
            buffers.xHi, buffers.xLo,
            1, y[i], n);
        }
        device.queue.submit([enc.finish()]);
      }

      if (solvedThisRestart) {
        return await downloadWithTrueResidualAcceptance({
          n,
          iterations: totalIterations,
          recurrenceResidualNorm: lastResidualNorm,
          rhsNorm,
          tolTarget,
          solverLabel: 'resident-fgmres'
        });
      }

      if (totalIterations >= maxIter) break;
    }

    const trueResidualNorm = await computeTrueResidualNormFromCurrentX(n);
    return await downloadSolution({
      n,
      converged: trueResidualNorm <= tolTarget,
      iterations: totalIterations,
      residualNorm: trueResidualNorm,
      rhsNorm,
      tolTarget,
      interrupted,
      trueResidualNorm,
      recurrenceResidualNorm: lastResidualNorm,
      usedTrueResidualAcceptance: true,
      fallbackReason: trueResidualNorm <= tolTarget
        ? ''
        : `resident-fgmres-not-converged:${lastResidualNorm}->${trueResidualNorm}`
    });
  }

  // Convert an f64 array to f32 storage, FAILING LOUDLY on non-finite
  // input or on overflow during the narrow. Silent zero-coercion is
  // catastrophic in engineering-critical workflows (c-phi reduction,
  // plastic geostatic, T6 slopes): a single NaN in a residual that
  // gets quietly masked into 0 looks like convergence to a feasible
  // state and silently corrupts the run record.
  //
  // The throw flows up through `solveCgPreconditionedWebgpu` → the
  // solver wrapper's catch → CPU f64 fallback for that single solve.
  // The user sees a console warning naming the bad index and value;
  // the run still completes (correctly, on CPU); and the GPU stays
  // live for every other call in the batch.
  function toFloat32Strict(source, label) {
    const n = source?.length || 0;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const v = Number(source[i]);
      if (!Number.isFinite(v)) {
        throw new Error(
          `webgpu-backend.${label || 'vector'}: non-finite value at index ${i} (${v}); refusing silent zero-coercion`
        );
      }
      out[i] = v;
      // f64 → f32 narrowing can produce ±Infinity if |v| > 3.4e38.
      // That is also a hard error in engineering-critical mode.
      if (!Number.isFinite(out[i])) {
        throw new Error(
          `webgpu-backend.${label || 'vector'}: f64→f32 overflow at index ${i} (|v|=${Math.abs(v).toExponential(3)} > f32 max ${Number.MAX_VALUE.toExponential(3)})`
        );
      }
    }
    return out;
  }
  // Back-compat alias so existing call sites keep working until the
  // surrounding code has migrated to pass meaningful labels.
  function toFiniteFloat32(source) { return toFloat32Strict(source, 'vector'); }

  // Async DS matvec for the hybrid / fallback path. Used by every
  // solver that doesn't yet run resident on the GPU (CPU CG fallback,
  // GMRES, BiCGStab, periodic residual refresh). Returns a
  // `Promise<Float64Array>` whose entries are the f64 reconstruction
  // of the GPU-computed DS pair (apHi + apLo). Internally the matvec
  // is fully DS — same matrix storage and same WGSL kernel as the
  // resident CG — so even the "hybrid" solvers see f64-equivalent
  // matvec precision when WebGPU is active.
  //
  // Uses the persistent readbackVecHi / readbackVecLo staging buffers
  // — no per-call allocation. The buffers are unmapped before this
  // function returns, so back-to-back matvecs reuse them safely.
  async function matvec(rows, vector) {
    if (!rows.length) return new Float64Array(0);
    ensureMatrixBuffers(rows);
    ensureVectorBuffers(rows.length);
    uploadDsVector(buffers.xHi, buffers.xLo, vector, 'matvec.x');
    const stagingSize = rows.length * 4;
    const enc = beginEncoder();
    encodeMatvec(enc, buffers.xHi, buffers.xLo, buffers.apHi, buffers.apLo, rows.length);
    enc.copyBufferToBuffer(buffers.apHi, 0, buffers.readbackVecHi, 0, stagingSize);
    enc.copyBufferToBuffer(buffers.apLo, 0, buffers.readbackVecLo, 0, stagingSize);
    device.queue.submit([enc.finish()]);
    await Promise.all([
      buffers.readbackVecHi.mapAsync(GPUMapMode.READ),
      buffers.readbackVecLo.mapAsync(GPUMapMode.READ)
    ]);
    const hi = new Float32Array(buffers.readbackVecHi.getMappedRange().slice(0));
    const lo = new Float32Array(buffers.readbackVecLo.getMappedRange().slice(0));
    buffers.readbackVecHi.unmap();
    buffers.readbackVecLo.unmap();
    const out = new Float64Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
      out[i] = Number(hi[i]) + Number(lo[i]);
    }
    return out;
  }

  function dispose() {
    freeAll();
    if (typeof device.destroy === 'function') {
      try { device.destroy(); } catch { /* ignore */ }
    }
  }

  // Honest capability schema. The resident WebGPU linear-algebra chain
  // is double-single, but this backend is still experimental until it
  // passes the formal deformation certification sweep against CPU f64.
  // Resident GPU Krylov therefore stays explicit opt-in for
  // engineering-critical runs.
  return {
    backend: {
      get name() { return 'webgpu-ds'; },
      get precision() { return 'double-single'; },

      // Per-operation precision (Round 1: every linear-algebra
      // primitive in the resident chain is DS).
      vectorPrecision: 'double-single',
      matrixPrecision: 'double-single',
      matvecPrecision: 'double-single',
      dotPrecision: 'double-single',
      axbyPrecision: 'double-single',
      residualPrecision: 'double-single',
      // Element kernels and material updates are still on CPU in
      // Round 1; Round 2 of this branch moves them to WGSL.
      elementKernelPrecision: null,
      materialUpdatePrecision: null,
      highestPrecisionMode: 'double-single',

      // Resident-solver certification flags. Each flips to `true`
      // ONLY when the corresponding solver passes the engineering
      // test sweep against CPU f64. Until certified, the dispatcher
      // requires explicit opt-in.
      residentCgCertified: false,
      residentGmresCertified: false,
      residentSchwarzCertified: false,
      residentBicgstabCertified: false,

      // Legacy aggregates (kept for consumers not yet migrated to
      // the explicit per-op precision flags).
      supportsDoubleSingle: true,
      hasDsGradeDot: true,
      supportsElementKernels: false,
      supportsT3ElementKernels: false,
      supportsT6ElementKernels: false,
      supportsResidentCg: true,
      supportsResidentGmres: true,
      supportsResidentSchwarz: true,
      capabilities: {
        residentCg: true,
        residentGmres: true,
        residentBicgstab: false,
        residentSchwarz: true,
        t3ElementKernels: false,
        t6ElementKernels: false,
        nonlinearAssembly: false,
        materialKernels: false,
        trueResidualOnGpu: true,
        supportsCancellation: true
      },
      certification: {
        residentCg: 'none',
        residentGmres: 'none',
        residentSchwarz: 'none',
        nonlinearAssembly: 'none',
        mcMaterial: 'none'
      },
      // The DS matvec captures rounding-error compensation in `lo`,
      // so the recurrence-accumulated residual has DS precision.
      // The resident CG also performs a true residual replacement
      // every 25 iterations, so an explicit CPU residual refresh is
      // not required. Hybrid-path matvec also returns DS-precision
      // results (`hi + lo` reconstruction), so the CPU CG / GMRES /
      // BiCGStab fallbacks see f64-equivalent matvec values.
      requiresResidualRefresh: false,
      get precisionMode() { return 'double-single'; },
      get residualRefreshInterval() { return 0; },
      get matrixMaxAbsValue() { return cachedHostMatrix?.maxAbsValue ?? 0; },
      get matrixMaxRowLen() { return cachedShape?.maxRowLen || 0; },
      matvec,
      solveCgPreconditionedGpu: solveCgPreconditionedWebgpu,
      solveGmresPreconditionedGpu: solveGmresPreconditionedWebgpu,
      setPrecisionMode: () => 'double-single',
      setResidualRefreshInterval: () => 0,
      dispose
    },
    reason: '',
    maxTextureSize: 0
  };
}
