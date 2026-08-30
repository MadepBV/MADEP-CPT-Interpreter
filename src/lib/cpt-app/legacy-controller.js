// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// The CPT app's composition root (01-monolith-map.md §6.1 row `host/legacy-controller.js`,
// §6.2 step 10; PLAN PR 20). It is not the monolith any more: the 18 503 lines of v0.5.3 became
// the packages under src/lib/cpt-app/ over PRs 4-19, and what is left here is the wiring —
//
//   1. the feature flags,
//   2. `PROJECT`, `newCptState()` and the single `let S` that points at the active CPT,
//   3. one `install<Pkg>(ctx)` call per package, in dependency order,
//   4. the monolith names each install answers to, kept as module bindings,
//   5. `handlers` — the union of the packages' `handlers` maps, the published window surface,
//   6. `initLegacyController()`: publish, bind the stage rail / dropzone / `#bishop` hash, render.
//
// ── The shared ctx ──────────────────────────────────────────────────────────────────────────
// Every install is handed a subset of the same context. There is no shared object literal on
// purpose — each package documents the members it needs in its own index.js — but the members
// always mean the same thing:
//
//   document                        the live document (packages never reach for the global)
//   window                          the live window, or null under SSR / the Node harness
//   getProject()                    → PROJECT
//   getActive() / getState()        → S, the active CPT; the ONLY way a package reads it
//   setActive(idx)                  the one re-point of S (core/state.js setActiveCpt)
//   newCptState(id)                 a fresh per-CPT state object
//   toast(message, opts) / alert(message) / confirm(message)
//   renderStage6() / ensureStage6State() / stage6WorkingLayers() / stage6MaxDepth() /
//   stage6DetailsOpen(key) / …      the Stage 6 shell contract (stage6/index.js)
//   renderLayers() / renderModel() / runClass() / detectLayers() / renderSection() / …
//                                   the cross-stage re-entry points, always as a hook
//
// Every hook is an arrow: nothing is *called* while the module evaluates, so the installs may
// reference each other in any order. The one hard ordering constraint is `stage6App`, whose
// `defaults()` runs inside `newCptState()` and therefore has to be installed above `PROJECT`.

import { DEFAULT_ASSUMED_RF } from './classification-core.js';

import { installRetainingApp } from './retaining/retaining-ui.js';
import { installStratigraphyApp } from './stratigraphy/index.js';

import { installProjectIO } from './project-io/index.js';
// Transient feedback (design §3.15): an `alert()` the engineer can only acknowledge becomes a toast.
// The guards whose text a golden locks — the export / Stage 7 preconditions and the PLAXIS nu note,
// which gates a download that then proceeds — deliberately keep `alert()`; see worklog 25 §3.
import { toast } from '../styles/toast.ts';

import { readCssToken } from './core/css-tokens.js';

import { installLoadApp } from './load/index.js';
import { installExportApp } from './export/index.js';
import { installReportApp } from './report/index.js';
import {
  cptModelCtx,
  hsParams as hsParamsPure,
  khParams as khParamsPure,
  installModelParamsApp
} from './model-params/index.js';
import { installClassificationApp } from './classification/index.js';
import { installLayersApp } from './layers/index.js';
import { installStage6App } from './stage6/index.js';
import { installBearingApp } from './bearing/index.js';
import { setActiveCpt } from './core/state.js';
import { installProject } from './project/index.js';
import { installSection } from './section/index.js';
import { installTuningApp } from './tuning/index.js';
import { installPileApp } from './pile/index.js';
import { installSettlementApp } from './settlement/index.js';
import { installDewateringApp } from './dewatering/index.js';
import { installBeamApp } from './beam/index.js';
// Seep / Slope (refactor step 9 / PRs 18a-18g + PR 20): seepslope/{state, model, run, geometry,
// probe, canvas, panels, report, contours, wall} hold the domain, seepslope/host.js the host half
// (the active CPT, the DOM, the three workers, the canvas, the model cache and the handlers that
// tie a state write to a re-render). Two pure helpers are wired straight into report/deps.js.
import {
  resolvedSeepageMeshTargetArea as stage6BishopResolvedSeepageMeshTargetArea,
  drainGatingLabel as stage6BishopDrainGatingLabel
} from './seepslope/state/index.js';
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
// wrappers below keep their names for the published surface and the inline onclick strings; every hook
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
/* What the composition root itself reaches for: the bishop body and its post-render, the three
   worker stops `selectCpt` needs, the Stage 4 → Stage 6 quantity catalogue the composed ensure()
   calls back into, the Stage 7 capture and the four labels report/deps.js is fed. */
