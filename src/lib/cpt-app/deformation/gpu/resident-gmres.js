// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Resident GPU restarted GMRES (DS, no handoffs).
// ============================================================================
//
// All Krylov vectors V_1, ..., V_{m+1} (each of length N, DS-packed) live on
// GPU buffers from solve start to solve end.  The Arnoldi process runs on
// GPU; the upper-Hessenberg matrix H ((m+1) × m) and Givens rotations run on
// CPU as f64 because they are tiny (~30 × 30 = 7 KB).
//
// Mathematical structure (right-preconditioned restarted GMRES with modified
// Gram-Schmidt, Saad "Iterative Methods for Sparse Linear Systems" §6.5):
//
//     Initial:  r_0 = b - A x_0
//               beta = ||r_0||
//               v_1 = r_0 / beta
//               g[0] = beta, g[1..m] = 0
//
//     For j = 1, 2, ..., m:
//         w = A v_j                   (one matvec)
//         For i = 1, ..., j:
//             h_ij = v_i · w           (one DS dot)
//             w = w - h_ij v_i         (one DS axpy)
//         h_{j+1,j} = ||w||
//         v_{j+1} = w / h_{j+1,j}
//         Apply previous Givens rotations to column j of H
//         Compute new Givens for (h_{j,j}, h_{j+1,j}) and apply
//         |g[j+1]| is the current residual estimate
//         If |g[j+1]| < tol: break
//
//     Solve upper-triangular H y = g (back-substitution, CPU)
//     x = x_0 + Σ y_j v_j
//
// Restart: x_0 ← x, repeat.
//
// Per inner iteration j: j+1 readbacks (j dots + 1 norm).  For m = 30:
// O(m²) total readbacks per restart = 480 × 8 B = ~4 KB.  Negligible.

import {
  KERNEL_AXPY_WGSL,
  KERNEL_AXPBY_WGSL,
  KERNEL_SCALE_WGSL,
  KERNEL_COPY_WGSL,
  KERNEL_DOT_PASS1_WGSL,
  KERNEL_DOT_PASS2_WGSL,
  KERNEL_CSR_MATVEC_WGSL,
  KERNEL_BLOCK_JACOBI_WGSL,
  cpuRefAxpy,
  cpuRefAxpby,
  cpuRefDot,
  cpuRefCsrMatvec,
  cpuRefBlockJacobi,
  liftF64,
  lowerDs
} from './wgsl/blas.js';

import {
  packDsVector,
  unpackDsVector
} from './resident-buffers.js';

import { dsFromF64, dsToF64, dsAdd, dsMul } from './wgsl/ds.js';

const WG_SIZE = 64;

// =============================================================================
// CPU reference implementation of restarted GMRES with the same dispatch
// shape as the resident GPU version.  This is the canonical algorithm we
// will use to drive parity tests against the GPU once a runtime is bound.
// =============================================================================

