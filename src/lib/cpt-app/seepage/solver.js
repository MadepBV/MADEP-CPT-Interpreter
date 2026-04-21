// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { buildOuterBoundary, pickOuterBoundaryEdge } from './boundary.js';
import { materialAt, pointInPolygonHalfOpen, polygonArea } from '../soil-regions.js';
import { buildTriangleMesh } from './mesh-triangle.js';

const EPS = 1e-9;
const GEOM_EPS = 1e-6;
const DRY_FACTOR = 1e-4;
const WALL_K = 1e-10;
const MIN_CONDUCTIVITY = 1e-20;
const WALL_THICKNESS = 0.1;
const DEFAULT_TARGET_AREA = 0.05;
const DEFAULT_FLOW_ERROR_TOL = 0.01;
const DEFAULT_MAX_RUNTIME_MS = 10000;
const MAX_CG_ITER = 2500;
const CG_TOL = 1e-6;
const CG_NUMERIC_EPS = 1e-30;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
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

function pointOnPolylineSegments(segments, point, tol = GEOM_EPS) {
  return (segments || []).some((segment) => pointOnSegment(point, segment.a, segment.b, tol));
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

function polylineSegments(vertices, kind, extra = {}) {
  const out = [];
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const a = { x: Number(vertices[i].x), y: Number(vertices[i].y) };
    const b = { x: Number(vertices[i + 1].x), y: Number(vertices[i + 1].y) };
    if (!(dist(a, b) > GEOM_EPS)) continue;
    out.push({ a, b, kind, ...extra });
  }
  return out;
}

function polygonSegments(polygon, kind, extra = {}) {
  const pts = cleanPolygon(polygon);
  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!(dist(a, b) > GEOM_EPS)) continue;
    out.push({ a, b, kind, ...extra });
  }
  return out;
}

function normalizeSegmentKey(a, b, kind = '') {
  const p0 = `${a.x.toFixed(8)},${a.y.toFixed(8)}`;
  const p1 = `${b.x.toFixed(8)},${b.y.toFixed(8)}`;
  return p0 < p1 ? `${kind}:${p0}|${p1}` : `${kind}:${p1}|${p0}`;
}

function dedupeSegments(segments) {
  const seen = new Set();
  const out = [];
  (segments || []).forEach((segment) => {
    const key = normalizeSegmentKey(segment.a, segment.b, segment.kind === 'region' ? 'region' : segment.kind);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(segment);
  });
  return out;
}

function regularAxis(min, max, step) {
  const out = [];
  const span = Math.max(max - min, 0);
  const actualStep = Math.max(Number(step) || 0, 0.05);
  const n = Math.max(1, Math.ceil(span / actualStep));
  for (let i = 0; i <= n; i += 1) {
    out.push(i === n ? max : min + (span * i) / n);
  }
  return out;
}

function addSegmentLineIntersections(coordSetX, coordSetY, segments, xGuides) {
  (segments || []).forEach((segment) => {
    const ax = segment.a.x;
    const ay = segment.a.y;
    const bx = segment.b.x;
    const by = segment.b.y;
    const dx = bx - ax;
    const dy = by - ay;
    const segXMin = Math.min(ax, bx);
    const segXMax = Math.max(ax, bx);

    xGuides.forEach((x) => {
      if (Math.abs(dx) <= EPS) return;
      if (x <= segXMin + GEOM_EPS || x >= segXMax - GEOM_EPS) return;
      const t = (x - ax) / dx;
      if (t <= GEOM_EPS || t >= 1 - GEOM_EPS) return;
      const y = ay + dy * t;
      if (!Number.isFinite(y)) return;
      coordSetX.add(+x.toFixed(8));
      coordSetY.add(+y.toFixed(8));
    });
  });
}

