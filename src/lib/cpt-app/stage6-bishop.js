// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
import { designSoilLayer } from './stage6-engineering.js';
import { normalizeWallMaterial, resolveMaterialPermeability } from './seepage/material.js';
import { normalizeDrains } from './seepage/drains.js';
import { sampleSeepagePorePressure } from './seepage/solver.js';
import {
  buildCptAutoRegions,
  isSimplePolygon,
  normalizeRegionPolygon,
  materialAt as regionMaterialAt,
  polygonArea,
  probeVerticalRegionStack,
  regionStripOverlap
} from './soil-regions.js';
import {
  circleWallSegmentIntersections,
  wallAxis,
  wallEndpoints,
  wallNormalForSide,
  wallStationOfPoint
} from './wall-geometry.js';

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
  momentTolerance: 0.001,
  forceTolerance: 0.001,
  FBracketLow: 0.1,
  FBracketHigh: 10.0,
  maxOuterIter: 20,
  maxInnerIter: 30,
  useNewton: false,
  initialF: null,
  initialLambda: 0,
  fallbackBishop: true
};

function normalizeRegionCoarseness(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
}

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

function sampleLogSpace(min, max, n) {
  const lo = Math.max(Number(min) || 0, 1e-6);
  const hi = Math.max(Number(max) || 0, lo * (1 + 1e-6));
  if (n <= 1 || Math.abs(hi - lo) <= EPS) return [lo];
  const logLo = Math.log(lo);
  const logHi = Math.log(hi);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(Math.exp(lerp(logLo, logHi, i / (n - 1))));
  }
  return out;
}

function incrementCount(map, key) {
  const bucket = map || {};
  const label = key || 'unknown';
  bucket[label] = (bucket[label] || 0) + 1;
  return bucket;
}

function summarizeReasonCounts(counts, maxItems = 2) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  return entries
    .slice(0, maxItems)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');
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

