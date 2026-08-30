// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/handles.js — layer 14: the round grab handles the Edit tool shows, drawn
// last so nothing covers them. From stage6BishopDrawCanvas 7375-7390 (integration-r 3b84193). The
// point set is `view-model.handlePoints` — the same set `picking.nearestHandle` grabs from.

export function drawEditHandles(ctx, vm, theme){
  const points = vm.editHandles;
  if(!points) return;
  points.forEach((pt)=>{
    const s = vm.toScreen(pt);
    ctx.save();
    ctx.fillStyle = theme.handleFill;
    ctx.strokeStyle = theme.handleStroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, 4, 0, Math.PI*2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });
}
