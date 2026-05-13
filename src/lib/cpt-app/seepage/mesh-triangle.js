// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { buildSectionMesh } from '../mesh/section-mesh.js';
import { normalizeDrains } from './drains.js';
import { buildSeepagePslg } from './pslg.js';
import { triangulatePslg } from './triangle-runtime.js';

const GEOM_EPS = 1e-6;

function dist(a, b) {
  return Math.hypot((Number(b?.x) || 0) - (Number(a?.x) || 0), (Number(b?.y) || 0) - (Number(a?.y) || 0));
}

function closestArcLengthOnDrain(drain, point) {
  const vertices = drain?.vertices || [];
  if (vertices.length < 2 || !point) return 0;
  let best = null;
  let prefix = 0;
  const segmentLimit = drain?.closed && vertices.length > 2 ? vertices.length : vertices.length - 1;
  for (let i = 0; i < segmentLimit; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % vertices.length];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const len = Math.sqrt(len2);
    if (!(len > GEOM_EPS)) continue;
    const t = Math.min(Math.max(((point.x - a.x) * abx + (point.y - a.y) * aby) / len2, 0), 1);
    const projected = { x: a.x + abx * t, y: a.y + aby * t };
    const distance = dist(point, projected);
    const arcLength = prefix + len * t;
    if (!best || distance < best.distance) best = { distance, arcLength };
    prefix += len;
  }
  return best?.arcLength || 0;
}

function buildDrainConstraintMaps(mesh, model) {
  const drains = normalizeDrains(model?.drains || []);
  const drainById = new Map(drains.map((drain, index) => [drain.id || `drain-${index + 1}`, drain]));
  const drainNodeIdsByDrain = new Map();
  const drainEdgesByDrain = new Map();
  const drainNodeArcLengthByNode = new Map();

  (mesh?.constraintEdges || [])
    .filter((edge) => edge.markerType === 'drain')
    .forEach((edge) => {
      const drainId = edge.drainId || `drain-${(edge.drainIndex || 0) + 1}`;
      if (!drainNodeIdsByDrain.has(drainId)) drainNodeIdsByDrain.set(drainId, new Set());
      if (!drainEdgesByDrain.has(drainId)) drainEdgesByDrain.set(drainId, []);
      drainEdgesByDrain.get(drainId).push(edge);
      const drain = drainById.get(drainId);
      (edge.nodeIds || [edge.n1, edge.n2]).forEach((nodeId) => {
        if (!Number.isInteger(nodeId)) return;
        drainNodeIdsByDrain.get(drainId).add(nodeId);
        if (drain && !drainNodeArcLengthByNode.has(nodeId)) {
          drainNodeArcLengthByNode.set(nodeId, closestArcLengthOnDrain(drain, mesh.nodes?.[nodeId]));
        }
      });
    });

  return {
    drainNodeIdsByDrain,
    drainNodeArcLengthByNode,
    drainEdgesByDrain
  };
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
  const mesh = buildSectionMesh({
    triangleOutput,
    pslg,
    regions,
    targetArea: options?.meshTargetArea,
    startedAt,
    attemptLabel: attempt?.label || 'quality-28',
    onProgress,
    progressPercent: 38,
    purpose: 'seepage'
  });
  const phreaticNodeIds = [
    ...new Set(
      mesh.constraintEdges
        .filter((edge) => edge.markerType === 'phreatic')
        .flatMap((edge) => [edge.n1, edge.n2])
      )
  ];
  const drainMaps = buildDrainConstraintMaps(mesh, model);
  return {
    ...mesh,
    phreaticNodeIds,
    ...drainMaps
  };
}
