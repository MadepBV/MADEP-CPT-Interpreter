// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Stage 6 "Retaining walls" application — shell. Wires the state (wall-state.js), the engine
 * request (request-builder.js), the interactive section (scenes/*, retaining-canvas.js), the
 * input panels (panels/*) and the result views (results/*) together. All calculation logic lives
 * in the pure modules; this file only orchestrates DOM updates and window handlers.
 *
 * Context supplied by the host controller:
 *   getState()        → live CPT state (holds stage6.retwall)
 *   requestRender()   → full re-render of the Stage 6 area
 *   workingLayers()   → Stage 3/4 layer model of the active CPT
 *   getCpt()          → { id, depth[], qc[] (MPa), fs[] (kPa|null), waterTable } for drivability
 *   getProjectMeta()  → { projectName, cptId }
 */
import { runRetainingAnalysis } from './wasm-loader.js';
import { createRetainingCanvas } from './retaining-canvas.js';
import { RETWALL_STYLE } from './retaining-styles.js';
import { WALL_TYPES, isEmbedded, isSoldierPile } from './wall-types.js';
import { defaults, ensure } from './wall-state.js';
import { buildRequest } from './request-builder.js';
import { setCohesionForAll, pruneOverrides, layerKey } from './soil-profile.js';
import { buildEmbeddedScene, applyEmbeddedDrag } from './scenes/embedded-scene.js';
import { buildGravityScene, applyGravityDrag } from './scenes/gravity-scene.js';
import { geometryPanel } from './panels/geometry-panel.js';
import { sectionPanel } from './panels/section-panel.js';
import { soilPanel, backfillPanel } from './panels/soil-panel.js';
import { loadsPanel } from './panels/loads-panel.js';
import { ec7Panel } from './panels/ec7-panel.js';
import { anchorPanel } from './panels/anchor-panel.js';
import { drivabilityPanel, drivabilityView, drawDrivabilityCharts, runDrivability } from './panels/drivability-panel.js';
import { vibrationPanel, vibrationView, drawVibrationCharts, computeVibration } from './panels/vibration-panel.js';
import { computeEmbeddedStructural } from './results/embedded-structural.js';
import { summaryCard } from './results/summary-card.js';
import { checksView } from './results/checks-view.js';
import { branchesView } from './results/branches-view.js';
import { diagramsView, drawDiagramCharts } from './results/diagrams-view.js';
import { structuralView } from './results/structural-view.js';
import { plaxisView } from './results/plaxis-view.js';
import { gravityChecksView } from './results/gravity-results.js';
import { noteView, buildNotePayload, openNote } from './report/note-view.js';
import { esc } from './results/result-kit.js';

const STRUCTURAL_PATHS = new Set(['wallType', 'insitu.mode', 'water.mode', 'loads.berm.enabled', 'settings.riskScheme', 'settings.overdigRule', 'settings.materialOverride.enabled',
  'soldier.resistanceModel', 'sheet.useWpl', 'sheet.sectionId', 'soldier.sectionId', 'sheet.grade', 'soldier.grade', 'drivability.method', 'drivability.vibrator.id', 'drivability.hammer.id',
  'vibration.framework', 'embedded.anchored', 'profile.offset', 'soldier.laggingSpan', 'soldier.tlatConvention']);
const STRING_PATHS = new Set(['water.mode', 'insitu.mode', 'settings.bearingMethod', 'settings.overdigRule', 'settings.da11Mode', 'sheet.sectionId', 'sheet.grade', 'soldier.sectionId', 'soldier.grade',
  'soldier.laggingGrade', 'soldier.laggingSpan', 'soldier.resistanceModel', 'soldier.tlatConvention', 'soldier.tskinK', 'drivability.method', 'drivability.drivingUnit', 'drivability.srdMethod',
  'drivability.vibrator.id', 'drivability.vibrator.source', 'drivability.vibrator.sheet.name', 'drivability.vibrator.sheet.amplitudeConvention', 'drivability.hammer.id', 'drivability.hammer.type', 'vibration.framework', 'vibration.groundCondition', 'vibration.sbr.condition', 'vibration.sbr.measurement',
  'vibration.sbr.vibrationType', 'vibration.sbr.part', 'vibration.din.location', 'vibration.din.duration', 'ui.resultTab', 'ui.diagram', 'ui.branch', 'ui.tlatSet']);

function setPath(obj, path, value) {
  const parts = path.split('.');
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
  o[parts[parts.length - 1]] = value;
}

export function installRetainingApp(ctx) {
  const getRw = () => ctx.getState().stage6.retwall;
  const layers = () => (ctx.workingLayers && ctx.workingLayers()) || [];
  let analysisToken = 0;
  let canvasApi = null, canvasEl = null;
  let lastProfile = null;   // soil profile of the last request (notes, strata) — derived, not persisted

  // ---------------- analysis ----------------
  async function runAnalysis() {
    const rw = getRw();
    const token = ++analysisToken;
    rw.status = 'running';
    let built;
    try { built = buildRequest(rw, layers()); } catch (e) { rw.status = 'error'; rw.error = String(e?.message || e); updateResultsDom(); return; }
    lastProfile = built.profile;
    try {
      const result = await runRetainingAnalysis(built.request);
      if (token !== analysisToken) return;
      rw.result = result; rw.status = 'done'; rw.error = '';
    } catch (e) {
      if (token !== analysisToken) return;
      rw.status = 'error'; rw.error = String(e?.message || e); rw.result = null;
    }
    updateResultsDom();
    drawCanvas();
  }

  function structuralOf(rw) {
    if (!isEmbedded(rw.wallType) || !rw.result) return null;
    try { return computeEmbeddedStructural(rw, rw.result, lastProfile); } catch (e) { console.warn('structural derivation failed', e); return null; }
  }

  // ---------------- canvas ----------------
  function buildScene(rw) {
    return isEmbedded(rw.wallType) ? buildEmbeddedScene(rw, rw.result, layers()) : buildGravityScene(rw, rw.result, layers());
  }
  function ensureCanvas() {
    const canvas = document.getElementById('retwallCanvas');
    if (!canvas) { canvasApi = null; canvasEl = null; return null; }
    if (!canvasApi || canvasEl !== canvas) {
      canvasApi = createRetainingCanvas(canvas, {
        getScene: () => { try { return buildScene(getRw()); } catch (e) { console.warn('scene failed', e); return null; } },
        onDrag: (id, w) => onHandleDrag(id, w),
        onDragEnd: () => { renderInputs(); runAnalysis(); }
      });
      canvasEl = canvas;
      canvasApi.refit();
    }
    return canvasApi;
  }
  function drawCanvas() { const api = ensureCanvas(); if (api) api.render(); }
  let liveTimer = null;
  function onHandleDrag(id, w) {
    const rw = getRw();
    if (id === 'cpt') { rw.cptX = w.x; drawCanvas(); return; }
    const scene = canvasApi ? buildScene(rw) : null;
    const changed = isEmbedded(rw.wallType) ? applyEmbeddedDrag(rw, id, w, scene?._geom) : applyGravityDrag(rw, id, w);
    if (!changed) return;
    drawCanvas();
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { liveTimer = null; runAnalysis(); }, 140);
  }

  // ---------------- rendering ----------------
  function inputsHtml(rw) {
    return [geometryPanel(rw), isEmbedded(rw.wallType) ? sectionPanel(rw) : '', backfillPanel(rw), soilPanel(rw, layers()), loadsPanel(rw), anchorPanel(rw), ec7Panel(rw), drivabilityPanel(rw), isEmbedded(rw.wallType) ? vibrationPanel(rw) : ''].join('');
  }
  function openAccordions() {
    const s = new Set();
    document.querySelectorAll('#retwallInputs details[data-acc][open]').forEach((d) => s.add(d.getAttribute('data-acc')));
    return s;
  }
  // The inputs column is its own scroll container; replacing its HTML would reset it to the top.
  let keepScroll = null;   // { inputs, page } captured before a full re-render, restored in postRender
  function captureScroll() {
    const el = document.getElementById('retwallInputs');
    return { inputs: el ? el.scrollTop : 0, page: typeof window !== 'undefined' ? window.scrollY : 0 };
  }
  function restoreScroll(s) {
    if (!s) return;
    const el = document.getElementById('retwallInputs');
    if (el) el.scrollTop = s.inputs;
    if (typeof window !== 'undefined' && Math.abs(window.scrollY - s.page) > 1) window.scrollTo(window.scrollX, s.page);
  }
  function fullRender() { keepScroll = captureScroll(); ctx.requestRender(); }
  function renderInputs() {
    const el = document.getElementById('retwallInputs');
    if (!el) return;
    const open = openAccordions();
    const scroll = el.scrollTop;
    el.innerHTML = inputsHtml(getRw());
    if (open.size) el.querySelectorAll('details[data-acc]').forEach((d) => { if (open.has(d.getAttribute('data-acc'))) d.setAttribute('open', ''); else d.removeAttribute('open'); });
    el.scrollTop = scroll;
  }
  function resultTabs(rw) {
    const embedded = isEmbedded(rw.wallType);
    const tabs = embedded
      ? [['checks', 'Verifications'], ['branches', 'Design branches'], ['diagrams', 'Diagrams'], ['structural', 'Structural'], ['plaxis', 'PLAXIS 2D'], ['drivability', 'Drivability'], ['vibration', 'Vibration'], ['note', 'Calculation note']]
      : [['checks', 'Verifications'], ['structural', 'Structural'], ['note', 'Calculation note']];
    const cur = tabs.some((t) => t[0] === rw.ui?.resultTab) ? rw.ui.resultTab : 'checks';
    return { tabs, cur };
  }
  function resultBodyHtml(rw) {
    const { cur } = resultTabs(rw);
    const st = structuralOf(rw);
    if (rw.status === 'error' && cur !== 'drivability' && cur !== 'vibration' && cur !== 'note') return `<div class="st6-rw-verdict bad"><span class="st6-rw-verdict-tag">ENGINE ERROR</span><span>${esc(rw.error)}</span></div>`;
    if (!isEmbedded(rw.wallType)) {
      if (cur === 'structural') return structuralView(rw, rw.result, null);
      if (cur === 'note') return noteView(rw);
      return gravityChecksView(rw, rw.result);
    }
    switch (cur) {
      case 'branches': return branchesView(rw, rw.result);
      case 'diagrams': return diagramsView(rw, rw.result);
      case 'structural': return structuralView(rw, rw.result, st);
      case 'plaxis': return plaxisView(rw, rw.result, st);
      case 'drivability': return drivabilityView(rw);
      case 'vibration': return vibrationView(rw);
      case 'note': return noteView(rw);
      default: return checksView(rw, rw.result, st);
    }
  }
  function drawResultCharts(rw) {
    const { cur } = resultTabs(rw);
    try {
      if (cur === 'diagrams' && rw.result?.branches) drawDiagramCharts(rw, rw.result);
      if (cur === 'drivability') drawDrivabilityCharts(rw);
      if (cur === 'vibration') drawVibrationCharts(rw);
    } catch (e) { console.warn('chart failed', e); }
  }
  function updateResultsDom() {
    const rw = getRw();
    const sum = document.getElementById('retwallSummary');
    if (sum) sum.innerHTML = summaryCard(rw, rw.result, structuralOf(rw));
    const tabsEl = document.getElementById('retwallResultTabs');
    if (tabsEl) tabsEl.innerHTML = tabsHtml(rw);
    const body = document.getElementById('retwallResultBody');
    if (body) body.innerHTML = resultBodyHtml(rw);
    requestAnimationFrame(() => drawResultCharts(rw));
  }
  function tabsHtml(rw) {
    const { tabs, cur } = resultTabs(rw);
    return tabs.map(([id, label]) => `<button type="button" class="st6-rw-rtab ${id === cur ? 'sel' : ''}" onclick="retwallSet('ui.resultTab','${id}')">${label}</button>`).join('');
  }

  function renderBody() {
    const rw = getRw();
    const tabs = WALL_TYPES.map((t) => `<button class="st6-rw-tab ${t.id === rw.wallType ? 'sel' : ''}" onclick="retwallSetType('${t.id}')"><strong>${esc(t.label)}</strong><span>${esc(t.sub)}</span></button>`).join('');
    const embedded = isEmbedded(rw.wallType);
    return `${RETWALL_STYLE}
      <div class="mc2 st6-retwall">
        <div class="st6-rw-head">
          <div>
            <div class="st6-rw-title">Retaining walls — Eurocode 7 (Belgium, DA1)</div>
            <div class="st6-rw-subtitle">Gravity and RC cantilever walls, continuous sheet-pile walls and soldier-pile (Berliner) walls on the interpreted CPT profile: earth pressures per design branch, embedment, section forces, EN 1993 steel checks, PLAXIS 2D input sets, drivability and vibration impact — every intermediate value shown.</div>
          </div>
          <div class="st6-rw-actions"><button type="button" class="btn sm" onclick="retwallOpenNote()">Calculation note ↗</button></div>
        </div>
        <div class="st6-rw-tabs">${tabs}</div>
        <div class="st6-rw-cols">
          <div class="st6-rw-inputs" id="retwallInputs">${inputsHtml(rw)}</div>
          <div class="st6-rw-canvaswrap"><canvas id="retwallCanvas"></canvas>
            <div class="st6-rw-canvastools"><button type="button" title="Fit to view" onclick="retwallFit()">⤢ Fit</button><span class="st6-rw-hint">drag ● handles · scroll to zoom · drag empty to pan</span></div>
            <div class="st6-rw-legend">
              ${embedded ? '<span><i style="background:#8a8f98"></i>steel</span><span><i style="background:rgba(46,111,85,0.5)"></i>passive wedge</span><span><i style="background:rgba(180,60,50,0.35)"></i>over-excavation</span><span><i style="background:#7e50a8"></i>M / <i style="background:#8a620d"></i>V</span>' : '<span><i style="background:#d8b15a"></i>backfill</span><span><i style="background:#9b3a32"></i>σ active</span><span><i style="background:#2e6f55"></i>σ passive</span>'}
              <span><i style="background:#3d6b6a"></i>water</span><span>* = overridden layer</span>
            </div>
          </div>
          <div class="st6-rw-summary" id="retwallSummary">${summaryCard(rw, rw.result, structuralOf(rw))}</div>
        </div>
        <div class="st6-rw-results">
          <div class="st6-rw-rtabs" id="retwallResultTabs">${tabsHtml(rw)}</div>
          <div class="st6-rw-rbody" id="retwallResultBody">${resultBodyHtml(rw)}</div>
        </div>
      </div>`;
  }

  function postRender() {
    if (canvasApi) { try { canvasApi.destroy(); } catch (e) { /* ignore */ } }
    canvasApi = null; canvasEl = null;
    drawCanvas();
    if (canvasApi) canvasApi.refit();
    if (keepScroll) { const s = keepScroll; keepScroll = null; restoreScroll(s); requestAnimationFrame(() => restoreScroll(s)); }
    runAnalysis();
    requestAnimationFrame(() => drawResultCharts(getRw()));
    if (typeof window !== 'undefined') {
      if (postRender._ro) postRender._ro.disconnect();
      const c = document.getElementById('retwallCanvas');
      if (c && typeof ResizeObserver !== 'undefined') {
        postRender._ro = new ResizeObserver(() => { if (canvasApi) canvasApi.render(); drawResultCharts(getRw()); });
        postRender._ro.observe(c.parentElement || c);
      }
    }
  }

  // ---------------- handlers (registered on window by the host) ----------------
  function afterChange(path) {
    const rw = getRw();
    if (path.startsWith('ui.')) { updateResultsDom(); drawCanvas(); return; }
    if (STRUCTURAL_PATHS.has(path)) { fullRender(); return; }
    renderInputs();
    if (path.startsWith('vibration.')) { updateResultsDom(); return; }
    if (path.startsWith('drivability.')) { rw.drivability.result = null; rw.drivability.status = 'idle'; updateResultsDom(); drawCanvas(); return; }
    drawCanvas();
    runAnalysis();
  }
  const handlers = {
    retwallFit() { const api = ensureCanvas(); if (api) api.refit(); },
    retwallSetType(type) {
      const rw = getRw();
      if (!WALL_TYPES.some((t) => t.id === type)) return;
      rw.wallType = type; rw.result = null; rw.status = 'idle';
      if (rw.ui) rw.ui.resultTab = 'checks';
      fullRender();
    },
    retwallSet(path, value) {
      const rw = getRw();
      let v = value;
      if (typeof value !== 'boolean' && !STRING_PATHS.has(path)) { const n = Number(value); v = (value === '' || value == null) ? null : (Number.isFinite(n) ? n : value); }
      if (path === 'embedded.anchorDepth' && Number.isFinite(v)) { const Hret = Number(rw.embedded?.retainedHeight) || 5; v = Math.min(Math.max(v, 0.2), Math.max(Hret - 0.2, 0.2)); }
      if (path === 'drivability.targetDepth' && v == null) v = null;
      setPath(rw, path, v);
      afterChange(path);
    },
    retwallSetBool(path, checked) { setPath(getRw(), path, !!checked); afterChange(path); },
    retwallOverride(key, field, value) {
      const rw = getRw();
      rw.profile.overrides = rw.profile.overrides || {};
      const o = rw.profile.overrides[key] || {};
      if (value === '' || value == null) delete o[field]; else o[field] = Number(value);
      if (Object.keys(o).length) rw.profile.overrides[key] = o; else delete rw.profile.overrides[key];
      afterChange('profile.overrides');
    },
    retwallOverrideDrained(key, value) {
      const rw = getRw();
      rw.profile.overrides = rw.profile.overrides || {};
      const o = rw.profile.overrides[key] || {};
      if (value === 'base') delete o.drained; else o.drained = value === 'drained';
      if (Object.keys(o).length) rw.profile.overrides[key] = o; else delete rw.profile.overrides[key];
      afterChange('profile.overrides');
    },
    retwallSetAllC(value) {
      const rw = getRw();
      const c = Number(value);
      if (!Number.isFinite(c)) return;
      rw.profile.overrides = setCohesionForAll(layers(), rw.profile.overrides, c);
      afterChange('profile.overrides');
    },
    retwallClearOverrides() { getRw().profile.overrides = {}; afterChange('profile.overrides'); },
    retwallCopy(btn) {
      const text = btn?.getAttribute('data-copy') || '';
      const done = () => { const old = btn.textContent; btn.textContent = 'copied ✓'; setTimeout(() => { btn.textContent = old; }, 1200); };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
      else fallbackCopy(text, done);
    },
    retwallRunDrivability() {
      const rw = getRw();
      rw.drivability.status = 'running'; rw.drivability.error = '';
      if (rw.ui) rw.ui.resultTab = 'drivability';
      renderInputs(); updateResultsDom();
      setTimeout(() => {
        try {
          const cpt = ctx.getCpt ? ctx.getCpt() : null;
          rw.drivability.result = runDrivability(rw, cpt, layers());
          rw.drivability.status = rw.drivability.result?.ok ? 'done' : 'idle';
        } catch (e) { rw.drivability.status = 'error'; rw.drivability.error = String(e?.message || e); rw.drivability.result = null; }
        renderInputs(); updateResultsDom(); drawCanvas();
      }, 30);
    },
    retwallCalPoint(i, field, value) {
      const rw = getRw();
      const pts = rw.vibration.calibration.points = rw.vibration.calibration.points || [];
      if (field === 'add') pts.push({ x: 10, v: 5 });
      else if (field === 'remove') pts.splice(i, 1);
      else if (pts[i]) pts[i][field] = Number(value);
      renderInputs(); updateResultsDom();
    },
    retwallOpenNote() {
      const rw = getRw();
      try {
        const payload = buildNotePayload({ rw, layers: layers(), profile: lastProfile, structural: structuralOf(rw), vibration: isEmbedded(rw.wallType) ? computeVibration(rw) : null, meta: ctx.getProjectMeta ? ctx.getProjectMeta() : {} });
        openNote(payload);
      } catch (e) { alert(`Calculation note could not be generated: ${e?.message || e}`); }
    }
  };
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
    ta.remove();
  }

  // ---------------- state hooks for the host ----------------
  function ensureState(stage6) {
    const rw = ensure(stage6);
    // drop overrides whose layer no longer exists
    if (rw.profile?.overrides && Object.keys(rw.profile.overrides).length) rw.profile.overrides = pruneOverrides(layers(), rw.profile.overrides);
    return rw;
  }

  const cardMeta = { id: 'retwall', title: 'Retaining walls', desc: 'Gravity, RC cantilever, sheet-pile and soldier-pile walls to Eurocode 7 (Belgium): design branches, embedment, EN 1993 steel checks, PLAXIS 2D input, drivability and vibration.' };
  return { defaults, ensure: ensureState, renderBody, postRender, handlers, cardMeta, layerKey };
}
