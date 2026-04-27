// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// GPU assembly orchestrator.
// ============================================================================
//
// Wires the per-element WGSL kernels (strain, MC return mapping, internal
// force, stiffness) and the atomics-free scatter kernels into a single
// device-side assembly pipeline.  Exposes two recording closures:
//
//   recordResidualAndTangent(encoder)
//     Strain → MC (returns σ AND algorithmic tangent) →
//     internal-force → stiffness → scatter free-RHS → scatter CSR.
//     Writes:
//       rhsFreeBuffer          (DS, length numFree)
//       csrValHiBuffer / valLo (f32, length nnz)
//       branchKindBuffer       (u32, length numGp)
//       sigmaReturnedBuffer    (DS, length 6 * numGp)
//
//   recordResidualOnly(encoder)
//     Strain → MC → internal-force → scatter free-RHS.
//     (Stiffness + CSR scatter elided; used during line search.)
//
// Both closures consume `uBuffer` (DS, length numFree) as the displacement
// state and produce `rhsFreeBuffer` (the internal-force vector, free-DOF
// only).  The Newton orchestrator computes r = b - rhsFree separately.
//
// ============================================================================

import { dsFromF64 } from './wgsl/ds.js';
import {
  KERNEL_STRAIN_T3_WGSL, KERNEL_STRAIN_T6_WGSL,
  KERNEL_INTERNAL_FORCE_T3_WGSL, KERNEL_INTERNAL_FORCE_T6_WGSL,
  KERNEL_STIFFNESS_T3_WGSL, KERNEL_STIFFNESS_T6_WGSL,
  KERNEL_SCATTER_FREE_RHS_WGSL, KERNEL_SCATTER_CSR_WGSL
} from './wgsl/elements.js';
import { KERNEL_MC_RETURN_WGSL } from './wgsl/mc-plastic.js';
import {
  KERNEL_STRAIN_TO_TRIAL_STRESS_WGSL,
  KERNEL_COMMIT_STATE_WGSL
} from './wgsl/plastic-trial.js';

const WG_SIZE = 64;

function GPUShaderStage_COMPUTE() {
  /* global GPUShaderStage */
  return typeof GPUShaderStage !== 'undefined' ? GPUShaderStage.COMPUTE : 0x4;
}

function bgLayoutFromDescriptor(device, desc) {
  const stage = GPUShaderStage_COMPUTE();
  return device.createBindGroupLayout({
    entries: desc.entries.map((e) => ({
      binding: e.binding,
      visibility: stage,
      buffer: {
        type: e.type === 'uniform' ? 'uniform'
            : e.type === 'read-only-storage' ? 'read-only-storage'
            : 'storage'
      }
    }))
  });
}

function compilePipeline(device, key, wgsl, bgLayout) {
  if (!device.__gpuAssemblyPipelines) device.__gpuAssemblyPipelines = new Map();
  const cache = device.__gpuAssemblyPipelines;
  if (cache.has(key)) return cache.get(key);
  const module = device.createShaderModule({ code: wgsl });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bgLayout] });
  const pipeline = device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: 'main' } });
  const entry = { pipeline, bgLayout };
  cache.set(key, entry);
  return entry;
}

// -----------------------------------------------------------------------------
// Bind-group layouts (mirroring each kernel's @group(0) declarations).
// -----------------------------------------------------------------------------
const BGL_STRAIN = { entries: [
  { binding: 0, type: 'read-only-storage' },  // uvec
  { binding: 1, type: 'read-only-storage' },  // bMatrices
  { binding: 2, type: 'read-only-storage' },  // dofMap (i32)
  { binding: 3, type: 'storage' },            // strain
  { binding: 4, type: 'uniform' }
]};

const BGL_MC = { entries: [
  { binding: 0, type: 'read-only-storage' },  // sigmaTrial (DS Voigt-6)
  { binding: 1, type: 'read-only-storage' },  // matIndex
  { binding: 2, type: 'read-only-storage' },  // matParams
  { binding: 3, type: 'storage' },            // sigmaReturned
  { binding: 4, type: 'storage' },            // branchKind
  { binding: 5, type: 'storage' },            // tangentPrincipal
  { binding: 6, type: 'storage' },            // converged
  { binding: 7, type: 'uniform' }
]};

const BGL_FORCE = { entries: [
  { binding: 0, type: 'read-only-storage' },  // bMatrices
  { binding: 1, type: 'read-only-storage' },  // gpWeights
  { binding: 2, type: 'read-only-storage' },  // stress (3 DS per GP, σxx σyy σxy)
  { binding: 3, type: 'storage' },            // forceOut
  { binding: 4, type: 'uniform' }
]};

const BGL_STIFF = { entries: [
  { binding: 0, type: 'read-only-storage' },  // bMatrices
  { binding: 1, type: 'read-only-storage' },  // gpWeights
  { binding: 2, type: 'read-only-storage' },  // tangents (9 DS per GP)
  { binding: 3, type: 'storage' },            // kOut
  { binding: 4, type: 'uniform' }
]};

const BGL_SCATTER_RHS = { entries: [
  { binding: 0, type: 'read-only-storage' },  // forceOut
  { binding: 1, type: 'read-only-storage' },  // forceIncPtr
  { binding: 2, type: 'read-only-storage' },  // forceIncList
  { binding: 3, type: 'storage' },            // rhsFree
  { binding: 4, type: 'uniform' }
]};

const BGL_SCATTER_CSR = { entries: [
  { binding: 0, type: 'read-only-storage' },  // kOut
  { binding: 1, type: 'read-only-storage' },  // csrIncPtr
  { binding: 2, type: 'read-only-storage' },  // csrIncList
  { binding: 3, type: 'storage' },            // csrValHi
  { binding: 4, type: 'storage' },            // csrValLo
  { binding: 5, type: 'uniform' }
]};

