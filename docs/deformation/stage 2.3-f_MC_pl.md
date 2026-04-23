# stage 2.3-f_MC_pl.md — Exact Mohr–Coulomb Stage 2.3 edge/apex implementation plan

## 0. Scope

This note defines the full implementation plan for **Stage `2.3`** of the deformation solver on
branch `v0.4.4`.

The purpose of Stage `2.3` is narrow and exact:

- finish the local constitutive upgrade from exact MC **face** return to exact MC
  **edge/apex active-set** return,
- remove the remaining ambiguity at repeated principal stresses,
- make the active surface and plastic strain semantics mathematically consistent at corners of the
  classical cornered Mohr-Coulomb yield surface,
- prepare the solver cleanly for later Stage `2.4` tension-cutoff plasticity.

This note does **not** replace the separate `stage 2.2-f_MC_pl.md` plan.

The two notes address different gaps:

- `stage 2.2-f_MC_pl.md`
  addresses the **global phase structure** problem:
  plastic geostatic initialization, displacement reset, and clean separation of self-weight
  instability from service-load instability.
- `stage 2.3-f_MC_pl.md`
  addresses the **local constitutive exactness** problem at MC corners:
  edges, repeated eigenvalues, apex handling, active-set stability, and exact local branch
  interpretation.

Both are required for a full exact classical MC workflow. They are not the same task.

---

## 1. Current status at the start of `v0.4.4`

### 1.1 What is already present in the shipped exact Stage `2` path

At the start of `v0.4.4`, the codebase already contains:

- exact MC shear diagnostics in principal effective stress space,
- exact face-return algebra for the primary shear branch,
- a provisional multisurface local solve in
  `src/lib/cpt-app/deformation/material-models.js`,
- explicit helpers such as:
  - `buildExactMcSurfaces(...)`
  - `evaluateExactMcSurfaceValuesFromPrincipal(...)`
  - `solveExactMcActiveSetReturn(...)`
  - `computeExactElastoplasticTangent(...)`
- active surface labels:
  - `MC_FACE`
  - `MC_EDGE`
  - `MC_APEX`
  - `TENSION`
- exact initial admissibility auditing for the prescribed initial stress state.

The current exact shear route is therefore no longer the old smoothed Stage `2.1`.

### 1.2 Why that still does not mean Stage `2.3` is finished

The current local exact path already goes beyond a pure single-face return, but it is still **not**
the rigorous end state of Stage `2.3`.

The reasons are:

1. the current local multisurface solve is still built around a surface set
   `F12`, `F13`, `F23` evaluated on the **trial spectral projectors**,
2. the current `solveExactMcActiveSetReturn(...)` admits multiple active shear surfaces, but
   it still does so inside one generic projector-frozen loop rather than inside explicit
   branch-specific face/edge/apex solvers,
3. edge handling is obtained by promoting active surfaces inside one generic active-set loop,
   rather than by explicit branch-aware edge logic,
4. repeated-eigenvalue handling is not yet formalized around unique subspace projectors,
5. the formal apex branch is not yet separated from the edge branches in a mathematically explicit way,
6. tension cut-off is still outside the constitutive active-set branch solve,
7. tangent construction is still expressed as a generic multisurface correction, not as
   branch-identified exact face/edge/apex logic,
8. user-facing and regression semantics still do not distinguish:
   - face plasticity,
   - exact repeated-eigenvalue edge plasticity,
   - formal apex or degenerate-corner states.

So the current code should be read as:

- exact MC shear plasticity with a useful provisional corner-capable active-set mechanism,
- but not yet a formally finished Stage `2.3` cornered-MC implementation.

### 1.3 What Stage `2.3` is supposed to achieve

Stage `2.3` is the phase in which:

- the edge branches become explicit and exact,
- repeated principal stresses stop being treated as a side effect of a generic active-set loop,
- the local branch type becomes a declared constitutive result,
- the local update remains exact when `sigma'1 ≈ sigma'2` or `sigma'2 ≈ sigma'3`,
- the code is ready for a later constitutive tension branch without rewriting the branch logic again.

In short:

```text
Stage 2.2 = exact face return
Stage 2.3 = exact edge/apex active-set return
Stage 2.4 = exact constitutive tension cut-off
```

This is the same sequence declared in `docs/deformation/MC_pl.md`.

---

## 2. Relation to the original `MC_pl.md` roadmap

### 2.1 Original roadmap statement

The original deformation theory note already states the intended progression:

```text
Stage 2.1: smoothed MC or Drucker-Prager test plasticity
Stage 2.2: exact MC face return
Stage 2.3: MC edge/apex active-set return
Stage 2.4: optional tension cut-off
```

It also states that for exact cornered MC:

- a smoothed cutting-plane route is not the preferred final path,
- the preferred route is a local active-set backward-Euler return.

### 2.2 Interpretation for the current app

The app has already crossed the main Stage `2.2` threshold:

- the active constitutive path is now exact MC shear plasticity,
- exact `eta_MC` and plastic strain are much better aligned,
- the old smoothed mismatch is no longer the main public problem.

So the next constitutive step is indeed `2.3`, not a repetition of `2.2`.

### 2.3 Important sequencing note

Even though `2.3` is the next **local constitutive** step, it is still not the biggest global
physics improvement for slopes.

That remains the separate plan in `stage 2.2-f_MC_pl.md`:

- plastic geostatic initialization,
- reset displacements for the service phase,
- separate self-weight failure from service-load failure.

So the rigorous reading is:

- the next **local constitutive** step is Stage `2.3`,
- the next **global phase-structure** step is the Stage `2.2` geostatic plan.

They should not be conflated.

---

## 3. Exact Mohr–Coulomb theory relevant to Stage `2.3`

### 3.1 Ordered principal effective stresses

Use the compression-positive convention:

```text
sigma'1 >= sigma'2 >= sigma'3
```

where:

- `sigma'1`, `sigma'2`, `sigma'3` are principal effective stresses in `kPa`,
- compression is positive,
- the internal FE stress vector remains the current engineering-Voigt sign convention already
  implemented in the solver.

### 3.2 The classical MC face in the ordered principal sector

In the ordered principal sector, the usual classical shear face is:

```text
f13 =
(sigma'1 - sigma'3)
- (sigma'1 + sigma'3) sin(phi')
- 2 c' cos(phi')
```

with:

- `phi'` friction angle in `rad` internally and `deg` in UI,
- `c'` effective cohesion in `kPa`.

The admissible condition is:

```text
f13 <= 0
```

and on the face:

```text
f13 = 0
```

### 3.3 Multisurface representation

The current code uses the equivalent surface set:

```text
F12 = (1 - sin(phi')) sigma'1 - (1 + sin(phi')) sigma'2 - 2 c' cos(phi')
F13 = (1 - sin(phi')) sigma'1 - (1 + sin(phi')) sigma'3 - 2 c' cos(phi')
F23 = (1 - sin(phi')) sigma'2 - (1 + sin(phi')) sigma'3 - 2 c' cos(phi')
```

This is useful for symmetric multisurface implementation and for branch promotion, but it must be
interpreted correctly:

- in the strictly ordered sector, `F13` is the governing face,
- `F12` and `F23` become relevant when the stress point approaches a corner where the ordering
  sectors meet.

### 3.4 Why `F13` governs in the ordered sector

For `sigma'1 >= sigma'2 >= sigma'3` and `0 <= sin(phi') < 1`:

```text
F13 - F12 = (1 + sin(phi')) (sigma'2 - sigma'3) >= 0
F13 - F23 = (1 - sin(phi')) (sigma'1 - sigma'2) >= 0
```

So inside the ordered sector:

```text
F13 >= F12
F13 >= F23
```

That is why Stage `2.2` face return is naturally the `F13` face return.

### 3.5 Edge conditions

At a corner of the hexagonal pyramid, two faces are simultaneously active.

The two practically relevant exact edge branches are:

1. `sigma'2 = sigma'3`

   Then:

   ```text
   F12 = F13
   ```

   so the active pair is:

   ```text
   {F12, F13}
   ```

2. `sigma'1 = sigma'2`

   Then:

   ```text
   F13 = F23
   ```

   so the active pair is:

   ```text
   {F13, F23}
   ```

To avoid ambiguous geotechnical naming in the code, the exact implementation should use explicit
branch names such as:

- `MC_EDGE_S23_EQUAL`
- `MC_EDGE_S12_EQUAL`

rather than relying only on informal labels like "extension edge" or "compression edge".

### 3.6 Edge multipliers are generally unequal

For the lower-edge branch:

```text
A = {F12, F13}
```

the exact `2 x 2` solve implies:

```text
Delta lambda_12 - Delta lambda_13
=
[F12^tr - F13^tr]
/
[2 G (1 + sin(phi')) (1 + sin(psi))]
=
-(sigma'2,tr - sigma'3,tr) / [2 G (1 + sin(psi))]
```

For the upper-edge branch:

```text
A = {F13, F23}
```

the exact `2 x 2` solve implies:

```text
Delta lambda_13 - Delta lambda_23
=
[F13^tr - F23^tr]
/
[2 G (1 - sin(phi')) (1 - sin(psi))]
=
(sigma'1,tr - sigma'2,tr) / [2 G (1 - sin(psi))]
```

where:

- `G` is shear modulus in `kPa`,
- `phi'` is friction angle in `rad`,
- `psi` is dilation angle in `rad`,
- `Delta lambda_ij` are plastic multiplier increments, dimensionless,
- `Fij^tr` are exact trial surface values in `kPa`.

So the two active multipliers are generally unequal. That matters because an exact edge state has a
unique returned stress branch, but not a unique full plastic-strain tensor representation unless a
further constitutive representation rule is declared.

### 3.7 Representative-basis rule is required in addition to repeated-subspace projectors

