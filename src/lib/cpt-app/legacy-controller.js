// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { eurocodeEntryMatches } from './eurocode-tabel3.js';
import { DEFAULT_ASSUMED_RF } from './classification-core.js';

import {
  cleanupStage7Payloads,
  saveStage7Payload
} from './report-storage';
import { SOIL_CLASS_NAMES } from './soil-styles';

import { installRetainingApp } from './retaining/retaining-ui.js';
import { installStratigraphyApp } from './stratigraphy/index.js';

import { installProjectIO } from './project-io/index.js';
// Transient feedback (design §3.15): an `alert()` the engineer can only acknowledge becomes a toast.
// The guards whose text a golden locks — the export / Stage 7 preconditions and the PLAXIS nu note,
// which gates a download that then proceeds — deliberately keep `alert()`; see worklog 25 §3.
import { toast } from '../styles/toast.ts';

import { readCssToken } from './core/css-tokens.js';

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
import { installStage6App } from './stage6/index.js';
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
  resolvedSeepageMeshTargetArea as stage6BishopResolvedSeepageMeshTargetArea,
  drainGatingLabel as stage6BishopDrainGatingLabel
} from './seepslope/state/index.js';
// Seep / Slope model package (refactor step 9b / PR 18b, src/lib/cpt-app/seepslope/model/): the
// soil-model sync as a pure patch of the bishop block and the result invalidation as pure state
// transitions; the façades below (stage6BishopSyncSoilModel, stage6BishopInvalidate*) keep the
// monolith names, apply the patch to `S.stage6.bishop` and terminate the workers.

// Seep / Slope run package (refactor step 9c / PR 18c, src/lib/cpt-app/seepslope/run/): each of
// the three runs is a pure request builder (state → worker message) plus a pure result reducer
// (worker message → state patch, the run-id guard included); the worker lifecycle lives behind
// one `createWorkerAdapter()` instance, so the controller no longer holds worker singletons in
// closure. The run/stop/progress façades below keep the monolith names and own the three host
// halves the package cannot: ensureStage6State(), the DOM, and `S`.

// Seep / Slope geometry package (refactor step 9d / PR 18d, src/lib/cpt-app/seepslope/geometry/):
// the section maths — points and segments, polygons and their validators, boundary picking,
// splitting and hole subtraction, the regions a canvas shows, the shared Measure tool's line.
// Everything here is pure, so the monolith names are import aliases; the three that read `S`, the
// viewport or the results region (TooltipHtml, DisplayRegions, PickRegionBoundaryPoint) are
// façades in the geometry region below. The pointer / snapping / viewport handling that *uses*
// them stays in the controller until step 9e.

// Seep / Slope line probe (refactor step 9d / PR 18d, src/lib/cpt-app/seepslope/probe/): the
// quantity catalogue per workspace, the sampler along the Measure tool's line, and the clipboard
// readout. `lineProbeOptions` / `lineProbeMeta` / `buildLineProbe` take the host `env` of
// SEEPSLOPE_PROBE_ENV (the HS UI flag and the two contour catalogues that are not extracted yet),
// so they are façades below; the formatters and the clipboard text are pure.

// Seep / Slope canvas package (refactor step 9e / PR 18e, src/lib/cpt-app/seepslope/canvas/):
// the viewport (world ↔ screen, fit, zoom / pan, every px → world tolerance), the picking and
// snapping, the {down, move, up, cancel} pointer state machine, the pure view model and the
// fourteen `draw/*` layers behind one sequencer. Every monolith name below survives as a façade in
// the canvas region: they own `S`, the canvas element, the device-pixel ratio, the model cache and
// the tooltip DOM — the package owns everything else, and reads none of them.

// Seep / Slope panels package (refactor step 9f / PR 18f, src/lib/cpt-app/seepslope/panels/):
// the 2 392-line `renderStage6BishopApp` split by `data-st6details` group — one module per
// collapsible section, plus the tool rail, the eight canvas sheets, the results panel, the header
// and a layout.js that composes them in exactly the monolith's order over one pure view model.
// Every module is a pure string builder over `(vm, env)`; the façades in the panel region below
// keep the monolith names and own the host halves — `S`, the volatile Stage 6 cache and the
// regions step 9f must not touch (SEEPSLOPE_PANELS_ENV).

// Seep / Slope report package (refactor step 9g / PR 18g, src/lib/cpt-app/seepslope/report/):
// the Stage 7 workspace screenshot, rasterised on an offscreen canvas from a view model built for
// the target workspace. It replaces the app / workspace switch + double re-render of
// 01-monolith-map.md §3.4 #10; the façades in the Stage 7 region below own the host halves — the
// canvas factory, the frame box, the section model and the theme.
import { installSeepSlopeApp } from './seepslope/index.js';

/* ════════════════════════════════
   STATE
════════════════════════════════ */
let __legacyControllerInitialized = false;
let __legacyControllerHashBound = false;
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
/* ════════════════════════════════
   STAGE 6 — SEEP / SLOPE  (src/lib/cpt-app/seepslope/, PR 20 / refactor step 10)
   Steps 9a-9g carved the domain into seepslope/{state, model, run, geometry, probe, canvas,
   panels, report, contours, wall}; PR 20 moved the host half that was left — the active CPT, the
   DOM, the three workers, the canvas element, the volatile model cache and every handler that
   ties a state write to a re-render — into seepslope/host.js. The names below are that install's
   members, kept as module bindings so the inline `on*=` attributes, the Svelte bridge and the
   Node verifiers still resolve them here.
════════════════════════════════ */
const seepslopeApp = installSeepSlopeApp({
  document,
  getActive: () => S,
  hardeningSoilUi: STAGE6_ENABLE_HARDENING_SOIL_UI,
  ensureStage6State,
  renderStage6,
  stage6RememberDetailsState,
  stage6DetailsOpen,
  stage6SetDetailsOpen,
  stage6BishopUiState,
  stage6WorkingLayers,
  stage6MaxDepth,
  stage6Defaults
});
const {
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
} = seepslopeApp;

function stage6BishopEnabled(){
  return true;
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
