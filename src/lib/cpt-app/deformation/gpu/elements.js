// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Shared element-kernel data layout for the deformation GPU backends. The
// WebGL path and the deterministic CPU surrogate both consume the same flat
// buffers so parity tests exercise the exact same gather/pack order.

const ELEMENT_B_STRIDE = 18;
const ELEMENT_DOF_STRIDE = 6;
const ELEMENT_STRAIN_STRIDE = 3;
const ELEMENT_FORCE_STRIDE = 6;
const ELEMENT_TANGENT_STRIDE = 9;
const ELEMENT_STIFFNESS_STRIDE = 36;

export {
  ELEMENT_B_STRIDE,
  ELEMENT_DOF_STRIDE,
  ELEMENT_STRAIN_STRIDE,
  ELEMENT_FORCE_STRIDE,
  ELEMENT_TANGENT_STRIDE,
  ELEMENT_STIFFNESS_STRIDE
};

export function createElementKernelBuffer(elementCount = 0) {
  const count = Math.max(Math.round(Number(elementCount) || 0), 0);
  return {
    elementCount: count,
    B: new Float32Array(count * ELEMENT_B_STRIDE),
    dofs: new Int32Array(count * ELEMENT_DOF_STRIDE),
    area: new Float32Array(count),
    identityKey: null
  };
}

export function elementKernelBufferMatches(buffer, elementCaches) {
  return !!buffer
    && buffer.identityKey === elementCaches
    && buffer.elementCount === (elementCaches?.length || 0);
}

export function packElementKernelBuffer(buffer, elementCaches) {
  const elementCount = elementCaches?.length || 0;
  if (!buffer || buffer.elementCount !== elementCount) {
    throw new Error(`Element-kernel pack: buffer element count ${buffer?.elementCount || 0} does not match ${elementCount}.`);
  }
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const bBase = elementIndex * ELEMENT_B_STRIDE;
    let flatIndex = 0;
    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
      for (let colIndex = 0; colIndex < 6; colIndex += 1) {
        buffer.B[bBase + flatIndex] = Number(elementCache?.B?.[rowIndex]?.[colIndex]) || 0;
        flatIndex += 1;
      }
    }
    const dofBase = elementIndex * ELEMENT_DOF_STRIDE;
    for (let localIndex = 0; localIndex < ELEMENT_DOF_STRIDE; localIndex += 1) {
      buffer.dofs[dofBase + localIndex] = Number(elementCache?.dofs?.[localIndex]) || 0;
    }
    buffer.area[elementIndex] = Number(elementCache?.area) || 0;
  }
  buffer.identityKey = elementCaches;
}

export function ensureElementKernelBuffer(buffer, elementCaches) {
  const elementCount = elementCaches?.length || 0;
  let nextBuffer = buffer;
  if (!nextBuffer || nextBuffer.elementCount !== elementCount) {
    nextBuffer = createElementKernelBuffer(elementCount);
  }
  if (!elementKernelBufferMatches(nextBuffer, elementCaches)) {
    packElementKernelBuffer(nextBuffer, elementCaches);
  }
  return nextBuffer;
}

export function elementStrainReference(buffer, displacementVector, out = null) {
  const elementCount = buffer?.elementCount || 0;
  const result = out && out.length === elementCount * ELEMENT_STRAIN_STRIDE
    ? out
    : new Float64Array(elementCount * ELEMENT_STRAIN_STRIDE);
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const bBase = elementIndex * ELEMENT_B_STRIDE;
    const dofBase = elementIndex * ELEMENT_DOF_STRIDE;
    const u0 = Number(displacementVector?.[buffer.dofs[dofBase]]) || 0;
    const u1 = Number(displacementVector?.[buffer.dofs[dofBase + 1]]) || 0;
    const u2 = Number(displacementVector?.[buffer.dofs[dofBase + 2]]) || 0;
    const u3 = Number(displacementVector?.[buffer.dofs[dofBase + 3]]) || 0;
    const u4 = Number(displacementVector?.[buffer.dofs[dofBase + 4]]) || 0;
    const u5 = Number(displacementVector?.[buffer.dofs[dofBase + 5]]) || 0;
    const sBase = elementIndex * ELEMENT_STRAIN_STRIDE;
    result[sBase] =
      buffer.B[bBase] * u0 + buffer.B[bBase + 1] * u1 + buffer.B[bBase + 2] * u2
      + buffer.B[bBase + 3] * u3 + buffer.B[bBase + 4] * u4 + buffer.B[bBase + 5] * u5;
    result[sBase + 1] =
      buffer.B[bBase + 6] * u0 + buffer.B[bBase + 7] * u1 + buffer.B[bBase + 8] * u2
      + buffer.B[bBase + 9] * u3 + buffer.B[bBase + 10] * u4 + buffer.B[bBase + 11] * u5;
    result[sBase + 2] =
      buffer.B[bBase + 12] * u0 + buffer.B[bBase + 13] * u1 + buffer.B[bBase + 14] * u2
      + buffer.B[bBase + 15] * u3 + buffer.B[bBase + 16] * u4 + buffer.B[bBase + 17] * u5;
  }
  return result;
}

