#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Section properties, EN 1993 checks and PLAXIS parameter derivation — parity with the MADEP
// Rekennota "beschoeiing berlinerwand HEA180" (h.o.h. 1.00 m, S235, lagging 10 mm) and the course
// manual §7.2 (Bentley AZ 25 plate example, arithmetic identities).
import { hSectionSI, sheetPileSI, hSectionClass, yieldStrength } from '../src/lib/cpt-app/retaining/sections/section-properties.js';
import { hPileResistance, checkHPile, checkLaggingPlate, checkVerticalEquilibrium, sheetPileResistance, checkSheetPile } from '../src/lib/cpt-app/retaining/sections/steel-checks.js';
import { plateFromSheetPile, plateFromSoldierPile, ebrFromSoldierPile, tskinLinear, fmaxFromCpt, interfaceFactors, tlatRowsForPlaxis } from '../src/lib/cpt-app/retaining/plaxis/plaxis-parameters.js';

let fails = 0, n = 0;
const ok = (name, cond, detail = '') => { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; };
const near = (name, got, want, tol) => { const good = Math.abs(got - want) <= tol * (1 + Math.abs(want)); ok(name, good, `got=${Number(got).toPrecision(6)} want=${want}`); };

console.log('== HEA180 (NBN EN 10365) ==');
const hea = hSectionSI('HEA180');
ok('HEA180 found', !!hea);
near('A', hea.A, 4.525e-3, 1e-4); near('Iy', hea.Iy, 2.510e-5, 1e-4); near('Wel,y', hea.Wely, 293.6e-6, 1e-4); near('Wpl,y', hea.Wply, 324.9e-6, 1e-4);
near('Av,z', hea.Avz, 14.47e-4, 1e-3); near('weight per m (35.5 kg/m × 9.81; the Rekennota rounds to 0.355 with g ≈ 10)', hea.weightPerM, 0.3483, 2e-3);
near('O_steel = 2b', hea.perimeterFlanges, 0.360, 1e-6); near('O_plug = 2h', hea.perimeterPlug, 0.342, 1e-6); near('box area b·h', hea.boxArea, 0.03078, 1e-4);
const cls = hSectionClass(hea, 235);
near('flange c/t', cls.flange.ct, 7.58, 2e-3); near('web c/t', cls.web.ct, 20.33, 2e-3); ok('class 1', cls.cls === 1);

console.log('\n== EN 1993-1-1 resistance HEA180 S235 ==');
const R = hPileResistance(hea, { fy: 235 });
near('M_pl,Rd', R.MplRd, 76.35, 1e-3); near('M_el,Rd', R.MelRd, 69.00, 1e-3); near('V_pl,Rd', R.VplRd, 196.3, 1e-3); near('N_pl,Rd', R.NplRd, 1063, 1e-3);
const chk = checkHPile(hea, { MEd: 57.64, VEd: 85.03, fy: 235 });
near('UC bending plastic', chk.rows[0].util, 0.755, 2e-3); near('UC bending elastic', chk.rows[1].util, 0.835, 2e-3);
near('UC shear', chk.rows[2].util, 0.433, 2e-3); near('M–V ratio V/(0.5 Vpl)', chk.rows[3].util, 0.866, 2e-3); ok('no M–V reduction', chk.rows[3].pass && /no reduction/.test(chk.rows[3].note));
ok('overall pass', chk.pass);

console.log('\n== PLAXIS plate above excavation (HEA180, s = 1.00, lagging 10 mm) ==');
const pl = plateFromSoldierPile(hea, { spacing: 1.0, laggingThickness: 0.010 });
near('EA', pl.EA, 9.503e5, 1e-3); near('EI', pl.EI, 5271, 1e-3); near('d_eq', pl.dEq, 0.2580, 1e-3);
near('w total', pl.w, 1.140, 2e-3); near('w profile', pl.wProfile, 0.355, 3e-3); near('w lagging', pl.wLagging, 0.785, 1e-3); near('lagging EI', pl.laggingEI, 17.5, 1e-3);
ok('nu = 0', pl.nu === 0);

console.log('\n== PLAXIS embedded beam row (HEA180, s = 1.00, γ_soil 19.5) ==');
const ebr = ebrFromSoldierPile(hea, { spacing: 1.0, gammaSoil: 19.5 });
near('γ_eff', ebr.gammaEff, 59.0, 1e-6); near('D_eq', ebr.Deq, 0.2580, 1e-3); near('L/D_eq', ebr.ratio, 3.876, 1e-3);
near('ISF_RS', ebr.ISF_RS, 0.905, 2e-3); near('ISF_KF', ebr.ISF_KF, 9.050, 2e-3);
const ebr2 = ebrFromSoldierPile(hSectionSI('HEA240'), { spacing: 1.5, gammaSoil: 19.5 });
near('HEA240 @1.5 m ISF_RS (Rekennota: 0.8360)', ebr2.ISF_RS, 0.8360, 3e-3); near('HEA240 @1.5 m ISF_KF (8.361)', ebr2.ISF_KF, 8.361, 3e-3);

