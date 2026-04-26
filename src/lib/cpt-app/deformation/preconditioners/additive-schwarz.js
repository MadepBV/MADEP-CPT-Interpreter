// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

const LU_PIVOT_TOL = 1e-14;

function denseLuFactorize(matrix, tolerance = LU_PIVOT_TOL) {
  const n = matrix.length;
  const lu = matrix.map((row) => Float64Array.from(row));
  const pivots = Array.from({ length: n }, (_item, index) => index);

  for (let k = 0; k < n; k += 1) {
    let pivotRow = k;
    let pivotAbs = Math.abs(Number(lu[k]?.[k]) || 0);
    for (let row = k + 1; row < n; row += 1) {
      const candidate = Math.abs(Number(lu[row]?.[k]) || 0);
      if (candidate > pivotAbs) {
        pivotAbs = candidate;
        pivotRow = row;
      }
    }
    if (!(pivotAbs > tolerance) || !Number.isFinite(pivotAbs)) return null;
    if (pivotRow !== k) {
      [lu[k], lu[pivotRow]] = [lu[pivotRow], lu[k]];
      [pivots[k], pivots[pivotRow]] = [pivots[pivotRow], pivots[k]];
    }
    const pivot = lu[k][k];
    for (let row = k + 1; row < n; row += 1) {
      const factor = lu[row][k] / pivot;
      lu[row][k] = factor;
      for (let col = k + 1; col < n; col += 1) {
        lu[row][col] -= factor * lu[k][col];
      }
    }
  }

  return { lu, pivots };
}

function denseLuSolve(factors, rhs) {
  const n = factors?.lu?.length || 0;
  if (!n || !rhs || rhs.length !== n) return null;
  const x = new Float64Array(n);
  for (let row = 0; row < n; row += 1) x[row] = Number(rhs[factors.pivots[row]]) || 0;

  for (let row = 0; row < n; row += 1) {
    let sum = x[row];
    for (let col = 0; col < row; col += 1) sum -= factors.lu[row][col] * x[col];
    x[row] = sum;
  }
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = x[row];
    for (let col = row + 1; col < n; col += 1) sum -= factors.lu[row][col] * x[col];
    const diagonal = factors.lu[row][row];
    if (!(Math.abs(diagonal) > LU_PIVOT_TOL) || !Number.isFinite(diagonal)) return null;
    x[row] = sum / diagonal;
  }
  return x;
}

function rowValue(row, colIndex) {
  if (!row) return 0;
  for (let index = 0; index < row.indices.length; index += 1) {
    if (row.indices[index] === colIndex) return Number(row.values[index]) || 0;
  }
  return 0;
}

function buildFreeDofIndex(freeDofs) {
  const map = new Map();
  if (!Array.isArray(freeDofs) && !ArrayBuffer.isView(freeDofs)) return map;
  for (let rowIndex = 0; rowIndex < freeDofs.length; rowIndex += 1) {
    map.set(Number(freeDofs[rowIndex]), rowIndex);
  }
  return map;
}

function collectPatchRows(centerNodeIndex, nodeToElements, elementCaches, freeIndexByDof, overlap = 1) {
  const elementQueue = [];
  const elementVisited = new Set();
  const rows = new Set();
  const seedElements = nodeToElements.get(centerNodeIndex) || [];
  seedElements.forEach((elementIndex) => {
    elementQueue.push({ elementIndex, depth: 0 });
    elementVisited.add(elementIndex);
  });

  while (elementQueue.length) {
    const { elementIndex, depth } = elementQueue.shift();
    const elementCache = elementCaches[elementIndex];
    if (!elementCache) continue;
    (elementCache.dofs || []).forEach((globalDof) => {
      const rowIndex = freeIndexByDof.get(Number(globalDof));
      if (rowIndex != null) rows.add(rowIndex);
    });
    if (depth >= overlap) continue;
    const elementNodes = new Set((elementCache.dofs || []).map((dof) => Math.floor(Number(dof) / 2)));
    elementNodes.forEach((nodeIndex) => {
      (nodeToElements.get(nodeIndex) || []).forEach((nextElementIndex) => {
        if (elementVisited.has(nextElementIndex)) return;
        elementVisited.add(nextElementIndex);
        elementQueue.push({ elementIndex: nextElementIndex, depth: depth + 1 });
      });
    });
  }

  return Array.from(rows).sort((a, b) => a - b);
}