export function cpuReferenceResidentGmres({ csr, blockJacobiDs, bF64, x0F64 = null, maxIter = 1000, relTol = 1e-8, absTol = 1e-12, restart = 30 }) {
  const N = bF64.length;
  const m = Math.max(Math.min(restart | 0, maxIter), 1);
  const bDs = liftF64(bF64);
  let xDs = liftF64(x0F64 || new Float64Array(N));

  const rhsNormSq = dsToF64(cpuRefDot(bDs, bDs));
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const targetTol = Math.max(absTol, relTol * rhsNorm);

  let totalIters = 0;
  let lastResidualNorm = 0;

  while (totalIters < maxIter) {
    // r_0 = b - A x  (or = b when x = 0)
    let rDs;
    if (totalIters > 0 || (x0F64 && x0F64.some((v) => v !== 0))) {
      const Ax = cpuRefCsrMatvec(csr, xDs);
      rDs = bDs.map((v, i) => dsAdd(v, [-Ax[i][0], -Ax[i][1]]));
    } else {
      rDs = bDs.map((v) => [v[0], v[1]]);
    }

    // Apply right preconditioner to the residual: z_0 = M^-1 r_0.
    // Right preconditioning: solve A M^-1 (M x) = b.  Equivalent left form
    // here: we work with the preconditioned residual.  Using left
    // preconditioning is simpler in code: z = M^-1 r and Krylov subspace is
    // K_m(M^-1 A, z).
    let zDs = cpuRefBlockJacobi(blockJacobiDs, rDs);
    const beta0Sq = dsToF64(cpuRefDot(zDs, zDs));
    const beta0 = Math.sqrt(Math.max(beta0Sq, 0));
    if (beta0 <= targetTol) {
      lastResidualNorm = beta0;
      return { solution: lowerDs(xDs), iterations: totalIters, residualNorm: lastResidualNorm, converged: true };
    }

    // Allocate Krylov basis V (m+1 vectors of length N) and small CPU H, g, c, s.
    const V = new Array(m + 1);
    V[0] = zDs.map((v) => {
      const f = 1 / beta0;
      return [Math.fround(v[0] * f), Math.fround(v[1] * f + (v[0] * f - Math.fround(v[0] * f)))];
    });
    const H = Array.from({ length: m + 1 }, () => new Float64Array(m));
    const g = new Float64Array(m + 1);
    g[0] = beta0;
    const c = new Float64Array(m);
    const s = new Float64Array(m);

    let innerIters = 0;
    let breakReason = 'maxinner';

    for (let j = 0; j < m && totalIters + 1 <= maxIter; j += 1) {
      innerIters = j + 1;
      totalIters += 1;
      // w = M^-1 A v_j  (left preconditioning)
      const Avj = cpuRefCsrMatvec(csr, V[j]);
      let w = cpuRefBlockJacobi(blockJacobiDs, Avj);
      // Modified Gram-Schmidt against V[0..j].
      for (let i = 0; i <= j; i += 1) {
        const hij = dsToF64(cpuRefDot(V[i], w));
        H[i][j] = hij;
        // w = w - hij V[i]
        cpuRefAxpy(dsFromF64(-hij), V[i], w);
      }
      const wNormSq = dsToF64(cpuRefDot(w, w));
      const wNorm = Math.sqrt(Math.max(wNormSq, 0));
      H[j + 1][j] = wNorm;
      // v_{j+1} = w / wNorm  (unless wNorm ~ 0, "happy breakdown")
      if (wNorm > 1e-300) {
        V[j + 1] = w.map((v) => {
          const f = 1 / wNorm;
          return [Math.fround(v[0] * f), Math.fround(v[1] * f + (v[0] * f - Math.fround(v[0] * f)))];
        });
      } else {
        V[j + 1] = w.map(() => [0, 0]);
      }

      // Apply previous Givens rotations to column j of H.
      for (let i = 0; i < j; i += 1) {
        const tmp = c[i] * H[i][j] + s[i] * H[i + 1][j];
        H[i + 1][j] = -s[i] * H[i][j] + c[i] * H[i + 1][j];
        H[i][j] = tmp;
      }
      // Compute new Givens for (H[j][j], H[j+1][j]).
      const hj = H[j][j];
      const hjp = H[j + 1][j];
      const denom = Math.hypot(hj, hjp);
      if (denom > 0) {
        c[j] = hj / denom;
        s[j] = hjp / denom;
      } else {
        c[j] = 1; s[j] = 0;
      }
      H[j][j] = c[j] * hj + s[j] * hjp;
      H[j + 1][j] = 0;
      // Update g.
      const gj = c[j] * g[j];
      g[j + 1] = -s[j] * g[j];
      g[j] = gj;
      lastResidualNorm = Math.abs(g[j + 1]);
      if (lastResidualNorm <= targetTol) {
        breakReason = 'tolerance';
        break;
      }
    }

    // Solve upper-triangular H y = g (size innerIters) and update x.
    const yk = new Float64Array(innerIters);
    for (let i = innerIters - 1; i >= 0; i -= 1) {
      let sum = g[i];
      for (let kj = i + 1; kj < innerIters; kj += 1) {
        sum -= H[i][kj] * yk[kj];
      }
      yk[i] = H[i][i] !== 0 ? sum / H[i][i] : 0;
    }
    // x = x_0 + Σ_{j=0}^{innerIters-1} yk[j] V[j]
    for (let j = 0; j < innerIters; j += 1) {
      cpuRefAxpy(dsFromF64(yk[j]), V[j], xDs);
    }

    if (breakReason === 'tolerance') {
      return { solution: lowerDs(xDs), iterations: totalIters, residualNorm: lastResidualNorm, converged: true };
    }
    if (totalIters >= maxIter) break;
  }
  return { solution: lowerDs(xDs), iterations: totalIters, residualNorm: lastResidualNorm, converged: false };
}

