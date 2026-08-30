// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/pointer.js — the Seep / Slope canvas pointer state machine (refactor step 9e,
// PLAN §2 row 18e; 01-monolith-map.md §2.11 group "Canvas interaction", §6.1 row `canvas/pointer.js`).
//
// Moved verbatim out of legacy-controller.js (line numbers of integration-r @ 3b84193):
//   stage6BishopUpdateHoverDom 5339 → hoverUpdate   (the pure half: readout, hit test, placement)
//   stage6BishopPointerDown    5941 → pointerDown
//   stage6BishopPointerMove    6032 → pointerMove
//   stage6BishopPointerUp      6130 → pointerUp     (bound to `pointercancel` too — see below)
//   stage6BishopPointerLeave   6203 → pointerLeave
//   stage6BishopWheel          6209 → wheel
//
// ── The machine ──────────────────────────────────────────────────────────────────────────────
// One `ctx` object describes the canvas the gesture is on:
//
//   { bishop, viewport, canvasState, rect() }
//
// `canvasState` is the host's three-field handle (`{canvas, pointerDrag, hoverWorld}`) — the
// machine's own memory: `pointerDrag` is the state ("idle" is `null`, otherwise one of the drag
// kinds or `'pan'`), `hoverWorld` is the last world point the pointer was over. `rect()` is the
// canvas' bounding rect, read lazily exactly where the monolith read it.
//
// ── Effects ──────────────────────────────────────────────────────────────────────────────────
// Every transition returns an ordered **effect log**. `{type:'preventDefault'}` is the one effect
// the host performs *after* the transition returns: the browser's default action happens after the
// handler, so its position inside the handler cannot matter. Every other effect is an `env`
// callback the machine calls at the very statement the monolith called it, and logs:
//
//   {type:'hover'} {type:'draw'} {type:'render'} {type:'hideHover'}
//   {type:'setPointerCapture', pointerId} {type:'releasePointerCapture', pointerId}
//
// They stay callbacks because their position *is* observable. A draw between two writes is what
// the user sees. And `renderStage6()` replaces `#stage6Area`'s innerHTML — the canvas element the
// gesture started on is gone afterwards — so the capture release has to happen before the
// invalidation / render of `up`, not after the transition. Logging them keeps the order assertable
// without a DOM (the verifier drives the machine with a recording `env`).
//
// Nothing here reads `S`, the DOM or a canvas element.
import {
  commitDrawPoint,
  completeCurrentActionAt,
  currentDragKey,
  dragHandleTo,
  nearestHandle,
  pickSurfaceLoadAtWorld,
  pickWallAtWorld,
  snapWorldPoint
} from './picking.js';
import { panOffsets, screenToWorldFromClient, zoomAtPoint } from './viewport.js';

/** Placement of the hover tooltip inside the canvas wrapper (monolith literals). */
export const TIP_LAYOUT = Object.freeze({ offsetPx: 16, minPx: 12, rightInsetPx: 292, bottomInsetPx: 180 });

const PREVENT_DEFAULT = Object.freeze({ type: 'preventDefault' });

/** The drag key of the handle currently held, for the snap-candidate exclusion. */
const excludeKeyOf = (ctx) => () => currentDragKey(ctx.canvasState.pointerDrag);

/**
 * The pointer readout and the hover tooltip, without a DOM.
 *
 * Returns `{world, snapped, coordText, tip}`; `tip` is `null` when the tooltip must be hidden,
 * `{html, left, top}` when it must be shown, and `undefined` when the caller asked for no tooltip
 * (`wantTip:false` — the monolith's `if(!tip || !model)` early return, whose two halves are host
 * conditions). `ctx.canvasState.hoverWorld` is updated, exactly where the monolith updated it.
 *
 * `env`: `{workspace, wrapRect(), tooltipForLoad(load), tooltipForWall(wall, meta), tooltipForRegion(region),
 * regionAt(world)}`.
 */
