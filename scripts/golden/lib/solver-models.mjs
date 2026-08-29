// SPDX-License-Identifier: AGPL-3.0-or-later
// Solver model fixtures as pure functions of constants (design §3.3): the inline model
// builders of scripts/verify_seepage_phase_2.mjs:194-306 (baseFixedModel,
// layeredIterateModel), scripts/verify_seepage_drains_walls.mjs:20-95 (baseModel with
// drains / walls), scripts/verify_deformation_phase_1.mjs:165-268 (baseModel, slopedModel)
// and, for the Hardening-Soil benchmarks, the material bundles of
// scripts/verify_hs_phase_8.mjs:75-118 on the geometry / loading constants of
// scripts/fixtures/hs_*.json (uniform top pressure, as those fixtures apply it).
// make-fixtures.mjs serialises every entry of MODELS to tests/golden/fixtures/models/
// so the solver suites read committed JSON and never depend on this generator.

const K_SOIL = 1e-5;

function homogeneousRegion(xMin, xMax, yMin, yMax, id = 'soil', k = K_SOIL) {
  return {
    id,
    polygon: [{ x: xMin, y: yMin }, { x: xMax, y: yMin }, { x: xMax, y: yMax }, { x: xMin, y: yMax }],
    material: { id, label: id, kx: k, ky: k, gamma: 18, gammaSat: 20 }
  };
}

/* ── seepage (verify_seepage_phase_2.mjs) ─────────────────────────────── */
export function seepageBaseFixedModel(rightBcType) {
  return {
    terrain: { vertices: [{ x: 0, y: 5 }, { x: 10, y: 5 }] },
    analysisBottomY: 0,
    phreatic: { vertices: [{ x: 0, y: 5 }, { x: 10, y: 2 }] },
    walls: [],
    regions: [homogeneousRegion(0, 10, 0, 5)],
    seepage: {
      bcs: [
        { edgeKey: 'side-left:0', type: 'head', head: 5, status: 'active' },
        { edgeKey: 'side-right:0', type: rightBcType, head: rightBcType === 'head' ? 2 : null, status: 'active' }
      ],
      options: { freeSurface: 'fixed', meshTargetArea: 0.4, usePhreaticAsSeed: true }
    }
  };
}

export function seepageLayeredIterateModel(kMid) {
  const band = (id, y0, y1, k) => ({
    id,
    polygon: [{ x: 0, y: y0 }, { x: 20, y: y0 }, { x: 20, y: y1 }, { x: 0, y: y1 }],
    material: { id, label: id, kx: k, ky: k, gamma: 18, gammaSat: 20 }
  });
  return {
    terrain: { vertices: [{ x: 0, y: 5 }, { x: 20, y: 5 }] },
    analysisBottomY: 0,
    phreatic: { vertices: [{ x: 0, y: 5 }, { x: 20, y: 0 }] },
    walls: [],
    regions: [band('bot', 0, 2, K_SOIL), band('mid', 2, 3, kMid), band('top', 3, 5, K_SOIL)],
    seepage: {
      bcs: [
        { edgeKey: 'side-left:0', type: 'head', head: 5, status: 'active' },
        { edgeKey: 'side-right:0', type: 'seepage-face', status: 'active' }
      ],
      options: { freeSurface: 'iterate', meshTargetArea: 0.2, usePhreaticAsSeed: true }
    }
  };
}

/* ── seepage with drains / walls (verify_seepage_drains_walls.mjs) ───────── */
export function seepageDrainWallModel({ height = 2, head = 10, drains = [], walls = [], meshTargetArea = 0.08, flowErrorTolerance = 1e-5 } = {}) {
  return {
    terrain: { vertices: [{ x: 0, y: height }, { x: 10, y: height }] },
    analysisBottomY: 0,
    phreatic: { vertices: [{ x: 0, y: height }, { x: 10, y: height }] },
    walls,
    drains,
    regions: [homogeneousRegion(0, 10, 0, height)],
    seepage: {
      bcs: [
        { edgeKey: 'terrain:0', type: 'head', head, status: 'active' },
        { edgeKey: 'side-left:0', type: 'head', head, status: 'active' },
        { edgeKey: 'side-right:0', type: 'head', head, status: 'active' }
      ],
      options: { freeSurface: 'iterate', meshTargetArea, usePhreaticAsSeed: true, maxRuntimeMs: 5000, flowErrorTolerance }
    }
  };
}

export const seepageDrain = (gating, head = 4, vertices = [{ x: 2, y: 1 }, { x: 8, y: 1 }]) => ({
  id: `drain-${gating}`, label: `${gating} drain`, vertices, closed: false, head: { kind: 'constant', value: head }, gating
});

export const SEEPAGE_LEGACY_WALL = { id: 'w1', x: 5, yTop: 2, yTip: 0.5, passiveSide: 'right' };
export const SEEPAGE_LEAKY_WALL = {
  ...SEEPAGE_LEGACY_WALL,
  material: { id: 'wall-legacy-w1', label: 'Leaky wall', kAcross: 1e-7, kAlong: 1e-12, gamma: 20, gammaSat: 20, kSource: 'user' }
};