export function elementInternalForceReference(buffer, stressFlat, out = null) {
  const elementCount = buffer?.elementCount || 0;
  const result = out && out.length === elementCount * ELEMENT_FORCE_STRIDE
    ? out
    : new Float64Array(elementCount * ELEMENT_FORCE_STRIDE);
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const bBase = elementIndex * ELEMENT_B_STRIDE;
    const sigmaBase = elementIndex * ELEMENT_STRAIN_STRIDE;
    const scale = Number(buffer.area?.[elementIndex]) || 0;
    const sxx = Number(stressFlat?.[sigmaBase]) || 0;
    const syy = Number(stressFlat?.[sigmaBase + 1]) || 0;
    const txy = Number(stressFlat?.[sigmaBase + 2]) || 0;
    const forceBase = elementIndex * ELEMENT_FORCE_STRIDE;
    result[forceBase] = scale * (buffer.B[bBase] * sxx + buffer.B[bBase + 6] * syy + buffer.B[bBase + 12] * txy);
    result[forceBase + 1] = scale * (buffer.B[bBase + 1] * sxx + buffer.B[bBase + 7] * syy + buffer.B[bBase + 13] * txy);
    result[forceBase + 2] = scale * (buffer.B[bBase + 2] * sxx + buffer.B[bBase + 8] * syy + buffer.B[bBase + 14] * txy);
    result[forceBase + 3] = scale * (buffer.B[bBase + 3] * sxx + buffer.B[bBase + 9] * syy + buffer.B[bBase + 15] * txy);
    result[forceBase + 4] = scale * (buffer.B[bBase + 4] * sxx + buffer.B[bBase + 10] * syy + buffer.B[bBase + 16] * txy);
    result[forceBase + 5] = scale * (buffer.B[bBase + 5] * sxx + buffer.B[bBase + 11] * syy + buffer.B[bBase + 17] * txy);
  }
  return result;
}

export function elementElasticStiffnessReference(buffer, tangentFlat, out = null) {
  const elementCount = buffer?.elementCount || 0;
  const result = out && out.length === elementCount * ELEMENT_STIFFNESS_STRIDE
    ? out
    : new Float64Array(elementCount * ELEMENT_STIFFNESS_STRIDE);
  const usesBroadcastTangent = (tangentFlat?.length || 0) === ELEMENT_TANGENT_STRIDE;
  for (let elementIndex = 0; elementIndex < elementCount; elementIndex += 1) {
    const bBase = elementIndex * ELEMENT_B_STRIDE;
    const dBase = usesBroadcastTangent ? 0 : elementIndex * ELEMENT_TANGENT_STRIDE;
    const scale = Number(buffer.area?.[elementIndex]) || 0;
    const d00 = Number(tangentFlat?.[dBase]) || 0;
    const d01 = Number(tangentFlat?.[dBase + 1]) || 0;
    const d02 = Number(tangentFlat?.[dBase + 2]) || 0;
    const d10 = Number(tangentFlat?.[dBase + 3]) || 0;
    const d11 = Number(tangentFlat?.[dBase + 4]) || 0;
    const d12 = Number(tangentFlat?.[dBase + 5]) || 0;
    const d20 = Number(tangentFlat?.[dBase + 6]) || 0;
    const d21 = Number(tangentFlat?.[dBase + 7]) || 0;
    const d22 = Number(tangentFlat?.[dBase + 8]) || 0;
    const kBase = elementIndex * ELEMENT_STIFFNESS_STRIDE;
    for (let localRow = 0; localRow < 6; localRow += 1) {
      const bi0 = buffer.B[bBase + localRow];
      const bi1 = buffer.B[bBase + 6 + localRow];
      const bi2 = buffer.B[bBase + 12 + localRow];
      for (let localCol = 0; localCol < 6; localCol += 1) {
        const bj0 = buffer.B[bBase + localCol];
        const bj1 = buffer.B[bBase + 6 + localCol];
        const bj2 = buffer.B[bBase + 12 + localCol];
        const db0 = d00 * bj0 + d01 * bj1 + d02 * bj2;
        const db1 = d10 * bj0 + d11 * bj1 + d12 * bj2;
        const db2 = d20 * bj0 + d21 * bj1 + d22 * bj2;
        result[kBase + localRow * 6 + localCol] = scale * (bi0 * db0 + bi1 * db1 + bi2 * db2);
      }
    }
  }
  return result;
}
