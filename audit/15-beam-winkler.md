# Audit — Beam/slab on elastic foundation (Winkler/Pasternak)
**Subsystem key:** beam-winkler
**Files reviewed:** /Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/stage6-engineering.js (lines 1117-1613 in full, plus supporting helpers eoedAtStress/buildSublayerProfile/ulsEq610/slsLoadCombination/reinforcementDesign), /Users/mathiasdepelsmaeker/Projects/madep-cp/src/routes/docs/engineering/beam/+page.svelte (full), /Users/mathiasdepelsmaeker/Projects/madep-cp/src/wasm/deformation/beam.hpp (full), /Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/legacy-controller.js (beam config defaults, call site, chart consumers)

**Finding counts:** critical=0 high=2 medium=4 low=6 info=3  |  A=5 B=2 C=6 D=2  |  total=15

## Overview
The actual Winkler/Pasternak beam-on-elastic-foundation solver lives entirely in JavaScript in `stage6-engineering.js` (`computeSubgradeReaction`, `beamElementStiffness`, `pasternakElementStiffness`, `solveBeamOnElasticFoundation`, `analyzeBeamAndReinforcement`). The core FEM is **correct**: the Euler-Bernoulli 4×4 Hermitian bending matrix, the consistent (mass-form) Winkler matrix, the Pasternak `∫ N′ᵀN′` shear matrix with 3-point Gauss, the consistent load vectors, the Vesić k_s conversion, the oedometer→Young conversion, the moment/shear recovery (`M=−EI w″`, `V=−EI w‴`), and the EC2 reinforcement handoff are all dimensionally consistent and match standard theory. The dominant problems are **documentation-vs-code drift**: the in-app doc (`+page.svelte`) describes several features that are not implemented (selectable fixed/hinged boundary conditions, λ-adaptive meshing, a default Pasternak η = 1/3) and contains one wrong worked-example arithmetic figure and one wrong unit in a symbol table. There are also a few genuine but low-severity code issues (uncaught singular-matrix throw on zero-soil input, full-element smearing of partial patch loads, dense O(n³) main-thread solve). Note the paired `beam.hpp` is a Timoshenko **retaining-wall** beam element with no foundation term — it is a different subsystem from the Winkler slab beam this doc describes.

## Findings

### [BEAM-WINKLER-A-01] medium · Solver throws an uncaught "singular matrix" error when there is no soil stiffness (k_s = 0, g_p = 0)
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1206-1207` (throw), `1376-1397` (free-free assembly, no BCs), `1164-1167` (`ks=0` when `EsAvg=0`); call site `src/lib/cpt-app/legacy-controller.js:16807` (no try/catch in `renderStage6`, lines 16774-16829)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** `solveBeamOnElasticFoundation` assembles only `K_beam + K_Winkler + K_Pasternak` and never applies any essential boundary condition — the beam is free-free. This is well-posed *only* because the Winkler springs make K positive-definite. If `EsAvg = 0` (no sublayer falls inside the influence window `[Df, Df+zInfluence]`, or all `Eoed_ref = 0`), then `ks = 0` (line 1164-1167). In Winkler mode `gp = 0`, so `kLine = 0` and `gpLine = 0`: K reduces to the bending-only matrix, which is rank-deficient (rigid-body translation + rotation). `solveLinearSystem` hits `pivotAbs < 1e-12` and `throw new Error('Beam stiffness matrix is singular.')`. `renderStage6` (legacy-controller.js:16774) calls `analyzeBeamAndReinforcement` with no surrounding try/catch, so the exception propagates and breaks the entire Stage-6 render rather than producing a graceful "insufficient soil data" message. This is reachable with legitimate inputs (e.g. a deep founding level with thin soil model, or a CPT whose interpreted layers have zero reference stiffness).
- **Recommendation:** Guard the zero-stiffness case before solving (return a diagnostic result when `kLine ≤ 0 && gpLine ≤ 0`), and/or wrap the Stage-6 beam analysis call in try/catch so a singular system surfaces as a user-facing note instead of an unhandled throw.

### [BEAM-WINKLER-A-02] medium · Partial patch load is smeared as a reduced-intensity full-element load (wrong nodal moment distribution at patch edges)
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1386-1391`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** For an element only partially covered by a uniform/patch load:
  ```js
  const overlap = Math.max(0, Math.min(x2, loadMeta.xEnd) - Math.max(x1, loadMeta.xStart));
  if (overlap > 0) {
    const qEff = loadMeta.value * (overlap / le);
    addVectorBlock(F, dofs, distributedLoadVector(qEff, le));
  }
  ```
  `distributedLoadVector(q, le)` returns the consistent vector for a load over the **whole** element `[x1,x2]`: `[qL/2, qL²/12, qL/2, −qL²/12]`. By scaling intensity to `qEff = q·(overlap/le)` and applying it over the full element, the *total* force is preserved (`qEff·le = q·overlap`), but the load is incorrectly placed at the element centroid and split evenly to both nodes, rather than integrated only over the loaded sub-interval `[max(x1,xStart), min(x2,xEnd)]`. The consistent end-moment terms (`±qL²/12`) and the unequal node split are therefore wrong whenever a patch edge falls mid-element. The error is local to the two edge elements and vanishes as the mesh refines (default 120 elements makes it small), but it is a genuine inconsistency in the load assembly.
