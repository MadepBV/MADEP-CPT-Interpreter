// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { buildSectionMesh } from '../mesh/section-mesh.js';
import { buildSectionPslg, polygonSegments } from '../mesh/section-pslg.js';
import { buildOuterBoundary } from '../seepage/boundary.js';
import { triangulatePslg } from '../seepage/triangle-runtime.js';
import { terrainY } from '../stage6-bishop.js';

const GEOM_EPS = 1e-6;
const SEGMENT_PRIORITY = {
  region: 1,
  outer: 3
};

function dist(a, b) {
  return Math.hypot((b?.x || 0) - (a?.x || 0), (b?.y || 0) - (a?.y || 0));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function uniqueSorted(values, tol = GEOM_EPS) {
  const sorted = [...values]
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const out = [];
  sorted.forEach((value) => {
    if (!out.length || Math.abs(value - out[out.length - 1]) > tol) out.push(value);
  });
  return out;
}

function regionAreaLimit(region, options) {
  const baseArea = Math.max(Number(options?.regionTargetArea ?? options?.meshTargetArea) || 0.5, 0.01);
  const coarseness = Number.isFinite(Number(region?.coarseness)) && Number(region.coarseness) > 0 ? Number(region.coarseness) : 1;
  return Math.max(baseArea * coarseness, 1e-4);
}

function deformationOuterMarker(edge) {
  return {
    markerType: 'outer',
    source: edge.source,
    sourceIndex: edge.index,
    edgeKey: edge.edgeKey
  };
}

function splitTerrainEdgeAtXs(edge, xs) {
  if (edge?.source !== 'terrain' || !Array.isArray(xs) || !xs.length) return [edge];
  const x0 = Number(edge.a?.x);
  const x1 = Number(edge.b?.x);
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || Math.abs(x1 - x0) <= GEOM_EPS) return [edge];
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const ts = [0, 1];
  xs.forEach((x) => {
    if (!(x > minX + GEOM_EPS && x < maxX - GEOM_EPS)) return;
    ts.push((x - x0) / (x1 - x0));
  });
  const uniqueTs = uniqueSorted(ts, 1e-8);
  const pieces = [];
  for (let i = 0; i < uniqueTs.length - 1; i += 1) {
    const t0 = uniqueTs[i];
    const t1 = uniqueTs[i + 1];
    if (!(t1 > t0 + GEOM_EPS)) continue;
    const a = {
      x: +lerp(edge.a.x, edge.b.x, t0).toFixed(6),
      y: +lerp(edge.a.y, edge.b.y, t0).toFixed(6)
    };
    const b = {
      x: +lerp(edge.a.x, edge.b.x, t1).toFixed(6),
      y: +lerp(edge.a.y, edge.b.y, t1).toFixed(6)
    };
    if (!(dist(a, b) > GEOM_EPS)) continue;
    pieces.push({ ...edge, a, b });
  }
  return pieces.length ? pieces : [edge];
}

function overlapRange(a0, a1, b0, b1) {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return hi > lo + GEOM_EPS ? { lo, hi } : null;
}

function buildLoadRefinementMeta(model, load, targetArea) {
  const terrain = model?.terrain?.vertices || [];
  if (!(load?.xEnd > load?.xStart + GEOM_EPS) || terrain.length < 2) return null;
  const xMin = terrain[0].x;
  const xMax = terrain[terrain.length - 1].x;
  const width = load.xEnd - load.xStart;
  const baseSpacing = Math.max(Math.sqrt(Math.max(Number(targetArea) || 0.05, 0.01)), 0.12);
  const refinedSpacing = Math.max(baseSpacing * 0.45, 0.08);
  const edgeSpacing = Math.max(baseSpacing * 0.35, 0.06);
  const edgeHalfWidth = Math.min(Math.max(width * 0.1, refinedSpacing * 2, 0.25), Math.max(width * 0.4, 0.25));
  const topDepth = Math.max(Math.min(0.9 * width, 4.5), Math.max(0.75, 2.5 * refinedSpacing));
  const edgeDepth = Math.max(Math.min(1.8 * width, 7), Math.max(topDepth * 1.5, 4 * edgeSpacing));
  const splitXs = uniqueSorted(
    [
      clamp(load.xStart - edgeHalfWidth, xMin, xMax),
      clamp(load.xStart, xMin, xMax),
      clamp(load.xStart + edgeHalfWidth, xMin, xMax),
      clamp(load.xEnd - edgeHalfWidth, xMin, xMax),
      clamp(load.xEnd, xMin, xMax),
      clamp(load.xEnd + edgeHalfWidth, xMin, xMax)
    ],
    1e-5
  );
  return {
    width,
    baseSpacing,
    refinedSpacing,
    edgeSpacing,
    edgeHalfWidth,
    topDepth,
    edgeDepth,
    splitXs
  };
}

