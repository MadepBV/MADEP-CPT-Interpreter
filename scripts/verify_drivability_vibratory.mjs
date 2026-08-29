#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verification of the Hypervib1-type vibratory drivability runner against the worked example
// of the course chapter "Vibratory pile installation" §8 (independently verified numbers):
//   closed tube Ø273×8, L = 6 m, embedment 3 m, q_c = 3000 kPa, f_s = 30 kPa, Λ = 6,
//   M_dyn = 2200 kg, crowd 15 kN, f = 35 Hz, δ_H = 0.
// Plus the §8.9 sensitivity table, the χ limit for FR → 0, monotonicity and candidate checks.
import { buildDrivingResistanceProfile } from '../src/lib/cpt-app/retaining/drivability/srd-from-cpt.js';
import { runVibratoryDrivability, chiFactor } from '../src/lib/cpt-app/retaining/drivability/vibratory-drivability.js';

let fails = 0, n = 0;
function ok(name, cond, detail = '') { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; }
function near(name, got, want, relTol, absTol = 0) {
  const tol = Math.max(absTol, relTol * Math.abs(want));
  ok(name, Number.isFinite(got) && Math.abs(got - want) <= tol, `got ${Number.isFinite(got) ? got.toPrecision(7) : got}, want ${want}`);
}
function mono(name, arr, dir) {
  let good = true; for (let i = 1; i < arr.length; i++) if (dir > 0 ? !(arr[i] > arr[i - 1] - 1e-9) : !(arr[i] < arr[i - 1] + 1e-9)) good = false;
  ok(name, good, arr.map((x) => x.toFixed(3)).join(' → '));
}

const Do = 0.273, t = 0.008, Di = Do - 2 * t;
const pile = { toeArea_m2: Math.PI * Do * Do / 4, shaftPerimeter_m: Math.PI * Do, steelArea_m2: Math.PI / 4 * (Do * Do - Di * Di) };
const cptUniform = (fs) => ({ depth: [0, 6], qc: [3, 3], fs: [fs, fs] });
const profileFor = (fs) => buildDrivingResistanceProfile({ cpt: cptUniform(fs), pile, method: 'reference', options: { dz: 0.1, maxDepth_m: 3.0 } });
const vib = (over = {}) => ({ frequency_Hz: 35, dynamicMass_kg: 2200, crowd_kN: 15, ...over });

console.log('== Course §8 worked example (4 significant figures) ==');
const prof = profileFor(30);
ok('profile ok', prof.ok, prof.notes.join(' | '));
near('χ(FR = 1 %, Λ = 6) = 0.473233', chiFactor(1.0, 6), 0.473233, 0, 1e-6);
near('A_b = 0.058535 m²', prof.effectiveToeArea_m2, 0.058535, 0, 1e-6);
near('P = 0.857655 m', prof.contactPerimeter_m, 0.857655, 0, 1e-6);
near('A_s = 0.006660 m²', pile.steelArea_m2, 0.006660, 0, 1e-6);
const j3 = prof.z.length - 1;
near('z_toe = 3.0 m', prof.z[j3], 3.0, 0, 1e-9);
near('R_s,static = 77.189 kN', prof.cumulativeShaft_kN[j3], 77.189, 0, 1e-3);
near('R_b,static = 175.605 kN', prof.toe_kN[j3], 175.605, 0, 1e-3);
near('R_static = 252.794 kN', prof.Rstatic_kN[j3], 252.794, 0, 1e-3);

