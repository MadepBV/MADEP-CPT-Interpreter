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

export function packEllpackValues(buffer, rows) {
  const { numRows, maxRowLen, vals, valsHi, valsLo, valueDtype } = buffer;
  if (rows.length !== numRows) {
    throw new Error(`ELLPACK pack: row-count mismatch (buffer=${numRows}, rows=${rows.length}).`);
  }
  for (let row = 0; row < numRows; row += 1) {
    const values = rows[row].values;
    const rowLen = values.length;
    const base = row * maxRowLen;
    for (let k = 0; k < rowLen; k += 1) {
      const value = Number(values[k]) || 0;
      if (valueDtype === 'ds') {
        const pair = splitFloat64ToFloat32Pair(value);
        valsHi[base + k] = pair.hi;
        valsLo[base + k] = pair.lo;
        vals[base + k] = pair.hi;
      } else {
        vals[base + k] = value;
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
