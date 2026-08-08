// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Layer-pair similarity for the correlation engine.
//
// Scores how likely two layers from *different* CPTs sample the same
// geological unit. Works entirely in absolute elevation (m TAW) so CPTs at
// different surface levels compare correctly. The score feeds the ordered
// sequence alignment in alignment.js — position along the sounding is
// enforced there, so this score only judges the layers themselves.

import { lithoCompatibility, soilFamily } from './soil-knowledge.js';

export const DEFAULT_WEIGHTS = {
  litho: 0.4, // soil type / Tabel 3 subtype compatibility
  elevation: 0.25, // depth-interval overlap in TAW
  qc: 0.2, // cone-resistance similarity (log-ratio)
  rf: 0.1, // friction-ratio similarity
  thickness: 0.05 // bed-thickness similarity
};

/* Elevation agreement: interval IoU when the layers overlap; otherwise decays
   with the vertical gap. Tolerance widens with CPT spacing (default 0.5 cm/m,
   floor 0.5 m) so gently dipping strata still correlate at long spacings. */
export function elevationScore(a, b, spacing = 25) {
  const overlap = Math.min(a.topTaw, b.topTaw) - Math.max(a.botTaw, b.botTaw);
  if (overlap > 0) {
    const union = Math.max(a.topTaw, b.topTaw) - Math.min(a.botTaw, b.botTaw);
    return overlap / Math.max(union, 0.01);
  }
  const tolerance = Math.max(0.5, 0.005 * spacing);
  return Math.max(0, 1 - -overlap / tolerance) * 0.5; // capped: no overlap is never better than 50 % IoU
}

export function qcScore(a, b) {
  const qa = Math.max(0.01, a.avgQc);
  const qb = Math.max(0.01, b.avgQc);
  // 1 order of magnitude apart → 0. Robust across soft clay vs dense sand.
  return Math.max(0, 1 - Math.abs(Math.log(qa / qb)) / Math.log(10));
}

export function rfScore(a, b) {
  if (a.avgRf == null || b.avgRf == null) return 0.5; // unknown: neutral
  return Math.max(0, 1 - Math.abs(a.avgRf - b.avgRf) / 3);
}

export function thicknessScore(a, b) {
  const ta = Math.max(a.thk, 0.01);
  const tb = Math.max(b.thk, 0.01);
  return Math.min(ta, tb) / Math.max(ta, tb);
}

/**
 * Similarity in [0, 1], or -Infinity when the layers are lithologically
 * incompatible (a hard gate: peat never correlates with gravel, no matter
 * how well elevations line up).
 */
export function layerSimilarity(a, b, { weights = DEFAULT_WEIGHTS, spacing = 25 } = {}) {
  const litho = lithoCompatibility(a, b);
  if (litho === 0) return -Infinity;
  // Cross-family matches (cohesive vs granular) only via genuine transition
  // types; damp them so they never outcompete a same-family alternative.
  const familyDamp = soilFamily(a.type, a.subtype) === soilFamily(b.type, b.subtype) ? 1 : 0.6;

  const s =
    weights.litho * litho +
    weights.elevation * elevationScore(a, b, spacing) +
    weights.qc * qcScore(a, b) +
    weights.rf * rfScore(a, b) +
    weights.thickness * thicknessScore(a, b);
  return s * familyDamp;
}