- **Recommendation:** When `overlap < le`, integrate the Hermite shape functions over the actual loaded sub-interval (closed-form or sub-element Gauss) to build the consistent edge-element load vector, or split the mesh so element boundaries land on the patch edges (`xStart`, `xEnd`).

### [BEAM-WINKLER-A-03] low · `nuAvg` returned from `averageSoilStiffness` is discarded; reported `nuAvg` is the scalar mode value
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1156` (destructure) and `1157, 1178` (overwrite with scalar `nu`)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** Line 1156 destructures `{ EsAvg, nuAvg }` from `averageSoilStiffness`, but line 1157 recomputes a scalar `nu` from `config.EsMode` and line 1178 returns `nuAvg: nu`. The thickness-weighted `nuAvg` computed inside `averageSoilStiffness` (lines 1122-1137) is never used. In `young_drained` mode the per-sublayer ν is hard-coded to 0.30 anyway, so the weighted average equals the scalar and there is no numerical impact today — but the weighted-average machinery is dead and the field name is misleading.
- **Recommendation:** Either use the weighted `nuAvg` in the k_s / G_s conversions, or remove the unused weighted-ν accumulation (see DEAD-CODE D-02) and stop destructuring it.

### [BEAM-WINKLER-A-04] low · Shear/moment recovery at shared nodes only samples the left element (right-element node value never evaluated)
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1404-1435` (recovery loop, esp. `if (e > 0 && s === 0) continue;` at 1410)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** For cubic-Hermite elements, `M = −EI w″` is linear within an element and **discontinuous** across element boundaries (the curvature jumps), and `V = −EI w‴` is constant per element and also discontinuous. The recovery loop samples `xi = 0, 1/3, 2/3, 1`, but skips `s===0` for every element after the first to avoid duplicate x-positions. The consequence is that at each interior node only the *left* element's `xi=1` value is recorded; the *right* element's `xi=0` value is never evaluated. The global max-moment / max-deflection search (`maxMoment`, used directly as `MEd` for reinforcement) can therefore under-capture a peak that is larger on the right side of a node. For smooth, well-refined solutions the two sides nearly coincide, so the practical error is small, but the ULS moment that drives steel area is taken from this search.
- **Recommendation:** Sample both `xi=0` (right element) and `xi=1` (left element) at shared nodes when searching for the moment/shear extrema, or take the max of left/right limits at each node explicitly.

