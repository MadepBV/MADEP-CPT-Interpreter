// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/walls.js — layer 8: every retaining wall, and in the deformation workspace
// its solved response — the deflected axis, the M / V / N overlay diagram with its station dots and
// its two extremum callouts. From stage6BishopDrawCanvas 6852-7043 (drawWallResponse) and
// 7203-7213 (integration-r 3b84193). The overlay catalogue and the colour helpers are reached
// through `vm.env` (map §2.11 "Result HTML / labels", step 9f).
import { compactNumber as stage6CompactNumber } from '../../../core/format.js';
import { wallResultIsStale } from '../../../deformation/wall-result-staleness.js';
import { drawWall } from './primitives.js';

/** Every wall axis; the selected one heavier and in the selection colour. */
export function drawWalls(ctx, vm, theme){
  const bishop = vm.bishop;
  (bishop.walls || []).forEach((wall)=>drawWall(ctx, vm, theme, wall, wall.id === bishop.selectedWallId ? {stroke:theme.wallSelected, width:5} : {}));
}

/** One wall's solved response. */
export function drawWallResponse(ctx, vm, theme, wallResult){
  const { bishop, env, width, height } = vm;
  const stations = wallResult?.stations || [];
  if(stations.length < 2) return;
  const displacementScale = Math.max(Number(bishop.deformation?.options?.displacementScale) || 1, 0.05);
  const passiveSign = wallResult.passiveSign < 0 ? -1 : 1;
  const deformed = stations.map((station)=>vm.toScreen({
    x:(Number(station.x) || 0) + displacementScale * (Number(station.ux) || 0),
    y:(Number(station.y) || 0) + displacementScale * (Number(station.uy) || 0)
  }));
  const base = stations.map((station)=>vm.toScreen({
    x:Number(station.x) || 0,
    y:Number(station.y) || 0
  }));
  const overlayQuantity = env.wallOverlayQuantity();
  const overlayData = env.wallNodeValuesForOverlay(wallResult, overlayQuantity);
  const overlayMaxAbs = Math.max(...(overlayData?.nodeValues || []).map((value)=>Math.abs(Number(value) || 0)), 0);
  ctx.save();
  ctx.strokeStyle = theme.wallDeflection;
  ctx.lineWidth = 2.2;
  ctx.setLineDash([]);
  ctx.beginPath();
  deformed.forEach((pt, index)=>{
    if(index === 0) ctx.moveTo(pt.x, pt.y);
    else ctx.lineTo(pt.x, pt.y);
  });
  ctx.stroke();
  if(overlayMaxAbs > 0){
    if(bishop.deformation?.display?.showWallMomentOverlay !== true){
      ctx.restore();
      return;
    }
    ctx.strokeStyle = overlayData?.meta?.color || theme.wallOverlayFallback;
    ctx.fillStyle = env.cssColorWithAlpha(overlayData?.meta?.color || theme.wallOverlayFallbackHex, 0.12);
    ctx.lineWidth = 1.4;
    const diagram = stations.map((station, index)=>{
      const value = Number(overlayData.nodeValues[index]) || 0;
      const prev = stations[Math.max(index - 1, 0)] || station;
      const next = stations[Math.min(index + 1, stations.length - 1)] || station;
      const dx = (Number(next.x) || 0) - (Number(prev.x) || 0);
      const dy = (Number(next.y) || 0) - (Number(prev.y) || 0);
      const len = Math.max(Math.hypot(dx, dy), 1e-9);
      const normal = {x:-(dy / len) * passiveSign, y:(dx / len) * passiveSign};
      return {
        x:base[index].x + normal.x * 32 * (value / overlayMaxAbs),
        y:base[index].y - normal.y * 32 * (value / overlayMaxAbs)
      };
    });
    ctx.beginPath();
    base.forEach((pt, index)=>{
      if(index === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    for(let i=diagram.length - 1; i >= 0; i -= 1) ctx.lineTo(diagram[i].x, diagram[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    diagram.forEach((pt, index)=>{
      if(index === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    ctx.stroke();
    // Per-station tick marks: the diagram amplitude is normalized to 32 px at
    // |max|, so a smoothly growing quantity (e.g. the ~cubic moment build-up
    // over the retained height) can hug the wall line within the wall-stroke
    // width and read as "no data". Small dots keep every station visibly
    // present without changing the normalization. (Verified twice: the
    // "missing" upper-band data was correct and statics-consistent.)
    ctx.save();
    ctx.fillStyle = overlayData?.meta?.color || theme.wallOverlayFallback;
    diagram.forEach((pt)=>{
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
    const extrema = overlayData.nodeValues.map((value, index)=>({
      value:Number(value) || 0,
      index,
      point:diagram[index]
    })).filter((item)=>item.point);
    if(extrema.length){
      let minItem = extrema[0];
      let maxItem = extrema[0];
      extrema.forEach((item)=>{
        if(item.value < minItem.value) minItem = item;
        if(item.value > maxItem.value) maxItem = item;
      });
      const drawOverlayExtremum = (item, label, offsetSign)=>{
        const point = item?.point;
        if(!point) return;
        const meta = overlayData?.meta || {};
        const labelText = `${label} ${env.wallQuantityFormat(item.value, meta)}`;
        const station = stations[item.index];
        const stationText = `s=${stage6CompactNumber(Number(station?.s) || 0, 3)} m`;
        ctx.save();
        ctx.font = '10px system-ui, sans-serif';
        const labelW = Math.max(ctx.measureText(labelText).width, ctx.measureText(stationText).width) + 12;
        const labelH = 26;
        let lx = point.x + 10;
        let ly = point.y + offsetSign * 18 - labelH / 2;
        lx = Math.max(6, Math.min(width - labelW - 6, lx));
        ly = Math.max(6, Math.min(height - labelH - 6, ly));
        ctx.fillStyle = theme.wallOverlayLabelBg;
        ctx.strokeStyle = meta.color || theme.wallOverlayFallbackHex;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 3.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = env.cssColorWithAlpha(meta.color || theme.wallOverlayFallbackHex, 0.88);
        ctx.strokeStyle = env.cssColorWithAlpha(meta.color || theme.wallOverlayFallbackHex, 0.96);
        ctx.lineWidth = 1;
        if(typeof ctx.roundRect === 'function'){
          ctx.beginPath();
          ctx.roundRect(lx, ly, labelW, labelH, 5);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(lx, ly, labelW, labelH);
          ctx.strokeRect(lx, ly, labelW, labelH);
        }
        ctx.fillStyle = env.contrastingTextColor(meta.color || theme.wallOverlayFallbackHex);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(labelText, lx + 6, ly + 4);
        ctx.fillText(stationText, lx + 6, ly + 15);
        ctx.restore();
      };
      drawOverlayExtremum(minItem, 'min', -1);
      const sameExtremum = minItem.index === maxItem.index ||
        (Math.abs(minItem.value - maxItem.value) < 1e-12 && Math.abs(minItem.index - maxItem.index) === 0);
      if(!sameExtremum) drawOverlayExtremum(maxItem, 'max', 1);
    }
  }
  ctx.restore();
}

/**
 * Every non-stale wall response of the current deformation result.
 *
 * Defense-in-depth: skip any wall overlay whose run-time geometry no longer matches the current
 * wall, so a stale result can never silently masquerade (a diagram drawn at old coordinates) even
 * if a future edit path forgets to invalidate the deformation result.
 */
export function drawWallResponses(ctx, vm, theme){
  const bishop = vm.bishop;
  if(vm.workspace !== 'deformation') return;
  (bishop.deformation?.result?.wallResults || bishop.deformation?.result?.retainingWallResults || [])
    .filter((wallResult)=>!wallResultIsStale(wallResult, bishop))
    .forEach((wallResult)=>drawWallResponse(ctx, vm, theme, wallResult));
}
