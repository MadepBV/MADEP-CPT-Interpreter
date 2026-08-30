# Audit — Deformation FEM — JS CPU solver & elements
**Subsystem key:** def-solver
**Files reviewed:** src/lib/cpt-app/deformation/solver.js, src/lib/cpt-app/deformation/element-kernel.js, src/lib/cpt-app/deformation/element-t3.js, src/lib/cpt-app/deformation/element-t6.js, src/lib/cpt-app/deformation/material.js, src/lib/cpt-app/deformation/post.js (cross-ref), src/lib/cpt-app/deformation/material-models.js (cross-ref for tangent/stress extraction), docs/deformation/T6_mesh.md, docs/deformation/geostatic-init.md, src/routes/docs/engineering/deformation/+page.svelte
**Finding counts:** critical=0 high=0 medium=3 low=4 info=4  |  A=0 B=1 C=3 D=7  |  total=11

## Overview
The deformation FEM CPU reference is in strong numerical health. The T3/T6 element kernels (B-matrix, Gauss quadrature, Jacobian = 2A, plane-strain D-matrix, consistent body-force/traction vectors, B-bar projection) are all correct and match the closed-form math in the paired docs. The plane-strain tangent extraction (slicing the 6×6 to the in-plane sub-block) is mathematically valid because ε_zz = 0 is a kinematic constraint, not a stress constraint. Stress-sign conventions (tension-positive Voigt internally, compression-positive for MC), residual/internal-force assembly, the PCG/restarted-PGMRES Krylov solvers with Kahan-compensated reductions and nodal 2×2 block-Jacobi preconditioning, the Newton–Raphson loop with Armijo line search and adaptive continuation, K0 geostatic seeding with admissibility-limited shear, and the c-φ strength-reduction bracket all check out. No correctness (A) defects were confirmed. The main findings are doc-vs-code drift (B-bar default, a superseded geostatic-init design note) and a meaningful amount of dead/forwarded-only code in the large solver.js file.

## Findings

### [DEF-SOLVER-B-01] low · Geostatic elastic assembly builds a per-row Map global matrix instead of using the CSR pattern
- **Location:** `src/lib/cpt-app/deformation/solver.js:6583` (`const rows = Array.from({ length: ndof }, () => new Map())`), assembled at 6611–6621, compressed at 6645 via `compressMatrixRows`
- **Category:** B — Memory/Performance
- **Confidence:** confirmed
- **Analysis:** The one-time elastic geostatic stiffness assembly uses an `ndof`-length array of JS `Map` objects (`addMatrixBlock` does `row.set/get` per entry), then converts to CSR. The nonlinear phases already use a far more efficient precomputed compressed-row pattern (`buildCompressedAssemblyPattern` → `addMatrixBlockToCompressedRows`, solver.js:2366, 1970). For large T6 meshes (the docs note 5,000 elements / >30,000 DOF), allocating tens of thousands of `Map`s with per-entry hashing is materially slower and more allocation-heavy than the CSR path, and it runs on the main solving thread. Because it executes only once per analysis (not per Newton iteration), impact is bounded — hence low severity.
- **Recommendation:** Reuse the compressed assembly pattern (already built at solver.js:6649 as `nonlinearAssemblyPattern`) for the elastic geostatic assembly too, or assemble directly into CSR. We will not apply this now.

