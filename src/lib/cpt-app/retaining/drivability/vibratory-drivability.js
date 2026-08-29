// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck — plain ES module with JSDoc contracts and runtime input guards (repo pattern, see PLAN §5)
/**
 * Vibratory drivability — Hypervib1-type force-envelope method (CPT based).
 *
 * Purpose
 *   For every trial toe depth z_j ≤ target, find the smallest peak centrifugal force F_c
 *   for which the peak downward force F_c + W_eff is at least m_R times the vibratory
 *   driving resistance R_drive(F_c). R_drive depends on F_c through the pile acceleration
 *   (higher acceleration → more soil degradation), so the root is found by bisection.
 *   Then convert the governing force into a machine requirement at the chosen frequency.
 *
 * Formulation (course "Vibratory pile installation" §4, §7, §8; reproduced from course material)
 *   FR_i     = 100·f_s/q_c                                  [percentage NUMBER, course §5.2, §18.3]
 *   χ_i      = (1 − 1/Λ)·exp(−1/FR_i) + 1/Λ                  (FR = 0 → χ = 1/Λ)
 *   q_l, τ_l = χ·q_s, χ·τ_s                                  fully degraded ("liquefied") values
 *   α        = a/g ;  q_d = (q_s − q_l)·e^{−α} + q_l ; τ_d likewise
 *   a        = max(0, 1000·(F_c − δ_H·R_s)/M_dyn)            iterated to convergence (δ_H = 0 → free acceleration)
 *   R_s      = Σ τ_d,i·P_i·Δz ;  R_b = q_d,toe·A_b ;  R_drive = R_s + R_b + R_interlock
 *   W_eff    = M_dyn·g/1000 + F_crowd − T_line              [kN]
 *   G(F_c)   = F_c + W_eff − m_R·R_drive(F_c)  ≥ 0           force-envelope margin
 *   ω = 2πf ; M_e = 1000·F_c/ω² [kg·m] ; s_0 = M_e/M_dyn [m] ; A_pp = 2 s_0 ; α_req = 1000 F_c/(M_dyn g)
 *   σ_screen = (F_c + W_eff)/A_s                             preliminary uniform axial stress screen
 *
 * Primary-source verification status
 *   - χ (eq. 18a/b), the acceleration interpolation q_d = (q_s − q_l)e^{−α} + q_l (eq. 19a/b),
 *     FR as a percentage and Λ "chosen in the range of 4 to 10" are VERIFIED verbatim in
 *     Holeyman, A. (2002) "Soil behavior under vibratory driving", keynote, TransVib 2002,
 *     pp. 14–15 (open PDF: https://www.fondytest.com/Alain-Holeyman-s-publications/pdf/2002-Transvib-1.pdf).
 *   - The force-envelope inequality F_c + W_eff > R_drive is the "force equilibrium model"
 *     class reviewed in the same keynote §5.2 (Jonker 1987; Warrington 1989) and course §4.4.
 *   - The δ_H shaft-reaction reduction of the free acceleration and the m_R reserve multiplier
 *     are reproduced from the course material only; the 2002 keynote describes Hypervib1 as an
 *     "iterative procedure to identify the coexisting acceleration and soil resistance" without
 *     giving δ_H. Van Rompaey, Legrand & Holeyman (1995) (WIT Trans. Built Env. 14, 533–542)
 *     and Holeyman & Whenham (2017) (Geotech. Geol. Eng. 35, 1933–1951; Λ confirmed in the
 *     abstract's nomenclature) are paywalled and were NOT checked in full.
 *
 * Status
 *   Non-normative, empirical (course §7.1). No Eurocode partial factors (PLAN D10).
 *   Upper-bound SRD in, transparent equipment reserve m_R out. Does not predict penetration rate.
 *
 * Units: kN, kPa, m, kg, Hz, g = 9.81 m/s² (as in the course example).
 */
import { shaftStressAtTip, indexAtDepth } from './srd-from-cpt.js';

export const G_M_S2 = 9.81;

/** Fully degraded resistance ratio χ (course §7.3; Holeyman 2002 eq. 18). FR in percent. */
export function chiFactor(frictionRatioPct, lambda) {
  if (!(lambda > 0)) return 1;
  if (!(frictionRatioPct > 0)) return 1 / lambda;
  return (1 - 1 / lambda) * Math.exp(-1 / frictionRatioPct) + 1 / lambda;
}

