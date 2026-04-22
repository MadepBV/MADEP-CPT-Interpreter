// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { planeStrainElasticMatrix } from './material.js';

const AREA_EPS = 1e-12;

export function triangleSignedArea2(nodes) {
  const [a, b, c] = nodes;
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function triangleArea(nodes) {
  return 0.5 * Math.abs(triangleSignedArea2(nodes));
}

export function triangleCentroid(nodes) {
  return {
    x: (nodes[0].x + nodes[1].x + nodes[2].x) / 3,
    y: (nodes[0].y + nodes[1].y + nodes[2].y) / 3
  };
}

export function buildBMatrixT3(nodes) {
  const [a, b, c] = nodes;
  const area2 = triangleSignedArea2(nodes);
  if (!(Math.abs(area2) > AREA_EPS)) {
    throw new Error('Encountered a degenerate T3 element during deformation assembly.');
  }
  const b1 = b.y - c.y;
  const b2 = c.y - a.y;
  const b3 = a.y - b.y;
  const c1 = c.x - b.x;
  const c2 = a.x - c.x;
  const c3 = b.x - a.x;
  const invArea2 = 1 / area2;
  return [
    [b1 * invArea2, 0, b2 * invArea2, 0, b3 * invArea2, 0],
    [0, c1 * invArea2, 0, c2 * invArea2, 0, c3 * invArea2],
    [c1 * invArea2, b1 * invArea2, c2 * invArea2, b2 * invArea2, c3 * invArea2, b3 * invArea2]
  ];
}

export function elementStiffnessT3FromBAndArea(B, area, tangent2D) {
  if (!(area > AREA_EPS)) {
    throw new Error('Encountered a zero-area T3 element during deformation assembly.');
  }
  const D = tangent2D;
  const out = Array.from({ length: 6 }, () => Array(6).fill(0));
  for (let i = 0; i < 6; i += 1) {
    const Bi0 = B[0][i];
    const Bi1 = B[1][i];
    const Bi2 = B[2][i];
    for (let j = 0; j < 6; j += 1) {
      const DB0 = D[0][0] * B[0][j] + D[0][1] * B[1][j] + D[0][2] * B[2][j];
      const DB1 = D[1][0] * B[0][j] + D[1][1] * B[1][j] + D[1][2] * B[2][j];
      const DB2 = D[2][0] * B[0][j] + D[2][1] * B[1][j] + D[2][2] * B[2][j];
      out[i][j] = area * (Bi0 * DB0 + Bi1 * DB1 + Bi2 * DB2);
    }
  }
  return out;
}

export function elementStiffnessT3FromTangent2D(nodes, tangent2D) {
  const area = triangleArea(nodes);
  if (!(area > AREA_EPS)) {
    throw new Error('Encountered a zero-area T3 element during deformation assembly.');
  }
  const B = buildBMatrixT3(nodes);
  return elementStiffnessT3FromBAndArea(B, area, tangent2D);
}

export function elementStiffnessT3(nodes, material, warnings = []) {
  const D = planeStrainElasticMatrix(material?.Emc, material?.nu, warnings, material?.label || material?.id || 'Material');
  return elementStiffnessT3FromTangent2D(nodes, D);
}

export function elementBodyForceVectorT3(nodes, bx = 0, by = 0) {
  const area = triangleArea(nodes);
  if (!(area > AREA_EPS)) {
    throw new Error('Encountered a zero-area T3 element during deformation body-force assembly.');
  }
  return elementBodyForceVectorT3FromArea(area, bx, by);
}

export function elementBodyForceVectorT3FromArea(area, bx = 0, by = 0) {
  if (!(area > AREA_EPS)) {
    throw new Error('Encountered a zero-area T3 element during deformation body-force assembly.');
  }
  const scale = area / 3;
  return [scale * bx, scale * by, scale * bx, scale * by, scale * bx, scale * by];
}

export function elementGravityVectorT3(nodes, gammaBulk) {
  return elementBodyForceVectorT3(nodes, 0, -Math.max(Number(gammaBulk) || 0, 0));
}

export function elementGravityVectorT3FromArea(area, gammaBulk) {
  return elementBodyForceVectorT3FromArea(area, 0, -Math.max(Number(gammaBulk) || 0, 0));
}

export function edgeTractionVector(edge, tx, ty) {
  const length = Math.hypot((edge?.b?.x || 0) - (edge?.a?.x || 0), (edge?.b?.y || 0) - (edge?.a?.y || 0));
  const scale = length / 2;
  return [scale * tx, scale * ty, scale * tx, scale * ty];
}
