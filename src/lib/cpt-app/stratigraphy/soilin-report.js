// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// SCIA Engineer SOILIN report: payload builder + localStorage hand-off.
//
// SOILIN's geological model is entered per borehole, and the *layer order
// must be identical in every borehole* — where a unit is locally absent it
// is entered with thickness 0. This module builds exactly that: for every
// CPT a borehole table listing ALL soil units in stratigraphic order with
// the local thickness (0.00 where the unit pinches out) and the unit's
// derived SOILIN parameters: E_def [MN/m²], ν, γ_dry, γ_sat and m.
//
// The payload is rendered by the /report/soilin route (print → PDF), using
// the same storage hand-off pattern as the Stage 7 report.

export const SOILIN_REPORT_STORAGE_PREFIX = 'soilin-report:';
export const SOILIN_REPORT_VERSION = 1;

const round = (v, d) => (v == null || !Number.isFinite(v) ? null : +(+v).toFixed(d));

/**
 * @param {object} derived  stratigraphy store view model (fresh, not stale)
 * @param {{projectName?: string, generatedAt?: string}} meta
 */
export function buildSoilinReportPayload(derived, meta = {}) {
  const units = derived.units.map((u) => ({
    letter: u.letter,
    name: u.name,
    type: u.type,
    subtype: u.subtype || u.type,
    color: u.color,
    // SOILIN layer parameters, unit-level (same values in every borehole —
    // that is the point of correlating the layers into shared units).
    EdefMPa: u.params ? round(u.params.Edef.wmean / 1000, 1) : null,
    nu: u.params ? round(u.params.nu.wmean, 2) : null,
    beta: u.params ? round(u.params.beta.wmean, 3) : null,
    gammaDry: round(u.characteristic.g, 1),
    gammaSat: round(u.characteristic.gs, 1),
    m: u.params ? round(u.params.m, 2) : null
  }));

  const unitByMember = new Map();
  derived.units.forEach((u, ui) => {
    u.members.forEach((m) => unitByMember.set(`${m.cptIdx}:${m.layerIdx}`, ui));
  });

  const boreholes = derived.profiles.cpts.map((cpt) => {
    // Local thickness per unit (a unit may own several stacked layers here).
    const thickness = new Array(units.length).fill(0);
    cpt.layers.forEach((l) => {
      const ui = unitByMember.get(`${cpt.cptIdx}:${l.layerIdx}`);
      if (ui != null) thickness[ui] += l.thk;
    });
    return {
      id: cpt.id,
      elev: round(cpt.elev, 2),
      dist: round(cpt.dist, 1),
      rows: units.map((u, ui) => ({
        unit: ui,
        thickness: round(thickness[ui], 2)
      }))
    };
  });

  return {
    version: SOILIN_REPORT_VERSION,
    kind: 'soilin',
    generatedAt: meta.generatedAt || '',
    project: { name: meta.projectName || 'CPT Project' },
    characteristic: derived.settings.characteristic,
    units,
    boreholes
  };
}

// ── storage hand-off (same pattern as report-storage.js) ──────────────────

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isSoilinPayload(payload) {
  return (
    isPlainObject(payload) &&
    payload.version === SOILIN_REPORT_VERSION &&
    payload.kind === 'soilin' &&
    isPlainObject(payload.project) &&
    Array.isArray(payload.units) &&
    Array.isArray(payload.boreholes) &&
    payload.boreholes.every((b) => isPlainObject(b) && Array.isArray(b.rows) && b.rows.length === payload.units.length)
  );
}

export function saveSoilinPayload(storage, payload) {
  if (!storage || !isSoilinPayload(payload)) return '';
  const key = `${SOILIN_REPORT_STORAGE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  storage.setItem(key, JSON.stringify(payload));
  // Keep only the latest payload around.
  const staleKeys = [];
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (k && k.startsWith(SOILIN_REPORT_STORAGE_PREFIX) && k !== key) staleKeys.push(k);
  }
  staleKeys.forEach((k) => storage.removeItem(k));
  return key;
}

export function loadSoilinPayload(storage, key) {
  if (!storage || !key) return null;
  try {
    const payload = JSON.parse(storage.getItem(key) || 'null');
    return isSoilinPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}
