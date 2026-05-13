# Feature: Production SigmaMsf Safety Reduction

Status: design
Target area: deformation solver, safety analysis, WASM result pipeline, UI reporting
Target runtime: WASM CPU solver first
Supersedes: current c-phi safety finalization once validated

## Naming And Positioning

Use product-owned wording in the code and UI:

- `SigmaMsf`
- strength reduction factor
- safety reduction
- reduced-strength phase
- safety mechanism
- safety curve

Avoid building the feature around another product name. It is acceptable to mention
industry precedent in internal engineering discussion or validation notes, but the
feature, UI, code, and reports should describe the method directly.

## Purpose

The current safety path finds a lower and upper c-phi reduction bracket. That is
useful, but it is not yet a complete engineering safety methodology because the
final factor should be supported by:

- a conservative lower-bound `SigmaMsf`,
- a meaningful upper bound where one exists,
- a visible displacement versus `SigmaMsf` curve,
- a coherent failure mechanism, not only scattered plastic points,
- a clear distinction between physical failure and numerical non-convergence,
- enough history to audit how the solver reached the displayed factor.

This feature defines the production safety methodology that should replace the
current finalization logic after validation.

## Current State

The solver already has important pieces:

- JS CPU reduces strength through `reduceMaterialStrengthForSafety`.
- WASM mirrors the same reduction in `reduce_strength`.
- c, `tan(phi)`, `tan(psi)`, and the tensile cutoff are reduced by `SigmaMsf`.
- `psi` is clamped so it does not exceed the reduced `phi`.
- WASM safety trials start from the last stable checkpoint and interpolate
  strength from the lower `SigmaMsf` to the target `SigmaMsf` during the trial.
- WASM reports lower and upper factors through:
  - `safetyFactorOfSafetyLower`
  - `safetyFactorOfSafetyUpper`
  - `safetyFactorOfSafety`
  - `safetyDisplayedSigmaMsf`
  - `safetyStrengthRetained`
- The result builder can display safety plastic strain increments through the
  comparison accumulated plastic strain field.

The missing production pieces are:

- WASM does not yet emit dense accepted safety-curve points from inside each
  continuation phase.
- WASM does not yet score spatial mechanism coherence.
- The UI does not yet show the key `u` versus `SigmaMsf` stabilization curve.
- The final safety status is still mostly bracket-driven.
- Numerical non-convergence and physical mechanism development are not yet
  separated strongly enough in the report.

## Strength Reduction Definition

`SigmaMsf` is the absolute mobilized strength reduction factor for the safety
phase. It must not be treated as a per-step increment in public result fields.

For each material region in a safety phase:

```text
c_reduced         = c_base / SigmaMsf
tan(phi_reduced)  = tan(phi_base) / SigmaMsf
tan(psi_reduced)  = tan(psi_base) / SigmaMsf
psi_reduced       = min(psi_reduced, phi_reduced)
sigmaT_reduced    = min(sigmaT_base, c_base / tan(phi_base)) / SigmaMsf
```

Rules:

- Clamp `SigmaMsf >= 1`.
- Preserve the existing Mohr-Coulomb return mapping.
- Preserve unsymmetric plastic tangents unless the material explicitly asks for
  symmetrization.
- Use the same reduced material parameters for stiffness, residual assembly,
  stress update, diagnostics, and displayed mechanism state.
- Do not silently change the strength-reduction formula while switching the
  finalization methodology. Formula changes require separate validation.

## Solver Methodology

The safety solve starts from the converged service checkpoint:

```text
service equilibrium at SigmaMsf = 1
    -> reduced-strength trial from SigmaMsf_low to SigmaMsf_target
    -> if converged, commit as new lower-bound checkpoint
    -> if failed, retain it as upper-bound evidence and reduce the next target
```

Each safety trial must use continuation inside the trial:

```text
SigmaMsf(lambda) = SigmaMsf_start
                + lambda * (SigmaMsf_target - SigmaMsf_start)

lambda in [0, 1]
```

