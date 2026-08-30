// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/seepage.js — layer 3: the solved seepage field — element contours, contour
// lines, the free surface, flow lines and the exit-gradient faces.
// From stage6BishopDrawCanvas 6425-6484 (integration-r 3b84193). The contour catalogue is reached
// through `vm.env` (map §2.11 "Seepage state + contours" is not extracted yet).
import { drawPolyline, drawPolylineArrows } from './primitives.js';

export function drawSeepageField(ctx, vm, theme){
  const seepage = vm.seepage;
  if(!seepage) return;
  const { env, bishop } = vm;
  const { mesh, result, contourMode, contourDerived, stats } = seepage;

  if(bishop.seepage.display?.showContours !== false){
    ctx.save();
    mesh.cells.forEach((cell, index)=>{
      const polygon = cell?.polygon || [];
      if(polygon.length < 3) return;
      const screen = polygon.map((point)=>vm.toScreen(point));
      const wetFraction = Math.max(0, Math.min(result.cellWetFraction?.[index] ?? (result.cellDryMask?.[index] ? 0 : 1), 1));
      const alpha = contourMode === 'head' || contourMode === 'hydraulicFs'
        ? (0.08 + 0.44 * wetFraction)
        : 0.52;
      const value = env.seepageContourValue(result, mesh, index, contourMode);
      ctx.fillStyle = env.seepageContourColor(value, stats.min, stats.max, contourMode, alpha);
      ctx.beginPath();
      ctx.moveTo(screen[0].x, screen[0].y);
      for(let i=1;i<screen.length;i+=1) ctx.lineTo(screen[i].x, screen[i].y);
      ctx.closePath();
      ctx.fill();
    });
    ctx.restore();
  }

  if(bishop.seepage.display?.showContourLines !== false){
    ctx.save();
    contourDerived.levelSegments.forEach((group)=>{
      const stroke = env.seepageContourLineColor(group.level, stats.min, stats.max, contourMode, 0.94);
      (group.segments || []).forEach((segment)=>{
        drawPolyline(ctx, vm, segment, stroke, Math.abs(group.level) < 1e-10 ? 2.1 : 1.35, []);
      });
    });
    ctx.restore();
  }

  if(bishop.seepage.display?.showPhreatic !== false){
    (result.phreaticSegments || []).forEach((segment)=>{
      drawPolyline(ctx, vm, segment, theme.phreaticSolved, 2, [8, 4]);
    });
  }

  if(bishop.seepage.display?.showFlowVectors){
    const flowLines = result.flowLines || [];
    flowLines.forEach((line)=>{
      drawPolyline(ctx, vm, line, theme.flowLine, 1.6, []);
      drawPolylineArrows(ctx, vm, line, theme.flowArrow, 74, 7);
    });
  }

  if(bishop.seepage.display?.showExitGradient){
    (mesh.boundaryFaces || []).forEach((face, index)=>{
      if(face?.type !== 'seepage-face') return;
      if(result.activeSeepageFaceMask && !result.activeSeepageFaceMask[index]) return;
      const gradient = result.boundaryGradients?.[index] || 0;
      const t = Math.max(0, Math.min(gradient / Math.max(result.maxExitGradient || 1, 1e-6), 1));
      const stroke = `rgba(${Math.round(70 + 185 * t)}, ${Math.round(165 - 105 * t)}, 72, 0.86)`;
      drawPolyline(ctx, vm, [face.a, face.b], stroke, 4, []);
    });
  }
}
