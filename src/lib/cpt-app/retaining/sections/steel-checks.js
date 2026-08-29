// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Structural (STR) verifications of the wall elements, Eurocode 3.
 *
 *   H/I soldier piles — NBN EN 1993-1-1 (+ ANB: γ_M0 = 1.00):
 *     class 1/2:  M_c,Rd = W_pl·f_y/γ_M0;  class 3: W_el;  V_pl,Rd = A_v·(f_y/√3)/γ_M0 (§6.2.6);
 *     M–V interaction: no reduction when V_Ed ≤ 0.5·V_pl,Rd (§6.2.8), otherwise ρ = (2V_Ed/V_pl,Rd − 1)²
 *     on the web contribution — reported as a warning with the reduced resistance for a rolled I-section
 *     M_y,V,Rd = (W_pl − ρ·A_w²/(4 t_w))·f_y/γ_M0 (§6.2.8(5)).
 *   Sheet piles — NBN EN 1993-5:2007 (+ ANB): M_c,Rd = β_B·W_pl·f_y/γ_M0 for class 1–2, W_el for class 3
 *     (§5.2.2). β_B accounts for interlock transmission in U-piles (National Annex; 1.0 for Z-piles).
 *     Shear: A_v = Σ webs per metre × t_w·(h − t_f) (§5.2.2(4); web inclination neglected — conservative).
 *   Lagging (steel plate spanning horizontally between the flanges, Rekennota §7.8):
 *     M_Ed = p_Ed·L²/8 with L = spacing (conservative) or clear span s − b; W_el = t²/6, W_pl = t²/4 per metre;
 *     deflection δ = 5·p_k·L⁴/(384·EI), EI = E·t³/12.
 *   Vertical equilibrium of a soldier pile (Rekennota §7.10): G = pile + lagging self-weight vs
 *     R_s = ∫T_skin dz over the embedment (β-method, see plaxis-parameters.js); base resistance not credited.
 */
import { E_STEEL_KPA, GAMMA_STEEL, hSectionClass } from './section-properties.js';

const SQRT3 = Math.sqrt(3);

/** Resistance of an H/I soldier pile (per pile). fy in N/mm², results kNm / kN. */
export function hPileResistance(sec, { fy = 235, gammaM0 = 1.0 } = {}) {
  const cls = hSectionClass(sec, fy);
  const fyk = fy * 1000;   // kPa
  const MplRd = sec.Wply * fyk / gammaM0;
  const MelRd = sec.Wely * fyk / gammaM0;
  const McRd = cls.cls <= 2 ? MplRd : MelRd;
  const VplRd = sec.Avz * (fyk / SQRT3) / gammaM0;
  const NplRd = sec.A * fyk / gammaM0;
  return { cls, MplRd, MelRd, McRd, VplRd, NplRd, fy, gammaM0, plasticAllowed: cls.cls <= 2 };
}

/** Verification of an H/I soldier pile for M_Ed (kNm), V_Ed (kN) per pile. */
export function checkHPile(sec, { MEd, VEd, fy = 235, gammaM0 = 1.0 }) {
  const R = hPileResistance(sec, { fy, gammaM0 });
  const rows = [];
  rows.push({ id: 'bending', label: R.plasticAllowed ? 'Bending, plastic (class ' + R.cls.cls + ')' : 'Bending, elastic (class ' + R.cls.cls + ')', Ed: MEd, Rd: R.McRd, unit: 'kNm', util: MEd / R.McRd, pass: MEd <= R.McRd, ref: 'EN 1993-1-1 §6.2.5' });
  rows.push({ id: 'bending_el', label: 'Bending, elastic (control)', Ed: MEd, Rd: R.MelRd, unit: 'kNm', util: MEd / R.MelRd, pass: MEd <= R.MelRd, ref: 'EN 1993-1-1 §6.2.5', info: true });
  rows.push({ id: 'shear', label: 'Shear', Ed: VEd, Rd: R.VplRd, unit: 'kN', util: VEd / R.VplRd, pass: VEd <= R.VplRd, ref: 'EN 1993-1-1 §6.2.6' });
  const halfV = 0.5 * R.VplRd;
  let interaction = { id: 'mv', label: 'M–V interaction', Ed: VEd, Rd: halfV, unit: 'kN', util: VEd / halfV, pass: true, ref: 'EN 1993-1-1 §6.2.8', note: VEd <= halfV ? 'V_Ed ≤ 0.5·V_pl,Rd — no reduction of the moment resistance required.' : '' };
  if (VEd > halfV) {
    const rho = Math.pow(2 * VEd / R.VplRd - 1, 2);
    const Aw = (sec.h - 2 * sec.tf) * sec.tw;
    const MyVRd = Math.max((sec.Wply - rho * Aw * Aw / (4 * sec.tw)) * fy * 1000 / gammaM0, 0);
    interaction = { ...interaction, note: `V_Ed > 0.5·V_pl,Rd: ρ = ${rho.toFixed(3)}, reduced M_y,V,Rd = ${MyVRd.toFixed(1)} kNm`, MyVRd, pass: MEd <= MyVRd, util: MEd / MyVRd };
  }
  rows.push(interaction);
  return { resistance: R, rows, pass: rows.filter((r) => !r.info).every((r) => r.pass) };
}

