# Geostatic Initialization Fix

## Purpose

This note defines the fix for sloped-terrain Stage 2 plastic geostatic initialization.

The current failure mode is:

```text
Showing a non-converged initial self-weight equilibration state at 0.0%
of the predictor-to-full-gravity correction. Service loading was not started.
Initial exact MC audit flagged many inadmissible predictor elements.
```

This is most visible near the terrain surface on sloped ground, especially with
T6 elements. The effective stress is small near the free surface, so the
available resistance is mathematically small. That part is physical. The bug is
that the current predictor creates a non-admissible hybrid stress state before
the plastic geostatic correction even starts.

The goal is:

```text
geometry + soil + pore pressure
  -> admissible initial effective stress seed
  -> plastic self-weight equilibration
  -> service loading
```

The solver must not hide near-surface plasticity by coarsening the mesh or
discarding shallow Gauss points. It must build a mathematically admissible
initial state and report near-surface plastic/tension activity clearly.

## Current Problem

The current plastic-geostatic path builds an elastic gravity solution, recovers
elastic stress, then rewrites only part of that stress into a K0-style state.

The problematic flow is in `src/lib/cpt-app/deformation/solver.js`:

```js
function buildK0ControlledInitialEffectiveStress6(totalStress6, materialParameters, porePressure = 0) {
  const totalStress = totalStress6ToCompressionPositiveStress3D(totalStress6);
  const u0 = Math.max(Number(porePressure) || 0, 0);
  const sigmaV0Eff = Math.max(totalStress.syy - u0, 0);
  const K0 = Number.isFinite(Number(materialParameters?.K0nc))
    ? Math.max(Number(materialParameters.K0nc), 0)
    : fallbackK0(materialParameters?.phiEffDeg);
  const sigmaH0Eff = K0 * sigmaV0Eff;
  return [
    -sigmaH0Eff,
    -sigmaV0Eff,
    -sigmaH0Eff,
    -(Number(totalStress.txy) || 0),
    0,
    0
  ];
}
```

This keeps the elastic slope shear while replacing the normal stresses with a
vertical K0 field. Near the surface this can create:

```text
sigma'v ~= 0
sigma'h ~= 0
tau_xy  != 0
```

That is not a physically consistent stress tensor. A small retained shear stress
combined with almost zero confinement can create tensile minor principal stress
or exceed the exact Mohr-Coulomb surface. The exact MC audit then flags many
near-surface points as inadmissible before the correction phase begins.

With T6 this is more visible because each element has three Gauss points, and
some are closer to the free surface than a T3 centroid would be.

## Design Summary

Implement a new admissible geostatic seed:

1. Stop using the hybrid "K0 normals plus elastic shear" predictor for plastic
   geostatic slopes.
2. Build a terrain-following K0 initial effective stress field directly at each
   integration point.
3. Project every initial stress seed into the exact admissible domain before
   the plastic continuation starts.
4. Treat zero-tension boundary states as admissible boundary states, not as
   automatic tension failures.
5. Respect generic initial-step controls in the initial-gravity phase.
6. Add near-surface diagnostic bins so users can distinguish shallow boundary
   activity from a real plastic mechanism.

## New Module

Add:

```text
src/lib/cpt-app/deformation/geostatic-init.js
```

This module should own all plastic-geostatic initial stress construction.

Suggested exports:

```js
export function surfaceFrameAt(model, x, options = {})
export function terrainFollowingK0Stress6AtPoint(model, point, material, options, warnings)
export function projectStressToAdmissibleSeed(stress6, material, options = {})
export function buildAdmissibleInitialStressField(mesh, elementCaches, model, options, warnings)
export function summarizeInitialStressAudit(auditRecords, model)
```

Keep this module pure and deterministic. It should not assemble global stiffness
or run the nonlinear phase. It only builds and audits the initial stress field.

## Terrain-Following K0 Seed

For each integration point:

```text
point = { x, y, regionIndex, material }
```

Compute:

```text
y_surface = terrainY(model.terrain, x)
depth = max(y_surface - y, 0)
sigma_v_total = verticalOverburdenStressAt(model, x, y)
u0 = sampleInitialPorePressure(model, x, y, options, warnings)
sigma_v_eff = max(sigma_v_total - u0, 0)
K0 = material.K0nc ?? 1 - sin(phi')
```

Then compute a local terrain tangent. Do not use a discontinuous segment tangent
at terrain vertices if avoidable. Use a small smoothing length:

```text
L_smooth = max(0.5 * sqrt(meshTargetArea), 0.25 m)
```

Estimate:

