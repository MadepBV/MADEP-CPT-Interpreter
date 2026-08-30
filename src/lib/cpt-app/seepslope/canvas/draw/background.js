// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/background.js — layer 1: the paper and the snap grid.
// From stage6BishopDrawCanvas 6267-6271 and stage6BishopDrawGrid 6221-6251 (integration-r 3b84193).
import { worldToScreen } from '../viewport.js';

/** Clears the frame and paints the canvas paper. */
export function drawBackground(ctx, vm, theme){
  ctx.clearRect(0, 0, vm.width, vm.height);
  ctx.fillStyle = theme.paper;
  ctx.fillRect(0, 0, vm.width, vm.height);
}

/**
 * The snap grid, hidden when its lines would sit closer than 18 px. The `x += step` accumulation is
 * the monolith's, so the lines land on the same sub-pixels.
 */
export function drawGrid(ctx, vm, theme){
  const { grid, viewport, width, height } = vm;
  if(!grid.show) return;
  const { step, startX, endX, startY, endY } = grid;
  ctx.save();
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  for(let x=startX; x<=endX+1e-9; x+=step){
    const sx = worldToScreen({x, y:0}, viewport).x;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
    ctx.stroke();
  }
  for(let y=startY; y<=endY+1e-9; y+=step){
    const sy = worldToScreen({x:0, y}, viewport).y;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
    ctx.stroke();
  }
  ctx.restore();
}
