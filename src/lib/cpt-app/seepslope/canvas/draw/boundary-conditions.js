// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/boundary-conditions.js — layer 12: the seepage outer boundary, one stroke
// per edge in its BC's colour and dash, with the selected / hovered edge outlined and the head
// labels. From stage6BishopDrawCanvas 7290-7332 (integration-r 3b84193). The BC lookup is reached
// through `vm.env` (map §2.11 "Seepage BC handlers" is not extracted yet).
import { drawPolyline } from './primitives.js';

export function drawBoundaryConditions(ctx, vm, theme){
  const boundary = vm.boundary;
  if(!boundary) return;
  const { env } = vm;
  boundary.edges.forEach((edge)=>{
    const bc = env.seepageBcForEdge(edge.edgeKey);
    const isSelected = boundary.selected?.edgeKey === edge.edgeKey;
    const isHovered = boundary.hovered?.edgeKey === edge.edgeKey;
    const stroke = bc?.type === 'head'
      ? theme.bcHead
      : bc?.type === 'seepage-face'
        ? theme.bcSeepageFace
        : theme.bcNoFlow;
    const dash = bc?.type === 'head' ? [] : bc?.type === 'seepage-face' ? [10, 6] : [7, 5];
    drawPolyline(ctx, vm, [edge.a, edge.b], stroke, isSelected ? 5 : isHovered ? 4 : 2.5, dash);
    if((isSelected || isHovered) && bc?.status !== 'orphaned'){
      drawPolyline(ctx, vm, [edge.a, edge.b], theme.bcSelectedOutline, 1.2, []);
    }
    if(boundary.showLabels){
      const label = bc?.type === 'head'
        ? `h=${Number(bc.head ?? edge.mid.y).toFixed(2)} m`
        : bc?.type === 'seepage-face'
          ? 'h = y'
          : (isSelected ? 'no-flow' : '');
      if(label){
        const mid = vm.toScreen(edge.mid);
        ctx.save();
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 4;
        ctx.strokeStyle = theme.halo;
        ctx.strokeText(label, mid.x, mid.y - 6);
        ctx.fillStyle = stroke;
        ctx.fillText(label, mid.x, mid.y - 6);
        ctx.restore();
      }
    }
  });
}
