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
export const YIELD_SURFACE_MC_FACE = 'MC_FACE';
export const YIELD_SURFACE_MC_EDGE = 'MC_EDGE';
export const YIELD_SURFACE_MC_APEX = 'MC_APEX';
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

function zeroMatrix3() {
  return [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0]
  ];
}

function cloneVector3(vector) {
  const source = Array.isArray(vector) || ArrayBuffer.isView(vector) ? vector : [0, 0, 0];
  return [
    Number(source[0]) || 0,
    Number(source[1]) || 0,
    Number(source[2]) || 0
  ];
}

function addVector3(left, right) {
  return [
    (Number(left?.[0]) || 0) + (Number(right?.[0]) || 0),
    (Number(left?.[1]) || 0) + (Number(right?.[1]) || 0),
    (Number(left?.[2]) || 0) + (Number(right?.[2]) || 0)
  ];
}

function subtractVector3(left, right) {
  return [
    (Number(left?.[0]) || 0) - (Number(right?.[0]) || 0),
    (Number(left?.[1]) || 0) - (Number(right?.[1]) || 0),
    (Number(left?.[2]) || 0) - (Number(right?.[2]) || 0)
  ];
}

function scaleVector3(vector, factor) {
  return [
    (Number(vector?.[0]) || 0) * factor,
    (Number(vector?.[1]) || 0) * factor,
    (Number(vector?.[2]) || 0) * factor
  ];
}

function dotVector3(left, right) {
  return (
    (Number(left?.[0]) || 0) * (Number(right?.[0]) || 0) +
    (Number(left?.[1]) || 0) * (Number(right?.[1]) || 0) +
    (Number(left?.[2]) || 0) * (Number(right?.[2]) || 0)
  );
}

function vectorNorm3(vector) {
  return Math.sqrt(dotVector3(vector, vector));
}

function multiplyMatrix3x3Vector3(matrix, vector) {
  return [
    (Number(matrix?.[0]?.[0]) || 0) * (Number(vector?.[0]) || 0) +
      (Number(matrix?.[0]?.[1]) || 0) * (Number(vector?.[1]) || 0) +
      (Number(matrix?.[0]?.[2]) || 0) * (Number(vector?.[2]) || 0),
    (Number(matrix?.[1]?.[0]) || 0) * (Number(vector?.[0]) || 0) +
      (Number(matrix?.[1]?.[1]) || 0) * (Number(vector?.[1]) || 0) +
      (Number(matrix?.[1]?.[2]) || 0) * (Number(vector?.[2]) || 0),
    (Number(matrix?.[2]?.[0]) || 0) * (Number(vector?.[0]) || 0) +
      (Number(matrix?.[2]?.[1]) || 0) * (Number(vector?.[1]) || 0) +
      (Number(matrix?.[2]?.[2]) || 0) * (Number(vector?.[2]) || 0)
  ];
}

function outerProduct3(left, right) {
  return [
    [
      (Number(left?.[0]) || 0) * (Number(right?.[0]) || 0),
      (Number(left?.[0]) || 0) * (Number(right?.[1]) || 0),
      (Number(left?.[0]) || 0) * (Number(right?.[2]) || 0)
    ],
    [
      (Number(left?.[1]) || 0) * (Number(right?.[0]) || 0),
      (Number(left?.[1]) || 0) * (Number(right?.[1]) || 0),
      (Number(left?.[1]) || 0) * (Number(right?.[2]) || 0)
    ],
    [
      (Number(left?.[2]) || 0) * (Number(right?.[0]) || 0),
      (Number(left?.[2]) || 0) * (Number(right?.[1]) || 0),
      (Number(left?.[2]) || 0) * (Number(right?.[2]) || 0)
    ]
  ];
}

function addMatrix3(left, right) {
  return Array.from({ length: 3 }, (_item, rowIndex) =>
    Array.from({ length: 3 }, (_value, colIndex) =>
      (Number(left?.[rowIndex]?.[colIndex]) || 0) + (Number(right?.[rowIndex]?.[colIndex]) || 0)
    )
  );
}

function scaleMatrix3(matrix, factor) {
  return Array.from({ length: 3 }, (_item, rowIndex) =>
    Array.from({ length: 3 }, (_value, colIndex) =>
      (Number(matrix?.[rowIndex]?.[colIndex]) || 0) * factor
    )
  );
}

function principalDirectionToProjector(vector3) {
  const norm = vectorNorm3(vector3);
  if (!(norm > 1e-12)) return zeroMatrix3();
  const normalized = scaleVector3(vector3, 1 / norm);
  return outerProduct3(normalized, normalized);
}

function projectorTensorToEngineeringGradient6(projector) {
  return [
    Number(projector?.[0]?.[0]) || 0,
    Number(projector?.[1]?.[1]) || 0,
    Number(projector?.[2]?.[2]) || 0,
    2 * (Number(projector?.[0]?.[1]) || 0),
    2 * (Number(projector?.[1]?.[2]) || 0),
    2 * (Number(projector?.[0]?.[2]) || 0)
  ];
}

function normalizeVector3(vector3, fallback = [1, 0, 0]) {
  const norm = vectorNorm3(vector3);
  if (!(norm > 1e-12)) return cloneVector3(fallback);
  return scaleVector3(vector3, 1 / norm);
}