```text
dy_dx = (terrainY(x + L_smooth) - terrainY(x - L_smooth)) / (2 * L_smooth)
theta = atan(dy_dx)
```

Clamp or fall back safely near model boundaries.

Define local axes:

```text
t = [ cos(theta), sin(theta) ]       tangent along terrain
n = [ -sin(theta), cos(theta) ]      normal to terrain
```

Use a simple admissible terrain-following seed:

```text
sigma_nn = sigma_v_eff * cos(theta)^2
sigma_tt = K0 * sigma_v_eff
tau_tn   = sigma_v_eff * sin(theta) * cos(theta)
sigma_zz = K0 * sigma_v_eff
```

For flat terrain:

```text
theta = 0
sigma_xx = K0 * sigma_v_eff
sigma_yy = sigma_v_eff
tau_xy = 0
sigma_zz = K0 * sigma_v_eff
```

This preserves the current flat-ground behavior.

Transform local stress back to global coordinates. Use compression-positive
stress internally, then convert to the solver's effective-stress Voigt sign
convention:

```js
// compression-positive 2D tensor in global axes
const sigma = sigma_tt * outer(t, t)
  + sigma_nn * outer(n, n)
  + tau_tn * (outer(t, n) + outer(n, t));

return [
  -sigma.xx,
  -sigma.yy,
  -sigma_zz,
  -sigma.xy,
  0,
  0
];
```

The exact formula for `tau_tn` should be conservative. If this seed still
overstates shear for shallow points, the projection step below will reduce it.

## Admissibility Projection

Every initial seed must be checked against the same exact MC and tension surfaces
used by Stage 2. The plastic continuation must not start from an inadmissible
predictor.

For each integration point:

1. Build raw seed stress.
2. Evaluate exact MC surface values.
3. If admissible, keep it.
4. If inadmissible, reduce terrain-induced shear by scalar bisection.
5. If shear reduction is insufficient, use exact active-set return mapping as a
   projection fallback.

Recommended API:

```js
projectStressToAdmissibleSeed(rawStress6, material, {
  shearBasis,
  tolerance,
  maxIterations: 40
})
```

The first projection route is shear scaling:

```text
stress(alpha) = normalPart + alpha * shearPart
alpha in [0, 1]
```

Choose the largest admissible `alpha` by bisection.

Diagnostic record:

```js
{
  rawStress6,
  projectedStress6,
  rawAdmissible,
  projectedAdmissible,
  projectionApplied,
  projectionMode: 'none' | 'shear-scale' | 'exact-return',
  shearScale,
  rawYieldSurface,
  projectedYieldSurface,
  rawMaxSurfaceResidual,
  projectedMaxSurfaceResidual,
  depthBelowTerrain,
  porePressure,
  sigmaV0Eff
}
```

The exact-return fallback should not increment service plastic history. It is an
initial stress projection. Store it as audit data, not accumulated service
plasticity.

## Tension Boundary Semantics

The current tension diagnostic is too aggressive for zero-tension free-surface
states. It treats states near the zero-tension boundary as active tension
failure:

```js
if (useTensionCutoff && T3 >= -tensionTolerance) {
  return { state: 'tension-cutoff', eta: Infinity }
}
```

Change this to three states:

```text
T3 > +tol       tension violation
|T3| <= tol     admissible tension boundary
T3 < -tol       inside admissible tension domain
```

Proposed behavior:

```js
if (useTensionCutoff && T3 > tensionTolerance) {
  return {
    state: 'tension-cutoff',
    tensionViolation: true,
    tensionBoundary: false,
    eta: Number.POSITIVE_INFINITY
  };
}

if (useTensionCutoff && T3 >= -tensionTolerance) {
  return {
    state: 'tension-boundary',
    tensionViolation: false,
    tensionBoundary: true,
    eta: finiteMcEta,
    F,
    surfaceValues,
    ...principal
  };
}
```

The exact active-set return should activate the tension branch only when the
tension residual is truly positive beyond tolerance:

```text
T3 > tolerance
```

Boundary states should be reported, but not counted as inadmissible predictor
states.

Apply this consistently in:

```text
src/lib/cpt-app/deformation/material-models.js
src/lib/cpt-app/deformation/post.js
```

## Solver Flow Change

In `src/lib/cpt-app/deformation/solver.js`, split geostatic initialization into
two paths:

```text
predictor mode:
  current gravity-step K0 predictor may remain

plastic-geostatic mode:
  admissible terrain-following seed
  plastic self-weight correction
```

Current flow:

