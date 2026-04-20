// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { buildOuterBoundary, pickOuterBoundaryEdge } from './boundary.js';
import { materialAt, pointInPolygonHalfOpen, polygonArea } from '../soil-regions.js';

const EPS = 1e-9;
const GEOM_EPS = 1e-6;
const DRY_FACTOR = 1e-4;
const WALL_K = 1e-10;
const WALL_THICKNESS = 0.1;
const DEFAULT_TARGET_AREA = 0.5;
const MAX_CG_ITER = 2500;
const CG_TOL = 1e-6;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}

function sparseMatVec(rows, vector) {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    let sum = 0;
    const row = rows[i];
    for (let j = 0; j < row.indices.length; j += 1) {
      sum += row.values[j] * vector[row.indices[j]];
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
    const diag = Math.abs(rows[i].diag) > EPS ? rows[i].diag : 1;
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
    if (!(Math.abs(denom) > EPS)) {
      return { solution: x, converged: false, iterations: iter, residualNorm };
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
      const diag = Math.abs(rows[i].diag) > EPS ? rows[i].diag : 1;
      z[i] = r[i] / diag;
    }
    const rzNew = dot(r, z);
    const beta = rzNew / Math.max(rzOld, EPS);
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

function contourSegmentsForTriangles(mesh, nodeValues, level) {
  const out = [];
  mesh.elements.forEach((element) => {
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
    if (uniqueHits.length === 2) out.push(uniqueHits);
  });
  return out;
}

function average(array) {
  if (!array.length) return 0;
  return array.reduce((sum, value) => sum + value, 0) / array.length;
}

function solveHeadField(mesh, dryFlags, dirichletValues, initial = null) {
  const rows = Array.from({ length: mesh.nodes.length }, () => new Map());
  mesh.elementData.forEach((elementData, elementIndex) => {
    const element = mesh.elements[elementIndex];
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const dry = dryFlags[elementIndex];
    const factor = dry ? DRY_FACTOR : 1;
    const kx = Math.max(Number(cell.material?.kx) || 0, WALL_K) * factor;
    const ky = Math.max(Number(cell.material?.ky) || 0, WALL_K) * factor;
    const matrix = elementMatrix(mesh.nodes, element, kx, ky);
    if (!matrix) return;
    for (let i = 0; i < 3; i += 1) {
      const row = rows[element[i]];
      for (let j = 0; j < 3; j += 1) {
        row.set(element[j], (row.get(element[j]) || 0) + matrix.ke[i][j]);
      }
    }
    mesh.elementData[elementIndex] = { ...elementData, kx, ky, area: matrix.area, dNdx: matrix.dNdx, dNdy: matrix.dNdy, centroid: matrix.centroid };
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
    const data = mesh.elementData[elementIndex];
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
      head: Number.isFinite(Number(bc?.head)) ? Number(bc.head) : null
    });
  });
  return out;
}

