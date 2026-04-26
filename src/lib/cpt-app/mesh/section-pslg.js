// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { pointInPolygonHalfOpen } from '../soil-regions.js';

const EPS = 1e-9;
const GEOM_EPS = 1e-6;
const SNAP_DECIMALS = 6;

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

export function polylineSegments(vertices, extra) {
  const out = [];
  for (let i = 0; i < vertices.length - 1; i += 1) {
    const a = { x: Number(vertices[i]?.x), y: Number(vertices[i]?.y) };
    const b = { x: Number(vertices[i + 1]?.x), y: Number(vertices[i + 1]?.y) };
    if (!(dist(a, b) > GEOM_EPS)) continue;
    out.push({ a, b, ...extra });
  }
  return out;
}

export function polygonSegments(polygon, extra) {
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

export function domainPolygonFor(model) {
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
  // Length-normalised perpendicular-distance test. The raw cross product
  // (twice the signed area of the triangle a-b-point) scales with segment
  // length, so a fixed `tol` on it forces an effective perpendicular
  // tolerance of `tol / length`. On long sloped terrain segments (e.g. an
  // 8 m terrain edge) that becomes ~1.3e-7 m — tighter than the 1e-6 m
  // SNAP_DECIMALS rounding precision used everywhere else, so points that
  // should sit on the segment after rounding fail the test. The split/
  // dedup pipeline then treats two physically identical segments as
  // distinct and Triangle inserts unbounded Steiner refinement to honour
  // them, producing an exploded mesh on sloping terrain.
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const length = Math.hypot(abx, aby);
  if (!(length > EPS)) {
    return Math.hypot(point.x - a.x, point.y - a.y) <= tol;
  }
  const cross = segmentOrientation(a, b, point);
  if (Math.abs(cross) > tol * length) return false;
  const t = ((point.x - a.x) * abx + (point.y - a.y) * aby) / (length * length);
  const tolT = tol / length;
  return t >= -tolT && t <= 1 + tolT;
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
  if (
    Number.isFinite(Number(segment?.segmentTargetLength)) &&
    Number(segment.segmentTargetLength) > 0
  ) {
    return Math.max(Math.min(base, Number(segment.segmentTargetLength)), 0.02);
  }
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
  const mergeRefinement = (kept, candidate) => {
    const lengths = [kept?.segmentTargetLength, candidate?.segmentTargetLength]
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (!lengths.length) return kept;
    return {
      ...kept,
      segmentTargetLength: Math.min(...lengths)
    };
  };
  // Primary dedup: identical-endpoint segments after rounding to SNAP_DECIMALS.
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
      map.set(key, mergeRefinement(segment, existing));
      return;
    }
    if (nextPriority === existingPriority && (segment.markerId || 0) < (existing.markerId || 0)) {
      map.set(key, mergeRefinement(segment, existing));
      return;
    }
    map.set(key, mergeRefinement(existing, segment));
  });
  // Secondary dedup: collinear-overlapping segments. After the primary
  // dedup we may still hold pairs of segments that lie on the same line
  // and overlap end-to-end, where one segment's endpoints sit on the
  // other within the length-normalised pointOnSegment tolerance. These
  // come from terrain segments paired with region polygon top edges that
  // share the slope but were rounded onto slightly different x values
  // before snap. Triangle would otherwise see them as two near-parallel
  // constraints and refine catastrophically. Merge any such pair into a
  // single longer segment whose endpoints span both inputs, keeping the
  // higher priority's metadata and the tighter target length.
  const merged = [...map.values()];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < merged.length; i += 1) {
      const a = merged[i];
      if (!a) continue;
      for (let j = i + 1; j < merged.length; j += 1) {
        const b = merged[j];
        if (!b) continue;
        // Both endpoints of one on the other (each direction) and within
        // GEOM_EPS perpendicular distance proves collinearity overlap.
        const aOnB = pointOnSegment(a.a, b.a, b.b) || pointOnSegment(a.b, b.a, b.b);
        const bOnA = pointOnSegment(b.a, a.a, a.b) || pointOnSegment(b.b, a.a, a.b);
        if (!(aOnB && bOnA)) continue;
        // Verify both segments are collinear by checking all four endpoint
        // positions lie on the line through one of them.
        if (!pointOnSegment(b.a, a.a, a.b) || !pointOnSegment(b.b, a.a, a.b)) {
          if (!pointOnSegment(a.a, b.a, b.b) || !pointOnSegment(a.b, b.a, b.b)) continue;
        }
        // Pick the longer segment as the carrier; project all four endpoints
        // onto it and take the extreme parameters.
        const lenA2 = (a.b.x - a.a.x) ** 2 + (a.b.y - a.a.y) ** 2;
        const lenB2 = (b.b.x - b.a.x) ** 2 + (b.b.y - b.a.y) ** 2;
        const carrier = lenA2 >= lenB2 ? a : b;
        const cx = carrier.b.x - carrier.a.x;
        const cy = carrier.b.y - carrier.a.y;
        const inv = 1 / (cx * cx + cy * cy);
        const proj = (p) => (((p.x - carrier.a.x) * cx) + ((p.y - carrier.a.y) * cy)) * inv;
        const ts = [0, 1, proj(a.a), proj(a.b), proj(b.a), proj(b.b)];
        const tMin = Math.min(...ts);
        const tMax = Math.max(...ts);
        const newA = {
          x: +lerp(carrier.a.x, carrier.b.x, tMin).toFixed(SNAP_DECIMALS),
          y: +lerp(carrier.a.y, carrier.b.y, tMin).toFixed(SNAP_DECIMALS)
        };
        const newB = {
          x: +lerp(carrier.a.x, carrier.b.x, tMax).toFixed(SNAP_DECIMALS),
          y: +lerp(carrier.a.y, carrier.b.y, tMax).toFixed(SNAP_DECIMALS)
        };
        const winnerPriority = (a.priority || 0) >= (b.priority || 0) ? a : b;
        const winnerMarker = (a.markerId || 0) <= (b.markerId || 0) ? a : b;
        const survivor = {
          ...mergeRefinement(winnerPriority, winnerMarker === winnerPriority ? a : b),
          a: newA,
          b: newB
        };
        merged[i] = survivor;
        merged[j] = null;
        changed = true;
        break outer;
      }
    }
    if (changed) {
      for (let k = merged.length - 1; k >= 0; k -= 1) {
        if (!merged[k]) merged.splice(k, 1);
      }
    }
  }
  return merged.filter(Boolean);
}

