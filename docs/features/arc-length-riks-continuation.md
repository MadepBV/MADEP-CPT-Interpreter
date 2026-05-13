# Feature: Arc-Length/Riks Continuation

Status: design
Target area: WASM deformation solver, nonlinear continuation, safety analysis
Target runtime: WASM CPU solver first
Related feature: production SigmaMsf safety reduction

## Purpose

The current nonlinear solver is a load-control and strength-control continuation
solver. It prescribes a target load factor or target `SigmaMsf`, then uses Newton
iterations to find equilibrium at that prescribed continuation point.

That works well while the equilibrium path is regular. It can fail too early
near limit points, snap-through, snap-back, or highly plastic softening because
the prescribed control variable becomes a poor path parameter.

Arc-length/Riks continuation adds an augmented equilibrium solve where the
displacement increment and continuation increment are solved together. The goal
is not to make every invalid model converge. The goal is to follow physically
meaningful equilibrium paths farther and classify failure more reliably.

## Why We Do Not Have It Yet

Arc-length is not a smaller step size and it is not a line-search option. It
changes the nonlinear system.

The current solver solves:

```text
R(u, lambda) = 0
```

with `lambda` prescribed by the outer continuation loop.

Arc-length solves:

```text
R(u, lambda) = 0
g(delta_u, delta_lambda) = 0
```

where both `u` and `lambda` are unknowns. This requires:

- an augmented Newton system,
- a constraint equation,
- a tangent direction predictor,
- a derivative of the residual with respect to the continuation variable,
- path direction control,
- adaptive arc-length radius,
- new convergence and failure criteria,
- new result history for the safety curve,
- careful interaction with plastic return mapping and active-set warm starts.

The recent WASM work focused on making the CPU path logically match the existing
JS solver first. Adding arc-length before that parity work would have mixed two
separate problems: solver correctness and a new continuation formulation.

## Scope

Implement arc-length in WASM for:

- service load continuation,
- c-phi safety reduction through `SigmaMsf`,
- Mohr-Coulomb plasticity with unsymmetric tangents,
- the production safety curve and finalization methodology.

Do not implement it for GPU paths in this phase.

Do not use it as a silent replacement for every analysis. It should be selected
by solver strategy:

```ts
requestedContinuationMode:
  | 'load-control'
  | 'strength-control'
  | 'arc-length'
  | 'auto'
```

`auto` is a request, not an executed step mode. Result records must store the
actual mode used for each accepted or rejected step:

```ts
type ActualContinuationMode =
  | 'load-control'
  | 'strength-control'
  | 'arc-length';
```

Recommended production behavior:

- default service solve: current load/strength control,
- default safety solve: current strength control first,
- automatic fallback to arc-length when the safety path approaches a limit point
  or repeated cutbacks indicate that prescribed `SigmaMsf` control is failing.

## Mathematical Formulation

Let:

```text
u       = free displacement vector
lambda  = continuation variable
R       = external force - internal force
K       = dR/du with sign convention consistent with current solver assembly
R_lam   = dR/dlambda
```

For load control:

```text
R(u, lambda) = lambda * F_ref - F_int(u)
R_lam        = F_ref
```

For safety strength reduction:

```text
R(u, lambda) = F_service - F_int(u, material(lambda))
R_lam        = -dF_int/dlambda
```

For `SigmaMsf` safety:

```text
SigmaMsf(lambda) = SigmaMsf_start
                 + lambda * (SigmaMsf_target - SigmaMsf_start)
```

For full arc-length safety search, the continuation variable may represent the
absolute `SigmaMsf`, but the admissible domain is still:

```text
SigmaMsf(lambda) >= 1
```

Any trial that would evaluate reduced strength below `SigmaMsf = 1` is invalid
and must be cut back or projected to the admissible boundary before material
assembly. The shared strength-reduction primitives must remain the single source
of truth.

The arc-length constraint is:

```text
g(delta_u, delta_lambda) =
  || W * delta_u ||^2
  + alpha^2 * delta_lambda^2
  - delta_s^2
  = 0
```

Where:

- `W` scales displacement DOFs so the norm is unit-consistent,
- `alpha` scales the continuation variable relative to displacement,
- `delta_s` is the arc-length radius.

The augmented Newton system is:

```text
[ K      R_lam ] [ correction_u      ] = [ -R ]
[ g_u    g_lam ] [ correction_lambda ]   [ -g ]
```

Dimensions:

```text
K      in R^(n x n)
R_lam  in R^(n x 1)
g_u    in R^(1 x n)
g_lam  in R
R      in R^(n x 1)
g      in R
```

`g_u` is a row vector in the augmented system. Do not assemble it as the
transpose column block.

Because the Mohr-Coulomb tangent can be unsymmetric, the linear solves must
continue to use GMRES for plastic phases. Do not symmetrize plastic tangents to
make the augmented solve easier.

## Practical Corrector Implementation

Avoid assembling a physically larger augmented sparse matrix at first. Use the
standard two-solve arc-length corrector.

At each Newton correction:

```text
K * du_R   = -R
K * du_lam = -R_lam
```

Then compute `dlam` from the linearized constraint:

```text
g_u * (du_R + dlam * du_lam) + g_lam * dlam = -g

dlam = (-g - g_u * du_R) / (g_u * du_lam + g_lam)
du   = du_R + dlam * du_lam
```

This reuses the existing matrix assembly, preconditioner, and GMRES path. It
requires two linear solves with the same tangent per Newton iteration.

If the denominator is too small, classify the correction as ill-conditioned and
cut back the arc-length radius.

## Predictor

The predictor chooses the first direction for a new arc-length step.

Load-control predictor:

```text
K * phi = F_ref
```

Safety predictor:

```text
K * phi = -R_lam
```

Normalize:

```text
scale = delta_s / sqrt(||W * phi||^2 + alpha^2)
delta_u_predictor      = scale * phi
delta_lambda_predictor = scale
```

Choose the sign so the new predictor follows the previous converged path:

```text
dot_path =
  dot(W * delta_u_predictor, W * previous_delta_u)
  + alpha^2 * delta_lambda_predictor * previous_delta_lambda

if dot_path < 0:
  flip predictor sign
```

On the first arc-length step within a phase, the previous path increment is not
defined. Force `delta_lambda_predictor > 0` for that first step:

- load-control: load increases,
- safety reduction: `SigmaMsf` increases.

Apply the path-sign dot-product rule from the second accepted arc-length step
onward. A first safety predictor must never drive `SigmaMsf` toward the
inadmissible region below `1`.

For safety reduction, initial production mode should prefer increasing
`SigmaMsf`. Post-peak decreases in `SigmaMsf` may be useful for diagnostics, but
the reported FoS remains the conservative stable peak/lower-bound value.

## Residual Derivative With Respect To Safety Strength

For load control, `R_lam` is simple. For c-phi safety, it is not.

The residual derivative must account for the fact that material strength changes
with `SigmaMsf`:

```text
R_lam = -dF_int/dSigmaMsf
```

Implementation options:

### Option A: Verified Finite Difference

Compute:

```text
R_lam ~= (R(u, SigmaMsf + h) - R(u, SigmaMsf - h)) / (2h)
```

Use this central form only when both probes stay in the admissible domain
`SigmaMsf >= 1`. At `SigmaMsf = 1`, or whenever the lower probe would fall below
`1`, use the forward-only form specified in Phase 4.

Use the same committed material state for both probes and do not commit probe
states.

Pros:

- fastest route to a correct implementation,
- excellent for validating the analytic derivative,
- lower risk of deriving the wrong plastic tangent-strength coupling.

Cons:

- requires two extra residual assemblies per Newton iteration,
- expensive,
- probe return mapping must be carefully isolated.

### Option B: Analytic Material-Strength Derivative

Derive and assemble `dF_int/dSigmaMsf` from each Gauss point.

Pros:

- production performance,
- avoids extra assemblies,
- cleaner long-term implementation.

Cons:

- difficult for multisurface plasticity,
- must include face, edge, apex, tension cutoff, and smooth fallback regimes,
- easy to get wrong without a finite-difference oracle.

Required approach:

1. Implement finite-difference `R_lam` first behind the arc-length feature.
2. Build tests that compare analytic derivatives against finite differences.
3. Add analytic derivative only after the finite-difference path is validated.
4. Keep finite difference as a debug verifier, not as the default forever.

This is the non-compromised route: correctness first, then performance.

## Scaling

