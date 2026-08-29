#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifies src/lib/cpt-app/retaining/vibration/receiver-criteria.js and monitoring-plan.js against:
//   * the SBR-A example note (T26L053 CN001A: cat. 2, sensitive, indicative, repeated short-term),
//   * SBR-A 2017 worked examples (kader 50; summary examples: 38 Hz continuous, 10 Hz piling),
//   * DIN 4150-3 Table 1 / Table 3 and the course §12.5 numbers,
//   * BS 7385-2 Table 1 and the course §12.5 numbers (35 Hz → 44 mm/s; 15 → 7.5 mm/s),
//   * BS 5228-2 Table B.1 descriptors.
import { sbrAAllowableVelocity, din4150Guideline, bs7385Guideline, humanResponseDescriptor, assessReceiver, sbrALayerFactorCD, SBR_A_GAMMA_T, SBR_A_GAMMA_V, SBR_A_GAMMA_S } from '../src/lib/cpt-app/retaining/vibration/receiver-criteria.js';
import { buildMonitoringPlan, suggestSensorLayout } from '../src/lib/cpt-app/retaining/vibration/monitoring-plan.js';

let fails = 0, n = 0;
function ok(name, cond, detail = '') { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; }
const close = (a, b, tol) => Math.abs(a - b) <= tol;

console.log('== SBR-A 2017 partial factors ==');
ok('γt structure = 1.0 / 1.5 / 2.5 (Table 10.6)', SBR_A_GAMMA_T.structure.short === 1 && SBR_A_GAMMA_T.structure.repeated === 1.5 && SBR_A_GAMMA_T.structure.continuous === 2.5);
ok('γt foundation = 1.0 / 1.6 / 2.0 (Table 10.6)', SBR_A_GAMMA_T.foundation.short === 1 && SBR_A_GAMMA_T.foundation.repeated === 1.6 && SBR_A_GAMMA_T.foundation.continuous === 2.0);
ok('γv = 1.0 / 1.4 / 1.6 (Table 9.2)', SBR_A_GAMMA_V.extensive === 1 && SBR_A_GAMMA_V.limited === 1.4 && SBR_A_GAMMA_V.indicative === 1.6);
ok('γs = 1.0 / 1.7 (Table 10.7)', SBR_A_GAMMA_S.normal === 1 && SBR_A_GAMMA_S.sensitive === 1.7 && SBR_A_GAMMA_S.monument === 1.7);

