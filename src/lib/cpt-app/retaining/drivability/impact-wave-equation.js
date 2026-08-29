// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck — plain ES module with JSDoc contracts and runtime input guards (repo pattern, see PLAN §5)
/**
 * Impact drivability — Smith (1960) one-dimensional wave equation ("heipredictie").
 *
 * Reference model
 *   Smith, E.A.L. (1960) "Pile-driving analysis by the wave equation", ASCE Journal of the
 *   Soil Mechanics and Foundations Division 86(SM4), 35–61 (https://ascelibrary.org/doi/10.1061/JSFEAQ.0000281).
 *   Hammer ram → hammer cushion → helmet → (pile cushion) → pile segments, each a lumped mass
 *   joined by springs; soil along the shaft and at the toe as elasto-plastic springs (quake q,
 *   ultimate R_u) plus Smith damping R_dyn = R_static·(1 + J·v).
 *
 * Default parameters (all fetched, see agent report)
 *   Quake:   shaft 2.5 mm; toe 2.5 mm, or D/120 (very dense/hard) … D/60 (softer/loose) for
 *            displacement piles — Rausche, "GRLWEAP Fundamentals" (PDCA), slides 38–40;
 *            FHWA GEC-12 Vol. II (NHI-16-009) §12.5 "Shaft quake and toe damping are generally
 *            left at the defaults of 0.10 inches and 0.15 s/ft".
 *   Damping: shaft clay 0.65 s/m (0.20 s/ft), sand 0.16 s/m (0.05 s/ft), silts intermediate;
 *            toe all soils 0.50 s/m (0.15 s/ft) — same sources (GRLWEAP slide 42; GEC-12 §12.8).
 *   Hammer efficiency (GRLWEAP, "Hammer Types, Efficiencies and Models in GRLWEAP", GRL 2007,
 *            and Rausche slide 28): diesel 0.80; hydraulic 0.80; hydraulic/diesel with internal
 *            energy monitoring 0.95; single-acting air/steam 0.67; double-acting air/steam or
 *            hydraulic 0.50. Drop (winch-released) hammers are not covered by that source: the
 *            0.50 used here is a conservative placeholder — set hammer.efficiency explicitly.
 *   Ram impact velocity v = √(2 g h η) with h = rated energy / (m g) (GRLWEAP procedure, Rausche slide 17).
 *   Refusal: FHWA GEC-12 Vol. II §17.2 practical refusal = 10 blows/inch ≈ 98 blows/0.25 m;
 *            this module labels ≥ options.refusalBlows (default 250 blows/0.25 m, set ≤ 1 mm) as refusal.
 *
 * Numerical method
 *   Explicit central-difference (leap-frog) integration of the lumped-mass chain.
 *   Δt = min(0.5·L_seg/c, 0.1/ω_max) with c = √(E/ρ) and ω_max the stiffest spring/mass pair;
 *   options.timeStepFactor (≤ 1) refines it further for convergence studies.
 *   Hammer cushion: compression-only, loading stiffness k, unloading stiffness k/e² (Smith 1960,
 *   coefficient of restitution e). Pile springs: linear, tension-capable (continuous pile).
 *   Shaft soil: two-way elasto-plastic spring; toe: compression-only. Damping is Smith's
 *   R_static·(1 + J·v); the product is clipped at zero when static and damping terms oppose
 *   (numerical safeguard, not part of Smith's paper). Set per blow = max toe displacement −
 *   toe quake (Smith 1960); blows/0.25 m = 0.25/set.
 *
 * Simplifications (documented limitations)
 *   - No gravity / static pre-equilibrium (pile self-weight ≪ driving forces).
 *   - Diesel hammers: equivalent free-fall ram energy; no combustion, pre-compression or impact block.
 *   - No residual stresses between blows, no splices/slacks, no pile-cap impedance change, no plug mass.
 *   - Single-blow analysis at each trial toe depth; the SRD profile comes from srd-from-cpt.js.
 *
 * Units: kN, kPa, m, kg, s. Energies in kJ (kN·m). Stresses in MPa.
 */