The external force vector remains the full service load. The safety phase changes
material strength, not the applied load.

## Finalization Philosophy

The reported factor of safety must remain conservative:

```text
reported FoS = highest stable lower-bound SigmaMsf
```

An upper bound is supporting evidence. A failed upper-bound trial does not replace
the lower-bound result.

Finalization must classify the safety result into one of these states:

| Status | Meaning | Reported FoS |
| --- | --- | --- |
| `bracketed-failure` | Stable lower bound and failed upper bound are within tolerance. | lower bound |
| `mechanism-developed` | A stable lower bound has developed a coherent mechanism and the safety curve has stabilized. | lower bound |
| `no-failure-found` | The search reached `SigmaMsfMax` without an upper failure. | lower bound, marked open-ended |
| `numerical-nonconvergence` | Solver stopped, but mechanism evidence is insufficient. | lower bound with warning, not physical failure |
| `insufficient-mechanism` | Plasticity exists but is scattered or not kinematically meaningful. | lower bound with warning |
| `needs-more-steps` | Trial budget, bracket tolerance, or step floor stopped the search before classification. | lower bound with warning |

Numeric result contract:

- `factorOfSafety` is always a number.
- `factorOfSafetyLower` is always the conservative lower-bound number.
- `factorOfSafetyUpper` is a number only when a finite upper bound exists.
- `factorOfSafetyIsOpenEnded` is `true` when the UI/report must display the
  value as `FoS > factorOfSafetyLower`.
- For `no-failure-found`:

```text
factorOfSafety              = factorOfSafetyLower
factorOfSafetyUpper         = null
factorOfSafetyIsOpenEnded   = true
```

No consumer may infer open-ended safety from a formatted string. It must use the
boolean field.

Do not call soil-body failure solely because Newton failed. Non-convergence is
evidence only when it occurs near a stable bracket or together with a coherent,
growing mechanism.

## Canonical Status Contract

The current code has several status layers: fixed-width WASM wire codes, decoded
labels, result-builder labels, mechanism-summary labels, and legacy UI text. The
production feature must make these mappings explicit before implementation.

Reserve `WIRE_VERSION = 7` for the safety-curve and production-finalization
contract. `WIRE_VERSION = 6` remains the current legacy contract.

Proposed `WIRE_VERSION = 7` mapping:

| Wire u8 | Wire label | Finalization status | Mechanism status | Legacy/UI compatibility label |
| --- | --- | --- | --- | --- |
| 0 | `not-run` | `not-run` | `none` | `not-applicable` |
| 1 | `bracketed` | `bracketed-failure` | `coherent` or `candidate` | `bracketed` |
| 2 | `mechanism` | `mechanism-developed` | `coherent` | `mechanism-developed` |
| 3 | `no-failure-found` | `no-failure-found` | `none` or `scattered` | `no-failure-found` |
| 4 | `numerical-limit` | `numerical-nonconvergence` | `scattered` or `candidate` | `numerical-nonconvergence` |
| 5 | `insufficient-mechanism` | `insufficient-mechanism` | `scattered` | `insufficient-mechanism` |
| 6 | `needs-more-steps` | `needs-more-steps` | `candidate` or `scattered` | `needs-more-steps` |

Rules:

- Result builders expose `finalization.status`, not the raw wire label, to the
  UI.
- Mechanism status describes only spatial mechanism quality. It must never be
  used as the safety finalization status.
- Existing `WIRE_VERSION = 6` code `2` decodes as wire label `mechanism` and is
  converted by the result builder to `mechanism-developed`.
- Do not branch UI text directly on raw wire codes.
- Before shipping this feature, audit every exact safety-status comparison in:
  - `src/lib/cpt-app/legacy-controller.js`
  - `src/lib/cpt-app/routes/+page.svelte`, if it exists in the active app
  - `src/lib/cpt-app/deformation/wasm/build-result.js`
  - any report/export builder that reads `safetyStatus`

## Safety Curve

The UI must include a safety curve that plots displacement against `SigmaMsf`.
This is a primary engineering output, not a diagnostic afterthought.

