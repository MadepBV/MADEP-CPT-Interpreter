// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/geometry/measurement.js — the shared Measure tool's two-point line: its metrics, its
// readout and its tangent / normal. Refactor step 9d (01-monolith-map.md §2.11 group "Geometry,
// picking, line probe"; PLAN §2 row 18d). Moved verbatim from legacy-controller.js
// (integration-r 4974167):
//
//   stage6BishopMeasurementMetrics 5254-5273  → measurementMetrics
//   stage6BishopMeasurementLabel 5275-5278    → measurementLabel
//   stage6BishopMeasurementVectors 5423-5431  → measurementVectors
//
// Pure maths: no `S`, no DOM. The metrics are also the line probe's section (probe/line-probe.js).

/**
 * The first two finite points of the measure draft → `{a, b, dx, dy, length, mid}`, or `null`
 * while fewer than two points are set. Extra points are ignored; coincident points give
 * `length === 0`, which every reader treats as "not set".
 */
export function measurementMetrics(points){
  const clean = (points || [])
    .filter((pt)=>Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    .slice(0, 2);
  if(clean.length < 2) return null;
  const [a, b] = clean;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    a,
    b,
    dx,
    dy,
    length:Math.hypot(dx, dy),
    mid:{
      x:0.5 * (a.x + b.x),
      y:0.5 * (a.y + b.y)
    }
  };
}

/** The measure readout of the tool rail and the canvas. */
export function measurementLabel(metrics){
  if(!metrics) return 'Measure not set';
  return `L=${metrics.length.toFixed(2)} m · dx=${metrics.dx.toFixed(2)} m · dy=${metrics.dy.toFixed(2)} m`;
}

/**
 * The unit tangent `(tx, ty)` and left normal `(nx, ny)` of the measured line; a degenerate line
 * (length 0, or no metrics at all) divides by 1e-9 and yields the zero vector, as the monolith did.
 */
export function measurementVectors(metrics){
  const length = Math.max(metrics?.length || 0, 1e-9);
  return {
    tx:(metrics?.dx || 0) / length,
    ty:(metrics?.dy || 0) / length,
    nx:-(metrics?.dy || 0) / length,
    ny:(metrics?.dx || 0) / length
  };
}
