// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/state/defaults.js — the state schema of the Seep / Slope ("bishop") app, refactor
// step 9a (01-monolith-map.md §1.2, §6.1 row `seepslope/`). The `bishop` block of
// stage6Defaults() (legacy-controller.js 3873-4134 at 462fc50, stage6/apps/bishop-state.js
// `defaults()` since PR 11) split per concern: every builder returns a fresh object, and
// `defaults()` composes them in exactly the literal's key order — a saved project serialises
// `stage6.bishop` in that order, so the order is part of the contract (verified byte-for-byte
// by scripts/verify_seepslope_state.mjs).
//
// Nothing here is redesigned: the values, the comments and even the two tab-indented lines of
// the surface-load block are the monolith's.

/** `measurement`: the two-point measuring tape of the canvas. */
export function measurementDefaults(){
  return {
    points:[]
  };
}

/** `lineProbe`: the measurement-line sampler of the seepage / deformation fields. */
export function lineProbeDefaults(){
  return {
    sampleCount:81,
    seepageQuantity:'head',
    deformationQuantity:'uTotal',
    copyMessage:'',
    copyTone:''
  };
}

/** `display`: the soil-region overlay of the canvas. */
export function displayDefaults(){
  return {
    showRegions:true,
    showRegionLabels:true,
    showRegionLegend:true,
    regionOpacity:0.22
  };
}

/** `surfaceLoad`: the legacy single-load mirror (kept in sync with `surfaceLoads[0]`). */
export function surfaceLoadMirrorDefaults(){
  return {
    xStart:null,
    xEnd:null,
    q:0
  };
}

/** `viewport`: the canvas transform (world → screen). */
export function viewportDefaults(){
  return {
    scale:24,
    offsetX:80,
    offsetY:360,
    fitted:false
  };
}

/** `search`: the slip-circle grid search. */
export function searchDefaults(){
  return {
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
  };
}

/** `solver`: the Bishop iteration. */
export function solverDefaults(){
  return {
    useOrdinarySeed:true,
    initialFS:1.00,
    tolerance:0.0001,
    maxIterations:50,
    minMAlpha:0.000001
  };
}

/** `spencer`: the Spencer re-check of the shortlisted circles. */
export function spencerDefaults(){
  return {
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
  };
}

/** `progress`: the stability search progress (the Worker's feed). */
export function progressDefaults(){
  return {
    running:false,
    percent:0,
    trial:0,
    total:0,
    message:'',
    previewCircle:null
  };
}

/** `seepage.progress` / `deformation.progress`: the run progress of the FEM Workers. */
export function runProgressDefaults(){
  return {
    running:false,
    percent:0,
    message:'',
    runId:0
  };
}

/** `seepage.options`: the free-surface seepage solve. */
export function seepageOptionsDefaults(){
  return {
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
  };
}

/** `seepage.display`: the seepage overlays of the canvas. */
export function seepageDisplayDefaults(){
  return {
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
  };
}

/** `seepage`: boundary conditions, mesh, result, run state and options of the seepage workspace. */
export function seepageDefaults(){
  return {
    bcs:[],
    mesh:null,
    result:null,
    stale:false,
    status:'idle',
    progress:runProgressDefaults(),
    rejectReason:'',
    drainValidation:{
      errors:[],
      warnings:[]
    },
    geometryHash:'',
    options:seepageOptionsDefaults(),
    display:seepageDisplayDefaults(),
    lastAppliedBcType:'',
    lastAppliedBcHead:null,
    selectedEdgeKey:'',
    selectedBcId:''
  };
}

/** `deformation.options`: the nonlinear FEM solve (≈60 solver keys). */
export function deformationOptionsDefaults(){
  return {
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
  };
}

/** `deformation.display`: the deformation overlays of the canvas. */
export function deformationDisplayDefaults(){
  return {
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
  };
}

/** `deformation`: mesh, result, run state, options and display of the deformation workspace. */
export function deformationDefaults(){
  return {
    mesh:null,
    result:null,
    stale:false,
    status:'idle',
    rejectReason:'',
    warnings:[],
    progress:runProgressDefaults(),
    options:deformationOptionsDefaults(),
    display:deformationDisplayDefaults()
  };
}

/** `capturedView`: the Stage 7 canvas captures per workspace. */
export function capturedViewDefaults(){
  return {
    stability:null,
    seepage:null,
    deformation:null
  };
}

/** The `bishop` block of stage6Defaults() — same keys, same order, same values. */
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
    measurement:measurementDefaults(),
    lineProbe:lineProbeDefaults(),
    analysisTab:'line-probe',
    display:displayDefaults(),
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
	      surfaceLoad:surfaceLoadMirrorDefaults(),
	      surfaceLoads:[],
	      selectedSurfaceLoadId:null,
    viewport:viewportDefaults(),
    gridSnap:true,
    pointSnap:false,
    snapSize:0.50,
    analysisDepth:15.00,
    materials:[],
    sourceLayerSignature:'',
    search:searchDefaults(),
    solver:solverDefaults(),
    spencer:spencerDefaults(),
    progress:progressDefaults(),
    seepage:seepageDefaults(),
    deformation:deformationDefaults(),
    results:null,
    selectedResult:0,
    stale:true,
    capturedView:capturedViewDefaults()
  };
}
