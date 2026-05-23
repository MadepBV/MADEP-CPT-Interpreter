// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

export const WALL_DEFAULT_K = 1e-10;
export const WALL_DEFAULT_GAMMA = 20;
export const WALL_DEFAULT_GAMMA_SAT = 20;
export const WALL_DEFAULT_MECHANICAL_E = 3.0e7;
export const WALL_DEFAULT_MECHANICAL_NU = 0.2;
export const WALL_DEFAULT_MECHANICAL_THICKNESS = 0.6;
export const WALL_DEFAULT_MECHANICAL_KAPPA = 5 / 6;

const WALL_MATERIAL_SOURCES = new Set(['user', 'preset', 'legacy-impermeable']);
const WALL_MECHANICAL_SOURCES = new Set(['concrete-fallback', 'preset', 'user']);

export const WALL_MECHANICAL_PRESETS = Object.freeze({
  concreteDiaphragm: Object.freeze({
    id: 'concrete-diaphragm',
    label: 'Concrete diaphragm',
    mechanical: Object.freeze({
      model: 'rectangular',
      E: WALL_DEFAULT_MECHANICAL_E,
      nu: WALL_DEFAULT_MECHANICAL_NU,
      thickness: WALL_DEFAULT_MECHANICAL_THICKNESS,
      kappa: WALL_DEFAULT_MECHANICAL_KAPPA,
      source: 'preset'
    }),
    seepage: Object.freeze({
      kAcross: 1e-12,
      kAlong: 1e-12,
      gamma: 24,
      gammaSat: 24
    })
  }),
  // ArcelorMittal AZ 26, per metre of wall: A = 197.8 cm2/m,
  // Iy = 55510 cm4/m, Wel,y = 2600 cm3/m. Section stiffnesses below
  // use E = 210 GPa, nu = 0.30; nominal thickness is display-only.
  steelSheetPileAz26: Object.freeze({
    id: 'steel-sheet-pile-AZ-26',
    label: 'Steel sheet pile AZ 26',
    mechanical: Object.freeze({
      model: 'section-properties',
      EA: 2.1e8 * 197.8e-4,
      EI: 2.1e8 * 55510e-8,
      GA: (2.1e8 / (2 * (1 + 0.3))) * 197.8e-4,
      kappa: 1,
      displayE: 2.1e8,
      displayNu: 0.3,
      displayThickness: 0.025,
      source: 'preset'
    }),
    seepage: Object.freeze({
      kAcross: 1e-12,
      kAlong: 1e-12,
      gamma: 78,
      gammaSat: 78
    })
  })
});

function soilText(layer) {
  return `${String(layer?.type || '')} ${String(layer?.subtype || '')}`.toLowerCase();
}

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function nonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function clampKappa(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 1
    ? numeric
    : WALL_DEFAULT_MECHANICAL_KAPPA;
}

function cloneMechanicalPreset(preset) {
  return preset?.mechanical ? { ...preset.mechanical } : null;
}

export function defaultWallMechanicalMaterial(source = 'concrete-fallback') {
  return {
    model: 'rectangular',
    E: WALL_DEFAULT_MECHANICAL_E,
    nu: WALL_DEFAULT_MECHANICAL_NU,
    thickness: WALL_DEFAULT_MECHANICAL_THICKNESS,
    kappa: WALL_DEFAULT_MECHANICAL_KAPPA,
    source: WALL_MECHANICAL_SOURCES.has(source) ? source : 'concrete-fallback'
  };
}

export function normalizeWallMechanicalMaterial(mechanical, fallback = null) {
  const input = mechanical && typeof mechanical === 'object' ? mechanical : fallback;
  if (!input || typeof input !== 'object') return defaultWallMechanicalMaterial();
  const source = WALL_MECHANICAL_SOURCES.has(input.source) ? input.source : 'user';
  const model = input.model === 'section-properties' ? 'section-properties' : 'rectangular';
  if (model === 'section-properties') {
    const EA = positiveNumber(input.EA);
    const EI = positiveNumber(input.EI);
    const GA = positiveNumber(input.GA);
    if (EA && EI && GA) {
      const out = {
        model,
        EA,
        EI,
        GA,
        kappa: clampKappa(input.kappa ?? 1),
        source
      };
      const displayE = positiveNumber(input.displayE ?? input.E);
      const displayNu = nonNegativeNumber(input.displayNu ?? input.nu);
      const displayThickness = positiveNumber(input.displayThickness ?? input.thickness);
      if (displayE) out.displayE = displayE;
      if (displayNu !== null && displayNu < 0.5) out.displayNu = displayNu;
      if (displayThickness) out.displayThickness = displayThickness;
      return out;
    }
  }
  const E = positiveNumber(input.E ?? input.Emc) ?? WALL_DEFAULT_MECHANICAL_E;
  const nuCandidate = Number(input.nu);
  const nu = Number.isFinite(nuCandidate) && nuCandidate >= 0 && nuCandidate < 0.5
    ? nuCandidate
    : WALL_DEFAULT_MECHANICAL_NU;
  return {
    model: 'rectangular',
    E,
    nu,
    thickness: positiveNumber(input.thickness) ?? WALL_DEFAULT_MECHANICAL_THICKNESS,
    kappa: clampKappa(input.kappa),
    source
  };
}