function buildOuterSegments(model, load, options, allocateMarker) {
  const baseLength = Math.sqrt(Math.max(Number(options?.segmentTargetArea ?? options?.meshTargetArea) || 0.5, 0.01));
  const refinement = buildLoadRefinementMeta(model, load, options?.meshTargetArea);
  return buildOuterBoundary(model).flatMap((edge) => {
    const pieces = splitTerrainEdgeAtXs(edge, refinement?.splitXs || []);
    return pieces.map((piece) => {
      const xMid = 0.5 * (piece.a.x + piece.b.x);
      let segmentTargetLength = edge.source === 'terrain' ? Math.max(baseLength * 0.8, 0.05) : baseLength;
      if (refinement && piece.source === 'terrain') {
        const topOverlap = overlapRange(piece.a.x, piece.b.x, load.xStart, load.xEnd);
        const leftOverlap = overlapRange(piece.a.x, piece.b.x, load.xStart - refinement.edgeHalfWidth, load.xStart + refinement.edgeHalfWidth);
        const rightOverlap = overlapRange(piece.a.x, piece.b.x, load.xEnd - refinement.edgeHalfWidth, load.xEnd + refinement.edgeHalfWidth);
        if (topOverlap) segmentTargetLength = Math.min(segmentTargetLength, refinement.refinedSpacing);
        if (leftOverlap || rightOverlap || Math.abs(xMid - load.xStart) <= refinement.edgeHalfWidth || Math.abs(xMid - load.xEnd) <= refinement.edgeHalfWidth) {
          segmentTargetLength = Math.min(segmentTargetLength, refinement.edgeSpacing);
        }
      }
      return {
        ...piece,
        kind: 'outer',
        priority: SEGMENT_PRIORITY.outer,
        segmentTargetLength,
        markerId: allocateMarker(deformationOuterMarker(piece))
      };
    });
  });
}

