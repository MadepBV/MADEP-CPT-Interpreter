// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { elasticLameParameters, elasticMatrix6x6, elasticMatrix6x6FromBulkShear } from './material.js';
import { negateNormalAndShear } from './post.js';

const VOIGT_XX = 0;
const VOIGT_YY = 1;
const VOIGT_ZZ = 2;
const VOIGT_XY = 3;
const VOIGT_YZ = 4;
const VOIGT_XZ = 5;

export const YIELD_SURFACE_NONE = 'NONE';
export const YIELD_SURFACE_MC_SHEAR = 'MC_SHEAR';
export const YIELD_SURFACE_TENSION = 'TENSION';
export const YIELD_SURFACE_COMPRESSION_CAP = 'COMPRESSION_CAP';

function zeroVector6() {
  return [0, 0, 0, 0, 0, 0];
}

function cloneVector6(vector) {
  const source = Array.isArray(vector) || ArrayBuffer.isView(vector) ? vector : zeroVector6();
  return [
    Number(source[0]) || 0,
    Number(source[1]) || 0,
    Number(source[2]) || 0,
    Number(source[3]) || 0,
    Number(source[4]) || 0,
    Number(source[5]) || 0
  ];
}

function cloneMatrix6(matrix) {
  if (!Array.isArray(matrix)) {
    return Array.from({ length: 6 }, () => zeroVector6());
  }
  return Array.from({ length: 6 }, (_item, rowIndex) => cloneVector6(matrix[rowIndex]));
}

function addVector6(left, right) {
  return [
    (Number(left?.[0]) || 0) + (Number(right?.[0]) || 0),
    (Number(left?.[1]) || 0) + (Number(right?.[1]) || 0),
    (Number(left?.[2]) || 0) + (Number(right?.[2]) || 0),
    (Number(left?.[3]) || 0) + (Number(right?.[3]) || 0),
    (Number(left?.[4]) || 0) + (Number(right?.[4]) || 0),
    (Number(left?.[5]) || 0) + (Number(right?.[5]) || 0)
  ];
}

function scaleVector6(vector, factor) {
  return [
    (Number(vector?.[0]) || 0) * factor,
    (Number(vector?.[1]) || 0) * factor,
    (Number(vector?.[2]) || 0) * factor,
    (Number(vector?.[3]) || 0) * factor,
    (Number(vector?.[4]) || 0) * factor,
    (Number(vector?.[5]) || 0) * factor
  ];
}

function subtractVector6(left, right) {
  return [
    (Number(left?.[0]) || 0) - (Number(right?.[0]) || 0),
    (Number(left?.[1]) || 0) - (Number(right?.[1]) || 0),
    (Number(left?.[2]) || 0) - (Number(right?.[2]) || 0),
    (Number(left?.[3]) || 0) - (Number(right?.[3]) || 0),
    (Number(left?.[4]) || 0) - (Number(right?.[4]) || 0),
    (Number(left?.[5]) || 0) - (Number(right?.[5]) || 0)
  ];
}

function addPorePressureToNormalComponents(stress6, porePressure) {
  const u0 = Math.max(Number(porePressure) || 0, 0);
  const base = cloneVector6(stress6);
  base[VOIGT_XX] += u0;
  base[VOIGT_YY] += u0;
  base[VOIGT_ZZ] += u0;
  return base;
}

function descendingNumeric(left, right) {
  return right - left;
}

function multiplyMatrix6x6Vector6(matrix, vector) {
  const out = zeroVector6();
  for (let i = 0; i < 6; i += 1) {
    const row = matrix?.[i] || [];
    out[i] =
      (Number(row[0]) || 0) * (Number(vector?.[0]) || 0) +
      (Number(row[1]) || 0) * (Number(vector?.[1]) || 0) +
      (Number(row[2]) || 0) * (Number(vector?.[2]) || 0) +
      (Number(row[3]) || 0) * (Number(vector?.[3]) || 0) +
      (Number(row[4]) || 0) * (Number(vector?.[4]) || 0) +
      (Number(row[5]) || 0) * (Number(vector?.[5]) || 0);
  }
  return out;
}