// =============================================================================
// GPU resident GMRES is structurally identical to the CPU reference above.
// The only differences are:
//
//  - V_j are stored as DS-vector GPU buffers; allocated once, indexed by j.
//  - matvec and Gram-Schmidt happen via WGSL kernel dispatches.
//  - h_ij and ||w|| readbacks cross to CPU each inner iteration (small, fast).
//  - H, c, s, g stay on CPU (tiny).
//  - Final x update uses dispatchAxpy(yk[j], V[j], x) per j.
//
// Because the runtime layer (`resident-cg.js`) already exposes pipeline
// compilation, bind-group helpers and bind-binding helpers, the GMRES
// runtime can be assembled from the same building blocks.  See
// `resident-gmres-runtime.js` (Phase 5b — wired in Phase 8) for the
// device-bound version.  This module ships:
//
//  1. The CPU reference algorithm (above), used for parity tests.
//  2. A `dispatchPlanResidentGmres()` that returns a structured description
//     of the per-inner-iteration kernel sequence the device-bound runtime
//     must execute.  Externalising the dispatch plan lets the runtime layer
//     reuse a single kernel-cache and lets the parity suite verify the
//     plan without spinning up a real GPU.
// =============================================================================

// =============================================================================
// Device-bound resident GMRES runtime.
//
// Allocation contract:
//   - One DS vector buffer per Krylov basis vector V[0..m]; length = N.
//   - One DS-CSR matrix triple uploaded once via uploadDsCsr.
//   - One DS block-Jacobi inverse uploaded via uploadBlockJacobi.
//   - One DS scratch vector `w` for the Arnoldi work vector.
//   - Two DS scratch vectors `Ap`/`zScratch` for matvec + preconditioner.
//   - One DS-vector buffer `x` (solution).
//   - One DS-vector buffer `b` (right-hand side).
//   - One DS-vector buffer `r` (residual at restart).
//   - Reduction scratch (dotPartials, dotResult, readback) shared per-restart.
//
// Per inner iteration, the runtime issues:
//   - 1 csr-matvec      (V[j] → Ap)
//   - 1 block-jacobi     (Ap → w)
//   - j+1 dot kernels    (V[i] · w  for MGS)
//   - j+1 axpy kernels   (w -= h_ij V[i])
//   - 1 dot kernel       (||w||²)
//   - 1 scale kernel     (V[j+1] = w / ||w||)
//
// All scalar readbacks (h_ij, ||w||) cross to CPU and feed the Hessenberg
// matrix and Givens rotations on CPU.
// =============================================================================

const WG_SIZE_GMRES = 64;

function ensurePipelineCacheGmres(device) {
  if (!device.__residentDsPipelinesGmres) {
    device.__residentDsPipelinesGmres = new Map();
  }
  return device.__residentDsPipelinesGmres;
}

function GPUShaderStage_COMPUTE_g() {
  /* global GPUShaderStage */
  return typeof GPUShaderStage !== 'undefined' ? GPUShaderStage.COMPUTE : 0x4;
}

function getOrCompilePipelineG(device, key, wgsl, bgLayoutDesc) {
  const cache = ensurePipelineCacheGmres(device);
  if (cache.has(key)) return cache.get(key);
  const stage = GPUShaderStage_COMPUTE_g();
  const desc = {
    entries: bgLayoutDesc.entries.map((e) => ({
      binding: e.binding,
      visibility: stage,
      buffer: { type: e.type === 'uniform' ? 'uniform' : (e.type === 'read-only-storage' ? 'read-only-storage' : 'storage') }
    }))
  };
  const module = device.createShaderModule({ code: wgsl });
  const bgLayout = device.createBindGroupLayout(desc);
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bgLayout] });
  const pipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: 'main' } });
  const entry = { pipeline, bgLayout };
  cache.set(key, entry);
  return entry;
}

