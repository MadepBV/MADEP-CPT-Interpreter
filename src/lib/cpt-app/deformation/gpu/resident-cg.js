// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// Resident GPU Conjugate Gradient (DS, no handoffs).
// ============================================================================
//
// All five iteration vectors (x, r, p, Ap, z) plus the DS-CSR matrix and
// block-Jacobi preconditioner live on GPU buffers from solve start to solve
// end.  The CG inner loop dispatches kernels sequentially and only reads
// back three scalars per iteration: rzNew, pAp, residualNorm. Total readback
// per iteration is 3 × 8 bytes = 24 bytes.
//
// Mathematical structure (Hestenes-Stiefel, classical preconditioned CG):
//
//     Initial:  r = b - A x_0       z = M^-1 r       p = z       rz = r·z
//     For iter = 1, 2, ...:
//         Ap = A p
//         alpha = rz / (p · Ap)                            <-- 2 readbacks
//         x = x + alpha p
//         r = r - alpha Ap
//         if ||r|| < tol: break                            <-- 1 readback
//         z = M^-1 r
//         rzNew = r · z
//         beta = rzNew / rz
//         p = z + beta p
//         rz = rzNew
//
// True-residual replacement: every TRUE_RESIDUAL_INTERVAL iterations, we
// recompute r = b - A x to clear accumulated DS rounding drift in the
// recurrence-updated r.  This keeps the residual estimate faithful to the
// actual b - A x, which matters when the iterate count grows past 100.
//
// This module is the JavaScript orchestrator: it owns the GPUBuffer handles,
// the bind-group construction, and the per-iteration kernel dispatch list.
// The actual numerical kernels live in `wgsl/blas.js`.

import {
  KERNEL_AXPY_WGSL,
  KERNEL_AXPBY_WGSL,
  KERNEL_SCALE_WGSL,
  KERNEL_COPY_WGSL,
  KERNEL_DOT_PASS1_WGSL,
  KERNEL_DOT_PASS2_WGSL,
  KERNEL_CSR_MATVEC_WGSL,
  KERNEL_BLOCK_JACOBI_WGSL,
  KERNEL_BUILD_BLOCK_JACOBI_FROM_CSR_WGSL
} from './wgsl/blas.js';

import {
  packDsVector,
  unpackDsVector,
  packDsCsr,
  packDsBlockJacobi,
  packDsScalar,
  unpackDsScalar
} from './resident-buffers.js';

import { dsFromF64, dsToF64, dsAdd, dsMul, dsRecip, dsDiv } from './wgsl/ds.js';

const WG_SIZE = 64;
const TRUE_RESIDUAL_INTERVAL = 25;

// -----------------------------------------------------------------------------
// Kernel registry: a single pipeline per kernel, lazily compiled on first
// use and cached on the GPUDevice instance.
// -----------------------------------------------------------------------------
function ensurePipelineCache(device) {
  if (!device.__residentDsPipelines) {
    device.__residentDsPipelines = new Map();
  }
  return device.__residentDsPipelines;
}

function getOrCompilePipeline(device, key, wgslSource, bindGroupLayoutDesc) {
  const cache = ensurePipelineCache(device);
  if (cache.has(key)) return cache.get(key);
  const module = device.createShaderModule({ code: wgslSource });
  const bgLayout = device.createBindGroupLayout(bindGroupLayoutDesc);
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bgLayout] });
  const pipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module, entryPoint: 'main' }
  });
  const entry = { pipeline, bgLayout };
  cache.set(key, entry);
  return entry;
}

// Bind-group layout descriptors.  Keep these in lock-step with the WGSL
// `@group(0) @binding(k)` declarations in `wgsl/blas.js`.
const BGL_AXPY = {
  entries: [
    { binding: 0, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'storage' } },
    { binding: 2, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'uniform' } }
  ]
};
const BGL_AXPBY = BGL_AXPY;
const BGL_SCALE = {
  entries: [
    { binding: 0, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'storage' } },
    { binding: 1, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'uniform' } }
  ]
};
const BGL_COPY = BGL_AXPY;
const BGL_DOT_PASS1 = {
  entries: [
    { binding: 0, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'storage' } },
    { binding: 3, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'uniform' } }
  ]
};
const BGL_DOT_PASS2 = {
  entries: [
    { binding: 0, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'storage' } },
    { binding: 2, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'uniform' } }
  ]
};
const BGL_CSR_MATVEC = {
  entries: [
    { binding: 0, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 3, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 4, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 5, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'storage' } },
    { binding: 6, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'uniform' } }
  ]
};
const BGL_BLOCK_JACOBI = {
  entries: [
    { binding: 0, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'storage' } },
    { binding: 3, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'uniform' } }
  ]
};
const BGL_BUILD_BLOCK_JACOBI = {
  entries: [
    { binding: 0, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 1, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 2, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 3, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 4, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'storage' } },
    { binding: 5, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'read-only-storage' } },
    { binding: 6, visibility: GPUShaderStage_COMPUTE(), buffer: { type: 'uniform' } }
  ]
};

