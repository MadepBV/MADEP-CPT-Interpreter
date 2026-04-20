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
/* ════════════════════════════════
   STATE
════════════════════════════════ */
let __legacyControllerInitialized = false;

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
    elev:null, elevFromFile:false,
    minThk:0.50,
    smartMerge:true,
    smartMergeSensitivity:0.50,
    method:'robertson',
    alphaMethod:'B',
    stiffMethod:'B',
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
  if(smartSensRange) smartSensRange.value=(S.smartMergeSensitivity ?? 0.5).toFixed(2);
  if(smartSensNum) smartSensNum.value=(S.smartMergeSensitivity ?? 0.5).toFixed(2);
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
    const status=cpt.layers.length?'✓':cpt.data.length?'⚡':'○';
    const statusCol=cpt.layers.length?'#1D9E75':cpt.data.length?'#BA7517':'#9a9a96';
    return`<div onclick="selectCpt(${i})" style="
        display:flex;align-items:center;gap:5px;padding:0 12px;cursor:pointer;
        border-bottom:2px solid ${isActive?'#1D9E75':'transparent'};
        background:${isActive?'var(--bg)':'transparent'};
        font-size:12px;font-weight:${isActive?'600':'400'};color:var(--tx);
        white-space:nowrap;min-height:44px;transition:.1s">
      <span style="color:${statusCol};font-size:10px">${status}</span>
      <span>${cpt.id}</span>
      ${PROJECT.cpts.length>1?`<span data-remove="${i}"
        style="color:var(--tx3);font-size:10px;margin-left:3px;cursor:pointer;padding:2px 4px;border-radius:3px" title="Verwijder CPT">✕</span>`:''}
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
/* Multi-CPT file load — reads files serially to avoid chart race conditions */
function loadGEF(evt){
  const files=Array.from(evt.target.files);
  if(!files.length)return;
  evt.target.value='';

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
    reader.onload=e=>{
      // Save current active, switch to target, parse, restore
      const prevActive=PROJECT.activeCptIdx;
      const prevS=S;
      PROJECT.activeCptIdx=targetIdx;
      S=PROJECT.cpts[targetIdx];
      parseGEF(e.target.result,f.name);
      S.id=f.name.replace(/\.gef$/i,'').replace(/\.txt$/i,'').replace(/\.GEF$/i,'');
      renderBanner();
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
    reader.readAsText(f);
  }
  loadNext(0);
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
    svg.innerHTML='<text x="20" y="40" font-size="13" fill="#9a9a96">Minimaal 2 CPTs met maaiveldshoogte vereist voor doorsnede.</text>';
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
  if(!elevAll.length){ svg.innerHTML='<text x="20" y="30" font-size="11" fill="#9a9a96">Geen data.</text>'; return; }
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

  let s='';

  // ── Ground fill (below surface, above deepest layer) ──
  s+='<rect x="0" y="0" width="'+totalW+'" height="'+totalH+'" fill="var(--bg)"/>';

  // ── Elevation grid lines ──
  const step=elevRange<=5?0.5:elevRange<=15?1:elevRange<=30?2:5;
  for(let e=Math.ceil(minElev/step)*step; e<=Math.floor(maxElev/step)*step; e=+(e+step).toFixed(4)){
    const y=py(e);
    if(y<MT||y>MT+H) continue;
    s+=`<line x1="${ML}" x2="${ML+W}" y1="${y}" y2="${y}" stroke="rgba(128,128,128,0.10)" stroke-width="0.5"/>`;
    s+=`<text x="${ML-5}" y="${y+3.5}" font-size="9" text-anchor="end" fill="#9a9a96" font-family="sans-serif">${e.toFixed(1)}</text>`;
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
      s+=`<polygon points="${topPts} ${botPts}" fill="${fill}" fill-opacity="0.80" stroke="#555" stroke-width="0.6"/>`;

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
    s+=`<line x1="${xc}" x2="${xc}" y1="${py(c.elev)}" y2="${py(toeElev)}" stroke="#666" stroke-width="0.8" stroke-dasharray="3,2"/>`;

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
      s+=`<line x1="${(xc-colW/2-5).toFixed(1)}" x2="${(xc-colW/2).toFixed(1)}" y1="${y1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="#666" stroke-width="0.6"/>`;
      // Depth label left
      if(h>12){
        const elmid=(y1+y2)/2;
        s+=`<text x="${(xc-colW/2-7).toFixed(1)}" y="${(elmid+3).toFixed(1)}" font-size="7.5" text-anchor="end" fill="#555" font-family="sans-serif">${(c.elev-l.bot).toFixed(1)}</text>`;
      }
    });

    // WT
    if(c.wt!=null){
      const wtY=py(c.elev-c.wt);
      s+=`<line x1="${(xc-18).toFixed(1)}" x2="${(xc+18).toFixed(1)}" y1="${wtY.toFixed(1)}" y2="${wtY.toFixed(1)}" stroke="#378ADD" stroke-width="2" stroke-dasharray="5,3"/>`;
    }
    // CPT label
    s+=`<text x="${xc}" y="${(MT-14).toFixed(1)}" font-size="10" text-anchor="middle" font-weight="600" fill="#333" font-family="sans-serif">${c.id}</text>`;
    s+=`<text x="${xc}" y="${(MT-4).toFixed(1)}" font-size="9" text-anchor="middle" fill="#9a9a96" font-family="sans-serif">${c.elev!=null?c.elev.toFixed(2)+' m TAW':''}</text>`;
    // Distance from start
    const d0=(c.dist-distMin).toFixed(0);
    s+=`<text x="${xc}" y="${(totalH-8).toFixed(1)}" font-size="9" text-anchor="middle" fill="#9a9a96" font-family="sans-serif">${d0}m</text>`;
  });

  // ── WT interpolated line across section ──
  const wtPts=projCpts.filter(c=>c.wt!=null&&c.elev!=null)
    .map(c=>`${px(c.dist).toFixed(1)},${py(c.elev-c.wt).toFixed(1)}`);
  if(wtPts.length>=2)
    s+=`<polyline points="${wtPts.join(' ')}" fill="none" stroke="#378ADD" stroke-width="1.8" stroke-dasharray="7,5"/>
        <text x="${(ML+10).toFixed(1)}" y="${py(projCpts.find(c=>c.wt!=null)?.elev-(projCpts.find(c=>c.wt!=null)?.wt||0)||maxElev).toFixed(1)}" font-size="9" fill="#378ADD" font-family="sans-serif">WT</text>`;

  // ── Axes labels ──
  s+=`<text x="${(ML+W/2).toFixed(1)}" y="${(totalH-6).toFixed(1)}" font-size="10" text-anchor="middle" fill="#6b6b68" font-family="sans-serif">Afstand langs doorsnede (m) — vex ×${vex}</text>`;
  s+=`<text x="12" y="${(MT+H/2).toFixed(1)}" font-size="10" text-anchor="middle" fill="#6b6b68" font-family="sans-serif" transform="rotate(-90,12,${(MT+H/2).toFixed(1)})">Hoogte (m TAW)</text>`;

  // ── Legend ──
  const legendTypes=[...new Set(PROJECT.cpts.flatMap(c=>c.layers.map(l=>l.type)))].slice(0,8);
  const lx=ML+W-140, ly=MT+10;
  s+=`<rect x="${lx-4}" y="${ly-4}" width="144" height="${legendTypes.length*17+8}" rx="4" fill="var(--bg)" fill-opacity="0.85" stroke="rgba(0,0,0,0.1)" stroke-width="0.5"/>`;
  legendTypes.forEach((t,i)=>{
    s+=`<rect x="${lx}" y="${ly+i*17}" width="10" height="10" fill="${SCFILL[t]||'#D3D1C7'}" stroke="rgba(0,0,0,0.2)" stroke-width="0.3"/>`;
    s+=`<text x="${lx+14}" y="${ly+i*17+9}" font-size="8.5" fill="#333" font-family="sans-serif">${t}</text>`;
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
const SC={
  'Peat / organic':'s-peat','Soft clay':'s-sclay','Clay':'s-clay',
  'Sandy clay':'s-sclayl','Silty sand':'s-ssand','Sand':'s-sand','Gravel':'s-gravel'
};
const SCFILL={
  'Peat / organic':'#C0DD97','Soft clay':'#B5D4F4','Clay':'#AFA9EC',
  'Sandy clay':'#FAC775','Silty sand':'#F4C0D1','Sand':'#D3D1C7','Gravel':'#F0997B'
};
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
    function toMPa(raw, unit, fallbackKind){
      if(raw==null||isNaN(raw)) return null;
      if(unit.includes('mpa')) return raw;
      if(unit.includes('kpa')) return raw/1000;
      if(unit==='pa' || unit.endsWith(' pa') || unit.startsWith('pa ')) return raw/1e6;
      if(fallbackKind==='qc'){
        return raw>100?raw/1000:raw;
      }
      if(fallbackKind==='fs'){
        if(Math.abs(raw)>1000) return raw/1e6;
        if(Math.abs(raw)>10) return raw/1000;
      }
      return raw;
    }

    const z=get(11)??get(1);   // prefer corrected depth
    const qc_v=get(2);
    const fs_v=get(3);
    const rf_v=get(4);         // % as declared
    const u2_v=get(6);

    if(z==null||qc_v==null||isNaN(z)||isNaN(qc_v)||z<0)continue;

    const qc=toMPa(qc_v, unitFor(2), 'qc');
    const fs=toMPa(fs_v, unitFor(3), 'fs');

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

  if(!rows.length){alert('No valid data rows found.');return;}

  S.data=rows;
  S.wt=wl??1.5; S.wtFromFile=wl!=null;
  S.elev=zid; S.elevFromFile=zid!=null;
  S.meta={...meta,aRatio,zid,nRows:rows.length,
    depthMin:rows[0].z,depthMax:rows[rows.length-1].z,
    hasU2:rows.some(r=>r.u2!=null)};

  // Sync controls
  document.getElementById('wtR').value=S.wt;
  document.getElementById('wtN').value=S.wt.toFixed(2);
  if(S.elev!=null){document.getElementById('elevN').value=S.elev.toFixed(2);}
  updateElevSrc(); updateWTDisplay();

  renderMeta();
  document.getElementById('s1body').style.display='block';
  requestAnimationFrame(()=>initCharts());
}

function updateElevSrc(){
  document.getElementById('elev-src').textContent=
    S.elevFromFile?'(from ZID)':S.elev!=null?'(manually set)':'(not set — enter for TAW output)';
}
function updateWTDisplay(){
  document.getElementById('wt-src').textContent=S.wtFromFile?'(MEASUREMENTVAR 14)':'(default)';
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
  updateElevSrc(); updateWTDisplay();
  // Re-render layers if they exist (TAW column changes)
  if(S.layers.length&&document.getElementById('p2').classList.contains('active'))renderLayers();
}

function setWT(v,fromInput){
  if(isNaN(v)||v<0)return;
  S.wt=v;
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

function setMinThk(v,fromInput){
  if(isNaN(v)||v<0.05)return;
  S.minThk=v;
  if(fromInput)document.getElementById('minThkR').value=v;
  else document.getElementById('minThkN').value=v.toFixed(2);
  document.getElementById('minThkInfo').textContent='';
  // If already classified, re-run layer detection and update preview
  if(S.classified.length){
    detectLayers();
    renderLayerPreviewSvg('layerPreviewSvg');
    if(document.getElementById('p2').classList.contains('active'))renderLayers();
    document.getElementById('minThkInfo').textContent=`→ ${S.layers.length} layers`;
  }
}

function setSmartMerge(v){
  S.smartMerge=!!v;
  const smartMergeControls=document.getElementById('smartMergeControls');
  if(smartMergeControls) smartMergeControls.style.display=S.smartMerge?'':'none';
  if(S.classified.length){
    detectLayers();
    renderLayerPreviewSvg('layerPreviewSvg');
    drawLayerColumnSvg('layerColSvg',S.layers,S.data[S.data.length-1]?.z+0.5||20);
    if(document.getElementById('p2').classList.contains('active'))renderLayers();
    document.getElementById('minThkInfo').textContent=`→ ${S.layers.length} layers`;
  }
}

function setSmartMergeSensitivity(v,fromInput){
  if(isNaN(v)) return;
  const val=Math.max(0,Math.min(2,+v));
  S.smartMergeSensitivity=val;
  const range=document.getElementById('smartMergeSensR');
  const num=document.getElementById('smartMergeSensN');
  if(fromInput){
    if(range) range.value=val.toFixed(2);
  }else{
    if(num) num.value=val.toFixed(2);
  }
  if(S.classified.length && S.smartMerge){
    detectLayers();
    renderLayerPreviewSvg('layerPreviewSvg');
    drawLayerColumnSvg('layerColSvg',S.layers,S.data[S.data.length-1]?.z+0.5||20);
    if(document.getElementById('p2').classList.contains('active'))renderLayers();
    document.getElementById('minThkInfo').textContent=`→ ${S.layers.length} layers`;
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
  function wtLine(xmax){return[{x:0,y:wt},{x:xmax,y:wt}];}

  function mk(id,vals,color,xmax){
    const ctx=document.getElementById(id);
    if(!ctx)return null;
    return new Chart(ctx,{
      type:'line',
      data:{datasets:[
        {label:'value',data:ptData(vals),borderColor:color,borderWidth:1.2,
          pointRadius:0,fill:false,tension:0.04,spanGaps:true},
        {label:'WT',data:wtLine(xmax),borderColor:'#378ADD',borderWidth:1.5,
          borderDash:[6,4],pointRadius:0,fill:false}
      ]},
      options:{
        responsive:true,maintainAspectRatio:false,animation:false,
        plugins:{legend:{display:false}},
        scales:{
          x:{type:'linear',min:0,max:xmax,position:'top',
            grid:{color:'rgba(128,128,128,0.07)'},
            ticks:{font:{size:10},maxTicksLimit:5}},
          y:{type:'linear',min:0,max:maxZ,reverse:true,
            grid:{color:'rgba(128,128,128,0.07)'},
            ticks:{font:{size:10}}}
        }
      }
    });
  }

  S.charts.qc=mk('cQc',qcs,'#1D9E75',maxQc);
  S.charts.fs=mk('cFs',fss,'#534AB7',maxFs);
  S.charts.rf=mk('cRf',rfs,'#D85A30',12);
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

  if(!layers.length){
    svg.innerHTML=`<text x="${W/2}" y="${H/2}" text-anchor="middle" font-size="9" fill="#9a9a96">Run\nclass.</text>`;
    return;
  }

  const zMax=layers[layers.length-1].bot||maxZ;
  const scale=v=>+(v/zMax*H).toFixed(1);
  const rects=layers.map(l=>{
    const y1=scale(l.top), y2=scale(l.bot);
    const fill=SCFILL[l.type]||'#D3D1C7';
    return`<rect x="0" y="${y1}" width="${W}" height="${Math.max(y2-y1,1)}" fill="${fill}" stroke="rgba(0,0,0,0.12)" stroke-width="0.5"/>
      <text x="${W/2}" y="${(y1+y2)/2+3}" text-anchor="middle" font-size="7" fill="rgba(0,0,0,0.55)" font-family="sans-serif">${l.type.split('/')[0].trim().split(' ')[0]}</text>`;
  }).join('');

  // WT line
  const wtY=scale(S.wt);
  const wtLine=`<line x1="0" x2="${W}" y1="${wtY}" y2="${wtY}" stroke="#378ADD" stroke-width="1.5" stroke-dasharray="4,3"/>`;

  // Depth tick labels
  const ticks=[0,2,4,6,8,10,12,14,16,18,20,22,25].filter(v=>v<=zMax);
  const tickSvg=ticks.map(v=>{
    const y=scale(v);
    return`<line x1="0" x2="4" y1="${y}" y2="${y}" stroke="rgba(0,0,0,0.3)" stroke-width="0.5"/>
      <text x="5" y="${y+3}" font-size="6" fill="#9a9a96" font-family="sans-serif">${v}</text>`;
  }).join('');

  svg.innerHTML=rects+wtLine+tickSvg;
}

/* ════════════════════════════════
   LAYER PREVIEW SVG (Stage 2 side panel)
════════════════════════════════ */
function renderLayerPreviewSvg(svgId){
  /* Renders: depth labels | soil column | qc micro-profile | Rf micro-profile
     Uses S.classified (per-reading data) for the qc/Rf curves,
     and S.layers for the color bands and labels. */
  const svg=document.getElementById(svgId);
  if(!svg||!S.layers.length)return;

  const W=240, H=520;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);

  const zMax=S.layers[S.layers.length-1].bot;
  const pad=20;
  const avail=H-2*pad;
  const sc=v=>pad+v/zMax*avail;  // depth → SVG y

  // Layout columns (x positions)
  const depthX=0;       // depth labels: 0-20
  const colX=22;        // soil color band: 22-54
  const colW=32;
  const qcX=58;         // qc sparkline: 58-118
  const qcW=60;
  const rfX=122;        // Rf sparkline: 122-162
  const rfW=40;
  const labelX=165;     // type labels: 165-240

  let html='';
  let overlaySvg='';

  // ── Column header ──
  html+=`<text x="${qcX+qcW/2}" y="12" font-size="7" text-anchor="middle" fill="#9a9a96" font-family="sans-serif">qc (MPa)</text>`;
  html+=`<text x="${rfX+rfW/2}" y="12" font-size="7" text-anchor="middle" fill="#9a9a96" font-family="sans-serif">Rf (%)</text>`;

  // ── qc and Rf range from data ──
  const data=S.classified||[];
  const qcVals=data.map(r=>r.qc).filter(v=>v>0);
  const rfVals=data.map(r=>r.rf).filter(v=>v!=null&&v>=0);
  const qcMax=qcVals.length?Math.max(...qcVals):10;
  const rfMaxVal=rfVals.length?Math.max(...rfVals):10;
  // Scale: qc 0→qcMax maps to qcW; Rf 0→rfMaxVal maps to rfW
  const scQc=v=>qcX+(v/Math.max(qcMax,0.1))*qcW;
  const scRf=v=>rfX+(v/Math.max(rfMaxVal,1))*rfW;

  // Track the original per-reading curves separately so they can be drawn
  // on top of the layer bands instead of being visually buried underneath.
  let qcPath='', rfPath='';
  if(data.length>1){
    data.forEach((r,i)=>{
      const y=sc(r.z);
      const xq=scQc(r.qc);
      qcPath+=(i===0?'M':'L')+`${xq.toFixed(1)},${y.toFixed(1)} `;
      if(r.rf!=null){
        const xr=scRf(r.rf);
        rfPath+=(rfPath===''?'M':'L')+`${xr.toFixed(1)},${y.toFixed(1)} `;
      }
    });
  }

  // Zero / origin lines and light chart guides
  html+=`<line x1="${qcX}" x2="${qcX}" y1="${pad}" y2="${H-pad}" stroke="rgba(128,128,128,0.18)" stroke-width="0.5"/>`;
  html+=`<line x1="${rfX}" x2="${rfX}" y1="${pad}" y2="${H-pad}" stroke="rgba(128,128,128,0.18)" stroke-width="0.5"/>`;
  html+=`<line x1="${qcX+qcW}" x2="${qcX+qcW}" y1="${pad}" y2="${H-pad}" stroke="rgba(128,128,128,0.07)" stroke-width="0.4"/>`;
  html+=`<line x1="${rfX+rfW}" x2="${rfX+rfW}" y1="${pad}" y2="${H-pad}" stroke="rgba(128,128,128,0.07)" stroke-width="0.4"/>`;

  // ── Draw layer bands ──
  for(const l of S.layers){
    const y1=sc(l.top), y2=sc(l.bot);
    const h=Math.max(y2-y1,1.5);
    const fill=SCFILL[l.type]||'#D3D1C7';
    const midY=(y1+y2)/2;
    const rows=data.filter(r=>r.z>=l.top&&r.z<=l.bot);
    const qcRows=rows.map(r=>r.qc).filter(v=>v!=null&&v>=0);
    const rfRows=rows.map(r=>r.rf).filter(v=>v!=null&&v>=0);
    const fsRows=rows.map(r=>r.fs!=null?r.fs*1000:null).filter(v=>v!=null);
    const esc=v=>String(v??'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // Depth label
    html+=`<text x="${depthX}" y="${y1+5}" font-size="7" fill="#9a9a96" font-family="sans-serif">${l.top.toFixed(1)}</text>`;
    // Soil color band
    html+=`<rect x="${colX}" y="${y1}" width="${colW}" height="${h}" fill="${fill}" fill-opacity="0.85" stroke="rgba(0,0,0,0.15)" stroke-width="0.5"/>`;
    html+=`<rect class="section-layer-hit" data-layer-preview="1"
      data-type="${esc(l.type)}"
      data-subtype="${esc(l.subtype||'—')}"
      data-top="${l.top.toFixed(2)}" data-bot="${l.bot.toFixed(2)}" data-thk="${(l.bot-l.top).toFixed(2)}"
      data-points="${rows.length}"
      data-qcmin="${qcRows.length?Math.min(...qcRows).toFixed(2):'—'}"
      data-qcmax="${qcRows.length?Math.max(...qcRows).toFixed(2):'—'}"
      data-qcavg="${l.avgQc.toFixed(2)}"
      data-rfmin="${rfRows.length?Math.min(...rfRows).toFixed(2):'—'}"
      data-rfmax="${rfRows.length?Math.max(...rfRows).toFixed(2):'—'}"
      data-rfavg="${l.avgRf!=null?l.avgRf.toFixed(2):'—'}"
      data-fsmin="${fsRows.length?Math.min(...fsRows).toFixed(1):'—'}"
      data-fsmax="${fsRows.length?Math.max(...fsRows).toFixed(1):'—'}"
      data-fsavg="${l.avgFs!=null?(l.avgFs*1000).toFixed(1):'—'}"
      x="${colX}" y="${y1}" width="${labelX+70-colX}" height="${h}" fill="transparent"/>`;
    // Separator line across charts
    html+=`<line x1="${colX}" x2="${labelX+70}" y1="${y1}" y2="${y1}" stroke="rgba(0,0,0,0.08)" stroke-width="0.4"/>`;

  }

  // ── Original qc and Rf data overlay (drawn LAST so it stays visible) ──
  if(qcPath){
    overlaySvg+=`<path d="${qcPath.trim()}" fill="none" stroke="rgba(53,162,235,0.95)" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  if(rfPath){
    overlaySvg+=`<path d="${rfPath.trim()}" fill="none" stroke="rgba(235,100,53,0.95)" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>`;
  }

  // Small axis-end labels to make the chart ranges easier to read at a glance.
  html+=`<text x="${qcX}" y="${H-4}" font-size="6" fill="#9a9a96" font-family="sans-serif">0</text>`;
  html+=`<text x="${qcX+qcW}" y="${H-4}" font-size="6" text-anchor="end" fill="#9a9a96" font-family="sans-serif">${qcMax.toFixed(0)}</text>`;
  html+=`<text x="${rfX}" y="${H-4}" font-size="6" fill="#9a9a96" font-family="sans-serif">0</text>`;
  html+=`<text x="${rfX+rfW}" y="${H-4}" font-size="6" text-anchor="end" fill="#9a9a96" font-family="sans-serif">${rfMaxVal.toFixed(0)}</text>`;

  // Last depth label
  const last=S.layers[S.layers.length-1];
  html+=`<text x="${depthX}" y="${sc(last.bot)+5}" font-size="7" fill="#9a9a96" font-family="sans-serif">${last.bot.toFixed(1)}</text>`;

  // WT line
  const wtY=sc(S.wt);
  html+=`<line x1="${colX-4}" x2="${rfX+rfW}" y1="${wtY}" y2="${wtY}" stroke="#378ADD" stroke-width="1.5" stroke-dasharray="4,3"/>`;
  html+=`<text x="${rfX+rfW+2}" y="${wtY+3}" font-size="6.5" fill="#378ADD" font-family="sans-serif">WT</text>`;

  svg.innerHTML=html+overlaySvg;
  // Widen the SVG container to show new width
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
  S.elev=69.97; S.elevFromFile=true;
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
    const f=e.dataTransfer.files[0]; if(!f)return;
    const r=new FileReader();r.onload=ev=>parseGEF(ev.target.result,f.name);r.readAsText(f);
  });
  dz.dataset.bound='1';
}

/* ════════════════════════════════
   METHOD SELECT
════════════════════════════════ */
function selM(m){
  S.method=m;
  document.getElementById('mRob').classList.toggle('sel',m==='robertson');
  document.getElementById('mCur').classList.toggle('sel',m==='cur3');
  document.getElementById('mNen').classList.toggle('sel',m==='nen6740');
  document.getElementById('mSB').classList.toggle('sel',m==='sb260');
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

   Implemented chart gates:
     - Peat: Rf > 4%
     - Sand: Rf < 1% and qc > 1.5 MPa
     - Silt: Rf < 2% and 0.5 ≤ qc ≤ 1.5 MPa
     - Clay: all remaining points
════════════════════════════════ */
function classCUR3(r){
  const qc = r.qc;
  const rf = r.rf != null ? r.rf : 3.0;

  if(rf > 4.0)
    return{type:'Peat / organic', subtype:'', Ic:null, Qt:null,
           g:null,gs:null,phi:null,c:null,cu:null};

  if(rf < 1.0 && qc > 1.5)
    return{type:'Sand', subtype:'CUR3 sand', Ic:null, Qt:null,
           g:null,gs:null,phi:null,c:null,cu:null};

  if(rf < 2.0 && qc >= 0.5 && qc <= 1.5)
    return{type:'Sandy clay', subtype:'CUR3 silt', Ic:null, Qt:null,
           g:null,gs:null,phi:null,c:null,cu:null};

  return{type:'Clay', subtype:'CUR3 clay', Ic:null, Qt:null,
         g:null,gs:null,phi:null,c:null,cu:null};
}

const classCUR = classCUR3;

const NEN6740_MATERIALS=[
  {subtype:'gravel, slightly silty, moderate', type:'Gravel', g:19, gs:21, phi:37.5, c:0, cu:0, rf:0.35, qcNen:25},
  {subtype:'sand, clean, stiff',               type:'Sand',   g:20, gs:22, phi:40.0, c:0, cu:0, rf:1.00, qcNen:25},
  {subtype:'sand, slightly silty, moderate',   type:'Silty sand', g:19, gs:21, phi:32.5, c:0, cu:0, rf:1.60, qcNen:15},
  {subtype:'sand, very silty, loose',          type:'Silty sand', g:19, gs:21, phi:30.0, c:0, cu:0, rf:2.20, qcNen:7},
  {subtype:'loam, very sandy, stiff',          type:'Sandy clay', g:20, gs:20, phi:35.0, c:1, cu:0, rf:2.45, qcNen:6},
  {subtype:'loam, slightly sandy, weak',       type:'Sandy clay', g:20, gs:20, phi:30.0, c:1, cu:0, rf:3.00, qcNen:3.5},
  {subtype:'clay, very sandy, stiff',          type:'Sandy clay', g:20, gs:20, phi:32.5, c:1, cu:0, rf:3.40, qcNen:4},
  {subtype:'clay, slightly sandy, moderate',   type:'Clay',   g:20, gs:20, phi:22.5, c:13, cu:0, rf:3.85, qcNen:2.8},
  {subtype:'clay, clean, stiff',               type:'Clay',   g:20, gs:20, phi:25.0, c:15, cu:0, rf:4.45, qcNen:2.3},
  {subtype:'clay, clean, weak',                type:'Clay',   g:17, gs:17, phi:17.5, c:5, cu:0, rf:5.15, qcNen:1.0},
  {subtype:'clay, organic, moderate',          type:'Clay',   g:16, gs:16, phi:15.0, c:1, cu:0, rf:6.10, qcNen:0.75},
  {subtype:'clay, organic, weak',              type:'Clay',   g:15, gs:15, phi:15.0, c:1, cu:0, rf:7.05, qcNen:0.22},
  {subtype:'peat, moderately preloaded, moderate', type:'Peat / organic', g:13, gs:13, phi:15.0, c:5, cu:0, rf:8.30, qcNen:0.06},
  {subtype:'peat, not preloaded, weak',        type:'Peat / organic', g:12, gs:12, phi:15.0, c:2.5, cu:0, rf:9.25, qcNen:0.02},
].map((entry, index)=>({
  ...entry,
  order:index,
  score: Math.log10(entry.qcNen) - 0.18 * entry.rf
}));

/* ════════════════════════════════
   CLASSIFICATION — NEN 6740 (stress dependent)

   Source: NEN 6740 chart as reproduced in D-SHEET Piling and related
   engineering manuals. The source is a 14-area semilog chart rather
   than a closed algebraic decision tree.

   The app therefore implements a transparent fixed discretisation:
     1. compute stress-corrected q_c,NEN
     2. compute chart score = log10(q_c,NEN) - 0.18 R_f
     3. choose the nearest of the 14 published material areas

   The 14 area centres are digitised from the published chart and tied
   to the representative NEN material set commonly used by software
   implementations of the rule.
════════════════════════════════ */
function classNEN6740(r){
  const rf = r.rf != null ? r.rf : 3.0;
  const {sigVeff} = stressAt(r.z, 18, 17);
  const qcNen = Math.max(0.01, r.qc * Math.pow(100 / Math.max(sigVeff, 1), 0.67));
  const score = Math.log10(qcNen) - 0.18 * rf;

  let best=NEN6740_MATERIALS[0];
  let bestDist=Infinity;
  for(const area of NEN6740_MATERIALS){
    const d=Math.abs(score-area.score);
    if(d<bestDist || (Math.abs(d-bestDist)<1e-9 && area.order<best.order)){
      best=area;
      bestDist=d;
    }
  }

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
    {l:'method',        v:{robertson:'Robertson',cur3:'CUR 3 layers',nen6740:'NEN 6740',sb260:'NEN Tabel 3'}[S.method]}
  ].map(m=>`<div class="met"><div class="met-l">${m.l}</div><div class="met-v">${m.v}</div></div>`).join('');

  const taw=z=>S.elev!=null?(S.elev-z).toFixed(2):'—';
  const previewMetric=r=>{
    if(S.method==='robertson') return r.Ic!=null ? r.Ic : '—';
    if(S.method==='nen6740') return r.Qt!=null ? r.Qt.toFixed(2) : '—';
    return '—';
  };
  document.getElementById('cbody').innerHTML=cl.map(r=>`<tr>
    <td>${r.z.toFixed(3)}</td>
    <td style="color:var(--tx2)">${taw(r.z)}</td>
    <td>${r.qc.toFixed(3)}</td>
    <td>${r.fs!=null?(r.fs*1000).toFixed(2):'—'}</td>
    <td>${r.rf!=null?r.rf.toFixed(2):'—'}</td>
    <td><span class="sb ${SC[r.type]||'s-sand'}">${r.type}</span></td>
    <td style="font-size:10px;color:var(--tx2)">${r.subtype||'—'}</td>
    <td style="color:var(--tx3)">${previewMetric(r)}</td>
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
function segmentSummary(seg){
  const r=seg.rows.filter(x=>x.qc>0.02);
  const rows=r.length?r:seg.rows;
  const top=seg._top!=null?seg._top:(seg.isFirst?0:+(seg.rows[0].z-0.02).toFixed(3));
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
    for(const seg of merged){
      const rows=seg.rows;
      const thick=segmentSummary(seg).thk;
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
    merged[i+1]._top=seg._top!=null?seg._top:(i===0?0:seg.rows[0].z-0.02);
    merged.splice(i,1);
  }
  return merged.map((s,idx)=>({...s,isFirst:idx===0}));
}

function chooseSimilarityMergeDirection(merged, i, margin){
  const seg=merged[i];
  const layer=segmentSummary(seg);
  const upSeg=i>0?merged[i-1]:null, downSeg=i<merged.length-1?merged[i+1]:null;
  const up=upSeg?segmentSummary(upSeg):null, down=downSeg?segmentSummary(downSeg):null;
  const upOuter=i>1?segmentSummary(merged[i-2]):null;
  const downOuter=i<merged.length-2?segmentSummary(merged[i+2]):null;
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
  const sens=Math.max(0,Math.min(2,sensitivity ?? 0.5));
  const pairThreshold=Math.max(0.35, 0.90 - 0.275*sens);
  const thicknessRef=SMART_SLIVER_REF;
  while(changed){
    changed=false;
    let bestIdx=-1;
    let bestScore=-Infinity;
    for(let i=0;i<merged.length-1;i++){
      const left=segmentSummary(merged[i]);
      const right=segmentSummary(merged[i+1]);
      const leftOuter=i>0?segmentSummary(merged[i-1]):null;
      const rightOuter=i<merged.length-2?segmentSummary(merged[i+2]):null;
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
  const sens=Math.max(0,Math.min(2,sensitivity ?? 0.5));
  const margin=Math.max(0.02, 0.14 - 0.08*sens);
  while(changed){
    changed=false;
    for(let i=0;i<merged.length;i++){
      const layer=segmentSummary(merged[i]);
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
  const sensitivity=Math.max(0,Math.min(2,S.smartMergeSensitivity ?? 0.5));
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

  const mergedSummaries=merged.map((seg,i)=>segmentSummary({...seg,isFirst:i===0}));
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

  // kh/kv ratio (CUR 2003-7)
  const khkv = isGranular ? 1 : 3;
  const kv_rep = +(kh_rep / khkv).toExponential(1);

  // psi_unsat (Plaxis 2D Manual)
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

  /* ── m (type default, engineer can override) ── */
  const m=l.ovr.m ? l.m_ovr
          : l.type==='Peat / organic'?1.0
          : cohesive?0.85
          : l.type==='Sandy clay'?0.65
          : 0.50;

  /* ── Eoed,ref (full cohesion-corrected formula per SB260-21-6.4.10) ── */
  const cotphi = l.phi>0 ? Math.cos(l.phi*Math.PI/180)/Math.sin(l.phi*Math.PI/180) : 0;
  const cCotPhi = l.c * cotphi;
  const ratio = Math.max((sigVeff + cCotPhi) / (pref + cCotPhi), 0.05);
  const Eoed_ref = +(Eoed_i / Math.pow(ratio, m)).toFixed(0);

  /* ── Stiffness Method A (CUR 2003-7) or B (E50 = Eoed) ── */
  let E50_ref, Eur_ref;
  if(S.stiffMethod==='B'){
    E50_ref = Eoed_ref;
    Eur_ref = +(3*Eoed_ref).toFixed(0);
  } else {
    // Method A: CUR 2003-7
    E50_ref = cohesive ? +(1.25*Eoed_ref).toFixed(0) : Eoed_ref;
    Eur_ref = +(3*E50_ref).toFixed(0);
  }

  const K0nc=+(1-Math.sin(l.phi*Math.PI/180)).toFixed(3);
  const nu=l.type==='Peat / organic'?0.45:cohesive?0.35:0.30;
  const nu_ur=0.20;
  const psi=Math.max(0,l.phi>30?Math.round(l.phi-30):0);
  const Emc=+((1+nu)*(1-2*nu)/(1-nu)*Eoed_i*1.5).toFixed(0);
  const taw=z=>S.elev!=null?(S.elev-z).toFixed(2)+'m TAW':'—';
  return{Eoed_i,Eoed_ref,E50_ref,Eur_ref,m,K0nc,nu,nu_ur,aE:+aE.toFixed(2),
    sigV:+sigV.toFixed(1),u:+u.toFixed(1),sigVeff:+sigVeff.toFixed(1),psi,Emc,
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
      'Infiltratie (effectief)':   '#1D9E75',
      'Infiltratie + buffer':      'var(--wn)',
      'Buffer (infiltratie marginaal)': '#D85A30'
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
            <tr class="key"><td>&phi;' (&deg;)</td><td>${l.phi}</td></tr>
            <tr class="key"><td>c' (kPa)</td><td>${l.c}</td></tr>
            <tr><td>&psi; (&deg;)</td><td>${h.psi}</td></tr>
            <tr><td>&gamma; / &gamma;_sat</td><td>${l.g} / ${l.gs} kN/m&sup3;</td></tr>
            ${l.type==='Soft clay'||l.type==='Clay'?`<tr><td>c_u (kPa)</td><td>${l.cu}</td></tr>`:''}
          </table>
        </div>
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

  const mDefault = l.type==='Peat / organic'?1.0
    : (l.type==='Clay'||l.type==='Soft clay'||l.type==='Peat / organic')?0.85
    : l.type==='Sandy clay'?0.65
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

function updateTuningPreviewM(i, rawValue){
  const t = S.tuning?.[i];
  if(!t||!t.fit) return;

  const parsed = Number(rawValue);
  t.previewM = parsed;

  const invalid = !isFinite(parsed) || parsed <= 0;
  const previewM = invalid ? t.fit.m_fit : parsed;
  const preview = tuningPreviewLineData(t.fit, previewM);

  const input=document.getElementById('fitPreviewInput'+i);
  if(input){
    input.style.borderColor = invalid ? '#A32D2D' : 'var(--bd2)';
    input.style.color = invalid ? '#A32D2D' : 'var(--tx)';
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
    noteEl.style.color = invalid ? '#A32D2D' : 'var(--tx2)';
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
    regChart.data.datasets[2].borderColor = invalid ? '#A32D2D' : '#1D9E75';
    regChart.data.datasets[2].borderDash = invalid ? [5,4] : (t.fit.quality==='warn'?[5,4]:[]);
    regChart.update('none');
  }

  const depCanvas=document.getElementById('tChart'+i+'d');
  const depChart=depCanvas?depCanvas._chartRef:null;
  if(depChart){
    depChart.data.datasets[3].data = preview.depthLine;
    depChart.data.datasets[3].label = 'HS preview m='+previewM.toFixed(2);
    depChart.data.datasets[3].borderColor = invalid ? '#A32D2D' : '#1D9E75';
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

    const qColor = fit.quality==='good'?'#0F6E56'
      : fit.quality==='ok'?'#BA7517'
      : fit.quality==='invalid'?'#A32D2D'
      : '#A32D2D';

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
            <span style="margin-left:6px;color:#534AB7">─ default</span>
            <span style="margin-left:4px;color:#1D9E75">─ preview</span>
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
            <span style="margin-left:6px;color:#534AB7">─ default m=${m_def.toFixed(2)}</span>
            <span style="margin-left:4px;color:#1D9E75">─ preview m=${previewM.toFixed(2)}</span>
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
            <tr><td colspan="2" style="font-size:10px;font-weight:600;color:#1D9E75;padding:4px 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);text-transform:uppercase">Auto-fit</td></tr>
            <tr><td>m</td><td style="color:#0F6E56;font-weight:700">${fit.m_fit.toFixed(3)}</td></tr>
            <tr><td>E_oed,ref</td><td style="color:#0F6E56;font-weight:600">${fit.Eoed_ref_fit.toLocaleString()} kPa</td></tr>
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
            ?`<div style="font-size:11px;color:#0F6E56;font-weight:600;margin-bottom:8px">✓ Huidige override m = ${l.m_ovr.toFixed(3)}</div>`
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
        const chart = new Chart(canvas,{
          type:'scatter',
          data:{datasets:[
            {label:'CPT data', data:scatter,
             backgroundColor:'rgba(53,162,235,0.55)', pointRadius:3, pointHoverRadius:5},
            {label:'Default m='+mDef, data:defLine,
             type:'line', borderColor:'#534AB7', borderWidth:1.5, pointRadius:0, fill:false},
            {label:'Preview m='+mFit, data:fitLine,
             type:'line', borderColor:invalidSlope?'#A32D2D':'#1D9E75', borderWidth:2, pointRadius:0, fill:false,
             borderDash: (el.dataset.quality==='warn'||invalidSlope)?[5,4]:[]}
          ]},
          options:{
            responsive:true, maintainAspectRatio:false, animation:false,
            plugins:{legend:{display:false}},
            scales:{
              x:{title:{display:true, text:"ln(σ'v0 stress ratio)", font:{size:10}},
                 grid:{color:'rgba(128,128,128,0.07)'}, ticks:{font:{size:10}}},
              y:{title:{display:true, text:'ln(E_oed,i)', font:{size:10}},
                 grid:{color:'rgba(128,128,128,0.07)'}, ticks:{font:{size:10}}}
            }
          }
        });
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

        // x-axis max: round up to next 5000
        const allE = [...EoedI, ...hsDefault, ...hsFit];
        const xMax = Math.ceil(Math.max(...allE) / 5000) * 5000;

        // CPT scatter: {x: Eoed_i, y: depth}
        const scatterDep = depths.map((z,i)=>({x:EoedI[i], y:z}));
        // HS lines: {x: Eoed(z), y: depth}
        const defDep = depths.map((z,i)=>({x:hsDefault[i], y:z}));
        const fitDep = depths.map((z,i)=>({x:hsFit[i],     y:z}));
        // WT annotation line
        const wtLine = [{x:0,y:wt},{x:xMax,y:wt}];
        // Layer boundary lines
        const topLine = [{x:0,y:layerTop},{x:xMax,y:layerTop}];
        const botLine = [{x:0,y:layerBot},{x:xMax,y:layerBot}];

        const yMin = Math.max(0, layerTop - 0.5);
        const yMax = layerBot + 0.5;

        const chart = new Chart(canvasD,{
          type:'scatter',
          data:{datasets:[
            // Layer boundary shading — draw as area between top and bot
            {label:'layer',
             data:[{x:0,y:layerTop},{x:xMax,y:layerTop},{x:xMax,y:layerBot},{x:0,y:layerBot}],
             type:'line', fill:true,
             backgroundColor:'rgba(200,200,200,0.10)',
             borderWidth:0, pointRadius:0, showLine:false},
            // CPT-derived Eoed,i points
            {label:'E_oed,i (CPT)', data:scatterDep,
             backgroundColor:'rgba(53,162,235,0.5)',
             pointRadius:2.5, pointHoverRadius:5},
            // Default HS model curve
            {label:'HS default m='+mDef, data:defDep,
             type:'line', borderColor:'#534AB7', borderWidth:1.5,
             pointRadius:0, fill:false, tension:0.3},
            // Fitted HS model curve
            {label:'HS preview m='+mFit, data:fitDep,
             type:'line', borderColor:invalidSlope?'#A32D2D':'#1D9E75', borderWidth:2.5,
             pointRadius:0, fill:false, tension:0.3,
             borderDash: (el.dataset.quality==='warn'||invalidSlope)?[5,4]:[]},
            // Water table
            {label:'WT', data:wtLine,
             type:'line', borderColor:'#378ADD', borderWidth:1.5,
             borderDash:[6,4], pointRadius:0, fill:false},
            // Layer top/bot dashes
            {label:'top', data:topLine,
             type:'line', borderColor:'rgba(0,0,0,0.25)', borderWidth:1,
             borderDash:[3,3], pointRadius:0, fill:false},
            {label:'bot', data:botLine,
             type:'line', borderColor:'rgba(0,0,0,0.25)', borderWidth:1,
             borderDash:[3,3], pointRadius:0, fill:false},
          ]},
          options:{
            responsive:true, maintainAspectRatio:false, animation:false,
            plugins:{legend:{display:false},
              tooltip:{callbacks:{
                label: ctx=>{
                  if(ctx.dataset.label==='WT') return 'WT = '+wt.toFixed(2)+' m';
                  return ctx.dataset.label+': '+Math.round(ctx.parsed.x).toLocaleString()+' kPa @ '+ctx.parsed.y.toFixed(2)+'m';
                }
              }}
            },
            scales:{
              x:{type:'linear', min:0, max:xMax, position:'top',
                 title:{display:true, text:'E_oed (kPa)', font:{size:10}},
                 grid:{color:'rgba(128,128,128,0.07)'}, ticks:{font:{size:10}, maxTicksLimit:5}},
              y:{type:'linear', min:yMin, max:yMax, reverse:true,
                 title:{display:true, text:'Diepte (m)', font:{size:10}},
                 grid:{color:'rgba(128,128,128,0.07)'}, ticks:{font:{size:10}}}
            }
          }
        });
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
    bearing:{
      foundationType:'strip',
      B:1.50,
      L:1.50,
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
    beam:{
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
      kh:k.kh_rep,
      kv:k.kv_rep,
      nu_ur:h.nu_ur
    };
  });
}

function stage6MaxDepth(){
  return S.layers.length ? S.layers[S.layers.length-1].bot : 10;
}

function ensureStage6State(){
  if(!S.stage6) S.stage6 = stage6Defaults();
  stage6Merge(S.stage6, stage6Defaults());
  if(!S.stage6Cache) S.stage6Cache = {};
  const maxDepth = Math.max(stage6MaxDepth(), 0.5);
  S.stage6.bearing.Df = Math.min(Math.max(+S.stage6.bearing.Df || 0.2, 0.2), maxDepth);
  S.stage6.settlement.Df = Math.min(Math.max(+S.stage6.settlement.Df || 0.0, 0.0), maxDepth);
  S.stage6.dewatering.targetWt = Math.min(Math.max(+S.stage6.dewatering.targetWt || (S.wt + 0.5), S.wt), Math.max(S.wt, maxDepth-0.2));
  S.stage6.beam.Df = Math.min(Math.max(+S.stage6.beam.Df || 0.0, 0.0), maxDepth);
  S.stage6.beam.zInfluence = Math.max(+S.stage6.beam.zInfluence || 1, 0.5);
  S.stage6.beam.gpEta = Math.max(+S.stage6.beam.gpEta || 1.0, 0);
  if(S.stage6.beam.gpOverride != null && S.stage6.beam.gpOverride !== ''){
    S.stage6.beam.gpOverride = +S.stage6.beam.gpOverride;
  } else {
    S.stage6.beam.gpOverride = null;
  }
  if(S.stage6.beam.cNomOverride != null && S.stage6.beam.cNomOverride !== ''){
    S.stage6.beam.cNomOverride = +S.stage6.beam.cNomOverride;
  }
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
  S.stage6.app = app;
  renderStage6();
}

function layerAtDepth(z, layers){
  const arr = layers || stage6WorkingLayers();
  if(!arr.length) return null;
  return arr.find(l=>z >= l.top && z < l.bot) || arr[arr.length-1];
}

function stage6ShapeFactors(type){
  if(type === 'footing') return {sc:1.2, sq:1.1, sg:0.6, scu:1.2};
  if(type === 'slab') return {sc:1.3, sq:1.2, sg:0.8, scu:1.3};
  return {sc:1.0, sq:1.0, sg:1.0, scu:1.0};
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
    const color = note.level === 'warn' ? 'var(--wn)' : note.level === 'error' ? '#D85A30' : 'var(--ac)';
    const bg = note.level === 'warn' ? 'var(--wnl)' : 'var(--bg2)';
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
    uniform_full:'Uniform full length loads the whole strip equally. This is useful for settlement-style screening, but it can legitimately give almost zero bending moment because the strip settles nearly uniformly on the soil springs.',
    uniform_patch:'Uniform patch is the better choice when you want bending from a wall strip, machine strip, loaded zone, or any local area load on the slab/beam.',
    point_centre:'Point load at centre is a localised strip/beam check. Use it for a concentrated reaction or local heavy point action applied at midspan.',
    point_at_x:'Point load at x is the same localised check, but at a chosen position along the strip so you can inspect edge-near or eccentric loading.'
  };
  return text[selected] || text.uniform_full;
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
    text:'Bearing capacity is shown as a shallow-foundation screening curve using the interpreted layer active at each founding depth. Layered failure mechanisms and eccentric loading are not modeled here.'
  }];
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
  const shp = stage6ShapeFactors(cfg.foundationType);
  const B = Math.max(cfg.B || 0.1, 0.1);
  const phiK = Math.max(l.phi || 0, 0);
  const cK = Math.max(l.c || 0, 0);
  const cuK = Math.max(l.cu || 0, 0);
  const useEc7 = stage6UsesEc7Factors(cfg);
  const gammaEff = z <= S.wt ? l.g : Math.max((l.gs || l.g) - stage6Constants().gammaW, 1.0);
  const qDrain = Math.max(stress.sigmaEff, 0);
  const qUndrain = Math.max(stress.sigmaV, 0);
  const factor = stage6FactorValue(cfg);
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
      const Ng = phiD > 0 ? Math.max(0, 2 * (Nq + 1) * tanPhi) : 0;
      const qultDrained = Math.max(0, cD * Nc * shp.sc + qDrain * Nq * shp.sq + 0.5 * gammaEff * B * Ng * shp.sg);
      const qultUndrained = Math.max(0, qUndrain + 5.14 * cuD * shp.scu);
      const qdDrained = qultDrained / factor;
      const qdUndrained = qultUndrained / factor;
      return {
        ...spec,
        phiD, cD, cuD, Nq, Nc, Ng, qultDrained, qultUndrained, qdDrained, qdUndrained
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
    const Ng = phiD > 0 ? Math.max(0, 2 * (Nq + 1) * tanPhi) : 0;
    const qultDrained = Math.max(0, cD * Nc * shp.sc + qDrain * Nq * shp.sq + 0.5 * gammaEff * B * Ng * shp.sg);
    const qultUndrained = Math.max(0, qUndrain + 5.14 * cuD * shp.scu);
    drainedCalc = undrainedCalc = {
      label:'Global SF',
      soilSet:'M1',
      gammaMphi:1,
      gammaMc:1,
      gammaMcu:1,
      phiD, cD, cuD, Nq, Nc, Ng, qultDrained, qultUndrained,
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
    Nc:+drainedCalc.Nc.toFixed(3),
    Nq:+drainedCalc.Nq.toFixed(3),
    Ng:+drainedCalc.Ng.toFixed(3),
    sc:+shp.sc.toFixed(2),
    sq:+shp.sq.toFixed(2),
    sg:+shp.sg.toFixed(2),
    scu:+shp.scu.toFixed(2),
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
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:#1D9E75;padding:4px 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);text-transform:uppercase">Drained</td></tr>
      ${sel.useEc7 ? `<tr><td>Governing combo</td><td>${sel.drainedComboLabel}</td></tr>` : ''}
      <tr><td>q_ult</td><td>${sel.qultDrained.toLocaleString()} kPa</td></tr>
      <tr><td>${sel.capacityLabel}</td><td>${sel.qdDrained.toLocaleString()} kPa</td></tr>
      <tr><td>utilisation</td><td>${sel.utilDrained!=null?sel.utilDrained.toFixed(2):'—'}</td></tr>
      <tr><td colspan="2" style="font-size:10px;font-weight:600;color:#D85A30;padding:4px 0;border-top:1px solid var(--bd);border-bottom:1px solid var(--bd);text-transform:uppercase">Undrained</td></tr>
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
      </table>
      <div style="margin-top:8px;font-size:11px;color:var(--tx2);line-height:1.5">
        Characteristic soil parameters are used directly. The global/system factor ξ is applied on the output resistance only and is not combined with γ_R or γ_M.
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
    <div style="font-size:10px;font-weight:700;color:#1D9E75;text-transform:uppercase;margin-bottom:6px">Drained formula at selected depth</div>
    <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
      q_ult,d = c'·N_c·s_c + q'·N_q·s_q + 0.5·γ'·B·N_γ·s_γ
    </div>
    <div style="font-size:11px;color:var(--tx2);line-height:1.55">
      φ'k = <strong>${sel.phiK.toFixed(1)}°</strong>${sel.useEc7?` → φ'd = <strong>${sel.phiD.toFixed(1)}°</strong>`:''}<br>
      c'k = <strong>${sel.cK.toFixed(1)} kPa</strong>${sel.useEc7?` → c'd = <strong>${sel.cD.toFixed(1)} kPa</strong>`:''}<br>
      N_c = <strong>${sel.Nc.toFixed(3)}</strong><br>
      N_q = <strong>${sel.Nq.toFixed(3)}</strong><br>
      N_γ = <strong>${sel.Ng.toFixed(3)}</strong><br>
      q' = σ'v = <strong>${sel.qDrain.toFixed(1)} kPa</strong><br>
      γ' = <strong>${sel.gammaEff.toFixed(2)} kN/m³</strong><br>
      ${sel.useEc7 ? `Governing Belgian combo = <strong>${sel.drainedComboLabel}</strong><br>` : ''}
      B = <strong>${sel.B.toFixed(2)} m</strong><br>
      s_c = <strong>${sel.sc.toFixed(2)}</strong>, s_q = <strong>${sel.sq.toFixed(2)}</strong>, s_γ = <strong>${sel.sg.toFixed(2)}</strong><br>
      ${sel.factorLabel} = <strong>${sel.factor.toFixed(2)}</strong><br>
      ${sel.capacityLabel} = q_ult,d / ${sel.factorLabel} = <strong>${sel.qdDrained.toLocaleString()} kPa</strong>
    </div>
  `;
}

function stage6BearingUndrainedFormulaHtml(sel){
  return `
    <div style="font-size:10px;font-weight:700;color:#D85A30;text-transform:uppercase;margin-bottom:6px">Undrained formula at selected depth</div>
    <div style="font-family:monospace;font-size:12px;color:var(--tx);margin-bottom:8px">
      q_ult,u = q + 5.14·c_u·s_cu
    </div>
    <div style="font-size:11px;color:var(--tx2);line-height:1.55">
      q = σv = <strong>${sel.qUndrain.toFixed(1)} kPa</strong><br>
      cu,k = <strong>${sel.cuK.toFixed(1)} kPa</strong>${sel.useEc7?` → cu,d = <strong>${sel.cuD.toFixed(1)} kPa</strong>`:''}<br>
      N_cu = <strong>5.14</strong><br>
      ${sel.useEc7 ? `Governing Belgian combo = <strong>${sel.undrainedComboLabel}</strong><br>` : ''}
      s_cu = <strong>${sel.scu.toFixed(2)}</strong><br>
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

function stage6CardsHtml(app){
  const cards = [
    {id:'bearing', title:'Bearing capacity', desc:'Drained and undrained shallow-foundation resistance vs founding depth.'},
    {id:'settlement', title:'Settlement', desc:'SLS settlement from CPT-derived E_oed with Boussinesq or 2:1 stress spread.'},
    {id:'dewatering', title:'Dewatering', desc:'Analytical drawdown screening plus induced stress change and settlement at the CPT.'},
    {id:'beam', title:'Beam / slab on Winkler', desc:'1D strip-on-elastic-foundation screening with EC2 reinforcement output.'}
  ];
  return `
    <div class="mcards" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:14px">
      ${cards.map(c=>`<div class="mc ${c.id===app?'sel':''}" onclick="setStage6App('${c.id}')">
        <h3>${c.title}</h3><p>${c.desc}</p>
      </div>`).join('')}
    </div>
  `;
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
            <span style="margin-left:6px;color:#1D9E75">- drained</span>
            <span style="margin-left:4px;color:#D85A30">- undrained</span>
            <span style="margin-left:4px;color:#378ADD">- selected Df</span>
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
  const loadRows = [
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
            <div class="st6-help" style="margin-bottom:2px">Hover the <strong>ⓘ</strong> icons for how to use each modelling input. This module is best used as a <strong>1 m strip screening tool</strong>, not as a final 2D slab design model.</div>
            <label style="font-size:11px;color:var(--tx2)">Soil width B for ks (m)${stage6Tooltip('B is the characteristic loaded width used in the subgrade-reaction calculation k_s. For a strip footing, beam, or 1 m slab strip, start with the real loaded width bearing on soil. For a full slab, B is often a screening width rather than the whole slab plan dimension.')}
              <input type="number" step="0.1" min="0.1" value="${cfg.B.toFixed(2)}" onchange="setStage6Field('beam.B', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Beam / strip width b (m)${stage6Tooltip('b is the structural strip width used for the beam stiffness and line-foundation coupling. For slab screening, keep b = 1.0 m so the output stays in kNm/m and mm2/m.')}
              <input type="number" step="0.1" min="0.1" value="${cfg.b.toFixed(2)}" onchange="setStage6Field('beam.b', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Length L (m)${stage6Tooltip('L is the strip length in the direction you want to analyse. For a slab, run the tool separately in the two principal strip directions if you want a first screening comparison.')}
              <input type="number" step="0.1" min="0.5" value="${cfg.L.toFixed(2)}" onchange="setStage6Field('beam.L', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
            </label>
            <label style="font-size:11px;color:var(--tx2)">Thickness h (m)${stage6Tooltip('h is the concrete member thickness used in the strip stiffness EI and in the reinforcement effective depth d. Increasing h strongly increases stiffness and usually reduces deflection and required steel.')}
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
                <label style="font-size:11px;color:var(--tx2)">Permanent load Gk (${analysis.slsLoadMeta.units})
                  <input type="number" step="1" min="0" value="${cfg.Gk.toFixed(1)}" onchange="setStage6Field('beam.Gk', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Leading variable load Qk (${analysis.slsLoadMeta.units})
                  <input type="number" step="1" min="0" value="${cfg.QLead.toFixed(1)}" onchange="setStage6Field('beam.QLead', this.value)" style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%">
                </label>
                <label style="font-size:11px;color:var(--tx2)">Other variable loads together (${analysis.slsLoadMeta.units})
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
              <label style="font-size:11px;color:var(--tx2);display:flex;align-items:center;gap:8px"><input type="checkbox" ${cfg.isSlabOrPlate?'checked':''} onchange="setStage6Field('beam.isSlabOrPlate', this.checked)">slab / plate member</label>
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
            <tr><td>M_Ed,max</td><td>${Math.abs(analysis.uls.maxMoment.value).toFixed(2)} kNm/m</td></tr>
            <tr><td>Exposure</td><td>${reinf.durability.exposureClass}</td></tr>
            <tr><td>Structural class</td><td>S${reinf.structuralClass}</td></tr>
            <tr><td>c_nom</td><td>${reinf.cNom.toFixed(0)} mm</td></tr>
            <tr><td>As,req</td><td>${reinf.AsReq!=null?reinf.AsReq.toFixed(0):'—'} mm²/m</td></tr>
            <tr><td>As,min</td><td>${reinf.AsMin.toFixed(0)} mm²/m</td></tr>
            <tr><td>As,governing</td><td>${reinf.As.toFixed(0)} mm²/m</td></tr>
          </table>
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
            ULS design moment = <strong>${Math.abs(analysis.uls.maxMoment.value).toFixed(2)} kNm/m</strong><br>
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

function renderStage6(){
  ensureStage6State();
  stage6RememberDetailsState();
  const el = document.getElementById('stage6Area');
  if(!el) return;
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
  } else if(app === 'settlement'){
    const analysis = analyzeSettlement(layers, S.wt, S.stage6.settlement);
    S.stage6Cache.settlement = analysis;
    body = renderStage6SettlementApp(analysis);
  } else if(app === 'dewatering'){
    const analysis = analyzeDewatering(layers, S.wt, S.stage6.dewatering);
    S.stage6Cache.dewatering = analysis;
    body = renderStage6DewateringApp(analysis);
  } else {
    const analysis = analyzeBeamAndReinforcement(layers, S.wt, S.stage6.beam);
    S.stage6Cache.beam = analysis;
    body = renderStage6BeamApp(analysis);
  }
  el.innerHTML = `${stage6CardsHtml(app)}${stage6SharedBanner()}${body}`;
  requestAnimationFrame(()=>{
    if(app === 'bearing') buildStage6BearingChart();
    if(app === 'settlement') buildStage6SettlementCharts();
    if(app === 'dewatering') buildStage6DewateringCharts();
    if(app === 'beam') buildStage6BeamCharts();
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
  const drained = data.drained;
  const undrained = data.undrained;
  const xMax = Math.max(50, Math.ceil(Math.max(...drained.map(p=>p.x||0), ...undrained.map(p=>p.x||0)) / 50) * 50);
  const datasets = [];
  if(cfg.showMode !== 'undrained') datasets.push({label:'Drained', data:drained, borderColor:'#1D9E75', borderWidth:2.4, pointRadius:0, fill:false, tension:0.15});
  if(cfg.showMode !== 'drained') datasets.push({label:'Undrained', data:undrained, borderColor:'#D85A30', borderWidth:2.4, pointRadius:0, fill:false, tension:0.15});
  datasets.push({label:'Selected Df', data:[{x:0,y:cfg.Df},{x:xMax,y:cfg.Df}], borderColor:'#378ADD', borderWidth:1.5, borderDash:[6,4], pointRadius:0, fill:false});
  const chart = new Chart(canvas,{
    type:'line',
    data:{datasets},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      plugins:{legend:{display:false}, tooltip:{callbacks:{label:ctx=>ctx.dataset.label === 'Selected Df' ? `Df = ${cfg.Df.toFixed(2)} m` : `${ctx.dataset.label}: ${Math.round(ctx.parsed.x).toLocaleString()} kPa @ ${ctx.parsed.y.toFixed(2)} m`}}},
      scales:{
        x:{type:'linear', min:0, max:xMax, position:'top', title:{display:true,text:(stage6CapacityLabel(cfg)==='q_d'?'Design bearing capacity q_d (kPa)':'Allowable bearing capacity q_allow (kPa)'),font:{size:10}}, grid:{color:'rgba(128,128,128,0.07)'}, ticks:{font:{size:10}}},
        y:{type:'linear', min:0, max:data.maxDepth + 0.25, reverse:true, title:{display:true,text:'Founding depth (m)',font:{size:10}}, grid:{color:'rgba(128,128,128,0.07)'}, ticks:{font:{size:10}}}
      }
    }
  });
  canvas._chartRef = chart;
}

function buildStage6SettlementCharts(){
  const analysis = S.stage6Cache?.settlement;
  if(!analysis || typeof Chart === 'undefined') return;
  const stressCanvas = stage6DestroyChart('stage6SettlementStressChart');
  if(stressCanvas){
    stressCanvas._chartRef = new Chart(stressCanvas,{
      type:'line',
      data:{datasets:[{label:'Delta sigma_v', data:analysis.deltaStressCurve, borderColor:'#1D9E75', borderWidth:2.2, pointRadius:0, tension:0.15, fill:false}]},
      options:{responsive:true, maintainAspectRatio:false, animation:false, plugins:{legend:{display:false}}, scales:{x:{type:'linear', position:'top', title:{display:true,text:'Delta sigma_v (kPa)',font:{size:10}}, ticks:{font:{size:10}}}, y:{type:'linear', reverse:true, min:0, max:stage6MaxDepth()+0.25, title:{display:true,text:'Depth (m)',font:{size:10}}, ticks:{font:{size:10}}}}}
    });
  }
  const cumCanvas = stage6DestroyChart('stage6SettlementCumulativeChart');
  if(cumCanvas){
    cumCanvas._chartRef = new Chart(cumCanvas,{
      type:'line',
      data:{datasets:[{label:'Cumulative S', data:analysis.cumulativeCurve, borderColor:'#378ADD', borderWidth:2.2, pointRadius:0, tension:0.12, fill:false}]},
      options:{responsive:true, maintainAspectRatio:false, animation:false, plugins:{legend:{display:false}}, scales:{x:{type:'linear', position:'top', title:{display:true,text:'Cumulative settlement (mm)',font:{size:10}}, ticks:{font:{size:10}}}, y:{type:'linear', reverse:true, min:0, max:analysis.truncationDepth + 0.25, title:{display:true,text:'Depth (m)',font:{size:10}}, ticks:{font:{size:10}}}}}
    });
  }
  const timeCanvas = stage6DestroyChart('stage6SettlementTimeChart');
  if(timeCanvas && analysis.timeCurve){
    timeCanvas._chartRef = new Chart(timeCanvas,{
      type:'line',
      data:{datasets:[{label:'S(t)', data:analysis.timeCurve, borderColor:'#D85A30', borderWidth:2.2, pointRadius:0, fill:false, tension:0.15}]},
      options:{responsive:true, maintainAspectRatio:false, animation:false, plugins:{legend:{display:false}}, scales:{x:{type:'linear', title:{display:true,text:'Time (days)',font:{size:10}}, ticks:{font:{size:10}}}, y:{type:'linear', title:{display:true,text:'Settlement (mm)',font:{size:10}}, ticks:{font:{size:10}}}}}
    });
  }
}

function buildStage6DewateringCharts(){
  const analysis = S.stage6Cache?.dewatering;
  if(!analysis || typeof Chart === 'undefined') return;
  const drawCanvas = stage6DestroyChart('stage6DewateringDrawdownChart');
  if(drawCanvas){
    const profile = analysis.drawdownDisplayCurve?.length ? analysis.drawdownDisplayCurve : analysis.drawdownCurve;
    const influenceX = Math.max(analysis.radiusInfluence || 0, analysis.geometry.distanceToCpt || 0, 1);
    const maxX = influenceX * 1.1;
    const minRelevantY = Math.min(
      S.wt,
      analysis.targetWt,
      analysis.newWtAtCpt,
      ...profile.map(p=>p.y ?? S.wt)
    );
    const maxRelevantY = Math.max(
      S.wt,
      analysis.targetWt,
      analysis.newWtAtCpt,
      ...profile.map(p=>p.y ?? S.wt)
    );
    const yPad = Math.max((maxRelevantY - minRelevantY) * 0.1, 0.15);
    const minY = Math.max(0, minRelevantY - yPad);
    const maxY = maxRelevantY + yPad;
    const originalLine = [{x:0,y:S.wt},{x:maxX,y:S.wt}];
    const influenceLine = analysis.radiusInfluence > 0 ? [{x:analysis.radiusInfluence,y:0},{x:analysis.radiusInfluence,y:maxY}] : [];
    drawCanvas._chartRef = new Chart(drawCanvas,{
      type:'line',
      data:{datasets:[
        {label:'Original WT', data:originalLine, borderColor:'rgba(107,107,104,.50)', borderWidth:1.3, borderDash:[5,4], pointRadius:0, fill:false},
        {label:'WT profile', data:profile, borderColor:'#378ADD', backgroundColor:'rgba(55,138,221,.12)', borderWidth:2.4, pointRadius:0, tension:0, fill:'-1'},
        {label:'Influence radius', data:influenceLine, borderColor:'rgba(29,158,117,.45)', borderWidth:1.2, borderDash:[4,4], pointRadius:0, fill:false},
        {label:'CPT location', data:[{x:analysis.geometry.distanceToCpt || 0,y:0},{x:analysis.geometry.distanceToCpt || 0,y:maxY}], borderColor:'rgba(216,90,48,.55)', borderWidth:1.4, borderDash:[6,4], pointRadius:0, fill:false},
        {label:'Target head at source', data:[{x:0,y:analysis.targetWt}], borderColor:'#1D9E75', pointRadius:4, pointHoverRadius:4, showLine:false},
        {label:'WT at CPT', data:[{x:analysis.geometry.distanceToCpt || 0,y:analysis.newWtAtCpt}], borderColor:'#D85A30', pointRadius:4, pointHoverRadius:4, showLine:false}
      ]},
      options:{
        responsive:true,
        maintainAspectRatio:false,
        animation:false,
        interaction:{mode:'nearest', intersect:false},
        plugins:{
          legend:{display:false},
          tooltip:{
            filter:(ctx)=>ctx.dataset.label === 'WT profile' || ctx.dataset.label === 'WT at CPT' || ctx.dataset.label === 'Target head at source',
            callbacks:{
              label:(ctx)=>{
                if(ctx.dataset.label === 'WT at CPT'){
                  return `WT at CPT: ${ctx.parsed.y.toFixed(2)} m @ ${ctx.parsed.x.toFixed(2)} m`;
                }
                if(ctx.dataset.label === 'Target head at source'){
                  return `Installed target head: ${ctx.parsed.y.toFixed(2)} m @ source`;
                }
                return `WT depth: ${ctx.parsed.y.toFixed(2)} m @ ${ctx.parsed.x.toFixed(2)} m`;
              }
            }
          }
        },
        scales:{
          x:{type:'linear', min:0, max:maxX, title:{display:true,text:analysis.geometry.geometry === 'line_dewatering_trench' ? 'Perpendicular distance from trench (m)' : 'Distance from source / centroid (m)',font:{size:10}}, grid:{color:'rgba(128,128,128,0.07)'}, ticks:{font:{size:10}}},
          y:{type:'linear', reverse:true, min:minY, max:maxY, title:{display:true,text:'Phreatic level depth below ground (m)',font:{size:10}}, ticks:{font:{size:10}}}
        }
      }
    });
  }
  const stressCanvas = stage6DestroyChart('stage6DewateringStressChart');
  if(stressCanvas){
    stressCanvas._chartRef = new Chart(stressCanvas,{
      type:'line',
      data:{datasets:[
        {label:'sigma_v before', data:analysis.beforeTotalStressCurve, borderColor:'rgba(107,107,104,.60)', borderWidth:1.2, borderDash:[5,4], pointRadius:0, fill:false},
        {label:'sigma_v after', data:analysis.afterTotalStressCurve, borderColor:'rgba(29,158,117,.55)', borderWidth:1.2, borderDash:[5,4], pointRadius:0, fill:false},
        {label:'sigma_eff before', data:analysis.beforeStressCurve, borderColor:'#6b6b68', borderWidth:2, pointRadius:0, fill:false},
        {label:'sigma_eff after', data:analysis.afterStressCurve, borderColor:'#1D9E75', borderWidth:2, pointRadius:0, fill:false},
        {label:'Delta sigma', data:analysis.deltaStressCurve, borderColor:'#D85A30', borderWidth:1.6, pointRadius:0, fill:false}
      ]},
      options:{responsive:true, maintainAspectRatio:false, animation:false, plugins:{legend:{display:false}}, scales:{x:{type:'linear', position:'top', title:{display:true,text:'Total stress, effective stress, and increase (kPa)',font:{size:10}}, ticks:{font:{size:10}}}, y:{type:'linear', reverse:true, min:0, max:stage6MaxDepth()+0.25, title:{display:true,text:'Depth (m)',font:{size:10}}, ticks:{font:{size:10}}}}}
    });
  }
  const setCanvas = stage6DestroyChart('stage6DewateringSettlementChart');
  if(setCanvas){
    setCanvas._chartRef = new Chart(setCanvas,{
      type:'line',
      data:{datasets:[
        {label:'Total settlement', data:analysis.settlementDistanceCurve, borderColor:'#378ADD', borderWidth:2.2, pointRadius:0, fill:false, tension:0.12},
        {label:'CPT location', data:[{x:analysis.geometry.distanceToCpt || 0,y:0},{x:analysis.geometry.distanceToCpt || 0,y:analysis.totalSettlementMm}], borderColor:'rgba(216,90,48,.55)', borderWidth:1.4, borderDash:[6,4], pointRadius:0, fill:false},
        {label:'Settlement at CPT', data:[{x:analysis.geometry.distanceToCpt || 0,y:analysis.totalSettlementMm}], borderColor:'#D85A30', pointRadius:4, pointHoverRadius:4, showLine:false}
      ]},
      options:{
        responsive:true,
        maintainAspectRatio:false,
        animation:false,
        interaction:{mode:'nearest', intersect:false},
        plugins:{
          legend:{display:false},
          tooltip:{
            filter:(ctx)=>ctx.dataset.label === 'Total settlement' || ctx.dataset.label === 'Settlement at CPT',
            callbacks:{
              label:(ctx)=>{
                if(ctx.dataset.label === 'Settlement at CPT'){
                  return `Settlement at CPT: ${ctx.parsed.y.toFixed(2)} mm @ ${ctx.parsed.x.toFixed(2)} m`;
                }
                return `Settlement: ${ctx.parsed.y.toFixed(2)} mm @ ${ctx.parsed.x.toFixed(2)} m`;
              }
            }
          }
        },
        scales:{
          x:{type:'linear', title:{display:true,text:analysis.geometry.geometry === 'line_dewatering_trench' ? 'Perpendicular distance from trench (m)' : 'Radial distance from well centre / excavation centroid (m)',font:{size:10}}, ticks:{font:{size:10}}},
          y:{type:'linear', beginAtZero:true, title:{display:true,text:'Total settlement (mm)',font:{size:10}}, ticks:{font:{size:10}}}
        }
      }
    });
  }
  const timeCanvas = stage6DestroyChart('stage6DewateringTimeChart');
  if(timeCanvas && analysis.timeCurve){
    timeCanvas._chartRef = new Chart(timeCanvas,{
      type:'line',
      data:{datasets:[{label:'S(t)', data:analysis.timeCurve, borderColor:'#D85A30', borderWidth:2.2, pointRadius:0, fill:false, tension:0.15}]},
      options:{responsive:true, maintainAspectRatio:false, animation:false, plugins:{legend:{display:false}}, scales:{x:{type:'linear', title:{display:true,text:'Time (days)',font:{size:10}}, ticks:{font:{size:10}}}, y:{type:'linear', title:{display:true,text:'Settlement (mm)',font:{size:10}}, ticks:{font:{size:10}}}}}
    });
  }
}

function buildStage6BeamCharts(){
  const analysis = S.stage6Cache?.beam;
  if(!analysis || typeof Chart === 'undefined') return;
  const tickFmt = (value)=>stage6CompactNumber(value, 2);
  const defCanvas = stage6DestroyChart('stage6BeamDeflectionChart');
  if(defCanvas){
    const deflectionData = analysis.sls.xSamples.map((x, i)=>({x, y:analysis.sls.wSamples[i]*1000}));
    defCanvas._chartRef = new Chart(defCanvas,{
      type:'line',
      data:{datasets:[{label:'w(x)', data:deflectionData, borderColor:'#378ADD', borderWidth:2.2, pointRadius:0, fill:false, tension:0}]},
      options:{
        responsive:true,
        maintainAspectRatio:false,
        animation:false,
        plugins:{
          legend:{display:false},
          tooltip:{callbacks:{label:(ctx)=>`w = ${stage6CompactNumber(ctx.parsed.y, 2)} mm @ x = ${stage6CompactNumber(ctx.parsed.x, 2)} m`}}
        },
        scales:{
          x:{type:'linear', title:{display:true,text:'x along beam (m)',font:{size:10}}, ticks:{font:{size:10}, callback:tickFmt}},
          y:{title:{display:true,text:'Deflection (mm)',font:{size:10}}, ticks:{font:{size:10}, callback:tickFmt}}
        }
      }
    });
  }
  const momentCanvas = stage6DestroyChart('stage6BeamMomentChart');
  if(momentCanvas){
    const momentData = analysis.uls.xSamples.map((x, i)=>({x, y:analysis.uls.mSamples[i]}));
    momentCanvas._chartRef = new Chart(momentCanvas,{
      type:'line',
      data:{datasets:[{label:'M(x)', data:momentData, borderColor:'#D85A30', borderWidth:2.2, pointRadius:0, fill:false, tension:0}]},
      options:{
        responsive:true,
        maintainAspectRatio:false,
        animation:false,
        plugins:{
          legend:{display:false},
          tooltip:{callbacks:{label:(ctx)=>`M = ${stage6CompactNumber(ctx.parsed.y, 2)} kNm/m @ x = ${stage6CompactNumber(ctx.parsed.x, 2)} m`}}
        },
        scales:{
          x:{type:'linear', title:{display:true,text:'x along beam (m)',font:{size:10}}, ticks:{font:{size:10}, callback:tickFmt}},
          y:{title:{display:true,text:'Moment (kNm/m)',font:{size:10}}, ticks:{font:{size:10}, callback:tickFmt}}
        }
      }
    });
  }
}

/* ════════════════════════════════
   CSV EXPORT
════════════════════════════════ */
function exportCSV(){
  if(!S.layers.length){alert('No layers to export. Run classification first.');return;}
  const taw=z=>S.elev!=null?(S.elev-z).toFixed(2):'';
  const hdr='Layer,Type,Subtype,Top_m,Bot_m,Top_TAW,Bot_TAW,Thick_m,avgQc_MPa,avgRf_pct,gamma,gamma_sat,phi,c,cu,alphaE,alphaMethod,Eoed_i_kPa,Eoed_ref_kPa,E50_ref_kPa,Eur_ref_kPa,m,K0nc,nu_ur,stiffMethod,kh_ms,kv_ms,khkv,psi_unsat_m,Infiltratie_klasse';
  const rows=S.layers.map((l,i)=>{
    const h=hsParams(l);
    const k=khParams(l);
    return[i+1,l.type,`"${l.subtype||''}"`,
      l.top.toFixed(3),l.bot.toFixed(3),taw(l.top),taw(l.bot),
      (l.bot-l.top).toFixed(3),l.avgQc,l.avgRf??'',
      l.g,l.gs,l.phi,l.c,l.cu,
      h.aE.toFixed(2),S.alphaMethod,
      h.Eoed_i,h.Eoed_ref,h.E50_ref,h.Eur_ref,h.m.toFixed(2),h.K0nc,h.nu_ur,S.stiffMethod,
      k.kh_rep.toExponential(2),k.kv_rep.toExponential(2),k.khkv,k.psi_unsat,
      `"${k.infClass}"`].join(',');
  });
  const csv=[hdr,...rows].join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=`CPT_${S.meta.testid||'export'}_layers.csv`;
  a.click();
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
  khParams,
  setAlphaMethod,
  setStiffMethod,
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
  exportCSV
};

export function initLegacyController(){
  if(__legacyControllerInitialized) return ()=>{};
  Object.assign(window, legacyApi);
  bindDropzone();
  renderBanner();
  __legacyControllerInitialized = true;
  return ()=>{};
}