function legacyPolygonArea(points) {
  if (!points?.length || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return 0.5 * sum;
}

function buildLegacyHorizontalBandPolygons(terrain, topY, botY, topFollowsTerrain) {
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
    if (Math.abs(legacyPolygonArea(poly)) > 1e-4) polygons.push(poly);
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

function baseMaterialAtLegacy(model, x, yBase) {
  const probeY = yBase + 0.05;
  const terrainVal = terrainY(model.terrain, x);
  if (probeY > terrainVal) return null;
  for (let i = 0; i < model.legacyBands.length; i += 1) {
    const band = model.legacyBands[i];
    const upper = bandUpperYAt(x, model.terrain, band.topY, band.topFollowsTerrain);
    const lower = bandLowerYAt(x, model.terrain, band.botY);
    if (probeY <= upper + GEOM_EPS && probeY >= lower - GEOM_EPS && upper > lower + GEOM_EPS) {
      return band.material;
    }
  }
  return model.legacyBands[model.legacyBands.length - 1]?.material || null;
}

function deriveBandContributionAtXLegacy(model, band, x, yBase) {
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

function baseMaterialAt(model, x, yBase, soilSource = 'regions') {
  if (soilSource === 'legacy-bands' && Array.isArray(model?.legacyBands)) {
    return baseMaterialAtLegacy(model, x, yBase);
  }
  const probeY = yBase + 0.05;
  const terrainVal = terrainY(model.terrain, x);
  if (probeY > terrainVal) return null;
  return regionMaterialAt(model.regions, x, probeY) || null;
}

function aggregateLayerAreas(model, contributions) {
  const order = new Map((model?.materials || []).map((material, index) => [material.id, index]));
  const merged = new Map();
  (contributions || []).forEach((item) => {
    const material = item.material;
    if (!material?.id) return;
    const prev = merged.get(material.id) || {
      materialId: material.id,
      label: material.label,
      area: 0,
      weight: 0
    };
    prev.area += Number(item.area) || 0;
    prev.weight += Number(item.weight) || 0;
    merged.set(material.id, prev);
  });
  return [...merged.values()]
    .filter((item) => item.area > 1e-5)
    .sort((a, b) => (order.get(a.materialId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.materialId) ?? Number.MAX_SAFE_INTEGER));
}

function legacySliceContributions(model, xL, xR, yBaseL, yBaseMid, yBaseR) {
  const dx = xR - xL;
  const contributions = [];
  (model.legacyBands || []).forEach((band) => {
    const left = deriveBandContributionAtXLegacy(model, band, xL, yBaseL);
    const mid = deriveBandContributionAtXLegacy(model, band, 0.5 * (xL + xR), yBaseMid);
    const right = deriveBandContributionAtXLegacy(model, band, xR, yBaseR);
    const area = simpsonIntegrate(dx, left.thickness, mid.thickness, right.thickness);
    const weight = simpsonIntegrate(dx, left.weightPerWidth, mid.weightPerWidth, right.weightPerWidth);
    if (area > 1e-5) {
      contributions.push({
        material: band.material,
        area,
        weight
      });
    }
  });
  return contributions;
}

function regionSliceContributions(model, xL, xR, soilBounds) {
  const phreaticFn = model.phreatic ? (x) => terrainY(model.phreatic, x) : null;
  return regionStripOverlap(
    model.regions,
    xL,
    xR,
    soilBounds.yTopAt,
    soilBounds.yBaseAt,
    phreaticFn
  );
}

function buildRegionBoundaryPolylines(regions) {
  const seen = new Set();
  const polylines = [];
  (regions || []).forEach((region) => {
    const polygon = region?.polygon || [];
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      if (!Number.isFinite(a?.x) || !Number.isFinite(a?.y) || !Number.isFinite(b?.x) || !Number.isFinite(b?.y)) continue;
      if (dist(a, b) <= GEOM_EPS) continue;
      const key = [a.x, a.y, b.x, b.y].map((value) => Number(value).toFixed(6)).join(':');
      const reverseKey = [b.x, b.y, a.x, a.y].map((value) => Number(value).toFixed(6)).join(':');
      if (seen.has(key) || seen.has(reverseKey)) continue;
      seen.add(key);
      polylines.push({
        vertices: [
          { x: a.x, y: a.y },
          { x: b.x, y: b.y }
        ]
      });
    }
  });
  return polylines;
}

function sliceContributionsForSpan(model, xL, xR, yBaseL, yBaseMid, yBaseR, soilSource = 'regions') {
  if (soilSource === 'legacy-bands') {
    return legacySliceContributions(model, xL, xR, yBaseL, yBaseMid, yBaseR);
  }
  return regionSliceContributions(model, xL, xR, {
    yTopAt: (x) => terrainY(model.terrain, x),
    yBaseAt: (x) => {
      if (Math.abs(x - xL) <= GEOM_EPS) return yBaseL;
      if (Math.abs(x - xR) <= GEOM_EPS) return yBaseR;
      return yBaseMid;
    }
  });
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

function totalSurfaceLoadContribution(surfaceLoads, xL, xR) {
  let width = 0;
  let force = 0;
  (surfaceLoads || []).forEach((surfaceLoad) => {
    if (!surfaceLoad || surfaceLoad.active === false) return;
    const contribution = surfaceLoadContribution(surfaceLoad, xL, xR);
    width += contribution.width;
    force += contribution.force;
  });
  return { width, force };
}

export function debugSurfaceLoadContributionForTest(surfaceLoads, xL, xR) {
  return totalSurfaceLoadContribution(surfaceLoads, xL, xR);
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
  const gauss = [0.2113248654, 0.5, 0.7886751346];
  const useFem = !!model?.useFemPorePressure && model?.seepage?.mesh && model?.seepage?.result;
  let sum = 0;
  gauss.forEach((f) => {
    const x = lerp(xL, xR, f);
    const y = circleYActive(circle, x);
    if (useFem) {
      const sampled = sampleSeepagePorePressure(model.seepage.mesh, model.seepage.result, x, y, GAMMA_W);
      if (Number.isFinite(sampled)) {
        sum += Math.max(sampled, 0);
        return;
      }
    }
    if (!model.phreatic?.vertices?.length) return;
    const water = terrainY(model.phreatic, x);
    sum += Math.max((water - y) * GAMMA_W, 0);
  });
  return sum / gauss.length;
}

function normalizePassiveSide(side) {
  return side === 'left' ? 'left' : 'right';
}

function wallPointForPassiveProbe(wall, fallbackY = null) {
  const axis = wallAxis(wall);
  if (axis) {
    if (Number.isFinite(Number(fallbackY)) && Math.abs(axis.tip.y - axis.head.y) > GEOM_EPS) {
      const u = clamp((Number(fallbackY) - axis.head.y) / (axis.tip.y - axis.head.y), 0, 1);
      return {
        x: axis.head.x + u * (axis.tip.x - axis.head.x),
        y: axis.head.y + u * (axis.tip.y - axis.head.y)
      };
    }
    return axis.head;
  }
  return {
    x: Number(wall?.x) || 0,
    y: Number.isFinite(Number(fallbackY)) ? Number(fallbackY) : Number(wall?.yTop) || 0
  };
}

function wallPassiveProbePoint(model, wall, referencePoint = null) {
  const terrainVerts = model?.terrain?.vertices || [];
  const base = referencePoint || wallPointForPassiveProbe(wall);
  if (!terrainVerts.length) return base;
  const span = Math.max(terrainVerts[terrainVerts.length - 1].x - terrainVerts[0].x, 1);
  const offset = Math.max(span * 1e-4, 0.01);
  const normal = wallNormalForSide(wall, normalizePassiveSide(wall?.passiveSide));
  const probe = normal
    ? { x: base.x + normal.x * offset, y: base.y + normal.y * offset }
    : { x: base.x + (normalizePassiveSide(wall?.passiveSide) === 'left' ? -offset : offset), y: base.y };
  return {
    x: clampXToTerrain(model.terrain, probe.x),
    y: probe.y
  };
}

function wallPassiveProbeX(model, wall, referencePoint = null) {
  return wallPassiveProbePoint(model, wall, referencePoint).x;
}

function wallPassiveSegmentsLegacy(model, wall, yIntersect, referencePoint = null) {
  const xProbe = wallPassiveProbeX(model, wall, referencePoint || wallPointForPassiveProbe(wall, yIntersect));
  const terrainSurfaceY = terrainY(model.terrain, xProbe);
  const waterY = model.phreatic ? terrainY(model.phreatic, xProbe) : null;
  const yBottom = Math.min(Number(wall?.yTip) || 0, Number(yIntersect) || 0);
  const yTop = Math.max(Number(wall?.yTip) || 0, Number(yIntersect) || 0);
  const segments = [];

  (model.legacyBands || []).forEach((band) => {
    const bandTop = bandUpperYAt(xProbe, model.terrain, band.topY, band.topFollowsTerrain);
    const bandBottom = bandLowerYAt(xProbe, model.terrain, band.botY);
    const overlapTop = Math.min(yTop, bandTop);
    const overlapBottom = Math.max(yBottom, bandBottom);
    if (overlapTop <= overlapBottom + GEOM_EPS) return;
    const breakYs = [overlapBottom, overlapTop];
    if (Number.isFinite(waterY) && waterY > overlapBottom + GEOM_EPS && waterY < overlapTop - GEOM_EPS) {
      breakYs.push(waterY);
    }
    const ys = uniqueSorted(breakYs);
    for (let i = 0; i < ys.length - 1; i += 1) {
      const yLow = ys[i];
      const yHigh = ys[i + 1];
      const yMid = 0.5 * (yLow + yHigh);
      const gammaDry = Number.isFinite(Number(band.material?.gamma)) ? Number(band.material.gamma) : 18;
      const gammaSat = Number.isFinite(Number(band.material?.gammaSat)) ? Number(band.material.gammaSat) : gammaDry + 2;
      segments.push({
        yBottom: yLow,
        yTop: yHigh,
        gamma: Number.isFinite(waterY) && yMid < waterY - GEOM_EPS ? gammaSat : gammaDry,
        material: band.material
      });
    }
  });

  return {
    xProbe,
    terrainSurfaceY,
    segments
  };
}

function wallPassiveSegments(model, wall, yIntersect, soilSource = 'regions', referencePoint = null) {
  const xProbe = wallPassiveProbeX(model, wall, referencePoint || wallPointForPassiveProbe(wall, yIntersect));
  const terrainSurfaceY = terrainY(model.terrain, xProbe);
  const waterY = model.phreatic ? terrainY(model.phreatic, xProbe) : null;
  const yBottom = Math.min(Number(wall?.yTip) || 0, Number(yIntersect) || 0);
  const yTop = Math.max(Number(wall?.yTip) || 0, Number(yIntersect) || 0);
  if (soilSource === 'legacy-bands' && Array.isArray(model?.legacyBands)) {
    return wallPassiveSegmentsLegacy(model, wall, yIntersect, referencePoint);
  }
  return {
    xProbe,
    terrainSurfaceY,
    segments: probeVerticalRegionStack(model.regions, xProbe, yBottom, yTop, waterY)
  };
}

export function debugWallPassiveSegmentsForTest(model, wall, yIntersect, soilSource = 'regions') {
  return wallPassiveSegments(model, wall, yIntersect, soilSource);
}

function computeWallIntersections(circle, model, entry, exit, soilSource = 'regions') {
  const walls = model?.walls || [];
  const interactions = {
    intersections: [],
    passedBelow: 0,
    passedAbove: 0,
    outOfMass: 0
  };

  walls.forEach((wall) => {
    const axis = wallAxis(wall);
    if (!axis) {
      interactions.outOfMass += 1;
      return;
    }
    const hits = circleWallSegmentIntersections(circle, wall, GEOM_EPS)
      .filter((hit) => hit?.point && hit.point.x > entry.x + GEOM_EPS && hit.point.x < exit.x - GEOM_EPS)
      .filter((hit) => {
        const activeY = circleYActive(circle, hit.point.x);
        return Number.isFinite(activeY) && Math.abs(activeY - hit.point.y) <= Math.max(1e-4, circle.radius * 1e-7);
      })
      .sort((a, b) => a.s - b.s);
    if (!hits.length) {
      const minWallX = Math.min(axis.head.x, axis.tip.x);
      const maxWallX = Math.max(axis.head.x, axis.tip.x);
      if (maxWallX <= entry.x + GEOM_EPS || minWallX >= exit.x - GEOM_EPS) interactions.outOfMass += 1;
      return;
    }

    hits.forEach((hit) => {
      const yIntersect = hit.point.y;
      const station = Number.isFinite(hit.s) ? hit.s : wallStationOfPoint(axis, hit.point);
      if (station >= axis.length - GEOM_EPS) {
        interactions.passedBelow += 1;
        return;
      }
      if (station <= GEOM_EPS) {
        interactions.passedAbove += 1;
        return;
      }

      const passive = wallPassiveSegments(model, wall, yIntersect, soilSource, hit.point);
      let R_passive = 0;
      let yMoment = 0;
      passive.segments.forEach((segment) => {
        const phi = ((Number(segment.material?.phiEffDeg) || 0) * Math.PI) / 180;
        const Kp = sqr(Math.tan(Math.PI / 4 + phi / 2));
        const cohesion = Number(segment.material?.cEff) || 0;
        const z1 = passive.terrainSurfaceY - segment.yTop;
        const z2 = passive.terrainSurfaceY - segment.yBottom;
        if (!Number.isFinite(z1) || !Number.isFinite(z2) || z2 <= z1 + GEOM_EPS) return;
        const a = Kp * (Number(segment.gamma) || 0);
        const b = 2 * cohesion * Math.sqrt(Math.max(Kp, 0));
        const force = 0.5 * a * (z2 * z2 - z1 * z1) + b * (z2 - z1);
        if (!(force > GEOM_EPS)) return;
        const firstMoment =
          passive.terrainSurfaceY * force -
          (a / 3) * (z2 * z2 * z2 - z1 * z1 * z1) -
          0.5 * b * (z2 * z2 - z1 * z1);
        R_passive += force;
        yMoment += firstMoment;
      });

      if (!(R_passive > GEOM_EPS)) return;
      const maxShear =
        Number.isFinite(Number(wall?.maxShearForce)) && Number(wall.maxShearForce) > 0
          ? Number(wall.maxShearForce)
          : null;
      const R_wall = maxShear != null ? Math.min(R_passive, maxShear) : R_passive;
      if (!(R_wall > GEOM_EPS)) return;
      const y_application =
        R_passive > GEOM_EPS && Number.isFinite(yMoment / R_passive)
          ? yMoment / R_passive
          : Number(axis.tip.y) + (yIntersect - Number(axis.tip.y)) / 3;
      const momentArm = circle.center.y - y_application;
      const M_wall = R_wall * momentArm;
      const passiveNormal = wallNormalForSide(axis, normalizePassiveSide(wall?.passiveSide));
      interactions.intersections.push({
        wall: {
          ...wall,
          passiveSide: normalizePassiveSide(wall?.passiveSide)
        },
        x: hit.point.x,
        y_intersect: yIntersect,
        s_intersect: station,
        d_embedded: axis.length - station,
        R_passive,
        R_wall,
        y_application,
        momentArm,
        M_wall,
        passiveNormal,
        momentTerm: M_wall / Math.max(circle.radius, EPS)
      });
    });
  });

  return interactions;
}

function applyWallInteractionsToSlices(slices, wallIntersections) {
  if (!Array.isArray(slices) || !slices.length) return [];
  return slices.map((slice) => {
    const leftWalls = (wallIntersections || []).filter((item) => Math.abs(slice.xL - item.x) <= 1e-6);
    const rightWalls = (wallIntersections || []).filter((item) => Math.abs(slice.xR - item.x) <= 1e-6);
    return {
      ...slice,
      wallOnLeft: leftWalls[0]?.wall || slice.wallOnLeft || null,
      wallOnRight: rightWalls[0]?.wall || slice.wallOnRight || null,
      wallForceLeft: leftWalls.reduce((sum, item) => sum + (Number(item.R_wall) || 0), 0),
      wallMomentTermLeft: leftWalls.reduce((sum, item) => sum + (Number(item.momentTerm) || 0), 0),
      wallInteractionsLeft: leftWalls.map((item) => ({
        x: item.x,
        y_intersect: item.y_intersect,
        R_wall: item.R_wall,
        y_application: item.y_application,
        passiveNormal: item.passiveNormal
      }))
    };
  });
}

function mergeShortIntervals(xs, minSliceWidth, protectedXs = []) {
  let arr = uniqueSorted(xs);
  const protectedVals = uniqueSorted(protectedXs);
  const isProtected = (value) => protectedVals.some((item) => Math.abs(item - value) <= GEOM_EPS);
  if (arr.length < 2) return arr;
  let changed = true;
  while (changed && arr.length > 2) {
    changed = false;
    for (let i = 0; i < arr.length - 1; i += 1) {
      if (arr[i + 1] - arr[i] >= minSliceWidth - GEOM_EPS) continue;
      const leftProtected = isProtected(arr[i]);
      const rightProtected = isProtected(arr[i + 1]);
      if (leftProtected && rightProtected) continue;
      if (i === 0) {
        arr.splice(leftProtected ? i + 1 : 1, 1);
      } else if (i === arr.length - 2) {
        arr.splice(rightProtected ? i : arr.length - 2, 1);
      } else {
        const left = arr[i] - arr[i - 1];
        const right = arr[i + 2] - arr[i + 1];
        if (leftProtected) arr.splice(i + 1, 1);
        else if (rightProtected) arr.splice(i, 1);
        else if (left >= right) arr.splice(i + 1, 1);
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
  const protectedCuts = [xStart, xEnd];
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

  if (model.regionMode === 'custom') {
    (model.regionBoundaryPolylines || []).forEach((polyline) => {
      (polyline.vertices || []).forEach((pt) => {
        if (pt.x > xStart + GEOM_EPS && pt.x < xEnd - GEOM_EPS) cuts.push(pt.x);
      });
      circlePolylineIntersections(circle, polyline).forEach((pt) => {
        if (pt.x > xStart + GEOM_EPS && pt.x < xEnd - GEOM_EPS) cuts.push(pt.x);
      });
    });
  }

  (model.surfaceLoads || (model.surfaceLoad ? [model.surfaceLoad] : [])).forEach((surfaceLoad) => {
    if (!surfaceLoad || surfaceLoad.active === false) return;
    [surfaceLoad.xStart, surfaceLoad.xEnd].forEach((x) => {
      if (x > xStart + GEOM_EPS && x < xEnd - GEOM_EPS) cuts.push(x);
    });
  });

  (model.walls || []).forEach((wall) => {
    circleWallSegmentIntersections(circle, wall, GEOM_EPS).forEach((hit) => {
      const x = hit?.point?.x;
      if (!(x > xStart + GEOM_EPS && x < xEnd - GEOM_EPS)) return;
      const activeY = circleYActive(circle, x);
      if (!Number.isFinite(activeY) || Math.abs(activeY - hit.point.y) > Math.max(1e-4, circle.radius * 1e-7)) return;
      cuts.push(x);
      protectedCuts.push(x);
    });
  });

  return mergeShortIntervals(cuts, minSliceWidth, protectedCuts);
}

function buildSlicesForCircle(circle, entry, exit, model, searchConfig, soilSource = 'regions') {
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

    const baseMaterial = baseMaterialAt(model, xMid, yBaseMid, soilSource);
    if (!baseMaterial) return { slices: null, reason: 'cannot identify base material' };

    const rawContributions = sliceContributionsForSpan(
      model,
      xL,
      xR,
      yBaseL,
      yBaseMid,
      yBaseR,
      soilSource
    );
    const layerAreas = aggregateLayerAreas(model, rawContributions);
    const totalWeight = layerAreas.reduce((sum, item) => sum + item.weight, 0);

    if (totalWeight <= 0) continue;

    const surcharge = totalSurfaceLoadContribution(
      model.surfaceLoads || (model.surfaceLoad ? [model.surfaceLoad] : []),
      xL,
      xR
    );
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
      layerAreas,
      wallOnLeft: null,
      wallOnRight: null,
      wallForceLeft: 0,
      wallMomentTermLeft: 0,
      wallInteractionsLeft: []
    });
  }

  return { slices, reason: '' };
}

function totalWallMomentTerm(wallIntersections) {
  return (wallIntersections || []).reduce((sum, item) => sum + (Number(item?.momentTerm) || 0), 0);
}

function totalWallForce(wallIntersections) {
  return (wallIntersections || []).reduce((sum, item) => sum + (Number(item?.R_wall) || 0), 0);
}

function ordinarySeed(slices, wallIntersections = []) {
  let numerator = 0;
  let denominator = 0;
  slices.forEach((slice) => {
    const c = slice.baseMaterial.cEff;
    const phi = (slice.baseMaterial.phiEffDeg * Math.PI) / 180;
    const tanPhi = Math.tan(phi);
    const cosA = Math.cos(slice.alphaRad);
    const sinA = Math.sin(slice.alphaRad);
    const V = sliceVerticalLoad(slice);
    const l = Number(slice.baseLength) || slice.dx / Math.max(cosA, 1e-6);
    numerator += c * l + (V * cosA - slice.uBase * l) * tanPhi;
    denominator += V * sinA;
  });
  denominator -= totalWallMomentTerm(wallIntersections);
  if (denominator <= EPS) return 1;
  const seed = numerator / denominator;
  return Number.isFinite(seed) ? seed : 1;
}

function buildDiagnostics(slices, F, iterations, wallIntersections = []) {
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
    F_fellenius: ordinarySeed(slices, wallIntersections),
    iterations,
    reason: '',
    wallMomentTerm: totalWallMomentTerm(wallIntersections),
    wallForceTotal: totalWallForce(wallIntersections),
    wallIntersections,
    sliceNormals,
    sliceMobilizedShears,
    sliceMAlpha
  };
}

function cloneSlicesForSolver(slices) {
  return (slices || []).map((slice) => ({
    ...slice,
    baseMaterial: slice?.baseMaterial ? { ...slice.baseMaterial } : slice.baseMaterial,
    layerAreas: Array.isArray(slice?.layerAreas) ? slice.layerAreas.map((item) => ({ ...item })) : [],
    wallOnLeft: slice?.wallOnLeft ? { ...slice.wallOnLeft } : null,
    wallOnRight: slice?.wallOnRight ? { ...slice.wallOnRight } : null,
    wallInteractionsLeft: Array.isArray(slice?.wallInteractionsLeft)
      ? slice.wallInteractionsLeft.map((item) => ({ ...item }))
      : []
  }));
}

function enrichBishopSlices(slices, diagnostics) {
  return (slices || []).map((slice, index) => ({
    ...slice,
    mAlpha: diagnostics?.sliceMAlpha?.[index] ?? null,
    normalForce: diagnostics?.sliceNormals?.[index] ?? null,
    N_total: diagnostics?.sliceNormals?.[index] ?? null,
    mobilizedShear: diagnostics?.sliceMobilizedShears?.[index] ?? null,
    E_right: null,
    X_right: null,
    N_eff: null,
    S_mob: null,
    theta_interslice: null,
    wallForceLeft: Number(slice?.wallForceLeft) || 0,
    wallMomentTermLeft: Number(slice?.wallMomentTermLeft) || 0,
    wallInteractionsLeft: Array.isArray(slice?.wallInteractionsLeft)
      ? slice.wallInteractionsLeft.map((item) => ({ ...item }))
      : []
  }));
}

function buildBishopSearchResult(circle, slices, bishopDiagnostics, wallInteraction) {
  const F = bishopDiagnostics?.FS ?? bishopDiagnostics?.F ?? null;
  const wallIntersections = wallInteraction?.intersections || bishopDiagnostics?.wallIntersections || [];
  const passesBelowWall = !wallIntersections.length && (wallInteraction?.passedBelow || 0) > 0;
  return {
    circle,
    entry: circle?.entryPoint || null,
    exit: circle?.exitPoint || null,
    method: 'bishop_simplified',
    methodLabel: 'Seep/Slope',
    FS: F,
    F,
    F_bishop: F,
    F_m: F,
    F_f: null,
    F_fellenius: bishopDiagnostics?.F_fellenius ?? ordinarySeed(slices, wallIntersections),
    lambda: null,
    thetaDeg: null,
    theta_deg: null,
    momentResidual: null,
    forceResidual: null,
    maxE: null,
    tensionSlices: 0,
    iterations: bishopDiagnostics?.iterations ?? 0,
    converged: !!bishopDiagnostics?.converged,
    reason: bishopDiagnostics?.reason || '',
    spencerAttempted: false,
    spencerConverged: false,
    spencerRejectReason: '',
    intersectsWall: wallIntersections.length > 0,
    passesBelowWall,
    wallIntersectionCount: wallIntersections.length,
    wallBypassCount: wallInteraction?.passedBelow || 0,
    wallForceTotal: bishopDiagnostics?.wallForceTotal ?? totalWallForce(wallIntersections),
    wallMomentTerm: bishopDiagnostics?.wallMomentTerm ?? totalWallMomentTerm(wallIntersections),
    wallForces: wallIntersections.map((item) => ({ ...item })),
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

function normalizedMomentResidualScale(slices) {
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
  merged.momentTolerance = Math.max(
    Number.isFinite(+merged.momentTolerance)
      ? +merged.momentTolerance
      : Number.isFinite(+merged.FfTolerance)
        ? +merged.FfTolerance
        : DEFAULT_SPENCER_CONFIG.momentTolerance,
    1e-6
  );
  merged.forceTolerance = Math.max(
    Number.isFinite(+merged.forceTolerance)
      ? +merged.forceTolerance
      : Number.isFinite(+merged.FfTolerance)
        ? +merged.FfTolerance
        : DEFAULT_SPENCER_CONFIG.forceTolerance,
    1e-6
  );
  merged.FBracketLow = Math.max(
    Number.isFinite(+merged.FBracketLow)
      ? +merged.FBracketLow
      : Number.isFinite(+merged.FfBracketLow)
        ? +merged.FfBracketLow
        : DEFAULT_SPENCER_CONFIG.FBracketLow,
    0.01
  );
  merged.FBracketHigh = Math.max(
    Number.isFinite(+merged.FBracketHigh)
      ? +merged.FBracketHigh
      : Number.isFinite(+merged.FfBracketHigh)
        ? +merged.FfBracketHigh
        : DEFAULT_SPENCER_CONFIG.FBracketHigh,
    merged.FBracketLow + 0.1
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
  merged.initialF = Number.isFinite(+merged.initialF) && +merged.initialF > 0 ? +merged.initialF : null;
  merged.initialLambda = Number.isFinite(+merged.initialLambda) ? +merged.initialLambda : DEFAULT_SPENCER_CONFIG.initialLambda;
  merged.intersectionTolerance = Math.max(merged.momentTolerance, merged.forceTolerance, 1e-6);
  merged.fallbackBishop = merged.fallbackBishop !== false;
  return merged;
}

function evaluateSpencerState(slices, lambda, FTrial, solverConfig) {
  if (!Array.isArray(slices) || !slices.length || !Number.isFinite(FTrial) || FTrial <= 0) {
    return {
      valid: false,
      reason: 'invalid Spencer trial state',
      F: FTrial,
      lambda,
      forceResidual: NaN,
      momentResidual: NaN,
      normalizedForceResidual: Infinity,
      normalizedMomentResidual: Infinity,
      forceResidualScale: 1,
      momentResidualScale: 1,
      maxE: 0,
      tensionSlices: 0,
      sliceForces: []
    };
  }

  const sliceForces = [];
  let ELeft = 0;
  let maxE = 0;
  let tensionSlices = 0;
  let drivingMoment = 0;
  let resistingMoment = 0;
  const wallMomentTerm = (slices || []).reduce((sum, slice) => sum + (Number(slice?.wallMomentTermLeft) || 0), 0);
  const theta = Math.atan(lambda);
  const forceResidualScale = normalizedForceResidualScale(slices);
  const momentResidualScale = normalizedMomentResidualScale(slices);

  for (let i = 0; i < slices.length; i += 1) {
    const slice = slices[i];
    ELeft += Number(slice?.wallForceLeft) || 0;
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
        F: FTrial,
        lambda,
        forceResidual: NaN,
        momentResidual: NaN,
        normalizedForceResidual: Infinity,
        normalizedMomentResidual: Infinity,
        forceResidualScale,
        momentResidualScale,
        maxE,
        tensionSlices,
        sliceForces
      };
    }

    const a1 = sinA - (tanPhi * cosA) / FTrial;
    const a0 = ELeft + porePressure * width * tanA - (cohesion * width) / FTrial;
    const denomN = mAlpha + lambda * a1;
    if (!Number.isFinite(denomN) || Math.abs(denomN) <= (solverConfig.minMAlpha || 1e-6)) {
      return {
        valid: false,
        reason: 'spencer denominator <= 0',
        F: FTrial,
        lambda,
        forceResidual: NaN,
        momentResidual: NaN,
        normalizedForceResidual: Infinity,
        normalizedMomentResidual: Infinity,
        forceResidualScale,
        momentResidualScale,
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
        F: FTrial,
        lambda,
        forceResidual: NaN,
        momentResidual: NaN,
        normalizedForceResidual: Infinity,
        normalizedMomentResidual: Infinity,
        forceResidualScale,
        momentResidualScale,
        maxE,
        tensionSlices,
        sliceForces
      };
    }

    if (N_eff < 0) tensionSlices += 1;
    maxE = Math.max(maxE, Math.abs(E_right));
    drivingMoment += vertical * sinA;
    resistingMoment += S_mob;
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

  const forceResidual = ELeft;
  const momentResidual = resistingMoment - drivingMoment + wallMomentTerm;
  return {
    valid: true,
    reason: '',
    F: FTrial,
    lambda,
    forceResidual,
    momentResidual,
    wallMomentTerm,
    normalizedForceResidual: Math.abs(forceResidual) / forceResidualScale,
    normalizedMomentResidual: Math.abs(momentResidual) / momentResidualScale,
    forceResidualScale,
    momentResidualScale,
    maxE,
    tensionSlices,
    sliceForces
  };
}

function spencerBranchSolveKey(mode) {
  return mode === 'moment'
    ? {
        residualField: 'momentResidual',
        normalizedField: 'normalizedMomentResidual',
        tolerance: 'momentTolerance',
        label: 'moment equilibrium',
        outputField: 'F_m'
      }
    : {
        residualField: 'forceResidual',
        normalizedField: 'normalizedForceResidual',
        tolerance: 'forceTolerance',
        label: 'force equilibrium',
        outputField: 'F_f'
      };
}

function buildSpencerFProbeValues(spencerConfig, bishopF) {
  const seedF =
    Number.isFinite(spencerConfig.initialF) && spencerConfig.initialF > 0
      ? spencerConfig.initialF
      : Number.isFinite(bishopF) && bishopF > 0
        ? bishopF
        : null;
  const dynamicHigh = Math.max(
    40,
    Number(spencerConfig?.FBracketHigh) || 0,
    seedF != null ? seedF * 4 : 0
  );
  const dynamicLow = Math.max(
    0.01,
    Math.min(
      Number(spencerConfig?.FBracketLow) || 0.1,
      seedF != null ? seedF * 0.25 : Infinity,
      0.05
    )
  );
  return uniqueSorted([
    0.01,
    0.02,
    0.05,
    0.1,
    spencerConfig.FBracketLow,
    spencerConfig.FBracketHigh,
    ...sampleLogSpace(dynamicLow, dynamicHigh, 17),
    ...(seedF != null
      ? [seedF * 0.25, seedF * 0.5, seedF * 0.75, seedF, seedF * 1.25, seedF * 1.5, seedF * 2.5, seedF * 4]
      : [])
  ]);
}

function choosePreferredFExactSample(candidates, targetF, normalizedField) {
  let best = null;
  (candidates || []).forEach((candidate) => {
    if (!candidate?.valid) return;
    if (!best) {
      best = candidate;
      return;
    }
    const nextDist = Number.isFinite(targetF) ? Math.abs(candidate.F - targetF) : 0;
    const bestDist = Number.isFinite(targetF) ? Math.abs(best.F - targetF) : 0;
    if (nextDist < bestDist - 1e-12) {
      best = candidate;
      return;
    }
    if (Math.abs(nextDist - bestDist) <= 1e-12 && candidate.state?.[normalizedField] < best.state?.[normalizedField]) {
      best = candidate;
    }
  });
  return best;
}

function choosePreferredFSignChange(samples, residualField, targetF, currentWidth = Infinity) {
  let previousValid = null;
  let best = null;

  function rank(bracket) {
    const width = bracket.upper.F - bracket.lower.F;
    const mid = 0.5 * (bracket.lower.F + bracket.upper.F);
    const target = Number.isFinite(targetF) ? targetF : mid;
    const spansTarget = Number.isFinite(targetF)
      ? bracket.lower.F <= targetF + EPS && bracket.upper.F >= targetF - EPS
      : false;
    return {
      spansTarget: spansTarget ? 0 : 1,
      distance: Math.abs(mid - target),
      width,
      residualMag:
        Math.abs(bracket.lower.state?.[residualField] || 0) + Math.abs(bracket.upper.state?.[residualField] || 0)
    };
  }

  function isBetter(next, current) {
    if (!current) return true;
    const a = rank(next);
    const b = rank(current);
    if (a.spansTarget !== b.spansTarget) return a.spansTarget < b.spansTarget;
    if (Math.abs(a.distance - b.distance) > 1e-12) return a.distance < b.distance;
    if (Math.abs(a.width - b.width) > 1e-12) return a.width < b.width;
    return a.residualMag < b.residualMag;
  }

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    if (!sample?.valid) {
      previousValid = null;
      continue;
    }
    if (
      previousValid &&
      Math.sign(previousValid.state?.[residualField]) !== Math.sign(sample.state?.[residualField])
    ) {
      const width = sample.F - previousValid.F;
      const bracket = {
        lower: previousValid,
        upper: sample,
        width
      };
      if (width < currentWidth - 1e-12 && isBetter(bracket, best)) {
        best = bracket;
      }
    }
    previousValid = sample;
  }
  return best;
}

function probeSpencerBranchF(slices, lambda, spencerConfig, solverConfig, bishopF, branch, tol) {
  const samples = [];
  const invalidReasonCounts = {};
  let best = null;
  let exactCandidates = [];
  const targetF =
    Number.isFinite(spencerConfig.initialF) && spencerConfig.initialF > 0
      ? spencerConfig.initialF
      : Number.isFinite(bishopF) && bishopF > 0
        ? bishopF
        : null;
  const probeValues = buildSpencerFProbeValues(spencerConfig, bishopF);

  probeValues.forEach((F) => {
    const state = evaluateSpencerState(slices, lambda, F, solverConfig);
    const sample = {
      F,
      state,
      valid: !!state?.valid
    };
    samples.push(sample);
    if (!state?.valid) {
      incrementCount(invalidReasonCounts, state?.reason);
      return;
    }
    if (!best || state[branch.normalizedField] < best.state[branch.normalizedField]) {
      best = sample;
    }
    if (state[branch.normalizedField] <= tol) exactCandidates.push(sample);
  });

  return {
    samples,
    best,
    exact: choosePreferredFExactSample(exactCandidates, targetF, branch.normalizedField),
    bracket: choosePreferredFSignChange(samples, branch.residualField, targetF),
    validCount: samples.filter((item) => item.valid).length,
    invalidCount: samples.filter((item) => !item.valid).length,
    invalidReasonCounts,
    evaluations: samples.length,
    targetF
  };
}

function describeSpencerBranchProbeFailure(branch, probe) {
  const summary = summarizeReasonCounts(probe?.invalidReasonCounts);
  const suffix = summary ? ` (${summary})` : '';
  if ((probe?.validCount || 0) <= 0) {
    return `${branch.label} has no valid F window for this lambda${suffix}`;
  }
  return `${branch.label} valid F window shows no residual sign change${suffix}`;
}

function refineSpencerBranchBracket(
  slices,
  lambda,
  solverConfig,
  branch,
  tol,
  FLo,
  resLo,
  FHi,
  resHi,
  priorBest,
  targetF
) {
  const probeValues = uniqueSorted([
    FLo,
    FHi,
    ...sampleArray([FLo, FHi], 9)
  ]);
  const currentWidth = FHi - FLo;
  let best = priorBest || null;
  let exactCandidates = [];
  let evaluations = 0;
  const invalidReasonCounts = {};
  const samples = probeValues.map((F) => {
    let state = null;
    if (Math.abs(F - FLo) <= EPS) state = resLo;
    else if (Math.abs(F - FHi) <= EPS) state = resHi;
    else {
      state = evaluateSpencerState(slices, lambda, F, solverConfig);
      evaluations += 1;
    }
    const sample = {
      F,
      state,
      valid: !!state?.valid
    };
    if (!state?.valid) {
      incrementCount(invalidReasonCounts, state?.reason);
      return sample;
    }
    if (!best || state[branch.normalizedField] < best.state[branch.normalizedField]) {
      best = sample;
    }
    if (state[branch.normalizedField] <= tol) exactCandidates.push(sample);
    return sample;
  });

  const exact = choosePreferredFExactSample(exactCandidates, targetF, branch.normalizedField);
  if (exact) {
    return { best, exact, bracket: null, evaluations, reason: '' };
  }

  const narrowed = choosePreferredFSignChange(samples, branch.residualField, targetF, currentWidth);
  if (narrowed) {
    return { best, exact: null, bracket: narrowed, evaluations, reason: '' };
  }

  const summary = summarizeReasonCounts(invalidReasonCounts);
  const suffix = summary ? ` (${summary})` : '';
  const validCount = samples.filter((item) => item.valid).length;
  return {
    best,
    exact: null,
    bracket: null,
    evaluations,
    reason:
      validCount > 0
        ? `${branch.label} valid F interval fragmented by invalid states${suffix}`
        : `${branch.label} lost all valid F states inside the active bracket${suffix}`
  };
}

function solveSpencerBranchF(slices, lambda, spencerConfig, solverConfig, bishopF, mode) {
  const branch = spencerBranchSolveKey(mode);
  const tol = spencerConfig[branch.tolerance];
  const probe = probeSpencerBranchF(slices, lambda, spencerConfig, solverConfig, bishopF, branch, tol);
  let best = probe.best || null;
  let iterations = probe.evaluations || 0;

  if (probe.exact?.state) {
    return {
      [branch.outputField]: probe.exact.F,
      converged: true,
      reason: '',
      state: probe.exact.state,
      iterations
    };
  }

  if (!probe.bracket?.lower?.state || !probe.bracket?.upper?.state) {
    return {
      [branch.outputField]: best?.F ?? NaN,
      converged: false,
      reason: describeSpencerBranchProbeFailure(branch, probe),
      state: best?.state || null,
      iterations
    };
  }

  let FLo = probe.bracket.lower.F;
  let FHi = probe.bracket.upper.F;
  let resLo = probe.bracket.lower.state;
  let resHi = probe.bracket.upper.state;

  for (let iter = 1; iter <= spencerConfig.maxInnerIter; iter += 1) {
    const FMid = 0.5 * (FLo + FHi);
    const midState = evaluateSpencerState(slices, lambda, FMid, solverConfig);
    iterations += 1;
    if (!midState.valid) {
      const refined = refineSpencerBranchBracket(
        slices,
        lambda,
        solverConfig,
        branch,
        tol,
        FLo,
        resLo,
        FHi,
        resHi,
        best,
        probe.targetF
      );
      iterations += refined.evaluations || 0;
      if (refined.best) best = refined.best;
      if (refined.exact?.state) {
        return {
          [branch.outputField]: refined.exact.F,
          converged: true,
          reason: '',
          state: refined.exact.state,
          iterations
        };
      }
      if (refined.bracket?.lower?.state && refined.bracket?.upper?.state) {
        FLo = refined.bracket.lower.F;
        FHi = refined.bracket.upper.F;
        resLo = refined.bracket.lower.state;
        resHi = refined.bracket.upper.state;
        continue;
      }
      return {
        [branch.outputField]: best?.F ?? NaN,
        converged: false,
        reason: refined.reason || midState.reason || `${branch.label} invalid state`,
        state: best?.state || null,
        iterations
      };
    }

    if (!best || midState[branch.normalizedField] < best.state[branch.normalizedField]) {
      best = { F: FMid, state: midState };
    }
    if (midState[branch.normalizedField] <= tol) {
      return {
        [branch.outputField]: FMid,
        converged: true,
        reason: '',
        state: midState,
        iterations
      };
    }

    if (Math.sign(midState[branch.residualField]) === Math.sign(resLo[branch.residualField])) {
      FLo = FMid;
      resLo = midState;
    } else {
      FHi = FMid;
      resHi = midState;
    }
  }

  return {
    [branch.outputField]: best?.F ?? 0.5 * (FLo + FHi),
    converged: false,
    reason: `${branch.label} did not converge`,
    state: best?.state || resHi,
    iterations
  };
}

function computeSpencerMomentEquilibriumF(slices, lambda, spencerConfig, solverConfig, bishopF) {
  return solveSpencerBranchF(slices, lambda, spencerConfig, solverConfig, bishopF, 'moment');
}

function computeSpencerForceEquilibriumF(slices, lambda, spencerConfig, solverConfig, bishopF) {
  return solveSpencerBranchF(slices, lambda, spencerConfig, solverConfig, bishopF, 'force');
}

function describeSpencerLambdaFailure(momentEq, forceEq) {
  const reasons = [];
  if (!momentEq?.converged) reasons.push(`moment branch: ${momentEq?.reason || 'failed'}`);
  if (!forceEq?.converged) reasons.push(`force branch: ${forceEq?.reason || 'failed'}`);
  return reasons.join('; ') || 'Spencer branch solve failed';
}

function evaluateSpencerAtLambda(slices, bishopF, lambda, spencerConfig, solverConfig) {
  const momentEq = computeSpencerMomentEquilibriumF(slices, lambda, spencerConfig, solverConfig, bishopF);
  const forceEq = computeSpencerForceEquilibriumF(slices, lambda, spencerConfig, solverConfig, bishopF);
  const totalIterations = (momentEq?.iterations || 0) + (forceEq?.iterations || 0);

  if (!momentEq.converged || !forceEq.converged || !Number.isFinite(momentEq.F_m) || !Number.isFinite(forceEq.F_f)) {
    return {
      lambda,
      valid: false,
      value: NaN,
      F: NaN,
      F_m: momentEq?.F_m ?? NaN,
      F_f: forceEq?.F_f ?? NaN,
      momentEq,
      forceEq,
      iterations: totalIterations,
      reason: describeSpencerLambdaFailure(momentEq, forceEq)
    };
  }

  const FCommon = 0.5 * (momentEq.F_m + forceEq.F_f);
  const state = evaluateSpencerState(slices, lambda, FCommon, solverConfig);
  if (!state.valid) {
    return {
      lambda,
      valid: false,
      value: NaN,
      F: NaN,
      F_m: momentEq.F_m,
      F_f: forceEq.F_f,
      momentEq,
      forceEq,
      iterations: totalIterations,
      reason: state.reason || 'Spencer common-state evaluation failed'
    };
  }

  return {
    lambda,
    valid: true,
    value: momentEq.F_m - forceEq.F_f,
    F: FCommon,
    F_m: momentEq.F_m,
    F_f: forceEq.F_f,
    state,
    momentEq,
    forceEq,
    iterations: totalIterations
  };
}

function buildSpencerLambdaSamples(spencerConfig) {
  const low = spencerConfig.lambdaLow;
  const high = spencerConfig.lambdaHigh;
  const anchors = [-0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45].filter(
    (value) => value > low + EPS && value < high - EPS
  );
  return uniqueSorted([
    low,
    high,
    spencerConfig.initialLambda,
    ...anchors,
    ...sampleArray([low, high], 25)
  ]);
}

function choosePreferredLambdaExactSample(candidates, targetLambda) {
  let best = null;
  (candidates || []).forEach((candidate) => {
    if (!candidate?.valid) return;
    if (!best) {
      best = candidate;
      return;
    }
    const nextDist = Number.isFinite(targetLambda) ? Math.abs(candidate.lambda - targetLambda) : Math.abs(candidate.value);
    const bestDist = Number.isFinite(targetLambda) ? Math.abs(best.lambda - targetLambda) : Math.abs(best.value);
    if (nextDist < bestDist - 1e-12) {
      best = candidate;
      return;
    }
    if (Math.abs(nextDist - bestDist) <= 1e-12 && Math.abs(candidate.value) < Math.abs(best.value)) {
      best = candidate;
    }
  });
  return best;
}

function choosePreferredLambdaSignChange(samples, targetLambda, currentWidth = Infinity) {
  let previousValid = null;
  let best = null;

  function rank(bracket) {
    const width = bracket.upper.lambda - bracket.lower.lambda;
    const mid = 0.5 * (bracket.lower.lambda + bracket.upper.lambda);
    const target = Number.isFinite(targetLambda) ? targetLambda : mid;
    const spansTarget = Number.isFinite(targetLambda)
      ? bracket.lower.lambda <= targetLambda + EPS && bracket.upper.lambda >= targetLambda - EPS
      : false;
    return {
      spansTarget: spansTarget ? 0 : 1,
      distance: Math.abs(mid - target),
      width,
      residualMag: Math.abs(bracket.lower.value) + Math.abs(bracket.upper.value)
    };
  }

  function isBetter(next, current) {
    if (!current) return true;
    const a = rank(next);
    const b = rank(current);
    if (a.spansTarget !== b.spansTarget) return a.spansTarget < b.spansTarget;
    if (Math.abs(a.distance - b.distance) > 1e-12) return a.distance < b.distance;
    if (Math.abs(a.width - b.width) > 1e-12) return a.width < b.width;
    return a.residualMag < b.residualMag;
  }

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    if (!sample?.valid) continue;
    if (previousValid && Math.sign(previousValid.value) !== Math.sign(sample.value)) {
      const width = sample.lambda - previousValid.lambda;
      const bracket = {
        lower: previousValid,
        upper: sample,
        width
      };
      if (width < currentWidth - 1e-12 && isBetter(bracket, best)) {
        best = bracket;
      }
    }
    previousValid = sample;
  }
  return best;
}

function evaluateSpencerLambdaSamples(slices, bishopF, lambdas, spencerConfig, solverConfig) {
  const samples = [];
  const invalidReasonCounts = {};
  let best = null;
  let exactCandidates = [];
  let totalIterations = 0;
  const targetLambda = Number.isFinite(spencerConfig.initialLambda) ? spencerConfig.initialLambda : 0;

  lambdas.forEach((lambda) => {
    const current = evaluateSpencerAtLambda(slices, bishopF, lambda, spencerConfig, solverConfig);
    totalIterations += current?.iterations || 0;
    samples.push(current);
    if (!current?.valid) {
      incrementCount(invalidReasonCounts, current?.reason);
      return;
    }
    if (!best || Math.abs(current.value) < Math.abs(best.value)) best = current;
    if (Math.abs(current.value) <= spencerConfig.intersectionTolerance) exactCandidates.push(current);
  });

  return {
    samples,
    best,
    exact: choosePreferredLambdaExactSample(exactCandidates, targetLambda),
    bracket: choosePreferredLambdaSignChange(samples, targetLambda),
    validCount: samples.filter((item) => item.valid).length,
    invalidCount: samples.filter((item) => !item.valid).length,
    invalidReasonCounts,
    iterations: totalIterations,
    targetLambda
  };
}

function chooseSpencerSecantPair(samples, best) {
  const valid = (samples || []).filter((item) => item?.valid).sort((a, b) => a.lambda - b.lambda);
  if (valid.length < 2 || !best) return null;
  const bestIndex = valid.findIndex((item) => Math.abs(item.lambda - best.lambda) <= 1e-12);
  const candidates = [];
  if (bestIndex > 0) candidates.push([valid[bestIndex - 1], valid[bestIndex]]);
  if (bestIndex >= 0 && bestIndex < valid.length - 1) candidates.push([valid[bestIndex], valid[bestIndex + 1]]);
  if (bestIndex > 0 && bestIndex < valid.length - 1) candidates.push([valid[bestIndex - 1], valid[bestIndex + 1]]);
  if (!candidates.length) candidates.push([valid[0], valid[1]]);
  return candidates
    .filter(([left, right]) => left && right && Math.abs(right.value - left.value) > 1e-12)
    .sort(
      (a, b) =>
        Math.abs(a[0].value) + Math.abs(a[1].value) - (Math.abs(b[0].value) + Math.abs(b[1].value))
    )[0] || null;
}

function refineSpencerLambdaBracket(
  slices,
  bishopF,
  spencerConfig,
  solverConfig,
  lower,
  upper,
  priorBest,
  targetLambda
) {
  const probeLambdas = uniqueSorted([
    lower.lambda,
    upper.lambda,
    ...sampleArray([lower.lambda, upper.lambda], 9)
  ]);
  const currentWidth = upper.lambda - lower.lambda;
  let best = priorBest || null;
  let exactCandidates = [];
  let iterations = 0;
  const invalidReasonCounts = {};
  const samples = probeLambdas.map((lambda) => {
    let current = null;
    if (Math.abs(lambda - lower.lambda) <= EPS) current = lower;
    else if (Math.abs(lambda - upper.lambda) <= EPS) current = upper;
    else {
      current = evaluateSpencerAtLambda(slices, bishopF, lambda, spencerConfig, solverConfig);
      iterations += current?.iterations || 0;
    }
    if (!current?.valid) {
      incrementCount(invalidReasonCounts, current?.reason);
      return current;
    }
    if (!best || Math.abs(current.value) < Math.abs(best.value)) best = current;
    if (Math.abs(current.value) <= spencerConfig.intersectionTolerance) exactCandidates.push(current);
    return current;
  });

  const exact = choosePreferredLambdaExactSample(exactCandidates, targetLambda);
  if (exact) {
    return { best, exact, bracket: null, iterations, reason: '' };
  }

  const narrowed = choosePreferredLambdaSignChange(samples, targetLambda, currentWidth);
  if (narrowed) {
    return { best, exact: null, bracket: narrowed, iterations, reason: '' };
  }

  const summary = summarizeReasonCounts(invalidReasonCounts);
  const suffix = summary ? ` (${summary})` : '';
  const validCount = samples.filter((item) => item?.valid).length;
  return {
    best,
    exact: null,
    bracket: null,
    iterations,
    reason:
      validCount > 0
        ? `Spencer lambda interval fragmented by invalid branch states${suffix}`
        : `No admissible Spencer lambda remained inside the active bracket${suffix}`
  };
}

function findSpencerLambdaBracket(slices, bishopF, spencerConfig, solverConfig) {
  const initial = evaluateSpencerLambdaSamples(
    slices,
    bishopF,
    buildSpencerLambdaSamples(spencerConfig),
    spencerConfig,
    solverConfig
  );
  let samples = [...initial.samples];
  let best = initial.best || null;
  let totalIterations = initial.iterations || 0;
  const invalidReasonCounts = { ...(initial.invalidReasonCounts || {}) };
  let validCount = initial.validCount || 0;
  let invalidCount = initial.invalidCount || 0;

  if (initial.exact) {
    return {
      exact: initial.exact,
      lower: null,
      upper: null,
      best,
      iterations: totalIterations,
      validCount,
      invalidCount,
      invalidReasonCounts,
      targetLambda: initial.targetLambda
    };
  }

  if (initial.bracket) {
    return {
      exact: null,
      lower: initial.bracket.lower,
      upper: initial.bracket.upper,
      best,
      iterations: totalIterations,
      validCount,
      invalidCount,
      invalidReasonCounts,
      targetLambda: initial.targetLambda
    };
  }

  const maxSecantIter = Math.min(6, Math.max(spencerConfig.maxOuterIter || 0, 1));
  for (let iter = 0; iter < maxSecantIter; iter += 1) {
    const pair = chooseSpencerSecantPair(samples, best);
    if (!pair) break;
    const [left, right] = pair;
    const valueDiff = right.value - left.value;
    let lambdaNext = right.lambda - (right.value * (right.lambda - left.lambda)) / valueDiff;
    if (!Number.isFinite(lambdaNext)) {
      lambdaNext = 0.5 * (left.lambda + right.lambda);
    }
    lambdaNext = clamp(lambdaNext, spencerConfig.lambdaLow, spencerConfig.lambdaHigh);
    if (samples.some((sample) => Math.abs(sample.lambda - lambdaNext) <= spencerConfig.lambdaTolerance)) {
      lambdaNext = 0.5 * (left.lambda + right.lambda);
    }
    if (samples.some((sample) => Math.abs(sample.lambda - lambdaNext) <= spencerConfig.lambdaTolerance)) break;

    const current = evaluateSpencerAtLambda(slices, bishopF, lambdaNext, spencerConfig, solverConfig);
    totalIterations += current?.iterations || 0;
    samples.push(current);
    samples.sort((a, b) => a.lambda - b.lambda);

    if (!current?.valid) {
      invalidCount += 1;
      incrementCount(invalidReasonCounts, current?.reason);
    } else {
      validCount += 1;
      if (!best || Math.abs(current.value) < Math.abs(best.value)) best = current;
      if (Math.abs(current.value) <= spencerConfig.intersectionTolerance) {
        return {
          exact: current,
          lower: null,
          upper: null,
          best,
          iterations: totalIterations,
          validCount,
          invalidCount,
          invalidReasonCounts,
          targetLambda: initial.targetLambda
        };
      }
      const bracket = choosePreferredLambdaSignChange(samples, initial.targetLambda);
      if (bracket) {
        return {
          exact: null,
          lower: bracket.lower,
          upper: bracket.upper,
          best,
          iterations: totalIterations,
          validCount,
          invalidCount,
          invalidReasonCounts,
          targetLambda: initial.targetLambda
        };
      }
    }
  }

  return {
    exact: null,
    lower: null,
    upper: null,
    best,
    iterations: totalIterations,
    validCount,
    invalidCount,
    invalidReasonCounts,
    targetLambda: initial.targetLambda
  };
}

function finalizeSpencerSlices(baseSlices, sliceForces, lambda) {
  const theta = Math.atan(lambda);
  return (baseSlices || []).map((slice, index) => {
    const forceState = sliceForces?.[index];
    if (!forceState) return { ...slice };
    const porePressure = Number(slice.uBase) || 0;
    const baseLength = Number(slice.baseLength) || 0;
    return {
      ...slice,
      mobilizedShear: forceState.S_mob,
      E_right: forceState.E_right,
      X_right: forceState.X_right,
      N_eff: forceState.N_eff,
      N_total: forceState.N_eff + porePressure * baseLength,
      S_mob: forceState.S_mob,
      mAlpha: forceState.mAlpha ?? slice.mAlpha,
      theta_interslice: Number.isFinite(forceState.theta_interslice)
        ? forceState.theta_interslice
        : theta
    };
  });
}

function buildSpencerUnresolvedResult(bishopF, candidate, reason, iterations = 0) {
  const thetaDeg = Number.isFinite(candidate?.lambda) ? (Math.atan(candidate.lambda) * 180) / Math.PI : null;
  return {
    converged: false,
    F: NaN,
    F_bishop: Number.isFinite(bishopF) ? bishopF : NaN,
    F_m: candidate?.F_m ?? NaN,
    F_f: candidate?.F_f ?? NaN,
    lambda: candidate?.lambda ?? null,
    thetaDeg,
    momentResidual: candidate?.state?.momentResidual ?? null,
    forceResidual: candidate?.state?.forceResidual ?? null,
    maxE: candidate?.state?.maxE ?? 0,
    tensionSlices: candidate?.state?.tensionSlices ?? 0,
    sliceForces: candidate?.state?.sliceForces || [],
    iterations,
    reason: reason || 'Spencer did not converge'
  };
}

function buildConvergedSpencerResult(bishopF, candidate, iterations = 0) {
  const thetaDeg = (Math.atan(candidate.lambda) * 180) / Math.PI;
  return {
    converged: true,
    F: candidate.F,
    F_bishop: Number.isFinite(bishopF) ? bishopF : NaN,
    F_m: candidate.F_m,
    F_f: candidate.F_f,
    lambda: candidate.lambda,
    thetaDeg,
    momentResidual: candidate.state.momentResidual,
    forceResidual: candidate.state.forceResidual,
    maxE: candidate.state.maxE,
    tensionSlices: candidate.state.tensionSlices,
    sliceForces: candidate.state.sliceForces,
    iterations,
    reason: ''
  };
}

function solveSpencerForSlices(slices, bishopDiagnostics, spencerConfig, solverConfig) {
  const bishopF = bishopDiagnostics?.FS ?? bishopDiagnostics?.F ?? null;
  if (!bishopDiagnostics?.converged || !Number.isFinite(bishopF) || bishopF <= 0) {
    return buildSpencerUnresolvedResult(bishopF, null, 'Bishop moment equilibrium did not converge', 0);
  }

  const bracket = findSpencerLambdaBracket(slices, bishopF, spencerConfig, solverConfig);
  let totalIterations = bracket.iterations || 0;
  if (bracket.exact) {
    return buildConvergedSpencerResult(bishopF, bracket.exact, totalIterations);
  }

  if (!bracket.lower || !bracket.upper) {
    const summary = summarizeReasonCounts(bracket.invalidReasonCounts);
    const suffix = summary ? ` (${summary})` : '';
    return buildSpencerUnresolvedResult(
      bishopF,
      bracket.best,
      bracket.best
        ? `Valid Spencer lambda samples found, but F_m and F_f did not intersect in the lambda range${suffix}`
        : `No admissible Spencer lambda in the search range${suffix}`,
      totalIterations
    );
  }

  let lower = bracket.lower;
  let upper = bracket.upper;
  let best = bracket.best || (Math.abs(lower.value) <= Math.abs(upper.value) ? lower : upper);

  for (let iter = 1; iter <= spencerConfig.maxOuterIter; iter += 1) {
    const lambdaMid = 0.5 * (lower.lambda + upper.lambda);
    const mid = evaluateSpencerAtLambda(slices, bishopF, lambdaMid, spencerConfig, solverConfig);
    totalIterations += mid?.iterations || 0;
    if (!mid.valid) {
      const refined = refineSpencerLambdaBracket(
        slices,
        bishopF,
        spencerConfig,
        solverConfig,
        lower,
        upper,
        best,
        bracket.targetLambda
      );
      totalIterations += refined.iterations || 0;
      if (refined.best) best = refined.best;
      if (refined.exact) {
        return buildConvergedSpencerResult(bishopF, refined.exact, totalIterations);
      }
      if (refined.bracket?.lower && refined.bracket?.upper) {
        lower = refined.bracket.lower;
        upper = refined.bracket.upper;
        continue;
      }
      return buildSpencerUnresolvedResult(
        bishopF,
        best,
        refined.reason || mid.reason || 'Spencer branch solve failed during lambda bisection',
        totalIterations
      );
    }

    if (!best || Math.abs(mid.value) < Math.abs(best.value)) best = mid;

    if (Math.abs(mid.value) <= spencerConfig.intersectionTolerance) {
      return buildConvergedSpencerResult(bishopF, mid, totalIterations);
    }

    if (Math.sign(mid.value) === Math.sign(lower.value)) {
      lower = mid;
    } else {
      upper = mid;
    }
  }

  return buildSpencerUnresolvedResult(
    bishopF,
    best,
    `Outer lambda loop did not converge in ${spencerConfig.maxOuterIter} iterations`,
    totalIterations
  );
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
      methodLabel: 'Seep/Slope',
      spencerAttempted: true,
      spencerConverged: false,
      spencerRejectReason: spencerResult?.reason || 'Spencer did not converge',
      F_m: spencerResult?.F_m ?? baseResult.F_m,
      lambda: spencerResult?.lambda ?? null,
      thetaDeg,
      theta_deg: thetaDeg,
      F_f: spencerResult?.F_f ?? null,
      momentResidual: spencerResult?.momentResidual ?? null,
      forceResidual: spencerResult?.forceResidual ?? null,
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
    momentResidual: spencerResult.momentResidual,
    forceResidual: spencerResult.forceResidual,
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

function solveBishopSimplified(slices, solverConfig, wallIntersections = []) {
  let driving = 0;
  slices.forEach((slice) => {
    driving += sliceVerticalLoad(slice) * Math.sin(slice.alphaRad);
  });
  const wallMomentTerm = totalWallMomentTerm(wallIntersections);
  driving -= wallMomentTerm;
  if (driving <= EPS) {
    return {
      converged: false,
      FS: null,
      iterations: 0,
      reason: wallMomentTerm > 0 ? 'stable by wall alone' : 'nonpositive driving term',
      wallMomentTerm,
      wallForceTotal: totalWallForce(wallIntersections),
      wallIntersections,
      sliceNormals: [],
      sliceMobilizedShears: [],
      sliceMAlpha: []
    };
  }

  let F = ordinarySeed(slices, wallIntersections);
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
          wallMomentTerm,
          wallForceTotal: totalWallForce(wallIntersections),
          wallIntersections,
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
        wallMomentTerm,
        wallForceTotal: totalWallForce(wallIntersections),
        wallIntersections,
        sliceNormals: [],
        sliceMobilizedShears: [],
        sliceMAlpha: mDiag
      };
    }
    if (Math.abs(nextF - F) < (solverConfig.tolerance || 1e-4)) {
      return buildDiagnostics(slices, nextF, iter, wallIntersections);
    }
    F = nextF;
  }

  return {
    converged: false,
    FS: null,
    iterations: solverConfig.maxIterations || 50,
    reason: 'no convergence',
    wallMomentTerm,
    wallForceTotal: totalWallForce(wallIntersections),
    wallIntersections,
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
    FS: result.FS,
    maxDepth: depth,
    intersectsWall: !!result.intersectsWall,
    passesBelowWall: !!result.passesBelowWall,
    wallIntersectionCount: result.wallIntersectionCount || 0,
    wallForceTotal: Number(result.wallForceTotal) || 0,
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
  const soilSource = input?.soilSource === 'legacy-bands' ? 'legacy-bands' : 'regions';
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
            const built = buildSlicesForCircle(circle, entry, exit, model, search, soilSource);
            if (!built.slices || built.slices.length < 3) {
              noteReject(built.reason || 'too few slices');
            } else {
              const wallInteraction = computeWallIntersections(circle, model, entry, exit, soilSource);
              const wallSlices = applyWallInteractionsToSlices(built.slices, wallInteraction.intersections);
              const bishop = solveBishopSimplified(wallSlices, solver, wallInteraction.intersections);
              if (!bishop.converged) {
                noteReject(bishop.reason || 'no convergence');
              } else {
                results.push(buildBishopSearchResult(circle, wallSlices, bishop, wallInteraction));
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
          methodLabel: 'Seep/Slope',
          FS: result.F_bishop,
          F: result.F_bishop
        };
      });
    }
    finalResults.sort((a, b) => a.FS - b.FS);
  }

  const criticalOverall = finalResults[0] || null;
  const criticalThroughWall = finalResults.find((result) => result.intersectsWall) || null;
  const criticalBelowWall = finalResults.find((result) => result.passesBelowWall) || null;
  const totalMs = Date.now() - started;
  return {
    critical: criticalOverall,
    criticalOverall,
    criticalThroughWall,
    criticalBelowWall,
    allResults: finalResults,
    summary: summarizeCritical(criticalOverall, model),
    wallSummary:
      (model?.walls || []).length > 0
        ? {
            wallCount: model.walls.length,
            criticalOverall: summarizeCritical(criticalOverall, model),
            criticalThroughWall: summarizeCritical(criticalThroughWall, model),
            criticalBelowWall: summarizeCritical(criticalBelowWall, model),
            wallEffective:
              criticalThroughWall && criticalBelowWall
                ? criticalThroughWall.FS > criticalBelowWall.FS + 1e-9
                : null
          }
        : null,
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
    const hasPrior = prev.has(id);
    const prior = prev.get(id) || {};
    const designed =
      strengthSet === 'da1_2' ? designSoilLayer(layer, 'M2')
      : strengthSet === 'da1_1' ? designSoilLayer(layer, 'M1')
      : { ...layer };
    const canReuseStrengthValues = prior.sourceStrengthSet === strengthSet;
    const permeability = resolveMaterialPermeability(layer, prior);
    const hadPriorUseConsistentTangent = Object.prototype.hasOwnProperty.call(prior.hs || {}, 'useConsistentTangent');
    const useConsistentTangent = hadPriorUseConsistentTangent
      ? Number(prior.hs.useConsistentTangent) >= 0.5 || prior.hs.useConsistentTangent === true
      : !hasPrior;
    // The HS stiffness parameters (E50_ref, Eoed_ref, Eur_ref, m, ν_ur) and
    // the K0_nc / ψ values are SEEDED from the upstream layer-classification
    // logic (`hsParams` in legacy-controller, per CUR 2003-7 /
    // SB260-21-6.4.10 / Schanz, Vermeer & Bonnier (1999)). They live on the
    // material as top-level fields — NOT inside `material.hs` — so the wire
    // encoder can route them directly to the WASM HS block by name and so
    // the HS panel can override them per material (mirroring MC). Prior
    // top-level overrides are preserved here on re-sync, matching the MC
    // convention used for `Emc`, `nu`, `K0nc`, etc.
    //
    // The `material.hs` sub-block is reserved for the genuinely HS-specific
    // parameters that have NO upstream analogue: R_f (failure ratio), OCR
    // (over-consolidation), p_ref (reference pressure), e_init / e_max
    // (dilatancy cutoff).
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
      Emc: Number.isFinite(prior.Emc) && prior.Emc > 0 ? prior.Emc : Number(layer.Emc) || Number(layer.E50_i) || Number(layer.E50_ref) || 1000,
      nu: Number.isFinite(prior.nu) ? prior.nu : Number(layer.nu),
      K0nc: Number.isFinite(prior.K0nc) ? prior.K0nc : Number(layer.K0nc),
      rShear: Number.isFinite(prior.rShear) && prior.rShear > 0 ? prior.rShear : Number(layer.rShear) || 0.25,
      psi: Number.isFinite(prior.psi) ? prior.psi : Number(layer.psi) || 0,
      sigmaTAllow: Number.isFinite(prior.sigmaTAllow) ? prior.sigmaTAllow : 0,
      // HS stiffness fields seeded from the layer / material classification
      // but preserved across re-imports if the engineer has overridden them
      // in the Stage 6 HS panel (same convention as `Emc` / `nu` / `K0nc`).
      E50_ref: Number.isFinite(prior.E50_ref) && prior.E50_ref > 0
        ? prior.E50_ref
        : Number(layer.E50_ref) || Number(layer.Emc) || Number(layer.E50_i) || 1000,
      Eoed_ref: Number.isFinite(prior.Eoed_ref) && prior.Eoed_ref > 0
        ? prior.Eoed_ref
        : Number(layer.Eoed_ref) || Number(layer.E50_ref) || Number(layer.Emc) || 1000,
      Eur_ref: Number.isFinite(prior.Eur_ref) && prior.Eur_ref > 0
        ? prior.Eur_ref
        : Number(layer.Eur_ref) || 3 * (Number(layer.E50_ref) || Number(layer.Emc) || 1000),
      m: Number.isFinite(prior.m)
        ? prior.m
        : (Number.isFinite(Number(layer.m)) ? Number(layer.m) : 0.5),
      nu_ur: Number.isFinite(prior.nu_ur)
        ? prior.nu_ur
        : (Number.isFinite(Number(layer.nu_ur)) ? Number(layer.nu_ur) : 0.2),
      // HS-only sub-block: parameters with no upstream analogue.
      hs: {
        p_ref: Number.isFinite(Number(prior.hs?.p_ref)) && Number(prior.hs.p_ref) > 0 ? Number(prior.hs.p_ref) : 100,
        Rf: Number.isFinite(Number(prior.hs?.Rf)) ? Number(prior.hs.Rf) : 0.9,
        e_init: Number.isFinite(Number(prior.hs?.e_init)) ? Number(prior.hs.e_init) : -1,
        e_max: Number.isFinite(Number(prior.hs?.e_max)) ? Number(prior.hs.e_max) : -1,
        OCR: Number.isFinite(Number(prior.hs?.OCR)) && Number(prior.hs.OCR) > 0 ? Number(prior.hs.OCR) : 1,
        nearSurfaceMinConfiningStress: Math.max(
          Number.isFinite(Number(prior.hs?.nearSurfaceMinConfiningStress))
            ? Number(prior.hs.nearSurfaceMinConfiningStress)
            : (Number.isFinite(Number(prior.hs?.reserved)) ? Number(prior.hs.reserved) : 0),
          0
        ),
        useConsistentTangent
      },
      kx: permeability.kx,
      ky: permeability.ky,
      kSource: permeability.kSource,
      color: prior.color || DEFAULT_MATERIAL_COLORS[index % DEFAULT_MATERIAL_COLORS.length]
    };
  });
}