### [BEAM-WINKLER-A-05] info · Patch-load `xEnd` clamp can silently move the patch when `xStart` ≈ L
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1336-1341`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** `xEnd = clamp(positive(config.xEnd, L*0.75), xStart + 0.05, L)`. If a user sets `xStart` near `L`, the lower clamp `xStart + 0.05` can exceed `L`, in which case `clamp` returns `L` (upper bound), producing a degenerate `xEnd ≤ xStart` interval rather than a validation error. Practically the patch then has near-zero overlap and contributes ~no load — a silent no-op rather than a flagged input error. Low impact (engineer would notice the empty diagram), noted for completeness.
- **Recommendation:** Validate `xStart < L − 0.05` and surface a note when the patch interval collapses.

### [BEAM-WINKLER-B-01] medium · Dense O(n³) Gaussian elimination on the main thread; system is block-tridiagonal (sparse) and solved twice per render
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1188-1227` (`zeroMatrix`, `solveLinearSystem`), `1376` (`K = zeroMatrix(dof)`), `1522-1523` (two solves: SLS + ULS)
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** The beam K is stored as a full dense `dof × dof` array (`dof = 2(nElem+1)`) and solved with full partial-pivot Gaussian elimination — O(n³) time, O(n²) memory, plus a full dense copy `A = matrix.map(row=>row.slice())` (line 1194). The element coupling is only nearest-neighbour, so K is block-tridiagonal with bandwidth 3; a banded/Thomas solver would be O(n). For the default `nElem=120` (`dof=242`) this is ~14M flops × 2 (SLS+ULS) — acceptable, but it runs synchronously on the main thread and scales cubically if a user raises `nElements`. `analyzeBeamAndReinforcement` is also re-run on every Stage-6 render (`renderStage6`), with no memoization keyed on the beam config.
- **Recommendation:** Use a banded/tridiagonal-block factorization (the bending+Winkler+Pasternak stencil is bandwidth 3), reuse a single factorization for both load vectors (same K), and consider memoizing the analysis on a hash of the beam config.

