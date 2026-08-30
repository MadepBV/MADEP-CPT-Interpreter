// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Interactive section canvas for the retaining-wall app, mirroring the Seep/Slope
// (bishop) interaction model: an affine viewport {scale, ox, oy} with pan (drag
// empty space), wheel zoom, fit-to-content, and draggable handles. The UI module
// supplies a "scene" (soil layers, wall polygons, water, loads, pressure/BM diagrams,
// anchor, handles) and drag callbacks; this module renders it and dispatches drags
// with world coordinates + the handle id (geometry inversion lives in the UI module).
//
// Colours (PR 15, 02-design-system.md §3.13 / §5.2 row 2f): the scene builders (scenes/*.js) are pure
// and golden-locked — their literal palette is part of `*.scene.json`, so it cannot move to tokens.
// This module therefore *maps* that palette onto the `--viz-*` roles of theme.ts `retainingVizSeries()`
// at paint time, and takes the soil fills from the `--soil-*` tokens of soil-styles.js. A theme switch
// changes what the same scene paints, without a scene rebuild; anything the map does not know is
// painted as given, so a new scene colour degrades to its literal instead of disappearing.

import { retainingVizSeries, token } from '../../styles/theme.ts';
import { SOIL_CLASS_NAMES, SOIL_FILL_COLORS } from '../soil-styles.js';

const HANDLE_HIT = 11; // px

/** '#c0dd97' → '--soil-peat' (soil-styles.js is the source of both halves). */
const SOIL_TOKENS = {};
for (const [type, cls] of Object.entries(SOIL_CLASS_NAMES)) {
  const literal = SOIL_FILL_COLORS[type];
  if (literal) SOIL_TOKENS[literal.toLowerCase()] = `--soil-${cls.slice(2)}`;
}

const key = (c) => String(c).toLowerCase().replace(/\s+/g, '');

/** Scene literal → role of retainingVizSeries(). Every colour scenes/*.js can emit is listed. */
function sceneRoles(S) {
  return {
    '#8a8f98': S.wallFill,                  // COLORS.steel — sheet / soldier pile body
    '#3d4350': S.wall,                      // COLORS.steelStroke — outline + spacing dimension
    '#b8bcc4': S.lagging,                   // COLORS.lagging
    '#b89b6e': S.berm,                      // COLORS.insitu
    '#cfcabe': S.concrete,                  // gravity / cantilever stem + base
    '#6d6962': S.dim,                       // concreteStroke + H / B dimension lines
    '#3d6b6a': S.water,                     // COLORS.water
    '#9b3a32': S.retained,                  // COLORS.active — σ active
    '#2e6f55': S.passive,                   // COLORS.passive — σ passive, embedment dimension
    '#7e50a8': S.moment,                    // COLORS.bm — M on the section
    '#8a620d': S.shear,                     // COLORS.shear, berm dimension, surcharge arrows
    '#b43c32': S.bad,                       // over-dig dimension + drivability refusal marker
    'rgba(216,177,90,0.45)': S.berm,        // retained berm (embedded)
    'rgba(216,177,90,0.5)': S.berm,         // backfill wedge (gravity)
    'rgba(120,90,30,0.3)': S.bermHatch,
    'rgba(120,90,30,0.5)': S.bermLine,
    'rgba(120,90,30,0.4)': S.bermLine,
    'rgba(180,60,50,0.10)': S.overdig,
    'rgba(150,40,30,0.35)': S.overdigLine,
    'rgba(46,111,85,0.16)': S.passiveWedge,
    'rgba(46,111,85,0.14)': S.passiveFill,
    'rgba(155,58,50,0.16)': S.retainedFill,
    'rgba(126,80,168,0.16)': S.momentFill,
    'rgba(138,98,13,0.16)': S.shearFill
  };
}

