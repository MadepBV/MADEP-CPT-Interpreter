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
    numerator += c * slice.baseLength + (slice.W * Math.cos(slice.alphaRad) - slice.uBase * slice.baseLength) * tanPhi;
    denominator += slice.W * Math.sin(slice.alphaRad);
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
    const mAlpha = Math.cos(slice.alphaRad) + (Math.sin(slice.alphaRad) * tanPhi) / F;
    const N =
      (slice.W -
        ((c * slice.baseLength - slice.uBase * slice.baseLength * tanPhi) * Math.sin(slice.alphaRad)) / F) /
      mAlpha;
    const T = (c * slice.baseLength + (N - slice.uBase * slice.baseLength) * tanPhi) / F;
    sliceNormals.push(N);
    sliceMobilizedShears.push(T);
    sliceMAlpha.push(mAlpha);
  });

  return {
    converged: true,
    FS: F,
    iterations,
    reason: '',
    sliceNormals,
    sliceMobilizedShears,
    sliceMAlpha
  };
}

function solveBishopSimplified(slices, solverConfig) {
  let driving = 0;
  slices.forEach((slice) => {
    driving += slice.W * Math.sin(slice.alphaRad);
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
      resisting += (c * slice.dx + (slice.W - slice.uBase * slice.baseLength) * tanPhi) / mAlpha;
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
                const enrichedSlices = built.slices.map((slice, index) => ({
                  ...slice,
                  mAlpha: bishop.sliceMAlpha[index],
                  normalForce: bishop.sliceNormals[index],
                  mobilizedShear: bishop.sliceMobilizedShears[index]
                }));
                results.push({
                  circle,
                  FS: bishop.FS,
                  iterations: bishop.iterations,
                  converged: true,
                  diagnostics: bishop,
                  slices: enrichedSlices
                });
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
  const critical = results[0] || null;
  const totalMs = Date.now() - started;
  return {
    critical,
    allResults: results,
    summary: summarizeCritical(critical, model),
    rejectionCounts,
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
    boundaryYs
  };
}
