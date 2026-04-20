// @ts-nocheck
const GAMMA_W = 9.81;
const P_REF = 100;
const TWO_PI = 2 * Math.PI;

export const PSI_FACTORS = {
  A: { psi0: 0.7, psi1: 0.5, psi2: 0.3, label: 'Residential / domestic' },
  B: { psi0: 0.7, psi1: 0.5, psi2: 0.3, label: 'Office areas' },
  C: { psi0: 0.7, psi1: 0.7, psi2: 0.6, label: 'Congregation areas' },
  D: { psi0: 0.7, psi1: 0.7, psi2: 0.6, label: 'Shopping areas' },
  E: { psi0: 1.0, psi1: 0.9, psi2: 0.8, label: 'Storage areas' },
  W: { psi0: 0.6, psi1: 0.2, psi2: 0.0, label: 'Wind' },
  S: { psi0: 0.5, psi1: 0.2, psi2: 0.0, label: 'Snow' },
  T: { psi0: 0.6, psi1: 0.5, psi2: 0.0, label: 'Temperature' }
};

export const EC2_EXPOSURE_META = {
  X0: {
    label: 'No corrosion risk',
    hint: 'Use only where there is no corrosion risk, no freeze-thaw risk, and no aggressive chemical or abrasion exposure.'
  },
  XC1: {
    label: 'Dry or permanently wet',
    hint: 'Carbonation exposure for dry interiors or concrete that stays permanently wet.'
  },
  XC2: {
    label: 'Wet, rarely dry',
    hint: 'Carbonation exposure for foundations and buried concrete that stay wet for long periods, for example below the water table.'
  },
  XC3: {
    label: 'Moderate humidity',
    hint: 'Carbonation exposure for sheltered external concrete or interiors with moderate humidity.'
  },
  XC4: {
    label: 'Cyclic wet and dry',
    hint: 'Carbonation exposure for concrete above the water table or in splash zones with repeated wet-dry cycles.'
  },
  XD1: {
    label: 'Chlorides, moderate humidity',
    hint: 'Chloride exposure from non-marine sources under moderate humidity.'
  },
  XD2: {
    label: 'Chlorides, wet rarely dry',
    hint: 'Chloride exposure from non-marine sources where the concrete stays wet for long periods.'
  },
  XD3: {
    label: 'Chlorides, cyclic wet and dry',
    hint: 'Severe non-marine chloride exposure with repeated wetting and drying.'
  },
  XS1: {
    label: 'Sea-salt air',
    hint: 'Marine chloride exposure from airborne salt without direct sea-water contact.'
  },
  XS2: {
    label: 'Permanently submerged in sea water',
    hint: 'Marine chloride exposure for concrete permanently submerged in sea water.'
  },
  XS3: {
    label: 'Tidal / splash / spray',
    hint: 'Severe marine chloride exposure in tidal, splash, or spray zones.'
  },
  XF1: {
    label: 'Freeze-thaw, moderate saturation',
    hint: 'Freeze-thaw exposure with moderate water saturation and no de-icing agent.'
  },
  XF2: {
    label: 'Freeze-thaw with de-icing agent',
    hint: 'Freeze-thaw exposure with moderate water saturation and de-icing salts.'
  },
  XF3: {
    label: 'Freeze-thaw, high saturation',
    hint: 'Freeze-thaw exposure with high water saturation and no de-icing agent.'
  },
  XF4: {
    label: 'Freeze-thaw, severe',
    hint: 'Freeze-thaw exposure with high water saturation and de-icing salts or sea water.'
  },
  XA1: {
    label: 'Slight chemical attack',
    hint: 'Slightly aggressive chemical environment. Concrete composition still needs EN 206 durability checks.'
  },
  XA2: {
    label: 'Moderate chemical attack',
    hint: 'Moderately aggressive chemical environment. Concrete composition still needs EN 206 durability checks.'
  },
  XA3: {
    label: 'Severe chemical attack',
    hint: 'Highly aggressive chemical environment. Concrete composition still needs EN 206 durability checks.'
  }
};

const EC2_TABLE_44N = [
  [10, 10, 10, 15, 20, 25, 30],
  [10, 10, 15, 20, 25, 30, 35],
  [10, 10, 20, 25, 30, 35, 40],
  [10, 15, 25, 30, 35, 40, 45],
  [15, 20, 30, 35, 40, 45, 50],
  [20, 25, 35, 40, 45, 50, 55]
];

