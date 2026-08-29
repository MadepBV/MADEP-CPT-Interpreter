#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verification of the CPT → static-resistance-to-driving profile builder:
//   - layered CPT → uniform grid, friction ratio, cumulative shaft, toe and total
//   - ground-level offset (CPT datum ≠ platform), extrapolation beyond the CPT, null f_s
//   - interlock term, inner perimeter, plug ratio, reduction factors
//   - Alm & Hamre (2001) friction-fatigue method: coefficients, degradation with tip distance
//   - hammer catalog integrity (sources present, F_c ≈ M_e ω² consistency)
import { buildDrivingResistanceProfile, shaftStressAtTip, indexAtDepth } from '../src/lib/cpt-app/retaining/drivability/srd-from-cpt.js';
import { vibratoryHammers, impactHammers, findHammer, vibratoryConsistency } from '../src/lib/cpt-app/retaining/drivability/hammer-catalog.js';

let fails = 0, n = 0;
function ok(name, cond, detail = '') { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; }
function near(name, got, want, relTol, absTol = 0) {
  const tol = Math.max(absTol, relTol * Math.abs(want));
  ok(name, Number.isFinite(got) && Math.abs(got - want) <= tol, `got ${Number.isFinite(got) ? got.toPrecision(6) : got}, want ${Number(want).toPrecision(6)}`);
}
function mono(name, arr, dir) {
  let good = true; for (let i = 1; i < arr.length; i++) if (dir > 0 ? !(arr[i] > arr[i - 1] - 1e-9) : !(arr[i] < arr[i - 1] + 1e-9)) good = false;
  ok(name, good);
}

// layered CPT at 0.05 m spacing: sand 0–3 (5 MPa, 25 kPa), clay 3–6 (1 MPa, 40 kPa), dense sand 6–10 (15 MPa, 75 kPa)
const depth = [], qc = [], fs = [];
for (let d = 0; d <= 10 + 1e-9; d += 0.05) {
  depth.push(+d.toFixed(2));
  if (d < 3) { qc.push(5); fs.push(25); } else if (d < 6) { qc.push(1); fs.push(40); } else { qc.push(15); fs.push(75); }
}
const cpt = { depth, qc, fs };
const AZ = { toeArea_m2: 0.0150, shaftPerimeter_m: 2.6, steelArea_m2: 0.0150 }; // sheet-pile-like: toe = steel area, both faces
const P = buildDrivingResistanceProfile({ cpt, pile: AZ, options: { dz: 0.1 } });

console.log('== Reference profile on a layered CPT ==');
ok('ok', P.ok, P.notes.join(' | '));
ok('uniform grid 0.1 … 10.0 m (100 points)', P.z.length === 100 && Math.abs(P.z[0] - 0.1) < 1e-9 && Math.abs(P.z[99] - 10) < 1e-9 && P.dz === 0.1);
near('q_toe at 2.0 m = 5000 kPa', P.qToe_kPa[indexAtDepth(P, 2.0)], 5000, 1e-9);
near('q_toe at 8.0 m = 15000 kPa', P.qToe_kPa[indexAtDepth(P, 8.0)], 15000, 1e-9);
near('τ_s in clay (4.5 m) = 40 kPa', P.tauShaft_kPa[indexAtDepth(P, 4.5)], 40, 1e-9);
near('FR in sand = 0.5 %', P.frictionRatioPct[indexAtDepth(P, 1.5)], 0.5, 1e-9);
near('FR in clay = 4 %', P.frictionRatioPct[indexAtDepth(P, 4.5)], 4, 1e-9);
near('cumulative shaft at 3.0 m = 25·2.6·3', P.cumulativeShaft_kN[indexAtDepth(P, 3.0)], 25 * 2.6 * 3, 1e-6);
near('cumulative shaft at 6.0 m = 195 + 40·2.6·3', P.cumulativeShaft_kN[indexAtDepth(P, 6.0)], 25 * 2.6 * 3 + 40 * 2.6 * 3, 1e-6);
near('toe at 10 m = 15000·0.015 = 225 kN', P.toe_kN[99], 225, 1e-9);
ok('R_static = shaft + interlock + toe everywhere', P.z.every((_, j) => Math.abs(P.Rstatic_kN[j] - (P.cumulativeShaft_kN[j] + P.interlock_kN[j] + P.toe_kN[j])) < 1e-9));
mono('cumulative shaft is non-decreasing', P.cumulativeShaft_kN, +1);
ok('toe drops entering the clay (governing layer can be intermediate)', P.toe_kN[indexAtDepth(P, 2.9)] > P.toe_kN[indexAtDepth(P, 3.5)]);
ok('shaftStressAtTip = constant τ for the reference method', shaftStressAtTip(P, 50).every((t, i) => t === P.tauShaft_kPa[i]));
ok('reference note present', P.notes.some((s) => /course §7.2/.test(s)));

