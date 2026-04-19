// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
import { designSoilLayer } from './stage6-engineering';

const EPS = 1e-9;
const GEOM_EPS = 1e-6;
const GAMMA_W = 9.81;

const DEFAULT_MATERIAL_COLORS = [
  '#b68a60',
  '#7aa6c2',
  '#a67bbd',
  '#d6b26f',
  '#94b47b',
  '#d38d8d',
  '#8f9aa7',
  '#b7a27c'
];

const DEFAULT_SPENCER_CONFIG = {
  recheckCount: 10,
  lambdaLow: -0.6,
  lambdaHigh: 0.6,
  lambdaTolerance: 0.001,
  FfTolerance: 0.001,
  FfBracketLow: 0.1,
  FfBracketHigh: 10.0,
  maxOuterIter: 30,
  maxInnerIter: 50,
  useNewton: false,
  fallbackBishop: true
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function sqr(v) {
  return v * v;
}

function dist(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

function normalize(vec) {
  const len = Math.hypot(vec.x, vec.y) || 1;
  return { x: vec.x / len, y: vec.y / len };
}

function uniqueSorted(values, tol = GEOM_EPS) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out = [];
  sorted.forEach((value) => {
    if (!out.length || Math.abs(value - out[out.length - 1]) > tol) out.push(value);
  });
  return out;
}

function sampleArray(xs, n) {
  if (n <= 1) return [xs[0]];
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(lerp(xs[0], xs[1], i / (n - 1)));
  }
  return out;
}

