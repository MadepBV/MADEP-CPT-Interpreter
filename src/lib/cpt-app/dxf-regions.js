// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Export Stage-6 soil regions as an ASCII DXF that PLAXIS 2D imports as closed
// polygons ready for material assignment.
//
// Format choices (see the PLAXIS 2D "Import geometry" behaviour):
//  - AutoCAD R12 / AC1009 ASCII — the most universally imported flavour.
//  - Old-style POLYLINE / VERTEX / SEQEND with the "closed" flag (70 = 1). R12
//    predates LWPOLYLINE, and current PLAXIS turns each closed polyline into a
//    polygon/cluster, so this is both the safest and the most useful form.
//  - One closed polyline per region, each on its own named layer (group 8), so
//    the engineer can tell the soils apart before assigning materials.
//  - Straight segments only (no bulge/arc/spline) and simple, consistently
//    wound loops — PLAXIS drops curves and chokes on self-intersecting loops.
//  - Coordinates are the raw section metres (x = station, y = elevation). Import
//    at scale factor 1.0.

// Reserved/awkward characters are stripped so the name is a valid DXF R12 layer
// name (<= 31 chars). Falls back to a stable token if nothing usable is left.
function sanitizeLayerName(name, fallback) {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 31);
  return cleaned || fallback;
}

// DXF wants plain decimals; round off floating-point fuzz and normalise -0.
function fmt(value) {
  const v = Math.round((Number(value) || 0) * 1e6) / 1e6;
  return (Object.is(v, -0) ? 0 : v).toString();
}

// Distinct AutoCAD colour indices so adjacent layers read differently on import.
const ACI_CYCLE = [1, 2, 3, 4, 5, 6, 8, 30, 40, 90, 150, 210];

/**
 * Serialise soil regions to an R12 DXF string.
 * @param {Array<{polygon:Array<{x:number,y:number}>, material?:{id?:string,label?:string,name?:string}, materialId?:string}>} regions
 * @param {{title?:string}} [options]
 * @returns {string} DXF text (CRLF line endings, trailing newline)
 */
export function exportRegionsToDxf(regions, options = {}) {
  const list = (regions || []).filter(
    (region) => Array.isArray(region?.polygon) && region.polygon.length >= 3
  );

  const lines = [];
  const g = (code, value) => {
    lines.push(String(code));
    lines.push(String(value));
  };

  // Resolve one DXF layer per material (regions sharing a material share a
  // layer); fall back to a per-region layer when the material is unknown.
  const layerByRegion = [];
  const layerTable = []; // { name, color }
  const usedNames = new Map(); // baseName -> occurrence count
  const materialLayer = new Map(); // materialId -> layer name

  list.forEach((region, index) => {
    const materialId = region?.material?.id || region?.materialId || null;
    if (materialId && materialLayer.has(materialId)) {
      layerByRegion.push(materialLayer.get(materialId));
      return;
    }
    const label = region?.material?.label || region?.material?.name || materialId || `Region ${index + 1}`;
    let name = sanitizeLayerName(label, `SOIL_${index + 1}`);
    if (usedNames.has(name)) {
      const next = usedNames.get(name) + 1;
      usedNames.set(name, next);
      name = sanitizeLayerName(`${name}_${next}`, `SOIL_${index + 1}`);
    } else {
      usedNames.set(name, 1);
    }
    layerTable.push({ name, color: ACI_CYCLE[layerTable.length % ACI_CYCLE.length] });
    if (materialId) materialLayer.set(materialId, name);
    layerByRegion.push(name);
  });

  // Drawing extents for the HEADER.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  list.forEach((region) => {
    region.polygon.forEach((pt) => {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    });
  });
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  g(999, options.title || 'MADEP CPT soil regions - metres - import into PLAXIS 2D at scale 1.0');

  // HEADER
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1009');
  g(9, '$EXTMIN');
  g(10, fmt(minX));
  g(20, fmt(minY));
  g(30, '0.0');
  g(9, '$EXTMAX');
  g(10, fmt(maxX));
  g(20, fmt(maxY));
  g(30, '0.0');
  g(0, 'ENDSEC');

  // TABLES -> LAYER
  g(0, 'SECTION');
  g(2, 'TABLES');
  g(0, 'TABLE');
  g(2, 'LAYER');
  g(70, layerTable.length);
  layerTable.forEach((layer) => {
    g(0, 'LAYER');
    g(2, layer.name);
    g(70, 0);
    g(62, layer.color);
    g(6, 'CONTINUOUS');
  });
  g(0, 'ENDTABLE');
  g(0, 'ENDSEC');

  // ENTITIES -> one closed POLYLINE per region
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  list.forEach((region, index) => {
    const layerName = layerByRegion[index];
    g(0, 'POLYLINE');
    g(8, layerName);
    g(66, 1); // vertices follow (required on R12 POLYLINE)
    g(70, 1); // closed polyline -> PLAXIS forms a polygon/cluster
    g(10, '0.0'); // canonical POLYLINE elevation point
    g(20, '0.0');
    g(30, '0.0');
    region.polygon.forEach((pt) => {
      g(0, 'VERTEX');
      g(8, layerName);
      g(10, fmt(pt.x));
      g(20, fmt(pt.y));
    });
    g(0, 'SEQEND');
    g(8, layerName);
  });
  g(0, 'ENDSEC');
  g(0, 'EOF');

  return lines.join('\r\n') + '\r\n';
}
