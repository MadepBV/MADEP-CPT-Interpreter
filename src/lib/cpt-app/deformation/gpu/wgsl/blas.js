// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// DS BLAS kernels (WGSL).
// ============================================================================
//
// Each kernel is a self-contained WGSL compute shader that operates on the
// resident DS buffers defined in `resident-buffers.js`.  All arithmetic is
// in software-double-single (f64-equivalent precision).
//
// Workgroup size: 64 threads.  This is the WebGPU sweet spot — large enough
// to amortise scheduler overhead, small enough that the per-workgroup shared
// memory footprint stays well below the 16 KB minimum guaranteed by the
// spec.
//
// Reductions (dot product, norm) use a two-pass parallel reduction:
//   Pass 1:  per-workgroup partial sum into a partials buffer
//                                of length numWorkgroups.
//   Pass 2:  tree reduction of partials into a single DS scalar.
// Both passes use compensated DS sums so the final value is faithful to
// f64 precision regardless of workgroup count.
//
// CSR matvec: one thread per row.  Each thread reads `rowPtr[i]..rowPtr[i+1]`
// nonzeros, accumulates `y[i] = Σ_k val[k] * x[col[k]]` in a DS register,
// and writes once to `y`.  Bandwidth is the limiting factor on this kernel,
// not arithmetic; DS just doubles the per-coefficient byte count.

import { DS_WGSL } from './ds.js';

// -----------------------------------------------------------------------------
// AXPY:  y = alpha * x + y    where alpha is a DS scalar, x and y DS vectors.
// -----------------------------------------------------------------------------
export const KERNEL_AXPY_WGSL = /* wgsl */ `
${DS_WGSL}

struct AxpyParams {
  alpha: vec2<f32>,   // DS scalar
  n: u32,             // vector length
  _pad: vec3<u32>     // align to 16 B
};

@group(0) @binding(0) var<storage, read>       x: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> y: array<vec2<f32>>;
@group(0) @binding(2) var<uniform>             params: AxpyParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  if (i >= params.n) { return; }
  let xi: vec2<f32> = x[i];
  let yi: vec2<f32> = y[i];
  let ax: vec2<f32> = dsMul(params.alpha, xi);
  y[i] = dsAdd(ax, yi);
}
`;

// -----------------------------------------------------------------------------
// AXPBY:  y = alpha * x + beta * y    (fused; saves one vector pass for CG).
// -----------------------------------------------------------------------------
export const KERNEL_AXPBY_WGSL = /* wgsl */ `
${DS_WGSL}

struct AxpbyParams {
  alpha: vec2<f32>,
  beta:  vec2<f32>,
  n: u32,
  _pad: vec3<u32>
};

@group(0) @binding(0) var<storage, read>       x: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> y: array<vec2<f32>>;
@group(0) @binding(2) var<uniform>             params: AxpbyParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  if (i >= params.n) { return; }
  let xi: vec2<f32> = x[i];
  let yi: vec2<f32> = y[i];
  let ax: vec2<f32> = dsMul(params.alpha, xi);
  let by: vec2<f32> = dsMul(params.beta,  yi);
  y[i] = dsAdd(ax, by);
}
`;

// -----------------------------------------------------------------------------
// SCALE:  y = alpha * y      (in-place; used for line-search displacement).
// -----------------------------------------------------------------------------
export const KERNEL_SCALE_WGSL = /* wgsl */ `
${DS_WGSL}

struct ScaleParams {
  alpha: vec2<f32>,
  n: u32,
  _pad: vec3<u32>
};

@group(0) @binding(0) var<storage, read_write> y: array<vec2<f32>>;
@group(0) @binding(1) var<uniform>             params: ScaleParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  if (i >= params.n) { return; }
  let yi: vec2<f32> = y[i];
  y[i] = dsMul(params.alpha, yi);
}
`;

// -----------------------------------------------------------------------------
// COPY:  y = x.  Trivial; provided so the runtime can swap CG search vectors
// without launching a memset-and-axpby sequence.
// -----------------------------------------------------------------------------
export const KERNEL_COPY_WGSL = /* wgsl */ `
struct CopyParams { n: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       x: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> y: array<vec2<f32>>;
@group(0) @binding(2) var<uniform>             params: CopyParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  if (i >= params.n) { return; }
  y[i] = x[i];
}
`;

