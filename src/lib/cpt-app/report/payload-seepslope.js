// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// report/payload-seepslope.js — the Stage 7 annexes of the Seep/Slope app: stability
// (Bishop / Spencer results), seepage (boundary conditions, mesh, result) and deformation.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 8, refactor step 4):
// stage7BishopPayload (old lines 15981-16062 at c989770), stage7SeepagePayload
// (16064-16258) and stage7DeformationPayload (16264-16319). Changes inside the bodies:
//   • the CPT state is a parameter (`cpt`) instead of the module-level active CPT `S`;
//   • the Seep/Slope helpers that stay in the controller until refactor step 9
//     (stage6BishopResultMethodLabel, stage6BishopSeepageEdgeLabel,
//     stage6BishopSeepageBcTypeLabel, stage6BishopDrainGatingLabel,
//     stage6BishopResolvedSeepageMeshTargetArea) come from `deps.seepslope` (report/deps.js);
//   • stage6BishopSelectedResult() was results[clamp(selectedResult, 0, n-1)] over the same
//     allResults array — the `selectedIndex` the payload computes itself — so
//     `selected = results[selectedIndex]`;
//   • the two impure calls of the deformation annex (ensureStage6State(),
//     stage7CaptureBishopWorkspaceView('deformation')) go through `deps.ensureStage6State`
//     / `deps.captureBishopWorkspaceView`, with the same "manual capture first" conditional.

import { normalizeWallMaterial, seepageSourceLabel, wallMaterialSourceLabel } from '../seepage/material.js';
import { drainTotalLength } from '../seepage/drains.js';
import { wallEndpoints } from '../wall-geometry.js';
import { safeClone } from './clone.js';
import { stage7Deps } from './deps.js';

export function stage7BishopPayload(cpt, deps){
  deps = stage7Deps(cpt, deps);
  const sl = deps.seepslope;
  const bishop=cpt.stage6?.bishop;
  const results=bishop?.results?.allResults || [];
  if(!results.length) return null;
  const selectedIndex=Math.min(Math.max(bishop.selectedResult || 0, 0), Math.max(results.length - 1, 0));
  const selected=results[selectedIndex];
  const keepBest=Math.max(bishop.search?.keepBest || 10, 1);
  return{
    config:safeClone({
      strengthSet:bishop.strengthSet,
      methodMode:bishop.methodMode,
      analysisDepth:bishop.analysisDepth,
      snapSize:bishop.snapSize,
      gridSnap:bishop.gridSnap,
      pointSnap:bishop.pointSnap,
      activeCptX:bishop.activeCptX,
      cptInsertionOffset:bishop.cptInsertionOffset,
      walls:bishop.walls,
      entryZone:bishop.entryZone,
      exitZone:bishop.exitZone,
      surfaceLoad:bishop.surfaceLoad,
      surfaceLoads:bishop.surfaceLoads,
      search:bishop.search,
      solver:bishop.solver,
      spencer:bishop.spencer
    }),
    summary:safeClone(bishop.results?.summary || null),
    wallSummary:safeClone(bishop.results?.wallSummary || null),
    methodMode:bishop.results?.methodMode || bishop.methodMode || 'bishop_only',
    spencerRechecked:bishop.results?.spencerRechecked || 0,
    spencerConverged:bishop.results?.spencerConverged || 0,
    selectedIndex,
    selected:selected ? safeClone({
      FS:selected.FS,
      method:selected.method,
      methodLabel:sl.resultMethodLabel(selected),
      F_bishop:selected.F_bishop,
      F_m:selected.F_m,
      F_f:selected.F_f,
      lambda:selected.lambda,
      thetaDeg:selected.thetaDeg,
      momentResidual:selected.momentResidual,
      forceResidual:selected.forceResidual,
      spencerAttempted:selected.spencerAttempted,
      spencerConverged:selected.spencerConverged,
      spencerRejectReason:selected.spencerRejectReason,
      intersectsWall:selected.intersectsWall,
      passesBelowWall:selected.passesBelowWall,
      wallIntersectionCount:selected.wallIntersectionCount,
      wallForceTotal:selected.wallForceTotal,
      wallMomentTerm:selected.wallMomentTerm,
      wallForces:selected.wallForces,
      iterations:selected.iterations,
      circle:selected.circle,
      entry:selected.entry,
      exit:selected.exit
    }) : null,
    topResults:results.slice(0, keepBest).map((result, index)=>safeClone({
      rank:index + 1,
      FS:result.FS,
      method:result.method,
      methodLabel:sl.resultMethodLabel(result),
      F_bishop:result.F_bishop,
      F_m:result.F_m,
      F_f:result.F_f,
      lambda:result.lambda,
      thetaDeg:result.thetaDeg,
      momentResidual:result.momentResidual,
      forceResidual:result.forceResidual,
      spencerAttempted:result.spencerAttempted,
      spencerConverged:result.spencerConverged,
      spencerRejectReason:result.spencerRejectReason,
      intersectsWall:result.intersectsWall,
      passesBelowWall:result.passesBelowWall,
      wallIntersectionCount:result.wallIntersectionCount,
      wallForceTotal:result.wallForceTotal,
      iterations:result.iterations,
      circle:result.circle
    })),
    rejectionCounts:safeClone(bishop.results?.rejectionCounts || {}),
    timing:safeClone(bishop.results?.timing || null)
  };
}

