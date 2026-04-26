// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { terrainY } from '../stage6-bishop.js';
import {
  effectiveStress6ToCompressionPositiveStress2D,
  mohrCoulombIndicator3D
} from './material-models.js';

const DEFAULT_DEPTH_BANDS = [
  { label: '0.00-0.25 m', min: 0, max: 0.25 },
  { label: '0.25-0.50 m', min: 0.25, max: 0.50 },
  { label: '0.50-1.00 m', min: 0.50, max: 1.00 },
  { label: '1.00-2.00 m', min: 1.00, max: 2.00 },
  { label: '2.00-4.00 m', min: 2.00, max: 4.00 },
  { label: '4.00-8.00 m', min: 4.00, max: 8.00 },
  { label: '> 8.00 m', min: 8.00, max: Number.POSITIVE_INFINITY }
];

function quantile(sortedValues, q) {
  if (!sortedValues.length) return 0;
  const clamped = Math.max(0, Math.min(Number(q) || 0, 1));
  const position = clamped * (sortedValues.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const t = position - lower;
  return sortedValues[lower] + t * (sortedValues[upper] - sortedValues[lower]);
}

function depthBelowTerrain(model, point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !model?.terrain?.vertices?.length) {
    return Number.POSITIVE_INFINITY;
  }
  const surfaceY = terrainY(model.terrain, x);
  return Number.isFinite(surfaceY) ? Math.max(surfaceY - y, 0) : Number.POSITIVE_INFINITY;
}

function bandIndexForDepth(depth, bands) {
  for (let index = 0; index < bands.length; index += 1) {
    if (depth <= bands[index].max) return index;
  }
  return bands.length - 1;
}

function integrationPointLookup(elementCaches) {
  const lookup = [];
  (elementCaches || []).forEach((elementCache) => {
    (elementCache.integrationPoints || []).forEach((gp) => {
      lookup[gp.globalIndex] = {
        x: Number(gp.x) || 0,
        y: Number(gp.y) || 0,
        elementIndex: elementCache.elementIndex,
        gpIndex: gp.gpIndex
      };
    });
  });
  return lookup;
}

function stateForDiagnostic(materialPoint) {
  return materialPoint?.trialState
    || materialPoint?.committedState
    || materialPoint?.referenceState
    || materialPoint?.predictorState
    || null;
}

function isTensionActive(state, mc) {
  const surface = String(state?.activeYieldSurface || state?.diagnosticYieldSurface || '');
  return mc?.tensionViolation === true
    || mc?.state === 'tension-cutoff'
    || surface === 'TENSION';
}

function isPlasticActive(state, diagnostics, mc, tolerance) {
  const surface = String(state?.activeYieldSurface || state?.diagnosticYieldSurface || diagnostics?.activeYieldSurface || '');
  if (state?.currentlyMcActive === true || diagnostics?.currentlyMcActive === true) return true;
  if (surface === 'MC_FACE' || surface === 'MC_EDGE' || surface === 'MC_APEX' || surface === 'MC_SHEAR') return true;
  return mc?.state === 'mc-yield' && (Number(mc?.F) || 0) > tolerance;
}

function tauOverStrength(stress6, materialParameters) {
  const stress = effectiveStress6ToCompressionPositiveStress2D(stress6);
  const tau = Math.abs(Number(stress?.txy) || 0);
  const sigmaN = Math.max(0, 0.5 * ((Number(stress?.sxx) || 0) + (Number(stress?.syy) || 0)));
  const c = Math.max(Number(materialParameters?.cEff ?? materialParameters?.cPrime ?? materialParameters?.c) || 0, 0);
  const phiDeg = Number(materialParameters?.phiEffDeg ?? materialParameters?.phiDeg ?? materialParameters?.phi);
  const phi = (Number.isFinite(phiDeg) ? phiDeg : 0) * Math.PI / 180;
  const strength = Math.max(c + sigmaN * Math.tan(phi), 1e-9);
  return tau / strength;
}

function initializeBands(bands) {
  return bands.map((band) => ({
    label: band.label,
    zMin: band.min,
    zMax: band.max,
    count: 0,
    plastic: 0,
    tension: 0,
    mcYield: 0,
    etaMax: 0,
    tauOverStrength: {
      p50: 0,
      p95: 0,
      max: 0
    },
    _tauValues: []
  }));
}

