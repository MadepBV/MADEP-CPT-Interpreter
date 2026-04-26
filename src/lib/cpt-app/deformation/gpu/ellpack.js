// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// CSR -> ELLPACK conversion with a sparsity-pattern cache. The deformation
// solver rebuilds the CSR `rows` array on every assembly via
// createCompressedRowsFromPattern, but the Int32Array `rows[i].indices` is
// reused across rebuilds (it comes from the prebuilt assembly pattern). We
// key the cache on the identity of rows[0].indices so we can refresh the
// ELLPACK values buffer in place and avoid reallocating the cols buffer on
// every Krylov iteration.

import { splitFloat64ToFloat32Pair } from './double-single.js';

const ELLPACK_PAD_COL = 0;
const ELLPACK_PAD_VAL = 0;

export function computeEllpackShape(rows) {
  const numRows = rows.length;
  let maxRowLen = 0;
  let totalNnz = 0;
  for (let i = 0; i < numRows; i += 1) {
    const rowLen = rows[i].indices.length;
    if (rowLen > maxRowLen) maxRowLen = rowLen;
    totalNnz += rowLen;
  }
  const flatLen = numRows * maxRowLen;
  return {
    numRows,
    maxRowLen,
    totalNnz,
    flatLen,
    paddingRatio: totalNnz > 0 ? flatLen / totalNnz : 1
  };
}

export function createEllpackBuffer({ numRows, maxRowLen, valueDtype = 'f32' }) {
  const flatLen = numRows * maxRowLen;
  const cols = new Int32Array(flatLen);
  const usesDoubleSingle = valueDtype === 'double-single' || valueDtype === 'ds';
  const vals = valueDtype === 'f64'
    ? new Float64Array(flatLen)
    : new Float32Array(flatLen);
  return {
    numRows,
    maxRowLen,
    flatLen,
    cols,
    vals,
    valsHi: usesDoubleSingle ? new Float32Array(flatLen) : null,
    valsLo: usesDoubleSingle ? new Float32Array(flatLen) : null,
    valueDtype: usesDoubleSingle ? 'ds' : valueDtype,
    identityKey: null,
    rowsRef: null,
    totalNnz: 0,
    paddingRatio: 1
  };
}

export function packEllpackIndices(buffer, rows) {
  const { numRows, maxRowLen, cols } = buffer;
  if (rows.length !== numRows) {
    throw new Error(`ELLPACK pack: row-count mismatch (buffer=${numRows}, rows=${rows.length}).`);
  }
  for (let row = 0; row < numRows; row += 1) {
    const indices = rows[row].indices;
    const rowLen = indices.length;
    if (rowLen > maxRowLen) {
      throw new Error(`ELLPACK pack: row ${row} length ${rowLen} exceeds maxRowLen ${maxRowLen}.`);
    }
    const base = row * maxRowLen;
    for (let k = 0; k < rowLen; k += 1) cols[base + k] = indices[k];
    for (let k = rowLen; k < maxRowLen; k += 1) cols[base + k] = ELLPACK_PAD_COL;
  }
  buffer.identityKey = rows.length ? rows[0].indices : null;
  buffer.rowsRef = rows;
  const shape = computeEllpackShape(rows);
  buffer.totalNnz = shape.totalNnz;
  buffer.paddingRatio = shape.paddingRatio;
}

// Sanity threshold for matrix values destined for the GPU's f32 matvec
// kernel. The kernel computes `sum_k vals[base+k] * x[col_k]`, and an
// f32 overflow during multiplication or accumulation is the primary
// mechanism by which the matvec produces NaN (Inf · finite = Inf, then
// Inf + (-Inf) = NaN in the row reduction).
//
// Threshold derivation: f32 max = 3.4e38. The kernel does up to
// `maxRowLen` ≈ 80 multiply-adds per row. For any single product to
// stay below f32 max we need `|val| · |x| < 3.4e38`. Krylov iterates in
// pathologically ill-conditioned T6 systems can reach |x| ≈ 1e15
// before the residual-refresh interval forces a recompute, so capping
// |val| at 1e15 keeps the product comfortably under f32 limit even at
// the worst observed vector magnitudes — and well clear of the
// summation over 80 entries (worst case 8e31 is still 4×10⁶ under f32
// max).
//
// A typical FE stiffness has max entry ~1e10 (E·n with E ≈ 5×10⁷ and
// element-scale gradient terms), so values within 5 orders of magnitude
// of the threshold simply do not arise from real geotechnical inputs.
// A trip through this guard genuinely indicates either a degenerate
// element (tiny area inflating B = ∂N/∂x), a tangent with near-singular
// singular values (rare; usually trapped earlier by the constitutive
// update), or a numerically broken assembly — all of which deserve CPU
// fallback rather than a quietly-poisoned GPU run.
const ELLPACK_F32_VALUE_SANITY_THRESHOLD = 1e15;

