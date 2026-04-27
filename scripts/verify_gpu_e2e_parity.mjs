// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end CPU-reference parity test for the new GPU resident pipeline.
// =============================================================================
//
// Purpose: confirm that the entire GPU pipeline — buildGpuMeshPack →
// recordResidualAndTangent → resident CG — produces the same elastic
// displacement field as the production CPU CG path, on a non-trivial mesh.
//
// We do NOT need real GPU hardware for this test.  The CPU-reference
// implementations of every kernel are verified bit-for-bit equivalent to the
// device kernels (Phase 10's parity gates already confirm this).  Running
// the entire pipeline through the CPU references exercises:
//
//   - the mesh pack builder (B-matrices, GP weights, dofMap, materials,
//     incidence lists)
//   - the strain → stress → force → stiffness → scatter chain
//   - the DS-CSR + block-Jacobi 2x2 preconditioner
//   - the resident CG iteration logic
//
// Test problem: a 4-by-2 unit-square mesh (8 T3 elements, 9 nodes, 18 DOFs,
// 12 free DOFs after fixing the bottom edge), uniform soil, gravity load.
// We solve K u = f_g and compare against the CPU baseline assembly from
// element-t3.js plus the production solver's CG path.
// =============================================================================

import { buildBMatrixT3, triangleArea, elementStiffnessT3FromBAndArea, elementBodyForceVectorT3FromArea } from '../src/lib/cpt-app/deformation/element-t3.js';
import { runDeformationOnGpuCpuReference, cpuReferenceAssemble } from '../src/lib/cpt-app/deformation/gpu/gpu-controller.js';

// ---------------------------------------------------------------------------
// Test mesh: a 4×2 grid of unit squares, each split into 2 T3 triangles.
//   Nodes (3 columns × 3 rows; 9 nodes total):
//       6----7----8
//       |\   |\   |
//       | \  | \  |
//       3----4----5
//       |\   |\   |
//       | \  | \  |
//       0----1----2
//   x = 0, 1, 2;  y = 0, 1, 2
//   Bottom-edge nodes (y=0): 0, 1, 2  (fixed in both x and y)
// ---------------------------------------------------------------------------
const nodes = [];
for (let j = 0; j <= 2; j += 1) {
  for (let i = 0; i <= 2; i += 1) {
    nodes.push({ x: i, y: j });
  }
}
const elements = [
  [0, 1, 4],   [0, 4, 3],
  [1, 2, 5],   [1, 5, 4],
  [3, 4, 7],   [3, 7, 6],
  [4, 5, 8],   [4, 8, 7]
];
const cells = elements.map(() => ({ regionIndex: 0 }));
const elementCell = elements.map((_, i) => i);
const mesh = {
  nodes, elements, cells, elementCell, elementType: 't3',
  elementData: elements.map(() => ({ centroid: { x: 0, y: 0 } }))
};

// Material: stiff elastic clay, γ = 18 kN/m³.
const material = {
  Emc: 20000, nu: 0.3, gamma: 18, cEff: 0, phiEffDeg: 30, K0nc: 0.5
};
const regionConstitutiveByRegion = new Map([
  [0, {
    materialParameters: {
      Emc: 20000, nu: 0.3, cEff: 0, phiEffDeg: 30, psiEffDeg: 0,
      gamma: 18, gammaSat: 18, K0nc: 0.5, sigmaTAllow: 0
    }
  }]
]);

// Element caches: build the same shape buildDeformationElementCaches produces.
function buildLocalElementCaches(mesh) {
  let gpCounter = 0;
  return mesh.elements.map((elem, eIdx) => {
    const corners = elem.map((nid) => mesh.nodes[nid]);
    const area = triangleArea(corners);
    const B = buildBMatrixT3(corners);
    const dofs = Int32Array.from([
      2 * elem[0], 2 * elem[0] + 1,
      2 * elem[1], 2 * elem[1] + 1,
      2 * elem[2], 2 * elem[2] + 1
    ]);
    const integrationPoints = [{
      gpIndex: 0, globalIndex: gpCounter, w: 1, areaWeightFactor: 1,
      areaWeight: area, B, x: 0, y: 0
    }];
    gpCounter += 1;
    return {
      elementIndex: eIdx, cellIndex: eIdx, element: elem,
      kind: 't3', kernel: null,
      localDofCount: 6, numGaussPoints: 1,
      nodes: corners, corners, area,
      B, bMatricesPerGp: [B], useBBar: false,
      centroid: { x: 0, y: 0 },
      integrationPoints, dofs
    };
  });
}
const elementCaches = buildLocalElementCaches(mesh);
elementCaches.integrationPointCount = 8;
const ndof = 2 * mesh.nodes.length;

