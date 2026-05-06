// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stage 6 — Pile Estimator: De Beer base resistance, CPT-based shaft
// resistance, ULS factor chain, F_nk screening, and SLS settlement via the
// Belgian load-transfer method.
//
// References (cited in pile_estimator.md):
//   [1] BUtgb-UBAtc Informatieblad 2025/3
//   [2] Buildwise Dimensioneringsmethode 20 (2020)
//   [3] Huybrechts et al., Design of piles — Belgian practice (2016)
//   [4] BGGG-GBMS, Reference document for the De Beer method (2002)
//   [5] Allani & Huybrechts, ICSMGE 2022 — Belgian SLS pile method

import {
  effectiveVerticalStressAtDepth,
  totalVerticalStressAtDepth,
  eoedAtStress
} from './stage6-engineering.js';

const GAMMA_W = 9.81;
const D_C = 0.0357;            // standard CPT cone diameter [m]
const DEBEER_DZ = 0.20;        // BGGG sampling step [m]
const PILE_DZ_DEFAULT = 0.20;  // pile-axis discretisation for load-transfer [m]
const Q_C_MIN_FOR_SHAFT = 1.0; // MPa, layers with q_c,m below this are excluded

// =====================================================================
// 1. Public factor tables — reproduced from [3] (publicly cited values)
// =====================================================================

export const PILE_TYPE_KEYS = [
  'driven',
  'screw_displacement',
  'screw_cased',
  'cfa',
  'bored'
];

// Default α_b and α_s by pile type and soil category.
// Values are conservative midpoints for screening; ATG override via state.
// alpha_b applies to base resistance; alpha_s applies to shaft.
//   row: pileType
//   col: 'clay' | 'loam' | 'sandy_clay' | 'sand'
//
// These are the broadly cited default Belgian DM values for screening; for
// production design the user must enter ATG-specific or DM20 values via the
// override block (atgAlphaB / atgAlphaS).
const ALPHA_B_DEFAULT = {
  driven:             { clay: 1.00, loam: 1.00, sandy_clay: 1.00, sand: 1.00 },
  screw_displacement: { clay: 0.80, loam: 0.90, sandy_clay: 0.90, sand: 0.90 },
  screw_cased:        { clay: 0.70, loam: 0.80, sandy_clay: 0.80, sand: 0.80 },
  cfa:                { clay: 0.50, loam: 0.55, sandy_clay: 0.60, sand: 0.60 },
  bored:              { clay: 0.50, loam: 0.55, sandy_clay: 0.60, sand: 0.60 }
};

const ALPHA_S_DEFAULT = {
  driven:             { clay: 1.00, loam: 1.00, sandy_clay: 1.00, sand: 1.00 },
  screw_displacement: { clay: 0.90, loam: 0.90, sandy_clay: 0.90, sand: 0.90 },
  screw_cased:        { clay: 0.80, loam: 0.80, sandy_clay: 0.80, sand: 0.80 },
  cfa:                { clay: 0.60, loam: 0.65, sandy_clay: 0.70, sand: 0.70 },
  bored:              { clay: 0.50, loam: 0.55, sandy_clay: 0.60, sand: 0.60 }
};

// γ_Rd table — public values from [3] §A.2
//   row: pileType; col: sltCondition ('none','comparable','jobsite')
const GAMMA_RD_TABLE = {
  driven:             { none: 1.00, comparable: 1.00, jobsite: 1.00 },
  screw_displacement: { none: 1.30, comparable: 1.10, jobsite: 1.00 },
  screw_cased:        { none: 1.30, comparable: 1.10, jobsite: 1.00 },
  cfa:                { none: 1.35, comparable: 1.20, jobsite: 1.10 },
  bored:              { none: 1.20, comparable: 1.20, jobsite: 1.10 }
};

// γ_b and γ_s — public values from [3] §A.4
const GAMMA_B_NO_QA = {
  driven: 1.00, screw_displacement: 1.07, screw_cased: 1.07,
  cfa: 1.10, bored: 1.20
};
const GAMMA_S_NO_QA = {
  driven: 1.00, screw_displacement: 1.00, screw_cased: 1.00,
  cfa: 1.00, bored: 1.00
};
const GAMMA_B_QA = {
  driven: 1.00, screw_displacement: 1.00, screw_cased: 1.00,
  cfa: 1.00, bored: 1.00
};
const GAMMA_S_QA = {
  driven: 1.00, screw_displacement: 1.00, screw_cased: 1.00,
  cfa: 1.00, bored: 1.00
};

// ξ_3 and ξ_4 — public values from [3] §A.3
//   row: nPiles ('1-3','4-10','>10'); col: cptDensity
const XI_DENSITIES = ['1/10m2', '1/50m2', '1/100m2', '1/300m2', '1/1000m2'];
const XI3_TABLE = {
  '1-3':  [1.25, 1.29, 1.32, 1.36, 1.40],
  '4-10': [1.15, 1.19, 1.21, 1.25, 1.29],
  '>10':  [1.14, 1.17, 1.20, 1.24, 1.27]
};
const XI4_TABLE = {
  '1-3':  [1.08, 1.17, 1.23, 1.31, 1.40],
  '4-10': [1.00, 1.07, 1.13, 1.21, 1.29],
  '>10':  [1.00, 1.06, 1.12, 1.20, 1.27]
};

// Mechanical-cone reduction ω from [3]
const OMEGA_TABLE = {
  M1: { tertiary_clay: 1.30, other: 1.00 },
  M2: { tertiary_clay: 1.30, other: 1.00 },
  M4: { tertiary_clay: 1.15, other: 1.00 }
};

// Default M_s (× 10⁻³) and M_b (dimensionless) midpoints from [5]
const MS_TABLE_E3 = {
  driven:             { sand: 9,  mixed: 4,   clay: 1.5 },
  screw_displacement: { sand: 9,  mixed: 4.5, clay: 3   },
  screw_cased:        { sand: 9,  mixed: 4.5, clay: 3   },
  cfa:                { sand: 21, mixed: 9,   clay: 3.5 },
  bored:              { sand: 21, mixed: 9,   clay: 3.5 }
};

const MB_TABLE = {
  driven:             { sand: 32, mixed: 7.5, clay: 110 },
  screw_displacement: { sand: 17, mixed: 7.5, clay: 50  },
  screw_cased:        { sand: 17, mixed: 7.5, clay: 50  },
  cfa:                { sand: 3.5, mixed: 3.5, clay: 3.5 },
  bored:              { sand: 3.5, mixed: 3.5, clay: 3.5 }
};

// Default pile axial-stiffness modulus by material [GPa]
const EP_BY_MATERIAL = {
  concrete: 30,
  steel: 210,
  timber: 12
};

