// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Order-preserving alignment of two layer sequences (Needleman–Wunsch).
//
// Borehole/CPT correlation is a sequence-alignment problem: layers obey
// superposition, so correlation lines between two soundings must not cross.
// Global alignment with gap penalties is the standard technique for exactly
// this constraint (dynamic-programming log correlation; cf. Waterman &
// Raymond 1987, "The match game: new stratigraphic correlation algorithms").
//
// A *gap* — a layer left unmatched — is the mathematical form of a pinch-out:
// the bed exists in one sounding and wedges out before the next. Gap cost
// scales with relative bed thickness, so thin lenses pinch out readily while
// skipping a thick regional bed is expensive.

import { layerSimilarity } from './similarity.js';

export const DEFAULT_ALIGNMENT_OPTIONS = {
  minMatch: 0.45, // similarity a pair must clear to add alignment value
  gapCost: 0.06 // base cost of leaving a median-thickness layer unmatched
};

function medianThickness(layers) {
  const thk = layers
    .map((l) => l.thk)
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((x, y) => x - y);
  if (!thk.length) return 1;
  const mid = Math.floor(thk.length / 2);
  return thk.length % 2 ? thk[mid] : (thk[mid - 1] + thk[mid]) / 2;
}

/**
 * Align two top→bottom layer sequences.
 *
 * @param {Array} seqA  layers of CPT A (profiles.js shape, TAW fields)
 * @param {Array} seqB  layers of CPT B
 * @param {object} opts { spacing, weights, minMatch, gapCost }
 * @returns {{ pairs: Array<{ia:number, ib:number, score:number}>,
 *             gapsA: number[], gapsB: number[] }}
 *   pairs are strictly increasing in both ia and ib (non-crossing);
 *   gapsA/gapsB list unmatched layer indices (pinch-out candidates).
 */
export function alignSequences(seqA, seqB, opts = {}) {
  const { minMatch, gapCost } = { ...DEFAULT_ALIGNMENT_OPTIONS, ...opts };
  const n = seqA.length;
  const m = seqB.length;
  const medThk = medianThickness([...seqA, ...seqB]);
  const gapFor = (layer) => gapCost * Math.min(Math.max(layer.thk / medThk, 0.5), 2);

  // Pair score: value above the match threshold. Slightly-below-threshold
  // matches stay possible when the alternative is a double gap, which keeps
  // the alignment stable near the threshold instead of flickering.
  const pairScore = (ia, ib) => {
    const s = layerSimilarity(seqA[ia], seqB[ib], opts);
    return s === -Infinity ? -Infinity : s - minMatch;
  };

  // DP over prefix lengths. M[i][j] = best score aligning seqA[0..i) with seqB[0..j).
  const M = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const FROM = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 1=diag 2=up(gap A) 3=left(gap B)
  for (let i = 1; i <= n; i++) {
    M[i][0] = M[i - 1][0] - gapFor(seqA[i - 1]);
    FROM[i][0] = 2;
  }
  for (let j = 1; j <= m; j++) {
    M[0][j] = M[0][j - 1] - gapFor(seqB[j - 1]);
    FROM[0][j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = M[i - 1][j - 1] + pairScore(i - 1, j - 1);
      const up = M[i - 1][j] - gapFor(seqA[i - 1]);
      const left = M[i][j - 1] - gapFor(seqB[j - 1]);
      if (diag >= up && diag >= left && diag > -Infinity) {
        M[i][j] = diag;
        FROM[i][j] = 1;
      } else if (up >= left) {
        M[i][j] = up;
        FROM[i][j] = 2;
      } else {
        M[i][j] = left;
        FROM[i][j] = 3;
      }
    }
  }

  // Trace back.
  const pairs = [];
  const matchedA = new Set();
  const matchedB = new Set();
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = FROM[i][j];
    if (step === 1) {
      const score = layerSimilarity(seqA[i - 1], seqB[j - 1], opts);
      pairs.push({ ia: i - 1, ib: j - 1, score });
      matchedA.add(i - 1);
      matchedB.add(j - 1);
      i -= 1;
      j -= 1;
    } else if (step === 2) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  pairs.reverse();

  const gapsA = seqA.map((_, k) => k).filter((k) => !matchedA.has(k));
  const gapsB = seqB.map((_, k) => k).filter((k) => !matchedB.has(k));
  return { pairs, gapsA, gapsB };
}
