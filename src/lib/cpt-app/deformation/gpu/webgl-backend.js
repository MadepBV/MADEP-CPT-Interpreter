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
import { createFloat32PairArrays, fillFloat32PairArrays } from './double-single.js';
import { loadGpuJs, newProbeCanvas } from './probe.js';

const GPU_MAX_PADDING_RATIO = 2.0;
const GPU_F32_RESIDUAL_REFRESH_INTERVAL = 25;
const GPU_DOUBLE_SINGLE_RESIDUAL_REFRESH_INTERVAL = 10;

function destroyKernel(kernel) {
  if (!kernel) return;
  try { kernel.destroy?.(); } catch { /* ignore */ }
}

function normalizeKernelOutput(rawOut, expectedLength) {
  if (!Number.isFinite(expectedLength) || expectedLength <= 0) return new Float64Array(0);
  const source = rawOut?.length != null
    ? rawOut
    : (typeof rawOut?.toArray === 'function' ? rawOut.toArray() : []);
  const result = new Float64Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const value = Number(source?.[index]) || 0;
    if (!Number.isFinite(value)) {
      throw new Error(`GPU kernel produced a non-finite value at index ${index}; forcing CPU fallback.`);
    }
    result[index] = value;
  }
  return result;
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

  let elementBuffer = null;
  let elementShapeKey = '';
  let elementStrainKernel = null;
  let elementInternalForceKernel = null;
  let elementElasticStiffnessKernel = null;
  let elementDisplacementBuffer = null;
  let elementStressBuffer = null;
  let elementTangentBuffer = null;

  function disposeKernels() {
    destroyKernel(matvecKernelF32);
    destroyKernel(matvecKernelDoubleSingle);
    destroyKernel(elementStrainKernel);
    destroyKernel(elementInternalForceKernel);
    destroyKernel(elementElasticStiffnessKernel);
    matvecKernelF32 = null;
    matvecKernelDoubleSingle = null;
    elementStrainKernel = null;
    elementInternalForceKernel = null;
    elementElasticStiffnessKernel = null;
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

  function ensureElementBuffer(elementCaches) {
    if (elementBuffer && elementBuffer.identityKey === elementCaches) return elementBuffer;
    elementBuffer = ensureElementKernelBuffer(elementBuffer, elementCaches);
    const elementCount = elementBuffer.elementCount;
    checkTextureBudget('Element strain buffer', elementCount * ELEMENT_STRAIN_STRIDE, maxTextureSize);
    checkTextureBudget('Element internal-force buffer', elementCount * ELEMENT_FORCE_STRIDE, maxTextureSize);
    checkTextureBudget('Element stiffness buffer', elementCount * ELEMENT_STIFFNESS_STRIDE, maxTextureSize);
    const shapeKey = `${elementCount}`;
    if (elementShapeKey !== shapeKey) {
      destroyKernel(elementStrainKernel);
      destroyKernel(elementInternalForceKernel);
      destroyKernel(elementElasticStiffnessKernel);
      elementStrainKernel = buildElementStrainKernel(gpu, elementCount * ELEMENT_STRAIN_STRIDE);
      elementInternalForceKernel = buildElementInternalForceKernel(gpu, elementCount * ELEMENT_FORCE_STRIDE);
      elementElasticStiffnessKernel = buildElementElasticStiffnessKernel(gpu, elementCount * ELEMENT_STIFFNESS_STRIDE);
      elementShapeKey = shapeKey;
    }
    return elementBuffer;
  }

  function ensureFloat32VectorBuffer(source, existing = null) {
    const requiredLength = source?.length || 0;
    const target = existing && existing.length === requiredLength
      ? existing
      : new Float32Array(requiredLength);
    for (let index = 0; index < requiredLength; index += 1) target[index] = Number(source[index]) || 0;
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
        matrixBuffer.numRows
      );
    }
    vectorNarrowF32 = ensureFloat32VectorBuffer(vector, vectorNarrowF32);
    return normalizeKernelOutput(
      matvecKernelF32(matrixBuffer.cols, matrixBuffer.vals, vectorNarrowF32, matrixBuffer.maxRowLen),
      matrixBuffer.numRows
    );
  }

  function elementStrain(elementCaches, displacementVector) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const buffer = ensureElementBuffer(elementCaches);
    elementDisplacementBuffer = ensureFloat32VectorBuffer(displacementVector, elementDisplacementBuffer);
    return normalizeKernelOutput(
      elementStrainKernel(buffer.B, buffer.dofs, elementDisplacementBuffer),
      buffer.elementCount * ELEMENT_STRAIN_STRIDE
    );
  }

  function elementInternalForce(elementCaches, stressFlat) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const buffer = ensureElementBuffer(elementCaches);
    elementStressBuffer = ensureFloat32VectorBuffer(stressFlat, elementStressBuffer);
    return normalizeKernelOutput(
      elementInternalForceKernel(buffer.B, buffer.area, elementStressBuffer),
      buffer.elementCount * ELEMENT_FORCE_STRIDE
    );
  }

  function elementElasticStiffness(elementCaches, tangentFlat) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const buffer = ensureElementBuffer(elementCaches);
    elementTangentBuffer = ensureFloat32VectorBuffer(tangentFlat, elementTangentBuffer);
    return normalizeKernelOutput(
      elementElasticStiffnessKernel(buffer.B, buffer.area, elementTangentBuffer, tangentFlat.length === 9 ? 1 : 0),
      buffer.elementCount * ELEMENT_STIFFNESS_STRIDE
    );
  }

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
    elementBuffer = null;
    vectorNarrowF32 = null;
    vectorNarrowPair = null;
    elementDisplacementBuffer = null;
    elementStressBuffer = null;
    elementTangentBuffer = null;
    matrixShapeKey = '';
    matrixPrecisionKey = '';
    elementShapeKey = '';
    try { gpu.destroy?.(); } catch { /* ignore */ }
  }

  try {
    const sampleRows = [
      { indices: new Int32Array([0, 1]), values: new Float64Array([2, -1]), diagIndex: 0, diag: 2 },
      { indices: new Int32Array([0, 1, 2]), values: new Float64Array([-1, 2, -1]), diagIndex: 1, diag: 2 },
      { indices: new Int32Array([1, 2]), values: new Float64Array([-1, 2]), diagIndex: 1, diag: 2 }
    ];
    const got = matvec(sampleRows, new Float64Array([1, 2, 3]));
    const expected = [0, 0, -1];
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
      requiresResidualRefresh: true,
      get precisionMode() { return precisionMode; },
      get residualRefreshInterval() { return residualRefreshInterval; },
      get maxTextureSize() { return maxTextureSize; },
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
