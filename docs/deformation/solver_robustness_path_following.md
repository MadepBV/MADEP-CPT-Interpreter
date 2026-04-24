# Solver Robustness and Path-Following Implementation Specification

**Document status:** forward implementation specification  
**Target:** current 2D small-strain effective-stress deformation solver  
**Primary goal:** increase nonlinear equilibrium-tracing robustness so the solver can continue farther along severe elastoplastic response paths before declaring loss of equilibrium  
**Secondary goal:** align the safety calculation and limit-state interpretation with a PLAXIS-like incremental multiplier workflow, while keeping the implementation mathematically explicit and auditable

---

## 1. Scope

This note defines the implementation path for a more persistent nonlinear solution strategy in the
deformation module. The intended outcome is not a cosmetic increase in iteration limits; it is a
structural upgrade of the global-local solution algorithm so that difficult self-weight,
service-loading, and c-phi reduction problems are traced with greater mathematical robustness.

The scope includes:

- global residual-based nonlinear equilibrium solution,
- globalization by residual-merit line search,
- adaptive continuation control,
- stronger local constitutive fallback,
- stronger unsymmetric global linear algebra,
- optional path-following through limit points,
- safety analysis by incremental strength reduction,
- failure-mechanism interpretation from incremental fields,
- verification and benchmarking requirements.

The scope does **not** include:

- large-deformation kinematics,
- strain-softening regularization,
- coupled consolidation,
- dynamic analysis,
- proprietary replication of commercial-code internals.

The public PLAXIS manuals describe safety as an incremental multiplier analysis with automatic load
advancement and mechanism interpretation from incremental displacements. They do not expose the full
internal nonlinear solver architecture. Accordingly, this note defines a **PLAXIS-like**
implementation path inferred from published manuals and standard nonlinear finite-element theory; it
does not claim reverse-engineering of proprietary implementation details.

---

## 2. Problem statement

The present solver is an incremental-iterative equilibrium algorithm with exact local
Mohr-Coulomb constitutive updates, but the global solution path is still bounded by explicit
continuation budgets and relatively simple globalization rules. Consequently, the solver can stop
earlier than industrial geotechnical finite-element codes when the response path develops:

- sharp active-set switching,
- near-singular elastoplastic tangents,
- severe stiffness loss,
- limit-point behavior,
- shallow tension-dominated free-surface zones,
- widespread plasticity in self-weight initialization or strength reduction.

The engineering objective is to distinguish more clearly between:

1. admissible local yielding,
2. difficult but solvable nonlinear equilibrium,
3. genuine loss of equilibrium,
4. purely algorithmic termination.

The solver must therefore be upgraded from a bounded continuation procedure to a more robust
equilibrium-path tracing algorithm.

---

## 3. Governing equations

### 3.1 Ordinary nonlinear deformation

For ordinary loading, the equilibrium problem is:

\[
\mathbf{R}(\mathbf{u},\lambda)
=
\lambda \mathbf{F}_{\mathrm{ext}}
- \mathbf{F}_{\mathrm{int}}(\mathbf{u})
=
\mathbf{0}
\]

where:

- \(\mathbf{u}\) is the global displacement vector,
- \(\lambda\) is the scalar continuation parameter,
- \(\mathbf{F}_{\mathrm{ext}}\) is the reference external load vector,
- \(\mathbf{F}_{\mathrm{int}}(\mathbf{u})\) is the assembled internal force vector.

The global Newton linearization is:

\[
\mathbf{K}_t(\mathbf{u}_k)\,\delta \mathbf{u}_k
=
\mathbf{R}_k
\]

with:

\[
\mathbf{K}_t
=
\frac{\partial \mathbf{F}_{\mathrm{int}}}{\partial \mathbf{u}}
\]

formed from the exact or fallback algorithmic material tangent at the current local states.

### 3.2 Strength-reduction safety analysis

For safety analysis by c-phi reduction, the equilibrium problem is:

\[
\mathbf{R}(\mathbf{u},\Sigma M_{sf})
=
\mathbf{F}_{\mathrm{fixed}}
- \mathbf{F}_{\mathrm{int}}(\mathbf{u}; \Sigma M_{sf})
=
\mathbf{0}
\]

with fixed actions and reduced material strength:

\[
c_r = \frac{c}{\Sigma M_{sf}}
\]

\[
\tan \phi_r = \frac{\tan \phi}{\Sigma M_{sf}}
\]

\[
\phi_r = \arctan \left(\frac{\tan \phi}{\Sigma M_{sf}}\right)
\]

\[
\tan \psi_r = \frac{\tan \psi}{\Sigma M_{sf}}
\]

\[
\psi_r = \arctan \left(\frac{\tan \psi}{\Sigma M_{sf}}\right)
\]

\[
\sigma_{t,r} = \frac{\sigma_t}{\Sigma M_{sf}}
\]

subject to:

\[
\psi_r \le \phi_r
\]

and, when tension cut-off is enabled,

\[
\sigma_{t,r} \le \frac{c_r}{\tan \phi_r}
\qquad
(\phi_r > 0)
\]

The reported factor of safety is identified from the critical multiplier:

\[
F_s = \Sigma M_{sf,\mathrm{crit}}
\]

In a bracketed search, the conservative reported value should be the highest converged lower bound.

### 3.3 Residual-merit globalization

Global step acceptance should be based on the residual-merit function:

\[
\Phi(\mathbf{u},\lambda)
=
\frac{1}{2}
\left\|
\mathbf{R}(\mathbf{u},\lambda)
\right\|_2^2
\]

Given a Newton or augmented Newton search direction \((\delta \mathbf{u}, \delta \lambda)\), the
accepted line-search factor \(\alpha \in (0,1]\) should satisfy an Armijo-type decrease condition:

\[
\Phi(\mathbf{u} + \alpha \delta \mathbf{u}, \lambda + \alpha \delta \lambda)
\le
\Phi(\mathbf{u},\lambda)
-
\eta \alpha
\left\|
\mathbf{R}(\mathbf{u},\lambda)
\right\|_2^2
\]

with \(0 < \eta \ll 1\).

This is the correct globalization object for the global equilibrium problem. It is preferable to
heuristic residual-improvement tests because it supplies a mathematically explicit acceptance rule.

### 3.4 Arc-length path following

When the equilibrium path approaches a limit point, load control alone becomes inadequate. A
standard cylindrical arc-length formulation introduces the auxiliary constraint:

\[
g(\Delta \mathbf{u}, \Delta \lambda)
=
\Delta \mathbf{u}^T \mathbf{W} \Delta \mathbf{u}
+
\alpha_{\lambda}^2
\Delta \lambda^2
\mathbf{F}_{\mathrm{ext}}^T \mathbf{W} \mathbf{F}_{\mathrm{ext}}
-
\Delta s^2
=
0
\]

and solves the augmented Newton system:

\[
\begin{bmatrix}
\mathbf{K}_t & -\mathbf{F}_{\mathrm{ext}} \\
\partial g / \partial \mathbf{u} & \partial g / \partial \lambda
\end{bmatrix}
\begin{bmatrix}
\delta \mathbf{u} \\
\delta \lambda
\end{bmatrix}
=
\begin{bmatrix}
\mathbf{R} \\
-g
\end{bmatrix}
\]

The sign convention matches §3.1: with \(\mathbf{R} = \lambda \mathbf{F}_{\mathrm{ext}} - \mathbf{F}_{\mathrm{int}}\),
Newton linearization of equilibrium gives \(\mathbf{K}_t \delta \mathbf{u} - \mathbf{F}_{\mathrm{ext}} \delta \lambda = \mathbf{R}\),
which reduces to \(\mathbf{K}_t \delta \mathbf{u} = \mathbf{R}\) in the load-controlled limit \(\delta \lambda = 0\).
The arc-length row is the Newton correction of the constraint equation \(g = 0\), hence the right-hand side \(-g\).

This should be introduced only after the ordinary load-controlled continuation is upgraded, because
arc-length is not a substitute for weak local or global Newton infrastructure.

