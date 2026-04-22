// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { pointInPolygonHalfOpen } from '../soil-regions.js';
import { buildDeformationMesh } from './mesh.js';
import {
  buildBMatrixT3,
  edgeTractionVector,
  elementGravityVectorT3FromArea,
  elementStiffnessT3FromBAndArea,
  triangleArea
} from './element-t3.js';
import {
  cloneMaterialPointState,
  createLinearElasticMaterial,
  createMCPlasticMaterial,
  createMCReducedStiffnessMaterial,
  createMaterialPoint,
  commitMaterialPoint,
  effectiveStress6ToCompressionPositiveStress3D,
  extractStress2DFrom6,
  extractTangent2DFrom6,
  liftPlaneStrainStrainTo6,
  seedMaterialPointStateFromEffectiveStress6,
  seedMaterialPointStateFromInitialStress,
  snapshotMaterialPointState,
} from './material-models.js';
import { prepareMechanicalMaterial } from './material.js';
import {
  buildFlatK0InitialEffectiveStressField,
  initialBulkUnitWeightFromPorePressure,
  mohrCoulombIndicator,
  negateNormalAndShear,
  principalStress2DCompressionPositive,
  sampleInitialPorePressure
} from './post.js';

const CG_REL_TOL = 1e-5;
const CG_ABS_TOL = 5e-5;
const CG_NUMERIC_EPS = 1e-14;
const CG_CHECKPOINT_INTERVAL = 25;
const MAX_CG_ITER = 25000;
const BICGSTAB_CHECKPOINT_INTERVAL = 20;
const GEOM_EPS = 1e-6;
const NONLINEAR_RESIDUAL_REL_TOL = 1e-4;
const NONLINEAR_RESIDUAL_ABS_TOL = 1e-3;
const NONLINEAR_DISPLACEMENT_REL_TOL = 1e-5;
const NONLINEAR_DISPLACEMENT_ABS_TOL = 1e-8;
const NONLINEAR_MAX_ITER = 24;
const NONLINEAR_INITIAL_LOAD_STEP = 0.25;
const NONLINEAR_MIN_LOAD_STEP = 1 / 2048;
const NONLINEAR_GROWTH_FACTOR = 1.25;
const NONLINEAR_CUTBACK_FACTOR = 0.5;
const NONLINEAR_MAX_LOAD_STEPS = 256;

function pushUniqueWarning(warnings, message) {
  if (!Array.isArray(warnings) || !message) return;
  if (!warnings.includes(message)) warnings.push(message);
}

function isStopRequested(runControl) {
  return typeof runControl?.shouldStop === 'function' ? !!runControl.shouldStop() : false;
}

async function runCheckpoint(runControl, force = false) {
  if (typeof runControl?.checkpoint === 'function') {
    return !!(await runControl.checkpoint({ force }));
  }
  return isStopRequested(runControl);
}

function dot(a, b) {
  let sum = 0;
  let compensation = 0;
  for (let i = 0; i < a.length; i += 1) {
    const term = a[i] * b[i];
    const corrected = term - compensation;
    const next = sum + corrected;
    compensation = (next - sum) - corrected;
    sum = next;
  }
  return sum;
}

function vectorNorm(vector) {
  return Math.sqrt(dot(vector, vector));
}

function addScaledVectorInPlace(target, source, scale = 1) {
  for (let i = 0; i < target.length; i += 1) target[i] += (Number(source?.[i]) || 0) * scale;
}

function cloneScaledVector(vector, scale = 1) {
  const out = new Float64Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = (Number(vector[i]) || 0) * scale;
  return out;
}

function copyVectorInto(target, source) {
  for (let i = 0; i < target.length; i += 1) target[i] = Number(source?.[i]) || 0;
}

function sparseMatVec(rows, vector) {
  const out = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    let sum = 0;
    let compensation = 0;
    const row = rows[i];
    for (let j = 0; j < row.indices.length; j += 1) {
      const term = row.values[j] * vector[row.indices[j]];
      const corrected = term - compensation;
      const next = sum + corrected;
      compensation = (next - sum) - corrected;
      sum = next;
    }
    out[i] = sum;
  }
  return out;
}

function nonlinearToleranceState(residualNorm, rhsNorm, deltaNorm, solutionNorm, {
  residualRelTol = NONLINEAR_RESIDUAL_REL_TOL,
  residualAbsTol = NONLINEAR_RESIDUAL_ABS_TOL,
  displacementRelTol = NONLINEAR_DISPLACEMENT_REL_TOL,
  displacementAbsTol = NONLINEAR_DISPLACEMENT_ABS_TOL
} = {}) {
  const residualTarget = Math.max(Math.max(Number(residualAbsTol) || 0, 0), Math.max(Number(residualRelTol) || 0, 0) * Math.max(Number(rhsNorm) || 0, 0));
  const displacementTarget = Math.max(Math.max(Number(displacementAbsTol) || 0, 0), Math.max(Number(displacementRelTol) || 0, 0) * Math.max(Number(solutionNorm) || 0, 0));
  const relativeResidual = Math.max(Number(rhsNorm) || 0, 0) > CG_NUMERIC_EPS ? residualNorm / rhsNorm : residualNorm > residualTarget ? Infinity : 0;
  const relativeDisplacement = Math.max(Number(solutionNorm) || 0, 0) > CG_NUMERIC_EPS ? deltaNorm / solutionNorm : deltaNorm > displacementTarget ? Infinity : 0;
  return {
    residualTarget,
    displacementTarget,
    relativeResidual,
    relativeDisplacement,
    residualConverged: residualNorm <= residualTarget,
    displacementConverged: deltaNorm <= displacementTarget,
    converged: residualNorm <= residualTarget && deltaNorm <= displacementTarget
  };
}

function cgToleranceState(residualNorm, rhsNorm, relTol = CG_REL_TOL, absTol = CG_ABS_TOL) {
  const absoluteTarget = Math.max(Number(absTol) || 0, 0);
  const relativeTarget = Math.max(Number(relTol) || 0, 0) * Math.max(Number(rhsNorm) || 0, 0);
  const target = Math.max(absoluteTarget, relativeTarget);
  const relativeResidual = Math.max(Number(rhsNorm) || 0, 0) > CG_NUMERIC_EPS
    ? residualNorm / rhsNorm
    : residualNorm > absoluteTarget ? Infinity : 0;
  return {
    target,
    absoluteTarget,
    relativeTarget,
    relativeResidual,
    converged: residualNorm <= target
  };
}