// =====================================================================
// 2. Soil-type mapping (Stage 3 NEN6740 → Belgian η*_p category)
// =====================================================================

// Returns one of: 'clay' | 'loam' | 'sandy_clay' | 'sand' | 'excluded'
export function mapLayerToBelgianCategory(layer) {
  if (!layer) return 'sand';
  const type = String(layer.type || '').toLowerCase();
  const subtype = String(layer.subtype || '').toLowerCase();

  if (type.includes('peat') || type.includes('organic') || subtype.includes('veen')) {
    return 'excluded';
  }
  // Explicit loam markers (Dutch 'leem') take precedence over the broader type.
  if (subtype.includes('leem') || type.includes('loam') || type.includes('silt')) {
    return 'loam';
  }
  // Compound types — sandy clay / clayey sand families.
  if (type.includes('sandy clay') || type.includes('clayey')) return 'sandy_clay';
  // Pure sand and pure clay.
  if (type.includes('sand')) return 'sand';
  if (type.includes('clay')) return 'clay';

  // Fallback by friction-ratio heuristic mirroring the Rf indicator in [3].
  const rf = Number(layer.avgRf);
  if (Number.isFinite(rf)) {
    if (rf < 1) return 'sand';
    if (rf < 2) return 'sandy_clay';
    if (rf < 3) return 'loam';
    return 'clay';
  }
  return 'sand';
}

// Group used by M_s / M_b tables: sand / mixed / clay.
function categoryToMsGroup(category) {
  if (category === 'sand') return 'sand';
  if (category === 'clay' || category === 'excluded') return 'clay';
  return 'mixed';
}

// =====================================================================
// 3. η*_p table — exact values from [3] §A.1
// =====================================================================

export function unitShaftFriction(category, qcMpa) {
  const qc = Math.max(qcMpa, 0);
  if (qc < Q_C_MIN_FOR_SHAFT) return { qs: 0, etaP: 0, branch: 'excluded' };
  switch (category) {
    case 'clay': {
      if (qc <= 4.5) return { qs: 1000 * (1 / 30) * qc, etaP: 1 / 30, branch: 'eta' };
      return { qs: 150, etaP: null, branch: 'cap' };
    }
    case 'loam': {
      if (qc <= 6) return { qs: 1000 * (1 / 60) * qc, etaP: 1 / 60, branch: 'eta' };
      return { qs: 100, etaP: null, branch: 'cap' };
    }
    case 'sandy_clay': {
      if (qc <= 10) return { qs: 1000 * (1 / 80) * qc, etaP: 1 / 80, branch: 'eta' };
      return { qs: 125, etaP: null, branch: 'cap' };
    }
    case 'sand': {
      if (qc <= 10) return { qs: 1000 * (1 / 90) * qc, etaP: 1 / 90, branch: 'eta' };
      if (qc <= 20) return { qs: 110 + 4 * (qc - 10), etaP: null, branch: 'linear' };
      return { qs: 150, etaP: null, branch: 'cap' };
    }
    default:
      return { qs: 0, etaP: 0, branch: 'excluded' };
  }
}

// =====================================================================
// 4. Pile geometry helpers
// =====================================================================

export function pileGeometry(cfg) {
  const shape = cfg.shape || 'circular';
  const Ds = positive(cfg.Ds, 0.40);
  const DbInput = positive(cfg.Db, Ds);
  const Db = Math.max(DbInput, Ds);
  let A_b;
  let D_b_eq;
  let chi_s;
  if (shape === 'circular') {
    A_b = Math.PI * Db * Db / 4;
    D_b_eq = Db;
    chi_s = Math.PI * Ds;
  } else if (shape === 'square') {
    const a = positive(cfg.a, Ds);
    A_b = a * a;
    D_b_eq = Math.sqrt(4 * a * a / Math.PI);
    chi_s = 4 * a;
  } else {
    // rectangular
    const a = positive(cfg.a, Ds);
    const bRaw = positive(cfg.b, a);
    const b = Math.max(a, bRaw);
    A_b = a * b;
    if (b <= 1.5 * a) D_b_eq = Math.sqrt(4 * a * b / Math.PI);
    else D_b_eq = Math.sqrt(6 * a * a / Math.PI);
    chi_s = 2 * (a + b);
  }
  // A_p — pile axial cross-section (used for elastic compression)
  let A_p = positive(cfg.Ap, NaN);
  if (!Number.isFinite(A_p) || A_p <= 0) {
    if (shape === 'circular') A_p = Math.PI * Ds * Ds / 4;
    else if (shape === 'square') A_p = positive(cfg.a, Ds) ** 2;
    else A_p = positive(cfg.a, Ds) * Math.max(positive(cfg.b, cfg.a), positive(cfg.a, Ds));
  }
  return { shape, Ds, Db, A_b, D_b_eq, chi_s, A_p };
}

// β shape factor for base resistance, per [3] §3.5.3
export function shapeFactorBeta(cfg) {
  const shape = cfg.shape || 'circular';
  if (shape === 'circular' || shape === 'square') return 1.0;
  if (shape === 'rectangular') {
    const a = positive(cfg.a, 0.4);
    const b = Math.max(positive(cfg.b, a), a);
    return (1 + 0.3 * (a / b)) / 1.3;
  }
  return 1.0;
}

// e_b factor for tertiary OC clay only; identity elsewhere.
export function ebFactor(layerAtToe, D_b_eq) {
  if (!layerAtToe) return 1.0;
  const subtype = String(layerAtToe.subtype || '').toLowerCase();
  const type = String(layerAtToe.type || '').toLowerCase();
  const isTertiaryClay = type.includes('clay')
    && (subtype.includes('tertiair') || subtype.includes('tertiary')
        || subtype.includes('boom') || subtype.includes('ypres'));
  if (!isTertiaryClay) return 1.0;
  const ratio = D_b_eq / D_C;
  return Math.max(0.476, 1 - 0.01 * (ratio - 1));
}

// λ relaxation factor — non-relaxing default 1.0; relaxing requires override.
// Detect "relaxing enlarged base" when D_b > D_s + 0.05 m and pile is prefab
// (driven). User can supply a manual override via cfg.lambdaOverride.
export function lambdaFactor(cfg) {
  const Ds = positive(cfg.Ds, 0.40);
  const Db = positive(cfg.Db, Ds);
  const isRelaxing = (cfg.pileType === 'driven') && (Db > Ds + 0.05);
  const override = positive(cfg.lambdaOverride, NaN);
  if (Number.isFinite(override) && override > 0 && override <= 1.0) {
    return { lambda: override, isRelaxing, source: 'override' };
  }
  return { lambda: 1.0, isRelaxing, source: 'default' };
}

