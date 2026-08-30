// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/canvas/draw/deformation.js — layer 4: the solved deformation field — element contours
// (T6 sub-triangles included), contour lines, plastic points, displacement vectors and the two
// meshes. From stage6BishopDrawCanvas 6486-6742 (integration-r 3b84193). The contour catalogue is
// reached through `vm.env` (map §2.11 "Deformation contours" is not extracted yet).
import { sampleDeformationState } from '../../../deformation/solver.js';
import { drawPolyline } from './primitives.js';

export function drawDeformationField(ctx, vm, theme){
  const def = vm.deformation;
  if(!def) return;
  const { env, bishop, width, height, deformationAnalysisType } = vm;
  const { mesh, result, contourMode, contourDerived, stats, vectorMode, vectorReference, deformedPoint } = def;

  if(bishop.deformation?.display?.showContours !== false){
    ctx.save();
    if(mesh.elementType === 't6' && vectorMode){
      mesh.elements.forEach((element)=>{
        env.t6VisualSubtriangles(element).forEach((subtri)=>{
          if(subtri.length < 3) return;
          const value = env.averageFiniteValues(
            subtri.map((nodeId)=>env.deformationFiniteScalarOrNull(contourDerived.nodalValues?.[nodeId])),
            null
          );
          if(!Number.isFinite(value)) return;
          const screen = subtri.map((nodeId)=>vm.toScreen(mesh.nodes[nodeId]));
          ctx.fillStyle = env.deformationContourColor(value, stats.min, stats.max, contourMode, 0.52, deformationAnalysisType);
          ctx.beginPath();
          ctx.moveTo(screen[0].x, screen[0].y);
          ctx.lineTo(screen[1].x, screen[1].y);
          ctx.lineTo(screen[2].x, screen[2].y);
          ctx.closePath();
          ctx.fill();
        });
      });
    } else {
      mesh.cells.forEach((cell, index)=>{
        const polygon = cell?.polygon || [];
        if(polygon.length < 3) return;
        const screen = polygon.map((point)=>vm.toScreen(point));
        const value = env.deformationContourValue(result, mesh, index, contourMode);
        if(!Number.isFinite(value)) return;
        ctx.fillStyle = env.deformationContourColor(value, stats.min, stats.max, contourMode, 0.52, deformationAnalysisType);
        ctx.beginPath();
        ctx.moveTo(screen[0].x, screen[0].y);
        for(let i=1;i<screen.length;i+=1) ctx.lineTo(screen[i].x, screen[i].y);
        ctx.closePath();
        ctx.fill();
      });
    }
    ctx.restore();
  }
  if(bishop.deformation?.display?.showContourLines !== false){
    ctx.save();
    contourDerived.levelSegments.forEach((group)=>{
      const stroke = env.deformationContourLineColor(group.level, stats.min, stats.max, contourMode, 0.94, deformationAnalysisType);
      (group.segments || []).forEach((segment)=>{
        drawPolyline(ctx, vm, segment, stroke, Math.abs(group.level) < 1e-10 ? 2.1 : 1.35, []);
      });
    });
    ctx.restore();
  }
  if(bishop.deformation?.display?.showPlasticPoints !== false){
    const plasticPointSets = env.deformationPlasticPointSets(result);
    const drawPlasticMarkers = (points, style = {})=>{
      if(!points?.length) return;
      const radius = Math.max(Number(style.radius) || 2.3, 1.2);
      ctx.save();
      points.forEach((point)=>{
        const screen = vm.toScreen(point);
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        if(style.fill){
          ctx.fillStyle = style.fill;
          ctx.fill();
        }
        if(style.stroke){
          ctx.lineWidth = Number(style.lineWidth) || 1;
          ctx.strokeStyle = style.stroke;
          ctx.stroke();
        }
      });
      ctx.restore();
    };
    drawPlasticMarkers(plasticPointSets.historyPoints, {
      stroke:theme.plasticHistory,
      lineWidth:1.2,
      radius:2.0
    });
    drawPlasticMarkers(plasticPointSets.activePoints, {
      fill:theme.plasticActive,
      stroke:theme.plasticStroke,
      lineWidth:0.9,
      radius:2.4
    });
    drawPlasticMarkers(plasticPointSets.tensionPoints, {
      fill:theme.plasticTension,
      stroke:theme.plasticStroke,
      lineWidth:0.9,
      radius:2.7
    });
  }
  if(
    bishop.deformation?.display?.showDisplacementVectors &&
    bishop.deformation?.display?.showContourLines !== false &&
    vectorMode
  ){
    const maxVectors = 28;
    const bucketSizePx = 96;
    const viewportPaddingPx = 18;
    const usedBuckets = new Set();
    let drawnVectors = 0;
    const drawDisplacementArrow = (screenMid, vx, vy, relativeMagnitude)=>{
      const mag = Math.hypot(vx, vy);
      if(!(mag > 1e-12)) return;
      const dirX = vx / mag;
      const dirY = vy / mag;
      const shaftPx = 10 + 8 * Math.max(0, Math.min(relativeMagnitude, 1));
      const halfDx = 0.5 * shaftPx * dirX;
      const halfDy = -0.5 * shaftPx * dirY;
      const tailX = screenMid.x - halfDx;
      const tailY = screenMid.y - halfDy;
      const tipX = screenMid.x + halfDx;
      const tipY = screenMid.y + halfDy;
      const headPx = 5.2;
      const headAngle = Math.PI / 6;
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = theme.vectorHalo;
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.strokeStyle = theme.vectorInk;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tipX, tipY);
      ctx.stroke();
      ctx.fillStyle = theme.vectorFill;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(
        tipX - headPx * Math.cos(Math.atan2(-dirY, dirX) - headAngle),
        tipY - headPx * Math.sin(Math.atan2(-dirY, dirX) - headAngle)
      );
      ctx.lineTo(
        tipX - headPx * Math.cos(Math.atan2(-dirY, dirX) + headAngle),
        tipY - headPx * Math.sin(Math.atan2(-dirY, dirX) + headAngle)
      );
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };
    contourDerived.levelSegments.forEach((group)=>{
      if(drawnVectors >= maxVectors) return;
      (group.segments || []).forEach((segment)=>{
        if(drawnVectors >= maxVectors || !segment?.length || segment.length < 2) return;
        const a = segment[0];
        const b = segment[segment.length - 1];
        const screenA = vm.toScreen(a);
        const screenB = vm.toScreen(b);
        const screenLen = Math.hypot(screenB.x - screenA.x, screenB.y - screenA.y);
        if(screenLen < 2) return;
        const midpoint = {
          x:0.5 * (a.x + b.x),
          y:0.5 * (a.y + b.y)
        };
        const screenMid = vm.toScreen(midpoint);
        if(
          screenMid.x < -viewportPaddingPx ||
          screenMid.x > width + viewportPaddingPx ||
          screenMid.y < -viewportPaddingPx ||
          screenMid.y > height + viewportPaddingPx
        ) return;
        const bucketKey = `${Math.floor(screenMid.x / bucketSizePx)}:${Math.floor(screenMid.y / bucketSizePx)}`;
        if(usedBuckets.has(bucketKey)) return;
        const sampled = sampleDeformationState(mesh, result, midpoint.x, midpoint.y);
        if(!sampled) return;
        const vx = contourMode === 'ux'
          ? Number(sampled.ux) || 0
          : contourMode === 'uy' || contourMode === 'settlement'
            ? 0
            : Number(sampled.ux) || 0;
        const vy = contourMode === 'ux'
          ? 0
          : contourMode === 'uy' || contourMode === 'settlement'
            ? Number(sampled.uy) || 0
            : Number(sampled.uy) || 0;
        const referenceMag = contourMode === 'ux'
          ? Math.abs(vx)
          : contourMode === 'uy' || contourMode === 'settlement'
            ? Math.abs(vy)
            : Math.hypot(vx, vy);
        if(!(referenceMag > 1e-12)) return;
        usedBuckets.add(bucketKey);
        drawDisplacementArrow(screenMid, vx, vy, referenceMag / vectorReference);
        drawnVectors += 1;
      });
    });
  }
  if(bishop.deformation?.display?.showUndeformedMesh){
    ctx.save();
    ctx.strokeStyle = theme.meshUndeformed;
    ctx.lineWidth = 0.8;
    mesh.elements.forEach((element)=>{
      const p0 = vm.toScreen(mesh.nodes[element[0]]);
      const p1 = vm.toScreen(mesh.nodes[element[1]]);
      const p2 = vm.toScreen(mesh.nodes[element[2]]);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.closePath();
      ctx.stroke();
    });
    ctx.restore();
  }
  if(bishop.deformation?.display?.showDeformedMesh !== false){
    ctx.save();
    ctx.strokeStyle = theme.meshDeformed;
    ctx.lineWidth = 0.9;
    mesh.elements.forEach((element)=>{
      const p0 = deformedPoint(element[0]);
      const p1 = deformedPoint(element[1]);
      const p2 = deformedPoint(element[2]);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.lineTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.closePath();
      ctx.stroke();
    });
    ctx.restore();
  }
}
