// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/hover.js — layer 6: what the active tool would add if the user clicked
// where the pointer is — the rubber bands, the polygon and hole previews, the split chord, the
// wall preview and the measure preview. From stage6BishopDrawCanvas 7060-7158 (integration-r
// 3b84193). Nothing here is drawn without a hover point, so the whole layer is one guard.
import { boundaryPickToleranceWorld } from '../viewport.js';
import { dist } from '../../geometry/points.js';
import { pickRegionBoundaryPoint } from '../../geometry/boundary.js';
import { sortZone, validZone, zoneColor } from '../../state/surface-loads.js';
import { defaultPassiveSide } from '../../state/walls.js';
import { terrainY as bishopTerrainY } from '../../../stage6-bishop.js';
import { drawMeasurementOverlay, drawPolyline, drawWall } from './primitives.js';

export function drawHoverPreview(ctx, vm, theme){
  const { bishop, hoverWorld } = vm;
  if(!hoverWorld) return;
  if((bishop.tool === 'terrain' || bishop.tool === 'phreatic') && bishop.draft?.length){
    const last = bishop.draft[bishop.draft.length-1];
    const next = vm.snap(hoverWorld, 'free');
    if(next.x > last.x + 1e-6){
      drawPolyline(ctx, vm, [last, next], bishop.tool === 'phreatic' ? theme.phreatic : theme.draft, 1.5, [6, 4]);
    }
  }
  if(bishop.tool === 'drain' && bishop.draftKind === 'drain' && bishop.draft?.length){
    const last = bishop.draft[bishop.draft.length - 1];
    const next = vm.snap(hoverWorld, 'free');
    if(dist(last, next) > 1e-6){
      drawPolyline(ctx, vm, [last, next], theme.drain, 1.5, [6, 4]);
    }
  }
  if((bishop.tool === 'entry' || bishop.tool === 'exit' || bishop.tool === 'load') && bishop.draftKind === bishop.tool && bishop.draft?.length === 1 && bishop.terrain.length >= 2){
    const terrain = {vertices:bishop.terrain};
    const first = bishop.draft[0];
    const x = Math.min(Math.max(vm.snap(hoverWorld, 'terrain-x').x, bishop.terrain[0].x), bishop.terrain[bishop.terrain.length-1].x);
    const zone = sortZone({xStart:first.x, xEnd:x});
    if(validZone(zone)){
      drawPolyline(ctx, vm, [
        {x:zone.xStart, y:bishopTerrainY(terrain, zone.xStart)},
        {x:zone.xEnd, y:bishopTerrainY(terrain, zone.xEnd)}
      ], zoneColor(bishop.tool), 4, [5, 4]);
    }
  }
  if((bishop.tool === 'region' || bishop.tool === 'regionHole') && (bishop.draftKind === 'region' || bishop.draftKind === 'regionHole') && bishop.draft?.length){
    const isHoleDraft = bishop.draftKind === 'regionHole';
    const next = vm.snap(hoverWorld, 'free');
    const preview = [...bishop.draft, next];
    if(preview.length >= 2){
      drawPolyline(ctx, vm, preview, isHoleDraft ? theme.draftHole : theme.draft, 1.5, [6, 4]);
    }
    if(preview.length >= 3){
      ctx.save();
      ctx.beginPath();
      preview.forEach((pt, index)=>{
        const s = vm.toScreen(pt);
        if(index === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fillStyle = isHoleDraft ? theme.draftHole : theme.draft;
      ctx.globalAlpha = 0.08;
      ctx.fill();
      ctx.restore();
      const first = vm.toScreen(preview[0]);
      ctx.save();
      ctx.fillStyle = theme.handleFill;
      ctx.strokeStyle = isHoleDraft ? theme.draftHole : theme.draft;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(first.x, first.y, 5, 0, Math.PI*2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
  if(bishop.tool === 'regionSplit'){
    const selectedRegion = vm.selectedRegion;
    const splitDraft = bishop.draftKind === 'regionSplit' ? (bishop.draft || []) : [];
    splitDraft.forEach((pt, index)=>{
      const s = vm.toScreen(pt);
      ctx.save();
      ctx.fillStyle = index === 0 ? theme.splitPoint : theme.handleFill;
      ctx.strokeStyle = theme.splitPoint;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 5, 0, Math.PI*2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });
    if(selectedRegion && splitDraft.length === 1 && hoverWorld){
      const hoverCut = pickRegionBoundaryPoint(selectedRegion, hoverWorld, ()=>boundaryPickToleranceWorld(vm.viewport));
      if(hoverCut){
        drawPolyline(ctx, vm, [splitDraft[0], hoverCut], theme.splitPoint, 2, [6, 4]);
      }
    }
  }
  if(bishop.tool === 'wall' && bishop.draftKind === 'wall' && bishop.draft?.length === 1){
    const top = bishop.draft[0];
    const tip = vm.snap(hoverWorld, 'free');
    drawWall(ctx, vm, theme, {
      head:{x:top.x, y:top.y},
      tip:{x:tip.x, y:tip.y},
      x:top.x,
      yTop:top.y,
      yTip:tip.y,
      passiveSide:defaultPassiveSide(bishop.terrain || [])
    }, {stroke:theme.wall, width:3, dash:[6,4]});
  }
  if(bishop.tool === 'measure' && (bishop.measurement?.points || []).length === 1){
    drawMeasurementOverlay(ctx, vm, theme, [
      bishop.measurement.points[0],
      vm.snap(hoverWorld, 'free')
    ], {preview:true});
  }
}