// =====================================================================
// 5. CPT preprocessing — mechanical-cone correction + 0.20 m resampling
// =====================================================================

// Apply ω(coneType, soilType) per [3]. cptRaw is array of {z, qc} with qc in MPa.
// `layers` provides soil-type lookup for tertiary-clay detection.
export function applyMechanicalCone(cptRaw, layers, mechanicalCone, coneType) {
  if (!Array.isArray(cptRaw) || !cptRaw.length) return [];
  if (!mechanicalCone) return cptRaw.map((p) => ({ ...p }));
  const omega = OMEGA_TABLE[coneType] || OMEGA_TABLE.M1;
  return cptRaw.map((p) => {
    const layer = findLayerAt(layers, p.z);
    const isTertiary = layer
      && String(layer.type || '').toLowerCase().includes('clay')
      && (
        String(layer.subtype || '').toLowerCase().includes('tertiair')
        || String(layer.subtype || '').toLowerCase().includes('tertiary')
        || String(layer.subtype || '').toLowerCase().includes('boom')
        || String(layer.subtype || '').toLowerCase().includes('ypres')
      );
    const w = isTertiary ? omega.tertiary_clay : omega.other;
    const qcDiv = w > 0 ? w : 1;
    return { z: p.z, qc: p.qc / qcDiv };
  });
}

// Resample {z, qc in MPa} to 0.20 m bins by averaging.
// Returns { profile:[{z, qc}], dz, zMin, zMax }.
export function resampleQc(cptRaw, dz = DEBEER_DZ) {
  const arr = Array.isArray(cptRaw) ? cptRaw.filter((p) => Number.isFinite(p?.z) && Number.isFinite(p?.qc)) : [];
  if (!arr.length) return { profile: [], dz, zMin: 0, zMax: 0 };
  const zMin = arr[0].z;
  const zMax = arr[arr.length - 1].z;
  const nBins = Math.max(1, Math.round((zMax - zMin) / dz));
  const sums = new Float64Array(nBins);
  const counts = new Int32Array(nBins);
  for (let i = 0; i < arr.length; i += 1) {
    const idx = Math.min(nBins - 1, Math.max(0, Math.floor((arr[i].z - zMin) / dz)));
    sums[idx] += arr[i].qc;
    counts[idx] += 1;
  }
  const profile = [];
  let lastVal = null;
  for (let i = 0; i < nBins; i += 1) {
    const z = zMin + (i + 0.5) * dz;
    let qc;
    if (counts[i] > 0) {
      qc = sums[i] / counts[i];
      lastVal = qc;
    } else {
      // interpolate by carry-forward; refine with neighbour scan below
      qc = lastVal != null ? lastVal : 0;
    }
    profile.push({ z, qc });
  }
  // Backward fill any leading empty bins from the first non-empty bin.
  let firstNonEmpty = profile.findIndex((p, i) => counts[i] > 0);
  if (firstNonEmpty > 0) {
    const fill = profile[firstNonEmpty].qc;
    for (let i = 0; i < firstNonEmpty; i += 1) profile[i].qc = fill;
  }
  return { profile, dz, zMin, zMax };
}

// =====================================================================
// 6. De Beer transformation — four stages
// =====================================================================

// Returns the full transformation chain plus q_b at z_toe.
// `qcResampled` is an array of {z, qc(MPa)} at uniform 0.20 m spacing.
// `D_b_eq` is the equivalent pile-base diameter [m].
// `layers`, `wtDepth` provide σ'_v(z) for the homogeneous-stage stress
// scaling (currently used for the Δq_max computation in stages 2/3).
//
// Stage 1 (homogeneous q_h) is currently implemented as the identity
// transformation q_h = q_c. The full BGGG [4] homogeneous-conversion
// equations are not in the public source set; the screening-tool note
// makes this explicit. The diameter scale-effect is applied through the
// gradient limits in stages 2 and 3.
//
// Stage 2 (q_d, downward sweep): q_d climbs toward q_h by a fraction
// proportional to (D_c / D_b,eq) per Δz — bigger piles climb more slowly.
//
// Stage 3 (q_u, upward sweep): symmetric — q_u falls toward q_h by the
// same fraction per Δz when going upward.
//
// Stage 4 (q_p): q_p = min(q_d, q_u).
export function deBeerProfile(qcResampled, D_b_eq, layers, wtDepth, opts = {}) {
  const dz = positive(qcResampled?.dz, DEBEER_DZ);
  const profile = qcResampled?.profile || [];
  const n = profile.length;
  const out = {
    qc: [],   // input
    qh: [],   // Stage 1
    qd: [],   // Stage 2
    qu: [],   // Stage 3
    qp: [],   // Stage 4 — final mixed
    dz,
    Dbeq: D_b_eq,
    Dc: D_C
  };
  if (!n || !(D_b_eq > 0)) {
    return { ...out, qbAtToe: () => 0 };
  }
  const ratio = clamp(D_C / D_b_eq, 0.001, 1.0); // climbs by this fraction of the gap per Δz

  // Stage 1 — identity (see method note).
  const qh = new Array(n);
  for (let i = 0; i < n; i += 1) {
    qh[i] = Math.max(0, profile[i].qc);
  }

  // Stage 2 — downward sweep.
  const qd = new Array(n);
  qd[0] = qh[0];
  for (let i = 1; i < n; i += 1) {
    const target = qh[i];
    const prev = qd[i - 1];
    if (target <= prev) {
      // Fall instantly with q_h.
      qd[i] = target;
    } else {
      qd[i] = prev + (target - prev) * ratio;
      if (qd[i] > target) qd[i] = target; // numerical safety
    }
  }

  // Stage 3 — upward sweep.
  const qu = new Array(n);
  qu[n - 1] = qh[n - 1];
  for (let i = n - 2; i >= 0; i -= 1) {
    const target = qh[i];
    const prev = qu[i + 1];
    if (target <= prev) {
      qu[i] = target;
    } else {
      qu[i] = prev + (target - prev) * ratio;
      if (qu[i] > target) qu[i] = target;
    }
  }

  // Stage 4 — mixed.
  const qp = new Array(n);
  for (let i = 0; i < n; i += 1) {
    qp[i] = Math.min(qd[i], qu[i]);
    if (!Number.isFinite(qp[i]) || qp[i] < 0) qp[i] = 0;
  }

  for (let i = 0; i < n; i += 1) {
    const z = profile[i].z;
    out.qc.push({ z, q: profile[i].qc });
    out.qh.push({ z, q: qh[i] });
    out.qd.push({ z, q: qd[i] });
    out.qu.push({ z, q: qu[i] });
    out.qp.push({ z, q: qp[i] });
  }

  // Linear interpolation of q_p at the requested toe depth (in MPa).
  out.qbAtToe = (zToe) => qbAtToeFrom(out.qp, zToe);
  return out;
}