async function solveCg(rows, rhs, initial = null, maxIter = MAX_CG_ITER, relTol = CG_REL_TOL, absTol = CG_ABS_TOL, runControl = null) {
  const n = rows.length;
  if (!n) {
    return {
      solution: new Float64Array(0),
      converged: true,
      iterations: 0,
      residualNorm: 0,
      relativeResidual: 0,
      rhsNorm: 0,
      toleranceTarget: 0,
      interrupted: false
    };
  }
  const x = initial && initial.length === n ? Float64Array.from(initial) : new Float64Array(n);
  let r = rhs;
  if (initial) {
    const ax = sparseMatVec(rows, x);
    r = new Float64Array(n);
    for (let i = 0; i < n; i += 1) r[i] = rhs[i] - ax[i];
  } else {
    r = Float64Array.from(rhs);
  }
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const rhsNorm = Math.sqrt(dot(rhs, rhs));

  for (let i = 0; i < n; i += 1) {
    const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
    z[i] = r[i] / diag;
    p[i] = z[i];
  }

  let rzOld = dot(r, z);
  let residualNorm = Math.sqrt(dot(r, r));
  let tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  if (tolerance.converged) {
    return {
      solution: x,
      converged: true,
      iterations: 0,
      residualNorm,
      relativeResidual: tolerance.relativeResidual,
      rhsNorm,
      toleranceTarget: tolerance.target,
      interrupted: false
    };
  }
  await runCheckpoint(runControl, true);

  for (let iter = 1; iter <= maxIter; iter += 1) {
    const ap = sparseMatVec(rows, p);
    const denom = dot(p, ap);
    if (!(Math.abs(denom) > CG_NUMERIC_EPS)) {
      tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: tolerance.converged,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    const alpha = rzOld / denom;
    for (let i = 0; i < n; i += 1) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    residualNorm = Math.sqrt(dot(r, r));
    tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
    if (tolerance.converged) {
      return {
        solution: x,
        converged: true,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    for (let i = 0; i < n; i += 1) {
      const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
      z[i] = r[i] / diag;
    }
    const rzNew = dot(r, z);
    const beta = Math.abs(rzOld) > CG_NUMERIC_EPS ? rzNew / rzOld : 0;
    for (let i = 0; i < n; i += 1) p[i] = z[i] + beta * p[i];
    rzOld = rzNew;
    if (iter % CG_CHECKPOINT_INTERVAL === 0 && (await runCheckpoint(runControl))) {
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: true
      };
    }
  }

  tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  return {
    solution: x,
    converged: false,
    iterations: maxIter,
    residualNorm,
    relativeResidual: tolerance.relativeResidual,
    rhsNorm,
    toleranceTarget: tolerance.target,
    interrupted: false
  };
}

async function solveBiCgStab(rows, rhs, initial = null, maxIter = MAX_CG_ITER, relTol = CG_REL_TOL, absTol = CG_ABS_TOL, runControl = null) {
  const n = rows.length;
  if (!n) {
    return {
      solution: new Float64Array(0),
      converged: true,
      iterations: 0,
      residualNorm: 0,
      relativeResidual: 0,
      rhsNorm: 0,
      toleranceTarget: 0,
      interrupted: false
    };
  }
  const x = initial && initial.length === n ? Float64Array.from(initial) : new Float64Array(n);
  const rhsNorm = Math.sqrt(dot(rhs, rhs));
  const ax0 = initial ? sparseMatVec(rows, x) : new Float64Array(n);
  const r = new Float64Array(n);
  for (let i = 0; i < n; i += 1) r[i] = rhs[i] - ax0[i];
  const rHat = Float64Array.from(r);
  let residualNorm = Math.sqrt(dot(r, r));
  let tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  if (tolerance.converged) {
    return {
      solution: x,
      converged: true,
      iterations: 0,
      residualNorm,
      relativeResidual: tolerance.relativeResidual,
      rhsNorm,
      toleranceTarget: tolerance.target,
      interrupted: false
    };
  }

  const p = new Float64Array(n);
  const v = new Float64Array(n);
  const s = new Float64Array(n);
  const t = new Float64Array(n);
  const phat = new Float64Array(n);
  const shat = new Float64Array(n);
  let rhoOld = 1;
  let alpha = 1;
  let omega = 1;

  await runCheckpoint(runControl, true);

  for (let iter = 1; iter <= maxIter; iter += 1) {
    const rhoNew = dot(rHat, r);
    if (!(Number.isFinite(rhoNew) && Math.abs(rhoNew) > CG_NUMERIC_EPS)) {
      tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: tolerance.converged,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    const beta = (rhoNew / rhoOld) * (alpha / omega);
    for (let i = 0; i < n; i += 1) {
      p[i] = r[i] + beta * (p[i] - omega * v[i]);
      const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
      phat[i] = p[i] / diag;
    }
    const vNext = sparseMatVec(rows, phat);
    v.set(vNext);
    const rHatDotV = dot(rHat, v);
    if (!(Number.isFinite(rHatDotV) && Math.abs(rHatDotV) > CG_NUMERIC_EPS)) {
      tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    alpha = rhoNew / rHatDotV;
    for (let i = 0; i < n; i += 1) s[i] = r[i] - alpha * v[i];
    const sNorm = Math.sqrt(dot(s, s));
    const sTolerance = cgToleranceState(sNorm, rhsNorm, relTol, absTol);
    if (sTolerance.converged) {
      for (let i = 0; i < n; i += 1) x[i] += alpha * phat[i];
      return {
        solution: x,
        converged: true,
        iterations: iter,
        residualNorm: sNorm,
        relativeResidual: sTolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: sTolerance.target,
        interrupted: false
      };
    }
    for (let i = 0; i < n; i += 1) {
      const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
      shat[i] = s[i] / diag;
    }
    const tNext = sparseMatVec(rows, shat);
    t.set(tNext);
    const tDotT = dot(t, t);
    if (!(Number.isFinite(tDotT) && tDotT > CG_NUMERIC_EPS)) {
      tolerance = cgToleranceState(sNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm: sNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    omega = dot(t, s) / tDotT;
    if (!(Number.isFinite(omega) && Math.abs(omega) > CG_NUMERIC_EPS)) {
      tolerance = cgToleranceState(sNorm, rhsNorm, relTol, absTol);
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm: sNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    for (let i = 0; i < n; i += 1) {
      x[i] += alpha * phat[i] + omega * shat[i];
      r[i] = s[i] - omega * t[i];
    }
    residualNorm = Math.sqrt(dot(r, r));
    tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
    if (tolerance.converged) {
      return {
        solution: x,
        converged: true,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: false
      };
    }
    rhoOld = rhoNew;
    if (iter % BICGSTAB_CHECKPOINT_INTERVAL === 0 && (await runCheckpoint(runControl))) {
      return {
        solution: x,
        converged: false,
        iterations: iter,
        residualNorm,
        relativeResidual: tolerance.relativeResidual,
        rhsNorm,
        toleranceTarget: tolerance.target,
        interrupted: true
      };
    }
  }

  tolerance = cgToleranceState(residualNorm, rhsNorm, relTol, absTol);
  return {
    solution: x,
    converged: false,
    iterations: maxIter,
    residualNorm,
    relativeResidual: tolerance.relativeResidual,
    rhsNorm,
    toleranceTarget: tolerance.target,
    interrupted: false
  };
}

function compressMatrixRows(rows, freeDofs, freeIndexByDof) {
  return freeDofs.map((dofId, rowIndex) => {
    const out = { indices: [], values: [], diag: 0 };
    rows[dofId].forEach((value, colId) => {
      const colIndex = freeIndexByDof.get(colId);
      if (colIndex == null) return;
      out.indices.push(colIndex);
      out.values.push(value);
      if (colIndex === rowIndex) out.diag = value;
    });
    return out;
  });
}

function compressRhs(rows, freeDofs, fixedValues, fullRhs) {
  const rhs = new Float64Array(freeDofs.length);
  freeDofs.forEach((dofId, rowIndex) => {
    rhs[rowIndex] = fullRhs[dofId] || 0;
    rows[dofId].forEach((value, colId) => {
      if (!fixedValues.has(colId)) return;
      rhs[rowIndex] -= value * fixedValues.get(colId);
    });
  });
  return rhs;
}

function gatherFreeVector(fullVector, freeDofs) {
  const rhs = new Float64Array(freeDofs.length);
  freeDofs.forEach((dofId, rowIndex) => {
    rhs[rowIndex] = Number(fullVector?.[dofId]) || 0;
  });
  return rhs;
}

function addMatrixBlock(rows, dofs, localK) {
  for (let i = 0; i < dofs.length; i += 1) {
    const row = rows[dofs[i]];
    for (let j = 0; j < dofs.length; j += 1) {
      row.set(dofs[j], (row.get(dofs[j]) || 0) + localK[i][j]);
    }
  }
}

function addVectorBlock(rhs, dofs, localF) {
  for (let i = 0; i < dofs.length; i += 1) rhs[dofs[i]] += localF[i];
}

function addMatrixBlockToCompressedRows(rows, elementCache, localK) {
  for (let localRow = 0; localRow < 6; localRow += 1) {
    const freeRowIndex = elementCache.freeRowIndices?.[localRow] ?? -1;
    if (freeRowIndex < 0) continue;
    const rowValues = rows[freeRowIndex].values;
    for (let localCol = 0; localCol < 6; localCol += 1) {
      const slotIndex = elementCache.assemblyLocalSlots?.[localRow * 6 + localCol] ?? -1;
      if (slotIndex < 0) continue;
      rowValues[slotIndex] += localK[localRow][localCol];
    }
  }
}

function addVectorBlockToFreeRhs(rhs, freeRowIndices, localF) {
  for (let i = 0; i < 6; i += 1) {
    const freeRowIndex = freeRowIndices?.[i] ?? -1;
    if (freeRowIndex < 0) continue;
    rhs[freeRowIndex] += localF[i];
  }
}

function elementInternalForceVector(B, stress2D, area) {
  return [
    area * (B[0][0] * stress2D.sxx + B[1][0] * stress2D.syy + B[2][0] * stress2D.txy),
    area * (B[0][1] * stress2D.sxx + B[1][1] * stress2D.syy + B[2][1] * stress2D.txy),
    area * (B[0][2] * stress2D.sxx + B[1][2] * stress2D.syy + B[2][2] * stress2D.txy),
    area * (B[0][3] * stress2D.sxx + B[1][3] * stress2D.syy + B[2][3] * stress2D.txy),
    area * (B[0][4] * stress2D.sxx + B[1][4] * stress2D.syy + B[2][4] * stress2D.txy),
    area * (B[0][5] * stress2D.sxx + B[1][5] * stress2D.syy + B[2][5] * stress2D.txy)
  ];
}

function overlapRange(a0, a1, b0, b1) {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1));
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1));
  return hi > lo + GEOM_EPS ? { lo, hi } : null;
}

function normalizeLoad(model, options, warnings) {
  const surfaceLoad = model?.surfaceLoad || null;
  if (!(surfaceLoad?.xEnd > surfaceLoad?.xStart + GEOM_EPS)) {
    throw new Error('Draw a load interval on the terrain before running deformation.');
  }
  const width = surfaceLoad.xEnd - surfaceLoad.xStart;
  const outOfPlaneLength = Math.max(Number(options?.outOfPlaneLength) || 10, 0.1);
  const loadMode = options?.loadMode === 'total' ? 'total' : 'pressure';
  let q = Math.max(Number(surfaceLoad?.q) || 0, 0);
  let totalLoad = null;
  if (loadMode === 'total') {
    totalLoad = Math.max(Number(options?.totalLoad) || 0, 0);
    if (!(totalLoad > 0)) {
      throw new Error('Enter a positive total load before running deformation in total-load mode.');
    }
    q = totalLoad / Math.max(width * outOfPlaneLength, 1e-6);
  }
  if (!(q > 0)) {
    throw new Error(loadMode === 'pressure'
      ? 'Enter a positive surface load q before running deformation.'
      : 'The derived pressure from total load is zero or negative.');
  }
  if (loadMode === 'pressure' && Number(options?.totalLoad) > 0) {
    totalLoad = q * width * outOfPlaneLength;
  }
  if (outOfPlaneLength / width < 4 - 1e-9) {
    warnings.push('Out-of-plane length is less than 4 times the loaded width, so the plane-strain deformation result should be treated as a 2D screening approximation.');
  }
  return {
    xStart: surfaceLoad.xStart,
    xEnd: surfaceLoad.xEnd,
    width,
    q,
    loadMode,
    totalLoad,
    outOfPlaneLength
  };
}

function addDomainExtentWarnings(model, load, warnings) {
  const terrain = model?.terrain?.vertices || [];
  if (terrain.length < 2 || !(load?.width > 0)) return;
  const leftMargin = load.xStart - terrain[0].x;
  const rightMargin = terrain[terrain.length - 1].x - load.xEnd;
  const below = terrain.reduce((sum, point) => sum + point.y, 0) / terrain.length - Number(model.analysisBottomY || 0);
  const target = 5 * load.width;
  if (leftMargin < target || rightMargin < target || below < target) {
    warnings.push(
      `The current domain is smaller than the recommended 5*B buffer (${target.toFixed(2)} m) on one or more sides, so settlements and MC utilization near the boundaries may be optimistic.`
    );
  }
}

function buildConstraintSets(mesh) {
  const fixUx = new Set();
  const fixUy = new Set();
  (mesh.constraintEdges || []).forEach((edge) => {
    if (edge?.markerType !== 'outer') return;
    if (edge.source === 'side-left' || edge.source === 'side-right') {
      fixUx.add(edge.n1);
      fixUx.add(edge.n2);
    }
    if (edge.source === 'base') {
      fixUy.add(edge.n1);
      fixUy.add(edge.n2);
    }
  });
  return { fixUx, fixUy };
}

function buildFixedDofMap(mesh) {
  const { fixUx, fixUy } = buildConstraintSets(mesh);
  const fixed = new Map();
  [...fixUx].forEach((nodeId) => fixed.set(2 * nodeId, 0));
  [...fixUy].forEach((nodeId) => fixed.set(2 * nodeId + 1, 0));
  return fixed;
}

function loadedTerrainEdges(mesh, load) {
  return (mesh.constraintEdges || []).filter((edge) => {
    if (edge?.markerType !== 'outer' || edge?.source !== 'terrain') return false;
    return !!overlapRange(edge.a.x, edge.b.x, load.xStart, load.xEnd);
  });
}

function createMaterialModelForOptions(materialParameters, options, warnings) {
  const constitutiveModel = options?.constitutiveModel === 'linear-elastic'
    ? 'linear-elastic'
    : options?.constitutiveModel === 'mc-plastic'
      ? 'mc-plastic'
      : 'mc-reduced-stiffness';
  if (constitutiveModel === 'linear-elastic') return createLinearElasticMaterial(materialParameters, warnings);
  if (constitutiveModel === 'mc-plastic') return createMCPlasticMaterial(materialParameters, warnings);
  return createMCReducedStiffnessMaterial(materialParameters, warnings);
}

function prepareRegionConstitutiveModels(mesh, options, warnings) {
  const byRegion = new Map();
  mesh.cells.forEach((cell) => {
    if (cell?.regionIndex == null || cell.regionIndex < 0 || byRegion.has(cell.regionIndex)) return;
    const materialParameters = prepareMechanicalMaterial(cell.material, warnings);
    byRegion.set(cell.regionIndex, {
      materialParameters,
      materialModel: createMaterialModelForOptions(materialParameters, options, warnings)
    });
  });
  return byRegion;
}

function regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings) {
  const cached = regionConstitutiveByRegion.get(cell?.regionIndex);
  if (cached) return cached;
  const materialParameters = prepareMechanicalMaterial(cell?.material, warnings);
  return {
    materialParameters,
    materialModel: createMaterialModelForOptions(materialParameters, options, warnings)
  };
}

function elementDofMap(element) {
  return [2 * element[0], 2 * element[0] + 1, 2 * element[1], 2 * element[1] + 1, 2 * element[2], 2 * element[2] + 1];
}

function buildDeformationElementCaches(mesh) {
  return mesh.elements.map((element, elementIndex) => {
    const nodes = element.map((nodeId) => mesh.nodes[nodeId]);
    const area = triangleArea(nodes);
    const B = buildBMatrixT3(nodes);
    const centroid = mesh.elementData[elementIndex]?.centroid || mesh.cells[mesh.elementCell[elementIndex]]?.centroid || {
      x: (nodes[0].x + nodes[1].x + nodes[2].x) / 3,
      y: (nodes[0].y + nodes[1].y + nodes[2].y) / 3
    };
    return {
      elementIndex,
      cellIndex: mesh.elementCell[elementIndex],
      element,
      nodes,
      area,
      B,
      centroid,
      dofs: Int32Array.from(elementDofMap(element)),
      freeRowIndices: null,
      assemblyLocalSlots: null
    };
  });
}

function buildCompressedAssemblyPattern(elementCaches, freeIndexByDof, freeDofCount) {
  const rowColSets = Array.from({ length: freeDofCount }, () => new Set());

  elementCaches.forEach((elementCache) => {
    const freeRowIndices = new Int32Array(6);
    freeRowIndices.fill(-1);
    for (let localIndex = 0; localIndex < 6; localIndex += 1) {
      const freeRowIndex = freeIndexByDof.get(elementCache.dofs[localIndex]);
      if (freeRowIndex != null) freeRowIndices[localIndex] = freeRowIndex;
    }
    elementCache.freeRowIndices = freeRowIndices;
    elementCache.assemblyLocalSlots = new Int32Array(36);
    elementCache.assemblyLocalSlots.fill(-1);
    for (let localRow = 0; localRow < 6; localRow += 1) {
      const freeRowIndex = freeRowIndices[localRow];
      if (freeRowIndex < 0) continue;
      for (let localCol = 0; localCol < 6; localCol += 1) {
        const freeColIndex = freeRowIndices[localCol];
        if (freeColIndex < 0) continue;
        rowColSets[freeRowIndex].add(freeColIndex);
      }
    }
  });

  const rowTemplates = rowColSets.map((rowSet, rowIndex) => {
    const indices = Int32Array.from([...rowSet].sort((left, right) => left - right));
    const slotByCol = new Map();
    let diagIndex = -1;
    for (let slotIndex = 0; slotIndex < indices.length; slotIndex += 1) {
      slotByCol.set(indices[slotIndex], slotIndex);
      if (indices[slotIndex] === rowIndex) diagIndex = slotIndex;
    }
    return { indices, diagIndex, slotByCol };
  });

  elementCaches.forEach((elementCache) => {
    for (let localRow = 0; localRow < 6; localRow += 1) {
      const freeRowIndex = elementCache.freeRowIndices[localRow];
      if (freeRowIndex < 0) continue;
      const template = rowTemplates[freeRowIndex];
      for (let localCol = 0; localCol < 6; localCol += 1) {
        const freeColIndex = elementCache.freeRowIndices[localCol];
        if (freeColIndex < 0) continue;
        const slotIndex = template.slotByCol.get(freeColIndex);
        if (slotIndex != null) elementCache.assemblyLocalSlots[localRow * 6 + localCol] = slotIndex;
      }
    }
  });

  return {
    rows: rowTemplates.map((rowTemplate) => ({
      indices: rowTemplate.indices,
      diagIndex: rowTemplate.diagIndex
    }))
  };
}

function createCompressedRowsFromPattern(pattern) {
  return pattern.rows.map((rowTemplate) => ({
    indices: rowTemplate.indices,
    values: new Float64Array(rowTemplate.indices.length),
    diagIndex: rowTemplate.diagIndex,
    diag: 0
  }));
}

function finalizeCompressedRows(rows) {
  rows.forEach((row) => {
    row.diag = row.diagIndex >= 0 ? row.values[row.diagIndex] || 0 : 0;
  });
}

function expandSolutionVector(ndof, freeDofs, fixedValues, freeSolution) {
  const U = new Float64Array(ndof);
  fixedValues.forEach((value, dof) => {
    U[dof] = value;
  });
  freeDofs.forEach((dof, index) => {
    U[dof] = freeSolution[index];
  });
  return U;
}

function gatherElementDisplacements(U, dofs) {
  const out = new Float64Array(6);
  for (let i = 0; i < 6; i += 1) out[i] = U[dofs[i]];
  return out;
}

function multiplyMat3x6Vec6(matrix, vector) {
  return {
    exx: matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2] + matrix[0][3] * vector[3] + matrix[0][4] * vector[4] + matrix[0][5] * vector[5],
    eyy: matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2] + matrix[1][3] * vector[3] + matrix[1][4] * vector[4] + matrix[1][5] * vector[5],
    gxy: matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2] + matrix[2][3] * vector[3] + matrix[2][4] * vector[4] + matrix[2][5] * vector[5]
  };
}

