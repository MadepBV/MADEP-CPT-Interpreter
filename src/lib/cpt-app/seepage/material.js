// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

export const WALL_DEFAULT_K = 1e-10;
export const WALL_DEFAULT_GAMMA = 20;
export const WALL_DEFAULT_GAMMA_SAT = 20;

const WALL_MATERIAL_SOURCES = new Set(['user', 'preset', 'legacy-impermeable']);

function soilText(layer) {
  return `${String(layer?.type || '')} ${String(layer?.subtype || '')}`.toLowerCase();
}

function positiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
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
  return {
    id: material?.id || (source === 'legacy-impermeable' ? `wall-legacy-${suffix}` : `wall-material-${suffix}`),
    label: material?.label || defaultLabel,
    kAcross,
    kAlong,
    gamma: positiveNumber(material?.gamma) ?? WALL_DEFAULT_GAMMA,
    gammaSat: positiveNumber(material?.gammaSat) ?? WALL_DEFAULT_GAMMA_SAT,
    kSource: source
  };
}
