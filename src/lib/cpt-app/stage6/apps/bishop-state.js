// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/apps/bishop-state.js — state schema of the Seep / Slope ("bishop") app, moved verbatim
// out of legacy-controller.js (line numbers at integration-r):
//   defaults()                         the `bishop` block of stage6Defaults()            2367-2625
//   ensure(stage6, env)                the bishop schema migration of ensureStage6State()  2755-3118
//   sortedPolyline                     stage6BishopSortedPolyline                          3359-3369
//   seepageDomainArea, auto/resolved{Seepage,Deformation}MeshTargetArea
//                                      the mesh target-area helpers                        2664-2721
// This is a holding place until the seepslope package (refactor step 9a) takes the state over;
// nothing here is redesigned. The migration reads the host through `env`:
//   env.rawMaxDepth            stage6MaxDepth() — bottom of the last layer (10 without layers)
//   env.hardeningSoilUi        STAGE6_ENABLE_HARDENING_SOIL_UI
//   env.deformationQuantityIds stage6BishopDeformationQuantityIds(analysisType, hasHs)
//   env.migrateSurfaceLoadsShape stage6BishopMigrateSurfaceLoadsShape(bishop)
import { terrainY as bishopTerrainY } from '../../stage6-bishop.js';
import { polygonArea } from '../../soil-regions.js';
import { merge } from '../merge.js';

export function defaults(){
  return {
    schemaVersion:3,
    history:[],
    workspace:'stability',
    tool:'terrain',
    useFemPorePressure:false,
    strengthSet:'characteristic',
    methodMode:'bishop_spencer',
    useCustomRegions:false,
    customRegions:[],
    selectedRegionId:null,
    regionDraftMaterialId:null,
    measurement:{
      points:[]
    },
    lineProbe:{
      sampleCount:81,
      seepageQuantity:'head',
      deformationQuantity:'uTotal',
      copyMessage:'',
      copyTone:''
    },
    analysisTab:'line-probe',
    display:{
      showRegions:true,
      showRegionLabels:true,
      showRegionLegend:true,
      regionOpacity:0.22
    },
    terrain:[],
    phreatic:[],
    walls:[],
    selectedWallId:null,
    drains:[],
    selectedDrainId:'',
    draft:[],
    draftKind:'',
    activeCptX:null,
    cptInsertionOffset:0,
    entryZone:null,
    exitZone:null,
	      surfaceLoad:{
	        xStart:null,
	        xEnd:null,
	        q:0
	      },
	      surfaceLoads:[],
	      selectedSurfaceLoadId:null,
    viewport:{
      scale:24,
      offsetX:80,
      offsetY:360,
      fitted:false
    },
    gridSnap:true,
    pointSnap:false,
    snapSize:0.50,
    analysisDepth:15.00,
    materials:[],
    sourceLayerSignature:'',
    search:{
      nEntry:10,
      nExit:10,
      nCenter:15,
      centerOffsetMin:0.50,
      centerOffsetMax:3.00,
      minChordLength:2.00,
      minSlipThickness:0.75,
      maxExitAngleDeg:45,
      validationSamples:30,
      geomTol:0.001,
      minSliceWidth:0.05,
      targetSlices:30,
      keepBest:10
    },
    solver:{
      useOrdinarySeed:true,
      initialFS:1.00,
      tolerance:0.0001,
      maxIterations:50,
      minMAlpha:0.000001
    },
    spencer:{
      recheckCount:10,
      lambdaLow:-0.60,
      lambdaHigh:0.60,
      lambdaTolerance:0.001,
      momentTolerance:0.001,
      forceTolerance:0.001,
      FBracketLow:0.10,
      FBracketHigh:10.00,
      maxOuterIter:20,
      maxInnerIter:30,
      useNewton:false,
      initialF:null,
      initialLambda:0.00,
      fallbackBishop:true
    },
    progress:{
      running:false,
      percent:0,
      trial:0,
      total:0,
      message:'',
      previewCircle:null
    },
    seepage:{
      bcs:[],
      mesh:null,
      result:null,
      stale:false,
      status:'idle',
      progress:{
        running:false,
        percent:0,
        message:'',
        runId:0
      },
      rejectReason:'',
      drainValidation:{
        errors:[],
        warnings:[]
      },
      geometryHash:'',
      options:{
        freeSurface:'iterate',
        usePhreaticAsSeed:true,
        flowErrorTolerance:0.01,
        maxRuntimeMs:10000,
        meshTargetArea:null,
        meshTargetAreaAuto:true,
        drains:{
          gatingTolerances:{},
          reportPerSegmentInflow:true
        }
      },
      display:{
        showBoundaryConditions:true,
        showBoundaryLabels:true,
        contourMode:'head',
        showContours:true,
        showContourLines:true,
        showContourLegend:true,
        showPhreatic:true,
        showDrains:true,
        showHead:false,
        showEquipotentials:false,
        showFlowVectors:false,
        showExitGradient:false
      },
      lastAppliedBcType:'',
      lastAppliedBcHead:null,
      selectedEdgeKey:'',
      selectedBcId:''
    },
    deformation:{
      mesh:null,
      result:null,
      stale:false,
      status:'idle',
      rejectReason:'',
      warnings:[],
      progress:{
        running:false,
        percent:0,
        message:'',
        runId:0
      },
      options:{
        analysisType:'deformation',
        loadMode:'pressure',
        constitutiveModel:'mc-plastic',
        initialStressMode:'plastic-geostatic',
        totalLoad:null,
        outOfPlaneLength:10,
        meshElementType:'t6',
        meshTargetArea:null,
        meshTargetAreaAuto:true,
        useSeepagePorePressures:false,
        displacementScale:1,
        nonlinearMaxIterations:32,
        initialLoadStep:0.25,
        minLoadStep:1/4096,
        maxLoadSteps:384,
        residualRelTol:1e-4,
        residualAbsTol:1e-3,
        displacementRelTol:1e-4,
        displacementAbsTol:1e-6,
        loadStepGrowthFactor:1.25,
        loadStepCutbackFactor:0.5,
        plasticLoadStepGrowthFactor:1.08,
        plasticLoadStepCutbackFactor:0.4,
        plasticLineSearchMaxBacktracks:6,
        geostaticInitializationMethod:'auto',
        geostaticStressOnlyResidualTolerance:0.05,
        useStagedGeostaticInit:true,
        // Staged construction (model C): for a retaining wall, hold the in-situ
        // K0 state supported, then relax the cut-face support in a wall-active
        // excavation phase so the wall carries the cut. ON by default — it is
        // the physically-correct model and only engages for MC + a wall (inert
        // otherwise). Toggle off for the legacy wall-free geostatic.
        useStagedExcavation:true,
        // Phase 2: zero-thickness Coulomb soil-wall interface (gap + slip),
        // the staged path's companion. ON by default — it is the mechanism
        // that releases the crest tension band (deep cohesionless cuts reach
        // 100% load) and it only engages for MC + wall + staged construction.
        // Single-sided in this phase (documented in the result assumptions).
        useWallInterface:true,
        allowStressOnlyGeostaticReference:false,
        stressOnlyGeostaticMaxEta:1.0,
        geostaticCorrectionStages:1,
        initialGravityTangentSchedule:['plastic'],
        initialGravityElasticGlobalizationIterations:4,
        elasticGlobalizationArmijoC1:1e-3,
        elasticGlobalizationMinResidualRatio:0.90,
        geostaticMinLoadStep:5e-4,
        geostaticMaxRepeatedBand:3,
        geostaticProgressFailFast:false,
        geostaticProgressFailFastSteps:6,
        geostaticProgressFailFastLoadFactor:0.50,
        geostaticProgressFailFastPlasticFraction:0.15,
        serviceProgressFailFast:false,
        serviceProgressFailFastSteps:16,
        serviceProgressFailFastLoadFactor:0.20,
        serviceProgressFailFastPlasticFraction:0.35,
        preconditionerLevel:'jacobi',
        safetyInitialSigmaMsfIncrement:0.10,
        safetySigmaMsfGrowthFactor:1.50,
        safetySigmaMsfMax:3.00,
        safetySigmaMsfBracketTolerance:0.01,
        safetyMaxSearchTrials:32,
        safetyFinalizationMode:'production-msf',
        useUnsymmetricPlasticSolver:true,
        useMcConsistentTangent:true,
        hsConsistentTangentPromptPending:false,
        hsConsistentTangentMigrationResolved:false
      },
      display:{
        contourMode:'uTotal',
        showContours:true,
        showContourLines:true,
        showContourLegend:true,
        showDisplacementVectors:false,
        showDeformedMesh:false,
        showUndeformedMesh:false,
        showLoadVectors:true,
        showPlasticPoints:true,
        showWallMomentOverlay:false
      }
    },
    results:null,
    selectedResult:0,
    stale:true,
    capturedView:{
      stability:null,
      seepage:null,
      deformation:null
    }
  };
}

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