function addPairwiseSegmentIntersections(coordSetX, coordSetY, segments) {
  for (let i = 0; i < segments.length; i += 1) {
    const ai = segments[i].a;
    const bi = segments[i].b;
    const ixMin = Math.min(ai.x, bi.x);
    const ixMax = Math.max(ai.x, bi.x);
    const iyMin = Math.min(ai.y, bi.y);
    const iyMax = Math.max(ai.y, bi.y);
    for (let j = i + 1; j < segments.length; j += 1) {
      const aj = segments[j].a;
      const bj = segments[j].b;
      if (Math.max(ixMin, Math.min(aj.x, bj.x)) > Math.min(ixMax, Math.max(aj.x, bj.x)) + GEOM_EPS) continue;
      if (Math.max(iyMin, Math.min(aj.y, bj.y)) > Math.min(iyMax, Math.max(aj.y, bj.y)) + GEOM_EPS) continue;
      const hit = segmentIntersection(ai, bi, aj, bj);
      if (!hit) continue;
      if (!Number.isFinite(hit.x) || !Number.isFinite(hit.y)) continue;
      coordSetX.add(+hit.x.toFixed(8));
      coordSetY.add(+hit.y.toFixed(8));
    }
  }
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

function domainPolygonFor(model) {
  const terrain = model?.terrain?.vertices || [];
  if (terrain.length < 2) return [];
  const rightTop = terrain[terrain.length - 1];
  const leftTop = terrain[0];
  return [
    ...terrain.map((point) => ({ x: Number(point.x), y: Number(point.y) })),
    { x: Number(rightTop.x), y: Number(model.analysisBottomY) },
    { x: Number(leftTop.x), y: Number(model.analysisBottomY) }
  ];
}

function clipPolygonBySignedDistance(polygon, signedDistance, keepPositive) {
  const subject = cleanPolygon(polygon);
  if (subject.length < 3) return [];
  const out = [];
  const isInside = (value) => (keepPositive ? value >= -GEOM_EPS : value <= GEOM_EPS);
  const intersect = (a, b) => {
    const va = signedDistance(a);
    const vb = signedDistance(b);
    const denom = va - vb;
    if (Math.abs(denom) <= EPS) return { x: b.x, y: b.y };
    const t = clamp(va / (va - vb), 0, 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };

  for (let i = 0; i < subject.length; i += 1) {
    const current = subject[i];
    const previous = subject[(i + subject.length - 1) % subject.length];
    const currentVal = signedDistance(current);
    const previousVal = signedDistance(previous);
    const currentInside = isInside(currentVal);
    const previousInside = isInside(previousVal);

    if (currentInside !== previousInside) out.push(intersect(previous, current));
    if (currentInside) out.push(current);
  }
  return cleanPolygon(out);
}

function buildBaseCellPolygon(x0, x1, y0, y1, top0, top1) {
  if (!(x1 > x0 + GEOM_EPS) || !(y1 > y0 + GEOM_EPS)) return [];
  const rect = cleanPolygon([
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 }
  ]);
  const topLineY = (point) => top0 + ((top1 - top0) * (point.x - x0)) / Math.max(x1 - x0, EPS);
  const clipped = clipPolygonBySignedDistance(rect, (point) => point.y - topLineY(point), false);
  return polygonArea(clipped) > 1e-8 ? clipped : [];
}

function clipSegmentToConvexPolygon(a, b, polygon) {
  const pts = cleanPolygon(polygon);
  if (pts.length < 3) return null;
  const tValues = [0, 1];
  for (let i = 0; i < pts.length; i += 1) {
    const c = pts[i];
    const d = pts[(i + 1) % pts.length];
    const hit = segmentIntersection(a, b, c, d);
    if (!hit) continue;
    if (hit.t > GEOM_EPS && hit.t < 1 - GEOM_EPS) tValues.push(hit.t);
  }
  const ts = uniqueSorted(tValues, 1e-8);
  for (let i = 0; i < ts.length - 1; i += 1) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (!(t1 > t0 + GEOM_EPS)) continue;
    const mid = { x: lerp(a.x, b.x, 0.5 * (t0 + t1)), y: lerp(a.y, b.y, 0.5 * (t0 + t1)) };
    if (!pointInPolygonHalfOpen(pts, mid.x, mid.y)) continue;
    return {
      a: { x: lerp(a.x, b.x, t0), y: lerp(a.y, b.y, t0) },
      b: { x: lerp(a.x, b.x, t1), y: lerp(a.y, b.y, t1) }
    };
  }
  if (pointInPolygonHalfOpen(pts, 0.5 * (a.x + b.x), 0.5 * (a.y + b.y))) {
    return { a: { ...a }, b: { ...b } };
  }
  return null;
}

function splitConvexPolygonByLine(polygon, a, b) {
  const left = clipPolygonBySignedDistance(polygon, (point) => segmentOrientation(a, b, point), true);
  const right = clipPolygonBySignedDistance(polygon, (point) => segmentOrientation(a, b, point), false);
  if (!(polygonArea(left) > 1e-8) || !(polygonArea(right) > 1e-8)) return null;
  const originalArea = polygonArea(polygon);
  const sum = polygonArea(left) + polygonArea(right);
  if (sum > originalArea * 1.05) return null;
  return [left, right];
}

function regionIndexAt(regions, x, y) {
  for (let i = (regions || []).length - 1; i >= 0; i -= 1) {
    if (pointInPolygonHalfOpen(regions[i]?.polygon || [], x, y)) return i;
  }
  return -1;
}

function wallRegionFor(wall, index) {
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
      id: `wall-auto-material-${index + 1}`,
      label: `Wall ${index + 1}`,
      color: '#5E6472',
      kx: WALL_K,
      ky: WALL_K,
      gamma: 20,
      gammaSat: 20,
      kSource: 'user'
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

function buildFeatureSegments(model, regions, options) {
  const regionSegments = dedupeSegments(
    regions.flatMap((region, index) =>
      polygonSegments(region.polygon, 'region', {
        regionIndex: index,
        regionId: region.id
      })
    )
  );
  const phreaticSegments =
    options.freeSurface === 'fixed' && model?.phreatic?.vertices?.length >= 2
      ? polylineSegments(model.phreatic.vertices, 'phreatic')
      : [];
  const terrainSegments = polylineSegments(model?.terrain?.vertices || [], 'terrain');
  return {
    regionSegments,
    phreaticSegments,
    terrainSegments,
    coordinateSegments: [...terrainSegments, ...regionSegments, ...phreaticSegments],
    splitSegments: [...regionSegments, ...phreaticSegments]
  };
}

function dedupeConstraintSegments(segments) {
  const seen = new Set();
  const out = [];
  (segments || []).forEach((segment) => {
    const key = normalizeSegmentKey(segment.a, segment.b, 'constraint');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      a: { x: +segment.a.x.toFixed(8), y: +segment.a.y.toFixed(8) },
      b: { x: +segment.b.x.toFixed(8), y: +segment.b.y.toFixed(8) },
      kind: segment.kind || 'constraint'
    });
  });
  return out;
}

function buildConstraintSegments(model, regions, options) {
  const outerBoundarySegments = buildOuterBoundary(model).map((edge) => ({
    a: { x: Number(edge.a.x), y: Number(edge.a.y) },
    b: { x: Number(edge.b.x), y: Number(edge.b.y) },
    kind: 'boundary'
  }));
  const regionSegments = dedupeConstraintSegments(
    regions.flatMap((region) => polygonSegments(region.polygon, 'region'))
  );
  const phreaticSegments =
    options.freeSurface === 'fixed' && model?.phreatic?.vertices?.length >= 2
      ? dedupeConstraintSegments(polylineSegments(model.phreatic.vertices, 'phreatic'))
      : [];
  return {
    outerBoundarySegments,
    regionSegments,
    phreaticSegments,
    all: dedupeConstraintSegments([...outerBoundarySegments, ...regionSegments, ...phreaticSegments])
  };
}

function pointParamOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > EPS) return (point.x - a.x) / dx;
  if (Math.abs(dy) > EPS) return (point.y - a.y) / dy;
  return 0;
}

