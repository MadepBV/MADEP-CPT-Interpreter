// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Empirical source → receiver peak-particle-velocity (PPV) predictors for
// construction vibration (preliminary screening only).
//
// References
//   [TRL429]  Hiller, D.M. & Crabb, G.I. (2000). Groundborne vibration caused by
//             mechanised construction works. TRL Report 429.
//   [BS5228]  BS 5228-2:2009+A1:2014, Annex E, Table E.1 (empirical predictors) and
//             Table E.2 (k_p for percussive piling). The tables reproduce TRL 429.
//   [COURSE]  worklog/course-text/Vibratory_Pile_Installation_Manual_Eurocode_Course_Chapter.md
//             §10–11 (vibratory piling, worked 30 m example) and §9.4 / §15.5 (site power law).
//
// Units: distance in m, PPV in mm/s, hammer energy in J. All functions are pure and
// return `notes: string[]` for caveats instead of throwing.
//
// Assumptions / scope
//   * The TRL 429 vibratory-piling relationship predicts the RESULTANT PPV at the ground
//     surface at horizontal distance x from the active pile. It is a statistical predictor
//     (exceedance probability attached to k_v), not an upper bound.
//   * The percussive-piling relationship uses the SLOPE distance r from the pile toe
//     (r² = L² + x²) and a ground-condition factor k_p — NOT a probability (BS 5228-2 Table E.2).
//   * Nothing here is normative; results are for screening and for planning a monitored trial.

/** TRL 429 / BS 5228-2 Table E.1 scaling coefficient k_v by probability of exceedance (%). */
export const TRL429_KV = Object.freeze({ 50: 60, 33: 126, 5: 266 });

/** TRL 429 / BS 5228-2 Table E.1 distance exponent δ_v by operating phase. */
export const TRL429_DELTA_V = Object.freeze({ steady: 1.4, all: 1.3, startup: 1.2 });

/** Calibration domain of the vibratory-piling relationship (BS 5228-2 Table E.1). */
export const TRL429_VIBRATORY_RANGE = Object.freeze({ xMin_m: 1, xMax_m: 100, wcMin_kJ: 1.2, wcMax_kJ: 10.7 });

/**
 * BS 5228-2:2009+A1:2014 Table E.2 — values of k_p for percussive (impact) piling.
 * Keys are ground-condition classes; the standard attaches no exceedance probability to k_p.
 */
export const BS5228_KP = Object.freeze({
  refusal: { kp: 5, description: 'All piles driven to refusal' },
  veryStiffDense: { kp: 3, description: 'Pile toe driven through very stiff cohesive soils, dense granular soils, or fill with obstructions large relative to the pile section' },
  stiffMediumDense: { kp: 1.5, description: 'Pile toe driven through stiff cohesive soils, medium dense granular soils, compacted fill' },
  softLoose: { kp: 1, description: 'Pile toe driven through soft cohesive soils, loose granular soils, loose fill, organic soils' }
});

/** Calibration domain of the percussive-piling relationship (BS 5228-2 Table E.1). */
export const BS5228_IMPACT_RANGE = Object.freeze({ toeDepthMin_m: 1, toeDepthMax_m: 27, xMin_m: 1, xMax_m: 111, wMin_J: 1500, wMax_J: 85000 });

const SOURCE_VIBRATORY = 'TRL 429 (Hiller & Crabb 2000); BS 5228-2:2009+A1:2014 Annex E Table E.1';
const SOURCE_IMPACT = 'BS 5228-2:2009+A1:2014 Annex E Table E.1 (equation) and Table E.2 (k_p)';

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Vibratory (vibrodriver) piling: v_res = k_v · x^(−δ_v).
 *
 * @param {object} a
 * @param {number} a.distance_m   horizontal surface distance from the active pile (m)
 * @param {'steady'|'all'|'startup'} [a.phase='steady']  operating phase → δ_v (1.4 / 1.3 / 1.2)
 * @param {50|33|5} [a.probability=5]  probability (%) that the actual value exceeds the prediction → k_v (60 / 126 / 266)
 * @returns {{ ppv_mm_s:number, kv:number, deltaV:number, formula:string, source:string, quantity:string,
 *            phase:string, probability:number, distance_m:number, notes:string[] }}
 */
