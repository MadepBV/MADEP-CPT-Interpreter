// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/panels/view-model.js — the one pure derivation step between the Seep / Slope state and
// the panels (refactor step 9f, PLAN §2 row 18f; 01-monolith-map.md §6.3 item 4: the two giant
// render functions "have ~130 local derivations shared across the template; they must be split by
// … `data-st6details` group **with an explicit view-model**").
//
// This is `renderStage6BishopApp`'s prelude, verbatim and in the monolith's order:
// legacy-controller.js 5849-6105, 6107-6451, 7025-7026, 7059-7082, 7133-7162 and 7366-7381 — 198
// derivations, the table-row builders included, computed **once** and then read by every section,
// sheet, tool-rail card and results panel. Every guard is the monolith's, in the monolith's place.
//
// Nothing here writes. The two statements the monolith interleaved that do are the host's:
//   · `stage6BishopMigrateSurfaceLoadsShape(bishop)` (6106's predecessor at 5848) runs before this
//     function, exactly where the monolith ran it;
//   · `S.stage6Cache.bishopLineProbe = lineProbe` (6106) runs right after it — nothing between that
//     line and the end of the render reads the key back (its only reader is
//     `buildStage6BishopLineProbeChart`, after the innerHTML swap).
// The volatile memo stores the two contour catalogues keep are reached through `env` and are not
// part of the state this function is handed; the verifier asserts `bishop` and `model` come back
// byte-identical.
//
// `env` is the host half — the regions step 9f must not touch (map §2.11): the seepage boundary and
// its selection, the seepage / deformation contour catalogues, the wall-result readers, the details
// memory, the Stage 4 depth and the two feature flags.
import { escAttr as stage6EscAttr, escJsString as stage6EscJsString } from '../../core/format.js';
import { drainHeadValueAt, drainTotalLength } from '../../seepage/drains';
import { defaultWallMechanicalMaterial, normalizeWallMaterial, seepageSourceLabel, wallMaterialSourceLabel } from '../../seepage/material';
import { bishopHsJakyK0nc, bishopHsRowePhiCvDeg } from '../../stage6-bishop';
import { wallEndpoints, wallLength } from '../../wall-geometry.js';
import { measurementLabel as stage6BishopMeasurementLabel, measurementMetrics as stage6BishopMeasurementMetrics, regionLegendItems as stage6BishopRegionLegendItems, showingCustomRegionPreview as stage6BishopShowingCustomRegionPreview } from '../geometry/index.js';
import { methodModeLabel as stage6BishopMethodModeLabel, safetyFinalizationStatusFromSolver as stage6SafetyFinalizationStatusFromSolver } from '../run/index.js';
import { activeSurfaceLoads as activeSurfaceLoadsOf, autoDeformationMeshTargetArea as stage6BishopAutoDeformationMeshTargetArea, autoSeepageMeshTargetArea as stage6BishopAutoSeepageMeshTargetArea, drainGatingLabel as stage6BishopDrainGatingLabel, effectiveSurfaceLoadQ as effectiveSurfaceLoadQOf, resolvedDeformationMeshTargetArea as stage6BishopResolvedDeformationMeshTargetArea, resolvedSeepageMeshTargetArea as stage6BishopResolvedSeepageMeshTargetArea, resultWallLabel as stage6BishopResultWallLabel, selectedCustomRegion as selectedCustomRegionOf, selectedSurfaceLoad as selectedSurfaceLoadOf, sortZone as stage6BishopSortZone, validZone as stage6BishopValidZone, wallMaterialPresetKey as stage6BishopWallMaterialPresetKey } from '../state/index.js';
import { partialLoadBadgeHtml as stage6BishopPartialLoadBadgeHtml, resultMethodLabel as stage6BishopResultMethodLabel } from './labels.js';