console.log('== Offsets, extrapolation, null f_s, factors ==');
{
  const Poff = buildDrivingResistanceProfile({ cpt: { ...cpt, groundLevelOffset: 1.0 }, pile: AZ, options: { dz: 0.1 } });
  near('CPT GL 1 m above platform: q_toe(z = 2.0) = q_c(CPT 3.0)', Poff.qToe_kPa[indexAtDepth(Poff, 2.0)], P.qToe_kPa[indexAtDepth(P, 3.0)], 1e-9);
  near('… and q_toe(z = 1.5) = q_c(CPT 2.5)', Poff.qToe_kPa[indexAtDepth(Poff, 1.5)], P.qToe_kPa[indexAtDepth(P, 2.5)], 1e-9);
  ok('offset profile ends 1 m shallower', Poff.z.length === 90);
  ok('offset note emitted', Poff.notes.some((s) => /above the platform by 1.00 m/.test(s)));
  const Pneg = buildDrivingResistanceProfile({ cpt: { ...cpt, groundLevelOffset: -2.0 }, pile: AZ, options: { dz: 0.1 } });
  near('CPT GL 2 m below platform: first value held above the CPT start', Pneg.qToe_kPa[indexAtDepth(Pneg, 1.0)], 5000, 1e-9);
  ok('… note emitted', Pneg.notes.some((s) => /starts 2.00 m below the platform/.test(s)));
  const Pdeep = buildDrivingResistanceProfile({ cpt, pile: AZ, options: { dz: 0.1, maxDepth_m: 12 } });
  ok('beyond the CPT: last value held + note', Pdeep.z.length === 120 && Pdeep.qToe_kPa[119] === 15000 && Pdeep.tauShaft_kPa[119] === 75 && Pdeep.notes.some((s) => /below the CPT end/.test(s)));
  const fsNull = fs.map((v, i) => (depth[i] >= 3 && depth[i] < 6 ? null : v));
  const Pnull = buildDrivingResistanceProfile({ cpt: { depth, qc, fs: fsNull }, pile: AZ, options: { dz: 0.1, assumedFrictionRatioPct: 2.0 } });
  near('null f_s ⇒ f_s = FR_assumed·q_c (clay 1 MPa, 2 %) = 20 kPa', Pnull.tauShaft_kPa[indexAtDepth(Pnull, 4.5)], 20, 1e-9);
  ok('null f_s note emitted with the assumed ratio', Pnull.notes.some((s) => /without f_s: f_s = 2 %/.test(s)));
  const Pf = buildDrivingResistanceProfile({ cpt, pile: AZ, options: { dz: 0.1, toeFactor: 0.5, shaftFactor: 0.8 } });
  near('toeFactor 0.5 halves the toe', Pf.toe_kN[99], 0.5 * P.toe_kN[99], 1e-9);
  near('shaftFactor 0.8 scales the shaft', Pf.cumulativeShaft_kN[99], 0.8 * P.cumulativeShaft_kN[99], 1e-9);
  const Pavg = buildDrivingResistanceProfile({ cpt, pile: AZ, options: { dz: 0.1, toeAveragingWindow_m: 0.5 } });
  ok('toe averaging smooths the sand/clay step', Pavg.qToe_kPa[indexAtDepth(Pavg, 3.0)] > 1000 && Pavg.qToe_kPa[indexAtDepth(Pavg, 3.0)] < 5000);
  ok('qc-only CPT (no fs array) works with the assumed ratio', buildDrivingResistanceProfile({ cpt: { depth, qc }, pile: AZ, options: { dz: 0.1 } }).ok);
  ok('bad input ⇒ ok:false with a note, no throw', buildDrivingResistanceProfile({ cpt: { depth: [0], qc: [1] }, pile: AZ }).ok === false && buildDrivingResistanceProfile({ cpt, pile: { toeArea_m2: 0, shaftPerimeter_m: 1 } }).ok === false && buildDrivingResistanceProfile({ cpt, pile: AZ, method: 'nope' }).ok === false);
}

