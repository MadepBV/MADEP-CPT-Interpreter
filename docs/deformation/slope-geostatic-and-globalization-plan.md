# Slope Geostatic Initialization & Nonlinear Globalization Plan

This is the detailed architectural plan for the slope-specific failure mode the
user diagnosed in the read-only review:

> The current initial stress predictor takes an elastic gravity stress field,
> replaces the normal stresses with a K0-style vertical/horizontal state, but
> keeps the elastic shear stress. On sloping ground that produces a
> mathematically awkward stress seed: near the surface σ′v and σ′h are almost
> zero while slope-equilibrium shear is still present. For Mohr–Coulomb with
> low cohesion and zero/low tension strength, many near-surface Gauss points
> start on or outside yield. The plastic equilibration phase then has to
> repair a globally inconsistent state, which T6 makes more visible.

The plan below is **independent of GPU/CPU choice**. The hard part —
plastic return mapping, active-set transitions, line search, cutbacks,
unsymmetric Krylov — is shared across backends. We do not solve this with
acceleration; we solve it with better algorithms.

The numbering matches the user's six recommendations (replace predictor,
staged geostatic init, better globalization tangent, fail-fast on small
steps, depth-band diagnostics, stronger preconditioning).

---

## 1. Replace the K0-normal + elastic-shear predictor

### Current behaviour

Today the geostatic seed is built in two stages:

1. **Elastic gravity solve** in `buildGeostaticInitialization()`
   — solves `K_e · u = f_g` with the elastic operator, recovers a full
   elastic stress field everywhere.
2. **K0-controlled normal-stress overwrite** in
   `buildK0ControlledInitialEffectiveStress6()`:
   keeps the elastic shear stress (`τ_xy`, `τ_yz`, `τ_xz`) but rewrites
   `σ′_v` from gravity overburden and `σ′_h = K0 · σ′_v`.

On flat ground this is fine: the elastic shear is approximately zero so
mixing it with K0 normal stresses gives an admissible state. On sloped
ground the elastic shear is **not** zero — gravity creates a real shear
component to balance the slope — and the resulting hybrid is yield-active
near the free surface where `σ′` is tiny.

The damage shows up as:

- "Initial exact MC audit flagged many inadmissible predictor elements"
- The plastic equilibration phase doing dozens of Newton steps just to
  "repair" the predictor before service loading even starts.
- T6 amplifies this because mid-edge nodes give more near-surface Gauss
  points, each of which sees the same low-`σ′` / high-`τ` problem.

### Target behaviour

Build an **admissible local predictor** for the initial effective stress field,
by depth below terrain, with a Mohr–Coulomb + tension feasibility check at
every Gauss point. This predictor is not claimed to be globally equilibrated;
the staged plastic geostatic phase in §2 is responsible for restoring global
force balance.

```
For each Gauss point GP:
  σ_v,total(GP) = verticalOverburdenStressAt(model, GP.x, GP.y)
  u0(GP)        = sampleInitialPorePressure(model, GP.x, GP.y, options)
  σ′_v(GP)      = max(σ_v,total - u0, 0)
  σ′_h(GP)      = K0(GP) · σ′_v(GP)
  τ_target(GP)  = chooseSlopeShearTarget(GP, elastic_geostatic_stress, terrain_angle)
  τ(GP)         = clipShearToAdmissibleEnvelope(σ′_v, σ′_h, τ_target, c′, φ′, σ_t)
  σ_eff_seed(GP) = build_3D_tensor(σ′_v, σ′_h, τ)
  assert isInsideMohrCoulomb(σ_eff_seed, c′, φ′, σ_t)
```

`chooseSlopeShearTarget` is deliberately a **target**, not a guarantee of
equilibrium. It can use the recovered elastic gravity shear as the preferred
sign/magnitude, optionally limited by an infinite-slope estimate for sanity.
The important step is the clipping/projection helper: it keeps only the amount
of shear that still leaves the seed inside the exact MC + tension envelope.

```
τ_target = recovered elastic geostatic τxy, bounded by slope-sign heuristics
τ_max_admissible = largest |τ| found by bracketing/bisection such that
                   F_shear(σ′_v, σ′_h, τ) ≤ tol
                   AND F_tension(σ′_v, σ′_h, τ) ≤ tol
τ_seed = sign(τ_target) · min(|τ_target|, |τ_max_admissible|)
```

If `|τ_target| > |τ_max_admissible|`, we record a shear-deficit diagnostic
(`τ_target - τ_seed`) by depth band. The seed itself stays admissible; the
global gravity deficit is then resolved by the staged plastic continuation in
§2, not by asking the predictor to carry an impossible free-surface shear.

### Files affected

- **`src/lib/cpt-app/deformation/solver.js`** —
  - Add `buildAdmissibleSlopeInitialEffectiveStress6()` and route
    `recoverInitialFieldFromGeostaticSolution()` through it when
    `useAdmissibleSlopeSeed !== false`.
  - Keep `buildK0ControlledInitialEffectiveStress6()` as the legacy fallback
    for flat-K0 and explicit compatibility modes.
  - Add `chooseSlopeShearTarget(...)`, `clipShearToAdmissibleEnvelope(...)`,
    and `terrainSlopeAtPoint(model, x) → α`. Cache terrain-segment lookup per
    x-bin or segment index; do not re-walk the terrain polyline for every
    Gauss-point trial.
- **`src/lib/cpt-app/deformation/material-models.js`** —
  - Export or wrap the existing exact MC/tension feasibility evaluator so
    the seed helper can test candidate stresses with the same convention as
    the return map.
  - Add `largestAdmissibleShear(...)` as a robust bracketing/bisection
    helper first. A closed-form quadratic version is optional later, but it
    must handle principal-order switches and tension branches exactly before
    replacing the bracketed oracle.