function buildElementAnalysisState(elementCache, U) {
  const ue = gatherElementDisplacements(U, elementCache.dofs);
  const strain = multiplyMat3x6Vec6(elementCache.B, ue);
  return {
    element: elementCache.element,
    nodes: elementCache.nodes,
    ue,
    area: elementCache.area,
    B: elementCache.B,
    strain,
    strainTrial6: liftPlaneStrainStrainTo6(strain)
  };
}

function recoverElementMaterialResponse(elementCache, U, materialPoint, analysisContext = null) {
  const elementState = buildElementAnalysisState(elementCache, U);
  const previousTrialState = materialPoint.trialState ? cloneMaterialPointState(materialPoint.trialState) : cloneMaterialPointState(materialPoint.committedState);
  const update = materialPoint.materialModel.update({
    strainTrial6: elementState.strainTrial6,
    committedState: materialPoint.committedState,
    materialParameters: materialPoint.materialParameters,
    analysisContext: {
      ...analysisContext,
      previousTrialState,
      elementIndex: elementCache.elementIndex,
      regionIndex: materialPoint.regionIndex
    }
  });
  return {
    ...elementState,
    stress2D: extractStress2DFrom6(update.stressTrial6),
    tangent2D: extractTangent2DFrom6(update.tangent6x6),
    update
  };
}

function fallbackK0(phiEffDeg) {
  const phi = (Math.max(Number(phiEffDeg) || 0, 0) * Math.PI) / 180;
  return Math.max(1 - Math.sin(phi), 0);
}

function totalStress6ToCompressionPositiveStress3D(stress6) {
  return {
    sxx: -(Number(stress6?.[0]) || 0),
    syy: -(Number(stress6?.[1]) || 0),
    szz: -(Number(stress6?.[2]) || 0),
    txy: -(Number(stress6?.[3]) || 0)
  };
}

function buildK0ControlledInitialEffectiveStress6(totalStress6, materialParameters, porePressure = 0) {
  const totalStress = totalStress6ToCompressionPositiveStress3D(totalStress6);
  const u0 = Math.max(Number(porePressure) || 0, 0);
  const sigmaV0Eff = Math.max(totalStress.syy - u0, 0);
  const K0 = Number.isFinite(Number(materialParameters?.K0nc))
    ? Math.max(Number(materialParameters.K0nc), 0)
    : fallbackK0(materialParameters?.phiEffDeg);
  const sigmaH0Eff = K0 * sigmaV0Eff;
  return [
    -sigmaH0Eff,
    -sigmaV0Eff,
    -sigmaH0Eff,
    -(Number(totalStress.txy) || 0),
    0,
    0
  ];
}

function recoverInitialFieldFromGeostaticSolution(mesh, elementCaches, Ugeo, regionConstitutiveByRegion, options, porePressureByElement, warnings) {
  const out = [];
  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const cell = mesh.cells[elementCache.cellIndex];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    const materialPoint = createMaterialPoint({
      materialModel: createLinearElasticMaterial(constitutive.materialParameters, warnings),
      materialParameters: constitutive.materialParameters,
      elementIndex,
      regionIndex: cell?.regionIndex ?? -1
    });
    const response = recoverElementMaterialResponse(elementCache, Ugeo, materialPoint, {
      stage: 'geostatic-initialization'
    });
    const u0 = Math.max(Number(porePressureByElement?.[elementIndex]) || 0, 0);
    out.push(buildK0ControlledInitialEffectiveStress6(response.update?.stressTrial6, constitutive.materialParameters, u0));
  }
  return out;
}

