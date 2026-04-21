// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { buildOuterBoundary } from './boundary.js';

const EPS = 1e-9;
const GEOM_EPS = 1e-6;
const SNAP_DECIMALS = 6;
const SEGMENT_PRIORITY = {
  region: 1,
  phreatic: 2,
  outer: 3
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function dist(a, b) {
  return Math.hypot((b?.x || 0) - (a?.x || 0), (b?.y || 0) - (a?.y || 0));
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

function cleanPolygon(points) {
  const cleaned = [];
  (points || []).forEach((point) => {
    const pt = { x: Number(point?.x), y: Number(point?.y) };
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    const last = cleaned[cleaned.length - 1];
    if (!last || dist(last, pt) > GEOM_EPS) cleaned.push(pt);
  });
  if (cleaned.length > 1 && dist(cleaned[0], cleaned[cleaned.length - 1]) <= GEOM_EPS) cleaned.pop();
  if (polygonSignedArea(cleaned) < 0) cleaned.reverse();
  return cleaned;
}

function polylineSegments(vertices, extra) {
  const out = [];
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const a = { x: Number(vertices[i]?.x), y: Number(vertices[i]?.y) };
    const b = { x: Number(vertices[i + 1]?.x), y: Number(vertices[i + 1]?.y) };
    if (!(dist(a, b) > GEOM_EPS)) continue;
    out.push({ a, b, ...extra });
  }
  return out;
}

function polygonSegments(polygon, extra) {
  const pts = cleanPolygon(polygon);
  const out = [];
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (!(dist(a, b) > GEOM_EPS)) continue;
    out.push({ a, b, ...extra });
  }
  return out;
}

function domainPolygonFor(model) {
  const terrain = model?.terrain?.vertices || [];
  if (terrain.length < 2) return [];
  const left = terrain[0];
  const right = terrain[terrain.length - 1];
  return cleanPolygon([
    ...terrain.map((point) => ({ x: Number(point.x), y: Number(point.y) })),
    { x: Number(right.x), y: Number(model.analysisBottomY) },
    { x: Number(left.x), y: Number(model.analysisBottomY) }
  ]);
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
  if (Math.abs(denom) <= tol) return null;
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

function pointParamOnSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > EPS) return (point.x - a.x) / dx;
  if (Math.abs(dy) > EPS) return (point.y - a.y) / dy;
  return 0;
}

function segmentKey(segment) {
  const p0 = `${segment.a.x.toFixed(SNAP_DECIMALS)},${segment.a.y.toFixed(SNAP_DECIMALS)}`;
  const p1 = `${segment.b.x.toFixed(SNAP_DECIMALS)},${segment.b.y.toFixed(SNAP_DECIMALS)}`;
  return p0 < p1 ? `${p0}|${p1}` : `${p1}|${p0}`;
}

function buildSplitSegments(segments, splitParams) {
  const out = [];
  segments.forEach((segment, index) => {
    const ts = uniqueSorted(splitParams[index], 1e-8);
    for (let i = 0; i < ts.length - 1; i += 1) {
      const t0 = ts[i];
      const t1 = ts[i + 1];
      if (!(t1 > t0 + GEOM_EPS)) continue;
      const a = {
        x: +lerp(segment.a.x, segment.b.x, t0).toFixed(SNAP_DECIMALS),
        y: +lerp(segment.a.y, segment.b.y, t0).toFixed(SNAP_DECIMALS)
      };
      const b = {
        x: +lerp(segment.a.x, segment.b.x, t1).toFixed(SNAP_DECIMALS),
        y: +lerp(segment.a.y, segment.b.y, t1).toFixed(SNAP_DECIMALS)
      };
      if (!(dist(a, b) > GEOM_EPS)) continue;
      out.push({ ...segment, a, b });
    }
  });
  return out;
}