/** Resistance of a sheet pile per metre of wall (M in kNm/m, V in kN/m, N in kN/m). */
export function sheetPileResistance(sp, { fy = 355, gammaM0 = 1.0, useWpl = false, betaB = 1.0, sectionClass = null } = {}) {
  if (!sp || !sp.perMetre) return null;
  const fyk = fy * 1000;
  const cls = sectionClass || (sp.classByGrade ? sp.classByGrade[Object.keys(sp.classByGrade).find((g) => Number(g.replace(/\D/g, '')) === fy)] : null) || null;
  const plasticAllowed = useWpl && (cls == null || cls <= 2) && sp.Wpl > 0;
  const MplRd = betaB * (sp.Wpl || 0) * fyk / gammaM0;
  const MelRd = sp.Wel * fyk / gammaM0;
  const McRd = plasticAllowed ? MplRd : MelRd;
  // webs per metre of wall = 1 / b (single-pile system width); A_v = n·t_w·(h − t_f), inclination neglected
  const websPerM = sp.b > 0 ? 1 / sp.b : 0;
  const Av = websPerM * sp.s * Math.max(sp.h - sp.t, 0);   // m²/m
  const VplRd = Av * (fyk / SQRT3) / gammaM0;
  const NplRd = sp.A * fyk / gammaM0;
  return { cls, plasticAllowed, MplRd, MelRd, McRd, Av, VplRd, NplRd, fy, gammaM0, betaB, websPerM };
}

export function checkSheetPile(sp, { MEd, VEd, fy = 355, gammaM0 = 1.0, useWpl = false, betaB = 1.0, sectionClass = null }) {
  const R = sheetPileResistance(sp, { fy, gammaM0, useWpl, betaB, sectionClass });
  if (!R) return null;
  const rows = [];
  rows.push({ id: 'bending', label: R.plasticAllowed ? `Bending, plastic (class ${R.cls ?? '≤2'}, β_B = ${betaB})` : `Bending, elastic${R.cls ? ` (class ${R.cls})` : ''}`, Ed: MEd, Rd: R.McRd, unit: 'kNm/m', util: MEd / R.McRd, pass: MEd <= R.McRd, ref: 'EN 1993-5 §5.2.2' });
  rows.push({ id: 'shear', label: 'Shear (webs, inclination neglected)', Ed: VEd, Rd: R.VplRd, unit: 'kN/m', util: VEd / R.VplRd, pass: VEd <= R.VplRd, ref: 'EN 1993-5 §5.2.2(4)' });
  rows.push({ id: 'mv', label: 'M–V interaction', Ed: VEd, Rd: 0.5 * R.VplRd, unit: 'kN/m', util: VEd / (0.5 * R.VplRd), pass: VEd <= 0.5 * R.VplRd, ref: 'EN 1993-5 §5.2.2(9)', note: VEd <= 0.5 * R.VplRd ? 'V_Ed ≤ 0.5·V_pl,Rd — no reduction of the moment resistance required.' : 'V_Ed > 0.5·V_pl,Rd — reduce the moment resistance per EN 1993-5 §5.2.2(9).' });
  return { resistance: R, rows, pass: rows.every((r) => r.pass) };
}

/**
 * Lagging plate check (steel plate between soldier piles).
 * @param {object} a  { pEd kPa (design), pK kPa (characteristic, for deflection), spacing m, flangeWidth m,
 *                      thickness m, fy N/mm², gammaM0, spanMode 'centre'|'clear', method 'elastic'|'plastic' }
 */
export function checkLaggingPlate({ pEd, pK = null, spacing, flangeWidth = 0, thickness, fy = 235, gammaM0 = 1.0, spanMode = 'centre', method = 'elastic' }) {
  const L = spanMode === 'clear' ? Math.max(spacing - flangeWidth, 0.05) : spacing;
  const t = thickness;
  const MEd = pEd * L * L / 8;                 // kNm/m
  const Wel = t * t / 6, Wpl = t * t / 4;      // m³/m
  const fyk = fy * 1000;
  const MelRd = Wel * fyk / gammaM0, MplRd = Wpl * fyk / gammaM0;
  const MRd = method === 'plastic' ? MplRd : MelRd;
  const sigma = MEd / Wel / 1000;              // N/mm²
  const EI = E_STEEL_KPA * t * t * t / 12;     // kNm²/m
  const defl = pK != null ? 5 * pK * Math.pow(L, 4) / (384 * EI) : null;   // m
  return { L, spanMode, MEd, Wel, Wpl, MelRd, MplRd, MRd, sigma, util: MEd / MRd, utilElastic: MEd / MelRd, utilPlastic: MEd / MplRd, pass: MEd <= MRd, EI, deflection: defl, ref: 'EN 1993-1-1 §6.2.5; Rekennota §7.8' };
}

/**
 * Vertical equilibrium of one soldier pile (self-weight only; anchors add T·tan α if present).
 * @param {object} a { section (SI), length m, laggingThickness m, laggingHeight m (retained height),
 *                     spacing m, tskinSlope kN/m per m of depth, embedment m, extraVertical kN }
 */
export function checkVerticalEquilibrium({ section, length, laggingThickness = 0, laggingHeight = 0, spacing = 1, tskinSlope, embedment, extraVertical = 0 }) {
  const Gpile = section.weightPerM * length;
  const Glagging = GAMMA_STEEL * laggingThickness * laggingHeight * spacing;
  const G = Gpile + Glagging + Math.max(extraVertical, 0);
  const Rs = tskinSlope * embedment * embedment / 2;
  return { Gpile, Glagging, G, Rs, util: Rs > 0 ? G / Rs : Infinity, pass: G <= Rs, ref: 'EN 1997-1 §9.7.5; Rekennota §7.10' };
}
