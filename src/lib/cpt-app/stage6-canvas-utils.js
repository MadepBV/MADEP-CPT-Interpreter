// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stage 6 — shared 2D canvas / SVG helpers.
//
// World coordinates are application units (metres). Screen coordinates are
// pixels relative to the host element's viewBox or bounding client rect.
//
// A viewport object is `{scale, offsetXpx, offsetZpx, fitted}`:
//   - scale     : pixels per metre (uniform; aspect ratios are honoured by
//                 the host element rather than by anisotropic scaling)
//   - offsetXpx : screen-x of world-x = 0
//   - offsetZpx : screen-y of world-z = 0   (world z increases downward)
//   - fitted    : has `fitViewport` been applied to this viewport yet?

const TWO_PI = Math.PI * 2;

export function makeViewport(overrides = {}) {
  return {
    scale: 36,
    offsetXpx: 0,
    offsetZpx: 0,
    fitted: false,
    ...overrides
  };
}

export function worldToScreen(world, viewport) {
  return {
    x: viewport.offsetXpx + (world.x ?? 0) * viewport.scale,
    y: viewport.offsetZpx + (world.z ?? 0) * viewport.scale
  };
}

export function screenToWorld(px, viewport) {
  return {
    x: (px.x - viewport.offsetXpx) / viewport.scale,
    z: (px.y - viewport.offsetZpx) / viewport.scale
  };
}

// Fit the world bounding box into the screen box, preserving aspect ratio.
// `worldBox`  : { xMin, xMax, zMin, zMax } in metres
// `screenBox` : { width, height } in pixels
// `padding`   : pixel margin inside the screen box
export function fitViewport(worldBox, screenBox, padding = 16) {
  const wW = Math.max(worldBox.xMax - worldBox.xMin, 1e-6);
  const wH = Math.max(worldBox.zMax - worldBox.zMin, 1e-6);
  const sW = Math.max(screenBox.width - 2 * padding, 1);
  const sH = Math.max(screenBox.height - 2 * padding, 1);
  const scale = Math.min(sW / wW, sH / wH);
  const usedW = wW * scale;
  const usedH = wH * scale;
  const offsetXpx = padding + (sW - usedW) / 2 - worldBox.xMin * scale;
  const offsetZpx = padding + (sH - usedH) / 2 - worldBox.zMin * scale;
  return {
    scale: Number.isFinite(scale) && scale > 0 ? scale : 36,
    offsetXpx,
    offsetZpx,
    fitted: true
  };
}

export function panViewport(viewport, dxPx, dzPx) {
  return {
    ...viewport,
    offsetXpx: viewport.offsetXpx + dxPx,
    offsetZpx: viewport.offsetZpx + dzPx
  };
}

// Zoom about an anchor in screen coordinates. The world point under the anchor
// stays under the anchor after the zoom.
export function zoomViewport(viewport, factor, anchorPx) {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  if (f === 1) return viewport;
  const anchor = anchorPx || { x: 0, y: 0 };
  const world = screenToWorld(anchor, viewport);
  const newScale = clampScale(viewport.scale * f);
  const newOffsetX = anchor.x - world.x * newScale;
  const newOffsetZ = anchor.y - world.z * newScale;
  return {
    ...viewport,
    scale: newScale,
    offsetXpx: newOffsetX,
    offsetZpx: newOffsetZ
  };
}

function clampScale(scale) {
  if (!Number.isFinite(scale)) return 36;
  return Math.min(Math.max(scale, 0.5), 5000);
}

// Generic snapping ----------------------------------------------------------

export function snapToGrid(value, gridSize) {
  if (!Number.isFinite(value)) return value;
  const g = Number.isFinite(gridSize) && gridSize > 0 ? gridSize : 0;
  if (g <= 0) return value;
  return Math.round(value / g) * g;
}

