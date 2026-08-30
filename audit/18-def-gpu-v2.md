# Audit — Deformation GPU v2 (matrix-free, BiCGSTAB/CG, CPU-ref parity)
**Subsystem key:** def-gpu-v2
**Files reviewed:** src/lib/cpt-app/deformation/gpu/v2/gpu-v2-controller.js, gpu-v2-newton.js, gpu-v2-state.js, gpu-v2-dispatch.js, gpu-v2-cg.js, gpu-v2-bicgstab.js, cpu-ref-mf.js, cpu-ref-plastic.js, wgsl-v2/mf-kx-element.js, wgsl-v2/mf-blas.js, wgsl-v2/mf-block-jacobi.js, wgsl-v2/mf-apply-jacobi.js, wgsl-v2/mf-jacobi-diag.js, wgsl-v2/mf-elastic-d.js, wgsl-v2/mf-plastic-strain.js, wgsl-v2/mf-residual-and-flag.js, wgsl-v2/mf-stress-slice.js, wgsl-v2/mf-trial-stress.js, README.md, docs/deformation/T6_gpu_acceleration.md (plus cross-reference reads of wgsl/mc-plastic.js, wgsl/elements.js, wgsl/ds.js, solver.js)

**Finding counts:** critical=0 high=2 medium=6 low=7 info=4  |  A=5 B=4 C=4 D=6  |  total=19

