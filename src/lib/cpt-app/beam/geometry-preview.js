// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// beam/geometry-preview.js — the view-only 2D-canvas geometry preview of the beam / slab app: the
// x-z model view (soil bed, springs, strip, load pattern, dimensions) and the y-z section inset
// (01-monolith-map.md §2.9 "Charts / canvas", §4.3 canvas pattern, §6.1 row `beam/`, refactor step 7 / PR 12c).
//
// Moved verbatim out of legacy-controller.js (integration-r @ 07f0645 line numbers), renamed to drop the prefix:
//   stage6BeamCanvasText           12559-12569 → canvasText
//   stage6BeamRoundedRect          12571-12584 → roundedRect
//   stage6BeamDrawDimension        12586-12614 → drawDimension
//   stage6BeamDrawLoadArrow        12616-12632 → drawLoadArrow
//   drawStage6BeamGeometryPreview  12634-12813 → drawBeamGeometryPreview(analysis, cfg)
//     the one controller-state read `S.stage6?.beam || {}` → the cfg parameter (`cfg || {}`); the canvas id
//     → BEAM_GEOMETRY_CANVAS_ID; the axis copy → options.js beamAxisCopy
// The four primitives take the 2D context explicitly and are exported for the verifier / a future canvas
// module. Draws nothing when the canvas is missing, not a real <canvas>, has no layout box or no context —
// as before. Sizes the backing store to devicePixelRatio and paints at CSS pixels (§4.3).
import { beamAxisCopy } from './options.js';

/** Canvas id of panel.js beamBodyHtml ("Geometry preview (view only)"). */
export const BEAM_GEOMETRY_CANVAS_ID = 'stage6BeamGeometryCanvas';