const res = runVibratoryDrivability({ profile: prof, vibrator: vib({ centrifugalForce_kN: 125 }), options: { lambda: 6, targetDepth_m: 3.0 } });
ok('run ok', res.ok, res.notes.join(' | '));
near('W_eff = 36.582 kN', res.Weff_kN, 36.582, 0, 1e-3);
near('governing depth = 3.0 m', res.governingDepth_m, 3.0, 0, 1e-9);
near('R_liquefied = 119.630 kN', res.perDepth[j3].Rliquefied_kN, 119.630, 0, 2e-3);
const cc = res.candidateCheck;
ok('candidate check present', !!cc && cc.z === 3.0);
near('α(125 kN) = 5.7919', cc.alpha, 5.7919, 0, 1e-4);
near('q_d(125 kN) = 1424.522 kPa', cc.qd_kPa, 1424.522, 0, 1e-3);
near('τ_d(125 kN) = 14.24522 kPa', cc.taud_kPa, 14.24522, 0, 1e-5);
near('R_s(125) = 36.652 kN', cc.Rs_kN, 36.652, 0, 1e-3);
near('R_b(125) = 83.384 kN', cc.Rb_kN, 83.384, 0, 1e-3);
near('R_drive(125 kN) = 120.037 kN', cc.Rdrive_kN, 120.037, 0, 1e-3);
near('G(125 kN, m_R = 1.25) = 11.536 kN', cc.margin125_kN, 11.536, 0, 1e-3);
near('G(125 kN, m_R = 1.0) = 41.55 kN', cc.margin_kN, 41.545, 0, 5e-3);
near('F_c,min(m_R = 1.0) = 85.57 kN', res.FcRequired_kN, 85.574, 0, 5e-3);
near('F_c,min(m_R = 1.25) = 113.81 kN', res.FcRequired125_kN, 113.809, 0, 5e-3);
near('M_e(125 kN, 35 Hz) = 2.5847 kg·m', cc.eccentricMoment_kgm, 2.5847, 0, 1e-4);
near('s_0 = 1.175 mm', cc.amplitude_mm, 1.1749, 0, 1e-3);
near('A_pp = 2.350 mm', cc.amplitudePp_mm, 2.3498, 0, 2e-3);
near('α_free(125 kN) = 5.79', cc.accelerationRatio, 5.7919, 0, 1e-4);
near('σ_screen = 24.3 MPa', cc.stressScreen_MPa, 24.3, 2e-3);
ok('design basis = candidate', res.designForceBasis === 'candidate' && res.designForce_kN === 125);
near('top-level M_e follows the candidate', res.eccentricMoment_kgm, 2.5847, 0, 1e-4);

console.log('== Course Table 8A/8B spot checks ==');
const rowAt = (Fc) => res.forceEnvelopeCurve.reduce((b, r) => (Math.abs(r.Fc_kN - Fc) < Math.abs(b.Fc_kN - Fc) ? r : b));
const run50 = runVibratoryDrivability({ profile: prof, vibrator: vib({ centrifugalForce_kN: 50 }), options: { lambda: 6, targetDepth_m: 3.0 } }).candidateCheck;
near('α(50) = 2.317', run50.alpha, 2.317, 0, 1e-3);
near('q_d(50) = 1575.5', run50.qd_kPa, 1575.5, 0, 0.1);
near('R_drive(50) = 132.76', run50.Rdrive_kN, 132.76, 0, 0.01);
near('G(50, 1.0) = −46.18', run50.margin_kN, -46.18, 0, 0.01);
near('G(50, 1.25) = −79.37', run50.margin125_kN, -79.37, 0, 0.01);
const run100 = runVibratoryDrivability({ profile: prof, vibrator: vib({ centrifugalForce_kN: 100 }), options: { lambda: 6, targetDepth_m: 3.0 } }).candidateCheck;
near('R_drive(100) = 120.92', run100.Rdrive_kN, 120.92, 0, 0.01);
near('G(100, 1.25) = −14.57', run100.margin125_kN, -14.57, 0, 0.01);
ok('force-envelope curve spans the candidate', res.forceEnvelopeCurve[res.forceEnvelopeCurve.length - 1].Fc_kN >= 125 && rowAt(0).G_kN < 0);
mono('G(F_c) is monotone increasing', res.forceEnvelopeCurve.map((r) => r.G_kN), +1);

console.log('== Course §8.9 sensitivity (m_R = 1.25 root) ==');
const root125 = (fs, lambda, crowd) => runVibratoryDrivability({ profile: profileFor(fs), vibrator: vib({ crowd_kN: crowd }), options: { lambda, targetDepth_m: 3.0 } }).FcRequired125_kN;
near('f_s = 15 kPa → 54.0 kN', root125(15, 6, 15), 54.0, 2e-3);
near('f_s = 30 kPa → 113.8 kN', root125(30, 6, 15), 113.8, 2e-3);
near('f_s = 60 kPa → 240.7 kN', root125(60, 6, 15), 240.7, 2e-3);
near('Λ = 4 → 130.0 kN', root125(30, 4, 15), 130.0, 2e-3);
near('Λ = 10 → 101.3 kN', root125(30, 10, 15), 101.3, 2e-3);
near('crowd 0 → 128.4 kN', root125(30, 6, 0), 128.4, 2e-3);
near('crowd 25 → 104.3 kN', root125(30, 6, 25), 104.3, 2e-3);

