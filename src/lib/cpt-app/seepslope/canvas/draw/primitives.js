// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/primitives.js — the drawing helpers `stage6BishopDrawCanvas` declared as
// closures inside itself and shared between its blocks (refactor step 9e, PLAN §2 row 18e).
// Each is verbatim, with the two closed-over values made parameters: the 2D context and the view
// model (whose `toScreen` is the monolith's `stage6BishopWorldToScreen`).
import { measurementLabelOffsetWorld } from '../viewport.js';
import { measurementLabel, measurementMetrics } from '../../geometry/measurement.js';
import { validZone } from '../../state/surface-loads.js';
import { terrainY as bishopTerrainY } from '../../../stage6-bishop.js';
import { wallAxis, wallNormalForSide } from '../../../wall-geometry.js';

/** A world polyline as one stroked path. */
export function drawPolyline(ctx, vm, points, stroke, widthPx, dash){
  if(!points?.length) return;
  ctx.save();
  ctx.beginPath();
  points.forEach((pt, index)=>{
    const s = vm.toScreen(pt);
    if(index === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.strokeStyle = stroke;
  ctx.lineWidth = widthPx;
  ctx.setLineDash(dash || []);
  ctx.stroke();
  ctx.restore();
}

/** Direction arrows spaced along a world polyline (flow lines). */
export function drawPolylineArrows(ctx, vm, points, stroke, spacingPx = 74, arrowPx = 7){
  if(!points?.length || points.length < 2) return;
  const screenPts = points.map((point)=>vm.toScreen(point));
  let carry = spacingPx * 0.5;
  for(let i=0;i<screenPts.length-1;i+=1){
    const a = screenPts[i];
    const b = screenPts[i+1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if(!(len > 1e-6)) continue;
    let offset = carry;
    while(offset < len){
      const t = offset / len;
      const x = a.x + dx * t;
      const y = a.y + dy * t;
      const angle = Math.atan2(dy, dx);
      ctx.save();
      ctx.strokeStyle = stroke;
      ctx.fillStyle = stroke;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x - 0.6 * arrowPx * Math.cos(angle), y - 0.6 * arrowPx * Math.sin(angle));
      ctx.lineTo(x + 0.6 * arrowPx * Math.cos(angle), y + 0.6 * arrowPx * Math.sin(angle));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 0.6 * arrowPx * Math.cos(angle), y + 0.6 * arrowPx * Math.sin(angle));
      ctx.lineTo(x + 0.05 * arrowPx * Math.cos(angle) - 0.6 * arrowPx * Math.cos(angle - Math.PI / 6), y + 0.05 * arrowPx * Math.sin(angle) - 0.6 * arrowPx * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x + 0.05 * arrowPx * Math.cos(angle) - 0.6 * arrowPx * Math.cos(angle + Math.PI / 6), y + 0.05 * arrowPx * Math.sin(angle) - 0.6 * arrowPx * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      offset += spacingPx;
    }
    carry = offset - len;
  }
}

/** One slip circle, sampled as 100 chords between its entry and exit point. */
export function drawCircleArc(ctx, vm, circle, stroke, widthPx, dash){
  const pts = [];
  const n = 100;
  const branch = circle?.branch === 'upper' ? 'upper' : 'lower';
  for(let i=0;i<=n;i+=1){
    const x = circle.entryPoint.x + ((circle.exitPoint.x - circle.entryPoint.x) * i) / n;
    const rem = Math.max(circle.radius*circle.radius - (x-circle.center.x)*(x-circle.center.x), 0);
    const root = Math.sqrt(rem);
    pts.push({x, y:branch === 'upper' ? circle.center.y + root : circle.center.y - root});
  }
  drawPolyline(ctx, vm, pts, stroke, widthPx, dash);
}

/** A wall axis plus the little arrow that marks its passive side. */
export function drawWall(ctx, vm, theme, wall, options = {}){
  const axis = wallAxis(wall);
  if(!axis) return;
  const top = vm.toScreen(axis.head);
  const tip = vm.toScreen(axis.tip);
  const mid = vm.toScreen({
    x:0.5 * (axis.head.x + axis.tip.x),
    y:0.5 * (axis.head.y + axis.tip.y)
  });
  const passiveNormal = wallNormalForSide(axis, wall.passiveSide);
  const screenNormal = passiveNormal
    ? {x:passiveNormal.x, y:-passiveNormal.y}
    : {x:wall.passiveSide === 'left' ? -1 : 1, y:0};
  ctx.save();
  ctx.strokeStyle = options.stroke || theme.wall;
  ctx.lineWidth = options.width || 4;
  ctx.setLineDash(options.dash || []);
  ctx.beginPath();
  ctx.moveTo(top.x, top.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = options.stroke || theme.wall;
  ctx.beginPath();
  const arrowTip = {x:mid.x + screenNormal.x * 12, y:mid.y + screenNormal.y * 12};
  const arrowBase = {x:mid.x + screenNormal.x * 3, y:mid.y + screenNormal.y * 3};
  const tangentScreen = {x:tip.x - top.x, y:tip.y - top.y};
  const tangentLen = Math.max(Math.hypot(tangentScreen.x, tangentScreen.y), 1);
  const tx = tangentScreen.x / tangentLen;
  const ty = tangentScreen.y / tangentLen;
  ctx.moveTo(arrowTip.x, arrowTip.y);
  ctx.lineTo(arrowBase.x + tx * 5, arrowBase.y + ty * 5);
  ctx.lineTo(arrowBase.x - tx * 5, arrowBase.y - ty * 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The `q = … kPa` caption of a surface load and its down-arrows. */
export function drawLoadZoneMarkers(ctx, vm, theme, zone, q, color, options = {}){
  const bishop = vm.bishop;
  if(!validZone(zone) || bishop.terrain.length < 2) return;
  const terrain = {vertices:bishop.terrain};
  const midX = 0.5 * (zone.xStart + zone.xEnd);
  const midY = bishopTerrainY(terrain, midX);
  const mid = vm.toScreen({x:midX, y:midY});
  ctx.save();
  ctx.fillStyle = color;
  ctx.globalAlpha = options.active === false ? 0.62 : 1;
  ctx.font = `${options.active === false ? 'italic ' : ''}12px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  const label = options.label ? `${options.label}: ` : '';
  const text = options.active === false
    ? `${label}inactive`
    : `${options.selected ? 'Selected · ' : ''}${label}q=${q.toFixed(1)} kPa`;
  if(options.selected){
    const metrics = ctx.measureText(text);
    const padX = 7;
    const badgeX = mid.x - metrics.width / 2 - padX;
    const badgeY = mid.y - 28;
    const badgeW = metrics.width + 2 * padX;
    const badgeH = 18;
    ctx.save();
    ctx.fillStyle = theme.loadBadgeBg;
    ctx.strokeStyle = theme.loadBadgeBorder;
    ctx.lineWidth = 1;
    if(typeof ctx.roundRect === 'function'){
      ctx.beginPath();
      ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
      ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
    }
    ctx.restore();
  }
  ctx.fillText(text, mid.x, mid.y - 12);
  ctx.restore();
  if(!(q > 0) || options.active === false) return;
  const span = Math.abs(zone.xEnd - zone.xStart);
  const arrowCount = Math.max(2, Math.min(5, Math.round(span / 2) + 1));
  Array.from({length:arrowCount}, (_, index)=>(
    zone.xStart + ((zone.xEnd - zone.xStart) * index) / Math.max(arrowCount - 1, 1)
  )).forEach((x)=>{
    const y = bishopTerrainY(terrain, x);
    const top = vm.toScreen({x, y:y + 0.8});
    const tip = vm.toScreen({x, y:y + 0.08});
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.globalAlpha = options.active === false ? 0.35 : 1;
    ctx.lineWidth = options.selected ? 2 : 1.5;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - 4, tip.y - 6);
    ctx.lineTo(tip.x + 4, tip.y - 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  });
}

/** The Measure tool's line, its two end dots and its distance / slope label. */
export function drawMeasurementOverlay(ctx, vm, theme, points, options = {}){
  const metrics = measurementMetrics(points);
  if(!metrics) return;
  const a = vm.toScreen(metrics.a);
  const b = vm.toScreen(metrics.b);
  const label = measurementLabel(metrics);
  ctx.save();
  ctx.strokeStyle = options.preview ? theme.measurePreview : theme.measure;
  ctx.fillStyle = options.preview ? theme.measurePreviewFill : theme.measure;
  ctx.lineWidth = options.preview ? 2 : 2.2;
  ctx.setLineDash(options.preview ? [7, 5] : []);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.setLineDash([]);
  [a, b].forEach((pt)=>{
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = theme.measureDotStroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.strokeStyle = options.preview ? theme.measurePreview : theme.measure;
    ctx.lineWidth = options.preview ? 2 : 2.2;
  });
  const labelPos = vm.toScreen({
    x:metrics.mid.x,
    y:metrics.mid.y + measurementLabelOffsetWorld(vm.viewport)
  });
  ctx.font = '600 11px system-ui, sans-serif';
  const paddingX = 8;
  const paddingY = 5;
  const textWidth = ctx.measureText(label).width;
  const boxWidth = textWidth + paddingX * 2;
  const boxHeight = 24;
  const boxX = labelPos.x - boxWidth / 2;
  const boxY = labelPos.y - boxHeight / 2;
  ctx.fillStyle = options.preview ? theme.measureBoxBgPreview : theme.measureBoxBg;
  ctx.strokeStyle = options.preview ? theme.measureBoxBorderPreview : theme.measureBoxBorder;
  ctx.lineWidth = 1;
  if(typeof ctx.roundRect === 'function'){
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 6);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
    ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);
  }
  ctx.fillStyle = theme.measureText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, labelPos.x, labelPos.y);
  ctx.restore();
}