Default chart:

```text
x-axis: monitored displacement u, relative to the safety-base checkpoint
y-axis: SigmaMsf
```

Why this chart matters:

- If the soil body is stable, additional strength reduction requires modest
  displacement growth and the curve continues upward.
- Near failure, displacement grows strongly while `SigmaMsf` stops increasing
  materially.
- The plateau makes the final factor visually auditable.
- Failed upper-bound probes can be shown without claiming they are the reported
  factor.

Required chart elements:

- accepted continuation points,
- rejected or failed trial targets,
- final reported lower bound,
- upper-bound band if available,
- plateau window used for finalization,
- mechanism-developed marker if applicable,
- hover details with trial, step, `SigmaMsf`, displacement, residual, active-set
  count, and plastic increment.

The chart must be built from solver-emitted data, not reconstructed from final
state only.

## Monitoring Displacement

The default monitor should work without user setup. It must also allow explicit
user selection later.

Default monitor:

```text
u_monitor = max absolute nodal displacement increment relative to safety base
```

Store both:

- signed component displacement for the dominant direction,
- absolute resultant displacement norm.

Recommended monitor fields per accepted safety curve point:

```text
uMaxAbs
uNorm
uSettlementMax
uHorizontalMax
dominantDof
dominantNode
userMonitorU
```

UI behavior:

- Use `uMaxAbs` as the default chart x-value.
- If the user selects a node and component, show that curve as the main curve
  and keep the default curve as a secondary option.
- Display units in the project displacement unit.
- Keep signs available in tooltips, but make the default curve monotonic by
  using absolute magnitude.

## Plateau Detection

Plateau detection must be based on a rolling window of accepted continuation
states, not only on trial endpoints.

Inputs:

- `SigmaMsf` history,
- monitored displacement history,
- safety plastic increment history,
- active-set stability,
- residual and line-search behavior,
- mechanism coherence score.

Minimum rule:

```text
relativeSigmaChange =
  abs(SigmaMsf_last - SigmaMsf_first) / max(SigmaMsf_last, 1)

uGrowth =
  u_last - u_first

plasticGrowth =
  maxSafetyPlastic_last - maxSafetyPlastic_first
```

A plateau is eligible when:

- the window has at least `N` accepted points,
- `relativeSigmaChange <= plateauRelativeTolerance`,
- `uGrowth >= minPlateauDisplacementGrowth` or
  `plasticGrowth >= minPlateauPlasticGrowth`,
- the active plastic region is spatially coherent,
- the lower-bound state remains converged.

Recommended defaults:

```text
plateauWindow                  = 4 accepted points
plateauRelativeTolerance       = 0.005 to 0.01
minPlateauDisplacementGrowth   = model-size scaled, not a fixed global number
minPlateauPlasticGrowth        = 1e-8 initial default, calibrated by validation
```

The model-size scaled displacement threshold should be derived from the mesh
bounding box:

```text
minPlateauDisplacementGrowth = 1e-6 * max(modelWidth, modelHeight)
```

## Mechanism Detection

Failure mechanism display and finalization must be based on incremental safety
quantities. Accumulated service plasticity must not be mistaken for safety
failure.

Primary mechanism contour:

```text
deltaEquivalentPlasticStrainSafety =
  accumulatedPlasticStrain_display
  - accumulatedPlasticStrain_comparison
```

Additional useful fields:

- incremental maximum shear strain,
- incremental deviatoric strain norm,
- incremental displacement magnitude,
- active Mohr-Coulomb face/edge/apex classification,
- tension cutoff activity.

Mechanism scoring must distinguish a real mechanism from isolated points.

Required mechanism metrics:

```text
maxDeltaPlasticStrain
totalDeltaPlasticStrain
activePlasticPointCount
activePlasticElementCount
largestConnectedComponentElementCount
largestConnectedComponentPlasticMass
connectedComponentCount
mechanismLength
mechanismTouchesLoadedZone
mechanismTouchesFreeSurface
mechanismTouchesBoundary
mechanismCrossesSlopeOrFoundationZone
displacementDirectionCoherence
mechanismScore
```

