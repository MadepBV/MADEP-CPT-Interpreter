// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
import {
  EC2_EXPOSURE_META,
  analyzeBeamAndReinforcement,
  analyzeDewatering,
  analyzeSettlement,
  designSoilLayer,
  effectiveVerticalStressAtDepth,
  stage6Constants
} from './stage6-engineering';
import {
  bishopHsJakyK0nc,
  bishopHsRowePhiCvDeg,
  bishopLayerSignature,
  buildBishopModelFromStageLayers,
  importBishopMaterialsFromLayers,
  terrainY as bishopTerrainY
} from './stage6-bishop';
import { importTerrainFromDxfText } from './dxf-terrain';
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
  wallMechanicalPresetById,
  wallMaterialSourceLabel
} from './seepage/material';
import {
  drainHeadValueAt,
  drainTotalLength,
  normalizeDrain,
  normalizeDrains,
  validateDrains
} from './seepage/drains';
import { contourSegmentsForTriangles, sampleSeepageFlowState, sampleSeepageHead, sampleSeepagePorePressure } from './seepage/solver';
import { isSimplePolygon, normalizeRegionPolygon, polygonArea } from './soil-regions';
import { sampleDeformationState } from './deformation/solver.js';
import {
  buildBeamDeflectionChartConfig,
  buildBeamMomentChartConfig,
  buildBearingChartConfig,
  buildDewateringDrawdownChartConfig,
  buildDewateringSettlementChartConfig,
  buildDewateringStressChartConfig,
  buildLineProbeChartConfig,
  buildPileAxialForceChartConfig,
  buildPileDeBeerChartConfig,
  buildPileLoadSettlementChartConfig,
  buildPileShaftChartConfig,
  buildRawProfileChartConfig,
  buildSettlementCumulativeChartConfig,
  buildSettlementStressChartConfig,
  buildTimeChartConfig,
  buildTuningDepthChartConfig,
  buildTuningRegressionChartConfig
} from './chart-factories';
import { analyzePile, PILE_CONSTANTS } from './stage6-pile';
import {
  drawStage6PileSection,
  ensurePileCanvasState,
  stage6PileSnapZ
} from './stage6-pile-canvas';
import { classifyNen6740Reading } from './nen6740';
import { buildLayerColumnSvgMarkup, buildLayerPreviewSvgMarkup } from './report-svg';
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
/* ════════════════════════════════
   STATE
════════════════════════════════ */
let __legacyControllerInitialized = false;
let __legacyControllerHashBound = false;
let xlsxModulePromise = null;
let stage6BishopWorker = null;
let stage6BishopRunId = 0;
let stage6BishopSeepageWorker = null;
let stage6BishopSeepageRunId = 0;
let stage6BishopDeformationWorker = null;
let stage6BishopDeformationRunId = 0;
let classificationRefreshTimer = null;
const stage6BishopCanvasState = {
  canvas:null,
  pointerDrag:null,
  hoverWorld:null
};
// Hardening Soil remains in the lower-level solver code while it is being
// validated, but the production UI must not expose it until the model is
// convergence- and benchmark-ready.
const STAGE6_ENABLE_HARDENING_SOIL_UI = false;

// Stage 6 "Retaining walls" application — self-contained module wired in via a
// small context (live state accessor + render trigger + CPT layer accessor).
const retainingApp = installRetainingApp({
  getState: () => S,
  requestRender: () => renderStage6(),
  workingLayers: () => stage6WorkingLayers()
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
  correlations:[],
  sectionOrder:[0],
};

// S is a live reference to the active CPT — all existing code uses S unchanged
let S=PROJECT.cpts[0];

function selectCpt(idx){
  if(idx<0||idx>=PROJECT.cpts.length)return;
  stage6BishopStopSearch(true);
  stage6BishopStopSeepage(true);
  cancelClassificationRefresh();

  // Destroy any existing Chart.js instances tied to the DOM canvases
  // (they are shared DOM elements, but each CPT has its own chart state)
  try{
    Object.values(S.charts||{}).forEach(c=>{if(c&&c.destroy)c.destroy();});
  }catch(e){}

  PROJECT.activeCptIdx=idx;
  S=PROJECT.cpts[idx];
  renderBanner();

  // Reset stage nav to Stage 1
  document.querySelectorAll('.panel').forEach((p,i)=>p.classList.toggle('active',i===0));
  document.querySelectorAll('.si').forEach((s,i)=>{
    s.classList.remove('active','locked','done');
    if(i===0)s.classList.add('active'); else s.classList.add('locked');
  });

  // Sync controls to this CPT's values
  document.getElementById('wtR').value=S.wt;
  document.getElementById('wtN').value=S.wt.toFixed(2);
  document.getElementById('elevN').value=S.elev!=null?S.elev.toFixed(2):'';
  const smartMergeEl=document.getElementById('smartMergeChk');
  if(smartMergeEl) smartMergeEl.checked=!!S.smartMerge;
  const smartSensRange=document.getElementById('smartMergeSensR');
  const smartSensNum=document.getElementById('smartMergeSensN');
  if(smartSensRange) smartSensRange.value=(S.smartMergeSensitivity ?? 1.1).toFixed(2);
  if(smartSensNum) smartSensNum.value=(S.smartMergeSensitivity ?? 1.1).toFixed(2);
  const smartMergeControls=document.getElementById('smartMergeControls');
  if(smartMergeControls) smartMergeControls.style.display=S.smartMerge?'':'none';
  const cptXEl=document.getElementById('cptX');
  const cptYEl=document.getElementById('cptY');
  if(cptXEl) cptXEl.value=S.x!=null?S.x:'';
  if(cptYEl) cptYEl.value=S.y!=null?S.y:'';
  updateElevSrc(); updateWTDisplay();
  document.getElementById('btnAlphaA').classList.toggle('active',S.alphaMethod==='A');
  document.getElementById('btnAlphaB').classList.toggle('active',S.alphaMethod==='B');
  document.getElementById('btnStiffA').classList.toggle('active',S.stiffMethod==='A');
  document.getElementById('btnStiffB').classList.toggle('active',S.stiffMethod==='B');
  // khKvMethod buttons are added in Stage 4; tolerate missing nodes during early init.
  const btnKhKvA = document.getElementById('btnKhKvA');
  const btnKhKvB = document.getElementById('btnKhKvB');
  if (btnKhKvA) btnKhKvA.classList.toggle('active', S.khKvMethod==='A');
  if (btnKhKvB) btnKhKvB.classList.toggle('active', S.khKvMethod==='B');
  syncClassificationMethodCards(S.method);

  if(S.data.length){
    renderMeta();
    document.getElementById('s1body').style.display='block';
    // Force fresh chart creation for this CPT
    S.chartsReady=false;
    S.charts={};
    // Rebuild chart area DOM so canvases are fresh
    const cr=document.getElementById('chartArea');
    if(cr) cr.innerHTML=`
      <div class="col-card"><div class="ct">layers</div><svg id="layerColSvg" viewBox="0 0 60 400"></svg></div>
      <div class="cc"><div class="ct">qc (MPa)</div><div style="position:relative;height:380px"><canvas id="cQc" role="img" aria-label="qc vs depth">qc profile</canvas></div></div>
      <div class="cc"><div class="ct">fs (kPa)</div><div style="position:relative;height:380px"><canvas id="cFs" role="img" aria-label="fs vs depth">fs profile</canvas></div></div>
      <div class="cc"><div class="ct">Rf (%)</div><div style="position:relative;height:380px"><canvas id="cRf" role="img" aria-label="Rf vs depth">Rf profile</canvas></div></div>`;
    requestAnimationFrame(()=>initCharts());
    drawLayerColumnSvg('layerColSvg', S.layers, S.data[S.data.length-1]?.z+0.5||20);
  } else {
    document.getElementById('s1body').style.display='none';
  }
}

function addCpt(){
  const idx=PROJECT.cpts.length;
  const cpt=newCptState('CPT-'+(idx+1));
  PROJECT.cpts.push(cpt);
  PROJECT.sectionOrder.push(idx);
  selectCpt(idx);
  // Open file picker for the new CPT
  document.getElementById('fi').click();
}

function setCptName(idx, name){
  PROJECT.cpts[idx].id=name.trim()||('CPT-'+(idx+1));
  renderBanner();
}

/* ════════════════════════════════
   BANNER + PHASE MANAGEMENT
════════════════════════════════ */
function renderBanner(){
  const tabs=document.getElementById('cptTabs');
  if(!tabs)return;
  tabs.innerHTML=PROJECT.cpts.map((cpt,i)=>{
    const isActive=i===PROJECT.activeCptIdx;
    const status=cpt.layers.length?'Ready':cpt.data.length?'Data':'Empty';
    const statusClass=cpt.layers.length?'ready':cpt.data.length?'data':'empty';
    return`<div class="cpt-tab ${isActive?'active':''}" data-cpt-index="${i}" role="button" tabindex="0" onclick="selectCpt(${i})" aria-label="Select ${cpt.id}">
      <span class="cpt-tab__status cpt-tab__status--${statusClass}">${status}</span>
      <span>${cpt.id}</span>
      ${PROJECT.cpts.length>1?`<span data-remove="${i}"
        class="cpt-tab__remove" title="Verwijder CPT" aria-label="Verwijder ${cpt.id}">x</span>`:''}
    </div>`;
  }).join('');
  document.getElementById('projName').value=PROJECT.name;
  // Event delegation for remove buttons (avoids nested onclick issues)
  tabs.querySelectorAll('[data-remove]').forEach(el=>{
    el.addEventListener('click', e=>{
      e.stopPropagation();
      const i=+el.dataset.remove;
      removeCpt(i);
    });
  });
  tabs.querySelectorAll('.cpt-tab').forEach(el=>{
    el.addEventListener('keydown', e=>{
      if(e.key!=='Enter'&&e.key!==' ') return;
      e.preventDefault();
      selectCpt(+el.dataset.cptIndex || 0);
    });
  });
}

function removeCpt(idx){
  if(PROJECT.cpts.length<=1)return;
  if(!confirm(`CPT "${PROJECT.cpts[idx].id}" verwijderen?`))return;
  PROJECT.cpts.splice(idx,1);
  PROJECT.sectionOrder=PROJECT.sectionOrder.filter(i=>i!==idx).map(i=>i>idx?i-1:i);
  const newActive=Math.min(PROJECT.activeCptIdx,PROJECT.cpts.length-1);
  PROJECT.activeCptIdx=newActive;
  S=PROJECT.cpts[newActive];
  renderBanner();
  selectCpt(newActive);
}

function setPhase(ph){
  PROJECT.phase=ph;
  ['analysis','correlation','section'].forEach(p=>{
    document.getElementById('phase'+p[0].toUpperCase()+p.slice(1))?.classList.toggle('active',p===ph);
  });
  document.getElementById('phaseA').classList.toggle('active',ph==='analysis');
  document.getElementById('phaseB').classList.toggle('active',ph==='correlation');
  document.getElementById('phaseC').classList.toggle('active',ph==='section');
  document.getElementById('nav').style.display    = ph==='analysis'?'flex':'none';
  document.querySelector('.wrap').style.display   = ph==='analysis'?'block':'none';
  document.getElementById('phaseCorr').style.display    = ph==='correlation'?'block':'none';
  document.getElementById('phaseSection').style.display = ph==='section'?'block':'none';
  if(ph==='correlation') renderCorrTable();
  if(ph==='section')     renderSection();
}

/* ════════════════════════════════
   MULTI-CPT FILE LOAD
════════════════════════════════ */
function stripCptFileExtension(name){
  return String(name||'CPT').replace(/\.(gef|txt|csv|xls|xlsx)$/i,'');
}

function isExcelCptFile(file){
  const name=String(file?.name||'');
  const type=String(file?.type||'');
  return /\.(xls|xlsx)$/i.test(name)
    || type.includes('spreadsheet')
    || type.includes('excel');
}

function isCsvCptFile(file){
  const name=String(file?.name||'');
  const type=String(file?.type||'');
  return /\.csv$/i.test(name) || type.includes('csv');
}

/* Reads files serially because parsing still drives shared DOM/chart state. */
function importCptFiles(files){
  if(!files.length)return;

  // Build list of target CPT indices before any async work
  const targets=files.map((f,fi)=>{
    if(fi===0) return PROJECT.activeCptIdx;
    const idx=PROJECT.cpts.length;
    PROJECT.cpts.push(newCptState('CPT-'+(idx+1)));
    PROJECT.sectionOrder.push(idx);
    return idx;
  });

  // Load serially: each file's reader waits for previous to complete
  function loadNext(fi){
    if(fi>=files.length)return;
    const f=files[fi], targetIdx=targets[fi];
    const reader=new FileReader();
    reader.onload=async e=>{
      // Save current active, switch to target, parse, restore
      const prevActive=PROJECT.activeCptIdx;
      const prevS=S;
      PROJECT.activeCptIdx=targetIdx;
      S=PROJECT.cpts[targetIdx];
      try{
        let ok;
        if(isExcelCptFile(f)) ok=await parseExcelCpt(e.target.result,f.name);
        else if(isCsvCptFile(f)) ok=parseCsvCpt(e.target.result,f.name);
        else ok=parseGEF(e.target.result,f.name);
        if(ok!==false){
          S.id=stripCptFileExtension(f.name);
          renderBanner();
        }
      }catch(err){
        console.error(err);
        alert(`Error importing ${f.name}: ${err?.message||err}`);
      }
      if(fi===0){
        // First file: stay on this CPT, update display
        selectCpt(targetIdx);
      } else {
        // Additional files: restore previous active, then load next
        PROJECT.activeCptIdx=prevActive;
        S=prevS;
        renderBanner();
      }
      loadNext(fi+1);
    };
    reader.onerror=()=>{ alert('Error reading '+f.name); loadNext(fi+1); };
    if(isExcelCptFile(f)) reader.readAsArrayBuffer(f);
    else reader.readAsText(f);
  }
  loadNext(0);
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

/* ════════════════════════════════
   PHASE B — CROSS-CPT CORRELATION
════════════════════════════════ */
function layerTAW(cpt, layer){
  if(cpt.elev==null) return null;
  return{top:cpt.elev-layer.top, bot:cpt.elev-layer.bot, mid:cpt.elev-(layer.top+layer.bot)/2};
}

function cptDist(cptA, cptB){
  // Returns distance between CPTs. If coordinates unknown, returns 10m as default.
  if(cptA.x==null||cptA.y==null||cptB.x==null||cptB.y==null) return 10;
  return Math.sqrt((cptA.x-cptB.x)**2+(cptA.y-cptB.y)**2)||1;
}

function layerTypeCompatScore(lA, lB){
  /* Multi-level type compatibility for correlation.
     Uses both the COMPAT matrix (grp-based) AND direct type matching.
     Mixed/transition layers (Sandy clay = leem/klei border) get adjacency credit
     on both sides of the boundary. */
  const compatA=COMPAT[lA.type]||{ok:[],adj:[]};
  const compatB=COMPAT[lB.type]||{ok:[],adj:[]};

  // Get Eurocode Table 3 group of each layer's subtype
  const entA=CAT.find(r=>r.subtype===lA.subtype);
  const entB=CAT.find(r=>r.subtype===lB.subtype);
  const grpA=entA?entA.grp:'';
  const grpB=entB?entB.grp:'';

  // Direct type match (both same CPT type)
  if(lA.type===lB.type) return 1.0;

  // A's subtype group is in B's compat.ok
  if(grpA&&compatB.ok.includes(grpA)) return 0.9;
  // B's subtype group is in A's compat.ok
  if(grpB&&compatA.ok.includes(grpB)) return 0.9;

  // Adjacent type (transition zones)
  if(grpA&&compatB.adj.includes(grpA)) return 0.5;
  if(grpB&&compatA.adj.includes(grpB)) return 0.5;

  // CPT types are compatible (even without subtype info)
  const cpttypes_compat={
    'Sandy clay': ['Clay','Soft clay','Silty sand'],
    'Silty sand': ['Sandy clay','Sand'],
    'Soft clay':  ['Clay','Sandy clay'],
    'Clay':       ['Soft clay','Sandy clay'],
    'Sand':       ['Silty sand','Gravel'],
    'Gravel':     ['Sand'],
  };
  if((cpttypes_compat[lA.type]||[]).includes(lB.type)) return 0.4;
  if((cpttypes_compat[lB.type]||[]).includes(lA.type)) return 0.4;

  return 0.0; // genuinely incompatible
}

function matchScore(cptA, lA, cptB, lB){
  const tA=layerTAW(cptA,lA), tB=layerTAW(cptB,lB);
  if(!tA||!tB) return 0;
  const dist=cptDist(cptA,cptB);

  // Elevation IoU (Intersection over Union)
  // Both layers have top > bot in TAW (top = higher elevation)
  const overlapTop=Math.min(tA.top,tB.top);
  const overlapBot=Math.max(tA.bot,tB.bot);
  const overlap=Math.max(0,overlapTop-overlapBot);
  const unionTop=Math.max(tA.top,tB.top);
  const unionBot=Math.min(tA.bot,tB.bot);
  const union=Math.max(0.01, unionTop-unionBot);
  const IoU=overlap/union;

  // Gap penalty — layers that don't overlap but are close
  const gap=Math.max(0,overlapBot-overlapTop); // positive = gap between layers
  const tol=Math.max(0.30, 0.30+0.005*dist);  // tolerance grows 0.5cm/m distance
  const gapScore=IoU>0?1.0:Math.max(0,1-gap/tol);

  // Soil type compatibility (improved)
  const typeScore=layerTypeCompatScore(lA,lB);

  // qc similarity (log-ratio — more robust for orders of magnitude differences)
  const qcA=Math.max(0.01,lA.avgQc), qcB=Math.max(0.01,lB.avgQc);
  const logRatio=Math.abs(Math.log(qcA/qcB));
  const qcScore=Math.max(0,1-logRatio/1.5); // 1.5 = 1 order of magnitude tolerance

  // Thickness similarity bonus (same geological unit → similar thickness)
  const thkA=lA.bot-lA.top, thkB=lB.bot-lB.top;
  const thkRatio=Math.min(thkA,thkB)/Math.max(thkA,thkB,0.01);
  const thkScore=Math.max(0,thkRatio-0.3)/0.7; // penalise >3× thickness difference

  const score=0.45*IoU + 0.25*gapScore + 0.18*typeScore + 0.07*qcScore + 0.05*thkScore;
  return +score.toFixed(3);
}

function runCorrelation(){
  const cpts=PROJECT.cpts.filter(c=>c.elev!=null&&c.layers.length);
  if(cpts.length<2){
    document.getElementById('corrWarnings').innerHTML=
      '<div class="info">Minimaal 2 CPTs met bevestigde maaiveldshoogte en laagindeling vereist.</div>';
    return;
  }
  document.getElementById('corrWarnings').innerHTML='';

  // Build edges (pairwise best matches, greedy)
  // Node: {ci: cptIdx in PROJECT.cpts, li: layerIdx}
  // Use original PROJECT indices
  const projCpts=PROJECT.cpts;

  // All pairwise candidate pairs
  const pairs=[];
  for(let a=0;a<projCpts.length;a++){
    if(!projCpts[a].elev||!projCpts[a].layers.length) continue;
    for(let b=a+1;b<projCpts.length;b++){
      if(!projCpts[b].elev||!projCpts[b].layers.length) continue;
      for(let la=0;la<projCpts[a].layers.length;la++){
        for(let lb=0;lb<projCpts[b].layers.length;lb++){
          const sc=matchScore(projCpts[a],projCpts[a].layers[la],projCpts[b],projCpts[b].layers[lb]);
          if(sc>=0.25) pairs.push({a,la,b,lb,sc});
        }
      }
    }
  }
  pairs.sort((x,y)=>y.sc-x.sc);

  // Greedy assignment
  const matched=new Set();
  const edges=[];
  for(const p of pairs){
    const kA=p.a+'-'+p.la, kB=p.b+'-'+p.lb;
    if(!matched.has(kA)&&!matched.has(kB)){
      matched.add(kA); matched.add(kB);
      edges.push(p);
    }
  }

  // Union-Find to build groups
  const parent={}; // key -> root key
  function find(k){return parent[k]===k?k:(parent[k]=find(parent[k]));}
  function union(k1,k2){parent[find(k1)]=find(k2);}

  // Init
  for(let ci=0;ci<projCpts.length;ci++){
    if(!projCpts[ci].layers.length)continue;
    projCpts[ci].layers.forEach((_,li)=>{ const k=ci+'-'+li; parent[k]=k; });
  }
  for(const e of edges){ union(e.a+'-'+e.la, e.b+'-'+e.lb); }

  // Collect groups
  const groupMap={};
  for(let ci=0;ci<projCpts.length;ci++){
    if(!projCpts[ci].layers.length)continue;
    projCpts[ci].layers.forEach((l,li)=>{
      const k=ci+'-'+li;
      if(!parent[k])return;
      const root=find(k);
      if(!groupMap[root]) groupMap[root]=[];
      groupMap[root].push({ci,li,layer:l});
    });
  }

  // Sort groups by mean TAW elevation descending (highest first)
  PROJECT.correlations=Object.values(groupMap).map(members=>{
    const taws=members.map(m=>layerTAW(projCpts[m.ci],m.layer)).filter(Boolean);
    const meanMid=taws.length?taws.reduce((s,t)=>s+t.mid,0)/taws.length:0;
    return{members, meanMid};
  }).sort((a,b)=>b.meanMid-a.meanMid);

  renderCorrTable();
  if(PROJECT.phase==='correlation') renderSection();
}

function renderCorrTable(){
  const el=document.getElementById('corrTable');
  const cpts=PROJECT.cpts;
  const activeCpts=cpts.map((c,i)=>({c,i})).filter(({c})=>c.elev!=null&&c.layers.length);

  if(activeCpts.length<2){
    el.innerHTML='<div style="color:var(--tx2);font-size:13px;padding:20px 0">Laad minimaal 2 CPTs met laagindeling en maaiveldshoogte.</div>';
    return;
  }
  if(!PROJECT.correlations.length){
    el.innerHTML='<div style="color:var(--tx2);font-size:13px;padding:20px 0">Klik op "Auto-correleer" om de correlatie te berekenen.</div>';
    return;
  }

  const hdrs=activeCpts.map(({c,i})=>`<th style="min-width:120px">${c.id}</th>`).join('');
  const rows=PROJECT.correlations.map((grp,gi)=>{
    const taws=grp.members.map(m=>layerTAW(cpts[m.ci],m.layer)).filter(Boolean);
    const topTAW=Math.max(...taws.map(t=>t.top)).toFixed(1);
    const botTAW=Math.min(...taws.map(t=>t.bot)).toFixed(1);
    const cells=activeCpts.map(({c,i})=>{
      const member=grp.members.find(m=>m.ci===i);
      if(!member){
        // Check if this CPT even covers this elevation range
        const tawRange=grp.members.map(m=>layerTAW(cpts[m.ci],m.layer)).filter(Boolean);
        const grpTopTAW=Math.max(...tawRange.map(t=>t.top));
        const grpBotTAW=Math.min(...tawRange.map(t=>t.bot));
        const cptToeElev=c.elev-(c.data[c.data.length-1]?.z||0);
        const notSampled=c.elev!=null&&grpBotTAW<cptToeElev;
        return`<td style="text-align:center;color:var(--tx3)">
          <span style="font-size:10px">${notSampled?'— niet bereikt':'─── afwezig'}</span>
        </td>`;
      }
      const l=member.layer;
      const fill=SCFILL[l.type]||'#D3D1C7';
      const taw=layerTAW(cpts[i],l);
      const depthStr=taw?`${taw.top.toFixed(1)}→${taw.bot.toFixed(1)} TAW`:'';
      return`<td style="vertical-align:top;padding:5px 8px">
        <span class="sb" style="background:${fill};color:#333;font-size:10px;display:block;margin-bottom:3px">${l.subtype||l.type}</span>
        <div style="font-size:10px;color:var(--tx2)">${depthStr}</div>
        <div style="font-size:10px;color:var(--tx3)">qc ${l.avgQc.toFixed(2)} MPa · ${(l.bot-l.top).toFixed(1)}m dik</div>
      </td>`;
    }).join('');
    return`<tr>
      <td style="font-size:11px;color:var(--tx2);white-space:nowrap">${topTAW} → ${botTAW} m TAW</td>
      ${cells}
    </tr>`;
  }).join('');

  el.innerHTML=`<table class="tbl"><thead><tr><th>Hoogte (m TAW)</th>${hdrs}</tr></thead><tbody>${rows}</tbody></table>`;
}

/* ════════════════════════════════
   PHASE C — GEOLOGICAL CROSS-SECTION
════════════════════════════════ */
function sectionProjection(){
  // Project CPTs onto section line using XY if available, else use CPT order
  const all=PROJECT.cpts.filter(c=>c.elev!=null&&c.layers.length);
  if(all.length<2) return null;

  const hasCoords=all.every(c=>c.x!=null&&c.y!=null);

  if(!hasCoords){
    // Fallback: use CPT index order, 50m apart
    return all.map((c,i)=>({...c, dist:i*50}));
  }

  const cpts=all;

  const cx=cpts.reduce((s,c)=>s+c.x,0)/cpts.length;
  const cy=cpts.reduce((s,c)=>s+c.y,0)/cpts.length;

  let sxx=0,sxy=0,syy=0;
  cpts.forEach(c=>{sxx+=(c.x-cx)**2;sxy+=(c.x-cx)*(c.y-cy);syy+=(c.y-cy)**2;});

  let dx,dy;
  if(Math.abs(sxy)<1e-6&&sxx>=syy){dx=1;dy=0;}
  else if(Math.abs(sxy)<1e-6){dx=0;dy=1;}
  else{
    // Eigenvector of 2x2 cov matrix
    const diff=sxx-syy, disc=Math.sqrt(diff*diff+4*sxy*sxy);
    const lam=(sxx+syy+disc)/2;
    dx=sxy; dy=lam-sxx;
    const len=Math.sqrt(dx*dx+dy*dy); dx/=len; dy/=len;
  }

  return cpts.map(c=>({
    ...c,
    dist: (c.x-cx)*dx+(c.y-cy)*dy
  })).sort((a,b)=>a.dist-b.dist);
}

function renderSection(){
  const svg=document.getElementById('sectionSvg');
  if(!svg) return;
  const vex=parseFloat(document.getElementById('vexag')?.value||2);

  const projCpts=sectionProjection();
  if(!projCpts||projCpts.length<1){
    svg.innerHTML=`<text x="20" y="40" font-size="13" fill="${readCssToken('--tx3', '#888890')}">Minimaal 2 CPTs met maaiveldshoogte vereist voor doorsnede.</text>`;
    svg.setAttribute('viewBox','0 0 400 80'); svg.setAttribute('width','400'); svg.setAttribute('height','80');
    return;
  }

  // ── Canvas geometry ──
  const ML=65,MR=30,MT=40,MB=50;
  const W=Math.max(700, projCpts.length*260);

  // Collect all elevations across all CPTs
  const elevAll=[];
  projCpts.forEach(c=>{
    if(c.elev!=null) elevAll.push(c.elev);
    c.layers.forEach(l=>{ if(c.elev!=null) elevAll.push(c.elev-l.bot); });
  });
  if(!elevAll.length){ svg.innerHTML=`<text x="20" y="30" font-size="11" fill="${readCssToken('--tx3', '#888890')}">Geen data.</text>`; return; }
  const maxElev=Math.max(...elevAll)+1;
  const minElev=Math.min(...elevAll)-1;
  const elevRange=maxElev-minElev||1;
  const H=Math.max(350, elevRange*vex*18);

  const totalW=W+ML+MR, totalH=H+MT+MB;
  svg.setAttribute('viewBox',`0 0 ${totalW} ${totalH}`);
  svg.setAttribute('width',totalW); svg.setAttribute('height',totalH);

  const distMin=projCpts[0].dist, distMax=projCpts[projCpts.length-1].dist;
  const distRange=Math.max(distMax-distMin,1);

  function px(d){ return ML+(d-distMin)/distRange*W; }
  function py(e){ return MT+(maxElev-e)/elevRange*(H/vex)*vex; }
  function esc(v){
    return String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  const svgText = readCssToken('--tx', '#18181a');
  const svgMuted = readCssToken('--tx2', '#4a4a52');
  const svgSubtle = readCssToken('--tx3', '#888890');
  const svgBlue = readCssToken('--chart-blue', '#4F8584');

  let s='';

  // ── Ground fill (below surface, above deepest layer) ──
  s+='<rect x="0" y="0" width="'+totalW+'" height="'+totalH+'" fill="var(--bg)"/>';

  // ── Elevation grid lines ──
  const step=elevRange<=5?0.5:elevRange<=15?1:elevRange<=30?2:5;
  for(let e=Math.ceil(minElev/step)*step; e<=Math.floor(maxElev/step)*step; e=+(e+step).toFixed(4)){
    const y=py(e);
    if(y<MT||y>MT+H) continue;
    s+=`<line x1="${ML}" x2="${ML+W}" y1="${y}" y2="${y}" stroke="rgba(128,128,128,0.10)" stroke-width="0.5"/>`;
    s+=`<text x="${ML-5}" y="${y+3.5}" font-size="9" text-anchor="end" fill="${svgSubtle}" font-family="sans-serif">${e.toFixed(1)}</text>`;
  }

  // ── Build interpolated stratigraphy ──
  // For each unique soil group from correlations, draw a filled polygon
  // connecting layer tops and bottoms across all CPTs (with interpolation for gaps).
  // Groups sorted top to bottom in elevation.

  if(PROJECT.correlations.length){
    PROJECT.correlations.forEach((grp,gi)=>{
      // Gather anchor points: {dist, topTAW, botTAW, type}
      const anchors=[];
      projCpts.forEach(pc=>{
        const cptIdx=PROJECT.cpts.indexOf(pc);
        if(cptIdx<0) return;
        const member=grp.members.find(m=>m.ci===cptIdx);
        if(member&&pc.elev!=null){
          const taw={top:pc.elev-member.layer.top, bot:pc.elev-member.layer.bot};
          anchors.push({dist:pc.dist, top:taw.top, bot:taw.bot, type:member.layer.type, hasData:true});
        } else {
          anchors.push({dist:pc.dist, top:null, bot:null, type:null, hasData:false});
        }
      });

      // Interpolate missing anchors between known ones
      for(let i=0;i<anchors.length;i++){
        if(!anchors[i].hasData){
          // Find nearest known on left and right
          let li=-1,ri=-1;
          for(let j=i-1;j>=0;j--){ if(anchors[j].hasData){li=j;break;} }
          for(let j=i+1;j<anchors.length;j++){ if(anchors[j].hasData){ri=j;break;} }
          if(li>=0&&ri>=0){
            const t=(anchors[i].dist-anchors[li].dist)/(anchors[ri].dist-anchors[li].dist);
            anchors[i].top =anchors[li].top +(anchors[ri].top -anchors[li].top )*t;
            anchors[i].bot =anchors[li].bot +(anchors[ri].bot -anchors[li].bot )*t;
            anchors[i].type=anchors[li].type;
            anchors[i].interpolated=true;
          } else if(li>=0){
            // Taper to a point at the right end
            anchors[i].top=anchors[li].top;
            anchors[i].bot=anchors[li].bot;
            anchors[i].type=anchors[li].type;
            anchors[i].taper='right';
          } else if(ri>=0){
            anchors[i].top=anchors[ri].top;
            anchors[i].bot=anchors[ri].bot;
            anchors[i].type=anchors[ri].type;
            anchors[i].taper='left';
          }
        }
      }

      const valid=anchors.filter(a=>a.top!=null);
      if(valid.length<2) return;
      const fill=SCFILL[valid[0].type]||'#D3D1C7';
      const topPts=valid.map(a=>`${px(a.dist).toFixed(1)},${py(a.top).toFixed(1)}`).join(' ');
      const botPts=[...valid].reverse().map(a=>`${px(a.dist).toFixed(1)},${py(a.bot).toFixed(1)}`).join(' ');
      s+=`<polygon points="${topPts} ${botPts}" fill="${fill}" fill-opacity="0.80" stroke="${svgMuted}" stroke-width="0.6"/>`;

      // Label in middle of group
      const midAnchor=valid[Math.floor(valid.length/2)];
      const labelY=(py(midAnchor.top)+py(midAnchor.bot))/2;
      const thickness=midAnchor.top-midAnchor.bot;
      if(thickness*vex*18/elevRange>12){
        const lbl=midAnchor.type||'';
        s+=`<text x="${px(midAnchor.dist).toFixed(1)}" y="${(labelY+4).toFixed(1)}" font-size="9" text-anchor="middle" fill="rgba(0,0,0,0.55)" font-family="sans-serif">${lbl.split('/')[0].trim()}</text>`;
      }
    });
  }

  // ── Fill background below correlated stratigraphy (deepest layer downward) ──
  // Draw a ground fill below the deepest confirmed layer in each CPT
  projCpts.forEach(c=>{
    if(!c.elev||!c.layers.length) return;
    const deepBot=c.elev-c.layers[c.layers.length-1].bot;
    const x=px(c.dist), colW=14;
    s+=`<rect x="${(x-colW/2).toFixed(1)}" y="${py(deepBot).toFixed(1)}" width="${colW}" height="${(totalH-py(deepBot)).toFixed(1)}" fill="#b8a99a" fill-opacity="0.3"/>`;
  });

  // ── CPT columns ──
  projCpts.forEach(c=>{
    if(!c.elev) return;
    const xc=px(c.dist), colW=14;
    // Surface to toe vertical line
    const toeElev=c.layers.length?c.elev-c.layers[c.layers.length-1].bot:c.elev-10;
    s+=`<line x1="${xc}" x2="${xc}" y1="${py(c.elev)}" y2="${py(toeElev)}" stroke="${svgMuted}" stroke-width="0.8" stroke-dasharray="3,2"/>`;

    c.layers.forEach(l=>{
      const fill=SCFILL[l.type]||'#D3D1C7';
      const y1=py(c.elev-l.top), y2=py(c.elev-l.bot);
      const h=Math.max(y2-y1,1.5);
      const topTaw=(c.elev-l.top).toFixed(2);
      const botTaw=(c.elev-l.bot).toFixed(2);
      const avgFsTxt=l.avgFs!=null?(l.avgFs*1000).toFixed(1):'—';
      const avgRfTxt=l.avgRf!=null?l.avgRf.toFixed(2):'—';
      const subtypeTxt=l.subtype||'—';
      s+=`<rect class="section-layer-hit" data-section-layer="1"
        data-cpt="${esc(c.id)}"
        data-type="${esc(l.type)}"
        data-subtype="${esc(subtypeTxt)}"
        data-top="${l.top.toFixed(2)}"
        data-bot="${l.bot.toFixed(2)}"
        data-toptaw="${topTaw}"
        data-bottaw="${botTaw}"
        data-thk="${(l.bot-l.top).toFixed(2)}"
        data-qc="${l.avgQc.toFixed(2)}"
        data-fs="${avgFsTxt}"
        data-rf="${avgRfTxt}"
        data-g="${l.g}"
        data-gs="${l.gs}"
        data-phi="${l.phi}"
        data-c="${l.c}"
        data-cu="${l.cu}"
        x="${(xc-colW/2).toFixed(1)}" y="${y1.toFixed(1)}" width="${colW}" height="${h.toFixed(1)}"
        fill="${fill}" stroke="rgba(0,0,0,0.25)" stroke-width="0.5"/>`;
      // Layer boundary tick (left of column)
      s+=`<line x1="${(xc-colW/2-5).toFixed(1)}" x2="${(xc-colW/2).toFixed(1)}" y1="${y1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${svgMuted}" stroke-width="0.6"/>`;
      // Depth label left
      if(h>12){
        const elmid=(y1+y2)/2;
        s+=`<text x="${(xc-colW/2-7).toFixed(1)}" y="${(elmid+3).toFixed(1)}" font-size="7.5" text-anchor="end" fill="${svgMuted}" font-family="sans-serif">${(c.elev-l.bot).toFixed(1)}</text>`;
      }
    });

    // WT
    if(c.wt!=null){
      const wtY=py(c.elev-c.wt);
      s+=`<line x1="${(xc-18).toFixed(1)}" x2="${(xc+18).toFixed(1)}" y1="${wtY.toFixed(1)}" y2="${wtY.toFixed(1)}" stroke="${svgBlue}" stroke-width="2" stroke-dasharray="5,3"/>`;
    }
    // CPT label
    s+=`<text x="${xc}" y="${(MT-14).toFixed(1)}" font-size="10" text-anchor="middle" font-weight="600" fill="${svgText}" font-family="sans-serif">${c.id}</text>`;
    s+=`<text x="${xc}" y="${(MT-4).toFixed(1)}" font-size="9" text-anchor="middle" fill="${svgSubtle}" font-family="sans-serif">${c.elev!=null?c.elev.toFixed(2)+' m TAW':''}</text>`;
    // Distance from start
    const d0=(c.dist-distMin).toFixed(0);
    s+=`<text x="${xc}" y="${(totalH-8).toFixed(1)}" font-size="9" text-anchor="middle" fill="${svgSubtle}" font-family="sans-serif">${d0}m</text>`;
  });

  // ── WT interpolated line across section ──
  const wtPts=projCpts.filter(c=>c.wt!=null&&c.elev!=null)
    .map(c=>`${px(c.dist).toFixed(1)},${py(c.elev-c.wt).toFixed(1)}`);
  if(wtPts.length>=2)
    s+=`<polyline points="${wtPts.join(' ')}" fill="none" stroke="${svgBlue}" stroke-width="1.8" stroke-dasharray="7,5"/>
        <text x="${(ML+10).toFixed(1)}" y="${py(projCpts.find(c=>c.wt!=null)?.elev-(projCpts.find(c=>c.wt!=null)?.wt||0)||maxElev).toFixed(1)}" font-size="9" fill="${svgBlue}" font-family="sans-serif">WT</text>`;

  // ── Axes labels ──
  s+=`<text x="${(ML+W/2).toFixed(1)}" y="${(totalH-6).toFixed(1)}" font-size="10" text-anchor="middle" fill="${svgMuted}" font-family="sans-serif">Afstand langs doorsnede (m) — vex ×${vex}</text>`;
  s+=`<text x="12" y="${(MT+H/2).toFixed(1)}" font-size="10" text-anchor="middle" fill="${svgMuted}" font-family="sans-serif" transform="rotate(-90,12,${(MT+H/2).toFixed(1)})">Hoogte (m TAW)</text>`;

  // ── Legend ──
  const legendTypes=[...new Set(PROJECT.cpts.flatMap(c=>c.layers.map(l=>l.type)))].slice(0,8);
  const lx=ML+W-140, ly=MT+10;
  s+=`<rect x="${lx-4}" y="${ly-4}" width="144" height="${legendTypes.length*17+8}" rx="4" fill="var(--bg)" fill-opacity="0.85" stroke="rgba(0,0,0,0.1)" stroke-width="0.5"/>`;
  legendTypes.forEach((t,i)=>{
    s+=`<rect x="${lx}" y="${ly+i*17}" width="10" height="10" fill="${SCFILL[t]||'#D3D1C7'}" stroke="rgba(0,0,0,0.2)" stroke-width="0.3"/>`;
    s+=`<text x="${lx+14}" y="${ly+i*17+9}" font-size="8.5" fill="${svgText}" font-family="sans-serif">${t}</text>`;
  });

  svg.innerHTML=s;
  bindSectionTooltip();
}

function bindSectionTooltip(){
  const svg=document.getElementById('sectionSvg');
  const canvas=document.getElementById('sectionCanvas');
  const tip=document.getElementById('sectionTip');
  if(!svg||!canvas||!tip||svg.dataset.tipBound==='1') return;

  function hideTip(){ tip.style.display='none'; }
  function showTip(target, evt){
    tip.innerHTML=`<strong>${target.dataset.cpt||'CPT'} — ${target.dataset.type||''}</strong>
      <div class="mut">${target.dataset.subtype||'—'}</div>
      <div class="row"><span>Depth</span><span>${target.dataset.top}–${target.dataset.bot} m</span></div>
      <div class="row"><span>TAW</span><span>${target.dataset.toptaw} to ${target.dataset.bottaw}</span></div>
      <div class="row"><span>Thickness</span><span>${target.dataset.thk} m</span></div>
      <div class="row"><span>avg qc</span><span>${target.dataset.qc} MPa</span></div>
      <div class="row"><span>avg fs</span><span>${target.dataset.fs} kPa</span></div>
      <div class="row"><span>avg Rf</span><span>${target.dataset.rf} %</span></div>
      <div class="row"><span>γ / γ_sat</span><span>${target.dataset.g} / ${target.dataset.gs}</span></div>
      <div class="row"><span>φ' / c' / cu</span><span>${target.dataset.phi}° / ${target.dataset.c} / ${target.dataset.cu}</span></div>`;
    tip.style.display='block';
    const rect=canvas.getBoundingClientRect();
    const pad=14;
    const tipW=260;
    const tipH=190;
    let left=evt.clientX-rect.left+16+canvas.scrollLeft;
    let top =evt.clientY-rect.top +16+canvas.scrollTop;
    const maxLeft=canvas.scrollLeft+rect.width-tipW-pad;
    const maxTop =canvas.scrollTop +rect.height-tipH-pad;
    if(left>maxLeft) left=Math.max(canvas.scrollLeft+pad, evt.clientX-rect.left-tipW-16+canvas.scrollLeft);
    if(top>maxTop)   top =Math.max(canvas.scrollTop+pad, evt.clientY-rect.top-tipH-16+canvas.scrollTop);
    tip.style.left=`${left}px`;
    tip.style.top=`${top}px`;
  }

  svg.addEventListener('mousemove',e=>{
    const target=e.target.closest?.('[data-section-layer]');
    if(!target){ hideTip(); return; }
    showTip(target,e);
  });
  svg.addEventListener('mouseleave',hideTip);
  svg.dataset.tipBound='1';
}

function exportSectionSVG(){
  const svg=document.getElementById('sectionSvg');
  if(!svg)return;
  const blob=new Blob(['<?xml version="1.0"?>'+svg.outerHTML],{type:'image/svg+xml'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=`${PROJECT.name}_doorsnede.svg`;
  a.click();
}

/* ════════════════════════════════
   SOIL DEFS
════════════════════════════════ */
const SC = SOIL_CLASS_NAMES;
const SCFILL = SOIL_FILL_COLORS;
const DEF={
  'Peat / organic':{g:11,gs:12,phi:17,c:0,cu:10},
  'Soft clay':     {g:15,gs:16,phi:20,c:2,cu:25},
  'Clay':          {g:17,gs:18,phi:24,c:5,cu:50},
  'Sandy clay':    {g:18,gs:19,phi:28,c:2,cu:0},
  'Silty sand':    {g:19,gs:20,phi:31,c:0,cu:0},
  'Sand':          {g:19,gs:20,phi:34,c:0,cu:0},
  'Gravel':        {g:20,gs:21,phi:38,c:0,cu:0}
};
/* Alpha Method A — fixed Sanglerat values (SB260-21-6.4.10) */
const AE={
  'Peat / organic':1.5,'Soft clay':3.0,'Clay':5.0,
  'Sandy clay':8.0,'Silty sand':10.0,'Sand':13.0,'Gravel':15.0
};

/* Default drained Poisson ratios for the Mohr-Coulomb deformation export.
   Priority: selected EC7 subtype first, then broad CPT soil family fallback.
   These values replace the previous blanket 0.30/0.35/0.45 rule so dense sands
   and weak fine soils do not all inherit the same lateral-strain behavior. */
const MC_NU_BY_TYPE={
  'Peat / organic':0.42,
  'Soft clay':0.45,
  'Clay':0.40,
  'Sandy clay':0.33,
  'Silty sand':0.30,
  'Sand':0.30,
  'Gravel':0.28
};

const MC_NU_BY_SUBTYPE={
  'veen, weinig vast':0.40,
  'veen, matig vast':0.42,
  'veen, vast':0.45,

  'klei, weinig vast':0.42,
  'klei, matig vast':0.40,
  'klei, vrij vast':0.38,
  'klei, vast':0.35,
  'klei (zh), weinig vast':0.40,
  'klei (zh), matig vast':0.38,
  'klei (zh), vrij vast':0.36,
  'klei (zh), vast':0.35,

  'leem, weinig vast':0.35,
  'leem, matig vast':0.33,
  'leem, vrij vast':0.32,
  'leem, vast':0.30,
  'leem (zh), weinig vast':0.33,
  'leem (zh), matig vast':0.32,
  'leem (zh), vrij vast':0.31,
  'leem (zh), vast':0.30,

  'zand, los':0.28,
  'zand, matig':0.30,
  'zand, dicht':0.33,
  'zand, zeer dicht':0.35,
  'zand (lh), los':0.30,
  'zand (lh), matig':0.32,
  'zand (lh), dicht':0.34,
  'zand (lh), z.dicht':0.35,

  'grind, matig':0.28,
  'grind, dicht':0.30,
  'grind (kh), matig':0.30,
  'grind (kh), dicht':0.32
};

const MC_RSHEAR_BY_TYPE={
  'Peat / organic':0.12,
  'Soft clay':0.14,
  'Clay':0.16,
  'Sandy clay':0.22,
  'Silty sand':0.28,
  'Sand':0.33,
  'Gravel':0.34
};

const MC_RSHEAR_BY_SUBTYPE={
  'veen, weinig vast':0.10,
  'veen, matig vast':0.12,
  'veen, vast':0.15,

  'klei, weinig vast':0.12,
  'klei, matig vast':0.15,
  'klei, vrij vast':0.18,
  'klei, vast':0.20,
  'klei (zh), weinig vast':0.15,
  'klei (zh), matig vast':0.18,
  'klei (zh), vrij vast':0.20,
  'klei (zh), vast':0.22,

  'leem, weinig vast':0.18,
  'leem, matig vast':0.20,
  'leem, vrij vast':0.22,
  'leem, vast':0.25,
  'leem (zh), weinig vast':0.20,
  'leem (zh), matig vast':0.22,
  'leem (zh), vrij vast':0.25,
  'leem (zh), vast':0.28,

  'zand, los':0.30,
  'zand, matig':0.33,
  'zand, dicht':0.35,
  'zand, zeer dicht':0.35,
  'zand (lh), los':0.28,
  'zand (lh), matig':0.30,
  'zand (lh), dicht':0.32,
  'zand (lh), z.dicht':0.33,

  'grind, matig':0.33,
  'grind, dicht':0.35,
  'grind (kh), matig':0.30,
  'grind (kh), dicht':0.33
};

function mohrCoulombNuDefault(type, subtype){
  const key=(subtype||'').trim().toLowerCase();
  if(key && Object.prototype.hasOwnProperty.call(MC_NU_BY_SUBTYPE, key)) return MC_NU_BY_SUBTYPE[key];
  return MC_NU_BY_TYPE[type] ?? 0.30;
}

function mohrCoulombRShearDefault(type, subtype){
  const key=(subtype||'').trim().toLowerCase();
  if(key && Object.prototype.hasOwnProperty.call(MC_RSHEAR_BY_SUBTYPE, key)) return MC_RSHEAR_BY_SUBTYPE[key];
  return MC_RSHEAR_BY_TYPE[type] ?? 0.25;
}

/* Alpha Method B — SB260 family mapping driven by the selected EC7 subtype.
   Stage 4 uses layer avgQc; Stage 5 may pass row qc for pointwise fitting.
   Peat water content w is not available in the app, so veen defaults to α=1.5. */
/* ════════════════════════════════
   ALPHA METHOD B — SB260-21-6.4.10 Tabel 21-6-5
   
   Definitive subtype→rule-family mapping. Priority: subtype string first, then type.
   
   Cohesive:
   - veen, ...      → α=1.5 (w unknown in app)
   - klei, ...      → qc<0.7 => 5 ; 0.7-2 => 3 ; >=2 => 1.5
   - leem, ...      → qc<2 => 4 ; >=2 => 2

   Transition:
   - klei (zh), ... / leem (zh), ... / zand (lh), ...
     qc<2.5 => α=2 ; 2.5-5 => Es=4qc-5 ; >=5 => α=2

   Granular:
   - zand, ... / grind, ... / grind (kh), ...
     qc<=10 => Es=4qc ; 10-50 => Es=2qc+20 ; >50 => Es=120
════════════════════════════════ */
function sb260GranularAlpha(qc){
  if(qc <= 10) return 4.0;
  if(qc <= 50) return +(((2*qc) + 20) / qc).toFixed(3);
  return +(120 / qc).toFixed(3);
}

function sb260TransitionAlpha(qc){
  if(qc < 2.5) return 2.0;
  if(qc < 5.0) return +(((4*qc) - 5) / qc).toFixed(3);
  return 2.0;
}

function sb260AlphaFamily(type, subtype, rf){
  const sub=(subtype||'').toLowerCase();

  if(sub.includes('veen')) return 'cohesive-peat';
  if(sub.includes('klei (zh)')) return 'transition';
  if(sub.includes('leem (zh)')) return 'transition';
  if(sub.includes('zand (lh)')) return 'transition';
  if(sub.includes('grind (kh)')) return 'granular';
  if(sub.includes('grind')) return 'granular';
  if(sub.includes('zand')) return 'granular';
  if(sub.includes('klei')) return 'cohesive-clay';
  if(sub.includes('leem')) return 'cohesive-loam';

  // Fallback by type if no EC7 subtype is available.
  if(type==='Peat / organic') return 'cohesive-peat';
  if(type==='Gravel') return 'granular';
  if(type==='Sand'||type==='Silty sand'){
    if(rf != null && rf >= 1 && rf <= 2) return 'transition';
    return 'granular';
  }
  if(type==='Clay'||type==='Soft clay') return 'cohesive-clay';
  if(type==='Sandy clay') return 'cohesive-loam';
  return 'cohesive-clay';
}

function alphaEB(type, avgQc, subtype, avgRf){
  const qc = Math.max(avgQc||0.1, 0.01);
  const family = sb260AlphaFamily(type, subtype, avgRf);

  if(family==='transition') return sb260TransitionAlpha(qc);
  if(family==='granular') return sb260GranularAlpha(qc);
  if(family==='cohesive-peat') return 1.5;
  if(family==='cohesive-loam') return qc < 2.0 ? 4.0 : 2.0;
  if(family==='cohesive-clay') return qc < 0.7 ? 5.0 : (qc < 2.0 ? 3.0 : 1.5);

  return AE[type]||5.0;  // fallback Method A
}

/* ════════════════════════════════
   NAVIGATION
════════════════════════════════ */
function goS(n){
  // Track highest stage reached so nav tabs stay unlocked
  if(!S._maxStage) S._maxStage=0;
  if(n>S._maxStage) S._maxStage=n;
  const maxReached=S._maxStage;

  document.querySelectorAll('.panel').forEach((p,i)=>p.classList.toggle('active',i===n));
  document.querySelectorAll('.si').forEach((s,i)=>{
    s.classList.remove('active','locked','done');
    if(i===n) s.classList.add('active');
    else if(i<=maxReached) s.classList.add('done');  // all reached stages stay clickable
    else s.classList.add('locked');
  });
  if(n===2)renderLayers();
  if(n===3)renderModel();
  if(n===4)renderTuning();
  if(n===5)renderStage6();
}
document.querySelectorAll('.si').forEach(s=>{
  s.addEventListener('click',()=>{
    if(!s.classList.contains('locked'))goS(+s.dataset.s);
  });
});


/* ════════════════════════════════
   CPT FILE PARSERS
════════════════════════════════ */
function cptValueToMPa(raw, unit, fallbackKind){
  if(raw==null||isNaN(raw)) return null;
  const u=String(unit||'').toLowerCase();
  if(u.includes('mpa')) return raw;
  if(u.includes('kpa')) return raw/1000;
  if(u==='pa' || u.endsWith(' pa') || u.startsWith('pa ') || /\bpa\b/.test(u)) return raw/1e6;
  if(fallbackKind==='qc'){
    return raw>100?raw/1000:raw;
  }
  if(fallbackKind==='fs'){
    if(Math.abs(raw)>1000) return raw/1e6;
    if(Math.abs(raw)>10) return raw/1000;
  }
  return raw;
}

function parseCptNumber(value){
  if(value==null || value==='') return null;
  if(typeof value==='number') return Number.isFinite(value)?value:null;
  if(value instanceof Date) return null;
  let s=String(value).trim();
  if(!s) return null;
  s=s.replace(/\s/g,'');
  if(s.includes(',') && s.includes('.')){
    s=s.lastIndexOf(',')>s.lastIndexOf('.')
      ? s.replace(/\./g,'').replace(',','.')
      : s.replace(/,/g,'');
  }else{
    s=s.replace(',','.');
  }
  const n=Number(s);
  return Number.isFinite(n)?n:null;
}

function pad2(n){
  return String(n).padStart(2,'0');
}

function formatExcelHeaderValue(value, key=''){
  if(value==null) return '';
  if(value instanceof Date && !isNaN(value)){
    if(/tijd|time/i.test(key)){
      return `${pad2(value.getHours())}:${pad2(value.getMinutes())}:${pad2(value.getSeconds())}`;
    }
    return `${pad2(value.getDate())}/${pad2(value.getMonth()+1)}/${value.getFullYear()}`;
  }
  if(typeof value==='number'){
    return Number.isInteger(value)?String(value):String(value);
  }
  return String(value).trim();
}

function normalizeExcelLabel(value){
  return String(value||'')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'')
    .replace(/[^a-z0-9]+/g,' ');
}

function excelHeaderLookup(headerRows, labels){
  const wanted=labels.map(normalizeExcelLabel);
  for(const row of headerRows){
    const key=normalizeExcelLabel(row?.[0]);
    if(wanted.includes(key)) return row?.[1];
  }
  return null;
}

function excelHeaderText(headerRows, labels){
  const raw=excelHeaderLookup(headerRows, labels);
  const label=labels[0]||'';
  const text=formatExcelHeaderValue(raw,label);
  return text||null;
}

function excelHeaderNumber(headerRows, labels){
  return parseCptNumber(excelHeaderLookup(headerRows, labels));
}

function findExcelSheetName(workbook, preferredName){
  const wanted=normalizeExcelLabel(preferredName);
  return workbook.SheetNames.find(name=>normalizeExcelLabel(name)===wanted)
    || workbook.SheetNames.find(name=>normalizeExcelLabel(name).includes(wanted));
}

function findExcelDataHeaderRow(rows){
  const max=Math.min(rows.length,40);
  for(let i=0;i<max;i++){
    const labels=(rows[i]||[]).map(normalizeExcelLabel);
    const hasDepth=labels.some(isExcelDepthHeader);
    const hasQc=labels.some(isExcelQcHeader);
    if(hasDepth && hasQc) return i;
  }
  return -1;
}

function isExcelDepthHeader(label){
  return /\bdepth\b/.test(label) || /\bdiepte\b/.test(label) || /penetratie lengte/.test(label);
}

function isExcelQcHeader(label){
  return /\bqc\b/.test(label) || /cone resistance/.test(label) || /conus weerstand/.test(label);
}

function isExcelFsHeader(label){
  return /\bfs\b/.test(label) || /sleeve friction/.test(label) || /plaatselijke wrijving/.test(label);
}

function isExcelRfHeader(label){
  return /\brf\b/.test(label) || /friction ratio/.test(label) || /wrijvingsgetal/.test(label);
}

function findExcelColumn(headers, predicate){
  for(let i=0;i<headers.length;i++){
    if(predicate(normalizeExcelLabel(headers[i]))) return i;
  }
  return -1;
}

function loadXlsxModule(){
  if(!xlsxModulePromise){
    xlsxModulePromise=import('xlsx').then(module=>module.default?.read?module.default:module);
  }
  return xlsxModulePromise;
}

function applyParsedCpt({rows, meta, waterLevel, waterSource, elevation, elevationSource, x, y, coordinateSource}){
  if(!rows.length){alert('No valid data rows found.');return false;}

  S.data=rows;
  S.wt=waterLevel??1.5;
  S.wtFromFile=waterLevel!=null;
  S.wtSource=waterLevel!=null?(waterSource||'file'):null;
  S.elev=elevation;
  S.elevFromFile=elevation!=null;
  S.elevSource=elevation!=null?(elevationSource||'file'):null;
  if(x!=null && y!=null && (x!==0 || y!==0)){
    S.x=x;
    S.y=y;
  }else if(coordinateSource){
    S.x=null;
    S.y=null;
  }
  S.meta={...meta,nRows:rows.length,
    depthMin:rows[0].z,depthMax:rows[rows.length-1].z,
    hasU2:rows.some(r=>r.u2!=null)};

  // Sync controls
  document.getElementById('wtR').value=S.wt;
  document.getElementById('wtN').value=S.wt.toFixed(2);
  document.getElementById('elevN').value=S.elev!=null?S.elev.toFixed(2):'';
  const cptXEl=document.getElementById('cptX');
  const cptYEl=document.getElementById('cptY');
  if(cptXEl) cptXEl.value=S.x!=null?S.x:'';
  if(cptYEl) cptYEl.value=S.y!=null?S.y:'';
  updateElevSrc(); updateWTDisplay();

  renderMeta();
  document.getElementById('s1body').style.display='block';
  requestAnimationFrame(()=>initCharts());
  return true;
}

async function parseExcelCpt(buffer,fname){
  const XLSX=await loadXlsxModule();
  let workbook;
  try{
    workbook=XLSX.read(buffer,{type:'array',cellDates:true});
  }catch(err){
    alert(`Could not read Excel workbook: ${err?.message||err}`);
    return false;
  }

  const dataSheetName=findExcelSheetName(workbook,'Data') || workbook.SheetNames[0];
  const headerSheetName=findExcelSheetName(workbook,'Header');
  const dataSheet=workbook.Sheets[dataSheetName];
  if(!dataSheet){alert('No data sheet found in Excel workbook.');return false;}

  const dataRows=XLSX.utils.sheet_to_json(dataSheet,{header:1,raw:true,defval:null,blankrows:false});
  const headerRows=headerSheetName
    ? XLSX.utils.sheet_to_json(workbook.Sheets[headerSheetName],{header:1,raw:true,defval:null,blankrows:false})
    : [];

  const headerIdx=findExcelDataHeaderRow(dataRows);
  if(headerIdx<0){alert('Could not find depth/qc columns in the Excel data sheet.');return false;}

  const headers=dataRows[headerIdx]||[];
  const zCol=findExcelColumn(headers,isExcelDepthHeader);
  const qcCol=findExcelColumn(headers,isExcelQcHeader);
  const fsCol=findExcelColumn(headers,isExcelFsHeader);
  const rfCol=findExcelColumn(headers,isExcelRfHeader);
  if(zCol<0 || qcCol<0){alert('Excel data sheet needs at least depth and qc columns.');return false;}

  const rows=[];
  const qcUnit=headers[qcCol]||'';
  const fsUnit=fsCol>=0?(headers[fsCol]||''):'';
  for(let i=headerIdx+1;i<dataRows.length;i++){
    const raw=dataRows[i]||[];
    const z=parseCptNumber(raw[zCol]);
    const qcRaw=parseCptNumber(raw[qcCol]);
    const fsRaw=fsCol>=0?parseCptNumber(raw[fsCol]):null;
    const rfRaw=rfCol>=0?parseCptNumber(raw[rfCol]):null;
    if(z==null||qcRaw==null||z<0) continue;

    const qc=cptValueToMPa(qcRaw,qcUnit,'qc');
    const fs=fsRaw!=null?cptValueToMPa(fsRaw,fsUnit,'fs'):null;
    if(qc==null||qc<0.02) continue;

    let rf=null;
    if(rfRaw!=null&&rfRaw>=0&&rfRaw<50){
      rf=Math.min(rfRaw,20);
    }else if(fs!=null&&qc>0.05){
      rf=Math.max(0,Math.min(20,(Math.abs(fs)/qc)*100));
    }

    rows.push({z:+z.toFixed(4),qc:+qc.toFixed(4),
      fs:fs!=null?+fs.toFixed(6):null,
      rf:rf!=null?+rf.toFixed(3):null,u2:null});
  }
  rows.sort((a,b)=>a.z-b.z);

  const water=excelHeaderNumber(headerRows,['Waterniveau','Water level']);
  const elevation=excelHeaderNumber(headerRows,['Grondniveau','Surface level','Ground level','ZID']);
  const x=excelHeaderNumber(headerRows,['E Coordinate','X Coordinate','Easting']);
  const y=excelHeaderNumber(headerRows,['N Coordinate','Y Coordinate','Northing']);
  const aRatio=excelHeaderNumber(headerRows,['Alpha Factor','Alpha','Area ratio']) ?? 0.8;
  const betaFactor=excelHeaderNumber(headerRows,['Beta Factor','Beta']);
  const project=excelHeaderText(headerRows,['Taak Nummer','Project','Project ID']);
  const testid=excelHeaderText(headerRows,['Sondering Nummer','Test ID','CPT ID']);
  const client=excelHeaderText(headerRows,['Client Naam','Client Name','File owner']);
  const operator=excelHeaderText(headerRows,['Operator']);
  const location=excelHeaderText(headerRows,['Locatie','Location']);
  const date=excelHeaderText(headerRows,['Datum','Date']);
  const coneNumber=excelHeaderText(headerRows,['Conus Nummer','Cone Number']);
  const penetrationDepth=excelHeaderNumber(headerRows,['Penetratiediepte','Penetration depth']);

  return applyParsedCpt({
    rows,
    waterLevel:water!=null?Math.abs(water):null,
    waterSource:water!=null?'Header Waterniveau':null,
    elevation,
    elevationSource:elevation!=null?'Header Grondniveau':null,
    x,
    y,
    coordinateSource:(x!=null||y!=null)?'Header coordinates':null,
    meta:{
      fname,
      importFormat:'Excel',
      project,
      testid,
      client,
      owner:client||operator,
      operator,
      location,
      date,
      coneNumber,
      penetrationDepth,
      aRatio,
      betaFactor,
      zid:elevation
    }
  });
}

function splitDelimitedLine(line, delimiter){
  const cells=[];
  let cell='';
  let quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==='"'){
      if(quoted && line[i+1]==='"'){
        cell+='"';
        i++;
      }else{
        quoted=!quoted;
      }
    }else if(ch===delimiter && !quoted){
      cells.push(cell.trim());
      cell='';
    }else{
      cell+=ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseDelimitedText(text, delimiter){
  return String(text||'')
    .replace(/^\uFEFF/,'')
    .split(/\r?\n/)
    .map(line=>splitDelimitedLine(line, delimiter))
    .filter(row=>row.some(cell=>String(cell||'').trim()!==''));
}

function detectDelimitedTextSeparator(text){
  const sample=String(text||'')
    .replace(/^\uFEFF/,'')
    .split(/\r?\n/)
    .filter(line=>line.trim())
    .slice(0,20);
  const delimiters=[',',';','\t'];
  let best={delimiter:',',score:-Infinity};
  for(const delimiter of delimiters){
    const rows=sample.map(line=>splitDelimitedLine(line, delimiter));
    const headerIdx=findExcelDataHeaderRow(rows);
    const maxCols=Math.max(...rows.map(row=>row.length),0);
    const avgCols=rows.length?rows.reduce((sum,row)=>sum+row.length,0)/rows.length:0;
    const score=(headerIdx>=0?100:0) + maxCols*3 + avgCols;
    if(score>best.score) best={delimiter,score};
  }
  return best.delimiter;
}

function parseCsvCpt(text,fname){
  const delimiter=detectDelimitedTextSeparator(text);
  const tableRows=parseDelimitedText(text, delimiter);
  const headerIdx=findExcelDataHeaderRow(tableRows);
  if(headerIdx<0){alert('Could not find depth/qc columns in the CSV file.');return false;}

  const headers=tableRows[headerIdx]||[];
  const zCol=findExcelColumn(headers,isExcelDepthHeader);
  const qcCol=findExcelColumn(headers,isExcelQcHeader);
  const fsCol=findExcelColumn(headers,isExcelFsHeader);
  const rfCol=findExcelColumn(headers,isExcelRfHeader);
  if(zCol<0 || qcCol<0){alert('CSV file needs at least depth and qc columns.');return false;}

  const rows=[];
  const qcUnit=headers[qcCol]||'';
  const fsUnit=fsCol>=0?(headers[fsCol]||''):'';
  for(let i=headerIdx+1;i<tableRows.length;i++){
    const raw=tableRows[i]||[];
    const z=parseCptNumber(raw[zCol]);
    const qcRaw=parseCptNumber(raw[qcCol]);
    const fsRaw=fsCol>=0?parseCptNumber(raw[fsCol]):null;
    const rfRaw=rfCol>=0?parseCptNumber(raw[rfCol]):null;
    if(z==null||qcRaw==null||z<0) continue;

    const qc=cptValueToMPa(qcRaw,qcUnit,'qc');
    const fs=fsRaw!=null?cptValueToMPa(fsRaw,fsUnit,'fs'):null;
    if(qc==null||qc<0.02) continue;

    let rf=null;
    if(rfRaw!=null&&rfRaw>=0&&rfRaw<50){
      rf=Math.min(rfRaw,20);
    }else if(fs!=null&&qc>0.05){
      rf=Math.max(0,Math.min(20,(Math.abs(fs)/qc)*100));
    }

    rows.push({z:+z.toFixed(4),qc:+qc.toFixed(4),
      fs:fs!=null?+fs.toFixed(6):null,
      rf:rf!=null?+rf.toFixed(3):null,u2:null});
  }
  rows.sort((a,b)=>a.z-b.z);

  return applyParsedCpt({
    rows,
    waterLevel:null,
    elevation:null,
    meta:{
      fname,
      importFormat:'CSV',
      project:null,
      testid:stripCptFileExtension(fname),
      owner:null,
      location:null,
      date:null,
      aRatio:0.8,
      zid:null
    }
  });
}

/* ════════════════════════════════
   GEF PARSER
════════════════════════════════ */
function parseGEF(txt,fname){
  const lines=txt.split(/\r?\n/);
  const colMap={};  // quantityID → 0-based col index
  const unitMap={}; // quantityID → declared unit string from COLUMNINFO
  let eoh=false, wl=null, zid=null, aRatio=0.8;
  const meta={fname};
  const rows=[];

  for(const raw of lines){
    const l=raw.trim();
    if(!l)continue;
    if(l.toUpperCase().startsWith('#EOH')){eoh=true;continue;}

    if(!eoh){
      if(l.startsWith('#COLUMNINFO')){
        // format: #COLUMNINFO= colIndex, unit, description, quantityID
        const rest=l.slice(l.indexOf('=')+1).split(',');
        if(rest.length>=4){
          const ci=parseInt(rest[0].trim())-1;
          const unit=(rest[1]||'').trim();
          const qi=parseInt(rest[3].trim());
          if(!isNaN(ci)&&!isNaN(qi)){
            colMap[qi]=ci;
            unitMap[qi]=unit;
          }
        }
      }
      if(l.startsWith('#MEASUREMENTVAR')){
        const m=l.match(/#MEASUREMENTVAR\s*=\s*(\d+)\s*,\s*([\-\d.eE+]+)/);
        if(m){
          const id=+m[1],val=parseFloat(m[2]);
          if(id===14&&!isNaN(val))wl=Math.abs(val);   // water table depth
          if(id===3 &&!isNaN(val))aRatio=val;           // net area ratio
        }
      }
      if(l.startsWith('#ZID')){
        const m=l.match(/#ZID\s*=\s*[^,]+,\s*([\-\d.eE+]+)/);
        if(m)zid=parseFloat(m[1]);
      }
      if(l.startsWith('#PROJECTID'))  meta.project=l.split('=')[1].trim();
      if(l.startsWith('#TESTID'))     meta.testid=l.split('=')[1].trim();
      if(l.startsWith('#STARTDATE'))  meta.date=l.split('=')[1].trim();
      if(l.startsWith('#FILEOWNER'))  meta.owner=l.split('=')[1].trim();
      if(l.startsWith('#MEASUREMENTTEXT')&&/lokatie|location/i.test(l)){
        const m=l.match(/=\s*\d+\s*,\s*([^,]+)/);
        if(m)meta.location=m[1].trim();
      }
      continue;
    }

    if(l.startsWith('!'))continue;
    const parts=l.split(/\s+/).filter(Boolean);
    if(parts.length<2)continue;
    let vals;try{vals=parts.map(Number);}catch(e){continue;}
    if(vals.some(v=>isNaN(v)))continue;

    function get(qid){const ci=colMap[qid];return(ci!=null&&ci<vals.length)?vals[ci]:null;}
    function unitFor(qid){return (unitMap[qid]||'').toLowerCase();}

    const z=get(11)??get(1);   // prefer corrected depth
    const qc_v=get(2);
    const fs_v=get(3);
    const rf_v=get(4);         // % as declared
    const u2_v=get(6);

    if(z==null||qc_v==null||isNaN(z)||isNaN(qc_v)||z<0)continue;

    const qc=cptValueToMPa(qc_v, unitFor(2), 'qc');
    const fs=cptValueToMPa(fs_v, unitFor(3), 'fs');

    let rf=null;
    if(rf_v!=null&&!isNaN(rf_v)&&rf_v>=0&&rf_v<50){
      rf=Math.min(rf_v,20);
    } else if(fs!=null&&qc>0.05){
      rf=Math.max(0,Math.min(20,(Math.abs(fs)/qc)*100));
    }

    const u2=u2_v!=null&&!isNaN(u2_v)?u2_v:null;
    if(qc<0.02)continue;  // cone not engaged

    rows.push({z:+z.toFixed(4),qc:+qc.toFixed(4),
      fs:fs!=null?+fs.toFixed(6):null,
      rf:rf!=null?+rf.toFixed(3):null,u2});
  }

  return applyParsedCpt({
    rows,
    waterLevel:wl,
    waterSource:wl!=null?'MEASUREMENTVAR 14':null,
    elevation:zid,
    elevationSource:zid!=null?'ZID':null,
    meta:{...meta,importFormat:'GEF',aRatio,zid}
  });
}

function updateElevSrc(){
  const src=S.elevSource || 'ZID';
  document.getElementById('elev-src').textContent=
    S.elevFromFile?`(from ${src})`:S.elev!=null?'(manually set)':'(not set — enter for TAW output)';
}
function updateWTDisplay(){
  document.getElementById('wt-src').textContent=S.wtFromFile?`(${S.wtSource || 'file'})`:'(default)';
  const tawEl=document.getElementById('wt-taw');
  if(S.elev!=null){
    const wtTaw=(S.elev-S.wt).toFixed(2);
    tawEl.textContent=`= ${wtTaw} m TAW`;
  }else{tawEl.textContent='';}
}

function renderMeta(){
  const m=S.meta, d=S.data;
  const maxQc=d.reduce((mx,r)=>Math.max(mx,r.qc),0).toFixed(2);
  const items=[
    {l:'Project',v:m.project||'—'},{l:'Test ID',v:m.testid||'—'},
    {l:'Location',v:m.location||'—'},{l:'Owner',v:m.owner||'—'},
    {l:'Date',v:m.date||'—'},{l:'Readings',v:m.nRows},
    {l:'Depth (m)',v:`${(+m.depthMin).toFixed(2)}–${(+m.depthMax).toFixed(2)}`},
    {l:'Surface (m TAW)',v:m.zid!=null?m.zid.toFixed(2):'—'},
    {l:'Area ratio a',v:m.aRatio.toFixed(3)},
    {l:'Pore pres. u2',v:m.hasU2?'Present':'—'},
    {l:'max qc (MPa)',v:maxQc},
  ];
  document.getElementById('mgrid').innerHTML=items.map(i=>
    `<div class="mi"><div class="mi-l">${i.l}</div><div class="mi-v">${i.v}</div></div>`).join('');
  document.getElementById('finfo').textContent=`${m.fname||''} — ${m.nRows} readings`;
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
    const maxQc=arrMax(d.map(r=>r.qc));
    const maxFs=arrMax(d.map(r=>r.fs!=null?r.fs*1000:0));
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
  const d=S.data;
  const depths=d.map(r=>r.z);
  const maxZ=arrMax(depths)+0.5;
  const qcs=arrSafe(d.map(r=>r.qc));
  const fss=arrSafe(d.map(r=>r.fs!=null?r.fs*1000:null));
  const rfs=arrSafe(d.map(r=>r.rf??null));
  const maxQc=Math.max(1,arrMax(qcs))*1.15;
  const maxFs=Math.max(10,arrMax(fss))*1.15;
  const wt=S.wt;

  function ptData(vals){return depths.map((z,i)=>({x:vals[i],y:z}));}
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

  // Layer column SVG (placeholder before classification)
  drawLayerColumnSvg('layerColSvg',[],maxZ);
}

function refreshChartData(){
  // Called if a new file is loaded after charts exist
  const d=S.data;
  const depths=d.map(r=>r.z);
  const qcs=arrSafe(d.map(r=>r.qc));
  const fss=arrSafe(d.map(r=>r.fs!=null?r.fs*1000:null));
  const rfs=arrSafe(d.map(r=>r.rf??null));
  const maxZ=arrMax(depths)+0.5;
  const maxQc=Math.max(1,arrMax(qcs))*1.15;
  const maxFs=Math.max(10,arrMax(fss))*1.15;

  function ptData(vals){return depths.map((z,i)=>({x:vals[i],y:z}));}
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
    showRf:true
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
  const rows=[];
  for(let z=0.14;z<=21.73;z=+(z+0.02).toFixed(3)){
    let qc,rf;
    if(z<0.6)      {qc=0.15+Math.random()*0.12;rf=0.7+Math.random()*0.4;}
    else if(z<1.5) {qc=3+Math.random()*2.5;   rf=0.5+Math.random()*0.4;}
    else if(z<3.0) {qc=7+Math.random()*3;     rf=0.8+Math.random()*0.7;}
    else if(z<5.5) {qc=1.2+Math.random()*1;   rf=4+Math.random()*3;}
    else if(z<7.0) {qc=1.5+Math.random()*0.8; rf=3.5+Math.random()*2;}
    else if(z<9.5) {qc=4+Math.random()*4;     rf=1.2+Math.random()*0.8;}
    else if(z<11)  {qc=2+Math.random()*1;     rf=3+Math.random()*2;}
    else           {qc=3.5+Math.random()*5;   rf=1.5+Math.random()*2;}
    const fs=qc*rf/100;
    rows.push({z,qc:+qc.toFixed(4),fs:+fs.toFixed(6),rf:+rf.toFixed(3),u2:null});
  }
  S.data=rows; S.wt=1.7; S.wtFromFile=true;
  S.wtSource='demo';
  S.elev=69.97; S.elevFromFile=true; S.elevSource='demo';
  S.meta={project:'Demo Project A',testid:'CPT-1 (demo)',location:'Reference site — anonymised',owner:'Anonymous source',
    date:'2025, 7, 7',aRatio:0.79,zid:69.97,fname:'demo-anonymous.GEF',
    nRows:rows.length,depthMin:0.14,depthMax:21.73,hasU2:false};
  document.getElementById('wtR').value=1.7;
  document.getElementById('wtN').value='1.70';
  document.getElementById('elevN').value='69.97';
  updateElevSrc(); updateWTDisplay();
  renderMeta();
  document.getElementById('s1body').style.display='block';
  requestAnimationFrame(()=>initCharts());
}

/* ════════════════════════════════
   FILE LOAD
════════════════════════════════ */
function loadSingleGEF(evt){
  const f=evt.target.files[0]; if(!f)return;
  const r=new FileReader();
  r.onload=e=>parseGEF(e.target.result,f.name);
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
function classificationMethodLabel(method){
  return {
    robertson:'Robertson (1990)',
    robertson2016:'Robertson (2016)',
    cur3:'CUR 3 layers',
    nen6740:'NEN 6740',
    sb260:'NEN Tabel 3 / EC7'
  }[method] || method || 'Unknown';
}

function classificationMetricLabel(method){
  if(method === 'robertson') return 'Ic (-)';
  if(method === 'robertson2016') return 'Qtn (-)';
  if(method === 'nen6740') return 'qc,NEN (MPa)';
  return 'Metric (-)';
}

function classificationMetricValue(method, row){
  if(method === 'robertson') return row.Ic != null ? row.Ic : '—';
  if(method === 'robertson2016') return row.Qt != null ? row.Qt.toFixed(1) : '—';
  if(method === 'nen6740') return row.Qt != null ? row.Qt.toFixed(2) : '—';
  return '—';
}

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
  /* Correct effective stress accounting for water table position.
     Above WT: use gamma_unsat (unsaturated unit weight = gamma, Stage 3).
     Below WT: use gamma_sat.
     If gamma_unsat not supplied, falls back to gamma_sat for both zones
     (conservative, used during Stage 2 classification where only gamma=18 known). */
  const wt = S.wt;
  const gu = gamma_unsat ?? gamma_sat; // fallback
  let sigV;
  if(z <= wt){
    sigV = gu * z;
  } else {
    sigV = gu * wt + gamma_sat * (z - wt);
  }
  const u = z > wt ? 9.81 * (z - wt) : 0;
  return{sigV: +sigV.toFixed(2), u: +u.toFixed(2), sigVeff: Math.max(sigV - u, 1)};
}

/* ════════════════════════════════
   CLASSIFICATION
════════════════════════════════ */

/* ════════════════════════════════
   CLASSIFICATION — Robertson (1990) SBT
   
   Source: Robertson, P.K. (1990). Soil classification using the CPT.
   Canadian Geotechnical Journal, 27(1), 151-158.
   
   Uses the Soil Behaviour Type (SBT) index Ic and the normalised
   Robertson chart. Nine zones mapped to practical soil types.
   
   STRESS NORMALISATION:
     Qt = (qc - σv0) / σ'v0        (dimensionless, cone resistance ratio)
     Fr = fs / (qc - σv0) × 100    (%, normalised friction ratio)
     Ic = √((3.47 - log Qt)² + (log Fr + 1.22)²)
   
   IC ZONE BOUNDARIES (Robertson 1990):
     Ic > 3.60  → Zone 2: Organic soils — clay / peat
     Ic > 2.95  → Zone 3: Clays — silty clay to clay
     Ic > 2.60  → Zone 4: Silt mixtures — clayey silt to silty clay
     Ic > 2.05  → Zone 5: Sand mixtures — silty sand to sandy silt
     Ic > 1.31  → Zone 6: Sands — clean sand to silty sand
     Ic ≤ 1.31  → Zone 7: Gravelly sand to dense sand
     (Zone 1 "sensitive fine-grained" is not defined by an Ic band alone.)
   
   MAPPING to app soil types:
     Zone 2 → Peat / organic
     Zone 3 → Clay
     Zone 4 → Sandy clay
     Zone 5 → Silty sand
     Zone 6 → Sand
     Zone 7 → Gravel
   Sensitive / structured fine-grained soils require judgement outside the
   Ic bands and are not inferred here from Ic alone.
════════════════════════════════ */
function classRob(r){
  const {sigV, sigVeff} = stressAt(r.z, 18, 17);
  const aRatio = S.meta?.aRatio ?? 0.8;
  const qtCone = r.u2 != null ? (r.qc + (1 - aRatio) * r.u2) : r.qc; // qt in MPa
  const dQ = qtCone - sigV/1000;   // qt - σv0 [MPa]

  // Guard: if stress or net resistance is negligible, default to Clay
  if(dQ < 0.01 || sigVeff < 1)
    return{type:'Clay', subtype:'', Ic:2.80, Qt:null, g:null,gs:null,phi:null,c:null,cu:null};

  // Qt = (qt - σv0) / σ'v0  — both in MPa
  const Qt = Math.max(0.1, dQ / (sigVeff / 1000));

  // Fr = fs / (qt - σv0) × 100  [%]
  // If fs not available, estimate sleeve friction from qt and Rf.
  const fs_eff = r.fs != null ? r.fs : qtCone * (r.rf ?? 3) / 100;
  const Fr = Math.max(0.1, Math.min(10, (Math.abs(fs_eff) / dQ) * 100));

  // Ic = √((3.47 - log Qt)² + (log Fr + 1.22)²)
  const Ic = Math.sqrt((3.47 - Math.log10(Qt))**2 + (Math.log10(Fr) + 1.22)**2);

  // Zone 7 check (gravelly sand / dense sand) — BEFORE Ic zones
  // Robertson charts place very high Qt with very low Fr in the gravelly/dense range.
  const isZone7 = (Qt > 200 && Fr < 0.5);

  let type;
  if(isZone7)    type = 'Gravel';              // Zone 7: gravelly sand/dense sand
  else if(Ic > 3.60) type = 'Peat / organic';  // Zone 2: organic soils-clay / peat
  else if(Ic > 2.95) type = 'Clay';            // Zone 3: clay to silty clay
  else if(Ic > 2.60) type = 'Sandy clay';      // Zone 4: silt mixtures
  else if(Ic > 2.05) type = 'Silty sand';      // Zone 5: sand mixtures
  else               type = 'Sand';            // Zone 6: sands

  return{type, subtype:'', Ic:+Ic.toFixed(2), Qt:+Qt.toFixed(1),
         g:null, gs:null, phi:null, c:null, cu:null};
}

/* ════════════════════════════════
   CLASSIFICATION — Robertson (2016) SBT

   Uses the Robertson 2016 iterative Qtn normalisation while keeping the
   existing Ic-based app mapping to broad soil families.
════════════════════════════════ */
function classRob2016(r){
  const {sigV, sigVeff} = stressAt(r.z, 18, 17);
  const aRatio = S.meta?.aRatio ?? 0.8;
  const pa = 100;
  const qtCone = r.u2 != null ? (r.qc + (1 - aRatio) * r.u2) : r.qc; // qt in MPa
  const qtKPa = qtCone * 1000;
  const dQKPa = qtKPa - sigV;

  if(dQKPa < 10 || sigVeff < 1)
    return{type:'Clay', subtype:'', Ic:2.80, Qt:null, g:null,gs:null,phi:null,c:null,cu:null};

  const fsKPa = r.fs != null ? (r.fs * 1000) : (qtKPa * (r.rf ?? 3) / 100);
  const Fr = Math.max(0.1, Math.min(10, (Math.abs(fsKPa) / dQKPa) * 100));

  let n = 1.0;
  let Qtn = 0.1;
  let Ic = 2.8;
  for(let i=0;i<10;i++){
    Qtn = Math.max(0.1, (dQKPa / pa) * Math.pow(pa / sigVeff, n));
    Ic = Math.sqrt((3.47 - Math.log10(Qtn))**2 + (Math.log10(Fr) + 1.22)**2);
    const nNew = Math.max(0.5, Math.min(1.0, 0.381 * Ic + 0.05 * (sigVeff / pa) - 0.15));
    if(Math.abs(nNew - n) < 0.001){
      n = nNew;
      break;
    }
    n = nNew;
  }

  Qtn = Math.max(0.1, (dQKPa / pa) * Math.pow(pa / sigVeff, n));
  Ic = Math.sqrt((3.47 - Math.log10(Qtn))**2 + (Math.log10(Fr) + 1.22)**2);

  const isZone7 = (Qtn > 200 && Fr < 0.5);

  let type;
  if(isZone7)         type = 'Gravel';
  else if(Ic > 3.60) type = 'Peat / organic';
  else if(Ic > 2.95) type = 'Clay';
  else if(Ic > 2.60) type = 'Sandy clay';
  else if(Ic > 2.05) type = 'Silty sand';
  else               type = 'Sand';

  return{type, subtype:'', Ic:+Ic.toFixed(2), Qt:+Qtn.toFixed(1),
         g:null, gs:null, phi:null, c:null, cu:null};
}

/* ════════════════════════════════
   CLASSIFICATION — CUR 3 layers

   Source: PLAXIS Reference Manual, "CUR 3 layers method" chart.

   This is a broad layering rule, not a detailed parameter catalogue.
   The published chart contains four fields:
     - Sand
     - Silt
     - Clay
     - Peat

   The app keeps downstream compatibility with the existing parameter
   workflow by carrying the intermediate "Silt" field as the app's
   intermediate type "Sandy clay", with subtype marker "CUR3 silt".

   Implemented chart zones:
     - Sand: Rf < 1.5% and qc ≥ 1.5 MPa
     - Silt: Rf < 2.5% and qc ≥ 0.5 MPa
     - Clay: Rf ≤ 5.0% and qc ≥ 0.2 MPa
     - Peat: all remaining points

   The chart is implemented as nested zones checked from the most
   specific region to the broadest:
     1. Sand
     2. Silt
     3. Clay
     4. Peat (complement of the three zones above)
════════════════════════════════ */
function classCUR3(r){
  const qc = r.qc;
  const rf = r.rf != null ? r.rf : 3.0;

  if(rf < 1.5 && qc >= 1.5)
    return{type:'Sand', subtype:'CUR3 sand', Ic:null, Qt:null,
           g:null,gs:null,phi:null,c:null,cu:null};

  if(rf < 2.5 && qc >= 0.5)
    return{type:'Sandy clay', subtype:'CUR3 silt', Ic:null, Qt:null,
           g:null,gs:null,phi:null,c:null,cu:null};

  if(rf <= 5.0 && qc >= 0.2)
    return{type:'Clay', subtype:'CUR3 clay', Ic:null, Qt:null,
           g:null,gs:null,phi:null,c:null,cu:null};

  return{type:'Peat / organic', subtype:'', Ic:null, Qt:null,
         g:null,gs:null,phi:null,c:null,cu:null};
}

const classCUR = classCUR3;

/* ════════════════════════════════
   CLASSIFICATION — NEN 6740 (stress dependent)

   Source: NEN 6740 chart as reproduced in D-SHEET Piling and related
   engineering manuals. The source is a 14-area semilog chart rather
   than a closed algebraic decision tree.

   The app therefore implements a transparent fixed discretisation:
     1. compute stress-corrected q_c,NEN
     2. compute chart score = log10(q_c,NEN) - 0.34 * R_f
     3. choose the nearest of the 14 published material areas

   The 14 area centres are digitised from the published chart and tied
   to the representative NEN material set commonly used by software
   implementations of the rule.

   Provenance:
   - the stress correction exponent 0.67 follows the Deltares D-SHEET
     Piling manual for the NEN (Stress Dependent) rule;
   - the RF slope 0.34 is an app-side regression fit through the 14
     digitised centres, not a published NEN coefficient. It replaced the
     earlier 0.18 slope after audit validation showed that 0.18 collapsed
     the boundary between the stored areas 5 and 6 into a near tie.
════════════════════════════════ */
function classNEN6740(r){
  const rf = r.rf != null ? r.rf : 3.0;
  const {sigVeff} = stressAt(r.z, 18, 17);
  const { area:best, qcNen } = classifyNen6740Reading({ qc:r.qc, rf, sigVeff });

  return{
    type:best.type,
    subtype:best.subtype,
    g:best.g, gs:best.gs, phi:best.phi, c:best.c, cu:best.cu,
    Ic:null, Qt:+qcNen.toFixed(2)
  };
}

/* ════════════════════════════════
   CLASSIFICATION — Eurocode / NEN Tabel 3
   "Karakteristieke grondparameters op basis van de resultaten
   uit een elektrische sondering"
   
   The Eurocode table contains overlapping qc/Rf envelopes.
   For deterministic classification the implementation checks the exact
   table rows in table order:
     grind → zand → leem → klei → veen
   and, within each group, top-to-bottom row order.
   Range handling follows the table notation exactly:
     qc lower bound inclusive, upper bound exclusive
     Rf < 1 and Rf > 6 are strict
     banded Rf ranges (1–2, 2–4, 2–5, 3–6) are inclusive.
════════════════════════════════ */
function classSB260(r){
  const qc = r.qc;
  const rf = r.rf != null ? r.rf : null;

  for(const entry of EUROCODE_CLASS_ENTRIES){
    if(eurocodeEntryMatches(entry, qc, rf)){
      return{
        type:entry.type, subtype:entry.subtype,
        g:entry.g, gs:entry.gs, phi:entry.phi, c:entry.c, cu:entry.cu,
        Ic:null, Qt:null
      };
    }
  }

  // Table 3 does not cover every possible CPT reading.
  // Keep a deterministic fallback for out-of-table values.
  if(qc < 0.4){
    return{type:'Sandy clay', subtype:'leem, weinig vast',
      g:17, gs:17, phi:22, c:0, cu:10, Ic:null, Qt:null};
  }
  return{type:'Sand', subtype:'zand, los',
    g:16, gs:18, phi:27, c:0, cu:0, Ic:null, Qt:null};
}

/* ════════════════════════════════
   CLASSIFICATION RUN
════════════════════════════════ */
function runClass(){
  if(!S.data.length){alert('Laad eerst een GEF bestand.');return;}

  S.useSB260params=(S.method==='sb260');

  S.classified=S.data.map(r=>{
    let res;
    if(S.method==='robertson')     res=classRob(r);
    else if(S.method==='robertson2016') res=classRob2016(r);
    else if(S.method==='cur3')     res=classCUR3(r);
    else if(S.method==='nen6740')  res=classNEN6740(r);
    else                           res=classSB260(r);
    return Object.assign({},r,res);
  });

  const cl=S.classified;
  const n=cl.length;
  const avgOf=(fn,flt)=>{
    const rows=flt?cl.filter(flt):cl;
    return rows.length?rows.reduce((s,x)=>s+fn(x),0)/rows.length:0;
  };

  document.getElementById('cmet').innerHTML=[
    {l:'avg qc (MPa)',  v:avgOf(r=>r.qc).toFixed(2)},
    {l:'avg fs (kPa)',  v:(avgOf(r=>r.fs||0,r=>r.fs!=null)*1000).toFixed(1)},
    {l:'avg Rf (%)',    v:avgOf(r=>r.rf||0,r=>r.rf!=null).toFixed(2)},
    {l:'max depth (m)', v:cl[n-1].z.toFixed(2)},
    {l:'readings',      v:n},
    {l:'method',        v:classificationMethodLabel(S.method)}
  ].map(m=>`<div class="met"><div class="met-l">${m.l}</div><div class="met-v">${m.v}</div></div>`).join('');

  const taw=z=>S.elev!=null?(S.elev-z).toFixed(2):'—';
  const metricHead=document.getElementById('cmetricHead');
  if(metricHead) metricHead.innerHTML=classificationMetricLabel(S.method);
  document.getElementById('cbody').innerHTML=cl.map(r=>`<tr>
    <td>${r.z.toFixed(3)}</td>
    <td style="color:var(--tx2)">${taw(r.z)}</td>
    <td>${r.qc.toFixed(3)}</td>
    <td>${r.fs!=null?(r.fs*1000).toFixed(2):'—'}</td>
    <td>${r.rf!=null?r.rf.toFixed(2):'—'}</td>
    <td><span class="sb ${SC[r.type]||'s-sand'}">${r.type}</span></td>
    <td style="font-size:10px;color:var(--tx2)">${r.subtype||'—'}</td>
    <td style="color:var(--tx3)">${classificationMetricValue(S.method, r)}</td>
  </tr>`).join('');

  document.getElementById('classLayout').style.display='';
  detectLayers();
  renderLayerPreviewSvg('layerPreviewSvg');
  drawLayerColumnSvg('layerColSvg',S.layers,S.data[S.data.length-1].z+0.5);
  document.getElementById('minThkInfo').textContent='-> '+S.layers.length+' layers';
  document.getElementById('btnToLayers').style.display='';
}

/* ════════════════════════════════
   LAYER DETECTION
════════════════════════════════ */
function segmentSummary(seg, prevSeg){
  const r=seg.rows.filter(x=>x.qc>0.02);
  const rows=r.length?r:seg.rows;
  const top=segmentTop(seg, prevSeg);
  const bot=+seg.rows[seg.rows.length-1].z.toFixed(3);
  const avgQc=+(rows.reduce((s,x)=>s+x.qc,0)/rows.length).toFixed(3);
  const fsR=rows.filter(x=>x.fs!=null);
  const avgFs=fsR.length?+(fsR.reduce((s,x)=>s+x.fs,0)/fsR.length).toFixed(5):null;
  const rfR=rows.filter(x=>x.rf!=null);
  const avgRf=rfR.length?+(rfR.reduce((s,x)=>s+(x.rf??0),0)/rfR.length).toFixed(2):null;
  const subtypeCounts={};
  seg.rows.forEach(row=>{const st=row.subtype||'';subtypeCounts[st]=(subtypeCounts[st]||0)+1;});
  const subtype=Object.keys(subtypeCounts).sort((a,b)=>subtypeCounts[b]-subtypeCounts[a])[0]||'';
  let g,gs,phi,c,cu;
  if(S.useSB260params){
    const vr=seg.rows.filter(x=>x.g!=null);
    if(vr.length){
      const avg2=fn=>+(vr.reduce((s,x)=>s+fn(x),0)/vr.length).toFixed(1);
      g=+avg2(x=>x.g); gs=+avg2(x=>x.gs); phi=+avg2(x=>x.phi); c=+avg2(x=>x.c); cu=+avg2(x=>x.cu);
    }else{
      const df=DEF[seg.type]||DEF['Sand']; g=df.g; gs=df.gs; phi=df.phi; c=df.c; cu=df.cu;
    }
  }else{
    const df=DEF[seg.type]||DEF['Sand']; g=df.g; gs=df.gs; phi=df.phi; c=df.c; cu=df.cu;
  }
  return{type:seg.type,subtype,avgQc,avgFs,avgRf,g,gs,phi,c,cu,top,bot,thk:+(bot-top).toFixed(3),rows:seg.rows.length};
}

function segmentTop(seg, prevSeg){
  if(!seg) return 0;
  if(seg._top!=null) return +(+seg._top).toFixed(3);
  if(seg.isFirst) return 0;

  const prevLast=prevSeg?.rows?.[prevSeg.rows.length - 1]?.z;
  const currFirst=seg.rows?.[0]?.z;

  if(Number.isFinite(prevLast) && Number.isFinite(currFirst) && currFirst > prevLast){
    return +(0.5 * (prevLast + currFirst)).toFixed(3);
  }

  if(Number.isFinite(currFirst)){
    return +(currFirst - 0.02).toFixed(3);
  }

  return Number.isFinite(prevLast) ? +prevLast.toFixed(3) : 0;
}

function subtypeGroup(subtype){
  const ent=CAT.find(r=>r.subtype===subtype);
  return ent?ent.grp:'';
}

function familyClass(layer){
  const grp=subtypeGroup(layer.subtype);
  if(grp==='veen'||grp==='klei'||grp==='leem') return 'cohesive';
  if(grp==='zand'||grp==='grind') return 'granular';
  if(layer.type==='Peat / organic'||layer.type==='Clay'||layer.type==='Soft clay'||layer.type==='Sandy clay') return 'cohesive';
  return 'granular';
}

function qcSimilarity(a,b){
  const qa=Math.max(0.01,a.avgQc), qb=Math.max(0.01,b.avgQc);
  return Math.max(0,1-Math.abs(Math.log(qa/qb))/Math.log(3));
}

function rfSimilarity(a,b){
  if(a.avgRf==null||b.avgRf==null) return 0.5;
  return Math.max(0,1-Math.abs(a.avgRf-b.avgRf)/3);
}

function subtypeSimilarity(a,b){
  if(a.subtype&&a.subtype===b.subtype) return 1;
  const ga=subtypeGroup(a.subtype), gb=subtypeGroup(b.subtype);
  if(ga&&gb&&ga===gb) return 0.75;
  const lvl=compatLevel(a.type,gb||'');
  return lvl==='ok'?0.55:lvl==='adj'?0.25:0;
}

function paramSimilarity(a,b){
  const vals=[
    Math.max(0,1-Math.abs(a.phi-b.phi)/8),
    Math.max(0,1-Math.abs(a.g-b.g)/3),
    Math.max(0,1-Math.abs(a.c-b.c)/15)
  ];
  if(a.cu>0||b.cu>0) vals.push(Math.max(0,1-Math.abs(a.cu-b.cu)/75));
  return vals.reduce((s,v)=>s+v,0)/vals.length;
}

function compatSimilarity(a,b){
  const grpB=subtypeGroup(b.subtype);
  const lvl=compatLevel(a.type,grpB||'');
  return lvl==='ok'?1:lvl==='adj'?0.5:0;
}

function continuityScore(neighbor, outer){
  if(!outer) return 0.5;
  return 0.35*(layerTypeCompatScore(neighbor,outer)) + 0.35*qcSimilarity(neighbor,outer) + 0.30*rfSimilarity(neighbor,outer);
}

function isCriticalMarkerLayer(layer, up, down){
  if(layer.type==='Peat / organic'||layer.type==='Gravel') return true;
  if(layer.avgRf!=null&&layer.avgRf>6) return true;
  if(layer.avgQc<0.35||layer.avgQc>=15) return true;
  if(up&&down){
    const fam=familyClass(layer), fu=familyClass(up), fd=familyClass(down);
    if(fam!==fu&&fam!==fd&&fu===fd) return true;
  }
  return false;
}

const SMART_SLIVER_REF = 0.25;

function mergeCandidateScore(layer, neighbor, outer){
  if(!neighbor) return{ok:false,score:0,why:'no-neighbor'};
  const logRatio=Math.abs(Math.log(Math.max(0.01,layer.avgQc)/Math.max(0.01,neighbor.avgQc)));
  const thicknessRef=SMART_SLIVER_REF;
  const thicknessImportance=Math.max(0,Math.min(1,(layer.thk||0)/thicknessRef));
  const sliverBonus=0.14*(1-thicknessImportance);
  const penaltyScale=0.25 + 0.75*thicknessImportance;

  const typeScore=layer.type===neighbor.type?1:layerTypeCompatScore(layer,neighbor);
  const qcScore=qcSimilarity(layer,neighbor);
  const rfScore=rfSimilarity(layer,neighbor);
  const stScore=subtypeSimilarity(layer,neighbor);
  const pScore=paramSimilarity(layer,neighbor);
  const compScore=compatSimilarity(layer,neighbor);
  const corrScore=continuityScore(neighbor,outer);
  let score=0.24*typeScore + 0.20*qcScore + 0.14*rfScore + 0.14*stScore + 0.12*pScore + 0.08*compScore + 0.08*corrScore + sliverBonus;

  // Penalise sharp transitions, but do not fully block the merge.
  // The thickness criterion remains hard; similarity only decides direction.
  if(logRatio>Math.log(2.5)) score-=0.22*penaltyScale;
  else if(logRatio>Math.log(1.8)) score-=0.10*penaltyScale;

  if(layer.avgRf!=null&&neighbor.avgRf!=null){
    const rfDiff=Math.abs(layer.avgRf-neighbor.avgRf);
    if(rfDiff>4) score-=0.16*penaltyScale;
    else if(rfDiff>2.5) score-=0.08*penaltyScale;
  }

  if((layer.type==='Peat / organic')!==(neighbor.type==='Peat / organic')) score-=0.18*penaltyScale;
  if((layer.type==='Gravel')!==(neighbor.type==='Gravel')) score-=0.14*penaltyScale;

  if(isCriticalMarkerLayer(layer,null,null) && layer.type!==neighbor.type) score-=0.10*penaltyScale;

  score=Math.max(0,+score.toFixed(3));
  return{ok:true,score};
}

function simpleUpwardMerge(segments){
  let changed=true;
  let merged=segments.map((seg,i)=>({...seg,isFirst:i===0}));
  while(changed){
    changed=false;
    const next=[];
    for(let i=0;i<merged.length;i++){
      const seg=merged[i];
      const rows=seg.rows;
      const prev=i>0?merged[i-1]:null;
      const thick=segmentSummary(seg, prev).thk;
      if(thick<S.minThk&&next.length>0){
        next[next.length-1].rows.push(...rows);
        changed=true;
      }else{
        next.push({...seg,rows:[...rows]});
      }
    }
    merged=next.map((seg,i)=>({...seg,isFirst:i===0}));
  }
  return merged;
}

function mergeSegmentInDirection(merged, i, dir){
  const seg=merged[i];
  if(dir==='up'){
    merged[i-1].rows.push(...seg.rows);
    merged.splice(i,1);
  }else{
    merged[i+1].rows.unshift(...seg.rows);
    merged[i+1]._top=segmentTop(seg, i>0?merged[i-1]:null);
    merged.splice(i,1);
  }
  return merged.map((s,idx)=>({...s,isFirst:idx===0}));
}

function chooseSimilarityMergeDirection(merged, i, margin){
  const seg=merged[i];
  const layer=segmentSummary(seg, i>0?merged[i-1]:null);
  const upSeg=i>0?merged[i-1]:null, downSeg=i<merged.length-1?merged[i+1]:null;
  const up=upSeg?segmentSummary(upSeg, i>1?merged[i-2]:null):null;
  const down=downSeg?segmentSummary(downSeg, seg):null;
  const upOuter=i>1?segmentSummary(merged[i-2], i>2?merged[i-3]:null):null;
  const downOuter=i<merged.length-2?segmentSummary(merged[i+2], downSeg):null;
  const upCand=mergeCandidateScore(layer,up,upOuter);
  const downCand=mergeCandidateScore(layer,down,downOuter);
  if(!upCand.ok&&!downCand.ok) return null;

  if(upCand.ok&&(!downCand.ok||upCand.score>downCand.score+margin)) return 'up';
  if(downCand.ok&&(!upCand.ok||downCand.score>upCand.score+margin)) return 'down';
  if(upCand.ok&&downCand.ok){
    const upThk=up?.thk||0, downThk=down?.thk||0;
    return upThk===downThk?'up':(upThk>downThk?'up':'down');
  }
  return upCand.ok?'up':'down';
}

function smartSimilarityReduce(segments, sensitivity){
  let changed=true;
  let merged=segments.map((seg,i)=>({...seg,isFirst:i===0}));
  const sens=Math.max(0,Math.min(6,sensitivity ?? 1.1));
  const pairThreshold=0.90 - 0.275*sens;
  const thicknessRef=SMART_SLIVER_REF;
  while(changed){
    changed=false;
    let bestIdx=-1;
    let bestScore=-Infinity;
    for(let i=0;i<merged.length-1;i++){
      const left=segmentSummary(merged[i], i>0?merged[i-1]:null);
      const right=segmentSummary(merged[i+1], merged[i]);
      const leftOuter=i>0?segmentSummary(merged[i-1], i>1?merged[i-2]:null):null;
      const rightOuter=i<merged.length-2?segmentSummary(merged[i+2], merged[i+1]):null;
      const lr=mergeCandidateScore(left,right,rightOuter);
      const rl=mergeCandidateScore(right,left,leftOuter);
      if(!lr.ok||!rl.ok) continue;
      const thinBoundaryFactor=1-Math.max(0,Math.min(1,Math.min(left.thk,right.thk)/thicknessRef));
      const pairScore=+(((lr.score+rl.score)/2 + 0.10*thinBoundaryFactor)).toFixed(3);
      if(pairScore>bestScore){
        bestScore=pairScore;
        bestIdx=i;
      }
    }

    if(bestIdx>=0 && bestScore>=pairThreshold){
      merged[bestIdx].rows.push(...merged[bestIdx+1].rows);
      merged.splice(bestIdx+1,1);
      merged=merged.map((s,idx)=>({...s,isFirst:idx===0}));
      changed=true;
    }
  }
  return merged;
}

function enforceMinThicknessBySimilarity(segments, sensitivity){
  let changed=true;
  let merged=segments.map((seg,i)=>({...seg,isFirst:i===0}));
  const sens=Math.max(0,Math.min(6,sensitivity ?? 1.1));
  const margin=Math.max(0, 0.14 - 0.08*sens);
  while(changed){
    changed=false;
    for(let i=0;i<merged.length;i++){
      const layer=segmentSummary(merged[i], i>0?merged[i-1]:null);
      if(layer.thk>=S.minThk) continue;
      const dir=chooseSimilarityMergeDirection(merged, i, margin);
      if(!dir) continue;
      merged=mergeSegmentInDirection(merged, i, dir);
      changed=true;
      break;
    }
  }
  return merged;
}

function smartPostMerge(segments){
  const sensitivity=Math.max(0,Math.min(6,S.smartMergeSensitivity ?? 1.1));
  let merged=segments.map((seg,i)=>({...seg,isFirst:i===0}));
  // Intended smart chain:
  //   1. original raw classification-derived layering
  //   2. similarity-driven boundary reduction
  //   3. minimum-thickness enforcement as the final hard merge force
  merged=smartSimilarityReduce(merged, sensitivity);
  merged=enforceMinThicknessBySimilarity(merged, sensitivity);
  return merged;
}

function classificationSegmentKey(row){
  if(S.method==='sb260') return `${row.type}::${row.subtype||''}`;
  return row.type;
}

function detectLayers(){
  const d=S.classified;
  const raw=[];
  let cur={type:d[0].type, subtype:d[0].subtype||'', key:classificationSegmentKey(d[0]), rows:[d[0]]};
  for(let i=1;i<d.length;i++){
    const key=classificationSegmentKey(d[i]);
    if(key===cur.key) cur.rows.push(d[i]);
    else{
      raw.push(cur);
      cur={type:d[i].type, subtype:d[i].subtype||'', key, rows:[d[i]]};
    }
  }
  raw.push(cur);

  // Important: the original raw layering is always created first from the
  // unmodified point-by-point classification sequence above.
  // Then:
  //   - baseline mode: enforce minimum thickness by upward merge
  //   - smart mode: reduce by similarity first, enforce minimum thickness last
  const merged=S.smartMerge ? smartPostMerge(raw) : simpleUpwardMerge(raw);

  const mergedSummaries=merged.map((seg,i)=>segmentSummary({...seg,isFirst:i===0}, i>0?merged[i-1]:null));
  let prevBot=null;
  S.layers=merged.map((seg,i)=>{
    const sum=mergedSummaries[i];
    const top=prevBot==null?sum.top:+prevBot.toFixed(3);
    const bot=Math.max(top,+sum.bot.toFixed(3));
    prevBot=bot;
    const {avgQc,avgFs,avgRf,subtype}=sum;
    let {g,gs,phi,c,cu}=sum;
    // Auto-suggest best Eurocode Table 3 subtype from catalogue based on avgQc + avgRf
    // Only if subtype not already forced by the classification itself
    const tmpLayer={type:seg.type,subtype,avgQc,avgRf};
    const suggestion=suggestSubtype(tmpLayer);
    const suggestedSubtype=suggestion?suggestion.subtype:subtype;
    // If suggestion differs from classification subtype, apply suggestion params
    // but mark it as a suggestion (not a manual override)
    let sg=g,sgs=gs,sphi=Math.round(phi),sc=Math.round(c),scu=Math.round(cu);
    if(suggestion&&S.paramMethod==='sb260'){
      sg=suggestion.g; sgs=suggestion.gs;
      sphi=suggestion.phi; sc=suggestion.c; scu=suggestion.cu;
    }
    return{id:i,top,bot,type:seg.type,subtype:suggestedSubtype,avgQc,avgFs,avgRf,
      g:sg,gs:sgs,phi:sphi,c:sc,cu:scu,ovr:{}};
  });
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

/* ═══════════════════════════════════════════════════════════════════════
   NEN / Eurocode 7 Tabel 3 — COMPLETE CATALOGUE
   "Karakteristieke grondparameters op basis van de resultaten uit
    een elektrische sondering"
   
   Every entry corresponds EXACTLY to one row of Tabel 3.
   No entries outside the table. No invented entries.
   
   Columns verified against table image:
     grp    = grondsoort family (determines dropdown grouping)
     label  = displayed name in dropdown
     type   = CPT soil behaviour type (for COMPAT routing)
     subtype= exact internal key (matches classSB260 output)
     g      = γ boven F.O. (kN/m³)
     gs     = γ onder F.O. (kN/m³)
     phi    = φ'k (°)
     c      = c'k (kPa)
     cu     = cu,k (kPa)
     qcMin  = lower qc bound (MPa, inclusive)
     qcMax  = upper qc bound (MPa, exclusive)
     rfMin  = lower Rf bound (%, inclusive)
     rfMax  = upper Rf bound (%, inclusive)
   
   GRIND: Tabel 3 shows qc ≥ 10 for matig and qc ≥ 20 for dicht.
   VEEN:  Tabel 3 shows Rf > 6% (hard gate). qc 0.2-0.5 / 0.5-1 / ≥1.
   ZAND:  Clean: Rf < 1%. With fines (lh/kh): Rf 1-2%.
   LEEM:  Pure: Rf 2-4%. Zandhoudend: Rf 1-3%.
   KLEI:  Pure: Rf 3-6%. Zandhoudend: Rf 2-5%.
   
   "Siltig zand" is NOT in Tabel 3 and has been removed.
   Robertson Zone 5 (Silty sand CPT type) maps to leemhoudend zand / 
   zandhoudende leem entries via COMPAT.
═══════════════════════════════════════════════════════════════════════ */
const CAT=[
  // ──────────────────────────────────────────────────────────────────────
  // VEEN  Tabel 3: Rf > 6%, qc ranges as shown
  // γ boven/onder F.O.: 10/10, 12/12, 14/14  φ'=15°  c'=2,5,10  cu=10,20,40
  // ──────────────────────────────────────────────────────────────────────
  {grp:'veen', label:'Veen — weinig vast  (qc 0.2–0.5, Rf >6%)',
   type:'Peat / organic', subtype:'veen, weinig vast',
   g:10, gs:10, phi:15, c:2,  cu:10,
   qcMin:0.2, qcMax:0.5, rfMin:6, rfMax:99},

  {grp:'veen', label:'Veen — matig vast  (qc 0.5–1.0, Rf >6%)',
   type:'Peat / organic', subtype:'veen, matig vast',
   g:12, gs:12, phi:15, c:5,  cu:20,
   qcMin:0.5, qcMax:1.0, rfMin:6, rfMax:99},

  {grp:'veen', label:'Veen — vast  (qc ≥1.0, Rf >6%)',
   type:'Peat / organic', subtype:'veen, vast',
   g:14, gs:14, phi:15, c:10, cu:40,
   qcMin:1.0, qcMax:99,  rfMin:6, rfMax:99},

  // ──────────────────────────────────────────────────────────────────────
  // KLEI (pure)  Tabel 3: Rf 3–6%
  // γ: 16/16, 17/17, 18/18, 19/19  φ'=20°  c'=2,4,8,15  cu=20,50,100,200
  // ──────────────────────────────────────────────────────────────────────
  {grp:'klei', label:'Klei — weinig vast  (qc 0.4–1, Rf 3–6%)',
   type:'Clay', subtype:'klei, weinig vast',
   g:16, gs:16, phi:20, c:2,  cu:20,
   qcMin:0.4, qcMax:1.0, rfMin:3, rfMax:6},

  {grp:'klei', label:'Klei — matig vast  (qc 1–2, Rf 3–6%)',
   type:'Clay', subtype:'klei, matig vast',
   g:17, gs:17, phi:20, c:4,  cu:50,
   qcMin:1.0, qcMax:2.0, rfMin:3, rfMax:6},

  {grp:'klei', label:'Klei — vrij vast  (qc 2–4, Rf 3–6%)',
   type:'Clay', subtype:'klei, vrij vast',
   g:18, gs:18, phi:20, c:8,  cu:100,
   qcMin:2.0, qcMax:4.0, rfMin:3, rfMax:6},

  {grp:'klei', label:'Klei — vast  (qc ≥4, Rf 3–6%)',
   type:'Clay', subtype:'klei, vast',
   g:19, gs:19, phi:20, c:15, cu:200,
   qcMin:4.0, qcMax:99,  rfMin:3, rfMax:6},

  // ──────────────────────────────────────────────────────────────────────
  // KLEI ZANDHOUDEND  Tabel 3: Rf 2–5%
  // γ: 16/16, 17/17, 18/18, 19/19  φ'=22°  c'=2,4,8,15  cu=20,50,100,200
  // ──────────────────────────────────────────────────────────────────────
  {grp:'klei', label:'Klei zandhoudend — weinig vast  (qc 0.4–1, Rf 2–5%)',
   type:'Clay', subtype:'klei (zh), weinig vast',
   g:16, gs:16, phi:22, c:2,  cu:20,
   qcMin:0.4, qcMax:1.0, rfMin:2, rfMax:5},

  {grp:'klei', label:'Klei zandhoudend — matig vast  (qc 1–2, Rf 2–5%)',
   type:'Clay', subtype:'klei (zh), matig vast',
   g:17, gs:17, phi:22, c:4,  cu:50,
   qcMin:1.0, qcMax:2.0, rfMin:2, rfMax:5},

  {grp:'klei', label:'Klei zandhoudend — vrij vast  (qc 2–4, Rf 2–5%)',
   type:'Clay', subtype:'klei (zh), vrij vast',
   g:18, gs:18, phi:22, c:8,  cu:100,
   qcMin:2.0, qcMax:4.0, rfMin:2, rfMax:5},

  {grp:'klei', label:'Klei zandhoudend — vast  (qc ≥4, Rf 2–5%)',
   type:'Clay', subtype:'klei (zh), vast',
   g:19, gs:19, phi:22, c:15, cu:200,
   qcMin:4.0, qcMax:99,  rfMin:2, rfMax:5},

  // ──────────────────────────────────────────────────────────────────────
  // LEEM (pure)  Tabel 3: Rf 2–4%
  // γ: 17/17, 18/18, 19/19, 20/20  φ'=22°  c'=0,2,4,8  cu=10,25,50,100
  // ──────────────────────────────────────────────────────────────────────
  {grp:'leem', label:'Leem — weinig vast  (qc 0.4–1, Rf 2–4%)',
   type:'Sandy clay', subtype:'leem, weinig vast',
   g:17, gs:17, phi:22, c:0, cu:10,
   qcMin:0.4, qcMax:1.0, rfMin:2, rfMax:4},

  {grp:'leem', label:'Leem — matig vast  (qc 1–2, Rf 2–4%)',
   type:'Sandy clay', subtype:'leem, matig vast',
   g:18, gs:18, phi:22, c:2, cu:25,
   qcMin:1.0, qcMax:2.0, rfMin:2, rfMax:4},

  {grp:'leem', label:'Leem — vrij vast  (qc 2–4, Rf 2–4%)',
   type:'Sandy clay', subtype:'leem, vrij vast',
   g:19, gs:19, phi:22, c:4, cu:50,
   qcMin:2.0, qcMax:4.0, rfMin:2, rfMax:4},

  {grp:'leem', label:'Leem — vast  (qc ≥4, Rf 2–4%)',
   type:'Sandy clay', subtype:'leem, vast',
   g:20, gs:20, phi:22, c:8, cu:100,
   qcMin:4.0, qcMax:99,  rfMin:2, rfMax:4},

  // ──────────────────────────────────────────────────────────────────────
  // LEEM ZANDHOUDEND  Tabel 3: Rf 1–3%
  // (= zandhoudende leem: leem dominant with sand admixture)
  // γ: 17/17, 18/18, 19/19, 20/20  φ'=25°  c'=0,2,4,8  cu=10,25,50,100
  // ──────────────────────────────────────────────────────────────────────
  {grp:'leem', label:'Zandhoudende leem — weinig vast  (qc 0.4–1, Rf 1–3%)',
   type:'Sandy clay', subtype:'leem (zh), weinig vast',
   g:17, gs:17, phi:25, c:0, cu:10,
   qcMin:0.4, qcMax:1.0, rfMin:1, rfMax:3},

  {grp:'leem', label:'Zandhoudende leem — matig vast  (qc 1–2, Rf 1–3%)',
   type:'Sandy clay', subtype:'leem (zh), matig vast',
   g:18, gs:18, phi:25, c:2, cu:25,
   qcMin:1.0, qcMax:2.0, rfMin:1, rfMax:3},

  {grp:'leem', label:'Zandhoudende leem — vrij vast  (qc 2–4, Rf 1–3%)',
   type:'Sandy clay', subtype:'leem (zh), vrij vast',
   g:19, gs:19, phi:25, c:4, cu:50,
   qcMin:2.0, qcMax:4.0, rfMin:1, rfMax:3},

  {grp:'leem', label:'Zandhoudende leem — vast  (qc ≥4, Rf 1–3%)',
   type:'Sandy clay', subtype:'leem (zh), vast',
   g:20, gs:20, phi:25, c:8, cu:100,
   qcMin:4.0, qcMax:99,  rfMin:1, rfMax:3},

  // ──────────────────────────────────────────────────────────────────────
  // ZAND (clean)  Tabel 3: Rf < 1%
  // γ boven F.O.: 16,17,18,18  γ onder: 18,19,20,20  φ'=27,30,32,35°
  // c'=0  cu=—
  // ──────────────────────────────────────────────────────────────────────
  {grp:'zand', label:'Zand — los  (qc 2–4, Rf <1%)',
   type:'Sand', subtype:'zand, los',
   g:16, gs:18, phi:27, c:0, cu:0,
   qcMin:2,  qcMax:4,  rfMin:0, rfMax:1},

  {grp:'zand', label:'Zand — matig  (qc 4–10, Rf <1%)',
   type:'Sand', subtype:'zand, matig',
   g:17, gs:19, phi:30, c:0, cu:0,
   qcMin:4,  qcMax:10, rfMin:0, rfMax:1},

  {grp:'zand', label:'Zand — dicht  (qc 10–15, Rf <1%)',
   type:'Sand', subtype:'zand, dicht',
   g:18, gs:20, phi:32, c:0, cu:0,
   qcMin:10, qcMax:15, rfMin:0, rfMax:1},

  {grp:'zand', label:'Zand — zeer dicht  (qc ≥15, Rf <1%)',
   type:'Sand', subtype:'zand, zeer dicht',
   g:18, gs:20, phi:35, c:0, cu:0,
   qcMin:15, qcMax:99, rfMin:0, rfMax:1},

  // ──────────────────────────────────────────────────────────────────────
  // ZAND leem/kleihoudend  Tabel 3: Rf 1–2%
  // (= leemhoudend zand: zand dominant with silt/clay admixture)
  // γ boven F.O.: 16,17,18,19  γ onder: 18,19,20,20  φ'=25,27,30,32°
  // c'=0  cu=—
  // ──────────────────────────────────────────────────────────────────────
  {grp:'zand', label:'Leemhoudend zand — los  (qc 2–4, Rf 1–2%)',
   type:'Sand', subtype:'zand (lh), los',
   g:16, gs:18, phi:25, c:0, cu:0,
   qcMin:2,  qcMax:4,  rfMin:1, rfMax:2},

  {grp:'zand', label:'Leemhoudend zand — matig  (qc 4–10, Rf 1–2%)',
   type:'Sand', subtype:'zand (lh), matig',
   g:17, gs:19, phi:27, c:0, cu:0,
   qcMin:4,  qcMax:10, rfMin:1, rfMax:2},

  {grp:'zand', label:'Leemhoudend zand — dicht  (qc 10–15, Rf 1–2%)',
   type:'Sand', subtype:'zand (lh), dicht',
   g:18, gs:20, phi:30, c:0, cu:0,
   qcMin:10, qcMax:15, rfMin:1, rfMax:2},

  {grp:'zand', label:'Leemhoudend zand — zeer dicht  (qc ≥15, Rf 1–2%)',
   type:'Sand', subtype:'zand (lh), z.dicht',
   g:19, gs:20, phi:32, c:0, cu:0,
   qcMin:15, qcMax:99, rfMin:1, rfMax:2},

  // ──────────────────────────────────────────────────────────────────────
  // GRIND (clean)  Tabel 3: Rf < 1%, qc ≥ 10
  // γ: 18/20, 19/21  φ'=35,40°  c'=0  cu=—
  // ──────────────────────────────────────────────────────────────────────
  {grp:'grind', label:'Grind — matig  (qc 10–20, Rf <1%)',
   type:'Gravel', subtype:'grind, matig',
   g:18, gs:20, phi:35, c:0, cu:0,
   qcMin:10, qcMax:20, rfMin:0, rfMax:1},

  {grp:'grind', label:'Grind — dicht  (qc ≥20, Rf <1%)',
   type:'Gravel', subtype:'grind, dicht',
   g:19, gs:21, phi:40, c:0, cu:0,
   qcMin:20, qcMax:99, rfMin:0, rfMax:1},

  // ──────────────────────────────────────────────────────────────────────
  // GRIND leem/kleihoudend  Tabel 3: Rf 1–2%, qc ≥ 10
  // γ: 19/21, 20/22  φ'=32,37°  c'=0  cu=—
  // ──────────────────────────────────────────────────────────────────────
  {grp:'grind', label:'Grind klei-/leemhoudend — matig  (qc 10–20, Rf 1–2%)',
   type:'Gravel', subtype:'grind (kh), matig',
   g:19, gs:21, phi:32, c:0, cu:0,
   qcMin:10, qcMax:20, rfMin:1, rfMax:2},

  {grp:'grind', label:'Grind klei-/leemhoudend — dicht  (qc ≥20, Rf 1–2%)',
   type:'Gravel', subtype:'grind (kh), dicht',
   g:20, gs:22, phi:37, c:0, cu:0,
   qcMin:20, qcMax:99, rfMin:1, rfMax:2},
];

const EUROCODE_CLASS_ENTRIES=[
  ...CAT.filter(r=>r.grp==='grind'),
  ...CAT.filter(r=>r.grp==='zand'),
  ...CAT.filter(r=>r.grp==='leem'),
  ...CAT.filter(r=>r.grp==='klei'),
  ...CAT.filter(r=>r.grp==='veen'),
];

function eurocodeEntryMatches(entry, qc, rf){
  if(qc < entry.qcMin || qc >= entry.qcMax) return false;
  if(rf == null) return false;

  if(entry.grp === 'veen') return rf > 6;
  if(entry.rfMin === 0 && entry.rfMax === 1) return rf < 1;
  if(entry.rfMin === 1 && entry.rfMax === 2) return rf >= 1 && rf <= 2;
  return rf >= entry.rfMin && rf <= entry.rfMax;
}

const CAT_GROUPS={
  veen:'Veen',
  klei:'Klei / Klei zandhoudend',
  leem:'Leem / Zandhoudende leem',
  zand:'Zand / Leemhoudend zand',
  grind:'Grind',
};

/* Compatibility matrix: CPT type → {compatible grps, adjacent grps}
   'compatible' = expected match, no warning
   'adjacent'   = plausible (transition zone), show note in dropdown but allow
   anything else = incompatible, shown in disabled optgroup with warning */
/* COMPAT: CPT soil behaviour type → {ok: Tabel 3 groups, adj: adjacent groups}
   'ok'  = directly expected for this CPT type — shown first in dropdown, ✓/~/· hints
   'adj' = adjacent/transition — shown with ⚠ prefix, selectable
   rest  = incompatible — disabled
   
   Robertson types → Tabel 3 mapping:
     Peat/organic (Zone 2)  → veen
     Soft clay   (Zone 1)   → klei (sensitive clay), leem adj
     Clay        (Zone 3)   → klei, leem adj
     Sandy clay  (Zone 4)   → leem AND klei zh (both are silt mixtures in Tabel 3)
     Silty sand  (Zone 5)   → zandhoudende leem (leem grp) + leemhoudend zand (zand grp)
                              pure klei is not treated as an adjacent transition here
     Sand        (Zone 6)   → zand, grind adj
     Gravel      (Zone 7)   → grind, zand adj
*/
const COMPAT={
  'Peat / organic': {ok:['veen'],             adj:[]},
  'Soft clay':      {ok:['klei'],             adj:['leem']},
  'Clay':           {ok:['klei'],             adj:['leem']},
  'Sandy clay':     {ok:['leem','klei'],      adj:['zand']},
  'Silty sand':     {ok:['leem','zand'],      adj:[]},
  'Sand':           {ok:['zand'],             adj:['grind','leem']},
  'Gravel':         {ok:['grind'],            adj:['zand']},
};

function compatLevel(cptType, grp){
  const c=COMPAT[cptType]||{ok:[],adj:[]};
  if(c.ok.includes(grp))  return 'ok';
  if(c.adj.includes(grp)) return 'adj';
  return 'bad';
}

/* Build the subtype dropdown for one layer.
   Groups: compatible entries first (enabled), adjacent (enabled, marked),
   incompatible last (disabled). */
/* ── qc/Rf fit check ───────────────────────────────────────────────────
   Returns whether a CAT entry's qc and Rf ranges match the layer's
   average values. 'match'=within range, 'close'=within 50% margin,
   'out'=clearly outside. Only applied within compatible groups. */
function qcRfFit(entry, avgQc, avgRf){
  /* Strict matching against NEN Tabel 3 qc and Rf ranges.
     
     BOUNDARY RULES from Tabel 3:
     - qc: lower bound inclusive, upper bound exclusive  (e.g. "2 ≤ qc < 4")
     - Rf: lower bound inclusive, upper bound inclusive  (e.g. "Rf 3–6%")
     - Exception: Rf < 1% entries (clean zand/grind) → upper bound is EXCLUSIVE
       because Rf=1.0% belongs to the leem/kleihoudend zone (Rf 1–2%)
     - Veen requires Rf > 6% (hard gate, no tolerance)
     
     Returns: 'match' = both qc and Rf in range for this entry
              'close' = qc matches, Rf within 0.3pp of boundary
              'out'   = clearly outside → shown as '·' hint only
  */
  const rf = avgRf ?? null;

  // Hard veen gate: must have Rf > 6%
  if(entry.grp === 'veen' && rf !== null && rf < 5.5) return 'out';

  // qc check (exclusive upper bound per Tabel 3 notation)
  const qcOk = avgQc >= entry.qcMin && avgQc < entry.qcMax;

  // Rf check — boundary inclusivity depends on entry type
  let rfOk;
  if(rf === null){
    rfOk = true;  // no Rf data: skip Rf check
  } else if(entry.rfMax === 1 && entry.rfMin === 0){
    // Clean zand / grind: Tabel 3 "Rf < 1%" → strict exclusive upper
    rfOk = rf >= 0 && rf < 1.0;
  } else if(entry.rfMax === 2 && entry.rfMin === 1){
    // Lh/kh zand / grind: Tabel 3 "Rf 1–2%" → inclusive both ends
    rfOk = rf >= 1.0 && rf <= 2.0;
  } else {
    // All other entries: inclusive both ends
    rfOk = rf >= entry.rfMin && rf <= entry.rfMax;
  }

  if(qcOk && rfOk) return 'match';

  // Close: qc in range, Rf within 0.3pp of boundary
  let rfClose;
  if(rf === null) rfClose = true;
  else rfClose = rf >= entry.rfMin - 0.3 && rf <= entry.rfMax + 0.3;
  if(qcOk && rfClose) return 'close';

  return 'out';
}

/* ── Auto-suggest best CAT entry for a layer ──────────────────────────
   Called when layer has no subtype yet (or on param method change).
   Picks the highest-scoring compatible entry based on qc and Rf. */
function suggestSubtype(l){
  /* Suggest the single best CAT entry for this layer's qc and Rf.
     
     Priority:
     1. Compatible group (COMPAT.ok) with qc AND Rf matching → score 10
     2. Compatible group with qc matching, Rf close (±0.5pp) → score 5
     3. Compatible group with qc matching, Rf out → score 2
        BUT: never suggest veen if Rf < 6% (Tabel 3 hard gate)
        AND: if the best ok-candidate has Rf mismatch, also check adj groups
     4. Adjacent group with qc+Rf match → score 3 (preferred over ok+Rf mismatch)
     5. Proximity-based fallback within ok group
  */
  const qc  = l.avgQc;
  const rf  = l.avgRf ?? null;

  // Hard veen exclusion: veen entries require Rf>6%
  const rfBlocksVeen = rf !== null && rf < 5.0;

  let best = null, bestScore = -99;

  const levels = ['ok', 'adj'];
  for(const level of levels){
    const candidates = CAT.filter(r => compatLevel(l.type, r.grp) === level);
    for(const r of candidates){
      // Hard exclusion: never suggest veen if Rf clearly not peat-range
      if(r.grp === 'veen' && rfBlocksVeen) continue;

      const fit = qcRfFit(r, qc, rf);
      let score = 0;
      if(level === 'ok'){
        if(fit === 'match')      score = 10;
        else if(fit === 'close') score = 5;
        else {
          // qc out of range — penalise by distance
          const qcDist = qc < r.qcMin ? r.qcMin - qc : Math.max(0, qc - r.qcMax);
          score = 2 - qcDist;
        }
      } else {
        // adj group — only suggest if it fits better than ok candidates
        if(fit === 'match')      score = 4;   // slightly below ok-match
        else if(fit === 'close') score = 2;
        else score = -1;
      }
      // Tie-break: prefer entry whose qc midpoint is closest to layer avgQc
      const qcMid = (r.qcMin + Math.min(r.qcMax, 20)) / 2;
      score += 0.01 * (1 - Math.abs(qc - qcMid) / Math.max(qcMid, 1));

      if(score > bestScore){ bestScore = score; best = r; }
    }
  }
  return best;
}

function buildSubtypeDropdown(l, i){
  const cptType=l.type;
  const cur=l.subtype||'';
  const qc=l.avgQc;
  const rf=l.avgRf??3;
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
      `<input class="ed${l.ovr[f]?' ovr':''}" data-i="${i}" data-f="${f}" value="${l[f]}" type="number" step="${step}" onchange="editL(this)">`;
    const thick=(l.bot-l.top).toFixed(2);
    const dropdown=buildSubtypeDropdown(l,i);
    return`<tr>
      <td style="font-weight:600">${i+1}</td>
      <td>${l.top.toFixed(2)}</td><td>${l.bot.toFixed(2)}</td>
      <td style="color:var(--tx2)">${taw(l.top)}</td>
      <td style="color:var(--tx2)">${taw(l.bot)}</td>
      <td>${thick} m</td>
      <td style="min-width:180px">
        <span class="sb ${SC[l.type]||'s-sand'}" style="font-size:10px">${l.type}</span>
        ${dropdown}
      </td>
      <td>${l.avgQc.toFixed(3)}</td>
      <td>${l.avgFs!=null?(l.avgFs*1000).toFixed(1):'—'}</td>
      <td>${l.avgRf!=null?l.avgRf.toFixed(2):'—'}</td>
      <td>${ed('g')}</td><td>${ed('gs')}</td>
      <td>${ed('phi')}</td><td>${ed('c')}</td><td>${ed('cu',1)}</td>
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

/* ════════════════════════════════
   MODEL PARAMETERS
════════════════════════════════ */
function khParams(l){
  /* Hydraulic conductivity from I/RA/11461/15.066/JSW
     Tabel 2-44 (OVAM 2002) + Tabel 2-45 (De Smedt VUB)
     mapped to CPT soil types. Values in m/s.
     kh_min, kh_max = range; kh_rep = representative (geometric mean). */
  const sub=l.subtype||'';
  const isGranular=l.type==='Sand'||l.type==='Silty sand'||l.type==='Gravel';
  const isCohesive =l.type==='Clay'||l.type==='Soft clay';
  const isLeem     =l.type==='Sandy clay';
  const isPeat     =l.type==='Peat / organic';

  let kh_min,kh_max,kh_rep;

  if(l.type==='Gravel'){
    kh_min=2.3e-4; kh_max=1.2e-2; kh_rep=1e-3;
  } else if(l.type==='Sand'){
    // Sub-classify by SB260 consistency (subtype contains zand, los/matig/dicht/z.dicht)
    if(sub.includes('z.dicht')||sub.includes('zeer dicht')){kh_min=1.2e-4;kh_max=2.3e-4;kh_rep=2e-4;}
    else if(sub.includes('dicht'))                          {kh_min=1.2e-4;kh_max=2.3e-4;kh_rep=1.5e-4;}
    else if(sub.includes('matig'))                          {kh_min=1.2e-5;kh_max=1.2e-4;kh_rep=4e-5;}
    else /* los + kleihoudend */                            {kh_min=1.2e-6;kh_max=1.2e-5;kh_rep=3e-6;}
  } else if(l.type==='Silty sand'){
    kh_min=1.2e-6; kh_max=1.2e-5; kh_rep=3e-6;
  } else if(isLeem){
    kh_min=1.2e-7; kh_max=1.2e-6; kh_rep=5e-7;
  } else if(l.type==='Clay'){
    kh_min=1e-9; kh_max=1.2e-7; kh_rep=5e-8;
  } else if(l.type==='Soft clay'){
    kh_min=1e-10; kh_max=1.2e-7; kh_rep=2e-8;
  } else if(isPeat){
    kh_min=6e-8; kh_max=6e-7; kh_rep=2e-7;
  } else {
    kh_min=1e-6; kh_max=1e-4; kh_rep=1e-5; // fallback
  }

  // kh/kv ratio — engineer-selectable method.
  //
  //   Method A — OVAM / I/RA/11461 (default)
  //     Conservative engineering practice value used in the Belgian
  //     OVAM 2002 / I/RA/11461.15.066 reference.  Silty sand ("fijn zand"
  //     in the source) is grouped with the fine soils → k_h/k_v = 3.
  //
  //   Method B — Bear (1979) academic
  //     Bear's Hydraulics of Groundwater gives a literature-typical
  //     intermediate value for fine/silty sand: k_h/k_v ≈ 2.  Reflects
  //     the partly-cohesive nature of silty sand without lumping it
  //     fully with cohesive soils.
  //
  // Sand and gravel remain isotropic (k_h/k_v = 1) under both methods.
  // All cohesive soils (clay, sandy clay/leem, peat) get k_h/k_v = 3
  // under both methods.
  const isFineSand = l.type==='Silty sand';
  let khkv;
  if (isGranular && !isFineSand) {
    khkv = 1;                                   // clean sand or gravel
  } else if (isFineSand) {
    khkv = (S.khKvMethod === 'B') ? 2 : 3;      // OVAM=3 (default), Bear=2
  } else {
    khkv = 3;                                   // cohesive
  }
  const kv_rep = +(kh_rep / khkv).toExponential(1);

  // psi_unsat (Plaxis 2D Manual): granular 0.1 m, leem 1.0 m, cohesive 3.0 m.
  // Silty sand stays in the granular branch for ψ_unsat (height of partially
  // saturated zone above the water table) — it dries similarly to clean sand.
  const psi_unsat = isGranular ? 0.1 : isLeem ? 1.0 : 3.0;

  // Infiltration design class (VMM §5.2, I/RA/11461/15.066/JSW)
  let infClass;
  if(kh_rep > 0.5e-6)       infClass='Infiltratie (volledig)';
  else if(kh_rep > 0.1e-6)  infClass='Infiltratie (effectief)';
  else if(kh_rep > 0.01e-6) infClass='Infiltratie + buffer';
  else                        infClass='Buffer (infiltratie marginaal)';

  function fmtK(v){
    // Format as X.Xe-N
    const e=Math.floor(Math.log10(v));
    const m=+(v/Math.pow(10,e)).toFixed(1);
    return `${m}\u00d710\u207b${Math.abs(e)}`;  // m×10⁻N
  }

  return{kh_min,kh_max,kh_rep,khkv,kv_rep,psi_unsat,infClass,
    kh_rep_fmt:fmtK(kh_rep), kh_min_fmt:fmtK(kh_min), kh_max_fmt:fmtK(kh_max)};
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

function hsParams(l){
  const pref=100;
  const midZ=(l.top+l.bot)/2;
  /* Pass both gamma_sat (l.gs) and gamma_unsat (l.g) so that stress
     above the water table uses the unsaturated unit weight. */
  const {sigV, u, sigVeff}=stressAt(midZ, l.gs, l.g);
  const cohesive=l.type==='Clay'||l.type==='Soft clay'||l.type==='Peat / organic';

  /* ── Alpha selection ── */
  let aE;
  if(l.ovr.aE){
    aE=l.aE_ovr;  // engineer override takes absolute priority
  } else if(S.alphaMethod==='B'){
    aE=alphaEB(l.type, l.avgQc, l.subtype, l.avgRf);
  } else {
    aE=AE[l.type]||10;
  }

  /* ── Eoed,i ── */
  const Eoed_i=+(aE*l.avgQc*1000).toFixed(0);

  /* ── m (type default, engineer can override) ──
     CUR 2003-7 binary stress-exponent convention: m = 0.5 for granular soils
     (sand, silty sand, gravel) and m = 1.0 for cohesive soils (clay, soft
     clay, sandy clay / leem, peat).  This is the documented method's
     conservative default — Stage 5 m-fitting is available per layer when
     site-specific evidence supports a different value.
     References: CUR 2003-7; Schanz, Vermeer & Bonnier (1999). */
  const m=l.ovr.m ? l.m_ovr
          : (cohesive || l.type==='Sandy clay') ? 1.0
          : 0.50;

  /* ── Eoed,ref (full cohesion-corrected formula per SB260-21-6.4.10) ── */
  const cotphi = l.phi>0 ? Math.cos(l.phi*Math.PI/180)/Math.sin(l.phi*Math.PI/180) : 0;
  const cCotPhi = l.c * cotphi;
  const ratio = Math.max((sigVeff + cCotPhi) / (pref + cCotPhi), 0.05);
  const Eoed_ref = +(Eoed_i / Math.pow(ratio, m)).toFixed(0);

  /* ── Stiffness Method A (CUR 2003-7) or B (E50 = Eoed) ──
     CUR 2003-7 treats klei AND leem (Sandy clay) as the cohesive set for
     the E50/Eoed = 1.25 ratio.  The earlier code excluded Sandy clay,
     which disagreed with the documented method. */
  const cohesiveForE50 = cohesive || l.type==='Sandy clay';
  let E50_i, E50_ref, Eur_ref;
  if(S.stiffMethod==='B'){
    E50_i = Eoed_i;
    E50_ref = Eoed_ref;
    Eur_ref = +(3*Eoed_ref).toFixed(0);
  } else {
    // Method A: CUR 2003-7
    E50_i = cohesiveForE50 ? +(1.25*Eoed_i).toFixed(0) : Eoed_i;
    E50_ref = cohesiveForE50 ? +(1.25*Eoed_ref).toFixed(0) : Eoed_ref;
    Eur_ref = +(3*E50_ref).toFixed(0);
  }

  const K0nc=+(1-Math.sin(l.phi*Math.PI/180)).toFixed(3);
  const nu = l.ovr && l.ovr.nu ? l.nu_ovr : mohrCoulombNuDefault(l.type, l.subtype);
  const rShear = l.ovr && l.ovr.rShear
    ? Math.max(Math.min(Number(l.rShear_ovr) || 0.25, 1), 0.01)
    : mohrCoulombRShearDefault(l.type, l.subtype);
  const nu_ur=0.20;
  const psi=Math.max(0,l.phi>30?Math.round(l.phi-30):0);
  /* MC export uses the current-stress loading stiffness E50,i.
     The earlier x1.5 conversion from Eoed,i had no retained source basis. */
  const Emc=E50_i;
  const taw=z=>S.elev!=null?(S.elev-z).toFixed(2)+'m TAW':'—';
  return{Eoed_i,E50_i,Eoed_ref,E50_ref,Eur_ref,m,K0nc,nu,nu_ur,aE:+aE.toFixed(2),
    sigV:+sigV.toFixed(1),u:+u.toFixed(1),sigVeff:+sigVeff.toFixed(1),psi,Emc,rShear,
    topTAW:taw(l.top),botTAW:taw(l.bot)};
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

    return`<div class="mc2">
      <div class="mc2-head">
        <span class="sb ${SC[l.type]||'s-sand'}">${l.type}</span>
        <span style="font-size:13px;font-weight:600">Layer ${i+1} &mdash; ${l.top.toFixed(2)}&ndash;${l.bot.toFixed(2)} m${tawStr} &nbsp;(${thick} m)</span>
        ${l.subtype?`<span style="font-size:11px;color:var(--tx2);font-style:italic">${l.subtype}</span>`:''}
        <span style="font-size:11px;color:var(--tx2);margin-left:auto" title="z_mid=${midZ.toFixed(2)}m | &sigma;v0=${h.sigV} kPa | u=${h.u} kPa | &sigma;'v0=${h.sigVeff} kPa">&sigma;v0 ${h.sigV} &minus; u ${h.u} = &sigma;'v0 <strong>${h.sigVeff} kPa</strong> &middot; &alpha;E ${h.aE}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px">
        <div>
          <div class="mc2-sec">Mohr-Coulomb</div>
          <table class="pt">
            <tr><td>E_ref (kPa)</td><td>${h.Emc.toLocaleString()}</td></tr>
            <tr><td>&nu;</td><td>${h.nu}</td></tr>
            <tr class="key">
              <td>r_shear <input class="ed${l.ovr.rShear?' ovr':''}" type="number" step="0.01" min="0.01" max="1.00"
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
        ${STAGE6_ENABLE_HARDENING_SOIL_UI ? `
          <div>
            <div class="mc2-sec">Hardening Soil &mdash; p_ref = 100 kPa</div>
            <table class="pt">
              <tr>
                <td style="color:var(--tx3);font-size:10px">&alpha;E (${S.alphaMethod==='B'?'SB260':'Sanglerat'})</td>
                <td style="text-align:right">
                  <input class="ed${l.ovr.aE?' ovr':''}" type="number" step="0.5" min="0.5" max="30"
                    value="${h.aE}" style="width:54px"
                    data-i="${i}" onchange="editAlpha(this)">
                </td>
              </tr>
              <tr><td>E_oed,i (kPa)</td><td style="color:var(--tx2)">${h.Eoed_i.toLocaleString()}</td></tr>
              <tr class="key"><td>E_oed,ref (kPa)</td><td>${h.Eoed_ref.toLocaleString()}</td></tr>
              <tr class="key"><td>E_50,ref (kPa) <span style="font-size:9px;color:var(--tx3)">${S.stiffMethod==='B'?'=E_oed':'CUR 2003-7'}</span></td><td>${h.E50_ref.toLocaleString()}</td></tr>
              <tr class="key"><td>E_ur,ref (kPa)</td><td>${h.Eur_ref.toLocaleString()}</td></tr>
              <tr class="key">
                <td>m <input class="ed${l.ovr.m?' ovr':''}" type="number" step="0.05" min="0.3" max="1.2"
                  value="${h.m.toFixed(2)}" style="width:48px;margin-left:4px"
                  data-i="${i}" onchange="editM(this)"></td>
                <td>${h.m.toFixed(2)}</td>
              </tr>
              <tr><td>K0_nc</td><td>${h.K0nc}</td></tr>
              <tr><td>&nu;_ur</td><td>${h.nu_ur}</td></tr>
              <tr><td>R_f</td><td>0.90</td></tr>
            </table>
          </div>
        ` : ''}
        <div>
          <div class="mc2-sec">Hydraulic conductivity</div>
          <table class="pt">
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

function fitLayer(l){
  // Pull the classified rows that belong to this layer depth range
  const rows = S.classified.filter(r =>
    r.z >= l.top && r.z <= l.bot && r.qc > 0.02
  );
  if(rows.length < 5) return null; // insufficient data

  const pref = 100;
  const cotphi = l.phi > 0
    ? Math.cos(l.phi*Math.PI/180) / Math.sin(l.phi*Math.PI/180)
    : 0;
  const cCotPhi = l.c * cotphi;

  // CUR 2003-7 binary default — must match hsParams().
  const mDefault =
      (l.type==='Clay'||l.type==='Soft clay'||l.type==='Peat / organic'||l.type==='Sandy clay')
        ? 1.0
        : 0.50;
  const alphaDefault = (l.ovr.aE ? l.aE_ovr
    : S.alphaMethod==='B' ? alphaEB(l.type, l.avgQc, l.subtype, l.avgRf)
    : (AE[l.type] || 10));

  // Build the point cloud directly from CPT rows in the layer.
  // Stage 5 only: Method B uses the row qc for pointwise Eoed,i reconstruction.
  const pts = [];
  for(const r of rows){
    const {sigVeff} = stressAt(r.z, l.gs, l.g);
    const denom = pref + cCotPhi;
    const numer = sigVeff + cCotPhi;
    if(numer <= 0 || denom <= 0) continue;

    const ratio = numer / denom;
    if(ratio <= 0) continue;

    const aE_row = l.ovr.aE ? l.aE_ovr
      : S.alphaMethod==='B' ? alphaEB(l.type, r.qc, l.subtype, r.rf ?? l.avgRf)
      : (AE[l.type] || 10);
    const Eoed_i_row = aE_row * r.qc * 1000;
    if(Eoed_i_row <= 0) continue;

    pts.push({
      z:r.z,
      x:Math.log(ratio),
      y:Math.log(Eoed_i_row),
      ratio,
      sigVeff,
      aE:aE_row,
      Eoed_i:Eoed_i_row
    });
  }

  const n = pts.length;
  if(n < 5) return null;

  // Stress range check
  const sigVeffs = pts.map(p => p.sigVeff);
  const svMin = Math.min(...sigVeffs), svMax = Math.max(...sigVeffs);
  const stressRangeFactor = svMin > 0 ? svMax / svMin : 1;

  // OLS
  const Xs = pts.map(p=>p.x);
  const Ys = pts.map(p=>p.y);
  const meanX = Xs.reduce((s,v)=>s+v,0)/n;
  const meanY = Ys.reduce((s,v)=>s+v,0)/n;
  const covXY = Xs.reduce((s,x,i)=>s+(x-meanX)*(Ys[i]-meanY),0)/n;
  const varX  = Xs.reduce((s,x)=>s+(x-meanX)**2,0)/n;

  if(Math.abs(varX) < 1e-6) return null; // no depth variation

  const m_raw = covXY/varX;
  if(!isFinite(m_raw)) return null;

  const m_fit = +m_raw.toFixed(3);
  const Eoed_ref_fit = +Math.exp(meanY - m_fit*meanX).toFixed(0);
  const invalidSlope = m_fit <= 0;

  // R²
  const SS_res = Xs.reduce((s,x,i)=>{
    const Ypred = meanY - m_raw*meanX + m_raw*x;
    return s + (Ys[i]-Ypred)**2;
  },0);
  const SS_tot = Ys.reduce((s,y)=>s+(y-meanY)**2,0);
  const R2 = SS_tot > 0 ? +(1 - SS_res/SS_tot).toFixed(3) : 0;

  // Quality flag
  let quality, qMsg;
  if(n < 10)                         { quality='warn'; qMsg='Weinig meetpunten (n='+n+')'; }
  else if(stressRangeFactor < 1.5)   { quality='warn'; qMsg='Spanningsbereik te klein (factor '+stressRangeFactor.toFixed(1)+')'; }
  else if(l.top < 0.5)               { quality='warn'; qMsg='Laag te ondiep (<0.5m)'; }
  else if(invalidSlope)              { quality='invalid'; qMsg='Negatieve of nul-helling gevonden — fit ongeldig'; }
  else if(m_fit < 0 || m_fit > 1.5)  { quality='warn'; qMsg='m buiten verwacht bereik ('+m_fit.toFixed(2)+')'; }
  else if(R2 < 0.50)                 { quality='warn'; qMsg='Lage R²='+R2+' — heterogene laag?'; }
  else if(R2 < 0.70)                 { quality='ok';   qMsg='Acceptabel (R²='+R2+')'; }
  else                               { quality='good'; qMsg='Goede fit (R²='+R2+')'; }

  // Build depth-profile arrays for physical-space chart
  const depthPts = pts.map(p=>p.z);
  const EoedI_pts = pts.map(p=>p.Eoed_i); // CPT-derived per row
  const aE_pts = pts.map(p=>+p.aE.toFixed(3));

  // HS model curve: Eoed(z) = Eoed_ref * ratio(z)^m
  const makeHScurve = (Eoed_ref_val, m_val) => pts.map(p =>
    Eoed_ref_val * Math.pow(Math.max(p.ratio, 0.05), m_val)
  );

  // For default m: recompute Eoed_ref at midZ with default m
  const midZ2 = (l.top+l.bot)/2;
  const {sigVeff: sv_mid2} = stressAt(midZ2, l.gs, l.g);
  const ratioMid = Math.max((sv_mid2+cCotPhi)/(pref+cCotPhi), 0.05);
  const Eoed_ref_default = (alphaDefault * l.avgQc * 1000) / Math.pow(ratioMid, mDefault);

  const hsDefault_pts = makeHScurve(Eoed_ref_default, mDefault);
  const hsFit_pts     = makeHScurve(Eoed_ref_fit, m_fit);

  return{m_fit, Eoed_ref_fit, R2, n, stressRangeFactor:+stressRangeFactor.toFixed(2),
         quality, qMsg, invalidSlope, Xs, Ys, meanX:+meanX.toFixed(6), meanY:+meanY.toFixed(6), m_raw:+m_raw.toFixed(4),
         depthPts, EoedI_pts, aE_pts, hsDefault_pts, hsFit_pts,
         Eoed_ref_default, mDefault, alphaDefault:+alphaDefault.toFixed(3)};
}

function runTuning(){
  S.tuning = S.layers.map((l,i)=>{
    const fit = fitLayer(l);
    return{i, fit, previewM:fit ? (fit.invalidSlope ? fit.mDefault : fit.m_fit) : null};
  });
  renderTuning();
}

function acceptFit(i){
  const t = S.tuning?.[i];
  const previewM = Number(t?.previewM);
  if(!t||!t.fit||!isFinite(previewM)||previewM<=0) return;
  S.layers[i].m_ovr = previewM;
  S.layers[i].ovr.m = true;
  // Also update Eoed,ref override? No — Eoed,ref is derived from m in hsParams.
  // Accepting m is enough: renderModel will recompute Eoed,ref with the new m.
  renderTuning();
  // Re-render Stage 4 in background so it stays current
  if(document.getElementById('p3').classList.contains('active')) renderModel();
}

function rejectFit(i){
  if(!S.layers[i]) return;
  delete S.layers[i].m_ovr;
  S.layers[i].ovr.m = false;
  renderTuning();
}

function getTuningPreviewM(t){
  if(!t||!t.fit) return NaN;
  const m = Number(t.previewM);
  if(isFinite(m) && m > 0) return m;
  return t.fit.invalidSlope ? t.fit.mDefault : t.fit.m_fit;
}

function tuningSliderBounds(fit){
  const anchors=[fit.mDefault, fit.m_fit, 0.01].filter(v=>isFinite(v) && v>0);
  const min=Math.max(0.01, Math.min(...anchors) - 0.4);
  const max=Math.min(2.0, Math.max(...anchors) + 0.4);
  return{
    min:+min.toFixed(2),
    max:+Math.max(max, min + 0.2).toFixed(2),
    step:0.01
  };
}

function tuningPreviewEoedRef(fit, previewM){
  return +Math.exp(fit.meanY - previewM*fit.meanX).toFixed(0);
}

function tuningPreviewLineData(fit, previewM){
  const Eoed_ref = tuningPreviewEoedRef(fit, previewM);
  const Xmin = Math.min(...fit.Xs)-0.1, Xmax = Math.max(...fit.Xs)+0.1;
  const linePts = 30;
  const logLine = Array.from({length:linePts},(_,k)=>{
    const x=Xmin+(Xmax-Xmin)*k/(linePts-1);
    return{x, y: Math.log(Eoed_ref)+previewM*x};
  });
  const depthLine = fit.depthPts.map((z,i)=>({x:Eoed_ref*Math.exp(previewM*fit.Xs[i]), y:z}));
  return{Eoed_ref, logLine, depthLine};
}

function readCssToken(name, fallback){
  if(typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function updateTuningPreviewM(i, rawValue){
  const t = S.tuning?.[i];
  if(!t||!t.fit) return;

  const parsed = Number(rawValue);
  t.previewM = parsed;
  const chartRed = readCssToken('--chart-red', '#9B3A32');
  const chartGreen = readCssToken('--chart-green', '#3D6B6A');

  const invalid = !isFinite(parsed) || parsed <= 0;
  const previewM = invalid ? t.fit.m_fit : parsed;
  const preview = tuningPreviewLineData(t.fit, previewM);

  const input=document.getElementById('fitPreviewInput'+i);
  if(input){
    input.style.borderColor = invalid ? 'var(--bad)' : 'var(--bd2)';
    input.style.color = invalid ? 'var(--bad-text)' : 'var(--tx)';
  }

  const mEl=document.getElementById('fitPreviewM'+i);
  if(mEl) mEl.textContent = invalid ? '—' : previewM.toFixed(3);

  const refEl=document.getElementById('fitPreviewRef'+i);
  if(refEl) refEl.textContent = invalid ? '—' : preview.Eoed_ref.toLocaleString()+' kPa';

  const noteEl=document.getElementById('fitPreviewNote'+i);
  if(noteEl){
    noteEl.textContent = invalid
      ? 'Preview ongeldig: m moet groter zijn dan 0'
      : (Math.abs(previewM - t.fit.m_fit) < 1e-6 ? 'Preview volgt de auto-fit' : 'Preview wijkt af van de auto-fit');
    noteEl.style.color = invalid ? 'var(--bad-text)' : 'var(--tx2)';
  }

  const btn=document.getElementById('fitAcceptBtn'+i);
  if(btn){
    btn.disabled = invalid;
    btn.style.opacity = invalid ? '0.5' : '1';
    btn.style.cursor = invalid ? 'not-allowed' : '';
  }

  const regCanvas=document.getElementById('tChart'+i);
  const regChart=regCanvas?regCanvas._chartRef:null;
  if(regChart){
    regChart.data.datasets[2].data = preview.logLine;
    regChart.data.datasets[2].label = 'Preview m='+previewM.toFixed(2);
    regChart.data.datasets[2].borderColor = invalid ? chartRed : chartGreen;
    regChart.data.datasets[2].borderDash = invalid ? [5,4] : (t.fit.quality==='warn'?[5,4]:[]);
    regChart.update('none');
  }

  const depCanvas=document.getElementById('tChart'+i+'d');
  const depChart=depCanvas?depCanvas._chartRef:null;
  if(depChart){
    depChart.data.datasets[3].data = preview.depthLine;
    depChart.data.datasets[3].label = 'HS preview m='+previewM.toFixed(2);
    depChart.data.datasets[3].borderColor = invalid ? chartRed : chartGreen;
    depChart.data.datasets[3].borderDash = invalid ? [5,4] : (t.fit.quality==='warn'?[5,4]:[]);
    depChart.update('none');
  }
}

function renderTuning(){
  const el = document.getElementById('tuningArea');
  if(!S.tuning){
    el.innerHTML='<div style="color:var(--tx2);font-size:13px;padding:20px 0">Klik op "Run fitting" om de regressie per laag te berekenen.</div>';
    return;
  }

  const pref=100;
  el.innerHTML = S.tuning.map(t=>{
    const l = S.layers[t.i];
    const fit = t.fit;
    const hasAccepted = !!l.ovr.m;
    const badge = SC[l.type]||'s-sand';

    if(!fit){
      return`<div class="mc2" style="margin-bottom:10px">
        <div class="mc2-head">
          <span class="sb ${badge}">${l.type}</span>
          <span style="font-size:13px;font-weight:600">Laag ${t.i+1} — ${l.top.toFixed(2)}–${l.bot.toFixed(2)} m</span>
          <span style="font-size:11px;color:var(--wn);margin-left:auto">Onvoldoende data voor regressie (n &lt; 5 of geen variatie)</span>
        </div>
      </div>`;
    }

    const qColor = fit.quality==='good'?'var(--ok-text)'
      : fit.quality==='ok'?'var(--wn)'
      : fit.quality==='invalid'?'var(--bad-text)'
      : 'var(--bad-text)';

    // Build scatter chart data
    const chartId = 'tChart'+t.i;
    const previewM = getTuningPreviewM(t);
    const preview = tuningPreviewLineData(fit, previewM);
    const slider = tuningSliderBounds(fit);

    // Default line points stay anchored to the type-default baseline.
    const m_def = fit.mDefault;
    const Eoed_ref_default = fit.Eoed_ref_default;

    // X range for model lines
    const Xmin = Math.min(...fit.Xs)-0.1, Xmax = Math.max(...fit.Xs)+0.1;
    const linePts = 30;
    const defaultLineY = Array.from({length:linePts},(_,k)=>{
      const x=Xmin+(Xmax-Xmin)*k/(linePts-1);
      return{x, y: Math.log(Eoed_ref_default)+m_def*x};
    });
    const scatterData = fit.Xs.map((x,k)=>({x,y:fit.Ys[k]}));

    return`<div class="mc2" style="margin-bottom:12px">
      <div class="mc2-head" style="margin-bottom:12px">
        <span class="sb ${badge}">${l.type}</span>
        <span style="font-size:13px;font-weight:600">Laag ${t.i+1} — ${l.top.toFixed(2)}–${l.bot.toFixed(2)} m</span>
        <span style="font-size:11px;font-style:italic;color:var(--tx2)">${l.subtype||''}</span>
        <span style="font-size:11px;font-weight:600;color:${qColor};margin-left:auto">${fit.qMsg}</span>
      </div>
      <!-- 3-column: depth profile | log-log fit | numbers -->
      <div style="display:grid;grid-template-columns:200px 1fr 200px;gap:14px;align-items:start">

        <!-- LEFT: Eoed vs depth (physical space) -->
        <div>
          <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">
            E_oed vs diepte (kPa)
            <span style="margin-left:6px;color:var(--chart-purple)">─ default</span>
            <span style="margin-left:4px;color:var(--chart-green)">─ preview</span>
            <span style="margin-left:4px;color:rgba(53,162,235,0.7)">· CPT</span>
          </div>
          <div style="position:relative;height:280px">
            <canvas id="${chartId+'d'}" role="img" aria-label="Eoed depth profile layer ${t.i+1}"></canvas>
          </div>
        </div>

        <!-- MIDDLE: log-log regression plot -->
        <div>
          <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">
            ln(E_oed,i) vs ln(σ'v0 stress ratio) — regressionvlak
            <span style="margin-left:6px;color:var(--chart-purple)">─ default m=${m_def.toFixed(2)}</span>
            <span style="margin-left:4px;color:var(--chart-green)">─ preview m=${previewM.toFixed(2)}</span>
          </div>
          <div style="position:relative;height:280px">
            <canvas id="${chartId}" role="img" aria-label="m fitting regression layer ${t.i+1}"></canvas>
          </div>
        </div>

        <!-- RIGHT: numbers + accept/reject -->
        <div>
          <table class="pt" style="margin-bottom:12px">
            <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Type-default</td></tr>
            <tr><td>m</td><td>${m_def.toFixed(2)}</td></tr>
            <tr><td>E_oed,ref</td><td>${Eoed_ref_default.toLocaleString()} kPa</td></tr>
            <tr><td>&alpha;E basis</td><td>${S.alphaMethod==='B'?'puntgewijs qc-afhankelijk':'vast per laag'} (${fit.alphaDefault.toFixed(2)})</td></tr>
            <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--ok-text);padding:4px 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);text-transform:uppercase">Auto-fit</td></tr>
            <tr><td>m</td><td style="color:var(--ok-text);font-weight:700">${fit.m_fit.toFixed(3)}</td></tr>
            <tr><td>E_oed,ref</td><td style="color:var(--ok-text);font-weight:600">${fit.Eoed_ref_fit.toLocaleString()} kPa</td></tr>
            <tr><td style="padding-top:6px">R²</td><td style="padding-top:6px">${fit.R2.toFixed(3)}</td></tr>
            <tr><td>n</td><td>${fit.n} punten</td></tr>
            <tr><td>σ' bereik</td><td>×${fit.stressRangeFactor}</td></tr>
            <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--tx2);padding:6px 0 4px;border-top:1px solid var(--bd);text-transform:uppercase">Preview / engineer tweak</td></tr>
            <tr>
              <td>m</td>
              <td>
                <input id="fitPreviewInput${t.i}" type="range" min="${slider.min}" max="${slider.max}" step="${slider.step}" value="${previewM.toFixed(3)}"
                  oninput="updateTuningPreviewM(${t.i}, this.value)"
                  style="width:100%;accent-color:var(--ac)">
                <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--tx3);margin-top:2px">
                  <span>${slider.min.toFixed(2)}</span>
                  <span>${slider.max.toFixed(2)}</span>
                </div>
                <div id="fitPreviewNote${t.i}" style="font-size:10px;color:var(--tx2);margin-top:4px">
                  ${fit.invalidSlope?'Auto-fit was ongeldig; slider start vanaf default m':'Preview volgt de auto-fit'}
                </div>
              </td>
            </tr>
            <tr><td>Preview m</td><td id="fitPreviewM${t.i}">${previewM.toFixed(3)}</td></tr>
            <tr><td>Preview E_oed,ref</td><td id="fitPreviewRef${t.i}">${preview.Eoed_ref.toLocaleString()} kPa</td></tr>
          </table>
          ${hasAccepted
            ?`<div style="font-size:11px;color:var(--ok-text);font-weight:600;margin-bottom:8px">✓ Huidige override m = ${l.m_ovr.toFixed(3)}</div>`
            :`<div style="font-size:11px;color:var(--tx2);margin-bottom:8px">Standaard m actief tot je expliciet accepteert</div>`
          }
          <button id="fitAcceptBtn${t.i}" class="btn pri sm" onclick="acceptFit(${t.i})" ${fit.quality==='warn'||fit.quality==='invalid'?'style="background:var(--wn);border-color:var(--wn)"':''}>
            ${fit.quality==='warn'?'⚠ ':''}Accepteer fit
          </button>
          ${hasAccepted?`<button class="btn sm" onclick="rejectFit(${t.i})" style="margin-left:6px">Herstel default m</button>`:''}
        </div>
      </div>
    </div>
    <div data-chart-pending="${chartId}"
         data-chart-depth="${chartId+'d'}"
         data-scatter='${JSON.stringify(scatterData).replace(/'/g,"&#39;")}'
         data-default-line='${JSON.stringify(defaultLineY).replace(/'/g,"&#39;")}'
         data-fit-line='${JSON.stringify(preview.logLine).replace(/'/g,"&#39;")}'
         data-depth-pts='${JSON.stringify(fit.depthPts).replace(/'/g,"&#39;")}'
         data-eoed-i='${JSON.stringify(fit.EoedI_pts.map(v=>+v.toFixed(0))).replace(/'/g,"&#39;")}'
         data-hs-default='${JSON.stringify(fit.hsDefault_pts.map(v=>+v.toFixed(0))).replace(/'/g,"&#39;")}'
         data-hs-fit='${JSON.stringify(preview.depthLine.map(v=>+v.x.toFixed(0))).replace(/'/g,"&#39;")}'
         data-layer-top="${l.top.toFixed(3)}"
         data-layer-bot="${l.bot.toFixed(3)}"
         data-wt="${S.wt.toFixed(3)}"
         data-m-def="${m_def.toFixed(2)}"
         data-m-fit="${previewM.toFixed(2)}"
         data-invalid-slope="0"
         data-quality="${fit.quality}">
    </div>`;
  }).join('');
  // Build charts after DOM settles.
  setTimeout(buildTuningCharts, 50);
}
/* Build tuning charts after DOM is rendered (avoids early tag close issue) */
function buildTuningCharts(){
  document.querySelectorAll('[data-chart-pending]').forEach(el=>{
    // ── Log-log regression chart ──
    const id = el.dataset.chartPending;
    const canvas = document.getElementById(id);
    if(canvas && !canvas._built){
      canvas._built = true;
      try{
        const scatter  = JSON.parse(el.dataset.scatter);
        const defLine  = JSON.parse(el.dataset.defaultLine);
        const fitLine  = JSON.parse(el.dataset.fitLine);
        const mDef = el.dataset.mDef, mFit = el.dataset.mFit;
        const invalidSlope = el.dataset.invalidSlope === '1';
        const chart = new Chart(canvas, buildTuningRegressionChartConfig({
          scatter,
          defaultLine:defLine,
          previewLine:fitLine,
          mDefault:mDef,
          mPreview:mFit,
          quality:el.dataset.quality,
          invalidSlope
        }));
        canvas._chartRef = chart;
      }catch(e){console.warn('Log-log chart error:',e);}
    }

    // ── Depth-profile chart ──
    const idD = el.dataset.chartDepth;
    const canvasD = idD ? document.getElementById(idD) : null;
    if(canvasD && !canvasD._built){
      canvasD._built = true;
      try{
        const depths    = JSON.parse(el.dataset.depthPts);
        const EoedI     = JSON.parse(el.dataset.eoedI);
        const hsDefault = JSON.parse(el.dataset.hsDefault);
        const hsFit     = JSON.parse(el.dataset.hsFit);
        const layerTop  = parseFloat(el.dataset.layerTop);
        const layerBot  = parseFloat(el.dataset.layerBot);
        const wt        = parseFloat(el.dataset.wt);
        const mDef      = el.dataset.mDef;
        const mFit      = el.dataset.mFit;
        const invalidSlope = el.dataset.invalidSlope === '1';
        const chart = new Chart(canvasD, buildTuningDepthChartConfig({
          depths,
          eoedI:EoedI,
          hsDefault,
          hsPreview:hsFit,
          layerTop,
          layerBot,
          wt,
          mDefault:mDef,
          mPreview:mFit,
          quality:el.dataset.quality,
          invalidSlope
        }));
        canvasD._chartRef = chart;
      }catch(e){console.warn('Depth chart error:',e);}
    }
  });
}

/* ════════════════════════════════
   STAGE 6 — APPLICATIONS
════════════════════════════════ */
function stage6Defaults(){
  return{
    app:'bearing',
    ui:{details:{}},
    retwall:retainingApp.defaults(),
    bearing:{
      foundationType:'strip',
      B:1.50,
      L:1.50,
      eB:0.00,
      eL:0.00,
      shapeMode:'hansen',
      load:150,
      factorMode:'ec7',
      xi:2.0,
      gammaRd:1.00,
      ec7Combination:'governing',
      Df:1.00,
      showMode:'both'
    },
    settlement:{
      footingType:'rectangular',
      B:2.00,
      L:2.00,
      D:2.00,
      Df:1.00,
      Gk:120,
      QLead:40,
      QOther:0,
      useCategory:'A',
      combination:'qp',
      stressMethod:'boussinesq',
      truncationRule:'CPT_bottom',
      dz:0.10,
      includeTime:false,
      timeDays:180,
      allowableSettlement:25
    },
    dewatering:{
      combination:'characteristic',
      targetWt:3.00,
      geometry:'single_well',
      aquiferType:'unconfined',
      rw:0.15,
      rCPT:0.00,
      LPit:12.00,
      BPit:8.00,
      LTrench:20.00,
      distanceToCPT:10.00,
      CSichardt:3000,
      sigmaVMode:'conservative',
      aquiferBaseDepth:null,
      dz:0.10,
      timeDays:0
    },
    pile:{
      pileType:'driven',
      shape:'circular',
      Ds:0.40,
      Db:0.40,
      a:null,
      b:null,
      Ap:null,
      zHead:0.00,
      zToe:10.00,
      Fcd:500,
      Frep:350,
      loadFromComponents:false,
      GkPerPile:null,
      QLeadPerPile:null,
      QOtherPerPile:null,
      loadCategory:'A',
      slsCombination:'qp',
      ulsSet:'A1',
      sltCondition:'none',
      qaToggle:false,
      nCpt:1,
      nPiles:'1-3',
      cptDensity:'1/100m2',
      useAtg:false,
      atgAlphaB:null,
      atgAlphaS:null,
      atgGammaRd:null,
      atgGammaB:null,
      lambdaOverride:null,
      downdrag:'none',
      neutralPlane:null,
      pileMaterial:'concrete',
      Ep:30,
      EbOverride:null,
      MsOverride:null,
      MbOverride:null,
      sAllowable:10,
      mechanicalCone:false,
      coneType:'M1',
      settlementMethod:'transfer'
    },
    beam:{
      modelMode:'slab_strip',
      foundationModel:'pasternak',
      B:1.50,
      b:1.00,
      L:6.00,
      h:0.35,
      Df:0.80,
      Ec:33000000,
      EsMode:'oedometric',
      zInfluence:3.00,
      gpEta:1.00,
      gpOverride:null,
      loadPattern:'uniform_full',
      Gk:35,
      QLead:15,
      QOther:0,
      useCategory:'A',
      slsCombination:'qp',
      ulsCombination:'A1',
      xLoad:3.00,
      xStart:1.50,
      xEnd:4.50,
      nElements:120,
      allowableDeflectionRatio:500,
      fck:30,
      fyk:500,
      exposureClass:'XC2',
      phiBar:12,
      dG:20,
      deltaCdev:10,
      cNomOverride:null,
      designLifeYears:50,
      isSlabOrPlate:true,
      specialQC:false,
      castAgainstUnevenSurface:false,
      castAgainstPreparedGround:false,
      castAgainstUnpreparedGround:false,
      dz:0.10
    },
    bishop:{
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
    }
  };
}

function stage6Merge(target, defaults){
  Object.keys(defaults).forEach((key)=>{
    const dv = defaults[key];
    if(dv && typeof dv === 'object' && !Array.isArray(dv)){
      if(!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
      stage6Merge(target[key], dv);
    } else if(target[key] == null){
      target[key] = dv;
    }
  });
}

function stage6Get(obj, path){
  return path.split('.').reduce((acc, part)=>acc ? acc[part] : undefined, obj);
}

function stage6Set(obj, path, value){
  const parts = path.split('.');
  let cur = obj;
  for(let i=0;i<parts.length-1;i+=1){
    const part = parts[i];
    if(!cur[part] || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length-1]] = value;
}

function stage6WorkingLayers(){
  return S.layers.map((layer, index)=>{
    const h = hsParams(layer);
    const k = khParams(layer);
    return{
      ...layer,
      index,
      Eoed_ref:h.Eoed_ref,
      Eoed_i:h.Eoed_i,
      E50_ref:h.E50_ref,
      Eur_ref:h.Eur_ref,
      m:h.m,
      Emc:h.Emc,
      nu:h.nu,
      K0nc:h.K0nc,
      rShear:h.rShear,
      psi:h.psi,
      kh:k.kh_rep,
      kv:k.kv_rep,
      nu_ur:h.nu_ur
    };
  });
}

function stage6MaxDepth(){
  return S.layers.length ? S.layers[S.layers.length-1].bot : 10;
}

function stage6BishopSeepageDomainArea(bishop){
  const terrain = stage6BishopSortedPolyline(bishop?.terrain);
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

function stage6BishopAutoSeepageMeshTargetArea(bishop){
  const domainArea = stage6BishopSeepageDomainArea(bishop);
  if(!(domainArea > 0)) return 0.05;
  return +Math.min(Math.max(domainArea / 3500, 0.05), 1.5).toFixed(3);
}

function stage6BishopResolvedSeepageMeshTargetArea(bishop){
  const options = bishop?.seepage?.options || {};
  const autoArea = stage6BishopAutoSeepageMeshTargetArea(bishop);
  if(options.meshTargetAreaAuto !== false) return autoArea;
  const manualArea = Number(options.meshTargetArea);
  return Math.max(Number.isFinite(manualArea) && manualArea > 0 ? manualArea : autoArea, 0.01);
}

function stage6BishopAutoDeformationMeshTargetArea(bishop){
  // Auto target area for the deformation mesh.  Coarser than seepage by
  // a factor of 9 (was 3): the deformation analysis is dominated by the
  // nonlinear inner-Newton + GMRES cost, which scales much more strongly
  // with the number of free DOFs than the assembly cost — a 3× coarser
  // mesh in each direction (≈ 9× area per element) cuts numFree by 3×
  // and the GMRES Arnoldi cost by ~9× while keeping engineering-grade
  // resolution for the ground-improvement problem class this app targets.
  // Users can still tighten the mesh manually via the meshTargetArea field
  // (turning auto off).
  const domainArea = stage6BishopSeepageDomainArea(bishop);
  if(!(domainArea > 0)) return 0.45;
  return +Math.min(Math.max(9 * (domainArea / 3500), 0.45), 9.0).toFixed(3);
}

function stage6BishopResolvedDeformationMeshTargetArea(bishop){
  const options = bishop?.deformation?.options || {};
  const autoArea = stage6BishopAutoDeformationMeshTargetArea(bishop);
  if(options.meshTargetAreaAuto !== false) return autoArea;
  const manualArea = Number(options.meshTargetArea);
  return Math.max(Number.isFinite(manualArea) && manualArea > 0 ? manualArea : autoArea, 0.01);
}

function ensureStage6State(){
  if(!S.stage6) S.stage6 = stage6Defaults();
  stage6Merge(S.stage6, stage6Defaults());
  retainingApp.ensure(S.stage6);
  if(!S.stage6Cache) S.stage6Cache = {};
  const maxDepth = Math.max(stage6MaxDepth(), 0.5);
  S.stage6.bearing.B = Math.max(+S.stage6.bearing.B || stage6Defaults().bearing.B, 0.1);
  S.stage6.bearing.L = Math.max(+S.stage6.bearing.L || S.stage6.bearing.B, 0.1);
  S.stage6.bearing.Df = Math.min(Math.max(+S.stage6.bearing.Df || 0.2, 0.2), maxDepth);
  S.stage6.bearing.eB = Math.max(0, Math.min(+S.stage6.bearing.eB || 0, Math.max((+S.stage6.bearing.B || 0.1) / 2 - 0.025, 0)));
  S.stage6.bearing.eL = Math.max(0, Math.min(+S.stage6.bearing.eL || 0, Math.max((+S.stage6.bearing.L || 0.1) / 2 - 0.025, 0)));
  if(!['hansen','conservative'].includes(S.stage6.bearing.shapeMode)) S.stage6.bearing.shapeMode = 'hansen';
  S.stage6.settlement.Df = Math.min(Math.max(+S.stage6.settlement.Df || 0.0, 0.0), maxDepth);
  S.stage6.dewatering.targetWt = Math.min(Math.max(+S.stage6.dewatering.targetWt || (S.wt + 0.5), S.wt), Math.max(S.wt, maxDepth-0.2));
  S.stage6.beam.Df = Math.min(Math.max(+S.stage6.beam.Df || 0.0, 0.0), maxDepth);
  S.stage6.beam.zInfluence = Math.max(+S.stage6.beam.zInfluence || 1, 0.5);
  S.stage6.beam.gpEta = Math.max(+S.stage6.beam.gpEta || 1.0, 0);
  if(!['slab_strip','beam_length','footing_transverse'].includes(S.stage6.beam.modelMode)){
    S.stage6.beam.modelMode = 'slab_strip';
  }
  if(S.stage6.beam.gpOverride != null && S.stage6.beam.gpOverride !== ''){
    S.stage6.beam.gpOverride = +S.stage6.beam.gpOverride;
  } else {
    S.stage6.beam.gpOverride = null;
  }
  if(S.stage6.beam.cNomOverride != null && S.stage6.beam.cNomOverride !== ''){
    S.stage6.beam.cNomOverride = +S.stage6.beam.cNomOverride;
  }
  if(!stage6BishopEnabled() && S.stage6.app === 'bishop'){
    S.stage6.app = 'bearing';
  }
  ensurePileState(maxDepth);
  const bishop = S.stage6.bishop;
  const bishopSchemaVersionBeforeSync = Math.round(+bishop.schemaVersion || 0);
  const hsConsistentTangentLegacySchema = bishopSchemaVersionBeforeSync < 3;
  bishop.schemaVersion = Math.max(bishopSchemaVersionBeforeSync, 3);
  if(!Array.isArray(bishop.history)) bishop.history = [];
  const bishopMinDepth = Math.max(stage6MaxDepth(), 15);
  if(!['stability','seepage','deformation'].includes(bishop.workspace)) bishop.workspace = 'stability';
  bishop.useFemPorePressure = !!bishop.useFemPorePressure;
  if(!bishop.measurement || typeof bishop.measurement !== 'object') bishop.measurement = {points:[]};
  if(!Array.isArray(bishop.measurement.points)) bishop.measurement.points = [];
  bishop.measurement.points = bishop.measurement.points
    .filter((pt)=>Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    .slice(0, 2)
    .map((pt)=>({x:+pt.x, y:+pt.y}));
  if(!bishop.lineProbe || typeof bishop.lineProbe !== 'object') bishop.lineProbe = stage6Defaults().bishop.lineProbe;
  bishop.lineProbe.sampleCount = Math.min(Math.max(Math.round(+bishop.lineProbe.sampleCount || 81), 21), 201);
  if(!['head','porePressure','gradient','hydraulicFs','flow','qx','qy','normalFlow'].includes(bishop.lineProbe.seepageQuantity)){
    bishop.lineProbe.seepageQuantity = 'head';
  }
  if(!stage6BishopDeformationQuantityIds(
    bishop.deformation?.options?.analysisType,
    STAGE6_ENABLE_HARDENING_SOIL_UI && bishop.deformation?.result?.hasHardeningSoil === true
  ).includes(bishop.lineProbe.deformationQuantity)){
    bishop.lineProbe.deformationQuantity = 'uTotal';
  }
  bishop.lineProbe.copyMessage = typeof bishop.lineProbe.copyMessage === 'string' ? bishop.lineProbe.copyMessage : '';
  bishop.lineProbe.copyTone = bishop.lineProbe.copyTone === 'warn' ? 'warn' : bishop.lineProbe.copyTone === 'ok' ? 'ok' : '';
  if(bishop.analysisDepth == null || bishop.analysisDepth === ''){
    const legacyBottomMargin = Number(bishop.bottomMargin);
    const hasCustomLegacyMargin = Number.isFinite(legacyBottomMargin) && Math.abs(legacyBottomMargin - 5) > 1e-9;
    bishop.analysisDepth = hasCustomLegacyMargin
      ? stage6MaxDepth() + legacyBottomMargin
      : bishopMinDepth;
  }
  bishop.analysisDepth = Math.max(+bishop.analysisDepth || bishopMinDepth, bishopMinDepth);
  bishop.snapSize = Math.max(+bishop.snapSize || 0.5, 0.05);
  bishop.pointSnap = !!bishop.pointSnap;
  if(!bishop.display || typeof bishop.display !== 'object') bishop.display = stage6Defaults().bishop.display;
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
  if(!bishop.seepage || typeof bishop.seepage !== 'object') bishop.seepage = stage6Defaults().bishop.seepage;
  stage6Merge(bishop.seepage, stage6Defaults().bishop.seepage);
  if(!Array.isArray(bishop.seepage.bcs)) bishop.seepage.bcs = [];
  if(!['idle','meshing','solving','success','failed'].includes(bishop.seepage.status)) bishop.seepage.status = 'idle';
  if(!bishop.seepage.progress || typeof bishop.seepage.progress !== 'object') bishop.seepage.progress = stage6Defaults().bishop.seepage.progress;
  bishop.seepage.progress.running = !!bishop.seepage.progress.running;
  bishop.seepage.progress.percent = Math.max(0, Math.min(100, +bishop.seepage.progress.percent || 0));
  bishop.seepage.progress.message = bishop.seepage.progress.message ? String(bishop.seepage.progress.message) : '';
  bishop.seepage.progress.runId = Math.max(0, Math.round(+bishop.seepage.progress.runId || 0));
  bishop.seepage.rejectReason = bishop.seepage.rejectReason ? String(bishop.seepage.rejectReason) : '';
  if(!bishop.seepage.drainValidation || typeof bishop.seepage.drainValidation !== 'object') bishop.seepage.drainValidation = {errors:[], warnings:[]};
  if(!Array.isArray(bishop.seepage.drainValidation.errors)) bishop.seepage.drainValidation.errors = [];
  if(!Array.isArray(bishop.seepage.drainValidation.warnings)) bishop.seepage.drainValidation.warnings = [];
  bishop.seepage.geometryHash = bishop.seepage.geometryHash ? String(bishop.seepage.geometryHash) : '';
  if(!bishop.seepage.options || typeof bishop.seepage.options !== 'object') bishop.seepage.options = stage6Defaults().bishop.seepage.options;
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
  bishop.seepage.options.meshTargetArea = stage6BishopResolvedSeepageMeshTargetArea(bishop);
  if(!bishop.seepage.display || typeof bishop.seepage.display !== 'object') bishop.seepage.display = stage6Defaults().bishop.seepage.display;
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
  if(!bishop.deformation || typeof bishop.deformation !== 'object') bishop.deformation = stage6Defaults().bishop.deformation;
  stage6Merge(bishop.deformation, stage6Defaults().bishop.deformation);
  const visibleConstitutiveModels = STAGE6_ENABLE_HARDENING_SOIL_UI
    ? ['linear-elastic','mc-reduced-stiffness','mc-plastic','hardening-soil']
    : ['linear-elastic','mc-reduced-stiffness','mc-plastic'];
  if(!visibleConstitutiveModels.includes(bishop.deformation.options.constitutiveModel)){
    bishop.deformation.options.constitutiveModel = stage6Defaults().bishop.deformation.options.constitutiveModel;
    if(!visibleConstitutiveModels.includes(bishop.deformation.options.constitutiveModel)){
      bishop.deformation.options.constitutiveModel = 'mc-plastic';
    }
  }
  // The browser UI no longer exposes the old predictor-only initial mode.
  // Keep that mode available to lower-level scripts through the solver API,
  // but migrate saved UI sessions to the production geostatic workflow.
  bishop.deformation.options.initialStressMode = 'plastic-geostatic';
  if(!['idle','meshing','solving','post','success','failed'].includes(bishop.deformation.status)) bishop.deformation.status = 'idle';
  if(!bishop.deformation.progress || typeof bishop.deformation.progress !== 'object') bishop.deformation.progress = stage6Defaults().bishop.deformation.progress;
  bishop.deformation.progress.running = !!bishop.deformation.progress.running;
  bishop.deformation.progress.percent = Math.max(0, Math.min(100, +bishop.deformation.progress.percent || 0));
  bishop.deformation.progress.message = bishop.deformation.progress.message ? String(bishop.deformation.progress.message) : '';
  bishop.deformation.progress.runId = Math.max(0, Math.round(+bishop.deformation.progress.runId || 0));
  bishop.deformation.rejectReason = bishop.deformation.rejectReason ? String(bishop.deformation.rejectReason) : '';
  if(!Array.isArray(bishop.deformation.warnings)) bishop.deformation.warnings = [];
  if(!bishop.deformation.options || typeof bishop.deformation.options !== 'object') bishop.deformation.options = stage6Defaults().bishop.deformation.options;
  if(hsConsistentTangentLegacySchema && bishop.deformation.options.hsConsistentTangentMigrationResolved !== true){
    bishop.deformation.options.hsConsistentTangentPromptPending = true;
  }
  if(!['deformation','safety-cphi'].includes(bishop.deformation.options.analysisType)){
    bishop.deformation.options.analysisType = stage6Defaults().bishop.deformation.options.analysisType;
  }
  if(!['t3','t6'].includes(String(bishop.deformation.options.meshElementType || '').toLowerCase())){
    bishop.deformation.options.meshElementType = stage6Defaults().bishop.deformation.options.meshElementType;
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
  const deformationAutoMeshTargetArea = stage6BishopAutoDeformationMeshTargetArea(bishop);
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
  bishop.deformation.options.meshTargetArea = stage6BishopResolvedDeformationMeshTargetArea(bishop);
  if(!bishop.deformation.display || typeof bishop.deformation.display !== 'object') bishop.deformation.display = stage6Defaults().bishop.deformation.display;
  if(bishop.deformation.display.contourMode === 'syy') bishop.deformation.display.contourMode = 'deltaSigmaYy';
  if(bishop.deformation.display.contourMode === 'mc') bishop.deformation.display.contourMode = 'mcEta';
  if(!stage6BishopDeformationQuantityIds(
    bishop.deformation?.options?.analysisType,
    STAGE6_ENABLE_HARDENING_SOIL_UI && bishop.deformation?.result?.hasHardeningSoil === true
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
  stage6BishopMigrateSurfaceLoadsShape(bishop);
  if(!bishop.viewport || typeof bishop.viewport !== 'object') bishop.viewport = {scale:24, offsetX:80, offsetY:360, fitted:false};
  if(!['characteristic','da1_1','da1_2'].includes(bishop.strengthSet)) bishop.strengthSet = 'characteristic';
}

function stage6RememberDetailsState(){
  const root = document.getElementById('stage6Area');
  if(!root) return;
  ensureStage6State();
  if(!S.stage6.ui || typeof S.stage6.ui !== 'object') S.stage6.ui = {details:{}};
  if(!S.stage6.ui.details || typeof S.stage6.ui.details !== 'object') S.stage6.ui.details = {};
  root.querySelectorAll('details[data-st6details]').forEach(el=>{
    S.stage6.ui.details[el.dataset.st6details] = !!el.open;
  });
}

function stage6DetailsOpen(key){
  ensureStage6State();
  return S.stage6?.ui?.details?.[key] ? ' open' : '';
}

const STAGE6_SCROLL_PERSIST_SELECTORS = [
  '[data-st6scroll-key]',
  '.st6-canvas-card-body',
  '.st6-canvas-sheet-body',
  '.st6-bishop-view-menu-body',
  '.st6-canvas-table-wrap',
  'details[data-st6details] [style*="overflow"]'
];

function stage6ScrollTargetBaseKey(el){
  const explicit = el?.getAttribute?.('data-st6scroll-key');
  if(explicit) return `explicit:${explicit}`;
  const detailsKey = el?.closest?.('details[data-st6details]')?.dataset?.st6details || '';
  const dialogLabel = el?.closest?.('[role="dialog"][aria-label]')?.getAttribute?.('aria-label') || '';
  const classKey = Array.from(el?.classList || []).sort().join('.');
  const tag = String(el?.tagName || 'node').toLowerCase();
  return `${tag}|${classKey}|${detailsKey}|${dialogLabel}`;
}

function stage6ScrollTargets(root){
  if(!root?.querySelectorAll) return [];
  const seen = new Set();
  const rawTargets = [];
  STAGE6_SCROLL_PERSIST_SELECTORS.forEach((selector)=>{
    root.querySelectorAll(selector).forEach((el)=>{
      if(seen.has(el)) return;
      seen.add(el);
      if(typeof el.scrollTop !== 'number' || typeof el.scrollLeft !== 'number') return;
      rawTargets.push(el);
    });
  });
  const counts = new Map();
  return rawTargets.map((el)=>{
    const baseKey = stage6ScrollTargetBaseKey(el);
    const index = counts.get(baseKey) || 0;
    counts.set(baseKey, index + 1);
    return {el, key:`${baseKey}#${index}`};
  });
}

function stage6CaptureScrollState(root){
  return stage6ScrollTargets(root)
    .map(({el, key})=>({key, top:el.scrollTop || 0, left:el.scrollLeft || 0}))
    .filter((entry)=>entry.top || entry.left);
}

function stage6RestoreScrollState(root, scrollState){
  if(!scrollState?.length) return;
  const byKey = new Map(scrollState.map((entry)=>[entry.key, entry]));
  const restore = ()=>{
    stage6ScrollTargets(root).forEach(({el, key})=>{
      const entry = byKey.get(key);
      if(!entry) return;
      el.scrollTop = entry.top;
      el.scrollLeft = entry.left;
    });
  };
  restore();
  requestAnimationFrame(restore);
}

function stage6SetDetailsOpen(key, open = true){
  ensureStage6State();
  if(!S.stage6.ui || typeof S.stage6.ui !== 'object') S.stage6.ui = {details:{}};
  if(!S.stage6.ui.details || typeof S.stage6.ui.details !== 'object') S.stage6.ui.details = {};
  S.stage6.ui.details[key] = !!open;
}

function stage6BishopUiState(){
  ensureStage6State();
  if(!S.stage6.ui || typeof S.stage6.ui !== 'object') S.stage6.ui = {details:{}};
  if(!S.stage6.ui.details || typeof S.stage6.ui.details !== 'object') S.stage6.ui.details = {};
  return S.stage6.ui;
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
  const defaults = stage6Defaults();
  const currentDefault = stage6Get(defaults, field);
  let nextValue = value;
  if(typeof currentDefault === 'number'){
    nextValue = value === '' || value == null ? null : +value;
  } else if(typeof currentDefault === 'boolean'){
    nextValue = !!value;
  }
  stage6Set(S.stage6, field, nextValue);
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

function stage6BishopSortedPolyline(points){
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

function stage6BishopSortZone(zone){
  if(!zone || !Number.isFinite(zone.xStart) || !Number.isFinite(zone.xEnd)) return null;
  return {
    ...zone,
    xStart:Math.min(zone.xStart, zone.xEnd),
    xEnd:Math.max(zone.xStart, zone.xEnd)
  };
}

function stage6BishopValidZone(zone){
  return !!zone
    && Number.isFinite(zone.xStart)
    && Number.isFinite(zone.xEnd)
    && Math.abs(zone.xEnd - zone.xStart) > 1e-6;
}

function stage6BishopAllocateSurfaceLoadId(bishop){
  const taken = new Set((bishop.surfaceLoads || []).map((load)=>String(load?.id || '')).filter(Boolean));
  let index = 1;
  while(taken.has(`load-${index}`)) index += 1;
  return `load-${index}`;
}

function stage6BishopNormalizeSurfaceLoad(load, index, bishop){
  const out = load && typeof load === 'object' ? {...load} : {};
  out.id = String(out.id || `load-${index + 1}`);
  out.label = String(out.label || `Load ${index + 1}`).slice(0, 64);
  out.q = Math.max(Number(out.q) || 0, 0);
  out.totalLoad = Math.max(Number(out.totalLoad) || 0, 0);
  out.loadMode = out.loadMode === 'total' ? 'total' : out.loadMode === 'pressure'
    ? 'pressure'
    : bishop?.deformation?.options?.loadMode === 'total'
      ? 'total'
      : 'pressure';
  out.active = out.active !== false;
  if(Number.isFinite(Number(out.xStart))) out.xStart = Number(out.xStart);
  else out.xStart = null;
  if(Number.isFinite(Number(out.xEnd))) out.xEnd = Number(out.xEnd);
  else out.xEnd = null;
  const sorted = stage6BishopSortZone(out);
  return sorted || out;
}

function stage6BishopSyncLegacySurfaceLoadMirror(bishop = S.stage6?.bishop){
  if(!bishop) return;
  const first = (bishop.surfaceLoads || []).find((load)=>load?.active !== false)
    || (bishop.surfaceLoads || [])[0]
    || null;
  bishop.surfaceLoad = first
    ? {xStart:first.xStart, xEnd:first.xEnd, q:Math.max(Number(first.q) || 0, 0)}
    : {
      xStart:null,
      xEnd:null,
      q:Math.max(Number(bishop.surfaceLoad?.q) || 0, 0)
    };
}

function stage6BishopLegacySurfaceLoadSeed(bishop, legacy){
  if(!legacy || !Number.isFinite(Number(legacy.xStart)) || !Number.isFinite(Number(legacy.xEnd))) return null;
  const migratedLegacy = stage6BishopNormalizeSurfaceLoad({
    id:stage6BishopAllocateSurfaceLoadId(bishop),
    label:'Load 1',
    xStart:Number(legacy.xStart),
    xEnd:Number(legacy.xEnd),
    q:Math.max(Number(legacy.q) || 0, 0),
    totalLoad:Math.max(Number(bishop.deformation?.options?.totalLoad) || 0, 0),
    loadMode:bishop.deformation?.options?.loadMode === 'total' ? 'total' : 'pressure',
    active:true
  }, 0, bishop);
  return stage6BishopValidZone(migratedLegacy) ? migratedLegacy : null;
}

function stage6BishopMigrateSurfaceLoadsShape(bishop){
  if(!bishop) return;
  const legacy = bishop.surfaceLoad && typeof bishop.surfaceLoad === 'object' ? bishop.surfaceLoad : null;
  const hadLoads = Array.isArray(bishop.surfaceLoads);
  if(!hadLoads) bishop.surfaceLoads = [];
  if(!bishop.surfaceLoads.length){
    const seed = stage6BishopLegacySurfaceLoadSeed(bishop, legacy);
    if(seed) bishop.surfaceLoads.push(seed);
  }
  const used = new Set();
  bishop.surfaceLoads = (bishop.surfaceLoads || []).map((load, index)=>{
    const normalized = stage6BishopNormalizeSurfaceLoad(load, index, bishop);
    let id = normalized.id || `load-${index + 1}`;
    if(used.has(id)){
      id = stage6BishopAllocateSurfaceLoadId({...bishop, surfaceLoads:[...used].map((item)=>({id:item}))});
    }
    used.add(id);
    normalized.id = id;
    return normalized;
  }).filter((load)=>stage6BishopValidZone(load));
  if(!bishop.surfaceLoads.length){
    const seed = stage6BishopLegacySurfaceLoadSeed(bishop, legacy);
    if(seed) bishop.surfaceLoads.push(seed);
  }
  bishop.surfaceLoads.forEach((load, index)=>{
    if(/^Load\s+\d+$/i.test(String(load.label || ''))) load.label = `Load ${index + 1}`;
  });
  if(bishop.selectedSurfaceLoadId && !(bishop.surfaceLoads || []).some((load)=>load.id === bishop.selectedSurfaceLoadId)){
    bishop.selectedSurfaceLoadId = null;
  }
  stage6BishopSyncLegacySurfaceLoadMirror(bishop);
}

function stage6BishopSelectedSurfaceLoad(){
  const bishop = S.stage6?.bishop;
  if(!bishop) return null;
  return (bishop.surfaceLoads || []).find((load)=>load.id === bishop.selectedSurfaceLoadId) || null;
}

function stage6BishopPrimarySurfaceLoad(create = false){
  const bishop = S.stage6?.bishop;
  if(!bishop) return null;
  stage6BishopMigrateSurfaceLoadsShape(bishop);
  let load = stage6BishopSelectedSurfaceLoad()
    || (bishop.surfaceLoads || []).find((item)=>item.active !== false)
    || (bishop.surfaceLoads || [])[0]
    || null;
  if(!load && create){
    load = {
      id:stage6BishopAllocateSurfaceLoadId(bishop),
      label:`Load ${(bishop.surfaceLoads || []).length + 1}`,
      xStart:null,
      xEnd:null,
      q:Math.max(Number(bishop.surfaceLoad?.q) || 5, 0),
      totalLoad:0,
      loadMode:'pressure',
      active:true
    };
    bishop.surfaceLoads = [...(bishop.surfaceLoads || []), load];
    bishop.selectedSurfaceLoadId = load.id;
    stage6BishopSyncLegacySurfaceLoadMirror(bishop);
  }
  return load;
}

function stage6BishopEffectiveSurfaceLoadQ(load, workspace = S.stage6?.bishop?.workspace || 'stability'){
  if(!load) return 0;
  const bishop = S.stage6?.bishop;
  const loadMode = load.loadMode === 'total'
    ? 'total'
    : load.loadMode === 'pressure'
      ? 'pressure'
      : workspace === 'deformation' && bishop?.deformation?.options?.loadMode === 'total'
        ? 'total'
        : 'pressure';
  const width = Math.abs((Number(load.xEnd) || 0) - (Number(load.xStart) || 0));
  if(loadMode === 'total'){
    const outOfPlaneLength = Math.max(Number(bishop?.deformation?.options?.outOfPlaneLength) || 10, 0.1);
    const loadCount = Array.isArray(bishop?.surfaceLoads) ? bishop.surfaceLoads.length : 0;
    const legacyTotalLoad = loadCount <= 1 ? Number(bishop?.deformation?.options?.totalLoad) || 0 : 0;
    const totalLoad = Math.max(Number(load.totalLoad) || legacyTotalLoad || 0, 0);
    return width > 1e-9 ? totalLoad / Math.max(width * outOfPlaneLength, 1e-6) : 0;
  }
  return Math.max(Number(load.q) || 0, 0);
}

function stage6BishopSurfaceLoadSummary(load, workspace = S.stage6?.bishop?.workspace || 'stability'){
  if(!stage6BishopValidZone(load)) return 'not set';
  const q = stage6BishopEffectiveSurfaceLoadQ(load, workspace);
  const modeLabel = load.loadMode === 'total' ? `total ${Math.max(Number(load.totalLoad) || 0, 0).toFixed(1)} kN` : `${q.toFixed(1)} kPa`;
  return `${load.xStart.toFixed(2)}-${load.xEnd.toFixed(2)} m @ ${modeLabel}${load.active === false ? ' (inactive)' : q > 0 ? '' : ' (zero)'}`;
}

function stage6BishopActiveSurfaceLoads(workspace = S.stage6?.bishop?.workspace || 'stability'){
  const bishop = S.stage6?.bishop;
  if(!bishop) return [];
  stage6BishopMigrateSurfaceLoadsShape(bishop);
  return (bishop.surfaceLoads || []).filter((load)=>load.active !== false && stage6BishopValidZone(load) && stage6BishopEffectiveSurfaceLoadQ(load, workspace) > 0);
}

function stage6BishopSetSurfaceLoadField(loadId, field, value){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  stage6BishopMigrateSurfaceLoadsShape(bishop);
  const load = (bishop.surfaceLoads || []).find((item)=>item.id === loadId);
  if(!load) return;
  if(field === 'active'){
    load.active = !!value;
  } else if(field === 'label'){
    load.label = String(value || '').slice(0, 64);
  } else if(field === 'loadMode'){
    load.loadMode = value === 'total' ? 'total' : 'pressure';
  } else if(field === 'q'){
    load.q = Math.max(Number(value) || 0, 0);
  } else if(field === 'totalLoad'){
    load.totalLoad = Math.max(Number(value) || 0, 0);
  } else if(field === 'xStart' || field === 'xEnd'){
    const x = Number(value);
    if(!Number.isFinite(x)) return;
    const minX = bishop.terrain?.[0]?.x ?? -Infinity;
    const maxX = bishop.terrain?.[bishop.terrain.length - 1]?.x ?? Infinity;
    load[field] = Math.min(Math.max(x, minX), maxX);
    Object.assign(load, stage6BishopSortZone(load) || load);
  } else {
    return;
  }
  bishop.selectedSurfaceLoadId = load.id;
  stage6BishopSyncLegacySurfaceLoadMirror(bishop);
  stage6BishopInvalidate('Surface load changed; rerun the active analysis.');
  renderStage6();
}

function stage6BishopSelectSurfaceLoad(loadId){
  ensureStage6State();
  stage6BishopMigrateSurfaceLoadsShape(S.stage6.bishop);
  S.stage6.bishop.selectedSurfaceLoadId = loadId || null;
  if(loadId) S.stage6.bishop.tool = 'edit';
  renderStage6();
}

function stage6BishopDeleteSurfaceLoad(loadId){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  const before = (bishop.surfaceLoads || []).length;
  bishop.surfaceLoads = (bishop.surfaceLoads || []).filter((load)=>load.id !== loadId);
  if(bishop.selectedSurfaceLoadId === loadId) bishop.selectedSurfaceLoadId = null;
  if(bishop.surfaceLoads.length !== before){
    stage6BishopSyncLegacySurfaceLoadMirror(bishop);
    stage6BishopInvalidate('Surface load deleted; rerun the active analysis.');
  }
  renderStage6();
}

function stage6BishopCreateSurfaceLoadFromZone(zone){
  const bishop = S.stage6.bishop;
  stage6BishopMigrateSurfaceLoadsShape(bishop);
  if(!stage6BishopValidZone(zone)) return null;
  const source = stage6BishopPrimarySurfaceLoad(false);
  const id = stage6BishopAllocateSurfaceLoadId(bishop);
  const load = {
    id,
    label:`Load ${(bishop.surfaceLoads || []).length + 1}`,
    xStart:zone.xStart,
    xEnd:zone.xEnd,
    q:Math.max(Number(source?.q ?? bishop.surfaceLoad?.q) || 5, 0),
    totalLoad:Math.max(Number(source?.totalLoad) || 0, 0),
    loadMode:source?.loadMode === 'total' ? 'total' : 'pressure',
    active:true
  };
  bishop.surfaceLoads = [...(bishop.surfaceLoads || []), load];
  bishop.selectedSurfaceLoadId = id;
  bishop.tool = 'edit';
  stage6BishopSyncLegacySurfaceLoadMirror(bishop);
  stage6BishopInvalidate('Surface load added; rerun the active analysis.');
  return load;
}

function stage6BishopZoneKey(kind){
  if(kind === 'entry') return 'entryZone';
  if(kind === 'exit') return 'exitZone';
  if(kind === 'load') return 'surfaceLoad';
  return '';
}

function stage6BishopZoneLabel(kind){
  if(kind === 'entry') return 'Entry zone';
  if(kind === 'exit') return 'Exit zone';
  if(kind === 'load') return 'Load zone';
  return 'Zone';
}

function stage6BishopZoneColor(kind){
  if(kind === 'entry') return '#3aa35f';
  if(kind === 'exit') return '#d27b2d';
  if(kind === 'load') return '#b3477a';
  return '#5c6b7a';
}

function stage6BishopPassiveSideLabel(side){
  return side === 'left' ? 'Left' : 'Right';
}

function stage6BishopDefaultPassiveSide(){
  const terrain = S.stage6?.bishop?.terrain || [];
  if(terrain.length >= 2){
    return terrain[terrain.length-1].y <= terrain[0].y ? 'right' : 'left';
  }
  return 'right';
}

function stage6BishopWallId(){
  return `wall_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
}

function stage6BishopDefaultWallMaterial(index = 0, wallId = ''){
  return normalizeWallMaterial(
    {
      id:`wall-material-${wallId || index + 1}`,
      label:'Concrete diaphragm',
      kAcross:1e-12,
      kAlong:1e-12,
      gamma:24,
      gammaSat:24,
      kSource:'preset',
      mechanical:defaultWallMechanicalMaterial('preset')
    },
    index,
    wallId || `${index + 1}`,
    {sourceFallback:'preset', mechanicalPreset:'concrete-diaphragm'}
  );
}

function stage6BishopWallMaterialPreset(preset, index = 0, wallId = ''){
  const presets = {
    sheetPile:{label:'Sheet pile', kAcross:1e-10, kAlong:1e-8},
    'steel-sheet-pile-AZ-26':{label:'Steel sheet pile AZ 26', kAcross:1e-12, kAlong:1e-12, gamma:78, gammaSat:78},
    'concrete-diaphragm':{label:'Concrete diaphragm', kAcross:1e-12, kAlong:1e-12, gamma:24, gammaSat:24},
    slurry:{label:'Slurry wall', kAcross:1e-9, kAlong:1e-9},
    diaphragm:{label:'Diaphragm wall', kAcross:1e-9, kAlong:1e-9},
    soilMix:{label:'Soil-mix wall', kAcross:1e-7, kAlong:1e-7},
    relief:{label:'Relief wall', kAcross:1e-6, kAlong:1e-5},
    legacy:{label:'Legacy impermeable', kAcross:1e-10, kAlong:1e-10}
  };
  const presetDef = presets[preset] || presets.legacy;
  const mechanicalPreset = wallMechanicalPresetById(preset);
  return normalizeWallMaterial(
    {
      id:`wall-material-${wallId || index + 1}`,
      ...presetDef,
      kSource:'preset',
      mechanical:mechanicalPreset?.mechanical
    },
    index,
    wallId || `${index + 1}`,
    {sourceFallback:'preset', mechanicalPreset:preset}
  );
}

function stage6BishopWallMaterialPresetKey(material){
  if(material?.kSource === 'legacy-impermeable') return 'legacy';
  if(material?.kSource === 'user') return 'custom';
  const mechanical = material?.mechanical || {};
  if(mechanical.model === 'section-properties') return 'steel-sheet-pile-AZ-26';
  if(mechanical.model === 'rectangular' && Math.abs((Number(mechanical.E) || 0) - 3e7) <= 3e4 && Math.abs((Number(mechanical.thickness) || 0) - 0.6) <= 1e-6) return 'concrete-diaphragm';
  const kAcross = Number(material?.kAcross);
  const kAlong = Number(material?.kAlong);
  const close = (value, target)=>Number.isFinite(value) && Math.abs(value - target) <= Math.max(Math.abs(target) * 1e-9, 1e-16);
  if(close(kAcross, 1e-10) && close(kAlong, 1e-8)) return 'sheetPile';
  if(close(kAcross, 1e-9) && close(kAlong, 1e-9)) return String(material?.label || '').toLowerCase().includes('diaphragm') ? 'diaphragm' : 'slurry';
  if(close(kAcross, 1e-7) && close(kAlong, 1e-7)) return 'soilMix';
  if(close(kAcross, 1e-6) && close(kAlong, 1e-5)) return 'relief';
  if(close(kAcross, 1e-10) && close(kAlong, 1e-10)) return 'legacy';
  return 'custom';
}

function stage6BishopNormalizeWalls(walls, terrain){
  const terrainLine = terrain?.length ? {vertices:terrain} : null;
  const minX = terrain?.length ? terrain[0].x : -Infinity;
  const maxX = terrain?.length ? terrain[terrain.length-1].x : Infinity;
  return (walls || [])
    .map((wall, index)=>{
      const id = wall?.id || `wall-${index + 1}`;
      const hadMaterial = !!(wall?.material && typeof wall.material === 'object');
      const hasMechanicalActiveField = Object.prototype.hasOwnProperty.call(wall || {}, 'mechanicalActive');
      const mechanicalActive = hasMechanicalActiveField ? wall?.mechanicalActive === true : false;
      const legacyX = Number.isFinite(+wall?.x) ? +wall.x : minX;
      const xFallback = Math.min(Math.max(legacyX, minX), maxX);
      const endpoints = wallEndpoints(wall);
      const headRaw = endpoints?.head || {
        x:xFallback,
        y:Number.isFinite(+wall?.yTop)
          ? +wall.yTop
          : terrainLine
            ? bishopTerrainY(terrainLine, xFallback)
            : NaN
      };
      const tipRaw = endpoints?.tip || {
        x:xFallback,
        y:Number.isFinite(+wall?.yTip) ? +wall.yTip : NaN
      };
      const head = {
        x:Math.min(Math.max(Number(headRaw.x), minX), maxX),
        y:Number(headRaw.y)
      };
      let tip = {
        x:Math.min(Math.max(Number(tipRaw.x), minX), maxX),
        y:Number(tipRaw.y)
      };
      if(Number.isFinite(head.x) && Number.isFinite(head.y) && Number.isFinite(tip.x) && Number.isFinite(tip.y)){
        const len = Math.hypot(tip.x - head.x, tip.y - head.y);
        if(len < 0.05){
          tip = {x:head.x, y:head.y - 0.05};
        }
      }
      return {
        id,
        head,
        tip,
        // Legacy aliases kept during migration for old UI/report code.
        x:head.x,
        yTop:head.y,
        yTip:tip.y,
        passiveSide:wall?.passiveSide === 'left' ? 'left' : 'right',
        mechanicalActive,
        mechanicalActivationPromptPending:!hasMechanicalActiveField && !!wall,
        anchors:Array.isArray(wall?.anchors) ? wall.anchors : [],
        maxShearForce:Number.isFinite(+wall?.maxShearForce) && +wall.maxShearForce > 0 ? +wall.maxShearForce : null,
        material:normalizeWallMaterial(wall?.material, index, id, {
          sourceFallback:hadMaterial ? 'user' : 'legacy-impermeable',
          mechanicalPreset:mechanicalActive ? 'concrete-diaphragm' : null
        })
      };
    })
    .filter((wall)=>wallAxis(wall, 1e-9))
    .map((wall)=>{
      wall.head = {x:+wall.head.x.toFixed(3), y:+wall.head.y.toFixed(3)};
      wall.tip = {x:+wall.tip.x.toFixed(3), y:+wall.tip.y.toFixed(3)};
      wall.x = wall.head.x;
      wall.yTop = wall.head.y;
      wall.yTip = wall.tip.y;
      return wall;
    })
    .sort((a,b)=>a.head.x-b.head.x || b.head.y-a.head.y || a.tip.x-b.tip.x);
}

function stage6BishopDrainId(){
  return `drain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
}

function stage6BishopNormalizeDrains(drains){
  return normalizeDrains(drains || [])
    .filter((drain)=>drain.vertices.length >= 2)
    .map((drain, index)=>({
      ...drain,
      id:drain.id || `drain-${index + 1}`,
      label:drain.label || `Drain ${index + 1}`
    }));
}

function stage6BishopDefaultDrainHead(vertices){
  const first = vertices?.[0] || null;
  return {
    kind:'constant',
    value:Number.isFinite(+first?.y) ? +first.y : 0
  };
}

function stage6BishopCreateDrainFromVertices(vertices){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  const drainId = stage6BishopDrainId();
  const candidate = normalizeDrain({
    id:drainId,
    label:`Drain ${(bishop.drains || []).length + 1}`,
    vertices,
    closed:false,
    head:stage6BishopDefaultDrainHead(vertices),
    gating:'when-saturated'
  }, (bishop.drains || []).length);
  const model = {
    ...(S.stage6Cache?.bishopModel || stage6BishopCurrentModel() || {}),
    drains:[...(bishop.drains || []), candidate]
  };
  const validation = validateDrains(model);
  if(validation.errors.length){
    bishop.progress.message = validation.errors[0].message;
    bishop.seepage.drainValidation = validation;
    return false;
  }
  bishop.drains = stage6BishopNormalizeDrains([...(bishop.drains || []), candidate]);
  bishop.selectedDrainId = drainId;
  bishop.seepage.drainValidation = validation;
  bishop.workspace = 'seepage';
  stage6SetDetailsOpen('bishop-seepage-drains', true);
  stage6BishopInvalidateSeepage('Drain added. Set the drain head, then rerun seepage.', true, true);
  return true;
}

function stage6BishopDrainValidationSummary(validation){
  const errorCount = validation?.errors?.length || 0;
  const warningCount = validation?.warnings?.length || 0;
  if(errorCount) return `${errorCount} drain validation ${errorCount === 1 ? 'error' : 'errors'}`;
  if(warningCount) return `${warningCount} drain validation ${warningCount === 1 ? 'warning' : 'warnings'}`;
  return 'ok';
}

function stage6BishopDrainGatingLabel(value){
  if(value === 'always') return 'Always';
  if(value === 'head-cap') return 'Head cap';
  return 'When saturated';
}

function stage6BishopRegionId(){
  return `region_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,7)}`;
}

const STAGE6_REGION_COORD_DECIMALS = 6;
const STAGE6_REGION_COARSENESS_DECIMALS = 3;

function stage6BishopRoundRegionCoord(value){
  return +Number(value).toFixed(STAGE6_REGION_COORD_DECIMALS);
}

function stage6BishopNormalizeRegionCoarseness(value){
  const numeric = Number(value);
  if(!Number.isFinite(numeric) || !(numeric > 0)) return 1;
  return +numeric.toFixed(STAGE6_REGION_COARSENESS_DECIMALS);
}

function stage6BishopClampRegionPoint(point, minX = -Infinity, maxX = Infinity){
  return {
    x:stage6BishopRoundRegionCoord(Math.min(Math.max(Number(point?.x), minX), maxX)),
    y:stage6BishopRoundRegionCoord(Number(point?.y))
  };
}

function stage6BishopNormalizeCustomRegions(regions, terrain, materials){
  const minX = terrain?.length ? terrain[0].x : -Infinity;
  const maxX = terrain?.length ? terrain[terrain.length-1].x : Infinity;
  const materialIds = new Set((materials || []).map((material)=>material.id));
  const fallbackMaterialId = materials?.[0]?.id || null;
  return (regions || [])
    .map((region)=>{
      const rawPolygon = (region?.polygon || [])
        .map((pt)=>({
          x:Number(pt?.x),
          y:Number(pt?.y)
        }))
        .filter((pt)=>Number.isFinite(pt.x) && Number.isFinite(pt.y))
        .map((pt)=>stage6BishopClampRegionPoint(pt, minX, maxX));
      const polygon = normalizeRegionPolygon(rawPolygon);
      const materialId = materialIds.has(region?.materialId) ? region.materialId : fallbackMaterialId;
      return {
        id:region?.id || stage6BishopRegionId(),
        polygon,
        materialId,
        coarseness:stage6BishopNormalizeRegionCoarseness(region?.coarseness),
        source:region?.source === 'cpt-copy' ? 'cpt-copy' : region?.source === 'hole' ? 'hole' : region?.source === 'edited' ? 'edited' : 'custom'
      };
    })
    .filter((region)=>region.materialId && region.polygon.length >= 3 && polygonArea(region.polygon) > 1e-4 && isSimplePolygon(region.polygon));
}

function stage6BishopSelectedCustomRegion(){
  const bishop = S?.stage6?.bishop;
  if(!bishop) return null;
  return (bishop.customRegions || []).find((region)=>region.id === bishop.selectedRegionId) || null;
}

function stage6BishopResultWallLabel(result){
  if(!result) return '—';
  if(result.intersectsWall) return `${result.wallIntersectionCount || 0} engaged`;
  if(result.passesBelowWall) return 'passes below';
  return 'no wall effect';
}

function stage6BishopInvalidateSeepage(message, keepMesh, preserveSolvedState){
  ensureStage6State();
  stage6BishopStopSeepage(true);
  const seepage = S.stage6.bishop.seepage;
  const keepSolvedState = !!preserveSolvedState && !!seepage.mesh && !!seepage.result;
  seepage.progress.running = false;
  seepage.progress.percent = 0;
  if(keepSolvedState){
    seepage.stale = true;
    seepage.status = 'success';
    if(message) seepage.rejectReason = message;
    return;
  }
  if(!keepMesh) seepage.mesh = null;
  seepage.result = null;
  seepage.stale = false;
  if(seepage.status === 'success' || seepage.status === 'meshing' || seepage.status === 'solving') seepage.status = 'idle';
  if(message) seepage.rejectReason = message;
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
  const deformation = S.stage6.bishop.deformation;
  const keepSolvedState = !!preserveSolvedState && !!deformation.mesh && !!deformation.result;
  deformation.progress.running = false;
  deformation.progress.percent = 0;
  if(keepSolvedState){
    deformation.stale = true;
    deformation.status = 'success';
    if(message) deformation.rejectReason = message;
    return;
  }
  if(!keepMesh) deformation.mesh = null;
  deformation.result = null;
  deformation.stale = false;
  deformation.warnings = [];
  if(['success','meshing','solving','post'].includes(deformation.status)) deformation.status = 'idle';
  deformation.rejectReason = message || '';
}

function stage6BishopInvalidate(message){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  stage6BishopStopSearch(true);
  stage6BishopStopDeformation(true);
  bishop.results = null;
  bishop.selectedResult = 0;
  bishop.stale = true;
  if(bishop.deformation){
    bishop.deformation.mesh = null;
    bishop.deformation.result = null;
    bishop.deformation.stale = false;
    bishop.deformation.warnings = [];
    bishop.deformation.progress.running = false;
    bishop.deformation.progress.percent = 0;
    if(['success','meshing','solving','post'].includes(bishop.deformation.status)) bishop.deformation.status = 'idle';
    bishop.deformation.rejectReason = '';
  }
  if(message) bishop.progress.message = message;
}

function stage6BishopInvalidateWallGeometry(message){
  stage6BishopInvalidate(message || 'Retaining wall geometry changed; rerun Bishop search.');
  stage6BishopInvalidateSeepage('Wall geometry changed; rerun seepage.', false, false);
}

function stage6BishopSyncSoilModel(){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  stage6BishopMigrateSurfaceLoadsShape(bishop);
  const layers = stage6WorkingLayers();
  const signature = bishopLayerSignature(layers);
  const hadSignature = !!bishop.sourceLayerSignature;
  const strengthSetChanged = bishop.sourceStrengthSet !== bishop.strengthSet;
  if(signature !== bishop.sourceLayerSignature || !bishop.materials.length || strengthSetChanged){
    bishop.materials = importBishopMaterialsFromLayers(layers, bishop.materials || [], bishop.strengthSet || 'characteristic');
    bishop.sourceLayerSignature = signature;
    bishop.sourceStrengthSet = bishop.strengthSet;
    if(hadSignature) stage6BishopInvalidate(strengthSetChanged ? 'Material strength set changed; Bishop results were cleared.' : 'Active CPT layers changed; Bishop results were cleared.');
  }
  bishop.materials.forEach((material, index)=>{
    const layer = layers[index];
    if(!Number.isFinite(Number(material?.rShear))){
      material.rShear = Number.isFinite(Number(layer?.rShear)) ? Number(layer.rShear) : 0.25;
    }
    // The HS stiffness fields (E50_ref / Eoed_ref / Eur_ref / m / ν_ur) and
    // the cohesion/friction-derived K0_nc + ψ are computed upstream in
    // `hsParams` per CUR 2003-7 / SB260-21-6.4.10 (cohesion-corrected
    // formula + binary stress-exponent default, with Stage 5 m-fit
    // overrides).  Mirror them onto the bishop material on every sync so
    // toggling alphaMethod / stiffMethod / m_ovr upstream is reflected
    // without requiring a full layer-signature rebuild.
    const fallbackE50 = Number(material.Emc) || 1000;
    material.E50_ref = Number(layer?.E50_ref) || fallbackE50;
    material.Eoed_ref = Number(layer?.Eoed_ref) || material.E50_ref;
    material.Eur_ref = Number(layer?.Eur_ref) || 3 * material.E50_ref;
    material.m = Math.min(Math.max(Number.isFinite(Number(layer?.m)) ? Number(layer.m) : 0.5, 0), 1);
    material.nu_ur = Math.min(Math.max(Number.isFinite(Number(layer?.nu_ur)) ? Number(layer.nu_ur) : 0.2, -0.99), 0.49);
    if(Number.isFinite(Number(layer?.K0nc))) material.K0nc = Number(layer.K0nc);
    if(Number.isFinite(Number(layer?.psi))) material.psi = Number(layer.psi);
    // HS-only sub-block: parameters with no upstream analogue. Only these
    // are editable from the HS panel; the inherited block above is
    // read-only (engineer edits them via the Stage 5 layer / material
    // editor).
    if(!material.hs || typeof material.hs !== 'object') material.hs = {};
    const hs = material.hs;
    hs.p_ref = Math.max(Number(hs.p_ref) || 100, 1e-6);
    hs.Rf = Math.min(Math.max(Number.isFinite(Number(hs.Rf)) ? Number(hs.Rf) : 0.9, 1e-6), 0.999999);
    hs.e_init = Number.isFinite(Number(hs.e_init)) ? Number(hs.e_init) : -1;
    hs.e_max = Number.isFinite(Number(hs.e_max)) ? Number(hs.e_max) : -1;
    hs.OCR = Math.max(Number(hs.OCR) || 1, 1e-6);
    const legacyHsReserved = Number(hs.reserved);
    hs.nearSurfaceMinConfiningStress = Math.max(
      Number.isFinite(Number(hs.nearSurfaceMinConfiningStress))
        ? Number(hs.nearSurfaceMinConfiningStress)
        : (Number.isFinite(legacyHsReserved) ? legacyHsReserved : 0),
      0
    );
    const hasStoredHsConsistentTangent = Object.prototype.hasOwnProperty.call(hs, 'useConsistentTangent');
    if(hasStoredHsConsistentTangent){
      hs.useConsistentTangent = hs.useConsistentTangent === true || Number(hs.useConsistentTangent) >= 0.5;
    } else {
      // Existing projects saved before the HS selector existed must not
      // silently flip into the Simo-Hughes path. New projects are handled in
      // importBishopMaterialsFromLayers(), which writes the field explicitly.
      hs.useConsistentTangent = false;
      if(bishop.deformation?.options && bishop.deformation.options.hsConsistentTangentMigrationResolved !== true){
        bishop.deformation.options.hsConsistentTangentPromptPending = true;
      }
    }
    if('reserved' in hs) delete hs.reserved;
    // Strip legacy stiffness fields that may linger on an existing
    // material.hs from older project files — they now live at the
    // material's top level.
    if('E50_ref' in hs) delete hs.E50_ref;
    if('Eoed_ref' in hs) delete hs.Eoed_ref;
    if('Eur_ref' in hs) delete hs.Eur_ref;
    if('m' in hs) delete hs.m;
    if('nu_ur' in hs) delete hs.nu_ur;
    if('K0_nc' in hs) delete hs.K0_nc;
  });
  if(!Array.isArray(bishop.customRegions)) bishop.customRegions = [];
  bishop.useCustomRegions = !!bishop.useCustomRegions;
  if(Array.isArray(bishop.terrain) && bishop.terrain.length >= 2){
    const sorted = stage6BishopSortedPolyline(bishop.terrain);
    bishop.terrain = sorted;
    const minX = sorted[0].x;
    const maxX = sorted[sorted.length-1].x;
    if(!Number.isFinite(bishop.activeCptX)){
      bishop.activeCptX = 0.5*(minX+maxX);
    } else {
      bishop.activeCptX = Math.min(Math.max(+bishop.activeCptX, minX), maxX);
    }
    ['entryZone','exitZone'].forEach((key)=>{
      const zone = stage6BishopSortZone(bishop[key]);
      if(!zone) return;
      zone.xStart = Math.min(Math.max(zone.xStart, minX), maxX);
      zone.xEnd = Math.min(Math.max(zone.xEnd, minX), maxX);
      bishop[key] = stage6BishopSortZone(zone);
    });
    bishop.surfaceLoads = (bishop.surfaceLoads || []).map((load, index)=>{
      const normalized = stage6BishopNormalizeSurfaceLoad(load, index, bishop);
      if(stage6BishopValidZone(normalized)){
        normalized.xStart = Math.min(Math.max(normalized.xStart, minX), maxX);
        normalized.xEnd = Math.min(Math.max(normalized.xEnd, minX), maxX);
        return stage6BishopSortZone(normalized) || normalized;
      }
      return normalized;
    }).filter((load)=>stage6BishopValidZone(load));
    stage6BishopSyncLegacySurfaceLoadMirror(bishop);
    bishop.walls = stage6BishopNormalizeWalls(bishop.walls, sorted);
    bishop.drains = stage6BishopNormalizeDrains(bishop.drains);
    bishop.customRegions = stage6BishopNormalizeCustomRegions(bishop.customRegions, sorted, bishop.materials);
  }
  bishop.selectedWallId = bishop.selectedWallId ? String(bishop.selectedWallId) : null;
  if(bishop.selectedWallId && !(bishop.walls || []).some((wall)=>wall.id === bishop.selectedWallId)){
    bishop.selectedWallId = null;
  }
  if(!(bishop.drains || []).some((drain)=>drain.id === bishop.selectedDrainId)){
    bishop.selectedDrainId = bishop.drains?.[0]?.id || '';
  }
  const validMaterialIds = new Set((bishop.materials || []).map((material)=>material.id));
  if(!validMaterialIds.has(bishop.regionDraftMaterialId)){
    bishop.regionDraftMaterialId = bishop.materials?.[0]?.id || null;
  }
  if(!(bishop.customRegions || []).some((region)=>region.id === bishop.selectedRegionId)){
    bishop.selectedRegionId = bishop.customRegions?.[0]?.id || null;
  }
  if(!(bishop.customRegions || []).length) bishop.useCustomRegions = false;
  if((bishop.tool === 'regionSplit' || bishop.tool === 'regionHole') && !bishop.selectedRegionId){
    bishop.tool = 'edit';
    bishop.draft = [];
    bishop.draftKind = '';
  }
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
  S.stage6.bishop.selectedRegionId = regionId || null;
  renderStage6();
}

function stage6BishopCopyCurrentRegionsToCustom(){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  const model = stage6BishopCurrentModel();
  if(!model?.regions?.length){
    bishop.progress.message = 'Draw terrain and place the active CPT marker before copying solver polygons.';
    renderStage6();
    return;
  }
  bishop.customRegions = model.regions.map((region, index)=>({
    id:stage6BishopRegionId(),
    polygon:(region.polygon || []).map((pt)=>stage6BishopClampRegionPoint(pt)),
    materialId:region.material?.id || bishop.materials?.[0]?.id || null,
    coarseness:stage6BishopNormalizeRegionCoarseness(region?.coarseness),
    source:index < (model.autoRegions?.length || 0) ? 'cpt-copy' : 'custom'
  }));
  bishop.useCustomRegions = bishop.customRegions.length > 0;
  bishop.selectedRegionId = bishop.customRegions[0]?.id || null;
  bishop.regionDraftMaterialId = bishop.customRegions[0]?.materialId || bishop.materials?.[0]?.id || null;
  if(bishop.useCustomRegions) stage6BishopCurrentModel();
  stage6BishopInvalidate('Current solver polygons were copied into an editable custom polygon set and automatically enabled in the solver; rerun Bishop search after edits.');
  renderStage6();
}

function stage6BishopSetUseCustomRegions(value){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  bishop.useCustomRegions = !!value && (bishop.customRegions || []).length > 0;
  stage6BishopInvalidate(bishop.useCustomRegions ? 'Custom soil polygons enabled; rerun Bishop search.' : 'Reverted to CPT-derived soil polygons; rerun Bishop search.');
  renderStage6();
}

function stage6BishopClearCustomRegions(message){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  bishop.customRegions = [];
  bishop.useCustomRegions = false;
  bishop.selectedRegionId = null;
  stage6BishopInvalidate(message || 'Custom soil polygons were cleared; Bishop reverted to CPT-derived polygons.');
}

function stage6BishopDeleteSelectedRegion(){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  const selectedId = bishop.selectedRegionId;
  if(!selectedId) return;
  bishop.customRegions = (bishop.customRegions || []).filter((region)=>region.id !== selectedId);
  bishop.selectedRegionId = bishop.customRegions[0]?.id || null;
  if(!bishop.customRegions.length){
    bishop.useCustomRegions = false;
  }
  stage6BishopInvalidate('Custom soil polygon removed; rerun Bishop search.');
  renderStage6();
}

function stage6BishopSetSelectedRegionMaterial(materialId){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  const region = stage6BishopSelectedCustomRegion();
  if(!region) return;
  region.materialId = materialId;
  stage6BishopSyncSoilModel();
  stage6BishopInvalidate('Custom soil polygon material updated; rerun Bishop search.');
  renderStage6();
}

function stage6BishopSetSelectedRegionCoarseness(value){
  ensureStage6State();
  stage6RememberDetailsState();
  const bishop = S.stage6.bishop;
  const region = stage6BishopSelectedCustomRegion();
  if(!region) return;
  region.coarseness = stage6BishopNormalizeRegionCoarseness(value);
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
  const bishop = S.stage6.bishop;
  const region = stage6BishopSelectedCustomRegion();
  const splitPoints = bishop.draftKind === 'regionSplit' ? (bishop.draft || []) : [];
  if(!region || splitPoints.length < 2){
    bishop.progress.message = 'Choose two boundary points on the selected polygon to split it.';
    renderStage6();
    return;
  }
  const outcome = stage6BishopSplitRegionPolygon(region, splitPoints[0], splitPoints[1]);
  if(!outcome.ok){
    bishop.draft = [];
    bishop.draftKind = 'regionSplit';
    bishop.progress.message = outcome.message;
    renderStage6();
    return;
  }
  const replacements = outcome.polygons.map((polygon)=>({
    id:stage6BishopRegionId(),
    polygon,
    materialId:region.materialId || bishop.materials?.[0]?.id || null,
    coarseness:stage6BishopNormalizeRegionCoarseness(region?.coarseness),
    source:'edited'
  }));
  bishop.customRegions = stage6BishopNormalizeCustomRegions(
    (bishop.customRegions || []).flatMap((item)=>item.id === region.id ? replacements : [item]),
    bishop.terrain,
    bishop.materials
  );
  bishop.selectedRegionId = replacements[0]?.id || bishop.selectedRegionId;
  bishop.useCustomRegions = bishop.customRegions.length > 0;
  bishop.tool = 'edit';
  bishop.draft = [];
  bishop.draftKind = '';
  stage6BishopInvalidate('Custom soil polygon split into two polygons; rerun Bishop search.');
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
  const wall = S.stage6.bishop.walls?.[index];
  if(!wall) return;
  if(field === 'passiveSide'){
    wall.passiveSide = value === 'left' ? 'left' : 'right';
  } else if(field === 'maxShearForce'){
    wall.maxShearForce = value === '' || value == null ? null : Math.max(+value || 0, 0);
  } else if(field === 'mechanicalActive'){
    wall.mechanicalActive = value === true || value === 'true' || value === 1 || value === '1';
    wall.mechanicalActivationPromptPending = false;
  } else if(field === 'head.x' || field === 'head.y' || field === 'tip.x' || field === 'tip.y'){
    const [endKey, coordKey] = field.split('.');
    if(!wall[endKey] || typeof wall[endKey] !== 'object') wall[endKey] = {};
    wall[endKey][coordKey] = value === '' || value == null ? null : +value;
  } else if(field === 'x'){
    const nextX = value === '' || value == null ? null : +value;
    const axis = wallAxis(wall);
    if(Number.isFinite(nextX)){
      const dx = axis ? axis.tip.x - axis.head.x : 0;
      wall.head = {...(wall.head || {x:wall.x, y:wall.yTop}), x:nextX};
      wall.tip = {...(wall.tip || {x:wall.x, y:wall.yTip}), x:nextX + dx};
    }
  } else if(field === 'yTop'){
    wall.head = {...(wall.head || {x:wall.x, y:wall.yTop}), y:value === '' || value == null ? null : +value};
  } else if(field === 'yTip'){
    wall.tip = {...(wall.tip || {x:wall.x, y:wall.yTip}), y:value === '' || value == null ? null : +value};
  } else {
    wall[field] = value === '' || value == null ? null : +value;
  }
  S.stage6.bishop.walls = stage6BishopNormalizeWalls(S.stage6.bishop.walls, S.stage6.bishop.terrain);
  if(field === 'mechanicalActive'){
    stage6BishopInvalidateDeformation('Wall mechanical activation changed; rerun deformation analysis.');
  } else if(field === 'x' || field === 'yTop' || field === 'yTip' || field.startsWith('head.') || field.startsWith('tip.')) {
    stage6BishopInvalidateWallGeometry('Retaining wall geometry updated; rerun Bishop search.');
  } else {
    stage6BishopInvalidate('Retaining wall geometry updated; rerun Bishop search.');
  }
  renderStage6();
}

function stage6BishopSetWallMaterialField(index, field, value){
  ensureStage6State();
  stage6BishopSyncSoilModel();
  const wall = S.stage6.bishop.walls?.[index];
  if(!wall) return;
  wall.material = normalizeWallMaterial(wall.material, index, wall.id, {sourceFallback:'user'});
  if(field === 'preset'){
    wall.material = stage6BishopWallMaterialPreset(value, index, wall.id);
  } else if(field === 'mechanical.model'){
    const nextModel = value === 'section-properties' ? 'section-properties' : 'rectangular';
    if(nextModel === 'section-properties'){
      wall.material.mechanical = {
        model:'section-properties',
        EA:resolveWallMechanicalSection(wall.material.mechanical).EA,
        EI:resolveWallMechanicalSection(wall.material.mechanical).EI,
        GA:resolveWallMechanicalSection(wall.material.mechanical).GA,
        kappa:1,
        source:'user'
      };
    } else {
      wall.material.mechanical = defaultWallMechanicalMaterial('user');
    }
  } else if(field.startsWith('mechanical.')){
    const key = field.slice('mechanical.'.length);
    const mechanical = {...(wall.material.mechanical || defaultWallMechanicalMaterial('user'))};
    const nextValue = value === '' || value == null ? null : +value;
    if(key === 'E' || key === 'thickness' || key === 'EA' || key === 'EI' || key === 'GA' || key === 'kappa'){
      if(!(nextValue > 0)) return;
      mechanical[key] = nextValue;
    } else if(key === 'nu'){
      if(!(Number.isFinite(nextValue) && nextValue >= 0 && nextValue < 0.5)) return;
      mechanical.nu = nextValue;
    }
    mechanical.source = 'user';
    wall.material.mechanical = mechanical;
  } else if(field === 'label'){
    wall.material.label = String(value || '').trim() || 'Wall material';
    wall.material.kSource = 'user';
  } else if(field === 'kAcross' || field === 'kAlong'){
    const nextValue = value === '' || value == null ? null : +value;
    if(!(nextValue > 0)) return;
    wall.material[field] = nextValue;
    wall.material.kSource = 'user';
  }
  S.stage6.bishop.walls = stage6BishopNormalizeWalls(S.stage6.bishop.walls, S.stage6.bishop.terrain);
  if(field === 'kAcross' || field === 'kAlong' || field === 'preset'){
    stage6BishopInvalidateSeepage('Wall conductivity changed. Showing the previous result until you rerun.', true, true);
  }
  if(field.startsWith('mechanical.') || field === 'preset'){
    stage6BishopInvalidateDeformation('Wall mechanical material changed; rerun deformation analysis.', true, true);
  }
  renderStage6();
}

function stage6BishopDeleteWall(index){
  ensureStage6State();
  stage6BishopSyncSoilModel();
  const removed = S.stage6.bishop.walls?.[index] || null;
  S.stage6.bishop.walls = (S.stage6.bishop.walls || []).filter((_, wallIndex)=>wallIndex !== index);
  if(removed?.id === S.stage6.bishop.selectedWallId){
    S.stage6.bishop.selectedWallId = null;
  }
  stage6BishopInvalidateWallGeometry('Retaining wall removed; rerun Bishop search.');
  renderStage6();
}

function stage6BishopSelectWall(wallId){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  const wall = (bishop.walls || []).find((item)=>item.id === wallId);
  bishop.selectedWallId = wall ? wall.id : null;
  if(wall){
    bishop.selectedSurfaceLoadId = null;
    bishop.selectedDrainId = '';
    bishop.selectedRegionId = null;
    const ui = stage6BishopUiState();
    ui.bishopActiveCanvasPanel = 'structures';
    ui.bishopActiveCanvasSheet = '';
    ui.bishopCanvasToolsHidden = false;
  }
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
  S.stage6.bishop.selectedDrainId = drainId || '';
  if(drainId) S.stage6.bishop.selectedWallId = null;
  renderStage6();
}

function stage6BishopSetDrainField(index, field, value){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopSyncSoilModel();
  const drain = S.stage6.bishop.drains?.[index];
  if(!drain) return;
  if(field === 'label'){
    drain.label = String(value || '').trim() || `Drain ${index + 1}`;
  } else if(field === 'head'){
    const head = value === '' || value == null ? null : +value;
    if(!Number.isFinite(head)) return;
    drain.head = {kind:'constant', value:head};
  } else if(field === 'gating'){
    drain.gating = value === 'always' || value === 'head-cap' ? value : 'when-saturated';
  }
  S.stage6.bishop.drains = stage6BishopNormalizeDrains(S.stage6.bishop.drains);
  const model = stage6BishopCurrentModel();
  S.stage6.bishop.seepage.drainValidation = validateDrains(model);
  stage6BishopInvalidateSeepage('Drain settings changed. Showing the previous result until you rerun.', true, true);
  renderStage6();
}

function stage6BishopDeleteDrain(index){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopSyncSoilModel();
  const removed = S.stage6.bishop.drains?.[index];
  S.stage6.bishop.drains = (S.stage6.bishop.drains || []).filter((_, drainIndex)=>drainIndex !== index);
  if(removed?.id === S.stage6.bishop.selectedDrainId){
    S.stage6.bishop.selectedDrainId = S.stage6.bishop.drains?.[0]?.id || '';
  }
  stage6BishopInvalidateSeepage('Drain removed. Showing the previous result until you rerun.', true, true);
  renderStage6();
}

function stage6BishopStopSeepage(silent){
  if(stage6BishopSeepageWorker){
    if(silent){
      stage6BishopSeepageWorker.terminate();
      stage6BishopSeepageWorker = null;
    } else if(S?.stage6?.bishop?.seepage?.progress?.runId){
      stage6BishopSeepageWorker.postMessage({
        type:'stop-seepage',
        runId:S.stage6.bishop.seepage.progress.runId
      });
    }
  }
  if(S?.stage6?.bishop?.seepage){
    const seepage = S.stage6.bishop.seepage;
    if(silent){
      seepage.progress.running = false;
      seepage.progress.percent = 0;
      if(seepage.status === 'meshing' || seepage.status === 'solving') seepage.status = 'idle';
    } else if(seepage.progress?.running){
      seepage.progress.message = 'Stopping seepage and keeping the latest solved state...';
      seepage.rejectReason = '';
    } else {
      seepage.progress.message = 'No seepage run is active.';
      seepage.rejectReason = '';
    }
  }
}

function stage6BishopStopDeformation(silent){
  if(stage6BishopDeformationWorker){
    if(silent){
      stage6BishopDeformationWorker.terminate();
      stage6BishopDeformationWorker = null;
    } else if(S?.stage6?.bishop?.deformation?.progress?.runId){
      stage6BishopDeformationWorker.postMessage({
        type:'stop-deformation',
        runId:S.stage6.bishop.deformation.progress.runId
      });
    }
  }
  if(S?.stage6?.bishop?.deformation){
    const deformation = S.stage6.bishop.deformation;
    if(silent){
      deformation.progress.running = false;
      deformation.progress.percent = 0;
      if(['meshing','solving','post'].includes(deformation.status)) deformation.status = 'idle';
    } else if(deformation.progress?.running){
      deformation.progress.message = 'Stopping deformation and keeping the latest solved state...';
      deformation.rejectReason = '';
    } else {
      deformation.progress.message = 'No deformation run is active.';
      deformation.rejectReason = '';
    }
  }
}

function stage6BishopStopSearch(silent){
  if(stage6BishopWorker){
    stage6BishopWorker.terminate();
    stage6BishopWorker = null;
  }
  if(S?.stage6?.bishop){
    S.stage6.bishop.progress.running = false;
    S.stage6.bishop.progress.previewCircle = null;
    if(!silent) S.stage6.bishop.progress.message = 'Bishop search stopped.';
  }
}

function stage6BishopUpdateProgressDom(){
  const bishop = S?.stage6?.bishop;
  if(!bishop) return;
  const status = document.getElementById('stage6BishopProgress');
  const bar = document.getElementById('stage6BishopProgressBar');
  if(status){
    const p = bishop.progress;
    status.textContent = p.running
      ? `${stage6BishopMethodModeLabel(bishop.methodMode)} · ${p.trial||0}/${p.total||0} Bishop trials (${(p.percent||0).toFixed(0)}%)`
      : (p.message || 'Idle');
  }
  if(bar) bar.style.width = `${Math.max(0, Math.min(100, bishop.progress.percent || 0))}%`;
}

function stage6BishopEnsureWorker(){
  if(stage6BishopWorker || typeof Worker === 'undefined') return stage6BishopWorker;
  stage6BishopWorker = new Worker(new URL('./stage6-bishop-worker.js', import.meta.url), {type:'module'});
  stage6BishopWorker.onmessage = (event)=>{
    const payload = event?.data || {};
    const bishop = S?.stage6?.bishop;
    if(!bishop || payload.runId !== bishop.progress.runId) return;
    if(payload.type === 'progress'){
      bishop.progress.running = true;
      bishop.progress.trial = payload.progress?.trial || 0;
      bishop.progress.total = payload.progress?.total || 0;
      bishop.progress.percent = payload.progress?.percent || 0;
      bishop.progress.previewCircle = payload.progress?.previewCircle || null;
      bishop.progress.message = stage6BishopRunningMessage();
      stage6BishopUpdateProgressDom();
      stage6BishopDrawCanvas();
      return;
    }
    bishop.progress.running = false;
    bishop.progress.previewCircle = null;
    if(payload.type === 'result'){
      bishop.results = payload.result || null;
      bishop.selectedResult = 0;
      bishop.stale = false;
      const timing = payload.result?.timing;
      bishop.progress.message = stage6BishopCompleteMessage(payload.result, timing);
      renderStage6();
      return;
    }
    bishop.progress.message = payload.error || 'Bishop search failed.';
    bishop.progress.previewCircle = null;
    renderStage6();
  };
  stage6BishopWorker.onerror = ()=>{
    if(S?.stage6?.bishop){
      S.stage6.bishop.progress.running = false;
      S.stage6.bishop.progress.previewCircle = null;
      S.stage6.bishop.progress.message = 'Bishop worker error.';
      renderStage6();
    }
    if(stage6BishopWorker){
      stage6BishopWorker.terminate();
      stage6BishopWorker = null;
    }
  };
  return stage6BishopWorker;
}

function stage6BishopEnsureSeepageWorker(){
  if(stage6BishopSeepageWorker || typeof Worker === 'undefined') return stage6BishopSeepageWorker;
  stage6BishopSeepageWorker = new Worker(new URL('./seepage/seepage-worker.js', import.meta.url), {type:'module'});
  stage6BishopSeepageWorker.onmessage = (event)=>{
    const payload = event?.data || {};
    const seepage = S?.stage6?.bishop?.seepage;
    if(!seepage || payload.runId !== seepage.progress?.runId) return;
    if(payload.type === 'progress'){
      seepage.progress.running = true;
      seepage.progress.percent = payload.progress?.percent || 0;
      seepage.progress.message = payload.progress?.message || 'Running seepage...';
      if(payload.progress?.stage === 'meshing') seepage.status = 'meshing';
      else if(payload.progress?.stage === 'solving' || payload.progress?.stage === 'post') seepage.status = 'solving';
      renderStage6();
      return;
    }
    seepage.progress.running = false;
    seepage.progress.percent = 100;
    if(payload.type === 'result'){
      seepage.mesh = payload.output?.mesh || null;
      seepage.result = payload.output?.result || null;
      seepage.stale = false;
      seepage.status = seepage.mesh && seepage.result ? 'success' : 'failed';
      seepage.rejectReason = seepage.status === 'success'
        ? ''
        : 'The seepage solver returned no result.';
      if(
        seepage.status === 'success' &&
        !seepage.display?.showContours &&
        !seepage.display?.showContourLines &&
        !seepage.display?.showFlowVectors &&
        !seepage.display?.showExitGradient
      ){
        seepage.display.showContours = true;
        seepage.display.showContourLines = true;
        seepage.display.showContourLegend = true;
        seepage.display.contourMode = 'head';
      }
      seepage.progress.message = seepage.status === 'success'
        ? stage6BishopSeepageCompleteMessage(seepage.result)
        : 'Seepage solve failed.';
      renderStage6();
      return;
    }
    if(payload.error === 'Seepage run was interrupted before a solution became available.'){
      seepage.status = 'idle';
      seepage.rejectReason = '';
      seepage.progress.message = 'Seepage interrupted before the first solution became available.';
      seepage.progress.percent = 0;
      renderStage6();
      return;
    }
    seepage.status = 'failed';
    seepage.rejectReason = payload.error || 'Seepage solve failed.';
    seepage.progress.message = seepage.rejectReason;
    seepage.progress.percent = 0;
    renderStage6();
  };
  stage6BishopSeepageWorker.onerror = ()=>{
    if(S?.stage6?.bishop?.seepage){
      const seepage = S.stage6.bishop.seepage;
      seepage.progress.running = false;
      seepage.progress.percent = 0;
      seepage.status = 'failed';
      seepage.rejectReason = 'Seepage worker error.';
      seepage.progress.message = 'Seepage worker error.';
      renderStage6();
    }
    if(stage6BishopSeepageWorker){
      stage6BishopSeepageWorker.terminate();
      stage6BishopSeepageWorker = null;
    }
  };
  return stage6BishopSeepageWorker;
}

function stage6BishopEnsureDeformationWorker(){
  if(stage6BishopDeformationWorker || typeof Worker === 'undefined') return stage6BishopDeformationWorker;
  stage6BishopDeformationWorker = new Worker(new URL('./deformation/deformation-worker.js', import.meta.url), {type:'module'});
  stage6BishopDeformationWorker.onmessage = (event)=>{
    const payload = event?.data || {};
    const deformation = S?.stage6?.bishop?.deformation;
    if(!deformation || payload.runId !== deformation.progress?.runId) return;
    if(payload.type === 'progress'){
      deformation.progress.running = true;
      deformation.progress.percent = payload.progress?.percent || 0;
      deformation.progress.message = payload.progress?.message || 'Running deformation...';
      if(payload.progress?.stage === 'meshing') deformation.status = 'meshing';
      else if(payload.progress?.stage === 'solving') deformation.status = 'solving';
      else if(payload.progress?.stage === 'post') deformation.status = 'post';
      renderStage6();
      return;
    }
    deformation.progress.running = false;
    deformation.progress.percent = 100;
    if(payload.type === 'result'){
      deformation.mesh = payload.output?.mesh || null;
      deformation.result = payload.output || null;
      deformation.stale = false;
      deformation.warnings = Array.isArray(payload.output?.warnings) ? payload.output.warnings : [];
      deformation.status = deformation.mesh && deformation.result ? 'success' : 'failed';
      deformation.rejectReason = deformation.status === 'success'
        ? ''
        : 'The deformation solver returned no result.';
      const solver = payload.output?.solver || {};
      const analysisType = solver?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
      const convergenceState = solver?.convergenceState || 'converged';
      const shownLoadFactor = 100 * Math.max(Number(solver?.displayedLoadFactor) || 0, 0);
      const stableLoadFactor = 100 * Math.max(Number(solver?.loadFactorCommitted) || 0, 0);
      const shownGravityFactor = 100 * Math.max(Number(solver?.initialPhaseDisplayedGravityFactor) || 0, 0);
      const initialPhaseDisplayedContinuationMode = String(solver?.initialPhaseDisplayedContinuationMode || 'gravity');
      const initialPhaseTargetLabel = initialPhaseDisplayedContinuationMode === 'predictor-to-full-gravity correction'
        ? `${shownGravityFactor.toFixed(1)}% of the predictor-to-full-gravity correction`
        : `${shownGravityFactor.toFixed(1)}% gravity`;
      const initialPhaseStarted = solver?.initialPhaseStarted === true;
      const servicePhaseStarted = solver?.servicePhaseStarted === true;
      const shownPhasePeakTensionCutoff = initialPhaseStarted && !servicePhaseStarted
        ? Math.max(Math.round(Number(solver?.initialPhasePeakTensionCutoffActiveElements ?? solver?.initialPhasePeakTensionPendingElements) || 0), 0)
        : Math.max(Math.round(Number(solver?.peakTensionCutoffActiveElements ?? solver?.peakTensionPendingElements) || 0), 0);
      const maxMcEtaLabel = shownPhasePeakTensionCutoff > 0
        ? 'n/a (tension cut-off active)'
        : payload.output?.summaries?.hasInfiniteMcEta
          ? '∞'
        : (Number(payload.output?.summaries?.maxMcEta) || 0).toFixed(2);
      const maxSettlementLabel = ((payload.output?.summaries?.maxSettlement || 0) * 1000).toFixed(1);
      const maxSafetyPlasticLabel = `${(100 * (payload.output?.summaries?.maxSafetyEquivalentPlasticIncrement || 0)).toFixed(3)} %`;
      const inadmissibleInitialCount = Math.max(Math.round(Number(payload.output?.summaries?.inadmissibleInitialElementCount) || 0), 0);
      const inadmissibleInitialSuffix = inadmissibleInitialCount > 0
        ? ` Initial exact MC audit flagged ${inadmissibleInitialCount} inadmissible predictor element${inadmissibleInitialCount === 1 ? '' : 's'}.`
        : '';
      const safetyFinalization = solver?.safetyResult?.finalization || null;
      const safetyFinalizationStatus = stage6SafetyFinalizationStatusFromSolver(solver);
      const safetyOpenEnded = safetyFinalization?.factorOfSafetyIsOpenEnded === true
        || safetyFinalizationStatus === 'no-failure-found';
      const safetyPhysicalFailure = safetyFinalizationStatus === 'bracketed-failure'
        || safetyFinalizationStatus === 'mechanism-developed';
      const safetyPhysicalLead = safetyFinalizationStatus === 'mechanism-developed'
        ? `C-phi reduction developed a coherent mechanism at ΣMsf ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}.`
        : `C-phi reduction bracketed failure between ΣMsf ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)} and ${Number(solver?.safetyFactorOfSafetyUpper || solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}.`;
      deformation.progress.message = deformation.status === 'success'
        ? (
            analysisType === 'safety-cphi'
              ? (
                  safetyPhysicalFailure
                    ? `${safetyPhysicalLead} Conservative FoS ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}. Showing the near-failure mechanism at ΣMsf ${Number(solver?.safetyDisplayedSigmaMsf || solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}. Max additional settlement ${maxSettlementLabel} mm; max safety Δε̄ᵖ ${maxSafetyPlasticLabel}.${inadmissibleInitialSuffix}`
                    : safetyOpenEnded
                      ? `C-phi reduction remained stable up to ΣMsf ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}. Report FoS > ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)}. Max additional settlement ${maxSettlementLabel} mm; max safety Δε̄ᵖ ${maxSafetyPlasticLabel}.${inadmissibleInitialSuffix}`
                      : `C-phi reduction stopped at ΣMsf ${Number(solver?.safetyFactorOfSafetyLower || 1).toFixed(3)} with status ${safetyFinalizationStatus.replaceAll('-', ' ')}. Treat the FoS as a lower-bound numerical result, not confirmed soil body failure. Max additional settlement ${maxSettlementLabel} mm; max safety Δε̄ᵖ ${maxSafetyPlasticLabel}.${inadmissibleInitialSuffix}`
                )
              : convergenceState === 'partial'
              ? (
                  initialPhaseStarted && !servicePhaseStarted
                    ? `Showing a non-converged initial self-weight equilibration state at ${initialPhaseTargetLabel}. Service loading was not started. Max settlement ${maxSettlementLabel} mm; max MC eta ${maxMcEtaLabel}.${inadmissibleInitialSuffix}`
                    : `Showing a non-converged near-failure deformation state at ${shownLoadFactor.toFixed(1)}% load${shownLoadFactor > stableLoadFactor + 1e-6 ? ` (last fully converged state ${stableLoadFactor.toFixed(1)}%)` : ''}. Max settlement ${maxSettlementLabel} mm; max MC eta ${maxMcEtaLabel}.${inadmissibleInitialSuffix}`
                )
              : `Deformation screen ready. Max settlement ${maxSettlementLabel} mm; max MC eta ${maxMcEtaLabel}.${inadmissibleInitialSuffix}`
          )
        : 'Deformation solve failed.';
      renderStage6();
      return;
    }
    if(
      payload.error === 'Deformation run was interrupted before the first displacement solution became available.' ||
      payload.error === 'Deformation run was interrupted before geostatic initialization became available.'
    ){
      deformation.status = 'idle';
      deformation.rejectReason = '';
      deformation.progress.message = payload.error === 'Deformation run was interrupted before geostatic initialization became available.'
        ? 'Deformation interrupted before the geostatic initialization solution became available.'
        : 'Deformation interrupted before the first displacement solution became available.';
      deformation.progress.percent = 0;
      renderStage6();
      return;
    }
    deformation.status = 'failed';
    deformation.rejectReason = payload.error || 'Deformation solve failed.';
    deformation.progress.message = deformation.rejectReason;
    deformation.progress.percent = 0;
    renderStage6();
  };
  stage6BishopDeformationWorker.onerror = ()=>{
    if(S?.stage6?.bishop?.deformation){
      const deformation = S.stage6.bishop.deformation;
      deformation.progress.running = false;
      deformation.progress.percent = 0;
      deformation.status = 'failed';
      deformation.rejectReason = 'Deformation worker error.';
      deformation.progress.message = 'Deformation worker error.';
      renderStage6();
    }
    if(stage6BishopDeformationWorker){
      stage6BishopDeformationWorker.terminate();
      stage6BishopDeformationWorker = null;
    }
  };
  return stage6BishopDeformationWorker;
}

function stage6BishopRunSearch(){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopCommitPendingSelectedRegionCoarseness();
  const bishop = S.stage6.bishop;
  const model = stage6BishopCurrentModel();
  if(!model){
    bishop.progress.message = 'Draw terrain and place the active CPT marker first.';
    renderStage6();
    return;
  }
  if(!bishop.entryZone || !bishop.exitZone){
    bishop.progress.message = 'Define entry and exit zones on the terrain before running the search.';
    renderStage6();
    return;
  }
  const entryZone = stage6BishopSortZone(bishop.entryZone);
  const exitZone = stage6BishopSortZone(bishop.exitZone);
  const span = Math.abs((exitZone?.xEnd || 0) - (entryZone?.xStart || 0));
  const input = {
    model,
    entryZone,
    exitZone,
    methodMode:bishop.methodMode,
    searchConfig:{
      ...bishop.search,
      minSliceWidth:Math.max(+bishop.search.minSliceWidth || 0.05, span/300 || 0.05, 0.05)
    },
    solverConfig:{...bishop.solver},
    spencerConfig:{...bishop.spencer}
  };
  stage6BishopStopSeepage(true);
  stage6BishopStopSearch(true);
  const worker = stage6BishopEnsureWorker();
  if(!worker){
    bishop.progress.message = 'Web Worker is not available in this browser context.';
    renderStage6();
    return;
  }
  stage6BishopRunId += 1;
  bishop.progress = {
    running:true,
    percent:0,
    trial:0,
    total:0,
    runId:stage6BishopRunId,
    message:stage6BishopRunningMessage(),
    previewCircle:null
  };
  bishop.results = null;
  bishop.selectedResult = 0;
  bishop.stale = true;
  renderStage6();
  worker.postMessage({
    type:'analyze',
    runId:stage6BishopRunId,
    input
  });
}

function stage6BishopRunSeepage(){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopCommitPendingSelectedRegionCoarseness();
  const bishop = S.stage6.bishop;
  stage6BishopSyncSoilModel();
  const model = stage6BishopCurrentModel();
  if(!model){
    bishop.seepage.rejectReason = 'Draw terrain and place the active CPT marker first.';
    bishop.seepage.status = 'failed';
    renderStage6();
    return;
  }
  const activeBcs = (bishop.seepage.bcs || []).filter((bc)=>bc.status !== 'orphaned');
  const headCount = activeBcs.filter((bc)=>bc.type === 'head').length;
  if(!headCount){
    bishop.seepage.rejectReason = 'Assign at least one prescribed-head boundary edge before running seepage.';
    bishop.seepage.status = 'failed';
    renderStage6();
    return;
  }
  if(bishop.seepage.options?.freeSurface === 'fixed' && (!bishop.phreatic || bishop.phreatic.length < 2)){
    bishop.seepage.rejectReason = 'Draw a phreatic line or switch seepage to iterative free-surface mode.';
    bishop.seepage.status = 'failed';
    renderStage6();
    return;
  }
  const drainValidation = validateDrains(model);
  bishop.seepage.drainValidation = drainValidation;
  if(drainValidation.errors.length){
    bishop.seepage.rejectReason = drainValidation.errors[0].message;
    bishop.seepage.status = 'failed';
    renderStage6();
    return;
  }
  stage6BishopStopSearch(true);
  stage6BishopStopSeepage(true);
  const worker = stage6BishopEnsureSeepageWorker();
  if(!worker){
    bishop.seepage.rejectReason = 'Web Worker is not available in this browser context.';
    bishop.seepage.status = 'failed';
    renderStage6();
    return;
  }
  stage6BishopSeepageRunId += 1;
  bishop.seepage.status = 'meshing';
  bishop.seepage.rejectReason = '';
  bishop.seepage.progress = {
    running:true,
    percent:0,
    message:'Building triangulated seepage mesh...',
    runId:stage6BishopSeepageRunId
  };
  const seepageInputModel = {
    ...model,
    seepage:{
      ...(model.seepage || {}),
      mesh:null,
      result:null
    }
  };
  renderStage6();
  worker.postMessage({
    type:'run-seepage',
    runId:stage6BishopSeepageRunId,
    input:{model:seepageInputModel}
  });
}

function stage6BishopRunDeformation(){
  ensureStage6State();
  stage6RememberDetailsState();
  stage6BishopCommitPendingSelectedRegionCoarseness();
  const bishop = S.stage6.bishop;
  stage6BishopSyncSoilModel();
  const model = stage6BishopCurrentModel();
  if(!model){
    bishop.deformation.rejectReason = 'Draw terrain and place the active CPT marker first.';
    bishop.deformation.status = 'failed';
    renderStage6();
    return;
  }
  const analysisType = bishop.deformation?.options?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
  const loadMode = bishop.deformation?.options?.loadMode === 'total' ? 'total' : 'pressure';
  const activeLoads = stage6BishopActiveSurfaceLoads('deformation');
  if(analysisType === 'deformation'){
    if(!activeLoads.length){
      bishop.deformation.rejectReason = 'Draw or enable at least one positive surface load before running deformation.';
      bishop.deformation.status = 'failed';
      renderStage6();
      return;
    }
  }
  stage6BishopStopSearch(true);
  stage6BishopStopSeepage(true);
  stage6BishopStopDeformation(true);
  const worker = stage6BishopEnsureDeformationWorker();
  if(!worker){
    bishop.deformation.rejectReason = 'Web Worker is not available in this browser context.';
    bishop.deformation.status = 'failed';
    renderStage6();
    return;
  }
  stage6BishopDeformationRunId += 1;
  bishop.deformation.status = 'meshing';
  bishop.deformation.rejectReason = '';
  bishop.deformation.warnings = [];
  bishop.deformation.lastWallInputs = (model.walls || []).map((wall)=>({
    id:wall.id,
    head:wall.head ? {...wall.head} : null,
    tip:wall.tip ? {...wall.tip} : null,
    x:wall.x,
    yTop:wall.yTop,
    yTip:wall.yTip,
    passiveSide:wall.passiveSide,
    mechanicalActive:wall.mechanicalActive === true
  }));
  bishop.deformation.progress = {
    running:true,
    percent:0,
    message:'Building triangulated deformation mesh...',
    runId:stage6BishopDeformationRunId
  };
  renderStage6();
  worker.postMessage({
    type:'run-deformation',
    runId:stage6BishopDeformationRunId,
    input:{
      model,
      options:{
        analysisType,
        meshTargetArea:stage6BishopResolvedDeformationMeshTargetArea(bishop),
        meshElementType:String(bishop.deformation?.options?.meshElementType || '').toLowerCase() === 't6' ? 't6' : 't3',
        constitutiveModel:bishop.deformation?.options?.constitutiveModel,
        initialStressMode:'plastic-geostatic',
        loadMode,
        totalLoad:bishop.deformation?.options?.totalLoad,
        outOfPlaneLength:bishop.deformation?.options?.outOfPlaneLength,
        useSeepagePorePressures:bishop.deformation?.options?.useSeepagePorePressures === true,
        nonlinearMaxIterations:bishop.deformation?.options?.nonlinearMaxIterations,
        initialLoadStep:bishop.deformation?.options?.initialLoadStep,
        minLoadStep:bishop.deformation?.options?.minLoadStep,
        maxLoadSteps:bishop.deformation?.options?.maxLoadSteps,
        residualRelTol:bishop.deformation?.options?.residualRelTol,
        residualAbsTol:bishop.deformation?.options?.residualAbsTol,
        displacementRelTol:bishop.deformation?.options?.displacementRelTol,
        displacementAbsTol:bishop.deformation?.options?.displacementAbsTol,
        loadStepGrowthFactor:bishop.deformation?.options?.loadStepGrowthFactor,
        loadStepCutbackFactor:bishop.deformation?.options?.loadStepCutbackFactor,
        plasticLoadStepGrowthFactor:bishop.deformation?.options?.plasticLoadStepGrowthFactor,
        plasticLoadStepCutbackFactor:bishop.deformation?.options?.plasticLoadStepCutbackFactor,
        geostaticInitializationMethod:bishop.deformation?.options?.geostaticInitializationMethod,
        geostaticStressOnlyResidualTolerance:bishop.deformation?.options?.geostaticStressOnlyResidualTolerance,
        useStagedGeostaticInit:true,
        allowStressOnlyGeostaticReference:bishop.deformation?.options?.allowStressOnlyGeostaticReference === true,
        stressOnlyGeostaticMaxEta:bishop.deformation?.options?.stressOnlyGeostaticMaxEta,
        geostaticCorrectionStages:bishop.deformation?.options?.geostaticCorrectionStages,
        initialGravityTangentSchedule:bishop.deformation?.options?.initialGravityTangentSchedule,
        initialGravityElasticGlobalizationIterations:bishop.deformation?.options?.initialGravityElasticGlobalizationIterations,
        elasticGlobalizationArmijoC1:bishop.deformation?.options?.elasticGlobalizationArmijoC1,
        elasticGlobalizationMinResidualRatio:bishop.deformation?.options?.elasticGlobalizationMinResidualRatio,
        geostaticMinLoadStep:bishop.deformation?.options?.geostaticMinLoadStep,
        geostaticMaxRepeatedBand:bishop.deformation?.options?.geostaticMaxRepeatedBand,
        geostaticProgressFailFast:bishop.deformation?.options?.geostaticProgressFailFast === true,
        geostaticProgressFailFastSteps:bishop.deformation?.options?.geostaticProgressFailFastSteps,
        geostaticProgressFailFastLoadFactor:bishop.deformation?.options?.geostaticProgressFailFastLoadFactor,
        geostaticProgressFailFastPlasticFraction:bishop.deformation?.options?.geostaticProgressFailFastPlasticFraction,
        serviceProgressFailFast:bishop.deformation?.options?.serviceProgressFailFast === true,
        serviceProgressFailFastSteps:bishop.deformation?.options?.serviceProgressFailFastSteps,
        serviceProgressFailFastLoadFactor:bishop.deformation?.options?.serviceProgressFailFastLoadFactor,
        serviceProgressFailFastPlasticFraction:bishop.deformation?.options?.serviceProgressFailFastPlasticFraction,
        safetyInitialSigmaMsfIncrement:bishop.deformation?.options?.safetyInitialSigmaMsfIncrement,
        safetySigmaMsfGrowthFactor:bishop.deformation?.options?.safetySigmaMsfGrowthFactor,
        safetySigmaMsfMax:bishop.deformation?.options?.safetySigmaMsfMax,
        safetySigmaMsfBracketTolerance:bishop.deformation?.options?.safetySigmaMsfBracketTolerance,
        safetyMaxSearchTrials:bishop.deformation?.options?.safetyMaxSearchTrials,
        safetyFinalizationMode:bishop.deformation?.options?.safetyFinalizationMode === 'production-msf' ? 'production-msf' : 'legacy-bracket',
        useUnsymmetricPlasticSolver:bishop.deformation?.options?.useUnsymmetricPlasticSolver === true,
        solverBackend:bishop.deformation?.options?.solverBackend === 'js-cpu' ? 'js-cpu' : 'wasm-cpu',
        useNewGpuPipeline:false,
        gpuPipelineVersion:'v1',
        useWasmCpuPipeline:bishop.deformation?.options?.solverBackend !== 'js-cpu',
        wasmRobustNonlinearMode:false
      }
    }
  });
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

function stage6BishopStrengthSetLabel(key){
  if(key === 'da1_1') return 'DA1/1 (M1 soil set)';
  if(key === 'da1_2') return 'DA1/2 (M2 soil set)';
  return 'Characteristic';
}

function stage6BishopMethodModeLabel(mode){
  return mode === 'bishop_spencer' ? 'Bishop + Spencer check' : 'Bishop only';
}

function stage6SecondsLabelFromMs(value){
  const ms = Number(value);
  if(!Number.isFinite(ms)) return '—';
  return `${stage6CompactNumber(ms / 1000, 3)} s`;
}

function stage6SafetyFinalizationStatusFromSolver(solver){
  const finalStatus = solver?.safetyResult?.finalization?.status;
  if(finalStatus) return finalStatus;
  const legacyStatus = solver?.safetyStatus;
  if(legacyStatus === 'bracketed') return 'bracketed-failure';
  return legacyStatus || 'not-applicable';
}

function stage6DepthBandReportHtml(report, title = 'Depth-band plasticity'){
  const bands = Array.isArray(report?.depthBands) ? report.depthBands.filter((band)=>Number(band?.count) > 0) : [];
  if(!bands.length) return '';
  const maxCount = Math.max(1, ...bands.map((band)=>Math.max(Number(band.plastic) || 0, Number(band.tension) || 0)));
  return `
    <div class="info st6-depth-band-report" style="background:var(--bg2);border-color:var(--bd2)">
      <strong>${stage6EscAttr(title)}</strong>
      ${bands.map((band)=>{
        const plastic = Number(band.plastic) || 0;
        const tension = Number(band.tension) || 0;
        const plasticWidth = Math.min(100, 100 * plastic / maxCount);
        const tensionWidth = Math.min(100, 100 * tension / maxCount);
        const tau95 = Number(band.tauOverStrength?.p95);
        return `
          <div class="st6-depth-band-row">
            <span>${stage6EscAttr(band.label)}</span>
            <div class="st6-depth-band-bars">
              <i style="width:${plasticWidth.toFixed(1)}%"></i>
              <b style="width:${tensionWidth.toFixed(1)}%"></b>
            </div>
            <em>${plastic}/${band.count} MC${tension ? `, ${tension} T` : ''}${Number.isFinite(tau95) ? `, τ/S p95 ${tau95.toFixed(2)}` : ''}</em>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function stage6BishopSafetyCurveHtml(solver){
  if(!solver || solver.analysisType !== 'safety-cphi') return '';
  const rawCurve = Array.isArray(solver.safetyCurve) ? solver.safetyCurve : [];
  const rawTargets = Array.isArray(solver.safetyTrialTargets) && solver.safetyTrialTargets.length
    ? solver.safetyTrialTargets
    : (Array.isArray(solver.safetyTrialHistory) ? solver.safetyTrialHistory : []);
  const curve = rawCurve
    .map((point, index)=>({
      index:Number.isFinite(Number(point?.index)) ? Number(point.index) : index,
      trialIndex:Number.isFinite(Number(point?.trialIndex)) ? Number(point.trialIndex) : null,
      sigmaMsf:Number(point?.sigmaMsf),
      uMm:1000 * Math.abs(Number(point?.uMaxAbs) || 0),
      nonlinearIterations:Number(point?.nonlinearIterations) || 0,
      linearIterations:Number(point?.linearIterations) || 0,
      activeCount:Number(point?.activeCount) || 0,
      maxDeltaPlasticStrain:Number(point?.maxDeltaPlasticStrain) || 0
    }))
    .filter((point)=>Number.isFinite(point.sigmaMsf) && Number.isFinite(point.uMm));
  if(!curve.length && rawTargets.length){
    rawTargets.forEach((trial, index)=>{
      if(trial?.converged !== true) return;
      const sigmaMsf = Number(trial?.sigmaMsfCommitted ?? trial?.committed ?? trial?.sigmaMsfTarget ?? trial?.target);
      const uMm = 1000 * Math.abs(Number(trial?.incrementalDisplacementMaxAbs) || 0);
      if(Number.isFinite(sigmaMsf) && Number.isFinite(uMm)){
        curve.push({
          index,
          trialIndex:Number.isFinite(Number(trial?.index)) ? Number(trial.index) : index,
          sigmaMsf,
          uMm,
          nonlinearIterations:Number(trial?.iterations) || 0,
          linearIterations:0,
          activeCount:0,
          maxDeltaPlasticStrain:Number(trial?.maxAccumulatedPlasticIncrement) || 0
        });
      }
    });
  }
  if(!curve.length) return '';

  const lower = Number(solver.safetyFactorOfSafetyLower);
  const upperRaw = Number(solver.safetyFactorOfSafetyUpper);
  const upper = Number.isFinite(upperRaw) && upperRaw > 0 ? upperRaw : null;
  const displayed = Number(solver.safetyDisplayedSigmaMsf);
  const failedTargets = rawTargets
    .map((trial, index)=>({
      index:Number.isFinite(Number(trial?.index)) ? Number(trial.index) : index,
      trialIndex:Number.isFinite(Number(trial?.index)) ? Number(trial.index) : index,
      target:Number(trial?.sigmaMsfTarget ?? trial?.target),
      committed:Number(trial?.sigmaMsfCommitted ?? trial?.committed),
      converged:trial?.converged === true,
      displayed:trial?.displayed === true,
      uMm:1000 * Math.abs(Number(trial?.incrementalDisplacementMaxAbs) || 0)
    }))
    .filter((trial)=>trial.converged === false && Number.isFinite(trial.target));
  const findCurveForSigma = (sigmaMsf)=>{
    if(!Number.isFinite(sigmaMsf)) return curve[curve.length - 1];
    let best = curve[0];
    let bestDiff = Math.abs(best.sigmaMsf - sigmaMsf);
    for(const point of curve){
      const diff = Math.abs(point.sigmaMsf - sigmaMsf);
      if(diff < bestDiff){
        best = point;
        bestDiff = diff;
      }
    }
    return best;
  };
  const targetMarkerPoint = (target)=>{
    const sameTrial = curve.filter((point)=>point.trialIndex === target.trialIndex);
    if(sameTrial.length) return sameTrial[sameTrial.length - 1];
    if(Number.isFinite(target.committed)) return findCurveForSigma(target.committed);
    return curve[curve.length - 1];
  };

  const allX = curve.map((point)=>point.uMm);
  const allY = curve.map((point)=>point.sigmaMsf);
  failedTargets.forEach((target)=>{
    allY.push(target.target);
    if(target.uMm > 0) allX.push(target.uMm);
    else allX.push(targetMarkerPoint(target)?.uMm || 0);
  });
  if(Number.isFinite(lower)) allY.push(lower);
  if(Number.isFinite(upper)) allY.push(upper);
  if(Number.isFinite(displayed)) allY.push(displayed);

  const width = 520;
  const height = 220;
  const ml = 48;
  const mr = 18;
  const mt = 18;
  const mb = 38;
  const pw = width - ml - mr;
  const ph = height - mt - mb;
  const xMaxRaw = Math.max(...allX, 0);
  const xMax = xMaxRaw > 1e-9 ? xMaxRaw * 1.08 : 1;
  const yMinRaw = Math.min(...allY, 1);
  const yMaxRaw = Math.max(...allY, 1.01);
  const yPad = Math.max((yMaxRaw - yMinRaw) * 0.08, 0.01);
  const yMin = Math.max(1, yMinRaw - yPad);
  const yMax = Math.max(yMin + 0.01, yMaxRaw + yPad);
  const px = (uMm)=>ml + Math.min(Math.max(uMm / xMax, 0), 1) * pw;
  const py = (sigmaMsf)=>mt + (1 - Math.min(Math.max((sigmaMsf - yMin) / (yMax - yMin), 0), 1)) * ph;
  const path = curve.map((point, index)=>`${index === 0 ? 'M' : 'L'} ${px(point.uMm).toFixed(1)} ${py(point.sigmaMsf).toFixed(1)}`).join(' ');
  const xTicks = [0, xMax / 2, xMax];
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  const finalPoint = findCurveForSigma(Number.isFinite(lower) ? lower : curve[curve.length - 1].sigmaMsf);
  const displayedPoint = Number.isFinite(displayed) ? findCurveForSigma(displayed) : null;
  const bracketBand = Number.isFinite(lower) && Number.isFinite(upper) && upper > lower
    ? `<rect x="${ml}" y="${py(upper).toFixed(1)}" width="${pw}" height="${Math.max(1, py(lower) - py(upper)).toFixed(1)}" fill="var(--acl)" opacity="0.45"></rect>`
    : '';
  const failedMarkers = failedTargets.map((target)=>{
    const anchor = targetMarkerPoint(target);
    const x = target.uMm > 0 ? target.uMm : (anchor?.uMm || 0);
    return `<g>
      <line x1="${px(x).toFixed(1)}" x2="${px(x).toFixed(1)}" y1="${py(target.target).toFixed(1)}" y2="${py(anchor?.sigmaMsf || target.target).toFixed(1)}" stroke="var(--bad)" stroke-width="1" stroke-dasharray="3 3" opacity="0.75"></line>
      <path d="M ${px(x).toFixed(1)} ${(py(target.target) - 5).toFixed(1)} l 5 10 h -10 z" fill="var(--bad)">
        <title>Failed target ${target.index + 1}: SigmaMsf ${stage6EscAttr(target.target.toFixed(3))}</title>
      </path>
    </g>`;
  }).join('');
  const acceptedMarkers = curve.map((point)=>`
    <circle cx="${px(point.uMm).toFixed(1)}" cy="${py(point.sigmaMsf).toFixed(1)}" r="2.6" fill="var(--ac)">
      <title>Step ${point.index + 1}: SigmaMsf ${stage6EscAttr(point.sigmaMsf.toFixed(3))}, u ${stage6EscAttr(point.uMm.toFixed(2))} mm, active ${point.activeCount}</title>
    </circle>
  `).join('');
  const finalMarker = finalPoint ? `
    <circle cx="${px(finalPoint.uMm).toFixed(1)}" cy="${py(Number.isFinite(lower) ? lower : finalPoint.sigmaMsf).toFixed(1)}" r="5" fill="none" stroke="var(--tx)" stroke-width="1.8">
      <title>Reported lower-bound FoS ${Number.isFinite(lower) ? stage6EscAttr(lower.toFixed(3)) : '—'}</title>
    </circle>
  ` : '';
  const displayedMarker = displayedPoint && Math.abs((Number.isFinite(lower) ? lower : displayedPoint.sigmaMsf) - displayed) > 1e-8 ? `
    <circle cx="${px(displayedPoint.uMm).toFixed(1)}" cy="${py(displayed).toFixed(1)}" r="4" fill="var(--chart-orange, #8A620D)" opacity="0.9">
      <title>Displayed SigmaMsf ${stage6EscAttr(displayed.toFixed(3))}</title>
    </circle>
  ` : '';
  const axis = `
    ${xTicks.map((tick)=>`<g><line x1="${px(tick).toFixed(1)}" x2="${px(tick).toFixed(1)}" y1="${mt}" y2="${mt + ph}" stroke="var(--bd)" stroke-width="1"></line><text x="${px(tick).toFixed(1)}" y="${height - 12}" text-anchor="middle">${stage6EscAttr(tick.toFixed(tick >= 10 ? 0 : 1))}</text></g>`).join('')}
    ${yTicks.map((tick)=>`<g><line x1="${ml}" x2="${ml + pw}" y1="${py(tick).toFixed(1)}" y2="${py(tick).toFixed(1)}" stroke="var(--bd)" stroke-width="1"></line><text x="${ml - 8}" y="${(py(tick) + 3).toFixed(1)}" text-anchor="end">${stage6EscAttr(tick.toFixed(3))}</text></g>`).join('')}
    <line x1="${ml}" x2="${ml + pw}" y1="${mt + ph}" y2="${mt + ph}" stroke="var(--tx2)" stroke-width="1.2"></line>
    <line x1="${ml}" x2="${ml}" y1="${mt}" y2="${mt + ph}" stroke="var(--tx2)" stroke-width="1.2"></line>
    <text x="${ml + pw / 2}" y="${height - 1}" text-anchor="middle">u max (mm)</text>
    <text x="12" y="${mt + ph / 2}" text-anchor="middle" transform="rotate(-90 12 ${mt + ph / 2})">SigmaMsf</text>
  `;
  return `
    <div class="st6-safety-curve">
      <div class="st6-safety-curve-head">
        <strong>Safety curve</strong>
        <span>FoS ${Number.isFinite(lower) ? lower.toFixed(3) : '—'}${Number.isFinite(upper) && upper > lower ? ` - ${upper.toFixed(3)}` : ''}</span>
      </div>
      <svg class="st6-safety-curve-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Safety curve SigmaMsf versus displacement">
        ${axis}
        ${bracketBand}
        <path d="${path}" fill="none" stroke="var(--ac)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></path>
        ${acceptedMarkers}
        ${failedMarkers}
        ${displayedMarker}
        ${finalMarker}
      </svg>
      <div class="st6-safety-curve-legend">
        <span><i class="accepted"></i> accepted</span>
        <span><i class="failed"></i> failed target</span>
        <span><i class="reported"></i> reported FoS</span>
      </div>
    </div>
  `;
}

function stage6BishopSafetyMechanismHtml(mechanism){
  if(!mechanism) return '';
  const activeElements = Math.max(Math.round(Number(mechanism.activePlasticElementCount) || 0), 0);
  const largestComponent = Math.max(Math.round(Number(mechanism.largestConnectedComponentElementCount) || 0), 0);
  const activePoints = Math.max(Math.round(Number(mechanism.activePlasticPointCount) || 0), 0);
  const components = Math.max(Math.round(Number(mechanism.connectedComponentCount) || 0), 0);
  const score = Number(mechanism.score) || 0;
  const threshold = Number(mechanism.threshold) || 0.65;
  const flags = [
    mechanism.mechanismTouchesLoadedZone ? 'loaded zone' : '',
    mechanism.mechanismTouchesFreeSurface ? 'free surface' : '',
    mechanism.mechanismTouchesBoundary ? 'outer boundary' : '',
    mechanism.mechanismCrossesSlopeOrFoundationZone ? 'connected path' : ''
  ].filter(Boolean);
  return `
    <div class="info st6-safety-mechanism" style="background:var(--bg2);border-color:var(--bd2)">
      <strong>Mechanism</strong>
      <div class="st6-safety-mechanism-grid">
        <span>Status</span><b>${stage6EscAttr(mechanism.status || 'none')}</b>
        <span>Score</span><b>${stage6CompactNumber(score, 3)} / ${stage6CompactNumber(threshold, 3)}</b>
        <span>Active elements</span><b>${activeElements}</b>
        <span>Largest component</span><b>${largestComponent} of ${components || 0}</b>
        <span>Active points</span><b>${activePoints}</b>
        <span>Length</span><b>${stage6CompactNumber(Number(mechanism.mechanismLength) || 0, 3)} m</b>
        <span>Direction coherence</span><b>${stage6CompactNumber(Number(mechanism.displacementDirectionCoherence) || 0, 3)}</b>
        <span>Contact</span><b>${flags.length ? flags.map(stage6EscAttr).join(', ') : 'none'}</b>
      </div>
    </div>
  `;
}

function stage6SeepageFlowErrorLabel(result){
  return result?.flowError != null ? `${stage6CompactNumber(100 * result.flowError, 3)} %` : '—';
}

function stage6BishopSeepageTerminationLabel(reason){
  if(!reason) return '—';
  if(reason === 'time-limit') return 'Stopped at runtime limit';
  if(reason === 'interrupted') return 'Interrupted by user';
  if(reason === 'fixed-boundary') return 'Solved with fixed phreatic boundary';
  return 'Converged on flow-rate error target';
}

function stage6BishopResultMethodLabel(result){
  if(!result) return '—';
  if(result.method === 'spencer') return 'Spencer';
  if(result.spencerAttempted && !result.spencerConverged) return 'Seep/Slope (Spencer fallback)';
  return 'Seep/Slope';
}

function stage6BishopRunningMessage(){
  return S.stage6?.bishop?.methodMode === 'bishop_spencer'
    ? 'Running Bishop search; Spencer will recheck the shortlist...'
    : 'Running Bishop search...';
}

function stage6BishopReadyMessage(runReady){
  if(!runReady) return 'Draw terrain, place the active CPT, and define entry and exit zones. Retaining walls, load zones, and the phreatic line are optional.';
  return S.stage6?.bishop?.methodMode === 'bishop_spencer'
    ? 'Ready to run Bishop + Spencer check.'
    : 'Ready to run Bishop search.';
}

function stage6BishopCompleteMessage(result, timing){
  if(!result?.critical) return 'Search completed with no valid slip circles.';
  const runtime = timing?.totalMs?.toFixed ? timing.totalMs.toFixed(0) : timing?.totalMs || 0;
  if(result.methodMode === 'bishop_spencer'){
    if((result.spencerConverged || 0) > 0){
      return `Search + Spencer check complete in ${runtime} ms.`;
    }
    return `Bishop search complete in ${runtime} ms; Spencer fell back to Bishop results.`;
  }
  return `Search complete in ${runtime} ms.`;
}

function stage6BishopSeepageCompleteMessage(result){
  const runtime = stage6SecondsLabelFromMs(result?.timing?.totalMs);
  const flowError = stage6SeepageFlowErrorLabel(result);
  const terminationReason = result?.solver?.terminationReason || 'flow-error';
  if(terminationReason === 'time-limit'){
    return flowError !== '—'
      ? `Seepage stopped after ${runtime} at the configured runtime limit. Latest flow-rate error: ${flowError}.`
      : `Seepage stopped after ${runtime} at the configured runtime limit; showing the best available result.`;
  }
  if(terminationReason === 'interrupted'){
    return flowError !== '—'
      ? `Seepage interrupted after ${runtime}. Showing the latest solved state with flow-rate error ${flowError}.`
      : `Seepage interrupted after ${runtime}. Showing the latest solved state.`;
  }
  if(terminationReason === 'fixed-boundary'){
    return `Seepage solved in ${runtime} with a fixed phreatic boundary.`;
  }
  return `Seepage solved in ${runtime} with flow-rate error ${flowError}.`;
}

function stage6BishopModeMeta(){
  const bishop = S.stage6.bishop;
  if(bishop.tool === 'terrain'){
    return {
      label:'Terrain mode',
      hint:'Click terrain points from left to right, then press Finish draft to accept the terrain.'
    };
  }
  if(bishop.tool === 'phreatic'){
    return {
      label:'Phreatic mode',
      hint:'Click phreatic-line points from left to right, then press Finish draft to accept the line.'
    };
  }
  if(bishop.tool === 'region'){
    return {
      label:'Soil polygon mode',
      hint:'Click polygon vertices, then press Finish draft or right-click to close the polygon. New polygons use the selected material and switch Bishop to custom polygon mode.'
    };
  }
  if(bishop.tool === 'regionHole'){
    return {
      label:'Hole cut mode',
      hint:'Draw a closed polygon inside the selected custom polygon to create a material override there. The chosen material for new polygons will be used for the cutout.'
    };
  }
  if(bishop.tool === 'regionSplit'){
    return {
      label:'Split polygon mode',
      hint:'Click two points on the boundary of the selected custom polygon to split it into two polygons. Right-click cancels the current split draft.'
    };
  }
  if(bishop.tool === 'cpt'){
    return {
      label:'Place CPT mode',
      hint:'Click once on the terrain to place the active CPT marker used for the Bishop soil column.'
    };
  }
  if(bishop.tool === 'entry'){
    return {
      label:'Entry zone mode',
      hint:'Click the start and end of the entry zone on the terrain.'
    };
  }
  if(bishop.tool === 'exit'){
    return {
      label:'Exit zone mode',
      hint:'Click the start and end of the exit zone on the terrain.'
    };
  }
  if(bishop.tool === 'load'){
    return {
      label:'Load zone mode',
      hint:'Click the start and end of a uniform surcharge strip on the terrain. Set q below in kPa.'
    };
  }
  if(bishop.tool === 'wall'){
    return {
      label:'Retaining wall mode',
      hint:'Click the wall head, then click the wall tip. The wall can be vertical or inclined and stays shared by stability, seepage, and deformation.'
    };
  }
  if(bishop.tool === 'measure'){
    return {
      label:'Measure mode',
      hint:'Click two points in the shared canvas to measure the straight-line distance, horizontal delta, and vertical delta. A third click starts a new measurement.'
    };
  }
  if(bishop.tool === 'seepageBc'){
    return {
      label:'Boundary-condition mode',
      hint:'Click an outer-boundary edge to assign a seepage boundary condition. Only the terrain, model base, and the two side boundaries can carry seepage BCs.'
    };
  }
  if(bishop.tool === 'drain'){
    return {
      label:'Drain mode',
      hint:'Click the drain start point, then click the end point. The new drain is selected so you can set its head.'
    };
  }
  return {
    label:'Edit / pan mode',
    hint:'Drag terrain or phreatic vertices, retaining-wall ends, the CPT marker, zone ends, or selected custom soil-polygon vertices. Click a custom polygon first to select it. Drag empty space to pan and use the mouse wheel to zoom.'
  };
}

function stage6BishopToolIcon(name){
  const icons = {
    close:'<path d="M18 6 6 18"></path><path d="m6 6 12 12"></path>',
    play:'<path d="M6 4l14 8-14 8V4Z"></path>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="2"></rect>',
    collapse:'<path d="M15 6 9 12l6 6"></path>',
    expand:'<path d="M9 6l6 6-6 6"></path>',
    settings:'<path d="M4 6h16"></path><path d="M4 12h16"></path><path d="M4 18h16"></path><circle cx="8" cy="6" r="1.8"></circle><circle cx="15" cy="12" r="1.8"></circle><circle cx="11" cy="18" r="1.8"></circle>',
    panel:'<rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M9 5v14"></path>',
    eyeOff:'<path d="M3 3l18 18"></path><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path><path d="M9.5 5.2A10.5 10.5 0 0 1 12 5c5 0 8.5 4.4 9.5 7a12.8 12.8 0 0 1-2.2 3.4"></path><path d="M6.2 6.8A12.8 12.8 0 0 0 2.5 12c1 2.6 4.5 7 9.5 7 1.4 0 2.7-.3 3.8-.9"></path>',
    materials:'<rect x="5" y="4" width="14" height="16" rx="2"></rect><path d="M5 9h14"></path><path d="M5 14h14"></path><path d="M9 4v16"></path><circle cx="7" cy="6.5" r=".8"></circle><circle cx="7" cy="11.5" r=".8"></circle><circle cx="7" cy="16.5" r=".8"></circle>',
    chart:'<path d="M4 19V5"></path><path d="M4 19h16"></path><path d="m7 15 3-4 3 2 4-7"></path>',
    reset:'<path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 14h10l1-14"></path><path d="M9 7V4h6v3"></path>',
    pointer:'<path d="M5 3l7 16 2-6 6-2L5 3Z"></path>',
    measure:'<path d="M4 17 17 4l3 3L7 20l-3-3Z"></path><path d="m8 13 2 2"></path><path d="m11 10 2 2"></path><path d="m14 7 2 2"></path>',
    fit:'<path d="M8 3H3v5"></path><path d="M16 3h5v5"></path><path d="M8 21H3v-5"></path><path d="M16 21h5v-5"></path><path d="M3 3l6 6"></path><path d="m15 9 6-6"></path><path d="m3 21 6-6"></path><path d="m15 15 6 6"></path>',
    terrain:'<path d="M3 17c3-6 5-8 8-5s5 1 10-6"></path><path d="M3 21h18"></path>',
    import:'<path d="M12 3v10"></path><path d="m8 9 4 4 4-4"></path><path d="M5 17v2h14v-2"></path>',
    cpt:'<path d="M12 3v18"></path><path d="M8 7h8"></path><path d="M9 21h6"></path><circle cx="12" cy="11" r="2"></circle>',
    phreatic:'<path d="M3 14c2-3 4-3 6 0s4 3 6 0 4-3 6 0"></path><path d="M3 19c2-3 4-3 6 0s4 3 6 0 4-3 6 0"></path>',
    wall:'<path d="M12 3v18"></path><path d="M8 6h8"></path><path d="M8 10h8"></path><path d="M8 14h8"></path><path d="M8 18h8"></path>',
    drain:'<path d="M4 14h16"></path><path d="M6 10h12"></path><path d="M8 6h8"></path><path d="M7 18c1.8 2 8.2 2 10 0"></path>',
    load:'<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 20h14"></path>',
    entry:'<path d="M4 12h15"></path><path d="m10 6-6 6 6 6"></path>',
    exit:'<path d="M5 12h15"></path><path d="m14 6 6 6-6 6"></path>',
    boundary:'<rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M4 12h16"></path><circle cx="8" cy="12" r="1.6"></circle><circle cx="16" cy="12" r="1.6"></circle>',
    polygon:'<path d="M12 3 20 9l-3 10H7L4 9l8-6Z"></path>',
    meshUndeformed:'<path d="M4 6h16v12H4Z"></path><path d="M4 12h16"></path><path d="M10 6v12"></path><path d="M16 6v12"></path>',
    meshDeformed:'<path d="M4 18 9 8l6 3 5-7"></path><path d="M4 18h16"></path><path d="M9 8l1 10"></path><path d="M15 11l-5 7"></path>',
    arrows:'<path d="M5 17 17 5"></path><path d="M12 5h5v5"></path><path d="M19 7v12H7"></path><path d="m7 19 4-4"></path>',
    contourFill:'<path d="M4 18c3-8 6-12 10-10s4 6 6 10"></path><path d="M4 18h16"></path><path d="M8 16h8"></path><path d="M10 13h4"></path>',
    contourLines:'<path d="M4 8c4-3 8-3 12 0s4 3 4 0"></path><path d="M4 13c4-3 8-3 12 0s4 3 4 0"></path><path d="M4 18c4-3 8-3 12 0s4 3 4 0"></path>',
    plastic:'<circle cx="8" cy="8" r="2"></circle><circle cx="16" cy="9" r="2"></circle><circle cx="12" cy="16" r="2"></circle><path d="M10 9.5 14 15"></path><path d="M10 8.2 14 8.8"></path>',
    exitGradient:'<path d="M12 3 22 20H2L12 3Z"></path><path d="M12 9v5"></path><path d="M12 17h.01"></path>',
    label:'<path d="M4 6h10l6 6-6 6H4Z"></path><circle cx="8" cy="12" r="1.5"></circle>',
    copy:'<rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M5 15V5h10"></path>',
    cut:'<circle cx="6" cy="7" r="2"></circle><circle cx="6" cy="17" r="2"></circle><path d="M8 8.5 19 19"></path><path d="M8 15.5 19 5"></path>',
    split:'<path d="M4 6h6a4 4 0 0 1 4 4v8"></path><path d="M4 18h6a4 4 0 0 0 4-4V6"></path><path d="M18 6h2"></path><path d="M18 18h2"></path>',
    finish:'<path d="M20 6 9 17l-5-5"></path>',
    undo:'<path d="M9 7 4 12l5 5"></path><path d="M5 12h10a5 5 0 0 1 0 10h-2"></path>',
    clear:'<path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 14h10l1-14"></path><path d="M9 7V4h6v3"></path>',
    layers:'<path d="m12 3 9 5-9 5-9-5 9-5Z"></path><path d="m3 12 9 5 9-5"></path><path d="m3 16 9 5 9-5"></path>',
    copy:'<rect x="9" y="9" width="10" height="10" rx="2"></rect><rect x="5" y="5" width="10" height="10" rx="2"></rect>'
  };
  return `<svg class="st6-canvas-tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[name] || icons.pointer}</svg>`;
}

function stage6BishopCanvasToolButton(options){
  const label = options?.label || 'Tool';
  const className = [
    'st6-canvas-tool-btn',
    options?.active ? 'active' : '',
    options?.tone ? `tone-${options.tone}` : ''
  ].filter(Boolean).join(' ');
  const disabled = options?.disabled ? ' disabled' : '';
  const onclick = options?.disabled ? '' : ` onclick="${options.onclick || ''}"`;
  return `
    <button type="button" class="${className}"${onclick}${disabled} title="${stage6EscAttr(label)}" aria-label="${stage6EscAttr(label)}" data-tip="${stage6EscAttr(label)}">
      ${stage6BishopToolIcon(options?.icon || 'pointer')}
      <span>${stage6EscAttr(label)}</span>
    </button>
  `;
}

function stage6BishopWallMechanicalLabel(wall){
  const section = resolveWallMechanicalSection(wall?.material?.mechanical);
  if(!section) return 'mechanical section not set';
  if(section.model === 'section-properties'){
    return `EA ${stage6CompactNumber(section.EA, 3)} kN/m · EI ${stage6CompactNumber(section.EI, 3)} kN·m²/m`;
  }
  return `E ${stage6CompactNumber(section.E, 3)} kPa · t ${stage6CompactNumber(section.thickness, 3)} m`;
}

function stage6BishopWallInfoPanelHtml(){
  const bishop = S.stage6?.bishop;
  const wall = (bishop?.walls || []).find((item)=>item.id === bishop.selectedWallId);
  if(!wall) return '';
  const wallIndex = (bishop.walls || []).findIndex((item)=>item.id === wall.id);
  const wallResult = stage6BishopSelectedWallResult();
  const series = wallResult ? stage6BishopWallResultSeries(wallResult) : null;
  const maxAbs = (values)=>Math.max(0, ...(values || []).map((value)=>Math.abs(Number(value) || 0)));
  const maxM = series ? maxAbs(series.MPassive) : 0;
  const maxV = series ? maxAbs(series.VPassive) : 0;
  const maxN = series ? maxAbs(series.N) : 0;
  const maxW = series ? maxAbs(series.wPassive) : 0;
  const maxTheta = series ? maxAbs(series.thetaPassive) : 0;
  const idxMaxM = series?.MPassive?.findIndex((value)=>Math.abs(Number(value) || 0) === maxM) ?? -1;
  const wallIdArg = stage6EscJsString(wall.id);
  return `
    <div class="st6-canvas-card-section st6-canvas-card--wall-info">
      <div class="st6-canvas-card-kicker">Selected retaining wall</div>
      <div class="st6-canvas-card-note">
        Wall ${wallIndex + 1} · ${stage6EscAttr(wall.material?.label || wall.id)}
        <br>Length ${wallLength(wall).toFixed(2)} m · passive ${stage6EscAttr(wall.passiveSide)}
        <br>${stage6EscAttr(stage6BishopWallMechanicalLabel(wall))}
      </div>
      <div class="st6-canvas-card-row st6-canvas-card-row--actions">
        <button type="button" class="st6-canvas-tool ${wall.mechanicalActive === true ? 'active' : ''}" onclick="stage6BishopSetWallField(${wallIndex}, 'mechanicalActive', ${wall.mechanicalActive === true ? 'false' : 'true'})">
          ${stage6BishopToolIcon('wall')}<span>${wall.mechanicalActive === true ? 'Mechanical active' : 'Activate mechanical'}</span>
        </button>
        <button type="button" class="st6-canvas-tool ${bishop.deformation?.display?.showWallMomentOverlay === true ? 'active' : ''}" onclick="stage6BishopToggleWallMomentOverlay()">
          ${stage6BishopToolIcon('chart')}<span>${bishop.deformation?.display?.showWallMomentOverlay === true ? 'Hide overlay' : 'Show overlay'}</span>
        </button>
      </div>
      ${series ? `
        <div class="st6-canvas-card-note">
          Max |N| ${stage6CompactNumber(maxN, 3)} kN/m ·
          Max |V| ${stage6CompactNumber(maxV, 3)} kN/m ·
          Max |M| ${stage6CompactNumber(maxM, 3)} kN·m/m${idxMaxM >= 0 ? ` at s ${stage6CompactNumber(series.sNode[idxMaxM] || 0, 3)} m` : ''}
          <br>Max |w| ${(1000 * maxW).toFixed(2)} mm · Max |θ| ${(1000 * maxTheta).toFixed(3)} mrad
        </div>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          <button type="button" class="st6-canvas-tool" onclick="stage6BishopOpenAnalysisTab('structure', ${wallIdArg})">${stage6BishopToolIcon('chart')}<span>Open Analysis</span></button>
          <button type="button" class="st6-canvas-tool" onclick="stage6BishopCopyWallData(${wallIdArg})">${stage6BishopToolIcon('copy')}<span>Copy data</span></button>
        </div>
      ` : `
        <div class="st6-canvas-card-note">Run deformation with this wall mechanically active, then open Analysis → Structure to inspect N, V, M, w, and theta diagrams.</div>
      `}
    </div>
  `;
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
  const ui = stage6BishopUiState();
  const bishop = context?.bishop || S.stage6.bishop;
  const workspace = context?.workspace || 'stability';
  const model = context?.model || null;
  const selectedCustomRegion = context?.selectedCustomRegion || null;
  const selectedSeepageEdge = context?.selectedSeepageEdge || null;
  const selectedSeepageBc = context?.selectedSeepageBc || null;
  const selectedDrainIndex = (bishop.drains || []).findIndex((drain)=>drain.id === bishop.selectedDrainId);
  const selectedDrain = selectedDrainIndex >= 0 ? bishop.drains[selectedDrainIndex] : null;
  const pendingWallActivationCount = (bishop.walls || []).filter((wall)=>wall.mechanicalActivationPromptPending === true).length;
  const isHidden = ui.bishopCanvasToolsHidden === true;
  const activePanel = ui.bishopActiveCanvasPanel === 'view' ? '' : (ui.bishopActiveCanvasPanel || '');
  const activeSheet = ui.bishopActiveCanvasSheet || '';
  if(isHidden){
    return `
      <button type="button" class="st6-canvas-tools-restore" onclick="stage6BishopToggleCanvasTools(true)" title="Show canvas tools" aria-label="Show canvas tools">
        ${stage6BishopToolIcon('settings')}
      </button>
    `;
  }
  const toolButton = (id, label, icon, disabled = false)=>stage6BishopCanvasToolButton({
    label,
    icon,
    active:bishop.tool === id,
    disabled,
    onclick:`stage6BishopSetTool('${id}')`
  });
  const actionButton = (label, icon, onclick, disabled = false, tone = '')=>stage6BishopCanvasToolButton({
    label,
    icon,
    disabled,
    onclick,
    tone
  });
  const panelButton = (id, label, icon)=>stage6BishopCanvasToolButton({
    label,
    icon,
    active:activePanel === id && !activeSheet,
    onclick:`stage6BishopSetCanvasPanel('${id}')`
  });
  const sheetButton = (id, label, icon)=>stage6BishopCanvasToolButton({
    label,
    icon,
    active:activeSheet === id,
    onclick:`stage6BishopSetCanvasSheet('${id}')`
  });
  const hasDraft = !!bishop.draft?.length;
  const finishDraftEnabled = (
    (bishop.draftKind === 'terrain' || bishop.draftKind === 'phreatic') && bishop.draft.length >= 2
  ) || (
    bishop.draftKind === 'drain' && bishop.draft.length >= 2
  ) || (
    (bishop.draftKind === 'region' || bishop.draftKind === 'regionHole') && bishop.draft.length >= 3
  );
  const loadQ = Number(context?.loadQ || 0);
  const surfaceLoads = bishop.surfaceLoads || [];
  const selectedSurfaceLoad = (surfaceLoads || []).find((load)=>load.id === bishop.selectedSurfaceLoadId) || null;
  const primarySurfaceLoad = selectedSurfaceLoad
    || surfaceLoads.find((load)=>load.active !== false)
    || surfaceLoads[0]
    || null;
  const selectedLoadWidth = stage6BishopValidZone(selectedSurfaceLoad)
    ? Math.max(selectedSurfaceLoad.xEnd - selectedSurfaceLoad.xStart, 0)
    : 0;
  const surfaceLoadRows = surfaceLoads.map((load, index)=>{
    const selected = load.id === bishop.selectedSurfaceLoadId;
    const q = stage6BishopEffectiveSurfaceLoadQ(load, workspace);
    const loadIdArg = stage6EscJsString(load.id);
    return `
      <div class="st6-canvas-card-row" style="gap:6px;align-items:center">
        <button type="button" class="st6-canvas-tool ${selected ? 'active' : ''}" style="flex:1;justify-content:flex-start" onclick="stage6BishopSelectSurfaceLoad(${loadIdArg})" title="${stage6EscAttr(stage6BishopSurfaceLoadSummary(load, workspace))}">
          ${stage6BishopToolIcon('load')}
          <span>${stage6EscAttr(load.label || `Load ${index + 1}`)}</span>
        </button>
        <button type="button" class="st6-canvas-tool ${load.active !== false ? 'active' : ''}" style="width:36px;flex:0 0 36px" onclick="stage6BishopSetSurfaceLoadField(${loadIdArg}, 'active', ${load.active === false ? 'true' : 'false'})" title="${load.active === false ? 'Enable load' : 'Disable load'}" aria-label="${load.active === false ? 'Enable load' : 'Disable load'}">
          ${stage6BishopToolIcon(load.active === false ? 'eyeOff' : 'play')}
        </button>
        <span style="font-size:11px;color:var(--tx2);min-width:54px;text-align:right">${q.toFixed(1)} kPa</span>
      </div>
    `;
  }).join('');
  const selectedLoadIdArg = selectedSurfaceLoad ? stage6EscJsString(selectedSurfaceLoad.id) : '""';
  const selectedSurfaceLoadEditor = selectedSurfaceLoad ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Selected load</div>
      <label class="st6-canvas-check">
        <input type="checkbox" ${selectedSurfaceLoad.active === false ? '' : 'checked'} onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'active', this.checked)">
        Active in current model
      </label>
      <label>Label
        <input type="text" value="${stage6EscAttr(selectedSurfaceLoad.label || selectedSurfaceLoad.id)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'label', this.value)">
      </label>
      <label>Load input
        <select onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'loadMode', this.value)">
          <option value="pressure"${selectedSurfaceLoad.loadMode !== 'total' ? ' selected' : ''}>Pressure q (kPa)</option>
          <option value="total"${selectedSurfaceLoad.loadMode === 'total' ? ' selected' : ''}>Total load (kN)</option>
        </select>
      </label>
      ${selectedSurfaceLoad.loadMode === 'total' ? `
        <label>Total load (kN)
          <input type="number" step="1" min="0" value="${Number(selectedSurfaceLoad.totalLoad || 0).toFixed(1)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'totalLoad', this.value)">
        </label>
      ` : `
        <label>Pressure q (kPa)
          <input type="number" step="1" min="0" value="${Number(selectedSurfaceLoad.q || 0).toFixed(1)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'q', this.value)">
        </label>
      `}
      <div class="st6-canvas-card-grid">
        <label>x start (m)
          <input type="number" step="0.1" value="${Number(selectedSurfaceLoad.xStart ?? 0).toFixed(2)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'xStart', this.value)">
        </label>
        <label>x end (m)
          <input type="number" step="0.1" value="${Number(selectedSurfaceLoad.xEnd ?? 0).toFixed(2)}" onchange="stage6BishopSetSurfaceLoadField(${selectedLoadIdArg}, 'xEnd', this.value)">
        </label>
      </div>
      <div class="st6-canvas-card-note">Width ${selectedLoadWidth.toFixed(2)} m · effective q ${stage6BishopEffectiveSurfaceLoadQ(selectedSurfaceLoad, workspace).toFixed(2)} kPa</div>
      <div class="st6-canvas-card-row st6-canvas-card-row--actions">
        ${actionButton('Delete load', 'reset', `stage6BishopDeleteSurfaceLoad(${selectedLoadIdArg})`, false, 'danger')}
      </div>
    </div>
  ` : '';
  const seepage = bishop.seepage || {};
  const seepageMeshTargetArea = Number(context?.seepageMeshTargetArea || 0);
  const seepageUsesIterativeFreeSurface = seepage.options?.freeSurface === 'iterate';
  const viewSeepageContourOptions = stage6BishopSeepageContourOptions();
  const viewSeepageContourMode = bishop.seepage?.display?.contourMode || 'head';
  const viewDeformationAnalysisType = bishop.deformation?.options?.analysisType === 'safety-cphi' ? 'safety-cphi' : 'deformation';
  const viewDeformationHasHs = STAGE6_ENABLE_HARDENING_SOIL_UI && bishop.deformation?.result?.hasHardeningSoil === true;
  const viewDeformationContourOptions = stage6BishopDeformationContourOptions(viewDeformationAnalysisType, viewDeformationHasHs);
  const viewDeformationContourMode = bishop.deformation?.display?.contourMode || 'uTotal';
  const deformationShowWallOverlay = bishop.deformation?.display?.showWallMomentOverlay === true;
  const wallOverlayQuantity = stage6BishopWallOverlayQuantity();
  const wallOverlayStats = stage6BishopWallQuantityStats(
    stage6BishopWallResultForId(stage6BishopAnalysisWallId()),
    wallOverlayQuantity
  );
  const wallOverlayStatsLabel = wallOverlayStats
    ? `min ${stage6BishopWallQuantityFormat(wallOverlayStats.min, wallOverlayStats.meta)} · max ${stage6BishopWallQuantityFormat(wallOverlayStats.max, wallOverlayStats.meta)}`
    : 'Run deformation and hover a wall to inspect min/max.';
  const draftRegionMaterialId = bishop.regionDraftMaterialId || bishop.materials?.[0]?.id || '';
  const selectedRegionMaterialId = selectedCustomRegion?.materialId || draftRegionMaterialId;
  const draftMaterialOptions = (bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${draftRegionMaterialId===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('');
  const selectedMaterialOptions = (bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${selectedRegionMaterialId===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('');
  const panelTitle = {
    draw:'Draw',
    structures:'Structures',
    boundary:'Boundary conditions',
    regions:'Regions',
    view:'View',
    solve:'Solve',
    reset:'Reset'
  }[activePanel] || '';
  const sheetTitle = {
    structures:'Structure Settings',
    boundary:'Boundary Conditions',
    regions:'Region Settings',
    view:'View Settings',
    materials:'Materials',
    workspace:workspace === 'seepage' ? 'Seepage Settings' : workspace === 'deformation' ? 'Deformation Settings' : 'Stability Settings',
    reset:'Reset Geometry',
    probe:'Analysis'
  }[activeSheet] || '';
  const draftActions = hasDraft ? `
    <div class="st6-canvas-card-row st6-canvas-card-row--actions">
      ${actionButton('Finish draft', 'finish', 'stage6BishopFinishDraft()', !finishDraftEnabled)}
      ${actionButton('Undo point', 'undo', 'stage6BishopPopDraftPoint()')}
      ${actionButton('Clear draft', 'clear', "stage6BishopClear('draft')", false, 'danger')}
    </div>
  ` : '';
  const drawPanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Section drawing</div>
      <div class="st6-canvas-card-grid">
        ${toolButton('terrain', 'Terrain', 'terrain')}
        ${actionButton('Import DXF', 'import', 'stage6BishopTriggerDxfImport()')}
        ${toolButton('cpt', 'Place CPT', 'cpt')}
        ${toolButton('phreatic', 'Phreatic line', 'phreatic')}
        ${toolButton('measure', 'Measure', 'measure')}
        ${toolButton('edit', 'Edit / pan', 'pointer')}
      </div>
      ${draftActions}
    </div>
  `;
	  const structuresPanel = `
	    <div class="st6-canvas-card-section">
	      <div class="st6-canvas-card-kicker">Structure tools</div>
      <div class="st6-canvas-card-grid">
        ${toolButton('wall', 'Retaining wall', 'wall')}
        ${toolButton('drain', 'Drain line', 'drain', !model)}
        ${toolButton('load', 'Load zone', 'load')}
        ${toolButton('entry', 'Entry zone', 'entry')}
        ${toolButton('exit', 'Exit zone', 'exit')}
      </div>
    </div>
      ${pendingWallActivationCount ? `
        <div class="st6-canvas-card-section">
          <div class="st6-canvas-card-kicker">Legacy wall activation</div>
          <div class="st6-canvas-card-note">${pendingWallActivationCount} existing retaining wall${pendingWallActivationCount === 1 ? '' : 's'} opened from older project data. They stay inactive in deformation until you opt in.</div>
          <div class="st6-canvas-card-row st6-canvas-card-row--actions">
            <button type="button" class="st6-canvas-tool" onclick="stage6BishopResolveWallMechanicalActivation(true)">${stage6BishopToolIcon('wall')}<span>Activate</span></button>
            <button type="button" class="st6-canvas-tool" onclick="stage6BishopResolveWallMechanicalActivation(false)">${stage6BishopToolIcon('close')}<span>Keep inactive</span></button>
          </div>
        </div>
      ` : ''}
	    ${stage6BishopWallInfoPanelHtml()}
	    <div class="st6-canvas-card-section">
	      <div class="st6-canvas-card-kicker">Quick settings</div>
	      <label>${primarySurfaceLoad ? `Quick q for ${stage6EscAttr(primarySurfaceLoad.label || primarySurfaceLoad.id)}` : 'Default surface load q'} (kPa)
	        <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)">
	      </label>
	      <div class="st6-canvas-card-note">Use Load zone to draw another strip. Click a strip in Edit / pan to select and edit it.</div>
	      ${selectedDrain ? `
        <label>Selected drain head h (m)
          <input type="number" step="0.05" value="${Number(drainHeadValueAt(selectedDrain, 0) || 0).toFixed(2)}" onchange="stage6BishopSetDrainField(${selectedDrainIndex}, 'head', this.value)">
        </label>
        <label>Drain gating
          <select onchange="stage6BishopSetDrainField(${selectedDrainIndex}, 'gating', this.value)">
            <option value="always"${selectedDrain.gating==='always'?' selected':''}>Always</option>
            <option value="when-saturated"${selectedDrain.gating==='when-saturated'?' selected':''}>When saturated</option>
            <option value="head-cap"${selectedDrain.gating==='head-cap'?' selected':''}>Head cap</option>
          </select>
        </label>
      ` : '<div class="st6-canvas-card-note">Select or draw a drain to edit head and gating here.</div>'}
	      <div class="st6-canvas-card-row st6-canvas-card-row--actions">
	        ${actionButton('Manage structures', 'wall', "stage6BishopSetCanvasSheet('structures')")}
	        ${actionButton('Reset tools', 'reset', "stage6BishopSetCanvasSheet('reset')")}
	      </div>
	    </div>
	    <div class="st6-canvas-card-section">
	      <div class="st6-canvas-card-kicker">Surface loads</div>
	      ${surfaceLoadRows || '<div class="st6-canvas-card-note">No loads yet. Select Load zone, then click two terrain points.</div>'}
	    </div>
	    ${selectedSurfaceLoadEditor}
	  `;
  const boundaryPanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Boundary assignment</div>
      <div class="st6-canvas-card-grid">
        ${toolButton('seepageBc', 'Assign BC', 'boundary', !model || workspace !== 'seepage')}
        ${toolButton('edit', 'Edit / pan', 'pointer')}
      </div>
      ${workspace !== 'seepage' ? '<div class="st6-canvas-card-note">Boundary conditions are available in the Seepage workspace.</div>' : ''}
    </div>
    ${workspace === 'seepage' ? `
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Selected edge</div>
        ${selectedSeepageEdge ? `
          <div class="st6-canvas-card-note">${stage6EscAttr(stage6BishopSeepageEdgeLabel(selectedSeepageEdge))} · ${selectedSeepageEdge.length.toFixed(2)} m</div>
          <label>Boundary type
            <select onchange="stage6BishopSetSeepageBcType(this.value)">
              <option value="no-flow"${(selectedSeepageBc?.type || 'no-flow')==='no-flow'?' selected':''}>No-flow</option>
              <option value="head"${selectedSeepageBc?.type==='head'?' selected':''}>Prescribed head</option>
              <option value="seepage-face"${selectedSeepageBc?.type==='seepage-face'?' selected':''}>Seepage face</option>
            </select>
          </label>
          ${(selectedSeepageBc?.type || 'no-flow') === 'head' ? `
            <label>Head h (m elevation)
              <input type="number" step="0.05" value="${Number(selectedSeepageBc?.head ?? selectedSeepageEdge.mid.y).toFixed(2)}" onchange="stage6BishopSetSeepageBcHead(this.value)">
            </label>
          ` : ''}
          <div class="st6-canvas-card-row st6-canvas-card-row--actions">
            ${actionButton('Remove BC', 'clear', `stage6BishopDeleteSeepageBc('${stage6EscAttr(selectedSeepageEdge.edgeKey)}')`, false, 'danger')}
            ${actionButton('BC table', 'boundary', "stage6BishopSetCanvasSheet('boundary')")}
          </div>
        ` : '<div class="st6-canvas-card-note">Click Assign BC, then choose an outer boundary edge.</div>'}
      </div>
    ` : ''}
  `;
  const regionsPanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Region tools</div>
      <div class="st6-canvas-card-grid">
        ${actionButton('Copy CPT regions', 'copy', 'stage6BishopCopyCurrentRegionsToCustom()', !model)}
        ${toolButton('region', 'Draw polygon', 'polygon', !model)}
        ${toolButton('regionHole', 'Cut hole', 'cut', !selectedCustomRegion)}
        ${toolButton('regionSplit', 'Split polygon', 'split', !selectedCustomRegion)}
      </div>
    </div>
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Region settings</div>
      <label>Material for new polygons
        <select onchange="stage6BishopSetField('regionDraftMaterialId', this.value)">${draftMaterialOptions}</select>
      </label>
      ${selectedCustomRegion ? `
        <label>Selected material
          <select onchange="stage6BishopSetSelectedRegionMaterial(this.value)">${selectedMaterialOptions}</select>
        </label>
        <label>Selected coarseness
          <input type="number" min="0.01" step="0.1" value="${stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness)}" onchange="stage6BishopSetSelectedRegionCoarseness(this.value)">
        </label>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          ${actionButton('Delete selected', 'clear', 'stage6BishopDeleteSelectedRegion()', false, 'danger')}
        </div>
      ` : '<div class="st6-canvas-card-note">Select a custom polygon to edit its material and mesh coarseness.</div>'}
    </div>
  `;
  const viewDisplayQuantityPanel = workspace === 'seepage' ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Display quantity</div>
      <label>Canvas contours
        <select onchange="stage6BishopSetField('seepage.display.contourMode', this.value)">
          ${viewSeepageContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${viewSeepageContourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
        </select>
      </label>
    </div>
  ` : workspace === 'deformation' ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Display quantity</div>
      <label>Canvas contours
        <select onchange="stage6BishopSetField('deformation.display.contourMode', this.value)">
          ${viewDeformationContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${viewDeformationContourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
        </select>
      </label>
    </div>
  ` : '';
  const viewPanel = `
    ${viewDisplayQuantityPanel}
    <details class="st6-canvas-card-section st6-canvas-mini-details" data-st6details="bishop-view-quick-snap"${stage6DetailsOpen('bishop-view-quick-snap')}>
      <summary>Snap</summary>
      <div class="st6-canvas-mini-details-body">
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.gridSnap?'checked':''} onchange="stage6BishopSetField('gridSnap', this.checked)"> Snap to grid</label>
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.pointSnap?'checked':''} onchange="stage6BishopSetField('pointSnap', this.checked)"> Snap to points</label>
        <label>Grid size (m)
          <input type="number" step="0.05" min="0.05" value="${bishop.snapSize.toFixed(2)}" onchange="stage6BishopSetField('snapSize', this.value)">
        </label>
      </div>
    </details>
    <details class="st6-canvas-card-section st6-canvas-mini-details" data-st6details="bishop-view-quick-layers"${stage6DetailsOpen('bishop-view-quick-layers')}>
      <summary>Canvas layers</summary>
      <div class="st6-canvas-mini-details-body">
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.display?.showRegions !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegions', this.checked)"> Soil polygons</label>
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.display?.showRegionLabels !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLabels', this.checked)"> Polygon labels</label>
        <label class="st6-canvas-check"><input type="checkbox" ${bishop.display?.showRegionLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLegend', this.checked)"> Polygon legend</label>
        ${workspace === 'seepage' ? `
          <label class="st6-canvas-check"><input type="checkbox" ${bishop.seepage?.display?.showBoundaryConditions !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showBoundaryConditions', this.checked)"> Boundary conditions</label>
          <label class="st6-canvas-check"><input type="checkbox" ${bishop.seepage?.display?.showDrains !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showDrains', this.checked)"> Drains</label>
          <label class="st6-canvas-check"><input type="checkbox" ${bishop.seepage?.display?.showFlowVectors ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showFlowVectors', this.checked)"> Flow lines</label>
          <label class="st6-canvas-check"><input type="checkbox" ${bishop.seepage?.display?.showExitGradient ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showExitGradient', this.checked)"> Exit gradient</label>
        ` : ''}
        ${workspace === 'deformation' ? `
          <label class="st6-canvas-check"><input type="checkbox" ${deformationShowWallOverlay ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showWallMomentOverlay', this.checked)"> Wall result overlay</label>
          <label>Wall overlay quantity
            <select onchange="stage6BishopSetField('deformation.display.wallOverlayQuantity', this.value)" title="${stage6EscAttr(wallOverlayStatsLabel)}">
              ${STAGE6_WALL_RESPONSE_QUANTITIES.map((option)=>`<option value="${stage6EscAttr(option.id)}"${wallOverlayQuantity===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
            </select>
          </label>
        ` : ''}
      </div>
    </details>
    <div class="st6-canvas-card-row st6-canvas-card-row--actions">
      ${actionButton('Detailed view', 'layers', "stage6BishopOpenSettingsDetail('bishop-geo-view')")}
      ${actionButton('Fit view', 'fit', 'fitStage6BishopViewport()')}
    </div>
  `;
  const solvePanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">${workspace === 'seepage' ? 'Seepage solve' : workspace === 'deformation' ? 'Deformation solve' : 'Stability solve'}</div>
      <div class="st6-canvas-card-row st6-canvas-card-row--actions">
        ${actionButton(context?.toolbarRunLabel || 'Run', 'play', context?.toolbarRunAction || 'stage6BishopRunSearch()', !context?.toolbarRunReady)}
        ${actionButton('Stop', 'stop', context?.toolbarStopAction || 'stage6BishopStopSearch();renderStage6()', !context?.toolbarRunning)}
        ${actionButton(context?.toolbarClearLabel || 'Clear result', 'clear', context?.toolbarClearAction || "stage6BishopClear('results')", !context?.toolbarHasResult)}
      </div>
      <div class="st6-canvas-card-note">${stage6EscAttr(context?.toolbarProgressText || '')}</div>
    </div>
    ${workspace === 'seepage' ? `
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Core settings</div>
        <label>Free-surface mode
          <select onchange="stage6BishopSetField('seepage.options.freeSurface', this.value)">
            <option value="iterate"${seepage.options?.freeSurface==='iterate'?' selected':''}>Iterative free surface</option>
            <option value="fixed"${seepage.options?.freeSurface==='fixed'?' selected':''}>Fixed phreatic line</option>
          </select>
        </label>
        <label class="st6-canvas-check"><input type="checkbox" ${seepage.options?.meshTargetAreaAuto !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.options.meshTargetAreaAuto', this.checked)"> Auto mesh size</label>
        <label>Target area (m²)
          <input type="number" step="0.01" min="0.01" value="${Number(seepageMeshTargetArea || 0).toFixed(2)}" onchange="stage6BishopSetField('seepage.options.meshTargetArea', this.value)">
        </label>
        <label>Flow error target (%)
          <input type="number" step="0.01" min="0.0001" value="${(100 * Math.max(Number(seepage.options?.flowErrorTolerance) || 0.01, 0.000001)).toFixed(3)}" onchange="stage6BishopSetField('seepage.options.flowErrorTolerance', this.value)" ${seepageUsesIterativeFreeSurface ? '' : 'disabled'}>
        </label>
        <label>Runtime cap (s)
          <input type="number" step="0.1" min="0.1" value="${(Math.max(Number(seepage.options?.maxRuntimeMs) || 10000, 1) / 1000).toFixed(2)}" onchange="stage6BishopSetField('seepage.options.maxRuntimeMs', this.value)" ${seepageUsesIterativeFreeSurface ? '' : 'disabled'}>
        </label>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          ${actionButton('Materials', 'materials', "stage6BishopSetCanvasSheet('materials')")}
          ${actionButton('Advanced solve', 'settings', "stage6BishopSetCanvasSheet('workspace')")}
        </div>
      </div>
    ` : workspace === 'stability' ? `
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Core settings</div>
        <label>Strength set
          <select onchange="stage6BishopSetField('strengthSet', this.value)">
            <option value="characteristic"${bishop.strengthSet==='characteristic'?' selected':''}>Characteristic</option>
            <option value="da1_1"${bishop.strengthSet==='da1_1'?' selected':''}>DA1/1 (M1)</option>
            <option value="da1_2"${bishop.strengthSet==='da1_2'?' selected':''}>DA1/2 (M2)</option>
          </select>
        </label>
        <label>Method
          <select onchange="stage6BishopSetField('methodMode', this.value)">
            <option value="bishop_spencer"${bishop.methodMode==='bishop_spencer'?' selected':''}>Bishop + Spencer</option>
            <option value="bishop_only"${bishop.methodMode==='bishop_only'?' selected':''}>Bishop only</option>
          </select>
        </label>
        <label>Surface load q (kPa)
          <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)">
        </label>
        <label>Analysis depth (m)
          <input type="number" step="0.5" min="${Math.max(stage6MaxDepth(), 15).toFixed(2)}" value="${bishop.analysisDepth.toFixed(2)}" onchange="stage6BishopSetField('analysisDepth', this.value)">
        </label>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          ${actionButton('Search settings', 'settings', "stage6BishopSetCanvasSheet('workspace')")}
          ${actionButton('Materials', 'materials', "stage6BishopSetCanvasSheet('materials')")}
        </div>
      </div>
    ` : `
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Core settings</div>
        <label>Analysis mode
          <select onchange="stage6BishopSetField('deformation.options.analysisType', this.value)">
            <option value="deformation"${bishop.deformation?.options?.analysisType!=='safety-cphi'?' selected':''}>Deformation</option>
            <option value="safety-cphi"${bishop.deformation?.options?.analysisType==='safety-cphi'?' selected':''}>C-phi safety</option>
          </select>
        </label>
        <label>Surface load q (kPa)
          <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)">
        </label>
        <div class="st6-canvas-card-row st6-canvas-card-row--actions">
          ${actionButton('Mechanical inputs', 'settings', "stage6BishopSetCanvasSheet('workspace')")}
          ${actionButton('Materials', 'materials', "stage6BishopSetCanvasSheet('materials')")}
        </div>
      </div>
    `}
  `;
  const resetPanel = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Clear drawn items</div>
      <div class="st6-canvas-card-grid">
        ${actionButton('Clear draft', 'clear', "stage6BishopClear('draft')", false, 'danger')}
        ${actionButton('Clear load', 'load', "stage6BishopClear('load')", false, 'danger')}
        ${actionButton('Clear drains', 'drain', "stage6BishopClear('drains')", false, 'danger')}
        ${actionButton('More reset', 'reset', "stage6BishopSetCanvasSheet('reset')", false, 'danger')}
      </div>
    </div>
  `;
  const panelBody = {
    draw:drawPanel,
    structures:structuresPanel,
    boundary:boundaryPanel,
    regions:regionsPanel,
    view:viewPanel,
    solve:solvePanel,
    reset:resetPanel
  }[activePanel] || '';
  const sheetBody = context?.canvasSheets?.[activeSheet] || '';
  return `
    <div class="st6-canvas-shell" aria-label="Canvas tools and settings">
      <div class="st6-canvas-dock" aria-label="Tool groups">
        <div class="st6-canvas-dock-group" aria-label="Model tools">
          ${panelButton('draw', 'Draw', 'terrain')}
          ${panelButton('structures', 'Structures', 'wall')}
          ${panelButton('boundary', 'Boundary conditions', 'boundary')}
          ${panelButton('regions', 'Regions', 'polygon')}
        </div>
        <div class="st6-canvas-dock-group" aria-label="Analysis tools">
          ${panelButton('solve', 'Solve', 'play')}
          ${sheetButton('workspace', 'Settings', 'settings')}
          ${sheetButton('materials', 'Materials', 'materials')}
          ${sheetButton('probe', 'Analysis', 'chart')}
        </div>
        <div class="st6-canvas-dock-group" aria-label="Utility tools">
          ${panelButton('reset', 'Reset', 'reset')}
          ${stage6BishopCanvasToolButton({label:'Hide canvas UI', icon:'eyeOff', onclick:'stage6BishopToggleCanvasTools(false)'})}
        </div>
      </div>
	      ${panelBody ? `
	        <div class="st6-canvas-card" role="dialog" aria-label="${stage6EscAttr(panelTitle)}">
          <div class="st6-canvas-card-head">
            <strong>${stage6EscAttr(panelTitle)}</strong>
            <button type="button" class="st6-canvas-card-close" onclick="stage6BishopSetCanvasPanel('')" aria-label="Close ${stage6EscAttr(panelTitle)}">${stage6BishopToolIcon('close')}</button>
          </div>
          <div class="st6-canvas-card-body" data-st6scroll-key="bishop-canvas-card-${stage6EscAttr(activePanel)}">${panelBody}</div>
	        </div>
	      ` : ''}
	      ${sheetBody ? `
        <div class="st6-canvas-sheet" role="dialog" aria-label="${stage6EscAttr(sheetTitle)}">
          <div class="st6-canvas-card-head">
            <strong>${stage6EscAttr(sheetTitle)}</strong>
            <button type="button" class="st6-canvas-card-close" onclick="stage6BishopSetCanvasSheet('')" aria-label="Close ${stage6EscAttr(sheetTitle)}">${stage6BishopToolIcon('close')}</button>
          </div>
          <div class="st6-canvas-sheet-body" data-st6scroll-key="bishop-canvas-sheet-${stage6EscAttr(activeSheet)}">${sheetBody}</div>
        </div>
      ` : ''}
    </div>
  `;
}

function stage6BishopDist(a, b){
  return Math.hypot((Number(a?.x) || 0) - (Number(b?.x) || 0), (Number(a?.y) || 0) - (Number(b?.y) || 0));
}

function stage6BishopPointInPolygon(point, polygon){
  let inside = false;
  for(let i=0, j=polygon.length-1; i<polygon.length; j=i, i+=1){
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-12) + xi);
    if(intersect) inside = !inside;
  }
  return inside;
}

function stage6BishopRegionAtPoint(model, point){
  if(!model?.regions?.length) return null;
  for(let i=model.regions.length-1;i>=0;i-=1){
    const region = model.regions[i];
    if(region.polygon?.length >= 3 && stage6BishopPointInPolygon(point, region.polygon)) return region;
  }
  return null;
}

function stage6BishopTooltipHtml(region){
  if(!region?.material) return '';
  const mat = region.material;
  const setLabel = stage6BishopStrengthSetLabel(mat.sourceStrengthSet || S.stage6.bishop.strengthSet);
  return `
    <strong>${mat.label}</strong>
    <div class="mut">${mat.sourceType || 'Soil'}${mat.sourceSubtype ? ` · ${mat.sourceSubtype}` : ''}</div>
    <div class="row"><span>Strength set</span><span>${setLabel}</span></div>
    <div class="row"><span>c'</span><span>${Number(mat.cEff || 0).toFixed(1)} kPa</span></div>
    <div class="row"><span>phi'</span><span>${Number(mat.phiEffDeg || 0).toFixed(1)}°</span></div>
    <div class="row"><span>gamma</span><span>${Number(mat.gamma || 0).toFixed(2)} kN/m³</span></div>
    <div class="row"><span>gamma_sat</span><span>${Number(mat.gammaSat || 0).toFixed(2)} kN/m³</span></div>
  `;
}

function stage6BishopRegionShortLabel(region){
  const label = String(region?.material?.label || region?.material?.id || 'Region').trim();
  const base = label.includes(' - ') ? label.split(' - ')[0] : label;
  return base.length > 18 ? `${base.slice(0, 17)}…` : base;
}

function stage6BishopPolygonCentroid(polygon){
  if(!polygon?.length) return null;
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for(let i=0;i<polygon.length;i+=1){
    const a = polygon[i];
    const b = polygon[(i+1)%polygon.length];
    const cross = a.x * b.y - b.x * a.y;
    twiceArea += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if(Math.abs(twiceArea) < 1e-9){
    const avg = polygon.reduce((acc, pt)=>{
      acc.x += pt.x;
      acc.y += pt.y;
      return acc;
    }, {x:0, y:0});
    return {
      x:avg.x / polygon.length,
      y:avg.y / polygon.length
    };
  }
  return {
    x:cx / (3 * twiceArea),
    y:cy / (3 * twiceArea)
  };
}

function stage6BishopRegionLegendItems(model){
  if(!model?.regions?.length) return [];
  const items = new Map();
  model.regions.forEach((region)=>{
    const mat = region.material || {};
    const key = mat.id || region.id;
    const item = items.get(key) || {
      id:key,
      label:mat.label || key,
      color:mat.color || '#c9b089',
      count:0,
      sourceType:mat.sourceType || 'Soil'
    };
    item.count += 1;
    items.set(key, item);
  });
  return [...items.values()];
}

function stage6BishopMeasurementMetrics(points){
  const clean = (points || [])
    .filter((pt)=>Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    .slice(0, 2);
  if(clean.length < 2) return null;
  const [a, b] = clean;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    a,
    b,
    dx,
    dy,
    length:Math.hypot(dx, dy),
    mid:{
      x:0.5 * (a.x + b.x),
      y:0.5 * (a.y + b.y)
    }
  };
}

function stage6BishopMeasurementLabel(metrics){
  if(!metrics) return 'Measure not set';
  return `L=${metrics.length.toFixed(2)} m · dx=${metrics.dx.toFixed(2)} m · dy=${metrics.dy.toFixed(2)} m`;
}

function stage6BishopLineProbeOptions(workspace, analysisType = null, hasHs = false){
  const chartBlue = readCssToken('--chart-blue', '#4F8584');
  const chartGreen = readCssToken('--chart-green', '#3D6B6A');
  const chartOrange = readCssToken('--chart-orange', '#8A620D');
  const chartRed = readCssToken('--chart-red', '#9B3A32');
  const chartPurple = readCssToken('--chart-purple', '#18181A');
  if(workspace === 'seepage'){
    return [
      {id:'head', label:'h', axisTitle:'Head h (m)', unit:'m', color:chartBlue, digits:3},
      {id:'porePressure', label:'u', axisTitle:'Pore pressure u (kPa)', unit:'kPa', color:chartBlue, digits:3},
      {id:'gradient', label:'|∇h|', axisTitle:'Hydraulic gradient |∇h| (-)', unit:'', color:chartGreen, digits:3},
      {id:'hydraulicFs', label:'FSᵢ', axisTitle:'Hydraulic safety factor FSᵢ = iᶜʳⁱᵗ / |∇h| (-)', unit:'', color:chartGreen, digits:2},
      {id:'flow', label:'|q|', axisTitle:'Specific discharge |q| (m/s)', unit:'m/s', color:readCssToken('--wn', '#BA7517'), digits:3},
      {id:'qx', label:'qₓ', axisTitle:'Specific discharge qₓ (m/s)', unit:'m/s', color:chartOrange, digits:3},
      {id:'qy', label:'qᵧ', axisTitle:'Specific discharge qᵧ (m/s)', unit:'m/s', color:chartPurple, digits:3},
      {id:'normalFlow', label:'qₙ', axisTitle:'Normal discharge qₙ (m/s)', unit:'m/s', color:chartRed, digits:3}
    ];
  }
  if(workspace === 'deformation'){
    const normalizedAnalysisType = stage6BishopNormalizedDeformationAnalysisType(analysisType);
    const colorById = {
      settlement:chartOrange,
      ux:chartBlue,
      uy:chartPurple,
      uTotal:chartRed,
      epsilonXx:chartGreen,
      epsilonYy:chartGreen,
      gammaXy:chartBlue,
      equivalentPlasticStrain:chartPurple,
      safetyEquivalentPlasticIncrement:chartPurple,
      deltaSigmaYy:readCssToken('--wn', '#BA7517'),
      sigmaYyEffInit:readCssToken('--wn', '#BA7517'),
      sigmaYyEff:chartOrange,
      sigmaYyTotalInit:chartOrange,
      sigmaYyTotal:chartRed,
      sigmaXxEffInit:chartBlue,
      sigmaXxEff:chartBlue,
      sigmaXxTotalInit:chartBlue,
      sigmaXxTotal:chartBlue,
      tauXy:chartPurple,
      mcEta:chartRed,
      hsGammaP:chartGreen,
      hsPP:chartOrange,
      hsEpsVPDilative:chartPurple,
      hsLastActiveSet:chartRed
    };
    return stage6BishopDeformationContourOptions(normalizedAnalysisType, hasHs === true).map(({id, label})=>{
      const meta = stage6BishopDeformationContourMeta(id, normalizedAnalysisType);
      return {
        id,
        label,
        axisTitle:meta.axisTitle || `${label}${meta.unit ? ` (${meta.unit})` : ''}`,
        unit:meta.unit || '',
        color:colorById[id] || chartBlue,
        digits:meta.digits || 3
      };
    });
  }
  return [];
}

function stage6BishopLineProbeMeta(workspace, quantity, analysisType = null, hasHs = false){
  const options = stage6BishopLineProbeOptions(workspace, analysisType, hasHs === true);
  return options.find((item)=>item.id === quantity) || options[0] || null;
}

function stage6BishopLineProbeFormatValue(meta, value){
  if(!Number.isFinite(value)) return '—';
  const suffix = meta?.unit ? ` ${meta.unit}` : '';
  return `${stage6CompactNumber(value, meta?.digits || 3)}${suffix}`;
}

function stage6ClipboardNumber(value){
  const n = Number(value);
  if(!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  if(abs === 0) return '0';
  if(abs < 1e-6 || abs >= 1e6) return n.toExponential(10);
  return n.toFixed(10).replace(/\.?0+$/, '');
}

function stage6BishopLineProbeClipboardValueHeader(lineProbe){
  const quantity = lineProbe?.quantity || lineProbe?.meta?.label || 'value';
  const unit = lineProbe?.meta?.unit || '';
  const slug = String(quantity)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'value';
  const unitSlug = String(unit)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return unitSlug ? `${slug}_${unitSlug}` : slug;
}

function stage6BishopLineProbeClipboardText(lineProbe){
  if(!lineProbe || lineProbe.status !== 'ready') return '';
  const valueHeader = stage6BishopLineProbeClipboardValueHeader(lineProbe);
  const rows = [
    `distance_along_line_m\t${valueHeader}`
  ];
  (lineProbe.samples || []).forEach((sample)=>{
    rows.push(`${stage6ClipboardNumber(sample?.s)}\t${stage6ClipboardNumber(sample?.value)}`);
  });
  return rows.join('\n');
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

function stage6BishopMeasurementVectors(metrics){
  const length = Math.max(metrics?.length || 0, 1e-9);
  return {
    tx:(metrics?.dx || 0) / length,
    ty:(metrics?.dy || 0) / length,
    nx:-(metrics?.dy || 0) / length,
    ny:(metrics?.dx || 0) / length
  };
}

function stage6BishopLineProbeStats(samples){
  const values = (samples || []).map((item)=>item?.value).filter(Number.isFinite);
  if(!values.length){
    return {
      min:null,
      max:null,
      mean:null,
      validCount:0
    };
  }
  const sum = values.reduce((acc, value)=>acc + value, 0);
  return {
    min:Math.min(...values),
    max:Math.max(...values),
    mean:sum / values.length,
    validCount:values.length
  };
}

function stage6BishopIntegrateLineProbe(samples, absolute){
  let total = 0;
  const items = (samples || []).filter((item)=>Number.isFinite(item?.s));
  for(let i=1;i<items.length;i+=1){
    const prev = items[i-1];
    const next = items[i];
    if(!(Number.isFinite(prev?.value) && Number.isFinite(next?.value))) continue;
    const ds = next.s - prev.s;
    if(!(ds > 0)) continue;
    const v0 = absolute ? Math.abs(prev.value) : prev.value;
    const v1 = absolute ? Math.abs(next.value) : next.value;
    total += 0.5 * (v0 + v1) * ds;
  }
  return total;
}

function stage6BishopBuildLineProbe(workspace, measurementMetrics){
  const bishop = S?.stage6?.bishop;
  const quantity = workspace === 'seepage'
    ? (bishop?.lineProbe?.seepageQuantity || 'head')
    : (bishop?.lineProbe?.deformationQuantity || 'uTotal');
  const analysisType = workspace === 'deformation'
    ? stage6BishopNormalizedDeformationAnalysisType()
    : null;
  const hasHs = workspace === 'deformation' && STAGE6_ENABLE_HARDENING_SOIL_UI && bishop?.deformation?.result?.hasHardeningSoil === true;
  const meta = stage6BishopLineProbeMeta(workspace, quantity, analysisType, hasHs);
  if(workspace !== 'seepage' && workspace !== 'deformation'){
    return {
      workspace,
      quantity,
      meta,
      status:'unsupported',
      message:'Line plots are currently available in the seepage and deformation workspaces.'
    };
  }
  if(!measurementMetrics || !(measurementMetrics.length > 1e-9)){
    return {
      workspace,
      quantity,
      meta,
      status:'missing-measurement',
      message:'Use the shared Measure tool to draw a probe line on the canvas first.'
    };
  }
  if(workspace === 'seepage' && !(bishop?.seepage?.mesh && bishop?.seepage?.result)){
    return {
      workspace,
      quantity,
      meta,
      status:'missing-result',
      message:'Run seepage first, then the measured line can plot heads, gradients, and discharge quantities.'
    };
  }
  if(workspace === 'deformation' && !(bishop?.deformation?.mesh && bishop?.deformation?.result)){
    return {
      workspace,
      quantity,
      meta,
      status:'missing-result',
      message:'Run deformation first, then the measured line can plot displacement and MC screening quantities.'
    };
  }
  const sampleCount = Math.min(Math.max(Math.round(+bishop?.lineProbe?.sampleCount || 81), 21), 201);
  const vectors = stage6BishopMeasurementVectors(measurementMetrics);
  const samples = [];
  for(let i=0;i<sampleCount;i+=1){
    const t = sampleCount <= 1 ? 0 : i / (sampleCount - 1);
    const x = measurementMetrics.a.x + t * measurementMetrics.dx;
    const y = measurementMetrics.a.y + t * measurementMetrics.dy;
    const s = t * measurementMetrics.length;
    let value = null;
    if(workspace === 'seepage'){
      if(quantity === 'head'){
        value = sampleSeepageHead(bishop.seepage.mesh, bishop.seepage.result, x, y);
      } else if(quantity === 'porePressure'){
        value = sampleSeepagePorePressure(bishop.seepage.mesh, bishop.seepage.result, x, y, 9.81);
      } else {
        const flowState = sampleSeepageFlowState(bishop.seepage.mesh, bishop.seepage.result, x, y);
        if(flowState){
          if(quantity === 'gradient'){
            value = Math.hypot(flowState.dhdx || 0, flowState.dhdy || 0);
          } else if(quantity === 'hydraulicFs'){
            const cell = bishop.seepage.mesh?.cells?.[flowState.cellIndex];
            value = stage6BishopSeepageHydraulicFs(
              Math.hypot(flowState.dhdx || 0, flowState.dhdy || 0),
              cell?.material
            );
          } else if(quantity === 'flow'){
            value = Math.hypot(flowState.qx || 0, flowState.qy || 0);
          } else if(quantity === 'qx'){
            value = flowState.qx || 0;
          } else if(quantity === 'qy'){
            value = flowState.qy || 0;
          } else if(quantity === 'normalFlow'){
            value = (flowState.qx || 0) * vectors.nx + (flowState.qy || 0) * vectors.ny;
          }
        }
      }
    } else if(workspace === 'deformation'){
      const state = sampleDeformationState(bishop.deformation.mesh, bishop.deformation.result, x, y);
      if(state){
        if(quantity === 'ux') value = 1000 * (state.ux || 0);
        else if(quantity === 'uy') value = 1000 * (state.uy || 0);
        else if(quantity === 'uTotal') value = 1000 * (state.uTotal || 0);
        else if(quantity === 'epsilonXx') value = 100 * (state.epsilonXx || 0);
        else if(quantity === 'epsilonYy') value = 100 * (state.epsilonYy || 0);
        else if(quantity === 'gammaXy') value = 100 * (state.gammaXy || 0);
        else if(quantity === 'equivalentPlasticStrain') value = 100 * (state.equivalentPlasticStrain || 0);
        else if(quantity === 'safetyEquivalentPlasticIncrement') value = 100 * (state.safetyEquivalentPlasticIncrement || 0);
        else if(quantity === 'deltaSigmaYy') value = state.deltaSigmaYy;
        else if(quantity === 'sigmaYyEffInit') value = state.sigmaYyEffInit;
        else if(quantity === 'sigmaYyEff') value = state.sigmaYyEff;
        else if(quantity === 'sigmaYyTotalInit') value = state.sigmaYyTotalInit;
        else if(quantity === 'sigmaYyTotal') value = state.sigmaYyTotal;
        else if(quantity === 'sigmaXxEffInit') value = state.sigmaXxEffInit;
        else if(quantity === 'sigmaXxEff') value = state.sigmaXxEff;
        else if(quantity === 'sigmaXxTotalInit') value = state.sigmaXxTotalInit;
        else if(quantity === 'sigmaXxTotal') value = state.sigmaXxTotal;
        else if(quantity === 'tauXy') value = state.tauXy;
        else if(quantity === 'mcEta') value = state.mcEta;
        else value = 1000 * (state.settlement || 0);
      }
    }
    samples.push({
      index:i,
      x,
      y,
      s,
      value:Number.isFinite(value) ? value : null
    });
  }
  const stats = stage6BishopLineProbeStats(samples);
  if(!stats.validCount){
    return {
      workspace,
      quantity,
      meta,
      measurement:measurementMetrics,
      samples,
      chartPoints:samples.map((item)=>({x:item.s, y:item.value})),
      stats,
      status:'no-valid-samples',
      message:'The current measurement line does not intersect the solved field inside the section domain.'
    };
  }
  const coverage = stats.validCount / sampleCount;
  return {
    workspace,
    quantity,
    meta,
    measurement:measurementMetrics,
    samples,
    chartPoints:samples.map((item)=>({x:item.s, y:item.value})),
    stats,
    status:'ready',
    coverage,
    sampleCount,
    message:coverage < 0.999
      ? 'Part of the measurement line lies outside the solved domain, so the graph includes gaps where no field value exists.'
      : '',
    netCrossFlow:workspace === 'seepage' && quantity === 'normalFlow' ? stage6BishopIntegrateLineProbe(samples, false) : null,
    absCrossFlow:workspace === 'seepage' && quantity === 'normalFlow' ? stage6BishopIntegrateLineProbe(samples, true) : null
  };
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
  const bishop = S?.stage6?.bishop;
  if(!model || !bishop) return [];
  const customRegions = model.customRegions || [];
  if(customRegions.length) return customRegions;
  return model.regions || [];
}

function stage6BishopShowingCustomRegionPreview(model){
  return !!(model?.customRegions?.length) && model.regionMode !== 'custom';
}

function stage6BishopPolygonIsValid(polygon){
  return Array.isArray(polygon) && polygon.length >= 3 && polygonArea(polygon) > 1e-4 && isSimplePolygon(polygon);
}

function stage6BishopSegmentOrientation(a, b, c){
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function stage6BishopSegmentsIntersectClosed(a, b, c, d, tol = 1e-6){
  const o1 = stage6BishopSegmentOrientation(a, b, c);
  const o2 = stage6BishopSegmentOrientation(a, b, d);
  const o3 = stage6BishopSegmentOrientation(c, d, a);
  const o4 = stage6BishopSegmentOrientation(c, d, b);

  if(Math.abs(o1) <= tol && stage6BishopPointOnSegment(c, a, b, tol)) return true;
  if(Math.abs(o2) <= tol && stage6BishopPointOnSegment(d, a, b, tol)) return true;
  if(Math.abs(o3) <= tol && stage6BishopPointOnSegment(a, c, d, tol)) return true;
  if(Math.abs(o4) <= tol && stage6BishopPointOnSegment(b, c, d, tol)) return true;

  return (
    ((o1 > tol && o2 < -tol) || (o1 < -tol && o2 > tol)) &&
    ((o3 > tol && o4 < -tol) || (o3 < -tol && o4 > tol))
  );
}

function stage6BishopValidateHolePolygon(parentRegion, polygon){
  const parentPolygon = parentRegion?.polygon || [];
  const holePolygon = normalizeRegionPolygon(polygon || []);
  if(parentPolygon.length < 3) return {ok:false, message:'Select a valid custom polygon before cutting a hole.'};
  if(holePolygon.length < 3 || !(polygonArea(holePolygon) > 1e-4)){
    return {ok:false, message:'Draw at least three distinct points for the hole polygon.'};
  }
  if(!isSimplePolygon(holePolygon)){
    return {ok:false, message:'Hole polygons must be simple non-self-intersecting closed shapes.'};
  }
  if(holePolygon.some((pt)=>parentPolygon.some((_, index)=>stage6BishopPointOnSegment(pt, parentPolygon[index], parentPolygon[(index + 1) % parentPolygon.length], 1e-6)))){
    return {ok:false, message:'The hole polygon must stay strictly inside the selected custom polygon.'};
  }
  if(holePolygon.some((pt)=>!stage6BishopPointInPolygon(pt, parentPolygon))){
    return {ok:false, message:'The hole polygon must stay strictly inside the selected custom polygon.'};
  }
  for(let i=0;i<holePolygon.length;i+=1){
    const a = holePolygon[i];
    const b = holePolygon[(i + 1) % holePolygon.length];
    for(let j=0;j<parentPolygon.length;j+=1){
      const c = parentPolygon[j];
      const d = parentPolygon[(j + 1) % parentPolygon.length];
      if(stage6BishopSegmentsIntersectClosed(a, b, c, d)){
        return {ok:false, message:'The hole polygon must stay strictly inside the selected custom polygon.'};
      }
    }
  }
  return {ok:true, polygon:holePolygon};
}

function stage6BishopPointOnSegment(point, a, b, tol = 1e-6){
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const len2 = abx*abx + aby*aby;
  if(len2 <= 1e-12) return stage6BishopDist(point, a) <= tol;
  const cross = Math.abs(apx*aby - apy*abx);
  if(cross > tol * Math.max(1, Math.sqrt(len2))) return false;
  const dot = apx*abx + apy*aby;
  return dot >= -tol && dot <= len2 + tol;
}

function stage6BishopPointInsideOrBoundary(point, polygon){
  if(stage6BishopPointInPolygon(point, polygon)) return true;
  for(let i=0;i<polygon.length;i+=1){
    const a = polygon[i];
    const b = polygon[(i+1)%polygon.length];
    if(stage6BishopPointOnSegment(point, a, b, 1e-4)) return true;
  }
  return false;
}

function stage6BishopClosestPointOnSegment(point, a, b){
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx*dx + dy*dy;
  const t = len2 > 1e-12 ? Math.min(Math.max(((point.x - a.x)*dx + (point.y - a.y)*dy) / len2, 0), 1) : 0;
  return {
    point:stage6BishopClampRegionPoint({x:a.x + dx*t, y:a.y + dy*t}),
    t,
    distance:Math.hypot(point.x - (a.x + dx*t), point.y - (a.y + dy*t))
  };
}

function stage6BishopBoundaryPickToleranceWorld(){
  return stage6BishopSnapToleranceWorld();
}

function stage6BishopPickRegionBoundaryPoint(region, world){
  const polygon = region?.polygon || [];
  if(polygon.length < 3) return null;
  let best = null;
  for(let i=0;i<polygon.length;i+=1){
    const a = polygon[i];
    const b = polygon[(i+1)%polygon.length];
    const projected = stage6BishopClosestPointOnSegment(world, a, b);
    if(!best || projected.distance < best.distance){
      best = {
        ...projected,
        edgeIndex:i
      };
    }
  }
  if(!best || best.distance > stage6BishopBoundaryPickToleranceWorld()) return null;
  const polygonLength = polygon.length;
  const nearVertexTol = 1e-3;
  if(best.t <= nearVertexTol){
    return {
      x:stage6BishopRoundRegionCoord(polygon[best.edgeIndex].x),
      y:stage6BishopRoundRegionCoord(polygon[best.edgeIndex].y),
      edgeIndex:best.edgeIndex,
      vertexIndex:best.edgeIndex,
      t:0
    };
  }
  if(best.t >= 1 - nearVertexTol){
    const vertexIndex = (best.edgeIndex + 1) % polygonLength;
    return {
      x:stage6BishopRoundRegionCoord(polygon[vertexIndex].x),
      y:stage6BishopRoundRegionCoord(polygon[vertexIndex].y),
      edgeIndex:best.edgeIndex,
      vertexIndex,
      t:1
    };
  }
  return {
    x:best.point.x,
    y:best.point.y,
    edgeIndex:best.edgeIndex,
    vertexIndex:null,
    t:best.t
  };
}

function stage6BishopTraverseBoundary(boundary, startIndex, endIndex){
  const out = [];
  let index = startIndex;
  while(true){
    out.push(stage6BishopClampRegionPoint(boundary[index]));
    if(index === endIndex) break;
    index = (index + 1) % boundary.length;
    if(out.length > boundary.length + 2) return [];
  }
  return out;
}

function stage6BishopBuildSplitBoundary(polygon, cuts){
  const insertionsByEdge = new Map();
  const cutNamesByVertex = new Map();
  cuts.forEach((cut)=>{
    if(Number.isInteger(cut.vertexIndex)){
      const names = cutNamesByVertex.get(cut.vertexIndex) || [];
      names.push(cut.name);
      cutNamesByVertex.set(cut.vertexIndex, names);
      return;
    }
    const insertions = insertionsByEdge.get(cut.edgeIndex) || [];
    insertions.push(cut);
    insertionsByEdge.set(cut.edgeIndex, insertions);
  });
  const boundary = [];
  const cutIndices = {};
  for(let i=0;i<polygon.length;i+=1){
    boundary.push(stage6BishopClampRegionPoint(polygon[i]));
    (cutNamesByVertex.get(i) || []).forEach((name)=>{
      cutIndices[name] = boundary.length - 1;
    });
    const insertions = (insertionsByEdge.get(i) || []).slice().sort((a, b)=>a.t - b.t);
    insertions.forEach((cut)=>{
      const pt = stage6BishopClampRegionPoint(cut);
      if(stage6BishopDist(boundary[boundary.length - 1], pt) > 1e-6){
        boundary.push(pt);
      }
      cutIndices[cut.name] = boundary.length - 1;
    });
  }
  return {boundary, cutIndices};
}

function stage6BishopUniqueSortedNumbers(values, tol = 1e-6){
  const sorted = [...values].filter((value)=>Number.isFinite(value)).sort((a, b)=>a - b);
  const out = [];
  sorted.forEach((value)=>{
    if(!out.length || Math.abs(value - out[out.length - 1]) > tol) out.push(value);
  });
  return out;
}

function stage6BishopBoundaryYAtX(boundary, x){
  const polygon = boundary?.polygon || [];
  const a = polygon?.[boundary?.edgeIndex];
  const b = polygon?.[(boundary?.edgeIndex + 1) % polygon.length];
  if(!a || !b) return NaN;
  if(Math.abs((b.x - a.x) || 0) <= 1e-9) return +a.y.toFixed(6);
  return +(a.y + ((x - a.x) * (b.y - a.y)) / (b.x - a.x)).toFixed(6);
}

function stage6BishopPolygonIntervalsDetailed(polygon, x){
  const pts = normalizeRegionPolygon(polygon || []);
  if(pts.length < 3) return [];
  const hits = [];
  for(let i=0;i<pts.length;i+=1){
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    if(Math.abs(dx) <= 1e-9) continue;
    if(x <= minX + 1e-9 || x >= maxX - 1e-9) continue;
    const t = (x - a.x) / dx;
    if(t <= 1e-9 || t >= 1 - 1e-9) continue;
    hits.push({
      y:a.y + (b.y - a.y) * t,
      edgeIndex:i
    });
  }
  hits.sort((left, right)=>left.y - right.y);
  const intervals = [];
  for(let i=0;i+1<hits.length;i+=2){
    const low = hits[i];
    const high = hits[i + 1];
    if(!(high.y > low.y + 1e-6)) continue;
    intervals.push({
      yBottom:low.y,
      yTop:high.y,
      bottomBoundary:{polygon:pts, edgeIndex:low.edgeIndex},
      topBoundary:{polygon:pts, edgeIndex:high.edgeIndex}
    });
  }
  return intervals;
}

function stage6BishopSubtractDetailedIntervals(parentIntervals, holeIntervals){
  const out = [];
  (parentIntervals || []).forEach((parentInterval)=>{
    let segments = [{
      yBottom:parentInterval.yBottom,
      yTop:parentInterval.yTop,
      bottomBoundary:parentInterval.bottomBoundary,
      topBoundary:parentInterval.topBoundary
    }];
    (holeIntervals || []).forEach((holeInterval)=>{
      const nextSegments = [];
      segments.forEach((segment)=>{
        const overlapBottom = Math.max(segment.yBottom, holeInterval.yBottom);
        const overlapTop = Math.min(segment.yTop, holeInterval.yTop);
        if(!(overlapTop > overlapBottom + 1e-6)){
          nextSegments.push(segment);
          return;
        }
        if(overlapBottom > segment.yBottom + 1e-6){
          nextSegments.push({
            yBottom:segment.yBottom,
            yTop:overlapBottom,
            bottomBoundary:segment.bottomBoundary,
            topBoundary:holeInterval.bottomBoundary
          });
        }
        if(overlapTop < segment.yTop - 1e-6){
          nextSegments.push({
            yBottom:overlapTop,
            yTop:segment.yTop,
            bottomBoundary:holeInterval.topBoundary,
            topBoundary:segment.topBoundary
          });
        }
      });
      segments = nextSegments;
    });
    out.push(...segments.filter((segment)=>segment.yTop > segment.yBottom + 1e-6));
  });
  return out;
}

function stage6BishopSubtractHoleFromPolygon(parentPolygon, holePolygon){
  const parent = normalizeRegionPolygon(parentPolygon || []);
  const hole = normalizeRegionPolygon(holePolygon || []);
  if(parent.length < 3 || hole.length < 3) return [];
  const xBreaks = stage6BishopUniqueSortedNumbers([
    ...parent.map((pt)=>pt.x),
    ...hole.map((pt)=>pt.x)
  ]);
  const pieces = [];
  for(let i=0;i<xBreaks.length - 1;i+=1){
    const xL = xBreaks[i];
    const xR = xBreaks[i + 1];
    if(!(xR > xL + 1e-6)) continue;
    const xMid = 0.5 * (xL + xR);
    const parentIntervals = stage6BishopPolygonIntervalsDetailed(parent, xMid);
    const holeIntervals = stage6BishopPolygonIntervalsDetailed(hole, xMid);
    const visibleIntervals = stage6BishopSubtractDetailedIntervals(parentIntervals, holeIntervals);
    visibleIntervals.forEach((interval)=>{
      const leftBottom = stage6BishopClampRegionPoint({x:xL, y:stage6BishopBoundaryYAtX(interval.bottomBoundary, xL)});
      const leftTop = stage6BishopClampRegionPoint({x:xL, y:stage6BishopBoundaryYAtX(interval.topBoundary, xL)});
      const rightTop = stage6BishopClampRegionPoint({x:xR, y:stage6BishopBoundaryYAtX(interval.topBoundary, xR)});
      const rightBottom = stage6BishopClampRegionPoint({x:xR, y:stage6BishopBoundaryYAtX(interval.bottomBoundary, xR)});
      const piece = normalizeRegionPolygon([leftBottom, leftTop, rightTop, rightBottom]);
      if(stage6BishopPolygonIsValid(piece)){
        pieces.push(piece);
      }
    });
  }
  return pieces;
}

function stage6BishopSplitRegionPolygon(region, cutA, cutB){
  const polygon = region?.polygon || [];
  if(polygon.length < 3) return {ok:false, message:'Select a valid polygon before splitting it.'};
  if(stage6BishopDist(cutA, cutB) <= 1e-4){
    return {ok:false, message:'Choose two distinct points on the selected polygon boundary to split it.'};
  }
  const chordSamples = [0.25, 0.5, 0.75].every((t)=>{
    const point = {
      x:cutA.x + (cutB.x - cutA.x)*t,
      y:cutA.y + (cutB.y - cutA.y)*t
    };
    return stage6BishopPointInsideOrBoundary(point, polygon);
  });
  if(!chordSamples){
    return {ok:false, message:'The split line must stay inside the selected polygon.'};
  }
  const {boundary, cutIndices} = stage6BishopBuildSplitBoundary(polygon, [
    {...cutA, name:'a'},
    {...cutB, name:'b'}
  ]);
  const indexA = cutIndices.a;
  const indexB = cutIndices.b;
  if(indexA == null || indexB == null || indexA === indexB){
    return {ok:false, message:'Choose two separate polygon-boundary points to split the polygon.'};
  }
  const polygonA = normalizeRegionPolygon(stage6BishopTraverseBoundary(boundary, indexA, indexB));
  const polygonB = normalizeRegionPolygon(stage6BishopTraverseBoundary(boundary, indexB, indexA));
  if(!stage6BishopPolygonIsValid(polygonA) || !stage6BishopPolygonIsValid(polygonB)){
    return {ok:false, message:'That split would create an invalid polygon. Try points on different edges.'};
  }
  const originalArea = polygonArea(polygon);
  const splitArea = polygonArea(polygonA) + polygonArea(polygonB);
  const areaTolerance = Math.max(0.01, originalArea * 1e-4);
  if(Math.abs(splitArea - originalArea) > areaTolerance){
    return {ok:false, message:'That split falls outside the polygon. Try a cut line that stays inside the region.'};
  }
  return {
    ok:true,
    polygons:[polygonA, polygonB]
  };
}

function stage6BishopHideHoverDom(){
  const tip = document.getElementById('stage6BishopTip');
  const coord = document.getElementById('stage6BishopCoord');
  if(tip) tip.style.display = 'none';
  if(coord) coord.textContent = '';
}

function stage6BishopUpdateHoverDom(canvas, clientX, clientY){
  const coord = document.getElementById('stage6BishopCoord');
  const tip = document.getElementById('stage6BishopTip');
  const model = S.stage6Cache.bishopModel || stage6BishopCurrentModel();
  const world = stage6BishopScreenToWorld(canvas, clientX, clientY);
  const snapped = stage6BishopSnapWorldPoint(world, 'free');
  stage6BishopCanvasState.hoverWorld = world;
  if(coord){
    const snapEnabled = S.stage6.bishop.gridSnap || S.stage6.bishop.pointSnap;
    coord.textContent = `x = ${world.x.toFixed(2)} m · y = ${world.y.toFixed(2)} m${snapEnabled ? ` · snap ${snapped.x.toFixed(2)}, ${snapped.y.toFixed(2)} m` : ''}`;
  }
  if(!tip || !model){
    stage6BishopDrawCanvas();
    return;
  }
  const load = stage6BishopPickSurfaceLoadAtWorld(world);
  const hoveredWall = !load && S.stage6.bishop.workspace === 'deformation'
    ? stage6BishopPickWallAtWorld(world)
    : null;
  const hoveredWallResult = hoveredWall ? stage6BishopWallResultForId(hoveredWall.id) : null;
  const hoveredWallMeta = hoveredWallResult
    ? stage6BishopWallQuantityStats(hoveredWallResult, stage6BishopWallOverlayQuantity())
    : null;
  const region = !load && !hoveredWall ? stage6BishopRegionAtPoint({regions:stage6BishopDisplayRegions(model)}, world) : null;
  if(load){
    const wrap = canvas.parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    tip.innerHTML = `
      <div style="font-weight:700;margin-bottom:4px">${stage6EscAttr(load.label || load.id || 'Surface load')}</div>
      <div>${stage6EscAttr(stage6BishopSurfaceLoadSummary(load, S.stage6.bishop.workspace))}</div>
      <div style="color:var(--tx2);margin-top:4px">Click to edit · drag endpoints when selected</div>
    `;
    tip.style.display = 'block';
    tip.style.left = `${Math.min(Math.max(clientX - wrapRect.left + 16, 12), Math.max(wrapRect.width - 292, 12))}px`;
    tip.style.top = `${Math.min(Math.max(clientY - wrapRect.top + 16, 12), Math.max(wrapRect.height - 180, 12))}px`;
  } else if(hoveredWall){
    const wrap = canvas.parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    const wallIndex = (S.stage6.bishop.walls || []).findIndex((wall)=>wall.id === hoveredWall.id);
    const meta = hoveredWallMeta?.meta || stage6BishopWallResponseMeta(stage6BishopWallOverlayQuantity());
    tip.innerHTML = `
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
    tip.style.display = 'block';
    tip.style.left = `${Math.min(Math.max(clientX - wrapRect.left + 16, 12), Math.max(wrapRect.width - 292, 12))}px`;
    tip.style.top = `${Math.min(Math.max(clientY - wrapRect.top + 16, 12), Math.max(wrapRect.height - 180, 12))}px`;
  } else if(region){
    const wrap = canvas.parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    tip.innerHTML = stage6BishopTooltipHtml(region);
    tip.style.display = 'block';
    tip.style.left = `${Math.min(Math.max(clientX - wrapRect.left + 16, 12), Math.max(wrapRect.width - 292, 12))}px`;
    tip.style.top = `${Math.min(Math.max(clientY - wrapRect.top + 16, 12), Math.max(wrapRect.height - 180, 12))}px`;
  } else {
    tip.style.display = 'none';
  }
  stage6BishopDrawCanvas();
}

function stage6BishopScreenToWorld(canvas, clientX, clientY){
  const rect = canvas.getBoundingClientRect();
  const bishop = S.stage6.bishop;
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  return {
    x:(sx - bishop.viewport.offsetX) / bishop.viewport.scale,
    y:(bishop.viewport.offsetY - sy) / bishop.viewport.scale
  };
}

function stage6BishopWorldToScreen(pt){
  const bishop = S.stage6.bishop;
  return {
    x:pt.x * bishop.viewport.scale + bishop.viewport.offsetX,
    y:bishop.viewport.offsetY - pt.y * bishop.viewport.scale
  };
}

function stage6BishopSnapToleranceWorld(){
  const scale = Math.max(S?.stage6?.bishop?.viewport?.scale || 24, 1);
  return 14 / scale;
}

function stage6BishopCurrentDragKey(){
  const drag = stage6BishopCanvasState.pointerDrag;
  if(!drag) return '';
  const index = drag.kind === 'drainVertex' ? drag.vertexIndex : drag.index;
  return `${drag.kind}:${drag.regionId || drag.loadId || ''}:${Number.isFinite(index) ? index : ''}`;
}

function stage6BishopSnapPointKey(kind, index, regionId){
  return `${kind}:${regionId || ''}:${Number.isFinite(index) ? index : ''}`;
}

function stage6BishopCollectSnapPoints(){
  const bishop = S.stage6.bishop;
  const points = [];
  const seen = new Set();
  const excludeKey = stage6BishopCurrentDragKey();
  const pushPoint = (kind, pt, index = null, regionId = null)=>{
    const x = Number(pt?.x);
    const y = Number(pt?.y);
    if(!Number.isFinite(x) || !Number.isFinite(y)) return;
    if(stage6BishopSnapPointKey(kind, index, regionId) === excludeKey) return;
    const coordKey = `${x.toFixed(4)}:${y.toFixed(4)}`;
    if(seen.has(coordKey)) return;
    seen.add(coordKey);
    points.push({x, y});
  };
  (bishop.terrain || []).forEach((pt, index)=>pushPoint('terrain', pt, index));
  (bishop.phreatic || []).forEach((pt, index)=>pushPoint('phreatic', pt, index));
  if(Number.isFinite(bishop.activeCptX) && bishop.terrain.length >= 2){
    pushPoint('cpt', {
      x:bishop.activeCptX,
      y:bishopTerrainY({vertices:bishop.terrain}, bishop.activeCptX)
    });
  }
  if(bishop.entryZone && bishop.terrain.length >= 2){
    pushPoint('entryStart', {x:bishop.entryZone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, bishop.entryZone.xStart)});
    pushPoint('entryEnd', {x:bishop.entryZone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, bishop.entryZone.xEnd)});
  }
  if(bishop.exitZone && bishop.terrain.length >= 2){
    pushPoint('exitStart', {x:bishop.exitZone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, bishop.exitZone.xStart)});
    pushPoint('exitEnd', {x:bishop.exitZone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, bishop.exitZone.xEnd)});
  }
  const selectedLoadForSnap = stage6BishopSelectedSurfaceLoad()
    || ((bishop.surfaceLoads || []).length === 1 ? bishop.surfaceLoads[0] : null);
  if(stage6BishopValidZone(selectedLoadForSnap) && bishop.terrain.length >= 2){
    pushPoint('loadStart', {x:selectedLoadForSnap.xStart, y:bishopTerrainY({vertices:bishop.terrain}, selectedLoadForSnap.xStart)}, null, selectedLoadForSnap.id);
    pushPoint('loadEnd', {x:selectedLoadForSnap.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, selectedLoadForSnap.xEnd)}, null, selectedLoadForSnap.id);
  }
  (bishop.walls || []).forEach((wall, index)=>{
    const endpoints = wallEndpoints(wall);
    if(!endpoints) return;
    pushPoint('wallTop', endpoints.head, index);
    pushPoint('wallTip', endpoints.tip, index);
  });
  (bishop.drains || []).forEach((drain)=>{
    (drain.vertices || []).forEach((pt, index)=>pushPoint('drainVertex', pt, index, drain.id));
  });
  (bishop.customRegions || []).forEach((region)=>{
    (region.polygon || []).forEach((pt, index)=>pushPoint('regionVertex', pt, index, region.id));
  });
  return points;
}

function stage6BishopNearestPointSnap(pt, mode){
  const tolerance = stage6BishopSnapToleranceWorld();
  let best = null;
  stage6BishopCollectSnapPoints().forEach((candidate)=>{
    const distance = mode === 'terrain-x'
      ? Math.abs(candidate.x - pt.x)
      : stage6BishopDist(candidate, pt);
    if(distance > tolerance) return;
    if(!best || distance < best.distance){
      best = {
        distance,
        point:mode === 'terrain-x'
          ? {x:candidate.x, y:pt.y}
          : {x:candidate.x, y:candidate.y}
      };
    }
  });
  return best;
}

function stage6BishopSnapWorldPoint(pt, mode){
  const bishop = S.stage6.bishop;
  const grid = Math.max(bishop.snapSize || 0.5, 0.05);
  const candidates = [];
  if(bishop.gridSnap){
    const gridPoint = {...pt};
    gridPoint.x = Math.round(gridPoint.x / grid) * grid;
    if(mode !== 'terrain-x'){
      gridPoint.y = Math.round(gridPoint.y / grid) * grid;
    }
    candidates.push({
      point:gridPoint,
      distance:mode === 'terrain-x' ? Math.abs(gridPoint.x - pt.x) : stage6BishopDist(gridPoint, pt)
    });
  }
  if(bishop.pointSnap){
    const pointCandidate = stage6BishopNearestPointSnap(pt, mode);
    if(pointCandidate) candidates.push(pointCandidate);
  }
  if(!candidates.length) return {...pt};
  candidates.sort((a, b)=>a.distance - b.distance);
  return {...candidates[0].point};
}

function stage6BishopCanvasWorldBounds(model){
  const bishop = S.stage6.bishop;
  const terrain = stage6BishopSortedPolyline(bishop.terrain);
  if(terrain.length >= 2){
    const xs = terrain.map(pt=>pt.x);
    const ys = terrain.map(pt=>pt.y);
    (bishop.walls || []).forEach((wall)=>{
      const endpoints = wallEndpoints(wall);
      if(!endpoints) return;
      xs.push(endpoints.head.x, endpoints.tip.x);
      ys.push(endpoints.head.y, endpoints.tip.y);
    });
    (bishop.drains || []).forEach((drain)=>{
      (drain.vertices || []).forEach((point)=>{
        if(Number.isFinite(point?.x)) xs.push(point.x);
        if(Number.isFinite(point?.y)) ys.push(point.y);
      });
    });
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);
    const minY = model ? model.analysisBottomY : (maxY - Math.max(+bishop.analysisDepth || 15, 1));
    return {minX, maxX, minY, maxY};
  }
  return {minX:0, maxX:20, minY:-10, maxY:5};
}

function fitStage6BishopViewport(){
  ensureStage6State();
  const canvas = document.getElementById('stage6BishopCanvas');
  if(!canvas) return;
  const model = stage6BishopCurrentModel();
  const rect = canvas.getBoundingClientRect();
  const bounds = stage6BishopCanvasWorldBounds(model);
  const width = Math.max(rect.width, 100);
  const height = Math.max(rect.height, 100);
  const dx = Math.max(bounds.maxX - bounds.minX, 1);
  const dy = Math.max(bounds.maxY - bounds.minY, 1);
  const margin = 28;
  const scale = Math.max(Math.min((width - 2*margin)/dx, (height - 2*margin)/dy), 8);
  const cx = 0.5*(bounds.minX + bounds.maxX);
  const cy = 0.5*(bounds.minY + bounds.maxY);
  S.stage6.bishop.viewport.scale = scale;
  S.stage6.bishop.viewport.offsetX = width*0.5 - cx*scale;
  S.stage6.bishop.viewport.offsetY = height*0.5 + cy*scale;
  S.stage6.bishop.viewport.fitted = true;
  stage6BishopDrawCanvas();
}

function stage6BishopAutoFitViewportIfNeeded(){
  if(!S.stage6.bishop.viewport.fitted) fitStage6BishopViewport();
}

function stage6BishopNearestHandle(canvas, clientX, clientY){
  const bishop = S.stage6.bishop;
  const handles = [];
  const screenDist = (pt)=>{
    const scr = stage6BishopWorldToScreen(pt);
    return Math.hypot(scr.x - (clientX - canvas.getBoundingClientRect().left), scr.y - (clientY - canvas.getBoundingClientRect().top));
  };
  bishop.terrain.forEach((pt, index)=>handles.push({kind:'terrain', index, pt}));
  bishop.phreatic.forEach((pt, index)=>handles.push({kind:'phreatic', index, pt}));
  if(Number.isFinite(bishop.activeCptX) && bishop.terrain.length >= 2){
    handles.push({kind:'cpt', pt:{x:bishop.activeCptX, y:bishopTerrainY({vertices:bishop.terrain}, bishop.activeCptX)}});
  }
  if(bishop.entryZone){
    handles.push({kind:'entryStart', pt:{x:bishop.entryZone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, bishop.entryZone.xStart)}});
    handles.push({kind:'entryEnd', pt:{x:bishop.entryZone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, bishop.entryZone.xEnd)}});
  }
  if(bishop.exitZone){
    handles.push({kind:'exitStart', pt:{x:bishop.exitZone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, bishop.exitZone.xStart)}});
    handles.push({kind:'exitEnd', pt:{x:bishop.exitZone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, bishop.exitZone.xEnd)}});
  }
  const selectedLoadForHandles = stage6BishopSelectedSurfaceLoad()
    || ((bishop.surfaceLoads || []).length === 1 ? bishop.surfaceLoads[0] : null);
  if(stage6BishopValidZone(selectedLoadForHandles)){
    handles.push({kind:'loadStart', loadId:selectedLoadForHandles.id, pt:{x:selectedLoadForHandles.xStart, y:bishopTerrainY({vertices:bishop.terrain}, selectedLoadForHandles.xStart)}});
    handles.push({kind:'loadEnd', loadId:selectedLoadForHandles.id, pt:{x:selectedLoadForHandles.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, selectedLoadForHandles.xEnd)}});
  }
  (bishop.walls || []).forEach((wall, index)=>{
    const endpoints = wallEndpoints(wall);
    if(!endpoints) return;
    handles.push({kind:'wallTop', index, pt:endpoints.head});
    handles.push({kind:'wallTip', index, pt:endpoints.tip});
  });
  (bishop.drains || []).forEach((drain, drainIndex)=>{
    (drain.vertices || []).forEach((pt, vertexIndex)=>{
      handles.push({kind:'drainVertex', index:drainIndex, vertexIndex, regionId:drain.id, pt});
    });
  });
  if((bishop.customRegions || []).length){
    const selectedRegion = stage6BishopSelectedCustomRegion();
    (selectedRegion?.polygon || []).forEach((pt, index)=>{
      handles.push({kind:'regionVertex', regionId:selectedRegion.id, index, pt});
    });
  }
  let best = null;
  handles.forEach((handle)=>{
    const d = screenDist(handle.pt);
    if(d <= 12 && (!best || d < best.distance)){
      best = {...handle, distance:d};
    }
  });
  return best;
}

function stage6BishopPickSurfaceLoadAtWorld(world){
  const bishop = S.stage6.bishop;
  if(!world || !bishop?.terrain?.length) return null;
  const tolerance = stage6BishopSnapToleranceWorld();
  const terrain = {vertices:bishop.terrain};
  const loads = [...(bishop.surfaceLoads || [])].reverse();
  for(const load of loads){
    if(!stage6BishopValidZone(load)) continue;
    const xStart = Math.min(load.xStart, load.xEnd);
    const xEnd = Math.max(load.xStart, load.xEnd);
    if(world.x < xStart - tolerance || world.x > xEnd + tolerance) continue;
    const xProbe = Math.min(Math.max(world.x, xStart), xEnd);
    const ySurface = bishopTerrainY(terrain, xProbe);
    const height = Math.max(0.8, 22 / Math.max(bishop.viewport.scale || 24, 1));
    if(world.y >= ySurface - tolerance && world.y <= ySurface + height + tolerance){
      return load;
    }
  }
  return null;
}

function stage6BishopPickWallAtWorld(world){
  const bishop = S.stage6.bishop;
  if(!world) return null;
  const tolerance = stage6BishopSnapToleranceWorld();
  let best = null;
  (bishop.walls || []).forEach((wall)=>{
    const endpoints = wallEndpoints(wall);
    if(!endpoints) return;
    const distance = wallPointSegmentDistance(world, endpoints.head, endpoints.tip);
    if(distance <= tolerance && (!best || distance < best.distance)){
      best = {wall, distance};
    }
  });
  return best?.wall || null;
}

function stage6BishopCommitDrawPoint(canvas, world){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  const tool = bishop.tool;
  if(tool === 'seepageBc'){
    const model = S.stage6Cache?.bishopModel || stage6BishopCurrentModel();
    const boundary = S.stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model);
    const picked = pickSeepageBoundaryEdge(boundary, world, stage6BishopSnapToleranceWorld());
    if(!picked?.edge){
      bishop.progress.message = 'Click near an outer-boundary edge to assign a seepage boundary condition.';
      renderStage6();
      return;
    }
    stage6BishopSelectSeepageBoundary(picked.edge.edgeKey);
    return;
  }
  if(tool === 'terrain' || tool === 'phreatic'){
    const snapped = stage6BishopSnapWorldPoint(world, 'free');
    const next = [...bishop.draft];
    // Permit a vertical drop (same x, different y); reject only a backwards move or a duplicate point.
    const prevPt = next[next.length-1];
    if(prevPt && (snapped.x < prevPt.x - 1e-6 || Math.hypot(snapped.x-prevPt.x, snapped.y-prevPt.y) <= 1e-6)) return;
    next.push(snapped);
    bishop.draft = next;
    bishop.draftKind = tool;
    renderStage6();
    return;
  }
  if(tool === 'drain'){
    if(bishop.terrain.length < 2) return;
    const snapped = stage6BishopSnapWorldPoint(world, 'free');
    const next = [...bishop.draft];
    if(next.length && stage6BishopDist(snapped, next[next.length - 1]) <= 1e-6) return;
    if(bishop.draftKind !== 'drain' || !next.length){
      bishop.draft = [snapped];
      bishop.draftKind = 'drain';
      bishop.progress.message = 'Drain start set. Click the end point to create the drain.';
      renderStage6();
      return;
    }
    if(stage6BishopCreateDrainFromVertices([next[0], snapped])){
      bishop.draft = [];
      bishop.draftKind = '';
    }
    renderStage6();
    return;
  }
  if(tool === 'region' || tool === 'regionHole'){
    if(bishop.terrain.length < 2) return;
    if(tool === 'regionHole' && !stage6BishopSelectedCustomRegion()){
      bishop.progress.message = 'Select a custom polygon first in Edit / pan mode, then choose Cut hole.';
      renderStage6();
      return;
    }
    const snapped = stage6BishopSnapWorldPoint(world, 'free');
    const next = [...bishop.draft];
    if(next.length && stage6BishopDist(snapped, next[next.length - 1]) <= 1e-6) return;
    if(next.length >= 3 && stage6BishopDist(snapped, next[0]) <= Math.max(bishop.snapSize || 0.5, 0.25)){
      stage6BishopFinishDraft();
      return;
    }
    next.push(snapped);
    bishop.draft = next;
    bishop.draftKind = tool;
    renderStage6();
    return;
  }
  if(tool === 'regionSplit'){
    const region = stage6BishopSelectedCustomRegion();
    if(!region){
      bishop.progress.message = 'Select a custom polygon first in Edit / pan mode, then choose Split selected.';
      renderStage6();
      return;
    }
    const cutPoint = stage6BishopPickRegionBoundaryPoint(region, world);
    if(!cutPoint){
      bishop.progress.message = 'Click near the selected polygon boundary to place a split point.';
      renderStage6();
      return;
    }
    if(bishop.draftKind !== 'regionSplit' || bishop.draft.length >= 2){
      bishop.draft = [cutPoint];
      bishop.draftKind = 'regionSplit';
      renderStage6();
      return;
    }
    if(stage6BishopDist(bishop.draft[0], cutPoint) <= Math.max((bishop.snapSize || 0.5) * 0.25, 0.05)){
      bishop.progress.message = 'Choose a second boundary point away from the first one to split the polygon.';
      renderStage6();
      return;
    }
    bishop.draft = [bishop.draft[0], cutPoint];
    bishop.draftKind = 'regionSplit';
    stage6BishopSplitSelectedRegion();
    return;
  }
  if(tool === 'cpt'){
    if(bishop.terrain.length < 2) return;
    const x = stage6BishopSnapWorldPoint(world, 'terrain-x').x;
    const terrain = {vertices:bishop.terrain};
    bishop.activeCptX = Math.min(Math.max(x, bishop.terrain[0].x), bishop.terrain[bishop.terrain.length-1].x);
    stage6BishopInvalidate('Active CPT position updated; rerun Bishop search.');
    renderStage6();
    return;
  }
  if(tool === 'measure'){
    const snapped = stage6BishopSnapWorldPoint(world, 'free');
    const points = (bishop.measurement?.points || []).slice(0, 2);
    if(points.length !== 1){
      bishop.measurement = {points:[snapped]};
    } else if(stage6BishopDist(points[0], snapped) > 1e-6){
      bishop.measurement = {points:[points[0], snapped]};
    }
    renderStage6();
    return;
  }
	  if(tool === 'entry' || tool === 'exit' || tool === 'load'){
	    if(bishop.terrain.length < 2) return;
    const x = stage6BishopSnapWorldPoint(world, 'terrain-x').x;
    const terrain = {vertices:bishop.terrain};
    const minX = bishop.terrain[0].x;
    const maxX = bishop.terrain[bishop.terrain.length-1].x;
    const clampedX = Math.min(Math.max(x, minX), maxX);
    if(bishop.draftKind !== tool || bishop.draft.length >= 2){
      bishop.draft = [{x:clampedX, y:bishopTerrainY(terrain, clampedX)}];
      bishop.draftKind = tool;
	    } else {
	      const first = bishop.draft[0];
	      const zoneKey = stage6BishopZoneKey(tool);
	      const zone = stage6BishopSortZone({
	        ...(bishop[zoneKey] || {}),
	        xStart:first.x,
	        xEnd:clampedX
	      });
	      if(tool === 'load'){
	        stage6BishopCreateSurfaceLoadFromZone(zone);
	      } else if(zoneKey) {
	        bishop[zoneKey] = zone;
	        stage6BishopInvalidate(`${stage6BishopZoneLabel(tool)} updated; rerun Bishop search.`);
	      }
	      bishop.draft = [];
	      bishop.draftKind = '';
	    }
	    renderStage6();
	    return;
  }
  if(tool === 'wall'){
    if(bishop.terrain.length < 2) return;
    const minX = bishop.terrain[0].x;
    const maxX = bishop.terrain[bishop.terrain.length-1].x;
    if(bishop.draftKind !== 'wall' || bishop.draft.length !== 1){
      const x = Math.min(Math.max(stage6BishopSnapWorldPoint(world, 'terrain-x').x, minX), maxX);
      const terrain = {vertices:bishop.terrain};
      bishop.draft = [{x, y:bishopTerrainY(terrain, x)}];
      bishop.draftKind = 'wall';
    } else {
      const top = bishop.draft[0];
      const tip = stage6BishopSnapWorldPoint(world, 'free');
      const wallId = stage6BishopWallId();
      bishop.walls = [
        ...(bishop.walls || []),
        {
          id:wallId,
          head:{x:top.x, y:top.y},
          tip:{x:tip.x, y:tip.y},
          x:top.x,
          yTop:top.y,
          yTip:tip.y,
          passiveSide:stage6BishopDefaultPassiveSide(),
          mechanicalActive:true,
          anchors:[],
          maxShearForce:null,
          material:stage6BishopDefaultWallMaterial((bishop.walls || []).length, wallId)
        }
      ];
      bishop.walls = stage6BishopNormalizeWalls(bishop.walls, bishop.terrain);
      bishop.selectedWallId = wallId;
      bishop.draft = [];
      bishop.draftKind = '';
      stage6BishopInvalidateWallGeometry('Retaining wall added; rerun Bishop search.');
    }
    renderStage6();
  }
}

function stage6BishopCompleteCurrentActionAt(world){
  ensureStage6State();
  const bishop = S.stage6.bishop;
  if(bishop.draftKind === 'terrain' || bishop.draftKind === 'phreatic' || bishop.draftKind === 'drain' || bishop.draftKind === 'region' || bishop.draftKind === 'regionHole'){
    if((bishop.draft || []).length >= 2){
      if(bishop.draftKind === 'drain' && bishop.draft.length < 2) return false;
      if((bishop.draftKind === 'region' || bishop.draftKind === 'regionHole') && bishop.draft.length < 3) return false;
      stage6BishopFinishDraft();
      return true;
    }
    return false;
  }
  if(bishop.draftKind === 'regionSplit'){
    bishop.draft = [];
    bishop.draftKind = 'regionSplit';
    renderStage6();
    return true;
  }
  if((bishop.draftKind === 'entry' || bishop.draftKind === 'exit' || bishop.draftKind === 'load') && (bishop.draft || []).length === 1 && bishop.terrain.length >= 2){
    const kind = bishop.draftKind;
    const x = stage6BishopSnapWorldPoint(world, 'terrain-x').x;
    const terrain = {vertices:bishop.terrain};
    const minX = bishop.terrain[0].x;
    const maxX = bishop.terrain[bishop.terrain.length-1].x;
    const clampedX = Math.min(Math.max(x, minX), maxX);
    const first = bishop.draft[0];
    const zoneKey = stage6BishopZoneKey(kind);
    const zone = stage6BishopSortZone({
      ...(bishop[zoneKey] || {}),
      xStart:first.x,
      xEnd:clampedX
    });
	    if(stage6BishopValidZone(zone)){
	      if(kind === 'load'){
	        stage6BishopCreateSurfaceLoadFromZone(zone);
	      } else if(zoneKey) {
	        bishop[zoneKey] = zone;
	        stage6BishopInvalidate(`${stage6BishopZoneLabel(kind)} updated; rerun Bishop search.`);
	      }
	      bishop.draft = [];
	      bishop.draftKind = '';
	      renderStage6();
	      return true;
	    }
  }
  if(bishop.draftKind === 'wall' && (bishop.draft || []).length === 1){
    const top = bishop.draft[0];
    const tip = stage6BishopSnapWorldPoint(world, 'free');
    const wallId = stage6BishopWallId();
    bishop.walls = [
      ...(bishop.walls || []),
      {
        id:wallId,
        head:{x:top.x, y:top.y},
        tip:{x:tip.x, y:tip.y},
        x:top.x,
        yTop:top.y,
        yTip:tip.y,
        passiveSide:stage6BishopDefaultPassiveSide(),
        mechanicalActive:true,
        anchors:[],
        maxShearForce:null,
        material:stage6BishopDefaultWallMaterial((bishop.walls || []).length, wallId)
      }
    ];
    bishop.walls = stage6BishopNormalizeWalls(bishop.walls, bishop.terrain);
    bishop.selectedWallId = wallId;
    bishop.draft = [];
    bishop.draftKind = '';
    stage6BishopInvalidateWallGeometry('Retaining wall added; rerun Bishop search.');
    renderStage6();
    return true;
  }
  return false;
}

function stage6BishopPointerDown(event){
  const canvas = event.currentTarget;
  const bishop = S.stage6.bishop;
  stage6BishopCanvasState.canvas = canvas;
  stage6BishopUpdateHoverDom(canvas, event.clientX, event.clientY);
  if(event.button === 2){
    event.preventDefault();
    stage6BishopCompleteCurrentActionAt(stage6BishopScreenToWorld(canvas, event.clientX, event.clientY));
    return;
  }
  if(event.button === 1){
    event.preventDefault();
    stage6BishopCanvasState.pointerDrag = {
      kind:'pan',
      pointerId:event.pointerId,
      startX:event.clientX,
      startY:event.clientY,
      offsetX:bishop.viewport.offsetX,
      offsetY:bishop.viewport.offsetY
    };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if(bishop.tool === 'edit'){
    const handle = stage6BishopNearestHandle(canvas, event.clientX, event.clientY);
    if(handle){
      if(handle.kind === 'wallTop' || handle.kind === 'wallTip'){
        bishop.selectedWallId = bishop.walls?.[handle.index]?.id || null;
      }
      stage6BishopInvalidate();
	      stage6BishopCanvasState.pointerDrag = {
	        kind:handle.kind,
	        index:handle.index,
	        vertexIndex:handle.vertexIndex,
	        regionId:handle.regionId,
	        loadId:handle.loadId,
	        pointerId:event.pointerId
	      };
      canvas.setPointerCapture(event.pointerId);
      return;
    }
	    const model = S.stage6Cache.bishopModel || stage6BishopCurrentModel();
	    const world = stage6BishopScreenToWorld(canvas, event.clientX, event.clientY);
	    const load = stage6BishopPickSurfaceLoadAtWorld(world);
	    if(load){
	      bishop.selectedSurfaceLoadId = load.id;
	      bishop.selectedRegionId = null;
	      bishop.selectedWallId = null;
	      renderStage6();
	      return;
	    }
    const wall = stage6BishopPickWallAtWorld(world);
    if(wall){
      bishop.selectedWallId = wall.id;
      bishop.selectedSurfaceLoadId = null;
      bishop.selectedRegionId = null;
      bishop.selectedDrainId = '';
      const ui = stage6BishopUiState();
      ui.bishopActiveCanvasPanel = 'structures';
      ui.bishopActiveCanvasSheet = '';
      ui.bishopCanvasToolsHidden = false;
      renderStage6();
      return;
    }
	    const region = (bishop.customRegions || []).length
      ? stage6BishopRegionAtPoint({regions:stage6BishopDisplayRegions(model)}, world)
      : null;
    if(region){
      bishop.selectedRegionId = region.id;
      bishop.selectedWallId = null;
      renderStage6();
      return;
    }
    stage6BishopCanvasState.pointerDrag = {
      kind:'pan',
      pointerId:event.pointerId,
      startX:event.clientX,
      startY:event.clientY,
      offsetX:bishop.viewport.offsetX,
      offsetY:bishop.viewport.offsetY
    };
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  stage6BishopCommitDrawPoint(canvas, stage6BishopScreenToWorld(canvas, event.clientX, event.clientY));
}

function stage6BishopPointerMove(event){
  const canvas = event.currentTarget;
  stage6BishopUpdateHoverDom(canvas, event.clientX, event.clientY);
  const drag = stage6BishopCanvasState.pointerDrag;
  if(!drag || drag.pointerId !== event.pointerId){
    return;
  }
  const bishop = S.stage6.bishop;
  if(drag.kind === 'pan'){
    bishop.viewport.offsetX = drag.offsetX + (event.clientX - drag.startX);
    bishop.viewport.offsetY = drag.offsetY + (event.clientY - drag.startY);
    stage6BishopDrawCanvas();
    return;
  }
  const world = stage6BishopScreenToWorld(canvas, event.clientX, event.clientY);
  if(drag.kind === 'terrain'){
    const pt = stage6BishopSnapWorldPoint(world, 'free');
    const prev = bishop.terrain[drag.index-1];
    const next = bishop.terrain[drag.index+1];
    // Monotone NON-decreasing x (allow a vertical face Δx=0, Δy≠0 — e.g. a step flush to a wall);
    // 'free' snapping pulls x onto a wall head/tip so the drop lands exactly on the wall.
    if(prev) pt.x = Math.max(pt.x, prev.x);
    if(next) pt.x = Math.min(pt.x, next.x);
    if((prev && Math.hypot(pt.x-prev.x, pt.y-prev.y) <= 1e-6) ||
       (next && Math.hypot(pt.x-next.x, pt.y-next.y) <= 1e-6)) return;  // reject a zero-length edge
    bishop.terrain[drag.index] = pt;
  } else if(drag.kind === 'phreatic'){
    const pt = stage6BishopSnapWorldPoint(world, 'free');
    const prev = bishop.phreatic[drag.index-1];
    const next = bishop.phreatic[drag.index+1];
    if(prev) pt.x = Math.max(pt.x, prev.x);   // allow a vertical phreatic step to match the face
    if(next) pt.x = Math.min(pt.x, next.x);
    if((prev && Math.hypot(pt.x-prev.x, pt.y-prev.y) <= 1e-6) ||
       (next && Math.hypot(pt.x-next.x, pt.y-next.y) <= 1e-6)) return;
    bishop.phreatic[drag.index] = pt;
  } else if(drag.kind === 'cpt'){
    const x = stage6BishopSnapWorldPoint(world, 'terrain-x').x;
    bishop.activeCptX = Math.min(Math.max(x, bishop.terrain[0].x), bishop.terrain[bishop.terrain.length-1].x);
  } else if(drag.kind.startsWith('entry') || drag.kind.startsWith('exit') || drag.kind.startsWith('load')){
    const edge = drag.kind.endsWith('Start') ? 'xStart' : 'xEnd';
    const x = stage6BishopSnapWorldPoint(world, 'terrain-x').x;
    const minX = bishop.terrain[0].x;
    const maxX = bishop.terrain[bishop.terrain.length-1].x;
    if(drag.kind.startsWith('load')){
      const load = (bishop.surfaceLoads || []).find((item)=>item.id === drag.loadId)
        || stage6BishopSelectedSurfaceLoad();
      if(!load) return;
      load[edge] = Math.min(Math.max(x, minX), maxX);
      Object.assign(load, stage6BishopSortZone(load) || load);
      bishop.selectedSurfaceLoadId = load.id;
      stage6BishopSyncLegacySurfaceLoadMirror(bishop);
    } else {
      const zoneKey = drag.kind.startsWith('entry') ? 'entryZone' : 'exitZone';
      bishop[zoneKey][edge] = Math.min(Math.max(x, minX), maxX);
      bishop[zoneKey] = stage6BishopSortZone(bishop[zoneKey]);
    }
  } else if(drag.kind === 'wallTop' || drag.kind === 'wallTip'){
    const wall = bishop.walls?.[drag.index];
    if(!wall) return;
    const pt = stage6BishopSnapWorldPoint(world, 'free');
    const minX = bishop.terrain.length >= 2 ? bishop.terrain[0].x : -Infinity;
    const maxX = bishop.terrain.length >= 2 ? bishop.terrain[bishop.terrain.length-1].x : Infinity;
    const nextPoint = {
      x:Math.min(Math.max(pt.x, minX), maxX),
      y:pt.y
    };
    if(drag.kind === 'wallTop'){
      wall.head = nextPoint;
    } else {
      wall.tip = nextPoint;
    }
    bishop.walls = stage6BishopNormalizeWalls(bishop.walls, bishop.terrain);
  } else if(drag.kind === 'drainVertex'){
    const drain = bishop.drains?.[drag.index];
    if(!drain || !Array.isArray(drain.vertices) || !drain.vertices[drag.vertexIndex]) return;
    const pt = stage6BishopSnapWorldPoint(world, 'free');
    drain.vertices[drag.vertexIndex] = {x:+pt.x.toFixed(6), y:+pt.y.toFixed(6)};
    bishop.drains = stage6BishopNormalizeDrains(bishop.drains);
  } else if(drag.kind === 'regionVertex'){
    const region = (bishop.customRegions || []).find((item)=>item.id === drag.regionId);
    if(!region) return;
    const pt = stage6BishopSnapWorldPoint(world, 'free');
    const minX = bishop.terrain.length >= 2 ? bishop.terrain[0].x : -Infinity;
    const maxX = bishop.terrain.length >= 2 ? bishop.terrain[bishop.terrain.length-1].x : Infinity;
    const nextPoint = stage6BishopClampRegionPoint(pt, minX, maxX);
    const nextPolygon = (region.polygon || []).map((item, index)=>index === drag.index ? nextPoint : item);
    if(stage6BishopPolygonIsValid(nextPolygon)){
      region.polygon[drag.index] = nextPoint;
    }
  }
  stage6BishopDrawCanvas();
}

function stage6BishopPointerUp(event){
  const drag = stage6BishopCanvasState.pointerDrag;
  if(!drag || drag.pointerId !== event.pointerId) return;
  stage6BishopCanvasState.pointerDrag = null;
  if(event.currentTarget.releasePointerCapture){
    try{ event.currentTarget.releasePointerCapture(event.pointerId); }catch(e){}
  }
  if(drag.kind === 'terrain' && (S.stage6.bishop.customRegions || []).length){
    stage6BishopClearCustomRegions('Terrain updated; custom soil polygons were cleared and Bishop results were reset.');
  }
  if(drag.kind === 'wallTop' || drag.kind === 'wallTip'){
    stage6BishopInvalidateSeepage('Wall geometry changed; rerun seepage.', false, false);
  }
  renderStage6();
}

function stage6BishopPointerLeave(){
  stage6BishopCanvasState.hoverWorld = null;
  stage6BishopHideHoverDom();
  stage6BishopDrawCanvas();
}

function stage6BishopWheel(event){
  event.preventDefault();
  const canvas = event.currentTarget;
  const bishop = S.stage6.bishop;
  const before = stage6BishopScreenToWorld(canvas, event.clientX, event.clientY);
  const factor = event.deltaY < 0 ? 1.08 : 1/1.08;
  bishop.viewport.scale = Math.min(Math.max(bishop.viewport.scale * factor, 4), 220);
  bishop.viewport.offsetX = (event.clientX - canvas.getBoundingClientRect().left) - before.x * bishop.viewport.scale;
  bishop.viewport.offsetY = (event.clientY - canvas.getBoundingClientRect().top) + before.y * bishop.viewport.scale;
  stage6BishopDrawCanvas();
}

function stage6BishopDrawGrid(ctx, width, height){
  const bishop = S.stage6.bishop;
  const step = Math.max(bishop.snapSize || 0.5, 0.05);
  if(bishop.viewport.scale * step < 18) return;
  const xMin = (0 - bishop.viewport.offsetX) / bishop.viewport.scale;
  const xMax = (width - bishop.viewport.offsetX) / bishop.viewport.scale;
  const yMax = bishop.viewport.offsetY / bishop.viewport.scale;
  const yMin = (bishop.viewport.offsetY - height) / bishop.viewport.scale;
  const startX = Math.floor(xMin / step) * step;
  const endX = Math.ceil(xMax / step) * step;
  const startY = Math.floor(yMin / step) * step;
  const endY = Math.ceil(yMax / step) * step;
  ctx.save();
  ctx.strokeStyle = 'rgba(140, 150, 170, 0.18)';
  ctx.lineWidth = 1;
  for(let x=startX; x<=endX+1e-9; x+=step){
    const sx = stage6BishopWorldToScreen({x, y:0}).x;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
    ctx.stroke();
  }
  for(let y=startY; y<=endY+1e-9; y+=step){
    const sy = stage6BishopWorldToScreen({x:0, y}).y;
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
    ctx.stroke();
  }
  ctx.restore();
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
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  const rootStyle = getComputedStyle(document.documentElement);
  ctx.fillStyle = rootStyle.getPropertyValue('--bg').trim() || '#fff';
  ctx.fillRect(0, 0, width, height);
  stage6BishopDrawGrid(ctx, width, height);
  const canvasTextColor = rootStyle.getPropertyValue('--canvas-text').trim() || '#213142';
  const canvasHaloColor = rootStyle.getPropertyValue('--canvas-text-halo').trim() || 'rgba(255,255,255,0.92)';

  const bishop = S.stage6.bishop;
  const workspace = bishop.workspace === 'seepage' ? 'seepage' : bishop.workspace === 'deformation' ? 'deformation' : 'stability';
  const deformationAnalysisType = stage6BishopNormalizedDeformationAnalysisType();
  stage6BishopSyncSoilModel();
  const model = buildBishopModelFromStageLayers(stage6WorkingLayers(), bishop);
  S.stage6Cache.bishopModel = model;
  const displayRegions = stage6BishopDisplayRegions(model);
  const showingCustomRegionPreview = stage6BishopShowingCustomRegionPreview(model);
  if(model && bishop.display?.showRegions !== false){
    displayRegions.forEach((region)=>{
      if(!region.polygon?.length) return;
      const screenPts = region.polygon.map((pt)=>stage6BishopWorldToScreen(pt));
      const isSelectedCustom = region.id === bishop.selectedRegionId;
      ctx.beginPath();
      screenPts.forEach((s, index)=>{
        if(index === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.save();
      ctx.globalAlpha = showingCustomRegionPreview ? Math.min((bishop.display?.regionOpacity ?? 0.22) + 0.06, 0.35) : (bishop.display?.regionOpacity ?? 0.22);
      ctx.fillStyle = region.material.color || '#c9b089';
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = region.material.color || '#c9b089';
      ctx.globalAlpha = isSelectedCustom ? 0.95 : (showingCustomRegionPreview ? 0.82 : 0.7);
      ctx.lineWidth = isSelectedCustom ? 3 : 1.5;
      if(showingCustomRegionPreview) ctx.setLineDash([8, 5]);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      if(isSelectedCustom){
        ctx.save();
        ctx.strokeStyle = '#213142';
        ctx.lineWidth = 1;
        ctx.setLineDash([6,4]);
        ctx.stroke();
        ctx.restore();
      }

      if(bishop.display?.showRegionLabels !== false){
        const centroid = stage6BishopPolygonCentroid(region.polygon);
        if(centroid){
          const labelPos = stage6BishopWorldToScreen(centroid);
          const xs = screenPts.map((pt)=>pt.x);
          const ys = screenPts.map((pt)=>pt.y);
          const widthPx = Math.max(...xs) - Math.min(...xs);
          const heightPx = Math.max(...ys) - Math.min(...ys);
          if(widthPx >= 48 && heightPx >= 20){
            const label = stage6BishopRegionShortLabel(region);
            ctx.save();
            ctx.font = '600 11px system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 4;
            ctx.lineJoin = 'round';
            ctx.strokeStyle = canvasHaloColor;
            ctx.strokeText(label, labelPos.x, labelPos.y);
            ctx.fillStyle = canvasTextColor;
            ctx.fillText(label, labelPos.x, labelPos.y);
            ctx.restore();
          }
        }
      }
    });
  }

  const drawPolyline = (points, stroke, widthPx, dash)=>{
    if(!points?.length) return;
    ctx.save();
    ctx.beginPath();
    points.forEach((pt, index)=>{
      const s = stage6BishopWorldToScreen(pt);
      if(index === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.strokeStyle = stroke;
    ctx.lineWidth = widthPx;
    ctx.setLineDash(dash || []);
    ctx.stroke();
    ctx.restore();
  };

  const drawPolylineArrows = (points, stroke, spacingPx = 74, arrowPx = 7)=>{
    if(!points?.length || points.length < 2) return;
    const screenPts = points.map((point)=>stage6BishopWorldToScreen(point));
    let carry = spacingPx * 0.5;
    for(let i=0;i<screenPts.length-1;i+=1){
      const a = screenPts[i];
      const b = screenPts[i+1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if(!(len > 1e-6)) continue;
      let offset = carry;
      while(offset < len){
        const t = offset / len;
        const x = a.x + dx * t;
        const y = a.y + dy * t;
        const angle = Math.atan2(dy, dx);
        ctx.save();
        ctx.strokeStyle = stroke;
        ctx.fillStyle = stroke;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - 0.6 * arrowPx * Math.cos(angle), y - 0.6 * arrowPx * Math.sin(angle));
        ctx.lineTo(x + 0.6 * arrowPx * Math.cos(angle), y + 0.6 * arrowPx * Math.sin(angle));
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + 0.6 * arrowPx * Math.cos(angle), y + 0.6 * arrowPx * Math.sin(angle));
        ctx.lineTo(x + 0.05 * arrowPx * Math.cos(angle) - 0.6 * arrowPx * Math.cos(angle - Math.PI / 6), y + 0.05 * arrowPx * Math.sin(angle) - 0.6 * arrowPx * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(x + 0.05 * arrowPx * Math.cos(angle) - 0.6 * arrowPx * Math.cos(angle + Math.PI / 6), y + 0.05 * arrowPx * Math.sin(angle) - 0.6 * arrowPx * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        offset += spacingPx;
      }
      carry = offset - len;
    }
  };

  const drawCircleArc = (circle, stroke, widthPx, dash)=>{
    const pts = [];
    const n = 100;
    const branch = circle?.branch === 'upper' ? 'upper' : 'lower';
    for(let i=0;i<=n;i+=1){
      const x = circle.entryPoint.x + ((circle.exitPoint.x - circle.entryPoint.x) * i) / n;
      const rem = Math.max(circle.radius*circle.radius - (x-circle.center.x)*(x-circle.center.x), 0);
      const root = Math.sqrt(rem);
      pts.push({x, y:branch === 'upper' ? circle.center.y + root : circle.center.y - root});
    }
    drawPolyline(pts, stroke, widthPx, dash);
  };

  const seepageMesh = bishop.seepage?.mesh || null;
  const seepageResult = bishop.seepage?.result || null;
  if(workspace === 'seepage' && seepageMesh && seepageResult){
    const contourMode = bishop.seepage?.display?.contourMode || 'head';
    const contourDerived = stage6BishopSeepageContourDerived(seepageResult, seepageMesh, contourMode);
    const contourStats = contourDerived.stats;
    if(bishop.seepage.display?.showContours !== false){
      ctx.save();
      seepageMesh.cells.forEach((cell, index)=>{
        const polygon = cell?.polygon || [];
        if(polygon.length < 3) return;
        const screen = polygon.map((point)=>stage6BishopWorldToScreen(point));
        const wetFraction = Math.max(0, Math.min(seepageResult.cellWetFraction?.[index] ?? (seepageResult.cellDryMask?.[index] ? 0 : 1), 1));
        const alpha = contourMode === 'head' || contourMode === 'hydraulicFs'
          ? (0.08 + 0.44 * wetFraction)
          : 0.52;
        const value = stage6BishopSeepageContourValue(seepageResult, seepageMesh, index, contourMode);
        ctx.fillStyle = stage6BishopSeepageContourColor(value, contourStats.min, contourStats.max, contourMode, alpha);
        ctx.beginPath();
        ctx.moveTo(screen[0].x, screen[0].y);
        for(let i=1;i<screen.length;i+=1) ctx.lineTo(screen[i].x, screen[i].y);
        ctx.closePath();
        ctx.fill();
      });
      ctx.restore();
    }

    if(bishop.seepage.display?.showContourLines !== false){
      ctx.save();
      contourDerived.levelSegments.forEach((group)=>{
        const stroke = stage6BishopSeepageContourLineColor(group.level, contourStats.min, contourStats.max, contourMode, 0.94);
        (group.segments || []).forEach((segment)=>{
          drawPolyline(segment, stroke, Math.abs(group.level) < 1e-10 ? 2.1 : 1.35, []);
        });
      });
      ctx.restore();
    }

    if(bishop.seepage.display?.showPhreatic !== false){
      (seepageResult.phreaticSegments || []).forEach((segment)=>{
        drawPolyline(segment, readCssToken('--chart-green', '#3D6B6A'), 2, [8, 4]);
      });
    }

    if(bishop.seepage.display?.showFlowVectors){
      const flowLines = seepageResult.flowLines || [];
      flowLines.forEach((line)=>{
        drawPolyline(line, 'rgba(20, 58, 95, 0.48)', 1.6, []);
        drawPolylineArrows(line, 'rgba(20, 58, 95, 0.78)', 74, 7);
      });
    }

    if(bishop.seepage.display?.showExitGradient){
      (seepageMesh.boundaryFaces || []).forEach((face, index)=>{
        if(face?.type !== 'seepage-face') return;
        if(seepageResult.activeSeepageFaceMask && !seepageResult.activeSeepageFaceMask[index]) return;
        const gradient = seepageResult.boundaryGradients?.[index] || 0;
        const t = Math.max(0, Math.min(gradient / Math.max(seepageResult.maxExitGradient || 1, 1e-6), 1));
        const stroke = `rgba(${Math.round(70 + 185 * t)}, ${Math.round(165 - 105 * t)}, 72, 0.86)`;
        drawPolyline([face.a, face.b], stroke, 4, []);
      });
    }
  }

  const deformationMesh = bishop.deformation?.mesh || null;
  const deformationResult = bishop.deformation?.result || null;
  if(workspace === 'deformation' && deformationMesh && deformationResult){
    const contourMode = bishop.deformation?.display?.contourMode || 'uTotal';
    const contourDerived = stage6BishopDeformationContourDerived(deformationResult, deformationMesh, contourMode);
    const contourStats = contourDerived.stats;
    const dispScale = Math.max(Number(bishop.deformation?.options?.displacementScale) || 1, 0.05);
    const deformationVectorMode = stage6BishopDeformationVectorMode(contourMode);
    const deformationVectorReference = deformationVectorMode
      ? Math.max(
          (deformationResult?.nodalDisplacements || []).reduce((max, disp)=>{
            const ux = Number(disp?.ux) || 0;
            const uy = Number(disp?.uy) || 0;
            const mag = contourMode === 'ux'
              ? Math.abs(ux)
              : contourMode === 'uy' || contourMode === 'settlement'
                ? Math.abs(uy)
                : Math.hypot(ux, uy);
            return Math.max(max, mag);
          }, 0),
          1e-12
        )
      : 1e-12;
    const deformedPoint = (nodeId)=>{
      const node = deformationMesh.nodes?.[nodeId];
      const disp = deformationResult.nodalDisplacements?.[nodeId];
      return stage6BishopWorldToScreen({
        x:(node?.x || 0) + (disp?.ux || 0) * dispScale,
        y:(node?.y || 0) + (disp?.uy || 0) * dispScale
      });
    };
    if(bishop.deformation?.display?.showContours !== false){
      ctx.save();
      if(deformationMesh.elementType === 't6' && deformationVectorMode){
        deformationMesh.elements.forEach((element)=>{
          stage6BishopT6VisualSubtriangles(element).forEach((subtri)=>{
            if(subtri.length < 3) return;
            const value = stage6BishopAverageFiniteValues(
              subtri.map((nodeId)=>stage6BishopDeformationFiniteScalarOrNull(contourDerived.nodalValues?.[nodeId])),
              null
            );
            if(!Number.isFinite(value)) return;
            const screen = subtri.map((nodeId)=>stage6BishopWorldToScreen(deformationMesh.nodes[nodeId]));
            ctx.fillStyle = stage6BishopDeformationContourColor(value, contourStats.min, contourStats.max, contourMode, 0.52, deformationAnalysisType);
            ctx.beginPath();
            ctx.moveTo(screen[0].x, screen[0].y);
            ctx.lineTo(screen[1].x, screen[1].y);
            ctx.lineTo(screen[2].x, screen[2].y);
            ctx.closePath();
            ctx.fill();
          });
        });
      } else {
        deformationMesh.cells.forEach((cell, index)=>{
          const polygon = cell?.polygon || [];
          if(polygon.length < 3) return;
          const screen = polygon.map((point)=>stage6BishopWorldToScreen(point));
          const value = stage6BishopDeformationContourValue(deformationResult, deformationMesh, index, contourMode);
          if(!Number.isFinite(value)) return;
          ctx.fillStyle = stage6BishopDeformationContourColor(value, contourStats.min, contourStats.max, contourMode, 0.52, deformationAnalysisType);
          ctx.beginPath();
          ctx.moveTo(screen[0].x, screen[0].y);
          for(let i=1;i<screen.length;i+=1) ctx.lineTo(screen[i].x, screen[i].y);
          ctx.closePath();
          ctx.fill();
        });
      }
      ctx.restore();
    }
    if(bishop.deformation?.display?.showContourLines !== false){
      ctx.save();
      contourDerived.levelSegments.forEach((group)=>{
        const stroke = stage6BishopDeformationContourLineColor(group.level, contourStats.min, contourStats.max, contourMode, 0.94, deformationAnalysisType);
        (group.segments || []).forEach((segment)=>{
          drawPolyline(segment, stroke, Math.abs(group.level) < 1e-10 ? 2.1 : 1.35, []);
        });
      });
      ctx.restore();
    }
    if(bishop.deformation?.display?.showPlasticPoints !== false){
      const plasticPointSets = stage6BishopDeformationPlasticPointSets(deformationResult);
      const drawPlasticMarkers = (points, style = {})=>{
        if(!points?.length) return;
        const radius = Math.max(Number(style.radius) || 2.3, 1.2);
        ctx.save();
        points.forEach((point)=>{
          const screen = stage6BishopWorldToScreen(point);
          ctx.beginPath();
          ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
          if(style.fill){
            ctx.fillStyle = style.fill;
            ctx.fill();
          }
          if(style.stroke){
            ctx.lineWidth = Number(style.lineWidth) || 1;
            ctx.strokeStyle = style.stroke;
            ctx.stroke();
          }
        });
        ctx.restore();
      };
      drawPlasticMarkers(plasticPointSets.historyPoints, {
        stroke:'rgba(181, 58, 109, 0.88)',
        lineWidth:1.2,
        radius:2.0
      });
      drawPlasticMarkers(plasticPointSets.activePoints, {
        fill:'rgba(196, 57, 43, 0.88)',
        stroke:'rgba(255, 255, 255, 0.92)',
        lineWidth:0.9,
        radius:2.4
      });
      drawPlasticMarkers(plasticPointSets.tensionPoints, {
        fill:'rgba(214, 137, 16, 0.92)',
        stroke:'rgba(255, 255, 255, 0.92)',
        lineWidth:0.9,
        radius:2.7
      });
    }
    if(
      bishop.deformation?.display?.showDisplacementVectors &&
      bishop.deformation?.display?.showContourLines !== false &&
      deformationVectorMode
    ){
      const maxVectors = 28;
      const bucketSizePx = 96;
      const viewportPaddingPx = 18;
      const usedBuckets = new Set();
      let drawnVectors = 0;
      const drawDisplacementArrow = (screenMid, vx, vy, relativeMagnitude)=>{
        const mag = Math.hypot(vx, vy);
        if(!(mag > 1e-12)) return;
        const dirX = vx / mag;
        const dirY = vy / mag;
        const shaftPx = 10 + 8 * Math.max(0, Math.min(relativeMagnitude, 1));
        const halfDx = 0.5 * shaftPx * dirX;
        const halfDy = -0.5 * shaftPx * dirY;
        const tailX = screenMid.x - halfDx;
        const tailY = screenMid.y - halfDy;
        const tipX = screenMid.x + halfDx;
        const tipY = screenMid.y + halfDy;
        const headPx = 5.2;
        const headAngle = Math.PI / 6;
        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.lineWidth = 3.4;
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(25, 37, 54, 0.92)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(tailX, tailY);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();
        ctx.fillStyle = 'rgba(25, 37, 54, 0.94)';
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(
          tipX - headPx * Math.cos(Math.atan2(-dirY, dirX) - headAngle),
          tipY - headPx * Math.sin(Math.atan2(-dirY, dirX) - headAngle)
        );
        ctx.lineTo(
          tipX - headPx * Math.cos(Math.atan2(-dirY, dirX) + headAngle),
          tipY - headPx * Math.sin(Math.atan2(-dirY, dirX) + headAngle)
        );
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      };
      contourDerived.levelSegments.forEach((group)=>{
        if(drawnVectors >= maxVectors) return;
        (group.segments || []).forEach((segment)=>{
          if(drawnVectors >= maxVectors || !segment?.length || segment.length < 2) return;
          const a = segment[0];
          const b = segment[segment.length - 1];
          const screenA = stage6BishopWorldToScreen(a);
          const screenB = stage6BishopWorldToScreen(b);
          const screenLen = Math.hypot(screenB.x - screenA.x, screenB.y - screenA.y);
          if(screenLen < 2) return;
          const midpoint = {
            x:0.5 * (a.x + b.x),
            y:0.5 * (a.y + b.y)
          };
          const screenMid = stage6BishopWorldToScreen(midpoint);
          if(
            screenMid.x < -viewportPaddingPx ||
            screenMid.x > width + viewportPaddingPx ||
            screenMid.y < -viewportPaddingPx ||
            screenMid.y > height + viewportPaddingPx
          ) return;
          const bucketKey = `${Math.floor(screenMid.x / bucketSizePx)}:${Math.floor(screenMid.y / bucketSizePx)}`;
          if(usedBuckets.has(bucketKey)) return;
          const sampled = sampleDeformationState(deformationMesh, deformationResult, midpoint.x, midpoint.y);
          if(!sampled) return;
          const vx = contourMode === 'ux'
            ? Number(sampled.ux) || 0
            : contourMode === 'uy' || contourMode === 'settlement'
              ? 0
              : Number(sampled.ux) || 0;
          const vy = contourMode === 'ux'
            ? 0
            : contourMode === 'uy' || contourMode === 'settlement'
              ? Number(sampled.uy) || 0
              : Number(sampled.uy) || 0;
          const referenceMag = contourMode === 'ux'
            ? Math.abs(vx)
            : contourMode === 'uy' || contourMode === 'settlement'
              ? Math.abs(vy)
              : Math.hypot(vx, vy);
          if(!(referenceMag > 1e-12)) return;
          usedBuckets.add(bucketKey);
          drawDisplacementArrow(screenMid, vx, vy, referenceMag / deformationVectorReference);
          drawnVectors += 1;
        });
      });
    }
    if(bishop.deformation?.display?.showUndeformedMesh){
      ctx.save();
      ctx.strokeStyle = 'rgba(33, 49, 66, 0.22)';
      ctx.lineWidth = 0.8;
      deformationMesh.elements.forEach((element)=>{
        const p0 = stage6BishopWorldToScreen(deformationMesh.nodes[element[0]]);
        const p1 = stage6BishopWorldToScreen(deformationMesh.nodes[element[1]]);
        const p2 = stage6BishopWorldToScreen(deformationMesh.nodes[element[2]]);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.closePath();
        ctx.stroke();
      });
      ctx.restore();
    }
    if(bishop.deformation?.display?.showDeformedMesh !== false){
      ctx.save();
      ctx.strokeStyle = 'rgba(33, 49, 66, 0.68)';
      ctx.lineWidth = 0.9;
      deformationMesh.elements.forEach((element)=>{
        const p0 = deformedPoint(element[0]);
        const p1 = deformedPoint(element[1]);
        const p2 = deformedPoint(element[2]);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.closePath();
        ctx.stroke();
      });
      ctx.restore();
    }
  }

  const drawLoadZoneMarkers = (zone, q, color, options = {})=>{
    if(!stage6BishopValidZone(zone) || bishop.terrain.length < 2) return;
    const terrain = {vertices:bishop.terrain};
    const midX = 0.5 * (zone.xStart + zone.xEnd);
    const midY = bishopTerrainY(terrain, midX);
    const mid = stage6BishopWorldToScreen({x:midX, y:midY});
    ctx.save();
    ctx.fillStyle = color;
    ctx.globalAlpha = options.active === false ? 0.62 : 1;
    ctx.font = `${options.active === false ? 'italic ' : ''}12px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    const label = options.label ? `${options.label}: ` : '';
    const text = options.active === false
      ? `${label}inactive`
      : `${options.selected ? 'Selected · ' : ''}${label}q=${q.toFixed(1)} kPa`;
    if(options.selected){
      const metrics = ctx.measureText(text);
      const padX = 7;
      const badgeX = mid.x - metrics.width / 2 - padX;
      const badgeY = mid.y - 28;
      const badgeW = metrics.width + 2 * padX;
      const badgeH = 18;
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.strokeStyle = 'rgba(31,111,235,0.55)';
      ctx.lineWidth = 1;
      if(typeof ctx.roundRect === 'function'){
        ctx.beginPath();
        ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 6);
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
        ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
      }
      ctx.restore();
    }
    ctx.fillText(text, mid.x, mid.y - 12);
    ctx.restore();
    if(!(q > 0) || options.active === false) return;
    const span = Math.abs(zone.xEnd - zone.xStart);
    const arrowCount = Math.max(2, Math.min(5, Math.round(span / 2) + 1));
    Array.from({length:arrowCount}, (_, index)=>(
      zone.xStart + ((zone.xEnd - zone.xStart) * index) / Math.max(arrowCount - 1, 1)
    )).forEach((x)=>{
      const y = bishopTerrainY(terrain, x);
      const top = stage6BishopWorldToScreen({x, y:y + 0.8});
      const tip = stage6BishopWorldToScreen({x, y:y + 0.08});
      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.globalAlpha = options.active === false ? 0.35 : 1;
      ctx.lineWidth = options.selected ? 2 : 1.5;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - 4, tip.y - 6);
      ctx.lineTo(tip.x + 4, tip.y - 6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });
  };

  const drawWall = (wall, options = {})=>{
    const axis = wallAxis(wall);
    if(!axis) return;
    const top = stage6BishopWorldToScreen(axis.head);
    const tip = stage6BishopWorldToScreen(axis.tip);
    const mid = stage6BishopWorldToScreen({
      x:0.5 * (axis.head.x + axis.tip.x),
      y:0.5 * (axis.head.y + axis.tip.y)
    });
    const passiveNormal = wallNormalForSide(axis, wall.passiveSide);
    const screenNormal = passiveNormal
      ? {x:passiveNormal.x, y:-passiveNormal.y}
      : {x:wall.passiveSide === 'left' ? -1 : 1, y:0};
    ctx.save();
    ctx.strokeStyle = options.stroke || '#6a5841';
    ctx.lineWidth = options.width || 4;
    ctx.setLineDash(options.dash || []);
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = options.stroke || '#6a5841';
    ctx.beginPath();
    const arrowTip = {x:mid.x + screenNormal.x * 12, y:mid.y + screenNormal.y * 12};
    const arrowBase = {x:mid.x + screenNormal.x * 3, y:mid.y + screenNormal.y * 3};
    const tangentScreen = {x:tip.x - top.x, y:tip.y - top.y};
    const tangentLen = Math.max(Math.hypot(tangentScreen.x, tangentScreen.y), 1);
    const tx = tangentScreen.x / tangentLen;
    const ty = tangentScreen.y / tangentLen;
    ctx.moveTo(arrowTip.x, arrowTip.y);
    ctx.lineTo(arrowBase.x + tx * 5, arrowBase.y + ty * 5);
    ctx.lineTo(arrowBase.x - tx * 5, arrowBase.y - ty * 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  const drawWallResponse = (wallResult)=>{
    const stations = wallResult?.stations || [];
    if(stations.length < 2) return;
    const displacementScale = Math.max(Number(bishop.deformation?.options?.displacementScale) || 1, 0.05);
    const passiveSign = wallResult.passiveSign < 0 ? -1 : 1;
    const deformed = stations.map((station)=>stage6BishopWorldToScreen({
      x:(Number(station.x) || 0) + displacementScale * (Number(station.ux) || 0),
      y:(Number(station.y) || 0) + displacementScale * (Number(station.uy) || 0)
    }));
    const base = stations.map((station)=>stage6BishopWorldToScreen({
      x:Number(station.x) || 0,
      y:Number(station.y) || 0
    }));
    const overlayQuantity = stage6BishopWallOverlayQuantity();
    const overlayData = stage6BishopWallNodeValuesForOverlay(wallResult, overlayQuantity);
    const overlayMaxAbs = Math.max(...(overlayData?.nodeValues || []).map((value)=>Math.abs(Number(value) || 0)), 0);
    ctx.save();
    ctx.strokeStyle = 'rgba(18, 127, 155, 0.95)';
    ctx.lineWidth = 2.2;
    ctx.setLineDash([]);
    ctx.beginPath();
    deformed.forEach((pt, index)=>{
      if(index === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    ctx.stroke();
    if(overlayMaxAbs > 0){
      if(bishop.deformation?.display?.showWallMomentOverlay !== true){
        ctx.restore();
        return;
      }
      ctx.strokeStyle = overlayData?.meta?.color || 'rgba(126, 80, 168, 0.8)';
      ctx.fillStyle = stage6BishopCssColorWithAlpha(overlayData?.meta?.color || '#7e50a8', 0.12);
      ctx.lineWidth = 1.4;
      const diagram = stations.map((station, index)=>{
        const value = Number(overlayData.nodeValues[index]) || 0;
        const prev = stations[Math.max(index - 1, 0)] || station;
        const next = stations[Math.min(index + 1, stations.length - 1)] || station;
        const dx = (Number(next.x) || 0) - (Number(prev.x) || 0);
        const dy = (Number(next.y) || 0) - (Number(prev.y) || 0);
        const len = Math.max(Math.hypot(dx, dy), 1e-9);
        const normal = {x:-(dy / len) * passiveSign, y:(dx / len) * passiveSign};
        return {
          x:base[index].x + normal.x * 32 * (value / overlayMaxAbs),
          y:base[index].y - normal.y * 32 * (value / overlayMaxAbs)
        };
      });
      ctx.beginPath();
      base.forEach((pt, index)=>{
        if(index === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      for(let i=diagram.length - 1; i >= 0; i -= 1) ctx.lineTo(diagram[i].x, diagram[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      diagram.forEach((pt, index)=>{
        if(index === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
      const extrema = overlayData.nodeValues.map((value, index)=>({
        value:Number(value) || 0,
        index,
        point:diagram[index]
      })).filter((item)=>item.point);
      if(extrema.length){
        let minItem = extrema[0];
        let maxItem = extrema[0];
        extrema.forEach((item)=>{
          if(item.value < minItem.value) minItem = item;
          if(item.value > maxItem.value) maxItem = item;
        });
        const drawOverlayExtremum = (item, label, offsetSign)=>{
          const point = item?.point;
          if(!point) return;
          const meta = overlayData?.meta || {};
          const labelText = `${label} ${stage6BishopWallQuantityFormat(item.value, meta)}`;
          const station = stations[item.index];
          const stationText = `s=${stage6CompactNumber(Number(station?.s) || 0, 3)} m`;
          ctx.save();
          ctx.font = '10px system-ui, sans-serif';
          const labelW = Math.max(ctx.measureText(labelText).width, ctx.measureText(stationText).width) + 12;
          const labelH = 26;
          let lx = point.x + 10;
          let ly = point.y + offsetSign * 18 - labelH / 2;
          lx = Math.max(6, Math.min(width - labelW - 6, lx));
          ly = Math.max(6, Math.min(height - labelH - 6, ly));
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = meta.color || '#7e50a8';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(point.x, point.y, 3.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = stage6BishopCssColorWithAlpha(meta.color || '#7e50a8', 0.88);
          ctx.strokeStyle = stage6BishopCssColorWithAlpha(meta.color || '#7e50a8', 0.96);
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
          ctx.fillStyle = stage6BishopContrastingTextColor(meta.color || '#7e50a8');
          ctx.textAlign = 'left';
          ctx.textBaseline = 'top';
          ctx.fillText(labelText, lx + 6, ly + 4);
          ctx.fillText(stationText, lx + 6, ly + 15);
          ctx.restore();
        };
        drawOverlayExtremum(minItem, 'min', -1);
        const sameExtremum = minItem.index === maxItem.index ||
          (Math.abs(minItem.value - maxItem.value) < 1e-12 && Math.abs(minItem.index - maxItem.index) === 0);
        if(!sameExtremum) drawOverlayExtremum(maxItem, 'max', 1);
      }
    }
    ctx.restore();
  };

  const drawMeasurementOverlay = (points, options = {})=>{
    const metrics = stage6BishopMeasurementMetrics(points);
    if(!metrics) return;
    const a = stage6BishopWorldToScreen(metrics.a);
    const b = stage6BishopWorldToScreen(metrics.b);
    const label = stage6BishopMeasurementLabel(metrics);
    ctx.save();
    ctx.strokeStyle = options.preview ? 'rgba(181, 87, 36, 0.78)' : '#b55724';
    ctx.fillStyle = options.preview ? 'rgba(181, 87, 36, 0.12)' : '#b55724';
    ctx.lineWidth = options.preview ? 2 : 2.2;
    ctx.setLineDash(options.preview ? [7, 5] : []);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    [a, b].forEach((pt)=>{
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI*2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.strokeStyle = options.preview ? 'rgba(181, 87, 36, 0.78)' : '#b55724';
      ctx.lineWidth = options.preview ? 2 : 2.2;
    });
    const labelPos = stage6BishopWorldToScreen({
      x:metrics.mid.x,
      y:metrics.mid.y + Math.max(0.2, 12 / Math.max(bishop.viewport.scale || 24, 1))
    });
    ctx.font = '600 11px system-ui, sans-serif';
    const paddingX = 8;
    const paddingY = 5;
    const textWidth = ctx.measureText(label).width;
    const boxWidth = textWidth + paddingX * 2;
    const boxHeight = 24;
    const boxX = labelPos.x - boxWidth / 2;
    const boxY = labelPos.y - boxHeight / 2;
    ctx.fillStyle = options.preview ? 'rgba(255, 246, 237, 0.9)' : 'rgba(255, 246, 237, 0.96)';
    ctx.strokeStyle = options.preview ? 'rgba(181, 87, 36, 0.55)' : 'rgba(181, 87, 36, 0.9)';
    ctx.lineWidth = 1;
    if(typeof ctx.roundRect === 'function'){
      ctx.beginPath();
      ctx.roundRect(boxX, boxY, boxWidth, boxHeight, 6);
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
      ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);
    }
    ctx.fillStyle = '#6b3212';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, labelPos.x, labelPos.y);
    ctx.restore();
  };

  if(bishop.phreatic?.length >= 2) drawPolyline(bishop.phreatic, '#2f7fda', 2, [8, 5]);
  if(bishop.seepage?.display?.showDrains !== false){
    (bishop.drains || []).forEach((drain)=>{
      const selected = drain.id && drain.id === bishop.selectedDrainId;
      drawPolyline(drain.vertices || [], selected ? '#0b7285' : '#128a99', selected ? 3.5 : 2.5, []);
    });
  }
  if(bishop.draft?.length){
    const draftStroke = bishop.draftKind === 'phreatic'
      ? '#2f7fda'
      : bishop.draftKind === 'drain'
        ? '#128a99'
        : '#2d3a4a';
    drawPolyline(bishop.draft, draftStroke, 2, [6, 4]);
  }
  if(stage6BishopCanvasState.hoverWorld){
    if((bishop.tool === 'terrain' || bishop.tool === 'phreatic') && bishop.draft?.length){
      const last = bishop.draft[bishop.draft.length-1];
      const next = stage6BishopSnapWorldPoint(stage6BishopCanvasState.hoverWorld, 'free');
      if(next.x > last.x + 1e-6){
        drawPolyline([last, next], bishop.tool === 'phreatic' ? '#2f7fda' : '#2d3a4a', 1.5, [6, 4]);
      }
    }
    if(bishop.tool === 'drain' && bishop.draftKind === 'drain' && bishop.draft?.length){
      const last = bishop.draft[bishop.draft.length - 1];
      const next = stage6BishopSnapWorldPoint(stage6BishopCanvasState.hoverWorld, 'free');
      if(stage6BishopDist(last, next) > 1e-6){
        drawPolyline([last, next], '#128a99', 1.5, [6, 4]);
      }
    }
    if((bishop.tool === 'entry' || bishop.tool === 'exit' || bishop.tool === 'load') && bishop.draftKind === bishop.tool && bishop.draft?.length === 1 && bishop.terrain.length >= 2){
      const terrain = {vertices:bishop.terrain};
      const first = bishop.draft[0];
      const x = Math.min(Math.max(stage6BishopSnapWorldPoint(stage6BishopCanvasState.hoverWorld, 'terrain-x').x, bishop.terrain[0].x), bishop.terrain[bishop.terrain.length-1].x);
      const zone = stage6BishopSortZone({xStart:first.x, xEnd:x});
      if(stage6BishopValidZone(zone)){
        drawPolyline([
          {x:zone.xStart, y:bishopTerrainY(terrain, zone.xStart)},
          {x:zone.xEnd, y:bishopTerrainY(terrain, zone.xEnd)}
        ], stage6BishopZoneColor(bishop.tool), 4, [5, 4]);
      }
    }
    if((bishop.tool === 'region' || bishop.tool === 'regionHole') && (bishop.draftKind === 'region' || bishop.draftKind === 'regionHole') && bishop.draft?.length){
      const isHoleDraft = bishop.draftKind === 'regionHole';
      const next = stage6BishopSnapWorldPoint(stage6BishopCanvasState.hoverWorld, 'free');
      const preview = [...bishop.draft, next];
      if(preview.length >= 2){
        drawPolyline(preview, isHoleDraft ? '#b3477a' : '#2d3a4a', 1.5, [6, 4]);
      }
      if(preview.length >= 3){
        ctx.save();
        ctx.beginPath();
        preview.forEach((pt, index)=>{
          const s = stage6BishopWorldToScreen(pt);
          if(index === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
        ctx.fillStyle = isHoleDraft ? '#b3477a' : '#2d3a4a';
        ctx.globalAlpha = 0.08;
        ctx.fill();
        ctx.restore();
        const first = stage6BishopWorldToScreen(preview[0]);
        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = isHoleDraft ? '#b3477a' : '#2d3a4a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(first.x, first.y, 5, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
    if(bishop.tool === 'regionSplit'){
      const selectedRegion = stage6BishopSelectedCustomRegion();
      const splitDraft = bishop.draftKind === 'regionSplit' ? (bishop.draft || []) : [];
      splitDraft.forEach((pt, index)=>{
        const s = stage6BishopWorldToScreen(pt);
        ctx.save();
        ctx.fillStyle = index === 0 ? '#b3477a' : '#fff';
        ctx.strokeStyle = '#b3477a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      });
      if(selectedRegion && splitDraft.length === 1 && stage6BishopCanvasState.hoverWorld){
        const hoverCut = stage6BishopPickRegionBoundaryPoint(selectedRegion, stage6BishopCanvasState.hoverWorld);
        if(hoverCut){
          drawPolyline([splitDraft[0], hoverCut], '#b3477a', 2, [6, 4]);
        }
      }
    }
    if(bishop.tool === 'wall' && bishop.draftKind === 'wall' && bishop.draft?.length === 1){
      const top = bishop.draft[0];
      const tip = stage6BishopSnapWorldPoint(stage6BishopCanvasState.hoverWorld, 'free');
      drawWall({
        head:{x:top.x, y:top.y},
        tip:{x:tip.x, y:tip.y},
        x:top.x,
        yTop:top.y,
        yTip:tip.y,
        passiveSide:stage6BishopDefaultPassiveSide()
      }, {stroke:'#6a5841', width:3, dash:[6,4]});
    }
    if(bishop.tool === 'measure' && (bishop.measurement?.points || []).length === 1){
      drawMeasurementOverlay([
        bishop.measurement.points[0],
        stage6BishopSnapWorldPoint(stage6BishopCanvasState.hoverWorld, 'free')
      ], {preview:true});
    }
  }

  const zoneStroke = (zone, color, widthPx, dash)=>{
    if(!stage6BishopValidZone(zone) || bishop.terrain.length < 2) return;
    const pts = [
      {x:zone.xStart, y:bishopTerrainY({vertices:bishop.terrain}, zone.xStart)},
      {x:zone.xEnd, y:bishopTerrainY({vertices:bishop.terrain}, zone.xEnd)}
    ];
    drawPolyline(pts, color, widthPx || 5, dash);
  };
  zoneStroke(bishop.entryZone, stage6BishopZoneColor('entry'));
  zoneStroke(bishop.exitZone, stage6BishopZoneColor('exit'));
  (bishop.surfaceLoads || []).forEach((load, index)=>{
    const zone = stage6BishopSortZone(load);
    if(!stage6BishopValidZone(zone)) return;
    const q = stage6BishopEffectiveSurfaceLoadQ(load, workspace);
    const selectedLoad = load.id === bishop.selectedSurfaceLoadId;
    const active = load.active !== false && q > 0;
    const color = selectedLoad ? '#1f6feb' : stage6BishopZoneColor('load');
    if(selectedLoad){
      zoneStroke(zone, 'rgba(31, 111, 235, 0.22)', 12, []);
    }
    zoneStroke(zone, color, selectedLoad ? 6 : 4, active ? [] : [5, 4]);
    if(workspace !== 'deformation' || bishop.deformation?.display?.showLoadVectors !== false){
      drawLoadZoneMarkers(zone, q, color, {
        label: load.label || `Load ${index + 1}`,
        active,
        selected: selectedLoad
      });
    }
    if(selectedLoad){
      [zone.xStart, zone.xEnd].forEach((x)=>{
        const y = bishopTerrainY({vertices:bishop.terrain}, x);
        const screen = stage6BishopWorldToScreen({x, y});
        ctx.save();
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      });
    }
  });
  (bishop.walls || []).forEach((wall)=>drawWall(wall, wall.id === bishop.selectedWallId ? {stroke:'#127f9b', width:5} : {}));
  if(workspace === 'deformation'){
    (bishop.deformation?.result?.wallResults || bishop.deformation?.result?.retainingWallResults || []).forEach(drawWallResponse);
  }
  if((bishop.measurement?.points || []).length >= 2){
    drawMeasurementOverlay(bishop.measurement.points);
  }

  const results = bishop.results?.allResults || [];
  const keepBest = Math.min(results.length, bishop.search.keepBest || 10);
  if(workspace === 'stability'){
    if(bishop.progress?.running && bishop.progress.previewCircle){
      drawCircleArc(bishop.progress.previewCircle, 'rgba(58, 128, 212, 0.6)', 1.8, [8, 6]);
    }
    for(let i=Math.min(keepBest-1, results.length-1); i>=0; i-=1){
      const result = results[i];
      const color = i === (bishop.selectedResult || 0) ? '#d65252' : 'rgba(214, 82, 82, 0.16)';
      drawCircleArc(result.circle, color, i === (bishop.selectedResult || 0) ? 2.8 : 1.2);
    }

    const selected = stage6BishopSelectedResult();
    if(selected){
      selected.slices.forEach((slice)=>{
        const top = stage6BishopWorldToScreen({x:slice.xL, y:slice.yTopL});
        const base = stage6BishopWorldToScreen({x:slice.xL, y:slice.yBaseL});
        ctx.save();
        ctx.strokeStyle = 'rgba(34, 76, 120, 0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(base.x, base.y);
        ctx.stroke();
        ctx.restore();
      });
      (selected.wallForces || []).forEach((wallForce)=>{
        const application = stage6BishopWorldToScreen({x:wallForce.x, y:wallForce.y_application});
        const passiveNormal = wallForce.passiveNormal || wallNormalForSide(wallForce.wall, wallForce.wall?.passiveSide);
        const screenNormal = passiveNormal
          ? {x:passiveNormal.x, y:-passiveNormal.y}
          : {x:wallForce.wall?.passiveSide === 'left' ? -1 : 1, y:0};
        const labelAlign = screenNormal.x >= 0 ? 'left' : 'right';
        const tip = {
          x:application.x + screenNormal.x * 22,
          y:application.y + screenNormal.y * 22
        };
        const tangent = {x:-screenNormal.y, y:screenNormal.x};
        ctx.save();
        ctx.strokeStyle = '#b3477a';
        ctx.fillStyle = '#b3477a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(application.x, application.y);
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(tip.x, tip.y);
        ctx.lineTo(tip.x - screenNormal.x * 8 + tangent.x * 5, tip.y - screenNormal.y * 8 + tangent.y * 5);
        ctx.lineTo(tip.x - screenNormal.x * 8 - tangent.x * 5, tip.y - screenNormal.y * 8 - tangent.y * 5);
        ctx.closePath();
        ctx.fill();
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = labelAlign;
        ctx.fillText(`${wallForce.R_wall.toFixed(0)} kN/m`, tip.x + screenNormal.x * 4, tip.y + screenNormal.y * 4 - 6);
        ctx.restore();
      });
    }
  }

  if(bishop.terrain?.length >= 2) drawPolyline(bishop.terrain, '#2d3a4a', 3);

  if(workspace === 'seepage' && model && bishop.seepage?.display?.showBoundaryConditions !== false){
    const boundaryBlue = readCssToken('--chart-blue', '#4F8584');
    const boundaryGreen = readCssToken('--chart-green', '#3D6B6A');
    const boundaryNeutral = readCssToken('--chart-neutral', '#6b6b68');
    const boundary = S.stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model);
    const selectedBoundary = stage6BishopSelectedBoundaryEdge(model);
    const hoveredBoundary = stage6BishopHoveredSeepageEdge(model);
    boundary.forEach((edge)=>{
      const bc = stage6BishopSeepageBcForEdge(edge.edgeKey);
      const isSelected = selectedBoundary?.edgeKey === edge.edgeKey;
      const isHovered = hoveredBoundary?.edgeKey === edge.edgeKey;
      const stroke = bc?.type === 'head'
        ? boundaryBlue
        : bc?.type === 'seepage-face'
          ? boundaryGreen
          : boundaryNeutral;
      const dash = bc?.type === 'head' ? [] : bc?.type === 'seepage-face' ? [10, 6] : [7, 5];
      drawPolyline([edge.a, edge.b], stroke, isSelected ? 5 : isHovered ? 4 : 2.5, dash);
      if((isSelected || isHovered) && bc?.status !== 'orphaned'){
        drawPolyline([edge.a, edge.b], 'rgba(33,49,66,0.9)', 1.2, []);
      }
      if(bishop.seepage.display?.showBoundaryLabels !== false){
        const label = bc?.type === 'head'
          ? `h=${Number(bc.head ?? edge.mid.y).toFixed(2)} m`
          : bc?.type === 'seepage-face'
            ? 'h = y'
            : (isSelected ? 'no-flow' : '');
        if(label){
          const mid = stage6BishopWorldToScreen(edge.mid);
          ctx.save();
          ctx.font = '11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.lineWidth = 4;
          ctx.strokeStyle = canvasHaloColor;
          ctx.strokeText(label, mid.x, mid.y - 6);
          ctx.fillStyle = stroke;
          ctx.fillText(label, mid.x, mid.y - 6);
          ctx.restore();
        }
      }
    });
  }

  if(Number.isFinite(bishop.activeCptX) && bishop.terrain.length >= 2){
    const pt = {x:bishop.activeCptX, y:bishopTerrainY({vertices:bishop.terrain}, bishop.activeCptX)};
    const s = stage6BishopWorldToScreen(pt);
    ctx.save();
    ctx.fillStyle = '#7a2dd2';
    ctx.beginPath();
    ctx.arc(s.x, s.y, 6, 0, Math.PI*2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }

  if(bishop.tool === 'edit'){
    const handleSets = [
      ...(bishop.terrain || []),
      ...(bishop.phreatic || []),
      ...(bishop.walls || []).flatMap((wall)=>{
        const endpoints = wallEndpoints(wall);
        return endpoints ? [endpoints.head, endpoints.tip] : [];
      }),
      ...(bishop.drains || []).flatMap((drain)=>drain.vertices || []),
      ...((bishop.customRegions?.length ? stage6BishopSelectedCustomRegion()?.polygon : []) || [])
    ];
    handleSets.forEach((pt)=>{
      const s = stage6BishopWorldToScreen(pt);
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#1f2e40';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 4, 0, Math.PI*2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });
  }
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

function layerAtDepth(z, layers){
  const arr = layers || stage6WorkingLayers();
  if(!arr.length) return null;
  return arr.find(l=>z >= l.top && z < l.bot) || arr[arr.length-1];
}

function stage6BearingGeometry(cfg){
  const rawB = Math.max(cfg.B || 0.1, 0.1);
  const rawL = Math.max(cfg.L || rawB, 0.1);
  const eB = Math.max(0, Math.min(cfg.eB || 0, Math.max(rawB / 2 - 0.025, 0)));
  const eL = Math.max(0, Math.min(cfg.eL || 0, Math.max(rawL / 2 - 0.025, 0)));
  const effB = Math.max(rawB - 2 * eB, 0.05);
  const effL = Math.max(rawL - 2 * eL, 0.05);
  if((cfg.foundationType || 'strip') === 'strip'){
    return {
      B:effB,
      L:Math.max(effL, effB),
      BRaw:rawB,
      LRaw:Math.max(rawL, rawB),
      BEff:effB,
      LEff:Math.max(effL, effB),
      eB,
      eL,
      ratio:0,
      label:'strip'
    };
  }
  const shortSide = Math.max(Math.min(effB, effL), 0.05);
  const longSide = Math.max(effB, effL);
  return {
    B:shortSide,
    L:longSide,
    BRaw:rawB,
    LRaw:rawL,
    BEff:shortSide,
    LEff:longSide,
    eB,
    eL,
    ratio:Math.max(0, Math.min(shortSide / longSide, 1)),
    label:'rectangular'
  };
}

function stage6BearingShapeModeLabel(mode){
  return mode === 'conservative'
    ? 'Conservative (shape factors = 1.0)'
    : 'Brinch Hansen / Annex D';
}

function stage6BearingNgammaLabel(){
  return 'EC7 Annex D rough base';
}

function stage6BearingShapeModeDetailHtml(mode){
  if(mode === 'conservative'){
    return 'Shape factors are fixed at <code>1.0</code> in conservative mode.';
  }
  return "Shape factors follow the effective-dimension ratio <code>r = B'/L'</code>.";
}

function stage6BearingShapeModeDetailText(mode){
  if(mode === 'conservative'){
    return 'In conservative mode all shape factors are fixed at 1.0.';
  }
  return 'In Brinch Hansen / Annex D mode the shape factors follow the effective-dimension ratio r = B′/L′.';
}

function stage6BearingShapeFactors(geometry, phiDeg, Nq, mode){
  if(mode === 'conservative'){
    return {sc:1, sq:1, sg:1, scu:1};
  }
  const r = geometry?.ratio || 0;
  const phiRad = Math.max(phiDeg || 0, 0) * Math.PI / 180;
  const sq = 1 + r * Math.sin(phiRad);
  const sc = phiDeg > 0
    ? (sq * Nq - 1) / Math.max(Nq - 1, 1e-6)
    : 1 + 0.2 * r;
  return {
    sc,
    sq,
    sg:Math.max(0.6, 1 - 0.3 * r),
    scu:1 + 0.2 * r
  };
}

function stage6BearingDepthFactors(Df, B, phiDeg, Nc){
  const eta = Math.max(Df || 0, 0) / Math.max(B || 0.1, 0.1);
  const k = eta <= 1 ? eta : Math.atan(eta);
  if(phiDeg > 0){
    const phiRad = phiDeg * Math.PI / 180;
    const sinPhi = Math.sin(phiRad);
    const tanPhi = Math.tan(phiRad);
    const dq = 1 + 2 * tanPhi * (1 - sinPhi) ** 2 * k;
    return {
      eta,
      k,
      dq,
      dc:dq - (1 - dq) / (Math.max(Nc, 1e-6) * Math.max(tanPhi, 1e-6)),
      dg:1.0,
      dcu:1 + 0.4 * k
    };
  }
  return {
    eta,
    k,
    dq:1.0,
    dc:1 + 0.4 * k,
    dg:1.0,
    dcu:1 + 0.4 * k
  };
}

// Backward-compatible alias for any external callers that still expect
// the old helper name on the legacy window API.
const stage6ShapeFactors = stage6BearingShapeFactors;

function stage6BearingNgamma(phiDeg, Nq){
  if(!(phiDeg > 0)) return 0;
  const phiRad = phiDeg * Math.PI / 180;
  return Math.max(0, 2 * Math.max(Nq - 1, 0) * Math.tan(phiRad));
}

function stage6UsesEc7Factors(cfg){
  return (cfg.factorMode || 'ec7') === 'ec7';
}

function stage6CapacityLabel(cfg){
  return stage6UsesEc7Factors(cfg) ? 'q_d' : 'q_allow';
}

function stage6FactorLabel(cfg){
  return stage6UsesEc7Factors(cfg) ? 'γ_Rd' : 'ξ';
}

function stage6FactorValue(cfg){
  if(stage6UsesEc7Factors(cfg)) return Math.max(cfg.gammaRd || 1, 0.1);
  return Math.max(cfg.xi || 1, 0.1);
}

function stage6BearingEc7Keys(mode){
  if(mode === 'da1_1') return ['da1_1'];
  if(mode === 'da1_2') return ['da1_2'];
  return ['da1_1', 'da1_2'];
}

function stage6BearingEc7Spec(key){
  if(key === 'da1_1'){
    return {
      key,
      label:'DA1/1',
      soilSet:'M1',
      gammaMphi:1.00,
      gammaMc:1.00,
      gammaMcu:1.00
    };
  }
  return {
    key:'da1_2',
    label:'DA1/2',
    soilSet:'M2',
    gammaMphi:1.25,
    gammaMc:1.25,
    gammaMcu:1.40
  };
}

function stage6NoteHtml(notes){
  if(!notes || !notes.length) return '';
  return notes.map(note=>{
    const color = note.level === 'warn' ? 'var(--wn)' : note.level === 'error' ? 'var(--bad)' : 'var(--ac)';
    const bg = note.level === 'warn' ? 'var(--wnl)' : note.level === 'error' ? 'var(--bad-soft)' : 'var(--bg2)';
    return `<div class="info" style="margin-top:8px;background:${bg};border-color:${color}">${note.text}</div>`;
  }).join('');
}

function stage6EscAttr(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stage6EscJsString(value){
  return stage6EscAttr(JSON.stringify(String(value ?? '')));
}

function stage6Tooltip(text){
  const safe = stage6EscAttr(text);
  return `<span class="st6-tip" tabindex="0" data-tip="${safe}" aria-label="${safe}">ⓘ</span>`;
}

function stage6UseCategoryOptions(selected){
  const labels = {
    A:'A - residential / domestic',
    B:'B - offices',
    C:'C - assembly / congregation',
    D:'D - shopping / commercial',
    E:'E - storage',
    W:'W - wind',
    S:'S - snow',
    T:'T - temperature'
  };
  return ['A','B','C','D','E','W','S','T']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

function stage6UseCategoryHelp(selected){
  const text = {
    A:'Residential and domestic imposed loads. Typical default for houses and small residential slabs.',
    B:'Office loading. Use when the supported structure behaves like an office floor or office occupancy.',
    C:'Assembly / congregation loading. Higher variable load factors for halls, schools, and gathering spaces.',
    D:'Shopping and retail loading. Similar to C but framed for commercial occupancy.',
    E:'Storage / warehouse loading. Highest default psi factors of the building-use categories.',
    W:'Wind action. Only use when the variable action is wind rather than occupancy load.',
    S:'Snow action. Belgian lowland snow defaults.',
    T:'Temperature action. Only use if temperature effects govern the variable action.'
  };
  return text[selected] || text.A;
}

function stage6SlsCombinationOptions(selected){
  const labels = {
    qp:'Quasi-permanent',
    frequent:'Frequent',
    characteristic:'Characteristic'
  };
  return ['qp','frequent','characteristic']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

function stage6SlsCombinationHelp(selected, context){
  const prefix = context === 'settlement'
    ? 'For settlement'
    : context === 'beam'
      ? 'For deflection'
      : 'For serviceability';
  const text = {
    qp:`${prefix}, quasi-permanent is the usual default for long-term behaviour and is the recommended starting point.`,
    frequent:`${prefix}, frequent is useful for intermediate serviceability checks when the variable action is present often but not permanently.`,
    characteristic:`${prefix}, characteristic is the better fit for short-term or immediate response checks and is usually less relevant for long-term consolidation.`
  };
  return text[selected] || text.qp;
}

function stage6DewateringCombinationOptions(selected){
  const labels = {
    characteristic:'Characteristic drawdown',
    qp:'Quasi-permanent drawdown context'
  };
  return ['characteristic','qp'].map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`).join('');
}

function stage6DewateringCombinationHelp(selected){
  if(selected === 'qp'){
    return 'Quasi-permanent is useful as a contextual serviceability label when the lowered water level is expected to persist for a long period. In the current tool, the entered drawdown itself is still used directly.';
  }
  return 'Characteristic is the recommended default here: enter the expected drawdown directly and do not factor it as a ULS variable load.';
}

function stage6BeamUlsOptions(selected){
  const labels = {
    A1:'A1 - Eq. 6.10, ordinary building gravity default',
    A2:'A2 - alternative action set'
  };
  return ['A1','A2'].map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`).join('');
}

function stage6BeamUlsHelp(selected){
  if(selected === 'A2'){
    return 'A2 is an alternative action set. For ordinary Belgian building gravity loading in this beam/slab screening tool, A1 is usually the safer and more standard starting point.';
  }
  return 'A1 is the recommended default here for ordinary Belgian building loading when deriving the ULS beam moment for reinforcement.';
}

function stage6BeamLoadPatternHelp(selected){
  const text = {
    uniform_full:'Uniform full length applies the same line load along the whole x direction. For a long uniform strip this is effectively the infinite/uniform case: settlement is meaningful, while longitudinal bending can legitimately be almost zero.',
    uniform_patch:'Uniform patch applies a line load only between patch start x and patch end x. Use it for a loaded slab bay, machine strip, wall contact width in transverse footing mode, or any local zone that should create bending along x.',
    point_centre:'Point load at centre is a localised strip/beam check. Use it for a concentrated reaction or local heavy point action applied at midspan.',
    point_at_x:'Point load at x is the same localised check, but at a chosen position along the strip so you can inspect edge-near or eccentric loading.'
  };
  return text[selected] || text.uniform_full;
}

function stage6BeamModelModeOptions(selected){
  const labels = {
    slab_strip:'x = slab strip direction',
    beam_length:'x = along wall / beam length',
    footing_transverse:'x = across footing width'
  };
  return ['slab_strip','beam_length','footing_transverse']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

function stage6BeamModelModeLabel(selected){
  const labels = {
    slab_strip:'1 m slab strip',
    beam_length:'Along wall / beam length',
    footing_transverse:'Across footing width'
  };
  return labels[selected] || labels.slab_strip;
}

function stage6BeamAxisCopy(selected){
  const mode = ['slab_strip','beam_length','footing_transverse'].includes(selected) ? selected : 'slab_strip';
  const copy = {
    slab_strip: {
      prompt: '1D bending is solved only along x. For a slab strip, x is the checked slab direction and b is normally 1.00 m.',
      summary: 'x = checked slab strip direction',
      canvasMode: 'x: slab strip direction, b: unit strip width',
      LLabel: 'Analysis length L along slab x (m)',
      LTip: 'L is the in-plan length of the checked slab strip in the x direction.',
      bLabel: 'Strip width b along y (m)',
      bTip: 'b is the strip width perpendicular to x. Keep b = 1.00 m when you want kNm/m and mm2/m output.',
      BLabel: 'Bearing width B for k_s (m)',
      BTip: 'B is the characteristic contact width used only to derive k_s from the CPT stiffness profile. For slab-strip screening it is the width you want the Vesić support conversion to represent.',
      hLabel: 'Slab thickness h along z (m)'
    },
    beam_length: {
      prompt: '1D bending is solved only along x. Here x runs along the wall or beam; local patch or point loads create the useful bending case.',
      summary: 'x = foundation / wall run',
      canvasMode: 'x: wall/beam run, b: contact width',
      LLabel: 'Run length L along wall / beam x (m)',
      LTip: 'L is the length along the wall, strip, or beam run. A full-length uniform load mainly checks settlement; patch or point loads create local bending along this run.',
      bLabel: 'Contact width b across the run (m)',
      bTip: 'b is the physical strip/contact width perpendicular to the wall or beam run. It is used in I = b*h^3/12, k_s*b, and the reinforcement width b_w.',
      BLabel: 'Bearing width B for k_s (m)',
      BTip: 'B is the real bearing/contact width used in the subgrade-reaction calculation. For a beam along its length this often equals the physical contact width b, but it is entered separately so you can audit the assumption.',
      hLabel: 'Section height h along z (m)'
    },
    footing_transverse: {
      prompt: '1D bending is solved only along x. Here x runs across the footing width; b is the out-of-plane slice along the wall, often 1.00 m.',
      summary: 'x = transverse footing width',
      canvasMode: 'x: across footing width, b: slice along wall',
      LLabel: 'Footing width L across wall x (m)',
      LTip: 'L is the footing width across the wall or line load. Use this mode when the ordinary strip-footing bending check is transverse rather than along the wall length.',
      bLabel: 'Out-of-plane strip width b along wall (m)',
      bTip: 'b is the model slice width along the wall. Use b = 1.00 m for a conventional per-meter strip-footing check.',
      BLabel: 'Bearing width B for k_s (m)',
      BTip: 'B is the support width used in the k_s derivation. In transverse strip-footing mode this normally matches the footing width across the wall.',
      hLabel: 'Footing height h along z (m)'
    }
  };
  return copy[mode];
}

function stage6BeamMomentContextHelp(cfg){
  const pattern = cfg.loadPattern || 'uniform_full';
  if(pattern === 'uniform_full'){
    return 'Full-length uniform loading is mainly a settlement case in this 1D model; longitudinal bending can be near zero because soil reaction balances the load almost uniformly.';
  }
  return 'Patch and point loads make the strip redistribute load into the soil. Increasing h raises EI, so M_Ed can increase even while deflection drops.';
}

function stage6BeamOrientationHtml(cfg, analysis){
  const mode = cfg.modelMode || 'slab_strip';
  const axis = stage6BeamAxisCopy(mode);
  return `
    <label style="font-size:11px;color:var(--tx2)">Analysis direction${stage6Tooltip('The equations are one-dimensional. This choice defines what the x direction means before you enter L, b, B, loads, and patch positions.')}
      <select onchange="setStage6Field('beam.modelMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
        ${stage6BeamModelModeOptions(mode)}
      </select>
    </label>
    <div class="st6-help">${axis.prompt}</div>
  `;
}

function stage6BearingEc7Options(selected){
  const labels = {
    governing:'Governing of DA1/1 and DA1/2 (Recommended)',
    da1_1:'DA1/1 - action-factored route',
    da1_2:'DA1/2 - M2 soil-strength route'
  };
  return ['governing','da1_1','da1_2']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

function stage6BearingEc7Help(selected){
  const text = {
    governing:'Belgian EC7 bearing checks should normally review both DA1/1 and DA1/2; the governing result is the recommended default in this tool.',
    da1_1:'DA1/1 keeps soil strengths characteristic and is useful when you want to inspect the action-factored side on its own.',
    da1_2:'DA1/2 applies the M2 reduction to soil strengths and often governs geotechnical bearing resistance; inspect it directly if you want to understand the soil-side penalty.'
  };
  return text[selected] || text.governing;
}

function stage6BearingShapeModeOptions(selected){
  const labels = {
    hansen:'Brinch Hansen / Annex D (Recommended)',
    conservative:'Conservative (shape factors = 1.0)'
  };
  return ['hansen','conservative']
    .map(v=>`<option value="${v}"${selected===v?' selected':''}>${labels[v]}</option>`)
    .join('');
}

function stage6BearingShapeModeHelp(selected){
  if(selected === 'conservative'){
    return 'Conservative mode keeps all shape factors equal to 1.0. Depth factors still apply, but plan-shape enhancement is suppressed.';
  }
  return 'Brinch Hansen / Annex D mode derives the shape factors from the effective plan ratio r = B′/L′ after eccentricity. This is the default and recommended mode.';
}

function stage6ExposureOptions(selected){
  return Object.entries(EC2_EXPOSURE_META)
    .map(([key, meta])=>`<option value="${key}"${selected===key?' selected':''}>${key} - ${meta.label}</option>`)
    .join('');
}

function stage6ExposureHelp(selected){
  const meta = EC2_EXPOSURE_META[selected] || EC2_EXPOSURE_META.XC2;
  return meta.hint;
}

function stage6AuditTableHtml(rows){
  return `
    <table class="tbl st6-audit">
      <thead><tr>${rows.map(r=>`<th>${r.k}</th>`).join('')}</tr></thead>
      <tbody><tr>${rows.map(r=>`<td>${r.v}</td>`).join('')}</tr></tbody>
    </table>
  `;
}

function stage6LoadSummaryHtml(title, rows){
  return `
    <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
      <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">${title}</div>
      ${stage6AuditTableHtml(rows)}
    </div>
  `;
}

function stage6CompactNumber(value, digits = 2){
  const n = Number(value);
  if(!Number.isFinite(n)) return '—';
  if(n === 0) return '0';
  const abs = Math.abs(n);
  if(abs < 1e-2 || abs >= 1e4){
    return n.toExponential(Math.max(0, digits - 1)).replace('e', 'E');
  }
  if(abs >= 100) return n.toFixed(1).replace(/\.0$/, '');
  if(abs >= 10) return n.toFixed(2).replace(/\.?0+$/, '');
  if(abs >= 1) return n.toFixed(3).replace(/\.?0+$/, '');
  return n.toFixed(4).replace(/\.?0+$/, '');
}

function stage6BeamDurabilityHtml(reinf){
  const d = reinf.durability;
  const lines = [
    {k:'Exposure class', v:`${d.exposureClass} - ${d.exposureMeta.label}`},
    {k:'Structural class', v:`S${d.structuralClass}`},
    {k:'c_min,dur', v:`${d.cMinDur.toFixed(0)} mm`},
    {k:'c_min,b', v:`${d.cMinB.toFixed(0)} mm`},
    {k:'c_min', v:`${d.cMin.toFixed(0)} mm`},
    {k:'Δc_dev', v:`${d.deltaCdev.toFixed(0)} mm`},
    {k:'Ground-cast extra', v:`${d.unevenExtra.toFixed(0)} mm`},
    {k:'Ground-cast floor', v:`${d.floor.toFixed(0)} mm`},
    {k:'c_nom raw', v:`${d.cNomRaw.toFixed(0)} mm`},
    {k:'c_nom recommended', v:`${d.recommendedCNom.toFixed(0)} mm`},
    {k:'c_nom used', v:`${d.cNom.toFixed(0)} mm`}
  ];
  const structuralDetail = d.structuralAdjustments.length
    ? d.structuralAdjustments.join(' ')
    : 'Default 50-year EC2 structural class S4, with no additional modifiers applied.';
  const fallbackText = d.fallbackExposure
    ? `For ${d.exposureClass}, EC2 cover uses the corrosion fallback ${d.tableExposure}. Concrete mix requirements for XF/XA remain an engineer check outside this tool.`
    : '';
  return `
    <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
      <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">EC2 durability audit</div>
      <table class="pt">
        ${lines.map(row=>`<tr><td>${row.k}</td><td>${row.v}</td></tr>`).join('')}
      </table>
      <div style="margin-top:8px;font-size:11px;color:var(--tx2);line-height:1.55">
        ${d.exposureMeta.hint}<br>
        High-strength threshold for this exposure = <strong>${d.highStrengthThreshold.toFixed(0)} MPa</strong>; auto check = <strong>${d.autoHighStrength ? 'applied' : 'not applied'}</strong>.<br>
        ${structuralDetail}
        ${fallbackText ? `<br>${fallbackText}` : ''}
      </div>
    </div>
  `;
}

function stage6BearingNotes(sel, cfg){
  const notes = [{
    level:'warn',
    text:'Bearing capacity is shown as a shallow-foundation screening curve using the interpreted layer active at each founding depth. Layered failure mechanisms and full eccentric-load verification are not modeled here.'
  }];
  notes.push({
    level:'info',
    text:`The current bearing check uses ${sel.ngammaFormulaLabel} for Nγ and ${sel.shapeModeLabel} for shape factors. ${stage6BearingShapeModeDetailText(sel.shapeMode)} It includes Df/B′ depth factors, but it still assumes level ground, horizontal base, and no horizontal load.`
  });
  if(stage6UsesEc7Factors(cfg)){
    notes.push({
      level:'info',
      text:'Belgian bearing checks should normally review both DA1/1 and DA1/2; the governing result is the recommended default in this tool.'
    });
    notes.push({
      level:'warn',
      text:'gamma_Rd is kept as an optional model factor only. Leave it at 1.0 unless you intentionally want an extra correction for simplified analytical model bias.'
    });
  } else {
    notes.push({level:'warn', text:'Global/system factor ξ is a legacy-style screening route. Keep it separate from the EC7 partial-factor route and do not stack them.'});
  }
  if(sel.layer.type === 'Sandy clay' || sel.layer.type === 'Peat / organic'){
    notes.push({level:'info', text:'Mixed or organic layers can govern with undrained behaviour. Review both curves before accepting a founding depth.'});
  }
  return notes;
}

function bearingAtDepth(z, cfg, layers){
  const arr = layers || stage6WorkingLayers();
  const l = layerAtDepth(z, arr);
  if(!l) return null;
  const stress = effectiveVerticalStressAtDepth(arr, z, S.wt, stage6Constants().gammaW);
  const geo = stage6BearingGeometry(cfg);
  const B = geo.B;
  const phiK = Math.max(l.phi || 0, 0);
  const cK = Math.max(l.c || 0, 0);
  const cuK = Math.max(l.cu || 0, 0);
  const useEc7 = stage6UsesEc7Factors(cfg);
  const gammaEff = z <= S.wt ? l.g : Math.max((l.gs || l.g) - stage6Constants().gammaW, 1.0);
  const qDrain = Math.max(stress.sigmaEff, 0);
  const qUndrain = Math.max(stress.sigmaV, 0);
  const factor = stage6FactorValue(cfg);
  const shapeMode = cfg.shapeMode || 'hansen';
  let drainedCalc = null;
  let undrainedCalc = null;
  let ec7Results = [];
  if(useEc7){
    ec7Results = stage6BearingEc7Keys(cfg.ec7Combination || 'governing').map(key=>{
      const spec = stage6BearingEc7Spec(key);
      const designed = designSoilLayer(l, spec.soilSet);
      const phiD = Math.max(designed.phi || 0, 0);
      const cD = Math.max(designed.c || 0, 0);
      const cuD = Math.max(designed.cu || 0, 0);
      const phiDRad = phiD * Math.PI / 180;
      const tanPhi = Math.tan(phiDRad);
      const Nq = phiD > 0 ? Math.exp(Math.PI * tanPhi) * Math.tan(Math.PI/4 + phiDRad/2)**2 : 1;
      const Nc = phiD > 0 ? (Nq - 1) / Math.max(tanPhi, 1e-6) : 5.14;
      const Ng = stage6BearingNgamma(phiD, Nq);
      const shp = stage6BearingShapeFactors(geo, phiD, Nq, shapeMode);
      const dep = stage6BearingDepthFactors(z, B, phiD, Nc);
      const undShp = stage6BearingShapeFactors(geo, 0, 1, shapeMode);
      const undDep = stage6BearingDepthFactors(z, B, 0, 5.14);
      const qultDrained = Math.max(0, cD * Nc * shp.sc * dep.dc + qDrain * Nq * shp.sq * dep.dq + 0.5 * gammaEff * geo.BEff * Ng * shp.sg * dep.dg);
      const qultUndrained = Math.max(0, qUndrain + 5.14 * cuD * undShp.scu * undDep.dcu);
      const qdDrained = qultDrained / factor;
      const qdUndrained = qultUndrained / factor;
      return {
        ...spec,
        phiD, cD, cuD, Nq, Nc, Ng,
        shape:shp,
        depth:dep,
        undrainedShape:undShp,
        undrainedDepth:undDep,
        shapeModeLabel:stage6BearingShapeModeLabel(shapeMode),
        ngammaFormulaLabel:stage6BearingNgammaLabel(),
        qultDrained, qultUndrained, qdDrained, qdUndrained
      };
    });
    drainedCalc = ec7Results.reduce((best, item)=>
      !best || item.qdDrained < best.qdDrained ? item : best
    , null);
    undrainedCalc = ec7Results.reduce((best, item)=>
      !best || item.qdUndrained < best.qdUndrained ? item : best
    , null);
  } else {
    const phiD = phiK;
    const cD = cK;
    const cuD = cuK;
    const phiDRad = phiD * Math.PI / 180;
    const tanPhi = Math.tan(phiDRad);
    const Nq = phiD > 0 ? Math.exp(Math.PI * tanPhi) * Math.tan(Math.PI/4 + phiDRad/2)**2 : 1;
    const Nc = phiD > 0 ? (Nq - 1) / Math.max(tanPhi, 1e-6) : 5.14;
    const Ng = stage6BearingNgamma(phiD, Nq);
    const shp = stage6BearingShapeFactors(geo, phiD, Nq, shapeMode);
    const dep = stage6BearingDepthFactors(z, B, phiD, Nc);
    const undShp = stage6BearingShapeFactors(geo, 0, 1, shapeMode);
    const undDep = stage6BearingDepthFactors(z, B, 0, 5.14);
    const qultDrained = Math.max(0, cD * Nc * shp.sc * dep.dc + qDrain * Nq * shp.sq * dep.dq + 0.5 * gammaEff * geo.BEff * Ng * shp.sg * dep.dg);
    const qultUndrained = Math.max(0, qUndrain + 5.14 * cuD * undShp.scu * undDep.dcu);
    drainedCalc = undrainedCalc = {
      label:'Global SF',
      soilSet:'M1',
      gammaMphi:1,
      gammaMc:1,
      gammaMcu:1,
      phiD, cD, cuD, Nq, Nc, Ng,
      shape:shp,
      depth:dep,
      undrainedShape:undShp,
      undrainedDepth:undDep,
      shapeModeLabel:stage6BearingShapeModeLabel(shapeMode),
      ngammaFormulaLabel:stage6BearingNgammaLabel(),
      qultDrained, qultUndrained,
      qdDrained: qultDrained / factor,
      qdUndrained: qultUndrained / factor
    };
  }
  const qdDrained = drainedCalc.qdDrained;
  const qdUndrained = undrainedCalc.qdUndrained;
  return{
    layer:l,
    z,
    B:+B.toFixed(2),
    L:+geo.L.toFixed(2),
    BRaw:+geo.BRaw.toFixed(2),
    LRaw:+geo.LRaw.toFixed(2),
    BEff:+geo.BEff.toFixed(2),
    LEff:+geo.LEff.toFixed(2),
    eB:+geo.eB.toFixed(2),
    eL:+geo.eL.toFixed(2),
    r:+geo.ratio.toFixed(3),
    eta:+drainedCalc.depth.eta.toFixed(3),
    k:+drainedCalc.depth.k.toFixed(3),
    sigV:+stress.sigmaV.toFixed(1),
    sigVeff:+stress.sigmaEff.toFixed(1),
    qDrain:+qDrain.toFixed(1),
    qUndrain:+qUndrain.toFixed(1),
    gammaEff:+gammaEff.toFixed(2),
    phiK:+phiK.toFixed(1),
    phiD:+drainedCalc.phiD.toFixed(1),
    cK:+cK.toFixed(1),
    cD:+drainedCalc.cD.toFixed(1),
    cuK:+cuK.toFixed(1),
    cuD:+undrainedCalc.cuD.toFixed(1),
    drainedComboLabel:useEc7 ? drainedCalc.label : 'Global SF',
    undrainedComboLabel:useEc7 ? undrainedCalc.label : 'Global SF',
    gammaMphi:+drainedCalc.gammaMphi.toFixed(2),
    gammaMc:+drainedCalc.gammaMc.toFixed(2),
    gammaMcu:+undrainedCalc.gammaMcu.toFixed(2),
    useEc7,
    gammaRd:+(cfg.gammaRd || 1).toFixed(2),
    xi:+(cfg.xi || 1).toFixed(2),
    ec7CombinationMode:cfg.ec7Combination || 'governing',
    ec7CombinationLabel:useEc7
      ? drainedCalc.label === undrainedCalc.label
        ? drainedCalc.label
        : `drained ${drainedCalc.label} / undrained ${undrainedCalc.label}`
      : null,
    ec7Results:ec7Results.map(item=>({
      label:item.label,
      qdDrained:+item.qdDrained.toFixed(1),
      qdUndrained:+item.qdUndrained.toFixed(1)
    })),
    capacityLabel:stage6CapacityLabel(cfg),
    factorLabel:stage6FactorLabel(cfg),
    shapeMode:shapeMode,
    shapeModeLabel:drainedCalc.shapeModeLabel,
    ngammaFormulaLabel:drainedCalc.ngammaFormulaLabel,
    Nc:+drainedCalc.Nc.toFixed(3),
    Nq:+drainedCalc.Nq.toFixed(3),
    Ng:+drainedCalc.Ng.toFixed(3),
    sc:+drainedCalc.shape.sc.toFixed(2),
    sq:+drainedCalc.shape.sq.toFixed(2),
    sg:+drainedCalc.shape.sg.toFixed(2),
    scu:+undrainedCalc.undrainedShape.scu.toFixed(2),
    dc:+drainedCalc.depth.dc.toFixed(2),
    dq:+drainedCalc.depth.dq.toFixed(2),
    dg:+drainedCalc.depth.dg.toFixed(2),
    dcu:+undrainedCalc.undrainedDepth.dcu.toFixed(2),
    factor:+factor.toFixed(2),
    qultDrained:+drainedCalc.qultDrained.toFixed(1),
    qultUndrained:+undrainedCalc.qultUndrained.toFixed(1),
    qdDrained:+qdDrained.toFixed(1),
    qdUndrained:+qdUndrained.toFixed(1),
    utilDrained: cfg.load > 0 ? +(cfg.load / Math.max(qdDrained, 1e-6)).toFixed(2) : null,
    utilUndrained: cfg.load > 0 ? +(cfg.load / Math.max(qdUndrained, 1e-6)).toFixed(2) : null
  };
}

function bearingProfile(cfg, layers){
  const arr = layers || stage6WorkingLayers();
  if(!arr.length) return null;
  const maxDepth = arr[arr.length-1].bot;
  const step = Math.max(0.1, Math.min(0.25, maxDepth / 60));
  const depths = [];
  for(let z = Math.max(cfg.Df, 0.2); z <= maxDepth + 1e-9; z += step){
    depths.push(+z.toFixed(3));
  }
  if(!depths.length || depths[0] !== +cfg.Df.toFixed(3)) depths.unshift(+cfg.Df.toFixed(3));
  const pts = depths.map(z=>bearingAtDepth(z, cfg, arr)).filter(Boolean);
  const selected = bearingAtDepth(cfg.Df, cfg, arr);
  return{
    pts,
    selected,
    drained:pts.map(p=>({x:p.qdDrained, y:p.z})),
    undrained:pts.map(p=>({x:p.qdUndrained, y:p.z})),
    maxDepth
  };
}

function stage6BearingSelectedDepthHtml(sel, governing, governingMode){
  return `
    <table class="pt" style="margin-bottom:12px">
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Selected depth</td></tr>
      <tr><td>Df</td><td>${sel.z.toFixed(2)} m</td></tr>
      <tr><td>Layer</td><td>${sel.layer.type}</td></tr>
      <tr><td>Subtype</td><td>${sel.layer.subtype||'—'}</td></tr>
      ${sel.useEc7 ? `<tr><td>Belgian EC7 envelope</td><td>${sel.ec7CombinationLabel}</td></tr>` : `<tr><td>Safety route</td><td>Global system factor</td></tr>`}
      <tr><td>σ'v</td><td>${sel.sigVeff.toFixed(1)} kPa</td></tr>
      <tr><td>Applied stress</td><td>${sel.utilDrained!=null?`${sel.utilDrained.toFixed(2)} · drained / ${sel.utilUndrained.toFixed(2)} · undrained`:'—'}</td></tr>
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--chart-green);padding:4px 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);text-transform:uppercase">Drained</td></tr>
      ${sel.useEc7 ? `<tr><td>Governing combo</td><td>${sel.drainedComboLabel}</td></tr>` : ''}
      <tr><td>q_ult</td><td>${sel.qultDrained.toLocaleString()} kPa</td></tr>
      <tr><td>${sel.capacityLabel}</td><td>${sel.qdDrained.toLocaleString()} kPa</td></tr>
      <tr><td>utilisation</td><td>${sel.utilDrained!=null?sel.utilDrained.toFixed(2):'—'}</td></tr>
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--chart-orange);padding:4px 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);text-transform:uppercase">Undrained</td></tr>
      ${sel.useEc7 ? `<tr><td>Governing combo</td><td>${sel.undrainedComboLabel}</td></tr>` : ''}
      <tr><td>q_ult</td><td>${sel.qultUndrained.toLocaleString()} kPa</td></tr>
      <tr><td>${sel.capacityLabel}</td><td>${sel.qdUndrained.toLocaleString()} kPa</td></tr>
      <tr><td>utilisation</td><td>${sel.utilUndrained!=null?sel.utilUndrained.toFixed(2):'—'}</td></tr>
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:var(--tx2);padding:4px 0;border-top:1px solid var(--bd);text-transform:uppercase">Governing</td></tr>
      <tr><td>Mode</td><td>${governingMode}</td></tr>
      <tr><td>${sel.capacityLabel}</td><td>${governing.toLocaleString()} kPa</td></tr>
    </table>
  `;
}

function stage6BearingMaterialParamsHtml(sel, cfg){
  if(!sel.useEc7){
    return `
      <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Global safety-factor route at selected depth</div>
      <table class="pt">
        <tr><td>φ'k</td><td>${sel.phiK.toFixed(1)}°</td><td>c'k</td><td>${sel.cK.toFixed(1)} kPa</td><td>cu,k</td><td>${sel.cuK.toFixed(1)} kPa</td></tr>
        <tr><td>γ'</td><td>${sel.gammaEff.toFixed(2)} kN/m³</td><td>ξ</td><td>${cfg.xi.toFixed(2)}</td><td>Route</td><td>Global SF</td></tr>
        <tr><td>B / L</td><td>${sel.BRaw.toFixed(2)} / ${sel.LRaw.toFixed(2)} m</td><td>eB / eL</td><td>${sel.eB.toFixed(2)} / ${sel.eL.toFixed(2)} m</td><td>Route</td><td>${sel.shapeModeLabel}</td></tr>
        <tr><td>B' / L'</td><td>${sel.BEff.toFixed(2)} / ${sel.LEff.toFixed(2)} m</td><td>r</td><td>${sel.r.toFixed(3)}</td><td>k</td><td>${sel.k.toFixed(3)}</td></tr>
      </table>
      <div style="margin-top:8px;font-size:11px;color:var(--tx2);line-height:1.5">
        Characteristic soil parameters are used directly. The global/system factor ξ is applied on the output resistance only and is not combined with γ_R or γ_M.<br>
        Nγ uses the <strong>${sel.ngammaFormulaLabel}</strong> form. Shape factors follow <strong>${sel.shapeModeLabel}</strong>. ${stage6BearingShapeModeDetailHtml(sel.shapeMode)}
      </div>
    `;
  }
  return `
    <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Belgian EC7 DA1 parameters used at selected depth</div>
    <table class="pt">
      <tr><td>Drained combo</td><td>${sel.drainedComboLabel}</td><td>Undrained combo</td><td>${sel.undrainedComboLabel}</td><td>γ_Rd</td><td>${cfg.gammaRd.toFixed(2)}</td></tr>
      <tr><td>φ'k</td><td>${sel.phiK.toFixed(1)}°</td><td>γ_M,φ</td><td>${sel.gammaMphi.toFixed(2)}</td><td>φ'd</td><td>${sel.phiD.toFixed(1)}°</td></tr>
      <tr><td>c'k</td><td>${sel.cK.toFixed(1)} kPa</td><td>γ_M,c'</td><td>${sel.gammaMc.toFixed(2)}</td><td>c'd</td><td>${sel.cD.toFixed(1)} kPa</td></tr>
      <tr><td>cu,k</td><td>${sel.cuK.toFixed(1)} kPa</td><td>γ_M,cu</td><td>${sel.gammaMcu.toFixed(2)}</td><td>cu,d</td><td>${sel.cuD.toFixed(1)} kPa</td></tr>
      <tr><td>γ'</td><td>${sel.gammaEff.toFixed(2)} kN/m³</td><td>Combo mode</td><td>${cfg.ec7Combination === 'governing' ? 'most onerous' : cfg.ec7Combination.toUpperCase().replace('_','/')}</td><td>R set</td><td>R1</td></tr>
      <tr><td>B / L</td><td>${sel.BRaw.toFixed(2)} / ${sel.LRaw.toFixed(2)} m</td><td>eB / eL</td><td>${sel.eB.toFixed(2)} / ${sel.eL.toFixed(2)} m</td><td>Shape route</td><td>${sel.shapeModeLabel}</td></tr>
      <tr><td>B' / L'</td><td>${sel.BEff.toFixed(2)} / ${sel.LEff.toFixed(2)} m</td><td>r</td><td>${sel.r.toFixed(3)}</td><td>Nγ</td><td>${sel.ngammaFormulaLabel}</td></tr>
    </table>
    ${sel.ec7Results && sel.ec7Results.length > 1 ? `
      <div style="margin-top:8px;font-size:11px;color:var(--tx2);line-height:1.55">
        DA1 overview: ${sel.ec7Results.map(r=>`${r.label}: drained ${r.qdDrained.toFixed(0)} kPa, undrained ${r.qdUndrained.toFixed(0)} kPa`).join(' · ')}
      </div>
    ` : ''}
  `;
}

function stage6BearingDrainedFormulaHtml(sel){
  return `
    <div style="font-size:10px;font-weight:700;color:var(--chart-green);text-transform:uppercase;margin-bottom:6px">Drained formula at selected depth</div>
    <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
      q_ult,d = c'·N_c·s_c·d_c + q'·N_q·s_q·d_q + 0.5·γ'·B'·N_γ·s_γ·d_γ
    </div>
    <div style="font-size:11px;color:var(--tx2);line-height:1.55">
      φ'k = <strong>${sel.phiK.toFixed(1)}°</strong>${sel.useEc7?` → φ'd = <strong>${sel.phiD.toFixed(1)}°</strong>`:''}<br>
      c'k = <strong>${sel.cK.toFixed(1)} kPa</strong>${sel.useEc7?` → c'd = <strong>${sel.cD.toFixed(1)} kPa</strong>`:''}<br>
      N_c = <strong>${sel.Nc.toFixed(3)}</strong><br>
      N_q = <strong>${sel.Nq.toFixed(3)}</strong><br>
      N_γ = <strong>${sel.Ng.toFixed(3)}</strong> (${sel.ngammaFormulaLabel})<br>
      q' = σ'v = <strong>${sel.qDrain.toFixed(1)} kPa</strong><br>
      γ' = <strong>${sel.gammaEff.toFixed(2)} kN/m³</strong><br>
      ${sel.useEc7 ? `Governing Belgian combo = <strong>${sel.drainedComboLabel}</strong><br>` : ''}
      Shape factors = <strong>${sel.shapeModeLabel}</strong><br>
      B = <strong>${sel.BRaw.toFixed(2)} m</strong>, L = <strong>${sel.LRaw.toFixed(2)} m</strong><br>
      eB = <strong>${sel.eB.toFixed(2)} m</strong>, eL = <strong>${sel.eL.toFixed(2)} m</strong><br>
      B' = <strong>${sel.BEff.toFixed(2)} m</strong>, L' = <strong>${sel.LEff.toFixed(2)} m</strong>, r = <strong>${sel.r.toFixed(3)}</strong><br>
      Df/B' = η = <strong>${sel.eta.toFixed(3)}</strong>, k = <strong>${sel.k.toFixed(3)}</strong><br>
      s_c = <strong>${sel.sc.toFixed(2)}</strong>, s_q = <strong>${sel.sq.toFixed(2)}</strong>, s_γ = <strong>${sel.sg.toFixed(2)}</strong><br>
      d_c = <strong>${sel.dc.toFixed(2)}</strong>, d_q = <strong>${sel.dq.toFixed(2)}</strong>, d_γ = <strong>${sel.dg.toFixed(2)}</strong><br>
      ${sel.factorLabel} = <strong>${sel.factor.toFixed(2)}</strong><br>
      ${sel.capacityLabel} = q_ult,d / ${sel.factorLabel} = <strong>${sel.qdDrained.toLocaleString()} kPa</strong>
    </div>
  `;
}

function stage6BearingUndrainedFormulaHtml(sel){
  return `
    <div style="font-size:10px;font-weight:700;color:var(--chart-orange);text-transform:uppercase;margin-bottom:6px">Undrained formula at selected depth</div>
    <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
      q_ult,u = q + 5.14·c_u·s_cu·d_cu
    </div>
    <div style="font-size:11px;color:var(--tx2);line-height:1.55">
      q = σv = <strong>${sel.qUndrain.toFixed(1)} kPa</strong><br>
      cu,k = <strong>${sel.cuK.toFixed(1)} kPa</strong>${sel.useEc7?` → cu,d = <strong>${sel.cuD.toFixed(1)} kPa</strong>`:''}<br>
      N_cu = <strong>5.14</strong><br>
      ${sel.useEc7 ? `Governing Belgian combo = <strong>${sel.undrainedComboLabel}</strong><br>` : ''}
      Shape factors = <strong>${sel.shapeModeLabel}</strong><br>
      B = <strong>${sel.BRaw.toFixed(2)} m</strong>, L = <strong>${sel.LRaw.toFixed(2)} m</strong><br>
      eB = <strong>${sel.eB.toFixed(2)} m</strong>, eL = <strong>${sel.eL.toFixed(2)} m</strong><br>
      B' = <strong>${sel.BEff.toFixed(2)} m</strong>, L' = <strong>${sel.LEff.toFixed(2)} m</strong>, r = <strong>${sel.r.toFixed(3)}</strong><br>
      Df/B' = η = <strong>${sel.eta.toFixed(3)}</strong>, k = <strong>${sel.k.toFixed(3)}</strong><br>
      s_cu = <strong>${sel.scu.toFixed(2)}</strong>, d_cu = <strong>${sel.dcu.toFixed(2)}</strong><br>
      ${sel.factorLabel} = <strong>${sel.factor.toFixed(2)}</strong><br>
      ${sel.capacityLabel} = q_ult,u / ${sel.factorLabel} = <strong>${sel.qdUndrained.toLocaleString()} kPa</strong>
    </div>
  `;
}

let stage6BearingChartTimer = null;
function queueStage6BearingChartBuild(){
  if(stage6BearingChartTimer) clearTimeout(stage6BearingChartTimer);
  stage6BearingChartTimer = setTimeout(()=>{
    stage6BearingChartTimer = null;
    buildStage6BearingChart();
  }, 20);
}

function refreshStage6BearingPreview(){
  ensureStage6State();
  if(!S.layers.length || !S.stage6 || S.stage6.app !== 'bearing') return;
  const layers = stage6WorkingLayers();
  const cfg = S.stage6.bearing;
  const profile = bearingProfile(cfg, layers);
  if(!profile || !profile.selected) return;
  S.stage6Cache.bearing = profile;
  const sel = profile.selected;
  const governing = Math.min(sel.qdDrained, sel.qdUndrained);
  const governingMode = sel.qdDrained <= sel.qdUndrained ? 'Drained' : 'Undrained';
  const dfValue = document.getElementById('stage6DfValue');
  if(dfValue) dfValue.textContent = sel.z.toFixed(2)+' m';
  const summary = document.getElementById('stage6SelectedDepth');
  if(summary) summary.innerHTML = stage6BearingSelectedDepthHtml(sel, governing, governingMode);
  const material = document.getElementById('stage6UlsParams');
  if(material) material.innerHTML = stage6BearingMaterialParamsHtml(sel, cfg);
  const drainedFormula = document.getElementById('stage6DrainedFormula');
  if(drainedFormula) drainedFormula.innerHTML = stage6BearingDrainedFormulaHtml(sel);
  const undrainedFormula = document.getElementById('stage6UndrainedFormula');
  if(undrainedFormula) undrainedFormula.innerHTML = stage6BearingUndrainedFormulaHtml(sel);
  queueStage6BearingChartBuild();
}

function stage6SharedBanner(){
  return `
    <div class="info" style="margin-bottom:14px;background:var(--bg2);border-color:var(--bd2);color:var(--tx2)">
      Active CPT: <strong>${S.id}</strong> · WT = <strong>${S.wt.toFixed(2)} m</strong> below surface · parameter source = <strong>${S.paramMethod==='sb260'?'EC7 / NEN Table 3':'DEF'}</strong> · Stage 5 tuned m = <strong>${S.layers.some(l=>l.ovr.m)?'used where accepted':'not accepted'}</strong>
    </div>
  `;
}

function stage6AppIcon(id){
  // 18×18 line-art glyphs (stroke = currentColor), one per Stage 6 application.
  const I = (b)=>`<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${b}</svg>`;
  switch(id){
    case 'bearing':   return I('<path d="M2 12h14"/><rect x="6.5" y="3" width="5" height="6"/><path d="M3 12l1.5 3M15 12l-1.5 3M9 12v3"/>');
    case 'pile':      return I('<path d="M2 5h14"/><rect x="7.5" y="5" width="3" height="11"/><path d="M2 5v2M16 5v2"/>');
    case 'settlement':return I('<path d="M2 4h14"/><path d="M5 7v5M9 7v6M13 7v4"/><path d="M3.5 10.5L5 12l1.5-1.5M7.5 11.5L9 13l1.5-1.5M11.5 9.5L13 11l1.5-1.5"/>');
    case 'dewatering':return I('<path d="M9 2c2.5 3 4 5 4 7a4 4 0 0 1-8 0c0-2 1.5-4 4-7z"/><path d="M2 15h14"/>');
    case 'beam':      return I('<path d="M2 7h14"/><path d="M4 7l-1.5 3h3zM14 7l-1.5 3h3z"/><path d="M5 7v-2M9 7V5M13 7V5"/>');
    case 'retwall':   return I('<path d="M3 15h12"/><path d="M5 15V4h2v9h6"/><path d="M9 11h5M9 8h5M9 5h5" stroke-width="0.9"/>');
    case 'bishop':    return I('<path d="M2 15h14"/><path d="M3 15C3 8 8 4 15 4"/><path d="M4 13a9 9 0 0 1 9-7" stroke-dasharray="2 1.6"/>');
    default:          return I('<rect x="3" y="3" width="12" height="12" rx="2"/>');
  }
}

function stage6CardsHtml(app){
  const cards = [
    {id:'bearing', short:'Bearing', title:'Bearing capacity', desc:'Drained and undrained shallow-foundation resistance vs founding depth.'},
    {id:'pile', short:'Piles', title:'Pile capacity', desc:'Axial pile resistance and settlement from CPT (DM20 / De Beer).'},
    {id:'settlement', short:'Settlement', title:'Settlement', desc:'SLS settlement from CPT-derived E_oed with Boussinesq or 2:1 stress spread.'},
    {id:'dewatering', short:'Dewatering', title:'Dewatering', desc:'Drawdown screening plus induced stress change and settlement at the CPT.'},
    {id:'beam', short:'Beam/slab', title:'Beam / slab on Winkler', desc:'1D strip-on-elastic-foundation screening with EC2 reinforcement output.'},
    {id:retainingApp.cardMeta.id, short:'Retaining walls', title:retainingApp.cardMeta.title, desc:retainingApp.cardMeta.desc}
  ];
  if(stage6BishopEnabled()){
    cards.push({id:'bishop', short:'Seep/Slope', title:'Seep / Slope', desc:'Slope-stability, seepage and deformation workspace on the active CPT soil model.'});
  }
  return `
    <div class="app-switch" role="tablist" aria-label="Stage 6 applications">
      ${cards.map(c=>`<button type="button" role="tab" aria-selected="${c.id===app}" class="app-chip ${c.id===app?'sel':''}" onclick="setStage6App('${c.id}')" title="${c.title} — ${c.desc}">
        <span class="app-chip-ico">${stage6AppIcon(c.id)}</span><span class="app-chip-lbl">${c.short}</span>
      </button>`).join('')}
    </div>
  `;
}

// =====================================================================
// Stage 6 — Pile Estimator (Option A++ interactive section view)
// =====================================================================

function ensurePileState(maxDepth){
  if(!S.stage6.pile) S.stage6.pile = stage6Defaults().pile;
  const p = S.stage6.pile;
  const def = stage6Defaults().pile;
  // Enums
  const pileTypes = ['driven','screw_displacement','screw_cased','cfa','bored'];
  if(!pileTypes.includes(p.pileType)) p.pileType = 'driven';
  if(!['circular','square','rectangular'].includes(p.shape)) p.shape = 'circular';
  if(!['none','comparable','jobsite'].includes(p.sltCondition)) p.sltCondition = 'none';
  if(!['1-3','4-10','>10'].includes(p.nPiles)) p.nPiles = '1-3';
  if(!['1/10m2','1/50m2','1/100m2','1/300m2','1/1000m2'].includes(p.cptDensity)) p.cptDensity = '1/100m2';
  if(!['M1','M2','M4'].includes(p.coneType)) p.coneType = 'M1';
  if(!['none','moderate','severe'].includes(p.downdrag)) p.downdrag = 'none';
  if(!['concrete','steel','timber'].includes(p.pileMaterial)) p.pileMaterial = 'concrete';
  if(!['transfer','typical-curve'].includes(p.settlementMethod)) p.settlementMethod = 'transfer';
  if(!['qp','frequent','characteristic'].includes(p.slsCombination)) p.slsCombination = 'qp';
  if(!['A1','A2'].includes(p.ulsSet)) p.ulsSet = 'A1';
  if(!['A','B','C','D','E','W','S','T'].includes(p.loadCategory)) p.loadCategory = 'A';
  // Geometry
  p.Ds = Math.max(+p.Ds || def.Ds, 0.05);
  p.Db = Math.max(+p.Db || p.Ds, p.Ds);
  if(p.shape === 'rectangular'){
    p.a = Math.max(+p.a || p.Ds, 0.05);
    p.b = Math.max(+p.b || p.a, p.a);
  } else if(p.shape === 'square'){
    p.a = Math.max(+p.a || p.Ds, 0.05);
    p.b = null;
  } else {
    p.a = null;
    p.b = null;
  }
  if(p.Ap != null && p.Ap !== '' && Number.isFinite(+p.Ap) && +p.Ap > 0) p.Ap = +p.Ap;
  else p.Ap = null;
  // Depths
  p.zHead = Math.max(+p.zHead || 0, 0);
  if(p.zHead > maxDepth - 0.5) p.zHead = Math.max(0, maxDepth - 0.5);
  p.zToe = Math.min(Math.max(+p.zToe || def.zToe, p.zHead + 0.50), maxDepth);
  // Loads
  p.Fcd = Math.max(+p.Fcd || 0, 0);
  p.Frep = Math.max(+p.Frep || 0, 0);
  // Toggles / counts
  p.qaToggle = !!p.qaToggle;
  p.useAtg = !!p.useAtg;
  p.mechanicalCone = !!p.mechanicalCone;
  p.loadFromComponents = !!p.loadFromComponents;
  p.nCpt = Math.max(1, Math.round(+p.nCpt || 1));
  p.sAllowable = Math.max(+p.sAllowable || 10, 0.1);
  // Material modulus
  if(p.pileMaterial === 'steel') p.Ep = +p.Ep > 0 ? +p.Ep : 210;
  else if(p.pileMaterial === 'timber') p.Ep = +p.Ep > 0 ? +p.Ep : 12;
  else p.Ep = +p.Ep > 0 ? +p.Ep : 30;
  // Optional overrides
  for(const key of ['atgAlphaB','atgAlphaS','atgGammaRd','atgGammaB','lambdaOverride','EbOverride','MsOverride','MbOverride','GkPerPile','QLeadPerPile','QOtherPerPile']){
    const v = p[key];
    if(v == null || v === '' || !Number.isFinite(+v) || +v <= 0) p[key] = null;
    else p[key] = +v;
  }
  // Lambda special: default 1.0 when relaxing flagged
  if(p.lambdaOverride != null && p.lambdaOverride > 1.0) p.lambdaOverride = 1.0;
  // Downdrag / neutral plane
  if(p.downdrag !== 'none'){
    if(p.neutralPlane == null || !Number.isFinite(+p.neutralPlane)){
      p.neutralPlane = Math.max(p.zHead + 0.5, p.zToe / 2);
    } else {
      p.neutralPlane = Math.min(Math.max(+p.neutralPlane, p.zHead + 0.05), p.zToe - 0.05);
    }
  } else {
    p.neutralPlane = null;
  }
}

function renderStage6PileApp(analysis){
  const cfg = S.stage6.pile;
  const cap = analysis?.capacity || {};
  const set = analysis?.settlement;
  const notes = analysis?.notes || [];
  const xi = cap.xi || {};
  const lengthM = (cfg.zToe - cfg.zHead);
  const sHead = set ? set.sHead_mm : 0;
  const sUtil = sHead && cfg.sAllowable > 0 ? sHead / cfg.sAllowable : 0;
  const ulsPass = cap.ulsUtil != null && cap.ulsUtil <= 1.0;
  const slsPass = sUtil != null && sUtil <= 1.0;
  return `
    <div class="mc2 st6-pile">
      <div class="mc2-head" style="margin-bottom:12px">
        <span style="font-size:13px;font-weight:600">Pile capacity (Belgian DM20 / De Beer)</span>
        <span style="font-size:11px;color:var(--tx2)">CPT-based axial pile resistance and SLS settlement for a single pile, with the De Beer scale-effect base resistance and the Belgian load-transfer settlement method.</span>
      </div>
      <div class="st6-pile-cols">
        ${renderPileInputsColumn(cfg)}
        ${renderPileVisualsColumn(cfg, analysis)}
        ${renderPileSummaryColumn(cap, set, sHead, sUtil, ulsPass, slsPass, lengthM, cfg)}
      </div>
      <div class="st6-pile-tables">
        ${renderPilePerLayerTable(cap)}
        ${renderPileFactorChainTable(cap)}
      </div>
      ${stage6NoteHtml(notes)}
    </div>
  `;
}

function renderPileInputsColumn(cfg){
  const numField = (path, label, value, opts={}) => `
    <label style="font-size:11px;color:var(--tx2)">${label}
      <input type="number" step="${opts.step || 0.01}" min="${opts.min ?? 0}" ${opts.max != null ? `max="${opts.max}"` : ''}
        value="${value != null && value !== '' ? value : ''}" placeholder="${opts.placeholder || ''}"
        onchange="setStage6Field('pile.${path}', this.value)"
        style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
    </label>`;
  const selectField = (path, label, value, options) => `
    <label style="font-size:11px;color:var(--tx2)">${label}
      <select onchange="setStage6Field('pile.${path}', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
        ${options.map(([v,l])=>`<option value="${v}"${value===v?' selected':''}>${l}</option>`).join('')}
      </select>
    </label>`;
  const checkField = (path, label, value) => `
    <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px">
      <input type="checkbox" ${value?'checked':''} onchange="setStage6Field('pile.${path}', this.checked)">
      ${label}
    </label>`;

  return `
    <div>
      <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Inputs</div>
      <div class="ctrl-row" style="padding:12px;display:grid;grid-template-columns:1fr;gap:10px">
        <div class="st6-help">Drag the pile toe and head on the section view to set z<sub>toe</sub> and z<sub>head</sub>, or type values here. Drag the shaft / base edges to change D<sub>s</sub> / D<sub>b</sub>. Click any soil layer to snap the toe to its top, mid, or bottom.</div>
        ${selectField('pileType','Pile type',cfg.pileType,[
          ['driven','Driven / jacked'],
          ['screw_displacement','Displacement screw (plastic-concrete shaft)'],
          ['screw_cased','Screw with lost / temporary casing'],
          ['cfa','CFA (continuous flight auger)'],
          ['bored','Bored']
        ])}
        ${selectField('shape','Cross-section',cfg.shape,[
          ['circular','Circular'],
          ['square','Square'],
          ['rectangular','Rectangular']
        ])}
        ${cfg.shape === 'circular' ? `
          ${numField('Ds','Shaft diameter D<sub>s</sub> (m)',cfg.Ds,{step:0.01,min:0.05})}
          ${numField('Db','Base diameter D<sub>b</sub> (m)',cfg.Db,{step:0.01,min:cfg.Ds})}
        ` : cfg.shape === 'square' ? `
          ${numField('a','Side a (m)',cfg.a ?? cfg.Ds,{step:0.01,min:0.05})}
          ${numField('Ds','Shaft equivalent D<sub>s</sub> (m, perimeter use)',cfg.Ds,{step:0.01,min:0.05})}
          ${numField('Db','Base equivalent D<sub>b</sub> (m, base use)',cfg.Db,{step:0.01,min:cfg.Ds})}
        ` : `
          ${numField('a','Short side a (m)',cfg.a ?? cfg.Ds,{step:0.01,min:0.05})}
          ${numField('b','Long side b (m)',cfg.b ?? cfg.a ?? cfg.Ds,{step:0.01,min:cfg.a ?? cfg.Ds})}
          ${numField('Ds','Shaft equivalent D<sub>s</sub> (m)',cfg.Ds,{step:0.01,min:0.05})}
          ${numField('Db','Base equivalent D<sub>b</sub> (m)',cfg.Db,{step:0.01,min:cfg.Ds})}
        `}
        ${numField('Ap','Pile axial cross-section A<sub>p</sub> (m², blank = auto)',cfg.Ap,{step:0.001,min:0.001,placeholder:'auto'})}
        ${numField('zHead','Pile head depth z<sub>head</sub> (m)',cfg.zHead.toFixed(2),{step:0.05,min:0})}
        ${numField('zToe','Pile toe depth z<sub>toe</sub> (m)',cfg.zToe.toFixed(2),{step:0.05,min:cfg.zHead+0.5})}
        ${numField('Fcd','ULS design load F<sub>c,d</sub> (kN)',cfg.Fcd,{step:10,min:0})}
        ${numField('Frep','SLS representative load F<sub>rep</sub> (kN)',cfg.Frep,{step:10,min:0})}
        ${numField('sAllowable','Allowable settlement s<sub>allow</sub> (mm)',cfg.sAllowable,{step:1,min:0.5})}
        <details class="st6-adv" data-st6details="pile-factors"${stage6DetailsOpen('pile-factors')}>
          <summary>Factor chain (γ<sub>Rd</sub> / ξ / γ<sub>b</sub>·γ<sub>s</sub>)</summary>
          <div class="st6-adv-body">
            ${selectField('sltCondition','Static load test condition',cfg.sltCondition,[
              ['none','No SLT — γ<sub>Rd1</sub>'],
              ['comparable','SLT in comparable conditions — γ<sub>Rd2</sub>'],
              ['jobsite','SLT on the job site — γ<sub>Rd3</sub>']
            ])}
            ${selectField('nPiles','Number of piles',cfg.nPiles,[
              ['1-3','1–3'],['4-10','4–10'],['>10','>10']
            ])}
            ${selectField('cptDensity','CPT density',cfg.cptDensity,[
              ['1/10m2','1 CPT / 10 m²'],
              ['1/50m2','1 CPT / 50 m²'],
              ['1/100m2','1 CPT / 100 m²'],
              ['1/300m2','1 CPT / 300 m²'],
              ['1/1000m2','1 CPT / 1000 m²']
            ])}
            ${numField('nCpt','Number of CPTs in zone',cfg.nCpt,{step:1,min:1})}
            ${checkField('qaToggle','Quality assurance (QA) — favourable γ<sub>b</sub> column',cfg.qaToggle)}
          </div>
        </details>
        <details class="st6-adv" data-st6details="pile-atg"${stage6DetailsOpen('pile-atg')}>
          <summary>ATG / DM20 factor overrides</summary>
          <div class="st6-adv-body">
            ${checkField('useAtg','Use ATG / DM20 overrides',cfg.useAtg)}
            ${cfg.useAtg ? `
              ${numField('atgAlphaB','α<sub>b</sub> override',cfg.atgAlphaB,{step:0.01,min:0.01,placeholder:'default'})}
              ${numField('atgAlphaS','α<sub>s</sub> override',cfg.atgAlphaS,{step:0.01,min:0.01,placeholder:'default'})}
              ${numField('atgGammaRd','γ<sub>Rd</sub> override',cfg.atgGammaRd,{step:0.05,min:0.5,placeholder:'default'})}
              ${numField('atgGammaB','γ<sub>b</sub> override',cfg.atgGammaB,{step:0.05,min:0.5,placeholder:'default'})}
            ` : '<div class="st6-help">Tick the box above to expose α<sub>b</sub>, α<sub>s</sub>, γ<sub>Rd</sub>, γ<sub>b</sub> override fields for ATG-certified pile systems.</div>'}
            ${numField('lambdaOverride','λ override (relaxing enlarged base)',cfg.lambdaOverride,{step:0.01,min:0.1,max:1.0,placeholder:'default 1.00'})}
          </div>
        </details>
        <details class="st6-adv" data-st6details="pile-cone"${stage6DetailsOpen('pile-cone')}>
          <summary>Mechanical cone correction</summary>
          <div class="st6-adv-body">
            ${checkField('mechanicalCone','Apply mechanical-cone ω correction',cfg.mechanicalCone)}
            ${cfg.mechanicalCone ? selectField('coneType','Cone type',cfg.coneType,[
              ['M1','M1'],['M2','M2'],['M4','M4']
            ]) : '<div class="st6-help">Default: CPT-E (electric cone, ω = 1.00). Tick the box for mechanical cones.</div>'}
          </div>
        </details>
        <details class="st6-adv" data-st6details="pile-downdrag"${stage6DetailsOpen('pile-downdrag')}>
          <summary>Negative skin friction / downdrag</summary>
          <div class="st6-adv-body">
            ${selectField('downdrag','Downdrag preset',cfg.downdrag,[
              ['none','No downdrag expected'],
              ['moderate','Moderate (4–10 cm settlement → ½ F<sub>nk</sub>)'],
              ['severe','Severe (>10 cm settlement → full F<sub>nk</sub>)']
            ])}
            ${cfg.downdrag !== 'none' ? `
              ${numField('neutralPlane','Neutral plane depth (m)',cfg.neutralPlane,{step:0.05,min:cfg.zHead+0.05,max:cfg.zToe-0.05})}
              <div class="st6-help">Layers above the neutral plane lose positive shaft friction and contribute to F<sub>nk</sub> via slip + analogy methods.</div>
            ` : ''}
          </div>
        </details>
        <details class="st6-adv" data-st6details="pile-settlement"${stage6DetailsOpen('pile-settlement')}>
          <summary>Settlement parameters</summary>
          <div class="st6-adv-body">
            ${selectField('settlementMethod','Method',cfg.settlementMethod,[
              ['transfer','Belgian load-transfer (recommended)'],
              ['typical-curve','Simplified typical-curve (short, homogeneous piles only)']
            ])}
            ${selectField('pileMaterial','Pile material',cfg.pileMaterial,[
              ['concrete','Reinforced concrete'],
              ['steel','Steel'],
              ['timber','Timber']
            ])}
            ${numField('Ep','E<sub>p</sub> (GPa)',cfg.Ep,{step:1,min:1})}
            ${numField('EbOverride','E<sub>b</sub> override (kPa, blank = oedometric default)',cfg.EbOverride,{step:1000,min:1000,placeholder:'auto'})}
            ${numField('MsOverride','M<sub>s</sub> override (×10⁻³, blank = table)',cfg.MsOverride,{step:0.5,min:0.1,placeholder:'auto'})}
            ${numField('MbOverride','M<sub>b</sub> override (blank = table)',cfg.MbOverride,{step:1,min:0.1,placeholder:'auto'})}
          </div>
        </details>
      </div>
    </div>
  `;
}

function renderPileVisualsColumn(cfg, analysis){
  return `
    <div class="st6-pile-visuals">
      <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Pile + soil section view (drag to edit)</div>
      <div style="position:relative">
        <svg id="stage6PileSection" width="100%" style="height:520px;display:block;background:var(--bg2);border:1px solid var(--bd2);border-radius:6px"></svg>
      </div>
      <div class="st6-pile-charts">
        <div class="st6-pile-chart">
          <div class="st6-pile-chart__title">De Beer transformation chain</div>
          <div class="st6-pile-chart__cv"><canvas id="stage6PileDeBeerChart" role="img" aria-label="De Beer profile"></canvas></div>
        </div>
        <div class="st6-pile-chart">
          <div class="st6-pile-chart__title">Per-layer shaft friction q<sub>s</sub></div>
          <div class="st6-pile-chart__cv"><canvas id="stage6PileShaftChart" role="img" aria-label="Shaft friction profile"></canvas></div>
        </div>
        <div class="st6-pile-chart">
          <div class="st6-pile-chart__title">Load–settlement curve</div>
          <div class="st6-pile-chart__cv"><canvas id="stage6PileLoadSettlementChart" role="img" aria-label="Load-settlement curve"></canvas></div>
        </div>
        <div class="st6-pile-chart">
          <div class="st6-pile-chart__title">Axial force N(z)</div>
          <div class="st6-pile-chart__cv"><canvas id="stage6PileAxialForceChart" role="img" aria-label="Axial force profile"></canvas></div>
        </div>
      </div>
    </div>
  `;
}

function renderPileSummaryColumn(cap, set, sHead, sUtil, ulsPass, slsPass, lengthM, cfg){
  const fmt = (v, dp=0, unit='') => Number.isFinite(+v) ? `${(+v).toFixed(dp)}${unit?(' '+unit):''}` : '—';
  const utilColor = (u) => !Number.isFinite(+u) ? 'var(--tx2)' : (+u <= 1.0 ? '#1D9E75' : '#D85A30');
  const passBadge = (pass, label) => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;color:#fff;background:${pass?'#1D9E75':'#D85A30'}">${pass?'PASS':'FAIL'} · ${label}</span>`;
  return `
    <div>
      <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Summary</div>
      <table class="pt" style="margin-bottom:10px">
        <tr><td>Pile length L</td><td>${lengthM.toFixed(2)} m</td></tr>
        <tr><td>D<sub>b,eq</sub></td><td>${fmt(cap.Dbeq, 3, 'm')}</td></tr>
        <tr><td>A<sub>b</sub></td><td>${fmt(cap.A_b, 4, 'm²')}</td></tr>
        <tr><td>χ<sub>s</sub></td><td>${fmt(cap.chi_s, 3, 'm')}</td></tr>
        <tr><td>Layer at toe</td><td>${cap.categoryAtToe || '—'}</td></tr>
        <tr><td>q<sub>b</sub> (De Beer)</td><td>${fmt(cap.qb_kPa, 0, 'kPa')}</td></tr>
        <tr><td>α<sub>b</sub> · e<sub>b</sub> · β · λ</td><td>${(cap.alphaB||0).toFixed(2)} · ${(cap.eb||1).toFixed(3)} · ${(cap.beta||1).toFixed(3)} · ${(cap.lambda||1).toFixed(2)}</td></tr>
        <tr><td>R<sub>b</sub></td><td>${fmt(cap.R_b, 0, 'kN')}</td></tr>
        <tr><td>R<sub>s</sub></td><td>${fmt(cap.R_s, 0, 'kN')}</td></tr>
        <tr><td>R<sub>c</sub> = R<sub>b</sub> + R<sub>s</sub></td><td>${fmt(cap.R_c, 0, 'kN')}</td></tr>
        <tr><td>γ<sub>Rd</sub></td><td>${fmt(cap.gammaRd, 2)}</td></tr>
        <tr><td>R<sub>c,cal</sub></td><td>${fmt(cap.R_c_cal, 0, 'kN')}</td></tr>
        <tr><td>ξ<sub>3</sub> / ξ<sub>4</sub> / max</td><td>${(cap.xi?.xi3||0).toFixed(2)} / ${(cap.xi?.xi4||0).toFixed(2)} / <strong>${(cap.xi?.governing||0).toFixed(2)}</strong></td></tr>
        <tr><td>R<sub>c,k</sub></td><td>${fmt(cap.R_c_k, 0, 'kN')}</td></tr>
        <tr><td>γ<sub>b</sub> / γ<sub>s</sub></td><td>${(cap.gamma_b||1).toFixed(2)} / ${(cap.gamma_s||1).toFixed(2)}</td></tr>
        <tr><td>R<sub>c,d</sub></td><td><strong>${fmt(cap.R_c_d, 0, 'kN')}</strong></td></tr>
        ${cap.neutralPlane != null ? `
          <tr><td>F<sub>nk</sub> slip</td><td>${fmt(cap.F_nk_slip, 0, 'kN')}</td></tr>
          <tr><td>F<sub>nk</sub> analogy</td><td>${fmt(cap.F_nk_analogy, 0, 'kN')}</td></tr>
          <tr><td>F<sub>nk,d</sub> (governing)</td><td><strong>${fmt(cap.F_nk_design, 0, 'kN')}</strong></td></tr>
        ` : ''}
        <tr><td>Effective ULS load</td><td>${fmt(cap.ulsLoad, 0, 'kN')}</td></tr>
        <tr><td style="color:${utilColor(cap.ulsUtil)}">ULS utilisation</td><td style="color:${utilColor(cap.ulsUtil)};font-weight:700">${fmt(cap.ulsUtil, 3)}</td></tr>
        ${set ? `
          <tr><td>s<sub>head</sub> (SLS)</td><td>${fmt(sHead, 2, 'mm')}</td></tr>
          <tr><td>z<sub>b</sub> (base)</td><td>${fmt((set.zb_m||0)*1000, 2, 'mm')}</td></tr>
          <tr><td>s<sub>allow</sub></td><td>${cfg.sAllowable.toFixed(1)} mm</td></tr>
          <tr><td style="color:${utilColor(sUtil)}">SLS utilisation</td><td style="color:${utilColor(sUtil)};font-weight:700">${fmt(sUtil, 3)}</td></tr>
        ` : ''}
      </table>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${passBadge(ulsPass, 'ULS')}
        ${set ? passBadge(slsPass, 'SLS') : ''}
      </div>
    </div>
  `;
}

function renderPilePerLayerTable(cap){
  const rows = (cap?.perLayer || []).map((row) => {
    const tag = row.excluded ? '<span style="color:var(--tx2)">excluded</span>'
      : row.aboveNeutral ? '<span style="color:#D85A30">above N.P.</span>'
      : '<span style="color:#1D9E75">contributing</span>';
    const etaP = row.etaP != null ? row.etaP.toFixed(4) : 'cap';
    return `<tr>
      <td>${row.layerIndex + 1}</td>
      <td>${row.top.toFixed(2)}</td>
      <td>${row.bot.toFixed(2)}</td>
      <td>${row.category}</td>
      <td>${row.qcMean.toFixed(2)}</td>
      <td>${etaP}</td>
      <td>${row.qs.toFixed(0)}</td>
      <td>${row.alphaS.toFixed(2)}</td>
      <td>${row.h.toFixed(2)}</td>
      <td>${tag}</td>
      <td>${row.RsLayer.toFixed(0)}</td>
    </tr>`;
  }).join('');
  return `
    <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
      <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Per-layer shaft resistance</div>
      <div style="overflow:auto">
        <table class="tbl" style="font-size:11px;width:100%">
          <thead><tr><th>i</th><th>Top (m)</th><th>Bot (m)</th><th>Cat.</th><th>q<sub>c,m</sub> (MPa)</th><th>η*<sub>p</sub></th><th>q<sub>s</sub> (kPa)</th><th>α<sub>s</sub></th><th>h (m)</th><th>Status</th><th>R<sub>s</sub> (kN)</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="11" style="text-align:center;color:var(--tx2)">No layers intersect the pile shaft.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderPileFactorChainTable(cap){
  const fmt = (v, dp=0) => Number.isFinite(+v) ? (+v).toFixed(dp) : '—';
  return `
    <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
      <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Factor chain audit</div>
      <table class="pt" style="font-size:11px;width:100%">
        <tr><td>R<sub>c</sub> = R<sub>b</sub> + R<sub>s</sub></td><td>${fmt(cap.R_c, 0)} kN</td><td>per-CPT calculated</td></tr>
        <tr><td>÷ γ<sub>Rd</sub></td><td>${fmt(cap.gammaRd, 2)}</td><td>${cap.lambdaSource === 'override' ? 'ATG override' : 'DM20 default'}</td></tr>
        <tr><td>= R<sub>c,cal</sub></td><td>${fmt(cap.R_c_cal, 0)} kN</td><td>calibrated</td></tr>
        <tr><td>÷ max(ξ<sub>3</sub>, ξ<sub>4</sub>)</td><td>${fmt(cap.xi?.governing, 2)}</td><td>single-CPT governing branch (${cap.xi?.branch || '—'})</td></tr>
        <tr><td>= R<sub>c,k</sub></td><td>${fmt(cap.R_c_k, 0)} kN</td><td>characteristic</td></tr>
        <tr><td>R<sub>b,k</sub> = ${(cap.RbShare*100).toFixed(0)}% of R<sub>c,k</sub></td><td>${fmt(cap.R_b_k, 0)} kN</td><td></td></tr>
        <tr><td>R<sub>s,k</sub> = ${(cap.RsShare*100).toFixed(0)}% of R<sub>c,k</sub></td><td>${fmt(cap.R_s_k, 0)} kN</td><td></td></tr>
        <tr><td>R<sub>c,d</sub> = R<sub>b,k</sub>/γ<sub>b</sub> + R<sub>s,k</sub>/γ<sub>s</sub></td><td><strong>${fmt(cap.R_c_d, 0)} kN</strong></td><td>γ<sub>b</sub>=${(cap.gamma_b||1).toFixed(2)}, γ<sub>s</sub>=${(cap.gamma_s||1).toFixed(2)}</td></tr>
      </table>
    </div>
  `;
}

function buildStage6PileCharts(){
  const analysis = S.stage6Cache?.pile;
  if(!analysis || typeof Chart === 'undefined') return;
  const cap = analysis.capacity || {};
  const set = analysis.settlement;
  const cfg = S.stage6.pile;
  const maxDepth = stage6MaxDepth();
  const deBeerCanvas = stage6DestroyChart('stage6PileDeBeerChart');
  if(deBeerCanvas){
    deBeerCanvas._chartRef = new Chart(deBeerCanvas, buildPileDeBeerChartConfig({
      deBeer: cap.deBeer,
      maxDepth,
      zToe: cfg.zToe
    }));
  }
  const shaftCanvas = stage6DestroyChart('stage6PileShaftChart');
  if(shaftCanvas){
    shaftCanvas._chartRef = new Chart(shaftCanvas, buildPileShaftChartConfig({
      perLayer: cap.perLayer || [],
      maxDepth
    }));
  }
  const lsCanvas = stage6DestroyChart('stage6PileLoadSettlementChart');
  if(lsCanvas && set){
    lsCanvas._chartRef = new Chart(lsCanvas, buildPileLoadSettlementChartConfig({
      curve: set.curve || [],
      Frep: cfg.Frep,
      Rcd: cap.R_c_d,
      sAllowable: cfg.sAllowable
    }));
  }
  const nCanvas = stage6DestroyChart('stage6PileAxialForceChart');
  if(nCanvas && set){
    nCanvas._chartRef = new Chart(nCanvas, buildPileAxialForceChartConfig({
      trace: set.trace || [],
      zHead: cfg.zHead,
      zToe: cfg.zToe,
      Frep: cfg.Frep
    }));
  }
}

function drawStage6PileSectionLive(){
  const analysis = S.stage6Cache?.pile;
  if(!analysis) return;
  const canvasState = ensurePileCanvasState(S.stage6Cache);
  drawStage6PileSection('stage6PileSection', analysis, S.stage6.pile, canvasState, {
    getLayers: () => stage6WorkingLayers(),
    getWt: () => S.wt,
    getMaxDepth: () => stage6MaxDepth(),
    setField: (path, value) => {
      // Drag-driven writes: bypass the full setStage6Field rebuild for the live
      // drag path, but still go through the same state shape. We update the
      // pile config in place; ensurePileState() re-clamps on next render.
      const segs = path.split('.');
      let cur = S.stage6;
      for(let i = 0; i < segs.length - 1; i += 1){
        if(!cur[segs[i]]) cur[segs[i]] = {};
        cur = cur[segs[i]];
      }
      cur[segs[segs.length - 1]] = value;
    },
    requestRedraw: () => requestStage6PileLightRedraw(),
    commitChange: () => {
      // Full re-render on drag-end so the column-3 summary, audit tables and
      // four Chart.js panels also reflect the new state.
      renderStage6();
    }
  });
}

let __stage6PileLightRedrawHandle = null;
function requestStage6PileLightRedraw(){
  if(__stage6PileLightRedrawHandle) return;
  __stage6PileLightRedrawHandle = requestAnimationFrame(()=>{
    __stage6PileLightRedrawHandle = null;
    if(S.stage6.app !== 'pile') return;
    // Re-clamp config and recompute the analysis so the active-shaft band,
    // downdrag overlay, and per-layer hover tooltips track the live drag.
    // analyzePile is fast (~ms-range on a typical CPT); doing it at 60 Hz
    // is well within budget on modern browsers.
    ensureStage6State();
    const analysis = analyzePile(stage6WorkingLayers(), S.wt, S.data, S.stage6.pile);
    S.stage6Cache.pile = analysis;
    const canvasState = ensurePileCanvasState(S.stage6Cache);
    drawStage6PileSection('stage6PileSection', analysis, S.stage6.pile, canvasState, {
      getLayers: () => stage6WorkingLayers(),
      getWt: () => S.wt,
      getMaxDepth: () => stage6MaxDepth(),
      setField: (path, value) => {
        const segs = path.split('.');
        let cur = S.stage6;
        for(let i = 0; i < segs.length - 1; i += 1){
          if(!cur[segs[i]]) cur[segs[i]] = {};
          cur = cur[segs[i]];
        }
        cur[segs[segs.length - 1]] = value;
      },
      requestRedraw: () => requestStage6PileLightRedraw(),
      commitChange: () => renderStage6()
    });
  });
}

function renderStage6BearingApp(profile){
  const cfg = S.stage6.bearing;
  const sel = profile.selected;
  const governing = Math.min(sel.qdDrained, sel.qdUndrained);
  const governingMode = sel.qdDrained <= sel.qdUndrained ? 'Drained' : 'Undrained';
  return `
    <div class="mc2">
      <div class="mc2-head" style="margin-bottom:12px">
        <span style="font-size:13px;font-weight:600">Bearing capacity</span>
        <span style="font-size:11px;color:var(--tx2)">ULS-style resistance screening from the interpreted CPT profile.</span>
      </div>
      <div style="display:grid;grid-template-columns:260px 1fr 250px;gap:14px;align-items:start">
        <div>
          <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Inputs</div>
          <div class="ctrl-row" style="padding:12px;display:grid;grid-template-columns:1fr;gap:10px">
            <label style="font-size:11px;color:var(--tx2)">Displayed curves
              <select onchange="setStage6Field('bearing.showMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="both"${cfg.showMode==='both'?' selected':''}>Show both curves</option>
                <option value="drained"${cfg.showMode==='drained'?' selected':''}>Drained only</option>
                <option value="undrained"${cfg.showMode==='undrained'?' selected':''}>Undrained only</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Foundation type
              <select onchange="setStage6Field('bearing.foundationType', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="strip"${cfg.foundationType==='strip'?' selected':''}>Strip</option>
                <option value="footing"${cfg.foundationType==='footing'?' selected':''}>Footing / pad</option>
                <option value="slab"${cfg.foundationType==='slab'?' selected':''}>Slab / raft</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Width B (m)
              <input type="number" step="0.1" min="0.1" value="${cfg.B.toFixed(2)}" onchange="setStage6Field('bearing.B', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Length L (m)
              <input type="number" step="0.1" min="0.1" value="${cfg.L.toFixed(2)}" onchange="setStage6Field('bearing.L', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <div>
              <div style="font-size:11px;color:var(--tx2);margin-bottom:5px">Founding depth Df = <strong id="stage6DfValue">${cfg.Df.toFixed(2)} m</strong></div>
              <input type="range" min="0.2" max="${profile.maxDepth.toFixed(2)}" step="0.05" value="${cfg.Df.toFixed(2)}" oninput="setStage6Field('bearing.Df', this.value)" style="width:100%">
            </div>
            <details class="st6-adv" data-st6details="bearing-advanced"${stage6DetailsOpen('bearing-advanced')}>
              <summary>Optional verification and safety settings</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Bearing capacity is calculated regardless. Expand this only if you want a utilisation check against an applied stress or if you want to adjust the safety philosophy.</div>
                <label style="font-size:11px;color:var(--tx2)">Shape factors
                  <select onchange="setStage6Field('bearing.shapeMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${stage6BearingShapeModeOptions(cfg.shapeMode)}
                  </select>
                </label>
                <div class="st6-help">${stage6BearingShapeModeHelp(cfg.shapeMode)}</div>
                <label style="font-size:11px;color:var(--tx2)">Eccentricity eB (m)
                  <input type="number" step="0.01" min="0" value="${cfg.eB.toFixed(2)}" onchange="setStage6Field('bearing.eB', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Eccentricity eL (m)
                  <input type="number" step="0.01" min="0" value="${cfg.eL.toFixed(2)}" onchange="setStage6Field('bearing.eL', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <div class="st6-help">Effective dimensions for shape factors use B' = B − 2eB and L' = L − 2eL. With the default centered load, keep eB = eL = 0. For circular plans screened in this rectangular interface, use B = L so r = 1.</div>
                <label style="font-size:11px;color:var(--tx2)">Applied stress for utilisation (kPa)
                  <input type="number" step="5" min="0" value="${cfg.load.toFixed(0)}" onchange="setStage6Field('bearing.load', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Safety route
                  <select onchange="setStage6Field('bearing.factorMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    <option value="ec7"${cfg.factorMode==='ec7'?' selected':''}>EC7 output factors</option>
                    <option value="system"${cfg.factorMode==='system'?' selected':''}>Global system factor ξ</option>
                  </select>
                </label>
                ${cfg.factorMode==='ec7' ? `
                  <label style="font-size:11px;color:var(--tx2)">Belgian ULS combination
                    <select onchange="setStage6Field('bearing.ec7Combination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                      ${stage6BearingEc7Options(cfg.ec7Combination)}
                    </select>
                  </label>
                  <div class="st6-help">${stage6BearingEc7Help(cfg.ec7Combination)}</div>
                  <label style="font-size:11px;color:var(--tx2)">γ_Rd
                    <input type="number" step="0.05" min="1.0" value="${cfg.gammaRd.toFixed(2)}" onchange="setStage6Field('bearing.gammaRd', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                  </label>
                  <div class="st6-help">Belgian EC7 DA1 uses R1 for spread footing bearing. This tool keeps γ_R = 1.0 and switches the soil-side factors automatically between DA1/1 and DA1/2.</div>
                ` : `
                  <label style="font-size:11px;color:var(--tx2)">Global system factor ξ
                    <input type="number" step="0.1" min="1.0" value="${cfg.xi.toFixed(2)}" onchange="setStage6Field('bearing.xi', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                  </label>
                  <div class="st6-help">Use the global ξ route only as a legacy screening path. For Belgian EC7 checks, switch back to the EC7 route above.</div>
                `}
              </div>
            </details>
          </div>
        </div>
        <div>
          <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">
            ${cfg.factorMode==='ec7' ? 'Design bearing capacity vs founding depth' : 'Allowable bearing capacity vs founding depth'}
            <span style="margin-left:6px;color:var(--chart-green)">- drained</span>
            <span style="margin-left:4px;color:var(--chart-orange)">- undrained</span>
            <span style="margin-left:4px;color:var(--chart-blue)">- selected Df</span>
          </div>
          <div style="position:relative;height:420px"><canvas id="stage6BearingChart" role="img" aria-label="Bearing capacity versus depth"></canvas></div>
        </div>
        <div id="stage6SelectedDepth">${stage6BearingSelectedDepthHtml(sel, governing, governingMode)}</div>
      </div>
      <div id="stage6UlsParams" style="margin-top:14px" class="info">${stage6BearingMaterialParamsHtml(sel, cfg)}</div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div id="stage6DrainedFormula" class="info" style="background:var(--bg2)">${stage6BearingDrainedFormulaHtml(sel)}</div>
        <div id="stage6UndrainedFormula" class="info" style="background:var(--bg2)">${stage6BearingUndrainedFormulaHtml(sel)}</div>
      </div>
      ${stage6NoteHtml(stage6BearingNotes(sel, cfg))}
    </div>
  `;
}

function renderStage6SettlementApp(analysis){
  const cfg = S.stage6.settlement;
  const loadRows = [
    {k:'Limit state', v:'SLS'},
    {k:'Combination', v:cfg.combination === 'qp' ? 'Quasi-permanent' : cfg.combination},
    {k:'Gk', v:`${cfg.Gk.toFixed(1)} kPa`},
    {k:'Qk,lead', v:`${cfg.QLead.toFixed(1)} kPa`},
    {k:'Qk,other', v:`${cfg.QOther.toFixed(1)} kPa`},
    {k:'q_gross', v:`${analysis.qGross.toFixed(1)} kPa`},
    {k:'sigma_v(Df)', v:`${analysis.sigmaVDf.toFixed(1)} kPa`},
    {k:'q_net', v:`${analysis.qNet.toFixed(1)} kPa`}
  ];
  return `
    <div class="mc2">
      <div class="mc2-head" style="margin-bottom:12px">
        <span style="font-size:13px;font-weight:600">Settlement</span>
        <span style="font-size:11px;color:var(--tx2)">SLS settlement at the footing / slab centreline from CPT-derived E_oed with explicit stress integration below Df.</span>
      </div>
      <div style="display:grid;grid-template-columns:280px 1fr 260px;gap:14px;align-items:start">
        <div>
          <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Inputs</div>
          <div class="st6-help" style="margin-bottom:8px">The reported settlement is the vertical settlement beneath the centre of the loaded area. For a strip footing this is the centreline in section; for a rectangular, square, circular footing or slab it is the middle of the footprint.</div>
          <div class="ctrl-row" style="padding:12px;display:grid;grid-template-columns:1fr;gap:10px">
            <label style="font-size:11px;color:var(--tx2)">Footing type
              <select onchange="setStage6Field('settlement.footingType', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="strip"${cfg.footingType==='strip'?' selected':''}>Strip</option>
                <option value="rectangular"${cfg.footingType==='rectangular'?' selected':''}>Rectangular / slab</option>
                <option value="square"${cfg.footingType==='square'?' selected':''}>Square</option>
                <option value="circular"${cfg.footingType==='circular'?' selected':''}>Circular</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Width B (m)
              <input type="number" step="0.1" min="0.1" value="${cfg.B.toFixed(2)}" onchange="setStage6Field('settlement.B', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            ${cfg.footingType==='circular' ? `
              <label style="font-size:11px;color:var(--tx2)">Diameter D (m)
                <input type="number" step="0.1" min="0.1" value="${cfg.D.toFixed(2)}" onchange="setStage6Field('settlement.D', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            ` : `
              <label style="font-size:11px;color:var(--tx2)">Length L (m)
                <input type="number" step="0.1" min="0.1" value="${cfg.L.toFixed(2)}" onchange="setStage6Field('settlement.L', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `}
            <label style="font-size:11px;color:var(--tx2)">Founding depth Df (m)
              <input type="number" step="0.1" min="0" value="${cfg.Df.toFixed(2)}" onchange="setStage6Field('settlement.Df', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Stress spread
              <select onchange="setStage6Field('settlement.stressMethod', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="boussinesq"${cfg.stressMethod==='boussinesq'?' selected':''}>Boussinesq / Newmark</option>
                <option value="two_to_one"${cfg.stressMethod==='two_to_one'?' selected':''}>2:1 method</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Truncation rule
              <select onchange="setStage6Field('settlement.truncationRule', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="10%_sigma_eff"${cfg.truncationRule==='10%_sigma_eff'?' selected':''}>Delta sigma < 10% sigma'v0</option>
                <option value="20%_q_net"${cfg.truncationRule==='20%_q_net'?' selected':''}>Delta sigma < 20% q_net</option>
                <option value="CPT_bottom"${cfg.truncationRule==='CPT_bottom'?' selected':''}>Use CPT bottom</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Sub-layer dz (m)
              <input type="number" step="0.05" min="0.05" value="${cfg.dz.toFixed(2)}" onchange="setStage6Field('settlement.dz', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Target allowable settlement (mm)
              <input type="number" step="1" min="1" value="${cfg.allowableSettlement.toFixed(0)}" onchange="setStage6Field('settlement.allowableSettlement', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px">
              <input type="checkbox" ${cfg.includeTime?'checked':''} onchange="setStage6Field('settlement.includeTime', this.checked)">
              Show settlement time curve
            </label>
            ${cfg.includeTime ? `
              <label style="font-size:11px;color:var(--tx2)">Time horizon (days)
                <input type="number" step="10" min="1" value="${cfg.timeDays.toFixed(0)}" onchange="setStage6Field('settlement.timeDays', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            <details class="st6-adv" data-st6details="settlement-loads"${stage6DetailsOpen('settlement-loads')}>
              <summary>Load assumptions and Eurocode combination</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Only expand this if you want to change the serviceability load assumptions. The default is the quasi-permanent SLS combination, which is usually the right starting point for long-term settlement.</div>
                <label style="font-size:11px;color:var(--tx2)">SLS combination
                  <select onchange="setStage6Field('settlement.combination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${stage6SlsCombinationOptions(cfg.combination)}
                  </select>
                </label>
                <div class="st6-help">${stage6SlsCombinationHelp(cfg.combination, 'settlement')}</div>
                <label style="font-size:11px;color:var(--tx2)">Load category for Eurocode ψ-factors
                  <select onchange="setStage6Field('settlement.useCategory', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${stage6UseCategoryOptions(cfg.useCategory)}
                  </select>
                </label>
                <div class="st6-help">${stage6UseCategoryHelp(cfg.useCategory)}</div>
                <label style="font-size:11px;color:var(--tx2)">Permanent stress Gk (kPa)
                  <input type="number" step="5" min="0" value="${cfg.Gk.toFixed(1)}" onchange="setStage6Field('settlement.Gk', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Leading variable load Qk (kPa)
                  <input type="number" step="5" min="0" value="${cfg.QLead.toFixed(1)}" onchange="setStage6Field('settlement.QLead', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Other variable loads together (kPa)
                  <input type="number" step="5" min="0" value="${cfg.QOther.toFixed(1)}" onchange="setStage6Field('settlement.QOther', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
              </div>
            </details>
          </div>
        </div>
        <div>
          <div style="display:grid;grid-template-columns:1fr;gap:12px">
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Stress increase Delta sigma_v vs depth</div>
              <div style="position:relative;height:180px"><canvas id="stage6SettlementStressChart" role="img" aria-label="Settlement stress increase versus depth"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Cumulative settlement vs depth</div>
              <div style="position:relative;height:180px"><canvas id="stage6SettlementCumulativeChart" role="img" aria-label="Cumulative settlement versus depth"></canvas></div>
            </div>
            ${analysis.timeCurve ? `
              <div>
                <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Indicative settlement time curve</div>
                <div style="position:relative;height:180px"><canvas id="stage6SettlementTimeChart" role="img" aria-label="Settlement time curve"></canvas></div>
              </div>
            `:''}
          </div>
        </div>
        <div>
          <table class="pt" style="margin-bottom:12px">
            <tr><td colspan="2" style="font-size:10px;font-weight:700;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Summary</td></tr>
            <tr><td>Total settlement</td><td>${analysis.totalSettlementMm.toFixed(1)} mm</td></tr>
            <tr><td>Target allowable</td><td>${cfg.allowableSettlement.toFixed(1)} mm</td></tr>
            <tr><td>Utilisation</td><td>${(analysis.totalSettlementMm/Math.max(cfg.allowableSettlement,1)).toFixed(2)}</td></tr>
            <tr><td>q_gross</td><td>${analysis.qGross.toFixed(1)} kPa</td></tr>
            <tr><td>q_net</td><td>${analysis.qNet.toFixed(1)} kPa</td></tr>
            <tr><td>Df</td><td>${analysis.Df.toFixed(2)} m</td></tr>
            <tr><td>Truncation</td><td>${analysis.truncationCause}</td></tr>
            <tr><td>z_trunc</td><td>${analysis.truncationDepth.toFixed(2)} m</td></tr>
            <tr><td>Sublayers used</td><td>${analysis.sublayers.length}</td></tr>
          </table>
        </div>
      </div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
        ${stage6LoadSummaryHtml('Load combination audit', loadRows)}
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Formula used</div>
          <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
            Delta eps = Delta sigma_v / E_oed(sigma_mean)<br>
            Delta S = Sum(Delta eps * Delta z)
          </div>
          <div style="font-size:11px;color:var(--tx2);line-height:1.55">
            Evaluation point = <strong>centre of loaded area</strong><br>
            Stress method = <strong>${cfg.stressMethod === 'two_to_one' ? '2:1 spread beneath centreline' : 'Boussinesq / Newmark centreline'}</strong><br>
            Soil route = <strong>Characteristic E_oed,ref and m</strong><br>
            Load route = <strong>SLS ${cfg.combination === 'qp' ? 'quasi-permanent' : cfg.combination}</strong><br>
            Truncation = <strong>${analysis.truncationCause}</strong>
          </div>
        </div>
      </div>
      <div class="mc2" style="margin-top:14px">
        <div class="mc2-sec">Per layer contribution</div>
        <table class="tbl">
          <thead><tr><th>Layer</th><th>Type</th><th>Top-Bot (m)</th><th>Thickness (m)</th><th>Settlement (mm)</th></tr></thead>
          <tbody>
            ${analysis.perLayer.map(row=>`<tr><td>${row.layerIndex+1}</td><td>${row.type}</td><td>${row.top.toFixed(2)}-${row.bot.toFixed(2)}</td><td>${row.thickness.toFixed(2)}</td><td>${row.settlementMm.toFixed(2)}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="mc2" style="margin-top:14px">
        <div class="mc2-sec">Audit sublayers</div>
        <div style="max-height:320px;overflow:auto">
          <table class="tbl">
            <thead><tr><th>z_mid</th><th>Layer</th><th>sigma'v0</th><th>Delta sigma</th><th>sigma'mean</th><th>E_oed</th><th>Delta S</th></tr></thead>
            <tbody>
              ${analysis.sublayers.map(row=>`<tr><td>${row.zMid.toFixed(2)}</td><td>${row.layerIndex+1}</td><td>${row.sigmaEff0.toFixed(1)}</td><td>${row.deltaSigmaV.toFixed(1)}</td><td>${row.sigmaMean.toFixed(1)}</td><td>${row.Eoed.toFixed(0)}</td><td>${row.dSmm.toFixed(3)}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      ${stage6NoteHtml(analysis.notes)}
    </div>
  `;
}

function renderStage6DewateringApp(analysis){
  const cfg = S.stage6.dewatering;
  const loadRows = [
    {k:'Limit state', v:'SLS'},
    {k:'Combination', v:cfg.combination === 'qp' ? 'Quasi-permanent drawdown context' : 'Characteristic drawdown'},
    {k:'Hydraulic model', v:analysis.hydraulicModel},
    {k:'Geometry', v:analysis.geometry.label},
    {k:'Original WT', v:`${S.wt.toFixed(2)} m`},
    {k:'Target WT at well', v:`${analysis.targetWt.toFixed(2)} m`},
    {k:'WT at CPT', v:`${analysis.newWtAtCpt.toFixed(2)} m`},
    {k:'Drawdown at CPT', v:`${analysis.drawdownAtCpt.toFixed(2)} m`},
    {k:analysis.geometry.distanceLabel || 'Source-CPT distance', v:`${(analysis.geometry.distanceToCpt || 0).toFixed(2)} m`},
    ...(analysis.geometry.wellRadius ? [{k:analysis.geometry.equivalentRadiusLabel || 'Well radius', v:`${analysis.geometry.wellRadius.toFixed(2)} m`}] : []),
    {k:'T far field', v:`${analysis.transmissivityFar.toExponential(2)} m²/s`},
    {k:'T at well', v:`${analysis.transmissivityWell.toExponential(2)} m²/s`},
    {k:'k_eff,h', v:`${analysis.effectiveK.toExponential(2)} m/s`},
    {k:'R', v:`${analysis.radiusInfluence.toFixed(1)} m`}
  ];
  return `
    <div class="mc2">
      <div class="mc2-head" style="margin-bottom:12px">
        <span style="font-size:13px;font-weight:600">Dewatering impact</span>
        <span style="font-size:11px;color:var(--tx2)">Hydrogeological screening plus stress and settlement response at the CPT location.</span>
      </div>
      <div style="display:grid;grid-template-columns:280px 1fr 260px;gap:14px;align-items:start">
        <div>
          <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Inputs</div>
          <div class="ctrl-row" style="padding:12px;display:grid;grid-template-columns:1fr;gap:10px">
            <label style="font-size:11px;color:var(--tx2)">Combination context
              <select onchange="setStage6Field('dewatering.combination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                ${stage6DewateringCombinationOptions(cfg.combination)}
              </select>
            </label>
            <div class="st6-help">${stage6DewateringCombinationHelp(cfg.combination)}</div>
            <label style="font-size:11px;color:var(--tx2)">Target water table at well / excavation (m below ground)
              <input type="number" step="0.1" min="${S.wt.toFixed(2)}" value="${cfg.targetWt.toFixed(2)}" onchange="setStage6Field('dewatering.targetWt', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Geometry
              <select onchange="setStage6Field('dewatering.geometry', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="single_well"${cfg.geometry==='single_well'?' selected':''}>Single well</option>
                <option value="equivalent_well_rectangular_excavation"${cfg.geometry==='equivalent_well_rectangular_excavation'?' selected':''}>Equivalent well excavation</option>
                <option value="line_dewatering_trench"${cfg.geometry==='line_dewatering_trench'?' selected':''}>Line dewatering trench</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Aquifer type
              <select onchange="setStage6Field('dewatering.aquiferType', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="unconfined"${cfg.aquiferType==='unconfined'?' selected':''}>Unconfined</option>
                <option value="confined"${cfg.aquiferType==='confined'?' selected':''}>Confined</option>
              </select>
            </label>
            ${cfg.geometry==='single_well' ? `
              <label style="font-size:11px;color:var(--tx2)">Well radius rw (m)
                <input type="number" step="0.05" min="0.05" value="${cfg.rw.toFixed(2)}" onchange="setStage6Field('dewatering.rw', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Distance well-CPT (m)
                <input type="number" step="0.5" min="0" value="${cfg.rCPT.toFixed(2)}" onchange="setStage6Field('dewatering.rCPT', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            ${cfg.geometry==='equivalent_well_rectangular_excavation' ? `
              <label style="font-size:11px;color:var(--tx2)">Pit length L (m)
                <input type="number" step="0.5" min="0.5" value="${cfg.LPit.toFixed(2)}" onchange="setStage6Field('dewatering.LPit', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Pit width B (m)
                <input type="number" step="0.5" min="0.5" value="${cfg.BPit.toFixed(2)}" onchange="setStage6Field('dewatering.BPit', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Centroid-CPT distance (m)
                <input type="number" step="0.5" min="0" value="${cfg.rCPT.toFixed(2)}" onchange="setStage6Field('dewatering.rCPT', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <div class="st6-help">The rectangular excavation is converted to an equivalent circular well using the same plan area. The drawdown curve is then evaluated at the CPT distance from the excavation centroid.</div>
            `:''}
            ${cfg.geometry==='line_dewatering_trench' ? `
              <label style="font-size:11px;color:var(--tx2)">Trench length (m)
                <input type="number" step="0.5" min="1" value="${cfg.LTrench.toFixed(2)}" onchange="setStage6Field('dewatering.LTrench', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Perpendicular CPT distance (m)
                <input type="number" step="0.5" min="0" value="${cfg.distanceToCPT.toFixed(2)}" onchange="setStage6Field('dewatering.distanceToCPT', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            <label style="font-size:11px;color:var(--tx2)">Sichardt coefficient C
              <input type="number" step="100" min="100" value="${cfg.CSichardt.toFixed(0)}" onchange="setStage6Field('dewatering.CSichardt', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Total stress mode
              <select onchange="setStage6Field('dewatering.sigmaVMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="conservative"${cfg.sigmaVMode==='conservative'?' selected':''}>Conservative sigma_v fixed</option>
                <option value="realistic"${cfg.sigmaVMode==='realistic'?' selected':''}>Realistic gamma_sat to gamma</option>
              </select>
            </label>
            <div class="st6-help">Conservative keeps the total overburden stress profile unchanged and only lowers pore pressure. Realistic also reduces total stress in the zone that changes from saturated to unsaturated, by switching from γ_sat to γ.</div>
            <label style="font-size:11px;color:var(--tx2)">Aquifer base depth (m, optional)
              <input type="number" step="0.5" min="0.5" value="${cfg.aquiferBaseDepth!=null?cfg.aquiferBaseDepth.toFixed(2):''}" onchange="setStage6Field('dewatering.aquiferBaseDepth', this.value)" placeholder="defaults to CPT bottom" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Sub-layer dz (m)
              <input type="number" step="0.05" min="0.05" value="${cfg.dz.toFixed(2)}" onchange="setStage6Field('dewatering.dz', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Time horizon for settlement curve (days, optional)
              <input type="number" step="10" min="0" value="${cfg.timeDays.toFixed(0)}" onchange="setStage6Field('dewatering.timeDays', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
          </div>
        </div>
        <div>
          <div style="display:grid;grid-template-columns:1fr;gap:12px">
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Estimated phreatic level profile from source to CPT</div>
              <div style="position:relative;height:170px"><canvas id="stage6DewateringDrawdownChart" role="img" aria-label="Drawdown profile"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Effective stress before / after drawdown</div>
              <div style="position:relative;height:170px"><canvas id="stage6DewateringStressChart" role="img" aria-label="Effective stress profile"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Total settlement versus distance from source</div>
              <div style="position:relative;height:170px"><canvas id="stage6DewateringSettlementChart" role="img" aria-label="Dewatering settlement versus distance"></canvas></div>
            </div>
            ${analysis.timeCurve ? `
              <div>
                <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Indicative settlement time curve</div>
                <div style="position:relative;height:170px"><canvas id="stage6DewateringTimeChart" role="img" aria-label="Dewatering settlement time curve"></canvas></div>
              </div>
            `:''}
          </div>
        </div>
        <div>
          <table class="pt" style="margin-bottom:12px">
            <tr><td colspan="2" style="font-size:10px;font-weight:700;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Summary</td></tr>
            <tr><td>New WT at CPT</td><td>${analysis.newWtAtCpt.toFixed(2)} m</td></tr>
            <tr><td>Drawdown at CPT</td><td>${analysis.drawdownAtCpt.toFixed(2)} m</td></tr>
            <tr><td>${analysis.geometry.distanceLabel || 'Source-CPT distance'}</td><td>${(analysis.geometry.distanceToCpt || 0).toFixed(2)} m</td></tr>
            ${analysis.geometry.wellRadius ? `<tr><td>${analysis.geometry.equivalentRadiusLabel || 'Well radius'}</td><td>${analysis.geometry.wellRadius.toFixed(2)} m</td></tr>` : ''}
            <tr><td>R influence</td><td>${analysis.radiusInfluence.toFixed(1)} m</td></tr>
            <tr><td>Q estimate</td><td>${analysis.QEstimate.toExponential(2)} ${analysis.QUnits}</td></tr>
            ${analysis.qPrime ? `<tr><td>q' estimate</td><td>${analysis.qPrime.toExponential(2)} ${analysis.qPrimeUnits}</td></tr>`:''}
            <tr><td>Aquifer base</td><td>${analysis.baseDepth.toFixed(2)} m</td></tr>
            <tr><td>Hydraulic model</td><td>${analysis.hydraulicModel}</td></tr>
            <tr><td>T far field</td><td>${analysis.transmissivityFar.toExponential(2)} m²/s</td></tr>
            <tr><td>T at well</td><td>${analysis.transmissivityWell.toExponential(2)} m²/s</td></tr>
            <tr><td>k_eff,h</td><td>${analysis.effectiveK.toExponential(2)} m/s</td></tr>
            <tr><td>Conservative settlement</td><td>${analysis.conservativeSettlementMm.toFixed(2)} mm</td></tr>
            <tr><td>Realistic settlement</td><td>${analysis.realisticSettlementMm.toFixed(2)} mm</td></tr>
            <tr><td>Max Δσv mode effect</td><td>${analysis.maxSigmaVShift.toFixed(1)} kPa</td></tr>
            <tr><td>Total settlement</td><td>${analysis.totalSettlementMm.toFixed(1)} mm</td></tr>
          </table>
          <div class="st6-help" style="margin-bottom:8px">Dewatering impact is treated as an SLS deformation screening tool. Use the expected drawdown directly; this module does not apply DA1/1 or DA1/2 style load factoring.</div>
          <div class="st6-help" style="margin-bottom:8px">Hydraulics are screened with a transmissivity-based model. The app combines the active layer conductivities into <strong>T = Σ(k_h · b)</strong> through the pumped interval and uses that profile in the radial or line-flow estimate.</div>
          <div class="st6-help">Important: settlement is driven by the <strong>drawdown at the CPT location</strong>, not by the target level at the well or excavation itself. If the CPT sits outside the computed screening influence radius, the module will show little or no settlement.</div>
        </div>
      </div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
        ${stage6LoadSummaryHtml('Hydraulic screening inputs', loadRows)}
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Formula route</div>
          <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
            R = C · s · sqrt(k)<br>
            h²(r) = h_w² + Q / (pi·k) · ln(r / r_w) &nbsp; (radial, unconfined)<br>
            Delta eps = Delta sigma' / E_oed(sigma_mean)
          </div>
          <div style="font-size:11px;color:var(--tx2);line-height:1.55">
            Geometry = <strong>${analysis.geometry.label}</strong><br>
            Aquifer type = <strong>${cfg.aquiferType}</strong><br>
            Distance axis = <strong>${analysis.geometry.geometry === 'line_dewatering_trench' ? 'perpendicular distance from trench' : 'radial distance from well centre / excavation centroid'}</strong><br>
            Settlement-distance curve = <strong>total settlement predicted at each x-location</strong><br>
            Total stress mode = <strong>${cfg.sigmaVMode}</strong><br>
            Settlement limit state = <strong>SLS only</strong><br>
            Combination route = <strong>${cfg.combination === 'qp' ? 'Quasi-permanent context, no γ factors' : 'Characteristic drawdown, no γ factors'}</strong>
          </div>
        </div>
      </div>
      <div class="mc2" style="margin-top:14px">
        <div class="mc2-sec">Per layer settlement contribution</div>
        <table class="tbl">
          <thead><tr><th>Layer</th><th>Type</th><th>Top-Bot (m)</th><th>Settlement (mm)</th></tr></thead>
          <tbody>${analysis.perLayer.map(row=>`<tr><td>${row.layerIndex+1}</td><td>${row.type}</td><td>${row.top.toFixed(2)}-${row.bot.toFixed(2)}</td><td>${row.settlementMm.toFixed(2)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      ${stage6NoteHtml(analysis.notes)}
    </div>
  `;
}

function renderStage6BeamApp(analysis){
  const cfg = S.stage6.beam;
  const ks = analysis.ksInfo;
  const reinf = analysis.reinforcement;
  const axisCopy = stage6BeamAxisCopy(cfg.modelMode);
  const momentUnits = reinf.momentUnits || 'kNm/m';
  const areaUnits = reinf.areaUnits || 'mm²/m';
  const loadInputKind = analysis.slsLoadMeta.units === 'kN' ? 'point action' : 'line load q(x)';
  const loadInputPlural = analysis.slsLoadMeta.units === 'kN' ? 'point actions' : 'line loads q(x)';
  const loadRows = [
    {k:'Analysis direction', v:axisCopy.summary},
    {k:'Foundation model', v:ks.foundationModel === 'pasternak' ? 'Pasternak (two-parameter)' : 'Winkler'},
    {k:'SLS route', v:`${analysis.slsLoadMeta.label}`},
    {k:'ULS route', v:`${analysis.ulsLoadMeta.label}`},
    {k:'SLS load', v:`${analysis.slsLoadMeta.value.toFixed(2)} ${analysis.slsLoadMeta.units}`},
    {k:'ULS load', v:`${analysis.ulsLoadMeta.value.toFixed(2)} ${analysis.ulsLoadMeta.units}`},
    {k:'Es mode', v:cfg.EsMode === 'young_drained' ? 'Young drained' : 'Oedometric'},
    {k:'Es avg', v:`${ks.EsAvg.toFixed(0)} kPa`},
    {k:'ks', v:`${ks.ks.toFixed(0)} kN/m³`},
    ...(ks.foundationModel === 'pasternak' ? [
      {k:'G_s,avg', v:`${ks.GsAvg.toFixed(0)} kPa`},
      {k:'G_p', v:`${ks.gp.toFixed(0)} kN/m`},
      {k:'eta', v:ks.gpEta.toFixed(2)}
    ] : []),
    {k:'beta*L', v:ks.betaL.toFixed(2)}
  ];
  return `
    <div class="mc2">
      <div class="mc2-head" style="margin-bottom:12px">
        <span style="font-size:13px;font-weight:600">Beam / slab on ${ks.foundationModel === 'pasternak' ? 'Pasternak' : 'Winkler'}</span>
        <span style="font-size:11px;color:var(--tx2)">1D strip model with SLS deflection and ULS reinforcement output from the current CPT stiffness profile.</span>
      </div>
      <div style="display:grid;grid-template-columns:300px 1fr 280px;gap:14px;align-items:start">
        <div>
          <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Inputs</div>
          <div class="ctrl-row" style="padding:12px;display:grid;grid-template-columns:1fr;gap:10px">
            <div class="st6-help" style="margin-bottom:2px">Pick the <strong>x direction</strong> first. The canvas shows the x-z model view and the y-z section for the values below.</div>
            ${stage6BeamOrientationHtml(cfg, analysis)}
            <label style="font-size:11px;color:var(--tx2)">${axisCopy.BLabel}${stage6Tooltip(axisCopy.BTip)}
              <input type="number" step="0.1" min="0.1" value="${cfg.B.toFixed(2)}" onchange="setStage6Field('beam.B', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">${axisCopy.bLabel}${stage6Tooltip(axisCopy.bTip)}
              <input type="number" step="0.1" min="0.1" value="${cfg.b.toFixed(2)}" onchange="setStage6Field('beam.b', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">${axisCopy.LLabel}${stage6Tooltip(axisCopy.LTip)}
              <input type="number" step="0.1" min="0.5" value="${cfg.L.toFixed(2)}" onchange="setStage6Field('beam.L', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">${axisCopy.hLabel}${stage6Tooltip('h is the vertical concrete section depth. It is used twice: it increases strip stiffness EI for the soil-supported beam solve and increases reinforcement effective depth d for the section check. Because a stiffer strip can bridge a larger MEd on elastic support, As,req can rise over some h ranges even though a fixed-moment section check would usually need less steel.')}
              <input type="number" step="0.01" min="0.1" value="${cfg.h.toFixed(2)}" onchange="setStage6Field('beam.h', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Founding depth Df (m)${stage6Tooltip('Df shifts the evaluation depth for the soil stiffness averaging. Use the depth of the underside of the slab, strip footing, or beam relative to ground level.')}
              <input type="number" step="0.1" min="0" value="${cfg.Df.toFixed(2)}" onchange="setStage6Field('beam.Df', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Concrete E (kPa)${stage6Tooltip('Concrete Young modulus used for EI. The default is a reasonable reinforced-concrete screening value. Change it only if you want a project-specific stiffness assumption.')}
              <input type="number" step="100000" min="1000000" value="${cfg.Ec.toFixed(0)}" onchange="setStage6Field('beam.Ec', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Foundation model${stage6Tooltip('Use Winkler as the standard first screening model. Pasternak adds shear coupling between adjacent soil springs and can give a smoother, more spread response, but in this app it is still an inferred experimental extension.')}
              <select onchange="setStage6Field('beam.foundationModel', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="winkler"${cfg.foundationModel==='winkler'?' selected':''}>Winkler</option>
                <option value="pasternak"${cfg.foundationModel==='pasternak'?' selected':''}>Pasternak (1D strip)</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Es route${stage6Tooltip('This controls how the CPT-derived stiffness is converted to the soil modulus used in k_s. The default keeps Es = E_oed for consistency with the oedometric CPT workflow.')}
              <select onchange="setStage6Field('beam.EsMode', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="oedometric"${cfg.EsMode==='oedometric'?' selected':''}>Es = E_oed, nu = 0</option>
                <option value="young_drained"${cfg.EsMode==='young_drained'?' selected':''}>Young drained conversion</option>
              </select>
            </label>
            <label style="font-size:11px;color:var(--tx2)">Influence depth for Es averaging (m)${stage6Tooltip('Depth range below Df over which the CPT stiffness is averaged to derive Es and k_s. Larger values smooth the soil profile more; smaller values make the support react more to the near-surface layer only.')}
              <input type="number" step="0.1" min="0.5" value="${cfg.zInfluence.toFixed(2)}" onchange="setStage6Field('beam.zInfluence', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            ${cfg.foundationModel==='pasternak' ? `
              <label style="font-size:11px;color:var(--tx2)">Pasternak coupling factor eta${stage6Tooltip('eta scales the inferred Pasternak shear layer: G_p = eta · G_s,avg · H_p. Start around 1.0. Lower eta weakens lateral coupling between springs; higher eta strengthens it.')}
                <input type="number" step="0.1" min="0" value="${cfg.gpEta.toFixed(2)}" onchange="setStage6Field('beam.gpEta', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Override G_p (kN/m, optional)${stage6Tooltip('Use this only if you already have an engineering value for the Pasternak shear parameter G_p. Leave it blank to let the app infer G_p from the CPT stiffness profile and eta.')}
                <input type="number" step="100" min="0" value="${cfg.gpOverride!=null?cfg.gpOverride:''}" onchange="setStage6Field('beam.gpOverride', this.value)" placeholder="leave blank to infer from CPT" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <div class="st6-help">Pasternak adds shear interaction between adjacent springs. Here <strong>eta</strong> is an engineer scaling factor in <strong>G_p = eta · G_s,avg · H_p</strong>. Start around <strong>1.0</strong>; lower values weaken the coupling, higher values strengthen it. Treat this as experimental screening unless calibrated.</div>
            `:''}
            <label style="font-size:11px;color:var(--tx2)">Load pattern${stage6Tooltip('Choose a load shape that matches how the slab or beam is really loaded. Uniform full length is often a settlement-style case; local bending is usually better captured by a patch load or a point load.')}
              <select onchange="setStage6Field('beam.loadPattern', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                <option value="uniform_full"${cfg.loadPattern==='uniform_full'?' selected':''}>Uniform full length</option>
                <option value="uniform_patch"${cfg.loadPattern==='uniform_patch'?' selected':''}>Uniform patch</option>
                <option value="point_centre"${cfg.loadPattern==='point_centre'?' selected':''}>Point load at centre</option>
                <option value="point_at_x"${cfg.loadPattern==='point_at_x'?' selected':''}>Point load at x</option>
              </select>
            </label>
            <div class="st6-help">${stage6BeamLoadPatternHelp(cfg.loadPattern)}</div>
            ${cfg.loadPattern==='uniform_patch' ? `
              <label style="font-size:11px;color:var(--tx2)">Patch start x (m)${stage6Tooltip('Start position of the loaded zone along the strip. Use this with patch end x to place a wall strip, loaded bay, or other local area load.')}
                <input type="number" step="0.1" min="0" value="${cfg.xStart.toFixed(2)}" onchange="setStage6Field('beam.xStart', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Patch end x (m)${stage6Tooltip('End position of the loaded patch. The bending moment is created only over this loaded interval, so this is often more useful than full-length loading for reinforcement screening.')}
                <input type="number" step="0.1" min="0" value="${cfg.xEnd.toFixed(2)}" onchange="setStage6Field('beam.xEnd', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            ${(cfg.loadPattern==='point_centre' || cfg.loadPattern==='point_at_x') ? `
              <label style="font-size:11px;color:var(--tx2)">Point load x-position (m)${stage6Tooltip('x-position of the concentrated load along the strip. This is useful for checking an isolated reaction, edge-near machine support, or local heavy point action.')}
                <input type="number" step="0.1" min="0" value="${cfg.xLoad.toFixed(2)}" onchange="setStage6Field('beam.xLoad', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
            `:''}
            <label style="font-size:11px;color:var(--tx2)">Allowable deflection ratio L / n${stage6Tooltip('Serviceability comparison only. The app reports w_max and compares it to L/n. This does not affect the ULS reinforcement result.')}
              <input type="number" step="50" min="100" value="${cfg.allowableDeflectionRatio.toFixed(0)}" onchange="setStage6Field('beam.allowableDeflectionRatio', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <details class="st6-adv" data-st6details="beam-loads"${stage6DetailsOpen('beam-loads')}>
              <summary>Load assumptions and Eurocode combination</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Expand this only if you want to change how the line load is assembled. The category sets the Eurocode ψ-factors for the variable action.</div>
                <label style="font-size:11px;color:var(--tx2)">SLS combination
                  <select onchange="setStage6Field('beam.slsCombination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${stage6SlsCombinationOptions(cfg.slsCombination)}
                  </select>
                </label>
                <div class="st6-help">${stage6SlsCombinationHelp(cfg.slsCombination, 'beam')}</div>
                <label style="font-size:11px;color:var(--tx2)">ULS action set
                  <select onchange="setStage6Field('beam.ulsCombination', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${stage6BeamUlsOptions(cfg.ulsCombination)}
                  </select>
                </label>
                <div class="st6-help">${stage6BeamUlsHelp(cfg.ulsCombination)}</div>
                <label style="font-size:11px;color:var(--tx2)">Load category for Eurocode ψ-factors
                  <select onchange="setStage6Field('beam.useCategory', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                    ${stage6UseCategoryOptions(cfg.useCategory)}
                  </select>
                </label>
                <div class="st6-help">${stage6UseCategoryHelp(cfg.useCategory)}</div>
                <label style="font-size:11px;color:var(--tx2)">Permanent ${loadInputKind} Gk (${analysis.slsLoadMeta.units})
                  <input type="number" step="1" min="0" value="${cfg.Gk.toFixed(1)}" onchange="setStage6Field('beam.Gk', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Leading variable ${loadInputKind} Qk (${analysis.slsLoadMeta.units})
                  <input type="number" step="1" min="0" value="${cfg.QLead.toFixed(1)}" onchange="setStage6Field('beam.QLead', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Other variable ${loadInputPlural} together (${analysis.slsLoadMeta.units})
                  <input type="number" step="1" min="0" value="${cfg.QOther.toFixed(1)}" onchange="setStage6Field('beam.QOther', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
              </div>
            </details>
            <div style="padding-top:6px;border-top:1px solid var(--bd)">
              <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">EC2 reinforcement</div>
              <label style="font-size:11px;color:var(--tx2)">Concrete class fck (MPa)${stage6Tooltip('Characteristic cylinder strength used for the EC2 ULS reinforcement design. The app applies the concrete material factor internally when deriving f_cd.')}
                <input type="number" step="1" min="12" value="${cfg.fck.toFixed(0)}" onchange="setStage6Field('beam.fck', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Steel fyk (MPa)${stage6Tooltip('Characteristic reinforcement yield strength. The app applies the EC2 steel material factor internally and designs with f_yd = f_yk / 1.15.')}
                <input type="number" step="10" min="200" value="${cfg.fyk.toFixed(0)}" onchange="setStage6Field('beam.fyk', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Exposure class${stage6Tooltip('Exposure class drives the EC2 durability cover recommendation c_nom. Pick the environment the member will actually see, then override only if project detailing requires it.')}
                <select onchange="setStage6Field('beam.exposureClass', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                  ${stage6ExposureOptions(cfg.exposureClass)}
                </select>
              </label>
              <div class="st6-help">${stage6ExposureHelp(cfg.exposureClass)}</div>
              <label style="font-size:11px;color:var(--tx2)">Design working life (years)${stage6Tooltip('Used in the EC2 durability route for the recommended nominal cover. Longer design life can lead to a higher recommended c_nom.')}
                <select onchange="setStage6Field('beam.designLifeYears', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                  <option value="25"${cfg.designLifeYears===25?' selected':''}>25 years</option>
                  <option value="50"${cfg.designLifeYears===50?' selected':''}>50 years</option>
                  <option value="100"${cfg.designLifeYears===100?' selected':''}>100 years</option>
                </select>
              </label>
              <label style="font-size:11px;color:var(--tx2)">Bar diameter (mm)${stage6Tooltip('Bar diameter used in the cover and effective-depth calculation. It affects d and therefore the resulting As requirement slightly.')}
                <input type="number" step="2" min="6" value="${cfg.phiBar.toFixed(0)}" onchange="setStage6Field('beam.phiBar', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Max aggregate size d_g (mm)
                <input type="number" step="1" min="8" value="${cfg.dG.toFixed(0)}" onchange="setStage6Field('beam.dG', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Δc_dev (mm)
                <input type="number" step="1" min="0" value="${cfg.deltaCdev.toFixed(0)}" onchange="setStage6Field('beam.deltaCdev', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2)">Override c_nom (mm, optional)
                <input type="number" step="1" min="0" value="${cfg.cNomOverride!=null?cfg.cNomOverride:''}" onchange="setStage6Field('beam.cNomOverride', this.value)" placeholder="leave blank for recommendation" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
              </label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.isSlabOrPlate?'checked':''} onchange="setStage6Field('beam.isSlabOrPlate', this.checked)">EC2 slab / plate durability class (cover only)</label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.specialQC?'checked':''} onchange="setStage6Field('beam.specialQC', this.checked)">special QC / precast-like execution</label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.castAgainstUnevenSurface?'checked':''} onchange="setStage6Field('beam.castAgainstUnevenSurface', this.checked)">cast against uneven prepared surface (+5 mm)</label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.castAgainstPreparedGround?'checked':''} onchange="setStage6Field('beam.castAgainstPreparedGround', this.checked)">cast against prepared ground / blinding (minimum 40 mm)</label>
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.castAgainstUnpreparedGround?'checked':''} onchange="setStage6Field('beam.castAgainstUnpreparedGround', this.checked)">cast against unprepared ground (minimum 75 mm)</label>
              <div class="st6-help">High-strength concrete reduction is checked automatically from the chosen fck and exposure class, following the EC2 Table 4.3N thresholds.</div>
            </div>
          </div>
        </div>
        <div>
          <div style="display:grid;grid-template-columns:1fr;gap:12px">
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">SLS deflection line w(x)</div>
              <div style="position:relative;height:190px"><canvas id="stage6BeamDeflectionChart" role="img" aria-label="Beam deflection diagram"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">ULS bending moment M(x)</div>
              <div style="position:relative;height:190px"><canvas id="stage6BeamMomentChart" role="img" aria-label="Beam bending moment diagram"></canvas></div>
            </div>
            <div>
              <div style="font-size:10px;color:var(--tx2);margin-bottom:4px">Geometry preview (view only)</div>
              <div style="position:relative;height:220px;border:1px solid var(--bd);border-radius:3px;background:var(--bg2);overflow:hidden">
                <canvas id="stage6BeamGeometryCanvas" role="img" aria-label="Beam or slab strip geometry preview" style="width:100%;height:100%;display:block"></canvas>
              </div>
            </div>
          </div>
        </div>
        <div>
          <table class="pt" style="margin-bottom:12px">
            <tr><td colspan="2" style="font-size:10px;font-weight:700;color:var(--tx2);padding-bottom:4px;border-bottom:1px solid var(--bd);text-transform:uppercase">Summary</td></tr>
            <tr><td>Es avg</td><td>${ks.EsAvg.toFixed(0)} kPa</td></tr>
            <tr><td>ks</td><td>${ks.ks.toFixed(0)} kN/m³</td></tr>
            ${ks.foundationModel === 'pasternak' ? `<tr><td>G_p</td><td>${ks.gp.toFixed(0)} kN/m</td></tr>` : ''}
            <tr><td>${ks.foundationModel === 'pasternak' ? 'lambda_ref' : 'lambda'}</td><td>${ks.lambda.toFixed(2)} m</td></tr>
            <tr><td>${ks.foundationModel === 'pasternak' ? 'beta·L ref' : 'beta·L'}</td><td>${ks.betaL.toFixed(2)}</td></tr>
            <tr><td>Classification</td><td>${ks.classification}</td></tr>
            <tr><td>w_max,SLS</td><td>${(analysis.sls.maxDeflection.value*1000).toFixed(2)} mm</td></tr>
            <tr><td>w_allow</td><td>${((cfg.L / cfg.allowableDeflectionRatio)*1000).toFixed(2)} mm</td></tr>
            <tr><td>SLS utilisation</td><td>${(Math.abs(analysis.sls.maxDeflection.value)/Math.max(cfg.L / cfg.allowableDeflectionRatio, 1e-6)).toFixed(2)}</td></tr>
            <tr><td>M_Ed,max</td><td>${Math.abs(analysis.uls.maxMoment.value).toFixed(2)} ${momentUnits}</td></tr>
            <tr><td>Exposure</td><td>${reinf.durability.exposureClass}</td></tr>
            <tr><td>Structural class</td><td>S${reinf.structuralClass}</td></tr>
            <tr><td>c_nom</td><td>${reinf.cNom.toFixed(0)} mm</td></tr>
            <tr><td>b_w</td><td>${reinf.bw.toFixed(0)} mm</td></tr>
            <tr><td>As,req</td><td>${reinf.AsReq!=null?reinf.AsReq.toFixed(0):'—'} ${areaUnits}</td></tr>
            <tr><td>As,min</td><td>${reinf.AsMin.toFixed(0)} ${areaUnits}</td></tr>
            <tr><td>As,governing</td><td>${reinf.As.toFixed(0)} ${areaUnits}</td></tr>
          </table>
          <div class="st6-help" style="margin-bottom:10px">${stage6BeamMomentContextHelp(cfg)}</div>
          <div class="st6-help">k_s is <strong>not</strong> a fixed soil material constant. It depends on the interpreted CPT stiffness, the loaded width <strong>B</strong>, the averaging depth, and the strip stiffness. As a rough order of magnitude only: very soft support may be around <strong>5,000-20,000 kN/m³</strong>, medium support <strong>20,000-80,000 kN/m³</strong>, and stiff/dense support <strong>80,000-200,000+ kN/m³</strong>. Use these only as a sanity check, not as target values.</div>
        </div>
      </div>
      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:14px">
        ${stage6LoadSummaryHtml('Vesic / load audit', loadRows)}
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          <div style="font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;margin-bottom:8px">Formula route</div>
          <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
            k_s = 0.65·E_s / [B·(1-nu²)] · (E_s·B^4 / (E_b·I_b))^(1/12)<br>
            ${ks.foundationModel === 'pasternak'
              ? `G_p = eta·G_s,avg·H_p &nbsp; (or engineer override)<br>EI·w'''' - G_p·b·w'' + k_s·b·w = q(x)`
              : `EI·w'''' + k_s·b·w = q(x)`}
          </div>
          <div style="font-size:11px;color:var(--tx2);line-height:1.55">
            Foundation model = <strong>${ks.foundationModel === 'pasternak' ? 'Pasternak (1D strip)' : 'Winkler'}</strong><br>
            Structural stiffness I = <strong>${ks.I.toFixed(5)} m4</strong><br>
            ULS design moment = <strong>${Math.abs(analysis.uls.maxMoment.value).toFixed(2)} ${momentUnits}</strong><br>
            c_nom used = <strong>${reinf.cNom.toFixed(0)} mm</strong><br>
            Effective depth d = <strong>${reinf.d.toFixed(0)} mm</strong><br>
            Structural class = <strong>S${reinf.structuralClass}</strong>
          </div>
        </div>
      </div>
      <div style="margin-top:14px">
        ${stage6BeamDurabilityHtml(reinf)}
      </div>
      ${stage6NoteHtml(analysis.notes)}
    </div>
  `;
}

function renderStage6BishopApp(){
  const bishop = S.stage6.bishop;
  const bishopUi = stage6BishopUiState();
  const model = stage6BishopCurrentModel();
  const modeMeta = stage6BishopModeMeta();
  const selected = stage6BishopSelectedResult();
  const results = bishop.results?.allResults || [];
  const summary = bishop.results?.summary;
  const wallSummary = bishop.results?.wallSummary || null;
  stage6BishopMigrateSurfaceLoadsShape(bishop);
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
  const seepageBoundary = S.stage6Cache?.bishopSeepageBoundary || stage6BishopCurrentSeepageBoundary(model);
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
  S.stage6Cache.bishopLineProbe = lineProbe;
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
  const workspaceGeometrySectionHtml = workspace === 'stability' ? `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-analysis"${stage6DetailsOpen('bishop-geo-analysis')}>
                <summary>Analysis inputs</summary>
                <div class="st6-adv-body">
                  <label style="font-size:11px;color:var(--tx2)">Material strength set${stage6Tooltip('Characteristic keeps the active CPT layer parameters unchanged. DA1/1 uses M1 soil factors and DA1/2 uses M2 soil factors before importing the Bishop base materials.')}
                    <select onchange="stage6BishopSetField('strengthSet', this.value)">
                      <option value="characteristic"${bishop.strengthSet==='characteristic'?' selected':''}>Characteristic</option>
                      <option value="da1_1"${bishop.strengthSet==='da1_1'?' selected':''}>DA1/1 (M1)</option>
                      <option value="da1_2"${bishop.strengthSet==='da1_2'?' selected':''}>DA1/2 (M2)</option>
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Method
                    <select onchange="stage6BishopSetField('methodMode', this.value)">
                      <option value="bishop_spencer"${bishop.methodMode==='bishop_spencer'?' selected':''}>Bishop + Spencer check</option>
                      <option value="bishop_only"${bishop.methodMode==='bishop_only'?' selected':''}>Bishop only</option>
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Surface load q (kPa)${stage6Tooltip('Uniform vertical surcharge intensity for the selected load zone. In the 2D Bishop section all active loads contribute q times their overlap width in each slice.')}
                    <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Analysis depth below terrain (m)${stage6Tooltip('The Bishop section extends to this depth below the local ground level at the active CPT. The default is the CPT depth or 15 m, whichever is greater. If you go deeper, the deepest CPT layer is extrapolated downward.')}
                    <input type="number" step="0.5" min="${Math.max(stage6MaxDepth(), 15).toFixed(2)}" value="${bishop.analysisDepth.toFixed(2)}" onchange="stage6BishopSetField('analysisDepth', this.value)">
                  </label>
                </div>
              </details>
  ` : workspace === 'seepage' ? `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-seepage-boundary"${stage6DetailsOpen('bishop-geo-seepage-boundary')}>
                <summary>Boundary conditions</summary>
                <div class="st6-adv-body">
                  <div class="st6-help">Switch the shared canvas into boundary-condition mode, then click an outer-boundary edge. Terrain, model base, and the two side boundaries can carry seepage BCs; interior soil-region edges cannot. New edges reuse the last boundary condition you applied, while edges that already have an explicit BC keep their own setting. For <strong>Prescribed head</strong>, enter the absolute head elevation <strong>h</strong> in metres; on a sloping or vertical edge the solver applies that head only to the submerged part below <strong>y = h</strong>, while the dry part above falls back to natural no-flow.</div>
                  <div class="st6-bishop-tools">
                    <button class="btn sm ${bishop.tool==='seepageBc'?'active':''}" onclick="stage6BishopSetTool('seepageBc')" ${model ? '' : 'disabled'}>Assign BC</button>
                    <button class="btn sm ${bishop.tool==='edit'?'active':''}" onclick="stage6BishopSetTool('edit')">Edit / pan</button>
                  </div>
                  ${selectedSeepageEdge ? `
                    <div class="st6-help">Selected edge: <strong>${stage6EscAttr(stage6BishopSeepageEdgeLabel(selectedSeepageEdge))}</strong> · length <strong>${selectedSeepageEdge.length.toFixed(2)} m</strong></div>
                    <label style="font-size:11px;color:var(--tx2)">Boundary type
                      <select onchange="stage6BishopSetSeepageBcType(this.value)">
                        <option value="no-flow"${(selectedSeepageBc?.type || 'no-flow')==='no-flow'?' selected':''}>No-flow</option>
                        <option value="head"${selectedSeepageBc?.type==='head'?' selected':''}>Prescribed head</option>
                        <option value="seepage-face"${selectedSeepageBc?.type==='seepage-face'?' selected':''}>Seepage face</option>
                      </select>
                    </label>
                    ${(selectedSeepageBc?.type || 'no-flow') === 'head' ? `
                      <label style="font-size:11px;color:var(--tx2)">Head h (m elevation)
                        <input type="number" step="0.05" value="${Number(selectedSeepageBc?.head ?? selectedSeepageEdge.mid.y).toFixed(2)}" onchange="stage6BishopSetSeepageBcHead(this.value)">
                      </label>
                    ` : ''}
                    <div class="st6-bishop-mini-actions">
                      <button class="btn sm" onclick="stage6BishopDeleteSeepageBc('${stage6EscAttr(selectedSeepageEdge.edgeKey)}')">Remove explicit BC</button>
                    </div>
                  ` : `
                    <div class="st6-help">${seepageSetupMessage}</div>
                  `}
                </div>
              </details>
  ` : `
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-deformation"${stage6DetailsOpen('bishop-geo-deformation')}>
                <summary>Mechanical inputs</summary>
                <div class="st6-adv-body">
                  <div class="st6-help">${deformationIsSafety
                    ? 'The safety route starts from a converged Mohr-Coulomb plastic equilibrium state and then runs a c-phi reduction phase with fixed actions. External loading is optional: without active surcharge strips, the analysis reduces strength under self-weight only.'
                    : 'This first deformation tool is a long-term drained screening solve on the shared triangular mesh. Draw the load interval on the terrain, choose whether you want to drive the model by applied pressure or total slab load, then size the out-of-plane length to approximate strip behaviour.'}</div>
                  <label style="font-size:11px;color:var(--tx2)">Analysis mode
                    <select onchange="stage6BishopSetField('deformation.options.analysisType', this.value)">
                      <option value="deformation"${deformationAnalysisType==='deformation'?' selected':''}>Deformation</option>
                      <option value="safety-cphi"${deformationAnalysisType==='safety-cphi'?' selected':''}>C-phi reduction safety</option>
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Load input mode
                    <select onchange="stage6BishopSetField('deformation.options.loadMode', this.value)">
                      <option value="pressure"${deformationLoadMode==='pressure'?' selected':''}>Pressure q (kPa)</option>
                      <option value="total"${deformationLoadMode==='total'?' selected':''}>Total load (kN)</option>
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Constitutive model
                    <select onchange="stage6BishopSetField('deformation.options.constitutiveModel', this.value)">
                      <option value="mc-plastic"${bishop.deformation?.options?.constitutiveModel==='mc-plastic'?' selected':''}>Mohr-Coulomb plastic</option>
                      <option value="mc-reduced-stiffness"${bishop.deformation?.options?.constitutiveModel==='mc-reduced-stiffness'?' selected':''}>Reduced-stiffness screen</option>
                      <option value="linear-elastic"${bishop.deformation?.options?.constitutiveModel==='linear-elastic'?' selected':''}>Linear elastic</option>
                    </select>
                  </label>
                  ${deformationUsesMcPlastic ? `
                  <label style="font-size:11px;color:var(--tx2)" title="WASM CPU only. Uses the Mohr-Coulomb consistent algorithmic tangent in plastic returns; turn off to compare with the previous elastic-tangent global Newton path.">
                    <input type="checkbox" ${deformationUsesMcConsistentTangent ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.useMcConsistentTangent', this.checked)">
                    MC Simo-Hughes tangent
                  </label>` : ''}
	                  <label style="font-size:11px;color:var(--tx2)">Initial equilibrium workflow
	                    <select onchange="stage6BishopSetField('deformation.options.geostaticInitializationMethod', this.value)">
	                      <option value="auto"${deformationGeostaticInitializationMethod==='auto'?' selected':''}>Auto K0 + self-weight equilibrium</option>
	                      ${bishop.deformation?.options?.constitutiveModel === 'mc-plastic' ? `<option value="gravity-ramp"${deformationGeostaticInitializationMethod==='gravity-ramp'?' selected':''}>Gravity ramp equilibrium</option>` : ''}
                    </select>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Surface load q (kPa)${stage6Tooltip(deformationIsSafety
                    ? 'Optional in safety mode. If you leave the load inactive, the c-phi reduction starts from the self-weight equilibrium state only. If you apply a surcharge, the safety phase starts from the converged end-of-service state and keeps that external load fixed.'
                    : 'Used directly in pressure mode. In total-load mode the app derives an equivalent 2D pressure q = total load / (loaded width × out-of-plane length).')}
                    <input type="number" step="1" min="0" value="${loadQ.toFixed(1)}" onchange="stage6BishopSetField('surfaceLoad.q', this.value)" ${deformationLoadMode === 'pressure' ? '' : 'disabled'}>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Total slab load (kN)
                    <input type="number" step="1" min="0" value="${deformationTotalLoad != null ? deformationTotalLoad.toFixed(1) : ''}" onchange="stage6BishopSetField('deformation.options.totalLoad', this.value)" ${deformationLoadMode === 'total' ? '' : 'disabled'}>
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Out-of-plane length (m)
                    <input type="number" step="0.5" min="0.1" value="${deformationOutOfPlaneLength.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.outOfPlaneLength', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Analysis depth below terrain (m)${stage6Tooltip('The deformation mesh uses the same section envelope as the seepage and stability tools. The bottom boundary is fixed vertically, so a deeper domain usually gives a less stiff settlement response.')}
                    <input type="number" step="0.5" min="${Math.max(stage6MaxDepth(), 15).toFixed(2)}" value="${bishop.analysisDepth.toFixed(2)}" onchange="stage6BishopSetField('analysisDepth', this.value)">
                  </label>
                  <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                    Analysis mode: <strong>${deformationIsSafety ? 'C-phi reduction safety' : 'Deformation'}</strong><br>
	                    Surface loads: <strong>${stage6EscAttr(loadSummary)}</strong><br>
	                    Total loaded width: <strong>${deformationWidth > 0 ? `${deformationWidth.toFixed(2)} m` : '—'}</strong><br>
	                    Average active pressure q: <strong>${deformationAppliedQ > 0 ? `${deformationAppliedQ.toFixed(2)} kPa` : '—'}</strong><br>
                    Total load: <strong>${deformationTotalLoad != null ? `${deformationTotalLoad.toFixed(1)} kN` : '—'}</strong><br>
                    ${deformationUsesMcPlastic ? `MC tangent: <strong>${deformationUsesMcConsistentTangent ? 'Simo-Hughes consistent' : 'elastic fallback'}</strong><br>` : ''}
                    Setup: <strong>${stage6EscAttr(deformationSetupMessage)}</strong>
                  </div>
                </div>
              </details>
  `;
  const workspaceSettingsHtml = workspace === 'stability' ? `
            <details class="st6-adv" data-st6details="bishop-search"${stage6DetailsOpen('bishop-search')}>
              <summary>Search and solver settings</summary>
              <div class="st6-adv-body">
                <div class="st6-help">If no valid slip circle is found, first try widening the entry and exit zones, increasing the entry / exit samples and centers per chord, increasing the maximum center offset, reducing the minimum slip thickness slightly, or allowing a somewhat larger exit angle. Simple, monotonic terrain geometry also helps the search.</div>
                <label style="font-size:11px;color:var(--tx2)">Entry samples
                  <input type="number" step="1" min="2" value="${bishop.search.nEntry}" onchange="stage6BishopSetField('search.nEntry', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Exit samples
                  <input type="number" step="1" min="2" value="${bishop.search.nExit}" onchange="stage6BishopSetField('search.nExit', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Centers per chord
                  <input type="number" step="1" min="2" value="${bishop.search.nCenter}" onchange="stage6BishopSetField('search.nCenter', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Center offset min (× chord)
                  <input type="number" step="0.1" min="0.05" value="${bishop.search.centerOffsetMin.toFixed(2)}" onchange="stage6BishopSetField('search.centerOffsetMin', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Center offset max (× chord)
                  <input type="number" step="0.1" min="0.10" value="${bishop.search.centerOffsetMax.toFixed(2)}" onchange="stage6BishopSetField('search.centerOffsetMax', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Target slices
                  <input type="number" step="1" min="6" value="${bishop.search.targetSlices}" onchange="stage6BishopSetField('search.targetSlices', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Minimum slip thickness (m)
                  <input type="number" step="0.05" min="0.1" value="${bishop.search.minSlipThickness.toFixed(2)}" onchange="stage6BishopSetField('search.minSlipThickness', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Maximum exit angle (deg)
                  <input type="number" step="1" min="5" max="89" value="${bishop.search.maxExitAngleDeg.toFixed(0)}" onchange="stage6BishopSetField('search.maxExitAngleDeg', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Tolerance
                  <input type="number" step="0.0001" min="0.000001" value="${bishop.solver.tolerance.toFixed(4)}" onchange="stage6BishopSetField('solver.tolerance', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Maximum iterations
                  <input type="number" step="1" min="5" value="${bishop.solver.maxIterations}" onchange="stage6BishopSetField('solver.maxIterations', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Minimum m_alpha
                  <input type="number" step="0.000001" min="0.000000001" value="${bishop.solver.minMAlpha}" onchange="stage6BishopSetField('solver.minMAlpha', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px">
                  <input type="checkbox" ${bishop.solver.useOrdinarySeed?'checked':''} onchange="stage6BishopSetField('solver.useOrdinarySeed', this.checked)">
                  Use ordinary method seed
                </label>
              </div>
            </details>
            <details class="st6-adv" data-st6details="bishop-spencer"${stage6DetailsOpen('bishop-spencer')}>
              <summary>Spencer recheck settings</summary>
              <div class="st6-adv-body">
                <div class="st6-help">When <strong>${stage6BishopMethodModeLabel('bishop_spencer')}</strong> is active, the app first searches with Bishop, then reruns the best circles with a full Spencer solve. For each shortlisted circle it solves the Spencer moment and force branches separately, then finds the λ where those branches intersect. Convergence is accepted on the branch-intersection residual; the λ tolerance field is retained only for compatibility with older saved configs. If Spencer fails on a shortlisted circle, the Bishop result is kept as a fallback.</div>
                <label style="font-size:11px;color:var(--tx2)">Recheck top N circles
                  <input type="number" step="1" min="1" max="${bishop.search.keepBest}" value="${bishop.spencer.recheckCount}" onchange="stage6BishopSetField('spencer.recheckCount', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Lambda low
                  <input type="number" step="0.05" value="${bishop.spencer.lambdaLow.toFixed(2)}" onchange="stage6BishopSetField('spencer.lambdaLow', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Lambda high
                  <input type="number" step="0.05" value="${bishop.spencer.lambdaHigh.toFixed(2)}" onchange="stage6BishopSetField('spencer.lambdaHigh', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Lambda tolerance (legacy)
                  <input type="number" step="0.0001" min="0.000001" value="${bishop.spencer.lambdaTolerance}" onchange="stage6BishopSetField('spencer.lambdaTolerance', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Moment-branch tolerance
                  <input type="number" step="0.0001" min="0.000001" value="${bishop.spencer.momentTolerance}" onchange="stage6BishopSetField('spencer.momentTolerance', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Force-branch tolerance
                  <input type="number" step="0.0001" min="0.000001" value="${bishop.spencer.forceTolerance}" onchange="stage6BishopSetField('spencer.forceTolerance', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">F bracket low
                  <input type="number" step="0.05" min="0.01" value="${bishop.spencer.FBracketLow.toFixed(2)}" onchange="stage6BishopSetField('spencer.FBracketLow', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">F bracket high
                  <input type="number" step="0.5" min="0.10" value="${bishop.spencer.FBracketHigh.toFixed(2)}" onchange="stage6BishopSetField('spencer.FBracketHigh', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Outer iterations
                  <input type="number" step="1" min="5" value="${bishop.spencer.maxOuterIter}" onchange="stage6BishopSetField('spencer.maxOuterIter', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Inner iterations
                  <input type="number" step="1" min="5" value="${bishop.spencer.maxInnerIter}" onchange="stage6BishopSetField('spencer.maxInnerIter', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px">
                  <input type="checkbox" ${bishop.spencer.fallbackBishop?'checked':''} onchange="stage6BishopSetField('spencer.fallbackBishop', this.checked)">
                  Fall back to Bishop if Spencer fails
                </label>
              </div>
            </details>
            <details class="st6-adv" data-st6details="bishop-materials"${stage6DetailsOpen('bishop-materials')}>
              <summary>Imported base materials from active CPT</summary>
              <div class="st6-adv-body">
                <div class="st6-help">The active CPT working layer model from Stages 2-5 is extended horizontally across the Bishop section. The current imported material set is <strong>${stage6BishopStrengthSetLabel(bishop.strengthSet)}</strong>. You can still tweak the displayed values here for sensitivity work.</div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>Layer</th><th>c'</th><th>phi'</th><th>gamma</th><th>gamma_sat</th></tr></thead>
                    <tbody>${materialRows}</tbody>
                  </table>
                </div>
              </div>
            </details>
  ` : workspace === 'seepage' ? `
            <details class="st6-adv" data-st6details="bishop-seepage-perm"${stage6DetailsOpen('bishop-seepage-perm')}>
              <summary>Permeability</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Each Bishop material now carries seepage permeability. CPT-derived values are carried through when available; otherwise the app uses an SBTn-style default. Editing either value marks that material as a user override.</div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>Material</th><th>k_x (m/s)</th><th>k_y (m/s)</th><th>Source</th><th></th></tr></thead>
                    <tbody>${permeabilityRows}</tbody>
                  </table>
                </div>
              </div>
            </details>
            <details class="st6-adv" data-st6details="bishop-seepage-bcs"${stage6DetailsOpen('bishop-seepage-bcs')}>
              <summary>Assigned boundary conditions</summary>
              <div class="st6-adv-body">
                <div class="st6-help">The seepage solver will require at least one prescribed-head edge. Any outer boundary edge without an explicit assignment still behaves as no-flow by default.</div>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                  Outer boundary edges: <strong>${seepageBoundary.length}</strong><br>
                  Active BCs: <strong>${seepageActiveBcs.length}</strong><br>
                  Prescribed head edges: <strong>${seepageHeadCount}</strong><br>
                  Orphaned BCs: <strong>${seepageOrphanedBcs.length}</strong><br>
                  Status: <strong>${stage6EscAttr(seepageSetupMessage)}</strong>
                </div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>Edge</th><th>Type</th><th>Head</th><th>Status</th><th></th></tr></thead>
                    <tbody>${seepageBcRows || '<tr><td colspan="5" style="text-align:center;color:var(--tx2)">No explicit boundary conditions yet.</td></tr>'}</tbody>
                  </table>
                </div>
                ${seepageOrphanedBcs.length ? `
                  <div class="st6-help">Some BC anchors no longer match the rebuilt geometry and are marked orphaned. Reassign those edges on the canvas before solving seepage.</div>
                ` : ''}
              </div>
            </details>
            <details class="st6-adv" data-st6details="bishop-seepage-drains"${stage6DetailsOpen('bishop-seepage-drains')}>
              <summary>Drains</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Draw an interior drain as a line in the shared canvas. After the second click, set the constant drain head in the selected row below. Per-vertex and invert-plus head modes remain disabled for this v1 plumbing phase.</div>
                <div class="st6-bishop-tools">
                  <button class="btn sm ${bishop.tool==='drain'?'active':''}" onclick="stage6BishopSetTool('drain')" ${model ? '' : 'disabled'}>Draw drain line</button>
                  <button class="btn sm" onclick="stage6BishopFinishDraft()" ${(bishop.draftKind==='drain' && bishop.draft.length >= 2) ? '' : 'disabled'}>Finish drain</button>
                  <button class="btn sm" onclick="stage6BishopClear('drains')" ${(bishop.drains || []).length ? '' : 'disabled'}>Clear drains</button>
                </div>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                  Drains: <strong>${(bishop.drains || []).length}</strong><br>
                  Validation: <strong>${stage6EscAttr(stage6BishopDrainValidationSummary(drainValidation))}</strong>
                </div>
                ${drainValidationHtml.length ? `
                  <div style="display:grid;gap:6px">
                    ${drainValidationHtml.map((issue)=>`
                      <div class="info" style="background:${issue.level === 'warn' ? 'var(--wnl)' : 'var(--bg2)'};border-color:${issue.level === 'warn' ? 'var(--wn)' : 'var(--bd2)'};margin:0">${stage6EscAttr(issue.text)}</div>
                    `).join('')}
                  </div>
                ` : ''}
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>Label</th><th>Vertices</th><th>Head h</th><th>Gating</th><th>Length</th><th></th><th></th></tr></thead>
                    <tbody>${drainRows || '<tr><td colspan="7" style="text-align:center;color:var(--tx2)">No drains yet. Use Draw drain line, then click a start and end point on the canvas.</td></tr>'}</tbody>
                  </table>
                </div>
              </div>
            </details>
            <details class="st6-adv" data-st6details="bishop-seepage-options"${stage6DetailsOpen('bishop-seepage-options')}>
              <summary>Mesh & solve</summary>
              <div class="st6-adv-body">
                <label style="font-size:11px;color:var(--tx2)">Free-surface mode
                  <select onchange="stage6BishopSetField('seepage.options.freeSurface', this.value)">
                    <option value="iterate"${seepage.options?.freeSurface==='iterate'?' selected':''}>Iterative free surface</option>
                    <option value="fixed"${seepage.options?.freeSurface==='fixed'?' selected':''}>Fixed phreatic line</option>
                  </select>
                </label>
                <label class="st6-bishop-check">
                  <input type="checkbox" ${seepageMeshTargetAreaAuto ? 'checked' : ''} onchange="stage6BishopSetField('seepage.options.meshTargetAreaAuto', this.checked)">
                  Auto size target area from the drawn geometry
                </label>
                <label style="font-size:11px;color:var(--tx2)">Target element area (m²)
                  <input type="number" step="0.01" min="0.01" value="${Number(seepageMeshTargetArea).toFixed(2)}" onchange="stage6BishopSetField('seepage.options.meshTargetArea', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Flow-rate error target (%)
                  <input type="number" step="0.01" min="0.0001" value="${(100 * Math.max(Number(seepage.options?.flowErrorTolerance) || 0.01, 0.000001)).toFixed(3)}" onchange="stage6BishopSetField('seepage.options.flowErrorTolerance', this.value)" ${seepageUsesIterativeFreeSurface ? '' : 'disabled'}>
                </label>
                <label style="font-size:11px;color:var(--tx2)">Max runtime (s)
                  <input type="number" step="0.1" min="0.1" value="${(Math.max(Number(seepage.options?.maxRuntimeMs) || 10000, 1) / 1000).toFixed(2)}" onchange="stage6BishopSetField('seepage.options.maxRuntimeMs', this.value)" ${seepageUsesIterativeFreeSurface ? '' : 'disabled'}>
                </label>
                <label class="st6-bishop-check">
                  <input type="checkbox" ${seepage.options?.usePhreaticAsSeed !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.options.usePhreaticAsSeed', this.checked)">
                  Use the drawn phreatic line as the initial wet/dry seed
                </label>
                <div class="st6-help">Iterative free surface is now the default. In iterative mode the seepage solve stops as soon as the flow-rate error target is met or the runtime limit is reached, whichever comes first. Fixed phreatic remains available when you intentionally want to lock seepage to a known phreatic line for benchmarking or sensitivity checks. The automatic target area scales from the drawn section geometry and becomes coarser for larger sections to keep the default mesh size under control. For the current section that lands around <strong>${seepageAutoMeshTargetArea.toFixed(2)} m²</strong>. Typing a value switches the mesh to manual sizing.</div>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                  Status: <strong>${stage6EscAttr(seepageStatusMessage)}</strong><br>
                  Solver: <strong>constrained triangular FEM mesh</strong><br>
                  Nodes: <strong>${seepage.mesh?.nodes?.length || 0}</strong><br>
                  Triangles: <strong>${seepage.mesh?.elements?.length || 0}</strong><br>
                  Rendered triangles: <strong>${seepage.mesh?.cells?.length || 0}</strong><br>
                  Head range: <strong>${seepage.result ? `${seepage.result.headMin.toFixed(2)} to ${seepage.result.headMax.toFixed(2)} m` : '—'}</strong><br>
                  Through-flow: <strong>${seepage.result ? `${(seepage.result.throughFlow || 0).toExponential(2)} m³/s/m` : '—'}</strong><br>
                  Drain inflow: <strong>${seepage.result ? `${seepageDrainInflow.toExponential(2)} m³/s/m` : '—'}</strong><br>
                  Drain outflow: <strong>${seepage.result ? `${seepageDrainOutflow.toExponential(2)} m³/s/m` : '—'}</strong><br>
                  Flow-rate error target: <strong>${seepageUsesIterativeFreeSurface ? `${(100 * Math.max(Number(seepage.options?.flowErrorTolerance) || 0.01, 0.000001)).toFixed(3)} %` : 'n/a'}</strong><br>
                  Runtime cap: <strong>${seepageUsesIterativeFreeSurface ? stage6SecondsLabelFromMs(Math.max(Number(seepage.options?.maxRuntimeMs) || 10000, 1)) : 'n/a'}</strong><br>
                  Total runtime: <strong>${stage6SecondsLabelFromMs(seepage.result?.timing?.totalMs)}</strong><br>
                  Flow-rate error: <strong>${stage6SeepageFlowErrorLabel(seepage.result)}</strong><br>
                  Termination: <strong>${stage6EscAttr(stage6BishopSeepageTerminationLabel(seepage.result?.solver?.terminationReason))}</strong><br>
                  Max exit gradient: <strong>${seepage.result ? (seepage.result.maxExitGradient || 0).toFixed(3) : '—'}</strong><br>
                  Dry cells: <strong>${seepage.result?.dryCellCount || 0}</strong>
                </div>
                <div class="st6-help">The seepage solver now rebuilds the shared Bishop section into a constrained triangular mesh, solves the head field in a worker, and feeds that result back into the canvas overlays and the optional FEM pore-pressure hook.</div>
              </div>
            </details>
            <details class="st6-adv" data-st6details="bishop-seepage-integration"${stage6DetailsOpen('bishop-seepage-integration')}>
              <summary>Bishop integration</summary>
              <div class="st6-adv-body">
                <label class="st6-bishop-check">
                  <input type="checkbox" ${bishop.useFemPorePressure ? 'checked' : ''} onchange="stage6BishopSetField('useFemPorePressure', this.checked)">
                  Use FEM pore pressure when a seepage result exists
                </label>
                <div class="st6-help">This opt-in stays harmless while the seepage result is empty: Bishop and Spencer continue to use the drawn hydrostatic phreatic line until a seepage field is available.</div>
              </div>
            </details>
  ` : `
            <details class="st6-adv" data-st6details="bishop-deformation-materials"${stage6DetailsOpen('bishop-deformation-materials')}>
              <summary>Imported deformation materials</summary>
              <div class="st6-adv-body">
                <div class="st6-help">The deformation screen reuses the active CPT-derived layer column across the whole section. The default Mohr-Coulomb plastic route uses an exact active-set return with face, edge, apex, and tension cut-off handling. The reduced-stiffness screen and linear elastic route remain available for sensitivity checks.</div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials st6-bishop-materials--deformation">
                    <colgroup>
                      <col class="st6-mat-col-layer">
                      <col class="st6-mat-col-emc">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                      <col class="st6-mat-col-small">
                    </colgroup>
                    <thead><tr><th>Layer</th><th>E_mc (kPa)</th><th>nu</th><th>K0</th><th>r_shear</th><th>c'</th><th>phi'</th><th>psi</th></tr></thead>
                    <tbody>${deformationMaterialRows}</tbody>
                  </table>
                </div>
                ${STAGE6_ENABLE_HARDENING_SOIL_UI ? hsMaterialTableHtml : ''}
              </div>
            </details>
            <details class="st6-adv" data-st6details="bishop-deformation-solve"${stage6DetailsOpen('bishop-deformation-solve')}>
              <summary>Mesh & run state</summary>
              <div class="st6-adv-body">
                <label class="st6-bishop-check">
                  <input type="checkbox" ${deformationMeshTargetAreaAuto ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.meshTargetAreaAuto', this.checked)">
                  Auto size target area from the drawn geometry
                </label>
                <label style="font-size:11px;color:var(--tx2)">Target element area (m²)
                  <input type="number" step="0.005" min="0.01" value="${Number(deformationMeshTargetArea).toFixed(3)}" onchange="stage6BishopSetField('deformation.options.meshTargetArea', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Triangle element
                  <select onchange="stage6BishopSetField('deformation.options.meshElementType', this.value)">
                    <option value="t3" ${deformationMeshElementType === 't3' ? 'selected' : ''}>T3 - constant strain, fast</option>
                    <option value="t6" ${deformationMeshElementType === 't6' ? 'selected' : ''}>T6 - quadratic, 3 Gauss points</option>
                  </select>
                </label>
                <label class="st6-bishop-check">
                  <input type="checkbox" ${deformation.options?.useSeepagePorePressures ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.useSeepagePorePressures', this.checked)">
                  Use seepage pore pressures when a seepage result exists
                </label>
                <div class="st6-help">${deformationIsSafety
                  ? `The safety mesh still follows the shared section geometry, with local refinement under active surcharge strips. The automatic target area scales from the current section and is about <strong>${deformationAutoMeshTargetArea.toFixed(3)} m²</strong> here. The safety phase starts from a converged self-weight equilibrium state before the strength-reduction multiplier ΣMsf is advanced.`
		                  : `The deformation mesh is intentionally refined beneath the loaded interval and both load edges. T3 is the fast constant-strain path; T6 uses six-node quadratic triangles and three integration points per element to resolve bending and stress gradients with lower mesh sensitivity. The automatic target area is about <strong>${deformationAutoMeshTargetArea.toFixed(3)} m²</strong> here. The default workflow recovers a K0 stress field and requires self-weight equilibrium before service loading.`}</div>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                  Status: <strong>${stage6EscAttr(deformationStatusMessage)}</strong><br>
                  Solver: <strong>${stage6EscAttr(deformationSolverLabel)}</strong><br>
                  Initial workflow: <strong>${stage6EscAttr(deformationRequestedInitialStressMode)}</strong><br>
                  Initial stress: <strong>${stage6EscAttr(deformationInitialStressMode)}</strong><br>
                  Initial equilibration: <strong>${stage6EscAttr(deformationInitialPhaseStatus)}</strong><br>
                  Service phase: <strong>${stage6EscAttr(deformationServicePhaseStatus)}</strong><br>
                  ${deformationIsSafety ? `Safety phase: <strong>${stage6EscAttr(deformationSafetyStatus)}</strong><br>` : ''}
                  ${deformationIsSafety ? `FoS lower bound: <strong>${deformationSafetyFoSLower != null ? deformationSafetyFoSLower.toFixed(3) : '—'}</strong><br>` : ''}
                  ${deformationIsSafety ? `FoS upper bound: <strong>${deformationSafetyOpenEnded && deformationSafetyFoSLower != null ? `> ${deformationSafetyFoSLower.toFixed(3)}` : (deformationSafetyFoSUpper != null ? deformationSafetyFoSUpper.toFixed(3) : '—')}</strong><br>` : ''}
                  ${deformationIsSafety ? `Displayed ΣMsf: <strong>${deformationSafetyDisplayedSigmaMsf != null ? deformationSafetyDisplayedSigmaMsf.toFixed(3) : '—'}</strong><br>` : ''}
                  ${deformationIsSafety ? `Displayed retained strength: <strong>${deformationSafetyStrengthRetained != null ? `${(100 * deformationSafetyStrengthRetained).toFixed(2)} %` : '—'}</strong><br>` : ''}
                  Element type: <strong>${stage6EscAttr(deformationMeshElementLabel)}</strong><br>
                  Nodes: <strong>${deformation.mesh?.nodes?.length || 0}</strong><br>
                  Mechanical walls: <strong>${deformation.mesh?.mechanicalWalls?.length || 0}</strong><br>
                  Mid-edge nodes: <strong>${deformation.mesh?.meshStats?.midEdgeNodes || 0}</strong><br>
                  Triangles: <strong>${deformation.mesh?.elements?.length || 0}</strong><br>
                  Integration points: <strong>${deformation.result?.solver?.integrationPointCount || 0}</strong><br>
                  Free DOFs: <strong>${deformation.result?.solver?.freeDofs || 0}</strong><br>
                  Geostatic CG iterations: <strong>${deformationGeostaticIterations ?? '—'}</strong><br>
                  Geostatic residual: <strong>${deformationGeostaticResidual}</strong><br>
                  ${deformationIsSafety
                    ? `Safety continuation steps: <strong>${deformation.result?.solver?.safetyAcceptedContinuationSteps || 0}</strong>${deformation.result?.solver?.safetyRejectedContinuationSteps ? ` accepted, ${deformation.result.solver.safetyRejectedContinuationSteps} cut back` : ''}<br>`
                    : `Load steps: <strong>${deformationAcceptedSteps ?? '—'}</strong>${deformationRejectedSteps ? ` accepted, ${deformationRejectedSteps} cut back` : ''}<br>`}
                  ${deformationIsSafety
                    ? ''
                    : `Load factor shown: <strong>${deformationDisplayedLoadFactor != null ? `${(100 * deformationDisplayedLoadFactor).toFixed(1)} %` : '—'}</strong><br>
                  Last converged load factor: <strong>${deformationCommittedLoadFactor != null ? `${(100 * deformationCommittedLoadFactor).toFixed(1)} %` : '—'}</strong><br>`}
                  Nonlinear iterations: <strong>${deformation.result?.solver?.nonlinearIterations || 0}</strong><br>
                  Linear iterations: <strong>${deformation.result?.solver?.linearIterations || 0}</strong><br>
                  Residual: <strong>${Number.isFinite(deformation.result?.solver?.residualNorm) ? Number(deformation.result.solver.residualNorm).toExponential(2) : '—'}</strong><br>
                  Peak active MC elements: <strong>${deformationPeakActive ?? '—'}</strong><br>
                  ${deformationIsSafety
                    ? `Max safety Δε̄ᵖ: <strong>${deformation.result ? `${(100 * (deformation.result.summaries?.maxSafetyEquivalentPlasticIncrement || 0)).toFixed(3)} %` : '—'}</strong><br>`
                    : `Initial max settlement: <strong>${deformation.result ? `${(1000 * (deformation.result.summaries?.maxInitialSettlement || 0)).toFixed(2)} mm` : '—'}</strong><br>`}
                  Runtime: <strong>${stage6SecondsLabelFromMs(deformation.result?.timing?.totalMs)}</strong>
                </div>
                ${deformationWarnings.length ? `
                  <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
                    ${deformationWarnings.map((warning)=>stage6EscAttr(warning)).join('<br>')}
                  </div>
                ` : ''}
                ${(deformation.result?.solver?.initialPhaseDepthBandReport || deformation.result?.solver?.servicePhaseDepthBandReport) ? `
                  <details class="st6-adv" data-st6details="bishop-deformation-diagnostics"${stage6DetailsOpen('bishop-deformation-diagnostics')}>
                    <summary>Plasticity diagnostics</summary>
                    <div class="st6-adv-body">
                      ${stage6DepthBandReportHtml(deformation.result?.solver?.initialPhaseDepthBandReport, 'Initial self-weight')}
                      ${stage6DepthBandReportHtml(deformation.result?.solver?.servicePhaseDepthBandReport, 'Service loading')}
                    </div>
                  </details>
                ` : ''}
              </div>
            </details>
            <details class="st6-adv" data-st6details="bishop-deformation-solver-settings"${stage6DetailsOpen('bishop-deformation-solver-settings')}>
              <summary>Solver settings</summary>
              <div class="st6-adv-body">
                <div class="st6-help">${deformationIsSafety
                  ? 'These settings control both the base deformation solve and the c-phi reduction search. The safety phase expands the strength-reduction multiplier ΣMsf until failure is bracketed, then refines that bracket conservatively from the last converged state.'
                  : 'These settings control how aggressively the nonlinear deformation solver searches for equilibrium before it cuts the load step back or stops. Smaller initial steps and more conservative growth help near plastic collapse; tighter tolerances demand a cleaner residual before a step is accepted.'}</div>
                <label style="font-size:11px;color:var(--tx2)">Nonlinear iterations per load step
                  <input type="number" step="1" min="1" value="${deformationNonlinearMaxIterations}" onchange="stage6BishopSetField('deformation.options.nonlinearMaxIterations', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Initial load step (0-1)
                  <input type="number" step="0.01" min="${deformationMinLoadStep.toFixed(6)}" max="1" value="${deformationInitialLoadStep.toFixed(3)}" onchange="stage6BishopSetField('deformation.options.initialLoadStep', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Minimum load step
                  <input type="number" step="0.0001" min="0.000001" value="${deformationMinLoadStep.toFixed(6)}" onchange="stage6BishopSetField('deformation.options.minLoadStep', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Maximum load steps
                  <input type="number" step="1" min="1" value="${deformationMaxLoadSteps}" onchange="stage6BishopSetField('deformation.options.maxLoadSteps', this.value)">
                </label>
		                <div class="st6-help">Auto is the production workflow: one K0 stress-recovery seed, followed by the required self-weight equilibrium solve before service or safety loading.</div>
		                <label style="font-size:11px;color:var(--tx2)">Geostatic correction stages
		                  <input type="number" step="1" min="1" max="64" value="${deformationGeostaticCorrectionStages}" onchange="stage6BishopSetField('deformation.options.geostaticCorrectionStages', this.value)">
		                </label>
                <label style="font-size:11px;color:var(--tx2)">Residual relative tolerance
                  <input type="number" step="0.00001" min="0.00000001" value="${deformationResidualRelTol.toExponential(3)}" onchange="stage6BishopSetField('deformation.options.residualRelTol', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Residual absolute tolerance
                  <input type="number" step="0.000001" min="0.000000001" value="${deformationResidualAbsTol.toExponential(3)}" onchange="stage6BishopSetField('deformation.options.residualAbsTol', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Displacement relative tolerance
                  <input type="number" step="0.000001" min="0.00000001" value="${deformationDisplacementRelTol.toExponential(3)}" onchange="stage6BishopSetField('deformation.options.displacementRelTol', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Displacement absolute tolerance
                  <input type="number" step="0.000000001" min="0.000000000001" value="${deformationDisplacementAbsTol.toExponential(3)}" onchange="stage6BishopSetField('deformation.options.displacementAbsTol', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Load-step growth factor
                  <input type="number" step="0.01" min="1" value="${deformationLoadStepGrowthFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.loadStepGrowthFactor', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Load-step cutback factor
                  <input type="number" step="0.01" min="0.1" max="0.9" value="${deformationLoadStepCutbackFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.loadStepCutbackFactor', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Plastic growth factor
                  <input type="number" step="0.01" min="1" value="${deformationPlasticLoadStepGrowthFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.plasticLoadStepGrowthFactor', this.value)">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Plastic cutback factor
                  <input type="number" step="0.01" min="0.1" max="0.9" value="${deformationPlasticLoadStepCutbackFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.plasticLoadStepCutbackFactor', this.value)">
                </label>
	                <label class="st6-bishop-check">
	                  <input type="checkbox" ${deformationUseUnsymmetricPlasticSolver ? 'checked' : ''} onchange="stage6BishopSetField('deformation.options.useUnsymmetricPlasticSolver', this.checked)">
	                  Nonsymmetric plastic tangents
	                </label>
	                <label class="st6-bishop-check">
	                  <span style="font-size:11px;color:var(--tx2);min-width:80px">Solve path:</span>
	                  <select onchange="stage6BishopSetField('deformation.options.solverBackend', this.value)" style="font-size:11px">
	                    <option value="js-cpu" ${deformationSolverBackend === 'js-cpu' ? 'selected' : ''}>JS CPU</option>
	                    <option value="wasm-cpu" ${deformationSolverBackend === 'wasm-cpu' ? 'selected' : ''}>WASM CPU</option>
	                  </select>
	                </label>
                ${deformationIsSafety ? `
                  <label style="font-size:11px;color:var(--tx2)">Initial ΣMsf increment
                    <input type="number" step="0.01" min="0.001" value="${deformationSafetyInitialSigmaMsfIncrement.toFixed(3)}" onchange="stage6BishopSetField('deformation.options.safetyInitialSigmaMsfIncrement', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">ΣMsf growth factor
                    <input type="number" step="0.01" min="1.01" value="${deformationSafetySigmaMsfGrowthFactor.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.safetySigmaMsfGrowthFactor', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Maximum ΣMsf
                    <input type="number" step="0.05" min="1.00" value="${deformationSafetySigmaMsfMax.toFixed(2)}" onchange="stage6BishopSetField('deformation.options.safetySigmaMsfMax', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">FoS bracket tolerance
                    <input type="number" step="0.001" min="0.0001" value="${deformationSafetySigmaMsfBracketTolerance.toFixed(3)}" onchange="stage6BishopSetField('deformation.options.safetySigmaMsfBracketTolerance', this.value)">
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Maximum safety trials
                    <input type="number" step="1" min="1" value="${deformationSafetyMaxSearchTrials}" onchange="stage6BishopSetField('deformation.options.safetyMaxSearchTrials', this.value)">
                  </label>
                ` : ''}
              </div>
            </details>
  `;
  const workspaceInfoHtml = workspace === 'stability' ? `
            <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
              Solver polygons: <strong>${model?.regions?.length || 0}</strong> (${model?.regionMode === 'custom' ? 'custom' : 'CPT-derived'})<br>
              Custom polygons stored: <strong>${customRegionCount}</strong><br>
              Polygon overlay: <strong>${showingCustomRegionPreview ? 'custom preview' : (model?.regionMode === 'custom' ? 'custom active' : 'CPT-derived')}</strong><br>
              Terrain vertices: <strong>${bishop.terrain.length}</strong><br>
              Phreatic vertices: <strong>${bishop.phreatic.length}</strong><br>
              Retaining walls: <strong>${wallCount}</strong><br>
              Active CPT x: <strong>${Number.isFinite(bishop.activeCptX)?bishop.activeCptX.toFixed(2)+' m':'not placed'}</strong><br>
              Entry zone: <strong>${bishop.entryZone?`${bishop.entryZone.xStart.toFixed(2)}-${bishop.entryZone.xEnd.toFixed(2)} m`:'not set'}</strong><br>
              Exit zone: <strong>${bishop.exitZone?`${bishop.exitZone.xStart.toFixed(2)}-${bishop.exitZone.xEnd.toFixed(2)} m`:'not set'}</strong><br>
              Surface load: <strong>${loadSummary}</strong><br>
              Measurement: <strong>${stage6EscAttr(measurementStatus)}</strong>
            </div>
  ` : workspace === 'seepage' ? `
            <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
              Shared geometry polygons: <strong>${model?.regions?.length || 0}</strong><br>
              Outer seepage boundary edges: <strong>${seepageBoundary.length}</strong><br>
              Explicit BCs: <strong>${seepageActiveBcs.length}</strong><br>
              Prescribed head edges: <strong>${seepageHeadCount}</strong><br>
              Orphaned BCs: <strong>${seepageOrphanedBcs.length}</strong><br>
              Selected edge: <strong>${selectedSeepageEdge ? stage6EscAttr(stage6BishopSeepageEdgeLabel(selectedSeepageEdge)) : 'none'}</strong><br>
              Free-surface mode: <strong>${stage6EscAttr(seepage.options?.freeSurface === 'iterate' ? 'iterative' : 'fixed')}</strong><br>
              Solver status: <strong>${stage6EscAttr(seepageStatusLabel)}</strong><br>
              Last head range: <strong>${seepage.result ? `${seepage.result.headMin.toFixed(2)} to ${seepage.result.headMax.toFixed(2)} m` : '—'}</strong><br>
              Measurement: <strong>${stage6EscAttr(measurementStatus)}</strong>
            </div>
  ` : `
            <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
              Shared geometry polygons: <strong>${model?.regions?.length || 0}</strong><br>
              Active CPT x: <strong>${Number.isFinite(bishop.activeCptX)?bishop.activeCptX.toFixed(2)+' m':'not placed'}</strong><br>
	              Surface loads: <strong>${stage6EscAttr(loadSummary)}</strong><br>
	              Load mode: <strong>${deformationLoadMode === 'total' ? 'total load' : 'pressure q'}</strong><br>
	              Average active pressure q: <strong>${deformationAppliedQ > 0 ? `${deformationAppliedQ.toFixed(2)} kPa` : '—'}</strong><br>
              Element type: <strong>${stage6EscAttr(deformationMeshElementLabel)}</strong><br>
              Out-of-plane length: <strong>${deformationOutOfPlaneLength.toFixed(2)} m</strong><br>
              Seepage pore pressures: <strong>${deformation.options?.useSeepagePorePressures ? 'enabled when available' : 'off'}</strong><br>
              Initial workflow: <strong>${stage6EscAttr(deformationRequestedInitialStressMode)}</strong><br>
              Solver status: <strong>${stage6EscAttr(deformationStatusLabel)}</strong><br>
              Last max settlement: <strong>${deformation.result ? `${(1000 * (deformation.result.summaries?.maxSettlement || 0)).toFixed(2)} mm` : '—'}</strong><br>
              Measurement: <strong>${stage6EscAttr(measurementStatus)}</strong>
            </div>
  `;
  const workspaceCanvasHelp = workspace === 'stability'
    ? 'Canvas order: draw terrain left-to-right or import a DXF terrain line, click <strong>Finish line</strong> to accept the terrain or phreatic line, place the active CPT on the terrain, optionally add retaining walls and one or more load zones, then draw the entry and exit zones. The coloured polygons are the solver regions from Phase A; hover one to inspect its current material parameters. In custom mode you can also select a polygon, drag its vertices, split it by clicking two boundary points, or cut an interior hole with a different material.'
    : workspace === 'seepage'
      ? 'The seepage workspace reuses the same Bishop section. Use <strong>Assign BC</strong> and click the terrain, model base, or side boundaries to assign prescribed head, no-flow, or seepage-face conditions, then click <strong>Run seepage</strong>. The same terrain, polygons, walls, snap settings, and viewport stay active while you switch between stability and seepage. Contour fill, contour lines, and the legend now follow the selected seepage field, while flow lines, the phreatic line, and exit-gradient highlights remain optional overlays. When a measurement line exists, the results panel can also probe heads, gradients, and discharge along it.'
	      : (deformationIsSafety
	        ? 'The deformation workspace also supports a c-phi reduction safety route. It first requires a converged Mohr-Coulomb plastic equilibrium state, then keeps the actions fixed while reducing strength through the multiplier ΣMsf. Self-weight-only safety runs are allowed when no surcharge is active. Contours and the shared line probe can inspect the additional safety displacement field and incremental safety plasticity band.'
	        : 'The deformation workspace reuses the same section mesh logic and geometry. Draw the load interval on the terrain, set either the pressure or total slab load, then run the drained plane-strain screen. The default Mohr-Coulomb plastic route builds a K0 seed and requires self-weight equilibrium before service loading. Contour fill, contour lines, the optional legend, and the shared measurement line all follow the selected deformation field.');
  const lineProbeSelectionPath = workspace === 'seepage' ? 'lineProbe.seepageQuantity' : 'lineProbe.deformationQuantity';
  const lineProbeCopyToneColor = bishop.lineProbe?.copyTone === 'ok' ? 'var(--ok-text)' : bishop.lineProbe?.copyTone === 'warn' ? 'var(--wn)' : 'var(--tx2)';
  const lineProbeSummaryHtml = lineProbe.status === 'ready' ? `
            <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:10px">
              Line: <strong>${stage6EscAttr(stage6BishopMeasurementLabel(measurementMetrics))}</strong><br>
              Quantity: <strong>${stage6EscAttr(lineProbe.meta?.label || 'Line probe')}</strong><br>
              Valid samples: <strong>${lineProbe.stats.validCount}/${lineProbe.sampleCount}</strong>${lineProbe.coverage != null ? ` (${(100 * lineProbe.coverage).toFixed(0)}%)` : ''}<br>
              Range: <strong>${stage6EscAttr(stage6BishopLineProbeFormatValue(lineProbe.meta, lineProbe.stats.min))} to ${stage6EscAttr(stage6BishopLineProbeFormatValue(lineProbe.meta, lineProbe.stats.max))}</strong><br>
              Mean: <strong>${stage6EscAttr(stage6BishopLineProbeFormatValue(lineProbe.meta, lineProbe.stats.mean))}</strong>
              ${lineProbe.quantity === 'normalFlow' && Number.isFinite(lineProbe.netCrossFlow) ? `<br>Net cross-flow: <strong>${stage6CompactNumber(lineProbe.netCrossFlow, 3)} m³/s/m</strong><br>Absolute cross-flow: <strong>${stage6CompactNumber(lineProbe.absCrossFlow, 3)} m³/s/m</strong>` : ''}
            </div>
            ${lineProbe.quantity === 'normalFlow' ? `<div class="st6-help" style="margin-bottom:10px">Positive <strong>q_n</strong> means flow across the left side of the measurement direction A→B; reverse the measurement points if you want the sign convention flipped.</div>` : ''}
            ${lineProbe.message ? `<div class="st6-help" style="margin-bottom:10px">${stage6EscAttr(lineProbe.message)}</div>` : ''}
          `
    : `<div class="st6-help" style="margin-bottom:10px">${stage6EscAttr(lineProbe.message || 'No line probe available yet.')}</div>`;
  const lineProbeHtml = workspace === 'seepage' || workspace === 'deformation' ? `
            <div class="st6-bishop-side" style="margin-top:14px">
              <div class="mc2-sec">Line probe</div>
              <div class="st6-help" style="margin-bottom:10px">The graph follows the shared measurement line without covering the canvas. Use <strong>Measure</strong> in the geometry tools to set or replace the probe line.</div>
              <label style="font-size:11px;color:var(--tx2);margin-bottom:10px;display:block">Quantity
                <select onchange="stage6BishopSetField('${lineProbeSelectionPath}', this.value)">
                  ${lineProbeOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${lineProbe.quantity===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
                </select>
              </label>
              <div class="st6-bishop-mini-actions" style="margin-bottom:10px">
                <button class="btn sm ${bishop.tool==='measure'?'active':''}" onclick="stage6BishopSetTool('measure')">Set probe line</button>
                <button class="btn sm" onclick="stage6BishopClear('measure')" ${measurementPoints.length ? '' : 'disabled'}>Clear line</button>
                <button class="btn sm" onclick="stage6BishopCopyLineProbeData()" ${lineProbe.status === 'ready' ? '' : 'disabled'}>Copy graph data</button>
              </div>
              ${bishop.lineProbe?.copyMessage ? `<div class="st6-help" style="margin-bottom:10px;color:${lineProbeCopyToneColor}">${stage6EscAttr(bishop.lineProbe.copyMessage)}</div>` : ''}
              ${lineProbeSummaryHtml}
              ${lineProbe.status === 'ready' ? `<div style="position:relative;height:220px"><canvas id="stage6BishopLineProbeChart" role="img" aria-label="Line probe graph"></canvas></div>` : ''}
            </div>
          ` : '';
  const analysisTab = bishop.analysisTab === 'structure' ? 'structure' : 'line-probe';
  const analysisWallId = stage6BishopAnalysisWallId();
  const analysisWall = (bishop.walls || []).find((wall)=>wall.id === analysisWallId) || null;
  const analysisWallIndex = analysisWall ? (bishop.walls || []).findIndex((wall)=>wall.id === analysisWall.id) : -1;
  const analysisWallResult = analysisWall ? stage6BishopWallResultForId(analysisWall.id) : null;
  const analysisWallSeries = analysisWallResult ? stage6BishopWallResultSeries(analysisWallResult) : null;
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
  const structureAnalysisHtml = `
    <div class="st6-bishop-side" style="margin-top:14px">
      <div class="mc2-sec">Structure response</div>
      <div class="st6-help" style="margin-bottom:10px">The graphs use station <strong>s</strong> from the wall head to the tip on the vertical axis. The horizontal axis is the signed response value; positive V, M, and w act toward the wall passive side. For a right-passive wall, negative w plots to the left.</div>
      ${(bishop.walls || []).length ? `
        <label style="font-size:11px;color:var(--tx2);margin-bottom:10px;display:block">Wall
          <select onchange="stage6BishopOpenAnalysisTab('structure', this.value)">
            ${analysisWallOptionHtml}
          </select>
        </label>
      ` : ''}
      ${analysisWall ? `
        <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:10px">
          Wall: <strong>${analysisWallIndex + 1}</strong><br>
          Mechanical: <strong>${analysisWall.mechanicalActive === true ? 'active' : 'inactive'}</strong><br>
          Section: <strong>${stage6EscAttr(stage6BishopWallMechanicalLabel(analysisWall))}</strong><br>
          Result stations: <strong>${analysisWallResult?.stations?.length || 0}</strong>
        </div>
        ${analysisWallResult && analysisWallSeries ? `
          <div class="st6-bishop-mini-actions" style="margin-bottom:10px">
            <button class="btn sm" onclick="stage6BishopSelectWall(${stage6EscJsString(analysisWall.id)})">Open wall settings</button>
            <button class="btn sm" onclick="stage6BishopCopyWallData(${stage6EscJsString(analysisWall.id)})">Copy wall data</button>
          </div>
          ${wallCopyMessage ? `<div class="st6-help" style="margin-bottom:10px">${stage6EscAttr(wallCopyMessage.length > 160 ? 'Wall response prepared as TSV.' : wallCopyMessage)}</div>` : ''}
          <div class="st6-wall-chart-grid">${wallChartsHtml}</div>
        ` : '<div class="st6-help" style="margin-bottom:10px">Run deformation with this wall mechanically active to inspect N, V, M, w, and theta diagrams.</div>'}
      ` : '<div class="st6-help" style="margin-bottom:10px">Draw a retaining wall in Structures, activate it mechanically, and run deformation to inspect structure response diagrams.</div>'}
    </div>
  `;
  const analysisTabsHtml = `
    <div class="st6-analysis-tabs" role="tablist" aria-label="Analysis result views">
      <button type="button" class="st6-analysis-tab${analysisTab === 'line-probe' ? ' active' : ''}" onclick="stage6BishopSetAnalysisTab('line-probe')" role="tab" aria-selected="${analysisTab === 'line-probe' ? 'true' : 'false'}">Line probe</button>
      <button type="button" class="st6-analysis-tab${analysisTab === 'structure' ? ' active' : ''}" onclick="stage6BishopSetAnalysisTab('structure')" role="tab" aria-selected="${analysisTab === 'structure' ? 'true' : 'false'}">Structure</button>
    </div>
  `;
  const analysisSheetHtml = `
    <div class="st6-canvas-sheet-grid">
      ${analysisTabsHtml}
      ${analysisTab === 'structure'
        ? structureAnalysisHtml
        : (lineProbeHtml || `<div class="st6-help" style="margin-bottom:10px">Line-probe analysis is available in the Seepage and Deformation workspaces.</div>`)}
    </div>
  `;
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
  const viewSectionHtml = `
              <details class="st6-adv st6-bishop-view-panel" data-st6details="bishop-geo-view"${stage6DetailsOpen('bishop-geo-view')}>
                <summary>View</summary>
                <div class="st6-adv-body">
                  <div class="st6-bishop-view-grid">
                    <div class="st6-bishop-view-card">
                      <div class="st6-bishop-view-card-title">Snap</div>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.gridSnap?'checked':''} onchange="stage6BishopSetField('gridSnap', this.checked)">
                        Snap to grid
                      </label>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.pointSnap?'checked':''} onchange="stage6BishopSetField('pointSnap', this.checked)">
                        Snap to existing points
                      </label>
                      <label style="font-size:11px;color:var(--tx2)">Grid size (m)
                        <input type="number" step="0.05" min="0.05" value="${bishop.snapSize.toFixed(2)}" onchange="stage6BishopSetField('snapSize', this.value)">
                      </label>
                      <div class="st6-help">If both snap modes are enabled, the cursor snaps to whichever candidate is closer: the grid node or the nearest existing Bishop canvas point.</div>
                    </div>
                    <div class="st6-bishop-view-card">
                      <div class="st6-bishop-view-card-title">Polygon overlay</div>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.display?.showRegions !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegions', this.checked)">
                        Show soil polygons
                      </label>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.display?.showRegionLabels !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLabels', this.checked)">
                        Show polygon labels
                      </label>
                      <label class="st6-bishop-check">
                        <input type="checkbox" ${bishop.display?.showRegionLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLegend', this.checked)">
                        Show polygon legend
                      </label>
                      <label style="font-size:11px;color:var(--tx2)">Fill opacity
                        <input type="number" step="0.05" min="0.05" max="0.75" value="${Number(bishop.display?.regionOpacity ?? 0.22).toFixed(2)}" onchange="stage6BishopSetField('display.regionOpacity', this.value)">
                      </label>
                    </div>
                    ${workspace === 'seepage' ? `
                      <div class="st6-bishop-view-card">
                        <div class="st6-bishop-view-card-title">Seepage contours</div>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showContours !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showContours', this.checked)">
                          Show contour fill
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showContourLines !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showContourLines', this.checked)">
                          Show contour lines
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showContourLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showContourLegend', this.checked)">
                          Show contour legend
                        </label>
                        <label style="font-size:11px;color:var(--tx2)">Contour mode
                          <select onchange="stage6BishopSetField('seepage.display.contourMode', this.value)">
                            ${seepageContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${bishop.seepage?.display?.contourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
                          </select>
                        </label>
                      </div>
                      <div class="st6-bishop-view-card">
                        <div class="st6-bishop-view-card-title">Seepage overlay</div>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showBoundaryConditions !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showBoundaryConditions', this.checked)">
                          Show boundary conditions
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showBoundaryLabels !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showBoundaryLabels', this.checked)">
                          Show BC labels
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showPhreatic !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showPhreatic', this.checked)">
                          Show phreatic line
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showDrains !== false ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showDrains', this.checked)">
                          Show drains
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showFlowVectors ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showFlowVectors', this.checked)">
                          Show flow lines
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.seepage?.display?.showExitGradient ? 'checked' : ''} onchange="stage6BishopSetField('seepage.display.showExitGradient', this.checked)">
                          Show exit gradient
                        </label>
                      </div>
                    ` : workspace === 'deformation' ? `
                      <div class="st6-bishop-view-card">
                        <div class="st6-bishop-view-card-title">Contour overlay</div>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showContours !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showContours', this.checked)">
                          Show contour fill
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showContourLines !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showContourLines', this.checked)">
                          Show contour lines
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showContourLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showContourLegend', this.checked)">
                          Show contour legend
                        </label>
                        <label style="font-size:11px;color:var(--tx2)">Contour mode
                          <select onchange="stage6BishopSetField('deformation.display.contourMode', this.value)">
                            ${deformationContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${bishop.deformation?.display?.contourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
                          </select>
                        </label>
                      </div>
                      <div class="st6-bishop-view-card">
                        <div class="st6-bishop-view-card-title">Mesh and vectors</div>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showDeformedMesh !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showDeformedMesh', this.checked)">
                          Show deformed mesh
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showUndeformedMesh ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showUndeformedMesh', this.checked)">
                          Show undeformed mesh
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showLoadVectors !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showLoadVectors', this.checked)">
                          Show load vectors
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showPlasticPoints !== false ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showPlasticPoints', this.checked)">
                          Show plastic points
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${deformationShowWallOverlay ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showWallMomentOverlay', this.checked)">
                          Show wall result overlay
                        </label>
                        <label style="font-size:11px;color:var(--tx2)">Wall overlay quantity
                          <select onchange="stage6BishopSetField('deformation.display.wallOverlayQuantity', this.value)" title="${stage6EscAttr(wallOverlayStatsLabel)}">
                            ${STAGE6_WALL_RESPONSE_QUANTITIES.map((option)=>`<option value="${stage6EscAttr(option.id)}"${wallOverlayQuantity===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
                          </select>
                        </label>
                        <label class="st6-bishop-check">
                          <input type="checkbox" ${bishop.deformation?.display?.showDisplacementVectors ? 'checked' : ''} onchange="stage6BishopSetField('deformation.display.showDisplacementVectors', this.checked)" ${deformationDisplacementVectorAvailable ? '' : 'disabled'}>
                          Show displacement direction vectors
                        </label>
                        <div class="st6-help">Filled red points mark currently active plastic points, amber points mark active tension cut-off points, and magenta rings show stored plastic history. In the reduced-stiffness screen the same overlay marks MC-active hotspots.</div>
                        <label style="font-size:11px;color:var(--tx2)">Deformed-shape scale factor
                          <input type="number" step="0.1" min="0.05" value="${Number(bishop.deformation?.options?.displacementScale || 1).toFixed(2)}" onchange="stage6BishopSetField('deformation.options.displacementScale', this.value)">
                        </label>
                        <div class="st6-help">Wall diagrams are signed: positive w, V, and M plot toward the selected passive side; for a right-passive wall, negative w is left. Displacement vectors are shown sparsely on the current contour lines for <strong>Settlement</strong>, <strong>|u|,fin</strong>, <strong>uₓ,fin</strong>, and <strong>uᵧ,fin</strong>. They stay off for stress and MC contour modes.</div>
                      </div>
                    ` : ''}
                  </div>
                </div>
              </details>
  `;
  const deformationContourLegendHtml = deformationContourDerived &&
      bishop.deformation?.display?.showContourLegend !== false &&
      (bishop.deformation?.display?.showContours !== false || bishop.deformation?.display?.showContourLines !== false)
    ? `
              <details class="st6-bishop-contour-legend" data-st6details="bishop-deformation-contour-legend"${stage6DetailsOpen('bishop-deformation-contour-legend')}>
                <summary>
                  <span class="st6-bishop-contour-legend-title">Legend</span>
                  <span class="st6-bishop-contour-legend-mode">${stage6EscAttr(deformationContourLegendMeta.label)}</span>
                </summary>
                <div class="st6-bishop-contour-legend-panel">
                  <div class="st6-bishop-contour-legend-unit">${stage6EscAttr(deformationContourLegendMeta.unit || 'relative')}</div>
                  <div class="st6-bishop-contour-legend-body">
                    <div class="st6-bishop-contour-legend-scale" style="background:${stage6EscAttr(stage6BishopDeformationContourLegendGradient(deformationContourMode, deformationAnalysisType))}"></div>
                    <div class="st6-bishop-contour-legend-ticks">
                      ${deformationContourLegendTicks.map((value)=>`<span>${stage6EscAttr(stage6BishopDeformationContourLegendValue(deformationContourMode, value, deformationAnalysisType))}</span>`).join('')}
                    </div>
                  </div>
                </div>
              </details>
            `
    : '';
  const seepageContourLegendHtml = seepageContourDerived &&
      bishop.seepage?.display?.showContourLegend !== false &&
      (bishop.seepage?.display?.showContours !== false || bishop.seepage?.display?.showContourLines !== false)
    ? `
              <details class="st6-bishop-contour-legend" data-st6details="bishop-seepage-contour-legend"${stage6DetailsOpen('bishop-seepage-contour-legend')}>
                <summary>
                  <span class="st6-bishop-contour-legend-title">Legend</span>
                  <span class="st6-bishop-contour-legend-mode">${stage6EscAttr(seepageContourLegendMeta.label)}</span>
                </summary>
                <div class="st6-bishop-contour-legend-panel">
                  <div class="st6-bishop-contour-legend-unit">${stage6EscAttr(seepageContourLegendMeta.unit || 'relative')}</div>
                  <div class="st6-bishop-contour-legend-body">
                    <div class="st6-bishop-contour-legend-scale" style="background:${stage6EscAttr(stage6BishopSeepageContourLegendGradient(seepageContourMode))}"></div>
                    <div class="st6-bishop-contour-legend-ticks">
                      ${seepageContourLegendTicks.map((value)=>`<span>${stage6EscAttr(stage6BishopSeepageContourLegendValue(seepageContourMode, value))}</span>`).join('')}
                    </div>
                  </div>
                </div>
              </details>
            `
    : '';
  const activeContourLegendHtml = workspace === 'seepage'
    ? seepageContourLegendHtml
    : deformationContourLegendHtml;
  const viewMenuIconButton = ({label, icon, active, disabled, onclick})=>`
    <button
      type="button"
      class="st6-bishop-view-menu-action${active ? ' active' : ''}"
      ${disabled ? 'disabled' : `onclick="${onclick}"`}
      title="${stage6EscAttr(label)}"
      aria-label="${stage6EscAttr(label)}"
    >${stage6BishopToolIcon(icon)}</button>
  `;
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
  const viewMenuContourControlHtml = workspace === 'seepage' ? `
    <label class="st6-bishop-view-menu-field">Contour mode
      <select onchange="stage6BishopSetField('seepage.display.contourMode', this.value)">
        ${seepageContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${seepageContourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
      </select>
    </label>
  ` : workspace === 'deformation' ? `
    <label class="st6-bishop-view-menu-field">Contour mode
      <select onchange="stage6BishopSetField('deformation.display.contourMode', this.value)">
        ${deformationContourOptions.map((option)=>`<option value="${stage6EscAttr(option.id)}"${deformationContourMode===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
      </select>
    </label>
  ` : '';
  const viewMenuWorkspaceOverlayHtml = workspace === 'seepage' ? `
    <div class="st6-bishop-view-menu-icon-grid">
      ${viewMenuIconButton({
        label:'Contour fill',
        icon:'contourFill',
        active:seepageShowContours,
        onclick:`stage6BishopSetField('seepage.display.showContours', ${seepageShowContours ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Contour lines',
        icon:'contourLines',
        active:seepageShowContourLines,
        onclick:`stage6BishopSetField('seepage.display.showContourLines', ${seepageShowContourLines ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Contour legend',
        icon:'layers',
        active:seepageShowContourLegend,
        onclick:`stage6BishopSetField('seepage.display.showContourLegend', ${seepageShowContourLegend ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Boundary conditions',
        icon:'boundary',
        active:seepageShowBoundaryConditions,
        onclick:`stage6BishopSetField('seepage.display.showBoundaryConditions', ${seepageShowBoundaryConditions ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Boundary labels',
        icon:'label',
        active:seepageShowBoundaryLabels,
        onclick:`stage6BishopSetField('seepage.display.showBoundaryLabels', ${seepageShowBoundaryLabels ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Phreatic line',
        icon:'phreatic',
        active:seepageShowPhreatic,
        onclick:`stage6BishopSetField('seepage.display.showPhreatic', ${seepageShowPhreatic ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Drains',
        icon:'drain',
        active:seepageShowDrains,
        onclick:`stage6BishopSetField('seepage.display.showDrains', ${seepageShowDrains ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Flow lines',
        icon:'arrows',
        active:seepageShowFlowVectors,
        onclick:`stage6BishopSetField('seepage.display.showFlowVectors', ${seepageShowFlowVectors ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Exit gradient',
        icon:'exitGradient',
        active:seepageShowExitGradient,
        onclick:`stage6BishopSetField('seepage.display.showExitGradient', ${seepageShowExitGradient ? 'false' : 'true'})`
      })}
    </div>
  ` : workspace === 'deformation' ? `
    <div class="st6-bishop-view-menu-icon-grid">
      ${viewMenuIconButton({
        label:'Contour fill',
        icon:'contourFill',
        active:deformationShowContours,
        onclick:`stage6BishopSetField('deformation.display.showContours', ${deformationShowContours ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Contour lines',
        icon:'contourLines',
        active:deformationShowContourLines,
        onclick:`stage6BishopSetField('deformation.display.showContourLines', ${deformationShowContourLines ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Contour legend',
        icon:'layers',
        active:deformationShowContourLegend,
        onclick:`stage6BishopSetField('deformation.display.showContourLegend', ${deformationShowContourLegend ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Deformed mesh',
        icon:'meshDeformed',
        active:deformationShowDeformedMesh,
        onclick:`stage6BishopSetField('deformation.display.showDeformedMesh', ${deformationShowDeformedMesh ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Undeformed mesh',
        icon:'meshUndeformed',
        active:deformationShowUndeformedMesh,
        onclick:`stage6BishopSetField('deformation.display.showUndeformedMesh', ${deformationShowUndeformedMesh ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Plastic points',
        icon:'plastic',
        active:deformationShowPlasticPoints,
        onclick:`stage6BishopSetField('deformation.display.showPlasticPoints', ${deformationShowPlasticPoints ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Direction vectors',
        icon:'arrows',
        active:deformationShowDirectionVectors,
        disabled:!deformationDisplacementVectorAvailable,
        onclick:`stage6BishopSetField('deformation.display.showDisplacementVectors', ${deformationShowDirectionVectors ? 'false' : 'true'})`
      })}
      ${viewMenuIconButton({
        label:'Wall result overlay',
        icon:'chart',
        active:deformationShowWallOverlay,
        onclick:`stage6BishopSetField('deformation.display.showWallMomentOverlay', ${deformationShowWallOverlay ? 'false' : 'true'})`
      })}
    </div>
    <label class="st6-bishop-view-menu-field" title="${stage6EscAttr(wallOverlayStatsLabel)}">Wall overlay quantity
      <select onchange="stage6BishopSetField('deformation.display.wallOverlayQuantity', this.value)">
        ${STAGE6_WALL_RESPONSE_QUANTITIES.map((option)=>`<option value="${stage6EscAttr(option.id)}"${wallOverlayQuantity===option.id?' selected':''}>${stage6EscAttr(option.label)}</option>`).join('')}
      </select>
    </label>
    <label class="st6-bishop-view-menu-field">Shape scale
      <input type="number" step="0.1" min="0.05" value="${Number(bishop.deformation?.options?.displacementScale || 1).toFixed(2)}" onchange="stage6BishopSetField('deformation.options.displacementScale', this.value)">
    </label>
  ` : '';
  const canvasViewMenuHtml = `
    <details class="st6-bishop-view-menu" data-st6details="bishop-canvas-view-menu"${stage6DetailsOpen('bishop-canvas-view-menu')}>
      <summary title="View" aria-label="View">
        <span class="st6-bishop-view-menu-icon">${stage6BishopToolIcon('layers')}</span>
        <span class="st6-bishop-region-legend-title st6-bishop-view-menu-title">View</span>
        ${regionLegendItems.length ? `<span class="st6-bishop-region-legend-count">${regionLegendItems.length}</span>` : ''}
      </summary>
      <div class="st6-bishop-view-menu-body" data-st6scroll-key="bishop-canvas-view-menu-body">
        <div class="st6-bishop-view-menu-actions">
          <button type="button" class="st6-bishop-view-menu-action" onclick="fitStage6BishopViewport()" title="Fit view" aria-label="Fit view">${stage6BishopToolIcon('fit')}</button>
          <button type="button" class="st6-bishop-view-menu-action" onclick="stage6BishopOpenSettingsDetail('bishop-geo-view')" title="View details" aria-label="View details">${stage6BishopToolIcon('panel')}</button>
        </div>
        ${viewMenuContourControlHtml}
        <div class="st6-bishop-view-menu-section">
          <div class="st6-bishop-view-menu-label">Snap</div>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.gridSnap?'checked':''} onchange="stage6BishopSetField('gridSnap', this.checked)"> Grid</label>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.pointSnap?'checked':''} onchange="stage6BishopSetField('pointSnap', this.checked)"> Points</label>
          <label class="st6-bishop-view-menu-field">Grid size
            <input type="number" step="0.05" min="0.05" value="${bishop.snapSize.toFixed(2)}" onchange="stage6BishopSetField('snapSize', this.value)">
          </label>
        </div>
        <div class="st6-bishop-view-menu-section">
          <div class="st6-bishop-view-menu-label">Polygons</div>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.display?.showRegions !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegions', this.checked)"> Fill</label>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.display?.showRegionLabels !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLabels', this.checked)"> Labels</label>
          <label class="st6-bishop-check"><input type="checkbox" ${bishop.display?.showRegionLegend !== false ? 'checked' : ''} onchange="stage6BishopSetField('display.showRegionLegend', this.checked)"> List</label>
          ${bishop.display?.showRegionLegend !== false && regionLegendItems.length ? `
            <div class="st6-bishop-region-legend-body st6-bishop-view-menu-region-list">
              ${regionLegendItems.map((item)=>`
                <div class="st6-bishop-region-chip">
                  <span class="st6-bishop-region-swatch" style="background:${stage6EscAttr(item.color)}"></span>
                  <span class="st6-bishop-region-text">${stage6EscAttr(item.label)}${item.count > 1 ? ` <em>(${item.count})</em>` : ''}</span>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
        ${viewMenuWorkspaceOverlayHtml ? `
          <div class="st6-bishop-view-menu-section">
            <div class="st6-bishop-view-menu-label">${workspace === 'seepage' ? 'Seepage' : 'Deformation'}</div>
            ${viewMenuWorkspaceOverlayHtml}
          </div>
        ` : ''}
      </div>
    </details>
  `;
  const structuresSheetHtml = `
    <div class="st6-canvas-sheet-grid">
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Retaining walls</div>
        <div class="st6-help">Edit geometry, passive side, and seepage conductivity for every wall without opening the old settings column.</div>
        <div class="st6-canvas-table-wrap">
          <table class="tbl st6-bishop-materials">
            <thead><tr><th>#</th><th>Head x</th><th>Head y</th><th>Tip x</th><th>Tip y</th><th>Passive side</th><th>Mechanical</th><th>Preset</th><th>Model</th><th>E / EA</th><th>t / EI</th><th>ν / GA</th><th>κ</th><th>k across</th><th>k along</th><th>Source</th><th>Length</th><th></th></tr></thead>
            <tbody>${wallRows || '<tr><td colspan="18" style="text-align:center;color:var(--tx2)">No retaining walls yet. Use the Retaining wall tool and click head then tip.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Drains</div>
        <div class="st6-bishop-tools">
          <button class="btn sm ${bishop.tool==='drain'?'active':''}" onclick="stage6BishopSetTool('drain')" ${model ? '' : 'disabled'}>Draw drain line</button>
          <button class="btn sm" onclick="stage6BishopFinishDraft()" ${(bishop.draftKind==='drain' && bishop.draft.length >= 2) ? '' : 'disabled'}>Finish drain</button>
          <button class="btn sm" onclick="stage6BishopClear('drains')" ${(bishop.drains || []).length ? '' : 'disabled'}>Clear drains</button>
        </div>
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          Drains: <strong>${(bishop.drains || []).length}</strong><br>
          Validation: <strong>${stage6EscAttr(stage6BishopDrainValidationSummary(drainValidation))}</strong>
        </div>
        ${drainValidationHtml.length ? `
          <div style="display:grid;gap:6px">
            ${drainValidationHtml.map((issue)=>`
              <div class="info" style="background:${issue.level === 'warn' ? 'var(--wnl)' : 'var(--bg2)'};border-color:${issue.level === 'warn' ? 'var(--wn)' : 'var(--bd2)'};margin:0">${stage6EscAttr(issue.text)}</div>
            `).join('')}
          </div>
        ` : ''}
        <div class="st6-canvas-table-wrap">
          <table class="tbl st6-bishop-materials">
            <thead><tr><th>Label</th><th>Vertices</th><th>Head h</th><th>Gating</th><th>Length</th><th></th><th></th></tr></thead>
            <tbody>${drainRows || '<tr><td colspan="7" style="text-align:center;color:var(--tx2)">No drains yet. Use Draw drain line, then click a start and end point on the canvas.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  const boundarySheetHtml = workspace === 'seepage' ? `
    <div class="st6-canvas-sheet-grid">
      ${workspaceGeometrySectionHtml}
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Assigned boundary conditions</div>
        <div class="info" style="background:var(--bg2);border-color:var(--bd2)">
          Outer boundary edges: <strong>${seepageBoundary.length}</strong><br>
          Active BCs: <strong>${seepageActiveBcs.length}</strong><br>
          Prescribed head edges: <strong>${seepageHeadCount}</strong><br>
          Orphaned BCs: <strong>${seepageOrphanedBcs.length}</strong><br>
          Status: <strong>${stage6EscAttr(seepageSetupMessage)}</strong>
        </div>
        <div class="st6-canvas-table-wrap">
          <table class="tbl st6-bishop-materials">
            <thead><tr><th>Edge</th><th>Type</th><th>Head</th><th>Status</th><th></th></tr></thead>
            <tbody>${seepageBcRows || '<tr><td colspan="5" style="text-align:center;color:var(--tx2)">No explicit boundary conditions yet.</td></tr>'}</tbody>
          </table>
        </div>
        ${seepageOrphanedBcs.length ? `<div class="st6-help">Some BC anchors no longer match the rebuilt geometry and are marked orphaned. Reassign those edges on the canvas before solving seepage.</div>` : ''}
      </div>
    </div>
  ` : `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Boundary conditions</div>
      <div class="st6-canvas-card-note">Seepage boundary conditions are available in the Seepage workspace.</div>
    </div>
  `;
  const regionsSheetHtml = `
    <div class="st6-canvas-sheet-grid">
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Soil polygons</div>
        <div class="st6-bishop-tools">
          <button class="btn sm" onclick="stage6BishopCopyCurrentRegionsToCustom()" ${model ? '' : 'disabled'}>Copy current polygons</button>
          <button class="btn sm ${bishop.tool==='region'?'active':''}" onclick="stage6BishopSetTool('region')" ${model ? '' : 'disabled'}>Draw polygon</button>
          <button class="btn sm ${bishop.tool==='regionHole'?'active':''}" onclick="stage6BishopSetTool('regionHole')" ${selectedCustomRegion ? '' : 'disabled'}>Cut hole</button>
          <button class="btn sm ${bishop.tool==='regionSplit'?'active':''}" onclick="stage6BishopSetTool('regionSplit')" ${selectedCustomRegion ? '' : 'disabled'}>Split selected</button>
          <button class="btn sm" onclick="stage6BishopFinishDraft()" ${((bishop.draftKind==='region' || bishop.draftKind==='regionHole') && bishop.draft.length >= 3) ? '' : 'disabled'}>${bishop.draftKind==='regionHole' ? 'Finish hole' : 'Finish polygon'}</button>
          <button class="btn sm" onclick="stage6BishopDeleteSelectedRegion()" ${selectedCustomRegion ? '' : 'disabled'}>Delete selected</button>
        </div>
        <label class="st6-bishop-check">
          <input type="checkbox" ${customModeActive ? 'checked' : ''} onchange="stage6BishopSetUseCustomRegions(this.checked)" ${customRegionCount ? '' : 'disabled'}>
          Use custom polygons in the solver
        </label>
        ${showingCustomRegionPreview ? `<div class="st6-help">Custom polygons are visible for editing, but the solver is still using the CPT-derived polygon set until you enable the checkbox above.</div>` : ''}
        <label style="font-size:11px;color:var(--tx2)">Material for new polygons
          <select onchange="stage6BishopSetField('regionDraftMaterialId', this.value)">
            ${(bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${(bishop.regionDraftMaterialId || bishop.materials?.[0]?.id)===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="st6-canvas-card-section">
        <div class="st6-canvas-card-kicker">Selected polygon</div>
        ${selectedCustomRegion ? `
          <label style="font-size:11px;color:var(--tx2)">Selected polygon material
            <select onchange="stage6BishopSetSelectedRegionMaterial(this.value)">
              ${(bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${selectedCustomRegion.materialId===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('')}
            </select>
          </label>
          <label style="font-size:11px;color:var(--tx2)">Selected polygon coarseness
            <input type="number" min="0.01" step="0.1" value="${stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness)}" onchange="stage6BishopSetSelectedRegionCoarseness(this.value)">
          </label>
          <div class="st6-help">Effective local seepage target area: <strong>${(stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness) * seepageMeshTargetArea).toFixed(3)} m²</strong>.</div>
          <div class="st6-help">Selected polygon: <strong>${stage6EscAttr(selectedCustomRegion.id)}</strong> · vertices <strong>${selectedCustomRegion.polygon.length}</strong> · source <strong>${selectedCustomRegion.source === 'cpt-copy' ? 'copied from CPT' : selectedCustomRegion.source === 'hole' ? 'hole cut' : selectedCustomRegion.source === 'edited' ? 'edited fragment' : 'custom drawn'}</strong></div>
        ` : `<div class="st6-canvas-card-note">${customRegionCount ? 'No custom polygon is selected. Click one in Edit / pan mode to edit it.' : 'No custom polygons yet. Copy the current solver polygons or draw a new polygon to start editing.'}</div>`}
      </div>
    </div>
  `;
  const materialsSheetHtml = workspace === 'seepage' ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Permeability</div>
      <div class="st6-help">Each Bishop material carries seepage permeability. Editing either value marks that material as a user override.</div>
      <div class="st6-canvas-table-wrap">
        <table class="tbl st6-bishop-materials">
          <thead><tr><th>Material</th><th>k_x (m/s)</th><th>k_y (m/s)</th><th>Source</th><th></th></tr></thead>
          <tbody>${permeabilityRows}</tbody>
        </table>
      </div>
    </div>
  ` : workspace === 'deformation' ? `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Deformation materials</div>
      <div class="st6-canvas-table-wrap">
        <table class="tbl st6-bishop-materials st6-bishop-materials--deformation">
          <colgroup>
            <col class="st6-mat-col-layer">
            <col class="st6-mat-col-emc">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
            <col class="st6-mat-col-small">
          </colgroup>
          <thead><tr><th>Layer</th><th>E_mc (kPa)</th><th>nu</th><th>K0</th><th>r_shear</th><th>c'</th><th>phi'</th><th>psi</th></tr></thead>
          <tbody>${deformationMaterialRows}</tbody>
        </table>
      </div>
      ${STAGE6_ENABLE_HARDENING_SOIL_UI ? hsMaterialTableHtml : ''}
    </div>
  ` : `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Stability materials</div>
      <div class="st6-help">The current imported material set is <strong>${stage6BishopStrengthSetLabel(bishop.strengthSet)}</strong>.</div>
      <div class="st6-canvas-table-wrap">
        <table class="tbl st6-bishop-materials">
          <thead><tr><th>Layer</th><th>c'</th><th>phi'</th><th>gamma</th><th>gamma_sat</th></tr></thead>
          <tbody>${materialRows}</tbody>
        </table>
      </div>
    </div>
  `;
  const workspaceSheetHtml = `
    <div class="st6-canvas-sheet-grid">
      ${workspaceInfoHtml}
      ${workspaceGeometrySectionHtml}
      ${workspaceSettingsHtml}
    </div>
  `;
  const resetSheetHtml = `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Reset geometry and overlays</div>
      <div class="st6-help">These actions clear drawn data from the shared Stage 6 section. They do not delete interpreted CPT layers.</div>
      <div class="st6-bishop-mini-actions">
        <button class="btn sm" onclick="stage6BishopClear('terrain')">Clear terrain</button>
        <button class="btn sm" onclick="stage6BishopClear('phreatic')">Clear phreatic</button>
        <button class="btn sm" onclick="stage6BishopClear('walls')">Clear walls</button>
        <button class="btn sm" onclick="stage6BishopClear('drains')">Clear drains</button>
        <button class="btn sm" onclick="stage6BishopClear('entry')">Clear entry</button>
        <button class="btn sm" onclick="stage6BishopClear('exit')">Clear exit</button>
        <button class="btn sm" onclick="stage6BishopClear('load')">Clear load</button>
        <button class="btn sm" onclick="stage6BishopClear('measure')" ${measurementPoints.length ? '' : 'disabled'}>Clear measure</button>
        <button class="btn sm" onclick="stage6BishopClear('customRegions')">Clear custom polygons</button>
      </div>
    </div>
  `;
  const probeSheetHtml = analysisSheetHtml || `
    <div class="st6-canvas-card-section">
      <div class="st6-canvas-card-kicker">Workspace summary</div>
      ${workspaceInfoHtml}
    </div>
  `;
  const canvasSheets = {
    structures:structuresSheetHtml,
    boundary:boundarySheetHtml,
    regions:regionsSheetHtml,
    view:viewSectionHtml,
    materials:materialsSheetHtml,
    workspace:workspaceSheetHtml,
    reset:resetSheetHtml,
    probe:probeSheetHtml
  };
  const canvasToolRailHtml = stage6BishopCanvasToolRailHtml({
    bishop,
    workspace,
    model,
    selectedCustomRegion,
    selectedSeepageEdge,
    selectedSeepageBc,
    loadQ,
    seepageMeshTargetArea,
    toolbarRunLabel,
    toolbarRunAction,
    toolbarRunReady,
    toolbarStopAction,
    toolbarRunning,
    toolbarClearLabel,
    toolbarClearAction,
    toolbarHasResult,
    toolbarProgressText,
    canvasSheets
  });
  const workspaceResultsHtml = workspace === 'stability' ? `
          <div class="st6-bishop-results-panel">
            <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase">Results</div>
            <div class="st6-bishop-results-top">
              <div class="st6-bishop-side">
                <table class="pt" style="margin-bottom:12px">
                  <tr><td>Critical F</td><td>${summary && results[0] ? results[0].FS.toFixed(3) : '—'}</td></tr>
                  <tr><td>Mode</td><td>${stage6BishopMethodModeLabel(bishop.methodMode)}</td></tr>
                  <tr><td>Circle centre</td><td>${summary ? `(${summary.center.x.toFixed(2)}, ${summary.center.y.toFixed(2)})` : '—'}</td></tr>
                  <tr><td>Radius</td><td>${summary ? `${summary.radius.toFixed(2)} m` : '—'}</td></tr>
                  <tr><td>Max slip depth</td><td>${summary ? `${summary.maxDepth.toFixed(2)} m` : '—'}</td></tr>
                  ${hasWalls ? `<tr><td>Critical through wall</td><td>${wallSummary?.criticalThroughWall ? wallSummary.criticalThroughWall.FS.toFixed(3) : '—'}</td></tr>` : ''}
                  ${hasWalls ? `<tr><td>Critical below wall</td><td>${wallSummary?.criticalBelowWall ? wallSummary.criticalBelowWall.FS.toFixed(3) : '—'}</td></tr>` : ''}
                  ${hasWalls ? `<tr><td>Wall effective</td><td>${wallSummary?.wallEffective == null ? '—' : (wallSummary.wallEffective ? 'yes' : 'no / inconclusive')}</td></tr>` : ''}
                  <tr><td>Trials</td><td>${bishop.results?.timing?.trialCount ?? '—'}</td></tr>
                  <tr><td>Runtime</td><td>${bishop.results?.timing?.totalMs != null ? `${bishop.results.timing.totalMs.toFixed(0)} ms` : '—'}</td></tr>
                  <tr><td>Spencer rechecked</td><td>${bishop.results?.methodMode === 'bishop_spencer' ? `${bishop.results?.spencerRechecked || 0}` : 'off'}</td></tr>
                  <tr><td>Spencer converged</td><td>${bishop.results?.methodMode === 'bishop_spencer' ? `${bishop.results?.spencerConverged || 0}` : 'off'}</td></tr>
                  <tr><td>Selected result</td><td>${selected ? `#${(bishop.selectedResult||0)+1}` : '—'}</td></tr>
                  <tr><td>Selected method</td><td>${selectedMethodLabel}</td></tr>
                  <tr><td>Selected Bishop F</td><td>${selected && Number.isFinite(selected.F_bishop) ? selected.F_bishop.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected Spencer F</td><td>${selected?.method === 'spencer' && Number.isFinite(selected.FS) ? selected.FS.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected λ</td><td>${selected && Number.isFinite(selected.lambda) ? selected.lambda.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected θ</td><td>${selected && Number.isFinite(selected.thetaDeg) ? `${selected.thetaDeg.toFixed(1)}°` : '—'}</td></tr>
                  ${hasWalls ? `<tr><td>Selected wall status</td><td>${selectedWallLabel}</td></tr>` : ''}
                  ${hasWalls ? `<tr><td>Selected wall force</td><td>${selected && Number.isFinite(selected.wallForceTotal) ? `${selected.wallForceTotal.toFixed(1)} kN/m` : '—'}</td></tr>` : ''}
                  <tr><td>Selected moment residual</td><td>${selected && Number.isFinite(selected.momentResidual) ? selected.momentResidual.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected force residual</td><td>${selected && Number.isFinite(selected.forceResidual) ? selected.forceResidual.toFixed(3) : '—'}</td></tr>
                  <tr><td>Selected iterations</td><td>${selected ? selected.iterations : '—'}</td></tr>
                </table>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:0">
                  Rejections: ${bishop.results ? Object.entries(bishop.results.rejectionCounts || {}).map(([k,v])=>`${k}: ${v}`).join(' · ') || 'none' : 'no search yet'}${selected?.spencerAttempted && !selected?.spencerConverged ? `<br>Selected fallback: ${stage6EscAttr(selected.spencerRejectReason || 'Spencer did not converge.')}` : ''}
                </div>
              </div>
              <div class="st6-bishop-side">
                ${bishop.results && !results.length ? `
                  <div class="st6-help" style="margin-bottom:12px">
                    No valid circle was found for the current geometry and search settings. Try widening the <strong>entry</strong> and <strong>exit</strong> zones, increasing <strong>entry / exit samples</strong> and <strong>centers per chord</strong>, increasing <strong>center offset max</strong>, reducing <strong>minimum slip thickness</strong> a little, or allowing a larger <strong>maximum exit angle</strong>. The rejection summary above tells you which filter blocked most trial circles.
                  </div>
                `:''}
                <div class="mc2-sec">Best circles</div>
                <div style="max-height:200px;overflow:auto">
                  <table class="tbl st6-bishop-results">
                    <thead><tr><th>#</th><th>F</th><th>Method</th><th>Bishop F</th><th>Wall</th><th>λ</th><th>Iter</th><th></th></tr></thead>
                    <tbody>${resultRows || '<tr><td colspan="8" style="text-align:center;color:var(--tx2)">No results yet.</td></tr>'}</tbody>
                  </table>
                </div>
              </div>
            </div>
            <div class="st6-bishop-side">
              <div class="mc2-sec">Selected slices</div>
              <div style="max-height:250px;overflow:auto">
                <table class="tbl st6-bishop-results">
                  <thead><tr><th>i</th><th>W</th><th>Q</th><th>V</th><th>alpha</th><th>c'</th><th>phi'</th><th>u</th><th>m_alpha</th><th>${selectedNormalHeader}</th>${showWallSliceCol ? '<th>R_wall,left</th>' : ''}${showSpencerSliceCols ? '<th>E_r</th><th>X_r</th><th>S_mob</th>' : ''}</tr></thead>
                  <tbody>
                    ${selected ? selected.slices.map((slice, index)=>`
                      <tr>
                        <td>${index+1}</td>
                        <td>${slice.W.toFixed(1)}</td>
                        <td>${(slice.Q || 0).toFixed(1)}</td>
                        <td>${(slice.V || slice.W || 0).toFixed(1)}</td>
                        <td>${(slice.alphaRad * 180 / Math.PI).toFixed(1)}°</td>
                        <td>${slice.baseMaterial.cEff.toFixed(1)}</td>
                        <td>${slice.baseMaterial.phiEffDeg.toFixed(1)}°</td>
                        <td>${slice.uBase.toFixed(1)}</td>
                        <td>${slice.mAlpha.toFixed(3)}</td>
                        <td>${(showSpencerSliceCols ? slice.N_eff : slice.normalForce) != null ? (showSpencerSliceCols ? slice.N_eff : slice.normalForce).toFixed(1) : '—'}</td>
                        ${showWallSliceCol ? `<td>${(slice.wallForceLeft || 0) > 0 ? slice.wallForceLeft.toFixed(1) : '—'}</td>` : ''}
                        ${showSpencerSliceCols ? `<td>${slice.E_right != null ? slice.E_right.toFixed(1) : '—'}</td><td>${slice.X_right != null ? slice.X_right.toFixed(1) : '—'}</td><td>${slice.S_mob != null ? slice.S_mob.toFixed(1) : '—'}</td>` : ''}
                      </tr>
                    `).join('') : `<tr><td colspan="${10 + (showWallSliceCol ? 1 : 0) + (showSpencerSliceCols ? 3 : 0)}" style="text-align:center;color:var(--tx2)">Select or run a result to inspect slice data.</td></tr>`}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
  ` : workspace === 'seepage' ? `
          <div class="st6-bishop-results-panel">
            <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase">Results</div>
            <div class="st6-bishop-results-top">
              <div class="st6-bishop-side">
                <table class="pt" style="margin-bottom:12px">
                  <tr><td>Status</td><td>${stage6EscAttr(seepageStatusLabel)}</td></tr>
                  <tr><td>Nodes</td><td>${seepage.mesh?.nodes?.length || 0}</td></tr>
                  <tr><td>Triangles</td><td>${seepage.mesh?.elements?.length || 0}</td></tr>
                  <tr><td>Head range</td><td>${seepage.result ? `${seepage.result.headMin.toFixed(2)} to ${seepage.result.headMax.toFixed(2)} m` : '—'}</td></tr>
                  <tr><td>Through-flow</td><td>${seepage.result ? `${(seepage.result.throughFlow || 0).toExponential(2)} m³/s/m` : '—'}</td></tr>
                  <tr><td>Drain inflow</td><td>${seepage.result ? `${seepageDrainInflow.toExponential(2)} m³/s/m` : '—'}</td></tr>
                  <tr><td>Drain outflow</td><td>${seepage.result ? `${seepageDrainOutflow.toExponential(2)} m³/s/m` : '—'}</td></tr>
                  <tr><td>Flow-rate error</td><td>${stage6SeepageFlowErrorLabel(seepage.result)}</td></tr>
                  <tr><td>Termination</td><td>${stage6EscAttr(stage6BishopSeepageTerminationLabel(seepage.result?.solver?.terminationReason))}</td></tr>
                  <tr><td>Max exit gradient</td><td>${seepage.result ? (seepage.result.maxExitGradient || 0).toFixed(3) : '—'}</td></tr>
                  <tr><td>Dry cells</td><td>${seepage.result?.dryCellCount || 0}</td></tr>
                  <tr><td>Runtime</td><td>${stage6SecondsLabelFromMs(seepage.result?.timing?.totalMs)}</td></tr>
                </table>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:0">
                  ${stage6EscAttr(seepageStatusMessage)}
                </div>
              </div>
              <div class="st6-bishop-side">
                <div class="mc2-sec">Boundary summary</div>
                <table class="pt" style="margin-bottom:12px">
                  <tr><td>Outer edges</td><td>${seepageBoundary.length}</td></tr>
                  <tr><td>Explicit BCs</td><td>${seepageActiveBcs.length}</td></tr>
                  <tr><td>Prescribed head</td><td>${seepageHeadCount}</td></tr>
                  <tr><td>Seepage face</td><td>${seepageActiveBcs.filter((bc)=>bc.type === 'seepage-face').length}</td></tr>
                  <tr><td>No-flow</td><td>${seepageActiveBcs.filter((bc)=>bc.type === 'no-flow').length}</td></tr>
                  <tr><td>Orphaned BCs</td><td>${seepageOrphanedBcs.length}</td></tr>
                  <tr><td>Drain nodes active</td><td>${seepageDrainNodeSummary ? `${seepageDrainNodeSummary.activeNodes || 0} / ${seepageDrainNodeSummary.totalNodes || 0}` : '—'}</td></tr>
                  <tr><td>Drain edge check</td><td>${Number.isFinite(Number(seepageDrainNodeSummary?.perEdgeReactionDelta)) ? Number(seepageDrainNodeSummary.perEdgeReactionDelta).toExponential(2) : '—'}</td></tr>
                </table>
                <div class="mc2-sec">Drain discharge</div>
                <div style="max-height:160px;overflow:auto;margin-bottom:12px">
                  <table class="tbl st6-bishop-results">
                    <thead><tr><th>Drain</th><th>Gating</th><th>Inflow</th><th>Reaction</th><th>Active nodes</th></tr></thead>
                    <tbody>${drainResultRows || '<tr><td colspan="5" style="text-align:center;color:var(--tx2)">No solved drain discharge.</td></tr>'}</tbody>
                  </table>
                </div>
                <div class="mc2-sec">Assigned BCs</div>
                <div style="max-height:240px;overflow:auto">
                  <table class="tbl st6-bishop-results">
                    <thead><tr><th>Edge</th><th>Type</th><th>Head</th><th>Status</th></tr></thead>
                    <tbody>${seepageActiveBcs.map((bc)=>{
                      const edge = seepageBoundary.find((item)=>item.edgeKey === bc.edgeKey);
                      return `
                        <tr>
                          <td>${stage6EscAttr(stage6BishopSeepageEdgeLabel(edge || {source:bc.anchor?.source, index:0}))}</td>
                          <td>${stage6EscAttr(stage6BishopSeepageBcTypeLabel(bc.type))}</td>
                          <td>${bc.type === 'head' && Number.isFinite(bc.head) ? `${bc.head.toFixed(2)} m` : '—'}</td>
                          <td>${stage6EscAttr(bc.status || 'active')}</td>
                        </tr>
                      `;
                    }).join('') || '<tr><td colspan="4" style="text-align:center;color:var(--tx2)">No explicit boundary conditions yet.</td></tr>'}</tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
  ` : `
          <div class="st6-bishop-results-panel">
            <div style="font-size:10px;font-weight:600;color:var(--tx2);text-transform:uppercase">Results</div>
            <div class="st6-bishop-results-top">
              <div class="st6-bishop-side">
                <table class="pt" style="margin-bottom:12px">
                  <tr><td>Status</td><td>${stage6EscAttr(deformationStatusLabel)}</td></tr>
                  <tr><td>Load mode</td><td>${deformationLoadMode === 'total' ? 'total load' : 'pressure q'}</td></tr>
	                  <tr><td>Active loads</td><td>${deformationActiveLoads.length}</td></tr>
	                  <tr><td>Average q</td><td>${deformationAppliedQ > 0 ? `${deformationAppliedQ.toFixed(2)} kPa` : '—'}</td></tr>
	                  <tr><td>Total load</td><td>${deformationTotalLoad != null ? `${deformationTotalLoad.toFixed(1)} kN` : '—'}</td></tr>
                  <tr><td>Out-of-plane length</td><td>${deformationOutOfPlaneLength.toFixed(2)} m</td></tr>
		                  <tr><td>Nodes</td><td>${deformation.mesh?.nodes?.length || 0}</td></tr>
		                  <tr><td>Mechanical walls</td><td>${deformation.mesh?.mechanicalWalls?.length || 0}</td></tr>
		                  <tr><td>Triangles</td><td>${deformation.mesh?.elements?.length || 0}</td></tr>
	                  <tr><td>Solver</td><td>${stage6EscAttr(deformationSolverLabel)}</td></tr>
	                  <tr><td>Initial stress</td><td>${stage6EscAttr(deformationInitialStressMode)}</td></tr>
	                  <tr><td>Free DOFs</td><td>${deformation.result?.solver?.freeDofs || 0}</td></tr>
	                  <tr><td>Geostatic CG iterations</td><td>${deformationGeostaticIterations ?? '—'}</td></tr>
	                  <tr><td>Geostatic residual</td><td>${deformationGeostaticResidual}</td></tr>
                  ${deformationIsSafety
                    ? `<tr><td>Safety status</td><td>${stage6EscAttr(deformationSafetyStatus)}</td></tr>
                  <tr><td>FoS lower bound</td><td>${deformationSafetyFoSLower != null ? deformationSafetyFoSLower.toFixed(3) : '—'}</td></tr>
                  <tr><td>FoS upper bound</td><td>${deformationSafetyOpenEnded && deformationSafetyFoSLower != null ? `> ${deformationSafetyFoSLower.toFixed(3)}` : (deformationSafetyFoSUpper != null ? deformationSafetyFoSUpper.toFixed(3) : '—')}</td></tr>
                  <tr><td>Displayed ΣMsf</td><td>${deformationSafetyDisplayedSigmaMsf != null ? deformationSafetyDisplayedSigmaMsf.toFixed(3) : '—'}</td></tr>
                  <tr><td>Displayed retained strength</td><td>${deformationSafetyStrengthRetained != null ? `${(100 * deformationSafetyStrengthRetained).toFixed(2)} %` : '—'}</td></tr>
                  <tr><td>Accepted continuation steps</td><td>${deformation.result?.solver?.safetyAcceptedContinuationSteps || 0}</td></tr>
                  <tr><td>Rejected continuation steps</td><td>${deformation.result?.solver?.safetyRejectedContinuationSteps || 0}</td></tr>
                  <tr><td>Mechanism</td><td>${deformationSafetyMechanism ? `${stage6EscAttr(deformationSafetyMechanism.status || 'none')} · ${stage6CompactNumber(deformationSafetyMechanism.score || 0, 3)}` : '—'}</td></tr>`
                    : `<tr><td>Accepted load steps</td><td>${deformationAcceptedSteps ?? '—'}</td></tr>
                  <tr><td>Rejected load steps</td><td>${deformationRejectedSteps ?? '—'}</td></tr>`}
                  <tr><td>Nonlinear iterations</td><td>${deformation.result?.solver?.nonlinearIterations || 0}</td></tr>
	                  <tr><td>Linear iterations</td><td>${deformation.result?.solver?.linearIterations || 0}</td></tr>
                  <tr><td>Residual</td><td>${Number.isFinite(deformation.result?.solver?.residualNorm) ? Number(deformation.result.solver.residualNorm).toExponential(2) : '—'}</td></tr>
                  <tr><td>Peak active MC elements</td><td>${deformationPeakActive ?? '—'}</td></tr>
                  <tr><td>Max settlement</td><td>${deformation.result ? `${(1000 * (deformation.result.summaries?.maxSettlement || 0)).toFixed(2)} mm` : '—'}</td></tr>
                  <tr><td>Max |u_x|</td><td>${deformation.result ? `${(1000 * (deformation.result.summaries?.maxHorizontalDisplacement || 0)).toFixed(2)} mm` : '—'}</td></tr>
                  <tr><td>Max delta sigma_yy</td><td>${deformation.result ? `${(deformation.result.summaries?.maxDeltaSigmaYy || 0).toFixed(2)} kPa` : '—'}</td></tr>
	                  <tr><td>Max MC eta</td><td>${deformation.result ? (deformation.result.summaries?.hasInfiniteMcEta ? '∞' : `${(deformation.result.summaries?.maxMcEta || 0).toFixed(3)}`) : '—'}</td></tr>
	                  <tr><td>Active MC elements</td><td>${deformation.result ? `${deformation.result.summaries?.activeMcElementCount || 0}` : '—'}</td></tr>
	                  <tr><td>MC-exceeded elements</td><td>${deformation.result ? `${deformation.result.summaries?.exceededMcElementCount || 0}` : '—'}</td></tr>
	                  <tr><td>Max ε̄ᵖ,acc</td><td>${deformation.result ? `${(100 * (deformation.result.summaries?.maxEquivalentPlasticStrain || 0)).toFixed(3)} %` : '—'}</td></tr>
                  ${deformationIsSafety ? `<tr><td>Max Δε̄ᵖ,safety</td><td>${deformation.result ? `${(100 * (deformation.result.summaries?.maxSafetyEquivalentPlasticIncrement || 0)).toFixed(3)} %` : '—'}</td></tr>` : ''}
                  <tr><td>Runtime</td><td>${stage6SecondsLabelFromMs(deformation.result?.timing?.totalMs)}</td></tr>
                </table>
                <div class="info" style="background:var(--bg2);border-color:var(--bd2);margin-bottom:0">
                  ${stage6EscAttr(deformationStatusMessage)}
                  ${deformationWarnings.length ? `<br><br>${deformationWarnings.map((warning)=>stage6EscAttr(warning)).join('<br>')}` : ''}
			              </div>
			            </div>
              <div class="st6-bishop-side">
                <div class="mc2-sec">Terrain settlement profile</div>
                <div style="max-height:300px;overflow:auto">
                  <table class="tbl st6-bishop-results">
                    <thead><tr><th>#</th><th>x</th><th>y</th><th>settlement (mm)</th><th>u_x (mm)</th></tr></thead>
                    <tbody>${deformationProfileRows || '<tr><td colspan="5" style="text-align:center;color:var(--tx2)">Run the deformation screen to inspect the terrain settlement profile.</td></tr>'}</tbody>
		                  </table>
		                </div>
		              </div>
	              <div class="st6-bishop-side">
	                <div class="mc2-sec">Retaining wall response</div>
	                <div style="max-height:300px;overflow:auto">
	                  <table class="tbl st6-bishop-results">
	                    <thead><tr><th>Wall</th><th>Station</th><th>s (m)</th><th>w pass. (mm)</th><th>θ pass. (mrad)</th><th>N (kN/m)</th><th>V pass. (kN/m)</th><th>M pass. (kNm/m)</th></tr></thead>
	                    <tbody>${deformationWallRows || '<tr><td colspan="8" style="text-align:center;color:var(--tx2)">Run deformation with mechanical wall activation enabled to inspect wall forces.</td></tr>'}</tbody>
	                  </table>
	                </div>
	              </div>
		            </div>
	            ${deformationIsSafety ? stage6BishopSafetyCurveHtml(deformation.result?.solver) : ''}
	            ${deformationIsSafety ? stage6BishopSafetyMechanismHtml(deformationSafetyMechanism) : ''}
	          </div>
	  `;
  return `
    <div class="mc2 st6-bishop">
      <div class="mc2-head" style="margin-bottom:12px">
	        <span style="font-size:13px;font-weight:600">${workspace === 'deformation' ? 'Section deformation screening' : 'Seep/Slope + Spencer equilibrium check'}</span>
	        <span style="font-size:11px;color:var(--tx2)">${workspace === 'deformation'
	          ? 'Shared Stage 6 geometry with a drained plane-strain mesh, required self-weight equilibrium, and selectable elastic or Mohr-Coulomb material behaviour.'
		          : 'Circular slip surfaces only, active CPT only, with self-weight, optional infinitely stiff retaining walls, multiple optional surcharge strips, and an optional full Spencer verification pass on the shortlisted circles.'}</span>
      </div>
      <div class="st6-bishop-workspace-switch">
        <button class="btn sm ${workspace==='stability'?'active':''}" onclick="stage6BishopSetWorkspace('stability')">Stability</button>
        <button class="btn sm ${workspace==='seepage'?'active':''}" onclick="stage6BishopSetWorkspace('seepage')">Seepage</button>
        <button class="btn sm ${workspace==='deformation'?'active':''}" onclick="stage6BishopSetWorkspace('deformation')">Deformation</button>
      </div>
      <div class="st6-bishop-workspace-note">${stage6EscAttr(workspaceSwitchNote)}</div>
      <div class="st6-bishop-layout${settingsCollapsed ? ' st6-bishop-layout--settings-collapsed' : ''}${settingsWide ? ' st6-bishop-layout--settings-wide' : ''}">
        <div class="st6-bishop-side st6-bishop-settings-panel">
          <div class="st6-bishop-settings-head">
            <div>
              <span>Settings</span>
              <strong>${workspace === 'seepage' ? 'Seepage' : workspace === 'deformation' ? 'Deformation' : 'Stability'}</strong>
            </div>
            <div class="st6-bishop-settings-actions">
              <button class="btn sm" onclick="stage6BishopToggleSettingsWidth()">${settingsWide ? 'Narrow' : 'Wide'}</button>
              <button class="btn sm" onclick="stage6BishopToggleSettingsPanel(false)">Hide</button>
            </div>
          </div>
          <div class="ctrl-row st6-bishop-controls">
	            <div class="st6-help">Draw a monotonic terrain, or import a DXF containing exactly one open polyline. Imported terrain is shifted so its leftmost vertex becomes <strong>(0, 0)</strong>. Then place or review the active CPT, optionally add infinitely stiff retaining walls and one or more uniform surcharge strips, and define the entry and exit daylight zones. The active CPT layer model is extended horizontally across the section for the Bishop search.</div>
            <div class="st6-bishop-tool-groups">
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-terrain"${stage6DetailsOpen('bishop-geo-terrain')}>
                <summary>Terrain</summary>
                <div class="st6-adv-body">
                  <div class="st6-bishop-tools">
                    <button class="btn sm ${bishop.tool==='terrain'?'active':''}" onclick="stage6BishopSetTool('terrain')">Draw terrain</button>
                    <button class="btn sm" onclick="stage6BishopTriggerDxfImport()">Import DXF terrain</button>
                    <input id="stage6BishopDxfInput" type="file" accept=".dxf,.DXF" style="display:none" onchange="stage6BishopImportDxf(event)">
                    <button class="btn sm" onclick="stage6BishopFinishDraft()">Finish draft</button>
                    <button class="btn sm" onclick="stage6BishopPopDraftPoint()">Undo point</button>
                    <button class="btn sm" onclick="stage6BishopClear('draft')">Clear draft</button>
                  </div>
                </div>
              </details>
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-regions"${stage6DetailsOpen('bishop-geo-regions')}>
                <summary>Soil polygons</summary>
                <div class="st6-adv-body">
                  <div class="st6-help">Default Bishop still uses CPT-derived polygons. To edit them, first copy the current solver polygons into a custom set. After that you can draw additional polygons, select one in <strong>Edit / pan</strong>, drag its vertices, split it into smaller polygons, cut interior holes with a different material, assign one of the imported Bishop materials, and tune a polygon-specific seepage coarseness factor for local mesh refinement.</div>
                  ${showingCustomRegionPreview ? `<div class="st6-help">Custom polygons are visible for editing, but the solver is still using the CPT-derived polygon set until you enable the checkbox below.</div>` : ''}
                  <div class="st6-bishop-tool-grid">
                    <div class="st6-bishop-tool-group">
                      <div class="st6-bishop-tool-title">Create</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm" onclick="stage6BishopCopyCurrentRegionsToCustom()">Copy current polygons</button>
                        <button class="btn sm ${bishop.tool==='region'?'active':''}" onclick="stage6BishopSetTool('region')">Draw polygon</button>
                        <button class="btn sm" onclick="stage6BishopFinishDraft()" ${((bishop.draftKind==='region' || bishop.draftKind==='regionHole') && bishop.draft.length >= 3) ? '' : 'disabled'}>${bishop.draftKind==='regionHole' ? 'Finish hole' : 'Finish polygon'}</button>
                      </div>
                    </div>
                    <div class="st6-bishop-tool-group ${selectedCustomRegion ? '' : 'st6-bishop-tool-group-muted'}">
                      <div class="st6-bishop-tool-title">Selected polygon</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm ${bishop.tool==='regionHole'?'active':''}" onclick="stage6BishopSetTool('regionHole')" ${selectedCustomRegion ? '' : 'disabled'}>Cut hole</button>
                        <button class="btn sm ${bishop.tool==='regionSplit'?'active':''}" onclick="stage6BishopSetTool('regionSplit')" ${selectedCustomRegion ? '' : 'disabled'}>Split selected</button>
                        <button class="btn sm" onclick="stage6BishopDeleteSelectedRegion()" ${selectedCustomRegion ? '' : 'disabled'}>Delete selected</button>
                      </div>
                    </div>
                  </div>
                  <label class="st6-bishop-check">
                    <input type="checkbox" ${customModeActive ? 'checked' : ''} onchange="stage6BishopSetUseCustomRegions(this.checked)" ${customRegionCount ? '' : 'disabled'}>
                    Use custom polygons in the solver
                  </label>
                  <label style="font-size:11px;color:var(--tx2)">Material for new polygons
                    <select onchange="stage6BishopSetField('regionDraftMaterialId', this.value)">
                      ${(bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${(bishop.regionDraftMaterialId || bishop.materials?.[0]?.id)===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('')}
                    </select>
                  </label>
                  ${selectedCustomRegion ? `
                    <label style="font-size:11px;color:var(--tx2)">Selected polygon material
                      <select onchange="stage6BishopSetSelectedRegionMaterial(this.value)">
                        ${(bishop.materials || []).map((mat)=>`<option value="${stage6EscAttr(mat.id)}"${selectedCustomRegion.materialId===mat.id?' selected':''}>${stage6EscAttr(mat.label)}</option>`).join('')}
                      </select>
                    </label>
                    <label style="font-size:11px;color:var(--tx2)">Selected polygon coarseness
                      <input
                        id="st6-bishop-selected-region-coarseness"
                        type="number"
                        min="0.01"
                        step="0.1"
                        value="${stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness)}"
                        onchange="stage6BishopSetSelectedRegionCoarseness(this.value)"
                        onkeydown="if(event.key === 'Enter'){ event.preventDefault(); stage6BishopSetSelectedRegionCoarseness(this.value); this.blur(); }"
                      >
                    </label>
                    <div class="st6-help">When custom polygons are enabled in the solver, this scales only the seepage mesh inside the selected polygon. Effective local target area: <strong>${(stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness) * seepageMeshTargetArea).toFixed(3)} m²</strong> = coarseness <strong>${stage6BishopNormalizeRegionCoarseness(selectedCustomRegion.coarseness).toFixed(2)}</strong> × global target <strong>${seepageMeshTargetArea.toFixed(3)} m²</strong>.</div>
                    <div class="st6-help">Selected polygon: <strong>${stage6EscAttr(selectedCustomRegion.id)}</strong> · vertices <strong>${selectedCustomRegion.polygon.length}</strong> · source <strong>${selectedCustomRegion.source === 'cpt-copy' ? 'copied from CPT' : selectedCustomRegion.source === 'hole' ? 'hole cut' : selectedCustomRegion.source === 'edited' ? 'edited fragment' : 'custom drawn'}</strong></div>
                  ` : `
                    <div class="st6-help">${customRegionCount ? 'No custom polygon is selected. Click one in Edit / pan mode to edit it.' : 'No custom polygons yet. Copy the current solver polygons or draw a new polygon to start editing.'}</div>
                  `}
                </div>
              </details>
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-setup"${stage6DetailsOpen('bishop-geo-setup')}>
                <summary>Section setup</summary>
                <div class="st6-adv-body">
                  <div class="st6-bishop-tool-grid">
                    <div class="st6-bishop-tool-group">
                      <div class="st6-bishop-tool-title">Draw</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm ${bishop.tool==='cpt'?'active':''}" onclick="stage6BishopSetTool('cpt')">Place CPT</button>
                        <button class="btn sm ${bishop.tool==='phreatic'?'active':''}" onclick="stage6BishopSetTool('phreatic')">Phreatic line</button>
                        <button class="btn sm ${bishop.tool==='drain'?'active':''}" onclick="stage6BishopSetTool('drain')">Drain</button>
                        <button class="btn sm ${bishop.tool==='wall'?'active':''}" onclick="stage6BishopSetTool('wall')">Retaining wall</button>
                        <button class="btn sm ${bishop.tool==='entry'?'active':''}" onclick="stage6BishopSetTool('entry')">Entry zone</button>
                        <button class="btn sm ${bishop.tool==='exit'?'active':''}" onclick="stage6BishopSetTool('exit')">Exit zone</button>
                        <button class="btn sm ${bishop.tool==='load'?'active':''}" onclick="stage6BishopSetTool('load')">Load zone</button>
                      </div>
                    </div>
                    <div class="st6-bishop-tool-group">
                      <div class="st6-bishop-tool-title">Edit</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm ${bishop.tool==='edit'?'active':''}" onclick="stage6BishopSetTool('edit')">Edit / pan</button>
                      </div>
                    </div>
                    <div class="st6-bishop-tool-group st6-bishop-tool-group-muted">
                      <div class="st6-bishop-tool-title">Probe</div>
                      <div class="st6-bishop-tools">
                        <button class="btn sm ${bishop.tool==='measure'?'active':''}" onclick="stage6BishopSetTool('measure')">Measure</button>
                      </div>
                      <div class="st6-help">Measurement line: <strong>${stage6EscAttr(measurementStatus)}</strong>${workspace === 'seepage' ? '<br>Boundary assignment lives in the seepage boundary-conditions section below.' : ''}</div>
                    </div>
                  </div>
                </div>
              </details>
              ${workspaceGeometrySectionHtml}
              <details class="st6-adv st6-bishop-geo-section" data-st6details="bishop-geo-clear"${stage6DetailsOpen('bishop-geo-clear')}>
                <summary>Reset geometry</summary>
                <div class="st6-adv-body">
                  <div class="st6-bishop-mini-actions">
                    <button class="btn sm" onclick="stage6BishopClear('terrain')">Clear terrain</button>
                    <button class="btn sm" onclick="stage6BishopClear('phreatic')">Clear phreatic</button>
                    <button class="btn sm" onclick="stage6BishopClear('walls')">Clear walls</button>
                    <button class="btn sm" onclick="stage6BishopClear('drains')">Clear drains</button>
                    <button class="btn sm" onclick="stage6BishopClear('entry')">Clear entry</button>
                    <button class="btn sm" onclick="stage6BishopClear('exit')">Clear exit</button>
                    <button class="btn sm" onclick="stage6BishopClear('load')">Clear load</button>
                    ${workspace === 'stability' ? `<button class="btn sm" onclick="stage6BishopClear('measure')" ${measurementPoints.length ? '' : 'disabled'}>Clear measure</button>` : ''}
                    <button class="btn sm" onclick="stage6BishopClear('customRegions')">Clear custom polygons</button>
                  </div>
                </div>
              </details>
            </div>
            ${workspaceInfoHtml}
            <details class="st6-adv" data-st6details="bishop-walls"${stage6DetailsOpen('bishop-walls')}>
              <summary>Retaining walls</summary>
              <div class="st6-adv-body">
                <div class="st6-help">Walls are treated as infinitely stiff line elements for stability. In seepage they are thin oriented regions with user-set across-wall and along-wall conductivity; dry wall elements get the same dry-factor reduction as soil.</div>
                <div style="overflow:auto">
                  <table class="tbl st6-bishop-materials">
                    <thead><tr><th>#</th><th>Head x</th><th>Head y</th><th>Tip x</th><th>Tip y</th><th>Passive side</th><th>Mechanical</th><th>Preset</th><th>Model</th><th>E / EA</th><th>t / EI</th><th>ν / GA</th><th>κ</th><th>k across</th><th>k along</th><th>Source</th><th>Length</th><th></th></tr></thead>
                    <tbody>${wallRows || '<tr><td colspan="18" style="text-align:center;color:var(--tx2)">No retaining walls yet. Use the Retaining wall tool and click head then tip.</td></tr>'}</tbody>
                  </table>
                </div>
              </div>
            </details>
            ${workspaceSettingsHtml}
          </div>
        </div>
        <div class="st6-bishop-main">
          <div class="st6-bishop-canvas-wrap">
            <div class="st6-bishop-command">
              <div class="st6-bishop-toolbar">
                <div class="st6-bishop-toolbar-main">
                  <button class="btn" onclick="${toolbarRunAction}" ${toolbarRunReady?'':'disabled'}>${toolbarRunLabel}</button>
                  <button class="btn sm" onclick="${toolbarStopAction}" ${toolbarRunning ? '' : 'disabled'}>Stop</button>
                </div>
                <div class="st6-bishop-toolbar-secondary">
                  <button class="btn sm" onclick="fitStage6BishopViewport()">Fit view</button>
                  <button class="btn sm" onclick="${toolbarClearAction}" ${toolbarHasResult ? '' : 'disabled'}>${toolbarClearLabel}</button>
                </div>
              </div>
              <div class="st6-bishop-status-card">
                <div id="stage6BishopProgress" class="st6-bishop-status-summary">${stage6EscAttr(toolbarProgressText)}</div>
                <div class="st6-bishop-status-meta">
                  <div class="st6-bishop-status-stat">
                    <span class="st6-bishop-status-label">Tool</span>
                    <strong id="stage6BishopMode" class="st6-bishop-mode">${stage6EscAttr(modeMeta.label)}</strong>
                  </div>
                  <div class="st6-bishop-status-stat">
                    <span class="st6-bishop-status-label">${stage6EscAttr(workspaceFocusLabel)}</span>
                    <strong>${stage6EscAttr(workspaceFocusValue)}</strong>
                  </div>
                  <div class="st6-bishop-status-stat">
                    <span class="st6-bishop-status-label">Line</span>
                    <strong>${stage6EscAttr(measurementStatus)}</strong>
                  </div>
                </div>
                <div class="st6-bishop-status-hint">${stage6EscAttr(workspaceReadyHint)}</div>
              </div>
            </div>
            <div class="st6-bishop-progress-track"><div id="stage6BishopProgressBar" class="st6-bishop-progress-bar" style="width:${Math.max(0, Math.min(100, toolbarProgressPercent))}%"></div></div>
            <div class="st6-bishop-canvas-stage">
              ${canvasToolRailHtml}
              <canvas id="stage6BishopCanvas" class="st6-bishop-canvas" role="img" aria-label="Seep/Slope section and slip circles"></canvas>
              ${toolbarHasResult ? `
                <button
                  type="button"
                  class="st6-canvas-capture${bishop.capturedView?.[workspace] ? ' has-capture' : ''}"
                  onclick="stage7CaptureWorkspaceView('${workspace}')"
                  aria-label="${bishop.capturedView?.[workspace]
                    ? 'Recapture the current canvas view for the Stage 7 report. Last captured at ' + new Date(bishop.capturedView[workspace].capturedAt).toLocaleTimeString() + '.'
                    : 'Capture the current canvas view for the Stage 7 report.'}"
                  title="${bishop.capturedView?.[workspace]
                    ? 'Captured ' + new Date(bishop.capturedView[workspace].capturedAt).toLocaleTimeString() + ' · click to recapture'
                    : 'Capture for Stage 7 report'}"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                    <path d="M4 7h3.2l1.6-2h6.4l1.6 2H20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                    <circle cx="12" cy="13" r="3.4" fill="none" stroke="currentColor" stroke-width="1.6"/>
                  </svg>
                  ${bishop.capturedView?.[workspace] ? '<span class="st6-canvas-capture__check" aria-hidden="true">✓</span>' : ''}
                </button>
              ` : ''}
              ${canvasViewMenuHtml}
              ${activeContourLegendHtml}
	              <div id="stage6BishopTip" class="section-tip st6-bishop-tip"></div>
	            </div>
	            <div id="stage6BishopCoord" class="st6-bishop-coord"></div>
	            <div class="st6-help" style="margin-top:10px">${workspaceCanvasHelp}</div>
	          </div>
	          ${workspaceResultsHtml}
	        </div>
	      </div>
		      ${workspace === 'deformation' ? '' : stage6NoteHtml(workspace === 'seepage'
	          ? [
	              {level:'warn', text:'This Stage 6 seepage workflow is experimental. It solves steady-state 2D seepage on a constrained triangular FEM mesh built from the shared section geometry.'},
	              {level:'info', text:'The soil model is derived from the active CPT only. The interpreted layer column is extended horizontally across the drawn section for this workflow.'},
	              {level:'info', text:'Use prescribed-head, seepage-face, and no-flow conditions only on the terrain, side, and base boundaries. Interior polygon edges are material interfaces, not seepage boundaries.'},
              {level:'info', text:'The seepage result can be reused by the deformation screen and, when enabled, by the Bishop/Spencer pore-pressure hook without redrawing the section.'}
            ]
          : [
	              {level:'warn', text:'This Stage 6 slope check is experimental. It searches circular slip surfaces only and currently uses self-weight, optional infinitely stiff retaining walls, multiple optional uniform surcharge strips, and optional phreatic pore pressure along the base.'},
              {level:'info', text:'The soil model is derived from the active CPT only. The interpreted layer column is extended horizontally across the drawn section for this workflow.'},
	              {level:'info', text:'Spencer runs as a verification pass on the best Bishop circles. Each shortlisted circle is solved by intersecting the Spencer moment and force branches. If Spencer does not converge for a shortlisted circle, the app keeps the Bishop result and flags that fallback in the results panel.'},
	              {level:'info', text:'When a circle intersects a retaining wall, Bishop reduces the driving moment with the wall resistance and Spencer injects the same wall force into the horizontal force chain. Circles that pass below the wall tip remain unchanged and may still govern.'}
	            ]
	      )}
    </div>
  `;
}

function renderStage6(){
  ensureStage6State();
  const el = document.getElementById('stage6Area');
  if(!el) return;
  const scrollState = stage6CaptureScrollState(el);
  stage6RememberDetailsState();
  if(!S.layers.length){
    el.innerHTML='<div style="color:var(--tx2);font-size:13px;padding:20px 0">Run the CPT through Stages 2–5 first so Stage 6 can reuse the interpreted layer model.</div>';
    return;
  }
  const layers = stage6WorkingLayers();
  const app = S.stage6.app;
  let body = '';
  if(app === 'bearing'){
    const profile = bearingProfile(S.stage6.bearing, layers);
    S.stage6Cache.bearing = profile;
    body = renderStage6BearingApp(profile);
  } else if(app === 'pile'){
    const analysis = analyzePile(layers, S.wt, S.data, S.stage6.pile);
    S.stage6Cache.pile = analysis;
    ensurePileCanvasState(S.stage6Cache);
    body = renderStage6PileApp(analysis);
  } else if(app === 'settlement'){
    const analysis = analyzeSettlement(layers, S.wt, S.stage6.settlement);
    S.stage6Cache.settlement = analysis;
    body = renderStage6SettlementApp(analysis);
  } else if(app === 'dewatering'){
    const analysis = analyzeDewatering(layers, S.wt, S.stage6.dewatering);
    S.stage6Cache.dewatering = analysis;
    body = renderStage6DewateringApp(analysis);
  } else if(app === 'bishop'){
    body = renderStage6BishopApp();
  } else if(app === 'retwall'){
    body = retainingApp.renderBody();
  } else {
    const analysis = analyzeBeamAndReinforcement(layers, S.wt, S.stage6.beam);
    S.stage6Cache.beam = analysis;
    body = renderStage6BeamApp(analysis);
  }
  el.innerHTML = `${stage6CardsHtml(app)}${stage6SharedBanner()}${body}`;
  stage6RestoreScrollState(el, scrollState);
  requestAnimationFrame(()=>{
    if(app === 'bearing') buildStage6BearingChart();
    if(app === 'pile'){
      drawStage6PileSectionLive();
      buildStage6PileCharts();
    }
    if(app === 'settlement') buildStage6SettlementCharts();
    if(app === 'dewatering') buildStage6DewateringCharts();
    if(app === 'beam') buildStage6BeamCharts();
    if(app === 'bishop'){
      initStage6BishopCanvas();
      buildStage6BishopLineProbeChart();
      buildStage6BishopWallCharts();
    }
    if(app === 'retwall') retainingApp.postRender();
    stage6RestoreScrollState(el, scrollState);
  });
}

function stage6DestroyChart(id){
  const canvas = document.getElementById(id);
  if(canvas && canvas._chartRef && canvas._chartRef.destroy) canvas._chartRef.destroy();
  return canvas;
}

function buildStage6BearingChart(){
  const canvas = stage6DestroyChart('stage6BearingChart');
  const data = S.stage6Cache?.bearing;
  if(!canvas || !data || typeof Chart === 'undefined') return;
  const cfg = S.stage6.bearing;
  const chart = new Chart(canvas, buildBearingChartConfig({
    data,
    cfg,
    capacityAxisTitle:stage6CapacityLabel(cfg)==='q_d'
      ? 'Design bearing capacity q_d (kPa)'
      : 'Allowable bearing capacity q_allow (kPa)'
  }));
  canvas._chartRef = chart;
}

function buildStage6SettlementCharts(){
  const analysis = S.stage6Cache?.settlement;
  if(!analysis || typeof Chart === 'undefined') return;
  const stressCanvas = stage6DestroyChart('stage6SettlementStressChart');
  if(stressCanvas){
    stressCanvas._chartRef = new Chart(stressCanvas, buildSettlementStressChartConfig({
      analysis,
      maxDepth:stage6MaxDepth()
    }));
  }
  const cumCanvas = stage6DestroyChart('stage6SettlementCumulativeChart');
  if(cumCanvas){
    cumCanvas._chartRef = new Chart(cumCanvas, buildSettlementCumulativeChartConfig({analysis}));
  }
  const timeCanvas = stage6DestroyChart('stage6SettlementTimeChart');
  if(timeCanvas && analysis.timeCurve){
    timeCanvas._chartRef = new Chart(timeCanvas, buildTimeChartConfig({
      curve:analysis.timeCurve
    }));
  }
}

function buildStage6DewateringCharts(){
  const analysis = S.stage6Cache?.dewatering;
  if(!analysis || typeof Chart === 'undefined') return;
  const drawCanvas = stage6DestroyChart('stage6DewateringDrawdownChart');
  if(drawCanvas){
    drawCanvas._chartRef = new Chart(drawCanvas, buildDewateringDrawdownChartConfig({
      analysis,
      originalWt:S.wt
    }));
  }
  const stressCanvas = stage6DestroyChart('stage6DewateringStressChart');
  if(stressCanvas){
    stressCanvas._chartRef = new Chart(stressCanvas, buildDewateringStressChartConfig({
      analysis,
      maxDepth:stage6MaxDepth()
    }));
  }
  const setCanvas = stage6DestroyChart('stage6DewateringSettlementChart');
  if(setCanvas){
    setCanvas._chartRef = new Chart(setCanvas, buildDewateringSettlementChartConfig({analysis}));
  }
  const timeCanvas = stage6DestroyChart('stage6DewateringTimeChart');
  if(timeCanvas && analysis.timeCurve){
    timeCanvas._chartRef = new Chart(timeCanvas, buildTimeChartConfig({
      curve:analysis.timeCurve
    }));
  }
}

function buildStage6BeamCharts(){
  const analysis = S.stage6Cache?.beam;
  if(!analysis) return;
  if(typeof Chart !== 'undefined'){
    const tickFmt = (value)=>stage6CompactNumber(value, 2);
    const defCanvas = stage6DestroyChart('stage6BeamDeflectionChart');
    if(defCanvas){
      defCanvas._chartRef = new Chart(defCanvas, buildBeamDeflectionChartConfig({
        analysis,
        tickFormatter:tickFmt
      }));
    }
    const momentCanvas = stage6DestroyChart('stage6BeamMomentChart');
    if(momentCanvas){
      momentCanvas._chartRef = new Chart(momentCanvas, buildBeamMomentChartConfig({
        analysis,
        tickFormatter:tickFmt
      }));
    }
  }
  drawStage6BeamGeometryPreview(analysis);
}

function stage6BeamCanvasText(ctx, text, x, y, opts = {}){
  const size = opts.size || 11;
  const weight = opts.weight || 500;
  ctx.save();
  ctx.font = `${weight} ${size}px Inter, system-ui, sans-serif`;
  ctx.fillStyle = opts.color || '#344054';
  ctx.textAlign = opts.align || 'left';
  ctx.textBaseline = opts.baseline || 'middle';
  ctx.fillText(text, x, y);
  ctx.restore();
}

function stage6BeamRoundedRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function stage6BeamDrawDimension(ctx, x1, y1, x2, y2, label, vertical = false){
  ctx.save();
  ctx.strokeStyle = '#667085';
  ctx.fillStyle = '#667085';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const tick = 4;
  if(vertical){
    ctx.beginPath();
    ctx.moveTo(x1 - tick, y1);
    ctx.lineTo(x1 + tick, y1);
    ctx.moveTo(x2 - tick, y2);
    ctx.lineTo(x2 + tick, y2);
    ctx.stroke();
    stage6BeamCanvasText(ctx, label, x1 + 8, (y1 + y2) / 2, {size:10, color:'#475467'});
  }else{
    ctx.beginPath();
    ctx.moveTo(x1, y1 - tick);
    ctx.lineTo(x1, y1 + tick);
    ctx.moveTo(x2, y2 - tick);
    ctx.lineTo(x2, y2 + tick);
    ctx.stroke();
    stage6BeamCanvasText(ctx, label, (x1 + x2) / 2, y1 - 9, {size:10, color:'#475467', align:'center'});
  }
  ctx.restore();
}

function stage6BeamDrawLoadArrow(ctx, x, yTop, yBot, color){
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(x, yTop);
  ctx.lineTo(x, yBot);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x, yBot);
  ctx.lineTo(x - 4, yBot - 7);
  ctx.lineTo(x + 4, yBot - 7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawStage6BeamGeometryPreview(analysis){
  const canvas = document.getElementById('stage6BeamGeometryCanvas');
  if(!(canvas instanceof HTMLCanvasElement) || !analysis) return;
  const rect = canvas.getBoundingClientRect();
  if(!(rect.width > 0 && rect.height > 0)) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if(canvas.width !== w || canvas.height !== h){
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if(!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  const W = rect.width;
  const H = rect.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(0, 0, W, H);

  const cfg = S.stage6?.beam || {};
  const ks = analysis.ksInfo || {};
  const mode = cfg.modelMode || 'slab_strip';
  const axisCopy = stage6BeamAxisCopy(mode);
  const L = Math.max(+cfg.L || +ks.L || 6, 0.5);
  const b = Math.max(+cfg.b || +ks.b || 1, 0.1);
  const B = Math.max(+cfg.B || +ks.B || b, 0.1);
  const depth = Math.max(+cfg.h || +ks.h || 0.3, 0.05);
  const Df = Math.max(+cfg.Df || 0, 0);
  const pattern = cfg.loadPattern || 'uniform_full';
  const margin = 18;
  const mainX = margin;
  const mainY = 24;
  const mainW = Math.max(160, W - 210);
  const mainH = H - 42;
  const insetX = mainX + mainW + 18;
  const insetW = Math.max(150, W - insetX - margin);
  const soilY = mainY + Math.min(mainH * 0.58, mainH - 58);
  const zScale = Math.min(54, Math.max(10, (soilY - mainY - 12) / Math.max(Df, depth, 0.1)));
  const groundY = Math.max(mainY + 10, soilY - Df * zScale);
  const beamPixH = Math.max(10, Math.min(64, depth * zScale));
  const beamY = soilY - beamPixH;
  const scaleX = mainW / L;

  // Soil bed and founding depth context.
  ctx.fillStyle = '#EEF4EC';
  ctx.fillRect(mainX, groundY, mainW, mainH - (groundY - mainY));
  ctx.strokeStyle = '#6F8F64';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(mainX, groundY);
  ctx.lineTo(mainX + mainW, groundY);
  ctx.stroke();
  ctx.setLineDash([]);
  stage6BeamCanvasText(ctx, 'soil surface', mainX + 6, groundY - 8, {size:10, color:'#667085'});
  ctx.strokeStyle = '#8AA57F';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(mainX, soilY);
  ctx.lineTo(mainX + mainW, soilY);
  ctx.stroke();
  for(let x = mainX; x < mainX + mainW; x += 14){
    ctx.strokeStyle = 'rgba(138,165,127,0.32)';
    ctx.beginPath();
    ctx.moveTo(x, soilY + 8);
    ctx.lineTo(x + 10, soilY);
    ctx.stroke();
  }

  // Springs.
  const springCount = Math.max(8, Math.min(22, Math.round(mainW / 28)));
  ctx.strokeStyle = '#9AA6B2';
  ctx.lineWidth = 1;
  for(let i = 0; i <= springCount; i += 1){
    const x = mainX + (mainW * i) / springCount;
    const y0 = soilY + 3;
    const amp = 4;
    const step = 4;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    for(let j = 1; j <= 6; j += 1){
      ctx.lineTo(x + (j % 2 ? amp : -amp), y0 + j * step);
    }
    ctx.lineTo(x, y0 + 7 * step);
    ctx.stroke();
  }

  // Beam/slab rectangle in x-z view.
  stage6BeamRoundedRect(ctx, mainX, beamY, mainW, beamPixH, 2);
  ctx.fillStyle = '#D9E7F5';
  ctx.fill();
  ctx.strokeStyle = '#3C6F97';
  ctx.lineWidth = 1.3;
  ctx.stroke();
  ctx.fillStyle = 'rgba(60,111,151,0.12)';
  ctx.fillRect(mainX, beamY + beamPixH - 5, mainW, 5);

  // Load rendering.
  const loadColor = '#C2410C';
  if(pattern === 'uniform_full' || pattern === 'uniform_patch'){
    const xStart = pattern === 'uniform_patch' ? Math.max(0, Math.min(L, +cfg.xStart || 0)) : 0;
    const xEndRaw = pattern === 'uniform_patch' ? (+cfg.xEnd || L) : L;
    const xEnd = Math.max(xStart, Math.min(L, xEndRaw));
    const px1 = mainX + xStart * scaleX;
    const px2 = mainX + xEnd * scaleX;
    ctx.fillStyle = 'rgba(194,65,12,0.10)';
    ctx.fillRect(px1, beamY - 30, Math.max(2, px2 - px1), 24);
    const arrows = Math.max(2, Math.min(10, Math.round((px2 - px1) / 28)));
    for(let i = 0; i < arrows; i += 1){
      const x = px1 + ((px2 - px1) * (i + 0.5)) / arrows;
      stage6BeamDrawLoadArrow(ctx, x, beamY - 28, beamY - 6, loadColor);
    }
    stage6BeamCanvasText(ctx, pattern === 'uniform_patch' ? 'patch q(x)' : 'full-length q(x)', (px1 + px2) / 2, beamY - 36, {size:10, color:loadColor, align:'center'});
  }else{
    const pointX = pattern === 'point_at_x' ? (+cfg.xLoad || L / 2) : L / 2;
    const px = mainX + Math.max(0, Math.min(L, pointX)) * scaleX;
    stage6BeamDrawLoadArrow(ctx, px, beamY - 40, beamY - 5, loadColor);
    stage6BeamCanvasText(ctx, 'P', px + 7, beamY - 34, {size:10, color:loadColor});
  }

  stage6BeamDrawDimension(ctx, mainX, beamY + beamPixH + 42, mainX + mainW, beamY + beamPixH + 42, `L = ${L.toFixed(2)} m`);
  stage6BeamDrawDimension(ctx, mainX + mainW + 8, beamY, mainX + mainW + 8, beamY + beamPixH, `h = ${depth.toFixed(2)} m`, true);
  stage6BeamDrawDimension(ctx, mainX + 10, groundY, mainX + 10, soilY, `Df = ${Df.toFixed(2)} m`, true);
  stage6BeamCanvasText(ctx, 'soil bed / elastic support', mainX + mainW - 6, soilY + 44, {size:10, color:'#667085', align:'right'});
  stage6BeamCanvasText(ctx, `x-z view - ${axisCopy.summary}`, mainX, 13, {size:11, weight:700, color:'#344054'});

  // Cross-section inset y-z.
  const insetY = mainY + 8;
  const insetH = mainH - 12;
  ctx.strokeStyle = '#D0D5DD';
  ctx.beginPath();
  ctx.moveTo(insetX - 10, mainY);
  ctx.lineTo(insetX - 10, mainY + mainH);
  ctx.stroke();
  stage6BeamCanvasText(ctx, 'y-z section', insetX, 13, {size:11, weight:700, color:'#344054'});
  const secBaseY = insetY + Math.min(insetH * 0.58, insetH - 56);
  const maxSecW = insetW - 36;
  const widthScale = maxSecW / Math.max(b, B);
  const bW = Math.max(16, b * widthScale);
  const BW = Math.max(16, B * widthScale);
  const secZScale = Math.min(58, Math.max(14, (secBaseY - insetY - 12) / Math.max(Df, depth, 0.1)));
  const secGroundY = Math.max(insetY + 8, secBaseY - Df * secZScale);
  const secH = Math.max(20, Math.min(76, depth * secZScale));
  const secCX = insetX + insetW / 2;
  const secX = secCX - bW / 2;
  const secY = secBaseY - secH;
  ctx.fillStyle = '#EEF4EC';
  ctx.fillRect(insetX, secGroundY, insetW - 4, insetH - (secGroundY - insetY));
  ctx.strokeStyle = '#6F8F64';
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(insetX, secGroundY);
  ctx.lineTo(insetX + insetW - 4, secGroundY);
  ctx.stroke();
  ctx.setLineDash([]);
  stage6BeamCanvasText(ctx, 'surface', insetX + 3, secGroundY - 8, {size:9, color:'#667085'});
  ctx.strokeStyle = '#8AA57F';
  ctx.beginPath();
  ctx.moveTo(insetX, secBaseY);
  ctx.lineTo(insetX + insetW - 4, secBaseY);
  ctx.stroke();
  const bx = secCX - BW / 2;
  ctx.fillStyle = 'rgba(138,165,127,0.20)';
  ctx.fillRect(bx, secBaseY + 2, BW, 12);
  ctx.strokeStyle = '#8AA57F';
  ctx.strokeRect(bx, secBaseY + 2, BW, 12);
  stage6BeamRoundedRect(ctx, secX, secY, bW, secH, 2);
  ctx.fillStyle = '#D9E7F5';
  ctx.fill();
  ctx.strokeStyle = '#3C6F97';
  ctx.stroke();
  stage6BeamDrawDimension(ctx, secX, secY - 10, secX + bW, secY - 10, `b = ${b.toFixed(2)} m`);
  stage6BeamDrawDimension(ctx, secX + bW + 8, secY, secX + bW + 8, secY + secH, `h = ${depth.toFixed(2)} m`, true);
  stage6BeamDrawDimension(ctx, bx, secBaseY + 30, bx + BW, secBaseY + 30, `B = ${B.toFixed(2)} m`);
  stage6BeamCanvasText(ctx, axisCopy.canvasMode, insetX, H - 15, {size:10, color:'#475467'});
  ctx.restore();
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
   CSV EXPORT
════════════════════════════════ */
function exportCSV(){
  if(!S.layers.length){alert('No layers to export. Run classification first.');return;}
  const taw=z=>S.elev!=null?(S.elev-z).toFixed(2):'';
  const hdr='Layer,Type,Subtype,Top_m,Bot_m,Top_TAW,Bot_TAW,Thick_m,avgQc_MPa,avgRf_pct,gamma,gamma_sat,phi,c,cu,alphaE,alphaMethod,Eoed_i_kPa,Eoed_ref_kPa,E50_ref_kPa,Eur_ref_kPa,E_mc_kPa,nu,rShear,m,K0nc,nu_ur,stiffMethod,kh_ms,kv_ms,khkv,psi_unsat_m,Infiltratie_klasse';
  const rows=S.layers.map((l,i)=>{
    const h=hsParams(l);
    const k=khParams(l);
    return[i+1,l.type,`"${l.subtype||''}"`,
      l.top.toFixed(3),l.bot.toFixed(3),taw(l.top),taw(l.bot),
      (l.bot-l.top).toFixed(3),l.avgQc,l.avgRf??'',
      l.g,l.gs,l.phi,l.c,l.cu,
      h.aE.toFixed(2),S.alphaMethod,
      h.Eoed_i,h.Eoed_ref,h.E50_ref,h.Eur_ref,h.Emc,h.nu,h.rShear.toFixed(2),h.m.toFixed(2),h.K0nc,h.nu_ur,S.stiffMethod,
      k.kh_rep.toExponential(2),k.kv_rep.toExponential(2),k.khkv,k.psi_unsat,
      `"${k.infClass}"`].join(',');
  });
  const csv=[hdr,...rows].join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=`CPT_${S.meta.testid||'export'}_layers.csv`;
  a.click();
}

function safeMaterialToken(value){
  let txt=String(value??'').trim();
  if(txt.normalize) txt=txt.normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
  txt=txt.replace(/[(),]/g,'').replace(/\s+/g,'_').replace(/[^A-Za-z0-9_.-]/g,'');
  return txt || 'Layer';
}

function plaxisDrainageType(layer){
  const sub=(layer.subtype||'').toLowerCase();
  if(sub.includes('(lh)') || sub.includes('(kh)') || sub.includes('leemhoudend') || sub.includes('klei-/leemhoudend')){
    return 'Undrained A';
  }
  return layer.type==='Sand' || layer.type==='Gravel' ? 'Drained' : 'Undrained A';
}

function plaxisDisplayName(value){
  return String(value??'')
    .replace(/"/g, '\'')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function plaxisCommandValue(value){
  if(typeof value === 'number'){
    if(!isFinite(value)) return '0';
    return Object.is(value, -0) ? '0' : String(value);
  }
  return `"${plaxisDisplayName(value)}"`;
}

function buildPlaxisSoilmatCommand(pairs){
  return `soilmat ${pairs.map(([key,val])=>`${plaxisCommandValue(key)} ${plaxisCommandValue(val)}`).join(' ')}`;
}

function msToMday(value){
  if(!isFinite(value)) return 0;
  return +(value * 86400).toFixed(6);
}

function exportPlaxisCommands(){
  if(!S.layers.length){
    alert('No layers to export. Run classification first.');
    return;
  }

  const cptId=S.meta.testid||S.id||'CPT';
  const commands=S.layers.flatMap((l,i)=>{
    const layerId=i+1;
    const subtype=l.subtype||l.type||`Layer_${layerId}`;
    const safeSubtype=safeMaterialToken(subtype);
    const baseName=`${safeMaterialToken(cptId)}_L${layerId}_${safeSubtype}`;
    const dr=plaxisDrainageType(l);
    const h=hsParams(l);
    const k=khParams(l);
    const khMday=msToMday(k.kh_rep);
    const kvMday=msToMday(k.kv_rep);
    const cohesion=Math.max(Number(l.c)||0,0.1);
    const mcName=`${baseName}_MC`;
    const hsName=`${baseName}_HS`;

    return[
      buildPlaxisSoilmatCommand([
        ['Identification', mcName],
        ['SoilModel', 2],
        ['DrainageType', dr],
        ['gammaUnsat', l.g],
        ['gammaSat', l.gs],
        ['ERef', h.Emc],
        ['nu', h.nu],
        ['cRef', cohesion],
        ['phi', l.phi],
        ['psi', h.psi],
        ['PermHorizontalPrimary', khMday],
        ['PermVertical', kvMday]
      ]),
      buildPlaxisSoilmatCommand([
        ['Identification', hsName],
        ['SoilModel', 3],
        ['DrainageType', dr],
        ['gammaUnsat', l.g],
        ['gammaSat', l.gs],
        ['E50Ref', h.E50_ref],
        ['EOedRef', h.Eoed_ref],
        ['EURRef', h.Eur_ref],
        ['PowerM', h.m],
        ['pRef', 100],
        ['cRef', cohesion],
        ['phi', l.phi],
        ['psi', h.psi],
        ['PermHorizontalPrimary', khMday],
        ['PermVertical', kvMday]
      ])
    ];
  });
  const txt=commands.join('\r\n');
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(txt);
  a.download=`CPT_${safeMaterialToken(cptId)}_plaxis_materials_commands.txt`;
  a.click();
}

function findLayerForDepth(z){
  for(let i=0;i<S.layers.length;i++){
    const l=S.layers[i];
    const isLast=i===S.layers.length-1;
    if(z >= l.top && (z < l.bot || (isLast && z <= l.bot))) return l;
  }
  return null;
}

function simulatedLayerFs(layer){
  if(layer.avgFs!=null && isFinite(layer.avgFs)) return Math.max(0, layer.avgFs);
  if(layer.avgRf!=null && isFinite(layer.avgRf)) return Math.max(0, layer.avgQc * layer.avgRf / 100);
  return 0;
}

function formatPlaxisCoord(value){
  if(value==null || !isFinite(value)) return '0';
  const rounded=Math.abs(value) < 1e-9 ? 0 : value;
  const txt=rounded.toFixed(4).replace(/\.?0+$/,'');
  return txt === '-0' ? '0' : txt;
}

function exportPlaxisCpt(){
  if(!S.layers.length || !S.data.length){
    alert('No layer model to export. Run classification and layer identification first.');
    return;
  }

  const rows=S.data
    .map(r=>{
      const layer=findLayerForDepth(r.z);
      if(!layer) return null;
      return{
        z:r.z,
        qc:Math.max(0, layer.avgQc || 0),
        fs:simulatedLayerFs(layer)
      };
    })
    .filter(Boolean);

  if(!rows.length){
    alert('No simulated CPT rows could be generated from the active layer model.');
    return;
  }

  const lines=[
    `X[m] ${formatPlaxisCoord(S.x)}`,
    `Y[m] ${formatPlaxisCoord(S.y)}`,
    `Z[m] ${formatPlaxisCoord(S.elev)}`,
    'D[m] Q[MPa] F[MPa] x  # depth, qc, fs, Rf(skipped)',
    ...rows.map(r=>`${r.z.toFixed(4)} ${r.qc.toFixed(6)} ${r.fs.toFixed(6)} 0`)
  ];

  const txt=lines.join('\r\n');
  const a=document.createElement('a');
  a.href='data:text/plain;charset=utf-8,'+encodeURIComponent(txt);
  a.download=`CPT_${S.meta.testid||S.id||'export'}_plaxis_simulated.txt`;
  a.click();
}

function safeClone(value){
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stage7MethodLabel(method){
  return classificationMethodLabel(method);
}

function stage7ParamMethodLabel(method){
  return method === 'def' ? 'Generic (DEF)' : 'NEN Tabel 3 / EC7';
}

function stage7AlphaMethodLabel(method){
  return method === 'A' ? 'A - Sanglerat (fixed)' : 'B - SB260 qc-dependent';
}

function stage7StiffMethodLabel(method){
  return method === 'A' ? 'A - CUR 2003-7 ratios' : 'B - E50 = Eoed';
}

function stage7WtSourceLabel(){
  return S.wtFromFile ? (S.wtSource || 'File') : 'Manual / default';
}

function stage7ElevSourceLabel(){
  return S.elevFromFile ? (S.elevSource || 'File') : (S.elev != null ? 'Manual' : 'Not set');
}

function stage7LayerWarnings(){
  const warnings=[];
  S.layers.forEach((layer, index)=>{
    if(!layer.subtype || layer.subtype === '(overridden)') return;
    const entry=CAT.find(row=>row.subtype===layer.subtype);
    if(!entry) return;
    const level=compatLevel(layer.type, entry.grp);
    if(level === 'ok') return;
    warnings.push({
      layer:index + 1,
      level,
      type:layer.type,
      subtype:layer.subtype,
      message:level === 'bad'
        ? `${layer.type} is not directly compatible with ${layer.subtype}.`
        : `${layer.subtype} sits in an adjacent transition family for ${layer.type}.`
    });
  });
  return warnings;
}

function stage7TuningPayload(){
  if(!S.tuning) return null;
  return S.tuning.map((item)=>{
    const layer=S.layers[item.i];
    const fit=item.fit;
    return{
      index:item.i,
      layerIndex:item.i + 1,
      layerLabel:`Layer ${item.i + 1}`,
      top:layer.top,
      bot:layer.bot,
      type:layer.type,
      subtype:layer.subtype || '',
      accepted:!!layer.ovr.m,
      previewM:Number.isFinite(Number(item.previewM)) ? Number(item.previewM) : null,
      fit:fit ? {
        mFit:fit.m_fit,
        eOedRefFit:fit.Eoed_ref_fit,
        r2:fit.R2,
        n:fit.n,
        stressRangeFactor:fit.stressRangeFactor,
        quality:fit.quality,
        message:fit.qMsg,
        mDefault:fit.mDefault,
        eOedRefDefault:fit.Eoed_ref_default,
        meanX:fit.meanX,
        meanY:fit.meanY,
        alphaDefault:fit.alphaDefault,
        depthPts:fit.depthPts,
        eOedIPts:fit.EoedI_pts,
        hsDefaultPts:fit.hsDefault_pts,
        hsFitPts:fit.hsFit_pts,
        xs:fit.Xs,
        ys:fit.Ys
      } : null
    };
  });
}

function stage7WorkingLayerPayload(layer, index){
  const hs=hsParams(layer);
  const kh=khParams(layer);
  const tuningFit=S.tuning?.[index]?.fit || null;
  return{
    index:index + 1,
    id:layer.id,
    top:layer.top,
    bot:layer.bot,
    topTaw:S.elev != null ? +(S.elev - layer.top).toFixed(2) : null,
    botTaw:S.elev != null ? +(S.elev - layer.bot).toFixed(2) : null,
    thickness:+(layer.bot - layer.top).toFixed(3),
    type:layer.type,
    subtype:layer.subtype || '',
    avgQc:layer.avgQc,
    avgFsKPa:layer.avgFs != null ? +(layer.avgFs * 1000).toFixed(2) : null,
    avgRf:layer.avgRf,
    gamma:layer.g,
    gammaSat:layer.gs,
    phi:layer.phi,
    c:layer.c,
    cu:layer.cu,
    overrides:safeClone(layer.ovr || {}),
    hasAcceptedTuning:!!layer.ovr?.m && !!tuningFit,
    manualMOverride:!!layer.ovr?.m && !tuningFit,
    hs:{
      alphaE:hs.aE,
      eOedI:hs.Eoed_i,
      eOedRef:hs.Eoed_ref,
      e50Ref:hs.E50_ref,
      eurRef:hs.Eur_ref,
      m:hs.m,
      k0nc:hs.K0nc,
      nu:hs.nu,
      nuUr:hs.nu_ur,
      rShear:hs.rShear,
      psi:hs.psi,
      eMc:hs.Emc,
      sigmaV:hs.sigV,
      porePressure:hs.u,
      sigmaVEff:hs.sigVeff
    },
    hydraulic:{
      kh:kh.kh_rep,
      kv:kh.kv_rep,
      khkv:kh.khkv,
      psiUnsat:kh.psi_unsat,
      infiltrationClass:kh.infClass
    }
  };
}

function stage7BishopPayload(){
  const bishop=S.stage6?.bishop;
  const results=bishop?.results?.allResults || [];
  if(!results.length) return null;
  const selected=stage6BishopSelectedResult();
  const keepBest=Math.max(bishop.search?.keepBest || 10, 1);
  return{
    config:safeClone({
      strengthSet:bishop.strengthSet,
      methodMode:bishop.methodMode,
      analysisDepth:bishop.analysisDepth,
      snapSize:bishop.snapSize,
      gridSnap:bishop.gridSnap,
      pointSnap:bishop.pointSnap,
	      activeCptX:bishop.activeCptX,
	      walls:bishop.walls,
	      entryZone:bishop.entryZone,
	      exitZone:bishop.exitZone,
	      surfaceLoad:bishop.surfaceLoad,
	      surfaceLoads:bishop.surfaceLoads,
	      search:bishop.search,
      solver:bishop.solver,
      spencer:bishop.spencer
    }),
    summary:safeClone(bishop.results?.summary || null),
    wallSummary:safeClone(bishop.results?.wallSummary || null),
    methodMode:bishop.results?.methodMode || bishop.methodMode || 'bishop_only',
    spencerRechecked:bishop.results?.spencerRechecked || 0,
    spencerConverged:bishop.results?.spencerConverged || 0,
    selectedIndex:Math.min(Math.max(bishop.selectedResult || 0, 0), Math.max(results.length - 1, 0)),
    selected:selected ? safeClone({
      FS:selected.FS,
      method:selected.method,
      methodLabel:stage6BishopResultMethodLabel(selected),
      F_bishop:selected.F_bishop,
      F_m:selected.F_m,
      F_f:selected.F_f,
      lambda:selected.lambda,
      thetaDeg:selected.thetaDeg,
      momentResidual:selected.momentResidual,
      forceResidual:selected.forceResidual,
      spencerAttempted:selected.spencerAttempted,
      spencerConverged:selected.spencerConverged,
      spencerRejectReason:selected.spencerRejectReason,
      intersectsWall:selected.intersectsWall,
      passesBelowWall:selected.passesBelowWall,
      wallIntersectionCount:selected.wallIntersectionCount,
      wallForceTotal:selected.wallForceTotal,
      wallMomentTerm:selected.wallMomentTerm,
      wallForces:selected.wallForces,
      iterations:selected.iterations,
      circle:selected.circle,
      entry:selected.entry,
      exit:selected.exit
    }) : null,
    topResults:results.slice(0, keepBest).map((result, index)=>safeClone({
      rank:index + 1,
      FS:result.FS,
      method:result.method,
      methodLabel:stage6BishopResultMethodLabel(result),
      F_bishop:result.F_bishop,
      F_m:result.F_m,
      F_f:result.F_f,
      lambda:result.lambda,
      thetaDeg:result.thetaDeg,
      momentResidual:result.momentResidual,
      forceResidual:result.forceResidual,
      spencerAttempted:result.spencerAttempted,
      spencerConverged:result.spencerConverged,
      spencerRejectReason:result.spencerRejectReason,
      intersectsWall:result.intersectsWall,
      passesBelowWall:result.passesBelowWall,
      wallIntersectionCount:result.wallIntersectionCount,
      wallForceTotal:result.wallForceTotal,
      iterations:result.iterations,
      circle:result.circle
    })),
    rejectionCounts:safeClone(bishop.results?.rejectionCounts || {}),
    timing:safeClone(bishop.results?.timing || null)
  };
}

function stage7SeepagePayload(){
  const bishop=S.stage6?.bishop;
  const seepage=bishop?.seepage;
  if(!bishop || !seepage) return null;
  try{
    const model=S.stage6Cache?.bishopModel || null;
    const boundary=S.stage6Cache?.bishopSeepageBoundary || [];
    const edgeByKey=new Map(boundary.map((edge)=>[edge.edgeKey, edge]));
    const activeBcs=(seepage.bcs || []).filter((bc)=>bc?.status !== 'orphaned');
    const orphanedBcs=(seepage.bcs || []).filter((bc)=>bc?.status === 'orphaned');
    const hasSetup=!!(activeBcs.length || orphanedBcs.length || seepage.mesh || seepage.result || seepage.rejectReason);
    if(!hasSetup) return null;
    const prescribedHeadCount=activeBcs.filter((bc)=>bc.type === 'head').length;
    const seepageFaceCount=activeBcs.filter((bc)=>bc.type === 'seepage-face').length;
    const noFlowCount=activeBcs.filter((bc)=>bc.type !== 'head' && bc.type !== 'seepage-face').length;
    const edgeLabelFor=(edgeKey, anchorSource)=>{
      if(edgeByKey.has(edgeKey)) return stage6BishopSeepageEdgeLabel(edgeByKey.get(edgeKey));
      if(typeof edgeKey === 'string' && edgeKey){
        const [source, rawIndex] = edgeKey.split(':');
        const index = Number(rawIndex);
        return stage6BishopSeepageEdgeLabel({
          source:source || anchorSource || '',
          index:Number.isFinite(index) ? index : 0
        });
      }
      return anchorSource ? `${anchorSource} edge` : 'Unmatched boundary edge';
    };
    return{
      config:safeClone({
        freeSurface:seepage.options?.freeSurface === 'iterate' ? 'iterate' : 'fixed',
        usePhreaticAsSeed:seepage.options?.usePhreaticAsSeed !== false,
        flowErrorTolerance:Math.max(+seepage.options?.flowErrorTolerance || 0.01, 0.000001),
        maxRuntimeMs:Math.max(+seepage.options?.maxRuntimeMs || 10000, 1),
        meshTargetArea:stage6BishopResolvedSeepageMeshTargetArea(bishop),
        meshTargetAreaAuto:seepage.options?.meshTargetAreaAuto !== false,
        drains:safeClone(seepage.options?.drains || {gatingTolerances:{}, reportPerSegmentInflow:true}),
        useFemPorePressure:!!bishop.useFemPorePressure
      }),
      summary:{
        status:seepage.status || 'idle',
        solved:!!seepage.mesh && !!seepage.result,
        rejectReason:seepage.rejectReason || '',
        explicitBcCount:(seepage.bcs || []).length,
        activeBcCount:activeBcs.length,
        orphanedBcCount:orphanedBcs.length,
        prescribedHeadCount,
        seepageFaceCount,
        noFlowCount,
        drainCount:bishop.drains?.length || 0,
        activeDrainNodeCount:seepage.result?.solver?.activeSetSummary?.drains?.activeNodes || 0,
        totalDrainNodeCount:seepage.result?.solver?.activeSetSummary?.drains?.totalNodes || 0
      },
      geometry:safeClone({
        regionMode:model?.regionMode || (bishop.useCustomRegions ? 'custom' : 'auto'),
        regionCount:model?.regions?.length || (bishop.useCustomRegions ? (bishop.customRegions?.length || 0) : (bishop.materials?.length || 0)),
        autoRegionCount:model?.autoRegions?.length || 0,
        customRegionCount:model?.customRegions?.length || (bishop.customRegions?.length || 0),
        terrainVertexCount:bishop.terrain?.length || 0,
        phreaticVertexCount:bishop.phreatic?.length || 0,
        drainCount:bishop.drains?.length || 0,
        wallCount:bishop.walls?.length || 0,
        boundaryEdgeCount:boundary.length
      }),
      walls:(bishop.walls || []).map((wall, index)=>{
        const material = normalizeWallMaterial(wall.material, index, wall.id, {sourceFallback:'legacy-impermeable'});
        const endpoints = wallEndpoints(wall);
        return safeClone({
          id:wall.id || `wall-${index + 1}`,
          label:`Wall ${index + 1}`,
          head:endpoints ? endpoints.head : null,
          tip:endpoints ? endpoints.tip : null,
          x:Number.isFinite(+wall.x) ? +wall.x : null,
          yTop:Number.isFinite(+wall.yTop) ? +wall.yTop : null,
          yTip:Number.isFinite(+wall.yTip) ? +wall.yTip : null,
          passiveSide:wall.passiveSide === 'left' ? 'left' : 'right',
          material:{
            id:material.id,
            label:material.label,
            kAcross:material.kAcross,
            kAlong:material.kAlong,
            kSource:material.kSource,
            kSourceLabel:wallMaterialSourceLabel(material.kSource)
          }
        });
      }),
      drains:(bishop.drains || []).map((drain, index)=>{
        const drainId = drain.id || `drain-${index + 1}`;
        const resultDrain = (seepage.result?.drains || []).find((item)=>item?.drainId === drainId) || null;
        const activeNodes = resultDrain?.nodes?.filter((node)=>node?.isActive).length || 0;
        return safeClone({
          id:drainId,
          label:drain.label || `Drain ${index + 1}`,
          vertices:drain.vertices || [],
          vertexCount:drain.vertices?.length || 0,
          closed:!!drain.closed,
          length:drainTotalLength(drain),
          head:safeClone(drain.head || {kind:'constant', value:0}),
          gating:drain.gating || 'when-saturated',
          gatingLabel:stage6BishopDrainGatingLabel(drain.gating),
          result:resultDrain ? {
            totalInflow:resultDrain.totalInflow,
            activeNodes,
            totalNodes:resultDrain.nodes?.length || 0,
            perSegmentInflow:resultDrain.perSegmentInflow || []
          } : null
        });
      }),
      materials:(bishop.materials || []).map((mat)=>safeClone({
        id:mat.id || '',
        label:mat.label || mat.id || 'Material',
        kx:Number.isFinite(+mat.kx) ? +mat.kx : null,
        ky:Number.isFinite(+mat.ky) ? +mat.ky : null,
        kSource:mat.kSource || 'sbtn-default',
        kSourceLabel:seepageSourceLabel(mat.kSource)
      })),
      boundaryConditions:(seepage.bcs || []).map((bc, index)=>{
        const edge=edgeByKey.get(bc.edgeKey);
        return safeClone({
          id:bc.id || `bc-${index + 1}`,
          edgeKey:bc.edgeKey || '',
          edgeLabel:edgeLabelFor(bc.edgeKey, bc.anchor?.source),
          source:edge?.source || bc.anchor?.source || '',
          index:edge?.index ?? null,
          type:bc.type === 'head' ? 'head' : bc.type === 'seepage-face' ? 'seepage-face' : 'no-flow',
          typeLabel:stage6BishopSeepageBcTypeLabel(bc.type),
          head:bc.type === 'head' && Number.isFinite(+bc.head) ? +bc.head : null,
          status:bc.status === 'orphaned' ? 'orphaned' : 'active',
          length:Number.isFinite(edge?.length) ? edge.length : null,
          midpoint:safeClone(edge?.mid || bc.anchor?.mid || null)
        });
      }),
      mesh:seepage.mesh ? safeClone({
        nodes:seepage.mesh.nodes?.length || 0,
        elements:seepage.mesh.elements?.length || 0,
        cells:seepage.mesh.cells?.length || 0,
        boundaryFaces:seepage.mesh.boundaryFaces?.length || 0,
        drainEdges:[...(seepage.mesh.drainEdgesByDrain?.values?.() || [])].reduce((sum, edges)=>sum + (edges?.length || 0), 0),
        generatedMs:Number.isFinite(+seepage.mesh.generatedMs) ? +seepage.mesh.generatedMs : null
      }) : null,
      result:seepage.result ? safeClone({
        headMin:seepage.result.headMin,
        headMax:seepage.result.headMax,
        throughFlow:seepage.result.throughFlow,
        inflow:seepage.result.inflow,
        outflow:seepage.result.outflow,
        flowError:seepage.result.flowError,
        maxExitGradient:seepage.result.maxExitGradient,
        dryCellCount:seepage.result.dryCellCount,
        equipotentialLevelCount:seepage.result.equipotentialSegments?.length || 0,
        phreaticSegmentCount:seepage.result.phreaticSegments?.length || 0,
        drains:safeClone(seepage.result.drains || []),
        solver:safeClone(seepage.result.solver || null),
        timing:safeClone(seepage.result.timing || null)
      }) : null
    };
  } catch(error){
    console.error('Stage 7 seepage payload build failed:', error);
    return{
      config:safeClone({
        freeSurface:seepage.options?.freeSurface === 'iterate' ? 'iterate' : 'fixed',
        usePhreaticAsSeed:seepage.options?.usePhreaticAsSeed !== false,
        flowErrorTolerance:Math.max(+seepage.options?.flowErrorTolerance || 0.01, 0.000001),
        maxRuntimeMs:Math.max(+seepage.options?.maxRuntimeMs || 10000, 1),
        meshTargetArea:stage6BishopResolvedSeepageMeshTargetArea(bishop),
        meshTargetAreaAuto:seepage.options?.meshTargetAreaAuto !== false,
        useFemPorePressure:!!bishop.useFemPorePressure
      }),
      summary:{
        status:seepage.status || 'idle',
        solved:false,
        rejectReason:seepage.rejectReason || 'Seepage report payload could not be fully assembled.',
        explicitBcCount:(seepage.bcs || []).length,
        activeBcCount:0,
        orphanedBcCount:0,
        prescribedHeadCount:0,
        seepageFaceCount:0,
        noFlowCount:0
      },
      geometry:{
        regionMode:bishop.useCustomRegions ? 'custom' : 'auto',
        regionCount:0,
        autoRegionCount:0,
        customRegionCount:bishop.customRegions?.length || 0,
        terrainVertexCount:bishop.terrain?.length || 0,
        phreaticVertexCount:bishop.phreatic?.length || 0,
        wallCount:bishop.walls?.length || 0,
        boundaryEdgeCount:0
      },
      materials:[],
      boundaryConditions:[],
      mesh:null,
      result:null
    };
  }
}

// Deformation annex — included only when a result has been solved. The
// captured view (manual via the toolbar button, or automatic at report-build
// time when none exists) is the primary visual; the surrounding payload
// captures the analysis context so the report can be reproduced and audited.
function stage7DeformationPayload(){
  ensureStage6State();
  const stage6 = S.stage6;
  const bishop = stage6?.bishop;
  if(!bishop) return null;
  const deformation = bishop.deformation;
  if(!deformation || !deformation.result) return null;
  const result = deformation.result;
  const solver = result?.solver || {};
  const elementType = solver.elementType
    || result?.mesh?.elementType
    || deformation.options?.meshElementType
    || 't3';
  const safetyFosLower = Number.isFinite(solver.safetyFactorOfSafetyLower) ? Number(solver.safetyFactorOfSafetyLower) : null;
  const safetyFosUpper = Number.isFinite(solver.safetyFactorOfSafetyUpper) ? Number(solver.safetyFactorOfSafetyUpper) : null;
  const safetyFinalization = solver.safetyResult?.finalization || null;
  const summary = {
    analysisType: deformation.options?.analysisType || 'deformation',
    constitutiveModel: deformation.options?.constitutiveModel || 'linear-elastic',
    elementType,
    converged: solver.convergenceState === 'converged' || result?.converged === true,
    convergenceState: solver.convergenceState || null,
    loadFactor: result?.loadFactor != null ? Number(result.loadFactor) : null,
    loadFactorMeaning: result?.loadFactorMeaning || null,
    safetyStatus: solver.safetyStatus || null,
    safetyFinalizationStatus: safetyFinalization?.status || null,
    safetyFactorOfSafetyIsOpenEnded: safetyFinalization?.factorOfSafetyIsOpenEnded === true,
    safetyFactorOfSafetyLower: safetyFosLower,
    safetyFactorOfSafetyUpper: safetyFosUpper,
    safetyLoadFactor: safetyFosLower != null
      ? safetyFosLower
      : (result?.safetyLoadFactor != null ? Number(result.safetyLoadFactor) : null),
    initialPhaseConvergenceState: solver.initialPhaseConvergenceState || null,
    servicePhaseConvergenceState: solver.servicePhaseConvergenceState || null,
    iterations: solver.iterations != null
      ? Number(solver.iterations)
      : (result?.iterations != null ? Number(result.iterations) : null),
    timing: result?.timing ? safeClone(result.timing) : null,
    nodeCount: Array.isArray(result?.mesh?.nodes) ? result.mesh.nodes.length : (result?.mesh?.nodeCount ?? null),
    elementCount: Array.isArray(result?.mesh?.triangles) ? result.mesh.triangles.length : (result?.mesh?.elementCount ?? null),
    maxSettlementMm: result?.summary?.maxSettlementMm ?? null,
    maxDisplacementMm: result?.summary?.maxDisplacementMm ?? null
  };
  const manualView = bishop.capturedView?.deformation || null;
  const view = manualView
    ? safeClone(manualView)
    : stage7CaptureBishopWorkspaceView('deformation');
  if(!view) return null;
  view.source = manualView ? 'manual' : 'auto';
  return {
    config: safeClone(deformation.options || {}),
    summary,
    warnings: Array.isArray(deformation.warnings) ? safeClone(deformation.warnings) : [],
    view
  };
}

// Extend stage7CaptureBishopWorkspaceView to also support 'deformation' so the
// auto-capture fallback works for the deformation annex.
//
// (The function itself is defined further down; this comment documents the
// contract.)
function stage7CaptureCanvasImage(canvasId, {
  maxWidth=1400,
  quality=0.9,
  mimeType='image/jpeg'
} = {}){
  if(typeof document === 'undefined') return null;
  const canvas=document.getElementById(canvasId);
  if(!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) return null;
  try{
    const scale=Math.min(1, maxWidth / Math.max(canvas.width, 1));
    const out=document.createElement('canvas');
    out.width=Math.max(1, Math.round(canvas.width * scale));
    out.height=Math.max(1, Math.round(canvas.height * scale));
    const ctx=out.getContext('2d');
    if(!ctx) return null;
    ctx.fillStyle='#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(canvas, 0, 0, out.width, out.height);
    return {
      mimeType,
      width:out.width,
      height:out.height,
      dataUrl:out.toDataURL(mimeType, quality)
    };
  }catch(error){
    console.warn('Stage 7 canvas capture failed:', error);
    return null;
  }
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
  const valid = ['stability', 'seepage', 'deformation'];
  if(!valid.includes(workspace)) return;
  const image = stage7CaptureCanvasImage('stage6BishopCanvas');
  if(!image?.dataUrl){
    console.warn(`Stage 7 capture (${workspace}) failed: canvas not ready.`);
    return;
  }
  const bishop = S.stage6.bishop;
  if(!bishop.capturedView || typeof bishop.capturedView !== 'object'){
    bishop.capturedView = { stability:null, seepage:null, deformation:null };
  }
  let display = null;
  if(workspace === 'stability'){
    display = {
      selectedResult: Math.max(0, bishop.selectedResult || 0),
      methodMode: bishop.methodMode || 'bishop_spencer'
    };
  } else if(workspace === 'seepage'){
    display = safeClone(bishop.seepage?.display || null);
  } else if(workspace === 'deformation'){
    display = safeClone(bishop.deformation?.display || null);
  }
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

function stage7CaptureBishopWorkspaceView(workspace){
  if(typeof document === 'undefined') return null;
  ensureStage6State();
  const stage6=S.stage6;
  const bishop=stage6?.bishop;
  if(!stage6 || !bishop) return null;
  const targetWorkspace = workspace === 'seepage'
    ? 'seepage'
    : workspace === 'deformation'
    ? 'deformation'
    : 'stability';
  const hasContent = targetWorkspace === 'seepage'
    ? !!(bishop.seepage?.mesh && bishop.seepage?.result)
    : targetWorkspace === 'deformation'
    ? !!(bishop.deformation?.result)
    : !!(bishop.results?.allResults?.length);
  if(!hasContent) return null;

  const prevApp=stage6.app;
  const prevWorkspace=bishop.workspace;
  const switched=prevApp !== 'bishop' || prevWorkspace !== targetWorkspace;

  const syncBishopCanvas = ()=>{
    const stage6Area = document.getElementById('stage6Area');
    if(stage6.app !== 'bishop'){
      renderStage6();
      if(stage6.app === 'bishop' && stage6Area) initStage6BishopCanvas();
      return;
    }
    const canvas = document.getElementById('stage6BishopCanvas');
    if(!(canvas instanceof HTMLCanvasElement) || !stage6Area){
      renderStage6();
      if(document.getElementById('stage6BishopCanvas')) initStage6BishopCanvas();
      return;
    }
    stage6BishopCanvasState.canvas = canvas;
    stage6BishopDrawCanvas();
  };

  try{
    if(switched){
      stage6.app='bishop';
      bishop.workspace=targetWorkspace;
      syncBishopCanvas();
    }
    if(!switched) syncBishopCanvas();
    const image=stage7CaptureCanvasImage('stage6BishopCanvas');
    if(!image?.dataUrl) return null;
    return safeClone({
      workspace:targetWorkspace,
      app:'bishop',
      capturedAt:new Date().toISOString(),
      display: targetWorkspace === 'seepage'
        ? {
            contourMode:bishop.seepage?.display?.contourMode || 'head',
            showContours:bishop.seepage?.display?.showContours !== false,
            showContourLines:bishop.seepage?.display?.showContourLines !== false,
            showContourLegend:bishop.seepage?.display?.showContourLegend !== false,
            showBoundaryConditions:bishop.seepage?.display?.showBoundaryConditions !== false,
            showBoundaryLabels:bishop.seepage?.display?.showBoundaryLabels !== false,
            showPhreatic:bishop.seepage?.display?.showPhreatic !== false,
            showFlowVectors:!!bishop.seepage?.display?.showFlowVectors,
            showExitGradient:!!bishop.seepage?.display?.showExitGradient
          }
        : targetWorkspace === 'deformation'
        ? safeClone(bishop.deformation?.display || null)
        : {
            selectedResult:Math.min(Math.max(bishop.selectedResult || 0, 0), Math.max((bishop.results?.allResults?.length || 1) - 1, 0)),
            methodMode:bishop.methodMode || 'bishop_spencer'
          },
      viewport:safeClone(bishop.viewport || null),
      image
    });
  } finally {
    if(switched){
      stage6.app=prevApp;
      bishop.workspace=prevWorkspace;
      if(prevApp === 'bishop'){
        syncBishopCanvas();
      } else {
        renderStage6();
      }
    }
  }
}

function stage7Stage6Payload(workingLayers){
  const annexes={};
  if(S.stage6Cache?.bearing?.selected){
    annexes.bearing={
      config:safeClone(S.stage6.bearing),
      analysis:safeClone(S.stage6Cache.bearing)
    };
  }
  if(S.stage6Cache?.settlement?.sublayers?.length){
    annexes.settlement={
      config:safeClone(S.stage6.settlement),
      analysis:safeClone(S.stage6Cache.settlement)
    };
  }
  if(S.stage6Cache?.dewatering?.sublayers?.length || S.stage6Cache?.dewatering?.drawdownCurve?.length){
    annexes.dewatering={
      config:safeClone(S.stage6.dewatering),
      analysis:safeClone(S.stage6Cache.dewatering)
    };
  }
  if(S.stage6Cache?.beam?.sls?.xSamples?.length){
    annexes.beam={
      config:safeClone(S.stage6.beam),
      analysis:safeClone(S.stage6Cache.beam)
    };
  }
  // Pile capacity — added once the pile estimator was built (the cache is
  // populated by analyzePile in renderStage6() when app === 'pile').
  if(S.stage6Cache?.pile?.capacity){
    annexes.pile={
      config:safeClone(S.stage6.pile),
      analysis:safeClone(S.stage6Cache.pile)
    };
  }
  // Bishop / seepage / deformation each get a workspace screenshot. The user
  // can press the "Capture for report" button in the workspace toolbar at any
  // time to freeze a specific view (selected result, contour mode, viewport)
  // for the report. We prefer that manual capture; if the user never pressed
  // it, fall back to the automatic capture done here at report-build time.
  const bishop=stage7BishopPayload();
  if(bishop){
    const manualBishopView = S.stage6.bishop?.capturedView?.stability || null;
    const bishopView = manualBishopView
      ? safeClone(manualBishopView)
      : stage7CaptureBishopWorkspaceView('stability');
    if(bishopView){
      bishopView.source = manualBishopView ? 'manual' : 'auto';
      bishop.view = bishopView;
    }
    annexes.bishop=bishop;
  }
  const seepage=stage7SeepagePayload();
  if(seepage){
    const manualSeepageView = S.stage6.bishop?.capturedView?.seepage || null;
    const seepageView = manualSeepageView
      ? safeClone(manualSeepageView)
      : stage7CaptureBishopWorkspaceView('seepage');
    if(seepageView){
      seepageView.source = manualSeepageView ? 'manual' : 'auto';
      seepage.view = seepageView;
    }
    annexes.seepage=seepage;
  }
  // Deformation annex — was previously absent. Only included when a result
  // is solved AND the user has captured a view (the captured view IS the
  // deformation reporting; without a screenshot we have nothing meaningful
  // to show in the printed report at present).
  const deformation = stage7DeformationPayload();
  if(deformation){
    annexes.deformation = deformation;
  }
  const available=Object.keys(annexes);
  if(!available.length) return null;
  return{
    currentApp:S.stage6?.app || 'bearing',
    available,
    layers:safeClone(workingLayers),
    ...annexes
  };
}

function buildStage7Payload(){
  if(!S.layers.length || !S.data.length){
    alert('Run the CPT through layers and model parameters before opening the Stage 7 report.');
    return null;
  }
  ensureStage6State();
  const workingLayers=stage6WorkingLayers();
  const rawDepthMax=S.data.length ? +(S.data[S.data.length - 1].z + 0.5).toFixed(3) : stage6MaxDepth();
  const maxQc=Math.max(1, arrMax(S.data.map(r=>r.qc))) * 1.15;
  const maxFs=Math.max(10, arrMax(S.data.map(r=>r.fs != null ? r.fs * 1000 : 0))) * 1.15;
  const tuning=stage7TuningPayload();
  const layerWarnings=stage7LayerWarnings();
  const layerPayload=S.layers.map((layer, index)=>stage7WorkingLayerPayload(layer, index));
  const acceptedTuningCount=layerPayload.filter(layer=>layer.hasAcceptedTuning).length;
  const manualOverrideCount=layerPayload.reduce((sum, layer)=>{
    return sum + Object.values(layer.overrides || {}).filter(Boolean).length;
  }, 0);
  const stage6=stage7Stage6Payload(workingLayers);
  return{
    version:4,
    stage:'stage7',
    generatedAt:new Date().toISOString(),
    appVersion:'0.3.3',
    project:{
      name:PROJECT.name,
      phase:PROJECT.phase
    },
    cpt:{
      id:S.id,
      displayId:S.meta?.testid || S.id || 'CPT',
      coordinates:{
        x:S.x,
        y:S.y
      }
    },
    metadata:safeClone({
      ...S.meta,
      sourceFile:S.meta?.fname || null,
      nRows:S.meta?.nRows || S.data.length
    }),
    replication:{
      method:S.method,
      methodLabel:stage7MethodLabel(S.method),
      smartMerge:!!S.smartMerge,
      smartMergeSensitivity:+Number(S.smartMergeSensitivity ?? 1.1).toFixed(3),
      minThickness:+Number(S.minThk || 0).toFixed(3),
      parameterMethod:S.paramMethod,
      parameterMethodLabel:stage7ParamMethodLabel(S.paramMethod),
      alphaMethod:S.alphaMethod,
      alphaMethodLabel:stage7AlphaMethodLabel(S.alphaMethod),
      stiffnessMethod:S.stiffMethod,
      stiffnessMethodLabel:stage7StiffMethodLabel(S.stiffMethod),
      waterTable:S.wt,
      waterTableTaw:S.elev != null ? +(S.elev - S.wt).toFixed(2) : null,
      waterTableSource:stage7WtSourceLabel(),
      surfaceElevation:S.elev,
      surfaceElevationSource:stage7ElevSourceLabel()
    },
    summary:{
      layerCount:S.layers.length,
      depthMin:S.meta?.depthMin ?? (S.data[0]?.z || 0),
      depthMax:S.meta?.depthMax ?? (S.data[S.data.length - 1]?.z || 0),
      acceptedTuningCount,
      manualOverrideCount,
      stage6Annexes:stage6?.available || []
    },
    visuals:{
      layerColumn:{
        width:72,
        height:420,
        markup:buildLayerColumnSvgMarkup({
          layers:S.layers,
          maxDepth:rawDepthMax,
          wt:S.wt,
          width:72,
          height:420,
          emptyLabel:'No layers'
        })
      },
      layerProfile:{
        width:210,
        height:520,
        markup:buildLayerPreviewSvgMarkup({
          layers:S.layers,
          rows:S.classified?.length ? S.classified : S.data,
          wt:S.wt,
          width:210,
          height:520,
          showRf:false,
          showFs:true
        })
      }
    },
    chartInputs:{
      raw:{
        maxDepth:rawDepthMax,
        maxQc,
        maxFs
      }
    },
    rawRows:S.data.map((row)=>({
      depth:row.z,
      taw:S.elev != null ? +(S.elev - row.z).toFixed(2) : null,
      qc:row.qc,
      fsMPa:row.fs ?? null,
      fsKPa:row.fs != null ? +(row.fs * 1000).toFixed(3) : null,
      rf:row.rf ?? null,
      u2:row.u2 ?? null
    })),
    classifiedRows:(S.classified || []).map((row)=>({
      depth:row.z,
      taw:S.elev != null ? +(S.elev - row.z).toFixed(2) : null,
      qc:row.qc,
      fsKPa:row.fs != null ? +(row.fs * 1000).toFixed(3) : null,
      rf:row.rf ?? null,
      type:row.type,
      subtype:row.subtype || '',
      ic:row.Ic ?? null,
      qtOrQcNen:row.Qt ?? null
    })),
    layers:layerPayload,
    layerWarnings,
    tuning,
    stage6
  };
}

function openStage7Report(){
  const payload=buildStage7Payload();
  if(!payload || typeof window === 'undefined') return;
  const key=saveStage7Payload(window.localStorage, payload);
  if(!key){
    alert('The Stage 7 report payload could not be validated for saving.');
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
  layerTAW,
  cptDist,
  layerTypeCompatScore,
  matchScore,
  runCorrelation,
  renderCorrTable,
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
  stage6BishopSetUseCustomRegions,
  stage6BishopDeleteSelectedRegion,
  stage6BishopSetSelectedRegionMaterial,
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