### Validation

- New verification case **41p**: feed a 30°-slope mesh, run the new
  seed, assert that *every* Gauss point passes the exact MC + tension
  audit (`F < -tol`).
- Verification case **41q**: same mesh with `c′ = 1 kPa, φ′ = 30°` —
  baseline expects 0 inadmissible elements after the predictor.
- Regression case **1fb** (existing slope predictor case) should now
  pass *without* needing the plastic correction to repair the
  predictor.

### Estimated complexity

- ~150 lines new code in `solver.js` + ~80 lines in the MC plugin.
- 2 new verification cases.
- Risk: near-tension states are branch-sensitive. Use the existing exact
  MC/tension evaluator and tolerances first; only introduce analytic
  shortcuts after parity tests prove they make identical admissibility
  decisions.
- Estimated effort: **2-3 dev-days**.

---

## 2. Staged geostatic correction with controlled plastic updates

### Current behaviour

`solveInitialPlasticEquilibrium()` currently builds a predictor reference
state, computes the internal force carried by that predictor, and then uses a
load-factor continuation from that predictor internal-force state to the full
gravity force. This is a correction homotopy, not a fresh gravity ramp from
zero. When the predictor is bad (§1), the force correction is large and the
load-step adapter cuts back aggressively, sometimes never reaching the full
correction.

### Target behaviour

Replace the all-at-once correction with a **staged geostatic correction**
modelled on the spirit of commercial K0/staged-construction procedures. The
important invariant is that we must not double-count self-weight: if the seed
stress already represents full overburden, the stages must ramp the **missing
equilibrium correction**, not unload/reload the whole overburden.

1. **Stage A — Admissible full-overburden seed**: install the §1 predictor
   as the committed/reference material-point state. It carries the intended
   total/effective overburden locally, but it is only a local stress seed; it
   may not satisfy global FE equilibrium.
2. **Stage B — Plastic correction ramp**: compute
   `f_seed = internalForce(seed, u = 0)` and `f_gravity = gravity RHS`.
   Continue from `f_seed` to `f_gravity` in `N_g = 5..10` correction stages:
   `f_target(λ) = f_seed + λ · (f_gravity - f_seed)`,
   with `λ ∈ {1/N_g, 2/N_g, ..., 1}`. At each increment:
   - Solve the nonlinear correction for the current `f_target(λ)` with
     Newton/line search.
   - Commit stresses, plastic strains, and displacement correction on success.
   - Reset to `λ_committed` on failure and cut back the correction increment.
3. **Stage C — Effective-stress pore-pressure handling**: pore pressure is not
   a separate generic RHS in the current solver. It enters through sampled
   `u0`, effective stress, and saturated/dry bulk unit weight. If we later add
   pore-pressure staging, it must stage the effective-stress reference field
   and unit-weight/body-force choice consistently. Until that is designed,
   pore pressure should be included in the §1 seed exactly as today via
   `sampleInitialPorePressure(...)`, not ramped as `b_pwp`.
4. **Stage D — Service loading**: hand off to `solveServiceLoadPhase()`
   with the converged plastic geostatic state.

This follows the same broad idea as commercial geotechnical K0/staged
procedures, without claiming to reproduce a specific PLAXIS implementation.
The key invariants:

- Each stage produces a *converged* plastic equilibrium for a smaller
  problem. Failure in stage B at `λ = 0.4` is recoverable; the solver
  keeps the `λ = 0.3` committed state and reports the failure honestly.
- No Newton step ever has to bridge the entire predictor-to-real-state
  gap in one shot.

### API shape

```js
async function solveStagedGeostaticEquilibrium({
  mesh, model, materialPlugins, pwp, options, runControl
}) {
  const seed = buildAdmissibleSlopeInitialEffectiveStress(...);  // §1
  const seedInternalForce = assembleInternalForceAtSeed(seed, u = 0);
  const fullGravityForce = gravityCompressedRhs;
  const stages = planGeostaticCorrectionStages(model, options);
  // Returns: [
  //   { kind: 'geostatic-correction', lambda: 0.2 },
  //   { kind: 'geostatic-correction', lambda: 0.4 },
  //   ...,
  // ]
  let state = seed;
  for (const stage of stages) {
    const targetForce = interpolateVectorFields(seedInternalForce, fullGravityForce, stage.lambda);
    const result = await solveStageWithPlasticContinuation(state, targetForce, ...);
    if (!result.converged) {
      return classifyGeostaticFailure(state, stage, result);  // §4
    }
    state = result.state;
  }
  return { kind: 'staged-converged', state };
}
```

### Files affected

- **`src/lib/cpt-app/deformation/solver.js`** —
  - New `solveStagedGeostaticEquilibrium()` orchestrator.
  - New `planGeostaticCorrectionStages(model, options)` — picks number of
    correction increments based on terrain slope, seed shear deficit, and soil
    strength heterogeneity.
  - Extract `solveStageWithPlasticContinuation()` from the current
    `solveInitialPlasticEquilibrium()` body.
  - `analyzeDeformationModel()` switches its initial-phase call from
    the old `solveInitialPlasticEquilibrium` to the new staged variant
    behind an option flag (`useStagedGeostaticInit: true`, default
    `true`).
- **`src/lib/cpt-app/legacy-controller.js`** — expose a "Staged
  geostatic initialisation" toggle (default ON for slope cases) and a
  numeric "Geostatic correction stages" input.

### Validation

- New verification cases **1h**, **1h-slope**, **1h-cphi**: run on flat,
  10°-slope, 30°-slope geometries with `c′ = 0..5 kPa`. Assert each
  stage converges, final stress field is admissible.
