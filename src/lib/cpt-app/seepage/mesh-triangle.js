// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { materialAt, pointInPolygonHalfOpen } from '../soil-regions.js';
import { buildSeepagePslg } from './pslg.js';
import { triangulatePslg } from './triangle-runtime.js';

const EPS = 1e-9;
const GEOM_EPS = 1e-6;

function average(values) {
  if (!values?.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dist(a, b) {
  return Math.hypot((b?.x || 0) - (a?.x || 0), (b?.y || 0) - (a?.y || 0));
}

function segmentOrientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function triangleArea(a, b, c) {
  return 0.5 * Math.abs(segmentOrientation(a, b, c));
}

function centroidOfTriangle(a, b, c) {
  return {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3
  };
}

function regionIndexAt(regions, x, y) {
  for (let i = (regions || []).length - 1; i >= 0; i -= 1) {
    if (pointInPolygonHalfOpen(regions[i]?.polygon || [], x, y)) return i;
  }
  return -1;
}

function resolveMaterialAssignment(regions, centroid) {
  const directIndex = regionIndexAt(regions, centroid.x, centroid.y);
  if (directIndex >= 0) {
    return {
      regionIndex: directIndex,
      material: regions[directIndex]?.material || materialAt(regions, centroid.x, centroid.y)
    };
  }

  const offsets = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2];
  for (let i = 0; i < offsets.length; i += 1) {
    const delta = offsets[i];
    const probeIndex = regionIndexAt(regions, centroid.x, centroid.y - delta);
    if (probeIndex >= 0) {
      return {
        regionIndex: probeIndex,
        material: regions[probeIndex]?.material || materialAt(regions, centroid.x, centroid.y - delta)
      };
    }
  }

  for (let i = 0; i < offsets.length; i += 1) {
    const delta = offsets[i];
    const probeIndex = regionIndexAt(regions, centroid.x, centroid.y + delta);
    if (probeIndex >= 0) {
      return {
        regionIndex: probeIndex,
        material: regions[probeIndex]?.material || materialAt(regions, centroid.x, centroid.y + delta)
      };
    }
  }

  return null;
}

function bboxForPolygon(points) {
  return {
    xMin: Math.min(...points.map((point) => point.x)),
    xMax: Math.max(...points.map((point) => point.x)),
    yMin: Math.min(...points.map((point) => point.y)),
    yMax: Math.max(...points.map((point) => point.y))
  };
}

function buildCellSampleBins(cells, domainPolygon, targetArea) {
  if (!cells?.length || !domainPolygon?.length) {
    return {
      grid: {
        xMin: 0,
        yMin: 0,
        cellSize: Math.max(Math.sqrt(Number(targetArea) || 0.5), 0.1)
      },
      bins: {}
    };
  }

  const xMin = Math.min(...domainPolygon.map((point) => point.x));
  const yMin = Math.min(...domainPolygon.map((point) => point.y));
  const cellSize = Math.max(Math.sqrt(Number(targetArea) || 0.5), 0.1);
  const bins = {};

  cells.forEach((cell, index) => {
    const ix0 = Math.floor((cell.bbox.xMin - xMin) / cellSize);
    const ix1 = Math.floor((cell.bbox.xMax - xMin) / cellSize);
    const iy0 = Math.floor((cell.bbox.yMin - yMin) / cellSize);
    const iy1 = Math.floor((cell.bbox.yMax - yMin) / cellSize);
    for (let ix = ix0; ix <= ix1; ix += 1) {
      for (let iy = iy0; iy <= iy1; iy += 1) {
        const key = `${ix}:${iy}`;
        if (!bins[key]) bins[key] = [];
        bins[key].push(index);
      }
    }
  });

  return {
    grid: { xMin, yMin, cellSize },
    bins
  };
}

function buildConstraintEdges(nodes, triangleOutput, markerInfoById) {
  const out = [];
  const edges = triangleOutput?.edgelist || [];
  const markers = triangleOutput?.edgemarkerlist || [];
  for (let i = 0; i < markers.length; i += 1) {
    const markerId = Number(markers[i]) || 0;
    if (!(markerId > 0)) continue;
    const metadata = markerInfoById.get(markerId);
    if (!metadata) continue;
    const n1 = Number(edges[2 * i]);
    const n2 = Number(edges[2 * i + 1]);
    if (!Number.isInteger(n1) || !Number.isInteger(n2) || n1 === n2) continue;
    const a = nodes[n1];
    const b = nodes[n2];
    if (!a || !b || !(dist(a, b) > GEOM_EPS)) continue;
    out.push({
      n1,
      n2,
      a,
      b,
      ...metadata
    });
  }
  return out;
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
  const baseArea = Math.max(Number(targetArea) || 0.5, 0.01);
  return [
    { quality: 28, area: baseArea * 0.9, ccdt: true, segmentTargetArea: baseArea * 1.0, steiner: 25000, label: 'quality-28' },
    { quality: 26, area: baseArea * 1.1, ccdt: true, segmentTargetArea: baseArea * 1.35, steiner: 18000, label: 'quality-26' },
    { quality: 24, area: baseArea * 1.35, ccdt: true, segmentTargetArea: baseArea * 1.8, steiner: 12000, label: 'quality-24' },
    { quality: 22, area: baseArea * 1.75, ccdt: false, segmentTargetArea: baseArea * 2.4, steiner: 8000, label: 'quality-22-cdt' },
    { quality: 20, area: baseArea * 2.4, ccdt: false, segmentTargetArea: baseArea * 3.2, steiner: 5000, label: 'quality-20-cdt' }
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

async function triangulateSeepagePslg(model, regions, options, onProgress = () => {}) {
  const attempts = meshingAttemptsFor(options?.meshTargetArea);
  let lastError = null;

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    try {
      const pslg = buildSeepagePslg(model, regions, {
        ...options,
        segmentTargetArea: attempt.segmentTargetArea,
        regionTargetArea: attempt.area
      });
      if (i > 0) {
        onProgress({
          stage: 'meshing',
          percent: 24,
          message: `Triangle hit a meshing limit; retrying with relaxed mesh controls (${attempt.label})...`
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
      if (!isRecoverableTriangleFailure(error) || i === attempts.length - 1) {
        throw error;
      }
    }
  }

  throw lastError || new Error('Triangle meshing failed.');
}

export async function buildTriangleMesh(model, regions, options, onProgress = () => {}) {
  const startedAt = performance.now();
  onProgress({
    stage: 'meshing',
    percent: 10,
    message: 'Preparing seepage constraints...'
  });
  onProgress({
    stage: 'meshing',
    percent: 22,
    message: 'Running constrained Delaunay triangulation...'
  });

  const { triangleOutput, attempt, pslg } = await triangulateSeepagePslg(model, regions, options, onProgress);

  const nodes = [];
  const pointlist = triangleOutput?.pointlist || [];
  for (let i = 0; i < pointlist.length; i += 2) {
    nodes.push({
      x: +Number(pointlist[i]).toFixed(8),
      y: +Number(pointlist[i + 1]).toFixed(8)
    });
  }

  const elements = [];
  const cells = [];
  const elementCell = [];
  const elementData = [];
  const uncovered = [];
  const trianglelist = triangleOutput?.trianglelist || [];
  const corners = Math.max(Number(triangleOutput?.numberofcorners) || 3, 3);

  for (let i = 0; i < trianglelist.length; i += corners) {
    const tri = [
      Number(trianglelist[i]),
      Number(trianglelist[i + 1]),
      Number(trianglelist[i + 2])
    ];
    if (!tri.every(Number.isInteger)) continue;
    const pts = tri.map((nodeId) => nodes[nodeId]);
    if (pts.some((point) => !point)) continue;
    if (segmentOrientation(pts[0], pts[1], pts[2]) < 0) {
      tri[1] = Number(trianglelist[i + 2]);
      tri[2] = Number(trianglelist[i + 1]);
      pts[1] = nodes[tri[1]];
      pts[2] = nodes[tri[2]];
    }

    const area = triangleArea(pts[0], pts[1], pts[2]);
    if (!(area > 1e-10)) continue;
    const centroid = centroidOfTriangle(pts[0], pts[1], pts[2]);
    if (!pointInPolygonHalfOpen(pslg.domainPolygon, centroid.x, centroid.y)) continue;

    const assignment = resolveMaterialAssignment(regions, centroid);
    const regionIndex = assignment?.regionIndex ?? -1;
    const material = assignment?.material || null;
    if (!material) {
      if (uncovered.length < 5) uncovered.push(`${centroid.x.toFixed(3)}, ${centroid.y.toFixed(3)}`);
      continue;
    }

    const elementIndex = elements.length;
    elements.push(tri);
    elementCell.push(cells.length);
    elementData.push({ area, centroid });
    cells.push({
      polygon: pts,
      centroid,
      area,
      material,
      regionIndex,
      triangleIndices: [elementIndex],
      bbox: bboxForPolygon(pts)
    });
  }

  if (uncovered.length) {
    throw new Error(`The seepage mesh contains triangles outside any soil polygon. First uncovered centroid(s): ${uncovered.join('; ')}.`);
  }
  if (!elements.length || !cells.length) {
    throw new Error('The constrained triangulation produced no active seepage elements.');
  }

  const sample = buildCellSampleBins(cells, pslg.domainPolygon, options?.meshTargetArea);
  const constraintEdges = buildConstraintEdges(nodes, triangleOutput, pslg.markerInfoById);
  const phreaticNodeIds = [
    ...new Set(
      constraintEdges
        .filter((edge) => edge.markerType === 'phreatic')
        .flatMap((edge) => [edge.n1, edge.n2])
    )
  ];

  onProgress({
    stage: 'meshing',
    percent: 38,
    message: `Built ${elements.length} seepage triangles from ${nodes.length} nodes.`
  });

  return {
    kind: 'triangle-cdt-fem',
    nodes,
    elements,
    cells,
    elementCell,
    elementData,
    constraintEdges,
    domainPolygon: pslg.domainPolygon,
    sampleGrid: sample.grid,
    sampleBins: sample.bins,
    phreaticNodeIds,
    generatedMs: performance.now() - startedAt,
    meshStats: {
      nodes: nodes.length,
      triangles: elements.length,
      meanTriangleArea: average(elementData.map((item) => item.area)),
      triangleAttempt: attempt?.label || 'quality-28'
    }
  };
}
