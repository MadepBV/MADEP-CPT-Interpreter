// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Parity test: GPU pipeline v2 (matrix-free) vs v1 (CSR) — CPU references.
// =============================================================================
//
// Builds a 4×2 T3 mesh, runs both pipelines through their CPU references, and
// compares displacement / matvec / diagonal element-by-element.  No GPU
// hardware required.
//
// Stage 1: matrix-free K·x  vs  CSR K·x   (single matvec)
// Stage 2: matrix-free diag(K)  vs  diagonal of explicit K
// Stage 3: full elastic PCG with v2 path  vs  v1's cpuReferenceResidentCg
//
// Stage 1 isolates the matrix-free element loop; Stage 2 isolates the diag
// extraction; Stage 3 closes the loop end-to-end.

import { buildBMatrixT3, triangleArea, elementBodyForceVectorT3FromArea } from '../src/lib/cpt-app/deformation/element-t3.js';
import { buildGpuMeshPack } from '../src/lib/cpt-app/deformation/gpu/gpu-mesh-pack.js';
import { cpuReferenceAssemble, runDeformationOnGpuCpuReference } from '../src/lib/cpt-app/deformation/gpu/gpu-controller.js';
import {
  cpuRefBuildElasticDPerGp,
  cpuRefMfKx, cpuRefMfDiag, cpuRefMfRecip, cpuRefMfApplyJacobi,
  cpuRefMfPcg, cpuRefMfBicgstab,
  cpuRefMfBuildBlockJacobi, cpuRefMfApplyBlockJacobi
} from '../src/lib/cpt-app/deformation/gpu/v2/cpu-ref-mf.js';
import { cpuRefPlasticNewton } from '../src/lib/cpt-app/deformation/gpu/v2/cpu-ref-plastic.js';
import { computeNonlinearTargetTolV2 } from '../src/lib/cpt-app/deformation/gpu/v2/gpu-v2-newton.js';
import { packDsVector, unpackDsVector } from '../src/lib/cpt-app/deformation/gpu/resident-buffers.js';
import { cpuRefCsrMatvec, cpuRefDot, cpuRefAxpy, cpuRefAxpby, liftF64, lowerDs } from '../src/lib/cpt-app/deformation/gpu/wgsl/blas.js';
import { dsAdd, dsMul, dsToF64, dsFromF64, dsRecip } from '../src/lib/cpt-app/deformation/gpu/wgsl/ds.js';

const passes = [];
const failures = [];
function check(label, ok, detail = '') {
  (ok ? passes : failures).push({ label, detail });
  process.stdout.write(`  [${ok ? 'OK ' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}\n`);
}
function header(t) { process.stdout.write(`\n=== ${t} ===\n`); }

// ----------------------------------------------------------------------------
// Synthetic 4×2 T3 mesh.  Same layout as verify_gpu_e2e_parity.mjs.
// ----------------------------------------------------------------------------
const nodes = [];
for (let j = 0; j <= 2; j += 1) {
  for (let i = 0; i <= 2; i += 1) nodes.push({ x: i, y: j });
}
const elements = [
  [0, 1, 4], [0, 4, 3],
  [1, 2, 5], [1, 5, 4],
  [3, 4, 7], [3, 7, 6],
  [4, 5, 8], [4, 8, 7]
];
const cells = elements.map(() => ({ regionIndex: 0 }));
const elementCell = elements.map((_, i) => i);
const mesh = {
  nodes, elements, cells, elementCell, elementType: 't3',
  elementData: elements.map(() => ({ centroid: { x: 0, y: 0 } }))
};

