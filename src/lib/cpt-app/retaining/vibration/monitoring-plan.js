// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Trigger-action (traffic-light) monitoring plan for construction vibration.
//
// References
//   [COURSE]  course chapter §16 (expected / warning / stop / structural guide / human objective),
//             §15.2 (sensor layout: ~5 m control, ~10 m, ~20 m, receiver).
//   [EXAMPLE] worklog/course-text/T26L053 ... LLTrillingsmonitoring.txt: alarm at the SBR-A limit,
//             SMS at 75 % of the limit, frequency table 0–100 Hz in 5 Hz steps (Figuur 2).
//
// Units: mm/s, Hz, m. Pure; caveats in `notes`.
//
// Assumptions
//   * The stop level is the receiver limit of the selected framework (the example sets the alarm
//     at V_top,allow). A project may choose a lower stop level; pass `stop_mm_s` to override.
//   * warning = warningFraction × stop (default 0.75, as in the example's 75 % SMS).
//   * The frequency table is SBR-A style: for DIN 4150-3 / BS 7385-2 the "vKar" column holds the
//     guideline value and "vAllow" equals it (those standards have no partial factors).

import { sbrAAllowableVelocity, din4150Guideline, bs7385Guideline, humanResponseDescriptor } from './receiver-criteria.js';

/** @param {unknown} v @returns {v is number} */
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Limit at a frequency for one framework → { vKar, vAllow, framework, notes }.
 * @param {string} framework
 * @param {Record<string, any>} frameworkArgs
 * @param {number} f
 * @returns {{ vKar:number, vAllow:number, framework:string, notes:string[] }}
 */
function limitAt(framework, frameworkArgs, f) {
  const args = /** @type {any} */ (frameworkArgs);
  if (framework === 'SBR-A') { const r = sbrAAllowableVelocity({ ...args, frequency_Hz: f }); return { vKar: r.vKar, vAllow: r.vAllow, framework: r.framework, notes: r.notes }; }
  if (framework === 'DIN4150-3') { const r = din4150Guideline({ ...args, frequency_Hz: Math.max(f, 1) }); return { vKar: r.limit_mm_s, vAllow: r.limit_mm_s, framework: r.framework, notes: r.notes }; }
  if (framework === 'BS7385-2') { const r = bs7385Guideline({ ...args, frequency_Hz: Math.max(f, 4) }); return { vKar: r.transient_mm_s, vAllow: r.limit_mm_s, framework: r.framework, notes: r.notes }; }
  return { vKar: NaN, vAllow: NaN, framework, notes: [`Unknown framework '${framework}'.`] };
}

/**
 * Sensor-layout suggestion (course §15.2): near-field control ≈ 5 m, ≈ 10 m, ≈ 20 m, receiver.
 * @param {number} receiverDistance_m
 * @returns {{ sensors:{ role:string, distance_m:number, mounting:string }[], notes:string[] }}
 */
export function suggestSensorLayout(receiverDistance_m) {
  const notes = [];
  if (!isNum(receiverDistance_m) || receiverDistance_m <= 0) return { sensors: [], notes: ['receiverDistance_m must be a positive number.'] };
  const ground = 'triaxial geophone rigidly coupled to the ground surface (not loose on paving)';
  const candidates = [
    { role: 'near-field control (source repeatability)', distance_m: 5, mounting: ground },
    { role: 'intermediate (attenuation fit)', distance_m: 10, mounting: ground },
    { role: 'intermediate (attenuation fit)', distance_m: 20, mounting: ground }
  ].filter((s) => s.distance_m < receiverDistance_m * 0.8);
  const sensors = [...candidates, { role: 'receiver', distance_m: receiverDistance_m, mounting: 'rigidly attached to the lowest accessible load-bearing element on the source-facing side; radial/transverse/vertical documented' }];
  if (candidates.length < 2) notes.push('Receiver is close to the source: use at least a near-field control point and the receiver sensor; an attenuation fit needs ≥ 3 distances.');
  notes.push('All devices need a common time reference; record depth, frequency and moment setting simultaneously (course §15.3).');
  return { sensors, notes };
}

/**
 * Build the trigger-action plan.
 *
 * @param {object} a
 * @param {'SBR-A'|'DIN4150-3'|'BS7385-2'} a.framework
 * @param {Record<string, any>} [a.frameworkArgs]  arguments for the framework's limit function (frequency injected)
 * @param {number} a.dominantFrequency_Hz        frequency used for the scalar stop level
 * @param {{ expected_mm_s?:number, upper_mm_s?:number }} [a.prediction]   e.g. TRL 429 k_v = 60 and 266
 * @param {number} [a.warningFraction=0.75]
 * @param {number} [a.stop_mm_s]                 override of the stop level (must not exceed the framework limit)
 * @param {number} [a.structuralGuide_mm_s]      optional separate structural guide (e.g. unfactored V_kar or BS 7385-2 value)
 * @param {number} [a.humanObjective_mm_s=1.0]   human-response objective (BS 5228-2 Table B.1: 1.0 mm/s complaints likely)
 * @param {number} [a.receiverDistance_m]
 * @param {number} [a.fStep_Hz=5]
 * @returns {{ framework:string, dominantFrequency_Hz:number, expected:object, upper:object, warning:object, stop:object,
 *            structuralGuide:object, humanObjective:object,
 *            frequencyTable:{ f:number, vKar:number, vAllow:number, warning:number }[], sensorLayout:object, states:object[], notes:string[] }}
 */