Bad scaling makes arc-length unstable. The solver must not use an unscaled raw
Euclidean displacement norm as the only production choice.

Recommended displacement scaling:

```text
W_i = 1 / max(modelLength, 1)
```

for translational DOFs.

Recommended initial `alpha`:

```text
alpha = targetDisplacementPerSigmaMsf
```

Estimate from the last stable strength-control steps:

```text
epsSigma = max(1e-6 * max(SigmaMsf, 1), 1e-6)

alpha =
  median(||W * delta_u|| / max(abs(deltaSigmaMsf), epsSigma))
```

Clamp:

```text
alphaMin <= alpha <= alphaMax
```

If no history exists, initialize from model size and expected safety increment:

```text
delta_s_initial = 1e-4 to 1e-3
deltaSigma_initial = 0.02 to 0.05
```

These defaults must be calibrated on project fixtures.

## Adaptive Arc-Length Radius

The radius must adapt based on Newton performance.

Inputs:

- nonlinear iteration count,
- line-search scale,
- residual reduction,
- active-set changes,
- correction denominator quality,
- plastic return mapping failures.

Initial policy:

```text
if step converged fast and active set stable:
  delta_s *= growthFactor

if step required many iterations, line search cut back, or active set changed:
  delta_s *= shrinkFactor

if step failed:
  reject step
  restore committed state
  delta_s *= failureShrinkFactor
  retry
```

Recommended bounds:

```text
delta_s_min
delta_s_max
maxArcLengthRetries
targetNewtonIterations
```

The retry loop must restore:

- displacement vector,
- material point committed state,
- previous-trial warm-start state,
- active-set diagnostics,
- continuation variables.

## State Management

Arc-length adds one more state dimension. Treat it as committed solver state, not
as a local temporary.

Required state:

```ts
type ArcLengthState = {
  lambda: number;
  sigmaMsf: number;
  deltaS: number;
  alpha: number;
  previousDeltaU: Float64Array;
  previousDeltaLambda: number;
  stepIndex: number;
  acceptedStepCount: number;
  rejectedStepCount: number;
};
```

Material state rules:

- A trial correction may update trial material points.
- A rejected arc-length step must restore the last committed material points.
- A converged arc-length step commits material points and previous-trial hints.
- Finite-difference `R_lam` probes must never overwrite trial or committed state.
- Smooth-fallback local return mode retention must continue to work.

## Interaction With Line Search

Line search remains useful, but it must preserve the arc-length constraint.

Acceptable first implementation:

- Use the arc-length corrector to compute `(du, dlam)`.
- Apply a scalar line-search scale `eta` to both:

```text
u_trial      = u_current + eta * du
lambda_trial = lambda_current + eta * dlam
```

- Recompute residual and constraint merit.
- Accept if the combined merit decreases.

For arc-length curve points, `lineSearchAcceptedScale` is this joint scalar
`eta`. For non-arc-length points, `lineSearchAcceptedScale` remains the existing
Armijo scale applied to the displacement correction.

Combined merit:

```text
merit = 0.5 * ||R||^2 + beta * 0.5 * g^2
```

`beta` must scale the constraint term so it is comparable to the residual term.

Long-term improvement:

- Add a trust-region style correction if line search repeatedly violates the
  constraint.

## Convergence Criteria

An arc-length step converges when:

- residual norm satisfies the existing force tolerance,
- displacement correction satisfies the existing displacement tolerance,
- arc-length constraint residual satisfies `arcLengthConstraintTolerance`,
- active set is stable when the material model requires it,
- local return mapping has no unresolved failures.

Do not accept a step based only on the arc-length constraint. Equilibrium remains
the primary requirement.

## Safety Finalization With Arc-Length

Arc-length should feed the production `SigmaMsf` safety methodology.

The safety curve should include every accepted arc-length step:

```text
u versus SigmaMsf
```

The reported FoS remains:

```text
max stable lower-bound SigmaMsf before mechanism plateau or bracketed failure
```

If arc-length follows a post-peak path where `SigmaMsf` decreases with increasing
displacement:

- keep displaying the post-peak path as diagnostic information,
- report the peak stable `SigmaMsf` as the safety factor,
- mark the peak on the curve,
- do not report a lower post-peak `SigmaMsf` as the FoS.

