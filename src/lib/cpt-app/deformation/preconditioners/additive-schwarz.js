// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

const LU_PIVOT_TOL = 1e-14;

function matrixMaxAbsEntry(matrix) {
  let maxValue = 0;
  for (let row = 0; row < (matrix?.length || 0); row += 1) {
    for (let col = 0; col < (matrix?.[row]?.length || 0); col += 1) {
      maxValue = Math.max(maxValue, Math.abs(Number(matrix[row][col]) || 0));
    }
  }
  return maxValue;
}

function relativePivotTolerance(matrix, relative = 1e-12, absolute = LU_PIVOT_TOL) {
  return Math.max(Number(absolute) || 0, Math.max(Number(relative) || 0, 0) * matrixMaxAbsEntry(matrix));
}

function symmetrizeInPlace(matrix) {
  const n = matrix?.length || 0;
  for (let row = 0; row < n; row += 1) {
    for (let col = row + 1; col < n; col += 1) {
      const value = 0.5 * ((Number(matrix[row][col]) || 0) + (Number(matrix[col][row]) || 0));
      matrix[row][col] = value;
      matrix[col][row] = value;
    }
  }
  return matrix;
}

function patchDiagonalAverage(matrix) {
  const n = matrix?.length || 0;
  if (!n) return 0;
  let sum = 0;
  for (let row = 0; row < n; row += 1) sum += Math.abs(Number(matrix[row]?.[row]) || 0);
  return sum / n;
}

function addDiagonalShift(matrix, shift) {
  const value = Number(shift) || 0;
  if (!value) return matrix;
  for (let row = 0; row < (matrix?.length || 0); row += 1) {
    matrix[row][row] += value;
  }
  return matrix;
}

function denseLdltFactorize(matrix, tolerance = relativePivotTolerance(matrix)) {
  const n = matrix?.length || 0;
  if (!n) return null;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  const D = new Float64Array(n);
  for (let row = 0; row < n; row += 1) L[row][row] = 1;

  for (let k = 0; k < n; k += 1) {
    let diagonal = Number(matrix[k]?.[k]) || 0;
    for (let j = 0; j < k; j += 1) diagonal -= L[k][j] * L[k][j] * D[j];
    if (!(diagonal > tolerance) || !Number.isFinite(diagonal)) return null;
    D[k] = diagonal;
    for (let i = k + 1; i < n; i += 1) {
      let value = Number(matrix[i]?.[k]) || 0;
      for (let j = 0; j < k; j += 1) value -= L[i][j] * L[k][j] * D[j];
      L[i][k] = value / diagonal;
      if (!Number.isFinite(L[i][k])) return null;
    }
  }

  return { kind: 'ldlt', L, D, tolerance };
}

function denseLdltSolve(factors, rhs) {
  const n = factors?.D?.length || 0;
  if (!n || !rhs || rhs.length !== n) return null;
  const y = new Float64Array(n);
  for (let row = 0; row < n; row += 1) {
    let sum = Number(rhs[row]) || 0;
    for (let col = 0; col < row; col += 1) sum -= factors.L[row][col] * y[col];
    y[row] = sum;
  }
  const w = new Float64Array(n);
  for (let row = 0; row < n; row += 1) {
    const diagonal = factors.D[row];
    if (!(diagonal > factors.tolerance) || !Number.isFinite(diagonal)) return null;
    w[row] = y[row] / diagonal;
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = w[row];
    for (let col = row + 1; col < n; col += 1) sum -= factors.L[col][row] * x[col];
    x[row] = sum;
  }
  return x;
}

