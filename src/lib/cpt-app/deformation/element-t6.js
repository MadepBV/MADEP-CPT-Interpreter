// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { triangleArea, triangleSignedArea2 } from './element-t3.js';

const AREA_EPS = 1e-12;

export const T6_NUM_NODES = 6;
export const T6_NUM_DOFS = 12;
export const T6_NUM_GP = 3;

export const GAUSS_T6_3PT = [
  { L1: 2 / 3, L2: 1 / 6, L3: 1 / 6, w: 1 / 6 },
  { L1: 1 / 6, L2: 2 / 3, L3: 1 / 6, w: 1 / 6 },
  { L1: 1 / 6, L2: 1 / 6, L3: 2 / 3, w: 1 / 6 }
];

export function shapeFunctionsT6(L1, L2, L3) {
  return [
    L1 * (2 * L1 - 1),
    L2 * (2 * L2 - 1),
    L3 * (2 * L3 - 1),
    4 * L2 * L3,
    4 * L3 * L1,
    4 * L1 * L2
  ];
}

export function barycentricToXY(corners, L1, L2, L3) {
  return {
    x: L1 * corners[0].x + L2 * corners[1].x + L3 * corners[2].x,
    y: L1 * corners[0].y + L2 * corners[1].y + L3 * corners[2].y
  };
}

export function shapeFunctionGradientsT6(corners, L1, L2, L3) {
  const area2 = triangleSignedArea2(corners);
  if (!(Math.abs(area2) > AREA_EPS)) {
    throw new Error('Encountered a degenerate T6 element during deformation assembly.');
  }
  const [a, b, c] = corners;
  const b1 = b.y - c.y;
  const b2 = c.y - a.y;
  const b3 = a.y - b.y;
  const c1 = c.x - b.x;
  const c2 = a.x - c.x;
  const c3 = b.x - a.x;
  const invArea2 = 1 / area2;
  const dLdx = [b1 * invArea2, b2 * invArea2, b3 * invArea2];
  const dLdy = [c1 * invArea2, c2 * invArea2, c3 * invArea2];
  const L = [L1, L2, L3];
  const dNdx = new Float64Array(6);
  const dNdy = new Float64Array(6);

  for (let i = 0; i < 3; i += 1) {
    const scale = 4 * L[i] - 1;
    dNdx[i] = scale * dLdx[i];
    dNdy[i] = scale * dLdy[i];
  }

  // Triangle o2 ordering is [v1, v2, v3, m23, m31, m12].
  dNdx[3] = 4 * (L2 * dLdx[2] + L3 * dLdx[1]);
  dNdy[3] = 4 * (L2 * dLdy[2] + L3 * dLdy[1]);
  dNdx[4] = 4 * (L3 * dLdx[0] + L1 * dLdx[2]);
  dNdy[4] = 4 * (L3 * dLdy[0] + L1 * dLdy[2]);
  dNdx[5] = 4 * (L1 * dLdx[1] + L2 * dLdx[0]);
  dNdy[5] = 4 * (L1 * dLdy[1] + L2 * dLdy[0]);

  return { dNdx, dNdy };
}

export function buildBMatrixT6AtGauss(corners, L1, L2, L3) {
  const { dNdx, dNdy } = shapeFunctionGradientsT6(corners, L1, L2, L3);
  const B = [
    new Float64Array(12),
    new Float64Array(12),
    new Float64Array(12)
  ];
  for (let i = 0; i < 6; i += 1) {
    const ux = 2 * i;
    const uy = ux + 1;
    B[0][ux] = dNdx[i];
    B[1][uy] = dNdy[i];
    B[2][ux] = dNdy[i];
    B[2][uy] = dNdx[i];
  }
  return B;
}