// Strain → trial stress (plastic mode):
const BGL_PLASTIC_TRIAL = { entries: [
  { binding: 0, type: 'read-only-storage' },  // strain (current ε)
  { binding: 1, type: 'read-only-storage' },  // strainCommitted
  { binding: 2, type: 'read-only-storage' },  // sigmaCommitted
  { binding: 3, type: 'read-only-storage' },  // matIndex
  { binding: 4, type: 'read-only-storage' },  // matParams
  { binding: 5, type: 'storage' },            // sigmaTrialBuf
  { binding: 6, type: 'uniform' }
]};

// Commit-state at end of accepted load step:
const BGL_COMMIT_STATE = { entries: [
  { binding: 0, type: 'read-only-storage' },  // sigmaReturned
  { binding: 1, type: 'read-only-storage' },  // strain
  { binding: 2, type: 'read-only-storage' },  // branchKind
  { binding: 3, type: 'storage' },            // sigmaCommitted
  { binding: 4, type: 'storage' },            // strainCommitted
  { binding: 5, type: 'storage' },            // branchHistory
  { binding: 6, type: 'uniform' }
]};

// =============================================================================
// Per-pack assembly context.  Owns:
//   - All compiled pipelines for the pack's element type.
//   - All host-allocated GPU buffers that are shared across iterations
//     (intermediate strain/sigmaTrial/sigmaReturned/tangent buffers, etc.).
//   - Pre-uploaded read-only buffers (bMatrices, gpWeights, dofMap, matIndex,
//     matParams, scatter incidence).
//
// The Newton orchestrator constructs one of these per analysis run and
// reuses it across iterations.
// =============================================================================
export function createGpuAssemblyContext({ device, pack, elementType }) {
  const numLocalDofs = pack.numLocalDofs;
  const gpsPerElem = pack.gpsPerElem;
  const numGp = pack.numGp;
  const numElements = pack.numElements;
  const numFree = pack.numFree;
  const nnz = pack.nnz;
  const STRAIN_DIM = 3;
  const numWgGp = Math.ceil(numGp / WG_SIZE);
  const numWgElem = Math.ceil(numElements / WG_SIZE);
  const numWgElemStiff = Math.ceil(numElements / 32);  // stiffness kernel uses workgroup_size(32)
  const numWgFree = Math.ceil(numFree / WG_SIZE);
  const numWgNnz = Math.ceil(nnz / WG_SIZE);

  // Pick element-specific kernels.
  const isT6 = elementType === 't6';
  const strainWgsl = isT6 ? KERNEL_STRAIN_T6_WGSL : KERNEL_STRAIN_T3_WGSL;
  const forceWgsl  = isT6 ? KERNEL_INTERNAL_FORCE_T6_WGSL : KERNEL_INTERNAL_FORCE_T3_WGSL;
  const stiffWgsl  = isT6 ? KERNEL_STIFFNESS_T6_WGSL : KERNEL_STIFFNESS_T3_WGSL;

  // -------------------------------------------------------------------------
  // Compile pipelines.
  // -------------------------------------------------------------------------
  const layouts = {
    strain:     bgLayoutFromDescriptor(device, BGL_STRAIN),
    mc:         bgLayoutFromDescriptor(device, BGL_MC),
    force:      bgLayoutFromDescriptor(device, BGL_FORCE),
    stiff:      bgLayoutFromDescriptor(device, BGL_STIFF),
    scatterRhs: bgLayoutFromDescriptor(device, BGL_SCATTER_RHS),
    scatterCsr: bgLayoutFromDescriptor(device, BGL_SCATTER_CSR),
    plasticTrial: bgLayoutFromDescriptor(device, BGL_PLASTIC_TRIAL),
    commitState:  bgLayoutFromDescriptor(device, BGL_COMMIT_STATE),
    voigt6to3:    bgLayoutFromDescriptor(device, BGL_VOIGT6_TO_VOIGT3)
  };
  const pipes = {
    strain:     compilePipeline(device, `gpu-strain-${elementType}`,     strainWgsl,                  layouts.strain),
    mc:         compilePipeline(device, 'gpu-mc-return',                 KERNEL_MC_RETURN_WGSL,       layouts.mc),
    force:      compilePipeline(device, `gpu-force-${elementType}`,      forceWgsl,                   layouts.force),
    stiff:      compilePipeline(device, `gpu-stiff-${elementType}`,      stiffWgsl,                   layouts.stiff),
    scatterRhs: compilePipeline(device, 'gpu-scatter-free-rhs',          KERNEL_SCATTER_FREE_RHS_WGSL,layouts.scatterRhs),
    scatterCsr: compilePipeline(device, 'gpu-scatter-csr',               KERNEL_SCATTER_CSR_WGSL,     layouts.scatterCsr),
    plasticTrial: compilePipeline(device, 'gpu-plastic-trial',           KERNEL_STRAIN_TO_TRIAL_STRESS_WGSL, layouts.plasticTrial),
    commitState:  compilePipeline(device, 'gpu-commit-state',            KERNEL_COMMIT_STATE_WGSL,    layouts.commitState),
    voigt6to3:    compilePipeline(device, 'gpu-voigt6-to-3',             KERNEL_VOIGT6_TO_VOIGT3_STRESS_WGSL, layouts.voigt6to3)
  };

  // -------------------------------------------------------------------------
  // Allocate buffers.
  // -------------------------------------------------------------------------
  const bytes = {
    dsScalar: 16,
    bMatrices: pack.bMatricesPacked.byteLength,
    gpWeights: pack.gpWeightsPacked.byteLength,
    matParams: pack.matParamsPacked.byteLength,
    dofMap:    pack.dofMap.byteLength,
    matIndex:  pack.matIndex.byteLength,
    forceIncPtr:  pack.forceIncPtr.byteLength,
    forceIncList: pack.forceIncList.byteLength,
    csrIncPtr:    pack.csrIncPtr.byteLength,
    csrIncList:   pack.csrIncList.byteLength,
    uvec:         8 * numFree,
    strain:       8 * STRAIN_DIM * numGp,
    sigmaTrial:   8 * 6 * numGp,
    sigmaReturned:8 * 6 * numGp,
    branchKind:   4 * numGp,
    converged:    4 * numGp,
    tangentPrin:  8 * 9 * numGp,
    stressVoigt3: 8 * STRAIN_DIM * numGp,
    tangent2D:    8 * 9 * numGp,
    forceOut:     8 * numLocalDofs * numElements,
    kOut:         8 * numLocalDofs * numLocalDofs * numElements,
    rhsFree:      8 * numFree,
    csrValHi:     4 * nnz,
    csrValLo:     4 * nnz,
    // Persistent material-point state (Step 1 of the full-plastic plan).
    // sigmaCommitted: σ at last accepted load step (Voigt-6 DS).
    // strainCommitted: ε_total at last accepted load step (Voigt-3 DS).
    // branchHistory:  last accepted MC branch id (u32).
    // uCommitted:     u at last accepted load step (DS, length numFree) — used
    //                 by the residual-only re-pass during line search.
    sigmaCommitted:    8 * 6 * numGp,
    strainCommitted:   8 * 3 * numGp,
    branchHistory:     4 * numGp,
    uCommitted:        8 * numFree,
    // Trial state and tangent in physical Voigt-3 (xx, yy, xy) — emitted by
    // the MC kernel in plastic mode.
    tangentVoigt3:     8 * 9 * numGp,
    sigmaTrialBuf:     8 * 6 * numGp
  };

  const usageRO  = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const usageRW  = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const usageU   = GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;

  const buffers = {
    bMatrices:  device.createBuffer({ size: bytes.bMatrices,  usage: usageRO }),
    gpWeights:  device.createBuffer({ size: bytes.gpWeights,  usage: usageRO }),
    dofMap:     device.createBuffer({ size: bytes.dofMap,     usage: usageRO }),
    matIndex:   device.createBuffer({ size: bytes.matIndex,   usage: usageRO }),
    matParams:  device.createBuffer({ size: bytes.matParams,  usage: usageRO }),
    forceIncPtr:  device.createBuffer({ size: bytes.forceIncPtr,  usage: usageRO }),
    forceIncList: device.createBuffer({ size: bytes.forceIncList, usage: usageRO }),
    csrIncPtr:    device.createBuffer({ size: bytes.csrIncPtr,    usage: usageRO }),
    csrIncList:   device.createBuffer({ size: bytes.csrIncList,   usage: usageRO }),
    // Per-iteration scratch.
    uvec:          device.createBuffer({ size: bytes.uvec,          usage: usageRW }),
    strain:        device.createBuffer({ size: bytes.strain,        usage: usageRW }),
    sigmaReturned: device.createBuffer({ size: bytes.sigmaReturned, usage: usageRW }),
    branchKind:    device.createBuffer({ size: bytes.branchKind,    usage: usageRW }),
    converged:     device.createBuffer({ size: bytes.converged,     usage: usageRW }),
    tangentPrin:   device.createBuffer({ size: bytes.tangentPrin,   usage: usageRW }),
    stressVoigt3:  device.createBuffer({ size: bytes.stressVoigt3,  usage: usageRW }),
    tangent2D:     device.createBuffer({ size: bytes.tangent2D,     usage: usageRW }),
    forceOut:      device.createBuffer({ size: bytes.forceOut,      usage: usageRW }),
    kOut:          device.createBuffer({ size: bytes.kOut,          usage: usageRW }),
    rhsFree:       device.createBuffer({ size: bytes.rhsFree,       usage: usageRW }),
    csrValHi:      device.createBuffer({ size: bytes.csrValHi,      usage: usageRW }),
    csrValLo:      device.createBuffer({ size: bytes.csrValLo,      usage: usageRW }),
    // Persistent material-point state for the plastic Newton.
    sigmaCommitted:  device.createBuffer({ size: bytes.sigmaCommitted,  usage: usageRW }),
    strainCommitted: device.createBuffer({ size: bytes.strainCommitted, usage: usageRW }),
    branchHistory:   device.createBuffer({ size: bytes.branchHistory,   usage: usageRW }),
    uCommitted:      device.createBuffer({ size: bytes.uCommitted,      usage: usageRW }),
    tangentVoigt3:   device.createBuffer({ size: bytes.tangentVoigt3,   usage: usageRW }),
    sigmaTrialBuf:   device.createBuffer({ size: bytes.sigmaTrialBuf,   usage: usageRW }),
    // Uniforms.
    paramsStrain: device.createBuffer({ size: 32, usage: usageU }),
    paramsMc:     device.createBuffer({ size: 32, usage: usageU }),
    paramsForce:  device.createBuffer({ size: 32, usage: usageU }),
    paramsStiff:  device.createBuffer({ size: 32, usage: usageU }),
    paramsRhsScat:device.createBuffer({ size: 32, usage: usageU }),
    paramsCsrScat:device.createBuffer({ size: 32, usage: usageU }),
    paramsTrial:  device.createBuffer({ size: 32, usage: usageU }),
    paramsCommit: device.createBuffer({ size: 32, usage: usageU })
  };

  // -------------------------------------------------------------------------
  // Upload read-only buffers once.
  // -------------------------------------------------------------------------
  device.queue.writeBuffer(buffers.bMatrices,    0, pack.bMatricesPacked);
  device.queue.writeBuffer(buffers.gpWeights,    0, pack.gpWeightsPacked);
  device.queue.writeBuffer(buffers.dofMap,       0, pack.dofMap);
  device.queue.writeBuffer(buffers.matIndex,     0, pack.matIndex);
  device.queue.writeBuffer(buffers.matParams,    0, pack.matParamsPacked);
  device.queue.writeBuffer(buffers.forceIncPtr,  0, pack.forceIncPtr);
  device.queue.writeBuffer(buffers.forceIncList, 0, pack.forceIncList);
  device.queue.writeBuffer(buffers.csrIncPtr,    0, pack.csrIncPtr);
  device.queue.writeBuffer(buffers.csrIncList,   0, pack.csrIncList);

  // -------------------------------------------------------------------------
  // Write static uniform values once (each one is a u32 count + padding).
  // -------------------------------------------------------------------------
  function writeU32Uniform(buffer, value) {
    const u = new ArrayBuffer(16);
    new Uint32Array(u, 0, 1).set([value]);
    device.queue.writeBuffer(buffer, 0, u);
  }
  writeU32Uniform(buffers.paramsStrain, numElements);
  writeU32Uniform(buffers.paramsMc,     numGp);
  writeU32Uniform(buffers.paramsForce,  numElements);
  writeU32Uniform(buffers.paramsStiff,  numElements);
  writeU32Uniform(buffers.paramsRhsScat,numFree);
  writeU32Uniform(buffers.paramsCsrScat,nnz);
  writeU32Uniform(buffers.paramsTrial,  numGp);
  writeU32Uniform(buffers.paramsCommit, numGp);

  return {
    device,
    pack,
    elementType,
    layouts,
    pipes,
    buffers,
    sizes: {
      numElements, numLocalDofs, gpsPerElem, numGp, numFree, nnz,
      numWgGp, numWgElem, numWgElemStiff, numWgFree, numWgNnz
    }
  };
}

