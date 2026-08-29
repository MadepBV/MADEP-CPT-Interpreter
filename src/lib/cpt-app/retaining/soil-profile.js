// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Soil profile for the retaining-wall engine: turns the interpreted CPT layer model into
 * engine strata, with
 *   • a vertical shift of the whole stratigraphy relative to the wall datum
 *     (`offset` = CPT ground level − reference surface, m; positive = the CPT was pushed from a
 *     level ABOVE the reference surface, negative = from BELOW it). Layers above the reference
 *     surface are cut off; when the CPT ground level lies below the surface, the uppermost
 *     layer is extended upward ("interpolated") to the surface — the engineer is told so.
 *   • per-layer parameter overrides (c′ first of all — its uncertainty often leads to a
 *     deliberately very low design value — but also φ′, γ, γ_sat, c_u and the drainage
 *     framework), stored by a stable layer key so a re-run of the layer detection does not
 *     silently apply an override to a different layer.
 *
 * Units: elevations m (up), depths m (down from the CPT ground level), γ kN/m³, φ′ °, c′/c_u kPa,
 * q_c MPa in the layer model → kPa in the strata. Pure module: no DOM, no globals.
 */

/** Stable key for a layer of the Stage 3/4 model (top/bot to the cm, plus the type). */
export function layerKey(layer, index) {
  const t = Number.isFinite(layer?.top) ? layer.top.toFixed(2) : String(index);
  const b = Number.isFinite(layer?.bot) ? layer.bot.toFixed(2) : '';
  return `${index}:${t}-${b}:${layer?.type || ''}`;
}

const OVERRIDABLE = ['gammaMoist', 'gammaSat', 'phi', 'c', 'cu', 'drained'];

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** Characteristic parameters of one CPT layer, before overrides. */
export function layerBaseParameters(layer) {
  const g = num(layer.g, 19);
  return {
    gammaMoist: g,
    gammaSat: num(layer.gs, g + 1),
    phi: num(layer.phi, 30),
    c: num(layer.c, 0),
    cu: num(layer.cu, 0),
    // drainage framework: drained (φ′, c′) unless the layer only carries c_u
    drained: !(num(layer.phi, 0) < 1 && num(layer.cu, 0) > 0),
    qc: num(layer.avgQc, 0),
    type: layer.type || '',
    subtype: layer.subtype || ''
  };
}

/**
 * Resolve the parameters of a layer after overrides.
 * @param {object} layer  Stage 3/4 layer
 * @param {number} index
 * @param {object} overrides  map layerKey → partial { gammaMoist, gammaSat, phi, c, cu, drained }
 * @returns {{params: object, overridden: string[]}}
 */
export function resolveLayerParameters(layer, index, overrides) {
  const base = layerBaseParameters(layer);
  const o = overrides?.[layerKey(layer, index)];
  const overridden = [];
  if (o && typeof o === 'object') {
    for (const k of OVERRIDABLE) {
      if (o[k] === undefined || o[k] === null || o[k] === '') continue;
      if (k === 'drained') { base.drained = !!o[k]; overridden.push(k); continue; }
      const v = Number(o[k]);
      if (Number.isFinite(v)) { base[k] = v; overridden.push(k); }
    }
  }
  return { params: base, overridden };
}

/**
 * Build engine strata from the CPT layer model.
 * @param {object} args
 * @param {object[]} args.layers        Stage 3/4 working layers ({top, bot, g, gs, phi, c, cu, avgQc, type})
 * @param {number}   args.surfaceEl     elevation of the reference surface (where σ′_v = 0) in the wall frame
 * @param {number}   [args.offset=0]    CPT ground level − reference surface (m)
 * @param {object}   [args.overrides]   per-layer overrides (see resolveLayerParameters)
 * @param {object}   [args.fallback]    single material used when there are no layers
 * @param {number}   [args.minDepth=60] make sure the profile reaches this depth below the surface
 * @returns {{strata: object[], notes: string[], extendedTopBy: number, cutTopBy: number}}
 */