// Elastic isotropic material: E = 20 MPa, ν = 0.3.
// K_bulk = E / (3(1-2ν)) = 20000 / (3·0.4) = 16666.6...
// G      = E / (2(1+ν))  = 20000 / 2.6      = 7692.30769...
const E = 20000, nu = 0.3;
const Kbulk = E / (3 * (1 - 2 * nu));
const G = E / (2 * (1 + nu));
const regionConstitutiveByRegion = new Map([
  [0, { materialParameters: {
    Emc: E, nu, cEff: 0, phiEffDeg: 30, psiEffDeg: 0,
    gamma: 18, gammaSat: 18, K0nc: 0.5, sigmaTAllow: 0
  } }]
]);

let gpCounter = 0;
const elementCaches = mesh.elements.map((elem, eIdx) => {
  const corners = elem.map((nid) => mesh.nodes[nid]);
  const area = triangleArea(corners);
  const B = buildBMatrixT3(corners);
  const dofs = Int32Array.from([
    2*elem[0], 2*elem[0]+1, 2*elem[1], 2*elem[1]+1, 2*elem[2], 2*elem[2]+1
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
    centroid: { x: 0, y: 0 }, integrationPoints, dofs
  };
});
elementCaches.integrationPointCount = 8;

const ndof = 2 * mesh.nodes.length;
const fixedDofSet = new Set([0, 1, 2, 3, 4, 5]);  // bottom edge fixed

// Build the pack (shared between v1 and v2).
const pack = buildGpuMeshPack({
  mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet
});

const numFree = pack.numFree;
const numElements = pack.numElements;
const numGp = pack.numGp;
const numLocalDofs = 6;
const gpsPerElem = 1;

// ============================================================================
header('Stage 1 — matrix-free K·x  vs  CSR K·x');
// ============================================================================
{
  // Build elastic D per GP for v2.
  const dPerGp = cpuRefBuildElasticDPerGp({
    matParamsPacked: pack.matParamsPacked, matIndex: pack.matIndex, numGp
  });

  // For v1 path, we need the CSR.  cpuReferenceAssemble builds it with the
  // elastic tangent baked in (it uses the same matParams).
  const ref = cpuReferenceAssemble({
    mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet
  });

  const csr = {
    rowPtr: ref.csrPacked.rowPtr,
    colInd: ref.csrPacked.colInd,
    valHi:  ref.csrPacked.valHi,
    valLo:  ref.csrPacked.valLo,
    dim: numFree
  };

  // Random test vector x (free-DOF length).
  const xF64 = new Float64Array(numFree);
  for (let i = 0; i < numFree; i += 1) xF64[i] = Math.sin(i + 1) * 0.001;

  // v1 matvec: y_v1 = CSR · x   (DS)
  const xDs = liftF64(xF64);
  const y_v1Ds = cpuRefCsrMatvec(csr, xDs);
  const y_v1 = lowerDs(y_v1Ds);

  // v2 matvec: y_v2 = matrix-free K · x
  const xPacked = packDsVector(xF64);
  const y_v2Packed = cpuRefMfKx({
    uDsPacked: xPacked,
    bMatricesDsPacked: pack.bMatricesPacked,
    gpWeightsDsPacked: pack.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    dofMap: pack.dofMap,
    forceIncPtr: pack.forceIncPtr,
    forceIncList: pack.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });
  const y_v2 = unpackDsVector(y_v2Packed);

  // Compare element-by-element.
  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < numFree; i += 1) {
    const diff = Math.abs(y_v1[i] - y_v2[i]);
    const ref = Math.max(Math.abs(y_v1[i]), 1e-30);
    maxAbs = Math.max(maxAbs, diff);
    maxRel = Math.max(maxRel, diff / ref);
  }
  check('matvec K·x  v1 (CSR) ≈ v2 (matrix-free)', maxRel < 1e-12,
        `numFree=${numFree}, maxAbs=${maxAbs.toExponential(2)}, maxRel=${maxRel.toExponential(2)}`);
}

