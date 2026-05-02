// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GPU pipeline v2 — state allocator.
// =============================================================================
//
// Single source of truth for buffer + pipeline allocation in v2.  Builds a
// `ctx` object that owns:
//
//   - All static device buffers (B-matrices, gpWeights, dofMap, matParams,
//     matIndex, forceIncPtr/List, dPerGp).
//   - All mutable iteration buffers (u, r, p, Ap, z, b, diag, mInv,
//     elemScatter, sigmaCommitted, sigmaTrial, sigmaReturned, branchKind,
//     deltaEps, status flag).
//   - For BiCGStab: rhat, v, s, t, y, z auxiliary vectors.
//   - For block-Jacobi: kElem scratch, blocks (4 DS per node-pair),
//     freeToPair / freeIsSecond / freeMate maps.
//   - All compute pipelines (mfKx, mfDiag, mfRecip, mfApplyJacobi,
//     mfBuildD, mfTrialStress, mfBlockBuild, mfBlockInvert,
//     mfBlockApply, mfResidFromFint, mfConvergeFlag, mfResetStatus,
//     plus reused v1 BLAS + element kernels).
//   - All small parameter buffers (axpy 32B, axpby 48B, scalar 16B params, etc.).
//
// One single command-buffer-friendly schema; nothing here issues dispatches
// — that's `gpu-v2-dispatch.js`.  Iterative solvers (CG, BiCGStab) and
// outer drivers (Newton) consume the ctx via the dispatch primitives.
//
// All scalars are DS (vec2<f32>, hi+lo) for f64-equivalent precision per
// the `wgsl/ds.js` primitives v1 already uses.

import { buildGpuMeshPack } from '../gpu-mesh-pack.js';
import {
  packDsVector, packDsScalar, dsVectorBytes, DS_SCALAR_BYTES
} from '../resident-buffers.js';
import { dsFromF64 } from '../wgsl/ds.js';
import { KERNEL_COPY_WGSL } from '../wgsl/blas.js';
import {
  KERNEL_STRAIN_T3_WGSL, KERNEL_STRAIN_T6_WGSL,
  KERNEL_INTERNAL_FORCE_T3_WGSL, KERNEL_INTERNAL_FORCE_T6_WGSL,
  KERNEL_SCATTER_FREE_RHS_WGSL, SCATTER_FREE_RHS_LAYOUT
} from '../wgsl/elements.js';
import { KERNEL_MC_RETURN_WGSL, MC_BIND_GROUP_LAYOUT } from '../wgsl/mc-plastic.js';
import {
  KERNEL_MF_KX_T3_WGSL, KERNEL_MF_KX_T6_WGSL,
  KERNEL_MF_KX_T3_TANGENT_WGSL, KERNEL_MF_KX_T6_TANGENT_WGSL,
  MF_KX_LAYOUT
} from './wgsl-v2/mf-kx-element.js';
import {
  KERNEL_MF_DIAG_T3_WGSL, KERNEL_MF_DIAG_T6_WGSL,
  KERNEL_MF_DIAG_T3_TANGENT_WGSL, KERNEL_MF_DIAG_T6_TANGENT_WGSL,
  MF_DIAG_LAYOUT,
  KERNEL_MF_RECIP_WGSL, MF_RECIP_LAYOUT
} from './wgsl-v2/mf-jacobi-diag.js';
import { KERNEL_MF_ELASTIC_D_WGSL, MF_ELASTIC_D_LAYOUT } from './wgsl-v2/mf-elastic-d.js';
import { KERNEL_MF_APPLY_JACOBI_WGSL, MF_APPLY_JACOBI_LAYOUT } from './wgsl-v2/mf-apply-jacobi.js';
import { KERNEL_MF_TRIAL_STRESS_WGSL, MF_TRIAL_STRESS_LAYOUT } from './wgsl-v2/mf-trial-stress.js';
import {
  KERNEL_MF_BLOCK_BUILD_T3_WGSL, KERNEL_MF_BLOCK_BUILD_T6_WGSL,
  KERNEL_MF_BLOCK_BUILD_T3_TANGENT_WGSL, KERNEL_MF_BLOCK_BUILD_T6_TANGENT_WGSL,
  MF_BLOCK_BUILD_LAYOUT,
  KERNEL_MF_BLOCK_DIAG_FROM_KELEM_T3_WGSL, KERNEL_MF_BLOCK_DIAG_FROM_KELEM_T6_WGSL,
  MF_BLOCK_DIAG_FROM_KELEM_LAYOUT,
  KERNEL_MF_BLOCK_JACOBI_INVERT_WGSL, MF_BLOCK_JACOBI_INVERT_LAYOUT,
  KERNEL_MF_BLOCK_JACOBI_APPLY_WGSL, MF_BLOCK_JACOBI_APPLY_LAYOUT
} from './wgsl-v2/mf-block-jacobi.js';
import {
  KERNEL_MF_RESID_FROM_FINT_WGSL, MF_RESID_FROM_FINT_LAYOUT,
  KERNEL_MF_MC_STATS_WGSL, MF_MC_STATS_LAYOUT,
  KERNEL_MF_MC_STATS_FINAL_WGSL, MF_MC_STATS_FINAL_LAYOUT,
  KERNEL_MF_CONVERGE_FLAG_WGSL, MF_CONVERGE_FLAG_LAYOUT,
  KERNEL_MF_RESET_STATUS_WGSL, MF_RESET_STATUS_LAYOUT
} from './wgsl-v2/mf-residual-and-flag.js';
import {
  KERNEL_MF_STRESS_VOIGT6_TO_VOIGT3_WGSL, MF_STRESS_VOIGT6_TO_VOIGT3_LAYOUT
} from './wgsl-v2/mf-stress-slice.js';
import {
  KERNEL_MF_AXPY_WGSL, KERNEL_MF_AXPBY_WGSL,
  KERNEL_MF_DOT_PASS1_WGSL, KERNEL_MF_DOT_PASS2_WGSL,
  MF_AXPY_LAYOUT, MF_AXPBY_LAYOUT, MF_DOT_PASS1_LAYOUT, MF_DOT_PASS2_LAYOUT
} from './wgsl-v2/mf-blas.js';