---

## 4. Required failure taxonomy

The implementation must stop treating all non-converged states as one class. The solver shall
distinguish at least the following outcomes:

1. `equilibrium-converged`
2. `mechanism-developed`
3. `local-constitutive-failure`
4. `global-linear-solve-failure`
5. `line-search-stall`
6. `step-budget-exhausted`
7. `step-below-minimum`
8. `arc-length-limit-point-not-resolved`
9. `no-failure-found` for safety runs that remain stable up to the target multiplier

This taxonomy is essential for engineering interpretation. A local active-set failure, a Krylov
breakdown, and a true equilibrium loss are not the same physical statement and must not be
presented to the user as the same result.

---

## 5. Global solution strategy

### 5.1 Stage A: residual-merit line search

The present solver should first be upgraded to a proper residual-merit globalization.

Implementation requirements:

- retain the exact elastoplastic tangent as the primary linearization,
- compute the search direction from the current tangent system,
- evaluate trial states only through the actual global residual,
- accept a trial factor only if the Armijo decrease condition on \(\Phi\) is satisfied,
- record the accepted \(\alpha\), rejected \(\alpha\), and the resulting residual decrease.

This stage replaces ad hoc damping rules with an explicit optimization-based acceptance test.

### 5.2 Stage B: adaptive continuation control

The current fixed multiplicative growth and cutback should be replaced by a controller that responds
to observed nonlinear difficulty. A suitable update rule is:

\[
\Delta \lambda_{n+1}
=
\operatorname{clip}
\left[
\Delta \lambda_n
\left(\frac{N_{\mathrm{target}}}{N_n}\right)^{\beta}
\left(\frac{\alpha_n}{\alpha_{\mathrm{target}}}\right)^{\gamma},
\Delta \lambda_{\min},
\Delta \lambda_{\max}
\right]
\]

where:

- \(N_n\) is the Newton iteration count of the accepted step,
- \(N_{\mathrm{target}}\) is the target effort per accepted step,
- \(\alpha_n\) is the accepted line-search factor,
- \(\alpha_{\mathrm{target}}\) is the desired level of undamped acceptance,
- \(\beta\) and \(\gamma\) are controller exponents.

Separate controllers are required for:

- service loading,
- plastic geostatic correction,
- safety multiplier progression.

The key principle is that step size must react to measured nonlinear difficulty, not only to binary
accept or reject outcomes.

### 5.3 Stage C: stronger unsymmetric global linear algebra

The exact non-associated Mohr-Coulomb tangent is unsymmetric. The solver must therefore treat the
global tangent as unsymmetric by default whenever the exact Stage 2 route is active.

Required upgrades:

- preserve unsymmetric assembly,
- retain BiCGStab as a baseline option,
- add a stronger unsymmetric Krylov option such as GMRES or BiCGStab(l),
- add row and column scaling,
- add an ILU or ILUT-type preconditioner if feasible,
- keep the architecture open to a future sparse-direct unsymmetric solver path.

This is one of the most important differences between research-quality robustness and a minimal
incremental-iterative implementation.

### 5.4 Stage D: local constitutive fallback

The exact Stage 2 active-set return remains the primary local algorithm. However, if branch
selection fails or the local coupling matrix becomes singular, the solver should not immediately
declare the global step failed.

Define the local unknown vector as:

\[
\mathbf{z}
=
[\sigma_1,\sigma_2,\sigma_3,\Delta \lambda_1,\ldots,\Delta \lambda_m]^T
\]

and solve the local constitutive equations as a trust-region or damped least-squares problem:

\[
\min_{\delta \mathbf{z}}
\left\|
\mathbf{f}_{\mathrm{local}}(\mathbf{z})
+
\mathbf{J}_{\mathrm{local}}(\mathbf{z}) \delta \mathbf{z}
\right\|_2
\qquad
\text{subject to}
\qquad
\|\delta \mathbf{z}\|_{\mathbf{M}} \le \Delta
\]

Only if both:

1. the exact active-set solve, and
2. the fallback local nonlinear solve