export function elementStiffnessT6FromTangents2D(corners, tangents2DAtGp, area) {
  if (!(area > AREA_EPS)) {
    throw new Error('Encountered a zero-area T6 element during deformation stiffness assembly.');
  }
  const out = Array.from({ length: 12 }, () => new Float64Array(12));
  const detJ = 2 * area;
  for (let g = 0; g < GAUSS_T6_3PT.length; g += 1) {
    const gp = GAUSS_T6_3PT[g];
    const D = tangents2DAtGp?.[g];
    if (!D) throw new Error(`Missing T6 material tangent at Gauss point ${g}.`);
    const B = buildBMatrixT6AtGauss(corners, gp.L1, gp.L2, gp.L3);
    const wDet = gp.w * detJ;
    for (let i = 0; i < 12; i += 1) {
      const Bi0 = B[0][i];
      const Bi1 = B[1][i];
      const Bi2 = B[2][i];
      for (let j = 0; j < 12; j += 1) {
        const Bj0 = B[0][j];
        const Bj1 = B[1][j];
        const Bj2 = B[2][j];
        const DB0 = D[0][0] * Bj0 + D[0][1] * Bj1 + D[0][2] * Bj2;
        const DB1 = D[1][0] * Bj0 + D[1][1] * Bj1 + D[1][2] * Bj2;
        const DB2 = D[2][0] * Bj0 + D[2][1] * Bj1 + D[2][2] * Bj2;
        out[i][j] += wDet * (Bi0 * DB0 + Bi1 * DB1 + Bi2 * DB2);
      }
    }
  }
  return out;
}

export function elementInternalForceVectorT6(corners, stress2DAtGp, area) {
  if (!(area > AREA_EPS)) {
    throw new Error('Encountered a zero-area T6 element during deformation internal-force assembly.');
  }
  const out = new Float64Array(12);
  const detJ = 2 * area;
  for (let g = 0; g < GAUSS_T6_3PT.length; g += 1) {
    const gp = GAUSS_T6_3PT[g];
    const sigma = stress2DAtGp?.[g];
    if (!sigma) throw new Error(`Missing T6 stress state at Gauss point ${g}.`);
    const B = buildBMatrixT6AtGauss(corners, gp.L1, gp.L2, gp.L3);
    const wDet = gp.w * detJ;
    const sxx = Number(sigma.sxx) || 0;
    const syy = Number(sigma.syy) || 0;
    const txy = Number(sigma.txy) || 0;
    for (let i = 0; i < 12; i += 1) {
      out[i] += wDet * (B[0][i] * sxx + B[1][i] * syy + B[2][i] * txy);
    }
  }
  return out;
}

export function elementBodyForceVectorT6FromArea(area, bx = 0, by = 0) {
  if (!(area > AREA_EPS)) {
    throw new Error('Encountered a zero-area T6 element during deformation body-force assembly.');
  }
  const midpointShare = area / 3;
  // For a quadratic Lagrange triangle under constant body force, corner
  // shape-function integrals are exactly zero and midpoint integrals are A/3.
  return new Float64Array([
    0, 0,
    0, 0,
    0, 0,
    midpointShare * bx, midpointShare * by,
    midpointShare * bx, midpointShare * by,
    midpointShare * bx, midpointShare * by
  ]);
}

export function edgeTractionVectorT6(edge, tx, ty) {
  const length = Math.hypot((edge?.b?.x || 0) - (edge?.a?.x || 0), (edge?.b?.y || 0) - (edge?.a?.y || 0));
  const corner = length / 6;
  const mid = (2 * length) / 3;
  return new Float64Array([
    corner * tx, corner * ty,
    corner * tx, corner * ty,
    mid * tx, mid * ty
  ]);
}

export function gaussPointsXYT6(corners) {
  return GAUSS_T6_3PT.map((gp, gpIndex) => ({
    gpIndex,
    ...gp,
    areaWeightFactor: gp.w * 2,
    ...barycentricToXY(corners, gp.L1, gp.L2, gp.L3),
    N: shapeFunctionsT6(gp.L1, gp.L2, gp.L3)
  }));
}

export function validateT6Area(corners) {
  const area = triangleArea(corners);
  if (!(area > AREA_EPS)) {
    throw new Error('Encountered a zero-area T6 element.');
  }
  return area;
}
