// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// WebGL2 GPU.js matvec backend. Loaded lazily via dynamic import() so the
// gpu.js package is only pulled in when the feature is toggled on. The
// backend transparently falls back to the CPU path at the call-site layer
// if creation or any kernel execution raises.

import {
  computeEllpackShape,
  createEllpackBuffer,
  ellpackPatternMatches,
  packEllpackIndices,
  packEllpackValues
} from './ellpack.js';

const GPU_KERNEL_MAX_LOOP = 64;

async function loadGpuJs() {
  try {
    // gpu.js is a regular dependency: Vite resolves this dynamic import at
    // build time and emits a lazy-loaded chunk. At runtime any load failure
    // (missing package, driver context problem, browser module-map issue)
    // is caught here and the caller falls back to the CPU f64 path.
    const mod = await import('gpu.js');
    return mod?.GPU || mod?.default?.GPU || null;
  } catch {
    return null;
  }
}

function newOffscreen() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1);
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return canvas;
  }
  return null;
}

export async function tryCreateWebglBackend() {
  const GPU = await loadGpuJs();
  if (!GPU) return { backend: null, reason: 'gpu-js-load-failed' };
  const canvas = newOffscreen();
  if (!canvas) return { backend: null, reason: 'no-canvas-in-context' };

  let gpu;
  try {
    gpu = new GPU({ mode: 'webgl2', canvas });
  } catch (error) {
    return { backend: null, reason: `gpu-context-init:${error?.message || 'unknown'}` };
  }

  // Trivial probe kernel - verifies the WebGL2 context actually executes.
  try {
    const probe = gpu.createKernel(function (a) {
      return a[this.thread.x] * 2.0;
    }).setOutput([4]);
    const probeOut = probe([1, 2, 3, 4]);
    const ok = Math.abs(probeOut[0] - 2) < 1e-4
      && Math.abs(probeOut[1] - 4) < 1e-4
      && Math.abs(probeOut[2] - 6) < 1e-4
      && Math.abs(probeOut[3] - 8) < 1e-4;
    probe.destroy();
    if (!ok) {
      gpu.destroy();
      return { backend: null, reason: 'probe-kernel-mismatch' };
    }
  } catch (error) {
    try { gpu.destroy(); } catch { /* ignore */ }
    return { backend: null, reason: `probe-kernel-threw:${error?.message || 'unknown'}` };
  }

  let buffer = null;
  let matvecKernel = null;
  let cachedKernelShape = null;

  function buildKernel(numRows, maxRowLen) {
    // Rebuild the kernel when the sparsity pattern shape changes. GPU.js
    // compiles kernels per output size, so reuse is important.
    const kernel = gpu.createKernel(function (cols, vals, x, maxLen) {
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
    return kernel;
  }

  function ensureBufferAndKernel(rows) {
    const { numRows, maxRowLen } = computeEllpackShape(rows);
    const shapeKey = `${numRows}x${maxRowLen}`;
    if (
      buffer
      && buffer.numRows === numRows
      && buffer.maxRowLen === maxRowLen
      && ellpackPatternMatches(buffer, rows)
    ) {
      packEllpackValues(buffer, rows);
    } else {
      if (!buffer || buffer.numRows !== numRows || buffer.maxRowLen !== maxRowLen) {
        buffer = createEllpackBuffer({ numRows, maxRowLen, valueDtype: 'f32' });
      }
      packEllpackIndices(buffer, rows);
      packEllpackValues(buffer, rows);
    }
    if (cachedKernelShape !== shapeKey) {
      if (matvecKernel) {
        try { matvecKernel.destroy(); } catch { /* ignore */ }
      }
      matvecKernel = buildKernel(numRows, maxRowLen);
      cachedKernelShape = shapeKey;
    }
  }

  function matvec(rows, vector) {
    if (!rows.length) return new Float64Array(0);
    ensureBufferAndKernel(rows);
    const narrowedX = new Float32Array(vector.length);
    for (let i = 0; i < vector.length; i += 1) narrowedX[i] = vector[i];
    const rawOut = matvecKernel(buffer.cols, buffer.vals, narrowedX, buffer.maxRowLen);
    // GPU.js returns an Array or Float32Array depending on pipeline mode.
    const outF32 = rawOut.length ? rawOut : rawOut.toArray();
    const result = new Float64Array(buffer.numRows);
    for (let i = 0; i < buffer.numRows; i += 1) {
      const v = outF32[i];
      if (!Number.isFinite(v)) {
        throw new Error(`GPU matvec produced a non-finite value at row ${i}; forcing CPU fallback.`);
      }
      result[i] = v;
    }
    return result;
  }

  function dispose() {
    if (matvecKernel) {
      try { matvecKernel.destroy(); } catch { /* ignore */ }
      matvecKernel = null;
    }
    try { gpu.destroy(); } catch { /* ignore */ }
    buffer = null;
    cachedKernelShape = null;
  }

  // Sanity-check the kernel on a tiny real sparse system before we let it
  // loose on the Krylov solver. This catches drivers where MAX_LOOP or
  // single-precision pipeline behaviour diverges from spec.
  try {
    const sampleRows = [
      { indices: new Int32Array([0, 1]), values: new Float64Array([2, -1]), diagIndex: 0, diag: 2 },
      { indices: new Int32Array([0, 1, 2]), values: new Float64Array([-1, 2, -1]), diagIndex: 1, diag: 2 },
      { indices: new Int32Array([1, 2]), values: new Float64Array([-1, 2]), diagIndex: 1, diag: 2 }
    ];
    const samplVec = new Float64Array([1, 2, 3]);
    const expected = [0, 0, -1];
    const got = matvec(sampleRows, samplVec);
    // Re-check that the kernel can handle a different, larger shape after the
    // sample. We just force an additional ensureBufferAndKernel on a
    // different pattern; any compile-time error will surface here.
    const biggerRows = [
      { indices: new Int32Array([0, 1, 2, 3]), values: new Float64Array([1, 1, 1, 1]), diagIndex: 0, diag: 1 },
      { indices: new Int32Array([0, 2]), values: new Float64Array([1, 1]), diagIndex: 1, diag: 1 }
    ];
    matvec(biggerRows, new Float64Array([1, 1, 1, 1]));
    let healthy = true;
    for (let i = 0; i < expected.length; i += 1) {
      if (!Number.isFinite(got[i]) || Math.abs(got[i] - expected[i]) > 1e-3) {
        healthy = false;
        break;
      }
    }
    if (!healthy) {
      dispose();
      return { backend: null, reason: 'kernel-integration-test-mismatch' };
    }
  } catch (error) {
    try { dispose(); } catch { /* ignore */ }
    return { backend: null, reason: `kernel-integration-test-threw:${error?.message || 'unknown'}` };
  }

  return {
    backend: {
      name: 'webgl2-f32',
      precision: 'f32',
      requiresResidualRefresh: true,
      matvec,
      dispose
    },
    reason: ''
  };
}
