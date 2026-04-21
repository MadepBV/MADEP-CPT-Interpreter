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

function multiplyMatrices3x6and6x6(left, right) {
  const out = Array.from({ length: 3 }, () => Array(6).fill(0));
  for (let i = 0; i < 3; i += 1) {
    for (let k = 0; k < 6; k += 1) {
      let sum = 0;
      for (let j = 0; j < 3; j += 1) sum += left[i][j] * right[j][k];
      out[i][k] = sum;
    }
  }
  return out;
}

function multiplyMatrices6x3and3x6(left, right) {
  const out = Array.from({ length: 6 }, () => Array(6).fill(0));
  for (let i = 0; i < 6; i += 1) {
    for (let k = 0; k < 6; k += 1) {
      let sum = 0;
      for (let j = 0; j < 3; j += 1) sum += left[i][j] * right[j][k];
      out[i][k] = sum;
    }
  }
  return out;
}

export function elementStiffnessT3(nodes, material, warnings = []) {
  const area = triangleArea(nodes);
  if (!(area > AREA_EPS)) {
    throw new Error('Encountered a zero-area T3 element during deformation assembly.');
  }
  const B = buildBMatrixT3(nodes);
  const D = planeStrainElasticMatrix(material?.Emc, material?.nu, warnings, material?.label || material?.id || 'Material');
  const Bt = Array.from({ length: 6 }, (_, i) => [B[0][i], B[1][i], B[2][i]]);
  const DB = multiplyMatrices3x6and6x6(D, B);
  const BtDB = multiplyMatrices6x3and3x6(Bt, DB);
  return BtDB.map((row) => row.map((value) => value * area));
}

export function edgeTractionVector(edge, tx, ty) {
  const length = Math.hypot((edge?.b?.x || 0) - (edge?.a?.x || 0), (edge?.b?.y || 0) - (edge?.a?.y || 0));
  const scale = length / 2;
  return [scale * tx, scale * ty, scale * tx, scale * ty];
}
