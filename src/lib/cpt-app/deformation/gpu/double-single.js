// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Utilities for a lightweight double-single representation backed by pairs of
// Float32 values. The kernels still execute in WebGL single precision, but
// retaining the low-order remainder materially improves the ELLPACK matvec on
// near-singular Stage 2 tangents.

export function splitFloat64ToFloat32Pair(value) {
  const hi = Math.fround(Number(value) || 0);
  const lo = Math.fround((Number(value) || 0) - hi);
  return { hi, lo };
}

export function fillFloat32PairArrays(source, targetHi, targetLo, length = source?.length || 0) {
  const count = Math.max(Math.min(Math.round(length), source?.length || 0, targetHi?.length || 0, targetLo?.length || 0), 0);
  for (let index = 0; index < count; index += 1) {
    const { hi, lo } = splitFloat64ToFloat32Pair(source[index]);
    targetHi[index] = hi;
    targetLo[index] = lo;
  }
  return count;
}

export function createFloat32PairArrays(length) {
  const size = Math.max(Math.round(Number(length) || 0), 0);
  return {
    hi: new Float32Array(size),
    lo: new Float32Array(size)
  };
}
