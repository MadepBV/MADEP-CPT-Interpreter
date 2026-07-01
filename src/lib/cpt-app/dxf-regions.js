// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// Export Stage-6 soil regions as an ASCII DXF that PLAXIS 2D imports as closed
// polygons ready for material assignment.
//
// Format: AutoCAD 2000 / AC1015 with one closed LWPOLYLINE per region. PLAXIS 2D
// recognises a closed LWPOLYLINE (group 70 bit 1) as a polygon far more reliably
// than an old-style POLYLINE, which tends to come in as an open polycurve; with
// "Import closed polylines as polygons" enabled each loop becomes an assignable
// soil cluster. AC1015 is required because LWPOLYLINE predates neither exists in
// R12; the format also needs handles (group 5) on every table record and entity,
// subclass markers (group 100), the block-record table, and an OBJECTS section —
// all emitted below, mirroring a minimal AutoCAD-written file.
//
// Rules baked in: one closed loop per region (70=1, no duplicated closing
// vertex), straight segments only, coordinates in raw section metres (import at
// scale 1.0), each region on its own named layer, and bit-identical shared
// vertices between adjacent regions (they come from the same computed values, so
// PLAXIS intersect-and-reclusters them into one internal boundary).

// Reserved/awkward characters are stripped so the name is a valid DXF layer name
// (<= 255 chars in AC1015; kept short here). Falls back to a stable token.
function sanitizeLayerName(name, fallback) {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
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
 * Serialise soil regions to an AC1015 DXF string of closed LWPOLYLINEs.
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

  // Handle allocation. The fixed boilerplate below uses low handles (< 0x100);
  // dynamic layer records and entities start at 0x100 so they never collide.
  let handleCounter = 0x100;
  const nextHandle = () => (handleCounter++).toString(16).toUpperCase();
  const layerHandles = layerTable.map(() => nextHandle());
  const entityHandles = list.map(() => nextHandle());
  // $HANDSEED must exceed every used handle.
  const handSeed = Math.max(0xffff, handleCounter).toString(16).toUpperCase();

  g(999, options.title || 'MADEP CPT soil regions - metres - PLAXIS 2D: import closed polylines as polygons, scale 1.0');

  // ---- HEADER ----
  g(0, 'SECTION');
  g(2, 'HEADER');
  g(9, '$ACADVER');
  g(1, 'AC1015');
  g(9, '$HANDSEED');
  g(5, handSeed);
  g(0, 'ENDSEC');

  // ---- TABLES ----
  g(0, 'SECTION');
  g(2, 'TABLES');

  // VPORT (empty)
  g(0, 'TABLE'); g(2, 'VPORT'); g(5, '8'); g(100, 'AcDbSymbolTable'); g(70, 0);
  g(0, 'ENDTAB');

  // LTYPE (CONTINUOUS)
  g(0, 'TABLE'); g(2, 'LTYPE'); g(5, '5'); g(100, 'AcDbSymbolTable'); g(70, 1);
  g(0, 'LTYPE'); g(5, '14'); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbLinetypeTableRecord');
  g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
  g(0, 'ENDTAB');

  // LAYER (one record per material)
  g(0, 'TABLE'); g(2, 'LAYER'); g(5, '2'); g(100, 'AcDbSymbolTable'); g(70, layerTable.length);
  layerTable.forEach((layer, i) => {
    g(0, 'LAYER'); g(5, layerHandles[i]); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbLayerTableRecord');
    g(2, layer.name); g(70, 0); g(62, layer.color); g(6, 'CONTINUOUS');
  });
  g(0, 'ENDTAB');

  // STYLE (empty)
  g(0, 'TABLE'); g(2, 'STYLE'); g(5, '3'); g(100, 'AcDbSymbolTable'); g(70, 0);
  g(0, 'ENDTAB');

  // VIEW (empty)
  g(0, 'TABLE'); g(2, 'VIEW'); g(5, '6'); g(100, 'AcDbSymbolTable'); g(70, 0);
  g(0, 'ENDTAB');

  // UCS (empty)
  g(0, 'TABLE'); g(2, 'UCS'); g(5, '7'); g(100, 'AcDbSymbolTable'); g(70, 0);
  g(0, 'ENDTAB');

  // APPID (ACAD)
  g(0, 'TABLE'); g(2, 'APPID'); g(5, '9'); g(100, 'AcDbSymbolTable'); g(70, 1);
  g(0, 'APPID'); g(5, '12'); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbRegAppTableRecord');
  g(2, 'ACAD'); g(70, 0);
  g(0, 'ENDTAB');

  // DIMSTYLE (empty)
  g(0, 'TABLE'); g(2, 'DIMSTYLE'); g(5, 'A'); g(100, 'AcDbSymbolTable'); g(70, 0);
  g(100, 'AcDbDimStyleTable'); g(71, 0);
  g(0, 'ENDTAB');

  // BLOCK_RECORD (model + paper space)
  g(0, 'TABLE'); g(2, 'BLOCK_RECORD'); g(5, '1'); g(100, 'AcDbSymbolTable'); g(70, 2);
  g(0, 'BLOCK_RECORD'); g(5, '1F'); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbBlockTableRecord'); g(2, '*Model_Space');
  g(0, 'BLOCK_RECORD'); g(5, '1B'); g(100, 'AcDbSymbolTableRecord'); g(100, 'AcDbBlockTableRecord'); g(2, '*Paper_Space');
  g(0, 'ENDTAB');

  g(0, 'ENDSEC');

  // ---- BLOCKS ----
  g(0, 'SECTION');
  g(2, 'BLOCKS');
  g(0, 'BLOCK'); g(5, '20'); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockBegin');
  g(2, '*Model_Space'); g(70, 0); g(10, '0.0'); g(20, '0.0'); g(30, '0.0'); g(3, '*Model_Space'); g(1, '');
  g(0, 'ENDBLK'); g(5, '21'); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockEnd');
  g(0, 'BLOCK'); g(5, '1C'); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockBegin');
  g(2, '*Paper_Space'); g(70, 0); g(10, '0.0'); g(20, '0.0'); g(30, '0.0'); g(3, '*Paper_Space'); g(1, '');
  g(0, 'ENDBLK'); g(5, '1D'); g(100, 'AcDbEntity'); g(8, '0'); g(100, 'AcDbBlockEnd');
  g(0, 'ENDSEC');

  // ---- ENTITIES: one closed LWPOLYLINE per region ----
  g(0, 'SECTION');
  g(2, 'ENTITIES');
  list.forEach((region, index) => {
    g(0, 'LWPOLYLINE');
    g(5, entityHandles[index]);
    g(100, 'AcDbEntity');
    g(8, layerByRegion[index]);
    g(100, 'AcDbPolyline');
    g(90, region.polygon.length); // vertex count
    g(70, 1); // closed -> PLAXIS forms a polygon/cluster
    g(43, '0.0'); // constant width
    region.polygon.forEach((pt) => {
      g(10, fmt(pt.x));
      g(20, fmt(pt.y));
    });
  });
  g(0, 'ENDSEC');

  // ---- OBJECTS (minimal named-object dictionary) ----
  g(0, 'SECTION');
  g(2, 'OBJECTS');
  g(0, 'DICTIONARY'); g(5, 'C'); g(330, '0'); g(100, 'AcDbDictionary'); g(281, 1); g(3, 'ACAD_GROUP'); g(350, 'D');
  g(0, 'DICTIONARY'); g(5, 'D'); g(330, 'C'); g(100, 'AcDbDictionary'); g(281, 1);
  g(0, 'ENDSEC');

  g(0, 'EOF');

  return lines.join('\r\n') + '\r\n';
}
