// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
import {
  designSoilLayer,
  effectiveVerticalStressAtDepth,
  stage6Constants
} from './stage6-engineering';
import {
  bishopHsJakyK0nc,
  bishopHsRowePhiCvDeg,
  buildBishopModelFromStageLayers,
  terrainY as bishopTerrainY
} from './stage6-bishop';
import { importTerrainFromDxfText } from './dxf-terrain';
import { exportRegionsToDxf } from './dxf-regions';
import {
  buildOuterBoundary as buildSeepageOuterBoundary,
  makeBoundaryCondition as makeSeepageBoundaryCondition,
  migrateBcs as migrateSeepageBcs,
  pickOuterBoundaryEdge as pickSeepageBoundaryEdge,
  seepageGeometryHash
} from './seepage/boundary';
import {
  defaultWallMechanicalMaterial,
  normalizeWallMaterial,
  resolveMaterialPermeability,
  resolveWallMechanicalSection,
  seepageSourceLabel,
  wallMaterialSourceLabel
} from './seepage/material';
import {
  drainHeadValueAt,
  drainTotalLength,
  validateDrains
} from './seepage/drains';
import { contourSegmentsForTriangles } from './seepage/solver';
import { normalizeRegionPolygon } from './soil-regions';
import { wallResultIsStale } from './deformation/wall-result-staleness.js';
import {
  buildBearingChartConfig,
  buildLineProbeChartConfig,
  buildRawProfileChartConfig,
  buildTuningDepthChartConfig,
  buildTuningRegressionChartConfig
} from './chart-factories';
import { CAT, eurocodeEntryMatches } from './eurocode-tabel3.js';
import {
  DEFAULT_ASSUMED_RF,
  classifyCUR3,
  classifyNEN6740,
  classifyRobertson1990,
  classifyRobertson2016,
  classifyTabel3,
  normalizeAssumedRf
} from './classification-core.js';
import { buildLayerColumnSvgMarkup, buildLayerPreviewSvgMarkup } from './report/svg.js';
import { cleanupStage7Payloads, saveStage7Payload } from './report-storage';
import { SOIL_CLASS_NAMES, SOIL_FILL_COLORS } from './soil-styles';
import {
  pointSegmentDistance as wallPointSegmentDistance,
  wallAxis,
  wallEndpoints,
  wallLength,
  wallNormalForSide
} from './wall-geometry.js';
import { installRetainingApp } from './retaining/retaining-ui.js';
import { installStratigraphyApp } from './stratigraphy/index.js';
import {
  buildRowsFromGrid,
  cptValueToMPa,
  detectColumns,
  findDataHeaderRow,
  parseCptNumber,
  presentImportReview
} from './import-review/index.js';
import { installProjectIO } from './project-io/index.js';
// Transient feedback (design §3.15): an `alert()` the engineer can only acknowledge becomes a toast.
// The guards whose text a golden locks — the export / Stage 7 preconditions and the PLAXIS nu note,
// which gates a download that then proceeds — deliberately keep `alert()`; see worklog 25 §3.
import { toast } from '../styles/toast.ts';
import { seepslopeVizSeries } from '../styles/theme.ts';
import {
  escAttr as stage6EscAttr,
  escJsString as stage6EscJsString,
  tooltip as stage6Tooltip,
  noteHtml as stage6NoteHtml,
  auditTableHtml as stage6AuditTableHtml,
  compactNumber as stage6CompactNumber
} from './core/format.js';
import { readCssToken } from './core/css-tokens.js';
import { destroyChart as stage6DestroyChart } from './core/chart-host.js';
import {
  parseGEF as parseGefPure,
  parseCsvCpt as parseCsvPure,
  parseExcelCpt as parseExcelPure,
  loadXlsxModule,
  applyParsedCpt as applyParsedCptPure,
  reviewStaging,
  NO_DATA_ROWS_MESSAGE,
  importCptFiles as importCptFilesPure,
  demoPatch,
  syncParsedCptDom,
  syncDemoDom,
  renderElevationSource,
  renderWaterTableDisplay,
  renderAssumedRfControls,
  renderMetaCard
} from './load/index.js';
import {
  NO_LAYERS_MESSAGE,
  buildLayersCsv,
  layersCsvFilename,
  buildPlaxisCommandsText,
  plaxisNuDrainageConflicts,
  plaxisNuDrainageAlertMessage,
  plaxisCommandsFilename,
  NO_LAYER_MODEL_MESSAGE,
  NO_SIMULATED_ROWS_MESSAGE,
  buildPlaxisCptText,
  plaxisCptFilename
} from './export/index.js';
import {
  STAGE7_GUARD_MESSAGE,
  safeClone,
  buildStage7Payload as buildStage7PayloadPure
} from './report/index.js';
import {
  DEF,
  AE,
  sb260GranularAlpha,
  sb260TransitionAlpha,
  sb260AlphaFamily,
  alphaEB,
  cptModelCtx,
  stressAt as stressAtPure,
  hsParams as hsParamsPure,
  khParams as khParamsPure,
  workingLayers as workingLayersPure
} from './model-params/index.js';
import {
  classificationMethodLabel,
  classificationMetricLabel,
  classificationMetricValue,
  assumedRfValue as assumedRfValuePure,
  cptHasFs as cptHasFsPure,
  cptHasRf as cptHasRfPure,
  classRob as classRobPure,
  classRob2016 as classRob2016Pure,
  classCUR3 as classCUR3Pure,
  classNEN6740 as classNEN6740Pure,
  classSB260 as classSB260Pure,
  classifyCpt,
  classificationMetricsHtml,
  classificationAssumedRfNoteHtml,
  classificationTableRowsHtml
} from './classification/index.js';
import {
  CAT_GROUPS,
  compatLevel,
  subtypeGroup,
  qcRfFit,
  suggestSubtype,
  layerTypeCompatScore,
  familyClass,
  qcSimilarity,
  rfSimilarity,
  subtypeSimilarity,
  paramSimilarity,
  compatSimilarity,
  continuityScore,
  isCriticalMarkerLayer,
  mergeCandidateScore,
  segmentSummary as segmentSummaryPure,
  layersCtx,
  detectLayers as detectLayersPure
} from './layers/index.js';
import {
  createStage6Registry,
  defaults as stage6StateDefaults,
  ensureCpt as stage6EnsureCpt,
  layerBottom as stage6LayerBottom,
  get as stage6Get,
  set as stage6Set,
  uiState as stage6UiState,
  rememberDetailsState as stage6RememberDetails,
  detailsOpen as stage6DetailsOpenOf,
  setDetailsOpen as stage6SetDetailsOpenOf,
  setField as stage6SetField,
  createStage6Shell
} from './stage6/index.js';
import {
  installBearingApp,
  layerAtDepth as bearingLayerAtDepth,
  bearingAtDepth as bearingAtDepthPure,
  bearingProfile as bearingProfilePure,
  shapeFactors as bearingShapeFactors,
  selectedDepthHtml as bearingSelectedDepthHtml,
  materialParamsHtml as bearingMaterialParamsHtml,
  drainedFormulaHtml as bearingDrainedFormulaHtml,
  undrainedFormulaHtml as bearingUndrainedFormulaHtml
} from './bearing/index.js';
import { setActiveCpt } from './core/state.js';
import { installProject, bindStageNav } from './project/index.js';
import { installSection } from './section/index.js';
import {
  tuningCtx,
  fitLayer as fitLayerPure,
  runTuningFits,
  acceptFit as acceptFitPure,
  rejectFit as rejectFitPure,
  getTuningPreviewM,
  tuningSliderBounds,
  tuningPreviewEoedRef,
  tuningPreviewLineData,
  tuningAreaHtml,
  buildTuningCharts as buildTuningChartsPure,
  updateTuningPreviewM as updateTuningPreviewPure
} from './tuning/index.js';
import { installPileApp } from './pile/index.js';
import { installSettlementApp } from './settlement/index.js';
import { installDewateringApp } from './dewatering/index.js';
import { installBeamApp } from './beam/index.js';
// Seep / Slope state package (refactor step 9a / PR 18a, src/lib/cpt-app/seepslope/state/): the
// pure helpers keep their monolith names as import aliases (their signatures never read `S`);
// the operations that read the active CPT, the Stage 6 UI state or generate entity ids are
// wrapped by façades in the bishop state regions below (the `seepslope*` aliases).
import {
  sortedPolyline as stage6BishopSortedPolyline,
  autoSeepageMeshTargetArea as stage6BishopAutoSeepageMeshTargetArea,
  resolvedSeepageMeshTargetArea as stage6BishopResolvedSeepageMeshTargetArea,
  autoDeformationMeshTargetArea as stage6BishopAutoDeformationMeshTargetArea,
  resolvedDeformationMeshTargetArea as stage6BishopResolvedDeformationMeshTargetArea,
  sortZone as stage6BishopSortZone,
  validZone as stage6BishopValidZone,
  zoneKey as stage6BishopZoneKey,
  zoneLabel as stage6BishopZoneLabel,
  zoneColor as stage6BishopZoneColor,
  allocateSurfaceLoadId as stage6BishopAllocateSurfaceLoadId,
  normalizeSurfaceLoad as stage6BishopNormalizeSurfaceLoad,
  legacySurfaceLoadSeed as stage6BishopLegacySurfaceLoadSeed,
  migrateSurfaceLoadsShape as stage6BishopMigrateSurfaceLoadsShape,
  syncLegacySurfaceLoadMirror as seepslopeSyncLegacySurfaceLoadMirror,
  selectedSurfaceLoad as seepslopeSelectedSurfaceLoad,
  primarySurfaceLoad as seepslopePrimarySurfaceLoad,
  effectiveSurfaceLoadQ as seepslopeEffectiveSurfaceLoadQ,
  surfaceLoadSummary as seepslopeSurfaceLoadSummary,
  activeSurfaceLoads as seepslopeActiveSurfaceLoads,
  setSurfaceLoadField as seepslopeSetSurfaceLoadField,
  selectSurfaceLoad as seepslopeSelectSurfaceLoad,
  deleteSurfaceLoad as seepslopeDeleteSurfaceLoad,
  createSurfaceLoadFromZone as seepslopeCreateSurfaceLoadFromZone,
  passiveSideLabel as stage6BishopPassiveSideLabel,
  defaultPassiveSide as seepslopeDefaultPassiveSide,
  wallId as seepslopeWallId,
  defaultWallMaterial as stage6BishopDefaultWallMaterial,
  wallMaterialPreset as stage6BishopWallMaterialPreset,
  wallMaterialPresetKey as stage6BishopWallMaterialPresetKey,
  normalizeWalls as stage6BishopNormalizeWalls,
  resultWallLabel as stage6BishopResultWallLabel,
  setWallField as seepslopeSetWallField,
  setWallMaterialField as seepslopeSetWallMaterialField,
  deleteWall as seepslopeDeleteWall,
  selectWall as seepslopeSelectWall,
  drainId as seepslopeDrainId,
  normalizeDrains as stage6BishopNormalizeDrains,
  defaultDrainHead as stage6BishopDefaultDrainHead,
  drainValidationSummary as stage6BishopDrainValidationSummary,
  drainGatingLabel as stage6BishopDrainGatingLabel,
  createDrainFromVertices as seepslopeCreateDrainFromVertices,
  selectDrain as seepslopeSelectDrain,
  setDrainField as seepslopeSetDrainField,
  deleteDrain as seepslopeDeleteDrain,
  regionId as seepslopeRegionId,
  roundRegionCoord as stage6BishopRoundRegionCoord,
  normalizeRegionCoarseness as stage6BishopNormalizeRegionCoarseness,
  clampRegionPoint as stage6BishopClampRegionPoint,
  normalizeCustomRegions as stage6BishopNormalizeCustomRegions,
  selectedCustomRegion as seepslopeSelectedCustomRegion,
  setSelectedRegion as seepslopeSetSelectedRegion,
  copyCurrentRegionsToCustom as seepslopeCopyCurrentRegionsToCustom,
  setUseCustomRegions as seepslopeSetUseCustomRegions,
  clearCustomRegions as seepslopeClearCustomRegions,
  deleteSelectedRegion as seepslopeDeleteSelectedRegion,
  setSelectedRegionMaterial as seepslopeSetSelectedRegionMaterial,
  setSelectedRegionCoarseness as seepslopeSetSelectedRegionCoarseness,
  splitSelectedRegion as seepslopeSplitSelectedRegion
} from './seepslope/state/index.js';
// Seep / Slope model package (refactor step 9b / PR 18b, src/lib/cpt-app/seepslope/model/): the
// soil-model sync as a pure patch of the bishop block and the result invalidation as pure state
// transitions; the façades below (stage6BishopSyncSoilModel, stage6BishopInvalidate*) keep the
// monolith names, apply the patch to `S.stage6.bishop` and terminate the workers.
import {
  syncSoilModel as seepslopeSyncSoilModel,
  applySoilModelPatch as seepslopeApplySoilModelPatch,
  invalidateSeepage as seepslopeInvalidateSeepage,
  invalidateDeformation as seepslopeInvalidateDeformation,
  invalidateBishop as seepslopeInvalidateBishop,
  invalidateWallGeometry as seepslopeInvalidateWallGeometry
} from './seepslope/model/index.js';
// Seep / Slope run package (refactor step 9c / PR 18c, src/lib/cpt-app/seepslope/run/): each of
// the three runs is a pure request builder (state → worker message) plus a pure result reducer
// (worker message → state patch, the run-id guard included); the worker lifecycle lives behind
// one `createWorkerAdapter()` instance, so the controller no longer holds worker singletons in
// closure. The run/stop/progress façades below keep the monolith names and own the three host
// halves the package cannot: ensureStage6State(), the DOM, and `S`.
import {
  applyRunPatch as seepslopeApplyRunPatch,
  createWorkerAdapter as seepslopeCreateWorkerAdapter,
  prepareSearch as seepslopePrepareSearch,
  searchNoWorkerPatch as seepslopeSearchNoWorkerPatch,
  buildSearchInput as seepslopeBuildSearchInput,
  searchRequest as seepslopeSearchRequest,
  startSearchPatch as seepslopeStartSearchPatch,
  reduceSearchMessage as seepslopeReduceSearchMessage,
  searchWorkerErrorPatch as seepslopeSearchWorkerErrorPatch,
  stopSearchPatch as seepslopeStopSearchPatch,
  prepareSeepage as seepslopePrepareSeepage,
  seepageNoWorkerPatch as seepslopeSeepageNoWorkerPatch,
  buildSeepageInputModel as seepslopeBuildSeepageInputModel,
  seepageRequest as seepslopeSeepageRequest,
  startSeepagePatch as seepslopeStartSeepagePatch,
  reduceSeepageMessage as seepslopeReduceSeepageMessage,
  seepageWorkerErrorPatch as seepslopeSeepageWorkerErrorPatch,
  stopSeepagePatch as seepslopeStopSeepagePatch,
  prepareDeformation as seepslopePrepareDeformation,
  deformationNoWorkerPatch as seepslopeDeformationNoWorkerPatch,
  buildDeformationOptions as seepslopeBuildDeformationOptions,
  deformationRequest as seepslopeDeformationRequest,
  startDeformationPatch as seepslopeStartDeformationPatch,
  reduceDeformationMessage as seepslopeReduceDeformationMessage,
  deformationWorkerErrorPatch as seepslopeDeformationWorkerErrorPatch,
  stopDeformationPatch as seepslopeStopDeformationPatch,
  searchProgressDom as seepslopeSearchProgressDom,
  runningMessage as seepslopeRunningMessage,
  readyMessage as seepslopeReadyMessage,
  // The four label helpers the runs share with the results / panel regions (step 9f): the run is
  // their only writer, so they moved with it and keep their monolith names as import aliases.
  methodModeLabel as stage6BishopMethodModeLabel,
  secondsLabelFromMs as stage6SecondsLabelFromMs,
  seepageFlowErrorLabel as stage6SeepageFlowErrorLabel,
  safetyFinalizationStatusFromSolver as stage6SafetyFinalizationStatusFromSolver,
  completeMessage as stage6BishopCompleteMessage,
  seepageCompleteMessage as stage6BishopSeepageCompleteMessage
} from './seepslope/run/index.js';
// Seep / Slope geometry package (refactor step 9d / PR 18d, src/lib/cpt-app/seepslope/geometry/):
// the section maths — points and segments, polygons and their validators, boundary picking,
// splitting and hole subtraction, the regions a canvas shows, the shared Measure tool's line.
// Everything here is pure, so the monolith names are import aliases; the three that read `S`, the
// viewport or the results region (TooltipHtml, DisplayRegions, PickRegionBoundaryPoint) are
// façades in the geometry region below. The pointer / snapping / viewport handling that *uses*
// them stays in the controller until step 9e.
import {
  dist as stage6BishopDist,
  segmentOrientation as stage6BishopSegmentOrientation,
  pointOnSegment as stage6BishopPointOnSegment,
  segmentsIntersectClosed as stage6BishopSegmentsIntersectClosed,
  closestPointOnSegment as stage6BishopClosestPointOnSegment,
  uniqueSortedNumbers as stage6BishopUniqueSortedNumbers,
  pointInPolygon as stage6BishopPointInPolygon,
  pointInsideOrBoundary as stage6BishopPointInsideOrBoundary,
  polygonCentroid as stage6BishopPolygonCentroid,
  polygonIsValid as stage6BishopPolygonIsValid,
  validateHolePolygon as stage6BishopValidateHolePolygon,
  pickRegionBoundaryPoint as seepslopePickRegionBoundaryPoint,
  traverseBoundary as stage6BishopTraverseBoundary,
  buildSplitBoundary as stage6BishopBuildSplitBoundary,
  boundaryYAtX as stage6BishopBoundaryYAtX,
  polygonIntervalsDetailed as stage6BishopPolygonIntervalsDetailed,
  subtractDetailedIntervals as stage6BishopSubtractDetailedIntervals,
  subtractHoleFromPolygon as stage6BishopSubtractHoleFromPolygon,
  splitRegionPolygon as stage6BishopSplitRegionPolygon,
  displayRegions as seepslopeDisplayRegions,
  showingCustomRegionPreview as stage6BishopShowingCustomRegionPreview,
  regionAtPoint as stage6BishopRegionAtPoint,
  regionTooltipHtml as seepslopeRegionTooltipHtml,
  regionShortLabel as stage6BishopRegionShortLabel,
  regionLegendItems as stage6BishopRegionLegendItems,
  measurementMetrics as stage6BishopMeasurementMetrics,
  measurementLabel as stage6BishopMeasurementLabel,
  measurementVectors as stage6BishopMeasurementVectors
} from './seepslope/geometry/index.js';
// Seep / Slope line probe (refactor step 9d / PR 18d, src/lib/cpt-app/seepslope/probe/): the
// quantity catalogue per workspace, the sampler along the Measure tool's line, and the clipboard
// readout. `lineProbeOptions` / `lineProbeMeta` / `buildLineProbe` take the host `env` of
// SEEPSLOPE_PROBE_ENV (the HS UI flag and the two contour catalogues that are not extracted yet),
// so they are façades below; the formatters and the clipboard text are pure.
import {
  lineProbeOptions as seepslopeLineProbeOptions,
  lineProbeMeta as seepslopeLineProbeMeta,
  lineProbeFormatValue as stage6BishopLineProbeFormatValue,
  clipboardNumber as stage6ClipboardNumber,
  lineProbeClipboardValueHeader as stage6BishopLineProbeClipboardValueHeader,
  lineProbeClipboardText as stage6BishopLineProbeClipboardText,
  lineProbeStats as stage6BishopLineProbeStats,
  integrateLineProbe as stage6BishopIntegrateLineProbe,
  buildLineProbe as seepslopeBuildLineProbe
} from './seepslope/probe/index.js';
// Seep / Slope canvas package (refactor step 9e / PR 18e, src/lib/cpt-app/seepslope/canvas/):
// the viewport (world ↔ screen, fit, zoom / pan, every px → world tolerance), the picking and
// snapping, the {down, move, up, cancel} pointer state machine, the pure view model and the
// fourteen `draw/*` layers behind one sequencer. Every monolith name below survives as a façade in
// the canvas region: they own `S`, the canvas element, the device-pixel ratio, the model cache and
// the tooltip DOM — the package owns everything else, and reads none of them.
import {
  worldToScreen as seepslopeWorldToScreen,
  screenToWorldFromClient as seepslopeScreenToWorldFromClient,
  snapToleranceWorld as seepslopeSnapToleranceWorld,
  boundaryPickToleranceWorld as seepslopeBoundaryPickToleranceWorld,
  canvasWorldBounds as seepslopeCanvasWorldBounds,
  fitViewport as seepslopeFitViewport,
  gridSpec as seepslopeGridSpec,
  currentDragKey as seepslopeCurrentDragKey,
  snapPointKey as seepslopeSnapPointKey,
  collectSnapPoints as seepslopeCollectSnapPoints,
  nearestPointSnap as seepslopeNearestPointSnap,
  snapWorldPoint as seepslopeSnapWorldPoint,
  nearestHandle as seepslopeNearestHandle,
  pickSurfaceLoadAtWorld as seepslopePickSurfaceLoadAtWorld,
  pickWallAtWorld as seepslopePickWallAtWorld,
  commitDrawPoint as seepslopeCommitDrawPoint,
  completeCurrentActionAt as seepslopeCompleteCurrentActionAt,
  hoverUpdate as seepslopeHoverUpdate,
  pointerDown as seepslopePointerDown,
  pointerMove as seepslopePointerMove,
  pointerUp as seepslopePointerUp,
  pointerLeave as seepslopePointerLeave,
  wheel as seepslopeWheel,
  buildCanvasViewModel as seepslopeBuildCanvasViewModel,
  drawCanvasFrame as seepslopeDrawCanvasFrame,
  drawGrid as seepslopeDrawGrid
} from './seepslope/canvas/index.js';
// Seep / Slope panels package (refactor step 9f / PR 18f, src/lib/cpt-app/seepslope/panels/):
// the 2 392-line `renderStage6BishopApp` split by `data-st6details` group — one module per
// collapsible section, plus the tool rail, the eight canvas sheets, the results panel, the header
// and a layout.js that composes them in exactly the monolith's order over one pure view model.
// Every module is a pure string builder over `(vm, env)`; the façades in the panel region below
// keep the monolith names and own the host halves — `S`, the volatile Stage 6 cache and the
// regions step 9f must not touch (SEEPSLOPE_PANELS_ENV).
import {
  buildPanelsViewModel as seepslopeBuildPanelsViewModel,
  bishopAppHtml as seepslopeBishopAppHtml,
  canvasToolRailHtml as seepslopeCanvasToolRailHtml,
  wallInfoPanelHtml as seepslopeWallInfoPanelHtml,
  canvasToolButton as seepslopeCanvasToolButton,
  toolIcon as seepslopeToolIcon,
  depthBandReportHtml as seepslopeDepthBandReportHtml,
  modeMeta as seepslopeModeMeta,
  partialLoadBadgeHtml as seepslopePartialLoadBadgeHtml,
  resultMethodLabel as seepslopeResultMethodLabel,
  seepageTerminationLabel as seepslopeSeepageTerminationLabel,
  strengthSetLabel as seepslopeStrengthSetLabel,
  wallMechanicalLabel as seepslopeWallMechanicalLabel,
  safetyCurveHtml as seepslopeSafetyCurveHtml,
  safetyMechanismHtml as seepslopeSafetyMechanismHtml
} from './seepslope/panels/index.js';
// Seep / Slope report package (refactor step 9g / PR 18g, src/lib/cpt-app/seepslope/report/):
// the Stage 7 workspace screenshot, rasterised on an offscreen canvas from a view model built for
// the target workspace. It replaces the app / workspace switch + double re-render of
// 01-monolith-map.md §3.4 #10; the façades in the Stage 7 region below own the host halves — the
// canvas factory, the frame box, the section model and the theme.
import {
  bishopCanvasProbeHtml as seepslopeBishopCanvasProbeHtml,
  bishopWorkspaceCapture as seepslopeBishopWorkspaceCapture,
  isCaptureWorkspace as seepslopeIsCaptureWorkspace,
  manualCaptureDisplay as seepslopeManualCaptureDisplay,
  rasteriseCanvas as seepslopeRasteriseCanvas
} from './seepslope/report/index.js';
/* ════════════════════════════════
   STATE
════════════════════════════════ */
let __legacyControllerInitialized = false;
let __legacyControllerHashBound = false;
// The three Seep / Slope workers and their run ids (map §3.4 #8) live in this adapter instead of
// six module variables; nothing outside the run façades below touches it.
const stage6BishopWorkers = seepslopeCreateWorkerAdapter();
let classificationRefreshTimer = null;
const stage6BishopCanvasState = {
  canvas:null,
  pointerDrag:null,
  hoverWorld:null
};
// The Hardening Soil *deformation solver* (Stage 6) remains in the lower-level
// solver code while it is being validated, but the production UI must not
// expose it until the model is convergence- and benchmark-ready.
const STAGE6_ENABLE_HARDENING_SOIL_UI = false;
// The Stage 4 Hardening Soil *parameter display* is decoupled from the solver
// gate above: E_oed,i / E_oed,ref / E_50,ref / E_ur,ref / m are pure CPT
// correlations (Sanglerat / SB260 -> CUR 2003-7) already exported to the CSV,
// PLAXIS commands, and the Stage 7 report, so they are shown in the Stage 4
// model-parameters card regardless of the deformation-solver readiness.
const STAGE4_ENABLE_HARDENING_SOIL_PARAMS = true;