- A/B against the old `solveInitialPlasticEquilibrium` on a benchmark
  set: time-to-convergence should drop dramatically on sloped meshes.

### Estimated complexity

- ~400 lines new code in `solver.js`.
- 5+ new verification cases.
- Risk: pore-pressure staging is easy to get wrong because the current solver
  treats pore pressure as effective-stress initialization plus bulk unit
  weight, not as a separate RHS. Keep pore-pressure activation out of v1 unless
  the effective-stress staging equations are written and tested explicitly.
- Estimated effort: **4-5 dev-days**.

---

## 3. Improve nonlinear globalization for initial gravity

### Current behaviour

With the current defaults, `solveInitialPlasticEquilibrium()` uses the
**plastic algorithmic tangent** for the initial-gravity phase. The existing
`initialGravityUseElasticGlobalizationTangent` option can route assembly
through the elastic tangent, but it is opt-in and coarse-grained. On hard
slopes the active set changes between consecutive Newton iterates (Gauss
points flip in/out of yield), so the plastic tangent itself is non-smooth, and
the linear solve (CG/GMRES/BiCGStab) chases a moving target. Step acceptance
fails, line search shrinks, total iterations explode.

The flag `initialGravityUseElasticGlobalizationTangent` exists in the code
already, but the plan should evolve it from a single boolean into an explicit
tangent schedule with clear switching criteria.

### Target behaviour

A two-phase Newton with explicit **globalization**:

```
Phase 1 (Elastic globalization):
  Use K_e (elastic tangent) as the linearization for the Newton step.
  Solve K_e · Δu = -r(u).
  Apply line search on the *plastic* residual r_pl(u).
  Iterate until the residual is inside a moderate basin, or until descent
  stalls despite line search.

Phase 2 (Plastic refinement):
  Switch to the algorithmic plastic tangent K_p.
  Solve K_p · Δu = -r(u).  (With GMRES/BiCGStab and the selected preconditioner.)
  Apply line search on r_pl.
  Continue until ‖r_pl‖ ≤ tol or max iterations.
```

The elastic tangent gives slower asymptotic convergence (linear, not
quadratic) but is **monotone-descent-safe**. It pulls the iterate into
the basin of attraction of the plastic state without active-set thrash.
The plastic tangent then takes over for fast final convergence.

A second adjustment: separate **residual-improvement criteria** from the
Armijo coefficient. Armijo `c1` multiplies the directional derivative; setting
`c1 = 0.1` is not the same as requiring a 10% residual reduction and may reject
good Newton directions. Keep `c1` in the usual `1e-4..1e-3` range, then add a
separate phase-1 rule such as:

```
accept if Armijo passes AND
  (residual_new <= 0.9 * residual_old OR lineSearchScale <= minScale)
```

If that rule fails repeatedly, switch to plastic refinement or classify the
stage as stuck (§4).

### Files affected

- **`src/lib/cpt-app/deformation/solver.js`** —
  - Generalise the existing `useElasticGlobalizationTangent` path into a
    `tangentMode: 'elastic' | 'plastic'` parameter. The code already has the
    essential hook inside `recoverIntegrationPointMaterialResponse()`; the
    change is primarily scheduling and reporting, not a new constitutive API.
  - `solveNonlinearPhase()` accepts a `tangentSchedule` (`['elastic',
    'plastic']` for staged, `['plastic']` for current behaviour).
  - `performArmijoLineSearch()` keeps a conventional Armijo coefficient and
    accepts an additional phase-1 residual-improvement/stagnation policy.
  - The current `initialGravityUseElasticGlobalizationTangent` flag becomes
    either a compatibility alias or the first entry in
    `initialGravityTangentSchedule`.
- **`src/lib/cpt-app/deformation/material-models.js`** — verify each plugin
  that can use the elastic globalization path exposes `elasticTangent6x6`.
  The exact MC plastic plugin already does; do not force unrelated plugins
  into this path unless their capability flags explicitly allow it.

### Validation

- New verification case **1i**: a sloped problem that the current
  solver requires 30+ Newton iterations to converge. Assert the new
  globalization converges in ≤ 12 (5 elastic + 7 plastic, typically).
- Existing verification cases must still pass with the same residuals.
- A/B benchmark: total Newton iterations on the slope test sweep
  should drop ≥ 40% on average.

### Estimated complexity

- ~200 lines new code, mostly in `solveNonlinearPhase`.
- 2 new verification cases.
- Risk: elastic-tangent Newton can over-shoot when soil is highly yielded.
  Mitigation is line search plus the separate residual-improvement/stagnation
  rule, not an unusually large Armijo coefficient.
- Estimated effort: **2-3 dev-days**.

---

## 4. Fail-fast classification on tiny load steps

### Current behaviour

The load-step adapter in `solveInitialPlasticEquilibrium()` /
`solveServiceLoadPhase()` cuts back on any non-converged Newton step
by `loadStepCutbackFactor` (default `0.5`). On hard slopes this can
cut back 10+ times to `λ ≈ 0.001`, then spend hundreds of Newton
iterations failing again. The user (correctly) called this "grinding."

The end-state is reported as "non-converged at 0.0% of correction" —
which is technically true but uninformative. From an engineering standpoint,
some of these cases are physically unstable, while others are numerically
stuck because the current seed/tangent/step policy is poor. The solver should
distinguish those outcomes instead of grinding.

### Target behaviour

Add an explicit **stuck detector** with a clear classification:

```
const MIN_LOAD_STEP = 1e-3;   // 0.1%
const MAX_REPEATED_BAND = 3;  // same shallow band for 3 cutbacks → classify

let prevPlasticBand = null;
let repeatedBandCount = 0;
while (loadStep > MIN_LOAD_STEP) {
  result = await trySolveStep(currentState, loadStep);
  if (result.converged) { commit(); continue; }
  const band = depthBandOf(result.activeYieldGaussPoints);
  if (sameBand(band, prevPlasticBand)) {
    repeatedBandCount += 1;
  } else {
    repeatedBandCount = 0;
    prevPlasticBand = band;
  }
  if (repeatedBandCount >= MAX_REPEATED_BAND) {
    return classifyStuckOrUnstable(state, band, result);
  }
  loadStep *= cutbackFactor;
}
return classifyStuck(state, loadStep);
```

`classifyStuckOrUnstable` produces a *positive* run record. It may classify
the phase as `numerically-stuck`, `shallow-free-surface-yielding`, or
`likely-unstable-self-weight`, depending on the depth distribution, spatial
continuity, shear reserve, and whether the committed state itself is close to
failure:

```js
{
  kind: 'geostatic-classification',
  outcomeClass: 'likely-unstable-self-weight',
  reason: 'same-shallow-band-yielding-after-3-cutbacks',
  depthBand: { z_min, z_max, count, fraction_yielded },
  recommendation: 'Increase cohesion, reduce slope angle, or check ' +
                  'the predictor for sub-surface yielding inputs.',
  partialSolution: lastCommittedState
}
```

The deformation panel shows this with the same UI affordance as a usable
partial result, but tagged with the classification rather than a
percent-converged number. Avoid labelling every tiny-step failure as
"unstable"; that word is reserved for cases with a persistent mechanism-like
plastic band or committed-state strength reserve near unity.

### Files affected

- **`src/lib/cpt-app/deformation/solver.js`** — new
  `classifyGeostaticNonconvergence()` and `depthBandOf()` (see §5).
- **`src/lib/cpt-app/legacy-controller.js`** — UI rendering for the new
  geostatic classification / failure outcome.
- **Run-record assembly in `src/lib/cpt-app/deformation/solver.js`** — extend
  `failureCode`, `failureOutcomeClass`, and the solver summary with the new
  geostatic classification. There is no separate run-record schema module in
  the current codebase.

### Validation

- Verification case **1z-unstable**: a deliberately unstable
  steep-slope-with-low-c′ case. Assert the solver returns the
  `likely-unstable-self-weight` classification within 5 cutbacks
  instead of grinding.
- UI snapshot test: the geostatic classification label renders correctly.

### Estimated complexity

- ~120 lines new code; mostly bookkeeping.
- 1 new verification case + 1 UI test.
- Risk: depth-band heuristic must not false-positive on
  legitimately-yielding deeper bands (foundation-load cases).
- Estimated effort: **1-2 dev-days**.

---

## 5. Diagnostics by depth below terrain

### Current behaviour

The solver already reports a seed-projection depth distribution when the K0
predictor is projected onto MC, but the later nonlinear phases still mostly
report generic strings ("Stage 2 plastic geostatic equilibration failed").
There is no per-step quantitative breakdown of *where* the plasticity /
tension is concentrating. From the warning alone, an engineer cannot tell
whether they have a free-surface predictor problem, a deep slope-stability
issue, or an applied-load issue.

### Target behaviour

Compute per-step:

```js
{
  depthBands: [
    { z_min: 0,    z_max: 1,    count: 540, plastic: 220, tension: 12, tau_over_strength: { p50: 0.96, p95: 1.05 } },
    { z_min: 1,    z_max: 3,    count: 1620, plastic: 80,  tension: 0,  tau_over_strength: { p50: 0.62, p95: 0.81 } },
    { z_min: 3,    z_max: 6,    count: 2240, plastic: 40,  tension: 0,  tau_over_strength: { p50: 0.45, p95: 0.61 } },
    { z_min: 6,    z_max: 12,   count: 1980, plastic: 8,   tension: 0,  tau_over_strength: { p50: 0.31, p95: 0.42 } }
  ]
}
```

`z` = vertical distance below the terrain ray cast straight up from
each Gauss point. Bands are auto-chosen from the terrain depth range
(roughly logarithmic spacing).

`tau_over_strength` is a diagnostic reserve ratio, not the constitutive yield
function. Compute it from the same effective-stress convention as the MC
evaluator, for example `‖τ‖ / max(c′ + σ′_n · tan φ′, tolerance)`, and pair it
with the exact MC/tension branch state. Values near or above 1 indicate the
band deserves attention; p50 / p95 quantiles are robust to single-Gauss-point
anomalies.

The UI exposes this as a small bar chart per phase (initial / service /
safety) — exactly the kind of diagnostic the user described.

### Files affected

- **`src/lib/cpt-app/deformation/diagnostics-depth-bands.js`** (new
  file). Provides `computeDepthBandReport(mesh, materialPoints, model,
  elementCaches, options)`.
- **`src/lib/cpt-app/deformation/solver.js`** — call the diagnostics
  builder on every rejected step, accepted step, and final displayed state.
  Keep the existing seed-projection depth warning, but back it with the same
  structured depth-band report.
- **`src/lib/cpt-app/legacy-controller.js`** — render the depth-band
  chart in the run summary panel.

### Validation

- Verification case **1y-diagnostics**: assert depth-band counts match
  hand-computed expected values for a reference small mesh.
- Visual smoke test in the browser.

### Estimated complexity

- ~200 lines new code (algorithm + chart rendering).
- 1 new verification case.
- Estimated effort: **1.5-2 dev-days**.

---

## 6. Stronger unsymmetric preconditioning

### Current behaviour

