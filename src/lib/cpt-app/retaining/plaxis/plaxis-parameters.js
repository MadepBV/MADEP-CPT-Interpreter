// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * PLAXIS 2D (v24) input parameters for embedded walls, derived from the section catalogue and the
 * hand calculation — everything the engineer copies into the calculation note.
 *
 *   Sheet pile → Plate over the full length, interfaces both sides (course manual §8.4, Bentley KB):
 *     EA₁ = E·A [kN/m], EI = E·I [kNm²/m], w = mass per wall area × g / 1000 [kN/m/m],
 *     M_p = f_y·W_pl [kNm/m], N_p = f_y·A [kN/m], d_eq = √(12·EI/EA), ν = 0 (no out-of-plane plate action
 *     for a corrugated section; document), EA₂ only from interlock tests (EA₁/20 is illustrative).
 *     R_inter = tan δ / tan φ′ per layer (Annex C δ of the hand calculation).
 *
 *   Soldier pile → hybrid (NUMGE2023-25; Rekennota §5):
 *     Plate above the design excavation:  EA = E·A_p/s, EI = E·I_p/s (lagging stiffness omitted),
 *       w = γ_s·(A_p/s + t_lagging), d_eq = √(12·I/A) (independent of s), ν = 0.
 *     Embedded Beam Row below the design excavation (user-defined cross-section):
 *       L_spacing = s, A, I, E of ONE pile, γ_eff = γ_s − γ_soil (the EBR occupies no volume),
 *       D_eq = √(12·I/A), default interface stiffness factors ISF_RS = ISF_RN = 2.5·(L_spacing/D_eq)^−0.75,
 *       ISF_KF = 25·(L_spacing/D_eq)^−0.75 (PLAXIS 2D reference manual defaults),
 *       T_skin linear (β-method, Rekennota §5.5):  T_skin(z′) = σ′_v(z′)·K·[O_steel·tan δ + O_plug·tan φ′_k],
 *       F_max = α_b·q_c·A_b (plugged box area; unplugged alternative = q_c·A_steel),
 *       T_lat multilinear: from the engine (Brinch Hansen, brinch_hansen.hpp) — per pile, B = flange width.
 */
import { E_STEEL_KPA, GAMMA_STEEL } from '../sections/section-properties.js';

const g = 9.81;
const deg = (d) => d * Math.PI / 180;

/** Plate set for a continuous sheet pile (per metre of wall). sp = sheetPileSI(...), fy N/mm². */
export function plateFromSheetPile(sp, { fy = 355, E = E_STEEL_KPA, nu = 0 } = {}) {
  if (!sp || !sp.perMetre) return null;
  const EA1 = E * sp.A;
  const EI = E * sp.Iy;
  const w = sp.weightPerM2 != null ? sp.weightPerM2 : GAMMA_STEEL * sp.A;
  const Mp = fy * 1000 * (sp.Wpl || 0);
  const Np = fy * 1000 * sp.A;
  const dEq = Math.sqrt(12 * EI / EA1);
  return {
    kind: 'plate', material: 'Elastic (or elastoplastic with M_p/N_p as numerical caps)',
    EA1, EA2: null, EI, w, Mp, Np, nu, dEq,
    rows: [
      ['Element type', 'Plate, elastic', ''],
      ['EA₁', EA1, 'kN/m'],
      ['EA₂', '—', 'manufacturer/interlock data only (EA₁/20 is illustrative)'],
      ['EI', EI, 'kNm²/m'],
      ['w', w, 'kN/m/m'],
      ['ν', nu, '—'],
      ['d_eq (computed by PLAXIS)', dEq, 'm'],
      ['M_p (if elastoplastic)', Mp, 'kNm/m'],
      ['N_p (if elastoplastic)', Np, 'kN/m'],
      ['Prevent punching', 'No', 'Bentley KB: not for sheet piles'],
      ['Interfaces', 'both sides', 'R_inter per layer, see table']
    ],
    notes: [
      'All values per metre of wall (catalogue per-metre properties).',
      'M_p and N_p are numerical yield caps, not an EN 1993-5 verification (done separately).',
      'ν = 0: a corrugated sheet pile has no out-of-plane plate action; use the documented material value if the model requests otherwise.'
    ]
  };
}

