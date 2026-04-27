// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Mesh → GPU device pack.
// ============================================================================
//
// Converts the CPU-side `elementCaches` + `regionConstitutiveByRegion` +
// `mesh` triple produced by the deformation solver into the flat,
// double-single-packed buffers the GPU resident pipeline consumes.
//
// What the device pack contains:
//
//   bMatricesPacked     : Float32Array of length 2 * (numElements * gpsPerElem * 3 * numLocalDofs)
//                         — DS B-matrix per (elem, gp, row, col), row-major.
//   gpWeightsPacked     : Float32Array of length 2 * (numElements * gpsPerElem)
//                         — DS  w · |J|  per Gauss point.
//   dofMap              : Int32Array of length numElements * numLocalDofs
//                         — free-DOF index for each (elem, localDof);
//                            -1 means constrained.
//   matIndex            : Uint32Array of length numElements * gpsPerElem
//                         — material index per Gauss point.
//   regionId            : Uint32Array of length numElements * gpsPerElem
//                         — region index per Gauss point (used by the K0
//                           recovery kernel; mostly equals matIndex).
//   matParamsPacked     : Float32Array of length 2 * (numMaterials * 8)
//                         — DS material constants per region in this order:
//                           [sinPhi, cosPhi, sinPsi, cosPsi, c, σ_T, K, G].
//   k0RegionsPacked     : Float32Array of length 2 * (numMaterials * 4)
//                         — DS K0-recovery constants per region:
//                           [K0, E, ν, γ].
//   forceIncPtr         : Uint32Array (numFree + 1)
//   forceIncList        : Uint32Array (totalForceIncidence)
//   csrIncPtr           : Uint32Array (nnz + 1)
//   csrIncList          : Uint32Array (totalCsrIncidence)
//   csrColInd, csrRowPtr: Uint32Array describing the assembled-CSR structure.
//   numFree, ndof, nnz, numGp, numElements, numLocalDofs, gpsPerElem.
//
// All conversions are deterministic, pure, and host-side: no GPU calls.
// The runtime layer (`gpu-controller.js`) takes this pack and uploads it
// into device buffers in one go.
// ============================================================================

import { dsFromF64 } from './wgsl/ds.js';
import { buildScatterIncidence } from './wgsl/elements.js';

// -----------------------------------------------------------------------------
// Pack a sequence of f64 values into a Float32Array of [hi0, lo0, hi1, lo1, ...]
// using Veltkamp split.
// -----------------------------------------------------------------------------
function packDsArray(f64values) {
  const n = f64values.length;
  const out = new Float32Array(2 * n);
  for (let i = 0; i < n; i += 1) {
    const v = Number(f64values[i]) || 0;
    const hi = Math.fround(v);
    const lo = Math.fround(v - hi);
    out[2 * i] = hi;
    out[2 * i + 1] = lo;
  }
  return out;
}

// -----------------------------------------------------------------------------
// Material-pack helpers.  Convert region constitutive records to the flat DS
// arrays the MC kernel and the K0 kernel expect.
// -----------------------------------------------------------------------------
function materialMcParams(materialParameters) {
  const phi = ((Number(materialParameters?.phiEffDeg) || 0) * Math.PI) / 180;
  const psi = ((Number(materialParameters?.psiEffDeg) || 0) * Math.PI) / 180;
  const c = Number(materialParameters?.cEff) || 0;
  const sigmaT = Number(materialParameters?.sigmaTAllow) || 0;
  const E = Math.max(Number(materialParameters?.Emc) || 1000, 1);
  const nu = Math.max(Math.min(Number(materialParameters?.nu) || 0.3, 0.499), -0.999);
  const KBulk = E / (3 * (1 - 2 * nu));
  const G = E / (2 * (1 + nu));
  return {
    sinPhi: Math.sin(phi),
    cosPhi: Math.cos(phi),
    sinPsi: Math.sin(psi),
    cosPsi: Math.cos(psi),
    c,
    sigmaT,
    KBulk,
    G
  };
}

function materialK0Params(materialParameters) {
  const phi = ((Number(materialParameters?.phiEffDeg) || 0) * Math.PI) / 180;
  const K0 = Number.isFinite(Number(materialParameters?.K0nc))
    ? Math.max(Number(materialParameters.K0nc), 0)
    : Math.max(1 - Math.sin(phi), 0);
  const E = Math.max(Number(materialParameters?.Emc) || 1000, 1);
  const nu = Math.max(Math.min(Number(materialParameters?.nu) || 0.3, 0.499), -0.999);
  const gamma = Math.max(Number(materialParameters?.gamma) || 18, 0);
  return { K0, E, nu, gamma };
}

