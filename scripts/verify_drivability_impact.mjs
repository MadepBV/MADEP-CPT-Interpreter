#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verification of the Smith (1960) wave-equation impact drivability runner:
//   1. analytical rigid-pile / single toe-spring set (derivation below)
//   2. energy balance of the lumped-mass integration
//   3. monotonicity: higher R_u → more blows; more energy → fewer blows
//   4. refusal labelling, bearing graph, stresses, ENTHRU, defaults and input guards
//
// Analytical reference (test 1): ram m_r hits a rigid pile of mass M through a stiff
// elastic spring (COR = 1, no helmet) → ideal elastic collision, v_p = 2 m_r v_0/(m_r + M),
// ram rebounds upward when m_r < M. The pile then loads a single toe spring (k_t = R_u/q,
// no damping, no shaft): elastic capacity ½ R_u q, remainder plastic →
//   set = (½ M v_p² − ½ R_u q)/R_u   (if ½ M v_p² > ½ R_u q, else 0).
// The toe force during the very short ram contact perturbs v_p by < 0.2 % for the chosen numbers.
import { buildDrivingResistanceProfile } from '../src/lib/cpt-app/retaining/drivability/srd-from-cpt.js';
import { runImpactDrivability, toeQuakeFromDiameter, HAMMER_EFFICIENCY_DEFAULTS } from '../src/lib/cpt-app/retaining/drivability/impact-wave-equation.js';