// =============================================================================
// Committed-state lifecycle helpers.
//
// These manage the persistent material-point state buffers (σ_committed,
// ε_committed, u_committed, branchHistory) without invoking any kernels —
// the kernels write/read these buffers directly during normal assembly,
// these helpers just seed/snapshot/restore them at phase boundaries.
// =============================================================================

// Zero out all committed state at the start of a fresh analysis.
export function clearCommittedState(ctx) {
  const { device, buffers, sizes, pack } = ctx;
  const zeroSigma = new Float32Array(2 * 6 * sizes.numGp);
  const zeroStrain = new Float32Array(2 * 3 * sizes.numGp);
  const zeroBranch = new Uint32Array(sizes.numGp);
  const zeroU = new Float32Array(2 * sizes.numFree);
  device.queue.writeBuffer(buffers.sigmaCommitted, 0, zeroSigma);
  device.queue.writeBuffer(buffers.strainCommitted, 0, zeroStrain);
  device.queue.writeBuffer(buffers.branchHistory, 0, zeroBranch);
  device.queue.writeBuffer(buffers.uCommitted, 0, zeroU);
}

// Seed σ_committed from a CPU-side Voigt-6 array (length 6 * numGp f64) —
// used after K0 recovery to set the initial geostatic stress.
export function uploadCommittedSigmaFromF64(ctx, sigmaF64) {
  const { device, buffers, sizes } = ctx;
  if (sigmaF64.length !== 6 * sizes.numGp) {
    throw new Error(`uploadCommittedSigmaFromF64: expected 6*numGp=${6*sizes.numGp}, got ${sigmaF64.length}`);
  }
  const packed = new Float32Array(2 * sigmaF64.length);
  for (let i = 0; i < sigmaF64.length; i += 1) {
    const v = Number(sigmaF64[i]) || 0;
    const hi = Math.fround(v);
    packed[2 * i] = hi;
    packed[2 * i + 1] = Math.fround(v - hi);
  }
  device.queue.writeBuffer(buffers.sigmaCommitted, 0, packed);
}

