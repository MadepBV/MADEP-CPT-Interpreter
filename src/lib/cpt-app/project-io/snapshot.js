// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Project snapshot: serialise the complete multi-CPT project to a JSON-safe
// object and restore it onto a live project. Pure — no DOM, no File API —
// so the round-trip is verifiable in Node (verify_project_io.mjs).
//
// What is saved: everything the engineer produced — CPT data rows, surface
// levels, classification settings, the confirmed layer models with manual
// overrides, Stage 4/5 tuning, Stage 6 application state, the stratigraphy
// (units + manual interpretation), phase and stage position.
//
// What is NOT saved: derived/volatile state that the app rebuilds — chart
// instances, render caches, Stage 6 solver caches. Restoring recomputes
// them, so a stale cache can never be resurrected from a file.

export const PROJECT_SNAPSHOT_VERSION = 1;
export const PROJECT_SNAPSHOT_KIND = 'madep-cp/project';

/* Per-CPT keys that must never be serialised (runtime-only). */
const VOLATILE_CPT_KEYS = ['charts', 'chartsReady', 'stage6Cache'];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeCpt(cpt) {
  const clean = JSON.parse(
    JSON.stringify(cpt, (key, value) => (VOLATILE_CPT_KEYS.includes(key) ? undefined : value))
  );
  VOLATILE_CPT_KEYS.forEach((k) => delete clean[k]);
  return clean;
}

/**
 * @param {object} project  the live PROJECT object
 * @param {{activeStage?:number, savedAt?:string, appVersion?:string}} meta
 */
export function buildProjectSnapshot(project, meta = {}) {
  return {
    kind: PROJECT_SNAPSHOT_KIND,
    version: PROJECT_SNAPSHOT_VERSION,
    savedAt: meta.savedAt || '',
    appVersion: meta.appVersion || '',
    project: {
      name: project.name,
      activeCptIdx: project.activeCptIdx,
      phase: project.phase,
      activeStage: Number.isInteger(meta.activeStage) ? meta.activeStage : 0,
      sectionOrder: project.sectionOrder,
      stratigraphy: project.stratigraphy ?? null,
      cpts: project.cpts.map(sanitizeCpt)
    }
  };
}

export function validateProjectSnapshot(snapshot) {
  return (
    isPlainObject(snapshot) &&
    snapshot.kind === PROJECT_SNAPSHOT_KIND &&
    Number.isInteger(snapshot.version) &&
    snapshot.version >= 1 &&
    snapshot.version <= PROJECT_SNAPSHOT_VERSION &&
    isPlainObject(snapshot.project) &&
    Array.isArray(snapshot.project.cpts) &&
    snapshot.project.cpts.length > 0 &&
    snapshot.project.cpts.every((c) => isPlainObject(c) && Array.isArray(c.data) && Array.isArray(c.layers))
  );
}

/* Recursive merge of the saved state onto a freshly constructed default CPT:
   plain objects merge key-by-key (new app fields keep their defaults when
   absent from an older save), arrays and primitives are taken verbatim. */
function mergeInto(base, saved) {
  Object.keys(saved).forEach((key) => {
    const sv = saved[key];
    if (isPlainObject(sv) && isPlainObject(base[key])) {
      mergeInto(base[key], sv);
    } else {
      base[key] = sv;
    }
  });
  return base;
}

/**
 * Restore a snapshot onto the live project (mutates it in place, keeping the
 * object identity that the rest of the app holds references to).
 *
 * @param {object} project     the live PROJECT object
 * @param {object} snapshot    validated snapshot
 * @param {{newCptState: (id:string)=>object}} deps
 * @returns {{activeCptIdx:number, activeStage:number, phase:string}}
 */
export function applyProjectSnapshot(project, snapshot, { newCptState }) {
  const saved = snapshot.project;

  project.name = saved.name || 'CPT Project';
  project.cpts = saved.cpts.map((savedCpt, i) => {
    const base = newCptState(savedCpt.id || `CPT-${i + 1}`);
    mergeInto(base, savedCpt);
    // Volatile state always starts fresh.
    base.charts = {};
    base.chartsReady = false;
    base.stage6Cache = {};
    return base;
  });
  project.sectionOrder = Array.isArray(saved.sectionOrder)
    ? saved.sectionOrder.filter((i) => Number.isInteger(i) && i >= 0 && i < project.cpts.length)
    : project.cpts.map((_, i) => i);
  if (!project.sectionOrder.length) project.sectionOrder = project.cpts.map((_, i) => i);
  project.stratigraphy = saved.stratigraphy ?? null;

  const activeCptIdx = Math.min(Math.max(saved.activeCptIdx || 0, 0), project.cpts.length - 1);
  project.activeCptIdx = activeCptIdx;

  const phase = ['analysis', 'correlation', 'section'].includes(saved.phase) ? saved.phase : 'analysis';
  const activeStage = Math.min(Math.max(saved.activeStage || 0, 0), 5);
  return { activeCptIdx, activeStage, phase };
}
