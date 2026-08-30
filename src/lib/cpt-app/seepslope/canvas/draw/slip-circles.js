// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/slip-circles.js — layer 10: the Bishop search result — the live preview
// circle, the kept circles (worst first, the selected one in full colour), and for the selected
// circle its slice divisions and the wall reaction arrows.
// From stage6BishopDrawCanvas 7218-7286 (integration-r 3b84193).
import { wallNormalForSide } from '../../../wall-geometry.js';
import { drawCircleArc } from './primitives.js';

export function drawSlipCircles(ctx, vm, theme){
  if(vm.workspace !== 'stability') return;
  const { circles } = vm;
  const { results, keepBest, selectedIndex, selected } = circles;
  if(circles.previewCircle){
    drawCircleArc(ctx, vm, circles.previewCircle, theme.circlePreview, 1.8, [8, 6]);
  }
  for(let i=Math.min(keepBest-1, results.length-1); i>=0; i-=1){
    const result = results[i];
    const color = i === selectedIndex ? theme.circleSelected : theme.circleOther;
    drawCircleArc(ctx, vm, result.circle, color, i === selectedIndex ? 2.8 : 1.2);
  }

  if(selected){
    selected.slices.forEach((slice)=>{
      const top = vm.toScreen({x:slice.xL, y:slice.yTopL});
      const base = vm.toScreen({x:slice.xL, y:slice.yBaseL});
      ctx.save();
      ctx.strokeStyle = theme.slice;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(base.x, base.y);
      ctx.stroke();
      ctx.restore();
    });
    (selected.wallForces || []).forEach((wallForce)=>{
      const application = vm.toScreen({x:wallForce.x, y:wallForce.y_application});
      const passiveNormal = wallForce.passiveNormal || wallNormalForSide(wallForce.wall, wallForce.wall?.passiveSide);
      const screenNormal = passiveNormal
        ? {x:passiveNormal.x, y:-passiveNormal.y}
        : {x:wallForce.wall?.passiveSide === 'left' ? -1 : 1, y:0};
      const labelAlign = screenNormal.x >= 0 ? 'left' : 'right';
      const tip = {
        x:application.x + screenNormal.x * 22,
        y:application.y + screenNormal.y * 22
      };
      const tangent = {x:-screenNormal.y, y:screenNormal.x};
      ctx.save();
      ctx.strokeStyle = theme.wallForce;
      ctx.fillStyle = theme.wallForce;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(application.x, application.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - screenNormal.x * 8 + tangent.x * 5, tip.y - screenNormal.y * 8 + tangent.y * 5);
      ctx.lineTo(tip.x - screenNormal.x * 8 - tangent.x * 5, tip.y - screenNormal.y * 8 - tangent.y * 5);
      ctx.closePath();
      ctx.fill();
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = labelAlign;
      ctx.fillText(`${wallForce.R_wall.toFixed(0)} kN/m`, tip.x + screenNormal.x * 4, tip.y + screenNormal.y * 4 - 6);
      ctx.restore();
    });
  }
}