function buildSplitSegments(segments, splitParams) {
  const seen = new Set();
  const out = [];
  segments.forEach((segment, index) => {
    const ts = uniqueSorted(splitParams[index], 1e-8);
    for (let i = 0; i < ts.length - 1; i += 1) {
      const t0 = ts[i];
      const t1 = ts[i + 1];
      if (!(t1 > t0 + GEOM_EPS)) continue;
      const a = {
        x: +lerp(segment.a.x, segment.b.x, t0).toFixed(8),
        y: +lerp(segment.a.y, segment.b.y, t0).toFixed(8)
      };
      const b = {
        x: +lerp(segment.a.x, segment.b.x, t1).toFixed(8),
        y: +lerp(segment.a.y, segment.b.y, t1).toFixed(8)
      };
      if (!(dist(a, b) > GEOM_EPS)) continue;
      const key = normalizeSegmentKey(a, b, 'constraint-piece');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ a, b, kind: segment.kind || 'constraint' });
    }
  });
  return out;
}

function splitConstraintSegmentsInternal(groupA, groupB = null) {
  const segments = groupB ? [...groupA, ...groupB] : [...groupA];
  const nA = groupB ? groupA.length : 0;
  const splitParams = segments.map(() => [0, 1]);
  const bboxes = segments.map((segment) => ({
    xMin: Math.min(segment.a.x, segment.b.x),
    xMax: Math.max(segment.a.x, segment.b.x),
    yMin: Math.min(segment.a.y, segment.b.y),
    yMax: Math.max(segment.a.y, segment.b.y)
  }));

  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      if (groupB && i < nA && j < nA) continue;
      const boxA = bboxes[i];
      const boxB = bboxes[j];
      if (Math.max(boxA.xMin, boxB.xMin) > Math.min(boxA.xMax, boxB.xMax) + GEOM_EPS) continue;
      if (Math.max(boxA.yMin, boxB.yMin) > Math.min(boxA.yMax, boxB.yMax) + GEOM_EPS) continue;
      const a = segments[i];
      const b = segments[j];
      const hit = segmentIntersection(a.a, a.b, b.a, b.b);
      if (hit) {
        if (hit.t > GEOM_EPS && hit.t < 1 - GEOM_EPS) splitParams[i].push(hit.t);
        if (hit.u > GEOM_EPS && hit.u < 1 - GEOM_EPS) splitParams[j].push(hit.u);
        continue;
      }

      [b.a, b.b].forEach((point) => {
        if (!pointOnSegment(point, a.a, a.b)) return;
        const t = pointParamOnSegment(point, a.a, a.b);
        if (t > GEOM_EPS && t < 1 - GEOM_EPS) splitParams[i].push(t);
      });
      [a.a, a.b].forEach((point) => {
        if (!pointOnSegment(point, b.a, b.b)) return;
        const t = pointParamOnSegment(point, b.a, b.b);
        if (t > GEOM_EPS && t < 1 - GEOM_EPS) splitParams[j].push(t);
      });
    }
  }

  return buildSplitSegments(segments, splitParams);
}

function splitConstraintSegments(segments) {
  return splitConstraintSegmentsInternal(segments || []);
}

function splitConstraintSegmentsTwoGroups(groupA, groupB) {
  return splitConstraintSegmentsInternal(groupA || [], groupB || []);
}

function buildPlanarFacesFromSegments(segments) {
  const vertices = [];
  const vertexIdByKey = new Map();
  const adjacency = new Map();

  const getVertexId = (point) => {
    const key = nodeKey(point);
    if (!vertexIdByKey.has(key)) {
      vertexIdByKey.set(key, vertices.length);
      vertices.push({ x: +point.x.toFixed(8), y: +point.y.toFixed(8) });
    }
    return vertexIdByKey.get(key);
  };

  const addHalfEdge = (from, to) => {
    if (!adjacency.has(from)) adjacency.set(from, []);
    const fromPoint = vertices[from];
    const toPoint = vertices[to];
    adjacency.get(from).push({
      to,
      angle: Math.atan2(toPoint.y - fromPoint.y, toPoint.x - fromPoint.x)
    });
  };

  (segments || []).forEach((segment) => {
    const from = getVertexId(segment.a);
    const to = getVertexId(segment.b);
    if (from === to) return;
    addHalfEdge(from, to);
    addHalfEdge(to, from);
  });

  adjacency.forEach((edges) => {
    edges.sort((left, right) => left.angle - right.angle);
  });

  const visited = new Set();
  const faces = [];

  const nextHalfEdge = (from, to) => {
    const edges = adjacency.get(to) || [];
    if (!edges.length) return null;
    const reverseIndex = edges.findIndex((edge) => edge.to === from);
    if (reverseIndex < 0) return null;
    const nextIndex = (reverseIndex - 1 + edges.length) % edges.length;
    return { from: to, to: edges[nextIndex].to };
  };

  adjacency.forEach((edges, from) => {
    edges.forEach((edge) => {
      const startKey = `${from}:${edge.to}`;
      if (visited.has(startKey)) return;
      const polygonVertexIds = [];
      let current = { from, to: edge.to };
      let closed = false;
      for (let guard = 0; guard < 2 * segments.length + 2; guard += 1) {
        const key = `${current.from}:${current.to}`;
        if (visited.has(key)) break;
        visited.add(key);
        polygonVertexIds.push(current.from);
        const next = nextHalfEdge(current.from, current.to);
        if (!next) break;
        current = next;
        if (current.from === from && current.to === edge.to) {
          closed = true;
          break;
        }
      }
      if (!closed) return;
      const polygon = cleanPolygon(polygonVertexIds.map((vertexId) => vertices[vertexId]));
      if (polygon.length < 3) return;
      if (!(polygonArea(polygon) > 1e-8)) return;
      if (polygonSignedArea(polygon) <= 1e-8) return;
      faces.push(polygon);
    });
  });

  return faces;
}

