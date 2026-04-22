// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { pointInPolygonHalfOpen } from '../soil-regions.js';
import { buildDeformationMesh } from './mesh.js';
import { buildBMatrixT3, edgeTractionVector, elementGravityVectorT3, elementStiffnessT3, triangleArea } from './element-t3.js';
import { prepareMechanicalMaterial, planeStrainElasticMatrix } from './material.js';
import {
  addStress,
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
const GEOM_EPS = 1e-6;

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

function prepareRegionMaterials(mesh, warnings) {
  const byRegion = new Map();
  mesh.cells.forEach((cell) => {
    if (cell?.regionIndex == null || cell.regionIndex < 0 || byRegion.has(cell.regionIndex)) return;
    byRegion.set(cell.regionIndex, prepareMechanicalMaterial(cell.material, warnings));
  });
  return byRegion;
}

function elementDofMap(element) {
  return [2 * element[0], 2 * element[0] + 1, 2 * element[1], 2 * element[1] + 1, 2 * element[2], 2 * element[2] + 1];
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

function gatherElementDisplacements(U, element) {
  const out = new Float64Array(6);
  for (let i = 0; i < 3; i += 1) {
    out[2 * i] = U[2 * element[i]];
    out[2 * i + 1] = U[2 * element[i] + 1];
  }
  return out;
}

function multiplyMat3x6Vec6(matrix, vector) {
  return {
    exx: matrix[0][0] * vector[0] + matrix[0][1] * vector[1] + matrix[0][2] * vector[2] + matrix[0][3] * vector[3] + matrix[0][4] * vector[4] + matrix[0][5] * vector[5],
    eyy: matrix[1][0] * vector[0] + matrix[1][1] * vector[1] + matrix[1][2] * vector[2] + matrix[1][3] * vector[3] + matrix[1][4] * vector[4] + matrix[1][5] * vector[5],
    gxy: matrix[2][0] * vector[0] + matrix[2][1] * vector[1] + matrix[2][2] * vector[2] + matrix[2][3] * vector[3] + matrix[2][4] * vector[4] + matrix[2][5] * vector[5]
  };
}

function applyElasticMatrix(D, strain) {
  return {
    sxx: D[0][0] * strain.exx + D[0][1] * strain.eyy + D[0][2] * strain.gxy,
    syy: D[1][0] * strain.exx + D[1][1] * strain.eyy + D[1][2] * strain.gxy,
    txy: D[2][0] * strain.exx + D[2][1] * strain.eyy + D[2][2] * strain.gxy
  };
}

function recoverElementElasticResponse(mesh, elementIndex, U, material) {
  const element = mesh.elements[elementIndex];
  const nodes = element.map((nodeId) => mesh.nodes[nodeId]);
  const ue = gatherElementDisplacements(U, element);
  const area = triangleArea(nodes);
  const B = buildBMatrixT3(nodes);
  const D = planeStrainElasticMatrix(material.Emc, material.nu, [], material.label || material.id || 'Material');
  const strain = multiplyMat3x6Vec6(B, ue);
  const stressIncrement = applyElasticMatrix(D, strain);
  return {
    element,
    nodes,
    ue,
    area,
    B,
    D,
    strain,
    stressIncrement
  };
}

function recoverInitialFieldFromGeostaticSolution(mesh, Ugeo, materialsByRegion, porePressureByElement) {
  const out = [];
  for (let elementIndex = 0; elementIndex < mesh.elements.length; elementIndex += 1) {
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const material = materialsByRegion.get(cell?.regionIndex) || prepareMechanicalMaterial(cell?.material);
    const elastic = recoverElementElasticResponse(mesh, elementIndex, Ugeo, material);
    const sigmaTotal0 = negateNormalAndShear(elastic.stressIncrement);
    const u0 = Math.max(Number(porePressureByElement?.[elementIndex]) || 0, 0);
    out.push({
      sxx: sigmaTotal0.sxx - u0,
      syy: sigmaTotal0.syy - u0,
      txy: sigmaTotal0.txy
    });
  }
  return out;
}

async function buildGeostaticInitialization(
  mesh,
  model,
  options,
  warnings,
  materialsByRegion,
  ndof,
  rows,
  compressedRows,
  freeDofs,
  fixedValues,
  gravityRhs,
  porePressureByElement,
  runControl,
  onProgress
) {
  onProgress({
    stage: 'solving',
    percent: 64,
    message: 'Solving the geostatic gravity step for the initial stress field...'
  });

  const gravityCompressedRhs = compressRhs(rows, freeDofs, fixedValues, gravityRhs);
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
  const initialField = recoverInitialFieldFromGeostaticSolution(mesh, Ugeo, materialsByRegion, porePressureByElement);
  const hasInvalidStress = initialField.some((stress) => !Number.isFinite(stress?.sxx) || !Number.isFinite(stress?.syy) || !Number.isFinite(stress?.txy));
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
    mode: 'gravity-step',
    iterations: geostaticCg.iterations,
    residualNorm: geostaticCg.residualNorm
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
  nodalDisplacements.forEach((item) => {
    maxSettlement = Math.max(maxSettlement, -(item?.uy || 0));
    maxHorizontalDisplacement = Math.max(maxHorizontalDisplacement, Math.abs(item?.ux || 0));
  });
  let maxMcEta = 0;
  let maxDeltaSigmaYy = 0;
  elementResults.forEach((item) => {
    maxMcEta = Math.max(maxMcEta, Number(item?.mc?.eta) || 0);
    maxDeltaSigmaYy = Math.max(maxDeltaSigmaYy, -Number(item?.stressIncrement?.syy || 0));
  });
  return {
    maxSettlement,
    maxHorizontalDisplacement,
    maxMcEta,
    maxDeltaSigmaYy
  };
}

function recoverElementResults(mesh, U, materialsByRegion, initialField, porePressureByElement = null) {
  const out = [];
  for (let elementIndex = 0; elementIndex < mesh.elements.length; elementIndex += 1) {
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const material = materialsByRegion.get(cell?.regionIndex) || prepareMechanicalMaterial(cell?.material);
    const elastic = recoverElementElasticResponse(mesh, elementIndex, U, material);
    const initialStress = initialField[elementIndex];
    const stressIncrement = elastic.stressIncrement;
    const sigmaIncrementGeo = negateNormalAndShear(stressIncrement);
    const sigmaEff = addStress(initialStress, sigmaIncrementGeo);
    const porePressure = Math.max(Number(porePressureByElement?.[elementIndex]) || 0, 0);
    const initialTotalStress = {
      sxx: (Number(initialStress?.sxx) || 0) + porePressure,
      syy: (Number(initialStress?.syy) || 0) + porePressure,
      txy: Number(initialStress?.txy) || 0
    };
    const totalStress = {
      sxx: (Number(sigmaEff?.sxx) || 0) + porePressure,
      syy: (Number(sigmaEff?.syy) || 0) + porePressure,
      txy: Number(sigmaEff?.txy) || 0
    };
    const principal = principalStress2DCompressionPositive(sigmaEff);
    const mc = mohrCoulombIndicator(principal, material);
    out.push({
      elementIndex,
      regionIndex: cell?.regionIndex ?? -1,
      area: elastic.area,
      centroid: mesh.elementData[elementIndex]?.centroid || cell?.centroid || { x: 0, y: 0 },
      strain: elastic.strain,
      stressIncrement,
      stressIncrementGeo: sigmaIncrementGeo,
      porePressure,
      initialEffectiveStress: initialStress,
      initialTotalStress,
      effectiveStress: sigmaEff,
      totalStress,
      principal,
      mc
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
  const options = {
    meshTargetArea: Math.max(Number(input?.options?.meshTargetArea) || 0.05, 0.01),
    loadMode: input?.options?.loadMode === 'total' ? 'total' : 'pressure',
    totalLoad: input?.options?.totalLoad,
    outOfPlaneLength: Math.max(Number(input?.options?.outOfPlaneLength) || 10, 0.1),
    useSeepagePorePressures: input?.options?.useSeepagePorePressures === true
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
  const rows = Array.from({ length: ndof }, () => new Map());
  const loadRhs = new Float64Array(ndof);
  const gravityRhs = new Float64Array(ndof);
  const porePressureByElement = new Float64Array(mesh.elements.length);
  const materialsByRegion = prepareRegionMaterials(mesh, warnings);

  onProgress({
    stage: 'solving',
    percent: 46,
    message: 'Assembling the plane-strain stiffness matrix and geostatic gravity load...'
  });

  for (let elementIndex = 0; elementIndex < mesh.elements.length; elementIndex += 1) {
    const element = mesh.elements[elementIndex];
    const nodes = element.map((nodeId) => mesh.nodes[nodeId]);
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const material = materialsByRegion.get(cell?.regionIndex) || prepareMechanicalMaterial(cell?.material, warnings);
    const dofs = elementDofMap(element);
    const centroid = mesh.elementData[elementIndex]?.centroid || cell?.centroid || {
      x: (nodes[0].x + nodes[1].x + nodes[2].x) / 3,
      y: (nodes[0].y + nodes[1].y + nodes[2].y) / 3
    };
    const initialPorePressure = sampleInitialPorePressure(model, centroid.x, centroid.y, options, warnings);
    const gammaBulk = initialBulkUnitWeightFromPorePressure(material, initialPorePressure);
    addMatrixBlock(rows, dofs, elementStiffnessT3(nodes, material, warnings));
    addVectorBlock(gravityRhs, dofs, elementGravityVectorT3(nodes, gammaBulk));
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
  const geostatic = await buildGeostaticInitialization(
    mesh,
    model,
    options,
    warnings,
    materialsByRegion,
    ndof,
    rows,
    compressedRows,
    freeDofs,
    fixedValues,
    gravityRhs,
    porePressureByElement,
    runControl,
    onProgress
  );

  onProgress({
    stage: 'solving',
    percent: 74,
    message: `Solving ${freeDofs.length.toLocaleString()} free deformation DOFs for the applied load increment...`
  });

  const compressedLoadRhs = compressRhs(rows, freeDofs, fixedValues, loadRhs);
  const cg = await solveCg(compressedRows, compressedLoadRhs, null, MAX_CG_ITER, CG_REL_TOL, CG_ABS_TOL, runControl);
  if (cg.interrupted) {
    throw new Error('Deformation run was interrupted before the first displacement solution became available.');
  }
  if (!cg.converged) {
    throw new Error(
      `Deformation linear solve did not converge (residual ${cg.residualNorm.toExponential(2)}, relative ${Number.isFinite(cg.relativeResidual) ? cg.relativeResidual.toExponential(2) : 'inf'}, target ${cg.toleranceTarget.toExponential(2)} after ${cg.iterations} iterations).`
    );
  }

  const U = expandSolutionVector(ndof, freeDofs, fixedValues, cg.solution);

  onProgress({
    stage: 'post',
    percent: 86,
    message: 'Recovering stresses, settlements, and MC utilization...'
  });

  const elementResults = recoverElementResults(mesh, U, materialsByRegion, geostatic.initialField, porePressureByElement);
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
      method: 'linear-elastic-plane-strain-t3',
      initialStressMode: geostatic.mode,
      geostaticIterations: geostatic.iterations,
      geostaticResidualNorm: geostatic.residualNorm,
      linearIterations: cg.iterations,
      residualNorm: cg.residualNorm,
      relativeResidualNorm: cg.relativeResidual,
      rhsNorm: cg.rhsNorm,
      toleranceTarget: cg.toleranceTarget,
      freeDofs: freeDofs.length
    },
    timing: {
      totalMs: performance.now() - startedAt
    }
  };
}