let fails = 0, n = 0;
function ok(name, cond, detail = '') { n++; console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`); if (!cond) fails++; }
function near(name, got, want, relTol, absTol = 0) {
  const tol = Math.max(absTol, relTol * Math.abs(want));
  ok(name, Number.isFinite(got) && Math.abs(got - want) <= tol, `got ${Number.isFinite(got) ? got.toPrecision(6) : got}, want ${want.toPrecision(6)}`);
}
function mono(name, arr, dir) {
  const a = arr.map((x) => (x === null ? Infinity : x));
  let good = true; for (let i = 1; i < a.length; i++) { if (!Number.isFinite(a[i]) && !Number.isFinite(a[i - 1])) continue; if (dir > 0 ? !(a[i] > a[i - 1] - 1e-9) : !(a[i] < a[i - 1] + 1e-9)) good = false; }
  ok(name, good, a.map((x) => (Number.isFinite(x) ? x.toFixed(2) : 'refusal')).join(' → '));
}

console.log('== 1. Analytical rigid pile with a single toe spring ==');
{
  const mr = 1000, M = 2000, h = 1.0, Ru = 500, q = 0.0025;
  const A = M / (7850 * 1.0); // 1 m pile of mass M
  const prof = buildDrivingResistanceProfile({ cpt: { depth: [0, 2], qc: [0.5, 0.5], fs: [0, 0] }, pile: { toeArea_m2: 1.0, shaftPerimeter_m: 1.0 }, options: { dz: 0.1, maxDepth_m: 1.0 } });
  const r = runImpactDrivability({
    profile: prof,
    pile: { length_m: 1.0, area_m2: A, density_kg_m3: 7850, segmentLength_m: 1.0, toeArea_m2: 1.0, shaftPerimeter_m: 1.0 },
    hammer: { ramMass_kg: mr, dropHeight_m: h, efficiency: 1.0, helmetMass_kg: 0, cushionStiffness_kN_m: 1e9, cushionCoefficientOfRestitution: 1.0, type: 'drop' },
    soilModel: { toeQuake_m: q, toeDamping_s_m: 0, shaftQuake_m: 0.0025, shaftDamping_s_m: 0 },
    options: { depths_m: [1.0], bearingGraphPoints: 3, timeStepFactor: 0.25 }
  });
  ok('run ok', r.ok, r.notes.join(' | '));
  const d = r.perDepth[0];
  const v0 = Math.sqrt(2 * 9.81 * h);
  const vp = 2 * mr * v0 / (mr + M);
  const setAnalytical = (0.5 * M * vp * vp / 1000 - 0.5 * Ru * q) / Ru;
  near('R_u,toe = 500 kN', d.Rtoe_kN, Ru, 1e-9);
  near('ram kinetic energy = m g h', r.hammer.kineticEnergy_kJ, mr * 9.81 * h / 1000, 1e-9);
  near('set = (½Mv_p² − ½R_u q)/R_u', d.set_mm, 1000 * setAnalytical, 0.005);
  near('blows/0.25 m = 0.25/set', d.blows_per_25cm, 0.25 / setAnalytical, 0.005);
  near('ENTHRU = ½ M v_p² (elastic collision)', d.enthru_kJ, 0.5 * M * vp * vp / 1000, 0.005);
  near('ram rebound energy = ½ m_r v_r²', d.energy.ramFinal_kJ, 0.5 * mr * Math.pow((mr - M) / (mr + M) * v0, 2) / 1000, 0.005);
  near('energy balance closes', d.energy.imbalance_kJ, 0, 0, 0.002 * r.hammer.kineticEnergy_kJ);
  ok('converged before t_max', d.converged === true, `${d.steps} steps, dt ${d.dt_s.toExponential(2)} s`);
  const rDefault = runImpactDrivability({ profile: prof, pile: { length_m: 1.0, area_m2: A, density_kg_m3: 7850, segmentLength_m: 1.0, toeArea_m2: 1.0, shaftPerimeter_m: 1.0 },
    hammer: { ramMass_kg: mr, dropHeight_m: h, efficiency: 1.0, helmetMass_kg: 0, cushionStiffness_kN_m: 1e9, cushionCoefficientOfRestitution: 1.0, type: 'drop' },
    soilModel: { toeQuake_m: q, toeDamping_s_m: 0, shaftQuake_m: 0.0025, shaftDamping_s_m: 0 }, options: { depths_m: [1.0], bearingGraphPoints: 3 } }).perDepth[0];
  near('default Δt (ω·Δt = 0.1) set within 0.5 % of the refined run', rDefault.set_mm, d.set_mm, 0.005);
  near('default Δt ram rebound within 1.5 % of the refined run (leap-frog energy error ∝ (ω·Δt)²)', rDefault.energy.ramFinal_kJ, d.energy.ramFinal_kJ, 0.015);
  // elastic case: capacity exceeds the pile energy → no set → refusal
  const rE = runImpactDrivability({
    profile: buildDrivingResistanceProfile({ cpt: { depth: [0, 2], qc: [20, 20], fs: [0, 0] }, pile: { toeArea_m2: 1.0, shaftPerimeter_m: 1.0 }, options: { dz: 0.1, maxDepth_m: 1.0 } }),
    pile: { length_m: 1.0, area_m2: A, segmentLength_m: 1.0, toeArea_m2: 1.0, shaftPerimeter_m: 1.0 },
    hammer: { ramMass_kg: mr, dropHeight_m: h, efficiency: 1.0, helmetMass_kg: 0, cushionStiffness_kN_m: 1e9, cushionCoefficientOfRestitution: 1.0, type: 'drop' },
    soilModel: { toeQuake_m: 0.0025, toeDamping_s_m: 0, shaftDamping_s_m: 0 },
    options: { depths_m: [1.0], bearingGraphPoints: 3 }
  });
  ok('purely elastic blow (½R_u q = 25 kJ > 8.7 kJ) ⇒ zero set, refusal', rE.perDepth[0].set_mm === 0 && rE.perDepth[0].refusal === true && rE.perDepth[0].blows_per_25cm === null);
}

console.log('== 2. Energy balance and behaviour of a realistic steel tube ==');
const Do = 0.508, tw = 0.0125, Di = Do - 2 * tw;
const tube = { toeArea_m2: Math.PI * Do * Do / 4, shaftPerimeter_m: Math.PI * Do, steelArea_m2: Math.PI / 4 * (Do * Do - Di * Di) };
const cptSand = (scale = 1) => ({ depth: [0, 25], qc: [10 * scale, 10 * scale], fs: [50 * scale, 50 * scale] });
const profSand = (scale = 1) => buildDrivingResistanceProfile({ cpt: cptSand(scale), pile: tube, options: { dz: 0.1, maxDepth_m: 15 } });
const pileTube = { length_m: 20, area_m2: tube.steelArea_m2, E_kPa: 210e6, density_kg_m3: 7850, segmentLength_m: 1.0, toeArea_m2: tube.toeArea_m2, shaftPerimeter_m: tube.shaftPerimeter_m };
const hhk7 = (over = {}) => ({ ramMass_kg: 7000, dropHeight_m: 1.0, efficiency: 0.8, helmetMass_kg: 1000, cushionStiffness_kN_m: 1.2e6, cushionCoefficientOfRestitution: 0.8, type: 'hydraulic', ...over });
const soilSand = { shaftQuake_m: 0.0025, toeQuake_m: toeQuakeFromDiameter(Do, 'dense'), shaftDamping_s_m: 0.16, toeDamping_s_m: 0.5 };
const base = runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: hhk7(), soilModel: soilSand, options: { targetDepth_m: 15, depthStep_m: 2.5 } });
ok('run ok', base.ok, base.notes.join(' | '));
{
  const last = base.perDepth[base.perDepth.length - 1];
  const E0 = base.hammer.kineticEnergy_kJ;
  near('E_kin = ½ m v² = η m g h = 54.9 kJ', E0, 7000 * 9.81 * 1.0 * 0.8 / 1000, 1e-9);
  ok('every depth closes the energy balance within 2 %', base.perDepth.every((d) => Math.abs(d.energy.imbalance_kJ) <= 0.02 * E0), base.perDepth.map((d) => (100 * d.energy.imbalance_kJ / E0).toFixed(2) + '%').join(', '));
  ok('all depths converged', base.perDepth.every((d) => d.converged), base.perDepth.map((d) => d.steps).join(','));
  ok('0 < ENTHRU ≤ E_kin', base.perDepth.every((d) => d.enthru_kJ > 0 && d.enthru_kJ <= E0 * 1.001), base.perDepth.map((d) => (d.enthru_kJ / E0).toFixed(2)).join(','));
  ok('energy budget = ram rebound + pile KE + strain + cushion + contact + soil', Math.abs(E0 - (last.energy.ramFinal_kJ + last.energy.kineticOthers_kJ + last.energy.pileStrain_kJ + last.energy.cushion_kJ + last.energy.contact_kJ + last.energy.soil_kJ) - last.energy.imbalance_kJ) < 1e-9);
  ok('soil work is the dominant sink at the final depth', last.energy.soil_kJ > 0.5 * E0, `${(last.energy.soil_kJ / E0 * 100).toFixed(0)} % of E_kin`);
  near('R_static at 15 m = shaft + toe', last.Rstatic_kN, profSand().Rstatic_kN[profSand().z.length - 1], 1e-6);
  ok('a realistic set (1–40 mm) at 3.2 MN static resistance', last.set_mm > 1 && last.set_mm < 40, `${last.set_mm.toFixed(2)} mm, ${last.blows_per_25cm.toFixed(0)} blows/0.25 m`);
  ok('set ≤ ENTHRU / R_static (all transferred energy as plastic work is an upper bound)', last.set_mm / 1000 <= last.enthru_kJ / last.Rstatic_kN, `${last.set_mm.toFixed(2)} mm ≤ ${(1000 * last.enthru_kJ / last.Rstatic_kN).toFixed(2)} mm`);
  ok('compressive stress positive and below yield', last.maxCompStress_MPa > 20 && last.maxCompStress_MPa < 355, `${last.maxCompStress_MPa.toFixed(1)} MPa`);
  const Z = base.pileModel.impedance_kNs_m;
  ok('peak top force ≤ 1.2·Z·v_impact (cushioned impact cannot exceed the impedance bound by much)', last.maxTopForce_kN <= 1.2 * Z * base.hammer.impactVelocity_m_s, `${last.maxTopForce_kN.toFixed(0)} kN vs Z·v = ${(Z * base.hammer.impactVelocity_m_s).toFixed(0)} kN`);
  ok('tension stress finite and ≥ 0', last.maxTensStress_MPa >= 0 && Number.isFinite(last.maxTensStress_MPa), `${last.maxTensStress_MPa.toFixed(1)} MPa`);
  mono('deeper ⇒ more blows (uniform sand)', base.perDepth.map((d) => d.blows_per_25cm), +1);
  ok('wave speed 5172 m/s for steel', Math.abs(base.pileModel.waveSpeed_m_s - Math.sqrt(210e9 / 7850)) < 1);
}

console.log('== 3. Monotonicity ==');
const blowsFinal = (r) => r.perDepth[r.perDepth.length - 1].blows_per_25cm;
mono('higher R_u (q_c, f_s × 0.5 … 2) ⇒ more blows', [0.5, 1, 1.5, 2].map((s) => blowsFinal(runImpactDrivability({ profile: profSand(s), pile: pileTube, hammer: hhk7(), soilModel: soilSand, options: { depths_m: [15] } }))), +1);
mono('higher energy (drop 0.4 … 1.2 m) ⇒ fewer blows', [0.4, 0.6, 0.8, 1.0, 1.2].map((h) => blowsFinal(runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: hhk7({ dropHeight_m: h }), soilModel: soilSand, options: { depths_m: [15] } }))), -1);
mono('higher efficiency ⇒ fewer blows', [0.5, 0.67, 0.8, 0.95].map((e) => blowsFinal(runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: hhk7({ efficiency: e }), soilModel: soilSand, options: { depths_m: [15] } }))), -1);
mono('more shaft damping ⇒ more blows', [0.16, 0.4, 0.65].map((J) => blowsFinal(runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: hhk7(), soilModel: { ...soilSand, shaftDamping_s_m: J }, options: { depths_m: [15] } }))), +1);
mono('bearing graph: blows increase with R_u', base.bearingGraph.map((p) => p.blows_per_25cm), +1);
ok('bearing graph spans 0.25–3 × R_static', base.bearingGraph.length === 12 && Math.abs(base.bearingGraph[11].Ru_kN / base.bearingGraph[3].Ru_kN - 3) < 1e-9);

console.log('== 4. Refusal, defaults, guards ==');
{
  const hard = runImpactDrivability({ profile: profSand(20), pile: pileTube, hammer: hhk7(), soilModel: soilSand, options: { depths_m: [15] } });
  const d = hard.perDepth[0];
  ok('q_c = 200 MPa ⇒ refusal labelled', d.refusal === true && (d.blows_per_25cm === null || d.blows_per_25cm >= 250), `set ${d.set_mm.toFixed(3)} mm`);
  ok('refusal note emitted', hard.notes.some((s) => /Refusal/.test(s)));
  const soft = runImpactDrivability({ profile: profSand(0.05), pile: pileTube, hammer: hhk7(), soilModel: soilSand, options: { depths_m: [15] } });
  ok('very soft ⇒ no refusal, few blows', soft.perDepth[0].refusal === false && soft.perDepth[0].blows_per_25cm < 20, `${soft.perDepth[0].blows_per_25cm.toFixed(1)} blows/0.25 m`);
}
{
  const dflt = runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: { ramMass_kg: 7000, ratedEnergy_kJ: 82, type: 'hydraulic' }, options: { depths_m: [15] } });
  ok('defaults: η = 0.80 hydraulic, quakes 2.5 mm, J_s 0.16, J_t 0.50', dflt.hammer.efficiency === 0.8 && dflt.soilModel.shaftQuake_m === 0.0025 && dflt.soilModel.toeQuake_m === 0.0025 && dflt.soilModel.shaftDamping_s_m === 0.16 && dflt.soilModel.toeDamping_s_m === 0.5);
  near('stroke from rated energy = E/(m g)', dflt.hammer.stroke_m, 82000 / (7000 * 9.81), 1e-9);
  ok('notes mention assumed efficiency, damping and cushion', ['efficiency', 'damping', 'cushion'].every((w) => dflt.notes.some((s) => new RegExp(w, 'i').test(s))), dflt.notes.join(' | '));
  const dsl = runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: { ramMass_kg: 4600, ratedEnergy_kJ: 166, type: 'diesel', helmetMass_kg: 1000, cushionStiffness_kN_m: 1.2e6 }, options: { depths_m: [15] } });
  ok('diesel: equivalent free-fall ram, note emitted, η = 0.80', dsl.ok && dsl.hammer.efficiency === 0.8 && dsl.notes.some((s) => /Diesel/.test(s)));
  ok('monitored hydraulic ⇒ η = 0.95', runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: { ramMass_kg: 7000, ratedEnergy_kJ: 82, type: 'hydraulic', energyMonitored: true }, options: { depths_m: [15] } }).hammer.efficiency === 0.95);
  ok('efficiency table matches the fetched GRLWEAP classes', HAMMER_EFFICIENCY_DEFAULTS['air-steam-single'] === 0.67 && HAMMER_EFFICIENCY_DEFAULTS['air-steam-double'] === 0.5 && HAMMER_EFFICIENCY_DEFAULTS.diesel === 0.8);
  near('D/120 toe quake for Ø508', toeQuakeFromDiameter(0.508), 0.508 / 120, 1e-12);
  const layered = runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: hhk7(), soilModel: { ...soilSand, shaftDamping_s_m: profSand().z.map((z) => (z < 8 ? 0.65 : 0.16)) }, options: { depths_m: [15] } });
  ok('per-layer shaft damping array accepted', layered.ok && Array.isArray(layered.soilModel.shaftDamping_s_m));
  const bad = runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: { ramMass_kg: 7000 }, options: {} });
  ok('missing stroke/energy ⇒ ok:false', bad.ok === false && /dropHeight_m or ratedEnergy_kJ/.test(bad.notes[0]));
  const badLen = runImpactDrivability({ profile: profSand(), pile: pileTube, hammer: hhk7(), soilModel: { shaftDamping_s_m: [1, 2] }, options: {} });
  ok('misaligned damping array ⇒ ok:false', badLen.ok === false);
  const tooDeep = runImpactDrivability({ profile: buildDrivingResistanceProfile({ cpt: cptSand(), pile: tube, options: { dz: 0.1, maxDepth_m: 25 } }), pile: pileTube, hammer: hhk7(), soilModel: soilSand, options: { targetDepth_m: 25, depthStep_m: 5 } });
  ok('target beyond pile length ⇒ stops at pile length with note', tooDeep.ok && tooDeep.perDepth[tooDeep.perDepth.length - 1].z <= 20 && tooDeep.notes.some((s) => /exceeds pile length/.test(s)));
  ok('results are plain JSON', !/NaN|Infinity/.test(JSON.stringify(base)));
}

console.log(`\n${n - fails}/${n} checks passed`);
process.exit(fails ? 1 : 0);