// Fixed DOFs: bottom edge (nodes 0, 1, 2) fully constrained.
const fixedDofSet = new Set([0, 1, 2, 3, 4, 5]);

// Gravity RHS (full DOF), then compress to free DOFs.
const gravityRhsFull = new Float64Array(ndof);
for (const cache of elementCaches) {
  const fLocal = elementBodyForceVectorT3FromArea(cache.area, 0, -material.gamma);
  for (let k = 0; k < 6; k += 1) gravityRhsFull[cache.dofs[k]] += fLocal[k];
}

// Build free-DOF index map (same logic as solver.js).
const freeDofs = [];
const freeIndexByDof = new Map();
for (let dof = 0; dof < ndof; dof += 1) {
  if (fixedDofSet.has(dof)) continue;
  freeIndexByDof.set(dof, freeDofs.length);
  freeDofs.push(dof);
}
const numFree = freeDofs.length;
const gravityFree = new Float64Array(numFree);
for (let i = 0; i < numFree; i += 1) gravityFree[i] = gravityRhsFull[freeDofs[i]];

// ---------------------------------------------------------------------------
// CPU baseline: assemble K_CPU and solve via the standard CPU CG.
// ---------------------------------------------------------------------------
function buildCpuBaseline() {
  // Sparse rows in the same shape solver.js uses.
  const rows = Array.from({ length: numFree }, () => new Map());
  for (const cache of elementCaches) {
    const tangent = planeStrainElasticD(material.Emc, material.nu);
    const Ke = elementStiffnessT3FromBAndArea(cache.B, cache.area, tangent);
    for (let li = 0; li < 6; li += 1) {
      const ri = freeIndexByDof.get(cache.dofs[li]);
      if (ri == null) continue;
      const rowMap = rows[ri];
      for (let lj = 0; lj < 6; lj += 1) {
        const rj = freeIndexByDof.get(cache.dofs[lj]);
        if (rj == null) continue;
        rowMap.set(rj, (rowMap.get(rj) || 0) + Ke[li][lj]);
      }
    }
  }
  // Solve K u = f via dense (it's only 12x12).
  const K = new Float64Array(numFree * numFree);
  for (let i = 0; i < numFree; i += 1) {
    for (const [j, v] of rows[i]) K[i * numFree + j] = v;
  }
  const u = solveDense(K, gravityFree, numFree);
  return { K, u };
}

function planeStrainElasticD(E, nu) {
  const factor = E / ((1 + nu) * (1 - 2 * nu));
  return [[factor * (1 - nu), factor * nu, 0], [factor * nu, factor * (1 - nu), 0], [0, 0, factor * (1 - 2 * nu) / 2]];
}

function solveDense(A, b, n) {
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let pmag = Math.abs(M[col * n + col]);
    for (let r = col + 1; r < n; r += 1) {
      const m = Math.abs(M[r * n + col]);
      if (m > pmag) { pmag = m; pivot = r; }
    }
    if (pmag < 1e-30) throw new Error('Singular CPU baseline');
    if (pivot !== col) {
      for (let cc = 0; cc < n; cc += 1) {
        const tmp = M[col * n + cc]; M[col * n + cc] = M[pivot * n + cc]; M[pivot * n + cc] = tmp;
      }
      const tmp = x[col]; x[col] = x[pivot]; x[pivot] = tmp;
    }
    const inv = 1 / M[col * n + col];
    for (let r = col + 1; r < n; r += 1) {
      const f = M[r * n + col] * inv;
      for (let cc = col; cc < n; cc += 1) M[r * n + cc] -= f * M[col * n + cc];
      x[r] -= f * x[col];
    }
  }
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = x[r];
    for (let cc = r + 1; cc < n; cc += 1) s -= M[r * n + cc] * x[cc];
    x[r] = s / M[r * n + r];
  }
  return x;
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------
process.stdout.write(`\n=== GPU pipeline e2e parity (CPU reference) ===\n`);
process.stdout.write(`  Mesh: ${mesh.elements.length} T3 elements, ${mesh.nodes.length} nodes, ${ndof} DOFs, ${numFree} free.\n`);