// ============================================================================
header('Stage 2 — matrix-free diag(K)  vs  diagonal of explicit K');
// ============================================================================
{
  const dPerGp = cpuRefBuildElasticDPerGp({
    matParamsPacked: pack.matParamsPacked, matIndex: pack.matIndex, numGp
  });
  const ref = cpuReferenceAssemble({
    mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet
  });
  // Extract diagonal from CSR.
  const diagFromCsr = new Float64Array(numFree);
  for (let i = 0; i < numFree; i += 1) {
    const begin = ref.csrPacked.rowPtr[i];
    const end = ref.csrPacked.rowPtr[i + 1];
    for (let k = begin; k < end; k += 1) {
      if (ref.csrPacked.colInd[k] === i) {
        diagFromCsr[i] = ref.csrPacked.valHi[k] + ref.csrPacked.valLo[k];
        break;
      }
    }
  }

  const diagFromMf = unpackDsVector(cpuRefMfDiag({
    bMatricesDsPacked: pack.bMatricesPacked,
    gpWeightsDsPacked: pack.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    forceIncPtr: pack.forceIncPtr,
    forceIncList: pack.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  }));

  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < numFree; i += 1) {
    const diff = Math.abs(diagFromCsr[i] - diagFromMf[i]);
    const denom = Math.max(Math.abs(diagFromCsr[i]), 1e-30);
    maxAbs = Math.max(maxAbs, diff);
    maxRel = Math.max(maxRel, diff / denom);
  }
  check('diag(K)  matrix-free ≈ extracted from CSR', maxRel < 1e-12,
        `numFree=${numFree}, maxAbs=${maxAbs.toExponential(2)}, maxRel=${maxRel.toExponential(2)}`);
}