console.log('== SBR-A example note (cat. 2, sensitive, indicative, repeated short-term) ==');
const ex = { category: 2, condition: 'sensitive', measurementType: 'indicative', vibrationType: 'repeated' };
{
  const r0 = sbrAAllowableVelocity({ ...ex, frequency_Hz: 0 });
  ok('factors 1.7 · 1.6 · 1.5', r0.gammaS === 1.7 && r0.gammaV === 1.6 && r0.gammaT === 1.5);
  ok('V_kar(0 Hz) = 5 mm/s', r0.vKar === 5);
  ok('V_top,allow(≤10 Hz) = 1.23 mm/s', close(r0.vAllow, 1.23, 0.005), r0.vAllow.toFixed(3));
  ok('10 Hz → 1.23', close(sbrAAllowableVelocity({ ...ex, frequency_Hz: 10 }).vAllow, 1.23, 0.005));
  ok('15 Hz → V_kar 6.25, 1.53', close(sbrAAllowableVelocity({ ...ex, frequency_Hz: 15 }).vKar, 6.25, 1e-9) && close(sbrAAllowableVelocity({ ...ex, frequency_Hz: 15 }).vAllow, 1.53, 0.005));
  ok('30 Hz → V_kar 10, 2.45', close(sbrAAllowableVelocity({ ...ex, frequency_Hz: 30 }).vAllow, 2.45, 0.005));
  ok('50 Hz → V_kar 15, 3.68', close(sbrAAllowableVelocity({ ...ex, frequency_Hz: 50 }).vAllow, 3.68, 0.005));
  ok('75 Hz → V_kar 17.5, 4.29', close(sbrAAllowableVelocity({ ...ex, frequency_Hz: 75 }).vKar, 17.5, 1e-9) && close(sbrAAllowableVelocity({ ...ex, frequency_Hz: 75 }).vAllow, 4.29, 0.005));
  ok('100 Hz → V_kar 20, 4.90', close(sbrAAllowableVelocity({ ...ex, frequency_Hz: 100 }).vAllow, 4.90, 0.005));
  const top = sbrAAllowableVelocity({ ...ex, part: 'topFloor' });
  ok('top floor / non-load-bearing: V_kar 15 → 3.68 mm/s', top.vKar === 15 && close(top.vAllow, 3.68, 0.005), top.vAllow.toFixed(3));
  const fnd = sbrAAllowableVelocity({ ...ex, part: 'foundation' });
  ok('foundation: V_kar 10 (C_D = 1), γt = 1.6 → 2.30 mm/s', fnd.vKar === 10 && fnd.gammaT === 1.6 && close(fnd.vAllow, 2.30, 0.005), fnd.vAllow.toFixed(3));
  ok('foundation: a_kar = 1 m/s², a_top,allow = 1/γv = 0.625 m/s²', fnd.aKar_m_s2 === 1 && close(fnd.aAllow_m_s2, 1 / 1.6, 1e-9));
  ok('framework tag = SBR-A 2017', r0.framework === 'SBR-A 2017' && /V_kar \/ \(γs · γv · γt\)/.test(r0.formula));
}
console.log('== SBR-A 2017 guideline examples ==');
{
  const k50 = sbrAAllowableVelocity({ category: 2, condition: 'monument', measurementType: 'extensive', vibrationType: 'continuous', frequency_Hz: 10 });
  ok('kader 50: cat 2 monument continuous 10 Hz → V_r = 5/2.5/1.7 = 1.18', close(k50.vR, 1.18, 0.005) && close(k50.vAllow, 1.18, 0.005), k50.vR.toFixed(3));
  const c38 = sbrAAllowableVelocity({ category: 2, condition: 'normal', measurementType: 'indicative', vibrationType: 'continuous', frequency_Hz: 38 });
  ok('summary: cat 2, 38 Hz continuous, indicative → V_kar 12.0, 12/2.5/1.6 = 3.00', close(c38.vKar, 12, 1e-9) && close(c38.vAllow, 3.0, 0.005), c38.vAllow.toFixed(3));
  const c38s = sbrAAllowableVelocity({ category: 2, condition: 'sensitive', measurementType: 'indicative', vibrationType: 'continuous', frequency_Hz: 38 });
  ok('… sensitive → 1.76', close(c38s.vAllow, 1.76, 0.005), c38s.vAllow.toFixed(3));
  const c38l = sbrAAllowableVelocity({ category: 2, condition: 'normal', measurementType: 'limited', vibrationType: 'continuous', frequency_Hz: 38 });
  ok('… limited (γv 1.4), normal → 3.43', close(c38l.vAllow, 3.43, 0.01), c38l.vAllow.toFixed(3));
  const p10 = sbrAAllowableVelocity({ category: 2, condition: 'normal', measurementType: 'indicative', vibrationType: 'repeated', frequency_Hz: 10 });
  ok('summary: piling cat 2, 10 Hz, repeated, indicative → 5/1.5/1.6 = 2.08', close(p10.vAllow, 2.083, 0.005), p10.vAllow.toFixed(3));
  const c1 = sbrAAllowableVelocity({ category: 1, condition: 'normal', measurementType: 'extensive', vibrationType: 'short', frequency_Hz: 15 });
  ok('Table 10.8 cat 1: 15 Hz → 22.5; 55 Hz → 41; 100 Hz → 50', close(c1.vKar, 22.5, 1e-9) && close(sbrAAllowableVelocity({ category: 1, frequency_Hz: 55 }).vKar, 41, 1e-9) && close(sbrAAllowableVelocity({ category: 1, frequency_Hz: 100 }).vKar, 50, 1e-9));
  ok('Table 10.9 cat 1 top floor = 40', sbrAAllowableVelocity({ category: 1, part: 'topFloor' }).vKar === 40);
  const c3 = sbrAAllowableVelocity({ category: 3, condition: 'normal', measurementType: 'extensive', vibrationType: 'short', frequency_Hz: 50 });
  ok('legacy category 3: 3 → 8 → 10 with explicit legacy note', c3.vKar === 8 && c3.notes.some((s) => /pre-2017/.test(s)));
  ok('C_D: H=1 → 2.00, H=4 → 1.57, H=8 → 1.00, cap 2', close(sbrALayerFactorCD(1), 2, 1e-9) && close(sbrALayerFactorCD(4), 1.5714, 0.001) && close(sbrALayerFactorCD(8), 1, 1e-9) && sbrALayerFactorCD(0) === 2);
  const f4 = sbrAAllowableVelocity({ ...ex, part: 'foundation', layerThickness_m: 4 });
  ok('foundation with H = 4 m: V_kar = 15.7', close(f4.vKar, 15.71, 0.01), f4.vKar.toFixed(2));
  ok('unknown condition → NaN + note, no throw', Number.isNaN(sbrAAllowableVelocity({ category: 2, condition: 'x', frequency_Hz: 10 }).vAllow));
}

