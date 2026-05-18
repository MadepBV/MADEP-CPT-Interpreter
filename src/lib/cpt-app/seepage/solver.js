// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { buildOuterBoundary, pickOuterBoundaryEdge } from './boundary.js';
import { materialAt, pointInPolygonHalfOpen, polygonArea } from '../soil-regions.js';
import { buildTriangleMesh } from './mesh-triangle.js';
import { normalizeWallMaterial } from './material.js';
import { drainHeadValueAt, normalizeDrains } from './drains.js';

const EPS = 1e-9;
const GEOM_EPS = 1e-6;
const DRY_FACTOR = 1e-4;
const MIN_CONDUCTIVITY = 1e-20;
const WALL_THICKNESS = 0.1;
const DEFAULT_TARGET_AREA = 0.05;
const DEFAULT_FLOW_ERROR_TOL = 0.01;
const DEFAULT_MAX_RUNTIME_MS = 10000;
const MAX_CG_ITER = 2500;
const CG_CHECKPOINT_INTERVAL = 25;
const CG_TOL = 1e-6;
const CG_NUMERIC_EPS = 1e-30;
const MAX_ACTIVE_SET_ITER = 12;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function minMax(values) {
  if (!values?.length) return { min: null, max: null };
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min === Infinity ? { min: null, max: null } : { min, max };
}

function pointBounds(points) {
  if (!points?.length) return null;
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  return xMin === Infinity ? null : { xMin, xMax, yMin, yMax };
}

function secondsValueLabel(ms) {
  const seconds = Number(ms) / 1000;
  if (!Number.isFinite(seconds)) return '0.00';
  return seconds >= 10 ? seconds.toFixed(1) : seconds.toFixed(2);
}

function buildInterruptedError(message = 'Seepage run was interrupted before a solution became available.') {
  const error = new Error(message);
  error.code = 'SEEPAGE_INTERRUPTED';
  return error;
}

function buildTimeLimitError(message = 'Seepage runtime limit was reached before a solution became available.') {
  const error = new Error(message);
  error.code = 'SEEPAGE_TIME_LIMIT';
  return error;
}

function isStopRequested(runControl) {
  return !!runControl?.shouldStop?.();
}

function stopReason(runControl) {
  if (typeof runControl?.stopReason === 'function') {
    const reason = runControl.stopReason();
    if (reason) return reason;
  }
  return isStopRequested(runControl) ? 'interrupted' : null;
}

async function runCheckpoint(runControl, force = false) {
  if (typeof runControl?.checkpoint === 'function') {
    return !!(await runControl.checkpoint({ force }));
  }
  return isStopRequested(runControl);
}

function withRuntimeDeadline(runControl, deadlineAt) {
  if (!Number.isFinite(deadlineAt)) return runControl;
  const deadline = Number(deadlineAt);
  const deadlineExceeded = () => performance.now() >= deadline;
  return {
    shouldStop: () => deadlineExceeded() || isStopRequested(runControl),
    stopReason: () => {
      const baseReason = stopReason(runControl);
      if (baseReason) return baseReason;
      return deadlineExceeded() ? 'time-limit' : null;
    },
    checkpoint: async ({ force = false } = {}) => {
      if (deadlineExceeded()) return true;
      if (typeof runControl?.checkpoint === 'function') {
        const stopped = await runControl.checkpoint({ force });
        if (stopped) return true;
      } else if (isStopRequested(runControl)) {
        return true;
      }
      return deadlineExceeded();
    }
  };
}

function conductivityFloor(value, floor = MIN_CONDUCTIVITY) {
  const numeric = positiveNumber(value);
  return numeric != null ? Math.max(numeric, floor) : floor;
}

