// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Receiver (building) vibration limit frameworks. Each function is tied to ONE standard,
// says so in its result (`framework`), and is never mixed with another one.
//
// References
//   [SBR-A]   SBR Trillingsrichtlijn A: Schade aan bouwwerken: 2017 (SBRCURnet).
//             §9.5 Table 9.2 (γv), §10.3.2 Tables 10.6 (γt) and 10.7 (γs), §10.3.3 Table 10.8
//             (V_kar ground-floor load-bearing structure, categories 1 and 2), §10.3.4 Table 10.9
//             (highest floor / non-load-bearing parts), §10.3.5 (foundation: a_kar = 1 m/s²,
//             V_kar = 10·C_D, C_D = 1 + (8 − H)/7 ≤ 2, Table 10.11 factor applicability).
//             Category 3 (3 → 8 → 10 mm/s) exists only in the pre-2017 editions; the 2017 edition
//             replaced it by γs = 1.7 (kader 50). It is kept here as an explicitly labelled legacy line.
//   [EXAMPLE] worklog/course-text/T26L053 CN001A 20260827 LLTrillingsmonitoring.txt (Belgian practice):
//             V_top,allow = V_kar / (γs · γv · γt) — algebraically identical to SBR-A's
//             V_d = V_top·γv ≤ V_r = V_kar/(γt·γs).
//   [DIN]     DIN 4150-3:2016-12 Table 1 (short-term, foundation and top floor), Table 3 (long-term,
//             horizontal in the plane of the highest floor). Values unchanged from the 1999 edition.
//   [BS7385]  BS 7385-2:1993 Table 1 (transient guide values for cosmetic damage, at the base of the
//             building), continuous-vibration clause (reduction of up to 50 % when resonance amplifies).
//   [BS5228]  BS 5228-2:2009+A1:2014 Table B.1 (human response descriptors).
//   [COURSE]  course chapter §12 (BS 7385-2 line-2 interpolation formulas, DIN line-2 example).
//
// Units: velocities mm/s, frequency Hz, acceleration m/s². Pure functions, no DOM.

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Piecewise-linear interpolation on [[x, y], …] sorted by x; clamps outside the range.
 * @param {number[][]} table
 * @param {number} x
 */
function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < table.length; i++) {
    const [x0, y0] = table[i - 1], [x1, y1] = table[i];
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return last[1];
}

// ---------------------------------------------------------------------------------------------
// SBR-A (Trillingsrichtlijn A: Schade aan bouwwerken: 2017)
// ---------------------------------------------------------------------------------------------

/** SBR-A 2017 Table 10.8: V_kar (mm/s) for the ground-floor load-bearing structure, f in Hz. */
export const SBR_A_VKAR_GROUND_FLOOR = Object.freeze({
  1: [[0, 20], [10, 20], [50, 40], [100, 50]],
  2: [[0, 5], [10, 5], [50, 15], [100, 20]],
  /** legacy (SBR-A 2002/2006 category 3: monuments / poor-condition masonry) — not in the 2017 edition */
  3: [[0, 3], [10, 3], [50, 8], [100, 10]]
});

/** SBR-A 2017 Table 10.9: V_kar (mm/s) for the highest floor and non-load-bearing parts (all frequencies). */
export const SBR_A_VKAR_TOP_FLOOR = Object.freeze({ 1: 40, 2: 15, 3: 8 /* legacy */ });

/** SBR-A 2017 Table 10.7: γs (building condition and/or monumental status). */
export const SBR_A_GAMMA_S = Object.freeze({ normal: 1.0, sensitive: 1.7, monument: 1.7 });

/** SBR-A 2017 Table 9.2: γv (type of measurement). */
export const SBR_A_GAMMA_V = Object.freeze({ extensive: 1.0, limited: 1.4, indicative: 1.6 });

/** SBR-A 2017 Table 10.6: γt (type of vibration) for the structure/parts and for the foundation (settlement). */
export const SBR_A_GAMMA_T = Object.freeze({
  structure: Object.freeze({ short: 1.0, repeated: 1.5, continuous: 2.5 }),
  foundation: Object.freeze({ short: 1.0, repeated: 1.6, continuous: 2.0 })
});

/** SBR-A 2017 §10.3.5: characteristic acceleration limit for settlement-sensitive foundations. */
export const SBR_A_A_KAR_M_S2 = 1.0;

