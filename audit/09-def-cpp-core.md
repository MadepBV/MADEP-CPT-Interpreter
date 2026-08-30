# Audit — WASM C++ core — solver, elements, CG, sparse, linalg, beam
**Subsystem key:** def-cpp-core
**Files reviewed:** src/wasm/deformation/types.hpp, src/wasm/deformation/element.hpp, src/wasm/deformation/beam.hpp, src/wasm/deformation/cg.hpp, src/wasm/deformation/sparse.hpp, src/wasm/deformation/linalg.hpp, src/wasm/deformation/math_js_mirror.hpp, src/wasm/deformation/solver.hpp, src/wasm/deformation/deformation_wasm.cpp, src/wasm/deformation/material_mc_exact.hpp (cross-ref), src/wasm/deformation/README.md, docs/deformation/certification-log.md; JS reference: src/lib/cpt-app/deformation/{element-t3.js, element-t6.js, material-models.js, material.js, solver.js}
**Finding counts:** critical=0 high=1 medium=3 low=5 info=3 | A=3 B=2 C=3 D=4 | total=12

## Overview
The C++ FEM core is a careful, largely faithful port of the JS reference. The T3/T6 B-matrices, B-bar volumetric projection, Gauss rules, plane-strain elastic D, CSR assembly, the exact Mohr-Coulomb return mapping (material_mc_exact.hpp uses the same compression-positive principal-stress yield form as JS), the Timoshenko wall-beam element, the spherical arc-length corrector, and the GMRES/CG solvers all check out against the governing equations and the JS reference. The most substantive issue is a deliberate but undocumented divergence in the Newton convergence tolerance (the WASM scales the absolute residual floor by √nfree, JS does not), which makes the WASM accept a looser-converged state than the oracle. Remaining findings are localized robustness/preconditioner-quality concerns, diagnostic-field miscategorization, doc inaccuracies in README, and dead/unused helpers. No sign errors, no unit slips, no incorrect governing equations were found in the hot path.

## Findings

### [DEF-CPP-CORE-A-01] high · Newton absolute residual tolerance diverges from JS reference by a √nfree factor
- **Location:** `src/wasm/deformation/solver.hpp:1885-1907` (`nonlinear_absolute_residual_target` / `nonlinear_residual_target`); JS reference `src/lib/cpt-app/deformation/solver.js:344-362` (`nonlinearToleranceState`)
- **Category:** A — Implementation (and C — doc/reference divergence)
- **Confidence:** confirmed
- **Analysis:** The C++ convergence target multiplies the absolute residual floor by `sqrt(nfree)` whenever `absTol <= 1.0000001e-3` (the UI default `1e-3`):
  ```cpp
  if (absTol <= 1.0000001e-3) {
    const double dofScale = std::sqrt(static_cast<double>(std::max<std::int32_t>(nfree, 1)));
    return absTol * dofScale;
  }
  ```
  The JS oracle does **not** scale: `residualTarget = max(residualAbsTol, residualRelTol * rhsNorm)` (solver.js:350). For a mesh with, e.g., nfree ≈ 4000, the WASM absolute floor is ~63× larger than the JS one. The assembled residual is a raw global L2 norm in both implementations, so the two are comparing the same quantity against different thresholds. Consequence: in load states where the absolute floor binds (geostatic-balanced or very lightly loaded configurations, where `residualRelTol * rhsNorm` is small), the WASM declares convergence at a residual up to √nfree larger than the JS reference would — i.e., a less-converged displacement/stress field. In well-loaded problems the relative term (`residualRelTol = 1e-4` × rhsNorm) usually dominates and the divergence is masked. The C++ comment argues the scaling is "more physical" (per-DOF force floor lifted to an L2 vector target); that may be defensible engineering, but it is an undocumented break from the stated 1:1 reference and changes the accept/reject decision and therefore the committed solution.
- **Recommendation:** Decide which side is the intended contract. If JS is the oracle, drop the `dofScale` so the WASM matches `max(absTol, relTol*rhsNorm)`. If the √nfree scaling is intended, apply the identical scaling in the JS reference and the parity harness (`scripts/verify_wasm_cpu_parity.mjs`) and document it in README "Precision". Do not silently keep two different convergence criteria.