function effectiveElementConductivity(value, dry = false) {
  const base = conductivityFloor(value);
  return dry ? Math.max(base * DRY_FACTOR, MIN_CONDUCTIVITY * DRY_FACTOR) : base;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function uniqueSorted(values, tol = GEOM_EPS) {
  const sorted = [...values]
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const out = [];
  sorted.forEach((value) => {
    if (!out.length || Math.abs(value - out[out.length - 1]) > tol) out.push(value);
  });
  return out;
}

function dist(a, b) {
  return Math.hypot((b?.x || 0) - (a?.x || 0), (b?.y || 0) - (a?.y || 0));
}

function samePoint(a, b, tol = GEOM_EPS) {
  return Math.abs((a?.x || 0) - (b?.x || 0)) <= tol && Math.abs((a?.y || 0) - (b?.y || 0)) <= tol;
}

function cleanPolygon(points) {
  const cleaned = [];
  (points || []).forEach((point) => {
    const pt = { x: Number(point?.x), y: Number(point?.y) };
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    const last = cleaned[cleaned.length - 1];
    if (!last || dist(last, pt) > GEOM_EPS) cleaned.push(pt);
  });
  if (cleaned.length > 1 && samePoint(cleaned[0], cleaned[cleaned.length - 1])) cleaned.pop();
  if (polygonSignedArea(cleaned) < 0) cleaned.reverse();
  return cleaned;
}

function polygonSignedArea(points) {
  if (!points?.length || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return 0.5 * sum;
}

function polygonCentroid(points) {
  const polygon = cleanPolygon(points);
  const area = polygonSignedArea(polygon);
  if (!(Math.abs(area) > EPS)) {
    const mean = polygon.reduce(
      (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
      { x: 0, y: 0 }
    );
    const divisor = polygon.length || 1;
    return { x: mean.x / divisor, y: mean.y / divisor };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  const factor = 1 / (6 * area);
  return { x: cx * factor, y: cy * factor };
}

function segmentOrientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point, a, b, tol = GEOM_EPS) {
  const cross = segmentOrientation(a, b, point);
  if (Math.abs(cross) > tol) return false;
  const dot = (point.x - a.x) * (point.x - b.x) + (point.y - a.y) * (point.y - b.y);
  return dot <= tol;
}

function segmentIntersection(a, b, c, d, tol = GEOM_EPS) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const cdx = d.x - c.x;
  const cdy = d.y - c.y;
  const denom = abx * cdy - aby * cdx;
  const acx = c.x - a.x;
  const acy = c.y - a.y;

  if (Math.abs(denom) <= tol) {
    return null;
  }

  const t = (acx * cdy - acy * cdx) / denom;
  const u = (acx * aby - acy * abx) / denom;
  if (t < -tol || t > 1 + tol || u < -tol || u > 1 + tol) return null;
  return {
    x: a.x + abx * t,
    y: a.y + aby * t,
    t,
    u
  };
}

function samplePolylineY(polyline, x) {
  const verts = polyline?.vertices || [];
  if (!verts.length) return null;
  if (x <= verts[0].x) return verts[0].y;
  if (x >= verts[verts.length - 1].x) return verts[verts.length - 1].y;
  let lo = 0;
  let hi = verts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (verts[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const a = verts[lo];
  const b = verts[lo + 1];
  const t = Math.abs(b.x - a.x) < EPS ? 0 : (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

function defaultMeshTargetAreaForModel(model) {
  const terrain = model?.terrain?.vertices || [];
  if (terrain.length < 2 || !Number.isFinite(model?.analysisBottomY)) return DEFAULT_TARGET_AREA;
  const xMin = Number(terrain[0].x);
  const xMax = Number(terrain[terrain.length - 1].x);
  const bottomY = Number(model.analysisBottomY);
  const domainPolygon = [
    ...terrain.map((point) => ({ x: Number(point.x), y: Number(point.y) })),
    { x: xMax, y: bottomY },
    { x: xMin, y: bottomY }
  ];
  const area = polygonArea(domainPolygon);
  if (!(area > 0)) return DEFAULT_TARGET_AREA;
  return clamp(area / 3500, DEFAULT_TARGET_AREA, 1.5);
}

function findBin(coords, value) {
  if (!(coords?.length >= 2)) return -1;
  if (value <= coords[0] + GEOM_EPS) return 0;
  if (value >= coords[coords.length - 1] - GEOM_EPS) return coords.length - 2;
  let lo = 0;
  let hi = coords.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (coords[mid] <= value) lo = mid;
    else hi = mid;
  }
  return Math.min(Math.max(lo, 0), coords.length - 2);
}

function wallRegionFor(wall, index) {
  const wallMaterial = normalizeWallMaterial(wall?.material, index, wall?.id);
  const half = WALL_THICKNESS * 0.5;
  const x0 = Number(wall?.x) - half;
  const x1 = Number(wall?.x) + half;
  const yTop = Number(wall?.yTop);
  const yTip = Number(wall?.yTip);
  return {
    id: `wall-auto-${index + 1}`,
    source: 'wall-auto',
    polygon: cleanPolygon([
      { x: x0, y: yTip },
      { x: x1, y: yTip },
      { x: x1, y: yTop },
      { x: x0, y: yTop }
    ]),
    material: {
      id: wallMaterial.id || `wall-auto-material-${index + 1}`,
      label: wallMaterial.label || `Wall ${index + 1}`,
      color: '#5E6472',
      kx: conductivityFloor(wallMaterial.kAcross),
      ky: conductivityFloor(wallMaterial.kAlong),
      kAcross: conductivityFloor(wallMaterial.kAcross),
      kAlong: conductivityFloor(wallMaterial.kAlong),
      gamma: wallMaterial.gamma,
      gammaSat: wallMaterial.gammaSat,
      kSource: wallMaterial.kSource
    }
  };
}

function activeRegionsFor(model) {
  const base = (model?.regions || [])
    .map((region) => ({
      ...region,
      polygon: cleanPolygon(region?.polygon || [])
    }))
    .filter((region) => polygonArea(region.polygon) > 1e-6 && region?.material);
  const walls = (model?.walls || []).map((wall, index) => wallRegionFor(wall, index));
  return [...base, ...walls];
}

function centroidOfTriangle(a, b, c) {
  return {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3
  };
}

function elementMatrix(nodes, element, kx, ky) {
  const p1 = nodes[element[0]];
  const p2 = nodes[element[1]];
  const p3 = nodes[element[2]];
  const twiceArea = (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
  if (!(Math.abs(twiceArea) > EPS)) return null;
  const area = 0.5 * Math.abs(twiceArea);
  const b1 = p2.y - p3.y;
  const b2 = p3.y - p1.y;
  const b3 = p1.y - p2.y;
  const c1 = p3.x - p2.x;
  const c2 = p1.x - p3.x;
  const c3 = p2.x - p1.x;
  const scale = 1 / twiceArea;
  const dNdx = [b1 * scale, b2 * scale, b3 * scale];
  const dNdy = [c1 * scale, c2 * scale, c3 * scale];
  const ke = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      ke[i][j] = area * (kx * dNdx[i] * dNdx[j] + ky * dNdy[i] * dNdy[j]);
    }
  }
  return {
    ke,
    area,
    dNdx,
    dNdy,
    centroid: centroidOfTriangle(p1, p2, p3)
  };
}

function mergeDirichlet(map, nodeId, value) {
  if (!map.has(nodeId)) {
    map.set(nodeId, value);
    return;
  }
  const prior = map.get(nodeId);
  if (Math.abs(prior - value) <= 1e-5) return;
  throw new Error(`Conflicting seepage head constraints meet at the same node (${prior.toFixed(3)} m vs ${Number(value).toFixed(3)} m).`);
}

function compressRows(rows, freeNodes, freeIndexByNode, fixedValues) {
  const out = freeNodes.map(() => ({ indices: [], values: [], diag: 0 }));
  const rhs = new Float64Array(freeNodes.length);

  freeNodes.forEach((nodeId, rowIndex) => {
    rows[nodeId].forEach((value, colId) => {
      if (fixedValues.has(colId)) {
        rhs[rowIndex] -= value * fixedValues.get(colId);
        return;
      }
      const colIndex = freeIndexByNode.get(colId);
      if (colIndex == null) return;
      out[rowIndex].indices.push(colIndex);
      out[rowIndex].values.push(value);
      if (colIndex === rowIndex) out[rowIndex].diag = value;
    });
  });

  return { rows: out, rhs };
}

function dot(a, b) {
  let sum = 0;
  let compensation = 0;
  for (let i = 0; i < a.length; i += 1) {
    const term = a[i] * b[i];
    const corrected = term - compensation;
    const next = sum + corrected;
    compensation = (next - sum) - corrected;
    sum = next;
  }
  return sum;
}

function maxConductivityValue(conductivities) {
  let maxValue = MIN_CONDUCTIVITY;
  for (let i = 0; i < conductivities.length; i += 1) {
    const item = conductivities[i];
    const kx = Number(item?.kx);
    const ky = Number(item?.ky);
    if (Number.isFinite(kx) && kx > maxValue) maxValue = kx;
    if (Number.isFinite(ky) && ky > maxValue) maxValue = ky;
  }
  return maxValue;
}

function sparseMatVec(rows, vector) {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    let sum = 0;
    let compensation = 0;
    const row = rows[i];
    for (let j = 0; j < row.indices.length; j += 1) {
      const term = row.values[j] * vector[row.indices[j]];
      const corrected = term - compensation;
      const next = sum + corrected;
      compensation = (next - sum) - corrected;
      sum = next;
    }
    out[i] = sum;
  }
  return out;
}

async function solveCg(rows, rhs, initial = null, maxIter = MAX_CG_ITER, tol = CG_TOL, runControl = null) {
  const n = rows.length;
  if (!n) return { solution: new Float64Array(0), converged: true, iterations: 0, residualNorm: 0 };
  const x = initial && initial.length === n ? Float64Array.from(initial) : new Float64Array(n);
  let r = rhs;
  if (initial) {
    const ax = sparseMatVec(rows, x);
    r = new Float64Array(n);
    for (let i = 0; i < n; i += 1) r[i] = rhs[i] - ax[i];
  } else {
    r = Float64Array.from(rhs);
  }
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const bNorm = Math.max(Math.sqrt(dot(rhs, rhs)), 1);

  for (let i = 0; i < n; i += 1) {
    const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
    z[i] = r[i] / diag;
    p[i] = z[i];
  }

  let rzOld = dot(r, z);
  let residualNorm = Math.sqrt(dot(r, r));
  if (residualNorm / bNorm <= tol) {
    return { solution: x, converged: true, iterations: 0, residualNorm };
  }
  await runCheckpoint(runControl, true);

  for (let iter = 1; iter <= maxIter; iter += 1) {
    const ap = sparseMatVec(rows, p);
    const denom = dot(p, ap);
    if (!(Math.abs(denom) > CG_NUMERIC_EPS)) {
      return { solution: x, converged: residualNorm / bNorm <= tol, iterations: iter, residualNorm };
    }
    const alpha = rzOld / denom;
    for (let i = 0; i < n; i += 1) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    residualNorm = Math.sqrt(dot(r, r));
    if (residualNorm / bNorm <= tol) {
      return { solution: x, converged: true, iterations: iter, residualNorm };
    }
    for (let i = 0; i < n; i += 1) {
      const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
      z[i] = r[i] / diag;
    }
    const rzNew = dot(r, z);
    const beta = Math.abs(rzOld) > CG_NUMERIC_EPS ? rzNew / rzOld : 0;
    for (let i = 0; i < n; i += 1) p[i] = z[i] + beta * p[i];
    rzOld = rzNew;
    if (iter % CG_CHECKPOINT_INTERVAL === 0 && (await runCheckpoint(runControl))) {
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm,
        interrupted: true,
        stopReason: stopReason(runControl)
      };
    }
  }

  return { solution: x, converged: false, iterations: maxIter, residualNorm };
}

function buildEdgeMap(mesh) {
  const map = new Map();
  mesh.elements.forEach((element, elementIndex) => {
    const edges = [
      [element[0], element[1]],
      [element[1], element[2]],
      [element[2], element[0]]
    ];
    edges.forEach(([n1, n2]) => {
      const key = n1 < n2 ? `${n1}:${n2}` : `${n2}:${n1}`;
      if (!map.has(key)) map.set(key, { n1, n2, elements: [] });
      map.get(key).elements.push(elementIndex);
    });
  });
  return map;
}

function elementNormalAndGradient(mesh, elementIndex, gradients) {
  const gradient = gradients[elementIndex];
  if (!gradient) return null;
  return gradient;
}

function sampleTriangleValue(point, triPoints, triValues) {
  const [a, b, c] = triPoints;
  const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (!(Math.abs(denom) > EPS)) return null;
  const l1 = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denom;
  const l2 = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denom;
  const l3 = 1 - l1 - l2;
  if (l1 < -GEOM_EPS || l2 < -GEOM_EPS || l3 < -GEOM_EPS) return null;
  return l1 * triValues[0] + l2 * triValues[1] + l3 * triValues[2];
}

function contourSegmentsForTriangles(mesh, nodeValues, level, options = {}) {
  const out = [];
  mesh.elements.forEach((element, elementIndex) => {
    if (typeof options.includeElement === 'function' && !options.includeElement(elementIndex)) return;
    const points = element.map((nodeId) => mesh.nodes[nodeId]);
    const values = element.map((nodeId) => nodeValues[nodeId]);
    const hits = [];
    for (let i = 0; i < 3; i += 1) {
      const j = (i + 1) % 3;
      const v0 = values[i] - level;
      const v1 = values[j] - level;
      const p0 = points[i];
      const p1 = points[j];
      if (Math.abs(v0) <= 1e-10 && Math.abs(v1) <= 1e-10) continue;
      if (Math.abs(v0) <= 1e-10) {
        hits.push({ x: p0.x, y: p0.y });
        continue;
      }
      if (Math.abs(v1) <= 1e-10) {
        hits.push({ x: p1.x, y: p1.y });
        continue;
      }
      if (v0 * v1 > 0) continue;
      const t = v0 / (v0 - v1);
      hits.push({
        x: lerp(p0.x, p1.x, t),
        y: lerp(p0.y, p1.y, t)
      });
    }
    const uniqueHits = [];
    hits.forEach((point) => {
      if (!uniqueHits.some((other) => dist(other, point) <= 1e-8)) uniqueHits.push(point);
    });
    if (uniqueHits.length === 2) {
      if (options.visibilityScalars) {
        const midpoint = {
          x: 0.5 * (uniqueHits[0].x + uniqueHits[1].x),
          y: 0.5 * (uniqueHits[0].y + uniqueHits[1].y)
        };
        const visibilityValues = element.map((nodeId) => options.visibilityScalars[nodeId]);
        const visibleValue = sampleTriangleValue(midpoint, points, visibilityValues);
        const minVisible = Number.isFinite(options.minVisibleValue) ? Number(options.minVisibleValue) : 0;
        if (!Number.isFinite(visibleValue) || visibleValue < minVisible) return;
      }
      out.push(uniqueHits);
    }
  });
  return out;
}

export { contourSegmentsForTriangles };

function average(array) {
  if (!array.length) return 0;
  return array.reduce((sum, value) => sum + value, 0) / array.length;
}

function normalizedFlowBalanceError(boundaryFluxSummary, drainFluxSummary = null) {
  const totalInflow = Number(boundaryFluxSummary?.totalInflow) || 0;
  const totalOutflow = Number(boundaryFluxSummary?.totalOutflow) || 0;
  const drainInflow = Number(drainFluxSummary?.drainInflow) || 0;
  const drainOutflow = Number(drainFluxSummary?.drainOutflow) || 0;
  const domainInflow = totalOutflow + drainOutflow;
  const domainOutflow = totalInflow + drainInflow;
  const referenceFlow = Math.max(Math.abs(domainInflow), Math.abs(domainOutflow), 1e-12);
  return Math.abs(domainInflow - domainOutflow) / referenceFlow;
}

function meshCharacteristicLength(mesh) {
  const areas = (mesh?.elementData || [])
    .map((item) => Number(item?.area))
    .filter((value) => value > EPS);
  const meanArea = areas.length ? average(areas) : DEFAULT_TARGET_AREA;
  return Math.max(Math.sqrt(2 * meanArea), 0.05);
}

function seepageIterationTolerances(mesh) {
  const charLength = meshCharacteristicLength(mesh);
  const headActivateTol = clamp(0.02 * charLength, 0.002, 0.05);
  const headKeepTol = clamp(1.5 * headActivateTol, 0.003, 0.075);
  return {
    charLength,
    headActivateTol,
    headKeepTol,
    headConvergeTol: clamp(0.5 * headActivateTol, 0.001, 0.03),
    wetFractionDryTol: 0.05,
    wetFractionWetTol: 0.95
  };
}

function ensureElementNeighbors(mesh) {
  if (Array.isArray(mesh?.elementNeighbors) && mesh.elementNeighbors.length === (mesh.elements?.length || 0)) {
    return mesh.elementNeighbors;
  }

  const neighbors = Array.from({ length: mesh?.elements?.length || 0 }, () => new Set());
  buildEdgeMap(mesh).forEach((entry) => {
    if ((entry?.elements?.length || 0) <= 1) return;
    for (let i = 0; i < entry.elements.length; i += 1) {
      for (let j = i + 1; j < entry.elements.length; j += 1) {
        neighbors[entry.elements[i]].add(entry.elements[j]);
        neighbors[entry.elements[j]].add(entry.elements[i]);
      }
    }
  });

  mesh.elementNeighbors = neighbors.map((set) => [...set]);
  return mesh.elementNeighbors;
}

function elementWetMetrics(mesh, heads) {
  return mesh.elements.map((element, elementIndex) => {
    const metrics = trianglePressureHeadMetrics(mesh, heads, elementIndex);
    return {
      ...metrics,
      wetFraction: triangleWetAreaFraction(metrics.triPoints, metrics.psiValues)
    };
  });
}

function classifyElementWet(metrics, priorDry = null, tolerances = seepageIterationTolerances(null)) {
  if (!metrics) return priorDry == null ? false : !priorDry;
  if (metrics.wetFraction <= tolerances.wetFractionDryTol && metrics.centroidPsi <= tolerances.headActivateTol) return false;
  if (metrics.wetFraction >= tolerances.wetFractionWetTol && metrics.centroidPsi >= -tolerances.headActivateTol) return true;
  return metrics.wetFraction >= 0.5 || metrics.centroidPsi >= 0;
}

function faceMaskSignature(mask) {
  return (mask || []).map((value) => (value ? '1' : '0')).join('');
}

function jointActiveSetSignature(activeSeepageFaces, activeDrainNodes) {
  return `${faceMaskSignature(activeSeepageFaces)}|${faceMaskSignature(activeDrainNodes)}`;
}

function masksMatch(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (!!left[i] !== !!right[i]) return false;
  }
  return true;
}

function drainEntriesForMesh(mesh, model) {
  const drains = normalizeDrains(model?.drains || []);
  const entries = [];
  drains.forEach((drain, drainIndex) => {
    const drainId = drain.id || `drain-${drainIndex + 1}`;
    const nodeSet = mesh?.drainNodeIdsByDrain?.get?.(drainId);
    if (!nodeSet?.size) return;
    [...nodeSet]
      .filter((nodeId) => Number.isInteger(nodeId) && mesh.nodes?.[nodeId])
      .sort((left, right) => {
        const leftS = Number(mesh.drainNodeArcLengthByNode?.get?.(left)) || 0;
        const rightS = Number(mesh.drainNodeArcLengthByNode?.get?.(right)) || 0;
        return leftS - rightS || left - right;
      })
      .forEach((nodeId) => {
        const arcLength = Number(mesh.drainNodeArcLengthByNode?.get?.(nodeId)) || 0;
        entries.push({
          entryIndex: entries.length,
          drain,
          drainId,
          drainIndex,
          nodeId,
          arcLength,
          head: drainHeadValueAt(drain, arcLength),
          gating: drain.gating || 'when-saturated'
        });
      });
  });
  return entries;
}

function drainEntryIsActive(entry, activeDrainNodes = null) {
  if (entry?.gating === 'always') return true;
  if (!activeDrainNodes) return false;
  if (Array.isArray(activeDrainNodes)) return !!activeDrainNodes[entry.entryIndex];
  if (activeDrainNodes instanceof Set) {
    return activeDrainNodes.has(`${entry.drainId}:${entry.nodeId}`) || activeDrainNodes.has(entry.nodeId);
  }
  if (activeDrainNodes instanceof Map) {
    return !!activeDrainNodes.get(`${entry.drainId}:${entry.nodeId}`) || !!activeDrainNodes.get(entry.nodeId);
  }
  return false;
}

function activeDrainNodeIdSet(mesh, model, activeDrainNodes = null) {
  const out = new Set();
  drainEntriesForMesh(mesh, model).forEach((entry) => {
    if (drainEntryIsActive(entry, activeDrainNodes)) out.add(entry.nodeId);
  });
  return out;
}

function elementsByNode(mesh) {
  if (Array.isArray(mesh?._seepageElementsByNode)) return mesh._seepageElementsByNode;
  const out = Array.from({ length: mesh?.nodes?.length || 0 }, () => []);
  (mesh?.elements || []).forEach((element, elementIndex) => {
    (element || []).forEach((nodeId) => {
      if (Number.isInteger(nodeId) && out[nodeId]) out[nodeId].push(elementIndex);
    });
  });
  if (mesh) mesh._seepageElementsByNode = out;
  return out;
}

function drainGatingTolerances(options, tolerances) {
  const overrides = options?.drains?.gatingTolerances || {};
  const activate = Number(overrides.activate);
  const keep = Number(overrides.keep);
  const fluxTol = Number(overrides.fluxTol);
  return {
    headActivateTol: Number.isFinite(activate) && activate >= 0 ? activate : tolerances.headActivateTol,
    headKeepTol: Number.isFinite(keep) && keep >= 0 ? keep : tolerances.headKeepTol,
    fluxTolOverride: Number.isFinite(fluxTol) && fluxTol >= 0 ? fluxTol : null
  };
}

function drainNodeFluxTolerance(mesh, nodeId, options, tolerances) {
  const gateTolerances = drainGatingTolerances(options, tolerances);
  if (gateTolerances.fluxTolOverride != null) return gateTolerances.fluxTolOverride;
  let kLocal = MIN_CONDUCTIVITY;
  (elementsByNode(mesh)[nodeId] || []).forEach((elementIndex) => {
    const data = mesh?.elementData?.[elementIndex];
    if (!data) return;
    kLocal = Math.max(kLocal, Number(data.kx) || 0, Number(data.ky) || 0);
  });
  return Math.max(kLocal * gateTolerances.headActivateTol / Math.max(tolerances.charLength, 0.05), 1e-12);
}

function initialActiveDrainNodes(mesh, model, prior = null) {
  const entries = drainEntriesForMesh(mesh, model);
  if (Array.isArray(prior) && prior.length === entries.length) return prior.slice();
  return entries.map(() => true);
}

/**
 * Update the active-set mask for drain nodes per Signorini-type
 * complementarity (h ≤ h_d, q_drain ≥ 0, (h_d − h)·q_drain = 0).
 *
 * Reaction sign convention:
 * - reaction > 0: net flux entering the DOMAIN through the drain node
 *   (i.e., the drain is acting as a SOURCE — water flowing into the
 *   soil). This violates the one-way rule and forces deactivation.
 * - reaction ≤ 0: net flux LEAVING the domain through the drain node
 *   (i.e., the drain is draining water out — physically valid).
 *   Drain stays active.
 *
 * Pressure-head convention:
 * - pressureHead = head - node_elevation. Positive means saturated soil
 *   at the drain. Negative means the drain is above the local water
 *   table — drain has no water to remove, deactivate.
 *
 * Note: gating === 'always' keeps the drain Dirichlet-fixed regardless
 * of reaction sign. That bypasses the one-way rule by design; when the
 * reaction shows net injection, the flux summary records this as a
 * forcedInjection event so the result layer can surface a warning.
 */
function activeDrainNodesFromSolve(
  mesh,
  model,
  options,
  heads,
  prior = null,
  tolerances = seepageIterationTolerances(mesh),
  reactions = null
) {
  const entries = drainEntriesForMesh(mesh, model);
  const gateTolerances = drainGatingTolerances(options, tolerances);
  const priorMask = initialActiveDrainNodes(mesh, model, prior);
  return entries.map((entry) => {
    // gating='always': drain stays Dirichlet-fixed even if the reaction sign
    // implies injection. The forced-injection warning is emitted from the
    // flux summary, not here, so as not to disturb the active-set fixed
    // point (which would never settle if 'always' could deactivate).
    if (entry.gating === 'always') return true;
    const node = mesh?.nodes?.[entry.nodeId];
    const head = Number(heads?.[entry.nodeId]);
    if (!node || !Number.isFinite(head)) return !!priorMask[entry.entryIndex];
    const priorActive = !!priorMask[entry.entryIndex];
    // reaction > 0 means the Dirichlet drain is pushing water into the
    // domain (injection) — physically forbidden, force deactivation.
    const reaction = priorActive && reactions ? Number(reactions[entry.nodeId]) : NaN;
    const fluxTol = drainNodeFluxTolerance(mesh, entry.nodeId, options, tolerances);

    if (entry.gating === 'head-cap') {
      // Head-cap: activates when head would exceed h_d, deactivates when
      // the reaction indicates the cap is now pushing water in.
      if (priorActive) return !(Number.isFinite(reaction) && reaction > fluxTol);
      return head > entry.head + gateTolerances.headActivateTol;
    }

    // when-saturated: also requires positive pressure-head at the node.
    const pressureHead = head - node.y;
    if (priorActive) {
      return pressureHead >= -gateTolerances.headKeepTol && (!Number.isFinite(reaction) || reaction <= fluxTol);
    }
    if (pressureHead < gateTolerances.headActivateTol) return false;
    return !Number.isFinite(reaction) || reaction <= 0;
  });
}

function updateDryFlagsFromHeads(mesh, heads, priorDryFlags = null, activeSeepageFaces = null, tolerances = seepageIterationTolerances(mesh)) {
  const elementMetrics = elementWetMetrics(mesh, heads);
  const dryFlags = elementMetrics.map((metrics, elementIndex) => {
    const priorDry = typeof priorDryFlags?.[elementIndex] === 'boolean' ? priorDryFlags[elementIndex] : null;
    return !classifyElementWet(metrics, priorDry, tolerances);
  });

  (activeSeepageFaces || []).forEach((active, faceIndex) => {
    if (!active) return;
    dryFlags[mesh.boundaryFaces[faceIndex].elementIndex] = false;
  });

  return {
    dryFlags,
    elementMetrics
  };
}

function prescribedHeadAnchorElements(mesh, model) {
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );
  const anchors = new Set();
  (mesh?.boundaryFaces || []).forEach((face) => {
    const bc = activeBcs.get(face?.edgeKey);
    if (boundaryFaceUsesPrescribedHead(face, bc)) anchors.add(face.elementIndex);
  });
  return anchors;
}