function qbAtToeFrom(qp, zToe) {
  if (!qp || !qp.length) return 0;
  if (zToe <= qp[0].z) return Math.max(0, qp[0].q);
  if (zToe >= qp[qp.length - 1].z) return Math.max(0, qp[qp.length - 1].q);
  // Binary search for the bracket
  let lo = 0;
  let hi = qp.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (qp[mid].z <= zToe) lo = mid;
    else hi = mid;
  }
  const t = (zToe - qp[lo].z) / Math.max(qp[hi].z - qp[lo].z, 1e-9);
  const q = qp[lo].q + (qp[hi].q - qp[lo].q) * t;
  return Math.max(0, q);
}

// =====================================================================
// 7. Per-layer shaft analysis
// =====================================================================

// For each layer intersecting the pile shaft (between zHead and zToe),
// compute the layer-mean q_c, η*_p, q_s, α_s, h, and R_s contribution.
// Layers above the neutral plane (when downdrag is set) are flagged
// `aboveNeutral` and excluded from positive R_s.
export function analyzeShaftLayers({
  layers,
  cptRaw,
  cfg,
  geometry,
  alphaSByCategory,
  neutralPlane
}) {
  const zHead = positive(cfg.zHead, 0);
  const zToe = positive(cfg.zToe, 0);
  if (zToe <= zHead) {
    return { perLayer: [], R_s: 0, aboveNP_R_s_potential: 0 };
  }
  const NPactive = neutralPlane != null && neutralPlane > zHead && neutralPlane < zToe;
  const perLayer = [];
  let R_s = 0;
  let aboveNP_R_s_potential = 0;

  for (let i = 0; i < layers.length; i += 1) {
    const layer = layers[i];
    const top = Math.max(layer.top, zHead);
    const bot = Math.min(layer.bot, zToe);
    if (bot <= top) continue;

    const h = bot - top;
    const category = mapLayerToBelgianCategory(layer);
    const qcm = layerMeanQc(cptRaw, top, bot, layer);
    const friction = unitShaftFriction(category, qcm);
    const alphaS = positive(cfg.atgAlphaS, NaN);
    const alphaSDefault = (ALPHA_S_DEFAULT[cfg.pileType] || ALPHA_S_DEFAULT.driven)[category] ?? 1.0;
    const alphaSEff = (cfg.useAtg && Number.isFinite(alphaS) && alphaS > 0) ? alphaS : alphaSDefault;
    const aboveNeutral = NPactive ? (top + bot) / 2 < neutralPlane : false;
    const excluded = friction.branch === 'excluded' || category === 'excluded';
    const RsContribution = excluded ? 0 : alphaSEff * h * friction.qs * geometry.chi_s;
    perLayer.push({
      layerIndex: i,
      top,
      bot,
      h,
      type: layer.type,
      subtype: layer.subtype,
      category,
      qcMean: qcm,
      etaP: friction.etaP,
      qs: friction.qs,
      branch: friction.branch,
      alphaS: alphaSEff,
      aboveNeutral,
      excluded,
      RsLayer: aboveNeutral ? 0 : RsContribution,
      RsLayerPotential: RsContribution
    });
    if (!excluded) {
      if (aboveNeutral) aboveNP_R_s_potential += RsContribution;
      else R_s += RsContribution;
    }
  }
  if (alphaSByCategory) {
    for (const row of perLayer) alphaSByCategory[row.category] = row.alphaS;
  }
  return { perLayer, R_s, aboveNP_R_s_potential };
}

// Layer-mean q_c in MPa. Prefer raw CPT inside the layer slice; fall back to
// layer.avgQc if no raw data is in the slice.
function layerMeanQc(cptRaw, top, bot, layer) {
  if (Array.isArray(cptRaw) && cptRaw.length) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < cptRaw.length; i += 1) {
      const z = cptRaw[i].z;
      if (z >= top && z <= bot) {
        sum += cptRaw[i].qc;
        count += 1;
      }
    }
    if (count > 0) return sum / count;
  }
  return Number.isFinite(+layer?.avgQc) ? +layer.avgQc : 0;
}

// =====================================================================
// 8. F_nk — slip method and analogy method
// =====================================================================

// Slip method [3]: F_nk = χ_s · Σ h_i · K_0,i · tan(δ_i) · σ'_v,i, with the
// floor K_0·tan(δ) ≥ 0.25.
export function fnkSlipMethod({ layers, cfg, geometry, neutralPlane, wtDepth }) {
  if (!Array.isArray(layers) || !layers.length) return 0;
  const zHead = positive(cfg.zHead, 0);
  const zToe = positive(cfg.zToe, 0);
  if (neutralPlane == null || neutralPlane <= zHead || neutralPlane >= zToe) return 0;
  // δ depends on pile material per [3]
  const deltaFactor = (cfg.pileMaterial === 'concrete' && cfg.pileType !== 'driven')
    ? 1.0
    : 0.75;
  let total = 0;
  for (const layer of layers) {
    const top = Math.max(layer.top, zHead);
    const bot = Math.min(layer.bot, neutralPlane);
    if (bot <= top) continue;
    const h = bot - top;
    const phi = positive(layer.phi, 25) * Math.PI / 180;
    // K_0 = 1 − sin(φ') per [3] §4.3. The only floor specified in [3] is
    // on the product K_0 · tan(δ) ≥ 0.25, applied below.
    const K0 = 1 - Math.sin(phi);
    const delta = phi * deltaFactor;
    const product = Math.max(K0 * Math.tan(delta), 0.25);
    const zMid = (top + bot) / 2;
    const sigmaEff = effectiveVerticalStressAtDepth(layers, zMid, wtDepth).sigmaEff;
    total += geometry.chi_s * h * product * sigmaEff;
  }
  return total;
}

// =====================================================================
// 9. ξ-table lookup (single-CPT branch)
// =====================================================================

export function xiLookup(nPiles, cptDensity) {
  const row = (nPiles in XI3_TABLE) ? nPiles : '1-3';
  const colIdx = Math.max(0, XI_DENSITIES.indexOf(cptDensity));
  return {
    xi3: XI3_TABLE[row][colIdx],
    xi4: XI4_TABLE[row][colIdx],
    governing: Math.max(XI3_TABLE[row][colIdx], XI4_TABLE[row][colIdx]),
    branch: XI3_TABLE[row][colIdx] >= XI4_TABLE[row][colIdx] ? 'xi3' : 'xi4',
    column: XI_DENSITIES[colIdx]
  };
}