### [BEAM-WINKLER-B-02] low · `pasternakElementStiffness` rebuilds Gauss-point arrays per element and allocates per call
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1261-1283` (called once per `elementGp`, line 1379) — and `distributedLoadVector`/`pointLoadVector` allocate fresh arrays per element (1285-1295, 1386-1394)
- **Category:** B — Performance
- **Confidence:** likely
- **Analysis:** `pasternakElementStiffness` allocates a fresh `gaussPoints` array literal and a `zeroMatrix(4)` on each invocation, and `solveBeamOnElasticFoundation` allocates `dofs`, `ue`, `d2`, `d3`, and shape-function arrays inside the per-element / per-sample loops (lines 1380-1435). Because all elements share `le`, `elementK` and `elementGp` are already (correctly) computed once outside the loop, so the matrix assembly itself is fine; the remaining per-iteration allocations are in the load assembly and recovery sampling. Minor for default sizes; only relevant at very high `nElements`.
- **Recommendation:** Hoist constant arrays (`gaussPoints`, shape-derivative coefficients) to module scope; reuse scratch buffers in the recovery loop. Low priority given typical mesh sizes.

### [BEAM-WINKLER-C-01] high · Doc claims selectable fixed-end and hinged boundary conditions; code only ever solves the free-free case
- **Location:** Doc `src/routes/docs/engineering/beam/+page.svelte:370-374, 386` (§7 "fixed-end walls carry w = w′ = 0; hinged ends fix w and M"); code `src/lib/cpt-app/stage6-engineering.js:1376-1397` (no BC application anywhere)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** "Free-end strip footings carry M = V = 0 at the ends; fixed-end walls carry w = w′ = 0; hinged ends fix w and M," and the equation block adds an "End-moment correction (finite strip): superpose fictitious end moments enforcing M = 0 (free) or w′ = 0 (fixed)." (2) **Code does:** assembles `K = K_beam + K_Winkler + K_Pasternak` and calls `solveLinearSystem(K, F)` directly — there is no row/column modification, penalty, or DOF restraint anywhere (grep for fixed/hinged/boundary/penalty/restrain in the solver returns nothing). Every solve is the natural **free-free** beam-on-foundation (M=V=0 at both ends). There is no UI control or config field for end conditions. (3) **Which is correct:** the code's free-free solve is itself a valid, well-posed model (Winkler springs remove rigid-body modes), and is the right default for a strip footing. The discrepancy is that the doc over-promises capabilities (fixed/hinged ends, end-moment correction) that do not exist. For a *retaining-wall* interpretation the missing fixed/clamped end is a real modelling gap, not just a doc issue. (4) **Fix direction:** fix the doc to state that only the free-free strip is solved, OR implement the documented BC options. The doc should not list BCs the solver cannot apply.
- **Recommendation:** Correct §7 to describe the free-free model actually solved, or add the BC machinery the doc advertises.

### [BEAM-WINKLER-C-02] high · Doc states default Pasternak η = 1/3; code default is η = 1.0 (3× the documented shear-layer stiffness)
- **Location:** Doc `src/routes/docs/engineering/beam/+page.svelte:420` ("default 1/3 for a linearly decaying shear profile"); code `src/lib/cpt-app/stage6-engineering.js:1159` (`positive(config.gpEta, 1.0)`) and default config `src/lib/cpt-app/legacy-controller.js:4159` (`gpEta:1.00`), normalization `legacy-controller.js:4566`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** η "default 1/3 for a linearly decaying shear profile." (2) **Code does:** the inferred Pasternak modulus is `gpInferred = gpEta · GsAvg · zInfluence` with `gpEta` defaulting to **1.0** (both the runtime fallback and the persisted app default). (3) **Which is correct:** η is an explicit calibration factor; neither value is "wrong" physically, but `Gp` scales **linearly** with η, so the code default produces **three times** the shear-layer stiffness the doc implies as the baseline. Since the default `foundationModel` is `'pasternak'` (legacy-controller.js:4150), this directly changes the moment/deflection envelope the engineer sees out of the box — a stiffer shear layer smooths and reduces the moment field more than documented. (4) **Fix direction:** make doc and code agree. Either change the code default to 1/3 (matching the stated "linearly decaying shear profile" rationale) or change the doc to state the actual default of 1.0 and justify it.
- **Recommendation:** Reconcile the default. Given the doc gives a physical rationale for 1/3, decide which is intended and align the other.

### [BEAM-WINKLER-C-03] medium · Doc claims λ-adaptive meshing `min(λ/10, L/50)`; code uses a fixed user element count (default 120)
- **Location:** Doc `src/routes/docs/engineering/beam/+page.svelte:471` ("Element size defaults to min(λ/10, L/50)…"); code `src/lib/cpt-app/stage6-engineering.js:1521` (`nElements = max(round(config.nElements||120), 40)`), `1372-1375` (`le = length / nElem`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** the mesh adapts so element size = `min(λ/10, L/50)`, guaranteeing ≥10 elements per Hetényi decay length. (2) **Code does:** uses a fixed element count from config (default 120, min 40), with uniform `le = L/nElem`; λ is computed (line 1515) only for the short/intermediate/long classification and never feeds the mesh. There is no per-element refinement near loads. (3) **Which is correct:** the doc's adaptivity is the more defensible numerical strategy (it guarantees resolution of the characteristic length); the code's fixed mesh can under-resolve when L ≫ λ (response localized in a few elements) unless the user raises `nElements`. (4) **Fix direction:** either implement the documented λ-aware default element count (`nElem ≥ ceil(L / min(λ/10, L/50))`) or correct the doc to describe the fixed-count mesh and its resolution caveats.
- **Recommendation:** Implement λ-aware default meshing (cheap given λ is already computed) or update §10 to match the fixed mesh.

### [BEAM-WINKLER-C-04] low · Doc symbol table gives G_p units as kN/m²; the governing ODE and runtime label require kN/m
- **Location:** Doc `src/routes/docs/engineering/beam/+page.svelte:416` (G_p "[kN/m²]") vs doc ODE `406-409` and runtime label `src/lib/cpt-app/stage6-engineering.js:1576` / `legacy-controller.js:14360` ("kN/m")
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc symbol table says:** "G_p … shear-layer stiffness per unit area [kN/m²]." (2) **Code/ODE imply:** In `EI w⁗ − b G_p w″ + b k_s w = q`, the term `b·G_p·w″` must have the units of `q` (kN/m): `[b][G_p][w″] = m · [G_p] · m⁻¹ = [G_p]`, so `[G_p] = kN/m`. Equivalently `G_p = η·G_s·H_p` with `G_s` in kPa (kN/m²) and `H_p` in m gives kN/m. The runtime correctly labels and reports `G_p` in kN/m (note text line 1576, table line 14360). (3) **Which is correct:** the **code/ODE are correct (kN/m)**; the doc symbol table's "[kN/m²]" is dimensionally wrong and contradicts the same doc's own `G_p = η G_s,avg H_p` definition. (4) **Fix direction:** fix the doc symbol unit to kN/m.
- **Recommendation:** Change the §8 symbol table entry for G_p from [kN/m²] to [kN/m].

### [BEAM-WINKLER-C-05] low · Doc worked example uses M₂/M₁ = (0.5/0.3)^1.63 = 2.15, but that ratio is 2.30; 2.15 corresponds to exponent 1.5
- **Location:** Doc `src/routes/docs/engineering/beam/+page.svelte:350-356` (§6 worked illustration)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** The example states the patch-UDL exponent α = 1.63 (consistent with the table at line 332 and `λ ∝ h^13/16`), then writes "M₂/M₁ = (0.5/0.3)^1.63 = 2.15, so M₂ ≈ 215 kN·m." But `(5/3)^1.63 = 2.30` (verified numerically), not 2.15; the value 2.15 is `(5/3)^1.5`. Carrying the *correct* ratio through: M₂ ≈ 230 kN·m, μ₂ ≈ 0.053, A_s,2 ≈ 1172 mm²/m — versus the doc's μ₂ = 0.050, A_s,2 ≈ 1094. (μ₁ = 0.072 and A_s,1 ≈ 904 in the doc check out exactly.) The qualitative conclusion ("moment growth out-runs the lever-arm gain") is unaffected, but the headline numbers are internally inconsistent (exponent 1.63 in the text, 1.5 in the arithmetic). This is doc-only (the code uses FEM, not these closed forms). (3) The **code is unaffected**; the **doc arithmetic is wrong**. (4) Fix the doc number.
- **Recommendation:** Recompute the worked example with the stated exponent 1.63 (M₂ ≈ 230 kN·m, A_s,2 ≈ 1172 mm²/m) or correct the exponent used in the arithmetic.

### [BEAM-WINKLER-C-06] info · In-app doc describes the JS Winkler FEM, but the audit-paired `beam.hpp` is an unrelated Timoshenko retaining-wall element (no foundation term)
- **Location:** `src/wasm/deformation/beam.hpp:1-9` (header: "Two-node Timoshenko beam element for embedded retaining walls") vs doc `+page.svelte:457-468` (cubic-Hermite Euler-Bernoulli beam on Winkler/Pasternak)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** The beam-on-elastic-foundation doc (§10) describes "two-node cubic-Hermite beam elements (4 DOF)" with a "consistent line spring" and Pasternak `∫ N′ᵢN′ⱼ`. That is precisely the JS implementation in `stage6-engineering.js`. `beam.hpp` is a **different** element: a 6-DOF (per element) Timoshenko beam with selective reduced shear integration, used for embedded **retaining walls**, and it has **no Winkler/Pasternak foundation term** at all. There is no contradiction to fix in either file — but the audit's file pairing implies `beam.hpp` implements the Winkler doc, which it does not. Flagged so the coordination with def-cpp-core (wall beams) does not get conflated with this Winkler-slab subsystem.
- **Recommendation:** No code change. Note in cross-subsystem coordination that `beam.hpp` ≠ the Winkler slab beam; the Winkler/Pasternak math is JS-only.

### [BEAM-WINKLER-D-01] low · `local_end_forces` in `beam.hpp` appears unused by the Winkler subsystem (verify ownership with def-cpp-core)
- **Location:** `src/wasm/deformation/beam.hpp:145-170`
- **Category:** D — Dead Code
- **Confidence:** uncertain
- **Analysis:** `local_end_forces` computes element end forces in local coordinates. It is part of the retaining-wall (Timoshenko) beam module, not the Winkler subsystem, so its usage must be judged by def-cpp-core. Flagging only because it sits in the audit-paired file; I did not trace its callers in the C++/WASM deformation pipeline. Do not act on this without confirming with the def-cpp-core pass.
- **Recommendation:** Defer to def-cpp-core; confirm whether `local_end_forces` (and the `U_reference` paths) are referenced before treating as dead.

### [BEAM-WINKLER-D-02] low · Weighted `nuAvg` accumulation in `averageSoilStiffness` is computed but never consumed
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1122, 1132, 1136-1137` (accumulate + return `nuAvg`); consumer `1156, 1178` discards it
- **Category:** D — Dead Code
- **Confidence:** confirmed
- **Analysis:** `averageSoilStiffness` accumulates `nuSum` and returns `nuAvg = nuSum/weight`, but the only caller (`computeSubgradeReaction`) destructures `nuAvg` (line 1156) and then overwrites it with the scalar `nu` derived from `config.EsMode` (line 1157), returning `nuAvg: nu`. The weighted-ν path is dead (and in `young_drained` mode the per-sublayer ν is the constant 0.30 anyway, so the average is trivially equal). See also A-03.
- **Recommendation:** Remove the unused `nuSum`/`nuAvg` accumulation, or wire the weighted average into the k_s/G_s conversions if a depth-varying ν is intended.