const {
  stage6BishopSeepageEdgeLabel, stage6BishopSeepageBcTypeLabel, stage6BishopInvalidate,
  stage6BishopSyncSoilModel, stage6BishopStopSeepage, stage6BishopStopDeformation,
  stage6BishopStopSearch, stage6BishopResultMethodLabel, buildStage6BishopWallCharts,
  initStage6BishopCanvas, renderStage6BishopApp, buildStage6BishopLineProbeChart,
  stage7CaptureBishopWorkspaceView, SEEPSLOPE_PROBE_ENV, SEEPSLOPE_PANELS_ENV,
  stage6BishopDeformationQuantityIds
} = seepslopeApp;

/* The Node-verifier surface. scripts/verify_seepslope_{geometry,canvas,panels,report}.mjs each
   materialise a copy of this file with an appended `export { … }` block and compare it, name by
   name, against the same block appended to the pre-refactor controller (`--base integration-r`).
   The 67 names below are the ones that comparison needs and the root does not otherwise use, so
   they are bound here — and only here — to keep the parity gate running against the monolith. */
const {
  stage6BishopSelectedCustomRegion, stage6BishopCurrentSeepageBoundary, stage6BishopSelectedBoundaryEdge,
  stage6BishopCurrentModel, stage6BishopSetSelectedRegion, stage6BishopSplitSelectedRegion,
  stage6BishopClearMeasurement, stage6BishopSelectedResult, stage6BishopStrengthSetLabel,
  stage6DepthBandReportHtml, stage6BishopSafetyCurveHtml, stage6BishopSafetyMechanismHtml,
  stage6BishopSeepageTerminationLabel, stage6BishopReadyMessage, stage6BishopModeMeta,
  stage6BishopToolIcon, stage6BishopCanvasToolButton, stage6BishopWallMechanicalLabel,
  stage6BishopPartialLoadBadgeHtml, stage6BishopWallInfoPanelHtml, stage6BishopCanvasToolRailHtml,
  stage6BishopTooltipHtml, stage6BishopLineProbeOptions, stage6BishopLineProbeMeta,
  stage6CopyTextFallback, stage6CopyTextToClipboard, stage6BishopBuildLineProbe,
  stage6BishopCopyLineProbeData, stage6BishopDisplayRegions, stage6BishopBoundaryPickToleranceWorld,
  stage6BishopPickRegionBoundaryPoint, stage6BishopHideHoverDom, stage6BishopUpdateHoverDom,
  stage6BishopScreenToWorld, stage6BishopWorldToScreen, stage6BishopSnapToleranceWorld,
  stage6BishopCurrentDragKey, stage6BishopSnapPointKey, stage6BishopCollectSnapPoints,
  stage6BishopNearestPointSnap, stage6BishopSnapWorldPoint, stage6BishopCanvasWorldBounds,
  stage6BishopAutoFitViewportIfNeeded, stage6BishopNearestHandle, stage6BishopPickSurfaceLoadAtWorld,
  stage6BishopPickWallAtWorld, stage6BishopCommitDrawPoint, stage6BishopCompleteCurrentActionAt,
  stage6BishopPointerDown, stage6BishopPointerMove, stage6BishopPointerUp,
  stage6BishopPointerLeave, stage6BishopWheel, stage6BishopDrawGrid,
  stage6BishopDrawCanvas, stage7CaptureCanvasImage, stage7CaptureWorkspaceView,
  stage7ClearWorkspaceCapture, stage6BishopCanvasState, SEEPSLOPE_CANVAS_ENV,
  stage6BishopSeepageHydraulicFs, stage6BishopNormalizedDeformationAnalysisType, stage6BishopDeformationContourMeta,
  stage6BishopDeformationContourOptions, stage6BishopWallOverlayQuantity, stage6BishopWallResultForId,
  stage6BishopAnalysisWallId
} = seepslopeApp;