import { shaftStressAtTip, indexAtDepth } from './srd-from-cpt.js';

const G = 9.81;

export const HAMMER_EFFICIENCY_DEFAULTS = {
  hydraulic: 0.80, 'hydraulic-monitored': 0.95, diesel: 0.80, 'diesel-monitored': 0.95,
  'air-steam-single': 0.67, 'air-steam-double': 0.50, 'hydraulic-double': 0.50, drop: 0.50
};
export const SOIL_DEFAULTS = { shaftQuake_m: 0.0025, toeQuake_m: 0.0025, shaftDamping_s_m: { sand: 0.16, clay: 0.65, silt: 0.40 }, toeDamping_s_m: 0.50 };

/** Toe quake from pile diameter/width (GRLWEAP recommendation for displacement piles). */
export function toeQuakeFromDiameter(D_m, condition = 'dense') { return condition === 'loose' ? D_m / 60 : D_m / 120; }

/**
 * @param {object} args
 * @param {object} args.profile  from buildDrivingResistanceProfile()
 * @param {{length_m:number, area_m2:number, E_kPa?:number, density_kg_m3?:number, shaftPerimeter_m?:number,
 *          innerPerimeter_m?:number, toeArea_m2?:number, plugRatio?:number, interlockResistance_kN_m?:number,
 *          segmentLength_m?:number, pileCushionStiffness_kN_m?:number, pileCushionCOR?:number}} args.pile
 * @param {{ramMass_kg:number, dropHeight_m?:number, ratedEnergy_kJ?:number, efficiency?:number, energyMonitored?:boolean,
 *          helmetMass_kg?:number, cushionStiffness_kN_m?:number, cushionCoefficientOfRestitution?:number,
 *          type?:'hydraulic'|'diesel'|'drop'|'air-steam-single'|'air-steam-double'}} args.hammer
 * @param {{shaftQuake_m?:number, toeQuake_m?:number, shaftDamping_s_m?:number|number[], toeDamping_s_m?:number}} [args.soilModel]
 * @param {{targetDepth_m?:number, depthStep_m?:number, depths_m?:number[], refusalBlows?:number, bearingGraphPoints?:number,
 *          bearingGraphMaxFactor?:number, maxTime_s?:number, timeStepFactor?:number}} [args.options]
 */