const BGL_AXPY_G = { entries: [
  { binding: 0, type: 'read-only-storage' },
  { binding: 1, type: 'storage' },
  { binding: 2, type: 'uniform' }
]};
const BGL_SCALE_G = { entries: [
  { binding: 0, type: 'storage' },
  { binding: 1, type: 'uniform' }
]};
const BGL_COPY_G = { entries: [
  { binding: 0, type: 'read-only-storage' },
  { binding: 1, type: 'storage' },
  { binding: 2, type: 'uniform' }
]};
const BGL_DOT1_G = { entries: [
  { binding: 0, type: 'read-only-storage' },
  { binding: 1, type: 'read-only-storage' },
  { binding: 2, type: 'storage' },
  { binding: 3, type: 'uniform' }
]};
const BGL_DOT2_G = { entries: [
  { binding: 0, type: 'read-only-storage' },
  { binding: 1, type: 'storage' },
  { binding: 2, type: 'uniform' }
]};
const BGL_CSR_G = { entries: [
  { binding: 0, type: 'read-only-storage' },
  { binding: 1, type: 'read-only-storage' },
  { binding: 2, type: 'read-only-storage' },
  { binding: 3, type: 'read-only-storage' },
  { binding: 4, type: 'read-only-storage' },
  { binding: 5, type: 'storage' },
  { binding: 6, type: 'uniform' }
]};
const BGL_BJ_G = { entries: [
  { binding: 0, type: 'read-only-storage' },
  { binding: 1, type: 'read-only-storage' },
  { binding: 2, type: 'storage' },
  { binding: 3, type: 'uniform' }
]};

export function createResidentGmresContext({ device, ndof, numNonzeros, restart = 30 }) {
  const N = ndof | 0;
  const m = Math.max(restart | 0, 1);
  const numWgBlas = Math.ceil(N / WG_SIZE_GMRES);
  const numNodes = Math.ceil(N / 2);
  const numWgBj = Math.ceil(numNodes / WG_SIZE_GMRES);
  const dsVecBytes = 8 * N;
  const partialsBytes = 8 * Math.max(numWgBlas, 1);

  const usageStorage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const usageStorageDst = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;

  // Allocate Krylov basis (m+1 vectors).
  const V = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) {
    V[j] = device.createBuffer({ size: dsVecBytes, usage: usageStorage });
  }

  const buffers = {
    V,
    x: device.createBuffer({ size: dsVecBytes, usage: usageStorage }),
    b: device.createBuffer({ size: dsVecBytes, usage: usageStorageDst }),
    r: device.createBuffer({ size: dsVecBytes, usage: usageStorage }),
    w: device.createBuffer({ size: dsVecBytes, usage: usageStorage }),
    Ap: device.createBuffer({ size: dsVecBytes, usage: usageStorage }),
    z: device.createBuffer({ size: dsVecBytes, usage: usageStorage }),
    rowPtr: device.createBuffer({ size: 4 * (N + 1), usage: usageStorageDst }),
    colInd: device.createBuffer({ size: 4 * numNonzeros, usage: usageStorageDst }),
    valHi:  device.createBuffer({ size: 4 * numNonzeros, usage: usageStorageDst }),
    valLo:  device.createBuffer({ size: 4 * numNonzeros, usage: usageStorageDst }),
    blockJacobi: device.createBuffer({ size: 32 * numNodes, usage: usageStorageDst }),
    paramsAxpy:  device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsScale: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsCopy:  device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsDot:   device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsDotP2: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsCsr:   device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsBj:    device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    dotPartials: device.createBuffer({ size: partialsBytes, usage: GPUBufferUsage.STORAGE }),
    dotResult:   device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    readback:    device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  };

  const pipelines = {
    axpy:    getOrCompilePipelineG(device, 'gmres-axpy',     KERNEL_AXPY_WGSL,        BGL_AXPY_G),
    scale:   getOrCompilePipelineG(device, 'gmres-scale',    KERNEL_SCALE_WGSL,       BGL_SCALE_G),
    copy:    getOrCompilePipelineG(device, 'gmres-copy',     KERNEL_COPY_WGSL,        BGL_COPY_G),
    dot1:    getOrCompilePipelineG(device, 'gmres-dot1',     KERNEL_DOT_PASS1_WGSL,   BGL_DOT1_G),
    dot2:    getOrCompilePipelineG(device, 'gmres-dot2',     KERNEL_DOT_PASS2_WGSL,   BGL_DOT2_G),
    matvec:  getOrCompilePipelineG(device, 'gmres-matvec',   KERNEL_CSR_MATVEC_WGSL,  BGL_CSR_G),
    bj:      getOrCompilePipelineG(device, 'gmres-bj',       KERNEL_BLOCK_JACOBI_WGSL,BGL_BJ_G)
  };

  return {
    device, N, numNodes, numWgBlas, numWgBj, m, restart: m, numNonzeros, buffers, pipelines
  };
}