export function buildMonitoringPlan({ framework, frameworkArgs = {}, dominantFrequency_Hz, prediction = {}, warningFraction = 0.75, stop_mm_s, structuralGuide_mm_s, humanObjective_mm_s = 1.0, receiverDistance_m, fStep_Hz = 5 }) {
  const notes = [];
  if (!isNum(warningFraction) || warningFraction <= 0 || warningFraction >= 1) { notes.push('warningFraction must be in (0, 1); 0.75 used.'); warningFraction = 0.75; }
  const fDom = isNum(dominantFrequency_Hz) ? dominantFrequency_Hz : 0;
  if (!isNum(dominantFrequency_Hz)) notes.push('dominantFrequency_Hz missing → lowest-frequency (most conservative) limit used for the stop level.');
  const lim = limitAt(framework, frameworkArgs, fDom);
  notes.push(...lim.notes);

  let stop = lim.vAllow;
  if (isNum(stop_mm_s)) {
    if (isNum(lim.vAllow) && stop_mm_s > lim.vAllow) notes.push(`Requested stop level ${stop_mm_s} mm/s exceeds the ${lim.framework} limit ${lim.vAllow.toFixed(2)} mm/s; the framework limit is used.`);
    else stop = stop_mm_s;
  }
  const warning = isNum(stop) ? warningFraction * stop : NaN;
  const expectedV = prediction.expected_mm_s, upperV = prediction.upper_mm_s;
  if (isNum(upperV) && isNum(stop) && upperV > stop) notes.push('Upper prediction exceeds the stop level: the method (moment/frequency control, distance, alternative system) must be revised before work starts.');
  else if (isNum(upperV) && isNum(warning) && upperV > warning) notes.push('Upper prediction exceeds the warning level: expect amber events; plan the operational response.');

  const frequencyTable = [];
  for (let f = 0; f <= 100 + 1e-9; f += fStep_Hz) {
    const r = limitAt(framework, frameworkArgs, f);
    frequencyTable.push({ f, vKar: r.vKar, vAllow: r.vAllow, warning: isNum(r.vAllow) ? warningFraction * r.vAllow : NaN });
  }

  const states = [
    { state: 'green', condition: `PPV < warning (${isNum(warning) ? warning.toFixed(2) : '?'} mm/s), stable penetration, no abnormal movement`, action: 'Continue; log data; review trends.' },
    { state: 'amber', condition: `warning ≤ PPV < stop, or expected upper prediction (${isNum(upperV) ? upperV.toFixed(2) : '?'} mm/s) reached, PPV rising with depth, penetration rate falling, complaint`, action: 'Reduce eccentric moment / adjust frequency; pause if needed; verify sensors and alignment; review depth and settings.' },
    { state: 'red', condition: `PPV ≥ stop (${isNum(stop) ? stop.toFixed(2) : '?'} mm/s), abnormal building/ground movement, sensor overload, prolonged refusal`, action: 'Stop immediately; inspect; notify the responsible engineer; revise the method before restart.' }
  ];
  notes.push('Stop level must sit below the receiver limit by an allowance for instrument uncertainty, signal delay and run-down vibration (course §16.1); the framework limit is only the ceiling.');

  return {
    framework: lim.framework,
    dominantFrequency_Hz: fDom,
    expected: { value: expectedV, unit: 'mm/s', note: 'median-type prediction (e.g. TRL 429 k_v = 60)' },
    upper: { value: upperV, unit: 'mm/s', note: 'conservative prediction (e.g. TRL 429 k_v = 266) — prediction-review level' },
    warning: { value: warning, unit: 'mm/s', fraction: warningFraction, note: `${Math.round(warningFraction * 100)} % of the stop level (SMS/notification level as in the example)` },
    stop: { value: stop, unit: 'mm/s', note: `alarm/stop level = ${lim.framework} allowable value${isNum(stop_mm_s) && stop === stop_mm_s ? ' (project override)' : ''}` },
    structuralGuide: { value: isNum(structuralGuide_mm_s) ? structuralGuide_mm_s : lim.vKar, unit: 'mm/s', note: isNum(structuralGuide_mm_s) ? 'project-supplied structural guide' : `unfactored characteristic/guide value of ${lim.framework} at ${fDom} Hz` },
    humanObjective: { value: humanObjective_mm_s, unit: 'mm/s', descriptor: humanResponseDescriptor(humanObjective_mm_s).descriptor, note: 'BS 5228-2 Table B.1 human-response objective; not a damage limit' },
    frequencyTable,
    sensorLayout: isNum(receiverDistance_m) ? suggestSensorLayout(receiverDistance_m) : { sensors: [], notes: ['receiverDistance_m not given.'] },
    states,
    notes
  };
}