function wetConnectivityDiagnostics(mesh, wetMask, anchorElements) {
  const wet = (wetMask || []).map(Boolean);
  const neighbors = ensureElementNeighbors(mesh);
  const connectedWetMask = new Array(wet.length).fill(false);
  const queue = [...new Set([...(anchorElements || [])].filter((elementIndex) => wet[elementIndex]))];

  queue.forEach((elementIndex) => {
    connectedWetMask[elementIndex] = true;
  });

  while (queue.length) {
    const elementIndex = queue.shift();
    (neighbors[elementIndex] || []).forEach((neighborIndex) => {
      if (!wet[neighborIndex] || connectedWetMask[neighborIndex]) return;
      connectedWetMask[neighborIndex] = true;
      queue.push(neighborIndex);
    });
  }

  const disconnectedWetMask = wet.map((isWet, elementIndex) => isWet && !connectedWetMask[elementIndex]);
  const seen = new Array(wet.length).fill(false);
  let disconnectedComponentCount = 0;
  let disconnectedElementCount = 0;

  disconnectedWetMask.forEach((isDisconnected, elementIndex) => {
    if (!isDisconnected || seen[elementIndex]) return;
    disconnectedComponentCount += 1;
    const stack = [elementIndex];
    seen[elementIndex] = true;
    while (stack.length) {
      const current = stack.pop();
      disconnectedElementCount += 1;
      (neighbors[current] || []).forEach((neighborIndex) => {
        if (!disconnectedWetMask[neighborIndex] || seen[neighborIndex]) return;
        seen[neighborIndex] = true;
        stack.push(neighborIndex);
      });
    }
  });

  return {
    connectedWetMask,
    disconnectedWetMask,
    disconnectedComponentCount,
    disconnectedElementCount
  };
}

function applyDisconnectedWetFallback(mesh, dryFlags, activeSeepageFaces, disconnectedWetMask) {
  const disconnected = (disconnectedWetMask || []).map(Boolean);
  if (!disconnected.some(Boolean)) {
    return {
      dryFlags,
      activeSeepageFaces,
      applied: false
    };
  }

  const nextDryFlags = dryFlags.map((isDry, elementIndex) => isDry || disconnected[elementIndex]);
  const nextActiveSeepageFaces = (activeSeepageFaces || []).map(
    (active, faceIndex) => active && !disconnected[mesh.boundaryFaces[faceIndex].elementIndex]
  );

  return {
    dryFlags: nextDryFlags,
    activeSeepageFaces: nextActiveSeepageFaces,
    applied: true
  };
}

async function solveSeepageBoundaryActiveSet(
  mesh,
  model,
  options,
  dryFlags,
  initialActiveSeepageFaces = null,
  initialHeads = null,
  tolerances = seepageIterationTolerances(mesh),
  runControl = null,
  initialActiveDrainNodesMask = null
) {
  let activeSeepageFaces =
    initialActiveSeepageFaces && initialActiveSeepageFaces.length === mesh.boundaryFaces.length
      ? initialActiveSeepageFaces.slice()
      : mesh.boundaryFaces.map(() => false);
  let activeDrainNodes = initialActiveDrainNodes(mesh, model, initialActiveDrainNodesMask);
  let heads = initialHeads;
  let totalLinearIterations = 0;
  let residualNorm = 0;
  let activeSetIterations = 0;
  // Sliding window of the most recent signatures (oldest first). A repeat
  // anywhere in the window indicates the active set is cycling between
  // configurations rather than approaching a fixed point — catches
  // A→B→C→A patterns that 1-step memory would miss.
  const seenSignatures = [];
  const CYCLE_WINDOW_SIZE = 4;
  let cycleDiagnostics = null;

  while (true) {
    if (await runCheckpoint(runControl, true)) {
      const reason = stopReason(runControl);
      if (!heads) {
        // Allow one partial active-set solve so stop/time-limit requests can
        // still return a usable latest state instead of failing before any iterate.
      } else {
        return {
          heads,
          activeSeepageFaces,
          activeDrainNodes,
          nextActiveSeepageFaces: activeSeepageFaces,
          nextActiveDrainNodes: activeDrainNodes,
          activeSetIterations,
          linearIterations: totalLinearIterations,
          residualNorm,
          interrupted: true,
          stopReason: reason,
          activeSetStable: false
        };
      }
    }

    activeSetIterations += 1;
    const dirichletValues = buildDirichletValues(mesh, model, options, activeSeepageFaces, activeDrainNodes);
    const activeSetDryFlags = (dryFlags || []).slice();
    activeSeepageFaces.forEach((active, faceIndex) => {
      if (!active) return;
      activeSetDryFlags[mesh.boundaryFaces[faceIndex].elementIndex] = false;
    });
    const solve = await solveHeadField(mesh, activeSetDryFlags, dirichletValues, heads, runControl);
    if (solve.interrupted && solve.iterations <= 0 && !heads) {
      return {
        heads: solve.heads,
        activeSeepageFaces,
        activeDrainNodes,
        nextActiveSeepageFaces: activeSeepageFaces,
        nextActiveDrainNodes: activeDrainNodes,
        activeSetIterations,
        linearIterations: totalLinearIterations,
        residualNorm: solve.residualNorm,
        interrupted: true,
        stopReason: solve.stopReason || stopReason(runControl),
        activeSetStable: false
      };
    }

    heads = solve.heads;
    totalLinearIterations += solve.iterations;
    residualNorm = solve.residualNorm;
    const gradients = computeElementGradients(mesh, heads);
    const nextActiveSeepageFaces = activeSeepageFacesFromFlux(
      mesh,
      heads,
      model,
      dryFlags,
      activeSeepageFaces,
      tolerances,
      gradients
    );
    const nextActiveDrainNodes = activeDrainNodesFromSolve(
      mesh,
      model,
      options,
      heads,
      activeDrainNodes,
      tolerances,
      solve.reactions
    );
    const stable =
      masksMatch(nextActiveSeepageFaces, activeSeepageFaces) &&
      masksMatch(nextActiveDrainNodes, activeDrainNodes);
    const nextSignature = jointActiveSetSignature(nextActiveSeepageFaces, nextActiveDrainNodes);
    const cycleHitIndex = seenSignatures.indexOf(nextSignature);
    const cycling = cycleHitIndex >= 0;
    if (cycling) {
      cycleDiagnostics = {
        cycleLength: seenSignatures.length - cycleHitIndex,
        windowSize: CYCLE_WINDOW_SIZE
      };
    }
    const boundaryFluxSummary = summarizeBoundaryFluxes(mesh, model, gradients, activeSeepageFaces, solve.reactions);

    if (solve.interrupted) {
      return {
        heads,
        activeSeepageFaces,
        activeDrainNodes,
        nextActiveSeepageFaces: activeSeepageFaces,
        nextActiveDrainNodes: activeDrainNodes,
        activeSetIterations,
        linearIterations: totalLinearIterations,
        residualNorm,
        interrupted: true,
        stopReason: solve.stopReason || stopReason(runControl),
        activeSetStable: stable,
        gradients,
        boundaryFluxSummary,
        reactions: solve.reactions
      };
    }

    if (stable || cycling || activeSetIterations >= MAX_ACTIVE_SET_ITER) {
      return {
        heads,
        activeSeepageFaces,
        activeDrainNodes,
        nextActiveSeepageFaces,
        nextActiveDrainNodes,
        activeSetIterations,
        linearIterations: totalLinearIterations,
        residualNorm,
        interrupted: false,
        stopReason: null,
        activeSetStable: stable,
        cycleDetected: cycling,
        cycleDiagnostics,
        gradients,
        boundaryFluxSummary,
        reactions: solve.reactions
      };
    }

    seenSignatures.push(jointActiveSetSignature(activeSeepageFaces, activeDrainNodes));
    if (seenSignatures.length > CYCLE_WINDOW_SIZE) seenSignatures.shift();
    activeSeepageFaces = nextActiveSeepageFaces;
    activeDrainNodes = nextActiveDrainNodes;
  }
}

async function solveHeadField(mesh, dryFlags, dirichletValues, initial = null, runControl = null) {
  const rows = Array.from({ length: mesh.nodes.length }, () => new Map());
  const conductivities = mesh.elementData.map((elementData, elementIndex) => {
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const dry = !!dryFlags[elementIndex];
    const kx = effectiveElementConductivity(cell.material?.kx, dry);
    const ky = effectiveElementConductivity(cell.material?.ky, dry);
    return { kx, ky };
  });
  const conductivityScale = maxConductivityValue(conductivities);

  mesh.elementData.forEach((elementData, elementIndex) => {
    const element = mesh.elements[elementIndex];
    const { kx, ky } = conductivities[elementIndex];
    const matrix = elementMatrix(mesh.nodes, element, kx / conductivityScale, ky / conductivityScale);
    if (!matrix) return;
    for (let i = 0; i < 3; i += 1) {
      const row = rows[element[i]];
      for (let j = 0; j < 3; j += 1) {
        row.set(element[j], (row.get(element[j]) || 0) + matrix.ke[i][j]);
      }
    }
    mesh.elementData[elementIndex] = {
      ...elementData,
      kx,
      ky,
      solverKx: kx / conductivityScale,
      solverKy: ky / conductivityScale,
      area: matrix.area,
      dNdx: matrix.dNdx,
      dNdy: matrix.dNdy,
      centroid: matrix.centroid
    };
  });

  const freeNodes = [];
  const freeIndexByNode = new Map();
  for (let i = 0; i < mesh.nodes.length; i += 1) {
    if (dirichletValues.has(i)) continue;
    freeIndexByNode.set(i, freeNodes.length);
    freeNodes.push(i);
  }

  const compressed = compressRows(rows, freeNodes, freeIndexByNode, dirichletValues);
  const initialFree = initial
    ? freeNodes.map((nodeId) => initial[nodeId] ?? 0)
    : null;
  const cg = await solveCg(compressed.rows, compressed.rhs, initialFree, MAX_CG_ITER, CG_TOL, runControl);
  if (!cg.converged && !cg.interrupted) {
    throw new Error(`Seepage linear solve did not converge (residual ${cg.residualNorm.toExponential(2)} after ${cg.iterations} iterations).`);
  }

  const heads = new Float64Array(mesh.nodes.length);
  dirichletValues.forEach((value, nodeId) => {
    heads[nodeId] = value;
  });
  freeNodes.forEach((nodeId, rowIndex) => {
    heads[nodeId] = cg.solution[rowIndex];
  });
  const reactions = new Float64Array(mesh.nodes.length);
  dirichletValues.forEach((_value, nodeId) => {
    const row = rows[nodeId];
    let reaction = 0;
    row.forEach((coefficient, columnId) => {
      reaction += coefficient * heads[columnId];
    });
    reactions[nodeId] = reaction * conductivityScale;
  });
  return {
    heads,
    iterations: cg.iterations,
    residualNorm: cg.residualNorm,
    interrupted: !!cg.interrupted,
    stopReason: cg.stopReason || null,
    reactions
  };
}