Unique repeated-subspace projectors are necessary, but not sufficient.

At an exact edge:

- `P23` or `P12` is enough to reconstruct the returned stress tensor,
- but it is not enough by itself to define a unique full plastic-strain tensor or a unique
  tensorial tangent push-forward inside the repeated subspace.

So Stage `2.3` must make one additional choice explicit:

1. solve the return completely in principal space,
2. store:
   - `edgeTotalMultiplier = Delta lambda_a + Delta lambda_b`
   - `edgeMixWeight = omega = Delta lambda_a / (Delta lambda_a + Delta lambda_b)`,
3. reconstruct returned stress using the unique distinct projector plus repeated-subspace projector,
4. reconstruct the full plastic-strain tensor using a deterministic representative basis inside
   the repeated subspace.

Recommended representative-basis priority:

1. previously committed basis if branch continuity is maintained,
2. otherwise the trial basis,
3. otherwise a documented canonical basis.

The trial-projector machinery should therefore be retained as a **representation rule**, not as the
definition of the constitutive branch itself.

### 3.8 Formal apex

Formally, an apex branch would be a state where three shear surfaces are active simultaneously.

For the pure shear-surface intersection:

```text
sigma'1 = sigma'2 = sigma'3 = -c' cot(phi')
```

So for `c' > 0` and `phi' > 0`, the formal triple-shear apex lies at hydrostatic **tension**, not
in the ordinary compression-positive soil regime. This is exactly why classical MC is commonly
paired with a separate tension cut-off.

There is also a direct numerical warning. For the shear-only `3 x 3` active system with isotropic
elasticity:

```text
det(N^T D_n M)
=
48 K G^2 sin(phi') sin(psi) (1 - sin^2(phi')) (1 - sin^2(psi))
```

where:

- `K` is bulk modulus in `kPa`,
- `G` is shear modulus in `kPa`.

So the formal triple-shear system is singular whenever:

```text
psi = 0
```

which is a common soil setting.

Therefore the rigorous Stage `2.3` policy should be:

- mandatory:
  - `MC_EDGE_S23_EQUAL`
  - `MC_EDGE_S12_EQUAL`
- optional and guarded:
  - `MC_APEX_FORMAL`

with default behavior:

- apex remains diagnostic-only or is immediately routed to `MC_TENSION_PENDING`
  unless:
  - `allowFormalApexBranch = true`,
  - `psi > 0`,
  - and branch conditioning checks are acceptable.

### 3.9 Kuhn-Tucker conditions for active surfaces

For an active-set return with surfaces `f_i` and plastic multipliers `Delta lambda_i`:

```text
f_i <= 0
Delta lambda_i >= 0
Delta lambda_i f_i = 0
```

For an edge branch with two active surfaces:

```text
f_a = 0
f_b = 0
Delta lambda_a >= 0
Delta lambda_b >= 0
```

This complementarity must be satisfied locally, not merely approximated by generic surface
promotion.

---

## 4. Exact backward-Euler return mapping for Stage `2.3`

### 4.1 General exact update

For an increment:

```text
sigma'_trial = sigma'_n + D^e Delta epsilon
```

the exact backward-Euler constitutive update is:

```text
sigma'_(n+1) = sigma'_trial - D^e sum_i (Delta lambda_i m_i)
epsilon^p_(n+1) = epsilon^p_n + sum_i (Delta lambda_i m_i)
f_i(sigma'_(n+1)) = 0 for active i
```

where:

- `D^e` is the elastic stiffness,
- `m_i` is the potential gradient of active surface `i`,
- `Delta lambda_i` are plastic multiplier increments.

### 4.2 Face branch

The exact Stage `2.2` face branch is the one-surface case:

```text
active set A = {F13}
```

This remains valid only while:

```text
sigma'1 - sigma'2 > tol_edge
sigma'2 - sigma'3 > tol_edge
```

### 4.3 Edge branch

The exact Stage `2.3` edge branch is the two-surface case:

```text
active set A = {Fa, Fb}
```

with either:

```text
A = {F12, F13}
```

or:

```text
A = {F13, F23}
```

The principal-space update becomes:

```text
sigma'_(n+1),p = sigma'_trial,p - D_n sum_i (Delta lambda_i m_i,p)
```

and the local unknowns are:

```text
[Delta lambda_a, Delta lambda_b]
```

solving:

```text
[n_a^T D_n m_a   n_a^T D_n m_b] [Delta lambda_a] = [f_a,trial]
[n_b^T D_n m_a   n_b^T D_n m_b] [Delta lambda_b]   [f_b,trial]
```

where:

- `D_n` is the elastic matrix in principal normal-stress space,
- `n_i` are exact yield normals,
- `m_i` are exact potential directions,
- `f_i,trial` are the active surface trial values.

This generic `2 x 2` active-set solve is the correct exact edge-return backbone.

### 4.4 Edge state variables that must be stored

