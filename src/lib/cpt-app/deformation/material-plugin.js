// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck

// ============================================================================
// Material plugin contract for the deformation solver
// ============================================================================
//
// The deformation solver is constitutive-model-agnostic by construction:
// every material — linear elastic, Mohr-Coulomb reduced stiffness, exact MC
// elastoplastic with tension cut-off — is registered here as a "plugin"
// implementing the same documented interface. The solver dispatches through
// this registry; it never switches on a model name string. Behaviour that
// is genuinely model-specific (line search, GMRES vs CG, predictor
// projection, plastic-geostatic equilibration, etc.) is selected through
// CAPABILITY FLAGS the plugin advertises, never through `kind === 'X'`
// comparisons.
//
// To add a new constitutive model, an author writes one factory function
// returning the plugin object documented below and calls
// `registerMaterialPlugin(name, factory)` once at module load time. No
// other file in the deformation pipeline needs to change.
//
// ## Plugin object contract
//
// Every plugin must return an object with the following shape from its
// factory. The factory signature is `(materialParameters, warnings) => Plugin`.
//
// ```
// {
//   // Stable identifier; used by the registry, the run record, and the UI.
//   kind: 'linear-elastic' | 'mc-reduced-stiffness' | 'mc-plastic' | string,
//
//   // The capability flags below drive solver behaviour. Plugins are
//   // expected to set EVERY flag explicitly so a future solver change
//   // adding a new flag never silently activates an unwired path. See
//   // MATERIAL_CAPABILITY_KEYS for the full enumeration.
//   capabilities: { ... },
//
//   // The same materialParameters that were passed in. Plugins must NOT
//   // store a different reference; the solver mutates this object during
//   // safety c-phi reduction by replacing it on the material point and
//   // expects the plugin's `update` to honour the new parameters.
//   materialParameters: object,
//
//   // 6x6 plane-strain elastic tangent and initial tangent (which may
//   // differ for plugins with state-dependent initial stiffness). Both
//   // are square arrays of arrays for the 6-component Voigt convention
//   // [exx, eyy, ezz, gxy, gyz, gxz] used throughout material-models.js.
//   elasticTangent6x6: number[6][6],
//   initialTangent6x6: number[6][6],
//
//   // Constitutive update at one Gauss point.
//   //
//   // Inputs:
//   //   strainTrial6     — total trial strain (6-component Voigt)
//   //   committedState   — last committed material-point state
//   //   materialParameters — usually the plugin's own, but may be a safety
//   //                        c-phi reduced override (see analysisContext)
//   //   analysisContext  — bookkeeping the solver passes through:
//   //     * stage              — string label (initial-gravity, service, ...)
//   //     * loadFactor         — current load factor
//   //     * useElasticGlobalizationTangent — when true, return the elastic
//   //                            tangent for Newton even if the plastic
//   //                            corrector is engaged (used during early
//   //                            globalisation and reset paths)
//   //     * previousTrialState — most recent trial state (active-set retention)
//   //     * elementIndex, gpIndex, integrationPointIndex, regionIndex
//   //     * projectInadmissibleOntoMc — seed-time projection (mc-plastic only)
//   //
//   // Output:
//   //   stressTrial6  — updated trial effective stress (6-component Voigt,
//   //                   tension-positive convention used by material-models.js)
//   //   tangent6x6    — algorithmic tangent for the next Newton iteration
//   //   trialState    — full material-point state to write back
//   //   diagnostics   — a record with the COMMON fields below, plus a
//   //                   plugin extension namespace (`diagnostics.plugin`)
//   //                   for kind-specific data. The solver's run record
//   //                   propagates the common fields; plugin-specific
//   //                   diagnostics are exposed on the integration-point
//   //                   record for downstream visualisation.
//   //
//   // Common diagnostic fields (every plugin must populate):
//   //   constitutiveModel, currentlyMcActive, hasEverExceededMc,
//   //   etaMcCurrent, etaMcMaxHistory, activeYieldSurface,
//   //   plasticIncrementNorm, localIterations
//   update({ strainTrial6, committedState, materialParameters, analysisContext }) → {
//     stressTrial6, tangent6x6, trialState, diagnostics
//   }
// }
// ```
//
// ## Capability flags
//
// Each flag answers a precise solver question. They are ALL booleans; the
// solver gates a single behaviour on each one. Plugins should set them
// explicitly even if the value is `false` (no implicit defaults).
//
// See `MATERIAL_CAPABILITY_KEYS` below for the canonical list. The
// `assertMaterialPluginShape` helper verifies a plugin returns one boolean
// per flag — its job is to catch silent mis-registration at module load.

