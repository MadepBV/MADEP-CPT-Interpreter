// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Section scene of an embedded wall (sheet pile, anchored sheet pile, soldier pile) for the
 * interactive canvas: soil bands (shifted/overridden CPT profile), wall, over-excavation, passive
 * wedge, water, surcharge, retained berm, lagging, anchor, the selected result diagram and the
 * drag handles. Pure: state + result in, scene out.
 */
import { profileBands } from '../soil-profile.js';
import { SOIL_FILL_COLORS } from '../../soil-styles.js';
import { isSoldierPile, isAnchoredType } from '../wall-types.js';
import { hSectionSI } from '../sections/section-properties.js';
import { drivabilityMarker } from '../drivability/drivability-outcome.js';

const COLORS = {
  steel: '#8a8f98', steelStroke: '#3d4350', lagging: '#b8bcc4', insitu: '#b89b6e',
  water: '#3d6b6a', active: '#9b3a32', passive: '#2e6f55', bm: '#7e50a8', shear: '#8a620d', berm: 'rgba(216,177,90,0.45)'
};
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const deg2rad = (d) => d * Math.PI / 180;
const fmt = (v, d = 2) => Number.isFinite(v) ? Number(v).toFixed(d) : '—';

export function buildEmbeddedScene(rw, result, layers) {
  const e = rw.embedded;
  const soldier = isSoldierPile(rw.wallType);
  const anchored = isAnchoredType(rw);
  const H = num(e.retainedHeight, 5), d = num(e.embedment, 4);
  const overdig = Number.isFinite(result?.overdigUls) ? result.overdigUls : (rw.settings.overdigRule === 'none' ? 0 : rw.settings.overdigRule === 'custom' ? num(rw.settings.overdigCustom, 0.3) : 0.30);
  const excY = -overdig;
  const toeY = excY - d;
  const sec = soldier ? hSectionSI(rw.soldier.sectionId) : null;
  const tw = soldier ? Math.max(sec ? sec.b : 0.18, 0.12) : Math.max(H * 0.022, 0.09);
  const topY = H + (soldier ? num(rw.soldier.pileHeadAbove, 0) : 0);
  const anchorDepth0 = num(e.anchorDepth, 1.5);
  const angle = deg2rad(num(e.anchorAngle, 20));
  const freeLen = num(e.freeLen, H * 0.6), fixedLen = num(e.fixedLen, 4);
  const ay = H - anchorDepth0;
  const tipX = tw / 2 + Math.cos(angle) * (freeLen + fixedLen);
  const tipY = ay - Math.sin(angle) * (freeLen + fixedLen);
  const berm = rw.loads?.berm?.enabled ? { h: num(rw.loads.berm.height, 0), slope: deg2rad(num(rw.loads.berm.slopeDeg, 45)) } : null;
  const bermRun = berm && berm.h > 0 ? berm.h / Math.tan(Math.max(berm.slope, 0.05)) : 0;
  const wallRight = Math.max(H * 1.05, 2.5);
  const minX = -Math.max(H * 1.0, d * 0.6, 2.0);
  const maxX = Math.max(anchored ? Math.max(wallRight + 0.6, tipX + 1.4) : wallRight + 0.6, bermRun + 1.5);
  const minY = (anchored ? Math.min(toeY, tipY) : toeY) - 1.0;
  const topOfGround = H + (berm ? berm.h : 0);
  const maxY = topOfGround + (rw.surcharge > 0 ? 1.2 : 0.6);
  const scene = { bounds: { minX, maxX, minY, maxY }, soilLayers: [], regions: [], walls: [], water: [], loads: [], diagrams: [], dims: [], handles: [] };

  const bands = (surfaceEl, x0, x1, minEl, clipTopEl) => profileBands({
    layers: rw.insitu?.mode === 'single' ? [] : layers, surfaceEl, offset: num(rw.profile?.offset, 0), overrides: rw.profile?.overrides || {},
    fallback: { ...rw.insitu, label: rw.insitu?.label || 'in-situ' }, minEl, clipTopEl, colorOf: (t) => SOIL_FILL_COLORS[t] || '#d8c9a8'
  }).map((b) => ({ x0, x1, topEl: b.topEl, botEl: b.botEl, color: b.color, label: b.label + (b.overridden?.length ? ' *' : '') }));
  scene.soilLayers = bands(H, tw / 2, maxX, minY).concat(bands(H, minX, -tw / 2, minY, excY));

  // retained berm / slope behind the wall (drawn as fill on top of the retained surface)
  if (berm && berm.h > 0) {
    scene.regions.push({ pts: [{ x: tw / 2, y: H }, { x: tw / 2, y: H + berm.h }, { x: tw / 2 + bermRun, y: H + berm.h }, { x: maxX, y: H + berm.h }, { x: maxX, y: H }], fill: COLORS.berm, hatch: 'rgba(120,90,30,0.3)', hatchAlpha: 0.5, stroke: 'rgba(120,90,30,0.5)', width: 0.75 });
    scene.dims.push({ x1: tw / 2 + bermRun + 0.4, y1: H, x2: tw / 2 + bermRun + 0.4, y2: H + berm.h, text: `berm ${fmt(berm.h, 2)} m @ ${fmt(num(rw.loads.berm.slopeDeg, 45), 0)}°`, color: '#8a620d' });
  }
  // over-excavation band (nominal level y = 0 to the design level)
  if (overdig > 0.01) scene.regions.push({ pts: [{ x: -tw / 2, y: 0 }, { x: minX, y: 0 }, { x: minX, y: excY }, { x: -tw / 2, y: excY }], fill: 'rgba(180,60,50,0.10)', stroke: 'rgba(150,40,30,0.35)', width: 0.75 });
  // passive wedge
  scene.regions.push({ pts: [{ x: -tw / 2, y: excY }, { x: -tw / 2, y: toeY }, { x: -Math.max(d * 0.9, 0.6), y: toeY }], fill: 'rgba(46,111,85,0.16)', stroke: COLORS.passive, width: 1 });
  // wall
  if (soldier) {
    // lagging above the design excavation (thin plate on the retained face), pile below and above
    const lt = Math.max(num(rw.soldier.laggingThk, 0.01), 0.02);
    scene.walls.push({ pts: [{ x: tw / 2, y: H }, { x: tw / 2 + lt, y: H }, { x: tw / 2 + lt, y: excY }, { x: tw / 2, y: excY }], fill: COLORS.lagging, stroke: COLORS.steelStroke, width: 1 });
    scene.walls.push({ pts: [{ x: -tw / 2, y: topY }, { x: tw / 2, y: topY }, { x: tw / 2, y: toeY }, { x: -tw / 2, y: toeY }], fill: COLORS.steel, stroke: COLORS.steelStroke, width: 1.6 });
  } else {
    scene.walls.push({ pts: [{ x: -tw / 2, y: topY }, { x: tw / 2, y: topY }, { x: tw / 2, y: toeY }, { x: -tw / 2, y: toeY }], fill: COLORS.steel, stroke: COLORS.steelStroke, width: 1.6 });
  }
  if (rw.water.mode !== 'none') { const wy = H - num(rw.water.retainedDepth, 2.5); if (wy > minY && wy < H) scene.water.push({ x0: tw / 2, x1: maxX, el: wy }); }
  if (rw.water.mode === 'both') { const wf = -num(rw.water.frontDepth, 0); if (wf > minY && wf <= 0) scene.water.push({ x0: minX, x1: -tw / 2, el: wf }); }
  const qv = num(rw.surcharge, 0), qp = num(rw.loads?.surchargePermanent, 0);
  if (qv > 0 || qp > 0) scene.loads.push({ x0: tw / 2 + bermRun, x1: Math.max(wallRight, bermRun + 2.5), el: topOfGround, h: 0.5, label: `q = ${fmt(qv, 0)} kPa${qp > 0 ? ` + ${fmt(qp, 0)} perm.` : ''}` });

  // result diagram on the wall: selected series of the governing branch
  const sel = rw.ui?.diagram || 'M';
  const gov = pickBranch(result, rw.ui?.branch);
  if (gov) {
    const D = gov.diagrams || {};
    const ser = sel === 'V' ? D.V : sel === 'p' ? D.net : D.M;
    if (ser && ser.z && ser.z.length > 2) {
      const pts = ser.z.map((z, i) => ({ depth: z, val: ser.v[i] })).filter((p) => p.depth <= (H - toeY) + 1e-6);
      const mmax = Math.max(1e-6, ...pts.map((p) => Math.abs(p.val)));
      const color = sel === 'V' ? COLORS.shear : sel === 'p' ? COLORS.active : COLORS.bm;
      const label = sel === 'V' ? `V_Ed ${fmt(result.structural?.Vmax, 0)} ${result.perPile ? 'kN' : 'kN/m'} (${result.structural?.vCombo || ''})`
        : sel === 'p' ? `net pressure, ${gov.id}` : `M_Ed ${fmt(result.structural?.Mmax, 0)} ${result.perPile ? 'kNm' : 'kNm/m'} (${result.structural?.combo || ''})`;
      scene.diagrams.push({ points: pts, topEl: H, baseX: tw / 2, dir: 1, scale: (H * 0.42) / mmax, color, fill: hexToRgba(color, 0.16), unit: ser.unit, peakLabel: sel, digits: 0, peakText: label });
    }
  }
  if (anchored) {
    scene.anchor = { head: { x: tw / 2, y: ay }, angleRad: angle, freeLen, fixedLen };
    scene.handles.push({ id: 'anchorY', x: tw / 2, y: ay, axis: 'y', cursor: 'ns-resize', label: `anchor depth = ${fmt(anchorDepth0, 2)} m` });
    scene.handles.push({ id: 'anchorTip', x: tipX, y: tipY, axis: 'xy', cursor: 'move', label: `angle ${fmt(num(e.anchorAngle, 20), 0)}°` });
  }
  scene.dims.push({ x1: wallRight, y1: 0, x2: wallRight, y2: H, text: `H = ${fmt(H, 2)} m`, color: '#6d6962' });
  scene.dims.push({ x1: -tw / 2 - 0.3, y1: excY, x2: -tw / 2 - 0.3, y2: toeY, text: `d = ${fmt(d, 2)} m`, color: COLORS.passive });
  if (overdig > 0.01) scene.dims.push({ x1: minX + 0.9, y1: 0, x2: minX + 0.9, y2: excY, text: `over-dig ${fmt(overdig, 2)} m`, color: '#b43c32' });
  if (soldier) scene.dims.push({ x1: -tw / 2 - 0.9, y1: topY + 0.25, x2: tw / 2 + 0.9, y2: topY + 0.25, text: `${rw.soldier.sectionId} @ ${fmt(num(rw.soldier.spacing, 1), 2)} m`, color: COLORS.steelStroke });
  // drivability outcome: predicted refusal depth (red), marginal (amber) or target reached (green), measured from the platform
  const dm = drivabilityMarker(rw);
  if (dm && Number.isFinite(dm.z)) {
    const y = H - dm.z;
    const col = dm.level === 'bad' ? '#b43c32' : dm.level === 'warn' ? '#8a620d' : '#2e6f55';
    scene.dims.push({ x1: -tw / 2 - 1.6, y1: y, x2: tw / 2 + 1.6, y2: y, text: dm.label, color: col });
  }
  const cptX = num(rw.cptX, wallRight * 0.6);
  scene.handles.push({ id: 'cpt', x: cptX, y: H - 0.4, axis: 'x', cursor: 'ew-resize', label: 'CPT position (drawing only)' });
  scene.handles.push({ id: 'embedTip', x: tw / 2, y: toeY, axis: 'y', cursor: 'ns-resize', label: `embedment = ${fmt(d, 2)} m` });
  scene.handles.push({ id: 'retTop', x: -tw / 2, y: H, axis: 'y', cursor: 'ns-resize', label: `retained H = ${fmt(H, 2)} m` });
  if (rw.water.mode !== 'none') { const wy = H - num(rw.water.retainedDepth, 2.5); scene.handles.push({ id: 'waterRet', x: wallRight - 0.6, y: wy, axis: 'y', cursor: 'ns-resize', label: 'water table' }); }
  scene._geom = { H, d, toeY, excY, overdig, tw };
  return scene;
}

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** Branch used for the wall diagram: the user's choice, else the STR-governing branch, else DA1-2. */
export function pickBranch(result, preferredId) {
  const list = result?.branches || [];
  if (!list.length) return null;
  if (preferredId) { const b = list.find((x) => x.id === preferredId); if (b) return b; }
  const gov = list.find((x) => x.id === result?.structural?.combo);
  return gov || list[0];
}