function activeYieldSurfaceFromState(mc) {
  if (mc?.state === 'tension-cutoff') return YIELD_SURFACE_TENSION;
  if (mc?.state === 'mc-yield') return YIELD_SURFACE_MC_SHEAR;
  if (mc?.state === 'compression-cap') return YIELD_SURFACE_COMPRESSION_CAP;
  return YIELD_SURFACE_NONE;
}

function hasShearYieldExceedance(mc) {
  return mc?.state === 'mc-yield';
}

function resolveYieldTolerance(materialParameters, mcTrial) {
  const absolute = Number(materialParameters?.yieldTolerance);
  if (Number.isFinite(absolute) && absolute > 0) return absolute;

  const epsilonF = Math.max(Number(materialParameters?.yieldToleranceScale) || 1e-8, 0);
  const pRef = Math.max(Number(materialParameters?.yieldTolerancePref) || 100, 1e-6);
  const cEff = Math.max(Number(materialParameters?.cEff) || 0, 0);
  const stressScale = Math.max(
    cEff,
    Math.abs(Number(mcTrial?.s1) || 0),
    Math.abs(Number(mcTrial?.s3) || 0),
    pRef
  );
  return epsilonF * stressScale;
}

export function createMaterialPointState(overrides = {}) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    totalStrain6: cloneVector6(source.totalStrain6),
    plasticStrain6: cloneVector6(source.plasticStrain6),
    effectiveStress6: cloneVector6(source.effectiveStress6),
    activeYieldSurface: source.activeYieldSurface || YIELD_SURFACE_NONE,
    currentlyMcActive: source.currentlyMcActive === true,
    hasEverExceededMc: source.hasEverExceededMc === true,
    etaMcCurrent: Number(source.etaMcCurrent) || 0,
    etaMcMaxHistory: Number(source.etaMcMaxHistory) || 0,
    sigmaY: Math.max(Number(source.sigmaY) || 0, 0),
    hardeningVariable: Number(source.hardeningVariable) || 0,
    accumulatedPlasticStrain: Math.max(Number(source.accumulatedPlasticStrain) || 0, 0)
  };
}

export function cloneMaterialPointState(state = {}) {
  return createMaterialPointState(state);
}

export function liftPlaneStrainStrainTo6(strain2D) {
  return [
    Number(strain2D?.exx) || 0,
    Number(strain2D?.eyy) || 0,
    0,
    Number(strain2D?.gxy) || 0,
    0,
    0
  ];
}

export function extractStress2DFrom6(stress6) {
  return {
    sxx: Number(stress6?.[VOIGT_XX]) || 0,
    syy: Number(stress6?.[VOIGT_YY]) || 0,
    txy: Number(stress6?.[VOIGT_XY]) || 0
  };
}

export function extractTangent2DFrom6(tangent6x6) {
  return [
    [
      Number(tangent6x6?.[VOIGT_XX]?.[VOIGT_XX]) || 0,
      Number(tangent6x6?.[VOIGT_XX]?.[VOIGT_YY]) || 0,
      Number(tangent6x6?.[VOIGT_XX]?.[VOIGT_XY]) || 0
    ],
    [
      Number(tangent6x6?.[VOIGT_YY]?.[VOIGT_XX]) || 0,
      Number(tangent6x6?.[VOIGT_YY]?.[VOIGT_YY]) || 0,
      Number(tangent6x6?.[VOIGT_YY]?.[VOIGT_XY]) || 0
    ],
    [
      Number(tangent6x6?.[VOIGT_XY]?.[VOIGT_XX]) || 0,
      Number(tangent6x6?.[VOIGT_XY]?.[VOIGT_YY]) || 0,
      Number(tangent6x6?.[VOIGT_XY]?.[VOIGT_XY]) || 0
    ]
  ];
}

export function planeStrainCompressionPositiveStress2DToStress6(initialStress, nuInput = 0.3) {
  const sxxFe = -(Number(initialStress?.sxx) || 0);
  const syyFe = -(Number(initialStress?.syy) || 0);
  const txyFe = -(Number(initialStress?.txy) || 0);
  const nu = Number.isFinite(Number(nuInput)) ? Number(nuInput) : 0.3;
  return [
    sxxFe,
    syyFe,
    nu * (sxxFe + syyFe),
    txyFe,
    0,
    0
  ];
}

export function totalStress6ToEffectiveStress6(totalStress6, porePressure = 0) {
  return addPorePressureToNormalComponents(totalStress6, porePressure);
}