export function runImpactDrivability({ profile, pile, hammer, soilModel = {}, options = {} }) {
  const notes = [];
  const fail = (msg) => ({ ok: false, notes: [msg], perDepth: [], bearingGraph: [] });
  if (!profile || !profile.ok || !profile.z.length) return fail('Profile missing or not ok.');
  if (!pile || !(pile.length_m > 0) || !(pile.area_m2 > 0)) return fail('Pile needs length_m > 0 and area_m2 > 0.');
  if (!hammer || !(hammer.ramMass_kg > 0)) return fail('Hammer needs ramMass_kg > 0.');

  // --- hammer ---------------------------------------------------------------------------------
  const type = hammer.type || 'hydraulic';
  const effKey = hammer.energyMonitored && (type === 'hydraulic' || type === 'diesel') ? `${type}-monitored` : type;
  const eff = hammer.efficiency > 0 ? Math.min(hammer.efficiency, 1) : (HAMMER_EFFICIENCY_DEFAULTS[effKey] ?? 0.8);
  if (!(hammer.efficiency > 0)) notes.push(`Hammer efficiency ${eff} assumed for type '${effKey}' (GRLWEAP defaults).`);
  if (type === 'drop' && !(hammer.efficiency > 0)) notes.push('Drop-hammer efficiency 0.50 is a placeholder (not in the fetched GRLWEAP source): set hammer.efficiency.');
  let stroke = hammer.dropHeight_m > 0 ? hammer.dropHeight_m : (hammer.ratedEnergy_kJ > 0 ? hammer.ratedEnergy_kJ * 1000 / (hammer.ramMass_kg * G) : NaN);
  if (!(stroke > 0)) return fail('Hammer needs dropHeight_m or ratedEnergy_kJ.');
  if (type === 'diesel') notes.push('Diesel hammer modelled as an equivalent free-fall ram (rated energy / ram weight); combustion, pre-compression and impact block are not modelled.');
  const v0 = Math.sqrt(2 * G * stroke * eff);
  const E0_kJ = 0.5 * hammer.ramMass_kg * v0 * v0 / 1000;
  const helmetMass = hammer.helmetMass_kg > 0 ? hammer.helmetMass_kg : 0;
  const cor = hammer.cushionCoefficientOfRestitution > 0 && hammer.cushionCoefficientOfRestitution <= 1 ? hammer.cushionCoefficientOfRestitution : 0.8;

  // --- pile ------------------------------------------------------------------------------------
  const E = pile.E_kPa > 0 ? pile.E_kPa : 210e6;
  const rho = pile.density_kg_m3 > 0 ? pile.density_kg_m3 : 7850;
  const A = pile.area_m2, L = pile.length_m;
  const segLenTarget = pile.segmentLength_m > 0 ? pile.segmentLength_m : 1.0;
  const N = Math.max(1, Math.round(L / segLenTarget));
  const Lseg = L / N;
  const mSeg = rho * A * Lseg;
  const kPile = E * A / Lseg; // kN/m
  const c = Math.sqrt(E * 1000 / rho);
  const perim = (pile.shaftPerimeter_m > 0 ? pile.shaftPerimeter_m : (profile.pile ? profile.pile.shaftPerimeter_m : 0)) + (pile.innerPerimeter_m > 0 ? pile.innerPerimeter_m : (pile.shaftPerimeter_m > 0 ? 0 : (profile.pile ? profile.pile.innerPerimeter_m : 0)));
  const toeArea = pile.toeArea_m2 > 0 ? pile.toeArea_m2 * (pile.plugRatio > 0 ? Math.min(pile.plugRatio, 1) : 1) : profile.effectiveToeArea_m2;
  const interlock = pile.interlockResistance_kN_m >= 0 ? pile.interlockResistance_kN_m : (profile.pile ? profile.pile.interlockResistance_kN_m : 0);
  if (!(perim > 0)) return fail('Shaft perimeter unknown (pile.shaftPerimeter_m or profile.pile).');
  let kCushion = hammer.cushionStiffness_kN_m > 0 ? hammer.cushionStiffness_kN_m : 10 * kPile;
  if (!(hammer.cushionStiffness_kN_m > 0)) notes.push(`Hammer cushion stiffness not given: near-rigid contact (10 × pile segment stiffness = ${kCushion.toExponential(2)} kN/m) assumed.`);
  const kPileCushion = pile.pileCushionStiffness_kN_m > 0 ? pile.pileCushionStiffness_kN_m : 0;
  const corPc = pile.pileCushionCOR > 0 && pile.pileCushionCOR <= 1 ? pile.pileCushionCOR : 0.5;

  // --- soil model ------------------------------------------------------------------------------
  const qShaft = soilModel.shaftQuake_m > 0 ? soilModel.shaftQuake_m : SOIL_DEFAULTS.shaftQuake_m;
  const qToe = soilModel.toeQuake_m > 0 ? soilModel.toeQuake_m : SOIL_DEFAULTS.toeQuake_m;
  const Jt = soilModel.toeDamping_s_m >= 0 ? soilModel.toeDamping_s_m : SOIL_DEFAULTS.toeDamping_s_m;
  const JsArr = Array.isArray(soilModel.shaftDamping_s_m) ? soilModel.shaftDamping_s_m : null;
  const JsScalar = !JsArr && soilModel.shaftDamping_s_m >= 0 ? soilModel.shaftDamping_s_m : SOIL_DEFAULTS.shaftDamping_s_m.sand;
  if (JsArr && JsArr.length !== profile.z.length) return fail('soilModel.shaftDamping_s_m[] must align with profile.z.');
  if (!JsArr && !(soilModel.shaftDamping_s_m >= 0)) notes.push('Shaft damping 0.16 s/m (sand) assumed; use 0.65 s/m for clay (GRLWEAP).');
  notes.push(`Quakes: shaft ${(qShaft * 1000).toFixed(2)} mm, toe ${(qToe * 1000).toFixed(2)} mm; damping: shaft ${JsArr ? 'per layer' : JsScalar + ' s/m'}, toe ${Jt} s/m (Smith).`);

  // --- trial depths ----------------------------------------------------------------------------
  const jTarget = Number.isFinite(options.targetDepth_m) ? indexAtDepth(profile, options.targetDepth_m) : profile.z.length - 1;
  const zTarget = profile.z[jTarget];
  let depths;
  if (Array.isArray(options.depths_m) && options.depths_m.length) depths = options.depths_m.map((z) => indexAtDepth(profile, z));
  else {
    const step = options.depthStep_m > 0 ? options.depthStep_m : 0.5;
    depths = [];
    for (let z = step; z < zTarget - 1e-9; z += step) depths.push(indexAtDepth(profile, z));
    depths.push(jTarget);
  }
  depths = [...new Set(depths)].filter((j) => j >= 0 && profile.z[j] <= L + 1e-9).sort((a, b) => a - b);
  if (!depths.length) return fail('No trial depth ≤ pile length.');
  if (zTarget > L) notes.push(`Target depth ${zTarget} m exceeds pile length ${L} m: analysis stops at the pile length.`);
  const refusalBlows = options.refusalBlows > 0 ? options.refusalBlows : 250;
  const maxTime = options.maxTime_s > 0 ? options.maxTime_s : Math.max(0.05, 100 * L / c);

  /** Build per-segment static shaft resistance and damping for toe index j; returns model soil arrays. */
  function soilAtDepth(j, scale = 1) {
    const z = profile.z[j];
    const stickup = L - z;
    const tau = shaftStressAtTip(profile, j);
    const Ru = new Array(N).fill(0), Js = new Array(N).fill(JsScalar);
    for (let s = 0; s < N; s++) {
      const d0 = s * Lseg - stickup, d1 = (s + 1) * Lseg - stickup; // depth range of segment s
      if (d1 <= 0) continue;
      let R = 0, RJ = 0;
      for (let i = 0; i <= j; i++) {
        const zc = profile.z[i] - profile.dz / 2;
        if (zc >= d0 && zc < d1) { const r = tau[i] * perim * profile.dz; R += r; RJ += r * (JsArr ? JsArr[i] : JsScalar); }
      }
      const embedded = Math.max(0, Math.min(d1, z) - Math.max(d0, 0));
      const Rsoil = R;
      R += interlock * embedded;
      Ru[s] = R * scale;
      Js[s] = Rsoil > 0 ? RJ / Rsoil : JsScalar;
      if (!(Js[s] >= 0)) Js[s] = JsScalar;
    }
    return { Ru, Js, Rtoe: profile.qToe_kPa[j] * toeArea * scale, shaft_kN: Ru.reduce((a, b) => a + b, 0) };
  }

  const dtFactor = options.timeStepFactor > 0 && options.timeStepFactor <= 1 ? options.timeStepFactor : 1;
  const model = { ramMass: hammer.ramMass_kg, v0, helmetMass, kCushion, cor, kPileCushion, corPc, N, mSeg, kPile, A, qShaft, qToe, Jt, maxTime, Lc: L / c, dtFactor };

  const perDepth = [];
  for (const j of depths) {
    const soil = soilAtDepth(j);
    const r = simulateBlow(model, soil);
    perDepth.push(summarize(profile.z[j], soil, r, refusalBlows));
  }

  // --- bearing graph at the final depth ---------------------------------------------------------
  const jF = depths[depths.length - 1];
  const nBG = options.bearingGraphPoints > 2 ? options.bearingGraphPoints : 12;
  const fMax = options.bearingGraphMaxFactor > 0 ? options.bearingGraphMaxFactor : 3;
  const RstaticF = profile.Rstatic_kN[jF];
  const bearingGraph = [];
  for (let k = 1; k <= nBG; k++) {
    const scale = fMax * k / nBG;
    const soil = soilAtDepth(jF, scale);
    const r = simulateBlow(model, soil);
    const s = summarize(profile.z[jF], soil, r, refusalBlows);
    bearingGraph.push({ Ru_kN: RstaticF * scale, blows_per_25cm: s.blows_per_25cm, set_mm: s.set_mm, refusal: s.refusal, maxCompStress_MPa: s.maxCompStress_MPa, maxTensStress_MPa: s.maxTensStress_MPa, enthru_kJ: s.enthru_kJ });
  }

  const last = perDepth[perDepth.length - 1];
  notes.push(`Hammer: ram ${hammer.ramMass_kg} kg, equivalent stroke ${stroke.toFixed(3)} m, η = ${eff}, v_impact = ${v0.toFixed(2)} m/s, E_kin = ${E0_kJ.toFixed(1)} kJ.`);
  notes.push(`Pile: ${N} segments of ${Lseg.toFixed(2)} m, c = ${c.toFixed(0)} m/s, impedance Z = ${(E * A / c).toFixed(0)} kN·s/m.`);
  if (last.refusal) notes.push(`Refusal (≥ ${refusalBlows} blows/0.25 m) predicted at the target depth.`);
  return {
    ok: true,
    hammer: { type, efficiency: eff, stroke_m: stroke, impactVelocity_m_s: v0, kineticEnergy_kJ: E0_kJ, helmetMass_kg: helmetMass, cushionStiffness_kN_m: kCushion, cor },
    pileModel: { segments: N, segmentLength_m: Lseg, segmentMass_kg: mSeg, segmentStiffness_kN_m: kPile, waveSpeed_m_s: c, impedance_kNs_m: E * A / c },
    soilModel: { shaftQuake_m: qShaft, toeQuake_m: qToe, shaftDamping_s_m: JsArr || JsScalar, toeDamping_s_m: Jt },
    perDepth, bearingGraph, notes
  };
}

