// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Targeted regression test for the block-Jacobi pair-slot indexing fix.
//
// Builds a synthetic CSR pattern that simulates a mesh with MIXED CONSTRAINTS
// (some nodes with both DOFs free, some with only one DOF free, some fully
// fixed).  Verifies that buildBlockJacobiPackForFreeDofs produces the correct
// 2×2 inverse for each pair slot — i.e., M_n · K[2n..2n+1; 2n..2n+1] ≈ I.
//
// The previous (per-node-indexed) implementation produced a packed array
// that was misaligned with the apply kernel's pair-slot reads on any mesh
// with mixed constraints, breaking CG convergence.
// =============================================================================

import { buildBlockJacobiPackForFreeDofs } from '../src/lib/cpt-app/deformation/gpu/gpu-mesh-pack.js';

const passes = [];
const failures = [];
const check = (label, ok, detail = '') => {
  (ok ? passes : failures).push({ label, detail });
  process.stdout.write(`  [${ok ? 'OK ' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}\n`);
};

// ---------------------------------------------------------------------------
// Build a CSR over `numFree` rows from a list of (row, col, value) triplets.
// Sorts columns ascending per row to match the pack's expectations.
// ---------------------------------------------------------------------------
function buildCsrFromTriplets(numFree, triplets) {
  const rowEntries = Array.from({ length: numFree }, () => []);
  for (const [r, c, v] of triplets) rowEntries[r].push([c, v]);
  for (const row of rowEntries) row.sort((a, b) => a[0] - b[0]);
  let nnz = 0;
  for (const row of rowEntries) nnz += row.length;
  const rowPtr = new Uint32Array(numFree + 1);
  const colInd = new Uint32Array(nnz);
  const valHi  = new Float32Array(nnz);
  const valLo  = new Float32Array(nnz);
  let cursor = 0;
  for (let r = 0; r < numFree; r += 1) {
    rowPtr[r] = cursor;
    for (const [c, v] of rowEntries[r]) {
      colInd[cursor] = c;
      const hi = Math.fround(v);
      valHi[cursor] = hi;
      valLo[cursor] = Math.fround(v - hi);
      cursor += 1;
    }
  }
  rowPtr[numFree] = nnz;
  return { rowPtr, colInd, valHi, valLo };
}