`solveGmresScaled()` currently does **row/column equilibration** and then runs
CPU restarted GMRES. It does **not** currently apply the 2×2 nodal
block-Jacobi preconditioner used by CG/BiCGStab and resident WebGPU GMRES
setup. For non-associated MC tangents that have strong off-diagonal coupling
(slip planes, dilation), row/column scaling alone is too weak: GMRES
iterations explode (~hundreds per Newton step), and wall-clock dominates.

### Target behaviour

Layered preconditioner stack, applied in order from cheap to
expensive. Each level can be enabled/disabled independently:

| Level | Preconditioner | When |
|-------|----------------|------|
| 1 | Row+column equilibration | Always (current behaviour) |
| 2 | 2×2 nodal block Jacobi   | Add to fallback GMRES; already used by CG/BiCGStab/resident setup |
| 3 | **Element-patch block** (additive Schwarz, overlap = 1) | Default ON for plastic phases |
| 4 | **Lightweight ILU(0) on the assembled scaled matrix** | Optional — heavy setup |

Level 3 (additive Schwarz) is the highest-impact addition and the
focus of this design.

### Additive Schwarz design

**Patches**: one patch per node, comprising the node and all elements
sharing it. For a typical T6 mesh that means each patch covers ~6-12
elements (= 12-24 DOFs after the 2×2 nodal expansion). Patches overlap
by 1 element (a "minimal-overlap" Schwarz).

**Setup**:

```js
function buildAdditiveSchwarzPreconditioner(mesh, rows, freeDofs) {
  const nodeToElements = buildNodeToElementMap(mesh);
  const patches = mesh.nodes.map((node, idx) => ({
    nodeIndex: idx,
    elementIndices: nodeToElements[idx],
    localDofs: collectFreeDofsOfPatch(idx, mesh, freeDofs)
    // localDofs is typically 12-24 entries
  }));
  // For each patch, extract the (localDofs × localDofs) submatrix from
  // the compressed rows, factor it (LU on CPU, dense; the matrices are tiny),
  // store the LU factors.
  for (const patch of patches) {
    patch.localK = extractSubmatrixFromCompressedRows(rows, patch.localDofs);
    patch.luFactors = denseLUFactorize(patch.localK);
  }
  return { patches };
}
```

**Apply**:

```js
function applySchwarzPreconditioner(precond, r, z) {
  z.fill(0);
  for (const patch of precond.patches) {
    const r_local = gatherDofs(r, patch.localDofs);
    const z_local = denseLUSolve(patch.luFactors, r_local);
    scatterAddDofs(z, z_local, patch.localDofs);
  }
  // (Optional) Damping factor: z := ω · z (ω ≈ 1/2 for additive Schwarz
  // to ensure SPD of the preconditioner when used inside CG; not
  // required for GMRES/BiCGStab but improves convergence rate).
}
```

**Cost analysis** for a T6 slope mesh, 5000 free DOFs, ~2500 nodes:

- Setup: roughly thousands of small dense LU factorizations, done once per
  nonlinear assembly. Exact timings must be measured; expect the setup to be
  visible on small meshes.
- Apply: thousands of small dense triangular solves per Krylov iteration.
  This is not free. The preconditioner is justified only if it reduces Krylov
  iterations enough to offset the apply cost.
- Gate behind `schwarzMinFreeDofs` and benchmark before making it default.

**GPU port** (deferred to the GPU roadmap): each patch is a small dense
linear system; a GPU version would need one workgroup per patch and LU factors
stored in GPU buffers. Until that exists, resident WebGPU GMRES cannot
automatically use a CPU-side Schwarz preconditioner without expensive
CPU/GPU synchronization.

### Files affected

- **`src/lib/cpt-app/deformation/preconditioners/additive-schwarz.js`**
  (new file). Provides `buildAdditiveSchwarzPreconditioner()`,
  `applyAdditiveSchwarzPreconditioner()`.
- **`src/lib/cpt-app/deformation/solver.js`** —
  - `applyKrylovPreconditioner()` becomes a dispatcher that picks
    the right `apply` function based on the `precond.kind`.
  - `solveGmresDispatched()` and `solveBiCgStab()` accept the
    Schwarz preconditioner.
  - `solveGmresScaled()` must actually apply the selected preconditioner.
    This likely means changing it from plain restarted GMRES to right- or
    left-preconditioned GMRES with a clear residual convention.
  - `solveGmresDispatched()` must decide explicitly:
    CPU fallback GMRES + CPU Schwarz, or resident WebGPU GMRES + GPU-supported
    preconditioner. Do not silently mix resident GPU vectors with CPU Schwarz.
- **`src/lib/cpt-app/legacy-controller.js`** — preconditioner level
  toggle (Schwarz on/off) and a help tip describing the trade-off.

### Validation

- Verification case **41s-schwarz**: solve a known unsymmetric system
  (10×10 dense) with both block-Jacobi and Schwarz preconditioners.
  Assert iteration counts match hand-computed expected values.
- Benchmark **41s-bench**: 30°-slope mesh, plastic phase. Measure
  GMRES iterations per Newton step with and without Schwarz; expect
  ≥ 2× reduction.

### Estimated complexity

- ~350 lines new code (Schwarz module + integration).
- 2 new verification cases.
- Risk: dense LU on small blocks is a sub-routine we currently lack;
  must implement (or import a tiny utility).
- Estimated effort: **3-4 dev-days**.

---

## Phasing & dependency graph

The six items split into two ordered tracks:

### Track A — Initialisation correctness (do first)

```
§1 (Admissible predictor)
   └─→ §2 (Staged geostatic init) — depends on §1's admissible seed
   └─→ §5 (Depth-band diagnostics) — independent, exposes §1+§2's progress
        └─→ §4 (Fail-fast) — uses §5's depth bands for classification
```

