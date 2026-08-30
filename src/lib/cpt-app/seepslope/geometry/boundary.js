// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/geometry/boundary.js — polygon-boundary picking, the split tool and the hole
// subtraction of the Seep / Slope section, refactor step 9d (01-monolith-map.md §2.11 group
// "Geometry, picking, line probe"; PLAN §2 row 18d). Moved verbatim from legacy-controller.js
// (integration-r 4974167):
//
//   stage6BishopPickRegionBoundaryPoint 5746-5790   → pickRegionBoundaryPoint(region, world, tol)
//   stage6BishopTraverseBoundary 5792-5802          → traverseBoundary
//   stage6BishopBuildSplitBoundary 5804-5835        → buildSplitBoundary
//   stage6BishopBoundaryYAtX 5846-5853              → boundaryYAtX
//   stage6BishopPolygonIntervalsDetailed 5855-5888  → polygonIntervalsDetailed
//   stage6BishopSubtractDetailedIntervals 5890-5930 → subtractDetailedIntervals
//   stage6BishopSubtractHoleFromPolygon 5932-5961   → subtractHoleFromPolygon
//   stage6BishopSplitRegionPolygon 5963-6001        → splitRegionPolygon
//
// Pure maths: no `S`, no DOM. The one host input is the pick tolerance, which the monolith read
// from the canvas viewport (`stage6BishopBoundaryPickToleranceWorld()` → `SnapToleranceWorld()`,
// step 9e): `pickRegionBoundaryPoint` takes it as a number **or a zero-argument function**, and
// calls it at the very statement the monolith called it — after the nearest-edge loop and only
// when an edge was found — so the viewport is read exactly as often as before.
import { normalizeRegionPolygon, polygonArea } from '../../soil-regions.js';
import { clampRegionPoint, roundRegionCoord } from '../state/regions.js';
import { closestPointOnSegment, dist, uniqueSortedNumbers } from './points.js';
import { pointInsideOrBoundary, polygonIsValid } from './polygons.js';

const resolveTolerance = (tolerance) => (typeof tolerance === 'function' ? tolerance() : tolerance);

/**
 * The point of `region`'s boundary nearest to `world`, or `null` when the polygon is degenerate
 * or the nearest edge is farther than `tolerance` (a number or a `() => number`).
 * Within 1e-3 of an edge end the *vertex* is returned (rounded to the region grid) with
 * `vertexIndex` set — that is what makes a split snap to a corner.
 */
export function pickRegionBoundaryPoint(region, world, tolerance){
  const polygon = region?.polygon || [];
  if(polygon.length < 3) return null;
  let best = null;
  for(let i=0;i<polygon.length;i+=1){
    const a = polygon[i];
    const b = polygon[(i+1)%polygon.length];
    const projected = closestPointOnSegment(world, a, b);
    if(!best || projected.distance < best.distance){
      best = {
        ...projected,
        edgeIndex:i
      };
    }
  }
  if(!best || best.distance > resolveTolerance(tolerance)) return null;
  const polygonLength = polygon.length;
  const nearVertexTol = 1e-3;
  if(best.t <= nearVertexTol){
    return {
      x:roundRegionCoord(polygon[best.edgeIndex].x),
      y:roundRegionCoord(polygon[best.edgeIndex].y),
      edgeIndex:best.edgeIndex,
      vertexIndex:best.edgeIndex,
      t:0
    };
  }
  if(best.t >= 1 - nearVertexTol){
    const vertexIndex = (best.edgeIndex + 1) % polygonLength;
    return {
      x:roundRegionCoord(polygon[vertexIndex].x),
      y:roundRegionCoord(polygon[vertexIndex].y),
      edgeIndex:best.edgeIndex,
      vertexIndex,
      t:1
    };
  }
  return {
    x:best.point.x,
    y:best.point.y,
    edgeIndex:best.edgeIndex,
    vertexIndex:null,
    t:best.t
  };
}

/** The boundary walked forwards from `startIndex` to `endIndex` (inclusive); `[]` if it runs away. */
export function traverseBoundary(boundary, startIndex, endIndex){
  const out = [];
  let index = startIndex;
  while(true){
    out.push(clampRegionPoint(boundary[index]));
    if(index === endIndex) break;
    index = (index + 1) % boundary.length;
    if(out.length > boundary.length + 2) return [];
  }
  return out;
}

/**
 * The polygon with the cut points inserted in edge order → `{boundary, cutIndices}`, where
 * `cutIndices[name]` is the index of that cut in `boundary`. A cut that landed on a vertex reuses
 * the vertex; a cut that coincides with the previous boundary point (within 1e-6) is not inserted
 * twice, so a degenerate cut pair ends up with `indexA === indexB` and the caller rejects it.
 */