Because the two active multipliers are generally unequal, the exact Stage `2.3` edge result should
store:

```text
edgeTotalMultiplier = Delta lambda_a + Delta lambda_b
edgeMixWeight = omega = Delta lambda_a / (Delta lambda_a + Delta lambda_b)
```

with:

```text
omega in [0, 1]
```

These are not cosmetic diagnostics. They are the additional state needed to represent edge
plasticity cleanly once the stress branch itself has been made objective.

### 4.5 Branch admissibility after the solve

After solving the edge system, the returned state is valid only if:

1. the solved plastic multipliers are non-negative,
2. inactive surfaces remain within tolerance,
3. the repeated-stress branch condition is satisfied,
4. the active set does not oscillate.

That means:

- for `A = {F12, F13}`, the return must satisfy `sigma'2 ≈ sigma'3`,
- for `A = {F13, F23}`, the return must satisfy `sigma'1 ≈ sigma'2`.

### 4.6 Apex branch

If a formal apex branch is kept inside Stage `2.3`, it becomes the `3 x 3` active system:

```text
A = {F12, F13, F23}
```

with:

```text
N^T D_n M DeltaLambda = f_trial^A
```

However, this branch should be implemented defensively:

- detect it,
- solve it only if the local system is physically meaningful and numerically admissible,
- otherwise report a branch transition toward the later Stage `2.4` tension/corner logic or
  a non-converged local corner state.

The practical rule is:

- edge branches are mandatory,
- apex support is guarded formal completeness and diagnostics,
- tension branch remains Stage `2.4`.

---

## 5. The real mathematical difficulty in Stage `2.3`

### 5.1 Repeated eigenvalues

At an exact edge:

- either `sigma'1 = sigma'2`,
- or `sigma'2 = sigma'3`.

At that point, the individual principal directions in the repeated eigenspace are **not unique**.

This is the core reason why Stage `2.3` is not just:

- "allow two surfaces in the current active-set solver".

### 5.2 What remains unique

Although the individual eigenvectors are not unique, the following are unique:

- the distinct principal direction,
- the projector onto the repeated subspace.

Define:

```text
P12 = P1 + P2
P23 = P2 + P3
```

Then:

- if `sigma'1 ≈ sigma'2`, `P12` is unique,
- if `sigma'2 ≈ sigma'3`, `P23` is unique.

This is the mathematical object the exact Stage `2.3` implementation must be built around.

### 5.3 What remains representation-dependent

Even after the unique repeated-subspace projector is introduced, the following still require a
documented representation choice:

- the full plastic-strain tensor inside the repeated subspace,
- any tensorial push-forward or basis-dependent tangent representation tied to that subspace.

So the mathematically complete closure condition for Stage `2.3` is not merely:

```text
branch-aware solver + repeated-subspace projector
```

It is:

```text
branch-aware solver
+ repeated-subspace projector
+ edge mixing variable
+ representative-basis rule
+ guarded apex policy
```

### 5.4 Why the current trial-projector approach is not the final answer

The current provisional multisurface solve builds active surfaces from the **trial** spectral
projectors and keeps that orientation during the local return.

That is serviceable for a first exact branch, but it is not the rigorous endpoint at repeated
eigenvalues because:

- the individual repeated-subspace vectors may rotate arbitrarily,
- the local gradients become basis-dependent if they are expressed in terms of `P2` and `P3`
  separately at a `sigma'2 = sigma'3` edge,
- branch switching can look like surface switching instead of true repeated-eigenvalue behavior.

So the exact `2.3` branch must move from:

- "surfaces on fixed trial projectors"

to:

- "branch-aware return with unique distinct-direction and repeated-subspace projectors".

However, the trial-projector machinery should still be kept as the deterministic basis used to
represent otherwise non-unique quantities inside the repeated subspace.

### 5.5 Consequence for code design

The Stage `2.3` implementation must explicitly detect:

- distinct face branch,
- `sigma'1 ≈ sigma'2` edge branch,
- `sigma'2 ≈ sigma'3` edge branch,
- formal apex/degenerate branch.

This branch classification is not optional. It is the core of the exact implementation.

---

## 6. Stage `2.3` target architecture

### 6.1 Required local branch classification

Replace the current implicit surface-promotion interpretation with an explicit local branch
classifier:

```text
classifyMcReturnBranch(trialState, materialParameters) -> {
  branchKind,
  candidateActiveSet,
  multiplicityKind,
  repeatedSubspace
}
```

Recommended branch kinds:

- `MC_FACE_F13`
- `MC_EDGE_S23_EQUAL`
- `MC_EDGE_S12_EQUAL`
- `MC_APEX_FORMAL`
- `MC_TENSION_PENDING`

### 6.2 Candidate-based branch orchestration

Branch classification should not be a single upfront decision that is accepted automatically.

The safer exact policy is:

1. build the ordered trial state,
2. rank likely candidate branches with hysteresis,
3. solve candidate face, edge, or formal apex branches in principal space,
4. accept only after post-solve checks on:
   - residual closure,
   - complementarity,
   - inactive-surface reopening,
   - repeated-gap closure,
   - active-matrix conditioning.

Required acceptance rules:

- if a face candidate closes the relevant principal gap below edge tolerance, the corresponding
  edge candidate outranks it,
- if both principal gaps collapse near `-c' cot(phi')`, route to `MC_TENSION_PENDING`
  unless the formal apex branch is explicitly allowed and admissible.

### 6.3 Required local solver split

Replace the single generic exact multisurface return entry point with an orchestrator:

```text
returnMapMcExactCornered(...)
  -> returnMapMcFaceExact(...)
  -> returnMapMcEdgeExact(...)
  -> returnMapMcApexExact(...)
  -> returnMapMcTensionPending(...) // diagnostic bridge only until Stage 2.4
```

This is cleaner than continuing to accumulate all exact branches inside one monolithic function.

### 6.4 Required repeated-subspace representation

Introduce explicit subspace projectors:

- `P1`, `P2`, `P3` when eigenvalues are distinct,
- `P12`, `P3` when `sigma'1 ≈ sigma'2`,
- `P1`, `P23` when `sigma'2 ≈ sigma'3`.

The branch solver should return:

- principal values,
- branch kind,
- subspace projectors,
- active surface ids,
- plastic multipliers,
- edge mix weight,
- exact local residuals.

### 6.5 Required representative-basis policy

Add an explicit representation policy for otherwise non-unique quantities:

```text
representativeBasisSource in {trial, committed, canonical}
```

Recommended default priority:

```text
committed -> trial -> canonical
```

The selected representative basis should be used only to represent:

- plastic-strain tensor components inside the repeated subspace,
- basis-dependent tangent push-forward quantities,

not to define the branch itself.

### 6.6 Required tangent architecture

The current multisurface elastoplastic tangent formula:

```text
D_ep = D_e - D_e M (N^T D_e M)^(-1) N^T D_e
```

remains the correct formal base.

But in Stage `2.3` it must be computed from **branch-valid** `N` and `M`, not merely from
trial-projector surfaces carried into a corner.

So the tangent builder must become branch-aware:

- `computeExactFaceTangent(...)`
- `computeExactEdgeTangent(...)`
- `computeExactApexTangent(...)`

All three may still reuse the same formal matrix expression, but their inputs and branch
semantics must be explicit.

---

## 7. Detailed implementation plan

### 7.1 `src/lib/cpt-app/deformation/material-models.js`

This file is the main Stage `2.3` work area.

#### A. Keep the current exact Stage `2.2` pieces that remain valid

Keep:

- exact MC parameter helpers,
- principal stress evaluation,
- exact face diagnostics,
- exact `eta_MC` evaluation,
- equivalent plastic strain accumulation,
- state cloning and diagnostics plumbing.

#### B. Refactor the current exact multisurface return

The current function:

```text
solveExactMcActiveSetReturn(...)
```

should not be deleted blindly, but it should be split and formalized.

Recommended target functions:

```text
classifyExactMcTrialBranch(...)
buildExactMcFaceData(...)
buildExactMcEdgeData(...)
buildRepeatedSubspaceProjectors(...)
returnMapMcFaceExact(...)
returnMapMcEdgeExact(...)
returnMapMcApexExact(...)
computeExactMcBranchTangent(...)
```

The present code structure already has useful building blocks:

- `buildExactMcSurfaces(...)`
- `evaluateExactMcSurfaceValuesFromPrincipal(...)`
- `activeYieldSurfaceLabelFromActiveSet(...)`
- `computeExactElastoplasticTangent(...)`

Those should be reused where correct, not rewritten unnecessarily.

#### C. Add explicit branch-state output

Extend the local result object with:

- `trialBranchKind`
- `acceptedBranchKind`
- `principalMultiplicity`
- `trialMultiplicityKind`
- `finalMultiplicityKind`
- `activeSurfaceIds`
- `plasticMultipliers`
- `usedRepeatedSubspaceProjectors`
- `edgeMixWeight`
- `representativeBasisSource`
- `tangentConditionNumber`
- `tangentQuality`
- `branchAcceptanceResidual`
- `apexAdmissibilityReason`
- `localResidualsBySurface`

This is essential for both debugging and public interpretation.

#### D. Add active-set stability logic

The local return needs more than a plain visited-set guard.

Add:

- active-set oscillation detection,
- repeated branch-switch detection,
- hysteresis for multiplicity detection,
- clear failure reason strings:
  - `edge active set oscillated`
  - `repeated-eigenvalue branch inconsistent`
  - `formal apex system singular`
  - `inactive surface reopened above tolerance`

#### E. Add explicit multiplicity tolerances

Use separate tolerances for:

- yield admissibility,
- edge multiplicity,
- apex multiplicity,
- local complementarity.

Do not reuse one single tolerance for all of these.