/** R_inter = tan δ / tan φ′ per layer (δ as used in the hand calculation). */
export function interfaceFactors(layers, deltaRatio) {
  return (layers || []).map((L) => {
    const phi = Number(L.phiK ?? L.phi);
    const delta = deltaRatio * phi;
    const r = phi > 0 ? Math.tan(deg(delta)) / Math.tan(deg(phi)) : 1;
    return { label: L.label || L.type || '', phi, delta, Rinter: Math.min(Math.max(r, 0.01), 1.0) };
  });
}

/** Plate above the excavation for a soldier-pile wall (per metre of wall). sec = hSectionSI(...). */
export function plateFromSoldierPile(sec, { spacing, laggingThickness = 0, E = E_STEEL_KPA, gammaSteel = GAMMA_STEEL, nu = 0 } = {}) {
  const s = Math.max(spacing, 0.05);
  const EA = E * sec.A / s;
  const EI = E * sec.Iy / s;
  const dEq = Math.sqrt(12 * sec.Iy / sec.A);
  const wProfile = gammaSteel * sec.A / s;
  const wLagging = gammaSteel * laggingThickness;
  const laggingEI = E * Math.pow(laggingThickness, 3) / 12;
  return {
    kind: 'plate', EA, EI, dEq, w: wProfile + wLagging, wProfile, wLagging, nu, laggingEI,
    NplPerM: 235e3 * sec.A / s,   // informational, S235; the STR check uses the selected grade
    rows: [
      ['Element type', 'Plate, elastic', ''],
      ['EA₁ = EA₂', EA, 'kN/m'],
      ['EI', EI, 'kNm²/m'],
      ['d_eq (computed by PLAXIS)', dEq, 'm'],
      ['w', wProfile + wLagging, 'kN/m/m'],
      ['ν', nu, '—'],
      ['Interfaces', 'both sides', 'R_inter per layer'],
      ['Rayleigh damping', 0, '% (static)']
    ],
    notes: [
      `Profile properties divided by the spacing s = ${s.toFixed(2)} m; lagging stiffness omitted (EI of the plate ${laggingEI.toFixed(1)} kNm²/m ≪ profile, and no composite action).`,
      'The lagging self-weight IS included in w (stiffness and weight are independent).',
      'ν = 0 for a wall of discrete elements (PLAXIS reference manual).'
    ]
  };
}

/** Embedded beam row below the excavation (one pile, user-defined cross-section). */
export function ebrFromSoldierPile(sec, { spacing, gammaSoil, E = E_STEEL_KPA, gammaSteel = GAMMA_STEEL } = {}) {
  const s = Math.max(spacing, 0.05);
  const gammaEff = gammaSteel - gammaSoil;
  const Deq = Math.sqrt(12 * sec.Iy / sec.A);
  const ratio = s / Deq;
  const ISF_RS = 2.5 * Math.pow(ratio, -0.75);
  const ISF_RN = ISF_RS;
  const ISF_KF = 25 * Math.pow(ratio, -0.75);
  return {
    kind: 'embedded-beam-row', Lspacing: s, A: sec.A, I: sec.Iy, E, gammaEff, Deq, ratio, ISF_RS, ISF_RN, ISF_KF,
    EIperM: E * sec.Iy / s, EAperM: E * sec.A / s,
    rows: [
      ['L_spacing', s, 'm'],
      ['Cross section type', 'User-defined', ''],
      ['A', sec.A, 'm²'],
      ['I', sec.Iy, 'm⁴'],
      ['E', E, 'kN/m²'],
      ['γ (net, γ_steel − γ_soil)', gammaEff, 'kN/m³'],
      ['D_eq = √(12·I/A) (computed by PLAXIS)', Deq, 'm'],
      ['ISF_RS = ISF_RN (default)', ISF_RS, '—'],
      ['ISF_KF (default)', ISF_KF, '—']
    ],
    notes: [
      'Actual properties of ONE pile — never divided by the spacing (PLAXIS smears the row itself).',
      'Net unit weight because the embedded beam row does not remove soil volume.',
      'The ISF values must coincide with the PLAXIS defaults; a mismatch means A, I or L_spacing were mistyped.',
      `Continuity check at the transition: EI per metre = ${(E * sec.Iy / s).toFixed(0)} kNm²/m for both the plate and the row.`
    ]
  };
}