function computeElementGradients(mesh, heads) {
  return mesh.elements.map((element, elementIndex) => {
    let data = mesh.elementData[elementIndex];
    if (!data?.dNdx || !data?.dNdy) {
      const cell = mesh.cells[mesh.elementCell[elementIndex]];
      const kx = Number.isFinite(Number(data?.kx))
        ? Number(data.kx)
        : conductivityFloor(cell?.material?.kx);
      const ky = Number.isFinite(Number(data?.ky))
        ? Number(data.ky)
        : conductivityFloor(cell?.material?.ky);
      const matrix = elementMatrix(mesh.nodes, element, kx, ky);
      if (!matrix) {
        return {
          dhdx: 0,
          dhdy: 0,
          gradientMagnitude: 0,
          qx: 0,
          qy: 0,
          qMagnitude: 0
        };
      }
      data = { ...data, ...matrix, kx, ky };
      mesh.elementData[elementIndex] = data;
    }
    const hLocal = element.map((nodeId) => heads[nodeId]);
    const dhdx = data.dNdx[0] * hLocal[0] + data.dNdx[1] * hLocal[1] + data.dNdx[2] * hLocal[2];
    const dhdy = data.dNdy[0] * hLocal[0] + data.dNdy[1] * hLocal[1] + data.dNdy[2] * hLocal[2];
    const qx = -data.kx * dhdx;
    const qy = -data.ky * dhdy;
    return {
      dhdx,
      dhdy,
      gradientMagnitude: Math.hypot(dhdx, dhdy),
      qx,
      qy,
      qMagnitude: Math.hypot(qx, qy)
    };
  });
}

function buildBoundaryFaces(mesh, model) {
  if (mesh?.constraintEdges?.length) {
    const activeBcs = new Map(
      ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
    );
    const edgeMap = buildEdgeMap(mesh);
    const out = [];

    mesh.constraintEdges.forEach((edge) => {
      if (edge?.markerType !== 'outer') return;
      const key = edge.n1 < edge.n2 ? `${edge.n1}:${edge.n2}` : `${edge.n2}:${edge.n1}`;
      const entry = edgeMap.get(key);
      if (!entry || entry.elements.length !== 1) return;
      const a = mesh.nodes[edge.n1];
      const b = mesh.nodes[edge.n2];
      if (!a || !b) return;
      const midpoint = { x: 0.5 * (a.x + b.x), y: 0.5 * (a.y + b.y) };
      const elementIndex = entry.elements[0];
      const centroid = mesh.elementData[elementIndex].centroid;
      const edgeDx = b.x - a.x;
      const edgeDy = b.y - a.y;
      const length = Math.hypot(edgeDx, edgeDy) || 1;
      let normal = { x: edgeDy / length, y: -edgeDx / length };
      const toEdge = { x: midpoint.x - centroid.x, y: midpoint.y - centroid.y };
      if (normal.x * toEdge.x + normal.y * toEdge.y < 0) normal = { x: -normal.x, y: -normal.y };
      const bc = activeBcs.get(edge.edgeKey);
      out.push({
        n1: edge.n1,
        n2: edge.n2,
        a,
        b,
        mid: midpoint,
        length,
        normal,
        elementIndex,
        edgeKey: edge.edgeKey,
        source: edge.source,
        sourceIndex: edge.sourceIndex,
        type: bc?.type || 'no-flow',
        head: Number.isFinite(Number(bc?.head)) ? Number(bc.head) : null,
        headSubmerged: edge?.headSubmerged
      });
    });

    return out;
  }

  const boundary = buildOuterBoundary(model);
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );
  const edgeMap = buildEdgeMap(mesh);
  const out = [];
  edgeMap.forEach((entry) => {
    if (entry.elements.length !== 1) return;
    const a = mesh.nodes[entry.n1];
    const b = mesh.nodes[entry.n2];
    const midpoint = { x: 0.5 * (a.x + b.x), y: 0.5 * (a.y + b.y) };
    const match = pickOuterBoundaryEdge(boundary, midpoint, Math.max(dist(a, b), 0.1));
    if (!match?.edge) return;
    const tol = Math.max(1e-5, dist(a, b) * 0.05);
    if (
      !pointOnSegment(a, match.edge.a, match.edge.b, tol) ||
      !pointOnSegment(b, match.edge.a, match.edge.b, tol) ||
      !pointOnSegment(midpoint, match.edge.a, match.edge.b, tol)
    ) {
      return;
    }
    const elementIndex = entry.elements[0];
    const centroid = mesh.elementData[elementIndex].centroid;
    const edgeDx = b.x - a.x;
    const edgeDy = b.y - a.y;
    const length = Math.hypot(edgeDx, edgeDy) || 1;
    let normal = { x: edgeDy / length, y: -edgeDx / length };
    const toEdge = { x: midpoint.x - centroid.x, y: midpoint.y - centroid.y };
    if (normal.x * toEdge.x + normal.y * toEdge.y < 0) normal = { x: -normal.x, y: -normal.y };
    const bc = activeBcs.get(match.edge.edgeKey);
    out.push({
      n1: entry.n1,
      n2: entry.n2,
      a,
      b,
      mid: midpoint,
      length,
      normal,
      elementIndex,
      edgeKey: match.edge.edgeKey,
      source: match.edge.source,
      sourceIndex: match.edge.index,
      type: bc?.type || 'no-flow',
      head: Number.isFinite(Number(bc?.head)) ? Number(bc.head) : null,
      headSubmerged: null
    });
  });
  return out;
}

function boundaryFaceUsesPrescribedHead(face, bc) {
  if (bc?.type !== 'head' || !Number.isFinite(Number(bc?.head))) return false;
  if (typeof face?.headSubmerged === 'boolean') return face.headSubmerged;
  return Math.max(Number(face?.a?.y), Number(face?.b?.y), Number(face?.mid?.y)) <= Number(bc.head) + GEOM_EPS;
}

function buildDirichletValues(mesh, model, options, activeSeepageFaces, activeDrainNodes = null) {
  const values = new Map();
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );

  mesh.boundaryFaces.forEach((face, faceIndex) => {
    const bc = activeBcs.get(face.edgeKey);
    if (!bc) return;
    if (boundaryFaceUsesPrescribedHead(face, bc)) {
      mergeDirichlet(values, face.n1, Number(bc.head));
      mergeDirichlet(values, face.n2, Number(bc.head));
      return;
    }
    if (bc.type === 'seepage-face') {
      const active = options.freeSurface === 'fixed' ? true : !!activeSeepageFaces?.[faceIndex];
      if (!active) return;
      mergeDirichlet(values, face.n1, mesh.nodes[face.n1].y);
      mergeDirichlet(values, face.n2, mesh.nodes[face.n2].y);
    }
  });

  if (options.freeSurface === 'fixed') {
    mesh.phreaticNodeIds.forEach((nodeId) => {
      mergeDirichlet(values, nodeId, mesh.nodes[nodeId].y);
    });
  }

  drainEntriesForMesh(mesh, model).forEach((entry) => {
    if (!drainEntryIsActive(entry, activeDrainNodes)) return;
    mergeDirichlet(values, entry.nodeId, entry.head);
  });

  return values;
}

function dirichletBoundaryNodeTypes(mesh, model, activeSeepageFaces = null, activeDrainNodes = null, includeDrains = false) {
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );
  const nodeTypes = new Array(mesh?.nodes?.length || 0).fill(null);

  mesh.boundaryFaces.forEach((face, faceIndex) => {
    const bc = activeBcs.get(face.edgeKey);
    if (boundaryFaceUsesPrescribedHead(face, bc)) {
      nodeTypes[face.n1] = 'head';
      nodeTypes[face.n2] = 'head';
      return;
    }
    if (bc?.type !== 'seepage-face' || !activeSeepageFaces?.[faceIndex]) return;
    if (!nodeTypes[face.n1]) nodeTypes[face.n1] = 'seepage-face';
    if (!nodeTypes[face.n2]) nodeTypes[face.n2] = 'seepage-face';
  });

  if (includeDrains) {
    drainEntriesForMesh(mesh, model).forEach((entry) => {
      if (!drainEntryIsActive(entry, activeDrainNodes)) return;
      nodeTypes[entry.nodeId] = 'drain';
    });
  }

  return nodeTypes;
}

function facePressureHeadMetrics(face, mesh, heads) {
  const psi1 = (heads?.[face.n1] ?? 0) - Number(mesh?.nodes?.[face.n1]?.y || 0);
  const psi2 = (heads?.[face.n2] ?? 0) - Number(mesh?.nodes?.[face.n2]?.y || 0);
  const psiMid = 0.5 * (psi1 + psi2);
  return {
    psi1,
    psi2,
    psiMid,
    minPsi: Math.min(psi1, psi2, psiMid),
    maxPsi: Math.max(psi1, psi2, psiMid)
  };
}

function trianglePressureHeadMetrics(mesh, heads, elementIndex) {
  const element = mesh.elements[elementIndex];
  const triPoints = element.map((nodeId) => mesh.nodes[nodeId]);
  const psiValues = element.map((nodeId) => (heads?.[nodeId] ?? 0) - Number(mesh.nodes[nodeId]?.y || 0));
  const centroid = mesh.elementData[elementIndex].centroid;
  const triHeads = element.map((nodeId) => heads[nodeId]);
  const headAtCentroid = sampleTriangleValue(centroid, triPoints, triHeads);
  const centroidPsi = Number.isFinite(headAtCentroid) ? headAtCentroid - centroid.y : average(psiValues);
  return {
    triPoints,
    psiValues,
    centroidPsi,
    minPsi: Math.min(...psiValues, centroidPsi),
    maxPsi: Math.max(...psiValues, centroidPsi)
  };
}

function clipPolygonByScalar(points, values, keepPositive) {
  const outPoints = [];
  const outValues = [];
  const isInside = (value) => (keepPositive ? value >= -EPS : value <= EPS);
  for (let i = 0; i < points.length; i += 1) {
    const curr = points[i];
    const currValue = values[i];
    const prev = points[(i + points.length - 1) % points.length];
    const prevValue = values[(i + points.length - 1) % points.length];
    const currInside = isInside(currValue);
    const prevInside = isInside(prevValue);
    if (currInside !== prevInside) {
      const denom = prevValue - currValue;
      const t = Math.abs(denom) > EPS ? clamp(prevValue / denom, 0, 1) : 0.5;
      outPoints.push({
        x: prev.x + (curr.x - prev.x) * t,
        y: prev.y + (curr.y - prev.y) * t
      });
      outValues.push(0);
    }
    if (currInside) {
      outPoints.push(curr);
      outValues.push(currValue);
    }
  }
  return { points: cleanPolygon(outPoints), values: outValues.slice(0, outPoints.length) };
}

function triangleWetAreaFraction(triPoints, psiValues) {
  const totalArea = polygonArea(triPoints);
  if (!(totalArea > 1e-10)) return 0;
  const minPsi = Math.min(...psiValues);
  const maxPsi = Math.max(...psiValues);
  if (minPsi >= 0) return 1;
  if (maxPsi <= 0) return 0;
  const clipped = clipPolygonByScalar(triPoints, psiValues, true).points;
  const wetArea = polygonArea(clipped);
  return clamp(wetArea / totalArea, 0, 1);
}

function cellValueFromTriangles(cell, triangleValues, mesh) {
  if (!cell.triangleIndices.length) return 0;
  let totalArea = 0;
  let total = 0;
  cell.triangleIndices.forEach((triangleIndex) => {
    const area = mesh.elementData[triangleIndex].area || 0;
    totalArea += area;
    total += area * triangleValues[triangleIndex];
  });
  return totalArea > EPS ? total / totalArea : average(cell.triangleIndices.map((triangleIndex) => triangleValues[triangleIndex]));
}

function activeSeepageFacesFromFlux(
  mesh,
  heads,
  model,
  dryFlags,
  prior = null,
  tolerances = seepageIterationTolerances(mesh),
  gradients = null
) {
  const fieldGradients = gradients || computeElementGradients(mesh, heads);
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );
  return mesh.boundaryFaces.map((face, faceIndex) => {
    const bc = activeBcs.get(face.edgeKey);
    if (bc?.type !== 'seepage-face') return false;
    const grad = fieldGradients[face.elementIndex];
    if (!grad) return false;
    const facePressure = facePressureHeadMetrics(face, mesh, heads);
    const elementData = mesh.elementData[face.elementIndex];
    const kNormal = Math.max(
      elementData.kx * face.normal.x * face.normal.x + elementData.ky * face.normal.y * face.normal.y,
      MIN_CONDUCTIVITY
    );
    const fluxTol = Math.max(kNormal * tolerances.headActivateTol / Math.max(face.length, tolerances.charLength, 0.05), 1e-12);
    const fluxNormal = grad.qx * face.normal.x + grad.qy * face.normal.y;
    const priorActive = !!prior?.[faceIndex];
    if (priorActive) {
      // Active-set retention: an atmospheric seepage edge remains active only
      // while it stays near zero pressure and does not demand inward flow.
      return facePressure.psiMid >= -tolerances.headKeepTol && fluxNormal >= -fluxTol;
    }
    if (facePressure.psiMid >= tolerances.headActivateTol) return true;
    return facePressure.psiMid >= -tolerances.headActivateTol && fluxNormal > fluxTol;
  });
}

function boundaryFaceFluxMetrics(face, mesh, gradients) {
  const grad = gradients?.[face?.elementIndex];
  if (!grad) return null;
  const elementData = mesh?.elementData?.[face.elementIndex];
  if (!elementData) return null;
  const kNormal = Math.max(
    elementData.kx * face.normal.x * face.normal.x + elementData.ky * face.normal.y * face.normal.y,
    MIN_CONDUCTIVITY
  );
  const fluxNormal = grad.qx * face.normal.x + grad.qy * face.normal.y;
  return {
    grad,
    kNormal,
    fluxNormal,
    gradientNormal: Math.abs(fluxNormal) / kNormal
  };
}