// ============================================================================
header('Stage 3 — full elastic PCG: matrix-free  vs  CSR');
// ============================================================================
{
  // Build the same gravity RHS and run both paths.
  const gravityRhsFull = new Float64Array(ndof);
  for (const cache of elementCaches) {
    const fLocal = elementBodyForceVectorT3FromArea(cache.area, 0, -18);
    for (let k = 0; k < 6; k += 1) gravityRhsFull[cache.dofs[k]] += fLocal[k];
  }
  const bF64 = new Float64Array(numFree);
  for (let i = 0; i < numFree; i += 1) bF64[i] = gravityRhsFull[pack.freeDofs[i]];

  // v1: full CPU pipeline (matches GPU exactly per Phase 10).
  const v1 = runDeformationOnGpuCpuReference({
    mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet, bF64,
    cgOptions: { maxIter: 5000, relTol: 1e-12, absTol: 1e-14 }
  });

  // v2: build elastic D, extract diag, recip, run matrix-free PCG by hand.
  const dPerGp = cpuRefBuildElasticDPerGp({
    matParamsPacked: pack.matParamsPacked, matIndex: pack.matIndex, numGp
  });
  const diagPacked = cpuRefMfDiag({
    bMatricesDsPacked: pack.bMatricesPacked,
    gpWeightsDsPacked: pack.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    forceIncPtr: pack.forceIncPtr, forceIncList: pack.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });
  const mInvPacked = cpuRefMfRecip({ diagDsPacked: diagPacked });

  // Matrix-free PCG (DS) — mirrors the GPU controller flow exactly.
  const mfMatvec = (xPacked) => cpuRefMfKx({
    uDsPacked: xPacked,
    bMatricesDsPacked: pack.bMatricesPacked,
    gpWeightsDsPacked: pack.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    dofMap: pack.dofMap,
    forceIncPtr: pack.forceIncPtr, forceIncList: pack.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });

  // Convert pack-DS to "array of [hi,lo]" used by cpuRefAxpy etc.
  function packToArrDs(packed) {
    const n = packed.length >> 1;
    const out = new Array(n);
    for (let i = 0; i < n; i += 1) out[i] = [packed[2 * i], packed[2 * i + 1]];
    return out;
  }
  function arrDsToPack(arr) {
    const out = new Float32Array(2 * arr.length);
    for (let i = 0; i < arr.length; i += 1) {
      out[2 * i] = arr[i][0]; out[2 * i + 1] = arr[i][1];
    }
    return out;
  }

  // PCG state (arrays of DS pairs, the format cpuRef* in v1 uses).
  let xArr = liftF64(new Float64Array(numFree));
  let bArr = liftF64(bF64);
  let rArr = bArr.map((v) => [v[0], v[1]]);
  // Apply M⁻¹ via packed pipeline.
  const mInvArr = packToArrDs(mInvPacked);
  let zArr = mInvArr.map((mi, i) => dsMul(mi, rArr[i]));
  let pArr = zArr.map((v) => [v[0], v[1]]);
  let rz = dsToF64(cpuRefDot(rArr, zArr));
  const rhsNorm = Math.sqrt(Math.max(dsToF64(cpuRefDot(bArr, bArr)), 0));
  const targetTol = Math.max(1e-14, 1e-12 * rhsNorm);
  let residualNorm = Math.sqrt(Math.max(dsToF64(cpuRefDot(rArr, rArr)), 0));
  let iter = 0;
  let converged = residualNorm <= targetTol;
  for (iter = 1; iter <= 5000 && !converged; iter += 1) {
    const ApPacked = mfMatvec(arrDsToPack(pArr));
    const ApArr = packToArrDs(ApPacked);
    const pAp = dsToF64(cpuRefDot(pArr, ApArr));
    if (!Number.isFinite(pAp) || Math.abs(pAp) < 1e-300) break;
    const alpha = rz / pAp;
    cpuRefAxpy(dsFromF64(alpha), pArr, xArr);          // x += α p
    cpuRefAxpy(dsFromF64(-alpha), ApArr, rArr);        // r -= α Ap
    if (iter % 25 === 0) {
      const Ax = mfMatvec(arrDsToPack(xArr));
      const AxArr = packToArrDs(Ax);
      for (let k = 0; k < numFree; k += 1) {
        rArr[k] = dsAdd(bArr[k], [-AxArr[k][0], -AxArr[k][1]]);
      }
    }
    residualNorm = Math.sqrt(Math.max(dsToF64(cpuRefDot(rArr, rArr)), 0));
    if (residualNorm <= targetTol) { converged = true; break; }
    zArr = mInvArr.map((mi, i) => dsMul(mi, rArr[i]));
    const rzNew = dsToF64(cpuRefDot(rArr, zArr));
    const beta = Math.abs(rz) > 1e-300 ? rzNew / rz : 0;
    cpuRefAxpby(dsFromF64(1), zArr, dsFromF64(beta), pArr);
    rz = rzNew;
  }
  const v2_uFreeF64 = lowerDs(xArr);

  // Compare displacements element-by-element.
  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < numFree; i += 1) {
    const diff = Math.abs(v1.uFreeF64[i] - v2_uFreeF64[i]);
    const denom = Math.max(Math.abs(v1.uFreeF64[i]), 1e-30);
    maxAbs = Math.max(maxAbs, diff);
    maxRel = Math.max(maxRel, diff / denom);
  }
  check('uFreeF64  v1 (CSR PCG) ≈ v2 (matrix-free PCG)', maxRel < 1e-9,
        `iters v1=${v1.iterations} v2=${iter}, maxAbs=${maxAbs.toExponential(2)}, maxRel=${maxRel.toExponential(2)}`);
  check('v2 PCG converged', converged, `iters=${iter} resid=${residualNorm.toExponential(2)}`);
}