const EC2_EXPOSURE_COLUMNS = {
  X0: 0,
  XC1: 1,
  XC2: 2,
  XC3: 2,
  XC4: 3,
  XD1: 4,
  XS1: 4,
  XD2: 5,
  XS2: 5,
  XD3: 6,
  XS3: 6
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function positive(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function safeLogRatio(outer, inner) {
  return Math.log(Math.max(outer, inner + 1e-6) / Math.max(inner, 1e-6));
}

function layerThickness(layer) {
  return Math.max((layer.bot ?? 0) - (layer.top ?? 0), 0);
}

function isFineGrained(layer) {
  return ['Clay', 'Soft clay', 'Sandy clay', 'Peat / organic'].includes(layer.type);
}

function ec2FallbackCorrosionExposure(exposureClass = 'XC2') {
  const mapping = {
    XF1: 'XC4',
    XF2: 'XC4',
    XF3: 'XC4',
    XF4: 'XD3',
    XA1: 'XC4',
    XA2: 'XC4',
    XA3: 'XD3'
  };
  return mapping[exposureClass] || null;
}

function ec2ConcreteStrengthThreshold(exposureClass = 'XC2') {
  const thresholds = {
    X0: 30,
    XC1: 30,
    XC2: 35,
    XC3: 35,
    XC4: 40,
    XD1: 40,
    XS1: 40,
    XD2: 40,
    XS2: 40,
    XD3: 45,
    XS3: 45,
    XF1: 35,
    XF2: 35,
    XF3: 40,
    XF4: 40,
    XA1: 35,
    XA2: 40,
    XA3: 45
  };
  return thresholds[exposureClass] ?? 35;
}

function ec2StructuralClass(config = {}) {
  if (config.structuralClassOverride != null && config.structuralClassOverride !== '') {
    return {
      value: clamp(Math.round(positive(config.structuralClassOverride, 4)), 1, 6),
      threshold: ec2ConcreteStrengthThreshold(config.exposureClass || 'XC2'),
      autoHighStrength: false,
      reductions: ['Manual structural class override applied.']
    };
  }
  const exposureClass = config.exposureClass || 'XC2';
  const fck = positive(config.fck, 30);
  const threshold = ec2ConcreteStrengthThreshold(exposureClass);
  const autoHighStrength = fck >= threshold;
  const reductions = [];
  let value = 4;
  const designLifeYears = Math.round(positive(config.designLifeYears, 50));
  if (designLifeYears >= 100) {
    value += 2;
    reductions.push('100-year design working life gives +2 structural classes.');
  } else if (designLifeYears <= 25) {
    value -= 1;
    reductions.push('Design working life up to 25 years gives -1 structural class.');
  }
  if (autoHighStrength) {
    value -= 1;
    reductions.push(`fck = ${fck.toFixed(0)} MPa meets the EC2 high-strength threshold ${threshold} MPa for ${exposureClass}, so structural class reduces by 1.`);
  }
  if (config.isSlabOrPlate) {
    value -= 1;
    reductions.push('Slab-like geometry reduces structural class by 1.');
  }
  if (config.specialQC) {
    value -= 1;
    reductions.push('Special quality control reduces structural class by 1.');
  }
  return { value: clamp(value, 1, 6), threshold, autoHighStrength, reductions };
}

function ec2MinimumBondCover(config = {}) {
  let cMinB = Math.max(positive(config.phiBar, 12), 6);
  if (positive(config.dG, 20) > 32) cMinB += 5;
  return cMinB;
}

function ec2DurabilityCover(config = {}) {
  const exposureClass = config.exposureClass || 'XC2';
  const fallbackExposure = ec2FallbackCorrosionExposure(exposureClass);
  const tableExposure = fallbackExposure || exposureClass;
  const column = EC2_EXPOSURE_COLUMNS[tableExposure] ?? EC2_EXPOSURE_COLUMNS.XC2;
  const structural = ec2StructuralClass(config);
  const cMinDur = EC2_TABLE_44N[structural.value - 1][column];
  const cMinB = ec2MinimumBondCover(config);
  const cMin = Math.max(cMinDur, cMinB, 10);
  const deltaCdev = Math.max(positive(config.deltaCdev, 10), 0);
  const unevenExtra = config.castAgainstUnevenSurface ? 5 : 0;
  let floor = 0;
  if (config.castAgainstPreparedGround) floor = Math.max(floor, 40);
  if (config.castAgainstUnpreparedGround) floor = Math.max(floor, 75);
  const cNomRaw = Math.max(cMin + deltaCdev + unevenExtra, floor);
  const recommendedCNom = 5 * Math.ceil(cNomRaw / 5);
  const overrideRaw = config.cNomOverride;
  const hasOverride = overrideRaw !== '' && overrideRaw != null && Number.isFinite(Number(overrideRaw));
  const cNom = hasOverride ? positive(overrideRaw, recommendedCNom) : recommendedCNom;
  return {
    exposureClass,
    exposureMeta: EC2_EXPOSURE_META[exposureClass] || EC2_EXPOSURE_META.XC2,
    fallbackExposure,
    tableExposure,
    structuralClass: structural.value,
    structuralAdjustments: structural.reductions,
    highStrengthThreshold: structural.threshold,
    autoHighStrength: structural.autoHighStrength,
    cMinDur,
    cMinB,
    cMin,
    deltaCdev,
    unevenExtra,
    floor,
    cNomRaw,
    recommendedCNom,
    cNom,
    hasOverride,
    cNomOverride: hasOverride ? positive(overrideRaw, recommendedCNom) : null,
    aggregateAdjustment: positive(config.dG, 20) > 32 ? 5 : 0,
    dG: positive(config.dG, 20)
  };
}

function consolidationDegree(Tv) {
  if (Tv <= 0) return 0;
  if (Tv < 0.2) return Math.min(Math.sqrt((4 * Tv) / Math.PI), 1);
  return clamp(1 - (8 / (Math.PI * Math.PI)) * Math.exp(-(Math.PI * Math.PI * Tv) / 4), 0, 1);
}

export function psiFactors(category = 'A') {
  return PSI_FACTORS[category] || PSI_FACTORS.A;
}

export function slsLoadCombination({
  Gk = 0,
  QLead = 0,
  QOther = 0,
  category = 'A',
  variant = 'qp'
} = {}) {
  const { psi0, psi1, psi2 } = psiFactors(category);
  const g = positive(Gk);
  const qLead = positive(QLead);
  const qOther = positive(QOther);
  if (variant === 'characteristic') {
    return g + qLead + psi0 * qOther;
  }
  if (variant === 'frequent') {
    return g + psi1 * qLead + psi2 * qOther;
  }
  return g + psi2 * (qLead + qOther);
}

export function ulsEq610({
  Gk = 0,
  QLead = 0,
  QOther = 0,
  category = 'A',
  setName = 'A1'
} = {}) {
  const { psi0 } = psiFactors(category);
  const gammaG = setName === 'A2' ? 1.0 : 1.35;
  const gammaQ = setName === 'A2' ? 1.30 : 1.50;
  return gammaG * positive(Gk) + gammaQ * positive(QLead) + gammaQ * psi0 * positive(QOther);
}

export function designSoilLayer(layer, combination = 'M1') {
  if (combination !== 'M2') return { ...layer };
  const phiK = positive(layer.phi);
  const tanPhi = Math.tan((phiK * Math.PI) / 180);
  return {
    ...layer,
    phi: phiK > 0 ? (Math.atan(tanPhi / 1.25) * 180) / Math.PI : 0,
    c: positive(layer.c) / 1.25,
    cu: positive(layer.cu) / 1.40
  };
}

export function totalVerticalStressAtDepth(layers, depth, wtDepth) {
  const z = Math.max(depth, 0);
  let total = 0;
  for (const layer of layers) {
    if ((layer.top ?? 0) >= z) break;
    const top = Math.max(layer.top ?? 0, 0);
    const bot = Math.min(layer.bot ?? 0, z);
    if (bot <= top) continue;
    if (bot <= wtDepth) {
      total += positive(layer.g) * (bot - top);
      continue;
    }
    if (top >= wtDepth) {
      total += positive(layer.gs || layer.g) * (bot - top);
      continue;
    }
    total += positive(layer.g) * (wtDepth - top);
    total += positive(layer.gs || layer.g) * (bot - wtDepth);
  }
  return total;
}

export function porePressureAtDepth(depth, wtDepth, gammaW = GAMMA_W) {
  return Math.max(0, gammaW * (depth - wtDepth));
}

export function effectiveVerticalStressAtDepth(layers, depth, wtDepth, gammaW = GAMMA_W) {
  const sigmaV = totalVerticalStressAtDepth(layers, depth, wtDepth);
  const u = porePressureAtDepth(depth, wtDepth, gammaW);
  return { sigmaV, u, sigmaEff: Math.max(sigmaV - u, 1) };
}

function intervalSegments(a, b, dz) {
  const out = [];
  let x = a;
  while (x < b - 1e-9) {
    const next = Math.min(x + dz, b);
    out.push([x, next]);
    x = next;
  }
  return out;
}

export function buildSublayerProfile(
  layers,
  {
    dz = 0.1,
    maxDepth = null,
    totalStressWt = 0,
    poreWt = 0,
    gammaW = GAMMA_W,
    splitDepths = []
  } = {}
) {
  const lim = maxDepth ?? (layers.length ? layers[layers.length - 1].bot : 0);
  const step = clamp(positive(dz, 0.1), 0.02, 1);
  const extraSplits = Array.isArray(splitDepths)
    ? splitDepths
        .map((depth) => positive(depth, null))
        .filter((depth) => Number.isFinite(depth) && depth > 0 && depth < lim)
    : [];
  const profile = [];
  let sigmaTop = 0;
  layers.forEach((layer, layerIndex) => {
    const layerTop = Math.max(positive(layer.top), 0);
    const layerBot = Math.min(positive(layer.bot), lim);
    if (layerBot <= layerTop) return;
    const splits = [layerTop, layerBot];
    if (totalStressWt > layerTop + 1e-9 && totalStressWt < layerBot - 1e-9) splits.push(totalStressWt);
    extraSplits.forEach((depth) => {
      if (depth > layerTop + 1e-9 && depth < layerBot - 1e-9) splits.push(depth);
    });
    splits.sort((a, b) => a - b);
    for (let i = 0; i < splits.length - 1; i += 1) {
      intervalSegments(splits[i], splits[i + 1], step).forEach(([segTop, segBot]) => {
        const zMid = 0.5 * (segTop + segBot);
        const gammaTotal = zMid > totalStressWt ? positive(layer.gs || layer.g) : positive(layer.g);
        const segDz = segBot - segTop;
        const sigmaMid = sigmaTop + 0.5 * gammaTotal * segDz;
        const sigmaBot = sigmaTop + gammaTotal * segDz;
        const u = porePressureAtDepth(zMid, poreWt, gammaW);
        profile.push({
          layer,
          layerIndex,
          top: segTop,
          bot: segBot,
          zMid,
          dz: segDz,
          gammaTotal,
          sigmaVTop: sigmaTop,
          sigmaVMid: sigmaMid,
          sigmaVBot: sigmaBot,
          u,
          sigmaEff: Math.max(sigmaMid - u, 1)
        });
        sigmaTop = sigmaBot;
      });
    }
  });
  return profile;
}

export function eoedAtStress(layer, sigmaEff, pRef = P_REF) {
  const sigma = Math.max(positive(sigmaEff, 1), 1);
  const phi = positive(layer.phi);
  const c = positive(layer.c);
  const m = clamp(positive(layer.m, 0.5), 0.01, 1.5);
  let cCotPhi = 0;
  if (c > 0 && phi > 0.001) {
    const phiRad = (phi * Math.PI) / 180;
    cCotPhi = c * (Math.cos(phiRad) / Math.max(Math.sin(phiRad), 1e-6));
  }
  const ref = Math.max(positive(layer.Eoed_ref, layer.EoedRef || 1), 1);
  const ratio = Math.max((sigma + cCotPhi) / Math.max(pRef + cCotPhi, 1e-6), 0.02);
  return ref * Math.pow(ratio, m);
}

function equivalentRectangle(config) {
  const footingType = config.footingType || config.foundationType || 'rectangular';
  if (footingType === 'strip') {
    return { footingType, B: Math.max(positive(config.B, 1), 0.1), L: Infinity, note: null };
  }
  if (footingType === 'square') {
    const B = Math.max(positive(config.B, 1), 0.1);
    return { footingType, B, L: B, note: null };
  }
  if (footingType === 'circular') {
    const D = Math.max(positive(config.D, config.B || 1), 0.1);
    const side = (D * Math.sqrt(Math.PI)) / 2;
    return {
      footingType,
      B: side,
      L: side,
      note: 'Circular footing is approximated as an equal-area square for the stress integration.'
    };
  }
  return {
    footingType,
    B: Math.max(positive(config.B, 1), 0.1),
    L: Math.max(positive(config.L, config.B || 1), 0.1),
    note: null
  };
}

function rectCornerInfluenceFactor(B, L, z) {
  const depth = Math.max(z, 1e-6);
  const mN = B / depth;
  const nN = L / depth;
  const V = mN * mN + nN * nN + 1;
  const V1 = (mN * nN) * (mN * nN);
  const numerator = 2 * mN * nN * Math.sqrt(V);
  const denom = V + V1;
  const A = clamp(numerator / Math.max(denom, 1e-9), -1, 1);
  const Bf = (V + 1) / Math.max(denom, 1e-9);
  if (V >= V1) {
    return (1 / (4 * Math.PI)) * (A * Bf + Math.asin(A));
  }
  return (1 / (4 * Math.PI)) * (A * Bf + Math.PI - Math.atan2(numerator, V - V1));
}

export function settlementStressIncrease({ method = 'boussinesq', footingType, B, L, qNet, z }) {
  const q = positive(qNet);
  if (q <= 0) return 0;
  const depth = Math.max(z, 1e-6);
  if (method === 'two_to_one') {
    if (footingType === 'strip') {
      return q * B / (B + depth);
    }
    return q * (B * L) / ((B + depth) * (L + depth));
  }
  if (footingType === 'strip') {
    const alpha = Math.atan(B / (2 * depth));
    return (q / Math.PI) * (2 * alpha + Math.sin(2 * alpha));
  }
  return 4 * rectCornerInfluenceFactor(B / 2, L / 2, depth) * q;
}

function perLayerMap(layers) {
  return layers.map((layer, index) => ({
    layerIndex: index,
    type: layer.type,
    subtype: layer.subtype || '',
    top: layer.top,
    bot: layer.bot,
    thickness: layerThickness(layer),
    settlement: 0
  }));
}

function buildTimeCurve(segments, maxDays) {
  const endDays = Math.max(positive(maxDays), 0);
  if (!endDays || !segments.length) return null;
  const steps = 24;
  const curve = [];
  for (let i = 0; i <= steps; i += 1) {
    const days = (endDays * i) / steps;
    const tSeconds = days * 24 * 3600;
    let settlement = 0;
    segments.forEach((seg) => {
      const Tv = seg.cv > 0 ? (seg.cv * tSeconds) / Math.max(seg.Hd * seg.Hd, 1e-9) : 0;
      settlement += consolidationDegree(Tv) * seg.dS;
    });
    curve.push({ x: days, y: settlement * 1000 });
  }
  return curve;
}

export function analyzeSettlement(layers, wtDepth, config = {}) {
  const maxDepth = layers.length ? layers[layers.length - 1].bot : 0;
  const Df = clamp(positive(config.Df, 1), 0, maxDepth);
  const dz = clamp(positive(config.dz, 0.1), 0.05, 0.5);
  const geom = equivalentRectangle(config);
  const combination = config.combination || 'qp';
  const qGross = slsLoadCombination({
    Gk: config.Gk,
    QLead: config.QLead,
    QOther: config.QOther,
    category: config.useCategory || 'A',
    variant: combination
  });
  const sigmaVDf = totalVerticalStressAtDepth(layers, Df, wtDepth);
  const qNetRaw = qGross - sigmaVDf;
  const qNet = Math.max(qNetRaw, 0);
  const profile = buildSublayerProfile(layers, {
    dz,
    maxDepth,
    totalStressWt: wtDepth,
    poreWt: wtDepth,
    splitDepths: [Df]
  });
  const perLayer = perLayerMap(layers);
  const sublayers = [];
  const deltaStressCurve = [];
  const eoedCurve = [];
  const cumulativeCurve = [];
  const timeSegments = [];
  const notes = [];
  let totalSettlement = 0;
  let truncationCause = 'CPT bottom reached';
  let truncationDepth = maxDepth;
  if (geom.note) notes.push({ level: 'info', text: geom.note });
  if (qNetRaw <= 0) {
    notes.push({
      level: 'warn',
      text: 'Net foundation pressure is zero or negative after subtracting the in-situ overburden at Df. Settlement is therefore reported as 0 mm. This usually means the chosen SLS load combination is smaller than the removed overburden; unloading / heave is not modelled in this screening tool.'
    });
  }
  for (const seg of profile) {
    if (seg.zMid <= Df + 1e-9) continue;
    if (qNet <= 0) break;
    const zRel = seg.zMid - Df;
    const dsig = settlementStressIncrease({
      method: config.stressMethod || 'boussinesq',
      footingType: geom.footingType,
      B: geom.B,
      L: Number.isFinite(geom.L) ? geom.L : geom.B * 50,
      qNet,
      z: zRel
    });
    const sigma0 = seg.sigmaEff;
    const sigmaF = sigma0 + dsig;
    const sigmaMean = sigma0 + 0.5 * dsig;
    const Eoed = eoedAtStress(seg.layer, sigmaMean);
    const deltaEps = dsig / Math.max(Eoed, 1e-6);
    const dS = deltaEps * seg.dz;
    totalSettlement += dS;
    perLayer[seg.layerIndex].settlement += dS;
    deltaStressCurve.push({ x: dsig, y: seg.zMid });
    eoedCurve.push({ x: Eoed, y: seg.zMid });
    cumulativeCurve.push({ x: totalSettlement * 1000, y: seg.zMid });
    const row = {
      zMid: seg.zMid,
      layerIndex: seg.layerIndex,
      sigmaEff0: sigma0,
      deltaSigmaV: dsig,
      sigmaEffF: sigmaF,
      sigmaMean,
      Eoed,
      deltaEps,
      dS,
      dSmm: dS * 1000
    };
    sublayers.push(row);
    if (isFineGrained(seg.layer) && positive(seg.layer.kv) > 0 && dS > 0) {
      const cv = (positive(seg.layer.kv) * Eoed) / GAMMA_W;
      const Hd = Math.max(layerThickness(seg.layer) / 2, seg.dz / 2);
      timeSegments.push({ cv, Hd, dS });
    }
    if ((config.truncationRule || '10%_sigma_eff') !== 'CPT_bottom') {
      const bySigma = dsig < 0.10 * sigma0;
      const byQNet = dsig < 0.20 * qNet;
      if ((config.truncationRule || '10%_sigma_eff') === '10%_sigma_eff' && bySigma) {
        truncationCause = 'Delta sigma_v < 10% of sigma_v,0';
        truncationDepth = seg.zMid;
        break;
      }
      if ((config.truncationRule || '10%_sigma_eff') === '20%_q_net' && byQNet) {
        truncationCause = 'Delta sigma_v < 20% of q_net';
        truncationDepth = seg.zMid;
        break;
      }
    }
  }
  if (config.includeTime && !timeSegments.length && totalSettlement > 0) {
    notes.push({
      level: 'warn',
      text: 'A time curve was requested, but no low-permeability fine-grained segments with kv were found inside the active influence zone.'
    });
  }
  if (config.includeTime) {
    notes.push({
      level: 'warn',
      text: 'Settlement time curve uses a simplified Terzaghi 1D two-way drainage assumption with Hd = half the interpreted layer thickness.'
    });
  }
  return {
    limitState: 'SLS',
    loadCombination: combination,
    qGross,
    qNet,
    sigmaVDf,
    Df,
    geometry: geom,
    totalSettlement,
    totalSettlementMm: totalSettlement * 1000,
    perLayer: perLayer.map((row) => ({ ...row, settlementMm: row.settlement * 1000 })),
    sublayers,
    deltaStressCurve,
    eoedCurve,
    cumulativeCurve,
    truncationDepth,
    truncationCause,
    timeCurve: config.includeTime ? buildTimeCurve(timeSegments, config.timeDays || 180) : null,
    notes
  };
}

function layerAverageKh(layers, zTop, zBot) {
  let num = 0;
  let den = 0;
  layers.forEach((layer) => {
    const top = Math.max(positive(layer.top), zTop);
    const bot = Math.min(positive(layer.bot), zBot);
    if (bot <= top) return;
    const dz = bot - top;
    num += positive(layer.kh, 1e-7) * dz;
    den += dz;
  });
  return den > 0 ? num / den : 1e-7;
}

function dewateringGeometry(config) {
  const geometry = config.geometry || 'equivalent_well_rectangular_excavation';
  if (geometry === 'single_well') {
    return {
      geometry,
      wellRadius: Math.max(positive(config.rw, 0.15), 0.05),
      distanceToCpt: Math.max(positive(config.rCPT, 5), 0),
      distanceLabel: 'Distance from well centre to CPT',
      sourceLabel: 'well centre',
      label: 'Single well'
    };
  }
  if (geometry === 'line_dewatering_trench') {
    return {
      geometry,
      wellRadius: null,
      trenchLength: Math.max(positive(config.LTrench, 20), 1),
      distanceToCpt: Math.max(positive(config.distanceToCPT, 10), 0),
      distanceLabel: 'Perpendicular distance from trench to CPT',
      sourceLabel: 'trench axis',
      label: 'Line dewatering trench'
    };
  }
  const Lpit = Math.max(positive(config.LPit, 10), 0.5);
  const Bpit = Math.max(positive(config.BPit, 6), 0.5);
  const wellRadius = Math.sqrt((Lpit * Bpit) / Math.PI);
  return {
    geometry,
    wellRadius,
    distanceToCpt: Math.max(positive(config.rCPT, 10), 0),
    Lpit,
    BPit: Bpit,
    distanceLabel: 'Distance from excavation centroid to CPT',
    sourceLabel: 'excavation centroid',
    equivalentRadiusLabel: 'Equivalent well radius',
    label: 'Equivalent well (rectangular excavation)'
  };
}

function drawdownCurveRadial(baseDepth, oldWt, newWtAtWell, radiusInfluence, effectiveK, geom, aquiferType) {
  const oldH = Math.max(baseDepth - oldWt, 0.05);
  const hw = Math.max(baseDepth - newWtAtWell, 0.05);
  const rw = Math.max(geom.wellRadius || 0.1, 0.05);
  const R = Math.max(radiusInfluence, rw * 1.01);
  const logTerm = safeLogRatio(R, rw);
  if (aquiferType === 'confined') {
    const H = oldH;
    const Q = (TWO_PI * effectiveK * H * Math.max(oldH - hw, 0)) / Math.max(logTerm, 1e-6);
    return {
      Q,
      QUnits: 'm3/s',
      points: Array.from({ length: 30 }, (_, idx) => {
        const r = rw + ((R - rw) * idx) / 29;
        const h = hw + (Q / (TWO_PI * effectiveK * Math.max(H, 1e-6))) * Math.log(r / rw);
        return { x: r, y: baseDepth - h };
      }),
      waterTableAtDistance(distance) {
        if (distance <= rw) return newWtAtWell;
        if (distance >= R) return oldWt;
        const h = hw + (Q / (TWO_PI * effectiveK * Math.max(H, 1e-6))) * Math.log(distance / rw);
        return baseDepth - h;
      }
    };
  }
  const Q = (Math.PI * effectiveK * Math.max(oldH * oldH - hw * hw, 0)) / Math.max(logTerm, 1e-6);
  return {
    Q,
    QUnits: 'm3/s',
    points: Array.from({ length: 30 }, (_, idx) => {
      const r = rw + ((R - rw) * idx) / 29;
      const h = Math.sqrt(Math.max(hw * hw + (Q / (Math.PI * effectiveK)) * Math.log(r / rw), hw * hw));
      return { x: r, y: baseDepth - h };
    }),
    waterTableAtDistance(distance) {
      if (distance <= rw) return newWtAtWell;
      if (distance >= R) return oldWt;
      const h = Math.sqrt(Math.max(hw * hw + (Q / (Math.PI * effectiveK)) * Math.log(distance / rw), hw * hw));
      return baseDepth - h;
    }
  };
}

function drawdownCurveTrench(baseDepth, oldWt, newWtAtWell, radiusInfluence, effectiveK, geom, aquiferType) {
  const oldH = Math.max(baseDepth - oldWt, 0.05);
  const hw = Math.max(baseDepth - newWtAtWell, 0.05);
  const R = Math.max(radiusInfluence, 0.5);
  const qPrime =
    aquiferType === 'confined'
      ? (effectiveK * oldH * Math.max(oldWt - newWtAtWell, 0)) / Math.max(R, 1e-6)
      : (effectiveK * Math.max(oldH * oldH - hw * hw, 0)) / Math.max(2 * R, 1e-6);
  return {
    Q: qPrime * positive(geom.trenchLength, 1),
    QUnits: 'm3/s total',
    qPrime,
    qPrimeUnits: 'm3/s per m',
    points: Array.from({ length: 30 }, (_, idx) => {
      const x = (R * idx) / 29;
      const ratio = clamp(1 - x / Math.max(R, 1e-6), 0, 1);
      return { x, y: oldWt + (newWtAtWell - oldWt) * ratio };
    }),
    waterTableAtDistance(distance) {
      if (distance >= R) return oldWt;
      const ratio = clamp(1 - distance / Math.max(R, 1e-6), 0, 1);
      return oldWt + (newWtAtWell - oldWt) * ratio;
    }
  };
}

function dewateringSettlementResponse(layers, wtDepth, newWtAtLocation, config, maxDepth) {
  const splitDepths = [wtDepth, newWtAtLocation];
  const before = buildSublayerProfile(layers, {
    dz: config.dz || 0.1,
    maxDepth,
    totalStressWt: wtDepth,
    poreWt: wtDepth,
    splitDepths
  });
  const after = buildSublayerProfile(layers, {
    dz: config.dz || 0.1,
    maxDepth,
    totalStressWt: (config.sigmaVMode || 'conservative') === 'realistic' ? newWtAtLocation : wtDepth,
    poreWt: newWtAtLocation,
    splitDepths
  });
  let totalSettlement = 0;
  const perLayer = perLayerMap(layers);
  const beforeStressCurve = [];
  const afterStressCurve = [];
  const beforeTotalStressCurve = [];
  const afterTotalStressCurve = [];
  const deltaStressCurve = [];
  const cumulativeCurve = [];
  const timeSegments = [];
  let maxSigmaVShift = 0;
  const sublayers = before.map((seg, idx) => {
    const afterSeg = after[idx];
    const deltaSigmaEff = Math.max(afterSeg.sigmaEff - seg.sigmaEff, 0);
    const sigmaMean = 0.5 * (seg.sigmaEff + afterSeg.sigmaEff);
    const Eoed = eoedAtStress(seg.layer, sigmaMean);
    const dS = (deltaSigmaEff / Math.max(Eoed, 1e-6)) * seg.dz;
    totalSettlement += dS;
    perLayer[seg.layerIndex].settlement += dS;
    beforeStressCurve.push({ x: seg.sigmaEff, y: seg.zMid });
    afterStressCurve.push({ x: afterSeg.sigmaEff, y: seg.zMid });
    beforeTotalStressCurve.push({ x: seg.sigmaVMid, y: seg.zMid });
    afterTotalStressCurve.push({ x: afterSeg.sigmaVMid, y: seg.zMid });
    deltaStressCurve.push({ x: deltaSigmaEff, y: seg.zMid });
    cumulativeCurve.push({ x: totalSettlement * 1000, y: seg.zMid });
    maxSigmaVShift = Math.max(maxSigmaVShift, Math.abs(afterSeg.sigmaVMid - seg.sigmaVMid));
    if (isFineGrained(seg.layer) && positive(seg.layer.kv) > 0 && dS > 0) {
      const cv = (positive(seg.layer.kv) * Eoed) / GAMMA_W;
      const Hd = Math.max(layerThickness(seg.layer) / 2, seg.dz / 2);
      timeSegments.push({ cv, Hd, dS });
    }
    return {
      zMid: seg.zMid,
      layerIndex: seg.layerIndex,
      sigmaEffBefore: seg.sigmaEff,
      sigmaEffAfter: afterSeg.sigmaEff,
      deltaSigmaEff,
      sigmaMean,
      Eoed,
      dS,
      dSmm: dS * 1000
    };
  });
  return {
    after,
    perLayer,
    beforeStressCurve,
    afterStressCurve,
    beforeTotalStressCurve,
    afterTotalStressCurve,
    deltaStressCurve,
    cumulativeCurve,
    timeSegments,
    sublayers,
    totalSettlement,
    totalSettlementMm: totalSettlement * 1000,
    maxSigmaVShift
  };
}

export function analyzeDewatering(layers, wtDepth, config = {}) {
  const maxDepth = layers.length ? layers[layers.length - 1].bot : 0;
  const geom = dewateringGeometry(config);
  const targetWt = clamp(positive(config.targetWt, wtDepth + 1), wtDepth, Math.max(maxDepth - 0.2, wtDepth));
  const baseDepth = Math.max(positive(config.aquiferBaseDepth, maxDepth), targetWt + 0.2);
  const effectiveK = layerAverageKh(layers, wtDepth, baseDepth);
  const wellDrawdown = Math.max(targetWt - wtDepth, 0);
  const radiusInfluence = positive(config.CSichardt, 3000) * wellDrawdown * Math.sqrt(Math.max(effectiveK, 1e-12));
  const aquiferType = config.aquiferType || 'unconfined';
  const drawdown =
    geom.geometry === 'line_dewatering_trench'
      ? drawdownCurveTrench(baseDepth, wtDepth, targetWt, radiusInfluence, effectiveK, geom, aquiferType)
      : drawdownCurveRadial(baseDepth, wtDepth, targetWt, radiusInfluence, effectiveK, geom, aquiferType);
  const newWtAtCpt = drawdown.waterTableAtDistance(geom.distanceToCpt);
  const conservativeResponse = dewateringSettlementResponse(
    layers,
    wtDepth,
    newWtAtCpt,
    { ...config, sigmaVMode: 'conservative' },
    maxDepth
  );
  const realisticResponse = dewateringSettlementResponse(
    layers,
    wtDepth,
    newWtAtCpt,
    { ...config, sigmaVMode: 'realistic' },
    maxDepth
  );
  const cptResponse =
    (config.sigmaVMode || 'conservative') === 'realistic' ? realisticResponse : conservativeResponse;
  const {
    after,
    perLayer,
    deltaStressCurve,
    beforeStressCurve,
    afterStressCurve,
    beforeTotalStressCurve,
    afterTotalStressCurve,
    cumulativeCurve,
    timeSegments,
    sublayers,
    totalSettlement,
    totalSettlementMm,
    maxSigmaVShift
  } = cptResponse;
  const notes = [
    {
      level: 'warn',
      text: 'Sichardt radius of influence is shown as a screening estimate only. It is not a permit-grade hydrogeological prediction.'
    }
  ];
  if (!config.aquiferBaseDepth) {
    notes.push({
      level: 'warn',
      text: 'Aquifer base was not provided, so the CPT bottom depth is used as a first-pass aquifer base. Verify this against geology or pumping-test data.'
    });
  }
  if (geom.geometry === 'line_dewatering_trench') {
    notes.push({
      level: 'warn',
      text: 'The trench drawdown profile toward the CPT is shown with a linear screening interpolation. Flow rate follows the Dupuit line-dewatering estimate.'
    });
  }
  if ((config.sigmaVMode || 'conservative') === 'realistic') {
    notes.push({
      level: 'info',
      text: 'Realistic total-stress mode swaps gamma_sat to gamma between the old and new water tables. Conservative mode keeps sigma_v unchanged.'
    });
  }
  const modeSensitivityMm = Math.abs(realisticResponse.totalSettlementMm - conservativeResponse.totalSettlementMm);
  if (modeSensitivityMm < 0.05) {
    notes.push({
      level: 'info',
      text: `Total-stress mode sensitivity is negligible for this case: conservative = ${conservativeResponse.totalSettlementMm.toFixed(2)} mm, realistic = ${realisticResponse.totalSettlementMm.toFixed(2)} mm. The pore-pressure reduction dominates the result here.`
    });
  } else {
    notes.push({
      level: 'info',
      text: `Total-stress mode does change the result here: conservative = ${conservativeResponse.totalSettlementMm.toFixed(2)} mm, realistic = ${realisticResponse.totalSettlementMm.toFixed(2)} mm.`
    });
  }
  if (geom.geometry === 'equivalent_well_rectangular_excavation') {
    notes.push({
      level: 'info',
      text: `Equivalent-well mapping is active: the rectangular excavation area is converted to r_w,eq = sqrt(A/pi) = ${geom.wellRadius.toFixed(2)} m, and the Dupuit radial drawdown is then evaluated at the CPT distance from the excavation centroid.`
    });
  }
  if (targetWt > wtDepth && geom.distanceToCpt >= radiusInfluence - 1e-9) {
    notes.push({
      level: 'warn',
      text: `The CPT lies outside the current Sichardt screening radius (distance = ${geom.distanceToCpt.toFixed(2)} m, R = ${radiusInfluence.toFixed(2)} m). Under this screening model, no drawdown reaches the CPT, so dewatering settlement remains 0 mm.`
    });
  } else if (drawdown.waterTableAtDistance(geom.distanceToCpt) - wtDepth < 0.01) {
    notes.push({
      level: 'info',
      text: 'Computed drawdown at the CPT is negligible (< 0.01 m), so the resulting dewatering settlement is effectively zero.'
    });
  }
  const settlementDistanceCurve = [];
  const maxDistance = Math.max(radiusInfluence, geom.distanceToCpt || 0, geom.wellRadius || 0, 1);
  const sampleCount = 30;
  for (let idx = 0; idx <= sampleCount; idx += 1) {
    const distance = (maxDistance * idx) / sampleCount;
    const wtAtDistance = drawdown.waterTableAtDistance(distance);
    const response = dewateringSettlementResponse(layers, wtDepth, wtAtDistance, config, maxDepth);
    settlementDistanceCurve.push({ x: distance, y: response.totalSettlementMm });
  }
  const drawdownDisplayCurve = Array.from({ length: 61 }, (_, idx) => {
    const distance = (maxDistance * idx) / 60;
    return { x: distance, y: drawdown.waterTableAtDistance(distance) };
  });
  if (config.timeDays) {
    notes.push({
      level: 'warn',
      text: 'Settlement time curve uses a simplified Terzaghi 1D two-way drainage assumption with Hd = half the interpreted layer thickness.'
    });
  }
  return {
    limitState: 'SLS',
    geometry: geom,
    targetWt,
    effectiveK,
    baseDepth,
    radiusInfluence,
    QEstimate: drawdown.Q,
    QUnits: drawdown.QUnits,
    qPrime: drawdown.qPrime,
    qPrimeUnits: drawdown.qPrimeUnits,
    drawdownAtCpt: Math.max(newWtAtCpt - wtDepth, 0),
    newWtAtCpt,
    drawdownCurve: drawdown.points,
    drawdownDisplayCurve,
    settlementDistanceCurve,
    beforeStressCurve,
    afterStressCurve,
    beforeTotalStressCurve,
    afterTotalStressCurve,
    deltaStressCurve,
    cumulativeCurve,
    perLayer: perLayer.map((row) => ({ ...row, settlementMm: row.settlement * 1000 })),
    sublayers,
    totalSettlement,
    totalSettlementMm,
    conservativeSettlementMm: conservativeResponse.totalSettlementMm,
    realisticSettlementMm: realisticResponse.totalSettlementMm,
    maxSigmaVShift,
    timeCurve: config.timeDays ? buildTimeCurve(timeSegments, config.timeDays) : null,
    notes
  };
}

function averageSoilStiffness(profile, config) {
  const Df = positive(config.Df, 0);
  const influenceDepth = Math.max(positive(config.zInfluence, 2 * positive(config.B, 1)), 0.5);
  let sum = 0;
  let weight = 0;
  let nuSum = 0;
  profile.forEach((seg) => {
    if (seg.zMid < Df || seg.zMid > Df + influenceDepth) return;
    const Eoed = eoedAtStress(seg.layer, seg.sigmaEff);
    const nu = config.EsMode === 'young_drained' ? 0.30 : 0.0;
    const Es =
      config.EsMode === 'young_drained'
        ? Eoed * (((1 + 0.30) * (1 - 2 * 0.30)) / (1 - 0.30))
        : Eoed;
    sum += Es * seg.dz;
    nuSum += nu * seg.dz;
    weight += seg.dz;
  });
  return {
    EsAvg: weight > 0 ? sum / weight : 0,
    nuAvg: weight > 0 ? nuSum / weight : 0
  };
}

export function computeSubgradeReaction(layers, wtDepth, config = {}) {
  const maxDepth = layers.length ? layers[layers.length - 1].bot : 0;
  const profile = buildSublayerProfile(layers, {
    dz: config.dz || 0.1,
    maxDepth,
    totalStressWt: wtDepth,
    poreWt: wtDepth
  });
  const B = Math.max(positive(config.B, 1), 0.1);
  const b = Math.max(positive(config.b, B), 0.1);
  const h = Math.max(positive(config.h, 0.3), 0.1);
  const Ec = Math.max(positive(config.Ec, 33000000), 1000);
  const I = b * Math.pow(h, 3) / 12;
  const Df = clamp(positive(config.Df, 0), 0, maxDepth);
  const zInfluence = positive(config.zInfluence, 2 * B);
  const { EsAvg, nuAvg } = averageSoilStiffness(profile, { ...config, Df, zInfluence });
  const nu = config.EsMode === 'young_drained' ? 0.30 : 0.0;
  const GsAvg = EsAvg > 0 ? EsAvg / (2 * (1 + nu)) : 0;
  const gpEta = Math.max(positive(config.gpEta, 1.0), 0);
  const gpInferred = GsAvg > 0 ? gpEta * GsAvg * zInfluence : 0;
  const gpOverride =
    config.gpOverride != null && config.gpOverride !== '' ? Math.max(positive(config.gpOverride), 0) : null;
  const gp = gpOverride != null ? gpOverride : gpInferred;
  const ks =
    EsAvg > 0
      ? (0.65 * EsAvg) / (B * (1 - nu * nu)) * Math.pow((EsAvg * Math.pow(B, 4)) / Math.max(Ec * I, 1e-9), 1 / 12)
      : 0;
  return {
    profile,
    B,
    b,
    h,
    Ec,
    I,
    Df,
    zInfluence,
    EsAvg,
    nuAvg: nu,
    GsAvg,
    gpEta,
    gpInferred,
    gpOverride,
    gp,
    ks
  };
}

function zeroMatrix(size) {
  return Array.from({ length: size }, () => Array(size).fill(0));
}

function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const A = matrix.map((row) => row.slice());
  const b = rhs.slice();
  for (let k = 0; k < n; k += 1) {
    let pivot = k;
    let pivotAbs = Math.abs(A[k][k]);
    for (let i = k + 1; i < n; i += 1) {
      const cand = Math.abs(A[i][k]);
      if (cand > pivotAbs) {
        pivotAbs = cand;
        pivot = i;
      }
    }
    if (pivotAbs < 1e-12) {
      throw new Error('Beam stiffness matrix is singular.');
    }
    if (pivot !== k) {
      [A[k], A[pivot]] = [A[pivot], A[k]];
      [b[k], b[pivot]] = [b[pivot], b[k]];
    }
    const diag = A[k][k];
    for (let j = k; j < n; j += 1) A[k][j] /= diag;
    b[k] /= diag;
    for (let i = 0; i < n; i += 1) {
      if (i === k) continue;
      const factor = A[i][k];
      if (Math.abs(factor) < 1e-12) continue;
      for (let j = k; j < n; j += 1) {
        A[i][j] -= factor * A[k][j];
      }
      b[i] -= factor * b[k];
    }
  }
  return b;
}

function addMatrixBlock(K, dofs, localK) {
  for (let i = 0; i < dofs.length; i += 1) {
    for (let j = 0; j < dofs.length; j += 1) {
      K[dofs[i]][dofs[j]] += localK[i][j];
    }
  }
}

function addVectorBlock(F, dofs, localF) {
  for (let i = 0; i < dofs.length; i += 1) {
    F[dofs[i]] += localF[i];
  }
}

function beamElementStiffness(EI, kLine, le) {
  const l2 = le * le;
  const l3 = l2 * le;
  const kb = [
    [12, 6 * le, -12, 6 * le],
    [6 * le, 4 * l2, -6 * le, 2 * l2],
    [-12, -6 * le, 12, -6 * le],
    [6 * le, 2 * l2, -6 * le, 4 * l2]
  ].map((row) => row.map((value) => (EI / l3) * value));
  const kf = [
    [156, 22 * le, 54, -13 * le],
    [22 * le, 4 * l2, 13 * le, -3 * l2],
    [54, 13 * le, 156, -22 * le],
    [-13 * le, -3 * l2, -22 * le, 4 * l2]
  ].map((row) => row.map((value) => (kLine * le / 420) * value));
  return kb.map((row, i) => row.map((value, j) => value + kf[i][j]));
}

function pasternakElementStiffness(gpLine, le) {
  if (!(gpLine > 0) || !(le > 0)) return zeroMatrix(4);
  const gaussPoints = [
    { r: 0.1127016653792583, w: 5 / 18 },
    { r: 0.5, w: 8 / 18 },
    { r: 0.8872983346207417, w: 5 / 18 }
  ];
  const K = zeroMatrix(4);
  gaussPoints.forEach(({ r, w }) => {
    const dNdx = [
      (-6 * r + 6 * r * r) / le,
      1 - 4 * r + 3 * r * r,
      (6 * r - 6 * r * r) / le,
      -2 * r + 3 * r * r
    ];
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        K[i][j] += gpLine * le * w * dNdx[i] * dNdx[j];
      }
    }
  });
  return K;
}

