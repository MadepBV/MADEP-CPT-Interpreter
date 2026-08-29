// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * State of the retaining-wall application (lives in `stage6.retwall` of the active CPT and is
 * saved with the project). `defaults()` is the schema; `ensure()` migrates older saved states by
 * filling missing keys — never overwriting what the engineer entered.
 *
 * Every value that changes a result is here and visible in the UI; the engine has no hidden
 * defaults of its own beyond what `request-builder.js` sends explicitly.
 */
import { WALL_TYPES } from './wall-types.js';

export function defaults() {
  return {
    wallType: 'cantilever',
    cantilever: { toe: 0.9, heel: 2.1, stemThkTop: 0.3, stemThkBot: 0.45, stemHeight: 4.5, baseThk: 0.55, keyDepth: 0, keyThk: 0.3, betaDeg: 0, frontSoilDepth: 1.0 },
    gravity: { toe: 0.4, heel: 0.4, stemThkTop: 0.6, stemThkBot: 1.7, stemHeight: 2.5, baseThk: 0.5, backBatterDeg: 6, betaDeg: 0, frontSoilDepth: 1.0 },
    embedded: {
      retainedHeight: 1.6, embedment: 4.4,   // Rekennota case: HEA180, 1.6 m retained, 4.4 m below the design excavation (≈ 6.3 m pile)
      anchored: false,                 // soldier-pile walls only (sheet-pile anchoring is its own wall type)
      anchorDepth: 0.8, anchorAngle: 20, freeLen: 4.0, fixedLen: 4.0, anchorDia: 0.15, anchorSpacing: 2.0, anchorTfk: 150, anchorGammaA: 1.1
    },
    sheet: { sectionId: 'AZ 26-700', grade: 'S355GP', useWpl: false, betaB: 1.0, corrosionLoss: 0 },
    soldier: {
      sectionId: 'HEA180', grade: 'S235', spacing: 1.0,
      laggingThk: 0.010, laggingGrade: 'S235', laggingSpan: 'centre',
      resistanceModel: 'effective-width', effectiveWidthFactor: 3, rowCap: true, laggingWatertight: false,
      tlatConvention: 'AL',
      tskinK: 'k0', tskinDeltaRatio: 0.667, tskinPlug: true, fmaxAlphaB: 0.5, fmaxPlugged: true,
      pileHeadAbove: 0.0                // pile length above the retained surface (m), for self-weight only
    },
    backfill: { gammaMoist: 18, gammaSat: 20, phi: 32, c: 0, cu: 0, drained: true, label: 'Granular backfill' },
    insitu: { gammaMoist: 19, gammaSat: 21, phi: 30, c: 5, cu: 0, drained: true, label: 'Foundation / in-situ', source: 'default', mode: 'cpt' },
    profile: { offset: 0, overrides: {} },
    water: { mode: 'none', retainedDepth: 2.5, frontDepth: 0.0 },
    surcharge: 10,                      // variable surcharge on the retained surface (kPa)
    loads: { surchargePermanent: 0, berm: { enabled: false, height: 1.5, slopeDeg: 45 } },
    settings: {
      deltaActiveRatio: 0.667, deltaBaseRatio: 1.0, passiveDeltaRatio: 0.667,
      deltaPassiveSheet: 0.667, deltaPassiveSoldier: 0.0,
      gammaConc: 24, consequenceClass: 2, riskScheme: 2,
      overdigRule: 'belgian', overdigCustom: 0.30, alphaVer: 1.10, da11Mode: 'separate', surchargeFloor: 10,
      materialOverride: { enabled: false, gPhi: 1.30, gC: 1.30, gCu: 1.40, applyToDA12: false },
      assumeCrackWater: true, passiveToe: true, bearingMethod: 'annexd', bearingDepthFactors: true
    },
    drivability: {
      method: 'vibratory', targetDepth: null, lambda: 6, deltaH: 0, reserve: 1.25, shaftFactor: 1.0, toeFactor: 1.0, interlock: 0,
      vibrator: {
        source: 'required', id: 'custom', frequency: 35, dynamicMass: 5000, crowd: 0, lineForce: 0, eccentricMoment: null, centrifugalForce: null,
        // supplier data sheet, in the sheet's own vocabulary (vibrator-datasheet.js translates it)
        sheet: { name: '', force_kN: null, forceAtRpm: null, rpmMax: null, rpmMin: null, rpmOperating: null, eccentricMoment_kgm: null, amplitude_mm: null, amplitudeConvention: 'pp',
          dynamicMass_kg: null, totalMass_kg: null, flow_lmin: null, flowMax_lmin: null, pressure_bar: null, pressureMax_bar: null, power_kW: null, carrierMin_t: null, carrierMax_t: null },
        carrier: { mass_t: null, flow_lmin: null, pressure_bar: null, power_kW: null }
      },
      hammer: { id: 'custom', ramMass: 5000, ratedEnergy: 60, efficiency: 0.9, helmetMass: 1500, cushionStiffness: 2.5e6, cushionCor: 0.8, type: 'hydraulic' },
      soil: { shaftQuake: 0.0025, toeQuake: 0.0025, shaftDampingSand: 0.16, shaftDampingClay: 0.65, toeDamping: 0.5 },
      result: null, status: 'idle', error: ''
    },
    vibration: {
      distance: 10, frequency: 35, framework: 'SBR-A',
      sbr: { category: 2, condition: 'normal', measurement: 'indicative', vibrationType: 'repeated-short', part: 'structure' },
      din: { line: 2, location: 'foundation', duration: 'short' },
      bs: { line: 2, continuous: false },
      warningFraction: 0.75,
      calibration: { points: [] }
    },
    cptX: null,
    ui: { resultTab: 'checks', diagram: 'M' },
    result: null, status: 'idle', error: ''
  };
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function fill(target, source) {
  for (const k of Object.keys(source)) {
    if (k === 'result') continue;
    if (target[k] == null) target[k] = source[k];
    else if (isObj(source[k]) && isObj(target[k])) fill(target[k], source[k]);
  }
}

/** Migrate / complete a saved state in place. */
export function ensure(stage6) {
  if (!stage6.retwall) { stage6.retwall = defaults(); return stage6.retwall; }
  const rw = stage6.retwall;
  const d = defaults();
  fill(rw, d);
  if (!WALL_TYPES.some((t) => t.id === rw.wallType)) rw.wallType = 'cantilever';
  // legacy: insitu.mode carried the CPT/single switch — keep it as the single source of truth
  if (rw.insitu.mode !== 'single' && rw.insitu.mode !== 'cpt') rw.insitu.mode = 'cpt';
  if (rw.settings.passiveDeltaRatio != null && rw.settings.deltaPassiveSheet == null) rw.settings.deltaPassiveSheet = rw.settings.passiveDeltaRatio;
  rw.status = rw.result ? 'done' : 'idle';
  return rw;
}
