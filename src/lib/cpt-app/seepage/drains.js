// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { domainPolygonFor } from '../mesh/section-pslg.js';
import { pointInPolygonHalfOpen } from '../soil-regions.js';
import { normalizeWallMaterial } from './material.js';
import { wallOrientedRectangle } from '../wall-geometry.js';

const GEOM_EPS = 1e-6;
const HEAD_MERGE_TOL = 1e-5;
const WALL_THICKNESS = 0.1;

function finitePoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function dist(a, b) {
  return Math.hypot((Number(b?.x) || 0) - (Number(a?.x) || 0), (Number(b?.y) || 0) - (Number(a?.y) || 0));
}

function roundCoord(value) {
  return +Number(value || 0).toFixed(6);
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegment(point, a, b, tol = GEOM_EPS) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const length = Math.hypot(abx, aby);
  if (!(length > GEOM_EPS)) return dist(point, a) <= tol;
  if (Math.abs(orientation(a, b, point)) > tol * length) return false;
  const t = ((point.x - a.x) * abx + (point.y - a.y) * aby) / (length * length);
  return t >= -tol / length && t <= 1 + tol / length;
}

function pointSegmentDistance(point, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (!(len2 > GEOM_EPS * GEOM_EPS)) return dist(point, a);
  const t = Math.min(Math.max(((point.x - a.x) * abx + (point.y - a.y) * aby) / len2, 0), 1);
  return dist(point, { x: a.x + abx * t, y: a.y + aby * t });
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

function collinearOverlap(a, b, c, d, tol = GEOM_EPS) {
  if (Math.abs(orientation(a, b, c)) > tol * Math.max(dist(a, b), 1)) return null;
  if (Math.abs(orientation(a, b, d)) > tol * Math.max(dist(a, b), 1)) return null;
  const useX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const values = [
    { value: useX ? a.x : a.y, point: a },
    { value: useX ? b.x : b.y, point: b },
    { value: useX ? c.x : c.y, point: c },
    { value: useX ? d.x : d.y, point: d }
  ].sort((left, right) => left.value - right.value);
  const first = values[1];
  const second = values[2];
  if (second.value - first.value <= tol) return null;
  return { a: first.point, b: second.point };
}

function segmentsTouch(a, b, c, d) {
  if (segmentIntersection(a, b, c, d)) return true;
  return !!collinearOverlap(a, b, c, d);
}

function segmentList(vertices, closed = false) {
  const pts = (vertices || []).map(finitePoint).filter(Boolean);
  const out = [];
  const limit = closed && pts.length > 2 ? pts.length : Math.max(pts.length - 1, 0);
  for (let i = 0; i < limit; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    if (dist(a, b) > GEOM_EPS) out.push({ a, b, index: i });
  }
  return out;
}

function midpoint(a, b) {
  return { x: 0.5 * (a.x + b.x), y: 0.5 * (a.y + b.y) };
}

function polylineLength(vertices, closed = false) {
  return segmentList(vertices, closed).reduce((sum, segment) => sum + dist(segment.a, segment.b), 0);
}

function arcLengthPrefix(vertices, closed = false) {
  const pts = (vertices || []).map(finitePoint).filter(Boolean);
  const prefix = [0];
  for (let i = 0; i < pts.length - 1; i += 1) {
    prefix.push(prefix[prefix.length - 1] + dist(pts[i], pts[i + 1]));
  }
  if (closed && pts.length > 2) prefix.push(prefix[prefix.length - 1] + dist(pts[pts.length - 1], pts[0]));
  return prefix;
}

function headAtSegmentPoint(drain, segmentIndex, t = 0) {
  const pts = drain?.vertices || [];
  const prefix = arcLengthPrefix(pts, drain?.closed);
  const a = pts[segmentIndex];
  const b = pts[(segmentIndex + 1) % pts.length];
  const s = (prefix[segmentIndex] || 0) + Math.max(0, Math.min(1, t)) * dist(a, b);
  return drainHeadValueAt(drain, s);
}

function samplePolylineY(vertices, x) {
  const pts = (vertices || []).map(finitePoint).filter(Boolean).sort((a, b) => a.x - b.x);
  if (!pts.length) return null;
  if (x <= pts[0].x) return pts[0].y;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    if (x < a.x - GEOM_EPS || x > b.x + GEOM_EPS) continue;
    const t = Math.abs(b.x - a.x) <= GEOM_EPS ? 0 : (x - a.x) / (b.x - a.x);
    return a.y + (b.y - a.y) * t;
  }
  return null;
}

function wallPolygonFor(wall) {
  return wallOrientedRectangle(wall, WALL_THICKNESS);
}