export const WG = 64;
export const D_PACK = 6;
export const VOIGT6 = 6;
export const STRAIN_DIM = 3;

const GPU_STAGE_C = () => (typeof GPUShaderStage !== 'undefined' ? GPUShaderStage.COMPUTE : 0x4);
const USAGE = (n) => (typeof GPUBufferUsage !== 'undefined' ? GPUBufferUsage[n] : 0);

const BGL_AXPY = MF_AXPY_LAYOUT;
const BGL_AXPBY = MF_AXPBY_LAYOUT;
const BGL_DOT_PASS1 = MF_DOT_PASS1_LAYOUT;
const BGL_DOT_PASS2 = MF_DOT_PASS2_LAYOUT;
const BGL_COPY = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'storage' },
    { binding: 2, type: 'uniform' }
  ]
};
const BGL_INTERNAL_FORCE = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'read-only-storage' },
    { binding: 3, type: 'storage' },
    { binding: 4, type: 'uniform' }
  ]
};
const BGL_STRAIN = {
  entries: [
    { binding: 0, type: 'read-only-storage' },
    { binding: 1, type: 'read-only-storage' },
    { binding: 2, type: 'read-only-storage' },
    { binding: 3, type: 'storage' },
    { binding: 4, type: 'uniform' }
  ]
};

function buildLayout(device, descriptor) {
  const visibility = GPU_STAGE_C();
  return device.createBindGroupLayout({
    entries: descriptor.entries.map((e) => ({
      binding: e.binding,
      visibility,
      buffer: { type: e.type }
    }))
  });
}

// Build a (pipeline, bgLayout) pair lazily.  See `lazyPipeline` below.
function compileNow(device, key, wgsl, layoutDescriptor) {
  const bgLayout = buildLayout(device, layoutDescriptor);
  const module = device.createShaderModule({ code: wgsl });
  if (typeof module.getCompilationInfo === 'function') {
    module.getCompilationInfo().then((info) => {
      for (const m of info?.messages || []) {
        const tag = m.type === 'error' ? 'ERROR' : (m.type === 'warning' ? 'WARN' : 'info');
        console.warn(`[v2-wgsl ${key}] ${tag} L${m.lineNum}:${m.linePos}  ${m.message}`);
      }
    }).catch(() => {});
  }
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgLayout] }),
    compute: { module, entryPoint: 'main' }
  });
  return { pipeline, bgLayout };
}

// Lazy pipeline factory.  Stores (key, wgsl, layoutDescriptor) and only
// compiles + caches on first .resolve() call.  This works around an Apple
// Metal-in-worker behaviour where pipelines compiled eagerly during
// createV2Context produce no output when later dispatched, while pipelines
// compiled lazily inside the Newton flow execute correctly.
function lazyPipeline(device, key, wgsl, layoutDescriptor) {
  let cached = null;
  return {
    resolve() {
      if (!cached) cached = compileNow(device, key, wgsl, layoutDescriptor);
      return cached;
    },
    get pipeline() { return this.resolve().pipeline; },
    get bgLayout() { return this.resolve().bgLayout; }
  };
}

function buf(device, sizeBytes, usage, label) {
  return device.createBuffer({ size: Math.max(sizeBytes, 16), usage, label });
}

function sourceBytes(src) {
  if (src == null) return new Uint8Array(0);
  if (src instanceof Float64Array) {
    throw new Error('uploadBufferStaged: raw Float64Array cannot be uploaded to WebGPU; pack it to DS Float32Array first.');
  }
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
  throw new Error('uploadBufferStaged: source must be an ArrayBuffer or TypedArray/DataView');
}

function copySourceIntoRange(range, src) {
  const bytes = sourceBytes(src);
  new Uint8Array(range, 0, bytes.byteLength).set(bytes);
  return bytes.byteLength;
}