function buildDirichletValues(mesh, model, options, activeSeepageFaces) {
  const values = new Map();
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );

  mesh.boundaryFaces.forEach((face, faceIndex) => {
    const bc = activeBcs.get(face.edgeKey);
    if (!bc) return;
    if (bc.type === 'head') {
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

function updateDryFlags(mesh, heads) {
  return mesh.elements.map((element, elementIndex) => {
    const centroid = mesh.elementData[elementIndex].centroid;
    const triPoints = element.map((nodeId) => mesh.nodes[nodeId]);
    const triHeads = element.map((nodeId) => heads[nodeId]);
    const headAtCentroid = sampleTriangleValue(centroid, triPoints, triHeads);
    return Number.isFinite(headAtCentroid) ? centroid.y > headAtCentroid + 1e-5 : false;
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

function activeSeepageFacesFromFlux(mesh, heads, model) {
  const gradients = computeElementGradients(mesh, heads);
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );
  return mesh.boundaryFaces.map((face) => {
    const bc = activeBcs.get(face.edgeKey);
    if (bc?.type !== 'seepage-face') return false;
    const grad = gradients[face.elementIndex];
    if (!grad) return false;
    const fluxNormal = grad.qx * face.normal.x + grad.qy * face.normal.y;
    return fluxNormal > 0;
  });
}

function postProcess(mesh, model, heads, dryFlags, solveMeta, options) {
  const gradients = computeElementGradients(mesh, heads);
  const boundaryGradients = [];
  let maxExitGradient = 0;
  let totalInflow = 0;
  let totalOutflow = 0;
  const activeBcs = new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );

  mesh.boundaryFaces.forEach((face) => {
    const grad = gradients[face.elementIndex];
    const elementData = mesh.elementData[face.elementIndex];
    const kNormal = Math.max(
      elementData.kx * face.normal.x * face.normal.x + elementData.ky * face.normal.y * face.normal.y,
      WALL_K
    );
    const fluxNormal = grad.qx * face.normal.x + grad.qy * face.normal.y;
    const gradientNormal = Math.abs(fluxNormal) / kNormal;
    boundaryGradients.push(gradientNormal);
    const bc = activeBcs.get(face.edgeKey);
    if (bc?.type === 'head' && fluxNormal < 0) totalInflow += -fluxNormal * face.length;
    if (bc?.type === 'seepage-face' && fluxNormal > 0) {
      totalOutflow += fluxNormal * face.length;
      maxExitGradient = Math.max(maxExitGradient, gradientNormal);
    }
  });

  const triangleHeads = mesh.elements.map((element) => average(element.map((nodeId) => heads[nodeId])));
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
  const cellDryMask = mesh.cells.map((cell) => {
    const wetCount = cell.triangleIndices.filter((index) => !dryFlags[index]).length;
    return wetCount < Math.ceil(cell.triangleIndices.length * 0.5);
  });

  const headMin = Math.min(...heads);
  const headMax = Math.max(...heads);
  const equipLevels = uniqueSorted(
    Array.from({ length: 9 }, (_, index) => headMin + ((headMax - headMin) * (index + 1)) / 10)
  );
  const equipotentialSegments = equipLevels.map((level) => ({
    level,
    segments: contourSegmentsForTriangles(mesh, heads, level)
  }));
  const phreaticScalar = mesh.nodes.map((node, index) => heads[index] - node.y);
  const phreaticSegments = contourSegmentsForTriangles(mesh, phreaticScalar, 0);
  const dryCellCount = cellDryMask.filter(Boolean).length;

  return {
    heads,
    cellHeads,
    gradients: cellGradients,
    cellGradients,
    dryMask: cellDryMask,
    cellDryMask,
    headMin,
    headMax,
    equipotentialSegments,
    phreaticSegments,
    boundaryGradients,
    maxExitGradient,
    throughFlow: Math.max(totalInflow, totalOutflow),
    inflow: totalInflow,
    outflow: totalOutflow,
    dryCellCount,
    timing: solveMeta,
    solver: {
      meshType: 'triangulated-strip-fem',
      freeSurface: options.freeSurface,
      iterations: solveMeta.outerIterations || 1,
      innerIterations: solveMeta.linearIterations || 0,
      residualNorm: solveMeta.residualNorm || 0
    }
  };
}

function generateTriangulatedMesh(model, options, onProgress = () => {}) {
  const startedAt = performance.now();
  const domainPolygon = domainPolygonFor(model);
  if (domainPolygon.length < 3) throw new Error('A valid terrain and analysis bottom are required for seepage.');
  const regions = activeRegionsFor(model);
  if (!regions.length) throw new Error('No seepage regions are available to mesh.');
  const features = buildFeatureSegments(model, regions, options);
  const { xCoords, yCoords } = buildMeshCoordinates(model, features, options);
  const splitPiecesByCell = splitSegmentsToAtomicPieces(features.splitSegments, xCoords, yCoords);

  const nodes = [];
  const nodeIndexByKey = new Map();
  const cells = [];
  const elements = [];
  const elementCell = [];
  const elementData = [];
  const sampleBins = {};

  const getNodeId = (point) => {
    const key = nodeKey(point);
    if (!nodeIndexByKey.has(key)) {
      nodeIndexByKey.set(key, nodes.length);
      nodes.push({ x: +point.x.toFixed(8), y: +point.y.toFixed(8) });
    }
    return nodeIndexByKey.get(key);
  };

  for (let ix = 0; ix < xCoords.length - 1; ix += 1) {
    const x0 = xCoords[ix];
    const x1 = xCoords[ix + 1];
    if (!(x1 > x0 + GEOM_EPS)) continue;
    const top0 = samplePolylineY(model.terrain, x0);
    const top1 = samplePolylineY(model.terrain, x1);
    if (!Number.isFinite(top0) || !Number.isFinite(top1)) continue;
    for (let iy = 0; iy < yCoords.length - 1; iy += 1) {
      const y0 = yCoords[iy];
      const y1 = yCoords[iy + 1];
      if (y1 <= Number(model.analysisBottomY) + GEOM_EPS) continue;
      const basePolygon = buildBaseCellPolygon(x0, x1, y0, y1, top0, top1);
      if (!(polygonArea(basePolygon) > 1e-8)) continue;
      const cellKey = `${ix}:${iy}`;
      const splitPieces = splitPiecesByCell.get(cellKey) || [];
      let polygons = [basePolygon];
      splitPieces.forEach((piece) => {
        const next = [];
        polygons.forEach((polygon) => {
          const clipped = clipSegmentToConvexPolygon(piece.a, piece.b, polygon);
          if (!clipped || !(dist(clipped.a, clipped.b) > 1e-8)) {
            next.push(polygon);
            return;
          }
          const split = splitConvexPolygonByLine(polygon, clipped.a, clipped.b);
          if (!split) {
            next.push(polygon);
            return;
          }
          next.push(split[0], split[1]);
        });
        polygons = next;
      });

      polygons.forEach((polygon) => {
        const cleaned = cleanPolygon(polygon);
        if (!(polygonArea(cleaned) > 1e-8)) return;
        const centroid = polygonCentroid(cleaned);
        if (!pointInPolygonHalfOpen(domainPolygon, centroid.x, centroid.y)) return;
        const regionIndex = regionIndexAt(regions, centroid.x, centroid.y);
        if (regionIndex < 0) return;
        const material = regions[regionIndex].material || materialAt(regions, centroid.x, centroid.y);
        if (!material) return;
        const nodeIds = cleaned.map((point) => getNodeId(point));
        const triangleNodeSets = buildTrianglesForPolygon(nodeIds, cleaned);
        const triangleIndices = [];
        triangleNodeSets.forEach((triangle) => {
          const pts = triangle.map((nodeId) => nodes[nodeId]);
          const area = triangleArea(pts[0], pts[1], pts[2]);
          if (!(area > 1e-10)) return;
          let tri = triangle;
          if (segmentOrientation(pts[0], pts[1], pts[2]) < 0) tri = [triangle[0], triangle[2], triangle[1]];
          triangleIndices.push(elements.length);
          elements.push(tri);
          elementCell.push(cells.length);
          elementData.push({ area, centroid: centroidOfTriangle(nodes[tri[0]], nodes[tri[1]], nodes[tri[2]]) });
        });
        if (!triangleIndices.length) return;
        cells.push({
          polygon: cleaned,
          centroid,
          area: polygonArea(cleaned),
          material,
          regionIndex,
          triangleIndices,
          baseKey: cellKey,
          bbox: {
            xMin: Math.min(...cleaned.map((point) => point.x)),
            xMax: Math.max(...cleaned.map((point) => point.x)),
            yMin: Math.min(...cleaned.map((point) => point.y)),
            yMax: Math.max(...cleaned.map((point) => point.y))
          }
        });
        if (!sampleBins[cellKey]) sampleBins[cellKey] = [];
        sampleBins[cellKey].push(cells.length - 1);
      });
    }
    onProgress({
      stage: 'meshing',
      percent: Math.round((35 * (ix + 1)) / Math.max(xCoords.length - 1, 1)),
      message: `Building seepage mesh (${ix + 1}/${Math.max(xCoords.length - 1, 1)} x-strips)...`
    });
  }

  if (!elements.length || !cells.length) throw new Error('The seepage mesher produced no active elements.');
  const mesh = {
    kind: 'triangulated-strip-fem',
    nodes,
    elements,
    cells,
    elementCell,
    elementData,
    xCoords,
    yCoords,
    sampleBins,
    domainPolygon,
    boundaryFaces: [],
    phreaticNodeIds: [],
    generatedMs: performance.now() - startedAt
  };

  mesh.boundaryFaces = buildBoundaryFaces(mesh, model);
  const phreaticSegments = features.phreaticSegments;
  if (phreaticSegments.length) {
    mesh.phreaticNodeIds = nodes
      .map((point, index) => (pointOnPolylineSegments(phreaticSegments, point, 1e-5) ? index : -1))
      .filter((index) => index >= 0);
  }
  return mesh;
}

function solveSeepage(mesh, model, options, onProgress = () => {}) {
  const solveStartedAt = performance.now();
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
        residualNorm: headField.residualNorm
      },
      options
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
  let converged = false;
  const maxOuterIter = Math.max(Number(options.maxFreeSurfaceIter) || 30, 1);

  for (let outerIter = 1; outerIter <= maxOuterIter; outerIter += 1) {
    onProgress({
      stage: 'solving',
      percent: 45 + Math.round((35 * outerIter) / maxOuterIter),
      message: `Iterating seepage free surface (${outerIter}/${maxOuterIter})...`
    });
    const dirichletValues = buildDirichletValues(mesh, model, options, activeSeepageFaces);
    const solve = solveHeadField(mesh, dryFlags, dirichletValues, heads);
    heads = solve.heads;
    linearIterations += solve.iterations;
    residualNorm = solve.residualNorm;
    const nextDryFlags = updateDryFlags(mesh, heads);
    const nextActiveSeepageFaces = activeSeepageFacesFromFlux(mesh, heads, model);
    const dryChanged = nextDryFlags.some((value, index) => value !== dryFlags[index]);
    const seepageChanged = nextActiveSeepageFaces.some((value, index) => value !== activeSeepageFaces[index]);
    dryFlags = nextDryFlags;
    activeSeepageFaces = nextActiveSeepageFaces;
    if (!dryChanged && !seepageChanged) {
      converged = true;
      return postProcess(
        mesh,
        model,
        heads,
        dryFlags,
        {
          totalMs: performance.now() - solveStartedAt,
          meshMs: mesh.generatedMs,
          solveMs: performance.now() - solveStartedAt,
          postMs: 0,
          outerIterations: outerIter,
          linearIterations,
          residualNorm
        },
        options
      );
    }
  }

  if (!converged) {
    throw new Error('The seepage free-surface iteration did not converge within the configured iteration limit.');
  }
  return null;
}

function optionsFor(model) {
  const seepageOptions = model?.seepage?.options || {};
  return {
    freeSurface: seepageOptions.freeSurface === 'iterate' ? 'iterate' : 'fixed',
    maxFreeSurfaceIter: Math.max(Number(seepageOptions.maxFreeSurfaceIter) || 30, 1),
    usePhreaticAsSeed: seepageOptions.usePhreaticAsSeed !== false,
    meshTargetArea: Math.max(Number(seepageOptions.meshTargetArea) || DEFAULT_TARGET_AREA, 0.01)
  };
}

export function analyzeSeepageModel(input, onProgress = () => {}) {
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
  const mesh = generateTriangulatedMesh(model, options, onProgress);
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