/**
 * SBR-A 2017 §10.3.5 layer-thickness factor C_D = 1 + (8 − H)/7, capped at 2 (H ≤ 8 m).
 * Unknown thickness → C_D = 1 (H = 8 m, the conservative end of Table 10.10).
 * @param {number|undefined} H_m thickness of the settlement-sensitive layer under the building (m)
 */
export function sbrALayerFactorCD(H_m) {
  if (!isNum(H_m)) return 1;
  const H = Math.min(Math.max(H_m, 0), 8);
  return Math.min(2, 1 + (8 - H) / 7);
}

/**
 * SBR-A allowable measured top velocity V_top,allow = V_kar / (γs · γv · γt).
 *
 * @param {object} a
 * @param {1|2|3} a.category                   building category (3 = legacy pre-2017 line, flagged)
 * @param {'normal'|'sensitive'|'monument'} [a.condition='normal']
 * @param {'extensive'|'limited'|'indicative'} [a.measurementType='indicative']
 * @param {'short'|'repeated'|'continuous'} [a.vibrationType='repeated']
 * @param {number} [a.frequency_Hz=0]           dominant frequency (ground-floor structure only)
 * @param {'structure'|'topFloor'|'foundation'} [a.part='structure']
 * @param {number} [a.layerThickness_m]         settlement-sensitive layer thickness H (foundation only)
 * @returns {{ framework:string, part:string, category:number, condition:string, measurementType:string, vibrationType:string,
 *            frequency_Hz:number, vKar:number, gammaS:number, gammaV:number, gammaT:number, cD:number,
 *            vAllow:number, vR:number, aKar_m_s2:number|null, aAllow_m_s2:number|null,
 *            formula:string, quantity:string, source:string, notes:string[] }}
 */
export function sbrAAllowableVelocity({ category, condition = 'normal', measurementType = 'indicative', vibrationType = 'repeated', frequency_Hz = 0, part = 'structure', layerThickness_m }) {
  const notes = [];
  const gammaS = SBR_A_GAMMA_S[condition];
  const gammaV = SBR_A_GAMMA_V[measurementType];
  const gtTable = part === 'foundation' ? SBR_A_GAMMA_T.foundation : SBR_A_GAMMA_T.structure;
  const gammaT = gtTable[vibrationType];
  if (!isNum(gammaS)) notes.push(`Unknown condition '${condition}' (normal | sensitive | monument).`);
  if (!isNum(gammaV)) notes.push(`Unknown measurementType '${measurementType}' (extensive | limited | indicative).`);
  if (!isNum(gammaT)) notes.push(`Unknown vibrationType '${vibrationType}' (short | repeated | continuous).`);
  if (!['structure', 'topFloor', 'foundation'].includes(part)) notes.push(`Unknown part '${part}' (structure | topFloor | foundation).`);

  let vKar = NaN, cD = 1, aKar = null, aAllow = null;
  if (part === 'foundation') {
    cD = sbrALayerFactorCD(layerThickness_m);
    vKar = 10 * cD;
    aKar = SBR_A_A_KAR_M_S2;
    aAllow = isNum(gammaV) ? aKar / gammaV : NaN;
    if (!isNum(layerThickness_m)) notes.push('Settlement-sensitive layer thickness unknown → C_D = 1 (V_kar,foundation = 10 mm/s).');
    notes.push('Foundation criterion (SBR-A §10.3.5) is frequency-independent; a_kar = 1 m/s² is divided by γv only (Table 10.11: γt, γs, C_D do not apply to the acceleration).');
  } else {
    const tbl = part === 'topFloor' ? null : SBR_A_VKAR_GROUND_FLOOR[category];
    if (part === 'topFloor') {
      vKar = SBR_A_VKAR_TOP_FLOOR[category];
      if (!isNum(vKar)) notes.push(`Unknown category ${category}.`);
      else notes.push('Highest-floor / non-load-bearing V_kar (Table 10.9) is frequency-independent.');
    } else if (!tbl) {
      notes.push(`Unknown category ${category} (1 | 2 | 3-legacy).`);
    } else {
      if (!isNum(frequency_Hz) || frequency_Hz < 0) notes.push('frequency_Hz must be ≥ 0.');
      else {
        vKar = interp(tbl, frequency_Hz);
        if (frequency_Hz > 100) notes.push('SBR-A covers 0–100 Hz; the 100 Hz value is used above 100 Hz.');
      }
    }
    if (category === 3) notes.push('Category 3 is the pre-2017 SBR-A line (3 → 8 → 10 mm/s). SBR-A 2017 has no category 3: use category 2 with condition "sensitive"/"monument" (γs = 1.7) instead.');
  }
  const ok = notes.every((n) => !/^Unknown|must be/.test(n)) && isNum(vKar);
  const vR = ok ? vKar / (gammaT * gammaS) : NaN;
  const vAllow = ok ? vKar / (gammaS * gammaV * gammaT) : NaN;
  return {
    framework: 'SBR-A 2017',
    part, category, condition, measurementType, vibrationType, frequency_Hz,
    vKar, gammaS, gammaV, gammaT, cD,
    vR,
    vAllow,
    aKar_m_s2: aKar,
    aAllow_m_s2: aAllow,
    formula: 'V_top,allow = V_kar / (γs · γv · γt)  ⇔  V_d = V_top · γv ≤ V_r = V_kar / (γt · γs)',
    quantity: 'peak velocity component V_top at the measuring point (SBR-A §9)',
    source: 'SBR Trillingsrichtlijn A: Schade aan bouwwerken: 2017, Tables 9.2, 10.6, 10.7, 10.8, 10.9; §10.3.5',
    notes
  };
}