Connectivity:

- Build element adjacency from shared mesh edges. This must match the existing
  seepage convention that builds neighbors through the mesh edge map.
- Mark an element active when any Gauss point exceeds the mechanism threshold.
- Compute connected components over active elements.
- The largest component must represent a meaningful fraction of plastic activity.

Initial scoring rule:

```text
componentMassRatio =
  largestConnectedComponentPlasticMass / max(totalDeltaPlasticStrain, eps)

mechanismScore =
  weighted combination of:
    componentMassRatio,
    mechanismLength / modelLength,
    loaded/free-surface/boundary contact,
    displacementDirectionCoherence,
    plasticGrowthOverWindow
```

Finalization threshold:

```text
mechanismScore >= 0.65
```

This threshold is not a universal truth. It must be calibrated on validation
models and kept configurable in solver options.

Performance rule:

- Store cheap per-point mechanism proxies in the safety curve:
  `activePlasticElementCount`, `maxDeltaPlasticStrain`, and
  `totalDeltaPlasticStrain`.
- Run full connected-component mechanism scoring only at:
  - finalization candidates,
  - plateau-window boundaries,
  - selected display states,
  - explicit diagnostic requests.
- If a curve point did not run full scoring, store `mechanismScore = null` and
  do not fabricate a score from cheap proxies.

## Result Data Contract

The WASM result must expose enough history for the UI and report to audit the
safety decision.

Add or extend:

```ts
type SafetyCurvePoint = {
  index: number;
  trialIndex: number;
  continuationStepIndex: number;
  sigmaMsf: number;
  lambda: number;
  converged: boolean;
  accepted: boolean;
  residualNorm: number;
  relativeResidual: number;
  nonlinearIterations: number;
  linearIterations: number;
  lineSearchAcceptedScale: number;
  activeCount: number;
  activeFaceCount: number;
  activeEdgeCount: number;
  activeApexCount: number;
  tensionCount: number;
  uMaxAbs: number;
  uNorm: number;
  uSettlementMax: number;
  uHorizontalMax: number;
  dominantNode: number;
  dominantDof: number;
  activePlasticElementCount: number;
  maxDeltaPlasticStrain: number;
  totalDeltaPlasticStrain: number;
  mechanismScore: number | null;
  arcLengthDetails: ArcLengthStepDetails | null;
};

type ArcLengthStepDetails = {
  actualContinuationMode: 'arc-length';
  deltaLambda: number;
  deltaS: number;
  alpha: number;
  constraintResidual: number;
  linearSolveCount: number;
  linearIterationsTotal: number;
  correctionDenominator: number;
  failureCode: number;
};

type SafetyMechanismSummary = {
  status: 'none' | 'scattered' | 'candidate' | 'coherent';
  score: number;
  threshold: number;
  activeElementCount: number;
  largestConnectedComponentElementCount: number;
  componentMassRatio: number;
  mechanismLength: number;
  touchesLoadedZone: boolean;
  touchesFreeSurface: boolean;
  touchesBoundary: boolean;
  displacementDirectionCoherence: number;
};

type SafetyFinalization = {
  status:
    | 'not-run'
    | 'bracketed-failure'
    | 'mechanism-developed'
    | 'no-failure-found'
    | 'numerical-nonconvergence'
    | 'insufficient-mechanism'
    | 'needs-more-steps';
  factorOfSafety: number;
  factorOfSafetyLower: number;
  factorOfSafetyUpper: number | null;
  factorOfSafetyIsOpenEnded: boolean;
  bracketWidth: number | null;
  strengthRetained: number;
  displayedSigmaMsf: number;
  plateauDetected: boolean;
  plateauWindowStart: number | null;
  plateauWindowEnd: number | null;
  mechanism: SafetyMechanismSummary;
  curve: SafetyCurvePoint[];
};
```