function distributedLoadVector(q, le) {
  return [(q * le) / 2, (q * le * le) / 12, (q * le) / 2, (-q * le * le) / 12];
}

function pointLoadVector(P, le, xi) {
  const N1 = 1 - 3 * xi * xi + 2 * xi * xi * xi;
  const N2 = le * (xi - 2 * xi * xi + xi * xi * xi);
  const N3 = 3 * xi * xi - 2 * xi * xi * xi;
  const N4 = le * (-xi * xi + xi * xi * xi);
  return [P * N1, P * N2, P * N3, P * N4];
}

function loadPatternMeta(config, limitState) {
  const pattern = config.loadPattern || 'uniform_full';
  const category = config.useCategory || 'A';
  const ulsSet = config.ulsCombination || 'A1';
  const loadSummary =
    limitState === 'ULS'
      ? ulsEq610({
          Gk: config.Gk,
          QLead: config.QLead,
          QOther: config.QOther,
          category,
          setName: ulsSet
        })
      : slsLoadCombination({
          Gk: config.Gk,
          QLead: config.QLead,
          QOther: config.QOther,
          category,
          variant: config.slsCombination || 'qp'
        });
  if (pattern === 'point_centre') {
    return {
      pattern,
      value: loadSummary,
      units: 'kN',
      pointX: positive(config.xLoad, config.L / 2) || positive(config.L, 6) / 2,
      label: limitState === 'ULS' ? `ULS Eq. 6.10 ${ulsSet} point load` : `SLS ${config.slsCombination || 'qp'} point load`
    };
  }
  if (pattern === 'point_at_x') {
    return {
      pattern,
      value: loadSummary,
      units: 'kN',
      pointX: clamp(positive(config.xLoad, positive(config.L, 6) / 2), 0, positive(config.L, 6)),
      label: limitState === 'ULS' ? `ULS Eq. 6.10 ${ulsSet} point load` : `SLS ${config.slsCombination || 'qp'} point load`
    };
  }
  if (pattern === 'uniform_patch') {
    const xStart = clamp(positive(config.xStart, positive(config.L, 6) * 0.25), 0, positive(config.L, 6));
    const xEnd = clamp(
      positive(config.xEnd, positive(config.L, 6) * 0.75),
      xStart + 0.05,
      positive(config.L, 6)
    );
    return {
      pattern,
      value: loadSummary,
      units: 'kN/m',
      xStart,
      xEnd,
      label:
        limitState === 'ULS'
          ? `ULS Eq. 6.10 ${ulsSet} patch line load`
          : `SLS ${config.slsCombination || 'qp'} patch line load`
    };
  }
  return {
    pattern: 'uniform_full',
    value: loadSummary,
    units: 'kN/m',
    xStart: 0,
    xEnd: positive(config.L, 6),
    label:
      limitState === 'ULS'
        ? `ULS Eq. 6.10 ${ulsSet} uniform line load`
        : `SLS ${config.slsCombination || 'qp'} uniform line load`
  };
}