// Snap to the nearest entry in `anchors` if it is within `tolerance`,
// otherwise return the original value. Returns { value, anchor, snapped }.
export function snapToAnchors(value, anchors, tolerance) {
  if (!Number.isFinite(value)) return { value, anchor: null, snapped: false };
  const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
  let best = null;
  let bestDist = Infinity;
  for (let i = 0; i < (anchors?.length || 0); i += 1) {
    const a = anchors[i];
    const d = Math.abs(a - value);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  if (best != null && bestDist <= tol) {
    return { value: best, anchor: best, snapped: true };
  }
  return { value, anchor: null, snapped: false };
}

// Pointer scaffolding -------------------------------------------------------
//
// `attachPanZoomPointer(el, getViewport, setViewport, opts)` wires pointer /
// wheel events on `el` to provide:
//   - left-button drag on empty space → pan
//   - middle/right-button drag → pan (always, even on geometry)
//   - wheel → zoom about pointer
//   - touch single-finger drag on empty space → pan
//   - touch two-finger pinch → zoom (handled via pointer events)
//
// `opts.onDragStart(target, world)` returns a drag descriptor or null.
// While dragging, `opts.onDragMove(descriptor, world, evt)` is called.
// On release, `opts.onDragEnd(descriptor, world, evt)` is called.
//
// The returned object exposes `dispose()` to unbind. Re-binding is idempotent
// when the same `el` is passed: a `__stage6PanZoom` marker is checked.
export function attachPanZoomPointer(el, getViewport, setViewport, opts = {}) {
  if (!el) return { dispose() {} };
  if (el.__stage6PanZoom) {
    el.__stage6PanZoom.dispose();
  }
  const state = {
    pointers: new Map(),
    pinchPrevDist: null,
    panActive: false,
    panLastPx: null,
    drag: null
  };

  const getElPx = (evt) => {
    const rect = el.getBoundingClientRect();
    const sx = el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.width
      ? el.viewBox.baseVal.width / Math.max(rect.width, 1)
      : 1;
    const sy = el.viewBox && el.viewBox.baseVal && el.viewBox.baseVal.height
      ? el.viewBox.baseVal.height / Math.max(rect.height, 1)
      : 1;
    return {
      x: (evt.clientX - rect.left) * sx,
      y: (evt.clientY - rect.top) * sy
    };
  };

  const onPointerDown = (evt) => {
    el.setPointerCapture?.(evt.pointerId);
    state.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    if (state.pointers.size === 2) {
      state.panActive = false;
      state.pinchPrevDist = pinchDistance(state.pointers);
      return;
    }
    const px = getElPx(evt);
    const world = screenToWorld(px, getViewport());

    // Middle / right button always pans, regardless of target
    const isPanButton = evt.button === 1 || evt.button === 2;
    let drag = null;
    if (!isPanButton && opts.onDragStart) {
      drag = opts.onDragStart(evt.target, world, evt) || null;
    }
    if (drag) {
      state.drag = { ...drag, startWorld: world, startEvt: evt };
      if (opts.onDragMove) opts.onDragMove(state.drag, world, evt);
    } else {
      state.panActive = true;
      state.panLastPx = { x: evt.clientX, y: evt.clientY };
    }
    evt.preventDefault();
  };

  const onPointerMove = (evt) => {
    if (state.pointers.has(evt.pointerId)) {
      state.pointers.set(evt.pointerId, { x: evt.clientX, y: evt.clientY });
    }
    if (state.pointers.size === 2 && state.pinchPrevDist != null) {
      const dist = pinchDistance(state.pointers);
      if (dist > 0 && state.pinchPrevDist > 0) {
        const factor = dist / state.pinchPrevDist;
        const center = pinchCenter(state.pointers);
        const rect = el.getBoundingClientRect();
        const anchor = { x: center.x - rect.left, y: center.y - rect.top };
        setViewport(zoomViewport(getViewport(), factor, anchor));
        state.pinchPrevDist = dist;
      }
      evt.preventDefault();
      return;
    }
    if (state.drag && opts.onDragMove) {
      const px = getElPx(evt);
      const world = screenToWorld(px, getViewport());
      opts.onDragMove(state.drag, world, evt);
      evt.preventDefault();
      return;
    }
    if (state.panActive && state.panLastPx) {
      const dx = evt.clientX - state.panLastPx.x;
      const dy = evt.clientY - state.panLastPx.y;
      state.panLastPx = { x: evt.clientX, y: evt.clientY };
      setViewport(panViewport(getViewport(), dx, dy));
      evt.preventDefault();
      return;
    }
    if (opts.onHover) {
      const px = getElPx(evt);
      const world = screenToWorld(px, getViewport());
      opts.onHover(evt.target, world, evt);
    }
  };

  const onPointerUp = (evt) => {
    el.releasePointerCapture?.(evt.pointerId);
    state.pointers.delete(evt.pointerId);
    if (state.pointers.size < 2) state.pinchPrevDist = null;
    if (state.drag) {
      if (opts.onDragEnd) {
        const px = getElPx(evt);
        const world = screenToWorld(px, getViewport());
        opts.onDragEnd(state.drag, world, evt);
      }
      state.drag = null;
    }
    state.panActive = false;
    state.panLastPx = null;
  };

  const onPointerCancel = (evt) => {
    if (state.drag && opts.onDragCancel) {
      opts.onDragCancel(state.drag, evt);
    }
    state.drag = null;
    state.panActive = false;
    state.panLastPx = null;
    state.pointers.delete(evt.pointerId);
    state.pinchPrevDist = null;
  };

  const onPointerLeave = (evt) => {
    if (opts.onHoverLeave) opts.onHoverLeave(evt);
  };

  const onWheel = (evt) => {
    const rect = el.getBoundingClientRect();
    const anchor = { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
    const factor = evt.deltaY < 0 ? 1.15 : 1 / 1.15;
    setViewport(zoomViewport(getViewport(), factor, anchor));
    evt.preventDefault();
  };

  const onContextMenu = (evt) => evt.preventDefault();

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerCancel);
  el.addEventListener('pointerleave', onPointerLeave);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', onContextMenu);

  const handle = {
    dispose() {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerCancel);
      el.removeEventListener('pointerleave', onPointerLeave);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContextMenu);
      el.__stage6PanZoom = null;
    },
    cancelDrag() {
      if (state.drag && opts.onDragCancel) opts.onDragCancel(state.drag, null);
      state.drag = null;
    },
    isDragging() {
      return !!state.drag;
    }
  };
  el.__stage6PanZoom = handle;
  return handle;
}

function pinchDistance(pointers) {
  const arr = Array.from(pointers.values());
  if (arr.length < 2) return 0;
  const dx = arr[0].x - arr[1].x;
  const dy = arr[0].y - arr[1].y;
  return Math.hypot(dx, dy);
}

function pinchCenter(pointers) {
  const arr = Array.from(pointers.values());
  if (arr.length < 2) return { x: 0, y: 0 };
  return { x: (arr[0].x + arr[1].x) / 2, y: (arr[0].y + arr[1].y) / 2 };
}

// Geometry helpers ----------------------------------------------------------

export function clampValue(value, min, max) {
  if (!Number.isFinite(value)) return Math.min(Math.max(0, min), max);
  return Math.min(Math.max(value, min), max);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function rotatePoint(pt, angleRad, about = { x: 0, y: 0 }) {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  const dx = pt.x - about.x;
  const dy = pt.y - about.y;
  return {
    x: about.x + dx * cos - dy * sin,
    y: about.y + dx * sin + dy * cos
  };
}

export const GEOM_TWO_PI = TWO_PI;