// Stage 6 "Retaining walls" application — self-contained module wired in via a
// small context (live state accessor + render trigger + CPT layer accessor).
const retainingApp = installRetainingApp({
  getState: () => S,
  requestRender: () => renderStage6(),
  workingLayers: () => stage6WorkingLayers(),
  // CPT trace of the active sounding for the drivability estimator (q_c MPa, f_s kPa)
  getCpt: () => ({
    id: S.meta?.testid || S.id || 'CPT',
    depth: (S.data || []).map((r) => r.z),
    qc: (S.data || []).map((r) => r.qc),
    fs: (S.data || []).map((r) => (r.fs != null && Number.isFinite(r.fs) ? r.fs * 1000 : null)),
    waterTable: S.wt
  }),
  getProjectMeta: () => ({ projectName: PROJECT.name, cptId: S.meta?.testid || S.id || 'CPT', appVersion: (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.5.x') })
});

// Stage 6 "Bearing capacity" application — src/lib/cpt-app/bearing/ (refactor step 7 / PR 12a),
// installed like the retaining app: live-state accessor, the composed ensure, the Stage 4 → 6
// layer contract and the <details> memory of the shell. Hoisted function references only.
const bearingApp = installBearingApp({
  getState: () => S,
  ensure: () => ensureStage6State(),
  workingLayers: () => stage6WorkingLayers(),
  detailsOpen: (key) => stage6DetailsOpen(key)
});

// Stage 6 "Piles" application — src/lib/cpt-app/pile/ (refactor step 7 / PR 12b), wired like the
// retaining app: live-state accessor, the Stage 6 render trigger (drag end), the working-layer
// contract, the layer bottom, the composed ensure (re-clamp before a live drag frame) and the
// <details> memory of the shell. Hoisted function references only.
const pileApp = installPileApp({
  getState: () => S,
  requestRender: () => renderStage6(),
  workingLayers: () => stage6WorkingLayers(),
  layerBottom: () => stage6MaxDepth(),
  ensure: () => ensureStage6State(),
  detailsOpen: (key) => stage6DetailsOpen(key)
});

// Stage 6 "Settlement" application — src/lib/cpt-app/settlement/ (refactor step 7 / PR 12c):
// live-state accessor, the layer bottom (depth axis of the stress chart) and the <details>
// memory of the shell. Hoisted function references only.
const settlementApp = installSettlementApp({
  getState: () => S,
  layerBottom: () => stage6MaxDepth(),
  detailsOpen: (key) => stage6DetailsOpen(key)
});

// Stage 6 "Dewatering" application — src/lib/cpt-app/dewatering/ (refactor step 7 / PR 12c):
// live-state accessor (wt, stage6, stage6Cache) and the layer bottom (depth axis of the
// effective-stress chart). Hoisted function references only.
const dewateringApp = installDewateringApp({
  getState: () => S,
  layerBottom: () => stage6MaxDepth()
});

// Stage 6 "Beam / slab on Winkler" application — src/lib/cpt-app/beam/ (refactor step 7 / PR 12c):
// live-state accessor and the <details> memory of the shell. Hoisted function references only.
const beamApp = installBeamApp({
  getState: () => S,
  detailsOpen: (key) => stage6DetailsOpen(key)
});

// Stage 6 shell — the ordered app registry (app switch cards + per-app state schema) and the
// shell renderer (ensure → compute → body → post-render), src/lib/cpt-app/stage6/. The five
// analysis apps' bodies come from the installed bearing/, pile/, settlement/, dewatering/ and
// beam/ packages (step 7); the bishop body is still this file's render function until step 9. All
// are handed to the shell as closures keyed by app id (unknown ids fall back to beam, the `else`
// branch of the old chain). Hoisted function references only — nothing runs here.
const stage6Registry = createStage6Registry({
  retaining: retainingApp,
  bishopEnabled: () => stage6BishopEnabled()
});
const stage6Shell = createStage6Shell({
  registry: stage6Registry,
  getState: () => S,
  ensure: () => ensureStage6State(),
  rememberDetailsState: () => stage6RememberDetailsState(),
  workingLayers: () => stage6WorkingLayers(),
  apps: {
    bearing: {
      compute: (layers) => bearingApp.compute(layers),
      body: (profile) => bearingApp.renderBody(profile),
      postRender: () => bearingApp.postRender()
    },
    pile: {
      compute: (layers) => pileApp.compute(layers),
      body: (analysis) => pileApp.renderBody(analysis),
      postRender: () => pileApp.postRender()
    },
    settlement: {
      compute: (layers) => settlementApp.compute(layers),
      body: (analysis) => settlementApp.renderBody(analysis),
      postRender: () => settlementApp.postRender()
    },
    dewatering: {
      compute: (layers) => dewateringApp.compute(layers),
      body: (analysis) => dewateringApp.renderBody(analysis),
      postRender: () => dewateringApp.postRender()
    },
    beam: {
      compute: (layers) => beamApp.compute(layers),
      body: (analysis) => beamApp.renderBody(analysis),
      postRender: () => beamApp.postRender()
    },
    retwall: {
      body: () => retainingApp.renderBody(),
      postRender: () => retainingApp.postRender()
    },
    bishop: {
      body: () => renderStage6BishopApp(),
      postRender: () => { initStage6BishopCanvas(); buildStage6BishopLineProbeChart(); buildStage6BishopWallCharts(); }
    }
  }
});

// Multi-CPT stratigraphy application (Correlatie phase + Doorsnede geometry).
// Self-contained module (src/lib/cpt-app/stratigraphy/) wired via a small
// context. layerParamsFor evaluates the Stage 4 parameter derivation in the
// member layer's own CPT context (model-params ctx built from that CPT).
const stratigraphyApp = installStratigraphyApp({
  getProject: () => PROJECT,
  layerParamsFor: (cpt, layer) => {
    const ctx = cptModelCtx(cpt);
    return { hs: hsParamsPure(layer, ctx), kh: khParamsPure(layer, ctx) };
  },
  requestSectionRender: () => { if(PROJECT.phase==='section') renderSection(); }
});

// Project save/load — full-project snapshot to/from a .madep.json file so an
// engineer resumes exactly where they left off (CPTs, layer models with
// manual overrides, settings, Stage 6 state, stratigraphy, phase + stage).
const projectIO = installProjectIO({
  getProject: () => PROJECT,
  newCptState,
  getActiveStage: () => {
    const panels=[...document.querySelectorAll('.panel')];
    const idx=panels.findIndex(p=>p.classList.contains('active'));
    return idx<0?0:idx;
  },
  afterLoad: ({activeCptIdx, activeStage, phase}) => {
    renderBanner();
    selectCpt(activeCptIdx);
    // Rebuild the classification-stage DOM through the same path the user
    // took, then restore the saved layer model over the auto-detected one —
    // detectLayers() would otherwise discard manual subtype/parameter edits.
    const savedLayers=S.layers;
    if(S.data.length && (activeStage>=1 || savedLayers.length)){
      runClass();
      if(savedLayers.length){
        S.layers=savedLayers;
        drawLayerColumnSvg('layerColSvg', S.layers, S.data[S.data.length-1].z+0.5);
        const thkInfo=document.getElementById('minThkInfo');
        if(thkInfo) thkInfo.textContent='-> '+S.layers.length+' layers';
      }
    }
    goS(activeStage);
    setPhase(phase);
  }
});

/* ════════════════════════════════
   PROJECT STATE — multi-CPT architecture
   S is always a reference to the active CPT's state object.
   All existing functions (parseGEF, runClass, renderLayers, hsParams, etc.)
   use S and require no changes — they transparently operate on the active CPT.
════════════════════════════════ */
function newCptState(id){
  return{
    id: id||'CPT',
    x: null, y: null,           // site coordinates (m, local or RD)
    data:[], wt:1.7, wtFromFile:false,
    wtSource:null,
    elev:null, elevFromFile:false, elevSource:null,
    minThk:0.50,
    smartMerge:true,
    smartMergeSensitivity:1.10,
    // Friction ratio assumed for readings without measured fs/Rf (legacy
    // qc-only files). Explicit and user-tunable — see assumedRfValue().
    assumedRf:DEFAULT_ASSUMED_RF,
    method:'robertson2016',
    alphaMethod:'B',
    stiffMethod:'B',
    khKvMethod:'A',  // 'A' = OVAM / I/RA/11461 (default); 'B' = Bear (1979) academic
    paramMethod:'sb260',
    stage6: stage6Defaults(),
    stage6Cache:{},
    classified:[], layers:[],
    charts:{}, chartsReady:false,
    meta:{}, tuning:null, useSB260params:false,
  };
}

const PROJECT={
  name:'CPT Project',
  cpts:[newCptState('CPT-1')],
  activeCptIdx:0,
  phase:'analysis',     // 'analysis' | 'correlation' | 'section'
  stratigraphy:null,    // owned by the stratigraphy store (multi-CPT units)
  sectionOrder:[0],
};

// S is a live reference to the active CPT — all existing code uses S unchanged
let S=PROJECT.cpts[0];

/* Re-point the active CPT: PROJECT.activeCptIdx and S move together (core/state.js
   setActiveCpt). The only write of S after its declaration. */
function setActive(idx){
  S=setActiveCpt(PROJECT, idx);
  return S;
}

// Banner, CPT list, phase and stage navigation — src/lib/cpt-app/project/ (PR 14). The
// wrappers below keep their names for legacyApi and the inline onclick strings; every hook
// is a hoisted function reference or a closure over PROJECT / S, nothing runs here.
const projectApp = installProject({
  document,
  getProject: () => PROJECT,
  getActive: () => S,
  setActive,
  newCptState,
  confirm: (message) => confirm(message),
  // Every Stage 6 worker of the CPT being left, incl. the deformation worker (map §3.4 #8 /
  // PLAN §4 defect 2): its messages for the old runId would be dropped after the switch and
  // the originating CPT stayed at deformation.progress.running = true with nothing to finish it.
  stopWorkers: () => { stage6BishopStopSearch(true); stage6BishopStopSeepage(true); stage6BishopStopDeformation(true); },
  cancelClassificationRefresh: () => cancelClassificationRefresh(),
  syncClassificationMethodCards: (method) => syncClassificationMethodCards(method),
  initCharts: () => initCharts(),
  drawLayerColumnSvg: (svgId, layers, maxZ) => drawLayerColumnSvg(svgId, layers, maxZ),
  renderCorrelation: () => stratigraphyApp.render(),
  renderSection: () => renderSection(),
  renderStage: (n) => {
    if(n===2)renderLayers();
    if(n===3)renderModel();
    if(n===4)renderTuning();
    if(n===5)renderStage6();
  }
});

function selectCpt(idx){
  projectApp.selectCpt(idx);
}

function addCpt(){
  projectApp.addCpt();
}

function setCptName(idx, name){
  projectApp.setCptName(idx, name);
}

/* ════════════════════════════════
   BANNER + PHASE MANAGEMENT
════════════════════════════════ */
function renderBanner(){
  projectApp.renderBanner();
}

function removeCpt(idx){
  projectApp.removeCpt(idx);
}

function setPhase(ph){
  projectApp.setPhase(ph);
}

/* ════════════════════════════════
   MULTI-CPT FILE LOAD
════════════════════════════════ */
/* File-kind sniffing and the serial loader live in load/ (file-kind.js,
   import-files.js). Each file is parsed for its explicit target CPT — the
   importers apply the patch to that CPT and sync the Stage 1 DOM from it —
   so S and PROJECT.activeCptIdx are never re-pointed during an import. */
const cptFileImporters={
  gef:async(txt,fname,cpt)=>importParsedCpt(cpt, parseGefPure(txt,fname)),
  csv:async(text,fname,cpt)=>importParsedCpt(cpt, parseCsvPure(text,fname)),
  excel:async(buffer,fname,cpt)=>importParsedCpt(cpt, parseExcelPure(await loadXlsxModule(),buffer,fname))
};

/* Reads files serially because parsing still drives shared DOM/chart state. */
function importCptFiles(files){
  importCptFilesPure(files,{
    project:PROJECT,
    newCptState,
    importers:cptFileImporters,
    onImported:(targetIdx,isFirst)=>{
      if(isFirst){
        // First file: stay on this CPT, update display
        selectCpt(targetIdx);
      } else {
        // Additional files: the active CPT is unchanged, refresh the banner
        renderBanner();
      }
    },
    renderBanner,
    // A file that could not be read is reported, not acknowledged: the loader is already moving on
    // to the next file, so a modal would stack in front of the queue (design §3.15).
    notify:(message)=>toast(message,{tone:'bad'})
  });
}

function importGEFFiles(files){
  importCptFiles(files);
}

/* Multi-CPT file load — one picker action can create multiple CPT tabs. */
function loadGEF(evt){
  const files=Array.from(evt.target.files||[]);
  evt.target.value='';
  importCptFiles(files);
}

function setCptCoord(axis, val){
  const v=parseFloat(val);
  S[axis]=isNaN(v)?null:v;
  // No renderBanner needed — coordinates don't affect banner display
}

/* layerTypeCompatScore (cross-CPT layer compatibility, shared by the Stage 3
   smart merge and the section view) lives in layers/tabel3-compat.js (PR 6). */


/* ════════════════════════════════
   PHASE C — GEOLOGICAL CROSS-SECTION
════════════════════════════════ */
// The SVG builder, tooltip and export live in src/lib/cpt-app/section/ (PR 14); the
// projection comes from the stratigraphy module (one chainage for the section, the
// correlation panel and the DXF export).
const sectionApp = installSection({
  document,
  getProject: () => PROJECT,
  projection: () => stratigraphyApp.projection(),
  sectionGeometry: () => stratigraphyApp.sectionGeometry(),
  readToken: readCssToken
});

function sectionProjection(){
  return sectionApp.sectionProjection();
}

function renderSection(){
  sectionApp.renderSection();
}

function bindSectionTooltip(){
  sectionApp.bindSectionTooltip();
}

function exportSectionSVG(){
  sectionApp.exportSectionSVG();
}

/* ════════════════════════════════
   SOIL DEFS
════════════════════════════════ */
const SC = SOIL_CLASS_NAMES;

/* ════════════════════════════════
   NAVIGATION
════════════════════════════════ */
function goS(n){
  projectApp.goS(n);
}
bindStageNav(document, goS);


/* ════════════════════════════════
   CPT FILE PARSERS
   The format readers are pure and live in load/parsers/ (gef.js, csv.js,
   excel.js + excel-headers.js); number parsing, unit conversion and tabular
   row building in import-review/ (shared with the review dialog). Here
   remain the handshake — parse → review dialog → apply — and the wrappers
   under the old names for the active CPT.
════════════════════════════════ */
/* Review → apply for an explicit CPT (the seam used by the multi-file loader). */
async function importParsedCpt(cpt, parsed){
  if(!parsed.ok){alert(parsed.error);return false;}
  const review=await presentImportReview(reviewStaging(parsed, normalizeAssumedRf(cpt.assumedRf).toFixed(1)));
  if(!review) return false;
  return applyParsedCptTo(cpt, {...parsed, rows:review.rows});
}

/* Assign the parsed patch to the CPT and sync the Stage 1 DOM from it; the
   charts are (re)built on the next frame for the CPT active at that time. */
function applyParsedCptTo(cpt, parsed){
  const patch=applyParsedCptPure(cpt, parsed);
  if(!patch){toast(NO_DATA_ROWS_MESSAGE,{tone:'warn'});return false;}
  Object.assign(cpt, patch);
  syncParsedCptDom(document, cpt);
  requestAnimationFrame(()=>initCharts());
  return true;
}

function applyParsedCpt(parsed){
  return applyParsedCptTo(S, parsed);
}

async function parseExcelCpt(buffer,fname){
  return cptFileImporters.excel(buffer,fname,S);
}

async function parseCsvCpt(text,fname){
  return cptFileImporters.csv(text,fname,S);
}

/* ════════════════════════════════
   GEF PARSER
════════════════════════════════ */
async function parseGEF(txt,fname){
  return cptFileImporters.gef(txt,fname,S);
}

function updateElevSrc(){
  renderElevationSource(document, S);
}
function updateWTDisplay(){
  renderWaterTableDisplay(document, S);
}

function renderMeta(){
  renderMetaCard(document, S);
}

/* ════════════════════════════════
   CONTROLS: elevation, WT, min-thickness
════════════════════════════════ */
function setElev(v){
  S.elev=(isNaN(v)||v==='')?null:v;
  S.elevFromFile=false;
  S.elevSource=null;
  updateElevSrc(); updateWTDisplay();
  // Re-render layers if they exist (TAW column changes)
  if(S.layers.length&&document.getElementById('p2').classList.contains('active'))renderLayers();
}

function setWT(v,fromInput){
  if(isNaN(v)||v<0)return;
  S.wt=v;
  S.wtFromFile=false;
  S.wtSource=null;
  if(fromInput)document.getElementById('wtR').value=v;
  else document.getElementById('wtN').value=v.toFixed(2);
  updateWTDisplay();
  // Update only the WT annotation line on each chart — no rebuild
  if(S.chartsReady){
    const d=S.data;
    const maxZ=d[d.length-1].z+0.5;
    const maxQc=Math.max(1,arrMax(d.map(r=>r.qc)));
    // Same floor as initCharts — without it a qc-only file collapses the fs
    // chart's WT line to a zero-length segment (line disappears).
    const maxFs=Math.max(10,arrMax(d.map(r=>r.fs!=null?r.fs*1000:0)));
    updateWTLine(S.charts.qc, v, maxQc*1.15);
    updateWTLine(S.charts.fs, v, maxFs*1.15);
    updateWTLine(S.charts.rf, v, 12);
  }
}

function updateWTLine(chart,wt,xmax){
  if(!chart)return;
  chart.data.datasets[1].data=[{x:0,y:wt},{x:xmax,y:wt}];
  chart.update('none'); // no animation
}

/* ── Assumed Rf (qc-only files) ──
   Shown only when the loaded CPT has readings without measured Rf. The value
   feeds every classification method through assumedRfValue(). */
function setAssumedRf(v){
  const n=Number(v);
  if(!Number.isFinite(n)||n<=0){
    // Rejected input: snap the field back to the value actually in use.
    updateAssumedRfControls();
    return;
  }
  S.assumedRf=normalizeAssumedRf(n);
  updateAssumedRfControls();
  updateRawChartEmptyStates();
  // Re-run the full classification chain so table, layers and previews stay
  // consistent with the new assumption.
  if(S.classified.length) runClass();
}

function updateAssumedRfControls(){
  renderAssumedRfControls(document, S);
}

function cancelClassificationRefresh(){
  if(classificationRefreshTimer!=null){
    clearTimeout(classificationRefreshTimer);
    classificationRefreshTimer=null;
  }
}

function refreshClassificationDerivedViews(){
  cancelClassificationRefresh();
  if(!S.classified.length) return;
  detectLayers();
  renderLayerPreviewSvg('layerPreviewSvg');
  const layerColSvg=document.getElementById('layerColSvg');
  if(layerColSvg) drawLayerColumnSvg('layerColSvg',S.layers,S.data[S.data.length-1]?.z+0.5||20);
  if(document.getElementById('p2').classList.contains('active')) renderLayers();
  const info=document.getElementById('minThkInfo');
  if(info) info.textContent=`→ ${S.layers.length} layers`;
}

function scheduleClassificationDerivedViews(delay=90){
  cancelClassificationRefresh();
  const info=document.getElementById('minThkInfo');
  if(info) info.textContent='Updating...';
  classificationRefreshTimer=setTimeout(()=>{
    classificationRefreshTimer=null;
    refreshClassificationDerivedViews();
  }, delay);
}

function setMinThk(v,fromInput){
  if(isNaN(v)||v<0.05)return;
  S.minThk=v;
  if(fromInput)document.getElementById('minThkR').value=v;
  else document.getElementById('minThkN').value=v.toFixed(2);
  document.getElementById('minThkInfo').textContent='';
  // If already classified, re-run layer detection and update preview
  if(S.classified.length){
    refreshClassificationDerivedViews();
  }
}

function setSmartMerge(v){
  S.smartMerge=!!v;
  const smartMergeControls=document.getElementById('smartMergeControls');
  if(smartMergeControls) smartMergeControls.style.display=S.smartMerge?'':'none';
  if(S.classified.length){
    refreshClassificationDerivedViews();
  }
}

function setSmartMergeSensitivity(v,fromInput){
  if(isNaN(v)) return;
  const val=Math.max(0,Math.min(6,+v));
  S.smartMergeSensitivity=val;
  const range=document.getElementById('smartMergeSensR');
  const num=document.getElementById('smartMergeSensN');
  if(fromInput){
    if(range) range.value=val.toFixed(2);
  }else{
    if(num) num.value=val.toFixed(2);
  }
  if(S.classified.length && S.smartMerge){
    scheduleClassificationDerivedViews();
  }
}

/* ════════════════════════════════
   CHARTS — created once, updated in-place
════════════════════════════════ */
function arrMax(arr){return arr.reduce((m,v)=>Math.max(m,v),-Infinity);}
function arrSafe(arr){return arr.map(v=>isNaN(v)||v==null?0:v);}

/* Shared data prep for the three Stage 1 raw-profile charts (initCharts and
   refreshChartData must stay identical). fs/Rf keep null when not measured —
   null points are dropped by ptData, NOT drawn as a fake zero-line (legacy
   qc-only files previously rendered fs=0 as a measured-looking profile). */
function buildRawChartSeries(){
  const d=S.data;
  const depths=d.map(r=>r.z);
  const qcs=arrSafe(d.map(r=>r.qc));
  const fss=d.map(r=>r.fs!=null?r.fs*1000:null);
  const rfs=d.map(r=>r.rf??null);
  return{
    depths,qcs,fss,rfs,
    maxZ:arrMax(depths)+0.5,
    maxQc:Math.max(1,arrMax(qcs))*1.15,
    maxFs:Math.max(10,arrMax(arrSafe(fss)))*1.15,
    ptData:vals=>depths.map((z,i)=>({x:vals[i],y:z})).filter(p=>p.x!=null)
  };
}

function initCharts(){
  const hasCanvases = document.getElementById('cQc') && document.getElementById('cFs') && document.getElementById('cRf');
  // If charts already exist and the canvases still exist, just update data
  if(S.chartsReady && hasCanvases && S.charts.qc && S.charts.fs && S.charts.rf){
    refreshChartData(); return;
  }
  if(typeof Chart==='undefined'){
    setTimeout(()=>initCharts(), 120);
    return;
  }
  const {qcs,fss,rfs,maxZ,maxQc,maxFs,ptData}=buildRawChartSeries();
  const wt=S.wt;

  function mk(id,vals,color,xmax,label){
    const ctx=document.getElementById(id);
    if(!ctx)return null;
    return new Chart(ctx, buildRawProfileChartConfig({
      points:ptData(vals),
      wt,
      xMax:xmax,
      maxDepth:maxZ,
      color,
      valueLabel:label
    }));
  }

  S.charts.qc=mk('cQc',qcs,readCssToken('--chart-green', '#3D6B6A'),maxQc,'qc');
  S.charts.fs=mk('cFs',fss,readCssToken('--chart-purple', '#18181A'),maxFs,'fs');
  S.charts.rf=mk('cRf',rfs,readCssToken('--chart-orange', '#8A620D'),12,'Rf');
  S.chartsReady=true;
  updateRawChartEmptyStates();

  // Layer column SVG (placeholder before classification)
  drawLayerColumnSvg('layerColSvg',[],maxZ);
}

/* Overlay note on the fs / Rf canvases when the source file never measured
   the quantity, so an empty track cannot be mistaken for a zero profile. */
function setChartEmptyState(canvasId, message){
  const canvas=document.getElementById(canvasId);
  const holder=canvas?.parentElement;
  if(!holder)return;
  let note=holder.querySelector('.chart-empty-note');
  if(message){
    if(!note){
      note=document.createElement('div');
      note.className='chart-empty-note';
      note.style.cssText='position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;font-size:11px;color:var(--tx3);pointer-events:none;padding:0 18px';
      holder.appendChild(note);
    }
    note.textContent=message;
  }else if(note){
    note.remove();
  }
}

function updateRawChartEmptyStates(){
  setChartEmptyState('cFs', cptHasFs()?null:'fs not recorded in source file');
  setChartEmptyState('cRf', cptHasRf()?null:`Rf not recorded — classification uses assumed Rf = ${assumedRfValue().toFixed(1)} %`);
}

function refreshChartData(){
  // Called if a new file is loaded after charts exist
  const {qcs,fss,rfs,maxZ,maxQc,maxFs,ptData}=buildRawChartSeries();

  function applyData(c,vals,xmax){
    c.data.datasets[0].data=ptData(vals);
    c.data.datasets[1].data=[{x:0,y:S.wt},{x:xmax,y:S.wt}];
    c.options.scales.x.max=xmax;
    c.options.scales.y.max=maxZ;
    c.update('none');
  }
  applyData(S.charts.qc,qcs,maxQc);
  applyData(S.charts.fs,fss,maxFs);
  applyData(S.charts.rf,rfs,12);
  updateRawChartEmptyStates();
}

/* ════════════════════════════════
   LAYER COLUMN SVG (Stage 1 preview)
════════════════════════════════ */
function drawLayerColumnSvg(svgId, layers, maxZ){
  const svg=document.getElementById(svgId);
  if(!svg)return;
  const W=60,H=400;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.innerHTML=buildLayerColumnSvgMarkup({
    layers,
    maxDepth:maxZ,
    wt:S.wt,
    width:W,
    height:H,
    emptyLabel:'Run class.'
  });
}

/* ════════════════════════════════
   LAYER PREVIEW SVG (Stage 2 side panel)
════════════════════════════════ */
function renderLayerPreviewSvg(svgId){
  const svg=document.getElementById(svgId);
  if(!svg||!S.layers.length)return;

  const W=240, H=520;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  svg.innerHTML=buildLayerPreviewSvgMarkup({
    layers:S.layers,
    rows:S.classified||[],
    wt:S.wt,
    width:W,
    height:H,
    showRf:cptHasRf()
  });
  svg.setAttribute('width','100%');
  bindLayerPreviewTooltip();
}

function bindLayerPreviewTooltip(){
  const svg=document.getElementById('layerPreviewSvg');
  const wrap=svg?.parentElement;
  const tip=document.getElementById('layerPreviewTip');
  if(!svg||!wrap||!tip||svg.dataset.previewTipBound==='1') return;

  function hideTip(){ tip.style.display='none'; }
  function showTip(target, evt){
    tip.innerHTML=`<strong>${target.dataset.type||''}</strong>
      <div class="mut">${target.dataset.subtype||'—'}</div>
      <div class="row"><span>Depth</span><span>${target.dataset.top}–${target.dataset.bot} m</span></div>
      <div class="row"><span>Thickness</span><span>${target.dataset.thk} m</span></div>
      <div class="row"><span>Original points</span><span>${target.dataset.points}</span></div>
      <div class="row"><span>qc original</span><span>${target.dataset.qcmin}–${target.dataset.qcmax} MPa</span></div>
      <div class="row"><span>qc layer avg</span><span>${target.dataset.qcavg} MPa</span></div>
      <div class="row"><span>Rf original</span><span>${target.dataset.rfmin}–${target.dataset.rfmax} %</span></div>
      <div class="row"><span>Rf layer avg</span><span>${target.dataset.rfavg} %</span></div>
      <div class="row"><span>fs original</span><span>${target.dataset.fsmin}–${target.dataset.fsmax} kPa</span></div>
      <div class="row"><span>fs layer avg</span><span>${target.dataset.fsavg} kPa</span></div>`;
    tip.style.display='block';
    const rect=wrap.getBoundingClientRect();
    const pad=12, tipW=250, tipH=210;
    let left=evt.clientX-rect.left+14;
    let top=evt.clientY-rect.top+14;
    if(left+tipW>rect.width-pad) left=Math.max(pad, evt.clientX-rect.left-tipW-14);
    if(top+tipH>rect.height-pad) top=Math.max(pad, evt.clientY-rect.top-tipH-14);
    tip.style.left=`${left}px`;
    tip.style.top=`${top}px`;
  }

  svg.addEventListener('mousemove',e=>{
    const target=e.target.closest?.('[data-layer-preview]');
    if(!target){ hideTip(); return; }
    showTip(target,e);
  });
  svg.addEventListener('mouseleave',hideTip);
  svg.dataset.previewTipBound='1';
}

/* ════════════════════════════════
   DEMO
════════════════════════════════ */
function loadDemo(){
  Object.assign(S, demoPatch(Math.random));
  syncDemoDom(document, S);
  requestAnimationFrame(()=>initCharts());
}

/* ════════════════════════════════
   FILE LOAD
════════════════════════════════ */
function loadSingleGEF(evt){
  const f=evt.target.files[0]; if(!f)return;
  const r=new FileReader();
  r.onload=e=>{parseGEF(e.target.result,f.name).catch(err=>toast(`Error importing ${f.name}: ${err?.message||err}`,{tone:'bad'}));};
  r.readAsText(f);
}
function bindDropzone(){
  const dz=document.getElementById('dz');
  if(!dz || dz.dataset.bound==='1') return;
  document.addEventListener('dragover',e=>{e.preventDefault();dz.classList.add('drag')});
  document.addEventListener('dragleave',e=>{if(!dz.contains(e.relatedTarget))dz.classList.remove('drag')});
  document.addEventListener('drop',e=>{
    e.preventDefault();dz.classList.remove('drag');
    const files=Array.from(e.dataTransfer?.files||[]);
    importGEFFiles(files);
  });
  dz.dataset.bound='1';
}

/* ════════════════════════════════
   METHOD SELECT
════════════════════════════════ */
function syncClassificationMethodCards(method){
  const cards={
    mRob:'robertson',
    mRob16:'robertson2016',
    mCur:'cur3',
    mNen:'nen6740',
    mSB:'sb260'
  };
  Object.entries(cards).forEach(([id, value])=>{
    const el=document.getElementById(id);
    if(el) el.classList.toggle('sel', method === value);
  });
}

function selM(m){
  S.method=m;
  syncClassificationMethodCards(m);
}

/* ════════════════════════════════
   STRESS
════════════════════════════════ */
function stressAt(z, gamma_sat, gamma_unsat){
  return stressAtPure(S, z, gamma_sat, gamma_unsat);
}

/* ════════════════════════════════
   CLASSIFICATION
════════════════════════════════ */

/* The classifier math lives in classification-core.js; the per-method
   wrappers (stress state + app settings) and the row dispatch live in
   classification/classify.js (PR 6). These wrappers feed them the active CPT.
   assumedRfValue() is the explicit friction-ratio assumption used for readings
   without measured fs/Rf. */
function assumedRfValue(){
  return assumedRfValuePure(S);
}

/* Single source of truth for fs/Rf availability — the meta flags are set at
   parse time; the S.data fallback covers states created before the flags. */
function cptHasFs(){
  return cptHasFsPure(S);
}
function cptHasRf(){
  return cptHasRfPure(S);
}

function classRob(r){
  return classRobPure(S, r);
}
function classRob2016(r){
  return classRob2016Pure(S, r);
}
function classCUR3(r){
  return classCUR3Pure(S, r);
}

const classCUR = classCUR3;

function classNEN6740(r){
  return classNEN6740Pure(S, r);
}
function classSB260(r){
  return classSB260Pure(S, r);
}

/* ════════════════════════════════
   CLASSIFICATION RUN
════════════════════════════════ */
function runClass(){
  if(!S.data.length){toast('Laad eerst een GEF bestand.',{tone:'warn'});return;}

  /* Compute (classification/run.js, pure) → assign to the active CPT → render
     the four Stage 2 regions (classification/panel.js builds the markup). */
  const result=classifyCpt(S);
  S.useSB260params=result.useSB260params;
  S.classified=result.classified;
  S.rfAssumedCount=result.rfAssumedCount;

  document.getElementById('cmet').innerHTML=classificationMetricsHtml(result.metrics);

  const assumedNote=document.getElementById('classAssumedRfNote');
  if(assumedNote) assumedNote.innerHTML=classificationAssumedRfNoteHtml(result.assumedRfNote);

  const metricHead=document.getElementById('cmetricHead');
  if(metricHead) metricHead.innerHTML=result.metricLabel;
  document.getElementById('cbody').innerHTML=classificationTableRowsHtml(result.classified,{method:S.method,elev:S.elev});

  document.getElementById('classLayout').style.display='';
  detectLayers();
  renderLayerPreviewSvg('layerPreviewSvg');
  drawLayerColumnSvg('layerColSvg',S.layers,S.data[S.data.length-1].z+0.5);
  document.getElementById('minThkInfo').textContent='-> '+S.layers.length+' layers';
  document.getElementById('btnToLayers').style.display='';
}

/* ════════════════════════════════
   LAYER DETECTION
   The detection lives in layers/ (PR 6): segments.js (summaries, similarity
   scores), merge.js (baseline / smart chains), detect.js (detectLayers →
   layers[], pure). These wrappers feed the pure functions the active CPT;
   detectLayers() assigns the result — rendering stays with its callers
   (goS(2), setParamMethod, refreshClassificationDerivedViews), as before.
════════════════════════════════ */
function segmentSummary(seg, prevSeg){
  return segmentSummaryPure(seg, prevSeg, layersCtx(S));
}

function detectLayers(){
  S.layers=detectLayersPure(S, layersCtx(S));
}

/* ════════════════════════════════
   LAYER TABLE
   
   CONCEPTUAL SEPARATION:
   - Stage 2 (classification): Robertson / CUR 3 layers / NEN 6740 / Eurocode Table 3
     → assigns CPT soil type
     per depth reading, then layers are detected. This determines the BOUNDARY logic.
   - Stage 3 (parameter method): independently assigns geotechnical parameters
     (γ, φ', c', cu) to each layer. The engineer can choose:
       • Generic DEF table (type-based defaults)
       • Eurocode / NEN Tabel 3 (full subtype catalogue with consistentie)
     These are independent of the Stage 2 classification method.
   - Stage 4 (model): derives HS/MC params from Stage 3 output.

   The subtype dropdown always shows the full Eurocode / NEN Table 3 catalogue.
   Compatible entries (matching the CPT type) are listed first and enabled.
   Potentially compatible entries (adjacent soil families) are shown with a note.
   Incompatible entries are shown in a disabled optgroup with a warning label.
   
   A warning panel below the table flags any layer where the selected subtype
   is outside the compatible or adjacent range for its CPT type.
════════════════════════════════ */

/* ── Parameter method selector (Stage 3 global) ── */
// S.paramMethod: 'sb260' | 'def'
// Set from the radio buttons rendered in renderLayers()

/* NEN / Eurocode 7 Tabel 3 catalogue (CAT), the derived classification
   entry list and the row matcher now live in eurocode-tabel3.js (imported
   at the top of this file) so the node verification scripts can exercise
   the exact table used by the app. */

/* CAT_GROUPS, the COMPAT matrix, compatLevel, qcRfFit and suggestSubtype live in
   layers/tabel3-compat.js (PR 6). */

/* Build the subtype dropdown for one layer.
   Groups: compatible entries first (enabled), adjacent (enabled, marked),
   incompatible last (disabled). */
function buildSubtypeDropdown(l, i){
  const cptType=l.type;
  const cur=l.subtype||'';
  const qc=l.avgQc;
  // null (not an assumed 3): qcRfFit then skips the Rf check, matching the
  // suggestion engine — otherwise a qc-only CPT shows no ✓ on any sand entry.
  const rf=l.avgRf??null;
  const bdCol=l.ovr.subtype?'var(--wn)':'var(--bd2)';

  // Sort entries: ok → adj → bad
  const sorted=[
    ...CAT.filter(r=>compatLevel(cptType,r.grp)==='ok'),
    ...CAT.filter(r=>compatLevel(cptType,r.grp)==='adj'),
    ...CAT.filter(r=>compatLevel(cptType,r.grp)==='bad'),
  ];

  const sections={ok:'',adj:'',bad:''};
  const grpOpen={ok:'',adj:'',bad:''};

  for(const row of sorted){
    const level=compatLevel(cptType,row.grp);
    const sel=row.subtype===cur?' selected':'';
    const grpLabel=CAT_GROUPS[row.grp]||row.grp;
    const key=level+'__'+row.grp;
    if(grpOpen[level]!==key){
      if(grpOpen[level]) sections[level]+='</optgroup>';
      const prefix=level==='adj'?'⚠ Overgang — ':'';
      sections[level]+=`<optgroup label="${prefix}${grpLabel}">`;
      grpOpen[level]=key;
    }

    // Visual fit hints — 'ok' entries never disabled (user must be able to select any)
    // 'bad' (incompatible soil family) remain disabled
    let disabled='', label=row.label, titleAttr='';
    if(level==='ok'){
      const fit=qcRfFit(row,qc,rf);
      if(fit==='match'){
        label='✓ '+row.label;            // clear best match
      } else if(fit==='close'){
        label='~ '+row.label;            // borderline
      } else {
        label='· '+row.label;            // out of range but still selectable
      }
    } else if(level==='adj'){
      label='⚠ '+row.label;             // adjacent/transition
    } else if(level==='bad'){
      disabled=' disabled';               // incompatible family — truly disabled
    }

    sections[level]+=`<option value="${row.subtype}"${sel}${disabled}>${label}</option>`;
  }
  for(const lv of ['ok','adj','bad']) if(grpOpen[lv]) sections[lv]+='</optgroup>';

  let inner=`<option value="">— kies grondsoort —</option>`;
  if(sections.ok)  inner+=sections.ok;
  if(sections.adj) inner+=`<optgroup label="── Overgang ──" disabled></optgroup>`+sections.adj;
  if(sections.bad) inner+=`<optgroup label="── Niet verwacht ──" disabled></optgroup>`+sections.bad;

  return `<select data-i="${i}" onchange="changeSubtype(this)"
    style="font-size:11px;padding:2px 4px;border:1px solid ${bdCol};border-radius:4px;
           background:var(--bg);color:var(--tx);width:100%;margin-top:3px;max-width:210px"
    >${inner}</select>`;
}

function renderLayers(){
  const taw=z=>S.elev!=null?(S.elev-z).toFixed(2):'—';
  document.getElementById('lb').innerHTML=S.layers.map((l,i)=>{
    const ed=(f,step=0.5)=>
      `<input class="input input--sm${l.ovr[f]?' ovr':''}" data-i="${i}" data-f="${f}" value="${l[f]}" type="number" step="${step}" onchange="editL(this)">`;
    const thick=(l.bot-l.top).toFixed(2);
    const dropdown=buildSubtypeDropdown(l,i);
    return`<tr>
      <td class="key" style="font-weight:600">${i+1}</td>
      <td class="num">${l.top.toFixed(2)}</td><td class="num">${l.bot.toFixed(2)}</td>
      <td class="num" style="color:var(--tx2)">${taw(l.top)}</td>
      <td class="num" style="color:var(--tx2)">${taw(l.bot)}</td>
      <td class="num">${thick} m</td>
      <td style="min-width:180px">
        <span class="pill ${SC[l.type]||'s-sand'}" style="font-size:10px">${l.type}</span>
        ${l.rfIndeterminate&&!l.ovr.subtype?'<span style="font-size:9px;color:var(--wn);border:1px solid var(--wn);border-radius:3px;padding:0 3px;margin-left:4px;vertical-align:middle" title="Geen gemeten Rf — meerdere Tabel 3 rijen passen bij deze qc. Grondsoort volgt de catalogusvolgorde; controleer de keuze.">qc-only</span>':''}
        ${dropdown}
      </td>
      <td class="num">${l.avgQc.toFixed(3)}</td>
      <td class="num">${l.avgFs!=null?(l.avgFs*1000).toFixed(1):'—'}</td>
      <td class="num">${l.avgRf!=null?l.avgRf.toFixed(2):'—'}</td>
      <td class="num">${ed('g')}</td><td class="num">${ed('gs')}</td>
      <td class="num">${ed('phi')}</td><td class="num">${ed('c')}</td><td class="num">${ed('cu',1)}</td>
    </tr>`;
  }).join('');

  // Render compatibility warnings below the table
  renderCompatWarnings();
}

function changeSubtype(sel){
  const i=+sel.dataset.i;
  const subtype=sel.value;
  if(!subtype) return;
  const l=S.layers[i];
  const entry=CAT.find(r=>r.subtype===subtype);
  if(!entry) return;

  const prevType=l.type;
  l.type=entry.type;
  l.subtype=entry.subtype;
  l.ovr.type=true;
  l.ovr.subtype=true;

  // Auto-fill DEF params — only fields not yet manually overridden
  ['g','gs','phi','c','cu'].forEach(f=>{
    if(!l.ovr[f]){ l[f]=entry[f]; }
  });

  // The soil-type pick drives the nu proposal: ANY new dropdown selection —
  // including a consistency-only refinement within the same family, since the
  // nu defaults are graded per subtype — invalidates a manual Poisson
  // override and re-proposes the subtype default (the engineer can override
  // nu again afterwards in Stage 4).
  l.ovr.nu=false;
  delete l.nu_ovr;

  renderLayers();
}

function renderCompatWarnings(){
  // Find layer warnings container — create if missing
  let warnEl=document.getElementById('layerWarnings');
  if(!warnEl){
    warnEl=document.createElement('div');
    warnEl.id='layerWarnings';
    warnEl.style.cssText='margin-top:12px';
    document.getElementById('lt').parentElement.after(warnEl);
  }

  const warnings=[];
  S.layers.forEach((l,i)=>{
    if(!l.subtype||l.subtype==='(overridden)') return;
    if(l.rfIndeterminate && !l.ovr.subtype){
      warnings.push({i,layer:i+1,cptType:l.type,subtype:l.subtype,level:'adj',
        msg:`Laag ${i+1}: <strong>${l.subtype}</strong> gekozen zonder gemeten R<sub>f</sub> (fs ontbreekt in het bronbestand). Meerdere Tabel 3 rijen passen bij qc ≈ ${l.avgQc.toFixed(1)} MPa; de parameters volgen de eerste passende rij. Controleer of overschrijf de grondsoort indien boringen of projectkennis beschikbaar zijn.`});
    }
    const entry=CAT.find(r=>r.subtype===l.subtype);
    if(!entry) return;
    const level=compatLevel(l.type, entry.grp);
    if(level==='bad'){
      warnings.push({i,layer:i+1,cptType:l.type,subtype:l.subtype,level:'bad',
        msg:`CPT classificatie = <strong>${l.type}</strong>, gekozen grondsoort = <strong>${l.subtype}</strong> — dit zijn niet-verwante grondsoorten. Controleer of de CPT classificatie correct is of pas de grondsoort aan.`});
    } else if(level==='adj'){
      warnings.push({i,layer:i+1,cptType:l.type,subtype:l.subtype,level:'adj',
        msg:`Laag ${i+1}: <strong>${l.subtype}</strong> ligt in een aangrenzende / overgangsfamilie t.o.v. CPT type <strong>${l.type}</strong>. Enkel aanvaardbaar indien bevestigd via boring, labo of projectkennis.`});
    }
  });

  if(!warnings.length){warnEl.innerHTML='';return;}

  warnEl.innerHTML=warnings.map(w=>`
    <div class="layerwarn ${w.level==='bad'?'layerwarn-bad':'layerwarn-adj'}">
      <span class="layerwarn-k">
        ${w.level==='bad'?'⚠ Waarschuwing laag '+w.layer:'ⓘ Opmerking laag '+w.layer}
      </span><br>
      <span class="layerwarn-msg">${w.msg}</span>
    </div>`).join('');
}

function editL(el){
  const i=+el.dataset.i,f=el.dataset.f;
  S.layers[i][f]=+el.value; S.layers[i].ovr[f]=true; el.classList.add('ovr');
}

function editAlpha(el){
  const i=+el.dataset.i;
  S.layers[i].aE_ovr=+el.value; S.layers[i].ovr.aE=true;
  el.classList.add('ovr');
  renderModel();
}

function editM(el){
  const i=+el.dataset.i;
  S.layers[i].m_ovr=+el.value; S.layers[i].ovr.m=true;
  el.classList.add('ovr');
  renderModel();
}

function editRShear(el){
  const i=+el.dataset.i;
  const numeric=Number(el.value);
  if(!Number.isFinite(numeric)) return;
  S.layers[i].rShear_ovr=Math.max(Math.min(numeric, 1), 0.01);
  S.layers[i].ovr.rShear=true;
  el.classList.add('ovr');
  renderModel();
}

function editNu(el){
  const i=+el.dataset.i;
  const raw=String(el.value).trim();
  if(raw===''){
    /* A cleared (or browser-invalid) number input reports value="" — treat it
       as "return to the soil-type proposal", never as 0 (which would clamp to
       an extreme 0.05 override). */
    S.layers[i].ovr.nu=false;
    delete S.layers[i].nu_ovr;
    renderModel();
    return;
  }
  const numeric=Number(raw);
  if(!Number.isFinite(numeric)) return;
  /* nu < 0.5 strictly: beta = (1+nu)(1-2nu)/(1-nu) degenerates to 0 at 0.5.
     Rounded to 2 decimals so the stored override always equals the display. */
  S.layers[i].nu_ovr=Math.max(Math.min(Math.round(numeric*100)/100, 0.49), 0.05);
  S.layers[i].ovr.nu=true;
  el.classList.add('ovr');
  renderModel();
}

/* ════════════════════════════════
   MODEL PARAMETERS
════════════════════════════════ */
function khParams(l){
  return khParamsPure(l, modelCtx());
}

/* Toggle functions for Stage 4 global method controls */
function setAlphaMethod(v){
  S.alphaMethod=v;
  document.getElementById('btnAlphaA').classList.toggle('active',v==='A');
  document.getElementById('btnAlphaB').classList.toggle('active',v==='B');
  if(S.layers.length) renderModel();
}
function setStiffMethod(v){
  S.stiffMethod=v;
  document.getElementById('btnStiffA').classList.toggle('active',v==='A');
  document.getElementById('btnStiffB').classList.toggle('active',v==='B');
  if(S.layers.length) renderModel();
}

/* k_h/k_v anisotropy method.
   A — OVAM / I/RA/11461 (default): conservative engineering practice value.
       Silty sand grouped with fine soils → k_h/k_v = 3.
   B — Bear (1979): literature-typical intermediate value for fine/silty sand.
       Silty sand → k_h/k_v = 2.
   Sand and gravel are isotropic (k_h/k_v = 1) under both methods.
   Cohesive soils (clay, sandy clay/leem, peat) get k_h/k_v = 3 under both. */
function setKhKvMethod(v){
  S.khKvMethod=v;
  document.getElementById('btnKhKvA').classList.toggle('active',v==='A');
  document.getElementById('btnKhKvB').classList.toggle('active',v==='B');
  if(S.layers.length) renderModel();
}

function setParamMethod(v){
  S.paramMethod=v;
  document.getElementById('pmSB260').classList.toggle('active',v==='sb260');
  document.getElementById('pmDEF').classList.toggle('active',v==='def');
  const desc={
    sb260:'Grondsoort en consistentie uit NEN Tabel 3 — aanbevolen',
    def:'Generieke parameters op basis van CPT-type (DEF tabel)'
  };
  document.getElementById('pmDesc').textContent=desc[v]||'';
  // Re-run detectLayers to apply new suggestions, then re-render
  if(S.classified.length){ detectLayers(); renderLayers(); }
}

/* Stage 4 derivation lives in model-params/ (PR 5); these wrappers feed the
   pure functions the context of the active CPT. */
function modelCtx(){
  return cptModelCtx(S);
}
function hsParams(l){
  return hsParamsPure(l, modelCtx());
}

function renderModel(){
  document.getElementById('ma').innerHTML=S.layers.map((l,i)=>{
    const h=hsParams(l);
    const k=khParams(l);
    const thick=(l.bot-l.top).toFixed(2);
    const midZ=(l.top+l.bot)/2;
    const tawStr=S.elev!=null?` &nbsp;(${h.topTAW} \u2192 ${h.botTAW})`:'';

    // Infiltration class colour
    const infCol={
      'Infiltratie (volledig)':    'var(--ac)',
      'Infiltratie (effectief)':   'var(--ok-text)',
      'Infiltratie + buffer':      'var(--wn)',
      'Buffer (infiltratie marginaal)': 'var(--chart-orange)'
    }[k.infClass]||'var(--tx2)';

    return`<div class="card">
      <div class="card__head">
        <span class="pill ${SC[l.type]||'s-sand'}">${l.type}</span>
        <span style="font-size:13px;font-weight:600">Layer ${i+1} &mdash; ${l.top.toFixed(2)}&ndash;${l.bot.toFixed(2)} m${tawStr} &nbsp;(${thick} m)</span>
        ${l.subtype?`<span style="font-size:11px;color:var(--tx2);font-style:italic">${l.subtype}</span>`:''}
        <span style="font-size:11px;color:var(--tx2);margin-left:auto" title="z_mid=${midZ.toFixed(2)}m | &sigma;v0=${h.sigV} kPa | u=${h.u} kPa | &sigma;'v0=${h.sigVeff} kPa">&sigma;v0 ${h.sigV} &minus; u ${h.u} = &sigma;'v0 <strong>${h.sigVeff} kPa</strong> &middot; &alpha;E ${h.aE}</span>
      </div>
      <div style="display:grid;grid-template-columns:${STAGE4_ENABLE_HARDENING_SOIL_PARAMS?'1fr 1fr 1fr 1fr':'1fr 1fr 1fr'};gap:14px">
        <div>
          <div class="card__eyebrow">Mohr-Coulomb</div>
          <table class="tbl tbl--kv">
            <tr><td>E_ref (kPa)</td><td>${h.Emc.toLocaleString()}</td></tr>
            <tr class="key">
              <td>&nu; <input class="input input--sm${l.ovr.nu?' ovr':''}" type="number" step="0.01" min="0.05" max="0.49"
                value="${h.nu.toFixed(2)}" style="width:52px;margin-left:4px"
                data-i="${i}" onchange="editNu(this)"></td>
              <td>${h.nu.toFixed(2)}</td>
            </tr>
            <tr class="key">
              <td>r_shear <input class="input input--sm${l.ovr.rShear?' ovr':''}" type="number" step="0.01" min="0.01" max="1.00"
                value="${h.rShear.toFixed(2)}" style="width:52px;margin-left:4px"
                data-i="${i}" onchange="editRShear(this)"></td>
              <td>${h.rShear.toFixed(2)}</td>
            </tr>
            <tr class="key"><td>&phi;' (&deg;)</td><td>${l.phi}</td></tr>
            <tr class="key"><td>c' (kPa)</td><td>${l.c}</td></tr>
            <tr><td>&psi; (&deg;)</td><td>${h.psi}</td></tr>
            <tr><td>&gamma; / &gamma;_sat</td><td>${l.g} / ${l.gs} kN/m&sup3;</td></tr>
            ${l.type==='Soft clay'||l.type==='Clay'?`<tr><td>c_u (kPa)</td><td>${l.cu}</td></tr>`:''}
          </table>
        </div>
        <div>
          <div class="card__eyebrow">Soilin &mdash; deformation modulus</div>
          <table class="tbl tbl--kv">
            <tr><td>&beta; (-)</td><td>${h.beta.toFixed(3)}</td></tr>
            <tr class="key"><td>E_def (kPa)</td><td>${h.Edef.toLocaleString()}</td></tr>
          </table>
          <div style="font-size:9px;color:var(--tx3);margin-top:6px">
            E_def = &beta;&middot;E_oed,i &nbsp;&middot;&nbsp; &beta; = (1+&nu;)(1&minus;2&nu;)/(1&minus;&nu;)<br>
            &#268;SN 73 1001 / Soilin subsoil input &middot; &nu; from Mohr-Coulomb column
          </div>
        </div>
        ${STAGE4_ENABLE_HARDENING_SOIL_PARAMS ? `
          <div>
            <div class="card__eyebrow">Hardening Soil &mdash; p_ref = 100 kPa</div>
            <table class="tbl tbl--kv">
              <tr>
                <td style="color:var(--tx3);font-size:10px">&alpha;E (${S.alphaMethod==='B'?'SB260':'Sanglerat'})</td>
                <td style="text-align:right">
                  <input class="input input--sm${l.ovr.aE?' ovr':''}" type="number" step="0.5" min="0.5" max="30"
                    value="${h.aE}" style="width:54px"
                    data-i="${i}" onchange="editAlpha(this)">
                </td>
              </tr>
              <tr><td>E_oed,i (kPa)</td><td style="color:var(--tx2)">${h.Eoed_i.toLocaleString()}</td></tr>
              <tr class="key"><td>E_oed,ref (kPa)</td><td>${h.Eoed_ref.toLocaleString()}</td></tr>
              <tr class="key"><td>E_50,ref (kPa) <span style="font-size:9px;color:var(--tx3)">${S.stiffMethod==='B'?'=E_oed':'CUR 2003-7'}</span></td><td>${h.E50_ref.toLocaleString()}</td></tr>
              <tr class="key"><td>E_ur,ref (kPa)</td><td>${h.Eur_ref.toLocaleString()}</td></tr>
              <tr class="key">
                <td>m <input class="input input--sm${l.ovr.m?' ovr':''}" type="number" step="0.05" min="0.3" max="1.2"
                  value="${h.m.toFixed(2)}" style="width:48px;margin-left:4px"
                  data-i="${i}" onchange="editM(this)"></td>
                <td>${h.m.toFixed(2)}</td>
              </tr>
              <tr><td>K0_nc</td><td>${h.K0nc}</td></tr>
              <tr><td>&nu;<sub>ur</sub></td><td>${h.nu_ur}</td></tr>
              <tr><td>R_f</td><td>0.90</td></tr>
            </table>
          </div>
        ` : ''}
        <div>
          <div class="card__eyebrow">Hydraulic conductivity</div>
          <table class="tbl tbl--kv">
            <tr><td>k_h (m/s)</td><td style="font-family:monospace;font-size:11px">${k.kh_rep_fmt}</td></tr>
            <tr><td style="color:var(--tx3);font-size:10px">range</td><td style="font-family:monospace;font-size:10px;color:var(--tx3)">${k.kh_min_fmt} \u2013 ${k.kh_max_fmt}</td></tr>
            <tr><td>k_h/k_v</td><td>${k.khkv}</td></tr>
            <tr><td>k_v (m/s)</td><td style="font-family:monospace;font-size:11px">${k.kv_rep.toExponential(1)}</td></tr>
            <tr><td>&psi;_unsat (m)</td><td>${k.psi_unsat}</td></tr>
            <tr><td colspan="2" style="padding-top:6px">
              <span style="font-size:10px;font-weight:600;color:${infCol}">${k.infClass}</span>
              <div style="font-size:9px;color:var(--tx3);margin-top:2px">VMM §5.2 richtlijn</div>
            </td></tr>
          </table>
          <div style="font-size:9px;color:var(--tx3);margin-top:6px">Ref: OVAM Tabel 2-44<br>I/RA/11461/15.066/JSW</div>
        </div>
      </div>
    </div>`;
  }).join('');
  // Build charts after DOM settles (data-attribute approach avoids early tag close)
  setTimeout(buildTuningCharts, 50);
}

/* ════════════════════════════════
   STAGE 5 — TUNING: m-fitting from CPT profile
   
   METHOD: OLS regression on log-log space.
   
   For each depth reading z_j in a layer:
     Eoed,i(z_j) = alphaE * qc(z_j) * 1000         [kPa]  (CPT-derived)
     X_j = ln((sigma_v0'(z_j) + c*cotphi) / (p_ref + c*cotphi))
     Y_j = ln(Eoed,i(z_j))
   
   The HS model predicts: Y = ln(Eoed,ref) + m * X
   OLS gives: m = cov(X,Y)/var(X), Eoed,ref = exp(mean(Y) - m*mean(X))
   
   This is equivalent to matching the derivative d(ln Eoed)/d(ln stress_ratio),
   which is exactly m. Minimising the sum of squared log-errors finds the best m.
   
   R2 = 1 - SS_res/SS_tot  (in log space)
   Reliable if: n>=10 readings, stress range factor >= 1.5, top layer > 0.5m
════════════════════════════════ */

/* Stage 5 — the fit, the cards and the charts live in src/lib/cpt-app/tuning/ (PR 14).
   These wrappers feed them the active CPT; the render-after-write and the Stage 4 refresh
   of acceptFit stay here (map §3.4 #2/#3). */
function fitLayer(l){
  return fitLayerPure(l, tuningCtx(S));
}

function runTuning(){
  S.tuning = runTuningFits(S.layers, tuningCtx(S));
  renderTuning();
}

function acceptFit(i){
  if(!acceptFitPure(S, i)) return;
  renderTuning();
  // Re-render Stage 4 in background so it stays current
  if(document.getElementById('p3').classList.contains('active')) renderModel();
}

function rejectFit(i){
  if(!rejectFitPure(S, i)) return;
  renderTuning();
}

function updateTuningPreviewM(i, rawValue){
  updateTuningPreviewPure(document, S.tuning, i, rawValue);
}

function renderTuning(){
  const el = document.getElementById('tuningArea');
  el.innerHTML = tuningAreaHtml(S);
  if(!S.tuning) return;
  // Build charts after DOM settles.
  setTimeout(buildTuningCharts, 50);
}

function buildTuningCharts(){
  buildTuningChartsPure(document);
}

/* ════════════════════════════════
   STAGE 6 — APPLICATIONS
════════════════════════════════ */
function stage6Defaults(){
  return stage6StateDefaults(stage6Registry);
}

function stage6WorkingLayers(){
  return workingLayersPure(S);
}

function stage6MaxDepth(){
  return stage6LayerBottom(S);
}

function ensureStage6State(){
  stage6EnsureCpt(S, stage6EnsureCtx());
}

// Host hooks of the composed ensure(): the registry, the hardening-soil UI gate and the one
// bishop helper the seepslope/state migration still calls into this file (the deformation
// quantity list lives in the deformation-contours region until step 9b/9d; seepslope/state/ensure.js
// header). The surface-load shape migration is the package's own since PR 18a.
function stage6EnsureCtx(){
  return {
    registry: stage6Registry,
    hardeningSoilUi: STAGE6_ENABLE_HARDENING_SOIL_UI,
    deformationQuantityIds: stage6BishopDeformationQuantityIds
  };
}

function stage6RememberDetailsState(){
  const root = document.getElementById('stage6Area');
  if(!root) return;
  ensureStage6State();
  stage6RememberDetails(S.stage6, root);
}

function stage6DetailsOpen(key){
  ensureStage6State();
  return stage6DetailsOpenOf(S.stage6, key);
}

function stage6SetDetailsOpen(key, open = true){
  ensureStage6State();
  stage6SetDetailsOpenOf(S.stage6, key, open);
}

function stage6BishopUiState(){
  ensureStage6State();
  return stage6UiState(S.stage6);
}

function stage6BishopToggleSettingsPanel(force){
  ensureStage6State();
  stage6RememberDetailsState();
  const ui = stage6BishopUiState();
  const isCollapsed = ui.bishopSettingsCollapsed !== false;
  ui.bishopSettingsCollapsed = typeof force === 'boolean' ? !force : !isCollapsed;
  renderStage6();
}

function stage6BishopToggleSettingsWidth(force){
  ensureStage6State();
  const ui = stage6BishopUiState();
  ui.bishopSettingsWide = typeof force === 'boolean' ? !!force : !ui.bishopSettingsWide;
  ui.bishopSettingsCollapsed = false;
  renderStage6();
}

function stage6BishopToggleToolRail(force){
  ensureStage6State();
  const ui = stage6BishopUiState();
  ui.bishopToolRailExpanded = typeof force === 'boolean' ? !!force : !ui.bishopToolRailExpanded;
  ui.bishopCanvasToolsHidden = false;
  renderStage6();
}

function stage6BishopToggleCanvasTools(force){
  ensureStage6State();
  const ui = stage6BishopUiState();
  ui.bishopCanvasToolsHidden = typeof force === 'boolean' ? !force : !ui.bishopCanvasToolsHidden;
  renderStage6();
}

function stage6BishopSetCanvasPanel(panel){
  ensureStage6State();
  const ui = stage6BishopUiState();
  const next = panel ? String(panel) : '';
  ui.bishopActiveCanvasPanel = ui.bishopActiveCanvasPanel === next ? '' : next;
  if(ui.bishopActiveCanvasPanel) ui.bishopActiveCanvasSheet = '';
  ui.bishopCanvasToolsHidden = false;
  renderStage6();
}

function stage6BishopSheetDetails(sheet){
  const bySheet = {
    structures:['bishop-walls', 'bishop-seepage-drains'],
    boundary:['bishop-geo-seepage-boundary', 'bishop-seepage-bcs'],
    regions:['bishop-geo-regions'],
    view:['bishop-geo-view'],
    materials:['bishop-materials', 'bishop-seepage-perm', 'bishop-deformation-materials'],
    workspace:[
      'bishop-geo-analysis',
      'bishop-search',
      'bishop-spencer',
      'bishop-seepage-options',
      'bishop-seepage-integration',
      'bishop-geo-deformation',
      'bishop-deformation-solve',
      'bishop-deformation-solver-settings'
    ],
    reset:['bishop-geo-clear'],
    probe:[]
  };
  return bySheet[sheet] || [];
}

function stage6BishopSetCanvasSheet(sheet){
  ensureStage6State();
  const ui = stage6BishopUiState();
  const next = sheet ? String(sheet) : '';
  ui.bishopActiveCanvasSheet = ui.bishopActiveCanvasSheet === next ? '' : next;
  if(ui.bishopActiveCanvasSheet){
    ui.bishopActiveCanvasPanel = '';
    ui.bishopSettingsCollapsed = true;
    stage6BishopSheetDetails(ui.bishopActiveCanvasSheet).forEach((key)=>stage6SetDetailsOpen(key, true));
  }
  ui.bishopCanvasToolsHidden = false;
  renderStage6();
}

function stage6BishopOpenSettingsDetail(key){
  ensureStage6State();
  stage6RememberDetailsState();
  const ui = stage6BishopUiState();
  const detailToSheet = {
    'bishop-walls':'structures',
    'bishop-seepage-drains':'structures',
    'bishop-geo-seepage-boundary':'boundary',
    'bishop-seepage-bcs':'boundary',
    'bishop-geo-regions':'regions',
    'bishop-geo-view':'view',
    'bishop-materials':'materials',
    'bishop-seepage-perm':'materials',
    'bishop-deformation-materials':'materials',
    'bishop-geo-analysis':'workspace',
    'bishop-search':'workspace',
    'bishop-spencer':'workspace',
    'bishop-seepage-options':'workspace',
    'bishop-seepage-integration':'workspace',
    'bishop-geo-deformation':'workspace',
    'bishop-deformation-solve':'workspace',
    'bishop-deformation-solver-settings':'workspace',
    'bishop-geo-clear':'reset'
  };
  const sheet = detailToSheet[key] || 'workspace';
  ui.bishopSettingsCollapsed = true;
  ui.bishopActiveCanvasPanel = '';
  ui.bishopActiveCanvasSheet = sheet;
  ui.bishopCanvasToolsHidden = false;
  stage6SetDetailsOpen(key, true);
  renderStage6();
}

function setStage6Field(field, value){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6SetField(S.stage6, stage6Defaults(), field, value);
  if(field === 'bearing.Df' && S.stage6.app === 'bearing'){
    refreshStage6BearingPreview();
    return;
  }
  renderStage6();
}

function setStage6App(app){
  ensureStage6State();
  stage6RememberDetailsState();
  if(app === 'bishop' && !stage6BishopEnabled()) return;
  S.stage6.app = app;
  renderStage6();
}

function stage6BishopEnabled(){
  return true;
}

function stage6BishopHashActive(){
  return typeof window !== 'undefined' && window.location.hash === '#bishop';
}

// ── seepslope/state façades (refactor step 9a / PR 18a) ─────────────────────────────────────
// The surface-load, wall, drain and region state helpers live in src/lib/cpt-app/seepslope/state/
// (surface-loads.js, walls.js, drains.js, regions.js, domain.js). The pure ones are imported under
// their monolith names at the top of this file; the functions below keep the names whose monolith
// signature read the active CPT (`S`) or generated an id, and hand the package the `bishop` block.
function stage6BishopSyncLegacySurfaceLoadMirror(bishop = S.stage6?.bishop){
  seepslopeSyncLegacySurfaceLoadMirror(bishop);
}

function stage6BishopSelectedSurfaceLoad(){
  return seepslopeSelectedSurfaceLoad(S.stage6?.bishop);
}

function stage6BishopPrimarySurfaceLoad(create = false){
  return seepslopePrimarySurfaceLoad(S.stage6?.bishop, create);
}

function stage6BishopEffectiveSurfaceLoadQ(load, workspace = S.stage6?.bishop?.workspace || 'stability'){
  return seepslopeEffectiveSurfaceLoadQ(S.stage6?.bishop, load, workspace);
}

function stage6BishopSurfaceLoadSummary(load, workspace = S.stage6?.bishop?.workspace || 'stability'){
  return seepslopeSurfaceLoadSummary(S.stage6?.bishop, load, workspace);
}

function stage6BishopActiveSurfaceLoads(workspace = S.stage6?.bishop?.workspace || 'stability'){
  return seepslopeActiveSurfaceLoads(S.stage6?.bishop, workspace);
}

function stage6BishopSetSurfaceLoadField(loadId, field, value){
  ensureStage6State();
  stage6RememberDetailsState();
  const load = seepslopeSetSurfaceLoadField(S.stage6.bishop, loadId, field, value);
  if(!load) return;
  stage6BishopInvalidate('Surface load changed; rerun the active analysis.');
  renderStage6();
}

function stage6BishopSelectSurfaceLoad(loadId){
  ensureStage6State();
  seepslopeSelectSurfaceLoad(S.stage6.bishop, loadId);
  renderStage6();
}

function stage6BishopDeleteSurfaceLoad(loadId){
  ensureStage6State();
  stage6RememberDetailsState();
  if(seepslopeDeleteSurfaceLoad(S.stage6.bishop, loadId)){
    stage6BishopInvalidate('Surface load deleted; rerun the active analysis.');
  }
  renderStage6();
}

function stage6BishopCreateSurfaceLoadFromZone(zone){
  const load = seepslopeCreateSurfaceLoadFromZone(S.stage6.bishop, zone);
  if(load) stage6BishopInvalidate('Surface load added; rerun the active analysis.');
  return load;
}

function stage6BishopDefaultPassiveSide(){
  return seepslopeDefaultPassiveSide(S.stage6?.bishop?.terrain || []);
}

function stage6BishopWallId(){
  return seepslopeWallId();
}

function stage6BishopDrainId(){
  return seepslopeDrainId();
}

function stage6BishopCreateDrainFromVertices(vertices){
  ensureStage6State();
  const outcome = seepslopeCreateDrainFromVertices(S.stage6.bishop, vertices, {
    model: () => S.stage6Cache?.bishopModel || stage6BishopCurrentModel() || {}
  });
  if(!outcome.ok) return false;
  stage6SetDetailsOpen('bishop-seepage-drains', true);
  stage6BishopInvalidateSeepage('Drain added. Set the drain head, then rerun seepage.', true, true);
  return true;
}

function stage6BishopRegionId(){
  return seepslopeRegionId();
}

function stage6BishopSelectedCustomRegion(){
  return seepslopeSelectedCustomRegion(S?.stage6?.bishop);
}


// ── seepslope/model invalidation façades (refactor step 9b / PR 18b) ────────────────────────
// The four invalidators are pure state transitions in seepslope/model/invalidate.js; the façades
// keep the monolith names and signatures and add the two host halves the package cannot own: the
// `ensureStage6State()` the monolith opened with, and the `terminate()` of the worker singletons
// (the state half of the silent stop lives in the package, so the pair is equivalent whatever the
// order). They return the transition's `{ stop, rerun, keptSolvedState, render }` — nothing reads
// it in the monolith yet; step 9c's run handlers will.
function stage6BishopInvalidateSeepage(message, keepMesh, preserveSolvedState){
  ensureStage6State();
  stage6BishopStopSeepage(true);
  return seepslopeInvalidateSeepage(S.stage6.bishop, {message, keepMesh, preserveSolvedState});
}

function stage6BishopCurrentSeepageBoundary(model){
  const boundary = buildSeepageOuterBoundary(model);
  S.stage6Cache.bishopSeepageBoundary = boundary;
  return boundary;
}

function stage6BishopSelectedBoundaryEdge(model){
  const seepage = S.stage6?.bishop?.seepage;
  const boundary = S.stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model);
  return (boundary || []).find((edge)=>edge.edgeKey === seepage?.selectedEdgeKey) || null;
}

function stage6BishopHoveredSeepageEdge(model){
  const bishop = S?.stage6?.bishop;
  if(!bishop || bishop.tool !== 'seepageBc' || !stage6BishopCanvasState.hoverWorld) return null;
  const boundary = S.stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model);
  return pickSeepageBoundaryEdge(boundary, stage6BishopCanvasState.hoverWorld, stage6BishopSnapToleranceWorld())?.edge || null;
}

function stage6BishopSeepageBcForEdge(edgeKey){
  return (S.stage6?.bishop?.seepage?.bcs || []).find((bc)=>bc.edgeKey === edgeKey) || null;
}

function stage6BishopSeepageEdgeLabel(edge){
  if(!edge) return '—';
  if(edge.source === 'terrain') return `Terrain edge ${edge.index + 1}`;
  if(edge.source === 'base') return 'Model base';
  if(edge.source === 'side-left') return 'Left side';
  if(edge.source === 'side-right') return 'Right side';
  return edge.source || 'Boundary edge';
}

function stage6BishopSeepageBcTypeLabel(type){
  if(type === 'head') return 'Prescribed head';
  if(type === 'seepage-face') return 'Seepage face';
  return 'No-flow';
}

function stage6BishopRememberSeepageBcPreset(bc){
  const seepage = S?.stage6?.bishop?.seepage;
  if(!seepage || !bc) return;
  seepage.lastAppliedBcType = bc.type === 'head' ? 'head' : bc.type === 'seepage-face' ? 'seepage-face' : 'no-flow';
  seepage.lastAppliedBcHead = seepage.lastAppliedBcType === 'head' && Number.isFinite(+bc.head) ? +bc.head : null;
}

function stage6BishopAutoApplySeepagePreset(edge){
  const seepage = S?.stage6?.bishop?.seepage;
  if(!seepage || !edge || stage6BishopSeepageBcForEdge(edge.edgeKey)) return null;
  const presetType = seepage.lastAppliedBcType;
  if(!['head','seepage-face','no-flow'].includes(presetType) || !presetType) return null;
  const bc = makeSeepageBoundaryCondition(edge, {
    id:`bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type:presetType,
    head:presetType === 'head'
      ? (Number.isFinite(seepage.lastAppliedBcHead) ? seepage.lastAppliedBcHead : edge.mid.y)
      : null
  });
  seepage.bcs = [...(seepage.bcs || []).filter((item)=>item.edgeKey !== edge.edgeKey), bc];
  seepage.selectedBcId = bc.id;
  stage6BishopRememberSeepageBcPreset(bc);
  return bc;
}

function stage6BishopSeepageHeadColor(value, min, max, alpha = 0.55){
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
  const t = Math.max(0, Math.min((value - lo) / (hi - lo), 1));
  const r = Math.round(33 + (44 - 33) * t);
  const g = Math.round(109 + (158 - 109) * t);
  const b = Math.round(186 + (82 - 186) * t);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function stage6BishopSeepageContourMeta(mode){
  if(mode === 'head') return {label:'h', axisTitle:'Head h (m)', unit:'m', scale:1, digits:2, signed:false};
  if(mode === 'porePressure') return {label:'u', axisTitle:'Pore pressure u (kPa)', unit:'kPa', scale:1, digits:2, signed:true};
  if(mode === 'gradient') return {label:'|∇h|', axisTitle:'Hydraulic gradient |∇h| (-)', unit:'', scale:1, digits:3, signed:false};
  if(mode === 'hydraulicFs') return {label:'FSᵢ', axisTitle:'Hydraulic safety factor FSᵢ = iᶜʳⁱᵗ / |∇h| (-)', unit:'', scale:1, digits:2, signed:false, centeredAtOne:true};
  if(mode === 'flow') return {label:'|q|', axisTitle:'Specific discharge |q| (m/s)', unit:'m/s', scale:1, digits:3, signed:false};
  if(mode === 'qx') return {label:'qₓ', axisTitle:'Specific discharge qₓ (m/s)', unit:'m/s', scale:1, digits:3, signed:true};
  return {label:'qᵧ', axisTitle:'Specific discharge qᵧ (m/s)', unit:'m/s', scale:1, digits:3, signed:true};
}

function stage6BishopSeepageContourOptions(){
  return [
    'head',
    'porePressure',
    'gradient',
    'hydraulicFs',
    'flow',
    'qx',
    'qy'
  ].map((id)=>({
    id,
    label:stage6BishopSeepageContourMeta(id).label
  }));
}

const ST6_SEEPAGE_HYDRAULIC_FS_CAP = 10;
const ST6_SEEPAGE_HYDRAULIC_FS_PALETTE = [
  {t:0.00, rgb:[202, 32, 36]},
  {t:0.24, rgb:[243, 150, 36]},
  {t:0.50, rgb:[45, 170, 91]},
  {t:0.74, rgb:[50, 184, 205]},
  {t:1.00, rgb:[33, 93, 188]}
];

function stage6BishopSeepageCriticalGradient(material){
  const gammaW = Math.max(Number(stage6Constants().gammaW) || 9.81, 1e-9);
  const gammaDry = Number.isFinite(Number(material?.gamma)) ? Number(material.gamma) : 18;
  const gammaSat = Number.isFinite(Number(material?.gammaSat)) ? Number(material.gammaSat) : gammaDry + 2;
  return Math.max((gammaSat - gammaW) / gammaW, 0);
}

function stage6BishopSeepageHydraulicFs(gradientMagnitude, material){
  const gradient = Math.max(Math.abs(Number(gradientMagnitude) || 0), 0);
  const criticalGradient = stage6BishopSeepageCriticalGradient(material);
  if(!(criticalGradient > 0)) return 0;
  if(!(gradient > 1e-9)) return ST6_SEEPAGE_HYDRAULIC_FS_CAP;
  return Math.min(criticalGradient / gradient, ST6_SEEPAGE_HYDRAULIC_FS_CAP);
}

function stage6BishopSeepageElementContourValue(result, mesh, elementIndex, mode){
  if(mode === 'head') return Number(result?.elementHeads?.[elementIndex] ?? 0);
  if(mode === 'porePressure'){
    const centroidY = Number(mesh?.elementData?.[elementIndex]?.centroid?.y);
    const head = Number(result?.elementHeads?.[elementIndex] ?? 0);
    return Number.isFinite(centroidY) ? 9.81 * (head - centroidY) : 0;
  }
  const gradient = result?.elementGradients?.[elementIndex] || {};
  if(mode === 'gradient') return Number(gradient.gradientMagnitude || 0);
  if(mode === 'hydraulicFs'){
    const cell = mesh?.cells?.[mesh?.elementCell?.[elementIndex]];
    return stage6BishopSeepageHydraulicFs(gradient.gradientMagnitude, cell?.material);
  }
  if(mode === 'flow') return Number(gradient.qMagnitude || 0);
  if(mode === 'qx') return Number(gradient.qx || 0);
  return Number(gradient.qy || 0);
}

function stage6BishopSeepageContourValue(result, mesh, cellIndex, mode){
  if(mode === 'head') return Number(result?.cellHeads?.[cellIndex] ?? result?.headMin ?? 0);
  if(mode === 'porePressure'){
    const cellY = Number(mesh?.cells?.[cellIndex]?.centroid?.y);
    const head = Number(result?.cellHeads?.[cellIndex] ?? 0);
    return Number.isFinite(cellY) ? 9.81 * (head - cellY) : 0;
  }
  const gradient = result?.cellGradients?.[cellIndex] || {};
  if(mode === 'gradient') return Number(gradient.gradientMagnitude || 0);
  if(mode === 'hydraulicFs'){
    const cell = mesh?.cells?.[cellIndex];
    return stage6BishopSeepageHydraulicFs(gradient.gradientMagnitude, cell?.material);
  }
  if(mode === 'flow') return Number(gradient.qMagnitude || 0);
  if(mode === 'qx') return Number(gradient.qx || 0);
  return Number(gradient.qy || 0);
}

function stage6BishopSeepageContourModeIsSigned(mode){
  return !!stage6BishopSeepageContourMeta(mode).signed;
}

function stage6BishopSeepageContourStats(result, mesh, mode){
  const values = (mesh?.cells || []).map((_, index)=>stage6BishopSeepageContourValue(result, mesh, index, mode)).filter(Number.isFinite);
  if(!values.length) return {min:0, max:1};
  const min = Math.min(...values);
  const max = Math.max(...values);
  if(mode === 'hydraulicFs'){
    return {
      min:Math.min(min, 1),
      max:Math.max(max, 1.5)
    };
  }
  if(stage6BishopSeepageContourModeIsSigned(mode)){
    const abs = Math.max(Math.abs(min), Math.abs(max), 1e-9);
    return {min:-abs, max:abs};
  }
  return {
    min,
    max: max > min + 1e-9 ? max : min + 1
  };
}

function stage6BishopSeepageContourNodalValues(result, mesh, mode){
  const nodeCount = mesh?.nodes?.length || 0;
  if(!nodeCount) return [];
  if(mode === 'head') return Array.from({length:nodeCount}, (_, nodeId)=>Number(result?.heads?.[nodeId] || 0));
  if(mode === 'porePressure'){
    return Array.from({length:nodeCount}, (_, nodeId)=>{
      const head = Number(result?.heads?.[nodeId] || 0);
      const y = Number(mesh?.nodes?.[nodeId]?.y);
      return Number.isFinite(y) ? 9.81 * (head - y) : 0;
    });
  }
  const sums = new Array(nodeCount).fill(0);
  const weights = new Array(nodeCount).fill(0);
  (mesh?.elements || []).forEach((element, elementIndex)=>{
    const value = stage6BishopSeepageElementContourValue(result, mesh, elementIndex, mode);
    if(!Number.isFinite(value)) return;
    const weight = Math.max(Number(mesh?.elementData?.[elementIndex]?.area) || 0, 1e-6);
    element.forEach((nodeId)=>{
      sums[nodeId] += value * weight;
      weights[nodeId] += weight;
    });
  });
  return sums.map((sum, index)=>weights[index] > 0 ? sum / weights[index] : 0);
}

function stage6BishopSeepageContourRgb(value, min, max, mode){
  if(mode === 'hydraulicFs'){
    const finiteValue = Number.isFinite(value) ? Math.max(value, 0) : 0;
    const hi = Math.max(Number.isFinite(max) ? max : 1.5, 1.5);
    const t = finiteValue <= 1
      ? 0.5 * Math.max(0, Math.min(finiteValue, 1))
      : 0.5 + 0.5 * Math.max(0, Math.min((finiteValue - 1) / Math.max(hi - 1, 1e-9), 1));
    return stage6BishopInterpolatePalette(ST6_SEEPAGE_HYDRAULIC_FS_PALETTE, t);
  }
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
  if(stage6BishopSeepageContourModeIsSigned(mode)){
    const span = Math.max(Math.abs(lo), Math.abs(hi), 1e-9);
    return stage6BishopInterpolatePalette(
      ST6_DEFORMATION_SIGNED_PALETTE,
      Math.max(0, Math.min((value + span) / (2 * span), 1))
    );
  }
  return stage6BishopInterpolatePalette(
    ST6_DEFORMATION_SEQ_PALETTE,
    Math.max(0, Math.min((value - lo) / (hi - lo), 1))
  );
}

function stage6BishopSeepageContourColor(value, min, max, mode, alpha = 0.52){
  const rgb = stage6BishopSeepageContourRgb(value, min, max, mode);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function stage6BishopSeepageContourLineColor(value, min, max, mode, alpha = 0.94){
  const rgb = stage6BishopSeepageContourRgb(value, min, max, mode);
  return `rgba(${Math.round(rgb.r * 0.72)}, ${Math.round(rgb.g * 0.72)}, ${Math.round(rgb.b * 0.72)}, ${alpha})`;
}

function stage6BishopSeepageContourLegendGradient(mode){
  if(mode === 'hydraulicFs'){
    return `linear-gradient(to top, ${ST6_SEEPAGE_HYDRAULIC_FS_PALETTE.map((stop)=>`rgb(${stop.rgb[0]}, ${stop.rgb[1]}, ${stop.rgb[2]}) ${Math.round(stop.t * 100)}%`).join(', ')})`;
  }
  const stops = stage6BishopSeepageContourModeIsSigned(mode)
    ? ST6_DEFORMATION_SIGNED_PALETTE
    : ST6_DEFORMATION_SEQ_PALETTE;
  return `linear-gradient(to top, ${stops.map((stop)=>`rgb(${stop.rgb[0]}, ${stop.rgb[1]}, ${stop.rgb[2]}) ${Math.round(stop.t * 100)}%`).join(', ')})`;
}

function stage6BishopSeepageContourLegendTicks(mode, stats){
  if(mode === 'hydraulicFs'){
    const max = Math.max(Number.isFinite(stats?.max) ? stats.max : 1.5, 1.5);
    return [max, 1 + 0.5 * (max - 1), 1, 0.5, 0];
  }
  if(stage6BishopSeepageContourModeIsSigned(mode)){
    const span = Math.max(Math.abs(stats?.min || 0), Math.abs(stats?.max || 0), 1e-9);
    return [span, 0.5 * span, 0, -0.5 * span, -span];
  }
  const min = Number.isFinite(stats?.min) ? stats.min : 0;
  const max = Number.isFinite(stats?.max) ? stats.max : 1;
  return [max, min + 0.75 * (max - min), min + 0.5 * (max - min), min + 0.25 * (max - min), min];
}

function stage6BishopSeepageContourLegendValue(mode, value){
  const meta = stage6BishopSeepageContourMeta(mode);
  const scaled = value * (meta.scale || 1);
  return `${stage6CompactNumber(scaled, meta.digits || 3)}${meta.unit ? ` ${meta.unit}` : ''}`;
}

function stage6BishopSeepageContourLevels(mode, stats, count = 11){
  const min = Number.isFinite(stats?.min) ? stats.min : 0;
  const max = Number.isFinite(stats?.max) ? stats.max : min + 1;
  if(!(max > min + 1e-9)) return [];
  const out = [];
  for(let index = 1; index < count; index += 1){
    const t = index / count;
    const level = min + (max - min) * t;
    if(stage6BishopSeepageContourModeIsSigned(mode) && Math.abs(level) < 1e-10) continue;
    out.push(level);
  }
  if(stage6BishopSeepageContourModeIsSigned(mode) && min < 0 && max > 0){
    out.push(0);
    out.sort((a, b)=>a - b);
  }
  if(mode === 'hydraulicFs' && min < 1 && max > 1 && !out.some((level)=>Math.abs(level - 1) < 1e-9)){
    out.push(1);
    out.sort((a, b)=>a - b);
  }
  return out;
}

function stage6BishopSeepageContourDerived(result, mesh, mode){
  ensureStage6State();
  S.stage6Cache ||= {};
  const store = S.stage6Cache.bishopSeepageContourDerived || (S.stage6Cache.bishopSeepageContourDerived = {});
  const cached = store[mode];
  if(cached && cached.result === result && cached.mesh === mesh) return cached;
  const stats = stage6BishopSeepageContourStats(result, mesh, mode);
  const nodalValues = stage6BishopSeepageContourNodalValues(result, mesh, mode);
  const levels = stage6BishopSeepageContourLevels(mode, stats, 11);
  const levelSegments = levels.map((level)=>({
    level,
    segments:contourSegmentsForTriangles(mesh, nodalValues, level)
  })).filter((group)=>group.segments.length);
  const next = {result, mesh, mode, stats, nodalValues, levels, levelSegments};
  store[mode] = next;
  return next;
}

function stage6BishopNormalizedDeformationAnalysisType(analysisType = null){
  if(analysisType === 'safety-cphi') return 'safety-cphi';
  if(analysisType === 'deformation') return 'deformation';
  return S?.stage6?.bishop?.deformation?.options?.analysisType === 'safety-cphi'
    ? 'safety-cphi'
    : 'deformation';
}

function stage6BishopDeformationQuantityIds(analysisType = null, hasHs = false){
  const normalizedAnalysisType = stage6BishopNormalizedDeformationAnalysisType(analysisType);
  const ids = [
    'uTotal',
    'settlement',
    'ux',
    'uy',
    'epsilonXx',
    'epsilonYy',
    'gammaXy',
    'equivalentPlasticStrain',
    'deltaSigmaYy',
    'sigmaYyEffInit',
    'sigmaYyEff',
    'sigmaYyTotalInit',
    'sigmaYyTotal',
    'sigmaXxEffInit',
    'sigmaXxEff',
    'sigmaXxTotalInit',
    'sigmaXxTotal',
    'tauXy',
    'mcEta'
  ];
  if(normalizedAnalysisType === 'safety-cphi'){
    ids.splice(8, 0, 'safetyEquivalentPlasticIncrement');
  }
  if(hasHs === true){
    ids.push('hsGammaP');
    ids.push('hsPP');
    ids.push('hsEpsVPDilative');
    ids.push('hsLastActiveSet');
  }
  return ids;
}

function stage6BishopDeformationContourMeta(mode, analysisType = 'deformation'){
  const isSafety = stage6BishopNormalizedDeformationAnalysisType(analysisType) === 'safety-cphi';
  if(mode === 'settlement') return {label:isSafety ? 'Additional settlement (-Δuᵧ,safety)' : 'Settlement (-uᵧ,fin)', axisTitle:isSafety ? 'Additional settlement (-Δuᵧ,safety) (mm)' : 'Settlement (-uᵧ,fin) (mm)', unit:'mm', scale:1000, digits:2, signed:false};
  if(mode === 'ux') return {label:isSafety ? 'Δuₓ,safety' : 'uₓ,fin', axisTitle:isSafety ? 'Δuₓ,safety (mm)' : 'uₓ,fin (mm)', unit:'mm', scale:1000, digits:2, signed:true};
  if(mode === 'uy') return {label:isSafety ? 'Δuᵧ,safety' : 'uᵧ,fin', axisTitle:isSafety ? 'Δuᵧ,safety (mm)' : 'uᵧ,fin (mm)', unit:'mm', scale:1000, digits:2, signed:true};
  if(mode === 'uTotal') return {label:isSafety ? '|Δu|,safety' : '|u|,fin', axisTitle:isSafety ? '|Δu|,safety (mm)' : '|u|,fin (mm)', unit:'mm', scale:1000, digits:2, signed:false};
  if(mode === 'epsilonXx') return {label:'εₓₓ,fin', axisTitle:'εₓₓ,fin (%)', unit:'%', scale:100, digits:3, signed:true};
  if(mode === 'epsilonYy') return {label:'εᵧᵧ,fin', axisTitle:'εᵧᵧ,fin (%)', unit:'%', scale:100, digits:3, signed:true};
  if(mode === 'gammaXy') return {label:'γₓᵧ,fin', axisTitle:'γₓᵧ,fin (%)', unit:'%', scale:100, digits:3, signed:true};
  if(mode === 'equivalentPlasticStrain') return {label:'ε̄ᵖ,acc', axisTitle:'ε̄ᵖ,acc (%)', unit:'%', scale:100, digits:3, signed:false};
  if(mode === 'safetyEquivalentPlasticIncrement') return {label:'Δε̄ᵖ,safety', axisTitle:'Δε̄ᵖ,safety (%)', unit:'%', scale:100, digits:3, signed:false};
  if(mode === 'deltaSigmaYy') return {label:'Δσᵧᵧ', axisTitle:'Δσᵧᵧ (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
  if(mode === 'sigmaYyEffInit') return {label:'σ′ᵧᵧ,init', axisTitle:'σ′ᵧᵧ,init (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
  if(mode === 'sigmaYyEff') return {label:'σ′ᵧᵧ,fin', axisTitle:'σ′ᵧᵧ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
  if(mode === 'sigmaYyTotalInit') return {label:'σᵧᵧ,init', axisTitle:'σᵧᵧ,init (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
  if(mode === 'sigmaYyTotal') return {label:'σᵧᵧ,fin', axisTitle:'σᵧᵧ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
  if(mode === 'sigmaXxEffInit') return {label:'σ′ₓₓ,init', axisTitle:'σ′ₓₓ,init (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
  if(mode === 'sigmaXxEff') return {label:'σ′ₓₓ,fin', axisTitle:'σ′ₓₓ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
  if(mode === 'sigmaXxTotalInit') return {label:'σₓₓ,init', axisTitle:'σₓₓ,init (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
  if(mode === 'sigmaXxTotal') return {label:'σₓₓ,fin', axisTitle:'σₓₓ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:false};
  if(mode === 'tauXy') return {label:'τₓᵧ,fin', axisTitle:'τₓᵧ,fin (kPa)', unit:'kPa', scale:1, digits:2, signed:true};
  if(mode === 'hsGammaP') return {label:'γᵖ (HS)', axisTitle:'γᵖ (HS) (%)', unit:'%', scale:100, digits:3, signed:false};
  if(mode === 'hsPP') return {label:'pₚ (HS)', axisTitle:'pₚ (HS) (kPa)', unit:'kPa', scale:1, digits:1, signed:false};
  if(mode === 'hsEpsVPDilative') return {label:'εᵥᵖ (HS, dilative)', axisTitle:'εᵥᵖ (HS, dilative) (%)', unit:'%', scale:100, digits:3, signed:true};
  if(mode === 'hsLastActiveSet') return {label:'HS active surface', axisTitle:'HS active surface', unit:'', scale:1, digits:0, signed:false, categorical:true};
  return {label:'η_MC', axisTitle:'η_MC (-)', unit:'', scale:1, digits:3, signed:false};
}

function stage6BishopDeformationContourOptions(analysisType = 'deformation', hasHs = false){
  const normalizedAnalysisType = stage6BishopNormalizedDeformationAnalysisType(analysisType);
  return stage6BishopDeformationQuantityIds(normalizedAnalysisType, hasHs === true).map((id)=>({
    id,
    label:stage6BishopDeformationContourMeta(id, normalizedAnalysisType).label
  }));
}

function stage6BishopDeformationVectorMode(mode){
  return ['settlement', 'ux', 'uy', 'uTotal'].includes(mode);
}

function stage6BishopT6VisualSubtriangles(element){
  if(!Array.isArray(element) || element.length < 6) return [element?.slice?.(0, 3) || []];
  return [
    [element[0], element[5], element[4]],
    [element[5], element[1], element[3]],
    [element[4], element[3], element[2]],
    [element[5], element[3], element[4]]
  ];
}

function stage6BishopDeformationPlasticPointSets(result){
  const constitutiveModel = String(result?.solver?.constitutiveModel || '');
  const isMcPlastic = constitutiveModel === 'mc-plastic-material-point' || constitutiveModel === 'gpu-resident-mc-plastic';
  const activePoints = [];
  const tensionPoints = [];
  const historyPoints = [];
  (result?.elementResults || []).forEach((item)=>{
    if(Array.isArray(item?.gaussPoints) && item.gaussPoints.length){
      item.gaussPoints.forEach((gp)=>{
        if(!Number.isFinite(gp?.x) || !Number.isFinite(gp?.y)) return;
        const point = {x:gp.x, y:gp.y};
        const diagnostics = gp?.materialDiagnostics || {};
        const materialState = gp?.materialState || {};
        const tensionCutoffActive = gp?.tensionCutoffActive === true || diagnostics.tensionCutoffActive === true;
        const currentlyMcActive = diagnostics.currentlyMcActive === true || materialState.currentlyMcActive === true;
        if(isMcPlastic){
          if(tensionCutoffActive){
            tensionPoints.push(point);
            return;
          }
          if(currentlyMcActive){
            activePoints.push(point);
            return;
          }
          if((Number(materialState?.accumulatedPlasticStrain) || 0) > 1e-8) historyPoints.push(point);
          return;
        }
        if(constitutiveModel === 'mc-reduced-stiffness-material-point' && currentlyMcActive) activePoints.push(point);
      });
      return;
    }
    const centroid = item?.centroid;
    if(!Number.isFinite(centroid?.x) || !Number.isFinite(centroid?.y)) return;
    const diagnostics = item?.materialDiagnostics || {};
    const tensionCutoffActive = diagnostics.tensionCutoffActive === true;
    const currentlyMcActive = diagnostics.currentlyMcActive === true;
    if(isMcPlastic){
      if(tensionCutoffActive){
        tensionPoints.push(centroid);
        return;
      }
      if(currentlyMcActive){
        activePoints.push(centroid);
        return;
      }
      if((Number(item?.materialState?.accumulatedPlasticStrain) || 0) > 1e-8){
        historyPoints.push(centroid);
      }
      return;
    }
    if(constitutiveModel === 'mc-reduced-stiffness-material-point' && currentlyMcActive){
      activePoints.push(centroid);
    }
  });
  return {
    activePoints,
    tensionPoints,
    historyPoints
  };
}

function stage6BishopDeformationFiniteScalar(value, fallback = 0){
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function stage6BishopDeformationFiniteScalarOrNull(value){
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stage6BishopDeformationElementEtaMc(item){
  const contourEta = Number(item?.materialDiagnostics?.etaMcContour);
  if(Number.isFinite(contourEta)) return contourEta;
  let sumEta = 0;
  let sumWeight = 0;
  let fallbackMax = null;
  (item?.gaussPoints || []).forEach((gp)=>{
    if(gp?.tensionCutoffActive === true || gp?.materialDiagnostics?.tensionCutoffActive === true) return;
    const numeric = Number(gp?.materialDiagnostics?.etaMcFinal ?? gp?.mc?.eta);
    if(!Number.isFinite(numeric)) return;
    const weight = Math.max(Number(gp?.areaWeight) || 1, 0);
    sumEta += weight * numeric;
    sumWeight += weight;
    fallbackMax = Math.max(fallbackMax ?? 0, numeric);
  });
  if(sumWeight > 0) return sumEta / sumWeight;
  if(fallbackMax != null) return fallbackMax;
  if(item?.materialDiagnostics?.tensionCutoffActive !== true){
    const numeric = Number(item?.materialDiagnostics?.etaMcFinal ?? item?.mc?.eta);
    if(Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function stage6BishopAverageFiniteValues(values, fallback = null){
  const finite = (values || []).filter((value)=>Number.isFinite(value));
  if(!finite.length) return fallback;
  return finite.reduce((sum, value)=>sum + value, 0) / finite.length;
}

function stage6BishopDeformationCellTriangleIndices(mesh, cellIndex){
  return Array.isArray(mesh?.cells?.[cellIndex]?.triangleIndices)
    ? mesh.cells[cellIndex].triangleIndices
    : [];
}

function stage6BishopDeformationCellNodeIds(mesh, cellIndex){
  const nodeIds = [];
  const seen = new Set();
  stage6BishopDeformationCellTriangleIndices(mesh, cellIndex).forEach((triangleIndex)=>{
    (mesh?.elements?.[triangleIndex] || []).forEach((nodeId)=>{
      if(seen.has(nodeId)) return;
      seen.add(nodeId);
      nodeIds.push(nodeId);
    });
  });
  return nodeIds;
}

function stage6BishopDeformationElementContourValue(result, elementIndex, mode){
  if(mode === 'syy') mode = 'deltaSigmaYy';
  const item = result?.elementResults?.[elementIndex] || null;
  if(mode === 'epsilonXx') return stage6BishopDeformationFiniteScalar(item?.strain?.exx, 0);
  if(mode === 'epsilonYy') return stage6BishopDeformationFiniteScalar(item?.strain?.eyy, 0);
  if(mode === 'gammaXy') return stage6BishopDeformationFiniteScalar(item?.strain?.gxy, 0);
  if(mode === 'equivalentPlasticStrain') return stage6BishopDeformationFiniteScalar(item?.materialState?.accumulatedPlasticStrain, 0);
  if(mode === 'safetyEquivalentPlasticIncrement') return stage6BishopDeformationFiniteScalar(item?.materialDiagnostics?.safetyEquivalentPlasticIncrement, 0);
  if(mode === 'deltaSigmaYy') return -stage6BishopDeformationFiniteScalar(item?.stressIncrement?.syy, 0);
  if(mode === 'sigmaYyEffInit') return stage6BishopDeformationFiniteScalar(item?.initialEffectiveStress?.syy, 0);
  if(mode === 'sigmaYyEff') return stage6BishopDeformationFiniteScalar(item?.effectiveStress?.syy, 0);
  if(mode === 'sigmaYyTotalInit') return stage6BishopDeformationFiniteScalar(item?.initialTotalStress?.syy, 0);
  if(mode === 'sigmaYyTotal') return stage6BishopDeformationFiniteScalar(item?.totalStress?.syy, 0);
  if(mode === 'sigmaXxEffInit') return stage6BishopDeformationFiniteScalar(item?.initialEffectiveStress?.sxx, 0);
  if(mode === 'sigmaXxEff') return stage6BishopDeformationFiniteScalar(item?.effectiveStress?.sxx, 0);
  if(mode === 'sigmaXxTotalInit') return stage6BishopDeformationFiniteScalar(item?.initialTotalStress?.sxx, 0);
  if(mode === 'sigmaXxTotal') return stage6BishopDeformationFiniteScalar(item?.totalStress?.sxx, 0);
  if(mode === 'tauXy') return stage6BishopDeformationFiniteScalar(item?.effectiveStress?.txy, 0);
  if(mode === 'hsGammaP') return stage6BishopDeformationFiniteScalar(item?.materialState?.hs?.gammaPMax, 0);
  if(mode === 'hsPP') return stage6BishopDeformationFiniteScalar(item?.materialState?.hs?.pPMax, 0);
  // ε_v^p is signed (compression-positive); flip the sign so dilative
  // magnitudes render as positive lobes in the diverging palette.
  if(mode === 'hsEpsVPDilative') return -stage6BishopDeformationFiniteScalar(item?.materialState?.hs?.epsVPDilative, 0);
  if(mode === 'hsLastActiveSet') return stage6BishopDeformationFiniteScalar(item?.materialState?.hs?.dominantActiveSet, 0);
  return stage6BishopDeformationElementEtaMc(item);
}

function stage6BishopDeformationContourValue(result, mesh, cellIndex, mode){
  const nodal = result?.nodalDisplacements || [];
  const nodeIds = stage6BishopDeformationCellNodeIds(mesh, cellIndex);
  if(mode === 'settlement'){
    return stage6BishopAverageFiniteValues(nodeIds.map((nodeId)=>-stage6BishopDeformationFiniteScalar(nodal[nodeId]?.uy, 0)), 0);
  }
  if(mode === 'ux'){
    return stage6BishopAverageFiniteValues(nodeIds.map((nodeId)=>stage6BishopDeformationFiniteScalar(nodal[nodeId]?.ux, 0)), 0);
  }
  if(mode === 'uy'){
    return stage6BishopAverageFiniteValues(nodeIds.map((nodeId)=>stage6BishopDeformationFiniteScalar(nodal[nodeId]?.uy, 0)), 0);
  }
  if(mode === 'uTotal'){
    return stage6BishopAverageFiniteValues(
      nodeIds.map((nodeId)=>Math.hypot(stage6BishopDeformationFiniteScalar(nodal[nodeId]?.ux, 0), stage6BishopDeformationFiniteScalar(nodal[nodeId]?.uy, 0))),
      0
    );
  }
  return stage6BishopAverageFiniteValues(
    stage6BishopDeformationCellTriangleIndices(mesh, cellIndex).map((elementIndex)=>stage6BishopDeformationElementContourValue(result, elementIndex, mode)),
    null
  );
}

function stage6BishopDeformationContourModeIsSigned(mode, analysisType = null){
  return !!stage6BishopDeformationContourMeta(mode, analysisType).signed;
}

function stage6BishopDeformationContourStats(result, mesh, mode, analysisType = null){
  const values = (mesh?.cells || []).map((_, index)=>stage6BishopDeformationContourValue(result, mesh, index, mode)).filter(Number.isFinite);
  if(!values.length) return {min:0, max:1};
  const min = Math.min(...values);
  const max = Math.max(...values);
  if(stage6BishopDeformationContourModeIsSigned(mode, analysisType)){
    const abs = Math.max(Math.abs(min), Math.abs(max), 1e-9);
    return {min:-abs, max:abs};
  }
  return {
    min,
    max: max > min + 1e-9 ? max : min + 1
  };
}

function stage6BishopDeformationContourNodalValues(result, mesh, mode){
  const nodeCount = mesh?.nodes?.length || 0;
  if(!nodeCount) return [];
  if(mode === 'settlement') return Array.from({length:nodeCount}, (_, nodeId)=>-stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.uy, 0));
  if(mode === 'ux') return Array.from({length:nodeCount}, (_, nodeId)=>stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.ux, 0));
  if(mode === 'uy') return Array.from({length:nodeCount}, (_, nodeId)=>stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.uy, 0));
  if(mode === 'uTotal') return Array.from({length:nodeCount}, (_, nodeId)=>Math.hypot(
    stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.ux, 0),
    stage6BishopDeformationFiniteScalar(result?.nodalDisplacements?.[nodeId]?.uy, 0)
  ));
  const sums = new Array(nodeCount).fill(0);
  const weights = new Array(nodeCount).fill(0);
  (mesh?.elements || []).forEach((element, elementIndex)=>{
    const value = stage6BishopDeformationElementContourValue(result, elementIndex, mode);
    if(!Number.isFinite(value)) return;
    const weight = Math.max(Number(mesh?.elementData?.[elementIndex]?.area) || 0, 1e-6);
    element.forEach((nodeId)=>{
      sums[nodeId] += value * weight;
      weights[nodeId] += weight;
    });
  });
  return sums.map((sum, index)=>weights[index] > 0 ? sum / weights[index] : 0);
}

function stage6BishopDeformationVisualContourMesh(mesh, mode){
  if(mesh?.elementType !== 't6' || !stage6BishopDeformationVectorMode(mode)) return mesh;
  return {
    ...mesh,
    elements:(mesh.elements || []).flatMap((element)=>stage6BishopT6VisualSubtriangles(element))
  };
}

const ST6_DEFORMATION_SEQ_PALETTE = [
  {t:0.00, rgb:[24, 52, 166]},
  {t:0.18, rgb:[36, 118, 224]},
  {t:0.36, rgb:[33, 193, 233]},
  {t:0.55, rgb:[46, 191, 104]},
  {t:0.72, rgb:[244, 223, 67]},
  {t:0.86, rgb:[243, 150, 36]},
  {t:1.00, rgb:[202, 32, 36]}
];
const ST6_DEFORMATION_SIGNED_PALETTE = [
  {t:0.00, rgb:[25, 58, 168]},
  {t:0.20, rgb:[41, 131, 229]},
  {t:0.40, rgb:[79, 205, 232]},
  {t:0.50, rgb:[250, 245, 198]},
  {t:0.70, rgb:[244, 182, 58]},
  {t:0.85, rgb:[237, 114, 34]},
  {t:1.00, rgb:[196, 33, 34]}
];

function stage6BishopInterpolatePalette(stops, t){
  const clamped = Math.max(0, Math.min(t, 1));
  for(let index = 1; index < stops.length; index += 1){
    const prev = stops[index - 1];
    const next = stops[index];
    if(clamped > next.t) continue;
    const span = Math.max(next.t - prev.t, 1e-9);
    const localT = (clamped - prev.t) / span;
    return {
      r:Math.round(prev.rgb[0] + (next.rgb[0] - prev.rgb[0]) * localT),
      g:Math.round(prev.rgb[1] + (next.rgb[1] - prev.rgb[1]) * localT),
      b:Math.round(prev.rgb[2] + (next.rgb[2] - prev.rgb[2]) * localT)
    };
  }
  const last = stops[stops.length - 1];
  return {r:last.rgb[0], g:last.rgb[1], b:last.rgb[2]};
}

function stage6BishopDeformationContourRgb(value, min, max, mode, analysisType = null){
  const lo = Number.isFinite(min) ? min : 0;
  const hi = Number.isFinite(max) && max > lo ? max : lo + 1;
  const finiteValue = Number.isFinite(value)
    ? value
    : (stage6BishopDeformationContourModeIsSigned(mode, analysisType) ? 0 : lo);
  if(stage6BishopDeformationContourModeIsSigned(mode, analysisType)){
    const span = Math.max(Math.abs(lo), Math.abs(hi), 1e-9);
    return stage6BishopInterpolatePalette(
      ST6_DEFORMATION_SIGNED_PALETTE,
      Math.max(0, Math.min((finiteValue + span) / (2 * span), 1))
    );
  }
  return stage6BishopInterpolatePalette(
    ST6_DEFORMATION_SEQ_PALETTE,
    Math.max(0, Math.min((finiteValue - lo) / (hi - lo), 1))
  );
}

function stage6BishopDeformationContourColor(value, min, max, mode, alpha = 0.6, analysisType = null){
  const rgb = stage6BishopDeformationContourRgb(value, min, max, mode, analysisType);
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function stage6BishopDeformationContourLineColor(value, min, max, mode, alpha = 0.92, analysisType = null){
  const rgb = stage6BishopDeformationContourRgb(value, min, max, mode, analysisType);
  return `rgba(${Math.round(rgb.r * 0.72)}, ${Math.round(rgb.g * 0.72)}, ${Math.round(rgb.b * 0.72)}, ${alpha})`;
}

function stage6BishopDeformationContourLegendGradient(mode, analysisType = null){
  const stops = stage6BishopDeformationContourModeIsSigned(mode, analysisType)
    ? ST6_DEFORMATION_SIGNED_PALETTE
    : ST6_DEFORMATION_SEQ_PALETTE;
  return `linear-gradient(to top, ${stops.map((stop)=>`rgb(${stop.rgb[0]}, ${stop.rgb[1]}, ${stop.rgb[2]}) ${Math.round(stop.t * 100)}%`).join(', ')})`;
}

function stage6BishopDeformationContourLegendTicks(mode, stats, analysisType = null){
  if(stage6BishopDeformationContourModeIsSigned(mode, analysisType)){
    const span = Math.max(Math.abs(stats?.min || 0), Math.abs(stats?.max || 0), 1e-9);
    return [span, 0.5 * span, 0, -0.5 * span, -span];
  }
  const min = Number.isFinite(stats?.min) ? stats.min : 0;
  const max = Number.isFinite(stats?.max) ? stats.max : 1;
  return [max, min + 0.75 * (max - min), min + 0.5 * (max - min), min + 0.25 * (max - min), min];
}

function stage6BishopDeformationContourLegendValue(mode, value, analysisType = null){
  const meta = stage6BishopDeformationContourMeta(mode, analysisType);
  const scaled = value * (meta.scale || 1);
  return `${stage6CompactNumber(scaled, meta.digits || 3)}${meta.unit ? ` ${meta.unit}` : ''}`;
}

function stage6BishopDeformationContourFlatTolerance(mode, analysisType = null){
  const meta = stage6BishopDeformationContourMeta(mode, analysisType);
  const digits = Math.max(Math.round(Number(meta?.digits) || 0), 0);
  const scale = Math.max(Math.abs(Number(meta?.scale) || 1), 1e-12);
  return 0.5 * Math.pow(10, -digits) / scale;
}

function stage6BishopDeformationContourLevels(mode, stats, count = 11, analysisType = null){
  const min = Number.isFinite(stats?.min) ? stats.min : 0;
  const max = Number.isFinite(stats?.max) ? stats.max : min + 1;
  const flatTolerance = Math.max(1e-9, stage6BishopDeformationContourFlatTolerance(mode, analysisType));
  if(!(max > min + flatTolerance)) return [];
  const out = [];
  for(let index = 1; index < count; index += 1){
    const t = index / count;
    const level = min + (max - min) * t;
    if(stage6BishopDeformationContourModeIsSigned(mode, analysisType) && Math.abs(level) < 1e-10) continue;
    out.push(level);
  }
  if(stage6BishopDeformationContourModeIsSigned(mode, analysisType) && min < 0 && max > 0){
    out.push(0);
    out.sort((a, b)=>a - b);
  }
  return out;
}

function stage6BishopDeformationContourDerived(result, mesh, mode){
  ensureStage6State();
  S.stage6Cache ||= {};
  const store = S.stage6Cache.bishopDeformationContourDerived || (S.stage6Cache.bishopDeformationContourDerived = {});
  const cached = store[mode];
  if(cached && cached.result === result && cached.mesh === mesh) return cached;
  const analysisType = result?.solver?.analysisType === 'safety-cphi' ? 'safety-cphi' : null;
  const stats = stage6BishopDeformationContourStats(result, mesh, mode, analysisType);
  const nodalValues = stage6BishopDeformationContourNodalValues(result, mesh, mode);
  const levels = stage6BishopDeformationContourLevels(mode, stats, 11, analysisType);
  const contourMesh = stage6BishopDeformationVisualContourMesh(mesh, mode);
  const levelSegments = levels.map((level)=>({
    level,
    segments:contourSegmentsForTriangles(contourMesh, nodalValues, level)
  })).filter((group)=>group.segments.length);
  const next = {result, mesh, mode, stats, nodalValues, levels, levelSegments};
  store[mode] = next;
  return next;
}

function stage6BishopSyncSeepageState(model){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  const seepage = bishop.seepage;
  const boundary = stage6BishopCurrentSeepageBoundary(model);
  seepage.bcs = migrateSeepageBcs(seepage.bcs, boundary);
  seepage.drainValidation = model ? validateDrains(model) : {errors:[], warnings:[]};
  const geometryHash = model ? seepageGeometryHash(model, seepage.options) : '';
  if(seepage.geometryHash && geometryHash && seepage.geometryHash !== geometryHash){
    const clearMesh = seepage.options.freeSurface === 'fixed' || !model?.phreatic;
    stage6BishopInvalidateSeepage('Seepage inputs changed.', !clearMesh);
  }
  seepage.geometryHash = geometryHash;
  if(seepage.selectedEdgeKey && !boundary.some((edge)=>edge.edgeKey === seepage.selectedEdgeKey)){
    seepage.selectedEdgeKey = '';
  }
  if(seepage.selectedBcId && !seepage.bcs.some((bc)=>bc.id === seepage.selectedBcId)){
    seepage.selectedBcId = '';
  }
  return boundary;
}

function stage6BishopSelectSeepageBoundary(edgeKey){
  ensureStage6State();
  const seepage = S.stage6.bishop.seepage;
  seepage.selectedEdgeKey = edgeKey || '';
  const model = S.stage6Cache?.bishopModel || stage6BishopCurrentModel();
  const boundary = S.stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model);
  const edge = (boundary || []).find((item)=>item.edgeKey === edgeKey) || null;
  let bc = stage6BishopSeepageBcForEdge(edgeKey);
  if(!bc && edge){
    stage6RememberDetailsState();
    bc = stage6BishopAutoApplySeepagePreset(edge);
    if(bc) stage6BishopInvalidateSeepage('Boundary conditions changed. Showing the previous result until you rerun.', true, true);
  }
  seepage.selectedBcId = bc?.id || '';
  renderStage6();
}

function stage6BishopSetSeepageBcType(value){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  const model = S.stage6Cache?.bishopModel || stage6BishopCurrentModel();
  const edge = stage6BishopSelectedBoundaryEdge(model);
  if(!edge) return;
  const seepage = bishop.seepage;
  const existing = stage6BishopSeepageBcForEdge(edge.edgeKey);
  const nextType = value === 'head' ? 'head' : value === 'seepage-face' ? 'seepage-face' : 'no-flow';
  const bc = makeSeepageBoundaryCondition(edge, {
    ...existing,
    id:existing?.id || `bc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type:nextType,
    head:nextType === 'head' ? (Number.isFinite(existing?.head) ? existing.head : edge.mid.y) : null
  });
  seepage.bcs = [...(seepage.bcs || []).filter((item)=>item.edgeKey !== edge.edgeKey), bc];
  seepage.selectedBcId = bc.id;
  stage6BishopRememberSeepageBcPreset(bc);
  stage6BishopInvalidateSeepage('Boundary conditions changed. Showing the previous result until you rerun.', true, true);
  renderStage6();
}

function stage6BishopSetSeepageBcHead(value){
  ensureStage6State();
  stage6RememberDetailsState();
  const seepage = S.stage6.bishop.seepage;
  const bc = (seepage.bcs || []).find((item)=>item.id === seepage.selectedBcId) || null;
  if(!bc) return;
  bc.type = 'head';
  bc.head = value === '' || value == null ? null : +value;
  stage6BishopRememberSeepageBcPreset(bc);
  stage6BishopInvalidateSeepage('Boundary head changed. Showing the previous result until you rerun.', true, true);
  renderStage6();
}

function stage6BishopDeleteSeepageBc(edgeKey){
  ensureStage6State();
  stage6RememberDetailsState();
  const seepage = S.stage6.bishop.seepage;
  seepage.bcs = (seepage.bcs || []).filter((bc)=>bc.edgeKey !== edgeKey);
  if(seepage.selectedEdgeKey === edgeKey) seepage.selectedBcId = '';
  stage6BishopInvalidateSeepage('Boundary condition removed. Showing the previous result until you rerun.', true, true);
  renderStage6();
}

function stage6BishopInvalidateDeformation(message, keepMesh, preserveSolvedState){
  ensureStage6State();
  stage6BishopStopDeformation(true);
  return seepslopeInvalidateDeformation(S.stage6.bishop, {message, keepMesh, preserveSolvedState});
}

function stage6BishopInvalidate(message){
  ensureStage6State();
  stage6BishopStopSearch(true);
  stage6BishopStopDeformation(true);
  return seepslopeInvalidateBishop(S.stage6.bishop, message);
}

function stage6BishopInvalidateWallGeometry(message){
  ensureStage6State();
  stage6BishopStopSearch(true);
  stage6BishopStopDeformation(true);
  stage6BishopStopSeepage(true);
  return seepslopeInvalidateWallGeometry(S.stage6.bishop, message);
}

// ── seepslope/model soil-model façades (refactor step 9b / PR 18b) ──────────────────────────
// The soil-model sync (materials from the Stage 3/4 working layers by signature, the HS mirror,
// the geometry normalisation, the selection pruning) lives in seepslope/model/sync-soil-model.js
// as a pure patch of the bishop block; this façade applies it to the active CPT and fires the
// Bishop invalidation a re-import carries (the same message strings). Returns the working layers
// the model is built from, as before.
//
// Order: the monolith fired stage6BishopInvalidate in the *middle* of the sync (right after the
// re-import, before the HS mirror / geometry / pruning); here the whole patch lands first and the
// invalidation follows. The two are equivalent — the invalidator writes results / selectedResult /
// stale / progress.message / deformation.*, none of which the sync touches, and every key exists
// after ensure() so no key order moves. scripts/verify_seepslope_model.mjs (a) checks it.
function stage6BishopSyncSoilModel(){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  const layers = stage6WorkingLayers();
  const sync = seepslopeSyncSoilModel(bishop, layers);
  if(sync.changed) seepslopeApplySoilModelPatch(bishop, sync.patch);
  if(sync.invalidation) stage6BishopInvalidate(sync.invalidation.message);
  return layers;
}

function stage6BishopCurrentModel(){
  const layers = stage6BishopSyncSoilModel();
  const model = buildBishopModelFromStageLayers(layers, S.stage6.bishop);
  S.stage6Cache.bishopModel = model;
  stage6BishopSyncSeepageState(model);
  return model;
}

function stage6BishopSetSelectedRegion(regionId){
  ensureStage6State();
  seepslopeSetSelectedRegion(S.stage6.bishop, regionId);
  renderStage6();
}

function stage6BishopCopyCurrentRegionsToCustom(){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  const model = stage6BishopCurrentModel();
  if(!seepslopeCopyCurrentRegionsToCustom(bishop, model)){
    renderStage6();
    return;
  }
  if(bishop.useCustomRegions) stage6BishopCurrentModel();
  stage6BishopInvalidate('Current solver polygons were copied into an editable custom polygon set and automatically enabled in the solver; rerun Bishop search after edits.');
  renderStage6();
}


// Read-only export of the current soil regions as a DXF of closed polygons that
// PLAXIS 2D imports directly as clusters for material assignment. Mirrors the
// visible regions (custom polygons when present, else the CPT-derived set).
function stage6BishopExportRegionsDxf(){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  const model = stage6BishopCurrentModel();
  const regions = model ? stage6BishopDisplayRegions(model) : [];
  if(!regions.length){
    bishop.progress.message = 'Draw terrain and place the active CPT marker (or copy CPT regions) before exporting to DXF.';
    renderStage6();
    return;
  }
  const testid = S.meta?.testid || S.id || 'section';
  const dxf = exportRegionsToDxf(regions, {
    title:`MADEP CPT soil regions (${testid}) - metres - import into PLAXIS 2D at scale 1.0`
  });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([dxf], {type:'application/dxf'}));
  a.download = `CPT_${testid}_regions.dxf`;
  a.click();
  const count = regions.length;
  bishop.progress.message = `Exported ${count} soil ${count === 1 ? 'region' : 'regions'} to DXF (metres, closed polygons for PLAXIS 2D).`;
  renderStage6();
}