console.log('== DIN 4150-3 ==');
{
  ok('line 2, 35 Hz → 11.25 (course §12.5)', close(din4150Guideline({ line: 2, frequency_Hz: 35 }).limit_mm_s, 11.25, 1e-9));
  ok('line 1: 5 Hz 20, 30 Hz 30, 75 Hz 45, 100 Hz 50', close(din4150Guideline({ line: 1, frequency_Hz: 5 }).limit_mm_s, 20, 1e-9) && close(din4150Guideline({ line: 1, frequency_Hz: 30 }).limit_mm_s, 30, 1e-9) && close(din4150Guideline({ line: 1, frequency_Hz: 75 }).limit_mm_s, 45, 1e-9) && close(din4150Guideline({ line: 1, frequency_Hz: 100 }).limit_mm_s, 50, 1e-9));
  ok('line 2: 10 Hz 5, 50 Hz 15, 100 Hz 20', close(din4150Guideline({ line: 2, frequency_Hz: 10 }).limit_mm_s, 5, 1e-9) && close(din4150Guideline({ line: 2, frequency_Hz: 50 }).limit_mm_s, 15, 1e-9) && close(din4150Guideline({ line: 2, frequency_Hz: 100 }).limit_mm_s, 20, 1e-9));
  ok('line 3: 8 Hz 3, 30 Hz 5.5, 75 Hz 9', close(din4150Guideline({ line: 3, frequency_Hz: 8 }).limit_mm_s, 3, 1e-9) && close(din4150Guideline({ line: 3, frequency_Hz: 30 }).limit_mm_s, 5.5, 1e-9) && close(din4150Guideline({ line: 3, frequency_Hz: 75 }).limit_mm_s, 9, 1e-9));
  ok('top floor short-term = 40 / 15 / 8', din4150Guideline({ line: 1, location: 'topFloor' }).limit_mm_s === 40 && din4150Guideline({ line: 2, location: 'topFloor' }).limit_mm_s === 15 && din4150Guideline({ line: 3, location: 'topFloor' }).limit_mm_s === 8);
  ok('long-term = 10 / 5 / 2.5', din4150Guideline({ line: 1, duration: 'long' }).limit_mm_s === 10 && din4150Guideline({ line: 2, duration: 'long' }).limit_mm_s === 5 && din4150Guideline({ line: 3, duration: 'long' }).limit_mm_s === 2.5);
  const hi = din4150Guideline({ line: 2, frequency_Hz: 150 });
  ok('> 100 Hz → 100 Hz value + note', hi.limit_mm_s === 20 && hi.notes.some((s) => /Above 100 Hz/.test(s)));
  ok('framework tag', hi.framework === 'DIN 4150-3:2016');
  ok('missing frequency → NaN + note', Number.isNaN(din4150Guideline({ line: 2 }).limit_mm_s));
}