export function packEllpackValues(buffer, rows) {
  const { numRows, maxRowLen, vals, valsHi, valsLo, valueDtype } = buffer;
  if (rows.length !== numRows) {
    throw new Error(`ELLPACK pack: row-count mismatch (buffer=${numRows}, rows=${rows.length}).`);
  }
  let extremeRowIndex = -1;
  let extremeValue = 0;
  for (let row = 0; row < numRows; row += 1) {
    const values = rows[row].values;
    const rowLen = values.length;
    const base = row * maxRowLen;
    for (let k = 0; k < rowLen; k += 1) {
      const raw = Number(values[k]);
      const isFiniteValue = Number.isFinite(raw);
      // Treat NaN and Infinity as fatal at pack time. NaN typically means
      // an upstream constitutive/element bug; Infinity typically means a
      // degenerate element snuck through area validation. Either way,
      // packing as 0 (the historical behaviour) silently corrupts the
      // CG/GMRES inner loop downstream — we'd rather reject early so the
      // run record carries a precise reason for the GPU fallback.
      if (!isFiniteValue) {
        throw new Error(`ELLPACK pack: non-finite matrix value (${raw}) at row ${row}, position ${k}. The deformation assembly produced a NaN/Inf entry; falling back to CPU.`);
      }
      const absValue = Math.abs(raw);
      if (absValue > extremeValue) {
        extremeValue = absValue;
        extremeRowIndex = row;
      }
      const value = raw || 0;
      if (valueDtype === 'ds') {
        const pair = splitFloat64ToFloat32Pair(value);
        valsHi[base + k] = pair.hi;
        valsLo[base + k] = pair.lo;
        vals[base + k] = pair.hi;
      } else {
        vals[base + k] = value;
      }
      // Defensive: Float32Array storage of a finite f64 with |x| > ~3.4e38
      // becomes Infinity. The pack-time threshold (1e30) above is meant
      // to cap this well below f32 max, but we re-verify post-assignment
      // so a future loosening of the threshold can never silently inject
      // an Infinity into the matvec. The `vals` view is the f32 one
      // consumed by the f32 kernel; valsHi mirrors it for double-single.
      if (!Number.isFinite(vals[base + k])) {
        throw new Error(`ELLPACK pack: value ${raw} at row ${row}, position ${k} overflows f32 storage to ${vals[base + k]}; falling back to CPU.`);
      }
    }
    for (let k = rowLen; k < maxRowLen; k += 1) {
      if (valueDtype === 'ds') {
        valsHi[base + k] = ELLPACK_PAD_VAL;
        valsLo[base + k] = ELLPACK_PAD_VAL;
      }
      vals[base + k] = ELLPACK_PAD_VAL;
    }
  }
  if (extremeValue > ELLPACK_F32_VALUE_SANITY_THRESHOLD) {
    throw new Error(`ELLPACK pack: max matrix value ${extremeValue.toExponential(2)} at row ${extremeRowIndex} exceeds the f32 sanity threshold ${ELLPACK_F32_VALUE_SANITY_THRESHOLD.toExponential(0)}. The matrix is too ill-conditioned for the GPU's f32 matvec; falling back to CPU.`);
  }
  // Stash the matrix's max absolute value so the matvec call can compute
  // a precise safe-vector-magnitude bound at call time instead of a
  // fixed conservative one. The kernel's per-term overflow happens when
  // |val| · |x| > f32 max; with |val| capped here and the row-length
  // capped by maxRowLen, the safe |x| ceiling is exact arithmetic, not
  // a guess.
  buffer.maxAbsValue = extremeValue;
  buffer.rowsRef = rows;
}

export function ellpackPatternMatches(buffer, rows) {
  if (!buffer) return false;
  if (buffer.numRows !== rows.length) return false;
  if (!rows.length) return true;
  return buffer.identityKey === rows[0].indices;
}

// Reference ELLPACK matvec (matches the CPU fallback bit-for-bit in f64).
// Used by the cpu-f32 backend and as a sanity check for the GPU kernel.
export function ellpackMatvecReference(buffer, vector, out = null) {
  const { numRows, maxRowLen, cols, vals } = buffer;
  const output = out && out.length === numRows ? out : new Float64Array(numRows);
  const usesDoubleSingle = buffer?.valueDtype === 'ds';
  for (let row = 0; row < numRows; row += 1) {
    const base = row * maxRowLen;
    let sum = 0;
    for (let k = 0; k < maxRowLen; k += 1) {
      const col = cols[base + k];
      if (usesDoubleSingle) {
        const x = Number(vector?.[col]) || 0;
        const pair = splitFloat64ToFloat32Pair(x);
        sum += (buffer.valsHi[base + k] * pair.hi)
          + (buffer.valsHi[base + k] * pair.lo)
          + (buffer.valsLo[base + k] * pair.hi)
          + (buffer.valsLo[base + k] * pair.lo);
      } else {
        sum += vals[base + k] * vector[col];
      }
    }
    output[row] = sum;
  }
  return output;
}