## Overview
The v2 matrix-free pipeline is carefully engineered and internally consistent: the WGSL element Kx, diag, block-Jacobi, trial-stress and residual kernels match each other and their `cpu-ref-mf.js` mirrors at the DS-arithmetic level, the elastic-D / plane-strain assembly is correct, the Voigt-6→Voigt-3 slice and internal-force scatter are sound, and the BiCGStab/CG drivers implement breakdown handling, true-residual refresh, and inexact-Newton forcing competently. The strongest correctness risks are not in the math but in (A) the inexact-acceptance / no-op-guard control logic, which is intricate enough that an over-tight or over-loose target could quietly degrade engineering answers, and (B) the absence of any GPU-buffer teardown — the v2 `ctx` allocates ~70 persistent device buffers per solve and is never destroyed, so repeated runs leak VRAM. The MC return-mapping and algorithmic-tangent rotation that v2 depends on live in `wgsl/mc-plastic.js` (outside this subsystem's file list) and were only cross-checked at the interface level. No certification artifact was found; v2 is wired in `solver.js` strictly opt-in (`gpuPipelineVersion: 'v2'`, labelled "experimental") and is therefore not on the default production path.

## Findings

### [DEF-GPU-V2-A-01] high · Geostatic stagnation/stop classifier never retries with elastic tangent on `localReturnFallbackCount`-driven failure path symmetry
- **Location:** `gpu-v2-controller.js:219-227` (`shouldRetryWithElasticTangent`), `gpu-v2-newton.js:561-597` (local-return failure return)
- **Category:** A — Implementation
- **Confidence:** likely
- **Analysis:** `runNewtonWithAdaptiveTangent` only retries with the elastic tangent when `shouldRetryWithElasticTangent` matches one of three reason strings: `"newton did not converge"`, `"line search failed"`, or `"linear solver failed to converge"`. When the algorithmic-tangent Newton instead aborts because the MC return mapping failed at Gauss points (`gpu-v2-newton.js:574` returns reason `"local return mapping failed at N Gauss point(s) during Newton iter K"`), the reason string matches none of the three, so no elastic-tangent retry is attempted even though a return-mapping failure under the algorithmic tangent is exactly the kind of stall the elastic fallback exists to rescue. The whole load step then fails and the analysis throws in `solver.js`. The elastic tangent uses the same MC return kernel, so this would not always help — but the asymmetry means a recoverable algorithmic-tangent pathology is treated as fatal. This is a robustness/convergence-logic bug, not a wrong-answer bug.
- **Recommendation:** Add the local-return-failure reason to `shouldRetryWithElasticTangent` (or key the retry on a structured failure flag rather than substring matching), so the elastic-tangent fallback is given a chance before the step is declared failed.

### [DEF-GPU-V2-A-02] medium · Inexact-Newton acceptance can commit a linear correction that violated the strict no-op guard
- **Location:** `gpu-v2-newton.js:680-715` (inexact branch when `linear.converged === true`), `gpu-v2-newton.js:112-159` (`computeInexactLinearTarget`)
- **Category:** A — Implementation
- **Confidence:** likely
- **Analysis:** When the Krylov solve reports `converged === true`, the code at `gpu-v2-newton.js:690-700` builds an `inexact.accepted = selectedResidual > strictTarget && selectedResidual <= inexactTarget.target`. The intent is to *also* accept "converged-but-loose" solves through the inexact path. But the actual `converged` decision was already made inside CG/BiCGStab against the *guarded* `effectiveTargetTol`, which itself was capped by `LINEAR_NO_OP_GUARD_RATIO * initialResidual` (`gpu-v2-cg.js:31`, `gpu-v2-bicgstab.js:31`). The Newton-side `inexactTarget.target` is computed from a *different* guard (`noOpGuardRatio` 0.75/0.85 of the linear RHS, `gpu-v2-newton.js:139-142`) and can be larger than the linear solver's own guarded target. The net effect is two independently-computed "no-op guards" that are not guaranteed to be consistent; a correction that the linear solver accepted as converged can be re-accepted with a looser Newton-side target, weakening the protection against committing a near-zero-progress step. No wrong final stress was demonstrated, but the layered guards are hard to reason about and a mismatch could let a stagnant step through.
- **Recommendation:** Unify the no-op guard: compute one guarded linear target, pass it to the solver, and have the Newton acceptance reuse exactly that value rather than recomputing a second independent guard. Add an assertion/test that the Newton-side accepted residual never exceeds the linear solver's own guarded target.

### [DEF-GPU-V2-A-03] medium · `combineFreeDofVectors` / `blendFreeDofVectors` silently truncate to the shorter vector length
- **Location:** `gpu-v2-controller.js:82-99`, used at `:426`, `:493`, `:549`
- **Category:** A — Implementation
- **Confidence:** likely
- **Analysis:** `combineFreeDofVectors(a, b, λ)` sets `n = a?.length || b?.length || 0` (the length of `a`, falling back to `b` only if `a` is null). `blendFreeDofVectors` uses `Math.max`. If `gravityRhsFree` and `surfaceLoadRhsFree` ever differ in length (they should both be `numFree`, but `surfaceLoadRhsFree` defaults to `null` and is constructed elsewhere), `combineFreeDofVectors` would silently truncate/zero-extend to `a.length` with no error. `runPlasticNewtonOnGpuV2` does validate `bF64.length === numFree` (`gpu-v2-newton.js:502`), so a true mismatch would throw later — but at a confusing call site. This is defensive-coding debt rather than a confirmed live bug, since both inputs are produced at `numFree` length by the solver.
- **Recommendation:** Assert `a.length === b.length === ctx.numFree` (or pass `numFree` explicitly) inside these combiners so a load-vector length mismatch fails loudly at the point of error instead of producing a silently wrong RHS.

### [DEF-GPU-V2-A-04] medium · CG stagnation ratio is not configurable from the Newton driver (only BiCGStab is)
- **Location:** `gpu-v2-newton.js:668-673` (linearOptions omit `stagnationRatio`), `gpu-v2-cg.js:43` (default `stagnationRatio = 0.995`), `gpu-v2-controller.js:680-681`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** The Newton loop builds `linearOptions` with `stagnationWindow` but no `stagnationRatio` (`gpu-v2-newton.js:671`). `solveCgV2` therefore always uses its hard-coded default `0.995`, while the configured `bicgstabStagnationRatio` (default 0.9995, from `gpu-v2-controller.js:681`) is threaded into BiCGStab only (`gpu-v2-newton.js:304`). A user tuning `v2BicgstabStagnationRatio` to suppress premature CG stagnation gets no effect on the CG path. Functionally CG also stops on non-positive curvature (`gpu-v2-cg.js:116`), so the consequence is limited, but the configuration is misleadingly asymmetric and the two solvers can stop at different stagnation thresholds for the same problem.
- **Recommendation:** Thread a `stagnationRatio` (e.g. a `cgStagnationRatio` option) into `linearOptions` for the CG path, or document that CG stagnation is fixed. At minimum make the two solvers' defaults explicit and consistent.

### [DEF-GPU-V2-A-05] low · BiCGStab `‖s‖`-small early exit reports the recursive s-norm as the converged residual; CG/BiCGStab use the inexact (guarded) tolerance for the s-test
- **Location:** `gpu-v2-bicgstab.js:155-166`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** On the half-step `s = r − αv`, the code accepts convergence when `sNorm <= effectiveTargetTol` and then sets `residualNorm = sNorm`, `stopReason = sNorm <= strictTargetTol ? 'strict' : 'inexact'`. `sNorm` is the recursively-updated residual norm (`s = r − αv`), not a freshly recomputed true residual `‖b − Ax‖`; on hard plastic solves DS roundoff in the recursive update can make the reported residual optimistic relative to the true residual. The full-step path mitigates this with a periodic true-residual refresh (`gpu-v2-bicgstab.js:199-208`), but the early `s`-exit path bypasses that refresh. The CPU reference (`cpu-ref-mf.js:414`) uses the *strict* `targetTol` for the same `‖s‖` test, so GPU and CPU references diverge in when they take the early exit (GPU exits earlier under the inexact target). Both are standard BiCGStab variants; the divergence is a parity nuance, not a correctness error, but it weakens the "bit-for-bit CPU-ref parity" claim on this branch.
- **Recommendation:** Either recompute the true residual before accepting the `s`-exit, or document that the early-exit residual is the recursive estimate. For parity, align the CPU reference's `s`-test tolerance with the GPU's guarded target (or vice-versa).

### [DEF-GPU-V2-B-01] high · v2 `ctx` allocates ~70 persistent GPU buffers and is never destroyed — VRAM leak across repeated solves
- **Location:** `gpu-v2-state.js:400-632` (buffer/uniform allocation), `gpu-v2-state.js:299` (doc claims `ctx.destroy()` exists), `gpu-v2-controller.js:638-890` (no teardown), `solver.js:1323-1334` (no disposal)
- **Category:** B — Memory / Performance
- **Confidence:** confirmed
- **Analysis:** `createV2Context` allocates on the order of 70 device buffers (`buffers.*`: bMatrices, gpWeights, dofMap, matParams, matIndex, forceIncPtr/List, dPerGp, sigmaCommitted/Trial/Returned, plasticStrain*, plasticEq*, sigmaVoigt3, deltaEps, branchKind, tangentVoigt3, mcConverged, elemScatter, fInt, kElem, the 10 solver DS vectors, the 6 BiCGStab aux vectors, blocks, freeToPair/IsSecond/Mate, nodePairFreeIdx, nodePairOffPtr/List ×4, status/statusRb, mcStats*, dot* ×6, plus ~18 `uniforms.*` parameter buffers). The state module's own comment (`gpu-v2-state.js:299`) says "Caller is responsible for `ctx.destroy()`", but **no `destroy` method is attached to the returned object** and neither `gpu-v2-controller.js` nor `solver.js` calls one. Every invocation of `runFullDeformationAnalysisOnGpuV2` therefore allocates a fresh full buffer set that lives until the `GPUDevice` itself is collected. For a browser app where a user re-runs Stage-6 deformation repeatedly on the same session/device, this is an unbounded VRAM growth. Snapshots *are* correctly destroyed (`destroyV2Snapshot` is called on all paths) and transient readback buffers are destroyed in `readDsVector`/`readU32Vector`/`readUtotal`, so the leak is specifically the per-solve `ctx` buffer set, not the inner-loop allocations.
- **Recommendation:** Add a real `ctx.destroy()` that iterates `buffers` and `uniforms` calling `.destroy()`, and invoke it in a `finally` around the solve in `gpu-v2-controller.js` (or have `solver.js` own the lifetime). Confirm with a buffer-count probe across N repeated runs.

### [DEF-GPU-V2-B-02] medium · Per-iteration host allocation of zero DS vectors in CG/BiCGStab initialization and BiCGStab `p`/`v` reset
- **Location:** `gpu-v2-cg.js:52` (`packDsVector(new Float64Array(numFree))`), `gpu-v2-bicgstab.js:52,74` (`zeroVec`/zero-pack), `gpu-v2-newton.js` per-iter dot calls
- **Category:** B — Memory / Performance
- **Confidence:** confirmed
- **Analysis:** Each linear solve allocates a fresh `new Float64Array(numFree)` and packs it to DS just to zero `buffers.x` (and, in BiCGStab, two more for `p` and `v`). These run once per Newton iteration per load step (and the safety c-phi search runs many Newton solves), so on a multi-step plastic run this is dozens-to-hundreds of `numFree`-length host allocations plus a `replaceStorageBufferData` staged upload (which itself allocates a staging buffer and awaits `onSubmittedWorkDone`). A device-side "zero buffer" kernel (or a single pre-allocated zero buffer copied with `copyBufferToBuffer`) would avoid the host allocation and the staged-upload round-trip entirely.
- **Recommendation:** Pre-allocate one persistent zero DS vector buffer in `ctx` (or add a trivial `memset` compute kernel) and use `copyBufferToBuffer` / dispatch to clear `x`/`p`/`v`, removing the per-solve host allocation and staged upload.

### [DEF-GPU-V2-B-03] medium · `replaceStorageBufferData` does double upload (writeBuffer + staged copy) and two device drains per call, on the hot per-iteration RHS/state path
- **Location:** `gpu-v2-dispatch.js:346-401`, called from `uploadInitialState` (`:542-563`) every Newton call and from the safety matParams swap
- **Category:** B — Memory / Performance
- **Confidence:** confirmed
- **Analysis:** `replaceStorageBufferData` deliberately writes the buffer *twice* — once via `device.queue.writeBuffer` and once via a fresh `mappedAtCreation` staging buffer + `copyBufferToBuffer` — and awaits `device.queue.onSubmittedWorkDone()` both before (to drain in-flight readers) and after (to free staging). The comment justifies this as an Apple-Metal-worker workaround where one path alone "silently drops bytes". `uploadInitialState` calls it up to ~6 times per Newton invocation (utotal, uPrev, sigmaCommitted, plasticStrainCommitted, plasticEqCommitted, b). Each call therefore allocates a staging buffer, does two uploads, and forces two full GPU drains — serializing the pipeline at every load step. This is a large, intentional correctness-over-speed tax; on hardware that doesn't need the workaround it roughly doubles upload cost and adds synchronization stalls.
- **Recommendation:** Gate the belt-and-suspenders double-upload behind a runtime capability/probe flag (detect the Metal-worker quirk once at context creation), and fall back to a single `writeBuffer` (or single staged copy) elsewhere. Batch the `uploadInitialState` uploads into one encoder where possible to avoid per-buffer drains.

### [DEF-GPU-V2-B-04] low · Bind groups are recreated on every dispatch instead of cached
- **Location:** `gpu-v2-dispatch.js:45-50` (`bg`), called in every `dispatch*`/`matvec`/`apply*`/`dot` helper
- **Category:** B — Memory / Performance
- **Confidence:** confirmed
- **Analysis:** Every matvec, preconditioner apply, axpy/axpby, and dot creates a new `GPUBindGroup` via `device.createBindGroup` (`bg(...)`). On a long CG/BiCGStab solve with hundreds of iterations, this is hundreds-to-thousands of bind-group allocations per linear solve, all over the *same* fixed buffer sets. Bind groups over immutable buffer bindings can be created once and reused. WebGPU bind groups are cheap but not free, and the churn adds GC pressure and driver-side validation cost on the hot loop.
- **Recommendation:** Cache bind groups keyed by (pipeline, buffer-tuple) on `ctx` and reuse them across iterations; only the small dynamic parameter buffers change content, not the binding identity.

### [DEF-GPU-V2-C-01] medium · README "DS precision … so parity with v1/CPU is exact at the scalar level" overstates what the code guarantees
- **Location:** `README.md:117-119` vs `gpu-v2-bicgstab.js:155-164`, `wgsl-v2/mf-residual-and-flag.js:189-213` (convergence flag does f32 compare), `gpu-v2-dispatch.js:36-39`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) The README states DS gives parity "exact at the scalar level". The code itself documents *deliberate* parity-breaking choices: the convergence-flag kernel comments "this kernel does the comparison in f32" (`mf-residual-and-flag.js:184-188`), and the BiCGStab `s`-exit uses the inexact target while the CPU reference uses the strict target (see DEF-GPU-V2-A-05). DS arithmetic gives ~f64-equivalent *accumulation*, not bit-exact reproduction of an f64 CPU computation, and the control-flow tolerances differ between GPU and CPU references. (2) Scientifically the DS approach is sound and the right design; the doc claim of "exact" parity is the part that is wrong — it should read "f64-equivalent accumulation precision; control-flow/tolerance decisions may differ from the CPU reference."
- **Recommendation:** Fix the doc: soften "exact" to "f64-equivalent" and note that convergence tests and early-exit tolerances are f32/inexact and may differ from the CPU reference. Code is correct as-is.

