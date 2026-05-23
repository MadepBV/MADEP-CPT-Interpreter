// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { buildSectionMesh } from '../mesh/section-mesh.js';
import { buildSectionPslg, polygonSegments, polylineSegments } from '../mesh/section-pslg.js';
import { buildOuterBoundary } from '../seepage/boundary.js';
import { resolveWallMechanicalSection } from '../seepage/material.js';
import { triangulatePslg } from '../seepage/triangle-runtime.js';
import { terrainY } from '../stage6-bishop.js';

const GEOM_EPS = 1e-6;
const SEGMENT_PRIORITY = {
  region: 1,
  mechanicalWall: 2,
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

function normalizeMeshSurfaceLoads(model, options) {
  const modelLoads = Array.isArray(model?.surfaceLoads)
    && model.surfaceLoads.length
    ? model.surfaceLoads
    : (model?.surfaceLoad ? [model.surfaceLoad] : []);
  const optionLoads = [
    ...(Array.isArray(options?.loads) ? options.loads : []),
    ...(options?.load ? [options.load] : [])
  ];
  const raw = [
    ...modelLoads,
    ...(modelLoads.length ? [] : optionLoads)
  ];
  const seen = new Set();
  return raw
    .filter((load) => load && Number.isFinite(Number(load.xStart)) && Number.isFinite(Number(load.xEnd)))
    .map((load) => ({
      ...load,
      xStart: Math.min(Number(load.xStart), Number(load.xEnd)),
      xEnd: Math.max(Number(load.xStart), Number(load.xEnd))
    }))
    .filter((load) => {
      if (!(load.xEnd > load.xStart + GEOM_EPS)) return false;
      const key = load.id || `${load.xStart.toFixed(6)}:${load.xEnd.toFixed(6)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function buildOuterSegments(model, loads, options, allocateMarker) {
  const baseLength = Math.sqrt(Math.max(Number(options?.segmentTargetArea ?? options?.meshTargetArea) || 0.5, 0.01));
  const refinements = (loads || [])
    .map((load) => ({ load, refinement: buildLoadRefinementMeta(model, load, options?.meshTargetArea) }))
    .filter((item) => item.refinement);
  const splitXs = uniqueSorted(refinements.flatMap((item) => item.refinement.splitXs || []), 1e-5);
  return buildOuterBoundary(model).flatMap((edge) => {
    const pieces = splitTerrainEdgeAtXs(edge, splitXs);
    return pieces.map((piece) => {
      const xMid = 0.5 * (piece.a.x + piece.b.x);
      let segmentTargetLength = edge.source === 'terrain' ? Math.max(baseLength * 0.8, 0.05) : baseLength;
      if (piece.source === 'terrain') {
        refinements.forEach(({ load, refinement }) => {
          const topOverlap = overlapRange(piece.a.x, piece.b.x, load.xStart, load.xEnd);
          const leftOverlap = overlapRange(piece.a.x, piece.b.x, load.xStart - refinement.edgeHalfWidth, load.xStart + refinement.edgeHalfWidth);
          const rightOverlap = overlapRange(piece.a.x, piece.b.x, load.xEnd - refinement.edgeHalfWidth, load.xEnd + refinement.edgeHalfWidth);
          if (topOverlap) segmentTargetLength = Math.min(segmentTargetLength, refinement.refinedSpacing);
          if (leftOverlap || rightOverlap || Math.abs(xMid - load.xStart) <= refinement.edgeHalfWidth || Math.abs(xMid - load.xEnd) <= refinement.edgeHalfWidth) {
            segmentTargetLength = Math.min(segmentTargetLength, refinement.edgeSpacing);
          }
        });
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

function buildLoadRefinementPointsForLoads(model, loads, options) {
  const deduped = new Map();
  (loads || []).forEach((load) => {
    buildLoadRefinementPoints(model, load, options).forEach((point) => {
      const key = `${point.x.toFixed(6)},${point.y.toFixed(6)}`;
      deduped.set(key, point);
    });
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

function verticalSegmentIntersectionY(x, yTop, yTip, a, b) {
  const ax = Number(a?.x);
  const ay = Number(a?.y);
  const bx = Number(b?.x);
  const by = Number(b?.y);
  if (![ax, ay, bx, by].every(Number.isFinite)) return null;
  if (Math.abs(bx - ax) <= GEOM_EPS) {
    if (Math.abs(x - ax) > GEOM_EPS) return null;
    const lo = Math.max(Math.min(ay, by), yTip);
    const hi = Math.min(Math.max(ay, by), yTop);
    if (!(hi >= lo - GEOM_EPS)) return null;
    return [lo, hi];
  }
  const t = (x - ax) / (bx - ax);
  if (t < -GEOM_EPS || t > 1 + GEOM_EPS) return null;
  const y = ay + t * (by - ay);
  if (y < yTip - GEOM_EPS || y > yTop + GEOM_EPS) return null;
  return y;
}

function collectWallRegionIntersections(wall, regions) {
  const ys = [wall.yTop, wall.yTip];
  (regions || []).forEach((region) => {
    const polygon = Array.isArray(region?.polygon) ? region.polygon : [];
    for (let i = 0; i < polygon.length; i += 1) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const hit = verticalSegmentIntersectionY(wall.x, wall.yTop, wall.yTip, a, b);
      if (Array.isArray(hit)) {
        ys.push(hit[0], hit[1]);
      } else if (Number.isFinite(hit)) {
        ys.push(hit);
      }
    }
  });
  return uniqueSorted(ys, 1e-5)
    .filter((y) => y <= wall.yTop + GEOM_EPS && y >= wall.yTip - GEOM_EPS);
}

function activeMechanicalWalls(model, regions, options = {}) {
  const terrain = model?.terrain?.vertices || [];
  const xMin = terrain.length ? Math.min(terrain[0].x, terrain[terrain.length - 1].x) : -Infinity;
  const xMax = terrain.length ? Math.max(terrain[0].x, terrain[terrain.length - 1].x) : Infinity;
  const targetLength = Math.max(
    Math.sqrt(Math.max(Number(options?.meshTargetArea) || 0.5, 0.01)) * 0.6,
    0.15
  );
  return (model?.walls || [])
    .map((wall, wallIndex) => ({ wall, wallIndex }))
    .filter(({ wall }) => wall?.mechanicalActive === true)
    .map(({ wall, wallIndex }) => {
      const x = Number(wall?.x);
      const yTop = Number(wall?.yTop);
      const yTip = Number(wall?.yTip);
      const label = wall?.id || `wall-${wallIndex + 1}`;
      if (!Number.isFinite(x) || !Number.isFinite(yTop) || !Number.isFinite(yTip)) {
        throw new Error(`Mechanical wall ${label} has invalid geometry.`);
      }
      if (x < xMin - GEOM_EPS || x > xMax + GEOM_EPS) {
        throw new Error(`Mechanical wall ${label} lies outside the deformation section.`);
      }
      if (!(yTop > yTip + 0.05)) {
        throw new Error(`Mechanical wall ${label} must have a tip at least 0.05 m below its top.`);
      }
      const section = resolveWallMechanicalSection(wall?.material?.mechanical);
      if (!section) throw new Error(`Mechanical wall ${label} has invalid section properties.`);
      const intersectionYs = collectWallRegionIntersections({ x, yTop, yTip }, regions);
      const nUniform = Math.max(1, Math.ceil((yTop - yTip) / targetLength));
      const uniformYs = Array.from({ length: nUniform + 1 }, (_, i) => yTop - (i / nUniform) * (yTop - yTip));
      const stationYs = uniqueSorted([...intersectionYs, ...uniformYs], 1e-5)
        .filter((y) => y <= yTop + GEOM_EPS && y >= yTip - GEOM_EPS)
        .sort((a, b) => b - a);
      const stations = stationYs.map((y) => ({
        x: +x.toFixed(6),
        y: +y.toFixed(6),
        s: +(yTop - y).toFixed(6)
      }));
      return {
        id: wall?.id || `wall-${wallIndex + 1}`,
        wallIndex,
        x,
        yTop,
        yTip,
        passiveSide: wall?.passiveSide === 'left' ? 'left' : 'right',
        section,
        stations
      };
    })
    .filter((wall) => wall && wall.stations.length >= 2);
}

function buildMechanicalWallSegments(model, regions, options, allocateMarker) {
  const walls = activeMechanicalWalls(model, regions, options);
  const segments = [];
  walls.forEach((wall, mechanicalWallIndex) => {
    segments.push(...polylineSegments(wall.stations, {
      kind: 'mechanical-wall',
      priority: SEGMENT_PRIORITY.mechanicalWall,
      wallIndex: wall.wallIndex,
      mechanicalWallIndex,
      wallId: wall.id,
      segmentTargetLength: Math.max(
        Math.sqrt(Math.max(Number(options?.segmentTargetArea ?? options?.meshTargetArea) || 0.5, 0.01)) * 0.6,
        0.1
      ),
      markerId: allocateMarker({
        markerType: 'mechanical-wall',
        wallIndex: wall.wallIndex,
        mechanicalWallIndex,
        wallId: wall.id
      })
    }));
  });
  return { walls, segments };
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

function triangleSwitchesForAttempt(attempt, hasRegionAreaConstraints, elementType = 't3') {
  let out = 'pzQ';
  if (String(elementType || '').toLowerCase() === 't6') out += 'o2';
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
  const loads = normalizeMeshSurfaceLoads(model, options);
  const wallPslg = buildMechanicalWallSegments(model, regions, options, allocateMarker);
  const constraintSegments = [
    ...buildOuterSegments(model, loads, options, allocateMarker),
    ...buildRegionBoundarySegments(regions, options, allocateMarker),
    ...wallPslg.segments
  ];
  const pslg = buildSectionPslg(model, regions, {
    ...options,
    constraintSegments,
    extraPoints: buildLoadRefinementPointsForLoads(model, loads, options),
    markerInfoById
  });
  pslg.mechanicalWalls = wallPslg.walls;
  return pslg;
}

function attachMechanicalWallsToMesh(mesh, pslg) {
  const inputWalls = pslg?.mechanicalWalls || [];
  if (!inputWalls.length) {
    mesh.mechanicalWalls = [];
    mesh.ndofTotal = 2 * (mesh.nodes?.length || 0);
    return;
  }
  const edgesByWall = new Map();
  (mesh.constraintEdges || []).forEach((edge) => {
    if (edge?.markerType !== 'mechanical-wall') return;
    const key = Number(edge.mechanicalWallIndex);
    if (!Number.isInteger(key)) return;
    if (!edgesByWall.has(key)) edgesByWall.set(key, []);
    edgesByWall.get(key).push(edge);
  });

  const ownerByNode = new Map();
  const wallRotationDofByNode = new Map();
  const mechanicalWalls = inputWalls.map((wall, mechanicalWallIndex) => {
    const edges = edgesByWall.get(mechanicalWallIndex) || [];
    if (!edges.length) {
      throw new Error(`Mechanical wall ${wall.id || wall.wallIndex + 1} was not recovered as constrained mesh edges.`);
    }
    const nodeByStation = new Map();
    const addNode = (nodeId) => {
      const node = mesh.nodes[nodeId];
      if (!node) return;
      const s = wall.yTop - node.y;
      if (Math.abs(node.x - wall.x) > 2e-5) return;
      if (s < -GEOM_EPS || s > (wall.yTop - wall.yTip) + GEOM_EPS) return;
      const key = s.toFixed(6);
      if (!nodeByStation.has(key)) nodeByStation.set(key, { nodeId, s, x: node.x, y: node.y });
    };
    edges.forEach((edge) => {
      (edge.nodeIds || [edge.n1, edge.n2]).forEach(addNode);
    });
    const nodes = [...nodeByStation.values()].sort((a, b) => a.s - b.s);
    if (nodes.length < 2) {
      throw new Error(`Mechanical wall ${wall.id || wall.wallIndex + 1} has fewer than two recovered mesh nodes.`);
    }
    nodes.forEach((station) => {
      const ownedBy = ownerByNode.get(station.nodeId);
      if (Number.isInteger(ownedBy) && ownedBy !== mechanicalWallIndex) {
        throw new Error('Mechanical walls may not share a mesh node in Phase 1. Split or offset overlapping walls before deformation analysis.');
      }
      ownerByNode.set(station.nodeId, mechanicalWallIndex);
      if (!wallRotationDofByNode.has(station.nodeId)) {
        wallRotationDofByNode.set(station.nodeId, 2 * mesh.nodes.length + wallRotationDofByNode.size);
      }
    });
    return {
      ...wall,
      nodes,
      nodeIds: nodes.map((node) => node.nodeId)
    };
  });

  mesh.mechanicalWalls = mechanicalWalls;
  mesh.wallRotationDofByNode = Object.fromEntries([...wallRotationDofByNode.entries()].map(([nodeId, dof]) => [String(nodeId), dof]));
  mesh.ndofTotal = 2 * mesh.nodes.length + wallRotationDofByNode.size;
}

async function triangulateMechanicalPslg(model, regions, options, onProgress = () => {}) {
  const attempts = meshingAttemptsFor(options?.meshTargetArea);
  const elementType = String(options?.meshElementType || '').toLowerCase() === 't6' ? 't6' : 't3';
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
          hasRegionAreaConstraints,
          elementType
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
  const elementType = String(options?.meshElementType || '').toLowerCase() === 't6' ? 't6' : 't3';
  const mesh = buildSectionMesh({
    triangleOutput,
    pslg,
    regions,
    targetArea: options?.meshTargetArea,
    startedAt,
    attemptLabel: attempt?.label || 'quality-28',
    onProgress,
    progressPercent: 38,
    purpose: 'deformation',
    elementType
  });
  attachMechanicalWallsToMesh(mesh, pslg);
  // Mesh sanity guard. The PSLG segment-collinearity bug previously caused
  // Triangle to insert orders of magnitude too many Steiner points on
  // sloping terrain at certain mesh target areas. Even after the
  // length-normalised pointOnSegment fix and the collinear-overlap dedup,
  // we still want a runtime warning if the produced mesh is materially
  // larger than the requested target. The check compares the
  // mean-element-area to the requested target_area; modest oversampling
  // is normal (Triangle inserts Steiner points to satisfy quality), but
  // a 10× overshoot or sliver-dominated distribution is suspect.
  attachMeshSanityWarnings(mesh, options, attempt);
  return mesh;
}

function attachMeshSanityWarnings(mesh, options, attempt) {
  if (!mesh) return;
  const requestedArea = Math.max(
    Number(options?.meshTargetArea ?? attempt?.area) || 0.5,
    0.01
  );
  const meanArea = Number(mesh?.meshStats?.meanTriangleArea) || 0;
  const triangles = Number(mesh?.meshStats?.triangles) || 0;
  const nodes = Number(mesh?.meshStats?.nodes) || 0;
  const elementType = mesh?.elementType || 't3';
  const messages = Array.isArray(mesh?.warnings) ? mesh.warnings : (mesh.warnings = []);

  // Triangle's quality-driven refinement legitimately produces meanArea
  // around 30-70% of the requested target. Below 10% is suspect.
  if (meanArea > 0 && requestedArea > 0 && meanArea < requestedArea * 0.1) {
    messages.push(
      `Mesh sanity: actual mean triangle area ${meanArea.toFixed(4)} m² is far below the requested target ${requestedArea.toFixed(2)} m² (${(100 * meanArea / requestedArea).toFixed(1)}%). The triangulation may have over-refined due to nearly overlapping PSLG constraint segments. Consider increasing the mesh target area or reviewing region boundary geometry.`
    );
  }

  // T6 explodes node count vs T3 by roughly a factor of 4 on a uniform
  // mesh (each edge gets a midpoint). A node-to-triangle ratio above 6
  // is unusual and suggests orphaned/under-utilized Steiner points.
  const nodesPerTriangle = triangles > 0 ? nodes / triangles : 0;
  const expectedRatio = elementType === 't6' ? 6 : 3;
  if (nodesPerTriangle > expectedRatio * 1.5) {
    messages.push(
      `Mesh sanity: ${nodes} nodes for ${triangles} ${elementType.toUpperCase()} triangles (${nodesPerTriangle.toFixed(2)} per triangle vs ${expectedRatio} expected). The mesh likely contains orphaned Steiner points from a degenerate constraint-segment configuration.`
    );
  }

  // Free-DOF guard for T6. With the default size gate (1500 free DOFs),
  // a 5000-element T6 mesh easily exceeds 30,000 free DOFs. Above 50,000
  // the solver becomes uncomfortable on a single browser thread; flag it
  // so the engineer can choose a coarser mesh or switch to T3.
  if (elementType === 't6') {
    const approxFreeDofs = 2 * nodes; // upper bound; constrained DOFs subtract a small fraction
    if (approxFreeDofs > 50000) {
      messages.push(
        `T6 mesh has ~${approxFreeDofs.toLocaleString()} displacement DOFs. The solver will run, but may be very slow on a coarse-mesh target. Consider increasing meshTargetArea, or running T3 first to validate the engineering setup before refining.`
      );
    }
  }
}
