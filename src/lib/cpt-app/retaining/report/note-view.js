// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Calculation note ("rekennota") hand-off: builds a self-contained payload of everything the
 * note needs (inputs, soil profile with overrides, engine result with all branches, structural
 * checks, PLAXIS sets, drivability and vibration results), stores it in localStorage and opens
 * the print-first report route /report/retaining?key=… in a new tab.
 */
import { esc, fmt } from '../results/result-kit.js';
import { isEmbedded, wallType } from '../wall-types.js';

export const RETAINING_NOTE_PREFIX = 'retaining-note:';
export const RETAINING_NOTE_VERSION = 1;

export function buildNotePayload({ rw, layers, profile, structural, vibration, meta }) {
  const t = wallType(rw.wallType);
  const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
  return {
    kind: 'madep-cp/retaining-note',
    version: RETAINING_NOTE_VERSION,
    generatedAt: new Date().toISOString(),
    project: { name: meta?.projectName || 'CPT Project', cptId: meta?.cptId || '', appVersion: meta?.appVersion || '' },
    wall: { type: t.id, label: t.label, family: t.family, embedded: isEmbedded(rw.wallType) },
    state: clone({ ...rw, result: undefined, drivability: { ...rw.drivability, result: undefined }, ui: undefined }),
    layers: clone(layers || []),
    profile: clone(profile ? { strata: profile.strata, notes: profile.notes, extendedTopBy: profile.extendedTopBy, cutTopBy: profile.cutTopBy } : null),
    result: clone(rw.result),
    structural: clone(structural),
    drivability: clone(rw.drivability?.result || null),
    vibration: clone(vibration)
  };
}

export function saveNotePayload(storage, payload) {
  const key = `${RETAINING_NOTE_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  storage.setItem(key, JSON.stringify(payload));
  const stale = [];
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(RETAINING_NOTE_PREFIX) && k !== key) stale.push(k); }
  stale.forEach((k) => storage.removeItem(k));
  return key;
}

export function loadNotePayload(storage, key) {
  if (!storage || !key) return null;
  try {
    const p = JSON.parse(storage.getItem(key) || 'null');
    return p && p.kind === 'madep-cp/retaining-note' ? p : null;
  } catch { return null; }
}

export function openNote(payload) {
  const key = saveNotePayload(window.localStorage, payload);
  window.open(`/report/retaining?key=${encodeURIComponent(key)}`, '_blank', 'noopener');
}

export function noteView(rw) {
  const embedded = isEmbedded(rw.wallType);
  return `<div class="st6-rw-grid2"><div>
      <div class="st6-rw-card-title">Print-ready calculation note</div>
      <p class="st6-rw-note">Generates a complete, navigable note in the structure of a Belgian "rekennota" for a temporary retaining wall: references, assumptions, geometry, CPT-derived characteristic parameters with every override flagged, risk class and partial factors, the hand calculation per design branch (design strengths, coefficients, pressures, embedment, section forces), the Eurocode verifications with utilisation${embedded ? ', the EN 1993 steel checks, the full PLAXIS 2D input set (Plate / Embedded Beam Row, T<sub>skin</sub>, F<sub>max</sub>, multilinear T<sub>lat</sub> table), the drivability estimate and the vibration assessment' : ''}. Every number can be copied into the project note.</p>
      <div class="st6-rw-actions"><button type="button" class="btn sm pri" onclick="retwallOpenNote()">Open calculation note ↗</button><span class="st6-help">opens in a new tab — print or save as PDF from there</span></div>
      <div class="st6-rw-note">${rw.result ? `Current result: ${esc(rw.result.wallType)}, ${rw.result.overallPass ? 'all engine verifications pass' : 'not verified'}${embedded ? `, M_Ed ${fmt(rw.result.structural?.Mmax, 1)} ${rw.result.perPile ? 'kNm/pile' : 'kNm/m'}` : ''}.` : 'Run the analysis first.'}</div>
    </div><div>
      <div class="st6-rw-card-title">What the note states explicitly</div>
      <ul class="st6-rw-note" style="padding-left:16px;margin:0">
        <li>Partial-factor scheme and every factor per branch (no hidden values).</li>
        <li>Over-excavation rule and the resulting design excavation.</li>
        <li>Soil parameters: CPT-derived characteristic values, overrides (c′!), stratigraphy shift.</li>
        <li>Wall-friction assumptions and the Belgian caps.</li>
        ${embedded ? '<li>Which resistance model was used below the excavation (effective width vs Brinch Hansen) and that PLAXIS T<sub>lat</sub> always uses Brinch Hansen with B = b.</li><li>The non-normative status of the drivability and vibration models.</li>' : ''}
      </ul>
    </div></div>`;
}