function stripWorkingFields(reportBands) {
  return reportBands.map((band) => {
    const tauValues = band._tauValues || [];
    tauValues.sort((a, b) => a - b);
    return {
      label: band.label,
      zMin: band.zMin,
      zMax: band.zMax,
      count: band.count,
      plastic: band.plastic,
      tension: band.tension,
      mcYield: band.mcYield,
      plasticFraction: band.count > 0 ? band.plastic / band.count : 0,
      tensionFraction: band.count > 0 ? band.tension / band.count : 0,
      etaMax: band.etaMax,
      tauOverStrength: {
        p50: quantile(tauValues, 0.50),
        p95: quantile(tauValues, 0.95),
        max: tauValues.length ? tauValues[tauValues.length - 1] : 0
      }
    };
  });
}

function chooseDominantBand(bands) {
  let best = null;
  for (const band of bands) {
    if (!band || band.count <= 0) continue;
    const score = 4 * (Number(band.plasticFraction) || 0)
      + 3 * (Number(band.tensionFraction) || 0)
      + Math.min(Number(band.tauOverStrength?.p95) || 0, 2)
      + 0.01 * (Number(band.plastic) || 0);
    if (!best || score > best.score) best = { ...band, score };
  }
  return best;
}

export function computeDepthBandReport(mesh, materialPoints, model, elementCaches, options = {}) {
  const configuredBands = Array.isArray(options?.depthBands) && options.depthBands.length
    ? options.depthBands
    : DEFAULT_DEPTH_BANDS;
  const bands = initializeBands(configuredBands);
  const gpLookup = integrationPointLookup(elementCaches);
  let totalCount = 0;
  let plasticCount = 0;
  let tensionCount = 0;
  let mcYieldCount = 0;
  let maxEta = 0;
  let maxTauOverStrength = 0;

  (materialPoints || []).forEach((materialPoint, pointIndex) => {
    if (!materialPoint) return;
    const state = stateForDiagnostic(materialPoint);
    const stress6 = state?.effectiveStress6;
    if (!Array.isArray(stress6) || stress6.length < 6) return;
    const point = gpLookup[materialPoint.integrationPointIndex ?? pointIndex] || gpLookup[pointIndex] || null;
    const depth = depthBelowTerrain(model, point);
    const band = bands[bandIndexForDepth(depth, configuredBands)];
    if (!band) return;
    const mc = mohrCoulombIndicator3D(stress6, materialPoint.materialParameters);
    const tolerance = Math.max(Number(materialPoint.materialParameters?.yieldTolerance) || 0, 1e-8);
    const plastic = isPlasticActive(state, materialPoint.diagnostics, mc, tolerance);
    const tension = isTensionActive(state, mc);
    const yielded = mc?.state === 'mc-yield' || plastic;
    const eta = Number.isFinite(Number(mc?.eta)) ? Math.max(Number(mc.eta), 0) : Number.POSITIVE_INFINITY;
    const tauRatio = tauOverStrength(stress6, materialPoint.materialParameters);

    totalCount += 1;
    band.count += 1;
    if (plastic) {
      plasticCount += 1;
      band.plastic += 1;
    }
    if (tension) {
      tensionCount += 1;
      band.tension += 1;
    }
    if (yielded) {
      mcYieldCount += 1;
      band.mcYield += 1;
    }
    maxEta = Math.max(maxEta, eta);
    maxTauOverStrength = Math.max(maxTauOverStrength, tauRatio);
    band.etaMax = Math.max(band.etaMax, eta);
    band._tauValues.push(tauRatio);
  });

  const depthBands = stripWorkingFields(bands);
  const dominantBand = chooseDominantBand(depthBands);
  const shallowBands = depthBands.filter((band) => Number(band.zMax) <= 1);
  const shallowPlasticCount = shallowBands.reduce((sum, band) => sum + (Number(band.plastic) || 0), 0);
  const shallowTensionCount = shallowBands.reduce((sum, band) => sum + (Number(band.tension) || 0), 0);

  return {
    depthBands,
    dominantBand,
    totalCount,
    plasticCount,
    tensionCount,
    mcYieldCount,
    shallowPlasticCount,
    shallowTensionCount,
    maxEta,
    maxTauOverStrength
  };
}

export { DEFAULT_DEPTH_BANDS };