function summarize(z, soil, r, refusalBlows) {
  const set = r.set_m;
  const blowsRaw = set > 0 ? 0.25 / set : Infinity;
  const refusal = !(blowsRaw < refusalBlows);
  return { z, Rstatic_kN: soil.shaft_kN + soil.Rtoe, Rshaft_kN: soil.shaft_kN, Rtoe_kN: soil.Rtoe,
    set_mm: 1000 * set, blows_per_25cm: Number.isFinite(blowsRaw) ? Math.min(blowsRaw, 9999) : null, refusal,
    maxCompStress_MPa: r.maxComp_kPa / 1000, maxTensStress_MPa: r.maxTens_kPa / 1000, enthru_kJ: r.enthru_kJ,
    maxToeDisplacement_mm: 1000 * r.uToeMax, maxTopForce_kN: r.maxTopForce, energy: r.energy, converged: r.converged, steps: r.steps, dt_s: r.dt };
}

/**
 * One hammer blow on the lumped-mass chain. Pure; returns set, stresses and an energy audit.
 * Chain index: 0 = ram, [1 = helmet], then N pile masses (top → toe).
 */
export function simulateBlow(model, soil) {
  const { ramMass, v0, helmetMass, kCushion, cor, kPileCushion, corPc, N, mSeg, kPile, A, qShaft, qToe, Jt, maxTime, Lc } = model;
  const dtFactor = model.dtFactor > 0 ? model.dtFactor : 1;
  const hasHelmet = helmetMass > 0;
  const nTop = hasHelmet ? 2 : 1;
  const n = nTop + N;
  const m = new Float64Array(n);
  m[0] = ramMass; if (hasHelmet) m[1] = helmetMass;
  for (let i = 0; i < N; i++) m[nTop + i] = mSeg;
  const u = new Float64Array(n), v = new Float64Array(n);
  v[0] = v0;

  // Springs between i and i+1: type 0 = pile (linear), 1 = cushion (compression-only, COR), 2 = contact (compression-only, elastic)
  const nS = n - 1;
  const kS = new Float64Array(nS), typeS = new Int8Array(nS), corS = new Float64Array(nS);
  const cMax = new Float64Array(nS), fMax = new Float64Array(nS);
  kS[0] = kCushion; typeS[0] = 1; corS[0] = cor;
  if (hasHelmet) {
    if (kPileCushion > 0) { kS[1] = kPileCushion; typeS[1] = 1; corS[1] = corPc; }
    else { kS[1] = kPile; typeS[1] = 2; corS[1] = 1; }
  }
  for (let s = nTop; s < nS; s++) { kS[s] = kPile; typeS[s] = 0; corS[s] = 1; }

  // time step: 0.5·L_seg/c for the pile chain, and ω·Δt ≤ 0.1 for the stiffest spring/mass pair
  // (resolves a cushion contact with ≥ 30 steps; leap-frog energy error ∝ (ω·Δt)² — see verify script)
  let dt = Infinity;
  for (let s = 0; s < nS; s++) { const w = Math.sqrt(kS[s] * 1000 * (1 / m[s] + 1 / m[s + 1])); dt = Math.min(dt, 0.1 / w); }
  if (N > 1) dt = Math.min(dt, 0.5 * Lc / N); // 0.5·L_seg/c
  if (!(dt > 0) || !Number.isFinite(dt)) dt = 1e-5;
  dt *= dtFactor;

  // soil state
  const uP = new Float64Array(N); // plastic displacement of shaft springs
  const kShaft = new Float64Array(N);
  for (let i = 0; i < N; i++) kShaft[i] = soil.Ru[i] > 0 ? soil.Ru[i] / qShaft : 0;
  const kToe = soil.Rtoe > 0 ? soil.Rtoe / qToe : 0;
  let uPtoe = 0;

  const F = new Float64Array(nS), Fprev = new Float64Array(nS);
  const Rsoil = new Float64Array(N), Rprev = new Float64Array(N);
  let maxComp = 0, maxTens = 0, maxTopForce = 0, uToeMax = 0, enthru = 0;
  let workSoil = 0, workCushion = 0, workContact = 0;
  let t = 0, steps = 0, tLastAdvance = 0, converged = false, first = true;
  const E0 = 0.5 * ramMass * v0 * v0 / 1000;
  const toe = n - 1;

  while (t < maxTime) {
    // spring forces (positive = compression)
    for (let s = 0; s < nS; s++) {
      const cc = u[s] - u[s + 1];
      if (typeS[s] === 0) F[s] = kS[s] * cc;
      else if (cc <= 0) { F[s] = 0; cMax[s] = 0; fMax[s] = 0; }
      else if (cc >= cMax[s]) { F[s] = kS[s] * cc; cMax[s] = cc; fMax[s] = F[s]; }
      else { F[s] = Math.max(0, fMax[s] - (kS[s] / (corS[s] * corS[s])) * (cMax[s] - cc)); }
    }
    // soil forces on pile masses
    for (let i = 0; i < N; i++) {
      const node = nTop + i;
      let R = 0;
      if (kShaft[i] > 0) {
        let Rs = kShaft[i] * (u[node] - uP[i]);
        if (Rs > soil.Ru[i]) { uP[i] = u[node] - qShaft; Rs = soil.Ru[i]; }
        else if (Rs < -soil.Ru[i]) { uP[i] = u[node] + qShaft; Rs = -soil.Ru[i]; }
        const fac = Math.max(0, 1 + soil.Js[i] * v[node] * Math.sign(Rs));
        R = Rs * fac;
      }
      if (i === N - 1 && kToe > 0) {
        let Rt = kToe * (u[node] - uPtoe);
        if (Rt > soil.Rtoe) { uPtoe = u[node] - qToe; Rt = soil.Rtoe; }
        if (Rt < 0) Rt = 0;
        R += Rt * (1 + Jt * Math.max(0, v[node]));
      }
      Rsoil[i] = R;
    }
    // work / energy bookkeeping over the displacement increment just applied (u_n − u_{n−1} = v_{n−½}·Δt),
    // trapezoidal in the force: ½(F_{n−1} + F_n)·Δu
    if (!first) {
      for (let s = 0; s < nS; s++) {
        const dc = (v[s] - v[s + 1]) * dt;
        if (typeS[s] === 1) workCushion += 0.5 * (Fprev[s] + F[s]) * dc;
        else if (typeS[s] === 2) workContact += 0.5 * (Fprev[s] + F[s]) * dc;
      }
      for (let i = 0; i < N; i++) workSoil += 0.5 * (Rprev[i] + Rsoil[i]) * v[nTop + i] * dt;
      enthru += 0.5 * (Fprev[nTop - 1] + F[nTop - 1]) * v[nTop] * dt;
    }
    first = false;
    Fprev.set(F); Rprev.set(Rsoil);
    // integrate (leap-frog): v_{n+½} = v_{n−½} + a_n Δt ; u_{n+1} = u_n + v_{n+½} Δt
    for (let i = 0; i < n; i++) {
      const fAbove = i > 0 ? F[i - 1] : 0;
      const fBelow = i < nS ? F[i] : 0;
      const fSoil = i >= nTop ? Rsoil[i - nTop] : 0;
      v[i] += (fAbove - fBelow - fSoil) * 1000 / m[i] * dt;
    }
    for (let i = 0; i < n; i++) u[i] += v[i] * dt;
    t += dt; steps++;

    // stresses and plastic advance
    for (let s = nTop; s < nS; s++) { if (F[s] > maxComp) maxComp = F[s]; if (-F[s] > maxTens) maxTens = -F[s]; }
    if (F[nTop - 1] > maxTopForce) maxTopForce = F[nTop - 1];
    if (u[toe] > uToeMax) { uToeMax = u[toe]; tLastAdvance = t; }

    // termination: ram separated & not approaching, toe not advancing for 6 L/c, and either the pile
    // has lost its kinetic energy or every soil spring is unloaded with the pile moving up/still.
    // After 40 L/c without any further toe advance the residual ringing cannot change the set: stop.
    if (t - tLastAdvance > 6 * Lc && F[0] === 0 && v[0] <= v[1]) {
      let ke = 0; for (let i = 1; i < n; i++) ke += 0.5 * m[i] * v[i] * v[i];
      let soilLoaded = false, anyDown = false;
      for (let i = 0; i < N; i++) { if (Math.abs(Rsoil[i]) > 1e-9) soilLoaded = true; if (v[nTop + i] > 1e-6) anyDown = true; }
      if (ke / 1000 <= 0.01 * E0 || (!soilLoaded && !anyDown) || t - tLastAdvance > 40 * Lc) { converged = true; break; }
    }
  }
  // energy audit (kJ)
  let keRam = 0.5 * m[0] * v[0] * v[0] / 1000, keOthers = 0, strain = 0;
  for (let i = 1; i < n; i++) keOthers += 0.5 * m[i] * v[i] * v[i] / 1000;
  for (let s = nTop; s < nS; s++) { const cc = u[s] - u[s + 1]; strain += 0.5 * kS[s] * cc * cc; }
  const energy = { ramInitial_kJ: E0, ramFinal_kJ: keRam, kineticOthers_kJ: keOthers, pileStrain_kJ: strain, cushion_kJ: workCushion, contact_kJ: workContact, soil_kJ: workSoil, enthru_kJ: enthru };
  energy.imbalance_kJ = E0 - (keRam + keOthers + strain + workCushion + workContact + workSoil);

  const set = kToe > 0 ? Math.max(0, uPtoe) : Math.max(0, uToeMax - qToe);
  return { set_m: set, uToeMax, maxComp_kPa: Math.max(maxComp, maxTopForce) / A, maxTens_kPa: maxTens / A, maxTopForce, enthru_kJ: enthru, energy, converged, steps, dt };
}