// ---------------------------------------------------------------------------------------------
// DIN 4150-3:2016-12
// ---------------------------------------------------------------------------------------------

/** DIN 4150-3 Table 1: short-term guideline values v_i (mm/s) at the foundation, by line and frequency. */
export const DIN4150_TABLE1_FOUNDATION = Object.freeze({
  1: [[1, 20], [10, 20], [50, 40], [100, 50]],
  2: [[1, 5], [10, 5], [50, 15], [100, 20]],
  3: [[1, 3], [10, 3], [50, 8], [100, 10]]
});

/** DIN 4150-3 Table 1: short-term, horizontal, plane of the floor of the uppermost storey (all frequencies). */
export const DIN4150_TABLE1_TOP_FLOOR = Object.freeze({ 1: 40, 2: 15, 3: 8 });

/** DIN 4150-3 Table 3: long-term, horizontal, plane of the floor of the uppermost storey (all frequencies). */
export const DIN4150_TABLE3_LONG_TERM = Object.freeze({ 1: 10, 2: 5, 3: 2.5 });

export const DIN4150_LINES = Object.freeze({
  1: 'Buildings used for commercial purposes, industrial buildings and buildings of similar design',
  2: 'Dwellings and buildings of similar design and/or occupancy',
  3: 'Structures of particular sensitivity / great intrinsic value (e.g. listed buildings)'
});

/**
 * DIN 4150-3 guideline value.
 *
 * @param {object} a
 * @param {1|2|3} a.line
 * @param {number} [a.frequency_Hz]       required for location 'foundation' with short-term duration
 * @param {'foundation'|'topFloor'} [a.location='foundation']
 * @param {'short'|'long'} [a.duration='short']
 * @returns {{ framework:string, line:number, lineDescription?:string, location:string, duration:string, frequency_Hz?:number,
 *            limit_mm_s:number, quantity:string, source?:string, notes:string[] }}
 */
export function din4150Guideline({ line, frequency_Hz, location = 'foundation', duration = 'short' }) {
  const notes = [];
  if (!DIN4150_LINES[line]) return { framework: 'DIN 4150-3:2016', limit_mm_s: NaN, quantity: '', line, location, duration, notes: [`Unknown line ${line} (1 | 2 | 3).`] };
  let limit = NaN, quantity = '';
  if (duration === 'long') {
    limit = DIN4150_TABLE3_LONG_TERM[line];
    quantity = 'max. horizontal velocity component in the plane of the floor of the uppermost storey (Table 3, all frequencies)';
    if (location === 'foundation') notes.push('DIN 4150-3 Table 3 (long-term) is defined at the uppermost floor, not at the foundation; the Table 3 value is returned.');
    notes.push('DIN "short-term" is about absence of fatigue/resonance, not calendar duration; vibratory piling may fall under long-term provisions.');
  } else if (location === 'topFloor') {
    limit = DIN4150_TABLE1_TOP_FLOOR[line];
    quantity = 'max. horizontal velocity component in the plane of the floor of the uppermost storey (Table 1, all frequencies)';
  } else {
    if (!isNum(frequency_Hz) || frequency_Hz <= 0) notes.push('frequency_Hz (> 0) is required for the foundation short-term value.');
    else {
      limit = interp(DIN4150_TABLE1_FOUNDATION[line], frequency_Hz);
      if (frequency_Hz > 100) notes.push('Above 100 Hz at least the 100 Hz value applies (Table 1 footnote).');
      if (frequency_Hz < 1) notes.push('Table 1 starts at 1 Hz; the 1 Hz value is used.');
    }
    quantity = 'max. absolute velocity component (x, y or z) at the foundation (Table 1, short-term)';
  }
  return {
    framework: 'DIN 4150-3:2016',
    line, lineDescription: DIN4150_LINES[line], location, duration, frequency_Hz,
    limit_mm_s: limit,
    quantity,
    source: 'DIN 4150-3:2016-12 Table 1 (short-term) / Table 3 (long-term)',
    notes
  };
}