function solveBeamOnElasticFoundation({ L, EI, ks, gp = 0, b, nElements, loadMeta }) {
  const length = Math.max(positive(L, 6), 0.5);
  const beamWidth = Math.max(positive(b, 1), 0.1);
  const kLine = Math.max(positive(ks), 0) * beamWidth;
  const gpLine = Math.max(positive(gp), 0) * beamWidth;
  const nElem = Math.max(Math.round(positive(nElements, 80)), 20);
  const nNodes = nElem + 1;
  const dof = 2 * nNodes;
  const le = length / nElem;
  const K = zeroMatrix(dof);
  const F = Array(dof).fill(0);
  const elementK = beamElementStiffness(EI, kLine, le);
  const elementGp = pasternakElementStiffness(gpLine, le);
  for (let e = 0; e < nElem; e += 1) {
    const x1 = e * le;
    const x2 = x1 + le;
    const dofs = [2 * e, 2 * e + 1, 2 * (e + 1), 2 * (e + 1) + 1];
    addMatrixBlock(K, dofs, elementK);
    if (gpLine > 0) addMatrixBlock(K, dofs, elementGp);
    if (loadMeta.pattern === 'uniform_full' || loadMeta.pattern === 'uniform_patch') {
      const overlap = Math.max(0, Math.min(x2, loadMeta.xEnd) - Math.max(x1, loadMeta.xStart));
      if (overlap > 0) {
        const qEff = loadMeta.value * (overlap / le);
        addVectorBlock(F, dofs, distributedLoadVector(qEff, le));
      }
    } else if ((loadMeta.pattern === 'point_centre' || loadMeta.pattern === 'point_at_x') && loadMeta.pointX >= x1 && loadMeta.pointX <= x2 + 1e-9) {
      const xi = clamp((loadMeta.pointX - x1) / le, 0, 1);
      addVectorBlock(F, dofs, pointLoadVector(loadMeta.value, le, xi));
    }
  }
  const U = solveLinearSystem(K, F);
  const xSamples = [];
  const wSamples = [];
  const mSamples = [];
  const vSamples = [];
  let maxDeflection = { value: 0, x: 0 };
  let maxMoment = { value: 0, x: 0 };
  for (let e = 0; e < nElem; e += 1) {
    const x1 = e * le;
    const dofs = [2 * e, 2 * e + 1, 2 * (e + 1), 2 * (e + 1) + 1];
    const ue = dofs.map((idx) => U[idx]);
    const sampleCount = 3;
    for (let s = 0; s <= sampleCount; s += 1) {
      if (e > 0 && s === 0) continue;
      const xi = s / sampleCount;
      const x = x1 + xi * le;
      const N1 = 1 - 3 * xi * xi + 2 * xi * xi * xi;
      const N2 = le * (xi - 2 * xi * xi + xi * xi * xi);
      const N3 = 3 * xi * xi - 2 * xi * xi * xi;
      const N4 = le * (-xi * xi + xi * xi * xi);
      const d2 = [
        (-6 + 12 * xi) / (le * le),
        (-4 + 6 * xi) / le,
        (6 - 12 * xi) / (le * le),
        (-2 + 6 * xi) / le
      ];
      const d3 = [12 / Math.pow(le, 3), 6 / (le * le), -12 / Math.pow(le, 3), 6 / (le * le)];
      const w = N1 * ue[0] + N2 * ue[1] + N3 * ue[2] + N4 * ue[3];
      const curvature = d2[0] * ue[0] + d2[1] * ue[1] + d2[2] * ue[2] + d2[3] * ue[3];
      const third = d3[0] * ue[0] + d3[1] * ue[1] + d3[2] * ue[2] + d3[3] * ue[3];
      const M = -EI * curvature;
      const V = -EI * third;
      xSamples.push(x);
      wSamples.push(w);
      mSamples.push(M);
      vSamples.push(V);
      if (Math.abs(w) > Math.abs(maxDeflection.value)) maxDeflection = { value: w, x };
      if (Math.abs(M) > Math.abs(maxMoment.value)) maxMoment = { value: M, x };
    }
  }
  return {
    xSamples,
    wSamples,
    mSamples,
    vSamples,
    maxDeflection,
    maxMoment,
    kLine,
    gpLine,
    nElem
  };
}

