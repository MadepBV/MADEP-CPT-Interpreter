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

  function disposeKernels() {
    destroyKernel(matvecKernelF32);
    destroyKernel(matvecKernelDoubleSingle);
    destroyKernel(elementStrainKernelT3);
    destroyKernel(elementInternalForceKernelT3);
    destroyKernel(elementElasticStiffnessKernelT3);
    destroyKernel(elementStrainKernelT6);
    destroyKernel(elementInternalForceKernelT6);
    destroyKernel(elementElasticStiffnessKernelT6);
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