export function buildStrata({ layers, surfaceEl, offset = 0, overrides = {}, fallback = null, minDepth = 60 }) {
  const notes = [];
  const usable = (layers || []).filter((L) => Number.isFinite(L.top) && Number.isFinite(L.bot) && L.bot > L.top);
  if (!usable.length) {
    const f = fallback || { gammaMoist: 19, gammaSat: 21, phi: 30, c: 0, cu: 0, drained: true, qc: 0 };
    return {
      strata: [{ topEl: surfaceEl, gammaMoist: num(f.gammaMoist, 19), gammaSat: num(f.gammaSat, 21), phi: num(f.phi, 30), c: num(f.c, 0), cu: num(f.cu, 0), drained: f.drained !== false, qc: num(f.qc, 0) * 1000, label: f.label || 'single material', overridden: [] }],
      notes: ['No CPT layer model — a single uniform material is used.'],
      extendedTopBy: 0, cutTopBy: 0
    };
  }
  const cptGroundEl = surfaceEl + num(offset, 0);
  const strata = [];
  let cutTopBy = 0, extendedTopBy = 0;
  usable.forEach((L, i) => {
    const topEl = cptGroundEl - L.top;
    const botEl = cptGroundEl - L.bot;
    if (botEl >= surfaceEl - 1e-9) { cutTopBy = Math.max(cutTopBy, surfaceEl - botEl); return; }  // entirely above the surface
    const { params, overridden } = resolveLayerParameters(L, i, overrides);
    // the first kept layer always starts at the reference surface: cut off when the CPT ground
    // is above it, extended upward ("interpolated") when the CPT ground is below it
    strata.push({
      topEl: strata.length === 0 ? surfaceEl : Math.min(topEl, surfaceEl),
      botEl,
      gammaMoist: params.gammaMoist, gammaSat: params.gammaSat, phi: params.phi, c: params.c, cu: params.cu,
      drained: params.drained, qc: params.qc * 1000,
      label: params.type, subtype: params.subtype, layerIndex: i, key: layerKey(L, i), overridden
    });
  });
  if (!strata.length) {
    // every layer lies above the surface (huge positive offset): keep the deepest one, extended downward
    const L = usable[usable.length - 1];
    const { params, overridden } = resolveLayerParameters(L, usable.length - 1, overrides);
    strata.push({ topEl: surfaceEl, botEl: surfaceEl - minDepth, ...params, qc: params.qc * 1000, label: params.type, layerIndex: usable.length - 1, key: layerKey(L, usable.length - 1), overridden });
    notes.push('The whole CPT profile lies above the reference surface; the deepest layer was extended downward.');
  }
  if (cptGroundEl < surfaceEl - 1e-9) {
    extendedTopBy = surfaceEl - cptGroundEl;
    notes.push(`CPT ground level is ${extendedTopBy.toFixed(2)} m below the reference surface: the uppermost layer (${strata[0].label || 'layer 1'}) is extended upward to the surface with its own parameters.`);
  } else if (cptGroundEl > surfaceEl + 1e-9) {
    notes.push(`CPT ground level is ${(cptGroundEl - surfaceEl).toFixed(2)} m above the reference surface: the profile is cut off at the surface.`);
  }
  const last = strata[strata.length - 1];
  if (last.botEl > surfaceEl - minDepth) {
    notes.push(`The CPT ends ${(surfaceEl - last.botEl).toFixed(1)} m below the surface; the deepest layer (${last.label || 'last layer'}) is extended downward beyond the sounding.`);
  }
  return { strata, notes, extendedTopBy, cutTopBy };
}

/**
 * Drawing bands (elevation intervals) matching buildStrata, clipped to [minEl, clipTopEl].
 */
export function profileBands({ layers, surfaceEl, offset = 0, overrides = {}, fallback = null, minEl, clipTopEl, colorOf }) {
  const { strata } = buildStrata({ layers, surfaceEl, offset, overrides, fallback });
  const bands = [];
  const topClip = clipTopEl != null ? clipTopEl : surfaceEl;
  strata.forEach((s, i) => {
    let t = Math.min(s.topEl, topClip);
    let b = s.botEl != null ? s.botEl : minEl;
    if (i === strata.length - 1) b = Math.min(b, minEl);
    b = Math.max(b, minEl);
    if (t - b < 0.02) return;
    bands.push({ topEl: t, botEl: b, label: s.label, color: colorOf ? colorOf(s.label) : undefined, overridden: s.overridden, key: s.key });
  });
  return bands;
}

/** Strata for the engine JSON (drops drawing-only fields). */
export function strataForEngine(strata) {
  return strata.map((s) => ({ topEl: s.topEl, gammaMoist: s.gammaMoist, gammaSat: s.gammaSat, phi: s.phi, c: s.c, cu: s.cu, drained: s.drained !== false, qc: s.qc || 0 }));
}

/** Apply the same c′ to every layer (returns a new overrides map). */
export function setCohesionForAll(layers, overrides, cValue) {
  const out = { ...(overrides || {}) };
  (layers || []).forEach((L, i) => {
    const k = layerKey(L, i);
    out[k] = { ...(out[k] || {}), c: Number(cValue) };
  });
  return out;
}

/** Drop overrides whose layer no longer exists (after a re-run of the layer detection). */
export function pruneOverrides(layers, overrides) {
  const valid = new Set((layers || []).map((L, i) => layerKey(L, i)));
  const out = {};
  for (const k of Object.keys(overrides || {})) if (valid.has(k)) out[k] = overrides[k];
  return out;
}
