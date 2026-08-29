// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/state/domain.js — the analysis domain as a function of the bishop state: the sorted
// terrain / phreatic polyline, the seepage domain area under the terrain down to `analysisDepth`,
// and the automatic / resolved mesh target areas of the seepage and deformation meshes
// (legacy-controller.js 4147-4204 and 4885-4895 at 462fc50; stage6/apps/bishop-state.js since
// PR 11). Pure: `bishop` is read, never written. `ensure()` resolves the mesh target areas
// through these; the field setter and the panels read them under the monolith names.
import { terrainY as bishopTerrainY } from '../../stage6-bishop.js';
import { polygonArea } from '../../soil-regions.js';

/** stage6BishopSortedPolyline: finite points sorted by x, consecutive duplicates (< 1e-6) dropped. */
export function sortedPolyline(points){
  return (points || [])
    .filter(pt=>Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    .sort((a,b)=>a.x-b.x)
    .reduce((acc, pt)=>{
      if(!acc.length || Math.hypot(acc[acc.length-1].x-pt.x, acc[acc.length-1].y-pt.y) > 1e-6){
        acc.push({x:+pt.x, y:+pt.y});
      }
      return acc;
    }, []);
}

/** stage6BishopSeepageDomainArea: area of the terrain polygon closed at `analysisDepth` below the CPT (null without terrain). */
export function seepageDomainArea(bishop){
  const terrain = sortedPolyline(bishop?.terrain);
  if(terrain.length < 2) return null;
  const terrainLine = {vertices:terrain};
  const xMin = terrain[0].x;
  const xMax = terrain[terrain.length - 1].x;
  const refX = Number.isFinite(+bishop?.activeCptX)
    ? Math.max(xMin, Math.min(+bishop.activeCptX, xMax))
    : 0.5 * (xMin + xMax);
  const groundY = bishopTerrainY(terrainLine, refX);
  if(!Number.isFinite(groundY)) return null;
  const analysisDepth = Math.max(+bishop?.analysisDepth || 15, 0.5);
  const bottomY = groundY - analysisDepth;
  const polygon = [
    ...terrain,
    {x:xMax, y:bottomY},
    {x:xMin, y:bottomY}
  ];
  const area = polygonArea(polygon);
  return area > 1e-6 ? area : null;
}

/** stage6BishopAutoSeepageMeshTargetArea: domain / 3500 clamped to [0.05, 1.5] m² (0.05 without a domain). */
export function autoSeepageMeshTargetArea(bishop){
  const domainArea = seepageDomainArea(bishop);
  if(!(domainArea > 0)) return 0.05;
  return +Math.min(Math.max(domainArea / 3500, 0.05), 1.5).toFixed(3);
}

/** stage6BishopResolvedSeepageMeshTargetArea: the auto value, or the manual one (≥ 0.01) when auto is off. */
export function resolvedSeepageMeshTargetArea(bishop){
  const options = bishop?.seepage?.options || {};
  const autoArea = autoSeepageMeshTargetArea(bishop);
  if(options.meshTargetAreaAuto !== false) return autoArea;
  const manualArea = Number(options.meshTargetArea);
  return Math.max(Number.isFinite(manualArea) && manualArea > 0 ? manualArea : autoArea, 0.01);
}

/** stage6BishopAutoDeformationMeshTargetArea: 9 × the seepage rule, clamped to [0.45, 9.0] m². */
export function autoDeformationMeshTargetArea(bishop){
  // Auto target area for the deformation mesh.  Coarser than seepage by
  // a factor of 9 (was 3): the deformation analysis is dominated by the
  // nonlinear inner-Newton + GMRES cost, which scales much more strongly
  // with the number of free DOFs than the assembly cost — a 3× coarser
  // mesh in each direction (≈ 9× area per element) cuts numFree by 3×
  // and the GMRES Arnoldi cost by ~9× while keeping engineering-grade
  // resolution for the ground-improvement problem class this app targets.
  // Users can still tighten the mesh manually via the meshTargetArea field
  // (turning auto off).
  const domainArea = seepageDomainArea(bishop);
  if(!(domainArea > 0)) return 0.45;
  return +Math.min(Math.max(9 * (domainArea / 3500), 0.45), 9.0).toFixed(3);
}

/** stage6BishopResolvedDeformationMeshTargetArea: the auto value, or the manual one (≥ 0.01) when auto is off. */
export function resolvedDeformationMeshTargetArea(bishop){
  const options = bishop?.deformation?.options || {};
  const autoArea = autoDeformationMeshTargetArea(bishop);
  if(options.meshTargetAreaAuto !== false) return autoArea;
  const manualArea = Number(options.meshTargetArea);
  return Math.max(Number.isFinite(manualArea) && manualArea > 0 ? manualArea : autoArea, 0.01);
}