## Notes / limitations of this audit pass
- The Hetényi A/B/C/D closed forms (doc §5) and the patch closed forms (doc §7) are **documentation-only**; the code solves the beam by FEM and never evaluates them. I spot-checked their asymptotics (interior deflection → q/(b k_s), interior moment → 0, point-load `w_max = Pβ/2bk_s`, `M_max = P/4β`) and they are consistent with Hetényi; I did not exhaustively re-derive the finite-strip end-moment corrections, which are described but not implemented.
- The EC2 reinforcement formulas downstream of the beam moment (`mu`, `omega = 1−√(1−2μ)`, `As`, `AsMin = max(0.26 fctm/fyk, 0.0013)·bw·d`, `fctm = 0.30 fck^{2/3}`) were checked for the moment→steel handoff and are dimensionally and standards-consistent for ≤C50; a full EC2 reinforcement audit (cover, exposure class, ductility limits) belongs to the reinforcement subsystem and was not exhaustively re-verified here.
- I confirmed the Euler-Bernoulli 4×4 matrix, the consistent Winkler matrix (`k·L/420`-form), the Pasternak `∫N′ᵀN′` matrix (3-point Gauss, exact for the quartic integrand), the consistent load vectors, the Vesić k_s twelfth-root coupling, and the oedometer→Young conversion all match standard theory with consistent units (kPa / m / kN throughout). No critical numerical errors were found in the FEM core.
- `beam.hpp` (Timoshenko wall beam) was read in full but is a different subsystem; its correctness (shear locking, transformation, internal-force recovery) should be judged by the def-cpp-core pass. I did not trace its WASM bindings or callers.
- I did not run the app; findings are from static reading and hand/`python3` numerical checks of the documented formulas and the doc worked example.