function pointInTriangle(point, a, b, c) {
  const value = sampleTriangleValue(point, [a, b, c], [1, 1, 1]);
  return Number.isFinite(value);
}

function simplifyPolygonForTriangulation(points, nodeIds) {
  const pts = [...points];
  const ids = [...nodeIds];
  let changed = true;
  while (changed && pts.length > 3) {
    changed = false;
    for (let i = 0; i < pts.length; i += 1) {
      const prev = pts[(i + pts.length - 1) % pts.length];
      const curr = pts[i];
      const next = pts[(i + 1) % pts.length];
      if (Math.abs(segmentOrientation(prev, curr, next)) > 1e-10) continue;
      if (!pointOnSegment(curr, prev, next, 1e-8)) continue;
      pts.splice(i, 1);
      ids.splice(i, 1);
      changed = true;
      break;
    }
  }
  return { points: pts, nodeIds: ids };
}

function triangulatePolygonEarClip(polygon, nodeIds) {
  if (polygon.length < 3 || polygon.length !== nodeIds.length) return [];
  const oriented =
    polygonSignedArea(polygon) >= 0
      ? { points: polygon, nodeIds }
      : { points: [...polygon].reverse(), nodeIds: [...nodeIds].reverse() };
  const simplified = simplifyPolygonForTriangulation(oriented.points, oriented.nodeIds);
  const points = simplified.points;
  const ids = simplified.nodeIds;
  if (points.length < 3) return [];
  if (points.length === 3) return [[ids[0], ids[1], ids[2]]];
  const remaining = Array.from({ length: points.length }, (_, index) => index);
  const triangles = [];

  while (remaining.length > 3) {
    let earFound = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const prevIndex = remaining[(i + remaining.length - 1) % remaining.length];
      const currIndex = remaining[i];
      const nextIndex = remaining[(i + 1) % remaining.length];
      const a = points[prevIndex];
      const b = points[currIndex];
      const c = points[nextIndex];
      if (segmentOrientation(a, b, c) <= 1e-10) continue;

      let containsVertex = false;
      for (let j = 0; j < remaining.length; j += 1) {
        const testIndex = remaining[j];
        if (testIndex === prevIndex || testIndex === currIndex || testIndex === nextIndex) continue;
        if (pointInTriangle(points[testIndex], a, b, c)) {
          containsVertex = true;
          break;
        }
      }
      if (containsVertex) continue;

      triangles.push([ids[prevIndex], ids[currIndex], ids[nextIndex]]);
      remaining.splice(i, 1);
      earFound = true;
      break;
    }

    if (!earFound) {
      // Fallback fans from a reflex vertex tend to create zero-area or inverted
      // triangles that later disappear. Returning the safe partial result keeps
      // the stiffness matrix well-posed until we add centroid insertion.
      return triangles;
    }
  }

  triangles.push([ids[remaining[0]], ids[remaining[1]], ids[remaining[2]]]);
  return triangles;
}

function orientTriangleCcw(nodes, triangle) {
  return segmentOrientation(nodes[triangle[0]], nodes[triangle[1]], nodes[triangle[2]]) >= 0
    ? triangle
    : [triangle[0], triangle[2], triangle[1]];
}

function isDelaunay(a, b, c, d) {
  const ax = a.x - d.x;
  const ay = a.y - d.y;
  const bx = b.x - d.x;
  const by = b.y - d.y;
  const cx = c.x - d.x;
  const cy = c.y - d.y;
  const det =
    (ax * ax + ay * ay) * (bx * cy - by * cx) -
    (bx * bx + by * by) * (ax * cy - ay * cx) +
    (cx * cx + cy * cy) * (ax * by - ay * bx);
  const orientation = segmentOrientation(a, b, c);
  if (Math.abs(orientation) <= EPS) return true;
  return orientation > 0 ? det <= 1e-10 : det >= -1e-10;
}

function performLawsonDelaunayFlips(nodes, elements, constrainedSegments) {
  const constrained = new Set();
  (constrainedSegments || []).forEach((segment) => {
    const nodeIdA = segment.startNodeId ?? segment.nodeIdA;
    const nodeIdB = segment.endNodeId ?? segment.nodeIdB;
    if (!Number.isInteger(nodeIdA) || !Number.isInteger(nodeIdB) || nodeIdA === nodeIdB) return;
    constrained.add(nodeIdA < nodeIdB ? `${nodeIdA}-${nodeIdB}` : `${nodeIdB}-${nodeIdA}`);
  });

  let flipped = true;
  let iter = 0;
  while (flipped && iter < 20) {
    flipped = false;
    iter += 1;

    const edgeToTris = new Map();
    for (let t = 0; t < elements.length; t += 1) {
      const tri = elements[t];
      for (let e = 0; e < 3; e += 1) {
        const i1 = tri[e];
        const i2 = tri[(e + 1) % 3];
        const key = i1 < i2 ? `${i1}-${i2}` : `${i2}-${i1}`;
        if (!edgeToTris.has(key)) edgeToTris.set(key, []);
        edgeToTris.get(key).push(t);
      }
    }

    const flipsToApply = [];
    for (const [key, tris] of edgeToTris.entries()) {
      if (tris.length !== 2 || constrained.has(key)) continue;
      const tri1 = elements[tris[0]];
      const tri2 = elements[tris[1]];
      const shared = tri1.filter((nodeId) => tri2.includes(nodeId));
      if (shared.length !== 2) continue;
      const [a, b] = shared;
      const c = tri1.find((nodeId) => nodeId !== a && nodeId !== b);
      const d = tri2.find((nodeId) => nodeId !== a && nodeId !== b);
      if (![a, b, c, d].every(Number.isInteger)) continue;

      const ptA = nodes[a];
      const ptB = nodes[b];
      const ptC = nodes[c];
      const ptD = nodes[d];
      const diagonalHit = segmentIntersection(ptC, ptD, ptA, ptB, 1e-10);
      if (!diagonalHit || diagonalHit.t <= GEOM_EPS || diagonalHit.t >= 1 - GEOM_EPS) continue;
      if (isDelaunay(ptA, ptB, ptC, ptD)) continue;

      const new1 = orientTriangleCcw(nodes, [c, d, a]);
      const new2 = orientTriangleCcw(nodes, [d, c, b]);
      if (
        triangleArea(nodes[new1[0]], nodes[new1[1]], nodes[new1[2]]) <= 1e-10 ||
        triangleArea(nodes[new2[0]], nodes[new2[1]], nodes[new2[2]]) <= 1e-10
      ) {
        continue;
      }
      flipsToApply.push({ t1: tris[0], t2: tris[1], new1, new2 });
    }

    flipsToApply.forEach((flip) => {
      elements[flip.t1] = flip.new1;
      elements[flip.t2] = flip.new2;
      flipped = true;
    });
  }
}