// Verify the pack matches the CPU's block-Jacobi mathematical contract:
// for each pair slot i, the block (A, B, C, D) satisfies:
//   - If freeDofs[2i] and freeDofs[2i+1] are the (x, y) of the same node:
//       M·K = I (true 2×2 nodal block-Jacobi).
//   - Otherwise (cross-node pair, or solitary):
//       A = 1/diag(row0), D = 1/diag(row1), B = C = 0  (scalar Jacobi).
function verifyPackMatchesContract({ packed, freeDofs, csr, label }) {
  const numFree = freeDofs.length;
  const numNodes = Math.ceil(numFree / 2);
  const lookup = (r, c) => {
    if (r < 0 || r >= numFree) return 0;
    const begin = csr.rowPtr[r];
    const end = csr.rowPtr[r + 1];
    for (let k = begin; k < end; k += 1) {
      if (csr.colInd[k] === c) return csr.valHi[k] + csr.valLo[k];
    }
    return 0;
  };
  let maxErr = 0;
  for (let i = 0; i < numNodes; i += 1) {
    const row0 = 2 * i;
    const row1 = 2 * i + 1;
    const r1Valid = row1 < numFree;
    const A = packed[8 * i + 0] + packed[8 * i + 1];
    const B = packed[8 * i + 2] + packed[8 * i + 3];
    const C = packed[8 * i + 4] + packed[8 * i + 5];
    const D = packed[8 * i + 6] + packed[8 * i + 7];
    const dof0 = freeDofs[row0];
    const dof1 = r1Valid ? freeDofs[row1] : -1;
    const isNodalPair = r1Valid && (dof0 % 2 === 0) && (dof1 === dof0 + 1);
    const a = lookup(row0, row0);
    const d = r1Valid ? lookup(row1, row1) : 0;
    if (isNodalPair) {
      // True nodal pair → M·K = I_{2×2}.
      const b = lookup(row0, row1);
      const c = lookup(row1, row0);
      const m00 = A * a + B * c;
      const m01 = A * b + B * d;
      const m10 = C * a + D * c;
      const m11 = C * b + D * d;
      maxErr = Math.max(maxErr, Math.abs(m00 - 1), Math.abs(m11 - 1), Math.abs(m01), Math.abs(m10));
    } else if (r1Valid) {
      // Cross-node pair → independent scalar Jacobi.
      maxErr = Math.max(maxErr, Math.abs(A - 1 / a), Math.abs(D - 1 / d), Math.abs(B), Math.abs(C));
    } else {
      // Solitary slot.
      maxErr = Math.max(maxErr, Math.abs(A - 1 / a), Math.abs(B), Math.abs(C));
    }
  }
  check(`${label}: pack matches CPU contract (nodal-pair → 2×2 inverse; cross-node → scalar)`,
        maxErr < 1e-6, `max err = ${maxErr.toExponential(3)}`);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== Block-Jacobi pair-slot indexing — fully-free mesh ===\n');
{
  // Mesh with 4 nodes, all fully free → freeDofs = [0..7], numFree = 8.
  // K is a tridiagonal-ish SPD matrix.
  const freeDofs = Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const trip = [];
  for (let i = 0; i < 8; i += 1) {
    trip.push([i, i, 10 + i]);    // diagonal
    if (i + 1 < 8) {
      trip.push([i, i + 1, -1]);
      trip.push([i + 1, i, -1]);
    }
  }
  const csr = buildCsrFromTriplets(8, trip);
  const packed = buildBlockJacobiPackForFreeDofs({
    freeDofs, csrRowPtr: csr.rowPtr, csrColInd: csr.colInd, csrValHi: csr.valHi, csrValLo: csr.valLo
  });
  check('packed length is 8 × ceil(numFree/2) = 32', packed.length === 32);
  verifyPackMatchesContract({ packed, freeDofs, csr, label: 'fully-free' });
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== Block-Jacobi pair-slot indexing — mixed-constraint mesh ===\n');
{
  // Hypothetical mesh: 4 geometric nodes total.
  //   node 0: DOF 0 fixed, DOF 1 fixed.
  //   node 1: DOF 2 free, DOF 3 fixed (roller-x).
  //   node 2: DOF 4 free, DOF 5 free (full).
  //   node 3: DOF 6 free, DOF 7 free (full).
  // Free DOFs (in monotonic order): [2, 4, 5, 6, 7].  numFree = 5.
  const freeDofs = Int32Array.from([2, 4, 5, 6, 7]);
  // Build a synthetic SPD CSR — diagonal + a few cross-couplings between
  // free indices that share elements.
  const trip = [
    // Diagonal — all ~10..14, SPD-friendly.
    [0, 0, 10],
    [1, 1, 11],
    [2, 2, 12],
    [3, 3, 13],
    [4, 4, 14],
    // Cross-coupling: node 2's pair (free indices 1, 2).
    [1, 2, -2], [2, 1, -2],
    // Cross-coupling: node 3's pair (free indices 3, 4).
    [3, 4, -3], [4, 3, -3],
    // Cross-element: node 1's free DOF (free index 0) connects to node 2's x (free index 1).
    [0, 1, -1], [1, 0, -1],
    // Cross-element: node 2 connects to node 3 (free indices 1↔3, 2↔4).
    [1, 3, -1], [3, 1, -1],
    [2, 4, -1], [4, 2, -1]
    // Note: free indices 0 (node 1) and 1 (node 2's x) are different nodes,
    // but happen to be paired in slot 0.  The previous per-node packing
    // would put node 1's scalar block at slot 0 (broken).  The new pair-
    // slot packing correctly inverts the actual K[(0,1); (0,1)] sub-block.
  ];
  const csr = buildCsrFromTriplets(5, trip);
  const packed = buildBlockJacobiPackForFreeDofs({
    freeDofs, csrRowPtr: csr.rowPtr, csrColInd: csr.colInd, csrValHi: csr.valHi, csrValLo: csr.valLo
  });
  // numNodes = ceil(5/2) = 3.  packed length = 8 × 3 = 24.
  check('packed length is 8 × ceil(5/2) = 24', packed.length === 24);
  verifyPackMatchesContract({ packed, freeDofs, csr, label: 'mixed-constraint' });
  // Specific case: pair slot 0 spans free indices (0, 1) — DIFFERENT nodes
  // (free index 0 = node 1's x-DOF, free index 1 = node 2's x-DOF).
  // freeDofs[0] = 2 (even — could be x of some node), freeDofs[1] = 4
  // (NOT freeDofs[0] + 1).  Therefore NOT a nodal pair → scalar Jacobi:
  // A = 1/K[0][0] = 1/10,  D = 1/K[1][1] = 1/11,  B = C = 0.
  const A = packed[0] + packed[1];
  const B = packed[2] + packed[3];
  const C = packed[4] + packed[5];
  const D = packed[6] + packed[7];
  check('pair slot 0 (cross-node) is scalar Jacobi: A = 1/10',
        Math.abs(A - 1 / 10) < 1e-6, `A = ${A.toFixed(6)}`);
  check('pair slot 0 (cross-node) is scalar Jacobi: D = 1/11',
        Math.abs(D - 1 / 11) < 1e-6, `D = ${D.toFixed(6)}`);
  check('pair slot 0 (cross-node) B = 0 (no spurious coupling)',
        Math.abs(B) < 1e-12 && Math.abs(C) < 1e-12,
        `B = ${B.toExponential(2)}, C = ${C.toExponential(2)}`);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== Block-Jacobi pair-slot indexing — odd numFree ===\n');
{
  // numFree = 3: pair slots 0 and 1.  Slot 1's row1 is OOB.
  const freeDofs = Int32Array.from([0, 1, 2]);
  const trip = [
    [0, 0, 5],
    [1, 1, 7],
    [2, 2, 11],
    [0, 1, -1], [1, 0, -1]
  ];
  const csr = buildCsrFromTriplets(3, trip);
  const packed = buildBlockJacobiPackForFreeDofs({
    freeDofs, csrRowPtr: csr.rowPtr, csrColInd: csr.colInd, csrValHi: csr.valHi, csrValLo: csr.valLo
  });
  check('packed length is 8 × ceil(3/2) = 16', packed.length === 16);
  // Slot 0: rows (0, 1).  K = [[5, -1], [-1, 7]], det = 34.
  // Slot 1: row 0 valid, row 1 OOB → A = 1/11, D = 1.
  const A1 = packed[8 + 0] + packed[8 + 1];
  const D1 = packed[8 + 6] + packed[8 + 7];
  check('odd numFree: last slot A = 1/11', Math.abs(A1 - 1 / 11) < 1e-6);
  check('odd numFree: last slot D = 1 (identity)', Math.abs(D1 - 1) < 1e-6);
  verifyPackMatchesContract({ packed, freeDofs, csr, label: 'odd-numFree' });
}

// ---------------------------------------------------------------------------
process.stdout.write(`\n=== Summary ===\n`);
process.stdout.write(`  passed: ${passes.length}\n`);
process.stdout.write(`  failed: ${failures.length}\n`);
if (failures.length) {
  process.stdout.write('\nFailures:\n');
  failures.forEach(({ label, detail }) => {
    process.stdout.write(`  - ${label}${detail ? ` (${detail})` : ''}\n`);
  });
  process.exit(1);
}
process.exit(0);