function solveDenseLinearSystem(matrixInput, rhsInput, tolerance = 1e-12) {
  const size = Array.isArray(rhsInput) ? rhsInput.length : 0;
  if (!(size > 0)) return [];
  const matrix = Array.from({ length: size }, (_item, rowIndex) =>
    Array.from({ length: size }, (_value, colIndex) => Number(matrixInput?.[rowIndex]?.[colIndex]) || 0)
  );
  const rhs = Array.from({ length: size }, (_item, rowIndex) => Number(rhsInput?.[rowIndex]) || 0);

  for (let pivotIndex = 0; pivotIndex < size; pivotIndex += 1) {
    let pivotRow = pivotIndex;
    let pivotValue = Math.abs(matrix[pivotRow][pivotIndex]);
    for (let rowIndex = pivotIndex + 1; rowIndex < size; rowIndex += 1) {
      const candidate = Math.abs(matrix[rowIndex][pivotIndex]);
      if (candidate > pivotValue) {
        pivotValue = candidate;
        pivotRow = rowIndex;
      }
    }
    if (!(pivotValue > tolerance) || !Number.isFinite(pivotValue)) return null;
    if (pivotRow !== pivotIndex) {
      [matrix[pivotIndex], matrix[pivotRow]] = [matrix[pivotRow], matrix[pivotIndex]];
      [rhs[pivotIndex], rhs[pivotRow]] = [rhs[pivotRow], rhs[pivotIndex]];
    }
    const pivot = matrix[pivotIndex][pivotIndex];
    for (let rowIndex = pivotIndex + 1; rowIndex < size; rowIndex += 1) {
      const factor = matrix[rowIndex][pivotIndex] / pivot;
      matrix[rowIndex][pivotIndex] = 0;
      for (let colIndex = pivotIndex + 1; colIndex < size; colIndex += 1) {
        matrix[rowIndex][colIndex] -= factor * matrix[pivotIndex][colIndex];
      }
      rhs[rowIndex] -= factor * rhs[pivotIndex];
    }
  }

  const solution = Array(size).fill(0);
  for (let rowIndex = size - 1; rowIndex >= 0; rowIndex -= 1) {
    let value = rhs[rowIndex];
    for (let colIndex = rowIndex + 1; colIndex < size; colIndex += 1) {
      value -= matrix[rowIndex][colIndex] * solution[colIndex];
    }
    const pivot = matrix[rowIndex][rowIndex];
    if (!(Math.abs(pivot) > tolerance) || !Number.isFinite(pivot)) return null;
    solution[rowIndex] = value / pivot;
  }
  return solution;
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

function weightedEngineeringStrainDot(left, right) {
  return (
    (Number(left?.[0]) || 0) * (Number(right?.[0]) || 0) +
    (Number(left?.[1]) || 0) * (Number(right?.[1]) || 0) +
    (Number(left?.[2]) || 0) * (Number(right?.[2]) || 0) +
    0.5 * (Number(left?.[3]) || 0) * (Number(right?.[3]) || 0) +
    0.5 * (Number(left?.[4]) || 0) * (Number(right?.[4]) || 0) +
    0.5 * (Number(left?.[5]) || 0) * (Number(right?.[5]) || 0)
  );
}

function deviatoricEngineeringStrain6(strain6) {
  const exx = Number(strain6?.[VOIGT_XX]) || 0;
  const eyy = Number(strain6?.[VOIGT_YY]) || 0;
  const ezz = Number(strain6?.[VOIGT_ZZ]) || 0;
  const mean = (exx + eyy + ezz) / 3;
  return [
    exx - mean,
    eyy - mean,
    ezz - mean,
    Number(strain6?.[VOIGT_XY]) || 0,
    Number(strain6?.[VOIGT_YZ]) || 0,
    Number(strain6?.[VOIGT_XZ]) || 0
  ];
}

function equivalentPlasticStrainIncrement(deltaPlasticStrain6) {
  const dev = deviatoricEngineeringStrain6(deltaPlasticStrain6);
  const normSquared = weightedEngineeringStrainDot(dev, dev);
  return Math.sqrt(Math.max((2 / 3) * normSquared, 0));
}

function vectorNorm6(vector) {
  return Math.sqrt(
    (Number(vector?.[0]) || 0) ** 2 +
    (Number(vector?.[1]) || 0) ** 2 +
    (Number(vector?.[2]) || 0) ** 2 +
    (Number(vector?.[3]) || 0) ** 2 +
    (Number(vector?.[4]) || 0) ** 2 +
    (Number(vector?.[5]) || 0) ** 2
  );
}

function dotVector6(left, right) {
  return (
    (Number(left?.[0]) || 0) * (Number(right?.[0]) || 0) +
    (Number(left?.[1]) || 0) * (Number(right?.[1]) || 0) +
    (Number(left?.[2]) || 0) * (Number(right?.[2]) || 0) +
    (Number(left?.[3]) || 0) * (Number(right?.[3]) || 0) +
    (Number(left?.[4]) || 0) * (Number(right?.[4]) || 0) +
    (Number(left?.[5]) || 0) * (Number(right?.[5]) || 0)
  );
}

function outerProduct6(left, right, scale = 1) {
  return Array.from({ length: 6 }, (_item, rowIndex) =>
    Array.from({ length: 6 }, (_value, colIndex) =>
      scale * (Number(left?.[rowIndex]) || 0) * (Number(right?.[colIndex]) || 0)
    )
  );
}

function subtractMatrix6(left, right) {
  return Array.from({ length: 6 }, (_item, rowIndex) =>
    Array.from({ length: 6 }, (_value, colIndex) =>
      (Number(left?.[rowIndex]?.[colIndex]) || 0) - (Number(right?.[rowIndex]?.[colIndex]) || 0)
    )
  );
}

function symmetrizeMatrix6(matrix) {
  return Array.from({ length: 6 }, (_item, rowIndex) =>
    Array.from({ length: 6 }, (_value, colIndex) =>
      0.5 * (
        (Number(matrix?.[rowIndex]?.[colIndex]) || 0) +
        (Number(matrix?.[colIndex]?.[rowIndex]) || 0)
      )
    )
  );
}

function zeroMatrix6() {
  return Array.from({ length: 6 }, () => zeroVector6());
}

function invertDenseMatrix(matrixInput, tolerance = 1e-12) {
  const size = Array.isArray(matrixInput) ? matrixInput.length : 0;
  if (!(size > 0)) return [];
  const inverse = Array.from({ length: size }, () => Array(size).fill(0));
  for (let columnIndex = 0; columnIndex < size; columnIndex += 1) {
    const rhs = Array.from({ length: size }, (_item, rowIndex) => (rowIndex === columnIndex ? 1 : 0));
    const column = solveDenseLinearSystem(matrixInput, rhs, tolerance);
    if (!column) return null;
    for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
      inverse[rowIndex][columnIndex] = Number(column[rowIndex]) || 0;
    }
  }
  return inverse;
}

function compressionPositiveStressTensor3From6(stress6) {
  return [
    [-(Number(stress6?.[VOIGT_XX]) || 0), -(Number(stress6?.[VOIGT_XY]) || 0), -(Number(stress6?.[VOIGT_XZ]) || 0)],
    [-(Number(stress6?.[VOIGT_XY]) || 0), -(Number(stress6?.[VOIGT_YY]) || 0), -(Number(stress6?.[VOIGT_YZ]) || 0)],
    [-(Number(stress6?.[VOIGT_XZ]) || 0), -(Number(stress6?.[VOIGT_YZ]) || 0), -(Number(stress6?.[VOIGT_ZZ]) || 0)]
  ];
}