function splitPolygonForRefinement(polygon, depth = 0) {
  const cleaned = cleanPolygon(polygon);
  if (cleaned.length < 3) return null;
  let bestLen = 0;
  let bestNormal = null;
  for (let i = 0; i < cleaned.length; i += 1) {
    const a = cleaned[i];
    const b = cleaned[(i + 1) % cleaned.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > bestLen + GEOM_EPS)) continue;
    const mid = { x: 0.5 * (a.x + b.x), y: 0.5 * (a.y + b.y) };
    bestLen = len;
    // Split across the longest edge, not along it: the bisector line must use
    // the edge direction as its normal so we cut the polygon into two pieces.
    bestNormal = (point) => (point.x - mid.x) * (dx / len) + (point.y - mid.y) * (dy / len);
  }
  if (!bestNormal) return null;
  const left = cleanPolygon(clipPolygonBySignedDistance(cleaned, bestNormal, true));
  const right = cleanPolygon(clipPolygonBySignedDistance(cleaned, bestNormal, false));
  if (!(polygonArea(left) > 1e-8) || !(polygonArea(right) > 1e-8)) return null;
  return [left, right];
}

function refineFacePolygons(facePolygon, targetArea, depth = 0) {
  const cleaned = cleanPolygon(facePolygon);
  const area = polygonArea(cleaned);
  if (!(area > 1e-8)) return [];
  if (area <= targetArea * 1.35 || depth >= 12) return [cleaned];
  const split = splitPolygonForRefinement(cleaned, depth);
  if (!split) return [cleaned];
  return split.flatMap((piece) => refineFacePolygons(piece, targetArea, depth + 1));
}

function samplePointFromTriangles(triangleNodeSets, nodes) {
  if (!triangleNodeSets?.length) return null;
  let best = null;
  triangleNodeSets.forEach((triangle) => {
    const a = nodes[triangle[0]];
    const b = nodes[triangle[1]];
    const c = nodes[triangle[2]];
    const area = triangleArea(a, b, c);
    if (!(area > 1e-10)) return;
    if (!best || area > best.area) {
      best = {
        area,
        point: centroidOfTriangle(a, b, c)
      };
    }
  });
  return best?.point || null;
}

function buildCellSampleBins(cells, domainPolygon, targetArea) {
  const domain = cleanPolygon(domainPolygon);
  if (!cells?.length || domain.length < 3) {
    return {
      grid: {
        xMin: 0,
        yMin: 0,
        cellSize: Math.max(Math.sqrt(Number(targetArea) || DEFAULT_TARGET_AREA), 0.1)
      },
      bins: {}
    };
  }
  const xMin = Math.min(...domain.map((point) => point.x));
  const yMin = Math.min(...domain.map((point) => point.y));
  const cellSize = Math.max(Math.sqrt(Number(targetArea) || DEFAULT_TARGET_AREA), 0.1);
  const bins = {};
  cells.forEach((cell, index) => {
    const bbox = cell?.bbox || {};
    const ix0 = Math.floor((bbox.xMin - xMin) / cellSize);
    const ix1 = Math.floor((bbox.xMax - xMin) / cellSize);
    const iy0 = Math.floor((bbox.yMin - yMin) / cellSize);
    const iy1 = Math.floor((bbox.yMax - yMin) / cellSize);
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iy = iy0; iy <= iy1; iy += 1) {
        const key = `${ix}:${iy}`;
        if (!bins[key]) bins[key] = [];
        bins[key].push(index);
      }
    }
  });
  return {
    grid: { xMin, yMin, cellSize },
    bins
  };
}

function buildMeshCoordinates(model, features, options) {
  const xMin = Number(model?.terrain?.vertices?.[0]?.x);
  const xMax = Number(model?.terrain?.vertices?.[model.terrain.vertices.length - 1]?.x);
  const yMin = Number(model?.analysisBottomY);
  const terrainYs = (model?.terrain?.vertices || []).map((point) => Number(point.y)).filter(Number.isFinite);
  const yMax = Math.max(...terrainYs, yMin + 1);
  const targetLength = Math.max(Math.sqrt(Number(options?.meshTargetArea) || DEFAULT_TARGET_AREA), 0.1);

  const xRegular = regularAxis(xMin, xMax, targetLength);
  const yRegular = regularAxis(yMin, yMax, targetLength);
  const coordSetX = new Set(xRegular.map((value) => +value.toFixed(8)));
  const coordSetY = new Set(yRegular.map((value) => +value.toFixed(8)));

  [...features.coordinateSegments].forEach((segment) => {
    [segment.a, segment.b].forEach((point) => {
      if (point.x >= xMin - GEOM_EPS && point.x <= xMax + GEOM_EPS) {
        coordSetX.add(+point.x.toFixed(8));
      }
      if (segment.kind === 'region' && point.y >= yMin - GEOM_EPS && point.y <= yMax + GEOM_EPS) {
        coordSetY.add(+point.y.toFixed(8));
      }
    });
  });

  return {
    xCoords: uniqueSorted([...coordSetX]),
    yCoords: uniqueSorted([...coordSetY])
  };
}

