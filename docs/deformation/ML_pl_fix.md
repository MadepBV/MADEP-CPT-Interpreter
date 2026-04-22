# ML_pl_fix.md — Correction Plan for the Current MC / Stage 1 Solver

**Document status:** corrective design note  
**Scope:** current `Stage 1 MC-active reduced-stiffness` deformation solver  
**Intent:** resolve the math/theory mismatches identified in the current implementation review and define the clean end-state

---

## 1. Purpose

The current deformation solver is useful and passes its regression suite, but several implementation choices are still shortcuts relative to the intended theory in `MC_pl.md`.

This note defines:

1. the **issues that must be corrected**,
2. the **final target behavior**,
3. the **implementation plan** to reach that target safely,
4. the **acceptance tests** required before the solver can be called theory-aligned.

The goal is not merely to keep the solver numerically stable. The goal is to make it:

- mathematically consistent,
- explicit about its approximations,
- architecturally ready for Stage 2 plasticity,
- documented without contradiction.

---

## 2. Issues to Correct

### 2.1 Stage 1 active state is sticky instead of reversible

Current code keeps `currently_MC_active` alive through committed state and previous-trial state carry-over. That makes Stage 1 behave like a monotonic damage model over one run.

That is **not** the same as the intended Stage 1 theory in `MC_pl.md`, where:

```text
currently_MC_active   // current trial-state branch only
has_ever_exceeded_MC  // diagnostic history only
```

So the present code is numerically usable, but it is not the elegant or theory-faithful Stage 1.

### 2.2 Initial `sigma'_zz` is reconstructed incorrectly below the phreatic line

The current solver stores only initial 2D effective stress, then lifts it back to 3D with:

\[
\sigma'_{zz}=\nu(\sigma'_{xx}+\sigma'_{yy})
\]

This is not generally valid after pore-pressure subtraction. The relation

\[
\sigma_{zz}=\nu(\sigma_{xx}+\sigma_{yy})
\]

applies to the **total** elastic stress state under plane strain, not directly to the already-subtracted effective stress state.

Because the Stage 1 material uses a 3D principal-stress Mohr-Coulomb check, this can distort:

- \(\sigma'_2\),
- the principal ordering,
- \(F_{MC}\),
- \(\eta_{MC}\),
- the active branch decision.

### 2.3 Tension cut-off is mixed into Stage 1 shear activation

Stage 1 is meant to be a **reduced-shear-stiffness response to MC shear exceedance**.

The current implementation also lets the tension-cutoff state participate in the same Stage 1 branch logic. That is conceptually muddy:

- Stage 1 shear softening is not a real tension model,
- a tension-zone warning is not the same thing as a reduced-shear branch,
- Stage 2 should handle true multisurface behavior later.

### 2.4 Hidden defaults do not match the intended theory

Two hidden defaults are currently engineering shortcuts:

- `rShear = 0.2`
- `yieldTolerance = 1e-3`

The specification in `MC_pl.md` instead points toward:

- first `rShear` range around `0.02 - 0.10`
- stress-scaled yield tolerances, not one absolute fixed number

These defaults strongly affect activation sensitivity and the severity of Stage 1 softening.

### 2.5 Public docs currently contradict the shipped solver behavior

The website docs and UI notes are not fully synchronized:

- some places correctly describe the shipped solver as monotonic/sticky,
- at least one public bullet still describes the default Stage 1 branch as reversible.

That is unacceptable for engineering software documentation.

---

## 3. Required End-State

The elegant end-state is:

1. **full 6-component effective stress state is stored and transported explicitly**;
2. **Stage 1 branch logic is reversible within the current trial equilibrium process**;
3. **`hasEverExceededMc` remains diagnostic only**;
4. **tension cut-off is diagnostic-only in Stage 1**;
5. **activation tolerances are stress-scaled**;
6. **all docs describe exactly what is shipped**.

In short:

\[
\boxed{\text{Stage 1 must be a reversible MC-shear active-set model, not sticky damage.}}
\]

---

## 4. Complete Solution

The clean solution has two layers:

1. **Immediate correctness fixes** that can be made without changing the Stage 1 solver concept.
2. **Final Stage 1 solver correction** that replaces sticky activation with a proper reversible active-set scheme.

The recommended execution is therefore:

- **Release A:** correctness and documentation fixes
- **Release B:** solver-level reversible Stage 1

This avoids shipping another half-correct nonlinear path.

---

## 5. Release A — Immediate Correctness Fixes

These fixes should be implemented even if the solver temporarily remains monotonic.

### 5.1 Store initial effective stress as full `stress_6`

Replace all logic that stores only:

\[
\{\sigma'_{xx},\sigma'_{yy},\tau_{xy}\}
\]

for initial state construction.

Instead store:

\[
\boldsymbol{\sigma}'_{0,6}
=

\begin{bmatrix}
\sigma'_{xx,0} \\
\sigma'_{yy,0} \\
\sigma'_{zz,0} \\
\tau_{xy,0} \\
0 \\
0
\end{bmatrix}
\]

#### 5.1.1 Geostatic gravity step

After the geostatic solve, recover the full total stress from the elastic material point:

\[
\boldsymbol{\sigma}_{0,6}
\]

Then subtract pore pressure from the normal components only:

\[
\boldsymbol{\sigma}'_{0,6}
=
\boldsymbol{\sigma}_{0,6}
-
u_0
\begin{bmatrix}
1\\1\\1\\0\\0\\0
\end{bmatrix}
\]

This must be done before material-point seeding.

#### 5.1.2 Flat `K0` fallback

If the gravity step fails and we fall back to flat `K0`, construct total stress first:

\[
\sigma'_{yy,0}=\sigma'_{v0}
\]

\[
\sigma'_{xx,0}=K_0\sigma'_{v0}
\]

\[
\sigma_{yy,0}=\sigma'_{yy,0}+u_0
\]

\[
\sigma_{xx,0}=\sigma'_{xx,0}+u_0
\]

\[
\sigma_{zz,0}=\nu(\sigma_{xx,0}+\sigma_{yy,0})
\]

\[
\sigma'_{zz,0}=\sigma_{zz,0}-u_0
\]

and then store the full effective vector.

#### 5.1.3 New state seeding API

Introduce a dedicated seeding path:

```text
seedMaterialPointStateFromEffectiveStress6(effective_stress_6, params)
```

Keep the old 2D helper only for tests or legacy import paths, not for the main deformation solver.

### 5.2 Separate tension cut-off from Stage 1 shear activation

In Stage 1:

- `MC_SHEAR` may activate the reduced-shear branch
- `TENSION` must remain diagnostic-only

So the branch rule becomes:

```text
if mc_trial.state == MC_SHEAR and mc_trial.f > f_tol:
    currently_MC_active = true
else:
    currently_MC_active = false
```

If:

```text
mc_trial.state == TENSION
```

then:

- keep the elastic tangent,
- keep the elastic trial stress,
- report tension diagnostics,
- do not route the point into the reduced-shear branch.

This gives a much cleaner interpretation:

- `MC-active zone` means reduced-shear pseudo-plasticity
- `tension zone` means warning/diagnostic only

### 5.3 Correct defaults and tolerances

#### 5.3.1 Reduced shear factor

Set the default:

\[
r_{shear}=0.05
\]

This sits comfortably inside the intended first-use range:

\[
0.02 \le r_{shear} \le 0.10
\]

Values outside that range should remain allowed, but the UI should treat them as advanced tuning.

#### 5.3.2 Stress-scaled yield tolerance

Replace the absolute default `yieldTolerance = 1e-3` with:

\[
f_{tol}=\epsilon_f\max(c',|\sigma'_1|,|\sigma'_3|,p_{ref})
\]

Recommended starting values:

\[
\epsilon_f=10^{-8}
\]

\[
p_{ref}=100 \text{ kPa}
\]

This avoids one arbitrary absolute threshold controlling both shallow and deep stress states.

### 5.4 Documentation sync

Before the reversible Stage 1 solver ships:

- every public doc must describe the shipped model as **monotonic/sticky**
- no public bullet may call it reversible

This is a release-blocking documentation consistency rule.

---

## 6. Release B — Final Elegant Stage 1 Solver

This is the actual solver correction.

### 6.1 Governing idea

Stage 1 is not a smooth Newton problem. It is a **piecewise-linear active-set problem**:

- inactive points use elastic tangent,
- active points use reduced shear tangent,
- the active set itself depends on the current trial stress state.

Therefore the solver should not hide active-set behavior inside sticky constitutive memory.

Instead:

\[
\boxed{\text{the solver must iterate on the active set explicitly}}
\]

### 6.2 Material-point law for reversible Stage 1

The corrected Stage 1 material update is:

1. take committed state,
2. compute elastic trial stress,
3. evaluate MC on the elastic trial stress,
4. choose elastic or reduced branch based only on the **current active-set guess**,
5. return stress/tangent for that branch,
6. store `currently_MC_active` for the current trial state only,
7. update `hasEverExceededMc` only on commit.

Mathematically:

\[
\Delta\boldsymbol{\epsilon}
=
\boldsymbol{\epsilon}_{trial}
-
\boldsymbol{\epsilon}_{committed}
\]

\[
\boldsymbol{\sigma}'_{trial,elastic}
=
\boldsymbol{\sigma}'_{committed}
+
\mathbf{D}_e\Delta\boldsymbol{\epsilon}
\]

Evaluate:

\[
f_{MC}\left(\boldsymbol{\sigma}'_{trial,elastic}\right)
\]

Then:

\[
\boldsymbol{\sigma}'_{trial}
=
\boldsymbol{\sigma}'_{committed}
+
\mathbf{D}_{branch}\Delta\boldsymbol{\epsilon}
\]

with:

\[
\mathbf{D}_{branch}
=
\begin{cases}
\mathbf{D}_e & \text{inactive}\\
\mathbf{D}_{red} & \text{active}
\end{cases}
\]

### 6.3 Solver-level reversible active-set loop

For one load step:

1. start from committed state,
2. guess active set \(A^{(0)}\),
3. solve the linearized system for that branch pattern,
4. re-evaluate the active set from elastic trial stresses,
5. repeat until:
   - active set no longer changes,
   - residual is below tolerance.

#### 6.3.1 Active-set iteration

For outer iteration \(k\):

\[
\mathbf{K}(A^{(k)})\Delta\mathbf{u}^{(k)}=\mathbf{R}^{(k)}
\]

Then form the updated trial state and compute:

\[
A^{(k+1)} = \mathcal{H}\left(f_{MC}\right)
\]

where \(\mathcal{H}\) is the branch-selection rule.

Converge when:

```text
A^(k+1) == A^(k)
and
||R_free|| < tol_R
```

### 6.4 Numerical switching band

Pure hard switching at:

\[
f_{MC}=0
\]

can chatter at the boundary. The elegant practical fix is a **small solver-level switching band**, not constitutive stickiness across the whole run.

Use:

\[
f_{on}=+\epsilon_{switch}\,s_{ref}
\]

\[
f_{off}=-\epsilon_{switch}\,s_{ref}
\]

with:

\[
s_{ref}=\max(c',|\sigma'_1|,|\sigma'_3|,p_{ref})
\]

Recommended first value:

\[
\epsilon_{switch}=10^{-6}
\]

Then:

```text
if f_MC > f_on:      active
if f_MC < f_off:     inactive
else:                keep current outer-iteration branch guess
```

Important:

- this branch retention applies only inside the current outer active-set iteration,
- it is not allowed to become committed monotonic damage memory.

### 6.5 Commit rules

Only after global convergence:

```text
committed_state = trial_state
committed_state.has_ever_exceeded_MC |= committed_state.currently_MC_active
```

Do **not** carry `currently_MC_active` from one converged load step into the next as a permanent damage flag.

The only acceptable uses of previous active state are:

- initial guess for the next outer active-set iteration,
- initial guess for the next load step.

Neither is allowed to override the current branch decision once the active-set iteration resolves.

---

## 7. Detailed Implementation Plan

### Phase A — correctness cleanup

1. Add `seedMaterialPointStateFromEffectiveStress6(...)`.
2. Change geostatic recovery to store full effective `stress_6`.
3. Change flat `K0` fallback to construct total stress first, then effective `stress_6`.
4. Remove tension-cutoff participation from Stage 1 reduced-branch activation.
5. Change defaults:
   - `rShear = 0.05`
   - stress-scaled `yieldTolerance`
6. Sync public docs and UI text to the currently shipped solver.

### Phase B — reversible Stage 1

1. Remove constitutive sticky retention of `currently_MC_active`.
2. Introduce solver-level outer active-set iterations.
3. Add switching-band logic at the solver/branch-selection level.
4. Use active-set stability plus residual convergence as the load-step acceptance rule.
5. Keep load-step cutback for genuinely difficult cases.

### Phase C — cleanup and removal of legacy path

1. Keep the monotonic Stage 1 path only as a hidden emergency fallback during migration.
2. Once reversible Stage 1 passes all heavy-load regressions, remove the legacy sticky branch.
3. Update all docs to say `reversible Stage 1 active-set` and remove monotonic language.

---

## 8. Required Tests

### 8.1 Initial stress tests

#### Submerged `sigma'_zz` reconstruction

Create a submerged element test where:

- `u0 > 0`
- `sigma'_xx`, `sigma'_yy` are known

Verify that:

- current incorrect lift `nu*(sigma'_xx + sigma'_yy)` is **not** used,
- stored `sigma'_zz` comes from total-stress reconstruction minus pore pressure.

### 8.2 Stage 1 constitutive tests

#### Shear activation only

Verify:

- `MC_SHEAR` activates reduced branch,
- `TENSION` does not activate reduced branch,
- `hasEverExceededMc` remains diagnostic.

#### Reversible unload / reload

For the final reversible Stage 1:

1. activate MC branch,
2. unload back inside MC,
3. verify branch returns elastic,
4. verify `hasEverExceededMc == true`.

### 8.3 Solver tests

#### Elastic equivalence

When no point exceeds MC:

\[
\mathbf{u}_{Stage1} \approx \mathbf{u}_{elastic}
\]

#### Heavy-load activation

Use the current strong surcharge regression and require:

- convergence,
- one or more active MC elements,
- greater settlement than elastic fallback.

#### Active-set stability

For the reversible solver:

- no infinite branch oscillation,
- cutback occurs if active-set iterations stall,
- accepted load step always ends with stable active set.

### 8.4 Documentation tests

Manual release checklist:

- website docs,
- UI help text,
- technical spec,
- status wording

must all use the same Stage 1 description.

---

## 9. Acceptance Criteria

This correction work is accepted only when all of the following are true.

### 9.1 Release A acceptance

- initial stress is stored as full effective `stress_6`,
- submerged `sigma'_zz` is reconstructed correctly,
- Stage 1 does not route tension cut-off into the reduced-shear branch,
- default `rShear` and yield tolerance are theory-aligned,
- docs no longer contradict shipped behavior.

### 9.2 Release B acceptance

- `currently_MC_active` is reversible within the current trial equilibrium process,
- `hasEverExceededMc` is diagnostic only,
- heavy-load regressions converge,
- the current strong-load case no longer requires sticky retention to remain solvable,
- docs and UI describe the solver as reversible Stage 1.

---

## 10. Recommended Immediate Policy

Until Release B is implemented, the codebase should follow this rule:

\[
\boxed{\text{Do not present the current shipped Stage 1 as reversible.}}
\]

And until Release A is done, the codebase should follow this rule:

\[
\boxed{\text{Do not trust current } \sigma'_{zz} \text{ reconstruction below the phreatic line as fully correct.}}
\]

This keeps the engineering communication honest while the solver is improved.

