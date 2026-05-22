// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

export const NU_MIN = -0.99;
export const NU_MAX = 0.49;
const MC_ANGLE_MAX_DEG = 89.5;

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

function clampMcAngle(angleDeg) {
  return Math.max(Math.min(Number(angleDeg) || 0, MC_ANGLE_MAX_DEG), 0);
}

function selectorEnabled(value) {
  if (value === true) return true;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0.5;
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
  const rawEdgeStressGapTolerance = finiteOrNull(material?.edgeStressGapTolerance);
  const rawApexStressGapTolerance = finiteOrNull(material?.apexStressGapTolerance);
  const rawComplementarityTolerance = finiteOrNull(material?.activeSetComplementarityTolerance);
  const rawEigenSubspaceTolerance = finiteOrNull(material?.eigenSubspaceTolerance);
  const hsSource = material?.hs && typeof material.hs === 'object' ? material.hs : {};
  const hasHsConsistentTangent = Object.prototype.hasOwnProperty.call(hsSource, 'useConsistentTangent');
  const hsConsistentTangent = selectorEnabled(
    hasHsConsistentTangent ? hsSource.useConsistentTangent : material?.useConsistentTangent
  );
  const sharedConsistentTangent = selectorEnabled(material?.useConsistentTangent ?? material?.mc?.useConsistentTangent);
  // HS stiffness fields (E50_ref / Eoed_ref / Eur_ref / m / ν_ur / K0_nc)
  // live on the material top-level — inherited from the upstream layer
  // classification (CUR 2003-7).  The HS sub-block holds only the
  // HS-specific R_f / OCR / p_ref / e_init / e_max / σ3,min. Material top-level
  // wins; we keep the hs.* fallback so older fixtures and verifiers that
  // populate the legacy hs.E50_ref shape still resolve correctly.
  const hsValue = (name, fallback = 0) => {
    const numeric = Number(material?.[name] ?? hsSource[name]);
    return Number.isFinite(numeric) ? numeric : fallback;
  };
  const hsE50Ref = Math.max(hsValue('E50_ref', Emc), 1);
  const hsEoedRef = Math.max(hsValue('Eoed_ref', hsE50Ref), 1);
  const hsEurRef = Math.max(hsValue('Eur_ref', Math.max(3 * hsE50Ref, hsE50Ref)), 1);

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
    hs: {
      E50_ref: hsE50Ref,
      Eoed_ref: hsEoedRef,
      Eur_ref: hsEurRef,
      m: Math.min(Math.max(hsValue('m', 0.5), 0), 1),
      nu_ur: Math.min(Math.max(hsValue('nu_ur', 0.2), NU_MIN), NU_MAX),
      p_ref: Math.max(hsValue('p_ref', 100), 1e-6),
      Rf: Math.min(Math.max(hsValue('Rf', 0.9), 1e-6), 0.999999),
      K0_nc: Math.max(hsValue('K0_nc', Number.isFinite(Number(material?.K0nc)) ? Number(material.K0nc) : 0), 0),
      e_init: hsValue('e_init', -1),
      e_max: hsValue('e_max', -1),
      OCR: Math.max(hsValue('OCR', 1), 1e-6),
      nearSurfaceMinConfiningStress: Math.max(hsValue(
        'nearSurfaceMinConfiningStress',
        Number.isFinite(Number(material?.nearSurfaceMinConfiningStress))
          ? Number(material.nearSurfaceMinConfiningStress)
          : hsValue('reserved', 0)
      ), 0),
      useConsistentTangent: hsConsistentTangent
    },
    yieldTolerance: rawYieldTolerance !== null ? Math.max(rawYieldTolerance, 0) : null,
    yieldToleranceScale: rawYieldToleranceScale !== null ? Math.max(rawYieldToleranceScale, 0) : 1e-8,
    yieldTolerancePref: rawYieldTolerancePref !== null ? Math.max(rawYieldTolerancePref, 1e-6) : 100,
    localTolerance: Math.max(Number(material?.localTolerance) || 1e-8, 0),
    localMaxIterations: Math.max(Math.round(Number(material?.localMaxIterations) || 40), 1),
    eigTolerance: Math.max(Number(material?.eigTolerance) || 1e-9, 1e-12),
    edgeStressGapTolerance: rawEdgeStressGapTolerance !== null ? Math.max(rawEdgeStressGapTolerance, 0) : null,
    apexStressGapTolerance: rawApexStressGapTolerance !== null ? Math.max(rawApexStressGapTolerance, 0) : null,
    activeSetComplementarityTolerance: rawComplementarityTolerance !== null ? Math.max(rawComplementarityTolerance, 0) : null,
    eigenSubspaceTolerance: rawEigenSubspaceTolerance !== null ? Math.max(rawEigenSubspaceTolerance, 1e-12) : null,
    allowFormalApexBranch: material?.allowFormalApexBranch === true,
    // Off by default: applying a hydrostatic preload is materially
    // equivalent to apparent cohesion and is therefore an engineer-
    // controlled knob, not a silent default.
    nearSurfaceMinConfiningStress: Math.max(
      Number.isFinite(Number(material?.nearSurfaceMinConfiningStress))
        ? Number(material.nearSurfaceMinConfiningStress)
        : hsValue('nearSurfaceMinConfiningStress', hsValue('reserved', 0)),
      0
    ),
    representativeBasisPolicy: typeof material?.representativeBasisPolicy === 'string' && material.representativeBasisPolicy
      ? material.representativeBasisPolicy
      : 'committed-trial-canonical',
    // The exact non-associated Stage 2 multisurface tangent is generally
    // unsymmetric. Preserve that by default unless the user explicitly asks
    // for a symmetrized approximation.
    symmetrizeEpTangent: material?.symmetrizeEpTangent === true,
    // Shared HS/MC Simo-Hughes-equivalent tangent selector. MC defaults
    // OFF; the maintainer can flip this one JS-side field after validation.
    useConsistentTangent: sharedConsistentTangent,
    useTensionCutoff: material?.useTensionCutoff !== false,
    useCompressionYield: material?.useCompressionYield === true
  };
}