async function buildGeostaticInitialization(
  mesh,
  elementCaches,
  model,
  options,
  warnings,
  regionConstitutiveByRegion,
  ndof,
  compressedRows,
  freeDofs,
  fixedValues,
  gravityCompressedRhs,
  porePressureByElement,
  runControl,
  onProgress
) {
  onProgress({
    stage: 'solving',
    percent: 64,
    message: 'Solving the geostatic gravity step for the initial stress field...'
  });

  const geostaticCg = await solveCg(compressedRows, gravityCompressedRhs, null, MAX_CG_ITER, CG_REL_TOL, CG_ABS_TOL, runControl);
  if (geostaticCg.interrupted) {
    throw new Error('Deformation run was interrupted before geostatic initialization became available.');
  }

  if (!geostaticCg.converged) {
    pushUniqueWarning(
      warnings,
      `Geostatic gravity-step initialization did not converge (residual ${geostaticCg.residualNorm.toExponential(2)} after ${geostaticCg.iterations} iterations), so the deformation screen fell back to flat-ground K0 initial stress.`
    );
    return {
      initialField: buildFlatK0InitialEffectiveStressField(mesh, model, options, warnings),
      mode: 'flat-k0-fallback',
      iterations: geostaticCg.iterations,
      residualNorm: geostaticCg.residualNorm
    };
  }

  const Ugeo = expandSolutionVector(ndof, freeDofs, fixedValues, geostaticCg.solution);
  const initialField = recoverInitialFieldFromGeostaticSolution(mesh, elementCaches, Ugeo, regionConstitutiveByRegion, options, porePressureByElement, warnings);
  const hasInvalidStress = initialField.some((stress6) => !Array.isArray(stress6) || stress6.some((value) => !Number.isFinite(Number(value))));
  if (hasInvalidStress) {
    pushUniqueWarning(
      warnings,
      'Geostatic gravity-step initialization produced an invalid stress state, so the deformation screen fell back to flat-ground K0 initial stress.'
    );
    return {
      initialField: buildFlatK0InitialEffectiveStressField(mesh, model, options, warnings),
      mode: 'flat-k0-fallback',
      iterations: geostaticCg.iterations,
      residualNorm: geostaticCg.residualNorm
    };
  }

  return {
    initialField,
    mode: 'gravity-step-k0nc',
    iterations: geostaticCg.iterations,
    residualNorm: geostaticCg.residualNorm
  };
}

function buildElementMaterialPoints(mesh, regionConstitutiveByRegion, initialField, options, warnings) {
  return mesh.elements.map((_element, elementIndex) => {
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    const initialStress6 = initialField?.[elementIndex];
    const committedState = Array.isArray(initialStress6)
      ? seedMaterialPointStateFromEffectiveStress6(initialStress6, constitutive.materialParameters)
      : seedMaterialPointStateFromInitialStress(initialStress6, constitutive.materialParameters);
    return createMaterialPoint({
      materialModel: constitutive.materialModel,
      materialParameters: constitutive.materialParameters,
      committedState,
      elementIndex,
      regionIndex: cell?.regionIndex ?? -1
    });
  });
}

function resetMaterialPointTrials(materialPoints) {
  materialPoints.forEach((materialPoint) => {
    materialPoint.trialState = cloneMaterialPointState(materialPoint.committedState);
    materialPoint.diagnostics = null;
  });
}

async function assembleNonlinearSystem(elementCaches, assemblyPattern, UTrial, materialPoints, loadRhsFreeBase, loadFactor, runControl, stageLabel = 'nonlinear-stage') {
  const compressedRows = createCompressedRowsFromPattern(assemblyPattern);
  const internalForceFree = new Float64Array(loadRhsFreeBase.length);
  let activeCount = 0;
  let changedCount = 0;
  let maxEta = 0;
  let maxStrengthReserve = 0;

  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const materialPoint = materialPoints[elementIndex];
    const previousTrialActive = materialPoint.trialState?.currentlyMcActive === true;
    const response = recoverElementMaterialResponse(elementCache, UTrial, materialPoint, {
      stage: stageLabel,
      loadFactor
    });
    materialPoint.trialState = response.update.trialState;
    materialPoint.diagnostics = response.update.diagnostics;
    const currentTrialActive = response.update.trialState?.currentlyMcActive === true;
    if (currentTrialActive) activeCount += 1;
    if (currentTrialActive !== previousTrialActive) changedCount += 1;
    maxEta = Math.max(maxEta, Number(response.update.diagnostics?.etaMcFinal) || 0);
    maxStrengthReserve = Math.max(maxStrengthReserve, Number(response.update.diagnostics?.localStrengthReserve) || 0);

    addMatrixBlockToCompressedRows(
      compressedRows,
      elementCache,
      elementStiffnessT3FromBAndArea(response.B, response.area, response.tangent2D)
    );
    const referenceStress2D = extractStress2DFrom6(materialPoint.referenceState?.effectiveStress6);
    const stressIncrement2D = {
      sxx: response.stress2D.sxx - referenceStress2D.sxx,
      syy: response.stress2D.syy - referenceStress2D.syy,
      txy: response.stress2D.txy - referenceStress2D.txy
    };
    addVectorBlockToFreeRhs(
      internalForceFree,
      elementCache.freeRowIndices,
      elementInternalForceVector(response.B, stressIncrement2D, response.area)
    );

    if (elementIndex % 200 === 0 && (await runCheckpoint(runControl))) {
      throw new Error('Deformation run was interrupted during nonlinear assembly.');
    }
  }

  finalizeCompressedRows(compressedRows);
  const targetForceFree = cloneScaledVector(loadRhsFreeBase, loadFactor);
  const residualFree = cloneScaledVector(targetForceFree, 1);
  addScaledVectorInPlace(residualFree, internalForceFree, -1);

  return {
    compressedRows,
    residualFree,
    targetForceFree,
    activeCount,
    changedCount,
    maxEta,
    maxStrengthReserve
  };
}

async function backtrackPlasticCorrection(
  elementCaches,
  assemblyPattern,
  uBase,
  correction,
  currentResidualNorm,
  materialPoints,
  loadRhsFreeBase,
  targetLoadFactor,
  runControl,
  analysisStageLabel
) {
  const stepScales = [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625];
  let best = null;
  const improvementTarget = Math.max(currentResidualNorm * (1 - 1e-4), currentResidualNorm - 1e-8);

  for (let index = 0; index < stepScales.length; index += 1) {
    const stepScale = stepScales[index];
    const uCandidate = Float64Array.from(uBase);
    addScaledVectorInPlace(uCandidate, correction, stepScale);
    resetMaterialPointTrials(materialPoints);
    const assembly = await assembleNonlinearSystem(
      elementCaches,
      assemblyPattern,
      uCandidate,
      materialPoints,
      loadRhsFreeBase,
      targetLoadFactor,
      runControl,
      analysisStageLabel
    );
    const residualNorm = vectorNorm(assembly.residualFree);
    if (!best || residualNorm < best.residualNorm) {
      best = {
        stepScale,
        residualNorm,
        uCandidate,
        assembly,
        improved: residualNorm < improvementTarget
      };
    }
    if (residualNorm < improvementTarget) return best;
  }

  return best;
}

function shouldPreferDisplayCandidate(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  if ((Number(candidate.loadFactor) || 0) > (Number(current.loadFactor) || 0) + 1e-10) return true;
  if ((Number(candidate.loadFactor) || 0) < (Number(current.loadFactor) || 0) - 1e-10) return false;
  return (Number(candidate.residualNorm) || Number.POSITIVE_INFINITY) < (Number(current.residualNorm) || Number.POSITIVE_INFINITY) - 1e-12;
}

function snapshotDisplayedState(solution, loadFactor, assembly, mode, reason = '') {
  if (!solution || !(solution.length > 0)) return null;
  const targetForceFree = assembly?.targetForceFree;
  const residualFree = assembly?.residualFree;
  const residualNorm = residualFree
    ? vectorNorm(residualFree)
    : (Number.isFinite(Number(assembly?.residualNorm)) ? Number(assembly.residualNorm) : Number.POSITIVE_INFINITY);
  const rhsNorm = targetForceFree
    ? vectorNorm(targetForceFree)
    : (Number.isFinite(Number(assembly?.rhsNorm)) ? Number(assembly.rhsNorm) : 0);
  const relativeResidualNorm = rhsNorm > CG_NUMERIC_EPS
    ? residualNorm / rhsNorm
    : (Number.isFinite(Number(assembly?.relativeResidualNorm)) ? Number(assembly.relativeResidualNorm) : (residualNorm > 0 ? Number.POSITIVE_INFINITY : 0));
  return {
    solution: Float64Array.from(solution),
    loadFactor: Math.max(Number(loadFactor) || 0, 0),
    residualNorm,
    relativeResidualNorm,
    activeCount: Number(assembly?.activeCount) || 0,
    maxEta: Number(assembly?.maxEta) || 0,
    stateChanges: Number(assembly?.changedCount) || 0,
    mode,
    reason
  };
}