function summarizeBoundaryFluxes(mesh, model, gradients, activeSeepageFaces = null, reactions = null) {
  const boundaryFaces = mesh?.boundaryFaces || [];
  const boundaryGradients = new Array(boundaryFaces.length).fill(0);
  let maxExitGradient = 0;
  let totalInflow = 0;
  let totalOutflow = 0;
  let prescribedHeadInflow = 0;
  let prescribedHeadOutflow = 0;
  let seepageFaceInflow = 0;
  let seepageFaceOutflow = 0;
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );

  boundaryFaces.forEach((face, faceIndex) => {
    const metrics = boundaryFaceFluxMetrics(face, mesh, gradients);
    if (!metrics) return;
    const bc = activeBcs.get(face.edgeKey);
    const seepageFaceActive =
      bc?.type === 'seepage-face' ? (activeSeepageFaces ? !!activeSeepageFaces[faceIndex] : true) : false;
    boundaryGradients[faceIndex] = metrics.gradientNormal;

    if (seepageFaceActive && metrics.fluxNormal > 0) {
      maxExitGradient = Math.max(maxExitGradient, metrics.gradientNormal);
    }
  });

  if (reactions) {
    const nodeTypes = dirichletBoundaryNodeTypes(mesh, model, activeSeepageFaces);
    nodeTypes.forEach((type, nodeId) => {
      if (!type) return;
      const flux = Number(reactions[nodeId]);
      if (!Number.isFinite(flux) || Math.abs(flux) <= 1e-12) return;
      const fluxMagnitude = Math.abs(flux);
      if (flux < 0) {
        totalInflow += fluxMagnitude;
        if (type === 'head') prescribedHeadInflow += fluxMagnitude;
        else seepageFaceInflow += fluxMagnitude;
        return;
      }
      totalOutflow += fluxMagnitude;
      if (type === 'head') prescribedHeadOutflow += fluxMagnitude;
      else seepageFaceOutflow += fluxMagnitude;
    });
  } else {
    boundaryFaces.forEach((face, faceIndex) => {
      const metrics = boundaryFaceFluxMetrics(face, mesh, gradients);
      if (!metrics) return;
      const fluxMagnitude = Math.abs(metrics.fluxNormal) * face.length;
      const bc = activeBcs.get(face.edgeKey);
      const usesHead = boundaryFaceUsesPrescribedHead(face, bc);
      const seepageFaceActive =
        bc?.type === 'seepage-face' ? (activeSeepageFaces ? !!activeSeepageFaces[faceIndex] : true) : false;
      if (!usesHead && !seepageFaceActive) return;

      if (metrics.fluxNormal < 0) {
        totalInflow += fluxMagnitude;
        if (usesHead) prescribedHeadInflow += fluxMagnitude;
        else if (seepageFaceActive) seepageFaceInflow += fluxMagnitude;
        return;
      }
      if (metrics.fluxNormal > 0) {
        totalOutflow += fluxMagnitude;
        if (usesHead) prescribedHeadOutflow += fluxMagnitude;
        else if (seepageFaceActive) seepageFaceOutflow += fluxMagnitude;
      }
    });
  }

  const throughFlow = Math.max(totalInflow, totalOutflow);

  return {
    boundaryGradients,
    maxExitGradient,
    totalInflow,
    totalOutflow,
    throughFlow,
    prescribedHeadInflow,
    prescribedHeadOutflow,
    seepageFaceInflow,
    seepageFaceOutflow
  };
}

function nearestDrainSegmentIndex(drain, point) {
  const vertices = drain?.vertices || [];
  if (vertices.length < 2 || !point) return 0;
  let best = null;
  const segmentCount = drain?.closed && vertices.length > 2 ? vertices.length : vertices.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (!(len2 > GEOM_EPS * GEOM_EPS)) continue;
    const t = clamp(((point.x - a.x) * abx + (point.y - a.y) * aby) / len2, 0, 1);
    const projected = { x: a.x + abx * t, y: a.y + aby * t };
    const distance = dist(point, projected);
    if (!best || distance < best.distance) best = { distance, index: i };
  }
  return best?.index || 0;
}

function drainResultSkeleton(drain, drainIndex) {
  const segmentCount = Math.max((drain?.vertices?.length || 0) - (drain?.closed ? 0 : 1), 0);
  return {
    drainId: drain?.id || `drain-${drainIndex + 1}`,
    label: drain?.label || `Drain ${drainIndex + 1}`,
    gating: drain?.gating || 'when-saturated',
    totalInflow: 0,
    perSegmentInflow: new Array(segmentCount).fill(0),
    forcedInjectionCount: 0,
    forcedInjectionFlux: 0,
    nodes: [],
    _edgeFluxes: [],
    _rawEdgeInflow: 0,
    _rawEdgeOutflow: 0,
    _reactionInflow: 0,
    _reactionOutflow: 0
  };
}

/**
 * Per-drain and per-segment flux summary.
 *
 * Reliability:
 * - Per-drain TOTAL inflow / outflow: reliable (matches Dirichlet
 *   reaction sum within scaling).
 * - Per-segment inflow distribution: APPROXIMATE. P1 elements give
 *   piecewise-constant gradients, and the reconciliation step scales
 *   raw edge fluxes to match the per-drain Dirichlet reaction total.
 *   The spatial distribution along the drain polyline is therefore a
 *   redistribution, not the FE-consistent answer. For applications
 *   requiring precise per-segment flux (e.g., differential drain
 *   loading studies), P2 elements would be needed.
 *
 * Also detects gating='always' drains acting as injection sources
 * (reaction > fluxTol at active nodes) and records them in
 * activeSetSummary.forcedInjection* so the result layer can surface a
 * warning. 'always' drains intentionally bypass the one-way Signorini
 * rule (see docs/seep/drain.md §3); the warning is the user-visible
 * contract that flags any physically invalid injection that follows.
 */
function summarizeDrainFluxes(
  mesh,
  model,
  gradients,
  activeDrainNodes = null,
  reactions = null,
  heads = null,
  options = null,
  tolerances = null
) {
  const drains = normalizeDrains(model?.drains || []);
  const entries = drainEntriesForMesh(mesh, model);
  const activeNodeIds = activeDrainNodeIdSet(mesh, model, activeDrainNodes);

  const resultsByDrainId = new Map(
    drains.map((drain, drainIndex) => [drain.id || `drain-${drainIndex + 1}`, drainResultSkeleton(drain, drainIndex)])
  );
  const edgeMap = buildEdgeMap(mesh);
  let skippedEdgeCount = 0;

  (mesh?.constraintEdges || [])
    .filter((edge) => edge.markerType === 'drain')
    .forEach((edge) => {
      const nodeIds = edge.nodeIds || [edge.n1, edge.n2];
      if (!nodeIds.every((nodeId) => activeNodeIds.has(nodeId))) return;
      const key = edge.n1 < edge.n2 ? `${edge.n1}:${edge.n2}` : `${edge.n2}:${edge.n1}`;
      const adjacency = edgeMap.get(key);
      if (!adjacency || adjacency.elements.length !== 2) {
        skippedEdgeCount += 1;
        return;
      }
      const a = mesh.nodes[edge.n1];
      const b = mesh.nodes[edge.n2];
      if (!a || !b) return;
      const length = dist(a, b);
      if (!(length > GEOM_EPS)) return;
      const [leftElementIndex, rightElementIndex] = adjacency.elements;
      const leftGradient = gradients?.[leftElementIndex];
      const rightGradient = gradients?.[rightElementIndex];
      const leftCentroid = mesh.elementData?.[leftElementIndex]?.centroid;
      if (!leftGradient || !rightGradient || !leftCentroid) return;
      const mid = { x: 0.5 * (a.x + b.x), y: 0.5 * (a.y + b.y) };
      let normal = { x: (b.y - a.y) / length, y: -(b.x - a.x) / length };
      const toEdge = { x: mid.x - leftCentroid.x, y: mid.y - leftCentroid.y };
      if (normal.x * toEdge.x + normal.y * toEdge.y < 0) normal = { x: -normal.x, y: -normal.y };
      const qEdge =
        length *
        ((leftGradient.qx - rightGradient.qx) * normal.x + (leftGradient.qy - rightGradient.qy) * normal.y);

      const drainId = edge.drainId || `drain-${(edge.drainIndex || 0) + 1}`;
      const drain = drains.find((item, index) => (item.id || `drain-${index + 1}`) === drainId);
      const result = resultsByDrainId.get(drainId);
      if (!result || !drain) return;
      const segmentIndex = nearestDrainSegmentIndex(drain, mid);
      result._edgeFluxes.push({ qEdge, segmentIndex });
      if (qEdge >= 0) result._rawEdgeInflow += qEdge;
      else result._rawEdgeOutflow += -qEdge;
    });

  const effectiveTolerances = tolerances || seepageIterationTolerances(mesh);
  let totalForcedInjectionCount = 0;
  let totalForcedInjectionFlux = 0;

  entries.forEach((entry) => {
    const result = resultsByDrainId.get(entry.drainId);
    if (!result) return;
    const node = mesh.nodes?.[entry.nodeId] || { x: 0, y: 0 };
    const isActive = drainEntryIsActive(entry, activeDrainNodes);
    const reaction = isActive && reactions ? Number(reactions[entry.nodeId]) || 0 : 0;
    if (isActive) {
      if (reaction < 0) result._reactionInflow += -reaction;
      else result._reactionOutflow += reaction;
      // Flag 'always' drains acting as a source (reaction > fluxTol).
      // For 'head-cap' / 'when-saturated' the active-set logic deactivates
      // these nodes on the next iteration, so a steady injection only
      // occurs when 'always' forces them to remain Dirichlet.
      if (entry.gating === 'always' && reaction > 0) {
        const fluxTol = drainNodeFluxTolerance(mesh, entry.nodeId, options, effectiveTolerances);
        if (reaction > fluxTol) {
          result.forcedInjectionCount += 1;
          result.forcedInjectionFlux += reaction;
          totalForcedInjectionCount += 1;
          totalForcedInjectionFlux += reaction;
        }
      }
    }
    result.nodes.push({
      nodeId: entry.nodeId,
      x: node.x,
      y: node.y,
      head: Number.isFinite(Number(heads?.[entry.nodeId])) ? Number(heads[entry.nodeId]) : entry.head,
      pressureHead: (Number.isFinite(Number(heads?.[entry.nodeId])) ? Number(heads[entry.nodeId]) : entry.head) - node.y,
      isActive,
      gated: entry.gating !== 'always' && !isActive,
      reaction,
      inflowAtNode: Math.max(-reaction, 0)
    });
  });

  let signedEdgeTotal = 0;
  let signedReactionTotal = 0;
  let drainInflow = 0;
  let drainOutflow = 0;
  resultsByDrainId.forEach((result) => {
    // P1 element fluxes are piecewise constant; normalise the two-sided edge
    // distribution to the Dirichlet reaction sum so open drain tips close mass.
    const inflowScale =
      result._rawEdgeInflow > 1e-18 ? result._reactionInflow / result._rawEdgeInflow : 0;
    const outflowScale =
      result._rawEdgeOutflow > 1e-18 ? result._reactionOutflow / result._rawEdgeOutflow : 0;
    result._edgeFluxes.forEach(({ qEdge, segmentIndex }) => {
      const corrected = qEdge >= 0 ? qEdge * inflowScale : qEdge * outflowScale;
      signedEdgeTotal += corrected;
      if (corrected >= 0) {
        drainInflow += corrected;
        result.totalInflow += corrected;
      } else {
        drainOutflow += -corrected;
      }
      if (Number.isInteger(segmentIndex) && segmentIndex >= 0 && segmentIndex < result.perSegmentInflow.length) {
        result.perSegmentInflow[segmentIndex] += corrected;
      }
    });
    signedReactionTotal += result._reactionInflow - result._reactionOutflow;
    delete result._edgeFluxes;
    delete result._rawEdgeInflow;
    delete result._rawEdgeOutflow;
    delete result._reactionInflow;
    delete result._reactionOutflow;
  });
  const perEdgeReactionDelta =
    Math.abs(signedEdgeTotal - signedReactionTotal) / Math.max(Math.abs(signedEdgeTotal), Math.abs(signedReactionTotal), 1e-12);

  return {
    drainInflow,
    drainOutflow,
    drains: [...resultsByDrainId.values()],
    activeSetSummary: {
      totalNodes: entries.length,
      activeNodes: entries.filter((entry) => drainEntryIsActive(entry, activeDrainNodes)).length,
      perEdgeReactionDelta,
      skippedEdgeCount,
      // Number of 'always'-gated drain nodes whose reaction shows the
      // drain is injecting water into the soil (forbidden by Signorini
      // complementarity). Non-zero values are surfaced as warnings.
      forcedInjectionCount: totalForcedInjectionCount,
      forcedInjectionFlux: totalForcedInjectionFlux
    }
  };
}

function segmentYAtX(segment, x, tol = 1e-8) {
  if (!Array.isArray(segment) || segment.length !== 2) return null;
  const [a, b] = segment;
  const xMin = Math.min(a.x, b.x) - tol;
  const xMax = Math.max(a.x, b.x) + tol;
  if (x < xMin || x > xMax) return null;
  const dx = b.x - a.x;
  if (Math.abs(dx) <= tol) {
    return Math.abs(x - a.x) <= tol ? Math.max(a.y, b.y) : null;
  }
  const t = (x - a.x) / dx;
  if (t < -tol || t > 1 + tol) return null;
  return lerp(a.y, b.y, clamp(t, 0, 1));
}

function simplifyOpenPolyline(points, tol = 1e-6) {
  const cleaned = [];
  (points || []).forEach((point) => {
    const next = { x: Number(point?.x), y: Number(point?.y) };
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return;
    const last = cleaned[cleaned.length - 1];
    if (!last || dist(last, next) > tol) cleaned.push(next);
  });
  if (cleaned.length <= 2) return cleaned;

  const simplified = [cleaned[0]];
  for (let i = 1; i < cleaned.length - 1; i += 1) {
    const prev = simplified[simplified.length - 1];
    const curr = cleaned[i];
    const next = cleaned[i + 1];
    const dx1 = curr.x - prev.x;
    const dy1 = curr.y - prev.y;
    const dx2 = next.x - curr.x;
    const dy2 = next.y - curr.y;
    const len1 = Math.hypot(dx1, dy1);
    const len2 = Math.hypot(dx2, dy2);
    if (!(len1 > tol) || !(len2 > tol)) continue;
    const cross = Math.abs(dx1 * dy2 - dy1 * dx2);
    if (cross <= tol * (len1 + len2)) continue;
    simplified.push(curr);
  }
  simplified.push(cleaned[cleaned.length - 1]);
  return simplified;
}

