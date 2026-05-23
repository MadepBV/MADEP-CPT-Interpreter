// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
// Shared two-point wall geometry helpers.  The canonical direction is
// head -> tip; for legacy vertical walls this is top -> bottom.

const DEFAULT_EPS = 1e-9;

export function finiteWallPoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

export function wallEndpoints(wall) {
  const head = finiteWallPoint(wall?.head) || finiteWallPoint(wall?.top) ||
    (Number.isFinite(Number(wall?.x)) && Number.isFinite(Number(wall?.yTop))
      ? { x: Number(wall.x), y: Number(wall.yTop) }
      : null);
  const tip = finiteWallPoint(wall?.tip) ||
    (Number.isFinite(Number(wall?.x)) && Number.isFinite(Number(wall?.yTip))
      ? { x: Number(wall.x), y: Number(wall.yTip) }
      : null);
  return head && tip ? { head, tip } : null;
}

export function wallLength(wall) {
  const endpoints = wallEndpoints(wall);
  if (!endpoints) return 0;
  return Math.hypot(endpoints.tip.x - endpoints.head.x, endpoints.tip.y - endpoints.head.y);
}

export function wallAxis(wall, eps = DEFAULT_EPS) {
  const endpoints = wallEndpoints(wall);
  if (!endpoints) return null;
  const dx = endpoints.tip.x - endpoints.head.x;
  const dy = endpoints.tip.y - endpoints.head.y;
  const length = Math.hypot(dx, dy);
  if (!(length > eps)) return null;
  const t = { x: dx / length, y: dy / length };
  // Project "right" relative to the head -> tip axis.  For a legacy
  // vertical wall (t = 0,-1), right = +x and left = -x, preserving the
  // old passive-side convention exactly.
  const nRight = { x: -t.y, y: t.x };
  const nLeft = { x: t.y, y: -t.x };
  return {
    head: endpoints.head,
    tip: endpoints.tip,
    length,
    t,
    nRight,
    nLeft
  };
}

export function wallNormalForSide(wallOrAxis, side = 'right') {
  const axis = wallOrAxis?.length && wallOrAxis?.t ? wallOrAxis : wallAxis(wallOrAxis);
  if (!axis) return null;
  return side === 'left' ? axis.nLeft : axis.nRight;
}

export function wallPointAtStation(wallOrAxis, station) {
  const axis = wallOrAxis?.length && wallOrAxis?.t ? wallOrAxis : wallAxis(wallOrAxis);
  if (!axis) return null;
  const s = Math.min(Math.max(Number(station) || 0, 0), axis.length);
  return {
    x: axis.head.x + axis.t.x * s,
    y: axis.head.y + axis.t.y * s
  };
}

export function wallStationOfPoint(wallOrAxis, point) {
  const axis = wallOrAxis?.length && wallOrAxis?.t ? wallOrAxis : wallAxis(wallOrAxis);
  const p = finiteWallPoint(point);
  if (!axis || !p) return NaN;
  return (p.x - axis.head.x) * axis.t.x + (p.y - axis.head.y) * axis.t.y;
}

export function pointSegmentDistance(point, a, b) {
  const p = finiteWallPoint(point);
  const p0 = finiteWallPoint(a);
  const p1 = finiteWallPoint(b);
  if (!p || !p0 || !p1) return Infinity;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len2 = dx * dx + dy * dy;
  if (!(len2 > DEFAULT_EPS * DEFAULT_EPS)) return Math.hypot(p.x - p0.x, p.y - p0.y);
  const u = Math.min(Math.max(((p.x - p0.x) * dx + (p.y - p0.y) * dy) / len2, 0), 1);
  return Math.hypot(p.x - (p0.x + u * dx), p.y - (p0.y + u * dy));
}

export function wallOrientedRectangle(wall, thickness = 0.1) {
  const axis = wallAxis(wall);
  if (!axis) return [];
  const half = Math.max(Number(thickness) || 0, 0) * 0.5;
  if (!(half > 0)) return [];
  const n = axis.nRight;
  return [
    { x: axis.head.x + n.x * half, y: axis.head.y + n.y * half },
    { x: axis.tip.x + n.x * half, y: axis.tip.y + n.y * half },
    { x: axis.tip.x - n.x * half, y: axis.tip.y - n.y * half },
    { x: axis.head.x - n.x * half, y: axis.head.y - n.y * half }
  ];
}

export function segmentIntersectionPoint(a, b, c, d, eps = 1e-9) {
  const p = finiteWallPoint(a);
  const p2 = finiteWallPoint(b);
  const q = finiteWallPoint(c);
  const q2 = finiteWallPoint(d);
  if (!p || !p2 || !q || !q2) return null;
  const r = { x: p2.x - p.x, y: p2.y - p.y };
  const s = { x: q2.x - q.x, y: q2.y - q.y };
  const cross = r.x * s.y - r.y * s.x;
  const qmp = { x: q.x - p.x, y: q.y - p.y };
  if (Math.abs(cross) <= eps) return null;
  const t = (qmp.x * s.y - qmp.y * s.x) / cross;
  const u = (qmp.x * r.y - qmp.y * r.x) / cross;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return { x: p.x + t * r.x, y: p.y + t * r.y, t, u };
}

export function circleWallSegmentIntersections(circle, wall, eps = 1e-9) {
  const axis = wallAxis(wall);
  const center = finiteWallPoint(circle?.center);
  const radius = Number(circle?.radius);
  if (!axis || !center || !(radius > 0)) return [];
  const fx = axis.head.x - center.x;
  const fy = axis.head.y - center.y;
  const b = 2 * (fx * axis.t.x + fy * axis.t.y);
  const c = fx * fx + fy * fy - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < -eps) return [];
  const roots = disc <= eps ? [-b / 2] : [(-b - Math.sqrt(disc)) / 2, (-b + Math.sqrt(disc)) / 2];
  return roots
    .filter((s, index, arr) => Number.isFinite(s) && s >= -eps && s <= axis.length + eps &&
      arr.findIndex((other) => Math.abs(other - s) <= eps) === index)
    .map((s) => ({
      s: Math.min(Math.max(s, 0), axis.length),
      point: wallPointAtStation(axis, s),
      axis
    }));
}
