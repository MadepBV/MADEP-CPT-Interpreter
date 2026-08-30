# Audit — Deformation GPU v1 (WebGPU resident CG/GMRES, assembly, WGSL)
**Subsystem key:** def-gpu-v1
**Files reviewed:** src/lib/cpt-app/deformation/gpu/gpu-controller.js, src/lib/cpt-app/deformation/gpu/gpu-assembly.js, src/lib/cpt-app/deformation/gpu/gpu-mesh-pack.js, src/lib/cpt-app/deformation/gpu/gpu-plastic-newton.js, src/lib/cpt-app/deformation/gpu/resident-buffers.js, src/lib/cpt-app/deformation/gpu/resident-cg.js, src/lib/cpt-app/deformation/gpu/resident-gmres.js, src/lib/cpt-app/deformation/gpu/resident-geostatic.js, src/lib/cpt-app/deformation/gpu/wgsl/blas.js, src/lib/cpt-app/deformation/gpu/wgsl/ds.js, src/lib/cpt-app/deformation/gpu/wgsl/elements.js, src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js, src/lib/cpt-app/deformation/gpu/wgsl/plastic-trial.js, docs/deformation/T6_gpu_acceleration.md, docs/deformation/certification-log.md, docs/deformation/incident-log.md, plus cross-references into solver.js, legacy-controller.js, src/routes/docs/engineering/deformation/+page.svelte
**Finding counts:** critical=0 high=3 medium=6 low=6 info=3  |  A=4 B=4 C=4 D=6  |  total=18

## Overview
The def-gpu-v1 subsystem is unusually well-engineered for an experimental path: the double-single (DS) primitives are textbook-correct (Dekker/Knuth/HLB), the FEM element kernels (strain, B^T D B stiffness, B^T σ internal force) and the atomics-free gather scatter match their CPU references, the Mohr-Coulomb principal-space return mapping is a faithful WGSL unroll of the CPU oracle, and the CG/GMRES kernels are numerically sound (true-residual restarts, MGS+Givens, compensated DS reductions). The serious problems are NOT in the core math but in (1) lifecycle — no GPUBuffer/context is ever destroyed, so every analysis leaks the entire resident buffer set; (2) certification governance — the certification log claims a code "flag" gates promotion, but no such gate exists and the uncertified v1 path is reachable by a user toggle that writes results into engineering output; (3) documentation that materially misdescribes what the v1 toggle runs (the in-app doc says "linear-elastic only" and "auto-fallback to CPU"; the production v1 path is a full elastoplastic pipeline that throws on failure); and (4) the consistent tangent is produced only in WGSL with no CPU oracle to certify it, and a per-Gauss-point return-map failure flag that is computed but never checked. No confirmed wrong-converged-answer bug was found, but the leak and certification gaps are real and engineering-relevant.

## Findings

### [DEF-GPU-V1-A-01] high · Per-Gauss-point MC return-map failure flag (`converged[gp]`) is written but never checked
- **Location:** `src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js:864,1889` (kernel writes `converged[gp]=ok`); `src/lib/cpt-app/deformation/gpu/gpu-assembly.js:717,841` (buffer bound write-only); `src/lib/cpt-app/deformation/gpu/gpu-plastic-newton.js` (orchestrator never reads it)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** The MC kernel sets `converged[gp]=0u` whenever an active-set return is singular: `solve3x3` rank-deficient (mc-plastic.js:1032), `faceReturn1`/`edgeReturn2` C/det `< 1e-30`, or a zero-friction apex (`abs(sinPhi.x) < 1e-15`, line 1660/1675/1711). On that path the kernel falls back to `sigmaOut = sortedTrial` (the *un-returned* trial stress) and `tangent = Dvoigt3` (elastic) and proceeds. The orchestrator (`runPlasticNewtonOnGpu`) reads back `branchKind` every iteration for the active-set count but **never reads `buffers.converged`**. Grep confirms no readback of that buffer anywhere. Consequence: at any GP where the return projection failed, the committed internal force is computed from an inadmissible (outside-yield) stress. Globally this usually shows up as Newton failing to converge (reported generically), but a localized failure at a few GPs can leave the global residual under tolerance while those GPs carry physically inadmissible stress that is then committed (`recordCommitState`) and read back into the engineering result. There is no surfaced warning that a return map failed.
- **Recommendation:** Read back `buffers.converged` (u32/GP, cheap) at least once per accepted Newton step (or fold an "any-GP-failed" reduction into a 1-word device flag) and treat any `ok==0` as a hard failure / cutback trigger, mirroring how the CPU oracle propagates a non-converged material point.