function compressionPositiveTensor3ToStress6(tensor3) {
  return [
    -(Number(tensor3?.[0]?.[0]) || 0),
    -(Number(tensor3?.[1]?.[1]) || 0),
    -(Number(tensor3?.[2]?.[2]) || 0),
    -(Number(tensor3?.[0]?.[1]) || 0),
    -(Number(tensor3?.[1]?.[2]) || 0),
    -(Number(tensor3?.[0]?.[2]) || 0)
  ];
}

function combinePrincipalProjectors(projectors, coefficients) {
  return addMatrix3(
    addMatrix3(
      scaleMatrix3(projectors?.P1, Number(coefficients?.[0]) || 0),
      scaleMatrix3(projectors?.P2, Number(coefficients?.[1]) || 0)
    ),
    scaleMatrix3(projectors?.P3, Number(coefficients?.[2]) || 0)
  );
}

function compressionPositiveGradientTensorToInternalEngineeringGradient6(tensor3) {
  return [
    -(Number(tensor3?.[0]?.[0]) || 0),
    -(Number(tensor3?.[1]?.[1]) || 0),
    -(Number(tensor3?.[2]?.[2]) || 0),
    -2 * (Number(tensor3?.[0]?.[1]) || 0),
    -2 * (Number(tensor3?.[1]?.[2]) || 0),
    -2 * (Number(tensor3?.[0]?.[2]) || 0)
  ];
}

function principalCoefficientsToInternalGradient6(coefficients, projectors) {
  return compressionPositiveGradientTensorToInternalEngineeringGradient6(
    combinePrincipalProjectors(projectors, coefficients)
  );
}

function projectorsToCompressionPositiveStressTensor(principalValues, projectors) {
  return combinePrincipalProjectors(projectors, principalValues);
}

function exactMcSurfaceParameters(materialParameters = {}) {
  const phi = (clampMcAngle(materialParameters?.phiEffDeg) * Math.PI) / 180;
  const psi = (clampMcAngle(materialParameters?.psiEffDeg ?? materialParameters?.psi) * Math.PI) / 180;
  const c = Math.max(Number(materialParameters?.cEff) || 0, 0);
  const sigmaTAllow = Math.max(Number(materialParameters?.sigmaTAllow) || 0, 0);
  return {
    phi,
    psi,
    c,
    sigmaTAllow,
    sinPhi: Math.sin(phi),
    cosPhi: Math.cos(phi),
    sinPsi: Math.sin(psi),
    useTensionCutoff: materialParameters?.useTensionCutoff !== false
  };
}

function principalElasticMatrix3x3(materialParameters, warnings = [], label = 'Material') {
  const { lambda, G } = elasticLameParameters(materialParameters?.Emc, materialParameters?.nu, warnings, label);
  return [
    [lambda + 2 * G, lambda, lambda],
    [lambda, lambda + 2 * G, lambda],
    [lambda, lambda, lambda + 2 * G]
  ];
}

function principalStressProjectors3DCompressionPositive(stress6, materialParameters = {}) {
  const stress = effectiveStress6ToCompressionPositiveStress3D(stress6);
  const eigTolerance = Math.max(Number(materialParameters?.eigTolerance) || 1e-9, 1e-12);
  const pxy = 0.5 * (stress.sxx + stress.syy);
  const diff = 0.5 * (stress.sxx - stress.syy);
  const radius = Math.hypot(diff, stress.txy);
  const planeMajor = pxy + radius;
  const planeMinor = pxy - radius;
  let planeMajorVector = [1, 0, 0];
  let planeMinorVector = [0, 1, 0];
  if (radius > eigTolerance) {
    const theta = 0.5 * Math.atan2(2 * stress.txy, stress.sxx - stress.syy);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    planeMajorVector = [c, s, 0];
    planeMinorVector = [-s, c, 0];
  }
  const eigenpairs = [
    { value: planeMajor, direction: normalizeVector3(planeMajorVector), source: 'plane-major' },
    { value: stress.szz, direction: [0, 0, 1], source: 'out-of-plane' },
    { value: planeMinor, direction: normalizeVector3(planeMinorVector), source: 'plane-minor' }
  ].sort((left, right) => descendingNumeric(left.value, right.value));
  const repeatedEigenvalues =
    Math.abs(eigenpairs[0].value - eigenpairs[1].value) <= eigTolerance ||
    Math.abs(eigenpairs[1].value - eigenpairs[2].value) <= eigTolerance ||
    Math.abs(eigenpairs[0].value - eigenpairs[2].value) <= eigTolerance;
  return {
    s1: Number(eigenpairs[0].value) || 0,
    s2: Number(eigenpairs[1].value) || 0,
    s3: Number(eigenpairs[2].value) || 0,
    P1: principalDirectionToProjector(eigenpairs[0].direction),
    P2: principalDirectionToProjector(eigenpairs[1].direction),
    P3: principalDirectionToProjector(eigenpairs[2].direction),
    planeMajor,
    planeMinor,
    repeatedEigenvalues,
    eigTolerance
  };
}

function buildExactMcSurfaces(projectors, materialParameters) {
  const { sinPhi, cosPhi, sinPsi } = exactMcSurfaceParameters(materialParameters);
  const shearIntercept = 2 * Math.max(Number(materialParameters?.cEff) || 0, 0) * cosPhi;
  const definitions = [
    {
      id: 'F12',
      kind: 'shear',
      nPrincipal: [1 - sinPhi, -(1 + sinPhi), 0],
      mPrincipal: [1 - sinPsi, -(1 + sinPsi), 0],
      intercept: shearIntercept
    },
    {
      id: 'F13',
      kind: 'shear',
      nPrincipal: [1 - sinPhi, 0, -(1 + sinPhi)],
      mPrincipal: [1 - sinPsi, 0, -(1 + sinPsi)],
      intercept: shearIntercept
    },
    {
      id: 'F23',
      kind: 'shear',
      nPrincipal: [0, 1 - sinPhi, -(1 + sinPhi)],
      mPrincipal: [0, 1 - sinPsi, -(1 + sinPsi)],
      intercept: shearIntercept
    }
  ];
  return definitions.map((surface) => ({
    ...surface,
    n6: principalCoefficientsToInternalGradient6(surface.nPrincipal, projectors),
    m6: principalCoefficientsToInternalGradient6(surface.mPrincipal, projectors)
  }));
}