function polylineToSegments(points) {
  const out = [];
  for (let i = 0; i < (points?.length || 0) - 1; i += 1) {
    if (dist(points[i], points[i + 1]) <= GEOM_EPS) continue;
    out.push([points[i], points[i + 1]]);
  }
  return out;
}

function regularizedPhreaticEnvelopeSegments(segments, tol = 1e-5) {
  const raw = (segments || []).filter((segment) => Array.isArray(segment) && segment.length === 2);
  if (!raw.length) return [];

  const xSamples = uniqueSorted(
    raw.flatMap((segment) => [Number(segment?.[0]?.x), Number(segment?.[1]?.x)]).filter(Number.isFinite),
    tol
  );
  if (!xSamples.length) return raw;

  const envelope = xSamples
    .map((x) => {
      let highestY = null;
      raw.forEach((segment) => {
        const sampleY = segmentYAtX(segment, x, tol);
        if (!Number.isFinite(sampleY)) return;
        highestY = highestY == null ? sampleY : Math.max(highestY, sampleY);
      });
      return highestY == null ? null : { x, y: highestY };
    })
    .filter(Boolean);

  if (envelope.length <= 1) return raw;

  const descending = envelope[envelope.length - 1].y <= envelope[0].y;
  const regularized = [];
  let runningY = envelope[0].y;
  regularized.push({ x: envelope[0].x, y: runningY });

  for (let i = 1; i < envelope.length; i += 1) {
    const sample = envelope[i];
    runningY = descending ? Math.min(runningY, sample.y) : Math.max(runningY, sample.y);
    regularized.push({ x: sample.x, y: runningY });
  }

  const simplified = simplifyOpenPolyline(regularized, tol);
  return polylineToSegments(simplified);
}

function topEnvelopeContourSegments(segments, tol = 1e-5) {
  const raw = (segments || []).filter((segment) => Array.isArray(segment) && segment.length === 2);
  if (raw.length <= 1) return raw;
  return raw.filter((segment) => {
    const xMid = 0.5 * (segment[0].x + segment[1].x);
    const yMid = 0.5 * (segment[0].y + segment[1].y);
    let highestY = yMid;
    raw.forEach((other) => {
      const sampleY = segmentYAtX(other, xMid);
      if (Number.isFinite(sampleY)) highestY = Math.max(highestY, sampleY);
    });
    return yMid >= highestY - tol;
  });
}

function sampleFlowState(mesh, heads, gradients, x, y) {
  if (!mesh?.cells?.length || !pointInPolygonHalfOpen(mesh.domainPolygon || [], x, y)) return null;
  const point = { x: Number(x), y: Number(y) };
  const candidateCells = samplePointCandidates(mesh, point.x, point.y);
  for (let i = 0; i < candidateCells.length; i += 1) {
    const cell = mesh.cells[candidateCells[i]];
    if (!cell) continue;
    if (
      point.x < cell.bbox.xMin - GEOM_EPS ||
      point.x > cell.bbox.xMax + GEOM_EPS ||
      point.y < cell.bbox.yMin - GEOM_EPS ||
      point.y > cell.bbox.yMax + GEOM_EPS
    ) continue;
    if (!pointInPolygonHalfOpen(cell.polygon, point.x, point.y)) continue;
    for (let j = 0; j < cell.triangleIndices.length; j += 1) {
      const triangleIndex = cell.triangleIndices[j];
      const element = mesh.elements[triangleIndex];
      const triPoints = element.map((nodeId) => mesh.nodes[nodeId]);
      const bary = sampleTriangleValue(point, triPoints, [1, 1, 1]);
      if (!Number.isFinite(bary)) continue;
      const grad = gradients?.[triangleIndex];
      if (!grad || !heads) return null;
      const triHeads = element.map((nodeId) => heads[nodeId]);
      const head = sampleTriangleValue(point, triPoints, triHeads);
      if (!Number.isFinite(head)) return null;
      return {
        ...grad,
        head,
        psi: head - point.y,
        point,
        triangleIndex,
        cellIndex: candidateCells[i]
      };
    }
  }
  return null;
}

function boundaryIntersectionPoint(start, end, faces) {
  let best = null;
  (faces || []).forEach((face) => {
    const hit = segmentIntersection(start, end, face.a, face.b, 1e-8);
    if (!hit) return;
    if (!(hit.t > 1e-5 && hit.t <= 1 + 1e-6)) return;
    if (!best || hit.t < best.t) {
      best = {
        t: hit.t,
        point: { x: hit.x, y: hit.y },
        face
      };
    }
  });
  return best;
}

function buildFlowLineSeeds(mesh, heads, gradients, model, activeSeepageFaces, tolerances) {
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );
  const eligible = [];
  let totalWeight = 0;
  mesh.boundaryFaces.forEach((face, faceIndex) => {
    const bc = activeBcs.get(face.edgeKey);
    if (!boundaryFaceUsesPrescribedHead(face, bc)) return;
    const metrics = boundaryFaceFluxMetrics(face, mesh, gradients);
    if (!metrics || !(metrics.fluxNormal < -1e-12)) return;
    const weight = Math.max(-metrics.fluxNormal * face.length, face.length * 0.1);
    totalWeight += weight;
    eligible.push({ face, faceIndex, weight });
  });
  if (!eligible.length) return [];

  const charLength = tolerances.charLength;
  const offset = Math.max(0.12 * charLength, 0.02);
  const minSeedSpacing = Math.max(0.7 * charLength, 0.08);
  const desiredCount = clamp(
    Math.round(eligible.reduce((sum, item) => sum + item.face.length, 0) / Math.max(1.1 * charLength, 0.2)),
    6,
    24
  );
  const seeds = [];

  eligible.forEach((item) => {
    const count = Math.max(1, Math.round((desiredCount * item.weight) / Math.max(totalWeight, EPS)));
    for (let i = 0; i < count; i += 1) {
      const t = (i + 1) / (count + 1);
      const boundaryPoint = {
        x: lerp(item.face.a.x, item.face.b.x, t),
        y: lerp(item.face.a.y, item.face.b.y, t)
      };
      const point = {
        x: boundaryPoint.x - item.face.normal.x * offset,
        y: boundaryPoint.y - item.face.normal.y * offset
      };
      if (!pointInPolygonHalfOpen(mesh.domainPolygon || [], point.x, point.y)) continue;
      if (seeds.some((seed) => dist(seed.point, point) < minSeedSpacing)) continue;
      const field = sampleFlowState(mesh, heads, gradients, point.x, point.y);
      if (!field || !(field.qMagnitude > 1e-12) || field.psi < -tolerances.headActivateTol) continue;
      seeds.push({
        point,
        boundaryPoint,
        sourceEdgeKey: item.face.edgeKey,
        sourceFaceIndex: item.faceIndex
      });
    }
  });

  return seeds;
}

function findPressureHeadCrossing(mesh, heads, gradients, start, end, positiveTol) {
  const startState = sampleFlowState(mesh, heads, gradients, start.x, start.y);
  const endState = sampleFlowState(mesh, heads, gradients, end.x, end.y);
  if (!startState || startState.psi < -positiveTol) return null;
  if (endState && endState.psi >= -positiveTol) return null;
  let lo = 0;
  let hi = 1;
  let loState = startState;
  let hiState = endState;
  for (let iter = 0; iter < 20; iter += 1) {
    const midT = 0.5 * (lo + hi);
    const midPoint = {
      x: lerp(start.x, end.x, midT),
      y: lerp(start.y, end.y, midT)
    };
    const midState = sampleFlowState(mesh, heads, gradients, midPoint.x, midPoint.y);
    if (!midState) {
      hi = midT;
      hiState = null;
      continue;
    }
    if (midState.psi >= -positiveTol) {
      lo = midT;
      loState = midState;
    } else {
      hi = midT;
      hiState = midState;
    }
  }
  const crossPoint = {
    x: lerp(start.x, end.x, lo),
    y: lerp(start.y, end.y, lo)
  };
  return loState || hiState ? crossPoint : null;
}

function traceFlowLine(mesh, heads, gradients, seed, options = {}) {
  const stepLength = Math.max(Number(options.stepLength) || 0, 0.03);
  const maxSteps = Math.max(Number(options.maxSteps) || 0, 200);
  const maxLength = Math.max(Number(options.maxLength) || 0, stepLength * 10);
  const domainPolygon = mesh?.domainPolygon || [];
  const boundaryFaces = mesh?.boundaryFaces || [];
  const pressureTol = Math.max(Number(options.pressureTol) || 0, 1e-4);
  const points = [seed];
  let current = { ...seed };
  let travelled = 0;

  for (let step = 0; step < maxSteps && travelled < maxLength; step += 1) {
    const field0 = sampleFlowState(mesh, heads, gradients, current.x, current.y);
    if (!field0 || !(field0.qMagnitude > 1e-12) || field0.psi < -pressureTol) break;
    const dir0 = {
      x: field0.qx / field0.qMagnitude,
      y: field0.qy / field0.qMagnitude
    };
    const mid = {
      x: current.x + dir0.x * stepLength * 0.5,
      y: current.y + dir0.y * stepLength * 0.5
    };
    const fieldMid = sampleFlowState(mesh, heads, gradients, mid.x, mid.y) || field0;
    if (!(fieldMid.qMagnitude > 1e-12) || fieldMid.psi < -pressureTol) {
      const cross = findPressureHeadCrossing(mesh, heads, gradients, current, mid, pressureTol);
      if (cross && dist(points[points.length - 1], cross) > 1e-4) points.push(cross);
      break;
    }
    const dir = {
      x: fieldMid.qx / fieldMid.qMagnitude,
      y: fieldMid.qy / fieldMid.qMagnitude
    };
    const next = {
      x: current.x + dir.x * stepLength,
      y: current.y + dir.y * stepLength
    };
    const hit = boundaryIntersectionPoint(current, next, boundaryFaces);
    if (hit) {
      if (dist(points[points.length - 1], hit.point) > 1e-4) points.push(hit.point);
      break;
    }
    if (!pointInPolygonHalfOpen(domainPolygon, next.x, next.y)) break;
    const nextState = sampleFlowState(mesh, heads, gradients, next.x, next.y);
    if (!nextState || nextState.psi < -pressureTol) {
      const cross = findPressureHeadCrossing(mesh, heads, gradients, current, next, pressureTol);
      if (cross && dist(points[points.length - 1], cross) > 1e-4) points.push(cross);
      break;
    }
    if (points.length > 4 && points.slice(0, -3).some((point) => dist(point, next) < 0.35 * stepLength)) break;
    const advance = dist(current, next);
    if (!(advance > 1e-5)) break;
    points.push(next);
    travelled += advance;
    current = next;
  }

  return points.length >= 2 && travelled > 0.5 * stepLength ? points : null;
}

function buildFlowLines(mesh, model, heads, gradients, activeSeepageFaces) {
  const tolerances = seepageIterationTolerances(mesh);
  const charLength = tolerances.charLength;
  const seeds = buildFlowLineSeeds(mesh, heads, gradients, model, activeSeepageFaces, tolerances);
  const domain = cleanPolygon(mesh.domainPolygon || []);
  if (!domain.length || !seeds.length) return [];
  const domainBounds = pointBounds(domain);
  const domainSpan = domainBounds
    ? Math.hypot(domainBounds.xMax - domainBounds.xMin, domainBounds.yMax - domainBounds.yMin)
    : 0;
  const stepLength = Math.max(0.45 * charLength, 0.04);
  const maxLength = Math.max(2.5 * domainSpan, 8 * stepLength);
  const lines = [];

  seeds.forEach((seed) => {
    const line = traceFlowLine(mesh, heads, gradients, seed.point, {
      stepLength,
      maxSteps: 900,
      maxLength,
      pressureTol: tolerances.headActivateTol
    });
    if (!line) return;
    const totalLength = line.slice(1).reduce((sum, point, index) => sum + dist(line[index], point), 0);
    if (!(totalLength > 1.5 * stepLength)) return;
    if (lines.some((existing) => dist(existing[0], line[0]) < 0.6 * charLength)) return;
    lines.push(line);
  });

  return lines;
}

