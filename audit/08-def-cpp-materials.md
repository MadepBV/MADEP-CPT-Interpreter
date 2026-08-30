# Audit — WASM C++ constitutive models (MC exact, HS, tangents, JS mirror)
**Subsystem key:** def-cpp-materials
**Files reviewed:** src/wasm/deformation/math_js_mirror.hpp, src/wasm/deformation/material_mc.hpp, src/wasm/deformation/material_mc_exact.hpp, src/wasm/deformation/material_hs.hpp, src/wasm/deformation/material_hs_tangent.hpp, src/lib/cpt-app/deformation/material-models.js (reference), docs/deformation/MC.md, docs/deformation/MC_pl.md, docs/features/hardening-soil-simo-hughes-implementation-log.md, scripts/scratch/mc_sh_phase_0_report.md, src/wasm/deformation/linalg.hpp (helpers)
**Finding counts:** critical=0 high=0 medium=2 low=4 info=3  |  A=0 B=0 C=4 D=3 (+2 info span A/D)  |  total=9

## Overview
This is a carefully engineered, well-tested subsystem. The MC exact active-set return mapping in
`material_mc_exact.hpp` is an essentially line-for-line, convention-equivalent mirror of the JS reference
(`material-models.js`): surface gradients, tension-cutoff coefficients, branch classification, candidate
priority ordering, principal-frame active-set solve, spectral consistent tangent (with the representation
projector derivative), and tolerance derivations all match. The native HS implementation (cone/cap/corner
return maps, Simo-Hughes consistent tangents, K0/cap calibration) is internally consistent with standard
HS theory (Schanz/Vermeer/Benz) and is backed by FD/residual oracles documented in the implementation log;
spot-checked derivatives (cone `df/dq`, `df/dq_a`, cap gradient/trace, Schanz `M` seed) are correct. I found
no critical or high-severity correctness bug. The findings are: (1) two genuine JS↔C++ mirror divergences in
rarely-exercised fallback/diagnostic paths (medium), (2) a small internal HS helper inconsistency that only
bites at the deviatoric asymptote (low), and (3) substantial dead/superseded MC code (`run_mc_return_mapping`
+ `continuum_tangent_mc_global`) retained only for local harnesses — the live FE MC path is `material_mc_exact.hpp`.

## Findings

### [DEF-CPP-MATERIALS-C-01] medium · committed-state seed fallback directions diverge from JS mirror
- **Location:** `src/wasm/deformation/material_mc_exact.hpp:585-603` (`direction_candidates_from_committed_state`) vs `src/lib/cpt-app/deformation/material-models.js:1192-1208` (`directionCandidatesFromCommittedState`)
- **Category:** C — Doc/code (JS mirror) consistency
- **Confidence:** confirmed
- **Analysis:** These two functions are meant to be exact mirrors (the C++ comment header cites `JS:1034`).
  They feed seed directions into `buildRepeatedSubspaceProjectors` for repeated-eigenvalue (edge/corner)
  branches. The seeds are produced by `rankOneProjectorToDirection(projector, fallback)` — the `fallback`
  is only used when the committed projector is rank-deficient/near-zero. The fallbacks differ:
  - S23_EQUAL: JS uses fallback `[0,1,0]` for **both** P2 and P3 seeds; C++ uses `{0,1,0}` for P2 and
    `{0,0,1}` for P3.
  - S12_EQUAL: JS uses `[1,0,0]` for **both** P1 and P2 seeds; C++ uses `{1,0,0}` for P1 and `{0,1,0}` for P2.
  - DISTINCT/else: JS uses `[1,0,0]` for **all three** of P1/P2/P3; C++ uses per-axis `{1,0,0}`,`{0,1,0}`,`{0,0,1}`.

  In the common case the projector yields a valid direction and the fallback is dead, so results match. But
  this branch is reached precisely on repeated-eigenvalue / axisymmetric committed states (K0-NC, oedometric),
  which are exactly the states where a committed projector can be degenerate. There the two ports can select
  different representative directions, then a different representative-surface basis, and diverge in the
  returned stress/tangent for that Gauss point — silently breaking WASM↔CPU parity. The C++ per-axis canonical
  fallback is arguably the *more* robust choice (distinct seeds), but it is not what the JS reference does, so
  bit-exact cross-validation against `material-models.js` is not guaranteed in the degenerate case.