function pointKey(point) {
  return `${point.x.toFixed(SNAP_DECIMALS)},${point.y.toFixed(SNAP_DECIMALS)}`;
}

function pointToSegmentDistance(point, a, b) {
  const abx = (b?.x || 0) - (a?.x || 0);
  const aby = (b?.y || 0) - (a?.y || 0);
  const len2 = abx * abx + aby * aby;
  if (!(len2 > EPS)) return Math.hypot((point?.x || 0) - (a?.x || 0), (point?.y || 0) - (a?.y || 0));
  const t = clamp((((point?.x || 0) - (a?.x || 0)) * abx + (((point?.y || 0) - (a?.y || 0)) * aby)) / len2, 0, 1);
  const qx = (a?.x || 0) + abx * t;
  const qy = (a?.y || 0) + aby * t;
  return Math.hypot((point?.x || 0) - qx, (point?.y || 0) - qy);
}

function bboxForPolygon(points) {
  return {
    xMin: Math.min(...points.map((point) => point.x)),
    xMax: Math.max(...points.map((point) => point.x)),
    yMin: Math.min(...points.map((point) => point.y)),
    yMax: Math.max(...points.map((point) => point.y))
  };
}

function horizontalIntervalsInPolygon(polygon, y) {
  const pts = cleanPolygon(polygon);
  if (pts.length < 3) return [];
  const xHits = [];
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (Math.abs(b.y - a.y) <= EPS) continue;
    const crosses = (a.y <= y + GEOM_EPS && b.y > y + GEOM_EPS) || (b.y <= y + GEOM_EPS && a.y > y + GEOM_EPS);
    if (!crosses) continue;
    const t = (y - a.y) / (b.y - a.y);
    if (t < -GEOM_EPS || t > 1 + GEOM_EPS) continue;
    xHits.push(lerp(a.x, b.x, t));
  }
  const xs = uniqueSorted(xHits);
  const out = [];
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i + 1] > xs[i] + GEOM_EPS) out.push({ xMin: xs[i], xMax: xs[i + 1] });
  }
  return out;
}

