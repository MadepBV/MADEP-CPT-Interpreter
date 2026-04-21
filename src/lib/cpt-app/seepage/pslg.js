// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { buildSectionPslg, polygonSegments, polylineSegments } from '../mesh/section-pslg.js';
import { buildOuterBoundary } from './boundary.js';

const GEOM_EPS = 1e-6;
const SNAP_DECIMALS = 6;
const SEGMENT_PRIORITY = {
  region: 1,
  phreatic: 2,
  outer: 3
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function dist(a, b) {
  return Math.hypot((b?.x || 0) - (a?.x || 0), (b?.y || 0) - (a?.y || 0));
}

function regionAreaLimit(region, options) {
  const baseArea = Math.max(Number(options?.regionTargetArea ?? options?.meshTargetArea) || 0.5, 0.01);
  const coarseness = Number.isFinite(Number(region?.coarseness)) && Number(region.coarseness) > 0 ? Number(region.coarseness) : 1;
  return Math.max(baseArea * coarseness, 1e-4);
}

function outerMarkerInfo(edge, extra = {}) {
  return {
    markerType: 'outer',
    edgeKey: edge.edgeKey,
    source: edge.source,
    sourceIndex: edge.index,
    ...extra
  };
}

function seepageBoundaryConditionMapFor(model) {
  return new Map(
    ((model?.seepage?.bcs || []).filter((bc) => bc?.status !== 'orphaned') || []).map((bc) => [bc.edgeKey, bc])
  );
}

function seepageBoundaryTargetLength(segment, baseLength) {
  if (segment.kind === 'phreatic') return Math.max(baseLength * 0.6, 0.05);
  if (segment.kind === 'outer' && segment.bcType === 'seepage-face') return Math.max(baseLength * 0.45, 0.03);
  if (segment.kind === 'outer' && segment.bcType === 'head') return Math.max(baseLength * 0.55, 0.04);
  if (segment.kind === 'outer') return Math.max(baseLength * 0.8, 0.05);
  return baseLength;
}

function splitOuterBoundarySegmentsForHead(edge, bc, allocateMarker, baseLength) {
  const bcType = bc?.type === 'seepage-face' ? 'seepage-face' : bc?.type === 'head' ? 'head' : 'no-flow';
  const headValue = bcType === 'head' && Number.isFinite(Number(bc?.head)) ? Number(bc.head) : null;
  const a = { x: Number(edge?.a?.x), y: Number(edge?.a?.y) };
  const b = { x: Number(edge?.b?.x), y: Number(edge?.b?.y) };
  const base = {
    a,
    b,
    kind: 'outer',
    priority: SEGMENT_PRIORITY.outer,
    bcType,
    segmentTargetLength: seepageBoundaryTargetLength({ kind: 'outer', bcType }, baseLength)
  };
  if (!Number.isFinite(headValue)) {
    return [
      {
        ...base,
        markerId: allocateMarker(outerMarkerInfo(edge, { bcType }))
      }
    ];
  }

  const yMin = Math.min(a.y, b.y);
  const yMax = Math.max(a.y, b.y);
  const classifyPiece = (start, end) => Math.max(start.y, end.y) <= headValue + GEOM_EPS;
  if (!(headValue > yMin + GEOM_EPS && headValue < yMax - GEOM_EPS) || Math.abs(a.y - b.y) <= GEOM_EPS) {
    return [
      {
        ...base,
        markerId: allocateMarker(
          outerMarkerInfo(edge, {
            bcType,
            headSubmerged: classifyPiece(a, b),
            headValue
          })
        )
      }
    ];
  }

  const t = clamp((headValue - a.y) / (b.y - a.y), 0, 1);
  const splitPoint = {
    x: +lerp(a.x, b.x, t).toFixed(SNAP_DECIMALS),
    y: +lerp(a.y, b.y, t).toFixed(SNAP_DECIMALS)
  };
  const pieces = [
    { a, b: splitPoint },
    { a: splitPoint, b }
  ].filter((segment) => dist(segment.a, segment.b) > GEOM_EPS);

  return pieces.map((segment) => ({
    ...segment,
    kind: 'outer',
    priority: SEGMENT_PRIORITY.outer,
    bcType,
    segmentTargetLength: seepageBoundaryTargetLength({ kind: 'outer', bcType }, baseLength),
    markerId: allocateMarker(
      outerMarkerInfo(edge, {
        bcType,
        headSubmerged: classifyPiece(segment.a, segment.b),
        headValue
      })
    )
  }));
}

export function buildSeepagePslg(model, regions, options) {
  let nextMarkerId = 1;
  const markerInfoById = new Map();
  const allocateMarker = (info) => {
    const markerId = nextMarkerId;
    nextMarkerId += 1;
    markerInfoById.set(markerId, { ...info, markerId });
    return markerId;
  };

  const baseLength = Math.sqrt(Math.max(Number(options?.segmentTargetArea ?? options?.meshTargetArea) || 0.5, 0.01));
  const seepageBcs = seepageBoundaryConditionMapFor(model);
  const outerBoundarySegments = buildOuterBoundary(model).flatMap((edge) =>
    splitOuterBoundarySegmentsForHead(edge, seepageBcs.get(edge.edgeKey), allocateMarker, baseLength)
  );

  const regionBoundarySegments = (regions || []).flatMap((region, regionIndex) =>
    polygonSegments(region?.polygon || [], {
      kind: 'region',
      priority: SEGMENT_PRIORITY.region,
      regionId: region?.id || `region-${regionIndex + 1}`,
      regionIndex,
      regionSource: region?.source || 'region',
      segmentTargetLength: Math.sqrt(regionAreaLimit(region, options)),
      markerId: allocateMarker({
        markerType: 'region',
        regionId: region?.id || `region-${regionIndex + 1}`,
        regionIndex,
        regionSource: region?.source || 'region'
      })
    })
  );

  const phreaticSegments =
    options?.freeSurface === 'fixed' && model?.phreatic?.vertices?.length >= 2
      ? polylineSegments(model.phreatic.vertices, {
          kind: 'phreatic',
          priority: SEGMENT_PRIORITY.phreatic,
          segmentTargetLength: seepageBoundaryTargetLength({ kind: 'phreatic' }, baseLength),
          markerId: allocateMarker({
            markerType: 'phreatic'
          })
        })
      : [];

  return buildSectionPslg(model, regions, {
    ...options,
    constraintSegments: [
      ...outerBoundarySegments,
      ...regionBoundarySegments,
      ...phreaticSegments
    ],
    markerInfoById
  });
}