export function predictVibratoryPpv({ distance_m, phase = 'steady', probability = 5 }) {
  const notes = [];
  const kv = TRL429_KV[probability];
  const deltaV = TRL429_DELTA_V[phase];
  if (!isNum(kv)) notes.push(`Unknown probability ${probability}; use 50, 33 or 5 (%).`);
  if (!isNum(deltaV)) notes.push(`Unknown phase '${phase}'; use 'steady', 'all' or 'startup'.`);
  if (!isNum(distance_m) || distance_m <= 0) notes.push('distance_m must be a positive number.');
  let ppv = NaN;
  if (notes.length === 0) {
    ppv = kv * Math.pow(distance_m, -deltaV);
    if (distance_m < TRL429_VIBRATORY_RANGE.xMin_m || distance_m > TRL429_VIBRATORY_RANGE.xMax_m) {
      notes.push(`Distance ${distance_m} m is outside the TRL 429 calibration range ${TRL429_VIBRATORY_RANGE.xMin_m}–${TRL429_VIBRATORY_RANGE.xMax_m} m; extrapolation is not justified without site data.`);
    }
    if (probability === 5) notes.push('k_v = 266 is an approximate 95th-percentile screening envelope, not an absolute maximum.');
  }
  return {
    ppv_mm_s: ppv,
    kv: isNum(kv) ? kv : NaN,
    deltaV: isNum(deltaV) ? deltaV : NaN,
    formula: 'v = kv · x^(−δv)',
    source: SOURCE_VIBRATORY,
    quantity: 'resultant PPV at the ground surface',
    phase,
    probability,
    distance_m,
    notes
  };
}

/**
 * Percussive (impact hammer) piling: v_res = k_p · √W / r^1.3, r = √(L² + x²).
 *
 * @param {object} a
 * @param {number} a.distance_m       horizontal surface distance x from the pile (m)
 * @param {number} a.hammerEnergy_J   nominal hammer energy W per blow (J)
 * @param {number} [a.toeDepth_m=0]   pile toe depth L below the surface (m); 0 → r = x (conservative)
 * @param {keyof typeof BS5228_KP} [a.groundCondition='refusal']  Table E.2 class
 * @param {number} [a.kp]             explicit k_p override (e.g. a site-calibrated value)
 * @returns {{ ppv_mm_s:number, kp:number, r_m:number, formula:string, source:string, quantity:string,
 *            groundCondition:string, distance_m:number, toeDepth_m:number, hammerEnergy_J:number, notes:string[] }}
 */