// -----------------------------------------------------------------------------
// DOT pass 1: per-workgroup partial sum of x · y.
//
// Each thread computes one DS-MUL (x[i] · y[i]), then the workgroup reduces
// to a single DS scalar via a tree reduction in shared memory using
// compensated DS sums.  Produces one DS pair per workgroup, written to
// `partials[wgIdx]`.
// -----------------------------------------------------------------------------
export const KERNEL_DOT_PASS1_WGSL = /* wgsl */ `
${DS_WGSL}

struct DotParams { n: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       x: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       y: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> partials: array<vec2<f32>>;
@group(0) @binding(3) var<uniform>             params: DotParams;

var<workgroup> shared_acc: array<vec2<f32>, 64>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>,
        @builtin(local_invocation_id)  lid: vec3<u32>,
        @builtin(workgroup_id)         wid: vec3<u32>) {
  let i: u32 = gid.x;
  let li: u32 = lid.x;
  var partial: vec2<f32> = vec2<f32>(0.0, 0.0);
  if (i < params.n) {
    partial = dsMul(x[i], y[i]);
  }
  shared_acc[li] = partial;
  workgroupBarrier();

  // Tree reduction in shared memory.
  for (var stride: u32 = 32u; stride > 0u; stride = stride >> 1u) {
    if (li < stride) {
      shared_acc[li] = dsAdd(shared_acc[li], shared_acc[li + stride]);
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    partials[wid.x] = shared_acc[0];
  }
}
`;

// -----------------------------------------------------------------------------
// DOT pass 2: tree-reduce the per-workgroup partials into a single DS scalar.
//
// Implemented as a compensated linear scan because the partials buffer is
// at most O(n / 64) entries — for n = 1 M, that's ~16 K entries, and a linear
// DS scan is O(n / 64) DS-adds, each ~6 f32 ops.  Total: 96 K f32 ops.
// One workgroup of 64 threads cooperatively processes the partials in
// chunks of 64, accumulating into the workgroup's shared register, then
// reduces that register to the single output slot.
// -----------------------------------------------------------------------------
export const KERNEL_DOT_PASS2_WGSL = /* wgsl */ `
${DS_WGSL}

struct DotPass2Params { numPartials: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       partials: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> result: array<vec2<f32>>;
@group(0) @binding(2) var<uniform>             params: DotPass2Params;

var<workgroup> shared_red: array<vec2<f32>, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>) {
  let li: u32 = lid.x;
  var acc: vec2<f32> = vec2<f32>(0.0, 0.0);
  // Strided accumulation: thread li walks every 64th entry.
  var idx: u32 = li;
  loop {
    if (idx >= params.numPartials) { break; }
    acc = dsAdd(acc, partials[idx]);
    idx = idx + 64u;
  }
  shared_red[li] = acc;
  workgroupBarrier();
  for (var stride: u32 = 32u; stride > 0u; stride = stride >> 1u) {
    if (li < stride) {
      shared_red[li] = dsAdd(shared_red[li], shared_red[li + stride]);
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    result[0] = shared_red[0];
  }
}
`;

// -----------------------------------------------------------------------------
// CSR matvec:  y = A * x  for a DS-CSR matrix.  One thread per row.
//
// Bandwidth bound (3 × 4 B per nonzero: rowPtr / colInd / DS values), so the
// kernel stays simple: each thread issues `rowLen` reads of (col, valHi,
// valLo, x[col]) and one accumulation pass.
// -----------------------------------------------------------------------------
export const KERNEL_CSR_MATVEC_WGSL = /* wgsl */ `
${DS_WGSL}

struct CsrParams { N: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       rowPtr: array<u32>;
@group(0) @binding(1) var<storage, read>       colInd: array<u32>;
@group(0) @binding(2) var<storage, read>       valHi:  array<f32>;
@group(0) @binding(3) var<storage, read>       valLo:  array<f32>;
@group(0) @binding(4) var<storage, read>       x: array<vec2<f32>>;
@group(0) @binding(5) var<storage, read_write> y: array<vec2<f32>>;
@group(0) @binding(6) var<uniform>             params: CsrParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i: u32 = gid.x;
  if (i >= params.N) { return; }
  let begin: u32 = rowPtr[i];
  let end:   u32 = rowPtr[i + 1u];
  var acc: vec2<f32> = vec2<f32>(0.0, 0.0);
  for (var k: u32 = begin; k < end; k = k + 1u) {
    let col: u32 = colInd[k];
    let coef: vec2<f32> = vec2<f32>(valHi[k], valLo[k]);
    let xc: vec2<f32> = x[col];
    acc = dsAdd(acc, dsMul(coef, xc));
  }
  y[i] = acc;
}
`;

