// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

const EPS = 1e-9;

function roundCoord(value) {
  return +Number(value || 0).toFixed(6);
}

function point(a) {
  return { x: roundCoord(a?.x), y: roundCoord(a?.y) };
}

function segmentLength(a, b) {
  return Math.hypot((b?.x || 0) - (a?.x || 0), (b?.y || 0) - (a?.y || 0));
}

function tangentFor(a, b) {
  const dx = (b?.x || 0) - (a?.x || 0);
  const dy = (b?.y || 0) - (a?.y || 0);
  const len = Math.hypot(dx, dy) || 1;
  return {
    dx: +(dx / len).toFixed(6),
    dy: +(dy / len).toFixed(6)
  };
}

function midpointFor(a, b) {
  return {
    x: +((Number(a?.x) + Number(b?.x)) * 0.5).toFixed(6),
    y: +((Number(a?.y) + Number(b?.y)) * 0.5).toFixed(6)
  };
}

function buildEdge(source, index, a, b) {
  const start = point(a);
  const end = point(b);
  const length = segmentLength(start, end);
  return {
    edgeKey: `${source}:${index}`,
    source,
    index,
    a: start,
    b: end,
    length,
    mid: midpointFor(start, end),
    tangent: tangentFor(start, end)
  };
}

function pointToSegmentDistance(pointValue, a, b) {
  const px = Number(pointValue?.x);
  const py = Number(pointValue?.y);
  const ax = Number(a?.x);
  const ay = Number(a?.y);
  const bx = Number(b?.x);
  const by = Number(b?.y);
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  if (!(len2 > EPS)) return Math.hypot(px - ax, py - ay);
  const t = Math.min(Math.max(((px - ax) * abx + (py - ay) * aby) / len2, 0), 1);
  const qx = ax + abx * t;
  const qy = ay + aby * t;
  return Math.hypot(px - qx, py - qy);
}

function tangentDot(left, right) {
  return (left?.dx || 0) * (right?.dx || 0) + (left?.dy || 0) * (right?.dy || 0);
}

export function buildOuterBoundary(model) {
  const terrain = model?.terrain?.vertices || [];
  if (terrain.length < 2 || !Number.isFinite(model?.analysisBottomY)) return [];
  const leftTop = point(terrain[0]);
  const rightTop = point(terrain[terrain.length - 1]);
  const leftBottom = { x: leftTop.x, y: roundCoord(model.analysisBottomY) };
  const rightBottom = { x: rightTop.x, y: roundCoord(model.analysisBottomY) };
  const edges = [];

  for (let i = 0; i < terrain.length - 1; i += 1) {
    edges.push(buildEdge('terrain', i, terrain[i], terrain[i + 1]));
  }
  edges.push(buildEdge('side-right', 0, rightTop, rightBottom));
  edges.push(buildEdge('base', 0, rightBottom, leftBottom));
  edges.push(buildEdge('side-left', 0, leftBottom, leftTop));
  return edges.filter((edge) => edge.length > 1e-6);
}

export function seepageBoundaryAnchor(edge) {
  if (!edge) return null;
  return {
    mid: { x: edge.mid.x, y: edge.mid.y },
    tangent: { dx: edge.tangent.dx, dy: edge.tangent.dy },
    source: edge.source
  };
}

export function makeBoundaryCondition(edge, partial = {}) {
  return {
    id: partial.id || '',
    edgeKey: edge?.edgeKey || '',
    type: partial.type === 'head' ? 'head' : partial.type === 'seepage-face' ? 'seepage-face' : 'no-flow',
    head:
      partial.type === 'head' && Number.isFinite(Number(partial.head)) ? Number(partial.head) : null,
    status: partial.status === 'orphaned' ? 'orphaned' : 'active',
    anchor: partial.anchor || seepageBoundaryAnchor(edge)
  };
}

