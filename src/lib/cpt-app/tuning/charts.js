// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// tuning/charts.js — the two Chart.js charts per tuning card (log-log regression, E_oed depth
// profile) and the live slider update (01-monolith-map.md §2.5, §3.4 #5 "three chart
// lifecycles": these are built from `data-*` JSON with a `canvas._built` guard and hang on
// `canvas._chartRef`).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): buildTuningCharts 2243-2304
// and the DOM half of updateTuningPreviewM 2034-2092 (`applyTuningPreview`; its value half is
// fit.js `tuningPreviewView`). Bodies are verbatim; `document` and the `Chart` global are
// parameters (the global is still the default). The chart configs come from chart-factories.js
// as before; the two design tokens are read with core/css-tokens.js readCssToken.

import { readCssToken } from '../core/css-tokens.js';
import { buildTuningRegressionChartConfig, buildTuningDepthChartConfig } from '../chart-factories.js';
import { tuningPreviewView } from './fit.js';

/* Build tuning charts after DOM is rendered (avoids early tag close issue) */
export function buildTuningCharts(document, ChartCtor = globalThis.Chart){
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
        const chart = new ChartCtor(canvas, buildTuningRegressionChartConfig({
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
        const chart = new ChartCtor(canvasD, buildTuningDepthChartConfig({
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

/** Write a preview view (fit.js tuningPreviewView) of card `i` into its inputs, texts, button
    and the two live charts. */
export function applyTuningPreview(document, i, view, {chartRed, chartGreen}){
  const {invalid, previewM, preview} = view;

  const input=document.getElementById('fitPreviewInput'+i);
  if(input){
    input.style.borderColor = invalid ? 'var(--bad)' : 'var(--bd2)';
    input.style.color = invalid ? 'var(--bad-text)' : 'var(--tx)';
  }

  const mEl=document.getElementById('fitPreviewM'+i);
  if(mEl) mEl.textContent = view.mText;

  const refEl=document.getElementById('fitPreviewRef'+i);
  if(refEl) refEl.textContent = view.refText;

  const noteEl=document.getElementById('fitPreviewNote'+i);
  if(noteEl){
    noteEl.textContent = view.noteText;
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
    regChart.data.datasets[2].label = view.regressionLabel;
    regChart.data.datasets[2].borderColor = invalid ? chartRed : chartGreen;
    regChart.data.datasets[2].borderDash = view.dashed ? [5,4] : [];
    regChart.update('none');
  }

  const depCanvas=document.getElementById('tChart'+i+'d');
  const depChart=depCanvas?depCanvas._chartRef:null;
  if(depChart){
    depChart.data.datasets[3].data = preview.depthLine;
    depChart.data.datasets[3].label = view.depthLabel;
    depChart.data.datasets[3].borderColor = invalid ? chartRed : chartGreen;
    depChart.data.datasets[3].borderDash = view.dashed ? [5,4] : [];
    depChart.update('none');
  }
  return previewM;
}

/** The live slider handler: store the raw preview m on tuning entry `i`, then re-render its
    numbers and charts. No-op without a fit (as before). */
export function updateTuningPreviewM(document, tuning, i, rawValue){
  const t = tuning?.[i];
  if(!t||!t.fit) return;

  const view = tuningPreviewView(t, rawValue);
  t.previewM = view.parsed;
  const chartRed = readCssToken('--chart-red', '#9B3A32');
  const chartGreen = readCssToken('--chart-green', '#3D6B6A');
  applyTuningPreview(document, i, view, {chartRed, chartGreen});
}