console.log('== Interlock, inner perimeter, plug ratio ==');
{
  const Pi = buildDrivingResistanceProfile({ cpt, pile: { ...AZ, interlockResistance_kN_m: 10 }, options: { dz: 0.1 } });
  near('interlock 10 kN/m ⇒ 40 kN at 4 m', Pi.interlock_kN[indexAtDepth(Pi, 4.0)], 40, 1e-9);
  ok('interlock adds exactly 10·z to R_static', Pi.z.every((z, j) => Math.abs(Pi.Rstatic_kN[j] - P.Rstatic_kN[j] - 10 * z) < 1e-9));
  ok('interlock note', Pi.notes.some((s) => /Interlock/.test(s)));
  const Pin = buildDrivingResistanceProfile({ cpt, pile: { ...AZ, innerPerimeter_m: 2.6 }, options: { dz: 0.1 } });
  near('inner perimeter = outer ⇒ shaft doubles', Pin.cumulativeShaft_kN[99], 2 * P.cumulativeShaft_kN[99], 1e-9);
  const Pp = buildDrivingResistanceProfile({ cpt, pile: { ...AZ, plugRatio: 0.5 }, options: { dz: 0.1 } });
  near('plugRatio 0.5 halves the toe', Pp.toe_kN[99], 0.5 * P.toe_kN[99], 1e-9);
}

console.log('== Alm & Hamre (2001) friction-fatigue method ==');
{
  const layers = [{ zTop_m: 0, zBot_m: 3, soilType: 'sand', deltaCv_deg: 29 }, { zTop_m: 3, zBot_m: 6, soilType: 'clay' }, { zTop_m: 6, zBot_m: 10, soilType: 'sand', deltaCv_deg: 29 }];
  const tubeOpen = { toeArea_m2: 0.0195, shaftPerimeter_m: Math.PI * 0.508, innerPerimeter_m: Math.PI * 0.483 };
  const AH = buildDrivingResistanceProfile({ cpt, pile: tubeOpen, method: 'alm-hamre', options: { dz: 0.1, almHamre: { layers, gamma_kN_m3: 19, waterTable_m: 1.0, insideFriction: 'half-both' } } });
  ok('ok', AH.ok, AH.notes.join(' | '));
  const j45 = indexAtDepth(AH, 4.5), j80 = indexAtDepth(AH, 8.0), j15 = indexAtDepth(AH, 1.5);
  const s = AH.almHamre.sigmaV0_kPa;
  near("σ′v0 at 4.45 m = 19·4.45 − 9.81·3.45", s[j45], 19 * 4.45 - 9.81 * 3.45, 1e-9);
  near('clay toe = 0.6 q_T', AH.qToe_kPa[j45], 0.6 * 1000, 1e-9);
  near('sand toe = 0.15 q_T (q_T/σ′)^0.2', AH.qToe_kPa[j80], 0.15 * 15000 * Math.pow(15000 / s[j80], 0.2), 1e-9);
  near('clay f_s,i = f_s(CPT) = 40 kPa', AH.almHamre.fsi_kPa[j45], 40, 1e-9);
  near('clay f_s,res = 0.004 q_T (1 − 0.0025 q_T/σ′)', AH.almHamre.fsres_kPa[j45], 0.004 * 1000 * (1 - 0.0025 * 1000 / s[j45]), 1e-9);
  const Kp0 = 0.0132 * 5000 * Math.pow(s[j15] / 100, 0.13);
  near('sand f_s,i = ½·0.0132 q_T (σ′/p_a)^0.13 tan δ (half-both)', AH.almHamre.fsi_kPa[j15], 0.5 * Kp0 * Math.tan(29 * Math.PI / 180), 1e-9);
  near('sand f_s,res = 0.2 f_s,i', AH.almHamre.fsres_kPa[j15], 0.2 * AH.almHamre.fsi_kPa[j15], 1e-9);
  near('k = √(q_T/σ′)/80', AH.almHamre.k_1_m[j15], Math.sqrt(5000 / s[j15]) / 80, 1e-9);
  const tauAt10 = shaftStressAtTip(AH, 99);
  near('τ half an interval above the tip = f_res + (f_i − f_res)e^{−k·dz/2}', tauAt10[99], AH.almHamre.fsres_kPa[99] + (AH.almHamre.fsi_kPa[99] - AH.almHamre.fsres_kPa[99]) * Math.exp(-AH.almHamre.k_1_m[99] * AH.dz / 2), 1e-9);
  mono('τ degrades with distance above the tip (within the deep sand)', tauAt10.slice(indexAtDepth(AH, 6.1), 100), +1);
  const dist = AH.z[99] - (AH.z[j15] - AH.dz / 2);
  near('degradation law f_res + (f_i − f_res)e^{−k·dist}', tauAt10[j15], AH.almHamre.fsres_kPa[j15] + (AH.almHamre.fsi_kPa[j15] - AH.almHamre.fsres_kPa[j15]) * Math.exp(-AH.almHamre.k_1_m[j15] * dist), 1e-9);
  ok('cumulative shaft < undegraded sum (friction fatigue acts)', AH.cumulativeShaft_kN[99] < AH.almHamre.fsi_kPa.reduce((a, f) => a + f * AH.contactPerimeter_m * AH.dz, 0));
  ok('perimeter = outside + inside', Math.abs(AH.contactPerimeter_m - Math.PI * (0.508 + 0.483)) < 1e-9);
  ok('notes: q_c as q_T, unplugged, inside friction halved', AH.notes.some((s) => /q_c used as q_T/.test(s)) && AH.notes.some((s) => /halved/.test(s)));
  const AHub = buildDrivingResistanceProfile({ cpt, pile: tubeOpen, method: 'alm-hamre', options: { dz: 0.1, srdFactor: 1.25, almHamre: { layers, gamma_kN_m3: 19, waterTable_m: 1.0 } } });
  ok('srdFactor 1.25 scales the whole profile (upper bound, Alm & Hamre §8)', Math.abs(AHub.qToe_kPa[j80] / AH.qToe_kPa[j80] - 1.25) < 1e-9);
  ok('alm-hamre without layers ⇒ ok:false', buildDrivingResistanceProfile({ cpt, pile: tubeOpen, method: 'alm-hamre' }).ok === false);
}

