// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// tuning/fit.js — Stage 5 "m fitting": the per-layer OLS of ln(E_oed,i) on ln(σ'v0 stress ratio)
// in the Hardening Soil sense, the accept/reject of the fitted m as a layer override, and the
// slider/preview helpers (01-monolith-map.md §2.5, §6.1 row `tuning/`).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (integration-r): fitLayer 1852-1970,
// runTuning 1972-1978 (the state half → `runTuningFits`), acceptFit 1980-1991 / rejectFit
// 1993-1998 (the state half → `acceptFit(cpt, i)` / `rejectFit(cpt, i)`, returning whether the
// old body went on to render), getTuningPreviewM 2000-2005, tuningSliderBounds 2007-2016,
// tuningPreviewEoedRef 2018-2020, tuningPreviewLineData 2022-2032, and the value half of
// updateTuningPreviewM 2034-2092 (→ `tuningPreviewView`). Bodies are verbatim; the reads of
// the active CPT `S` became the explicit `ctx` of `tuningCtx(cpt)`:
//   S.classified → ctx.classified · S.alphaMethod → ctx.alphaMethod ·
//   assumedRfValue() → ctx.assumedRf (classification/classify.js, pure) ·
//   stressAt(z, gs, g) → ctx.stressAt (model-params/stress.js bound to the CPT).

import { AE, alphaEB, stressAt as stressAtPure } from '../model-params/index.js';
import { assumedRfValue } from '../classification/index.js';

/** Everything fitLayer reads from a CPT state. */
export function tuningCtx(cpt){
  return {
    classified: cpt.classified,
    alphaMethod: cpt.alphaMethod,
    assumedRf: assumedRfValue(cpt),
    stressAt: (z, gamma_sat, gamma_unsat) => stressAtPure(cpt, z, gamma_sat, gamma_unsat)
  };
}

export function fitLayer(l, ctx){
  // Pull the classified rows that belong to this layer depth range
  const rows = ctx.classified.filter(r =>
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
    : ctx.alphaMethod==='B' ? alphaEB(l.type, l.avgQc, l.subtype, l.avgRf ?? ctx.assumedRf)
    : (AE[l.type] || 10));

  // Build the point cloud directly from CPT rows in the layer.
  // Stage 5 only: Method B uses the row qc for pointwise Eoed,i reconstruction.
  const pts = [];
  for(const r of rows){
    const {sigVeff} = ctx.stressAt(r.z, l.gs, l.g);
    const denom = pref + cCotPhi;
    const numer = sigVeff + cCotPhi;
    if(numer <= 0 || denom <= 0) continue;

    const ratio = numer / denom;
    if(ratio <= 0) continue;

    const aE_row = l.ovr.aE ? l.aE_ovr
      : ctx.alphaMethod==='B' ? alphaEB(l.type, r.qc, l.subtype, r.rf ?? l.avgRf ?? ctx.assumedRf)
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
  const {sigVeff: sv_mid2} = ctx.stressAt(midZ2, l.gs, l.g);
  const ratioMid = Math.max((sv_mid2+cCotPhi)/(pref+cCotPhi), 0.05);
  const Eoed_ref_default = (alphaDefault * l.avgQc * 1000) / Math.pow(ratioMid, mDefault);

  const hsDefault_pts = makeHScurve(Eoed_ref_default, mDefault);
  const hsFit_pts     = makeHScurve(Eoed_ref_fit, m_fit);

  return{m_fit, Eoed_ref_fit, R2, n, stressRangeFactor:+stressRangeFactor.toFixed(2),
         quality, qMsg, invalidSlope, Xs, Ys, meanX:+meanX.toFixed(6), meanY:+meanY.toFixed(6), m_raw:+m_raw.toFixed(4),
         depthPts, EoedI_pts, aE_pts, hsDefault_pts, hsFit_pts,
         Eoed_ref_default, mDefault, alphaDefault:+alphaDefault.toFixed(3)};
}

/** The `tuning` array of a CPT: one {i, fit, previewM} per layer (runTuning's state half). */
export function runTuningFits(layers, ctx){
  return layers.map((l,i)=>{
    const fit = fitLayer(l, ctx);
    return{i, fit, previewM:fit ? (fit.invalidSlope ? fit.mDefault : fit.m_fit) : null};
  });
}

/** Accept the preview m of tuning entry `i` as the layer's m override. Returns false when the
    old body returned early (no fit / invalid preview) — nothing is written then. */
export function acceptFit(cpt, i){
  const t = cpt.tuning?.[i];
  const previewM = Number(t?.previewM);
  if(!t||!t.fit||!isFinite(previewM)||previewM<=0) return false;
  cpt.layers[i].m_ovr = previewM;
  cpt.layers[i].ovr.m = true;
  // Also update Eoed,ref override? No — Eoed,ref is derived from m in hsParams.
  // Accepting m is enough: renderModel will recompute Eoed,ref with the new m.
  return true;
}

/** Drop the m override of layer `i`. Returns false when there is no such layer. */
export function rejectFit(cpt, i){
  if(!cpt.layers[i]) return false;
  delete cpt.layers[i].m_ovr;
  cpt.layers[i].ovr.m = false;
  return true;
}

export function getTuningPreviewM(t){
  if(!t||!t.fit) return NaN;
  const m = Number(t.previewM);
  if(isFinite(m) && m > 0) return m;
  return t.fit.invalidSlope ? t.fit.mDefault : t.fit.m_fit;
}

export function tuningSliderBounds(fit){
  const anchors=[fit.mDefault, fit.m_fit, 0.01].filter(v=>isFinite(v) && v>0);
  const min=Math.max(0.01, Math.min(...anchors) - 0.4);
  const max=Math.min(2.0, Math.max(...anchors) + 0.4);
  return{
    min:+min.toFixed(2),
    max:+Math.max(max, min + 0.2).toFixed(2),
    step:0.01
  };
}

export function tuningPreviewEoedRef(fit, previewM){
  return +Math.exp(fit.meanY - previewM*fit.meanX).toFixed(0);
}

export function tuningPreviewLineData(fit, previewM){
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

/** The value half of the live slider (updateTuningPreviewM): what the raw input means for the
    numbers, texts and chart datasets of tuning entry `t` (which must have a fit). */
export function tuningPreviewView(t, rawValue){
  const parsed = Number(rawValue);
  const invalid = !isFinite(parsed) || parsed <= 0;
  const previewM = invalid ? t.fit.m_fit : parsed;
  const preview = tuningPreviewLineData(t.fit, previewM);
  return {
    parsed,
    invalid,
    previewM,
    preview,
    mText: invalid ? '—' : previewM.toFixed(3),
    refText: invalid ? '—' : preview.Eoed_ref.toLocaleString()+' kPa',
    noteText: invalid
      ? 'Preview ongeldig: m moet groter zijn dan 0'
      : (Math.abs(previewM - t.fit.m_fit) < 1e-6 ? 'Preview volgt de auto-fit' : 'Preview wijkt af van de auto-fit'),
    regressionLabel: 'Preview m='+previewM.toFixed(2),
    depthLabel: 'HS preview m='+previewM.toFixed(2),
    dashed: invalid || t.fit.quality==='warn'
  };
}
