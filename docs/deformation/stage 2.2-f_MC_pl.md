# stage 2.2-f_MC_pl.md — Exact Mohr–Coulomb Stage 2.2 and Plastic Geostatic Initialization Plan

## 0. Scope

This note records the exact Stage `2.2` direction for the deformation solver after the `v0.4.3`
upgrade and defines the next required step to obtain a more faithful exact
Mohr–Coulomb elastoplastic workflow for slopes and other self-weight-sensitive geometries.

The note has four purposes:

1. state clearly what is already implemented in the current code,
2. state clearly what still prevents a full exact-match reading of the solver,
3. explain why weak slopes can fail before any meaningful service load is applied,
4. define, in implementation detail, the required plastic geostatic initialization phase and
   the associated solver, state-management, reporting, and documentation changes.

This is a theory-and-implementation note, not a marketing note. If the current implementation
is approximate, that is stated directly. If a proposed extension changes interpretation, that is
stated directly.

---

## 1. Current Status on `v0.4.3`

### 1.1 What is now exact

The current Stage `2` deformation route now uses an exact Mohr–Coulomb **shear** return at
material-point level:

- exact MC shear yield diagnostics are evaluated from the current 3D principal effective stresses,
- the local return is performed in principal stress space,
- active-set promotion from single-face to edge return is implemented,
- plastic strain and accumulated equivalent plastic strain are stored,
- the old Stage `2.1` mismatch between smoothed plastic activation and exact `eta_MC`
  diagnostics is substantially removed from the active constitutive path.

In practical terms:

- elastic points should satisfy `f_MC < 0`,
- yielded shear points should satisfy `f_MC ≈ 0`,
- accepted plastic shear points should satisfy `eta_MC ≈ 1`,
- `epsilon_p_acc > 0` now corresponds to actual exact shear plastic activity rather than to a
  smoothed surrogate.

### 1.2 What is not yet exact

The following items remain outside the fully exact final workflow:

1. the initial self-weight state is still a **prescribed reference stress field**, not a fully
   equilibrated elastoplastic geostatic state,
2. tension cut-off is still **diagnostic-only** in the public Stage `2` path,
3. the default global solve still uses the **symmetrized** elastoplastic tangent for robustness,
   while the unsymmetric path remains an advanced option,
4. the service-load phase still begins from a stress-seeded reference state rather than from a
   full converged plastic initial phase with non-zero initial displacement and plastic strain.

### 1.3 Consequence

The current code should therefore be read as:

- exact MC **shear plasticity** in the load phase,
- but not yet a full exact elastoplastic geostatic-history workflow.

That distinction is the reason why weak slopes may still appear to fail "immediately" once the
service phase starts: the constitutive update is exact for the load phase, but the initial state is
not yet the result of a prior elastoplastic gravity-equilibration phase.

---

## 2. Current Geostatic Initialization: What It Is and What It Is Not

### 2.1 Current implemented geostatic route

The current solver performs a **linear geostatic gravity step** on the actual section mesh and
then reconstructs the initial effective stress field as a `K0,nc`-controlled reference state.

The implemented route is:

1. assemble and solve the linear elastic gravity problem on the current mesh,
2. recover the total stress field from the geostatic displacement solution,
3. subtract pore pressure from the vertical total stress to obtain
   `sigma'yy,0`,
4. impose:
   `sigma'xx,0 = K0,nc sigma'yy,0`,
5. impose:
   `sigma'zz,0 = K0,nc sigma'yy,0`,
6. retain the geometry-driven initial shear stress `tau'xy,0` from the gravity-step result,
7. seed the material-point state from that effective-stress field.

In symbols:

```text
sigma'yy,0 = sigma_yy,total,gravity - u0
sigma'xx,0 = K0,nc sigma'yy,0
sigma'zz,0 = K0,nc sigma'yy,0
tau'xy,0   = tau_xy,total,gravity
```

where:

- `sigma'xx,0`, `sigma'yy,0`, `sigma'zz,0`, `tau'xy,0` are initial effective stresses in `kPa`,
- `sigma_yy,total,gravity` is the vertical total stress recovered from the linear gravity solve in `kPa`,
- `u0` is the initial pore pressure in `kPa`,
- `K0,nc` is the interpreted at-rest earth pressure ratio, dimensionless.

### 2.2 Why this route exists

This route intentionally separates two roles:

- **gravity-step solve**: capture geometry-driven vertical stress and initial shear stress,
- **`K0,nc` reconstruction**: preserve the interpreted in-situ horizontal confinement rather than
  letting elastic `nu` dictate the at-rest ratio.