- **Recommendation:** Pick one convention and make both match. Either change the C++ fallbacks to the uniform
  JS values, or update the JS reference to the per-axis canonical seeds (the latter is preferable on robustness
  grounds) — but they must agree, and the parity-verifier fixtures should include a degenerate committed-projector
  case to lock it.

### [DEF-CPP-MATERIALS-C-02] medium · MC.md yield/eta formula uses opposite sign convention to the live exact code (doc gap)
- **Location:** `docs/deformation/MC.md:698-700, 713-714` vs `src/wasm/deformation/material_mc_exact.hpp:287-292` and `material_mc.hpp:74-76`
- **Category:** C — Doc/code consistency
- **Confidence:** confirmed
- **Analysis:** MC.md (the shipped/UI MC documentation) states the yield function as
  `f = (σ1' - σ3') - (σ1' + σ3')·sin φ' - 2 c' cos φ'` and `η = (σ1'-σ3') / ((σ1'+σ3')sin φ' + 2 c' cos φ')`,
  in a **compression-positive** screening convention. The engineering helper `material_mc.hpp::mc_yield_principal`
  is **tension-positive**: `f = (σ1 - σ3) + (σ1 + σ3) sin φ - 2 c cos φ`, and `eta` uses
  `(s1-s3)/(2c cosφ - (s1+s3)sinφ)`. The live exact path `material_mc_exact.hpp` evaluates surfaces in
  **compression-positive principals** as `F13 = (1-sinφ)σ1 - (1+sinφ)σ3 - 2c cosφ`, which equals the MC.md
  compression-positive form `(σ1-σ3) - (σ1+σ3)sinφ - 2c cosφ`. (1) Doc says the compression-positive form;
  (2) the exact code agrees with the doc's compression-positive form, but the legacy `material_mc.hpp` helper
  uses the tension-positive form with the inverted middle-term sign and an inverted-sign eta denominator;
  (3) both formulas are scientifically correct in their own stated conventions (they describe the same hexagonal
  MC surface under σ → −σ); (4) Fix direction: documentation. MC.md describes a `material-models.js`/`post.js`
  screening route and does not state that the *live FE constitutive* return map is `material_mc_exact.hpp`
  (compression-positive principals) — and that the also-present tension-positive `material_mc.hpp` helper is no
  longer the FE path (see D-01). The doc should note the convention split so a reader does not "fix" the exact
  code's middle-term sign to match the doc's tension-positive-looking `eta`.
- **Recommendation:** Add a convention note in MC.md clarifying (a) which sign convention each shipped code path
  uses, and (b) that the live FE MC return map is `material_mc_exact.hpp` (compression-positive principals), not
  `material_mc.hpp::run_mc_return_mapping`. No code change needed.

### [DEF-CPP-MATERIALS-C-03] low · `tangentCoupling` is assembled transposed relative to the JS mirror
- **Location:** `src/wasm/deformation/material_mc_exact.hpp:1314-1322` vs `src/lib/cpt-app/deformation/material-models.js:1524-1526`
- **Category:** C — Doc/code (JS mirror) consistency
- **Confidence:** confirmed
- **Analysis:** JS builds `tangentCouplingMatrix[i][j] = dotVector6(surfaceI.n6, D_e·surfaceJ.m6)`. The C++
  computes `Cm = C·surfaces[i].m6` then writes `tangentCoupling[j][i] = dot(surfaces[j].n6, Cm)`, i.e. C++ stores
  `n_j·C·m_i`, which is the transpose of the JS `n_i·C·m_j`. This matrix is consumed **only** by
  `dense_matrix_condition_number_estimate` → `tangentConditionNumber` → `classify_tangent_quality`, a diagnostic
  (telemetry) quantity; it does not enter the stress or the algorithmic tangent. The estimator returns
  `‖A‖_∞ · ‖A⁻¹‖_∞`, which is **not** transpose-invariant for 2×2 active sets (edge/corner branches), so the
  reported `tangentConditionNumber`/`tangentQuality` can differ slightly between WASM and JS on multi-surface
  branches. For 1×1 active sets (most face/tension branches) it is identical. No physical consequence.
- **Recommendation:** Swap the index to `tangentCoupling[i][j] = dot(surfaces[i].n6, C·surfaces[j].m6)` to match
  JS exactly, so the diagnostic condition number is bit-comparable across ports.

