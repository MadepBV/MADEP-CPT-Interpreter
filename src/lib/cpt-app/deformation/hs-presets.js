// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Hardening Soil material presets — Phase 8 deliverable.
//
// Four PLAXIS-style HS presets covering the canonical sand/clay quadrants.
// Each preset bundles:
//   - HS reference stiffnesses (E50_ref, Eoed_ref, Eur_ref) at p_ref = 100 kPa
//   - stress-dependency exponent m
//   - elastic Poisson ν_ur for the unload/reload regime
//   - failure ratio Rf (Duncan-Chang asymptote tightening)
//   - over-consolidation ratio OCR
//   - effective shear strength (c', φ', ψ')
//   - reference pressure p_ref
//
// Reference: PLAXIS reference manual; the HS-canonical values per the
// "Hardening Soil Model" section. These act as starting points only; users
// edit individual fields after applying the preset (the UI shows a "custom"
// indicator once any field deviates).
//
// Spec: docs/features/hardening-soil-model.md §10 Phase 8.

/**
 * Build the full HS-block payload for a preset. Returns a plain object that
 * mirrors `material.hs` field shape used by the WASM wire format
 * (see encodeInputBuffer/writeHsParams in wire-format.js).
 *
 * The K0_nc field intentionally defaults to 0 so the solver computes it via
 * Jaky's formula (1 − sin φ'). Users can override via the Advanced panel.
 * e_init / e_max default to -1 (disabled) since dilatancy cutoff requires
 * a calibration ladder.
 */
function makeHsBlock({ E50_ref, Eoed_ref, Eur_ref, m, nu_ur, Rf, OCR }) {
  return {
    E50_ref,
    Eoed_ref,
    Eur_ref,
    m,
    nu_ur,
    p_ref: 100,
    Rf,
    K0_nc: 0,
    e_init: -1,
    e_max: -1,
    OCR,
    reserved: 0
  };
}

/**
 * Build the matched MC-style strength fields. The strength envelope (c', φ',
 * ψ') is shared between HS and the legacy MC model; HS adds the cone/cap
 * hardening on top. Linear-elastic moduli (Emc, ν) are kept for downstream
 * code paths that still consult them, but the HS dispatcher uses the
 * reference stiffnesses inside `hs`.
 */
function makeStrengthFields({ Emc, nu, cEff, phiEffDeg, psiEffDeg, gamma, gammaSat }) {
  return {
    Emc,
    nu,
    cEff,
    phiEffDeg,
    psiEffDeg,
    gamma,
    gammaSat,
    K0nc: 0,
    rShear: 0.25,
    sigmaTAllow: 0,
    useTensionCutoff: false
  };
}

function buildPresets() {
  const raw = {
    loose_sand: {
      id: 'loose_sand',
      label: 'Loose sand',
      description: 'Granular, low relative density. NC, ψ = 0.',
      fields: {
        ...makeStrengthFields({
          Emc: 15000, nu: 0.3, cEff: 0,
          phiEffDeg: 30, psiEffDeg: 0,
          gamma: 17, gammaSat: 19
        }),
        hs: makeHsBlock({
          E50_ref: 15000,
          Eoed_ref: 15000,
          Eur_ref: 60000,
          m: 0.5,
          nu_ur: 0.2,
          Rf: 0.9,
          OCR: 1.0
        })
      }
    },
    dense_sand: {
      id: 'dense_sand',
      label: 'Dense sand',
      description: 'Granular, high relative density. NC, ψ ≈ φ − 30°.',
      fields: {
        ...makeStrengthFields({
          Emc: 50000, nu: 0.3, cEff: 0,
          phiEffDeg: 40, psiEffDeg: 10,
          gamma: 19, gammaSat: 21
        }),
        hs: makeHsBlock({
          E50_ref: 50000,
          Eoed_ref: 50000,
          Eur_ref: 150000,
          m: 0.5,
          nu_ur: 0.2,
          Rf: 0.9,
          OCR: 1.0
        })
      }
    },
    soft_clay_nc: {
      id: 'soft_clay_nc',
      label: 'Soft clay (NC)',
      description: 'Normally-consolidated cohesive soil. m = 1 (clay).',
      fields: {
        ...makeStrengthFields({
          Emc: 3000, nu: 0.3, cEff: 5,
          phiEffDeg: 22, psiEffDeg: 0,
          gamma: 16, gammaSat: 18
        }),
        hs: makeHsBlock({
          E50_ref: 3000,
          Eoed_ref: 3000,
          Eur_ref: 30000,
          m: 1.0,
          nu_ur: 0.2,
          Rf: 0.9,
          OCR: 1.0
        })
      }
    },
    stiff_clay_oc: {
      id: 'stiff_clay_oc',
      label: 'Stiff clay (OC)',
      description: 'Over-consolidated cohesive soil (OCR = 2). m = 1.',
      fields: {
        ...makeStrengthFields({
          Emc: 15000, nu: 0.3, cEff: 20,
          phiEffDeg: 25, psiEffDeg: 0,
          gamma: 18, gammaSat: 20
        }),
        hs: makeHsBlock({
          E50_ref: 15000,
          Eoed_ref: 15000,
          Eur_ref: 75000,
          m: 1.0,
          nu_ur: 0.2,
          Rf: 0.9,
          OCR: 2.0
        })
      }
    }
  };
  // Pin the fingerprint onto each preset, then deep-freeze.
  for (const key of Object.keys(raw)) {
    raw[key].hsPresetFingerprint = makeFingerprint(raw[key].fields);
    Object.freeze(raw[key].fields.hs);
    Object.freeze(raw[key].fields);
    Object.freeze(raw[key]);
  }
  return Object.freeze(raw);
}