export function uploadCommittedSigmaFromDsArray(ctx, sigmaDsArray) {
  // sigmaDsArray: Array of length 6*numGp, each entry [hi, lo].
  const { device, buffers, sizes } = ctx;
  if (sigmaDsArray.length !== 6 * sizes.numGp) {
    throw new Error(`uploadCommittedSigmaFromDsArray: expected 6*numGp=${6*sizes.numGp}, got ${sigmaDsArray.length}`);
  }
  const packed = new Float32Array(2 * sigmaDsArray.length);
  for (let i = 0; i < sigmaDsArray.length; i += 1) {
    packed[2 * i] = sigmaDsArray[i][0];
    packed[2 * i + 1] = sigmaDsArray[i][1];
  }
  device.queue.writeBuffer(buffers.sigmaCommitted, 0, packed);
}

// Snapshot committed state into a fresh GPU buffer (used by safety to save
// the pre-safety reference state).  Returns { sigmaSnap, strainSnap, branchSnap, uSnap }.
export async function snapshotCommittedState(ctx) {
  const { device, buffers, sizes } = ctx;
  const make = (size) => device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const sigmaSnap  = make(8 * 6 * sizes.numGp);
  const strainSnap = make(8 * 3 * sizes.numGp);
  const branchSnap = make(4 * sizes.numGp);
  const uSnap      = make(8 * sizes.numFree);
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buffers.sigmaCommitted,  0, sigmaSnap,  0, 8 * 6 * sizes.numGp);
  enc.copyBufferToBuffer(buffers.strainCommitted, 0, strainSnap, 0, 8 * 3 * sizes.numGp);
  enc.copyBufferToBuffer(buffers.branchHistory,   0, branchSnap, 0, 4 * sizes.numGp);
  enc.copyBufferToBuffer(buffers.uCommitted,      0, uSnap,      0, 8 * sizes.numFree);
  device.queue.submit([enc.finish()]);
  if (typeof device.queue.onSubmittedWorkDone === 'function') {
    await device.queue.onSubmittedWorkDone();
  }
  return { sigmaSnap, strainSnap, branchSnap, uSnap };
}

// Restore from a previous snapshot.  Used by safety between ΣMsf trials.
export async function restoreCommittedState(ctx, snapshot) {
  const { device, buffers, sizes } = ctx;
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(snapshot.sigmaSnap,  0, buffers.sigmaCommitted,  0, 8 * 6 * sizes.numGp);
  enc.copyBufferToBuffer(snapshot.strainSnap, 0, buffers.strainCommitted, 0, 8 * 3 * sizes.numGp);
  enc.copyBufferToBuffer(snapshot.branchSnap, 0, buffers.branchHistory,   0, 4 * sizes.numGp);
  enc.copyBufferToBuffer(snapshot.uSnap,      0, buffers.uCommitted,      0, 8 * sizes.numFree);
  device.queue.submit([enc.finish()]);
  if (typeof device.queue.onSubmittedWorkDone === 'function') {
    await device.queue.onSubmittedWorkDone();
  }
}