`SafetyCurvePoint` is the canonical accepted-step history record. Arc-length
must add `arcLengthDetails` inside the same point rather than emitting a second
parallel step-history array for the same accepted safety state.

WASM binary wire format rules:

- Reserve `WIRE_VERSION = 7` for this safety-curve and finalization contract.
- Existing decoders must reject incompatible versions clearly.
- Fixed-width WASM records must not contain strings.
- Failure codes inside fixed-width records must be numeric enums, for example
  `u16 failureCode`, with JS-side label mapping.
- Saved-project option migration must be explicit and tested.

## UI Requirements

Safety result panel:

- Report `FoS = lower bound`.
- Show upper bound when available.
- Show `FoS > lower bound` only when `factorOfSafetyIsOpenEnded === true`.
- Show bracket width.
- Show status using the finalization states above.
- Show `strength retained = 1 / SigmaMsf`.
- Show whether the final state is bracketed, plateau-based, no-failure-found, or
  numerically limited.

Safety curve panel:

- Plot `SigmaMsf` versus monitored `u`.
- Mark accepted continuation points.
- Mark failed trial targets.
- Shade the lower/upper bracket when available.
- Mark the final reported point.
- Mark the plateau window.
- Allow switching between default max displacement and selected node/component.

Mechanism panel:

- Default contour: safety incremental equivalent plastic strain.
- Overlay displacement vectors relative to safety base.
- Let users switch to incremental displacement magnitude, active-set type, or
  shear strain diagnostics.
- Show mechanism score and largest connected component summary.

The UI must not present a failed Newton target as the reported FoS. It can show
it as upper-bound evidence.

## Implementation Plan

### Phase 1: Instrument WASM Safety History

Goal: emit dense accepted continuation points from WASM.

Tasks:

- Extend `PhaseResult` to store accepted continuation step summaries.
- During safety phases, append a `SafetyCurvePoint` at every accepted
  continuation step, not only at each search trial.
- Compute displacement metrics relative to the safety-base displacement vector.
- Compute safety plastic increments relative to the correct comparison material
  point state.
- Include active-set and solver metrics in each point.
- Extend the WASM output writer and JS decoder with a versioned safety-history
  section.
- Bump the WASM deformation wire contract to `WIRE_VERSION = 7`.
- Encode per-record failure/status details as numeric enums, not strings.

Validation:

- Existing WASM solves must produce identical final FoS before finalization logic
  changes.
- Safety curve endpoint must match `safetyDisplayedSigmaMsf`.
- Displacement metrics must match direct JS recomputation from the result arrays.
- Version-6 outputs still decode through the current path; version mismatch
  errors are explicit and cannot silently degrade.

### Phase 2: Add UI Safety Curve

Goal: make the safety progression auditable.

Tasks:

- Add a compact chart under the safety result panel.
- Plot accepted points, failed targets, lower bound, upper bound, and final FoS.
- Add hover details for solver and mechanism metrics.
- Keep the existing safety text concise.

Validation:

- Graph renders for bracketed failure, no-failure-found, and early-stop cases.
- Graph handles empty or legacy histories gracefully.

### Phase 3: Implement Mechanism Connectivity

Goal: distinguish coherent failure mechanisms from scattered plasticity.

Tasks:

- Build element adjacency once per mesh using the same edge-shared convention as
  the seepage solver.
- Compute active safety elements from incremental plastic strain threshold.
- Compute cheap per-point mechanism proxies for every curve point.
- Compute full connected components only at finalization candidates,
  plateau-window boundaries, and selected display states.
- Store mechanism summary in the safety result.
- Display mechanism summary in the UI.

Validation:

- Synthetic localized band scores higher than scattered isolated points.
- Linear-elastic safety cases score `none`.
- Existing plastic service cases do not appear as safety mechanisms unless the
  safety phase adds incremental plasticity.

### Phase 4: Production Finalization

Goal: replace bracket-only finalization with the full methodology.

Tasks:

- Add a solver option:

```ts
safetyFinalizationMode:
  | 'legacy-bracket'
  | 'production-msf'
```