async function solveNonlinearStage1(
  elementCaches,
  assemblyPattern,
  loadRhsFreeBase,
  materialPoints,
  ndof,
  freeDofs,
  fixedValues,
  runControl,
  onProgress,
  options = {}
) {
  const constitutiveModel = options?.constitutiveModel === 'linear-elastic'
    ? 'linear-elastic'
    : options?.constitutiveModel === 'mc-plastic'
      ? 'mc-plastic'
      : 'mc-reduced-stiffness';
  const isLinearElastic = constitutiveModel === 'linear-elastic';
  const requiresStableActiveSet = constitutiveModel === 'mc-reduced-stiffness';
  const requiresDisplacementTolerance = constitutiveModel !== 'mc-plastic';
  const usesUnsymmetricSolver = constitutiveModel === 'mc-plastic' && options?.useUnsymmetricPlasticSolver === true;
  const maxIterations = Math.max(Math.round(Number(options?.nonlinearMaxIterations) || NONLINEAR_MAX_ITER), 1);
  const growthFactor = Math.max(Number(options?.loadStepGrowthFactor) || NONLINEAR_GROWTH_FACTOR, 1);
  const cutbackFactor = Math.min(Math.max(Number(options?.loadStepCutbackFactor) || NONLINEAR_CUTBACK_FACTOR, 0.1), 0.9);
  const plasticGrowthFactor = Math.max(Number(options?.plasticLoadStepGrowthFactor) || 1.05, 1);
  const plasticCutbackFactor = Math.min(Math.max(Number(options?.plasticLoadStepCutbackFactor) || 0.4, 0.1), 0.9);
  const minLoadStep = Math.max(Number(options?.minLoadStep) || NONLINEAR_MIN_LOAD_STEP, 1e-4);
  let stepSize = isLinearElastic
    ? 1
    : Math.min(Math.max(Number(options?.initialLoadStep) || NONLINEAR_INITIAL_LOAD_STEP, minLoadStep), 1);
  const maxLoadSteps = Math.max(Math.round(Number(options?.maxLoadSteps) || NONLINEAR_MAX_LOAD_STEPS), 1);

  let loadFactorCommitted = 0;
  let uCommitted = new Float64Array(ndof);
  let acceptedSteps = 0;
  let rejectedSteps = 0;
  let totalNonlinearIterations = 0;
  let totalCgIterations = 0;
  let lastResidualNorm = 0;
  let lastRelativeResidual = 0;
  let lastDisplacementNorm = 0;
  let lastRelativeDisplacement = 0;
  let lastStateChanges = 0;
  let finalActiveCount = 0;
  let peakActiveCount = 0;
  let peakEta = 0;
  let loadStepCounter = 0;
  const loadStepHistory = [];
  const residualHistory = [];
  let terminalFailureReason = '';
  let terminatedByFailure = false;
  let bestDisplayedState = null;
  let warmStartFreeCorrection = null;
  const analysisStageLabel = constitutiveModel === 'mc-plastic'
    ? 'nonlinear-stage-2'
    : constitutiveModel === 'linear-elastic'
      ? 'nonlinear-elastic'
      : 'nonlinear-stage-1';

  resetMaterialPointTrials(materialPoints);

  while (loadFactorCommitted < 1 - 1e-10) {
    loadStepCounter += 1;
    if (loadStepCounter > maxLoadSteps) {
      terminalFailureReason = `${constitutiveModel === 'mc-plastic' ? 'Stage 2' : 'Stage 1'} deformation solve exceeded the maximum number of load steps (${maxLoadSteps}).`;
      terminatedByFailure = true;
      break;
    }
    const remaining = 1 - loadFactorCommitted;
    const actualStep = Math.min(stepSize, remaining);
    const targetLoadFactor = loadFactorCommitted + actualStep;
    const uTrial = Float64Array.from(uCommitted);
    resetMaterialPointTrials(materialPoints);
    const stepRecord = {
      index: loadStepCounter,
      targetLoadFactor,
      attemptedStep: actualStep,
      constitutiveModel,
      status: 'running',
      iterations: 0,
      accepted: false,
      rejected: false,
      peakActiveCount: 0,
      peakEta: 0,
      finalResidualNorm: null,
      relativeResidualNorm: null,
      reason: ''
    };

    let converged = false;
    let failureReason = '';
    let lastCorrection = new Float64Array(ndof);
    let stepBestState = null;
    const shouldWarmStartLinearSolve = constitutiveModel === 'mc-plastic';
    let iterationLinearGuess = warmStartFreeCorrection && warmStartFreeCorrection.length === freeDofs.length
      ? (shouldWarmStartLinearSolve ? Float64Array.from(warmStartFreeCorrection) : null)
      : null;

    onProgress({
      stage: 'solving',
      percent: 74,
      message: `${constitutiveModel === 'mc-plastic' ? 'Stage 2 elastoplastic' : 'Stage 1'} ${constitutiveModel === 'linear-elastic' ? 'elastic' : constitutiveModel === 'mc-plastic' ? 'plastic' : 'MC-active'} solve: load step ${acceptedSteps + rejectedSteps + 1}, target ${(100 * targetLoadFactor).toFixed(0)}%...`
    });

    for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
      totalNonlinearIterations += 1;
      let assembled;
      try {
        assembled = await assembleNonlinearSystem(
          elementCaches,
          assemblyPattern,
          uTrial,
          materialPoints,
          loadRhsFreeBase,
          targetLoadFactor,
          runControl,
          analysisStageLabel
        );
      } catch (error) {
        failureReason = error instanceof Error ? error.message : String(error);
        break;
      }
      finalActiveCount = assembled.activeCount;
      peakActiveCount = Math.max(peakActiveCount, assembled.activeCount);
      peakEta = Math.max(peakEta, assembled.maxEta);
      const residualNorm = vectorNorm(assembled.residualFree);
      const rhsNorm = vectorNorm(assembled.targetForceFree);
      const deltaNorm = vectorNorm(lastCorrection);
      const solutionNorm = vectorNorm(uTrial);
      const tolerance = nonlinearToleranceState(
        residualNorm,
        rhsNorm,
        deltaNorm,
        solutionNorm,
        options
      );
      lastResidualNorm = residualNorm;
      lastRelativeResidual = tolerance.relativeResidual;
      lastDisplacementNorm = deltaNorm;
      lastRelativeDisplacement = tolerance.relativeDisplacement;
      lastStateChanges = assembled.changedCount;
      stepRecord.iterations = iteration;
      stepRecord.peakActiveCount = Math.max(stepRecord.peakActiveCount, assembled.activeCount);
      stepRecord.peakEta = Math.max(stepRecord.peakEta, assembled.maxEta);
      residualHistory.push({
        loadStepIndex: loadStepCounter,
        iteration,
        targetLoadFactor,
        residualNorm,
        relativeResidualNorm: tolerance.relativeResidual,
        displacementCorrectionNorm: deltaNorm,
        relativeDisplacementCorrectionNorm: tolerance.relativeDisplacement,
        activeCount: assembled.activeCount,
        stateChanges: assembled.changedCount
      });
      const assembledState = snapshotDisplayedState(uTrial, targetLoadFactor, assembled, 'failed-step-iteration', failureReason);
      if (shouldPreferDisplayCandidate(assembledState, stepBestState)) stepBestState = assembledState;

      const assembledConverged = tolerance.residualConverged && (!requiresDisplacementTolerance || tolerance.displacementConverged);
      if (iteration > 1 && assembledConverged && (!requiresStableActiveSet || assembled.changedCount === 0)) {
        converged = true;
        break;
      }

      const linearSolve = usesUnsymmetricSolver ? solveBiCgStab : solveCg;
      const cg = await linearSolve(
        assembled.compressedRows,
        assembled.residualFree,
        shouldWarmStartLinearSolve ? iterationLinearGuess : null,
        MAX_CG_ITER,
        CG_REL_TOL,
        CG_ABS_TOL,
        runControl
      );
      totalCgIterations += cg.iterations;
      if (cg.interrupted) {
        throw new Error(`Deformation run was interrupted during the ${constitutiveModel === 'mc-plastic' ? 'Stage 2 elastoplastic' : 'Stage 1 nonlinear'} solve.`);
      }
      const acceptableLinearizedResidual = isLinearElastic
        ? Math.max(CG_ABS_TOL, 1e-8 * Math.max(Number(cg.rhsNorm) || 0, 0))
        : Math.max(
          CG_ABS_TOL,
          0.25 * Math.max(Number(options?.residualAbsTol) || NONLINEAR_RESIDUAL_ABS_TOL, NONLINEAR_RESIDUAL_ABS_TOL)
        );
      const allowInexactLinearizedSolve = cg.residualNorm <= acceptableLinearizedResidual;
      if (!cg.converged && !allowInexactLinearizedSolve) {
        failureReason = `linearized solve did not converge (residual ${cg.residualNorm.toExponential(2)} after ${cg.iterations} iterations)`;
        break;
      }
      lastCorrection = expandSolutionVector(ndof, freeDofs, fixedValues, cg.solution);
      let correctionNorm = vectorNorm(lastCorrection);
      let refreshed = null;
      let lineSearchStepScale = 1;
      if (constitutiveModel === 'mc-plastic' && correctionNorm > 0) {
        try {
          const lineSearch = await backtrackPlasticCorrection(
            elementCaches,
            assemblyPattern,
            uTrial,
            lastCorrection,
            residualNorm,
            materialPoints,
            loadRhsFreeBase,
            targetLoadFactor,
            runControl,
            analysisStageLabel
          );
          if (lineSearch) {
            if (!lineSearch.improved) {
              failureReason = 'plastic line search stalled';
              break;
            }
            copyVectorInto(uTrial, lineSearch.uCandidate);
            lastCorrection = cloneScaledVector(lastCorrection, lineSearch.stepScale);
            correctionNorm = vectorNorm(lastCorrection);
            refreshed = lineSearch.assembly;
            lineSearchStepScale = lineSearch.stepScale;
          } else {
            addScaledVectorInPlace(uTrial, lastCorrection, 1);
          }
        } catch (error) {
          failureReason = error instanceof Error ? error.message : String(error);
          break;
        }
      } else {
        addScaledVectorInPlace(uTrial, lastCorrection, 1);
      }
      iterationLinearGuess = shouldWarmStartLinearSolve ? Float64Array.from(cg.solution) : null;
      if (shouldWarmStartLinearSolve && lineSearchStepScale !== 1) {
        for (let i = 0; i < iterationLinearGuess.length; i += 1) iterationLinearGuess[i] *= lineSearchStepScale;
      }
      const updatedSolutionNorm = vectorNorm(uTrial);
      const postSolveTolerance = nonlinearToleranceState(
        residualNorm,
        rhsNorm,
        correctionNorm,
        updatedSolutionNorm,
        options
      );
      lastDisplacementNorm = correctionNorm;
      lastRelativeDisplacement = postSolveTolerance.relativeDisplacement;
      if (
        constitutiveModel === 'mc-plastic' &&
        iteration >= 6 &&
        lineSearchStepScale <= 0.125 &&
        !postSolveTolerance.residualConverged
      ) {
        failureReason = 'plastic correction required excessive damping';
        break;
      }
      const postSolveConverged = postSolveTolerance.residualConverged && (!requiresDisplacementTolerance || postSolveTolerance.displacementConverged);
      if ((isLinearElastic || postSolveConverged) && (!requiresStableActiveSet || assembled.changedCount === 0)) {
        if (!refreshed) {
          resetMaterialPointTrials(materialPoints);
          try {
            refreshed = await assembleNonlinearSystem(
              elementCaches,
              assemblyPattern,
              uTrial,
              materialPoints,
              loadRhsFreeBase,
              targetLoadFactor,
              runControl,
              analysisStageLabel
            );
          } catch (error) {
            failureReason = error instanceof Error ? error.message : String(error);
            break;
          }
        }
        finalActiveCount = refreshed.activeCount;
        peakActiveCount = Math.max(peakActiveCount, refreshed.activeCount);
        peakEta = Math.max(peakEta, refreshed.maxEta);
        const refreshedResidualNorm = vectorNorm(refreshed.residualFree);
        const refreshedRhsNorm = vectorNorm(refreshed.targetForceFree);
        const refreshedTolerance = nonlinearToleranceState(
          refreshedResidualNorm,
          refreshedRhsNorm,
          correctionNorm,
          updatedSolutionNorm,
          options
        );
        const refreshedState = snapshotDisplayedState(uTrial, targetLoadFactor, refreshed, 'failed-step-refresh', failureReason);
        if (shouldPreferDisplayCandidate(refreshedState, stepBestState)) stepBestState = refreshedState;
        lastResidualNorm = refreshedResidualNorm;
        lastRelativeResidual = refreshedTolerance.relativeResidual;
        lastDisplacementNorm = correctionNorm;
        lastRelativeDisplacement = refreshedTolerance.relativeDisplacement;
        lastStateChanges = refreshed.changedCount;
        const refreshedConverged = refreshedTolerance.residualConverged && (!requiresDisplacementTolerance || refreshedTolerance.displacementConverged);
        if ((!requiresStableActiveSet || refreshed.changedCount === 0) && refreshedConverged) {
          converged = true;
          break;
        }
      }

      if (await runCheckpoint(runControl)) {
        throw new Error(`Deformation run was interrupted during the ${constitutiveModel === 'mc-plastic' ? 'Stage 2 elastoplastic' : 'Stage 1 nonlinear'} solve.`);
      }
    }

    if (converged) {
      materialPoints.forEach((materialPoint) => commitMaterialPoint(materialPoint));
      uCommitted = Float64Array.from(uTrial);
      loadFactorCommitted = targetLoadFactor;
      const committedAssembly = stepBestState && Math.abs((Number(stepBestState.loadFactor) || 0) - targetLoadFactor) <= 1e-10
        ? {
            residualFree: null,
            targetForceFree: null,
            activeCount: stepBestState.activeCount,
            maxEta: stepBestState.maxEta,
            changedCount: stepBestState.stateChanges
          }
        : null;
      const committedState = snapshotDisplayedState(
        uCommitted,
        loadFactorCommitted,
        committedAssembly || {
          residualFree: new Float64Array([lastResidualNorm]),
          targetForceFree: new Float64Array([Math.max(lastResidualNorm / Math.max(lastRelativeResidual || 0, 1e-12), 0)]),
          activeCount: finalActiveCount,
          maxEta: peakEta,
          changedCount: lastStateChanges
        },
        'committed'
      );
      if (shouldPreferDisplayCandidate(committedState, bestDisplayedState)) bestDisplayedState = committedState;
      acceptedSteps += 1;
      stepRecord.status = 'accepted';
      stepRecord.accepted = true;
      stepRecord.finalResidualNorm = lastResidualNorm;
      stepRecord.relativeResidualNorm = lastRelativeResidual;
      loadStepHistory.push(stepRecord);
      warmStartFreeCorrection = shouldWarmStartLinearSolve && iterationLinearGuess ? Float64Array.from(iterationLinearGuess) : null;
      const effectiveGrowthFactor = constitutiveModel === 'mc-plastic' && stepRecord.peakActiveCount > 0
        ? Math.min(growthFactor, plasticGrowthFactor)
        : growthFactor;
      stepSize = Math.min(actualStep * effectiveGrowthFactor, 1 - loadFactorCommitted || actualStep);
      continue;
    }

    rejectedSteps += 1;
    stepRecord.status = 'rejected';
    stepRecord.rejected = true;
    stepRecord.finalResidualNorm = lastResidualNorm;
    stepRecord.relativeResidualNorm = lastRelativeResidual;
    stepRecord.reason = failureReason || 'nonlinear iterations exhausted';
    loadStepHistory.push(stepRecord);
    if (shouldPreferDisplayCandidate(stepBestState, bestDisplayedState)) {
      bestDisplayedState = {
        ...stepBestState,
        reason: stepRecord.reason
      };
    }
    warmStartFreeCorrection = shouldWarmStartLinearSolve && iterationLinearGuess
      ? Float64Array.from(iterationLinearGuess)
      : warmStartFreeCorrection;
    const effectiveCutbackFactor = constitutiveModel === 'mc-plastic' && stepRecord.peakActiveCount > 0
      ? Math.min(cutbackFactor, plasticCutbackFactor)
      : cutbackFactor;
    stepSize = actualStep * effectiveCutbackFactor;
    resetMaterialPointTrials(materialPoints);
    if (stepSize < minLoadStep - 1e-12) {
      terminalFailureReason = `${constitutiveModel === 'mc-plastic' ? 'Stage 2' : 'Stage 1'} deformation solve could not converge the load step to ${(100 * targetLoadFactor).toFixed(1)}% (last reason: ${failureReason || 'nonlinear iterations exhausted'}).`;
      terminatedByFailure = true;
      break;
    }
  }

  const fallbackCommittedState = snapshotDisplayedState(
    uCommitted,
    loadFactorCommitted,
    {
      residualFree: new Float64Array([lastResidualNorm]),
      targetForceFree: new Float64Array([Math.max(lastResidualNorm / Math.max(lastRelativeResidual || 0, 1e-12), 0)]),
      activeCount: finalActiveCount,
      maxEta: peakEta,
      changedCount: lastStateChanges
    },
    'committed',
    terminalFailureReason
  );
  if (shouldPreferDisplayCandidate(fallbackCommittedState, bestDisplayedState)) bestDisplayedState = fallbackCommittedState;

  if (terminatedByFailure && !bestDisplayedState) {
    throw new Error(terminalFailureReason || `${constitutiveModel === 'mc-plastic' ? 'Stage 2' : 'Stage 1'} deformation solve failed before a usable displacement state became available.`);
  }

  const displayedState = terminatedByFailure ? (bestDisplayedState || fallbackCommittedState) : (fallbackCommittedState || bestDisplayedState);
  const displayedSolution = displayedState?.solution || uCommitted;
  const displayedLoadFactor = Math.max(Number(displayedState?.loadFactor) || loadFactorCommitted || 0, 0);

  resetMaterialPointTrials(materialPoints);
  const finalAssembly = await assembleNonlinearSystem(
    elementCaches,
    assemblyPattern,
    displayedSolution,
    materialPoints,
    loadRhsFreeBase,
    displayedLoadFactor,
    runControl,
    analysisStageLabel
  );
  finalActiveCount = finalAssembly.activeCount;
  peakActiveCount = Math.max(peakActiveCount, finalAssembly.activeCount);
  peakEta = Math.max(peakEta, finalAssembly.maxEta);
  lastResidualNorm = vectorNorm(finalAssembly.residualFree);
  const finalRhsNorm = vectorNorm(finalAssembly.targetForceFree);
  const finalTolerance = nonlinearToleranceState(
    lastResidualNorm,
    finalRhsNorm,
    lastDisplacementNorm,
    vectorNorm(uCommitted),
    options
  );
  lastRelativeResidual = finalTolerance.relativeResidual;
  lastRelativeDisplacement = finalTolerance.relativeDisplacement;
  lastStateChanges = finalAssembly.changedCount;

  return {
    solution: displayedSolution,
    acceptedSteps,
    rejectedSteps,
    totalNonlinearIterations,
    totalCgIterations,
    residualNorm: lastResidualNorm,
    relativeResidualNorm: lastRelativeResidual,
    displacementCorrectionNorm: lastDisplacementNorm,
    relativeDisplacementCorrectionNorm: lastRelativeDisplacement,
    lastStateChanges,
    finalActiveCount,
    peakActiveCount,
    peakEta,
    loadFactorCommitted,
    displayedLoadFactor,
    converged: !terminatedByFailure,
    convergenceState: terminatedByFailure ? 'partial' : 'converged',
    displayedStateMode: displayedState?.mode || 'committed',
    failureReason: terminatedByFailure ? (displayedState?.reason || terminalFailureReason) : '',
    loadStepHistory,
    residualHistory
  };
}

