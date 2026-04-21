// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

import { pointInPolygonHalfOpen } from '../soil-regions.js';
import { buildDeformationMesh } from './mesh.js';
import { buildBMatrixT3, edgeTractionVector, elementStiffnessT3, triangleArea } from './element-t3.js';
import { prepareMechanicalMaterial, planeStrainElasticMatrix } from './material.js';
import {
  addStress,
  buildInitialEffectiveStressField,
  mohrCoulombIndicator,
  negateNormalAndShear,
  principalStress2DCompressionPositive
} from './post.js';

const CG_TOL = 1e-5;
const CG_NUMERIC_EPS = 1e-14;
const CG_CHECKPOINT_INTERVAL = 25;
const MAX_CG_ITER = 25000;
const GEOM_EPS = 1e-6;

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

async function solveCg(rows, rhs, initial = null, maxIter = MAX_CG_ITER, tol = CG_TOL, runControl = null) {
  const n = rows.length;
  if (!n) return { solution: new Float64Array(0), converged: true, iterations: 0, residualNorm: 0, interrupted: false };
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
  const bNorm = Math.max(Math.sqrt(dot(rhs, rhs)), 1);

  for (let i = 0; i < n; i += 1) {
    const diag = Math.abs(rows[i].diag) > CG_NUMERIC_EPS ? rows[i].diag : 1;
    z[i] = r[i] / diag;
    p[i] = z[i];
  }

  let rzOld = dot(r, z);
  let residualNorm = Math.sqrt(dot(r, r));
  if (residualNorm / bNorm <= tol) {
    return { solution: x, converged: true, iterations: 0, residualNorm, interrupted: false };
  }
  await runCheckpoint(runControl, true);

  for (let iter = 1; iter <= maxIter; iter += 1) {
    const ap = sparseMatVec(rows, p);
    const denom = dot(p, ap);
    if (!(Math.abs(denom) > CG_NUMERIC_EPS)) {
      return { solution: x, converged: residualNorm / bNorm <= tol, iterations: iter, residualNorm, interrupted: false };
    }
    const alpha = rzOld / denom;
    for (let i = 0; i < n; i += 1) {
      x[i] += alpha * p[i];
      r[i] -= alpha * ap[i];
    }
    residualNorm = Math.sqrt(dot(r, r));
    if (residualNorm / bNorm <= tol) {
      return { solution: x, converged: true, iterations: iter, residualNorm, interrupted: false };
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
      return { solution: x, converged: false, iterations: iter, residualNorm, interrupted: true };
    }
  }

  return { solution: x, converged: false, iterations: maxIter, residualNorm, interrupted: false };
}

function compressRows(rows, freeDofs, freeIndexByDof, fixedValues, fullRhs) {
  const out = freeDofs.map(() => ({ indices: [], values: [], diag: 0 }));
  const rhs = new Float64Array(freeDofs.length);

  freeDofs.forEach((dofId, rowIndex) => {
    rhs[rowIndex] = fullRhs[dofId] || 0;
    rows[dofId].forEach((value, colId) => {
      if (fixedValues.has(colId)) {
        rhs[rowIndex] -= value * fixedValues.get(colId);
        return;
      }
      const colIndex = freeIndexByDof.get(colId);
      if (colIndex == null) return;
      out[rowIndex].indices.push(colIndex);
      out[rowIndex].values.push(value);
      if (colIndex === rowIndex) out[rowIndex].diag = value;
    });
  });

  return { rows: out, rhs };
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
    maxDeltaSigmaYy = Math.max(maxDeltaSigmaYy, Number(item?.effectiveStress?.syy) || 0);
  });
  return {
    maxSettlement,
    maxHorizontalDisplacement,
    maxMcEta,
    maxDeltaSigmaYy
  };
}

