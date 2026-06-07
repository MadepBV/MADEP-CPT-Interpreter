// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Interactive section canvas for the retaining-wall app, mirroring the Seep/Slope
// (bishop) interaction model: an affine viewport {scale, ox, oy} with pan (drag
// empty space), wheel zoom, fit-to-content, and draggable handles. The UI module
// supplies a "scene" (soil layers, wall polygons, water, loads, pressure/BM diagrams,
// anchor, handles) and drag callbacks; this module renders it and dispatches drags
// with world coordinates + the handle id (geometry inversion lives in the UI module).

const HANDLE_HIT = 11; // px

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
    const dpr = (window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(rect.width, 200), H = Math.max(rect.height, 200);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // soil layers (coloured bands across the whole section width)
    for (const L of (scene.soilLayers || [])) {
      const pts = [{ x: L.x0, y: L.topEl }, { x: L.x1, y: L.topEl }, { x: L.x1, y: L.botEl }, { x: L.x0, y: L.botEl }];
      poly(ctx, pts, true);
      ctx.fillStyle = L.color || '#d8c9a8'; ctx.globalAlpha = 0.55; ctx.fill(); ctx.globalAlpha = 1;
      ctx.fillStyle = hatchPattern(ctx, 'rgba(60,50,30,0.25)'); ctx.fill();
      ctx.strokeStyle = 'rgba(24,24,26,0.18)'; ctx.lineWidth = 0.75; ctx.stroke();
    }
    // layer labels at the left margin
    ctx.font = '10px JetBrains Mono, monospace'; ctx.textBaseline = 'middle';
    for (const L of (scene.soilLayers || [])) {
      if (!L.label) continue;
      const yMid = screen(L.x0, (L.topEl + L.botEl) / 2).y;
      const xL = screen(L.x0, 0).x;
      ctx.fillStyle = 'rgba(24,24,26,0.65)'; ctx.textAlign = 'left';
      ctx.fillText(L.label, xL + 4, yMid);
    }

    // generic filled regions (front soil, passive wedge, etc.)
    for (const r of (scene.regions || [])) {
      poly(ctx, r.pts, true);
      if (r.fill) { ctx.fillStyle = r.fill; ctx.fill(); }
      if (r.hatch) { ctx.fillStyle = hatchPattern(ctx, r.hatch, r.hatchAlpha); ctx.fill(); }
      if (r.stroke) { ctx.strokeStyle = r.stroke; ctx.lineWidth = r.width || 1; if (r.dash) ctx.setLineDash(r.dash); ctx.stroke(); ctx.setLineDash([]); }
    }

    // wall(s)
    for (const w of (scene.walls || [])) {
      poly(ctx, w.pts, true);
      ctx.fillStyle = w.fill || '#cfcabe'; ctx.fill();
      ctx.strokeStyle = w.stroke || '#6d6962'; ctx.lineWidth = w.width || 1.6; ctx.stroke();
    }

    // water lines
    for (const wl of (scene.water || [])) {
      poly(ctx, [{ x: wl.x0, y: wl.el }, { x: wl.x1, y: wl.el }], false);
      ctx.strokeStyle = '#3d6b6a'; ctx.lineWidth = 1.4; ctx.setLineDash([5, 3]); ctx.stroke(); ctx.setLineDash([]);
      // little triangle marker
      const s = screen(wl.x0 + (wl.x1 - wl.x0) * 0.12, wl.el);
      ctx.fillStyle = '#3d6b6a';
      ctx.beginPath(); ctx.moveTo(s.x - 4, s.y - 1); ctx.lineTo(s.x + 4, s.y - 1); ctx.lineTo(s.x, s.y + 5); ctx.closePath(); ctx.fill();
    }

    // surcharge loads (downward arrows + label)
    for (const ld of (scene.loads || [])) {
      const y0 = ld.el;
      const n = Math.max(3, Math.round((ld.x1 - ld.x0) / 0.6));
      ctx.strokeStyle = '#8a620d'; ctx.fillStyle = '#8a620d'; ctx.lineWidth = 1.4;
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
        ctx.fillStyle = '#8a620d'; ctx.font = '11px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText(ld.label, c.x, c.y - 3);
      }
    }

    // diagrams (pressure / BM / shear) — filled profile off a base line with labels+units
    for (const d of (scene.diagrams || [])) drawDiagram(ctx, d);

    // anchor
    if (scene.anchor) drawAnchor(ctx, scene.anchor);

    // dimensions
    ctx.lineWidth = 1; ctx.font = '10px JetBrains Mono, monospace';
    for (const dim of (scene.dims || [])) {
      const a = screen(dim.x1, dim.y1), b = screen(dim.x2, dim.y2);
      ctx.strokeStyle = dim.color || '#6d6962';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(dim.text).width;
      ctx.fillStyle = 'rgba(247,244,239,0.9)'; ctx.fillRect(mx - tw / 2 - 2, my - 7, tw + 4, 13);
      ctx.fillStyle = dim.color || '#6d6962'; ctx.fillText(dim.text, mx, my);
    }

    // CPT marker (vertical dashed line at the CPT handle's x)
    const cpt = (scene.handles || []).find((h) => h.id === 'cpt');
    if (cpt) {
      const b = scene.bounds;
      const top = screen(cpt.x, b.maxY), bot = screen(cpt.x, b.minY);
      ctx.strokeStyle = 'rgba(24,24,26,0.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(bot.x, bot.y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(24,24,26,0.7)'; ctx.font = '9px JetBrains Mono, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('CPT', top.x, top.y + 2);
    }

    // expose handle world→screen mapping for E2E tests (harmless; read-only)
    canvas.__rwTest = { handles: scene.handles || [], screen: (x, y) => screen(x, y) };

    // handles
    for (const h of (scene.handles || [])) {
      const s = screen(h.x, h.y);
      const active = state.hover === h.id || state.drag?.id === h.id;
      ctx.beginPath(); ctx.arc(s.x, s.y, active ? 6.5 : 5, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#3d6b6a' : '#fff';
      ctx.strokeStyle = '#3d6b6a'; ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
      if (active && h.label) {
        ctx.fillStyle = '#18181a'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        const tw = ctx.measureText(h.label).width;
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(s.x + 8, s.y - 18, tw + 6, 14);
        ctx.fillStyle = '#18181a'; ctx.fillText(h.label, s.x + 11, s.y - 6);
      }
    }
  }

  function drawDiagram(ctx, d) {
    if (!d.points || d.points.length < 2) return;
    const baseX = d.baseX, dir = d.dir || 1, sc = d.scale || 1;
    const pts = d.points.map((p) => ({ x: baseX + dir * p.val * sc, y: d.topEl - p.depth }));
    const fillPts = [{ x: baseX, y: pts[0].y }, ...pts, { x: baseX, y: pts[pts.length - 1].y }];
    poly(ctx, fillPts, true);
    if (d.fill) { ctx.fillStyle = d.fill; ctx.fill(); }
    poly(ctx, pts, false);
    ctx.strokeStyle = d.color || '#7e50a8'; ctx.lineWidth = 1.4; ctx.stroke();
    // extremum label with units
    if (d.peakLabel) {
      let pk = 0, pj = 0;
      d.points.forEach((p, j) => { if (Math.abs(p.val) > Math.abs(pk)) { pk = p.val; pj = j; } });
      const s = screen(pts[pj].x, pts[pj].y);
      ctx.fillStyle = d.color || '#7e50a8'; ctx.font = '10px JetBrains Mono, monospace';
      ctx.textAlign = dir > 0 ? 'left' : 'right'; ctx.textBaseline = 'middle';
      ctx.fillText(`${d.peakLabel} ${pk.toFixed(d.digits ?? 1)} ${d.unit || ''}`, s.x + dir * 5, s.y);
    }
  }

  function drawAnchor(ctx, a) {
    // a: { head:{x,y}, angleRad, freeLen, fixedLen, dia }
    const dx = Math.cos(a.angleRad), dy = -Math.sin(a.angleRad);  // into the retained soil (down-back)
    const p0 = a.head;
    const p1 = { x: p0.x + dx * a.freeLen, y: p0.y + dy * a.freeLen };
    const p2 = { x: p1.x + dx * a.fixedLen, y: p1.y + dy * a.fixedLen };
    // free length (line)
    poly(ctx, [p0, p1], false);
    ctx.strokeStyle = '#18181a'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
    // grout body (thick)
    poly(ctx, [p1, p2], false);
    ctx.strokeStyle = '#8a620d'; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.stroke(); ctx.lineCap = 'butt';
    // anchor head plate
    const s = screen(p0.x, p0.y);
    ctx.fillStyle = '#18181a'; ctx.fillRect(s.x - 3, s.y - 7, 6, 14);
    ctx.fillStyle = '#8a620d'; ctx.font = '10px JetBrains Mono, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
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