export function stage7SeepagePayload(cpt, deps){
  deps = stage7Deps(cpt, deps);
  const sl = deps.seepslope;
  const bishop=cpt.stage6?.bishop;
  const seepage=bishop?.seepage;
  if(!bishop || !seepage) return null;
  try{
    const model=cpt.stage6Cache?.bishopModel || null;
    const boundary=cpt.stage6Cache?.bishopSeepageBoundary || [];
    const edgeByKey=new Map(boundary.map((edge)=>[edge.edgeKey, edge]));
    const activeBcs=(seepage.bcs || []).filter((bc)=>bc?.status !== 'orphaned');
    const orphanedBcs=(seepage.bcs || []).filter((bc)=>bc?.status === 'orphaned');
    const hasSetup=!!(activeBcs.length || orphanedBcs.length || seepage.mesh || seepage.result || seepage.rejectReason);
    if(!hasSetup) return null;
    const prescribedHeadCount=activeBcs.filter((bc)=>bc.type === 'head').length;
    const seepageFaceCount=activeBcs.filter((bc)=>bc.type === 'seepage-face').length;
    const noFlowCount=activeBcs.filter((bc)=>bc.type !== 'head' && bc.type !== 'seepage-face').length;
    const edgeLabelFor=(edgeKey, anchorSource)=>{
      if(edgeByKey.has(edgeKey)) return sl.seepageEdgeLabel(edgeByKey.get(edgeKey));
      if(typeof edgeKey === 'string' && edgeKey){
        const [source, rawIndex] = edgeKey.split(':');
        const index = Number(rawIndex);
        return sl.seepageEdgeLabel({
          source:source || anchorSource || '',
          index:Number.isFinite(index) ? index : 0
        });
      }
      return anchorSource ? `${anchorSource} edge` : 'Unmatched boundary edge';
    };
    return{
      config:safeClone({
        freeSurface:seepage.options?.freeSurface === 'iterate' ? 'iterate' : 'fixed',
        usePhreaticAsSeed:seepage.options?.usePhreaticAsSeed !== false,
        flowErrorTolerance:Math.max(+seepage.options?.flowErrorTolerance || 0.01, 0.000001),
        maxRuntimeMs:Math.max(+seepage.options?.maxRuntimeMs || 10000, 1),
        meshTargetArea:sl.resolvedSeepageMeshTargetArea(bishop),
        meshTargetAreaAuto:seepage.options?.meshTargetAreaAuto !== false,
        drains:safeClone(seepage.options?.drains || {gatingTolerances:{}, reportPerSegmentInflow:true}),
        useFemPorePressure:!!bishop.useFemPorePressure
      }),
      summary:{
        status:seepage.status || 'idle',
        solved:!!seepage.mesh && !!seepage.result,
        rejectReason:seepage.rejectReason || '',
        explicitBcCount:(seepage.bcs || []).length,
        activeBcCount:activeBcs.length,
        orphanedBcCount:orphanedBcs.length,
        prescribedHeadCount,
        seepageFaceCount,
        noFlowCount,
        drainCount:bishop.drains?.length || 0,
        activeDrainNodeCount:seepage.result?.solver?.activeSetSummary?.drains?.activeNodes || 0,
        totalDrainNodeCount:seepage.result?.solver?.activeSetSummary?.drains?.totalNodes || 0
      },
      geometry:safeClone({
        regionMode:model?.regionMode || (bishop.useCustomRegions ? 'custom' : 'auto'),
        regionCount:model?.regions?.length || (bishop.useCustomRegions ? (bishop.customRegions?.length || 0) : (bishop.materials?.length || 0)),
        autoRegionCount:model?.autoRegions?.length || 0,
        customRegionCount:model?.customRegions?.length || (bishop.customRegions?.length || 0),
        terrainVertexCount:bishop.terrain?.length || 0,
        phreaticVertexCount:bishop.phreatic?.length || 0,
        drainCount:bishop.drains?.length || 0,
        wallCount:bishop.walls?.length || 0,
        boundaryEdgeCount:boundary.length
      }),
      walls:(bishop.walls || []).map((wall, index)=>{
        const material = normalizeWallMaterial(wall.material, index, wall.id, {sourceFallback:'legacy-impermeable'});
        const endpoints = wallEndpoints(wall);
        return safeClone({
          id:wall.id || `wall-${index + 1}`,
          label:`Wall ${index + 1}`,
          head:endpoints ? endpoints.head : null,
          tip:endpoints ? endpoints.tip : null,
          x:Number.isFinite(+wall.x) ? +wall.x : null,
          yTop:Number.isFinite(+wall.yTop) ? +wall.yTop : null,
          yTip:Number.isFinite(+wall.yTip) ? +wall.yTip : null,
          passiveSide:wall.passiveSide === 'left' ? 'left' : 'right',
          material:{
            id:material.id,
            label:material.label,
            kAcross:material.kAcross,
            kAlong:material.kAlong,
            kSource:material.kSource,
            kSourceLabel:wallMaterialSourceLabel(material.kSource)
          }
        });
      }),
      drains:(bishop.drains || []).map((drain, index)=>{
        const drainId = drain.id || `drain-${index + 1}`;
        const resultDrain = (seepage.result?.drains || []).find((item)=>item?.drainId === drainId) || null;
        const activeNodes = resultDrain?.nodes?.filter((node)=>node?.isActive).length || 0;
        return safeClone({
          id:drainId,
          label:drain.label || `Drain ${index + 1}`,
          vertices:drain.vertices || [],
          vertexCount:drain.vertices?.length || 0,
          closed:!!drain.closed,
          length:drainTotalLength(drain),
          head:safeClone(drain.head || {kind:'constant', value:0}),
          gating:drain.gating || 'when-saturated',
          gatingLabel:sl.drainGatingLabel(drain.gating),
          result:resultDrain ? {
            totalInflow:resultDrain.totalInflow,
            activeNodes,
            totalNodes:resultDrain.nodes?.length || 0,
            perSegmentInflow:resultDrain.perSegmentInflow || []
          } : null
        });
      }),
      materials:(bishop.materials || []).map((mat)=>safeClone({
        id:mat.id || '',
        label:mat.label || mat.id || 'Material',
        kx:Number.isFinite(+mat.kx) ? +mat.kx : null,
        ky:Number.isFinite(+mat.ky) ? +mat.ky : null,
        kSource:mat.kSource || 'sbtn-default',
        kSourceLabel:seepageSourceLabel(mat.kSource)
      })),
      boundaryConditions:(seepage.bcs || []).map((bc, index)=>{
        const edge=edgeByKey.get(bc.edgeKey);
        return safeClone({
          id:bc.id || `bc-${index + 1}`,
          edgeKey:bc.edgeKey || '',
          edgeLabel:edgeLabelFor(bc.edgeKey, bc.anchor?.source),
          source:edge?.source || bc.anchor?.source || '',
          index:edge?.index ?? null,
          type:bc.type === 'head' ? 'head' : bc.type === 'seepage-face' ? 'seepage-face' : 'no-flow',
          typeLabel:sl.seepageBcTypeLabel(bc.type),
          head:bc.type === 'head' && Number.isFinite(+bc.head) ? +bc.head : null,
          status:bc.status === 'orphaned' ? 'orphaned' : 'active',
          length:Number.isFinite(edge?.length) ? edge.length : null,
          midpoint:safeClone(edge?.mid || bc.anchor?.mid || null)
        });
      }),
      mesh:seepage.mesh ? safeClone({
        nodes:seepage.mesh.nodes?.length || 0,
        elements:seepage.mesh.elements?.length || 0,
        cells:seepage.mesh.cells?.length || 0,
        boundaryFaces:seepage.mesh.boundaryFaces?.length || 0,
        drainEdges:[...(seepage.mesh.drainEdgesByDrain?.values?.() || [])].reduce((sum, edges)=>sum + (edges?.length || 0), 0),
        generatedMs:Number.isFinite(+seepage.mesh.generatedMs) ? +seepage.mesh.generatedMs : null
      }) : null,
      result:seepage.result ? safeClone({
        headMin:seepage.result.headMin,
        headMax:seepage.result.headMax,
        throughFlow:seepage.result.throughFlow,
        inflow:seepage.result.inflow,
        outflow:seepage.result.outflow,
        flowError:seepage.result.flowError,
        maxExitGradient:seepage.result.maxExitGradient,
        dryCellCount:seepage.result.dryCellCount,
        equipotentialLevelCount:seepage.result.equipotentialSegments?.length || 0,
        phreaticSegmentCount:seepage.result.phreaticSegments?.length || 0,
        drains:safeClone(seepage.result.drains || []),
        solver:safeClone(seepage.result.solver || null),
        timing:safeClone(seepage.result.timing || null)
      }) : null
    };
  } catch(error){
    console.error('Stage 7 seepage payload build failed:', error);
    return{
      config:safeClone({
        freeSurface:seepage.options?.freeSurface === 'iterate' ? 'iterate' : 'fixed',
        usePhreaticAsSeed:seepage.options?.usePhreaticAsSeed !== false,
        flowErrorTolerance:Math.max(+seepage.options?.flowErrorTolerance || 0.01, 0.000001),
        maxRuntimeMs:Math.max(+seepage.options?.maxRuntimeMs || 10000, 1),
        meshTargetArea:sl.resolvedSeepageMeshTargetArea(bishop),
        meshTargetAreaAuto:seepage.options?.meshTargetAreaAuto !== false,
        useFemPorePressure:!!bishop.useFemPorePressure
      }),
      summary:{
        status:seepage.status || 'idle',
        solved:false,
        rejectReason:seepage.rejectReason || 'Seepage report payload could not be fully assembled.',
        explicitBcCount:(seepage.bcs || []).length,
        activeBcCount:0,
        orphanedBcCount:0,
        prescribedHeadCount:0,
        seepageFaceCount:0,
        noFlowCount:0
      },
      geometry:{
        regionMode:bishop.useCustomRegions ? 'custom' : 'auto',
        regionCount:0,
        autoRegionCount:0,
        customRegionCount:bishop.customRegions?.length || 0,
        terrainVertexCount:bishop.terrain?.length || 0,
        phreaticVertexCount:bishop.phreatic?.length || 0,
        wallCount:bishop.walls?.length || 0,
        boundaryEdgeCount:0
      },
      materials:[],
      boundaryConditions:[],
      mesh:null,
      result:null
    };
  }
}

