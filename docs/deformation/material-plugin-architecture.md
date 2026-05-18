# Material plugin architecture

The deformation solver is constitutive-model-agnostic. Every material — linear
elastic, MC reduced-stiffness, exact MC elastoplastic with tension cut-off —
is registered with the plugin registry in
[`material-plugin.js`](../../src/lib/cpt-app/deformation/material-plugin.js)
and dispatched there. The solver itself never switches on a model name string.

This is the implementation contract a future plugin (Hardening Soil, Cam-Clay,
Drucker-Prager, …) must satisfy. Adding a plugin is one new factory function
plus one `registerMaterialPlugin(name, factory)` line, with no edits to
the solver, the GPU backend, or the verification harness.

---

## 1. The contract

A plugin is the object returned from a factory `(materialParameters, warnings) → Plugin`.
Every field below is mandatory unless explicitly noted.

| Field | Type | Purpose |
|---|---|---|
| `kind` | string | Stable identifier; appears in the run record and the registry. |
| `displayName` | string (optional, defaulted) | Human-readable label used in error / progress messages. |
| `shortDisplayName` | string (optional, defaulted) | Compact variant. |
| `capabilities` | object | One boolean per flag in `MATERIAL_CAPABILITY_KEYS`. Every flag must be set explicitly; there are no implicit defaults so a future capability addition cannot silently activate the plugin's path. |
| `materialParameters` | object | Same reference passed in. The c-phi safety reduction replaces this on the material point at runtime; the plugin's `update` is expected to honour the override (passed as `materialParameters` in the update call). |
| `elasticTangent6x6` | `number[6][6]` | Plane-strain elastic Voigt tangent (axes `[exx, eyy, ezz, gxy, gyz, gxz]`). |
| `initialTangent6x6` | `number[6][6]` | Initial-step Voigt tangent. May equal `elasticTangent6x6` for plugins with no reduced or pre-yield stiffness. |
| `update(...)` | function | The constitutive update; see §3. |

Shape validation runs on every `materialPluginFor` call so a bad factory is
caught at the call site, not as a downstream NaN. The validator also
synthesises `displayName` and `shortDisplayName` from `kind` if the plugin
omits them.

---

## 2. Capability flags

Every capability is one boolean. Each gates exactly one piece of solver
behaviour. Plugins set every flag explicitly. The full list (canonical
source: `MATERIAL_CAPABILITY_KEYS` in `material-plugin.js`):

| Flag | Set when | Solver consequence when `true` |
|---|---|---|
| `isLinearElastic` | The trial stress is a linear function of trial strain with no history. | The Newton solve converges in 1 iteration; line search and warm start are skipped; CG tolerance can be relaxed. |
| `tracksYieldSurface` | The plugin maintains a yield surface and may transition Gauss points between elastic and plastic. | The run record exposes plastic exceedance counts; the load-step adapter caps growth via `plasticGrowthFactor` when an active set is present. |
| `algorithmicTangentMayBeUnsymmetric` | Non-associated flow (e.g. MC with `psi ≠ phi`) or any case where the algorithmic tangent is not symmetric. | Krylov inner solver is GMRES (or BiCGStab); warm-start is enabled. |
| `isPathDependent` | The trial state at load `t` cannot be recomputed from strain at `t` alone — the plugin needs the most recent committed state. All plastic plugins. | The solver enforces the committed/trial split, allows `previousTrialState` retention to keep the active set warm during line-search backtracking. |
| `requiresPlasticLineSearch` | Newton may overshoot a yield-branch transition. | Armijo line search around each Newton step; line-search-derived load-step cutback is honoured. |
| `supportsPredictorProjection` | The plugin can project an inadmissible K0 predictor onto its yield surface. | At seed time, the solver requests projection via `projectInadmissibleOntoMc: true` in the seed options; the depth-banded warning is emitted. |
| `supportsPlasticGeostaticPhase` | The plugin can run a self-weight-only Newton solve before the service phase. | The plastic-geostatic phase is enabled; that phase forces GMRES regardless of `activeCount` and uses a longer `maxLoadSteps` budget. |
| `supportsTensionCutoff` | The plugin enforces a Mohr-Coulomb-style tension cut-off in addition to its primary yield surface. | Run record exposes tension-cutoff active counts; UI warning bins are populated. |
| `supportsExactReturnMapping` | The plugin runs a multi-surface active-set return mapping with a per-Gauss admissibility certificate. | The run record exposes active-surface counts (face / edge / apex), exact branch kinds, and the elastic-globalisation tangent path is allowed. The displacement-norm tolerance is relaxed because the residual already certifies admissibility. |
| `supportsCphiSafetyReduction` | The plugin re-evaluates correctly with safety-reduced parameters (cohesion / `tan(phi)` / `sigmaT` divided by ΣMsf). | The c-phi safety analysis is permitted; otherwise the safety phase is rejected at run-start. |
| `requiresStableActiveSetAtConvergence` | Convergence requires `changedCount === 0` at the final iteration (the model relies on a settled active set). True for `mc-reduced-stiffness`. | The convergence acceptance condition gates on `changedCount === 0`. False for `mc-plastic` because exact return mapping certifies admissibility per Gauss point. |