export function terrainY(polyline, x) {
  const verts = polyline?.vertices || [];
  if (!verts.length) return 0;
  if (x <= verts[0].x) return verts[0].y;
  if (x >= verts[verts.length - 1].x) return verts[verts.length - 1].y;
  let lo = 0;
  let hi = verts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (verts[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const a = verts[lo];
  const b = verts[lo + 1];
  const t = Math.abs(b.x - a.x) < EPS ? 0 : (x - a.x) / (b.x - a.x);
  return lerp(a.y, b.y, t);
}

function clampXToTerrain(terrain, x) {
  const verts = terrain?.vertices || [];
  if (!verts.length) return x;
  return clamp(x, verts[0].x, verts[verts.length - 1].x);
}

function polylineLevelIntersectionsX(terrain, levelY) {
  const verts = terrain?.vertices || [];
  const out = [];
  for (let i = 0; i < verts.length - 1; i += 1) {
    const a = verts[i];
    const b = verts[i + 1];
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    if (levelY < minY - GEOM_EPS || levelY > maxY + GEOM_EPS) continue;
    if (Math.abs(b.y - a.y) < EPS) {
      if (Math.abs(levelY - a.y) < GEOM_EPS) {
        out.push(a.x, b.x);
      }
      continue;
    }
    const t = (levelY - a.y) / (b.y - a.y);
    if (t >= -GEOM_EPS && t <= 1 + GEOM_EPS) out.push(lerp(a.x, b.x, t));
  }
  return out;
}

function bandUpperYAt(x, terrain, topY, topFollowsTerrain) {
  const terrainVal = terrainY(terrain, x);
  return topFollowsTerrain ? terrainVal : Math.min(terrainVal, topY);
}

function bandLowerYAt(x, terrain, botY) {
  return Math.min(terrainY(terrain, x), botY);
}

function thicknessBelowWater(bot, top, waterY) {
  if (waterY == null || !Number.isFinite(waterY)) return 0;
  const low = bot;
  const high = top;
  if (waterY <= low) return 0;
  return Math.max(0, Math.min(high, waterY) - low);
}

function polygonArea(points) {
  if (!points?.length || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return 0.5 * sum;
}

function buildHorizontalBandPolygons(terrain, topY, botY, topFollowsTerrain) {
  const verts = terrain?.vertices || [];
  if (verts.length < 2) return [];
  const xCandidates = [
    verts[0].x,
    verts[verts.length - 1].x,
    ...verts.map((v) => v.x),
    ...polylineLevelIntersectionsX(terrain, botY)
  ];
  if (!topFollowsTerrain && Number.isFinite(topY)) {
    xCandidates.push(...polylineLevelIntersectionsX(terrain, topY));
  }
  const xs = uniqueSorted(xCandidates);
  const polygons = [];
  let current = [];

  function flushCurrent() {
    if (current.length < 2) {
      current = [];
      return;
    }
    const upper = current.map((x) => ({ x, y: bandUpperYAt(x, terrain, topY, topFollowsTerrain) }));
    const lower = [...current]
      .reverse()
      .map((x) => ({ x, y: bandLowerYAt(x, terrain, botY) }));
    const poly = [...upper, ...lower];
    if (Math.abs(polygonArea(poly)) > 1e-4) polygons.push(poly);
    current = [];
  }

  for (let i = 0; i < xs.length - 1; i += 1) {
    const xA = xs[i];
    const xB = xs[i + 1];
    const xMid = 0.5 * (xA + xB);
    const upperMid = bandUpperYAt(xMid, terrain, topY, topFollowsTerrain);
    const lowerMid = bandLowerYAt(xMid, terrain, botY);
    if (upperMid > lowerMid + GEOM_EPS) {
      if (!current.length) current.push(xA);
      current.push(xB);
    } else if (current.length) {
      flushCurrent();
    }
  }
  if (current.length) flushCurrent();
  return polygons;
}

function baseMaterialAt(model, x, yBase) {
  const probeY = yBase + 0.05;
  const terrainVal = terrainY(model.terrain, x);
  if (probeY > terrainVal) return null;
  for (let i = 0; i < model.bands.length; i += 1) {
    const band = model.bands[i];
    const upper = bandUpperYAt(x, model.terrain, band.topY, band.topFollowsTerrain);
    const lower = bandLowerYAt(x, model.terrain, band.botY);
    if (probeY <= upper + GEOM_EPS && probeY >= lower - GEOM_EPS && upper > lower + GEOM_EPS) {
      return band.material;
    }
  }
  return model.bands[model.bands.length - 1]?.material || null;
}

function deriveBandContributionAtX(model, band, x, yBase) {
  const yTop = terrainY(model.terrain, x);
  const upper = bandUpperYAt(x, model.terrain, band.topY, band.topFollowsTerrain);
  const lower = bandLowerYAt(x, model.terrain, band.botY);
  const overlapTop = Math.min(yTop, upper);
  const overlapBot = Math.max(yBase, lower);
  const total = Math.max(0, overlapTop - overlapBot);
  if (total <= 0) return { thickness: 0, weightPerWidth: 0 };
  const waterY = model.phreatic ? terrainY(model.phreatic, x) : null;
  const belowWater = thicknessBelowWater(overlapBot, overlapTop, waterY);
  const aboveWater = total - belowWater;
  const gammaDry = Number.isFinite(band.material.gamma) ? band.material.gamma : 18;
  const gammaSat = Number.isFinite(band.material.gammaSat) ? band.material.gammaSat : gammaDry + 2;
  return {
    thickness: total,
    weightPerWidth: aboveWater * gammaDry + belowWater * gammaSat
  };
}

function simpsonIntegrate(dx, left, mid, right) {
  return (dx / 6) * (left + 4 * mid + right);
}

function circleYLower(circle, x) {
  const dx = x - circle.center.x;
  const rem = circle.radius * circle.radius - dx * dx;
  if (rem < 0) return NaN;
  return circle.center.y - Math.sqrt(Math.max(rem, 0));
}

function circleYUpper(circle, x) {
  const dx = x - circle.center.x;
  const rem = circle.radius * circle.radius - dx * dx;
  if (rem < 0) return NaN;
  return circle.center.y + Math.sqrt(Math.max(rem, 0));
}

function circleYOnBranch(circle, x, branch) {
  return branch === 'upper' ? circleYUpper(circle, x) : circleYLower(circle, x);
}

function circleSlopeLower(circle, x) {
  const dx = x - circle.center.x;
  const rem = circle.radius * circle.radius - dx * dx;
  const root = Math.sqrt(Math.max(rem, 1e-12));
  return dx / root;
}

function circleSlopeUpper(circle, x) {
  return -circleSlopeLower(circle, x);
}

function circleSlopeOnBranch(circle, x, branch) {
  return branch === 'upper' ? circleSlopeUpper(circle, x) : circleSlopeLower(circle, x);
}

function activeCircleBranch(circle) {
  return circle?.branch === 'upper' ? 'upper' : 'lower';
}

function circleYActive(circle, x) {
  return circleYOnBranch(circle, x, activeCircleBranch(circle));
}

function circleSlopeActive(circle, x) {
  return circleSlopeOnBranch(circle, x, activeCircleBranch(circle));
}

function baseAngleRad(circle, x) {
  const moveSign = Math.sign((circle?.exitPoint?.x || 0) - (circle?.entryPoint?.x || 0)) || 1;
  return Math.atan(-circleSlopeActive(circle, x) * moveSign);
}

function circlePolylineIntersections(circle, polyline) {
  const verts = polyline?.vertices || [];
  const hits = [];
  for (let i = 0; i < verts.length - 1; i += 1) {
    const p1 = verts[i];
    const p2 = verts[i + 1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const fx = p1.x - circle.center.x;
    const fy = p1.y - circle.center.y;
    const a = dx * dx + dy * dy;
    const b = 2 * (fx * dx + fy * dy);
    const c = fx * fx + fy * fy - circle.radius * circle.radius;
    const disc = b * b - 4 * a * c;
    if (disc < -GEOM_EPS) continue;
    const sqrtDisc = Math.sqrt(Math.max(disc, 0));
    const roots = [(-b - sqrtDisc) / (2 * a), (-b + sqrtDisc) / (2 * a)];
    roots.forEach((t) => {
      if (t < -GEOM_EPS || t > 1 + GEOM_EPS) return;
      const tt = clamp(t, 0, 1);
      const pt = { x: p1.x + dx * tt, y: p1.y + dy * tt };
      if (!hits.some((h) => dist(h, pt) < 1e-5)) hits.push(pt);
    });
  }
  return hits.sort((a, b) => a.x - b.x);
}

function countDistinct(points, tol = 1e-5) {
  const out = [];
  points.forEach((pt) => {
    if (!out.some((other) => dist(other, pt) < tol)) out.push(pt);
  });
  return out.length;
}

function zoneSamplePoints(terrain, zone, n) {
  const x0 = Math.min(zone.xStart, zone.xEnd);
  const x1 = Math.max(zone.xStart, zone.xEnd);
  return sampleArray([x0, x1], Math.max(2, n)).map((x) => ({ x, y: terrainY(terrain, x) }));
}

function intervalOverlapWidth(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

function surfaceLoadContribution(surfaceLoad, xL, xR) {
  if (!surfaceLoad || !Number.isFinite(surfaceLoad.q) || surfaceLoad.q <= 0) {
    return { width: 0, force: 0 };
  }
  const width = intervalOverlapWidth(xL, xR, surfaceLoad.xStart, surfaceLoad.xEnd);
  return {
    width,
    force: width * surfaceLoad.q
  };
}

function sliceVerticalLoad(slice) {
  return Number.isFinite(slice?.V) ? slice.V : slice?.W || 0;
}

function branchEndpointError(circle, point, branch) {
  return Math.abs((Number(point?.y) || 0) - circleYOnBranch(circle, Number(point?.x) || 0, branch));
}

function resolveActiveBranch(circle, entry, exit, terrain, xStart, xEnd, validationSamples = 30, geomTol = 1e-3) {
  const xs = sampleArray([xStart, xEnd], Math.max(5, validationSamples));
  const endpointTol = Math.max(geomTol * 5, 1e-4);
  const branches = ['upper', 'lower']
    .map((branch) => {
      const entryError = branchEndpointError(circle, entry, branch);
      const exitError = branchEndpointError(circle, exit, branch);
      if (entryError > endpointTol || exitError > endpointTol) {
        return { branch, valid: false, sumY: -Infinity, maxThickness: 0, entryError, exitError };
      }
      let valid = true;
      let sumY = 0;
      let maxThickness = 0;
      for (let i = 1; i < xs.length - 1; i += 1) {
        const x = xs[i];
        const yArc = circleYOnBranch(circle, x, branch);
        const yGround = terrainY(terrain, x);
        if (!Number.isFinite(yArc) || yArc > yGround + geomTol) {
          valid = false;
          break;
        }
        sumY += yArc;
        maxThickness = Math.max(maxThickness, yGround - yArc);
      }
      return { branch, valid, sumY, maxThickness, entryError, exitError };
    })
    .filter((option) => option.valid);

  if (!branches.length) return null;
  branches.sort((a, b) => (a.entryError + a.exitError) - (b.entryError + b.exitError) || b.sumY - a.sumY);
  return branches[0].branch;
}

function maxSlipThickness(circle, terrain, xStart, xEnd, n) {
  let maxThickness = 0;
  const xs = sampleArray([xStart, xEnd], Math.max(3, n));
  xs.forEach((x) => {
    const thickness = terrainY(terrain, x) - circleYActive(circle, x);
    if (Number.isFinite(thickness)) maxThickness = Math.max(maxThickness, thickness);
  });
  return maxThickness;
}

function averagePorePressureOnBase(model, circle, xL, xR) {
  if (!model.phreatic?.vertices?.length) return 0;
  const gauss = [0.2113248654, 0.5, 0.7886751346];
  let sum = 0;
  gauss.forEach((f) => {
    const x = lerp(xL, xR, f);
    const y = circleYActive(circle, x);
    const water = terrainY(model.phreatic, x);
    sum += Math.max((water - y) * GAMMA_W, 0);
  });
  return sum / gauss.length;
}

function mergeShortIntervals(xs, minSliceWidth) {
  let arr = uniqueSorted(xs);
  if (arr.length < 2) return arr;
  let changed = true;
  while (changed && arr.length > 2) {
    changed = false;
    for (let i = 0; i < arr.length - 1; i += 1) {
      if (arr[i + 1] - arr[i] >= minSliceWidth - GEOM_EPS) continue;
      if (i === 0) arr.splice(1, 1);
      else if (i === arr.length - 2) arr.splice(i, 1);
      else {
        const left = arr[i] - arr[i - 1];
        const right = arr[i + 2] - arr[i + 1];
        if (left >= right) arr.splice(i + 1, 1);
        else arr.splice(i, 1);
      }
      changed = true;
      break;
    }
  }
  return arr;
}

function computeSliceBreaks(circle, entry, exit, model, searchConfig) {
  const xStart = entry.x;
  const xEnd = exit.x;
  const span = Math.abs(xEnd - xStart);
  const minSliceWidth = Math.max(searchConfig.minSliceWidth || span / 300, 0.05);
  const cuts = [xStart, xEnd];
  const backbone = Math.max(3, searchConfig.targetSlices || 30);
  for (let i = 1; i < backbone; i += 1) cuts.push(lerp(xStart, xEnd, i / backbone));

  (model.terrain?.vertices || []).forEach((pt) => {
    if (pt.x > xStart + GEOM_EPS && pt.x < xEnd - GEOM_EPS) cuts.push(pt.x);
  });
  (model.phreatic?.vertices || []).forEach((pt) => {
    if (pt.x > xStart + GEOM_EPS && pt.x < xEnd - GEOM_EPS) cuts.push(pt.x);
  });

  model.boundaryYs.forEach((levelY) => {
    const delta = circle.radius * circle.radius - sqr(circle.center.y - levelY);
    if (delta < GEOM_EPS) return;
    const root = Math.sqrt(delta);
    [circle.center.x - root, circle.center.x + root].forEach((x) => {
      if (x > xStart + GEOM_EPS && x < xEnd - GEOM_EPS) cuts.push(x);
    });
  });

  if (model.phreatic?.vertices?.length) {
    circlePolylineIntersections(circle, model.phreatic).forEach((pt) => {
      if (pt.x > xStart + GEOM_EPS && pt.x < xEnd - GEOM_EPS) cuts.push(pt.x);
    });
  }

  if (model.surfaceLoad) {
    [model.surfaceLoad.xStart, model.surfaceLoad.xEnd].forEach((x) => {
      if (x > xStart + GEOM_EPS && x < xEnd - GEOM_EPS) cuts.push(x);
    });
  }

  return mergeShortIntervals(cuts, minSliceWidth);
}

function buildSlicesForCircle(circle, entry, exit, model, searchConfig) {
  const xBreaks = computeSliceBreaks(circle, entry, exit, model, searchConfig);
  const slices = [];
  const minSliceWidth = Math.max(searchConfig.minSliceWidth || Math.abs(exit.x - entry.x) / 300, 0.05);

  for (let i = 0; i < xBreaks.length - 1; i += 1) {
    const xL = xBreaks[i];
    const xR = xBreaks[i + 1];
    const dx = xR - xL;
    if (dx < minSliceWidth - GEOM_EPS) continue;

    const xMid = 0.5 * (xL + xR);
    const yTopL = terrainY(model.terrain, xL);
    const yTopR = terrainY(model.terrain, xR);
    const yTopMid = terrainY(model.terrain, xMid);
    const yBaseL = circleYActive(circle, xL);
    const yBaseR = circleYActive(circle, xR);
    const yBaseMid = circleYActive(circle, xMid);
    if (![yBaseL, yBaseR, yBaseMid].every(Number.isFinite)) continue;

    const slope = circleSlopeActive(circle, xMid);
    const alpha = baseAngleRad(circle, xMid);
    if (alpha >= (89 * Math.PI) / 180) return { slices: null, reason: 'base angle too steep' };
    const baseLength = dx / Math.max(Math.cos(alpha), 1e-6);

    const baseMaterial = baseMaterialAt(model, xMid, yBaseMid);
    if (!baseMaterial) return { slices: null, reason: 'cannot identify base material' };

    let totalWeight = 0;
    const layerAreas = [];
    model.bands.forEach((band) => {
      const left = deriveBandContributionAtX(model, band, xL, yBaseL);
      const mid = deriveBandContributionAtX(model, band, xMid, yBaseMid);
      const right = deriveBandContributionAtX(model, band, xR, yBaseR);
      const area = simpsonIntegrate(dx, left.thickness, mid.thickness, right.thickness);
      const weight = simpsonIntegrate(dx, left.weightPerWidth, mid.weightPerWidth, right.weightPerWidth);
      if (area > 1e-5) {
        layerAreas.push({
          materialId: band.material.id,
          label: band.material.label,
          area,
          weight
        });
      }
      totalWeight += weight;
    });

    if (totalWeight <= 0) continue;

    const surcharge = surfaceLoadContribution(model.surfaceLoad, xL, xR);
    const totalVertical = totalWeight + surcharge.force;

    const uBase = averagePorePressureOnBase(model, circle, xL, xR);

    slices.push({
      index: slices.length,
      xL,
      xR,
      dx,
      xMid,
      yTopL,
      yTopR,
      yTopMid,
      yBaseL,
      yBaseR,
      yBaseMid,
      area: simpsonIntegrate(
        dx,
        Math.max(yTopL - yBaseL, 0),
        Math.max(yTopMid - yBaseMid, 0),
        Math.max(yTopR - yBaseR, 0)
      ),
      W: totalWeight,
      Q: surcharge.force,
      V: totalVertical,
      loadWidth: surcharge.width,
      alphaRad: alpha,
      baseLength,
      uBase,
      baseMaterial,
      layerAreas
    });
  }

  return { slices, reason: '' };
}

function ordinarySeed(slices) {
  let numerator = 0;
  let denominator = 0;
  slices.forEach((slice) => {
    const c = slice.baseMaterial.cEff;
    const phi = (slice.baseMaterial.phiEffDeg * Math.PI) / 180;
    const tanPhi = Math.tan(phi);
    const V = sliceVerticalLoad(slice);
    numerator += c * slice.dx + (V - slice.uBase * slice.dx) * tanPhi;
    denominator += V * Math.sin(slice.alphaRad);
  });
  if (denominator <= EPS) return 1;
  const seed = numerator / denominator;
  return Number.isFinite(seed) && seed > 0 ? seed : 1;
}

function buildDiagnostics(slices, F, iterations) {
  const sliceNormals = [];
  const sliceMobilizedShears = [];
  const sliceMAlpha = [];

  slices.forEach((slice) => {
    const c = slice.baseMaterial.cEff;
    const phi = (slice.baseMaterial.phiEffDeg * Math.PI) / 180;
    const tanPhi = Math.tan(phi);
    const V = sliceVerticalLoad(slice);
    const mAlpha = Math.cos(slice.alphaRad) + (Math.sin(slice.alphaRad) * tanPhi) / F;
    const N =
      (V -
        ((c * slice.dx - slice.uBase * slice.dx * tanPhi) * Math.sin(slice.alphaRad)) / F) /
      mAlpha;
    const T = (c * slice.dx + (N - slice.uBase * slice.dx) * tanPhi) / F;
    sliceNormals.push(N);
    sliceMobilizedShears.push(T);
    sliceMAlpha.push(mAlpha);
  });

  return {
    converged: true,
    FS: F,
    F: F,
    F_fellenius: ordinarySeed(slices),
    iterations,
    reason: '',
    sliceNormals,
    sliceMobilizedShears,
    sliceMAlpha
  };
}

function cloneSlicesForSolver(slices) {
  return (slices || []).map((slice) => ({
    ...slice,
    baseMaterial: slice?.baseMaterial ? { ...slice.baseMaterial } : slice.baseMaterial,
    layerAreas: Array.isArray(slice?.layerAreas) ? slice.layerAreas.map((item) => ({ ...item })) : []
  }));
}

function enrichBishopSlices(slices, diagnostics) {
  return (slices || []).map((slice, index) => ({
    ...slice,
    mAlpha: diagnostics?.sliceMAlpha?.[index] ?? null,
    normalForce: diagnostics?.sliceNormals?.[index] ?? null,
    mobilizedShear: diagnostics?.sliceMobilizedShears?.[index] ?? null,
    E_right: null,
    X_right: null,
    N_eff: null,
    S_mob: null,
    theta_interslice: null
  }));
}

function buildBishopSearchResult(circle, slices, bishopDiagnostics) {
  const F = bishopDiagnostics?.FS ?? bishopDiagnostics?.F ?? null;
  return {
    circle,
    entry: circle?.entryPoint || null,
    exit: circle?.exitPoint || null,
    method: 'bishop_simplified',
    methodLabel: 'Bishop simplified',
    FS: F,
    F,
    F_bishop: F,
    F_m: F,
    F_f: null,
    F_fellenius: bishopDiagnostics?.F_fellenius ?? ordinarySeed(slices),
    lambda: null,
    thetaDeg: null,
    theta_deg: null,
    maxE: null,
    tensionSlices: 0,
    iterations: bishopDiagnostics?.iterations ?? 0,
    converged: !!bishopDiagnostics?.converged,
    reason: bishopDiagnostics?.reason || '',
    spencerAttempted: false,
    spencerConverged: false,
    spencerRejectReason: '',
    diagnostics: {
      bishop: bishopDiagnostics
    },
    slices: enrichBishopSlices(slices, bishopDiagnostics)
  };
}

function normalizedForceResidualScale(slices) {
  const scale =
    (slices || []).reduce(
      (sum, slice) => sum + Math.abs(sliceVerticalLoad(slice) * Math.sin(slice.alphaRad)),
      0
    ) / Math.max((slices || []).length, 1);
  return Math.max(scale, 1);
}

function normalizeSpencerConfig(config, searchConfig) {
  const merged = {
    ...DEFAULT_SPENCER_CONFIG,
    ...(config || {})
  };
  const keepBest = Math.max(1, Math.round(searchConfig?.keepBest || DEFAULT_SPENCER_CONFIG.recheckCount));
  merged.recheckCount = Math.max(1, Math.min(Math.round(merged.recheckCount || keepBest), keepBest));
  merged.lambdaLow = Number.isFinite(+merged.lambdaLow) ? +merged.lambdaLow : DEFAULT_SPENCER_CONFIG.lambdaLow;
  merged.lambdaHigh = Number.isFinite(+merged.lambdaHigh) ? +merged.lambdaHigh : DEFAULT_SPENCER_CONFIG.lambdaHigh;
  if (merged.lambdaHigh <= merged.lambdaLow) merged.lambdaHigh = merged.lambdaLow + 0.1;
  merged.lambdaTolerance = Math.max(
    Number.isFinite(+merged.lambdaTolerance) ? +merged.lambdaTolerance : DEFAULT_SPENCER_CONFIG.lambdaTolerance,
    1e-6
  );
  merged.FfTolerance = Math.max(
    Number.isFinite(+merged.FfTolerance) ? +merged.FfTolerance : DEFAULT_SPENCER_CONFIG.FfTolerance,
    1e-6
  );
  merged.FfBracketLow = Math.max(
    Number.isFinite(+merged.FfBracketLow) ? +merged.FfBracketLow : DEFAULT_SPENCER_CONFIG.FfBracketLow,
    0.01
  );
  merged.FfBracketHigh = Math.max(
    Number.isFinite(+merged.FfBracketHigh) ? +merged.FfBracketHigh : DEFAULT_SPENCER_CONFIG.FfBracketHigh,
    merged.FfBracketLow + 0.1
  );
  merged.maxOuterIter = Math.max(
    5,
    Math.round(Number.isFinite(+merged.maxOuterIter) ? +merged.maxOuterIter : DEFAULT_SPENCER_CONFIG.maxOuterIter)
  );
  merged.maxInnerIter = Math.max(
    5,
    Math.round(Number.isFinite(+merged.maxInnerIter) ? +merged.maxInnerIter : DEFAULT_SPENCER_CONFIG.maxInnerIter)
  );
  merged.useNewton = !!merged.useNewton;
  merged.fallbackBishop = merged.fallbackBishop !== false;
  return merged;
}

function solveSpencerForceChain(slices, lambda, FTrial, solverConfig) {
  const sliceForces = [];
  let ELeft = 0;
  let maxE = 0;
  let tensionSlices = 0;
  const theta = Math.atan(lambda);
  const residualScale = normalizedForceResidualScale(slices);

  for (let i = 0; i < slices.length; i += 1) {
    const slice = slices[i];
    const sinA = Math.sin(slice.alphaRad);
    const cosA = Math.cos(slice.alphaRad);
    const tanA = sinA / Math.max(cosA, 1e-9);
    const tanPhi = Math.tan((Number(slice.baseMaterial?.phiEffDeg) * Math.PI) / 180);
    const cohesion = Number(slice.baseMaterial?.cEff) || 0;
    const porePressure = Number(slice.uBase) || 0;
    const width = Number(slice.dx) || 0;
    const baseLength = Number(slice.baseLength) || width / Math.max(cosA, 1e-6);
    const vertical = sliceVerticalLoad(slice);
    const mAlpha = cosA + (sinA * tanPhi) / FTrial;
    if (!Number.isFinite(mAlpha) || Math.abs(mAlpha) <= (solverConfig.minMAlpha || 1e-6)) {
      return {
        valid: false,
        reason: 'spencer m_alpha <= 0',
        E_final: NaN,
        normalizedResidual: Infinity,
        residualScale,
        maxE,
        tensionSlices,
        sliceForces
      };
    }

    const a1 = -sinA + (tanPhi * cosA) / FTrial;
    const a0 = ELeft - porePressure * width * tanA + (cohesion * width) / FTrial;
    const denomN = mAlpha + lambda * a1;
    if (!Number.isFinite(denomN) || Math.abs(denomN) <= (solverConfig.minMAlpha || 1e-6)) {
      return {
        valid: false,
        reason: 'spencer denominator <= 0',
        E_final: NaN,
        normalizedResidual: Infinity,
        residualScale,
        maxE,
        tensionSlices,
        sliceForces
      };
    }

    const numerN =
      vertical +
      lambda * ELeft -
      lambda * a0 -
      porePressure * width -
      (cohesion * width * tanA) / FTrial;
    const N_eff = numerN / denomN;
    const S_mob = (cohesion * baseLength + N_eff * tanPhi) / FTrial;
    const E_right = a0 + a1 * N_eff;
    const X_right = lambda * E_right;
    if (![N_eff, S_mob, E_right, X_right].every(Number.isFinite)) {
      return {
        valid: false,
        reason: 'spencer invalid force state',
        E_final: NaN,
        normalizedResidual: Infinity,
        residualScale,
        maxE,
        tensionSlices,
        sliceForces
      };
    }

    if (N_eff < 0) tensionSlices += 1;
    maxE = Math.max(maxE, Math.abs(E_right));
    sliceForces.push({
      N_eff,
      S_mob,
      E_right,
      X_right,
      mAlpha,
      theta_interslice: theta
    });
    ELeft = E_right;
  }

  return {
    valid: true,
    reason: '',
    E_final: ELeft,
    normalizedResidual: Math.abs(ELeft) / residualScale,
    residualScale,
    maxE,
    tensionSlices,
    sliceForces
  };
}

function computeSpencerForceEquilibriumF(slices, lambda, spencerConfig, solverConfig) {
  let FLo = spencerConfig.FfBracketLow;
  let FHi = spencerConfig.FfBracketHigh;
  let resLo = solveSpencerForceChain(slices, lambda, FLo, solverConfig);
  let resHi = solveSpencerForceChain(slices, lambda, FHi, solverConfig);
  let lastValid = null;

  if (!resLo.valid || !resHi.valid || Math.sign(resLo.E_final) === Math.sign(resHi.E_final)) {
    const wideLo = Math.min(0.01, FLo);
    const wideHi = Math.max(20.0, FHi);
    const resLoWide = solveSpencerForceChain(slices, lambda, wideLo, solverConfig);
    const resHiWide = solveSpencerForceChain(slices, lambda, wideHi, solverConfig);
    if (
      resLoWide.valid &&
      resHiWide.valid &&
      Math.sign(resLoWide.E_final) !== Math.sign(resHiWide.E_final)
    ) {
      FLo = wideLo;
      FHi = wideHi;
      resLo = resLoWide;
      resHi = resHiWide;
    } else {
      return {
        F_f: NaN,
        converged: false,
        reason: !resLo.valid || !resHi.valid ? 'force equilibrium bracket invalid' : 'force equilibrium not bracketed',
        sliceForces: [],
        iterations: 0,
        maxE: 0,
        tensionSlices: 0
      };
    }
  }

  if (Math.abs(resLo.E_final) <= spencerConfig.FfTolerance * resLo.residualScale) {
    return {
      F_f: FLo,
      converged: true,
      reason: '',
      sliceForces: resLo.sliceForces,
      iterations: 0,
      maxE: resLo.maxE,
      tensionSlices: resLo.tensionSlices
    };
  }
  if (Math.abs(resHi.E_final) <= spencerConfig.FfTolerance * resHi.residualScale) {
    return {
      F_f: FHi,
      converged: true,
      reason: '',
      sliceForces: resHi.sliceForces,
      iterations: 0,
      maxE: resHi.maxE,
      tensionSlices: resHi.tensionSlices
    };
  }

  for (let iter = 1; iter <= spencerConfig.maxInnerIter; iter += 1) {
    const FMid = 0.5 * (FLo + FHi);
    const resMid = solveSpencerForceChain(slices, lambda, FMid, solverConfig);
    if (!resMid.valid) {
      return {
        F_f: lastValid?.F_f ?? NaN,
        converged: false,
        reason: resMid.reason || 'force equilibrium invalid state',
        sliceForces: lastValid?.sliceForces || [],
        iterations: iter,
        maxE: lastValid?.maxE ?? 0,
        tensionSlices: lastValid?.tensionSlices ?? 0
      };
    }

    lastValid = {
      F_f: FMid,
      sliceForces: resMid.sliceForces,
      maxE: resMid.maxE,
      tensionSlices: resMid.tensionSlices
    };

    if (Math.abs(resMid.E_final) <= spencerConfig.FfTolerance * resMid.residualScale) {
      return {
        F_f: FMid,
        converged: true,
        reason: '',
        sliceForces: resMid.sliceForces,
        iterations: iter,
        maxE: resMid.maxE,
        tensionSlices: resMid.tensionSlices
      };
    }

    if (Math.sign(resMid.E_final) === Math.sign(resLo.E_final)) {
      FLo = FMid;
      resLo = resMid;
    } else {
      FHi = FMid;
      resHi = resMid;
    }

    if (Math.abs(FHi - FLo) <= spencerConfig.FfTolerance) {
      const FFinal = 0.5 * (FLo + FHi);
      return {
        F_f: FFinal,
        converged: true,
        reason: '',
        sliceForces: resMid.sliceForces,
        iterations: iter,
        maxE: resMid.maxE,
        tensionSlices: resMid.tensionSlices
      };
    }
  }

  return {
    F_f: 0.5 * (FLo + FHi),
    converged: false,
    reason: 'force equilibrium did not converge',
    sliceForces: lastValid?.sliceForces || [],
    iterations: spencerConfig.maxInnerIter,
    maxE: lastValid?.maxE ?? 0,
    tensionSlices: lastValid?.tensionSlices ?? 0
  };
}

function evaluateSpencerAtLambda(slices, bishopDiagnostics, lambda, spencerConfig, solverConfig) {
  const forceEq = computeSpencerForceEquilibriumF(slices, lambda, spencerConfig, solverConfig);
  if (!forceEq.converged || !Number.isFinite(forceEq.F_f)) {
    return {
      lambda,
      valid: false,
      value: NaN,
      F_f: forceEq.F_f,
      forceEq
    };
  }
  const Fm = bishopDiagnostics?.FS ?? bishopDiagnostics?.F ?? NaN;
  return {
    lambda,
    valid: true,
    value: Fm - forceEq.F_f,
    F_f: forceEq.F_f,
    forceEq
  };
}

function findSpencerLambdaBracket(slices, bishopDiagnostics, spencerConfig, solverConfig) {
  const samples = uniqueSorted([
    spencerConfig.lambdaLow,
    spencerConfig.lambdaHigh,
    -0.3,
    0,
    0.3,
    ...sampleArray([spencerConfig.lambdaLow, spencerConfig.lambdaHigh], 13)
  ]);
  let previousValid = null;
  let best = null;

  for (let i = 0; i < samples.length; i += 1) {
    const current = evaluateSpencerAtLambda(
      slices,
      bishopDiagnostics,
      samples[i],
      spencerConfig,
      solverConfig
    );
    if (!current.valid) continue;
    if (!best || Math.abs(current.value) < Math.abs(best.value)) best = current;
    if (Math.abs(current.value) <= spencerConfig.lambdaTolerance) {
      return { exact: current, lower: null, upper: null, best };
    }
    if (previousValid && Math.sign(previousValid.value) !== Math.sign(current.value)) {
      return { exact: null, lower: previousValid, upper: current, best };
    }
    previousValid = current;
  }

  return { exact: null, lower: null, upper: null, best };
}

function finalizeSpencerSlices(baseSlices, sliceForces, lambda) {
  const theta = Math.atan(lambda);
  return (baseSlices || []).map((slice, index) => {
    const forceState = sliceForces?.[index];
    if (!forceState) return { ...slice };
    return {
      ...slice,
      normalForce: forceState.N_eff,
      mobilizedShear: forceState.S_mob,
      E_right: forceState.E_right,
      X_right: forceState.X_right,
      N_eff: forceState.N_eff,
      S_mob: forceState.S_mob,
      mAlpha: forceState.mAlpha ?? slice.mAlpha,
      theta_interslice: Number.isFinite(forceState.theta_interslice)
        ? forceState.theta_interslice
        : theta
    };
  });
}

function solveSpencerForSlices(slices, bishopDiagnostics, spencerConfig, solverConfig) {
  const bishopF = bishopDiagnostics?.FS ?? bishopDiagnostics?.F ?? null;
  if (!bishopDiagnostics?.converged || !Number.isFinite(bishopF) || bishopF <= 0) {
    return {
      converged: false,
      F: bishopF,
      F_m: bishopF,
      F_f: NaN,
      lambda: null,
      thetaDeg: null,
      maxE: 0,
      tensionSlices: 0,
      sliceForces: [],
      iterations: 0,
      reason: 'Bishop moment equilibrium did not converge'
    };
  }

  const bracket = findSpencerLambdaBracket(slices, bishopDiagnostics, spencerConfig, solverConfig);
  if (bracket.exact) {
    const thetaDeg = (Math.atan(bracket.exact.lambda) * 180) / Math.PI;
    return {
      converged: true,
      F: 0.5 * (bishopF + bracket.exact.F_f),
      F_m: bishopF,
      F_f: bracket.exact.F_f,
      lambda: bracket.exact.lambda,
      thetaDeg,
      maxE: bracket.exact.forceEq.maxE,
      tensionSlices: bracket.exact.forceEq.tensionSlices,
      sliceForces: bracket.exact.forceEq.sliceForces,
      iterations: 0,
      reason: ''
    };
  }

  if (!bracket.lower || !bracket.upper) {
    return {
      converged: false,
      F: spencerConfig.fallbackBishop ? bishopF : bracket.best ? 0.5 * (bishopF + bracket.best.F_f) : bishopF,
      F_m: bishopF,
      F_f: bracket.best?.F_f ?? NaN,
      lambda: bracket.best?.lambda ?? null,
      thetaDeg: Number.isFinite(bracket.best?.lambda) ? (Math.atan(bracket.best.lambda) * 180) / Math.PI : null,
      maxE: bracket.best?.forceEq?.maxE ?? 0,
      tensionSlices: bracket.best?.forceEq?.tensionSlices ?? 0,
      sliceForces: bracket.best?.forceEq?.sliceForces || [],
      iterations: 0,
      reason: bracket.best ? 'F_m and F_f do not intersect in lambda range' : 'force equilibrium failed across lambda range'
    };
  }

  let lower = bracket.lower;
  let upper = bracket.upper;
  let best = bracket.best || (Math.abs(lower.value) <= Math.abs(upper.value) ? lower : upper);

  for (let iter = 1; iter <= spencerConfig.maxOuterIter; iter += 1) {
    const lambdaMid = 0.5 * (lower.lambda + upper.lambda);
    const mid = evaluateSpencerAtLambda(slices, bishopDiagnostics, lambdaMid, spencerConfig, solverConfig);
    if (!mid.valid) {
      return {
        converged: false,
        F: spencerConfig.fallbackBishop ? bishopF : 0.5 * (bishopF + (best?.F_f ?? bishopF)),
        F_m: bishopF,
        F_f: best?.F_f ?? NaN,
        lambda: best?.lambda ?? null,
        thetaDeg: Number.isFinite(best?.lambda) ? (Math.atan(best.lambda) * 180) / Math.PI : null,
        maxE: best?.forceEq?.maxE ?? 0,
        tensionSlices: best?.forceEq?.tensionSlices ?? 0,
        sliceForces: best?.forceEq?.sliceForces || [],
        iterations: iter,
        reason: mid.forceEq?.reason || 'force equilibrium failed during lambda bisection'
      };
    }

    if (!best || Math.abs(mid.value) < Math.abs(best.value)) best = mid;

    if (
      Math.abs(mid.value) <= spencerConfig.lambdaTolerance ||
      Math.abs(upper.lambda - lower.lambda) <= spencerConfig.lambdaTolerance
    ) {
      const thetaDeg = (Math.atan(mid.lambda) * 180) / Math.PI;
      return {
        converged: true,
        F: 0.5 * (bishopF + mid.F_f),
        F_m: bishopF,
        F_f: mid.F_f,
        lambda: mid.lambda,
        thetaDeg,
        maxE: mid.forceEq.maxE,
        tensionSlices: mid.forceEq.tensionSlices,
        sliceForces: mid.forceEq.sliceForces,
        iterations: iter,
        reason: ''
      };
    }

    if (Math.sign(mid.value) === Math.sign(lower.value)) {
      lower = mid;
    } else {
      upper = mid;
    }
  }

  return {
    converged: false,
    F: spencerConfig.fallbackBishop ? bishopF : 0.5 * (bishopF + (best?.F_f ?? bishopF)),
    F_m: bishopF,
    F_f: best?.F_f ?? NaN,
    lambda: best?.lambda ?? null,
    thetaDeg: Number.isFinite(best?.lambda) ? (Math.atan(best.lambda) * 180) / Math.PI : null,
    maxE: best?.forceEq?.maxE ?? 0,
    tensionSlices: best?.forceEq?.tensionSlices ?? 0,
    sliceForces: best?.forceEq?.sliceForces || [],
    iterations: spencerConfig.maxOuterIter,
    reason: `outer lambda loop did not converge in ${spencerConfig.maxOuterIter} iterations`
  };
}

function applySpencerResult(baseResult, spencerResult) {
  const thetaDeg = Number.isFinite(spencerResult?.thetaDeg)
    ? spencerResult.thetaDeg
    : Number.isFinite(spencerResult?.lambda)
      ? (Math.atan(spencerResult.lambda) * 180) / Math.PI
      : null;
  if (!spencerResult?.converged) {
    return {
      ...baseResult,
      methodLabel: 'Bishop simplified',
      spencerAttempted: true,
      spencerConverged: false,
      spencerRejectReason: spencerResult?.reason || 'Spencer did not converge',
      lambda: spencerResult?.lambda ?? null,
      thetaDeg,
      theta_deg: thetaDeg,
      F_f: spencerResult?.F_f ?? null,
      maxE: spencerResult?.maxE ?? null,
      tensionSlices: spencerResult?.tensionSlices ?? 0,
      diagnostics: {
        ...baseResult.diagnostics,
        spencer: spencerResult
      }
    };
  }

  const slices = finalizeSpencerSlices(baseResult.slices, spencerResult.sliceForces, spencerResult.lambda);
  return {
    ...baseResult,
    method: 'spencer',
    methodLabel: 'Spencer',
    FS: spencerResult.F,
    F: spencerResult.F,
    F_m: spencerResult.F_m,
    F_f: spencerResult.F_f,
    lambda: spencerResult.lambda,
    thetaDeg,
    theta_deg: thetaDeg,
    maxE: spencerResult.maxE,
    tensionSlices: spencerResult.tensionSlices,
    iterations: spencerResult.iterations,
    spencerAttempted: true,
    spencerConverged: true,
    spencerRejectReason: '',
    diagnostics: {
      ...baseResult.diagnostics,
      spencer: spencerResult
    },
    slices
  };
}

function solveBishopSimplified(slices, solverConfig) {
  let driving = 0;
  slices.forEach((slice) => {
    driving += sliceVerticalLoad(slice) * Math.sin(slice.alphaRad);
  });
  if (driving <= EPS) {
    return {
      converged: false,
      FS: null,
      iterations: 0,
      reason: 'nonpositive driving term',
      sliceNormals: [],
      sliceMobilizedShears: [],
      sliceMAlpha: []
    };
  }

  let F = ordinarySeed(slices);
  if (!Number.isFinite(F) || F <= 0) F = solverConfig.initialFS || 1;

  for (let iter = 1; iter <= (solverConfig.maxIterations || 50); iter += 1) {
    let resisting = 0;
    const mDiag = [];

    for (let i = 0; i < slices.length; i += 1) {
      const slice = slices[i];
      const c = slice.baseMaterial.cEff;
      const phi = (slice.baseMaterial.phiEffDeg * Math.PI) / 180;
      const tanPhi = Math.tan(phi);
      const V = sliceVerticalLoad(slice);
      const mAlpha = Math.cos(slice.alphaRad) + (Math.sin(slice.alphaRad) * tanPhi) / F;
      mDiag.push(mAlpha);
      if (mAlpha <= (solverConfig.minMAlpha || 1e-6)) {
        return {
          converged: false,
          FS: null,
          iterations: iter,
          reason: 'm_alpha <= 0',
          sliceNormals: [],
          sliceMobilizedShears: [],
          sliceMAlpha: mDiag
        };
      }
      resisting += (c * slice.dx + (V - slice.uBase * slice.dx) * tanPhi) / mAlpha;
    }

    const nextF = resisting / driving;
    if (!Number.isFinite(nextF) || nextF <= 0) {
      return {
        converged: false,
        FS: null,
        iterations: iter,
        reason: 'invalid FS',
        sliceNormals: [],
        sliceMobilizedShears: [],
        sliceMAlpha: mDiag
      };
    }
    if (Math.abs(nextF - F) < (solverConfig.tolerance || 1e-4)) {
      return buildDiagnostics(slices, nextF, iter);
    }
    F = nextF;
  }

  return {
    converged: false,
    FS: null,
    iterations: solverConfig.maxIterations || 50,
    reason: 'no convergence',
    sliceNormals: [],
    sliceMobilizedShears: [],
    sliceMAlpha: []
  };
}

function circleForEntryExit(entry, exit, center) {
  return {
    entryPoint: entry,
    exitPoint: exit,
    center,
    radius: dist(center, entry)
  };
}

function validateCircle(circle, model, searchConfig) {
  const entry = circle.entryPoint;
  const exit = circle.exitPoint;
  const moveSign = Math.sign(exit.x - entry.x) || 1;
  const geomTol = searchConfig.geomTol || 1e-3;
  const branch = resolveActiveBranch(circle, entry, exit, model.terrain, entry.x, exit.x, searchConfig.validationSamples || 30, geomTol);
  if (!branch) {
    return { valid: false, reason: 'arc above terrain' };
  }
  circle.branch = branch;
  const intersections = circlePolylineIntersections(circle, model.terrain).filter((pt) => {
    const minX = Math.min(entry.x, exit.x) - 1e-4;
    const maxX = Math.max(entry.x, exit.x) + 1e-4;
    return pt.x >= minX && pt.x <= maxX;
  });
  if (countDistinct(intersections, 1e-4) !== 2) {
    return { valid: false, reason: 'extra ground intersections' };
  }
  const endpointTol = Math.max(geomTol * 5, 1e-4);
  if(
    !intersections.some((pt)=>dist(pt, entry) <= endpointTol) ||
    !intersections.some((pt)=>dist(pt, exit) <= endpointTol)
  ){
    return { valid: false, reason: 'wrong daylight points' };
  }

  const n = Math.max(8, searchConfig.validationSamples || 30);
  const xs = sampleArray([entry.x, exit.x], n);
  let maxThickness = 0;
  for (let i = 1; i < xs.length - 1; i += 1) {
    const x = xs[i];
    const yArc = circleYActive(circle, x);
    const yGround = terrainY(model.terrain, x);
    if (!Number.isFinite(yArc) || yArc > yGround + geomTol) {
      return { valid: false, reason: 'arc above terrain' };
    }
    maxThickness = Math.max(maxThickness, yGround - yArc);
  }

  if (maxThickness < (searchConfig.minSlipThickness || 0.5)) {
    return { valid: false, reason: 'too shallow' };
  }

  const probeDx = Math.max(1e-4 * Math.abs(exit.x - entry.x), 1e-4);
  const xProbe = exit.x - moveSign * probeDx;
  const exitAngle = Math.abs(baseAngleRad(circle, xProbe));
  if ((exitAngle * 180) / Math.PI > (searchConfig.maxExitAngleDeg || 45)) {
    return { valid: false, reason: 'exit angle too steep' };
  }

  return { valid: true, reason: '' };
}

function summarizeCritical(result, model) {
  if (!result) return null;
  const xStart = result.circle.entryPoint.x;
  const xEnd = result.circle.exitPoint.x;
  const depth = maxSlipThickness(result.circle, model.terrain, xStart, xEnd, 50);
  return {
    maxDepth: depth,
    entry: result.circle.entryPoint,
    exit: result.circle.exitPoint,
    center: result.circle.center,
    radius: result.circle.radius
  };
}

export function analyzeBishopSearch(input, emitProgress) {
  const started = Date.now();
  const model = input.model;
  const search = input.searchConfig || {};
  const solver = input.solverConfig || {};
  const methodMode = input.methodMode === 'bishop_spencer' ? 'bishop_spencer' : 'bishop_only';
  const spencerConfig = normalizeSpencerConfig(input.spencerConfig, search);
  const entryPts = zoneSamplePoints(model.terrain, input.entryZone, Math.max(2, search.nEntry || 10));
  const exitPts = zoneSamplePoints(model.terrain, input.exitZone, Math.max(2, search.nExit || 10));
  const totalTrials = entryPts.length * exitPts.length * Math.max(2, search.nCenter || 15) * 2;

  let trial = 0;
  const results = [];
  const rejectionCounts = {};
  const progressEvery = Math.max(1, Math.min(10, Math.round(totalTrials / 150) || 1));

  function noteReject(reason) {
    rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
  }

  entryPts.forEach((entry) => {
    exitPts.forEach((exit) => {
      if (exit.x <= entry.x + GEOM_EPS) {
        noteReject('entry-exit order');
        return;
      }
      const chord = { x: exit.x - entry.x, y: exit.y - entry.y };
      const chordLen = Math.hypot(chord.x, chord.y);
      if (chordLen < (search.minChordLength || 2)) {
        noteReject('short chord');
        return;
      }
      const chordMid = { x: 0.5 * (entry.x + exit.x), y: 0.5 * (entry.y + exit.y) };
      const dir = normalize(chord);
      const bisector = { x: -dir.y, y: dir.x };
      const offsetMin = (search.centerOffsetMin || 0.5) * chordLen;
      const offsetMax = (search.centerOffsetMax || 3.0) * chordLen;
      const offsets = sampleArray([offsetMin, offsetMax], Math.max(2, search.nCenter || 15));

      [1, -1].forEach((sign) => {
        offsets.forEach((offset) => {
          trial += 1;
          const center = {
            x: chordMid.x + sign * offset * bisector.x,
            y: chordMid.y + sign * offset * bisector.y
          };
          const circle = circleForEntryExit(entry, exit, center);
          const validity = validateCircle(circle, model, search);
          if (!validity.valid) {
            noteReject(validity.reason);
          } else {
            const built = buildSlicesForCircle(circle, entry, exit, model, search);
            if (!built.slices || built.slices.length < 3) {
              noteReject(built.reason || 'too few slices');
            } else {
              const bishop = solveBishopSimplified(built.slices, solver);
              if (!bishop.converged) {
                noteReject(bishop.reason || 'no convergence');
              } else {
                results.push(buildBishopSearchResult(circle, built.slices, bishop));
              }
            }
          }

          if (emitProgress && (trial === totalTrials || trial % progressEvery === 0)) {
            emitProgress({
              trial,
              total: totalTrials,
              percent: totalTrials ? (100 * trial) / totalTrials : 0,
              previewCircle: circle
            });
          }
        });
      });
    });
  });

  results.sort((a, b) => a.FS - b.FS);
  let finalResults = results;
  let spencerConverged = 0;
  let spencerRechecked = 0;

  if (methodMode === 'bishop_spencer' && results.length) {
    const recheckCount = Math.min(results.length, spencerConfig.recheckCount);
    const shortlisted = results.slice(0, recheckCount);
    finalResults = shortlisted.map((result) => {
      spencerRechecked += 1;
      const spencer = solveSpencerForSlices(
        cloneSlicesForSolver(result.slices),
        result.diagnostics?.bishop,
        spencerConfig,
        solver
      );
      if (spencer.converged) spencerConverged += 1;
      return applySpencerResult(result, spencer);
    });
    if (!spencerConverged && spencerConfig.fallbackBishop) {
      finalResults = finalResults.map((result) => {
        return {
          ...result,
          method: 'bishop_simplified',
          methodLabel: 'Bishop simplified',
          FS: result.F_bishop,
          F: result.F_bishop
        };
      });
    }
    finalResults.sort((a, b) => a.FS - b.FS);
  }

  const critical = finalResults[0] || null;
  const totalMs = Date.now() - started;
  return {
    critical,
    allResults: finalResults,
    summary: summarizeCritical(critical, model),
    rejectionCounts,
    methodMode,
    spencerRechecked,
    spencerConverged,
    timing: {
      totalMs,
      trialCount: trial,
      avgMsPerTrial: trial ? totalMs / trial : 0
    }
  };
}

export function importBishopMaterialsFromLayers(layers, existing = [], strengthSet = 'characteristic') {
  const prev = new Map((existing || []).map((item) => [item.id, item]));
  return (layers || []).map((layer, index) => {
    const id = `layer_${index}`;
    const fallbackLabel = `${layer.subtype || layer.type || 'Layer'}${layer.type && layer.subtype ? ` (${layer.type})` : ''}`;
    const prior = prev.get(id) || {};
    const designed =
      strengthSet === 'da1_2' ? designSoilLayer(layer, 'M2')
      : strengthSet === 'da1_1' ? designSoilLayer(layer, 'M1')
      : { ...layer };
    const canReuseStrengthValues = prior.sourceStrengthSet === strengthSet;
    return {
      id,
      label: prior.label || `Layer ${index + 1} - ${fallbackLabel}`,
      sourceType: layer.type,
      sourceSubtype: layer.subtype || '',
      sourceStrengthSet: strengthSet,
      cEff: canReuseStrengthValues && Number.isFinite(prior.cEff) ? prior.cEff : Number(designed.c) || 0,
      phiEffDeg: canReuseStrengthValues && Number.isFinite(prior.phiEffDeg) ? prior.phiEffDeg : Number(designed.phi) || 0,
      gamma: canReuseStrengthValues && Number.isFinite(prior.gamma) ? prior.gamma : Number(layer.g) || 18,
      gammaSat: canReuseStrengthValues && Number.isFinite(prior.gammaSat) ? prior.gammaSat : Number(layer.gs) || (Number(layer.g) || 18) + 2,
      color: prior.color || DEFAULT_MATERIAL_COLORS[index % DEFAULT_MATERIAL_COLORS.length]
    };
  });
}

export function bishopLayerSignature(layers) {
  return JSON.stringify(
    (layers || []).map((layer) => [
      layer.top,
      layer.bot,
      layer.type,
      layer.subtype,
      layer.c,
      layer.phi,
      layer.g,
      layer.gs
    ])
  );
}

export function buildBishopModelFromStageLayers(layers, bishopState) {
  const terrainVertices = (bishopState?.terrain || [])
    .filter((pt) => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    .sort((a, b) => a.x - b.x)
    .reduce((acc, pt) => {
      if (!acc.length || dist(acc[acc.length - 1], pt) > GEOM_EPS) acc.push({ x: pt.x, y: pt.y });
      return acc;
    }, []);

  if (terrainVertices.length < 2 || !layers?.length || !Number.isFinite(bishopState?.activeCptX)) return null;

  const terrain = { vertices: terrainVertices };
  const cptX = clampXToTerrain(terrain, bishopState.activeCptX);
  const yGround = terrainY(terrain, cptX);
  const deepestBot = Math.max(...layers.map((layer) => Number(layer.bot) || 0), 0);
  const analysisDepth = Math.max(Number(bishopState?.analysisDepth) || Math.max(deepestBot, 15), Math.max(deepestBot, 15));
  const analysisBottomY = yGround - analysisDepth;
  const materials = importBishopMaterialsFromLayers(layers, bishopState?.materials || [], bishopState?.strengthSet || 'characteristic');

  const bands = layers.map((layer, index) => ({
    id: `band_${index}`,
    topY: yGround - (Number(layer.top) || 0),
    botY: index === layers.length - 1 ? analysisBottomY : yGround - (Number(layer.bot) || 0),
    topFollowsTerrain: index === 0,
    material: materials[index]
  }));

  const regions = [];
  bands.forEach((band) => {
    const polys = buildHorizontalBandPolygons(terrain, band.topY, band.botY, band.topFollowsTerrain);
    polys.forEach((polygon, polyIndex) => {
      regions.push({
        id: `${band.id}_${polyIndex}`,
        polygon,
        material: band.material
      });
    });
  });

  const phreaticVertices = (bishopState?.phreatic || [])
    .filter((pt) => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    .sort((a, b) => a.x - b.x);
  const phreatic =
    phreaticVertices.length >= 2
      ? {
          vertices: phreaticVertices
        }
      : null;

  const rawSurfaceLoad = bishopState?.surfaceLoad || null;
  const surfaceLoadQ = Math.max(Number(rawSurfaceLoad?.q) || 0, 0);
  let surfaceLoad = null;
  if (surfaceLoadQ > 0 && Number.isFinite(rawSurfaceLoad?.xStart) && Number.isFinite(rawSurfaceLoad?.xEnd)) {
    const xStart = clampXToTerrain(terrain, Math.min(rawSurfaceLoad.xStart, rawSurfaceLoad.xEnd));
    const xEnd = clampXToTerrain(terrain, Math.max(rawSurfaceLoad.xStart, rawSurfaceLoad.xEnd));
    if (xEnd > xStart + GEOM_EPS) {
      surfaceLoad = {
        xStart,
        xEnd,
        q: surfaceLoadQ
      };
    }
  }

  const boundaryYs = uniqueSorted(
    layers
      .slice(0, -1)
      .map((layer) => yGround - (Number(layer.bot) || 0))
      .filter(Number.isFinite)
  );

  return {
    terrain,
    phreatic,
    cptX,
    cptGroundY: yGround,
    analysisBottomY,
    materials,
    strengthSet: bishopState?.strengthSet || 'characteristic',
    bands,
    regions,
    boundaryYs,
    surfaceLoad
  };
}