### [DEF-CPP-CORE-A-02] low · CSR scatter binary search has no "column present" guard (potential out-of-row / out-of-buffer write)
- **Location:** `src/wasm/deformation/sparse.hpp:115-124` (`scatter_element_matrix`), `145-152` (`scatter_dense_matrix`)
- **Category:** A — Implementation / memory hazard
- **Confidence:** confirmed (the missing check is real; triggering it requires a pattern/scatter mismatch)
- **Analysis:** Both scatter routines locate the target column with a bare lower-bound binary search and then immediately do `A.values[a] += Ke[...]` without verifying `a < hi && A.colIdx[a] == fj`:
  ```cpp
  while (a < b) { std::int32_t m = (a + b) >> 1; if (A.colIdx[m] < fj) a = m + 1; else b = m; }
  A.values[a] += Ke[i * n + j];
  ```
  Contrast `find_col` (line 83-95), which *does* check `a < hi && A.colIdx[a] == c`. If `fj` is ever absent from row `fi`, `a` lands at `hi` (= `rowPtr[fi+1]`), and the write corrupts the first entry of the next row, or — for the last free row — writes at index `nnz` (one past `values`), a heap overrun. In current code the sparsity pattern is built from exactly the same element + beam DOF lists used by the scatter (`build_pattern` at sparse.hpp:31-72 adds `el.dofs` and beam `el.dofs`), so the column is always present and the bug is latent. It becomes live if the pattern and the scatter ever desynchronize (e.g., a future change adds a coupling term to one but not the other).
- **Recommendation:** Add the same `if (a < hi && A.colIdx[a] == fj)` guard used by `find_col` before the `+=`, and treat a miss as an assertion/error rather than a silent write.

### [DEF-CPP-CORE-A-03] low · Safety-curve "dominant DOF" classification mislabels wall rotation DOFs as Ux/Uy
- **Location:** `src/wasm/deformation/solver.hpp:1948-1967` (`make_safety_curve_point`)
- **Category:** A — Implementation (diagnostic field)
- **Confidence:** confirmed
- **Analysis:** The loop iterates over the full DOF vector (`ndof`, which includes wall rotation DOFs appended after `2*numNodes`) and classifies each DOF by parity:
  ```cpp
  if ((dof & 1) == 0) point.uHorizontalMax = std::max(...);   // assumes Ux
  else point.uSettlementMax = std::max(point.uSettlementMax, -du);  // assumes Uy
  ...
  point.dominantNode = dominantDofIndex / 2;  // bogus for a rotation DOF
  ```
  A wall rotation DOF (a section rotation θ_z, not a translation) can dominate `maxAbs`, and it will be reported as a translation with a fabricated `dominantNode = rotationDof/2` and folded into `uHorizontalMax`/`uSettlementMax`. These are diagnostics for the safety continuation chart only — they do not feed the solver — but the reported "dominant node / settlement" can be misleading on wall models. Note the wall result block correctly handles rotations elsewhere; only this curve-point summary is affected.
- **Recommendation:** Bound the classification loop to soil translation DOFs (`dof < 2*numNodes`) or skip indices that map to a wall rotation DOF when accumulating `uHorizontalMax`/`uSettlementMax`/dominant-node.

### [DEF-CPP-CORE-B-01] low · Block-Jacobi fallback can pair two unrelated wall rotation DOFs into a spurious 2×2 block
- **Location:** `src/wasm/deformation/sparse.hpp:327-371` (`build_block_jacobi`), `513-531` (`apply_block_jacobi`)
- **Category:** B — Performance / preconditioner quality
- **Confidence:** likely
- **Analysis:** The soil 2×2 detection keys purely on global-DOF parity and adjacency: `isUx = (globalI % 2) == 0` and `nextIsUyOfSameNode = (freeDofs[i+1] == globalI + 1) && isUx`. Wall rotation DOFs are appended starting at `nextRotationDof = 2*numNodes` (an even number), so a rotation DOF can be "even" and the next rotation DOF can be `globalI+1`. If two rotation DOFs are free and consecutive in `freeDofs`, the fallback path treats them as a node's (Ux,Uy) pair and builds a 2×2 inverse coupling two physically unrelated rotation DOFs. In practice the wall preconditioner triplets/dense blocks (set via `build_wall_preconditioner_*`) overwrite the mode bytes for active wall rotation DOFs, and `apply_block_jacobi` checks the Wall3/Dense mode first and `continue`s — so the spurious 2×2 is normally bypassed. It can still be reached when a 3×3 wall block is rejected as non-SPD (`invert_spd3_cholesky` returns false → `continue`, mode left unset) or for any rotation DOF not covered by a triplet/dense block. This only degrades preconditioner quality (CG still converges to the true solution; it is only used for SPD tangents), so it is a robustness/performance concern, not a wrong answer.
- **Recommendation:** Gate the 2×2 pairing on the DOF actually being a soil translation pair (e.g., `globalI < 2*numNodes` and the node id of `globalI` equals that of `freeDofs[i+1]`) rather than on raw parity, so rotation DOFs always fall through to the scalar branch when no wall block covers them.