// -----------------------------------------------------------------------------
// Block-Jacobi 2x2 apply:  z = M^-1 * r.
//
// For each node n with DOFs (2n, 2n+1), z[2n]   = a*r[2n] + b*r[2n+1]
//                                       z[2n+1] = c*r[2n] + d*r[2n+1]
// One thread per node.  blocks[8n + 0..1, 2..3, 4..5, 6..7] holds DS pairs
// for a, b, c, d respectively.  See `packDsBlockJacobi` for the layout.
// -----------------------------------------------------------------------------
export const KERNEL_BLOCK_JACOBI_WGSL = /* wgsl */ `
${DS_WGSL}

struct BjParams { numNodes: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       blocks: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read>       r: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read_write> z: array<vec2<f32>>;
@group(0) @binding(3) var<uniform>             params: BjParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n: u32 = gid.x;
  if (n >= params.numNodes) { return; }
  let base: u32 = 4u * n;       // 4 DS entries per node
  let a: vec2<f32> = blocks[base + 0u];
  let b: vec2<f32> = blocks[base + 1u];
  let c: vec2<f32> = blocks[base + 2u];
  let d: vec2<f32> = blocks[base + 3u];
  let rx: vec2<f32> = r[2u * n];
  let ry: vec2<f32> = r[2u * n + 1u];
  z[2u * n]      = dsAdd(dsMul(a, rx), dsMul(b, ry));
  z[2u * n + 1u] = dsAdd(dsMul(c, rx), dsMul(d, ry));
}
`;

// =============================================================================
// CPU reference implementations of every BLAS kernel above.
// Used by the parity suite to verify that each WGSL kernel matches the
// CPU-f64 contract bit-for-bit (within DS precision).
// =============================================================================

import {
  dsAdd, dsMul, dsFromF64, dsToF64
} from './ds.js';

export function cpuRefAxpy(alphaDs, x, y) {
  const n = y.length;
  for (let i = 0; i < n; i += 1) {
    const xi = x[i];
    const yi = y[i];
    const ax = dsMul(alphaDs, xi);
    y[i] = dsAdd(ax, yi);
  }
  return y;
}

export function cpuRefAxpby(alphaDs, x, betaDs, y) {
  const n = y.length;
  for (let i = 0; i < n; i += 1) {
    const ax = dsMul(alphaDs, x[i]);
    const by = dsMul(betaDs, y[i]);
    y[i] = dsAdd(ax, by);
  }
  return y;
}

export function cpuRefDot(x, y) {
  let acc = [0, 0];
  for (let i = 0; i < x.length; i += 1) {
    acc = dsAdd(acc, dsMul(x[i], y[i]));
  }
  return acc;
}

export function cpuRefCsrMatvec(csr, x) {
  const { rowPtr, colInd, valHi, valLo, dim } = csr;
  const out = new Array(dim);
  for (let i = 0; i < dim; i += 1) {
    let acc = [0, 0];
    const begin = rowPtr[i];
    const end = rowPtr[i + 1];
    for (let k = begin; k < end; k += 1) {
      const coef = [valHi[k], valLo[k]];
      acc = dsAdd(acc, dsMul(coef, x[colInd[k]]));
    }
    out[i] = acc;
  }
  return out;
}

export function cpuRefBlockJacobi(blocksDs, r) {
  // blocksDs: Array of 4 DS-pairs per node (a, b, c, d).
  const numNodes = (blocksDs.length / 4) | 0;
  const z = new Array(2 * numNodes);
  for (let n = 0; n < numNodes; n += 1) {
    const a = blocksDs[4 * n + 0];
    const b = blocksDs[4 * n + 1];
    const c = blocksDs[4 * n + 2];
    const d = blocksDs[4 * n + 3];
    const rx = r[2 * n];
    const ry = r[2 * n + 1];
    z[2 * n]     = dsAdd(dsMul(a, rx), dsMul(b, ry));
    z[2 * n + 1] = dsAdd(dsMul(c, rx), dsMul(d, ry));
  }
  return z;
}

// Helper: lift f64 array → DS-pair array (for tests).
export function liftF64(f64arr) {
  const out = new Array(f64arr.length);
  for (let i = 0; i < f64arr.length; i += 1) out[i] = dsFromF64(f64arr[i]);
  return out;
}

export function lowerDs(dsArr) {
  const out = new Float64Array(dsArr.length);
  for (let i = 0; i < dsArr.length; i += 1) out[i] = dsToF64(dsArr[i]);
  return out;
}