// Read back σ_committed as a flat Float64Array of length 6 * numGp.
export async function readbackCommittedSigma(ctx) {
  const { device, buffers, sizes } = ctx;
  const out = device.createBuffer({ size: 8 * 6 * sizes.numGp, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buffers.sigmaCommitted, 0, out, 0, 8 * 6 * sizes.numGp);
  device.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const packed = new Float32Array(out.getMappedRange().slice(0));
  out.unmap(); out.destroy();
  const f64 = new Float64Array(packed.length >> 1);
  for (let i = 0; i < f64.length; i += 1) f64[i] = packed[2 * i] + packed[2 * i + 1];
  return f64;
}

export async function readbackCommittedDisplacement(ctx) {
  const { device, buffers, sizes } = ctx;
  const out = device.createBuffer({ size: 8 * sizes.numFree, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buffers.uCommitted, 0, out, 0, 8 * sizes.numFree);
  device.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const packed = new Float32Array(out.getMappedRange().slice(0));
  out.unmap(); out.destroy();
  const f64 = new Float64Array(packed.length >> 1);
  for (let i = 0; i < f64.length; i += 1) f64[i] = packed[2 * i] + packed[2 * i + 1];
  return f64;
}

// =============================================================================
// Bind-group factories.  Cheap to allocate; reused across iterations when
// possible by the orchestrator's batch encoder.
// =============================================================================
function bg(device, layout, entries) {
  return device.createBindGroup({ layout, entries });
}
function bge(binding, buffer) { return { binding, resource: { buffer } }; }

// =============================================================================
// Strain → σ + tangent (linear elastic plane-strain).
//
// Mathematical scope of the v1 GPU pipeline.  At first delivery the GPU path
// solves the linear-elastic residual exactly: σ = D_e · ε per Gauss point,
// tangent = D_e (constant, region-keyed).  This is sufficient for the
// initial-stress recovery, the elastic gravity step, and any small-strain
// service-load analysis; it is also the correct degenerate limit of MC for
// admissible trial states (the MC kernel returns σ_returned == σ_trial and
// algorithmicTangent == D_e on the ELASTIC branch).
//
// Plastic-mode wiring: the MC kernel is fully implemented (Phase 7) and
// bind-group layouts for sigmaTrial / sigmaReturned / tangentPrincipal /
// branchKind are pre-allocated in the assembly context.  Switching the
// orchestrator from elastic to plastic requires a) replacing the
// strain-to-stress kernel with a strain-to-trial-stress kernel, b) running
// the MC kernel, and c) routing sigmaReturned + tangentPrincipal into the
// internal-force / stiffness inputs.  That switch is a host-side
// orchestration change, not a kernel change.
// =============================================================================
import { DS_WGSL } from './wgsl/ds.js';

// =============================================================================
// Voigt-6 → Voigt-3 plane-strain stress slicer.
//
// The MC return-mapping kernel emits σ_returned in Voigt-6 layout
// (σxx, σyy, σzz, σxy, σyz, σxz).  The internal-force and stiffness kernels
// consume σ in Voigt-3 (σxx, σyy, σxy).  This kernel slices off the in-plane
// triple — one thread per Gauss point.
// =============================================================================
export const KERNEL_VOIGT6_TO_VOIGT3_STRESS_WGSL = /* wgsl */ `
struct Voigt6to3Params { numGp: u32, _pad0: u32, _pad1: u32, _pad2: u32 };

@group(0) @binding(0) var<storage, read>       sigma6: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> sigma3: array<vec2<f32>>;
@group(0) @binding(2) var<uniform>             params: Voigt6to3Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  if (gp >= params.numGp) { return; }
  sigma3[gp * 3u + 0u] = sigma6[gp * 6u + 0u];   // σxx
  sigma3[gp * 3u + 1u] = sigma6[gp * 6u + 1u];   // σyy
  sigma3[gp * 3u + 2u] = sigma6[gp * 6u + 3u];   // σxy
}
`;

const BGL_VOIGT6_TO_VOIGT3 = { entries: [
  { binding: 0, type: 'read-only-storage' },
  { binding: 1, type: 'storage' },
  { binding: 2, type: 'uniform' }
]};

export const KERNEL_STRAIN_TO_STRESS_WGSL = /* wgsl */ `
${DS_WGSL}

struct Params { numGp: u32, _pad: vec3<u32> };

@group(0) @binding(0) var<storage, read>       strain:    array<vec2<f32>>;   // 3 DS per GP (εxx, εyy, γxy)
@group(0) @binding(1) var<storage, read>       matIndex:  array<u32>;
@group(0) @binding(2) var<storage, read>       matParams: array<vec2<f32>>;   // 8 DS per material
@group(0) @binding(3) var<storage, read_write> stress:    array<vec2<f32>>;   // 3 DS per GP
@group(0) @binding(4) var<storage, read_write> tangent:   array<vec2<f32>>;   // 9 DS per GP
@group(0) @binding(5) var<uniform>             params: Params;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let gp: u32 = gid.x;
  if (gp >= params.numGp) { return; }
  let mi: u32 = matIndex[gp];
  let KBulk: vec2<f32> = matParams[mi * 8u + 6u];
  let G:     vec2<f32> = matParams[mi * 8u + 7u];

  // Plane-strain Voigt-3 elastic D:
  //   D11 = K + 4G/3,  D12 = K - 2G/3,  D33 = G   (γ = 2ε; engineering shear)
  let four_thirds: vec2<f32> = vec2<f32>(1.3333333333333333, 0.0);
  let two_thirds:  vec2<f32> = vec2<f32>(0.6666666666666666, 0.0);
  let D11: vec2<f32> = dsAdd(KBulk, dsMul(four_thirds, G));
  let D12: vec2<f32> = dsAdd(KBulk, dsNeg(dsMul(two_thirds, G)));
  let D33: vec2<f32> = G;

  let exx: vec2<f32> = strain[gp * 3u + 0u];
  let eyy: vec2<f32> = strain[gp * 3u + 1u];
  let gxy: vec2<f32> = strain[gp * 3u + 2u];

  let sxx: vec2<f32> = dsAdd(dsMul(D11, exx), dsMul(D12, eyy));
  let syy: vec2<f32> = dsAdd(dsMul(D12, exx), dsMul(D11, eyy));
  let sxy: vec2<f32> = dsMul(D33, gxy);
  stress[gp * 3u + 0u] = sxx;
  stress[gp * 3u + 1u] = syy;
  stress[gp * 3u + 2u] = sxy;

  // Elastic tangent in Voigt-3 form (row-major).
  let zero: vec2<f32> = vec2<f32>(0.0, 0.0);
  tangent[gp * 9u + 0u] = D11;
  tangent[gp * 9u + 1u] = D12;
  tangent[gp * 9u + 2u] = zero;
  tangent[gp * 9u + 3u] = D12;
  tangent[gp * 9u + 4u] = D11;
  tangent[gp * 9u + 5u] = zero;
  tangent[gp * 9u + 6u] = zero;
  tangent[gp * 9u + 7u] = zero;
  tangent[gp * 9u + 8u] = D33;
}
`;

const BGL_STRAIN_TO_STRESS = { entries: [
  { binding: 0, type: 'read-only-storage' },
  { binding: 1, type: 'read-only-storage' },
  { binding: 2, type: 'read-only-storage' },
  { binding: 3, type: 'storage' },
  { binding: 4, type: 'storage' },
  { binding: 5, type: 'uniform' }
]};

function ensureStrainToStress(ctx) {
  if (ctx._strainToStress) return ctx._strainToStress;
  const layout = bgLayoutFromDescriptor(ctx.device, BGL_STRAIN_TO_STRESS);
  const pipe = compilePipeline(ctx.device, 'gpu-strain-to-stress', KERNEL_STRAIN_TO_STRESS_WGSL, layout);
  ctx._strainToStress = { pipe, layout };
  return ctx._strainToStress;
}

// =============================================================================
// Recording: full assembly pass (strain → strain-to-stress → force → stiffness
// → scatter free RHS → scatter CSR).  After this call, rhsFree, csrValHi,
// csrValLo contain the assembled internal force and tangent.
// =============================================================================
export function recordResidualAndTangent(ctx, encoder) {
  const { device, pipes, buffers, sizes } = ctx;
  // 1. Strain.
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipes.strain.pipeline);
  pass.setBindGroup(0, bg(device, pipes.strain.bgLayout, [
    bge(0, buffers.uvec),
    bge(1, buffers.bMatrices),
    bge(2, buffers.dofMap),
    bge(3, buffers.strain),
    bge(4, buffers.paramsStrain)
  ]));
  pass.dispatchWorkgroups(sizes.numWgGp);
  pass.end();
  // 2-6. strain-to-stress + force + stiffness + scatter.
  recordElasticAssemblyTail(ctx, encoder);
}

// =============================================================================
// Recording: residual-only pass (strain → strain-to-stress → force →
// scatter free RHS).  Stiffness and CSR scatter elided; used during line
// search.
// =============================================================================
export function recordResidualOnly(ctx, encoder) {
  const { device, pipes, buffers, sizes } = ctx;
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipes.strain.pipeline);
  pass.setBindGroup(0, bg(device, pipes.strain.bgLayout, [
    bge(0, buffers.uvec),
    bge(1, buffers.bMatrices),
    bge(2, buffers.dofMap),
    bge(3, buffers.strain),
    bge(4, buffers.paramsStrain)
  ]));
  pass.dispatchWorkgroups(sizes.numWgGp);
  pass.end();
  recordElasticForceTail(ctx, encoder);
}