console.log('== BS 7385-2 ==');
{
  ok('line 2, 35 Hz → 44 mm/s (course §12.5)', close(bs7385Guideline({ line: 2, frequency_Hz: 35 }).limit_mm_s, 44, 1e-9));
  ok('line 2: 4 Hz 15, 15 Hz 20, 40 Hz 50, 100 Hz 50', close(bs7385Guideline({ line: 2, frequency_Hz: 4 }).limit_mm_s, 15, 1e-9) && close(bs7385Guideline({ line: 2, frequency_Hz: 15 }).limit_mm_s, 20, 1e-9) && close(bs7385Guideline({ line: 2, frequency_Hz: 40 }).limit_mm_s, 50, 1e-9) && close(bs7385Guideline({ line: 2, frequency_Hz: 100 }).limit_mm_s, 50, 1e-9));
  ok('line 2, 10 Hz → 15 + 5/11·6 = 17.73', close(bs7385Guideline({ line: 2, frequency_Hz: 10 }).limit_mm_s, 17.727, 0.001));
  ok('line 1 → 50 at any f ≥ 4', bs7385Guideline({ line: 1, frequency_Hz: 4 }).limit_mm_s === 50 && bs7385Guideline({ line: 1, frequency_Hz: 60 }).limit_mm_s === 50);
  const cont = bs7385Guideline({ line: 2, frequency_Hz: 4, continuous: true });
  ok('continuous → 50 % reduction: 15 → 7.5 (course §12.5)', close(cont.limit_mm_s, 7.5, 1e-9) && cont.reductionFactor === 0.5 && cont.transient_mm_s === 15);
  const low = bs7385Guideline({ line: 2, frequency_Hz: 2 });
  ok('< 4 Hz → 4 Hz value + displacement note', low.limit_mm_s === 15 && low.notes.some((s) => /0\.6 mm/.test(s)));
  ok('framework tag', low.framework === 'BS 7385-2:1993');
}

console.log('== BS 5228-2 Table B.1 human response ==');
{
  ok('0.1 → below perception', humanResponseDescriptor(0.1).band === 'below perception threshold');
  ok('0.2 → perceptible (sensitive situations)', humanResponseDescriptor(0.2).threshold_mm_s === 0.14);
  ok('0.5 → perceptible (residential)', humanResponseDescriptor(0.5).threshold_mm_s === 0.3);
  ok('2.3 → complaints likely', humanResponseDescriptor(2.3).threshold_mm_s === 1.0 && humanResponseDescriptor(2.3).band === 'complaints likely');
  ok('12 → intolerable', humanResponseDescriptor(12).threshold_mm_s === 10);
}

console.log('== assessReceiver (course §12.5) ==');
{
  const a = assessReceiver({ predictedPpv_mm_s: 4.491, frequency_Hz: 4, framework: 'BS7385-2', frameworkArgs: { line: 2 } });
  ok('4.491 vs BS 7385-2 line 2 at 4 Hz: η = 0.299, ok', close(a.utilisation, 0.299, 0.001) && a.verdict === 'ok', a.utilisation.toFixed(3));
  const b = assessReceiver({ predictedPpv_mm_s: 4.491, frequency_Hz: 4, framework: 'BS7385-2', frameworkArgs: { line: 2, continuous: true } });
  ok('… with 50 % reduction: η = 0.599', close(b.utilisation, 0.599, 0.001), b.utilisation.toFixed(3));
  const c = assessReceiver({ predictedPpv_mm_s: 2.275, frequency_Hz: 35, framework: 'DIN4150-3', frameworkArgs: { line: 2 } });
  ok('2.275 vs DIN line 2 at 35 Hz (11.25): η = 0.202', close(c.utilisation, 2.275 / 11.25, 1e-6) && c.verdict === 'ok');
  const d = assessReceiver({ predictedPpv_mm_s: 2.275, frequency_Hz: 35, framework: 'SBR-A', frameworkArgs: ex });
  ok('2.275 vs SBR-A example at 35 Hz (11.25/4.08 = 2.757; example prints 2.77 after rounding V_kar to 11.3): η = 0.83 → attention', close(d.limit_mm_s, 2.757, 0.002) && d.verdict === 'attention', `${d.limit_mm_s.toFixed(3)} / ${d.utilisation.toFixed(3)}`);
  const e = assessReceiver({ predictedPpv_mm_s: 4.491, frequency_Hz: 5, framework: 'SBR-A', frameworkArgs: ex });
  ok('4.491 vs SBR-A example at 5 Hz (1.23): exceeds', e.verdict === 'exceeds' && e.utilisation > 3);
  ok('human descriptor attached (complaints likely)', e.human.band === 'complaints likely');
  ok('unknown framework → undefined verdict + note', assessReceiver({ predictedPpv_mm_s: 1, frequency_Hz: 10, framework: 'ISO' }).verdict === 'undefined');
}