### [DEF-GPU-V2-C-02] medium · README implementation-status table marks the subsystem fully ✅ with no certification/limitation note, contradicting solver.js labelling it "experimental"
- **Location:** `README.md:31-51` (all rows ✅, "parity-tested") vs `solver.js:6491` ("'v2' … experimental"), `gpu-v2-controller.js:178-181` (v2 "experimental route")
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** The README status table marks every part ✅ and asserts the kernels and plastic Newton loop "are parity-tested against v1 and CPU references", with no statement that v2 is opt-in/experimental or not yet certified for production engineering use. The code disagrees: `solver.js` comments call v2 "experimental", `gpu-v2-controller.js:175-181` describes adaptive continuation as gated specifically because "v2's last stable behavior used fixed growth/cutback" on an "experimental route", and v2 is reachable only via the explicit non-default `gpuPipelineVersion: 'v2'` flag. For engineering-critical software the doc should not present an experimental, opt-in path as a finished, validated one. No v1-style certification artifact was found for either pipeline.
- **Recommendation:** Add an explicit status/limitations banner to the README ("experimental, opt-in, not the default production path; parity tests are algorithmic, not a full engineering certification") to match the code's own characterization.

### [DEF-GPU-V2-C-03] low · README architecture box lists "dirichletMask" as a static upload; code uses `dofMap` (−1 sentinel) for Dirichlet handling, with no dirichletMask buffer
- **Location:** `README.md:58-60` ("dofMap, … dirichletMask") vs `gpu-v2-state.js:401-407` (uploads bMatrices/gpWeights/dofMap/matParams/matIndex/forceIncPtr/List; no dirichletMask), `wgsl-v2/mf-kx-element.js:100-107` (Dirichlet via `dofMap[...] < 0`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** The ASCII architecture diagram lists `dirichletMask` among the static uploads. No buffer named `dirichletMask` exists in `gpu-v2-state.js`; Dirichlet/constrained DOFs are encoded as `−1` in `dofMap` and clamped to zero displacement in the Kx/strain/diag kernels (`mf-kx-element.js:102`). The code's approach is correct (the standard −1-sentinel scheme); the doc names a buffer that does not exist.
- **Recommendation:** Remove `dirichletMask` from the README diagram (Dirichlet is handled via the `dofMap` −1 sentinel). Doc fix only.

### [DEF-GPU-V2-C-04] low · `T6_gpu_acceleration.md` describes a WebGL2/GPU.js T6 plan that does not correspond to the WebGPU v2 implementation it is paired with
- **Location:** `docs/deformation/T6_gpu_acceleration.md` (entire doc) vs `gpu-v2-state.js:336-344` (WebGPU T3/T6 dispatch on `elementCaches[0].kind`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** The paired doc is a forward-looking implementation spec for adding T6 element kernels to a **WebGL2 / GPU.js** backend (`webgl-backend.js`, `gpu.createKernel`, `precision: 'single'`, texture-budget checks). The v2 subsystem under audit is a **WebGPU compute** pipeline whose T6 support is already present and structured completely differently (lazy WGSL pipelines selected by `elementType`, DS `vec2<f32>` precision, `forceIncPtr/List` scatter). The doc is not wrong as a WebGL plan, but it is mis-paired: it does not document v2, and a reader using it to reason about v2's T6 correctness (e.g. the `w·detJ`/Gauss-weight handling) would be reading about a different backend. v2 folds `w·|J|` into `gpWeights` (per the kernels), consistent with the doc's §9 warning, but the doc's kernel bodies and file map are WebGL-specific.
- **Recommendation:** Either retarget/replace this doc with a WebGPU-v2 T6 description, or add a header clarifying it documents the WebGL2 backend and that the WebGPU v2 path handles T6 via the WGSL `elementType` dispatch in `gpu-v2-state.js`.

### [DEF-GPU-V2-D-01] low · GPU-resident convergence-flag machinery is fully built but never dispatched (superseded by CPU-readback convergence)
- **Location:** `gpu-v2-dispatch.js:517-537` (`dispatchResetStatus`, `dispatchConvergeFlag`, `readStatus`), `gpu-v2-dispatch.js:504-512` (`dispatchDotOnDevice`), `gpu-v2-state.js:372-373` (convergeFlag/resetStatus pipelines), `:562-563` (status/statusRb buffers), `:632` (`uniforms.converge`), `:281-285` (`writeConvergeParams`), `wgsl-v2/mf-residual-and-flag.js:189-241`
- **Category:** D — Dead code (FLAG ONLY)
- **Confidence:** confirmed
- **Analysis:** Both CG and BiCGStab use CPU-readback dot/convergence (`dispatchDotAndRead`), not the on-device convergence flag. `dispatchConvergeFlag`, `dispatchResetStatus`, `readStatus`, and the v2 `dispatchDotOnDevice` are never called anywhere in the v2 solve path (the `dispatchDotOnDevice` reference in `resident-newton.js` is v1's, a different function). Consequently the `convergeFlag`/`resetStatus` pipelines, the `status`/`statusRb` buffers, the `uniforms.converge` parameter buffer, `writeConvergeParams`, and the `KERNEL_MF_CONVERGE_FLAG_WGSL`/`KERNEL_MF_RESET_STATUS_WGSL` kernels are dead in the production path. The README "GPU-resident convergence flag … without any CPU readback inside the iteration loop" (mf-residual-and-flag.js header) describes an unrealized design.
- **Recommendation:** Flag for removal or wiring. If on-device convergence is a future goal, mark it as such; otherwise drop the kernels, buffers, and helpers to reduce surface area. (Lazy pipelines mean unused ones never compile, so the runtime cost is the few unused buffers, not GPU compilation.)

### [DEF-GPU-V2-D-02] low · `cpuRefMfBuildBlockJacobi` / `cpuRefMfApplyBlockJacobi` build a symmetric-only block inverse, superseded by the asymmetric (B/C off-diagonal) GPU path
- **Location:** `cpu-ref-mf.js:498-696` vs `wgsl-v2/mf-block-jacobi.js:201-283` (separate B and C off-diagonal lists for unsymmetric tangent), `gpu-v2-state.js:508-559`
- **Category:** D — Dead code / superseded logic (FLAG ONLY)
- **Confidence:** likely
- **Analysis:** The CPU reference block-Jacobi assumes a symmetric nodal block (`off = K[i,j] = K[j,i]`, `det = a*d − off*off`, `cpu-ref-mf.js:601-611`). The GPU block-inverter maintains *separate* off-diagonal sums `b` (K[first,second]) and `c` (K[second,first]) precisely because the algorithmic plastic tangent is generally unsymmetric for non-associated flow (`mf-block-jacobi.js:191-283`, and the explicit comment in `gpu-v2-state.js:508-512`). The CPU reference therefore cannot validate the unsymmetric block-Jacobi path; it is only a parity oracle for the elastic/associated (symmetric) case. This is acceptable as a *test* helper but is superseded logic relative to the production GPU kernel and could mislead anyone treating it as the authoritative reference.
- **Recommendation:** Flag: either extend the CPU reference to the asymmetric (b≠c) block inverse to match the GPU kernel, or annotate it as "symmetric/elastic parity only". Do not delete — it is a live test oracle for the symmetric case.

### [DEF-GPU-V2-D-03] info · `cpu-ref-plastic.js` (`cpuRefPlasticNewton` and the per-stage reference functions) is used only by `verify_gpu_v2_parity.mjs`
- **Location:** `cpu-ref-plastic.js:234-343` (and the module's exports), consumed at `scripts/verify_gpu_v2_parity.mjs:499,580`
- **Category:** D — Dead code (FLAG ONLY — these are intentional test oracles)
- **Confidence:** confirmed
- **Analysis:** None of `cpu-ref-plastic.js` or the iterative-solver references in `cpu-ref-mf.js` (`cpuRefMfPcg`, `cpuRefMfBicgstab`) are imported by the production controller/newton/solver; they are imported only by the verification scripts. This is by design (CPU parity oracles), so it is *info*, not a defect — flagged for completeness so a future reader knows these are not part of the runtime path and changes to them do not affect production behavior.
- **Recommendation:** No action beyond awareness. Keep them co-located with the kernels they mirror; a header note "test-only oracle, not in the runtime path" would help.

### [DEF-GPU-V2-D-04] info · `dispatchBuildScalarJacobi` / scalar-Jacobi path retained but default is always block-Jacobi
- **Location:** `gpu-v2-dispatch.js:180-196`, selected only when `ctx.preconditioner === 'jacobi'` (`:173-178`); controller forces `'block-jacobi'` unless `options.preconditioner === 'jacobi'` (`gpu-v2-controller.js:654`)
- **Category:** D — Dead code / flag-disabled path (FLAG ONLY)
- **Confidence:** confirmed
- **Analysis:** The scalar-Jacobi preconditioner (build + apply, plus the `recip`/`applyJacobi`/`diag`/`diagTangent` pipelines and `mInv` buffer) is reachable only via the undocumented `options.preconditioner === 'jacobi'`. The default and every controller call use block-Jacobi. The scalar path is a legitimate fallback and its CPU reference exists, so this is retained-but-rarely-used rather than strictly dead; flagged so it is not assumed exercised by default test coverage.
- **Recommendation:** No removal needed; ensure at least one parity/hardware test exercises `preconditioner: 'jacobi'` so the fallback does not silently rot, or document it as a debug-only option.

### [DEF-GPU-V2-D-05] info · `gpsPerElem` is derived two different ways (state vs cpu-ref) — duplicate-logic note
- **Location:** `gpu-v2-state.js:326` (`gpsPerElem = elementType === 't6' ? 3 : 1`) vs `cpu-ref-plastic.js:243` (`gpsPerElem = numGp / numElements`)
- **Category:** D — Duplicate logic (FLAG ONLY)
- **Confidence:** confirmed
- **Analysis:** The GPU state hard-codes `gpsPerElem` from element type; the CPU reference infers it as `numGp / numElements`. Both yield the same value for clean T3/T6 meshes, but the two derivations can diverge if a pack ever carries an inconsistent `numGp`/`numElements`. Low-risk; flagged as a single-source-of-truth opportunity.
- **Recommendation:** Have the CPU reference read `gpsPerElem` from the pack/ctx rather than re-deriving it, so both agree by construction.

### [DEF-GPU-V2-D-06] info · `hasNonzeroVector`/`firstPositiveHistoryValue` and several diagnostics-only helpers in the controller are low-value but live; no action
- **Location:** `gpu-v2-controller.js:61-67`, `:302-308`, `:801-831`
- **Category:** D — (FLAG ONLY)
- **Confidence:** confirmed
- **Analysis:** These are genuinely used (e.g. `hasNonzeroVector` gates `hasSurfaceLoad`, `firstPositiveHistoryValue` populates `norms`), so they are *not* dead — flagged only to record that the controller carries a fair amount of diagnostics/warning plumbing whose correctness does not affect the numerical result. No defect.
- **Recommendation:** None.

## Notes / limitations of this audit pass
- The **MC return mapping and the algorithmic-tangent rotation** (`wgsl/mc-plastic.js`) that v2 consumes via `tangentVoigt3`/`sigmaReturned` are outside this subsystem's file list and were only cross-checked at the interface: the 9-slot row-major (xx,yy,xy) physical-frame tangent layout is consistent between the MC kernel output and the mfKx/diag/block-build consumers, and the compression↔tension sign flip on σ is correctly *not* applied to the tangent (D_ep = dσ/dε is sign-flip invariant). The deep constitutive correctness of that kernel (yield/potential surfaces, return-mapping branches, consistent tangent assembly) was **not** re-derived here and should be audited under its own subsystem.
- I could not execute the GPU path (no WebGPU device in this environment) or run `verify_gpu_v2_parity.mjs` / `verify_gpu_v2_hardware.mjs`, so all findings are from static reading; the parity claims in the README were not independently reproduced.
- DS arithmetic correctness (`dsAdd`/`dsMul`/`dsRecip`/`dsDiv`/`dsSqrt`) was assumed correct from v1 and only spot-checked; the elastic-D split constants (`two_thirds = (0.66666669, -3.9736431e-9)` etc.) were checked for plausibility but not bit-verified against an independent f64 split.
- The double-upload Metal-worker workaround (DEF-GPU-V2-B-03) and the lazy-pipeline workaround (`gpu-v2-state.js:156-166`) are described as confirmed device-specific behaviors; I took those at face value and did not verify the underlying Metal bug.
- Convergence-control logic (inexact forcing, no-op guards, line-search acceptance) is intricate; A-02 in particular would benefit from a targeted numerical test rather than static reasoning to confirm whether the layered guards can actually admit a stagnant step in practice.
