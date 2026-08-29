// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck — plain ES module with JSDoc contracts and runtime input guards (repo pattern)
/**
 * Static push-in (press-in / "drukken") drivability — quasi-static force balance.
 *
 * Question answered: an element is pushed into the ground with a static force F_push (excavator
 * crowd through a driving cap, or the rated press force of a press-in machine). How deep does it go?
 *
 * Model
 *   The element advances while the applied force plus the element's own weight exceeds the static
 *   resistance to penetration at the toe depth z:
 *       F_push + W(z) ≥ m_R · R_static(z),   R_static = R_shaft(z) + R_toe(z) + R_interlock(z)
 *   R_static(z) is the CPT-based static resistance profile of srd-from-cpt.js (reference method
 *   q_s = q_c, τ_s = f_s, or Alm & Hamre 2001 with friction fatigue — the latter is the usual basis
 *   for press-in predictions). No dynamic degradation applies: pressing does not liquefy the shaft.
 *   The predicted refusal is the first depth where the inequality fails; the required press force
 *   for a target depth is the largest (R_static − W) over 0 … target. m_R = 1.25 is the same
 *   equipment reserve as for the vibratory method, not a partial factor.
 *
 * Limits / assumptions (course §1.2, §7.10 apply)
 *   * Quasi-static: no rate effects, no set-up between strokes, no plug-formation modelling beyond
 *     the toe-area choice of the element (unplugged / plugged H-pile, sheet-pile toe plane).
 *   * The static profile is an UPPER envelope (dense lenses, no resistance factors) — the right basis
 *     for "will it get there", too high for "how much capacity does it have".
 *   * Reaction: a press-in machine needs the reaction force from previously installed elements or
 *     ballast; an excavator can only push what its weight and boom geometry allow (typically not
 *     more than 30–50 % of its operating weight through the boom — enter the value the contractor
 *     guarantees, not the hydraulic maximum).
 *   * Obstructions and very dense layers (q_c > 30 MPa) refuse pressing long before the calculation
 *     says so; pre-drilling or vibratory assistance is the usual answer (course §14).
 *
 * References
 *   Alm, T. & Hamre, L. (2001). Soil model for pile driveability predictions based on CPT
 *   interpretations. Proc. 15th ICSMGE, Istanbul, 1297–1302.  White, D.J. & Deeks, A.D. (2007).
 *   Recent research into the behaviour of jacked foundation piles. Advances in Deep Foundations,
 *   Taylor & Francis, 3–26 (press-in force ≈ static CPT-based capacity with friction fatigue).
 *
 * Units: kN, m. Pure; invalid input returns ok:false with notes.
 */
import { indexAtDepth } from './srd-from-cpt.js';

const G_M_S2 = 9.81;

/**
 * @param {object} args
 * @param {object} args.profile          output of buildDrivingResistanceProfile()
 * @param {number} args.force_kN         static push force available at the head
 * @param {number} [args.massPerM_kg]    element mass per metre (self-weight helps; 0 to ignore)
 * @param {{targetDepth_m?:number, reserveMultiplier?:number}} [args.options]
 */
export function runPushIn({ profile, force_kN, massPerM_kg = 0, options = {} }) {
  const notes = [];
  const fail = (msg) => ({ ok: false, notes: [msg], perDepth: [] });
  if (!profile || !profile.ok || !profile.z?.length) return fail('Profile missing or not ok.');
  const F = Number(force_kN);
  if (!(F >= 0)) return fail('Push force must be a number ≥ 0 kN.');
  const mR = options.reserveMultiplier > 0 ? options.reserveMultiplier : 1.0;
  const jTarget = Number.isFinite(options.targetDepth_m) ? indexAtDepth(profile, options.targetDepth_m) : profile.z.length - 1;
  const wPerM = (Number(massPerM_kg) > 0 ? Number(massPerM_kg) : 0) * G_M_S2 / 1000;   // kN/m of embedded length

  const perDepth = [];
  let refusal = null, refusal125 = null, achievable = 0, achievable125 = 0, required = 0, required125 = 0;
  for (let j = 0; j <= jTarget; j++) {
    const z = profile.z[j];
    const W = wPerM * z;
    const Rs = profile.cumulativeShaft_kN[j], Rb = profile.toe_kN[j], Rint = profile.interlock_kN[j];
    const R = profile.Rstatic_kN[j];
    const Freq = Math.max(0, mR * R - W), Freq125 = Math.max(0, 1.25 * R - W);
    const G = F + W - mR * R, G125 = F + W - 1.25 * R;
    perDepth.push({ z, Rs_kN: Rs, Rb_kN: Rb, Rinterlock_kN: Rint, Rstatic_kN: R, W_kN: W, Frequired_kN: Freq, Frequired125_kN: Freq125, G_kN: G, G125_kN: G125 });
    required = Math.max(required, Freq); required125 = Math.max(required125, Freq125);
    if (refusal === null) { if (G >= 0) achievable = z; else refusal = z; }
    if (refusal125 === null) { if (G125 >= 0) achievable125 = z; else refusal125 = z; }
  }
  const target = profile.z[jTarget];
  const last = perDepth[perDepth.length - 1];
  const govIdx = perDepth.reduce((m, r, i) => (r.Frequired_kN > perDepth[m].Frequired_kN ? i : m), 0);
  notes.push(refusal === null
    ? `Push force ${F.toFixed(0)} kN: static balance open down to the target ${target.toFixed(2)} m (m_R = ${mR}${refusal125 === null ? ' and 1.25' : `; with m_R = 1.25 refusal predicted at ${refusal125.toFixed(2)} m`}).`
    : `Push force ${F.toFixed(0)} kN: refusal predicted at ${refusal.toFixed(2)} m (m_R = ${mR}) — possible down to ${achievable.toFixed(2)} m of the ${target.toFixed(2)} m target.`);
  notes.push('Quasi-static balance against the upper static resistance envelope (no rate effects, no set-up); pressing needs an adequate reaction — confirm with a trial element.');
  return {
    ok: true, force_kN: F, reserveMultiplier: mR, weightPerM_kN: wPerM,
    perDepth,
    targetDepth_m: target, achievableDepth_m: achievable, refusalDepth_m: refusal, reachesTarget: refusal === null,
    achievableDepth125_m: achievable125, refusalDepth125_m: refusal125, reachesTarget125: refusal125 === null,
    requiredForce_kN: required, requiredForce125_kN: required125, governingDepth_m: perDepth[govIdx].z,
    marginAtTarget_kN: last.G_kN, marginAtTarget125_kN: last.G125_kN,
    notes
  };
}
