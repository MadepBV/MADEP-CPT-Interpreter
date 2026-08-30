// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// load/raw-charts.js — the three Stage 1 raw-profile charts (qc, fs, Rf) and the
// "not recorded in the source file" overlays. 01-monolith-map.md §6.1 row `load/`
// (`raw-charts.js`), moved out of legacy-controller.js in PR 20 / refactor step 10.
//
// Verbatim from the controller: arrMax / arrSafe / buildRawChartSeries / initCharts /
// setChartEmptyState / updateRawChartEmptyStates / refreshChartData / updateWTLine. `S` became
// the `cpt` parameter and the two things the monolith reached for through its closure are hooks:
// `drawLayerColumn` (the placeholder column initCharts paints after building the charts) and
// `again` (the 120 ms retry while the Chart.js CDN script is still loading — it re-enters through
// the host's façade, so a retry lands on the CPT that is active *then*, as before).
//
// `Chart` is the global the CDN `<script>` of +page.svelte defines; the golden harness stubs it.

import { buildRawProfileChartConfig } from '../chart-factories.js';
import { readCssToken } from '../core/css-tokens.js';
import { assumedRfValue, cptHasFs, cptHasRf } from '../classification/classify.js';

export function arrMax(arr){return arr.reduce((m,v)=>Math.max(m,v),-Infinity);}
export function arrSafe(arr){return arr.map(v=>isNaN(v)||v==null?0:v);}

/* Shared data prep for the three Stage 1 raw-profile charts (initCharts and
   refreshChartData must stay identical). fs/Rf keep null when not measured —
   null points are dropped by ptData, NOT drawn as a fake zero-line (legacy
   qc-only files previously rendered fs=0 as a measured-looking profile). */
export function buildRawChartSeries(cpt){
  const d=cpt.data;
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

export function initCharts(document, cpt, {drawLayerColumn, again}){
  const hasCanvases = document.getElementById('cQc') && document.getElementById('cFs') && document.getElementById('cRf');
  // If charts already exist and the canvases still exist, just update data
  if(cpt.chartsReady && hasCanvases && cpt.charts.qc && cpt.charts.fs && cpt.charts.rf){
    refreshChartData(document, cpt); return;
  }
  if(typeof Chart==='undefined'){
    setTimeout(()=>again(), 120);
    return;
  }
  const {qcs,fss,rfs,maxZ,maxQc,maxFs,ptData}=buildRawChartSeries(cpt);
  const wt=cpt.wt;

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

  cpt.charts.qc=mk('cQc',qcs,readCssToken('--chart-green', '#3D6B6A'),maxQc,'qc');
  cpt.charts.fs=mk('cFs',fss,readCssToken('--chart-purple', '#18181A'),maxFs,'fs');
  cpt.charts.rf=mk('cRf',rfs,readCssToken('--chart-orange', '#8A620D'),12,'Rf');
  cpt.chartsReady=true;
  updateRawChartEmptyStates(document, cpt);

  // Layer column SVG (placeholder before classification)
  drawLayerColumn('layerColSvg',[],maxZ);
}

/* Overlay note on the fs / Rf canvases when the source file never measured
   the quantity, so an empty track cannot be mistaken for a zero profile. */
export function setChartEmptyState(document, canvasId, message){
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

export function updateRawChartEmptyStates(document, cpt){
  setChartEmptyState(document, 'cFs', cptHasFs(cpt)?null:'fs not recorded in source file');
  setChartEmptyState(document, 'cRf', cptHasRf(cpt)?null:`Rf not recorded — classification uses assumed Rf = ${assumedRfValue(cpt).toFixed(1)} %`);
}

export function refreshChartData(document, cpt){
  // Called if a new file is loaded after charts exist
  const {qcs,fss,rfs,maxZ,maxQc,maxFs,ptData}=buildRawChartSeries(cpt);

  function applyData(c,vals,xmax){
    c.data.datasets[0].data=ptData(vals);
    c.data.datasets[1].data=[{x:0,y:cpt.wt},{x:xmax,y:cpt.wt}];
    c.options.scales.x.max=xmax;
    c.options.scales.y.max=maxZ;
    c.update('none');
  }
  applyData(cpt.charts.qc,qcs,maxQc);
  applyData(cpt.charts.fs,fss,maxFs);
  applyData(cpt.charts.rf,rfs,12);
  updateRawChartEmptyStates(document, cpt);
}

/** Move only the water-table annotation line of one chart — no rebuild. */
export function updateWTLine(chart,wt,xmax){
  if(!chart)return;
  chart.data.datasets[1].data=[{x:0,y:wt},{x:xmax,y:wt}];
  chart.update('none'); // no animation
}
