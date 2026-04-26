// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// T6 element-kernel data layout for the deformation GPU backends. Mirrors
// elements.js (T3) so the WebGL kernels and the deterministic CPU surrogate
// consume the same packed buffers. T6 differs from T3 in two structural ways:
//   1. 12 DOFs / element (3 corners + 3 mid-edge nodes), so dofs stride is 12.
//   2. 3 Gauss points / element with a 3×12 B-matrix at each, so the B
//      stride is 3 GP × 36 = 108 floats per element. The reference / kernel
//      bodies sum over Gauss points internally so consumers see one strain
//      triple per GP, one 12-vector internal force per element, and one
//      12×12 stiffness per element (Gauss-summed).
// The Gauss weight w = 1/6 and detJ = 2·area enter as the wDet = w·detJ
// scale on each Gauss-point contribution, identical to element-t6.js.

import { GAUSS_T6_3PT, buildBMatrixT6AtGauss } from '../element-t6.js';

const T6_NUM_GAUSS = 3;
const T6_GAUSS_WEIGHT = 1 / 6;

const T6_ELEMENT_B_STRIDE = T6_NUM_GAUSS * 3 * 12;       // 108
const T6_ELEMENT_DOF_STRIDE = 12;
const T6_ELEMENT_STRAIN_STRIDE = T6_NUM_GAUSS * 3;       // 9
const T6_ELEMENT_FORCE_STRIDE = 12;
const T6_ELEMENT_TANGENT_STRIDE_PER_GP = 9;
const T6_ELEMENT_TANGENT_STRIDE = T6_NUM_GAUSS * 9;      // 27 (per-GP)
const T6_ELEMENT_STIFFNESS_STRIDE = 144;                  // 12 × 12

export {
  T6_NUM_GAUSS,
  T6_GAUSS_WEIGHT,
  T6_ELEMENT_B_STRIDE,
  T6_ELEMENT_DOF_STRIDE,
  T6_ELEMENT_STRAIN_STRIDE,
  T6_ELEMENT_FORCE_STRIDE,
  T6_ELEMENT_TANGENT_STRIDE_PER_GP,
  T6_ELEMENT_TANGENT_STRIDE,
  T6_ELEMENT_STIFFNESS_STRIDE
};

export function createElementKernelBufferT6(elementCount = 0) {
  const count = Math.max(Math.round(Number(elementCount) || 0), 0);
  return {
    elementCount: count,
    elementType: 't6',
    B: new Float32Array(count * T6_ELEMENT_B_STRIDE),
    dofs: new Int32Array(count * T6_ELEMENT_DOF_STRIDE),
    area: new Float32Array(count),
    identityKey: null
  };
}

export function elementKernelBufferT6Matches(buffer, elementCaches) {
  return !!buffer
    && buffer.elementType === 't6'
    && buffer.identityKey === elementCaches
    && buffer.elementCount === (elementCaches?.length || 0);
}

export function packElementKernelBufferT6(buffer, elementCaches) {
  const elementCount = elementCaches?.length || 0;
  if (!buffer || buffer.elementCount !== elementCount) {
    throw new Error(`T6 element-kernel pack: buffer element count ${buffer?.elementCount || 0} does not match ${elementCount}.`);
  }
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const corners = elementCache?.corners;
    if (!Array.isArray(corners) || corners.length < 3) {
      throw new Error(`T6 element-kernel pack: element ${elementIndex} is missing corner data.`);
    }
    const bBase = elementIndex * T6_ELEMENT_B_STRIDE;
    for (let g = 0; g < T6_NUM_GAUSS; g += 1) {
      const gp = GAUSS_T6_3PT[g];
      const B = buildBMatrixT6AtGauss(corners, gp.L1, gp.L2, gp.L3);
      const gpBase = bBase + g * 36;
      for (let row = 0; row < 3; row += 1) {
        for (let col = 0; col < 12; col += 1) {
          buffer.B[gpBase + row * 12 + col] = Number(B?.[row]?.[col]) || 0;
        }
      }
    }
    const dofBase = elementIndex * T6_ELEMENT_DOF_STRIDE;
    const cacheDofs = elementCache?.dofs;
    for (let k = 0; k < T6_ELEMENT_DOF_STRIDE; k += 1) {
      buffer.dofs[dofBase + k] = Number(cacheDofs?.[k]) || 0;
    }
    buffer.area[elementIndex] = Number(elementCache?.area) || 0;
  }
  buffer.identityKey = elementCaches;
}

export function ensureElementKernelBufferT6(buffer, elementCaches) {
  const elementCount = elementCaches?.length || 0;
  let nextBuffer = buffer;
  if (!nextBuffer || nextBuffer.elementType !== 't6' || nextBuffer.elementCount !== elementCount) {
    nextBuffer = createElementKernelBufferT6(elementCount);
  }
  if (!elementKernelBufferT6Matches(nextBuffer, elementCaches)) {
    packElementKernelBufferT6(nextBuffer, elementCaches);
  }
  return nextBuffer;
}

// CPU reference functions: identical arithmetic to the WebGL kernels so the
// CPU-f32 backend reproduces the GPU code path deterministically. The f64
// reference values consumers expect come from element-t6.js itself; these
// are the f32-narrowed variants that exist purely so the f32 path is
// testable without a real GPU.