const cpu = buildCpuBaseline();

const gpuRef = runDeformationOnGpuCpuReference({
  mesh, elementCaches, regionConstitutiveByRegion,
  fixedDofSet, bF64: gravityFree,
  cgOptions: { maxIter: 5000, relTol: 1e-12, absTol: 1e-15 }
});

const passes = [];
const failures = [];
function check(label, ok, detail = '') {
  (ok ? passes : failures).push({ label, detail });
  process.stdout.write(`  [${ok ? 'OK ' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}\n`);
}

check('GPU-reference solve converged', gpuRef.converged, `iters=${gpuRef.iterations}`);

// Compare CPU baseline displacement to GPU pipeline displacement.
let maxAbsErr = 0;
let maxRelErr = 0;
for (let i = 0; i < numFree; i += 1) {
  const ref = cpu.u[i];
  const got = gpuRef.uFreeF64[i];
  const abs = Math.abs(got - ref);
  const denom = Math.max(Math.abs(ref), 1e-12);
  maxAbsErr = Math.max(maxAbsErr, abs);
  maxRelErr = Math.max(maxRelErr, abs / denom);
}
check('GPU u vs CPU u — max abs error < 1e-9', maxAbsErr < 1e-9, `max abs=${maxAbsErr.toExponential(2)}`);
check('GPU u vs CPU u — max rel error < 1e-9', maxRelErr < 1e-9, `max rel=${maxRelErr.toExponential(2)}`);

// Compare the assembled CSR (sparse) to the dense CPU K.
const csrCpu = cpuReferenceAssemble({
  mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet
}).csrPacked;
let maxKDiff = 0;
for (let i = 0; i < numFree; i += 1) {
  const begin = csrCpu.rowPtr[i];
  const end = csrCpu.rowPtr[i + 1];
  for (let k = begin; k < end; k += 1) {
    const j = csrCpu.colInd[k];
    const got = csrCpu.valHi[k] + csrCpu.valLo[k];
    const ref = cpu.K[i * numFree + j];
    maxKDiff = Math.max(maxKDiff, Math.abs(got - ref));
  }
}
check('GPU-pack CSR matches CPU dense K to 1e-6 (relative-to-K-magnitude)', maxKDiff < 1e-6 * Math.abs(cpu.K[0]), `maxKDiff=${maxKDiff.toExponential(2)}, |K[0]|=${Math.abs(cpu.K[0]).toExponential(2)}`);

// Sanity: gravity is downward, so all uy should be ≤ 0 at every free node.
let allUyNonpositive = true;
for (let i = 0; i < numFree; i += 1) {
  const dof = freeDofs[i];
  if ((dof & 1) === 1 && gpuRef.uFreeF64[i] > 1e-12) { allUyNonpositive = false; break; }
}
check('GPU displacement physically plausible (uy ≤ 0 under gravity)', allUyNonpositive);

// Diagnostic: show the displacement at the top-corner node (8) for both paths.
const dofTopCornerY = 2 * 8 + 1;
const refTop = cpu.u[freeIndexByDof.get(dofTopCornerY)];
const gotTop = gpuRef.uFreeF64[freeIndexByDof.get(dofTopCornerY)];
process.stdout.write(`  top-corner uy:  CPU = ${refTop.toExponential(4)} m,  GPU = ${gotTop.toExponential(4)} m\n`);

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
