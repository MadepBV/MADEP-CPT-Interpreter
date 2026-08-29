// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck — plain ES module with JSDoc contracts and runtime input guards (repo pattern, see PLAN §5)
/**
 * Hammer catalog — pure data. Every row carries the URL that was actually fetched on the
 * stated date; rows whose datasheet could not be retrieved are omitted. Fields that a
 * source did not state are `null` (the UI must ask the user), never guessed.
 *
 * Vibratory rows
 *   eccentricMomentMax_kgm  static moment of the eccentrics (variable-moment machines: 0 … max)
 *   frequencyMax_Hz         rated maximum rpm / 60
 *   centrifugalForceMax_kN  manufacturer value (≈ M_e·(2πf)²/1000 — see `consistency` notes)
 *   dynamicMass_kg          vibrating mass (exciter + clamp) — the M_dyn contribution excluding the pile
 * Impact rows
 *   ramMass_kg, ratedEnergy_kJ (max), minEnergy_kJ, strokeMax_m, blowRate_per_min, totalMass_kg
 *   efficiencyDefault       GRLWEAP class efficiency (see impact-wave-equation.js header)
 *
 * The UI always offers a 'custom' entry; this file only exports verified rows and findHammer(id).
 */

export const VERIFIED_ON = '2026-08-29';

export const vibratoryHammers = [
  {
    id: 'ice-28rf', make: 'ICE (Dieseko Group)', model: 'ICE 28RF', mounting: 'crane', variableMoment: true,
    eccentricMomentMin_kgm: 0, eccentricMomentMax_kgm: 28, frequencyMax_Hz: 2300 / 60, centrifugalForceMax_kN: 1600,
    dynamicMass_kg: 3900, dynamicMassWithClamp_kg: 5400, clampModel: '200TU', totalMass_kg: 5900,
    amplitudeMax_mm: 14, amplitudeMaxWithClamp_mm: 10.4, linePullMax_kN: 400, pullDownMax_kN: 150,
    source: 'https://www.twf.at/images/ramm-bohrtechnik/maschinen/vibrationstechnik/download/ice-28-rf-set.pdf',
    sourceAlt: 'https://www.diesekogroup.com/products/vibratory-hammers/ice-28rf/',
    sourceNote: 'Dieseko specification sheet (print date 4-8-2022) mirrored by TWF; Dieseko product page confirms 0–28 kgm, 0–1600 kN, 2300 rpm.',
    verifiedOn: VERIFIED_ON
  },
  {
    id: 'ice-14rf', make: 'ICE (Dieseko Group)', model: 'ICE 14RF', mounting: 'crane', variableMoment: true,
    eccentricMomentMin_kgm: 0, eccentricMomentMax_kgm: 14, frequencyMax_Hz: 2300 / 60, centrifugalForceMax_kN: 810,
    dynamicMass_kg: null, totalMass_kg: null, amplitudeMax_mm: null, linePullMax_kN: null,
    source: 'https://www.diesekogroup.com/products/vibratory-hammers/ice-14rf/',
    sourceNote: 'Product page only (0–14 kgm, 0–810 kN, 2300 rpm); dynamic weight not published there — enter from the datasheet.',
    verifiedOn: VERIFIED_ON
  },
  {
    id: 'ice-815c', make: 'ICE (Dieseko Group)', model: 'ICE 815C', mounting: 'crane', variableMoment: false,
    eccentricMomentMin_kgm: 46, eccentricMomentMax_kgm: 46, frequencyMax_Hz: 1570 / 60, centrifugalForceMax_kN: 1250,
    dynamicMass_kg: null, totalMass_kg: null, amplitudeMax_mm: null, linePullMax_kN: null,
    source: 'https://www.diesekogroup.com/products/vibratory-hammers/ice-815c/',
    sourceNote: 'Product page only (46 kgm, 1250 kN, 1570 rpm; normal-frequency machine); dynamic weight not published there.',
    verifiedOn: VERIFIED_ON
  },
  {
    id: 'pve-23vma', make: 'PVE (Dieseko Group)', model: 'PVE 23VMA', mounting: 'excavator', variableMoment: true,
    eccentricMomentMin_kgm: 0, eccentricMomentMax_kgm: 23, frequencyMax_Hz: 2300 / 60, centrifugalForceMax_kN: 1350,
    dynamicMass_kg: null, totalMass_kg: null, amplitudeMax_mm: null, linePullMax_kN: null,
    source: 'https://diesekogroup.com/products/vibratory-hammers/pve-23vma/',
    sourceNote: 'Product page only (0–23 kgm, 0–1350 kN, 2300 rpm); dynamic weight not published there.',
    verifiedOn: VERIFIED_ON
  },
  {
    id: 'abi-mrzv-20vv', make: 'ABI', model: 'MRZV 20VV', mounting: 'leader', variableMoment: true,
    eccentricMomentMin_kgm: 0, eccentricMomentMax_kgm: 20, frequencyNominal_Hz: 2135 / 60, frequencyMax_Hz: 2600 / 60,
    centrifugalForceNominal_kN: 1000, centrifugalForceMax_kN: 1200, dynamicMass_kg: 2810, totalMass_kg: 4220,
    extractionForceMax_kN: 200, carrierPower_kW: [300, 470],
    source: 'https://aeyates.co.uk/wp-content/uploads/2020/06/Vibrators-MRZV-VV.pdf',
    sourceNote: 'ABI "Technical Data MRZV VV" sheet (SPI Piling / A E Yates). The sheet prints "100 kN" at nominal frequency, an evident misprint: 20 kgm at 2135 rpm gives 1000 kN.',
    verifiedOn: VERIFIED_ON
  },
  {
    id: 'abi-mrzv-30vv', make: 'ABI', model: 'MRZV 30VV', mounting: 'leader', variableMoment: true,
    eccentricMomentMin_kgm: 0, eccentricMomentMax_kgm: 30, frequencyNominal_Hz: 2140 / 60, frequencyMax_Hz: 2600 / 60,
    centrifugalForceNominal_kN: 1500, centrifugalForceMax_kN: 1500, dynamicMass_kg: 3995, totalMass_kg: 5270,
    extractionForceMax_kN: 200, carrierPower_kW: [433, 570],
    source: 'https://aeyates.co.uk/wp-content/uploads/2020/06/Vibrators-MRZV-VV.pdf',
    sourceNote: 'ABI "Technical Data MRZV VV" sheet (SPI Piling / A E Yates).',
    verifiedOn: VERIFIED_ON
  }
];

