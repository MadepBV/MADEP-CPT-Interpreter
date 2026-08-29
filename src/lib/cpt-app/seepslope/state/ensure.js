// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/state/ensure.js — the Seep / Slope schema migration, refactor step 9a: the 364-line
// bishop part of ensureStage6State() (legacy-controller.js 4281-4646 at 462fc50, stage6/apps/
// bishop-state.js `ensure()` since PR 11) split into named steps. Every step says which legacy
// shape it upgrades; the statements keep the monolith's order and wording — the order matters
// (spencer.recheckCount reads search.keepBest, the mesh areas read terrain + analysisDepth, the
// deformation display validation reads the clamped analysisType) and so does the order in which
// keys missing from the defaults are added (`useWasmCpuPipeline`, `wallOverlayQuantity`, …:
// a saved project serialises them in insertion order).
//
// `ensure(stage6, env)` runs after the shell's merge of the defaults (stage6/state.js), so every
// key of defaults() exists; the steps clamp values, validate enums, migrate old shapes and delete
// retired keys. `env` (built by stage6/state.js ensure()):
//   env.rawMaxDepth             stage6MaxDepth() — bottom of the last layer (10 without layers)
//   env.hardeningSoilUi         STAGE6_ENABLE_HARDENING_SOIL_UI (which constitutive models /
//                               deformation quantities are visible)
//   env.deformationQuantityIds  stage6BishopDeformationQuantityIds(analysisType, hasHs) — the
//                               contour / probe quantity list (deformation contours, step 9b/9d);
//                               still a host hook because the function lives in that region
// The surface-load shape migration is this package's own (surface-loads.js), no longer a hook.
import { merge } from '../../stage6/merge.js';
import {
  deformationDefaults,
  deformationDisplayDefaults,
  deformationOptionsDefaults,
  displayDefaults,
  lineProbeDefaults,
  runProgressDefaults,
  seepageDefaults,
  seepageDisplayDefaults,
  seepageOptionsDefaults,
  surfaceLoadMirrorDefaults,
  viewportDefaults
} from './defaults.js';
import { autoDeformationMeshTargetArea, resolvedDeformationMeshTargetArea, resolvedSeepageMeshTargetArea } from './domain.js';
import { migrateSurfaceLoadsShape } from './surface-loads.js';

/** The bishop schema migration; `stage6.bishop` is upgraded in place. */
export function ensure(stage6, env){
  const bishop = stage6.bishop;
  const { hsConsistentTangentLegacySchema } = migrateSchemaVersion(bishop);
  const bishopMinDepth = Math.max(env.rawMaxDepth, 15);
  ensureWorkspace(bishop);
  ensureMeasurement(bishop);
  ensureLineProbe(bishop, env);
  migrateAnalysisDepth(bishop, env, bishopMinDepth);
  ensureCanvasSettings(bishop);
  ensureSearch(bishop);
  ensureMethodAndSolver(bishop);
  migrateSpencer(bishop);
  ensureGeometryCollections(bishop);
  ensureSeepage(bishop);
  ensureDeformation(bishop, env, hsConsistentTangentLegacySchema);
  ensureAnalysisTab(bishop);
  migrateSurfaceLoads(bishop);
  ensureViewport(bishop);
  ensureStrengthSet(bishop);
}

/**
 * Schema version: v1 (no / 1) and v2 sessions become v3. A pre-v3 session predates the MC
 * consistent-tangent default and gets the HS migration prompt (see ensureDeformation). Also the
 * `history` array (materials history) that v1 lacked.
 */
export function migrateSchemaVersion(bishop){
  const bishopSchemaVersionBeforeSync = Math.round(+bishop.schemaVersion || 0);
  const hsConsistentTangentLegacySchema = bishopSchemaVersionBeforeSync < 3;
  bishop.schemaVersion = Math.max(bishopSchemaVersionBeforeSync, 3);
  if(!Array.isArray(bishop.history)) bishop.history = [];
  return { hsConsistentTangentLegacySchema };
}

