# GPU Pipeline v2 — matrix-free, single-handoff

GPU pipeline v2 is an **additional** pipeline that runs alongside the existing v1
(`../gpu-controller.js`) and the CPU solver (`../../solver.js`). v2 is opt-in;
neither v1 nor the CPU path is touched.

## Why v2 exists

v1 is bandwidth-bound. Per Newton iteration it:

1. assembles the global stiffness matrix `K` in CSR (one nonzero per off-diagonal
   element) into device memory — ~29 dispatches, including element K_e and a
   scatter into the CSR pack;
2. preconditioner extraction: 2×2 nodal block-Jacobi inverse from the assembled
   CSR;
3. CG matvec over the CSR for every linear-solve iteration — irregular `colInd`
   reads dominate;
4. CPU readback of residual norm to test convergence.

For a 10 k-DOF, ~50-nonzero-per-row mesh, each CSR matvec reads ~4 MB from VRAM;
500 CG iterations = 2 GB of VRAM traffic per linear solve. Add the assembly
phase and this is the hot path.

v2 eliminates the global K. It's matrix-free: `K·x` is recomputed from element
data on every matvec by integrating `Bᵀ D B u_e` element-wise and scattering to
nodes through a precomputed incidence list. The same buffers and the same
incidence list back internal force (`F_int = ∑_e Bᵀσ`), residual computation,
and Jacobi diagonal extraction.

## Implementation status

| Part | Status |
|---|---|
| Design + file layout | ✅ |
| Element-major buffer pack (re-used from v1's `gpu-mesh-pack.js`) | ✅ |
| Per-GP elastic `D` precompute (one-shot at upload) | ✅ |
| Matrix-free Kx WGSL kernel (B-major loop, element-scatter slots) | ✅ |
| Node-side scatter (re-uses v1's `forceIncPtr`/`forceIncList`) | ✅ |
| Diagonal Jacobi diag(K) via element-scatter + node-side reduce | ✅ |
| Matrix-free CG (DS) with Jacobi preconditioner | ✅ |
| Production controller `runFullDeformationAnalysisOnGpuV2()` | ✅ |
| Newton outer loop (algorithmic tangent by default, elastic fallback option) | ✅ |
| BiCGStab fallback | ✅ |
| Per-GP MC return mapping wired into v2 | ✅ |
| Block-Jacobi (2×2 nodal) preconditioner | ✅ |
| Geostatic, service-load, and c-phi safety staging | ✅ |
| CPU/v1-independent result handoff | ✅ |

The matrix-free kernels and plastic Newton loop are parity-tested against v1
and CPU references by `scripts/verify_gpu_v2_parity.mjs`. Browser hardware
verification is in `scripts/verify_gpu_v2_hardware.mjs`.

## Architecture summary

```
                 ┌──────────────────────────────────────────────┐
   1× upload     │ static: B-matrices, gpWeights, dofMap,       │
   (handoff in)  │         matParams, matIndex, dPerGp,         │
                 │         forceIncPtr/List, dirichletMask      │
                 └──────────────────────────────────────────────┘
                                       │
                 ┌──────────────────────────────────────────────┐
   resident      │ - precompute D per GP                        │
   Newton        │ - staged geostatic/service/safety solves      │
   loop          │ - local MC return mapping at every GP         │
                 │ - internal force and residual on device      │
                 │ - CG primary, BiCGStab for unsymmetric active│
                 │   plasticity and as fallback                 │
                 │ - Jacobi or 2×2 block-Jacobi preconditioner  │
                 │ - GPU line-search residual trials            │
                 └──────────────────────────────────────────────┘
                                       │
   1× readback   ┌──────────────────────────────────────────────┐
   (handoff out) │ active/base/service vectors + GP stress state│
                 └──────────────────────────────────────────────┘
```

## Memory layout (10 k-DOF target, T3, ~9700 elements)

| Buffer | Size |
|---|---|
| static B-matrices | 1.4 MB |
| static dofMap | 233 kB |
| static gpWeights | 78 kB |
| static matParams + matIndex | 40 kB |
| static forceIncPtr + List | 160 kB |
| static dPerGp (elastic, 6 DS per GP) | 466 kB |
| mutable tangentVoigt3 (algorithmic, 9 DS per GP) | 699 kB |
| mutable u, r, p, Ap, b, z (DS, free-DOF length) | 470 kB |
| mutable diag_global (DS, free-DOF length) | 78 kB |
| mutable elemScatter (DS, 6 dofs/elem) | 470 kB |
| mutable convergedFlag, residualNorm | <1 kB |
| **Total** | ~4.3 MB |

vs. v1: ~10 MB+ (CSR alone).

## Key design decisions

**No atomic scatter.** WGSL has no `atomicAdd<f32>`. Both Kx and internal-force
write per-element results to a scratch buffer (`elemScatter`); a separate
node-side kernel sums each free DOF's contributions through a precomputed
incidence list (`forceIncPtr`, `forceIncList`). This list already exists in v1
for the same purpose.

**GPU-resident vector work.** Kx, preconditioner application, residual
construction, internal force, local return stats, and DS reductions all run on
WebGPU buffers. The driver reads back only scalar convergence diagnostics and
the final result fields needed by the existing solver contract. Krylov dot
readbacks are batched where dependencies allow it.

**Algorithmic tangent in v2.** The MC return kernel emits a 3×3 plane-strain
algorithmic tangent per Gauss point. Production v2 feeds that 9-slot full
tangent directly into matrix-free Kx and block-Jacobi. This is what keeps hard
plastic cases from behaving like a slow elastic modified-Newton solve. The old
elastic 6-slot tangent path remains available through `v2UseElasticTangent`.

**DS precision preserved.** `vec2<f32>` per scalar everywhere. Re-uses
`wgsl/ds.js` (`dsAdd`, `dsMul`, `dsRecip`) — the same primitives v1 uses, so
parity with v1/CPU is exact at the scalar level.

**Re-use, don't rewrite.** v2 calls into v1's `buildGpuMeshPack`,
`KERNEL_INTERNAL_FORCE_*`, `KERNEL_SCATTER_FREE_RHS_WGSL`, and the verified
Mohr-Coulomb return-mapping kernel. Only the matrix-free Kx, v2 state driver,
and v2 preconditioner kernels are new.

## Selecting v1 vs v2

```js
import { runDeformationOnGpu }   from '../gpu-controller.js';      // v1 (CSR)
import { runFullDeformationAnalysisOnGpuV2 } from './v2/gpu-v2-controller.js';
```

The public solver selects this path with `options.useNewGpuPipeline === true`
and `options.gpuPipelineVersion === 'v2'`.