function stage6BishopSetUseCustomRegions(value){
  ensureStage6State();
  stage6RememberDetailsState();
  const useCustomRegions = seepslopeSetUseCustomRegions(S.stage6.bishop, value);
  stage6BishopInvalidate(useCustomRegions ? 'Custom soil polygons enabled; rerun Bishop search.' : 'Reverted to CPT-derived soil polygons; rerun Bishop search.');
  renderStage6();
}

function stage6BishopClearCustomRegions(message){
  ensureStage6State();
  seepslopeClearCustomRegions(S.stage6.bishop);
  stage6BishopInvalidate(message || 'Custom soil polygons were cleared; Bishop reverted to CPT-derived polygons.');
}

function stage6BishopDeleteSelectedRegion(){
  ensureStage6State();
  stage6RememberDetailsState();
  if(!seepslopeDeleteSelectedRegion(S.stage6.bishop)) return;
  stage6BishopInvalidate('Custom soil polygon removed; rerun Bishop search.');
  renderStage6();
}

function stage6BishopSetSelectedRegionMaterial(materialId){
  ensureStage6State();
  stage6RememberDetailsState();
  if(!seepslopeSetSelectedRegionMaterial(S.stage6.bishop, materialId)) return;
  stage6BishopSyncSoilModel();
  stage6BishopInvalidate('Custom soil polygon material updated; rerun Bishop search.');
  renderStage6();
}