export const HS_PRESETS = buildPresets();

export const HS_PRESET_IDS = Object.freeze(['loose_sand', 'dense_sand', 'soft_clay_nc', 'stiff_clay_oc']);

/**
 * Compare two HS field bundles for equality (within a tiny absolute
 * tolerance for floating-point comparison). Used by the UI to decide
 * whether to display "preset" or "custom" after the user edits fields.
 */
export function hsFieldsEqual(a, b, eps = 1e-9) {
  if (!a || !b) return false;
  const fieldsA = a.hs || {};
  const fieldsB = b.hs || {};
  const hsKeys = ['E50_ref', 'Eoed_ref', 'Eur_ref', 'm', 'nu_ur', 'p_ref',
    'Rf', 'K0_nc', 'e_init', 'e_max', 'OCR'];
  for (const key of hsKeys) {
    const va = Number(fieldsA[key]);
    const vb = Number(fieldsB[key]);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) {
      if (Number.isFinite(va) !== Number.isFinite(vb)) return false;
      continue;
    }
    if (Math.abs(va - vb) > eps * Math.max(1, Math.abs(va), Math.abs(vb))) return false;
  }
  const mcKeys = ['Emc', 'nu', 'cEff', 'phiEffDeg', 'psiEffDeg', 'gamma', 'gammaSat'];
  for (const key of mcKeys) {
    const va = Number(a[key]);
    const vb = Number(b[key]);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) {
      if (Number.isFinite(va) !== Number.isFinite(vb)) return false;
      continue;
    }
    if (Math.abs(va - vb) > eps * Math.max(1, Math.abs(va), Math.abs(vb))) return false;
  }
  return true;
}

/**
 * Apply a preset to a material in place. Overwrites all HS fields and the
 * matching MC strength/elastic fields. Preserves the material's id and
 * label by default; callers can also override via `overrides`.
 *
 * Returns the updated material reference (for chaining or sanity checks).
 */
export function applyHsPreset(material, presetId, overrides = {}) {
  const preset = HS_PRESETS[presetId];
  if (!preset || !material || typeof material !== 'object') return material;
  const fields = preset.fields;
  // Overwrite the MC-style strength fields. Label / id are preserved
  // unless explicitly overridden.
  material.Emc = fields.Emc;
  material.nu = fields.nu;
  material.cEff = fields.cEff;
  material.phiEffDeg = fields.phiEffDeg;
  material.psiEffDeg = fields.psiEffDeg;
  material.psi = fields.psiEffDeg;
  material.gamma = fields.gamma;
  material.gammaSat = fields.gammaSat;
  material.K0nc = fields.K0nc;
  material.rShear = fields.rShear;
  material.sigmaTAllow = fields.sigmaTAllow;
  material.useTensionCutoff = fields.useTensionCutoff;
  // Replace the HS sub-object entirely.
  material.hs = { ...fields.hs };
  // Tag the material with the preset id so the UI can detect "preset" vs
  // "custom" once the user edits a single field.
  material.hsPresetId = presetId;
  material.hsPresetFingerprint = makeFingerprint(fields);
  if (overrides && typeof overrides === 'object') {
    for (const key of Object.keys(overrides)) material[key] = overrides[key];
  }
  return material;
}