export const MATERIAL_CAPABILITY_KEYS = Object.freeze([
  // Constitutive update is purely state-free: the trial stress is a
  // linear function of the trial strain, with no history and no yield
  // surface to enforce. Linear-elastic only. Solver consequence: the
  // residual is reproducible exactly across a load step, the Krylov
  // tolerance can be relaxed, line search is unnecessary.
  'isLinearElastic',

  // Plugin maintains a yield surface and may transition Gauss points
  // between elastic and plastic regimes. Solver consequence: track
  // active-set churn, expose plastic exceedance counts, treat
  // diagnostics' plastic fields as load-bearing.
  'tracksYieldSurface',

  // The algorithmic tangent returned by `update` may be unsymmetric
  // (e.g. non-associated MC, where the plastic potential and yield
  // surface have different normals). Solver consequence: switch the
  // Krylov inner solver from CG to GMRES (or BiCGStab) for this run.
  'algorithmicTangentMayBeUnsymmetric',

  // The constitutive update is path-dependent: the trial state at load
  // factor t > 0 cannot be recomputed from the strain at t alone; the
  // plugin needs the most recently committed state. Plastic models are
  // path-dependent; linear elastic is not. Solver consequence: reset
  // material-point trial state on every step retry, enforce the
  // committed/trial split, allow `previousTrialState` retention to keep
  // the active-set warm during line search.
  'isPathDependent',

  // Plastic correctors are non-quadratic and Newton may overshoot a
  // yield-surface transition. Solver consequence: enable the Armijo
  // line search around each Newton step, enable warm-start of the
  // linear solve, allow plastic quasi-convergence.
  'requiresPlasticLineSearch',

  // The plugin can turn an inadmissible K0 predictor (initial stress
  // outside its yield surface) into an admissible seed by projecting
  // onto the surface. Solver consequence: at material-point seeding
  // time, request projection via `projectInadmissibleOntoMc: true`;
  // emit the corresponding warning bins.
  'supportsPredictorProjection',

  // The plugin participates in the plastic-geostatic equilibration
  // phase: a self-weight-only Newton solve before any service load is
  // applied, used to grow plastic zones starting from a K0 predictor.
  // Solver consequence: force GMRES for that phase, allow longer
  // initial-gravity load-step budgets, enable predictor projection.
  'supportsPlasticGeostaticPhase',

  // The plugin enforces a Mohr-Coulomb tension cut-off in addition to
  // the shear yield surface. Used for diagnostic labels and for the
  // tension-cutoff active-element counters in the run record.
  'supportsTensionCutoff',

  // The plugin advertises an exact return-mapping algorithm with
  // multi-surface active-set bookkeeping (the exact MC implementation
  // in material-models.js). The run record exposes the active-surface
  // counts (face/edge/apex) and exact branch kinds when this is true.
  'supportsExactReturnMapping',

  // The plugin supports the c-phi safety reduction: parameters can be
  // reduced (cohesion / tan(phi) / sigmaT divided by ΣMsf) and the
  // material plugin re-evaluates with the reduced strength. Solver
  // consequence: c-phi safety analysis is permitted; otherwise the
  // safety phase is rejected at run-start.
  'supportsCphiSafetyReduction',

  // The plugin's Newton iterations may converge with a non-zero number
  // of state changes (active-set still churning) if the residual is
  // tight. Used as the inverse of "requires stable active set". The
  // mc-reduced-stiffness model requires a stable active set; the
  // exact mc-plastic model does not (its return map already enforces
  // admissibility per Gauss point). Solver consequence: gate the
  // convergence acceptance condition on `changedCount === 0`.
  'requiresStableActiveSetAtConvergence'
]);

const REQUIRED_DIAGNOSTIC_KEYS = Object.freeze([
  'constitutiveModel',
  'currentlyMcActive',
  'hasEverExceededMc',
  'etaMcCurrent',
  'etaMcMaxHistory',
  'activeYieldSurface',
  'plasticIncrementNorm',
  'localIterations'
]);

// ============================================================================
// Registry
// ============================================================================
//
// Plugins register themselves at module load time. Lookup is by string
// name (the same `constitutiveModel` option the existing UI emits). The
// registry is a private module-scoped Map; consumers go through
// `materialPluginFor` so we can never accidentally bypass shape validation.

const PLUGIN_REGISTRY = new Map();

