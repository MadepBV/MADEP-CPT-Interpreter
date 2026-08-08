// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Section geometry: soil units → closed 2D polygons in (chainage, m TAW).
//
// Rules (standard fence-diagram conventions):
//   - Between two CPTs that both sample a unit, its top and bottom are
//     linearly interpolated.
//   - Where a unit is absent at a neighbouring CPT it *pinches out*: top and
//     bottom converge to a point halfway to that CPT (the half-distance
//     rule — without extra information the wedge tip is equally likely
//     anywhere in between, so the midpoint is the unbiased estimate).
//   - A unit absent at an interior CPT splits into separate lobes — that is
//     what makes lenses possible.
//   - At the outer ends of the section nothing is extrapolated: polygons
//     stop with a vertical edge at the outermost sampled CPT.
//
// The same polygons drive the Doorsnede rendering, the correlation-panel
// ribbons and the DXF export, so what the engineer sees is what Plaxis gets.

/**
 * @param {Array} sectionCpts  profiles.cpts — sorted by dist
 * @param {Array} derivedUnits [{id, name, type, subtype, members:[{cptIdx, layerIdx}]}]
 * @param {Map<string, object>} layerLookup `${cptIdx}:${layerIdx}` → profile layer
 * @returns {Array<{unitId, name, type, subtype, points:Array<{dist:number, taw:number}>}>}
 *   one entry per lobe, ordered like derivedUnits (top unit first).
 */
export function buildSectionPolygons(sectionCpts, derivedUnits, layerLookup) {
  if (sectionCpts.length < 2) return [];
  const posByCptIdx = new Map(sectionCpts.map((c, i) => [c.cptIdx, i]));
  const polygons = [];

  derivedUnits.forEach((unit) => {
    // Vertical span of the unit at each section position where it is present.
    const spans = new Array(sectionCpts.length).fill(null);
    unit.members.forEach(({ cptIdx, layerIdx }) => {
      const pos = posByCptIdx.get(cptIdx);
      const layer = layerLookup.get(`${cptIdx}:${layerIdx}`);
      if (pos == null || !layer) return;
      const span = spans[pos] || { top: -Infinity, bot: Infinity };
      span.top = Math.max(span.top, layer.topTaw);
      span.bot = Math.min(span.bot, layer.botTaw);
      spans[pos] = span;
    });

    // Contiguous runs of presence → one lobe each.
    let runStart = null;
    for (let k = 0; k <= spans.length; k++) {
      const present = k < spans.length && spans[k];
      if (present && runStart == null) runStart = k;
      if (!present && runStart != null) {
        const lobe = buildLobe(sectionCpts, spans, runStart, k - 1);
        if (lobe) polygons.push({ unitId: unit.id, name: unit.name, type: unit.type, subtype: unit.subtype, points: lobe });
        runStart = null;
      }
    }
  });

  return polygons;
}

function buildLobe(sectionCpts, spans, first, last) {
  const tops = [];
  const bots = [];
  for (let k = first; k <= last; k++) {
    tops.push({ dist: sectionCpts[k].dist, taw: spans[k].top });
    bots.push({ dist: sectionCpts[k].dist, taw: spans[k].bot });
  }

  const points = [];
  // Left closure: pinch halfway to the previous CPT, or a vertical edge at
  // the section end.
  if (first > 0) {
    const pinchDist = (sectionCpts[first - 1].dist + sectionCpts[first].dist) / 2;
    points.push({ dist: pinchDist, taw: (spans[first].top + spans[first].bot) / 2 });
  }
  points.push(...tops);
  if (last < sectionCpts.length - 1) {
    const pinchDist = (sectionCpts[last].dist + sectionCpts[last + 1].dist) / 2;
    points.push({ dist: pinchDist, taw: (spans[last].top + spans[last].bot) / 2 });
  }
  points.push(...bots.reverse());

  // Degenerate lobes (single CPT at a section end: a zero-width sliver)
  // are dropped — there is nothing honest to draw.
  const minDist = Math.min(...points.map((p) => p.dist));
  const maxDist = Math.max(...points.map((p) => p.dist));
  if (maxDist - minDist < 1e-6 || points.length < 3) return null;
  return points;
}