fail, should the global step be rejected for constitutive reasons.

This preserves the exact active-set route as the preferred method while adding a mathematically
defensible recovery procedure for difficult branch transitions.

### 5.5 Stage E: optional arc-length path following

Arc-length should be introduced only after Stages A-D are in place. It should not replace standard
load control globally; instead it should be activated selectively when diagnostics indicate
approaching limit-point behavior:

- repeated cutbacks,
- very small accepted continuation steps,
- persistent residual decrease without acceptance of the target load step,
- deteriorating tangent conditioning,
- evidence of snap-through or snap-back behavior.

The recommended sequence is:

1. predictor step along the tangent path,
2. augmented Newton correction on equilibrium plus arc-length constraint,
3. Armijo line search on the augmented residual merit,
4. adaptive update of the arc-length radius \(\Delta s\).

Arc-length should first be enabled for:

- difficult service-loading phases,
- difficult safety analyses,
- optionally research mode for plastic geostatic equilibration.

It should not be introduced as the default mode for every routine problem.

---

## 6. Safety analysis architecture

### 6.1 Governing principle

Safety shall be treated as a **new nonlinear phase** that starts from a converged base state:

- plastic geostatic equilibrium for self-weight-only safety,
- converged end-of-service state for loaded safety.

The actions remain fixed during safety. Only strength is reduced.

### 6.2 Incremental multiplier workflow

A PLAXIS-like workflow is:

1. initialize \(\Sigma M_{sf} = 1\),
2. choose an initial multiplier increment \(\Delta \Sigma_0\),
3. solve the reduced-strength equilibrium problem at the target multiplier,
4. automatically grow or cut back \(\Delta \Sigma\) based on difficulty,
5. monitor incremental mechanism development,
6. stop when the critical multiplier is bracketed or when a multiplier plateau is detected.

The safety phase must store, for each accepted state:

- committed multiplier \(\Sigma M_{sf}\),
- accepted and rejected continuation counts,
- incremental displacement field \(\Delta \mathbf{u}\),
- incremental equivalent plastic strain field,
- incremental plastic work,
- counts of active yield states and tension-cut-off-active states.

### 6.3 Mechanism-based safety interpretation

The safety mechanism must be interpreted from **incremental** fields, not total displacements. This
is critical. Total displacement can contain large pre-failure history, rigid-body components, or
benign gradual settlement. The failure mechanism is reflected in the localized incremental response.

Suitable incremental mechanism measures include:

- \(\|\Delta \mathbf{u}\|\),
- incremental equivalent plastic strain \(\Delta \bar{\varepsilon}^p\),
- incremental plastic work,
- connected bands extracted from these fields.

### 6.4 Failure criterion in safety mode

Safety failure should not be equated with the first rejected substep. The implementation should
track a lower and upper bracket:

\[
\Sigma M_{sf,\mathrm{lower}} < \Sigma M_{sf,\mathrm{crit}} < \Sigma M_{sf,\mathrm{upper}}
\]

and may additionally recognize a plateau criterion:

\[
\frac{
\left|
\Sigma M_{sf}^{(k)} - \Sigma M_{sf}^{(k-1)}
\right|
}{
\Sigma M_{sf}^{(k)}
}
<
\varepsilon_{\Sigma}
\]

for several consecutive accepted states, while a mechanism indicator continues to grow:

\[
\|\Delta \mathbf{u}^{(k)}\| > \|\Delta \mathbf{u}^{(k-1)}\|
\quad \text{or} \quad
\max(\Delta \bar{\varepsilon}^{p,(k)}) > \max(\Delta \bar{\varepsilon}^{p,(k-1)})
\]

The conservative reported factor of safety should remain the converged lower bound unless the user
explicitly requests a midpoint or refined estimate.

---

## 7. Repository implementation map

### 7.1 `src/lib/cpt-app/deformation/solver.js`

This module must carry the main global strategy upgrades:

- residual-merit evaluation,
- Armijo line search,
- adaptive continuation controller,
- solver-outcome taxonomy,
- optional arc-length phase mode,
- safety incremental multiplier loop,
- checkpointing and mechanism history storage.