export function hoverUpdate(ctx, clientX, clientY, env, wantTip = true){
  const { bishop, viewport, canvasState } = ctx;
  const world = screenToWorldFromClient(ctx.rect(), clientX, clientY, viewport);
  const snapped = snapWorldPoint(world, 'free', bishop, viewport, excludeKeyOf(ctx));
  canvasState.hoverWorld = world;
  const snapEnabled = bishop.gridSnap || bishop.pointSnap;
  const coordText = `x = ${world.x.toFixed(2)} m · y = ${world.y.toFixed(2)} m${snapEnabled ? ` · snap ${snapped.x.toFixed(2)}, ${snapped.y.toFixed(2)} m` : ''}`;
  if(!wantTip) return { world, snapped, coordText, tip: undefined };
  const load = pickSurfaceLoadAtWorld(bishop, world, viewport);
  const hoveredWall = !load && bishop.workspace === 'deformation'
    ? pickWallAtWorld(bishop, world, viewport)
    : null;
  const region = !load && !hoveredWall ? env.regionAt(world) : null;
  const html = load
    ? env.tooltipForLoad(load)
    : hoveredWall
      ? env.tooltipForWall(hoveredWall)
      : region
        ? env.tooltipForRegion(region)
        : null;
  if(html === null) return { world, snapped, coordText, tip: null };
  const wrapRect = env.wrapRect();
  return {
    world,
    snapped,
    coordText,
    tip: {
      html,
      left: Math.min(Math.max(clientX - wrapRect.left + TIP_LAYOUT.offsetPx, TIP_LAYOUT.minPx), Math.max(wrapRect.width - TIP_LAYOUT.rightInsetPx, TIP_LAYOUT.minPx)),
      top: Math.min(Math.max(clientY - wrapRect.top + TIP_LAYOUT.offsetPx, TIP_LAYOUT.minPx), Math.max(wrapRect.height - TIP_LAYOUT.bottomInsetPx, TIP_LAYOUT.minPx))
    }
  };
}

/** The pan drag a middle-button press and an empty edit-mode press both start. */
function startPan(ctx, event){
  const { viewport, canvasState } = ctx;
  canvasState.pointerDrag = {
    kind:'pan',
    pointerId:event.pointerId,
    startX:event.clientX,
    startY:event.clientY,
    offsetX:viewport.offsetX,
    offsetY:viewport.offsetY
  };
}

/**
 * `down` — right button completes the current draft, middle button (and an empty edit-mode click)
 * starts a pan, an edit-mode click grabs a handle or selects the load / wall / region under it, and
 * every other tool commits a draw point.
 */
export function pointerDown(ctx, event, env){
  const { bishop, viewport, canvasState } = ctx;
  const effects = [];
  env.updateHover(event.clientX, event.clientY); effects.push({type:'hover'});
  if(event.button === 2){
    effects.push(PREVENT_DEFAULT);
    completeCurrentActionAt(bishop, screenToWorldFromClient(ctx.rect(), event.clientX, event.clientY, viewport), viewport, env, excludeKeyOf(ctx));
    return effects;
  }
  if(event.button === 1){
    effects.push(PREVENT_DEFAULT);
    startPan(ctx, event);
    env.setPointerCapture(event.pointerId); effects.push({type:'setPointerCapture', pointerId:event.pointerId});
    return effects;
  }
  if(bishop.tool === 'edit'){
    const handle = nearestHandle(bishop, viewport, ctx.rect(), event.clientX, event.clientY, env.selectedCustomRegion);
    if(handle){
      if(handle.kind === 'wallTop' || handle.kind === 'wallTip'){
        bishop.selectedWallId = bishop.walls?.[handle.index]?.id || null;
      }
      // Invalidation is owned by the gated pointer-up path (pointerUp below), keyed on
      // `drag.moved` and the handle kind. Grabbing a handle no longer destroys solved results
      // up-front, so a click-without-drag (selection only) preserves Bishop / seepage /
      // deformation results.
      canvasState.pointerDrag = {
        kind:handle.kind,
        index:handle.index,
        vertexIndex:handle.vertexIndex,
        regionId:handle.regionId,
        loadId:handle.loadId,
        moved:false,
        pointerId:event.pointerId
      };
      env.setPointerCapture(event.pointerId); effects.push({type:'setPointerCapture', pointerId:event.pointerId});
      return effects;
    }
    const model = env.model();
    const world = screenToWorldFromClient(ctx.rect(), event.clientX, event.clientY, viewport);
    const load = pickSurfaceLoadAtWorld(bishop, world, viewport);
    if(load){
      bishop.selectedSurfaceLoadId = load.id;
      bishop.selectedRegionId = null;
      bishop.selectedWallId = null;
      env.render(); effects.push({type:'render'});
      return effects;
    }
    const wall = pickWallAtWorld(bishop, world, viewport);
    if(wall){
      bishop.selectedWallId = wall.id;
      bishop.selectedSurfaceLoadId = null;
      bishop.selectedRegionId = null;
      bishop.selectedDrainId = '';
      env.openStructuresPanel();
      env.render(); effects.push({type:'render'});
      return effects;
    }
    const region = (bishop.customRegions || []).length
      ? env.regionAtInModel(model, world)
      : null;
    if(region){
      bishop.selectedRegionId = region.id;
      bishop.selectedWallId = null;
      env.render(); effects.push({type:'render'});
      return effects;
    }
    startPan(ctx, event);
    env.setPointerCapture(event.pointerId); effects.push({type:'setPointerCapture', pointerId:event.pointerId});
    return effects;
  }
  commitDrawPoint(bishop, screenToWorldFromClient(ctx.rect(), event.clientX, event.clientY, viewport), viewport, env, excludeKeyOf(ctx));
  return effects;
}