### [DEF-CPP-CORE-B-02] low · GMRES path drops the wall preconditioner; rebuilds full block-Jacobi each solve
- **Location:** `src/wasm/deformation/solver.hpp:1268-1280` (`solve_phase_linear_system`), `src/wasm/deformation/cg.hpp:275-279` (`solve_gmres_scaled` preconditioner build)
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** When `useUnsymmetricSolver` is true the wall preconditioner triplets/blocks (`wallPreconditionerTriplets`, `wallPreconditionerBlocks`) are not forwarded; GMRES builds only the 2×2/scalar block-Jacobi on the scaled matrix (`sparse::build_block_jacobi(activeCache.scaled.matrix, freeDofs, activeCache.diag_inv)` with no wall args). For plastic/HS wall problems the wall rotation DOFs therefore get a weaker (scalar) preconditioner, costing extra Krylov iterations. Additionally, in the Newton hot loop `solve_phase_linear_system` is called with `reuseDiagInv=false` every iteration, so for the CG path `build_block_jacobi` (which itself does a `find_col` binary search per block) is rebuilt on every Newton iteration even when the pattern is unchanged. The GMRES `GmresScalingCache` is also passed as `nullptr` from the main Newton dispatch (solver.hpp:3261), so the row/column equilibration and its block-Jacobi are recomputed (including a full FNV hash of all matrix values) on every plastic iteration. None of this is incorrect, but it is avoidable per-iteration work in the hottest loop.
- **Recommendation:** Plumb the wall preconditioner blocks into the GMRES preconditioner build, and pass a persistent `GmresScalingCache` (already supported by the API) across Newton iterations of a step so the equilibration/preconditioner are reused when the pattern is stable.

### [DEF-CPP-CORE-C-01] medium · README claims the WASM MC yield uses tension-positive principals; the code uses compression-positive (matching JS)
- **Location:** `src/wasm/deformation/README.md:108-117` (Convention notes); actual code `src/wasm/deformation/material_mc_exact.hpp:140-195, 279-289`
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** README states: "The MC yield function in this convention is `f = (σ1 - σ3) + (σ1 + σ3) sin φ - 2 c cos φ` with σ1 ≥ σ2 ≥ σ3 (sorted descending). The CPU path uses compression-positive principals and so has a leading minus sign on the second term." This describes a tension-positive WASM yield form. The actual implementation does the opposite: `principal_stress_projectors_3d_compression_positive` negates the tension-positive Voigt stress into compression-positive principals (s1 = most compressive), and `evaluate_exact_mc_surface_values_from_principal` uses `F13 = (1 - sinφ)·s1 - (1 + sinφ)·s3 - 2c·cosφ` — the standard compression-positive MC form, byte-for-byte identical to the JS reference (`material-models.js:752-754`). The code is scientifically correct and matches the oracle; the README's convention note is wrong/outdated and would mislead a future maintainer into thinking the two backends disagree on sign (they do not).
- **Recommendation:** Fix the README to state the WASM exact-MC path uses compression-positive principals with `F13 = (1-sinφ)s1 - (1+sinφ)s3 - 2c·cosφ`, identical to the CPU path. (Fix the doc, not the code.)

