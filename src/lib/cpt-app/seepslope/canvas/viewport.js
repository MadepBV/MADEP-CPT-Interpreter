// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/viewport.js — the Seep / Slope section viewport (refactor step 9e, PLAN §2
// row 18e; 01-monolith-map.md §2.11 group "Canvas interaction", §6.1 row `canvas/viewport.js`).
//
// The viewport is the four-field block on the bishop state: `{scale, offsetX, offsetY, fitted}`.
// `scale` is pixels per metre, `offsetX` / `offsetY` are the screen coordinates of the world
// origin, and the y axis is flipped (world +y is up, screen +y is down). Everything here is pure:
// a viewport goes in, numbers come out. Nothing reads `S`, the DOM or a canvas element — the host
// measures the canvas (`getBoundingClientRect`) and applies the returned patches.
//
// Moved verbatim out of legacy-controller.js (line numbers of integration-r @ 3b84193):
//   stage6BishopScreenToWorld           5406   → screenToWorld / screenToWorldFromClient
//   stage6BishopWorldToScreen           5417   → worldToScreen
//   stage6BishopSnapToleranceWorld      5425   → snapToleranceWorld
//   stage6BishopBoundaryPickToleranceWorld 5322 → boundaryPickToleranceWorld  (PR 18d left it behind
//                                                 because it was the geometry package's one viewport
//                                                 read; report 26 finding 2)
//   stage6BishopCanvasWorldBounds       5537   → canvasWorldBounds
//   fitStage6BishopViewport             5564   → fitViewport   (the pure half: bounds+box → patch)
//   stage6BishopWheel                   6209   → zoomAtPoint   (the pure half)
//   stage6BishopDrawGrid                6221   → gridSpec      (the pure half; the strokes are
//                                                 seepslope/canvas/draw/background.js)
//
// The two other pixel tolerances the monolith derived from `viewport.scale` inline live here too,
// so that every "px → world" conversion of the app is in one file:
//   surfaceLoadPickHeightWorld  the surface-load hit box (stage6BishopPickSurfaceLoadAtWorld 5643)
//   measurementLabelOffsetWorld the Measure tool's label offset (drawMeasurementOverlay)
import { sortedPolyline } from '../state/domain.js';
import { wallEndpoints } from '../../wall-geometry.js';

/** Every pixel constant of the viewport, in one place (all monolith literals). */
export const VIEWPORT_LIMITS = Object.freeze({
  snapTolerancePx: 14,       // stage6BishopSnapToleranceWorld
  handlePickRadiusPx: 12,    // stage6BishopNearestHandle
  loadPickHeightPx: 22,      // stage6BishopPickSurfaceLoadAtWorld
  loadPickHeightMinWorld: 0.8,
  measurementLabelPx: 12,    // drawMeasurementOverlay
  measurementLabelMinWorld: 0.2,
  fallbackScale: 24,         // the `|| 24` of every `viewport.scale` read on a px → world division
  fitMarginPx: 28,
  fitMinScale: 8,
  fitMinBoxPx: 100,
  zoomFactor: 1.08,
  minScale: 4,
  maxScale: 220,
  gridMinSpacingPx: 18
});

/** The default bounds of an empty section (no terrain): the monolith's literal. */
export const EMPTY_WORLD_BOUNDS = Object.freeze({ minX: 0, maxX: 20, minY: -10, maxY: 5 });

/** World point → screen (canvas-local CSS pixels). */
export function worldToScreen(pt, viewport){
  return {
    x: pt.x * viewport.scale + viewport.offsetX,
    y: viewport.offsetY - pt.y * viewport.scale
  };
}

/** Screen point (canvas-local CSS pixels) → world. */
export function screenToWorld(sx, sy, viewport){
  return {
    x: (sx - viewport.offsetX) / viewport.scale,
    y: (viewport.offsetY - sy) / viewport.scale
  };
}

/**
 * Client (viewport) coordinates → world, given the canvas' bounding rect. This is the monolith's
 * `stage6BishopScreenToWorld(canvas, clientX, clientY)` with the one DOM read hoisted out.
 */
export function screenToWorldFromClient(rect, clientX, clientY, viewport){
  return screenToWorld(clientX - rect.left, clientY - rect.top, viewport);
}

/**
 * The snap / pick tolerance in world units: 14 screen px at the current scale. `scale` falsy (0,
 * NaN, undefined, a missing viewport) reads as 24 px/m and the result is clamped at 1 px/m, exactly
 * as the monolith's `Math.max(S?.stage6?.bishop?.viewport?.scale || 24, 1)` did.
 */
export function snapToleranceWorld(viewport){
  const scale = Math.max(viewport?.scale || VIEWPORT_LIMITS.fallbackScale, 1);
  return VIEWPORT_LIMITS.snapTolerancePx / scale;
}

/**
 * The tolerance the polygon-boundary pick uses. The monolith kept it as its own name although the
 * body was `return stage6BishopSnapToleranceWorld();` — the split tool's pick radius is the app's
 * one deliberate alias of the snap tolerance, so the name (and the seam for changing it) stays.
 */
export function boundaryPickToleranceWorld(viewport){
  return snapToleranceWorld(viewport);
}

