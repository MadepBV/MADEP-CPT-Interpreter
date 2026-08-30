// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/regions.js — layer 2: the soil polygons and their labels.
// From stage6BishopDrawCanvas 6299-6357 (integration-r 3b84193).
import { polygonCentroid } from '../../geometry/polygons.js';
import { regionShortLabel } from '../../geometry/regions.js';

export function drawRegions(ctx, vm, theme){
  const { regions } = vm;
  if(!regions.show) return;
  regions.items.forEach((region)=>{
    if(!region.polygon?.length) return;
    const screenPts = region.polygon.map((pt)=>vm.toScreen(pt));
    const isSelectedCustom = region.id === regions.selectedId;
    ctx.beginPath();
    screenPts.forEach((s, index)=>{
      if(index === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.save();
    ctx.globalAlpha = regions.preview ? Math.min(regions.opacity + 0.06, 0.35) : regions.opacity;
    ctx.fillStyle = region.material.color || theme.regionFallback;
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = region.material.color || theme.regionFallback;
    ctx.globalAlpha = isSelectedCustom ? 0.95 : (regions.preview ? 0.82 : 0.7);
    ctx.lineWidth = isSelectedCustom ? 3 : 1.5;
    if(regions.preview) ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    if(isSelectedCustom){
      ctx.save();
      ctx.strokeStyle = theme.regionSelectedOutline;
      ctx.lineWidth = 1;
      ctx.setLineDash([6,4]);
      ctx.stroke();
      ctx.restore();
    }

    if(regions.showLabels){
      const centroid = polygonCentroid(region.polygon);
      if(centroid){
        const labelPos = vm.toScreen(centroid);
        const xs = screenPts.map((pt)=>pt.x);
        const ys = screenPts.map((pt)=>pt.y);
        const widthPx = Math.max(...xs) - Math.min(...xs);
        const heightPx = Math.max(...ys) - Math.min(...ys);
        if(widthPx >= 48 && heightPx >= 20){
          const label = regionShortLabel(region);
          ctx.save();
          ctx.font = '600 11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 4;
          ctx.lineJoin = 'round';
          ctx.strokeStyle = theme.halo;
          ctx.strokeText(label, labelPos.x, labelPos.y);
          ctx.fillStyle = theme.text;
          ctx.fillText(label, labelPos.x, labelPos.y);
          ctx.restore();
        }
      }
    }
  });
}