export function autoSeepageMeshTargetArea(bishop){
  const domainArea = seepageDomainArea(bishop);
  if(!(domainArea > 0)) return 0.05;
  return +Math.min(Math.max(domainArea / 3500, 0.05), 1.5).toFixed(3);
}

export function resolvedSeepageMeshTargetArea(bishop){
  const options = bishop?.seepage?.options || {};
  const autoArea = autoSeepageMeshTargetArea(bishop);
  if(options.meshTargetAreaAuto !== false) return autoArea;
  const manualArea = Number(options.meshTargetArea);
  return Math.max(Number.isFinite(manualArea) && manualArea > 0 ? manualArea : autoArea, 0.01);
}

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

export function resolvedDeformationMeshTargetArea(bishop){
  const options = bishop?.deformation?.options || {};
  const autoArea = autoDeformationMeshTargetArea(bishop);
  if(options.meshTargetAreaAuto !== false) return autoArea;
  const manualArea = Number(options.meshTargetArea);
  return Math.max(Number.isFinite(manualArea) && manualArea > 0 ? manualArea : autoArea, 0.01);
}

/** The bishop schema migration (schemaVersion → 3, measurement, line probe, search/solver/spencer
 *  clamps, seepage and deformation options and display, surface loads, viewport, strength set). */