/**
 * `move` — always refreshes the hover readout; then pans, or moves the held handle. A move the
 * geometry rejects (a zero-length terrain edge, an invalid region polygon, a vanished entity)
 * skips the redraw, exactly as the monolith's early `return`s did.
 */
export function pointerMove(ctx, event, env){
  const { bishop, viewport, canvasState } = ctx;   // ctx.viewport IS bishop.viewport (same object)
  const effects = [];
  env.updateHover(event.clientX, event.clientY); effects.push({type:'hover'});
  const drag = canvasState.pointerDrag;
  if(!drag || drag.pointerId !== event.pointerId){
    return effects;
  }
  if(drag.kind === 'pan'){
    Object.assign(viewport, panOffsets(drag, event.clientX, event.clientY));
    env.draw(); effects.push({type:'draw'});
    return effects;
  }
  // Mark that this handle drag actually produced pointer motion. pointer-up uses `drag.moved` to
  // gate result invalidation so a click-without-drag on a handle (selection only, no geometry
  // change) does not needlessly destroy solved Bishop / seepage / deformation results.
  drag.moved = true;
  const world = screenToWorldFromClient(ctx.rect(), event.clientX, event.clientY, viewport);
  if(dragHandleTo(bishop, drag, world, viewport, excludeKeyOf(ctx)) === false) return effects;
  env.draw(); effects.push({type:'draw'});
  return effects;
}

/**
 * Per-kind result invalidation of a finished drag, gated on actual drag motion (`drag.moved`).
 * A handle grab no longer clears results up-front, so a click-without-drag (selection only) leaves
 * Bishop / seepage / deformation results intact. Each branch uses the narrowest invalidator that
 * covers what the edit physically changed, avoiding double-invalidating the same analysis:
 *   env.invalidate             → Bishop + deformation
 *   env.invalidateSeepage      → seepage
 *   env.invalidateDeformation  → deformation
 *   env.invalidateWallGeometry → Bishop + deformation + seepage (everything)
 */
