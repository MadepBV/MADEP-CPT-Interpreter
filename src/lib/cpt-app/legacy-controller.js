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
import { installLoadApp } from './load/index.js';
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
  sb260GranularAlpha,
  sb260TransitionAlpha,
  sb260AlphaFamily,
  alphaEB,
  cptModelCtx,
  hsParams as hsParamsPure,
  khParams as khParamsPure,
  installModelParamsApp
} from './model-params/index.js';
import { installClassificationApp } from './classification/index.js';
import {
  compatLevel,
  qcRfFit,
  suggestSubtype,
  layerTypeCompatScore,
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
  installLayersApp
} from './layers/index.js';
import {
  get as stage6Get,
  set as stage6Set,
  installStage6App
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
import { installProject } from './project/index.js';
import { installSection } from './section/index.js';
import {
  getTuningPreviewM,
  tuningSliderBounds,
  tuningPreviewEoedRef,
  tuningPreviewLineData,
  installTuningApp
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
import { createSeepageContours } from './seepslope/contours/seepage.js';
import { createDeformationContours } from './seepslope/contours/deformation.js';
import { createWallResponse } from './seepslope/wall/response.js';
import { stage6BishopRenderWallChart as seepslopeRenderWallChart } from './seepslope/wall/chart.js';
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
const stage6App = installStage6App({
  document,
  getActive: () => S,
  retaining: retainingApp,
  bishopEnabled: () => stage6BishopEnabled(),
  workingLayers: () => stage6WorkingLayers(),
  hardeningSoilUi: STAGE6_ENABLE_HARDENING_SOIL_UI,
  // The one Seep/Slope helper the state migration calls back into (seepslope/state/ensure.js).
  deformationQuantityIds: (analysisType, hasHs) => stage6BishopDeformationQuantityIds(analysisType, hasHs),
  refreshBearingPreview: () => refreshStage6BearingPreview(),
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
const {
  registry: stage6Registry,
  defaults: stage6Defaults,
  ensure: ensureStage6State,
  ensureCtx: stage6EnsureCtx,
  maxDepth: stage6MaxDepth,
  rememberDetailsState: stage6RememberDetailsState,
  detailsOpen: stage6DetailsOpen,
  setDetailsOpen: stage6SetDetailsOpen,
  uiState: stage6BishopUiState,
  setStage6Field,
  setStage6App,
  render: renderStage6,
  cardsHtml: stage6CardsHtml,
  sharedBanner: stage6SharedBanner,
  appIcon: stage6AppIcon
} = stage6App;

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
  window: typeof window !== 'undefined' ? window : null,
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
  },
  renderStage6: () => renderStage6()
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
   STAGE 1 — LOAD  (src/lib/cpt-app/load/, PR 20 / refactor step 10)
   The parse → review → apply handshake, the multi-file loader, the elevation / water table /
   assumed-Rf / min-thickness / smart-merge controls, the three raw charts, the two layer SVGs
   and the dropzone. `installLoadApp(ctx)` owns them; the names below are its methods, kept as
   module bindings so the inline `on*=` attributes and the Node verifiers still find them.
════════════════════════════════ */
const loadApp = installLoadApp({
  document,
  getProject: () => PROJECT,
  getActive: () => S,
  newCptState,
  selectCpt: (idx) => selectCpt(idx),
  renderBanner: () => renderBanner(),
  runClass: () => runClass(),
  detectLayers: () => detectLayers(),
  renderLayers: () => renderLayers(),
  toast,
  alert: (message) => alert(message)
});
const {
  cptFileImporters, importParsedCpt, applyParsedCptTo, applyParsedCpt,
  parseGEF, parseCsvCpt, parseExcelCpt,
  importCptFiles, importGEFFiles, loadGEF, setCptCoord,
  updateElevSrc, updateWTDisplay, renderMeta,
  setElev, setWT, updateWTLine, setAssumedRf, updateAssumedRfControls,
  cancelClassificationRefresh, refreshClassificationDerivedViews, scheduleClassificationDerivedViews,
  setMinThk, setSmartMerge, setSmartMergeSensitivity,
  arrMax, arrSafe, initCharts, refreshChartData, updateRawChartEmptyStates,
  drawLayerColumnSvg, renderLayerPreviewSvg, bindLayerPreviewTooltip,
  loadDemo, bindDropzone
} = loadApp;

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


/* ════════════════════════════════
   STAGES 2-5 (src/lib/cpt-app/{classification,layers,model-params,tuning}/, PR 20 / step 10)
   Classification run and method cards · layer detection, table and per-layer editors · the
   Stage 4 parameter cards and the three global method toggles · the Stage 5 m-fit. Each package
   is installed once with the shared accessors; the names below are the installs' methods, kept
   as module bindings so the inline `on*=` attributes and the Node verifiers still find them.
════════════════════════════════ */
const classificationApp = installClassificationApp({
  document,
  getActive: () => S,
  toast,
  detectLayers: () => detectLayers(),
  renderLayerPreviewSvg: (svgId) => renderLayerPreviewSvg(svgId),
  drawLayerColumnSvg: (svgId, layers, maxZ) => drawLayerColumnSvg(svgId, layers, maxZ)
});
const {
  syncMethodCards: syncClassificationMethodCards, selM,
  assumedRfValue, cptHasFs, cptHasRf,
  classRob, classRob2016, classCUR3, classCUR, classNEN6740, classSB260,
  runClass
} = classificationApp;

const layersApp = installLayersApp({
  document,
  getActive: () => S,
  renderModel: () => renderModel()
});
const {
  segmentSummary, detectLayers, renderLayers, renderCompatWarnings,
  changeSubtype, editL, editAlpha, editM, editRShear, editNu, setParamMethod
} = layersApp;
const buildSubtypeDropdown = layersApp.handlers.buildSubtypeDropdown;

const modelParamsApp = installModelParamsApp({
  document,
  getActive: () => S,
  hardeningSoilParams: STAGE4_ENABLE_HARDENING_SOIL_PARAMS,
  buildTuningCharts: () => buildTuningCharts()
});
const {
  modelCtx, stressAt, hsParams, khParams, renderModel,
  setAlphaMethod, setStiffMethod, setKhKvMethod,
  workingLayers: stage6WorkingLayers
} = modelParamsApp;

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
const tuningApp = installTuningApp({
  document,
  getActive: () => S,
  // acceptFit re-renders Stage 4 in the background so it stays current (map §3.4 #2/#3).
  renderModelIfActive: () => { if(document.getElementById('p3').classList.contains('active')) renderModel(); }
});
const {
  fitLayer, runTuning, acceptFit, rejectFit, updateTuningPreviewM, renderTuning, buildTuningCharts
} = tuningApp;

/* ════════════════════════════════
   STAGE 6 — APPLICATIONS
   The shell (registry, state schema, <details> memory, field setters, the one re-render path)
   is src/lib/cpt-app/stage6/, installed at the top of this file; the bishop UI toggles below
   still belong to the Seep/Slope app.
════════════════════════════════ */
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

function stage6BishopEnabled(){
  return true;
}

/* The `#bishop` deep link lives in project/phase.js (PR 20); this keeps the monolith name. */
function stage6BishopHashActive(){
  return projectApp.bishopHashActive();
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

/* ── seepslope/contours façades (refactor step 10 / PR 20) ────────────────────────────────
   The two contour catalogues — every quantity of the seepage and the deformation workspace with
   its label, unit, per-element / per-cell value, nodal interpolation, statistics, colours and
   legend (map §2.11) — live in src/lib/cpt-app/seepslope/contours/. They are factories, not plain
   modules, because three members read the active CPT: the deformation analysis-type fallback and
   the two iso-line memos on the volatile Stage 6 cache. The names below are those factories'
   members, kept as module bindings. */
const seepageContours = createSeepageContours({
  ensure: () => ensureStage6State(),
  cache: () => (S.stage6Cache ||= {})
});
const {
  stage6BishopSeepageHeadColor, stage6BishopSeepageContourMeta, stage6BishopSeepageContourOptions,
  stage6BishopSeepageCriticalGradient, stage6BishopSeepageHydraulicFs, stage6BishopSeepageElementContourValue,
  stage6BishopSeepageContourValue, stage6BishopSeepageContourModeIsSigned, stage6BishopSeepageContourStats,
  stage6BishopSeepageContourNodalValues, stage6BishopSeepageContourRgb, stage6BishopSeepageContourColor,
  stage6BishopSeepageContourLineColor, stage6BishopSeepageContourLegendGradient, stage6BishopSeepageContourLegendTicks,
  stage6BishopSeepageContourLegendValue, stage6BishopSeepageContourLevels, stage6BishopSeepageContourDerived
} = seepageContours;

const deformationContours = createDeformationContours({
  currentAnalysisType: () => S?.stage6?.bishop?.deformation?.options?.analysisType,
  ensure: () => ensureStage6State(),
  cache: () => (S.stage6Cache ||= {})
});
const {
  stage6BishopNormalizedDeformationAnalysisType, stage6BishopDeformationQuantityIds, stage6BishopDeformationContourMeta,
  stage6BishopDeformationContourOptions, stage6BishopDeformationVectorMode, stage6BishopT6VisualSubtriangles,
  stage6BishopDeformationPlasticPointSets, stage6BishopDeformationFiniteScalar, stage6BishopDeformationFiniteScalarOrNull,
  stage6BishopDeformationElementEtaMc, stage6BishopAverageFiniteValues, stage6BishopDeformationCellTriangleIndices,
  stage6BishopDeformationCellNodeIds, stage6BishopDeformationElementContourValue, stage6BishopDeformationContourValue,
  stage6BishopDeformationContourModeIsSigned, stage6BishopDeformationContourStats, stage6BishopDeformationContourNodalValues,
  stage6BishopDeformationVisualContourMesh, stage6BishopDeformationContourRgb, stage6BishopDeformationContourColor,
  stage6BishopDeformationContourLineColor, stage6BishopDeformationContourLegendGradient, stage6BishopDeformationContourLegendTicks,
  stage6BishopDeformationContourLegendValue, stage6BishopDeformationContourFlatTolerance, stage6BishopDeformationContourLevels,
  stage6BishopDeformationContourDerived
} = deformationContours;

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

/* ── seepslope/wall façades (refactor step 10 / PR 20) ────────────────────────────────────
   The five plotted wall-response quantities, their series, extrema, overlay colours and the
   wall-result lookup by id (map §2.11 "Wall results") live in src/lib/cpt-app/seepslope/wall/
   response.js — a factory, because the four lookups read the active CPT's bishop block. */
const wallResponse = createWallResponse({ bishop: () => S?.stage6?.bishop });
const {
  STAGE6_WALL_RESPONSE_QUANTITIES,
  stage6BishopWallResultSeries, stage6BishopWallResponseMeta, stage6BishopWallOverlayQuantity,
  stage6BishopWallQuantitySeries, stage6BishopWallQuantityStats, stage6BishopWallQuantityFormat,
  stage6BishopCssColorWithAlpha, stage6BishopContrastingTextColor, stage6BishopWallNodeValuesForOverlay,
  stage6BishopWallResultIsStale, stage6BishopWallResultForId, stage6BishopSelectedWallResult,
  stage6BishopAnalysisWallId
} = wallResponse;

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

/* The five small wall diagrams are painted by seepslope/wall/chart.js; the three formatters
   they label with come from the wall-response factory above. */
function stage6BishopRenderWallChart(canvas, sValues, values, options = {}){
  return seepslopeRenderWallChart(canvas, sValues, values, options, {
    wallQuantityFormat: stage6BishopWallQuantityFormat,
    cssColorWithAlpha: stage6BishopCssColorWithAlpha,
    contrastingTextColor: stage6BishopContrastingTextColor
  });
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
  projectApp.handleBishopHashChange();
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
  projectApp.bindStageNav();
  bindDropzone();
  projectApp.applyOpeningBishopHash();
  renderBanner();
  if(!__legacyControllerHashBound) __legacyControllerHashBound = projectApp.bindBishopHash();
  __legacyControllerInitialized = true;
  return ()=>{};
}
