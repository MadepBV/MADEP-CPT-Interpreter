// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/geometry/polygons.js — point-in-polygon, centroid and the two polygon validators of
// the Seep / Slope section, refactor step 9d (01-monolith-map.md §2.11 group "Geometry, picking,
// line probe"; PLAN §2 row 18d). Moved verbatim from legacy-controller.js (integration-r 4974167):
//
//   stage6BishopPointInPolygon 5161-5173         → pointInPolygon
//   stage6BishopPolygonCentroid 5205-5233        → polygonCentroid
//   stage6BishopPolygonIsValid 5652-5654         → polygonIsValid
//   stage6BishopValidateHolePolygon 5677-5705    → validateHolePolygon
//   stage6BishopPointInsideOrBoundary 5720-5728  → pointInsideOrBoundary
//
// Pure maths on arrays of `{x, y}`: no `S`, no DOM. The degenerate answers are the monolith's —
// an empty polygon is never "inside", a zero-area polygon falls back to the vertex average for
// its centroid, and a horizontal edge is skipped by the ray cast (the `|| 1e-12` guard).
import { isSimplePolygon, normalizeRegionPolygon, polygonArea } from '../../soil-regions.js';
import { pointOnSegment, segmentsIntersectClosed } from './points.js';

/** Even-odd ray cast; points exactly on an edge are undefined (use `pointInsideOrBoundary`). */
export function pointInPolygon(point, polygon){
  let inside = false;
  for(let i=0, j=polygon.length-1; i<polygon.length; j=i, i+=1){
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-12) + xi);
    if(intersect) inside = !inside;
  }
  return inside;
}

/** Inside *or* within 1e-4 of the boundary — what the split tool accepts for its chord samples. */
export function pointInsideOrBoundary(point, polygon){
  if(pointInPolygon(point, polygon)) return true;
  for(let i=0;i<polygon.length;i+=1){
    const a = polygon[i];
    const b = polygon[(i+1)%polygon.length];
    if(pointOnSegment(point, a, b, 1e-4)) return true;
  }
  return false;
}

/** Area centroid; a degenerate (|2A| < 1e-9) polygon falls back to the vertex average. */
export function polygonCentroid(polygon){
  if(!polygon?.length) return null;
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for(let i=0;i<polygon.length;i+=1){
    const a = polygon[i];
    const b = polygon[(i+1)%polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if(Math.abs(twiceArea) < 1e-9){
    const avg = polygon.reduce((acc, pt)=>{
      acc.x += pt.x;
      acc.y += pt.y;
      return acc;
    }, {x:0, y:0});
    return {
      x:avg.x / polygon.length,
      y:avg.y / polygon.length
    };
  }
  return {
    x:cx / (3 * twiceArea),
    y:cy / (3 * twiceArea)
  };
}

/** A usable soil polygon: ≥ 3 vertices, area > 1e-4 m² and non-self-intersecting. */
export function polygonIsValid(polygon){
  return Array.isArray(polygon) && polygon.length >= 3 && polygonArea(polygon) > 1e-4 && isSimplePolygon(polygon);
}

/**
 * The hole tool's guard: the drawn polygon must be simple, big enough and *strictly* inside the
 * selected custom polygon (no shared boundary point, no crossing edge).
 * → `{ok:true, polygon}` with the normalised hole, or `{ok:false, message}` — the monolith's
 * three messages, in its order.
 */
export function validateHolePolygon(parentRegion, polygon){
  const parentPolygon = parentRegion?.polygon || [];
  const holePolygon = normalizeRegionPolygon(polygon || []);
  if(parentPolygon.length < 3) return {ok:false, message:'Select a valid custom polygon before cutting a hole.'};
  if(holePolygon.length < 3 || !(polygonArea(holePolygon) > 1e-4)){
    return {ok:false, message:'Draw at least three distinct points for the hole polygon.'};
  }
  if(!isSimplePolygon(holePolygon)){
    return {ok:false, message:'Hole polygons must be simple non-self-intersecting closed shapes.'};
  }
  if(holePolygon.some((pt)=>parentPolygon.some((_, index)=>pointOnSegment(pt, parentPolygon[index], parentPolygon[(index + 1) % parentPolygon.length], 1e-6)))){
    return {ok:false, message:'The hole polygon must stay strictly inside the selected custom polygon.'};
  }
  if(holePolygon.some((pt)=>!pointInPolygon(pt, parentPolygon))){
    return {ok:false, message:'The hole polygon must stay strictly inside the selected custom polygon.'};
  }
  for(let i=0;i<holePolygon.length;i+=1){
    const a = holePolygon[i];
    const b = holePolygon[(i + 1) % holePolygon.length];
    for(let j=0;j<parentPolygon.length;j+=1){
      const c = parentPolygon[j];
      const d = parentPolygon[(j + 1) % parentPolygon.length];
      if(segmentsIntersectClosed(a, b, c, d)){
        return {ok:false, message:'The hole polygon must stay strictly inside the selected custom polygon.'};
      }
    }
  }
  return {ok:true, polygon:holePolygon};
}