function recoverElementResults(mesh, U, materialsByRegion, initialField) {
  const out = [];
  for (let elementIndex = 0; elementIndex < mesh.elements.length; elementIndex += 1) {
    const element = mesh.elements[elementIndex];
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const material = materialsByRegion.get(cell?.regionIndex) || prepareMechanicalMaterial(cell?.material);
    const nodes = element.map((nodeId) => mesh.nodes[nodeId]);
    const ue = gatherElementDisplacements(U, element);
    const area = triangleArea(nodes);
    const B = buildBMatrixT3(nodes);
    const D = planeStrainElasticMatrix(material.Emc, material.nu, [], material.label || material.id || 'Material');
    const strain = multiplyMat3x6Vec6(B, ue);
    const stressIncrement = applyElasticMatrix(D, strain);
    const sigmaIncrementGeo = negateNormalAndShear(stressIncrement);
    const sigmaEff = addStress(initialField[elementIndex], sigmaIncrementGeo);
    const principal = principalStress2DCompressionPositive(sigmaEff);
    const mc = mohrCoulombIndicator(principal, material);
    out.push({
      elementIndex,
      regionIndex: cell?.regionIndex ?? -1,
      area,
      centroid: mesh.elementData[elementIndex]?.centroid || cell?.centroid || { x: 0, y: 0 },
      strain,
      stressIncrement,
      effectiveStress: sigmaEff,
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
        settlement: -uy,
        deltaSigmaYy: -Number(result.elementResults?.[triangleIndex]?.stressIncrement?.syy || 0),
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
  const rhs = new Float64Array(ndof);
  const materialsByRegion = prepareRegionMaterials(mesh, warnings);

  onProgress({
    stage: 'solving',
    percent: 46,
    message: 'Assembling the plane-strain stiffness matrix...'
  });

  for (let elementIndex = 0; elementIndex < mesh.elements.length; elementIndex += 1) {
    const element = mesh.elements[elementIndex];
    const nodes = element.map((nodeId) => mesh.nodes[nodeId]);
    const cell = mesh.cells[mesh.elementCell[elementIndex]];
    const material = materialsByRegion.get(cell?.regionIndex) || prepareMechanicalMaterial(cell?.material, warnings);
    const dofs = [2 * element[0], 2 * element[0] + 1, 2 * element[1], 2 * element[1] + 1, 2 * element[2], 2 * element[2] + 1];
    addMatrixBlock(rows, dofs, elementStiffnessT3(nodes, material, warnings));
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
    addVectorBlock(rhs, [2 * edge.n1, 2 * edge.n1 + 1, 2 * edge.n2, 2 * edge.n2 + 1], edgeTractionVector(edge, 0, -load.q));
  });

  const fixedValues = buildFixedDofMap(mesh);
  const freeDofs = [];
  const freeIndexByDof = new Map();
  for (let dof = 0; dof < ndof; dof += 1) {
    if (fixedValues.has(dof)) continue;
    freeIndexByDof.set(dof, freeDofs.length);
    freeDofs.push(dof);
  }
  const compressed = compressRows(rows, freeDofs, freeIndexByDof, fixedValues, rhs);

  onProgress({
    stage: 'solving',
    percent: 66,
    message: `Solving ${freeDofs.length.toLocaleString()} free deformation DOFs with conjugate gradients...`
  });

  const cg = await solveCg(compressed.rows, compressed.rhs, null, MAX_CG_ITER, CG_TOL, runControl);
  if (cg.interrupted) {
    throw new Error('Deformation run was interrupted before the first displacement solution became available.');
  }
  if (!cg.converged) {
    throw new Error(`Deformation linear solve did not converge (residual ${cg.residualNorm.toExponential(2)} after ${cg.iterations} iterations).`);
  }

  const U = new Float64Array(ndof);
  fixedValues.forEach((value, dof) => {
    U[dof] = value;
  });
  freeDofs.forEach((dof, index) => {
    U[dof] = cg.solution[index];
  });

  onProgress({
    stage: 'post',
    percent: 82,
    message: 'Recovering stresses, settlements, and MC utilization...'
  });

  const initialField = buildInitialEffectiveStressField(mesh, model, options, warnings);
  const elementResults = recoverElementResults(mesh, U, materialsByRegion, initialField);
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
      linearIterations: cg.iterations,
      residualNorm: cg.residualNorm,
      freeDofs: freeDofs.length
    },
    timing: {
      totalMs: performance.now() - startedAt
    }
  };
}
