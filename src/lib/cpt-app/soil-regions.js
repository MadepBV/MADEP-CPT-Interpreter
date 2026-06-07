// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

const EPS = 1e-9;
const GEOM_EPS = 1e-6;

function uniqueSorted(values, tol = GEOM_EPS) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out = [];
  sorted.forEach((value) => {
    if (!out.length || Math.abs(value - out[out.length - 1]) > tol) out.push(value);
  });
  return out;
}

function sqr(value) {
  return value * value;
}

function polygonSignedArea(points) {
  if (!points?.length || points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return 0.5 * sum;
}

export function polygonArea(points) {
  return Math.abs(polygonSignedArea(points));
}

function cleanPolygon(points) {
  const cleaned = (points || []).reduce((acc, point) => {
    const pt = { x: Number(point?.x), y: Number(point?.y) };
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return acc;
    const last = acc[acc.length - 1];
    if (!last || Math.hypot(last.x - pt.x, last.y - pt.y) > GEOM_EPS) acc.push(pt);
    return acc;
  }, []);
  if (cleaned.length > 1) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= GEOM_EPS) cleaned.pop();
  }
  if (cleaned.length >= 3 && polygonSignedArea(cleaned) < 0) cleaned.reverse();
  return cleaned;
}

export function normalizeRegionPolygon(points) {
  return cleanPolygon(points);
}

function segmentOrientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersectClosed(a, b, c, d, tol = GEOM_EPS) {
  const o1 = segmentOrientation(a, b, c);
  const o2 = segmentOrientation(a, b, d);
  const o3 = segmentOrientation(c, d, a);
  const o4 = segmentOrientation(c, d, b);

  if (Math.abs(o1) <= tol && pointOnSegment(c, a, b, tol)) return true;
  if (Math.abs(o2) <= tol && pointOnSegment(d, a, b, tol)) return true;
  if (Math.abs(o3) <= tol && pointOnSegment(a, c, d, tol)) return true;
  if (Math.abs(o4) <= tol && pointOnSegment(b, c, d, tol)) return true;

  return (
    ((o1 > tol && o2 < -tol) || (o1 < -tol && o2 > tol)) &&
    ((o3 > tol && o4 < -tol) || (o3 < -tol && o4 > tol))
  );
}

export function isSimplePolygon(points) {
  const pts = cleanPolygon(points);
  if (pts.length < 3) return false;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    for (let j = i + 1; j < pts.length; j += 1) {
      if (j === i) continue;
      if (j === i + 1 || (i === 0 && j === pts.length - 1)) continue;
      const c = pts[j];
      const d = pts[(j + 1) % pts.length];
      if (segmentsIntersectClosed(a, b, c, d)) return false;
    }
  }
  return true;
}

function samplePolylineY(polyline, x) {
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
  // Vertical face (two stacked vertices at x): a single-valued height query returns the TOP of the
  // step, so surface loads / CPT / band tops sit on the upper ground, not in the void of the drop.
  if (Math.abs(b.x - a.x) < EPS) return Math.max(a.y, b.y);
  if (Math.abs(x - a.x) < EPS && lo > 0 && Math.abs(verts[lo - 1].x - a.x) < EPS) return Math.max(a.y, verts[lo - 1].y);
  const t = (x - a.x) / (b.x - a.x);
  return a.y + (b.y - a.y) * t;
}

function polylineLevelIntersectionsX(polyline, levelY) {
  const verts = polyline?.vertices || [];
  const out = [];
  for (let i = 0; i < verts.length - 1; i += 1) {
    const a = verts[i];
    const b = verts[i + 1];
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    if (levelY < minY - GEOM_EPS || levelY > maxY + GEOM_EPS) continue;
    if (Math.abs(b.y - a.y) < EPS) {
      if (Math.abs(levelY - a.y) < GEOM_EPS) out.push(a.x, b.x);
      continue;
    }
    const t = (levelY - a.y) / (b.y - a.y);
    if (t >= -GEOM_EPS && t <= 1 + GEOM_EPS) out.push(a.x + (b.x - a.x) * t);
  }
  return out;
}

