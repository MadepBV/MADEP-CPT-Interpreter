// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure classification core — the five per-reading CPT classifiers, extracted
// from legacy-controller.js so they are importable by node verification
// scripts (scripts/verify_qc_only_handling.mjs). The controller keeps thin
// wrappers that supply the stress state and app settings; the math here is
// verbatim from the original in-controller implementations.
//
// Missing sleeve friction (fs): when a reading has neither fs nor Rf, every
// method classifies with an explicit assumed friction ratio `assumedRf`
// (app default 3.0 %, user-tunable per CPT). This replaces the previous
// hidden hardcoded defaults, and — for the Eurocode Tabel 3 route — replaces
// the previous silent fall-through to the loose-sand fallback for every
// qc-only reading.

import { classifyNen6740Reading } from './nen6740.js';
import { EUROCODE_CLASS_ENTRIES, eurocodeEntryMatches } from './eurocode-tabel3.js';

export const DEFAULT_ASSUMED_RF = 3.0;

/**
 * @typedef {{z?:number, qc:number, fs?:number|null, rf?:number|null, u2?:number|null}} CptReading
 */

/**
 * Clamp a user-supplied assumed Rf to a physically sensible band.
 * @param {unknown} value
 */
export function normalizeAssumedRf(value){
  const v = Number(value);
  if(!Number.isFinite(v) || v <= 0) return DEFAULT_ASSUMED_RF;
  return Math.min(Math.max(v, 0.1), 10);
}

/* ════════════════════════════════
   CLASSIFICATION — Robertson (1990) SBT
   Source: Robertson, P.K. (1990). Soil classification using the CPT.
   Canadian Geotechnical Journal, 27(1), 151-158.
   Qt = (qt - σv0) / σ'v0, Fr = fs / (qt - σv0) × 100,
   Ic = √((3.47 - log Qt)² + (log Fr + 1.22)²)
════════════════════════════════ */
/**
 * @param {CptReading} r
 * @param {{sigV:number, sigVeff:number, aRatio?:number, assumedRf?:number}} ctx
 */
export function classifyRobertson1990(r, {sigV, sigVeff, aRatio = 0.8, assumedRf = DEFAULT_ASSUMED_RF}){
  const qtCone = r.u2 != null ? (r.qc + (1 - aRatio) * r.u2) : r.qc; // qt in MPa
  const dQ = qtCone - sigV/1000;   // qt - σv0 [MPa]

  // Guard: if stress or net resistance is negligible, default to Clay
  if(dQ < 0.01 || sigVeff < 1)
    return{type:'Clay', subtype:'', Ic:2.80, Qt:null, g:null,gs:null,phi:null,c:null,cu:null};

  // Qt = (qt - σv0) / σ'v0  — both in MPa
  const Qt = Math.max(0.1, dQ / (sigVeff / 1000));

  // Fr = fs / (qt - σv0) × 100  [%]
  // If fs not available, estimate sleeve friction from qt and Rf
  // (measured Rf when present, otherwise the explicit assumed Rf).
  const fs_eff = r.fs != null ? r.fs : qtCone * (r.rf ?? assumedRf) / 100;
  const Fr = Math.max(0.1, Math.min(10, (Math.abs(fs_eff) / dQ) * 100));

  const Ic = Math.sqrt((3.47 - Math.log10(Qt))**2 + (Math.log10(Fr) + 1.22)**2);

  // Zone 7 check (gravelly sand / dense sand) — BEFORE Ic zones
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
   Iterative Qtn normalisation, same Ic-based app mapping.
════════════════════════════════ */
/**
 * @param {CptReading} r
 * @param {{sigV:number, sigVeff:number, aRatio?:number, assumedRf?:number}} ctx
 */
export function classifyRobertson2016(r, {sigV, sigVeff, aRatio = 0.8, assumedRf = DEFAULT_ASSUMED_RF}){
  const pa = 100;
  const qtCone = r.u2 != null ? (r.qc + (1 - aRatio) * r.u2) : r.qc; // qt in MPa
  const qtKPa = qtCone * 1000;
  const dQKPa = qtKPa - sigV;

  if(dQKPa < 10 || sigVeff < 1)
    return{type:'Clay', subtype:'', Ic:2.80, Qt:null, g:null,gs:null,phi:null,c:null,cu:null};

  const fsKPa = r.fs != null ? (r.fs * 1000) : (qtKPa * (r.rf ?? assumedRf) / 100);
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
   Zones checked most specific → broadest: Sand, Silt, Clay, Peat.
════════════════════════════════ */
/**
 * @param {CptReading} r
 * @param {{assumedRf?:number}} [ctx]
 */
export function classifyCUR3(r, {assumedRf = DEFAULT_ASSUMED_RF} = {}){
  const qc = r.qc;
  const rf = r.rf != null ? r.rf : assumedRf;

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

/* ════════════════════════════════
   CLASSIFICATION — NEN 6740 (stress dependent)
   Chart scoring lives in nen6740.js (independently verified by
   scripts/verify_nen6740.mjs).
════════════════════════════════ */
/**
 * @param {CptReading} r
 * @param {{sigVeff:number, assumedRf?:number}} ctx
 */
export function classifyNEN6740(r, {sigVeff, assumedRf = DEFAULT_ASSUMED_RF}){
  const rf = r.rf != null ? r.rf : assumedRf;
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
   Checks the exact table rows in table order (grind → zand → leem → klei
   → veen). When the reading has no measured Rf, it is classified with the
   explicit assumed Rf rather than skipping the table entirely.
════════════════════════════════ */
/**
 * @param {CptReading} r
 * @param {{assumedRf?:number}} [ctx]
 */
export function classifyTabel3(r, {assumedRf = DEFAULT_ASSUMED_RF} = {}){
  const qc = r.qc;
  const rf = r.rf != null ? r.rf : assumedRf;

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
   PLAXIS simulated-CPT sleeve friction
   The simulated export exists to let PLAXIS's own CPT interpretation
   recreate the app's layer sequence. When a layer has no measured fs/Rf,
   fs is synthesised from a representative Rf per soil type — writing fs=0
   would make PLAXIS read every layer as clean sand and destroy the
   layering the export is meant to carry. Values sit mid-band of the
   Tabel 3 Rf conventions per family.
════════════════════════════════ */
/** @type {Record<string, number>} */
export const SIMULATED_RF_BY_TYPE = {
  'Gravel': 0.5,
  'Sand': 0.7,
  'Silty sand': 1.5,
  'Sandy clay': 2.5,
  'Clay': 4.0,
  'Soft clay': 5.0,
  'Peat / organic': 7.0
};

/**
 * @param {{avgFs?:number|null, avgRf?:number|null, avgQc?:number|null, type?:string}} layer
 * @param {number} [assumedRf]
 */
export function simulatedLayerFsValue(layer, assumedRf = DEFAULT_ASSUMED_RF){
  if(layer.avgFs != null && isFinite(layer.avgFs)) return Math.max(0, layer.avgFs);
  if(layer.avgRf != null && isFinite(layer.avgRf)) return Math.max(0, (layer.avgQc || 0) * layer.avgRf / 100);
  const rf = SIMULATED_RF_BY_TYPE[layer.type || ''] ?? assumedRf;
  return Math.max(0, (layer.avgQc || 0) * rf / 100);
}
