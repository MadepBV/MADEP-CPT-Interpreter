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

export function createCpuF32Backend() {
  let buffer = null;

  function ensureBuffer(rows) {
    const { numRows, maxRowLen } = computeEllpackShape(rows);
    if (
      buffer
      && buffer.numRows === numRows
      && buffer.maxRowLen === maxRowLen
      && ellpackPatternMatches(buffer, rows)
    ) {
      packEllpackValues(buffer, rows);
      return;
    }
    if (!buffer || buffer.numRows !== numRows || buffer.maxRowLen !== maxRowLen) {
      buffer = createEllpackBuffer({ numRows, maxRowLen, valueDtype: 'f32' });
    }
    packEllpackIndices(buffer, rows);
    packEllpackValues(buffer, rows);
  }

  function matvec(rows, vector) {
    if (!rows.length) return new Float64Array(0);
    ensureBuffer(rows);
    // Narrow vector to Float32 so the computation matches the GPU path.
    const narrowedVector = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i += 1) narrowedVector[i] = vector[i];
    return ellpackMatvecReference(buffer, narrowedVector);
  }

  function dispose() {
    buffer = null;
  }

  return {
    name: 'cpu-f32',
    precision: 'f32',
    requiresResidualRefresh: true,
    matvec,
    dispose
  };
}