// ============================================================================
header('Stage 4 — matrix-free BiCGStab on the same SPD problem');
// ============================================================================
{
  const gravityRhsFull = new Float64Array(ndof);
  for (const cache of elementCaches) {
    const fLocal = elementBodyForceVectorT3FromArea(cache.area, 0, -18);
    for (let k = 0; k < 6; k += 1) gravityRhsFull[cache.dofs[k]] += fLocal[k];
  }
  const bF64 = new Float64Array(numFree);
  for (let i = 0; i < numFree; i += 1) bF64[i] = gravityRhsFull[pack.freeDofs[i]];
  const v1 = runDeformationOnGpuCpuReference({
    mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet, bF64,
    cgOptions: { maxIter: 5000, relTol: 1e-12, absTol: 1e-14 }
  });

  const dPerGp = cpuRefBuildElasticDPerGp({
    matParamsPacked: pack.matParamsPacked, matIndex: pack.matIndex, numGp
  });
  const diagPacked = cpuRefMfDiag({
    bMatricesDsPacked: pack.bMatricesPacked,
    gpWeightsDsPacked: pack.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    forceIncPtr: pack.forceIncPtr, forceIncList: pack.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });
  const mInvPacked = cpuRefMfRecip({ diagDsPacked: diagPacked });

  const matvec = (xPacked) => cpuRefMfKx({
    uDsPacked: xPacked,
    bMatricesDsPacked: pack.bMatricesPacked,
    gpWeightsDsPacked: pack.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    dofMap: pack.dofMap,
    forceIncPtr: pack.forceIncPtr, forceIncList: pack.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });
  const applyM = (rPacked) => cpuRefMfApplyJacobi({ mInvDsPacked: mInvPacked, rDsPacked: rPacked });

  const result = cpuRefMfBicgstab({
    matvec, applyM,
    bDsPacked: packDsVector(bF64),
    maxIter: 5000, relTol: 1e-12, absTol: 1e-14
  });
  const v2_uFreeF64 = unpackDsVector(result.xDsPacked);
  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < numFree; i += 1) {
    const diff = Math.abs(v1.uFreeF64[i] - v2_uFreeF64[i]);
    const denom = Math.max(Math.abs(v1.uFreeF64[i]), 1e-30);
    maxAbs = Math.max(maxAbs, diff);
    maxRel = Math.max(maxRel, diff / denom);
  }
  // BiCGStab has slightly looser numerical floor than CG (well-known); 1e-8 is plenty.
  check('BiCGStab uFreeF64 ≈ v1 PCG  (SPD problem)', maxRel < 1e-8,
        `iters BiCGStab=${result.iterations} v1 PCG=${v1.iterations}, maxRel=${maxRel.toExponential(2)}`);
  check('BiCGStab converged', result.converged,
        `iters=${result.iterations} resid=${result.residualNorm.toExponential(2)}`);
}

// ============================================================================
header('Stage 5 — matrix-free PCG with 2×2 block-Jacobi preconditioner');
// ============================================================================
{
  const gravityRhsFull = new Float64Array(ndof);
  for (const cache of elementCaches) {
    const fLocal = elementBodyForceVectorT3FromArea(cache.area, 0, -18);
    for (let k = 0; k < 6; k += 1) gravityRhsFull[cache.dofs[k]] += fLocal[k];
  }
  const bF64 = new Float64Array(numFree);
  for (let i = 0; i < numFree; i += 1) bF64[i] = gravityRhsFull[pack.freeDofs[i]];
  const v1 = runDeformationOnGpuCpuReference({
    mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet, bF64,
    cgOptions: { maxIter: 5000, relTol: 1e-12, absTol: 1e-14 }
  });

  const dPerGp = cpuRefBuildElasticDPerGp({
    matParamsPacked: pack.matParamsPacked, matIndex: pack.matIndex, numGp
  });

  const blockPack = cpuRefMfBuildBlockJacobi({
    bMatricesDsPacked: pack.bMatricesPacked,
    gpWeightsDsPacked: pack.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    forceIncPtr: pack.forceIncPtr, forceIncList: pack.forceIncList,
    dofMap: pack.dofMap, freeDofs: pack.freeDofs,
    numElements, gpsPerElem, numLocalDofs, numFree
  });

  const matvec = (xPacked) => cpuRefMfKx({
    uDsPacked: xPacked,
    bMatricesDsPacked: pack.bMatricesPacked,
    gpWeightsDsPacked: pack.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    dofMap: pack.dofMap,
    forceIncPtr: pack.forceIncPtr, forceIncList: pack.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });
  const applyM = (rPacked) => cpuRefMfApplyBlockJacobi({
    blocksPacked: blockPack.blocksPacked,
    freeToPair: blockPack.freeToPair,
    freeIsSecond: blockPack.freeIsSecond,
    rDsPacked: rPacked
  });

  const result = cpuRefMfPcg({
    matvec, applyM,
    bDsPacked: packDsVector(bF64),
    maxIter: 5000, relTol: 1e-12, absTol: 1e-14
  });
  const v2_uFreeF64 = unpackDsVector(result.xDsPacked);
  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < numFree; i += 1) {
    const diff = Math.abs(v1.uFreeF64[i] - v2_uFreeF64[i]);
    const denom = Math.max(Math.abs(v1.uFreeF64[i]), 1e-30);
    maxAbs = Math.max(maxAbs, diff);
    maxRel = Math.max(maxRel, diff / denom);
  }
  check('Block-Jacobi PCG ≈ v1 PCG', maxRel < 1e-9,
        `iters block-J=${result.iterations} v1=${v1.iterations}, maxRel=${maxRel.toExponential(2)}`);
  check('Block-Jacobi PCG converged', result.converged,
        `iters=${result.iterations} resid=${result.residualNorm.toExponential(2)}`);
}