// Allocate + populate a static buffer in one shot via mappedAtCreation.
// This is the most reliable upload path on every WebGPU implementation —
// the data is copied directly into the buffer's backing memory at create
// time, with no queue involvement.  Used for read-only static data that we
// only ever upload once.
export function createMappedBufferWithData(device, srcTypedArray, usage, label) {
  if (srcTypedArray instanceof Float64Array) {
    throw new Error(`createMappedBufferWithData(${label || 'unnamed'}): raw Float64Array cannot be uploaded to WebGPU; pack it to DS Float32Array first.`);
  }
  // Round size up to a multiple of 4 (WebGPU requires it for storage / vertex
  // buffers; mappedAtCreation also requires it).
  const byteLength = srcTypedArray.byteLength;
  const size = Math.max((byteLength + 3) & ~3, 16);
  const buffer = device.createBuffer({
    size, usage, label, mappedAtCreation: true
  });
  // Use the same view type as the source for the copy.
  const range = buffer.getMappedRange();
  if (srcTypedArray instanceof Float32Array) {
    new Float32Array(range).set(srcTypedArray);
  } else if (srcTypedArray instanceof Uint32Array) {
    new Uint32Array(range).set(srcTypedArray);
  } else if (srcTypedArray instanceof Int32Array) {
    new Int32Array(range).set(srcTypedArray);
  } else {
    // Generic fallback — works for any TypedArray that has byteLength.
    new Uint8Array(range).set(new Uint8Array(srcTypedArray.buffer, srcTypedArray.byteOffset, srcTypedArray.byteLength));
  }
  buffer.unmap();
  return buffer;
}

function bufWithData(device, srcTypedArray, usage, label) {
  const buffer = createMappedBufferWithData(device, srcTypedArray, usage, label);
  uploadBufferStaged(device, buffer, srcTypedArray, `${label}-staged-init`);
  return buffer;
}

export function uploadBufferStaged(device, buffer, src, label = 'mf-staged-upload') {
  const byteLength = sourceBytes(src).byteLength;
  if (byteLength <= 0) return null;
  const size = Math.max((byteLength + 3) & ~3, 4);
  const staging = device.createBuffer({
    size,
    usage: USAGE('COPY_SRC'),
    mappedAtCreation: true,
    label: `${label}-src`
  });
  copySourceIntoRange(staging.getMappedRange(), src);
  staging.unmap();
  const enc = device.createCommandEncoder({ label });
  enc.copyBufferToBuffer(staging, 0, buffer, 0, byteLength);
  device.queue.submit([enc.finish()]);
  const done = typeof device.queue.onSubmittedWorkDone === 'function'
    ? device.queue.onSubmittedWorkDone()
    : null;
  if (done?.then) done.then(() => staging.destroy?.()).catch(() => {});
  return staging;
}

// Dynamic v2 writes use mapped staging buffers instead of queue.writeBuffer.
// On Apple Metal we observed storage-buffer uploads being silently lost in the
// deformation worker; a command-buffer copy from mapped memory is slower but
// gives the solver an actually resident RHS/state.
function uploadF32(device, buffer, f32) {
  uploadBufferStaged(device, buffer, f32, 'mf-upload-f32');
}
function uploadU32(device, buffer, u32) {
  uploadBufferStaged(device, buffer, u32, 'mf-upload-u32');
}

// AxpyParams (32 B): alpha vec2<f32>, n u32, _pad vec3<u32>
export function writeAxpyParams(device, buffer, alphaDs, n) {
  const f = new Float32Array(8);             // 32 bytes; aliased view for the u32 slot
  f[0] = alphaDs[0]; f[1] = alphaDs[1];
  const u = new Uint32Array(f.buffer);
  u[2] = n >>> 0;
  uploadBufferStaged(device, buffer, f, 'mf-upload-axpy');
}
// AxpbyParams (48 B): alpha vec2, beta vec2 (offset 8), n u32 (offset 16), _pad vec3 (offset 32)
export function writeAxpbyParams(device, buffer, alphaDs, betaDs, n) {
  const f = new Float32Array(12);            // 48 bytes
  f[0] = alphaDs[0]; f[1] = alphaDs[1];
  f[2] = betaDs[0];  f[3] = betaDs[1];
  const u = new Uint32Array(f.buffer);
  u[4] = n >>> 0;
  uploadBufferStaged(device, buffer, f, 'mf-upload-axpby');
}
function writeU32Param(device, buffer, value, sizeBytes = 16) {
  const u = new Uint32Array(sizeBytes >> 2);
  u[0] = value >>> 0;
  uploadBufferStaged(device, buffer, u, 'mf-upload-u32-param');
}
export function writeConvergeParams(device, buffer, targetTolSqDs) {
  const f = new Float32Array(4);
  f[0] = targetTolSqDs[0]; f[1] = targetTolSqDs[1];
  uploadBufferStaged(device, buffer, f, 'mf-upload-converge');
}

