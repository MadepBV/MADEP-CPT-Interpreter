#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Proves the CPT auto soil-band regions TILE the soil column under the terrain with NO
// gaps and NO overlaps (no "double soil polygons"). These regions feed stability (Bishop),
// seepage, and deformation, where an overlap double-counts soil weight / mis-assigns
// material. Four independent checks over structured + random VALID terrains and layer
// stacks:
//   (1) every region polygon is SIMPLE (no self-intersection);
//   (2) AREA CONSERVATION: Σ region areas == area under the terrain (too small on a gap,
//       too large on an overlap — only equality passes);
//   (3) NO GAP: every interior point under the terrain is covered by ≥1 region;
//   (4) NO OVERLAP: no interior point is STRICTLY inside two regions, and materialAt()
//       (the consumer entry point) resolves a single material everywhere.
// Sampling uses generic (irrational) offsets so points never land on a shared boundary.

import {
  buildCptAutoRegions, polygonArea, isSimplePolygon, pointInPolygonHalfOpen, materialAt
} from '../src/lib/cpt-app/soil-regions.js';

let fails = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  [' + detail + ']' : ''}`);
  if (!cond) fails += 1;
};

// crossing-number STRICT interior test (excludes the boundary), for the overlap check.
function strictlyInside(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i], b = poly[j];
    if ((a.y > y) !== (b.y > y)) {
      const xHit = ((b.x - a.x) * (y - a.y)) / ((b.y - a.y) || 1e-300) + a.x;
      if (x < xHit) inside = !inside;
    }
  }
  return inside;
}

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

const PHI = 0.6180339887498949;  // irrational fractions ⇒ samples avoid layer boundaries

function scenario(label, terrain, layers, cptX, botY) {
  const mats = layers.map((_, i) => ({ label: `L${i + 1}`, color: '#abc' }));
  const regs = buildCptAutoRegions(terrain, layers, cptX, botY, mats);
  const v = terrain.vertices;
  const xmin = v[0].x, xmax = v[v.length - 1].x;

  let nonSimple = 0;
  for (const r of regs) if (r.polygon.length >= 3 && !isSimplePolygon(r.polygon)) nonSimple += 1;

  let areaUnder = 0;
  for (let i = 0; i < v.length - 1; i += 1) {
    const a = v[i], b = v[i + 1];
    areaUnder += 0.5 * ((a.y - botY) + (b.y - botY)) * (b.x - a.x);
  }
  const sumArea = regs.reduce((s, r) => s + Math.abs(polygonArea(r.polygon)), 0);

  let gaps = 0, overlaps = 0, multiMat = 0, total = 0;
  const NX = 173, NY = 97;
  for (let ix = 0; ix < NX; ix += 1) {
    const x = xmin + (xmax - xmin) * ((ix + PHI) / NX);
    const ty = terrainY(terrain, x);
    if (ty - botY < 0.02) continue;
    for (let iy = 0; iy < NY; iy += 1) {
      const y = botY + (ty - botY) * ((iy + PHI * 0.5) / NY);
      if (y >= ty - 0.01 || y <= botY + 0.01) continue;
      total += 1;
      let covered = 0, strict = 0;
      for (const r of regs) {
        if (pointInPolygonHalfOpen(r.polygon, x, y)) covered += 1;
        if (strictlyInside(r.polygon, x, y)) strict += 1;
      }
      if (covered === 0) gaps += 1;
      if (strict > 1) overlaps += 1;
      if (covered >= 1 && !materialAt(regs, x, y)) multiMat += 1;
    }
  }

  const dA = Math.abs(areaUnder - sumArea);
  const ok = nonSimple === 0 && dA < 1e-3 && gaps === 0 && overlaps === 0 && multiMat === 0;
  check(label, ok, `regs=${regs.length} nonSimple=${nonSimple} ΔA=${dA.toFixed(4)} gaps=${gaps}/${total} overlaps=${overlaps} noMat=${multiMat}`);
}

const L3 = [{ top: 0, bot: 1.5 }, { top: 1.5, bot: 4 }, { top: 4, bot: 8 }];
const L5 = [{ top: 0, bot: 1 }, { top: 1, bot: 2.5 }, { top: 2.5, bot: 4 }, { top: 4, bot: 6 }, { top: 6, bot: 12 }];

console.log('== structured terrains ==');
scenario('flat',            { vertices: [{ x: 0, y: 0 }, { x: 20, y: 0 }] }, L3, 10, -10);
scenario('slope down',      { vertices: [{ x: 0, y: 0 }, { x: 20, y: -5 }] }, L3, 10, -10);
scenario('slope up',        { vertices: [{ x: 0, y: -5 }, { x: 20, y: 0 }] }, L3, 10, -10);
scenario('hill',            { vertices: [{ x: 0, y: 0 }, { x: 6, y: 3 }, { x: 12, y: -1 }, { x: 20, y: -1 }] }, L3, 3, -10);
scenario('vertical step',   { vertices: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: -3 }, { x: 20, y: -3 }] }, L3, 4, -10);
scenario('deep V (trench)', { vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: -2 }, { x: 9, y: -9 }, { x: 13, y: -9 }, { x: 18, y: 1 }] }, L5, 1, -13);
scenario('symmetric V',     { vertices: [{ x: 0, y: 0 }, { x: 10, y: -9 }, { x: 20, y: 0 }] }, L5, 0.1, -12);
scenario('W (two valleys)', { vertices: [{ x: 0, y: 0 }, { x: 5, y: -7 }, { x: 10, y: -1 }, { x: 15, y: -7 }, { x: 20, y: 0 }] }, L5, 10, -12);
scenario('valley == botY',  { vertices: [{ x: 0, y: 0 }, { x: 10, y: -6 }, { x: 20, y: 0 }] }, L5, 0.1, -12); // yGround=-6 ⇒ a layer bot lands on the valley
scenario('vertical + V',    { vertices: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: -3 }, { x: 12, y: -10 }, { x: 19, y: 0 }] }, L5, 0.5, -13);

console.log('\n== 500 random VALID terrains × random layer stacks ==');
let rng = 24681357;
const rnd = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
// VALID terrain: strictly-advancing x with occasional single 2-point vertical face.
function randTerrain() {
  const vs = [];
  let x = 0;
  const n = 2 + Math.floor(rnd() * 7);
  for (let k = 0; k < n; k += 1) {
    vs.push({ x, y: -rnd() * 11 });
    if (rnd() < 0.22) vs.push({ x, y: -rnd() * 11 });   // one vertical face (exactly 2 points at x)
    x += 0.4 + rnd() * 4;                                 // always advance before the next vertex
  }
  return { vertices: vs };
}
let randFails = 0;
for (let t = 0; t < 500; t += 1) {
  const terrain = randTerrain();
  const nl = 1 + Math.floor(rnd() * 5);
  const layers = [];
  let d = 0;
  for (let k = 0; k < nl; k += 1) { const t0 = d; d += 0.5 + rnd() * 3; layers.push({ top: t0, bot: k === nl - 1 ? 99 : d }); }
  const cptX = terrain.vertices[Math.floor(rnd() * terrain.vertices.length)].x;
  const fb = fails;
  scenario(`rand${t}`, terrain, layers, cptX, -14);
  if (fails > fb) randFails += 1;
}
console.log(`random scenarios with a failure: ${randFails}/500`);

console.log(`\n${fails ? 'FAILURES' : 'ALL OK'}: ${fails} failure(s)`);
process.exit(fails ? 1 : 0);