export function predictImpactPpv({ distance_m, hammerEnergy_J, toeDepth_m = 0, groundCondition = 'refusal', kp }) {
  const notes = [];
  let kpUsed = isNum(kp) ? kp : NaN;
  if (!isNum(kp)) {
    const cls = BS5228_KP[groundCondition];
    if (!cls) notes.push(`Unknown groundCondition '${groundCondition}'; use one of ${Object.keys(BS5228_KP).join(', ')} or pass kp.`);
    else kpUsed = cls.kp;
  }
  if (!isNum(distance_m) || distance_m <= 0) notes.push('distance_m must be a positive number.');
  if (!isNum(hammerEnergy_J) || hammerEnergy_J <= 0) notes.push('hammerEnergy_J must be a positive number (joules per blow).');
  if (!isNum(toeDepth_m) || toeDepth_m < 0) notes.push('toeDepth_m must be ≥ 0.');
  let ppv = NaN, r = NaN;
  if (notes.length === 0) {
    r = Math.sqrt(toeDepth_m * toeDepth_m + distance_m * distance_m);
    ppv = kpUsed * Math.sqrt(hammerEnergy_J) / Math.pow(r, 1.3);
    const R = BS5228_IMPACT_RANGE;
    if (distance_m < R.xMin_m || distance_m > R.xMax_m) notes.push(`x = ${distance_m} m outside the calibration range ${R.xMin_m}–${R.xMax_m} m.`);
    if (toeDepth_m > 0 && (toeDepth_m < R.toeDepthMin_m || toeDepth_m > R.toeDepthMax_m)) notes.push(`Toe depth ${toeDepth_m} m outside the calibration range ${R.toeDepthMin_m}–${R.toeDepthMax_m} m.`);
    if (toeDepth_m === 0) notes.push('Toe depth 0 → r = x (slope distance taken equal to surface distance; conservative).');
    if (hammerEnergy_J < R.wMin_J || hammerEnergy_J > R.wMax_J) notes.push(`Hammer energy ${hammerEnergy_J} J outside the calibration range ${R.wMin_J}–${R.wMax_J} J.`);
    notes.push('k_p is a ground-condition factor (BS 5228-2 Table E.2); no exceedance probability is attached to it.');
  }
  return {
    ppv_mm_s: ppv,
    kp: isNum(kpUsed) ? kpUsed : NaN,
    r_m: r,
    formula: 'v = kp · √W / r^1.3,  r = √(L² + x²)',
    source: SOURCE_IMPACT,
    quantity: 'resultant PPV at the ground surface',
    groundCondition: isNum(kp) ? 'custom' : groundCondition,
    distance_m,
    toeDepth_m,
    hammerEnergy_J,
    notes
  };
}

/**
 * Site-calibrated power law v = K · x^(−n) (course §9.4, §15.5).
 *
 * @param {{ distance_m:number, K:number, n:number }} a
 * @returns {{ ppv_mm_s:number, K:number, n:number, distance_m:number, formula:string, source:string, notes:string[] }}
 */
export function predictPpvPowerLaw({ distance_m, K, n }) {
  const notes = [];
  if (!isNum(distance_m) || distance_m <= 0) notes.push('distance_m must be a positive number.');
  if (!isNum(K) || K <= 0) notes.push('K must be a positive number.');
  if (!isNum(n)) notes.push('n must be a number.');
  const ppv = notes.length ? NaN : K * Math.pow(distance_m, -n);
  return { ppv_mm_s: ppv, K, n, distance_m, formula: 'v = K · x^(−n)', source: 'site-calibrated power law (course §15.5–15.7)', notes };
}

/**
 * PPV-versus-distance curve for plotting.
 *
 * @param {object} a
 * @param {'vibratory'|'impact'|'powerLaw'} a.predictor
 * @param {object} a.args              predictor arguments (without distance_m)
 * @param {number[]} a.distances       distances (m)
 * @returns {{ predictor:string, points:{distance_m:number, ppv_mm_s:number}[], notes:string[] }}
 */
export function ppvVsDistanceCurve({ predictor, args = {}, distances = [] }) {
  /** @type {((a: any) => { ppv_mm_s:number, notes:string[] }) | null} */
  let fn = null;
  if (predictor === 'vibratory') fn = predictVibratoryPpv;
  else if (predictor === 'impact') fn = predictImpactPpv;
  else if (predictor === 'powerLaw') fn = predictPpvPowerLaw;
  if (!fn) return { predictor, points: [], notes: [`Unknown predictor '${predictor}'.`] };
  const noteSet = new Set();
  const points = distances.map((d) => {
    const r = fn({ ...args, distance_m: d });
    for (const n of r.notes) if (!/outside the (TRL 429 )?calibration range|^x = /.test(n)) noteSet.add(n);
    return { distance_m: d, ppv_mm_s: r.ppv_mm_s };
  });
  return { predictor, points, notes: [...noteSet] };
}