---

## 3. The update function

```ts
update({ strainTrial6, committedState, materialParameters, analysisContext }) → {
  stressTrial6, tangent6x6, trialState, diagnostics
}
```

### Inputs

- `strainTrial6` — total trial strain (6-component Voigt convention, the same one used everywhere in `material-models.js`).
- `committedState` — last committed material-point state (state from the previous accepted load step).
- `materialParameters` — usually the plugin's own; may be a c-phi reduced override.
- `analysisContext` — bookkeeping the solver passes through:
  - `stage` — string label (`'initial-gravity'`, `'service'`, `'final-recovery'`, …)
  - `loadFactor` — current load factor in [0, 1]
  - `useElasticGlobalizationTangent` — when `true`, return the elastic tangent for Newton even if the plastic corrector is engaged (used for early globalisation; the solver only requests this for plugins with `supportsExactReturnMapping`)
  - `previousTrialState` — most recent trial state (so the plugin can retain the active set during line-search backtracking)
  - `elementIndex`, `gpIndex`, `integrationPointIndex`, `regionIndex` — locator
  - `projectInadmissibleOntoMc` — at seed time, request that an inadmissible K0 predictor be projected onto the yield surface (`mc-plastic` only)

### Outputs

- `stressTrial6` — updated trial effective stress (6-component Voigt, tension-positive).
- `tangent6x6` — algorithmic tangent for the next Newton iteration.
- `trialState` — full material-point state to write back. Use `createMaterialPointState({ ...committed, ... })` so every field is filled.
- `diagnostics` — record carrying the common fields below plus any plugin-specific data:

| Common diagnostic field | Set to |
|---|---|
| `constitutiveModel` | The plugin's `kind`. |
| `currentlyMcActive` | Whether this Gauss point is currently plastic-active (false for linear elastic). |
| `hasEverExceededMc` | History flag; true once the point ever exceeded the yield surface. |
| `etaMcCurrent` | Current MC utilization ratio. `Number.POSITIVE_INFINITY` when a tension-controlled state suppresses MC eta. |
| `etaMcMaxHistory` | Running max of `etaMcCurrent`. |
| `activeYieldSurface` | One of the `YIELD_SURFACE_*` constants from `material-models.js`. |
| `plasticIncrementNorm` | L2 norm of the plastic strain increment in this update (0 for elastic plugins). |
| `localIterations` | Iterations spent in any inner local solve (0 for closed-form plugins). |

Plugin-specific diagnostics (e.g. `fMcTrial`, `etaMcTrial`, `exactBranchKind`,
`activeSurfaceIds`, `tangentConditionNumber`) live alongside the common fields
and are exposed on the integration-point record for downstream visualisation.
The solver itself never reads them.

---

## 4. Registration

```js
// my-fancy-soil-plugin.js
import { emptyCapabilities, registerMaterialPlugin } from './material-plugin.js';

export function createFancySoilPlugin(materialParameters, warnings = []) {
  const capabilities = emptyCapabilities();
  capabilities.tracksYieldSurface = true;
  capabilities.isPathDependent = true;
  capabilities.algorithmicTangentMayBeUnsymmetric = true;
  capabilities.requiresPlasticLineSearch = true;
  capabilities.supportsExactReturnMapping = true;
  capabilities.supportsPredictorProjection = true;
  capabilities.supportsPlasticGeostaticPhase = true;
  capabilities.supportsTensionCutoff = true;
  capabilities.supportsCphiSafetyReduction = true;

  return {
    kind: 'fancy-soil',
    displayName: 'Fancy Soil with cap',
    capabilities,
    materialParameters,
    elasticTangent6x6: /* compute */,
    initialTangent6x6: /* compute */,
    update({ strainTrial6, committedState, materialParameters, analysisContext }) {
      // … the actual constitutive update
      return { stressTrial6, tangent6x6, trialState, diagnostics };
    }
  };
}

registerMaterialPlugin('fancy-soil', createFancySoilPlugin);
```

