// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Soil-unit property derivation.
//
// A unit's parameters are *derived from its members* — the individual CPT
// layers that sample it — never invented. Conventions:
//   - Averages are thickness-weighted: a 4 m member says more about the unit
//     than a 0.4 m sliver of the same bed.
//   - Every aggregate carries its min–max envelope so the engineer sees the
//     spread, not just a single number.
//   - Strength parameters (φ', c', cu) offer a characteristic choice:
//     'wmean' (thickness-weighted mean) or 'min' (lower-bound member).
//   - Stiffness moduli aggregate as thickness-weighted means; permeabilities
//     as geometric means (log-normal convention for k).
//   - Lithology (type/subtype) is decided by thickness vote.

import { soilFamily } from './soil-knowledge.js';

function weighted(values, weights) {
  let sum = 0;
  let w = 0;
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    sum += v * weights[i];
    w += weights[i];
  });
  return w ? sum / w : null;
}

function envelope(values) {
  const nums = values.filter((v) => v != null && Number.isFinite(v));
  if (!nums.length) return { min: null, max: null };
  return { min: Math.min(...nums), max: Math.max(...nums) };
}

function aggregate(values, weights, digits = 2) {
  const wmean = weighted(values, weights);
  const { min, max } = envelope(values);
  const round = (v) => (v == null ? null : +v.toFixed(digits));
  return { wmean: round(wmean), min: round(min), max: round(max) };
}

function geometricMean(values, weights) {
  let sum = 0;
  let w = 0;
  values.forEach((v, i) => {
    if (v == null || !(v > 0)) return;
    sum += Math.log(v) * weights[i];
    w += weights[i];
  });
  return w ? Math.exp(sum / w) : null;
}

function thicknessVote(members, field) {
  const tally = new Map();
  members.forEach((m) => {
    const key = m.layer[field] || '';
    tally.set(key, (tally.get(key) || 0) + m.layer.thk);
  });
  let best = '';
  let bestW = -1;
  tally.forEach((wt, key) => {
    if (wt > bestW) {
      best = key;
      bestW = wt;
    }
  });
  return best;
}

/**
 * Derive the aggregated properties of one unit.
 *
 * @param {Array<{cptIdx:number, layerIdx:number}>} members
 * @param {Map<string, object>} layerLookup  `${cptIdx}:${layerIdx}` → profile layer
 * @param {(cptIdx:number, layerIdx:number) => {hs:object, kh:object}|null} paramsFor
 *   Stage 4 parameter derivation in the member's own CPT context (stress
 *   state, α-method); null when unavailable (e.g. in Node verification).
 * @param {{characteristic?: 'wmean'|'min'}} options
 */
export function deriveUnitProperties(members, layerLookup, paramsFor = () => null, options = {}) {
  const characteristic = options.characteristic === 'min' ? 'min' : 'wmean';
  const resolved = members
    .map(({ cptIdx, layerIdx }) => ({
      cptIdx,
      layerIdx,
      layer: layerLookup.get(`${cptIdx}:${layerIdx}`)
    }))
    .filter((m) => m.layer);
  if (!resolved.length) return null;

  const weightsArr = resolved.map((m) => Math.max(m.layer.thk, 0.01));
  const of = (fn) => resolved.map((m) => fn(m.layer));

  const type = thicknessVote(resolved, 'type');
  const subtype = thicknessVote(resolved, 'subtype');

  const agg = {
    qc: aggregate(of((l) => l.avgQc), weightsArr, 2),
    rf: aggregate(of((l) => l.avgRf), weightsArr, 2),
    fs: aggregate(of((l) => l.avgFs), weightsArr, 4),
    g: aggregate(of((l) => l.g), weightsArr, 1),
    gs: aggregate(of((l) => l.gs), weightsArr, 1),
    phi: aggregate(of((l) => l.phi), weightsArr, 1),
    c: aggregate(of((l) => l.c), weightsArr, 1),
    cu: aggregate(of((l) => l.cu), weightsArr, 1),
    thk: aggregate(of((l) => l.thk), weightsArr, 2),
    topTaw: envelope(of((l) => l.topTaw)),
    botTaw: envelope(of((l) => l.botTaw))
  };

  // Stage 4 model parameters per member, aggregated at unit level.
  const memberParams = resolved.map((m) => paramsFor(m.cptIdx, m.layerIdx));
  let params = null;
  if (memberParams.every((p) => p && p.hs)) {
    const hsOf = (fn) => memberParams.map((p) => fn(p.hs));
    const khOf = (fn) => memberParams.map((p) => (p.kh ? fn(p.kh) : null));
    const mVote = (() => {
      const tally = new Map();
      memberParams.forEach((p, i) => tally.set(p.hs.m, (tally.get(p.hs.m) || 0) + weightsArr[i]));
      return [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0];
    })();
    params = {
      Eoed_i: aggregate(hsOf((h) => h.Eoed_i), weightsArr, 0),
      Eoed_ref: aggregate(hsOf((h) => h.Eoed_ref), weightsArr, 0),
      E50_ref: aggregate(hsOf((h) => h.E50_ref), weightsArr, 0),
      Eur_ref: aggregate(hsOf((h) => h.Eur_ref), weightsArr, 0),
      Emc: aggregate(hsOf((h) => h.Emc), weightsArr, 0),
      Edef: aggregate(hsOf((h) => h.Edef), weightsArr, 0),
      nu: aggregate(hsOf((h) => h.nu), weightsArr, 2),
      beta: aggregate(hsOf((h) => h.beta), weightsArr, 3),
      psi: aggregate(hsOf((h) => h.psi), weightsArr, 1),
      m: mVote,
      kh: geometricMean(khOf((k) => k.kh_rep), weightsArr),
      kv: geometricMean(khOf((k) => k.kv_rep), weightsArr)
    };
  }

  const pick = (a) => (characteristic === 'min' ? (a.min ?? a.wmean) : a.wmean);
  return {
    type,
    subtype,
    family: soilFamily(type, subtype),
    members: resolved.map(({ cptIdx, layerIdx }) => ({ cptIdx, layerIdx })),
    agg,
    params,
    characteristic: {
      mode: characteristic,
      g: agg.g.wmean, // unit weights: always the weighted mean
      gs: agg.gs.wmean,
      phi: pick(agg.phi),
      c: pick(agg.c),
      cu: pick(agg.cu)
    }
  };
}

/** Excel-style unit labels: A, B, …, Z, AA, AB, … */
export function unitLetter(index) {
  let n = index;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}