function denseLuFactorize(matrix, tolerance = relativePivotTolerance(matrix)) {
  const n = matrix.length;
  const lu = matrix.map((row) => Float64Array.from(row));
  const rowPerm = Array.from({ length: n }, (_item, index) => index);
  const colPerm = Array.from({ length: n }, (_item, index) => index);

  for (let k = 0; k < n; k += 1) {
    let pivotRow = k;
    let pivotCol = k;
    let pivotAbs = 0;
    for (let row = k; row < n; row += 1) {
      for (let col = k; col < n; col += 1) {
        const candidate = Math.abs(Number(lu[row]?.[col]) || 0);
        if (candidate > pivotAbs) {
          pivotAbs = candidate;
          pivotRow = row;
          pivotCol = col;
        }
      }
    }
    if (!(pivotAbs > tolerance) || !Number.isFinite(pivotAbs)) return null;
    if (pivotRow !== k) {
      [lu[k], lu[pivotRow]] = [lu[pivotRow], lu[k]];
      [rowPerm[k], rowPerm[pivotRow]] = [rowPerm[pivotRow], rowPerm[k]];
    }
    if (pivotCol !== k) {
      for (let row = 0; row < n; row += 1) {
        [lu[row][k], lu[row][pivotCol]] = [lu[row][pivotCol], lu[row][k]];
      }
      [colPerm[k], colPerm[pivotCol]] = [colPerm[pivotCol], colPerm[k]];
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

  return { kind: 'lu-complete-pivot', lu, rowPerm, colPerm, tolerance };
}

function denseLuSolve(factors, rhs) {
  const n = factors?.lu?.length || 0;
  if (!n || !rhs || rhs.length !== n) return null;
  const y = new Float64Array(n);
  for (let row = 0; row < n; row += 1) y[row] = Number(rhs[factors.rowPerm?.[row]]) || 0;

  for (let row = 0; row < n; row += 1) {
    let sum = y[row];
    for (let col = 0; col < row; col += 1) sum -= factors.lu[row][col] * y[col];
    y[row] = sum;
  }
  const permutedSolution = new Float64Array(n);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = y[row];
    for (let col = row + 1; col < n; col += 1) sum -= factors.lu[row][col] * permutedSolution[col];
    const diagonal = factors.lu[row][row];
    if (!(Math.abs(diagonal) > factors.tolerance) || !Number.isFinite(diagonal)) return null;
    permutedSolution[row] = sum / diagonal;
  }
  const x = new Float64Array(n);
  for (let row = 0; row < n; row += 1) x[factors.colPerm?.[row] ?? row] = permutedSolution[row];
  return x;
}

function solveDenseFactors(factors, rhs) {
  if (factors?.kind === 'ldlt') return denseLdltSolve(factors, rhs);
  return denseLuSolve(factors, rhs);
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
  // BFS over elements within `overlap` element-hops from the center
  // node. We use a head-index queue (not `Array.shift`, which is O(n)
  // per call and turns the BFS into O(n²) on dense meshes) so the
  // setup cost stays linear in patch size.
  const elementQueue = [];
  let queueHead = 0;
  const elementVisited = new Set();
  const rows = new Set();
  const seedElements = nodeToElements.get(centerNodeIndex) || [];
  for (const elementIndex of seedElements) {
    elementQueue.push({ elementIndex, depth: 0 });
    elementVisited.add(elementIndex);
  }

  while (queueHead < elementQueue.length) {
    const { elementIndex, depth } = elementQueue[queueHead];
    queueHead += 1;
    const elementCache = elementCaches[elementIndex];
    if (!elementCache) continue;
    const dofs = elementCache.dofs || [];
    for (let dofIdx = 0; dofIdx < dofs.length; dofIdx += 1) {
      const rowIndex = freeIndexByDof.get(Number(dofs[dofIdx]));
      if (rowIndex != null) rows.add(rowIndex);
    }
    if (depth >= overlap) continue;
    const seenNodes = new Set();
    for (let dofIdx = 0; dofIdx < dofs.length; dofIdx += 1) {
      const nodeIndex = Math.floor(Number(dofs[dofIdx]) / 2);
      if (seenNodes.has(nodeIndex)) continue;
      seenNodes.add(nodeIndex);
      const adjacentElements = nodeToElements.get(nodeIndex) || [];
      for (let adjIdx = 0; adjIdx < adjacentElements.length; adjIdx += 1) {
        const nextElementIndex = adjacentElements[adjIdx];
        if (elementVisited.has(nextElementIndex)) continue;
        elementVisited.add(nextElementIndex);
        elementQueue.push({ elementIndex: nextElementIndex, depth: depth + 1 });
      }
    }
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

// Resolve a numeric option with `0` accepted as a meaningful value.
// `Number(0) || fallback` evaluates to `fallback` (because 0 is
// falsy), which silently overwrites the caller's explicit "no
// threshold" or "no overlap". Use this helper for every numeric
// option whose semantically valid range includes zero.
function pickNumberOption(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function buildAdditiveSchwarzPreconditioner(rows, freeDofs, elementCaches, options = {}) {
  const n = rows?.length || 0;
  const minFreeDofs = Math.max(Math.round(pickNumberOption(options?.schwarzMinFreeDofs, 800)), 0);
  if (!n || n < minFreeDofs || !Array.isArray(elementCaches) || !elementCaches.length) return null;

  const freeIndexByDof = buildFreeDofIndex(freeDofs);
  if (!freeIndexByDof.size) return null;
  const nodeToElements = buildNodeToElements(elementCaches);
  const overlap = Math.max(Math.round(pickNumberOption(options?.schwarzOverlap, 1)), 0);
  const maxPatchSize = Math.max(Math.round(pickNumberOption(options?.schwarzMaxPatchDofs, 48)), 4);
  const diagonalShiftScale = Math.max(pickNumberOption(options?.schwarzDiagonalShiftScale, 1e-8), 0);
  const symmetrizePatch = options?.schwarzSymmetrizePatch !== false;
  const patches = [];
  const scratchBySize = new Map();
  let ldltPatchCount = 0;
  let luPatchCount = 0;
  let skippedPatchCount = 0;

  nodeToElements.forEach((_elementIndices, nodeIndex) => {
    const localRows = collectPatchRows(nodeIndex, nodeToElements, elementCaches, freeIndexByDof, overlap);
    if (localRows.length < 2 || localRows.length > maxPatchSize) return;
    const matrix = extractDensePatchMatrix(rows, localRows, 0);
    if (symmetrizePatch) symmetrizeInPlace(matrix);
    const traceAvg = patchDiagonalAverage(matrix);
    const diagonalShift = Math.max(
      diagonalShiftScale * Math.max(traceAvg, 1),
      1e-12 * Math.max(traceAvg, 1)
    );
    addDiagonalShift(matrix, diagonalShift);
    let factors = null;
    if (symmetrizePatch) {
      factors = denseLdltFactorize(matrix);
      if (factors) ldltPatchCount += 1;
    }
    if (!factors) {
      factors = denseLuFactorize(matrix);
      if (factors) luPatchCount += 1;
    }
    if (!factors) {
      skippedPatchCount += 1;
      return;
    }
    patches.push({ localRows, factors, gatherWeights: null, scatterWeights: null });
    if (!scratchBySize.has(localRows.length)) {
      scratchBySize.set(localRows.length, {
        rhs: new Float64Array(localRows.length)
      });
    }
  });

  if (!patches.length) return null;
  const coverage = new Int32Array(n);
  for (const patch of patches) {
    for (const rowIndex of patch.localRows) coverage[rowIndex] += 1;
  }
  const weight = new Float64Array(n);
  let minCovered = Number.POSITIVE_INFINITY;
  let maxCovered = 0;
  let uncoveredCount = 0;
  for (let rowIndex = 0; rowIndex < n; rowIndex += 1) {
    const count = coverage[rowIndex];
    if (count > 0) {
      weight[rowIndex] = 1 / count;
      minCovered = Math.min(minCovered, count);
      maxCovered = Math.max(maxCovered, count);
    } else {
      uncoveredCount += 1;
    }
  }
  for (const patch of patches) {
    patch.gatherWeights = new Float64Array(patch.localRows.length);
    patch.scatterWeights = new Float64Array(patch.localRows.length);
    for (let localIndex = 0; localIndex < patch.localRows.length; localIndex += 1) {
      const symmetricWeight = Math.sqrt(Math.max(weight[patch.localRows[localIndex]], 0));
      patch.gatherWeights[localIndex] = symmetricWeight;
      patch.scatterWeights[localIndex] = symmetricWeight;
    }
  }

  return {
    kind: 'additive-schwarz',
    patches,
    coverage,
    weight,
    diagnostics: {
      patchCount: patches.length,
      ldltPatchCount,
      luPatchCount,
      skippedPatchCount,
      minCoverage: Number.isFinite(minCovered) ? minCovered : 0,
      maxCoverage: maxCovered,
      uncoveredCount,
      diagonalShiftScale,
      symmetrized: symmetrizePatch
    },
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
      scratch.rhs[localIndex] = (Number(patch.gatherWeights?.[localIndex]) || 0) * (Number(r[patch.localRows[localIndex]]) || 0);
    }
    const localSolution = solveDenseFactors(patch.factors, scratch.rhs);
    if (!localSolution) continue;
    for (let localIndex = 0; localIndex < n; localIndex += 1) {
      z[patch.localRows[localIndex]] += (Number(patch.scatterWeights?.[localIndex]) || 0) * localSolution[localIndex];
    }
  }
  return true;
}

export function flattenAdditiveSchwarzPreconditionerForGpu(precond) {
  const patches = Array.isArray(precond?.patches) ? precond.patches : [];
  const n = precond?.coverage?.length || precond?.weight?.length || 0;
  if (!n || !patches.length) return null;

  let totalLocalRows = 0;
  let totalInverseEntries = 0;
  for (const patch of patches) {
    const size = patch?.localRows?.length || 0;
    if (!size || !patch?.factors || !patch?.gatherWeights || !patch?.scatterWeights) return null;
    totalLocalRows += size;
    totalInverseEntries += size * size;
  }

  const patchOffsets = new Int32Array(patches.length + 1);
  const inverseOffsets = new Int32Array(patches.length + 1);
  const localRows = new Int32Array(totalLocalRows);
  const inverseValues = new Float64Array(totalInverseEntries);
  const dofEntries = Array.from({ length: n }, () => []);
  const dofWeights = Array.from({ length: n }, () => []);

  let rowOffset = 0;
  let inverseOffset = 0;
  for (let patchIndex = 0; patchIndex < patches.length; patchIndex += 1) {
    const patch = patches[patchIndex];
    const size = patch.localRows.length;
    patchOffsets[patchIndex] = rowOffset;
    inverseOffsets[patchIndex] = inverseOffset;

    for (let localIndex = 0; localIndex < size; localIndex += 1) {
      const rowIndex = Math.trunc(Number(patch.localRows[localIndex]) || 0);
      if (rowIndex < 0 || rowIndex >= n) return null;
      localRows[rowOffset + localIndex] = rowIndex;
      dofEntries[rowIndex].push(rowOffset + localIndex);
      dofWeights[rowIndex].push(Number(patch.scatterWeights[localIndex]) || 0);
    }

    for (let column = 0; column < size; column += 1) {
      const unit = new Float64Array(size);
      unit[column] = 1;
      const solved = solveDenseFactors(patch.factors, unit);
      if (!solved || solved.length !== size) return null;
      for (let row = 0; row < size; row += 1) {
        const value = Number(solved[row]) * (Number(patch.gatherWeights[column]) || 0);
        if (!Number.isFinite(value)) return null;
        inverseValues[inverseOffset + row * size + column] = value;
      }
    }

    rowOffset += size;
    inverseOffset += size * size;
  }
  patchOffsets[patches.length] = rowOffset;
  inverseOffsets[patches.length] = inverseOffset;

  const dofOffsets = new Int32Array(n + 1);
  let entryCount = 0;
  for (let rowIndex = 0; rowIndex < n; rowIndex += 1) {
    dofOffsets[rowIndex] = entryCount;
    entryCount += dofEntries[rowIndex].length;
  }
  dofOffsets[n] = entryCount;

  const flatDofEntries = new Int32Array(entryCount);
  const flatDofWeights = new Float64Array(entryCount);
  let entryOffset = 0;
  for (let rowIndex = 0; rowIndex < n; rowIndex += 1) {
    for (let local = 0; local < dofEntries[rowIndex].length; local += 1) {
      flatDofEntries[entryOffset] = dofEntries[rowIndex][local];
      flatDofWeights[entryOffset] = dofWeights[rowIndex][local];
      entryOffset += 1;
    }
  }

  return {
    kind: 'gpu-additive-schwarz-pou',
    n,
    patchCount: patches.length,
    totalLocalRows,
    totalInverseEntries,
    patchOffsets,
    localRows,
    inverseOffsets,
    inverseValues,
    dofOffsets,
    dofEntries: flatDofEntries,
    dofWeights: flatDofWeights,
    diagnostics: precond?.diagnostics || null
  };
}