/**
 * Linear axial skin resistance (β-method) of one soldier pile below the design excavation.
 * K: 'k0' (1 − sin φ′_k) or a number; δ = deltaRatio·φ′_k on the flange faces; soil–soil shear on the
 * plug faces at φ′_k when includePlug. σ′_v from γ′·z′ (uniform γ below the excavation — a simplification
 * when layered; the engine's stress profile is used when provided via sigmaVAt).
 */
export function tskinLinear(sec, { phiK, K = 'k0', deltaRatio = 2 / 3, includePlug = true, gamma, embedment, sigmaVAt = null, numericalFloor = 1.0 }) {
  const Kv = K === 'k0' ? 1 - Math.sin(deg(phiK)) : Number(K);
  const term = sec.perimeterFlanges * Math.tan(deg(deltaRatio * phiK)) + (includePlug ? sec.perimeterPlug * Math.tan(deg(phiK)) : 0);
  const coefficient = Kv * term;                        // T_skin = coefficient · σ′_v
  const slope = coefficient * gamma;                    // kN/m per metre of depth (uniform γ)
  const sigmaEnd = sigmaVAt ? sigmaVAt(embedment) : gamma * embedment;
  const Tend = coefficient * sigmaEnd;
  const Rs = sigmaVAt ? null : slope * embedment * embedment / 2;
  return {
    K: Kv, delta: deltaRatio * phiK, phiK, perimeterSteel: sec.perimeterFlanges, perimeterPlug: includePlug ? sec.perimeterPlug : 0,
    term, coefficient, slope, Tstart: numericalFloor, Tend, Rs,
    rows: [
      ['K', Kv, K === 'k0' ? 'K₀ = 1 − sin φ′_k (no installation increase)' : 'user value'],
      ['δ', deltaRatio * phiK, '° steel–soil'],
      ['O_steel', sec.perimeterFlanges, 'm (both flange faces)'],
      ['O_plug', includePlug ? sec.perimeterPlug : 0, 'm (soil–soil between the flanges)'],
      ['T_skin / σ′_v', coefficient, 'm'],
      ['T_skin,start,max', numericalFloor, 'kN/m (numerical floor at z′ = 0)'],
      ['T_skin,end,max', Tend, `kN/m at z′ = ${embedment.toFixed(3)} m`]
    ],
    notes: ['β-method with K = K₀ as the lower bound of the allowed installation methods (pre-augering with backfill); a lower T_skin is conservative for the φ-c reduction and the vertical check.', 'Linear profile with the unit weight and φ′ of the stratum at the toe (uniform below the excavation) — for a strongly layered embedment enter a multilinear T_skin from the per-layer values.']
  };
}

/** Base resistance F_max of one soldier pile from the cone resistance near the toe. */
export function fmaxFromCpt(sec, { qcToe_kPa, alphaB = 0.5, plugged = true }) {
  const Ab = plugged ? sec.boxArea : sec.A;
  const qb = alphaB * qcToe_kPa;
  const Fmax = qb * Ab;
  const FmaxUnplugged = qcToe_kPa * sec.A;
  return {
    Ab, qb, Fmax, FmaxUnplugged, alphaB, plugged,
    rows: [
      ['A_b', Ab, plugged ? 'm² (b·h, plug assumed)' : 'm² (steel only)'],
      ['q_b = α_b·q_c', qb, `kPa (α_b = ${alphaB})`],
      ['F_max', Fmax, 'kN'],
      ['F_max unplugged (q_c·A_steel)', FmaxUnplugged, 'kN']
    ],
    notes: ['The least substantiated parameter of the set; a toe force approaching F_max in the results requires a separate pile calculation (NBN EN 1997-1 ANB).']
  };
}

/**
 * Multilinear T_lat rows for the PLAXIS table from the engine's Brinch Hansen table.
 * convention: 'AL' (Andersen–Lodahl, default) | 'equal' (equal-level, Rekennota Table 5-7)
 */
export function tlatRowsForPlaxis(tlatTable, { convention = 'AL', useRowCap = true } = {}) {
  if (!tlatTable) return [];
  return tlatTable.rows.map((r) => {
    const raw = convention === 'equal' ? r.tlatEqual : r.tlatAL;
    const v = useRowCap ? Math.min(raw, r.rowCap) : raw;
    return { distance: r.z, tlat: Math.max(v, 0), raw, rowCap: r.rowCap, Kq: r.Kq, Kc: r.Kc, sigmaVf: r.sigmaVf, dq: r.dq };
  });
}