// -----------------------------------------------------------------------------
// GPUShaderStage_COMPUTE() helper.  Direct reference to GPUShaderStage.COMPUTE
// would force this module to import the WebGPU enum at module-load time;
// hoisting through a function lets the module stay loadable in Node test
// runners where the WebGPU API is absent.
// -----------------------------------------------------------------------------
function GPUShaderStage_COMPUTE() {
  /* global GPUShaderStage */
  return typeof GPUShaderStage !== 'undefined' ? GPUShaderStage.COMPUTE : 0x4;
}

// -----------------------------------------------------------------------------
// Build a `ResidentCgContext`: one device-bound CG instance, ready to be
// reused across multiple solves with the same matrix shape.
//
// The context owns:
//   - five DS vector buffers (x, r, p, Ap, z) of length N
//   - one DS-CSR matrix triple (rowPtr / colInd / valHi / valLo)
//   - one block-Jacobi inverse buffer
//   - one DS-scalar uniform buffer per AXPY/AXPBY/SCALE invocation
//   - one DS-scalar reduction output buffer
//   - one DOT-pass-1 partials buffer (sized to numWorkgroups)
//   - one staging buffer for scalar readback (3 DS scalars = 24 bytes)
// -----------------------------------------------------------------------------
export function createResidentCgContext({ device, ndof, numNonzeros }) {
  const N = ndof | 0;
  const numWorkgroupsBlas = Math.ceil(N / WG_SIZE);
  const numNodes = Math.ceil(N / 2);
  const numWorkgroupsBj = Math.ceil(numNodes / WG_SIZE);

  const usage = (storage = false) => (
    GPUBufferUsage.STORAGE
    | (storage ? GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST : GPUBufferUsage.COPY_DST)
  );
  const dsVecBytes = 8 * N;
  const dsScalarBytes = 16;
  const partialsBytes = 8 * Math.max(numWorkgroupsBlas, 1);

  const buffers = {
    x:    device.createBuffer({ size: dsVecBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }),
    r:    device.createBuffer({ size: dsVecBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }),
    p:    device.createBuffer({ size: dsVecBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    Ap:   device.createBuffer({ size: dsVecBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    z:    device.createBuffer({ size: dsVecBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    b:    device.createBuffer({ size: dsVecBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    // DS-CSR.  Uploaded once per matrix.
    rowPtr: device.createBuffer({ size: 4 * (N + 1),    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    colInd: device.createBuffer({ size: 4 * numNonzeros, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    valHi:  device.createBuffer({ size: 4 * numNonzeros, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    valLo:  device.createBuffer({ size: 4 * numNonzeros, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    // Preconditioner output (built on device by KERNEL_BUILD_BLOCK_JACOBI).
    // COPY_SRC lets the orchestrator mirror the built BJ to a separate
    // gmresCtx.blockJacobi via device-to-device copy when GMRES is the
    // active inner solver — no host round-trip per Newton iter.
    blockJacobi: device.createBuffer({
      size: 32 * numNodes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
    }),
    // Per-pair-slot mask (1 = nodal pair → 2x2 inverse, 0 = cross-node →
    // scalar Jacobi).  Uploaded once per analysis from `pack.pairIsNodal`.
    pairIsNodal: device.createBuffer({ size: 4 * Math.max(numNodes, 1), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
    // Scalar uniforms reused across iterations (overwritten via writeBuffer).
    paramsAxpy:  device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsAxpby: device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsScale: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsCopy:  device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsDot:   device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsDotP2: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsCsr:   device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsBj:    device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    paramsBuildBj: device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    // Reduction scratch / outputs.
    dotPartials: device.createBuffer({ size: partialsBytes, usage: GPUBufferUsage.STORAGE }),
    dotResult:   device.createBuffer({ size: 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }),
    // Staging buffer for scalar readback.
    readback: device.createBuffer({ size: 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  };

  // Compile pipelines once.
  const pipelines = {
    axpy:    getOrCompilePipeline(device, 'cg-axpy',     KERNEL_AXPY_WGSL,        BGL_AXPY),
    axpby:   getOrCompilePipeline(device, 'cg-axpby',    KERNEL_AXPBY_WGSL,       BGL_AXPBY),
    scale:   getOrCompilePipeline(device, 'cg-scale',    KERNEL_SCALE_WGSL,       BGL_SCALE),
    copy:    getOrCompilePipeline(device, 'cg-copy',     KERNEL_COPY_WGSL,        BGL_COPY),
    dot1:    getOrCompilePipeline(device, 'cg-dot-pass1',KERNEL_DOT_PASS1_WGSL,   BGL_DOT_PASS1),
    dot2:    getOrCompilePipeline(device, 'cg-dot-pass2',KERNEL_DOT_PASS2_WGSL,   BGL_DOT_PASS2),
    matvec:  getOrCompilePipeline(device, 'cg-csr-matvec',KERNEL_CSR_MATVEC_WGSL, BGL_CSR_MATVEC),
    bj:      getOrCompilePipeline(device, 'cg-block-jacobi',KERNEL_BLOCK_JACOBI_WGSL, BGL_BLOCK_JACOBI),
    buildBj: getOrCompilePipeline(device, 'cg-build-block-jacobi-from-csr',
                                   KERNEL_BUILD_BLOCK_JACOBI_FROM_CSR_WGSL, BGL_BUILD_BLOCK_JACOBI)
  };

  return {
    device,
    N,
    numNodes,
    numWorkgroupsBlas,
    numWorkgroupsBj,
    numNonzeros,
    buffers,
    pipelines
  };
}

// -----------------------------------------------------------------------------
// Upload helpers.  Each takes a context and a typed array, and writes it to
// the appropriate GPUBuffer.  Synchronous from the JS perspective; the queue
// is flushed before any kernel that depends on it.
// -----------------------------------------------------------------------------
export function uploadDsVector(ctx, bufferName, f64arr) {
  const packed = packDsVector(f64arr);
  ctx.device.queue.writeBuffer(ctx.buffers[bufferName], 0, packed);
}

export function uploadDsCsr(ctx, csrPacked) {
  ctx.device.queue.writeBuffer(ctx.buffers.rowPtr, 0, csrPacked.rowPtr);
  ctx.device.queue.writeBuffer(ctx.buffers.colInd, 0, csrPacked.colInd);
  ctx.device.queue.writeBuffer(ctx.buffers.valHi,  0, csrPacked.valHi);
  ctx.device.queue.writeBuffer(ctx.buffers.valLo,  0, csrPacked.valLo);
}

export function uploadBlockJacobi(ctx, blocksDsPacked) {
  ctx.device.queue.writeBuffer(ctx.buffers.blockJacobi, 0, blocksDsPacked);
}

// Upload the precomputed nodal-vs-cross-node mask once per analysis.  After
// this, the on-device build-BJ kernel can run per Newton iter without any
// host round-trip to rebuild the preconditioner.
export function uploadPairIsNodal(ctx, pairIsNodalU32) {
  ctx.device.queue.writeBuffer(ctx.buffers.pairIsNodal, 0, pairIsNodalU32);
}

// -----------------------------------------------------------------------------
// Bind-group factories.  One per kernel; called per-iteration but the bind
// group itself is cheap to create (handles only).  Cached across iterations
// to avoid per-iter allocator pressure.
// -----------------------------------------------------------------------------
function bg(device, layout, entries) {
  return device.createBindGroup({ layout, entries });
}

function bgEntry(binding, buffer) {
  return { binding, resource: { buffer } };
}

// -----------------------------------------------------------------------------
// Per-iteration kernel dispatch helpers.  Each writes the DS-scalar uniform
// (alpha, beta) via writeBuffer just before recording the dispatch.
// -----------------------------------------------------------------------------
function dispatchAxpy(ctx, encoder, alphaDs, xName, yName) {
  const { device, N, numWorkgroupsBlas, pipelines, buffers } = ctx;
  // Uniform layout: alpha (vec2 f32, 8 B) + n (u32, 4 B) + 12 B padding to 32 B.
  const u = new ArrayBuffer(32);
  const fv = new Float32Array(u);
  const uv = new Uint32Array(u);
  fv[0] = alphaDs[0]; fv[1] = alphaDs[1]; uv[2] = N;
  device.queue.writeBuffer(buffers.paramsAxpy, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.axpy.pipeline);
  pass.setBindGroup(0, bg(device, pipelines.axpy.bgLayout, [
    bgEntry(0, buffers[xName]),
    bgEntry(1, buffers[yName]),
    bgEntry(2, buffers.paramsAxpy)
  ]));
  pass.dispatchWorkgroups(numWorkgroupsBlas);
  pass.end();
}

function dispatchAxpby(ctx, encoder, alphaDs, betaDs, xName, yName) {
  const { device, N, numWorkgroupsBlas, pipelines, buffers } = ctx;
  // Uniform layout: alpha (vec2) + beta (vec2) + n (u32) + 12 B pad = 48.
  const u = new ArrayBuffer(48);
  const fv = new Float32Array(u);
  const uv = new Uint32Array(u);
  fv[0] = alphaDs[0]; fv[1] = alphaDs[1];
  fv[2] = betaDs[0];  fv[3] = betaDs[1];
  uv[4] = N;
  device.queue.writeBuffer(buffers.paramsAxpby, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.axpby.pipeline);
  pass.setBindGroup(0, bg(device, pipelines.axpby.bgLayout, [
    bgEntry(0, buffers[xName]),
    bgEntry(1, buffers[yName]),
    bgEntry(2, buffers.paramsAxpby)
  ]));
  pass.dispatchWorkgroups(numWorkgroupsBlas);
  pass.end();
}

function dispatchMatvec(ctx, encoder, xName, yName) {
  const { device, N, numWorkgroupsBlas, pipelines, buffers } = ctx;
  const u = new ArrayBuffer(16);
  const uv = new Uint32Array(u);
  uv[0] = N;
  device.queue.writeBuffer(buffers.paramsCsr, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.matvec.pipeline);
  pass.setBindGroup(0, bg(device, pipelines.matvec.bgLayout, [
    bgEntry(0, buffers.rowPtr),
    bgEntry(1, buffers.colInd),
    bgEntry(2, buffers.valHi),
    bgEntry(3, buffers.valLo),
    bgEntry(4, buffers[xName]),
    bgEntry(5, buffers[yName]),
    bgEntry(6, buffers.paramsCsr)
  ]));
  pass.dispatchWorkgroups(numWorkgroupsBlas);
  pass.end();
}

function dispatchBlockJacobi(ctx, encoder, rName, zName) {
  const { device, numNodes, numWorkgroupsBj, pipelines, buffers } = ctx;
  const u = new ArrayBuffer(16);
  const uv = new Uint32Array(u);
  uv[0] = numNodes;
  device.queue.writeBuffer(buffers.paramsBj, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.bj.pipeline);
  pass.setBindGroup(0, bg(device, pipelines.bj.bgLayout, [
    bgEntry(0, buffers.blockJacobi),
    bgEntry(1, buffers[rName]),
    bgEntry(2, buffers[zName]),
    bgEntry(3, buffers.paramsBj)
  ]));
  pass.dispatchWorkgroups(numWorkgroupsBj);
  pass.end();
}

function dispatchDot(ctx, encoder, xName, yName) {
  const { device, N, numWorkgroupsBlas, pipelines, buffers } = ctx;
  const u = new ArrayBuffer(16);
  const uv = new Uint32Array(u);
  uv[0] = N;
  device.queue.writeBuffer(buffers.paramsDot, 0, u);
  // Pass 1.
  let pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.dot1.pipeline);
  pass.setBindGroup(0, bg(device, pipelines.dot1.bgLayout, [
    bgEntry(0, buffers[xName]),
    bgEntry(1, buffers[yName]),
    bgEntry(2, buffers.dotPartials),
    bgEntry(3, buffers.paramsDot)
  ]));
  pass.dispatchWorkgroups(numWorkgroupsBlas);
  pass.end();
  // Pass 2.
  const u2 = new ArrayBuffer(16);
  new Uint32Array(u2)[0] = numWorkgroupsBlas;
  device.queue.writeBuffer(buffers.paramsDotP2, 0, u2);
  pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.dot2.pipeline);
  pass.setBindGroup(0, bg(device, pipelines.dot2.bgLayout, [
    bgEntry(0, buffers.dotPartials),
    bgEntry(1, buffers.dotResult),
    bgEntry(2, buffers.paramsDotP2)
  ]));
  pass.dispatchWorkgroups(1);
  pass.end();
  // Stage to readback buffer.
  encoder.copyBufferToBuffer(buffers.dotResult, 0, buffers.readback, 0, 8);
}

async function readbackDsScalar(ctx) {
  const { device, buffers } = ctx;
  await buffers.readback.mapAsync(GPUMapMode.READ);
  const arr = new Float32Array(buffers.readback.getMappedRange().slice(0));
  buffers.readback.unmap();
  return arr[0] + arr[1];
}

// -----------------------------------------------------------------------------
// Resident CG.
//
// Parameters:
//   ctx           : ResidentCgContext from createResidentCgContext.
//   csr           : DS-CSR matrix (already uploaded via uploadDsCsr).
//   blockJacobi   : DS-block-Jacobi (already uploaded).
//   bF64          : Float64Array of length N with the right-hand side b.
//   x0F64         : optional Float64Array initial guess (else zeros).
//   maxIter, relTol, absTol : tolerance state.
//
// Returns:
//   { solution: Float64Array, iterations, residualNorm, converged }
// -----------------------------------------------------------------------------
export async function solveResidentCg(ctx, {
  bF64, x0F64 = null, maxIter = 25000, relTol = 1e-8, absTol = 1e-12, observer = null,
  // When `bAlreadyOnDevice === true`, the caller has already populated
  // ctx.buffers.b with the right-hand side via copyBufferToBuffer; we skip
  // the host→device upload and use whatever is on device.  Used by the
  // plastic Newton orchestrator to avoid CPU round-trips.
  bAlreadyOnDevice = false,
  // When `keepSolutionOnDevice === true`, skip the final readback of x to
  // CPU.  The caller can use ctx.buffers.x directly for downstream device
  // operations (e.g., line-search axpy).  Returns { solution: null, ... }.
  keepSolutionOnDevice = false
}) {
  const { device, N } = ctx;
  // Initial uploads.  Skip b if the caller has already placed it on device.
  if (!bAlreadyOnDevice) {
    uploadDsVector(ctx, 'b', bF64);
  }
  uploadDsVector(ctx, 'x', x0F64 || new Float64Array(N));

  const rhsNormSq = await computeDot(ctx, 'b', 'b');
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const targetTol = Math.max(absTol, relTol * rhsNorm);

  // r = b - A x  (in-place via a copy and a scaled subtract).
  // With x0 = 0 this simplifies to r = b.
  let initialResidualWithSubtract = false;
  if (x0F64 && x0F64.some((v) => v !== 0)) {
    initialResidualWithSubtract = true;
    const enc = device.createCommandEncoder();
    dispatchMatvec(ctx, enc, 'x', 'Ap');         // Ap = A x
    // r = b
    dispatchCopy(ctx, enc, 'b', 'r');
    // r = r - Ap   (axpy with alpha = -1)
    dispatchAxpy(ctx, enc, dsFromF64(-1), 'Ap', 'r');
    device.queue.submit([enc.finish()]);
  } else {
    const enc = device.createCommandEncoder();
    dispatchCopy(ctx, enc, 'b', 'r');
    device.queue.submit([enc.finish()]);
  }

  // z = M^-1 r,  p = z,  rz = r·z.
  {
    const enc = device.createCommandEncoder();
    dispatchBlockJacobi(ctx, enc, 'r', 'z');
    dispatchCopy(ctx, enc, 'z', 'p');
    device.queue.submit([enc.finish()]);
  }
  let rz = await computeDot(ctx, 'r', 'z');
  let residualNormSq = await computeDot(ctx, 'r', 'r');
  let residualNorm = Math.sqrt(Math.max(residualNormSq, 0));
  if (residualNorm <= targetTol) {
    return finalize(ctx, 0, residualNorm, rhsNorm, true, null, keepSolutionOnDevice);
  }

  for (let iter = 1; iter <= maxIter; iter += 1) {
    // Ap = A p
    {
      const enc = device.createCommandEncoder();
      dispatchMatvec(ctx, enc, 'p', 'Ap');
      device.queue.submit([enc.finish()]);
    }
    const pAp = await computeDot(ctx, 'p', 'Ap');
    if (!Number.isFinite(pAp) || Math.abs(pAp) < 1e-300) {
      return finalize(ctx, iter, residualNorm, rhsNorm, false, 'breakdown:pAp', keepSolutionOnDevice);
    }
    const alpha = rz / pAp;
    // x = x + alpha p,   r = r - alpha Ap
    //
    // CRITICAL: each AXPY must be in its own encoder + submit because both
    // calls share the same `paramsAxpy` uniform buffer.  Within one
    // encoder + submit, all `queue.writeBuffer` calls run before the compute
    // passes — the second writeBuffer overwrites the first, and BOTH passes
    // then read the SECOND alpha.  This previously sign-flipped x.  Splitting
    // into two submits ensures the uniform write and its dependent dispatch
    // execute atomically.
    {
      const enc = device.createCommandEncoder();
      dispatchAxpy(ctx, enc, dsFromF64(alpha), 'p', 'x');
      device.queue.submit([enc.finish()]);
    }
    {
      const enc = device.createCommandEncoder();
      dispatchAxpy(ctx, enc, dsFromF64(-alpha), 'Ap', 'r');
      device.queue.submit([enc.finish()]);
    }
    // True-residual replacement at intervals.
    if (iter % TRUE_RESIDUAL_INTERVAL === 0) {
      const enc = device.createCommandEncoder();
      dispatchMatvec(ctx, enc, 'x', 'Ap');
      dispatchCopy(ctx, enc, 'b', 'r');
      dispatchAxpy(ctx, enc, dsFromF64(-1), 'Ap', 'r');
      device.queue.submit([enc.finish()]);
    }
    residualNormSq = await computeDot(ctx, 'r', 'r');
    residualNorm = Math.sqrt(Math.max(residualNormSq, 0));
    if (observer && (iter === 1 || iter % 25 === 0)) {
      await observer({ iterations: iter, residualNorm, relativeResidual: rhsNorm > 0 ? residualNorm / rhsNorm : 0 });
    }
    if (residualNorm <= targetTol) {
      return finalize(ctx, iter, residualNorm, rhsNorm, true, null, keepSolutionOnDevice);
    }
    // z = M^-1 r,  rzNew = r·z,  beta = rzNew / rz,  p = z + beta p
    {
      const enc = device.createCommandEncoder();
      dispatchBlockJacobi(ctx, enc, 'r', 'z');
      device.queue.submit([enc.finish()]);
    }
    const rzNew = await computeDot(ctx, 'r', 'z');
    const beta = Math.abs(rz) > 1e-300 ? rzNew / rz : 0;
    {
      const enc = device.createCommandEncoder();
      dispatchAxpby(ctx, enc, dsFromF64(1), dsFromF64(beta), 'z', 'p');
      device.queue.submit([enc.finish()]);
    }
    rz = rzNew;
  }
  return finalize(ctx, maxIter, residualNorm, rhsNorm, false, 'maxiter', keepSolutionOnDevice);
}

function dispatchCopy(ctx, encoder, srcName, dstName) {
  const { device, N, numWorkgroupsBlas, pipelines, buffers } = ctx;
  const u = new ArrayBuffer(16);
  new Uint32Array(u)[0] = N;
  device.queue.writeBuffer(buffers.paramsCopy, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipelines.copy.pipeline);
  pass.setBindGroup(0, bg(device, pipelines.copy.bgLayout, [
    bgEntry(0, buffers[srcName]),
    bgEntry(1, buffers[dstName]),
    bgEntry(2, buffers.paramsCopy)
  ]));
  pass.dispatchWorkgroups(numWorkgroupsBlas);
  pass.end();
}

async function computeDot(ctx, xName, yName) {
  const enc = ctx.device.createCommandEncoder();
  dispatchDot(ctx, enc, xName, yName);
  ctx.device.queue.submit([enc.finish()]);
  return readbackDsScalar(ctx);
}

async function finalize(ctx, iterations, residualNorm, rhsNorm, converged, fallbackReason = null, keepSolutionOnDevice = false) {
  let solution = null;
  if (!keepSolutionOnDevice) {
    // Read x off the device.
    const dim = ctx.N;
    const out = ctx.device.createBuffer({ size: 8 * dim, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = ctx.device.createCommandEncoder();
    enc.copyBufferToBuffer(ctx.buffers.x, 0, out, 0, 8 * dim);
    ctx.device.queue.submit([enc.finish()]);
    await out.mapAsync(GPUMapMode.READ);
    const packed = new Float32Array(out.getMappedRange().slice(0));
    out.unmap();
    out.destroy();
    solution = unpackDsVector(packed);
  }
  return {
    solution,
    iterations,
    residualNorm,
    relativeResidual: rhsNorm > 0 ? residualNorm / rhsNorm : 0,
    rhsNorm,
    converged,
    interrupted: false,
    fallbackReason,
    path: 'gpu-resident-cg'
  };
}

// =============================================================================
// CPU reference implementation of the resident CG control flow.  Mirrors the
// kernel sequence above using DS arithmetic on plain arrays so the parity
// suite can compare iterate-by-iterate to confirm the GPU dispatch is doing
// the same math.  Used by Phase 10's verification framework.
// =============================================================================

import {
  cpuRefAxpy,
  cpuRefAxpby,
  cpuRefDot,
  cpuRefCsrMatvec,
  cpuRefBlockJacobi,
  liftF64,
  lowerDs
} from './wgsl/blas.js';

export function cpuReferenceResidentCg({ csr, blockJacobiDs, bF64, x0F64 = null, maxIter = 25000, relTol = 1e-8, absTol = 1e-12 }) {
  const N = bF64.length;
  const bDs = liftF64(bF64);
  let xDs = liftF64(x0F64 || new Float64Array(N));
  // r = b - A x
  let rDs;
  if (x0F64 && x0F64.some((v) => v !== 0)) {
    const Ax = cpuRefCsrMatvec(csr, xDs);
    rDs = bDs.map((v, i) => dsAdd(v, [-Ax[i][0], -Ax[i][1]]));
  } else {
    rDs = bDs.map((v) => [v[0], v[1]]);
  }
  let zDs = cpuRefBlockJacobi(blockJacobiDs, rDs);
  let pDs = zDs.map((v) => [v[0], v[1]]);
  const rhsNormSq = dsToF64(cpuRefDot(bDs, bDs));
  const rhsNorm = Math.sqrt(Math.max(rhsNormSq, 0));
  const targetTol = Math.max(absTol, relTol * rhsNorm);
  let rz = dsToF64(cpuRefDot(rDs, zDs));
  let residualNormSq = dsToF64(cpuRefDot(rDs, rDs));
  let residualNorm = Math.sqrt(Math.max(residualNormSq, 0));
  if (residualNorm <= targetTol) {
    return { solution: lowerDs(xDs), iterations: 0, residualNorm, converged: true };
  }
  for (let iter = 1; iter <= maxIter; iter += 1) {
    const ApDs = cpuRefCsrMatvec(csr, pDs);
    const pAp = dsToF64(cpuRefDot(pDs, ApDs));
    if (!Number.isFinite(pAp) || Math.abs(pAp) < 1e-300) {
      return { solution: lowerDs(xDs), iterations: iter, residualNorm, converged: false };
    }
    const alpha = rz / pAp;
    cpuRefAxpy(dsFromF64(alpha), pDs, xDs);
    cpuRefAxpy(dsFromF64(-alpha), ApDs, rDs);
    if (iter % TRUE_RESIDUAL_INTERVAL === 0) {
      const Ax2 = cpuRefCsrMatvec(csr, xDs);
      for (let i = 0; i < N; i += 1) {
        rDs[i] = dsAdd(bDs[i], [-Ax2[i][0], -Ax2[i][1]]);
      }
    }
    residualNormSq = dsToF64(cpuRefDot(rDs, rDs));
    residualNorm = Math.sqrt(Math.max(residualNormSq, 0));
    if (residualNorm <= targetTol) {
      return { solution: lowerDs(xDs), iterations: iter, residualNorm, converged: true };
    }
    zDs = cpuRefBlockJacobi(blockJacobiDs, rDs);
    const rzNew = dsToF64(cpuRefDot(rDs, zDs));
    const beta = Math.abs(rz) > 1e-300 ? rzNew / rz : 0;
    cpuRefAxpby(dsFromF64(1), zDs, dsFromF64(beta), pDs);
    // axpby with alpha=1 sets pDs[i] = 1*zDs[i] + beta*pDs[i] = zDs[i] + beta * pDs[i].
    // The cpuRefAxpby above uses the convention y = alpha x + beta y, so
    // calling it with x=zDs, y=pDs, alpha=1, beta=beta updates pDs in place
    // exactly as required.
    rz = rzNew;
  }
  return { solution: lowerDs(xDs), iterations: maxIter, residualNorm, converged: false };
}

// =============================================================================
// Public dispatch helpers for the plastic-Newton orchestrator.
//
// These let the orchestrator record device-side BLAS / preconditioner
// operations directly into its own command encoder, keeping data on the GPU
// across the entire Newton iteration (no host round-trips beyond the scalar
// norm readbacks for convergence checks).
// =============================================================================

// y = alpha * x + y (DS axpy).  External buffers (not necessarily owned by
// `ctx`).  Uses ctx's paramsAxpy uniform.
export function dispatchAxpyExternal(ctx, encoder, alphaDs, srcBuf, dstBuf) {
  const u = new ArrayBuffer(32);
  const fv = new Float32Array(u);
  fv[0] = alphaDs[0]; fv[1] = alphaDs[1];
  new Uint32Array(u, 8, 1)[0] = ctx.N;
  ctx.device.queue.writeBuffer(ctx.buffers.paramsAxpy, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(ctx.pipelines.axpy.pipeline);
  pass.setBindGroup(0, ctx.device.createBindGroup({
    layout: ctx.pipelines.axpy.bgLayout,
    entries: [
      { binding: 0, resource: { buffer: srcBuf } },
      { binding: 1, resource: { buffer: dstBuf } },
      { binding: 2, resource: { buffer: ctx.buffers.paramsAxpy } }
    ]
  }));
  pass.dispatchWorkgroups(ctx.numWorkgroupsBlas);
  pass.end();
}

// y = x  (DS copy).  External buffers.  Uses ctx's paramsCopy uniform.
export function dispatchCopyExternal(ctx, encoder, srcBuf, dstBuf) {
  const u = new ArrayBuffer(32);
  new Uint32Array(u, 0, 1)[0] = ctx.N;
  ctx.device.queue.writeBuffer(ctx.buffers.paramsCopy, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(ctx.pipelines.copy.pipeline);
  pass.setBindGroup(0, ctx.device.createBindGroup({
    layout: ctx.pipelines.copy.bgLayout,
    entries: [
      { binding: 0, resource: { buffer: srcBuf } },
      { binding: 1, resource: { buffer: dstBuf } },
      { binding: 2, resource: { buffer: ctx.buffers.paramsCopy } }
    ]
  }));
  pass.dispatchWorkgroups(ctx.numWorkgroupsBlas);
  pass.end();
}

// Build the block-Jacobi 2×2 inverse on device from the CSR currently in the
// CG context.  Output goes to ctx.buffers.blockJacobi.  After this call, the
// CG can run with the freshly-built preconditioner without any host round-trip.
//
// Reads `ctx.buffers.pairIsNodal` for the nodal-vs-cross-node mask
// (uploaded once via `uploadPairIsNodal` per analysis).
export function dispatchBuildBlockJacobiFromCsr(ctx, encoder) {
  const u = new ArrayBuffer(32);
  new Uint32Array(u, 0, 1)[0] = ctx.numNodes;
  new Uint32Array(u, 4, 1)[0] = ctx.N;
  ctx.device.queue.writeBuffer(ctx.buffers.paramsBuildBj, 0, u);
  const pass = encoder.beginComputePass();
  pass.setPipeline(ctx.pipelines.buildBj.pipeline);
  pass.setBindGroup(0, ctx.device.createBindGroup({
    layout: ctx.pipelines.buildBj.bgLayout,
    entries: [
      { binding: 0, resource: { buffer: ctx.buffers.rowPtr } },
      { binding: 1, resource: { buffer: ctx.buffers.colInd } },
      { binding: 2, resource: { buffer: ctx.buffers.valHi } },
      { binding: 3, resource: { buffer: ctx.buffers.valLo } },
      { binding: 4, resource: { buffer: ctx.buffers.blockJacobi } },
      { binding: 5, resource: { buffer: ctx.buffers.pairIsNodal } },
      { binding: 6, resource: { buffer: ctx.buffers.paramsBuildBj } }
    ]
  }));
  pass.dispatchWorkgroups(ctx.numWorkgroupsBj);
  pass.end();
}

// Compute ⟨a, b⟩ on device, return scalar f64.  Single readback (8 bytes).
export async function computeDotExternal(ctx, bufA, bufB) {
  const enc = ctx.device.createCommandEncoder();
  // Pass 1.
  {
    const u = new ArrayBuffer(32);
    new Uint32Array(u, 0, 1)[0] = ctx.N;
    ctx.device.queue.writeBuffer(ctx.buffers.paramsDot, 0, u);
    const pass = enc.beginComputePass();
    pass.setPipeline(ctx.pipelines.dot1.pipeline);
    pass.setBindGroup(0, ctx.device.createBindGroup({
      layout: ctx.pipelines.dot1.bgLayout,
      entries: [
        { binding: 0, resource: { buffer: bufA } },
        { binding: 1, resource: { buffer: bufB } },
        { binding: 2, resource: { buffer: ctx.buffers.dotPartials } },
        { binding: 3, resource: { buffer: ctx.buffers.paramsDot } }
      ]
    }));
    pass.dispatchWorkgroups(ctx.numWorkgroupsBlas);
    pass.end();
  }
  // Pass 2.
  {
    const u = new ArrayBuffer(32);
    new Uint32Array(u, 0, 1)[0] = ctx.numWorkgroupsBlas;
    ctx.device.queue.writeBuffer(ctx.buffers.paramsDotP2, 0, u);
    const pass = enc.beginComputePass();
    pass.setPipeline(ctx.pipelines.dot2.pipeline);
    pass.setBindGroup(0, ctx.device.createBindGroup({
      layout: ctx.pipelines.dot2.bgLayout,
      entries: [
        { binding: 0, resource: { buffer: ctx.buffers.dotPartials } },
        { binding: 1, resource: { buffer: ctx.buffers.dotResult } },
        { binding: 2, resource: { buffer: ctx.buffers.paramsDotP2 } }
      ]
    }));
    pass.dispatchWorkgroups(1);
    pass.end();
  }
  enc.copyBufferToBuffer(ctx.buffers.dotResult, 0, ctx.buffers.readback, 0, 8);
  ctx.device.queue.submit([enc.finish()]);
  await ctx.buffers.readback.mapAsync(GPUMapMode.READ);
  const arr = new Float32Array(ctx.buffers.readback.getMappedRange().slice(0));
  ctx.buffers.readback.unmap();
  return arr[0] + arr[1];
}
