# GPU offload analysis — deformation solver

## Call-graph reality

The worker is trivial — it just forwards to `analyzeDeformationModel` in [../../src/lib/cpt-app/deformation/solver.js](../../src/lib/cpt-app/deformation/solver.js). The actual cost lives in three nested loops:

```
solveNonlinearPhase              (outer: continuation steps)
 └─ assembleNonlinearSystem      (per Newton iteration: loop over N_el elements)
 │    └─ recoverElementMaterialResponse → materialModel.update()  ← MC return-map
 │    └─ elementStiffnessT3FromBAndArea (6×6 = B^T D B · A)
 │    └─ elementInternalForceVector (6 = B^T σ · A)
 │    └─ addMatrixBlockToCompressedRows / addVectorBlockToFreeRhs (scatter)
 └─ solveCg / solveBiCgStab / solveGmresScaled   (inner: 100s–1000s iters)
      └─ sparseMatVec  ← dominates linear-elastic & inner loop
```

Plus `performArmijoLineSearch` ([solver.js:1424](../../src/lib/cpt-app/deformation/solver.js#L1424)) which re-runs assembly up to 5× per Newton step.

## Where time actually goes

For a typical T3 mesh (1k–5k elements, 2k–10k DOFs, ~20 nnz/row) you pay:

| Block | Cost profile | Invocations per run |
|---|---|---|
| **`sparseMatVec`** ([solver.js:240](../../src/lib/cpt-app/deformation/solver.js#L240)) | O(nnz) = ~20·N_dof per call, pure BLAS-2 | every Krylov iter × every Newton iter × every load step = 10⁴–10⁶ |
| **Element assembly loop** ([solver.js:1352-1399](../../src/lib/cpt-app/deformation/solver.js#L1352-L1399)) | O(N_el · (MC-update + 36 FMA)) | every Newton iter × load step × line-search probe |
| **MC return-map** ([material-models.js:1519](../../src/lib/cpt-app/deformation/material-models.js#L1519) `solveExactMcActiveSetReturn`) | Heavy branching, iterative, ~40 inner iters, eigendecomp, active-set selection | per element per assembly |
| Sparse scatter into CSR | O(36·N_el) writes to shared rows | per assembly |
| Krylov vector ops (dot, axpy) | O(N_dof) | per Krylov iter |

## Ranked GPU offload candidates (with GPU.js in mind)

### Tier 1 — big, obvious wins

**1. `sparseMatVec` — the Krylov inner kernel.**
- It is called in every iteration of [solveCg](../../src/lib/cpt-app/deformation/solver.js#L405), [solveBiCgStab](../../src/lib/cpt-app/deformation/solver.js#L534), and [solveGmresScaled](../../src/lib/cpt-app/deformation/solver.js#L875).
- Perfectly parallel by row; no data dependency across rows.
- Matrix is reused across many iters → upload once per Newton step, then amortize.
- For GPU.js: pack rows in **ELLPACK** (pad each row to `max_nnz` with `col = 0`, `val = 0`). Row widths in T3 meshes are uniform enough (~14–22) that padding waste is ~20%.
- **Caveat — precision**: GPU.js on WebGL2 is f32 by default. The CG in this code already converges at rel-tol 1e-5 ([CG_REL_TOL](../../src/lib/cpt-app/deformation/solver.js#L39)), which is near the f32 edge for ill-conditioned MC tangents. Two practical mitigations:
  - **Mixed-precision**: matvec on GPU in f32, residual recomputed on CPU in f64 every N iters (flexible GMRES / iterative refinement style).
  - **Double-single emulation**: pass values as hi/lo f32 pairs. GPU.js supports this but you lose ~4× throughput.
- **Expected speedup**: 3–10× on meshes with 3k+ DOFs; break-even is around 1k DOFs because of kernel-launch overhead.

### Tier 2 — worthwhile, less dominant

**2. Per-element strain `ε = B·u_e` and internal force `f_e = B^T σ · A`.**
- Called from [buildElementAnalysisState](../../src/lib/cpt-app/deformation/solver.js#L1114) and [elementInternalForceVector](../../src/lib/cpt-app/deformation/solver.js#L822).
- Pure data-parallel across elements, branch-free, fixed shape (6-vector in, 3- or 6-vector out).
- Pre-pack per-element `B` (3×6 = 18 floats) and `dofs` (6 ints) into GPU buffers at mesh build time.
- **Caveat**: `gather` of `u_e[i] = U[dofs[i]]` requires indirect reads; GPU.js handles this via a sampler (fine).
- **Expected speedup**: 2–5× on assembly when MC branch is light (mostly elastic).

**3. Elastic stiffness `K_e = A · B^T D B`** for linear-elastic regions and the initial geostatic solve.
- Done in [elementStiffnessT3FromBAndArea](../../src/lib/cpt-app/deformation/element-t3.js#L44) — 216 FMAs per element, branch-free.
- For the initial geostatic solve (where `D` is constant elastic), this is the assembly hot path.
- **Caveat**: the *scatter* into `compressedRows` ([solver.js:801](../../src/lib/cpt-app/deformation/solver.js#L801)) is a write-conflict zone. Keep scatter on CPU using the existing `assemblyLocalSlots` pattern — just compute the 36 element values on GPU and scatter on CPU. For T3/2D that's 36·N_el scalars round-tripped per assembly — worth it only for large meshes.

### Tier 3 — only if you batch aggressively

**4. Krylov BLAS-1 (dot, axpy, norm).**
- Individually they're too small. But if you fuse `alpha = rz/pAp; x += alpha·p; r -= alpha·Ap; residualNorm²; rzNew = r·z` into a **single GPU.js kernel** (using `kernelMap`), you can amortize one launch over several reductions.
- GPU.js reductions need multiple passes (log n) — clunky.
- **Expected speedup**: marginal; implement only after tier 1 is shipped.

### Do NOT offload

- **MC return mapping** ([material-models.js:1519](../../src/lib/cpt-app/deformation/material-models.js#L1519)): active-set selection, variable-length iterative loops, dense condition-number checks, conditional branches by surface topology, and needs f64. Data-dependent control flow kills GPU throughput. GPU.js specifically cannot compile such code.
- **Sparse CSR assembly / scatter into `compressedRows`**: requires atomics on shared rows. WebGL2 has no integer/float atomics usable in GPU.js. (WebGPU could, but GPU.js's WebGPU backend is immature.) Keep on CPU.
- **Adaptive continuation / line-search control flow**: orchestration logic, runs ~dozens of times per run — too little to gain.
- **Eigendecomposition / principal stress projectors** ([material-models.js:561](../../src/lib/cpt-app/deformation/material-models.js#L561)): branch-heavy, f64-sensitive, and only ~50 flops per element — not worth the marshalling.

## Practical recommendations

**Implementation phasing** (in order of ROI):

1. **Feature-flag** via `options.useGpuAcceleration` (propagated from UI → `analyzeDeformationModel` → passed through to solver stages). Default off; detect capability (`typeof GPU !== 'undefined'` + test kernel compilation) and grey-out toggle if unavailable.
2. **Size gate**: auto-skip GPU path when `N_dof < ~1500` — launch overhead dominates below that. Expose the threshold as a constant.
3. **Phase 1**: GPU `sparseMatVec` with ELLPACK layout and mixed-precision (GPU f32 matvec + CPU f64 residual). Ship this first — it hits CG/BiCGStab/GMRES simultaneously.
4. **Phase 2**: GPU element kernels for strain and internal-force. Keep scatter, keep MC update on CPU.
5. **Phase 3** (optional): elastic-only `K_e` kernel for the geostatic initialization phase.
6. **Do not** attempt GPU MC return mapping or GPU assembly scatter in GPU.js — wrong tool.

**Precision strategy.** Before shipping, run the verification suite [../../scripts/verify_deformation_phase_1.mjs](../../scripts/verify_deformation_phase_1.mjs) with GPU on and compare against CPU. If Krylov iteration counts balloon with f32 matvec, switch to double-single or drop to CPU for MC-active phases only.

**GPU.js vs WebGPU.** GPU.js is the pragmatic choice today for SvelteKit/Vite: npm install, no vendor-specific code, WebGL2 baseline everywhere. If you later hit f32 precision walls, the natural next step is a hand-written WebGPU compute shader for matvec (skip GPU.js entirely for that kernel). Architect the toggle so the "GPU backend" is a module you can swap without touching the solver.

**Rough expected end-to-end improvement** on a 4k-element mesh with MC plasticity active: 1.5–3× total wall-clock. On a linear-elastic geostatic init on the same mesh: 3–6×. The MC return map stays CPU-bound and will dominate any MC-heavy run — don't oversell the toggle to users doing safety analysis on small meshes.

## Toggle contract

- **Option key**: `options.useGpuAcceleration` (boolean; default `false`).
- **Capability detection**: a small probe module that (a) checks `typeof GPU !== 'undefined'`, (b) tries to compile a trivial kernel, (c) checks `EXT_color_buffer_float` for f32 render targets. On any failure, report "unavailable" and force the CPU path.
- **Size gate**: when `useGpuAcceleration === true` but `N_dof < GPU_MIN_DOF` (constant, suggested 1500), silently stay on CPU and log one info-level warning.
- **UI**: grey-out / disable the toggle when the capability probe reports unavailable; show the reason in a tooltip.
- **Backend abstraction**: a `linearAlgebraBackend` object with `matvec`, `elementStrain`, `elementInternalForce` methods. CPU backend ports the existing functions verbatim. GPU backend is loaded lazily so users without the dependency never pay the import cost.
- **Fallback**: any GPU kernel that throws (out-of-memory, context loss, NaN detected) flips the run to CPU for the remainder of the phase and surfaces a warning in the solver outcome.

## Stage 2 addendum — applying the plan to the full elastoplastic solve

"Stage 2" = exact Mohr-Coulomb active-set return ([material-models.js:1519 `solveExactMcActiveSetReturn`](../../src/lib/cpt-app/deformation/material-models.js#L1519)). It changes the hot-path profile in five ways:

1. **Unsymmetric global tangent** — only [solveBiCgStab](../../src/lib/cpt-app/deformation/solver.js#L534) or [solveGmresScaled](../../src/lib/cpt-app/deformation/solver.js#L875) are usable; CG is excluded.
2. **Per-element `D` (algorithmic tangent) is recomputed every Newton iter** by the return-map, not reused across iterations.
3. **Tangents are near-singular at active-set transitions**, tightening the precision margin of any f32 arithmetic.
4. **Armijo line search fires up to ~5× per Newton step** ([performArmijoLineSearch](../../src/lib/cpt-app/deformation/solver.js#L1424)), multiplying assembly frequency.
5. **MC return map dominates element-level CPU cost** — roughly 10–100× more expensive per element than the assembly arithmetic around it.

### Tier-by-tier re-ranking for Stage 2

| Kernel | Elastic-only | Stage 2 full EP |
|---|---|---|
| `sparseMatVec` (CG/BiCGStab/GMRES) | Tier 1 | Tier 1, **mixed-precision required** |
| Per-element `B·u` strain | Tier 2 | Tier 2 (amortizes *better* via Armijo re-probes) |
| Per-element `B^T σ · A` internal force | Tier 2 | Tier 2, consider fusing residual norm |
| Per-element `K_e` | Tier 3 on geostatic init | **Demoted** — `D` changes every iter; upload/download dwarfs 216 FMAs/element |
| MC return map | n/a | CPU only |
| Global scatter | CPU only | CPU only |
| Jacobi preconditioner | Tier 3 fusion | Tier 3 fusion |
| ILU(0) preconditioner (future) | CPU only | CPU only |

### Stage-2-specific additions

- **Residual-norm fusion in the line search.** [performArmijoLineSearch](../../src/lib/cpt-app/deformation/solver.js#L1424) re-evaluates `‖R‖₂` per probe ([solver.js:1469](../../src/lib/cpt-app/deformation/solver.js#L1469)). When the internal-force kernel already runs on GPU, compute `‖r‖²` in the same kernel and return just the scalar. Saves one GPU→CPU roundtrip per Armijo probe, ~5× per Newton step.
- **Preconditioner apply.** Current Jacobi apply is trivially parallel and fuses with matvec. If the planned ILU(0) upgrade from [solver_robustness_path_following.md §5.3](solver_robustness_path_following.md) lands, its back-substitution is inherently sequential and becomes a bad GPU kernel — keep the apply on CPU and restrict GPU to matvec.
- **Matrix upload cadence.** In Stage 2, upload the CSR/ELLPACK matrix **once per Newton iter** (not per Krylov iter). Values change per assembly; the sparsity pattern is fixed at mesh build time, so only the `values` buffer needs re-uploading.

### Precision strategy under Stage 2

Near-singular tangents amplify f32 roundoff in BiCGStab (breakdown risk) and GMRES (Arnoldi orthogonality loss). Two-stage rollout:

1. Ship with **mixed-precision matvec** by default: GPU f32 matvec, CPU f64 residual refresh every `K` Krylov iters (suggested `K = 25`, matching [CG_CHECKPOINT_INTERVAL](../../src/lib/cpt-app/deformation/solver.js#L42)).
2. If iteration counts on the Stage-2 regression benchmarks in [verify_deformation_phase_1.mjs](../../scripts/verify_deformation_phase_1.mjs) grow by more than ~1.5× vs CPU f64 baseline, switch that phase to **double-single emulation** (values as hi/lo f32 pairs) — accept the ~4× matvec-throughput hit in exchange for stability.

### Expected wall-clock

- 4k-element mesh, elastic geostatic init: **3–6×** speedup (matvec and `K_e` both on GPU, `D` constant).
- 4k-element mesh, Stage 2 service loading: **1.3–2×** speedup. Return-map is the floor; GPU only accelerates the ~20–30% of time spent in matvec and per-element strain/force.
- 4k-element mesh, Stage 2 safety (widespread plasticity): **1.1–1.5×**. Almost all time is return-map.

UI copy for the toggle should set this expectation explicitly so users running safety analyses don't over-attribute gains.

## Data layout

The CSR rows produced by [buildCompressedAssemblyPattern](../../src/lib/cpt-app/deformation/solver.js#L1017) are heterogeneous in length. GPU.js wants rectangular inputs. Convert once per mesh into ELLPACK:

- `max_nnz = max over rows of row.indices.length` (typically 14–22 for T3).
- `gpu_cols : Int32Array(N_rows × max_nnz)` — column indices, padded with `0`.
- `gpu_vals : Float32Array(N_rows × max_nnz)` — values, padded with `0.0`. Padded `(col=0, val=0)` contributes nothing to the dot product.
- `gpu_vals_hi, gpu_vals_lo : Float32Array(N_rows × max_nnz)` — only allocated when double-single emulation is active.
- `gpu_x : Float32Array(N_dof)` — input vector. Re-uploaded per Krylov iter.
- `gpu_y : Float32Array(N_rows)` — output vector. Downloaded per Krylov iter.

Pattern buffers (`gpu_cols`, row layout) are built once at mesh-build time alongside [buildCompressedAssemblyPattern](../../src/lib/cpt-app/deformation/solver.js#L1017). Only `gpu_vals` is rewritten per Newton iter; the sparsity pattern never changes within a run.

Element kernels need three mesh-time buffers:

- `gpu_B : Float32Array(N_el × 18)` — row-major B-matrices baked at [buildDeformationElementCaches](../../src/lib/cpt-app/deformation/solver.js#L993).
- `gpu_dofs : Int32Array(N_el × 6)` — global DOF indices per element.
- `gpu_area : Float32Array(N_el)`.

Per-iteration element inputs:

- `gpu_U : Float32Array(N_dof)` — current trial displacement.
- `gpu_sigma : Float32Array(N_el × 3)` — per-element 2D effective stress from the CPU return-map (only when computing internal force on GPU).

Per-iteration outputs:

- `gpu_strain : Float32Array(N_el × 3)` — `ε_xx, ε_yy, γ_xy`.
- `gpu_f_elem : Float32Array(N_el × 6)` — per-element internal force contribution. **Scatter stays on CPU**; the GPU returns the per-element vector and CPU writes via the existing `freeRowIndices` / `assemblyLocalSlots` pattern.

## Mixed-precision matvec loop

Pseudocode for the Krylov inner loop with residual refresh. Replaces the `sparseMatVec` calls inside [solveCg](../../src/lib/cpt-app/deformation/solver.js#L455), [solveBiCgStab](../../src/lib/cpt-app/deformation/solver.js#L617), and [solveGmresScaled](../../src/lib/cpt-app/deformation/solver.js#L948):

```text
upload gpu_vals := values(rows) as Float32    # once per Newton iter
for k = 1..maxIter:
  upload gpu_x := x_f64 as Float32              # per Krylov iter
  run ellpack_matvec kernel → gpu_y
  download y_f32 := gpu_y
  # lift to f64 for all reductions / updates
  if k % K_refresh == 0:
    # CPU f64 residual recompute: r = rhs - A·x_f64 using CPU sparseMatVec
    r_f64 := rhs - cpu_sparseMatVec(rows, x_f64)
  else:
    # use the GPU-derived residual path (standard Krylov update in f64)
    r_f64 := r_f64 - alpha · y_f64
  # rest of the Krylov step (dot, axpy, beta) stays CPU/f64
```

Rationale: update vectors stay in f64 on CPU, so the accumulation of small `alpha·A·p` corrections does not lose digits. Only the single `A·v` kernel runs in f32. The CPU refresh every `K_refresh` iterations resets any drift between the f32-approximated residual and the true f64 residual.

Suggested defaults: `K_refresh = 25` (matches [CG_CHECKPOINT_INTERVAL](../../src/lib/cpt-app/deformation/solver.js#L42)), escalated to `10` under Stage 2 if breakdown-and-restart counts in BiCGStab exceed baseline.

## Capability probe

```text
async function probeGpuBackend():
  try:
    if typeof GPU === 'undefined': return { ok: false, reason: 'gpu.js-not-loaded' }
    gpu = new GPU({ mode: 'webgl2' })
    # check float render target support
    if !gpu.getMode().includes('webgl') or
       !gl.getExtension('EXT_color_buffer_float'): return { ok: false, reason: 'float-rt-missing' }
    # trivial kernel compile + run
    k = gpu.createKernel(function(a) { return a[this.thread.x] * 2.0 }).setOutput([4])
    y = k([1, 2, 3, 4])
    if !approxEqual(y, [2, 4, 6, 8]): return { ok: false, reason: 'kernel-output-mismatch' }
    return { ok: true, mode: gpu.getMode(), maxTextureSize: gpu.context.MAX_TEXTURE_SIZE }
  catch err:
    return { ok: false, reason: err.message }
```

Run once at worker start, cache the result, attach `{ ok, reason, mode }` to the solver output so the UI can display *why* the toggle is disabled.

## Failure modes and mitigations

| Failure | Symptom | Mitigation |
|---|---|---|
| WebGL2 context loss mid-run | Kernel throws or returns zeros | Catch inside the backend wrapper, flip to CPU for the remainder of the phase, annotate solver outcome with `gpu-fallback-context-loss`. |
| f32 underflow on very small strains | Internal-force residual stalls at ~1e-4 instead of 1e-5 | Lift residual norm to f64 on CPU (already in the mixed-precision plan). If still stalling, force double-single path. |
| BiCGStab breakdown spike under Stage 2 | `rhoNew` denormal warnings, restart count climbs | Reduce `K_refresh`; if still unstable, route Stage 2 matvec through double-single emulation. |
| Large `max_nnz` on pathological meshes | Excessive ELLPACK padding, slow kernel | Detect `padding_ratio > 2.0` at build time; fall back to CPU matvec for the phase and warn. |
| Texture size limit exceeded | `N_rows × max_nnz > MAX_TEXTURE_SIZE²` | Detect at upload; fall back to CPU matvec. For realistic meshes (N_dof < 10⁵, max_nnz < 30) this is never hit. |
| GPU driver returns NaN silently | Krylov norm becomes NaN | Guard every kernel download with `Number.isFinite` scan; on any NaN, fall back to CPU for the remainder of the run. |

## Verification hooks

Extend [verify_deformation_phase_1.mjs](../../scripts/verify_deformation_phase_1.mjs) with a GPU-parity gate, guarded by a CLI flag so it stays opt-in (and CI can run CPU-only on headless runners):

- For each existing benchmark, run twice: `useGpuAcceleration: false` (baseline) and `useGpuAcceleration: true` (GPU path, mixed-precision).
- Pass criteria:
  - Final settlements within **1e-5 relative** on elastic runs, **1e-3 relative** on Stage 2 runs.
  - Krylov iteration count within **1.5×** of baseline on Stage 2 (tighter on elastic).
  - Final solver outcome class identical (e.g., both `equilibrium-converged`, or both `mechanism-developed`).
  - Reported FoS within **1e-2** on safety benchmarks.
- Add a **limit-point benchmark** (Section 9.7 of [solver_robustness_path_following.md](solver_robustness_path_following.md)) once arc-length ships, so the GPU path is exercised through a limit-point traversal before being defaulted on.

## Rollout checklist

1. Add `options.useGpuAcceleration` wiring from UI → controller → worker → solver; default `false`.
2. Build the capability probe; expose result in solver output; wire into UI tooltip.
3. Extract `linearAlgebraBackend` abstraction in [solver.js](../../src/lib/cpt-app/deformation/solver.js) so `sparseMatVec`, `elementStrain`, `elementInternalForce` can swap implementations.
4. Implement CPU backend (verbatim port) and wire through; verify no regression vs current main.
5. Implement GPU matvec kernel (ELLPACK + mixed-precision refresh). Gate behind probe result and size threshold.
6. Implement GPU element-strain and internal-force kernels. Wire residual-norm fusion into Armijo line search.
7. Extend verification script; compare GPU vs CPU on every existing benchmark.
8. Benchmark on a representative Stage 2 run; confirm speedup matches expectations in the "Expected wall-clock" table. If not, iterate on `K_refresh` and the size gate.
9. Flip default to `true` **only** if the verification gate holds on three consecutive runs across all benchmarks on the target hardware profile. Otherwise keep the toggle opt-in.