function postProcess(mesh, model, heads, dryFlags, solveMeta, options, activeSeepageFaces = null, activeDrainNodes = null) {
  const tolerances = seepageIterationTolerances(mesh);
  const gradients = computeElementGradients(mesh, heads);
  const boundaryFluxSummary =
    solveMeta.boundaryFluxSummary ||
    summarizeBoundaryFluxes(mesh, model, gradients, activeSeepageFaces, solveMeta.reactions);
  const drainFluxSummary = summarizeDrainFluxes(
    mesh,
    model,
    gradients,
    activeDrainNodes,
    solveMeta.reactions,
    heads,
    options,
    tolerances
  );
  const flowError = options.freeSurface === 'iterate' && Number.isFinite(solveMeta.flowError) ? solveMeta.flowError : null;
  const converged = solveMeta.converged !== false;
  const terminationReason =
    solveMeta.terminationReason || (options.freeSurface === 'iterate' ? 'flow-error' : 'fixed-boundary');

  const triangleHeads = mesh.elements.map((element) => average(element.map((nodeId) => heads[nodeId])));
  const elementWetFraction = mesh.elements.map((element, elementIndex) => {
    const metrics = trianglePressureHeadMetrics(mesh, heads, elementIndex);
    return triangleWetAreaFraction(metrics.triPoints, metrics.psiValues);
  });
  const cellHeads = mesh.cells.map((cell) => cellValueFromTriangles(cell, triangleHeads, mesh));
  const cellGradients = mesh.cells.map((cell) => {
    const meanQx = cellValueFromTriangles(cell, gradients.map((item) => item.qx), mesh);
    const meanQy = cellValueFromTriangles(cell, gradients.map((item) => item.qy), mesh);
    const meanDhdx = cellValueFromTriangles(cell, gradients.map((item) => item.dhdx), mesh);
    const meanDhdy = cellValueFromTriangles(cell, gradients.map((item) => item.dhdy), mesh);
    return {
      qx: meanQx,
      qy: meanQy,
      qMagnitude: Math.hypot(meanQx, meanQy),
      dhdx: meanDhdx,
      dhdy: meanDhdy,
      gradientMagnitude: Math.hypot(meanDhdx, meanDhdy)
    };
  });
  const cellWetFraction = mesh.cells.map((cell) =>
    clamp(cellValueFromTriangles(cell, elementWetFraction, mesh), 0, 1)
  );
  const cellDryMask = cellWetFraction.map((value) => value <= tolerances.wetFractionDryTol);

  const headRange = minMax(heads);
  const headMin = headRange.min ?? 0;
  const headMax = headRange.max ?? 0;
  const phreaticScalar = mesh.nodes.map((node, index) => heads[index] - node.y);
  const equipLevels = uniqueSorted(
    Array.from({ length: 9 }, (_, index) => headMin + ((headMax - headMin) * (index + 1)) / 10)
  );
  const equipotentialSegments = equipLevels.map((level) => ({
    level,
    segments: contourSegmentsForTriangles(mesh, heads, level, {
      includeElement: (elementIndex) => elementWetFraction[elementIndex] > tolerances.wetFractionDryTol,
      visibilityScalars: phreaticScalar,
      minVisibleValue: -Math.max(0.1 * tolerances.headActivateTol, 1e-6)
    })
  })).filter((group) => group.segments.length);
  const phreaticSegments = regularizedPhreaticEnvelopeSegments(
    topEnvelopeContourSegments(contourSegmentsForTriangles(mesh, phreaticScalar, 0)),
    Math.max(0.08 * tolerances.charLength, 1e-5)
  );
  const flowLines = buildFlowLines(mesh, model, heads, gradients, activeSeepageFaces);
  const dryCellCount = cellDryMask.filter(Boolean).length;
  const combinedThroughFlow = Math.max(
    boundaryFluxSummary.totalInflow + drainFluxSummary.drainInflow,
    boundaryFluxSummary.totalOutflow + drainFluxSummary.drainOutflow
  );

  const warnings = [];

  // FIX 1: surface 'always' drains that are injecting (violating
  // q_drain ≥ 0). The active-set logic deliberately leaves these
  // Dirichlet-fixed regardless of reaction sign, but the user needs
  // to know the result is physically inconsistent with the spec.
  (drainFluxSummary.drains || []).forEach((drainResult) => {
    if (!(Number(drainResult?.forcedInjectionCount) > 0)) return;
    const flux = Number(drainResult.forcedInjectionFlux) || 0;
    warnings.push({
      code: 'drain-forced-injection',
      drainId: drainResult.drainId,
      message:
        `Drain '${drainResult.label}' has gating='always' and is injecting ` +
        `${flux.toExponential(2)} m^3/s into the domain. This violates the ` +
        `one-way drain physics (q_drain >= 0) — switch to 'when-saturated' ` +
        `or 'head-cap' for physically correct behaviour.`
    });
  });

  // FIX 3: surface mass-balance failure when the active-set didn't
  // fully converge and the normalised flow-error exceeds the tolerance.
  // Otherwise the user would see a "result" with a quietly wrong mass
  // balance.
  if (options.freeSurface === 'iterate') {
    const reportedFlowError = Number.isFinite(flowError) ? flowError : null;
    const flowErrorTolerance = Math.max(
      Number(options.flowErrorTolerance) || DEFAULT_FLOW_ERROR_TOL,
      1e-6
    );
    if (
      reportedFlowError != null &&
      reportedFlowError > flowErrorTolerance &&
      reportedFlowError > DEFAULT_FLOW_ERROR_TOL
    ) {
      warnings.push({
        code: 'seepage-mass-balance',
        message:
          `Mass balance error is ${(reportedFlowError * 100).toFixed(2)}%, ` +
          `exceeding the ${(DEFAULT_FLOW_ERROR_TOL * 100).toFixed(2)}% tolerance. ` +
          `Active-set may not have converged ` +
          `(${solveMeta.activeSetIterations || 0}/${MAX_ACTIVE_SET_ITER} iterations). ` +
          `Consider checking for cycling drains or refining the mesh.`
      });
    }
  }

  return {
    heads,
    triangleHeads,
    elementHeads: triangleHeads,
    elementGradients: gradients,
    elementDryMask: dryFlags,
    elementWetFraction,
    cellHeads,
    gradients: cellGradients,
    cellGradients,
    cellWetFraction,
    dryMask: cellDryMask,
    cellDryMask,
    headMin,
    headMax,
    equipotentialSegments,
    phreaticSegments,
    flowLines,
    drains: drainFluxSummary.drains,
    boundaryGradients: boundaryFluxSummary.boundaryGradients,
    activeSeepageFaceMask: activeSeepageFaces || mesh.boundaryFaces.map((face) => face.type === 'seepage-face'),
    maxExitGradient: boundaryFluxSummary.maxExitGradient,
    throughFlow: combinedThroughFlow,
    inflow: boundaryFluxSummary.totalInflow,
    outflow: boundaryFluxSummary.totalOutflow,
    flowError,
    dryCellCount,
    disconnectedWetComponentCount: Number(solveMeta.disconnectedWetComponentCount) || 0,
    disconnectedWetElementCount: Number(solveMeta.disconnectedWetElementCount) || 0,
    warnings,
    timing: solveMeta,
    solver: {
      meshType: mesh?.kind || 'triangulated-strip-fem',
      freeSurface: options.freeSurface,
      iterations: solveMeta.outerIterations || 1,
      innerIterations: solveMeta.linearIterations || 0,
      activeSetIterations: solveMeta.activeSetIterations || 0,
      activeSetStable: solveMeta.activeSetStable !== false,
      residualNorm: solveMeta.residualNorm || 0,
      converged,
      terminationReason,
      flowError,
      flowErrorTolerance:
        options.freeSurface === 'iterate' ? Number(options.flowErrorTolerance) || DEFAULT_FLOW_ERROR_TOL : null,
      maxRuntimeMs: options.freeSurface === 'iterate' ? Number(options.maxRuntimeMs) || DEFAULT_MAX_RUNTIME_MS : null,
      disconnectedWetComponentCount: Number(solveMeta.disconnectedWetComponentCount) || 0,
      disconnectedWetElementCount: Number(solveMeta.disconnectedWetElementCount) || 0,
      connectivityFallbackApplied: !!solveMeta.connectivityFallbackApplied,
      convergenceMode: options.freeSurface === 'iterate' ? 'active-set-and-flow-balance' : 'fixed-boundary',
      boundaryFlux: {
        ...boundaryFluxSummary,
        drainInflow: drainFluxSummary.drainInflow,
        drainOutflow: drainFluxSummary.drainOutflow
      },
      activeSetSummary: {
        drains: {
          ...drainFluxSummary.activeSetSummary,
          iterationsToStable: solveMeta.activeSetIterations || 0,
          cycleDetected: !!solveMeta.cycleDetected,
          cycleDiagnostics: solveMeta.cycleDiagnostics || null
        }
      }
    }
  };
}

async function generateTriangulatedMesh(model, options, onProgress = () => {}) {
  const regions = activeRegionsFor(model);
  if (!regions.length) throw new Error('No seepage regions are available to mesh.');
  const mesh = await buildTriangleMesh(model, regions, options, onProgress);
  mesh.boundaryFaces = [];
  mesh.boundaryFaces = buildBoundaryFaces(mesh, model);
  return mesh;
}