/**
 * Compute K0_nc via Jaky's formula (1 − sin φ'). Clamped at 0.05 to keep the
 * derived value physically meaningful even for very small φ. φ in degrees.
 */
export function bishopHsJakyK0nc(phiEffDeg) {
  const phi = (Number(phiEffDeg) || 0) * Math.PI / 180;
  return Math.max(0.05, 1 - Math.sin(phi));
}

/**
 * Critical-state friction angle φ_cv via the inverse Rowe relation:
 *   sin φ_cv = (sin φ − sin ψ) / (1 − sin φ · sin ψ).
 * Returns φ_cv in degrees. Pure read-only helper for the HS panel's
 * "derived values" display; the actual constitutive update derives φ_cv
 * inside material_hs.hpp.
 */
export function bishopHsRowePhiCvDeg(phiEffDeg, psiEffDeg) {
  const phi = (Number(phiEffDeg) || 0) * Math.PI / 180;
  const psi = (Number(psiEffDeg) || 0) * Math.PI / 180;
  const sphi = Math.sin(phi);
  const spsi = Math.sin(psi);
  const denom = 1 - sphi * spsi;
  if (Math.abs(denom) < 1e-12) return Number(phiEffDeg) || 0;
  const sphiCv = (sphi - spsi) / denom;
  const clamped = Math.max(-0.999, Math.min(0.999, sphiCv));
  return Math.asin(clamped) * 180 / Math.PI;
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
      layer.gs,
      layer.kh,
      layer.kv
    ])
  );
}