export function resolveWallMechanicalSection(mechanical) {
  const m = normalizeWallMechanicalMaterial(mechanical);
  if (m.model === 'section-properties') {
    return {
      model: m.model,
      E: m.displayE || 0,
      nu: m.displayNu ?? 0,
      thickness: m.displayThickness || 0,
      EA: m.EA,
      EI: m.EI,
      GA: m.GA,
      kappa: clampKappa(m.kappa ?? 1)
    };
  }
  return {
    model: m.model,
    E: m.E,
    nu: m.nu,
    thickness: m.thickness,
    EA: m.E * m.thickness,
    EI: m.E * Math.pow(m.thickness, 3) / 12,
    GA: m.E * m.thickness / (2 * (1 + m.nu)),
    kappa: clampKappa(m.kappa)
  };
}

export function wallMechanicalPresetById(id) {
  if (id === 'steel-sheet-pile-AZ-26' || id === 'sheetPile') return WALL_MECHANICAL_PRESETS.steelSheetPileAz26;
  if (id === 'concrete-diaphragm' || id === 'diaphragm') return WALL_MECHANICAL_PRESETS.concreteDiaphragm;
  return null;
}

function estimateDefaultKh(layer) {
  const text = soilText(layer);
  const type = String(layer?.type || '');

  if (type === 'Gravel' || text.includes('grind')) return 1e-3;

  if (type === 'Sand' || text.includes('zand')) {
    if (text.includes('zeer dicht') || text.includes('z.dicht')) return 2e-4;
    if (text.includes('dicht')) return 1.5e-4;
    if (text.includes('matig')) return 4e-5;
    return 3e-6;
  }

  if (type === 'Silty sand') return 3e-6;
  if (type === 'Sandy clay') return 5e-7;
  if (type === 'Clay') return 5e-8;
  if (type === 'Soft clay') return 2e-8;
  if (type === 'Peat / organic') return 2e-7;

  if (text.includes('veen') || text.includes('peat')) return 2e-7;
  if (text.includes('leem') || text.includes('silt')) return 5e-7;
  if (text.includes('klei') || text.includes('clay')) return 5e-8;

  return 1e-5;
}

function defaultKhKvRatio(layer) {
  const type = String(layer?.type || '');
  if (type === 'Sand' || type === 'Silty sand' || type === 'Gravel') return 1;
  return 3;
}

export function defaultKx(layer) {
  return estimateDefaultKh(layer);
}

export function defaultKy(layer) {
  const kh = estimateDefaultKh(layer);
  return kh / defaultKhKvRatio(layer);
}

export function resolveMaterialPermeability(layer, prior = null) {
  const previous = prior || {};
  const keepPrior =
    previous.kSource === 'user' &&
    Number.isFinite(Number(previous.kx)) &&
    Number.isFinite(Number(previous.ky)) &&
    Number(previous.kx) > 0 &&
    Number(previous.ky) > 0;

  if (keepPrior) {
    return {
      kx: Number(previous.kx),
      ky: Number(previous.ky),
      kSource: 'user'
    };
  }

  const kh = Number(layer?.kh);
  const kv = Number(layer?.kv);
  const haveCpt = Number.isFinite(kh) && Number.isFinite(kv) && kh > 0 && kv > 0;

  return {
    kx: haveCpt ? kh : defaultKx(layer),
    ky: haveCpt ? kv : defaultKy(layer),
    kSource: haveCpt ? 'cpt' : 'sbtn-default'
  };
}

export function seepageSourceLabel(value) {
  if (value === 'user') return 'user';
  if (value === 'cpt') return 'CPT';
  return 'SBTn default';
}

export function wallMaterialSourceLabel(value) {
  if (value === 'legacy-impermeable') return 'legacy impermeable';
  if (value === 'preset') return 'preset';
  if (value === 'user') return 'user';
  return 'preset';
}

export function normalizeWallMaterial(material, index = 0, wallId = '', options = {}) {
  const hasMaterial = material && typeof material === 'object';
  const sourceFallback = options.sourceFallback || (hasMaterial ? 'user' : 'legacy-impermeable');
  const source = WALL_MATERIAL_SOURCES.has(material?.kSource) ? material.kSource : sourceFallback;
  const suffix = wallId || `${index + 1}`;
  const defaultLabel = source === 'legacy-impermeable' ? 'Legacy impermeable' : 'Wall material';
  const kAcross = positiveNumber(material?.kAcross ?? material?.kx) ?? WALL_DEFAULT_K;
  const kAlong = positiveNumber(material?.kAlong ?? material?.ky) ?? WALL_DEFAULT_K;
  const mechanicalFallback = cloneMechanicalPreset(wallMechanicalPresetById(options.mechanicalPreset));
  return {
    id: material?.id || (source === 'legacy-impermeable' ? `wall-legacy-${suffix}` : `wall-material-${suffix}`),
    label: material?.label || defaultLabel,
    kAcross,
    kAlong,
    gamma: positiveNumber(material?.gamma) ?? WALL_DEFAULT_GAMMA,
    gammaSat: positiveNumber(material?.gammaSat) ?? WALL_DEFAULT_GAMMA_SAT,
    kSource: source,
    mechanical: normalizeWallMechanicalMaterial(material?.mechanical, mechanicalFallback)
  };
}
