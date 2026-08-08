// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stratigraphy store: the single owner of correlation state.
//
// Persisted on PROJECT.stratigraphy (so future project save/load carries it):
//   { version, settings, result: { fingerprint, nextUnitSeq,
//     units: [{ id, name|null, members: [{cptIdx, layerIdx}] }] } | null }
//
// Everything else — aggregated properties, ordering, names, colours, section
// polygons — is derived on demand from the persisted members plus the live
// project, so a change in a CPT's layer model can never leave stale numbers
// on screen: the fingerprint mismatch surfaces as an explicit "stale" flag
// instead.

import { buildProfiles, medianSpacing } from './profiles.js';
import { correlateProfiles } from './correlate.js';
import { deriveUnitProperties, unitLetter } from './units.js';
import { buildSectionPolygons } from './geometry.js';
import { SOIL_FILL_COLORS } from '../soil-styles.js';

const STATE_VERSION = 1;

export const DEFAULT_SETTINGS = {
  minMatch: 0.45, // correlation sensitivity threshold
  characteristic: 'wmean' // 'wmean' | 'min' for strength parameters
};

export function createStratigraphyStore(ctx) {
  // ctx: { getProject, layerParamsFor(cpt, layer) → {hs, kh} }

  function state() {
    const project = ctx.getProject();
    if (!project.stratigraphy || project.stratigraphy.version !== STATE_VERSION) {
      project.stratigraphy = { version: STATE_VERSION, settings: { ...DEFAULT_SETTINGS }, result: null };
    }
    // Older saved states may miss newly added settings.
    project.stratigraphy.settings = { ...DEFAULT_SETTINGS, ...project.stratigraphy.settings };
    return project.stratigraphy;
  }

  const settings = () => state().settings;

  function setSetting(key, value) {
    if (key === 'minMatch') {
      const v = Number(value);
      if (Number.isFinite(v)) settings().minMatch = Math.min(Math.max(v, 0.2), 0.8);
    } else if (key === 'characteristic') {
      settings().characteristic = value === 'min' ? 'min' : 'wmean';
    }
  }

  /** Recorrelate from scratch. Discards manual edits (caller confirms). */
  function run() {
    const st = state();
    const profiles = buildProfiles(ctx.getProject());
    if (profiles.cpts.length < 2) {
      st.result = null;
      return derived();
    }
    const { units } = correlateProfiles(profiles, {
      minMatch: settings().minMatch
    });
    let seq = 1;
    st.result = {
      fingerprint: profiles.fingerprint,
      nextUnitSeq: units.length + 1,
      manual: false,
      units: units.map((u) => ({ id: `u${seq++}`, name: null, members: u.members }))
    };
    return derived();
  }

  /** True when the engineer has adjusted the automatic correlation. */
  function hasManualEdits() {
    return !!state().result?.manual;
  }

  function hasResult() {
    return !!state().result;
  }

  /** Auto-run once when entering the phase with enough data and no result yet. */
  function ensureRun() {
    if (!hasResult()) {
      const profiles = buildProfiles(ctx.getProject());
      if (profiles.cpts.length >= 2) run();
    }
  }

  // ── manual stratigraphic interpretation ────────────────────────────────

  function findUnit(unitId) {
    return state().result?.units.find((u) => u.id === unitId) || null;
  }

  function removeMemberEverywhere(result, cptIdx, layerIdx) {
    result.units.forEach((u) => {
      u.members = u.members.filter((m) => !(m.cptIdx === cptIdx && m.layerIdx === layerIdx));
    });
  }

  function dropEmptyUnits(result) {
    result.units = result.units.filter((u) => u.members.length);
  }

  /** Move one CPT layer to another unit, or to a fresh unit ('new'). */
  function assignMember(cptIdx, layerIdx, unitId) {
    const result = state().result;
    if (!result) return;
    result.manual = true;
    removeMemberEverywhere(result, cptIdx, layerIdx);
    let target = unitId === 'new' ? null : findUnit(unitId);
    if (!target) {
      target = { id: `u${result.nextUnitSeq++}`, name: null, members: [] };
      result.units.push(target);
    }
    target.members.push({ cptIdx, layerIdx });
    target.members.sort((a, b) => a.cptIdx - b.cptIdx || a.layerIdx - b.layerIdx);
    dropEmptyUnits(result);
  }

  /** Merge all members of one unit into another (engineering judgment). */
  function mergeUnits(fromId, intoId) {
    const result = state().result;
    if (!result || fromId === intoId) return;
    const from = findUnit(fromId);
    const into = findUnit(intoId);
    if (!from || !into) return;
    result.manual = true;
    into.members.push(...from.members);
    into.members.sort((a, b) => a.cptIdx - b.cptIdx || a.layerIdx - b.layerIdx);
    from.members = [];
    dropEmptyUnits(result);
  }

  function renameUnit(unitId, name) {
    const unit = findUnit(unitId);
    if (!unit) return;
    unit.name = String(name || '').trim() || null;
    state().result.manual = true;
  }

  // ── derivation ─────────────────────────────────────────────────────────

  function paramsFor(profiles) {
    const project = ctx.getProject();
    return (cptIdx, layerIdx) => {
      const cpt = project.cpts[cptIdx];
      const layer = cpt?.layers?.[layerIdx];
      if (!cpt || !layer || typeof ctx.layerParamsFor !== 'function') return null;
      return ctx.layerParamsFor(cpt, layer);
    };
  }

  function layerLookupFor(profiles) {
    const lookup = new Map();
    profiles.cpts.forEach((c) => c.layers.forEach((l) => lookup.set(`${c.cptIdx}:${l.layerIdx}`, l)));
    return lookup;
  }

  /**
   * The complete view model: profiles, ordered derived units, warnings,
   * section polygons and staleness — everything the UI and the exports need.
   */
  function derived() {
    const project = ctx.getProject();
    const st = state();
    const profiles = buildProfiles(project);
    const base = {
      profiles,
      settings: { ...st.settings },
      spacing: medianSpacing(profiles.cpts),
      hasResult: !!st.result,
      stale: false,
      units: [],
      polygons: [],
      warnings: [],
      excluded: profiles.excluded
    };
    if (!st.result) return base;

    if (st.result.fingerprint !== profiles.fingerprint) {
      return { ...base, stale: true };
    }

    const lookup = layerLookupFor(profiles);
    const getParams = paramsFor(profiles);
    const characteristic = st.settings.characteristic;

    const derivedUnits = st.result.units
      .map((u) => {
        const props = deriveUnitProperties(u.members, lookup, getParams, { characteristic });
        if (!props) return null;
        return { id: u.id, customName: u.name, ...props };
      })
      .filter(Boolean);

    // Superposition order: thickness-weighted mean mid-elevation, top first.
    derivedUnits.sort((a, b) => midTaw(b, lookup) - midTaw(a, lookup));
    derivedUnits.forEach((u, i) => {
      u.letter = unitLetter(i);
      u.name = u.customName || `${u.letter} — ${u.subtype || u.type}`;
      u.color = SOIL_FILL_COLORS[u.type] || '#D3D1C7';
    });

    const polygons = buildSectionPolygons(profiles.cpts, derivedUnits, lookup).map((poly) => ({
      ...poly,
      color: SOIL_FILL_COLORS[poly.type] || '#D3D1C7'
    }));

    return {
      ...base,
      units: derivedUnits,
      polygons,
      warnings: collectWarnings(derivedUnits, profiles, lookup)
    };
  }

  function midTaw(unit, lookup) {
    let sum = 0;
    let w = 0;
    unit.members.forEach(({ cptIdx, layerIdx }) => {
      const l = lookup.get(`${cptIdx}:${layerIdx}`);
      if (!l) return;
      const weight = Math.max(l.thk, 0.01);
      sum += ((l.topTaw + l.botTaw) / 2) * weight;
      w += weight;
    });
    return w ? sum / w : -Infinity;
  }

  function collectWarnings(units, profiles, lookup) {
    const warnings = [];
    units.forEach((u) => {
      const families = new Set(
        u.members.map(({ cptIdx, layerIdx }) => {
          const l = lookup.get(`${cptIdx}:${layerIdx}`);
          return l ? (l.type === 'Sand' || l.type === 'Gravel' || l.type === 'Silty sand' ? 'granular' : 'cohesive') : null;
        })
      );
      families.delete(null);
      if (families.size > 1) {
        warnings.push({
          level: 'warn',
          text: `Eenheid ${u.name}: combineert cohesieve en granulaire lagen — controleer de toewijzing.`
        });
      }

      // Two members of the same CPT with a foreign layer in between would
      // make the unit's span overlap its neighbours in the section.
      const byCpt = new Map();
      u.members.forEach((m) => {
        if (!byCpt.has(m.cptIdx)) byCpt.set(m.cptIdx, []);
        byCpt.get(m.cptIdx).push(m.layerIdx);
      });
      byCpt.forEach((layerIdxs, cptIdx) => {
        layerIdxs.sort((a, b) => a - b);
        for (let i = 1; i < layerIdxs.length; i++) {
          if (layerIdxs[i] - layerIdxs[i - 1] > 1) {
            const cpt = profiles.cpts.find((c) => c.cptIdx === cptIdx);
            warnings.push({
              level: 'warn',
              text: `Eenheid ${u.name}: niet-aaneengesloten lagen in ${cpt?.id || 'CPT'} — er ligt een andere eenheid tussen.`
            });
            break;
          }
        }
      });
    });
    return warnings;
  }

  return {
    state,
    settings,
    setSetting,
    run,
    ensureRun,
    hasResult,
    hasManualEdits,
    assignMember,
    mergeUnits,
    renameUnit,
    derived
  };
}