// ---------------------------------------------------------------------------------------------
// BS 7385-2:1993
// ---------------------------------------------------------------------------------------------

export const BS7385_LINES = Object.freeze({
  1: 'Reinforced or framed structures; industrial and heavy commercial buildings',
  2: 'Unreinforced or light framed structures; residential or light commercial buildings'
});

/**
 * BS 7385-2:1993 Table 1 transient guide value for cosmetic damage (peak component PPV at the building base).
 * Line 1: 50 mm/s at 4 Hz and above. Line 2: 15 at 4 Hz → 20 at 15 Hz → 50 at 40 Hz and above
 * (linear interpolation as in course §12.3: 15 + 5/11·(f−4); 20 + 30/25·(f−15)).
 *
 * @param {{ line:1|2, frequency_Hz:number, continuous?:boolean }} a
 * @returns {{ framework:string, line:number, lineDescription?:string, frequency_Hz:number, continuous?:boolean,
 *            limit_mm_s:number, transient_mm_s:number, reductionFactor:number, quantity?:string, source?:string, notes:string[] }}
 */
export function bs7385Guideline({ line, frequency_Hz, continuous = false }) {
  const notes = [];
  if (!BS7385_LINES[line]) return { framework: 'BS 7385-2:1993', limit_mm_s: NaN, transient_mm_s: NaN, reductionFactor: 1, line, frequency_Hz, notes: [`Unknown line ${line} (1 | 2).`] };
  if (!isNum(frequency_Hz) || frequency_Hz <= 0) return { framework: 'BS 7385-2:1993', limit_mm_s: NaN, transient_mm_s: NaN, reductionFactor: 1, line, frequency_Hz, notes: ['frequency_Hz (> 0) is required.'] };
  const f = Math.max(frequency_Hz, 4);
  let transient;
  if (line === 1) transient = 50;
  else if (f <= 15) transient = 15 + (5 / 11) * (f - 4);
  else if (f < 40) transient = 20 + (30 / 25) * (f - 15);
  else transient = 50;
  if (frequency_Hz < 4) notes.push('Below 4 Hz BS 7385-2 also limits displacement (line 2: 0.6 mm zero-to-peak); the 4 Hz velocity value is used here — consult the standard.');
  const reductionFactor = continuous ? 0.5 : 1;
  if (continuous) notes.push('Continuous vibration able to excite resonance: guide values reduced by 50 % (BS 7385-2 allows a reduction of up to 50 %; conditional, not automatic).');
  notes.push('Guide values are peak COMPONENT PPV at the building base; comparing a predicted RESULTANT PPV against them is conservative.');
  return {
    framework: 'BS 7385-2:1993',
    line, lineDescription: BS7385_LINES[line], frequency_Hz, continuous,
    transient_mm_s: transient,
    reductionFactor,
    limit_mm_s: transient * reductionFactor,
    quantity: 'peak component particle velocity at the base of the building',
    source: 'BS 7385-2:1993 Table 1; continuous-vibration clause (§7.5)',
    notes
  };
}

// ---------------------------------------------------------------------------------------------
// Human response — BS 5228-2:2009+A1:2014 Table B.1
// ---------------------------------------------------------------------------------------------

/** BS 5228-2 Table B.1 descriptors (PPV at the point of entry into the recipient). */
export const BS5228_HUMAN_RESPONSE = Object.freeze([
  { ppv_mm_s: 0.14, effect: 'Vibration might be just perceptible in the most sensitive situations for most vibration frequencies associated with construction.' },
  { ppv_mm_s: 0.3, effect: 'Vibration might be just perceptible in residential environments.' },
  { ppv_mm_s: 1.0, effect: 'Likely to cause complaint in residential environments, but can be tolerated if prior warning and explanation has been given to residents.' },
  { ppv_mm_s: 10, effect: 'Likely to be intolerable for any more than a very brief exposure to this level in most building environments.' }
]);

