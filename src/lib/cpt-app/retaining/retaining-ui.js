// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Stage 6 "Retaining walls" application UI. Self-contained module wired into the
// legacy controller through a small context (state accessor + render trigger +
// CPT layer accessor). Talks to the C++/wasm EC7 engine via runRetainingAnalysis.
//
// Wall types: cantilever (RC L/T), gravity (mass), sheetpile (cantilever embedded),
// anchored (singly-propped embedded). Soils: foundation/in-situ derived from the
// active CPT layer model (editable) + a manual backfill material.

import { runRetainingAnalysis } from './wasm-loader.js';
import { createRetainingCanvas } from './retaining-canvas.js';
import { SOIL_FILL_COLORS } from '../soil-styles.js';

const WALL_TYPES = [
  { id: 'cantilever', label: 'RC cantilever', sub: 'L / T-shaped reinforced concrete', family: 'gravity' },
  { id: 'gravity', label: 'Gravity / mass', sub: 'Mass concrete, resists by weight', family: 'gravity' },
  { id: 'sheetpile', label: 'Sheet pile', sub: 'Cantilever embedded (Blum)', family: 'embedded' },
  { id: 'anchored', label: 'Anchored', sub: 'Singly propped / anchored (free-earth)', family: 'embedded' }
];

const COLORS = {
  concrete: '#cfcabe', concreteStroke: '#6d6962',
  steel: '#8a8f98', steelStroke: '#3d4350',
  backfill: '#d8b15a', insitu: '#b89b6e', soilStroke: 'rgba(24,24,26,0.35)',
  water: '#3d6b6a', active: '#9b3a32', passive: '#2e6f55', bm: '#7e50a8'
};

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmt(v, d = 2) { return Number.isFinite(v) ? Number(v).toFixed(d) : '—'; }
function deg2rad(d) { return d * Math.PI / 180; }