function stage6BishopSetSelectedRegionCoarseness(value){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  if(!seepslopeSetSelectedRegionCoarseness(bishop, value)) return;
  stage6BishopSyncSoilModel();
  if(bishop.useCustomRegions && (bishop.customRegions || []).length){
    stage6BishopInvalidateSeepage('Selected polygon coarseness changed. Showing the previous result until you rerun.', true, true);
  } else {
    bishop.progress.message = 'Selected polygon coarseness updated. Enable custom polygons in the solver for it to affect seepage meshing.';
  }
  renderStage6();
}


function stage6BishopCommitPendingSelectedRegionCoarseness(){
  if(typeof document === 'undefined') return;
  const input = document.getElementById('st6-bishop-selected-region-coarseness');
  if(!input) return;
  stage6BishopSetSelectedRegionCoarseness(input.value);
}

function stage6BishopSplitSelectedRegion(){
  ensureStage6State();
  stage6RememberDetailsState();
  const outcome = seepslopeSplitSelectedRegion(S.stage6.bishop, {
    splitPolygon: (region, first, second) => stage6BishopSplitRegionPolygon(region, first, second)
  });
  if(outcome.ok) stage6BishopInvalidate('Custom soil polygon split into two polygons; rerun Bishop search.');
  renderStage6();
}