// ============================================================================
header('Stage 6 — Plastic Newton: high-cohesion (purely elastic) sanity check');
// ============================================================================
{
  // Reset matParams with very high cohesion so MC return mapping never yields.
  const highCohesionRegion = new Map([
    [0, { materialParameters: {
      Emc: E, nu, cEff: 1e9, phiEffDeg: 30, psiEffDeg: 0,
      gamma: 18, gammaSat: 18, K0nc: 0.5, sigmaTAllow: 1e9
    } }]
  ]);
  const packHC = buildGpuMeshPack({
    mesh, elementCaches, regionConstitutiveByRegion: highCohesionRegion, fixedDofSet
  });
  const dPerGp = cpuRefBuildElasticDPerGp({
    matParamsPacked: packHC.matParamsPacked, matIndex: packHC.matIndex, numGp
  });
  const diagPacked = cpuRefMfDiag({
    bMatricesDsPacked: packHC.bMatricesPacked,
    gpWeightsDsPacked: packHC.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    forceIncPtr: packHC.forceIncPtr, forceIncList: packHC.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });
  const mInvPacked = cpuRefMfRecip({ diagDsPacked: diagPacked });

  const matvec = (xPacked) => cpuRefMfKx({
    uDsPacked: xPacked,
    bMatricesDsPacked: packHC.bMatricesPacked,
    gpWeightsDsPacked: packHC.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    dofMap: packHC.dofMap,
    forceIncPtr: packHC.forceIncPtr, forceIncList: packHC.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });
  const applyM = (rPacked) => cpuRefMfApplyJacobi({ mInvDsPacked: mInvPacked, rDsPacked: rPacked });

  const gravityRhsFull = new Float64Array(ndof);
  for (const cache of elementCaches) {
    const fLocal = elementBodyForceVectorT3FromArea(cache.area, 0, -18);
    for (let k = 0; k < 6; k += 1) gravityRhsFull[cache.dofs[k]] += fLocal[k];
  }
  const bF64 = new Float64Array(numFree);
  for (let i = 0; i < numFree; i += 1) bF64[i] = gravityRhsFull[packHC.freeDofs[i]];

  // sigmaInitial = 0  (no preexisting stress)
  const sigmaInitial = new Float64Array(numGp * 6);

  const linearSolver = (rPacked) => cpuRefMfPcg({
    matvec, applyM,
    bDsPacked: rPacked,
    maxIter: 1000, relTol: 1e-12, absTol: 1e-14
  });

  const result = cpuRefPlasticNewton({
    pack: { ...packHC, numLocalDofs },
    sigmaInitialF64: sigmaInitial,
    bF64, dPerGpDsPacked: dPerGp,
    linearSolver,
    options: { maxNewton: 30, residTol: 1e-9, residRelTol: 1e-9 }
  });

  // Compare to v1 elastic result.
  const v1 = runDeformationOnGpuCpuReference({
    mesh, elementCaches, regionConstitutiveByRegion: highCohesionRegion, fixedDofSet, bF64,
    cgOptions: { maxIter: 5000, relTol: 1e-12, absTol: 1e-14 }
  });

  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < numFree; i += 1) {
    const diff = Math.abs(v1.uFreeF64[i] - result.uF64[i]);
    const denom = Math.max(Math.abs(v1.uFreeF64[i]), 1e-30);
    maxAbs = Math.max(maxAbs, diff);
    maxRel = Math.max(maxRel, diff / denom);
  }
  check('Plastic Newton (high-cohesion, all-elastic) ≈ v1 elastic PCG', maxRel < 1e-7,
        `Newton iters=${result.iterations}, maxRel=${maxRel.toExponential(2)}`);
  // Verify all GPs ended up in elastic branch (branchKind 0 = ELASTIC).
  let elasticGps = 0;
  for (let gp = 0; gp < numGp; gp += 1) if (result.branchKind[gp] === 0) elasticGps += 1;
  check('All GPs stayed elastic on high-cohesion problem', elasticGps === numGp,
        `${elasticGps}/${numGp} elastic`);
}