// Deformation annex — included only when a result has been solved. The
// captured view (manual via the toolbar button, or automatic at report-build
// time when none exists) is the primary visual; the surrounding payload
// captures the analysis context so the report can be reproduced and audited.
export function stage7DeformationPayload(cpt, deps){
  deps = stage7Deps(cpt, deps);
  deps.ensureStage6State();
  const stage6 = cpt.stage6;
  const bishop = stage6?.bishop;
  if(!bishop) return null;
  const deformation = bishop.deformation;
  if(!deformation || !deformation.result) return null;
  const result = deformation.result;
  const solver = result?.solver || {};
  const elementType = solver.elementType
    || result?.mesh?.elementType
    || deformation.options?.meshElementType
    || 't3';
  const safetyFosLower = Number.isFinite(solver.safetyFactorOfSafetyLower) ? Number(solver.safetyFactorOfSafetyLower) : null;
  const safetyFosUpper = Number.isFinite(solver.safetyFactorOfSafetyUpper) ? Number(solver.safetyFactorOfSafetyUpper) : null;
  const safetyFinalization = solver.safetyResult?.finalization || null;
  const summary = {
    analysisType: deformation.options?.analysisType || 'deformation',
    constitutiveModel: deformation.options?.constitutiveModel || 'linear-elastic',
    elementType,
    converged: solver.convergenceState === 'converged' || result?.converged === true,
    convergenceState: solver.convergenceState || null,
    loadFactor: result?.loadFactor != null ? Number(result.loadFactor) : null,
    loadFactorMeaning: result?.loadFactorMeaning || null,
    safetyStatus: solver.safetyStatus || null,
    safetyFinalizationStatus: safetyFinalization?.status || null,
    safetyFactorOfSafetyIsOpenEnded: safetyFinalization?.factorOfSafetyIsOpenEnded === true,
    safetyFactorOfSafetyLower: safetyFosLower,
    safetyFactorOfSafetyUpper: safetyFosUpper,
    safetyLoadFactor: safetyFosLower != null
      ? safetyFosLower
      : (result?.safetyLoadFactor != null ? Number(result.safetyLoadFactor) : null),
    initialPhaseConvergenceState: solver.initialPhaseConvergenceState || null,
    servicePhaseConvergenceState: solver.servicePhaseConvergenceState || null,
    iterations: solver.iterations != null
      ? Number(solver.iterations)
      : (result?.iterations != null ? Number(result.iterations) : null),
    timing: result?.timing ? safeClone(result.timing) : null,
    nodeCount: Array.isArray(result?.mesh?.nodes) ? result.mesh.nodes.length : (result?.mesh?.nodeCount ?? null),
    elementCount: Array.isArray(result?.mesh?.triangles) ? result.mesh.triangles.length : (result?.mesh?.elementCount ?? null),
    maxSettlementMm: result?.summary?.maxSettlementMm ?? null,
    maxDisplacementMm: result?.summary?.maxDisplacementMm ?? null
  };
  const manualView = bishop.capturedView?.deformation || null;
  const view = manualView
    ? safeClone(manualView)
    : deps.captureBishopWorkspaceView('deformation');
  if(!view) return null;
  view.source = manualView ? 'manual' : 'auto';
  return {
    config: safeClone(deformation.options || {}),
    summary,
    warnings: Array.isArray(deformation.warnings) ? safeClone(deformation.warnings) : [],
    view
  };
}
