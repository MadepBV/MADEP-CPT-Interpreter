// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/geometry/points.js — the point / segment maths of the Seep / Slope section, refactor
// step 9d (01-monolith-map.md §2.11 group "Geometry, picking, line probe"; PLAN §2 row 18d).
// Moved verbatim from legacy-controller.js (integration-r 4974167):
//
//   stage6BishopDist 5157-5159                   → dist
//   stage6BishopSegmentOrientation 5656-5658     → segmentOrientation
//   stage6BishopSegmentsIntersectClosed 5660-5675 → segmentsIntersectClosed
//   stage6BishopPointOnSegment 5707-5718         → pointOnSegment
//   stage6BishopClosestPointOnSegment 5730-5740  → closestPointOnSegment
//   stage6BishopUniqueSortedNumbers 5837-5844    → uniqueSortedNumbers
//
// Pure maths on `{x, y}` literals: no `S`, no DOM, no viewport. Degenerate inputs keep the
// monolith's answers — a zero-length segment falls back to the distance to its start point,
// a non-finite coordinate reads as 0 in `dist`, and `uniqueSortedNumbers` drops NaN / ±Infinity.
import { clampRegionPoint } from '../state/regions.js';

/** Euclidean distance; a missing or non-numeric coordinate counts as 0 (monolith behaviour). */
export function dist(a, b){
  return Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
}

/** 2× the signed area of the triangle a-b-c: > 0 left turn, < 0 right turn, 0 collinear. */
export function segmentOrientation(a, b, c){
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** True when `point` lies on the closed segment a-b within `tol` (a-b may be degenerate). */
export function pointOnSegment(point, a, b, tol = 1e-6){
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx*abx + aby*aby;
  if(len2 <= 1e-12) return dist(point, a) <= tol;
  const cross = Math.abs(apx*aby - apy*abx);
  if(cross > tol * Math.max(1, Math.sqrt(len2))) return false;
  const dot = apx*abx + apy*aby;
  return dot >= -tol && dot <= len2 + tol;
}

/** Closed-segment intersection (touching endpoints and collinear overlaps count as a hit). */
export function segmentsIntersectClosed(a, b, c, d, tol = 1e-6){
  const o1 = segmentOrientation(a, b, c);
  const o2 = segmentOrientation(a, b, d);
  const o3 = segmentOrientation(c, d, a);
  const o4 = segmentOrientation(c, d, b);

  if(Math.abs(o1) <= tol && pointOnSegment(c, a, b, tol)) return true;
  if(Math.abs(o2) <= tol && pointOnSegment(d, a, b, tol)) return true;
  if(Math.abs(o3) <= tol && pointOnSegment(a, c, d, tol)) return true;
  if(Math.abs(o4) <= tol && pointOnSegment(b, c, d, tol)) return true;

  return (
    ((o1 > tol && o2 < -tol) || (o1 < -tol && o2 > tol)) &&
    ((o3 > tol && o4 < -tol) || (o3 < -tol && o4 > tol))
  );
}

/**
 * The orthogonal projection of `point` on the closed segment a-b, clamped to the segment.
 * `point` is the projection rounded to the region grid (the monolith's `clampRegionPoint`),
 * `t` the parameter in [0, 1] and `distance` the *unrounded* distance.
 */
export function closestPointOnSegment(point, a, b){
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx*dx + dy*dy;
  const t = len2 > 1e-12 ? Math.min(Math.max(((point.x - a.x)*dx + (point.y - a.y)*dy) / len2, 0), 1) : 0;
  return {
    point:clampRegionPoint({x:a.x + dx*t, y:a.y + dy*t}),
    t,
    distance:Math.hypot(point.x - (a.x + dx*t), point.y - (a.y + dy*t))
  };
}

/** Ascending finite values with near-duplicates (within `tol`) collapsed. */
export function uniqueSortedNumbers(values, tol = 1e-6){
  const sorted = [...values].filter((value)=>Number.isFinite(value)).sort((a, b)=>a - b);
  const out = [];
  sorted.forEach((value)=>{
    if(!out.length || Math.abs(value - out[out.length - 1]) > tol) out.push(value);
  });
  return out;
}
