// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

const EPS = 1e-6;

export class DxfTerrainImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DxfTerrainImportError';
  }
}

function parseNumber(value) {
  const num = Number(String(value ?? '').trim());
  return Number.isFinite(num) ? num : null;
}

function almostEqual(a, b, tol = EPS) {
  return Math.abs(a - b) <= tol;
}

function samePoint(a, b, tol = EPS) {
  return !!a && !!b && almostEqual(a.x, b.x, tol) && almostEqual(a.y, b.y, tol);
}

function splitGroupPairs(raw) {
  const lines = String(raw ?? '')
    .replace(/\uFEFF/g, '')
    .split(/\r\n|\n|\r/);
  const groups = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    groups.push({
      code: lines[i].trim(),
      value: lines[i + 1].trim()
    });
  }
  return groups;
}

function finalizeVertex(vertices, vertex) {
  if (!vertex) return;
  if (Number.isFinite(vertex.x) && Number.isFinite(vertex.y)) {
    vertices.push({ x: vertex.x, y: vertex.y });
  }
}

function parseLwPolyline(groups, startIndex) {
  const vertices = [];
  let flags = 0;
  let hasBulge = false;
  let currentVertex = null;
  let i = startIndex;

  while (i < groups.length && groups[i].code !== '0') {
    const group = groups[i];
    if (group.code === '70') {
      flags = Math.trunc(parseNumber(group.value) ?? 0);
    } else if (group.code === '10') {
      finalizeVertex(vertices, currentVertex);
      currentVertex = { x: parseNumber(group.value), y: null };
    } else if (group.code === '20') {
      if (!currentVertex) currentVertex = { x: null, y: null };
      currentVertex.y = parseNumber(group.value);
    } else if (group.code === '42') {
      const bulge = parseNumber(group.value);
      if (bulge != null && Math.abs(bulge) > EPS) hasBulge = true;
    }
    i += 1;
  }

  finalizeVertex(vertices, currentVertex);
  return {
    polyline: {
      kind: 'LWPOLYLINE',
      vertices,
      closed: (flags & 1) === 1,
      hasBulge
    },
    nextIndex: i
  };
}

function parsePolyline(groups, startIndex) {
  let flags = 0;
  let i = startIndex;

  while (i < groups.length && groups[i].code !== '0') {
    const group = groups[i];
    if (group.code === '70') flags = Math.trunc(parseNumber(group.value) ?? 0);
    i += 1;
  }

  const vertices = [];
  let hasBulge = false;

  while (i < groups.length) {
    const group = groups[i];
    if (group.code !== '0') {
      i += 1;
      continue;
    }
    if (group.value === 'VERTEX') {
      i += 1;
      let x = null;
      let y = null;
      while (i < groups.length && groups[i].code !== '0') {
        const vertexGroup = groups[i];
        if (vertexGroup.code === '10') x = parseNumber(vertexGroup.value);
        else if (vertexGroup.code === '20') y = parseNumber(vertexGroup.value);
        else if (vertexGroup.code === '42') {
          const bulge = parseNumber(vertexGroup.value);
          if (bulge != null && Math.abs(bulge) > EPS) hasBulge = true;
        }
        i += 1;
      }
      if (Number.isFinite(x) && Number.isFinite(y)) vertices.push({ x, y });
      continue;
    }
    if (group.value === 'SEQEND') {
      i += 1;
      while (i < groups.length && groups[i].code !== '0') i += 1;
      break;
    }
    break;
  }

  return {
    polyline: {
      kind: 'POLYLINE',
      vertices,
      closed: (flags & 1) === 1,
      hasBulge
    },
    nextIndex: i
  };
}

function extractPolylineEntities(groups) {
  const polylines = [];
  let section = '';

  for (let i = 0; i < groups.length; i += 1) {
    const group = groups[i];
    const valueUpper = group.value.toUpperCase();
    if (group.code === '0' && valueUpper === 'SECTION') {
      const next = groups[i + 1];
      section = next?.code === '2' ? next.value.toUpperCase() : '';
      continue;
    }
    if (group.code === '0' && valueUpper === 'ENDSEC') {
      section = '';
      continue;
    }
    if (section !== 'ENTITIES' || group.code !== '0') continue;

    if (valueUpper === 'LWPOLYLINE') {
      const parsed = parseLwPolyline(groups, i + 1);
      polylines.push(parsed.polyline);
      i = parsed.nextIndex - 1;
      continue;
    }
    if (valueUpper === 'POLYLINE') {
      const parsed = parsePolyline(groups, i + 1);
      polylines.push(parsed.polyline);
      i = parsed.nextIndex - 1;
    }
  }

  return polylines;
}

function dedupeConsecutiveVertices(vertices) {
  return vertices.reduce((acc, vertex) => {
    if (!acc.length || !samePoint(acc[acc.length - 1], vertex)) acc.push({ x: vertex.x, y: vertex.y });
    return acc;
  }, []);
}

function isStrictlyIncreasingInX(vertices) {
  for (let i = 1; i < vertices.length; i += 1) {
    if (!(vertices[i].x > vertices[i - 1].x + EPS)) return false;
  }
  return true;
}

function orientTerrainVertices(vertices) {
  const deduped = dedupeConsecutiveVertices(vertices);
  if (deduped.length < 2) {
    throw new DxfTerrainImportError('The DXF polyline must contain at least two distinct vertices.');
  }
  if (isStrictlyIncreasingInX(deduped)) return deduped;
  const reversed = [...deduped].reverse();
  if (isStrictlyIncreasingInX(reversed)) return reversed;
  throw new DxfTerrainImportError(
    'The DXF terrain must be an open left-to-right polyline with strictly increasing x-coordinates.'
  );
}

function rebaseToOrigin(vertices) {
  const left = vertices[0];
  return vertices.map((vertex) => ({
    x: vertex.x - left.x,
    y: vertex.y - left.y
  }));
}

export function importTerrainFromDxfText(raw) {
  const groups = splitGroupPairs(raw);
  if (!groups.length) {
    throw new DxfTerrainImportError('The DXF file is empty or could not be read as text.');
  }

  const polylines = extractPolylineEntities(groups);
  if (polylines.length !== 1) {
    throw new DxfTerrainImportError(
      `DXF terrain import expects exactly one polyline entity; found ${polylines.length}.`
    );
  }

  const [polyline] = polylines;
  if (polyline.closed) {
    throw new DxfTerrainImportError('DXF terrain import expects one open polyline; closed polylines are not supported.');
  }
  if (polyline.hasBulge) {
    throw new DxfTerrainImportError('DXF terrain import supports straight polyline segments only; bulged arc segments are not supported.');
  }

  const oriented = orientTerrainVertices(polyline.vertices);
  return {
    vertices: rebaseToOrigin(oriented)
  };
}