/**
 * Compute a fingerprint string for a preset's field bundle. Used to detect
 * "custom" edits in O(1) by comparing the live fingerprint of the material
 * against the stored preset fingerprint.
 */
export function makeFingerprint(fields) {
  if (!fields) return '';
  const hs = fields.hs || {};
  return [
    fields.Emc, fields.nu, fields.cEff,
    fields.phiEffDeg, fields.psiEffDeg, fields.gamma, fields.gammaSat,
    fields.K0nc, fields.rShear, fields.sigmaTAllow,
    hs.E50_ref, hs.Eoed_ref, hs.Eur_ref, hs.m, hs.nu_ur, hs.p_ref,
    hs.Rf, hs.K0_nc, hs.e_init, hs.e_max, hs.OCR
  ].map((v) => Number(v).toFixed(6)).join('|');
}

/**
 * Compute the live fingerprint of a material (HS-relevant fields only).
 * Comparison against `material.hsPresetFingerprint` tells the UI whether
 * the user has diverged from the preset.
 */
export function liveMaterialFingerprint(material) {
  if (!material || typeof material !== 'object') return '';
  const hs = material.hs || {};
  return [
    material.Emc, material.nu, material.cEff,
    material.phiEffDeg, material.psiEffDeg ?? material.psi,
    material.gamma, material.gammaSat,
    material.K0nc, material.rShear, material.sigmaTAllow,
    hs.E50_ref, hs.Eoed_ref, hs.Eur_ref, hs.m, hs.nu_ur, hs.p_ref,
    hs.Rf, hs.K0_nc, hs.e_init, hs.e_max, hs.OCR
  ].map((v) => Number(v).toFixed(6)).join('|');
}

/**
 * Returns true if the material currently matches its stored preset (no
 * user edits since the preset was applied). False means "custom".
 */
export function isMaterialMatchingPreset(material) {
  if (!material || !material.hsPresetId) return false;
  const preset = HS_PRESETS[material.hsPresetId];
  if (!preset) return false;
  const expected = preset.hsPresetFingerprint || makeFingerprint(preset.fields);
  return liveMaterialFingerprint(material) === expected;
}

/**
 * Compute K0_nc via Jaky's formula (1 − sin φ'). Returned as a positive
 * number; callers should clamp into a physically reasonable band.
 */
export function jakyK0nc(phiEffDeg) {
  const phi = (Number(phiEffDeg) || 0) * Math.PI / 180;
  return Math.max(0.05, 1 - Math.sin(phi));
}

/**
 * Compute the critical-state friction angle φ_cv via the inverse Rowe
 * formula. Given φ' (peak) and ψ' (dilatancy) in degrees, the Rowe relation
 * sin ψ = (sin φ - sin φ_cv) / (1 - sin φ · sin φ_cv) inverts to
 *   sin φ_cv = (sin φ - sin ψ) / (1 - sin φ · sin ψ).
 * Returns φ_cv in degrees.
 *
 * Matches the implementation that lives inside material_hs.hpp; replicated
 * here as a pure-JS read-only display helper (does NOT participate in the
 * actual constitutive update).
 */
export function rowePhiCvDeg(phiEffDeg, psiEffDeg) {
  const phi = (Number(phiEffDeg) || 0) * Math.PI / 180;
  const psi = (Number(psiEffDeg) || 0) * Math.PI / 180;
  const sphi = Math.sin(phi);
  const spsi = Math.sin(psi);
  const denom = 1 - sphi * spsi;
  if (Math.abs(denom) < 1e-12) return Number(phiEffDeg) || 0;
  const sphiCv = (sphi - spsi) / denom;
  const clamped = Math.max(-0.999, Math.min(0.999, sphiCv));
  return Math.asin(clamped) * 180 / Math.PI;
}