This is better than the earlier bugged route in which the successful geostatic path effectively
let elastic Poisson confinement determine the initial horizontal stress ratio.

### 2.3 Why this route is still not a full elastoplastic initial phase

The current route is still a **prescribed initial stress model**.

The reason is that after the linear gravity step, the normal effective stresses are reconstructed
to match `K0,nc`; they are not then passed through a plastic self-weight equilibrium correction.

So the current state is:

- good as a prescribed geostatic reference field,
- not yet a self-weight state that has been allowed to plastically redistribute and re-equilibrate.

### 2.4 Current admissibility audit

The current code already performs an exact MC admissibility audit on the seeded initial state.

For each material point it stores:

- `initialFMc`,
- `initialEtaMc`,
- `initialDiagnosticYieldSurface`,
- `initialStateAdmissible`.

This is correct and important. It means the solver can now distinguish:

- "the prescribed initial stress is already inadmissible under exact MC",
  from
- "the load phase caused plasticity."

That audit is already a net improvement and must remain part of the future design.

---

## 3. Exact Mohr–Coulomb Theory Relevant to Stage `2.2`

### 3.1 Classical shear yield function

For compression-positive principal effective stresses:

```text
sigma'1 >= sigma'2 >= sigma'3
```

the classical MC shear yield function is:

```text
f_MC =
(sigma'1 - sigma'3)
- (sigma'1 + sigma'3) sin(phi')
- 2 c' cos(phi')
```

where:

- `sigma'1`, `sigma'2`, `sigma'3` are principal effective stresses in `kPa`,
- `c'` is effective cohesion in `kPa`,
- `phi'` is effective friction angle in `rad` internally, `deg` in UI.

Admissibility:

```text
f_MC <= 0
```

Yield:

```text
f_MC = 0
```

### 3.2 Diagnostic utilization

The exact MC utilization ratio is:

```text
eta_MC =
(sigma'1 - sigma'3)
/
[(sigma'1 + sigma'3) sin(phi') + 2 c' cos(phi')]
```

provided the denominator is positive and sufficiently large.

Interpretation:

- `eta_MC < 1`: elastic reserve exists,
- `eta_MC = 1`: on the exact shear surface,
- `eta_MC > 1`: inadmissible exact MC diagnostic state.

### 3.3 Plane-strain incremental constitutive update

The load phase is formulated incrementally. For an increment:

```text
Delta epsilon = B Delta u
```

and the elastic trial stress is:

```text
sigma'_trial = sigma'_n + D^e Delta epsilon
```

Exact backward-Euler return mapping requires:

```text
epsilon^p_(n+1) = epsilon^p_n + Delta lambda m_(n+1)
sigma'_(n+1)    = sigma'_trial - Delta lambda D^e m_(n+1)
f_MC(sigma'_(n+1)) = 0
```

where:

- `epsilon^p` is plastic strain,
- `Delta lambda` is the plastic multiplier increment,
- `m` is the plastic potential gradient.

For current Stage `2`, the implemented exact path covers the **MC shear branch**.

### 3.4 Why accepted shear-plastic states should satisfy `eta_MC ≈ 1`

If the local return is exact for the active shear surface, then after a converged accepted update:

```text
f_MC(sigma'_(n+1)) ≈ 0
```

Therefore:

```text
eta_MC(sigma'_(n+1)) ≈ 1
```

This is the exact theoretical reason why the old Stage `2.1` pattern

- `eta_MC > 1`
- `epsilon_p_acc = 0`

was unsatisfactory when interpreted as a plastic-zone map.

### 3.5 Tension cut-off

The present exact Stage `2` route is exact for MC **shear** return, not yet for a full public
tension-cutoff plastic branch.

Therefore:

- shear plasticity is exact,
- tension cut-off remains a diagnostic state for now.

This boundary must be stated clearly in solver output and documentation.

### 3.6 Exact face return in principal stress space

The exact Stage `2.2` face-return algebra should be stated explicitly because it defines what the
current exact shear branch is supposed to mean.

For a trial principal effective stress vector:

```text
sigma'_trial,p = [sigma'1,trial, sigma'2,trial, sigma'3,trial]^T
```

define:

```text
a_phi =
[1 - sin(phi'), 0, -(1 + sin(phi'))]^T

b_psi =
[1 - sin(psi), 0, -(1 + sin(psi))]^T
```

where:

- `a_phi` is the exact MC face normal in principal stress space, dimensionless,
- `b_psi` is the plastic-potential direction in principal stress space, dimensionless,
- `psi` is the dilation angle in `rad` internally, `deg` in UI.