function evaluateExactMcSurfaceValuesFromPrincipal(principalValues, materialParameters) {
  const { sinPhi, cosPhi, sigmaTAllow, useTensionCutoff } = exactMcSurfaceParameters(materialParameters);
  const shearIntercept = 2 * Math.max(Number(materialParameters?.cEff) || 0, 0) * cosPhi;
  const [s1, s2, s3] = cloneVector3(principalValues);
  const values = {
    F12: (1 - sinPhi) * s1 - (1 + sinPhi) * s2 - shearIntercept,
    F13: (1 - sinPhi) * s1 - (1 + sinPhi) * s3 - shearIntercept,
    F23: (1 - sinPhi) * s2 - (1 + sinPhi) * s3 - shearIntercept
  };
  if (useTensionCutoff) values.T3 = -s3 - sigmaTAllow;
  return values;
}

function evaluateExactMcSurfaceValuesFromStress(stress6, materialParameters) {
  const principal = principalStressProjectors3DCompressionPositive(stress6, materialParameters);
  const values = evaluateExactMcSurfaceValuesFromPrincipal([principal.s1, principal.s2, principal.s3], materialParameters);
  return { principal, values };
}

function activeYieldSurfaceLabelFromActiveSet(activeSurfaces = []) {
  const shearCount = activeSurfaces.filter((surface) => surface?.kind === 'shear').length;
  const hasTension = activeSurfaces.some((surface) => surface?.kind === 'tension');
  if (shearCount >= 3) return YIELD_SURFACE_MC_APEX;
  if (shearCount >= 2) return YIELD_SURFACE_MC_EDGE;
  if (shearCount === 1) return YIELD_SURFACE_MC_FACE;
  if (hasTension) return YIELD_SURFACE_TENSION;
  return YIELD_SURFACE_NONE;
}

function computeExactElastoplasticTangent(D_e, activeSurfaces, couplingMatrix, materialParameters = null) {
  if (!Array.isArray(activeSurfaces) || activeSurfaces.length === 0) return cloneMatrix6(D_e);
  const inverseCoupling = invertDenseMatrix(couplingMatrix, 1e-12);
  if (!inverseCoupling) return cloneMatrix6(D_e);
  const correction = zeroMatrix6();
  const DmColumns = activeSurfaces.map((surface) => multiplyMatrix6x6Vector6(D_e, surface.m6));
  const DnColumns = activeSurfaces.map((surface) => multiplyMatrix6x6Vector6(D_e, surface.n6));
  for (let rowIndex = 0; rowIndex < activeSurfaces.length; rowIndex += 1) {
    for (let colIndex = 0; colIndex < activeSurfaces.length; colIndex += 1) {
      const scale = Number(inverseCoupling?.[rowIndex]?.[colIndex]) || 0;
      if (!Number.isFinite(scale) || Math.abs(scale) <= 0) continue;
      const outer = outerProduct6(DmColumns[rowIndex], DnColumns[colIndex], scale);
      for (let i = 0; i < 6; i += 1) {
        for (let j = 0; j < 6; j += 1) {
          correction[i][j] += Number(outer?.[i]?.[j]) || 0;
        }
      }
    }
  }
  const tangent = subtractMatrix6(D_e, correction);
  return materialParameters?.symmetrizeEpTangent === true ? symmetrizeMatrix6(tangent) : tangent;
}

function solveExactMcActiveSetReturn(stressTrial6, elasticTangent6x6, materialParameters, mcTrial) {
  const tolerance = localReturnTolerance(materialParameters, mcTrial);
  const maxIterations = Math.max(Math.round(Number(materialParameters?.localMaxIterations) || 40), 1);
  const principalTrial = principalStressProjectors3DCompressionPositive(stressTrial6, materialParameters);
  const trialPrincipalValues = [principalTrial.s1, principalTrial.s2, principalTrial.s3];
  const surfaces = buildExactMcSurfaces(principalTrial, materialParameters);
  const surfaceMap = Object.fromEntries(surfaces.map((surface) => [surface.id, surface]));
  const trialSurfaceValues = evaluateExactMcSurfaceValuesFromPrincipal(trialPrincipalValues, materialParameters);
  const violatingTrialSurfaces = surfaces
    .filter((surface) => (Number(trialSurfaceValues?.[surface.id]) || 0) > tolerance)
    .sort((left, right) => (Number(trialSurfaceValues?.[right.id]) || 0) - (Number(trialSurfaceValues?.[left.id]) || 0));
  if (!violatingTrialSurfaces.length) {
    return {
      converged: true,
      iterations: 0,
      stress6: cloneVector6(stressTrial6),
      plasticStrainIncrement6: zeroVector6(),
      algorithmicTangent6x6: cloneMatrix6(elasticTangent6x6),
      activeYieldSurface: YIELD_SURFACE_NONE,
      activeSurfaceIds: [],
      yieldResidual: Math.max(...Object.values(trialSurfaceValues).map((value) => Number(value) || 0), 0)
    };
  }

  const activeIds = [];
  const tensionTrial = violatingTrialSurfaces.find((surface) => surface.kind === 'tension');
  const shearTrial = violatingTrialSurfaces.find((surface) => surface.kind === 'shear');
  if (tensionTrial) activeIds.push(tensionTrial.id);
  if (shearTrial) activeIds.push(shearTrial.id);
  if (!activeIds.length) activeIds.push(violatingTrialSurfaces[0].id);
  const visitedSets = new Set();
  const D_n = principalElasticMatrix3x3(materialParameters);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    activeIds.sort();
    const activeKey = activeIds.join('|');
    if (visitedSets.has(activeKey)) {
      return { converged: false, reason: `local active set oscillated (${activeKey})` };
    }
    visitedSets.add(activeKey);
    const activeSurfaces = activeIds.map((id) => surfaceMap[id]).filter(Boolean);
    const couplingMatrix = activeSurfaces.map((surfaceI) =>
      activeSurfaces.map((surfaceJ) => dotVector6(surfaceI.n6, multiplyMatrix6x6Vector6(elasticTangent6x6, surfaceJ.m6)))
    );
    const rhs = activeSurfaces.map((surface) => Number(trialSurfaceValues?.[surface.id]) || 0);
    const plasticMultipliers = solveDenseLinearSystem(couplingMatrix, rhs, 1e-12);
    if (!plasticMultipliers) {
      return { converged: false, reason: `local exact MC active-set solve became singular on ${activeKey || 'EMPTY'}` };
    }
    const mostNegativeIndex = plasticMultipliers.reduce((bestIndex, value, index) => {
      const bestValue = bestIndex >= 0 ? Number(plasticMultipliers?.[bestIndex]) || 0 : 0;
      return bestIndex < 0 || value < bestValue ? index : bestIndex;
    }, -1);
    if (mostNegativeIndex >= 0 && (Number(plasticMultipliers[mostNegativeIndex]) || 0) < -tolerance) {
      activeIds.splice(mostNegativeIndex, 1);
      if (!activeIds.length) activeIds.push(violatingTrialSurfaces[0].id);
      continue;
    }

    const plasticFlowPrincipal = activeSurfaces.reduce(
      (sum, surface, index) => addVector3(sum, scaleVector3(surface.mPrincipal, Number(plasticMultipliers?.[index]) || 0)),
      [0, 0, 0]
    );
    const stressCorrectionPrincipal = multiplyMatrix3x3Vector3(D_n, plasticFlowPrincipal);
    const stressReturnPrincipal = subtractVector3(trialPrincipalValues, stressCorrectionPrincipal);
    const candidateSurfaceValues = evaluateExactMcSurfaceValuesFromPrincipal(stressReturnPrincipal, materialParameters);
    const stressReturn6 = compressionPositiveTensor3ToStress6(
      projectorsToCompressionPositiveStressTensor(stressReturnPrincipal, principalTrial)
    );
    const plasticStrainIncrement6 = activeSurfaces.reduce(
      (sum, surface, index) => addVector6(sum, scaleVector6(surface.m6, Number(plasticMultipliers?.[index]) || 0)),
      zeroVector6()
    );
    const violatingInactive = surfaces
      .filter((surface) => !activeIds.includes(surface.id))
      .filter((surface) => (Number(candidateSurfaceValues?.[surface.id]) || 0) > tolerance)
      .sort((left, right) => (Number(candidateSurfaceValues?.[right.id]) || 0) - (Number(candidateSurfaceValues?.[left.id]) || 0));
    if (violatingInactive.length) {
      activeIds.push(violatingInactive[0].id);
      continue;
    }
    const exactCurrent = evaluateExactMcSurfaceValuesFromStress(stressReturn6, materialParameters);

    return {
      converged: true,
      iterations: iteration,
      stress6: stressReturn6,
      plasticStrainIncrement6,
      algorithmicTangent6x6: computeExactElastoplasticTangent(elasticTangent6x6, activeSurfaces, couplingMatrix, materialParameters),
      activeYieldSurface: activeYieldSurfaceLabelFromActiveSet(activeSurfaces),
      activeSurfaceIds: activeSurfaces.map((surface) => surface.id),
      yieldResidual: Math.max(...Object.values(exactCurrent.values || {}).map((value) => Number(value) || 0), 0)
    };
  }

  return {
    converged: false,
    reason: `max exact MC active-set iterations reached (${maxIterations})`
  };
}