**Reasoning**: every other improvement compounds on having a
mathematically clean initial state. Doing §3/§6 first would speed up
the *repair* of the bad predictor without addressing why the predictor
is bad in the first place.

### Track B — Nonlinear robustness (do second)

```
§3 (Globalization tangent)   — independent, helps both initial and service phases
§6 (Schwarz preconditioning) — independent, helps unsymmetric / plastic Krylov
```

These can run in parallel after Track A is in.

### Recommended sequencing

| Sprint | Items | Wall-clock |
|--------|-------|-----------|
| 1      | §1, §5 | ~4 days |
| 2      | §2, §4 | ~5 days |
| 3      | §3     | ~2.5 days |
| 4      | §6     | ~3.5 days |

Total: **~15 dev-days** from a single experienced engineer, or
**~8 dev-days** with two engineers working in parallel after §1.

---

## Test/validation strategy

### Layer 1 — Unit verification (in `verify_deformation_phase_1.mjs`)

- Each new function gets a verification case that hand-computes the
  expected output on a small fixed input.
- Existing 51 cases must continue to pass at every step.

### Layer 2 — Cross-backend consistency

For each new feature, run the same case on the deterministic backend paths
available in Node:

- CPU f64 reference.
- `cpu-f32` / `cpu-double-single` surrogate for the WebGL-style packed
  matvec/element-kernel path.

Browser certification must separately cover real WebGPU DS, because the
`cpu-f32` surrogate does not implement the WebGPU resident FGMRES path and is
not a faithful stand-in for WebGPU synchronization behaviour.

### Layer 3 — Slope-specific certification suite

Add a new script `scripts/certify_slope_geostatic.mjs` that runs a curated
set of failing-on-main slope geometries and confirms the new predictor +
staged init + globalization combination either converges or returns the
expected geostatic classification quickly:

- 10°, 20°, 30°, 45° slopes
- `c′ = 0`, `1`, `5`, `20` kPa
- `φ′ = 20°`, `30°`, `40°`
- Both T3 and T6 meshes
- Both flat-foundation and footing-load loadings

Total: 4 × 4 × 3 × 2 × 2 = **192 cases**. Do **not** assert that all cases
converge: `c′ = 0` with steep slopes may be physically unstable. Assert that
stable cases converge within calibrated Newton/Krylov budgets, and unstable
or inadmissible cases produce the intended classification within a small
cutback budget.

### Layer 4 — Visual / engineering sanity

A small set of canonical slope cases with known-good PLAXIS-equivalent
results from the team's archive. Compare settlement profile and FoS
within a few percent.

---

## Risks & mitigations

### R1 — The new predictor can be over-conservative for foundation-load cases

The shear-clipping in §1 underestimates the in-situ shear when slope
equilibrium genuinely requires it. For flat-ground footing problems
this is fine (the clip is no-op). For sloped ground with a steep
foundation load, the seed will under-predict the actual in-situ
shear, and the staged plastic continuation has to add it back.

**Mitigation**: §2's staged correction handles this naturally — the first
correction stages activate the missing equilibrium shear gradually, with the
plastic return mapping doing the work in small admissible steps.

### R2 — §3's elastic phase can over-shoot when soil is highly yielded

Elastic-tangent Newton steps can be too long when the actual
algorithmic-tangent stiffness is much smaller than `K_e`.

**Mitigation**: conventional Armijo line search, an additional phase-1
residual-improvement/stagnation check, and a maximum step size such as
`Δu_max = 0.05 · L_mesh` where `L_mesh` is a representative element length.
The line search will shrink an over-shooting step.

### R3 — Schwarz preconditioner setup cost dominates on small problems

For meshes < 1000 free DOFs, the Schwarz LU setup overhead exceeds
the iteration-count savings.

**Mitigation**: gate Schwarz behind a problem-size threshold
(`schwarzMinFreeDofs: 5000`). Below it, fall back to block-Jacobi.

### R4 — Depth-band heuristic mis-attributes failures to free-surface

A foundation-load problem can produce shallow yielding at the load
edge that looks like a free-surface predictor failure.

**Mitigation**: §5's depth-band report includes `tau_over_strength`
and explicit Gauss-point coordinates. §4's classification rule
checks for *spatial* clustering (high-σ' region with high
`tau_over_strength` p95 ≥ 0.95) before returning "unstable", so a
load-edge spike does not trigger the unstable classification.

---

## Out of scope (separate roadmaps)

These are noted for the user's awareness and explicitly *not* in this
plan:

- **WebGPU element kernels (T3/T6 strain/internal-force/tangent)** —
  see `docs/deformation/T6_gpu_acceleration.md` for the GPU side.
- **MC return mapping on GPU** — same.
- **Material commit/rollback on GPU** — needs the element kernels first.
- **GPU CSR-entry assembly** — same.

This plan is mostly independent of those for the CPU path: the initial-stress,
staging, diagnostics, and fail-fast changes live in solver control flow and
CPU-side numerical algorithms. Preconditioning is the exception. A CPU-side
Schwarz preconditioner can improve CPU fallback GMRES/BiCGStab, but resident
WebGPU GMRES will only benefit after a GPU-compatible preconditioner is added
or the dispatcher deliberately falls back to CPU GMRES for that solve.

---

## Appendix A — Function signatures (forward-declared)