For isotropic linear elasticity in principal normal-stress space:

```text
D_n =
[lambda + 2G, lambda,      lambda
 lambda,      lambda + 2G, lambda
 lambda,      lambda,      lambda + 2G]
```

with:

- `G = E / [2 (1 + nu)]` in `kPa`,
- `lambda = E nu / [(1 + nu)(1 - 2 nu)]` in `kPa`,
- `E` the Young modulus in `kPa`,
- `nu` the elastic Poisson ratio, dimensionless.

The exact single-face return then solves:

```text
f_trial = a_phi^T sigma'_trial,p - 2 c' cos(phi')

Delta lambda = f_trial / (a_phi^T D_n b_psi)

sigma'_(n+1),p = sigma'_trial,p - Delta lambda D_n b_psi
Delta epsilon^p_p = Delta lambda b_psi
```

The full tensor is reconstructed from the trial principal projectors:

```text
sigma'_(n+1) = sigma'1,(n+1) P1 + sigma'2,(n+1) P2 + sigma'3,(n+1) P3
```

where:

- `P1 = v1 ⊗ v1`,
- `P2 = v2 ⊗ v2`,
- `P3 = v3 ⊗ v3`,
- `v1`, `v2`, `v3` are orthonormal principal directions.

This is the exact Stage `2.2` face-return target. Any accepted face-plastic point should satisfy:

```text
f_MC(sigma'_(n+1)) ≈ 0
eta_MC(sigma'_(n+1)) ≈ 1
```

up to the declared local tolerance.

### 3.7 Face validity, edge/apex promotion, and the boundary with Stage `2.3`

Stage `2.2` is exact only as long as the return remains a **single-face** return.

The face solution is valid only if:

```text
sigma'1 - sigma'2 > tol_edge
sigma'2 - sigma'3 > tol_edge
```

and, if a tension branch is later activated:

```text
sigma'3 >= -sigma_t + tol_tension
```

where:

- `tol_edge` is the declared principal-stress degeneracy tolerance in `kPa`,
- `sigma_t` is tensile cut-off strength in `kPa`,
- `tol_tension` is the tension-surface activation tolerance in `kPa`.

If one of the principal-stress gaps collapses, the stress point is no longer a single-face point.
It must be promoted to:

- edge return when `sigma'1 ≈ sigma'2` or `sigma'2 ≈ sigma'3`,
- apex handling when the return collapses to the compression apex,
- tension cut-off handling once that branch is activated constitutively.

Therefore the rigorous interpretation of the roadmap remains:

```text
Stage 2.2 = exact face return
Stage 2.3 = exact edge/apex active-set return
Stage 2.4 = exact constitutive tension cut-off
```

This note deliberately plans the next initial-phase work on top of the current exact shear branch,
but it does not redefine Stage `2.2` as the final end state of exact Mohr-Coulomb plasticity.

---

## 4. Why Weak Slopes Can Still Fail Before Service Load

### 4.1 Infinite-slope screening

For a drained infinite-slope style check:

```text
FS(z) =
c' / [gamma z sin(beta) cos(beta)]
+ tan(phi') / tan(beta)
```

where:

- `FS(z)` is factor of safety at depth `z`, dimensionless,
- `c'` is effective cohesion in `kPa`,
- `gamma` is unit weight in `kN/m^3`,
- `z` is depth normal to the slope in `m`,
- `beta` is slope angle in `rad`,
- `phi'` is effective friction angle in `rad`.

For a `3H:2V` slope:

```text
beta = arctan(2/3) ≈ 33.7 deg
```

If:

- `phi' = 22 deg`,
- `c' = 1 kPa`,

then:

```text
tan(phi') / tan(beta) ≈ 0.61
```

So the frictional contribution alone is already well below unity, and the small cohesion term
rapidly loses importance with depth. That means the slope is expected to be very weak under
self-weight in a pure drained MC reading.

### 4.2 What the current code then does

If the exact initial-state audit finds broad regions with:

```text
initialFMc > 0
```

then the service phase starts from a prescribed reference stress state that is already
inadmissible under exact MC.

The first attempted service increment then often produces:

- widespread active plasticity,
- strong line-search damping,
- cutback,
- failure to accept even the first step.

This is not necessarily a code bug. It can be the correct consequence of:

- a very weak drained slope,
- plus the absence of a prior plastic self-weight equilibration phase.

---

## 5. Why PLAXIS Can Sometimes Get Further

### 5.1 What PLAXIS documents

PLAXIS publicly documents:

1. separate initial-stress generation procedures such as **`K0 procedure`** and
   **`Gravity loading`**,