async function solveSeepage(mesh, model, options, onProgress = () => {}, runControl = null) {
  const solveStartedAt = performance.now();
  const tolerances = seepageIterationTolerances(mesh);
  if (options.freeSurface === 'fixed') {
    if (await runCheckpoint(runControl, true)) {
      throw buildInterruptedError();
    }
    const dryFlags = mesh.elements.map((element, elementIndex) => {
      const centroid = mesh.elementData[elementIndex].centroid;
      const waterY = samplePolylineY(model.phreatic, centroid.x);
      return Number.isFinite(waterY) ? centroid.y > waterY + 1e-5 : false;
    });
    const dirichletValues = buildDirichletValues(mesh, model, options, mesh.boundaryFaces.map(() => true));
    onProgress({
      stage: 'solving',
      percent: 55,
      message: 'Solving seepage head field on the triangulated mesh...'
    });
    const headField = await solveHeadField(mesh, dryFlags, dirichletValues, null, runControl);
    if (headField.interrupted && headField.iterations <= 0) {
      throw buildInterruptedError();
    }
    return postProcess(
      mesh,
      model,
      headField.heads,
      dryFlags,
        {
          totalMs: performance.now() - solveStartedAt,
          meshMs: mesh.generatedMs,
          solveMs: performance.now() - solveStartedAt,
          postMs: 0,
          outerIterations: 1,
          linearIterations: headField.iterations,
          residualNorm: headField.residualNorm,
          converged: !headField.interrupted,
          terminationReason: headField.interrupted ? 'interrupted' : 'fixed-boundary',
          flowError: null,
          flowErrorTolerance: null,
          maxRuntimeMs: null,
          reactions: headField.reactions
        },
        options,
        mesh.boundaryFaces.map((face) => face.type === 'seepage-face')
      );
  }

  let dryFlags = mesh.elements.map((element, elementIndex) => {
    const centroid = mesh.elementData[elementIndex].centroid;
    if (options.usePhreaticAsSeed && model?.phreatic?.vertices?.length >= 2) {
      const waterY = samplePolylineY(model.phreatic, centroid.x);
      if (Number.isFinite(waterY)) return centroid.y > waterY + 1e-5;
    }
    return false;
  });
  let activeSeepageFaces = mesh.boundaryFaces.map(() => false);
  let activeDrainNodes = null;
  let heads = null;
  let linearIterations = 0;
  let residualNorm = 0;
  const flowErrorTolerance = Math.max(Number(options.flowErrorTolerance) || DEFAULT_FLOW_ERROR_TOL, 1e-6);
  const maxRuntimeMs = Math.max(Number(options.maxRuntimeMs) || DEFAULT_MAX_RUNTIME_MS, 1);
  const deadlineRunControl = withRuntimeDeadline(runControl, solveStartedAt + maxRuntimeMs);
  const anchorElements = prescribedHeadAnchorElements(mesh, model);
  let lastSolvedState = null;
  let outerIter = 0;
  while (true) {
    if (await runCheckpoint(deadlineRunControl, true)) {
      const reason = stopReason(deadlineRunControl) || 'interrupted';
      if (!lastSolvedState?.heads) {
        // Allow one partial outer solve so stop/time-limit requests can still
        // return the latest iterate instead of aborting before any state exists.
      } else {
        return postProcess(
          mesh,
          model,
          lastSolvedState.heads,
          lastSolvedState.dryFlags,
          {
            totalMs: lastSolvedState.elapsedMs,
            meshMs: mesh.generatedMs,
            solveMs: lastSolvedState.elapsedMs,
            postMs: 0,
            outerIterations: lastSolvedState.outerIterations,
            linearIterations: lastSolvedState.linearIterations,
            residualNorm: lastSolvedState.residualNorm,
            converged: false,
            terminationReason: reason === 'time-limit' ? 'time-limit' : 'interrupted',
            flowError: lastSolvedState.flowError,
            flowErrorTolerance,
            maxRuntimeMs,
            activeSetIterations: lastSolvedState.activeSetIterations,
            activeSetStable: lastSolvedState.activeSetStable,
            cycleDetected: !!lastSolvedState.cycleDetected,
            cycleDiagnostics: lastSolvedState.cycleDiagnostics || null,
            boundaryFluxSummary: lastSolvedState.boundaryFluxSummary,
            reactions: lastSolvedState.reactions
          },
          options,
          lastSolvedState.activeSeepageFaces,
          lastSolvedState.activeDrainNodes
        );
      }
    }
    outerIter += 1;
    const elapsedBeforeSolveMs = performance.now() - solveStartedAt;
    if (lastSolvedState?.heads && elapsedBeforeSolveMs >= maxRuntimeMs) {
      return postProcess(
        mesh,
        model,
        lastSolvedState.heads,
        lastSolvedState.dryFlags,
        {
          totalMs: lastSolvedState.elapsedMs,
          meshMs: mesh.generatedMs,
          solveMs: lastSolvedState.elapsedMs,
          postMs: 0,
          outerIterations: lastSolvedState.outerIterations,
          linearIterations: lastSolvedState.linearIterations,
          residualNorm: lastSolvedState.residualNorm,
          converged: false,
          terminationReason: 'time-limit',
          flowError: lastSolvedState.flowError,
          flowErrorTolerance,
          maxRuntimeMs,
          activeSetIterations: lastSolvedState.activeSetIterations,
          activeSetStable: lastSolvedState.activeSetStable,
          cycleDetected: !!lastSolvedState.cycleDetected,
          cycleDiagnostics: lastSolvedState.cycleDiagnostics || null,
          boundaryFluxSummary: lastSolvedState.boundaryFluxSummary,
          reactions: lastSolvedState.reactions
        },
        options,
        lastSolvedState.activeSeepageFaces,
        lastSolvedState.activeDrainNodes
      );
    }
    const runtimeRatio = clamp(elapsedBeforeSolveMs / maxRuntimeMs, 0, 1);
    onProgress({
      stage: 'solving',
      percent: 45 + Math.round(35 * runtimeRatio),
      message: `Iterating seepage free surface... ${secondsValueLabel(elapsedBeforeSolveMs)} / ${secondsValueLabel(maxRuntimeMs)} s`
    });
    const priorHeads = heads;
    const boundarySolve = await solveSeepageBoundaryActiveSet(
      mesh,
      model,
      options,
      dryFlags,
      activeSeepageFaces,
      heads,
      tolerances,
      deadlineRunControl,
      activeDrainNodes
    );
    if (boundarySolve.interrupted && boundarySolve.linearIterations <= 0 && !priorHeads) {
      throw boundarySolve.stopReason === 'time-limit' ? buildTimeLimitError() : buildInterruptedError();
    }
    heads = boundarySolve.heads;
    linearIterations += boundarySolve.linearIterations;
    residualNorm = boundarySolve.residualNorm;
    const solvedActiveSeepageFaces = boundarySolve.activeSeepageFaces || activeSeepageFaces;
    const solvedActiveDrainNodes = boundarySolve.activeDrainNodes || activeDrainNodes;
    const gradients = boundarySolve.gradients || computeElementGradients(mesh, heads);
    const boundaryFluxSummary =
      boundarySolve.boundaryFluxSummary ||
      summarizeBoundaryFluxes(mesh, model, gradients, solvedActiveSeepageFaces, boundarySolve.reactions);
    const drainFluxSummary = summarizeDrainFluxes(
      mesh,
      model,
      gradients,
      solvedActiveDrainNodes,
      boundarySolve.reactions,
      heads,
      options,
      tolerances
    );
    const flowError = normalizedFlowBalanceError(boundaryFluxSummary, drainFluxSummary);
    const flowErrorConverged = Number.isFinite(flowError) && flowError <= flowErrorTolerance;
    let nextActiveSeepageFaces = boundarySolve.nextActiveSeepageFaces || solvedActiveSeepageFaces;
    let nextActiveDrainNodes = boundarySolve.nextActiveDrainNodes || solvedActiveDrainNodes;
    const dryUpdate = updateDryFlagsFromHeads(
      mesh,
      heads,
      dryFlags,
      nextActiveSeepageFaces,
      tolerances
    );
    let nextDryFlags = dryUpdate.dryFlags;
    let connectivity = wetConnectivityDiagnostics(
      mesh,
      nextDryFlags.map((value) => !value),
      anchorElements
    );
    let connectivityFallbackApplied = false;
    if (connectivity.disconnectedComponentCount > 0) {
      const fallback = applyDisconnectedWetFallback(
        mesh,
        nextDryFlags,
        nextActiveSeepageFaces,
        connectivity.disconnectedWetMask
      );
      nextDryFlags = fallback.dryFlags;
      nextActiveSeepageFaces = fallback.activeSeepageFaces;
      connectivityFallbackApplied = fallback.applied;
      connectivity = wetConnectivityDiagnostics(
        mesh,
        nextDryFlags.map((value) => !value),
        anchorElements
      );
    }
    const seepageChanged = nextActiveSeepageFaces.some((value, index) => value !== activeSeepageFaces[index]);
    const elapsedMs = performance.now() - solveStartedAt;
    const admissibleState = boundarySolve.activeSetStable && connectivity.disconnectedComponentCount === 0;
    const convergedOuterSolve = outerIter >= 3 && flowErrorConverged && admissibleState;
    lastSolvedState = {
      heads,
      dryFlags,
      activeSeepageFaces: solvedActiveSeepageFaces,
      activeDrainNodes: solvedActiveDrainNodes,
      outerIterations: outerIter,
      linearIterations,
      residualNorm,
      flowError,
      elapsedMs,
      activeSetIterations: boundarySolve.activeSetIterations,
      activeSetStable: boundarySolve.activeSetStable,
      cycleDetected: !!boundarySolve.cycleDetected,
      cycleDiagnostics: boundarySolve.cycleDiagnostics || null,
      disconnectedWetComponentCount: connectivity.disconnectedComponentCount,
      disconnectedWetElementCount: connectivity.disconnectedElementCount,
      connectivityFallbackApplied,
      boundaryFluxSummary,
      reactions: boundarySolve.reactions
    };
    if (boundarySolve.interrupted) {
      const terminationReason = boundarySolve.stopReason === 'time-limit' ? 'time-limit' : 'interrupted';
      return postProcess(
        mesh,
        model,
        lastSolvedState.heads,
        lastSolvedState.dryFlags,
        {
          totalMs: elapsedMs,
          meshMs: mesh.generatedMs,
          solveMs: elapsedMs,
          postMs: 0,
          outerIterations: lastSolvedState.outerIterations,
          linearIterations: lastSolvedState.linearIterations,
          residualNorm: lastSolvedState.residualNorm,
          converged: false,
          terminationReason,
          flowError,
          flowErrorTolerance,
          maxRuntimeMs,
          activeSetIterations: boundarySolve.activeSetIterations,
          activeSetStable: boundarySolve.activeSetStable,
          cycleDetected: !!boundarySolve.cycleDetected,
          cycleDiagnostics: boundarySolve.cycleDiagnostics || null,
          disconnectedWetComponentCount: connectivity.disconnectedComponentCount,
          disconnectedWetElementCount: connectivity.disconnectedElementCount,
          connectivityFallbackApplied,
          boundaryFluxSummary: lastSolvedState.boundaryFluxSummary,
          reactions: lastSolvedState.reactions
        },
        options,
        lastSolvedState.activeSeepageFaces,
        lastSolvedState.activeDrainNodes
      );
    }
    if (convergedOuterSolve) {
      return postProcess(
        mesh,
        model,
        lastSolvedState.heads,
        lastSolvedState.dryFlags,
        {
          totalMs: elapsedMs,
          meshMs: mesh.generatedMs,
          solveMs: elapsedMs,
          postMs: 0,
          outerIterations: lastSolvedState.outerIterations,
          linearIterations: lastSolvedState.linearIterations,
          residualNorm: lastSolvedState.residualNorm,
          converged: true,
          terminationReason: 'flow-error',
          flowError,
          flowErrorTolerance,
          maxRuntimeMs,
          activeSetIterations: boundarySolve.activeSetIterations,
          activeSetStable: boundarySolve.activeSetStable,
          cycleDetected: !!boundarySolve.cycleDetected,
          cycleDiagnostics: boundarySolve.cycleDiagnostics || null,
          disconnectedWetComponentCount: connectivity.disconnectedComponentCount,
          disconnectedWetElementCount: connectivity.disconnectedElementCount,
          connectivityFallbackApplied,
          boundaryFluxSummary: lastSolvedState.boundaryFluxSummary,
          reactions: lastSolvedState.reactions
        },
        options,
        lastSolvedState.activeSeepageFaces,
        lastSolvedState.activeDrainNodes
      );
    }
    if (elapsedMs >= maxRuntimeMs) {
      return postProcess(
        mesh,
        model,
        lastSolvedState.heads,
        lastSolvedState.dryFlags,
        {
          totalMs: elapsedMs,
          meshMs: mesh.generatedMs,
          solveMs: elapsedMs,
          postMs: 0,
          outerIterations: lastSolvedState.outerIterations,
          linearIterations: lastSolvedState.linearIterations,
          residualNorm: lastSolvedState.residualNorm,
          converged: false,
          terminationReason: 'time-limit',
          flowError,
          flowErrorTolerance,
          maxRuntimeMs,
          activeSetIterations: boundarySolve.activeSetIterations,
          activeSetStable: boundarySolve.activeSetStable,
          cycleDetected: !!boundarySolve.cycleDetected,
          cycleDiagnostics: boundarySolve.cycleDiagnostics || null,
          disconnectedWetComponentCount: connectivity.disconnectedComponentCount,
          disconnectedWetElementCount: connectivity.disconnectedElementCount,
          connectivityFallbackApplied,
          boundaryFluxSummary: lastSolvedState.boundaryFluxSummary,
          reactions: lastSolvedState.reactions
        },
        options,
        lastSolvedState.activeSeepageFaces,
        lastSolvedState.activeDrainNodes
      );
    }
    dryFlags = nextDryFlags;
    activeSeepageFaces = nextActiveSeepageFaces;
    activeDrainNodes = nextActiveDrainNodes;
  }
}

function optionsFor(model) {
  const seepageOptions = model?.seepage?.options || {};
  const drainOptions = seepageOptions.drains || {};
  const drainGating = drainOptions.gatingTolerances || {};
  const autoTargetArea = defaultMeshTargetAreaForModel(model);
  const manualTargetArea = Number(seepageOptions.meshTargetArea);
  const hasExplicitManualTarget = Number.isFinite(manualTargetArea) && manualTargetArea > 0;
  const useAutoTarget =
    seepageOptions.meshTargetAreaAuto === true
      ? true
      : seepageOptions.meshTargetAreaAuto === false
        ? false
        : !hasExplicitManualTarget;
  return {
    freeSurface: seepageOptions.freeSurface === 'fixed' ? 'fixed' : 'iterate',
    flowErrorTolerance: Math.max(Number(seepageOptions.flowErrorTolerance) || DEFAULT_FLOW_ERROR_TOL, 1e-6),
    maxRuntimeMs: Math.max(Number(seepageOptions.maxRuntimeMs) || DEFAULT_MAX_RUNTIME_MS, 1),
    usePhreaticAsSeed: seepageOptions.usePhreaticAsSeed !== false,
    drains: {
      gatingTolerances: {
        activate: Number.isFinite(Number(drainGating.activate)) ? Number(drainGating.activate) : null,
        keep: Number.isFinite(Number(drainGating.keep)) ? Number(drainGating.keep) : null,
        fluxTol: Number.isFinite(Number(drainGating.fluxTol)) ? Number(drainGating.fluxTol) : null
      },
      reportPerSegmentInflow: drainOptions.reportPerSegmentInflow !== false
    },
    meshTargetArea: useAutoTarget
      ? autoTargetArea
      : Math.max(hasExplicitManualTarget ? manualTargetArea : autoTargetArea, 0.01)
  };
}

export async function analyzeSeepageModel(input, onProgress = () => {}, runControl = null) {
  const startedAt = performance.now();
  const model = input?.model;
  if (!model?.terrain?.vertices?.length || !Number.isFinite(model?.analysisBottomY)) {
    throw new Error('A valid Bishop terrain and analysis depth are required before seepage can run.');
  }
  const options = optionsFor(model);
  if (options.freeSurface === 'fixed' && (!model?.phreatic?.vertices?.length || model.phreatic.vertices.length < 2)) {
    throw new Error('Fixed phreatic seepage mode requires a drawn phreatic line.');
  }

  onProgress({
    stage: 'meshing',
    percent: 5,
    message: 'Building triangulated seepage mesh...'
  });
  const mesh = await generateTriangulatedMesh(model, options, onProgress);
  if (await runCheckpoint(runControl, true)) {
    throw buildInterruptedError();
  }
  const result = await solveSeepage(mesh, model, options, onProgress, runControl);
  onProgress({
    stage: 'post',
    percent: 95,
    message: 'Post-processing seepage results...'
  });
  result.timing = {
    ...result.timing,
    meshMs: mesh.generatedMs,
    totalMs: performance.now() - startedAt
  };
  return {
    mesh,
    result
  };
}

function samplePointCandidates(mesh, x, y) {
  if (mesh?.sampleGrid && mesh?.sampleBins) {
    const cellSize = Math.max(Number(mesh.sampleGrid.cellSize) || 0, 0.05);
    const ix = Math.floor((x - Number(mesh.sampleGrid.xMin || 0)) / cellSize);
    const iy = Math.floor((y - Number(mesh.sampleGrid.yMin || 0)) / cellSize);
    const keys = new Set();
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const key = `${ix + dx}:${iy + dy}`;
        if (mesh.sampleBins[key]) keys.add(key);
      }
    }
    return [...keys].flatMap((key) => mesh.sampleBins[key] || []);
  }
  const ix = findBin(mesh.xCoords, x);
  const iy = findBin(mesh.yCoords, y);
  const keys = new Set();
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const key = `${ix + dx}:${iy + dy}`;
      if (mesh.sampleBins[key]) keys.add(key);
    }
  }
  return [...keys].flatMap((key) => mesh.sampleBins[key] || []);
}

export function sampleSeepageHead(mesh, result, x, y) {
  if (!mesh?.cells?.length || !result?.heads?.length) return null;
  if (!pointInPolygonHalfOpen(mesh.domainPolygon || [], x, y)) return null;
  const point = { x: Number(x), y: Number(y) };
  const candidateCells = samplePointCandidates(mesh, point.x, point.y);
  for (let i = 0; i < candidateCells.length; i += 1) {
    const cell = mesh.cells[candidateCells[i]];
    if (!cell) continue;
    if (
      point.x < cell.bbox.xMin - GEOM_EPS ||
      point.x > cell.bbox.xMax + GEOM_EPS ||
      point.y < cell.bbox.yMin - GEOM_EPS ||
      point.y > cell.bbox.yMax + GEOM_EPS
    ) continue;
    if (!pointInPolygonHalfOpen(cell.polygon, point.x, point.y)) continue;
    for (let j = 0; j < cell.triangleIndices.length; j += 1) {
      const triangleIndex = cell.triangleIndices[j];
      const element = mesh.elements[triangleIndex];
      const triPoints = element.map((nodeId) => mesh.nodes[nodeId]);
      const triValues = element.map((nodeId) => result.heads[nodeId]);
      const sampled = sampleTriangleValue(point, triPoints, triValues);
      if (Number.isFinite(sampled)) return sampled;
    }
  }
  return null;
}

export function sampleSeepagePorePressure(mesh, result, x, y, gammaW = 9.81) {
  const head = sampleSeepageHead(mesh, result, x, y);
  if (!Number.isFinite(head)) return null;
  return gammaW * (head - Number(y));
}

export function sampleSeepageFlowState(mesh, result, x, y) {
  if (!mesh?.cells?.length || !result?.heads?.length) return null;
  const gradients = result?.elementGradients;
  if (!Array.isArray(gradients) || !gradients.length) return null;
  return sampleFlowState(mesh, result.heads, gradients, x, y);
}