export function elementStrainReferenceT6(buffer, displacementVector, out = null) {
  const elementCount = buffer?.elementCount || 0;
  const result = out && out.length === elementCount * T6_ELEMENT_STRAIN_STRIDE
    ? out
    : new Float64Array(elementCount * T6_ELEMENT_STRAIN_STRIDE);
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const bBase = elementIndex * T6_ELEMENT_B_STRIDE;
    const dofBase = elementIndex * T6_ELEMENT_DOF_STRIDE;
    const u = new Float64Array(12);
    for (let k = 0; k < 12; k += 1) {
      u[k] = Number(displacementVector?.[buffer.dofs[dofBase + k]]) || 0;
    }
    const sBase = elementIndex * T6_ELEMENT_STRAIN_STRIDE;
    for (let g = 0; g < T6_NUM_GAUSS; g += 1) {
      const gpBase = bBase + g * 36;
      let exx = 0;
      let eyy = 0;
      let gxy = 0;
      for (let k = 0; k < 12; k += 1) {
        exx += buffer.B[gpBase + k] * u[k];
        eyy += buffer.B[gpBase + 12 + k] * u[k];
        gxy += buffer.B[gpBase + 24 + k] * u[k];
      }
      result[sBase + g * 3] = exx;
      result[sBase + g * 3 + 1] = eyy;
      result[sBase + g * 3 + 2] = gxy;
    }
  }
  return result;
}

export function elementInternalForceReferenceT6(buffer, stressFlat, out = null) {
  const elementCount = buffer?.elementCount || 0;
  const result = out && out.length === elementCount * T6_ELEMENT_FORCE_STRIDE
    ? out
    : new Float64Array(elementCount * T6_ELEMENT_FORCE_STRIDE);
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const bBase = elementIndex * T6_ELEMENT_B_STRIDE;
    const sigmaBase = elementIndex * T6_ELEMENT_STRAIN_STRIDE;
    const detJ = 2 * (Number(buffer.area?.[elementIndex]) || 0);
    const wDet = T6_GAUSS_WEIGHT * detJ;
    const fBase = elementIndex * T6_ELEMENT_FORCE_STRIDE;
    for (let i = 0; i < 12; i += 1) result[fBase + i] = 0;
    for (let g = 0; g < T6_NUM_GAUSS; g += 1) {
      const gpBase = bBase + g * 36;
      const sxx = Number(stressFlat?.[sigmaBase + g * 3]) || 0;
      const syy = Number(stressFlat?.[sigmaBase + g * 3 + 1]) || 0;
      const txy = Number(stressFlat?.[sigmaBase + g * 3 + 2]) || 0;
      for (let i = 0; i < 12; i += 1) {
        result[fBase + i] += wDet * (
          buffer.B[gpBase + i] * sxx
          + buffer.B[gpBase + 12 + i] * syy
          + buffer.B[gpBase + 24 + i] * txy
        );
      }
    }
  }
  return result;
}

export function elementElasticStiffnessReferenceT6(buffer, tangentFlat, out = null) {
  const elementCount = buffer?.elementCount || 0;
  const result = out && out.length === elementCount * T6_ELEMENT_STIFFNESS_STRIDE
    ? out
    : new Float64Array(elementCount * T6_ELEMENT_STIFFNESS_STRIDE);
  // A 9-float tangent broadcasts the same D across all elements / GPs (the
  // common linear-elastic case where every Gauss point shares the initial
  // tangent). Otherwise a 27-float per-element tangent is expected, packed
  // (gp, row, col).
  const usesBroadcastTangent = (tangentFlat?.length || 0) === T6_ELEMENT_TANGENT_STRIDE_PER_GP;
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const bBase = elementIndex * T6_ELEMENT_B_STRIDE;
    const detJ = 2 * (Number(buffer.area?.[elementIndex]) || 0);
    const wDet = T6_GAUSS_WEIGHT * detJ;
    const kBase = elementIndex * T6_ELEMENT_STIFFNESS_STRIDE;
    for (let kk = 0; kk < T6_ELEMENT_STIFFNESS_STRIDE; kk += 1) result[kBase + kk] = 0;
    for (let g = 0; g < T6_NUM_GAUSS; g += 1) {
      const gpBase = bBase + g * 36;
      const dBase = usesBroadcastTangent ? 0 : (elementIndex * T6_ELEMENT_TANGENT_STRIDE + g * T6_ELEMENT_TANGENT_STRIDE_PER_GP);
      const d00 = Number(tangentFlat?.[dBase]) || 0;
      const d01 = Number(tangentFlat?.[dBase + 1]) || 0;
      const d02 = Number(tangentFlat?.[dBase + 2]) || 0;
      const d10 = Number(tangentFlat?.[dBase + 3]) || 0;
      const d11 = Number(tangentFlat?.[dBase + 4]) || 0;
      const d12 = Number(tangentFlat?.[dBase + 5]) || 0;
      const d20 = Number(tangentFlat?.[dBase + 6]) || 0;
      const d21 = Number(tangentFlat?.[dBase + 7]) || 0;
      const d22 = Number(tangentFlat?.[dBase + 8]) || 0;
      for (let i = 0; i < 12; i += 1) {
        const bi0 = buffer.B[gpBase + i];
        const bi1 = buffer.B[gpBase + 12 + i];
        const bi2 = buffer.B[gpBase + 24 + i];
        for (let j = 0; j < 12; j += 1) {
          const bj0 = buffer.B[gpBase + j];
          const bj1 = buffer.B[gpBase + 12 + j];
          const bj2 = buffer.B[gpBase + 24 + j];
          const db0 = d00 * bj0 + d01 * bj1 + d02 * bj2;
          const db1 = d10 * bj0 + d11 * bj1 + d12 * bj2;
          const db2 = d20 * bj0 + d21 * bj1 + d22 * bj2;
          result[kBase + i * 12 + j] += wDet * (bi0 * db0 + bi1 * db1 + bi2 * db2);
        }
      }
    }
  }
  return result;
}