function bandUpperYAt(x, terrain, topY, topFollowsTerrain) {
  const terrainVal = samplePolylineY(terrain, x);
  return topFollowsTerrain ? terrainVal : Math.min(terrainVal, topY);
}

function bandLowerYAt(x, terrain, botY) {
  return Math.min(samplePolylineY(terrain, x), botY);
}

export function buildBandPolygons(terrain, topY, botY, topFollowsTerrain) {
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
    const polygon = cleanPolygon([...upper, ...lower]);
    if (polygonArea(polygon) > 1e-4) polygons.push(polygon);
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

export function buildCptAutoRegions(terrain, layers, cptX, analysisBottomY, materials) {
  const yGround = samplePolylineY(terrain, cptX);
  const regions = [];
  (layers || []).forEach((layer, index) => {
    const topY = yGround - (Number(layer?.top) || 0);
    const botY =
      index === layers.length - 1 ? analysisBottomY : yGround - (Number(layer?.bot) || 0);
    const topFollowsTerrain = index === 0;
    const polygons = buildBandPolygons(terrain, topY, botY, topFollowsTerrain);
    polygons.forEach((polygon, polyIndex) => {
      regions.push({
        id: `cpt-${index}-${polyIndex}`,
        polygon,
        material: materials?.[index] || null,
        coarseness: 1,
        source: 'cpt-auto',
        topFollowsTerrain
      });
    });
  });
  return regions;
}

function pointOnSegment(point, a, b, tol = GEOM_EPS) {
  const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
  if (Math.abs(cross) > tol) return false;
  const dot = (point.x - a.x) * (point.x - b.x) + (point.y - a.y) * (point.y - b.y);
  return dot <= tol;
}

export function pointInPolygonHalfOpen(polygon, x, y) {
  const point = { x, y };
  const pts = cleanPolygon(polygon);
  if (pts.length < 3) return false;
  for (let i = 0; i < pts.length; i += 1) {
    if (pointOnSegment(point, pts[i], pts[(i + 1) % pts.length])) return true;
  }
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const a = pts[i];
    const b = pts[j];
    const intersects = (a.y > y) !== (b.y > y);
    if (!intersects) continue;
    const xHit = ((b.x - a.x) * (y - a.y)) / ((b.y - a.y) || EPS) + a.x;
    if (xHit >= x - GEOM_EPS) inside = !inside;
  }
  return inside;
}

export function materialAt(regions, x, y) {
  for (let i = (regions || []).length - 1; i >= 0; i -= 1) {
    const region = regions[i];
    if (pointInPolygonHalfOpen(region?.polygon, x, y)) return region.material || null;
  }
  return null;
}

function polygonVerticalIntervals(polygon, x) {
  const pts = cleanPolygon(polygon);
  if (pts.length < 3) return [];

  const yHits = [];
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x;

    if (Math.abs(dx) < EPS) {
      if (Math.abs(x - a.x) <= GEOM_EPS) yHits.push(a.y, b.y);
      continue;
    }

    const crosses = (a.x <= x + GEOM_EPS && b.x > x + GEOM_EPS) || (b.x <= x + GEOM_EPS && a.x > x + GEOM_EPS);
    if (!crosses) continue;
    const t = (x - a.x) / dx;
    if (t >= -GEOM_EPS && t <= 1 + GEOM_EPS) yHits.push(a.y + (b.y - a.y) * t);
  }

  const ys = uniqueSorted(yHits);
  const intervals = [];
  for (let i = 0; i + 1 < ys.length; i += 2) {
    const yBottom = Math.min(ys[i], ys[i + 1]);
    const yTop = Math.max(ys[i], ys[i + 1]);
    if (yTop > yBottom + GEOM_EPS) intervals.push({ yBottom, yTop });
  }
  return intervals;
}