/**
 * Wall models: the verify script's equal-head layout (10 m on every edge) only checks
 * legacy/explicit material parity and runs into the 5 s `maxRuntimeMs` limit — a
 * clock-dependent termination that cannot be a golden. Here the wall (verify_seepage_
 * drains_walls.mjs wall definitions, tip lifted to 0.5 m so flow passes underneath) sits
 * in a confined, fixed-phreatic domain with a 2 m head difference across it: one linear
 * solve, deterministic.
 */
export function seepageWallModel(wall, meshTargetArea = 0.12) {
  return {
    terrain: { vertices: [{ x: 0, y: 2 }, { x: 10, y: 2 }] },
    analysisBottomY: 0,
    phreatic: { vertices: [{ x: 0, y: 2 }, { x: 10, y: 2 }] },
    walls: [wall],
    drains: [],
    regions: [homogeneousRegion(0, 10, 0, 2)],
    seepage: {
      bcs: [
        { edgeKey: 'side-left:0', type: 'head', head: 10, status: 'active' },
        { edgeKey: 'side-right:0', type: 'head', head: 8, status: 'active' }
      ],
      options: { freeSurface: 'fixed', meshTargetArea, usePhreaticAsSeed: true }
    }
  };
}

/* ── deformation (verify_deformation_phase_1.mjs) ─────────────────────── */
export function deformationBaseModel(overrides = {}) {
  const material = { id: 'soil', label: 'soil', Emc: 25000, nu: 0.3, K0nc: 0.5, cEff: 1, phiEffDeg: 25, gamma: 18, gammaSat: 20, ...(overrides.material || {}) };
  return {
    terrain: { vertices: [{ x: 0, y: 0 }, { x: 24, y: 0 }] },
    analysisBottomY: -12,
    phreatic: { vertices: [{ x: 0, y: -20 }, { x: 24, y: -20 }] },
    walls: [],
    regions: [{ id: 'soil', polygon: [{ x: 0, y: -12 }, { x: 24, y: -12 }, { x: 24, y: 0 }, { x: 0, y: 0 }], material }],
    surfaceLoad: { xStart: 11, xEnd: 13, q: 40 },
    seepage: overrides.seepage || { mesh: null, result: null },
    ...overrides
  };
}

export function deformationSlopedModel(overrides = {}) {
  const material = { id: 'slope-soil', label: 'slope-soil', Emc: 22000, nu: 0.3, K0nc: 0.55, cEff: 6, phiEffDeg: 28, gamma: 18, gammaSat: 20, ...(overrides.material || {}) };
  return {
    terrain: { vertices: [{ x: 0, y: 1.5 }, { x: 8, y: 1.5 }, { x: 24, y: -6.5 }, { x: 35, y: -6.5 }] },
    analysisBottomY: -16.5,
    phreatic: { vertices: [{ x: 0, y: -20 }, { x: 24, y: -20 }] },
    walls: [],
    regions: [{ id: 'slope-soil', polygon: [{ x: 0, y: -16.5 }, { x: 35, y: -16.5 }, { x: 35, y: -6.5 }, { x: 8, y: 1.5 }, { x: 0, y: 1.5 }], material }],
    surfaceLoad: { xStart: 6, xEnd: 8, q: 12 },
    seepage: overrides.seepage || { mesh: null, result: null },
    ...overrides
  };
}

/* ── Hardening Soil benchmarks (verify_hs_phase_8.mjs bundles × scripts/fixtures/hs_*.json) ── */
export const HS_BUNDLES = {
  loose_sand: { Emc: 15000, nu: 0.3, cEff: 0, phiEffDeg: 30, psiEffDeg: 0, gamma: 17, gammaSat: 19, E50_ref: 15000, Eoed_ref: 15000, Eur_ref: 60000, m: 0.5, nu_ur: 0.2, hs: { p_ref: 100, Rf: 0.9, OCR: 1.0, e_init: -1, e_max: -1 } },
  stiff_clay_oc: { Emc: 15000, nu: 0.3, cEff: 20, phiEffDeg: 25, psiEffDeg: 0, gamma: 18, gammaSat: 20, E50_ref: 15000, Eoed_ref: 15000, Eur_ref: 75000, m: 1.0, nu_ur: 0.2, hs: { p_ref: 100, Rf: 0.9, OCR: 2.0, e_init: -1, e_max: -1 } }
};

/**
 * A Bishop-style section model for one HS benchmark: rectangle Lx × Ly (terrain at y = Ly,
 * base at y = 0), one region carrying the preset bundle (K0nc = 1 − sin φ), a uniform strip
 * load |kPa| over [xStart, xEnd] (the fixtures apply a uniform top pressure; the unload
 * case is run as the same magnitude in loading — analyzeDeformationModel needs a positive
 * load), phreatic far below the base (dry).
 */