// =====================================================================
// 10. ULS factor chain
// =====================================================================

export function gammaRdLookup(pileType, sltCondition) {
  const row = GAMMA_RD_TABLE[pileType] || GAMMA_RD_TABLE.driven;
  const cond = ['none', 'comparable', 'jobsite'].includes(sltCondition) ? sltCondition : 'none';
  return row[cond];
}

export function gammaBSLookup(pileType, qaToggle) {
  const b = qaToggle ? GAMMA_B_QA : GAMMA_B_NO_QA;
  const s = qaToggle ? GAMMA_S_QA : GAMMA_S_NO_QA;
  return {
    gamma_b: b[pileType] ?? 1.0,
    gamma_s: s[pileType] ?? 1.0
  };
}

// =====================================================================
// 11. Settlement — load-transfer method (Belgian SLS, [5])
// =====================================================================

// Hyperbolic shaft transfer function: t(w) = w / (1/k_s + w/t_max)
function tShaft(w, k_s, t_max) {
  if (w <= 0) return 0;
  const denom = 1 / Math.max(k_s, 1e-9) + w / Math.max(t_max, 1e-9);
  return w / denom;
}

// Hyperbolic base transfer function: q(z_b) = z_b / (1/k_b + z_b/q_max)
function qBase(zb, k_b, q_max) {
  if (zb <= 0) return 0;
  const denom = 1 / Math.max(k_b, 1e-9) + zb / Math.max(q_max, 1e-9);
  return zb / denom;
}

// Build per-layer M_s / k_s / t_max using §5.3-5.4 of pile_estimator.md.
function buildShaftSprings({ perLayer, cfg, Ds, R_b, A_b }) {
  const pileType = cfg.pileType || 'driven';
  const msTable = MS_TABLE_E3[pileType] || MS_TABLE_E3.driven;
  const msOverride = positive(cfg.MsOverride, NaN);
  return perLayer.map((row) => {
    const group = categoryToMsGroup(row.category);
    const Ms = Number.isFinite(msOverride) && msOverride > 0
      ? msOverride
      : (msTable[group] || msTable.mixed) * 1e-3;
    const t10 = row.alphaS * row.qs;       // kPa
    const tMax = t10 * (1 + 10 * Ms);      // kPa
    const ks = tMax / Math.max(Ms * Ds, 1e-6); // kN/m³ ≡ kPa/m
    return { ...row, Ms, t10, tMax, ks };
  });
}

function buildBaseSpring({ cfg, layerAtToe, Db, R_b, A_b, layers, wtDepth, qbAtToe }) {
  const pileType = cfg.pileType || 'driven';
  const mbTable = MB_TABLE[pileType] || MB_TABLE.driven;
  const category = mapLayerToBelgianCategory(layerAtToe);
  const group = categoryToMsGroup(category);
  const mbOverride = positive(cfg.MbOverride, NaN);
  const Mb = Number.isFinite(mbOverride) && mbOverride > 0 ? mbOverride : (mbTable[group] || mbTable.mixed);
  // q_b,10% — unit base resistance at ULS (kPa)
  const qb10 = R_b > 0 && A_b > 0 ? R_b / A_b : qbAtToe * 1000; // safety fallback
  const qMax = qb10 * (1 + 4.55 / Math.max(Mb, 1e-6));
  // E_b — soil modulus at the base level at mean SLS stress.
  //
  // Primary path: oedometric modulus from stage6-engineering's Hardening-Soil
  //   stress-dependent law (uses layer.Eoed_ref + m + φ' + c').
  //
  // Fallback (when Eoed_ref is absent or yields an implausible value, e.g. for
  // synthetic layers without Stage-4 parameters): conservative CPT correlation
  //   E_b ≈ α_E · q_c,base · 1000 [kPa]
  // with α_E by category (sand: 3, mixed: 5, clay: 7) — midpoints of widely
  // cited drained-modulus-from-q_c correlations for screening use. The
  // correlation is replaced as soon as Stage 4 supplies Eoed_ref upstream.
  let Eb;
  const ebOverride = positive(cfg.EbOverride, NaN);
  if (Number.isFinite(ebOverride) && ebOverride > 0) {
    Eb = ebOverride;
  } else {
    const sigmaEff0 = effectiveVerticalStressAtDepth(layers, cfg.zToe, wtDepth).sigmaEff;
    const sigmaMean = sigmaEff0 + 0.5 * qb10;
    const fromOedo = eoedAtStress(layerAtToe, sigmaMean);
    const alphaECpt = group === 'sand' ? 3 : group === 'clay' ? 7 : 5;
    const fromCpt = alphaECpt * qbAtToe * 1000; // qbAtToe is in MPa
    // If the oedometric value looks degenerate (< 200 kPa, the lowest value
    // any reasonable soil at SLS pressures would give), fall back to the CPT
    // correlation. Otherwise prefer the oedometric value as it is calibrated
    // against the project's Stage-4 parameters.
    Eb = fromOedo >= 200 ? fromOedo : Math.max(fromCpt, 200);
  }
  // β_b ≈ 0.455 D_b — calibrated coefficient (½(1-ν²) at ν=0.3) per [5]
  const betaB = 0.455 * Db;
  const kb = Eb / Math.max(betaB, 1e-6); // kN/m³
  return { Mb, qb10, qMax, Eb, betaB, kb, category };
}