### [DEF-CPP-MATERIALS-C-04] low · HS cone-zero γ_p helper and `cone_yield_value` clamp the deviator inconsistently
- **Location:** `src/wasm/deformation/material_hs.hpp:4126-4140` (`cone_zero_gamma_p_for_principal_pair`) vs `material_hs.hpp:334-342` (`cone_yield_value`)
- **Category:** C — internal consistency (no JS mirror for HS)
- **Confidence:** confirmed
- **Analysis:** `cone_zero_gamma_p_for_principal_pair` is meant to invert `f^s = 0` so that
  `cone_yield_value(q, …, γ_p_seed) == 0`. But the two functions clamp `q` differently:
  `cone_yield_value` uses `q_clamped = min(q, 0.999 q_a)` in **both** the hyperbolic term and the linear
  `-2 q/E_ur` term (line 339-340), whereas `cone_zero_gamma_p_for_principal_pair` uses `q_clamp` in the
  hyperbolic term but the **unclamped** `q` in the linear term (line 4139: `… - 2.0 * q / c.E_ur`). The
  textbook HS hyperbolic relation `γ_p = (2/E_i)q/(1-q/q_a) - 2q/E_ur` (Benz/Schanz) uses unclamped `q` in
  the linear term, so the *zero-γ_p* helper matches theory; `cone_yield_value` is the one that additionally
  clamps the linear term. Consequently, when `q > 0.999 q_a` (state essentially on the deviatoric asymptote),
  `cone_yield_value` evaluated at `γ_p_seed` is not exactly 0 — the seed leaves a small residual cone value.
  In normal operation `q ≪ q_a` (q_a is the failure asymptote), so the clamp never activates and the two
  agree to machine precision; this is a latent edge-case inconsistency, not an operating-range error.
- **Recommendation:** Use the same clamping in both helpers (either clamp the linear term in
  `cone_zero_gamma_p_for_principal_pair`, or — preferable for theory fidelity — use unclamped `q` in the
  linear term of `cone_yield_value` and rely on the hyperbolic-term clamp for the singularity guard). Low
  priority because it only differs at the asymptote.

### [DEF-CPP-MATERIALS-D-01] medium · `run_mc_return_mapping` is dead in the shipped module (superseded by material_mc_exact)
- **Location:** `src/wasm/deformation/material_mc.hpp:387-556` (`run_mc_return_mapping`) and supporting `mc_return_principal` (115-162)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** A repo-wide search shows `run_mc_return_mapping` is referenced only by
  `scripts/scratch/mc_sh_phase_0.cpp` and `scripts/scratch/mc_sh_phase_0_report.md` — never by the WASM module,
  bindings, or solver. The phase-0 report states explicitly: *"full FE MC dispatch goes through
  `solver.hpp::evaluate_gp_response_ex` and `material_mc_exact.hpp`; the older `material_mc.hpp` path is still
  compiled and used by HS Rankine helpers and local harnesses, but `run_mc_return_mapping` is not the live FE
  return map."* The file's own header (lines 22-24) admits this path "still returns the elastic tangent" and is
  an approximate single-pass projector that lacks the exact active-set bookkeeping the live path has. Keeping a
  second, lower-fidelity MC return map in a compiled header is a correctness hazard (a future maintainer could
  wire it in, or copy its inverted-sign conventions) and bloats the parity surface. Note `mc_return_principal`
  (the helper it calls) is likewise only reachable through `run_mc_return_mapping`.
- **Recommendation:** Flag only (no deletion in this pass). Consider moving `run_mc_return_mapping` /
  `mc_return_principal` behind a `#ifdef` harness guard or into a scratch/test-only header so it cannot be
  confused with the live path. `rankine_tension_return`, `spectral_tensor_to_voigt`, and `build_elastic_6x6`
  in the same file ARE live (used by HS tension return / linalg), so do not remove the whole file.

