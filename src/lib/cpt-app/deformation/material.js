// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

export const NU_MIN = -0.99;
export const NU_MAX = 0.49;

function pushUniqueWarning(warnings, message) {
  if (!Array.isArray(warnings) || !message) return;
  if (!warnings.includes(message)) warnings.push(message);
}

function fallbackK0(phiEffDeg) {
  const phi = (Math.max(Number(phiEffDeg) || 0, 0) * Math.PI) / 180;
  return Math.max(1 - Math.sin(phi), 0);
}

function finiteOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function elasticLameParameters(EInput, nuInput, warnings = [], label = 'Material') {
  const E = Math.max(Number(EInput) || 0, 1);
  const nuRaw = Number.isFinite(Number(nuInput)) ? Number(nuInput) : 0.3;
  const nu = Math.max(Math.min(nuRaw, NU_MAX), NU_MIN);
  if (nuRaw > NU_MAX + 1e-12) {
    pushUniqueWarning(
      warnings,
      `${label}: Poisson ratio was capped to ${NU_MAX.toFixed(2)} for numerical stability in the T3 plane-strain solver.`
    );
  }
  const G = E / (2 * (1 + nu));
  const K = E / (3 * (1 - 2 * nu));
  const lambda = K - (2 * G) / 3;
  return { E, nu, G, K, lambda };
}

export function prepareMechanicalMaterial(material, warnings = []) {
  const label = material?.label || material?.id || 'Material';
  const rawE = Number(material?.Emc);
  const Emc = Math.max(Number.isFinite(rawE) && rawE > 0 ? rawE : 1000, 1);
  if (!(rawE > 0)) {
    pushUniqueWarning(warnings, `${label}: missing or non-positive Emc was replaced with 1000 kPa for the deformation screen.`);
  }

  const rawNu = Number(material?.nu);
  const nuInput = Number.isFinite(rawNu) ? rawNu : 0.3;
  const nu = Math.max(Math.min(nuInput, NU_MAX), NU_MIN);
  if (nuInput > NU_MAX + 1e-12) {
    pushUniqueWarning(
      warnings,
      `${label}: Poisson ratio was capped to ${NU_MAX.toFixed(2)} for numerical stability in the T3 plane-strain solver.`
    );
  }

  const rawYieldTolerance = finiteOrNull(material?.yieldTolerance);
  const rawYieldToleranceScale = finiteOrNull(material?.yieldToleranceScale);
  const rawYieldTolerancePref = finiteOrNull(material?.yieldTolerancePref);

  return {
    ...material,
    Emc,
    nu,
    nuInput,
    cEff: Math.max(Number(material?.cEff) || 0, 0),
    phiEffDeg: Math.max(Number(material?.phiEffDeg) || 0, 0),
    psiEffDeg: Math.max(Number(material?.psiEffDeg ?? material?.psi) || 0, 0),
    gamma: Math.max(Number(material?.gamma) || 18, 0),
    gammaSat: Math.max(Number(material?.gammaSat) || Number(material?.gamma) || 20, 0),
    K0nc: Number.isFinite(Number(material?.K0nc)) ? Math.max(Number(material.K0nc), 0) : fallbackK0(material?.phiEffDeg),
    sigmaTAllow: Math.max(Number(material?.sigmaTAllow) || 0, 0),
    sigmaY: Math.max(Number(material?.sigmaY) || 0, 0),
    rShear: Math.min(Math.max(Number(material?.rShear) || 0.25, 1e-3), 1),
    yieldTolerance: rawYieldTolerance !== null ? Math.max(rawYieldTolerance, 0) : null,
    yieldToleranceScale: rawYieldToleranceScale !== null ? Math.max(rawYieldToleranceScale, 0) : 1e-8,
    yieldTolerancePref: rawYieldTolerancePref !== null ? Math.max(rawYieldTolerancePref, 1e-6) : 100,
    localTolerance: Math.max(Number(material?.localTolerance) || 1e-8, 0),
    localMaxIterations: Math.max(Math.round(Number(material?.localMaxIterations) || 25), 1),
    useTensionCutoff: material?.useTensionCutoff !== false,
    useCompressionYield: material?.useCompressionYield === true
  };
}

export function planeStrainElasticMatrix(EInput, nuInput, warnings = [], label = 'Material') {
  const { E, nu } = elasticLameParameters(EInput, nuInput, warnings, label);
  const factor = E / ((1 + nu) * (1 - 2 * nu));
  return [
    [factor * (1 - nu), factor * nu, 0],
    [factor * nu, factor * (1 - nu), 0],
    [0, 0, factor * ((1 - 2 * nu) / 2)]
  ];
}

export function elasticMatrix6x6(EInput, nuInput, warnings = [], label = 'Material') {
  const { lambda, G } = elasticLameParameters(EInput, nuInput, warnings, label);
  return elasticMatrix6x6FromBulkShear(lambda + (2 * G) / 3, G);
}

export function elasticMatrix6x6FromBulkShear(KInput, GInput) {
  const K = Math.max(Number(KInput) || 0, 1e-9);
  const G = Math.max(Number(GInput) || 0, 1e-9);
  const lambda = K - (2 * G) / 3;
  return [
    [lambda + 2 * G, lambda, lambda, 0, 0, 0],
    [lambda, lambda + 2 * G, lambda, 0, 0, 0],
    [lambda, lambda, lambda + 2 * G, 0, 0, 0],
    [0, 0, 0, G, 0, 0],
    [0, 0, 0, 0, G, 0],
    [0, 0, 0, 0, 0, G]
  ];
}