### [DEF-CPP-CORE-C-02] medium · README "Out of scope" and "modified Newton" claims are stale vs the implemented consistent-tangent / HS / arc-length features
- **Location:** `src/wasm/deformation/README.md:93-137`
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** README states the module "currently uses **modified Newton** (elastic tangent at yielding Gauss points)" and lists as deliberately out of scope: "Consistent (non-modified) algorithmic MC tangent ... Enabled would require a GMRES dispatch for non-associated flow", "Exact two-surface (edge) MC return mapping", "Adaptive Newton continuation that targets a specific iteration count", and "Hardening Soil and other future constitutive plugins". The code contradicts all four: (1) a consistent algorithmic tangent path exists and is selected when `rp.hs.useConsistentTangent >= 0.5` (`evaluate_gp_response_ex` lines 510, 682, 695) with a real GMRES dispatch (`mc_plastic_active_tangent_must_use_gmres`, `solve_gmres_scaled`); (2) the exact active-set return (`solve_exact_mc_active_set_return`) handles edge/apex branches; (3) adaptive continuation targeting `kContinuationTargetIterations`/`targetIters` is implemented (solver.hpp:3710-3719); (4) Hardening Soil is fully wired (`ConstitutiveKind::HardeningSoil`, `material_hs.hpp`, plane-strain wrapper, arc-length). The wire format is v12, not the v2 the README repeatedly cites (README:30,70,74; deformation_wasm.cpp:3, 190). The code is the source of truth; the README has drifted by many revisions.
- **Recommendation:** Rewrite the README "Precision", "Out of scope", and "Wire format (version 2)" sections to reflect v12, the consistent-tangent/GMRES path, the exact edge/apex return, adaptive continuation, HS, and arc-length. (Fix the doc.)

### [DEF-CPP-CORE-C-03] low · Certification log is GPU-only and does not record the WASM CPU path's certification status
- **Location:** `docs/deformation/certification-log.md` (whole file)
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** The paired certification log enumerates only GPU backends (cpu-f32/WebGL, WebGPU CG/FGMRES, GPU MC kernels) plus the "CPU f64 deformation solver = oracle". It contains no row for the C++/WASM CPU port that this subsystem implements, even though README describes it as an "opt-in fast path" the user can toggle and the repo ships `scripts/verify_wasm_cpu_parity.mjs`. A reader cannot tell from the certification log whether the WASM path is unit/engineering/production certified or what evidence backs it. This is a documentation-coverage gap, not a code defect.
- **Recommendation:** Add a row for the WASM CPU port (level, date, the parity script + result hashes as evidence, sign-off), or explicitly note in the log that the WASM path inherits the oracle's certification only when `verify_wasm_cpu_parity.mjs` passes within stated tolerances.

### [DEF-CPP-CORE-D-01] info · `linalg::elastic_matrix_E_nu` and several math_js_mirror helpers are unused in the WASM hot path
- **Location:** `src/wasm/deformation/math_js_mirror.hpp:111-118` (`add_pore_pressure_to_normal_components`), plus `compression_positive_tensor3_to_stress6`, `projectors_to_compression_positive_stress_tensor`, `dense_matrix_condition_number_estimate`, `relative_pivot_tolerance` and similar mirror functions
- **Category:** D — Dead code (flag only)
- **Confidence:** likely
- **Analysis:** `add_pore_pressure_to_normal_components` has no caller anywhere in the WASM sources (grep finds only its definition); its JS counterpart is only used by `totalStress6ToEffectiveStress6` for output conversion, which the WASM does not perform (pore pressure is carried per-GP but never folded into effective stress, correctly, since the solver works in effective stress and the gravity RHS is precomputed buoyant). Several other mirror helpers (condition-number estimate, pivot-tolerance, a couple of projector/tensor conversions) appear to be 1:1 ports kept for completeness but not invoked by the solver. These are harmless but add maintenance surface and can confuse a reader into thinking pore pressure enters the yield surface.
- **Recommendation:** Flag for review; either wire them up if intended or annotate them as "ported for parity completeness, intentionally unused" so future audits don't re-investigate.

### [DEF-CPP-CORE-D-02] info · `elem::element_body_force` is unused (gravity is supplied as a precomputed full-DOF RHS over the wire)
- **Location:** `src/wasm/deformation/element.hpp:252-268` (`element_body_force`)
- **Category:** D — Dead code (flag only)
- **Confidence:** confirmed
- **Analysis:** The body-force kernel (T3 lumped at corners, T6 lumped at midpoints) is implemented and correct vs the JS reference, but the WASM never calls it: gravity is delivered as `gravityRhsFull` (full-DOF, "-gamma*area lumped already" per the wire-format comment, deformation_wasm.cpp:57) and assembled directly. The function is dead in the C++ path. Not a defect; flagging for inventory only.
- **Recommendation:** Flag; keep if a future on-device gravity assembly is planned, otherwise consider removing in a separate cleanup change.

