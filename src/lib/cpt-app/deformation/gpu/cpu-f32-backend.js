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
import {
  elementElasticStiffnessReference,
  elementInternalForceReference,
  elementStrainReference,
  ensureElementKernelBuffer
} from './elements.js';
import {
  elementElasticStiffnessReferenceT6,
  elementInternalForceReferenceT6,
  elementStrainReferenceT6,
  ensureElementKernelBufferT6
} from './elements-t6.js';

function elementCachesKind(elementCaches) {
  const first = elementCaches?.[0]?.kind === 't6' ? 't6' : 't3';
  for (let i = 1; i < (elementCaches?.length || 0); i += 1) {
    const k = elementCaches[i]?.kind === 't6' ? 't6' : 't3';
    if (k !== first) {
      throw new Error('Element-kernel buffer received mixed element types; this configuration is not supported.');
    }
  }
  return first;
}

export function createCpuF32Backend(setup = {}) {
  let buffer = null;
  let elementBufferT3 = null;
  let elementBufferT6 = null;
  let precisionMode = String(setup?.precisionMode || 'f32').toLowerCase() === 'double-single' ? 'double-single' : 'f32';
  let residualRefreshInterval = Math.max(Math.round(Number(setup?.residualRefreshInterval) || 25), 1);
  let vectorF32Buffer = null;
  let displacementF32Buffer = null;
  let stressF32Buffer = null;
  let tangentF32Buffer = null;

  function ensureBuffer(rows) {
    if (buffer && buffer.rowsRef === rows) return;
    const { numRows, maxRowLen } = computeEllpackShape(rows);
    if (
      buffer
      && buffer.numRows === numRows
      && buffer.maxRowLen === maxRowLen
      && ellpackPatternMatches(buffer, rows)
    ) {
      if (buffer.rowsRef !== rows) packEllpackValues(buffer, rows);
      return;
    }
    if (!buffer || buffer.numRows !== numRows || buffer.maxRowLen !== maxRowLen) {
      buffer = createEllpackBuffer({
        numRows,
        maxRowLen,
        valueDtype: precisionMode === 'double-single' ? 'ds' : 'f32'
      });
    }
    packEllpackIndices(buffer, rows);
    packEllpackValues(buffer, rows);
  }

  function ensureElementBuffer(elementCaches) {
    const kind = elementCachesKind(elementCaches);
    if (kind === 't6') {
      if (elementBufferT6 && elementBufferT6.identityKey === elementCaches) return elementBufferT6;
      elementBufferT6 = ensureElementKernelBufferT6(elementBufferT6, elementCaches);
      return elementBufferT6;
    }
    if (elementBufferT3 && elementBufferT3.identityKey === elementCaches) return elementBufferT3;
    elementBufferT3 = ensureElementKernelBuffer(elementBufferT3, elementCaches);
    return elementBufferT3;
  }

  function ensureFloat32Buffer(source, existing = null) {
    const requiredLength = source?.length || 0;
    const target = existing && existing.length === requiredLength
      ? existing
      : new Float32Array(requiredLength);
    for (let index = 0; index < requiredLength; index += 1) target[index] = Number(source[index]) || 0;
    return target;
  }

  function matvec(rows, vector) {
    if (!rows.length) return new Float64Array(0);
    ensureBuffer(rows);
    const narrowedVector = precisionMode === 'double-single'
      ? Float64Array.from(vector)
      : (vectorF32Buffer = ensureFloat32Buffer(vector, vectorF32Buffer));
    return ellpackMatvecReference(buffer, narrowedVector);
  }

  function elementStrain(elementCaches, displacementVector) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const typedBuffer = ensureElementBuffer(elementCaches);
    const narrowed = displacementF32Buffer = ensureFloat32Buffer(displacementVector, displacementF32Buffer);
    return typedBuffer.elementType === 't6'
      ? elementStrainReferenceT6(typedBuffer, narrowed)
      : elementStrainReference(typedBuffer, narrowed);
  }

  function elementInternalForce(elementCaches, stressFlat) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const typedBuffer = ensureElementBuffer(elementCaches);
    const narrowed = stressF32Buffer = ensureFloat32Buffer(stressFlat, stressF32Buffer);
    return typedBuffer.elementType === 't6'
      ? elementInternalForceReferenceT6(typedBuffer, narrowed)
      : elementInternalForceReference(typedBuffer, narrowed);
  }

  function elementElasticStiffness(elementCaches, tangentFlat) {
    if (!(elementCaches?.length > 0)) return new Float64Array(0);
    const typedBuffer = ensureElementBuffer(elementCaches);
    const narrowed = tangentF32Buffer = ensureFloat32Buffer(tangentFlat, tangentF32Buffer);
    return typedBuffer.elementType === 't6'
      ? elementElasticStiffnessReferenceT6(typedBuffer, narrowed)
      : elementElasticStiffnessReference(typedBuffer, narrowed);
  }

  function setPrecisionMode(nextMode = 'f32') {
    const normalized = String(nextMode || 'f32').toLowerCase();
    const resolved = normalized === 'double-single' ? 'double-single' : 'f32';
    if (resolved === precisionMode) return precisionMode;
    precisionMode = resolved;
    buffer = null;
    return precisionMode;
  }

  function setResidualRefreshInterval(nextInterval = residualRefreshInterval) {
    residualRefreshInterval = Math.max(Math.round(Number(nextInterval) || residualRefreshInterval), 1);
    return residualRefreshInterval;
  }

  function dispose() {
    buffer = null;
    elementBufferT3 = null;
    elementBufferT6 = null;
    vectorF32Buffer = null;
    displacementF32Buffer = null;
    stressF32Buffer = null;
    tangentF32Buffer = null;
  }

  return {
    get name() {
      return precisionMode === 'double-single' ? 'cpu-double-single' : 'cpu-f32';
    },
    get precision() {
      return precisionMode === 'double-single' ? 'double-single' : 'f32';
    },
    supportsDoubleSingle: true,
    supportsElementKernels: true,
    supportsT3ElementKernels: true,
    supportsT6ElementKernels: true,
    requiresResidualRefresh: true,
    get precisionMode() { return precisionMode; },
    get residualRefreshInterval() { return residualRefreshInterval; },
    matvec,
    elementStrain,
    elementInternalForce,
    elementElasticStiffness,
    setPrecisionMode,
    setResidualRefreshInterval,
    dispose
  };
}