function splitConstraintSegments(segments) {
  const splitParams = (segments || []).map(() => [0, 1]);
  const bboxes = (segments || []).map((segment) => ({
    xMin: Math.min(segment.a.x, segment.b.x),
    xMax: Math.max(segment.a.x, segment.b.x),
    yMin: Math.min(segment.a.y, segment.b.y),
    yMax: Math.max(segment.a.y, segment.b.y)
  }));

  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
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

function segmentMaxLength(segment, targetLength) {
  const base = Math.max(Number(targetLength) || 0, 0.1);
  if (segment.kind === 'phreatic') return Math.max(base * 0.6, 0.05);
  if (segment.kind === 'outer') return Math.max(base * 0.8, 0.05);
  if (segment.regionSource === 'wall-auto') return Math.max(base * 0.4, 0.03);
  return base;
}

function densifySegments(segments, targetLength) {
  const out = [];
  (segments || []).forEach((segment) => {
    const length = dist(segment.a, segment.b);
    const maxLength = segmentMaxLength(segment, targetLength);
    const parts = Math.max(1, Math.ceil(length / Math.max(maxLength, 0.01)));
    for (let i = 0; i < parts; i += 1) {
      const t0 = i / parts;
      const t1 = (i + 1) / parts;
      const a = {
        x: +lerp(segment.a.x, segment.b.x, t0).toFixed(SNAP_DECIMALS),
        y: +lerp(segment.a.y, segment.b.y, t0).toFixed(SNAP_DECIMALS)
      };
      const b = {
        x: +lerp(segment.a.x, segment.b.x, t1).toFixed(SNAP_DECIMALS),
        y: +lerp(segment.a.y, segment.b.y, t1).toFixed(SNAP_DECIMALS)
      };
      if (!(dist(a, b) > GEOM_EPS)) continue;
      out.push({ ...segment, a, b });
    }
  });
  return out;
}

function dedupeSegmentsByPriority(segments) {
  const map = new Map();
  (segments || []).forEach((segment) => {
    const key = segmentKey(segment);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, segment);
      return;
    }
    const existingPriority = existing.priority || 0;
    const nextPriority = segment.priority || 0;
    if (nextPriority > existingPriority) {
      map.set(key, segment);
      return;
    }
    if (nextPriority === existingPriority && (segment.markerId || 0) < (existing.markerId || 0)) {
      map.set(key, segment);
    }
  });
  return [...map.values()];
}

function pointKey(point) {
  return `${point.x.toFixed(SNAP_DECIMALS)},${point.y.toFixed(SNAP_DECIMALS)}`;
}

function outerMarkerInfo(edge, extra = {}) {
  return {
    markerType: 'outer',
    edgeKey: edge.edgeKey,
    source: edge.source,
    sourceIndex: edge.index,
    ...extra
  };
}

function headBcMapFor(model) {
  return new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned' && bc?.type === 'head') || [])
      .filter((bc) => Number.isFinite(Number(bc?.head)))
      .map((bc) => [bc.edgeKey, Number(bc.head)])
  );
}

function splitOuterBoundarySegmentsForHead(edge, headValue, allocateMarker) {
  const a = { x: Number(edge?.a?.x), y: Number(edge?.a?.y) };
  const b = { x: Number(edge?.b?.x), y: Number(edge?.b?.y) };
  const base = {
    a,
    b,
    kind: 'outer',
    priority: SEGMENT_PRIORITY.outer
  };
  if (!Number.isFinite(headValue)) {
    return [
      {
        ...base,
        markerId: allocateMarker(outerMarkerInfo(edge))
      }
    ];
  }

  const yMin = Math.min(a.y, b.y);
  const yMax = Math.max(a.y, b.y);
  const classifyPiece = (start, end) => Math.max(start.y, end.y) <= headValue + GEOM_EPS;
  if (!(headValue > yMin + GEOM_EPS && headValue < yMax - GEOM_EPS) || Math.abs(a.y - b.y) <= GEOM_EPS) {
    return [
      {
        ...base,
        markerId: allocateMarker(
          outerMarkerInfo(edge, {
            headSubmerged: classifyPiece(a, b),
            headValue
          })
        )
      }
    ];
  }

  const t = clamp((headValue - a.y) / (b.y - a.y), 0, 1);
  const splitPoint = {
    x: +lerp(a.x, b.x, t).toFixed(SNAP_DECIMALS),
    y: +lerp(a.y, b.y, t).toFixed(SNAP_DECIMALS)
  };
  const pieces = [
    { a, b: splitPoint },
    { a: splitPoint, b }
  ].filter((segment) => dist(segment.a, segment.b) > GEOM_EPS);

  return pieces.map((segment) => ({
    ...segment,
    kind: 'outer',
    priority: SEGMENT_PRIORITY.outer,
    markerId: allocateMarker(
      outerMarkerInfo(edge, {
        headSubmerged: classifyPiece(segment.a, segment.b),
        headValue
      })
    )
  }));
}