2. implicit plastic integration for deformation calculations,
3. automatic step-size procedures,
4. global and local convergence checks, including local plastic-point accuracy,
5. the use of `Reset displacements to zero` in later phases to isolate phase-specific
   deformation output.

Official sources:

- PLAXIS 2D Scientific Manual  
  `https://files.seequent.com/PLAXIS/Manuals/PLAXIS_2D/English/PLAXIS_2D_4_Scientific%20Manual.pdf`
- PLAXIS 3D Reference Manual  
  `https://files.seequent.com/PLAXIS/Manuals/PLAXIS_3D/English/PLAXIS_3D_2_Reference%20Manual.pdf`
- PLAXIS 2D Tutorial Manual  
  `https://files.seequent.com/PLAXIS/Manuals/PLAXIS_2D/English/PLAXIS_2D_1_Tutorial%20Manual.pdf`
- PLAXIS 3D Tutorial Manual  
  `https://files.seequent.com/PLAXIS/Manuals/PLAXIS_3D/English/PLAXIS_3D_1_Tutorial%20Manual.pdf`

### 5.2 Important inference

The manuals do not say "PLAXIS will always converge a weak slope". That would be false.

The correct inference is:

- if a slope can plastically redistribute to a stable self-weight state,
  a mature plastic gravity initialization has a better chance of finding it,
- if a slope truly cannot sustain itself under drained MC self-weight,
  the initial plastic phase should fail there too.

### 5.3 Main difference with the current app

The main current difference is not that PLAXIS has a secret strength increase.

The main difference is:

- PLAXIS can follow a more mature staged path between initial stress generation and later
  plastic loading phases,
- our current app still begins the service-load phase from a prescribed reference stress field,
  not from a fully equilibrated plastic gravity phase.

That is the real gap to close.

---

## 6. Required Next Step: Plastic Geostatic Initialization

### 6.1 Principle

The next exact extension is **not** to remove the current `gravity-step-k0nc` predictor.

That predictor is still useful because:

- it preserves the interpreted `K0,nc` lateral confinement,
- it captures geometry-driven initial `tau_xy`,
- it gives a strong initial guess.

The correct extension is:

1. build the current `gravity-step-k0nc` predictor,
2. use it as the starting state for a plastic self-weight equilibrium phase,
3. carry the converged exact initial state into the service-load phase.

### 6.2 Why not gravity from zero with plain MC only

The current material definition does not contain the full stress-history structure required to
recreate the interpreted `K0,nc` state by loading from a stress-free state with plain MC only.

Therefore, a pure "gravity from zero with exact MC" route would discard an important part of
the interpreted in-situ state.

So the proper exact workflow for this app is:

```text
prescribed K0,nc geostatic predictor
-> plastic geostatic equilibration
-> service-load phase
```

That is the right engineering compromise and the right exact next step.

---

## 7. Required Theory for the New Initial Phase

### 7.1 New Phase 0 equilibrium problem

The new initial plastic phase must solve:

```text
R_g(u) = F_g - F_int(sigma'(u, state)) = 0
```

where:

- `R_g` is the gravity-phase residual vector,
- `u` is the total displacement field in the initial phase,
- `F_g` is the body-force vector from self-weight,
- `F_int` is the internal force vector assembled from the current exact constitutive state.

This is a **total-force equilibrium** problem.

### 7.2 Difference from the current service-load residual

The current service phase uses an incremental formulation around a reference stress field:

```text
R_q(Delta u) = lambda_q F_q - F_int(Delta sigma')
```

with:

```text
Delta sigma' = sigma'_current - sigma'_reference
```

The new initial phase must instead use the total current stress:

```text
F_int,g = integral B^T sigma'_current dV
```

not:

```text
integral B^T (sigma'_current - sigma'_reference) dV
```

So the solver must support two formulation modes:

- `total` for plastic geostatic equilibration,
- `incremental` for the later service-load phase.

### 7.3 End state of Phase 0

After convergence, the initial phase should provide:

- `U0` = converged geostatic displacement field,
- `sigma'0` = converged exact initial effective stress field,
- `epsilon^p_0` = plastic strain field accumulated during self-weight equilibration,
- `epsilon_bar^p,acc,0` = accumulated equivalent plastic strain from the initial phase.

Then the service-load phase starts from this exact committed state.

### 7.4 Phase 0 is an equilibrium-correction phase, not a fresh load-from-zero phase

This distinction is critical.

The proposed new initial phase should **not** discard the interpreted `K0,nc` state and reload the
section from a stress-free state under self-weight alone. That would remove part of the intended
in-situ interpretation.

