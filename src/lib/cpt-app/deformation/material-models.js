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

const BRANCH_ELASTIC = 'ELASTIC';
const BRANCH_FACE_F13 = 'MC_FACE_F13';
const BRANCH_EDGE_S23_EQUAL = 'MC_EDGE_S23_EQUAL';
const BRANCH_EDGE_S12_EQUAL = 'MC_EDGE_S12_EQUAL';
const BRANCH_APEX_FORMAL = 'MC_APEX_FORMAL';
const BRANCH_TENSION_PENDING = 'MC_TENSION_PENDING';
const BRANCH_TENSION_FACE_T3 = 'TENSION_FACE_T3';
const BRANCH_TENSION_EDGE_T23 = 'TENSION_EDGE_T23';
const BRANCH_TENSION_EDGE_F13_T3 = 'TENSION_EDGE_F13_T3';
const BRANCH_TENSION_CORNER_S23_T3 = 'TENSION_CORNER_S23_T3';
const BRANCH_TENSION_CORNER_S12_T3 = 'TENSION_CORNER_S12_T3';
const BRANCH_TENSION_APEX_T123 = 'TENSION_APEX_T123';
const BRANCH_FALLBACK_SMOOTH = 'MC_FALLBACK_SMOOTH';

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

function cloneMatrix3(matrix) {
  if (!Array.isArray(matrix)) return zeroMatrix3();
  return Array.from({ length: 3 }, (_item, rowIndex) =>
    Array.from({ length: 3 }, (_value, colIndex) => Number(matrix?.[rowIndex]?.[colIndex]) || 0)
  );
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

function crossVector3(left, right) {
  return [
    (Number(left?.[1]) || 0) * (Number(right?.[2]) || 0) - (Number(left?.[2]) || 0) * (Number(right?.[1]) || 0),
    (Number(left?.[2]) || 0) * (Number(right?.[0]) || 0) - (Number(left?.[0]) || 0) * (Number(right?.[2]) || 0),
    (Number(left?.[0]) || 0) * (Number(right?.[1]) || 0) - (Number(left?.[1]) || 0) * (Number(right?.[0]) || 0)
  ];
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

function rankOneProjectorToDirection(projector, fallback = [1, 0, 0]) {
  const candidateColumns = [
    [Number(projector?.[0]?.[0]) || 0, Number(projector?.[1]?.[0]) || 0, Number(projector?.[2]?.[0]) || 0],
    [Number(projector?.[0]?.[1]) || 0, Number(projector?.[1]?.[1]) || 0, Number(projector?.[2]?.[1]) || 0],
    [Number(projector?.[0]?.[2]) || 0, Number(projector?.[1]?.[2]) || 0, Number(projector?.[2]?.[2]) || 0]
  ];
  let best = null;
  let bestNorm = 0;
  candidateColumns.forEach((column) => {
    const norm = vectorNorm3(column);
    if (norm > bestNorm) {
      bestNorm = norm;
      best = column;
    }
  });
  if (!(bestNorm > 1e-12) || !best) return normalizeVector3(fallback, fallback);
  return normalizeVector3(best, fallback);
}

function cloneRepresentativeProjectors(projectors) {
  if (!projectors || typeof projectors !== 'object') return null;
  const out = {};
  ['P1', 'P2', 'P3', 'P12', 'P23'].forEach((key) => {
    if (projectors[key]) out[key] = cloneMatrix3(projectors[key]);
  });
  return Object.keys(out).length ? out : null;
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

function matrixInfinityNorm(matrix) {
  const size = Array.isArray(matrix) ? matrix.length : 0;
  let maxRowSum = 0;
  for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
    let rowSum = 0;
    for (let colIndex = 0; colIndex < size; colIndex += 1) {
      rowSum += Math.abs(Number(matrix?.[rowIndex]?.[colIndex]) || 0);
    }
    maxRowSum = Math.max(maxRowSum, rowSum);
  }
  return maxRowSum;
}

function denseMatrixConditionNumberEstimate(matrix, tolerance = 1e-12) {
  const inverse = invertDenseMatrix(matrix, tolerance);
  if (!inverse) return Number.POSITIVE_INFINITY;
  return matrixInfinityNorm(matrix) * matrixInfinityNorm(inverse);
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
  const sigmaTAllowRaw = Math.max(Number(materialParameters?.sigmaTAllow) || 0, 0);
  const tanPhi = Math.tan(phi);
  const sigmaTUpperBound = Math.abs(tanPhi) > 1e-12 ? Math.max(c / tanPhi, 0) : Number.POSITIVE_INFINITY;
  const sigmaTAllow = Math.min(sigmaTAllowRaw, sigmaTUpperBound);
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

function tensionSurfacePrincipalCoefficients(branchKind = null) {
  if (branchKind === BRANCH_TENSION_EDGE_T23 || branchKind === BRANCH_TENSION_CORNER_S23_T3) {
    return {
      nPrincipal: [0, -0.5, -0.5],
      mPrincipal: [0, -0.5, -0.5]
    };
  }
  if (branchKind === BRANCH_TENSION_APEX_T123) {
    return {
      nPrincipal: [-1 / 3, -1 / 3, -1 / 3],
      mPrincipal: [-1 / 3, -1 / 3, -1 / 3]
    };
  }
  return {
    nPrincipal: [0, 0, -1],
    mPrincipal: [0, 0, -1]
  };
}

function buildExactMcSurfaces(projectors, materialParameters, branchKind = null) {
  const { sinPhi, cosPhi, sinPsi, useTensionCutoff, sigmaTAllow } = exactMcSurfaceParameters(materialParameters);
  const shearIntercept = 2 * Math.max(Number(materialParameters?.cEff) || 0, 0) * cosPhi;
  const f12Principal = [1 - sinPhi, -(1 + sinPhi), 0];
  const f13Principal = [1 - sinPhi, 0, -(1 + sinPhi)];
  const f23Principal = [0, 1 - sinPhi, -(1 + sinPhi)];
  const g12Principal = [1 - sinPsi, -(1 + sinPsi), 0];
  const g13Principal = [1 - sinPsi, 0, -(1 + sinPsi)];
  const g23Principal = [0, 1 - sinPsi, -(1 + sinPsi)];
  if (branchKind === BRANCH_TENSION_CORNER_S23_T3) {
    f13Principal[1] = -0.5 * (1 + sinPhi);
    f13Principal[2] = -0.5 * (1 + sinPhi);
    g13Principal[1] = -0.5 * (1 + sinPsi);
    g13Principal[2] = -0.5 * (1 + sinPsi);
  }
  if (branchKind === BRANCH_TENSION_CORNER_S12_T3) {
    f13Principal[0] = 0.5 * (1 - sinPhi);
    f13Principal[1] = 0.5 * (1 - sinPhi);
    g13Principal[0] = 0.5 * (1 - sinPsi);
    g13Principal[1] = 0.5 * (1 - sinPsi);
  }
  const definitions = [
    {
      id: 'F12',
      kind: 'shear',
      nPrincipal: f12Principal,
      mPrincipal: g12Principal,
      intercept: shearIntercept
    },
    {
      id: 'F13',
      kind: 'shear',
      nPrincipal: f13Principal,
      mPrincipal: g13Principal,
      intercept: shearIntercept
    },
    {
      id: 'F23',
      kind: 'shear',
      nPrincipal: f23Principal,
      mPrincipal: g23Principal,
      intercept: shearIntercept
    }
  ];
  if (useTensionCutoff) {
    const tensionCoefficients = tensionSurfacePrincipalCoefficients(branchKind);
    definitions.push({
      id: 'T3',
      kind: 'tension',
      nPrincipal: tensionCoefficients.nPrincipal,
      mPrincipal: tensionCoefficients.mPrincipal,
      intercept: sigmaTAllow
    });
  }
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
  if (hasTension) return YIELD_SURFACE_TENSION;
  if (shearCount >= 3) return YIELD_SURFACE_MC_APEX;
  if (shearCount >= 2) return YIELD_SURFACE_MC_EDGE;
  if (shearCount === 1) return YIELD_SURFACE_MC_FACE;
  return YIELD_SURFACE_NONE;
}

function computeExactElastoplasticTangent(D_e, activeSurfaces, couplingMatrix, materialParameters = null) {
  if (!Array.isArray(activeSurfaces) || activeSurfaces.length === 0) return cloneMatrix6(D_e);
  const inverseCoupling = invertDenseMatrix(couplingMatrix, 1e-12);
  if (!inverseCoupling) return null;
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

function exactMcStressScale(materialParameters, principalValues = [], mcTrial = null) {
  const [s1, s2, s3] = principalValues?.length ? principalValues : [
    Number(mcTrial?.s1) || 0,
    Number(mcTrial?.s2) || 0,
    Number(mcTrial?.s3) || 0
  ];
  const cEff = Math.max(Number(materialParameters?.cEff) || 0, 0);
  const pRef = Math.max(Number(materialParameters?.yieldTolerancePref) || 100, 1e-6);
  return Math.max(Math.abs(s1), Math.abs(s2), Math.abs(s3), cEff, pRef, 1);
}

function resolveCornerStressGapTolerance(materialParameters, principalValues, mcTrial, kind = 'edge') {
  const explicit = kind === 'apex'
    ? Number(materialParameters?.apexStressGapTolerance)
    : Number(materialParameters?.edgeStressGapTolerance);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const stressScale = exactMcStressScale(materialParameters, principalValues, mcTrial);
  const localTol = localReturnTolerance(materialParameters, mcTrial);
  const scale = kind === 'apex' ? 5e-7 : 1e-7;
  const multiplier = kind === 'apex' ? 10 : 5;
  return Math.max(multiplier * localTol, scale * stressScale);
}

function resolveActiveSetComplementarityTolerance(materialParameters, principalValues, mcTrial, edgeTolerance) {
  const explicit = Number(materialParameters?.activeSetComplementarityTolerance);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const stressScale = exactMcStressScale(materialParameters, principalValues, mcTrial);
  const localTol = localReturnTolerance(materialParameters, mcTrial);
  return Math.max(5 * localTol, 1e-7 * stressScale, edgeTolerance);
}

function resolveEigenSubspaceTolerance(materialParameters, principalValues, mcTrial, edgeTolerance) {
  const explicit = Number(materialParameters?.eigenSubspaceTolerance);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return Math.max(Number(materialParameters?.eigTolerance) || 1e-9, edgeTolerance);
}

function resolveApexHydrostaticTolerance(materialParameters, principalValues, mcTrial, apexTolerance) {
  const explicit = Number(materialParameters?.apexHydrostaticTolerance);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const stressScale = exactMcStressScale(materialParameters, principalValues, mcTrial);
  const cohesionScale = Math.max(Number(materialParameters?.cEff) || 0, 0);
  return Math.max(20 * apexTolerance, 0.05 * Math.max(stressScale, cohesionScale, 1));
}

function isTensionBranchKind(branchKind) {
  return (
    branchKind === BRANCH_TENSION_PENDING ||
    branchKind === BRANCH_TENSION_FACE_T3 ||
    branchKind === BRANCH_TENSION_EDGE_T23 ||
    branchKind === BRANCH_TENSION_EDGE_F13_T3 ||
    branchKind === BRANCH_TENSION_CORNER_S23_T3 ||
    branchKind === BRANCH_TENSION_CORNER_S12_T3 ||
    branchKind === BRANCH_TENSION_APEX_T123
  );
}

function isLowerRepeatedBranchKind(branchKind) {
  return (
    branchKind === BRANCH_EDGE_S23_EQUAL ||
    branchKind === BRANCH_TENSION_EDGE_T23 ||
    branchKind === BRANCH_TENSION_CORNER_S23_T3
  );
}

function isUpperRepeatedBranchKind(branchKind) {
  return branchKind === BRANCH_EDGE_S12_EQUAL || branchKind === BRANCH_TENSION_CORNER_S12_T3;
}

function isShearEdgeBranchKind(branchKind) {
  return branchKind === BRANCH_EDGE_S23_EQUAL || branchKind === BRANCH_EDGE_S12_EQUAL;
}

function activeYieldSurfaceFromBranchKind(branchKind) {
  switch (branchKind) {
    case BRANCH_FACE_F13:
      return YIELD_SURFACE_MC_FACE;
    case BRANCH_EDGE_S23_EQUAL:
    case BRANCH_EDGE_S12_EQUAL:
      return YIELD_SURFACE_MC_EDGE;
    case BRANCH_APEX_FORMAL:
      return YIELD_SURFACE_MC_APEX;
    case BRANCH_TENSION_PENDING:
    case BRANCH_TENSION_FACE_T3:
    case BRANCH_TENSION_EDGE_T23:
    case BRANCH_TENSION_EDGE_F13_T3:
    case BRANCH_TENSION_CORNER_S23_T3:
    case BRANCH_TENSION_CORNER_S12_T3:
    case BRANCH_TENSION_APEX_T123:
      return YIELD_SURFACE_TENSION;
    default:
      return YIELD_SURFACE_NONE;
  }
}

function multiplicityKindFromBranchKind(branchKind) {
  switch (branchKind) {
    case BRANCH_EDGE_S23_EQUAL:
    case BRANCH_TENSION_EDGE_T23:
    case BRANCH_TENSION_CORNER_S23_T3:
      return 'S23_EQUAL';
    case BRANCH_EDGE_S12_EQUAL:
    case BRANCH_TENSION_CORNER_S12_T3:
      return 'S12_EQUAL';
    case BRANCH_APEX_FORMAL:
    case BRANCH_TENSION_APEX_T123:
      return 'TRIPLE';
    default:
      return 'DISTINCT';
  }
}

function activeSurfaceIdsForBranchKind(branchKind) {
  switch (branchKind) {
    case BRANCH_FACE_F13:
      return ['F13'];
    case BRANCH_EDGE_S23_EQUAL:
      return ['F12', 'F13'];
    case BRANCH_EDGE_S12_EQUAL:
      return ['F13', 'F23'];
    case BRANCH_APEX_FORMAL:
      return ['F12', 'F13', 'F23'];
    case BRANCH_TENSION_FACE_T3:
      return ['T3'];
    case BRANCH_TENSION_EDGE_T23:
      return ['T3'];
    case BRANCH_TENSION_EDGE_F13_T3:
      return ['F13', 'T3'];
    case BRANCH_TENSION_CORNER_S23_T3:
      return ['F13', 'T3'];
    case BRANCH_TENSION_CORNER_S12_T3:
      return ['F13', 'T3'];
    case BRANCH_TENSION_APEX_T123:
      return ['T3'];
    default:
      return [];
  }
}

function classifyTangentQuality(conditionNumber) {
  if (!Number.isFinite(conditionNumber)) return 'singular';
  if (conditionNumber > 1e12) return 'very-poor';
  if (conditionNumber > 1e9) return 'poor';
  if (conditionNumber > 1e6) return 'fair';
  return 'good';
}

function classifyLocalReturnFailure(local = null) {
  if (!local) return 'unknown';
  if (local?.routePending) return 'pending-tension-handoff';
  const text = String(local?.reason || '').toLowerCase();
  if (!text) return 'unknown';
  if (text.includes('singular')) return 'singular-coupling';
  if (text.includes('branch acceptance failed')) return 'branch-acceptance-failure';
  if (text.includes('surface closure')) return 'surface-closure-failure';
  if (text.includes('gap')) return 'repeated-eigenvalue-closure-failure';
  if (text.includes('tension')) return 'tension-branch-failure';
  if (text.includes('formal apex')) return 'formal-apex-handoff';
  if (text.includes('bad plastic denominator')) return 'bad-plastic-denominator';
  if (text.includes('negative plastic multiplier')) return 'negative-plastic-multiplier';
  if (text.includes('line search')) return 'local-line-search-stall';
  if (text.includes('max local iterations')) return 'local-iteration-budget-exhausted';
  return 'unknown';
}

function exactMcHydrostaticApexStress(materialParameters) {
  const { phi, c } = exactMcSurfaceParameters(materialParameters);
  const tanPhi = Math.tan(phi);
  if (!(Math.abs(tanPhi) > 1e-12)) return null;
  return -(c / tanPhi);
}

function isNearFormalShearApex(principalValues, materialParameters, apexTolerance) {
  const apexStress = exactMcHydrostaticApexStress(materialParameters);
  if (!Number.isFinite(apexStress)) return false;
  return principalValues.every((value) => Math.abs((Number(value) || 0) - apexStress) <= apexTolerance);
}

function representativeBasisPriorityList(materialParameters = {}) {
  const raw = String(materialParameters?.representativeBasisPolicy || 'committed-trial-canonical')
    .split(/[^a-zA-Z]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  const unique = [];
  raw.forEach((token) => {
    if (['committed', 'trial', 'canonical'].includes(token) && !unique.includes(token)) unique.push(token);
  });
  if (!unique.length) return ['committed', 'trial', 'canonical'];
  if (!unique.includes('canonical')) unique.push('canonical');
  return unique;
}

function directionCandidatesFromCommittedState(committedState, multiplicityKind) {
  const projectors = committedState?.representativeProjectors;
  if (!projectors) return [];
  if (multiplicityKind === 'S23_EQUAL') {
    return [projectors.P2, projectors.P3]
      .filter(Boolean)
      .map((projector) => rankOneProjectorToDirection(projector, [0, 1, 0]));
  }
  if (multiplicityKind === 'S12_EQUAL') {
    return [projectors.P1, projectors.P2]
      .filter(Boolean)
      .map((projector) => rankOneProjectorToDirection(projector, [1, 0, 0]));
  }
  return [projectors.P1, projectors.P2, projectors.P3]
    .filter(Boolean)
    .map((projector) => rankOneProjectorToDirection(projector, [1, 0, 0]));
}

function chooseProjectedDirection(subspaceProjector, candidateDirections, orthogonalTo = [], tolerance = 1e-10) {
  const forbidden = Array.isArray(orthogonalTo) ? orthogonalTo : [orthogonalTo];
  for (const candidate of candidateDirections) {
    if (!candidate) continue;
    let projected = multiplyMatrix3x3Vector3(subspaceProjector, candidate);
    forbidden.forEach((direction) => {
      const norm = vectorNorm3(direction);
      if (!(norm > tolerance)) return;
      const normalized = scaleVector3(direction, 1 / norm);
      projected = subtractVector3(projected, scaleVector3(normalized, dotVector3(projected, normalized)));
    });
    const norm = vectorNorm3(projected);
    if (norm > tolerance) return scaleVector3(projected, 1 / norm);
  }
  return null;
}

function buildRepeatedSubspaceProjectors(principalState, branchKind, committedState, materialParameters, tolerance) {
  if (!isLowerRepeatedBranchKind(branchKind) && !isUpperRepeatedBranchKind(branchKind)) {
    return {
      representativeBasisSource: 'trial',
      representativeProjectors: {
        P1: cloneMatrix3(principalState?.P1),
        P2: cloneMatrix3(principalState?.P2),
        P3: cloneMatrix3(principalState?.P3)
      }
    };
  }

  const priority = representativeBasisPriorityList(materialParameters);
  const multiplicityKind = multiplicityKindFromBranchKind(branchKind);
  const repeatedProjector = isLowerRepeatedBranchKind(branchKind)
    ? addMatrix3(principalState?.P2, principalState?.P3)
    : addMatrix3(principalState?.P1, principalState?.P2);
  const distinctDirection = isLowerRepeatedBranchKind(branchKind)
    ? rankOneProjectorToDirection(principalState?.P1, [1, 0, 0])
    : rankOneProjectorToDirection(principalState?.P3, [0, 0, 1]);
  const trialSeeds = isLowerRepeatedBranchKind(branchKind)
    ? [
        rankOneProjectorToDirection(principalState?.P2, [0, 1, 0]),
        rankOneProjectorToDirection(principalState?.P3, [0, 0, 1])
      ]
    : [
        rankOneProjectorToDirection(principalState?.P1, [1, 0, 0]),
        rankOneProjectorToDirection(principalState?.P2, [0, 1, 0])
      ];
  const canonicalSeeds = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];

  let sourceUsed = 'canonical';
  let primaryRepeatedDirection = null;
  for (const source of priority) {
    const seeds = source === 'committed'
      ? directionCandidatesFromCommittedState(committedState, multiplicityKind)
      : source === 'trial'
        ? trialSeeds
        : canonicalSeeds;
    primaryRepeatedDirection = chooseProjectedDirection(repeatedProjector, seeds, [distinctDirection], tolerance);
    if (primaryRepeatedDirection) {
      sourceUsed = source;
      break;
    }
  }
  if (!primaryRepeatedDirection) {
    primaryRepeatedDirection = chooseProjectedDirection(repeatedProjector, canonicalSeeds, [distinctDirection], tolerance)
      || (isLowerRepeatedBranchKind(branchKind) ? [0, 1, 0] : [1, 0, 0]);
    sourceUsed = 'canonical';
  }

  let secondaryDirection = crossVector3(distinctDirection, primaryRepeatedDirection);
  secondaryDirection = chooseProjectedDirection(repeatedProjector, [secondaryDirection, ...canonicalSeeds], [distinctDirection, primaryRepeatedDirection], tolerance)
    || normalizeVector3(crossVector3(distinctDirection, primaryRepeatedDirection), isLowerRepeatedBranchKind(branchKind) ? [0, 0, 1] : [0, 1, 0]);

  if (isLowerRepeatedBranchKind(branchKind)) {
    return {
      representativeBasisSource: sourceUsed,
      representativeProjectors: {
        P1: cloneMatrix3(principalState?.P1),
        P2: principalDirectionToProjector(primaryRepeatedDirection),
        P3: principalDirectionToProjector(secondaryDirection),
        P23: cloneMatrix3(repeatedProjector)
      }
    };
  }
  return {
    representativeBasisSource: sourceUsed,
    representativeProjectors: {
      P1: principalDirectionToProjector(primaryRepeatedDirection),
      P2: principalDirectionToProjector(secondaryDirection),
      P3: cloneMatrix3(principalState?.P3),
      P12: cloneMatrix3(repeatedProjector)
    }
  };
}

function buildSurfaceMapForProjectors(projectors, materialParameters, branchKind = null) {
  const surfaces = buildExactMcSurfaces(projectors, materialParameters, branchKind);
  return {
    surfaces,
    surfaceMap: Object.fromEntries(surfaces.map((surface) => [surface.id, surface]))
  };
}

function buildStressTensorProjectorsForBranch(branchKind, representativeProjectors) {
  if (isLowerRepeatedBranchKind(branchKind)) {
    return {
      P1: cloneMatrix3(representativeProjectors?.P1),
      P2: cloneMatrix3(representativeProjectors?.P2),
      P3: cloneMatrix3(representativeProjectors?.P3)
    };
  }
  if (isUpperRepeatedBranchKind(branchKind)) {
    return {
      P1: cloneMatrix3(representativeProjectors?.P1),
      P2: cloneMatrix3(representativeProjectors?.P2),
      P3: cloneMatrix3(representativeProjectors?.P3)
    };
  }
  return {
    P1: cloneMatrix3(representativeProjectors?.P1),
    P2: cloneMatrix3(representativeProjectors?.P2),
    P3: cloneMatrix3(representativeProjectors?.P3)
  };
}

function representedPrincipalValuesForBranch(branchKind, principalValues) {
  const [s1, s2, s3] = cloneVector3(principalValues);
  if (isLowerRepeatedBranchKind(branchKind)) {
    const repeated = 0.5 * (s2 + s3);
    return [s1, repeated, repeated];
  }
  if (isUpperRepeatedBranchKind(branchKind)) {
    const repeated = 0.5 * (s1 + s2);
    return [repeated, repeated, s3];
  }
  if (branchKind === BRANCH_APEX_FORMAL || branchKind === BRANCH_TENSION_APEX_T123) {
    const repeated = (s1 + s2 + s3) / 3;
    return [repeated, repeated, repeated];
  }
  return [s1, s2, s3];
}

function evaluatePrincipalSurfaceValue(surface, principalValues) {
  if (!surface) return 0;
  return dotVector3(surface.nPrincipal, principalValues) - (Number(surface.intercept) || 0);
}

function solveExactMcActiveSystemPrincipal(trialPrincipalValues, activeSurfaceIds, principalSurfaceMap, D_n, complementarityTolerance) {
  const activeSurfaces = activeSurfaceIds.map((id) => principalSurfaceMap?.[id]).filter(Boolean);
  const couplingMatrix = activeSurfaces.map((surfaceI) =>
    activeSurfaces.map((surfaceJ) => dotVector3(surfaceI.nPrincipal, multiplyMatrix3x3Vector3(D_n, surfaceJ.mPrincipal)))
  );
  const rhs = activeSurfaces.map((surface) => evaluatePrincipalSurfaceValue(surface, trialPrincipalValues));
  const plasticMultipliers = solveDenseLinearSystem(couplingMatrix, rhs, 1e-12);
  const conditionNumber = denseMatrixConditionNumberEstimate(couplingMatrix, 1e-12);
  if (!plasticMultipliers) {
    return {
      converged: false,
      reason: `local exact MC active-set solve became singular on ${activeSurfaceIds.join('|') || 'EMPTY'}`,
      conditionNumber
    };
  }
  const minMultiplier = Math.min(...plasticMultipliers.map((value) => Number(value) || 0));
  if (minMultiplier < -complementarityTolerance) {
    return {
      converged: false,
      reason: `negative plastic multiplier on ${activeSurfaceIds.join('|') || 'EMPTY'}`,
      conditionNumber,
      plasticMultipliers
    };
  }
  const plasticFlowPrincipal = activeSurfaces.reduce(
    (sum, surface, index) => addVector3(sum, scaleVector3(surface.mPrincipal, Number(plasticMultipliers?.[index]) || 0)),
    [0, 0, 0]
  );
  const stressCorrectionPrincipal = multiplyMatrix3x3Vector3(D_n, plasticFlowPrincipal);
  return {
    converged: true,
    plasticMultipliers,
    couplingMatrix,
    conditionNumber,
    stressReturnPrincipal: subtractVector3(trialPrincipalValues, stressCorrectionPrincipal)
  };
}

function classifyTrialBranchKind(principalTrialValues, trialSurfaceValues, edgeTolerance, apexTolerance, materialParameters) {
  const [s1, s2, s3] = cloneVector3(principalTrialValues);
  const gap12 = Math.abs(s1 - s2);
  const gap23 = Math.abs(s2 - s3);
  const f12 = Number(trialSurfaceValues?.F12) || 0;
  const f13 = Number(trialSurfaceValues?.F13) || 0;
  const f23 = Number(trialSurfaceValues?.F23) || 0;
  const t3 = Number(trialSurfaceValues?.T3) || 0;
  if (exactMcSurfaceParameters(materialParameters).useTensionCutoff && t3 > 0) {
    if (gap12 <= apexTolerance && gap23 <= apexTolerance) return BRANCH_TENSION_APEX_T123;
    if (gap23 <= edgeTolerance && f13 > 0) return BRANCH_TENSION_CORNER_S23_T3;
    if (gap23 <= edgeTolerance) return BRANCH_TENSION_EDGE_T23;
    if (f13 > 0 && (gap12 <= edgeTolerance || f23 > 0)) return BRANCH_TENSION_CORNER_S12_T3;
    if (f13 > 0) return BRANCH_TENSION_EDGE_F13_T3;
    return BRANCH_TENSION_FACE_T3;
  }
  if (gap12 <= apexTolerance && gap23 <= apexTolerance && isNearFormalShearApex(principalTrialValues, materialParameters, apexTolerance)) {
    return materialParameters?.allowFormalApexBranch === true ? BRANCH_APEX_FORMAL : BRANCH_TENSION_PENDING;
  }
  if (gap23 <= edgeTolerance || (f12 > 0 && f13 > 0)) return BRANCH_EDGE_S23_EQUAL;
  if (gap12 <= edgeTolerance || (f13 > 0 && f23 > 0)) return BRANCH_EDGE_S12_EQUAL;
  if (f13 > 0) return BRANCH_FACE_F13;
  return BRANCH_ELASTIC;
}

function buildExactMcPendingTensionResult(branchKind, stressTrial6, elasticTangent6x6, trialSurfaceValues, options = {}) {
  const maxResidual = Math.max(...Object.values(trialSurfaceValues || {}).map((value) => Number(value) || 0), 0);
  return {
    converged: true,
    iterations: 0,
    stress6: cloneVector6(stressTrial6),
    plasticStrainIncrement6: zeroVector6(),
    algorithmicTangent6x6: cloneMatrix6(elasticTangent6x6),
    activeYieldSurface: YIELD_SURFACE_TENSION,
    activeSurfaceIds: [],
    activeSetIds: [],
    yieldResidual: maxResidual,
    trialBranchKind: options.trialBranchKind || branchKind,
    acceptedBranchKind: branchKind,
    branchKind,
    trialMultiplicityKind: options.trialMultiplicityKind || multiplicityKindFromBranchKind(branchKind),
    finalMultiplicityKind: multiplicityKindFromBranchKind(branchKind),
    representativeBasisSource: options.representativeBasisSource || 'trial',
    tangentConditionNumber: Number.POSITIVE_INFINITY,
    tangentQuality: 'pending-tension',
    branchAcceptanceResidual: maxResidual,
    apexAdmissibilityReason: options.apexAdmissibilityReason || 'pending-tension-cutoff-stage',
    localResidualsBySurface: { ...(trialSurfaceValues || {}) },
    edgeTotalMultiplier: 0,
    edgeMixWeight: 0,
    plasticMultipliers: [],
    exactSurfaceValues: { ...(trialSurfaceValues || {}) }
  };
}

function solveExactMcCandidateBranch(
  branchKind,
  stressTrial6,
  trialPrincipal,
  elasticTangent6x6,
  materialParameters,
  mcTrial,
  committedState,
  toleranceState
) {
  const trialPrincipalValues = [trialPrincipal.s1, trialPrincipal.s2, trialPrincipal.s3];
  const trialSurfaceValues = evaluateExactMcSurfaceValuesFromPrincipal(trialPrincipalValues, materialParameters);
  const activeSurfaceIds = activeSurfaceIdsForBranchKind(branchKind);
  if (!activeSurfaceIds.length) {
    return {
      converged: false,
      reason: `no active surfaces were defined for branch ${branchKind}`
    };
  }
  if (branchKind === BRANCH_APEX_FORMAL) {
    const { sinPsi } = exactMcSurfaceParameters(materialParameters);
    if (materialParameters?.allowFormalApexBranch !== true) {
      return {
        converged: false,
        routePending: true,
        reason: 'formal apex branch disabled',
        apexAdmissibilityReason: 'formal-apex-disabled'
      };
    }
    if (!(Math.abs(sinPsi) > 1e-12)) {
      return {
        converged: false,
        routePending: true,
        reason: 'formal apex branch is rank-deficient when psi = 0',
        apexAdmissibilityReason: 'apex_potential_rank_deficient'
      };
    }
  }

  const complementarityTolerance = resolveActiveSetComplementarityTolerance(
    materialParameters,
    trialPrincipalValues,
    mcTrial,
    toleranceState.edgeTolerance
  );
  const D_n = principalElasticMatrix3x3(materialParameters);
  const trialSurfaceMap = buildSurfaceMapForProjectors(trialPrincipal, materialParameters, branchKind).surfaceMap;
  const representative = buildRepeatedSubspaceProjectors(
    trialPrincipal,
    branchKind,
    committedState,
    materialParameters,
    toleranceState.eigenSubspaceTolerance
  );
  const representativeProjectors = representative.representativeProjectors;
  const representativeSurfaceBundle = buildSurfaceMapForProjectors(representativeProjectors, materialParameters, branchKind);
  const principalSolve = solveExactMcActiveSystemPrincipal(
    trialPrincipalValues,
    activeSurfaceIds,
    trialSurfaceMap,
    D_n,
    complementarityTolerance
  );
  if (!principalSolve?.converged) {
    return {
      ...principalSolve,
      representativeBasisSource: representative.representativeBasisSource,
      activeSurfaceIds
    };
  }

  const representedPrincipalValues = representedPrincipalValuesForBranch(branchKind, principalSolve.stressReturnPrincipal);
  if (
    branchKind === BRANCH_APEX_FORMAL &&
    isNearFormalShearApex(representedPrincipalValues, materialParameters, toleranceState.apexTolerance) &&
    (materialParameters?.allowFormalApexBranch !== true || !(Math.abs(exactMcSurfaceParameters(materialParameters).sinPsi) > 1e-12))
  ) {
    return {
      converged: false,
      routePending: true,
      reason: 'formal apex branch rerouted to pending tension/tension-cutoff stage',
      apexAdmissibilityReason: 'formal-apex-rerouted'
    };
  }

  const stressTensorProjectors = buildStressTensorProjectorsForBranch(branchKind, representativeProjectors);
  const stressReturn6 = compressionPositiveTensor3ToStress6(
    projectorsToCompressionPositiveStressTensor(representedPrincipalValues, stressTensorProjectors)
  );
  const representativeSurfaceMap = representativeSurfaceBundle.surfaceMap;
  const activeRepresentativeSurfaces = activeSurfaceIds.map((id) => representativeSurfaceMap[id]).filter(Boolean);
  const plasticStrainIncrement6 = activeRepresentativeSurfaces.reduce(
    (sum, surface, index) => addVector6(sum, scaleVector6(surface.m6, Number(principalSolve.plasticMultipliers?.[index]) || 0)),
    zeroVector6()
  );
  const tangentCouplingMatrix = activeRepresentativeSurfaces.map((surfaceI) =>
    activeRepresentativeSurfaces.map((surfaceJ) => dotVector6(surfaceI.n6, multiplyMatrix6x6Vector6(elasticTangent6x6, surfaceJ.m6)))
  );
  const tangentConditionNumber = denseMatrixConditionNumberEstimate(tangentCouplingMatrix, 1e-12);
  const exactCurrent = evaluateExactMcSurfaceValuesFromStress(stressReturn6, materialParameters);
  const exactValues = exactCurrent?.values || {};
  const maxPositiveResidual = Math.max(...Object.values(exactValues).map((value) => Number(value) || 0), 0);
  const activeResidual = Math.max(
    0,
    ...activeSurfaceIds.map((id) => Math.abs(Number(exactValues?.[id]) || 0))
  );
  const inactivePositiveResidual = Math.max(
    0,
    ...Object.entries(exactValues)
      .filter(([id]) => !activeSurfaceIds.includes(id))
      .map(([_id, value]) => Math.max(Number(value) || 0, 0))
  );
  const principalFinal = exactCurrent?.principal || principalStressProjectors3DCompressionPositive(stressReturn6, materialParameters);
  const gap12 = Math.abs((Number(principalFinal?.s1) || 0) - (Number(principalFinal?.s2) || 0));
  const gap23 = Math.abs((Number(principalFinal?.s2) || 0) - (Number(principalFinal?.s3) || 0));
  const edgeTotalMultiplier = isShearEdgeBranchKind(branchKind)
    ? principalSolve.plasticMultipliers.reduce((sum, value) => sum + Math.max(Number(value) || 0, 0), 0)
    : 0;
  const edgeMixWeight = isShearEdgeBranchKind(branchKind) && edgeTotalMultiplier > 0
    ? Math.max(0, Math.min(1, (Number(principalSolve.plasticMultipliers?.[0]) || 0) / edgeTotalMultiplier))
    : 0;
  const branchAcceptanceResidual = Math.max(activeResidual, inactivePositiveResidual, maxPositiveResidual);

  if (activeResidual > toleranceState.localTolerance || inactivePositiveResidual > toleranceState.localTolerance) {
    return {
      converged: false,
      reason: `branch ${branchKind} did not satisfy exact MC surface closure`,
      activeSurfaceIds,
      branchAcceptanceResidual,
      localResidualsBySurface: { ...exactValues },
      representativeBasisSource: representative.representativeBasisSource
    };
  }

  if (branchKind === BRANCH_FACE_F13) {
    if (gap23 <= toleranceState.edgeTolerance) {
      return {
        converged: false,
        promoteToBranchKind: BRANCH_EDGE_S23_EQUAL,
        reason: 'face return closed the s2-s3 gap below edge tolerance',
        branchAcceptanceResidual,
        activeSurfaceIds,
        localResidualsBySurface: { ...exactValues },
        representativeBasisSource: representative.representativeBasisSource
      };
    }
    if (gap12 <= toleranceState.edgeTolerance) {
      return {
        converged: false,
        promoteToBranchKind: BRANCH_EDGE_S12_EQUAL,
        reason: 'face return closed the s1-s2 gap below edge tolerance',
        branchAcceptanceResidual,
        activeSurfaceIds,
        localResidualsBySurface: { ...exactValues },
        representativeBasisSource: representative.representativeBasisSource
      };
    }
  }
  if (branchKind === BRANCH_TENSION_FACE_T3 && gap23 <= toleranceState.edgeTolerance) {
    return {
      converged: false,
      promoteToBranchKind: BRANCH_TENSION_EDGE_T23,
      reason: 'tension face return closed the s2-s3 gap below edge tolerance',
      branchAcceptanceResidual,
      activeSurfaceIds,
      localResidualsBySurface: { ...exactValues },
      representativeBasisSource: representative.representativeBasisSource
    };
  }
  if (branchKind === BRANCH_TENSION_EDGE_F13_T3) {
    if (gap23 <= toleranceState.edgeTolerance) {
      return {
        converged: false,
        promoteToBranchKind: BRANCH_TENSION_CORNER_S23_T3,
        reason: 'tension edge return closed the s2-s3 gap below edge tolerance',
        branchAcceptanceResidual,
        activeSurfaceIds,
        localResidualsBySurface: { ...exactValues },
        representativeBasisSource: representative.representativeBasisSource
      };
    }
    if (gap12 <= toleranceState.edgeTolerance) {
      return {
        converged: false,
        promoteToBranchKind: BRANCH_TENSION_CORNER_S12_T3,
        reason: 'tension edge return closed the s1-s2 gap below edge tolerance',
        branchAcceptanceResidual,
        activeSurfaceIds,
        localResidualsBySurface: { ...exactValues },
        representativeBasisSource: representative.representativeBasisSource
      };
    }
  }
  if (branchKind === BRANCH_TENSION_EDGE_T23) {
    if (gap23 > toleranceState.edgeTolerance) {
      return {
        converged: false,
        reason: 'lower repeated tension branch did not close the s2-s3 gap inside edge tolerance',
        branchAcceptanceResidual,
        activeSurfaceIds,
        localResidualsBySurface: { ...exactValues },
        representativeBasisSource: representative.representativeBasisSource
      };
    }
    if (gap12 <= toleranceState.edgeTolerance) {
      return {
        converged: false,
        promoteToBranchKind: BRANCH_TENSION_APEX_T123,
        reason: 'lower tension edge return closed the s1-s2 gap below edge tolerance',
        branchAcceptanceResidual,
        activeSurfaceIds,
        localResidualsBySurface: { ...exactValues },
        representativeBasisSource: representative.representativeBasisSource
      };
    }
  }
  if (branchKind === BRANCH_EDGE_S23_EQUAL && gap23 > toleranceState.edgeTolerance) {
    return {
      converged: false,
      reason: 'lower edge return did not close the s2-s3 gap inside edge tolerance',
      branchAcceptanceResidual,
      activeSurfaceIds,
      localResidualsBySurface: { ...exactValues },
      representativeBasisSource: representative.representativeBasisSource
    };
  }
  if (branchKind === BRANCH_EDGE_S12_EQUAL && gap12 > toleranceState.edgeTolerance) {
    return {
      converged: false,
      reason: 'upper edge return did not close the s1-s2 gap inside edge tolerance',
      branchAcceptanceResidual,
      activeSurfaceIds,
      localResidualsBySurface: { ...exactValues },
      representativeBasisSource: representative.representativeBasisSource
    };
  }
  if (branchKind === BRANCH_TENSION_CORNER_S23_T3 && gap23 > toleranceState.edgeTolerance) {
    return {
      converged: false,
      reason: 'lower tension corner return did not close the s2-s3 gap inside edge tolerance',
      branchAcceptanceResidual,
      activeSurfaceIds,
      localResidualsBySurface: { ...exactValues },
      representativeBasisSource: representative.representativeBasisSource
    };
  }
  if (branchKind === BRANCH_TENSION_CORNER_S12_T3 && gap12 > toleranceState.edgeTolerance) {
    return {
      converged: false,
      reason: 'upper tension corner return did not close the s1-s2 gap inside edge tolerance',
      branchAcceptanceResidual,
      activeSurfaceIds,
      localResidualsBySurface: { ...exactValues },
      representativeBasisSource: representative.representativeBasisSource
    };
  }
  if (branchKind === BRANCH_TENSION_APEX_T123 && (gap12 > toleranceState.apexTolerance || gap23 > toleranceState.apexTolerance)) {
    return {
      converged: false,
      reason: 'tension apex return did not collapse the three principal stresses inside apex tolerance',
      branchAcceptanceResidual,
      activeSurfaceIds,
      localResidualsBySurface: { ...exactValues },
      representativeBasisSource: representative.representativeBasisSource
    };
  }
  if (
    (branchKind === BRANCH_EDGE_S23_EQUAL || branchKind === BRANCH_EDGE_S12_EQUAL || branchKind === BRANCH_FACE_F13) &&
    gap12 <= toleranceState.apexTolerance &&
    gap23 <= toleranceState.apexTolerance &&
    isNearFormalShearApex(
      [principalFinal?.s1, principalFinal?.s2, principalFinal?.s3],
      materialParameters,
      toleranceState.apexHydrostaticTolerance || toleranceState.apexTolerance
    ) &&
    exactMcSurfaceParameters(materialParameters).useTensionCutoff !== true &&
    (materialParameters?.allowFormalApexBranch !== true || !(Math.abs(exactMcSurfaceParameters(materialParameters).sinPsi) > 1e-12))
  ) {
    return {
      converged: false,
      routePending: true,
      reason: 'returned stress lies near the formal MC shear apex and must hand off to pending tension handling',
      apexAdmissibilityReason: 'formal-apex-near-tension-region'
    };
  }

  const algorithmicTangent6x6 = computeExactElastoplasticTangent(
    elasticTangent6x6,
    activeRepresentativeSurfaces,
    tangentCouplingMatrix,
    materialParameters
  );
  if (!algorithmicTangent6x6) {
    return {
      converged: false,
      reason: `branch ${branchKind} produced a singular elastoplastic tangent coupling matrix`,
      activeSurfaceIds,
      branchAcceptanceResidual,
      localResidualsBySurface: { ...exactValues },
      representativeBasisSource: representative.representativeBasisSource,
      tangentConditionNumber,
      tangentQuality: 'singular'
    };
  }

  return {
    converged: true,
    iterations: 1,
    stress6: stressReturn6,
    plasticStrainIncrement6,
    algorithmicTangent6x6,
    activeYieldSurface: activeYieldSurfaceFromBranchKind(branchKind),
    activeSurfaceIds,
    yieldResidual: maxPositiveResidual,
    trialBranchKind: null,
    acceptedBranchKind: branchKind,
    branchKind,
    representativeBasisSource: representative.representativeBasisSource,
    representativeProjectors,
    trialMultiplicityKind: null,
    finalMultiplicityKind: multiplicityKindFromBranchKind(branchKind),
    edgeTotalMultiplier,
    edgeMixWeight,
    plasticMultipliers: principalSolve.plasticMultipliers.map((value) => Math.max(Number(value) || 0, 0)),
    tangentConditionNumber,
    tangentQuality: classifyTangentQuality(tangentConditionNumber),
    branchAcceptanceResidual,
    apexAdmissibilityReason: branchKind === BRANCH_APEX_FORMAL ? 'formal-apex-accepted' : '',
    localResidualsBySurface: { ...exactValues }
  };
}

function solveExactMcActiveSetReturn(stressTrial6, elasticTangent6x6, materialParameters, mcTrial, committedState = null) {
  const tolerance = localReturnTolerance(materialParameters, mcTrial);
  const principalTrial = principalStressProjectors3DCompressionPositive(stressTrial6, materialParameters);
  const trialPrincipalValues = [principalTrial.s1, principalTrial.s2, principalTrial.s3];
  const trialSurfaceValues = evaluateExactMcSurfaceValuesFromPrincipal(trialPrincipalValues, materialParameters);
  const maxTrialResidual = Math.max(...Object.values(trialSurfaceValues).map((value) => Number(value) || 0), 0);
  const edgeTolerance = resolveCornerStressGapTolerance(materialParameters, trialPrincipalValues, mcTrial, 'edge');
  const apexTolerance = resolveCornerStressGapTolerance(materialParameters, trialPrincipalValues, mcTrial, 'apex');
  const apexHydrostaticTolerance = resolveApexHydrostaticTolerance(materialParameters, trialPrincipalValues, mcTrial, apexTolerance);
  const eigenSubspaceTolerance = resolveEigenSubspaceTolerance(materialParameters, trialPrincipalValues, mcTrial, edgeTolerance);
  const toleranceState = {
    localTolerance: tolerance,
    edgeTolerance,
    apexTolerance,
    apexHydrostaticTolerance,
    eigenSubspaceTolerance
  };
  if (!(maxTrialResidual > tolerance)) {
    if (
      activeSurfaceIdsForBranchKind(committedState?.exactBranchKind).length &&
      committedState?.activeYieldSurface !== YIELD_SURFACE_NONE
    ) {
      const retainedBranch = solveExactMcCandidateBranch(
        committedState.exactBranchKind,
        stressTrial6,
        principalTrial,
        elasticTangent6x6,
        materialParameters,
        mcTrial,
        committedState,
        toleranceState
      );
      if (retainedBranch?.converged) {
        retainedBranch.iterations = 0;
        retainedBranch.trialBranchKind = committedState.exactBranchKind;
        retainedBranch.trialMultiplicityKind = committedState.multiplicityKind || multiplicityKindFromBranchKind(committedState.exactBranchKind);
        return retainedBranch;
      }
    }
    return {
      converged: true,
      iterations: 0,
      stress6: cloneVector6(stressTrial6),
      plasticStrainIncrement6: zeroVector6(),
      algorithmicTangent6x6: cloneMatrix6(elasticTangent6x6),
      activeYieldSurface: YIELD_SURFACE_NONE,
      activeSurfaceIds: [],
      yieldResidual: maxTrialResidual,
      trialBranchKind: BRANCH_ELASTIC,
      acceptedBranchKind: BRANCH_ELASTIC,
      branchKind: BRANCH_ELASTIC,
      representativeBasisSource: 'trial',
      representativeProjectors: cloneRepresentativeProjectors({
        P1: principalTrial.P1,
        P2: principalTrial.P2,
        P3: principalTrial.P3
      }),
      trialMultiplicityKind: 'DISTINCT',
      finalMultiplicityKind: 'DISTINCT',
      edgeTotalMultiplier: 0,
      edgeMixWeight: 0,
      plasticMultipliers: [],
      tangentConditionNumber: 1,
      tangentQuality: 'good',
      branchAcceptanceResidual: maxTrialResidual,
      apexAdmissibilityReason: '',
      localResidualsBySurface: { ...trialSurfaceValues }
    };
  }
  const gap12Trial = Math.abs(principalTrial.s1 - principalTrial.s2);
  const gap23Trial = Math.abs(principalTrial.s2 - principalTrial.s3);
  const trialBranchKind = classifyTrialBranchKind(trialPrincipalValues, trialSurfaceValues, edgeTolerance, apexTolerance, materialParameters);
  const trialMultiplicityKind = multiplicityKindFromBranchKind(trialBranchKind);
  const { useTensionCutoff } = exactMcSurfaceParameters(materialParameters);
  const tensionViolated = useTensionCutoff && (Number(trialSurfaceValues?.T3) || 0) > tolerance;
  const nearFormalApex = gap12Trial <= apexTolerance &&
    gap23Trial <= apexTolerance &&
    isNearFormalShearApex(trialPrincipalValues, materialParameters, apexHydrostaticTolerance);

  if (nearFormalApex && materialParameters?.allowFormalApexBranch !== true && !tensionViolated) {
    return buildExactMcPendingTensionResult(
      BRANCH_TENSION_PENDING,
      stressTrial6,
      elasticTangent6x6,
      trialSurfaceValues,
      {
        trialBranchKind,
        trialMultiplicityKind,
        apexAdmissibilityReason: 'formal-apex-disabled-or-deferred-to-tension-stage'
      }
    );
  }

  const preferredCandidates = [];
  const committedBranch = committedState?.exactBranchKind;
  const directLowerEdge = gap23Trial <= edgeTolerance || ((Number(trialSurfaceValues?.F12) || 0) > tolerance && (Number(trialSurfaceValues?.F13) || 0) > tolerance);
  const directUpperEdge = gap12Trial <= edgeTolerance || ((Number(trialSurfaceValues?.F13) || 0) > tolerance && (Number(trialSurfaceValues?.F23) || 0) > tolerance);
  const committedPrefLower = committedBranch === BRANCH_EDGE_S23_EQUAL && gap23Trial <= 2 * edgeTolerance;
  const committedPrefUpper = committedBranch === BRANCH_EDGE_S12_EQUAL && gap12Trial <= 2 * edgeTolerance;
  const directTensionApex = tensionViolated && gap12Trial <= apexTolerance && gap23Trial <= apexTolerance;
  const directLowerTensionEdge = tensionViolated && gap23Trial <= edgeTolerance;
  const directLowerTensionCorner = tensionViolated && gap23Trial <= edgeTolerance && (Number(trialSurfaceValues?.F13) || 0) > tolerance;
  const directUpperTensionCorner = tensionViolated && (gap12Trial <= edgeTolerance || (Number(trialSurfaceValues?.F23) || 0) > tolerance);
  const committedPrefTensionApex = committedBranch === BRANCH_TENSION_APEX_T123;
  const committedPrefLowerTensionEdge = committedBranch === BRANCH_TENSION_EDGE_T23 && gap23Trial <= 2 * edgeTolerance;
  const committedPrefLowerTensionCorner = committedBranch === BRANCH_TENSION_CORNER_S23_T3 && gap23Trial <= 2 * edgeTolerance;
  const committedPrefUpperTensionCorner = committedBranch === BRANCH_TENSION_CORNER_S12_T3 && gap12Trial <= 2 * edgeTolerance;
  const committedPrefTensionEdge = committedBranch === BRANCH_TENSION_EDGE_F13_T3 && (
    (Number(trialSurfaceValues?.F13) || 0) > -2 * tolerance || nearFormalApex
  );
  const committedPrefTensionFace = committedBranch === BRANCH_TENSION_FACE_T3;

  function pushCandidate(kind) {
    if (!kind || preferredCandidates.includes(kind)) return;
    preferredCandidates.push(kind);
  }

  function pushShearCandidates() {
    if (nearFormalApex && materialParameters?.allowFormalApexBranch === true) pushCandidate(BRANCH_APEX_FORMAL);
    if (committedPrefLower) pushCandidate(BRANCH_EDGE_S23_EQUAL);
    if (committedPrefUpper) pushCandidate(BRANCH_EDGE_S12_EQUAL);
    if (directLowerEdge) pushCandidate(BRANCH_EDGE_S23_EQUAL);
    if (directUpperEdge) pushCandidate(BRANCH_EDGE_S12_EQUAL);
    if ((Number(trialSurfaceValues?.F13) || 0) > tolerance) pushCandidate(BRANCH_FACE_F13);
  }
  function pushTensionCandidates() {
    if (committedPrefTensionApex) pushCandidate(BRANCH_TENSION_APEX_T123);
    if (directTensionApex) pushCandidate(BRANCH_TENSION_APEX_T123);
    if (committedPrefLowerTensionEdge) pushCandidate(BRANCH_TENSION_EDGE_T23);
    if (committedPrefLowerTensionCorner) pushCandidate(BRANCH_TENSION_CORNER_S23_T3);
    if (committedPrefUpperTensionCorner) pushCandidate(BRANCH_TENSION_CORNER_S12_T3);
    if (directLowerTensionEdge) pushCandidate(BRANCH_TENSION_EDGE_T23);
    if (directLowerTensionCorner) pushCandidate(BRANCH_TENSION_CORNER_S23_T3);
    if (directUpperTensionCorner) pushCandidate(BRANCH_TENSION_CORNER_S12_T3);
    if (committedPrefTensionEdge || (Number(trialSurfaceValues?.F13) || 0) > tolerance || nearFormalApex) {
      pushCandidate(BRANCH_TENSION_EDGE_F13_T3);
      if (committedPrefTensionFace) pushCandidate(BRANCH_TENSION_FACE_T3);
    } else {
      if (committedPrefTensionFace) pushCandidate(BRANCH_TENSION_FACE_T3);
      pushCandidate(BRANCH_TENSION_FACE_T3);
      pushCandidate(BRANCH_TENSION_EDGE_F13_T3);
    }
    pushCandidate(BRANCH_TENSION_FACE_T3);
    pushCandidate(BRANCH_TENSION_EDGE_T23);
    pushCandidate(BRANCH_TENSION_EDGE_F13_T3);
    pushCandidate(BRANCH_TENSION_CORNER_S23_T3);
    pushCandidate(BRANCH_TENSION_CORNER_S12_T3);
    pushCandidate(BRANCH_TENSION_APEX_T123);
  }

  if (tensionViolated) {
    const shearSeverity = Math.max(
      Number(trialSurfaceValues?.F12) || 0,
      Number(trialSurfaceValues?.F13) || 0,
      Number(trialSurfaceValues?.F23) || 0,
      0
    );
    const tensionSeverity = Math.max(
      Number(trialSurfaceValues?.T3) || 0,
      0
    );
    if (shearSeverity >= tensionSeverity) {
      pushShearCandidates();
      pushTensionCandidates();
    } else {
      pushTensionCandidates();
      pushShearCandidates();
    }
  } else {
    pushShearCandidates();
  }
  if (!preferredCandidates.length) pushCandidate(trialBranchKind === BRANCH_ELASTIC ? BRANCH_FACE_F13 : trialBranchKind);

  const attempted = new Map();
  const failureReasons = [];
  for (let index = 0; index < preferredCandidates.length; index += 1) {
    const candidateKind = preferredCandidates[index];
    if (attempted.has(candidateKind)) continue;
    attempted.set(candidateKind, true);
    const candidate = solveExactMcCandidateBranch(
      candidateKind,
      stressTrial6,
      principalTrial,
      elasticTangent6x6,
      materialParameters,
      mcTrial,
      committedState,
      toleranceState
    );
    if (candidate?.converged) {
      candidate.iterations = 1;
      candidate.trialBranchKind = trialBranchKind;
      candidate.trialMultiplicityKind = trialMultiplicityKind;
      return candidate;
    }
    if (candidate?.routePending) {
      return buildExactMcPendingTensionResult(
        BRANCH_TENSION_PENDING,
        stressTrial6,
        elasticTangent6x6,
        trialSurfaceValues,
        {
          trialBranchKind,
          trialMultiplicityKind,
          apexAdmissibilityReason: candidate?.apexAdmissibilityReason || candidate?.reason || 'pending-tension-cutoff-stage'
        }
      );
    }
    if (candidate?.promoteToBranchKind) {
      pushCandidate(candidate.promoteToBranchKind);
    }
    if (candidate?.reason) failureReasons.push(`${candidateKind}: ${candidate.reason}`);
  }

  return {
    converged: false,
    reason: failureReasons.length
      ? `exact MC branch acceptance failed (${failureReasons.join('; ')})`
      : 'exact MC branch acceptance failed without a resolved candidate'
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

function solveLocalMcFallbackTrustRegion(stressTrial6, elasticTangent6x6, materialParameters, mcTrial, committedState = null, exactFailure = null) {
  const fallback = returnMapSmoothMCPlastic(stressTrial6, elasticTangent6x6, materialParameters, mcTrial);
  if (!fallback?.converged) {
    return {
      converged: false,
      reason: `local fallback return failed after exact Stage 2 failure (${fallback?.reason || 'unknown reason'})`,
      localFailureClassification: classifyLocalReturnFailure(fallback),
      fallbackSourceReason: exactFailure?.reason || ''
    };
  }

  const exactCurrent = evaluateExactMcSurfaceValuesFromStress(fallback.stress6, materialParameters);
  const exactValues = exactCurrent?.values || {};
  const fallbackConditionNumber = denseMatrixConditionNumberEstimate(fallback.algorithmicTangent6x6, 1e-12);
  const retainedCommittedBranch =
    activeSurfaceIdsForBranchKind(committedState?.exactBranchKind).length > 0
      ? committedState.exactBranchKind
      : BRANCH_FACE_F13;

  return {
    converged: true,
    iterations: Number(fallback.iterations) || 0,
    stress6: cloneVector6(fallback.stress6),
    plasticStrainIncrement6: cloneVector6(fallback.plasticStrainIncrement6),
    algorithmicTangent6x6: cloneMatrix6(fallback.algorithmicTangent6x6),
    activeYieldSurface: YIELD_SURFACE_MC_SHEAR,
    activeSurfaceIds: ['SMOOTH_MC_FALLBACK'],
    yieldResidual: Math.max(Number(exactCurrent?.F) || 0, 0),
    trialBranchKind: exactFailure?.trialBranchKind || retainedCommittedBranch,
    acceptedBranchKind: retainedCommittedBranch,
    branchKind: retainedCommittedBranch,
    representativeBasisSource: committedState?.representativeBasisSource || 'fallback-smooth',
    representativeProjectors: cloneRepresentativeProjectors(committedState?.representativeProjectors),
    trialMultiplicityKind: committedState?.multiplicityKind || 'DISTINCT',
    finalMultiplicityKind: 'DISTINCT',
    edgeTotalMultiplier: 0,
    edgeMixWeight: 0,
    plasticMultipliers: [],
    tangentConditionNumber: fallbackConditionNumber,
    tangentQuality: classifyTangentQuality(fallbackConditionNumber),
    branchAcceptanceResidual: Math.max(...Object.values(exactValues).map((value) => Number(value) || 0), 0),
    apexAdmissibilityReason: exactFailure?.apexAdmissibilityReason || '',
    localResidualsBySurface: { ...exactValues },
    localFallbackUsed: true,
    localReturnMode: 'smooth-fallback',
    localFailureClassification: exactFailure ? classifyLocalReturnFailure(exactFailure) : 'fallback-retained',
    fallbackSourceReason: exactFailure?.reason || ''
  };
}

export function createMaterialPointState(overrides = {}) {
  const source = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    totalStrain6: cloneVector6(source.totalStrain6),
    plasticStrain6: cloneVector6(source.plasticStrain6),
    effectiveStress6: cloneVector6(source.effectiveStress6),
    activeYieldSurface: source.activeYieldSurface || YIELD_SURFACE_NONE,
    exactBranchKind: source.exactBranchKind || 'ELASTIC',
    multiplicityKind: source.multiplicityKind || 'DISTINCT',
    representativeBasisSource: source.representativeBasisSource || 'trial',
    representativeProjectors: cloneRepresentativeProjectors(source.representativeProjectors),
    localReturnMode: source.localReturnMode || 'elastic',
    localFallbackUsed: source.localFallbackUsed === true,
    currentlyMcActive: source.currentlyMcActive === true,
    hasEverExceededMc: source.hasEverExceededMc === true,
    etaMcCurrent: Number(source.etaMcCurrent) || 0,
    etaMcMaxHistory: Number(source.etaMcMaxHistory) || 0,
    initialFMc: Number(source.initialFMc) || 0,
    initialEtaMc: Number(source.initialEtaMc) || 0,
    initialDiagnosticYieldSurface: source.initialDiagnosticYieldSurface || YIELD_SURFACE_NONE,
    initialStateAdmissible: source.initialStateAdmissible !== false,
    initialProjectedFromInadmissible: source.initialProjectedFromInadmissible === true,
    initialProjectionFailed: source.initialProjectionFailed === true,
    equilibratedInitialStateAvailable: source.equilibratedInitialStateAvailable === true,
    equilibratedInitialFMc: Number(source.equilibratedInitialFMc) || 0,
    equilibratedInitialEtaMc: Number(source.equilibratedInitialEtaMc) || 0,
    equilibratedInitialDiagnosticYieldSurface: source.equilibratedInitialDiagnosticYieldSurface || YIELD_SURFACE_NONE,
    equilibratedInitialStateAdmissible: source.equilibratedInitialStateAdmissible !== false,
    sigmaY: Math.max(Number(source.sigmaY) || 0, 0),
    hardeningVariable: Number(source.hardeningVariable) || 0,
    accumulatedPlasticStrain: Math.max(Number(source.accumulatedPlasticStrain) || 0, 0),
    edgeTotalMultiplier: Math.max(Number(source.edgeTotalMultiplier) || 0, 0),
    edgeMixWeight: Math.min(Math.max(Number(source.edgeMixWeight) || 0, 0), 1)
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
  const surfaceValues = evaluateExactMcSurfaceValuesFromPrincipal([s1, s2, s3], materialParameters);
  const tensionTolerance = resolveYieldTolerance(materialParameters, { s1, s2, s3 });
  const T3 = Number(surfaceValues?.T3) || 0;

  // Three regimes for the tension cut-off (compression-positive convention):
  //   T3 = -s3 - sigma_tAllow
  //   T3 >  +tol   strictly outside the cut-off  ->  tension VIOLATION (s3 too tensile)
  //   |T3| <= tol  exactly on the cut-off        ->  tension BOUNDARY (admissible)
  //   T3 <  -tol   inside the admissible region  ->  interior
  //
  // Free terrain surfaces with sigma_t = 0 sit at s3 ≈ 0, so T3 ≈ 0 is the
  // physical at-rest state, not a failure. The previous condition
  //   T3 >= -tol
  // collapsed boundary and violation into one bucket and emitted F = eta = ∞,
  // which made the seed admissibility check reject every shallow Gauss point
  // along a free surface and forced the predictor-projection code to do work
  // it should not have to do. Distinguishing the two regimes restores the
  // standard Koiter cut-off semantics: only true violations (T3 > +tol) get
  // the infinite-eta tag.
  if (useTensionCutoff && T3 > tensionTolerance) {
    return {
      F: Number.POSITIVE_INFINITY,
      eta: Number.POSITIVE_INFINITY,
      state: 'tension-cutoff',
      tensionViolation: true,
      tensionBoundary: false,
      surfaceValues,
      ...principal
    };
  }

  const rawDenom = (s1 + s3) * Math.sin(phi) + 2 * c * Math.cos(phi);
  const denom = Math.max(rawDenom, 1e-6);
  const F = (s1 - s3) - (s1 + s3) * Math.sin(phi) - 2 * c * Math.cos(phi);
  const eta = (s1 - s3) / denom;

  // Tension boundary case: T3 within ±tol of zero. The state is admissible
  // because the cut-off is satisfied by equality. Report shear-MC F and
  // eta normally, and flag tensionBoundary so callers can tell apart from
  // a genuinely interior point.
  const onTensionBoundary = useTensionCutoff && T3 >= -tensionTolerance;
  const stateLabel = F > 0
    ? 'mc-yield'
    : (onTensionBoundary ? 'tension-boundary' : 'elastic');

  return {
    F,
    eta,
    state: stateLabel,
    tensionViolation: false,
    tensionBoundary: onTensionBoundary,
    surfaceValues,
    ...principal
  };
}

export function evaluateMaterialPointDiagnosticsFromStress6(effectiveStress6, materialParameters, committedState = null, overrides = {}) {
  const effectiveStress2D = effectiveStress6ToCompressionPositiveStress2D(effectiveStress6);
  const effectiveStress3D = effectiveStress6ToCompressionPositiveStress3D(effectiveStress6);
  const mc = mohrCoulombIndicator3D(effectiveStress6, materialParameters);
  const activeYieldSurface = overrides.activeYieldSurface ?? YIELD_SURFACE_NONE;
  const diagnosticYieldSurface = activeYieldSurface === YIELD_SURFACE_TENSION
    ? YIELD_SURFACE_TENSION
    : activeYieldSurfaceFromState(mc);
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

function stampEquilibratedInitialAudit(state, materialParameters) {
  const next = createMaterialPointState({
    ...state,
    initialFMc: 0,
    initialEtaMc: 0,
    initialDiagnosticYieldSurface: YIELD_SURFACE_NONE,
    initialStateAdmissible: true
  });
  if (!materialParameters) return next;
  const diagnostics = evaluateMaterialPointDiagnosticsFromStress6(next.effectiveStress6, materialParameters, next, {
    activeYieldSurface: next.activeYieldSurface,
    currentlyMcActive: next.currentlyMcActive === true,
    hasEverExceededMc: next.hasEverExceededMc === true,
    hasExceededNow: next.currentlyMcActive === true
  });
  const tolerance = resolveYieldTolerance(materialParameters, diagnostics.mc);
  next.equilibratedInitialStateAvailable = true;
  next.equilibratedInitialFMc = Number(diagnostics.fMcFinal) || 0;
  next.equilibratedInitialEtaMc = Number(diagnostics.etaMcFinal) || 0;
  next.equilibratedInitialDiagnosticYieldSurface = diagnostics.diagnosticYieldSurface || YIELD_SURFACE_NONE;
  next.equilibratedInitialStateAdmissible = (Number(diagnostics.fMcFinal) || 0) <= tolerance;
  return next;
}

export function seedMaterialPointStateFromEffectiveStress6(
  initialEffectiveStress6,
  materialParameters,
  options = {}
) {
  // The seed function preserves the supplied stress by default. Pass
  // `{ projectInadmissibleOntoMc: true }` to project a K0-predictor
  // stress onto the exact MC surface when it is inadmissible — see
  // §"Predictor admissibility on sloping terrain" in the deformation
  // theory chapter for why this is needed for plastic-geostatic
  // equilibration on weak shallow soils.
  const projectInadmissible = options?.projectInadmissibleOntoMc === true;

  let effectiveStress6 = cloneVector6(initialEffectiveStress6);
  let diagnostics = evaluateMaterialPointDiagnosticsFromStress6(effectiveStress6, materialParameters, null, {
    activeYieldSurface: YIELD_SURFACE_NONE,
    currentlyMcActive: false,
    hasEverExceededMc: false,
    hasExceededNow: false
  });
  const initialTolerance = resolveYieldTolerance(materialParameters, diagnostics.mc);
  let admissible = (Number(diagnostics.fMcFinal) || 0) <= initialTolerance;

  // Optional projection of an inadmissible predictor onto MC. The flat-
  // ground K0 predictor (sigma_h = K0 sigma_v, tau = 0) is a proxy. On
  // sloping terrain the at-rest stress state has nonzero shear on
  // horizontal planes; the K0 predictor cannot reproduce it. Near the
  // surface where p ≈ c cot phi the apex region is small and even
  // modest predictor error puts the seed outside MC. Without
  // projection, plastic-geostatic equilibration starts from a state
  // that violates yield AND fails equilibrium and has to correct both
  // at once — which fails to converge on weak shallow soils.
  //
  // The closest admissible state to the K0 predictor is its return
  // mapping onto MC using the elastic tangent at the seed. After
  // projection the seed satisfies yield by construction and the
  // equilibration phase only has to recover force balance — the well-
  // posed problem the Newton/Krylov pipeline is designed for.
  let projectedFromInadmissible = false;
  let projectionFailed = false;
  if (projectInadmissible && !admissible) {
    try {
      const elasticTangent6x6 = elasticMatrix6x6(materialParameters?.Emc, materialParameters?.nu);
      const returnResult = solveExactMcActiveSetReturn(
        effectiveStress6,
        elasticTangent6x6,
        materialParameters,
        diagnostics.mc,
        null
      );
      if (
        returnResult?.converged
        && Array.isArray(returnResult.stress6)
        && returnResult.stress6.every(Number.isFinite)
      ) {
        effectiveStress6 = cloneVector6(returnResult.stress6);
        diagnostics = evaluateMaterialPointDiagnosticsFromStress6(effectiveStress6, materialParameters, null, {
          activeYieldSurface: YIELD_SURFACE_NONE,
          currentlyMcActive: false,
          hasEverExceededMc: false,
          hasExceededNow: false
        });
        admissible = (Number(diagnostics.fMcFinal) || 0) <= initialTolerance;
        projectedFromInadmissible = admissible;
        if (!admissible) projectionFailed = true;
      } else {
        projectionFailed = true;
      }
    } catch {
      projectionFailed = true;
    }
  }

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
    initialStateAdmissible: admissible,
    initialProjectedFromInadmissible: projectedFromInadmissible,
    initialProjectionFailed: projectionFailed,
    sigmaY: materialParameters?.sigmaY
  });
}

export function seedMaterialPointStateFromInitialStress(initialEffectiveStress2D, materialParameters) {
  const effectiveStress6 = planeStrainCompressionPositiveStress2DToStress6(initialEffectiveStress2D, materialParameters?.nu);
  return seedMaterialPointStateFromEffectiveStress6(effectiveStress6, materialParameters);
}

export function createMaterialPoint({
  materialModel,
  materialParameters,
  committedState = null,
  elementIndex = -1,
  integrationPointIndex = -1,
  gpIndex = -1,
  regionIndex = -1
} = {}) {
  const committed = cloneMaterialPointState(committedState);
  return {
    elementIndex,
    integrationPointIndex,
    gpIndex,
    regionIndex,
    materialModel,
    materialParameters,
    predictorState: cloneMaterialPointState(committed),
    referenceState: cloneMaterialPointState(committed),
    committedState: committed,
    trialState: cloneMaterialPointState(committed),
    diagnostics: null
  };
}

export function setMaterialPointReferenceState(materialPoint, sourceState = null, options = {}) {
  if (!materialPoint) return null;
  const referenceMode = options?.referenceMode === 'equilibrated-initial' ? 'equilibrated-initial' : 'predictor';
  const materialParameters = options?.materialParameters || materialPoint.materialParameters || null;
  const source = sourceState ? cloneMaterialPointState(sourceState) : cloneMaterialPointState(materialPoint.committedState);
  materialPoint.referenceState = referenceMode === 'equilibrated-initial'
    ? stampEquilibratedInitialAudit(source, materialParameters)
    : createMaterialPointState({
      ...source,
      equilibratedInitialStateAvailable: false,
      equilibratedInitialFMc: 0,
      equilibratedInitialEtaMc: 0,
      equilibratedInitialDiagnosticYieldSurface: YIELD_SURFACE_NONE,
      equilibratedInitialStateAdmissible: true
    });
  return materialPoint.referenceState;
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
    exactBranchKind: source.exactBranchKind || 'ELASTIC',
    multiplicityKind: source.multiplicityKind || 'DISTINCT',
    representativeBasisSource: source.representativeBasisSource || 'trial',
    representativeProjectors: cloneRepresentativeProjectors(source.representativeProjectors),
    localReturnMode: source.localReturnMode || 'elastic',
    localFallbackUsed: source.localFallbackUsed === true,
    currentlyMcActive: source.currentlyMcActive === true,
    hasEverExceededMc: source.hasEverExceededMc === true,
    etaMcCurrent: Number(source.etaMcCurrent) || 0,
    etaMcMaxHistory: Number(source.etaMcMaxHistory) || 0,
    initialFMc: Number(source.initialFMc) || 0,
    initialEtaMc: Number(source.initialEtaMc) || 0,
    initialDiagnosticYieldSurface: source.initialDiagnosticYieldSurface || YIELD_SURFACE_NONE,
    initialStateAdmissible: source.initialStateAdmissible !== false,
    initialProjectedFromInadmissible: source.initialProjectedFromInadmissible === true,
    initialProjectionFailed: source.initialProjectionFailed === true,
    equilibratedInitialStateAvailable: source.equilibratedInitialStateAvailable === true,
    equilibratedInitialFMc: Number(source.equilibratedInitialFMc) || 0,
    equilibratedInitialEtaMc: Number(source.equilibratedInitialEtaMc) || 0,
    equilibratedInitialDiagnosticYieldSurface: source.equilibratedInitialDiagnosticYieldSurface || YIELD_SURFACE_NONE,
    equilibratedInitialStateAdmissible: source.equilibratedInitialStateAdmissible !== false,
    sigmaY: Math.max(Number(source.sigmaY) || 0, 0),
    hardeningVariable: Number(source.hardeningVariable) || 0,
    accumulatedPlasticStrain: Math.max(Number(source.accumulatedPlasticStrain) || 0, 0),
    edgeTotalMultiplier: Math.max(Number(source.edgeTotalMultiplier) || 0, 0),
    edgeMixWeight: Math.min(Math.max(Number(source.edgeMixWeight) || 0, 0), 1)
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
      const mcTrialDiagnostic = mcTrial;
      const yieldTolerance = resolveYieldTolerance(params, mcTrial);
      const exactTrial = evaluateExactMcSurfaceValuesFromStress(stressTrial6, params);
      const exactTrialMaxResidual = Math.max(...Object.values(exactTrial?.values || {}).map((value) => Number(value) || 0), 0);
      const committedHasRetainableExactBranch =
        activeSurfaceIdsForBranchKind(committed?.exactBranchKind).length > 0 &&
        committed?.activeYieldSurface !== YIELD_SURFACE_NONE;
      const committedHasRetainableSmoothFallback =
        committed?.currentlyMcActive === true &&
        committed?.localReturnMode === 'smooth-fallback' &&
        (Number(exactTrial?.values?.T3) || 0) <= yieldTolerance;

      if (!(exactTrialMaxResidual > yieldTolerance) && !committedHasRetainableExactBranch && !committedHasRetainableSmoothFallback) {
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
          exactBranchKind: BRANCH_ELASTIC,
          multiplicityKind: 'DISTINCT',
          localReturnMode: 'elastic',
          localFallbackUsed: false,
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
            fMcTrial: Number(mcTrialDiagnostic?.F) || 0,
            etaMcTrial: Number.isFinite(Number(mcTrialDiagnostic?.eta)) ? Number(mcTrialDiagnostic.eta) : Number.POSITIVE_INFINITY,
            yieldTolerance,
            plasticIncrementNorm: 0,
            localIterations: 0,
            exactYieldTrial: exactTrialMaxResidual,
            exactYieldFinal: exactTrialMaxResidual,
            exactBranchKind: BRANCH_ELASTIC,
            trialBranchKind: BRANCH_ELASTIC,
            trialMultiplicityKind: 'DISTINCT',
            finalMultiplicityKind: 'DISTINCT',
            representativeBasisSource: committed.representativeBasisSource || 'trial',
            edgeTotalMultiplier: 0,
            edgeMixWeight: 0,
            plasticMultipliers: [],
            branchAcceptanceResidual: exactTrialMaxResidual,
            tangentConditionNumber: 1,
            tangentQuality: 'good',
            apexAdmissibilityReason: '',
            localResidualsBySurface: exactTrial?.values ? { ...exactTrial.values } : {},
            localReturnMode: 'elastic',
            localFallbackUsed: false,
            localFailureClassification: '',
            fallbackSourceReason: '',
            constitutiveModel: 'mc-plastic',
            analysisContext
          }
        };
      }

      let local = committedHasRetainableSmoothFallback
        ? solveLocalMcFallbackTrustRegion(stressTrial6, elasticTangent6x6, params, mcTrial, committed, null)
        : solveExactMcActiveSetReturn(stressTrial6, elasticTangent6x6, params, mcTrial, committed);
      if (!local?.converged) {
        const tensionTrialResidual = Number(exactTrial?.values?.T3) || 0;
        const canAttemptSmoothFallback =
          !committedHasRetainableSmoothFallback &&
          !local?.routePending &&
          tensionTrialResidual <= yieldTolerance &&
          mcTrial?.state !== 'tension-cutoff';
        if (canAttemptSmoothFallback) {
          const fallbackLocal = solveLocalMcFallbackTrustRegion(stressTrial6, elasticTangent6x6, params, mcTrial, committed, local);
          if (fallbackLocal?.converged) {
            local = fallbackLocal;
          } else {
            throw new Error(`Local return mapping failed: ${local?.reason || 'unknown reason'}; fallback failed: ${fallbackLocal?.reason || 'unknown reason'}`);
          }
        } else {
          throw new Error(`Local return mapping failed: ${local?.reason || 'unknown reason'}`);
        }
      }

      const plasticStrainIncrement6 = cloneVector6(local.plasticStrainIncrement6);
      const nextPlasticStrain6 = addVector6(committed.plasticStrain6, plasticStrainIncrement6);
      const finalMc = mohrCoulombIndicator3D(local.stress6, params);
      const equivalentPlasticIncrement = equivalentPlasticStrainIncrement(plasticStrainIncrement6);
      const finalIsPlasticActive =
        local.activeYieldSurface === YIELD_SURFACE_MC_FACE ||
        local.activeYieldSurface === YIELD_SURFACE_MC_EDGE ||
        local.activeYieldSurface === YIELD_SURFACE_MC_APEX ||
        local.activeYieldSurface === YIELD_SURFACE_TENSION;
      const diagnostics = evaluateMaterialPointDiagnosticsFromStress6(local.stress6, params, committed, {
        currentlyMcActive: finalIsPlasticActive,
        stateChanged: committed.activeYieldSurface !== local.activeYieldSurface,
        activeYieldSurface: local.activeYieldSurface,
        hasEverExceededMc: committed.hasEverExceededMc || finalIsPlasticActive,
        hasExceededNow: finalIsPlasticActive
      });
      const trialState = createMaterialPointState({
        ...committed,
        totalStrain6: nextStrain6,
        plasticStrain6: nextPlasticStrain6,
        effectiveStress6: local.stress6,
        activeYieldSurface: local.activeYieldSurface,
        exactBranchKind: local.acceptedBranchKind || local.branchKind || BRANCH_ELASTIC,
        multiplicityKind: local.finalMultiplicityKind || multiplicityKindFromBranchKind(local.acceptedBranchKind || local.branchKind),
        representativeBasisSource: local.representativeBasisSource || committed.representativeBasisSource || 'trial',
        representativeProjectors: local.representativeProjectors || committed.representativeProjectors || null,
        localReturnMode: local.localReturnMode || 'exact-active-set',
        localFallbackUsed: local.localFallbackUsed === true,
        currentlyMcActive: finalIsPlasticActive,
        hasEverExceededMc: diagnostics.hasEverExceededMc,
        etaMcCurrent: diagnostics.etaMcCurrent,
        etaMcMaxHistory: diagnostics.etaMcMaxHistory,
        sigmaY: params?.sigmaY,
        accumulatedPlasticStrain: Math.max(Number(committed.accumulatedPlasticStrain) || 0, 0) + equivalentPlasticIncrement,
        edgeTotalMultiplier: Number(local.edgeTotalMultiplier) || 0,
        edgeMixWeight: Number(local.edgeMixWeight) || 0
      });
      return {
        stressTrial6: local.stress6,
        tangent6x6: local.algorithmicTangent6x6,
        trialState,
        diagnostics: {
          ...diagnostics,
          fMcTrial: Number(mcTrialDiagnostic?.F) || 0,
          etaMcTrial: Number.isFinite(Number(mcTrialDiagnostic?.eta)) ? Number(mcTrialDiagnostic.eta) : Number.POSITIVE_INFINITY,
          fMcFinal: Number(finalMc?.F) || 0,
          // Suppress etaMcFinal when the accepted branch is tension-driven so
          // downstream consumers can tell tension-governed final states from
          // MC-governed ones. The new three-regime mohrCoulombIndicator3D
          // returns a finite eta on the tension boundary (T3 ≈ 0) — that is
          // correct for *trial* admissibility, but for the *final* diagnostic
          // we want eta = ∞ when the tension cut-off is the controlling
          // surface, matching the historical post-return semantics.
          etaMcFinal: isTensionBranchKind(local.acceptedBranchKind || local.branchKind)
            ? Number.POSITIVE_INFINITY
            : (Number.isFinite(Number(finalMc?.eta)) ? Number(finalMc.eta) : Number.POSITIVE_INFINITY),
          exactYieldTrial: exactTrialMaxResidual,
          exactYieldFinal: Number(local?.yieldResidual) || 0,
          activeSurfaceIds: Array.isArray(local?.activeSurfaceIds) ? [...local.activeSurfaceIds] : [],
          exactBranchKind: local.acceptedBranchKind || local.branchKind || BRANCH_ELASTIC,
          trialBranchKind: local.trialBranchKind || BRANCH_ELASTIC,
          trialMultiplicityKind: local.trialMultiplicityKind || 'DISTINCT',
          finalMultiplicityKind: local.finalMultiplicityKind || multiplicityKindFromBranchKind(local.acceptedBranchKind || local.branchKind),
          representativeBasisSource: local.representativeBasisSource || 'trial',
          edgeTotalMultiplier: Number(local.edgeTotalMultiplier) || 0,
          edgeMixWeight: Number(local.edgeMixWeight) || 0,
          plasticMultipliers: Array.isArray(local?.plasticMultipliers) ? [...local.plasticMultipliers] : [],
          branchAcceptanceResidual: Number(local?.branchAcceptanceResidual) || 0,
          tangentConditionNumber: Number(local?.tangentConditionNumber) || Number.POSITIVE_INFINITY,
          tangentQuality: local?.tangentQuality || 'unknown',
          apexAdmissibilityReason: local?.apexAdmissibilityReason || '',
          localResidualsBySurface: local?.localResidualsBySurface ? { ...local.localResidualsBySurface } : {},
          localReturnMode: local?.localReturnMode || 'exact-active-set',
          localFallbackUsed: local?.localFallbackUsed === true,
          localFailureClassification: local?.localFailureClassification || '',
          fallbackSourceReason: local?.fallbackSourceReason || '',
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