function reinforcementDesign(config, MEdAbs) {
  const durability = ec2DurabilityCover(config);
  const phiBar = Math.max(positive(config.phiBar, 12), 6);
  const cNom = durability.cNom;
  const hMm = Math.max(positive(config.h, 0.35) * 1000, cNom + phiBar);
  const d = hMm - cNom - phiBar / 2;
  const fck = Math.max(positive(config.fck, 30), 12);
  const fyk = Math.max(positive(config.fyk, 500), 200);
  const gammaC = 1.50;
  const gammaS = 1.15;
  const fcd = fck / gammaC;
  const fyd = fyk / gammaS;
  const bw = 1000;
  const mu = d > 0 ? (Math.max(MEdAbs, 0) * 1e6) / (bw * d * d * fcd) : 0;
  const omega = mu < 0.5 ? 1 - Math.sqrt(Math.max(1 - 2 * mu, 0)) : null;
  const AsReq = omega != null ? (omega * bw * d * fcd) / fyd : null;
  const fctm = 0.30 * Math.pow(fck, 2 / 3);
  const AsMin = Math.max((0.26 * fctm) / fyk, 0.0013) * bw * d;
  const As = AsReq == null ? AsMin : Math.max(AsReq, AsMin);
  const warnings = [];
  if (durability.hasOverride && durability.cNomOverride < durability.recommendedCNom) {
    warnings.push(
      `The manual c_nom override ${durability.cNomOverride.toFixed(0)} mm is below the EC2 recommendation ${durability.recommendedCNom.toFixed(0)} mm for the selected exposure and detailing assumptions.`
    );
  }
  if (durability.fallbackExposure) {
    warnings.push(
      `Exposure class ${durability.exposureClass} uses the EC2 corrosion-cover fallback ${durability.tableExposure} for c_min,dur. Concrete composition and XF/XA-specific EN 206 durability requirements are not checked here.`
    );
  }
  if (mu > 0.295) {
    warnings.push('mu exceeds about 0.295, so the section is outside the usual singly reinforced ductility limit. Increase h or redesign the section.');
  }
  return {
    structuralClass: durability.structuralClass,
    cMinDur: durability.cMinDur,
    cNom,
    recommendedCNom: durability.recommendedCNom,
    d,
    fcd,
    fyd,
    mu,
    omega,
    AsReq,
    AsMin,
    As,
    fctm,
    durability,
    warnings
  };
}

