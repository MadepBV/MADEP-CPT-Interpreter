// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// report/payload.js — buildStage7Payload(project, cpt, deps): the Stage 7 report payload
// (version 4) of one CPT after the Stage 2–6 chain — replication settings, metadata,
// layer table with the model parameters, layer warnings, tuning, the two layer SVGs, the
// raw / classified row tables and the Stage 6 annexes (payload-stage6.js).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 8, refactor step 4): the label
// helpers (old lines 15834-15856 at c989770), stage7LayerWarnings (15858-15886),
// stage7TuningPayload (15888-15925), stage7WorkingLayerPayload (15927-15979) and
// buildStage7Payload (16576-16707). Changes inside the bodies:
//   • the project and the CPT state are parameters instead of the module-level `PROJECT`
//     / active CPT `S`;
//   • hsParams / khParams / stage6WorkingLayers, ensureStage6State, the workspace capture
//     and the Vite define come from `deps` (report/deps.js; the controller passes its own
//     wrappers, the defaults are the pure model-params/ functions);
//   • cptHasFs / cptHasRf / assumedRfValue / classificationMethodLabel are the pure
//     classification/ functions over `cpt`; the Tabel 3 catalogue is a parameter of
//     stage7LayerWarnings (default: the module CAT, as before);
//   • the guard alert ('Run the CPT through layers …') stays in the controller wrapper:
//     the pure function returns null (STAGE7_GUARD_MESSAGE carries the text);
//   • arrMax (legacy-controller.js:1012, still used there by the Stage 1 charts) and the
//     one-line stage6MaxDepth are local copies.
// generatedAt is still `new Date().toISOString()` — the payload's own timestamp, masked by
// the goldens.

import { CAT } from '../eurocode-tabel3.js';
import { compatLevel } from '../layers/index.js';
import { assumedRfValue, classificationMethodLabel, cptHasFs, cptHasRf } from '../classification/index.js';
import { buildLayerColumnSvgMarkup, buildLayerPreviewSvgMarkup } from './svg.js';
import { safeClone } from './clone.js';
import { stage7Deps } from './deps.js';
import { stage7Stage6Payload } from './payload-stage6.js';

/** The controller's guard message when the CPT has no layers or no readings yet. */
export const STAGE7_GUARD_MESSAGE = 'Run the CPT through layers and model parameters before opening the Stage 7 report.';

function arrMax(arr){return arr.reduce((m,v)=>Math.max(m,v),-Infinity);}

function stage6MaxDepth(cpt){
  return cpt.layers.length ? cpt.layers[cpt.layers.length-1].bot : 10;
}

export function stage7MethodLabel(method){
  return classificationMethodLabel(method);
}

export function stage7ParamMethodLabel(method){
  return method === 'def' ? 'Generic (DEF)' : 'NEN Tabel 3 / EC7';
}

export function stage7AlphaMethodLabel(method){
  return method === 'A' ? 'A - Sanglerat (fixed)' : 'B - SB260 qc-dependent';
}

export function stage7StiffMethodLabel(method){
  return method === 'A' ? 'A - CUR 2003-7 ratios' : 'B - E50 = Eoed';
}

export function stage7WtSourceLabel(cpt){
  return cpt.wtFromFile ? (cpt.wtSource || 'File') : 'Manual / default';
}

export function stage7ElevSourceLabel(cpt){
  return cpt.elevFromFile ? (cpt.elevSource || 'File') : (cpt.elev != null ? 'Manual' : 'Not set');
}