/**
 * @param {object} args
 * @param {object} args.profile  output of buildDrivingResistanceProfile()
 * @param {{frequency_Hz:number, dynamicMass_kg:number, crowd_kN?:number, lineForce_kN?:number,
 *          eccentricMoment_kgm?:number, centrifugalForce_kN?:number}} args.vibrator
 * @param {object} [args.pile]  overrides profile.pile: { toeArea_m2, shaftPerimeter_m, innerPerimeter_m, plugRatio, interlockResistance_kN_m, steelArea_m2 }
 * @param {{lambda?:number, deltaH?:number, reserveMultiplier?:number, targetDepth_m?:number,
 *          accelerationTolerance?:number, maxIterations?:number, curvePoints?:number}} [args.options]
 */
export function runVibratoryDrivability({ profile, vibrator, pile, options = {} }) {
  const notes = [];
  const fail = (msg) => ({ ok: false, notes: [msg], perDepth: [], forceEnvelopeCurve: [] });
  if (!profile || !profile.ok || !profile.z || !profile.z.length) return fail('Profile missing or not ok.');
  if (!vibrator || !(vibrator.frequency_Hz > 0) || !(vibrator.dynamicMass_kg > 0)) return fail('Vibrator needs frequency_Hz > 0 and dynamicMass_kg > 0.');

  const f = vibrator.frequency_Hz, Mdyn = vibrator.dynamicMass_kg;
  const crowd = Number.isFinite(vibrator.crowd_kN) ? vibrator.crowd_kN : 0;
  const line = Number.isFinite(vibrator.lineForce_kN) ? vibrator.lineForce_kN : 0;
  let lambda = Number.isFinite(options.lambda) ? options.lambda : 6;
  if (lambda < 4 || lambda > 10) { notes.push(`Λ = ${lambda} outside the published 4–10 range (Holeyman 2002); clipped.`); lambda = Math.min(10, Math.max(4, lambda)); }
  const deltaH = Number.isFinite(options.deltaH) && options.deltaH >= 0 ? options.deltaH : 0;
  const mR = options.reserveMultiplier > 0 ? options.reserveMultiplier : 1.0;
  const tol = options.accelerationTolerance > 0 ? options.accelerationTolerance : 0.01;
  const maxIt = options.maxIterations > 0 ? options.maxIterations : 50;
  const jTarget = Number.isFinite(options.targetDepth_m) ? indexAtDepth(profile, options.targetDepth_m) : profile.z.length - 1;

  const Pg = pile ? normalizePile(pile) : null;
  const perim = Pg ? Pg.perim : profile.contactPerimeter_m;
  const toeArea = Pg ? Pg.toeArea : profile.effectiveToeArea_m2;
  const interlock = Pg ? Pg.interlock : (profile.pile ? profile.pile.interlockResistance_kN_m : 0);
  const As = Pg && Pg.steelArea ? Pg.steelArea : (profile.pile && profile.pile.steelArea_m2) || null;
  if (!(perim > 0) || !(toeArea >= 0)) return fail('Pile geometry missing (shaftPerimeter_m, toeArea_m2).');
  if (deltaH === 0) notes.push('δ_H = 0: optimistic free-acceleration baseline (course §8.1). Calibrate against measured amplitude (course §15.8).');
  if (!As) notes.push('Steel area unknown: stress screen not computed.');

  const Weff = Mdyn * G_M_S2 / 1000 + crowd - line;
  const dz = profile.dz;
  const omega = 2 * Math.PI * f;

  // --- per-depth static / degraded arrays -------------------------------------------------
  const depth = [];
  for (let j = 0; j <= jTarget; j++) {
    const tauS = shaftStressAtTip(profile, j);
    const tauL = new Array(j + 1);
    for (let i = 0; i <= j; i++) tauL[i] = chiFactor(profile.frictionRatioPct[i], lambda) * tauS[i];
    const qS = profile.qToe_kPa[j];
    const chiToe = chiFactor(profile.frictionRatioPct[j], lambda);
    const qL = chiToe * qS;
    const Rint = interlock * profile.z[j];
    let RsStatic = 0, RsLiq = 0;
    for (let i = 0; i <= j; i++) { RsStatic += tauS[i] * perim * dz; RsLiq += tauL[i] * perim * dz; }
    depth.push({ j, z: profile.z[j], tauS, tauL, qS, qL, chiToe, Rint, RsStatic, RbStatic: qS * toeArea, RsLiq, RbLiq: qL * toeArea });
  }

  /** Driving resistance at force Fc for depth record D (course §7.5–7.6). */
  function resistance(D, Fc) {
    let a = Math.max(0, 1000 * Fc / Mdyn);
    let alpha = 0, Rs = 0, Rb = 0, qd = 0, taud = 0, it = 0, converged = false;
    for (it = 0; it < maxIt; it++) {
      alpha = a / G_M_S2;
      const e = Math.exp(-alpha);
      Rs = 0;
      for (let i = 0; i <= D.j; i++) Rs += ((D.tauS[i] - D.tauL[i]) * e + D.tauL[i]) * perim * dz;
      qd = (D.qS - D.qL) * e + D.qL;
      taud = (D.tauS[D.j] - D.tauL[D.j]) * e + D.tauL[D.j];
      Rb = qd * toeArea;
      const aNew = Math.max(0, 1000 * (Fc - deltaH * Rs) / Mdyn);
      if (Math.abs(aNew - a) / Math.max(a, 0.01 * G_M_S2) < tol) { a = aNew; converged = true; break; }
      a = aNew;
    }
    return { Rs, Rb, Rint: D.Rint, Rdrive: Rs + Rb + D.Rint, alpha: a / G_M_S2, qd, taud, iterations: it + 1, converged };
  }
  const margin = (D, Fc, m) => Fc + Weff - m * resistance(D, Fc).Rdrive;

  /** Smallest Fc with G ≥ 0 (bisection; G is monotone because R_drive decreases with α). */
  function rootForce(D, m) {
    if (margin(D, 0, m) >= 0) return 0;
    let lo = 0, hi = m * (D.RsStatic + D.RbStatic + D.Rint) + 1; // G(hi) ≥ 0 since R_drive ≤ R_static
    for (let k = 0; k < 64; k++) { const mid = 0.5 * (lo + hi); if (margin(D, mid, m) < 0) lo = mid; else hi = mid; if (hi - lo < 1e-6) break; }
    return 0.5 * (lo + hi);
  }

  const perDepth = [];
  let unconverged = 0;
  let gov = 0, govFc = -1, gov125 = 0, govFc125 = -1;
  for (const D of depth) {
    const FcMin = rootForce(D, mR);
    const FcMin125 = rootForce(D, 1.25);
    const r = resistance(D, FcMin);
    if (!r.converged) unconverged++;
    perDepth.push({ z: D.z, Rstatic_kN: D.RsStatic + D.RbStatic + D.Rint, Rliquefied_kN: D.RsLiq + D.RbLiq + D.Rint, chiToe: D.chiToe,
      Rs_kN: r.Rs, Rb_kN: r.Rb, Rinterlock_kN: D.Rint, Rdrive_kN: r.Rdrive, alpha: r.alpha, qd_kPa: r.qd, taud_kPa: r.taud,
      FcMin_kN: FcMin, FcMin125_kN: FcMin125 });
    if (FcMin > govFc) { govFc = FcMin; gov = perDepth.length - 1; }
    if (FcMin125 > govFc125) { govFc125 = FcMin125; gov125 = perDepth.length - 1; }
  }
  if (unconverged) notes.push(`Acceleration iteration did not converge at ${unconverged} depth(s) within ${maxIt} iterations.`);

  const Dg = depth[gov];
  const convert = (Fc) => {
    const Me = 1000 * Fc / (omega * omega);
    const s0 = Me / Mdyn;
    return { Fc_kN: Fc, eccentricMoment_kgm: Me, amplitude_mm: 1000 * s0, amplitudePp_mm: 2000 * s0,
      accelerationRatio: 1000 * Fc / (Mdyn * G_M_S2), stressScreen_MPa: As ? (Fc + Weff) / As / 1000 : null };
  };

  // --- candidate machine check --------------------------------------------------------------
  let candidateCheck = null;
  let FcCand = null;
  if (vibrator.centrifugalForce_kN > 0) FcCand = vibrator.centrifugalForce_kN;
  else if (vibrator.eccentricMoment_kgm > 0) FcCand = vibrator.eccentricMoment_kgm * omega * omega / 1000;
  if (FcCand !== null) {
    // Drive-to-refusal scan (course §4.4): the pile is driven from the surface; the first depth at which
    // the force envelope closes (G < 0) is the predicted refusal — the machine cannot pass it, whatever
    // the margin further down. "Achievable" = the last depth before that with G ≥ 0.
    let worst = null;
    let refusal = null, refusal125 = null, achievable = 0, achievable125 = 0;
    for (let k = 0; k < depth.length; k++) {
      const D = depth[k];
      const r = resistance(D, FcCand);
      const g1 = FcCand + Weff - r.Rdrive, g125 = FcCand + Weff - 1.25 * r.Rdrive;
      perDepth[k].Gcand_kN = g1; perDepth[k].Gcand125_kN = g125;
      if (!worst || g1 < worst.margin_kN) worst = { z: D.z, margin_kN: g1, margin125_kN: g125, alpha: r.alpha, Rdrive_kN: r.Rdrive, Rs_kN: r.Rs, Rb_kN: r.Rb, qd_kPa: r.qd, taud_kPa: r.taud };
      if (refusal === null) { if (g1 >= 0) achievable = D.z; else refusal = D.z; }
      if (refusal125 === null) { if (g125 >= 0) achievable125 = D.z; else refusal125 = D.z; }
    }
    const target = depth[depth.length - 1].z;
    const atTarget = perDepth[perDepth.length - 1];
    candidateCheck = {
      Fc_kN: FcCand, ...worst, ok: worst.margin_kN >= 0, ok125: worst.margin125_kN >= 0, ...convert(FcCand),
      targetDepth_m: target,
      achievableDepth_m: achievable, refusalDepth_m: refusal, reachesTarget: refusal === null,
      achievableDepth125_m: achievable125, refusalDepth125_m: refusal125, reachesTarget125: refusal125 === null,
      marginAtTarget_kN: atTarget.Gcand_kN, marginAtTarget125_kN: atTarget.Gcand125_kN
    };
    notes.push(refusal === null
      ? `Candidate F_c = ${FcCand.toFixed(0)} kN: force envelope open down to the target ${target.toFixed(2)} m (m_R = 1.0${refusal125 === null ? ' and 1.25' : `; with m_R = 1.25 refusal predicted at ${refusal125.toFixed(2)} m`}).`
      : `Candidate F_c = ${FcCand.toFixed(0)} kN: refusal predicted at ${refusal.toFixed(2)} m (m_R = 1.0) — mechanically possible down to ${achievable.toFixed(2)} m of the ${target.toFixed(2)} m target.`);
  }

  // --- force-envelope curve at the governing depth --------------------------------------------
  const nPts = options.curvePoints > 4 ? options.curvePoints : 41;
  const FcTop = 1.4 * Math.max(govFc125, FcCand || 0, 1);
  const forceEnvelopeCurve = [];
  for (let k = 0; k < nPts; k++) {
    const Fc = FcTop * k / (nPts - 1);
    const r = resistance(Dg, Fc);
    forceEnvelopeCurve.push({ Fc_kN: Fc, G_kN: Fc + Weff - r.Rdrive, G125_kN: Fc + Weff - 1.25 * r.Rdrive, Rdrive_kN: r.Rdrive, alpha: r.alpha });
  }

  const design = FcCand !== null ? convert(FcCand) : convert(govFc125);
  notes.push(`Force-envelope root: F_c,min(m_R=${mR}) = ${govFc.toFixed(1)} kN at ${Dg.z.toFixed(2)} m; F_c,min(1.25) = ${govFc125.toFixed(1)} kN at ${depth[gov125].z.toFixed(2)} m.`);
  notes.push('Non-normative empirical model (course §7.1): confirm by an instrumented trial; check amplitude, clamp, power, wave stress and vibration separately (course §7.10).');

  return {
    ok: true,
    lambda, deltaH, reserveMultiplier: mR, frequency_Hz: f, omega_rad_s: omega, dynamicMass_kg: Mdyn, Weff_kN: Weff,
    perDepth,
    governingDepth_m: Dg.z, governingDepth125_m: depth[gov125].z,
    FcRequired_kN: govFc, FcRequired125_kN: govFc125,
    designForce_kN: design.Fc_kN, designForceBasis: FcCand !== null ? 'candidate' : 'required-1.25',
    eccentricMoment_kgm: design.eccentricMoment_kgm, amplitude_mm: design.amplitude_mm, amplitudePp_mm: design.amplitudePp_mm,
    accelerationRatio: design.accelerationRatio, stressScreen_MPa: design.stressScreen_MPa,
    machine: { atRequired: convert(govFc), atRequired125: convert(govFc125), atCandidate: FcCand !== null ? convert(FcCand) : null },
    candidateCheck,
    forceEnvelopeCurve,
    notes
  };
}

function normalizePile(p) {
  const perim = (p.shaftPerimeter_m > 0 ? p.shaftPerimeter_m : 0) + (p.innerPerimeter_m > 0 ? p.innerPerimeter_m : 0);
  const toeArea = (p.toeArea_m2 > 0 ? p.toeArea_m2 : 0) * (p.plugRatio > 0 ? Math.min(p.plugRatio, 1) : 1);
  return { perim, toeArea, interlock: p.interlockResistance_kN_m > 0 ? p.interlockResistance_kN_m : 0, steelArea: p.steelArea_m2 > 0 ? p.steelArea_m2 : null };
}