Recommended parameter names:

- `yieldTolerance`
- `localTolerance`
- `edgeStressGapTolerance`
- `apexStressGapTolerance`
- `activeSetComplementarityTolerance`
- `eigenSubspaceTolerance`

### 7.2 `src/lib/cpt-app/deformation/material.js`

Add configuration parameters needed by the exact cornered branch logic:

- `edgeStressGapTolerance`
- `apexStressGapTolerance`
- `eigenSubspaceTolerance`
- `activeSetComplementarityTolerance`
- `allowFormalApexBranch`
- `cornerBranchDiagnostics`
- `representativeBasisPolicy`

Defaults should be conservative and physically scaled, not arbitrary constants detached from the
stress scale.

Recommended scaling principle:

```text
tol_corner = eps_corner * max(|sigma'1|, |sigma'3|, p_ref, c')
```

with:

- `eps_corner` dimensionless,
- `p_ref` in `kPa`.

### 7.3 `src/lib/cpt-app/deformation/solver.js`

Global solver changes are smaller than in the constitutive file, but still important.

Required changes:

1. preserve the richer local branch diagnostics in the element summaries,
2. count:
   - face-plastic elements,
   - edge-plastic elements,
   - formal-apex elements separately,
3. expose branch-aware convergence metrics in partial near-failure states,
4. if local exact edge/apex return fails repeatedly, distinguish:
   - local constitutive failure,
   - global equilibrium failure.

The current solver summary already carries active MC counts and partial-state diagnostics. Stage
`2.3` should extend that machinery rather than replace it.

Recommended new summary fields:

- `peakActiveMcFaceElements`
- `peakActiveMcEdgeElements`
- `peakActiveMcApexElements`
- `peakLocalEdgeOscillationCount`

### 7.4 `src/lib/cpt-app/legacy-controller.js`

Add advanced public reporting, not new public complexity.

The UI does not need to show every internal branch detail by default, but it should expose:

- `plastic shear face yielding`
- `plastic edge yielding`
- `formal apex yielding`

and the diagnostics table should distinguish:

- `current active branch`
- `diagnostic surface`

Avoid ambiguous phrasing such as:

- `yielded`

without clarifying whether that means:

- exact face return,
- exact edge return,
- or diagnostic overstress only.

### 7.5 Documentation updates

Update:

- `docs/deformation/MC_pl.md`
- `docs/deformation/MC.md`
- public deformation docs

to state:

- Stage `2.2` = exact face return,
- Stage `2.3` = exact edge/apex return,
- repeated eigenvalues require unique subspace projectors,
- the public solver can distinguish face and edge yielding once the implementation lands.

---

## 8. Exact branch logic to implement

### 8.1 Trial classification logic

For the local trial state:

1. compute principal values and projectors,
2. evaluate `F12`, `F13`, `F23`,
3. identify whether the point is:
   - inside,
   - face-outside,
   - edge-adjacent,
   - repeated-eigenvalue corner candidate,
   - formal apex candidate,
4. rank candidate branches,
5. solve and accept according to the branch-acceptance policy.

### 8.2 Face branch rule

Use the existing exact Stage `2.2` face return if:

```text
F13 > tol_yield
sigma'1 - sigma'2 > tol_edge
sigma'2 - sigma'3 > tol_edge
```

and no other branch-preemption condition is triggered.

### 8.3 Edge branch rules

Use the `sigma'2 = sigma'3` edge branch if:

- the face return would land with `sigma'2 - sigma'3 <= tol_edge`, or
- trial classification already indicates that the lower pair is collapsing,
- active set `{F12, F13}` is indicated.

Use the `sigma'1 = sigma'2` edge branch if:

- the face return would land with `sigma'1 - sigma'2 <= tol_edge`, or
- trial classification already indicates that the upper pair is collapsing,
- active set `{F13, F23}` is indicated.

### 8.4 Apex branch rule

Use the formal apex branch only if:

- both principal gaps collapse within the declared apex tolerance, and
- the local active set and consistency conditions indicate triple-surface degeneracy or a
  branch-end state that cannot be represented by a two-surface edge, and
- `allowFormalApexBranch = true`, and
- `psi > 0`, and
- the active-system conditioning is acceptable.

If this is not physically meaningful or numerically stable, return a **branch-specific local
failure reason** or route immediately to `MC_TENSION_PENDING` rather than silently folding the
state back into an edge or face branch.

### 8.5 Inactive-surface reopening check

After every edge/apex return:

- evaluate all exact surfaces,
- any inactive shear surface reopening above tolerance invalidates the current branch,
- the branch must be reclassified, not merely accepted because the current active surfaces closed.

This is one of the most important exactness checks.

---

## 9. Repeated-eigenvalue projector strategy

### 9.1 Unique objects to use

At repeated eigenvalues, use:

- `P1`, `P23` for `sigma'2 ≈ sigma'3`,
- `P12`, `P3` for `sigma'1 ≈ sigma'2`.