Instead, the sequence should be:

1. build the current `gravity-step-k0nc` predictor,
2. seed the constitutive state from that predictor,
3. solve an exact plastic equilibrium correction under the full gravity load,
4. accept the converged corrected state as the initial reference state for the service phase.

So the new Phase `0b` is a Newton-type correction to:

```text
R_g(U) = F_g - F_int(U, state)
```

starting from the predictor state, not a new loading history from zero stress.

### 7.5 What constitutes failure in the initial phase

The initial phase should be considered to fail if:

- the nonlinear iterations cannot reduce the residual below the declared tolerances,
- repeated cutback cannot produce an acceptable update,
- the active-set/plastic corrector stalls,
- or the phase terminates in a clearly non-equilibrated partial state.

This is not merely a numerical event. In interpretation it means:

- the prescribed interpreted self-weight state could not be equilibrated under the current exact
  constitutive model and boundary conditions.

That outcome should be reported explicitly as:

- `initial self-weight equilibrium not achieved`,

not as a generic later service-load failure.

---

## 8. Displacement Reset: Why PLAXIS Uses It and Why We Should Too

### 8.1 Meaning of displacement reset

PLAXIS tutorials repeatedly use **`Reset displacements to zero`** when a later phase should
report only the deformation caused by that later phase.

This is a **reporting baseline reset**, not a constitutive memory reset.

The correct interpretation is:

- keep stresses,
- keep plastic strain,
- keep hardening/state variables,
- keep pore pressures as intended by the phase definition,
- reset the displacement reference for the next phase output.

### 8.2 Why it matters here

Once we add a true plastic gravity-initialization phase, the service-load phase will otherwise
report:

```text
u_total = u_gravity + u_service
```

But engineers usually want the service-load phase to report:

```text
Delta u_service = u_total - u_gravity
```

That is exactly why displacement reset is the correct behavior.

### 8.3 What must not be reset

We must **not** reset:

- `sigma'0`,
- `epsilon^p_0`,
- `epsilon_bar^p,acc,0`,
- constitutive state variables,
- exact initial admissibility information.

Resetting those would destroy the whole purpose of the plastic gravity phase.

### 8.4 Required solver interpretation

We therefore need:

- total displacement field:
  `U_total`,
- stored initial displacement field after Phase 0:
  `U0`,
- displayed service-load displacement:
  `Delta U = U_total - U0`.

This is the correct analogue of the PLAXIS displacement reset concept for our solver.

---

## 9. Detailed Implementation Plan

### 9.1 Phase sequence

The deformation run should be refactored into:

```text
Phase 0a: geostatic predictor
Phase 0b: plastic geostatic equilibration
Phase 1 : service-load phase
Phase 2 : postprocessing and reporting
```

### 9.2 Phase 0a — Geostatic predictor

Keep the current implemented route.

This remains:

- linear,
- geometry-aware,
- `K0,nc`-controlled,
- fast,
- a good initial guess.

The current solver mode label `gravity-step-k0nc` remains appropriate for the predictor.

### 9.3 Phase 0b — Plastic geostatic equilibration

Add a new nonlinear solve:

```text
solveInitialPlasticEquilibrium(...)
```

Inputs:

- mesh,
- element caches,
- body-force vector,
- material points seeded from the predictor state,
- Phase 0 solver options.

Outputs:

- converged `U0`,
- converged committed material-point states,
- initial-phase diagnostics,
- near-failure partial state if gravity equilibration cannot be completed.

The constitutive model should be the current exact Stage `2` MC shear route.

Recommended exact insertion points in the current file:

- keep `buildGeostaticInitialization(...)` as the predictor generator,
- add `solveInitialPlasticEquilibrium(...)` after the predictor path,
- replace the current direct transition
  `geostatic -> buildElementMaterialPoints -> solveNonlinearStage1`
  with
  `predictor -> material-point seeding -> initial plastic equilibrium -> service phase`,
- split the solver summary so the initial phase and the service phase each report their own
  convergence state and failure reason.

### 9.4 Phase 1 — Service-load phase from the equilibrated state

The current service-load solve then starts from:

- `U0` as the displacement baseline,
- exact committed state from Phase 0 as the constitutive base state.

The service phase should then report:

```text
Delta U_service = U_total - U0
```

and not the total self-weight settlement.

### 9.5 Displacement reset implementation rule

The correct analogue of the PLAXIS `Reset displacements to zero` feature is:

```text
constitutive state: preserved
stress state: preserved
plastic history: preserved
display baseline for displacement: reset
```