export function buildSplitBoundary(polygon, cuts){
  const insertionsByEdge = new Map();
  const cutNamesByVertex = new Map();
  cuts.forEach((cut)=>{
    if(Number.isInteger(cut.vertexIndex)){
      const names = cutNamesByVertex.get(cut.vertexIndex) || [];
      names.push(cut.name);
      cutNamesByVertex.set(cut.vertexIndex, names);
      return;
    }
    const insertions = insertionsByEdge.get(cut.edgeIndex) || [];
    insertions.push(cut);
    insertionsByEdge.set(cut.edgeIndex, insertions);
  });
  const boundary = [];
  const cutIndices = {};
  for(let i=0;i<polygon.length;i+=1){
    boundary.push(clampRegionPoint(polygon[i]));
    (cutNamesByVertex.get(i) || []).forEach((name)=>{
      cutIndices[name] = boundary.length - 1;
    });
    const insertions = (insertionsByEdge.get(i) || []).slice().sort((a, b)=>a.t - b.t);
    insertions.forEach((cut)=>{
      const pt = clampRegionPoint(cut);
      if(dist(boundary[boundary.length - 1], pt) > 1e-6){
        boundary.push(pt);
      }
      cutIndices[cut.name] = boundary.length - 1;
    });
  }
  return {boundary, cutIndices};
}

/**
 * y of the edge `boundary.edgeIndex` of `boundary.polygon` at abscissa `x`, rounded to 1e-6.
 * A vertical edge returns its start y; a missing edge returns NaN (the caller drops the piece).
 */
export function boundaryYAtX(boundary, x){
  const polygon = boundary?.polygon || [];
  const a = polygon?.[boundary?.edgeIndex];
  const b = polygon?.[(boundary?.edgeIndex + 1) % polygon.length];
  if(!a || !b) return NaN;
  if(Math.abs((b.x - a.x) || 0) <= 1e-9) return +a.y.toFixed(6);
  return +(a.y + ((x - a.x) * (b.y - a.y)) / (b.x - a.x)).toFixed(6);
}

/**
 * The vertical [yBottom, yTop] intervals of `polygon` at abscissa `x`, each carrying the edge it
 * came from. Vertical edges and hits at a vertex or outside the edge span are skipped, so a scan
 * line through a vertex yields no interval — the caller only ever scans at strip midpoints.
 */
export function polygonIntervalsDetailed(polygon, x){
  const pts = normalizeRegionPolygon(polygon || []);
  if(pts.length < 3) return [];
  const hits = [];
  for(let i=0;i<pts.length;i+=1){
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    if(Math.abs(dx) <= 1e-9) continue;
    if(x <= minX + 1e-9 || x >= maxX - 1e-9) continue;
    const t = (x - a.x) / dx;
    if(t <= 1e-9 || t >= 1 - 1e-9) continue;
    hits.push({
      y:a.y + (b.y - a.y) * t,
      edgeIndex:i
    });
  }
  hits.sort((left, right)=>left.y - right.y);
  const intervals = [];
  for(let i=0;i+1<hits.length;i+=2){
    const low = hits[i];
    const high = hits[i + 1];
    if(!(high.y > low.y + 1e-6)) continue;
    intervals.push({
      yBottom:low.y,
      yTop:high.y,
      bottomBoundary:{polygon:pts, edgeIndex:low.edgeIndex},
      topBoundary:{polygon:pts, edgeIndex:high.edgeIndex}
    });
  }
  return intervals;
}

/** `parentIntervals` minus `holeIntervals`, keeping the edge each remaining end came from. */
export function subtractDetailedIntervals(parentIntervals, holeIntervals){
  const out = [];
  (parentIntervals || []).forEach((parentInterval)=>{
    let segments = [{
      yBottom:parentInterval.yBottom,
      yTop:parentInterval.yTop,
      bottomBoundary:parentInterval.bottomBoundary,
      topBoundary:parentInterval.topBoundary
    }];
    (holeIntervals || []).forEach((holeInterval)=>{
      const nextSegments = [];
      segments.forEach((segment)=>{
        const overlapBottom = Math.max(segment.yBottom, holeInterval.yBottom);
        const overlapTop = Math.min(segment.yTop, holeInterval.yTop);
        if(!(overlapTop > overlapBottom + 1e-6)){
          nextSegments.push(segment);
          return;
        }
        if(overlapBottom > segment.yBottom + 1e-6){
          nextSegments.push({
            yBottom:segment.yBottom,
            yTop:overlapBottom,
            bottomBoundary:segment.bottomBoundary,
            topBoundary:holeInterval.bottomBoundary
          });
        }
        if(overlapTop < segment.yTop - 1e-6){
          nextSegments.push({
            yBottom:overlapTop,
            yTop:segment.yTop,
            bottomBoundary:holeInterval.topBoundary,
            topBoundary:segment.topBoundary
          });
        }
      });
      segments = nextSegments;
    });
    out.push(...segments.filter((segment)=>segment.yTop > segment.yBottom + 1e-6));
  });
  return out;
}