function stage6BishopSetField(path, value){
  ensureStage6State();
  stage6RememberDetailsState();
  if(typeof path === 'string' && path.startsWith('surfaceLoad.')){
    const field = path.slice('surfaceLoad.'.length);
    const target = stage6BishopPrimarySurfaceLoad(false);
    if(target){
      if(field === 'q' && target.loadMode === 'total' && stage6BishopValidZone(target)){
        const width = Math.max(target.xEnd - target.xStart, 0);
        const outOfPlaneLength = Math.max(Number(S.stage6.bishop.deformation?.options?.outOfPlaneLength) || 10, 0.1);
        stage6BishopSetSurfaceLoadField(target.id, 'totalLoad', (Math.max(Number(value) || 0, 0) * width * outOfPlaneLength));
      } else {
        stage6BishopSetSurfaceLoadField(target.id, field, value);
      }
      return;
    }
    if(!S.stage6.bishop.surfaceLoad || typeof S.stage6.bishop.surfaceLoad !== 'object'){
      S.stage6.bishop.surfaceLoad = {xStart:null, xEnd:null, q:0};
    }
    if(field === 'q') S.stage6.bishop.surfaceLoad.q = Math.max(Number(value) || 0, 0);
    else if(field === 'xStart' || field === 'xEnd') S.stage6.bishop.surfaceLoad[field] = Number.isFinite(Number(value)) ? Number(value) : null;
    stage6BishopSyncLegacySurfaceLoadMirror(S.stage6.bishop);
    stage6BishopInvalidate('Surface load changed; rerun the active analysis.');
    renderStage6();
    return;
  }
  const defaults = stage6Defaults().bishop;
  const currentDefault = stage6Get(defaults, path);
  let nextValue = value;
  if(path === 'seepage.options.meshTargetArea'){
    const numeric = value === '' || value == null ? null : +value;
    const isManual = Number.isFinite(numeric) && numeric > 0;
    S.stage6.bishop.seepage.options.meshTargetAreaAuto = !isManual;
    nextValue = isManual ? numeric : stage6BishopAutoSeepageMeshTargetArea(S.stage6.bishop);
  } else if(path === 'deformation.options.meshTargetArea'){
    const numeric = value === '' || value == null ? null : +value;
    const isManual = Number.isFinite(numeric) && numeric > 0;
    S.stage6.bishop.deformation.options.meshTargetAreaAuto = !isManual;
    nextValue = isManual ? numeric : stage6BishopAutoDeformationMeshTargetArea(S.stage6.bishop);
  } else if(path === 'seepage.options.flowErrorTolerance'){
    nextValue = value === '' || value == null ? null : (+value / 100);
  } else if(path === 'seepage.options.maxRuntimeMs'){
    nextValue = value === '' || value == null ? null : (+value * 1000);
  } else if(path === 'seepage.options.meshTargetAreaAuto'){
    nextValue = !!value;
  } else if(path === 'deformation.options.meshTargetAreaAuto'){
    nextValue = !!value;
  } else if(typeof currentDefault === 'number'){
    nextValue = value === '' || value == null ? null : +value;
  } else if(typeof currentDefault === 'boolean'){
    nextValue = !!value;
  }

  if(path === 'seepage.options.meshTargetAreaAuto' && nextValue){
    S.stage6.bishop.seepage.options.meshTargetArea = stage6BishopAutoSeepageMeshTargetArea(S.stage6.bishop);
  } else if(path === 'seepage.options.meshTargetAreaAuto' && !(Number(S.stage6.bishop.seepage.options.meshTargetArea) > 0)){
    S.stage6.bishop.seepage.options.meshTargetArea = stage6BishopAutoSeepageMeshTargetArea(S.stage6.bishop);
  }
  if(path === 'deformation.options.meshTargetAreaAuto' && nextValue){
    S.stage6.bishop.deformation.options.meshTargetArea = stage6BishopAutoDeformationMeshTargetArea(S.stage6.bishop);
  } else if(path === 'deformation.options.meshTargetAreaAuto' && !(Number(S.stage6.bishop.deformation.options.meshTargetArea) > 0)){
    S.stage6.bishop.deformation.options.meshTargetArea = stage6BishopAutoDeformationMeshTargetArea(S.stage6.bishop);
  }
	  stage6Set(S.stage6.bishop, path, nextValue);
  if(path === 'deformation.options.constitutiveModel' && nextValue === 'hardening-soil' && !STAGE6_ENABLE_HARDENING_SOIL_UI){
    S.stage6.bishop.deformation.options.constitutiveModel = 'mc-plastic';
  }
  if(path === 'deformation.options.loadMode'){
    const load = stage6BishopPrimarySurfaceLoad(false);
    if(load){
      load.loadMode = nextValue === 'total' ? 'total' : 'pressure';
      stage6BishopSyncLegacySurfaceLoadMirror(S.stage6.bishop);
    }
  }
  if(path === 'deformation.options.totalLoad'){
    const load = stage6BishopPrimarySurfaceLoad(false);
    if(load) load.totalLoad = Math.max(Number(nextValue) || 0, 0);
  }
  if(path === 'deformation.options.solverBackend'){
    // Sync the legacy fields so the worker payload + solver dispatch
    // keep working off the same source of truth without waiting for the
    // next render-time normalisation.
    const backend = String(nextValue || 'wasm-cpu');
    const canonicalBackend = ['js-cpu', 'wasm-cpu'].includes(backend) ? backend : 'wasm-cpu';
    S.stage6.bishop.deformation.options.solverBackend = canonicalBackend;
    S.stage6.bishop.deformation.options.useWasmCpuPipeline = canonicalBackend === 'wasm-cpu';
    S.stage6.bishop.deformation.options.useNewGpuPipeline = false;
    S.stage6.bishop.deformation.options.gpuPipelineVersion = 'v1';
  }
  if(path === 'deformation.options.analysisType' && nextValue === 'safety-cphi'){
    const currentConstitutiveModel = S.stage6.bishop.deformation?.options?.constitutiveModel;
    if(currentConstitutiveModel !== 'mc-plastic' && !(STAGE6_ENABLE_HARDENING_SOIL_UI && currentConstitutiveModel === 'hardening-soil')){
      S.stage6.bishop.deformation.options.constitutiveModel = 'mc-plastic';
    }
    if(STAGE6_ENABLE_HARDENING_SOIL_UI && S.stage6.bishop.deformation?.options?.constitutiveModel === 'hardening-soil'){
      S.stage6.bishop.deformation.options.solverBackend = 'wasm-cpu';
      S.stage6.bishop.deformation.options.useWasmCpuPipeline = true;
      S.stage6.bishop.deformation.options.useNewGpuPipeline = false;
    }
  }
  if(path === 'deformation.options.constitutiveModel' && S.stage6.bishop.deformation?.options?.constitutiveModel !== 'mc-plastic'){
    if(String(S.stage6.bishop.deformation?.options?.geostaticInitializationMethod || '').toLowerCase() === 'gravity-ramp'){
      S.stage6.bishop.deformation.options.geostaticInitializationMethod = 'auto';
    }
    // Safety analysis is allowed for the visible production plastic model;
    // any other constitutive model forces the analysis back to plain deformation.
    if(
      !(STAGE6_ENABLE_HARDENING_SOIL_UI && S.stage6.bishop.deformation?.options?.constitutiveModel === 'hardening-soil') &&
      S.stage6.bishop.deformation?.options?.analysisType === 'safety-cphi'
    ){
      S.stage6.bishop.deformation.options.analysisType = 'deformation';
    }
    if(STAGE6_ENABLE_HARDENING_SOIL_UI && nextValue === 'hardening-soil' && S.stage6.bishop.deformation?.options?.analysisType === 'safety-cphi'){
      S.stage6.bishop.deformation.options.solverBackend = 'wasm-cpu';
      S.stage6.bishop.deformation.options.useWasmCpuPipeline = true;
      S.stage6.bishop.deformation.options.useNewGpuPipeline = false;
    }
  }
  if(path.startsWith('lineProbe.') && path !== 'lineProbe.copyMessage' && path !== 'lineProbe.copyTone'){
    S.stage6.bishop.lineProbe.copyMessage = '';
    S.stage6.bishop.lineProbe.copyTone = '';
  }
  const isViewOnly = path === 'gridSnap' ||
    path === 'pointSnap' ||
    path === 'snapSize' ||
    path === 'deformation.options.displacementScale' ||
    path.startsWith('viewport.') ||
    path.startsWith('display.') ||
    path.startsWith('lineProbe.');
  const isSeepageField = path === 'workspace' || path === 'useFemPorePressure' || path.startsWith('seepage.');
  const isDeformationField = path === 'workspace' || path.startsWith('deformation.');
  if(path.startsWith('seepage.')){
    if(!path.startsWith('seepage.display.')){
      stage6BishopInvalidateSeepage('Seepage settings changed. Showing the previous result until you rerun.', true, true);
    }
  }
  if(path.startsWith('deformation.')){
    if(path !== 'deformation.options.displacementScale' && !path.startsWith('deformation.display.')){
      stage6BishopInvalidateDeformation('Deformation settings changed. Showing the previous result until you rerun.', true, true);
    }
  }
  if(path === 'useFemPorePressure'){
    stage6BishopInvalidate(nextValue ? 'FEM pore pressure enabled; rerun Bishop search.' : 'Reverted to hydrostatic pore pressure; rerun Bishop search.');
  } else if(!(isViewOnly || isSeepageField || isDeformationField)){
    stage6BishopInvalidate();
  }
  renderStage6();
}

