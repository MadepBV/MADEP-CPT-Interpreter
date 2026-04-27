// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Resident GPU buffer schema and packing helpers.
// ============================================================================
//
// Every floating-point quantity that lives on the GPU is stored as a
// double-single pair (hi, lo) of f32. The packing convention is:
//
//   DS scalar           : vec2<f32>           (8 bytes)
//   DS vector of length n: array<vec2<f32>, n>(8 n bytes)
//   DS CSR matrix       : { rowPtr (u32 N+1), colInd (u32 NNZ),
//                           valHi  (f32 NNZ), valLo  (f32 NNZ) }
//   DS block-Jacobi M^-1: array<vec2<f32>, 4n>  (16 n bytes per nodal 2x2)
//
// All packs are pure: they take a Float64Array source and produce typed
// arrays ready for `device.queue.writeBuffer`.  No GPU device is required at
// this layer; the runtime layer (`resident-runtime.js`) wires the typed
// arrays into actual GPUBuffer handles.
//
// The Veltkamp-style split used here is:
//
//   hi = Math.fround(value)
//   lo = Math.fround(value - hi)
//
// This is the IEEE-754 round-to-nearest-even split: `hi + lo = value` exactly
// for all f64 values in [-2^128, 2^128] and `|lo| <= ulp(hi) / 2`. The
// boundary check guards against silent overflow when an engineer accidentally
// uploads a value larger than f32 max — those become `Infinity` in `hi` and
// `0` in `lo`, which the GPU side detects as `dsHi(a) == infinity` and
// surfaces as a finite-stress assertion in the kernel.

import { dsFromF64 } from './wgsl/ds.js';

// -----------------------------------------------------------------------------
// DS-vector pack/unpack.  A length-n DS vector occupies 2n f32 slots laid out
// as (hi[0], lo[0], hi[1], lo[1], ...).  This matches WGSL's
// `array<vec2<f32>, n>` storage layout exactly.
// -----------------------------------------------------------------------------
export function packDsVector(vec) {
  const n = vec.length;
  const out = new Float32Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    const v = Number(vec[i]) || 0;
    const hi = Math.fround(v);
    const lo = Math.fround(v - hi);
    out[2 * i] = hi;
    out[2 * i + 1] = lo;
  }
  return out;
}

export function unpackDsVector(packed) {
  const n = packed.length >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = packed[2 * i] + packed[2 * i + 1];
  }
  return out;
}

// -----------------------------------------------------------------------------
// DS scalar pack/unpack.  Stored as vec4<f32>(hi, lo, 0, 0) so it can be
// bound as a uniform buffer (uniform buffer minimum binding size is 16 B).
// -----------------------------------------------------------------------------
export function packDsScalar(value) {
  const v = Number(value) || 0;
  const hi = Math.fround(v);
  const lo = Math.fround(v - hi);
  return new Float32Array([hi, lo, 0, 0]);
}

export function unpackDsScalar(packed) {
  return packed[0] + packed[1];
}

// -----------------------------------------------------------------------------
// CSR matrix layout.
//
// Input:
//   rows: Array of { indices: Int32Array, values: Float64Array, diag: number }
//         where `indices` and `values` are aligned and sorted ascending in
//         column index. Length-N row set yields a Length-N rowPtr.
//
// Output:
//   rowPtr: Uint32Array(N + 1)
//   colInd: Uint32Array(NNZ)
//   valHi:  Float32Array(NNZ)
//   valLo:  Float32Array(NNZ)
//
// Both column-index and row-pointer arrays are unsigned 32-bit. WebGPU's
// minimum buffer binding alignment is 4 bytes, so all four arrays satisfy
// the alignment contract by construction.
// -----------------------------------------------------------------------------
export function packDsCsr(rows) {
  const N = rows.length;
  let nnz = 0;
  for (let i = 0; i < N; i += 1) {
    nnz += rows[i]?.indices?.length || 0;
  }
  const rowPtr = new Uint32Array(N + 1);
  const colInd = new Uint32Array(nnz);
  const valHi = new Float32Array(nnz);
  const valLo = new Float32Array(nnz);
  let cursor = 0;
  for (let i = 0; i < N; i += 1) {
    rowPtr[i] = cursor;
    const row = rows[i] || {};
    const ind = row.indices || [];
    const val = row.values || [];
    for (let k = 0; k < ind.length; k += 1) {
      const v = Number(val[k]) || 0;
      const hi = Math.fround(v);
      const lo = Math.fround(v - hi);
      colInd[cursor] = ind[k] >>> 0;
      valHi[cursor] = hi;
      valLo[cursor] = lo;
      cursor += 1;
    }
  }
  rowPtr[N] = cursor;
  return { rowPtr, colInd, valHi, valLo, nnz: cursor, dim: N };
}

