// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck — plain ES module with JSDoc contracts and runtime input guards (repo pattern, see PLAN §5)
/**
 * Web Worker entry for the drivability runners. Message in:
 *   { id?, kind: 'vibratory'|'impact'|'profile', payload }
 * Message out:
 *   { id, ok: true, result } | { id, ok: false, error }
 * 'profile' builds the SRD profile (buildDrivingResistanceProfile) so the CPT never has to
 * leave the worker between steps; the two runners take a profile in their payload.
 */
import { buildDrivingResistanceProfile } from './srd-from-cpt.js';
import { runVibratoryDrivability } from './vibratory-drivability.js';
import { runImpactDrivability } from './impact-wave-equation.js';

const runners = { profile: buildDrivingResistanceProfile, vibratory: runVibratoryDrivability, impact: runImpactDrivability };

self.onmessage = (ev) => {
  const { id, kind, payload } = ev.data || {};
  try {
    const run = runners[kind];
    if (!run) throw new Error(`Unknown kind '${kind}'`);
    self.postMessage({ id, ok: true, result: run(payload || {}) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
