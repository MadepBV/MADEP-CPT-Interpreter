// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// seepslope/host.js — the Seep / Slope application bound to a host (01-monolith-map.md §6.1 row
// `seepslope/`, `index.js (installSeepSlopeApp(ctx))`); moved out of legacy-controller.js in
// PR 20 / refactor step 10, verbatim.
//
// Steps 9a-9g carved the Seep / Slope domain into seepslope/{state, model, run, geometry, probe,
// canvas, panels, report} and left one layer behind in the monolith: the *host half* those pure
// packages cannot own — the active CPT, the DOM, the three worker singletons, the canvas element
// and the device-pixel ratio, the volatile model cache, and the handlers that tie a state write
// to a re-render. That layer is this file. It is one closure so the ~230 names keep referring to
// each other exactly as they did at module scope in the monolith; the only identifiers that
// changed are the ones the controller owned:
//
//   S                                 → getActive()
//   STAGE6_ENABLE_HARDENING_SOIL_UI   → hardeningSoilUi
//   document, ensureStage6State, renderStage6, stage6RememberDetailsState, stage6DetailsOpen,
//   stage6SetDetailsOpen, stage6BishopUiState, stage6WorkingLayers, stage6MaxDepth,
//   stage6Defaults, stage6Get, stage6Set   → members of `env` (the Stage 6 shell install)
//
// Everything else — the three env objects (SEEPSLOPE_PROBE_ENV, SEEPSLOPE_CANVAS_ENV,
// SEEPSLOPE_PANELS_ENV), the worker adapter, the canvas state — moved with the code it serves.
// `createSeepSlopeHost(env)` returns every one of those names; seepslope/index.js composes it
// into `installSeepSlopeApp(ctx)` and adds the published `handlers`.

import { buildBishopModelFromStageLayers } from '../stage6-bishop.js';
import { importTerrainFromDxfText } from '../dxf-terrain.js';
import { exportRegionsToDxf } from '../dxf-regions.js';
import {
  buildOuterBoundary as buildSeepageOuterBoundary,
  makeBoundaryCondition as makeSeepageBoundaryCondition,
  migrateBcs as migrateSeepageBcs,
  pickOuterBoundaryEdge as pickSeepageBoundaryEdge,
  seepageGeometryHash
} from '../seepage/boundary.js';
import { resolveMaterialPermeability } from '../seepage/material.js';
import { validateDrains } from '../seepage/drains.js';
import { normalizeRegionPolygon } from '../soil-regions.js';
import { buildLineProbeChartConfig } from '../chart-factories.js';
import { seepslopeVizSeries } from '../../styles/theme.ts';
import { escAttr as stage6EscAttr, compactNumber as stage6CompactNumber } from '../core/format.js';
import { readCssToken } from '../core/css-tokens.js';
import { destroyChart as stage6DestroyChart } from '../core/chart-host.js';
import { safeClone } from '../report/index.js';
import { get as stage6Get, set as stage6Set } from '../stage6/index.js';
import {
  sortedPolyline as stage6BishopSortedPolyline,
  autoSeepageMeshTargetArea as stage6BishopAutoSeepageMeshTargetArea,
  autoDeformationMeshTargetArea as stage6BishopAutoDeformationMeshTargetArea,
  validZone as stage6BishopValidZone,
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
  defaultPassiveSide as seepslopeDefaultPassiveSide,
  wallId as seepslopeWallId,
  defaultWallMaterial as stage6BishopDefaultWallMaterial,
  normalizeWalls as stage6BishopNormalizeWalls,
  setWallField as seepslopeSetWallField,
  setWallMaterialField as seepslopeSetWallMaterialField,
  deleteWall as seepslopeDeleteWall,
  selectWall as seepslopeSelectWall,
  drainId as seepslopeDrainId,
  createDrainFromVertices as seepslopeCreateDrainFromVertices,
  selectDrain as seepslopeSelectDrain,
  setDrainField as seepslopeSetDrainField,
  deleteDrain as seepslopeDeleteDrain,
  regionId as seepslopeRegionId,
  normalizeRegionCoarseness as stage6BishopNormalizeRegionCoarseness,
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
} from './state/index.js';
import {
  syncSoilModel as seepslopeSyncSoilModel,
  applySoilModelPatch as seepslopeApplySoilModelPatch,
  invalidateSeepage as seepslopeInvalidateSeepage,
  invalidateDeformation as seepslopeInvalidateDeformation,
  invalidateBishop as seepslopeInvalidateBishop,
  invalidateWallGeometry as seepslopeInvalidateWallGeometry
} from './model/index.js';
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
  methodModeLabel as stage6BishopMethodModeLabel,
  secondsLabelFromMs as stage6SecondsLabelFromMs,
  seepageFlowErrorLabel as stage6SeepageFlowErrorLabel,
  safetyFinalizationStatusFromSolver as stage6SafetyFinalizationStatusFromSolver,
  completeMessage as stage6BishopCompleteMessage,
  seepageCompleteMessage as stage6BishopSeepageCompleteMessage
} from './run/index.js';
import {
  polygonIsValid as stage6BishopPolygonIsValid,
  validateHolePolygon as stage6BishopValidateHolePolygon,
  pickRegionBoundaryPoint as seepslopePickRegionBoundaryPoint,
  subtractHoleFromPolygon as stage6BishopSubtractHoleFromPolygon,
  splitRegionPolygon as stage6BishopSplitRegionPolygon,
  displayRegions as seepslopeDisplayRegions,
  regionAtPoint as stage6BishopRegionAtPoint,
  regionTooltipHtml as seepslopeRegionTooltipHtml,
  measurementMetrics as stage6BishopMeasurementMetrics
} from './geometry/index.js';
import {
  lineProbeOptions as seepslopeLineProbeOptions,
  lineProbeMeta as seepslopeLineProbeMeta,
  lineProbeFormatValue as stage6BishopLineProbeFormatValue,
  lineProbeClipboardText as stage6BishopLineProbeClipboardText,
  buildLineProbe as seepslopeBuildLineProbe
} from './probe/index.js';
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
} from './canvas/index.js';
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
} from './panels/index.js';
import { createSeepageContours } from './contours/seepage.js';
import { createDeformationContours } from './contours/deformation.js';
import { createWallResponse } from './wall/response.js';
import { stage6BishopRenderWallChart as seepslopeRenderWallChart } from './wall/chart.js';
import {
  bishopCanvasProbeHtml as seepslopeBishopCanvasProbeHtml,
  bishopWorkspaceCapture as seepslopeBishopWorkspaceCapture,
  isCaptureWorkspace as seepslopeIsCaptureWorkspace,
  manualCaptureDisplay as seepslopeManualCaptureDisplay,
  rasteriseCanvas as seepslopeRasteriseCanvas
} from './report/index.js';