In code terms that means:

- the converged displacement field `U0` from Phase `0b` must be stored,
- the service-phase unknown may still be held as total displacement if that is cleaner for the
  solver internals,
- but all public service-phase displacement output must be computed against `U0`.

This is an output-baseline reset, not a constitutive reset.

---

## 10. File-by-File Changes Required

### 10.1 `src/lib/cpt-app/deformation/solver.js`

This file will require the largest refactor.

#### A. Keep the current predictor path

Retain:

- `buildGeostaticInitialization(...)`
- `recoverInitialFieldFromGeostaticSolution(...)`
- `buildK0ControlledInitialEffectiveStress6(...)`

but conceptually reframe them as the **predictor** stage.

#### B. Add a new nonlinear initial-phase solve

Add:

```text
solveInitialPlasticEquilibrium(...)
```

This should:

- use the exact MC Stage `2` material points,
- use full gravity load only,
- use `formulationMode = 'total'`,
- return a converged or partial initial phase result.

#### C. Generalize the nonlinear solve

Refactor the current `solveNonlinearStage1(...)` into a more general phase solver, for example:

```text
solveNonlinearPhase({
  formulationMode,
  externalRhsBase,
  displacementReference,
  displacementInitialGuess,
  materialPoints,
  options,
  ...
})
```

where:

- in `total` mode:
  `F_int = integral B^T sigma' dV`,
- in `incremental` mode:
  `F_int = integral B^T (sigma' - sigma'_ref) dV`.

The current nonlinear assembly already computes:

- constitutive updates,
- current tangent,
- internal force,
- residual,
- active MC counts,
- displayed near-failure snapshots.

Those should be retained but parameterized by:

- `phaseKind: 'initial-gravity' | 'service-load'`,
- `formulationMode: 'total' | 'incremental'`,
- `referenceStateMode: 'none' | 'equilibrated-initial'`.

#### D. Carry non-zero initial displacement

Store:

- `U0` = converged initial displacement field,
- `U_display_service = U_total - U0`.

#### E. Separate failure reasons

The solver output must distinguish:

- initial-phase failure under self-weight,
- service-load failure after the load phase has started.

This is essential for interpretation.

Recommended solver output fields:

- `initialPredictorMode`
- `initialPhaseConvergenceState`
- `initialPhaseFailureReason`
- `initialPhaseAcceptedSteps`
- `initialPhaseRejectedSteps`
- `initialPhaseDisplayedGravityFactor`
- `servicePhaseConvergenceState`
- `servicePhaseFailureReason`
- existing service metrics retained where possible for backward compatibility

### 10.2 `src/lib/cpt-app/deformation/material-models.js`

The exact shear return is already in place and does not need a conceptual rewrite for this step.

Required additions are mainly state-management related:

- ensure committed/trial state can move cleanly from Phase 0 to Phase 1,
- preserve plastic history from the initial phase,
- distinguish:
  - predictor initial state,
  - equilibrated initial state.

Recommended additional stored fields:

- `equilibratedInitialFMc`,
- `equilibratedInitialEtaMc`,
- `equilibratedInitialYieldSurface`.

Recommended material-point state structure after this change:

```text
predictorState
  prescribed stress state from gravity-step-k0nc

referenceState
  converged exact initial phase state used as the service-load base state

committedState
  current accepted state in the active phase

trialState
  current Newton or line-search state
```

The required semantic change is that `referenceState` must become the **equilibrated**
initial state after Phase 0, not merely the seeded prescribed predictor state.

### 10.3 `src/lib/cpt-app/deformation/material.js`

No constitutive theory rewrite is required here, but new options will likely be needed:

- `initialPhaseMaxIterations`,
- `initialPhaseTolerance`,
- `initialPhaseLoadStepping` or similar if load advancement is exposed,
- possibly a dedicated initial-phase step-control set if later tuning proves necessary.

Default recommendation:

- start by reusing the current Stage `2` nonlinear defaults.

### 10.4 `src/lib/cpt-app/legacy-controller.js`

Add a Stage 6 deformation option:

`Initial stress mode`

with at least:

- `Fast geostatic predictor (gravity-step + K0nc)`
- `Plastic geostatic equilibration (exact Stage 2)`

Also add result summaries:

- initial-phase convergence state,
- initial inadmissible element count,
- initial yielded element count,
- max initial accumulated plastic strain,
- whether the service phase actually started.

Recommended public wording:

- `Initial stress predictor`
- `Initial plastic equilibration`
- `Initial state admissible`
- `Initial yielded elements`
- `Service-load phase started`