function mergeIntervals(intervals) {
  const sorted = (intervals || [])
    .filter((interval) => Number.isFinite(interval?.yBottom) && Number.isFinite(interval?.yTop) && interval.yTop > interval.yBottom + GEOM_EPS)
    .sort((a, b) => a.yBottom - b.yBottom || a.yTop - b.yTop);
  const merged = [];
  sorted.forEach((interval) => {
    const last = merged[merged.length - 1];
    if (last && interval.yBottom <= last.yTop + GEOM_EPS) {
      last.yTop = Math.max(last.yTop, interval.yTop);
    } else {
      merged.push({ yBottom: interval.yBottom, yTop: interval.yTop });
    }
  });
  return merged;
}

function clipIntervalsToBand(intervals, yBottom, yTop) {
  if (!(yTop > yBottom + GEOM_EPS)) return [];
  return mergeIntervals(
    (intervals || []).map((interval) => ({
      yBottom: Math.max(interval.yBottom, yBottom),
      yTop: Math.min(interval.yTop, yTop)
    }))
  );
}

function subtractIntervals(intervals, covered) {
  const source = mergeIntervals(intervals);
  const mask = mergeIntervals(covered);
  if (!mask.length) return source;
  const out = [];
  source.forEach((interval) => {
    let cursor = interval.yBottom;
    mask.forEach((cover) => {
      if (cover.yTop <= cursor + GEOM_EPS || cover.yBottom >= interval.yTop - GEOM_EPS) return;
      if (cover.yBottom > cursor + GEOM_EPS) {
        out.push({
          yBottom: cursor,
          yTop: Math.min(cover.yBottom, interval.yTop)
        });
      }
      cursor = Math.max(cursor, cover.yTop);
    });
    if (cursor < interval.yTop - GEOM_EPS) {
      out.push({
        yBottom: cursor,
        yTop: interval.yTop
      });
    }
  });
  return mergeIntervals(out);
}

function splitIntervalByWater(yBottom, yTop, waterY) {
  const total = Math.max(0, yTop - yBottom);
  if (!(total > GEOM_EPS) || !Number.isFinite(waterY)) {
    return { dry: total, wet: 0 };
  }
  if (waterY <= yBottom + GEOM_EPS) {
    return { dry: total, wet: 0 };
  }
  const wet = Math.max(0, Math.min(yTop, waterY) - yBottom);
  return {
    dry: Math.max(0, total - wet),
    wet
  };
}

function sampleRegionSpan(region, x, yTop, yBottom, waterY = null) {
  const clipped = clipIntervalsToBand(polygonVerticalIntervals(region?.polygon, x), yBottom, yTop);
  let dry = 0;
  let wet = 0;
  clipped.forEach((interval) => {
    const split = splitIntervalByWater(interval.yBottom, interval.yTop, waterY);
    dry += split.dry;
    wet += split.wet;
  });
  return {
    dry,
    wet,
    total: dry + wet
  };
}

function sampleVisibleRegionSpan(region, x, yTop, yBottom, waterY = null, coveredIntervals = []) {
  const rawIntervals = clipIntervalsToBand(polygonVerticalIntervals(region?.polygon, x), yBottom, yTop);
  const visibleIntervals = subtractIntervals(rawIntervals, coveredIntervals);
  let dry = 0;
  let wet = 0;
  visibleIntervals.forEach((interval) => {
    const split = splitIntervalByWater(interval.yBottom, interval.yTop, waterY);
    dry += split.dry;
    wet += split.wet;
  });
  return {
    rawIntervals,
    visibleIntervals,
    dry,
    wet,
    total: dry + wet
  };
}