function regionAreaLimit(region, options) {
  const baseArea = Math.max(Number(options?.regionTargetArea ?? options?.meshTargetArea) || 0.5, 0.01);
  const coarseness = Number.isFinite(Number(region?.coarseness)) && Number(region.coarseness) > 0 ? Number(region.coarseness) : 1;
  return Math.max(baseArea * coarseness, 1e-4);
}

function polygonCentroid(polygon) {
  const pts = cleanPolygon(polygon);
  const signedArea = polygonSignedArea(pts);
  if (!(Math.abs(signedArea) > EPS)) return null;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const cross = a.x * b.y - b.x * a.y;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  return {
    x: cx / (6 * signedArea),
    y: cy / (6 * signedArea)
  };
}

function pointToPolygonBoundaryDistance(point, polygon) {
  const pts = cleanPolygon(polygon);
  if (pts.length < 2) return 0;
  let best = Infinity;
  for (let i = 0; i < pts.length; i += 1) {
    best = Math.min(best, pointToSegmentDistance(point, pts[i], pts[(i + 1) % pts.length]));
  }
  return best;
}

function bestInteriorPointForPolygon(polygon) {
  const pts = cleanPolygon(polygon);
  if (pts.length < 3) return null;
  const bbox = bboxForPolygon(pts);
  const candidates = [];
  const seen = new Set();

  const tryCandidate = (x, y) => {
    const candidate = {
      x: +Number(x).toFixed(SNAP_DECIMALS),
      y: +Number(y).toFixed(SNAP_DECIMALS)
    };
    const key = pointKey(candidate);
    if (seen.has(key) || !pointInPolygonHalfOpen(pts, candidate.x, candidate.y)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  const centroid = polygonCentroid(pts);
  if (centroid) tryCandidate(centroid.x, centroid.y);

  [0.5, 0.38, 0.62, 0.25, 0.75, 0.15, 0.85].forEach((fraction) => {
    const y = lerp(bbox.yMin, bbox.yMax, fraction);
    horizontalIntervalsInPolygon(pts, y).forEach((interval) => {
      tryCandidate(0.5 * (interval.xMin + interval.xMax), y);
      tryCandidate(lerp(interval.xMin, interval.xMax, 0.35), y);
      tryCandidate(lerp(interval.xMin, interval.xMax, 0.65), y);
    });
  });

  if (!candidates.length) return null;
  return candidates.reduce((best, candidate) => {
    const distance = pointToPolygonBoundaryDistance(candidate, pts);
    if (!best || distance > best.distance) return { point: candidate, distance };
    return best;
  }, null)?.point || null;
}

function buildRegionList(regions, options) {
  const list = [];
  (regions || []).forEach((region, regionIndex) => {
    const polygon = cleanPolygon(region?.polygon || []);
    if (polygon.length < 3) return;
    const seed = bestInteriorPointForPolygon(polygon);
    if (!seed) return;
    list.push(seed.x, seed.y, regionIndex + 1, regionAreaLimit(region, options));
  });
  return list;
}

export function buildSectionPslg(model, regions, options = {}) {
  const domainPolygon = domainPolygonFor(model);
  if (domainPolygon.length < 3) {
    throw new Error('A valid section boundary is required before meshing.');
  }

  const splitSegments = splitConstraintSegments(options.constraintSegments || []);
  const uniqueSplitSegments = dedupeSegmentsByPriority(splitSegments);
  const densified = densifySegments(
    uniqueSplitSegments,
    Math.sqrt(Math.max(Number(options?.segmentTargetArea ?? options?.meshTargetArea) || 0.5, 0.01))
  );
  const finalSegments = dedupeSegmentsByPriority(densified);
  const regionlist = buildRegionList(regions, options);

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
    segmentmarkerlist.push(segment.markerId || 0);
  });

  (options.extraPoints || []).forEach((point) => {
    const candidate = {
      x: +Number(point?.x).toFixed(SNAP_DECIMALS),
      y: +Number(point?.y).toFixed(SNAP_DECIMALS)
    };
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) return;
    if (!pointInPolygonHalfOpen(domainPolygon, candidate.x, candidate.y)) return;
    getPointIndex(candidate);
  });

  return {
    domainPolygon,
    points,
    segments: finalSegments,
    regionlist,
    pointlist,
    segmentlist,
    segmentmarkerlist,
    markerInfoById: options.markerInfoById || new Map()
  };
}
