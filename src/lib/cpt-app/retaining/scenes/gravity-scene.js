// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Section scene of a gravity / RC cantilever wall for the interactive canvas (soil bands from the
 * shifted/overridden CPT profile, backfill, wall body, water, surcharge, active/passive diagrams,
 * dimensions, drag handles). Pure: state + result in, scene out.
 */
import { profileBands } from '../soil-profile.js';
import { SOIL_FILL_COLORS } from '../../soil-styles.js';

const COLORS = { concrete: '#cfcabe', concreteStroke: '#6d6962', active: '#9b3a32', passive: '#2e6f55' };
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const deg2rad = (d) => d * Math.PI / 180;
const fmt = (v, d = 2) => Number.isFinite(v) ? Number(v).toFixed(d) : '—';
const series = (result, id) => (result?.diagrams || []).find((s) => s.id === id);

export function buildGravityScene(rw, result, layers) {
  const g = rw.wallType === 'gravity' ? rw.gravity : rw.cantilever;
  const toe = num(g.toe, 0.8), heel = num(g.heel, 2), tt = num(g.stemThkTop, 0.3), tb = num(g.stemThkBot, 0.45);
  const Hs = num(g.stemHeight, 4.5), tBase = num(g.baseThk, 0.5);
  const B = toe + tb + heel, topW = tBase + Hs;
  const xStemF = toe, xStemBtop = toe + tt, xStemBbot = toe + tb;
  const frontEl = num(g.frontSoilDepth, 0);
  const kd = num(g.keyDepth, 0);
  const minX = -(toe + Math.max(heel, 2)), maxX = B + heel * 0.9 + 1.0;
  const tanBeta = Math.tan(deg2rad(num(g.betaDeg, 0)));
  const surfBack = topW + Math.max(maxX - xStemBtop, 0) * tanBeta;
  const minY = -(Math.max(kd, 1.5) + 0.5), maxY = Math.max(topW, surfBack) + (rw.surcharge > 0 ? 1.2 : 0.6);
  const scene = { bounds: { minX, maxX, minY, maxY }, soilLayers: [], regions: [], walls: [], water: [], loads: [], diagrams: [], dims: [], handles: [] };
  const cptSurf = frontEl > 0.05 ? frontEl : 0.0;
  const bands = (surfaceEl, x0, x1, minEl, clipTopEl) => profileBands({
    layers: rw.insitu?.mode === 'single' ? [] : layers, surfaceEl, offset: num(rw.profile?.offset, 0), overrides: rw.profile?.overrides || {},
    fallback: { ...rw.insitu, label: rw.insitu?.label || 'in-situ' }, minEl, clipTopEl, colorOf: (t) => SOIL_FILL_COLORS[t] || '#d8c9a8'
  }).map((b) => ({ x0, x1, topEl: b.topEl, botEl: b.botEl, color: b.color, label: b.label + (b.overridden?.length ? ' *' : '') }));
  scene.soilLayers = bands(cptSurf, minX, maxX, minY, 0).concat(cptSurf > 0.05 ? bands(cptSurf, minX, xStemF, 0, cptSurf) : []);
  scene.regions.push({ pts: [{ x: xStemBtop, y: topW }, { x: maxX, y: surfBack }, { x: maxX, y: 0 }, { x: B, y: 0 }, { x: B, y: tBase }, { x: xStemBbot, y: tBase }], fill: 'rgba(216,177,90,0.5)', hatch: 'rgba(120,90,30,0.3)', hatchAlpha: 0.5, stroke: 'rgba(120,90,30,0.4)', width: 0.75 });
  const overDig = Math.min(0.10 * Math.max(topW - frontEl, 0), 0.5);
  const passDepth = Math.max(frontEl - overDig, 0);
  if (rw.settings.passiveToe !== false && passDepth > 0.05) scene.regions.push({ pts: [{ x: 0, y: passDepth }, { x: 0, y: 0 }, { x: -Math.min(passDepth * 1.2, toe + 1.0), y: 0 }], fill: 'rgba(46,111,85,0.16)', stroke: COLORS.passive, width: 1 });
  scene.walls.push({ pts: [{ x: 0, y: 0 }, { x: B, y: 0 }, { x: B, y: tBase }, { x: xStemBbot, y: tBase }, { x: xStemBtop, y: topW }, { x: xStemF, y: topW }, { x: xStemF, y: tBase }, { x: 0, y: tBase }], fill: COLORS.concrete, stroke: COLORS.concreteStroke, width: 1.6 });
  if (kd > 0.01) scene.walls.push({ pts: [{ x: xStemF, y: 0 }, { x: xStemF + num(g.keyThk, 0.3), y: 0 }, { x: xStemF + num(g.keyThk, 0.3), y: -kd }, { x: xStemF, y: -kd }], fill: COLORS.concrete, stroke: COLORS.concreteStroke, width: 1.2 });
  if (rw.water.mode !== 'none') { const wy = topW - num(rw.water.retainedDepth, 2.5); if (wy > minY && wy < topW) scene.water.push({ x0: xStemBtop, x1: maxX, el: wy }); }
  if (rw.surcharge > 0) scene.loads.push({ x0: xStemBtop, x1: maxX, el: topW, h: 0.5, label: `q = ${fmt(rw.surcharge, 0)} kPa` });
  const act = series(result, 'active_pressure');
  if (act && act.z.length > 2) {
    const pmax = Math.max(1e-6, ...act.v.map(Math.abs));
    const vTop = topW + heel * tanBeta;
    scene.diagrams.push({ points: act.z.map((z, i) => ({ depth: z, val: act.v[i] })), topEl: vTop, baseX: B, dir: 1, scale: (heel * 0.85) / pmax, color: COLORS.active, fill: 'rgba(155,58,50,0.16)', unit: 'kPa', peakLabel: 'σa', digits: 0 });
  }
  const pas = series(result, 'passive_pressure');
  if (pas && pas.z.length > 2) {
    const pmax = Math.max(1e-6, ...pas.v.map(Math.abs));
    scene.diagrams.push({ points: pas.z.map((z, i) => ({ depth: z, val: pas.v[i] })), topEl: passDepth, baseX: 0, dir: -1, scale: Math.min((toe + 0.8), 1.4) / pmax, color: COLORS.passive, fill: 'rgba(46,111,85,0.14)', unit: 'kPa', peakLabel: 'σp', digits: 0 });
  }
  scene.dims.push({ x1: 0, y1: minY + 0.2, x2: B, y2: minY + 0.2, text: `B = ${fmt(B, 2)} m`, color: '#6d6962' });
  const cptX = num(rw.cptX, B + heel * 0.5);
  scene.handles.push({ id: 'cpt', x: cptX, y: topW - 0.4, axis: 'x', cursor: 'ew-resize', label: 'CPT position (drawing only)' });
  scene.handles.push({ id: 'stemTop', x: xStemF + tt / 2, y: topW, axis: 'y', cursor: 'ns-resize', label: `stem H = ${fmt(Hs, 2)} m` });
  scene.handles.push({ id: 'toe', x: xStemF, y: tBase, axis: 'x', cursor: 'ew-resize', label: `toe = ${fmt(toe, 2)} m` });
  scene.handles.push({ id: 'heelEnd', x: B, y: tBase, axis: 'x', cursor: 'ew-resize', label: `heel = ${fmt(heel, 2)} m` });
  scene.handles.push({ id: 'baseThk', x: B / 2, y: tBase, axis: 'y', cursor: 'ns-resize', label: `base = ${fmt(tBase, 2)} m` });
  scene.handles.push({ id: 'frontSoil', x: -Math.max(toe * 0.5, 0.4), y: Math.max(frontEl, 0), axis: 'y', cursor: 'ns-resize', label: `front soil = ${fmt(frontEl, 2)} m` });
  if (rw.water.mode !== 'none') { const wy = topW - num(rw.water.retainedDepth, 2.5); scene.handles.push({ id: 'waterRet', x: maxX - 0.6, y: wy, axis: 'y', cursor: 'ns-resize', label: 'water table' }); }
  scene._geom = { B, topW, tBase, toe, heel, xStemF };
  return scene;
}

export function applyGravityDrag(rw, id, w) {
  const g = rw.wallType === 'gravity' ? rw.gravity : rw.cantilever;
  const tb = num(g.stemThkBot, 0.45), toe = num(g.toe, 0.8);
  const clampPos = (v, lo) => Math.round(Math.max(num(v, lo), lo) * 100) / 100;   // snap to centimetres
  if (id === 'toe') g.toe = clampPos(w.x, 0.0);
  else if (id === 'heelEnd') g.heel = clampPos(w.x - toe - tb, 0.1);
  else if (id === 'stemTop') g.stemHeight = clampPos(w.y - num(g.baseThk, 0.5), 0.5);
  else if (id === 'baseThk') g.baseThk = clampPos(w.y, 0.2);
  else if (id === 'frontSoil') g.frontSoilDepth = clampPos(w.y, 0.0);
  else if (id === 'waterRet') rw.water.retainedDepth = clampPos((num(g.baseThk, 0.5) + num(g.stemHeight, 4.5)) - w.y, 0.0);
  else return false;
  return true;
}