```js
// §1
function buildAdmissibleSlopeInitialEffectiveStress6(
  point, materialParameters, model, options, elasticGeostaticStress6
): Float64Array /* 6-component */;
function chooseSlopeShearTarget(
  point, elasticGeostaticStress6, slopeAngleRad, params
): number;
function clipShearToAdmissibleEnvelope(
  sigmaVEff, sigmaHEff, tauTarget, params, tol
): number;
function largestAdmissibleShearByBisection(
  sigmaVEff, sigmaHEff, tauSign, params, tol
): number;

// §2
async function solveStagedGeostaticEquilibrium({...}): Promise<{
  state, kind: 'staged-converged' | 'geostatic-classification' | 'failed',
  stages: Array<StageResult>
}>;
function planGeostaticCorrectionStages(model, options): Array<StageDescriptor>;

// §3
async function solveNonlinearPhaseWithGlobalization({
  ..., tangentSchedule: ['elastic', 'plastic']
}): Promise<NonlinearResult>;

// §4
function classifyGeostaticNonconvergence(state, band, result): RunRecord;

// §5
function computeDepthBandReport(mesh, materialPoints, model, elementCaches, options): DepthBandReport;
function depthBandOf(activeYieldGaussPoints, mesh): DepthBand;

// §6
function buildAdditiveSchwarzPreconditioner(
  mesh, rows, freeDofs, options
): SchwarzPreconditioner;
function applyAdditiveSchwarzPreconditioner(
  precond, r, z
): void;
```

## Appendix B — Configuration option additions

```js
// In bishop.deformation.options:
useAdmissibleSlopeSeed:    true,    // §1, default ON
useStagedGeostaticInit:    true,    // §2, default ON
geostaticCorrectionStages: 8,       // §2, predictor-to-gravity correction stages
initialGravityTangentSchedule: ['elastic', 'plastic'], // §3
elasticGlobalizationArmijoC1: 1e-3, // §3, conventional Armijo coefficient
elasticGlobalizationMinResidualRatio: 0.90, // §3, separate residual-improvement check
geostaticMinLoadStep:      1e-3,    // §4, abort threshold
geostaticMaxRepeatedBand:  3,       // §4, fail-fast trigger
geostaticProgressFailFastSteps: 6,  // §4, accepted tiny-correction crawl trigger
geostaticProgressFailFastPlasticFraction: 0.15, // §4, active-zone fraction trigger
preconditionerLevel:       'schwarz', // §6, 'jacobi' | 'schwarz' | 'ilu0'
schwarzMinFreeDofs:        5000,    // §6, fall back to block-Jacobi below this
schwarzOverlap:            1,       // §6, number of element layers
```

---

## Appendix C — GPU path honesty (already shipped on this branch)

A separate, *already-merged* set of fixes addresses the user's critique
that the WebGPU path was not actually "all on GPU" for hard solves:

1. **`useResidentGmres`** is a first-class option. Forwarded through
   the controller bridge → worker payload → solver options → linear
   solve dispatch (mirrors `useResidentCg`).
2. **GMRES + BiCGStab default to pure CPU f64.** The slow hybrid
   pattern (CPU Krylov + GPU async DS matvec, with full vector
   round-trips per Arnoldi step) is now off by default. The user
   opts into it with `allowHybridGpuMatvecForCpuKrylov: true` (kept
   only as an experimental switch for benchmarking).
3. **`krylovPath` field on the run record.** Honest categorical
   value: `cpu-f64` | `gpu-resident-cg` | `gpu-resident-cg+gmres` |
   `gpu-resident-gmres` | `hybrid-cpu-krylov-gpu-matvec`. The UI
   surface label is built from this so the user can see at a glance
   whether the run actually exercised resident GPU paths or fell
   through to CPU.
4. **`residentGmresCertified: false` on WebGPU.** Until the
   certification harness in Appendix E passes on a real device, the
   resident FGMRES path is opt-in only. The dispatcher routes
   uncertified GMRES solves to CPU f64 — *never* to the slow hybrid.