// =============================================================================
// Build the 2×2 nodal block-Jacobi inverse on device, from a CSR matrix.
//
// One thread per node n.  For each node it scans rows (2n) and (2n+1) of the
// CSR for the four entries (a=K[2n][2n], b=K[2n][2n+1], c=K[2n+1][2n],
// d=K[2n+1][2n+1]), then computes the 2×2 inverse:
//
//     M_n^-1 = (1 / det) · [ d  -b ]
//                          [-c   a ]   where det = ad - bc
//
// If the 2×2 is degenerate, falls back to scalar Jacobi on the diagonal.
// Output layout: 4 DS scalars per node, packed as (A, B, C, D) — same layout
// the block-Jacobi APPLY kernel reads.
//
// This kernel exists so the plastic Newton can rebuild the preconditioner
// per iteration WITHOUT round-tripping the CSR to CPU.
// =============================================================================
export const KERNEL_BUILD_BLOCK_JACOBI_FROM_CSR_WGSL = /* wgsl */ `
${DS_WGSL}

struct BuildBjParams { numNodes: u32, numFree: u32, _pad0: u32, _pad1: u32 };

@group(0) @binding(0) var<storage, read>       rowPtr: array<u32>;
@group(0) @binding(1) var<storage, read>       colInd: array<u32>;
@group(0) @binding(2) var<storage, read>       valHi:  array<f32>;
@group(0) @binding(3) var<storage, read>       valLo:  array<f32>;
@group(0) @binding(4) var<storage, read_write> blocks: array<vec2<f32>>;   // 4 DS per node
@group(0) @binding(5) var<uniform>             params: BuildBjParams;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n: u32 = gid.x;
  if (n >= params.numNodes) { return; }
  let r0: u32 = 2u * n;
  let r1: u32 = 2u * n + 1u;
  let zero: vec2<f32> = vec2<f32>(0.0, 0.0);
  var a: vec2<f32> = zero;
  var b: vec2<f32> = zero;
  var c: vec2<f32> = zero;
  var d: vec2<f32> = zero;
  // Scan row r0 for cols r0 (→ a) and r1 (→ b).
  if (r0 < params.numFree) {
    let begin: u32 = rowPtr[r0];
    let end:   u32 = rowPtr[r0 + 1u];
    for (var k: u32 = begin; k < end; k = k + 1u) {
      let col: u32 = colInd[k];
      let val: vec2<f32> = vec2<f32>(valHi[k], valLo[k]);
      if (col == r0) { a = val; }
      else if (r1 < params.numFree && col == r1) { b = val; }
    }
  }
  // Scan row r1 for cols r0 (→ c) and r1 (→ d).
  if (r1 < params.numFree) {
    let begin: u32 = rowPtr[r1];
    let end:   u32 = rowPtr[r1 + 1u];
    for (var k: u32 = begin; k < end; k = k + 1u) {
      let col: u32 = colInd[k];
      let val: vec2<f32> = vec2<f32>(valHi[k], valLo[k]);
      if (col == r1) { d = val; }
      else if (r0 < params.numFree && col == r0) { c = val; }
    }
  }
  // Invert 2×2 if non-degenerate; otherwise scalar Jacobi or identity.
  let det: vec2<f32> = dsAdd(dsMul(a, d), dsNeg(dsMul(b, c)));
  let oneId: vec2<f32> = vec2<f32>(1.0, 0.0);
  var A: vec2<f32> = zero;
  var B: vec2<f32> = zero;
  var C: vec2<f32> = zero;
  var D: vec2<f32> = zero;
  if (abs(det.x) > 1e-30 && r1 < params.numFree) {
    let invDet: vec2<f32> = dsRecip(det);
    A = dsMul(d, invDet);
    B = dsNeg(dsMul(b, invDet));
    C = dsNeg(dsMul(c, invDet));
    D = dsMul(a, invDet);
  } else if (r0 < params.numFree && abs(a.x) > 1e-30) {
    A = dsRecip(a);
    if (r1 < params.numFree && abs(d.x) > 1e-30) { D = dsRecip(d); }
    else { D = oneId; }
  } else if (r1 < params.numFree && abs(d.x) > 1e-30) {
    A = oneId;
    D = dsRecip(d);
  } else {
    A = oneId;
    D = oneId;
  }
  blocks[n * 4u + 0u] = A;
  blocks[n * 4u + 1u] = B;
  blocks[n * 4u + 2u] = C;
  blocks[n * 4u + 3u] = D;
}
`;