function stage6BishopSetWorkspace(workspace){
  ensureStage6State();
  stage6RememberDetailsState();
  const next = workspace === 'seepage' ? 'seepage' : workspace === 'deformation' ? 'deformation' : 'stability';
  S.stage6.bishop.workspace = next;
  if(next === 'seepage' && S.stage6.bishop.tool === 'terrain'){
    S.stage6.bishop.tool = 'seepageBc';
  } else if(next !== 'seepage' && (S.stage6.bishop.tool === 'seepageBc' || S.stage6.bishop.tool === 'drain')){
    S.stage6.bishop.tool = 'edit';
  }
  renderStage6();
}

function stage6BishopSetTool(tool){
  ensureStage6State();
  stage6RememberDetailsState();
  if((tool === 'regionSplit' || tool === 'regionHole') && !stage6BishopSelectedCustomRegion()){
    S.stage6.bishop.progress.message = `Select a custom polygon first in Edit / pan mode, then choose ${tool === 'regionHole' ? 'Cut hole' : 'Split selected'}.`;
    renderStage6();
    return;
  }
  const prevTool = S.stage6.bishop.tool;
  S.stage6.bishop.tool = tool;
  if(tool === 'load'){
    S.stage6.bishop.selectedSurfaceLoadId = null;
  }
  if(tool !== prevTool && S.stage6.bishop.draftKind && S.stage6.bishop.draftKind !== tool){
    S.stage6.bishop.draft = [];
    S.stage6.bishop.draftKind = '';
  }
  if(tool === 'drain'){
    S.stage6.bishop.workspace = 'seepage';
    stage6SetDetailsOpen('bishop-seepage-drains', true);
  }
  renderStage6();
}

function stage6BishopTriggerDxfImport(){
  const input = document.getElementById('stage6BishopDxfInput');
  if(input) input.click();
}

function stage6BishopApplyImportedTerrain(vertices, label){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  bishop.terrain = stage6BishopSortedPolyline(vertices);
  bishop.phreatic = [];
  bishop.walls = [];
  bishop.drains = [];
  bishop.selectedDrainId = '';
  bishop.draft = [];
  bishop.draftKind = '';
	  bishop.entryZone = null;
	  bishop.exitZone = null;
	  bishop.surfaceLoad = {...bishop.surfaceLoad, xStart:null, xEnd:null};
	  bishop.surfaceLoads = [];
	  bishop.selectedSurfaceLoadId = null;
  bishop.activeCptX = null;
  bishop.customRegions = [];
  bishop.useCustomRegions = false;
  bishop.selectedRegionId = null;
  bishop.measurement = {points:[]};
  bishop.viewport.fitted = false;
  stage6BishopInvalidate(`Terrain imported from DXF${label ? ` (${label})` : ''}; retaining walls and custom soil polygons were cleared, so review the CPT position and redraw the zones before rerunning the search.`);
  renderStage6();
}

function stage6BishopImportDxf(event){
  ensureStage6State();
  const input = event?.target;
  const file = input?.files?.[0];
  if(input) input.value = '';
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (loadEvent)=>{
    try{
      const imported = importTerrainFromDxfText(loadEvent?.target?.result);
      stage6BishopApplyImportedTerrain(imported.vertices, file.name);
    }catch(error){
      const message = error?.message || 'Unable to import terrain from DXF.';
      S.stage6.bishop.progress.message = message;
      renderStage6();
      alert(`${file.name}: ${message}`);
    }
  };
  reader.onerror = ()=>{
    const message = `Error reading ${file.name}`;
    S.stage6.bishop.progress.message = message;
    renderStage6();
    alert(message);
  };
  reader.readAsText(file);
}

function stage6BishopPopDraftPoint(){
  ensureStage6State();
  if(S.stage6.bishop.draft?.length) S.stage6.bishop.draft.pop();
  renderStage6();
}

function stage6BishopFinishDraft(){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  if(bishop.draftKind === 'terrain' && bishop.draft.length >= 2){
    bishop.terrain = stage6BishopSortedPolyline(bishop.draft);
    bishop.walls = [];
    bishop.drains = [];
    bishop.selectedDrainId = '';
    bishop.customRegions = [];
    bishop.useCustomRegions = false;
    bishop.selectedRegionId = null;
    bishop.viewport.fitted = false;
    if(!bishop.entryZone) bishop.entryZone = null;
    if(!bishop.exitZone) bishop.exitZone = null;
    stage6BishopInvalidate('Terrain updated; retaining walls and custom soil polygons were cleared and Bishop results were reset.');
  } else if(bishop.draftKind === 'phreatic' && bishop.draft.length >= 2){
    bishop.phreatic = stage6BishopSortedPolyline(bishop.draft);
    stage6BishopInvalidate('Phreatic line updated; rerun Bishop search.');
  } else if(bishop.draftKind === 'drain' && bishop.draft.length >= 2){
    if(!stage6BishopCreateDrainFromVertices(bishop.draft)){
      renderStage6();
      return;
    }
  } else if(bishop.draftKind === 'region' && bishop.draft.length >= 3){
    const polygon = normalizeRegionPolygon(bishop.draft);
    if(!stage6BishopPolygonIsValid(polygon)){
      bishop.progress.message = 'Soil polygons must be simple non-self-intersecting closed shapes.';
      renderStage6();
      return;
    }
    bishop.customRegions = stage6BishopNormalizeCustomRegions([
      ...(bishop.customRegions || []),
      {
        id:stage6BishopRegionId(),
        polygon,
        materialId:bishop.regionDraftMaterialId || bishop.materials?.[0]?.id || null,
        coarseness:1,
        source:'custom'
      }
    ], bishop.terrain, bishop.materials);
    bishop.useCustomRegions = bishop.customRegions.length > 0;
    bishop.selectedRegionId = bishop.customRegions[bishop.customRegions.length - 1]?.id || bishop.selectedRegionId;
    stage6BishopInvalidate('Custom soil polygon added; rerun Bishop search.');
  } else if(bishop.draftKind === 'regionHole' && bishop.draft.length >= 3){
    const parentRegion = stage6BishopSelectedCustomRegion();
    const outcome = stage6BishopValidateHolePolygon(parentRegion, bishop.draft);
    if(outcome.ok){
      const carvedPieces = stage6BishopSubtractHoleFromPolygon(parentRegion?.polygon, outcome.polygon);
      if(!carvedPieces.length){
        bishop.progress.message = 'That hole could not be carved into non-overlapping pieces. Try a simpler hole shape fully inside the selected polygon.';
        bishop.draft = [];
        bishop.draftKind = '';
        renderStage6();
        return;
      }
      const holeRegion = {
        id:stage6BishopRegionId(),
        polygon:outcome.polygon,
        materialId:bishop.regionDraftMaterialId || bishop.materials?.[0]?.id || null,
        coarseness:1,
        source:'hole'
      };
      const replacementRegions = carvedPieces.map((polygon)=>({
        id:stage6BishopRegionId(),
        polygon,
        materialId:parentRegion.materialId || bishop.materials?.[0]?.id || null,
        coarseness:stage6BishopNormalizeRegionCoarseness(parentRegion?.coarseness),
        source:'edited'
      }));
      bishop.customRegions = stage6BishopNormalizeCustomRegions([
        ...((bishop.customRegions || []).flatMap((region)=>region.id === parentRegion?.id ? [...replacementRegions, holeRegion] : [region]))
      ], bishop.terrain, bishop.materials);
      bishop.useCustomRegions = bishop.customRegions.length > 0;
      bishop.selectedRegionId = holeRegion.id;
      bishop.tool = 'edit';
      stage6BishopInvalidate('Hole cut applied; the original polygon was rewritten into surrounding pieces with no overlap. Rerun Bishop search.');
    } else {
      bishop.progress.message = outcome.message;
    }
  }
  bishop.draft = [];
  bishop.draftKind = '';
  renderStage6();
}

function stage6BishopClearMeasurement(){
  ensureStage6State();
  S.stage6.bishop.measurement = {points:[]};
}

function stage6BishopClear(kind){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  if(kind === 'terrain'){
    bishop.terrain = [];
    bishop.phreatic = [];
    bishop.walls = [];
    bishop.drains = [];
    bishop.selectedDrainId = '';
    bishop.customRegions = [];
    bishop.useCustomRegions = false;
    bishop.selectedRegionId = null;
    bishop.measurement = {points:[]};
	    bishop.entryZone = null;
	    bishop.exitZone = null;
	    bishop.surfaceLoad = {...bishop.surfaceLoad, xStart:null, xEnd:null};
	    bishop.surfaceLoads = [];
	    bishop.selectedSurfaceLoadId = null;
    bishop.activeCptX = null;
    bishop.viewport.fitted = false;
  } else if(kind === 'phreatic'){
    bishop.phreatic = [];
  } else if(kind === 'walls'){
    bishop.walls = [];
  } else if(kind === 'drains'){
    bishop.drains = [];
    bishop.selectedDrainId = '';
  } else if(kind === 'entry'){
    bishop.entryZone = null;
  } else if(kind === 'exit'){
    bishop.exitZone = null;
	  } else if(kind === 'load'){
	    bishop.surfaceLoad = {...bishop.surfaceLoad, xStart:null, xEnd:null};
	    bishop.surfaceLoads = [];
	    bishop.selectedSurfaceLoadId = null;
  } else if(kind === 'draft'){
    bishop.draft = [];
    bishop.draftKind = '';
    renderStage6();
    return;
  } else if(kind === 'measure'){
    stage6BishopClearMeasurement();
    renderStage6();
    return;
  } else if(kind === 'customRegions'){
    stage6BishopClearCustomRegions();
    renderStage6();
    return;
  } else if(kind === 'results'){
    bishop.results = null;
    bishop.selectedResult = 0;
    bishop.stale = true;
    renderStage6();
    return;
  } else if(kind === 'seepageResults'){
    stage6BishopInvalidateSeepage('Seepage result cleared.', false);
    renderStage6();
    return;
  } else if(kind === 'deformationResults'){
    stage6BishopInvalidateDeformation('Deformation result cleared.', false);
    renderStage6();
    return;
  }
  stage6BishopInvalidate();
  renderStage6();
}

function stage6BishopSetMaterialField(index, field, value){
  ensureStage6State();
  stage6BishopSyncSoilModel();
  const material = S.stage6.bishop.materials?.[index];
  if(!material) return;
  material[field] = field === 'label' ? value : +value;
  stage6BishopInvalidate('Material properties updated; rerun Bishop search.');
  renderStage6();
}

// Whitelist of HS-only fields routed through `stage6BishopSetMaterialHsField`
// — i.e. parameters that live under `material.hs.*` because they have NO
// upstream layer-model analogue (R_f, OCR, p_ref, e_init, e_max, optional
// near-surface confinement floor, Simo-Hughes tangent selector). The
// stiffness block (E50_ref / Eoed_ref / Eur_ref / m / ν_ur / K0_nc / ψ)
// is overridden via `stage6BishopSetMaterialField` (top-level fields) for
// parity with the MC panel.
const STAGE6_BISHOP_EDITABLE_HS_FIELDS = new Set(['p_ref', 'Rf', 'OCR', 'e_init', 'e_max', 'nearSurfaceMinConfiningStress', 'useConsistentTangent']);

function stage6BishopSetMaterialHsField(index, field, value){
  ensureStage6State();
  stage6BishopSyncSoilModel();
  const material = S.stage6.bishop.materials?.[index];
  if(!material) return;
  if(!STAGE6_BISHOP_EDITABLE_HS_FIELDS.has(field)) return;
  if(!material.hs || typeof material.hs !== 'object') material.hs = {};
  if(field === 'useConsistentTangent'){
    material.hs[field] = value === true || value === 'true' || value === 1 || value === '1';
    if(S.stage6.bishop.deformation?.options){
      S.stage6.bishop.deformation.options.hsConsistentTangentPromptPending = false;
      S.stage6.bishop.deformation.options.hsConsistentTangentMigrationResolved = true;
    }
  } else {
    material.hs[field] = value === '' || value == null ? null : +value;
  }
  stage6BishopInvalidate('Hardening Soil material properties updated; rerun deformation analysis.');
  renderStage6();
}

function stage6BishopResolveHsConsistentTangentMigration(enable){
  ensureStage6State();
  stage6BishopSyncSoilModel();
  const next = enable === true || enable === 'true' || enable === 1 || enable === '1';
  (S.stage6.bishop.materials || []).forEach((material)=>{
    if(!material.hs || typeof material.hs !== 'object') material.hs = {};
    material.hs.useConsistentTangent = next;
  });
  if(S.stage6.bishop.deformation?.options){
    S.stage6.bishop.deformation.options.hsConsistentTangentPromptPending = false;
    S.stage6.bishop.deformation.options.hsConsistentTangentMigrationResolved = true;
  }
  stage6BishopInvalidate('Hardening Soil tangent mode updated; rerun deformation analysis.');
  renderStage6();
}

function stage6BishopSetMaterialPermeability(index, field, value){
  ensureStage6State();
  stage6BishopSyncSoilModel();
  const material = S.stage6.bishop.materials?.[index];
  if(!material) return;
  const nextValue = value === '' || value == null ? null : +value;
  if(!(nextValue > 0)) return;
  material[field] = nextValue;
  material.kSource = 'user';
  stage6BishopInvalidateSeepage('Material permeability changed. Showing the previous result until you rerun.', true, true);
  renderStage6();
}

function stage6BishopResetMaterialPermeability(index){
  ensureStage6State();
  const layers = stage6WorkingLayers();
  const material = S.stage6.bishop.materials?.[index];
  const layer = layers?.[index];
  if(!material || !layer) return;
  const next = resolveMaterialPermeability(layer, null);
  material.kx = next.kx;
  material.ky = next.ky;
  material.kSource = next.kSource;
  stage6BishopInvalidateSeepage('Material permeability reset. Showing the previous result until you rerun.', true, true);
  renderStage6();
}

function stage6BishopSetWallField(index, field, value){
  ensureStage6State();
  stage6BishopSyncSoilModel();
  const change = seepslopeSetWallField(S.stage6.bishop, index, field, value);
  if(!change) return;
  if(change === 'mechanical'){
    stage6BishopInvalidateDeformation('Wall mechanical activation changed; rerun deformation analysis.');
  } else if(change === 'geometry'){
    stage6BishopInvalidateWallGeometry('Retaining wall geometry updated; rerun Bishop search.');
  } else {
    stage6BishopInvalidate('Retaining wall geometry updated; rerun Bishop search.');
  }
  renderStage6();
}

function stage6BishopSetWallMaterialField(index, field, value){
  ensureStage6State();
  stage6BishopSyncSoilModel();
  const change = seepslopeSetWallMaterialField(S.stage6.bishop, index, field, value);
  if(!change) return;
  if(change.seepage){
    stage6BishopInvalidateSeepage('Wall conductivity changed. Showing the previous result until you rerun.', true, true);
  }
  if(change.deformation){
    stage6BishopInvalidateDeformation('Wall mechanical material changed; rerun deformation analysis.', true, true);
  }
  renderStage6();
}

function stage6BishopDeleteWall(index){
  ensureStage6State();
  stage6BishopSyncSoilModel();
  seepslopeDeleteWall(S.stage6.bishop, index);
  stage6BishopInvalidateWallGeometry('Retaining wall removed; rerun Bishop search.');
  renderStage6();
}

function stage6BishopSelectWall(wallId){
  ensureStage6State();
  seepslopeSelectWall(S.stage6.bishop, wallId, stage6BishopUiState());
  renderStage6();
}


function stage6BishopToggleWallMomentOverlay(){
  ensureStage6State();
  const display = S.stage6.bishop.deformation.display || (S.stage6.bishop.deformation.display = {});
  display.showWallMomentOverlay = display.showWallMomentOverlay !== true;
  renderStage6();
}

function stage6BishopOpenAnalysisTab(tab = 'line-probe', wallId = ''){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  bishop.analysisTab = tab === 'structure' ? 'structure' : 'line-probe';
  if(wallId && (bishop.walls || []).some((wall)=>wall.id === wallId)){
    bishop.selectedWallId = wallId;
  }
  const ui = stage6BishopUiState();
  ui.bishopActiveCanvasPanel = '';
  ui.bishopActiveCanvasSheet = 'probe';
  ui.bishopSettingsCollapsed = true;
  ui.bishopCanvasToolsHidden = false;
  renderStage6();
}

function stage6BishopSetAnalysisTab(tab){
  stage6BishopOpenAnalysisTab(tab);
}

function stage6BishopResolveWallMechanicalActivation(activate){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  let changed = false;
  (bishop.walls || []).forEach((wall)=>{
    if(wall.mechanicalActivationPromptPending !== true) return;
    wall.mechanicalActivationPromptPending = false;
    if(activate === true && wall.mechanicalActive !== true){
      wall.mechanicalActive = true;
      changed = true;
    }
  });
  bishop.walls = stage6BishopNormalizeWalls(bishop.walls, bishop.terrain);
  if(changed){
    stage6BishopInvalidateDeformation('Legacy retaining walls activated mechanically; rerun deformation analysis.');
  }
  renderStage6();
}

function stage6BishopWallResultSeries(wallResult){
  const stations = wallResult?.stations || [];
  const sNode = Array.isArray(wallResult?.s_node) && wallResult.s_node.length
    ? wallResult.s_node.map((v)=>Number(v) || 0)
    : stations.map((station)=>Number(station.s) || 0);
  const wPassive = Array.isArray(wallResult?.w_passive) && wallResult.w_passive.length
    ? wallResult.w_passive.map((v)=>Number(v) || 0)
    : stations.map((station)=>Number(station.wPassive) || 0);
  const thetaPassive = Array.isArray(wallResult?.theta_passive) && wallResult.theta_passive.length
    ? wallResult.theta_passive.map((v)=>Number(v) || 0)
    : stations.map((station)=>Number(station.thetaPassive) || 0);
  const sMidpoint = Array.isArray(wallResult?.s_midpoint) && wallResult.s_midpoint.length
    ? wallResult.s_midpoint.map((v)=>Number(v) || 0)
    : stations.slice(0, -1).map((station, index)=>0.5 * ((Number(station.s) || 0) + (Number(stations[index + 1]?.s) || 0)));
  // Node-level internal forces (single element→node average from the wasm). Used for
  // plotting and extrema so the moment renders as its true linear-within-element field
  // and the peak |M| label is honest. The midpoint arrays (wallResult.M_passive etc.)
  // are a redundant second average — they are retained on wallResult for the
  // wasm-pipeline verifier but deliberately NOT used for display here.
  const nodeForce = (key, fallbackArray)=>{
    if(stations.length) return stations.map((station)=>Number(station?.[key]) || 0);
    return Array.isArray(fallbackArray) ? fallbackArray.map((v)=>Number(v) || 0) : [];
  };
  return {
    sNode,
    sMidpoint,
    N:nodeForce('N', wallResult?.N),
    VPassive:nodeForce('VPassive', wallResult?.V_passive),
    MPassive:nodeForce('MPassive', wallResult?.M_passive),
    wPassive,
    thetaPassive
  };
}

const STAGE6_WALL_RESPONSE_QUANTITIES = [
  {id:'M', label:'Moment M', shortLabel:'M', key:'MPassive', stationKey:'sNode', unit:'kN·m/m', axisTitle:'M passive-positive (kN·m/m)', color:'#7e50a8', digits:3},
  {id:'V', label:'Shear V', shortLabel:'V', key:'VPassive', stationKey:'sNode', unit:'kN/m', axisTitle:'V passive-positive (kN/m)', color:'#1f6feb', digits:3},
  {id:'N', label:'Axial N', shortLabel:'N', key:'N', stationKey:'sNode', unit:'kN/m', axisTitle:'N tension-positive (kN/m)', color:'#3d6b6a', digits:3},
  {id:'w', label:'Deflection w', shortLabel:'w', key:'wPassive', stationKey:'sNode', scale:1000, unit:'mm', axisTitle:'w passive-positive (mm)', color:'#b3477a', digits:3},
  {id:'theta', label:'Rotation theta', shortLabel:'theta', key:'thetaPassive', stationKey:'sNode', scale:1000, unit:'mrad', axisTitle:'theta passive-positive (mrad)', color:'#9b6b32', digits:3}
];

function stage6BishopWallResponseMeta(quantity){
  return STAGE6_WALL_RESPONSE_QUANTITIES.find((item)=>item.id === quantity) || STAGE6_WALL_RESPONSE_QUANTITIES[0];
}

function stage6BishopWallOverlayQuantity(){
  const quantity = S.stage6?.bishop?.deformation?.display?.wallOverlayQuantity || 'M';
  return stage6BishopWallResponseMeta(quantity).id;
}

function stage6BishopWallQuantitySeries(wallResult, quantity){
  if(!wallResult) return null;
  const meta = stage6BishopWallResponseMeta(quantity);
  const series = stage6BishopWallResultSeries(wallResult);
  const scale = Number(meta.scale) || 1;
  const values = (series[meta.key] || []).map((value)=>scale * (Number(value) || 0));
  const sValues = series[meta.stationKey] || [];
  return {meta, series, sValues, values};
}

function stage6BishopWallQuantityStats(wallResult, quantity){
  const data = stage6BishopWallQuantitySeries(wallResult, quantity);
  const pairs = (data?.values || []).map((value, index)=>({
    value:Number(value),
    s:Number(data?.sValues?.[index]),
    index
  })).filter((pair)=>Number.isFinite(pair.value));
  if(!pairs.length) return null;
  let minPair = pairs[0];
  let maxPair = pairs[0];
  pairs.forEach((pair)=>{
    if(pair.value < minPair.value) minPair = pair;
    if(pair.value > maxPair.value) maxPair = pair;
  });
  const min = minPair.value;
  const max = maxPair.value;
  const maxAbs = Math.max(Math.abs(min), Math.abs(max));
  return {...data, min, max, maxAbs, minPair, maxPair};
}

function stage6BishopWallQuantityFormat(value, meta){
  if(!Number.isFinite(value)) return '—';
  return `${stage6CompactNumber(value, meta?.digits || 3)} ${meta?.unit || ''}`.trim();
}

function stage6BishopCssColorWithAlpha(color, alpha){
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color || '').trim());
  if(!match) return `rgba(126, 80, 168, ${alpha})`;
  const hex = match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function stage6BishopContrastingTextColor(color){
  const match = /^#?([0-9a-f]{6})$/i.exec(String(color || '').trim());
  if(!match) return '#fff';
  const hex = match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.58 ? '#17202a' : '#fff';
}

function stage6BishopWallNodeValuesForOverlay(wallResult, quantity){
  const data = stage6BishopWallQuantitySeries(wallResult, quantity);
  const stations = wallResult?.stations || [];
  if(!data || stations.length < 2 || !data.values.length) return null;
  if(data.meta.stationKey === 'sNode'){
    return {...data, nodeValues:data.values.slice(0, stations.length)};
  }
  const nodeValues = [];
  for(let i = 0; i < stations.length; i += 1){
    if(i === 0) nodeValues.push(data.values[0] || 0);
    else if(i === stations.length - 1) nodeValues.push(data.values[data.values.length - 1] || 0);
    else nodeValues.push(0.5 * ((data.values[i - 1] || 0) + (data.values[i] || 0)));
  }
  return {...data, nodeValues};
}

// Defense-in-depth staleness guard for the deformation wall overlay.
// Delegates to the pure `wallResultIsStale` predicate (shared with the
// verify:wall-station-span CI gate) so the renderer can skip a wall overlay
// whose run-time geometry no longer matches the current wall, i.e. a diagram
// drawn at old coordinates after a since-applied wall edit.
function stage6BishopWallResultIsStale(wallResult, bishop){
  return wallResultIsStale(wallResult, bishop);
}

function stage6BishopWallResultForId(wallId){
  const bishop = S.stage6?.bishop;
  if(!wallId) return null;
  const currentIndex = (bishop.walls || []).findIndex((wall)=>wall.id === wallId);
  const lastInputs = bishop.deformation?.lastWallInputs || [];
  const lastIndex = lastInputs.findIndex((wall)=>wall.id === wallId);
  const resultIndex = lastIndex >= 0 ? lastIndex : currentIndex;
  if(resultIndex < 0) return null;
  return (bishop.deformation?.result?.wallResults || bishop.deformation?.result?.retainingWallResults || [])
    .find((wallResult)=>Number(wallResult.wallIndex) === resultIndex) || null;
}

function stage6BishopSelectedWallResult(){
  return stage6BishopWallResultForId(S.stage6?.bishop?.selectedWallId);
}

function stage6BishopAnalysisWallId(){
  const bishop = S.stage6?.bishop;
  const selected = bishop?.selectedWallId;
  if(selected && (bishop.walls || []).some((wall)=>wall.id === selected)) return selected;
  const resultIndices = new Set((bishop?.deformation?.result?.wallResults || bishop?.deformation?.result?.retainingWallResults || [])
    .map((wallResult)=>Number(wallResult.wallIndex))
    .filter((index)=>Number.isInteger(index) && index >= 0));
  const activeWithResult = (bishop?.walls || []).find((wall, index)=>wall.mechanicalActive === true && resultIndices.has(index));
  if(activeWithResult) return activeWithResult.id;
  const active = (bishop?.walls || []).find((wall)=>wall.mechanicalActive === true);
  return active?.id || bishop?.walls?.[0]?.id || '';
}

async function stage6BishopCopyWallData(wallId){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  if(wallId) bishop.selectedWallId = wallId;
  const wall = (bishop.walls || []).find((item)=>item.id === bishop.selectedWallId);
  const wallResult = stage6BishopSelectedWallResult();
  if(!wall || !wallResult){
    bishop.deformation.wallCopyMessage = 'Run deformation for the selected mechanical wall first.';
    renderStage6();
    return;
  }
  const series = stage6BishopWallResultSeries(wallResult);
  const rows = ['s_m\tN_kN_per_m\tV_passive_kN_per_m\tM_passive_kNm_per_m\tw_passive_m\ttheta_passive_rad'];
  const maxRows = Math.max(series.sNode.length, series.sMidpoint.length);
  for(let i=0;i<maxRows;i+=1){
    rows.push([
      series.sNode[i] ?? series.sMidpoint[i] ?? '',
      series.N[i] ?? '',
      series.VPassive[i] ?? '',
      series.MPassive[i] ?? '',
      series.wPassive[i] ?? '',
      series.thetaPassive[i] ?? ''
    ].join('\t'));
  }
  const text = rows.join('\n');
  try{
    if(typeof navigator !== 'undefined' && navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(text);
      bishop.deformation.wallCopyMessage = 'Wall response copied as TSV.';
    } else {
      bishop.deformation.wallCopyMessage = text;
    }
  } catch(err){
    bishop.deformation.wallCopyMessage = text;
  }
  renderStage6();
}

function stage6BishopSelectDrain(drainId){
  ensureStage6State();
  seepslopeSelectDrain(S.stage6.bishop, drainId);
  renderStage6();
}

function stage6BishopSetDrainField(index, field, value){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopSyncSoilModel();
  if(!seepslopeSetDrainField(S.stage6.bishop, index, field, value)) return;
  const model = stage6BishopCurrentModel();
  S.stage6.bishop.seepage.drainValidation = validateDrains(model);
  stage6BishopInvalidateSeepage('Drain settings changed. Showing the previous result until you rerun.', true, true);
  renderStage6();
}

function stage6BishopDeleteDrain(index){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopSyncSoilModel();
  seepslopeDeleteDrain(S.stage6.bishop, index);
  stage6BishopInvalidateSeepage('Drain removed. Showing the previous result until you rerun.', true, true);
  renderStage6();
}


// ── seepslope/run façades (refactor step 9c / PR 18c) ───────────────────────────────────────
// The three runs (map §5 rows 1-3) are pure request builders and pure result reducers in
// src/lib/cpt-app/seepslope/run/; the worker lifecycle is one adapter (`stage6BishopWorkers`)
// instead of the six module variables the monolith closed over (map §3.4 #8). Each façade keeps
// the monolith name, signature and call order, and adds only what the package cannot own:
// ensureStage6State(), stage6RememberDetailsState(), the pending region-coarseness commit, the
// soil-model sync, the DOM (renderStage6 / the progress bar / the canvas) and `S`.

/** The bishop block of the CPT that is active *now* — the worker callbacks' one host hook. */
function stage6BishopRunState(){
  return S?.stage6?.bishop || null;
}

/** Apply a run patch to the active block; a no-op when there is no Stage 6 state. */
function stage6BishopApplyRunPatch(patch){
  const bishop = stage6BishopRunState();
  if(bishop) seepslopeApplyRunPatch(bishop, patch);
  return bishop;
}

function stage6BishopStopSeepage(silent){
  stage6BishopWorkers.stop('seepage', {silent, runId:S?.stage6?.bishop?.seepage?.progress?.runId});
  stage6BishopApplyRunPatch(seepslopeStopSeepagePatch(stage6BishopRunState(), silent));
}

function stage6BishopStopDeformation(silent){
  stage6BishopWorkers.stop('deformation', {silent, runId:S?.stage6?.bishop?.deformation?.progress?.runId});
  stage6BishopApplyRunPatch(seepslopeStopDeformationPatch(stage6BishopRunState(), silent));
}

function stage6BishopStopSearch(silent){
  // The search worker has no stop protocol (analyzeBishopSearch never yields), so the adapter
  // terminates it whether or not the stop is silent — as the monolith did.
  stage6BishopWorkers.stop('search', {silent});
  stage6BishopApplyRunPatch(seepslopeStopSearchPatch(stage6BishopRunState(), silent));
}

function stage6BishopUpdateProgressDom(){
  const bishop = stage6BishopRunState();
  if(!bishop) return;
  const status = document.getElementById('stage6BishopProgress');
  const bar = document.getElementById('stage6BishopProgressBar');
  const dom = seepslopeSearchProgressDom(bishop);
  if(status) status.textContent = dom.text;
  if(bar) bar.style.width = dom.width;
}

/** Run one reducer result: the patch on the active block, then the effects it asks for. */
function stage6BishopApplyRunStep(step){
  if(!step.handled) return false;
  stage6BishopApplyRunPatch(step.patch);
  if(step.effects.updateProgressDom) stage6BishopUpdateProgressDom();
  if(step.effects.drawCanvas) stage6BishopDrawCanvas();
  if(step.effects.render) renderStage6();
  return true;
}

function stage6BishopEnsureWorker(){
  return stage6BishopWorkers.ensure('search', {
    onMessage:(payload)=>{
      stage6BishopApplyRunStep(seepslopeReduceSearchMessage(stage6BishopRunState(), payload));
    },
    onError:()=>{
      if(!stage6BishopRunState()) return;
      stage6BishopApplyRunPatch(seepslopeSearchWorkerErrorPatch());
      renderStage6();
    }
  });
}

function stage6BishopEnsureSeepageWorker(){
  return stage6BishopWorkers.ensure('seepage', {
    onMessage:(payload)=>{
      stage6BishopApplyRunStep(seepslopeReduceSeepageMessage(stage6BishopRunState(), payload));
    },
    onError:()=>{
      if(!stage6BishopRunState()?.seepage) return;
      stage6BishopApplyRunPatch(seepslopeSeepageWorkerErrorPatch());
      renderStage6();
    }
  });
}