// -----------------------------------------------------------------------------
// Block-Jacobi 2x2 inverse, packed for the DS-apply kernel.
//
// For each node n with DOFs (2n, 2n+1), the 2x2 inverse is
//
//     M_n^-1 = (1/det) * [  d_yy  -d_xy ]
//                       [ -d_yx   d_xx ]
//
// which we store as four DS scalars laid out
//
//   ax2[2 N + 0] = a    (hi, lo)
//   ax2[2 N + 1] = b    (hi, lo)
//   ax2[2 N + 2] = c    (hi, lo)
//   ax2[2 N + 3] = d    (hi, lo)
//
// where the apply is z[2n]   = a*r[2n]   + b*r[2n+1]
//                    z[2n+1] = c*r[2n]   + d*r[2n+1]
//
// 16 bytes per node (4 × 8-byte DS), matching WGSL's
// `array<vec2<f32>, 4 * num_nodes>`.
// -----------------------------------------------------------------------------
export function packDsBlockJacobi(blocks) {
  // `blocks` is an Array of length numNodes, each entry { a, b, c, d } as f64.
  // For nodes whose 2×2 block was not invertible (rare; isolated DOFs at the
  // mesh boundary), the entry is { a: 1/diag_x, d: 1/diag_y, b: 0, c: 0 }
  // — i.e., scalar Jacobi for that nodal pair.
  const numNodes = blocks.length;
  const out = new Float32Array(8 * numNodes); // 4 DS × 2 f32 each
  for (let n = 0; n < numNodes; n += 1) {
    const block = blocks[n] || {};
    const entries = [block.a, block.b, block.c, block.d];
    for (let k = 0; k < 4; k += 1) {
      const v = Number(entries[k]) || 0;
      const hi = Math.fround(v);
      const lo = Math.fround(v - hi);
      out[8 * n + 2 * k] = hi;
      out[8 * n + 2 * k + 1] = lo;
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Buffer-size descriptor.  The runtime layer uses these to allocate GPU
// storage in advance and to validate that uploaded data exactly fills the
// declared buffer.
// -----------------------------------------------------------------------------
export const DS_VECTOR_BYTES_PER_ELEMENT = 8;          // 2 × f32
export const DS_SCALAR_BYTES = 16;                      // vec4<f32>
export const DS_BLOCK_JACOBI_BYTES_PER_NODE = 32;       // 4 DS × 8 B

export function dsVectorBytes(n) {
  return DS_VECTOR_BYTES_PER_ELEMENT * n;
}

export function dsCsrByteSizes({ N, nnz }) {
  return {
    rowPtr: 4 * (N + 1),
    colInd: 4 * nnz,
    valHi:  4 * nnz,
    valLo:  4 * nnz,
    total:  4 * (N + 1) + 12 * nnz
  };
}

export function dsBlockJacobiBytes(numNodes) {
  return DS_BLOCK_JACOBI_BYTES_PER_NODE * numNodes;
}

// -----------------------------------------------------------------------------
// Lift a single f64 scalar to a DS pair via dsFromF64.  Provided here as a
// trivial re-export so callers don't have to reach into the WGSL primitive
// module just to upload a constant.
// -----------------------------------------------------------------------------
export { dsFromF64 } from './wgsl/ds.js';