// One resolved palette shared by every canvas, rebuilt when the theme changes. `token('--viz-1')` is
// a single getComputedStyle read on a probe span — cheap enough for the drag loop (render() runs per
// pointermove) — and it doubles as the change detector: theme.ts drops its probes on `madep:theme`,
// so the next read returns the new value and the cache falls. No subscription of ours can go stale.
let cache = null;
function palette() {
  const probe = token('--viz-1');
  if (cache && cache.probe === probe) return cache;
  const S = retainingVizSeries();
  const roles = sceneRoles(S);
  const soil = {};
  for (const [literal, name] of Object.entries(SOIL_TOKENS)) soil[literal] = token(name) || literal;
  cache = { probe, S, roles, soil };
  return cache;
}
/** Scene colour → theme colour (soil fills included); unknown colours pass through. */
function ink(P, c, fallback) {
  if (c == null || c === '') return fallback;
  const k = key(c);
  return P.roles[k] || P.soil[k] || c;
}

export function createRetainingCanvas(canvas, hooks) {
  const state = { canvas, hooks, vp: null, hover: null, drag: null, pan: null };

  function world(scene, sx, sy) {
    const v = state.vp;
    return { x: (sx - v.ox) / v.scale, y: (v.oy - sy) / v.scale };
  }
  function screen(x, y) {
    const v = state.vp;
    return { x: x * v.scale + v.ox, y: v.oy - y * v.scale };
  }

  function fit(scene) {
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(rect.width, 200), H = Math.max(rect.height, 200);
    const b = scene.bounds;
    const dx = Math.max(b.maxX - b.minX, 0.5), dy = Math.max(b.maxY - b.minY, 0.5);
    const m = 54;
    const scale = Math.max(Math.min((W - 2 * m) / dx, (H - 2 * m) / dy), 2);
    state.vp = {
      scale,
      ox: m + (W - 2 * m - dx * scale) / 2 - b.minX * scale,
      oy: H - m - (H - 2 * m - dy * scale) / 2 + b.minY * scale
    };
  }

  function localXY(evt) {
    const r = canvas.getBoundingClientRect();
    return { sx: evt.clientX - r.left, sy: evt.clientY - r.top };
  }

  function pickHandle(scene, sx, sy) {
    let best = null;
    for (const h of (scene.handles || [])) {
      const s = screen(h.x, h.y);
      const d = Math.hypot(s.x - sx, s.y - sy);
      if (d <= HANDLE_HIT && (!best || d < best.d)) best = { h, d };
    }
    return best ? best.h : null;
  }

  // ----- pointer interaction -----
  canvas.onpointerdown = (e) => {
    const scene = state.hooks.getScene(); if (!scene || !state.vp) return;
    const { sx, sy } = localXY(e);
    const h = pickHandle(scene, sx, sy);
    if (h) state.drag = { id: h.id, axis: h.axis || 'xy' };
    else state.pan = { sx, sy, ox: state.vp.ox, oy: state.vp.oy };
    try { canvas.setPointerCapture?.(e.pointerId); state.captured = e.pointerId; } catch {}
    e.preventDefault();
  };
  canvas.onpointermove = (e) => {
    const scene = state.hooks.getScene(); if (!scene || !state.vp) return;
    const { sx, sy } = localXY(e);
    if (state.drag) {
      const w = world(scene, sx, sy);
      state.hooks.onDrag?.(state.drag.id, w, state.drag.axis);
      return;
    }
    if (state.pan) {
      state.vp.ox = state.pan.ox + (sx - state.pan.sx);
      state.vp.oy = state.pan.oy + (sy - state.pan.sy);
      render();
      return;
    }
    const h = pickHandle(scene, sx, sy);
    const next = h ? h.id : null;
    if (next !== state.hover) { state.hover = next; render(); }
    canvas.style.cursor = h ? (h.cursor || 'grab') : 'default';
  };
  const endPointer = (e) => {
    if (state.drag) { state.hooks.onDragEnd?.(state.drag.id); state.drag = null; }
    state.pan = null;
    try { canvas.releasePointerCapture?.(e.pointerId); } catch {}
    state.captured = null;
  };
  canvas.onpointerup = endPointer;
  canvas.onpointercancel = endPointer;
  // Safety net: a pointerup ANYWHERE ends an in-progress drag/pan and releases capture, so a
  // capture that somehow outlives the canvas can never swallow later clicks (e.g. wall tabs).
  const winEndPointer = (e) => { if (state.drag || state.pan || state.captured != null) endPointer(e); };
  if (typeof window !== 'undefined') window.addEventListener('pointerup', winEndPointer, true);
  canvas.onpointerleave = () => { if (!state.drag && !state.pan) { state.hover = null; } };
  canvas.onwheel = (e) => {
    if (!state.vp) return;
    e.preventDefault();
    const { sx, sy } = localXY(e);
    const factor = Math.exp(-e.deltaY * 0.0012);
    const wx = (sx - state.vp.ox) / state.vp.scale, wy = (state.vp.oy - sy) / state.vp.scale;
    state.vp.scale = Math.max(2, Math.min(state.vp.scale * factor, 4000));
    state.vp.ox = sx - wx * state.vp.scale;
    state.vp.oy = sy + wy * state.vp.scale;
    render();
  };

  // ----- rendering -----
  function hatchPattern(ctx, color, alpha) {
    const p = document.createElement('canvas'); p.width = 7; p.height = 7;
    const c = p.getContext('2d');
    c.globalAlpha = alpha != null ? alpha : 1;
    c.strokeStyle = color; c.lineWidth = 1;
    c.beginPath(); c.moveTo(0, 7); c.lineTo(7, 0); c.stroke();
    return ctx.createPattern(p, 'repeat');
  }

  function poly(ctx, pts, close) {
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    const a = screen(pts[0].x, pts[0].y); ctx.moveTo(a.x, a.y);
    for (let i = 1; i < pts.length; i++) { const s = screen(pts[i].x, pts[i].y); ctx.lineTo(s.x, s.y); }
    if (close) ctx.closePath();
  }

  function render() {
    const scene = state.hooks.getScene(); if (!scene) return;
    if (!state.vp) fit(scene);
    const P = palette(), S = P.S;
    const dpr = (window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(rect.width, 200), H = Math.max(rect.height, 200);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // soil layers (coloured bands across the whole section width) — fills from the --soil-* palette
    for (const L of (scene.soilLayers || [])) {
      const pts = [{ x: L.x0, y: L.topEl }, { x: L.x1, y: L.topEl }, { x: L.x1, y: L.botEl }, { x: L.x0, y: L.botEl }];
      poly(ctx, pts, true);
      ctx.fillStyle = ink(P, L.color, S.berm); ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = hatchPattern(ctx, S.hatch); ctx.fill();
      ctx.strokeStyle = S.soilLine; ctx.lineWidth = 0.75; ctx.stroke();
    }
    // layer labels at the left margin
    ctx.font = '10px JetBrains Mono, monospace'; ctx.textBaseline = 'middle';
    for (const L of (scene.soilLayers || [])) {
      if (!L.label) continue;
      const yMid = screen(L.x0, (L.topEl + L.botEl) / 2).y;
      const xL = screen(L.x0, 0).x;
      ctx.fillStyle = S.textMuted; ctx.textAlign = 'left';
      ctx.fillText(L.label, xL + 4, yMid);
    }

    // generic filled regions (front soil, passive wedge, etc.)
    for (const r of (scene.regions || [])) {
      poly(ctx, r.pts, true);
      if (r.fill) { ctx.fillStyle = ink(P, r.fill); ctx.fill(); }
      if (r.hatch) { ctx.fillStyle = hatchPattern(ctx, ink(P, r.hatch), r.hatchAlpha); ctx.fill(); }
      if (r.stroke) { ctx.strokeStyle = ink(P, r.stroke); ctx.lineWidth = r.width || 1; if (r.dash) ctx.setLineDash(r.dash); ctx.stroke(); ctx.setLineDash([]); }
    }

    // wall(s)
    for (const w of (scene.walls || [])) {
      poly(ctx, w.pts, true);
      ctx.fillStyle = ink(P, w.fill, S.concrete); ctx.fill();
      ctx.strokeStyle = ink(P, w.stroke, S.concreteStroke); ctx.lineWidth = w.width || 1.6; ctx.stroke();
    }

    // water lines
    for (const wl of (scene.water || [])) {
      poly(ctx, [{ x: wl.x0, y: wl.el }, { x: wl.x1, y: wl.el }], false);
      ctx.strokeStyle = S.water; ctx.lineWidth = 1.4; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
      // little triangle marker
      const s = screen(wl.x0 + (wl.x1 - wl.x0) * 0.12, wl.el);
      ctx.fillStyle = S.water;
      ctx.beginPath(); ctx.moveTo(s.x - 4, s.y - 1); ctx.lineTo(s.x + 4, s.y - 1); ctx.lineTo(s.x, s.y + 5); ctx.closePath(); ctx.fill();
    }

    // surcharge loads (downward arrows + label)
    for (const ld of (scene.loads || [])) {
      const y0 = ld.el;
      const n = Math.max(3, Math.round((ld.x1 - ld.x0) / 0.6));
      ctx.strokeStyle = S.load; ctx.fillStyle = S.load; ctx.lineWidth = 1.4;
      const top = screen(ld.x0, y0 + ld.h);
      const topR = screen(ld.x1, y0 + ld.h);
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(topR.x, topR.y); ctx.stroke();
      for (let i = 0; i <= n; i++) {
        const x = ld.x0 + (ld.x1 - ld.x0) * (i / n);
        const a = screen(x, y0 + ld.h), b = screen(x, y0);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - 3, b.y - 5); ctx.lineTo(b.x + 3, b.y - 5); ctx.closePath(); ctx.fill();
      }
      if (ld.label) {
        const c = screen((ld.x0 + ld.x1) / 2, y0 + ld.h);
        ctx.fillStyle = S.load; ctx.font = '11px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(ld.label, c.x, c.y - 3);
      }
    }

    // diagrams (pressure / BM / shear) — filled profile off a base line with labels+units
    for (const d of (scene.diagrams || [])) drawDiagram(ctx, P, d);

    // anchor
    if (scene.anchor) drawAnchor(ctx, P, scene.anchor);

    // dimensions
    ctx.lineWidth = 1; ctx.font = '10px JetBrains Mono, monospace';
    for (const dim of (scene.dims || [])) {
      const a = screen(dim.x1, dim.y1), b = screen(dim.x2, dim.y2);
      const col = ink(P, dim.color, S.dim);
      ctx.strokeStyle = col;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(dim.text).width;
      ctx.fillStyle = S.halo; ctx.fillRect(mx - tw / 2 - 2, my - 7, tw + 4, 13);
      ctx.fillStyle = col; ctx.fillText(dim.text, mx, my);
    }

    // CPT marker (vertical dashed line at the CPT handle's x)
    const cpt = (scene.handles || []).find((h) => h.id === 'cpt');
    if (cpt) {
      const b = scene.bounds;
      const top = screen(cpt.x, b.maxY), bot = screen(cpt.x, b.minY);
      ctx.strokeStyle = S.axis; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = S.textMuted; ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('CPT', top.x, top.y + 2);
    }

    // expose handle world→screen mapping for E2E tests (harmless; read-only)
    canvas.__rwTest = { handles: scene.handles || [], screen: (x, y) => screen(x, y) };

    // handles
    for (const h of (scene.handles || [])) {
      const s = screen(h.x, h.y);
      const active = state.hover === h.id || state.drag?.id === h.id;
      ctx.beginPath(); ctx.arc(s.x, s.y, active ? 6.5 : 5, 0, Math.PI * 2);
      ctx.fillStyle = active ? S.handle : S.paper;
      ctx.strokeStyle = S.handle; ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
      if (active && h.label) {
        ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        const tw = ctx.measureText(h.label).width;
        ctx.fillStyle = S.halo; ctx.fillRect(s.x + 8, s.y - 18, tw + 6, 14);
        ctx.fillStyle = S.text; ctx.fillText(h.label, s.x + 11, s.y - 6);
      }
    }
  }

  function drawDiagram(ctx, P, d) {
    if (!d.points || d.points.length < 2) return;
    const baseX = d.baseX, dir = d.dir || 1, sc = d.scale || 1;
    const pts = d.points.map((p) => ({ x: baseX + dir * p.val * sc, y: d.topEl - p.depth }));
    const fillPts = [{ x: baseX, y: pts[0].y }, ...pts, { x: baseX, y: pts[pts.length - 1].y }];
    const col = ink(P, d.color, P.S.moment);
    poly(ctx, fillPts, true);
    if (d.fill) { ctx.fillStyle = ink(P, d.fill); ctx.fill(); }
    poly(ctx, pts, false);
    ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.stroke();
    // extremum label with units
    if (d.peakLabel) {
      let pk = 0, pj = 0;
      d.points.forEach((p, j) => { if (Math.abs(p.val) > Math.abs(pk)) { pk = p.val; pj = j; } });
      const s = screen(pts[pj].x, pts[pj].y);
      ctx.fillStyle = col; ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = dir > 0 ? 'left' : 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(d.peakText || `${d.peakLabel} ${pk.toFixed(d.digits ?? 1)} ${d.unit || ''}`, s.x + dir * 5, s.y);
    }
  }

  function drawAnchor(ctx, P, a) {
    // a: { head:{x,y}, angleRad, freeLen, fixedLen, dia }
    const S = P.S;
    const dx = Math.cos(a.angleRad), dy = -Math.sin(a.angleRad);  // into the retained soil (down-back)
    const p0 = a.head;
    const p1 = { x: p0.x + dx * a.freeLen, y: p0.y + dy * a.freeLen };
    const p2 = { x: p1.x + dx * a.fixedLen, y: p1.y + dy * a.fixedLen };
    // free length (line)
    poly(ctx, [p0, p1], false);
    ctx.strokeStyle = S.anchor; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    // grout body (thick)
    poly(ctx, [p1, p2], false);
    ctx.strokeStyle = S.anchorGrout; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
    // anchor head plate
    const s = screen(p0.x, p0.y);
    ctx.fillStyle = S.anchor; ctx.fillRect(s.x - 3, s.y - 7, 6, 14);
    ctx.fillStyle = S.anchorGrout; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const sm = screen((p1.x + p2.x) / 2, (p1.y + p2.y) / 2);
    ctx.fillText('grout body', sm.x + 6, sm.y);
  }

  return {
    render,
    refit() { const scene = state.hooks.getScene(); if (scene) { fit(scene); render(); } },
    destroy() {
      // Release any orphaned pointer capture BEFORE the element is detached on re-render —
      // otherwise the captured pointer can keep routing events to the dead canvas and clicks
      // elsewhere (e.g. the wall-type tabs) stop registering.
      try { if (state.captured != null) canvas.releasePointerCapture?.(state.captured); } catch {}
      if (typeof window !== 'undefined') window.removeEventListener('pointerup', winEndPointer, true);
      state.captured = null; state.drag = null; state.pan = null;
      canvas.onpointerdown = canvas.onpointermove = canvas.onpointerup = null;
      canvas.onpointercancel = canvas.onpointerleave = canvas.onwheel = null;
    }
  };
}