These are unique and physically meaningful.

### 9.2 What not to rely on

Do **not** rely on:

- the exact orientation of `P2` versus `P3` at `sigma'2 = sigma'3`,
- the exact orientation of `P1` versus `P2` at `sigma'1 = sigma'2`,
- arbitrary eigenvector ordering within a repeated subspace.

Those are not stable branch objects.

### 9.3 Practical code strategy

Implement:

```text
buildRepeatedSubspaceProjectors(principalState, tolerances)
```

returning:

- `distinctProjector`
- `repeatedSubspaceProjector`
- `multiplicityKind`
- `isRepeated`

This helper should become the canonical source for exact edge/apex branch tensor mapping.

### 9.4 Branch continuity

To avoid branch jitter between Newton iterations, add continuity logic:

- prefer the previously committed branch if the current trial state remains within the branch
  hysteresis band,
- only switch branch when the new branch condition is clearly satisfied.

This does not change the exact theory. It stabilizes the branch detection around declared
numerical tolerances.

### 9.5 Invariance and representation discipline

At an exact edge, the following should be treated as constitutively invariant:

- returned stress,
- accepted branch label,
- active surface set,
- plastic work and scalar invariants,
- equivalent plastic strain.

Raw full plastic-strain tensor components at the exact edge are representation-dependent unless the
representative-basis rule is part of the specification. The verification plan must respect that.

---

## 10. Algorithmic tangent plan

### 10.1 Formal tangent expression

For a set of active surfaces:

```text
D_ep = D_e - D_e M (N^T D_e M)^(-1) N^T D_e
```

where:

- `N` stacks exact yield gradients of the active branch,
- `M` stacks exact potential gradients of the active branch.

### 10.2 What changes in Stage `2.3`

The formula itself does not change.

What changes is:

- how `N` is built for repeated-eigenvalue branches,
- how `M` is built for repeated-eigenvalue branches,
- how branch validity is checked before accepting the tangent.

### 10.3 Tangent symmetry

For non-associated flow:

- the exact consistent tangent is generally non-symmetric.

So Stage `2.3` should preserve the current distinction:

- exact local branch tangent,
- optional symmetrization at global-solver level for robustness.

Do not fake branch exactness by forcing symmetry inside the constitutive update itself.

### 10.4 Tangent acceptance check

After constructing the branch tangent:

- confirm the local active-set matrix was invertible,
- record its condition number,
- confirm the branch residuals are within tolerance,
- confirm the tangent entries are finite.

If any of these fail:

- do not silently fall back to elastic,
- return an explicit branch-local failure reason.

---

## 11. Verification plan

### 11.1 Unit tests for exact branch classification

Add deterministic local tests for:

1. face trial state:
   - classified as `MC_FACE_F13`
2. lower-pair repeated state:
   - classified as `MC_EDGE_S23_EQUAL`
3. upper-pair repeated state:
   - classified as `MC_EDGE_S12_EQUAL`
4. formal triple-degenerate state:
   - classified as `MC_APEX_FORMAL` or explicitly rejected as not admissible for the present
     constitutive stage

### 11.2 Unit tests for exact return behavior

Add local constitutive tests:

1. exact face return:
   - `f_final ≈ 0`
   - inactive surfaces remain admissible
2. exact `S23` edge return:
   - `F12_final ≈ 0`
   - `F13_final ≈ 0`
   - `sigma'2 ≈ sigma'3`
3. exact `S12` edge return:
   - `F13_final ≈ 0`
   - `F23_final ≈ 0`
   - `sigma'1 ≈ sigma'2`
4. local active-set oscillation detection:
   - branch returns explicit local failure reason instead of spinning
5. face-to-edge acceptance:
   - a trial state initially classified as face is forced onto the correct edge when the face solve
     closes the relevant principal gap below tolerance

### 11.3 Unit tests for repeated-subspace stability

Perturb a repeated-eigenvalue edge state by very small rotations and confirm:

- branch classification remains the same,
- returned stress remains materially the same,
- branch labels do not flicker because of arbitrary eigenvector flips,
- active surfaces remain the same,
- plastic work and equivalent plastic strain remain invariant.

Do **not** assert raw full plastic-strain tensor components at the exact edge unless the
representative-basis convention is explicitly part of the specification.

This is one of the most important new tests.

### 11.4 Global regression tests

Extend `scripts/verify_deformation_phase_1.mjs` with:

1. footing case that reaches face yield only
2. slope or crest case that produces localized exact edge activity
3. unload/reload from an edge-yield state
4. partial near-failure case with edge activity
5. regression proving that the Stage `2.3` branch logic does not degrade the current exact
   face-return benchmarks

### 11.5 Negative tests

Add failure-mode tests for:

- singular active-set matrix,
- `psi = 0` formal apex case:
  the correct result is branch rejection, `apex_potential_rank_deficient`, or reroute to
  `MC_TENSION_PENDING`,