function stage6BishopEnsureDeformationWorker(){
  return stage6BishopWorkers.ensure('deformation', {
    onMessage:(payload)=>{
      stage6BishopApplyRunStep(seepslopeReduceDeformationMessage(stage6BishopRunState(), payload));
    },
    onError:()=>{
      if(!stage6BishopRunState()?.deformation) return;
      stage6BishopApplyRunPatch(seepslopeDeformationWorkerErrorPatch());
      renderStage6();
    }
  });
}

function stage6BishopRunSearch(){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopCommitPendingSelectedRegionCoarseness();
  const bishop = S.stage6.bishop;
  const model = stage6BishopCurrentModel();
  const prep = seepslopePrepareSearch(bishop, model);
  if(!prep.ok){
    seepslopeApplyRunPatch(bishop, prep.patch);
    renderStage6();
    return;
  }
  // The input is built here, before the silent stops and before the pre-post render, exactly
  // where the monolith built it: the render re-runs ensure() and the soil-model sync, which may
  // still clamp the zones or the search config on a state that has not converged yet.
  const input = seepslopeBuildSearchInput(bishop, model);
  stage6BishopStopSeepage(true);
  stage6BishopStopSearch(true);
  const worker = stage6BishopEnsureWorker();
  if(!worker){
    seepslopeApplyRunPatch(bishop, seepslopeSearchNoWorkerPatch());
    renderStage6();
    return;
  }
  const runId = stage6BishopWorkers.nextRunId('search');
  seepslopeApplyRunPatch(bishop, seepslopeStartSearchPatch(bishop, runId));
  renderStage6();
  worker.postMessage(seepslopeSearchRequest(runId, input));
}

function stage6BishopRunSeepage(){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopCommitPendingSelectedRegionCoarseness();
  const bishop = S.stage6.bishop;
  stage6BishopSyncSoilModel();
  const model = stage6BishopCurrentModel();
  // prepareSeepage also *stores* the drain validation (the drains panel renders it), so its patch
  // is applied whether or not the pre-flight passed.
  const prep = seepslopePrepareSeepage(bishop, model);
  seepslopeApplyRunPatch(bishop, prep.patch);
  if(!prep.ok){
    renderStage6();
    return;
  }
  stage6BishopStopSearch(true);
  stage6BishopStopSeepage(true);
  const worker = stage6BishopEnsureSeepageWorker();
  if(!worker){
    seepslopeApplyRunPatch(bishop, seepslopeSeepageNoWorkerPatch());
    renderStage6();
    return;
  }
  const runId = stage6BishopWorkers.nextRunId('seepage');
  seepslopeApplyRunPatch(bishop, seepslopeStartSeepagePatch(runId));
  const inputModel = seepslopeBuildSeepageInputModel(model);
  renderStage6();
  worker.postMessage(seepslopeSeepageRequest(runId, inputModel));
}

function stage6BishopRunDeformation(){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopCommitPendingSelectedRegionCoarseness();
  const bishop = S.stage6.bishop;
  stage6BishopSyncSoilModel();
  const model = stage6BishopCurrentModel();
  const prep = seepslopePrepareDeformation(bishop, model);
  if(!prep.ok){
    seepslopeApplyRunPatch(bishop, prep.patch);
    renderStage6();
    return;
  }
  stage6BishopStopSearch(true);
  stage6BishopStopSeepage(true);
  stage6BishopStopDeformation(true);
  const worker = stage6BishopEnsureDeformationWorker();
  if(!worker){
    seepslopeApplyRunPatch(bishop, seepslopeDeformationNoWorkerPatch());
    renderStage6();
    return;
  }
  const runId = stage6BishopWorkers.nextRunId('deformation');
  seepslopeApplyRunPatch(bishop, seepslopeStartDeformationPatch(model, runId));
  renderStage6();
  // The ~60 solver options are read at the post, where the monolith read them (inline in the
  // postMessage literal, after the pre-post render).
  worker.postMessage(seepslopeDeformationRequest(runId, model, seepslopeBuildDeformationOptions(bishop)));
}

function stage6BishopSelectResult(index){
  ensureStage6State();
  const results = S.stage6.bishop.results?.allResults || [];
  S.stage6.bishop.selectedResult = Math.min(Math.max(+index || 0, 0), Math.max(results.length-1, 0));
  renderStage6();
}

function stage6BishopSelectedResult(){
  const results = S.stage6?.bishop?.results?.allResults || [];
  if(!results.length) return null;
  const index = Math.min(Math.max(S.stage6.bishop.selectedResult || 0, 0), results.length-1);
  return results[index];
}

// ─────────────── seepslope/panels labels, icons and the tool rail (step 9f / PR 18f) ───────────────
// The Seep / Slope HTML is src/lib/cpt-app/seepslope/panels/: one module per `data-st6details`
// group, the tool rail, the eight canvas sheets, the results panel, the header and a layout.js that
// composes them over one pure view model. The names below survive as façades; the ones that read
// `S` hand the active block (or SEEPSLOPE_PANELS_ENV, defined next to renderStage6BishopApp) to the
// package, which reads neither `S` nor the DOM.
function stage6BishopStrengthSetLabel(key){
  return seepslopeStrengthSetLabel(key);
}

// stage6BishopMethodModeLabel / stage6SecondsLabelFromMs / stage6SafetyFinalizationStatusFromSolver
// are import aliases of seepslope/run/progress.js (PR 18c): the run writes them, the results and
// panel regions read them.

function stage6DepthBandReportHtml(report, title = 'Depth-band plasticity'){
  return seepslopeDepthBandReportHtml(report, title);
}

function stage6BishopSafetyCurveHtml(solver){
  return seepslopeSafetyCurveHtml(solver);
}

function stage6BishopSafetyMechanismHtml(mechanism){
  return seepslopeSafetyMechanismHtml(mechanism);
}

// stage6SeepageFlowErrorLabel is an import alias of seepslope/run/progress.js (PR 18c).

function stage6BishopSeepageTerminationLabel(reason){
  return seepslopeSeepageTerminationLabel(reason);
}

function stage6BishopResultMethodLabel(result){
  return seepslopeResultMethodLabel(result);
}

// The four run messages live in seepslope/run/progress.js (PR 18c). stage6BishopCompleteMessage
// and stage6BishopSeepageCompleteMessage are import aliases (they never read `S`); the two below
// keep their monolith signatures and hand the active block to the pure functions.
function stage6BishopRunningMessage(){
  return seepslopeRunningMessage(S.stage6?.bishop);
}

function stage6BishopReadyMessage(runReady){
  return seepslopeReadyMessage(S.stage6?.bishop, runReady);
}

function stage6BishopModeMeta(){
  return seepslopeModeMeta(S.stage6.bishop);
}

function stage6BishopToolIcon(name){
  return seepslopeToolIcon(name);
}

function stage6BishopCanvasToolButton(options){
  return seepslopeCanvasToolButton(options);
}

function stage6BishopWallMechanicalLabel(wall){
  return seepslopeWallMechanicalLabel(wall);
}

function stage6BishopPartialLoadBadgeHtml(solver){
  return seepslopePartialLoadBadgeHtml(solver);
}

function stage6BishopWallInfoPanelHtml(){
  return seepslopeWallInfoPanelHtml(S.stage6?.bishop, SEEPSLOPE_PANELS_ENV);
}