function clampMcAngle(angleDeg) {
  return Math.max(Math.min(Number(angleDeg) || 0, 89.5), 0);
}

function smoothQScale(materialParameters) {
  const pRef = Math.max(Number(materialParameters?.yieldTolerancePref) || 100, 1e-6);
  const factor = Math.max(Number(materialParameters?.smoothQScale) || 1e-8, 0);
  return Math.max(factor * pRef, 1e-10);
}

function pressureDependentMcParameters(angleDeg, cohesion) {
  const angle = (clampMcAngle(angleDeg) * Math.PI) / 180;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const denom = Math.max(3 - sin, 1e-9);
  return {
    alpha: (6 * sin) / denom,
    k: (6 * Math.max(Number(cohesion) || 0, 0) * cos) / denom
  };
}

function evaluateSmoothedPlasticSurface(stress6, angleDeg, cohesion, materialParameters = {}, includeCohesion = true) {
  const sxx = -(Number(stress6?.[VOIGT_XX]) || 0);
  const syy = -(Number(stress6?.[VOIGT_YY]) || 0);
  const szz = -(Number(stress6?.[VOIGT_ZZ]) || 0);
  const txy = -(Number(stress6?.[VOIGT_XY]) || 0);
  const tyz = -(Number(stress6?.[VOIGT_YZ]) || 0);
  const txz = -(Number(stress6?.[VOIGT_XZ]) || 0);
  const p = (sxx + syy + szz) / 3;
  const dxx = sxx - p;
  const dyy = syy - p;
  const dzz = szz - p;
  const J2 = 0.5 * (dxx * dxx + dyy * dyy + dzz * dzz + 2 * (txy * txy + tyz * tyz + txz * txz));
  const q0 = smoothQScale(materialParameters);
  const q = Math.sqrt(Math.max(3 * J2, 0) + q0 * q0) - q0;
  const { alpha, k } = pressureDependentMcParameters(angleDeg, includeCohesion ? cohesion : 0);
  return {
    f: q - alpha * p - (includeCohesion ? k : 0),
    p,
    q,
    J2,
    alpha,
    k: includeCohesion ? k : 0
  };
}

function smoothSurfaceGradient6(stress6, angleDeg, cohesion, materialParameters = {}, includeCohesion = true) {
  const sxx = -(Number(stress6?.[VOIGT_XX]) || 0);
  const syy = -(Number(stress6?.[VOIGT_YY]) || 0);
  const szz = -(Number(stress6?.[VOIGT_ZZ]) || 0);
  const txy = -(Number(stress6?.[VOIGT_XY]) || 0);
  const tyz = -(Number(stress6?.[VOIGT_YZ]) || 0);
  const txz = -(Number(stress6?.[VOIGT_XZ]) || 0);
  const p = (sxx + syy + szz) / 3;
  const dxx = sxx - p;
  const dyy = syy - p;
  const dzz = szz - p;
  const J2 = 0.5 * (dxx * dxx + dyy * dyy + dzz * dzz + 2 * (txy * txy + tyz * tyz + txz * txz));
  const q0 = smoothQScale(materialParameters);
  const qTilde = Math.sqrt(Math.max(3 * J2, 0) + q0 * q0);
  const { alpha } = pressureDependentMcParameters(angleDeg, includeCohesion ? cohesion : 0);
  const qFactor = qTilde > 1e-12 ? 3 / (2 * qTilde) : 0;
  const tensorGradientCompressionPositive = [
    qFactor * dxx - alpha / 3,
    qFactor * dyy - alpha / 3,
    qFactor * dzz - alpha / 3,
    qFactor * txy,
    qFactor * tyz,
    qFactor * txz
  ];
  return [
    -tensorGradientCompressionPositive[VOIGT_XX],
    -tensorGradientCompressionPositive[VOIGT_YY],
    -tensorGradientCompressionPositive[VOIGT_ZZ],
    -2 * tensorGradientCompressionPositive[VOIGT_XY],
    -2 * tensorGradientCompressionPositive[VOIGT_YZ],
    -2 * tensorGradientCompressionPositive[VOIGT_XZ]
  ];
}