export const impactHammers = [
  { id: 'junttan-hhk-5a', make: 'Junttan', model: 'HHK 5A (800)', type: 'hydraulic', ramMass_kg: 5000, ratedEnergy_kJ: 59, strokeMax_m: 1.2, blowRate_per_min: [40, 100], totalMass_kg: 8400, efficiencyDefault: 0.80,
    source: 'https://www.junttan.com/wp-content/uploads/2015/10/Junttan_HHK_5A-800_datasheet.pdf', sourceNote: 'Junttan data sheet 05/2011; total weight includes A-type drive cap.', verifiedOn: VERIFIED_ON },
  { id: 'junttan-hhk-5-6a', make: 'Junttan', model: 'HHK 5/6A (800)', type: 'hydraulic', ramMass_kg: 6000, ratedEnergy_kJ: 71, strokeMax_m: 1.2, blowRate_per_min: [40, 100], totalMass_kg: 9600, efficiencyDefault: 0.80,
    source: 'https://www.junttan.com/wp-content/uploads/2015/10/Junttan_HHK_5A-800_datasheet.pdf', sourceNote: 'Junttan data sheet 05/2011 ("technical details with extensions", 6 t ram).', verifiedOn: VERIFIED_ON },
  { id: 'junttan-hhk-7a', make: 'Junttan', model: 'HHK 7A', type: 'hydraulic', ramMass_kg: 7000, ratedEnergy_kJ: 82, strokeMax_m: 1.2, blowRate_per_min: [40, 100], totalMass_kg: 11000, efficiencyDefault: 0.80,
    source: 'https://junttan.com/wp-content/uploads/2015/10/Junttan_HHK_7A_datasheet.pdf', sourceNote: 'Junttan data sheet 05/2011; total weight includes A-type drive cap.', verifiedOn: VERIFIED_ON },
  { id: 'junttan-hhk-7-9a', make: 'Junttan', model: 'HHK 7/9A', type: 'hydraulic', ramMass_kg: 9000, ratedEnergy_kJ: 106, strokeMax_m: 1.2, blowRate_per_min: [40, 100], totalMass_kg: 13500, efficiencyDefault: 0.80,
    source: 'https://junttan.com/wp-content/uploads/2015/10/Junttan_HHK_7A_datasheet.pdf', sourceNote: 'Junttan data sheet 05/2011 ("technical details with extensions", 9 t ram).', verifiedOn: VERIFIED_ON },
  { id: 'ihc-s-70', make: 'IHC Hydrohammer', model: 'S-70', type: 'hydraulic', ramMass_kg: 3500, ratedEnergy_kJ: 70, strokeMax_m: null, blowRate_per_min: [50, 50], totalMass_kg: 8300, efficiencyDefault: 0.80,
    source: 'https://greenglobalgroup3g.com/images/sampledata/parks/landscape/IHCHydrohammerOnshore.pdf', sourceNote: 'IHC Hydrohammer onshore brochure IHC02-30-11.12 (mirror); "max. net energy" = energy in the pile. PDI hammer database lists 89.4/69.5 kJ rated for S-90/S-70 with 2.02 m stroke.', verifiedOn: VERIFIED_ON },
  { id: 'ihc-s-90', make: 'IHC Hydrohammer', model: 'S-90', type: 'hydraulic', ramMass_kg: 4500, ratedEnergy_kJ: 90, strokeMax_m: null, blowRate_per_min: [46, 46], totalMass_kg: 9700, efficiencyDefault: 0.80,
    source: 'https://greenglobalgroup3g.com/images/sampledata/parks/landscape/IHCHydrohammerOnshore.pdf', sourceNote: 'IHC Hydrohammer onshore brochure IHC02-30-11.12 (mirror); cross-checked with https://www.pile.com/download/technical-specifications/hammer-database.pdf (S-90: 89.387 kJ, ram 44.233 kN).', verifiedOn: VERIFIED_ON },
  { id: 'ihc-s-120', make: 'IHC Hydrohammer', model: 'S-120', type: 'hydraulic', ramMass_kg: 6200, ratedEnergy_kJ: 120, strokeMax_m: null, blowRate_per_min: [48, 48], totalMass_kg: 14300, efficiencyDefault: 0.80,
    source: 'https://greenglobalgroup3g.com/images/sampledata/parks/landscape/IHCHydrohammerOnshore.pdf', sourceNote: 'IHC Hydrohammer onshore brochure IHC02-30-11.12 (mirror).', verifiedOn: VERIFIED_ON },
  { id: 'ihc-s-150', make: 'IHC Hydrohammer', model: 'S-150', type: 'hydraulic', ramMass_kg: 7500, ratedEnergy_kJ: 150, strokeMax_m: null, blowRate_per_min: [44, 44], totalMass_kg: 16200, efficiencyDefault: 0.80,
    source: 'https://greenglobalgroup3g.com/images/sampledata/parks/landscape/IHCHydrohammerOnshore.pdf', sourceNote: 'IHC Hydrohammer onshore brochure IHC02-30-11.12 (mirror).', verifiedOn: VERIFIED_ON },
  { id: 'ihc-s-200', make: 'IHC Hydrohammer', model: 'S-200', type: 'hydraulic', ramMass_kg: 10000, ratedEnergy_kJ: 200, strokeMax_m: null, blowRate_per_min: [45, 45], totalMass_kg: 25800, efficiencyDefault: 0.80,
    source: 'https://greenglobalgroup3g.com/images/sampledata/parks/landscape/IHCHydrohammerOnshore.pdf', sourceNote: 'IHC Hydrohammer onshore brochure IHC02-30-11.12 (mirror).', verifiedOn: VERIFIED_ON },
  { id: 'ihc-s-280', make: 'IHC Hydrohammer', model: 'S-280', type: 'hydraulic', ramMass_kg: 13600, ratedEnergy_kJ: 280, strokeMax_m: null, blowRate_per_min: [45, 45], totalMass_kg: 30500, efficiencyDefault: 0.80,
    source: 'https://greenglobalgroup3g.com/images/sampledata/parks/landscape/IHCHydrohammerOnshore.pdf', sourceNote: 'IHC Hydrohammer onshore brochure IHC02-30-11.12 (mirror).', verifiedOn: VERIFIED_ON },
  { id: 'delmag-d30-32', make: 'Delmag', model: 'D30-32', type: 'diesel', ramMass_kg: 3000, ratedEnergy_kJ: 95.1, minEnergy_kJ: 48.1, strokeMax_m: 3.2, blowRate_per_min: [36, 52], totalMass_kg: 7355, impactBlockMass_kg: 662, efficiencyDefault: 0.80,
    source: 'https://www.pileco.com/images/Hammers/brochures/HammerPDF_D30-32.pdf', sourceNote: 'Pileco specification sheet (pump settings 1–4: 48.1/70.2/85.5/95.1 kNm; hammer weight 16,215 lb). PDI database lists 100.9 kJ rated.', verifiedOn: VERIFIED_ON },
  { id: 'delmag-d46-32', make: 'Delmag', model: 'D46-32', type: 'diesel', ramMass_kg: 4600, ratedEnergy_kJ: 166, minEnergy_kJ: 71, strokeMax_m: null, blowRate_per_min: [35, 53], totalMass_kg: 9300, efficiencyDefault: 0.80,
    source: 'https://www.piledrivershop.com/media/3219/delmag-d46-32-specification-sheet.pdf', sourceNote: 'Delmag specification sheet (energy per blow 166–71 kNm). PDI database lists 154.8 kJ rated.', verifiedOn: VERIFIED_ON }
];

/** Find a catalog row by id in either list; returns null when unknown (UI falls back to 'custom'). */
export function findHammer(id) {
  return vibratoryHammers.find((h) => h.id === id) || impactHammers.find((h) => h.id === id) || null;
}

/** Catalogue consistency: F_c ≈ M_e·(2πf)²/1000 for every vibratory row with a stated force. */
export function vibratoryConsistency() {
  return vibratoryHammers.map((h) => {
    const f = h.frequencyNominal_Hz || h.frequencyMax_Hz;
    const omega = 2 * Math.PI * f;
    const F = h.eccentricMomentMax_kgm * omega * omega / 1000;
    const stated = h.centrifugalForceNominal_kN || h.centrifugalForceMax_kN;
    return { id: h.id, computed_kN: F, stated_kN: stated, ratio: F / stated };
  });
}