Avoid ambiguous wording such as `geostatic failed` without stating whether that refers to:

- predictor generation,
- self-weight plastic equilibration,
- or the later service phase.

### 10.5 Documentation

Update:

- `docs/deformation/MC_pl.md`
- `docs/deformation/MC.md`
- public deformation docs route

with:

- distinction between predictor and equilibrated initial state,
- displacement reset semantics,
- exact initial-phase interpretation.

### 10.6 `scripts/verify_deformation_phase_1.mjs`

Extend the verification suite with a dedicated initial-phase block.

Required new tests:

- admissible flat deposit:
  predictor and equilibrated initial states remain close,
- stable slope:
  initial plastic equilibration converges and service phase starts,
- unstable weak slope:
  initial phase fails or returns partial near-failure state before service loading,
- displacement-reset semantics:
  service settlement excludes self-weight displacement,
- state-carry-over semantics:
  plastic strain accumulated in the initial phase is still present at service-phase start.

### 10.7 Postprocessing and plotting code

Any postprocessing path that currently assumes a single seeded initial state must be updated to
distinguish:

- predictor state,
- equilibrated initial state,
- service final state.

That includes:

- element summaries,
- plotted `eta_MC`,
- plotted equivalent plastic strain,
- settlement summaries,
- line-probe and export quantities if they depend on absolute versus incremental displacement.

---

## 11. Output and Interpretation Changes

### 11.1 Solver outputs

Add:

- `geostaticPredictorMode`
- `initialEquilibriumConverged`
- `initialEquilibriumConvergenceState`
- `initialFailureReason`
- `initialAcceptedSteps`
- `initialRejectedSteps`
- `initialPeakActiveMcElements`
- `initialDisplacementResetApplied`

### 11.2 Summary outputs

Add:

- `maxInitialEtaMcPredictor`
- `maxInitialEtaMcEquilibrated`
- `initialInadmissibleElementCount`
- `initialPlasticElementCount`
- `maxInitialEquivalentPlasticStrain`
- `initialSettlementTotal`
- `serviceSettlementIncrement`

### 11.3 Result interpretation

The UI and reports should explicitly distinguish:

1. **predictor inadmissibility**
2. **equilibrated initial plasticity**
3. **service-load plasticity**

That avoids the current ambiguity where a user can think the surcharge caused a failure that
actually belongs to self-weight.

### 11.4 Plotting and display semantics

Default displacement plots should continue to show **service-load increment** displacement,
not total displacement since the start of gravity initialization.

Recommended displayed quantities:

- `u_x,fin,service = u_x,total - u_x,0`
- `u_y,fin,service = u_y,total - u_y,0`
- `settlement_service = -(u_y,total - u_y,0)`

Recommended optional advanced quantities:

- `u_x,0`
- `u_y,0`
- `eta_MC,predictor`
- `eta_MC,init,eq`
- `epsilon_bar^p,acc,init`
- `epsilon_bar^p,acc,service`

This is the correct analogue of PLAXIS displacement reset while preserving constitutive
history.

### 11.5 Exact semantic meaning of `eta_MC` after the new implementation

Once the initial phase is added, the public meaning of `eta_MC` should be partitioned explicitly:

- `eta_MC,predictor`
  exact MC diagnostic utilization of the prescribed `gravity-step-k0nc` predictor,
- `eta_MC,init,eq`
  exact MC utilization of the converged initial elastoplastic state,
- `eta_MC,service,fin`
  exact MC utilization of the accepted service-phase state.

The interpretation then becomes:

- `eta_MC,predictor > 1`
  means the prescribed interpreted initial state is outside exact MC,
- `eta_MC,init,eq ≈ 1`
  means the self-weight state has redistributed onto the exact surface,
- `eta_MC,service,fin ≈ 1`
  means the service phase has reached active exact MC yield at the final accepted state.

This separation is necessary if we want the plotted fields to remain rigorous.

---

## 12. Exact Pseudocode for the Two-Phase Workflow

```text
build mesh and body-force vector
build service-load vector

Phase 0a: geostatic predictor
  U_pred <- linear gravity-step solve
  sigma'_pred <- gravity-step-k0nc reconstruction
  seed material points from sigma'_pred
  audit predictor admissibility

Phase 0b: plastic geostatic equilibration
  solve R_g(U) = F_g - F_int(sigma'(U,state)) = 0
  constitutive model = exact Stage 2 MC shear plasticity
  if converged:
    store U0
    store equilibrated material-point state S0
  else:
    report initial self-weight failure
    stop before service phase

Phase 1: service-load phase
  start from U0 and S0
  solve incremental service-load problem
  Delta U_service = U_total - U0
  report service settlements and plasticity

postprocess
  output predictor metrics
  output equilibrated initial metrics
  output service-load metrics
```