export function installRetainingApp(ctx) {
  const getRw = () => ctx.getState().stage6.retwall;
  let analysisToken = 0;

  function defaults() {
    return {
      wallType: 'cantilever',
      cantilever: { toe: 0.9, heel: 2.1, stemThkTop: 0.3, stemThkBot: 0.45, stemHeight: 4.5, baseThk: 0.55, keyDepth: 0, keyThk: 0.3, betaDeg: 0, frontSoilDepth: 1.0 },
      gravity: { toe: 0.4, heel: 0.4, stemThkTop: 0.6, stemThkBot: 1.7, stemHeight: 2.5, baseThk: 0.5, backBatterDeg: 6, betaDeg: 0, frontSoilDepth: 1.0 },
      embedded: { retainedHeight: 5.0, embedment: 6.0, anchorDepth: 1.5, anchorAngle: 20, freeLen: 6.0, fixedLen: 5.0, anchorDia: 0.15, anchorSpacing: 2.0, anchorTfk: 150, anchorGammaA: 1.1 },
      backfill: { gammaMoist: 18, gammaSat: 20, phi: 32, c: 0, cu: 0, drained: true, label: 'Granular backfill' },
      insitu: { gammaMoist: 19, gammaSat: 21, phi: 30, c: 5, cu: 0, drained: true, label: 'Foundation / in-situ', source: 'default', mode: 'cpt' },
      water: { mode: 'none', retainedDepth: 2.5, frontDepth: 0.0 },
      surcharge: 10,
      cptX: null,
      settings: { deltaActiveRatio: 0.667, deltaBaseRatio: 1.0, passiveDeltaRatio: 0.667, gammaConc: 24, consequenceClass: 2, riskScheme: 0, assumeCrackWater: true, passiveToe: true, bearingMethod: 'annexd', bearingDepthFactors: true },
      result: null, status: 'idle', error: ''
    };
  }

  function ensure(stage6) {
    if (!stage6.retwall) { stage6.retwall = defaults(); return; }
    const d = defaults();
    const rw = stage6.retwall;
    for (const k of Object.keys(d)) {
      if (rw[k] == null) rw[k] = d[k];
      else if (typeof d[k] === 'object' && !Array.isArray(d[k]) && k !== 'result') {
        for (const kk of Object.keys(d[k])) if (rw[k][kk] == null) rw[k][kk] = d[k][kk];
      }
    }
    if (!WALL_TYPES.some((t) => t.id === rw.wallType)) rw.wallType = 'cantilever';
  }

  const family = (rw) => WALL_TYPES.find((t) => t.id === rw.wallType)?.family || 'gravity';

  // ---------------- engine request ----------------
  function buildRequest(rw) {
    const fam = family(rw);
    const s = rw.settings;
    const settings = {
      deltaActiveRatio: num(s.deltaActiveRatio, 0.667),
      deltaPassiveRatio: num(s.passiveDeltaRatio, 0.667),
      deltaBaseRatio: num(s.deltaBaseRatio, 1.0),
      assumeCrackWater: !!s.assumeCrackWater,
      consequenceClass: num(s.consequenceClass, 2),
      riskScheme: num(s.riskScheme, 0),
      // passive resistance in front of the toe (front soil); delta_p = 2/3·φ'_d, EN Annex C
      passiveToe: s.passiveToe !== false,
      passiveDeltaRatio: num(s.passiveDeltaRatio, 0.667),
      // bearing: EN 1997-1 Annex D (c-φ) with optional depth factors, or the De Beer CPT-direct method
      bearingMethod: s.bearingMethod === 'debeer' ? 'debeer' : 'annexd',
      bearingDepthFactors: s.bearingDepthFactors !== false,
      // Minimum variable surcharge on the retained surface for embedded walls — a prudent
      // UK/CIRIA default (NOT a Belgian NA requirement; see docs §7). Only the embedded
      // engine applies this floor.
      minSurcharge: 10
    };
    const backfill = { topEl: 0, gammaMoist: num(rw.backfill.gammaMoist, 18), gammaSat: num(rw.backfill.gammaSat, 20), phi: num(rw.backfill.phi, 32), c: num(rw.backfill.c, 0), cu: num(rw.backfill.cu, 0), drained: !!rw.backfill.drained };
    const soil = (topEl) => ({ topEl, gammaMoist: num(rw.insitu.gammaMoist, 19), gammaSat: num(rw.insitu.gammaSat, 21), phi: num(rw.insitu.phi, 30), c: num(rw.insitu.c, 5), cu: num(rw.insitu.cu, 0), drained: !!rw.insitu.drained, qc: num(rw.insitu.qc, 0) * 1000 });
    // Full CPT layer profile mapped to engine strata (CPT surface at surfaceEl). The engine
    // subdivides them exactly in the pressure integration. Falls back to the single editable
    // in-situ material when there is no CPT model or the user forces a single material.
    const cptProfile = (surfaceEl) => {
      const layers = (ctx.workingLayers && ctx.workingLayers()) || [];
      if (!layers.length || rw.insitu.mode === 'single') return [soil(surfaceEl)];
      return layers
        .filter((L) => Number.isFinite(L.top) && Number.isFinite(L.bot) && L.bot > L.top)
        .map((L) => ({
          topEl: surfaceEl - num(L.top, 0),
          gammaMoist: num(L.g, 19), gammaSat: num(L.gs, num(L.g, 19) + 1),
          phi: num(L.phi, 30), c: num(L.c, 0), cu: num(L.cu, 0),
          drained: !(num(L.phi, 0) < 1 && num(L.cu, 0) > 0),
          qc: num(L.avgQc, 0) * 1000   // CPT cone resistance MPa → kPa (De Beer bearing method)
        }));
    };

    if (fam === 'gravity') {
      const g = rw.wallType === 'gravity' ? rw.gravity : rw.cantilever;
      const retSurfEl = num(g.baseThk, 0.5) + num(g.stemHeight, 4);
      const wm = rw.water.mode;
      const waterRet = wm === 'none' ? -1000 : retSurfEl - num(rw.water.retainedDepth, 2.5);
      // front ground surface elevation above the base underside = the passive embedment depth
      // (the toe is buried under this soil; the canvas now draws it that way).
      const frontEl = num(g.frontSoilDepth, 0);
      const waterFront = wm === 'both' ? frontEl - num(rw.water.frontDepth, 0) : -1000;
      // Active method is auto-selected by the engine from geometry (Coulomb back face for a
      // mass-gravity wall, Rankine virtual plane for a cantilever); passive is always Annex C.
      return {
        wallType: rw.wallType,
        geom: {
          toe: num(g.toe, 0.8), heel: num(g.heel, 2), stemThkTop: num(g.stemThkTop, 0.3), stemThkBot: num(g.stemThkBot, 0.45),
          stemHeight: num(g.stemHeight, 4.5), baseThk: num(g.baseThk, 0.5), keyDepth: num(g.keyDepth, 0), keyThk: num(g.keyThk, 0.3),
          gammaConc: num(s.gammaConc, 24), betaDeg: num(g.betaDeg, 0), backBatterDeg: num(g.backBatterDeg, 0), frontSoilEl: frontEl
        },
        backfill, insitu: cptProfile(frontEl > 0.05 ? frontEl : 0), water: { retained: waterRet, front: waterFront }, surcharge: num(rw.surcharge, 0), settings
      };
    }
    // embedded
    const e = rw.embedded;
    const H = num(e.retainedHeight, 5);
    const anchorDepth = num(e.anchorDepth, 1.5);
    // Unplanned over-excavation Δa (EN 1997-1 §9.3.2.2): cantilever = 10% of retained height;
    // propped = 10% of the height below the lowest support; capped at 0.5 m. Belgian dry
    // floor +0.30 m (§1.6); under water keep the CIRIA cap only. The ENGINE applies Δa
    // (lowers the excavation by it internally), so we pass only the magnitude — the planned
    // excavation stays at the datum (el 0) and the canvas draws the over-dig explicitly.
    const baseDa = rw.wallType === 'anchored'
      ? Math.min(0.1 * Math.max(H - anchorDepth, 0), 0.5)
      : Math.min(0.1 * H, 0.5);
    const dryFront = rw.water.mode !== 'both';
    const overdig = dryFront ? Math.max(baseDa, 0.30) : baseDa;
    const wm = rw.water.mode;
    const waterRet = wm === 'none' ? -1000 : H - num(rw.water.retainedDepth, 2.5);
    const waterFront = wm === 'both' ? -num(rw.water.frontDepth, 0) : -1000;
    settings.overdig = overdig;  // engine lowers excavationEl by this Δa
    return {
      wallType: rw.wallType,
      geom: {
        retainedSurfaceEl: H, excavationEl: 0, embedment: num(e.embedment, 4), anchorEl: H - anchorDepth,
        anchorAngleDeg: num(e.anchorAngle, 20), anchorFixedLen: num(e.fixedLen, 5), anchorDia: num(e.anchorDia, 0.15),
        anchorSpacing: num(e.anchorSpacing, 2), anchorTfk: num(e.anchorTfk, 150), anchorGammaA: num(e.anchorGammaA, 1.1)
      },
      retained: cptProfile(H), front: cptProfile(H), water: { retained: waterRet, front: waterFront },
      surcharge: num(rw.surcharge, 0), settings
    };
  }

  // ---------------- analysis ----------------
  async function runAnalysis() {
    const rw = getRw();
    const token = ++analysisToken;
    rw.status = 'running';
    let req;
    try { req = buildRequest(rw); } catch (e) { rw.status = 'error'; rw.error = String(e); return; }
    try {
      const result = await runRetainingAnalysis(req);
      if (token !== analysisToken) return;  // superseded
      rw.result = result; rw.status = 'done'; rw.error = '';
    } catch (e) {
      if (token !== analysisToken) return;
      rw.status = 'error'; rw.error = String(e?.message || e); rw.result = null;
    }
    updateResultsDom();
    drawCanvas();
  }

  function updateResultsDom() {
    const el = document.getElementById('retwallResults');
    if (el) el.innerHTML = renderResults(getRw());
  }

  // ---------------- canvas model ----------------
  // CPT in-situ soil layers mapped to elevation bands (CPT surface at surfaceEl).
  function cptBands(surfaceEl, x0, x1, minEl, clipTopEl) {
    const rw = getRw();
    // When the user has chosen a single uniform material, draw ONE band (matching the engine,
    // which collapses to one stratum) instead of the CPT layer profile.
    const single = !!(rw && rw.insitu && rw.insitu.mode === 'single');
    const layers = (!single && ctx.workingLayers && ctx.workingLayers()) || [];
    const out = [];
    for (const L of layers) {
      const topEl = surfaceEl - num(L.top, 0);
      const botEl = surfaceEl - num(L.bot, 0);
      let t = topEl, b = botEl;
      if (clipTopEl != null && t > clipTopEl) t = clipTopEl;
      if (b < minEl) b = minEl;
      if (t - b < 0.02) continue;
      out.push({ x0, x1, topEl: t, botEl: b, color: SOIL_FILL_COLORS[L.type] || '#d8c9a8', label: L.type });
    }
    // single material, or no CPT model: one uniform band
    if (!out.length) out.push({ x0, x1, topEl: clipTopEl != null ? clipTopEl : surfaceEl, botEl: minEl, color: '#cdbf9f', label: single ? ((rw && rw.insitu && rw.insitu.label) || 'in-situ') : 'in-situ' });
    return out;
  }

  function diagramSeries(result, id) {
    return (result?.diagrams || []).find((d) => d.id === id);
  }

  function buildScene(rw) {
    const fam = family(rw);
    const result = rw.result;
    if (fam === 'gravity') return buildGravityScene(rw, result);
    return buildEmbeddedScene(rw, result);
  }

  function buildGravityScene(rw, result) {
    const g = rw.wallType === 'gravity' ? rw.gravity : rw.cantilever;
    const toe = num(g.toe, 0.8), heel = num(g.heel, 2), tt = num(g.stemThkTop, 0.3), tb = num(g.stemThkBot, 0.45);
    const Hs = num(g.stemHeight, 4.5), tBase = num(g.baseThk, 0.5);
    const B = toe + tb + heel, topW = tBase + Hs;
    const xStemF = toe, xStemBtop = toe + tt, xStemBbot = toe + tb;
    const frontEl = num(g.frontSoilDepth, 0);
    const kd = num(g.keyDepth, 0);
    const minX = -(toe + Math.max(heel, 2)), maxX = B + heel * 0.9 + 1.0;
    // sloping backfill rises behind the wall: surface at the stem-top back is topW and climbs
    // at tan(β) toward the rear, so the view top must clear the wedge.
    const tanBeta = Math.tan(deg2rad(num(g.betaDeg, 0)));
    const surfBack = topW + Math.max(maxX - xStemBtop, 0) * tanBeta;  // retained surface at maxX
    const minY = -(Math.max(kd, 1.5) + 0.5), maxY = Math.max(topW, surfBack) + (rw.surcharge > 0 ? 1.2 : 0.6);
    const scene = { bounds: { minX, maxX, minY, maxY }, soilLayers: [], regions: [], walls: [], water: [], loads: [], diagrams: [], dims: [], handles: [] };
    // CPT in-situ / foundation soil. BELOW founding (y=0) it spans the full width (the wall sits
    // on it). The FRONT soil — the same in-situ material exposed in front of the wall — is drawn
    // only IN FRONT of the stem (x ≤ toe), from founding up to the front-soil level. Behind the
    // wall above founding is the placed BACKFILL (a separate region), so the front soil never
    // overlaps the backfill: they are distinct bodies on opposite faces. (The CALCULATION keeps
    // them separate too — active thrust + heel weight use the backfill; the passive toe, the
    // bearing overburden and the foundation use the in-situ profile — so nothing is double-counted.)
    const cptSurf = frontEl > 0.05 ? frontEl : 0.0;
    scene.soilLayers = cptBands(cptSurf, minX, maxX, minY, 0)
      .concat(cptSurf > 0.05 ? cptBands(cptSurf, minX, xStemF, 0, cptSurf) : []);
    // Placed backfill behind the wall. The top follows the (possibly sloping) retained surface
    // — at the stem-top back it is topW and rises at tan(β) toward the rear. It rests on the
    // heel slab (tBase) over the heel and continues DOWN to the founding level (y=0) behind the
    // heel end, so the retained soil is continuous with the foundation — no gap appears when the
    // front soil is dragged down, and the sloping wedge carried by the heel is shown.
    scene.regions.push({ pts: [{ x: xStemBtop, y: topW }, { x: maxX, y: surfBack }, { x: maxX, y: 0 }, { x: B, y: 0 }, { x: B, y: tBase }, { x: xStemBbot, y: tBase }], fill: 'rgba(216,177,90,0.5)', hatch: 'rgba(120,90,30,0.3)', hatchAlpha: 0.5, stroke: 'rgba(120,90,30,0.4)', width: 0.75 });
    // unplanned over-dig Δa = min(0.10·H, 0.5) (EN 1997-1 §9.3.2.2), H = top-of-wall − front level
    const overDig = Math.min(0.10 * Math.max(topW - frontEl, 0), 0.5);
    const passDepth = Math.max(frontEl - overDig, 0);
    if (rw.settings.passiveToe !== false && passDepth > 0.05) {
      scene.regions.push({ pts: [{ x: 0, y: passDepth }, { x: 0, y: 0 }, { x: -Math.min(passDepth * 1.2, toe + 1.0), y: 0 }], fill: 'rgba(46,111,85,0.16)', stroke: COLORS.passive, width: 1 });
    }
    // wall concrete
    const wall = [{ x: 0, y: 0 }, { x: B, y: 0 }, { x: B, y: tBase }, { x: xStemBbot, y: tBase }, { x: xStemBtop, y: topW }, { x: xStemF, y: topW }, { x: xStemF, y: tBase }, { x: 0, y: tBase }];
    scene.walls.push({ pts: wall, fill: COLORS.concrete, stroke: COLORS.concreteStroke, width: 1.6 });
    if (kd > 0.01) scene.walls.push({ pts: [{ x: xStemF, y: 0 }, { x: xStemF + num(g.keyThk, 0.3), y: 0 }, { x: xStemF + num(g.keyThk, 0.3), y: -kd }, { x: xStemF, y: -kd }], fill: COLORS.concrete, stroke: COLORS.concreteStroke, width: 1.2 });
    // water
    if (rw.water.mode !== 'none') {
      const wy = topW - num(rw.water.retainedDepth, 2.5);
      if (wy > minY && wy < topW) scene.water.push({ x0: xStemBtop, x1: maxX, el: wy });
    }
    // surcharge load
    if (rw.surcharge > 0) scene.loads.push({ x0: xStemBtop, x1: maxX, el: topW, h: 0.5, label: `q = ${fmt(rw.surcharge, 0)} kPa` });
    // active pressure diagram on the virtual plane (x = B), pointing into the wall (left)
    const act = diagramSeries(result, 'active_pressure');
    if (act && act.z.length > 2) {
      const pmax = Math.max(1e-6, ...act.v.map(Math.abs));
      const vTop = topW + heel * Math.tan(deg2rad(num(g.betaDeg, 0)));  // virtual-plane top (sloped backfill)
      scene.diagrams.push({ points: act.z.map((z, i) => ({ depth: z, val: act.v[i] })), topEl: vTop, baseX: B, dir: 1, scale: (heel * 0.85) / pmax, color: COLORS.active, fill: 'rgba(155,58,50,0.16)', unit: 'kPa', peakLabel: 'σa', digits: 0 });
    }
    // passive pressure diagram on the toe front (x = 0), pointing left into the front soil
    const pas = diagramSeries(result, 'passive_pressure');
    if (pas && pas.z.length > 2) {
      const pmax = Math.max(1e-6, ...pas.v.map(Math.abs));
      scene.diagrams.push({ points: pas.z.map((z, i) => ({ depth: z, val: pas.v[i] })), topEl: passDepth, baseX: 0, dir: -1, scale: Math.min((toe + 0.8), 1.4) / pmax, color: COLORS.passive, fill: 'rgba(46,111,85,0.14)', unit: 'kPa', peakLabel: 'σp', digits: 0 });
    }
    scene.dims.push({ x1: 0, y1: minY + 0.2, x2: B, y2: minY + 0.2, text: `B = ${fmt(B, 2)} m`, color: '#6d6962' });
    // CPT marker (draggable horizontally)
    const cptX = num(rw.cptX, B + heel * 0.5);
    scene.handles.push({ id: 'cpt', x: cptX, y: topW - 0.4, axis: 'x', cursor: 'ew-resize', label: 'CPT position' });
    // geometry drag handles
    scene.handles.push({ id: 'stemTop', x: xStemF + tt / 2, y: topW, axis: 'y', cursor: 'ns-resize', label: `stem H = ${fmt(Hs, 2)} m` });
    scene.handles.push({ id: 'toe', x: xStemF, y: tBase, axis: 'x', cursor: 'ew-resize', label: `toe = ${fmt(toe, 2)} m` });
    scene.handles.push({ id: 'heelEnd', x: B, y: tBase, axis: 'x', cursor: 'ew-resize', label: `heel = ${fmt(heel, 2)} m` });
    scene.handles.push({ id: 'baseThk', x: B / 2, y: tBase, axis: 'y', cursor: 'ns-resize', label: `base = ${fmt(tBase, 2)} m` });
    scene.handles.push({ id: 'frontSoil', x: -Math.max(toe * 0.5, 0.4), y: Math.max(frontEl, 0), axis: 'y', cursor: 'ns-resize', label: `front soil = ${fmt(frontEl, 2)} m` });
    if (rw.water.mode !== 'none') { const wy = topW - num(rw.water.retainedDepth, 2.5); scene.handles.push({ id: 'waterRet', x: maxX - 0.6, y: wy, axis: 'y', cursor: 'ns-resize', label: 'water table' }); }
    scene._geom = { B, topW, tBase, toe, heel, xStemF };
    return scene;
  }

  function buildEmbeddedScene(rw, result) {
    const e = rw.embedded;
    const H = num(e.retainedHeight, 5), d = num(e.embedment, 4);
    const anchored = rw.wallType === 'anchored';
    // Unplanned over-dig Δa the engine analyses (matches buildRequest): the design excavation
    // sits Δa BELOW the planned front level (y=0); the embedment d is measured below it.
    const anchorDepth0 = num(e.anchorDepth, 1.5);
    const baseDa = anchored
      ? Math.min(0.1 * Math.max(H - anchorDepth0, 0), 0.5)
      : Math.min(0.1 * H, 0.5);
    const overdig = (rw.water.mode !== 'both') ? Math.max(baseDa, 0.30) : baseDa;
    const excY = -overdig;                 // design (over-dug) excavation level
    // The wall AND its bending diagram live ONLY on the actual pile (the user's provided embedment
    // d) — a moment diagram can never be longer than the structure it acts on. The required
    // embedment is reported by the embedment check in the results panel, not drawn as a phantom
    // wall/diagram extension. The toe handle and slider move the pile 1:1.
    const toeY = excY - d;                         // pile toe = user's provided embedment d
    const topY = H, tw = Math.max(H * 0.022, 0.09);
    // anchor tendon geometry — computed first so the viewport can include the grout body
    const angle = deg2rad(num(e.anchorAngle, 20));
    const freeLen = num(e.freeLen, H * 0.6), fixedLen = num(e.fixedLen, 4);
    const ay = H - anchorDepth0;
    const tipX = tw / 2 + Math.cos(angle) * (freeLen + fixedLen);
    const tipY = ay - Math.sin(angle) * (freeLen + fixedLen);
    const wallRight = H * 1.05;            // soil band + H-dimension just right of the wall
    const minX = -(H * 1.0);
    const maxX = anchored ? Math.max(wallRight + 0.6, tipX + 1.4) : wallRight + 0.6;
    const minY = (anchored ? Math.min(toeY, tipY) : toeY) - 1.0;
    const maxY = H + (rw.surcharge > 0 ? 1.2 : 0.6);
    const scene = { bounds: { minX, maxX, minY, maxY }, soilLayers: [], regions: [], walls: [], water: [], loads: [], diagrams: [], dims: [], handles: [] };
    // retained-side CPT bands (x>0) from H down; front-side (x<0) from the over-dug level down
    scene.soilLayers = cptBands(H, tw / 2, maxX, minY).concat(cptBands(H, minX, -tw / 2, minY, excY));
    // over-excavated zone (planned front level y=0 down to the design level excY) — soil removed
    if (overdig > 0.01) {
      scene.regions.push({ pts: [{ x: -tw / 2, y: 0 }, { x: minX, y: 0 }, { x: minX, y: excY }, { x: -tw / 2, y: excY }], fill: 'rgba(180,60,50,0.10)', stroke: 'rgba(150,40,30,0.35)', width: 0.75 });
    }
    // passive wedge in front of the toe — from the design excavation level down to the toe
    scene.regions.push({ pts: [{ x: -tw / 2, y: excY }, { x: -tw / 2, y: toeY }, { x: -Math.max(d * 0.9, 0.6), y: toeY }], fill: 'rgba(46,111,85,0.16)', stroke: COLORS.passive, width: 1 });
    // wall (steel) — the actual pile, top to the provided-embedment toe
    scene.walls.push({ pts: [{ x: -tw / 2, y: topY }, { x: tw / 2, y: topY }, { x: tw / 2, y: toeY }, { x: -tw / 2, y: toeY }], fill: COLORS.steel, stroke: COLORS.steelStroke, width: 1.6 });
    if (rw.water.mode !== 'none') { const wy = H - num(rw.water.retainedDepth, 2.5); if (wy > minY && wy < H) scene.water.push({ x0: tw / 2, x1: maxX, el: wy }); }
    if (rw.surcharge > 0) scene.loads.push({ x0: tw / 2, x1: wallRight, el: H, h: 0.5, label: `q = ${fmt(rw.surcharge, 0)} kPa` });
    // bending-moment diagram off the wall — confined to the actual pile (the engine integrates
    // the moment over the provided embedment, so the diagram and the pile share the same toe).
    const bm = diagramSeries(result, 'M_C1') || (result?.diagrams || []).find((dd) => dd.id.startsWith('M_'));
    if (bm && bm.z.length > 2) {
      const maxDepth = H - toeY;  // the actual pile toe (provided embedment)
      const dp = bm.z.map((z, i) => ({ depth: z, val: bm.v[i] })).filter((p) => p.depth <= maxDepth + 1e-6);
      if (dp.length >= 2) {
        const mmax = Math.max(1e-6, ...dp.map((p) => Math.abs(p.val)));
        // Badge shows the ENGINE's enveloped M_Ed,max (+ governing combo), not a
        // value recomputed from the subsampled plot (which drifted ~0.3% and
        // carried a sign the structural panel does not show).
        const stM = Number(result?.structural?.Mmax);
        const combo = result?.structural?.combo || '';
        scene.diagrams.push({ points: dp, topEl: H, baseX: tw / 2, dir: 1, scale: (H * 0.42) / mmax, color: COLORS.bm, fill: 'rgba(126,80,168,0.16)', unit: 'kNm/m', peakLabel: 'M', digits: 0,
          peakText: Number.isFinite(stM) ? `M_Ed,max ${stM.toFixed(0)} kNm/m${combo ? ' (' + combo + ')' : ''}` : null });
      }
    }
    if (anchored) {
      scene.anchor = { head: { x: tw / 2, y: ay }, angleRad: angle, freeLen, fixedLen };
      scene.handles.push({ id: 'anchorY', x: tw / 2, y: ay, axis: 'y', cursor: 'ns-resize', label: `anchor depth = ${fmt(anchorDepth0, 2)} m` });
      scene.handles.push({ id: 'anchorTip', x: tipX, y: tipY, axis: 'xy', cursor: 'move', label: `angle ${fmt(num(e.anchorAngle, 20), 0)}°` });
    }
    scene.dims.push({ x1: wallRight, y1: 0, x2: wallRight, y2: H, text: `H = ${fmt(H, 1)} m`, color: '#6d6962' });
    scene.dims.push({ x1: -tw / 2 - 0.3, y1: excY, x2: -tw / 2 - 0.3, y2: toeY, text: `d = ${fmt(d, 1)} m`, color: COLORS.passive });
    if (overdig > 0.01) scene.dims.push({ x1: minX + 0.9, y1: 0, x2: minX + 0.9, y2: excY, text: `over-dig ${fmt(overdig, 2)} m`, color: '#b43c32' });
    const cptX = num(rw.cptX, wallRight * 0.6);
    scene.handles.push({ id: 'cpt', x: cptX, y: H - 0.4, axis: 'x', cursor: 'ew-resize', label: 'CPT position' });
    scene.handles.push({ id: 'embedTip', x: tw / 2, y: toeY, axis: 'y', cursor: 'ns-resize', label: `embedment = ${fmt(d, 2)} m` });
    scene.handles.push({ id: 'retTop', x: -tw / 2, y: H, axis: 'y', cursor: 'ns-resize', label: `retained H = ${fmt(H, 2)} m` });
    if (rw.water.mode !== 'none') { const wy = H - num(rw.water.retainedDepth, 2.5); scene.handles.push({ id: 'waterRet', x: wallRight - 0.6, y: wy, axis: 'y', cursor: 'ns-resize', label: 'water table' }); }
    scene._geom = { H, d, toeY };
    return scene;
  }

  // ---------------- interactive canvas mount + drag mapping ----------------
  let canvasApi = null, canvasEl = null;
  function ensureCanvas() {
    const canvas = document.getElementById('retwallCanvas');
    if (!canvas) { canvasApi = null; canvasEl = null; return null; }
    if (!canvasApi || canvasEl !== canvas) {
      canvasApi = createRetainingCanvas(canvas, {
        getScene: () => { try { return buildScene(getRw()); } catch (e) { return null; } },
        onDrag: (id, w) => onHandleDrag(id, w),
        onDragEnd: () => runAnalysis()
      });
      canvasEl = canvas;
      canvasApi.refit();
    }
    return canvasApi;
  }
  function drawCanvas() { const api = ensureCanvas(); if (api) api.render(); }

  const clampPos = (v, lo) => Math.max(num(v, lo), lo);
  function onHandleDrag(id, w) {
    const rw = getRw();
    const fam = family(rw);
    if (id === 'cpt') { rw.cptX = w.x; drawCanvas(); return; }
    if (fam === 'gravity') {
      const g = rw.wallType === 'gravity' ? rw.gravity : rw.cantilever;
      const tb = num(g.stemThkBot, 0.45), toe = num(g.toe, 0.8);
      if (id === 'toe') g.toe = clampPos(w.x, 0.0);
      else if (id === 'heelEnd') g.heel = clampPos(w.x - toe - tb, 0.1);
      else if (id === 'stemTop') g.stemHeight = clampPos(w.y - num(g.baseThk, 0.5), 0.5);
      else if (id === 'baseThk') g.baseThk = clampPos(w.y, 0.2);
      else if (id === 'frontSoil') g.frontSoilDepth = clampPos(w.y, 0.0);
      else if (id === 'waterRet') rw.water.retainedDepth = clampPos((num(g.baseThk, 0.5) + num(g.stemHeight, 4.5)) - w.y, 0.0);
    } else {
      const e = rw.embedded;
      // embedment is measured below the over-dug excavation (y = -Δa); recompute Δa so the
      // toe handle maps back to the analysed embedment, matching buildEmbeddedScene/buildRequest.
      const H0 = num(e.retainedHeight, 5);
      const da = (rw.wallType === 'anchored'
        ? Math.min(0.1 * Math.max(H0 - num(e.anchorDepth, 1.5), 0), 0.5)
        : Math.min(0.1 * H0, 0.5));
      const excY = -((rw.water.mode !== 'both') ? Math.max(da, 0.30) : da);
      if (id === 'retTop') e.retainedHeight = clampPos(w.y, 0.5);
      else if (id === 'embedTip') e.embedment = clampPos(excY - w.y, 0.2);
      else if (id === 'anchorY') e.anchorDepth = clampPos(num(e.retainedHeight, 5) - w.y, 0.2);
      else if (id === 'anchorTip') {
        const ay = num(e.retainedHeight, 5) - num(e.anchorDepth, 1.5);
        const tw = Math.max(num(e.retainedHeight, 5) * 0.022, 0.09);
        const ang = Math.atan2(ay - w.y, w.x - tw / 2) * 180 / Math.PI;
        e.anchorAngle = Math.max(0, Math.min(ang, 60));
      } else if (id === 'waterRet') rw.water.retainedDepth = clampPos(num(e.retainedHeight, 5) - w.y, 0.0);
    }
    drawCanvas();
    scheduleLiveAnalysis();
  }

  let _liveTimer = null;
  function scheduleLiveAnalysis() {
    if (_liveTimer) clearTimeout(_liveTimer);
    _liveTimer = setTimeout(() => { _liveTimer = null; runAnalysis(); }, 140);
  }

  // ---------------- rendering ----------------
  function inputRow(label, path, value, opts = {}) {
    const step = opts.step != null ? opts.step : 0.05;
    const unit = opts.unit ? `<span class="st6-rw-unit">${esc(opts.unit)}</span>` : '';
    return `<label class="st6-rw-field"><span>${esc(label)}</span>
      <span class="st6-rw-inwrap"><input type="number" step="${step}" value="${esc(value)}" oninput="retwallSet('${path}', this.value)">${unit}</span></label>`;
  }

  function geomInputs(rw) {
    const fam = family(rw);
    if (fam === 'gravity') {
      const key = rw.wallType === 'gravity' ? 'gravity' : 'cantilever';
      const g = rw[key];
      let rows = [
        inputRow('Stem height', `${key}.stemHeight`, g.stemHeight, { unit: 'm' }),
        inputRow('Stem thk (top)', `${key}.stemThkTop`, g.stemThkTop, { unit: 'm' }),
        inputRow('Stem thk (base)', `${key}.stemThkBot`, g.stemThkBot, { unit: 'm' }),
        inputRow('Base thickness', `${key}.baseThk`, g.baseThk, { unit: 'm' }),
        inputRow('Toe length', `${key}.toe`, g.toe, { unit: 'm' }),
        inputRow('Heel length', `${key}.heel`, g.heel, { unit: 'm' }),
        inputRow('Backfill slope β', `${key}.betaDeg`, g.betaDeg, { unit: '°', step: 1 }),
        inputRow('Front soil depth', `${key}.frontSoilDepth`, g.frontSoilDepth, { unit: 'm' })
      ];
      if (key === 'gravity') rows.push(inputRow('Back batter', 'gravity.backBatterDeg', g.backBatterDeg, { unit: '°', step: 1 }));
      else rows.push(inputRow('Shear key depth', 'cantilever.keyDepth', g.keyDepth, { unit: 'm' }));
      return rows.join('');
    }
    const e = rw.embedded;
    let rows = [
      inputRow('Retained height H', 'embedded.retainedHeight', e.retainedHeight, { unit: 'm' }),
      inputRow('Embedment d (trial)', 'embedded.embedment', e.embedment, { unit: 'm' })
    ];
    return rows.join('');
  }

  // EC7 / EN 1537 ground-anchor configuration (anchored walls).
  function anchorInputs(rw) {
    const e = rw.embedded;
    return `
      ${inputRow('Anchor depth (below top)', 'embedded.anchorDepth', e.anchorDepth, { unit: 'm' })}
      ${inputRow('Inclination', 'embedded.anchorAngle', e.anchorAngle, { unit: '°', step: 1 })}
      ${inputRow('Free (stem) length', 'embedded.freeLen', e.freeLen, { unit: 'm', step: 0.5 })}
      ${inputRow('Fixed (grout) length', 'embedded.fixedLen', e.fixedLen, { unit: 'm', step: 0.5 })}
      ${inputRow('Grout body Ø', 'embedded.anchorDia', e.anchorDia, { unit: 'm', step: 0.01 })}
      ${inputRow('Horizontal spacing', 'embedded.anchorSpacing', e.anchorSpacing, { unit: 'm', step: 0.25 })}
      ${inputRow('Grout/soil bond τ', 'embedded.anchorTfk', e.anchorTfk, { unit: 'kPa', step: 10 })}
      ${inputRow('Anchor resistance γ_a', 'embedded.anchorGammaA', e.anchorGammaA, { step: 0.05 })}
      <div class="st6-help" style="margin-top:5px">Pull-out R<sub>a,k</sub> = π·Ø·L<sub>fixed</sub>·τ (EN 1537, a preliminary bond estimate to be proven by acceptance testing). T<sub>d</sub> per anchor = T·s/cos(angle) ≤ R<sub>a,d</sub> = R<sub>a,k</sub>/γ<sub>a</sub>. γ<sub>a</sub> = 1.1 is the EN 1997-1 Table A.12 anchorage factor (temporary and permanent); the ~1.5–1.6 range is the pile R4 set and does not apply to anchors. The real caveat is the untested calculated bond — apply a model factor or reduce τ until EN 1537 acceptance testing confirms it. The inclined anchor also adds V = T·tan(angle) downward to the wall. Drag the anchor tip in the view to set the inclination.</div>`;
  }

  function soilInputs(label, key, m) {
    return `<div class="st6-rw-soilgrid">
      ${inputRow('γ', `${key}.gammaMoist`, m.gammaMoist, { unit: 'kN/m³', step: 0.5 })}
      ${inputRow('γ_sat', `${key}.gammaSat`, m.gammaSat, { unit: 'kN/m³', step: 0.5 })}
      ${inputRow("φ'", `${key}.phi`, m.phi, { unit: '°', step: 0.5 })}
      ${inputRow("c'", `${key}.c`, m.c, { unit: 'kPa', step: 0.5 })}
    </div>`;
  }

  function renderInputs(rw) {
    const fam = family(rw);
    const wm = rw.water.mode;
    const s = rw.settings;
    const det = (id, title, body, open = false) => `<details class="st6-rw-acc"${open ? ' open' : ''}><summary>${esc(title)}</summary><div class="st6-rw-accbody">${body}</div></details>`;
    return `
      ${det('geom', 'Geometry', `<div class="st6-rw-fields">${geomInputs(rw)}</div>`, true)}
      ${fam === 'gravity'
        ? det('backfill', 'Backfill (retained fill)', soilInputs('Backfill', 'backfill', rw.backfill), true)
        : ''}
      ${det('insitu', fam === 'gravity' ? 'Foundation / in-situ soil' : 'Retained / in-situ soil', (() => {
        const nLayers = ((ctx.workingLayers && ctx.workingLayers()) || []).length;
        const useCpt = rw.insitu.mode !== 'single' && nLayers > 0;
        return `<label class="st6-rw-field"><span>Soil source</span>
          <select onchange="retwallSet('insitu.mode', this.value)">
            <option value="cpt"${rw.insitu.mode !== 'single' ? ' selected' : ''}>Full CPT profile${nLayers ? ` (${nLayers} layers)` : ''}</option>
            <option value="single"${rw.insitu.mode === 'single' ? ' selected' : ''}>Single material</option>
          </select></label>
        ${useCpt
          ? `<div class="st6-help">The interpreted ${nLayers}-layer CPT profile is used directly. ${fam === 'gravity'
              ? 'Each layer’s γ, φ′ and c′ is subdivided per layer in the foundation bearing, the passive toe and the over-dig overburden; the retained earth pressure uses the engineered backfill defined above.'
              : 'Each layer’s γ, φ′ and c′ is subdivided per layer on BOTH the retained (active) and front (passive) faces.'} Switch to “Single material” to override with a uniform stratum.</div>`
          : `<div class="st6-help">${nLayers ? '' : 'No CPT layer model yet — '}edit the uniform in-situ stratum:</div>${soilInputs('In-situ', 'insitu', rw.insitu)}`}`;
      })(), true)}
      ${rw.wallType === 'anchored' ? det('anchor', 'Ground anchor (EN 1537)', anchorInputs(rw), false) : ''}
      ${det('loads', 'Water & surcharge', `
        <label class="st6-rw-field"><span>Water table</span>
          <select onchange="retwallSet('water.mode', this.value)">
            <option value="none"${wm === 'none' ? ' selected' : ''}>None (drained)</option>
            <option value="retained"${wm === 'retained' ? ' selected' : ''}>Behind wall only</option>
            <option value="both"${wm === 'both' ? ' selected' : ''}>Both sides</option>
          </select></label>
        ${wm !== 'none' ? inputRow('Water depth (retained)', 'water.retainedDepth', rw.water.retainedDepth, { unit: 'm' }) : ''}
        ${wm === 'retained' ? `<div class="st6-help">"Behind wall only" treats the front soil as moist with zero pore pressure — valid only for a cut-off or fully dewatered pit. With a real front water table use "Both sides". Pore pressures are hydrostatic per face (no seepage credit/debit; EN 1997-1 9.3.1.6 — see the engine note in the results).</div>` : ''}
        ${wm === 'both' ? inputRow('Water depth (front)', 'water.frontDepth', rw.water.frontDepth, { unit: 'm' }) : ''}
        ${inputRow('Surcharge q', 'surcharge', rw.surcharge, { unit: 'kPa', step: 1 })}`)}
      ${det('ec7', 'Eurocode 7 settings', `
        <div class="st6-help">The earth-pressure method is selected automatically from the geometry — Rankine on the vertical virtual plane (cantilever / sheet pile) or Coulomb on the real inclined back face (mass-gravity), and the EN 1997-1 Annex C closed form for all passive resistance. There is no less-rigorous option to pick.</div>
        ${inputRow('δ/φ′ active (Coulomb back face)', 'settings.deltaActiveRatio', s.deltaActiveRatio, { step: 0.05 })}
        ${inputRow('δ_b/φ′ base sliding', 'settings.deltaBaseRatio', s.deltaBaseRatio, { step: 0.05 })}
        <div class="st6-help">The ratio applies to the foundation stratum's design φ′ (peak). EN 1997-1 6.5.3(10) recommends the critical-state angle: δ_b = φ′_cv (cast-in-situ) or ⅔·φ′_cv (precast) — for dense/dilatant soils enter a reduced ratio ≈ tanφ′_cv/tanφ′ (peak 38° vs cv 32° otherwise overstates sliding resistance ~25%).</div>
        ${inputRow('δ_p/φ′ passive face', 'settings.passiveDeltaRatio', num(s.passiveDeltaRatio, 0.667), { step: 0.05 })}
        ${family(rw) === 'gravity' ? `<label class="st6-rw-check"><input type="checkbox" ${s.passiveToe !== false ? 'checked' : ''} onchange="retwallSet('settings.passiveToe', this.checked)"> Include passive resistance at the toe</label>
        ${s.passiveToe !== false ? `<div class="st6-help">Passive toe resistance uses the EN 1997-1 Annex C coefficient at M-factored strength with R1 = 1.0 — no lumped mobilisation factor. The unplanned over-dig Δa = min(0.10·H, 0.5 m) removes the top band automatically. Full passive needs large wall movement; verify it separately under SLS, or disable it here for a conservative design.</div>` : ''}` : ''}
        ${family(rw) === 'gravity' ? `<label class="st6-rw-field"><span>Bearing method</span>
          <select onchange="retwallSet('settings.bearingMethod', this.value)">
            <option value="annexd"${s.bearingMethod !== 'debeer' ? ' selected' : ''}>EN 1997-1 Annex D (c−φ)</option>
            <option value="debeer"${s.bearingMethod === 'debeer' ? ' selected' : ''}>De Beer CPT-direct</option>
          </select></label>
        ${s.bearingMethod !== 'debeer'
          ? `<label class="st6-rw-check"><input type="checkbox" ${s.bearingDepthFactors !== false ? 'checked' : ''} onchange="retwallSet('settings.bearingDepthFactors', this.checked)"> Bearing depth factors (Brinch-Hansen)</label>
        <div class="st6-help">Depth factors d_q, d_c credit the soil shear above the buried toe — a Brinch-Hansen/Vesić refinement applied BY DEFAULT (EN Annex D itself omits them; untick for the strict, more conservative Annex-D form). The applied values appear in the bearing-check details. Bearing is governed by the inclined, eccentric toe load on a shallow footing.</div>`
          : `<div class="st6-help">De Beer / EN 1997-2 direct method: the net bearing is derived from the CPT cone resistance q_c near founding (needs a CPT profile; falls back to Annex D if no q_c is available).</div>`}` : ''}
        <label class="st6-rw-field"><span>Consequence class</span>
          <select onchange="retwallSet('settings.consequenceClass', this.value)">
            <option value="1"${s.consequenceClass == 1 ? ' selected' : ''}>CC1 (K_FI 0.90)</option>
            <option value="2"${s.consequenceClass == 2 ? ' selected' : ''}>CC2 (K_FI 1.00)</option>
            <option value="3"${s.consequenceClass == 3 ? ' selected' : ''}>CC3 (K_FI 1.10)</option>
          </select></label>
        <label class="st6-rw-check"><input type="checkbox" ${s.assumeCrackWater ? 'checked' : ''} onchange="retwallSet('settings.assumeCrackWater', this.checked)"> Water-filled tension crack</label>
        <div class="st6-help" style="margin-top:6px">DA1 — both combinations C1 (A1+M1) and C2 (A2+M2) are evaluated; the worst governs each check. γ_Q,C2 = 1.30 (NBN EN 1997-1 ANB).</div>`)}
    `;
  }

  function utilBar(util, pass) {
    const pct = Math.max(0, Math.min(util, 1.5)) / 1.5 * 100;
    const col = !pass ? 'var(--bad)' : util > 0.85 ? 'var(--wn)' : 'var(--ok)';
    return `<div class="st6-rw-util"><div class="st6-rw-util-fill" style="width:${pct}%;background:${col}"></div><div class="st6-rw-util-mark" style="left:${100 / 1.5}%"></div></div>`;
  }

  function renderResults(rw) {
    if (rw.status === 'running' && !rw.result) return `<div class="st6-help" style="padding:18px 0">Computing…</div>`;
    if (rw.status === 'error') return `<div class="info" style="background:var(--bad-soft);border-color:var(--bad);color:var(--bad-text)">Engine error: ${esc(rw.error)}</div>`;
    const r = rw.result;
    if (!r) return `<div class="st6-help" style="padding:18px 0">Adjust the geometry to run the EC7 verification.</div>`;
    const checks = r.checks || [];
    const worst = checks.reduce((m, c) => Math.max(m, c.util || 0), 0);
    const overall = r.overallPass;
    const rows = checks.map((c) => {
      // Embedment check: the engine fills Ed/Rd with DEPTHS (d_required incl.
      // the Blum 1.2 margin, d_provided), so Rd/Ed is a depth ratio — NOT the
      // over-design factor. The true ODF = M_resist/M_drive at the provided
      // embedment ships as the 'ODF_at_provided' extra; show that under the
      // ODF label (6–36% apart in realistic cantilevers, can straddle 1.0).
      const odf = c.id === 'embedment';
      const odfProvided = odf
        ? (c.extra || []).find((kv) => kv?.key === 'ODF_at_provided')?.value
        : null;
      const u = c.util || 0;
      const badge = c.pass ? '<span class="st6-rw-badge ok">PASS</span>' : '<span class="st6-rw-badge bad">FAIL</span>';
      // Transparent but uncluttered: a compact 3-value summary, expandable to the full
      // intermediate values + the engineering note (e.g. the bearing depth factors).
      const kvs = (c.extra || []).map((kv) => `${esc(kv.key)} ${fmt(kv.value, 2)}${kv.unit ? ' ' + esc(kv.unit) : ''}`);
      const compact = kvs.slice(0, 3).join(' · ');
      const hasMore = kvs.length > 3 || c.note;
      const noteHtml = c.note ? `<div style="margin-top:4px;color:var(--tx2);font-style:italic">${esc(c.note)}</div>` : '';
      const extra = !kvs.length ? '' : (hasMore
        ? `<details class="st6-rw-checkextra"><summary style="cursor:pointer">${compact} …</summary><div style="margin-top:4px;line-height:1.55">${kvs.join(' · ')}${noteHtml}</div></details>`
        : `<div class="st6-rw-checkextra">${compact}</div>`);
      return `<tr>
        <td><div class="st6-rw-checkname">${esc(c.label)}</div><div class="st6-rw-checksub">${esc(c.comboLabel || c.combo)} · ${esc(c.verb)}</div>${extra}</td>
        <td class="st6-rw-utilcell">${utilBar(u, c.pass)}<div class="st6-rw-utilnum">${odf
          ? (Number.isFinite(odfProvided)
              ? 'ODF ' + fmt(odfProvided, 2)
              : 'd<sub>prov</sub>/d<sub>req</sub> ' + fmt(c.Rd / Math.max(c.Ed, 1e-9), 2))
          : fmt(u, 2)}</div></td>
        <td>${badge}</td>
      </tr>`;
    }).join('');
    const st = r.structural || {};
    let structural = '';
    if (family(rw) === 'gravity') {
      structural = `<div class="st6-rw-struct">
        <div class="st6-rw-struct-title">Structural design forces (per m run)</div>
        <table class="st6-rw-structtbl"><tbody>
          <tr><td>Stem (base)</td><td>M<sub>Ed</sub> ${fmt(st.stem?.M, 1)} kNm</td><td>V<sub>Ed</sub> ${fmt(st.stem?.V, 1)} kN</td><td>${esc(st.stem?.combo || '')}</td></tr>
          <tr><td>Toe</td><td>M<sub>Ed</sub> ${fmt(st.toe?.M, 1)} kNm</td><td>V<sub>Ed</sub> ${fmt(st.toe?.V, 1)} kN</td><td>${esc(st.toe?.combo || '')}</td></tr>
          <tr><td>Heel</td><td>M<sub>Ed</sub> ${fmt(st.heel?.M, 1)} kNm</td><td>V<sub>Ed</sub> ${fmt(st.heel?.V, 1)} kN</td><td>${esc(st.heel?.combo || '')}</td></tr>
        </tbody></table></div>`;
    } else {
      structural = `<div class="st6-rw-struct">
        <div class="st6-rw-struct-title">Design forces</div>
        <table class="st6-rw-structtbl"><tbody>
          <tr><td>Max bending</td><td colspan="2">M<sub>Ed,max</sub> ${fmt(st.Mmax, 1)} kNm/m</td><td>${esc(st.combo || '')}</td></tr>
          ${rw.wallType === 'anchored' ? `<tr><td>Anchor force</td><td colspan="2">T<sub>d</sub> ${fmt(st.anchorForce, 1)} kN/m</td><td>${esc(st.anchorCombo || '')}</td></tr>` : ''}
          <tr><td>Required embedment</td><td colspan="2">d<sub>req</sub> ${fmt(st.requiredD, 2)} m</td><td>${esc(st.requiredDCombo || '')}</td></tr>
        </tbody></table></div>`;
    }
    return `
      <div class="st6-rw-verdict ${overall ? 'ok' : 'bad'}">
        <span class="st6-rw-verdict-tag">${overall ? 'VERIFICATIONS PASS' : 'NOT VERIFIED'}</span>
        <span>governing utilisation ${fmt(worst, 2)}</span>
      </div>
      <table class="st6-rw-checks"><thead><tr><th>Limit state (governing combo)</th><th>Util.</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      ${structural}
      ${(r.notes || []).length ? `<div class="st6-help" style="margin-top:8px">${(r.notes || []).map(esc).join('<br>')}</div>` : ''}
      <div class="st6-help" style="margin-top:6px">Method &amp; assumptions: <a href="/docs/engineering/retaining-wall" target="_blank" rel="noopener">documentation</a>.</div>`;
  }

  function renderBody() {
    const rw = getRw();
    const tabs = WALL_TYPES.map((t) => `<button class="st6-rw-tab ${t.id === rw.wallType ? 'sel' : ''}" onclick="retwallSetType('${t.id}')"><strong>${esc(t.label)}</strong><span>${esc(t.sub)}</span></button>`).join('');
    return `${RETWALL_STYLE}
      <div class="mc2 st6-retwall">
        <div class="st6-rw-head">
          <div>
            <div class="st6-rw-title">Retaining walls — Eurocode 7 (Belgium, DA1)</div>
            <div class="st6-rw-subtitle">Design and verify gravity, RC cantilever, and embedded sheet-pile (cantilever &amp; anchored) walls to Eurocode 7 for Belgium (NBN EN 1997-1 ANB, DA1): earth pressures, sliding, bearing, overturning, embedment and the structural design forces — with a live, draggable section.</div>
          </div>
        </div>
        <div class="st6-rw-tabs">${tabs}</div>
        <div class="st6-rw-cols">
          <div class="st6-rw-inputs">${renderInputs(rw)}</div>
          <div class="st6-rw-canvaswrap"><canvas id="retwallCanvas"></canvas>
            <div class="st6-rw-canvastools">
              <button type="button" title="Fit to view" onclick="retwallFit()">⤢ Fit</button>
              <span class="st6-rw-hint">drag ● handles to edit · scroll to zoom · drag empty to pan</span>
            </div>
            <div class="st6-rw-legend">
              <span><i style="background:${COLORS.backfill}"></i>backfill</span>
              <span><i style="background:${COLORS.insitu}"></i>in-situ (CPT)</span>
              <span><i style="background:${COLORS.active}"></i>σ active</span>
              <span><i style="background:${COLORS.passive}"></i>σ passive</span>
              <span><i style="background:${COLORS.bm}"></i>moment</span>
              <span><i style="background:${COLORS.water}"></i>water</span>
            </div>
          </div>
          <div class="st6-rw-results" id="retwallResults">${renderResults(rw)}</div>
        </div>
      </div>`;
  }

  function postRender() {
    if (canvasApi) { try { canvasApi.destroy(); } catch (e) {} }  // release stale capture/handlers
    canvasApi = null; canvasEl = null;  // fresh mount for the new DOM
    drawCanvas();
    if (canvasApi) canvasApi.refit();
    runAnalysis();
    if (typeof window !== 'undefined') {
      if (postRender._ro) postRender._ro.disconnect();
      const c = document.getElementById('retwallCanvas');
      if (c && typeof ResizeObserver !== 'undefined') {
        postRender._ro = new ResizeObserver(() => { if (canvasApi) canvasApi.render(); });
        postRender._ro.observe(c.parentElement || c);
      }
    }
  }

  // ---------------- handlers ----------------
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
    o[parts[parts.length - 1]] = value;
  }

  const handlers = {
    retwallFit() { const api = ensureCanvas(); if (api) api.refit(); },
    retwallSetType(type) {
      const rw = getRw();
      if (!WALL_TYPES.some((t) => t.id === type)) return;
      rw.wallType = type; rw.result = null;
      ctx.requestRender();
    },
    retwallSet(path, value) {
      const rw = getRw();
      // booleans pass through; numbers parsed; strings kept
      let v = value;
      if (typeof value === 'boolean') v = value;
      else if (path === 'water.mode' || path === 'insitu.mode' || path === 'settings.bearingMethod') v = value;  // string enums
      else { const n = Number(value); v = Number.isFinite(n) ? n : value; }
      // Anchor depth must lie within the retained height: an anchor typed
      // at/above the wall top (or absurdly deep) silently corrupted the moment
      // reference and dropped the anchor reaction from the bending diagram
      // (the engine now also clamps, belt-and-braces).
      if (path === 'embedded.anchorDepth' && Number.isFinite(v)) {
        const Hret = Number(rw.embedded?.retainedHeight) || 5;
        v = Math.min(Math.max(v, 0.2), Math.max(Hret - 0.2, 0.2));
      }
      setPath(rw, path, v);
      // water mode / method changes the input set -> full re-render; numeric -> rerun + redraw
      if (path === 'water.mode' || path === 'insitu.mode') { ctx.requestRender(); return; }
      runAnalysis();
    },
    retwallPullCpt() {
      const rw = getRw();
      const layers = (ctx.workingLayers && ctx.workingLayers()) || [];
      if (!layers.length) { rw.insitu.source = 'default'; updateResultsDom(); return; }
      // representative foundation soil: deepest layer with strength data
      let best = null;
      for (const L of layers) {
        if (Number.isFinite(L.phi) || Number.isFinite(L.cu)) best = L;
      }
      const L = best || layers[layers.length - 1];
      rw.insitu.gammaMoist = num(L.g, rw.insitu.gammaMoist);
      rw.insitu.gammaSat = num(L.gs, rw.insitu.gammaSat);
      rw.insitu.phi = num(L.phi, rw.insitu.phi);
      rw.insitu.c = num(L.c, rw.insitu.c);
      rw.insitu.cu = num(L.cu, rw.insitu.cu);
      rw.insitu.drained = !(num(L.phi, 0) < 1 && num(L.cu, 0) > 0);
      rw.insitu.label = `CPT: ${L.type || 'layer'}`;
      rw.insitu.source = 'cpt';
      ctx.requestRender();
    }
  };

  const cardMeta = { id: 'retwall', title: 'Retaining walls', desc: 'Gravity, RC cantilever and sheet-pile wall design to Eurocode 7 (Belgium): earth pressures, stability, bearing and structural forces.' };

  return { defaults, ensure, renderBody, postRender, handlers, cardMeta };
}

