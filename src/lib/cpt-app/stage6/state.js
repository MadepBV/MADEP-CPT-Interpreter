// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/state.js — the Stage 6 state schema composed from the per-app state modules of the
// registry (01-monolith-map.md §1.2, §6.1 row `stage6/`, refactor step 6).
//
//   defaults(registry)        == the monolith's stage6Defaults() (legacy-controller.js 2230-2627
//                                at integration-r): { app, ui, retwall, bearing, settlement,
//                                dewatering, pile, beam, bishop } — same keys, same order, same values
//   ensure(stage6, ctx)       == ensureStage6State() minus its two CPT-level lines (2723-3119):
//                                merge of the defaults, then every app's ensure() with the shared
//                                inputs, then the disabled-app guard
//   ensureCpt(cpt, ctx)       the two CPT-level lines (`stage6` / `stage6Cache` creation) + ensure()
//   layerBottom(cpt)          stage6MaxDepth(): bottom of the last layer, 10 without layers
//
// The order of the state keys is NOT the app-switch order: the defaults literal listed retwall
// first and pile after dewatering, and a saved project serialises `stage6` in key order — so the
// literal's order is kept here (STATE_KEY_ORDER) and the app-switch order lives in the registry.
//
// `ctx` of ensure(): { registry, maxDepth (raw layer bottom), wt, hardeningSoilUi,
//                      deformationQuantityIds, migrateSurfaceLoadsShape } — the last three are the
// bishop migration's host hooks (apps/bishop-state.js header) until the seepslope package exists.
import { merge, get, set } from './merge.js';
import { STAGE6_DEFAULT_APP, registryEntry } from './registry.js';

export { merge, get, set };

/** Key order of the monolith's stage6Defaults() literal (after `app` and `ui`). */
export const STATE_KEY_ORDER = ['retwall', 'bearing', 'settlement', 'dewatering', 'pile', 'beam', 'bishop'];

function stateOrder(registry) {
  const known = STATE_KEY_ORDER.filter((id) => registryEntry(registry, id));
  const rest = registry.map((a) => a.id).filter((id) => !known.includes(id));
  return [...known, ...rest];
}

/** stage6Defaults(): the full Stage 6 state schema. */
export function defaults(registry) {
  const out = {
    app: STAGE6_DEFAULT_APP,
    ui: { details: {} }
  };
  for (const id of stateOrder(registry)) out[id] = registryEntry(registry, id).state.defaults();
  return out;
}

/** stage6MaxDepth(): bottom of the interpreted layer model (10 m without layers). */
export function layerBottom(cpt) {
  return cpt.layers.length ? cpt.layers[cpt.layers.length - 1].bot : 10;
}

/**
 * ensureStage6State() on an existing `stage6` object: fill missing keys from the defaults, run
 * every app's ensure() (retaining's own, then the clamps/migrations of the six monolith apps),
 * and drop a disabled selection back to the first app. Returns `stage6`.
 */
export function ensure(stage6, ctx) {
  const { registry } = ctx;
  merge(stage6, defaults(registry));
  const rawMaxDepth = ctx.maxDepth;
  const env = {
    maxDepth: Math.max(rawMaxDepth, 0.5),
    rawMaxDepth,
    wt: ctx.wt,
    hardeningSoilUi: ctx.hardeningSoilUi,
    deformationQuantityIds: ctx.deformationQuantityIds,
    migrateSurfaceLoadsShape: ctx.migrateSurfaceLoadsShape
  };
  for (const id of stateOrder(registry)) registryEntry(registry, id).state.ensure(stage6, env);
  const selected = registryEntry(registry, stage6.app);
  if (selected && selected.enabled && !selected.enabled()) stage6.app = STAGE6_DEFAULT_APP;
  return stage6;
}

/**
 * The CPT-level part of ensureStage6State(): create `cpt.stage6` from the defaults and the
 * volatile `cpt.stage6Cache` when missing, then ensure(). `ctx` as for ensure() without
 * `maxDepth` / `wt`, which are read from the CPT.
 */
export function ensureCpt(cpt, ctx) {
  if (!cpt.stage6) cpt.stage6 = defaults(ctx.registry);
  if (!cpt.stage6Cache) cpt.stage6Cache = {};
  return ensure(cpt.stage6, { ...ctx, maxDepth: layerBottom(cpt), wt: cpt.wt });
}
