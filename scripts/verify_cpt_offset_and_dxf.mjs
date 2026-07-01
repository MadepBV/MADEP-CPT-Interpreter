#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifies the two Stage-6 canvas features:
//   A. CPT vertical insertion offset — the CPT layer stack can be raised above
//      or sunk below the terrain. Below → the top layer is extrapolated up to
//      the terrain; above → shallow readings clip at the ground surface. The
//      soil column must stay FULLY TILED (terrain → domain floor) at every
//      offset, and the surface material must follow the offset.
//   B. Region → DXF export — closed polygons, one per region, on per-material
//      layers, in an R12 (AC1009) file PLAXIS 2D imports as clusters.

import { buildCptAutoRegions, polygonArea, isSimplePolygon, materialAt } from '../src/lib/cpt-app/soil-regions.js';
import { exportRegionsToDxf } from '../src/lib/cpt-app/dxf-regions.js';

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) fails += 1;
};

function terrainY(terrain, x) {
  const v = terrain.vertices;
  if (x <= v[0].x) return v[0].y;
  if (x >= v[v.length - 1].x) return v[v.length - 1].y;
  for (let i = 0; i < v.length - 1; i += 1) {
    const a = v[i], b = v[i + 1];
    if (x >= a.x && x <= b.x) {
      if (Math.abs(b.x - a.x) < 1e-9) return Math.max(a.y, b.y);
      return a.y + (b.y - a.y) * ((x - a.x) / (b.x - a.x));
    }
  }
  return v[v.length - 1].y;
}

// Mirror of buildBishopModelFromStageLayers' datum math for the test harness.
function autoRegionsWithOffset(terrain, layers, cptX, analysisDepth, offset) {
  const yGround = terrainY(terrain, cptX);
  const cptTopY = yGround + offset;
  const deepestBot = Math.max(...layers.map((l) => Number(l.bot) || 0), 0);
  const depth = Math.max(analysisDepth, Math.max(deepestBot, 15));
  const analysisBottomY = Math.min(yGround - depth, cptTopY - deepestBot);
  const materials = layers.map((l, i) => ({ id: `layer_${i}`, label: l.name || `Layer ${i + 1}` }));
  return { regions: buildCptAutoRegions(terrain, layers, cptX, analysisBottomY, materials, cptTopY), analysisBottomY, cptTopY, materials };
}

function areaUnderTerrainToFloor(terrain, botY) {
  const v = terrain.vertices;
  let a = 0;
  for (let i = 0; i < v.length - 1; i += 1) a += 0.5 * ((v[i].y - botY) + (v[i + 1].y - botY)) * (v[i + 1].x - v[i].x);
  return a;
}

const PHI = 0.6180339887498949;

// ---------------------------------------------------------------------------
// PART A — insertion offset geometry
// ---------------------------------------------------------------------------
console.log('--- A. CPT insertion offset ---');

const flat = { vertices: [{ x: 0, y: 10 }, { x: 50, y: 10 }] };
const sloped = { vertices: [{ x: 0, y: 12 }, { x: 20, y: 10 }, { x: 35, y: 10 }, { x: 50, y: 6 }] };
const layers = [
  { top: 0, bot: 3, name: 'Sand' },
  { top: 3, bot: 8, name: 'Clay' },
  { top: 8, bot: 20, name: 'DenseSand' }
];
const cptX = 25;
const analysisDepth = 20;

// Invariant: whatever the offset, the CPT column tiles the section from terrain
// to the domain floor — no gaps, no overlaps, all simple polygons.
for (const terrain of [flat, sloped]) {
  const tag = terrain === flat ? 'flat' : 'slope';
  for (const offset of [-3, -2, -1, 0, 1, 2, 5, 12]) {
    const { regions, analysisBottomY } = autoRegionsWithOffset(terrain, layers, cptX, analysisDepth, offset);
    const sumArea = regions.reduce((s, r) => s + Math.abs(polygonArea(r.polygon)), 0);
    const under = areaUnderTerrainToFloor(terrain, analysisBottomY);
    const dA = Math.abs(sumArea - under);
    const nonSimple = regions.filter((r) => r.polygon.length >= 3 && !isSimplePolygon(r.polygon)).length;
    check(`tiling ${tag} offset=${offset}`, dA < 1e-4 && nonSimple === 0, `regs=${regions.length} ΔA=${dA.toFixed(6)} nonSimple=${nonSimple}`);
  }
}

// Surface material must follow the offset (probe just under the terrain at cptX).
const probeSurface = (offset) => {
  const { regions } = autoRegionsWithOffset(flat, layers, cptX, analysisDepth, offset);
  const yG = terrainY(flat, cptX);
  return materialAt(regions, cptX + PHI * 1e-3, yG - 1e-3)?.label || null;
};
check('offset 0 → Sand at surface', probeSurface(0) === 'Sand', probeSurface(0));
check('offset -2 (below) → Sand extrapolated to surface', probeSurface(-2) === 'Sand', probeSurface(-2));
check('offset +2 (above, <3m) → Sand still at surface', probeSurface(2) === 'Sand', probeSurface(2));
check('offset +5 (above, past Sand) → Clay at surface', probeSurface(5) === 'Clay', probeSurface(5));
check('offset +12 (above, past Clay) → DenseSand at surface', probeSurface(12) === 'DenseSand', probeSurface(12));

// Below-terrain extrapolation: the top layer fills the gap ABOVE the CPT top.
{
  const offset = -2; // cptTopY = 8, terrain = 10
  const { regions } = autoRegionsWithOffset(flat, layers, cptX, analysisDepth, offset);
  const inGap = materialAt(regions, cptX + PHI * 1e-3, 9.0)?.label || null; // y=9 is above cptTopY=8
  check('offset -2 → top layer fills 2 m gap above CPT top', inGap === 'Sand', `y=9 → ${inGap}`);
}