export function hsBenchmarkModel({ name, preset, Lx, Ly, xStart, xEnd, kPa }) {
  const b = HS_BUNDLES[preset];
  if (!b) throw new Error(`unknown HS preset ${preset}`);
  const material = { id: preset, label: `${preset} (${name})`, ...b, K0nc: 1 - Math.sin(b.phiEffDeg * Math.PI / 180), sigmaTAllow: 0 };
  return {
    terrain: { vertices: [{ x: 0, y: Ly }, { x: Lx, y: Ly }] },
    phreatic: { vertices: [{ x: 0, y: -50 }, { x: Lx, y: -50 }] },
    regions: [{ id: preset, label: material.label, polygon: [{ x: 0, y: Ly }, { x: Lx, y: Ly }, { x: Lx, y: 0 }, { x: 0, y: 0 }], material }],
    analysisLeftX: 0,
    analysisRightX: Lx,
    analysisBottomY: 0,
    analysisTopY: Ly,
    walls: [],
    surfaceLoad: { xStart, xEnd, q: Math.abs(kPa) },
    seepage: null
  };
}

/** name → { model, source, note }; keys become models/<name>.json */
export const MODELS = {
  'seepage-base-fixed-head': { model: seepageBaseFixedModel('head'), source: 'scripts/verify_seepage_phase_2.mjs baseFixedModel("head")', note: 'fixed phreatic, head/head' },
  'seepage-base-fixed-face': { model: seepageBaseFixedModel('seepage-face'), source: 'scripts/verify_seepage_phase_2.mjs baseFixedModel("seepage-face")', note: 'fixed phreatic, head/seepage-face (exit gradient)' },
  'seepage-layered-iterate-k1e-5': { model: seepageLayeredIterateModel(1e-5), source: 'scripts/verify_seepage_phase_2.mjs layeredIterateModel(1e-5)', note: 'iterative free surface, homogeneous k' },
  'seepage-layered-iterate-k1e-7': { model: seepageLayeredIterateModel(1e-7), source: 'scripts/verify_seepage_phase_2.mjs layeredIterateModel(1e-7)', note: 'iterative free surface, low-k middle band' },
  'seepage-drain-when-saturated': { model: seepageDrainWallModel({ drains: [seepageDrain('when-saturated')] }), source: 'scripts/verify_seepage_drains_walls.mjs baseModel + drain("when-saturated")', note: 'gated drain at head 4 below a 10 m head' },
  'seepage-drain-always': { model: seepageDrainWallModel({ drains: [seepageDrain('always', 4)] }), source: 'scripts/verify_seepage_drains_walls.mjs baseModel + drain("always")', note: 'always-active drain' },
  'seepage-wall-legacy': { model: seepageWallModel(SEEPAGE_LEGACY_WALL), source: 'scripts/verify_seepage_drains_walls.mjs checkWallConductivity legacyWall (confined fixed-phreatic layout, see solver-models.mjs)', note: 'legacy impermeable wall, 2 m head difference, flow under the tip' },
  'seepage-wall-leaky': { model: seepageWallModel(SEEPAGE_LEAKY_WALL), source: 'scripts/verify_seepage_drains_walls.mjs checkWallConductivity leakyWall (confined fixed-phreatic layout)', note: 'wall with kAcross 1e-7 (user material)' },
  'deformation-base': { model: deformationBaseModel(), source: 'scripts/verify_deformation_phase_1.mjs baseModel()', note: '24 × 12 m flat, strip load 40 kPa at 11–13 m' },
  'deformation-sloped': { model: deformationSlopedModel(), source: 'scripts/verify_deformation_phase_1.mjs slopedModel()', note: 'slope 1.5 → −6.5 m, crest load 12 kPa' },
  'deformation-hs-drained-footing': { model: hsBenchmarkModel({ name: 'hs_drained_footing', preset: 'loose_sand', Lx: 5, Ly: 3, xStart: 0, xEnd: 5, kPa: 200 }), source: 'scripts/fixtures/hs_drained_footing.json geometry/footing × verify_hs_phase_8.mjs loose_sand bundle', note: 'HS drained footing: uniform 200 kPa on 5 × 3 m loose sand' },
  'deformation-hs-softclay-embankment': { model: hsBenchmarkModel({ name: 'hs_softclay_embankment', preset: 'loose_sand', Lx: 10, Ly: 3, xStart: 0, xEnd: 10, kPa: 200 }), source: 'scripts/fixtures/hs_softclay_embankment.json geometry/loading × verify_hs_phase_8.mjs loose_sand bundle', note: 'HS embankment: uniform 200 kPa on 10 × 3 m' },
  'deformation-hs-oc-excavation': { model: hsBenchmarkModel({ name: 'hs_oc_excavation', preset: 'stiff_clay_oc', Lx: 10, Ly: 8, xStart: 0, xEnd: 10, kPa: 10 }), source: 'scripts/fixtures/hs_oc_excavation.json geometry/loading × verify_hs_phase_8.mjs stiff_clay_oc bundle', note: 'HS OC clay: |−10| kPa uniform on 10 × 8 m (loading sign — see solver-models.mjs)' }
};