export function buildBishopModelFromStageLayers(layers, bishopState, options = {}) {
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

  const legacyBands = layers.map((layer, index) => ({
    id: `band_${index}`,
    topY: yGround - (Number(layer.top) || 0),
    botY: index === layers.length - 1 ? analysisBottomY : yGround - (Number(layer.bot) || 0),
    topFollowsTerrain: index === 0,
    material: materials[index]
  }));

  const autoRegions = buildCptAutoRegions(terrain, layers, cptX, analysisBottomY, materials);
  const materialMap = new Map(materials.map((material) => [material.id, material]));
  const customRegions = (bishopState?.customRegions || [])
    .map((region, index) => {
      const polygon = normalizeRegionPolygon(region?.polygon || []);
      const materialId = typeof region?.materialId === 'string' ? region.materialId : materials[0]?.id || null;
      return {
        id: region?.id || `user-region-${index}`,
        polygon,
        materialId,
        coarseness: normalizeRegionCoarseness(region?.coarseness),
        material: materialMap.get(materialId) || null,
        source: region?.source === 'cpt-copy' ? 'cpt-copy' : region?.source === 'hole' ? 'hole' : region?.source === 'edited' ? 'edited' : 'custom'
      };
    })
    .filter((region) => region.material && region.polygon.length >= 3 && polygonArea(region.polygon) > 1e-4 && isSimplePolygon(region.polygon));
  const useCustomRegions = !!bishopState?.useCustomRegions && customRegions.length > 0;
  const regions = useCustomRegions ? customRegions : autoRegions;

  const phreaticVertices = (bishopState?.phreatic || [])
    .filter((pt) => Number.isFinite(pt?.x) && Number.isFinite(pt?.y))
    .sort((a, b) => a.x - b.x);
  const phreatic =
    phreaticVertices.length >= 2
      ? {
          vertices: phreaticVertices
        }
      : null;

  const rawSurfaceLoads = Array.isArray(bishopState?.surfaceLoads) && bishopState.surfaceLoads.length
    ? bishopState.surfaceLoads
    : (bishopState?.surfaceLoad ? [bishopState.surfaceLoad] : []);
  const outOfPlaneLength = Math.max(Number(bishopState?.deformation?.options?.outOfPlaneLength) || 10, 0.1);
  const globalLoadMode = bishopState?.deformation?.options?.loadMode === 'total' ? 'total' : 'pressure';
  const globalTotalLoad = Math.max(Number(bishopState?.deformation?.options?.totalLoad) || 0, 0);
  const surfaceLoads = rawSurfaceLoads
    .map((rawSurfaceLoad, index) => {
      if (!rawSurfaceLoad) return null;
      if (!Number.isFinite(rawSurfaceLoad?.xStart) || !Number.isFinite(rawSurfaceLoad?.xEnd)) return null;
      const xStart = clampXToTerrain(terrain, Math.min(rawSurfaceLoad.xStart, rawSurfaceLoad.xEnd));
      const xEnd = clampXToTerrain(terrain, Math.max(rawSurfaceLoad.xStart, rawSurfaceLoad.xEnd));
      if (!(xEnd > xStart + GEOM_EPS)) return null;
      const width = xEnd - xStart;
      const loadMode = rawSurfaceLoad.loadMode === 'total' || rawSurfaceLoad.loadMode === 'pressure'
        ? rawSurfaceLoad.loadMode
        : globalLoadMode;
      const totalLoad = Math.max(
        Number(rawSurfaceLoad.totalLoad) || (rawSurfaceLoads.length === 1 ? globalTotalLoad : 0),
        0
      );
      const q = loadMode === 'total'
        ? totalLoad / Math.max(width * outOfPlaneLength, 1e-6)
        : Math.max(Number(rawSurfaceLoad.q) || 0, 0);
      return {
        id: rawSurfaceLoad.id || `load-${index + 1}`,
        label: rawSurfaceLoad.label || `Load ${index + 1}`,
        xStart,
        xEnd,
        q,
        loadMode,
        totalLoad: loadMode === 'total' ? totalLoad : q * width * outOfPlaneLength,
        active: rawSurfaceLoad.active !== false
      };
    })
    .filter(Boolean);
  const surfaceLoad = surfaceLoads.find((load) => load.active !== false && load.q > 0) || surfaceLoads[0] || null;

  const boundaryYs = uniqueSorted(
    layers
      .slice(0, -1)
      .map((layer) => yGround - (Number(layer.bot) || 0))
      .filter(Number.isFinite)
  );

  const walls = (bishopState?.walls || [])
    .map((wall, index) => {
      const endpoints = wallEndpoints(wall);
      const head = endpoints?.head || {
        x: Number(wall?.x),
        y: Number(wall?.yTop)
      };
      const tip = endpoints?.tip || {
        x: Number(wall?.x),
        y: Number(wall?.yTip)
      };
      return {
        id: wall?.id || `wall-${index + 1}`,
        head,
        tip,
        x: head.x,
        yTop: head.y,
        yTip: tip.y,
        passiveSide: normalizePassiveSide(wall?.passiveSide),
        mechanicalActive: wall?.mechanicalActive === true,
        anchors: Array.isArray(wall?.anchors) ? wall.anchors : [],
        maxShearForce:
          Number.isFinite(Number(wall?.maxShearForce)) && Number(wall.maxShearForce) > 0
            ? Number(wall.maxShearForce)
            : null,
        material: normalizeWallMaterial(wall?.material, index, wall?.id || `wall-${index + 1}`)
      };
    })
    .filter((wall) => {
      const axis = wallAxis(wall, GEOM_EPS);
      return (
        axis &&
        axis.head.x >= terrain.vertices[0].x - GEOM_EPS &&
        axis.head.x <= terrain.vertices[terrain.vertices.length - 1].x + GEOM_EPS &&
        axis.tip.x >= terrain.vertices[0].x - GEOM_EPS &&
        axis.tip.x <= terrain.vertices[terrain.vertices.length - 1].x + GEOM_EPS
      );
    })
    .sort((a, b) => a.head.x - b.head.x || b.head.y - a.head.y || a.tip.x - b.tip.x);
  const drains = normalizeDrains(bishopState?.drains || []);

  const model = {
    terrain,
    phreatic,
    cptX,
    cptGroundY: yGround,
    analysisBottomY,
    useFemPorePressure: !!bishopState?.useFemPorePressure,
    materials,
    strengthSet: bishopState?.strengthSet || 'characteristic',
    regionMode: useCustomRegions ? 'custom' : 'auto',
    autoRegions,
    customRegions,
    regions,
    regionBoundaryPolylines: useCustomRegions ? buildRegionBoundaryPolylines(customRegions) : [],
    boundaryYs,
    surfaceLoad,
    surfaceLoads,
    walls,
    drains,
    seepage: bishopState?.seepage || null,
    deformation: bishopState?.deformation || null
  };
  if (options.includeLegacyBands) model.legacyBands = legacyBands;
  return model;
}