- repeated-surface oscillation,
- reopened inactive surface after edge return,
- invalid branch tangent construction.

These tests matter because exact cornered plasticity often fails in branch transitions, not in the
simple face case.

---

## 12. Public semantics after Stage `2.3`

Once Stage `2.3` is implemented, the app should be able to distinguish:

- `eta_MC > 1` as exact diagnostic overstress,
- `MC_FACE` as exact single-face plasticity,
- `MC_EDGE` as exact repeated-eigenvalue corner plasticity,
- `MC_APEX` as guarded formal corner endpoint,
- `TENSION` still diagnostic-only until Stage `2.4`.

Publicly, that means:

- a plastic zone map can become more precise,
- the user can see whether yielding is occurring on a smooth face-like branch or at a cornered
  edge branch,
- the docs can stop speaking about "yielded" as one undifferentiated state.

This is a real interpretive improvement, not just an internal algorithm change.

---

## 13. Interaction with the geostatic plan

### 13.1 Why Stage `2.3` still matters even if the geostatic plan comes first

The separate plastic geostatic-initialization plan should likely be implemented before or alongside
this Stage `2.3` work because it is the bigger slope-physics improvement.

However, Stage `2.3` still matters because:

- weak slope and crest problems often localize near repeated-stress corner states,
- exact edge return is a constitutive requirement independent of the initial-phase workflow,
- the geostatic plan does not remove the need for exact corner handling.

### 13.2 Recommended sequencing

The clean sequencing is:

1. implement the plastic geostatic-initialization plan from `stage 2.2-f_MC_pl.md`,
2. implement the exact Stage `2.3` local branch logic from this note,
3. implement Stage `2.4` tension-cutoff plasticity.

If forced to choose only one immediate code step for net engineering value:

- the geostatic plan likely has the larger slope-level payoff,
- but this note is still the correct exact constitutive plan for the next local upgrade.

---

## 14. File-by-file change summary

### `src/lib/cpt-app/deformation/material-models.js`

Main work:

- split exact return into branch-aware functions,
- add repeated-subspace projector logic,
- add explicit edge and formal apex branches,
- replace generic trial-projector corner logic with exact branch-aware corner logic,
- return richer diagnostics.

### `src/lib/cpt-app/deformation/material.js`

Add corner-specific tolerances and options:

- `edgeStressGapTolerance`
- `apexStressGapTolerance`
- `eigenSubspaceTolerance`
- `activeSetComplementarityTolerance`
- `allowFormalApexBranch`

### `src/lib/cpt-app/deformation/solver.js`

Carry richer constitutive branch diagnostics into element and global summaries.

### `src/lib/cpt-app/legacy-controller.js`

Expose edge/apex branch meaning in the advanced results without overwhelming the default UI.

### `scripts/verify_deformation_phase_1.mjs`

Add local and global branch-specific exact MC regressions.

### Documentation

Update:

- `docs/deformation/MC_pl.md`
- `docs/deformation/MC.md`
- public deformation docs

to reflect the actual branch structure once implemented.

---

## 15. Acceptance criteria

Stage `2.3` should be considered complete only if:

1. exact face-return regressions still pass unchanged,
2. exact `sigma'2 = sigma'3` edge return works and is branch-stable,
3. exact `sigma'1 = sigma'2` edge return works and is branch-stable,
4. repeated-eigenvalue perturbation tests do not show branch flicker,
5. inactive-surface reopening is caught and not silently accepted,
6. local corner failure reasons are explicit and diagnosable,
7. public diagnostics can distinguish face and edge yielding,
8. the implementation remains compatible with the later Stage `2.4` tension branch.

If those conditions are not met, the work is not yet a finished Stage `2.3`.

---

## 16. Final recommendation

The right reading of the current state is:

- the app has crossed Stage `2.2` in substance,
- but its corner handling is still transitional rather than fully formalized.

So the correct `v0.4.4` planning objective is:

```text
formalize the exact local branch structure for cornered MC:
face
-> edge with repeated eigenvalues
-> formal apex endpoint
-> clean handoff to later tension-cutoff plasticity
```

This should be implemented as a branch-aware exact active-set return, not as a continued expansion
of the current generic multisurface loop.

That is the full Stage `2.3` plan.

---

## 17. References

### Internal project documents

- `docs/deformation/MC_pl.md`
- `docs/deformation/MC.md`
- `docs/deformation/ML_pl_fix.md`
- `docs/deformation/stage 2.2-f_MC_pl.md`

### External references

- Itasca documentation for classical Mohr-Coulomb principal-stress formulation and non-associated
  flow interpretation.

- Abbo, A.J. & Sloan, S.W. (1995), smooth hyperbolic approximation to Mohr-Coulomb.
  Important as the contrast to the present exact cornered plan.

- Vermeer, P.A. and related implicit-integration literature for elastoplastic finite elements.

- PLAXIS scientific and reference manuals for constitutive integration, staged analysis, and
  nonlinear FE solution strategy context.
