#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifies src/lib/cpt-app/retaining/vibration/ppv-prediction.js against the course chapter
// §11.5 probability table (x = 30 m) and BS 5228-2:2009+A1:2014 Annex E (Tables E.1, E.2).
import { predictVibratoryPpv, predictImpactPpv, predictPpvPowerLaw, ppvVsDistanceCurve, TRL429_KV, TRL429_DELTA_V, BS5228_KP } from '../src/lib/cpt-app/retaining/vibration/ppv-prediction.js';

let fails = 0, n = 0;
function ok(name, cond, detail = '') { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; }
const close = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('== TRL 429 / BS 5228-2 coefficients ==');
ok('k_v = {60, 126, 266}', TRL429_KV[50] === 60 && TRL429_KV[33] === 126 && TRL429_KV[5] === 266);
ok('δ_v = {1.4 steady, 1.3 all, 1.2 start-up}', TRL429_DELTA_V.steady === 1.4 && TRL429_DELTA_V.all === 1.3 && TRL429_DELTA_V.startup === 1.2);

console.log('== Course §11.5 table, x = 30 m (values rounded to 3 decimals) ==');
const table = {
  steady: { 50: 0.513, 33: 1.078, 5: 2.275 },
  all: { 50: 0.721, 33: 1.514, 5: 3.196 },
  startup: { 50: 1.013, 33: 2.127, 5: 4.491 }
};
for (const phase of Object.keys(table)) for (const p of [50, 33, 5]) {
  const r = predictVibratoryPpv({ distance_m: 30, phase, probability: p });
  ok(`x=30 ${phase} k_v=${r.kv}: ${r.ppv_mm_s.toFixed(3)} ≈ ${table[phase][p]}`, close(r.ppv_mm_s, table[phase][p], 0.0006), r.formula);
}
{
  const r = predictVibratoryPpv({ distance_m: 30, phase: 'steady', probability: 5 });
  ok('30^1.4 = 116.94 (course §11.2)', close(Math.pow(30, 1.4), 116.944, 0.01), Math.pow(30, 1.4).toFixed(4));
  ok('result carries formula + source', r.formula === 'v = kv · x^(−δv)' && /TRL 429/.test(r.source) && /BS 5228-2/.test(r.source));
  ok('k_v = 266 flagged as screening envelope', r.notes.some((s) => /95th-percentile/.test(s)));
}
console.log('== Domain and behaviour ==');
ok('x = 0.5 m → out-of-range note', predictVibratoryPpv({ distance_m: 0.5 }).notes.some((s) => /outside the TRL 429 calibration range/.test(s)));
ok('x = 150 m → out-of-range note', predictVibratoryPpv({ distance_m: 150 }).notes.some((s) => /outside the TRL 429 calibration range/.test(s)));
ok('x = 30 m → no range note', !predictVibratoryPpv({ distance_m: 30 }).notes.some((s) => /outside/.test(s)));
ok('unknown phase → NaN + note, no throw', Number.isNaN(predictVibratoryPpv({ distance_m: 10, phase: 'bogus' }).ppv_mm_s));
ok('unknown probability → NaN + note', Number.isNaN(predictVibratoryPpv({ distance_m: 10, probability: 10 }).ppv_mm_s));
{
  const v = [5, 10, 20, 40, 80].map((x) => predictVibratoryPpv({ distance_m: x }).ppv_mm_s);
  ok('PPV decreases monotonically with distance', v.every((a, i) => i === 0 || a < v[i - 1]), v.map((x) => x.toFixed(2)).join(' → '));
  const p = [50, 33, 5].map((pr) => predictVibratoryPpv({ distance_m: 20, probability: pr }).ppv_mm_s);
  ok('lower exceedance probability ⇒ higher PPV', p[0] < p[1] && p[1] < p[2]);
  const ph = ['steady', 'all', 'startup'].map((s) => predictVibratoryPpv({ distance_m: 20, phase: s }).ppv_mm_s);
  ok('start-up > all > steady at x > 1 m', ph[0] < ph[1] && ph[1] < ph[2]);
}