export function effectiveStress6ToCompressionPositiveStress2D(stress6) {
  return negateNormalAndShear(extractStress2DFrom6(stress6));
}

export function effectiveStress6ToCompressionPositiveStress3D(stress6) {
  return {
    sxx: -(Number(stress6?.[VOIGT_XX]) || 0),
    syy: -(Number(stress6?.[VOIGT_YY]) || 0),
    szz: -(Number(stress6?.[VOIGT_ZZ]) || 0),
    txy: -(Number(stress6?.[VOIGT_XY]) || 0)
  };
}

export function principalStress3DCompressionPositive(stress6) {
  const stress = effectiveStress6ToCompressionPositiveStress3D(stress6);
  const pxy = 0.5 * (stress.sxx + stress.syy);
  const rxy = Math.hypot(0.5 * (stress.sxx - stress.syy), stress.txy);
  const principals = [pxy + rxy, stress.szz, pxy - rxy].sort(descendingNumeric);
  return {
    s1: principals[0],
    s2: principals[1],
    s3: principals[2],
    planeMajor: pxy + rxy,
    planeMinor: pxy - rxy
  };
}

export function mohrCoulombIndicator3D(stress6, materialParameters) {
  const phi = (Math.max(Number(materialParameters?.phiEffDeg) || 0, 0) * Math.PI) / 180;
  const c = Math.max(Number(materialParameters?.cEff) || 0, 0);
  const sigmaTAllow = Math.max(Number(materialParameters?.sigmaTAllow) || 0, 0);
  const principal = principalStress3DCompressionPositive(stress6);
  const s1 = principal.s1;
  const s3 = principal.s3;

  if ((materialParameters?.useTensionCutoff !== false) && s3 < -sigmaTAllow) {
    return {
      F: Number.POSITIVE_INFINITY,
      eta: Number.POSITIVE_INFINITY,
      state: 'tension-cutoff',
      ...principal
    };
  }

  const rawDenom = (s1 + s3) * Math.sin(phi) + 2 * c * Math.cos(phi);
  const denom = Math.max(rawDenom, 1e-6);
  const F = (s1 - s3) - (s1 + s3) * Math.sin(phi) - 2 * c * Math.cos(phi);
  const eta = (s1 - s3) / denom;

  return {
    F,
    eta,
    state: eta >= 1 ? 'mc-yield' : 'elastic',
    ...principal
  };
}

export function evaluateMaterialPointDiagnosticsFromStress6(effectiveStress6, materialParameters, committedState = null, overrides = {}) {
  const effectiveStress2D = effectiveStress6ToCompressionPositiveStress2D(effectiveStress6);
  const effectiveStress3D = effectiveStress6ToCompressionPositiveStress3D(effectiveStress6);
  const mc = mohrCoulombIndicator3D(effectiveStress6, materialParameters);
  const activeYieldSurface = overrides.activeYieldSurface || activeYieldSurfaceFromState(mc);
  const currentlyMcActive = overrides.currentlyMcActive === true;
  const hasExceededNow = activeYieldSurface === YIELD_SURFACE_MC_SHEAR || hasShearYieldExceedance(mc);
  const hasEverExceededMc = overrides.hasEverExceededMc === true || committedState?.hasEverExceededMc === true || hasExceededNow;
  const etaMc = Number(mc?.eta);
  const etaMcCurrent = Number.isFinite(etaMc) ? etaMc : Number.POSITIVE_INFINITY;
  const previousEtaMax = Number(committedState?.etaMcMaxHistory);
  const etaMcMaxHistory = Number.isFinite(previousEtaMax)
    ? Math.max(previousEtaMax, etaMcCurrent)
    : etaMcCurrent;
  return {
    fMcTrial: Number(mc?.F) || 0,
    etaMcTrial: etaMcCurrent,
    fMcFinal: Number(mc?.F) || 0,
    etaMcFinal: etaMcCurrent,
    etaMcCurrent,
    etaMcMaxHistory,
    localStrengthReserve: etaMcCurrent > 1e-12 ? 1 / etaMcCurrent : Number.POSITIVE_INFINITY,
    currentlyMcActive,
    hasEverExceededMc,
    activeYieldSurface,
    stateChanged: overrides.stateChanged === true,
    principal: {
      s1: mc.s1,
      s2: mc.s2,
      s3: mc.s3
    },
    mc,
    effectiveStress2D,
    effectiveStress3D
  };
}