function extractDensePatchMatrix(rows, localRows, diagonalShift = 0) {
  const localIndex = new Map();
  localRows.forEach((row, index) => localIndex.set(row, index));
  const n = localRows.length;
  const matrix = Array.from({ length: n }, () => new Float64Array(n));
  for (let localRowIndex = 0; localRowIndex < n; localRowIndex += 1) {
    const globalRowIndex = localRows[localRowIndex];
    const row = rows[globalRowIndex];
    for (let entryIndex = 0; entryIndex < row.indices.length; entryIndex += 1) {
      const localColIndex = localIndex.get(row.indices[entryIndex]);
      if (localColIndex == null) continue;
      matrix[localRowIndex][localColIndex] = Number(row.values[entryIndex]) || 0;
    }
    matrix[localRowIndex][localRowIndex] += diagonalShift;
  }
  return matrix;
}

function buildNodeToElements(elementCaches) {
  const nodeToElements = new Map();
  (elementCaches || []).forEach((elementCache, elementIndex) => {
    const nodes = new Set((elementCache.dofs || []).map((dof) => Math.floor(Number(dof) / 2)));
    nodes.forEach((nodeIndex) => {
      if (!nodeToElements.has(nodeIndex)) nodeToElements.set(nodeIndex, []);
      nodeToElements.get(nodeIndex).push(elementIndex);
    });
  });
  return nodeToElements;
}

export function buildAdditiveSchwarzPreconditioner(rows, freeDofs, elementCaches, options = {}) {
  const n = rows?.length || 0;
  const minFreeDofs = Math.max(Math.round(Number(options?.schwarzMinFreeDofs) || 800), 0);
  if (!n || n < minFreeDofs || !Array.isArray(elementCaches) || !elementCaches.length) return null;

  const freeIndexByDof = buildFreeDofIndex(freeDofs);
  if (!freeIndexByDof.size) return null;
  const nodeToElements = buildNodeToElements(elementCaches);
  const overlap = Math.max(Math.round(Number(options?.schwarzOverlap) || 1), 0);
  const maxPatchSize = Math.max(Math.round(Number(options?.schwarzMaxPatchDofs) || 48), 4);
  const diagonalShiftScale = Math.max(Number(options?.schwarzDiagonalShiftScale) || 1e-10, 0);
  const patches = [];
  const scratchBySize = new Map();

  nodeToElements.forEach((_elementIndices, nodeIndex) => {
    const localRows = collectPatchRows(nodeIndex, nodeToElements, elementCaches, freeIndexByDof, overlap);
    if (localRows.length < 2 || localRows.length > maxPatchSize) return;
    let maxDiag = 0;
    localRows.forEach((rowIndex) => {
      maxDiag = Math.max(maxDiag, Math.abs(rowValue(rows[rowIndex], rowIndex)));
    });
    const diagonalShift = diagonalShiftScale * Math.max(maxDiag, 1);
    const matrix = extractDensePatchMatrix(rows, localRows, diagonalShift);
    const factors = denseLuFactorize(matrix);
    if (!factors) return;
    patches.push({ localRows, factors });
    if (!scratchBySize.has(localRows.length)) {
      scratchBySize.set(localRows.length, {
        rhs: new Float64Array(localRows.length)
      });
    }
  });

  if (!patches.length) return null;
  return {
    kind: 'additive-schwarz',
    patches,
    damping: Math.min(Math.max(Number(options?.schwarzDamping) || 0.65, 0.05), 1),
    scratchBySize
  };
}

export function applyAdditiveSchwarzPreconditioner(precond, r, z) {
  if (!precond?.patches?.length) return false;
  z.fill(0);
  for (const patch of precond.patches) {
    const n = patch.localRows.length;
    let scratch = precond.scratchBySize?.get(n);
    if (!scratch) {
      scratch = { rhs: new Float64Array(n) };
      precond.scratchBySize?.set?.(n, scratch);
    }
    for (let localIndex = 0; localIndex < n; localIndex += 1) {
      scratch.rhs[localIndex] = Number(r[patch.localRows[localIndex]]) || 0;
    }
    const localSolution = denseLuSolve(patch.factors, scratch.rhs);
    if (!localSolution) continue;
    for (let localIndex = 0; localIndex < n; localIndex += 1) {
      z[patch.localRows[localIndex]] += precond.damping * localSolution[localIndex];
    }
  }
  return true;
}