// =============================================================================
// PLASTIC mode recording.
// strain → strain-to-trial-stress → MC return → voigt6→voigt3 → force →
// stiffness → scatter free RHS → scatter CSR.
//
// All kernels in this chain use distinct uniform buffers; same encoder + one
// submit is safe (no uniform aliasing).
// =============================================================================
export function recordResidualAndTangentPlastic(ctx, encoder) {
  const { device, pipes, buffers, sizes } = ctx;
  // 1. Strain.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.strain.pipeline);
    pass.setBindGroup(0, bg(device, pipes.strain.bgLayout, [
      bge(0, buffers.uvec),
      bge(1, buffers.bMatrices),
      bge(2, buffers.dofMap),
      bge(3, buffers.strain),
      bge(4, buffers.paramsStrain)
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  // 2. Strain → trial stress (Voigt-6).
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.plasticTrial.pipeline);
    pass.setBindGroup(0, bg(device, pipes.plasticTrial.bgLayout, [
      bge(0, buffers.strain),
      bge(1, buffers.strainCommitted),
      bge(2, buffers.sigmaCommitted),
      bge(3, buffers.matIndex),
      bge(4, buffers.matParams),
      bge(5, buffers.sigmaTrialBuf),
      bge(6, buffers.paramsTrial)
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  // 3. MC return mapping: σ_trial → σ_returned + tangentVoigt3 + branchKind.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.mc.pipeline);
    pass.setBindGroup(0, bg(device, pipes.mc.bgLayout, [
      bge(0, buffers.sigmaTrialBuf),
      bge(1, buffers.matIndex),
      bge(2, buffers.matParams),
      bge(3, buffers.sigmaReturned),
      bge(4, buffers.branchKind),
      bge(5, buffers.tangentVoigt3),
      bge(6, buffers.converged),
      bge(7, buffers.paramsMc)
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  // 4. σ Voigt-6 → Voigt-3 slice for the force/stiffness consumers.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.voigt6to3.pipeline);
    pass.setBindGroup(0, bg(device, pipes.voigt6to3.bgLayout, [
      bge(0, buffers.sigmaReturned),
      bge(1, buffers.stressVoigt3),
      bge(2, buffers.paramsMc)            // shares numGp uniform
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  // 5. Internal force per element (consumes stressVoigt3).
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.force.pipeline);
    pass.setBindGroup(0, bg(device, pipes.force.bgLayout, [
      bge(0, buffers.bMatrices),
      bge(1, buffers.gpWeights),
      bge(2, buffers.stressVoigt3),
      bge(3, buffers.forceOut),
      bge(4, buffers.paramsForce)
    ]));
    pass.dispatchWorkgroups(sizes.numWgElem);
    pass.end();
  }
  // 6. Element stiffness (consumes tangentVoigt3 from MC).
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.stiff.pipeline);
    pass.setBindGroup(0, bg(device, pipes.stiff.bgLayout, [
      bge(0, buffers.bMatrices),
      bge(1, buffers.gpWeights),
      bge(2, buffers.tangentVoigt3),
      bge(3, buffers.kOut),
      bge(4, buffers.paramsStiff)
    ]));
    pass.dispatchWorkgroups(sizes.numWgElemStiff);
    pass.end();
  }
  // 7. Scatter to free RHS.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.scatterRhs.pipeline);
    pass.setBindGroup(0, bg(device, pipes.scatterRhs.bgLayout, [
      bge(0, buffers.forceOut),
      bge(1, buffers.forceIncPtr),
      bge(2, buffers.forceIncList),
      bge(3, buffers.rhsFree),
      bge(4, buffers.paramsRhsScat)
    ]));
    pass.dispatchWorkgroups(sizes.numWgFree);
    pass.end();
  }
  // 8. Scatter to CSR.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.scatterCsr.pipeline);
    pass.setBindGroup(0, bg(device, pipes.scatterCsr.bgLayout, [
      bge(0, buffers.kOut),
      bge(1, buffers.csrIncPtr),
      bge(2, buffers.csrIncList),
      bge(3, buffers.csrValHi),
      bge(4, buffers.csrValLo),
      bge(5, buffers.paramsCsrScat)
    ]));
    pass.dispatchWorkgroups(sizes.numWgNnz);
    pass.end();
  }
}

// =============================================================================
// Plastic residual-only pass (no stiffness, no CSR scatter).  Used during
// line search.
// =============================================================================
export function recordResidualOnlyPlastic(ctx, encoder) {
  const { device, pipes, buffers, sizes } = ctx;
  // 1. Strain.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.strain.pipeline);
    pass.setBindGroup(0, bg(device, pipes.strain.bgLayout, [
      bge(0, buffers.uvec),
      bge(1, buffers.bMatrices),
      bge(2, buffers.dofMap),
      bge(3, buffers.strain),
      bge(4, buffers.paramsStrain)
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  // 2. Strain → trial stress.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.plasticTrial.pipeline);
    pass.setBindGroup(0, bg(device, pipes.plasticTrial.bgLayout, [
      bge(0, buffers.strain),
      bge(1, buffers.strainCommitted),
      bge(2, buffers.sigmaCommitted),
      bge(3, buffers.matIndex),
      bge(4, buffers.matParams),
      bge(5, buffers.sigmaTrialBuf),
      bge(6, buffers.paramsTrial)
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  // 3. MC return.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.mc.pipeline);
    pass.setBindGroup(0, bg(device, pipes.mc.bgLayout, [
      bge(0, buffers.sigmaTrialBuf),
      bge(1, buffers.matIndex),
      bge(2, buffers.matParams),
      bge(3, buffers.sigmaReturned),
      bge(4, buffers.branchKind),
      bge(5, buffers.tangentVoigt3),
      bge(6, buffers.converged),
      bge(7, buffers.paramsMc)
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  // 4. Voigt-6 → Voigt-3 slice.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.voigt6to3.pipeline);
    pass.setBindGroup(0, bg(device, pipes.voigt6to3.bgLayout, [
      bge(0, buffers.sigmaReturned),
      bge(1, buffers.stressVoigt3),
      bge(2, buffers.paramsMc)
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  // 5. Internal force.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.force.pipeline);
    pass.setBindGroup(0, bg(device, pipes.force.bgLayout, [
      bge(0, buffers.bMatrices),
      bge(1, buffers.gpWeights),
      bge(2, buffers.stressVoigt3),
      bge(3, buffers.forceOut),
      bge(4, buffers.paramsForce)
    ]));
    pass.dispatchWorkgroups(sizes.numWgElem);
    pass.end();
  }
  // 6. Scatter to free RHS only.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.scatterRhs.pipeline);
    pass.setBindGroup(0, bg(device, pipes.scatterRhs.bgLayout, [
      bge(0, buffers.forceOut),
      bge(1, buffers.forceIncPtr),
      bge(2, buffers.forceIncList),
      bge(3, buffers.rhsFree),
      bge(4, buffers.paramsRhsScat)
    ]));
    pass.dispatchWorkgroups(sizes.numWgFree);
    pass.end();
  }
}

// =============================================================================
// Commit-state recording.  Persists σ_returned → σ_committed and current
// strain → strain_committed, plus branch history.  Run ONCE per accepted
// load increment (after Newton converges).  Caller supplies the encoder.
// =============================================================================
export function recordCommitState(ctx, encoder) {
  const { device, pipes, buffers, sizes } = ctx;
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipes.commitState.pipeline);
  pass.setBindGroup(0, bg(device, pipes.commitState.bgLayout, [
    bge(0, buffers.sigmaReturned),
    bge(1, buffers.strain),
    bge(2, buffers.branchKind),
    bge(3, buffers.sigmaCommitted),
    bge(4, buffers.strainCommitted),
    bge(5, buffers.branchHistory),
    bge(6, buffers.paramsCommit)
  ]));
  pass.dispatchWorkgroups(sizes.numWgGp);
  pass.end();
}

// Commit u ← u_trial.  Used by the Newton orchestrator after line search
// accepts the trial step (parallels the σ commit, but for the displacement).
// Implemented via copyBufferToBuffer (no kernel needed).
export function recordCommitDisplacement(ctx, encoder) {
  encoder.copyBufferToBuffer(ctx.buffers.uvec, 0, ctx.buffers.uCommitted, 0, 8 * ctx.sizes.numFree);
}

function recordElasticAssemblyTail(ctx, encoder) {
  const { device, pipes, buffers, sizes } = ctx;
  // 2. strain → stress + tangent (elastic D per region).
  const sts = ensureStrainToStress(ctx);
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(sts.pipe.pipeline);
    pass.setBindGroup(0, bg(device, sts.pipe.bgLayout, [
      bge(0, buffers.strain),
      bge(1, buffers.matIndex),
      bge(2, buffers.matParams),
      bge(3, buffers.stressVoigt3),
      bge(4, buffers.tangent2D),
      bge(5, buffers.paramsMc)  // shares numGp uniform
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  // 3. internal force per element.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.force.pipeline);
    pass.setBindGroup(0, bg(device, pipes.force.bgLayout, [
      bge(0, buffers.bMatrices),
      bge(1, buffers.gpWeights),
      bge(2, buffers.stressVoigt3),
      bge(3, buffers.forceOut),
      bge(4, buffers.paramsForce)
    ]));
    pass.dispatchWorkgroups(sizes.numWgElem);
    pass.end();
  }
  // 4. element stiffness.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.stiff.pipeline);
    pass.setBindGroup(0, bg(device, pipes.stiff.bgLayout, [
      bge(0, buffers.bMatrices),
      bge(1, buffers.gpWeights),
      bge(2, buffers.tangent2D),
      bge(3, buffers.kOut),
      bge(4, buffers.paramsStiff)
    ]));
    pass.dispatchWorkgroups(sizes.numWgElemStiff);
    pass.end();
  }
  // 5. scatter to free RHS.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.scatterRhs.pipeline);
    pass.setBindGroup(0, bg(device, pipes.scatterRhs.bgLayout, [
      bge(0, buffers.forceOut),
      bge(1, buffers.forceIncPtr),
      bge(2, buffers.forceIncList),
      bge(3, buffers.rhsFree),
      bge(4, buffers.paramsRhsScat)
    ]));
    pass.dispatchWorkgroups(sizes.numWgFree);
    pass.end();
  }
  // 6. scatter to CSR.
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.scatterCsr.pipeline);
    pass.setBindGroup(0, bg(device, pipes.scatterCsr.bgLayout, [
      bge(0, buffers.kOut),
      bge(1, buffers.csrIncPtr),
      bge(2, buffers.csrIncList),
      bge(3, buffers.csrValHi),
      bge(4, buffers.csrValLo),
      bge(5, buffers.paramsCsrScat)
    ]));
    pass.dispatchWorkgroups(sizes.numWgNnz);
    pass.end();
  }
}

function recordElasticForceTail(ctx, encoder) {
  const { device, pipes, buffers, sizes } = ctx;
  const sts = ensureStrainToStress(ctx);
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(sts.pipe.pipeline);
    pass.setBindGroup(0, bg(device, sts.pipe.bgLayout, [
      bge(0, buffers.strain),
      bge(1, buffers.matIndex),
      bge(2, buffers.matParams),
      bge(3, buffers.stressVoigt3),
      bge(4, buffers.tangent2D),
      bge(5, buffers.paramsMc)
    ]));
    pass.dispatchWorkgroups(sizes.numWgGp);
    pass.end();
  }
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.force.pipeline);
    pass.setBindGroup(0, bg(device, pipes.force.bgLayout, [
      bge(0, buffers.bMatrices),
      bge(1, buffers.gpWeights),
      bge(2, buffers.stressVoigt3),
      bge(3, buffers.forceOut),
      bge(4, buffers.paramsForce)
    ]));
    pass.dispatchWorkgroups(sizes.numWgElem);
    pass.end();
  }
  {
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipes.scatterRhs.pipeline);
    pass.setBindGroup(0, bg(device, pipes.scatterRhs.bgLayout, [
      bge(0, buffers.forceOut),
      bge(1, buffers.forceIncPtr),
      bge(2, buffers.forceIncList),
      bge(3, buffers.rhsFree),
      bge(4, buffers.paramsRhsScat)
    ]));
    pass.dispatchWorkgroups(sizes.numWgFree);
    pass.end();
  }
}

// =============================================================================
// Convenience: upload a free-DOF Float64Array into the uvec buffer.
// =============================================================================
import { packDsVector } from './resident-buffers.js';

export function uploadDisplacement(ctx, uF64) {
  ctx.device.queue.writeBuffer(ctx.buffers.uvec, 0, packDsVector(uF64));
}

// Read back the assembled CSR values from device into a CPU-side
// `{ rowPtr, colInd, valHi, valLo }` triple (mirroring the resident-buffers
// CSR pack format).
export async function readbackCsr(ctx) {
  const { device, buffers, pack } = ctx;
  const valHi = device.createBuffer({ size: buffers.csrValHi.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const valLo = device.createBuffer({ size: buffers.csrValLo.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buffers.csrValHi, 0, valHi, 0, buffers.csrValHi.size);
  enc.copyBufferToBuffer(buffers.csrValLo, 0, valLo, 0, buffers.csrValLo.size);
  device.queue.submit([enc.finish()]);
  await Promise.all([
    valHi.mapAsync(GPUMapMode.READ),
    valLo.mapAsync(GPUMapMode.READ)
  ]);
  const hi = new Float32Array(valHi.getMappedRange().slice(0));
  const lo = new Float32Array(valLo.getMappedRange().slice(0));
  valHi.unmap(); valLo.unmap(); valHi.destroy(); valLo.destroy();
  return {
    rowPtr: pack.csrRowPtr,
    colInd: pack.csrColInd,
    valHi: hi,
    valLo: lo,
    nnz: pack.nnz,
    dim: pack.numFree
  };
}

export async function readbackRhsFree(ctx) {
  const { device, buffers } = ctx;
  const out = device.createBuffer({ size: buffers.rhsFree.size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyBufferToBuffer(buffers.rhsFree, 0, out, 0, buffers.rhsFree.size);
  device.queue.submit([enc.finish()]);
  await out.mapAsync(GPUMapMode.READ);
  const packed = new Float32Array(out.getMappedRange().slice(0));
  out.unmap(); out.destroy();
  const n = packed.length >> 1;
  const f64 = new Float64Array(n);
  for (let i = 0; i < n; i += 1) f64[i] = packed[2 * i] + packed[2 * i + 1];
  return f64;
}