These changes are independent of the slope-init plan above and
deliver the immediate UX correctness fix the user asked for ("the
hybrid is not the answer; tell me clearly what is running"). They
don't, on their own, fix the slope/c-phi *speed* — that requires the
real algorithmic work in §1–§6 above.

---

## Appendix D — Resident WebGPU FGMRES sync reduction

Current resident FGMRES per inner iteration:

| Phase | Submit | Readback |
|-------|--------|----------|
| matvec + MGS column + ‖w‖² | 1 submit (≈ 60-150 dispatches) | 1 readPair (norm) |
| Hessenberg column for Givens | 1 buffer copy submit | 1 mapAsync of full Hess (≈ 8 KB) |
| V[j+1] = w / norm | 1 submit (1 axby) | — |

3 submits + 2 readbacks per inner iter. At m=30 inner iters per
restart and ~50 µs per submit/readback, that's ≈ 9 ms of pure
synchronisation overhead per restart cycle, on top of the actual
GPU compute. For the slope c-phi case (~30 restarts), ≈ 270 ms of
overhead.

### Reduction option 1 — Lazy Givens (recommended first step)

Apply Givens to a *batch of K columns* of the Hessenberg matrix
instead of column-by-column. K = 5 means we readback the Hessenberg
+ rotated rhs every 5 inner iters, apply 5 columns of Givens on
CPU, decide if any row triggered convergence, and either continue
or break the inner loop.

**Cost**: between Givens applications we do K inner iters with
*no* convergence check — i.e. we may run a few iterations past
convergence. For typical engineering tolerances (10⁻⁸ relative
residual), the over-iteration is < 2 inner iters per restart.

**Savings**: readbacks drop from 60 → 12 per restart. Submits drop
from 90 → 30 + (60 - 12) saved buffer-copy submits.

**Implementation**: trivial — only the readback cadence changes.
~30 lines of solver-side bookkeeping in
`solveGmresPreconditionedWebgpu`.

### Reduction option 2 — Combined submit per inner iter

Merge the V[j+1] normalisation kernel into the next inner iter's
submit. Saves 1 submit per inner iter (30 per restart). Requires:

- The "1/norm" scalar comes from the previous inner iter's readback;
  it lives on CPU.
- The next inner iter's first kernel reads `1/norm` from a uniform
  written *just before* the submit.

**Implementation**: the FGMRES inner loop's submit boundary moves
from "after V[j+1] normalisation" to "after V[j+1] normalisation
of the *previous* iter and matvec of the *current* iter". One small
restructure of `solveGmresPreconditionedWebgpu`.

### Reduction option 3 — Givens on GPU + GPU-resident rotated rhs (ambitious)

Encode the entire restart cycle as one submit:

- New WGSL kernel: `dsGivensApplyColumn(j, c[], s[], hessenberg)` —
  applies prior j-1 rotations to column j, computes new (c[j], s[j]),
  applies to rotated rhs s.
- Convergence check via an "abort flag" in storage — a tiny
  `array<u32, 1>` buffer that the kernel writes when
  `|s[j+1]| < tol`. The host polls the flag (mapAsync of 4 bytes) at
  the end of the restart, but the GPU doesn't gate inner iters on it
  (those run to m).
- Tradeoff: we always run all m inner iters per restart cycle, even
  when convergence is reached early. For typical c-phi runs that's
  ~10-20% wasted iterations — but the wall-clock is dominated by
  sync overhead anyway, so the net is faster.

**Savings**: per-restart submits drop from 90 → 1. Readbacks drop
from 60 → 1.

**Implementation**: ~150 lines of new WGSL + 80 lines of solver
restructure. ≈ 2 dev-days.

### Recommended sequencing

1. Ship reduction option 1 (lazy Givens) immediately after FGMRES
   certification — minimal risk, 5× sync reduction.
2. Defer option 2 / 3 until the certification harness shows residual
   sync overhead is the dominant cost on user's hardware.

---

## Appendix E — Resident FGMRES certification harness

The WebGPU resident FGMRES is implemented but *uncertified* in code.
`residentGmresCertified: false` means the dispatcher only runs it
when the user explicitly opts in via `useResidentGmres: true`. Until
this harness passes on real hardware, the safe default is CPU f64.

### Test cases

The harness exercises the *exact* solve patterns that broke on the
old hybrid path:

| Case | Mesh | Soil | Loading | Notes |
|------|------|------|---------|-------|
| C1 | T3 flat | c'=5 kPa, φ'=30° | self-weight | sanity baseline |
| C2 | T3 flat | c'=5 kPa, φ'=30° | self-weight + 50 kN/m strip | service path |
| C3 | T3 30° slope | c'=5 kPa, φ'=30° | self-weight | predictor stress test |
| C4 | T3 30° slope | c'=1 kPa, φ'=30° | self-weight | low-cohesion stress test |
| C5 | T6 30° slope | c'=5 kPa, φ'=30° | self-weight | T6 mid-edge sensitivity |
| C6 | T6 30° slope | c'=1 kPa, φ'=30° | self-weight | T6 + low-cohesion |
| C7 | T6 30° slope | c'=5 kPa | c-phi reduction | unsymmetric tangent |
| C8 | T6 30° slope | c'=1 kPa | c-phi reduction | hard c-phi |

Each case is run *twice*: once with `useResidentGmres: true`
(resident path), once with `useResidentGmres: false` (CPU GMRES).

### Pass criteria

For each pair (resident vs CPU GMRES on the same case):

- **Convergence parity**: same `converged: true/false` decision in
  every Newton step.
- **Iteration parity**: total Newton iterations within ±2 of CPU.
- **Settlement parity**:
  `max ‖u_resident - u_cpu‖_∞ / ‖u_cpu‖_∞ < 1e-4`.
- **Residual parity**: final residual norm within ±1e-12 absolute or
  ±1e-4 relative of CPU.
- **No NaN, no infinite values** anywhere in the output.

Run timing is *recorded* (resident path should be 5-20× faster on
T6-slope problems where matvec dominates) but is **not** a pass
criterion — the certification is correctness-only.

### Implementation

- **`scripts/certify_webgpu_fgmres.html`** — browser-side harness.
  Loads the test fixtures, instantiates the deformation solver
  twice per case (resident, CPU), compares results, prints a
  pass/fail table. Uses ES-modules-in-browser so the same solver
  code runs as in production.
- **`scripts/fixtures/fgmres-certify-cases.json`** — fixed mesh +
  soil + loading definitions for each of C1-C8. Generated once,
  checked into the repo for reproducibility.
- **`scripts/certify_webgpu_fgmres_node.mjs`** — node-side runner
  that uses the cpu-f32 surrogate (CPU emulation of the DS resident
  path) to run a degraded version of the harness for CI. Catches
  algorithmic bugs even without WebGPU; the browser harness is
  required for hardware certification.

### Flipping the flag

When *every* case in the harness passes on at least:

- Apple M3 / Safari 18+
- Apple M3 / Chrome 120+
- Intel UHD / Chrome 120+
- AMD Radeon / Chrome 120+

…then change
[webgpu-backend.js](../../src/lib/cpt-app/deformation/gpu/webgpu-backend.js):

```diff
- residentGmresCertified: false,
+ residentGmresCertified: true,
```

After certification, the dispatcher's three-state logic flips the
default for unsymmetric / plastic / c-phi solves to the resident
FGMRES on every device that exposes WebGPU.

### Estimated effort

- Harness page + fixtures: 1 day
- Iteration-count and parity assertions: 1 day
- Cross-device runs + flag flip: 0.5 day (assuming all pass)

Total: **2-3 dev-days**.