### [DEF-SOLVER-C-01] medium · In-app doc presents T6 B-bar as the active default; code makes it opt-in (default OFF)
- **Location:** doc `src/routes/docs/engineering/deformation/+page.svelte:325` and `:635` (§5.4); code `src/lib/cpt-app/deformation/solver.js:2306` (`const useBBarT6 = elementType === 't6' && options?.useBBarFormulationT6 === true`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) The doc §5.4 states for T6: "Volumetric locking is removed by the B-bar projection… applied per Gauss point at element-stiffness assembly," and §3 says T6 "combines naturally with the B-bar near-incompressibility projection." An engineer reading this would reasonably conclude T6 runs are locking-free by default. (2) The code applies B-bar only when `options.useBBarFormulationT6 === true`; the default is OFF (solver.js:2306, with an explicit comment block at 2294–2305 confirming "Default is off"). The WASM path mirrors this opt-in (wasm/pipeline.js:140). (3) Scientifically, plain 3-point T6 *does* lock under plastic incompressibility (ψ→0) / high-ν elasticity — the very situation the doc describes — so a default-OFF B-bar means a default T6 run can lock, contradicting the doc's claim. The B-bar math itself (element-t6.js:119–163) is correct. (4) Fix direction: amend the doc to state B-bar is an opt-in flag (`useBBarFormulationT6`) and that default T6 uses standard B (and may lock for near-incompressible flow), OR change the code default — but a default change is a behavior change for shipped results, so the doc fix is the safer correction.
- **Recommendation:** Reword §5.4 / §3 to make the opt-in nature and default standard-B behavior explicit. We will not apply this now.

### [DEF-SOLVER-C-02] medium · geostatic-init.md describes a planned `geostatic-init.js` module and an old K0 seed that do not match shipped code
- **Location:** doc `docs/deformation/geostatic-init.md:42–58` (old `buildK0ControlledInitialEffectiveStress6` snippet), `:96–112` (proposed `geostatic-init.js` exports), `:340–355` (proposed flow); code `src/lib/cpt-app/deformation/solver.js:2607` (`buildK0ControlledInitialEffectiveStress6`) — the proposed module file does not exist
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) The doc shows the "current problem" `buildK0ControlledInitialEffectiveStress6` returning `…, -(totalStress.txy), 0, 0` — i.e. it retains the *full* elastic slope shear unconditionally, which the doc correctly criticizes as producing inadmissible near-surface states. The doc then proposes a new pure module `src/lib/cpt-app/deformation/geostatic-init.js` with `buildAdmissibleInitialStressField`, `terrainFollowingK0Stress6AtPoint`, `projectStressToAdmissibleSeed`, etc. (2) Reality: no `geostatic-init.js` exists (confirmed by `ls` and grep — none of the proposed symbols are defined anywhere). Instead, the *current* `buildK0ControlledInitialEffectiveStress6` (solver.js:2607–2687) was rewritten in place: it keeps shear only up to the largest admissible scale λ via a 48-step bisection against the exact MC + tension envelope (`isEffectiveStress6McAdmissible`), returning zero shear when the base seed or clipped seed is inadmissible. The tension-boundary three-state semantics the doc proposes (T3 > tol / |T3| ≤ tol / T3 < -tol) *were* implemented (post.js:157–185, and material-models.js). (3) Scientifically the shipped code is the better/correct version — it does not start the plastic continuation from an inadmissible hybrid seed, which was the doc's stated goal. (4) Fix direction: this is a stale design/plan note that has been superseded by an in-place implementation; update or retire the doc so it reflects the in-solver admissibility-clipped seed rather than a non-existent module.
- **Recommendation:** Mark geostatic-init.md as historical/superseded or rewrite it to document the shipped in-place approach (admissibility-limited K0 shear + MC projection). We will not apply this now.

### [DEF-SOLVER-C-03] low · In-app doc symbol table labels K_tan units as [kN/m²]; residual/force are [kN/m] — internally inconsistent unit annotation
- **Location:** doc `src/routes/docs/engineering/deformation/+page.svelte:490` (`K_tan … [kN/m²]`) vs `:461` and `:502` (`F_int, F_ext, R … [kN/m]`)
- **Category:** C — Doc vs Code
- **Confidence:** likely
- **Analysis:** The residual equation `K_tan Δu = R` requires `[K_tan] = [R]/[Δu]`. With force per unit out-of-plane width in [kN/m] and displacement [m], the stiffness should be [kN/m·m] = [kN/m²]·(per-width) — the symbol table writes `[kN/m²]` for K_tan and `[kN/m]` for R and `[m]` for Δu, which is dimensionally consistent for a per-unit-width plane-strain formulation only if read carefully (kN/m² · m = kN/m). This is not a code defect (the code is unit-agnostic; loads are scaled by `outOfPlaneLength`, solver.js:2030,2069), but the mixed annotation is easy to misread. Code is internally consistent (kPa·m² area → kN per unit width). Fix direction: tighten the doc unit annotations / add a one-line note that all force quantities are per unit out-of-plane width.
- **Recommendation:** Clarify the per-unit-width convention in the symbol tables. We will not apply this now.

