// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/loads.js — layer 7: the Bishop entry / exit windows and every surface load
// (band, caption, arrows and, when selected, its two drag handles).
// From stage6BishopDrawCanvas 7160-7202 (integration-r 3b84193).
import { effectiveSurfaceLoadQ, sortZone, validZone, zoneColor } from '../../state/surface-loads.js';
import { terrainY as bishopTerrainY } from '../../../stage6-bishop.js';
import { drawLoadZoneMarkers, drawPolyline } from './primitives.js';

/** A zone as a stroke along the terrain between its two x values. */
function zoneStroke(ctx, vm, zone, color, widthPx, dash){
  const bishop = vm.bishop;
  if(!validZone(zone) || bishop.terrain.length < 2) return;
  const pts = [
    {x:zone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, zone.xStart)},
    {x:zone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, zone.xEnd)}
  ];
  drawPolyline(ctx, vm, pts, color, widthPx || 5, dash);
}

export function drawZonesAndLoads(ctx, vm, theme){
  const { bishop, workspace } = vm;
  zoneStroke(ctx, vm, bishop.entryZone, zoneColor('entry'));
  zoneStroke(ctx, vm, bishop.exitZone, zoneColor('exit'));
  (bishop.surfaceLoads || []).forEach((load, index)=>{
    const zone = sortZone(load);
    if(!validZone(zone)) return;
    const q = effectiveSurfaceLoadQ(bishop, load, workspace);
    const selectedLoad = load.id === bishop.selectedSurfaceLoadId;
    const active = load.active !== false && q > 0;
    const color = selectedLoad ? theme.loadSelected : zoneColor('load');
    if(selectedLoad){
      zoneStroke(ctx, vm, zone, theme.loadSelectedHalo, 12, []);
    }
    zoneStroke(ctx, vm, zone, color, selectedLoad ? 6 : 4, active ? [] : [5, 4]);
    if(workspace !== 'deformation' || bishop.deformation?.display?.showLoadVectors !== false){
      drawLoadZoneMarkers(ctx, vm, theme, zone, q, color, {
        label: load.label || `Load ${index + 1}`,
        active,
        selected: selectedLoad
      });
    }
    if(selectedLoad){
      [zone.xStart, zone.xEnd].forEach((x)=>{
        const y = bishopTerrainY({vertices:bishop.terrain}, x);
        const screen = vm.toScreen({x, y});
        ctx.save();
        ctx.fillStyle = theme.handleFill;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      });
    }
  });
}