// Compute pile-head load and head settlement for a trial base settlement.
// Uses an explicit upward FD march:
//   N(L) = q(zb) · A_b
//   N(L-Δz) = N(L) + χ_s · t_i(w_local) · Δz   (axial force grows toward head)
//   w_local += N · Δz / (E_p · A_p)
function solveLoadTransferOnce(zb, springs, baseSpring, geom, cfg, dz) {
  const Ep_kPa = positive(cfg.Ep, 30) * 1e6; // GPa → kPa
  const EA = Ep_kPa * geom.A_p;              // kN
  const chi = geom.chi_s;
  // Discretise from toe upward through each shaft layer.
  // Springs come from analyzeShaftLayers, ordered by layer index (top→bot).
  // To march from toe upward, we walk the array in reverse and split each
  // layer into Δz steps.
  let w = zb;
  let N = qBase(zb, baseSpring.kb, baseSpring.qMax) * geom.A_b;
  const trace = [{ z: cfg.zToe, w, N }];
  for (let li = springs.length - 1; li >= 0; li -= 1) {
    const layer = springs[li];
    if (layer.aboveNeutral) {
      // Above the neutral plane during downdrag: positive friction is excluded,
      // and the negative-friction load is added at the slip-method level. Inside
      // the load-transfer model we treat this slice as inert (no t-z mobilization).
      const h = layer.bot - layer.top;
      const nSeg = Math.max(1, Math.ceil(h / dz));
      const segDz = h / nSeg;
      for (let s = 0; s < nSeg; s += 1) {
        w += N * segDz / EA;
        trace.push({ z: layer.bot - (s + 1) * segDz, w, N });
      }
      continue;
    }
    const h = layer.bot - layer.top;
    const nSeg = Math.max(1, Math.ceil(h / dz));
    const segDz = h / nSeg;
    for (let s = 0; s < nSeg; s += 1) {
      // Sign convention: pile is in compression; head load > toe load. Going
      // UP the pile (toe → head), axial force grows by χ·t·Δz (friction added
      // back) and downward displacement grows by N·Δz/(E_p·A_p) (elastic
      // shortening accumulates toward the head).
      const t = layer.excluded ? 0 : tShaft(w, layer.ks, layer.tMax);
      const dN = chi * t * segDz;
      N = N + dN;
      w += N * segDz / EA;
      trace.push({ z: layer.bot - (s + 1) * segDz, w, N });
    }
  }
  // Above the topmost analyzed layer (between zHead and the first layer top
  // if any — usually 0). Add elastic compression of any "pile head" segment.
  const zTopOfShaft = springs.length ? springs[0].top : cfg.zHead;
  const stickUp = Math.max(0, zTopOfShaft - cfg.zHead);
  if (stickUp > 0) {
    w += N * stickUp / EA;
    trace.push({ z: cfg.zHead, w, N });
  }
  trace.reverse(); // head first
  return { wHead: w, NHead: N, trace };
}

// Outer bisection: find zb such that NHead(zb) = F_rep.
// Always tags the returned object with `zb` so downstream consumers can
// report the actual base settlement, regardless of which exit branch fires.
function solveLoadTransfer({ Frep, springs, baseSpring, geom, cfg, dz }) {
  const target = positive(Frep, 0) * 1; // kN
  if (target <= 0) {
    return { ...solveLoadTransferOnce(0, springs, baseSpring, geom, cfg, dz), zb: 0 };
  }
  const upperZb = Math.max(0.30 * geom.Db, 0.10);
  let zbLo = 0;
  let zbHi = upperZb;
  let resLo = solveLoadTransferOnce(zbLo, springs, baseSpring, geom, cfg, dz);
  let resHi = solveLoadTransferOnce(zbHi, springs, baseSpring, geom, cfg, dz);
  let safety = 0;
  while (resHi.NHead < target && safety < 5) {
    zbHi *= 2;
    resHi = solveLoadTransferOnce(zbHi, springs, baseSpring, geom, cfg, dz);
    safety += 1;
  }
  if (resLo.NHead >= target) return { ...resLo, zb: zbLo };
  if (resHi.NHead < target) return { ...resHi, zb: zbHi };
  for (let it = 0; it < 80; it += 1) {
    const zbMid = 0.5 * (zbLo + zbHi);
    const resMid = solveLoadTransferOnce(zbMid, springs, baseSpring, geom, cfg, dz);
    if (resMid.NHead < target) {
      zbLo = zbMid;
      resLo = resMid;
    } else {
      zbHi = zbMid;
      resHi = resMid;
    }
    if (Math.abs(resMid.NHead - target) < Math.max(1e-3 * target, 0.01)) {
      return { ...resMid, zb: zbMid };
    }
  }
  return { ...resHi, zb: zbHi };
}

// Build the load-settlement curve by sweeping zb from 0 to upper bound.
function buildLoadSettlementCurve({ springs, baseSpring, geom, cfg, dz, Db }) {
  const points = [];
  const zbMax = Math.max(0.10 * Db, 0.05);
  const N = 50;
  for (let i = 0; i <= N; i += 1) {
    const zb = (i / N) * zbMax;
    const r = solveLoadTransferOnce(zb, springs, baseSpring, geom, cfg, dz);
    points.push({ s: r.wHead * 1000, F: r.NHead, zb }); // s in mm, F in kN
  }
  return points;
}

// =====================================================================
// 12. Bundled analysis
// =====================================================================