Required structural additions:

- `evaluateResidualMerit(...)`
- `performArmijoLineSearch(...)`
- `updateContinuationStepPI(...)`
- `solvePhaseWithArcLength(...)`
- `classifySolverOutcome(...)`
- `extractIncrementalMechanismMetrics(...)`

### 7.2 `src/lib/cpt-app/deformation/material-models.js`

This module remains responsible for the local constitutive integration and must be extended with:

- local fallback root solve for failed exact active sets,
- consistent tangent semantics under fallback,
- branch-quality diagnostics,
- explicit classification of local failure causes.

Required additions:

- `solveLocalMcFallbackTrustRegion(...)`
- `classifyLocalReturnFailure(...)`
- `buildFallbackConsistentTangent(...)`

### 7.3 `src/lib/cpt-app/deformation/material.js`

This module should continue to host the safety-strength transformation and must remain the single
source of truth for reduced parameters:

- `c_r`,
- `phi_r`,
- `psi_r`,
- `sigma_t,r`.

Any safety reduction logic must stay centralized here rather than being re-derived in the solver.

### 7.4 `src/lib/cpt-app/legacy-controller.js`

The controller must expose the solver outcomes and safety semantics without conflating them:

- distinguish non-convergence classes in user messages,
- distinguish total and incremental safety fields,
- expose `FoS_lower`, `FoS_upper`, and retained strength,
- show mechanism fields derived from incremental response,
- avoid displaying local `eta_MC = 1` as equivalent to global failure.

### 7.5 `scripts/verify_deformation_phase_1.mjs`

The verification suite must be expanded so that solver robustness changes are tested
quantitatively, not only qualitatively.

New regression classes are required for:

- line-search acceptance on difficult elastoplastic steps,
- adaptive continuation behavior under mild and severe nonlinearity,
- preservation of unsymmetric tangent behavior,
- successful fallback after exact active-set failure,
- safety lower/upper bracketing,
- incremental mechanism growth near failure,
- arc-length traversal through a limit point on a benchmark problem.

---

## 8. Pseudocode principles

### 8.1 Generic nonlinear phase

```text
initialize committed state (u_n, state_n, lambda_n)
initialize continuation controller

while target not reached:
  choose target increment Δlambda from adaptive controller
  form predictor state

  for Newton iteration k = 1..kmax:
    assemble residual R and tangent K_t
    perform local constitutive updates

    if a local update fails:
      try local fallback constitutive solve
      if fallback fails:
        reject the continuation step
        break

    if convergence criteria are satisfied:
      accept the step
      commit global and local states
      update controller statistics
      break

    solve the global linearized system for the search direction
    if the linear solve is unacceptable:
      reject the continuation step
      break

    line search on residual merit Phi = 0.5 ||R||^2
    if no acceptable alpha exists:
      reject the continuation step
      break

    update the trial state with alpha times the search direction

  if the step was rejected:
    cut back the continuation increment
    if the new increment is below the minimum or retry budget is exhausted:
      terminate with a classified solver outcome
```

### 8.2 Safety phase by incremental multipliers

```text
construct the converged base state
SigmaMsf = 1
DeltaSigma = DeltaSigma0
initialize lower and upper safety bounds

while safety search is active:
  target multiplier = SigmaMsf + DeltaSigma
  reduce material strengths to the target multiplier
  solve the reduced-strength equilibrium problem

  if converged:
    accept the multiplier
    store incremental displacements and mechanism fields
    update the lower safety bound
    adapt DeltaSigma upward or downward from measured difficulty
    if the multiplier plateaus while the mechanism grows:
      declare mechanism-developed
      stop
  else:
    update the upper safety bound if this is the first failure
    cut back DeltaSigma
    if DeltaSigma falls below the minimum:
      stop with the current bracket
```

### 8.3 Arc-length corrector