console.log('== Monitoring plan ==');
{
  const plan = buildMonitoringPlan({ framework: 'SBR-A', frameworkArgs: ex, dominantFrequency_Hz: 0, prediction: { expected_mm_s: 0.513, upper_mm_s: 2.275 }, receiverDistance_m: 30 });
  ok('stop = SBR-A limit 1.23 mm/s', close(plan.stop.value, 1.2255, 0.001), plan.stop.value.toFixed(3));
  ok('warning = 75 % → 0.92 mm/s', close(plan.warning.value, 0.919, 0.001), plan.warning.value.toFixed(3));
  ok('frequency table 0…100 in 5 Hz steps (21 rows)', plan.frequencyTable.length === 21 && plan.frequencyTable[0].f === 0 && plan.frequencyTable[20].f === 100);
  const rows = Object.fromEntries(plan.frequencyTable.map((r) => [r.f, r]));
  ok('table reproduces Figuur 2: 0→1.23, 30→2.45, 50→3.68, 100→4.90', close(rows[0].vAllow, 1.23, 0.005) && close(rows[30].vAllow, 2.45, 0.005) && close(rows[50].vAllow, 3.68, 0.005) && close(rows[100].vAllow, 4.90, 0.005));
  ok('table V_kar column: 15→6.25, 85→18.5', close(rows[15].vKar, 6.25, 1e-9) && close(rows[85].vKar, 18.5, 1e-9));
  ok('warning column = 0.75 · vAllow', plan.frequencyTable.every((r) => close(r.warning, 0.75 * r.vAllow, 1e-9)));
  ok('upper prediction > stop ⇒ revise-method note', plan.notes.some((s) => /exceeds the stop level/.test(s)));
  ok('sensor layout: 5, 10, 20 m + receiver 30 m', plan.sensorLayout.sensors.map((s) => s.distance_m).join(',') === '5,10,20,30');
  ok('human objective 1.0 mm/s with BS 5228-2 descriptor', plan.humanObjective.value === 1 && /complaint/.test(plan.humanObjective.descriptor));
  ok('structural guide = unfactored V_kar (5 mm/s at 0 Hz)', plan.structuralGuide.value === 5);
  ok('three states green/amber/red', plan.states.map((s) => s.state).join() === 'green,amber,red');
  const near = suggestSensorLayout(8);
  ok('receiver at 8 m → control 5 m + receiver only, with note', near.sensors.length === 2 && near.notes.some((s) => /close to the source/.test(s)));
  const over = buildMonitoringPlan({ framework: 'SBR-A', frameworkArgs: ex, dominantFrequency_Hz: 30, stop_mm_s: 5, prediction: {} });
  ok('stop override above limit is rejected', close(over.stop.value, 2.45, 0.005) && over.notes.some((s) => /exceeds the SBR-A 2017 limit/.test(s)));
  const under = buildMonitoringPlan({ framework: 'SBR-A', frameworkArgs: ex, dominantFrequency_Hz: 30, stop_mm_s: 2.0, prediction: {} });
  ok('stop override below limit honoured', under.stop.value === 2.0 && close(under.warning.value, 1.5, 1e-9));
  const din = buildMonitoringPlan({ framework: 'DIN4150-3', frameworkArgs: { line: 2 }, dominantFrequency_Hz: 35, prediction: {}, warningFraction: 0.5 });
  ok('DIN plan: stop 11.25, warning 5.625, table row 50 Hz = 15', close(din.stop.value, 11.25, 1e-9) && close(din.warning.value, 5.625, 1e-9) && close(din.frequencyTable.find((r) => r.f === 50).vAllow, 15, 1e-9));
  const bs = buildMonitoringPlan({ framework: 'BS7385-2', frameworkArgs: { line: 2, continuous: true }, dominantFrequency_Hz: 35, prediction: {} });
  ok('BS plan: stop 22 (44 × 0.5), vKar column 44', close(bs.stop.value, 22, 1e-9) && close(bs.frequencyTable.find((r) => r.f === 35).vKar, 44, 1e-9));
}

console.log(`\n${n - fails}/${n} OK${fails ? `, ${fails} FAIL` : ''}`);
process.exit(fails ? 1 : 0);