### [DEF-CPP-MATERIALS-D-02] low · `continuum_tangent_mc_global` is orphaned (harness-only)
- **Location:** `src/wasm/deformation/material_mc.hpp:283-369`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** Repo-wide search: `continuum_tangent_mc_global` is referenced only by `material_mc.hpp` itself,
  the MC-SH-0 scratch harness/report, and a single descriptive comment in `material_hs.hpp:3018` ("mirrors
  `continuum_tangent_mc_global`"). It is the smooth-face MC consistent tangent that MC-SH-0 fixed, but the live
  exact path uses `compute_exact_elastoplastic_tangent` in `material_mc_exact.hpp` instead. It is exercised only
  by `scripts/verify_mc_simo_hughes_phase_0.mjs`. Dead with respect to the shipped WASM module.
- **Recommendation:** Flag only. Same disposition as D-01 — guard it as harness-only or document it as a
  verifier reference, so it is not mistaken for a live tangent.

### [DEF-CPP-MATERIALS-D-03] low · zero-by-construction `recoveryResidual` recomputation in MC exact (mirrors JS, but is computationally dead)
- **Location:** `src/wasm/deformation/material_mc_exact.hpp:1301-1308` (mirrors `material-models.js:1515-1523`)
- **Category:** D — Dead code (redundant computation)
- **Confidence:** confirmed
- **Analysis:** `plasticStrainIncrement6 = plastic_increment_from_stress_correction(trial, return, mp)`, then
  `recoveryResidual = plastic_increment_from_stress_correction(trial, return, mp) − plasticStrainIncrement6`.
  The two calls are identical, so `recoveryResidual ≡ 0` and `recoveryResidualNorm ≡ 0`,
  `planeStrainResidualZz ≡ 0` always. This faithfully mirrors the JS (which has the same identically-zero
  expression), so it is correct as a *parity* mirror, but it is a dead computation in both ports — the residual
  diagnostic it claims to compute is structurally always zero and the second
  `plastic_increment_from_stress_correction` call is wasted work per accepted branch.
- **Recommendation:** Flag only. If the intent was to compare against a *different* (e.g. multiplier-based or
  representation-corrected) increment, fix both JS and C++ to compute that other quantity; otherwise drop the
  redundant call and set the residual fields to 0 directly. Keep JS and C++ in lock-step either way.

### [DEF-CPP-MATERIALS-A-01] info · math_js_mirror, surface, tangent, and tolerance math verified convention-equivalent to JS
- **Location:** `src/wasm/deformation/math_js_mirror.hpp` (whole), `material_mc_exact.hpp:200-1482`
- **Category:** A — Implementation (positive verification)
- **Confidence:** confirmed
- **Analysis:** I independently checked the items the brief calls out as silent-divergence risks and found them
  convention-equivalent: `atan2` branch (`principal_stress_projectors_3d_compression_positive` uses
  `0.5·atan2(2τ, σxx−σyy)` exactly as JS:638); eigenvector sign and normalization (`normalize_vector3` /
  `principal_direction_to_projector` use the same `>1e-12` guard and fallback as JS:199/270); `sqrt`-near-zero
  (`equivalent_plastic_strain_increment` uses `max(…,0)` before `sqrt`, matching JS:457); engineering-shear
  Voigt factors (`projector_tensor_to_engineering_gradient6` uses 2×, the internal gradient uses −2×, matching
  JS:259/557); `dot_vector6`/`weighted_engineering_strain_dot` weights match JS exactly; tolerance helpers
  (`mc_tolerance`, `eig_tolerance`, `resolve_*`) reproduce the JS relative/absolute floor structure and the
  `5e-7`/`1e-7` apex/edge scales and `20×`/`0.01` apex-hydrostatic constants. The exact active-set dispatcher
  (candidate priority, `pushShearCandidates`/`pushTensionCandidates`, previous-trial/committed caching gates,
  promotion/route handling, near-formal-apex routing) is a faithful structural mirror of JS:1779-2059. Cap and
  cone HS gradient derivatives spot-checked against analytic differentiation are correct. No A-class bug found.
- **Recommendation:** None. Recorded as positive evidence for the parity claim.

### [DEF-CPP-MATERIALS-A-02] info · minor stale JS line-number references in C++ comments
- **Location:** `src/wasm/deformation/material_mc_exact.hpp:85` (`clampMcAngle (line 1880)` — actual JS line is 2061), and the `resolveEigenSubspaceTolerance` field-name note below
- **Category:** A — Implementation (documentation drift, non-functional)
- **Confidence:** confirmed
- **Analysis:** Two cosmetic drifts: (1) the `clamp_mc_angle_deg` comment cites JS line 1880 for `clampMcAngle`,
  but it is actually at JS:2061 (the clamp `max(min(x,89.5),0)` is functionally identical to the C++
  `std::clamp(x,0,89.5)`, modulo NaN handling — JS coerces `Number(x)||0`, C++ assumes finite input). (2) The
  C++ `resolve_eigen_subspace_tolerance` reads `mp.eigSubspaceTolerance` while the JS reads
  `materialParameters.eigenSubspaceTolerance` — these are corresponding fields in their respective parameter
  structs, equivalent behavior, but the names differ (`eig`- vs `eigen`-), which can confuse a parity reviewer.
- **Recommendation:** None functional. Optionally refresh the `// JS:###` comment to 2061 and align the
  tolerance field name spelling, to keep the mechanical cross-check the header advertises actually mechanical.

### [DEF-CPP-MATERIALS-A-03] info · HS consistent-tangent direction-locking matches the audited (superseding) decision, not the earlier log line
- **Location:** `src/wasm/deformation/material_hs.hpp:3798-3816`; `material_hs_tangent.hpp:697-974`
- **Category:** A — Implementation (positive verification of a potential trap)
- **Confidence:** confirmed
- **Analysis:** The SH tangent path decomposes the **trial** stress for projectors (`principalT.P1/P2/P3`) and
  extracts converged principal **values** by projecting `res.stressUpdated` onto those trial projectors
  (`compression_component_in_projector`). An early implementation-log entry (2026-05-20) says "the SH tangent
  context now uses the converged-stress eigenbasis," which would contradict this. However, the later
  "HS Cap/Corner Locked-Projector Tangent Audit" entry supersedes it: it proves the shipped HS return map is
  **direction-locked to the trial eigenbasis** (stress reconstructed with `principalT` projectors), so the
  consistent algorithmic tangent must differentiate the trial-basis rotation (`apply_locked_projector_strain_correction`,
  `B = I − Δλ·dm_trial·D_e`). The code matches that final decision and the SH-2/3/4 FD/residual oracles pass.
  This is correct; I flag it only so a future reader does not "fix" the code back to the converged-basis line.
- **Recommendation:** Optionally annotate `update_plane_strain`'s SH block with a pointer to the
  Locked-Projector Audit so the trial-basis decomposition is not mistaken for a bug.

## Notes / limitations of this audit pass
- I verified the MC exact path against the JS reference exhaustively for the math/parity dimensions, and the HS
  cone/cap/corner constitutive math and SH tangents against standard HS theory and the documented FD/residual
  oracle results. I did **not** independently re-run the WASM build or the verifier scripts (no compile/execute
  in this pass) — the positive parity/FD claims rely on reading the code and the implementation log's recorded
  oracle errors (e.g. SH-2 directFdRelErr 1.8e-9, MC-exact tangent invariant worst 7.1e-7). A second pass that
  actually compiles `scripts/scratch/*.cpp` and diffs WASM-vs-JS on a fuzzed stress sweep (including degenerate
  axisymmetric/committed-projector states) would be the right way to confirm C-01 and C-03 empirically.
- I read `material_hs.hpp` selectively in the most error-prone regions (helpers, cone/cap yields & gradients,
  cap return, K0/M_cap/H_cap calibration, plane-strain wrapper, SH tangent dispatch) and the corner/tension
  return-map *interfaces*, but did not line-by-line verify the full 380-line `return_corner_coupled_active_set`
  2×2 Newton Jacobian assembly (lines ~1201-1580) or `update_substepped_no_tangent` substep ladder; the
  documented Jacobian signs (J[i][j]) are standard and the SH-4 corner oracle passes, but a dedicated second
  pass on the corner Newton Jacobian and the FD-tangent fallback (`fd_algorithmic_tangent`) is advisable.
- `material_hs_tangent.hpp` derivative helpers were spot-checked analytically (cone df/dq, df/dq_a, dq_f/dσ3,
  Rowe chain, cap Hessian 2/9 term); I did not re-derive every σ3-implicit chain term symbolically — the SH-1
  verifier reports ~1e-11..1e-14 relative FD agreement, which I relied on.
- No memory/performance (B) issues were found in these header-only constitutive routines: all allocation is
  stack/fixed-size (`std::array`), the only `std::vector` use is the small dense active-set solves (≤4×4 / ≤6×6),
  and there are no listeners/buffers/heap retained across calls. The dense `Xi` inversion is acknowledged in the
  log as un-optimized-by-design (no Woodbury) but is bounded 6×6 — not a hot-loop concern at the material-point
  level relative to the global solve.