### [DEF-GPU-V1-A-02] high · Tension-apex algorithmic tangent diverges from the CPU oracle (D_e vs deviatoric projection)
- **Location:** `src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js:1500-1506` (`tensionApexTangentVoigt3`) vs CPU oracle `src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js:329-332,702-738,788-790`
- **Category:** A — Implementation / parity
- **Confidence:** confirmed
- **Analysis:** For the tension apex branch (`BR_TENSION_APEX_T123`, σ'=(-σ_T,-σ_T,-σ_T)) the WGSL builds a single-surface algorithmic tangent with `n = m = (-1/3,-1/3,-1/3)` (`minusThird` triple) → a deviatoric-projected, non-elastic D_ep (algoTangentVoigt3_1). The CPU reference `cpuMcReturnMapping` for the same apex returns `M=null, N=null, DM=null` via `tensionApexReturn` (line 329-332), and `algorithmicTangentPrincipal({M:null,...})` returns **D_e** (line 703). So at the tension apex the CPU oracle uses the elastic tangent while the GPU uses a deviatoric projection — two different operators. Likewise the formal shear apex: CPU returns D_e (no M/N/DM), GPU uses `formalApexTangentVoigt3` (a 3-surface F12/F13/F23 projection). Because the residual is driven to b−F_int and the *stress* return is identical on both paths, this affects Newton convergence rate, not the converged stress — but it is a confirmed CPU↔GPU constitutive-tangent divergence that breaks the "CPU is the oracle" parity contract for the tangent and can change which problems converge at the apex. (See also C-02: the GPU tangent has no CPU oracle at all because it is rotated to physical space only in WGSL.)
- **Recommendation:** Make the GPU apex tangent match the oracle (return the elastic Voigt-3 tangent at the tension and formal apex branches), or — if the deviatoric projection is the intended improved tangent — update the CPU oracle to match and re-certify, so a parity test can cover it.

### [DEF-GPU-V1-A-03] medium · `recordResidualAndTangentPlastic` chains 8 compute passes in one encoder relying on implicit buffer dependencies
- **Location:** `src/lib/cpt-app/deformation/gpu/gpu-assembly.js:674-792`
- **Category:** A — Implementation
- **Confidence:** likely
- **Analysis:** The plastic assembly chains strain→trial→MC→voigt6to3→force→stiffness→scatterRhs→scatterCsr as 8 separate compute passes in a single `CommandEncoder`. WebGPU guarantees passes within one submission run in order with automatic hazard tracking on storage buffers, so the read-after-write dependencies (e.g. MC writing `tangentVoigt3` then stiffness reading it) are honored by the spec. This is correct *per spec*, but it is the kind of correctness that depends entirely on the implementation honoring storage-buffer hazard barriers between consecutive compute passes; there is no explicit `onSubmittedWorkDone`/barrier and no parity gate that this ordering holds on every backend. Flagged as a robustness/verification concern rather than a confirmed bug — the math is right if WebGPU barriers behave as required.
- **Recommendation:** Keep, but add a backend-level parity assertion (single-element plastic case) that the assembled `rhsFree`/CSR after this chain matches the CPU reference bit-for-bit, to catch any backend that under-synchronizes pass-to-pass.

### [DEF-GPU-V1-A-04] low · Block-Jacobi apply performs out-of-bounds read/write on the trailing DOF when `numFree` is odd
- **Location:** `src/lib/cpt-app/deformation/gpu/wgsl/blas.js:285-288` (apply), `:491-494` (build comment acknowledging it); buffers sized `8*N` in `src/lib/cpt-app/deformation/gpu/resident-cg.js:191-195`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** `KERNEL_BLOCK_JACOBI_WGSL` dispatches one thread per node (`numNodes = ceil(N/2)`). For odd `N` the last node reads `r[2n+1]` and writes `z[2n+1]` with `2n+1 == N` (out of bounds: the DS vectors hold exactly `N` pairs). The build kernel comment (blas.js:493-494) explicitly relies on "the write is silently dropped per WGSL spec." WebGPU robust buffer access does make OOB reads return zero and OOB writes no-ops, so this is safe *on a conformant implementation*, but it is an intentional reliance on robustness rather than an explicit `n*2+1 < N` guard. The build kernel handles the solitary slot correctly (D=1); the apply kernel does not guard.
- **Recommendation:** Add an explicit bounds guard in the apply kernel (`if (2u*n+1u < numFree)`) so correctness does not depend on robust-access behavior, and the dropped-write is intentional in code rather than in a comment.

### [DEF-GPU-V1-B-01] high · No GPUBuffer or resident context is ever destroyed — full resident buffer set leaks every analysis
- **Location:** `src/lib/cpt-app/deformation/gpu/resident-cg.js:190-228` (CG ctx buffers), `src/lib/cpt-app/deformation/gpu/resident-gmres.js:338-367` (GMRES ctx + Krylov basis), `src/lib/cpt-app/deformation/gpu/gpu-assembly.js:279-323` (assembly ctx); no `destroy`/cleanup anywhere (grep over the subsystem returns only short-lived staging-buffer destroys)
- **Category:** B — Memory leak
- **Confidence:** confirmed
- **Analysis:** `runFullDeformationAnalysisOnGpu` creates a fresh `createGpuAssemblyContext` (dozens of large RW buffers: `kOut` = 8·numLocalDofs²·numElements bytes, CSR valHi/Lo, sigmaCommitted/Returned/Trial, tangent buffers, etc.), a `createResidentCgContext` (6 DS vectors of length N + CSR + block-Jacobi), and optionally a `createResidentGmresContext` ((restart+1) DS vectors of length N + CSR + BJ). None of these contexts expose or call `.destroy()` on their buffers; there is no `destroyContext`/`cleanup`/`dispose`. Only the per-call staging readback buffers (`finalize`, `readbackBufferU32`, `readbackCommittedSigma`, etc.) are destroyed. Each repeated deformation analysis therefore allocates and abandons the entire resident buffer set. The pipeline cache (`device.__residentDsPipelines` etc.) is string-keyed and bounded, but the per-analysis buffers are not. On a long session with multiple GPU runs this is a steady, unbounded VRAM leak that can exhaust the device.
- **Recommendation:** Add a `destroyResidentCgContext` / `destroyResidentGmresContext` / `destroyGpuAssemblyContext` that iterates `buffers` and calls `.destroy()`, and invoke them in a `finally` around `runFullDeformationAnalysisOnGpu` (and the single-step `runDeformationOnGpu`). Also destroy the safety `snapshotCommittedState` buffers (B-02).

### [DEF-GPU-V1-B-02] medium · `snapshotCommittedState` allocates 4 GPU buffers that are never destroyed
- **Location:** `src/lib/cpt-app/deformation/gpu/gpu-assembly.js:428-445` (allocation); used once per safety run in `src/lib/cpt-app/deformation/gpu/gpu-controller.js:905`
- **Category:** B — Memory leak
- **Confidence:** confirmed
- **Analysis:** `snapshotCommittedState` creates `sigmaSnap`/`strainSnap`/`branchSnap`/`uSnap` GPU buffers (sized to the full GP/free-DOF state). `runSafetyOnGpu` calls it once and `restoreCommittedState` reads from it repeatedly, but the snapshot buffers are never `.destroy()`'d after the safety phase completes. Each c-φ safety analysis leaks 4 buffers in addition to the context leak in B-01.
- **Recommendation:** Return a `dispose()` from the snapshot (or destroy the four buffers in `runSafetyOnGpu` after the final restore at gpu-controller.js:960).

### [DEF-GPU-V1-B-03] medium · `readbackBufferU32` allocates+destroys a MAP_READ buffer every Newton iteration
- **Location:** `src/lib/cpt-app/deformation/gpu/gpu-plastic-newton.js:465-475`, called at line 233 once per Newton iteration
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** The per-iteration active-set readback (`branchKind`, 4·numGp bytes) creates a fresh `MAP_READ` GPUBuffer and destroys it every Newton iteration. Buffer creation/destruction is a relatively expensive driver operation; doing it in the hot outer loop adds per-iteration allocator/driver churn on top of the unavoidable map round-trip. A single persistent staging buffer of size `4·numGp` reused across iterations would remove the churn.
- **Recommendation:** Allocate one persistent `branchKind` staging buffer in the assembly/CG context and reuse it for the per-iter readback.

### [DEF-GPU-V1-B-04] low · Bind groups recreated per dispatch despite a comment claiming they are cached
- **Location:** `src/lib/cpt-app/deformation/gpu/resident-cg.js:284-291` (comment says "Cached across iterations to avoid per-iter allocator pressure") vs `bg()` at :289-291 which calls `device.createBindGroup` fresh every call; same pattern in `gpu-assembly.js:494-496`
- **Category:** B — Performance (and misleading comment)
- **Confidence:** confirmed
- **Analysis:** Every CG/GMRES/assembly dispatch helper (`dispatchAxpy`, `dispatchMatvec`, `dispatchDot`, `dispatchBlockJacobi`, the `*External` variants, all assembly passes) builds a new bind group via `device.createBindGroup` on each invocation. With ~6 dispatches/CG-iter and tens of thousands of CG iters per Newton solve, this is a large number of transient bind-group allocations. The comment at resident-cg.js:285-288 asserting bind groups are cached is false — there is no cache. Because the buffer set per (pipeline) is fixed for the whole solve, bind groups could be built once and reused.
- **Recommendation:** Build the per-pipeline bind groups once at context creation (buffers don't change during a solve) and reuse; fix the misleading comment.

### [DEF-GPU-V1-C-01] high · In-app doc says v1 is "linear-elastic only" with auto CPU fallback; the v1 toggle actually runs the full elastoplastic pipeline and throws on failure
- **Location:** Doc: `src/routes/docs/engineering/deformation/+page.svelte:1944-1948,1963-1967`. Code: `src/lib/cpt-app/deformation/solver.js:1306,1336,1302-1305,1351-1364` and `:6720-6770`; controller `src/lib/cpt-app/deformation/gpu/gpu-controller.js:391-635` (`runFullDeformationAnalysisOnGpu`)
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) The doc states "v1 (`runDeformationOnGpu`) — linear-elastic only." But the production v1 path is selected by `gpuPipelineVersion !== 'v2'`, which routes to `gpuRunFullDeformationAnalysisOnGpu` = `runFullDeformationAnalysisOnGpu` — a *full elastoplastic* pipeline: staged plastic geostatic correction, plastic Newton with Mohr-Coulomb return mapping, staged surface load, and optional c-φ safety. The single-step linear-elastic `runDeformationOnGpu` named in the doc is **not** reached by the solver at all (only by a hardware-smoke HTML). So a user who selects "v1" gets full GPU plasticity, not a linear-elastic solve. (2) The doc says "failure or unsupported scope automatically routes to the CPU path." The code is the opposite — `tryGpuFullDeformation` (solver.js:1303) is "STRICT BY DESIGN... no silent CPU fallback" and rethrows on any failure (solver.js:1351-1364, 6720-6722). Code is correct/intentional; the doc is wrong on both points and is engineering-relevant because it misrepresents both the constitutive scope and the failure behavior of a path that writes settlement/utilization into reports.
- **Recommendation:** Fix the doc: describe v1 as the CSR-assembly full elastoplastic resident pipeline (geostatic + plastic Newton + MC + safety), and state that both GPU pipelines are strict (throw on failure; no silent CPU fallback — uncheck the toggle to use CPU).

### [DEF-GPU-V1-C-02] medium · GPU consistent tangent is produced only in WGSL (physical Voigt-3); CPU oracle returns it in principal space — the tangent path has no parity oracle
- **Location:** GPU: `src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js:1327-1506` (`rotPrinToVoigt4`, `algoTangentVoigt3_1/2/3`, apex tangents) writing `tangentVoigt3`. CPU oracle: `:702-738` (`algorithmicTangentPrincipal`) returning a principal-space 3×3 with no rotation to (xx,yy,xy); `cpuMcReturnMapping` (`:743-800`) exposes `algorithmicTangentPrincipal` only.
- **Category:** C — Doc/oracle vs code (parity gap)
- **Confidence:** confirmed
- **Analysis:** The certification log declares the CPU f64 solver the oracle and the GPU paths uncertified pending parity evidence. But the GPU MC kernel computes the consistent tangent in **physical plane-strain Voigt-3** space (rotating the principal n/m gradients via `rotPrinToVoigt4` and assembling D_ep entirely in WGSL), while the CPU reference `cpuMcReturnMapping` returns the tangent in **principal-stress space** (`algorithmicTangentPrincipal`) and never performs the inverse rotation. There is therefore no CPU implementation of the GPU's physical-space tangent rotation, so a parity test can compare the returned *stress* (both yield Voigt-6) but **cannot** certify the GPU tangent. A sign/rotation error in `rotPrinToVoigt4` or `algoTangentVoigt3_*` would not be caught by stress parity — it would only manifest as degraded/failed Newton convergence. Combined with A-02, the entire plastic-tangent path is effectively unoracled.
- **Recommendation:** Add a CPU reference that rotates `algorithmicTangentPrincipal` to physical Voigt-3 (the same transform the WGSL applies) and add a parity test on `tangentVoigt3` per branch (face/edge/corner/apex/tension/mixed) before any promotion in the certification log.

### [DEF-GPU-V1-C-03] medium · Certification log claims a code flag gates promotion, but no certification gate exists in the code path
- **Location:** Doc: `docs/deformation/certification-log.md:3-4,18-22` ("the only place where a deformation GPU path can move from none to ... certification"; "A certification flag in code may only be flipped by a change that references an entry in this file"). Code: `src/lib/cpt-app/deformation/solver.js:1302,6360,6723` — the path is gated solely by the plain user option `options.useNewGpuPipeline === true`; no reference to the certification log, no cert-level check.
- **Category:** C — Doc vs code (governance) / certification
- **Confidence:** confirmed
- **Analysis:** The certification log states all WebGPU paths are `none` (uncertified) and that a "certification flag in code" governs reachability. No such flag exists. The v1 GPU pipeline (full plastic, MC return mapping, c-φ safety) is reachable whenever `useNewGpuPipeline` is true and produces a normal deformation result (`buildSolverResultFromGpuOutput`, solver.js:6763) tagged `gpu-resident-mc-plastic` that feeds settlement/utilization output. The default is `false` (CPU) and failures throw loudly, so it is *opt-in*, not a silent default — but the doc's claimed code-level certification gate is fictional: nothing links the runnable path to the `none` certification status. This is a governance gap for engineering-critical software: an uncertified path can produce reportable engineering numbers with no in-code certification check.
- **Recommendation:** Either implement a real code gate (a `GPU_CERTIFICATION_LEVEL` constant the toggle consults, refusing to run engineering-critical analysis types when level is `none`, and changeable only with a certification-log reference), or amend the certification log to state plainly that reachability is an honor-system UI toggle with no code enforcement. Until then, surface a prominent "uncertified experimental path" warning in the result (the existing `[GPU] Analysis ran on the new GPU resident pipeline` warning does not flag it as uncertified).

### [DEF-GPU-V1-C-04] low · GMRES header comment says "right-preconditioned"; implementation is left-preconditioned
- **Location:** `src/lib/cpt-app/deformation/gpu/resident-gmres.js:12-13` (header "right-preconditioned restarted GMRES") vs body `:96-101,127-129,562-571,585-603` (z=M⁻¹r, Krylov K_m(M⁻¹A,z), Givens track ‖M⁻¹r‖ — unambiguously left-preconditioned)
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** The file header describes the algorithm as right-preconditioned, but every internal comment and the actual code implement **left** preconditioning (apply M⁻¹ to the residual, build the Krylov subspace of M⁻¹A, and the canonical fix at :562-571 explicitly discusses the left-preconditioned residual). The math is correct (left-preconditioned GMRES with a true-residual restart test); only the one-line header is wrong. Scientifically the left form is fine for SPD/near-SPD block-Jacobi here.
- **Recommendation:** Fix the header comment to "left-preconditioned."

### [DEF-GPU-V1-D-01] medium · `runResidentGeostatic` (and `cpuRefK0Recovery` consumers) are dead — the geostatic GPU kernel is never used by the production pipeline
- **Location:** `src/lib/cpt-app/deformation/gpu/resident-geostatic.js:252-346` (`runResidentGeostatic`), exported but no callers (grep finds none outside the definition)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `runFullDeformationAnalysisOnGpu` requires the K0 σ_initial seed to be passed in from CPU (`sigmaInitialF64`, gpu-controller.js:420-426; supplied by solver.js:6724-6728 from the CPU geostatic prep). The on-device geostatic orchestrator `runResidentGeostatic` (elastic gravity CG + K0 recovery kernel) is never invoked by the solver or controller. The `KERNEL_K0_RECOVERY_WGSL` is wired into the assembly context pipelines (`pipes.k0Recovery`) but the recording helper `recordK0Recovery` is also unused (D-02). The whole on-device K0 recovery path is orphaned in favor of the CPU seed.
- **Recommendation:** Flag for removal or wiring. If the on-device K0 recovery is intended future work, mark it experimental and exclude it from the audited surface; otherwise delete to reduce the trusted-path footprint. (Audit flags only — no deletion performed.)

### [DEF-GPU-V1-D-02] medium · `recordK0Recovery`, `recordStrainOnly`, `recordZeroUvec` imported into the controller but never used
- **Location:** `src/lib/cpt-app/deformation/gpu/gpu-controller.js:49-51` (imports); each name appears exactly once in the file (the import line only)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** The controller imports `recordK0Recovery`, `recordStrainOnly`, `recordZeroUvec` from gpu-assembly.js but never calls them in any of its run functions. They are residue of the abandoned on-device K0 recovery path (D-01). Dead imports.
- **Recommendation:** Remove the unused imports (and the corresponding exports if no other consumer exists).

### [DEF-GPU-V1-D-03] medium · Single-step linear-elastic `runDeformationOnGpu` / `runDeformationOnGpuCpuReference` are unreachable from the solver
- **Location:** `src/lib/cpt-app/deformation/gpu/gpu-controller.js:119-210` (`runDeformationOnGpu`), `:310-363` (`runDeformationOnGpuCpuReference`)
- **Category:** D — Dead code (superseded)
- **Confidence:** confirmed
- **Analysis:** The solver only ever calls `runFullDeformationAnalysisOnGpu` for v1 (solver.js:1336). `runDeformationOnGpu` (the linear-elastic single-step path the in-app doc names for "v1") is referenced only by `scripts/gpu_hardware_smoke.html`, not by the application. `runDeformationOnGpuCpuReference` has no callers at all. These are superseded by the full pipeline and contribute to the C-01 doc confusion (the doc still names the dead function as the v1 path).
- **Recommendation:** Flag as superseded; either remove or clearly mark as smoke-test-only, and align the in-app doc (C-01) so it stops naming a function the app never runs.

### [DEF-GPU-V1-D-04] low · Dead `dbCol0/dbCol1/dbCol2` computation in the stiffness kernel
- **Location:** `src/lib/cpt-app/deformation/gpu/wgsl/elements.js:230-234`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** Inside `makeStiffnessKernel` the per-`i` precomputation of `dbCol0/dbCol1/dbCol2` ( (D·B)[:,i] ) is never used — the comment at lines 239-244 acknowledges the value needed is (D·B)[:,j], which is recomputed as `cb0/cb1/cb2` inside the inner `j`-loop. The `dbCol*` variables are computed and discarded each `i` iteration (wasted DS multiplies), and `let _unused: u32 = j;` (line 241) is a no-op left to suppress a warning. The actual stiffness math (`cb*`/`kij`) is correct.
- **Recommendation:** Remove `dbCol0/1/2` and the `_unused` line; they are pure waste (small per-element overhead, but in the hot stiffness assembly).

### [DEF-GPU-V1-D-05] low · `cpuReferenceResidentGmres` and `dispatchPlanResidentGmres` are reference/doc-only, not on any runtime path
- **Location:** `src/lib/cpt-app/deformation/gpu/resident-gmres.js:73-199` (`cpuReferenceResidentGmres`), `:737-758` (`dispatchPlanResidentGmres`)
- **Category:** D — Dead code (test/doc-only)
- **Confidence:** likely
- **Analysis:** `cpuReferenceResidentGmres` is the parity-reference algorithm and `dispatchPlanResidentGmres` returns a documentation structure ("for documentation and future tooling"); neither is used by the device runtime. They are presumably consumed by verification scripts (parity suite). Flagged so a reader knows they are not part of the runtime path; they are legitimate as parity references but should be excluded from the trusted runtime surface.
- **Recommendation:** Keep if verification scripts use them; otherwise remove `dispatchPlanResidentGmres` (pure documentation object) to reduce surface.

### [DEF-GPU-V1-D-06] low · Stale/incorrect inline comments label bound buffers
- **Location:** `src/lib/cpt-app/deformation/gpu/gpu-assembly.js:95` (BGL_MC binding 5 commented "tangentPrincipal" but the bound buffer and WGSL output are `tangentVoigt3`); `src/lib/cpt-app/deformation/gpu/resident-geostatic.js:98-99` (`szzTot` computed but comment notes it is unused) ; `src/lib/cpt-app/deformation/gpu/wgsl/elements.js:241`
- **Category:** D — Dead code / stale comments
- **Confidence:** confirmed
- **Analysis:** Minor but worth noting in engineering-critical code where comments are relied on: BGL_MC binding-5 comment says `tangentPrincipal` while the MC kernel actually writes the **physical Voigt-3** tangent there (relevant given C-02's principal-vs-physical confusion). In resident-geostatic.js the plane-strain `szzTot` is computed and discarded (the K0 recovery only uses σ_yy). These are non-functional but feed reader confusion about the tangent coordinate space.
- **Recommendation:** Update the BGL_MC comment to `tangentVoigt3 (physical plane-strain)`; drop the unused `szzTot` computation or comment it as intentionally unused.

### [DEF-GPU-V1-A-05] info · DS hardcoded `-1/3` constant has a slightly truncated low part (negligible)
- **Location:** `src/lib/cpt-app/deformation/gpu/wgsl/mc-plastic.js:1502`
- **Category:** A — Implementation (verified non-issue)
- **Confidence:** confirmed
- **Analysis:** `minusThird = vec2<f32>(-0.33333334, 9.9341078e-9)`. The hi part rounds to `Math.fround(-1/3)` exactly; the lo `9.9341078e-9` truncates the true lo `9.934107758624577e-9`, giving an absolute DS error ~3e-9 in a tangent that is already an apex approximation. Verified numerically; no action needed. Noted only because hand-entered DS constants are a recurring source of subtle error and the pattern should be avoided.
- **Recommendation:** Prefer `dsFromF64(-1.0/3.0)` (host) or a computed constant over hand-typed DS pairs.

### [DEF-GPU-V1-B-05] info · GMRES uses single-readback-per-MGS-step; O(m²) host round-trips per restart acknowledged in code
- **Location:** `src/lib/cpt-app/deformation/gpu/resident-gmres.js:635-643` (per-MGS dot readback); orchestration cost noted in `gpu-controller.js:455-470` and `gpu-plastic-newton.js:297-307`
- **Category:** B — Performance (by design, acknowledged)
- **Confidence:** confirmed
- **Analysis:** GMRES does `j+1` blocking dot-readbacks per inner iteration (m·(m+1)/2 per restart, ~820 at m=40), each a host-device sync. The code is aware of this and dispatches GMRES only when the active set is non-empty (CG otherwise). Not a defect; recorded so the performance profile of the plastic path is understood — for non-associated plasticity the GPU path will be host-sync-bound, which can make it slower than CPU on small meshes.
- **Recommendation:** None required; consider batched MGS (classical GS with reorthogonalization) to cut readbacks if GMRES becomes the bottleneck.

### [DEF-GPU-V1-C-05] info · T6_gpu_acceleration.md documents a WebGL/GPU.js plan, not this WebGPU subsystem
- **Location:** `docs/deformation/T6_gpu_acceleration.md` (entire); cross-ref WGSL T6 kernels in `src/lib/cpt-app/deformation/gpu/wgsl/elements.js:103,167,257`
- **Category:** C — Doc vs code (scope mismatch)
- **Confidence:** confirmed
- **Analysis:** The paired doc `T6_gpu_acceleration.md` is a forward plan for the **WebGL2 / GPU.js** element-kernel backend (`webgl-backend.js`, `cpu-f32-backend.js`, `gpujs-runtime.js`, `createKernel(...)`, `precision: 'single'`), which is a different subsystem from the WebGPU resident path under audit. The WebGPU path already has T6 element kernels (`KERNEL_STRAIN_T6_WGSL` etc.) wired via `createGpuAssemblyContext({elementType})`. The doc's T6 strides (B=108, etc.) and load-conservation guidance are still conceptually applicable, but the doc never describes the WebGPU WGSL T6 implementation that actually exists. A reader cross-referencing this doc against the WGSL code will find no correspondence in API.
- **Recommendation:** Add a note in the doc clarifying it targets the WebGL/GPU.js backend, and (if T6-on-WebGPU is in scope) document the WGSL T6 kernels separately.

## Notes / limitations of this audit pass
- I read all 14 listed code files in full and cross-referenced solver.js/legacy-controller.js routing and the in-app deformation doc. I did not execute the GPU path (no WebGPU in this environment) or run the parity scripts (`scripts/verify_gpu_*`), so claims about runtime numerical parity rest on static reading of the WGSL vs CPU references, not measured ULP differences.
- DS primitives (ds.js), BLAS reductions (blas.js), element kernels (elements.js), trial-stress (plastic-trial.js), and the MC stress *return* (mc-plastic.js) were verified against their CPU references and found consistent; I did not find a wrong-converged-answer bug. The MC *tangent* path (A-02, C-02) is the main unverifiable surface because the CPU oracle does not produce the same object (principal vs physical space).
- The K0 sign convention in resident-geostatic.js (tension-positive σ_yy from the gravity solve, flipped to compression-positive) was not fully verified end-to-end because the gravity assembly that produces `bGravityF64` is outside this subsystem; this path is also dead (D-01) in production, which lowers its risk.
- Buffer-leak findings (B-01/B-02) are confirmed by absence of any `destroy`/cleanup on the contexts; I did not measure VRAM growth empirically, but the static evidence (no destroy path) is unambiguous.
- The certification/reachability finding (C-03) was confirmed by tracing the `useNewGpuPipeline` toggle from legacy-controller defaults through solver.js; I confirmed the default is CPU and failures throw (no silent default-on), so this is a governance/honor-system gap, not a silently-on uncertified default.