/** Workspace enum (v1 sessions had only stability) and the FEM pore-pressure flag. */
export function ensureWorkspace(bishop){
  if(!['stability','seepage','deformation'].includes(bishop.workspace)) bishop.workspace = 'stability';
  bishop.useFemPorePressure = !!bishop.useFemPorePressure;
}

/** Measuring tape: at most two finite points (sessions before the tape have none). */
export function ensureMeasurement(bishop){
  if(!bishop.measurement || typeof bishop.measurement !== 'object') bishop.measurement = {points:[]};
  if(!Array.isArray(bishop.measurement.points)) bishop.measurement.points = [];
  bishop.measurement.points = bishop.measurement.points
    .filter((pt)=>Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    .slice(0, 2)
    .map((pt)=>({x:+pt.x, y:+pt.y}));
}

/**
 * Line probe (sessions before it get the defaults): sample count 21…201, the seepage quantity
 * enum, the deformation quantity against the visible list (HS quantities only with the HS UI),
 * the copy feedback strings.
 */
export function ensureLineProbe(bishop, env){
  if(!bishop.lineProbe || typeof bishop.lineProbe !== 'object') bishop.lineProbe = lineProbeDefaults();
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
}

/**
 * Analysis depth: v1 sessions stored `bottomMargin` (metres below the last layer, default 5)
 * instead of `analysisDepth` (metres below ground). A custom margin becomes layer bottom + margin,
 * the default margin becomes the minimum depth; the depth is at least max(layer bottom, 15).
 */
export function migrateAnalysisDepth(bishop, env, bishopMinDepth){
  if(bishop.analysisDepth == null || bishop.analysisDepth === ''){
    const legacyBottomMargin = Number(bishop.bottomMargin);
    const hasCustomLegacyMargin = Number.isFinite(legacyBottomMargin) && Math.abs(legacyBottomMargin - 5) > 1e-9;
    bishop.analysisDepth = hasCustomLegacyMargin
      ? env.rawMaxDepth + legacyBottomMargin
      : bishopMinDepth;
  }
  bishop.analysisDepth = Math.max(+bishop.analysisDepth || bishopMinDepth, bishopMinDepth);
}

/** Canvas settings: CPT insertion offset ±100 m, snap size ≥ 0.05 m, point snap flag, the region overlay display block. */
export function ensureCanvasSettings(bishop){
  bishop.cptInsertionOffset = Number.isFinite(+bishop.cptInsertionOffset)
    ? Math.max(Math.min(+bishop.cptInsertionOffset, 100), -100)
    : 0;
  bishop.snapSize = Math.max(+bishop.snapSize || 0.5, 0.05);
  bishop.pointSnap = !!bishop.pointSnap;
  if(!bishop.display || typeof bishop.display !== 'object') bishop.display = displayDefaults();
  bishop.display.showRegions = bishop.display.showRegions !== false;
  bishop.display.showRegionLabels = bishop.display.showRegionLabels !== false;
  bishop.display.showRegionLegend = bishop.display.showRegionLegend !== false;
  bishop.display.regionOpacity = Math.min(Math.max(+bishop.display.regionOpacity || 0.22, 0.05), 0.75);
}

/** Slip-circle search grid: integer counts with minimums, offsets / lengths / angle clamped. */
export function ensureSearch(bishop){
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
}

/** Method mode enum (v1 had only Bishop → bishop_spencer) and the Bishop iteration clamps. */
export function ensureMethodAndSolver(bishop){
  if(!['bishop_only','bishop_spencer'].includes(bishop.methodMode)) bishop.methodMode = 'bishop_spencer';
  bishop.solver.initialFS = Math.max(+bishop.solver.initialFS || 1, 0.1);
  bishop.solver.tolerance = Math.max(+bishop.solver.tolerance || 0.0001, 0.000001);
  bishop.solver.maxIterations = Math.max(5, Math.round(+bishop.solver.maxIterations || 50));
  bishop.solver.minMAlpha = Math.max(+bishop.solver.minMAlpha || 0.000001, 0.000000001);
}

/**
 * Spencer block (absent in v1): the re-check count is capped by search.keepBest, the λ bracket
 * ordered; the v2 keys `FfTolerance` / `FfBracketLow` / `FfBracketHigh` (one tolerance for both
 * equations) feed `momentTolerance` / `forceTolerance` / `FBracketLow` / `FBracketHigh` when the
 * new keys are missing.
 */
export function migrateSpencer(bishop){
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
}

/** The geometry collections are arrays (v1 sessions lack walls / drains / materials); the drain selection is a string. */
export function ensureGeometryCollections(bishop){
  if(!Array.isArray(bishop.terrain)) bishop.terrain = [];
  if(!Array.isArray(bishop.phreatic)) bishop.phreatic = [];
  if(!Array.isArray(bishop.walls)) bishop.walls = [];
  if(!Array.isArray(bishop.drains)) bishop.drains = [];
  bishop.selectedDrainId = bishop.selectedDrainId ? String(bishop.selectedDrainId) : '';
  if(!Array.isArray(bishop.draft)) bishop.draft = [];
  if(!Array.isArray(bishop.materials)) bishop.materials = [];
}

/**
 * Seepage workspace (absent in v1, partial in v2): the block is merged with the defaults, the
 * status / progress / reject reason / drain validation / geometry hash normalised, the options
 * clamped (free-surface enum, tolerances, the drains sub-block that v2 lacked), the mesh target
 * area migrated (see migrateSeepageMeshTargetArea), the display flags and the contour mode
 * validated, the boundary-condition memory (`lastAppliedBc*`, selections) typed.
 */
export function ensureSeepage(bishop){
  if(!bishop.seepage || typeof bishop.seepage !== 'object') bishop.seepage = seepageDefaults();
  merge(bishop.seepage, seepageDefaults());
  if(!Array.isArray(bishop.seepage.bcs)) bishop.seepage.bcs = [];
  if(!['idle','meshing','solving','success','failed'].includes(bishop.seepage.status)) bishop.seepage.status = 'idle';
  if(!bishop.seepage.progress || typeof bishop.seepage.progress !== 'object') bishop.seepage.progress = runProgressDefaults();
  bishop.seepage.progress.running = !!bishop.seepage.progress.running;
  bishop.seepage.progress.percent = Math.max(0, Math.min(100, +bishop.seepage.progress.percent || 0));
  bishop.seepage.progress.message = bishop.seepage.progress.message ? String(bishop.seepage.progress.message) : '';
  bishop.seepage.progress.runId = Math.max(0, Math.round(+bishop.seepage.progress.runId || 0));
  bishop.seepage.rejectReason = bishop.seepage.rejectReason ? String(bishop.seepage.rejectReason) : '';
  if(!bishop.seepage.drainValidation || typeof bishop.seepage.drainValidation !== 'object') bishop.seepage.drainValidation = {errors:[], warnings:[]};
  if(!Array.isArray(bishop.seepage.drainValidation.errors)) bishop.seepage.drainValidation.errors = [];
  if(!Array.isArray(bishop.seepage.drainValidation.warnings)) bishop.seepage.drainValidation.warnings = [];
  bishop.seepage.geometryHash = bishop.seepage.geometryHash ? String(bishop.seepage.geometryHash) : '';
  if(!bishop.seepage.options || typeof bishop.seepage.options !== 'object') bishop.seepage.options = seepageOptionsDefaults();
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
  migrateSeepageMeshTargetArea(bishop);
  if(!bishop.seepage.display || typeof bishop.seepage.display !== 'object') bishop.seepage.display = seepageDisplayDefaults();
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
}

/**
 * Seepage mesh target area: v2 sessions stored a manual `meshTargetArea` (default 0.5 m²) and had
 * no `meshTargetAreaAuto`; a value that is still the old default means "auto", anything else a
 * manual choice. Manual without a usable value falls back to auto; the stored value is always the
 * resolved one.
 */
export function migrateSeepageMeshTargetArea(bishop){
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
}

/**
 * Deformation workspace (absent in v1, evolving through v2/v3): the block is merged with the
 * defaults and then upgraded by the sub-steps below, in this order.
 */
export function ensureDeformation(bishop, env, hsConsistentTangentLegacySchema){
  if(!bishop.deformation || typeof bishop.deformation !== 'object') bishop.deformation = deformationDefaults();
  merge(bishop.deformation, deformationDefaults());
  ensureConstitutiveModel(bishop, env);
  ensureDeformationRunState(bishop);
  migrateHsConsistentTangentPrompt(bishop, hsConsistentTangentLegacySchema);
  ensureDeformationLoadOptions(bishop);
  migrateRetunedSolverDefaults(bishop);
  ensureNonlinearSolverOptions(bishop);
  migrateGeostaticInitialization(bishop);
  ensureGeostaticOptions(bishop);
  removeSchwarzPreconditioner(bishop);
  ensureSafetyOptions(bishop);
  migrateSolverBackend(bishop);
  migrateDeformationMeshTargetArea(bishop);
  ensureDeformationDisplay(bishop, env);
  bishop.deformation.stale = !!bishop.deformation.stale;
}

/**
 * Constitutive model: only the models the UI shows are kept ('hardening-soil' only with the HS UI,
 * else back to the default); the retired predictor-only `initialStressMode` values of old sessions
 * all become the production geostatic workflow.
 */
export function ensureConstitutiveModel(bishop, env){
  const visibleConstitutiveModels = env.hardeningSoilUi
    ? ['linear-elastic','mc-reduced-stiffness','mc-plastic','hardening-soil']
    : ['linear-elastic','mc-reduced-stiffness','mc-plastic'];
  if(!visibleConstitutiveModels.includes(bishop.deformation.options.constitutiveModel)){
    bishop.deformation.options.constitutiveModel = deformationOptionsDefaults().constitutiveModel;
    if(!visibleConstitutiveModels.includes(bishop.deformation.options.constitutiveModel)){
      bishop.deformation.options.constitutiveModel = 'mc-plastic';
    }
  }
  // The browser UI no longer exposes the old predictor-only initial mode.
  // Keep that mode available to lower-level scripts through the solver API,
  // but migrate saved UI sessions to the production geostatic workflow.
  bishop.deformation.options.initialStressMode = 'plastic-geostatic';
}

/** Run bookkeeping: status enum (v2 lacked 'post'), progress, reject reason, warnings, the options object itself. */
export function ensureDeformationRunState(bishop){
  if(!['idle','meshing','solving','post','success','failed'].includes(bishop.deformation.status)) bishop.deformation.status = 'idle';
  if(!bishop.deformation.progress || typeof bishop.deformation.progress !== 'object') bishop.deformation.progress = runProgressDefaults();
  bishop.deformation.progress.running = !!bishop.deformation.progress.running;
  bishop.deformation.progress.percent = Math.max(0, Math.min(100, +bishop.deformation.progress.percent || 0));
  bishop.deformation.progress.message = bishop.deformation.progress.message ? String(bishop.deformation.progress.message) : '';
  bishop.deformation.progress.runId = Math.max(0, Math.round(+bishop.deformation.progress.runId || 0));
  bishop.deformation.rejectReason = bishop.deformation.rejectReason ? String(bishop.deformation.rejectReason) : '';
  if(!Array.isArray(bishop.deformation.warnings)) bishop.deformation.warnings = [];
  if(!bishop.deformation.options || typeof bishop.deformation.options !== 'object') bishop.deformation.options = deformationOptionsDefaults();
}

/** A pre-v3 session that never resolved the MC consistent-tangent migration gets the prompt. */
export function migrateHsConsistentTangentPrompt(bishop, hsConsistentTangentLegacySchema){
  if(hsConsistentTangentLegacySchema && bishop.deformation.options.hsConsistentTangentMigrationResolved !== true){
    bishop.deformation.options.hsConsistentTangentPromptPending = true;
  }
}

/** Analysis type, element type (v2 stored upper-case 'T6'), load mode, total load, out-of-plane length, pore-pressure coupling, displacement scale. */
export function ensureDeformationLoadOptions(bishop){
  if(!['deformation','safety-cphi'].includes(bishop.deformation.options.analysisType)){
    bishop.deformation.options.analysisType = deformationOptionsDefaults().analysisType;
  }
  if(!['t3','t6'].includes(String(bishop.deformation.options.meshElementType || '').toLowerCase())){
    bishop.deformation.options.meshElementType = deformationOptionsDefaults().meshElementType;
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
}

/**
 * Solver defaults that were re-tuned (v2 → v3): a session still carrying the old default value
 * of a key gets the new default (a user's own value is left alone).
 */
export function migrateRetunedSolverDefaults(bishop){
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

/** Nonlinear load-stepping clamps: iteration counts, load steps, tolerances, growth / cutback factors. */
export function ensureNonlinearSolverOptions(bishop){
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
}

/**
 * Geostatic initialisation method: every historical method string ('direct-k0', 'admissible-k0',
 * 'k0-nil-step', 'sequential-deposition', 'field-stress') maps onto 'auto'; 'gravity-ramp' is only
 * valid with mc-plastic.
 */
export function migrateGeostaticInitialization(bishop){
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

/**
 * Geostatic options: the staged nil-step correction is forced on (the single-jump correction of
 * old sessions is obsolete), the stress-only reference flags, correction stages, the tangent
 * schedule (a string in v2 → array), globalisation and fail-fast clamps.
 */
export function ensureGeostaticOptions(bishop){
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
}

/** The Schwarz preconditioner option and its tuning keys (v2) are retired: block-Jacobi 2×2 is the only preconditioner. */
export function removeSchwarzPreconditioner(bishop){
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
}

/**
 * c-φ safety search clamps; `safetyFinalizationMode` missing altogether (v2) means the legacy
 * bracket finalisation, an unknown string the production Msf; the plastic-solver flags default
 * on, the WASM robust mode is forced off.
 */
export function ensureSafetyOptions(bishop){
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
}

/**
 * Solver backend: the GPU-era option carriers (`useGpuAcceleration`, resident CG / GMRES, hybrid
 * matvec, precision mode, backend, min DOF) are stripped; `solverBackend` is derived from the
 * legacy `useWasmCpuPipeline` toggle when missing and mirrored back onto the legacy fields the
 * worker payload still reads (`useWasmCpuPipeline`, `useNewGpuPipeline`, `gpuPipelineVersion`).
 */
export function migrateSolverBackend(bishop){
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
}

/**
 * Deformation mesh target area: like the seepage one, but the v2 "still the default" test is
 * against the automatic area of the current domain (v2 stored the auto value as a manual one).
 */
export function migrateDeformationMeshTargetArea(bishop){
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
}

/**
 * Deformation display: the v2 contour ids 'syy' / 'mc' became 'deltaSigmaYy' / 'mcEta'; the mode
 * is validated against the visible quantity list; the overlay flags typed; the wall overlay
 * quantity (added in v3) defaults to the bending moment.
 */
export function ensureDeformationDisplay(bishop, env){
  if(!bishop.deformation.display || typeof bishop.deformation.display !== 'object') bishop.deformation.display = deformationDisplayDefaults();
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
}

/** The analysis tab enum (v3). */
export function ensureAnalysisTab(bishop){
  if(!['line-probe', 'structure'].includes(bishop.analysisTab)) bishop.analysisTab = 'line-probe';
}

/**
 * Surface loads: the v1 single `surfaceLoad` {xStart, xEnd, q} mirror is typed, then the v1 → v2
 * shape migration of surface-loads.js seeds `surfaceLoads[]` from it and re-syncs the mirror.
 */
export function migrateSurfaceLoads(bishop){
  if(!bishop.surfaceLoad || typeof bishop.surfaceLoad !== 'object') bishop.surfaceLoad = surfaceLoadMirrorDefaults();
  bishop.surfaceLoad.q = Math.max(+bishop.surfaceLoad.q || 0, 0);
  migrateSurfaceLoadsShape(bishop);
}

/** The canvas viewport object (sessions saved without one). */
export function ensureViewport(bishop){
  if(!bishop.viewport || typeof bishop.viewport !== 'object') bishop.viewport = viewportDefaults();
}

/** The strength set enum (characteristic / DA1-1 / DA1-2). */
export function ensureStrengthSet(bishop){
  if(!['characteristic','da1_1','da1_2'].includes(bishop.strengthSet)) bishop.strengthSet = 'characteristic';
}
