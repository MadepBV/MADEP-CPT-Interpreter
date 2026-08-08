// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Input snapshot for the stratigraphy engine.
//
// Turns the mutable multi-CPT project state into an immutable, TAW-based
// profile set: eligible CPTs projected onto the section line, each with its
// ordered layer sequence in absolute elevation. Also computes the input
// fingerprint used to detect that a stored correlation went stale because
// the engineer changed a layer model, an elevation, or the CPT set.

/**
 * Least-squares section line through the CPT positions (principal axis of
 * the XY scatter), the same convention the Doorsnede view uses. CPTs without
 * coordinates fall back to import order at a nominal 50 m spacing.
 *
 * @param {Array<{x:number|null, y:number|null}>} cpts
 * @returns {number[]} chainage (m) per input index, unsorted
 */
export function projectOntoSectionLine(cpts) {
  const hasCoords = cpts.length > 0 && cpts.every((c) => c.x != null && c.y != null);
  if (!hasCoords) return cpts.map((_, i) => i * 50);

  const cx = cpts.reduce((s, c) => s + c.x, 0) / cpts.length;
  const cy = cpts.reduce((s, c) => s + c.y, 0) / cpts.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  cpts.forEach((c) => {
    sxx += (c.x - cx) ** 2;
    sxy += (c.x - cx) * (c.y - cy);
    syy += (c.y - cy) ** 2;
  });

  let dx;
  let dy;
  if (Math.abs(sxy) < 1e-6 && sxx >= syy) {
    dx = 1;
    dy = 0;
  } else if (Math.abs(sxy) < 1e-6) {
    dx = 0;
    dy = 1;
  } else {
    const diff = sxx - syy;
    const disc = Math.sqrt(diff * diff + 4 * sxy * sxy);
    const lam = (sxx + syy + disc) / 2;
    dx = sxy;
    dy = lam - sxx;
    const len = Math.hypot(dx, dy);
    dx /= len;
    dy /= len;
  }
  return cpts.map((c) => (c.x - cx) * dx + (c.y - cy) * dy);
}

function snapshotLayer(layer, layerIdx, elev) {
  return {
    layerIdx,
    type: layer.type,
    subtype: layer.subtype || '',
    topTaw: +(elev - layer.top).toFixed(3),
    botTaw: +(elev - layer.bot).toFixed(3),
    thk: +(layer.bot - layer.top).toFixed(3),
    avgQc: layer.avgQc,
    avgFs: layer.avgFs ?? null,
    avgRf: layer.avgRf ?? null,
    g: layer.g,
    gs: layer.gs,
    phi: layer.phi,
    c: layer.c,
    cu: layer.cu
  };
}

/**
 * Build the engine input from the project.
 *
 * @returns {{ cpts: Array<{cptIdx:number, id:string, elev:number, dist:number,
 *             toeTaw:number, layers:Array}>, excluded: Array<{id:string, reason:string}>,
 *             fingerprint: string } }
 *   cpts are sorted by chainage; layers top→bottom in TAW.
 */
export function buildProfiles(project) {
  const eligible = [];
  const excluded = [];
  project.cpts.forEach((cpt, cptIdx) => {
    if (cpt.elev == null) {
      excluded.push({ id: cpt.id, reason: 'geen bevestigde maaiveldhoogte (m TAW)' });
    } else if (!cpt.layers.length) {
      excluded.push({ id: cpt.id, reason: 'geen laagindeling (doorloop Stage 1–3)' });
    } else {
      eligible.push({ cpt, cptIdx });
    }
  });

  const dists = projectOntoSectionLine(eligible.map(({ cpt }) => cpt));
  const cpts = eligible
    .map(({ cpt, cptIdx }, i) => ({
      cptIdx,
      id: cpt.id,
      elev: cpt.elev,
      wt: cpt.wt ?? null,
      dist: dists[i],
      toeTaw: +(cpt.elev - (cpt.data[cpt.data.length - 1]?.z ?? cpt.layers[cpt.layers.length - 1].bot)).toFixed(3),
      layers: cpt.layers.map((l, li) => snapshotLayer(l, li, cpt.elev))
    }))
    .sort((a, b) => a.dist - b.dist);

  // Normalise chainage to start at 0 for display and export.
  const d0 = cpts.length ? cpts[0].dist : 0;
  cpts.forEach((c) => {
    c.dist = +(c.dist - d0).toFixed(3);
  });

  return { cpts, excluded, fingerprint: profilesFingerprint(cpts) };
}

/* Fingerprint over everything the correlation result depends on. */
export function profilesFingerprint(cpts) {
  return cpts
    .map(
      (c) =>
        `${c.cptIdx}:${c.elev}:${c.dist}:` +
        c.layers.map((l) => `${l.type}|${l.subtype}|${l.topTaw}|${l.botTaw}`).join(',')
    )
    .join(';');
}

/** Median spacing between consecutive CPTs along the section (m). */
export function medianSpacing(cpts) {
  if (cpts.length < 2) return 25;
  const gaps = [];
  for (let i = 1; i < cpts.length; i++) gaps.push(cpts[i].dist - cpts[i - 1].dist);
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  const med = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return Math.max(med, 1);
}