export function regionStripOverlap(regions, xL, xR, yTopFn, yBaseFn, phreaticFn = null) {
  if (!(xR > xL + GEOM_EPS)) return [];
  const dx = xR - xL;
  const xMid = 0.5 * (xL + xR);
  const samples = [
    { x: xL, factor: 1 },
    { x: xMid, factor: 4 },
    { x: xR, factor: 1 }
  ];
  const terms = (regions || []).map(() => ({ areaTerm: 0, weightTerm: 0 }));

  samples.forEach((sample) => {
    const yTop = yTopFn(sample.x);
    const yBottom = yBaseFn(sample.x);
    const waterY = typeof phreaticFn === 'function' ? phreaticFn(sample.x) : null;
    let coveredIntervals = [];

    for (let i = (regions || []).length - 1; i >= 0; i -= 1) {
      const region = regions[i];
      const gammaDry = Number.isFinite(Number(region?.material?.gamma)) ? Number(region.material.gamma) : 18;
      const gammaSat = Number.isFinite(Number(region?.material?.gammaSat))
        ? Number(region.material.gammaSat)
        : gammaDry + 2;
      const strip = sampleVisibleRegionSpan(region, sample.x, yTop, yBottom, waterY, coveredIntervals);
      coveredIntervals = mergeIntervals([...coveredIntervals, ...strip.rawIntervals]);
      if (!(strip.total > GEOM_EPS)) continue;
      terms[i].areaTerm += sample.factor * strip.total;
      terms[i].weightTerm += sample.factor * (strip.dry * gammaDry + strip.wet * gammaSat);
    }
  });

  return (regions || []).flatMap((region, index) => {
    const area = (dx / 6) * terms[index].areaTerm;
    const weight = (dx / 6) * terms[index].weightTerm;
    if (!(area > GEOM_EPS)) return [];
    return [{
      regionId: region.id,
      material: region.material,
      area,
      weight
    }];
  });
}

export function probeVerticalRegionStack(regions, x, yBottom, yTop, waterY = null) {
  const materialOrder = new Map();
  (regions || []).forEach((region, index) => {
    const materialId = region?.material?.id;
    if (materialId && !materialOrder.has(materialId)) materialOrder.set(materialId, index);
  });
  const segments = [];
  let coveredIntervals = [];
  for (let regionIndex = (regions || []).length - 1; regionIndex >= 0; regionIndex -= 1) {
    const region = regions[regionIndex];
    const material = region?.material;
    if (!material) continue;
    const gammaDry = Number.isFinite(Number(material.gamma)) ? Number(material.gamma) : 18;
    const gammaSat = Number.isFinite(Number(material.gammaSat)) ? Number(material.gammaSat) : gammaDry + 2;
    const rawIntervals = clipIntervalsToBand(polygonVerticalIntervals(region?.polygon, x), yBottom, yTop);
    const intervals = subtractIntervals(rawIntervals, coveredIntervals);
    coveredIntervals = mergeIntervals([...coveredIntervals, ...rawIntervals]);
    intervals.forEach((interval) => {
      const splits = [];
      if (Number.isFinite(waterY) && waterY > interval.yBottom + GEOM_EPS && waterY < interval.yTop - GEOM_EPS) {
        splits.push(
          { yBottom: interval.yBottom, yTop: waterY, gamma: gammaSat },
          { yBottom: waterY, yTop: interval.yTop, gamma: gammaDry }
        );
      } else {
        splits.push({
          yBottom: interval.yBottom,
          yTop: interval.yTop,
          gamma: Number.isFinite(waterY) && waterY > interval.yBottom + GEOM_EPS ? gammaSat : gammaDry
        });
      }
      splits.forEach((segment) => {
        if (!(segment.yTop > segment.yBottom + GEOM_EPS)) return;
        segments.push({
          yBottom: segment.yBottom,
          yTop: segment.yTop,
          gamma: segment.gamma,
          material
        });
      });
    });
  }

  segments.sort((a, b) => {
    const orderA = materialOrder.get(a.material?.id) ?? Number.MAX_SAFE_INTEGER;
    const orderB = materialOrder.get(b.material?.id) ?? Number.MAX_SAFE_INTEGER;
    return orderA - orderB || a.yBottom - b.yBottom || a.yTop - b.yTop;
  });
  const merged = [];
  segments.forEach((segment) => {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.material?.id === segment.material?.id &&
      Math.abs(last.gamma - segment.gamma) <= GEOM_EPS &&
      Math.abs(last.yTop - segment.yBottom) <= GEOM_EPS
    ) {
      last.yTop = segment.yTop;
    } else {
      merged.push({ ...segment });
    }
  });
  return merged;
}