This is the clean exact continuation of the current Stage `2` implementation.

---

## 13. Required Tests

### 13.1 Geostatic predictor regression

Keep the current checks:

- submerged `sigma'zz` reconstruction,
- `K0,nc`-controlled confinement,
- slope shear stress from gravity step.

### 13.2 Initial-phase equilibrium tests

Add:

1. flat horizontal deposit, admissible soil
   - predictor and equilibrated state should be close,
   - no spurious initial plasticity.

2. moderate slope that should stand
   - initial phase should converge,
   - some initial plastic redistribution is acceptable,
   - service phase should then start normally.

3. weak slope that cannot stand under self-weight
   - initial phase should fail or return a partial near-failure gravity state,
   - service phase should not start.

4. regression based on the current drained weak-slope case
   - verify that the solver identifies self-weight instability as an initial-phase issue rather than
     a later service-load issue.

### 13.3 Service-load continuation tests

Add:

- service footing benchmark from equilibrated initial state,
- service slope benchmark from equilibrated initial state,
- unload/reload around a plastic service state after a plastic initial phase,
- displacement-reset check:
  service settlement plot must exclude self-weight settlement.

---

## 14. Acceptance Criteria

This implementation should be considered successful only if all of the following are true:

1. the initial plastic phase can converge a moderate slope that is supportable under self-weight,
2. a truly weak drained slope is reported as failing in the initial phase rather than being
   misread as a service-load failure,
3. service-load displacement results exclude the initial self-weight settlement by default,
4. stresses and constitutive state variables are preserved across the displacement reset,
5. footing and slope regressions still pass with the new two-phase workflow,
6. the UI and documentation clearly distinguish:
   - predictor state,
   - equilibrated initial state,
   - service-load state.

---

## 15. Recommended Default Behavior

At first release of this extension:

- keep `Fast geostatic predictor` as the default for speed and backward compatibility,
- expose `Plastic geostatic equilibration` as an advanced exact option,
- once robust enough, revisit whether it should become the default for slopes and exact Stage `2`
  workflows.

This staged rollout is the safer engineering choice.

---

## 16. Final Recommendation

The current exact Stage `2` shear return is the correct and necessary foundation. The next exact
step is **not** another tweak to `eta_MC`, another surface hack, or another near-surface
regularization rule.

The next exact step is:

```text
prescribed gravity-step-k0nc predictor
-> exact plastic geostatic equilibration
-> displacement reset for the service phase
-> service-load phase from the converged initial plastic state
```

That is the correct implementation path if the objective is:

- exact MC shear plasticity in the load phase,
- honest identification of self-weight instability,
- better agreement with mature staged FEM practice,
- and a clearer separation between:
  - initial-state inadmissibility,
  - self-weight plastic redistribution,
  - and service-load response.

---

## 17. References

### Internal project documents

- `docs/deformation/MC_pl.md`
- `docs/deformation/MC.md`
- `docs/deformation/ML_pl_fix.md`

### External references

- Itasca Software. FLAC3D theory documentation for principal-stress Mohr-Coulomb evaluation,
  non-associated flow, and tension cut-off interpretation.

- PLAXIS 2D Scientific Manual  
  `https://files.seequent.com/PLAXIS/Manuals/PLAXIS_2D/English/PLAXIS_2D_4_Scientific%20Manual.pdf`

- PLAXIS 3D Reference Manual  
  `https://files.seequent.com/PLAXIS/Manuals/PLAXIS_3D/English/PLAXIS_3D_2_Reference%20Manual.pdf`

- PLAXIS 2D Tutorial Manual  
  `https://files.seequent.com/PLAXIS/Manuals/PLAXIS_2D/English/PLAXIS_2D_1_Tutorial%20Manual.pdf`

- PLAXIS 3D Tutorial Manual  
  `https://files.seequent.com/PLAXIS/Manuals/PLAXIS_3D/English/PLAXIS_3D_1_Tutorial%20Manual.pdf`

- Abbo, A.J. & Sloan, S.W. (1995), smooth hyperbolic approximation to Mohr-Coulomb; relevant as
  the theoretical contrast with the earlier Stage `2.1` smoothed route.

- Vermeer, P.A. (1979), implicit integration of elastoplastic constitutive equations

- Van Langen, H. & Vermeer, P.A. (1990), automatic step-size procedures for nonlinear
  geotechnical FE analysis