```text
buildGeostaticInitialization()
  -> recoverInitialFieldFromGeostaticSolution()
  -> buildK0ControlledInitialEffectiveStress6()
  -> buildElementMaterialPoints()
  -> solveInitialPlasticEquilibrium()
```

New plastic-geostatic flow:

```text
buildAdmissibleInitialStressField()
  -> buildElementMaterialPoints()
  -> initializePlasticPredictorReferenceState()
  -> solveInitialPlasticEquilibrium()
```

The elastic gravity displacement solution may still be useful for predictor mode
or display diagnostics, but it must not create the hybrid slope seed for plastic
geostatic mode.

Pseudo-code:

```js
const wantsPlasticInitialEquilibrium = options.initialStressMode === 'plastic-geostatic';

const geostatic = wantsPlasticInitialEquilibrium
  ? buildAdmissibleInitialStressField(mesh, elementCaches, model, options, warnings)
  : await buildGeostaticInitialization(...);

const materialPoints = buildElementMaterialPoints(
  mesh,
  elementCaches,
  regionConstitutiveByRegion,
  geostatic.initialField,
  options,
  warnings
);
```

The returned object should preserve the existing shape:

```js
{
  initialField,
  mode: 'admissible-terrain-following-k0',
  solution: new Float64Array(ndof),
  audit,
  warnings
}
```

If exact-return projection is used, do not set `solution` to a fake displacement
field. Initial stresses and displacement baselines are separate concepts.

## Initial Phase Load-Stepping Controls

The initial-gravity phase currently has independent defaults that override the
generic nonlinear controls:

```js
initialGravityMinLoadStep: input.initialGravityMinLoadStep || 1 / 8192
initialGravityMaxLoadSteps: input.initialGravityMaxLoadSteps || 512
```

This lets sloped cases grind through hundreds of tiny steps even when the user
or tests provide:

```js
maxLoadSteps: 80
minLoadStep: 0.0005
```

Change fallback order to:

```js
initialGravityMinLoadStep =
  input.options.initialGravityMinLoadStep
  ?? input.options.minLoadStep
  ?? NONLINEAR_MIN_LOAD_STEP;

initialGravityMaxLoadSteps =
  input.options.initialGravityMaxLoadSteps
  ?? input.options.maxLoadSteps
  ?? NONLINEAR_MAX_LOAD_STEPS;
```

Also add:

```js
initialGravityMaxLinearIterations
initialGravityMaxTotalLinearIterations
```

If exceeded, return a partial initial self-weight state with a clear failure
code:

```text
initial-geostatic-linear-budget-exhausted
```

This is not a convergence success. It is either a near-limit slope, an
ill-conditioned configuration, or an input state that needs engineering review.

## Inexact Newton Linear Tolerance

The current code calls GMRES with a fixed tight Krylov tolerance:

```js
CG_REL_TOL = 1e-5
```

Only after GMRES returns does the nonlinear solver decide whether a looser
inexact Newton correction would have been acceptable.

Change this so the inexact Newton forcing term is computed before calling GMRES:

```js
const linearRelTolForStep = computeInexactNewtonLinearRelTol(...);

const cg = await linearSolve(
  rows,
  rhs,
  initial,
  maxIterations,
  linearRelTolForStep,
  absTol,
  ...
);
```

For initial plastic geostatic, start with a looser correction tolerance when far
from convergence, for example:

```text
eta_linear = clamp(sqrt(relativeResidual), 0.05, 0.6)
```

This avoids spending 800 to 1200 GMRES iterations on a Newton correction that
the line search will later cut back.

## Adaptive Continuation Should Include Krylov Cost

The continuation controller currently looks mostly at Newton iterations and line
search scale. A step with one Newton iteration and 1000 GMRES iterations is
treated as cheap. That is wrong for T6 plastic slopes.

Add Krylov cost to the adaptive step factor:

```js
computeAdaptiveContinuationFactor({
  iterationCount,
  acceptedLineSearchScale,
  linearIterationCount,
  targetLinearIterations,
  ...
})
```

Example:

```text
targetLinearIterations = 250 for T3
targetLinearIterations = 400 for T6
```

If `linearIterationCount` is much larger than target, reduce the next load step
even when Newton count is low.

## Near-Surface Diagnostics

Add diagnostic bins by depth below terrain:

```text
0.00 - 0.25 m
0.25 - 0.50 m
0.50 - 1.00 m
1.00 - 2.00 m
2.00 - 4.00 m
> 4.00 m
```

For each bin, report:

```js
{
  depthMin,
  depthMax,
  gaussPointCount,
  rawInadmissibleCount,
  projectedInadmissibleCount,
  projectionAppliedCount,
  tensionBoundaryCount,
  tensionViolationCount,
  mcViolationCount,
  meanSigmaV0Eff,
  meanAbsTau,
  maxRawEta,
  maxProjectedEta
}
```