### [DEF-CPP-CORE-D-03] info · `solve_gmres` compatibility wrapper and `cg::solve_cg` unused-arg shims
- **Location:** `src/wasm/deformation/cg.hpp:465-477` (`solve_gmres` wrapper, ignores its 2nd arg), `src/wasm/deformation/types.hpp` unused `SolverOptions` arc-length fields not read on the wire
- **Category:** D — Dead code (flag only)
- **Confidence:** likely
- **Analysis:** `cg::solve_gmres` is a thin back-compat shim around `solve_gmres_scaled` with an ignored `std::vector<double>&` parameter; no caller in the current tree uses the legacy signature (the solver calls `solve_gmres_scaled` directly via `solve_phase_linear_system`). Likewise, several `SolverOptions` arc-length tuning fields (e.g. `arcLengthInitialRadius`, `arcLengthGrowthFactor`, `arcLengthTargetIterations`, `arcLengthAllowPostPeakSafetyPath`) have wire reads only for a subset; the remainder default in-struct and are not transported. Harmless, flagging for inventory.
- **Recommendation:** Flag; remove the legacy `solve_gmres` shim if no caller depends on it, and confirm which arc-length options are wire-transported vs default-only.

### [DEF-CPP-CORE-D-04] info · `material_mc.hpp` (smooth Drucker-Prager fallback file) vs the in-solver smooth fallback — duplicate smooth-surface logic
- **Location:** `src/wasm/deformation/material_mc.hpp` (whole file), vs `src/wasm/deformation/solver.hpp:178-365` (`evaluate_smoothed_plastic_surface`, `smooth_surface_gradient6`, `return_map_smooth_mc_plastic`)
- **Category:** D — Dead code / duplicate logic (flag only)
- **Confidence:** uncertain
- **Analysis:** `material_mc.hpp` (558 lines) is included by deformation_wasm.cpp but the smooth/approximate MC surface, its gradient, and the smooth return mapping appear to be re-implemented inline in solver.hpp (the production smooth fallback used by `evaluate_gp_response_ex`). It is unclear from this pass whether `material_mc.hpp` still has live callers or has been superseded by the exact path (`material_mc_exact.hpp`) plus the in-solver smooth fallback. If superseded, it is duplicate constitutive logic that could drift from the solver's copy. I did not fully trace every symbol in `material_mc.hpp`, so this is flagged as uncertain.
- **Recommendation:** Flag for a focused follow-up: grep callers of each `material_mc.hpp` export; if the exact path + in-solver smooth fallback fully supersede it, mark/remove the file in a dedicated cleanup, otherwise document why both copies exist.

## Notes / limitations of this audit pass
- I read the numerically critical files in full (types, element, beam, cg, sparse, linalg, math_js_mirror, deformation_wasm.cpp) and the load-bearing parts of solver.hpp (assembly, GP response dispatch, K0 seeding, the Newton phase incl. line search + load-step controller, the safety bracketing driver, the arc-length corrector, and the wall preconditioner builders). I did **not** line-by-line verify the full bodies of `material_mc_exact.hpp` (1821 lines), `material_hs.hpp` (4490 lines), `material_hs_tangent.hpp` (1078 lines), `material_mc.hpp` (558 lines), or the two large arc-length phase functions (`run_load_arc_length_phase`, `run_safety_arc_length_phase`, ~900 lines combined) beyond their interfaces and key formulas — a constitutive-kernel-focused second pass on the HS return mapping, the HS consistent tangent, and the exact MC edge/apex branches is warranted (those are where a subtle return-mapping or consistent-tangent error would hide).
- The MC exact-path yield convention, T3/T6 B-matrix, B-bar, elastic D, Timoshenko beam stiffness/transformation, arc-length constraint linearization, and the GMRES equilibration/restart logic were cross-checked against the JS reference or first principles and are correct.
- The √nfree residual-tolerance divergence (A-01) is confirmed at the code level; its *practical* magnitude depends on whether the absolute floor or the relative (rhsNorm) term binds for a given model — I did not run the parity harness to quantify the worst-case displacement error, so the engineering impact is asserted qualitatively.
- I could not execute the build or `verify_wasm_cpu_parity.mjs` in this pass; all findings are from static reading of the C++ and the JS reference.