function buildLoadRefinementPoints(model, load, options) {
  const refinement = buildLoadRefinementMeta(model, load, options?.meshTargetArea);
  const terrain = model?.terrain?.vertices || [];
  if (!refinement || terrain.length < 2) return [];
  const xMin = terrain[0].x;
  const xMax = terrain[terrain.length - 1].x;
  const points = [];
  const pushPoint = (x, depth) => {
    const clampedX = clamp(x, xMin, xMax);
    const ySurface = terrainY(model.terrain, clampedX);
    const y = ySurface - depth;
    if (!(Number.isFinite(ySurface) && Number.isFinite(y) && y > model.analysisBottomY + 0.05)) return;
    points.push({ x: clampedX, y });
  };

  for (let x = load.xStart + 0.5 * refinement.refinedSpacing; x < load.xEnd - 0.5 * refinement.refinedSpacing; x += refinement.refinedSpacing) {
    [0.3, 0.6, 1.0].forEach((factor) => pushPoint(x, factor * refinement.topDepth));
  }

  const buildEdgeColumn = (xCenter) => {
    for (let x = xCenter - refinement.edgeHalfWidth; x <= xCenter + refinement.edgeHalfWidth + GEOM_EPS; x += refinement.edgeSpacing) {
      [0.18, 0.38, 0.62, 1].forEach((factor) => pushPoint(x, factor * refinement.edgeDepth));
    }
  };
  buildEdgeColumn(load.xStart);
  buildEdgeColumn(load.xEnd);

  const deduped = new Map();
  points.forEach((point) => {
    const key = `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
    deduped.set(key, point);
  });
  return [...deduped.values()];
}

function buildRegionBoundarySegments(regions, options, allocateMarker) {
  return (regions || []).flatMap((region, regionIndex) =>
    polygonSegments(region?.polygon || [], {
      kind: 'region',
      priority: SEGMENT_PRIORITY.region,
      regionId: region?.id || `region-${regionIndex + 1}`,
      regionIndex,
      segmentTargetLength: Math.sqrt(regionAreaLimit(region, options)),
      markerId: allocateMarker({
        markerType: 'region',
        regionId: region?.id || `region-${regionIndex + 1}`,
        regionIndex
      })
    })
  );
}

function isRecoverableTriangleFailure(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('ran out of precision') ||
    message.includes('smaller size than can be accommodated') ||
    message.includes('topological inconsistency after splitting a segment') ||
    message.includes('internal error in segmentintersection()') ||
    message.includes('program terminated with exit(1)') ||
    message.includes('tiny triangles are not created') ||
    message.includes('oom') ||
    message.includes('out of memory')
  );
}

function meshingAttemptsFor(targetArea) {
  const baseArea = Math.max(Number(targetArea) || 0.2, 0.01);
  return [
    { quality: 28, area: baseArea * 0.9, ccdt: true, segmentTargetArea: baseArea * 0.9, steiner: 25000, label: 'quality-28' },
    { quality: 26, area: baseArea * 1.0, ccdt: true, segmentTargetArea: baseArea * 1.05, steiner: 18000, label: 'quality-26' },
    { quality: 24, area: baseArea * 1.2, ccdt: true, segmentTargetArea: baseArea * 1.25, steiner: 12000, label: 'quality-24' },
    { quality: 22, area: baseArea * 1.45, ccdt: false, segmentTargetArea: baseArea * 1.5, steiner: 9000, label: 'quality-22-cdt' }
  ];
}

function triangleSwitchesForAttempt(attempt, hasRegionAreaConstraints) {
  let out = 'pzQ';
  if (attempt?.ccdt) out += 'D';
  if (attempt?.jettison !== false) out += 'j';
  if (attempt?.edges !== false) out += 'e';
  if (typeof attempt?.steiner === 'number') out += `S${attempt.steiner}`;
  if (typeof attempt?.quality === 'number') out += `q${attempt.quality}`;
  if (typeof attempt?.area === 'number') out += `a${Math.max(attempt.area, 0.01)}`;
  if (hasRegionAreaConstraints) out += 'a';
  return out;
}

function buildMechanicalPslg(model, regions, options) {
  let nextMarkerId = 1;
  const markerInfoById = new Map();
  const allocateMarker = (info) => {
    const markerId = nextMarkerId;
    nextMarkerId += 1;
    markerInfoById.set(markerId, { ...info, markerId });
    return markerId;
  };
  const constraintSegments = [
    ...buildOuterSegments(model, options.load, options, allocateMarker),
    ...buildRegionBoundarySegments(regions, options, allocateMarker)
  ];
  return buildSectionPslg(model, regions, {
    ...options,
    constraintSegments,
    extraPoints: buildLoadRefinementPoints(model, options.load, options),
    markerInfoById
  });
}

async function triangulateMechanicalPslg(model, regions, options, onProgress = () => {}) {
  const attempts = meshingAttemptsFor(options?.meshTargetArea);
  let lastError = null;

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      const pslg = buildMechanicalPslg(model, regions, {
        ...options,
        segmentTargetArea: attempt.segmentTargetArea,
        regionTargetArea: attempt.area
      });
      if (i > 0) {
        onProgress({
          stage: 'meshing',
          percent: 24,
          message: `Triangle hit a meshing limit; retrying the deformation mesh with relaxed controls (${attempt.label})...`
        });
      }
      const hasRegionAreaConstraints = Array.isArray(pslg.regionlist) && pslg.regionlist.length >= 4;
      const triangleOutput = await triangulatePslg(
        {
          pointlist: pslg.pointlist,
          segmentlist: pslg.segmentlist,
          segmentmarkerlist: pslg.segmentmarkerlist,
          regionlist: hasRegionAreaConstraints ? pslg.regionlist : undefined
        },
        triangleSwitchesForAttempt(
          {
            ...attempt,
            edges: true,
            jettison: true
          },
          hasRegionAreaConstraints
        )
      );
      return { triangleOutput, attempt, pslg };
    } catch (error) {
      lastError = error;
      if (!isRecoverableTriangleFailure(error) || i === attempts.length - 1) throw error;
    }
  }

  throw lastError || new Error('Triangle meshing failed.');
}

export async function buildDeformationMesh(model, regions, options, onProgress = () => {}) {
  const startedAt = performance.now();
  onProgress({
    stage: 'meshing',
    percent: 10,
    message: 'Preparing the mechanical section mesh...'
  });
  onProgress({
    stage: 'meshing',
    percent: 22,
    message: 'Running constrained Delaunay triangulation for deformation...'
  });

  const { triangleOutput, attempt, pslg } = await triangulateMechanicalPslg(model, regions, options, onProgress);
  return buildSectionMesh({
    triangleOutput,
    pslg,
    regions,
    targetArea: options?.meshTargetArea,
    startedAt,
    attemptLabel: attempt?.label || 'quality-28',
    onProgress,
    progressPercent: 38,
    purpose: 'deformation'
  });
}