export function pickOuterBoundaryEdge(boundary, worldPoint, tolerance) {
  const edges = Array.isArray(boundary) ? boundary : [];
  const limit = Number.isFinite(Number(tolerance)) ? Number(tolerance) : Infinity;
  let best = null;
  edges.forEach((edge) => {
    const distance = pointToSegmentDistance(worldPoint, edge.a, edge.b);
    if (distance > limit) return;
    if (!best || distance < best.distance) best = { edge, distance };
  });
  return best;
}

export function migrateBcs(oldBcs, boundary) {
  const edges = Array.isArray(boundary) ? boundary : [];
  const activeByKey = new Map(edges.map((edge) => [edge.edgeKey, edge]));
  const migrated = [];
  (oldBcs || []).forEach((bc, index) => {
    if (bc?.edgeKey && activeByKey.has(bc.edgeKey)) {
      const edge = activeByKey.get(bc.edgeKey);
      migrated.push(
        makeBoundaryCondition(edge, {
          ...bc,
          id: bc.id || `bc-${index + 1}`,
          status: 'active'
        })
      );
      return;
    }

    const anchor = bc?.anchor;
    const source = anchor?.source || bc?.source;
    const candidates = edges.filter((edge) => !source || edge.source === source);
    let best = null;
    candidates.forEach((edge) => {
      const dist = Math.hypot((edge.mid.x || 0) - (anchor?.mid?.x || 0), (edge.mid.y || 0) - (anchor?.mid?.y || 0));
      const dot = tangentDot(edge.tangent, anchor?.tangent);
      if (dot < 0.5) return;
      if (!best || dist < best.distance) best = { edge, distance: dist };
    });

    if (best && best.distance <= Math.max(best.edge.length * 0.5, 0.25)) {
      migrated.push(
        makeBoundaryCondition(best.edge, {
          ...bc,
          id: bc.id || `bc-${index + 1}`,
          status: 'active'
        })
      );
    } else {
      migrated.push({
        id: bc?.id || `bc-${index + 1}`,
        edgeKey: '',
        type: bc?.type === 'head' ? 'head' : bc?.type === 'seepage-face' ? 'seepage-face' : 'no-flow',
        head: Number.isFinite(Number(bc?.head)) ? Number(bc.head) : null,
        status: 'orphaned',
        anchor: anchor || null
      });
    }
  });

  const deduped = new Map();
  migrated.forEach((bc) => {
    const key = bc.edgeKey ? `edge:${bc.edgeKey}` : `orphan:${bc.id}`;
    deduped.set(key, bc);
  });
  return [...deduped.values()];
}

export function seepageGeometryHash(model, options = {}) {
  const freeSurface = options?.freeSurface === 'iterate' ? 'iterate' : 'fixed';
  const usePhreaticAsSeed = options?.usePhreaticAsSeed !== false;
  return JSON.stringify({
    terrain: (model?.terrain?.vertices || []).map((pt) => [roundCoord(pt.x), roundCoord(pt.y)]),
    bottomY: roundCoord(model?.analysisBottomY),
    regions: (model?.regions || []).map((region) => ({
      id: region?.id || '',
      materialId: region?.material?.id || '',
      kx: Number.isFinite(Number(region?.material?.kx)) ? Number(region.material.kx) : null,
      ky: Number.isFinite(Number(region?.material?.ky)) ? Number(region.material.ky) : null,
      polygon: (region?.polygon || []).map((pt) => [roundCoord(pt.x), roundCoord(pt.y)])
    })),
    walls: (model?.walls || []).map((wall) => [
      roundCoord(wall?.x),
      roundCoord(wall?.yTop),
      roundCoord(wall?.yTip),
      wall?.passiveSide || 'right'
    ]),
    freeSurface,
    usePhreaticAsSeed,
    meshTargetArea: roundCoord(options?.meshTargetArea),
    phreatic:
      freeSurface === 'fixed' || usePhreaticAsSeed
        ? (model?.phreatic?.vertices || []).map((pt) => [roundCoord(pt.x), roundCoord(pt.y)])
        : []
  });
}