function hasNonAssociatedRegions(regionConstitutiveByRegion) {
  for (const [, constitutive] of regionConstitutiveByRegion || []) {
    const params = constitutive?.materialParameters || {};
    const phi = Number(params.phiEffDeg) || 0;
    const psi = Number(params.psiEffDeg) || 0;
    if (Math.abs(phi - psi) > 1e-9) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Build a single ctx that owns everything for v2.  Reusable across multiple
// solves with the same mesh.  Caller is responsible for `ctx.destroy()` to
// free GPU buffers if needed.
// -----------------------------------------------------------------------------
export function createV2Context({
  device,
  mesh,
  elementCaches,
  regionConstitutiveByRegion,
  fixedDofSet,
  porePressureByIntegrationPoint = null,
  preconditioner = 'block-jacobi',     // 'jacobi' | 'block-jacobi'
  forceSolver = null,                  // null | 'cg' | 'bicgstab'
  useUnsymmetricPlasticSolver = false,
  useAlgorithmicTangent = true,
  useLineSearch = true,
  warnings = []
}) {
  if (!device) throw new Error('createV2Context: GPUDevice required');

  const pack = buildGpuMeshPack({
    mesh, elementCaches, regionConstitutiveByRegion,
    fixedDofSet, porePressureByIntegrationPoint, warnings
  });
  if (pack.numFree === 0) throw new Error('createV2Context: no free DOFs');

  const elementType = elementCaches[0]?.kind === 't6' ? 't6' : 't3';
  const numLocalDofs = elementType === 't6' ? 12 : 6;
  const gpsPerElem = elementType === 't6' ? 3 : 1;
  const numElements = pack.numElements;
  const numGp = pack.numGp;
  const numFree = pack.numFree;
  const ndof = pack.ndof;
  const numWg = Math.ceil(numFree / WG);
  const numWgGp = Math.ceil(numGp / WG);
  const numWgEl = Math.ceil(numElements / WG);

  // Pipelines.
  const kxSrc = elementType === 't6' ? KERNEL_MF_KX_T6_WGSL : KERNEL_MF_KX_T3_WGSL;
  const kxTangentSrc = elementType === 't6' ? KERNEL_MF_KX_T6_TANGENT_WGSL : KERNEL_MF_KX_T3_TANGENT_WGSL;
  const diagSrc = elementType === 't6' ? KERNEL_MF_DIAG_T6_WGSL : KERNEL_MF_DIAG_T3_WGSL;
  const diagTangentSrc = elementType === 't6' ? KERNEL_MF_DIAG_T6_TANGENT_WGSL : KERNEL_MF_DIAG_T3_TANGENT_WGSL;
  const blkBuildSrc = elementType === 't6' ? KERNEL_MF_BLOCK_BUILD_T6_WGSL : KERNEL_MF_BLOCK_BUILD_T3_WGSL;
  const blkBuildTangentSrc = elementType === 't6' ? KERNEL_MF_BLOCK_BUILD_T6_TANGENT_WGSL : KERNEL_MF_BLOCK_BUILD_T3_TANGENT_WGSL;
  const blkDiagFromKElemSrc = elementType === 't6' ? KERNEL_MF_BLOCK_DIAG_FROM_KELEM_T6_WGSL : KERNEL_MF_BLOCK_DIAG_FROM_KELEM_T3_WGSL;
  const strainSrc = elementType === 't6' ? KERNEL_STRAIN_T6_WGSL : KERNEL_STRAIN_T3_WGSL;
  const fIntSrc   = elementType === 't6' ? KERNEL_INTERNAL_FORCE_T6_WGSL : KERNEL_INTERNAL_FORCE_T3_WGSL;

  // All pipelines are built via `lazyPipeline` — the actual
  // createShaderModule + createComputePipeline only fires on first
  // .pipeline / .bgLayout access from inside a dispatch helper.  This
  // avoids a confirmed Apple-Metal-in-worker behaviour where pipelines
  // compiled eagerly during context creation produce no output when later
  // dispatched, while the same pipelines compiled lazily inside the
  // Newton flow work correctly.
  const pipelines = {
    kx:           lazyPipeline(device, `mfKx-${elementType}`,         kxSrc,     MF_KX_LAYOUT),
    kxTangent:    lazyPipeline(device, `mfKxTangent-${elementType}`,  kxTangentSrc, MF_KX_LAYOUT),
    diag:         lazyPipeline(device, `mfDiag-${elementType}`,       diagSrc,   MF_DIAG_LAYOUT),
    diagTangent:  lazyPipeline(device, `mfDiagTangent-${elementType}`, diagTangentSrc, MF_DIAG_LAYOUT),
    recip:        lazyPipeline(device, 'mfRecip',                     KERNEL_MF_RECIP_WGSL,        MF_RECIP_LAYOUT),
    applyJacobi:  lazyPipeline(device, 'mfApplyJacobi',               KERNEL_MF_APPLY_JACOBI_WGSL, MF_APPLY_JACOBI_LAYOUT),
    buildD:       lazyPipeline(device, 'mfBuildD',                    KERNEL_MF_ELASTIC_D_WGSL,    MF_ELASTIC_D_LAYOUT),
    trialStress:  lazyPipeline(device, 'mfTrialStress',               KERNEL_MF_TRIAL_STRESS_WGSL, MF_TRIAL_STRESS_LAYOUT),
    blockBuild:   lazyPipeline(device, `mfBlockBuild-${elementType}`, blkBuildSrc, MF_BLOCK_BUILD_LAYOUT),
    blockBuildTangent: lazyPipeline(device, `mfBlockBuildTangent-${elementType}`, blkBuildTangentSrc, MF_BLOCK_BUILD_LAYOUT),
    blockDiagFromKElem: lazyPipeline(device, `mfBlockDiagFromKElem-${elementType}`, blkDiagFromKElemSrc, MF_BLOCK_DIAG_FROM_KELEM_LAYOUT),
    blockInvert:  lazyPipeline(device, 'mfBlockInvert',               KERNEL_MF_BLOCK_JACOBI_INVERT_WGSL, MF_BLOCK_JACOBI_INVERT_LAYOUT),
    blockApply:   lazyPipeline(device, 'mfBlockApply',                KERNEL_MF_BLOCK_JACOBI_APPLY_WGSL,  MF_BLOCK_JACOBI_APPLY_LAYOUT),
    residFromFint:lazyPipeline(device, 'mfResidFromFint',             KERNEL_MF_RESID_FROM_FINT_WGSL, MF_RESID_FROM_FINT_LAYOUT),
    mcStats:      lazyPipeline(device, 'mfMcStats',                   KERNEL_MF_MC_STATS_WGSL, MF_MC_STATS_LAYOUT),
    mcStatsFinal: lazyPipeline(device, 'mfMcStatsFinal',              KERNEL_MF_MC_STATS_FINAL_WGSL, MF_MC_STATS_FINAL_LAYOUT),
    stressSlice:  lazyPipeline(device, 'mfStressSlice',               KERNEL_MF_STRESS_VOIGT6_TO_VOIGT3_WGSL, MF_STRESS_VOIGT6_TO_VOIGT3_LAYOUT),
    convergeFlag: lazyPipeline(device, 'mfConvergeFlag',              KERNEL_MF_CONVERGE_FLAG_WGSL, MF_CONVERGE_FLAG_LAYOUT),
    resetStatus:  lazyPipeline(device, 'mfResetStatus',               KERNEL_MF_RESET_STATUS_WGSL,  MF_RESET_STATUS_LAYOUT),
    scatter:      lazyPipeline(device, 'mfScatter',                   KERNEL_SCATTER_FREE_RHS_WGSL, SCATTER_FREE_RHS_LAYOUT),
    strain:       lazyPipeline(device, `strain-${elementType}`,       strainSrc, BGL_STRAIN),
    internalForce:lazyPipeline(device, `internalForce-${elementType}`,fIntSrc,   BGL_INTERNAL_FORCE),
    mcReturn:     lazyPipeline(device, 'mcReturn',                    KERNEL_MC_RETURN_WGSL, MC_BIND_GROUP_LAYOUT),
    axpy:         lazyPipeline(device, 'mfAxpy',                      KERNEL_MF_AXPY_WGSL,  BGL_AXPY),
    axpby:        lazyPipeline(device, 'mfAxpby',                     KERNEL_MF_AXPBY_WGSL, BGL_AXPBY),
    copy:         lazyPipeline(device, 'copy',                        KERNEL_COPY_WGSL,  BGL_COPY),
    dot1:         lazyPipeline(device, 'mfDot1',                      KERNEL_MF_DOT_PASS1_WGSL, BGL_DOT_PASS1),
    dot2:         lazyPipeline(device, 'mfDot2',                      KERNEL_MF_DOT_PASS2_WGSL, BGL_DOT_PASS2)
  };

  // Buffer usage flags.  `COPY_SRC` is included on every buffer (including
  // parameter buffers) so diagnostic probes can read them back regardless of role.
  // The cost is negligible.
  const SR  = USAGE('STORAGE') | USAGE('COPY_DST') | USAGE('COPY_SRC');
  const SRW = USAGE('STORAGE') | USAGE('COPY_SRC') | USAGE('COPY_DST');
  const UNI = USAGE('UNIFORM') | USAGE('COPY_DST') | USAGE('COPY_SRC');
  const PARAM = USAGE('STORAGE') | USAGE('COPY_DST') | USAGE('COPY_SRC');
  const RB  = USAGE('COPY_DST') | USAGE('MAP_READ');

  // Static buffers — created with `mappedAtCreation: true` and the data
  // written directly into the mapped range.  This is the only WebGPU upload
  // path that's guaranteed to work without timing or implementation quirks
  // (in particular, on Apple Metal `device.queue.writeBuffer` was silently
  // dropping the static uploads in the deformation worker context, while
  // the same call worked for buffers uploaded right before use).
  const buffers = {};
  buffers.bMatrices    = bufWithData(device, pack.bMatricesPacked, SR, 'mf-B');
  buffers.gpWeights    = bufWithData(device, pack.gpWeightsPacked, SR, 'mf-W');
  buffers.dofMap       = bufWithData(device, pack.dofMap,          SR, 'mf-dofMap');
  buffers.matParams    = bufWithData(device, pack.matParamsPacked, SR, 'mf-matParams');
  buffers.matIndex     = bufWithData(device, pack.matIndex,        SR, 'mf-matIndex');
  buffers.forceIncPtr  = bufWithData(device, pack.forceIncPtr,     SR, 'mf-incPtr');
  buffers.forceIncList = bufWithData(device, pack.forceIncList,    SR, 'mf-incList');

  // Per-GP DS buffers.
  const dPerGpBytes = numGp * D_PACK * 8;
  buffers.dPerGp = buf(device, dPerGpBytes, SRW, 'mf-dPerGp');

  // Per-GP Voigt-6 stress buffers (DS).
  const sigmaBytes = numGp * VOIGT6 * 8;
  buffers.sigmaCommitted = buf(device, sigmaBytes, SRW, 'mf-sigmaC');
  buffers.sigmaTrial     = buf(device, sigmaBytes, SRW, 'mf-sigmaT');
  buffers.sigmaReturned  = buf(device, sigmaBytes, SRW, 'mf-sigmaR');
  // Voigt-3 (xx, yy, xy) slice of σ_returned — fed to v1's internal-force
  // kernel which expects 3 DS per GP, NOT the full Voigt-6 we keep on
  // sigmaReturned for the MC return mapping.
  buffers.sigmaVoigt3    = buf(device, numGp * 3 * 8, SRW, 'mf-sigmaV3');
  // Strain Voigt-3 (DS).
  buffers.deltaEps       = buf(device, numGp * STRAIN_DIM * 8, SRW, 'mf-deltaEps');
  // Per-GP MC outputs.
  buffers.branchKind    = buf(device, numGp * 4,        SRW, 'mf-branchKind');
  buffers.tangentVoigt3 = buf(device, numGp * 9 * 8,    SRW, 'mf-tangent');
  buffers.mcConverged   = buf(device, numGp * 4,        SRW, 'mf-mcConv');

  // Element-level scatter scratch (used by Kx, internalForce, blockBuild).
  buffers.elemScatter   = buf(device, numElements * numLocalDofs * 8, SRW, 'mf-elemScatter');
  buffers.fInt          = buf(device, dsVectorBytes(numFree), SRW, 'mf-fInt');
  // Element-level K_e for block-Jacobi.
  buffers.kElem         = buf(device, numElements * numLocalDofs * numLocalDofs * 8, SRW, 'mf-kElem');

  // Solver vectors (length numFree, DS).
  const vecBytes = dsVectorBytes(numFree);
  buffers.x   = buf(device, vecBytes, SRW, 'mf-x');
  buffers.xCandidate = buf(device, vecBytes, SRW, 'mf-xCandidate');
  buffers.linearRhs = buf(device, vecBytes, SRW, 'mf-linearRhs');
  buffers.r   = buf(device, vecBytes, SRW, 'mf-r');
  buffers.p   = buf(device, vecBytes, SRW, 'mf-p');
  buffers.Ap  = buf(device, vecBytes, SRW, 'mf-Ap');
  buffers.z   = buf(device, vecBytes, SRW, 'mf-z');
  buffers.b   = buf(device, vecBytes, SRW, 'mf-b');
  buffers.diag = buf(device, vecBytes, SRW, 'mf-diag');
  buffers.mInv = buf(device, vecBytes, SRW, 'mf-mInv');
  buffers.utotal = buf(device, vecBytes, SRW, 'mf-uTotal');           // current Newton displacement
  buffers.uPrev  = buf(device, vecBytes, SRW, 'mf-uPrev');             // previous load step / Newton ref
  buffers.uCandidate = buf(device, vecBytes, SRW, 'mf-uCandidate');     // line-search restore point
  buffers.du   = buf(device, vecBytes, SRW, 'mf-du');                  // Newton increment (= solver x)

  // BiCGStab auxiliary vectors.
  buffers.rhat = buf(device, vecBytes, SRW, 'mf-rhat');
  buffers.v    = buf(device, vecBytes, SRW, 'mf-v');
  buffers.s    = buf(device, vecBytes, SRW, 'mf-s');
  buffers.t    = buf(device, vecBytes, SRW, 'mf-t');
  buffers.y    = buf(device, vecBytes, SRW, 'mf-y');
  // 'z' reused for BiCGStab z-vector

  // Build host-side node-pair grouping FIRST so we know the actual count of
  // pairs.  `numNodePairs = groups.size` — the count of distinct nodes that
  // have at least one free DOF.  This differs from `Math.ceil(numFree / 2)`
  // when the mesh has nodes with one constrained and one free DOF (mixed-
  // constraint boundary nodes) — those contribute one DOF, not two.  Using
  // the wrong count under-allocates the offEntries / blocks buffers and
  // crashes during incidence-list build.
  const groups = new Map();
  for (let f = 0; f < numFree; f += 1) {
    const node = pack.freeDofs[f] >> 1;
    if (!groups.has(node)) groups.set(node, []);
    groups.get(node).push(f);
  }
  const numNodePairs = groups.size;

  // Block-Jacobi: 4 DS values per node-pair.
  buffers.blocks   = buf(device, numNodePairs * 4 * 8, SRW, 'mf-blocks');
  buffers.numNodePairs = numNodePairs;

  // Build the block-Jacobi index arrays first, then create their buffers
  // with `mappedAtCreation` so the data is committed at allocation time.
  const freeToPair    = new Uint32Array(numFree);
  const freeIsSecond  = new Uint32Array(numFree);
  const freeMate      = new Uint32Array(numFree);
  const nodePairFreeIdx = new Uint32Array(numNodePairs * 2);
  let pairIdx = 0;
  for (const [, list] of groups) {
    nodePairFreeIdx[2 * pairIdx + 0] = list[0] >>> 0;
    nodePairFreeIdx[2 * pairIdx + 1] = (list.length === 2 ? list[1] : 0xFFFFFFFF) >>> 0;
    for (let k = 0; k < list.length; k += 1) {
      const f = list[k];
      freeToPair[f] = pairIdx;
      freeIsSecond[f] = (k === 1) ? 1 : 0;
      freeMate[f] = (list.length === 2) ? (k === 0 ? list[1] : list[0]) : 0xFFFFFFFF;
    }
    pairIdx += 1;
  }
  buffers.freeToPair      = bufWithData(device, freeToPair,      SR, 'mf-freeToPair');
  buffers.freeIsSecond    = bufWithData(device, freeIsSecond,    SR, 'mf-freeIsSecond');
  buffers.freeMate        = bufWithData(device, freeMate,        SR, 'mf-freeMate');
  buffers.nodePairFreeIdx = bufWithData(device, nodePairFreeIdx, SR, 'mf-nodePairFreeIdx');
  // nodePairOffPtr and nodePairOffList are computed below and then created
  // via mappedAtCreation as well.

  // Off-diagonal incidence lists: for each node-pair, list per-element K_e
  // flat slots for both K[first, second] and K[second, first].  Elastic K is
  // symmetric so these lists sum to the same value; the algorithmic plastic
  // tangent is generally unsymmetric for non-associated flow, and the block
  // inverse must keep b and c distinct.
  const offEntriesB = new Array(numNodePairs);
  const offEntriesC = new Array(numNodePairs);
  for (let p = 0; p < numNodePairs; p += 1) {
    offEntriesB[p] = [];
    offEntriesC[p] = [];
  }
  for (let e = 0; e < numElements; e += 1) {
    for (let i = 0; i < numLocalDofs; i += 1) {
      const iFree = pack.dofMap[e * numLocalDofs + i];
      if (iFree < 0) continue;
      const pi = freeToPair[iFree];
      const first = nodePairFreeIdx[2 * pi + 0];
      const second = nodePairFreeIdx[2 * pi + 1];
      if (second === 0xFFFFFFFF) continue;        // single-DOF node, no off-diag
      for (let j = 0; j < numLocalDofs; j += 1) {
        const jFree = pack.dofMap[e * numLocalDofs + j];
        if (jFree < 0) continue;
        const slot = e * numLocalDofs * numLocalDofs + i * numLocalDofs + j;
        if (iFree === first && jFree === second) offEntriesB[pi].push(slot);
        if (iFree === second && jFree === first) offEntriesC[pi].push(slot);
      }
    }
  }
  let totalOffB = 0;
  let totalOffC = 0;
  const nodePairOffPtrB = new Uint32Array(numNodePairs + 1);
  const nodePairOffPtrC = new Uint32Array(numNodePairs + 1);
  for (let p = 0; p < numNodePairs; p += 1) {
    nodePairOffPtrB[p] = totalOffB;
    nodePairOffPtrC[p] = totalOffC;
    totalOffB += offEntriesB[p].length;
    totalOffC += offEntriesC[p].length;
  }
  nodePairOffPtrB[numNodePairs] = totalOffB;
  nodePairOffPtrC[numNodePairs] = totalOffC;
  const nodePairOffListB = new Uint32Array(Math.max(totalOffB, 1));
  const nodePairOffListC = new Uint32Array(Math.max(totalOffC, 1));
  let cursorB = 0;
  let cursorC = 0;
  for (let p = 0; p < numNodePairs; p += 1) {
    for (const s of offEntriesB[p]) nodePairOffListB[cursorB++] = s;
    for (const s of offEntriesC[p]) nodePairOffListC[cursorC++] = s;
  }
  buffers.nodePairOffPtr  = bufWithData(device, nodePairOffPtrB,  SR, 'mf-nodePairOffPtrB');
  buffers.nodePairOffList = bufWithData(device, nodePairOffListB, SR, 'mf-nodePairOffListB');
  buffers.nodePairOffPtrC  = bufWithData(device, nodePairOffPtrC,  SR, 'mf-nodePairOffPtrC');
  buffers.nodePairOffListC = bufWithData(device, nodePairOffListC, SR, 'mf-nodePairOffListC');

  // Status flag (4 u32: convergedFlag, iterCount, _, _).
  buffers.status = buf(device, 16, SRW, 'mf-status');
  buffers.statusRb = buf(device, 16, RB, 'mf-statusRb');

  // MC return-mapping scalar stats (failed count, plastic count, total, _).
  buffers.mcStatsPartials = buf(device, Math.max(numWgGp * 4 * 4, 16), SRW, 'mf-mcStatsPartials');
  buffers.mcStats = buf(device, 16, SRW, 'mf-mcStats');
  buffers.mcStatsRb = buf(device, 16, RB, 'mf-mcStatsRb');

  // Dot product partials + result.
  buffers.dotPartials  = buf(device, Math.max(numWg * 8, 16), SRW, 'mf-dotPartials');
  buffers.dotPartials2 = buf(device, Math.max(numWg * 8, 16), SRW, 'mf-dotPartials2');
  buffers.dotResult    = buf(device, DS_SCALAR_BYTES, SRW, 'mf-dotResult');
  buffers.dotResult2   = buf(device, DS_SCALAR_BYTES, SRW, 'mf-dotResult2');
  buffers.dotResultRb  = buf(device, DS_SCALAR_BYTES, RB,  'mf-dotResultRb');
  buffers.dotPairRb    = buf(device, 2 * DS_SCALAR_BYTES, RB, 'mf-dotPairRb');

  // Small parameter buffers.
  // Static-value params are created with their value baked in via
  // mappedAtCreation. Dynamic params are uploaded through mapped staging
  // copies by the helper functions above; this avoids the Apple Metal worker
  // path where queue.writeBuffer can leave the solver reading zeros.
  const uniforms = {};
  // Helpers to build mappedAtCreation parameter buffers carrying initial data.
  const makeU32UniformWithValue = (value, sizeBytes, label) => {
    const u = new Uint32Array(sizeBytes >> 2);
    u[0] = value >>> 0;
    return bufWithData(device, u, UNI, label);
  };
  const makeAxpyUniformWithValue = (alphaDs, n, label) => {
    const f = new Float32Array(8);             // 32 bytes
    f[0] = alphaDs[0]; f[1] = alphaDs[1];
    new Uint32Array(f.buffer)[2] = n >>> 0;
    return bufWithData(device, f, PARAM, label);
  };
  const makeAxpbyUniformWithValue = (alphaDs, betaDs, n, label) => {
    const f = new Float32Array(12);            // 48 bytes
    f[0] = alphaDs[0]; f[1] = alphaDs[1];
    f[2] = betaDs[0];  f[3] = betaDs[1];
    new Uint32Array(f.buffer)[4] = n >>> 0;
    return bufWithData(device, f, PARAM, label);
  };

  // Static U32 dispatch-size uniforms (one u32 + 3-u32 pad = 16 B).
  uniforms.numEl        = makeU32UniformWithValue(numElements, 16, 'mf-uNumEl');
  uniforms.numGp        = makeU32UniformWithValue(numGp,        16, 'mf-uNumGp');
  uniforms.numFree      = makeU32UniformWithValue(numFree,      16, 'mf-uNumFree');
  uniforms.numNodePairs = makeU32UniformWithValue(numNodePairs, 16, 'mf-uNumNodePairs');

  // Static AxpY/AxpbY parameter buffers with constant coefficients (1, -1, init).
  uniforms.axpyOne      = makeAxpyUniformWithValue(dsFromF64( 1), numFree, 'mf-uAxpyOne');
  uniforms.axpyNegOne   = makeAxpyUniformWithValue(dsFromF64(-1), numFree, 'mf-uAxpyNegOne');
  uniforms.axpbyInit    = makeAxpbyUniformWithValue(dsFromF64(1), dsFromF64(0), numFree, 'mf-uAxpbyInit');

  // Dynamic parameter buffers — written per CG/BiCGStab iteration.  IMPORTANT:
  // each dispatch within a single command-buffer submission must read its
  // own dedicated parameter buffer.  The staging-copy uploads are queued
  // before compute work, so reusing one parameter buffer with different values across
  // two dispatches in the same submission would make both reads see the
  // most-recently-uploaded value. Multiple slots below cover BiCGStab's
  // heaviest iteration, which issues up to 6 axpby + 4 axpy in one batch.
  uniforms.axpy       = buf(device, 32, PARAM, 'mf-uAxpy');
  uniforms.axpyAlpha  = buf(device, 32, PARAM, 'mf-uAxpyA');
  uniforms.axpyNegA   = buf(device, 32, PARAM, 'mf-uAxpyNa');
  uniforms.axpyAlphaY = buf(device, 32, PARAM, 'mf-uAxpyAY');         // BiCGStab x += α y
  uniforms.axpyOmegaZ = buf(device, 32, PARAM, 'mf-uAxpyOmZ');         // BiCGStab x += ω z
  uniforms.axpyNegOmegaT = buf(device, 32, PARAM, 'mf-uAxpyNegOmT');   // BiCGStab r -= ω t
  uniforms.axpby      = buf(device, 48, PARAM, 'mf-uAxpby');
  uniforms.axpbyP     = buf(device, 48, PARAM, 'mf-uAxpbyP');
  uniforms.axpbyPMix  = buf(device, 48, PARAM, 'mf-uAxpbyPMix');       // BiCGStab p = β p + r (slot 1)
  uniforms.axpbyPV    = buf(device, 48, PARAM, 'mf-uAxpbyPV');         // BiCGStab p -= ω v (slot 2)
  uniforms.converge   = buf(device, 16, PARAM, 'mf-uConverge');

  return {
    device, mesh, elementCaches, regionConstitutiveByRegion, fixedDofSet,
    pack, elementType, numLocalDofs, gpsPerElem,
    numElements, numGp, numFree, ndof, numWg, numWgGp, numWgEl, numNodePairs,
    pipelines, buffers, uniforms,
    preconditioner,
    forceSolver: forceSolver === 'bicgstab' ? 'bicgstab' : (forceSolver === 'cg' ? 'cg' : null),
    useUnsymmetricPlasticSolver: useUnsymmetricPlasticSolver === true,
    hasNonAssociatedPlasticity: hasNonAssociatedRegions(regionConstitutiveByRegion),
    useAlgorithmicTangent: useAlgorithmicTangent !== false,
    useLineSearch: useLineSearch !== false,
    helpers: {
      writeAxpyParams: (b, a, n) => writeAxpyParams(device, b, a, n),
      writeAxpbyParams: (b, a, β, n) => writeAxpbyParams(device, b, a, β, n),
      writeConvergeParams: (b, ts) => writeConvergeParams(device, b, ts),
      uploadF32: (b, a) => uploadF32(device, b, a),
      uploadU32: (b, a) => uploadU32(device, b, a),
      packDsVector,
      packDsScalar
    }
  };
}