export function ensure(stage6, env){
  const bishop = stage6.bishop;
  const bishopSchemaVersionBeforeSync = Math.round(+bishop.schemaVersion || 0);
  const hsConsistentTangentLegacySchema = bishopSchemaVersionBeforeSync < 3;
  bishop.schemaVersion = Math.max(bishopSchemaVersionBeforeSync, 3);
  if(!Array.isArray(bishop.history)) bishop.history = [];
  const bishopMinDepth = Math.max(env.rawMaxDepth, 15);
  if(!['stability','seepage','deformation'].includes(bishop.workspace)) bishop.workspace = 'stability';
  bishop.useFemPorePressure = !!bishop.useFemPorePressure;
  if(!bishop.measurement || typeof bishop.measurement !== 'object') bishop.measurement = {points:[]};
  if(!Array.isArray(bishop.measurement.points)) bishop.measurement.points = [];
  bishop.measurement.points = bishop.measurement.points
    .filter((pt)=>Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    .slice(0, 2)
    .map((pt)=>({x:+pt.x, y:+pt.y}));
  if(!bishop.lineProbe || typeof bishop.lineProbe !== 'object') bishop.lineProbe = defaults().lineProbe;
  bishop.lineProbe.sampleCount = Math.min(Math.max(Math.round(+bishop.lineProbe.sampleCount || 81), 21), 201);
  if(!['head','porePressure','gradient','hydraulicFs','flow','qx','qy','normalFlow'].includes(bishop.lineProbe.seepageQuantity)){
    bishop.lineProbe.seepageQuantity = 'head';
  }
  if(!env.deformationQuantityIds(
    bishop.deformation?.options?.analysisType,
    env.hardeningSoilUi && bishop.deformation?.result?.hasHardeningSoil === true
  ).includes(bishop.lineProbe.deformationQuantity)){
    bishop.lineProbe.deformationQuantity = 'uTotal';
  }
  bishop.lineProbe.copyMessage = typeof bishop.lineProbe.copyMessage === 'string' ? bishop.lineProbe.copyMessage : '';
  bishop.lineProbe.copyTone = bishop.lineProbe.copyTone === 'warn' ? 'warn' : bishop.lineProbe.copyTone === 'ok' ? 'ok' : '';
  if(bishop.analysisDepth == null || bishop.analysisDepth === ''){
    const legacyBottomMargin = Number(bishop.bottomMargin);
    const hasCustomLegacyMargin = Number.isFinite(legacyBottomMargin) && Math.abs(legacyBottomMargin - 5) > 1e-9;
    bishop.analysisDepth = hasCustomLegacyMargin
      ? env.rawMaxDepth + legacyBottomMargin
      : bishopMinDepth;
  }
  bishop.analysisDepth = Math.max(+bishop.analysisDepth || bishopMinDepth, bishopMinDepth);
  bishop.cptInsertionOffset = Number.isFinite(+bishop.cptInsertionOffset)
    ? Math.max(Math.min(+bishop.cptInsertionOffset, 100), -100)
    : 0;
  bishop.snapSize = Math.max(+bishop.snapSize || 0.5, 0.05);
  bishop.pointSnap = !!bishop.pointSnap;
  if(!bishop.display || typeof bishop.display !== 'object') bishop.display = defaults().display;
  bishop.display.showRegions = bishop.display.showRegions !== false;
  bishop.display.showRegionLabels = bishop.display.showRegionLabels !== false;
  bishop.display.showRegionLegend = bishop.display.showRegionLegend !== false;
  bishop.display.regionOpacity = Math.min(Math.max(+bishop.display.regionOpacity || 0.22, 0.05), 0.75);
  bishop.search.nEntry = Math.max(2, Math.round(+bishop.search.nEntry || 10));
  bishop.search.nExit = Math.max(2, Math.round(+bishop.search.nExit || 10));
  bishop.search.nCenter = Math.max(2, Math.round(+bishop.search.nCenter || 15));
  bishop.search.centerOffsetMin = Math.max(+bishop.search.centerOffsetMin || 0.5, 0.05);
  bishop.search.centerOffsetMax = Math.max(+bishop.search.centerOffsetMax || 3, bishop.search.centerOffsetMin + 0.05);
  bishop.search.minChordLength = Math.max(+bishop.search.minChordLength || 2, 0.5);
  bishop.search.minSlipThickness = Math.max(+bishop.search.minSlipThickness || 0.75, 0.1);
  bishop.search.maxExitAngleDeg = Math.min(Math.max(+bishop.search.maxExitAngleDeg || 45, 5), 89);
  bishop.search.validationSamples = Math.max(8, Math.round(+bishop.search.validationSamples || 30));
  bishop.search.geomTol = Math.max(+bishop.search.geomTol || 0.001, 0.000001);
  bishop.search.minSliceWidth = Math.max(+bishop.search.minSliceWidth || 0.05, 0.01);
  bishop.search.targetSlices = Math.max(6, Math.round(+bishop.search.targetSlices || 30));
  bishop.search.keepBest = Math.max(1, Math.round(+bishop.search.keepBest || 10));
  if(!['bishop_only','bishop_spencer'].includes(bishop.methodMode)) bishop.methodMode = 'bishop_spencer';
  bishop.solver.initialFS = Math.max(+bishop.solver.initialFS || 1, 0.1);
  bishop.solver.tolerance = Math.max(+bishop.solver.tolerance || 0.0001, 0.000001);
  bishop.solver.maxIterations = Math.max(5, Math.round(+bishop.solver.maxIterations || 50));
  bishop.solver.minMAlpha = Math.max(+bishop.solver.minMAlpha || 0.000001, 0.000000001);
  if(!bishop.spencer || typeof bishop.spencer !== 'object') bishop.spencer = {};
  bishop.spencer.recheckCount = Math.max(1, Math.min(Math.round(+bishop.spencer.recheckCount || 10), bishop.search.keepBest));
  bishop.spencer.lambdaLow = Number.isFinite(+bishop.spencer.lambdaLow) ? +bishop.spencer.lambdaLow : -0.6;
  bishop.spencer.lambdaHigh = Number.isFinite(+bishop.spencer.lambdaHigh) ? +bishop.spencer.lambdaHigh : 0.6;
  if(bishop.spencer.lambdaHigh <= bishop.spencer.lambdaLow) bishop.spencer.lambdaHigh = bishop.spencer.lambdaLow + 0.1;
  bishop.spencer.lambdaTolerance = Math.max(+bishop.spencer.lambdaTolerance || 0.001, 0.000001);
  bishop.spencer.momentTolerance = Math.max(
    +(bishop.spencer.momentTolerance ?? bishop.spencer.FfTolerance) || 0.001,
    0.000001
  );
  bishop.spencer.forceTolerance = Math.max(
    +(bishop.spencer.forceTolerance ?? bishop.spencer.FfTolerance) || 0.001,
    0.000001
  );
  bishop.spencer.FBracketLow = Math.max(
    +(bishop.spencer.FBracketLow ?? bishop.spencer.FfBracketLow) || 0.1,
    0.01
  );
  bishop.spencer.FBracketHigh = Math.max(
    +(bishop.spencer.FBracketHigh ?? bishop.spencer.FfBracketHigh) || 10.0,
    bishop.spencer.FBracketLow + 0.1
  );
  bishop.spencer.maxOuterIter = Math.max(5, Math.round(+bishop.spencer.maxOuterIter || 20));
  bishop.spencer.maxInnerIter = Math.max(5, Math.round(+bishop.spencer.maxInnerIter || 30));
  bishop.spencer.useNewton = !!bishop.spencer.useNewton;
  bishop.spencer.initialF = Number.isFinite(+bishop.spencer.initialF) && +bishop.spencer.initialF > 0 ? +bishop.spencer.initialF : null;
  bishop.spencer.initialLambda = Number.isFinite(+bishop.spencer.initialLambda) ? +bishop.spencer.initialLambda : 0;
  bishop.spencer.fallbackBishop = bishop.spencer.fallbackBishop !== false;
  if(!Array.isArray(bishop.terrain)) bishop.terrain = [];
  if(!Array.isArray(bishop.phreatic)) bishop.phreatic = [];
  if(!Array.isArray(bishop.walls)) bishop.walls = [];
  if(!Array.isArray(bishop.drains)) bishop.drains = [];
  bishop.selectedDrainId = bishop.selectedDrainId ? String(bishop.selectedDrainId) : '';
  if(!Array.isArray(bishop.draft)) bishop.draft = [];
  if(!Array.isArray(bishop.materials)) bishop.materials = [];
  if(!bishop.seepage || typeof bishop.seepage !== 'object') bishop.seepage = defaults().seepage;
  merge(bishop.seepage, defaults().seepage);
  if(!Array.isArray(bishop.seepage.bcs)) bishop.seepage.bcs = [];
  if(!['idle','meshing','solving','success','failed'].includes(bishop.seepage.status)) bishop.seepage.status = 'idle';
  if(!bishop.seepage.progress || typeof bishop.seepage.progress !== 'object') bishop.seepage.progress = defaults().seepage.progress;
  bishop.seepage.progress.running = !!bishop.seepage.progress.running;
  bishop.seepage.progress.percent = Math.max(0, Math.min(100, +bishop.seepage.progress.percent || 0));
  bishop.seepage.progress.message = bishop.seepage.progress.message ? String(bishop.seepage.progress.message) : '';
  bishop.seepage.progress.runId = Math.max(0, Math.round(+bishop.seepage.progress.runId || 0));
  bishop.seepage.rejectReason = bishop.seepage.rejectReason ? String(bishop.seepage.rejectReason) : '';
  if(!bishop.seepage.drainValidation || typeof bishop.seepage.drainValidation !== 'object') bishop.seepage.drainValidation = {errors:[], warnings:[]};
  if(!Array.isArray(bishop.seepage.drainValidation.errors)) bishop.seepage.drainValidation.errors = [];
  if(!Array.isArray(bishop.seepage.drainValidation.warnings)) bishop.seepage.drainValidation.warnings = [];
  bishop.seepage.geometryHash = bishop.seepage.geometryHash ? String(bishop.seepage.geometryHash) : '';
  if(!bishop.seepage.options || typeof bishop.seepage.options !== 'object') bishop.seepage.options = defaults().seepage.options;
  if(!['fixed','iterate'].includes(bishop.seepage.options.freeSurface)) bishop.seepage.options.freeSurface = 'iterate';
  bishop.seepage.options.usePhreaticAsSeed = bishop.seepage.options.usePhreaticAsSeed !== false;
  bishop.seepage.options.flowErrorTolerance = Math.max(+bishop.seepage.options.flowErrorTolerance || 0.01, 0.000001);
  bishop.seepage.options.maxRuntimeMs = Math.max(+bishop.seepage.options.maxRuntimeMs || 10000, 1);
  if(!bishop.seepage.options.drains || typeof bishop.seepage.options.drains !== 'object'){
    bishop.seepage.options.drains = {gatingTolerances:{}, reportPerSegmentInflow:true};
  }
  if(!bishop.seepage.options.drains.gatingTolerances || typeof bishop.seepage.options.drains.gatingTolerances !== 'object'){
    bishop.seepage.options.drains.gatingTolerances = {};
  }
  bishop.seepage.options.drains.reportPerSegmentInflow = bishop.seepage.options.drains.reportPerSegmentInflow !== false;
  const rawSeepageMeshTargetArea = Number(bishop.seepage.options.meshTargetArea);
  if(bishop.seepage.options.meshTargetAreaAuto == null){
    bishop.seepage.options.meshTargetAreaAuto = !(
      Number.isFinite(rawSeepageMeshTargetArea) &&
      rawSeepageMeshTargetArea > 0 &&
      Math.abs(rawSeepageMeshTargetArea - 0.5) > 1e-9
    );
  }
  if(bishop.seepage.options.meshTargetAreaAuto === false && !(rawSeepageMeshTargetArea > 0)){
    bishop.seepage.options.meshTargetAreaAuto = true;
  }
  bishop.seepage.options.meshTargetArea = resolvedSeepageMeshTargetArea(bishop);
  if(!bishop.seepage.display || typeof bishop.seepage.display !== 'object') bishop.seepage.display = defaults().seepage.display;
  bishop.seepage.display.showBoundaryConditions = bishop.seepage.display.showBoundaryConditions !== false;
  bishop.seepage.display.showBoundaryLabels = bishop.seepage.display.showBoundaryLabels !== false;
  if(!['head','porePressure','gradient','hydraulicFs','flow','qx','qy'].includes(bishop.seepage.display.contourMode)) bishop.seepage.display.contourMode = 'head';
  bishop.seepage.display.showContours = bishop.seepage.display.showContours !== false;
  bishop.seepage.display.showContourLines = bishop.seepage.display.showContourLines !== false;
  bishop.seepage.display.showContourLegend = bishop.seepage.display.showContourLegend !== false;
  bishop.seepage.display.showPhreatic = bishop.seepage.display.showPhreatic !== false;
  bishop.seepage.display.showDrains = bishop.seepage.display.showDrains !== false;
  bishop.seepage.display.showHead = !!bishop.seepage.display.showHead;
  bishop.seepage.display.showEquipotentials = !!bishop.seepage.display.showEquipotentials;
  bishop.seepage.display.showFlowVectors = !!bishop.seepage.display.showFlowVectors;
  bishop.seepage.display.showExitGradient = !!bishop.seepage.display.showExitGradient;
  bishop.seepage.stale = !!bishop.seepage.stale;
  bishop.seepage.lastAppliedBcType = ['head','seepage-face','no-flow'].includes(bishop.seepage.lastAppliedBcType)
    ? bishop.seepage.lastAppliedBcType
    : '';
  bishop.seepage.lastAppliedBcHead = Number.isFinite(+bishop.seepage.lastAppliedBcHead)
    ? +bishop.seepage.lastAppliedBcHead
    : null;
  bishop.seepage.selectedEdgeKey = bishop.seepage.selectedEdgeKey ? String(bishop.seepage.selectedEdgeKey) : '';
  bishop.seepage.selectedBcId = bishop.seepage.selectedBcId ? String(bishop.seepage.selectedBcId) : '';
  if(!bishop.deformation || typeof bishop.deformation !== 'object') bishop.deformation = defaults().deformation;
  merge(bishop.deformation, defaults().deformation);
  const visibleConstitutiveModels = env.hardeningSoilUi
    ? ['linear-elastic','mc-reduced-stiffness','mc-plastic','hardening-soil']
    : ['linear-elastic','mc-reduced-stiffness','mc-plastic'];
  if(!visibleConstitutiveModels.includes(bishop.deformation.options.constitutiveModel)){
    bishop.deformation.options.constitutiveModel = defaults().deformation.options.constitutiveModel;
    if(!visibleConstitutiveModels.includes(bishop.deformation.options.constitutiveModel)){
      bishop.deformation.options.constitutiveModel = 'mc-plastic';
    }
  }
  // The browser UI no longer exposes the old predictor-only initial mode.
  // Keep that mode available to lower-level scripts through the solver API,
  // but migrate saved UI sessions to the production geostatic workflow.
  bishop.deformation.options.initialStressMode = 'plastic-geostatic';
  if(!['idle','meshing','solving','post','success','failed'].includes(bishop.deformation.status)) bishop.deformation.status = 'idle';
  if(!bishop.deformation.progress || typeof bishop.deformation.progress !== 'object') bishop.deformation.progress = defaults().deformation.progress;
  bishop.deformation.progress.running = !!bishop.deformation.progress.running;
  bishop.deformation.progress.percent = Math.max(0, Math.min(100, +bishop.deformation.progress.percent || 0));
  bishop.deformation.progress.message = bishop.deformation.progress.message ? String(bishop.deformation.progress.message) : '';
  bishop.deformation.progress.runId = Math.max(0, Math.round(+bishop.deformation.progress.runId || 0));
  bishop.deformation.rejectReason = bishop.deformation.rejectReason ? String(bishop.deformation.rejectReason) : '';
  if(!Array.isArray(bishop.deformation.warnings)) bishop.deformation.warnings = [];
  if(!bishop.deformation.options || typeof bishop.deformation.options !== 'object') bishop.deformation.options = defaults().deformation.options;
  if(hsConsistentTangentLegacySchema && bishop.deformation.options.hsConsistentTangentMigrationResolved !== true){
    bishop.deformation.options.hsConsistentTangentPromptPending = true;
  }
  if(!['deformation','safety-cphi'].includes(bishop.deformation.options.analysisType)){
    bishop.deformation.options.analysisType = defaults().deformation.options.analysisType;
  }
  if(!['t3','t6'].includes(String(bishop.deformation.options.meshElementType || '').toLowerCase())){
    bishop.deformation.options.meshElementType = defaults().deformation.options.meshElementType;
  } else {
    bishop.deformation.options.meshElementType = String(bishop.deformation.options.meshElementType).toLowerCase();
  }
  if(!['pressure','total'].includes(bishop.deformation.options.loadMode)) bishop.deformation.options.loadMode = 'pressure';
  bishop.deformation.options.totalLoad = Number.isFinite(+bishop.deformation.options.totalLoad) && +bishop.deformation.options.totalLoad > 0
    ? +bishop.deformation.options.totalLoad
    : null;
  bishop.deformation.options.outOfPlaneLength = Math.max(+bishop.deformation.options.outOfPlaneLength || 10, 0.1);
  bishop.deformation.options.useSeepagePorePressures = !!bishop.deformation.options.useSeepagePorePressures;
  bishop.deformation.options.displacementScale = Math.max(+bishop.deformation.options.displacementScale || 1, 0.05);
  {
    const migrateOldDefault = (key, oldValue, newValue) => {
      const current = Number(bishop.deformation.options[key]);
      const tol = Math.max(1e-15, Math.abs(oldValue) * 1e-12);
      if (Number.isFinite(current) && Math.abs(current - oldValue) <= tol) {
        bishop.deformation.options[key] = newValue;
      }
    };
    migrateOldDefault('residualRelTol', 1e-3, 1e-4);
    migrateOldDefault('residualAbsTol', 1e-2, 1e-3);
    migrateOldDefault('minLoadStep', 1 / 2048, 1 / 4096);
    migrateOldDefault('maxLoadSteps', 256, 384);
    migrateOldDefault('plasticLoadStepGrowthFactor', 1.05, 1.08);
    migrateOldDefault('plasticLineSearchMaxBacktracks', 4, 6);
  }
  bishop.deformation.options.nonlinearMaxIterations = Math.max(Math.round(+bishop.deformation.options.nonlinearMaxIterations || 32), 1);
  bishop.deformation.options.initialLoadStep = Math.min(Math.max(+bishop.deformation.options.initialLoadStep || 0.25, 0.0001), 1);
  bishop.deformation.options.minLoadStep = Math.max(+bishop.deformation.options.minLoadStep || (1/4096), 0.000001);
  if(bishop.deformation.options.initialLoadStep < bishop.deformation.options.minLoadStep){
    bishop.deformation.options.initialLoadStep = bishop.deformation.options.minLoadStep;
  }
  bishop.deformation.options.maxLoadSteps = Math.max(Math.round(+bishop.deformation.options.maxLoadSteps || 384), 1);
  bishop.deformation.options.residualRelTol = Math.max(+bishop.deformation.options.residualRelTol || 1e-4, 1e-8);
  bishop.deformation.options.residualAbsTol = Math.max(+bishop.deformation.options.residualAbsTol || 1e-3, 1e-9);
  bishop.deformation.options.displacementRelTol = Math.max(+bishop.deformation.options.displacementRelTol || 1e-4, 1e-8);
  bishop.deformation.options.displacementAbsTol = Math.max(+bishop.deformation.options.displacementAbsTol || 1e-6, 1e-12);
  bishop.deformation.options.loadStepGrowthFactor = Math.max(+bishop.deformation.options.loadStepGrowthFactor || 1.25, 1);
  bishop.deformation.options.loadStepCutbackFactor = Math.min(Math.max(+bishop.deformation.options.loadStepCutbackFactor || 0.5, 0.1), 0.9);
  bishop.deformation.options.plasticLoadStepGrowthFactor = Math.max(+bishop.deformation.options.plasticLoadStepGrowthFactor || 1.08, 1);
  bishop.deformation.options.plasticLoadStepCutbackFactor = Math.min(Math.max(+bishop.deformation.options.plasticLoadStepCutbackFactor || 0.4, 0.1), 0.9);
  bishop.deformation.options.plasticLineSearchMaxBacktracks = Math.max(Math.round(+bishop.deformation.options.plasticLineSearchMaxBacktracks || 6), 1);
  {
    // The deformation pipeline now exposes exactly two initial-stress
    // workflows: 'auto' (elastic gravity-step CG + K0 recovery, identical
    // for flat and sloping ground) and 'gravity-ramp' (zero-stress seed
    // ramped by plastic Newton, only valid with mc-plastic). Every
    // historical method string ('direct-k0', 'admissible-k0', 'k0-nil-step',
    // 'sequential-deposition', 'field-stress') maps onto 'auto'.
    let geostaticMethod = String(bishop.deformation.options.geostaticInitializationMethod || '').toLowerCase();
    if(geostaticMethod !== 'auto' && geostaticMethod !== 'gravity-ramp'){
      geostaticMethod = 'auto';
    }
    if(bishop.deformation.options.constitutiveModel !== 'mc-plastic' && geostaticMethod === 'gravity-ramp'){
      geostaticMethod = 'auto';
    }
    bishop.deformation.options.geostaticInitializationMethod = geostaticMethod;
  }
  bishop.deformation.options.geostaticStressOnlyResidualTolerance = Math.max(+bishop.deformation.options.geostaticStressOnlyResidualTolerance || 0.05, 0.00000001);
  // Staged nil-step correction is now the production geostatic workflow. Keep
  // the solver's compatibility option for scripts, but migrate UI state to the
  // staged path so old saved sessions cannot silently select the obsolete
  // single-jump correction.
  bishop.deformation.options.useStagedGeostaticInit = true;
  bishop.deformation.options.allowStressOnlyGeostaticReference = bishop.deformation.options.allowStressOnlyGeostaticReference === true;
  bishop.deformation.options.stressOnlyGeostaticMaxEta = Math.min(Math.max(+bishop.deformation.options.stressOnlyGeostaticMaxEta || 1, 0), 1);
  bishop.deformation.options.geostaticCorrectionStages = Math.min(Math.max(Math.round(+bishop.deformation.options.geostaticCorrectionStages || 1), 1), 64);
  bishop.deformation.options.initialGravityTangentSchedule = Array.isArray(bishop.deformation.options.initialGravityTangentSchedule)
    ? bishop.deformation.options.initialGravityTangentSchedule
    : String(bishop.deformation.options.initialGravityTangentSchedule || 'plastic').split(/[,\s]+/).filter(Boolean);
  bishop.deformation.options.initialGravityElasticGlobalizationIterations = Math.max(Math.round(+bishop.deformation.options.initialGravityElasticGlobalizationIterations || 4), 0);
  bishop.deformation.options.elasticGlobalizationArmijoC1 = Math.max(+bishop.deformation.options.elasticGlobalizationArmijoC1 || 0.001, 0);
  bishop.deformation.options.elasticGlobalizationMinResidualRatio = Math.min(Math.max(+bishop.deformation.options.elasticGlobalizationMinResidualRatio || 0.90, 0.000001), 0.999);
  bishop.deformation.options.geostaticMinLoadStep = Math.max(+bishop.deformation.options.geostaticMinLoadStep || 0.0005, 0.000001);
  bishop.deformation.options.geostaticMaxRepeatedBand = Math.max(Math.round(+bishop.deformation.options.geostaticMaxRepeatedBand || 3), 1);
  bishop.deformation.options.geostaticProgressFailFast = bishop.deformation.options.geostaticProgressFailFast === true;
  bishop.deformation.options.geostaticProgressFailFastSteps = Math.max(Math.round(+bishop.deformation.options.geostaticProgressFailFastSteps || 6), 1);
  bishop.deformation.options.geostaticProgressFailFastLoadFactor = Math.min(Math.max(+bishop.deformation.options.geostaticProgressFailFastLoadFactor || 0.50, 0), 1);
  bishop.deformation.options.geostaticProgressFailFastPlasticFraction = Math.min(Math.max(+bishop.deformation.options.geostaticProgressFailFastPlasticFraction || 0.15, 0), 1);
  bishop.deformation.options.serviceProgressFailFast = bishop.deformation.options.serviceProgressFailFast === true;
  bishop.deformation.options.serviceProgressFailFastSteps = Math.max(Math.round(+bishop.deformation.options.serviceProgressFailFastSteps || 16), 1);
  bishop.deformation.options.serviceProgressFailFastLoadFactor = Math.min(Math.max(+bishop.deformation.options.serviceProgressFailFastLoadFactor || 0.20, 0), 1);
  bishop.deformation.options.serviceProgressFailFastPlasticFraction = Math.min(Math.max(+bishop.deformation.options.serviceProgressFailFastPlasticFraction || 0.35, 0), 1);
  // The Schwarz preconditioner option was removed; block-Jacobi 2x2 is the
  // single canonical Krylov preconditioner.
  bishop.deformation.options.preconditionerLevel = 'jacobi';
  delete bishop.deformation.options.schwarzMinFreeDofs;
  delete bishop.deformation.options.schwarzOverlap;
  delete bishop.deformation.options.schwarzMaxPatchDofs;
  delete bishop.deformation.options.schwarzDamping;
  delete bishop.deformation.options.schwarzDiagonalShiftScale;
  delete bishop.deformation.options.schwarzSymmetrizePatch;
  delete bishop.deformation.options.allowSchwarzPreconditioner;
  delete bishop.deformation.options.useAdmissibleSlopeSeed;
  delete bishop.deformation.options.unsymmetricLinearSolver;
  bishop.deformation.options.safetyInitialSigmaMsfIncrement = Math.max(+bishop.deformation.options.safetyInitialSigmaMsfIncrement || 0.10, 0.001);
  bishop.deformation.options.safetySigmaMsfGrowthFactor = Math.max(+bishop.deformation.options.safetySigmaMsfGrowthFactor || 1.50, 1.01);
  bishop.deformation.options.safetySigmaMsfMax = Math.max(+bishop.deformation.options.safetySigmaMsfMax || 3.00, 1.0);
  bishop.deformation.options.safetySigmaMsfBracketTolerance = Math.max(+bishop.deformation.options.safetySigmaMsfBracketTolerance || 0.01, 0.0001);
  bishop.deformation.options.safetyMaxSearchTrials = Math.max(Math.round(+bishop.deformation.options.safetyMaxSearchTrials || 32), 1);
  const hadSafetyFinalizationMode = typeof bishop.deformation.options.safetyFinalizationMode === 'string';
  bishop.deformation.options.safetyFinalizationMode = bishop.deformation.options.safetyFinalizationMode === 'production-msf'
    ? 'production-msf'
    : bishop.deformation.options.safetyFinalizationMode === 'legacy-bracket'
      ? 'legacy-bracket'
      : (hadSafetyFinalizationMode ? 'production-msf' : 'legacy-bracket');
  bishop.deformation.options.useUnsymmetricPlasticSolver = bishop.deformation.options.useUnsymmetricPlasticSolver !== false;
  bishop.deformation.options.useMcConsistentTangent = bishop.deformation.options.useMcConsistentTangent !== false;
  bishop.deformation.options.wasmRobustNonlinearMode = false;
  // Strip legacy GPU-related option carriers from saved sessions. The current
  // production deformation UI exposes the CPU f64 route only.
  delete bishop.deformation.options.useGpuAcceleration;
  delete bishop.deformation.options.useResidentCg;
  delete bishop.deformation.options.useResidentGmres;
  delete bishop.deformation.options.allowHybridGpuMatvecForCpuKrylov;
  delete bishop.deformation.options.gpuPrecisionMode;
  delete bishop.deformation.options.linearAlgebraBackend;
  delete bishop.deformation.options.gpuMinDof;
  // Solver backend — single canonical option that drives the dispatch.
  // Valid visible values: 'wasm-cpu' (default) and 'js-cpu'. GPU
  // backends remain in the codebase, but are not selectable in the app
  // while the production path is WASM-first.
  // Migration: if `solverBackend` is missing but a legacy toggle is set,
  // derive it from the legacy fields. Then mirror the canonical value
  // back onto the legacy fields so the existing worker payload + solver
  // dispatch keep working unchanged.
  let solverBackend = bishop.deformation.options.solverBackend;
  if (typeof solverBackend !== 'string') {
    if (bishop.deformation.options.useWasmCpuPipeline === true) solverBackend = 'wasm-cpu';
    else solverBackend = 'wasm-cpu';
  }
  if (!['js-cpu', 'wasm-cpu'].includes(solverBackend)) solverBackend = 'wasm-cpu';
  bishop.deformation.options.solverBackend = solverBackend;
  bishop.deformation.options.useWasmCpuPipeline = solverBackend === 'wasm-cpu';
  bishop.deformation.options.useNewGpuPipeline = false;
  bishop.deformation.options.gpuPipelineVersion = 'v1';
  const rawDeformationMeshTargetArea = Number(bishop.deformation.options.meshTargetArea);
  const deformationAutoMeshTargetArea = autoDeformationMeshTargetArea(bishop);
  if(bishop.deformation.options.meshTargetAreaAuto == null){
    bishop.deformation.options.meshTargetAreaAuto = !(
      Number.isFinite(rawDeformationMeshTargetArea) &&
      rawDeformationMeshTargetArea > 0 &&
      Math.abs(rawDeformationMeshTargetArea - deformationAutoMeshTargetArea) > 1e-9
    );
  }
  if(bishop.deformation.options.meshTargetAreaAuto === false && !(rawDeformationMeshTargetArea > 0)){
    bishop.deformation.options.meshTargetAreaAuto = true;
  }
  bishop.deformation.options.meshTargetArea = resolvedDeformationMeshTargetArea(bishop);
  if(!bishop.deformation.display || typeof bishop.deformation.display !== 'object') bishop.deformation.display = defaults().deformation.display;
  if(bishop.deformation.display.contourMode === 'syy') bishop.deformation.display.contourMode = 'deltaSigmaYy';
  if(bishop.deformation.display.contourMode === 'mc') bishop.deformation.display.contourMode = 'mcEta';
  if(!env.deformationQuantityIds(
    bishop.deformation?.options?.analysisType,
    env.hardeningSoilUi && bishop.deformation?.result?.hasHardeningSoil === true
  ).includes(bishop.deformation.display.contourMode)) bishop.deformation.display.contourMode = 'uTotal';
  bishop.deformation.display.showContours = bishop.deformation.display.showContours !== false;
  bishop.deformation.display.showContourLines = bishop.deformation.display.showContourLines !== false;
  bishop.deformation.display.showContourLegend = bishop.deformation.display.showContourLegend !== false;
  bishop.deformation.display.showDisplacementVectors = !!bishop.deformation.display.showDisplacementVectors;
  bishop.deformation.display.showDeformedMesh = !!bishop.deformation.display.showDeformedMesh;
  bishop.deformation.display.showUndeformedMesh = !!bishop.deformation.display.showUndeformedMesh;
  bishop.deformation.display.showLoadVectors = bishop.deformation.display.showLoadVectors !== false;
  bishop.deformation.display.showPlasticPoints = bishop.deformation.display.showPlasticPoints !== false;
  bishop.deformation.display.showWallMomentOverlay = bishop.deformation.display.showWallMomentOverlay === true;
  if(!['M', 'V', 'N', 'w', 'theta'].includes(bishop.deformation.display.wallOverlayQuantity)){
    bishop.deformation.display.wallOverlayQuantity = 'M';
  }
  bishop.deformation.stale = !!bishop.deformation.stale;
  if(!['line-probe', 'structure'].includes(bishop.analysisTab)) bishop.analysisTab = 'line-probe';
  if(!bishop.surfaceLoad || typeof bishop.surfaceLoad !== 'object') bishop.surfaceLoad = {xStart:null, xEnd:null, q:0};
  bishop.surfaceLoad.q = Math.max(+bishop.surfaceLoad.q || 0, 0);
  env.migrateSurfaceLoadsShape(bishop);
  if(!bishop.viewport || typeof bishop.viewport !== 'object') bishop.viewport = {scale:24, offsetX:80, offsetY:360, fitted:false};
  if(!['characteristic','da1_1','da1_2'].includes(bishop.strengthSet)) bishop.strengthSet = 'characteristic';
}