### [DEF-SOLVER-D-01] low · Dead async `sparseMatVec` wrapper — solvers call `sparseMatVecFallback` directly
- **Location:** `src/lib/cpt-app/deformation/solver.js:322` (`async function sparseMatVec`)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `sparseMatVec` is defined but never called: `solveCg` (1407) and `solveGmresScaled` (1663) both define their matvec as `sparseMatVecFallback`. No other call site exists in-file or elsewhere. The header comment (317–321) describes a future GPU dispatch that the wrapper would host, but today it is unreachable.
- **Recommendation:** FLAG ONLY. Remove or wire in once the GPU dispatch lands.

### [DEF-SOLVER-D-02] low · Dead flat-buffer assembly helpers (`addMatrixBlockFlat`, `addMatrixBlockFlatToCompressedRows`, `addVectorBlockFlatToFreeRhs`)
- **Location:** `src/lib/cpt-app/deformation/solver.js:1959`, `:1984`, `:2007`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** All three are defined and have exactly one occurrence in the file (their definition) and no external importers. The active assembly uses the non-flat variants (`addMatrixBlock`, `addMatrixBlockToCompressedRows`, `addVectorBlockToFreeRhs`). The flat variants appear to be leftovers from a GPU/packed-buffer assembly path that is no longer driven from this module.
- **Recommendation:** FLAG ONLY. Remove if the packed-buffer assembly path is not being revived here.

### [DEF-SOLVER-D-03] low · Dead `compressRhs` — geostatic path uses `gatherFreeVector` (homogeneous Dirichlet)
- **Location:** `src/lib/cpt-app/deformation/solver.js:1926` (`function compressRhs`)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `compressRhs` (which subtracts `K·u_fixed` contributions for non-homogeneous Dirichlet BCs) is defined but never called anywhere in src/. The active RHS compression uses `gatherFreeVector` (solver.js:1938, called at 6646–6647). Since the deformation BCs are homogeneous (u=0 supports, solver.js fixed-DOF map at 2184), the lifting term is zero and `compressRhs` is unnecessary — but it is fully dead.
- **Recommendation:** FLAG ONLY. Remove, or note it is reserved for prescribed-displacement BCs.

### [DEF-SOLVER-D-04] info · Dead GPU-preconditioner flatteners in the CPU subsystem (`flattenBlockJacobiPreconditioner`, `flattenKrylovPreconditionerForResidentGpu`)
- **Location:** `src/lib/cpt-app/deformation/solver.js:649` (exported `flattenBlockJacobiPreconditioner`), `:687` (`flattenKrylovPreconditionerForResidentGpu`)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `flattenKrylovPreconditionerForResidentGpu` (687) is never called. `flattenBlockJacobiPreconditioner` (649) is exported but has no importer anywhere in src/ and is only referenced by the dead `flattenKrylovPreconditionerForResidentGpu`. They flatten the 2×2 block-Jacobi preconditioner into self/prev/next coefficient arrays for a (not-yet-present) resident GPU kernel. Within the CPU subsystem they are inert.
- **Recommendation:** FLAG ONLY. Keep if the resident-GPU CG/GMRES kernel will consume them; otherwise remove.

### [DEF-SOLVER-D-05] info · Dead `multiplyMat3x6Displacement` (T3-only unrolled strain helper)
- **Location:** `src/lib/cpt-app/deformation/solver.js:2468`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** Defined and never called; strain is computed everywhere via the general `multiplyBDisplacement` (2451), including the T3 path. The unrolled 3×6 variant (with a guard that falls back to `multiplyBDisplacement` when dofs.length ≠ 6) is an unused micro-optimization.
- **Recommendation:** FLAG ONLY.