// -----------------------------------------------------------------------------
// Compute the CSR pattern produced by `buildCompressedAssemblyPattern` in the
// CPU solver, but here we only need the (rowPtr, colInd) structure: the
// numerical values come from the GPU scatter at runtime.
// -----------------------------------------------------------------------------
function buildCsrPattern(elementCaches, freeIndexByDof, numFree) {
  const rowSets = Array.from({ length: numFree }, () => new Set());
  for (const elementCache of elementCaches) {
    const dofs = elementCache.dofs;
    for (let li = 0; li < dofs.length; li += 1) {
      const ri = freeIndexByDof.get(dofs[li]);
      if (ri == null) continue;
      for (let lj = 0; lj < dofs.length; lj += 1) {
        const rj = freeIndexByDof.get(dofs[lj]);
        if (rj == null) continue;
        rowSets[ri].add(rj);
      }
    }
  }
  const rows = rowSets.map((rowSet) => {
    const indices = Int32Array.from([...rowSet].sort((a, b) => a - b));
    return { indices, values: new Float64Array(indices.length) };
  });
  let nnz = 0;
  const rowPtr = new Uint32Array(numFree + 1);
  for (let i = 0; i < numFree; i += 1) { rowPtr[i] = nnz; nnz += rows[i].indices.length; }
  rowPtr[numFree] = nnz;
  const colInd = new Uint32Array(nnz);
  let cursor = 0;
  for (let i = 0; i < numFree; i += 1) {
    const ind = rows[i].indices;
    for (let k = 0; k < ind.length; k += 1) {
      colInd[cursor] = ind[k];
      cursor += 1;
    }
  }
  return { rows, rowPtr, colInd, nnz };
}

// -----------------------------------------------------------------------------
// Build a per-DOF "free index" map.  freeIndexByDof: globalDof → freeIndex.
// -----------------------------------------------------------------------------
function buildFreeIndex(ndof, fixedDofSet) {
  const freeIndexByDof = new Map();
  const freeDofs = [];
  for (let dof = 0; dof < ndof; dof += 1) {
    if (fixedDofSet.has(dof)) continue;
    freeIndexByDof.set(dof, freeDofs.length);
    freeDofs.push(dof);
  }
  return { freeDofs, freeIndexByDof };
}