// Scoped styles (injected once with the body; cheap and keeps legacy.css untouched).
const RETWALL_STYLE = `<style>
.st6-retwall{padding:14px}
.st6-rw-head{margin-bottom:10px}
.st6-rw-title{font-size:14px;font-weight:600}
.st6-rw-subtitle{font-size:11.5px;color:var(--tx2);margin-top:3px;max-width:90ch}
.st6-rw-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:12px}
.st6-rw-tab{display:flex;flex-direction:column;gap:2px;align-items:flex-start;text-align:left;padding:8px 10px;border:1px solid var(--bd);border-radius:var(--r);background:var(--panel-solid);cursor:pointer;transition:all .15s}
.st6-rw-tab span{font-size:10.5px;color:var(--tx2)}
.st6-rw-tab:hover{border-color:var(--ac)}
.st6-rw-tab.sel{border-color:var(--ac);background:var(--acl);box-shadow:inset 0 0 0 1px var(--ac)}
.st6-rw-cols{display:grid;grid-template-columns:300px minmax(280px,1fr) 360px;gap:14px;align-items:start}
.st6-rw-inputs{display:flex;flex-direction:column;gap:7px}
.st6-rw-acc{border:1px solid var(--bd);border-radius:var(--r);background:var(--panel-solid);overflow:hidden}
.st6-rw-acc>summary{padding:8px 10px;font-size:12px;font-weight:600;cursor:pointer;list-style:none}
.st6-rw-acc>summary::-webkit-details-marker{display:none}
.st6-rw-acc>summary::before{content:'▸';margin-right:6px;color:var(--tx3)}
.st6-rw-acc[open]>summary::before{content:'▾'}
.st6-rw-accbody{padding:8px 10px;border-top:1px solid var(--bd)}
.st6-rw-fields{display:flex;flex-direction:column;gap:6px}
.st6-rw-soilgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.st6-rw-field{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11.5px}
.st6-rw-field>span:first-child{color:var(--tx2);white-space:nowrap}
.st6-rw-inwrap{display:flex;align-items:center;gap:4px}
.st6-rw-field input[type=number]{width:72px;padding:3px 6px;border:1px solid var(--bd2);border-radius:4px;background:var(--input-bg);font:inherit;font-size:11.5px;text-align:right}
.st6-rw-field select{padding:3px 6px;border:1px solid var(--bd2);border-radius:4px;background:var(--input-bg);font:inherit;font-size:11.5px}
.st6-rw-unit{font-size:10px;color:var(--tx3);min-width:34px}
.st6-rw-row{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.st6-rw-check{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--tx2);margin-top:6px}
.st6-rw-canvaswrap{position:relative;min-height:420px;border:1px solid var(--bd);border-radius:var(--r);background:var(--panel-solid);overflow:hidden}
.st6-rw-canvaswrap canvas{width:100%;height:420px;display:block}
.st6-rw-canvastools{position:absolute;top:8px;right:8px;display:flex;gap:8px;align-items:center}
.st6-rw-canvastools button{font-size:11px;padding:3px 9px;border:1px solid var(--bd2);border-radius:5px;background:rgba(255,255,255,0.88);cursor:pointer;font-family:var(--font-mono)}
.st6-rw-canvastools button:hover{border-color:var(--ac);color:var(--ac)}
.st6-rw-hint{font-size:10px;color:var(--tx3);background:rgba(247,244,239,0.82);padding:3px 7px;border-radius:5px}
.st6-rw-canvaswrap canvas{touch-action:none}
.st6-rw-legend{position:absolute;left:8px;bottom:8px;display:flex;gap:10px;flex-wrap:wrap;font-size:10px;color:var(--tx2);background:rgba(247,244,239,0.82);padding:4px 7px;border-radius:5px}
.st6-rw-legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:3px;vertical-align:middle}
.st6-rw-results{font-size:12px}
.st6-rw-verdict{display:flex;align-items:center;gap:10px;padding:8px 11px;border-radius:var(--r);margin-bottom:10px;font-size:12px}
.st6-rw-verdict.ok{background:var(--ok-soft);color:var(--ok-text)}
.st6-rw-verdict.bad{background:var(--bad-soft);color:var(--bad-text)}
.st6-rw-verdict-tag{font-weight:700;font-family:var(--font-mono);font-size:10.5px;letter-spacing:.04em}
.st6-rw-checks{width:100%;border-collapse:collapse}
.st6-rw-checks th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--tx3);padding:4px 6px;border-bottom:1px solid var(--bd)}
.st6-rw-checks td{padding:7px 6px;border-bottom:1px solid var(--bd);vertical-align:top}
.st6-rw-checkname{font-weight:600;font-size:11.5px}
.st6-rw-checksub{font-size:10px;color:var(--tx3);margin-top:1px}
.st6-rw-checkextra{font-size:10px;color:var(--tx2);margin-top:2px;font-family:var(--font-mono)}
.st6-rw-utilcell{width:120px}
.st6-rw-util{position:relative;height:7px;background:var(--bg2);border-radius:4px;overflow:hidden;margin-bottom:3px}
.st6-rw-util-fill{position:absolute;left:0;top:0;bottom:0;border-radius:4px}
.st6-rw-util-mark{position:absolute;top:-1px;bottom:-1px;width:1px;background:var(--tx3)}
.st6-rw-utilnum{font-size:10.5px;font-family:var(--font-mono);color:var(--tx2)}
.st6-rw-badge{font-size:9.5px;font-weight:700;font-family:var(--font-mono);padding:2px 5px;border-radius:3px}
.st6-rw-badge.ok{background:var(--ok-soft);color:var(--ok-text)}
.st6-rw-badge.bad{background:var(--bad-soft);color:var(--bad-text)}
.st6-rw-struct{margin-top:12px}
.st6-rw-struct-title{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--tx3);margin-bottom:4px}
.st6-rw-structtbl{width:100%;border-collapse:collapse;font-size:11px}
.st6-rw-structtbl td{padding:4px 6px;border-bottom:1px solid var(--bd);font-family:var(--font-mono)}
.st6-rw-structtbl td:first-child{font-family:inherit;color:var(--tx2)}
@media (max-width:1100px){.st6-rw-cols{grid-template-columns:1fr}.st6-rw-tabs{grid-template-columns:repeat(2,1fr)}}
</style>`;
