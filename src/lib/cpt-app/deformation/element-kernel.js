// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import {
  buildBMatrixT3,
  edgeTractionVector,
  elementBodyForceVectorT3FromArea,
  elementStiffnessT3FromBAndArea,
  triangleArea
} from './element-t3.js';
import * as T6 from './element-t6.js';

const T3_GAUSS = [{ L1: 1 / 3, L2: 1 / 3, L3: 1 / 3, w: 1, areaWeightFactor: 1 }];

function centroid(corners) {
  return {
    x: (corners[0].x + corners[1].x + corners[2].x) / 3,
    y: (corners[0].y + corners[1].y + corners[2].y) / 3
  };
}

function stressAt0(stress2DAtGp) {
  return Array.isArray(stress2DAtGp) ? stress2DAtGp[0] : stress2DAtGp;
}

function tangentAt0(tangents2DAtGp) {
  return Array.isArray(tangents2DAtGp) ? tangents2DAtGp[0] : tangents2DAtGp;
}

function elementInternalForceVectorT3FromBAndArea(B, area, stress2D) {
  const out = new Float64Array(6);
  const sxx = Number(stress2D?.sxx) || 0;
  const syy = Number(stress2D?.syy) || 0;
  const txy = Number(stress2D?.txy) || 0;
  for (let i = 0; i < 6; i += 1) {
    out[i] = area * (B[0][i] * sxx + B[1][i] * syy + B[2][i] * txy);
  }
  return out;
}

function t3GaussPointsXY(corners) {
  const point = centroid(corners);
  return [{
    gpIndex: 0,
    L1: 1 / 3,
    L2: 1 / 3,
    L3: 1 / 3,
    w: 1,
    areaWeightFactor: 1,
    x: point.x,
    y: point.y,
    N: [1 / 3, 1 / 3, 1 / 3]
  }];
}

const T3_KERNEL = {
  kind: 't3',
  numNodes: 3,
  numDofs: 6,
  numGaussPoints: 1,
  gaussPoints: T3_GAUSS,
  buildB: buildBMatrixT3,
  buildBAtGauss: (corners) => buildBMatrixT3(corners),
  elementStiffness: (corners, tangents2DAtGp, area, elementCache = null) => (
    elementStiffnessT3FromBAndArea(
      elementCache?.B || buildBMatrixT3(corners),
      area ?? triangleArea(corners),
      tangentAt0(tangents2DAtGp)
    )
  ),
  elementInternalForce: (corners, stress2DAtGp, area, elementCache = null) => (
    elementInternalForceVectorT3FromBAndArea(
      elementCache?.B || buildBMatrixT3(corners),
      area ?? triangleArea(corners),
      stressAt0(stress2DAtGp)
    )
  ),
  elementBodyForceFromArea: elementBodyForceVectorT3FromArea,
  edgeTraction: edgeTractionVector,
  gaussPointsXY: t3GaussPointsXY
};

const T6_KERNEL = {
  kind: 't6',
  numNodes: 6,
  numDofs: 12,
  numGaussPoints: 3,
  gaussPoints: T6.GAUSS_T6_3PT,
  buildB: T6.buildBMatrixT6AtGauss,
  buildBAtGauss: T6.buildBMatrixT6AtGauss,
  elementStiffness: T6.elementStiffnessT6FromTangents2D,
  elementInternalForce: T6.elementInternalForceVectorT6,
  elementBodyForceFromArea: T6.elementBodyForceVectorT6FromArea,
  edgeTraction: T6.edgeTractionVectorT6,
  gaussPointsXY: T6.gaussPointsXYT6
};

export function normalizeElementType(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized === 't6' ? 't6' : 't3';
}

export function elementKernelFor(kind) {
  return normalizeElementType(kind) === 't6' ? T6_KERNEL : T3_KERNEL;
}