// Above-terrain clip: a layer entirely above the terrain must NOT be emitted.
{
  const offset = 5; // Sand (0-3 → elev 15..12) is entirely above terrain=10
  const { regions } = autoRegionsWithOffset(flat, layers, cptX, analysisDepth, offset);
  const sandPresent = regions.some((r) => r.material?.label === 'Sand');
  check('offset +5 → Sand layer (fully above terrain) is clipped away', !sandPresent, `Sand region present=${sandPresent}`);
}

// ---------------------------------------------------------------------------
// PART B — DXF export
// ---------------------------------------------------------------------------
console.log('--- B. Region DXF export ---');

// Minimal ASCII DXF reader: closed POLYLINE loops + declared layers.
function readDxf(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push({ code: lines[i].trim(), value: lines[i + 1].trim() });
  const header = {};
  const layers = new Set();
  const polylines = [];
  let section = '';
  let inLayerTable = false;
  let cur = null;
  let vtx = null;
  for (let i = 0; i < pairs.length; i += 1) {
    const { code, value } = pairs[i];
    if (code === '0' && value === 'SECTION') { section = pairs[i + 1]?.code === '2' ? pairs[i + 1].value : ''; continue; }
    if (code === '0' && value === 'ENDSEC') { section = ''; inLayerTable = false; continue; }
    if (section === 'HEADER' && code === '9') { header.__pending = value; continue; }
    if (section === 'HEADER' && header.__pending && (code === '1' || code === '70')) { header[header.__pending] = value; header.__pending = null; continue; }
    if (section === 'TABLES') {
      if (code === '2' && value === 'LAYER') inLayerTable = true;
      if (inLayerTable && code === '0' && value === 'LAYER') { cur = { }; continue; }
      if (inLayerTable && cur && code === '2') { layers.add(value); cur = null; continue; }
    }
    if (section === 'ENTITIES') {
      if (code === '0' && value === 'POLYLINE') { cur = { layer: null, closed: false, verts: [] }; polylines.push(cur); vtx = null; continue; }
      if (cur && code === '8' && cur.layer === null) { cur.layer = value; continue; }
      if (cur && code === '70' && vtx === null) { cur.closed = (parseInt(value, 10) & 1) === 1; continue; }
      if (code === '0' && value === 'VERTEX') { vtx = { x: null, y: null }; cur.verts.push(vtx); continue; }
      if (vtx && code === '10') { vtx.x = Number(value); continue; }
      if (vtx && code === '20') { vtx.y = Number(value); continue; }
      if (code === '0' && value === 'SEQEND') { vtx = null; continue; }
    }
  }
  return { header, layers, polylines, hasEof: pairs.some((p) => p.code === '0' && p.value === 'EOF') };
}

{
  const { regions } = autoRegionsWithOffset(sloped, layers, cptX, analysisDepth, -1);
  const dxf = exportRegionsToDxf(regions);
  const doc = readDxf(dxf);

  check('DXF is AC1009 (R12)', doc.header.$ACADVER === 'AC1009', doc.header.$ACADVER);
  check('DXF has EOF', doc.hasEof, '');
  // The LAYER table MUST close with ENDTAB (not ENDTABLE) — the wrong token
  // corrupts the TABLES section and AutoCAD/PLAXIS then import no geometry.
  check('LAYER table closes with ENDTAB', /\r?\nENDTAB\r?\n/.test(dxf) && !/\r?\nENDTABLE\r?\n/.test(dxf), '');
  check('DXF polyline count == region count', doc.polylines.length === regions.length, `${doc.polylines.length} vs ${regions.length}`);
  check('every DXF polyline is closed', doc.polylines.every((p) => p.closed), '');
  check('every DXF polyline references a declared layer', doc.polylines.every((p) => doc.layers.has(p.layer)), `layers=${[...doc.layers].join(',')}`);
  check('no repeated closing vertex', doc.polylines.every((p, i) => {
    const a = p.verts[0], b = p.verts[p.verts.length - 1];
    return !(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9);
  }), '');

  // Vertex fidelity: each exported loop matches its region polygon (order + coords).
  let coordOk = true;
  regions.forEach((region, i) => {
    const p = doc.polylines[i];
    if (!p || p.verts.length !== region.polygon.length) { coordOk = false; return; }
    for (let j = 0; j < region.polygon.length; j += 1) {
      if (Math.abs(p.verts[j].x - region.polygon[j].x) > 1e-6 || Math.abs(p.verts[j].y - region.polygon[j].y) > 1e-6) coordOk = false;
    }
  });
  check('DXF vertices match region polygons (metres)', coordOk, '');

  // Two regions sharing a material share a DXF layer; distinct materials do not.
  const { regions: r2 } = autoRegionsWithOffset(sloped, layers, cptX, analysisDepth, 0);
  const doc2 = readDxf(exportRegionsToDxf(r2));
  const distinctMats = new Set(r2.map((r) => r.material?.id)).size;
  check('layer count == distinct materials', doc2.layers.size === distinctMats, `${doc2.layers.size} layers, ${distinctMats} materials`);

  // Degenerate input: no regions → still a well-formed, empty DXF.
  const empty = readDxf(exportRegionsToDxf([]));
  check('empty region set → valid empty DXF', empty.hasEof && empty.polylines.length === 0, '');
}

console.log(`\n${fails === 0 ? 'ALL OK' : 'FAILURES'}: ${fails} failure(s)`);
process.exit(fails === 0 ? 0 : 1);