function buildTerrainSettlementProfile(mesh, nodalDisplacements) {
  const terrainNodeIds = new Set();
  (mesh.constraintEdges || []).forEach((edge) => {
    if (edge?.markerType !== 'outer' || edge?.source !== 'terrain') return;
    terrainNodeIds.add(edge.n1);
    terrainNodeIds.add(edge.n2);
  });
  return [...terrainNodeIds]
    .map((nodeId) => ({
      x: mesh.nodes[nodeId]?.x ?? 0,
      y: mesh.nodes[nodeId]?.y ?? 0,
      settlement: -(nodalDisplacements[nodeId]?.uy || 0),
      ux: nodalDisplacements[nodeId]?.ux || 0
    }))
    .sort((a, b) => a.x - b.x || b.y - a.y);
}

function summarizeDeformation(nodalDisplacements, elementResults) {
  let maxSettlement = 0;
  let maxHorizontalDisplacement = 0;
  let activeMcElementCount = 0;
  let exceededMcElementCount = 0;
  let maxEquivalentPlasticStrain = 0;
  nodalDisplacements.forEach((item) => {
    maxSettlement = Math.max(maxSettlement, -(item?.uy || 0));
    maxHorizontalDisplacement = Math.max(maxHorizontalDisplacement, Math.abs(item?.ux || 0));
  });
  let maxMcEta = 0;
  let maxDeltaSigmaYy = 0;
  elementResults.forEach((item) => {
    maxMcEta = Math.max(maxMcEta, Number(item?.mc?.eta) || 0);
    maxDeltaSigmaYy = Math.max(maxDeltaSigmaYy, -Number(item?.stressIncrement?.syy || 0));
    if (item?.materialDiagnostics?.currentlyMcActive) activeMcElementCount += 1;
    if (item?.materialDiagnostics?.hasEverExceededMc) exceededMcElementCount += 1;
    maxEquivalentPlasticStrain = Math.max(maxEquivalentPlasticStrain, Number(item?.materialState?.accumulatedPlasticStrain) || 0);
  });
  return {
    maxSettlement,
    maxHorizontalDisplacement,
    maxMcEta,
    maxDeltaSigmaYy,
    maxEquivalentPlasticStrain,
    activeMcElementCount,
    exceededMcElementCount
  };
}