function gradientStepForStressComponent(stress6, index, materialParameters) {
  const baseScale = Math.max(Math.abs(Number(stress6?.[index]) || 0), Number(materialParameters?.yieldTolerancePref) || 100, 1);
  const stepScale = Math.max(Number(materialParameters?.gradientStepScale) || 1e-7, 1e-10);
  return Math.max(baseScale * stepScale, 1e-8);
}

function finiteDifferenceStressGradient6(stress6, evaluator, materialParameters) {
  const base = cloneVector6(stress6);
  const gradient = zeroVector6();
  for (let index = 0; index < 6; index += 1) {
    const step = gradientStepForStressComponent(base, index, materialParameters);
    const plus = cloneVector6(base);
    const minus = cloneVector6(base);
    plus[index] += step;
    minus[index] -= step;
    const fPlus = Number(evaluator(plus)) || 0;
    const fMinus = Number(evaluator(minus)) || 0;
    gradient[index] = (fPlus - fMinus) / (2 * step);
  }
  return gradient;
}

function toEngineeringStrainLikeGradient6(tensorGradientLike6) {
  const gradient = cloneVector6(tensorGradientLike6);
  gradient[VOIGT_XY] *= 2;
  gradient[VOIGT_YZ] *= 2;
  gradient[VOIGT_XZ] *= 2;
  return gradient;
}

function smoothYieldGradient6(stress6, materialParameters) {
  return smoothSurfaceGradient6(stress6, materialParameters?.phiEffDeg, materialParameters?.cEff, materialParameters, true);
}

function smoothPotentialGradient6(stress6, materialParameters) {
  return smoothSurfaceGradient6(stress6, materialParameters?.psiEffDeg ?? materialParameters?.psi, 0, materialParameters, false);
}

function computeApproximateElastoplasticTangent(D_e, yieldGradient6, potentialGradient6, materialParameters = null) {
  const Dm = multiplyMatrix6x6Vector6(D_e, potentialGradient6);
  const Dn = multiplyMatrix6x6Vector6(D_e, yieldGradient6);
  const denominator = dotVector6(yieldGradient6, Dm);
  if (!(Number.isFinite(denominator) && Math.abs(denominator) > 1e-12)) return cloneMatrix6(D_e);
  const tangent = subtractMatrix6(D_e, outerProduct6(Dm, Dn, 1 / denominator));
  return materialParameters?.symmetrizeEpTangent === true
    ? symmetrizeMatrix6(tangent)
    : tangent;
}

function localReturnTolerance(materialParameters, mcTrial) {
  return Math.max(Number(materialParameters?.localTolerance) || 1e-8, resolveYieldTolerance(materialParameters, mcTrial));
}

function returnMapSmoothMCPlastic(stressTrial6, elasticTangent6x6, materialParameters, mcTrial) {
  let stress6 = cloneVector6(stressTrial6);
  let deltaPlasticStrain6 = zeroVector6();
  const tolerance = localReturnTolerance(materialParameters, mcTrial);
  const maxIterations = Math.max(Math.round(Number(materialParameters?.localMaxIterations) || 40), 1);
  const smoothTrial = evaluateSmoothedPlasticSurface(stressTrial6, materialParameters?.phiEffDeg, materialParameters?.cEff, materialParameters, true);
  const fTrial = Number(smoothTrial?.f) || 0;
  if (Math.abs(fTrial) <= tolerance) {
    const trialYieldGradient6 = smoothYieldGradient6(stressTrial6, materialParameters);
    const trialPotentialGradient6 = smoothPotentialGradient6(stressTrial6, materialParameters);
      return {
        converged: true,
        iterations: 0,
        stress6,
        plasticStrainIncrement6: deltaPlasticStrain6,
        algorithmicTangent6x6: computeApproximateElastoplasticTangent(elasticTangent6x6, trialYieldGradient6, trialPotentialGradient6, materialParameters),
        activeYieldSurface: YIELD_SURFACE_MC_SHEAR,
        yieldResidual: fTrial
      };
    }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const smoothCurrent = evaluateSmoothedPlasticSurface(stress6, materialParameters?.phiEffDeg, materialParameters?.cEff, materialParameters, true);
    const fCurrent = Number(smoothCurrent?.f) || 0;
    if (Math.abs(fCurrent) <= tolerance) {
      const finalYieldGradient6 = smoothYieldGradient6(stress6, materialParameters);
      const finalPotentialGradient6 = smoothPotentialGradient6(stress6, materialParameters);
      return {
        converged: true,
        iterations: iteration,
        stress6,
        plasticStrainIncrement6: deltaPlasticStrain6,
        algorithmicTangent6x6: computeApproximateElastoplasticTangent(elasticTangent6x6, finalYieldGradient6, finalPotentialGradient6, materialParameters),
        activeYieldSurface: YIELD_SURFACE_MC_SHEAR,
        yieldResidual: fCurrent
      };
    }

    const yieldGradient6 = smoothYieldGradient6(stress6, materialParameters);
    const potentialGradient6 = smoothPotentialGradient6(stress6, materialParameters);
    const flowStressDirection6 = multiplyMatrix6x6Vector6(elasticTangent6x6, potentialGradient6);
    const denominator = dotVector6(yieldGradient6, flowStressDirection6);
    if (!(Number.isFinite(denominator) && denominator > 1e-12)) {
      return { converged: false, reason: 'bad plastic denominator' };
    }

    let deltaLambda = fCurrent / denominator;
    if (!(Number.isFinite(deltaLambda) && deltaLambda >= 0)) {
      return { converged: false, reason: 'negative plastic multiplier' };
    }

    let accepted = null;
    let best = null;
    for (const stepScale of [1, 0.5, 0.25, 0.125, 0.0625]) {
      const effectiveDeltaLambda = deltaLambda * stepScale;
      if (!(effectiveDeltaLambda > 0)) continue;
      const candidateStress6 = subtractVector6(stress6, scaleVector6(flowStressDirection6, effectiveDeltaLambda));
      const candidateSmooth = evaluateSmoothedPlasticSurface(candidateStress6, materialParameters?.phiEffDeg, materialParameters?.cEff, materialParameters, true);
      const fCandidate = Number(candidateSmooth?.f) || 0;
      if (!Number.isFinite(fCandidate)) continue;
      const candidate = {
        stress6: candidateStress6,
        f: fCandidate,
        deltaLambda: effectiveDeltaLambda,
        plasticStrainIncrement6: scaleVector6(potentialGradient6, effectiveDeltaLambda)
      };
      if (!best || Math.abs(fCandidate) < Math.abs(best.f)) best = candidate;
      if (Math.abs(fCandidate) <= tolerance || Math.abs(fCandidate) < Math.abs(fCurrent) * 0.9) {
        accepted = candidate;
        break;
      }
    }

    const next = accepted || best;
    if (!next || !(Math.abs(next.f) < Math.abs(fCurrent) - 1e-12 || Math.abs(next.f) <= tolerance)) {
      return { converged: false, reason: 'local line search could not reduce the smoothed yield residual' };
    }

    stress6 = next.stress6;
    deltaPlasticStrain6 = addVector6(deltaPlasticStrain6, next.plasticStrainIncrement6);
  }

  const smoothFinal = evaluateSmoothedPlasticSurface(stress6, materialParameters?.phiEffDeg, materialParameters?.cEff, materialParameters, true);
  return {
    converged: false,
    reason: `max local iterations reached (f=${(Number(smoothFinal?.f) || 0).toExponential(3)})`,
    yieldResidual: Number(smoothFinal?.f) || 0
  };
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
    initialFMc: Number(source.initialFMc) || 0,
    initialEtaMc: Number(source.initialEtaMc) || 0,
    initialDiagnosticYieldSurface: source.initialDiagnosticYieldSurface || YIELD_SURFACE_NONE,
    initialStateAdmissible: source.initialStateAdmissible !== false,
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
  const principal = principalStressProjectors3DCompressionPositive(stress6);
  return {
    s1: principal.s1,
    s2: principal.s2,
    s3: principal.s3,
    planeMajor: principal.planeMajor,
    planeMinor: principal.planeMinor
  };
}

