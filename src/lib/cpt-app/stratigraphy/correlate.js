// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Multi-CPT correlation: from per-CPT layer sequences to shared soil units.
//
// Method (the engineering-standard fence-diagram workflow):
//   1. Order the CPTs along the section line (profiles.js).
//   2. Align each *adjacent* pair of soundings with the order-preserving
//      sequence alignment (alignment.js). Aligning neighbours — not all
//      pairs — is deliberate: geological continuity is a local property,
//      and pairwise-monotone links along the line can never cross.
//   3. Chain the pairwise links with union–find. A layer left unmatched on
//      one side is a pinch-out: its unit simply has no member there.
//   4. Sort the resulting units by mean elevation (superposition order).
//
// The result stores only member references; deriving unit properties and
// section geometry are separate concerns (units.js, geometry.js).

import { alignSequences } from './alignment.js';

const memberKey = (cptIdx, layerIdx) => `${cptIdx}:${layerIdx}`;

class UnionFind {
  constructor() {
    this.parent = new Map();
  }
  add(k) {
    if (!this.parent.has(k)) this.parent.set(k, k);
  }
  find(k) {
    let root = k;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    // Path compression.
    let cur = k;
    while (cur !== root) {
      const next = this.parent.get(cur);
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a, b) {
    this.parent.set(this.find(a), this.find(b));
  }
}

/**
 * @param {ReturnType<import('./profiles.js').buildProfiles>} profiles
 * @param {object} options  similarity weights / minMatch / gapCost overrides
 * @returns {{ units: Array<{members: Array<{cptIdx:number, layerIdx:number}>}>,
 *             links: Array<{a:number, b:number, ia:number, ib:number, score:number}> }}
 *   units sorted top→bottom (mean member mid-elevation, thickness-weighted);
 *   links are the retained pairwise correlations (a/b index into profiles.cpts).
 */
export function correlateProfiles(profiles, options = {}) {
  const { cpts } = profiles;
  const uf = new UnionFind();
  cpts.forEach((c) => c.layers.forEach((l) => uf.add(memberKey(c.cptIdx, l.layerIdx))));

  const links = [];
  for (let k = 0; k + 1 < cpts.length; k++) {
    const A = cpts[k];
    const B = cpts[k + 1];
    const spacing = Math.max(B.dist - A.dist, 1);
    const { pairs } = alignSequences(A.layers, B.layers, { ...options, spacing });
    pairs.forEach(({ ia, ib, score }) => {
      uf.union(memberKey(A.cptIdx, A.layers[ia].layerIdx), memberKey(B.cptIdx, B.layers[ib].layerIdx));
      links.push({ a: k, b: k + 1, ia, ib, score: +score.toFixed(3) });
    });
  }

  // Collect components → units.
  const layerByKey = new Map();
  cpts.forEach((c) =>
    c.layers.forEach((l) => layerByKey.set(memberKey(c.cptIdx, l.layerIdx), { cptIdx: c.cptIdx, layer: l }))
  );
  const components = new Map();
  layerByKey.forEach((_, key) => {
    const root = uf.find(key);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(key);
  });

  const units = [...components.values()].map((keys) => {
    const members = keys
      .map((key) => layerByKey.get(key))
      .map(({ cptIdx, layer }) => ({ cptIdx, layerIdx: layer.layerIdx }));
    return { members: sortMembers(members, layerByKey) };
  });

  units.sort((u, v) => meanMidTaw(v.members, layerByKey) - meanMidTaw(u.members, layerByKey));
  return { units, links };
}

function sortMembers(members, layerByKey) {
  return [...members].sort((m1, m2) => m1.cptIdx - m2.cptIdx || m1.layerIdx - m2.layerIdx);
}

function meanMidTaw(members, layerByKey) {
  let wSum = 0;
  let w = 0;
  members.forEach(({ cptIdx, layerIdx }) => {
    const { layer } = layerByKey.get(memberKey(cptIdx, layerIdx));
    const weight = Math.max(layer.thk, 0.01);
    wSum += ((layer.topTaw + layer.botTaw) / 2) * weight;
    w += weight;
  });
  return w ? wSum / w : 0;
}