## Auto-Fallback Criteria

In `auto` mode, enter arc-length when prescribed strength control shows signs of
approaching a limit point.

Triggers:

- repeated cutbacks below `minLoadStep * 4`,
- repeated line-search stalls,
- active set keeps changing near the same `SigmaMsf`,
- residual decreases poorly while displacement increment grows,
- safety curve slope indicates a plateau,
- upper-bound failure is suspected but mechanism evidence is incomplete.

Cutback triggers are measured in the active continuation parameter `lambda`, not
directly in absolute `SigmaMsf`. In safety mode, `lambda` maps to `SigmaMsf`
through the current trial interval, so comparing `deltaSigmaMsf` directly to
`minLoadStep * 4` is a different trigger and must not be used for this rule.

The fallback should start from the last stable safety checkpoint, not from a
failed trial state.

## Data Contract

Arc-length must not introduce a second per-step history for safety states. The
production safety feature owns the canonical `SafetyCurvePoint` record. When a
safety step is solved with arc-length, attach arc-length-specific details to
that same curve point.

Reserve `WIRE_VERSION = 8` for arc-length additions after the safety-curve
contract in `WIRE_VERSION = 7`.

Arc-length wire work must not start before the `WIRE_VERSION = 7` safety-curve
contract is merged. Version 8 is an extension of version 7, not a replacement
that skips it.

Shared mode types:

```ts
type RequestedContinuationMode =
  | 'load-control'
  | 'strength-control'
  | 'arc-length'
  | 'auto';

type ActualContinuationMode =
  | 'load-control'
  | 'strength-control'
  | 'arc-length';

type ArcLengthStepDetails = {
  actualContinuationMode: 'arc-length';
  deltaLambda: number;
  deltaS: number;
  alpha: number;
  constraintResidual: number;
  linearSolveCount: number;
  correctionDenominator: number;
  failureCode: number;
};
```

For safety curve points, `SafetyCurvePoint.linearIterations` is the total number
of linear iterations across all arc-length corrector solves. It is not repeated
inside `ArcLengthStepDetails`.

`SafetyCurvePoint.arcLengthDetails !== null` if and only if the accepted point
used `actualContinuationMode === 'arc-length'`.

Non-safety arc-length phases may emit a compact phase history, but the record
must still use numeric failure/status enums. Fixed-width WASM records must not
contain strings. JS-side decoders map numeric failure codes to labels.

## Implementation Plan

### Phase 1: Refactor Continuation Boundaries

Goal: isolate control strategy from assembly and material update.

Binding resolution for the Phase-1 implementation:

- Phase 1 is a no-behavior-change refactor. It must not add arc-length options,
  result fields, or wire records.
- Safety strength continuation remains the current `lambda -> SigmaMsf`
  interpolation; the refactor only moves the per-step material reduction into a
  named boundary helper.
- Linear solve dispatch is isolated behind a helper that preserves the existing
  CG/GMRES decision. Unsymmetric plastic tangents continue to use GMRES.
- The current load-control and strength-control continuation controller remains
  the executed controller until Phase 2 introduces disabled arc-length state.

Tasks:

- Split `run_nonlinear_phase` into:
  - phase setup,
  - residual/tangent assembly,
  - linear solve,
  - Newton correction,
  - continuation controller.
- Preserve current load/strength-control behavior exactly.
- Add tests to prove no result drift before arc-length is enabled.

Validation:

- Existing WASM tests and reference cases match previous output.
- Current safety lower/upper brackets are unchanged.
- No wire-format change is allowed in this phase unless the decoder is updated
  in the same commit and versioned explicitly.

### Phase 2: Add Arc-Length State And Predictor

Goal: support accepted/rejected arc-length steps without changing material
behavior.

Binding resolution for the Phase-2 implementation:

- Arc-length remains disabled as an executed continuation controller in this
  phase. The current controller still records actual mode as load-control for
  service/geostatic phases and strength-control for safety.
- `requestedContinuationMode` and `arcLengthDerivativeMode` are encoded through
  the two reserved v7 input-header mode bytes. This does not change output
  records and does not bump the output wire version.
- Numeric arc-length tuning options are normalized in JS and stored with C++
  defaults, but the v7 WASM input does not yet transmit them. The default
  predictor shell is therefore the only Phase-2 C++ consumer.