export function analyzePile(layers, wtDepth, cptRaw, cfgIn) {
  const cfg = normalizeCfg(cfgIn);
  const notes = [];

  if (!Array.isArray(layers) || !layers.length) {
    return emptyResult(cfg, [{ level: 'warn', text: 'No interpreted layers available — run Stages 2–5 first.' }]);
  }

  const geom = pileGeometry(cfg);
  const beta = shapeFactorBeta(cfg);
  const layerAtToe = findLayerAt(layers, cfg.zToe);
  const eb = ebFactor(layerAtToe, geom.D_b_eq);
  const lambdaInfo = lambdaFactor(cfg);

  // CPT preprocessing
  const cptCorrected = applyMechanicalCone(cptRaw, layers, cfg.mechanicalCone, cfg.coneType);
  if (cfg.mechanicalCone) {
    notes.push({ level: 'info', text: `Mechanical-cone correction applied (cone ${cfg.coneType}; ω from [3]).` });
  }
  const resampled = resampleQc(cptCorrected, DEBEER_DZ);
  if (resampled.profile.length === 0) {
    return emptyResult(cfg, [{ level: 'warn', text: 'Raw CPT data empty after preprocessing.' }]);
  }
  notes.push({
    level: 'info',
    text: `De Beer profile resampled from ${cptRaw?.length || 0} raw points to ${resampled.profile.length} bins of ${DEBEER_DZ.toFixed(2)} m.`
  });

  // De Beer transformation
  const deBeer = deBeerProfile(resampled, geom.D_b_eq, layers, wtDepth);
  const qbAtToeMpa = deBeer.qbAtToe(cfg.zToe);
  const qb_kPa = qbAtToeMpa * 1000;

  notes.push({
    level: 'info',
    text: 'De Beer Stage 1 (homogeneous values) implemented as q_h = q_c (identity); the diameter scale-effect is applied through the gradient limits in Stages 2 and 3. The full BGGG [4] homogeneous-conversion equations are not in the public source set.'
  });

  // R_b
  const alphaBOverride = positive(cfg.atgAlphaB, NaN);
  const alphaBDefault = (ALPHA_B_DEFAULT[cfg.pileType] || ALPHA_B_DEFAULT.driven)[mapLayerToBelgianCategory(layerAtToe)] ?? 1.0;
  const alphaB = (cfg.useAtg && Number.isFinite(alphaBOverride) && alphaBOverride > 0) ? alphaBOverride : alphaBDefault;
  const R_b = alphaB * eb * beta * lambdaInfo.lambda * geom.A_b * qb_kPa;

  if (lambdaInfo.isRelaxing && lambdaInfo.source === 'default') {
    notes.push({
      level: 'warn',
      text: 'Relaxing enlarged base detected (D_b > D_s + 0.05 m on a driven pile). λ defaulted to 1.00, which is non-conservative until verified against DM20. Enter a manual override.'
    });
  }
  if (eb < 1.0) {
    notes.push({ level: 'info', text: `Tertiary OC clay detected at base; e_b = ${eb.toFixed(3)} applied per [3].` });
  }

  // Per-layer shaft analysis
  const NPdepth = (cfg.downdrag !== 'none' && Number.isFinite(+cfg.neutralPlane)) ? +cfg.neutralPlane : null;
  const shaft = analyzeShaftLayers({
    layers,
    cptRaw: cptCorrected,
    cfg,
    geometry: geom,
    alphaSByCategory: {},
    neutralPlane: NPdepth
  });
  for (const row of shaft.perLayer) {
    if (row.excluded && row.qcMean < Q_C_MIN_FOR_SHAFT && row.category !== 'excluded') {
      notes.push({
        level: 'info',
        text: `Layer ${row.layerIndex + 1} excluded from shaft friction (layer-mean q_c = ${row.qcMean.toFixed(2)} MPa < ${Q_C_MIN_FOR_SHAFT} MPa).`
      });
    }
  }
  const R_s = shaft.R_s;
  const R_c = R_b + R_s;

  // γ_Rd, ξ, γ_b, γ_s
  const gammaRdOverride = positive(cfg.atgGammaRd, NaN);
  const gammaRd = (cfg.useAtg && Number.isFinite(gammaRdOverride) && gammaRdOverride > 0)
    ? gammaRdOverride
    : gammaRdLookup(cfg.pileType, cfg.sltCondition);
  const R_c_cal = R_c / Math.max(gammaRd, 1e-6);
  const xi = xiLookup(cfg.nPiles, cfg.cptDensity);
  const R_c_k = R_c_cal / Math.max(xi.governing, 1e-6);
  const RbShare = R_c > 0 ? R_b / R_c : 0;
  const RsShare = R_c > 0 ? R_s / R_c : 0;
  const R_b_k = R_c_k * RbShare;
  const R_s_k = R_c_k * RsShare;
  const gammaBS = gammaBSLookup(cfg.pileType, cfg.qaToggle);
  const gammaBOverride = positive(cfg.atgGammaB, NaN);
  const gamma_b = (cfg.useAtg && Number.isFinite(gammaBOverride) && gammaBOverride > 0) ? gammaBOverride : gammaBS.gamma_b;
  const gamma_s = gammaBS.gamma_s;
  const R_c_d = R_b_k / gamma_b + R_s_k / gamma_s;

  // F_nk
  let F_nk_slip = 0;
  let F_nk_analogy = 0;
  let F_nk_design = 0;
  if (NPdepth != null) {
    F_nk_slip = fnkSlipMethod({ layers, cfg, geometry: geom, neutralPlane: NPdepth, wtDepth });
    F_nk_analogy = shaft.aboveNP_R_s_potential;
    let F_nk_rep = Math.max(F_nk_slip, F_nk_analogy);
    if (cfg.downdrag === 'moderate') F_nk_rep *= 0.5;
    // γ_F = 1.0 per [3]
    F_nk_design = F_nk_rep * 1.0;
    notes.push({
      level: 'info',
      text: `F_nk: slip = ${F_nk_slip.toFixed(0)} kN, analogy = ${F_nk_analogy.toFixed(0)} kN. Design F_nk,d = ${F_nk_design.toFixed(0)} kN (${cfg.downdrag === 'moderate' ? 'half applied per 4–10 cm rule' : 'full per >10 cm rule'}).`
    });
  }

  // Build resolved load values
  const FcdInput = positive(cfg.Fcd, 0);
  const FrepInput = positive(cfg.Frep, 0);

  // ULS check — worst of (Fcd transient combination) vs (permanent + F_nk,d)
  // Without explicit Gk/Qk split we treat Fcd as the transient combination
  // and F_nk-permanent as Gk_perPile + F_nk,d. If Gk_perPile is given, use it.
  const GkPerPile = positive(cfg.GkPerPile, NaN);
  const downdragCombination = Number.isFinite(GkPerPile) && GkPerPile > 0
    ? (1.35 * GkPerPile + F_nk_design)
    : (FcdInput * 0.7 + F_nk_design); // 0.7 ≈ G/F_total share; conservative fallback
  const ulsLoad = Math.max(FcdInput, downdragCombination);
  const ulsUtil = R_c_d > 0 ? ulsLoad / R_c_d : Infinity;

  // SLS — load-transfer settlement
  let settlement = null;
  try {
    settlement = computeSettlement({
      Frep: FrepInput,
      perLayer: shaft.perLayer,
      cfg,
      geom,
      Ds: geom.Ds,
      Db: geom.Db,
      R_b,
      A_b: geom.A_b,
      layerAtToe,
      layers,
      wtDepth,
      qbAtToe: qbAtToeMpa
    });
  } catch (err) {
    notes.push({ level: 'warn', text: `Settlement solver failed: ${err.message || err}.` });
  }

  // Cumulative warns
  if (cfg.zToe > (resampled.zMax || 0) + 0.10) {
    notes.push({
      level: 'warn',
      text: `Pile toe (${cfg.zToe.toFixed(2)} m) is below the deepest CPT reading (${resampled.zMax.toFixed(2)} m); De Beer is extrapolated.`
    });
  }
  if (qb_kPa < 5000) {
    notes.push({
      level: 'warn',
      text: `q_b at toe is low (${qb_kPa.toFixed(0)} kPa < 5 MPa) — verify the toe-level choice.`
    });
  }
  if (cfg.settlementMethod === 'typical-curve' && (cfg.zToe - cfg.zHead) > 15) {
    notes.push({
      level: 'warn',
      text: 'Simplified typical-curve method may not suit piles longer than 15 m. Use the load-transfer method instead.'
    });
  }

  return {
    capacity: {
      deBeer,
      qbAtToe_MPa: qbAtToeMpa,
      qb_kPa,
      alphaB,
      eb,
      beta,
      lambda: lambdaInfo.lambda,
      lambdaIsRelaxing: lambdaInfo.isRelaxing,
      lambdaSource: lambdaInfo.source,
      A_b: geom.A_b,
      A_p: geom.A_p,
      Dbeq: geom.D_b_eq,
      chi_s: geom.chi_s,
      Ds: geom.Ds,
      Db: geom.Db,
      shape: geom.shape,
      R_b,
      R_s,
      R_c,
      gammaRd,
      R_c_cal,
      xi,
      R_c_k,
      RbShare,
      RsShare,
      R_b_k,
      R_s_k,
      gamma_b,
      gamma_s,
      R_c_d,
      perLayer: shaft.perLayer,
      F_nk_slip,
      F_nk_analogy,
      F_nk_design,
      ulsLoad,
      ulsUtil,
      Fcd: FcdInput,
      Frep: FrepInput,
      neutralPlane: NPdepth,
      categoryAtToe: mapLayerToBelgianCategory(layerAtToe)
    },
    settlement,
    notes
  };
}