export function mohrCoulombIndicator3D(stress6, materialParameters) {
  const { phi, c, sigmaTAllow, useTensionCutoff } = exactMcSurfaceParameters(materialParameters);
  const principal = principalStressProjectors3DCompressionPositive(stress6, materialParameters);
  const s1 = principal.s1;
  const s2 = principal.s2;
  const s3 = principal.s3;

  if (useTensionCutoff && s3 < -sigmaTAllow) {
    return {
      F: Number.POSITIVE_INFINITY,
      eta: Number.POSITIVE_INFINITY,
      state: 'tension-cutoff',
      surfaceValues: evaluateExactMcSurfaceValuesFromPrincipal([s1, s2, s3], materialParameters),
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
    state: F > 0 ? 'mc-yield' : 'elastic',
    surfaceValues: evaluateExactMcSurfaceValuesFromPrincipal([s1, s2, s3], materialParameters),
    ...principal
  };
}

export function evaluateMaterialPointDiagnosticsFromStress6(effectiveStress6, materialParameters, committedState = null, overrides = {}) {
  const effectiveStress2D = effectiveStress6ToCompressionPositiveStress2D(effectiveStress6);
  const effectiveStress3D = effectiveStress6ToCompressionPositiveStress3D(effectiveStress6);
  const mc = mohrCoulombIndicator3D(effectiveStress6, materialParameters);
  const diagnosticYieldSurface = activeYieldSurfaceFromState(mc);
  const activeYieldSurface = overrides.activeYieldSurface ?? YIELD_SURFACE_NONE;
  const currentlyMcActive = overrides.currentlyMcActive === true;
  const hasExceededNow = overrides.hasExceededNow === true ||
    activeYieldSurface === YIELD_SURFACE_MC_FACE ||
    activeYieldSurface === YIELD_SURFACE_MC_EDGE ||
    activeYieldSurface === YIELD_SURFACE_MC_APEX;
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
    diagnosticYieldSurface,
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
  const diagnostics = evaluateMaterialPointDiagnosticsFromStress6(effectiveStress6, materialParameters, null, {
    activeYieldSurface: YIELD_SURFACE_NONE,
    currentlyMcActive: false,
    hasEverExceededMc: false,
    hasExceededNow: false
  });
  const initialTolerance = resolveYieldTolerance(materialParameters, diagnostics.mc);
  return createMaterialPointState({
    effectiveStress6,
    activeYieldSurface: YIELD_SURFACE_NONE,
    currentlyMcActive: false,
    hasEverExceededMc: false,
    etaMcCurrent: diagnostics.etaMcFinal,
    etaMcMaxHistory: diagnostics.etaMcFinal,
    initialFMc: diagnostics.fMcFinal,
    initialEtaMc: diagnostics.etaMcFinal,
    initialDiagnosticYieldSurface: diagnostics.diagnosticYieldSurface,
    initialStateAdmissible: (Number(diagnostics.fMcFinal) || 0) <= initialTolerance,
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
    initialFMc: Number(source.initialFMc) || 0,
    initialEtaMc: Number(source.initialEtaMc) || 0,
    initialDiagnosticYieldSurface: source.initialDiagnosticYieldSurface || YIELD_SURFACE_NONE,
    initialStateAdmissible: source.initialStateAdmissible !== false,
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
        activeYieldSurface: currentlyMcActive
          ? YIELD_SURFACE_MC_SHEAR
          : finalMc?.state === 'tension-cutoff'
            ? YIELD_SURFACE_TENSION
            : YIELD_SURFACE_NONE,
        hasEverExceededMc: committed.hasEverExceededMc || exceedsMcShear || hasShearYieldExceedance(finalMc),
        hasExceededNow: currentlyMcActive,
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

export function createMCPlasticMaterial(materialParameters, warnings = []) {
  const label = materialParameters?.label || materialParameters?.id || 'Material';
  const elasticTangent6x6 = elasticMatrix6x6(materialParameters?.Emc, materialParameters?.nu, warnings, label);
  return {
    kind: 'mc-plastic',
    materialParameters,
    elasticTangent6x6,
    initialTangent6x6: cloneMatrix6(elasticTangent6x6),
    update({ strainTrial6, committedState, materialParameters: paramsOverride, analysisContext = null } = {}) {
      const params = paramsOverride || materialParameters || {};
      const committed = cloneMaterialPointState(committedState);
      const nextStrain6 = cloneVector6(strainTrial6);
      const deltaStrain6 = subtractVector6(nextStrain6, committed.totalStrain6);
      const stressTrial6 = addVector6(committed.effectiveStress6, multiplyMatrix6x6Vector6(elasticTangent6x6, deltaStrain6));
      const mcTrial = mohrCoulombIndicator3D(stressTrial6, params);
      const yieldTolerance = resolveYieldTolerance(params, mcTrial);
      const exactYieldSurface = activeYieldSurfaceFromState(mcTrial);
      if (exactYieldSurface === YIELD_SURFACE_TENSION) {
        const diagnostics = evaluateMaterialPointDiagnosticsFromStress6(stressTrial6, params, committed, {
          currentlyMcActive: false,
          stateChanged: committed.activeYieldSurface !== YIELD_SURFACE_TENSION,
          activeYieldSurface: YIELD_SURFACE_TENSION,
          hasExceededNow: false
        });
        const trialState = createMaterialPointState({
          ...committed,
          totalStrain6: nextStrain6,
          effectiveStress6: stressTrial6,
          activeYieldSurface: YIELD_SURFACE_TENSION,
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
            fMcTrial: Number(mcTrial?.F) || 0,
            etaMcTrial: Number.isFinite(Number(mcTrial?.eta)) ? Number(mcTrial.eta) : Number.POSITIVE_INFINITY,
            yieldTolerance,
            plasticIncrementNorm: 0,
            localIterations: 0,
            exactYieldTrial: Number.POSITIVE_INFINITY,
            exactYieldFinal: Number.POSITIVE_INFINITY,
            constitutiveModel: 'mc-plastic',
            analysisContext
          }
        };
      }
      const exactTrial = evaluateExactMcSurfaceValuesFromStress(stressTrial6, params);
      const exactTrialMaxResidual = Math.max(...Object.values(exactTrial?.values || {}).map((value) => Number(value) || 0), 0);

      if (!(exactTrialMaxResidual > yieldTolerance)) {
        const diagnostics = evaluateMaterialPointDiagnosticsFromStress6(stressTrial6, params, committed, {
          currentlyMcActive: false,
          stateChanged: false,
          activeYieldSurface: YIELD_SURFACE_NONE,
          hasExceededNow: false
        });
        const trialState = createMaterialPointState({
          ...committed,
          totalStrain6: nextStrain6,
          effectiveStress6: stressTrial6,
          activeYieldSurface: YIELD_SURFACE_NONE,
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
            fMcTrial: Number(mcTrial?.F) || 0,
            etaMcTrial: Number.isFinite(Number(mcTrial?.eta)) ? Number(mcTrial.eta) : Number.POSITIVE_INFINITY,
            yieldTolerance,
            plasticIncrementNorm: 0,
            localIterations: 0,
            exactYieldTrial: exactTrialMaxResidual,
            exactYieldFinal: exactTrialMaxResidual,
            constitutiveModel: 'mc-plastic',
            analysisContext
          }
        };
      }

      const local = solveExactMcActiveSetReturn(stressTrial6, elasticTangent6x6, params, mcTrial);
      if (!local?.converged) {
        throw new Error(`Local return mapping failed: ${local?.reason || 'unknown reason'}`);
      }

      const plasticStrainIncrement6 = cloneVector6(local.plasticStrainIncrement6);
      const nextPlasticStrain6 = addVector6(committed.plasticStrain6, plasticStrainIncrement6);
      const finalMc = mohrCoulombIndicator3D(local.stress6, params);
      const equivalentPlasticIncrement = equivalentPlasticStrainIncrement(plasticStrainIncrement6);
      const finalIsMcActive =
        local.activeYieldSurface === YIELD_SURFACE_MC_FACE ||
        local.activeYieldSurface === YIELD_SURFACE_MC_EDGE ||
        local.activeYieldSurface === YIELD_SURFACE_MC_APEX;
      const diagnostics = evaluateMaterialPointDiagnosticsFromStress6(local.stress6, params, committed, {
        currentlyMcActive: finalIsMcActive,
        stateChanged: committed.activeYieldSurface !== local.activeYieldSurface,
        activeYieldSurface: local.activeYieldSurface,
        hasEverExceededMc: committed.hasEverExceededMc || finalIsMcActive,
        hasExceededNow: finalIsMcActive
      });
      const trialState = createMaterialPointState({
        ...committed,
        totalStrain6: nextStrain6,
        plasticStrain6: nextPlasticStrain6,
        effectiveStress6: local.stress6,
        activeYieldSurface: local.activeYieldSurface,
        currentlyMcActive: finalIsMcActive,
        hasEverExceededMc: diagnostics.hasEverExceededMc,
        etaMcCurrent: diagnostics.etaMcCurrent,
        etaMcMaxHistory: diagnostics.etaMcMaxHistory,
        sigmaY: params?.sigmaY,
        accumulatedPlasticStrain: Math.max(Number(committed.accumulatedPlasticStrain) || 0, 0) + equivalentPlasticIncrement
      });
      return {
        stressTrial6: local.stress6,
        tangent6x6: local.algorithmicTangent6x6,
        trialState,
        diagnostics: {
          ...diagnostics,
          fMcTrial: Number(mcTrial?.F) || 0,
          etaMcTrial: Number.isFinite(Number(mcTrial?.eta)) ? Number(mcTrial.eta) : Number.POSITIVE_INFINITY,
          fMcFinal: Number(finalMc?.F) || 0,
          etaMcFinal: Number.isFinite(Number(finalMc?.eta)) ? Number(finalMc.eta) : Number.POSITIVE_INFINITY,
          exactYieldTrial: exactTrialMaxResidual,
          exactYieldFinal: Number(local?.yieldResidual) || 0,
          activeSurfaceIds: Array.isArray(local?.activeSurfaceIds) ? [...local.activeSurfaceIds] : [],
          yieldTolerance,
          plasticIncrementNorm: vectorNorm6(plasticStrainIncrement6),
          localIterations: local.iterations,
          constitutiveModel: 'mc-plastic',
          analysisContext
        }
      };
    }
  };
}