Expose summary fields:

```js
summaries.initialStressNearSurfaceBins
summaries.rawInitialInadmissibleGaussPointCount
summaries.projectedInitialInadmissibleGaussPointCount
summaries.initialStressProjectionGaussPointCount
summaries.initialTensionBoundaryGaussPointCount
summaries.initialTensionViolationGaussPointCount
```

Keep the old element-level count for compatibility, but reword the UI so it is
clear whether the reported issue is raw predictor inadmissibility or projected
seed inadmissibility.

## UI Wording

Replace:

```text
Initial exact MC audit flagged 190 inadmissible predictor elements.
```

With one of:

```text
Raw slope stress seed required admissibility projection at 190 Gauss points,
mostly within 0.25 m of the terrain surface. The projected initial seed was
admissible before plastic self-weight equilibration.
```

Or, if projection fails:

```text
The projected initial stress seed remains inadmissible at 37 Gauss points.
Service loading was not started because the initial self-weight state could not
be made admissible. Review slope geometry, drainage, c', phi', and unit weights.
```

For tension boundary:

```text
Near-surface points on the zero-tension boundary are expected at free terrain
surfaces and are reported separately from tension violations.
```

## Tests

Add tests in `scripts/verify_deformation_phase_1.mjs`.

### 1. Flat K0 Regression

Flat terrain must reproduce the existing K0 stress field:

```text
sigma'xx = K0 * sigma'v
sigma'yy = sigma'v
sigma'zz = K0 * sigma'v
tau_xy = 0
```

Use both T3 and T6.

### 2. Free Surface Boundary Is Admissible

At a Gauss point with:

```text
sigma'v = 0
sigma'h = 0
tau = 0
sigmaTAllow = 0
```

Expected:

```text
tensionBoundary = true
tensionViolation = false
initialStateAdmissible = true
eta finite or null, not Infinity
```

### 3. Mild Slope Does Not Stall At 0 Percent

Use a lightly sloped terrain and weak but realistic material. Plastic-geostatic
initialization should either:

```text
converge
```

or:

```text
advance beyond 0% and return a classified partial state
```

It must not report zero accepted correction steps caused by raw predictor
inadmissibility.

### 4. T6 Near-Surface Diagnostic

Run the earlier T6 slope case and assert:

```text
mesh has no unused nodes
projectedInitialInadmissibleGaussPointCount = 0
nearSurfaceBins[0].gaussPointCount > 0
tensionBoundaryCount may be > 0
tensionViolationCount is not used to classify boundary states
```

### 5. Weak/Steep Slope Fails Fast

Use a deliberately unstable slope. Expected:

```text
initialPhaseConvergenceState = partial
failureCode is specific
servicePhaseStarted = false
linear/step budget respected
```

This confirms the solver does not grind for minutes.

### 6. Projection Does Not Create Service Plastic History

If the seed projection modifies stresses:

```text
initialStressProjectionGaussPointCount > 0
maxInitialEquivalentPlasticStrain remains 0 before plastic continuation
```

The projection is an admissible stress initialization step, not a service
plastic strain increment.

## Migration Plan

Implement in small, reviewable commits:

1. Add tension-boundary semantics and tests.
2. Add `geostatic-init.js` with terrain-frame and flat K0 regression tests.
3. Add admissibility projection with audit records.
4. Route plastic-geostatic initialization through the new admissible seed.
5. Add near-surface diagnostic summaries and UI wording.
6. Fix initial-gravity option fallback order.
7. Add inexact Newton linear tolerance and Krylov-aware continuation.
8. Run full deformation verification and targeted T6 slope diagnostics.

## Engineering Acceptance Criteria

The fix is accepted when:

```text
1. Flat terrain results remain unchanged within numerical tolerance.
2. Mild slopes no longer fail at 0% due to inadmissible near-surface predictors.
3. T6 slope cases expose shallow boundary activity without corrupting the initial state.
4. Weak/unstable slopes fail quickly with clear diagnostics.
5. The solver starts plastic continuation from an admissible stress field.
6. Near-surface zero-tension boundary points are not reported as tension failures.
7. The full deformation verification suite passes.
```

## Conceptual Rule

The key rule is:

```text
The plastic geostatic phase must not be asked to repair an inadmissible stress
field that the initializer created artificially.
```

Build an admissible initial stress seed first. Then let the plastic equilibrium
solver do its actual job: finding a self-weight equilibrium compatible with the
material model and the boundary conditions.