/** Drag mapping for the embedded scene (returns true when the state changed). */
const r2 = (v) => Math.round(v * 100) / 100;   // drag handles snap to centimetres
export function applyEmbeddedDrag(rw, id, w, geom) {
  const e = rw.embedded;
  const excY = geom?.excY ?? 0;
  if (id === 'retTop') { e.retainedHeight = r2(Math.max(w.y, 0.5)); return true; }
  if (id === 'embedTip') { e.embedment = r2(Math.max(excY - w.y, 0.2)); return true; }
  if (id === 'anchorY') { e.anchorDepth = r2(Math.min(Math.max(num(e.retainedHeight, 5) - w.y, 0.2), Math.max(num(e.retainedHeight, 5) - 0.2, 0.2))); return true; }
  if (id === 'anchorTip') {
    const ay = num(e.retainedHeight, 5) - num(e.anchorDepth, 1.5);
    const ang = Math.atan2(ay - w.y, w.x - (geom?.tw || 0.1) / 2) * 180 / Math.PI;
    e.anchorAngle = Math.round(Math.max(0, Math.min(ang, 60))); return true;
  }
  if (id === 'waterRet') { rw.water.retainedDepth = r2(Math.max(num(e.retainedHeight, 5) - w.y, 0)); return true; }
  return false;
}