```text
form the tangent predictor direction
choose the sign of DeltaLambda from the continuation direction
construct the augmented system for equilibrium plus arc-length

for Newton iteration k = 1..kmax:
  assemble the augmented residual
  solve for (delta_u, delta_lambda)
  line search on the augmented residual merit
  update the trial point
  if both equilibrium and arc-length constraints converge:
    accept the step
    update the arc-length radius
    break

if no converged augmented solution is found:
  cut back the arc-length radius or return to load control fallback
```

---

## 9. Verification and benchmark program

The following benchmarks should be mandatory before the upgraded solver is accepted as production
quality:

1. Homogeneous self-weight slope with no surcharge.
2. Homogeneous slope with surcharge.
3. Flat foundation problem with service loading well below failure.
4. Embankment with shallow crest plasticity and tension-cut-off activation.
5. Self-weight-only safety analysis with no external surcharge.
6. Loaded safety analysis starting from a converged service state.
7. A benchmark known to exhibit a limit point or near-peak response.

For each benchmark, record:

- continuation steps,
- rejected steps,
- Newton iterations,
- line-search factors,
- Krylov or direct-solver effort,
- local fallback frequency,
- mechanism metrics,
- final solver outcome class.

The comparison criteria are:

- convergence robustness,
- mechanism plausibility,
- sensitivity to mesh refinement,
- consistency of the reported factor of safety,
- consistency with classical reference solutions or published finite-element benchmarks.

---

## 10. Implementation order

The recommended development order is:

1. failure taxonomy and solver instrumentation,
2. residual-merit Armijo line search,
3. adaptive continuation controller,
4. stronger unsymmetric global linear algebra,
5. local constitutive fallback solver,
6. safety incremental multiplier workflow with mechanism-based interpretation,
7. optional arc-length path following,
8. higher-order elements and further discretization upgrades.

Arc-length should **not** be implemented first. If the ordinary local-global Newton path is still
too brittle, arc-length will only increase complexity while obscuring the real failure modes.

---

## 11. References

1. Seequent. *PLAXIS 2D Tutorial Manual*. Safety analysis chapters and interpretation of
   incremental displacements.
2. Seequent. *PLAXIS 3D Reference Manual*. Safety calculation, incremental multipliers, and load
   advancement procedures.
3. Crisfield, M. A. (1981). A fast incremental/iterative solution procedure that handles
   "snap-through". *Computers & Structures*, 13(1-3), 55-62.
   https://doi.org/10.1016/0045-7949(81)90108-5
4. Crisfield, M. A. (1983). An arc-length method including line searches and accelerations.
   *International Journal for Numerical Methods in Engineering*, 19(9), 1269-1289.
   https://doi.org/10.1002/nme.1620190902
5. Sloan, S. W., Abbo, A. J., and Sheng, D. (2001). Refined explicit integration of
   elastoplastic models with automatic error control. *Engineering Computations*, 18(1-2),
   121-154.
6. Simo, J. C., and Taylor, R. L. (1985). Consistent tangent operators for rate-independent
   elastoplasticity. *Computer Methods in Applied Mechanics and Engineering*, 48(1), 101-118.
   https://doi.org/10.1016/0045-7825(85)90070-2
7. de Borst, R. (1987). Computation of post-bifurcation and post-failure behavior of
   strain-softening solids. *Computers & Structures*, 25(2), 211-224.
   https://doi.org/10.1016/0045-7949(87)90144-1
8. Griffiths, D. V., and Lane, P. A. (1999). Slope stability analysis by finite elements.
   *Géotechnique*, 49(3), 387-403.
   https://doi.org/10.1680/geot.1999.49.3.387
9. Dawson, E. M., Roth, W. H., and Drescher, A. (1999). Slope stability analysis by strength
   reduction. *Géotechnique*, 49(6), 835-840.
   https://doi.org/10.1680/geot.1999.49.6.835
10. Zhang, X., Sheng, D., Sloan, S. W., and Wang, D. (2021). A line-search-based stress
    integration algorithm for elastoplastic soil models. *Computers and Geotechnics*, 133,
    104592. https://doi.org/10.1016/j.compgeo.2021.104592