/** Height of the surface-load hit box above the terrain, in world units (22 px, at least 0.8 m). */
export function surfaceLoadPickHeightWorld(viewport){
  return Math.max(
    VIEWPORT_LIMITS.loadPickHeightMinWorld,
    VIEWPORT_LIMITS.loadPickHeightPx / Math.max(viewport?.scale || VIEWPORT_LIMITS.fallbackScale, 1)
  );
}

/** Vertical offset of the Measure tool's label above the line, in world units (12 px, ≥ 0.2 m). */
export function measurementLabelOffsetWorld(viewport){
  return Math.max(
    VIEWPORT_LIMITS.measurementLabelMinWorld,
    VIEWPORT_LIMITS.measurementLabelPx / Math.max(viewport?.scale || VIEWPORT_LIMITS.fallbackScale, 1)
  );
}

/**
 * The world box the Fit view button frames: the terrain polyline plus every wall endpoint and drain
 * vertex, down to the model's analysis bottom (or `analysisDepth` below the highest point when no
 * model has been built yet). Without at least two terrain points the monolith's fixed default box
 * is returned.
 */
export function canvasWorldBounds(bishop, model){
  const terrain = sortedPolyline(bishop.terrain);
  if(terrain.length >= 2){
    const xs = terrain.map(pt=>pt.x);
    const ys = terrain.map(pt=>pt.y);
    (bishop.walls || []).forEach((wall)=>{
      const endpoints = wallEndpoints(wall);
      if(!endpoints) return;
      xs.push(endpoints.head.x, endpoints.tip.x);
      ys.push(endpoints.head.y, endpoints.tip.y);
    });
    (bishop.drains || []).forEach((drain)=>{
      (drain.vertices || []).forEach((point)=>{
        if(Number.isFinite(point?.x)) xs.push(point.x);
        if(Number.isFinite(point?.y)) ys.push(point.y);
      });
    });
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    const minY = model ? model.analysisBottomY : (maxY - Math.max(+bishop.analysisDepth || 15, 1));
    return {minX, maxX, minY, maxY};
  }
  return {...EMPTY_WORLD_BOUNDS};
}

/**
 * The viewport patch that frames `bounds` in a `rect.width × rect.height` canvas: a 28 px margin,
 * never below 8 px/m, the box centred. The host applies the four keys onto the live viewport
 * object (it keeps its identity and key order) and redraws.
 */
export function fitViewport(bounds, rectWidth, rectHeight){
  const width = Math.max(rectWidth, VIEWPORT_LIMITS.fitMinBoxPx);
  const height = Math.max(rectHeight, VIEWPORT_LIMITS.fitMinBoxPx);
  const dx = Math.max(bounds.maxX - bounds.minX, 1);
  const dy = Math.max(bounds.maxY - bounds.minY, 1);
  const margin = VIEWPORT_LIMITS.fitMarginPx;
  const scale = Math.max(
    Math.min((width - 2*margin)/dx, (height - 2*margin)/dy),
    VIEWPORT_LIMITS.fitMinScale
  );
  const cx = 0.5*(bounds.minX + bounds.maxX);
  const cy = 0.5*(bounds.minY + bounds.maxY);
  return {
    scale,
    offsetX: width*0.5 - cx*scale,
    offsetY: height*0.5 + cy*scale,
    fitted: true
  };
}

/**
 * The wheel-zoom patch: scale by 1.08 per notch (clamped to 4…220 px/m) about the pointer, so the
 * world point under the cursor does not move. `localX` / `localY` are canvas-local CSS pixels.
 */
export function zoomAtPoint(viewport, localX, localY, deltaY){
  const before = screenToWorld(localX, localY, viewport);
  const factor = deltaY < 0 ? VIEWPORT_LIMITS.zoomFactor : 1/VIEWPORT_LIMITS.zoomFactor;
  const scale = Math.min(Math.max(viewport.scale * factor, VIEWPORT_LIMITS.minScale), VIEWPORT_LIMITS.maxScale);
  return {
    scale,
    offsetX: localX - before.x * scale,
    offsetY: localY + before.y * scale
  };
}

/** The pan patch of a drag: the offsets the drag started from plus the pointer delta. */
export function panOffsets(drag, clientX, clientY){
  return {
    offsetX: drag.offsetX + (clientX - drag.startX),
    offsetY: drag.offsetY + (clientY - drag.startY)
  };
}

/**
 * The grid the background layer strokes: the world step and the first / last line in each axis, or
 * `{show:false}` when the lines would sit closer than 18 px. The draw layer keeps the monolith's
 * `for(let x=startX; x<=endX+1e-9; x+=step)` accumulation, so the line positions are bit-identical.
 */
export function gridSpec(viewport, width, height, snapSize){
  const step = Math.max(snapSize || 0.5, 0.05);
  if(viewport.scale * step < VIEWPORT_LIMITS.gridMinSpacingPx) return {show:false, step};
  const xMin = (0 - viewport.offsetX) / viewport.scale;
  const xMax = (width - viewport.offsetX) / viewport.scale;
  const yMax = viewport.offsetY / viewport.scale;
  const yMin = (viewport.offsetY - height) / viewport.scale;
  return {
    show: true,
    step,
    startX: Math.floor(xMin / step) * step,
    endX: Math.ceil(xMax / step) * step,
    startY: Math.floor(yMin / step) * step,
    endY: Math.ceil(yMax / step) * step
  };
}