console.log('== Model behaviour ==');
near('χ(FR = 0) = 1/Λ limit', chiFactor(0, 6), 1 / 6, 0, 1e-12);
near('χ(FR → ∞) → 1', chiFactor(1e9, 6), 1, 1e-6);
mono('χ increases with FR', [0.2, 0.5, 1, 2, 5].map((fr) => chiFactor(fr, 6)), +1);
mono('χ decreases with Λ', [4, 6, 8, 10].map((l) => chiFactor(1, l)), -1);
ok('Λ outside 4–10 is clipped with a note', (() => { const r = runVibratoryDrivability({ profile: prof, vibrator: vib(), options: { lambda: 2 } }); return r.lambda === 4 && r.notes.some((s) => /outside/.test(s)); })());
mono('deeper target ⇒ F_c,min ↑ (uniform soil)', [1, 2, 3].map((z) => runVibratoryDrivability({ profile: prof, vibrator: vib(), options: { targetDepth_m: z } }).FcRequired_kN), +1);
mono('δ_H > 0 ⇒ F_c,min ↑', [0, 0.5, 1.0].map((d) => runVibratoryDrivability({ profile: prof, vibrator: vib(), options: { deltaH: d } }).FcRequired_kN), +1);
mono('larger dynamic mass at constant W_eff ⇒ less acceleration ⇒ F_c,min ↑', [1500, 2200, 3000].map((m) => runVibratoryDrivability({ profile: prof, vibrator: vib({ dynamicMass_kg: m, crowd_kN: 15 - (m - 2200) * 9.81 / 1000 }), options: {} }).FcRequired_kN), +1);
mono('larger dynamic mass at constant crowd ⇒ more W_eff ⇒ F_c,min ↓', [1500, 2200, 3000].map((m) => runVibratoryDrivability({ profile: prof, vibrator: vib({ dynamicMass_kg: m }), options: {} }).FcRequired_kN), -1);
{
  const r = runVibratoryDrivability({ profile: prof, vibrator: vib({ eccentricMoment_kgm: 2.5847 }), options: {} });
  near('candidate from eccentric moment ⇒ F_c = 125 kN', r.candidateCheck.Fc_kN, 125, 1e-4);
  ok('candidate ok125 at 125 kN', r.candidateCheck.ok125 === true);
  const r2 = runVibratoryDrivability({ profile: prof, vibrator: vib({ centrifugalForce_kN: 100 }), options: {} });
  ok('candidate 100 kN fails the 1.25 reserve but passes m_R = 1', r2.candidateCheck.ok125 === false && r2.candidateCheck.ok === true);
}
{
  // governing layer in the middle: a dense lens at 1–1.5 m must govern when the target is 2 m
  const cpt = { depth: [0, 1, 1.01, 1.5, 1.51, 3], qc: [1, 1, 20, 20, 1, 1], fs: [10, 10, 100, 100, 10, 10] };
  const p = buildDrivingResistanceProfile({ cpt, pile, options: { dz: 0.1 } });
  const r = runVibratoryDrivability({ profile: p, vibrator: vib(), options: { targetDepth_m: 2.0 } });
  ok('intermediate dense lens governs', r.governingDepth_m >= 1.0 && r.governingDepth_m <= 1.5, `governing at ${r.governingDepth_m} m`);
}
{
  const bad = runVibratoryDrivability({ profile: prof, vibrator: { frequency_Hz: 0, dynamicMass_kg: 2200 } });
  ok('invalid vibrator ⇒ ok:false with note', bad.ok === false && bad.notes.length === 1);
  const noAs = runVibratoryDrivability({ profile: buildDrivingResistanceProfile({ cpt: cptUniform(30), pile: { toeArea_m2: pile.toeArea_m2, shaftPerimeter_m: pile.shaftPerimeter_m }, options: { dz: 0.1, maxDepth_m: 3 } }), vibrator: vib() });
  ok('missing steel area ⇒ stress screen null + note', noAs.stressScreen_MPa === null && noAs.notes.some((s) => /Steel area/.test(s)));
  ok('results are plain JSON', JSON.stringify(res).length > 100 && !/NaN|Infinity/.test(JSON.stringify(res)));
}

console.log(`\n${n - fails}/${n} checks passed`);
process.exit(fails ? 1 : 0);