export function uploadGmresVector(ctx, name, f64) {
  ctx.device.queue.writeBuffer(ctx.buffers[name], 0, packDsVector(f64));
}

export function uploadGmresCsr(ctx, csrPacked) {
  ctx.device.queue.writeBuffer(ctx.buffers.rowPtr, 0, csrPacked.rowPtr);
  ctx.device.queue.writeBuffer(ctx.buffers.colInd, 0, csrPacked.colInd);
  ctx.device.queue.writeBuffer(ctx.buffers.valHi,  0, csrPacked.valHi);
  ctx.device.queue.writeBuffer(ctx.buffers.valLo,  0, csrPacked.valLo);
}

export function uploadGmresBlockJacobi(ctx, packed) {
  ctx.device.queue.writeBuffer(ctx.buffers.blockJacobi, 0, packed);
}

function bgG(device, layout, entries) {
  return device.createBindGroup({ layout, entries });
}

function bgEntryG(binding, buffer) { return { binding, resource: { buffer } }; }

function dispGmresAxpy(ctx, encoder, alphaDs, srcBuf, dstBuf) {
  const u = new ArrayBuffer(32);
  new Float32Array(u, 0, 2).set(alphaDs);
  new Uint32Array(u, 8, 1).set([ctx.N]);
  ctx.device.queue.writeBuffer(ctx.buffers.paramsAxpy, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(ctx.pipelines.axpy.pipeline);
  pass.setBindGroup(0, bgG(ctx.device, ctx.pipelines.axpy.bgLayout, [
    bgEntryG(0, srcBuf), bgEntryG(1, dstBuf), bgEntryG(2, ctx.buffers.paramsAxpy)
  ]));
  pass.dispatchWorkgroups(ctx.numWgBlas);
  pass.end();
}

function dispGmresScale(ctx, encoder, alphaDs, buf) {
  const u = new ArrayBuffer(32);
  new Float32Array(u, 0, 2).set(alphaDs);
  new Uint32Array(u, 8, 1).set([ctx.N]);
  ctx.device.queue.writeBuffer(ctx.buffers.paramsScale, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(ctx.pipelines.scale.pipeline);
  pass.setBindGroup(0, bgG(ctx.device, ctx.pipelines.scale.bgLayout, [
    bgEntryG(0, buf), bgEntryG(1, ctx.buffers.paramsScale)
  ]));
  pass.dispatchWorkgroups(ctx.numWgBlas);
  pass.end();
}

function dispGmresCopy(ctx, encoder, srcBuf, dstBuf) {
  const u = new ArrayBuffer(16);
  new Uint32Array(u, 0, 1).set([ctx.N]);
  ctx.device.queue.writeBuffer(ctx.buffers.paramsCopy, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(ctx.pipelines.copy.pipeline);
  pass.setBindGroup(0, bgG(ctx.device, ctx.pipelines.copy.bgLayout, [
    bgEntryG(0, srcBuf), bgEntryG(1, dstBuf), bgEntryG(2, ctx.buffers.paramsCopy)
  ]));
  pass.dispatchWorkgroups(ctx.numWgBlas);
  pass.end();
}

function dispGmresMatvec(ctx, encoder, srcBuf, dstBuf) {
  const u = new ArrayBuffer(16);
  new Uint32Array(u, 0, 1).set([ctx.N]);
  ctx.device.queue.writeBuffer(ctx.buffers.paramsCsr, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(ctx.pipelines.matvec.pipeline);
  pass.setBindGroup(0, bgG(ctx.device, ctx.pipelines.matvec.bgLayout, [
    bgEntryG(0, ctx.buffers.rowPtr), bgEntryG(1, ctx.buffers.colInd),
    bgEntryG(2, ctx.buffers.valHi),  bgEntryG(3, ctx.buffers.valLo),
    bgEntryG(4, srcBuf),             bgEntryG(5, dstBuf),
    bgEntryG(6, ctx.buffers.paramsCsr)
  ]));
  pass.dispatchWorkgroups(ctx.numWgBlas);
  pass.end();
}

function dispGmresBj(ctx, encoder, srcBuf, dstBuf) {
  const u = new ArrayBuffer(16);
  new Uint32Array(u, 0, 1).set([ctx.numNodes]);
  ctx.device.queue.writeBuffer(ctx.buffers.paramsBj, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(ctx.pipelines.bj.pipeline);
  pass.setBindGroup(0, bgG(ctx.device, ctx.pipelines.bj.bgLayout, [
    bgEntryG(0, ctx.buffers.blockJacobi), bgEntryG(1, srcBuf),
    bgEntryG(2, dstBuf),                  bgEntryG(3, ctx.buffers.paramsBj)
  ]));
  pass.dispatchWorkgroups(ctx.numWgBj);
  pass.end();
}

async function dispGmresDot(ctx, srcA, srcB) {
  const enc = ctx.device.createCommandEncoder();
  // Pass 1.
  const u1 = new ArrayBuffer(16);
  new Uint32Array(u1, 0, 1).set([ctx.N]);
  ctx.device.queue.writeBuffer(ctx.buffers.paramsDot, 0, u1);
  let pass = enc.beginComputePass();
  pass.setPipeline(ctx.pipelines.dot1.pipeline);
  pass.setBindGroup(0, bgG(ctx.device, ctx.pipelines.dot1.bgLayout, [
    bgEntryG(0, srcA), bgEntryG(1, srcB),
    bgEntryG(2, ctx.buffers.dotPartials), bgEntryG(3, ctx.buffers.paramsDot)
  ]));
  pass.dispatchWorkgroups(ctx.numWgBlas);
  pass.end();
  // Pass 2.
  const u2 = new ArrayBuffer(16);
  new Uint32Array(u2, 0, 1).set([ctx.numWgBlas]);
  ctx.device.queue.writeBuffer(ctx.buffers.paramsDotP2, 0, u2);
  pass = enc.beginComputePass();
  pass.setPipeline(ctx.pipelines.dot2.pipeline);
  pass.setBindGroup(0, bgG(ctx.device, ctx.pipelines.dot2.bgLayout, [
    bgEntryG(0, ctx.buffers.dotPartials), bgEntryG(1, ctx.buffers.dotResult),
    bgEntryG(2, ctx.buffers.paramsDotP2)
  ]));
  pass.dispatchWorkgroups(1);
  pass.end();
  enc.copyBufferToBuffer(ctx.buffers.dotResult, 0, ctx.buffers.readback, 0, 8);
  ctx.device.queue.submit([enc.finish()]);
  await ctx.buffers.readback.mapAsync(GPUMapMode.READ);
  const arr = new Float32Array(ctx.buffers.readback.getMappedRange().slice(0));
  ctx.buffers.readback.unmap();
  return arr[0] + arr[1];
}

// -----------------------------------------------------------------------------
// solveResidentGmres: device-bound restarted GMRES.
// -----------------------------------------------------------------------------
export async function solveResidentGmres(ctx, { bF64, x0F64 = null, maxIter = 1000, relTol = 1e-8, absTol = 1e-12 }) {
  const { device, N, m, buffers } = ctx;
  uploadGmresVector(ctx, 'b', bF64);
  uploadGmresVector(ctx, 'x', x0F64 || new Float64Array(N));

  const rhsNormSq = await dispGmresDot(ctx, buffers.b, buffers.b);
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const targetTol = Math.max(absTol, relTol * rhsNorm);

  let totalIters = 0;
  let lastResidualNorm = 0;

  while (totalIters < maxIter) {
    // r = b - A x  (or just b if x = 0).
    {
      const enc = device.createCommandEncoder();
      dispGmresMatvec(ctx, enc, buffers.x, buffers.Ap);
      dispGmresCopy(ctx, enc, buffers.b, buffers.r);
      dispGmresAxpy(ctx, enc, [-1, 0], buffers.Ap, buffers.r);
      device.queue.submit([enc.finish()]);
    }
    // z = M^-1 r,  beta = ||z||,  V[0] = z / beta
    {
      const enc = device.createCommandEncoder();
      dispGmresBj(ctx, enc, buffers.r, buffers.z);
      device.queue.submit([enc.finish()]);
    }
    const beta0Sq = await dispGmresDot(ctx, buffers.z, buffers.z);
    const beta0 = Math.sqrt(Math.max(beta0Sq, 0));
    if (beta0 <= targetTol) {
      lastResidualNorm = beta0;
      return finalizeGmres(ctx, totalIters, lastResidualNorm, rhsNorm, true);
    }
    {
      const enc = device.createCommandEncoder();
      dispGmresCopy(ctx, enc, buffers.z, buffers.V[0]);
      const inv = 1 / beta0;
      dispGmresScale(ctx, enc, dsFromF64(inv), buffers.V[0]);
      device.queue.submit([enc.finish()]);
    }

    const H = Array.from({ length: m + 1 }, () => new Float64Array(m));
    const g = new Float64Array(m + 1);
    g[0] = beta0;
    const cArr = new Float64Array(m);
    const sArr = new Float64Array(m);

    let innerIters = 0;
    let breakReason = 'maxinner';

    for (let j = 0; j < m && totalIters + 1 <= maxIter; j += 1) {
      innerIters = j + 1;
      totalIters += 1;
      // w = M^-1 A V[j]
      {
        const enc = device.createCommandEncoder();
        dispGmresMatvec(ctx, enc, buffers.V[j], buffers.Ap);
        dispGmresBj(ctx, enc, buffers.Ap, buffers.w);
        device.queue.submit([enc.finish()]);
      }
      // Modified Gram-Schmidt against V[0..j].
      for (let i = 0; i <= j; i += 1) {
        const hij = await dispGmresDot(ctx, buffers.V[i], buffers.w);
        H[i][j] = hij;
        const enc = device.createCommandEncoder();
        dispGmresAxpy(ctx, enc, dsFromF64(-hij), buffers.V[i], buffers.w);
        device.queue.submit([enc.finish()]);
      }
      const wNormSq = await dispGmresDot(ctx, buffers.w, buffers.w);
      const wNorm = Math.sqrt(Math.max(wNormSq, 0));
      H[j + 1][j] = wNorm;
      if (wNorm > 1e-300) {
        const enc = device.createCommandEncoder();
        dispGmresCopy(ctx, enc, buffers.w, buffers.V[j + 1]);
        dispGmresScale(ctx, enc, dsFromF64(1 / wNorm), buffers.V[j + 1]);
        device.queue.submit([enc.finish()]);
      }

      for (let i = 0; i < j; i += 1) {
        const tmp = cArr[i] * H[i][j] + sArr[i] * H[i + 1][j];
        H[i + 1][j] = -sArr[i] * H[i][j] + cArr[i] * H[i + 1][j];
        H[i][j] = tmp;
      }
      const hj = H[j][j];
      const hjp = H[j + 1][j];
      const denom = Math.hypot(hj, hjp);
      if (denom > 0) { cArr[j] = hj / denom; sArr[j] = hjp / denom; }
      else { cArr[j] = 1; sArr[j] = 0; }
      H[j][j] = cArr[j] * hj + sArr[j] * hjp;
      H[j + 1][j] = 0;
      const gj = cArr[j] * g[j];
      g[j + 1] = -sArr[j] * g[j];
      g[j] = gj;
      lastResidualNorm = Math.abs(g[j + 1]);
      if (lastResidualNorm <= targetTol) { breakReason = 'tolerance'; break; }
    }

    // Solve upper-triangular H y = g.
    const yk = new Float64Array(innerIters);
    for (let i = innerIters - 1; i >= 0; i -= 1) {
      let sum = g[i];
      for (let kj = i + 1; kj < innerIters; kj += 1) sum -= H[i][kj] * yk[kj];
      yk[i] = H[i][i] !== 0 ? sum / H[i][i] : 0;
    }
    // x += Σ yk[j] V[j]
    //
    // Each AXPY must be in its own encoder + submit because all calls share
    // the `paramsAxpy` uniform — within one encoder the writeBuffers run
    // first and the last alpha overwrites all earlier ones.  See
    // resident-cg.js for the same pattern fix.
    for (let j = 0; j < innerIters; j += 1) {
      const enc = device.createCommandEncoder();
      dispGmresAxpy(ctx, enc, dsFromF64(yk[j]), buffers.V[j], buffers.x);
      device.queue.submit([enc.finish()]);
    }

    if (breakReason === 'tolerance') {
      return finalizeGmres(ctx, totalIters, lastResidualNorm, rhsNorm, true);
    }
    if (totalIters >= maxIter) break;
  }
  return finalizeGmres(ctx, totalIters, lastResidualNorm, rhsNorm, false);
}

async function finalizeGmres(ctx, iterations, residualNorm, rhsNorm, converged) {
  const out = ctx.device.createBuffer({ size: 8 * ctx.N, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = ctx.device.createCommandEncoder();
  enc.copyBufferToBuffer(ctx.buffers.x, 0, out, 0, 8 * ctx.N);
  ctx.device.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const packed = new Float32Array(out.getMappedRange().slice(0));
  out.unmap();
  out.destroy();
  const solution = unpackDsVector(packed);
  return {
    solution, iterations, residualNorm,
    relativeResidual: rhsNorm > 0 ? residualNorm / rhsNorm : 0,
    rhsNorm, converged, path: 'gpu-resident-gmres'
  };
}

export function dispatchPlanResidentGmres({ N, m, restart }) {
  // For documentation and future tooling: enumerate the kernels each
  // restart cycle would invoke, in order, with the binding contract.
  // Returned as a list of { kernel, inputs, outputs, count } records.
  const plan = [
    { kernel: 'csr-matvec', inputs: ['x'], outputs: ['Ap'], count: 1, phase: 'r_0 = b - A x' },
    { kernel: 'axpy',       inputs: ['Ap'], outputs: ['r'], count: 1, phase: 'r := b - A x' },
    { kernel: 'block-jacobi',inputs: ['r'],  outputs: ['z'], count: 1, phase: 'z = M^-1 r' },
    { kernel: 'dot',        inputs: ['z', 'z'], outputs: ['scalar'], count: 1, phase: 'beta = ||z||' },
    { kernel: 'scale',      inputs: ['z'], outputs: ['V[0]'], count: 1, phase: 'v_1 = z / beta' },
    // Per inner iter j:
    { kernel: 'csr-matvec',  inputs: ['V[j]'], outputs: ['Ap'], count: m, phase: 'A v_j' },
    { kernel: 'block-jacobi',inputs: ['Ap'],   outputs: ['w'],  count: m, phase: 'w = M^-1 A v_j' },
    { kernel: 'dot',         inputs: ['V[i]', 'w'], outputs: ['scalar'], count: 'm*(m+1)/2', phase: 'h_{ij} = v_i · w (MGS)' },
    { kernel: 'axpy',        inputs: ['V[i]'], outputs: ['w'],  count: 'm*(m+1)/2', phase: 'w -= h_{ij} v_i' },
    { kernel: 'dot',         inputs: ['w', 'w'], outputs: ['scalar'], count: m, phase: 'h_{j+1,j} = ||w||' },
    { kernel: 'scale',       inputs: ['w'], outputs: ['V[j+1]'], count: m, phase: 'v_{j+1} = w / h_{j+1,j}' },
    // Once per restart, after Givens convergence test:
    { kernel: 'axpy',        inputs: ['V[j]'], outputs: ['x'], count: 'innerIters', phase: 'x += y_j v_j' }
  ];
  return { N, m, restart, plan };
}