export function canvasText(ctx, text, x, y, opts = {}){
  const size = opts.size || 11;
  const weight = opts.weight || 500;
  ctx.save();
  ctx.font = `${weight} ${size}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = opts.color || '#344054';
  ctx.textAlign = opts.align || 'left';
  ctx.textBaseline = opts.baseline || 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

export function roundedRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export function drawDimension(ctx, x1, y1, x2, y2, label, vertical = false){
  ctx.save();
  ctx.strokeStyle = '#667085';
  ctx.fillStyle = '#667085';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const tick = 4;
  if(vertical){
    ctx.beginPath();
    ctx.moveTo(x1 - tick, y1);
    ctx.lineTo(x1 + tick, y1);
    ctx.moveTo(x2 - tick, y2);
    ctx.lineTo(x2 + tick, y2);
    ctx.stroke();
    canvasText(ctx, label, x1 + 8, (y1 + y2) / 2, {size:10, color:'#475467'});
  }else{
    ctx.beginPath();
    ctx.moveTo(x1, y1 - tick);
    ctx.lineTo(x1, y1 + tick);
    ctx.moveTo(x2, y2 - tick);
    ctx.lineTo(x2, y2 + tick);
    ctx.stroke();
    canvasText(ctx, label, (x1 + x2) / 2, y1 - 9, {size:10, color:'#475467', align:'center'});
  }
  ctx.restore();
}

export function drawLoadArrow(ctx, x, yTop, yBot, color){
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, yTop);
  ctx.lineTo(x, yBot);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, yBot);
  ctx.lineTo(x - 4, yBot - 7);
  ctx.lineTo(x + 4, yBot - 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function drawBeamGeometryPreview(analysis, cfg){
  const canvas = document.getElementById(BEAM_GEOMETRY_CANVAS_ID);
  if(!(canvas instanceof HTMLCanvasElement) || !analysis) return;
  const rect = canvas.getBoundingClientRect();
  if(!(rect.width > 0 && rect.height > 0)) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if(canvas.width !== w || canvas.height !== h){
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if(!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(0, 0, W, H);

  cfg = cfg || {};
  const ks = analysis.ksInfo || {};
  const mode = cfg.modelMode || 'slab_strip';
  const axisCopy = beamAxisCopy(mode);
  const L = Math.max(+cfg.L || +ks.L || 6, 0.5);
  const b = Math.max(+cfg.b || +ks.b || 1, 0.1);
  const B = Math.max(+cfg.B || +ks.B || b, 0.1);
  const depth = Math.max(+cfg.h || +ks.h || 0.3, 0.05);
  const Df = Math.max(+cfg.Df || 0, 0);
  const pattern = cfg.loadPattern || 'uniform_full';
  const margin = 18;
  const mainX = margin;
  const mainY = 24;
  const mainW = Math.max(160, W - 210);
  const mainH = H - 42;
  const insetX = mainX + mainW + 18;
  const insetW = Math.max(150, W - insetX - margin);
  const soilY = mainY + Math.min(mainH * 0.58, mainH - 58);
  const zScale = Math.min(54, Math.max(10, (soilY - mainY - 12) / Math.max(Df, depth, 0.1)));
  const groundY = Math.max(mainY + 10, soilY - Df * zScale);
  const beamPixH = Math.max(10, Math.min(64, depth * zScale));
  const beamY = soilY - beamPixH;
  const scaleX = mainW / L;

  // Soil bed and founding depth context.
  ctx.fillStyle = '#EEF4EC';
  ctx.fillRect(mainX, groundY, mainW, mainH - (groundY - mainY));
  ctx.strokeStyle = '#6F8F64';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(mainX, groundY);
  ctx.lineTo(mainX + mainW, groundY);
  ctx.stroke();
  ctx.setLineDash([]);
  canvasText(ctx, 'soil surface', mainX + 6, groundY - 8, {size:10, color:'#667085'});
  ctx.strokeStyle = '#8AA57F';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(mainX, soilY);
  ctx.lineTo(mainX + mainW, soilY);
  ctx.stroke();
  for(let x = mainX; x < mainX + mainW; x += 14){
    ctx.strokeStyle = 'rgba(138,165,127,0.32)';
    ctx.beginPath();
    ctx.moveTo(x, soilY + 8);
    ctx.lineTo(x + 10, soilY);
    ctx.stroke();
  }

  // Springs.
  const springCount = Math.max(8, Math.min(22, Math.round(mainW / 28)));
  ctx.strokeStyle = '#9AA6B2';
  ctx.lineWidth = 1;
  for(let i = 0; i <= springCount; i += 1){
    const x = mainX + (mainW * i) / springCount;
    const y0 = soilY + 3;
    const amp = 4;
    const step = 4;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    for(let j = 1; j <= 6; j += 1){
      ctx.lineTo(x + (j % 2 ? amp : -amp), y0 + j * step);
    }
    ctx.lineTo(x, y0 + 7 * step);
    ctx.stroke();
  }

  // Beam/slab rectangle in x-z view.
  roundedRect(ctx, mainX, beamY, mainW, beamPixH, 2);
  ctx.fillStyle = '#D9E7F5';
  ctx.fill();
  ctx.strokeStyle = '#3C6F97';
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.fillStyle = 'rgba(60,111,151,0.12)';
  ctx.fillRect(mainX, beamY + beamPixH - 5, mainW, 5);

  // Load rendering.
  const loadColor = '#C2410C';
  if(pattern === 'uniform_full' || pattern === 'uniform_patch'){
    const xStart = pattern === 'uniform_patch' ? Math.max(0, Math.min(L, +cfg.xStart || 0)) : 0;
    const xEndRaw = pattern === 'uniform_patch' ? (+cfg.xEnd || L) : L;
    const xEnd = Math.max(xStart, Math.min(L, xEndRaw));
    const px1 = mainX + xStart * scaleX;
    const px2 = mainX + xEnd * scaleX;
    ctx.fillStyle = 'rgba(194,65,12,0.10)';
    ctx.fillRect(px1, beamY - 30, Math.max(2, px2 - px1), 24);
    const arrows = Math.max(2, Math.min(10, Math.round((px2 - px1) / 28)));
    for(let i = 0; i < arrows; i += 1){
      const x = px1 + ((px2 - px1) * (i + 0.5)) / arrows;
      drawLoadArrow(ctx, x, beamY - 28, beamY - 6, loadColor);
    }
    canvasText(ctx, pattern === 'uniform_patch' ? 'patch q(x)' : 'full-length q(x)', (px1 + px2) / 2, beamY - 36, {size:10, color:loadColor, align:'center'});
  }else{
    const pointX = pattern === 'point_at_x' ? (+cfg.xLoad || L / 2) : L / 2;
    const px = mainX + Math.max(0, Math.min(L, pointX)) * scaleX;
    drawLoadArrow(ctx, px, beamY - 40, beamY - 5, loadColor);
    canvasText(ctx, 'P', px + 7, beamY - 34, {size:10, color:loadColor});
  }

  drawDimension(ctx, mainX, beamY + beamPixH + 42, mainX + mainW, beamY + beamPixH + 42, `L = ${L.toFixed(2)} m`);
  drawDimension(ctx, mainX + mainW + 8, beamY, mainX + mainW + 8, beamY + beamPixH, `h = ${depth.toFixed(2)} m`, true);
  drawDimension(ctx, mainX + 10, groundY, mainX + 10, soilY, `Df = ${Df.toFixed(2)} m`, true);
  canvasText(ctx, 'soil bed / elastic support', mainX + mainW - 6, soilY + 44, {size:10, color:'#667085', align:'right'});
  canvasText(ctx, `x-z view - ${axisCopy.summary}`, mainX, 13, {size:11, weight:700, color:'#344054'});

  // Cross-section inset y-z.
  const insetY = mainY + 8;
  const insetH = mainH - 12;
  ctx.strokeStyle = '#D0D5DD';
  ctx.beginPath();
  ctx.moveTo(insetX - 10, mainY);
  ctx.lineTo(insetX - 10, mainY + mainH);
  ctx.stroke();
  canvasText(ctx, 'y-z section', insetX, 13, {size:11, weight:700, color:'#344054'});
  const secBaseY = insetY + Math.min(insetH * 0.58, insetH - 56);
  const maxSecW = insetW - 36;
  const widthScale = maxSecW / Math.max(b, B);
  const bW = Math.max(16, b * widthScale);
  const BW = Math.max(16, B * widthScale);
  const secZScale = Math.min(58, Math.max(14, (secBaseY - insetY - 12) / Math.max(Df, depth, 0.1)));
  const secGroundY = Math.max(insetY + 8, secBaseY - Df * secZScale);
  const secH = Math.max(20, Math.min(76, depth * secZScale));
  const secCX = insetX + insetW / 2;
  const secX = secCX - bW / 2;
  const secY = secBaseY - secH;
  ctx.fillStyle = '#EEF4EC';
  ctx.fillRect(insetX, secGroundY, insetW - 4, insetH - (secGroundY - insetY));
  ctx.strokeStyle = '#6F8F64';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(insetX, secGroundY);
  ctx.lineTo(insetX + insetW - 4, secGroundY);
  ctx.stroke();
  ctx.setLineDash([]);
  canvasText(ctx, 'surface', insetX + 3, secGroundY - 8, {size:9, color:'#667085'});
  ctx.strokeStyle = '#8AA57F';
  ctx.beginPath();
  ctx.moveTo(insetX, secBaseY);
  ctx.lineTo(insetX + insetW - 4, secBaseY);
  ctx.stroke();
  const bx = secCX - BW / 2;
  ctx.fillStyle = 'rgba(138,165,127,0.20)';
  ctx.fillRect(bx, secBaseY + 2, BW, 12);
  ctx.strokeStyle = '#8AA57F';
  ctx.strokeRect(bx, secBaseY + 2, BW, 12);
  roundedRect(ctx, secX, secY, bW, secH, 2);
  ctx.fillStyle = '#D9E7F5';
  ctx.fill();
  ctx.strokeStyle = '#3C6F97';
  ctx.stroke();
  drawDimension(ctx, secX, secY - 10, secX + bW, secY - 10, `b = ${b.toFixed(2)} m`);
  drawDimension(ctx, secX + bW + 8, secY, secX + bW + 8, secY + secH, `h = ${depth.toFixed(2)} m`, true);
  drawDimension(ctx, bx, secBaseY + 30, bx + BW, secBaseY + 30, `B = ${B.toFixed(2)} m`);
  canvasText(ctx, axisCopy.canvasMode, insetX, H - 15, {size:10, color:'#475467'});
  ctx.restore();
}
