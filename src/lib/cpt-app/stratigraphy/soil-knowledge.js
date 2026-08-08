// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Soil-type compatibility knowledge for cross-CPT correlation.
//
// Answers one question: how plausible is it that two classified CPT layers
// belong to the same geological unit, judged on lithology alone?
//
// Two knowledge sources are combined:
//   1. NEN/Eurocode Tabel 3 groups (veen/klei/leem/zand/grind) via the layer
//      subtype, resolved through the shared CAT catalogue — the engineer's
//      confirmed Stage 3 interpretation.
//   2. Robertson soil-behaviour-type adjacency — classification of the same
//      geological unit legitimately drifts one zone between soundings
//      (e.g. a leem bed reading "Sandy clay" at one CPT and "Silty sand"
//      at the next).

import { CAT } from '../eurocode-tabel3.js';

/* Tabel 3 group per subtype, memoised (CAT is static). */
const GRP_BY_SUBTYPE = new Map(CAT.map((row) => [row.subtype, row.grp]));

export function tabel3Group(subtype) {
  return GRP_BY_SUBTYPE.get(subtype) || '';
}

/* Robertson CPT type → directly compatible (ok) and transitional (adj)
   Tabel 3 groups. Mirrors the Stage 3 COMPAT dropdown matrix. */
const TYPE_TO_GROUPS = {
  'Peat / organic': { ok: ['veen'], adj: [] },
  'Soft clay': { ok: ['klei'], adj: ['leem'] },
  Clay: { ok: ['klei'], adj: ['leem'] },
  'Sandy clay': { ok: ['leem', 'klei'], adj: ['zand'] },
  'Silty sand': { ok: ['leem', 'zand'], adj: [] },
  Sand: { ok: ['zand'], adj: ['grind', 'leem'] },
  Gravel: { ok: ['grind'], adj: ['zand'] }
};

/* Robertson type adjacency ladder (behaviour-type drift between soundings). */
const TYPE_NEIGHBOURS = {
  'Peat / organic': ['Soft clay'],
  'Soft clay': ['Peat / organic', 'Clay'],
  Clay: ['Soft clay', 'Sandy clay'],
  'Sandy clay': ['Clay', 'Silty sand'],
  'Silty sand': ['Sandy clay', 'Sand'],
  Sand: ['Silty sand', 'Gravel'],
  Gravel: ['Sand']
};

export function soilFamily(type, subtype) {
  const grp = tabel3Group(subtype);
  if (grp === 'veen' || grp === 'klei' || grp === 'leem') return 'cohesive';
  if (grp === 'zand' || grp === 'grind') return 'granular';
  return type === 'Sand' || type === 'Gravel' || type === 'Silty sand' ? 'granular' : 'cohesive';
}

/**
 * Lithological compatibility of two layers, in [0, 1].
 *   1.00  identical subtype            — same Tabel 3 row
 *   0.90  same Tabel 3 group           — e.g. two klei variants
 *   0.75  same Robertson type          — subtype differs or is missing
 *   0.60  group of one is 'ok' for the other's type
 *   0.40  neighbouring Robertson types — transition-zone drift
 *   0.25  group of one is 'adj' for the other's type
 *   0.00  incompatible                 — must never share a unit
 */
export function lithoCompatibility(a, b) {
  if (a.subtype && a.subtype === b.subtype) return 1.0;

  const grpA = tabel3Group(a.subtype);
  const grpB = tabel3Group(b.subtype);
  if (grpA && grpA === grpB) return 0.9;

  if (a.type === b.type) return 0.75;

  const okAB = grpB && (TYPE_TO_GROUPS[a.type]?.ok || []).includes(grpB);
  const okBA = grpA && (TYPE_TO_GROUPS[b.type]?.ok || []).includes(grpA);
  if (okAB || okBA) return 0.6;

  if ((TYPE_NEIGHBOURS[a.type] || []).includes(b.type)) return 0.4;

  const adjAB = grpB && (TYPE_TO_GROUPS[a.type]?.adj || []).includes(grpB);
  const adjBA = grpA && (TYPE_TO_GROUPS[b.type]?.adj || []).includes(grpA);
  if (adjAB || adjBA) return 0.25;

  return 0;
}