export function buildSeepagePslg(model, regions, options) {
  const domainPolygon = domainPolygonFor(model);
  if (domainPolygon.length < 3) {
    throw new Error('A valid seepage domain boundary is required before meshing.');
  }

  let nextMarkerId = 1;
  const markerInfoById = new Map();
  const allocateMarker = (info) => {
    const markerId = nextMarkerId;
    nextMarkerId += 1;
    markerInfoById.set(markerId, { ...info, markerId });
    return markerId;
  };

  const headBcs = headBcMapFor(model);
  const outerBoundarySegments = buildOuterBoundary(model).flatMap((edge) =>
    splitOuterBoundarySegmentsForHead(edge, headBcs.get(edge.edgeKey), allocateMarker)
  );

  const regionBoundarySegments = (regions || []).flatMap((region, regionIndex) =>
    polygonSegments(region?.polygon || [], {
      kind: 'region',
      priority: SEGMENT_PRIORITY.region,
      regionId: region?.id || `region-${regionIndex + 1}`,
      regionIndex,
      regionSource: region?.source || 'region',
      markerId: allocateMarker({
        markerType: 'region',
        regionId: region?.id || `region-${regionIndex + 1}`,
        regionIndex,
        regionSource: region?.source || 'region'
      })
    })
  );

  const phreaticSegments =
    options?.freeSurface === 'fixed' && model?.phreatic?.vertices?.length >= 2
      ? polylineSegments(model.phreatic.vertices, {
          kind: 'phreatic',
          priority: SEGMENT_PRIORITY.phreatic,
          markerId: allocateMarker({
            markerType: 'phreatic'
          })
        })
      : [];

  const splitSegments = splitConstraintSegments([
    ...outerBoundarySegments,
    ...regionBoundarySegments,
    ...phreaticSegments
  ]);
  const uniqueSplitSegments = dedupeSegmentsByPriority(splitSegments);
  const densified = densifySegments(
    uniqueSplitSegments,
    Math.sqrt(Math.max(Number(options?.segmentTargetArea ?? options?.meshTargetArea) || 0.5, 0.01))
  );
  const finalSegments = dedupeSegmentsByPriority(densified);

  const points = [];
  const pointIndexByKey = new Map();
  const pointlist = [];
  const segmentlist = [];
  const segmentmarkerlist = [];

  const getPointIndex = (point) => {
    const normalized = {
      x: +Number(point.x).toFixed(SNAP_DECIMALS),
      y: +Number(point.y).toFixed(SNAP_DECIMALS)
    };
    const key = pointKey(normalized);
    if (!pointIndexByKey.has(key)) {
      pointIndexByKey.set(key, points.length);
      points.push(normalized);
      pointlist.push(normalized.x, normalized.y);
    }
    return pointIndexByKey.get(key);
  };

  finalSegments.forEach((segment) => {
    const start = getPointIndex(segment.a);
    const end = getPointIndex(segment.b);
    if (start === end) return;
    segmentlist.push(start, end);
    segmentmarkerlist.push(segment.markerId);
  });

  return {
    domainPolygon,
    points,
    segments: finalSegments,
    pointlist,
    segmentlist,
    segmentmarkerlist,
    markerInfoById
  };
}