That single registration call wires the plugin into:
- `createMaterialModelForOptions(options.constitutiveModel = 'fancy-soil')`
- The capability-driven solver paths (Krylov choice, line search, plastic-geostatic phase, c-phi safety)
- The run-record metadata (`linearAlgebraBackend`, `solver.constitutiveModel`)

No solver edits, no GPU edits.

---

## 5. The GPU pipeline is plugin-agnostic by construction

The GPU offloads exactly four operations:

1. **Sparse matvec (Krylov inner loop)** — element-type-agnostic *and*
   constitutive-model-agnostic. Sees only the assembled global K in
   ELLPACK form.
2. **Element strain** — `B · u`. Independent of constitutive model.
3. **Element internal force** — `B^T · σ`. The plugin's `update` produces
   `σ` per Gauss point on the CPU; the solver scatters into a flat
   stress array, the GPU computes the integration on the same array.
4. **Element elastic stiffness** — `B^T D B` with the *initial* (elastic)
   tangent. The plugin advertises this tangent via `elasticTangent6x6`;
   the GPU consumes it as a flat 9-float (broadcast) or 27-float (per-GP)
   uniform.

The constitutive update itself runs on the CPU per Gauss point. This is
deliberate:
- Most update functions are branchy (active-set transitions, return
  mapping iterations) and don't vectorise well on GPU.
- The Gauss-point work is embarrassingly parallel even on CPU and
  benefits from memory locality.
- The expensive linear algebra (matvec) IS on GPU and amortises the
  per-iteration work.

Because the GPU touches only `B`, `area`, `dofs`, `tangent`, `stress`,
and `displacement` — none of which carry plugin identity — the GPU
pipeline is plugin-agnostic by construction. Adding a new plugin
automatically benefits from the GPU acceleration without any GPU edits.

---

## 6. Worked example: existing plugins

| Plugin | `isLinearElastic` | `tracksYieldSurface` | `algorithmicTangentMayBeUnsymmetric` | `isPathDependent` | `requiresPlasticLineSearch` | `supportsPredictorProjection` | `supportsPlasticGeostaticPhase` | `supportsTensionCutoff` | `supportsExactReturnMapping` | `supportsCphiSafetyReduction` | `requiresStableActiveSetAtConvergence` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `linear-elastic` | ✓ | | | | | | | | | | |
| `mc-reduced-stiffness` | | ✓ | | ✓ | | | | ✓ | | ✓ | ✓ |
| `mc-plastic` | | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | |

The matrix lives next to the factories in `material-models.js`; this doc
mirrors it for cross-reference. If the matrix here disagrees with the
code, the code wins — the validator catches missing capabilities at
module load time.

---

## 6A. Hardening Soil — WASM-only plugin exception

The Hardening Soil (HS) plugin (Schanz, Vermeer & Bonnier 1999) is the first
plugin in this codebase that ships **without a JavaScript reference
implementation**. See
[`docs/features/hardening-soil-model.md`](../features/hardening-soil-model.md)
for the full feature specification.

The contract above describes the JS plugin registry. HS deliberately does
not participate in that registry:

```js
// material-plugin.js (unchanged for HS):
registerMaterialPlugin('linear-elastic', ...);
registerMaterialPlugin('mc-reduced-stiffness', ...);
registerMaterialPlugin('mc-plastic', ...);
// NO registerMaterialPlugin('hardening-soil', ...) — by design.
```

Instead, HS is dispatched entirely on the C++ side inside the WASM
solver. The relevant entry points are:

- `src/wasm/deformation/material_hs.hpp` — the HS constitutive update
  (cone return, cap return, corner Newton, tension cutoff hierarchy,
  plane-strain σ<sub>zz</sub> inner Newton). Analogous in role to
  `material_mc_exact.hpp`.
- `src/wasm/deformation/solver.hpp` — `evaluate_gp_response_ex` dispatches
  to `material_hs::update(...)` when `RegionParams::constitutive ==
  ConstitutiveKind::HardeningSoil`. Same Gauss-point evaluation interface
  as the other plugins; the dispatch is a `switch` on the constitutive
  kind tag, not a registry lookup.
- The JS reference path (`src/lib/cpt-app/deformation/solver.js`) rejects
  any HS analysis at run-start with an explicit error message pointing
  the user at the WASM backend (which is the default; this only matters
  if the JS reference backend has been selected explicitly).
- The GPU pipeline (`gpu-v2-newton.js`) also rejects HS through the
  existing "GPU does not support this constitutive model" path.

### Why no JS plugin

1. **HS is algebraically heavier than MC.** Two yield surfaces, three
   reference stiffnesses, a power-law in confinement, a hyperbolic
   primary-loading curve, and a separate cap hardening law. A faithful
   JavaScript port would roughly double the maintenance surface for no
   production benefit, because the WASM CPU path is the production
   solver.
