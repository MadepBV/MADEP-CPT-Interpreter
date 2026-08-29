// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Section properties in SI units for the retaining-wall structural checks and the PLAXIS
 * parameter derivation.
 *
 *   H/I profiles (steel-h-sections.js): catalogue units mm / cm² / cm³ / cm⁴ / kg/m → m, m², m³, m⁴, kN/m.
 *   Sheet piles (sheet-pile-sections.js): catalogue PER METRE OF WALL, cm²/m, cm³/m, cm⁴/m, kg/m² → SI per m.
 *
 * Steel: E = 210 000 N/mm² (EN 1993-1-1 §3.2.6), γ_steel = 78.5 kN/m³ (EN 1991-1-1 Table A.4),
 * f_y per EN 10025-2 (t ≤ 40 mm: S235 235, S275 275, S355 355 N/mm²) and EN 10248 (sheet-pile
 * grades S240GP 240, S270GP 270, S320GP 320, S355GP 355, S390GP 390, S430GP 430, S460GP 460 N/mm²).
 */
import { findHSection } from './steel-h-sections.js';
import { findSheetPile } from './sheet-pile-sections.js';

export const E_STEEL_KPA = 210e6;      // kN/m²
export const GAMMA_STEEL = 78.5;       // kN/m³
export const RHO_STEEL = 7850;         // kg/m³

export const STEEL_GRADES = {
  S235: { fy: 235, standard: 'EN 10025-2' },
  S275: { fy: 275, standard: 'EN 10025-2' },
  S355: { fy: 355, standard: 'EN 10025-2' },
  S240GP: { fy: 240, standard: 'EN 10248-1' },
  S270GP: { fy: 270, standard: 'EN 10248-1' },
  S320GP: { fy: 320, standard: 'EN 10248-1' },
  S355GP: { fy: 355, standard: 'EN 10248-1' },
  S390GP: { fy: 390, standard: 'EN 10248-1' },
  S430GP: { fy: 430, standard: 'EN 10248-1' },
  S460GP: { fy: 460, standard: 'EN 10248-1' }
};

export function yieldStrength(grade) {
  const g = STEEL_GRADES[String(grade || '').toUpperCase()];
  return g ? g.fy : null;
}

/**
 * SI properties of one H/I profile.
 * @returns {null | {id, h, b, tw, tf, r, A, Iy, Wely, Wply, Iz, Avz, massPerM, weightPerM, perimeterFlanges, perimeterBox}}
 */
export function hSectionSI(id) {
  const s = findHSection(id);
  if (!s) return null;
  return {
    id: s.id, family: s.family,
    h: s.h / 1000, b: s.b / 1000, tw: s.tw / 1000, tf: s.tf / 1000, r: s.r / 1000,
    A: s.A * 1e-4, Iy: s.Iy * 1e-8, Wely: s.Wely * 1e-6, Wply: s.Wply * 1e-6, Iz: s.Iz * 1e-8, Avz: s.Avz * 1e-4,
    massPerM: s.mass, weightPerM: s.mass * 9.81 / 1000,   // kN/m
    perimeterFlanges: 2 * s.b / 1000,                    // both outer flange faces (steel–soil contact)
    perimeterPlug: 2 * s.h / 1000,                       // both open faces between the flanges (soil–soil plug)
    perimeterBox: 2 * (s.b + s.h) / 1000,                // enclosing rectangle
    boxArea: (s.b / 1000) * (s.h / 1000),
    source: s.source
  };
}

/**
 * SI properties of one sheet-pile section per metre of wall (optionally with a uniform
 * corrosion loss on the thickness-driven properties, applied as a plain reduction factor).
 */
export function sheetPileSI(id, { corrosionLoss = 0 } = {}) {
  const s = findSheetPile(id);
  if (!s) return null;
  const f = 1 - Math.min(Math.max(Number(corrosionLoss) || 0, 0), 0.9);
  const perMetre = s.shape !== 'flat';
  return {
    id: s.id, family: s.family, shape: s.shape, series: s.series || '',
    b: s.b / 1000, h: s.h / 1000, t: (s.t || 0) / 1000, s: (s.s || 0) / 1000,
    perMetre,
    A: perMetre ? s.A * 1e-4 * f : null,          // m²/m
    Iy: perMetre ? s.Iy * 1e-8 * f : null,        // m⁴/m
    Wel: perMetre ? s.Wel * 1e-6 * f : null,      // m³/m
    Wpl: perMetre ? (s.Wpl || 0) * 1e-6 * f : null,
    massPerM2: s.massPerM2 || null,               // kg/m² of wall
    massPerPile: s.massPerPile || null,           // kg/m per single pile
    weightPerM2: s.massPerM2 ? s.massPerM2 * 9.81 / 1000 : null,   // kN/m per metre of wall (PLAXIS w)
    classByGrade: s.classByGrade || null,
    interlockResistance_kN_m: s.interlockResistance_kN_m || null,
    corrosionFactor: f,
    // developed steel–soil contact per metre of wall (both faces), approximated from the developed
    // section length ≈ A / t — used only for drivability shaft integration; documented approximation
    developedPerimeterPerM: perMetre && s.t ? 2 * (s.A * 1e-4) / (s.t / 1000) : null,
    source: s.source
  };
}

/** EN 1993-1-1 Table 5.2 classification of an H/I section in pure bending about y-y. */
export function hSectionClass(sec, fy) {
  const eps = Math.sqrt(235 / fy);
  const cFlange = (sec.b - sec.tw - 2 * sec.r) / 2;
  const ctFlange = cFlange / sec.tf;
  const cWeb = sec.h - 2 * sec.tf - 2 * sec.r;
  const ctWeb = cWeb / sec.tw;
  const flangeClass = ctFlange <= 9 * eps ? 1 : ctFlange <= 10 * eps ? 2 : ctFlange <= 14 * eps ? 3 : 4;
  const webClass = ctWeb <= 72 * eps ? 1 : ctWeb <= 83 * eps ? 2 : ctWeb <= 124 * eps ? 3 : 4;
  return { flange: { ct: ctFlange, limit1: 9 * eps, limit2: 10 * eps, limit3: 14 * eps, cls: flangeClass }, web: { ct: ctWeb, limit1: 72 * eps, limit2: 83 * eps, limit3: 124 * eps, cls: webClass }, cls: Math.max(flangeClass, webClass), eps };
}