function recoverElementResults(mesh, elementCaches, U, materialPoints, porePressureByElement = null) {
  const out = [];
  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const cell = mesh.cells[elementCache.cellIndex];
    const materialPoint = materialPoints[elementIndex];
    const response = recoverElementMaterialResponse(elementCache, U, materialPoint, {
      stage: 'final-recovery'
    });
    materialPoint.trialState = response.update.trialState;
    materialPoint.diagnostics = response.update.diagnostics;
    const initialStress = negateNormalAndShear(extractStress2DFrom6(materialPoint.referenceState.effectiveStress6));
    const initialStress3D = effectiveStress6ToCompressionPositiveStress3D(materialPoint.referenceState.effectiveStress6);
    const initialStressFe = extractStress2DFrom6(materialPoint.referenceState.effectiveStress6);
    const stressIncrement = {
      sxx: response.stress2D.sxx - initialStressFe.sxx,
      syy: response.stress2D.syy - initialStressFe.syy,
      txy: response.stress2D.txy - initialStressFe.txy
    };
    const sigmaIncrementGeo = negateNormalAndShear(stressIncrement);
    const sigmaEff = negateNormalAndShear(response.stress2D);
    const sigmaEff3D = effectiveStress6ToCompressionPositiveStress3D(response.update.stressTrial6);
    const porePressure = Math.max(Number(porePressureByElement?.[elementIndex]) || 0, 0);
    const initialTotalStress = {
      sxx: (Number(initialStress?.sxx) || 0) + porePressure,
      syy: (Number(initialStress?.syy) || 0) + porePressure,
      txy: Number(initialStress?.txy) || 0
    };
    const initialTotalStress3D = {
      sxx: (Number(initialStress3D?.sxx) || 0) + porePressure,
      syy: (Number(initialStress3D?.syy) || 0) + porePressure,
      szz: (Number(initialStress3D?.szz) || 0) + porePressure,
      txy: Number(initialStress3D?.txy) || 0
    };
    const totalStress = {
      sxx: (Number(sigmaEff?.sxx) || 0) + porePressure,
      syy: (Number(sigmaEff?.syy) || 0) + porePressure,
      txy: Number(sigmaEff?.txy) || 0
    };
    const totalStress3D = {
      sxx: (Number(sigmaEff3D?.sxx) || 0) + porePressure,
      syy: (Number(sigmaEff3D?.syy) || 0) + porePressure,
      szz: (Number(sigmaEff3D?.szz) || 0) + porePressure,
      txy: Number(sigmaEff3D?.txy) || 0
    };
    const principal = response.update.diagnostics?.principal || principalStress2DCompressionPositive(sigmaEff);
    const mc = response.update.diagnostics?.mc || mohrCoulombIndicator(principal, materialPoint.materialParameters);
    const displayedMaterialState = snapshotMaterialPointState(materialPoint.trialState);
    const committedMaterialState = snapshotMaterialPointState(materialPoint.committedState);
    out.push({
      elementIndex,
      regionIndex: cell?.regionIndex ?? -1,
      area: response.area,
      centroid: elementCache.centroid || cell?.centroid || { x: 0, y: 0 },
      strain: response.strain,
      stressIncrement,
      stressIncrementGeo: sigmaIncrementGeo,
      porePressure,
      initialEffectiveStress: initialStress,
      initialEffectiveStress3D: initialStress3D,
      initialTotalStress,
      initialTotalStress3D,
      effectiveStress: sigmaEff,
      effectiveStress3D: sigmaEff3D,
      totalStress,
      totalStress3D,
      principal,
      mc,
      referenceMaterialState: snapshotMaterialPointState(materialPoint.referenceState),
      committedMaterialState,
      materialState: displayedMaterialState,
      materialDiagnostics: {
        constitutiveModel: response.update.diagnostics?.constitutiveModel || materialPoint.materialModel?.kind || 'linear-elastic',
        activeYieldSurface: displayedMaterialState?.activeYieldSurface || response.update.diagnostics?.activeYieldSurface || 'NONE',
        currentlyMcActive: displayedMaterialState?.currentlyMcActive === true,
        hasEverExceededMc: displayedMaterialState?.hasEverExceededMc === true,
        committedActiveYieldSurface: committedMaterialState?.activeYieldSurface || 'NONE',
        committedCurrentlyMcActive: committedMaterialState?.currentlyMcActive === true,
        committedHasEverExceededMc: committedMaterialState?.hasEverExceededMc === true,
        localStrengthReserve: Number(response.update.diagnostics?.localStrengthReserve),
        etaMcFinal: Number(response.update.diagnostics?.etaMcFinal),
        stateChanged: false
      }
    });
  }
  return out;
}

function samplePointCandidates(mesh, x, y) {
  if (mesh?.sampleGrid && mesh?.sampleBins) {
    const cellSize = Math.max(Number(mesh.sampleGrid.cellSize) || 0, 0.05);
    const ix = Math.floor((x - Number(mesh.sampleGrid.xMin || 0)) / cellSize);
    const iy = Math.floor((y - Number(mesh.sampleGrid.yMin || 0)) / cellSize);
    const keys = new Set();
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const key = `${ix + dx}:${iy + dy}`;
        if (mesh.sampleBins[key]) keys.add(key);
      }
    }
    return [...keys].flatMap((key) => mesh.sampleBins[key] || []);
  }
  return Array.from({ length: mesh?.cells?.length || 0 }, (_item, index) => index);
}

function sampleTriangleValue(point, triPoints, triValues) {
  const [a, b, c] = triPoints;
  const denom = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (!(Math.abs(denom) > GEOM_EPS)) return null;
  const l1 = ((b.y - c.y) * (point.x - c.x) + (c.x - b.x) * (point.y - c.y)) / denom;
  const l2 = ((c.y - a.y) * (point.x - c.x) + (a.x - c.x) * (point.y - c.y)) / denom;
  const l3 = 1 - l1 - l2;
  if (l1 < -GEOM_EPS || l2 < -GEOM_EPS || l3 < -GEOM_EPS) return null;
  return l1 * triValues[0] + l2 * triValues[1] + l3 * triValues[2];
}

export function sampleDeformationState(mesh, result, x, y) {
  if (!mesh?.cells?.length || !result?.nodalDisplacements?.length) return null;
  if (!pointInPolygonHalfOpen(mesh.domainPolygon || [], x, y)) return null;
  const point = { x: Number(x), y: Number(y) };
  const candidateCells = samplePointCandidates(mesh, point.x, point.y);
  for (let i = 0; i < candidateCells.length; i += 1) {
    const cellIndex = candidateCells[i];
    const cell = mesh.cells[cellIndex];
    if (!cell) continue;
    if (
      point.x < cell.bbox.xMin - GEOM_EPS ||
      point.x > cell.bbox.xMax + GEOM_EPS ||
      point.y < cell.bbox.yMin - GEOM_EPS ||
      point.y > cell.bbox.yMax + GEOM_EPS
    ) continue;
    if (!pointInPolygonHalfOpen(cell.polygon, point.x, point.y)) continue;
    for (let j = 0; j < cell.triangleIndices.length; j += 1) {
      const triangleIndex = cell.triangleIndices[j];
      const element = mesh.elements[triangleIndex];
      if (!element) continue;
      const triPoints = element.map((nodeId) => mesh.nodes[nodeId]);
      const ux = sampleTriangleValue(point, triPoints, element.map((nodeId) => result.nodalDisplacements[nodeId]?.ux || 0));
      const uy = sampleTriangleValue(point, triPoints, element.map((nodeId) => result.nodalDisplacements[nodeId]?.uy || 0));
      if (!(Number.isFinite(ux) && Number.isFinite(uy))) continue;
      return {
        point,
        cellIndex,
        triangleIndex,
        ux,
        uy,
        uTotal: Math.hypot(ux, uy),
        settlement: -uy,
        epsilonXx: Number(result.elementResults?.[triangleIndex]?.strain?.exx || 0),
        epsilonYy: Number(result.elementResults?.[triangleIndex]?.strain?.eyy || 0),
        gammaXy: Number(result.elementResults?.[triangleIndex]?.strain?.gxy || 0),
        equivalentPlasticStrain: Number(result.elementResults?.[triangleIndex]?.materialState?.accumulatedPlasticStrain || 0),
        deltaSigmaYy: -Number(result.elementResults?.[triangleIndex]?.stressIncrement?.syy || 0),
        sigmaYyEffInit: Number(result.elementResults?.[triangleIndex]?.initialEffectiveStress?.syy || 0),
        sigmaYyEff: Number(result.elementResults?.[triangleIndex]?.effectiveStress?.syy || 0),
        sigmaYyTotalInit: Number(result.elementResults?.[triangleIndex]?.initialTotalStress?.syy || 0),
        sigmaYyTotal: Number(result.elementResults?.[triangleIndex]?.totalStress?.syy || 0),
        sigmaXxEffInit: Number(result.elementResults?.[triangleIndex]?.initialEffectiveStress?.sxx || 0),
        sigmaXxEff: Number(result.elementResults?.[triangleIndex]?.effectiveStress?.sxx || 0),
        sigmaXxTotalInit: Number(result.elementResults?.[triangleIndex]?.initialTotalStress?.sxx || 0),
        sigmaXxTotal: Number(result.elementResults?.[triangleIndex]?.totalStress?.sxx || 0),
        tauXy: Number(result.elementResults?.[triangleIndex]?.effectiveStress?.txy || 0),
        porePressure: Number(result.elementResults?.[triangleIndex]?.porePressure || 0),
        mcEta: Number(result.elementResults?.[triangleIndex]?.mc?.eta || 0)
      };
    }
  }
  return null;
}