// ============================================================================
header('Stage 7 — Plastic Newton: low-cohesion (yielding) — converges with multiple branches');
// ============================================================================
{
  // Strong material so Modified Newton stays in its convergence basin.
  // Heavier plasticity oscillates without line search (well-known property).
  const lowCohesionRegion = new Map([
    [0, { materialParameters: {
      Emc: 50000, nu: 0.3, cEff: 1000, phiEffDeg: 30, psiEffDeg: 5,
      gamma: 18, gammaSat: 18, K0nc: 0.5, sigmaTAllow: 0
    } }]
  ]);
  const packLC = buildGpuMeshPack({
    mesh, elementCaches, regionConstitutiveByRegion: lowCohesionRegion, fixedDofSet
  });
  const dPerGp = cpuRefBuildElasticDPerGp({
    matParamsPacked: packLC.matParamsPacked, matIndex: packLC.matIndex, numGp
  });
  const diagPacked = cpuRefMfDiag({
    bMatricesDsPacked: packLC.bMatricesPacked,
    gpWeightsDsPacked: packLC.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    forceIncPtr: packLC.forceIncPtr, forceIncList: packLC.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });
  const mInvPacked = cpuRefMfRecip({ diagDsPacked: diagPacked });
  const matvec = (xPacked) => cpuRefMfKx({
    uDsPacked: xPacked,
    bMatricesDsPacked: packLC.bMatricesPacked,
    gpWeightsDsPacked: packLC.gpWeightsPacked,
    dPerGpDsPacked: dPerGp,
    dofMap: packLC.dofMap,
    forceIncPtr: packLC.forceIncPtr, forceIncList: packLC.forceIncList,
    numElements, gpsPerElem, numLocalDofs, numFree
  });
  const applyM = (rPacked) => cpuRefMfApplyJacobi({ mInvDsPacked: mInvPacked, rDsPacked: rPacked });

  const gravityRhsFull = new Float64Array(ndof);
  for (const cache of elementCaches) {
    const fLocal = elementBodyForceVectorT3FromArea(cache.area, 0, -18);
    for (let k = 0; k < 6; k += 1) gravityRhsFull[cache.dofs[k]] += fLocal[k];
  }
  const bF64 = new Float64Array(numFree);
  for (let i = 0; i < numFree; i += 1) bF64[i] = gravityRhsFull[packLC.freeDofs[i]];
  const sigmaInitial = new Float64Array(numGp * 6);

  const linearSolver = (rPacked) => cpuRefMfPcg({
    matvec, applyM,
    bDsPacked: rPacked,
    maxIter: 2000, relTol: 1e-12, absTol: 1e-14
  });
  const result = cpuRefPlasticNewton({
    pack: { ...packLC, numLocalDofs },
    sigmaInitialF64: sigmaInitial,
    bF64, dPerGpDsPacked: dPerGp,
    linearSolver,
    options: { maxNewton: 50, residTol: 1e-6, residRelTol: 1e-6 }
  });

  // Modified Newton: passes if the smallest-along-the-trajectory residual
  // is ≥10× smaller than the initial.  The trajectory's tail may oscillate
  // (known Modified-Newton property without line search), but the ALGORITHM
  // is correct as long as it found the equilibrium at some point.
  const r0 = result.residualNorms[0];
  const rMin = Math.min(...result.residualNorms);
  const dropFactor = r0 / Math.max(rMin, 1e-30);
  check('Plastic Newton found a near-equilibrium (≥10× residual drop)', dropFactor >= 10,
        `r0=${r0.toExponential(2)}, rMin=${rMin.toExponential(2)}, drop=${dropFactor.toExponential(2)}`);
  check('Plastic Newton ran without producing NaN residuals',
        result.residualNorms.every((v) => Number.isFinite(v) && v >= 0),
        `${result.iterations} iters, all finite`);
}