function stage6BishopRenderWallChart(canvas, sValues, values, options = {}){
  if(!canvas || !sValues?.length || !values?.length) return;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(rect.width || Number(canvas.getAttribute('width')) || 260, 160);
  const cssHeight = Math.max(rect.height || Number(canvas.getAttribute('height')) || 112, 80);
  if(canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)){
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
  }
  const ctx = canvas.getContext('2d');
  if(!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  const padL = 42;
  const padR = 52;
  const padT = 14;
  const padB = 20;
  const plotW = Math.max(cssWidth - padL - padR, 1);
  const plotH = Math.max(cssHeight - padT - padB, 1);
  const finitePairs = values.map((value, index)=>({s:Number(sValues[index]), value:Number(value), index}))
    .filter((pair)=>Number.isFinite(pair.s) && Number.isFinite(pair.value));
  if(!finitePairs.length) return;
  const sMin = Math.min(...finitePairs.map((pair)=>pair.s));
  const sMax = Math.max(...finitePairs.map((pair)=>pair.s), sMin + 1e-6);
  const minValue = Math.min(...finitePairs.map((pair)=>pair.value));
  const maxValue = Math.max(...finitePairs.map((pair)=>pair.value));
  const minPair = finitePairs.reduce((best, pair)=>pair.value < best.value ? pair : best, finitePairs[0]);
  const maxPair = finitePairs.reduce((best, pair)=>pair.value > best.value ? pair : best, finitePairs[0]);
  const maxAbs = Math.max(Math.abs(minValue), Math.abs(maxValue), 1e-12);
  const px = (value)=>padL + 0.5 * plotW + 0.48 * plotW * (value / maxAbs);
  const py = (s)=>padT + plotH * ((s - sMin) / Math.max(sMax - sMin, 1e-9));
  const axis = readCssToken('--bd', 'rgba(90,100,120,0.35)');
  const stroke = options.stroke || readCssToken('--chart-blue', '#2f6f9f');
  const text = readCssToken('--tx2', '#586271');
  ctx.save();
  ctx.strokeStyle = axis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px(0), padT);
  ctx.lineTo(px(0), padT + plotH);
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  finitePairs.forEach((pair, index)=>{
    const x = px(pair.value);
    const y = py(pair.s);
    if(index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  const drawExtremum = (pair, label, fillColor, preferAbove = true)=>{
    if(!pair) return;
    const x = px(pair.value);
    const y = py(pair.s);
    const valueText = `${label} ${stage6BishopWallQuantityFormat(pair.value, {unit:options.unit || '', digits:3})}`;
    const stationText = `s=${stage6CompactNumber(pair.s, 3)} m`;
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = fillColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 3.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.font = '10px system-ui, sans-serif';
    const labelW = Math.max(ctx.measureText(valueText).width, ctx.measureText(stationText).width) + 10;
    const labelH = 25;
    let lx = x + (pair.value >= 0 ? 8 : -labelW - 8);
    let ly = y + (preferAbove ? -labelH - 6 : 6);
    lx = Math.max(2, Math.min(cssWidth - labelW - 2, lx));
    ly = Math.max(2, Math.min(cssHeight - labelH - 2, ly));
    ctx.fillStyle = stage6BishopCssColorWithAlpha(fillColor, 0.88);
    ctx.strokeStyle = stage6BishopCssColorWithAlpha(fillColor, 0.96);
    ctx.lineWidth = 1;
    if(typeof ctx.roundRect === 'function'){
      ctx.beginPath();
      ctx.roundRect(lx, ly, labelW, labelH, 5);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(lx, ly, labelW, labelH);
      ctx.strokeRect(lx, ly, labelW, labelH);
    }
    ctx.fillStyle = stage6BishopContrastingTextColor(fillColor);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(valueText, lx + 5, ly + 3);
    ctx.fillText(stationText, lx + 5, ly + 14);
    ctx.restore();
  };
  const extremaSamePoint = minPair.index === maxPair.index || Math.abs(minPair.s - maxPair.s) < 1e-9 && Math.abs(minPair.value - maxPair.value) < 1e-12;
  drawExtremum(minPair, 'min', stroke, true);
  if(!extremaSamePoint) drawExtremum(maxPair, 'max', stroke, false);
  ctx.fillStyle = text;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('s=0', 4, padT + 4);
  ctx.fillText(stage6BishopWallQuantityFormat(minValue, {unit:options.unit || '', digits:3}), padL, cssHeight - 5);
  ctx.textAlign = 'right';
  ctx.fillText(stage6BishopWallQuantityFormat(maxValue, {unit:options.unit || '', digits:3}), cssWidth - padR, cssHeight - 5);
  ctx.textAlign = 'left';
  ctx.fillText(`s=${stage6CompactNumber(sMax, 3)} m`, 4, padT + plotH);
  ctx.restore();
}

function buildStage6BishopWallCharts(){
  const wallResult = stage6BishopWallResultForId(stage6BishopAnalysisWallId());
  if(!wallResult) return;
  STAGE6_WALL_RESPONSE_QUANTITIES.forEach((meta)=>{
    const data = stage6BishopWallQuantitySeries(wallResult, meta.id);
    stage6BishopRenderWallChart(
      document.getElementById(`stage6WallChart-${meta.id}`),
      data?.sValues || [],
      data?.values || [],
      {stroke:meta.color, unit:meta.unit}
    );
  });
}

function stage6BishopCanvasToolRailHtml(context){
  return seepslopeCanvasToolRailHtml(context, SEEPSLOPE_PANELS_ENV);
}

// ─────────────────── seepslope/geometry + seepslope/probe façades (step 9d) ───────────────────
// PR 18d moved the section geometry (points and segments, polygons and their validators, boundary
// picking / splitting / hole subtraction, the regions a canvas shows, the shared Measure tool's
// line) and the line probe into src/lib/cpt-app/seepslope/geometry/** and seepslope/probe/**.
// Every monolith name survives: the 29 pure ones as import aliases in the block at the top of this
// file, the six below as façades, because they read `S`, the canvas viewport, or a catalogue of a
// region that is not extracted yet (the deformation and seepage contour metas, map §2.11).
// Staying here on purpose: stage6CopyTextFallback / stage6CopyTextToClipboard (browser clipboard
// APIs) and stage6BishopCopyLineProbeData (a handler: state + render).
// stage6BishopBoundaryPickToleranceWorld became a one-liner over seepslope/canvas/viewport.js in
// PR 18e (report 26 finding 2); it lives in the canvas region below with the rest of the viewport.

/** The host values seepslope/probe cannot own yet; see seepslope/probe/index.js for the contract. */
const SEEPSLOPE_PROBE_ENV = {
  hardeningSoilUi:STAGE6_ENABLE_HARDENING_SOIL_UI,
  normalizedDeformationAnalysisType:(analysisType = null)=>stage6BishopNormalizedDeformationAnalysisType(analysisType),
  deformationContourOptions:(analysisType, hasHs)=>stage6BishopDeformationContourOptions(analysisType, hasHs),
  deformationContourMeta:(id, analysisType)=>stage6BishopDeformationContourMeta(id, analysisType),
  seepageHydraulicFs:(gradientMagnitude, material)=>stage6BishopSeepageHydraulicFs(gradientMagnitude, material)
};

// The region hover card: the material's own strength set, or the workspace's, formatted by
// stage6BishopStrengthSetLabel (results region, step 9f). `strengthSet` is passed as a function so
// the package reads `S` exactly where the monolith did — only for a material without a
// `sourceStrengthSet`, and never for a region without a material.
function stage6BishopTooltipHtml(region){
  return seepslopeRegionTooltipHtml(region, {
    strengthSet:()=>S.stage6.bishop.strengthSet,
    strengthSetLabel:stage6BishopStrengthSetLabel
  });
}

function stage6BishopLineProbeOptions(workspace, analysisType = null, hasHs = false){
  return seepslopeLineProbeOptions(workspace, analysisType, hasHs, SEEPSLOPE_PROBE_ENV);
}

function stage6BishopLineProbeMeta(workspace, quantity, analysisType = null, hasHs = false){
  return seepslopeLineProbeMeta(workspace, quantity, analysisType, hasHs, SEEPSLOPE_PROBE_ENV);
}

function stage6CopyTextFallback(text){
  if(typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  let copied = false;
  try{
    copied = !!document.execCommand && document.execCommand('copy');
  }catch(_error){
    copied = false;
  }
  document.body.removeChild(textarea);
  return copied;
}

async function stage6CopyTextToClipboard(text){
  if(!text) return false;
  try{
    if(typeof navigator !== 'undefined' && navigator.clipboard?.writeText){
      await navigator.clipboard.writeText(text);
      return true;
    }
  }catch(_error){
    // fall through to the textarea-based fallback
  }
  return stage6CopyTextFallback(text);
}

function stage6BishopBuildLineProbe(workspace, measurementMetrics){
  return seepslopeBuildLineProbe(S?.stage6?.bishop, workspace, measurementMetrics, SEEPSLOPE_PROBE_ENV);
}

async function stage6BishopCopyLineProbeData(){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  const workspace = bishop.workspace === 'seepage' ? 'seepage' : bishop.workspace === 'deformation' ? 'deformation' : 'stability';
  const measurementMetrics = stage6BishopMeasurementMetrics(bishop.measurement?.points || []);
  const lineProbe = stage6BishopBuildLineProbe(workspace, measurementMetrics);
  S.stage6Cache.bishopLineProbe = lineProbe;
  if(!lineProbe || lineProbe.status !== 'ready'){
    bishop.lineProbe.copyTone = 'warn';
    bishop.lineProbe.copyMessage = lineProbe?.message || 'No plotted line-probe data is available to copy yet.';
    renderStage6();
    return false;
  }
  const text = stage6BishopLineProbeClipboardText(lineProbe);
  const copied = await stage6CopyTextToClipboard(text);
  bishop.lineProbe.copyTone = copied ? 'ok' : 'warn';
  bishop.lineProbe.copyMessage = copied
    ? `Copied ${lineProbe.samples.length} graph points to the clipboard as distance/value columns.`
    : 'Clipboard copy failed in this browser session.';
  renderStage6();
  return copied;
}

function stage6BishopDisplayRegions(model){
  return seepslopeDisplayRegions(model, S?.stage6?.bishop);
}

// ───────────────────────── seepslope/canvas façades (refactor step 9e / PR 18e) ─────────────────────────
// The section canvas moved to src/lib/cpt-app/seepslope/canvas/**: the viewport (world ↔ screen,
// fit, zoom / pan, every px → world tolerance), the picking and snapping, the pointer state
// machine, the view model and the fourteen draw layers. What is left here is the host half the
// package cannot own — `S`, the canvas element, the device-pixel ratio, the model cache, the
// tooltip DOM and the theme — plus a façade under every monolith name.
//
// Two host objects carry what the package needs from regions that are not extracted yet
// (the contour catalogues, the wall-response overlay, the seepage BC lookup — map §2.11) and the
// handlers a gesture ends in: SEEPSLOPE_CANVAS_ENV (draw-time reads, one per frame) and
// seepslopeCanvasEnv(canvas) (a gesture's effects). Both follow the value-or-function convention
// of PR 18a / 18d, so every host read happens at the very statement the monolith made it.

/** The pick tolerance of the polygon-boundary tools: 14 px at the current scale, in metres. */
function stage6BishopBoundaryPickToleranceWorld(){
  return seepslopeBoundaryPickToleranceWorld(S?.stage6?.bishop?.viewport);
}

// The tolerance is handed over as a function, so the package reads the viewport at the very
// statement the monolith read it: after the nearest-edge loop, and only when an edge was found.
function stage6BishopPickRegionBoundaryPoint(region, world){
  return seepslopePickRegionBoundaryPoint(region, world, stage6BishopBoundaryPickToleranceWorld);
}

/** Draw-time reads the canvas package cannot own yet; see seepslope/canvas/view-model.js. */
const SEEPSLOPE_CANVAS_ENV = {
  // map §2.11 "Deformation contours"
  normalizedDeformationAnalysisType:()=>stage6BishopNormalizedDeformationAnalysisType(),
  deformationContourDerived:(result, mesh, mode)=>stage6BishopDeformationContourDerived(result, mesh, mode),
  deformationContourValue:(result, mesh, index, mode)=>stage6BishopDeformationContourValue(result, mesh, index, mode),
  deformationContourColor:(value, min, max, mode, alpha, analysisType)=>stage6BishopDeformationContourColor(value, min, max, mode, alpha, analysisType),
  deformationContourLineColor:(level, min, max, mode, alpha, analysisType)=>stage6BishopDeformationContourLineColor(level, min, max, mode, alpha, analysisType),
  deformationVectorMode:(mode)=>stage6BishopDeformationVectorMode(mode),
  deformationPlasticPointSets:(result)=>stage6BishopDeformationPlasticPointSets(result),
  deformationFiniteScalarOrNull:(value)=>stage6BishopDeformationFiniteScalarOrNull(value),
  averageFiniteValues:(values, fallback)=>stage6BishopAverageFiniteValues(values, fallback),
  t6VisualSubtriangles:(element)=>stage6BishopT6VisualSubtriangles(element),
  // map §2.11 "Seepage state + contours"
  seepageContourDerived:(result, mesh, mode)=>stage6BishopSeepageContourDerived(result, mesh, mode),
  seepageContourValue:(result, mesh, index, mode)=>stage6BishopSeepageContourValue(result, mesh, index, mode),
  seepageContourColor:(value, min, max, mode, alpha)=>stage6BishopSeepageContourColor(value, min, max, mode, alpha),
  seepageContourLineColor:(level, min, max, mode, alpha)=>stage6BishopSeepageContourLineColor(level, min, max, mode, alpha),
  // map §2.11 "Seepage BC handlers"
  seepageBoundary:(model)=>S.stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model),
  selectedBoundaryEdge:(model)=>stage6BishopSelectedBoundaryEdge(model),
  hoveredSeepageEdge:(model)=>stage6BishopHoveredSeepageEdge(model),
  seepageBcForEdge:(edgeKey)=>stage6BishopSeepageBcForEdge(edgeKey),
  // map §2.11 "Result HTML / labels" (step 9f)
  selectedResult:()=>stage6BishopSelectedResult(),
  wallOverlayQuantity:()=>stage6BishopWallOverlayQuantity(),
  wallNodeValuesForOverlay:(wallResult, quantity)=>stage6BishopWallNodeValuesForOverlay(wallResult, quantity),
  wallQuantityFormat:(value, meta)=>stage6BishopWallQuantityFormat(value, meta),
  cssColorWithAlpha:(color, alpha)=>stage6BishopCssColorWithAlpha(color, alpha),
  contrastingTextColor:(color)=>stage6BishopContrastingTextColor(color)
};

/** The canvas the gesture is on, as seepslope/canvas/pointer.js wants it. */
function seepslopeCanvasCtx(canvas){
  const bishop = S.stage6.bishop;
  return {
    bishop,
    viewport:bishop.viewport,
    canvasState:stage6BishopCanvasState,
    rect:()=>canvas.getBoundingClientRect()
  };
}

/** The drag key excluded from its own snap candidates — read live, as the monolith did. */
const seepslopeCanvasExcludeKey = ()=>seepslopeCurrentDragKey(stage6BishopCanvasState.pointerDrag);

/**
 * Everything a gesture on `canvas` can do to the host: the two DOM effects the package must not
 * perform itself, the render / redraw, and the handlers a committed draw point ends in.
 */
function seepslopeCanvasEnv(canvas){
  return {
    render:()=>renderStage6(),
    draw:()=>stage6BishopDrawCanvas(),
    updateHover:(clientX, clientY)=>stage6BishopUpdateHoverDom(canvas, clientX, clientY),
    hideHover:()=>stage6BishopHideHoverDom(),
    setPointerCapture:(pointerId)=>{ if(canvas?.setPointerCapture) canvas.setPointerCapture(pointerId); },
    releasePointerCapture:(pointerId)=>{
      if(canvas?.releasePointerCapture){
        try{ canvas.releasePointerCapture(pointerId); }catch(e){}
      }
    },
    model:()=>S.stage6Cache.bishopModel || stage6BishopCurrentModel(),
    seepageBoundary:(model)=>S.stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model),
    pickSeepageBoundaryEdge:(boundary, world, tolerance)=>pickSeepageBoundaryEdge(boundary, world, tolerance),
    selectSeepageBoundary:(edgeKey)=>stage6BishopSelectSeepageBoundary(edgeKey),
    finishDraft:()=>stage6BishopFinishDraft(),
    createDrainFromVertices:(vertices)=>stage6BishopCreateDrainFromVertices(vertices),
    selectedCustomRegion:()=>stage6BishopSelectedCustomRegion(),
    pickRegionBoundaryPoint:(region, world)=>stage6BishopPickRegionBoundaryPoint(region, world),
    splitSelectedRegion:()=>stage6BishopSplitSelectedRegion(),
    regionAtInModel:(model, world)=>stage6BishopRegionAtPoint({regions:stage6BishopDisplayRegions(model)}, world),
    invalidate:(message)=>stage6BishopInvalidate(message),
    invalidateSeepage:(message, keepMesh, preserveSolvedState)=>stage6BishopInvalidateSeepage(message, keepMesh, preserveSolvedState),
    invalidateDeformation:(message)=>stage6BishopInvalidateDeformation(message),
    invalidateWallGeometry:(message)=>stage6BishopInvalidateWallGeometry(message),
    clearCustomRegions:(message)=>stage6BishopClearCustomRegions(message),
    createSurfaceLoadFromZone:(zone)=>stage6BishopCreateSurfaceLoadFromZone(zone),
    wallId:()=>stage6BishopWallId(),
    defaultPassiveSide:()=>stage6BishopDefaultPassiveSide(),
    defaultWallMaterial:(index, wallId)=>stage6BishopDefaultWallMaterial(index, wallId),
    openStructuresPanel:()=>{
      const ui = stage6BishopUiState();
      ui.bishopActiveCanvasPanel = 'structures';
      ui.bishopActiveCanvasSheet = '';
      ui.bishopCanvasToolsHidden = false;
    }
  };
}

/** The tooltip bodies: HTML, so they stay with the other HTML strings until step 9f. */
function seepslopeCanvasTooltipEnv(canvas, model){
  return {
    wrapRect:()=>canvas.parentElement.getBoundingClientRect(),
    regionAt:(world)=>stage6BishopRegionAtPoint({regions:stage6BishopDisplayRegions(model)}, world),
    tooltipForLoad:(load)=>`
      <div style="font-weight:700;margin-bottom:4px">${stage6EscAttr(load.label || load.id || 'Surface load')}</div>
      <div>${stage6EscAttr(stage6BishopSurfaceLoadSummary(load, S.stage6.bishop.workspace))}</div>
      <div style="color:var(--tx2);margin-top:4px">Click to edit · drag endpoints when selected</div>
    `,
    tooltipForWall:(hoveredWall)=>{
      const hoveredWallResult = stage6BishopWallResultForId(hoveredWall.id);
      const hoveredWallMeta = hoveredWallResult
        ? stage6BishopWallQuantityStats(hoveredWallResult, stage6BishopWallOverlayQuantity())
        : null;
      const wallIndex = (S.stage6.bishop.walls || []).findIndex((wall)=>wall.id === hoveredWall.id);
      const meta = hoveredWallMeta?.meta || stage6BishopWallResponseMeta(stage6BishopWallOverlayQuantity());
      return `
      <div style="font-weight:700;margin-bottom:4px">Wall ${wallIndex + 1}</div>
      <div>${stage6EscAttr(meta.label)} overlay</div>
      ${hoveredWallMeta ? `
        <div style="margin-top:4px">
          Min: <strong>${stage6EscAttr(stage6BishopWallQuantityFormat(hoveredWallMeta.min, meta))}</strong><br>
          Max: <strong>${stage6EscAttr(stage6BishopWallQuantityFormat(hoveredWallMeta.max, meta))}</strong>
        </div>
      ` : '<div style="color:var(--tx2);margin-top:4px">Run deformation with this wall mechanically active to show result ranges.</div>'}
      <div style="color:var(--tx2);margin-top:4px">Click to select · open Analysis for diagrams</div>
    `;
    },
    tooltipForRegion:(region)=>stage6BishopTooltipHtml(region)
  };
}

function stage6BishopHideHoverDom(){
  const tip = document.getElementById('stage6BishopTip');
  const coord = document.getElementById('stage6BishopCoord');
  if(tip) tip.style.display = 'none';
  if(coord) coord.textContent = '';
}

/** The readout under the canvas and the hover card; the maths is seepslope/canvas/pointer.js. */
function stage6BishopUpdateHoverDom(canvas, clientX, clientY){
  const coord = document.getElementById('stage6BishopCoord');
  const tip = document.getElementById('stage6BishopTip');
  const model = S.stage6Cache.bishopModel || stage6BishopCurrentModel();
  const hover = seepslopeHoverUpdate(
    seepslopeCanvasCtx(canvas),
    clientX,
    clientY,
    seepslopeCanvasTooltipEnv(canvas, model),
    !!tip && !!model
  );
  if(coord) coord.textContent = hover.coordText;
  if(hover.tip !== undefined){
    if(hover.tip){
      tip.innerHTML = hover.tip.html;
      tip.style.display = 'block';
      tip.style.left = `${hover.tip.left}px`;
      tip.style.top = `${hover.tip.top}px`;
    } else {
      tip.style.display = 'none';
    }
  }
  stage6BishopDrawCanvas();
}

function stage6BishopScreenToWorld(canvas, clientX, clientY){
  return seepslopeScreenToWorldFromClient(canvas.getBoundingClientRect(), clientX, clientY, S.stage6.bishop.viewport);
}

function stage6BishopWorldToScreen(pt){
  return seepslopeWorldToScreen(pt, S.stage6.bishop.viewport);
}

function stage6BishopSnapToleranceWorld(){
  return seepslopeSnapToleranceWorld(S?.stage6?.bishop?.viewport);
}

function stage6BishopCurrentDragKey(){
  return seepslopeCurrentDragKey(stage6BishopCanvasState.pointerDrag);
}

function stage6BishopSnapPointKey(kind, index, regionId){
  return seepslopeSnapPointKey(kind, index, regionId);
}

function stage6BishopCollectSnapPoints(){
  return seepslopeCollectSnapPoints(S.stage6.bishop, seepslopeCanvasExcludeKey);
}

function stage6BishopNearestPointSnap(pt, mode){
  const bishop = S.stage6.bishop;
  return seepslopeNearestPointSnap(pt, mode, bishop, bishop.viewport, seepslopeCanvasExcludeKey);
}

function stage6BishopSnapWorldPoint(pt, mode){
  const bishop = S.stage6.bishop;
  return seepslopeSnapWorldPoint(pt, mode, bishop, bishop.viewport, seepslopeCanvasExcludeKey);
}

function stage6BishopCanvasWorldBounds(model){
  return seepslopeCanvasWorldBounds(S.stage6.bishop, model);
}

function fitStage6BishopViewport(){
  ensureStage6State();
  const canvas = document.getElementById('stage6BishopCanvas');
  if(!canvas) return;
  const model = stage6BishopCurrentModel();
  const rect = canvas.getBoundingClientRect();
  const bounds = stage6BishopCanvasWorldBounds(model);
  Object.assign(S.stage6.bishop.viewport, seepslopeFitViewport(bounds, rect.width, rect.height));
  stage6BishopDrawCanvas();
}

function stage6BishopAutoFitViewportIfNeeded(){
  if(!S.stage6.bishop.viewport.fitted) fitStage6BishopViewport();
}

function stage6BishopNearestHandle(canvas, clientX, clientY){
  const bishop = S.stage6.bishop;
  return seepslopeNearestHandle(bishop, bishop.viewport, canvas.getBoundingClientRect(), clientX, clientY, stage6BishopSelectedCustomRegion);
}

function stage6BishopPickSurfaceLoadAtWorld(world){
  const bishop = S.stage6.bishop;
  return seepslopePickSurfaceLoadAtWorld(bishop, world, bishop.viewport);
}

function stage6BishopPickWallAtWorld(world){
  const bishop = S.stage6.bishop;
  return seepslopePickWallAtWorld(bishop, world, bishop.viewport);
}

function stage6BishopCommitDrawPoint(canvas, world){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  return seepslopeCommitDrawPoint(bishop, world, bishop.viewport, seepslopeCanvasEnv(canvas), seepslopeCanvasExcludeKey);
}

function stage6BishopCompleteCurrentActionAt(world){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  const canvas = stage6BishopCanvasState.canvas || document.getElementById('stage6BishopCanvas');
  return seepslopeCompleteCurrentActionAt(bishop, world, bishop.viewport, seepslopeCanvasEnv(canvas), seepslopeCanvasExcludeKey);
}

function stage6BishopPointerDown(event){
  const canvas = event.currentTarget;
  stage6BishopCanvasState.canvas = canvas;
  const effects = seepslopePointerDown(seepslopeCanvasCtx(canvas), event, seepslopeCanvasEnv(canvas));
  seepslopeApplyPointerEffects(event, effects);
}

function stage6BishopPointerMove(event){
  const canvas = event.currentTarget;
  const effects = seepslopePointerMove(seepslopeCanvasCtx(canvas), event, seepslopeCanvasEnv(canvas));
  seepslopeApplyPointerEffects(event, effects);
}

function stage6BishopPointerUp(event){
  const canvas = event.currentTarget;
  const effects = seepslopePointerUp(seepslopeCanvasCtx(canvas), event, seepslopeCanvasEnv(canvas));
  seepslopeApplyPointerEffects(event, effects);
}

function stage6BishopPointerLeave(event){
  const canvas = event?.currentTarget || stage6BishopCanvasState.canvas;
  seepslopePointerLeave(seepslopeCanvasCtx(canvas), seepslopeCanvasEnv(canvas));
}

function stage6BishopWheel(event){
  const canvas = event.currentTarget;
  const effects = seepslopeWheel(seepslopeCanvasCtx(canvas), event, seepslopeCanvasEnv(canvas));
  seepslopeApplyPointerEffects(event, effects);
}

/** The only effect the state machine returns instead of performing (see canvas/pointer.js). */
function seepslopeApplyPointerEffects(event, effects){
  for(const effect of effects){
    if(effect.type === 'preventDefault') event.preventDefault();
  }
}

function stage6BishopDrawGrid(ctx, width, height){
  const bishop = S.stage6.bishop;
  seepslopeDrawGrid(ctx, {
    viewport:bishop.viewport,
    width,
    height,
    grid:seepslopeGridSpec(bishop.viewport, width, height, bishop.snapSize)
  }, seepslopeVizSeries());
}

function stage6BishopDrawCanvas(){
  const canvas = stage6BishopCanvasState.canvas || document.getElementById('stage6BishopCanvas');
  if(!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if(canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)){
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  const ctx = canvas.getContext('2d');
  if(!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const bishop = S.stage6.bishop;
  // E2E hook (harmless, read/drive only): set a terrain polyline and read the world→screen map.
  if (typeof window !== 'undefined') window.__bishopTest = {
    setTerrain: (t) => { bishop.terrain = stage6BishopSortedPolyline(t); bishop.viewport.fitted = false; renderStage6(); },
    worldToScreen: stage6BishopWorldToScreen,
    terrain: bishop.terrain
  };
  // PLAN §4 defect 3 / map §3.4 #5, §6.3 item 5: drawing a frame must not mutate the state. This
  // used to call stage6BishopSyncSoilModel() first, so every animation frame could re-import the
  // materials from the Stage 3/4 layers and — through the invalidation that re-import carries —
  // silently clear the Bishop and deformation results the user was looking at (map §3.4 #9). The
  // sync now runs only where the inputs change: the app render (stage6BishopCurrentModel at the
  // top of renderStage6BishopApp, which is also the app-entry and CPT-switch path), every field /
  // material / wall / drain / region / terrain-import handler, and each of the three run handlers
  // before they build their model. By the time a frame is drawn the block is therefore already
  // synced, and the line below is a pure read of it that yields the very model those callers
  // built — verified by scripts/verify_seepslope_model.mjs (c). Only the volatile model cache
  // (S.stage6Cache, not S.stage6) is written, so the hover tooltip and the pointer picking that
  // read it stay on the frame's own model instead of re-syncing behind the user. PR 18e keeps the
  // property structural: the view model below is a pure function and the draw layers only paint.
  const model = buildBishopModelFromStageLayers(stage6WorkingLayers(), bishop);
  S.stage6Cache.bishopModel = model;

  const viewModel = seepslopeBuildCanvasViewModel({
    bishop,
    model,
    viewport:bishop.viewport,
    width:rect.width,
    height:rect.height,
    hoverWorld:stage6BishopCanvasState.hoverWorld,
    excludeKey:seepslopeCanvasExcludeKey
  }, SEEPSLOPE_CANVAS_ENV);
  seepslopeDrawCanvasFrame(ctx, viewModel, seepslopeVizSeries());
}

function initStage6BishopCanvas(){
  const canvas = document.getElementById('stage6BishopCanvas');
  if(!canvas) return;
  stage6BishopCanvasState.canvas = canvas;
  canvas.onpointerdown = stage6BishopPointerDown;
  canvas.onpointermove = stage6BishopPointerMove;
  canvas.onpointerup = stage6BishopPointerUp;
  canvas.onpointercancel = stage6BishopPointerUp;
  canvas.onpointerleave = stage6BishopPointerLeave;
  canvas.onwheel = stage6BishopWheel;
  canvas.oncontextmenu = (event)=>event.preventDefault();
  canvas.onauxclick = (event)=>event.preventDefault();
  stage6BishopAutoFitViewportIfNeeded();
  stage6BishopDrawCanvas();
}

// ── bearing/ package façades (refactor step 7 / PR 12a): the legacy names on the window API
// keep their signatures; `layers` falls back to the working layers and the water table comes
// from the active CPT. Bodies: src/lib/cpt-app/bearing/compute.js.
function layerAtDepth(z, layers){
  return bearingLayerAtDepth(z, layers || stage6WorkingLayers());
}

function bearingAtDepth(z, cfg, layers){
  return bearingAtDepthPure(z, cfg, layers || stage6WorkingLayers(), { wt: S.wt });
}

function bearingProfile(cfg, layers){
  return bearingProfilePure(cfg, layers || stage6WorkingLayers(), { wt: S.wt });
}

// Backward-compatible alias for any external callers that still expect
// the old helper name on the legacy window API.
const stage6ShapeFactors = bearingShapeFactors;

// bearing/panel.js façades (legacy window API names).
function stage6BearingSelectedDepthHtml(sel, governing, governingMode){
  return bearingSelectedDepthHtml(sel, governing, governingMode);
}

function stage6BearingMaterialParamsHtml(sel, cfg){
  return bearingMaterialParamsHtml(sel, cfg);
}

function stage6BearingDrainedFormulaHtml(sel){
  return bearingDrainedFormulaHtml(sel);
}

function stage6BearingUndrainedFormulaHtml(sel){
  return bearingUndrainedFormulaHtml(sel);
}

function queueStage6BearingChartBuild(){
  bearingApp.queueChartBuild();
}

function refreshStage6BearingPreview(){
  bearingApp.refreshPreview();
}

function stage6SharedBanner(){
  return stage6Shell.sharedBanner();
}

function stage6AppIcon(id){
  return stage6Shell.appIcon(id);
}

function stage6CardsHtml(app){
  return stage6Shell.cardsHtml(app);
}

// =====================================================================
// Stage 6 — Pile Estimator (Option A++ interactive section view)
// =====================================================================
// Moved into src/lib/cpt-app/pile/ (refactor step 7, PR 12b): state.js (ensurePileState),
// panel.js (renderStage6PileApp and the four column / table builders), charts.js
// (buildStage6PileCharts), section-live.js (drawStage6PileSectionLive +
// requestStage6PileLightRedraw). The names below are façades over the installed `pileApp`;
// the shell's `apps.pile` adapter (top of the file) calls the package directly.

function ensurePileState(maxDepth){
  pileApp.ensure(S.stage6, {maxDepth});
}

function renderStage6PileApp(analysis){
  return pileApp.renderBody(analysis);
}

function buildStage6PileCharts(){
  pileApp.buildCharts();
}

function drawStage6PileSectionLive(){
  pileApp.sectionLive.draw();
}

function requestStage6PileLightRedraw(){
  pileApp.sectionLive.requestRedraw();
}

// Settlement app — moved into src/lib/cpt-app/settlement/ (refactor step 7, PR 12c): panel.js
// (renderStage6SettlementApp), chart.js (buildStage6SettlementCharts), options.js (the four load
// combination builders above). Façades over the installed `settlementApp`; the shell's
// `apps.settlement` adapter (top of the file) calls the package directly.
function renderStage6SettlementApp(analysis){
  return settlementApp.renderBody(analysis);
}

// Dewatering app — moved into src/lib/cpt-app/dewatering/ (refactor step 7, PR 12c): panel.js
// (renderStage6DewateringApp), chart.js (buildStage6DewateringCharts), options.js (the two
// combination builders). Façades over the installed `dewateringApp`; the shell's
// `apps.dewatering` adapter (top of the file) calls the package directly.
function renderStage6DewateringApp(analysis){
  return dewateringApp.renderBody(analysis);
}

// Beam / slab app — moved into src/lib/cpt-app/beam/ (refactor step 7, PR 12c): panel.js
// (renderStage6BeamApp + the orientation / durability fragments), chart.js (buildStage6BeamCharts),
// geometry-preview.js (drawStage6BeamGeometryPreview + the four canvas primitives), options.js (the
// beam wording builders). Façades over the installed `beamApp`; the shell's `apps.beam` adapter
// (top of the file) calls the package directly.
function renderStage6BeamApp(analysis){
  return beamApp.renderBody(analysis);
}

// ───────────────────── seepslope/panels façades (refactor step 9f / PR 18f) ─────────────────────
// SEEPSLOPE_PANELS_ENV is the host half of the panels package: the details memory, the seepage
// boundary and its selection, the two contour catalogues, the wall-result readers, the Stage 4
// depth and the two feature flags — every one of them a region step 9f must not touch (map §2.11).
// The package imports everything the earlier steps already own (seepslope/{state,geometry,run,probe},
// core/format, seepage/{material,drains}, wall-geometry) directly, so nothing pure is hooked here.
const SEEPSLOPE_PANELS_ENV = {
  STAGE6_ENABLE_HARDENING_SOIL_UI,
  STAGE6_WALL_RESPONSE_QUANTITIES,
  stage6DetailsOpen,
  stage6MaxDepth,
  stage6BishopUiState,
  // the volatile Stage 6 cache and the active block — the two `S` reads the prelude made
  cachedSeepageBoundary: ()=>S.stage6Cache?.bishopSeepageBoundary,
  stage6ActiveBishop: ()=>S.stage6.bishop,
  // map §2.11 "Seepage BC handlers"
  stage6BishopCurrentSeepageBoundary,
  stage6BishopSelectedBoundaryEdge,
  stage6BishopSeepageBcForEdge,
  stage6BishopSeepageEdgeLabel,
  stage6BishopSeepageBcTypeLabel,
  stage6BishopDisplayRegions,
  stage6BishopReadyMessage,
  stage6BishopLineProbeOptions,
  stage6BishopBuildLineProbe,
  // map §2.11 "Wall results"
  stage6BishopAnalysisWallId,
  stage6BishopWallResultForId,
  stage6BishopWallResultSeries,
  stage6BishopSelectedWallResult,
  stage6BishopWallQuantityStats,
  stage6BishopWallQuantityFormat,
  stage6BishopWallOverlayQuantity,
  // map §2.11 "Seepage state + contours"
  stage6BishopSeepageContourOptions,
  stage6BishopSeepageContourMeta,
  stage6BishopSeepageContourDerived,
  stage6BishopSeepageContourLegendTicks,
  stage6BishopSeepageContourLegendGradient,
  stage6BishopSeepageContourLegendValue,
  // map §2.11 "Deformation contours"
  stage6BishopDeformationContourOptions,
  stage6BishopDeformationContourMeta,
  stage6BishopDeformationContourDerived,
  stage6BishopDeformationContourLegendTicks,
  stage6BishopDeformationContourLegendGradient,
  stage6BishopDeformationContourLegendValue,
  stage6BishopDeformationVectorMode
};

// The host half of the render: the five `S` reads the monolith opened with, in its order, the
// surface-load shape migration (the one statement of the prelude that writes state) and the
// volatile line-probe cache the chart builder picks up after the innerHTML swap. Everything else —
// the 196 derivations and every HTML string — is seepslope/panels/.
function renderStage6BishopApp(){
  const bishop = S.stage6.bishop;
  const bishopUi = stage6BishopUiState();
  const model = stage6BishopCurrentModel();
  const modeMeta = stage6BishopModeMeta();
  const selected = stage6BishopSelectedResult();
  stage6BishopMigrateSurfaceLoadsShape(bishop);
  const vm = seepslopeBuildPanelsViewModel({bishop, bishopUi, model, modeMeta, selected}, SEEPSLOPE_PANELS_ENV);
  S.stage6Cache.bishopLineProbe = vm.lineProbe;
  return seepslopeBishopAppHtml(vm, SEEPSLOPE_PANELS_ENV);
}

function renderStage6(){
  stage6Shell.render();
}

function buildStage6BearingChart(){
  bearingApp.buildChart();
}

function buildStage6SettlementCharts(){
  settlementApp.buildCharts();
}

function buildStage6DewateringCharts(){
  dewateringApp.buildCharts();
}

function buildStage6BeamCharts(){
  beamApp.buildCharts();
}

function drawStage6BeamGeometryPreview(analysis){
  beamApp.drawGeometryPreview(analysis);
}

function buildStage6BishopLineProbeChart(){
  const canvas = stage6DestroyChart('stage6BishopLineProbeChart');
  const lineProbe = S.stage6Cache?.bishopLineProbe;
  if(!canvas || !lineProbe || lineProbe.status !== 'ready' || typeof Chart === 'undefined') return;
  const meta = lineProbe.meta || {label:'Line probe', axisTitle:'Value', color:readCssToken('--chart-blue', '#4F8584')};
  const tickFmt = (value)=>stage6CompactNumber(value, meta.digits || 3);
  canvas._chartRef = new Chart(canvas, buildLineProbeChartConfig({
    points:lineProbe.chartPoints,
    title:`${meta.label} along measurement line`,
    seriesLabel:meta.label,
    color:meta.color,
    xAxisTitle:'Distance along line s (m)',
    yAxisTitle:meta.axisTitle || meta.label,
    xTickFormatter:(value)=>stage6CompactNumber(value, 3),
    yTickFormatter:tickFmt,
    tooltipLabel:(value, distance)=>{
      const formattedValue = stage6BishopLineProbeFormatValue(meta, value);
      const formattedDistance = stage6CompactNumber(distance, 3);
      return `${meta.label}: ${formattedValue} @ s = ${formattedDistance} m`;
    }
  }));
}

/* ════════════════════════════════
   EXPORTS (CSV / PLAXIS)
════════════════════════════════ */
/* The text builders live in export/ (PR 8): buildLayersCsv, buildPlaxisCommandsText and
   buildPlaxisCptText take (cpt, ctx) and return the file text. These wrappers keep the
   guards, the alerts and the <a download> click of the monolith over the active CPT. */
function exportCSV(){
  if(!S.layers.length){alert(NO_LAYERS_MESSAGE);return;}
  const csv=buildLayersCsv(S, modelCtx());
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=layersCsvFilename(S);
  a.click();
}

function exportPlaxisCommands(){
  if(!S.layers.length){
    alert(NO_LAYERS_MESSAGE);
    return;
  }
  const txt=buildPlaxisCommandsText(S, modelCtx());
  const nuDrainageConflicts=plaxisNuDrainageConflicts(S, modelCtx());
  if(nuDrainageConflicts.length){
    alert(plaxisNuDrainageAlertMessage(nuDrainageConflicts));
  }
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(txt);
  a.download=plaxisCommandsFilename(S);
  a.click();
}

function exportPlaxisCpt(){
  if(!S.layers.length || !S.data.length){
    alert(NO_LAYER_MODEL_MESSAGE);
    return;
  }
  const txt=buildPlaxisCptText(S, modelCtx());
  if(txt==null){
    alert(NO_SIMULATED_ROWS_MESSAGE);
    return;
  }
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(txt);
  a.download=plaxisCptFilename(S);
  a.click();
}

/* ════════════════════════════════
   STAGE 7 — REPORT
════════════════════════════════ */
/* The payload builders live in report/ (PR 8): buildStage7Payload(project, cpt, deps) and
   its parts (payload-stage6.js, payload-seepslope.js). The automatic workspace capture moved
   to seepslope/report/capture.js in step 9g (PR 18g); what is left here is its host half —
   the offscreen canvas factory, the frame box, the section model, the theme — plus the
   manual "Capture for report" button, which writes S.stage6 and re-renders on purpose. */
// ── seepslope/report façades (refactor step 9g / PR 18g) ─────────────────────────────────
// 01-monolith-map.md §3.4 #10 and §6.3 item 7 — "Stage 7 capture that mutates app/workspace
// state" — are gone: stage7CaptureBishopWorkspaceView no longer sets S.stage6.app /
// bishop.workspace, no longer calls renderStage6() twice and no longer reads the on-screen
// canvas. It paints the frame on a canvas of its own from a view model built for the target
// workspace (seepslope/canvas, PR 18e) and hands that to the same down-scale + JPEG encode.
// The four host halves the package cannot own are below.

/** A real offscreen canvas, or null where there is none (SSR, the Node golden harness). */
function stage7OffscreenCanvas(width, height){
  if(typeof document === 'undefined') return null;
  const canvas=document.createElement('canvas');
  // The monolith's own guard, moved from the source canvas to the target one: the Tier-B DOM
  // stub hands out plain objects, so a payload built under Node still has no image.
  if(!(canvas instanceof HTMLCanvasElement)) return null;
  canvas.width=Math.max(1, Math.round(width));
  canvas.height=Math.max(1, Math.round(height));
  return canvas;
}

/**
 * The CSS box the Seep/Slope canvas has — or would have — plus the device pixel ratio the backing
 * store is sized for. The live element when the app is open; otherwise the same box measured
 * through a zero-height probe with the layout's own classes (seepslope/report/capture.js
 * `bishopCanvasProbeHtml`), appended to #stage6Area and removed in the same task, so nothing is
 * painted and no state is touched. Null when Stage 6 is not laid out at all (`.panel` is
 * `display:none`) — the state in which the monolith measured a 0 × 0 canvas and captured nothing.
 */
function stage6BishopCanvasBox(){
  if(typeof document === 'undefined' || typeof window === 'undefined') return null;
  const dpr=window.devicePixelRatio || 1;
  const live=document.getElementById('stage6BishopCanvas');
  if(live instanceof HTMLCanvasElement){
    const rect=live.getBoundingClientRect();
    if(rect.width > 0 && rect.height > 0) return {width:rect.width, height:rect.height, dpr};
  }
  const area=document.getElementById('stage6Area');
  if(!area || typeof area.appendChild !== 'function') return null;
  const probe=document.createElement('div');
  probe.setAttribute('aria-hidden','true');
  probe.style.cssText='height:0;overflow:hidden;visibility:hidden';
  probe.innerHTML=seepslopeBishopCanvasProbeHtml({settingsWide:stage6BishopUiState().bishopSettingsWide === true});
  area.appendChild(probe);
  try{
    const rect=probe.querySelector?.('canvas')?.getBoundingClientRect?.() || null;
    if(!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
    return {width:rect.width, height:rect.height, dpr};
  }finally{
    probe.remove();
  }
}

/**
 * The host half of the capture: the four non-pure pieces `seepslope/report/capture.js` asks for.
 * `model` is the frame's own line (stage6BishopDrawCanvas 4797-4798) including the volatile cache
 * write — S.stage6Cache, not S.stage6 — because stage7SeepagePayload reads `bishopModel` back
 * after the stability capture has run, and must keep seeing the model the frame built.
 */
function stage7CaptureHost(){
  return {
    ensure:()=>ensureStage6State(),
    box:()=>stage6BishopCanvasBox(),
    model:()=>{
      const model=buildBishopModelFromStageLayers(stage6WorkingLayers(), S.stage6.bishop);
      S.stage6Cache.bishopModel=model;
      return model;
    },
    createCanvas:stage7OffscreenCanvas,
    theme:()=>seepslopeVizSeries(),
    env:SEEPSLOPE_CANVAS_ENV
  };
}

/** The live canvas by id, down-scaled and encoded — what the manual capture button grabs. */
function stage7CaptureCanvasImage(canvasId, options = {}){
  if(typeof document === 'undefined') return null;
  const canvas=document.getElementById(canvasId);
  if(!(canvas instanceof HTMLCanvasElement)) return null;
  return seepslopeRasteriseCanvas(canvas, {...options, createCanvas:stage7OffscreenCanvas});
}

// User-initiated workspace screenshot. Press the "Capture" button in the
// stability / seepage / deformation toolbar; the canvas is grabbed exactly as
// shown (selected result, contour mode, viewport zoom, ...) and stored on the
// bishop state. The Stage 7 payload prefers this manual capture over the
// automatic capture done at report-build time, so the user controls which
// view of the analysis appears in the printed report.
function stage7CaptureWorkspaceView(workspace){
  if(typeof document === 'undefined') return;
  ensureStage6State();
  if(!seepslopeIsCaptureWorkspace(workspace)) return;
  const image = stage7CaptureCanvasImage('stage6BishopCanvas');
  if(!image?.dataUrl){
    console.warn(`Stage 7 capture (${workspace}) failed: canvas not ready.`);
    return;
  }
  const bishop = S.stage6.bishop;
  if(!bishop.capturedView || typeof bishop.capturedView !== 'object'){
    bishop.capturedView = { stability:null, seepage:null, deformation:null };
  }
  const display = seepslopeManualCaptureDisplay(bishop, workspace);
  bishop.capturedView[workspace] = {
    workspace,
    app:'bishop',
    capturedAt: new Date().toISOString(),
    image,
    viewport: safeClone(bishop.viewport || null),
    display
  };
  // Re-render so the toolbar shows the new captured-state badge.
  renderStage6();
}

function stage7ClearWorkspaceCapture(workspace){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  if(!bishop.capturedView) return;
  if(['stability','seepage','deformation'].includes(workspace)){
    bishop.capturedView[workspace] = null;
    renderStage6();
  }
}

/**
 * The automatic annex screenshot: `seepslope/report/capture.js` bound to the active CPT and to the
 * host halves above — the same value `report/deps.js` builds itself from `over.captureHost` when a
 * caller has no controller. It is handed to the payload under the dep name PR 8 gave it
 * (`captureBishopWorkspaceView`), so nothing downstream changed except that a report build no
 * longer switches the app, re-renders or writes `S.stage6`.
 */
function stage7CaptureBishopWorkspaceView(workspace){
  if(typeof document === 'undefined') return null;
  return seepslopeBishopWorkspaceCapture(S, stage7CaptureHost())(workspace);
}

/* Everything the pure builder used to reach through this module's closure, named
   (report/deps.js): the model-parameter wrappers over the active CPT, the Stage 6 state
   normaliser, the host half of the automatic workspace capture (only called when an annex
   exists and no manual capture is stored — same conditional as before) and the Seep/Slope
   helpers that move with the seepslope/ package in step 9. */
function stage7ControllerDeps(){
  return {
    hsParams,
    khParams,
    workingLayers:stage6WorkingLayers,
    ensureStage6State,
    captureBishopWorkspaceView:stage7CaptureBishopWorkspaceView,
    seepslope:{
      resultMethodLabel:stage6BishopResultMethodLabel,
      seepageEdgeLabel:stage6BishopSeepageEdgeLabel,
      seepageBcTypeLabel:stage6BishopSeepageBcTypeLabel,
      drainGatingLabel:stage6BishopDrainGatingLabel,
      resolvedSeepageMeshTargetArea:stage6BishopResolvedSeepageMeshTargetArea
    }
  };
}

function buildStage7Payload(){
  if(!S.layers.length || !S.data.length){
    alert(STAGE7_GUARD_MESSAGE);
    return null;
  }
  return buildStage7PayloadPure(PROJECT, S, stage7ControllerDeps());
}

function openStage7Report(){
  const payload=buildStage7Payload();
  if(!payload || typeof window === 'undefined') return;
  const key=saveStage7Payload(window.localStorage, payload);
  if(!key){
    toast('The Stage 7 report payload could not be validated for saving.',{tone:'bad'});
    return;
  }
  cleanupStage7Payloads(window.localStorage, key);
  window.open(`/report/stage7?key=${encodeURIComponent(key)}`, '_blank', 'noopener');
}

function stage6BishopHandleHashChange(){
  if(!S?.stage6) return;
  if(stage6BishopHashActive()){
    if(S.stage6.app !== 'bishop') S.stage6.app = 'bishop';
  } else if(S.stage6.app === 'bishop'){
    S.stage6.app = 'bearing';
  }
  renderStage6();
}

const legacyApi={
  PROJECT,
  newCptState,
  selectCpt,
  addCpt,
  setCptName,
  renderBanner,
  removeCpt,
  setPhase,
  loadGEF,
  setCptCoord,
  saveProject: projectIO.saveProject,
  loadProjectFromFile: projectIO.loadProjectFromFile,
  layerTypeCompatScore,
  sectionProjection,
  renderSection,
  bindSectionTooltip,
  exportSectionSVG,
  sb260GranularAlpha,
  sb260TransitionAlpha,
  sb260AlphaFamily,
  alphaEB,
  goS,
  parseGEF,
  updateElevSrc,
  updateWTDisplay,
  renderMeta,
  setElev,
  setWT,
  updateWTLine,
  setMinThk,
  setSmartMerge,
  setSmartMergeSensitivity,
  setAssumedRf,
  arrMax,
  arrSafe,
  initCharts,
  refreshChartData,
  drawLayerColumnSvg,
  renderLayerPreviewSvg,
  bindLayerPreviewTooltip,
  loadDemo,
  selM,
  stressAt,
  classRob,
  classCUR,
  classSB260,
  runClass,
  segmentSummary,
  subtypeGroup,
  familyClass,
  qcSimilarity,
  rfSimilarity,
  subtypeSimilarity,
  paramSimilarity,
  compatSimilarity,
  continuityScore,
  isCriticalMarkerLayer,
  mergeCandidateScore,
  detectLayers,
  eurocodeEntryMatches,
  compatLevel,
  qcRfFit,
  suggestSubtype,
  buildSubtypeDropdown,
  renderLayers,
  changeSubtype,
  renderCompatWarnings,
  editL,
  editAlpha,
  editM,
  editRShear,
  editNu,
  khParams,
  setAlphaMethod,
  setStiffMethod,
  setKhKvMethod,
  setParamMethod,
  hsParams,
  renderModel,
  fitLayer,
  runTuning,
  acceptFit,
  rejectFit,
  getTuningPreviewM,
  tuningSliderBounds,
  tuningPreviewEoedRef,
  tuningPreviewLineData,
  updateTuningPreviewM,
  renderTuning,
  buildTuningCharts,
  stage6Defaults,
  ensureStage6State,
  setStage6Field,
  setStage6App,
  stage6BishopSetWorkspace,
  stage6BishopSetField,
	  stage6BishopSetTool,
	  stage6BishopSelectSurfaceLoad,
	  stage6BishopSetSurfaceLoadField,
	  stage6BishopDeleteSurfaceLoad,
	  stage6BishopToggleSettingsPanel,
  stage6BishopToggleSettingsWidth,
  stage6BishopToggleToolRail,
  stage6BishopToggleCanvasTools,
  stage6BishopSetCanvasPanel,
  stage6BishopSetCanvasSheet,
  stage6BishopOpenSettingsDetail,
  stage6BishopTriggerDxfImport,
  stage6BishopImportDxf,
  stage6BishopCopyCurrentRegionsToCustom,
  stage6BishopExportRegionsDxf,
  stage6BishopSetUseCustomRegions,
  stage6BishopDeleteSelectedRegion,
  stage6BishopSetSelectedRegionMaterial,
  stage6BishopSetSelectedRegionCoarseness,
  stage6BishopFinishDraft,
  stage6BishopPopDraftPoint,
  stage6BishopClear,
  stage6BishopSetMaterialField,
  stage6BishopSetMaterialHsField,
  stage6BishopResolveHsConsistentTangentMigration,
  stage6BishopSetMaterialPermeability,
  stage6BishopResetMaterialPermeability,
  stage6BishopSetWallField,
  stage6BishopSetWallMaterialField,
  stage6BishopDeleteWall,
  stage6BishopSelectWall,
  stage6BishopToggleWallMomentOverlay,
  stage6BishopOpenAnalysisTab,
  stage6BishopSetAnalysisTab,
  stage6BishopResolveWallMechanicalActivation,
  stage6BishopCopyWallData,
  stage6BishopSelectDrain,
  stage6BishopSetDrainField,
  stage6BishopDeleteDrain,
  stage6BishopSelectSeepageBoundary,
  stage6BishopSetSeepageBcType,
  stage6BishopSetSeepageBcHead,
  stage6BishopDeleteSeepageBc,
  stage6BishopRunSeepage,
  stage6BishopStopSeepage,
  stage6BishopRunDeformation,
  stage6BishopStopDeformation,
  stage6BishopCopyLineProbeData,
  stage6BishopRunSearch,
  stage6BishopStopSearch,
  stage6BishopSelectResult,
  fitStage6BishopViewport,
  stage7CaptureWorkspaceView,
  stage7ClearWorkspaceCapture,
  layerAtDepth,
  stage6ShapeFactors,
  bearingAtDepth,
  bearingProfile,
  stage6BearingSelectedDepthHtml,
  stage6BearingMaterialParamsHtml,
  stage6BearingDrainedFormulaHtml,
  stage6BearingUndrainedFormulaHtml,
  queueStage6BearingChartBuild,
  refreshStage6BearingPreview,
  renderStage6,
  buildStage6BearingChart,
  buildStage7Payload,
  openStage7Report,
  exportCSV,
  exportPlaxisCommands,
  exportPlaxisCpt
};

export function initLegacyController(){
  if(__legacyControllerInitialized) return ()=>{};
  Object.assign(window, legacyApi);
  Object.assign(window, retainingApp.handlers);
  bindDropzone();
  if(stage6BishopHashActive()) S.stage6.app = 'bishop';
  renderBanner();
  if(!__legacyControllerHashBound && typeof window !== 'undefined'){
    window.addEventListener('hashchange', stage6BishopHandleHashChange);
    __legacyControllerHashBound = true;
  }
  __legacyControllerInitialized = true;
  return ()=>{};
}