- Keep `legacy-bracket` only for validation and rollback.
- In `production-msf`, classify result using:
  - bracket width,
  - plateau detection,
  - mechanism score,
  - solver failure reason,
  - search budget exhaustion.
- Report conservative lower-bound FoS in all physical failure states.
- Report non-convergence separately when mechanism evidence is insufficient.
- Wire raw statuses through the canonical mapping table.
- Audit all exact safety-status comparisons in the UI, result builder, and
  report/export code.
- Use `factorOfSafetyIsOpenEnded` for open-ended display text; never encode
  `FoS > ...` inside the numeric factor field.

Validation:

- Golden cases with known bracket behavior keep the same lower-bound FoS.
- Plateau cases finalize without needing excessive failed probes.
- Non-convergent but scattered cases do not get reported as physical failure.
- A `bracketed-failure` result cannot fall through to "stable up to" UI text.
- `no-failure-found` displays as open-ended while preserving numeric FoS fields.

### Phase 5: Switch Over

Goal: make production `SigmaMsf` the default safety methodology.

Tasks:

- Default WASM safety to `production-msf`.
- Keep the legacy mode hidden behind a development-only option for one release.
- Update result text and export/report fields.
- Remove duplicate or dead safety finalization code after the rollback window.

Validation:

- WASM deformation remains the default backend.
- JS CPU remains available as a reference/debug path if still present.
- Existing saved projects load without option migration errors.

## Acceptance Criteria

The feature is complete only when:

- WASM emits a full safety curve.
- The UI plots `u` versus `SigmaMsf`.
- The reported FoS is conservative and lower-bound based.
- Bracketed failure and mechanism-developed failure are separate states.
- Numerical non-convergence is not mislabeled as soil body failure.
- The displayed mechanism is based on safety incremental plastic strain.
- Mechanism scoring is spatially coherent, not just a max-value check.
- Full mechanism scoring is not run for every accepted curve point.
- `factorOfSafetyIsOpenEnded` controls all `FoS > ...` display text.
- Status mappings are tested from WASM wire code through UI/report labels.
- Existing safety examples still solve.
- Regression fixtures cover bracketed, plateau, no-failure, scattered-plasticity,
  and numerical-limit cases.
- The legacy finalization path can be reverted to during validation without
  changing the solver core.

## Test Matrix

Required tests:

- Linear-elastic service plus safety: no plastic mechanism, no false failure.
- Mohr-Coulomb plastic footing: bracketed failure with visible mechanism.
- Slope with expected shear band: coherent mechanism and stable safety curve.
- Scattered plastic points: insufficient mechanism classification.
- Hard plasticity case: higher convergence than the old bracket-only flow.
- Mesh refinement pair: FoS and mechanism should be stable within tolerance.
- JS/WASM parity fixture: strength reduction formula and lower-bound FoS match
  within tolerance for cases where both paths converge.
- Wire-status mapping fixture: every wire `u8` status maps to the intended
  finalization status, mechanism status, and UI text.
- Open-ended FoS fixture: `no-failure-found` keeps numeric FoS but displays
  `FoS > lower`.
- Saved-project migration: old projects run with production defaults.

## Engineering Risks

- Mechanism scoring can become overconfident if thresholds are not calibrated.
- Dense history increases WASM result size; store summaries, not full state
  snapshots, unless a snapshot is needed for display.
- The chart can mislead if it uses only trial endpoints. It must use accepted
  continuation states.
- Non-convergence near true failure is useful evidence, but only after mechanism
  and bracket checks. Do not let solver failure become the definition of failure.

## Rollback Strategy

Keep these boundaries:

- strength-reduction formula unchanged,
- safety curve instrumentation additive,
- mechanism scoring additive,
- finalization mode switchable until validation is complete.

If production finalization needs rollback, switch:

```ts
safetyFinalizationMode = 'legacy-bracket'
```

The solver should still emit curve and mechanism diagnostics in legacy mode so
validation data is not lost.