function pointStrictlyInsidePolygon(point, polygon, margin = GEOM_EPS) {
  if (!pointInPolygonHalfOpen(polygon, point.x, point.y)) return false;
  for (let i = 0; i < polygon.length; i += 1) {
    if (pointSegmentDistance(point, polygon[i], polygon[(i + 1) % polygon.length]) <= margin) return false;
  }
  return true;
}

function pushIssue(list, issue) {
  list.push({
    code: issue.code || 'drain-validation',
    drainId: issue.drainId || '',
    drainLabel: issue.drainLabel || '',
    message: issue.message || 'Drain validation issue.'
  });
}

export function normalizeDrainHead(head, vertices = []) {
  const fallbackHead = Number.isFinite(Number(vertices?.[0]?.y)) ? Number(vertices[0].y) : 0;
  const kind = head?.kind === 'per-vertex' || head?.kind === 'invert-plus' ? head.kind : 'constant';
  if (kind === 'per-vertex') {
    const values = Array.isArray(head?.values)
      ? head.values.map((value) => Number(value)).filter(Number.isFinite)
      : [];
    if (values.length === vertices.length) return { kind, values };
    return { kind: 'constant', value: Number.isFinite(Number(head?.value)) ? Number(head.value) : fallbackHead };
  }
  if (kind === 'invert-plus') {
    const invertY = Number.isFinite(Number(head?.invertY)) ? Number(head.invertY) : fallbackHead;
    const headAbove = Number.isFinite(Number(head?.headAbove)) ? Number(head.headAbove) : 0;
    return { kind, invertY, headAbove };
  }
  return {
    kind: 'constant',
    value: Number.isFinite(Number(head?.value)) ? Number(head.value) : fallbackHead
  };
}

export function normalizeDrain(drain, index = 0) {
  const vertices = [];
  (drain?.vertices || []).forEach((point) => {
    const pt = finitePoint(point);
    if (!pt) return;
    const last = vertices[vertices.length - 1];
    if (!last || dist(last, pt) > GEOM_EPS) vertices.push({ x: roundCoord(pt.x), y: roundCoord(pt.y) });
  });
  const id = drain?.id || `drain-${index + 1}`;
  const gating = drain?.gating === 'always' || drain?.gating === 'head-cap' ? drain.gating : 'when-saturated';
  return {
    id,
    label: String(drain?.label || `Drain ${index + 1}`),
    vertices,
    closed: drain?.closed === true,
    head: normalizeDrainHead(drain?.head, vertices),
    gating
  };
}

export function normalizeDrains(drains = []) {
  return (drains || [])
    .map((drain, index) => normalizeDrain(drain, index))
    .filter((drain) => drain.vertices.length > 0);
}

export function drainHeadValueAt(drain, arcLength = 0) {
  const head = normalizeDrainHead(drain?.head, drain?.vertices || []);
  if (head.kind === 'invert-plus') return head.invertY + head.headAbove;
  if (head.kind === 'per-vertex') {
    const vertices = drain?.vertices || [];
    const values = head.values || [];
    if (vertices.length < 2 || values.length !== vertices.length) return Number(values[0]) || 0;
    const prefix = arcLengthPrefix(vertices, drain?.closed);
    const s = Math.max(0, Math.min(Number(arcLength) || 0, prefix[prefix.length - 1] || 0));
    for (let i = 0; i < vertices.length - 1; i += 1) {
      if (s > prefix[i + 1] + GEOM_EPS) continue;
      const span = Math.max(prefix[i + 1] - prefix[i], GEOM_EPS);
      const t = Math.max(0, Math.min(1, (s - prefix[i]) / span));
      return values[i] + (values[i + 1] - values[i]) * t;
    }
    return values[values.length - 1];
  }
  return head.value;
}

export function drainTotalLength(drain) {
  return polylineLength(drain?.vertices || [], drain?.closed);
}

