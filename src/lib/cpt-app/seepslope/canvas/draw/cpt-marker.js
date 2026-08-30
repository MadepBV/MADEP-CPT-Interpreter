// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/cpt-marker.js — layer 13: where the active CPT is inserted, with the
// connector and the offset label when the insertion point sits above or below the terrain.
// From stage6BishopDrawCanvas 7334-7373 (integration-r 3b84193).
import { terrainY as bishopTerrainY } from '../../../stage6-bishop.js';

export function drawCptMarker(ctx, vm, theme){
  const marker = vm.cptMarker;
  if(!marker) return;
  const bishop = vm.bishop;
  const offset = marker.offset;
  const groundPt = {x:marker.x, y:bishopTerrainY({vertices:bishop.terrain}, marker.x)};
  const topPt = {x:groundPt.x, y:groundPt.y + offset};
  const sGround = vm.toScreen(groundPt);
  const sTop = vm.toScreen(topPt);
  ctx.save();
  if(Math.abs(offset) > 1e-6){
    // Connector from the terrain surface to the offset insertion point.
    ctx.strokeStyle = theme.cpt;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(sGround.x, sGround.y);
    ctx.lineTo(sTop.x, sTop.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(sGround.x - 5, sGround.y);
    ctx.lineTo(sGround.x + 5, sGround.y);
    ctx.stroke();
    const label = `${offset > 0 ? '+' : ''}${offset.toFixed(2)} m`;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = theme.cptHalo;
    ctx.strokeText(label, sTop.x + 9, 0.5 * (sGround.y + sTop.y));
    ctx.fillStyle = theme.cpt;
    ctx.fillText(label, sTop.x + 9, 0.5 * (sGround.y + sTop.y));
  }
  ctx.fillStyle = theme.cpt;
  ctx.beginPath();
  ctx.arc(sTop.x, sTop.y, 6, 0, Math.PI*2);
  ctx.fill();
  ctx.strokeStyle = theme.cptRing;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}