console.log('== BS 5228-2 Annex E percussive piling ==');
ok('k_p Table E.2 = {5, 3, 1.5, 1}', BS5228_KP.refusal.kp === 5 && BS5228_KP.veryStiffDense.kp === 3 && BS5228_KP.stiffMediumDense.kp === 1.5 && BS5228_KP.softLoose.kp === 1);
{
  // hand check: kp = 5, W = 10 kJ, L = 10 m, x = 20 m → r = √500 = 22.3607; r^1.3 = e^(1.3·ln 22.3607) = e^(4.0394) = 56.79; v = 5·100/56.79 = 8.805
  const r = predictImpactPpv({ distance_m: 20, toeDepth_m: 10, hammerEnergy_J: 10000, groundCondition: 'refusal' });
  ok('r = √(L²+x²) = 22.361 m', close(r.r_m, Math.sqrt(500), 1e-9));
  ok('v = 5·√10000/22.361^1.3 ≈ 8.80 mm/s', close(r.ppv_mm_s, 5 * 100 / Math.pow(Math.sqrt(500), 1.3), 1e-9) && close(r.ppv_mm_s, 8.80, 0.02), r.ppv_mm_s.toFixed(3));
  ok('formula string names r = √(L² + x²)', /√\(L² \+ x²\)/.test(r.formula));
  ok('k_p documented as ground-condition factor (not probability)', r.notes.some((s) => /ground-condition factor/.test(s)));
  const soft = predictImpactPpv({ distance_m: 20, toeDepth_m: 10, hammerEnergy_J: 10000, groundCondition: 'softLoose' });
  ok('softLoose (k_p = 1) = refusal/5', close(soft.ppv_mm_s * 5, r.ppv_mm_s, 1e-9));
  const deeper = predictImpactPpv({ distance_m: 20, toeDepth_m: 25, hammerEnergy_J: 10000 });
  ok('deeper toe (larger r) ⇒ lower PPV', deeper.ppv_mm_s < r.ppv_mm_s);
  const w4 = predictImpactPpv({ distance_m: 20, toeDepth_m: 10, hammerEnergy_J: 40000 });
  ok('4× energy ⇒ 2× PPV (√W)', close(w4.ppv_mm_s / r.ppv_mm_s, 2, 1e-9));
  const far = predictImpactPpv({ distance_m: 120, toeDepth_m: 10, hammerEnergy_J: 10000 });
  ok('x = 120 m → range note', far.notes.some((s) => /outside the calibration range/.test(s)));
  const big = predictImpactPpv({ distance_m: 20, toeDepth_m: 10, hammerEnergy_J: 100000 });
  ok('W = 100 kJ → range note', big.notes.some((s) => /Hammer energy/.test(s)));
  ok('unknown ground condition → NaN + note', Number.isNaN(predictImpactPpv({ distance_m: 20, hammerEnergy_J: 1e4, groundCondition: 'x' }).ppv_mm_s));
  ok('explicit kp override honoured', close(predictImpactPpv({ distance_m: 20, toeDepth_m: 10, hammerEnergy_J: 1e4, kp: 2 }).ppv_mm_s, r.ppv_mm_s * 2 / 5, 1e-9));
}

console.log('== Power law and curve ==');
{
  const r = predictPpvPowerLaw({ distance_m: 30, K: 104.93, n: 1.3219 });
  ok('K = 104.93, n = 1.3219, x = 30 → 1.17 mm/s (course §15.5)', close(r.ppv_mm_s, 1.17, 0.005), r.ppv_mm_s.toFixed(3));
  const c = ppvVsDistanceCurve({ predictor: 'vibratory', args: { phase: 'steady', probability: 5 }, distances: [5, 10, 30, 100] });
  ok('curve has 4 points, x=30 matches scalar', c.points.length === 4 && close(c.points[2].ppv_mm_s, 2.275, 0.001));
  const ci = ppvVsDistanceCurve({ predictor: 'impact', args: { toeDepth_m: 10, hammerEnergy_J: 10000 }, distances: [10, 20] });
  ok('impact curve monotone', ci.points[0].ppv_mm_s > ci.points[1].ppv_mm_s);
  ok('unknown predictor → empty + note', ppvVsDistanceCurve({ predictor: 'nope', distances: [1] }).points.length === 0);
}

console.log(`\n${n - fails}/${n} OK${fails ? `, ${fails} FAIL` : ''}`);
process.exit(fails ? 1 : 0);