function splitSegmentsToAtomicPieces(segments, xCoords, yCoords) {
  const byCell = new Map();
  const seen = new Set();
  const bboxes = (segments || []).map((segment) => ({
    xMin: Math.min(segment.a.x, segment.b.x),
    xMax: Math.max(segment.a.x, segment.b.x),
    yMin: Math.min(segment.a.y, segment.b.y),
    yMax: Math.max(segment.a.y, segment.b.y)
  }));

  (segments || []).forEach((segment, segmentIndex) => {
    const tValues = [0, 1];
    const dx = segment.b.x - segment.a.x;
    const dy = segment.b.y - segment.a.y;

    if (Math.abs(dx) > EPS) {
      xCoords.forEach((x) => {
        if (x <= Math.min(segment.a.x, segment.b.x) + GEOM_EPS) return;
        if (x >= Math.max(segment.a.x, segment.b.x) - GEOM_EPS) return;
        const t = (x - segment.a.x) / dx;
        if (t > GEOM_EPS && t < 1 - GEOM_EPS) tValues.push(t);
      });
    }

    if (Math.abs(dy) > EPS) {
      yCoords.forEach((y) => {
        if (y <= Math.min(segment.a.y, segment.b.y) + GEOM_EPS) return;
        if (y >= Math.max(segment.a.y, segment.b.y) - GEOM_EPS) return;
        const t = (y - segment.a.y) / dy;
        if (t > GEOM_EPS && t < 1 - GEOM_EPS) tValues.push(t);
      });
    }

    const bbox = bboxes[segmentIndex];
    for (let otherIndex = 0; otherIndex < segments.length; otherIndex += 1) {
      if (otherIndex === segmentIndex) continue;
      const other = segments[otherIndex];
      const otherBox = bboxes[otherIndex];
      if (Math.max(bbox.xMin, otherBox.xMin) > Math.min(bbox.xMax, otherBox.xMax) + GEOM_EPS) continue;
      if (Math.max(bbox.yMin, otherBox.yMin) > Math.min(bbox.yMax, otherBox.yMax) + GEOM_EPS) continue;
      const hit = segmentIntersection(segment.a, segment.b, other.a, other.b);
      if (!hit) continue;
      if (hit.t > GEOM_EPS && hit.t < 1 - GEOM_EPS) tValues.push(hit.t);
    }

    const ts = uniqueSorted(tValues, 1e-8);
    for (let i = 0; i < ts.length - 1; i += 1) {
      const t0 = ts[i];
      const t1 = ts[i + 1];
      if (!(t1 > t0 + GEOM_EPS)) continue;
      const a = { x: lerp(segment.a.x, segment.b.x, t0), y: lerp(segment.a.y, segment.b.y, t0) };
      const b = { x: lerp(segment.a.x, segment.b.x, t1), y: lerp(segment.a.y, segment.b.y, t1) };
      if (!(dist(a, b) > GEOM_EPS)) continue;
      const key = normalizeSegmentKey(a, b, segment.kind);
      if (seen.has(key)) continue;
      seen.add(key);
      const mid = { x: 0.5 * (a.x + b.x), y: 0.5 * (a.y + b.y) };
      const ix = findBin(xCoords, mid.x);
      const iy = findBin(yCoords, mid.y);
      if (ix < 0 || iy < 0) continue;
      const cellKey = `${ix}:${iy}`;
      const piece = {
        a,
        b,
        kind: segment.kind,
        regionIndex: segment.regionIndex ?? null,
        regionId: segment.regionId ?? null
      };
      if (!byCell.has(cellKey)) byCell.set(cellKey, []);
      byCell.get(cellKey).push(piece);
    }
  });

  return byCell;
}

function nodeKey(point) {
  return `${point.x.toFixed(8)},${point.y.toFixed(8)}`;
}

function chooseQuadDiagonal(a, b, c, d) {
  const ac = dist(a, c);
  const bd = dist(b, d);
  return ac <= bd ? 'ac' : 'bd';
}

function buildTrianglesForPolygon(nodeIds, polygon) {
  const triangles = [];
  if (nodeIds.length === 3) {
    triangles.push([nodeIds[0], nodeIds[1], nodeIds[2]]);
    return triangles;
  }
  for (let i = 1; i < nodeIds.length - 1; i += 1) {
    triangles.push([nodeIds[0], nodeIds[i], nodeIds[i + 1]]);
  }
  return triangles;
}