export async function analyzeDeformationModel(input, onProgress = () => {}, runControl = null) {
  const startedAt = performance.now();
  const model = input?.model;
  if (!model?.terrain?.vertices?.length || !model?.regions?.length) {
    throw new Error('The deformation screen needs a valid Bishop section model first.');
  }

  const warnings = [];
  const constitutiveModel = input?.options?.constitutiveModel === 'linear-elastic'
    ? 'linear-elastic'
    : input?.options?.constitutiveModel === 'mc-plastic'
      ? 'mc-plastic'
      : 'mc-reduced-stiffness';
  const options = {
    meshTargetArea: Math.max(Number(input?.options?.meshTargetArea) || 0.05, 0.01),
    loadMode: input?.options?.loadMode === 'total' ? 'total' : 'pressure',
    totalLoad: input?.options?.totalLoad,
    outOfPlaneLength: Math.max(Number(input?.options?.outOfPlaneLength) || 10, 0.1),
    useSeepagePorePressures: input?.options?.useSeepagePorePressures === true,
    constitutiveModel,
    nonlinearMaxIterations: Math.max(Math.round(Number(input?.options?.nonlinearMaxIterations) || NONLINEAR_MAX_ITER), 1),
    initialLoadStep: Math.min(Math.max(Number(input?.options?.initialLoadStep) || NONLINEAR_INITIAL_LOAD_STEP, NONLINEAR_MIN_LOAD_STEP), 1),
    minLoadStep: Math.max(Number(input?.options?.minLoadStep) || NONLINEAR_MIN_LOAD_STEP, 1e-4),
    maxLoadSteps: Math.max(Math.round(Number(input?.options?.maxLoadSteps) || NONLINEAR_MAX_LOAD_STEPS), 1),
    residualRelTol: Math.max(Number(input?.options?.residualRelTol) || NONLINEAR_RESIDUAL_REL_TOL, 1e-8),
    residualAbsTol: Math.max(Number(input?.options?.residualAbsTol) || NONLINEAR_RESIDUAL_ABS_TOL, 1e-9),
    displacementRelTol: Math.max(Number(input?.options?.displacementRelTol) || NONLINEAR_DISPLACEMENT_REL_TOL, 1e-8),
    displacementAbsTol: Math.max(Number(input?.options?.displacementAbsTol) || NONLINEAR_DISPLACEMENT_ABS_TOL, 1e-12),
    loadStepGrowthFactor: Math.max(Number(input?.options?.loadStepGrowthFactor) || NONLINEAR_GROWTH_FACTOR, 1),
    loadStepCutbackFactor: Math.min(Math.max(Number(input?.options?.loadStepCutbackFactor) || NONLINEAR_CUTBACK_FACTOR, 0.1), 0.9),
    plasticLoadStepGrowthFactor: Math.max(Number(input?.options?.plasticLoadStepGrowthFactor) || 1.05, 1),
    plasticLoadStepCutbackFactor: Math.min(Math.max(Number(input?.options?.plasticLoadStepCutbackFactor) || 0.4, 0.1), 0.9),
    useUnsymmetricPlasticSolver: input?.options?.useUnsymmetricPlasticSolver === true
  };
  const load = normalizeLoad(model, options, warnings);
  addDomainExtentWarnings(model, load, warnings);

  if (await runCheckpoint(runControl, true)) {
    throw new Error('Deformation run was interrupted before meshing started.');
  }

  const mesh = await buildDeformationMesh(
    model,
    model.regions,
    {
      ...options,
      load
    },
    (progress) => onProgress(progress)
  );

  const ndof = 2 * mesh.nodes.length;
  const elementCaches = buildDeformationElementCaches(mesh);
  const rows = Array.from({ length: ndof }, () => new Map());
  const loadRhs = new Float64Array(ndof);
  const gravityRhs = new Float64Array(ndof);
  const porePressureByElement = new Float64Array(mesh.elements.length);
  const regionConstitutiveByRegion = prepareRegionConstitutiveModels(mesh, options, warnings);

  onProgress({
    stage: 'solving',
    percent: 46,
    message: 'Assembling the plane-strain stiffness matrix and geostatic gravity load...'
  });

  for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
    const elementCache = elementCaches[elementIndex];
    const cell = mesh.cells[elementCache.cellIndex];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    const initialPorePressure = sampleInitialPorePressure(model, elementCache.centroid.x, elementCache.centroid.y, options, warnings);
    const gammaBulk = initialBulkUnitWeightFromPorePressure(constitutive.materialParameters, initialPorePressure);
    addMatrixBlock(
      rows,
      elementCache.dofs,
      elementStiffnessT3FromBAndArea(elementCache.B, elementCache.area, extractTangent2DFrom6(constitutive.materialModel.initialTangent6x6))
    );
    addVectorBlock(gravityRhs, elementCache.dofs, elementGravityVectorT3FromArea(elementCache.area, gammaBulk));
    porePressureByElement[elementIndex] = initialPorePressure;
    if (elementIndex % 250 === 0 && (await runCheckpoint(runControl))) {
      throw new Error('Deformation run was interrupted during stiffness assembly.');
    }
  }

  onProgress({
    stage: 'solving',
    percent: 58,
    message: 'Applying the surface traction and support constraints...'
  });

  loadedTerrainEdges(mesh, load).forEach((edge) => {
    addVectorBlock(loadRhs, [2 * edge.n1, 2 * edge.n1 + 1, 2 * edge.n2, 2 * edge.n2 + 1], edgeTractionVector(edge, 0, -load.q));
  });

  const fixedValues = buildFixedDofMap(mesh);
  const freeDofs = [];
  const freeIndexByDof = new Map();
  for (let dof = 0; dof < ndof; dof += 1) {
    if (fixedValues.has(dof)) continue;
    freeIndexByDof.set(dof, freeDofs.length);
    freeDofs.push(dof);
  }
  const compressedRows = compressMatrixRows(rows, freeDofs, freeIndexByDof);
  const gravityCompressedRhs = gatherFreeVector(gravityRhs, freeDofs);
  const loadRhsFreeBase = gatherFreeVector(loadRhs, freeDofs);
  const nonlinearAssemblyPattern = buildCompressedAssemblyPattern(elementCaches, freeIndexByDof, freeDofs.length);
  const geostatic = await buildGeostaticInitialization(
    mesh,
    elementCaches,
    model,
    options,
    warnings,
    regionConstitutiveByRegion,
    ndof,
    compressedRows,
    freeDofs,
    fixedValues,
    gravityCompressedRhs,
    porePressureByElement,
    runControl,
    onProgress
  );

  onProgress({
    stage: 'solving',
    percent: 74,
    message: `Solving ${freeDofs.length.toLocaleString()} free deformation DOFs with the ${options.constitutiveModel === 'linear-elastic' ? 'elastic' : options.constitutiveModel === 'mc-plastic' ? 'Stage 2 elastoplastic' : 'Stage 1 MC-active reduced-stiffness'} material model...`
  });

  const materialPoints = buildElementMaterialPoints(mesh, regionConstitutiveByRegion, geostatic.initialField, options, warnings);
  const nonlinear = await solveNonlinearStage1(
    elementCaches,
    nonlinearAssemblyPattern,
    loadRhsFreeBase,
    materialPoints,
    ndof,
    freeDofs,
    fixedValues,
    runControl,
    onProgress,
    options
  );
  if (!nonlinear.converged) {
    const shownLoadFactor = 100 * Math.max(Number(nonlinear.displayedLoadFactor) || 0, 0);
    const stableLoadFactor = 100 * Math.max(Number(nonlinear.loadFactorCommitted) || 0, 0);
    const showingNearFailureState = (Number(nonlinear.displayedLoadFactor) || 0) > (Number(nonlinear.loadFactorCommitted) || 0) + 1e-8;
    warnings.push(
      showingNearFailureState
        ? `Showing a non-converged near-failure state at ${shownLoadFactor.toFixed(1)}% load. The last fully converged state reached ${stableLoadFactor.toFixed(1)}%. Reason: ${nonlinear.failureReason || 'nonlinear iterations exhausted'}. Use this result qualitatively.`
        : `The deformation solve did not fully converge beyond ${stableLoadFactor.toFixed(1)}% load. Showing the last fully converged state. Reason: ${nonlinear.failureReason || 'nonlinear iterations exhausted'}.`
    );
  }
  const U = nonlinear.solution;

  onProgress({
    stage: 'post',
    percent: 86,
    message: 'Recovering stresses, settlements, and MC utilization...'
  });

  const elementResults = recoverElementResults(mesh, elementCaches, U, materialPoints, porePressureByElement);
  const nodalDisplacements = mesh.nodes.map((_node, nodeId) => ({
    ux: U[2 * nodeId],
    uy: U[2 * nodeId + 1]
  }));
  const terrainSettlementProfile = buildTerrainSettlementProfile(mesh, nodalDisplacements);
  const summaries = summarizeDeformation(nodalDisplacements, elementResults);

  onProgress({
    stage: 'post',
    percent: 96,
    message: 'Finalizing deformation output...'
  });

  return {
    mesh,
    load,
    warnings,
    nodalDisplacements,
    terrainSettlementProfile,
    elementResults,
    summaries,
    solver: {
      method: options.constitutiveModel === 'linear-elastic'
        ? 'nonlinear-elastic-plane-strain-t3'
        : options.constitutiveModel === 'mc-plastic'
          ? 'stage-2-mc-plastic-plane-strain-t3'
          : 'stage-1-mc-reduced-stiffness-plane-strain-t3',
      constitutiveModel: options.constitutiveModel === 'linear-elastic'
        ? 'linear-elastic-material-point'
        : options.constitutiveModel === 'mc-plastic'
          ? 'mc-plastic-material-point'
          : 'mc-reduced-stiffness-material-point',
      materialPointCount: materialPoints.length,
      initialStressMode: geostatic.mode,
      geostaticIterations: geostatic.iterations,
      geostaticResidualNorm: geostatic.residualNorm,
      linearIterations: nonlinear.totalCgIterations,
      nonlinearIterations: nonlinear.totalNonlinearIterations,
      acceptedLoadSteps: nonlinear.acceptedSteps,
      rejectedLoadSteps: nonlinear.rejectedSteps,
      loadFactorCommitted: nonlinear.loadFactorCommitted,
      displayedLoadFactor: nonlinear.displayedLoadFactor,
      converged: nonlinear.converged,
      convergenceState: nonlinear.convergenceState,
      displayedStateMode: nonlinear.displayedStateMode,
      failureReason: nonlinear.failureReason,
      residualNorm: nonlinear.residualNorm,
      relativeResidualNorm: nonlinear.relativeResidualNorm,
      displacementCorrectionNorm: nonlinear.displacementCorrectionNorm,
      relativeDisplacementCorrectionNorm: nonlinear.relativeDisplacementCorrectionNorm,
      finalActiveMcElements: nonlinear.finalActiveCount,
      peakActiveMcElements: nonlinear.peakActiveCount,
      peakMcEta: nonlinear.peakEta,
      lastStateChanges: nonlinear.lastStateChanges,
      freeDofs: freeDofs.length,
      loadStepHistory: nonlinear.loadStepHistory,
      residualHistory: nonlinear.residualHistory
    },
    timing: {
      totalMs: performance.now() - startedAt
    }
  };
}