console.log('\n== T_skin (β-method) and F_max ==');
const ts = tskinLinear(hea, { phiK: 25, K: 'k0', deltaRatio: 2 / 3, includePlug: true, gamma: 19.5, embedment: 4.484 });
near('K0', ts.K, 0.5774, 1e-3); near('term O·tan', ts.term, 0.2673, 2e-3); near('T_skin/σ′_v', ts.coefficient, 0.15431, 2e-3);
near('slope kN/m per m', ts.slope, 3.009, 2e-3); near('T_skin,end', ts.Tend, 13.49, 2e-3); near('R_s over embedment', ts.Rs, 30.25, 2e-3);
const fm = fmaxFromCpt(hea, { qcToe_kPa: 3000, alphaB: 0.5, plugged: true });
near('A_b', fm.Ab, 0.03078, 1e-4); near('q_b', fm.qb, 1500, 1e-6); near('F_max', fm.Fmax, 46.2, 2e-3); near('F_max unplugged', fm.FmaxUnplugged, 13.6, 3e-3);

console.log('\n== lagging plate 10 mm S235 ==');
const lg = checkLaggingPlate({ pEd: 30.39, pK: 22.51, spacing: 1.0, flangeWidth: 0.18, thickness: 0.010, fy: 235, spanMode: 'centre', method: 'elastic' });
near('M_Ed', lg.MEd, 3.798, 2e-3); near('σ', lg.sigma, 227.9, 2e-3); near('UC elastic', lg.utilElastic, 0.970, 2e-3); near('UC plastic', lg.utilPlastic, 0.646, 3e-3);
near('deflection (h.o.h.)', lg.deflection * 1000, 17, 3e-2);
const lg2 = checkLaggingPlate({ pEd: 30.39, pK: 22.51, spacing: 1.0, flangeWidth: 0.18, thickness: 0.010, fy: 235, spanMode: 'clear' });
near('clear span L', lg2.L, 0.82, 1e-6); near('M_Ed clear', lg2.MEd, 2.554, 2e-3); near('UC clear', lg2.utilElastic, 0.652, 3e-3); near('deflection clear', lg2.deflection * 1000, 7.6, 3e-2);
const lg12 = checkLaggingPlate({ pEd: 30.39, spacing: 1.0, thickness: 0.012, fy: 235 });
near('12 mm σ', lg12.sigma, 158.3, 2e-3); near('12 mm UC', lg12.utilElastic, 0.674, 3e-3);
const lgU = checkLaggingPlate({ pEd: 25.87, spacing: 1.0, thickness: 0.010, fy: 235 });
near('undrained branch UC (25.87 kPa)', lgU.utilElastic, 0.826, 3e-3);

console.log('\n== vertical equilibrium ==');
const ve = checkVerticalEquilibrium({ section: hea, length: 6.40, laggingThickness: 0.010, laggingHeight: 1.916, spacing: 1.0, tskinSlope: 3.009, embedment: 4.484 });
near('G (Rekennota 3.78 with g ≈ 10)', ve.G, 3.733, 3e-3); near('R_s', ve.Rs, 30.25, 2e-3); near('UC', ve.util, 0.125, 5e-3); ok('passes', ve.pass);

console.log('\n== sheet pile plate (course §7.2 identities on catalogue sections) ==');
const az = sheetPileSI('AZ 26');
ok('AZ 26 (630) found', !!az && az.perMetre);
near('A m²/m', az.A, 0.0198, 1e-6); near('I m⁴/m', az.Iy, 5.551e-4, 1e-6);
const spPlate = plateFromSheetPile(az, { fy: 240 });
near('EA1 = E·A', spPlate.EA1, 210e6 * 0.0198, 1e-9); near('EI = E·I', spPlate.EI, 210e6 * 5.551e-4, 1e-9);
near('w = 155 kg/m² × g', spPlate.w, 155 * 9.81 / 1000, 1e-6); near('Mp = fy·Wpl', spPlate.Mp, 240e3 * 3059e-6, 1e-9); near('Np = fy·A', spPlate.Np, 240e3 * 0.0198, 1e-9);
near('d_eq', spPlate.dEq, Math.sqrt(12 * 5.551e-4 / 0.0198), 1e-9);
const spR = sheetPileResistance(az, { fy: 355, useWpl: true, betaB: 1.0 });
ok('AZ 26 S355GP class 2 → plastic allowed', spR.cls === 2 && spR.plasticAllowed);
near('M_c,Rd plastic', spR.McRd, 355e3 * 3059e-6, 1e-9);
const spR3 = sheetPileResistance(az, { fy: 355, useWpl: false });
near('M_c,Rd elastic', spR3.McRd, 355e3 * 2600e-6, 1e-9);
const azCorr = sheetPileSI('AZ 26', { corrosionLoss: 0.10 });
near('corrosion 10 % reduces Wel', azCorr.Wel / az.Wel, 0.9, 1e-9);
const sc = checkSheetPile(az, { MEd: 258.2, VEd: 130, fy: 355 });
ok('sheet-pile check rows', sc.rows.length === 3 && sc.pass);
near('R_inter = tan(2/3 φ)/tan φ (30°)', interfaceFactors([{ phi: 30 }], 2 / 3)[0].Rinter, Math.tan(20 * Math.PI / 180) / Math.tan(30 * Math.PI / 180), 1e-9);
ok('yield strength lookup', yieldStrength('S355GP') === 355 && yieldStrength('s235') === 235);
const rows = tlatRowsForPlaxis({ rows: [{ z: 0, tlatEqual: 1, tlatAL: 0.5, rowCap: 0.3 }, { z: 1, tlatEqual: 5, tlatAL: 4, rowCap: 6 }] }, { convention: 'AL', useRowCap: true });
ok('tlat rows: cap applied', rows[0].tlat === 0.3 && rows[1].tlat === 4);

console.log(`\n${fails ? 'FAILED' : 'PASSED'}: ${n - fails}/${n}`);
process.exit(fails ? 1 : 0);
