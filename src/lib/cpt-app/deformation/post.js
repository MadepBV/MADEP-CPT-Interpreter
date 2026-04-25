// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { probeVerticalRegionStack } from '../soil-regions.js';
import { sampleSeepagePorePressure } from '../seepage/solver.js';
import { terrainY } from '../stage6-bishop.js';

const GAMMA_W = 9.81;
const GEOM_EPS = 1e-6;

function pushUniqueWarning(warnings, message) {
  if (!Array.isArray(warnings) || !message) return;
  if (!warnings.includes(message)) warnings.push(message);
}

export function modelHasSteepSlopeOrWalls(model) {
  if ((model?.walls || []).length) return true;
  const terrain = model?.terrain?.vertices || [];
  for (let i = 0; i < terrain.length - 1; i += 1) {
    const dx = terrain[i + 1].x - terrain[i].x;
    const dy = terrain[i + 1].y - terrain[i].y;
    if (!(Math.abs(dx) > GEOM_EPS)) return true;
    const angleDeg = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
    if (angleDeg >= 15) return true;
  }
  return false;
}

export function hydrostaticPorePressureFromPhreatic(model, x, y, gammaW = GAMMA_W) {
  if (!model?.phreatic?.vertices?.length || model.phreatic.vertices.length < 2) return 0;
  const waterY = terrainY(model.phreatic, x);
  if (!Number.isFinite(waterY)) return 0;
  return Math.max((waterY - y) * gammaW, 0);
}

export function sampleInitialPorePressure(model, x, y, options = {}, warnings = [], gammaW = GAMMA_W) {
  const useSeepage = !!options?.useSeepagePorePressures && model?.seepage?.mesh && model?.seepage?.result;
  if (useSeepage) {
    const sampled = sampleSeepagePorePressure(model.seepage.mesh, model.seepage.result, x, y, gammaW);
    if (Number.isFinite(sampled)) return Math.max(sampled, 0);
    pushUniqueWarning(
      warnings,
      'FEM pore pressure sampling missed part of the deformation mesh, so hydrostatic phreatic pressure was used there instead.'
    );
    return hydrostaticPorePressureFromPhreatic(model, x, y, gammaW);
  }
  if (options?.useSeepagePorePressures) {
    pushUniqueWarning(
      warnings,
      'Use seepage pore pressures was requested, but no seepage result was available. The deformation screen fell back to the drawn hydrostatic phreatic line.'
    );
  }
  return hydrostaticPorePressureFromPhreatic(model, x, y, gammaW);
}

export function initialBulkUnitWeightFromPorePressure(material, porePressure) {
  const gammaDry = Number.isFinite(Number(material?.gamma)) ? Number(material.gamma) : 18;
  const gammaSat = Number.isFinite(Number(material?.gammaSat)) ? Number(material.gammaSat) : gammaDry + 2;
  return Number(porePressure) > GEOM_EPS ? gammaSat : gammaDry;
}

export function verticalOverburdenStressAt(model, x, y) {
  if (!model?.terrain?.vertices?.length) return 0;
  const surfaceY = terrainY(model.terrain, x);
  if (!Number.isFinite(surfaceY) || y >= surfaceY - GEOM_EPS) return 0;
  const waterY = model?.phreatic?.vertices?.length ? terrainY(model.phreatic, x) : null;
  const segments = probeVerticalRegionStack(model.regions, x, y, surfaceY, waterY);
  return segments.reduce(
    (sum, segment) => sum + (Math.max(segment.yTop - segment.yBottom, 0) * (Number(segment.gamma) || 0)),
    0
  );
}

export function initialEffectiveStress6AtPoint(model, point, options, warnings) {
  const material = model?.regions?.[point.regionIndex]?.material || point.material || null;
  const sigmaV0 = verticalOverburdenStressAt(model, point.x, point.y);
  const u0 = sampleInitialPorePressure(model, point.x, point.y, options, warnings, GAMMA_W);
  const sigmaV0Eff = Math.max(sigmaV0 - u0, 0);
  const phi = (Math.max(Number(material?.phiEffDeg) || 0, 0) * Math.PI) / 180;
  const K0 = Number.isFinite(Number(material?.K0nc)) ? Math.max(Number(material.K0nc), 0) : Math.max(1 - Math.sin(phi), 0);
  const sigmaH0Eff = K0 * sigmaV0Eff;
  return [
    -sigmaH0Eff,
    -sigmaV0Eff,
    -sigmaH0Eff,
    0,
    0,
    0
  ];
}