export function createSeepSlopeHost(env){
  const {
    document, getActive, hardeningSoilUi,
    ensureStage6State, renderStage6, stage6RememberDetailsState,
    stage6DetailsOpen, stage6SetDetailsOpen, stage6BishopUiState,
    stage6WorkingLayers, stage6MaxDepth, stage6Defaults
  } = env;

  // The three Seep / Slope workers and their run ids (map §3.4 #8) live in this adapter instead of
  // six module variables; nothing outside the run façades below touches it.
  const stage6BishopWorkers = seepslopeCreateWorkerAdapter();
  const stage6BishopCanvasState = {
    canvas:null,
    pointerDrag:null,
    hoverWorld:null
  };

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


  // ── seepslope/state façades (refactor step 9a / PR 18a) ─────────────────────────────────────
  // The surface-load, wall, drain and region state helpers live in src/lib/cpt-app/seepslope/state/
  // (surface-loads.js, walls.js, drains.js, regions.js, domain.js). The pure ones are imported under
  // their monolith names at the top of this file; the functions below keep the names whose monolith
  // signature read the active CPT (`S`) or generated an id, and hand the package the `bishop` block.
  function stage6BishopSyncLegacySurfaceLoadMirror(bishop = getActive().stage6?.bishop){
    seepslopeSyncLegacySurfaceLoadMirror(bishop);
  }

  function stage6BishopSelectedSurfaceLoad(){
    return seepslopeSelectedSurfaceLoad(getActive().stage6?.bishop);
  }

  function stage6BishopPrimarySurfaceLoad(create = false){
    return seepslopePrimarySurfaceLoad(getActive().stage6?.bishop, create);
  }

  function stage6BishopEffectiveSurfaceLoadQ(load, workspace = getActive().stage6?.bishop?.workspace || 'stability'){
    return seepslopeEffectiveSurfaceLoadQ(getActive().stage6?.bishop, load, workspace);
  }

  function stage6BishopSurfaceLoadSummary(load, workspace = getActive().stage6?.bishop?.workspace || 'stability'){
    return seepslopeSurfaceLoadSummary(getActive().stage6?.bishop, load, workspace);
  }

  function stage6BishopActiveSurfaceLoads(workspace = getActive().stage6?.bishop?.workspace || 'stability'){
    return seepslopeActiveSurfaceLoads(getActive().stage6?.bishop, workspace);
  }

  function stage6BishopSetSurfaceLoadField(loadId, field, value){
    ensureStage6State();
    stage6RememberDetailsState();
    const load = seepslopeSetSurfaceLoadField(getActive().stage6.bishop, loadId, field, value);
    if(!load) return;
    stage6BishopInvalidate('Surface load changed; rerun the active analysis.');
    renderStage6();
  }

  function stage6BishopSelectSurfaceLoad(loadId){
    ensureStage6State();
    seepslopeSelectSurfaceLoad(getActive().stage6.bishop, loadId);
    renderStage6();
  }

  function stage6BishopDeleteSurfaceLoad(loadId){
    ensureStage6State();
    stage6RememberDetailsState();
    if(seepslopeDeleteSurfaceLoad(getActive().stage6.bishop, loadId)){
      stage6BishopInvalidate('Surface load deleted; rerun the active analysis.');
    }
    renderStage6();
  }

  function stage6BishopCreateSurfaceLoadFromZone(zone){
    const load = seepslopeCreateSurfaceLoadFromZone(getActive().stage6.bishop, zone);
    if(load) stage6BishopInvalidate('Surface load added; rerun the active analysis.');
    return load;
  }

  function stage6BishopDefaultPassiveSide(){
    return seepslopeDefaultPassiveSide(getActive().stage6?.bishop?.terrain || []);
  }

  function stage6BishopWallId(){
    return seepslopeWallId();
  }

  function stage6BishopDrainId(){
    return seepslopeDrainId();
  }

  function stage6BishopCreateDrainFromVertices(vertices){
    ensureStage6State();
    const outcome = seepslopeCreateDrainFromVertices(getActive().stage6.bishop, vertices, {
      model: () => getActive().stage6Cache?.bishopModel || stage6BishopCurrentModel() || {}
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
    return seepslopeSelectedCustomRegion(getActive()?.stage6?.bishop);
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
    return seepslopeInvalidateSeepage(getActive().stage6.bishop, {message, keepMesh, preserveSolvedState});
  }

  function stage6BishopCurrentSeepageBoundary(model){
    const boundary = buildSeepageOuterBoundary(model);
    getActive().stage6Cache.bishopSeepageBoundary = boundary;
    return boundary;
  }

  function stage6BishopSelectedBoundaryEdge(model){
    const seepage = getActive().stage6?.bishop?.seepage;
    const boundary = getActive().stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model);
    return (boundary || []).find((edge)=>edge.edgeKey === seepage?.selectedEdgeKey) || null;
  }

  function stage6BishopHoveredSeepageEdge(model){
    const bishop = getActive()?.stage6?.bishop;
    if(!bishop || bishop.tool !== 'seepageBc' || !stage6BishopCanvasState.hoverWorld) return null;
    const boundary = getActive().stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model);
    return pickSeepageBoundaryEdge(boundary, stage6BishopCanvasState.hoverWorld, stage6BishopSnapToleranceWorld())?.edge || null;
  }

  function stage6BishopSeepageBcForEdge(edgeKey){
    return (getActive().stage6?.bishop?.seepage?.bcs || []).find((bc)=>bc.edgeKey === edgeKey) || null;
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
    const seepage = getActive()?.stage6?.bishop?.seepage;
    if(!seepage || !bc) return;
    seepage.lastAppliedBcType = bc.type === 'head' ? 'head' : bc.type === 'seepage-face' ? 'seepage-face' : 'no-flow';
    seepage.lastAppliedBcHead = seepage.lastAppliedBcType === 'head' && Number.isFinite(+bc.head) ? +bc.head : null;
  }

  function stage6BishopAutoApplySeepagePreset(edge){
    const seepage = getActive()?.stage6?.bishop?.seepage;
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
    cache: () => (getActive().stage6Cache ||= {})
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
    currentAnalysisType: () => getActive()?.stage6?.bishop?.deformation?.options?.analysisType,
    ensure: () => ensureStage6State(),
    cache: () => (getActive().stage6Cache ||= {})
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
    const bishop = getActive().stage6.bishop;
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
    const seepage = getActive().stage6.bishop.seepage;
    seepage.selectedEdgeKey = edgeKey || '';
    const model = getActive().stage6Cache?.bishopModel || stage6BishopCurrentModel();
    const boundary = getActive().stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model);
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
    const bishop = getActive().stage6.bishop;
    const model = getActive().stage6Cache?.bishopModel || stage6BishopCurrentModel();
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
    const seepage = getActive().stage6.bishop.seepage;
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
    const seepage = getActive().stage6.bishop.seepage;
    seepage.bcs = (seepage.bcs || []).filter((bc)=>bc.edgeKey !== edgeKey);
    if(seepage.selectedEdgeKey === edgeKey) seepage.selectedBcId = '';
    stage6BishopInvalidateSeepage('Boundary condition removed. Showing the previous result until you rerun.', true, true);
    renderStage6();
  }

  function stage6BishopInvalidateDeformation(message, keepMesh, preserveSolvedState){
    ensureStage6State();
    stage6BishopStopDeformation(true);
    return seepslopeInvalidateDeformation(getActive().stage6.bishop, {message, keepMesh, preserveSolvedState});
  }

  function stage6BishopInvalidate(message){
    ensureStage6State();
    stage6BishopStopSearch(true);
    stage6BishopStopDeformation(true);
    return seepslopeInvalidateBishop(getActive().stage6.bishop, message);
  }

  function stage6BishopInvalidateWallGeometry(message){
    ensureStage6State();
    stage6BishopStopSearch(true);
    stage6BishopStopDeformation(true);
    stage6BishopStopSeepage(true);
    return seepslopeInvalidateWallGeometry(getActive().stage6.bishop, message);
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
    const bishop = getActive().stage6.bishop;
    const layers = stage6WorkingLayers();
    const sync = seepslopeSyncSoilModel(bishop, layers);
    if(sync.changed) seepslopeApplySoilModelPatch(bishop, sync.patch);
    if(sync.invalidation) stage6BishopInvalidate(sync.invalidation.message);
    return layers;
  }

  function stage6BishopCurrentModel(){
    const layers = stage6BishopSyncSoilModel();
    const model = buildBishopModelFromStageLayers(layers, getActive().stage6.bishop);
    getActive().stage6Cache.bishopModel = model;
    stage6BishopSyncSeepageState(model);
    return model;
  }

  function stage6BishopSetSelectedRegion(regionId){
    ensureStage6State();
    seepslopeSetSelectedRegion(getActive().stage6.bishop, regionId);
    renderStage6();
  }

  function stage6BishopCopyCurrentRegionsToCustom(){
    ensureStage6State();
    stage6RememberDetailsState();
    const bishop = getActive().stage6.bishop;
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
    const bishop = getActive().stage6.bishop;
    const model = stage6BishopCurrentModel();
    const regions = model ? stage6BishopDisplayRegions(model) : [];
    if(!regions.length){
      bishop.progress.message = 'Draw terrain and place the active CPT marker (or copy CPT regions) before exporting to DXF.';
      renderStage6();
      return;
    }
    const testid = getActive().meta?.testid || getActive().id || 'section';
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
    const useCustomRegions = seepslopeSetUseCustomRegions(getActive().stage6.bishop, value);
    stage6BishopInvalidate(useCustomRegions ? 'Custom soil polygons enabled; rerun Bishop search.' : 'Reverted to CPT-derived soil polygons; rerun Bishop search.');
    renderStage6();
  }

  function stage6BishopClearCustomRegions(message){
    ensureStage6State();
    seepslopeClearCustomRegions(getActive().stage6.bishop);
    stage6BishopInvalidate(message || 'Custom soil polygons were cleared; Bishop reverted to CPT-derived polygons.');
  }

  function stage6BishopDeleteSelectedRegion(){
    ensureStage6State();
    stage6RememberDetailsState();
    if(!seepslopeDeleteSelectedRegion(getActive().stage6.bishop)) return;
    stage6BishopInvalidate('Custom soil polygon removed; rerun Bishop search.');
    renderStage6();
  }

  function stage6BishopSetSelectedRegionMaterial(materialId){
    ensureStage6State();
    stage6RememberDetailsState();
    if(!seepslopeSetSelectedRegionMaterial(getActive().stage6.bishop, materialId)) return;
    stage6BishopSyncSoilModel();
    stage6BishopInvalidate('Custom soil polygon material updated; rerun Bishop search.');
    renderStage6();
  }

  function stage6BishopSetSelectedRegionCoarseness(value){
    ensureStage6State();
    stage6RememberDetailsState();
    const bishop = getActive().stage6.bishop;
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
    const outcome = seepslopeSplitSelectedRegion(getActive().stage6.bishop, {
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
          const outOfPlaneLength = Math.max(Number(getActive().stage6.bishop.deformation?.options?.outOfPlaneLength) || 10, 0.1);
          stage6BishopSetSurfaceLoadField(target.id, 'totalLoad', (Math.max(Number(value) || 0, 0) * width * outOfPlaneLength));
        } else {
          stage6BishopSetSurfaceLoadField(target.id, field, value);
        }
        return;
      }
      if(!getActive().stage6.bishop.surfaceLoad || typeof getActive().stage6.bishop.surfaceLoad !== 'object'){
        getActive().stage6.bishop.surfaceLoad = {xStart:null, xEnd:null, q:0};
      }
      if(field === 'q') getActive().stage6.bishop.surfaceLoad.q = Math.max(Number(value) || 0, 0);
      else if(field === 'xStart' || field === 'xEnd') getActive().stage6.bishop.surfaceLoad[field] = Number.isFinite(Number(value)) ? Number(value) : null;
      stage6BishopSyncLegacySurfaceLoadMirror(getActive().stage6.bishop);
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
      getActive().stage6.bishop.seepage.options.meshTargetAreaAuto = !isManual;
      nextValue = isManual ? numeric : stage6BishopAutoSeepageMeshTargetArea(getActive().stage6.bishop);
    } else if(path === 'deformation.options.meshTargetArea'){
      const numeric = value === '' || value == null ? null : +value;
      const isManual = Number.isFinite(numeric) && numeric > 0;
      getActive().stage6.bishop.deformation.options.meshTargetAreaAuto = !isManual;
      nextValue = isManual ? numeric : stage6BishopAutoDeformationMeshTargetArea(getActive().stage6.bishop);
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
      getActive().stage6.bishop.seepage.options.meshTargetArea = stage6BishopAutoSeepageMeshTargetArea(getActive().stage6.bishop);
    } else if(path === 'seepage.options.meshTargetAreaAuto' && !(Number(getActive().stage6.bishop.seepage.options.meshTargetArea) > 0)){
      getActive().stage6.bishop.seepage.options.meshTargetArea = stage6BishopAutoSeepageMeshTargetArea(getActive().stage6.bishop);
    }
    if(path === 'deformation.options.meshTargetAreaAuto' && nextValue){
      getActive().stage6.bishop.deformation.options.meshTargetArea = stage6BishopAutoDeformationMeshTargetArea(getActive().stage6.bishop);
    } else if(path === 'deformation.options.meshTargetAreaAuto' && !(Number(getActive().stage6.bishop.deformation.options.meshTargetArea) > 0)){
      getActive().stage6.bishop.deformation.options.meshTargetArea = stage6BishopAutoDeformationMeshTargetArea(getActive().stage6.bishop);
    }
  	  stage6Set(getActive().stage6.bishop, path, nextValue);
    if(path === 'deformation.options.constitutiveModel' && nextValue === 'hardening-soil' && !hardeningSoilUi){
      getActive().stage6.bishop.deformation.options.constitutiveModel = 'mc-plastic';
    }
    if(path === 'deformation.options.loadMode'){
      const load = stage6BishopPrimarySurfaceLoad(false);
      if(load){
        load.loadMode = nextValue === 'total' ? 'total' : 'pressure';
        stage6BishopSyncLegacySurfaceLoadMirror(getActive().stage6.bishop);
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
      getActive().stage6.bishop.deformation.options.solverBackend = canonicalBackend;
      getActive().stage6.bishop.deformation.options.useWasmCpuPipeline = canonicalBackend === 'wasm-cpu';
      getActive().stage6.bishop.deformation.options.useNewGpuPipeline = false;
      getActive().stage6.bishop.deformation.options.gpuPipelineVersion = 'v1';
    }
    if(path === 'deformation.options.analysisType' && nextValue === 'safety-cphi'){
      const currentConstitutiveModel = getActive().stage6.bishop.deformation?.options?.constitutiveModel;
      if(currentConstitutiveModel !== 'mc-plastic' && !(hardeningSoilUi && currentConstitutiveModel === 'hardening-soil')){
        getActive().stage6.bishop.deformation.options.constitutiveModel = 'mc-plastic';
      }
      if(hardeningSoilUi && getActive().stage6.bishop.deformation?.options?.constitutiveModel === 'hardening-soil'){
        getActive().stage6.bishop.deformation.options.solverBackend = 'wasm-cpu';
        getActive().stage6.bishop.deformation.options.useWasmCpuPipeline = true;
        getActive().stage6.bishop.deformation.options.useNewGpuPipeline = false;
      }
    }
    if(path === 'deformation.options.constitutiveModel' && getActive().stage6.bishop.deformation?.options?.constitutiveModel !== 'mc-plastic'){
      if(String(getActive().stage6.bishop.deformation?.options?.geostaticInitializationMethod || '').toLowerCase() === 'gravity-ramp'){
        getActive().stage6.bishop.deformation.options.geostaticInitializationMethod = 'auto';
      }
      // Safety analysis is allowed for the visible production plastic model;
      // any other constitutive model forces the analysis back to plain deformation.
      if(
        !(hardeningSoilUi && getActive().stage6.bishop.deformation?.options?.constitutiveModel === 'hardening-soil') &&
        getActive().stage6.bishop.deformation?.options?.analysisType === 'safety-cphi'
      ){
        getActive().stage6.bishop.deformation.options.analysisType = 'deformation';
      }
      if(hardeningSoilUi && nextValue === 'hardening-soil' && getActive().stage6.bishop.deformation?.options?.analysisType === 'safety-cphi'){
        getActive().stage6.bishop.deformation.options.solverBackend = 'wasm-cpu';
        getActive().stage6.bishop.deformation.options.useWasmCpuPipeline = true;
        getActive().stage6.bishop.deformation.options.useNewGpuPipeline = false;
      }
    }
    if(path.startsWith('lineProbe.') && path !== 'lineProbe.copyMessage' && path !== 'lineProbe.copyTone'){
      getActive().stage6.bishop.lineProbe.copyMessage = '';
      getActive().stage6.bishop.lineProbe.copyTone = '';
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
    getActive().stage6.bishop.workspace = next;
    if(next === 'seepage' && getActive().stage6.bishop.tool === 'terrain'){
      getActive().stage6.bishop.tool = 'seepageBc';
    } else if(next !== 'seepage' && (getActive().stage6.bishop.tool === 'seepageBc' || getActive().stage6.bishop.tool === 'drain')){
      getActive().stage6.bishop.tool = 'edit';
    }
    renderStage6();
  }

  function stage6BishopSetTool(tool){
    ensureStage6State();
    stage6RememberDetailsState();
    if((tool === 'regionSplit' || tool === 'regionHole') && !stage6BishopSelectedCustomRegion()){
      getActive().stage6.bishop.progress.message = `Select a custom polygon first in Edit / pan mode, then choose ${tool === 'regionHole' ? 'Cut hole' : 'Split selected'}.`;
      renderStage6();
      return;
    }
    const prevTool = getActive().stage6.bishop.tool;
    getActive().stage6.bishop.tool = tool;
    if(tool === 'load'){
      getActive().stage6.bishop.selectedSurfaceLoadId = null;
    }
    if(tool !== prevTool && getActive().stage6.bishop.draftKind && getActive().stage6.bishop.draftKind !== tool){
      getActive().stage6.bishop.draft = [];
      getActive().stage6.bishop.draftKind = '';
    }
    if(tool === 'drain'){
      getActive().stage6.bishop.workspace = 'seepage';
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
    const bishop = getActive().stage6.bishop;
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
        getActive().stage6.bishop.progress.message = message;
        renderStage6();
        alert(`${file.name}: ${message}`);
      }
    };
    reader.onerror = ()=>{
      const message = `Error reading ${file.name}`;
      getActive().stage6.bishop.progress.message = message;
      renderStage6();
      alert(message);
    };
    reader.readAsText(file);
  }

  function stage6BishopPopDraftPoint(){
    ensureStage6State();
    if(getActive().stage6.bishop.draft?.length) getActive().stage6.bishop.draft.pop();
    renderStage6();
  }

  function stage6BishopFinishDraft(){
    ensureStage6State();
    const bishop = getActive().stage6.bishop;
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
    getActive().stage6.bishop.measurement = {points:[]};
  }

  function stage6BishopClear(kind){
    ensureStage6State();
    const bishop = getActive().stage6.bishop;
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
    const material = getActive().stage6.bishop.materials?.[index];
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
    const material = getActive().stage6.bishop.materials?.[index];
    if(!material) return;
    if(!STAGE6_BISHOP_EDITABLE_HS_FIELDS.has(field)) return;
    if(!material.hs || typeof material.hs !== 'object') material.hs = {};
    if(field === 'useConsistentTangent'){
      material.hs[field] = value === true || value === 'true' || value === 1 || value === '1';
      if(getActive().stage6.bishop.deformation?.options){
        getActive().stage6.bishop.deformation.options.hsConsistentTangentPromptPending = false;
        getActive().stage6.bishop.deformation.options.hsConsistentTangentMigrationResolved = true;
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
    (getActive().stage6.bishop.materials || []).forEach((material)=>{
      if(!material.hs || typeof material.hs !== 'object') material.hs = {};
      material.hs.useConsistentTangent = next;
    });
    if(getActive().stage6.bishop.deformation?.options){
      getActive().stage6.bishop.deformation.options.hsConsistentTangentPromptPending = false;
      getActive().stage6.bishop.deformation.options.hsConsistentTangentMigrationResolved = true;
    }
    stage6BishopInvalidate('Hardening Soil tangent mode updated; rerun deformation analysis.');
    renderStage6();
  }

  function stage6BishopSetMaterialPermeability(index, field, value){
    ensureStage6State();
    stage6BishopSyncSoilModel();
    const material = getActive().stage6.bishop.materials?.[index];
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
    const material = getActive().stage6.bishop.materials?.[index];
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
    const change = seepslopeSetWallField(getActive().stage6.bishop, index, field, value);
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
    const change = seepslopeSetWallMaterialField(getActive().stage6.bishop, index, field, value);
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
    seepslopeDeleteWall(getActive().stage6.bishop, index);
    stage6BishopInvalidateWallGeometry('Retaining wall removed; rerun Bishop search.');
    renderStage6();
  }

  function stage6BishopSelectWall(wallId){
    ensureStage6State();
    seepslopeSelectWall(getActive().stage6.bishop, wallId, stage6BishopUiState());
    renderStage6();
  }


  function stage6BishopToggleWallMomentOverlay(){
    ensureStage6State();
    const display = getActive().stage6.bishop.deformation.display || (getActive().stage6.bishop.deformation.display = {});
    display.showWallMomentOverlay = display.showWallMomentOverlay !== true;
    renderStage6();
  }

  function stage6BishopOpenAnalysisTab(tab = 'line-probe', wallId = ''){
    ensureStage6State();
    const bishop = getActive().stage6.bishop;
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
    const bishop = getActive().stage6.bishop;
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
  const wallResponse = createWallResponse({ bishop: () => getActive()?.stage6?.bishop });
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
    const bishop = getActive().stage6.bishop;
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
    seepslopeSelectDrain(getActive().stage6.bishop, drainId);
    renderStage6();
  }

  function stage6BishopSetDrainField(index, field, value){
    ensureStage6State();
    stage6RememberDetailsState();
    stage6BishopSyncSoilModel();
    if(!seepslopeSetDrainField(getActive().stage6.bishop, index, field, value)) return;
    const model = stage6BishopCurrentModel();
    getActive().stage6.bishop.seepage.drainValidation = validateDrains(model);
    stage6BishopInvalidateSeepage('Drain settings changed. Showing the previous result until you rerun.', true, true);
    renderStage6();
  }

  function stage6BishopDeleteDrain(index){
    ensureStage6State();
    stage6RememberDetailsState();
    stage6BishopSyncSoilModel();
    seepslopeDeleteDrain(getActive().stage6.bishop, index);
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
    return getActive()?.stage6?.bishop || null;
  }

  /** Apply a run patch to the active block; a no-op when there is no Stage 6 state. */
  function stage6BishopApplyRunPatch(patch){
    const bishop = stage6BishopRunState();
    if(bishop) seepslopeApplyRunPatch(bishop, patch);
    return bishop;
  }

  function stage6BishopStopSeepage(silent){
    stage6BishopWorkers.stop('seepage', {silent, runId:getActive()?.stage6?.bishop?.seepage?.progress?.runId});
    stage6BishopApplyRunPatch(seepslopeStopSeepagePatch(stage6BishopRunState(), silent));
  }

  function stage6BishopStopDeformation(silent){
    stage6BishopWorkers.stop('deformation', {silent, runId:getActive()?.stage6?.bishop?.deformation?.progress?.runId});
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
    const bishop = getActive().stage6.bishop;
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
    const bishop = getActive().stage6.bishop;
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
    const bishop = getActive().stage6.bishop;
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
    const results = getActive().stage6.bishop.results?.allResults || [];
    getActive().stage6.bishop.selectedResult = Math.min(Math.max(+index || 0, 0), Math.max(results.length-1, 0));
    renderStage6();
  }

  function stage6BishopSelectedResult(){
    const results = getActive().stage6?.bishop?.results?.allResults || [];
    if(!results.length) return null;
    const index = Math.min(Math.max(getActive().stage6.bishop.selectedResult || 0, 0), results.length-1);
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
    return seepslopeRunningMessage(getActive().stage6?.bishop);
  }

  function stage6BishopReadyMessage(runReady){
    return seepslopeReadyMessage(getActive().stage6?.bishop, runReady);
  }

  function stage6BishopModeMeta(){
    return seepslopeModeMeta(getActive().stage6.bishop);
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
    return seepslopeWallInfoPanelHtml(getActive().stage6?.bishop, SEEPSLOPE_PANELS_ENV);
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
    hardeningSoilUi:hardeningSoilUi,
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
      strengthSet:()=>getActive().stage6.bishop.strengthSet,
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
    return seepslopeBuildLineProbe(getActive()?.stage6?.bishop, workspace, measurementMetrics, SEEPSLOPE_PROBE_ENV);
  }

  async function stage6BishopCopyLineProbeData(){
    ensureStage6State();
    const bishop = getActive().stage6.bishop;
    const workspace = bishop.workspace === 'seepage' ? 'seepage' : bishop.workspace === 'deformation' ? 'deformation' : 'stability';
    const measurementMetrics = stage6BishopMeasurementMetrics(bishop.measurement?.points || []);
    const lineProbe = stage6BishopBuildLineProbe(workspace, measurementMetrics);
    getActive().stage6Cache.bishopLineProbe = lineProbe;
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
    return seepslopeDisplayRegions(model, getActive()?.stage6?.bishop);
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
    return seepslopeBoundaryPickToleranceWorld(getActive()?.stage6?.bishop?.viewport);
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
    seepageBoundary:(model)=>getActive().stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model),
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
    const bishop = getActive().stage6.bishop;
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
      model:()=>getActive().stage6Cache.bishopModel || stage6BishopCurrentModel(),
      seepageBoundary:(model)=>getActive().stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model),
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
      <div>${stage6EscAttr(stage6BishopSurfaceLoadSummary(load, getActive().stage6.bishop.workspace))}</div>
      <div style="color:var(--tx2);margin-top:4px">Click to edit · drag endpoints when selected</div>
    `,
      tooltipForWall:(hoveredWall)=>{
        const hoveredWallResult = stage6BishopWallResultForId(hoveredWall.id);
        const hoveredWallMeta = hoveredWallResult
          ? stage6BishopWallQuantityStats(hoveredWallResult, stage6BishopWallOverlayQuantity())
          : null;
        const wallIndex = (getActive().stage6.bishop.walls || []).findIndex((wall)=>wall.id === hoveredWall.id);
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
    const model = getActive().stage6Cache.bishopModel || stage6BishopCurrentModel();
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
    return seepslopeScreenToWorldFromClient(canvas.getBoundingClientRect(), clientX, clientY, getActive().stage6.bishop.viewport);
  }

  function stage6BishopWorldToScreen(pt){
    return seepslopeWorldToScreen(pt, getActive().stage6.bishop.viewport);
  }

  function stage6BishopSnapToleranceWorld(){
    return seepslopeSnapToleranceWorld(getActive()?.stage6?.bishop?.viewport);
  }

  function stage6BishopCurrentDragKey(){
    return seepslopeCurrentDragKey(stage6BishopCanvasState.pointerDrag);
  }

  function stage6BishopSnapPointKey(kind, index, regionId){
    return seepslopeSnapPointKey(kind, index, regionId);
  }

  function stage6BishopCollectSnapPoints(){
    return seepslopeCollectSnapPoints(getActive().stage6.bishop, seepslopeCanvasExcludeKey);
  }

  function stage6BishopNearestPointSnap(pt, mode){
    const bishop = getActive().stage6.bishop;
    return seepslopeNearestPointSnap(pt, mode, bishop, bishop.viewport, seepslopeCanvasExcludeKey);
  }

  function stage6BishopSnapWorldPoint(pt, mode){
    const bishop = getActive().stage6.bishop;
    return seepslopeSnapWorldPoint(pt, mode, bishop, bishop.viewport, seepslopeCanvasExcludeKey);
  }

  function stage6BishopCanvasWorldBounds(model){
    return seepslopeCanvasWorldBounds(getActive().stage6.bishop, model);
  }

  function fitStage6BishopViewport(){
    ensureStage6State();
    const canvas = document.getElementById('stage6BishopCanvas');
    if(!canvas) return;
    const model = stage6BishopCurrentModel();
    const rect = canvas.getBoundingClientRect();
    const bounds = stage6BishopCanvasWorldBounds(model);
    Object.assign(getActive().stage6.bishop.viewport, seepslopeFitViewport(bounds, rect.width, rect.height));
    stage6BishopDrawCanvas();
  }

  function stage6BishopAutoFitViewportIfNeeded(){
    if(!getActive().stage6.bishop.viewport.fitted) fitStage6BishopViewport();
  }

  function stage6BishopNearestHandle(canvas, clientX, clientY){
    const bishop = getActive().stage6.bishop;
    return seepslopeNearestHandle(bishop, bishop.viewport, canvas.getBoundingClientRect(), clientX, clientY, stage6BishopSelectedCustomRegion);
  }

  function stage6BishopPickSurfaceLoadAtWorld(world){
    const bishop = getActive().stage6.bishop;
    return seepslopePickSurfaceLoadAtWorld(bishop, world, bishop.viewport);
  }

  function stage6BishopPickWallAtWorld(world){
    const bishop = getActive().stage6.bishop;
    return seepslopePickWallAtWorld(bishop, world, bishop.viewport);
  }

  function stage6BishopCommitDrawPoint(canvas, world){
    ensureStage6State();
    const bishop = getActive().stage6.bishop;
    return seepslopeCommitDrawPoint(bishop, world, bishop.viewport, seepslopeCanvasEnv(canvas), seepslopeCanvasExcludeKey);
  }

  function stage6BishopCompleteCurrentActionAt(world){
    ensureStage6State();
    const bishop = getActive().stage6.bishop;
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
    const bishop = getActive().stage6.bishop;
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

    const bishop = getActive().stage6.bishop;
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
    getActive().stage6Cache.bishopModel = model;

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


  // ───────────────────── seepslope/panels façades (refactor step 9f / PR 18f) ─────────────────────
  // SEEPSLOPE_PANELS_ENV is the host half of the panels package: the details memory, the seepage
  // boundary and its selection, the two contour catalogues, the wall-result readers, the Stage 4
  // depth and the two feature flags — every one of them a region step 9f must not touch (map §2.11).
  // The package imports everything the earlier steps already own (seepslope/{state,geometry,run,probe},
  // core/format, seepage/{material,drains}, wall-geometry) directly, so nothing pure is hooked here.
  const SEEPSLOPE_PANELS_ENV = {
    hardeningSoilUi,
    STAGE6_WALL_RESPONSE_QUANTITIES,
    stage6DetailsOpen,
    stage6MaxDepth,
    stage6BishopUiState,
    // the volatile Stage 6 cache and the active block — the two `S` reads the prelude made
    cachedSeepageBoundary: ()=>getActive().stage6Cache?.bishopSeepageBoundary,
    stage6ActiveBishop: ()=>getActive().stage6.bishop,
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
    const bishop = getActive().stage6.bishop;
    const bishopUi = stage6BishopUiState();
    const model = stage6BishopCurrentModel();
    const modeMeta = stage6BishopModeMeta();
    const selected = stage6BishopSelectedResult();
    stage6BishopMigrateSurfaceLoadsShape(bishop);
    const vm = seepslopeBuildPanelsViewModel({bishop, bishopUi, model, modeMeta, selected}, SEEPSLOPE_PANELS_ENV);
    getActive().stage6Cache.bishopLineProbe = vm.lineProbe;
    return seepslopeBishopAppHtml(vm, SEEPSLOPE_PANELS_ENV);
  }


  function buildStage6BishopLineProbeChart(){
    const canvas = stage6DestroyChart('stage6BishopLineProbeChart');
    const lineProbe = getActive().stage6Cache?.bishopLineProbe;
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
        const model=buildBishopModelFromStageLayers(stage6WorkingLayers(), getActive().stage6.bishop);
        getActive().stage6Cache.bishopModel=model;
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
    const bishop = getActive().stage6.bishop;
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
    const bishop = getActive().stage6.bishop;
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
    return seepslopeBishopWorkspaceCapture(getActive(), stage7CaptureHost())(workspace);
  }

  /* Everything the pure builder used to reach through this module's closure, named
     (report/deps.js): the model-parameter wrappers over the active CPT, the Stage 6 state
     normaliser, the host half of the automatic workspace capture (only called when an annex
     exists and no manual capture is stored — same conditional as before) and the Seep/Slope
     helpers that move with the seepslope/ package in step 9. */

  return {
    stage6BishopToggleSettingsPanel, stage6BishopToggleSettingsWidth, stage6BishopToggleToolRail,
    stage6BishopToggleCanvasTools, stage6BishopSetCanvasPanel, stage6BishopSheetDetails,
    stage6BishopSetCanvasSheet, stage6BishopOpenSettingsDetail, stage6BishopSyncLegacySurfaceLoadMirror,
    stage6BishopSelectedSurfaceLoad, stage6BishopPrimarySurfaceLoad, stage6BishopEffectiveSurfaceLoadQ,
    stage6BishopSurfaceLoadSummary, stage6BishopActiveSurfaceLoads, stage6BishopSetSurfaceLoadField,
    stage6BishopSelectSurfaceLoad, stage6BishopDeleteSurfaceLoad, stage6BishopCreateSurfaceLoadFromZone,
    stage6BishopDefaultPassiveSide, stage6BishopWallId, stage6BishopDrainId,
    stage6BishopCreateDrainFromVertices, stage6BishopRegionId, stage6BishopSelectedCustomRegion,
    stage6BishopInvalidateSeepage, stage6BishopCurrentSeepageBoundary, stage6BishopSelectedBoundaryEdge,
    stage6BishopHoveredSeepageEdge, stage6BishopSeepageBcForEdge, stage6BishopSeepageEdgeLabel,
    stage6BishopSeepageBcTypeLabel, stage6BishopRememberSeepageBcPreset, stage6BishopAutoApplySeepagePreset,
    stage6BishopSyncSeepageState, stage6BishopSelectSeepageBoundary, stage6BishopSetSeepageBcType,
    stage6BishopSetSeepageBcHead, stage6BishopDeleteSeepageBc, stage6BishopInvalidateDeformation,
    stage6BishopInvalidate, stage6BishopInvalidateWallGeometry, stage6BishopSyncSoilModel,
    stage6BishopCurrentModel, stage6BishopSetSelectedRegion, stage6BishopCopyCurrentRegionsToCustom,
    stage6BishopExportRegionsDxf, stage6BishopSetUseCustomRegions, stage6BishopClearCustomRegions,
    stage6BishopDeleteSelectedRegion, stage6BishopSetSelectedRegionMaterial, stage6BishopSetSelectedRegionCoarseness,
    stage6BishopCommitPendingSelectedRegionCoarseness, stage6BishopSplitSelectedRegion, stage6BishopSetField,
    stage6BishopSetWorkspace, stage6BishopSetTool, stage6BishopTriggerDxfImport,
    stage6BishopApplyImportedTerrain, stage6BishopImportDxf, stage6BishopPopDraftPoint,
    stage6BishopFinishDraft, stage6BishopClearMeasurement, stage6BishopClear,
    stage6BishopSetMaterialField, stage6BishopSetMaterialHsField, stage6BishopResolveHsConsistentTangentMigration,
    stage6BishopSetMaterialPermeability, stage6BishopResetMaterialPermeability, stage6BishopSetWallField,
    stage6BishopSetWallMaterialField, stage6BishopDeleteWall, stage6BishopSelectWall,
    stage6BishopToggleWallMomentOverlay, stage6BishopOpenAnalysisTab, stage6BishopSetAnalysisTab,
    stage6BishopResolveWallMechanicalActivation, stage6BishopCopyWallData, stage6BishopSelectDrain,
    stage6BishopSetDrainField, stage6BishopDeleteDrain, stage6BishopRunState,
    stage6BishopApplyRunPatch, stage6BishopStopSeepage, stage6BishopStopDeformation,
    stage6BishopStopSearch, stage6BishopUpdateProgressDom, stage6BishopApplyRunStep,
    stage6BishopEnsureWorker, stage6BishopEnsureSeepageWorker, stage6BishopEnsureDeformationWorker,
    stage6BishopRunSearch, stage6BishopRunSeepage, stage6BishopRunDeformation,
    stage6BishopSelectResult, stage6BishopSelectedResult, stage6BishopStrengthSetLabel,
    stage6DepthBandReportHtml, stage6BishopSafetyCurveHtml, stage6BishopSafetyMechanismHtml,
    stage6BishopSeepageTerminationLabel, stage6BishopResultMethodLabel, stage6BishopRunningMessage,
    stage6BishopReadyMessage, stage6BishopModeMeta, stage6BishopToolIcon,
    stage6BishopCanvasToolButton, stage6BishopWallMechanicalLabel, stage6BishopPartialLoadBadgeHtml,
    stage6BishopWallInfoPanelHtml, stage6BishopRenderWallChart, buildStage6BishopWallCharts,
    stage6BishopCanvasToolRailHtml, stage6BishopTooltipHtml, stage6BishopLineProbeOptions,
    stage6BishopLineProbeMeta, stage6CopyTextFallback, stage6CopyTextToClipboard,
    stage6BishopBuildLineProbe, stage6BishopCopyLineProbeData, stage6BishopDisplayRegions,
    stage6BishopBoundaryPickToleranceWorld, stage6BishopPickRegionBoundaryPoint, seepslopeCanvasCtx,
    seepslopeCanvasEnv, seepslopeCanvasTooltipEnv, stage6BishopHideHoverDom,
    stage6BishopUpdateHoverDom, stage6BishopScreenToWorld, stage6BishopWorldToScreen,
    stage6BishopSnapToleranceWorld, stage6BishopCurrentDragKey, stage6BishopSnapPointKey,
    stage6BishopCollectSnapPoints, stage6BishopNearestPointSnap, stage6BishopSnapWorldPoint,
    stage6BishopCanvasWorldBounds, fitStage6BishopViewport, stage6BishopAutoFitViewportIfNeeded,
    stage6BishopNearestHandle, stage6BishopPickSurfaceLoadAtWorld, stage6BishopPickWallAtWorld,
    stage6BishopCommitDrawPoint, stage6BishopCompleteCurrentActionAt, stage6BishopPointerDown,
    stage6BishopPointerMove, stage6BishopPointerUp, stage6BishopPointerLeave,
    stage6BishopWheel, seepslopeApplyPointerEffects, stage6BishopDrawGrid,
    stage6BishopDrawCanvas, initStage6BishopCanvas, renderStage6BishopApp,
    buildStage6BishopLineProbeChart, stage7OffscreenCanvas, stage6BishopCanvasBox,
    stage7CaptureHost, stage7CaptureCanvasImage, stage7CaptureWorkspaceView,
    stage7ClearWorkspaceCapture, stage7CaptureBishopWorkspaceView, stage6BishopWorkers,
    stage6BishopCanvasState, seepageContours, deformationContours,
    STAGE6_BISHOP_EDITABLE_HS_FIELDS, wallResponse, SEEPSLOPE_PROBE_ENV,
    SEEPSLOPE_CANVAS_ENV, seepslopeCanvasExcludeKey, SEEPSLOPE_PANELS_ENV,
    stage6BishopSeepageHeadColor, stage6BishopSeepageContourMeta, stage6BishopSeepageContourOptions,
    stage6BishopSeepageCriticalGradient, stage6BishopSeepageHydraulicFs, stage6BishopSeepageElementContourValue,
    stage6BishopSeepageContourValue, stage6BishopSeepageContourModeIsSigned, stage6BishopSeepageContourStats,
    stage6BishopSeepageContourNodalValues, stage6BishopSeepageContourRgb, stage6BishopSeepageContourColor,
    stage6BishopSeepageContourLineColor, stage6BishopSeepageContourLegendGradient, stage6BishopSeepageContourLegendTicks,
    stage6BishopSeepageContourLegendValue, stage6BishopSeepageContourLevels, stage6BishopSeepageContourDerived,
    stage6BishopNormalizedDeformationAnalysisType, stage6BishopDeformationQuantityIds, stage6BishopDeformationContourMeta,
    stage6BishopDeformationContourOptions, stage6BishopDeformationVectorMode, stage6BishopT6VisualSubtriangles,
    stage6BishopDeformationPlasticPointSets, stage6BishopDeformationFiniteScalar, stage6BishopDeformationFiniteScalarOrNull,
    stage6BishopDeformationElementEtaMc, stage6BishopAverageFiniteValues, stage6BishopDeformationCellTriangleIndices,
    stage6BishopDeformationCellNodeIds, stage6BishopDeformationElementContourValue, stage6BishopDeformationContourValue,
    stage6BishopDeformationContourModeIsSigned, stage6BishopDeformationContourStats, stage6BishopDeformationContourNodalValues,
    stage6BishopDeformationVisualContourMesh, stage6BishopDeformationContourRgb, stage6BishopDeformationContourColor,
    stage6BishopDeformationContourLineColor, stage6BishopDeformationContourLegendGradient, stage6BishopDeformationContourLegendTicks,
    stage6BishopDeformationContourLegendValue, stage6BishopDeformationContourFlatTolerance, stage6BishopDeformationContourLevels,
    stage6BishopDeformationContourDerived, STAGE6_WALL_RESPONSE_QUANTITIES, stage6BishopWallResultSeries,
    stage6BishopWallResponseMeta, stage6BishopWallOverlayQuantity, stage6BishopWallQuantitySeries,
    stage6BishopWallQuantityStats, stage6BishopWallQuantityFormat, stage6BishopCssColorWithAlpha,
    stage6BishopContrastingTextColor, stage6BishopWallNodeValuesForOverlay, stage6BishopWallResultIsStale,
    stage6BishopWallResultForId, stage6BishopSelectedWallResult, stage6BishopAnalysisWallId
  };
}