export function reduceMaterialStrengthForSafety(materialParameters, sigmaMsfInput = 1) {
  const base = materialParameters && typeof materialParameters === 'object'
    ? materialParameters
    : {};
  const sigmaMsf = Math.max(Number(sigmaMsfInput) || 1, 1);
  const phiBaseDeg = clampMcAngle(base?.phiEffDeg);
  const psiBaseDeg = clampMcAngle(base?.psiEffDeg ?? base?.psi);
  const phiBaseRad = (phiBaseDeg * Math.PI) / 180;
  const psiBaseRad = (psiBaseDeg * Math.PI) / 180;
  const tanPhiReduced = Math.tan(phiBaseRad) / sigmaMsf;
  const tanPsiReduced = Math.tan(psiBaseRad) / sigmaMsf;
  const phiReducedDeg = (Math.atan(Math.max(tanPhiReduced, 0)) * 180) / Math.PI;
  const psiReducedUnclampedDeg = (Math.atan(Math.max(tanPsiReduced, 0)) * 180) / Math.PI;
  const psiReducedDeg = Math.min(phiReducedDeg, psiReducedUnclampedDeg);
  const cohesionBase = Math.max(Number(base?.cEff) || 0, 0);
  const sigmaTAllowBaseRaw = Math.max(Number(base?.sigmaTAllow) || 0, 0);
  const phiTangentBase = Math.tan(phiBaseRad);
  const sigmaTAllowCap = phiTangentBase > 1e-12
    ? cohesionBase / phiTangentBase
    : Number.POSITIVE_INFINITY;
  const sigmaTAllowBase = Math.min(sigmaTAllowBaseRaw, sigmaTAllowCap);
  return {
    ...base,
    cEff: cohesionBase / sigmaMsf,
    phiEffDeg: phiReducedDeg,
    psiEffDeg: psiReducedDeg,
    sigmaTAllow: Number.isFinite(sigmaTAllowBase) ? (sigmaTAllowBase / sigmaMsf) : sigmaTAllowBaseRaw,
    safetyStrengthReductionFactor: sigmaMsf,
    safetyBaseCohesion: cohesionBase,
    safetyBasePhiEffDeg: phiBaseDeg,
    safetyBasePsiEffDeg: psiBaseDeg,
    safetyBaseSigmaTAllow: sigmaTAllowBase
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