export function buildFlatK0InitialEffectiveStressField(mesh, model, options = {}, warnings = []) {
  if (modelHasSteepSlopeOrWalls(model)) {
    pushUniqueWarning(
      warnings,
      'Initial stress uses flat-ground K0 initialization with zero initial shear stress; results near steep slopes, embankments, or retaining walls may be unconservative.'
    );
  }
  return mesh.elementData.map((elementData, elementIndex) => {
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    return initialEffectiveStress6AtPoint(
      model,
      {
        x: elementData?.centroid?.x ?? cell?.centroid?.x ?? 0,
        y: elementData?.centroid?.y ?? cell?.centroid?.y ?? 0,
        regionIndex: cell?.regionIndex ?? -1,
        material: cell?.material || null
      },
      options,
      warnings
    );
  });
}

export function buildFlatK0InitialEffectiveStressFieldAtPoints(points, model, options = {}, warnings = []) {
  if (modelHasSteepSlopeOrWalls(model)) {
    pushUniqueWarning(
      warnings,
      'Initial stress uses flat-ground K0 initialization with zero initial shear stress; results near steep slopes, embankments, or retaining walls may be unconservative.'
    );
  }
  return (points || []).map((point) => initialEffectiveStress6AtPoint(model, point, options, warnings));
}

export function buildInitialEffectiveStressField(mesh, model, options = {}, warnings = []) {
  return buildFlatK0InitialEffectiveStressField(mesh, model, options, warnings);
}

export function negateNormalAndShear(stress) {
  return {
    sxx: -(Number(stress?.sxx) || 0),
    syy: -(Number(stress?.syy) || 0),
    txy: -(Number(stress?.txy) || 0)
  };
}

export function addStress(left, right) {
  return {
    sxx: (Number(left?.sxx) || 0) + (Number(right?.sxx) || 0),
    syy: (Number(left?.syy) || 0) + (Number(right?.syy) || 0),
    txy: (Number(left?.txy) || 0) + (Number(right?.txy) || 0)
  };
}

export function principalStress2DCompressionPositive(stress) {
  const sxx = Number(stress?.sxx) || 0;
  const syy = Number(stress?.syy) || 0;
  const txy = Number(stress?.txy) || 0;
  const p = 0.5 * (sxx + syy);
  const r = Math.hypot(0.5 * (sxx - syy), txy);
  return {
    s1: p + r,
    s3: p - r,
    mean: p,
    radius: r
  };
}

export function mohrCoulombIndicator(principal, material) {
  const phi = ((Math.max(Number(material?.phiEffDeg) || 0, 0) * Math.PI) / 180);
  const c = Math.max(Number(material?.cEff) || 0, 0);
  const s1 = Number(principal?.s1) || 0;
  const s3 = Number(principal?.s3) || 0;
  const tanPhi = Math.tan(phi);
  const sigmaTRaw = Math.max(Number(material?.sigmaTAllow) || 0, 0);
  const sigmaTAllow = Math.min(sigmaTRaw, Math.abs(tanPhi) > 1e-12 ? Math.max(c / tanPhi, 0) : Number.POSITIVE_INFINITY);
  const tensionTolerance = Number.isFinite(Number(material?.yieldTolerance)) && Number(material?.yieldTolerance) > 0
    ? Number(material.yieldTolerance)
    : Math.max(1e-8 * Math.max(Math.abs(s1), Math.abs(s3), c, 100), 1e-9);

  if (s3 <= -sigmaTAllow + tensionTolerance) {
    return {
      F: Number.POSITIVE_INFINITY,
      eta: Number.POSITIVE_INFINITY,
      state: 'tension-cutoff'
    };
  }

  const rawDenom = (s1 + s3) * Math.sin(phi) + 2 * c * Math.cos(phi);
  const denom = Math.max(rawDenom, 1e-6);
  const F = (s1 - s3) - (s1 + s3) * Math.sin(phi) - 2 * c * Math.cos(phi);
  const eta = (s1 - s3) / denom;

  return {
    F,
    eta,
    state: eta >= 1 ? 'mc-yield' : 'elastic'
  };
}