export function validateDrains(model = {}) {
  const errors = [];
  const warnings = [];
  const drains = normalizeDrains(model?.drains || []);
  const domain = domainPolygonFor(model);
  const domainSegments = segmentList(domain, true);
  const phreaticVertices = model?.phreatic?.vertices || [];
  const fixedFreeSurface = model?.seepage?.options?.freeSurface === 'fixed';
  const terrainMaxY = Math.max(...(model?.terrain?.vertices || []).map((point) => Number(point?.y)).filter(Number.isFinite), 0);
  const boundaryHeadBcs = (model?.seepage?.bcs || []).filter((bc) => bc?.type === 'head' && Number.isFinite(Number(bc.head)));

  drains.forEach((drain) => {
    if (drain.vertices.length < 2) {
      pushIssue(errors, {
        code: 'drain-too-few-vertices',
        drainId: drain.id,
        drainLabel: drain.label,
        message: `${drain.label} must have at least two finite vertices.`
      });
    }
  });

  drains.forEach((drain) => {
    drain.vertices.forEach((vertex) => {
      if (domain.length >= 3 && !pointInPolygonHalfOpen(domain, vertex.x, vertex.y)) {
        pushIssue(errors, {
          code: 'drain-vertex-outside-domain',
          drainId: drain.id,
          drainLabel: drain.label,
          message: `${drain.label} has a vertex outside the seepage analysis domain.`
        });
      }
    });
    segmentList(drain.vertices, drain.closed).forEach((segment) => {
      const mid = midpoint(segment.a, segment.b);
      if (domain.length >= 3 && !pointInPolygonHalfOpen(domain, mid.x, mid.y)) {
        pushIssue(errors, {
          code: 'drain-segment-outside-domain',
          drainId: drain.id,
          drainLabel: drain.label,
          message: `${drain.label} has a segment that exits the seepage analysis domain.`
        });
      }
      domainSegments.forEach((edge) => {
        const hit = segmentIntersection(segment.a, segment.b, edge.a, edge.b);
        if (!hit) return;
        const insideDrain = hit.t > GEOM_EPS && hit.t < 1 - GEOM_EPS;
        const insideDomainEdge = hit.u > GEOM_EPS && hit.u < 1 - GEOM_EPS;
        if (!insideDrain || !insideDomainEdge) return;
        pushIssue(errors, {
          code: 'drain-segment-crosses-domain-boundary',
          drainId: drain.id,
          drainLabel: drain.label,
          message: `${drain.label} crosses the analysis-domain boundary between its vertices.`
        });
      });
    });
  });

  drains.forEach((drain) => {
    const segments = segmentList(drain.vertices, drain.closed);
    for (let i = 0; i < segments.length; i += 1) {
      for (let j = i + 1; j < segments.length; j += 1) {
        if (Math.abs(i - j) === 1) continue;
        if (drain.closed && i === 0 && j === segments.length - 1) continue;
        if (!segmentsTouch(segments[i].a, segments[i].b, segments[j].a, segments[j].b)) continue;
        pushIssue(errors, {
          code: 'drain-self-intersection',
          drainId: drain.id,
          drainLabel: drain.label,
          message: `${drain.label} self-intersects.`
        });
      }
    }
  });

  const wallPolygons = (model?.walls || []).map(wallPolygonFor).filter((polygon) => polygon.length >= 3);
  drains.forEach((drain) => {
    wallPolygons.forEach((wallPolygon) => {
      drain.vertices.forEach((vertex) => {
        if (!pointStrictlyInsidePolygon(vertex, wallPolygon, GEOM_EPS)) return;
        pushIssue(errors, {
          code: 'drain-vertex-inside-wall',
          drainId: drain.id,
          drainLabel: drain.label,
          message: `${drain.label} has a vertex inside a wall.`
        });
      });
      segmentList(drain.vertices, drain.closed).forEach((segment) => {
        if (pointStrictlyInsidePolygon(midpoint(segment.a, segment.b), wallPolygon, GEOM_EPS)) {
          pushIssue(errors, {
            code: 'drain-segment-through-wall',
            drainId: drain.id,
            drainLabel: drain.label,
            message: `${drain.label} crosses a wall interior.`
          });
          return;
        }
        for (let i = 0; i < wallPolygon.length; i += 1) {
          const a = wallPolygon[i];
          const b = wallPolygon[(i + 1) % wallPolygon.length];
          if (collinearOverlap(segment.a, segment.b, a, b)) continue;
          const hit = segmentIntersection(segment.a, segment.b, a, b);
          if (!hit) continue;
          if (hit.t > GEOM_EPS && hit.t < 1 - GEOM_EPS && hit.u > GEOM_EPS && hit.u < 1 - GEOM_EPS) {
            pushIssue(errors, {
              code: 'drain-segment-through-wall',
              drainId: drain.id,
              drainLabel: drain.label,
              message: `${drain.label} crosses a wall interior.`
            });
            break;
          }
        }
      });
    });
  });

  for (let i = 0; i < drains.length; i += 1) {
    for (let j = i + 1; j < drains.length; j += 1) {
      const leftSegments = segmentList(drains[i].vertices, drains[i].closed);
      const rightSegments = segmentList(drains[j].vertices, drains[j].closed);
      leftSegments.forEach((left) => {
        rightSegments.forEach((right) => {
          const overlap = collinearOverlap(left.a, left.b, right.a, right.b);
          const hit = segmentIntersection(left.a, left.b, right.a, right.b);
          if (!overlap && !hit) return;
          const leftHead = overlap
            ? headAtSegmentPoint(drains[i], left.index, 0.5)
            : headAtSegmentPoint(drains[i], left.index, hit.t);
          const rightHead = overlap
            ? headAtSegmentPoint(drains[j], right.index, 0.5)
            : headAtSegmentPoint(drains[j], right.index, hit.u);
          if (Math.abs(leftHead - rightHead) <= HEAD_MERGE_TOL) return;
          pushIssue(errors, {
            code: 'drain-conflicting-heads',
            drainId: drains[i].id,
            drainLabel: drains[i].label,
            message: `${drains[i].label} and ${drains[j].label} cross with different prescribed heads.`
          });
        });
      });
    }
  }

  if (fixedFreeSurface && phreaticVertices.length >= 2) {
    const phreaticSegments = segmentList(phreaticVertices, false);
    drains.forEach((drain) => {
      segmentList(drain.vertices, drain.closed).forEach((segment) => {
        phreaticSegments.forEach((phreaticSegment) => {
          const overlap = collinearOverlap(segment.a, segment.b, phreaticSegment.a, phreaticSegment.b);
          const hit = segmentIntersection(segment.a, segment.b, phreaticSegment.a, phreaticSegment.b);
          if (!overlap && !hit) return;
          const t = hit ? hit.t : 0.5;
          const point = hit || midpoint(overlap.a, overlap.b);
          const head = headAtSegmentPoint(drain, segment.index, t);
          if (Math.abs(head - point.y) <= HEAD_MERGE_TOL) return;
          pushIssue(errors, {
            code: 'drain-phreatic-head-conflict',
            drainId: drain.id,
            drainLabel: drain.label,
            message: `${drain.label} intersects the fixed phreatic line at a different head.`
          });
        });
      });
    });
  }

  drains.forEach((drain) => {
    const headValues = drain.vertices.map((_, index) => drainHeadValueAt(drain, arcLengthPrefix(drain.vertices, drain.closed)[index] || 0));
    if (headValues.some((value) => value > terrainMaxY + 5)) {
      pushIssue(warnings, {
        code: 'drain-high-head',
        drainId: drain.id,
        drainLabel: drain.label,
        message: `${drain.label} has a head more than 5 m above the highest terrain point.`
      });
    }
    if (drain.gating === 'always' && phreaticVertices.length >= 2) {
      drain.vertices.forEach((vertex) => {
        const phreaticY = samplePolylineY(phreaticVertices, vertex.x);
        if (phreaticY == null || !(vertex.y > phreaticY + 0.5)) return;
        pushIssue(warnings, {
          code: 'drain-always-above-phreatic',
          drainId: drain.id,
          drainLabel: drain.label,
          message: `${drain.label} is above the phreatic line and is configured always-active; this can create suction.`
        });
      });
    }
  });

  drains.forEach((drain) => {
    if (!drain.vertices?.length) return;
    const yValues = drain.vertices.map((vertex) => Number(vertex?.y)).filter(Number.isFinite);
    if (!yValues.length) return;
    const minVertexY = Math.min(...yValues);
    const prefix = arcLengthPrefix(drain.vertices, drain.closed);
    const headValues = drain.vertices.map((_, index) =>
      drainHeadValueAt(drain, prefix[index] || 0));
    const finiteHeads = headValues.filter(Number.isFinite);
    if (!finiteHeads.length) return;
    const minHead = Math.min(...finiteHeads);
    if (minHead < minVertexY - 0.01) {
      pushIssue(warnings, {
        code: 'drain-head-below-elevation',
        drainId: drain.id,
        drainLabel: drain.label,
        message:
          `${drain.label} has prescribed head (${minHead.toFixed(2)} m) ` +
          `below its own elevation (${minVertexY.toFixed(2)} m). The drain ` +
          `cannot be active in saturated soil; it will only act if the soil ` +
          `is unsaturated above the drain (no water to remove).`
      });
    }
  });

  (model?.walls || []).forEach((wall, index) => {
    const material = normalizeWallMaterial(wall?.material, index, wall?.id);
    if (!(Number(material.kAcross) < 1e-15)) return;
    pushIssue(warnings, {
      code: 'wall-k-below-practical-floor',
      message: `Wall ${index + 1} has kAcross below the practical seepage numerical floor.`
    });
  });

  if (boundaryHeadBcs.length && drains.length) {
    const boundary = domainSegments;
    drains.forEach((drain) => {
      drain.vertices.forEach((vertex) => {
        boundary.forEach((edge) => {
          if (!pointOnSegment(vertex, edge.a, edge.b)) return;
          boundaryHeadBcs.forEach((bc) => {
            if (Math.abs((Number(bc.head) || 0) - drainHeadValueAt(drain, 0)) <= HEAD_MERGE_TOL) return;
            pushIssue(warnings, {
              code: 'drain-boundary-head-coincidence',
              drainId: drain.id,
              drainLabel: drain.label,
              message: `${drain.label} touches the outer boundary; if that edge has a head BC, the head values must match.`
            });
          });
        });
      });
    });
  }

  return { errors, warnings };
}