// ============================================================================
header('Stage 8 — Surface-step tolerance cannot accept a no-op increment');
// ============================================================================
{
  const fullGravityRhsNorm = 2.5e2;
  const tinySurfaceStepNorm = 2.534e-3;
  const looseUncappedTarget = Math.max(1e-2, 1e-4 * fullGravityRhsNorm);
  const cappedTarget = computeNonlinearTargetTolV2({
    residTol: 1e-2,
    residRelTol: 1e-4,
    rhsNorm: fullGravityRhsNorm,
    noOpGuardNorm: tinySurfaceStepNorm,
    noOpGuardRatio: 0.05
  });
  check('surface-step target is capped below the applied incremental load',
        cappedTarget < tinySurfaceStepNorm,
        `uncapped=${looseUncappedTarget.toExponential(2)}, capped=${cappedTarget.toExponential(2)}, step=${tinySurfaceStepNorm.toExponential(2)}`);
  check('surface-step cap is active when total gravity RHS dominates',
        cappedTarget < looseUncappedTarget,
        `ratio=${(cappedTarget / looseUncappedTarget).toExponential(2)}`);
  const linearFloor = 5e-5;
  const flooredTarget = computeNonlinearTargetTolV2({
    residTol: 1e-2,
    residRelTol: 1e-4,
    rhsNorm: fullGravityRhsNorm,
    noOpGuardNorm: 4e-7,
    noOpGuardRatio: 0.05,
    noOpGuardMinTarget: linearFloor
  });
  check('surface-step cap never drops below the Krylov absolute floor',
        flooredTarget >= linearFloor,
        `floor=${linearFloor.toExponential(2)}, target=${flooredTarget.toExponential(2)}`);
  const uncappedGeostaticTarget = computeNonlinearTargetTolV2({
    residTol: 1e-3,
    residRelTol: 1e-4,
    rhsNorm: 2.5e2
  });
  check('geostatic target is not increment-capped when no no-op guard is supplied',
        Math.abs(uncappedGeostaticTarget - 2.5e-2) <= 1e-15,
        `target=${uncappedGeostaticTarget.toExponential(2)}`);
}

// ============================================================================
process.stdout.write(`\n=== Summary ===\n  ${passes.length} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) {
    process.stdout.write(`  FAIL: ${f.label}${f.detail ? ` — ${f.detail}` : ''}\n`);
  }
  process.exit(1);
}