export function stage7LayerWarnings(cpt, catalogue = CAT){
  const warnings=[];
  cpt.layers.forEach((layer, index)=>{
    if(!layer.subtype || layer.subtype === '(overridden)') return;
    if(layer.rfIndeterminate && !layer.ovr.subtype){
      warnings.push({
        layer:index + 1,
        level:'adj',
        type:layer.type,
        subtype:layer.subtype,
        message:`${layer.subtype} was selected without measured Rf (no fs in the source CPT); several Tabel 3 rows share this qc band, so the catalogue-order row was applied. Review against borings or project knowledge.`
      });
    }
    const entry=catalogue.find(row=>row.subtype===layer.subtype);
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

export function stage7TuningPayload(cpt){
  if(!cpt.tuning) return null;
  return cpt.tuning.map((item)=>{
    const layer=cpt.layers[item.i];
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

export function stage7WorkingLayerPayload(cpt, layer, index, deps){
  deps = stage7Deps(cpt, deps);
  const hs=deps.hsParams(layer);
  const kh=deps.khParams(layer);
  const tuningFit=cpt.tuning?.[index]?.fit || null;
  return{
    index:index + 1,
    id:layer.id,
    top:layer.top,
    bot:layer.bot,
    topTaw:cpt.elev != null ? +(cpt.elev - layer.top).toFixed(2) : null,
    botTaw:cpt.elev != null ? +(cpt.elev - layer.bot).toFixed(2) : null,
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
      beta:hs.beta,
      eDef:hs.Edef,
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

/**
 * The Stage 7 payload, or `null` when the CPT has no layers / no readings (the controller
 * wrapper alerts STAGE7_GUARD_MESSAGE in that case).
 * @param {{name:string, phase:string}} project
 * @param {object} cpt   CPT state after the Stage 2–6 chain (newCptState shape).
 * @param {object} deps  see report/deps.js (all optional).
 */
export function buildStage7Payload(project, cpt, deps){
  if(!cpt.layers.length || !cpt.data.length) return null;
  deps = stage7Deps(cpt, deps);
  deps.ensureStage6State();
  const workingLayers=deps.workingLayers();
  const rawDepthMax=cpt.data.length ? +(cpt.data[cpt.data.length - 1].z + 0.5).toFixed(3) : stage6MaxDepth(cpt);
  const maxQc=Math.max(1, arrMax(cpt.data.map(r=>r.qc))) * 1.15;
  const maxFs=Math.max(10, arrMax(cpt.data.map(r=>r.fs != null ? r.fs * 1000 : 0))) * 1.15;
  const tuning=stage7TuningPayload(cpt);
  const layerWarnings=stage7LayerWarnings(cpt);
  const layerPayload=cpt.layers.map((layer, index)=>stage7WorkingLayerPayload(cpt, layer, index, deps));
  const acceptedTuningCount=layerPayload.filter(layer=>layer.hasAcceptedTuning).length;
  const manualOverrideCount=layerPayload.reduce((sum, layer)=>{
    return sum + Object.values(layer.overrides || {}).filter(Boolean).length;
  }, 0);
  const stage6=stage7Stage6Payload(cpt, workingLayers, deps);
  return{
    version:4,
    stage:'stage7',
    generatedAt:new Date().toISOString(),
    appVersion: deps.appVersion,
    project:{
      name:project.name,
      phase:project.phase
    },
    cpt:{
      id:cpt.id,
      displayId:cpt.meta?.testid || cpt.id || 'CPT',
      coordinates:{
        x:cpt.x,
        y:cpt.y
      }
    },
    metadata:safeClone({
      ...cpt.meta,
      sourceFile:cpt.meta?.fname || null,
      nRows:cpt.meta?.nRows || cpt.data.length,
      hasFs:cptHasFs(cpt),
      hasRf:cptHasRf(cpt),
      assumedRf:assumedRfValue(cpt),
      rfAssumedCount:cpt.data.filter(r=>r.rf==null).length
    }),
    replication:{
      method:cpt.method,
      methodLabel:stage7MethodLabel(cpt.method),
      smartMerge:!!cpt.smartMerge,
      smartMergeSensitivity:+Number(cpt.smartMergeSensitivity ?? 1.1).toFixed(3),
      minThickness:+Number(cpt.minThk || 0).toFixed(3),
      parameterMethod:cpt.paramMethod,
      parameterMethodLabel:stage7ParamMethodLabel(cpt.paramMethod),
      alphaMethod:cpt.alphaMethod,
      alphaMethodLabel:stage7AlphaMethodLabel(cpt.alphaMethod),
      stiffnessMethod:cpt.stiffMethod,
      stiffnessMethodLabel:stage7StiffMethodLabel(cpt.stiffMethod),
      waterTable:cpt.wt,
      waterTableTaw:cpt.elev != null ? +(cpt.elev - cpt.wt).toFixed(2) : null,
      waterTableSource:stage7WtSourceLabel(cpt),
      surfaceElevation:cpt.elev,
      surfaceElevationSource:stage7ElevSourceLabel(cpt)
    },
    summary:{
      layerCount:cpt.layers.length,
      depthMin:cpt.meta?.depthMin ?? (cpt.data[0]?.z || 0),
      depthMax:cpt.meta?.depthMax ?? (cpt.data[cpt.data.length - 1]?.z || 0),
      acceptedTuningCount,
      manualOverrideCount,
      stage6Annexes:stage6?.available || []
    },
    visuals:{
      layerColumn:{
        width:72,
        height:420,
        markup:buildLayerColumnSvgMarkup({
          layers:cpt.layers,
          maxDepth:rawDepthMax,
          wt:cpt.wt,
          width:72,
          height:420,
          emptyLabel:'No layers'
        })
      },
      layerProfile:{
        width:210,
        height:520,
        markup:buildLayerPreviewSvgMarkup({
          layers:cpt.layers,
          rows:cpt.classified?.length ? cpt.classified : cpt.data,
          wt:cpt.wt,
          width:210,
          height:520,
          showRf:false,
          // No fs in the source → no fs track: a permanently-empty column
          // with a fabricated axis would misread as a measured zero profile.
          showFs:cptHasFs(cpt)
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
    rawRows:cpt.data.map((row)=>({
      depth:row.z,
      taw:cpt.elev != null ? +(cpt.elev - row.z).toFixed(2) : null,
      qc:row.qc,
      fsMPa:row.fs ?? null,
      fsKPa:row.fs != null ? +(row.fs * 1000).toFixed(3) : null,
      rf:row.rf ?? null,
      u2:row.u2 ?? null
    })),
    classifiedRows:(cpt.classified || []).map((row)=>({
      depth:row.z,
      taw:cpt.elev != null ? +(cpt.elev - row.z).toFixed(2) : null,
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