export function seedMaterialPointStateFromEffectiveStress6(initialEffectiveStress6, materialParameters) {
  const effectiveStress6 = cloneVector6(initialEffectiveStress6);
  const diagnostics = evaluateMaterialPointDiagnosticsFromStress6(effectiveStress6, materialParameters);
  return createMaterialPointState({
    effectiveStress6,
    activeYieldSurface: diagnostics.activeYieldSurface,
    currentlyMcActive: false,
    hasEverExceededMc: diagnostics.hasEverExceededMc,
    etaMcCurrent: diagnostics.etaMcFinal,
    etaMcMaxHistory: diagnostics.etaMcFinal,
    sigmaY: materialParameters?.sigmaY
  });
}

export function seedMaterialPointStateFromInitialStress(initialEffectiveStress2D, materialParameters) {
  const effectiveStress6 = planeStrainCompressionPositiveStress2DToStress6(initialEffectiveStress2D, materialParameters?.nu);
  return seedMaterialPointStateFromEffectiveStress6(effectiveStress6, materialParameters);
}

export function createMaterialPoint({ materialModel, materialParameters, committedState = null, elementIndex = -1, regionIndex = -1 } = {}) {
  const committed = cloneMaterialPointState(committedState);
  return {
    elementIndex,
    regionIndex,
    materialModel,
    materialParameters,
    referenceState: cloneMaterialPointState(committed),
    committedState: committed,
    trialState: cloneMaterialPointState(committed),
    diagnostics: null
  };
}

export function commitMaterialPoint(materialPoint) {
  if (!materialPoint) return null;
  materialPoint.committedState = cloneMaterialPointState(materialPoint.trialState);
  materialPoint.trialState = cloneMaterialPointState(materialPoint.committedState);
  return materialPoint.committedState;
}

export function snapshotMaterialPointState(state = {}) {
  const source = state && typeof state === 'object' ? state : {};
  return {
    totalStrain6: cloneVector6(source.totalStrain6),
    plasticStrain6: cloneVector6(source.plasticStrain6),
    effectiveStress6: cloneVector6(source.effectiveStress6),
    activeYieldSurface: source.activeYieldSurface || YIELD_SURFACE_NONE,
    currentlyMcActive: source.currentlyMcActive === true,
    hasEverExceededMc: source.hasEverExceededMc === true,
    etaMcCurrent: Number(source.etaMcCurrent) || 0,
    etaMcMaxHistory: Number(source.etaMcMaxHistory) || 0,
    sigmaY: Math.max(Number(source.sigmaY) || 0, 0),
    hardeningVariable: Number(source.hardeningVariable) || 0,
    accumulatedPlasticStrain: Math.max(Number(source.accumulatedPlasticStrain) || 0, 0)
  };
}

export function createLinearElasticMaterial(materialParameters, warnings = []) {
  const label = materialParameters?.label || materialParameters?.id || 'Material';
  const elasticTangent6x6 = elasticMatrix6x6(materialParameters?.Emc, materialParameters?.nu, warnings, label);
  return {
    kind: 'linear-elastic',
    materialParameters,
    elasticTangent6x6,
    initialTangent6x6: cloneMatrix6(elasticTangent6x6),
    update({ strainTrial6, committedState, materialParameters: paramsOverride, analysisContext = null } = {}) {
      const params = paramsOverride || materialParameters || {};
      const committed = cloneMaterialPointState(committedState);
      const nextStrain6 = cloneVector6(strainTrial6);
      const deltaStrain6 = subtractVector6(nextStrain6, committed.totalStrain6);
      const deltaStress6 = multiplyMatrix6x6Vector6(elasticTangent6x6, deltaStrain6);
      const stressTrial6 = addVector6(committed.effectiveStress6, deltaStress6);
      const diagnostics = evaluateMaterialPointDiagnosticsFromStress6(stressTrial6, params, committed, {
        currentlyMcActive: false,
        stateChanged: false
      });
      const trialState = createMaterialPointState({
        ...committed,
        totalStrain6: nextStrain6,
        effectiveStress6: stressTrial6,
        activeYieldSurface: diagnostics.activeYieldSurface,
        currentlyMcActive: false,
        hasEverExceededMc: diagnostics.hasEverExceededMc,
        etaMcCurrent: diagnostics.etaMcCurrent,
        etaMcMaxHistory: diagnostics.etaMcMaxHistory,
        sigmaY: params?.sigmaY
      });
      return {
        stressTrial6,
        tangent6x6: elasticTangent6x6,
        trialState,
        diagnostics: {
          ...diagnostics,
          constitutiveModel: 'linear-elastic',
          analysisContext
        }
      };
    }
  };
}