/**
 * `parentPolygon` with `holePolygon` cut out, as a list of quadrilateral strips between the
 * x-breaks of both polygons. Strips whose corners collapse are dropped by `polygonIsValid`.
 */
export function subtractHoleFromPolygon(parentPolygon, holePolygon){
  const parent = normalizeRegionPolygon(parentPolygon || []);
  const hole = normalizeRegionPolygon(holePolygon || []);
  if(parent.length < 3 || hole.length < 3) return [];
  const xBreaks = uniqueSortedNumbers([
    ...parent.map((pt)=>pt.x),
    ...hole.map((pt)=>pt.x)
  ]);
  const pieces = [];
  for(let i=0;i<xBreaks.length - 1;i+=1){
    const xL = xBreaks[i];
    const xR = xBreaks[i + 1];
    if(!(xR > xL + 1e-6)) continue;
    const xMid = 0.5 * (xL + xR);
    const parentIntervals = polygonIntervalsDetailed(parent, xMid);
    const holeIntervals = polygonIntervalsDetailed(hole, xMid);
    const visibleIntervals = subtractDetailedIntervals(parentIntervals, holeIntervals);
    visibleIntervals.forEach((interval)=>{
      const leftBottom = clampRegionPoint({x:xL, y:boundaryYAtX(interval.bottomBoundary, xL)});
      const leftTop = clampRegionPoint({x:xL, y:boundaryYAtX(interval.topBoundary, xL)});
      const rightTop = clampRegionPoint({x:xR, y:boundaryYAtX(interval.topBoundary, xR)});
      const rightBottom = clampRegionPoint({x:xR, y:boundaryYAtX(interval.bottomBoundary, xR)});
      const piece = normalizeRegionPolygon([leftBottom, leftTop, rightTop, rightBottom]);
      if(polygonIsValid(piece)){
        pieces.push(piece);
      }
    });
  }
  return pieces;
}

/**
 * The split tool: cut `region.polygon` along the chord cutA-cutB (both picked on the boundary).
 * → `{ok:true, polygons:[A, B]}` or `{ok:false, message}` — the monolith's five refusals, in its
 * order: no polygon, coincident cuts, a chord that leaves the polygon, cuts that collapse to one
 * boundary index, an invalid half, and an area that does not add up (a chord across a concavity).
 */
export function splitRegionPolygon(region, cutA, cutB){
  const polygon = region?.polygon || [];
  if(polygon.length < 3) return {ok:false, message:'Select a valid polygon before splitting it.'};
  if(dist(cutA, cutB) <= 1e-4){
    return {ok:false, message:'Choose two distinct points on the selected polygon boundary to split it.'};
  }
  const chordSamples = [0.25, 0.5, 0.75].every((t)=>{
    const point = {
      x:cutA.x + (cutB.x - cutA.x)*t,
      y:cutA.y + (cutB.y - cutA.y)*t
    };
    return pointInsideOrBoundary(point, polygon);
  });
  if(!chordSamples){
    return {ok:false, message:'The split line must stay inside the selected polygon.'};
  }
  const {boundary, cutIndices} = buildSplitBoundary(polygon, [
    {...cutA, name:'a'},
    {...cutB, name:'b'}
  ]);
  const indexA = cutIndices.a;
  const indexB = cutIndices.b;
  if(indexA == null || indexB == null || indexA === indexB){
    return {ok:false, message:'Choose two separate polygon-boundary points to split the polygon.'};
  }
  const polygonA = normalizeRegionPolygon(traverseBoundary(boundary, indexA, indexB));
  const polygonB = normalizeRegionPolygon(traverseBoundary(boundary, indexB, indexA));
  if(!polygonIsValid(polygonA) || !polygonIsValid(polygonB)){
    return {ok:false, message:'That split would create an invalid polygon. Try points on different edges.'};
  }
  const originalArea = polygonArea(polygon);
  const splitArea = polygonArea(polygonA) + polygonArea(polygonB);
  const areaTolerance = Math.max(0.01, originalArea * 1e-4);
  if(Math.abs(splitArea - originalArea) > areaTolerance){
    return {ok:false, message:'That split falls outside the polygon. Try a cut line that stays inside the region.'};
  }
  return {
    ok:true,
    polygons:[polygonA, polygonB]
  };
}