2. **The verification oracle for HS is analytical, not registry-based.**
   The existing `verify_wasm_mc_local_parity.mjs` pattern uses the JS
   plugin as a bit-level oracle for the WASM port. For HS the oracle
   becomes closed-form single-element solutions (drained triaxial CD at
   multiple confining pressures, oedometric NC and unload-reload paths,
   K<sub>0,nc</sub> path) plus a small number of PLAXIS-equivalent
   multi-element benchmarks.
3. **The plugin-registry contract is still respected in spirit on the
   WASM side.** The capability flags HS satisfies (see the HS spec §5.6)
   are documented as if HS were a registered plugin, even though no JS
   instance is ever created. The WASM dispatch in `solver.hpp` enforces
   the same per-flag solver-behaviour rules (GMRES dispatch for
   non-associated flow, plastic line search, predictor projection,
   plastic geostatic phase, c-φ safety reduction). The flags are
   informational from JS's point of view but are the same contract.

### Production solver-dispatch contract for HS

Per the [hardening-soil-fix.md](../features/hardening-soil-fix.md) Phase
6/7/8 work and the binding contract in
[hardening-soil-model.md §3.6.1](../features/hardening-soil-model.md):

- `algorithmicTangentMayBeUnsymmetric = true` is enforced in the WASM
  dispatch.  HS plastic Newton iterations dispatch to GMRES; CG is
  reserved for the elastic HS branch and for symmetric mc-plastic.
- Routing a known-unsymmetric HS plastic tangent to CG is a debug-
  assert violation in `solver.hpp` (assertions fire in the nonlinear-
  phase Newton loop and the safety arc-length path).
- No tangent symmetrization is applied to HS — the
  `symmetrizeEpTangent` flag in `RegionParams` is wired for mc-plastic
  only and dropped on the HS dispatch path.
- Elastic-tangent modified Newton (`useElasticGlobalizationTangent` in
  the assembler) is retained as a diagnostic robust-mode rescue for
  mc-plastic and HS in service / safety phases, never as the default.

### Practical consequences for plugin authors

If a future constitutive model is light enough to warrant a JS reference
implementation (Cam-Clay, MCC, Drucker-Prager), follow the original §1–§5
contract above; register a factory with `registerMaterialPlugin` and the
solver picks it up.

If a future model is heavy and JS would be a maintenance liability (HS,
HSsmall, generalised plasticity with internal-variable evolution), use
the HS pattern instead: extend `ConstitutiveKind`, add a new
`material_<name>.hpp` with the constitutive update, dispatch from
`evaluate_gp_response_ex` in `solver.hpp`, extend the wire format with
the new region payload and per-GP state fields, and reject the model
explicitly in the JS reference path with a clear error.

The plugin registry remains the right pattern for any model where a JS
implementation is realistic. The WASM-only pattern is the documented
exception for algebraically heavy plugins that would otherwise force a
costly JavaScript port with no production benefit.

---

## 7. Verification gates

Any new plugin must, at minimum, pass these gates from
`verify_deformation_phase_1.mjs` (current canonical suite) before
becoming a default-allowed `constitutiveModel` option in the UI:

1. **Patch test** — A linear strain field on a small mesh recovers the
   correct stress / strain to f64 precision (`1e-9` relative). Drives
   the plugin's update with a known input and checks the output.
2. **Round-trip elastic unloading** — Load to plasticity, unload to
   zero — the plastic strain accumulated must be preserved and the
   final state must lie inside the yield surface.
3. **Symmetric / non-associated tangent** — If
   `algorithmicTangentMayBeUnsymmetric` is false, the algorithmic
   tangent is verified symmetric. If true, the GMRES path is exercised.
4. **Plastic-geostatic phase** — If the flag is true, a small
   self-weight-only run on a slope mesh reaches at least 80 % of the
   full gravity factor. Verifies the predictor projection and the
   phase's GMRES dispatch.
5. **C-phi safety reduction** — If the flag is true, a reduced-strength
   run produces a sensible factor of safety bracket.
6. **GPU parity** — Same problem with `useGpuAcceleration: true` and
   `false` produces results within `1e-3` to `1e-2` relative on max
   settlement and MC utilisation. Tests that the plugin's update
   handles f32 / double-single inputs gracefully.

Existing cases 1, 1a, 1b, 1c, 1d, 1f, 1fa, 1fb, 1g, 1ga, 42, 43, 44 from
the suite already cover these for the three built-in plugins; new
plugins extend with siblings of those cases.