function assertMaterialPluginShape(name, plugin) {
  if (!plugin || typeof plugin !== 'object') {
    throw new Error(`Material plugin '${name}' factory returned ${plugin === null ? 'null' : typeof plugin}; expected an object.`);
  }
  if (typeof plugin.kind !== 'string' || !plugin.kind) {
    throw new Error(`Material plugin '${name}' is missing a non-empty 'kind' string.`);
  }
  if (typeof plugin.update !== 'function') {
    throw new Error(`Material plugin '${name}' is missing the 'update' function.`);
  }
  if (!Array.isArray(plugin.elasticTangent6x6) || plugin.elasticTangent6x6.length !== 6) {
    throw new Error(`Material plugin '${name}' is missing a 6×6 elasticTangent6x6.`);
  }
  if (!Array.isArray(plugin.initialTangent6x6) || plugin.initialTangent6x6.length !== 6) {
    throw new Error(`Material plugin '${name}' is missing a 6×6 initialTangent6x6.`);
  }
  if (!plugin.capabilities || typeof plugin.capabilities !== 'object') {
    throw new Error(`Material plugin '${name}' is missing the capabilities object.`);
  }
  for (const key of MATERIAL_CAPABILITY_KEYS) {
    if (typeof plugin.capabilities[key] !== 'boolean') {
      throw new Error(`Material plugin '${name}' is missing a boolean capability '${key}'. Plugins must set every capability explicitly.`);
    }
  }
  // Display labels are optional but recommended; we synthesize defaults
  // from the plugin kind so the solver's progress messages and run
  // record never need a model-name `switch`.
  if (typeof plugin.displayName !== 'string' || !plugin.displayName) {
    plugin.displayName = humanizePluginKind(plugin.kind);
  }
  if (typeof plugin.shortDisplayName !== 'string' || !plugin.shortDisplayName) {
    plugin.shortDisplayName = plugin.displayName;
  }
}

function humanizePluginKind(kind) {
  switch (String(kind || '').toLowerCase()) {
    case 'linear-elastic': return 'Linear elastic';
    case 'mc-reduced-stiffness': return 'Stage 1 MC-active reduced-stiffness';
    case 'mc-plastic': return 'Stage 2 elastoplastic';
    default: return kind || 'material';
  }
}

export function registerMaterialPlugin(name, factory) {
  if (typeof name !== 'string' || !name) {
    throw new Error(`registerMaterialPlugin: name must be a non-empty string (got ${typeof name}).`);
  }
  if (typeof factory !== 'function') {
    throw new Error(`registerMaterialPlugin('${name}'): factory must be a function (got ${typeof factory}).`);
  }
  PLUGIN_REGISTRY.set(name, factory);
}

export function listRegisteredMaterialPlugins() {
  return Array.from(PLUGIN_REGISTRY.keys());
}

export function hasMaterialPlugin(name) {
  return PLUGIN_REGISTRY.has(String(name || ''));
}

// Resolve a plugin instance for a (name, materialParameters) pair. The
// plugin shape is validated on every call so a bad factory is caught at
// the place that asks for the plugin, not somewhere downstream where the
// failure mode would be a misleading NaN.
export function materialPluginFor(name, materialParameters, warnings = []) {
  const factory = PLUGIN_REGISTRY.get(name);
  if (!factory) {
    const known = listRegisteredMaterialPlugins().join(', ') || '<none>';
    throw new Error(`materialPluginFor: no material plugin registered as '${name}'. Known plugins: ${known}.`);
  }
  const plugin = factory(materialParameters, warnings);
  assertMaterialPluginShape(name, plugin);
  return plugin;
}

// Helpers — small, plugin-author convenience.
export function emptyCapabilities() {
  // A capability template with every flag set to false; plugin factories
  // start from this and flip the ones that apply. The pattern keeps the
  // capability list visible in the factory itself, so a reviewer can see
  // exactly what the plugin claims without cross-referencing this file.
  const out = {};
  for (const key of MATERIAL_CAPABILITY_KEYS) out[key] = false;
  return out;
}

export function ensureRequiredDiagnosticFields(pluginKind, diagnostics) {
  // Defensive helper plugins can call to make sure their diagnostic
  // record has every field the solver expects. Returns the same object
  // (mutated). Intended for tests; not used on the hot path.
  for (const key of REQUIRED_DIAGNOSTIC_KEYS) {
    if (!(key in (diagnostics || {}))) {
      throw new Error(`Material plugin '${pluginKind}' produced diagnostics without required field '${key}'.`);
    }
  }
  return diagnostics;
}