- The first-step predictor sign rule is binding: if no previous accepted
  arc-length step exists, the predictor must force `deltaLambda > 0`; later
  steps use the path dot product.

Tasks:

- Add `ArcLengthState`.
- Add arc-length solver options.
- Implement predictor direction for load control.
- Implement path sign selection.
- Implement radius adaptation shell.
- Store requested mode and actual mode separately.

Validation:

- Linear-elastic load-control model follows the same path as prescribed load
  control.
- Rejected steps restore state exactly.
- A result record never stores `auto` as the actual continuation mode.

### Phase 3: Implement Corrector With Two Linear Solves

Goal: solve the augmented correction without assembling a larger matrix.

Binding resolution for the Phase-3 implementation:

- The reusable corrector follows the current WASM solver sign convention:
  the first solve uses the current residual RHS that the existing Newton path
  already solves, and the second solve uses a caller-supplied continuation RHS.
  For load control that RHS is the reference external load vector.
- The helper returns numeric failure codes only:
  `0=ok`, `1=residual-solve-failed`, `2=continuation-solve-failed`,
  `3=ill-conditioned-denominator`, `4=non-finite-correction`.
- The production load/strength-control controller is still the only executed
  controller in this phase. Arc-length execution is introduced only after the
  safety derivative and result-record contracts are available.

Tasks:

- Reuse the existing tangent matrix.
- Solve `K * du_R = -R`.
- Solve `K * du_lam = -R_lam`.
- Compute `dlam` from the linearized constraint.
- Apply combined line search to `(du, dlam)`.
- Track constraint residual.

Validation:

- Scalar nonlinear spring with a known limit point is followed past peak.
- The same implementation works with symmetric and unsymmetric linear solvers.

### Phase 4: Add Safety `R_lam`

Goal: make arc-length work for `SigmaMsf` strength reduction.

Binding resolution for the Phase-4 implementation:

- The finite-difference oracle computes `R_lam = dR/dSigmaMsf` in absolute
  `SigmaMsf`, and also returns `-R_lam` as the continuation RHS for the
  existing two-solve corrector.
- The oracle uses local copies for probe material states and local residual
  buffers. Returning from the oracle must leave committed material points,
  trial material points, displacement, tangent values, and warm-start data as
  they were at entry.
- The default step is controlled by internal solver options
  `arcLengthFiniteDifferenceStepScale = 1e-5` and
  `arcLengthFiniteDifferenceMinStep = 1e-7`. The `WIRE_VERSION = 7` input
  contract keeps those defaults; exposing them through the public wire/options
  surface is deferred to the `WIRE_VERSION = 8` arc-length integration phase.
- A numeric failure code is returned for diagnostics:
  `0=ok`, `1=invalid-context`, `2=invalid-step-or-sigma`,
  `3=non-finite-probe-residual`.
- This phase still does not switch production safety solves onto arc-length.
  It introduces the derivative oracle that Phase 5 consumes.

Tasks:

- Implement finite-difference `R_lam` for safety.
- Ensure probe material states are isolated and never committed.
- Use central difference when possible.
- Use a forward-only difference at `SigmaMsf = 1`:

```text
R_lam ~= (R(SigmaMsf + h) - R(SigmaMsf)) / h
```

- Use one-sided difference whenever a central probe would evaluate
  `SigmaMsf < 1`.
- Scale finite-difference step with `SigmaMsf`.

Recommended finite-difference step:

```text
h = max(1e-5 * max(SigmaMsf, 1), 1e-7)
```

Expose this as a debug/development knob. Plastic return mapping is not a smooth
function at active-set changes, so derivative validation must sweep `h` around
the default instead of assuming one value is universally optimal.

Validation:

- Finite-difference derivative is stable across a range of `h`.
- Probe assemblies leave committed and trial states unchanged.
- Safety arc-length matches strength-control results on regular monotonic
  cases.

### Phase 5: Integrate With Production Safety Curve

Goal: make arc-length useful for final FoS decisions.

Binding resolution for the Phase-5 implementation:

- `WIRE_VERSION = 8` extends each `SafetyCurvePointV7` record with a fixed
  48-byte numeric `ArcLengthDetailsV8` tail:

```text
SafetyCurvePointV8 (200 bytes each)
  SafetyCurvePointV7 fields (152 bytes)
  u8  actualContinuationMode  // 0=load, 1=strength, 2=arc-length
  u8  hasArcLengthDetails
  u16 failureCode
  i32 linearSolveCount
  f64 deltaLambda
  f64 deltaS
  f64 alpha
  f64 constraintResidual
  f64 correctionDenominator
```

- Version-8 decoders must still decode version-7 safety-curve records and set
  `arcLengthDetails = null`.
- `hasArcLengthDetails === true` is valid only when
  `actualContinuationMode === 2`. Any other combination is a wire bug.
- Phase 5 enables WASM safety arc-length only when
  `requestedContinuationMode = 'arc-length'`; `auto` remains strength-control
  until Phase 7. This keeps regular production solves from paying the two-solve
  arc-length cost before the auto trigger is validated.
- The Phase-5 safety arc-length controller follows the increasing-`SigmaMsf`
  branch inside the current bracketing trial and never reports a non-equilibrium
  point as a lower-bound FoS. Post-peak diagnostics remain conservative: curve
  points can inform the UI, but the reported FoS is still the highest accepted
  lower-bound `SigmaMsf` from the trial/finalization contract.

Tasks:

- Emit arc-length accepted points into `SafetyCurvePoint`.
- Store arc-length-only data in `SafetyCurvePoint.arcLengthDetails`.
- Do not emit a parallel arc-length history for the same safety states.
- Track peak stable `SigmaMsf`.
- Detect plateau and post-peak behavior.
- Feed mechanism scoring and finalization.
- Bump the WASM deformation wire contract to `WIRE_VERSION = 8` only when the
  arc-length details are added to the wire payload.
- This phase must not start until the `WIRE_VERSION = 7` safety-curve contract
  is merged.

Validation:

- `u` versus `SigmaMsf` curve shows peak/plateau behavior.
- Reported FoS remains conservative.
- Post-peak diagnostic path does not overwrite the reported FoS.
- `WIRE_VERSION = 7` safety-curve results still decode without arc-length
  details.
- `WIRE_VERSION = 8` arc-length details decode through numeric failure/status
  enums, not strings.

### Phase 6: Analytic Strength Derivative

Goal: improve performance after correctness is established.

Binding resolution for the Phase-6 implementation:

- Only analytically exact derivatives are enabled. For `linear-elastic`, safety
  strength reduction does not affect the stress update, so
  `dR/dSigmaMsf = 0` exactly.
- `mc-plastic` and `mc-reduced-stiffness` continue to use the validated
  finite-difference oracle even when `arcLengthDerivativeMode` requests
  `analytic` or `analytic-verified`. The active-set return mapping is
  piecewise, branch-cached, and non-smooth at face/edge/apex/tension switches;
  shipping an approximate closed-form derivative under an analytic label is not
  allowed.
- The analytic selector returns numeric failure code `4=unsupported-regime`
  before falling back to finite difference. This is a controlled fallback, not
  a silent change in the reported derivative.
- A future full-plastic analytic derivative must differentiate each accepted
  active-set solve and pass the finite-difference oracle before it can replace
  the fallback.

Tasks:

- Derive `dF_int/dSigmaMsf` for elastic, plastic face, edge, apex, tension, and
  smooth fallback regimes.
- Compare analytic derivative to finite difference per Gauss point and globally.
- Keep debug assertions in development builds.
- Default to analytic derivative only after validation.

Validation:

- Analytic derivative matches finite difference within tolerance.
- Performance improves versus finite-difference arc-length.
- No convergence regression on hard plastic cases.

### Phase 7: Auto Mode

Goal: use arc-length only where it adds value.

Tasks:

- Add trigger logic from strength-control diagnostics.
- Start arc-length from the last stable checkpoint.
- Carry over active-set warm starts correctly.
- Return to strength control only if the path becomes regular and doing so does
  not lose the safety curve.

Validation:

- Regular cases do not pay arc-length cost.
- Hard plastic cases converge farther or classify failure more clearly.
- No false improvement from accepting non-equilibrium states.

## Solver Options

Add options with conservative defaults:

```ts
requestedContinuationMode:
  | 'load-control'
  | 'strength-control'
  | 'arc-length'
  | 'auto';
arcLengthInitialRadius: number;
arcLengthMinRadius: number;
arcLengthMaxRadius: number;
arcLengthGrowthFactor: number;
arcLengthShrinkFactor: number;
arcLengthFailureShrinkFactor: number;
arcLengthTargetIterations: number;
arcLengthMaxRetries: number;
arcLengthConstraintTolerance: number;
arcLengthAlphaMin: number;
arcLengthAlphaMax: number;
arcLengthDerivativeMode: 'finite-difference' | 'analytic' | 'analytic-verified';
arcLengthAllowPostPeakSafetyPath: boolean;
```

Rules:

- `requestedContinuationMode = 'auto'` lets the solver choose the actual mode.
- Result records store only `ActualContinuationMode`, never `auto`.
- `requestedContinuationMode = 'arc-length'` means arc-length is required.
- `requestedContinuationMode = 'load-control'` or `'strength-control'` means
  arc-length is disabled for that phase unless a higher-level development flag
  explicitly overrides it.
- `requestedContinuationMode` and `safetyFinalizationMode` are orthogonal.
  For validation, `requestedContinuationMode = 'arc-length'` may be combined
  with `safetyFinalizationMode = 'legacy-bracket'`; the solver still emits the
  safety curve, while the finalizer chooses the legacy bracket result from trial
  targets.

Initial production defaults:

```ts
requestedContinuationMode = 'auto'
arcLengthDerivativeMode = 'finite-difference'
arcLengthAllowPostPeakSafetyPath = true
```

The UI should not expose all of these. Most are engineering/development options.
The production UI should expose at most a solver strategy selector after the
feature is validated.

## Validation Matrix

Required fixtures:

- Scalar nonlinear spring with snap-through.
- Linear-elastic FEM model where arc-length reproduces load-control path.
- Mohr-Coulomb plastic footing with regular safety path.
- Mohr-Coulomb plastic footing near limit point.
- Slope with localized failure mechanism.
- Case where prescribed strength control fails before a coherent mechanism.
- Mesh refinement pair.
- JS/WASM parity case with arc-length disabled.
- WASM load/strength-control regression after refactor.

Required checks:

- committed state restoration after rejected arc-length steps,
- no material-state mutation from finite-difference probes,
- forward-only safety derivative at `SigmaMsf = 1`,
- unsymmetric tangent path still uses GMRES,
- `WIRE_VERSION = 8` decoder rejects incompatible records cleanly,
- residual and constraint convergence both satisfied,
- safety curve points are monotonic in step index,
- safety curve points carry `arcLengthDetails` instead of duplicate records,
- actual continuation mode never equals `auto`,
- `requestedContinuationMode = 'arc-length'` and
  `safetyFinalizationMode = 'legacy-bracket'` work together for validation,
- reported FoS remains lower-bound conservative,
- post-peak path is not reported as a lower FoS.

## Acceptance Criteria

Arc-length is production-ready only when:

- Current load-control and strength-control results are unchanged when
  arc-length is disabled.
- Arc-length follows a known limit-point benchmark past peak.
- Safety arc-length emits a complete `u` versus `SigmaMsf` curve.
- Hard plastic cases either converge farther or return a clearer engineering
  classification than prescribed strength control.
- The solver never accepts a step that violates equilibrium tolerance.
- Failed/rejected steps restore displacement and material state exactly.
- Finite-difference `R_lam` is validated and isolated.
- Analytic `R_lam`, if enabled by default, is verified against finite difference.
- `WIRE_VERSION = 8` is the first wire version that carries arc-length details.
- Saved-project options migrate without changing disabled arc-length behavior.
- Reports distinguish physical mechanism, no-failure-found, and numerical limit.

## Rollout

Recommended rollout sequence:

1. Commit current solver behavior as baseline.
2. Add production `SigmaMsf` history and curve first.
3. Refactor continuation boundaries with arc-length disabled.
4. Add load-control arc-length and scalar benchmark tests.
5. Add finite-difference safety `R_lam`.
6. Integrate safety arc-length with the safety curve.
7. Add auto fallback.
8. Add analytic derivative and performance work.
9. Expose production strategy only after validation fixtures pass.

This sequence keeps every intermediate step revertable and prevents a partial
arc-length implementation from changing validated behavior.