export function buildPanelsViewModel(input, env){
  const { bishop, bishopUi, model, modeMeta, selected } = input;
  const { STAGE6_ENABLE_HARDENING_SOIL_UI, STAGE6_WALL_RESPONSE_QUANTITIES, cachedSeepageBoundary, stage6BishopCurrentSeepageBoundary, stage6BishopSelectedBoundaryEdge, stage6BishopSeepageBcForEdge, stage6BishopSeepageEdgeLabel, stage6BishopSeepageBcTypeLabel, stage6BishopDisplayRegions, stage6BishopReadyMessage, stage6BishopLineProbeOptions, stage6BishopBuildLineProbe, stage6BishopAnalysisWallId, stage6BishopWallResultForId, stage6BishopWallResultSeries, stage6BishopWallQuantityStats, stage6BishopWallQuantityFormat, stage6BishopWallOverlayQuantity, stage6BishopSeepageContourOptions, stage6BishopSeepageContourMeta, stage6BishopSeepageContourDerived, stage6BishopSeepageContourLegendTicks, stage6BishopDeformationContourOptions, stage6BishopDeformationContourMeta, stage6BishopDeformationContourDerived, stage6BishopDeformationContourLegendTicks, stage6BishopDeformationVectorMode } = env;
  // The four surface-load / region façades of the controller, bound to the block we were handed
  // instead of to `S.stage6.bishop` — the same seepslope/state functions, the same signatures.
  const stage6BishopSelectedSurfaceLoad = ()=>selectedSurfaceLoadOf(bishop);
  const stage6BishopSelectedCustomRegion = ()=>selectedCustomRegionOf(bishop);
  const stage6BishopActiveSurfaceLoads = (workspace = bishop?.workspace || 'stability')=>activeSurfaceLoadsOf(bishop, workspace);
  const stage6BishopEffectiveSurfaceLoadQ = (load, workspace = bishop?.workspace || 'stability')=>effectiveSurfaceLoadQOf(bishop, load, workspace);

  const results = bishop.results?.allResults || [];
  const summary = bishop.results?.summary;
  const wallSummary = bishop.results?.wallSummary || null;
  const surfaceLoads = bishop.surfaceLoads || [];
  const selectedSurfaceLoad = stage6BishopSelectedSurfaceLoad();
  const primarySurfaceLoad = selectedSurfaceLoad
    || surfaceLoads.find((load)=>load.active !== false)
    || surfaceLoads[0]
    || null;
  const workspace = bishop.workspace === 'seepage' ? 'seepage' : bishop.workspace === 'deformation' ? 'deformation' : 'stability';
  const activeSurfaceLoads = stage6BishopActiveSurfaceLoads(workspace);
  const loadZone = stage6BishopSortZone(primarySurfaceLoad || bishop.surfaceLoad);
  const loadZoneActive = stage6BishopValidZone(loadZone);
  const loadQ = stage6BishopEffectiveSurfaceLoadQ(primarySurfaceLoad || bishop.surfaceLoad, workspace);
  const totalActiveLoadKnPerM = activeSurfaceLoads.reduce((sum, load)=>sum + stage6BishopEffectiveSurfaceLoadQ(load, workspace) * Math.max(load.xEnd - load.xStart, 0), 0);
  const wallCount = (bishop.walls || []).length;
  const hasWalls = wallCount > 0;
  const loadSummary = surfaceLoads.length
    ? `${activeSurfaceLoads.length}/${surfaceLoads.length} active · ${totalActiveLoadKnPerM.toFixed(1)} kN/m total`
    : 'not set';
  const runReady = !!model && !!bishop.entryZone && !!bishop.exitZone;
  const showSpencerSliceCols = !!selected?.spencerConverged;
  const showWallSliceCol = !!selected?.slices?.some((slice)=>(slice.wallForceLeft || 0) > 0);
  const selectedNormalHeader = showSpencerSliceCols ? 'Effective normal' : 'Normal';
  const selectedMethodLabel = stage6BishopResultMethodLabel(selected);
  const selectedWallLabel = stage6BishopResultWallLabel(selected);
  const selectedCustomRegion = stage6BishopSelectedCustomRegion();
  const customRegionCount = (bishop.customRegions || []).length;
  const customModeActive = !!bishop.useCustomRegions && customRegionCount > 0;
  const showingCustomRegionPreview = stage6BishopShowingCustomRegionPreview(model);
  const measurementPoints = bishop.measurement?.points || [];
  const measurementMetrics = stage6BishopMeasurementMetrics(measurementPoints);
  const measurementStatus = measurementMetrics
    ? stage6BishopMeasurementLabel(measurementMetrics)
    : measurementPoints.length === 1
      ? 'Pick the second point to complete the measurement.'
      : 'none';
  const settingsCollapsed = true;
  const settingsWide = bishopUi.bishopSettingsWide === true;
  const seepage = bishop.seepage || {};
  const deformation = bishop.deformation || {};
  const seepageBoundary = cachedSeepageBoundary() || stage6BishopCurrentSeepageBoundary(model);
  const selectedSeepageEdge = stage6BishopSelectedBoundaryEdge(model);
  const selectedSeepageBc = seepage.selectedBcId
    ? (seepage.bcs || []).find((bc)=>bc.id === seepage.selectedBcId) || null
    : (selectedSeepageEdge ? stage6BishopSeepageBcForEdge(selectedSeepageEdge.edgeKey) : null);
  const seepageActiveBcs = (seepage.bcs || []).filter((bc)=>bc.status !== 'orphaned');
  const seepageOrphanedBcs = (seepage.bcs || []).filter((bc)=>bc.status === 'orphaned');
  const seepageHeadCount = seepageActiveBcs.filter((bc)=>bc.type === 'head').length;
  const seepageMeshTargetAreaAuto = seepage.options?.meshTargetAreaAuto !== false;
  const seepageAutoMeshTargetArea = stage6BishopAutoSeepageMeshTargetArea(bishop);
  const seepageMeshTargetArea = stage6BishopResolvedSeepageMeshTargetArea(bishop);
  const seepageUsesIterativeFreeSurface = seepage.options?.freeSurface === 'iterate';
  const seepagePhreaticReady = seepage.options?.freeSurface === 'iterate' || (bishop.phreatic || []).length >= 2;
  const seepageRunReady = !!model && seepageHeadCount > 0 && seepagePhreaticReady;
  const seepageHasResult = !!seepage.mesh && !!seepage.result;
  const seepageStatusLabel = seepageHasResult && seepage.stale ? 'success (stale)' : (seepage.status || 'idle');
  const seepageSetupMessage = !model
    ? 'Draw terrain and place the active CPT before assigning seepage boundary conditions.'
    : seepageHeadCount > 0
      ? `${seepageHeadCount} prescribed-head boundary ${seepageHeadCount === 1 ? 'edge is' : 'edges are'} ready.`
      : 'Assign at least one prescribed-head boundary edge to make the seepage model solvable.';
  const seepageStatusMessage = seepage.progress?.running
    ? (seepage.progress.message || 'Running seepage...')
    : seepageHasResult && seepage.stale
      ? (seepage.rejectReason || 'Showing the previous seepage result. Rerun to update it.')
    : seepage.status === 'success'
      ? (seepage.progress?.message || 'Seepage result ready.')
      : (seepage.rejectReason || seepageSetupMessage);
  const deformationAnalysisType = deformation.options?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
  const deformationIsSafety = deformationAnalysisType === 'safety-cphi';
  const deformationLoadMode = deformation.options?.loadMode === 'total' ? 'total' : 'pressure';
  const deformationMeshTargetAreaAuto = deformation.options?.meshTargetAreaAuto !== false;
  const deformationAutoMeshTargetArea = stage6BishopAutoDeformationMeshTargetArea(bishop);
  const deformationMeshTargetArea = stage6BishopResolvedDeformationMeshTargetArea(bishop);
  const deformationMeshElementType = String(deformation.options?.meshElementType || '').toLowerCase() === 't6' ? 't6' : 't3';
  const deformationMeshElementLabel = deformation.result?.solver?.elementType === 't6' || deformation.mesh?.elementType === 't6' || deformationMeshElementType === 't6'
    ? 'T6 quadratic triangles'
    : 'T3 constant-strain triangles';
  const deformationNonlinearMaxIterations = Math.max(Math.round(Number(deformation.options?.nonlinearMaxIterations) || 32), 1);
  const deformationInitialLoadStep = Math.min(Math.max(Number(deformation.options?.initialLoadStep) || 0.25, 0.0001), 1);
  const deformationMinLoadStep = Math.max(Number(deformation.options?.minLoadStep) || (1/4096), 0.000001);
  const deformationMaxLoadSteps = Math.max(Math.round(Number(deformation.options?.maxLoadSteps) || 384), 1);
  const deformationResidualRelTol = Math.max(Number(deformation.options?.residualRelTol) || 1e-4, 1e-8);
  const deformationResidualAbsTol = Math.max(Number(deformation.options?.residualAbsTol) || 1e-3, 1e-9);
  const deformationDisplacementRelTol = Math.max(Number(deformation.options?.displacementRelTol) || 1e-5, 1e-8);
  const deformationDisplacementAbsTol = Math.max(Number(deformation.options?.displacementAbsTol) || 1e-8, 1e-12);
  const deformationLoadStepGrowthFactor = Math.max(Number(deformation.options?.loadStepGrowthFactor) || 1.25, 1);
  const deformationLoadStepCutbackFactor = Math.min(Math.max(Number(deformation.options?.loadStepCutbackFactor) || 0.5, 0.1), 0.9);
  const deformationPlasticLoadStepGrowthFactor = Math.max(Number(deformation.options?.plasticLoadStepGrowthFactor) || 1.08, 1);
  const deformationPlasticLoadStepCutbackFactor = Math.min(Math.max(Number(deformation.options?.plasticLoadStepCutbackFactor) || 0.4, 0.1), 0.9);
  const deformationGeostaticInitializationMethod = ['auto', 'gravity-ramp'].includes(String(deformation.options?.geostaticInitializationMethod || '').toLowerCase())
    ? String(deformation.options.geostaticInitializationMethod).toLowerCase()
    : 'auto';
  const deformationGeostaticCorrectionStages = Math.min(Math.max(Math.round(Number(deformation.options?.geostaticCorrectionStages) || 1), 1), 64);
  const deformationSafetyInitialSigmaMsfIncrement = Math.max(Number(deformation.options?.safetyInitialSigmaMsfIncrement) || 0.10, 0.001);
  const deformationSafetySigmaMsfGrowthFactor = Math.max(Number(deformation.options?.safetySigmaMsfGrowthFactor) || 1.50, 1.01);
  const deformationSafetySigmaMsfMax = Math.max(Number(deformation.options?.safetySigmaMsfMax) || 3.00, 1.0);
  const deformationSafetySigmaMsfBracketTolerance = Math.max(Number(deformation.options?.safetySigmaMsfBracketTolerance) || 0.01, 0.0001);
  const deformationSafetyMaxSearchTrials = Math.max(Math.round(Number(deformation.options?.safetyMaxSearchTrials) || 32), 1);
  const deformationUseUnsymmetricPlasticSolver = deformation.options?.useUnsymmetricPlasticSolver === true;
  const deformationUseWasmCpuPipeline = deformation.options?.useWasmCpuPipeline === true;
  const deformationSolverBackend = (() => {
    const raw = deformation.options?.solverBackend;
    if (raw === 'wasm-cpu' || raw === 'js-cpu') return raw;
    if (deformationUseWasmCpuPipeline) return 'wasm-cpu';
    return 'wasm-cpu';
  })();
  const deformationOutOfPlaneLength = Math.max(Number(deformation.options?.outOfPlaneLength) || 10, 0.1);
  const deformationActiveLoads = stage6BishopActiveSurfaceLoads('deformation');
  const deformationWidth = deformationActiveLoads.reduce((sum, load)=>sum + Math.max(load.xEnd - load.xStart, 0), 0);
  const deformationTotalLoadValue = deformationActiveLoads.reduce((sum, load)=>{
    const width = Math.max(load.xEnd - load.xStart, 0);
    const q = stage6BishopEffectiveSurfaceLoadQ(load, 'deformation');
    return sum + q * width * deformationOutOfPlaneLength;
  }, 0);
  const deformationTotalLoad = deformationTotalLoadValue > 0 ? deformationTotalLoadValue : (Number(deformation.options?.totalLoad) > 0 ? Number(deformation.options.totalLoad) : null);
  const deformationDerivedQ = deformationWidth > 0
    ? deformationActiveLoads.reduce((sum, load)=>sum + stage6BishopEffectiveSurfaceLoadQ(load, 'deformation') * Math.max(load.xEnd - load.xStart, 0), 0) / Math.max(deformationWidth, 1e-6)
    : loadQ;
  const deformationHasSurfaceLoadRequest = deformationActiveLoads.length > 0;
  const deformationRunReady = !!model && (
    deformationIsSafety
      ? true
      : deformationHasSurfaceLoadRequest
  );
  const deformationHasResult = !!deformation.mesh && !!deformation.result;
  const deformationStatusLabel = deformationHasResult && deformation.stale ? 'success (stale)' : (deformation.status || 'idle');
  const deformationAppliedQ = Math.max(Number(deformationDerivedQ) || 0, 0);
  const deformationWarnings = Array.isArray(deformation.warnings) ? deformation.warnings : [];
  const deformationInitialStressLabel = (mode)=>{
    if(!mode) return '—';
    if(mode === 'elastic-k0-recovery') return 'elastic gravity step with K0 stress recovery';
    if(mode === 'slope-aware-elastic-k0-recovery') return 'slope-aware elastic K0 recovery';
    if(mode === 'slope-aware-elastic-k0-recovery-stress-only-reference') return 'slope-aware K0 stress-only reference';
    if(mode === 'slope-aware-elastic-k0-recovery-plastic-equilibration') return 'slope-aware K0 recovery with self-weight equilibrium';
    if(mode === 'elastic-k0-recovery-stress-only-reference') return 'elastic K0 stress-only reference';
    if(mode === 'elastic-k0-recovery-plastic-equilibration') return 'elastic K0 recovery with plastic equilibration';
    if(mode === 'gravity-ramp-zero-stress') return 'gravity ramp from zero stress';
    if(mode === 'zero-stress-plastic-equilibration') return 'gravity ramp from zero stress';
    if(mode === 'flat-k0-fallback') return 'hydrostatic K0 fallback';
    if(mode === 'plastic-geostatic') return 'plastic geostatic equilibration';
    if(mode === 'predictor') return 'stress-only predictor';
    return String(mode).replaceAll('-', ' ');
  };
  const deformationRequestedWorkflowLabel = (mode)=>{
    if(mode === 'auto') return 'Auto K0 recovery + self-weight equilibrium';
    if(mode === 'gravity-ramp') return 'gravity ramp equilibrium';
    return deformationInitialStressLabel(mode);
  };
  const deformationRequestedInitialStressMode = deformationRequestedWorkflowLabel(deformationGeostaticInitializationMethod);
  const deformationInitialStressMode = deformationInitialStressLabel(deformation.result?.solver?.initialStressMode);
  const deformationSafetyFinalization = deformation.result?.solver?.safetyResult?.finalization || null;
  const deformationSafetyStatus = stage6SafetyFinalizationStatusFromSolver(deformation.result?.solver);
  const deformationSafetyFoSLower = Number.isFinite(deformation.result?.solver?.safetyFactorOfSafetyLower)
    ? Number(deformation.result.solver.safetyFactorOfSafetyLower)
    : null;
  const deformationSafetyFoSUpper = Number.isFinite(deformationSafetyFinalization?.factorOfSafetyUpper)
    ? Number(deformationSafetyFinalization.factorOfSafetyUpper)
    : Number.isFinite(deformation.result?.solver?.safetyFactorOfSafetyUpper)
    ? Number(deformation.result.solver.safetyFactorOfSafetyUpper)
    : null;
  const deformationSafetyOpenEnded = deformationSafetyFinalization?.factorOfSafetyIsOpenEnded === true
    || deformationSafetyStatus === 'no-failure-found';
  const deformationSafetyDisplayedSigmaMsf = Number.isFinite(deformation.result?.solver?.safetyDisplayedSigmaMsf)
    ? Number(deformation.result.solver.safetyDisplayedSigmaMsf)
    : null;
  const deformationSafetyStrengthRetained = Number.isFinite(deformation.result?.solver?.safetyStrengthRetained)
    ? Number(deformation.result.solver.safetyStrengthRetained)
    : null;
  const deformationSafetyMechanism = deformation.result?.solver?.safetyResult?.mechanism
    || deformation.result?.solver?.safetyMechanism
    || null;
  const deformationInitialPhaseStatus = deformation.result?.solver?.initialPhaseStarted === true
    ? String(deformation.result?.solver?.initialPhaseConvergenceState || 'unknown')
    : 'not requested';
  const deformationServicePhaseStatus = deformation.result?.solver?.servicePhaseStarted === true
    ? String(deformation.result?.solver?.servicePhaseConvergenceState || deformation.result?.solver?.convergenceState || 'unknown')
    : (deformation.result?.solver?.initialPhaseStarted === true ? 'not started' : 'not applicable');
  const deformationGeostaticIterations = Number.isFinite(deformation.result?.solver?.geostaticIterations)
    ? deformation.result.solver.geostaticIterations
    : null;
  const deformationGeostaticResidual = Number.isFinite(deformation.result?.solver?.geostaticResidualNorm)
    ? Number(deformation.result.solver.geostaticResidualNorm).toExponential(2)
    : '—';
  const deformationSolverLabel = deformation.result?.solver?.constitutiveModel === 'mc-reduced-stiffness-material-point'
    ? 'Reduced-stiffness Mohr-Coulomb screen'
    : (deformation.result?.solver?.constitutiveModel === 'mc-plastic-material-point' || deformation.result?.solver?.constitutiveModel === 'gpu-resident-mc-plastic')
      ? (deformation.result?.solver?.analysisType === 'safety-cphi' ? 'Mohr-Coulomb plastic + c-phi reduction safety' : 'Mohr-Coulomb plastic plane strain')
      : STAGE6_ENABLE_HARDENING_SOIL_UI && deformation.result?.solver?.constitutiveModel === 'hardening-soil-material-point'
      ? (deformation.result?.solver?.analysisType === 'safety-cphi' ? 'Hardening Soil + c-phi reduction safety' : 'Hardening Soil plane strain')
      : deformation.result?.solver?.constitutiveModel === 'linear-elastic-material-point'
      ? 'Linear elastic plane strain'
      : '—';
  const deformationAcceptedSteps = Number.isFinite(deformation.result?.solver?.acceptedLoadSteps)
    ? deformation.result.solver.acceptedLoadSteps
    : null;
  const deformationRejectedSteps = Number.isFinite(deformation.result?.solver?.rejectedLoadSteps)
    ? deformation.result.solver.rejectedLoadSteps
    : null;
  const deformationCommittedLoadFactor = Number.isFinite(deformation.result?.solver?.loadFactorCommitted)
    ? deformation.result.solver.loadFactorCommitted
    : null;
  const deformationDisplayedLoadFactor = Number.isFinite(deformation.result?.solver?.displayedLoadFactor)
    ? deformation.result.solver.displayedLoadFactor
    : null;
  const deformationPeakActive = Number.isFinite(deformation.result?.solver?.peakActiveMcElements)
    ? deformation.result.solver.peakActiveMcElements
    : null;
  const deformationProfileRows = deformationHasResult
    ? (deformation.result?.terrainSettlementProfile || []).map((point, index)=>`
        <tr>
          <td>${index+1}</td>
          <td>${point.x.toFixed(2)}</td>
          <td>${point.y.toFixed(2)}</td>
          <td>${(1000 * (point.settlement || 0)).toFixed(2)}</td>
          <td>${(1000 * (point.ux || 0)).toFixed(2)}</td>
        </tr>
      `).join('')
    : '';
  const deformationWallRows = deformationHasResult
    ? (deformation.result?.wallResults || deformation.result?.retainingWallResults || []).flatMap((wall)=>(
        wall.stations || []).map((station, stationIndex)=>`
          <tr>
            <td>${Number(wall.wallIndex) + 1}</td>
            <td>${stationIndex + 1}</td>
            <td>${Number(station.s || 0).toFixed(2)}</td>
            <td>${(1000 * (Number(station.wPassive) || 0)).toFixed(2)}</td>
            <td>${(1000 * (Number(station.thetaPassive) || 0)).toFixed(3)}</td>
            <td>${Number(station.N || 0).toFixed(2)}</td>
            <td>${Number(station.VPassive || 0).toFixed(2)}</td>
            <td>${Number(station.MPassive || 0).toFixed(2)}</td>
          </tr>
        `)
      ).join('')
    : '';
	  const deformationSetupMessage = !model
	    ? 'Draw terrain and place the active CPT before running deformation.'
	    : deformationIsSafety
	      ? (
	          deformationHasSurfaceLoadRequest
	              ? `Self-weight and ${deformationActiveLoads.length} active surface load${deformationActiveLoads.length === 1 ? '' : 's'} are ready for c-phi reduction safety analysis.`
	              : 'Self-weight-only c-phi reduction safety analysis is ready.'
	        )
	      : !deformationActiveLoads.length
	        ? 'Draw or enable at least one positive surface load before running deformation.'
	        : `${deformationActiveLoads.length} active surface load${deformationActiveLoads.length === 1 ? '' : 's'} ready for deformation.`;
  const deformationStatusMessage = deformation.progress?.running
    ? (deformation.progress.message || 'Running deformation...')
    : deformationHasResult && deformation.stale
      ? (deformation.rejectReason || 'Showing the previous deformation result. Rerun to update it.')
    : deformation.status === 'success'
      ? (deformation.progress?.message || 'Deformation result ready.')
      : (deformation.rejectReason || deformationSetupMessage);
  const lineProbeOptions = stage6BishopLineProbeOptions(
    workspace,
    workspace === 'deformation' ? deformationAnalysisType : null,
    workspace === 'deformation' && STAGE6_ENABLE_HARDENING_SOIL_UI && deformation?.result?.hasHardeningSoil === true
  );
  const lineProbe = stage6BishopBuildLineProbe(workspace, measurementMetrics);
  const toolbarRunLabel = workspace === 'seepage'
    ? 'Run seepage'
    : workspace === 'deformation'
      ? (deformationIsSafety ? 'Run safety' : 'Run deformation')
      : `Run ${stage6BishopMethodModeLabel(bishop.methodMode)}`;
  const toolbarRunAction = workspace === 'seepage'
    ? 'stage6BishopRunSeepage()'
    : workspace === 'deformation'
      ? 'stage6BishopRunDeformation()'
      : 'stage6BishopRunSearch()';
  const toolbarStopAction = workspace === 'seepage'
    ? 'stage6BishopStopSeepage();renderStage6()'
    : workspace === 'deformation'
      ? 'stage6BishopStopDeformation();renderStage6()'
      : 'stage6BishopStopSearch();renderStage6()';
  const toolbarClearAction = workspace === 'seepage'
    ? "stage6BishopClear('seepageResults')"
    : workspace === 'deformation'
      ? "stage6BishopClear('deformationResults')"
      : "stage6BishopClear('results')";
  const toolbarClearLabel = workspace === 'seepage' ? 'Clear seepage' : workspace === 'deformation' ? 'Clear deformation' : 'Clear results';
  const toolbarRunReady = workspace === 'seepage' ? seepageRunReady : workspace === 'deformation' ? deformationRunReady : runReady;
  const toolbarRunning = workspace === 'seepage'
    ? !!seepage.progress?.running
    : workspace === 'deformation'
      ? !!deformation.progress?.running
      : !!bishop.progress.running;
  const toolbarHasResult = workspace === 'seepage'
    ? seepageHasResult
    : workspace === 'deformation'
      ? deformationHasResult
      : results.length > 0;
  const toolbarProgressText = workspace === 'seepage'
    ? seepageStatusMessage
    : workspace === 'deformation'
      ? deformationStatusMessage
      : (bishop.progress.running
        ? `${stage6BishopMethodModeLabel(bishop.methodMode)} · ${bishop.progress.trial||0}/${bishop.progress.total||0} Bishop trials`
        : (bishop.progress.message || stage6BishopReadyMessage(runReady)));
  const toolbarProgressPercent = workspace === 'seepage'
    ? (seepage.progress?.running ? (seepage.progress.percent || 0) : (seepage.status === 'success' ? 100 : 0))
    : workspace === 'deformation'
      ? (deformation.progress?.running ? (deformation.progress.percent || 0) : (deformation.status === 'success' ? 100 : 0))
      : (bishop.progress.percent || 0);
	  const workspaceSwitchNote = workspace==='seepage'
	    ? 'Shared canvas and geometry; seepage settings are additive.'
	    : workspace === 'deformation'
	      ? (deformationIsSafety
	        ? 'Shared canvas and geometry; the safety phase starts from a converged equilibrium state and reduces strength with fixed actions.'
	        : 'Shared canvas and geometry; deformation reuses the section mesh with its own solver settings.')
      : 'Shared canvas and geometry; Bishop/Spencer remain the default workspace.';
  const workspaceReadyHint = workspace === 'seepage'
    ? seepageSetupMessage
    : workspace === 'deformation'
      ? deformationSetupMessage
      : stage6BishopReadyMessage(runReady);
  const workspaceFocusLabel = workspace === 'seepage'
    ? 'Selected edge'
    : workspace === 'deformation'
      ? 'Load interval'
      : 'Method';
  const workspaceFocusValue = workspace === 'seepage'
    ? (selectedSeepageEdge ? stage6BishopSeepageEdgeLabel(selectedSeepageEdge) : 'none')
    : workspace === 'deformation'
      ? (loadZoneActive ? `${loadZone.xStart.toFixed(2)}-${loadZone.xEnd.toFixed(2)} m` : 'not set')
      : stage6BishopMethodModeLabel(bishop.methodMode);
  const resultRows = results.slice(0, Math.max(bishop.search.keepBest || 10, 1)).map((result, index)=>`
    <tr class="${index === (bishop.selectedResult || 0) ? 'sel':''}">
      <td>${index+1}</td>
      <td>${result.FS.toFixed(3)}</td>
      <td>${stage6BishopResultMethodLabel(result)}</td>
      <td>${Number.isFinite(result.F_bishop) ? result.F_bishop.toFixed(3) : '—'}</td>
      <td>${stage6BishopResultWallLabel(result)}</td>
      <td>${Number.isFinite(result.lambda) ? result.lambda.toFixed(3) : '—'}</td>
      <td>${result.iterations}</td>
      <td><button class="btn sm" onclick="stage6BishopSelectResult(${index})">Show</button></td>
    </tr>
  `).join('');
  const materialRows = (bishop.materials || []).map((mat, index)=>`
    <tr>
      <td><input type="text" value="${stage6EscAttr(mat.label)}" onchange="stage6BishopSetMaterialField(${index}, 'label', this.value)"></td>
      <td><input type="number" step="1" min="0" value="${Number(mat.cEff || 0).toFixed(1)}" onchange="stage6BishopSetMaterialField(${index}, 'cEff', this.value)"></td>
      <td><input type="number" step="1" min="0" value="${Number(mat.phiEffDeg || 0).toFixed(1)}" onchange="stage6BishopSetMaterialField(${index}, 'phiEffDeg', this.value)"></td>
      <td><input type="number" step="0.1" min="0" value="${Number(mat.gamma || 0).toFixed(2)}" onchange="stage6BishopSetMaterialField(${index}, 'gamma', this.value)"></td>
      <td><input type="number" step="0.1" min="0" value="${Number(mat.gammaSat || 0).toFixed(2)}" onchange="stage6BishopSetMaterialField(${index}, 'gammaSat', this.value)"></td>
    </tr>
  `).join('');
  const deformationUsesHardeningSoil = STAGE6_ENABLE_HARDENING_SOIL_UI && bishop.deformation?.options?.constitutiveModel === 'hardening-soil';
  const deformationUsesMcPlastic = bishop.deformation?.options?.constitutiveModel === 'mc-plastic';
  const deformationUsesMcConsistentTangent = bishop.deformation?.options?.useMcConsistentTangent !== false;
  const deformationMaterialRows = (bishop.materials || []).map((mat, index)=>`
    <tr>
      <td><input type="text" value="${stage6EscAttr(mat.label)}" onchange="stage6BishopSetMaterialField(${index}, 'label', this.value)"></td>
      <td><input type="number" step="100" min="100" value="${Number(mat.Emc || 0).toFixed(0)}" onchange="stage6BishopSetMaterialField(${index}, 'Emc', this.value)"></td>
      <td><input type="number" step="0.01" min="-0.49" max="0.49" value="${Number(mat.nu || 0).toFixed(2)}" onchange="stage6BishopSetMaterialField(${index}, 'nu', this.value)"></td>
      <td><input type="number" step="0.01" min="0" value="${Number(mat.K0nc || 0).toFixed(2)}" onchange="stage6BishopSetMaterialField(${index}, 'K0nc', this.value)"></td>
      <td><input type="number" step="0.01" min="0.01" max="1" value="${(Number.isFinite(Number(mat.rShear)) ? Number(mat.rShear) : 0.25).toFixed(2)}" onchange="stage6BishopSetMaterialField(${index}, 'rShear', this.value)"></td>
      <td><input type="number" step="1" min="0" value="${Number(mat.cEff || 0).toFixed(1)}" onchange="stage6BishopSetMaterialField(${index}, 'cEff', this.value)"></td>
      <td><input type="number" step="1" min="0" value="${Number(mat.phiEffDeg || 0).toFixed(1)}" onchange="stage6BishopSetMaterialField(${index}, 'phiEffDeg', this.value)"></td>
      <td><input type="number" step="1" min="0" value="${Number(mat.psiEffDeg ?? mat.psi ?? 0).toFixed(1)}" onchange="stage6BishopSetMaterialField(${index}, 'psi', this.value)"></td>
    </tr>
  `).join('');
  // ── Hardening Soil panel ────────────────────────────────────────────
  // The HS stiffness parameters (E50_ref / Eoed_ref / Eur_ref / m / ν_ur)
  // and the cohesion / friction-derived K0_nc + ψ are seeded UPSTREAM in
  // `hsParams` per CUR 2003-7 / SB260-21-6.4.10 / Schanz, Vermeer &
  // Bonnier (1999) via `importBishopMaterialsFromLayers`.  Those values
  // become the Stage 6 defaults, but — mirroring the MC panel convention
  // — the engineer may override each row per material here. Edits are
  // wired through `stage6BishopSetMaterialField`, the same handler MC
  // uses; `importBishopMaterialsFromLayers` preserves prior top-level
  // overrides on re-sync.
  //
  // The genuinely HS-specific parameters — those with NO upstream
  // analogue — live in the editable `hs` sub-table below:
  //   - R_f   (failure ratio, default 0.9)
  //   - OCR   (over-consolidation, default 1 NC)
  //   - p_ref (reference pressure, default 100 kPa)
  //   - e_init, e_max (dilatancy cutoff, default -1 = disabled)
  //   - σ3,min (explicit near-surface confinement floor, default 0 = off)
  const hsInheritedRows = (bishop.materials || []).map((mat, index)=>{
    const phi = Number(mat.phiEffDeg ?? 0);
    const k0ncInherited = Number(mat.K0nc);
    const k0ncHasValue = Number.isFinite(k0ncInherited) && k0ncInherited > 0;
    const k0ncDisplayValue = k0ncHasValue ? k0ncInherited : bishopHsJakyK0nc(phi);
    const k0ncBadge = k0ncHasValue
      ? ''
      : ' <span class="st6-help" style="font-size:0.85em">(Jaky)</span>';
    const psi = Number(mat.psi ?? 0);
    return `
      <tr>
        <td>${stage6EscAttr(mat.label)}</td>
        <td><input type="number" step="100" min="0" value="${Number(mat.E50_ref || mat.Emc || 0).toFixed(0)}" onchange="stage6BishopSetMaterialField(${index}, 'E50_ref', this.value)"></td>
        <td><input type="number" step="100" min="0" value="${Number(mat.Eoed_ref || mat.E50_ref || mat.Emc || 0).toFixed(0)}" onchange="stage6BishopSetMaterialField(${index}, 'Eoed_ref', this.value)"></td>
        <td><input type="number" step="100" min="0" value="${Number(mat.Eur_ref || 3 * (mat.E50_ref || mat.Emc || 0)).toFixed(0)}" onchange="stage6BishopSetMaterialField(${index}, 'Eur_ref', this.value)"></td>
        <td><input type="number" step="0.05" min="0" max="1" value="${Number(mat.m ?? 0.5).toFixed(2)}" onchange="stage6BishopSetMaterialField(${index}, 'm', this.value)"></td>
        <td><input type="number" step="0.01" min="0.01" max="0.49" value="${Number(mat.nu_ur ?? 0.2).toFixed(2)}" onchange="stage6BishopSetMaterialField(${index}, 'nu_ur', this.value)"></td>
        <td><input type="number" step="0.01" min="0" value="${Number(k0ncDisplayValue).toFixed(3)}" onchange="stage6BishopSetMaterialField(${index}, 'K0nc', this.value)">${k0ncBadge}</td>
        <td><input type="number" step="1" min="0" value="${Number.isFinite(psi) ? psi.toFixed(1) : '0.0'}" onchange="stage6BishopSetMaterialField(${index}, 'psi', this.value)"></td>
      </tr>
    `;
  }).join('');
  const hsEditableRows = (bishop.materials || []).map((mat, index)=>{
    const hs = mat.hs || {};
    return `
      <tr>
        <td>${stage6EscAttr(mat.label)}</td>
        <td><input type="number" step="0.01" min="0.01" max="0.999" value="${Number(hs.Rf ?? 0.9).toFixed(2)}" onchange="stage6BishopSetMaterialHsField(${index}, 'Rf', this.value)"></td>
        <td><input type="number" step="0.1" min="1" value="${Number(hs.OCR ?? 1).toFixed(2)}" onchange="stage6BishopSetMaterialHsField(${index}, 'OCR', this.value)" title="Over-consolidation ratio (1 = normally consolidated)"></td>
        <td><input type="number" step="5" min="1" value="${Number(hs.p_ref ?? 100).toFixed(1)}" onchange="stage6BishopSetMaterialHsField(${index}, 'p_ref', this.value)"></td>
        <td><input type="number" step="0.01" value="${Number(hs.e_init ?? -1).toFixed(2)}" onchange="stage6BishopSetMaterialHsField(${index}, 'e_init', this.value)" title="-1 = disabled"></td>
        <td><input type="number" step="0.01" value="${Number(hs.e_max ?? -1).toFixed(2)}" onchange="stage6BishopSetMaterialHsField(${index}, 'e_max', this.value)" title="-1 = disabled"></td>
        <td><input type="number" step="0.1" min="0" value="${Number(hs.nearSurfaceMinConfiningStress ?? 0).toFixed(2)}" onchange="stage6BishopSetMaterialHsField(${index}, 'nearSurfaceMinConfiningStress', this.value)" title="Explicit minimum compression-positive σ3' for near-surface HS stiffness/strength. 0 = off."></td>
        <td style="text-align:center"><input type="checkbox" ${hs.useConsistentTangent !== false ? 'checked' : ''} onchange="stage6BishopSetMaterialHsField(${index}, 'useConsistentTangent', this.checked ? 1 : 0)" title="Use the Simo-Hughes consistent algorithmic tangent for HS plastic loading."></td>
      </tr>
    `;
  }).join('');
  const hsDerivedRows = (bishop.materials || []).map((mat)=>{
    const phi = Number(mat.phiEffDeg ?? 0);
    const psi = Number(mat.psiEffDeg ?? mat.psi ?? 0);
    const phiCv = bishopHsRowePhiCvDeg(phi, psi);
    return `
      <tr>
        <td>${stage6EscAttr(mat.label)}</td>
        <td>${Number.isFinite(phiCv) ? phiCv.toFixed(2) + '°' : '—'}</td>
      </tr>
    `;
  }).join('');
  const hsMaterialWarnings = (bishop.materials || []).flatMap((mat)=>{
    const hs = mat.hs || {};
    const warnings = [];
    const E50 = Number(mat.E50_ref);
    const Eur = Number(mat.Eur_ref);
    const m = Number(mat.m);
    const nuUr = Number(mat.nu_ur);
    const Rf = Number(hs.Rf);
    const K0nc = Number(mat.K0nc);
    const OCR = Number(hs.OCR);
    if(Number.isFinite(E50) && Number.isFinite(Eur) && Eur < E50) warnings.push(`${mat.label}: Eur_ref (${Eur}) should be >= E50_ref (${E50}); upstream layer / stiffness method may need review.`);
    if(Number.isFinite(m) && (m < 0 || m > 1)) warnings.push(`${mat.label}: m (${m}) should stay between 0 and 1; upstream layer m override may need review.`);
    if(Number.isFinite(Rf) && (Rf < 0 || Rf >= 1)) warnings.push(`${mat.label}: Rf (${Rf}) should stay in [0, 1).`);
    if(Number.isFinite(nuUr) && (nuUr <= 0 || nuUr >= 0.5)) warnings.push(`${mat.label}: ν_ur (${nuUr}) should stay strictly between 0 and 0.5.`);
    if(Number.isFinite(OCR) && OCR < 1) warnings.push(`${mat.label}: OCR (${OCR}) should typically be >= 1; values below 1 are non-physical for in-situ soils.`);
    if(Number.isFinite(K0nc) && (K0nc < 0 || K0nc >= 1)) warnings.push(`${mat.label}: K0_nc (${K0nc}) should stay between 0 and 1; check upstream φ' value.`);
    return warnings;
  });
  const hsConsistentTangentPromptHtml = deformationUsesHardeningSoil && bishop.deformation?.options?.hsConsistentTangentPromptPending === true ? `
    <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
      This project was created before the Simo-Hughes Hardening Soil tangent selector. Existing materials stayed on the previous continuum tangent. Enable Simo-Hughes for faster plastic-regime convergence, or keep the previous tangent for exact reopening continuity.
      <div class="st6-bishop-mini-actions" style="margin-top:6px">
        <button class="btn sm" onclick="stage6BishopResolveHsConsistentTangentMigration(1)">Enable Simo-Hughes</button>
        <button class="btn sm" onclick="stage6BishopResolveHsConsistentTangentMigration(0)">Keep previous tangent</button>
      </div>
    </div>
  ` : '';
  const hsMaterialTableHtml = deformationUsesHardeningSoil ? `
    ${hsConsistentTangentPromptHtml}
    <div class="st6-help">Hardening Soil parameters. The strength (c', φ', ψ', γ, γ_sat) and stiffness (E50_ref, Eoed_ref, Eur_ref, m, ν_ur, K0_nc) blocks are inherited from the layer / material classification per CUR 2003-7 (binary stress exponent m, cohesion-corrected reference stiffness, Jaky K0_nc) and the deformation-material editor above. To change them, edit the parent layer or material in Stage 5. Only the HS-specific knobs — R_f, OCR, p_ref, e_init, e_max, the explicit near-surface σ3' floor, and the Simo-Hughes tangent selector — are editable here.</div>
    ${hsMaterialWarnings.length ? `<div class="warn">${hsMaterialWarnings.map(stage6EscAttr).join('<br>')}</div>` : ''}
    <div class="st6-help" style="margin-top:6px"><strong>Inherited from layer / material (read-only)</strong></div>
    <div style="overflow:auto">
      <table class="tbl st6-bishop-materials st6-bishop-materials--hs-inherited">
        <thead><tr><th>Layer</th><th>E50_ref (kPa)</th><th>Eoed_ref (kPa)</th><th>Eur_ref (kPa)</th><th>m</th><th>ν_ur</th><th>K0_nc</th><th>ψ</th></tr></thead>
        <tbody>${hsInheritedRows}</tbody>
      </table>
    </div>
    <div class="st6-help" style="margin-top:6px"><strong>HS-specific (editable)</strong></div>
    <div style="overflow:auto">
      <table class="tbl st6-bishop-materials st6-bishop-materials--hs-editable">
        <thead><tr><th>Layer</th><th>R_f</th><th>OCR</th><th>p_ref (kPa)</th><th>e_init (-1=off)</th><th>e_max (-1=off)</th><th>σ3,min (kPa)</th><th>SH tangent</th></tr></thead>
        <tbody>${hsEditableRows}</tbody>
      </table>
    </div>
    <details class="st6-hs-derived">
      <summary>Derived values (read-only, computed inside the constitutive update)</summary>
      <div style="overflow:auto">
        <table class="tbl st6-bishop-materials st6-bishop-materials--hs-derived">
          <thead><tr><th>Layer</th><th>φ_cv (inverse Rowe)</th></tr></thead>
          <tbody>${hsDerivedRows}</tbody>
        </table>
      </div>
    </details>
  ` : '';
  const wallRows = (bishop.walls || []).map((wall, index)=>{
    const endpoints = wallEndpoints(wall) || {
      head:{x:Number(wall.x) || 0, y:Number(wall.yTop) || 0},
      tip:{x:Number(wall.x) || 0, y:Number(wall.yTip) || 0}
    };
    const material = normalizeWallMaterial(wall.material, index, wall.id, {sourceFallback:'legacy-impermeable'});
    const preset = stage6BishopWallMaterialPresetKey(material);
    const mechanical = material.mechanical || defaultWallMechanicalMaterial('user');
    const sectionMode = mechanical.model === 'section-properties';
    const wallIdArg = stage6EscJsString(wall.id);
    return `
      <tr class="${wall.id === bishop.selectedWallId ? 'sel' : ''}">
        <td>${index + 1}</td>
        <td><input type="number" step="0.05" value="${endpoints.head.x.toFixed(2)}" onchange="stage6BishopSetWallField(${index}, 'head.x', this.value)"></td>
        <td><input type="number" step="0.05" value="${endpoints.head.y.toFixed(2)}" onchange="stage6BishopSetWallField(${index}, 'head.y', this.value)"></td>
        <td><input type="number" step="0.05" value="${endpoints.tip.x.toFixed(2)}" onchange="stage6BishopSetWallField(${index}, 'tip.x', this.value)"></td>
        <td><input type="number" step="0.05" value="${endpoints.tip.y.toFixed(2)}" onchange="stage6BishopSetWallField(${index}, 'tip.y', this.value)"></td>
        <td>
          <select onchange="stage6BishopSetWallField(${index}, 'passiveSide', this.value)">
            <option value="left"${wall.passiveSide==='left'?' selected':''}>Left</option>
            <option value="right"${wall.passiveSide==='right'?' selected':''}>Right</option>
          </select>
        </td>
        <td><label class="st6-bishop-check"><input type="checkbox" ${wall.mechanicalActive === true ? 'checked' : ''} onchange="stage6BishopSetWallField(${index}, 'mechanicalActive', this.checked)"> Active</label></td>
        <td><input type="number" step="0.01" min="0.01" max="1" style="width:58px" title="Soil-wall interface strength ratio R_inter (c_i = R*c', tan phi_i = R*tan phi'; stiffness scales with R^2 per the Plaxis convention). Blank = 0.667, the retaining module's delta/phi' active convention." value="${Number(wall.interfaceRInter) > 0 ? Number(wall.interfaceRInter).toFixed(2) : ''}" placeholder="0.667" onchange="stage6BishopSetWallField(${index}, 'interfaceRInter', this.value)"></td>
        <td>
          <select onchange="stage6BishopSetWallMaterialField(${index}, 'preset', this.value)">
            <option value="concrete-diaphragm"${preset==='concrete-diaphragm'?' selected':''}>Concrete diaphragm</option>
            <option value="steel-sheet-pile-AZ-26"${preset==='steel-sheet-pile-AZ-26'?' selected':''}>Steel sheet pile AZ 26</option>
            <option value="sheetPile"${preset==='sheetPile'?' selected':''}>Sheet pile</option>
            <option value="slurry"${preset==='slurry'?' selected':''}>Slurry wall</option>
            <option value="diaphragm"${preset==='diaphragm'?' selected':''}>Diaphragm</option>
            <option value="soilMix"${preset==='soilMix'?' selected':''}>Soil-mix</option>
            <option value="relief"${preset==='relief'?' selected':''}>Relief</option>
            <option value="legacy"${preset==='legacy'?' selected':''}>Legacy</option>
            <option value="custom"${preset==='custom'?' selected':''} disabled>Custom</option>
          </select>
        </td>
        <td>
          <select onchange="stage6BishopSetWallMaterialField(${index}, 'mechanical.model', this.value)">
            <option value="rectangular"${!sectionMode?' selected':''}>Rectangular</option>
            <option value="section-properties"${sectionMode?' selected':''}>Section props</option>
          </select>
        </td>
        <td><input type="number" step="${sectionMode ? '1000' : '100000'}" min="0" value="${Number(sectionMode ? mechanical.EA : mechanical.E).toPrecision(6)}" onchange="stage6BishopSetWallMaterialField(${index}, '${sectionMode ? 'mechanical.EA' : 'mechanical.E'}', this.value)"></td>
        <td><input type="number" step="${sectionMode ? '100' : '0.05'}" min="0" value="${Number(sectionMode ? mechanical.EI : mechanical.thickness).toPrecision(6)}" onchange="stage6BishopSetWallMaterialField(${index}, '${sectionMode ? 'mechanical.EI' : 'mechanical.thickness'}', this.value)"></td>
        <td><input type="number" step="${sectionMode ? '1000' : '0.01'}" min="0" value="${Number(sectionMode ? mechanical.GA : mechanical.nu).toPrecision(6)}" onchange="stage6BishopSetWallMaterialField(${index}, '${sectionMode ? 'mechanical.GA' : 'mechanical.nu'}', this.value)"></td>
        <td><input type="number" step="0.01" min="0.01" max="1" value="${Number(mechanical.kappa || 1).toFixed(3)}" onchange="stage6BishopSetWallMaterialField(${index}, 'mechanical.kappa', this.value)"></td>
        <td><input type="number" step="1e-10" min="1e-20" value="${Number(material.kAcross).toExponential(2)}" onchange="stage6BishopSetWallMaterialField(${index}, 'kAcross', this.value)"></td>
        <td><input type="number" step="1e-10" min="1e-20" value="${Number(material.kAlong).toExponential(2)}" onchange="stage6BishopSetWallMaterialField(${index}, 'kAlong', this.value)"></td>
        <td><span class="st6-bishop-source-pill st6-bishop-source-pill--${stage6EscAttr(material.kSource || 'preset')}">${stage6EscAttr(wallMaterialSourceLabel(material.kSource))}</span></td>
        <td>${wallLength(wall).toFixed(2)} m</td>
        <td><button class="btn sm" onclick="stage6BishopSelectWall(${wallIdArg})">Select</button> <button class="btn sm" onclick="stage6BishopDeleteWall(${index})">Delete</button></td>
      </tr>
    `;
  }).join('');
  const permeabilityRows = (bishop.materials || []).map((mat, index)=>`
    <tr>
      <td>${stage6EscAttr(mat.label)}</td>
      <td><input type="number" step="1e-7" min="1e-12" value="${Number(mat.kx || 0).toExponential(2)}" onchange="stage6BishopSetMaterialPermeability(${index}, 'kx', this.value)"></td>
      <td><input type="number" step="1e-7" min="1e-12" value="${Number(mat.ky || 0).toExponential(2)}" onchange="stage6BishopSetMaterialPermeability(${index}, 'ky', this.value)"></td>
      <td><span class="st6-bishop-source-pill st6-bishop-source-pill--${stage6EscAttr(mat.kSource || 'sbtn-default')}">${stage6EscAttr(seepageSourceLabel(mat.kSource))}</span></td>
      <td><button class="btn sm" onclick="stage6BishopResetMaterialPermeability(${index})">Reset auto</button></td>
    </tr>
  `).join('');
  const seepageBcRows = seepageActiveBcs.map((bc)=>{
    const edge = seepageBoundary.find((item)=>item.edgeKey === bc.edgeKey);
    return `
      <tr class="${selectedSeepageEdge?.edgeKey === bc.edgeKey ? 'sel' : ''}">
        <td>${stage6EscAttr(stage6BishopSeepageEdgeLabel(edge || {source:bc.anchor?.source, index:0}))}</td>
        <td>${stage6EscAttr(stage6BishopSeepageBcTypeLabel(bc.type))}</td>
        <td>${bc.type === 'head' && Number.isFinite(bc.head) ? `${bc.head.toFixed(2)} m` : '—'}</td>
        <td>${bc.status}</td>
        <td><button class="btn sm" onclick="stage6BishopSelectSeepageBoundary('${stage6EscAttr(bc.edgeKey)}')">Select</button></td>
      </tr>
    `;
  }).join('');
  const drainValidation = seepage.drainValidation || {errors:[], warnings:[]};
  const drainRows = (bishop.drains || []).map((drain, index)=>{
    const headValue = drainHeadValueAt(drain, 0);
    const length = drainTotalLength(drain);
    return `
      <tr class="${drain.id === bishop.selectedDrainId ? 'sel' : ''}">
        <td><input type="text" value="${stage6EscAttr(drain.label || `Drain ${index + 1}`)}" onchange="stage6BishopSetDrainField(${index}, 'label', this.value)"></td>
        <td>${(drain.vertices || []).length}</td>
        <td><input type="number" step="0.05" value="${Number(headValue || 0).toFixed(2)}" onchange="stage6BishopSetDrainField(${index}, 'head', this.value)"></td>
        <td>
          <select onchange="stage6BishopSetDrainField(${index}, 'gating', this.value)">
            <option value="always"${drain.gating==='always'?' selected':''}>Always</option>
            <option value="when-saturated"${drain.gating==='when-saturated'?' selected':''}>When saturated</option>
            <option value="head-cap"${drain.gating==='head-cap'?' selected':''}>Head cap</option>
          </select>
        </td>
        <td>${Number(length || 0).toFixed(2)} m</td>
        <td><button class="btn sm" onclick="stage6BishopSelectDrain('${stage6EscAttr(drain.id)}')">Select</button></td>
        <td><button class="btn sm" onclick="stage6BishopDeleteDrain(${index})">Delete</button></td>
      </tr>
    `;
  }).join('');
  const drainResultRows = (seepage.result?.drains || []).map((drain)=>{
    const nodeCount = drain.nodes?.length || 0;
    const activeCount = (drain.nodes || []).filter((node)=>node?.isActive).length;
    const inflow = Number(drain.totalInflow || 0);
    const reactionInflow = (drain.nodes || []).reduce((sum, node)=>sum + Math.max(-(Number(node?.reaction) || 0), 0), 0);
    return `
      <tr>
        <td>${stage6EscAttr(drain.label || drain.drainId || 'Drain')}</td>
        <td>${stage6EscAttr(stage6BishopDrainGatingLabel(drain.gating))}</td>
        <td>${inflow.toExponential(2)}</td>
        <td>${reactionInflow.toExponential(2)}</td>
        <td>${activeCount} / ${nodeCount}</td>
      </tr>
    `;
  }).join('');
  const seepageDrainInflow = Number(seepage.result?.solver?.boundaryFlux?.drainInflow || 0);
  const seepageDrainOutflow = Number(seepage.result?.solver?.boundaryFlux?.drainOutflow || 0);
  const seepageDrainNodeSummary = seepage.result?.solver?.activeSetSummary?.drains || null;
  const drainValidationHtml = [
    ...(drainValidation.errors || []).map((issue)=>({level:'warn', text:issue.message})),
    ...(drainValidation.warnings || []).map((issue)=>({level:'info', text:issue.message}))
  ];
  const regionLegendItems = stage6BishopRegionLegendItems({regions:stage6BishopDisplayRegions(model)});
  const lineProbeSelectionPath = workspace === 'seepage' ? 'lineProbe.seepageQuantity' : 'lineProbe.deformationQuantity';
  const lineProbeCopyToneColor = bishop.lineProbe?.copyTone === 'ok' ? 'var(--ok-text)' : bishop.lineProbe?.copyTone === 'warn' ? 'var(--wn)' : 'var(--tx2)';
  const analysisTab = bishop.analysisTab === 'structure' ? 'structure' : 'line-probe';
  const analysisWallId = stage6BishopAnalysisWallId();
  const analysisWall = (bishop.walls || []).find((wall)=>wall.id === analysisWallId) || null;
  const analysisWallIndex = analysisWall ? (bishop.walls || []).findIndex((wall)=>wall.id === analysisWall.id) : -1;
  const analysisWallResult = analysisWall ? stage6BishopWallResultForId(analysisWall.id) : null;
  const analysisWallSeries = analysisWallResult ? stage6BishopWallResultSeries(analysisWallResult) : null;
  // Workstream C3(b): partial-load badge for the Structure tab (empty on converged).
  const analysisWallPartialBadge = analysisWallResult
    ? stage6BishopPartialLoadBadgeHtml(deformation.result?.solver)
    : '';
  const analysisWallOptionHtml = (bishop.walls || []).map((wall, index)=>`
    <option value="${stage6EscAttr(wall.id)}"${wall.id===analysisWallId?' selected':''}>Wall ${index + 1}${wall.mechanicalActive === true ? '' : ' (inactive)'}</option>
  `).join('');
  const wallStats = (meta)=>{
    const stats = analysisWallResult ? stage6BishopWallQuantityStats(analysisWallResult, meta.id) : null;
    return stats ? `${stage6BishopWallQuantityFormat(stats.min, meta)} to ${stage6BishopWallQuantityFormat(stats.max, meta)}` : '—';
  };
  const wallChartsHtml = analysisWallResult ? STAGE6_WALL_RESPONSE_QUANTITIES.map((meta)=>`
    <div class="st6-wall-chart-row">
      <canvas id="stage6WallChart-${stage6EscAttr(meta.id)}" width="360" height="126" aria-label="${stage6EscAttr(meta.axisTitle)}"></canvas>
      <div class="st6-canvas-card-note"><strong>${stage6EscAttr(meta.axisTitle)}</strong><br>Range ${stage6EscAttr(wallStats(meta))}</div>
    </div>
  `).join('') : '';
  const wallCopyMessage = bishop.deformation?.wallCopyMessage || '';
  const seepageContourMode = bishop.seepage?.display?.contourMode || 'head';
  const seepageContourOptions = stage6BishopSeepageContourOptions();
  const seepageContourDerived = workspace === 'seepage' && seepage.mesh && seepage.result
    ? stage6BishopSeepageContourDerived(seepage.result, seepage.mesh, seepageContourMode)
    : null;
  const seepageContourLegendMeta = stage6BishopSeepageContourMeta(seepageContourMode);
  const seepageContourLegendTicks = seepageContourDerived
    ? stage6BishopSeepageContourLegendTicks(seepageContourMode, seepageContourDerived.stats)
    : [];
  const deformationContourMode = bishop.deformation?.display?.contourMode || 'uTotal';
  const deformationContourHasHs = STAGE6_ENABLE_HARDENING_SOIL_UI && bishop.deformation?.result?.hasHardeningSoil === true;
  const deformationContourOptions = stage6BishopDeformationContourOptions(deformationAnalysisType, deformationContourHasHs);
  const deformationDisplacementVectorReady = stage6BishopDeformationVectorMode(deformationContourMode);
  const deformationDisplacementVectorAvailable = deformationDisplacementVectorReady && bishop.deformation?.display?.showContourLines !== false;
  const deformationShowWallOverlay = bishop.deformation?.display?.showWallMomentOverlay === true;
  const wallOverlayQuantity = stage6BishopWallOverlayQuantity();
  const wallOverlayStats = stage6BishopWallQuantityStats(
    stage6BishopWallResultForId(stage6BishopAnalysisWallId()),
    wallOverlayQuantity
  );
  const wallOverlayStatsLabel = wallOverlayStats
    ? `min ${stage6BishopWallQuantityFormat(wallOverlayStats.min, wallOverlayStats.meta)} · max ${stage6BishopWallQuantityFormat(wallOverlayStats.max, wallOverlayStats.meta)}`
    : 'Run deformation and hover a wall to inspect min/max.';
  const deformationContourDerived = workspace === 'deformation' && deformation.mesh && deformation.result
    ? stage6BishopDeformationContourDerived(deformation.result, deformation.mesh, deformationContourMode)
    : null;
  const deformationContourLegendMeta = stage6BishopDeformationContourMeta(deformationContourMode, deformationAnalysisType);
  const deformationContourLegendTicks = deformationContourDerived
    ? stage6BishopDeformationContourLegendTicks(deformationContourMode, deformationContourDerived.stats, deformationAnalysisType)
    : [];
  const deformationShowContours = bishop.deformation?.display?.showContours !== false;
  const deformationShowContourLines = bishop.deformation?.display?.showContourLines !== false;
  const deformationShowContourLegend = bishop.deformation?.display?.showContourLegend !== false;
  const deformationShowDeformedMesh = bishop.deformation?.display?.showDeformedMesh !== false;
  const deformationShowUndeformedMesh = !!bishop.deformation?.display?.showUndeformedMesh;
  const deformationShowPlasticPoints = bishop.deformation?.display?.showPlasticPoints !== false;
  const deformationShowDirectionVectors = !!bishop.deformation?.display?.showDisplacementVectors;
  const seepageShowContours = bishop.seepage?.display?.showContours !== false;
  const seepageShowContourLines = bishop.seepage?.display?.showContourLines !== false;
  const seepageShowContourLegend = bishop.seepage?.display?.showContourLegend !== false;
  const seepageShowBoundaryConditions = bishop.seepage?.display?.showBoundaryConditions !== false;
  const seepageShowBoundaryLabels = bishop.seepage?.display?.showBoundaryLabels !== false;
  const seepageShowPhreatic = bishop.seepage?.display?.showPhreatic !== false;
  const seepageShowDrains = bishop.seepage?.display?.showDrains !== false;
  const seepageShowFlowVectors = !!bishop.seepage?.display?.showFlowVectors;
  const seepageShowExitGradient = !!bishop.seepage?.display?.showExitGradient;
  return {
    bishop,
    bishopUi,
    model,
    modeMeta,
    selected,
    results,
    summary,
    wallSummary,
    surfaceLoads,
    selectedSurfaceLoad,
    primarySurfaceLoad,
    workspace,
    activeSurfaceLoads,
    loadZone,
    loadZoneActive,
    loadQ,
    totalActiveLoadKnPerM,
    wallCount,
    hasWalls,
    loadSummary,
    runReady,
    showSpencerSliceCols,
    showWallSliceCol,
    selectedNormalHeader,
    selectedMethodLabel,
    selectedWallLabel,
    selectedCustomRegion,
    customRegionCount,
    customModeActive,
    showingCustomRegionPreview,
    measurementPoints,
    measurementMetrics,
    measurementStatus,
    settingsCollapsed,
    settingsWide,
    seepage,
    deformation,
    seepageBoundary,
    selectedSeepageEdge,
    selectedSeepageBc,
    seepageActiveBcs,
    seepageOrphanedBcs,
    seepageHeadCount,
    seepageMeshTargetAreaAuto,
    seepageAutoMeshTargetArea,
    seepageMeshTargetArea,
    seepageUsesIterativeFreeSurface,
    seepagePhreaticReady,
    seepageRunReady,
    seepageHasResult,
    seepageStatusLabel,
    seepageSetupMessage,
    seepageStatusMessage,
    deformationAnalysisType,
    deformationIsSafety,
    deformationLoadMode,
    deformationMeshTargetAreaAuto,
    deformationAutoMeshTargetArea,
    deformationMeshTargetArea,
    deformationMeshElementType,
    deformationMeshElementLabel,
    deformationNonlinearMaxIterations,
    deformationInitialLoadStep,
    deformationMinLoadStep,
    deformationMaxLoadSteps,
    deformationResidualRelTol,
    deformationResidualAbsTol,
    deformationDisplacementRelTol,
    deformationDisplacementAbsTol,
    deformationLoadStepGrowthFactor,
    deformationLoadStepCutbackFactor,
    deformationPlasticLoadStepGrowthFactor,
    deformationPlasticLoadStepCutbackFactor,
    deformationGeostaticInitializationMethod,
    deformationGeostaticCorrectionStages,
    deformationSafetyInitialSigmaMsfIncrement,
    deformationSafetySigmaMsfGrowthFactor,
    deformationSafetySigmaMsfMax,
    deformationSafetySigmaMsfBracketTolerance,
    deformationSafetyMaxSearchTrials,
    deformationUseUnsymmetricPlasticSolver,
    deformationUseWasmCpuPipeline,
    deformationSolverBackend,
    deformationOutOfPlaneLength,
    deformationActiveLoads,
    deformationWidth,
    deformationTotalLoadValue,
    deformationTotalLoad,
    deformationDerivedQ,
    deformationHasSurfaceLoadRequest,
    deformationRunReady,
    deformationHasResult,
    deformationStatusLabel,
    deformationAppliedQ,
    deformationWarnings,
    deformationInitialStressLabel,
    deformationRequestedWorkflowLabel,
    deformationRequestedInitialStressMode,
    deformationInitialStressMode,
    deformationSafetyFinalization,
    deformationSafetyStatus,
    deformationSafetyFoSLower,
    deformationSafetyFoSUpper,
    deformationSafetyOpenEnded,
    deformationSafetyDisplayedSigmaMsf,
    deformationSafetyStrengthRetained,
    deformationSafetyMechanism,
    deformationInitialPhaseStatus,
    deformationServicePhaseStatus,
    deformationGeostaticIterations,
    deformationGeostaticResidual,
    deformationSolverLabel,
    deformationAcceptedSteps,
    deformationRejectedSteps,
    deformationCommittedLoadFactor,
    deformationDisplayedLoadFactor,
    deformationPeakActive,
    deformationProfileRows,
    deformationWallRows,
    deformationSetupMessage,
    deformationStatusMessage,
    lineProbeOptions,
    lineProbe,
    toolbarRunLabel,
    toolbarRunAction,
    toolbarStopAction,
    toolbarClearAction,
    toolbarClearLabel,
    toolbarRunReady,
    toolbarRunning,
    toolbarHasResult,
    toolbarProgressText,
    toolbarProgressPercent,
    workspaceSwitchNote,
    workspaceReadyHint,
    workspaceFocusLabel,
    workspaceFocusValue,
    resultRows,
    materialRows,
    deformationUsesHardeningSoil,
    deformationUsesMcPlastic,
    deformationUsesMcConsistentTangent,
    deformationMaterialRows,
    hsInheritedRows,
    hsEditableRows,
    hsDerivedRows,
    hsMaterialWarnings,
    hsConsistentTangentPromptHtml,
    hsMaterialTableHtml,
    wallRows,
    permeabilityRows,
    seepageBcRows,
    drainValidation,
    drainRows,
    drainResultRows,
    seepageDrainInflow,
    seepageDrainOutflow,
    seepageDrainNodeSummary,
    drainValidationHtml,
    regionLegendItems,
    lineProbeSelectionPath,
    lineProbeCopyToneColor,
    analysisTab,
    analysisWallId,
    analysisWall,
    analysisWallIndex,
    analysisWallResult,
    analysisWallSeries,
    analysisWallPartialBadge,
    analysisWallOptionHtml,
    wallStats,
    wallChartsHtml,
    wallCopyMessage,
    seepageContourMode,
    seepageContourOptions,
    seepageContourDerived,
    seepageContourLegendMeta,
    seepageContourLegendTicks,
    deformationContourMode,
    deformationContourHasHs,
    deformationContourOptions,
    deformationDisplacementVectorReady,
    deformationDisplacementVectorAvailable,
    deformationShowWallOverlay,
    wallOverlayQuantity,
    wallOverlayStats,
    wallOverlayStatsLabel,
    deformationContourDerived,
    deformationContourLegendMeta,
    deformationContourLegendTicks,
    deformationShowContours,
    deformationShowContourLines,
    deformationShowContourLegend,
    deformationShowDeformedMesh,
    deformationShowUndeformedMesh,
    deformationShowPlasticPoints,
    deformationShowDirectionVectors,
    seepageShowContours,
    seepageShowContourLines,
    seepageShowContourLegend,
    seepageShowBoundaryConditions,
    seepageShowBoundaryLabels,
    seepageShowPhreatic,
    seepageShowDrains,
    seepageShowFlowVectors,
    seepageShowExitGradient
  };
}