### [DEF-SOLVER-D-06] info · Arc-length continuation options are parsed/forwarded but never consumed by the JS CPU path
- **Location:** `src/lib/cpt-app/deformation/solver.js:526` (`normalizeRequestedContinuationMode`), `:534` (`normalizeArcLengthDerivativeMode`), `:6505–6518` (arcLength* option parsing), `:7265` (`arcLengthDetails: null`)
- **Category:** D — Dead code (within this subsystem)
- **Confidence:** confirmed
- **Analysis:** The JS CPU safety phase (`solveSafetyReductionSearch`, solver.js:5616) uses a bracket-and-grow / cutback scheme on σ_Msf, not arc-length. The full `arcLength*` option block (initial/min/max radius, growth/shrink, target iterations, derivative mode, etc.) and the two `normalize*` continuation helpers are parsed into the options object at 6505–6518 but never read by any JS CPU code; `arcLengthDetails` is hardcoded `null` at 7265. They are pass-through to the WASM/GPU pipelines, which do implement arc-length. Note: the in-app doc §10.6 is *correctly* scoped — it states arc-length is "available on the WASM CPU path" and "GPU v2 retains prescribed strength control only," so there is no doc contradiction; the only issue is dead/forwarded surface area in the JS reference solver.
- **Recommendation:** FLAG ONLY. These are intentional pass-throughs; consider isolating them from the CPU-reference option parsing to avoid the appearance of a CPU arc-length capability.

### [DEF-SOLVER-D-07] info · Duplicate `fallbackK0` and stress-convention helpers across modules
- **Location:** `src/lib/cpt-app/deformation/solver.js:2587` (`fallbackK0`) duplicates `src/lib/cpt-app/deformation/material.js:13` (`fallbackK0`); `totalStress6ToCompressionPositiveStress3D` (solver.js:2592) overlaps `effectiveStress6ToCompressionPositiveStress3D` (imported from material-models.js)
- **Category:** D — Dead/duplicate logic
- **Confidence:** confirmed
- **Analysis:** `fallbackK0(phi) = max(1 - sin(phi), 0)` (Jáky) is implemented identically in both solver.js and material.js; post.js:100 also inlines the same expression. The duplication is benign (all three agree numerically) but is a maintenance hazard: a future change to the K0 default would need to be made in three places. The two compression-positive 6→3D converters likewise overlap.
- **Recommendation:** FLAG ONLY. Consolidate to a single shared helper.

## Notes / limitations of this audit pass
- I read all four target element/kernel files in full and read solver.js in the numerically load-bearing regions (math helpers, Kahan reductions, sparse matvec, block-Jacobi preconditioner, PCG, restarted PGMRES with Givens, compressed assembly, B/strain/internal-force, K0 geostatic seeding, the full Newton/line-search/continuation loop, the service and c-φ safety phases, stress recovery and summaries). I did not exhaustively read every progress/record-building and diagnostics-formatting block in solver.js; those are non-numerical and low-risk, but a wrong sign in a *displayed* quantity there would not have been caught.
- I cross-checked the constitutive update only at the seams used by this subsystem (`extractTangent2DFrom6`, `extractStress2DFrom6`, the 6×6 elastic matrix, MC indicator/tension semantics). The interior of the exact MC return mapping and consistent tangent lives in material-models.js and is out of scope for def-solver; I confirmed only that the plane-strain slice of the 6×6 tangent is the correct in-plane tangent (it is, for the kinematic ε_zz=0 constraint).
- The T6 B-bar factor 1/2 (in-plane volumetric projection, element-t6.js:103,147) is a deliberate plane-strain modeling choice, not a 3D (1/3) projection; the code comment (114–118) acknowledges this explicitly. I treated it as an accepted formulation, not a defect.
- Triangle element orientation (CCW) is not explicitly re-enforced in mesh.js, but the solver is robust to orientation: the signed B (1/area2) is used consistently for strain and internal force, and stiffness is sign-insensitive, so CW elements would still produce the correct K and consistent F_int. I confirmed this analytically rather than by running a CW fixture.
- I did not execute the solver or any verification scripts; all findings are from static reading of the actual code and docs at the stated line numbers.
