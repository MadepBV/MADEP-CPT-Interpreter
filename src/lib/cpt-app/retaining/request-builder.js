// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
/**
 * Builds the engine request (JSON schema of retaining_wasm.cpp) from the application state.
 * Pure: the only inputs are the state and the Stage 3/4 working layers. Everything the engine
 * needs is passed explicitly — no hidden defaults on either side.
 */
import { wallType, isEmbedded, isSoldierPile } from './wall-types.js';
import { buildStrata, strataForEngine } from './soil-profile.js';
import { hSectionSI } from './sections/section-properties.js';

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** Strata of the in-situ profile referenced to `surfaceEl` (wall frame), with shift and overrides. */
export function insituStrata(rw, layers, surfaceEl) {
  const single = rw.insitu?.mode === 'single';
  const built = buildStrata({
    layers: single ? [] : layers,
    surfaceEl,
    offset: num(rw.profile?.offset, 0),
    overrides: rw.profile?.overrides || {},
    fallback: { gammaMoist: num(rw.insitu.gammaMoist, 19), gammaSat: num(rw.insitu.gammaSat, 21), phi: num(rw.insitu.phi, 30), c: num(rw.insitu.c, 5), cu: num(rw.insitu.cu, 0), drained: rw.insitu.drained !== false, qc: num(rw.insitu.qc, 0), label: rw.insitu.label }
  });
  return built;
}

function waterLevels(rw, surfaceEl, frontEl) {
  const wm = rw.water?.mode || 'none';
  return {
    retained: wm === 'none' ? -1000 : surfaceEl - num(rw.water.retainedDepth, 2.5),
    front: wm === 'both' ? frontEl - num(rw.water.frontDepth, 0) : -1000
  };
}

export function buildGravityRequest(rw, layers) {
  const g = rw.wallType === 'gravity' ? rw.gravity : rw.cantilever;
  const s = rw.settings;
  const retSurfEl = num(g.baseThk, 0.5) + num(g.stemHeight, 4);
  const frontEl = num(g.frontSoilDepth, 0);
  const cptSurf = frontEl > 0.05 ? frontEl : 0;
  const profile = insituStrata(rw, layers, cptSurf);
  const water = waterLevels(rw, retSurfEl, frontEl);
  return {
    request: {
      wallType: rw.wallType,
      geom: {
        toe: num(g.toe, 0.8), heel: num(g.heel, 2), stemThkTop: num(g.stemThkTop, 0.3), stemThkBot: num(g.stemThkBot, 0.45),
        stemHeight: num(g.stemHeight, 4.5), baseThk: num(g.baseThk, 0.5), keyDepth: num(g.keyDepth, 0), keyThk: num(g.keyThk, 0.3),
        gammaConc: num(s.gammaConc, 24), betaDeg: num(g.betaDeg, 0), backBatterDeg: num(g.backBatterDeg, 0), frontSoilEl: frontEl
      },
      backfill: { topEl: 0, gammaMoist: num(rw.backfill.gammaMoist, 18), gammaSat: num(rw.backfill.gammaSat, 20), phi: num(rw.backfill.phi, 32), c: num(rw.backfill.c, 0), cu: num(rw.backfill.cu, 0), drained: rw.backfill.drained !== false },
      insitu: strataForEngine(profile.strata),
      water,
      surcharge: num(rw.surcharge, 0),
      settings: {
        deltaActiveRatio: num(s.deltaActiveRatio, 0.667), deltaBaseRatio: num(s.deltaBaseRatio, 1.0), passiveDeltaRatio: num(s.passiveDeltaRatio, 0.667),
        assumeCrackWater: !!s.assumeCrackWater, consequenceClass: num(s.consequenceClass, 2), riskScheme: 0,
        passiveToe: s.passiveToe !== false, bearingMethod: s.bearingMethod === 'debeer' ? 'debeer' : 'annexd', bearingDepthFactors: s.bearingDepthFactors !== false
      }
    },
    profile
  };
}

export function buildEmbeddedRequest(rw, layers) {
  const e = rw.embedded, s = rw.settings, t = wallType(rw.wallType);
  const soldier = isSoldierPile(rw.wallType);
  const H = num(e.retainedHeight, 5);
  const profile = insituStrata(rw, layers, H);
  const strata = strataForEngine(profile.strata);
  const water = waterLevels(rw, H, 0);
  const anchored = !!t.anchored || (soldier && !!e.anchored);
  const sec = soldier ? hSectionSI(rw.soldier.sectionId) : null;
  const pileWidth = sec ? sec.b : 0.18;
  const berm = rw.loads?.berm?.enabled ? { height: num(rw.loads.berm.height, 0), slopeDeg: num(rw.loads.berm.slopeDeg, 45), gamma: profile.strata[0]?.gammaMoist } : null;
  const mo = s.materialOverride || {};
  const request = {
    wallType: t.engine,
    geom: {
      retainedSurfaceEl: H, excavationEl: 0, embedment: num(e.embedment, 4),
      anchored, anchorEl: H - num(e.anchorDepth, 1.5),
      anchorAngleDeg: num(e.anchorAngle, 20), anchorFixedLen: num(e.fixedLen, 5), anchorDia: num(e.anchorDia, 0.15),
      anchorSpacing: num(e.anchorSpacing, soldier ? num(rw.soldier.spacing, 1) : 2), anchorTfk: num(e.anchorTfk, 150), anchorGammaA: num(e.anchorGammaA, 1.1),
      pileWidth, spacing: num(rw.soldier.spacing, 1.0), effectiveWidthFactor: num(rw.soldier.effectiveWidthFactor, 3),
      laggingWatertight: !!rw.soldier.laggingWatertight, rowCap: rw.soldier.rowCap !== false
    },
    retained: strata, front: strata,
    water,
    loads: { surcharge: num(rw.surcharge, 0), surchargePermanent: num(rw.loads?.surchargePermanent, 0), berm },
    settings: {
      deltaPassiveRatio: soldier ? num(s.deltaPassiveSoldier, 0) : num(s.deltaPassiveSheet, 0.667),
      assumeCrackWater: !!s.assumeCrackWater,
      surchargeFloor: num(s.surchargeFloor, 0),
      riskScheme: num(s.riskScheme, 2), consequenceClass: num(s.consequenceClass, 2),
      overdigRule: s.overdigRule || 'belgian', overdigCustom: num(s.overdigCustom, 0.30),
      alphaVer: num(s.alphaVer, 1.10), effectFactorBGT: 1.35, da11Mode: s.da11Mode === 'single-source' ? 'single-source' : 'separate',
      resistanceModel: rw.soldier.resistanceModel === 'brinch-hansen' ? 'brinch-hansen' : 'effective-width'
    }
  };
  if (mo.enabled) request.settings.materialOverride = { gPhi: num(mo.gPhi, 1.30), gC: num(mo.gC, 1.30), gCu: num(mo.gCu, 1.40), applyToDA12: !!mo.applyToDA12 };
  return { request, profile, section: sec };
}

export function buildRequest(rw, layers) {
  return isEmbedded(rw.wallType) ? buildEmbeddedRequest(rw, layers) : buildGravityRequest(rw, layers);
}