function computeSettlement({
  Frep, perLayer, cfg, geom, Ds, Db, R_b, A_b, layerAtToe, layers, wtDepth, qbAtToe
}) {
  if (!perLayer.length || !(Frep > 0)) {
    return {
      method: cfg.settlementMethod,
      sHead_mm: 0,
      zb_m: 0,
      springs: [],
      baseSpring: null,
      curve: [],
      trace: [],
      slsUtil: 0
    };
  }
  const springs = buildShaftSprings({ perLayer, cfg, Ds, R_b, A_b });
  const baseSpring = buildBaseSpring({
    cfg, layerAtToe, Db, R_b, A_b, layers, wtDepth, qbAtToe
  });
  const dz = Math.min(PILE_DZ_DEFAULT, Math.max((cfg.zToe - cfg.zHead) / 50, 0.05));
  const solved = solveLoadTransfer({ Frep, springs, baseSpring, geom, cfg, dz });
  const curve = buildLoadSettlementCurve({ springs, baseSpring, geom, cfg, dz, Db });
  const sHead_mm = solved.wHead * 1000;
  const slsUtil = positive(cfg.sAllowable, 10) > 0 ? sHead_mm / cfg.sAllowable : 0;
  return {
    method: cfg.settlementMethod,
    sHead_mm,
    zb_m: solved.zb || 0,
    NHead_kN: solved.NHead,
    springs,
    baseSpring,
    curve,
    trace: solved.trace || [],
    slsUtil
  };
}

// =====================================================================
// 13. Helpers
// =====================================================================

function normalizeCfg(cfg) {
  const c = { ...(cfg || {}) };
  if (!PILE_TYPE_KEYS.includes(c.pileType)) c.pileType = 'driven';
  if (!['circular', 'square', 'rectangular'].includes(c.shape)) c.shape = 'circular';
  if (!['none', 'comparable', 'jobsite'].includes(c.sltCondition)) c.sltCondition = 'none';
  if (!['1-3', '4-10', '>10'].includes(c.nPiles)) c.nPiles = '1-3';
  if (!XI_DENSITIES.includes(c.cptDensity)) c.cptDensity = '1/100m2';
  if (!['M1', 'M2', 'M4'].includes(c.coneType)) c.coneType = 'M1';
  if (!['none', 'moderate', 'severe'].includes(c.downdrag)) c.downdrag = 'none';
  if (!['concrete', 'steel', 'timber'].includes(c.pileMaterial)) c.pileMaterial = 'concrete';
  if (!['transfer', 'typical-curve'].includes(c.settlementMethod)) c.settlementMethod = 'transfer';

  c.Ds = positive(c.Ds, 0.40);
  c.Db = Math.max(positive(c.Db, c.Ds), c.Ds);
  c.zHead = Math.max(positive(c.zHead, 0), 0);
  c.zToe = Math.max(positive(c.zToe, 10), c.zHead + 0.5);
  c.Fcd = Math.max(positive(c.Fcd, 0), 0);
  c.Frep = Math.max(positive(c.Frep, 0), 0);
  c.sAllowable = Math.max(positive(c.sAllowable, 10), 0.1);
  c.qaToggle = !!c.qaToggle;
  c.useAtg = !!c.useAtg;
  c.mechanicalCone = !!c.mechanicalCone;
  c.Ep = positive(c.Ep, EP_BY_MATERIAL[c.pileMaterial] || 30);
  return c;
}

function emptyResult(cfg, notes) {
  return {
    capacity: {
      R_b: 0, R_s: 0, R_c: 0, R_c_cal: 0, R_c_k: 0, R_c_d: 0,
      perLayer: [],
      qb_kPa: 0,
      qbAtToe_MPa: 0,
      deBeer: { qc: [], qh: [], qd: [], qu: [], qp: [], dz: DEBEER_DZ, qbAtToe: () => 0 },
      F_nk_slip: 0, F_nk_analogy: 0, F_nk_design: 0,
      ulsLoad: cfg?.Fcd || 0,
      ulsUtil: 0,
      Fcd: cfg?.Fcd || 0,
      Frep: cfg?.Frep || 0,
      neutralPlane: null,
      A_b: 0, A_p: 0, chi_s: 0, Ds: cfg?.Ds || 0.4, Db: cfg?.Db || 0.4,
      Dbeq: cfg?.Db || 0.4, shape: cfg?.shape || 'circular',
      alphaB: 0, eb: 1, beta: 1, lambda: 1, gammaRd: 1, gamma_b: 1, gamma_s: 1,
      RbShare: 0, RsShare: 0, R_b_k: 0, R_s_k: 0,
      xi: { xi3: 1.40, xi4: 1.40, governing: 1.40, branch: 'xi3', column: '1/100m2' },
      categoryAtToe: 'sand'
    },
    settlement: null,
    notes: notes || []
  };
}

export function findLayerAt(layers, depth) {
  if (!Array.isArray(layers) || !layers.length) return null;
  for (const l of layers) {
    if (depth >= l.top && depth < l.bot) return l;
  }
  return layers[layers.length - 1];
}

function positive(v, fallback) {
  const n = +v;
  return Number.isFinite(n) && n > 0 ? n : (Number.isFinite(+fallback) ? +fallback : 0);
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}

// =====================================================================
// Re-exports for the renderer / canvas
// =====================================================================

export const PILE_CONSTANTS = {
  D_C,
  DEBEER_DZ,
  PILE_DZ_DEFAULT,
  Q_C_MIN_FOR_SHAFT,
  XI_DENSITIES,
  EP_BY_MATERIAL,
  ALPHA_B_DEFAULT,
  ALPHA_S_DEFAULT,
  GAMMA_RD_TABLE,
  GAMMA_B_NO_QA,
  GAMMA_S_NO_QA,
  GAMMA_B_QA,
  GAMMA_S_QA,
  XI3_TABLE,
  XI4_TABLE,
  OMEGA_TABLE,
  MS_TABLE_E3,
  MB_TABLE,
  PILE_TYPE_KEYS
};