function stage6BishopEnabled(){
  return true;
}

/* ════════════════════════════════
   STAGE 4 EXPORTS + STAGE 7 REPORT  (src/lib/cpt-app/{export,report}/, PR 20 / step 10)
   The three download buttons and the Stage 7 payload / report window. The `deps` the pure
   payload builder is fed are named in report/index.js; the Seep/Slope half of them comes from
   the installed seepslope/ app.
════════════════════════════════ */
const exportApp = installExportApp({
  document,
  getActive: () => S,
  modelCtx: () => modelCtx(),
  alert: (message) => alert(message)
});

const reportApp = installReportApp({
  getProject: () => PROJECT,
  getActive: () => S,
  window: typeof window !== 'undefined' ? window : null,
  alert: (message) => alert(message),
  toast,
  hsParams,
  khParams,
  workingLayers: stage6WorkingLayers,
  ensureStage6State,
  captureBishopWorkspaceView: stage7CaptureBishopWorkspaceView,
  seepslope: {
    resultMethodLabel: stage6BishopResultMethodLabel,
    seepageEdgeLabel: stage6BishopSeepageEdgeLabel,
    seepageBcTypeLabel: stage6BishopSeepageBcTypeLabel,
    drainGatingLabel: stage6BishopDrainGatingLabel,
    resolvedSeepageMeshTargetArea: stage6BishopResolvedSeepageMeshTargetArea
  }
});
const { deps: stage7ControllerDeps, buildStage7Payload, openStage7Report } = reportApp;

/* ════════════════════════════════
   THE PUBLISHED HANDLER SURFACE
   The CPT app's HTML is built as template strings whose inline `on*="name(…)"` attributes
   resolve their callee as a *global* at event time, and `src/lib/cpt-app/ui.ts` `call(name, …)`
   is `window[name](…)` for the Svelte templates. Every package therefore hands the composition
   root a `handlers` map of the names it owns; this object is their union and the only thing
   `initLegacyController()` writes to `window`. `scripts/verify_window_handlers.mjs` loads the
   controller for real and asserts that every inline callee is in it.
════════════════════════════════ */
const handlers = {
  // the project itself
  PROJECT,
  newCptState,
  ...projectApp.handlers,        //  7 — banner, CPT list, phase, stage rail
  ...projectIO.handlers,         //  2 — .madep.json save / load
  // the seven stages
  ...loadApp.handlers,           // 21 — Stage 1
  ...classificationApp.handlers, //  5 — Stage 2
  ...layersApp.handlers,         // 27 — Stage 3
  ...modelParamsApp.handlers,    // 11 — Stage 4
  ...tuningApp.handlers,         // 11 — Stage 5
  ...stage6App.handlers,         //  5 — the Stage 6 shell
  ...bearingApp.handlers,        // 11 — Stage 6 bearing capacity
  ...retainingApp.handlers,      // 12 — Stage 6 retaining walls
  ...seepslopeApp.handlers,      // 54 — Stage 6 Seep / Slope
  ...sectionApp.handlers,        //  4 — the Doorsnede phase
  ...exportApp.handlers,         //  3 — Stage 4 downloads
  ...reportApp.handlers          //  2 — Stage 7
};

export function initLegacyController(){
  if(__legacyControllerInitialized) return ()=>{};
  Object.assign(window, handlers);
  projectApp.bindStageNav();
  bindDropzone();
  projectApp.applyOpeningBishopHash();
  renderBanner();
  if(!__legacyControllerHashBound) __legacyControllerHashBound = projectApp.bindBishopHash();
  __legacyControllerInitialized = true;
  return ()=>{};
}