function triangleArea(a, b, c) {
  return 0.5 * Math.abs(segmentOrientation(a, b, c));
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

function solveCg(rows, rhs, initial = null, maxIter = MAX_CG_ITER, tol = CG_TOL) {
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

function average(array) {
  if (!array.length) return 0;
  return array.reduce((sum, value) => sum + value, 0) / array.length;
}

function maxAbsDiff(left, right) {
  if (!left || !right || left.length !== right.length) return Infinity;
  let max = 0;
  for (let i = 0; i < left.length; i += 1) {
    max = Math.max(max, Math.abs((left[i] || 0) - (right[i] || 0)));
  }
  return max;
}

function relativeChange(current, prior, floor = 1e-12) {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) return Infinity;
  const denominator = Math.max(Math.abs(current), Math.abs(prior), floor);
  return Math.abs(current - prior) / denominator;
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

function stateSignature(dryFlags, activeSeepageFaces) {
  const dry = (dryFlags || []).map((value) => (value ? '1' : '0')).join('');
  const faces = (activeSeepageFaces || []).map((value) => (value ? '1' : '0')).join('');
  return `${dry}|${faces}`;
}

function solveHeadField(mesh, dryFlags, dirichletValues, initial = null) {
  const rows = Array.from({ length: mesh.nodes.length }, () => new Map());
  const conductivities = mesh.elementData.map((elementData, elementIndex) => {
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const dry = !!dryFlags[elementIndex];
    const kx = effectiveElementConductivity(cell.material?.kx, dry);
    const ky = effectiveElementConductivity(cell.material?.ky, dry);
    return { kx, ky };
  });
  const conductivityScale = Math.max(
    ...conductivities.flatMap((item) => [item.kx, item.ky]),
    MIN_CONDUCTIVITY
  );

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
  const cg = solveCg(compressed.rows, compressed.rhs, initialFree);
  if (!cg.converged) {
    throw new Error(`Seepage linear solve did not converge (residual ${cg.residualNorm.toExponential(2)} after ${cg.iterations} iterations).`);
  }

  const heads = new Float64Array(mesh.nodes.length);
  dirichletValues.forEach((value, nodeId) => {
    heads[nodeId] = value;
  });
  freeNodes.forEach((nodeId, rowIndex) => {
    heads[nodeId] = cg.solution[rowIndex];
  });
  return {
    heads,
    iterations: cg.iterations,
    residualNorm: cg.residualNorm
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

function buildDirichletValues(mesh, model, options, activeSeepageFaces) {
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

  return values;
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

function updateDryFlags(mesh, heads, prior = null, tolerances = seepageIterationTolerances(mesh)) {
  return mesh.elements.map((element, elementIndex) => {
    const priorDry = typeof prior?.[elementIndex] === 'boolean' ? prior[elementIndex] : null;
    const metrics = trianglePressureHeadMetrics(mesh, heads, elementIndex);
    const wetFraction = triangleWetAreaFraction(metrics.triPoints, metrics.psiValues);
    if (wetFraction <= tolerances.wetFractionDryTol && metrics.centroidPsi <= tolerances.headActivateTol) return true;
    if (wetFraction >= tolerances.wetFractionWetTol && metrics.centroidPsi >= -tolerances.headActivateTol) return false;
    if (priorDry != null) return priorDry;
    return metrics.centroidPsi < 0;
  });
}

function activeSeepageFacesFromDry(mesh, dryFlags, model) {
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );
  return mesh.boundaryFaces.map((face) => {
    const bc = activeBcs.get(face.edgeKey);
    if (bc?.type !== 'seepage-face') return false;
    return !dryFlags[face.elementIndex];
  });
}

function activeSeepageFacesFromFlux(mesh, heads, model, dryFlags, prior = null, tolerances = seepageIterationTolerances(mesh)) {
  const gradients = computeElementGradients(mesh, heads);
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );
  return mesh.boundaryFaces.map((face, faceIndex) => {
    const bc = activeBcs.get(face.edgeKey);
    if (bc?.type !== 'seepage-face') return false;
    const grad = gradients[face.elementIndex];
    if (!grad) return false;
    const facePressure = facePressureHeadMetrics(face, mesh, heads);
    if (dryFlags?.[face.elementIndex] && facePressure.maxPsi < tolerances.headActivateTol) return false;
    const elementData = mesh.elementData[face.elementIndex];
    const kNormal = Math.max(
      elementData.kx * face.normal.x * face.normal.x + elementData.ky * face.normal.y * face.normal.y,
      MIN_CONDUCTIVITY
    );
    const fluxTol = Math.max(kNormal * tolerances.headActivateTol / Math.max(face.length, tolerances.charLength, 0.05), 1e-12);
    const fluxNormal = grad.qx * face.normal.x + grad.qy * face.normal.y;
    const priorActive = !!prior?.[faceIndex];
    if (priorActive) {
      // Once a seepage face is clamped to h = y, pressure head alone can no longer
      // tell us whether it should stay active. Require non-inward flux so an
      // initially wet seed cannot pin the free surface above its physical exit point.
      return facePressure.psiMid >= -tolerances.headKeepTol && fluxNormal >= 0;
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

function summarizeBoundaryFluxes(mesh, model, gradients, activeSeepageFaces = null) {
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
    const fluxMagnitude = Math.abs(metrics.fluxNormal) * face.length;
    const bc = activeBcs.get(face.edgeKey);
    const usesHead = boundaryFaceUsesPrescribedHead(face, bc);
    const seepageFaceActive =
      bc?.type === 'seepage-face' ? (activeSeepageFaces ? !!activeSeepageFaces[faceIndex] : true) : false;
    boundaryGradients[faceIndex] = metrics.gradientNormal;

    if (seepageFaceActive && metrics.fluxNormal > 0) {
      maxExitGradient = Math.max(maxExitGradient, metrics.gradientNormal);
    }
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
  const xValues = domain.map((point) => point.x);
  const yValues = domain.map((point) => point.y);
  const domainSpan = Math.hypot(Math.max(...xValues) - Math.min(...xValues), Math.max(...yValues) - Math.min(...yValues));
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

function postProcess(mesh, model, heads, dryFlags, solveMeta, options, activeSeepageFaces = null) {
  const tolerances = seepageIterationTolerances(mesh);
  const gradients = computeElementGradients(mesh, heads);
  const boundaryFluxSummary = summarizeBoundaryFluxes(mesh, model, gradients, activeSeepageFaces);
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

  const headMin = Math.min(...heads);
  const headMax = Math.max(...heads);
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
  const phreaticSegments = topEnvelopeContourSegments(contourSegmentsForTriangles(mesh, phreaticScalar, 0));
  const flowLines = buildFlowLines(mesh, model, heads, gradients, activeSeepageFaces);
  const dryCellCount = cellDryMask.filter(Boolean).length;

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
    boundaryGradients: boundaryFluxSummary.boundaryGradients,
    activeSeepageFaceMask: activeSeepageFaces || mesh.boundaryFaces.map((face) => face.type === 'seepage-face'),
    maxExitGradient: boundaryFluxSummary.maxExitGradient,
    throughFlow: boundaryFluxSummary.throughFlow,
    inflow: boundaryFluxSummary.totalInflow,
    outflow: boundaryFluxSummary.totalOutflow,
    flowError,
    dryCellCount,
    timing: solveMeta,
    solver: {
      meshType: mesh?.kind || 'triangulated-strip-fem',
      freeSurface: options.freeSurface,
      iterations: solveMeta.outerIterations || 1,
      innerIterations: solveMeta.linearIterations || 0,
      residualNorm: solveMeta.residualNorm || 0,
      converged,
      terminationReason,
      flowError,
      flowErrorTolerance:
        options.freeSurface === 'iterate' ? Number(options.flowErrorTolerance) || DEFAULT_FLOW_ERROR_TOL : null,
      maxRuntimeMs: options.freeSurface === 'iterate' ? Number(options.maxRuntimeMs) || DEFAULT_MAX_RUNTIME_MS : null,
      convergenceMode: options.freeSurface === 'iterate' ? 'state-and-flow-error' : 'fixed-boundary'
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

function solveSeepage(mesh, model, options, onProgress = () => {}) {
  const solveStartedAt = performance.now();
  const tolerances = seepageIterationTolerances(mesh);
  if (options.freeSurface === 'fixed') {
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
    const headField = solveHeadField(mesh, dryFlags, dirichletValues);
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
          converged: true,
          terminationReason: 'fixed-boundary',
          flowError: null,
          flowErrorTolerance: null,
          maxRuntimeMs: null
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
  let activeSeepageFaces = activeSeepageFacesFromDry(mesh, dryFlags, model);
  let heads = null;
  let linearIterations = 0;
  let residualNorm = 0;
  const maxOuterIter = Math.max(Number(options.maxFreeSurfaceIter) || 30, 1);
  const flowErrorTolerance = Math.max(Number(options.flowErrorTolerance) || DEFAULT_FLOW_ERROR_TOL, 1e-6);
  const maxRuntimeMs = Math.max(Number(options.maxRuntimeMs) || DEFAULT_MAX_RUNTIME_MS, 1);
  let priorThroughFlow = null;
  let priorSignature = stateSignature(dryFlags, activeSeepageFaces);
  let priorPriorSignature = null;
  let lastSolvedState = null;
  for (let outerIter = 1; outerIter <= maxOuterIter; outerIter += 1) {
    onProgress({
      stage: 'solving',
      percent: 45 + Math.round((35 * outerIter) / maxOuterIter),
      message: `Iterating seepage free surface (${outerIter}/${maxOuterIter})...`
    });
    const dirichletValues = buildDirichletValues(mesh, model, options, activeSeepageFaces);
    const priorHeads = heads;
    const solve = solveHeadField(mesh, dryFlags, dirichletValues, heads);
    heads = solve.heads;
    linearIterations += solve.iterations;
    residualNorm = solve.residualNorm;
    const headChange = maxAbsDiff(priorHeads, heads);
    const gradients = computeElementGradients(mesh, heads);
    const boundaryFluxSummary = summarizeBoundaryFluxes(mesh, model, gradients, activeSeepageFaces);
    const flowError = Number.isFinite(priorThroughFlow) ? relativeChange(boundaryFluxSummary.throughFlow, priorThroughFlow) : null;
    const flowErrorConverged = Number.isFinite(flowError) && flowError <= flowErrorTolerance;
    const nextDryFlags = updateDryFlags(mesh, heads, dryFlags, tolerances);
    const nextActiveSeepageFaces = activeSeepageFacesFromFlux(mesh, heads, model, nextDryFlags, activeSeepageFaces, tolerances);
    const dryChanged = nextDryFlags.some((value, index) => value !== dryFlags[index]);
    const seepageChanged = nextActiveSeepageFaces.some((value, index) => value !== activeSeepageFaces[index]);
    const nextSignature = stateSignature(nextDryFlags, nextActiveSeepageFaces);
    const elapsedMs = performance.now() - solveStartedAt;
    const stateStable = !dryChanged && !seepageChanged;
    const cyclingStable = headChange <= tolerances.headConvergeTol && nextSignature === priorPriorSignature;
    lastSolvedState = {
      heads,
      dryFlags,
      activeSeepageFaces,
      outerIterations: outerIter,
      linearIterations,
      residualNorm,
      flowError,
      elapsedMs
    };
    if ((stateStable || cyclingStable) && flowErrorConverged) {
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
          maxRuntimeMs
        },
        options,
        lastSolvedState.activeSeepageFaces
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
          maxRuntimeMs
        },
        options,
        lastSolvedState.activeSeepageFaces
      );
    }
    dryFlags = nextDryFlags;
    activeSeepageFaces = nextActiveSeepageFaces;
    priorThroughFlow = boundaryFluxSummary.throughFlow;
    priorPriorSignature = priorSignature;
    priorSignature = nextSignature;
  }

  if (!lastSolvedState?.heads) {
    throw new Error('The seepage free-surface iteration did not produce a usable head field.');
  }
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
      terminationReason: 'iteration-limit',
      flowError: lastSolvedState.flowError,
      flowErrorTolerance,
      maxRuntimeMs
    },
    options,
    lastSolvedState.activeSeepageFaces
  );
}

function optionsFor(model) {
  const seepageOptions = model?.seepage?.options || {};
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
    maxFreeSurfaceIter: Math.max(Number(seepageOptions.maxFreeSurfaceIter) || 30, 1),
    flowErrorTolerance: Math.max(Number(seepageOptions.flowErrorTolerance) || DEFAULT_FLOW_ERROR_TOL, 1e-6),
    maxRuntimeMs: Math.max(Number(seepageOptions.maxRuntimeMs) || DEFAULT_MAX_RUNTIME_MS, 1),
    usePhreaticAsSeed: seepageOptions.usePhreaticAsSeed !== false,
    meshTargetArea: useAutoTarget
      ? autoTargetArea
      : Math.max(hasExplicitManualTarget ? manualTargetArea : autoTargetArea, 0.01)
  };
}

export async function analyzeSeepageModel(input, onProgress = () => {}) {
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
  const result = solveSeepage(mesh, model, options, onProgress);
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