console.log('== Hammer catalog ==');
{
  ok('vibratory rows have make, model, moment, frequency, force and a fetched source URL', vibratoryHammers.every((h) => h.make && h.model && h.eccentricMomentMax_kgm > 0 && h.frequencyMax_Hz > 0 && h.centrifugalForceMax_kN > 0 && /^https:\/\//.test(h.source) && h.verifiedOn));
  ok('impact rows have ram mass, rated energy, type, efficiency default and source', impactHammers.every((h) => h.ramMass_kg > 0 && h.ratedEnergy_kJ > 0 && /^(hydraulic|diesel)$/.test(h.type) && h.efficiencyDefault > 0 && /^https:\/\//.test(h.source)));
  ok('ids unique', new Set([...vibratoryHammers, ...impactHammers].map((h) => h.id)).size === vibratoryHammers.length + impactHammers.length);
  ok('findHammer works and returns null for custom', findHammer('ice-28rf').dynamicMass_kg === 3900 && findHammer('junttan-hhk-7a').ramMass_kg === 7000 && findHammer('custom') === null);
  const cons = vibratoryConsistency();
  ok('F_c ≈ M_e ω² within 8 % for every vibratory row', cons.every((c) => c.ratio > 0.92 && c.ratio < 1.08), cons.map((c) => `${c.id}: ${c.ratio.toFixed(3)}`).join(', '));
  ok('ICE 28RF amplitude 2·M_e/M_dyn = 14.4 mm ≈ datasheet 14 mm', Math.abs(2 * 28 / 3900 * 1000 - 14) < 0.5);
  ok('Junttan HHK 5A: 59 kNm ≈ 5000 kg · g · 1.2 m', Math.abs(findHammer('junttan-hhk-5a').ratedEnergy_kJ - 5000 * 9.81 * 1.2 / 1000) < 0.5);
  ok('IHC S-90: 90 kJ, 4500 kg ram (brochure) ≈ PDI database 89.4 kJ / 44.2 kN', findHammer('ihc-s-90').ratedEnergy_kJ === 90 && findHammer('ihc-s-90').ramMass_kg === 4500);
  ok('unknown dynamic masses are null, never guessed', vibratoryHammers.filter((h) => h.dynamicMass_kg === null).every((h) => /not published/.test(h.sourceNote)));
}

console.log(`\n${n - fails}/${n} checks passed`);
process.exit(fails ? 1 : 0);