export function createMCReducedStiffnessMaterial(materialParameters, warnings = []) {
  const label = materialParameters?.label || materialParameters?.id || 'Material';
  const { K, G } = elasticLameParameters(materialParameters?.Emc, materialParameters?.nu, warnings, label);
  const elasticTangent6x6 = elasticMatrix6x6FromBulkShear(K, G);
  const reducedTangent6x6 = elasticMatrix6x6FromBulkShear(K, G * Math.min(Math.max(Number(materialParameters?.rShear) || 0.25, 1e-3), 1));
  return {
    kind: 'mc-reduced-stiffness',
    materialParameters,
    elasticTangent6x6,
    reducedTangent6x6,
    initialTangent6x6: cloneMatrix6(elasticTangent6x6),
    update({ strainTrial6, committedState, materialParameters: paramsOverride, analysisContext = null } = {}) {
      const params = paramsOverride || materialParameters || {};
      const committed = cloneMaterialPointState(committedState);
      const nextStrain6 = cloneVector6(strainTrial6);
      const deltaStrain6 = subtractVector6(nextStrain6, committed.totalStrain6);
      const elasticTrialStress6 = addVector6(committed.effectiveStress6, multiplyMatrix6x6Vector6(elasticTangent6x6, deltaStrain6));
      const mcTrial = mohrCoulombIndicator3D(elasticTrialStress6, params);
      const yieldTolerance = resolveYieldTolerance(params, mcTrial);
      const previousTrialActive = analysisContext?.previousTrialState?.currentlyMcActive === true;
      const retainedActive = committed.currentlyMcActive === true || previousTrialActive;
      const exceedsMcShear = hasShearYieldExceedance(mcTrial) && Number(mcTrial?.F) > yieldTolerance;
      const currentlyMcActive = retainedActive || exceedsMcShear;
      const tangent6x6 = currentlyMcActive ? reducedTangent6x6 : elasticTangent6x6;
      const stressTrial6 = currentlyMcActive
        ? addVector6(committed.effectiveStress6, multiplyMatrix6x6Vector6(reducedTangent6x6, deltaStrain6))
        : elasticTrialStress6;
      const finalMc = mohrCoulombIndicator3D(stressTrial6, params);
      const diagnostics = evaluateMaterialPointDiagnosticsFromStress6(stressTrial6, params, committed, {
        currentlyMcActive,
        activeYieldSurface: activeYieldSurfaceFromState(currentlyMcActive ? mcTrial : finalMc),
        hasEverExceededMc: committed.hasEverExceededMc || exceedsMcShear || hasShearYieldExceedance(finalMc),
        stateChanged: currentlyMcActive !== (committed.currentlyMcActive === true)
      });
      const trialState = createMaterialPointState({
        ...committed,
        totalStrain6: nextStrain6,
        effectiveStress6: stressTrial6,
        activeYieldSurface: diagnostics.activeYieldSurface,
        currentlyMcActive,
        hasEverExceededMc: diagnostics.hasEverExceededMc,
        etaMcCurrent: diagnostics.etaMcCurrent,
        etaMcMaxHistory: diagnostics.etaMcMaxHistory,
        sigmaY: params?.sigmaY
      });
      return {
        stressTrial6,
        tangent6x6,
        trialState,
        diagnostics: {
          ...diagnostics,
          fMcTrial: Number(mcTrial?.F) || 0,
          etaMcTrial: Number.isFinite(Number(mcTrial?.eta)) ? Number(mcTrial.eta) : Number.POSITIVE_INFINITY,
          yieldTolerance,
          constitutiveModel: 'mc-reduced-stiffness',
          analysisContext
        }
      };
    }
  };
}