// =============================================================================
// Top-level: build the device pack from the standard CPU-side analysis state.
// =============================================================================
export function buildGpuMeshPack({
  mesh,
  elementCaches,
  regionConstitutiveByRegion,
  fixedDofSet,                  // Set<number> of constrained global DOFs
  porePressureByIntegrationPoint = null,
  warnings = []
}) {
  if (!mesh || !elementCaches) {
    throw new Error('buildGpuMeshPack: mesh and elementCaches are required.');
  }
  const numElements = elementCaches.length;
  if (numElements === 0) {
    throw new Error('buildGpuMeshPack: mesh contains no elements.');
  }
  const sample = elementCaches[0];
  const numLocalDofs = Number(sample.localDofCount) || sample.dofs?.length || 0;
  const gpsPerElem = Number(sample.numGaussPoints) || sample.integrationPoints?.length || 1;
  if (numLocalDofs <= 0 || gpsPerElem <= 0) {
    throw new Error('buildGpuMeshPack: element cache shape is invalid.');
  }
  const STRAIN_DIM = 3;
  const ndof = 2 * mesh.nodes.length;
  const { freeDofs, freeIndexByDof } = buildFreeIndex(ndof, fixedDofSet || new Set());

  // ---------------------------------------------------------------------------
  // Pack B-matrices and Gauss-point weights.
  // ---------------------------------------------------------------------------
  const bRowMajor = new Float64Array(numElements * gpsPerElem * STRAIN_DIM * numLocalDofs);
  const gpWeights = new Float64Array(numElements * gpsPerElem);
  // The Gauss-weight convention here matches the CPU solver: each GP carries
  // `area * areaWeightFactor`.  For T3 (1 GP, areaWeightFactor=1) this gives
  // exactly `area`, which matches the CPU's `area * B^T D B` integration.
  // For T6 (3 GPs, areaWeightFactor = w*2 = 1/3 each), the three GPs sum to
  // `area`, exact for the 3-point parametric-triangle rule.
  for (let e = 0; e < numElements; e += 1) {
    const cache = elementCaches[e];
    const elemBase = e * gpsPerElem * STRAIN_DIM * numLocalDofs;
    const gpBase = e * gpsPerElem;
    const area = Math.max(Number(cache.area) || 0, 0);
    const bMatrices = cache.bMatricesPerGp || [cache.B];
    const gps = cache.integrationPoints || [];
    for (let g = 0; g < gpsPerElem; g += 1) {
      const B = bMatrices[g] || cache.B;
      const factor = Number(gps[g]?.areaWeightFactor);
      const w = Number.isFinite(factor) ? factor : 1;
      gpWeights[gpBase + g] = area * w;
      const slot = elemBase + g * STRAIN_DIM * numLocalDofs;
      for (let r = 0; r < STRAIN_DIM; r += 1) {
        for (let c = 0; c < numLocalDofs; c += 1) {
          bRowMajor[slot + r * numLocalDofs + c] = (B && B[r] && B[r][c]) || 0;
        }
      }
    }
  }
  const bMatricesPacked = packDsArray(bRowMajor);
  const gpWeightsPacked = packDsArray(gpWeights);

  // ---------------------------------------------------------------------------
  // dofMap: per (elem, localDof) → free DOF or -1.
  // ---------------------------------------------------------------------------
  const dofMap = new Int32Array(numElements * numLocalDofs);
  for (let e = 0; e < numElements; e += 1) {
    const cache = elementCaches[e];
    const dofs = cache.dofs;
    for (let d = 0; d < numLocalDofs; d += 1) {
      const free = freeIndexByDof.get(dofs[d]);
      dofMap[e * numLocalDofs + d] = (free == null) ? -1 : free;
    }
  }

  // ---------------------------------------------------------------------------
  // Material packs (MC + K0).  matIndex maps GP → region index.
  // ---------------------------------------------------------------------------
  // Build a stable region-index → packed-material-index mapping.
  const regionIndexList = Array.from(regionConstitutiveByRegion?.keys?.() || []).sort((a, b) => a - b);
  const matToRegion = regionIndexList;
  const regionToMat = new Map(regionIndexList.map((rid, idx) => [rid, idx]));
  const numMaterials = regionIndexList.length;
  const mcF64 = new Float64Array(numMaterials * 8);
  const k0F64 = new Float64Array(numMaterials * 4);
  regionIndexList.forEach((regionIndex, matIdx) => {
    const constitutive = regionConstitutiveByRegion.get(regionIndex);
    const params = materialMcParams(constitutive?.materialParameters || {});
    mcF64[matIdx * 8 + 0] = params.sinPhi;
    mcF64[matIdx * 8 + 1] = params.cosPhi;
    mcF64[matIdx * 8 + 2] = params.sinPsi;
    mcF64[matIdx * 8 + 3] = params.cosPsi;
    mcF64[matIdx * 8 + 4] = params.c;
    mcF64[matIdx * 8 + 5] = params.sigmaT;
    mcF64[matIdx * 8 + 6] = params.KBulk;
    mcF64[matIdx * 8 + 7] = params.G;
    const k0params = materialK0Params(constitutive?.materialParameters || {});
    k0F64[matIdx * 4 + 0] = k0params.K0;
    k0F64[matIdx * 4 + 1] = k0params.E;
    k0F64[matIdx * 4 + 2] = k0params.nu;
    k0F64[matIdx * 4 + 3] = k0params.gamma;
  });
  const matParamsPacked = packDsArray(mcF64);
  const k0RegionsPacked = packDsArray(k0F64);

  // matIndex: per Gauss point.  cell.regionIndex → mat slot.
  const numGp = numElements * gpsPerElem;
  const matIndex = new Uint32Array(numGp);
  const regionId = new Uint32Array(numGp);
  for (let e = 0; e < numElements; e += 1) {
    const cache = elementCaches[e];
    const cell = mesh.cells[cache.cellIndex];
    const regionIndex = Number(cell?.regionIndex);
    const matSlot = regionToMat.get(regionIndex);
    if (matSlot == null) {
      pushUnique(warnings, `Element ${e}: cell.regionIndex ${regionIndex} has no constitutive entry — using slot 0.`);
    }
    for (let g = 0; g < gpsPerElem; g += 1) {
      const idx = e * gpsPerElem + g;
      matIndex[idx] = matSlot ?? 0;
      regionId[idx] = matSlot ?? 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Pore pressure per GP (DS-packed).  Defaults to zero if not provided.
  // ---------------------------------------------------------------------------
  const poreF64 = new Float64Array(numGp);
  if (porePressureByIntegrationPoint && porePressureByIntegrationPoint.length === numGp) {
    for (let i = 0; i < numGp; i += 1) poreF64[i] = porePressureByIntegrationPoint[i] || 0;
  }
  const porePressurePacked = packDsArray(poreF64);

  // ---------------------------------------------------------------------------
  // CSR pattern + scatter incidence.
  // ---------------------------------------------------------------------------
  const numFree = freeDofs.length;
  const csr = buildCsrPattern(elementCaches, freeIndexByDof, numFree);
  const incidence = buildScatterIncidence({
    dofMap, csrRows: csr.rows, numElements, numLocalDofs
  });

  return {
    // Structural
    ndof,
    numFree,
    freeDofs: Int32Array.from(freeDofs),
    freeIndexByDof,
    numElements,
    numLocalDofs,
    gpsPerElem,
    numGp,
    numMaterials,
    matToRegion,
    regionToMat,
    // Element packs
    bMatricesPacked,
    gpWeightsPacked,
    dofMap,
    matIndex,
    regionId,
    porePressurePacked,
    // Material packs
    matParamsPacked,
    k0RegionsPacked,
    // CSR pattern (values empty until first scatter pass on device)
    csrRowPtr: csr.rowPtr,
    csrColInd: csr.colInd,
    nnz: csr.nnz,
    // Scatter incidence
    forceIncPtr:  incidence.forceIncPtr,
    forceIncList: incidence.forceIncList,
    csrIncPtr:    incidence.csrIncPtr,
    csrIncList:   incidence.csrIncList
  };
}

// Helper.
function pushUnique(arr, message) {
  if (!arr.includes(message)) arr.push(message);
}

// =============================================================================
// Convenience: re-pack a free-DOF f64 vector into the DS-packed layout the
// kernels consume.  Used to upload b, x_initial, etc.
// =============================================================================
export function packFreeDofVector(f64) {
  return packDsArray(f64);
}

export function unpackFreeDofVector(packed) {
  const n = packed.length >> 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) out[i] = packed[2 * i] + packed[2 * i + 1];
  return out;
}

// =============================================================================
// Block-Jacobi 2x2 inverse pack from the assembled CSR.  The block at node n
// has rows (2n, 2n+1) and the same two columns; we extract (a, b, c, d) from
// the unpacked CSR and invert the 2x2.
//
// This needs the freeDofs → globalDofs mapping to identify which free rows
// belong to the same nodal block (i.e., free rows ri, rj such that
// freeDofs[ri] = 2n + 0 and freeDofs[rj] = 2n + 1 for the same node n).
// =============================================================================
export function buildBlockJacobiPackForFreeDofs({ freeDofs, csrRowPtr, csrColInd, csrValHi, csrValLo }) {
  const numFree = freeDofs.length;
  // Reverse map: globalDof → free index.
  const freeIndexByDof = new Map();
  for (let i = 0; i < numFree; i += 1) freeIndexByDof.set(freeDofs[i], i);
  // Group free rows by node (n = global DOF / 2).
  const blocksByNode = new Map();
  for (let i = 0; i < numFree; i += 1) {
    const dof = freeDofs[i];
    const node = dof >> 1;
    const isY = dof & 1;
    if (!blocksByNode.has(node)) blocksByNode.set(node, { row0: -1, row1: -1 });
    const slot = blocksByNode.get(node);
    if (isY) slot.row1 = i; else slot.row0 = i;
  }
  // Build the per-node packed block (4 DS scalars per node).
  // For nodes that have only one free DOF (the other is constrained), use
  // scalar Jacobi for that DOF.
  const numNodes = Math.ceil(numFree / 2);
  const out = new Float32Array(8 * numNodes);
  let nodeSlot = 0;
  for (const [, { row0, row1 }] of blocksByNode) {
    let a = 0, b = 0, c = 0, d = 0;
    // Read diagonal of row0 from CSR if available.
    if (row0 >= 0) {
      const begin = csrRowPtr[row0], end = csrRowPtr[row0 + 1];
      for (let k = begin; k < end; k += 1) {
        if (csrColInd[k] === row0) a = csrValHi[k] + csrValLo[k];
        if (row1 >= 0 && csrColInd[k] === row1) b = csrValHi[k] + csrValLo[k];
      }
    }
    if (row1 >= 0) {
      const begin = csrRowPtr[row1], end = csrRowPtr[row1 + 1];
      for (let k = begin; k < end; k += 1) {
        if (row0 >= 0 && csrColInd[k] === row0) c = csrValHi[k] + csrValLo[k];
        if (csrColInd[k] === row1) d = csrValHi[k] + csrValLo[k];
      }
    }
    // Invert 2x2 if possible; else fall back to scalar.
    const det = a * d - b * c;
    let A, B, C, D;
    if (Math.abs(det) > 1e-30 && row0 >= 0 && row1 >= 0) {
      A = d / det; B = -b / det; C = -c / det; D = a / det;
    } else if (row0 >= 0 && Math.abs(a) > 1e-30) {
      A = 1 / a; B = 0; C = 0; D = (row1 >= 0 && Math.abs(d) > 1e-30) ? 1 / d : 1;
    } else if (row1 >= 0 && Math.abs(d) > 1e-30) {
      A = 1; B = 0; C = 0; D = 1 / d;
    } else {
      A = 1; B = 0; C = 0; D = 1;
    }
    const pack = (v, k) => {
      const hi = Math.fround(v);
      const lo = Math.fround(v - hi);
      out[8 * nodeSlot + 2 * k] = hi;
      out[8 * nodeSlot + 2 * k + 1] = lo;
    };
    pack(A, 0); pack(B, 1); pack(C, 2); pack(D, 3);
    nodeSlot += 1;
  }
  return out;
}