function invalidateForDrag(bishop, kind, env){
  if(kind === 'wallTop' || kind === 'wallTip'){
    // Wall endpoint moved: geometry feeds Bishop slip search, seepage domain, and the deformation
    // mesh/beam. Invalidate all three. This already calls the seepage invalidator internally, so
    // the old bare seepage call here was redundant and is dropped.
    env.invalidateWallGeometry('Retaining wall geometry updated; rerun analyses.');
  } else if(kind === 'terrain'){
    // Terrain shape changes Bishop, the seepage domain, and the deformation mesh. Clearing custom
    // regions (when present) already invalidates Bishop + deformation; otherwise invalidate
    // Bishop + deformation directly. Either way, seepage too.
    if((bishop.customRegions || []).length){
      env.clearCustomRegions('Terrain updated; custom soil polygons were cleared and analyses were reset.');
    } else {
      env.invalidate('Terrain geometry updated; rerun analyses.');
    }
    env.invalidateSeepage('Terrain geometry updated; rerun seepage.', false, false);
  } else if(kind === 'cpt'){
    // Moving the active-CPT marker remaps the soil layering everywhere: Bishop, seepage and
    // deformation all depend on it.
    env.invalidate('Active CPT location updated; rerun analyses.');
    env.invalidateSeepage('Active CPT location updated; rerun seepage.', false, false);
  } else if(kind === 'regionVertex'){
    // A custom soil-polygon vertex moved: Bishop, seepage and deformation.
    env.invalidate('Soil polygon geometry updated; rerun analyses.');
    env.invalidateSeepage('Soil polygon geometry updated; rerun seepage.', false, false);
  } else if(kind === 'phreatic'){
    // The phreatic polyline feeds the Bishop slice pore pressures DIRECTLY
    // (averagePorePressureOnBase samples model.phreatic when FEM pore pressure is off), as well as
    // the seepage field and the deformation solve. Invalidate all three.
    env.invalidate('Phreatic line updated; rerun analyses.');
    env.invalidateSeepage('Phreatic line updated; rerun seepage.', false, false);
  } else if(kind === 'drainVertex'){
    // Drains act only through the seepage solve (Bishop consumes that field solely via the
    // FEM-pore-pressure option, which carries its own staleness flag) and through the pore
    // pressures the deformation solve uses. Invalidate seepage + deformation.
    env.invalidateSeepage('Drain geometry updated; rerun seepage.', false, false);
    env.invalidateDeformation('Drain geometry updated; rerun deformation analysis.');
  } else if(kind === 'loadStart' || kind === 'loadEnd'){
    // Surface-load extent changes the Bishop driving moment and the deformation loading, but not
    // the seepage domain. Bishop + deformation.
    env.invalidate('Surface load geometry updated; rerun analyses.');
  } else if(kind.startsWith('entry') || kind.startsWith('exit')){
    // Entry/exit zones only retune the Bishop slip-circle search window (no seepage/deformation
    // coupling). Keep the prior "Bishop only" behaviour; env.invalidate is the narrowest available
    // invalidator that clears the Bishop results (it also drops any stale deformation, which is
    // harmless here since the window does not feed the deformation solve).
    env.invalidate('Bishop search window updated; rerun Bishop search.');
  }
}

/**
 * `up` — ends the drag, releases the capture and invalidates what the edit changed.
 *
 * `pointercancel` is bound to this same transition by the host (`initStage6BishopCanvas`), so a
 * cancelled gesture commits the geometry it had already written and invalidates for it — the
 * monolith's behaviour, kept deliberately: `move` mutates the state directly, so there is nothing
 * to roll back to.
 */
export function pointerUp(ctx, event, env){
  const { bishop, canvasState } = ctx;
  const effects = [];
  const drag = canvasState.pointerDrag;
  if(!drag || drag.pointerId !== event.pointerId) return effects;
  canvasState.pointerDrag = null;
  env.releasePointerCapture(event.pointerId); effects.push({type:'releasePointerCapture', pointerId:event.pointerId});
  if(drag.moved) invalidateForDrag(bishop, drag.kind, env);
  env.render(); effects.push({type:'render'});
  return effects;
}

/** `cancel` — the monolith binds `pointercancel` to the very same handler as `pointerup`. */
export const pointerCancel = pointerUp;

/** The pointer left the canvas: drop the hover point, hide the tooltip, redraw. */
export function pointerLeave(ctx, env){
  const effects = [];
  ctx.canvasState.hoverWorld = null;
  env.hideHover(); effects.push({type:'hideHover'});
  env.draw(); effects.push({type:'draw'});
  return effects;
}

/** Wheel zoom about the pointer. */
export function wheel(ctx, event, env){
  const { bishop, viewport } = ctx;
  const effects = [PREVENT_DEFAULT];
  const rect = ctx.rect();
  Object.assign(viewport, zoomAtPoint(viewport, event.clientX - rect.left, event.clientY - rect.top, event.deltaY));
  env.draw(); effects.push({type:'draw'});
  return effects;
}