export function analyzeBeamAndReinforcement(layers, wtDepth, config = {}) {
  const ksInfo = computeSubgradeReaction(layers, wtDepth, config);
  const L = Math.max(positive(config.L, 6), 0.5);
  const b = Math.max(positive(config.b, config.B || 1), 0.1);
  const EI = ksInfo.Ec * ksInfo.I;
  const ks = ksInfo.ks;
  const gp = (config.foundationModel || 'winkler') === 'pasternak' ? ksInfo.gp : 0;
  const lambda = ks > 0 ? Math.pow((4 * EI) / Math.max(ks * b, 1e-9), 0.25) : 0;
  const beta = lambda > 0 ? 1 / lambda : 0;
  const betaL = beta * L;
  const classification = betaL > Math.PI ? 'Long beam' : betaL > Math.PI / 4 ? 'Intermediate beam' : 'Short beam';
  const slsLoadMeta = loadPatternMeta(config, 'SLS');
  const ulsLoadMeta = loadPatternMeta(config, 'ULS');
  const nElements = Math.max(Math.round(positive(config.nElements, 120)), 40);
  const sls = solveBeamOnElasticFoundation({ L, EI, ks, gp, b, nElements, loadMeta: slsLoadMeta });
  const uls = solveBeamOnElasticFoundation({ L, EI, ks, gp, b, nElements, loadMeta: ulsLoadMeta });
  const reinforcement = reinforcementDesign(config, Math.abs(uls.maxMoment.value));
  const notes = [];
  notes.push({
    level: 'warn',
    text: `Stage 6 ${gp > 0 ? 'Pasternak' : 'Winkler'} uses a 1D beam/strip model. True 2D slab-on-grade plate behaviour still needs FE or a dedicated analytical plate solution.`
  });
  if (betaL < Math.PI) {
    notes.push({
      level: 'warn',
      text: 'beta*L is below pi, so finite-beam behaviour matters. A numerical beam-on-Winkler solve is therefore used instead of relying on the infinite-beam shortcut.'
    });
  } else {
    notes.push({
      level: 'info',
      text: 'beta*L exceeds pi, so this beam is in the long-beam range and the numerical result should align closely with the classical infinite-beam solution.'
    });
  }
  if (config.EsMode !== 'young_drained') {
    notes.push({
      level: 'info',
      text: 'Default ks derivation uses Es = E_oed and nu = 0 for consistency with the oedometric stiffness route. Switch to drained Young modulus mode if a project-specific conversion is preferred.'
    });
  }
  if (gp > 0) {
    notes.push({
      level: 'warn',
      text: `Pasternak shear coupling is inferred from the CPT stiffness profile as G_p ≈ eta·G_s,avg·H_p. This is a screening approximation, not a calibrated Belgian design value.`
    });
    notes.push({
      level: 'info',
      text: `Current Pasternak inputs: G_p = ${gp.toFixed(0)} kN/m, G_s,avg = ${ksInfo.GsAvg.toFixed(0)} kPa, H_p = ${ksInfo.zInfluence.toFixed(2)} m, eta = ${ksInfo.gpEta.toFixed(2)}.`
    });
  }
  if ((config.loadPattern || 'uniform_full') === 'uniform_full') {
    notes.push({
      level: 'info',
        text: 'Uniform full-length load on a free Winkler beam can legitimately give nearly constant settlement w ≈ q/k and almost zero bending moment. If you want edge-driven or local bending, use a patch / point load case or a 2D plate model.'
    });
  }
  reinforcement.warnings.forEach((text) => notes.push({ level: 'warn', text }));
  return {
    limitState: 'SLS + ULS',
    ksInfo: {
      ...ksInfo,
      foundationModel: gp > 0 ? 'pasternak' : 'winkler',
      lambda,
      beta,
      betaL,
      classification
    },
    slsLoadMeta,
    ulsLoadMeta,
    sls,
    uls,
    reinforcement,
    notes
  };
}

export function stage6Constants() {
  return { gammaW: GAMMA_W, pRef: P_REF };
}