/**
 * @param {number} ppv_mm_s
 * @returns {{ framework:string, ppv_mm_s:number, band:string, threshold_mm_s:number|null, descriptor:string, notes:string[] }}
 */
export function humanResponseDescriptor(ppv_mm_s) {
  const notes = ['Human-response descriptors are not building-damage limits (BS 5228-2 Annex B); a formal assessment uses BS 6472-1.'];
  if (!isNum(ppv_mm_s) || ppv_mm_s < 0) return { framework: 'BS 5228-2 Table B.1', ppv_mm_s, band: 'invalid', threshold_mm_s: null, descriptor: '', notes: ['ppv_mm_s must be ≥ 0.'] };
  let hit = null;
  for (const row of BS5228_HUMAN_RESPONSE) if (ppv_mm_s >= row.ppv_mm_s) hit = row;
  if (!hit) return { framework: 'BS 5228-2 Table B.1', ppv_mm_s, band: 'below perception threshold', threshold_mm_s: null, descriptor: 'Below 0.14 mm/s: below the typical threshold of perception (BS 5228-2 B.2).', notes };
  const band = hit.ppv_mm_s >= 10 ? 'intolerable' : hit.ppv_mm_s >= 1 ? 'complaints likely' : hit.ppv_mm_s >= 0.3 ? 'perceptible (residential)' : 'perceptible (sensitive situations)';
  return { framework: 'BS 5228-2 Table B.1', ppv_mm_s, band, threshold_mm_s: hit.ppv_mm_s, descriptor: hit.effect, notes };
}

// ---------------------------------------------------------------------------------------------
// Common wrapper
// ---------------------------------------------------------------------------------------------

/**
 * Compare a predicted PPV with ONE receiver framework.
 *
 * @param {object} a
 * @param {number} a.predictedPpv_mm_s
 * @param {number} a.frequency_Hz
 * @param {'SBR-A'|'DIN4150-3'|'BS7385-2'} a.framework
 * @param {Record<string, any>} [a.frameworkArgs]     arguments of the framework function (frequency is injected)
 * @param {number} [a.attentionFraction=0.75]  utilisation above which the verdict is 'attention'
 * @returns {{ framework:string, predictedPpv_mm_s:number, frequency_Hz:number, limit_mm_s:number, utilisation:number,
 *            verdict:'ok'|'attention'|'exceeds'|'undefined', human:object, detail:object|null, notes:string[] }}
 */
export function assessReceiver({ predictedPpv_mm_s, frequency_Hz, framework, frameworkArgs = {}, attentionFraction = 0.75 }) {
  const notes = [];
  const args = /** @type {any} */ (frameworkArgs);
  let detail, limit = NaN;
  if (framework === 'SBR-A') { detail = sbrAAllowableVelocity({ ...args, frequency_Hz }); limit = detail.vAllow; }
  else if (framework === 'DIN4150-3') { detail = din4150Guideline({ ...args, frequency_Hz }); limit = detail.limit_mm_s; }
  else if (framework === 'BS7385-2') { detail = bs7385Guideline({ ...args, frequency_Hz }); limit = detail.limit_mm_s; }
  else { detail = null; notes.push(`Unknown framework '${framework}' (SBR-A | DIN4150-3 | BS7385-2).`); }
  if (detail) notes.push(...detail.notes);
  const human = humanResponseDescriptor(predictedPpv_mm_s);
  let utilisation = NaN;
  /** @type {'ok'|'attention'|'exceeds'|'undefined'} */
  let verdict = 'undefined';
  if (isNum(limit) && limit > 0 && isNum(predictedPpv_mm_s)) {
    utilisation = predictedPpv_mm_s / limit;
    verdict = utilisation >= 1 ? 'exceeds' : utilisation >= attentionFraction ? 'attention' : 'ok';
  } else notes.push('Limit undefined; no verdict.');
  notes.push('The predicted value is a resultant PPV at the ground surface; the framework limit refers to its own quantity/location (see detail.quantity). Do not mix frameworks.');
  return { framework: detail ? detail.framework : framework, predictedPpv_mm_s, frequency_Hz, limit_mm_s: limit, utilisation, verdict, human, detail, notes };
}
