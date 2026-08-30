// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/index.js — public surface of the Stage 6 shell package (01-monolith-map.md §6.1 row
// `stage6/`, extracted in PR 11 / refactor step 6).
//
//   registry.js      createStage6Registry({retaining, bishopEnabled}) → ordered app list with
//                    cardMeta + per-app state; STAGE6_APP_ORDER, STAGE6_DEFAULT_APP, enabledApps
//   state.js         defaults(registry) == stage6Defaults(), ensure(stage6, ctx) / ensureCpt(cpt, ctx)
//                    == ensureStage6State(), layerBottom(cpt) == stage6MaxDepth(); merge/get/set
//   ui-state.js      <details data-st6details> open state + scroll capture/restore
//   field-setter.js  coerceFieldValue / setField — the typed write of setStage6Field
//   shell.js         createStage6Shell(ctx) → { render, cardsHtml, sharedBanner, appIcon }
//   apps/*-state.js  defaults() / ensure(stage6, env) per app (bearing, pile, settlement,
//                    dewatering, beam, bishop); retwall's come from the installed retaining/ package
//
// PR 20 (refactor step 10) added `installStage6App(ctx)` at the bottom: one install that builds
// the registry and the shell, binds the state / <details> / field-setter helpers to the active
// CPT, and returns the Stage 6 `handlers`. The controller keeps every old name (stage6Defaults,
// ensureStage6State, renderStage6, stage6CardsHtml, …) as a binding of that install.

export {
  STAGE6_APP_ORDER,
  STAGE6_DEFAULT_APP,
  STAGE6_ICON_FALLBACK,
  createStage6Registry,
  registryEntry,
  enabledApps
} from './registry.js';
export { defaults, ensure, ensureCpt, layerBottom, STATE_KEY_ORDER, merge, get, set } from './state.js';
export {
  uiState,
  rememberDetailsState,
  detailsOpen,
  setDetailsOpen,
  STAGE6_SCROLL_PERSIST_SELECTORS,
  scrollTargetBaseKey,
  scrollTargets,
  captureScrollState,
  restoreScrollState
} from './ui-state.js';
export { coerceFieldValue, setField } from './field-setter.js';
export { createStage6Shell, stage6IconSvg, STAGE6_NO_LAYERS_HTML } from './shell.js';
export * as bearingState from './apps/bearing-state.js';
export * as pileState from './apps/pile-state.js';
export * as settlementState from './apps/settlement-state.js';
export * as dewateringState from './apps/dewatering-state.js';
export * as beamState from './apps/beam-state.js';
export * as bishopState from './apps/bishop-state.js';

import { createStage6Registry as buildRegistry } from './registry.js';
import { defaults as stateDefaults, ensureCpt as ensureCptState, layerBottom } from './state.js';
import {
  uiState,
  rememberDetailsState as rememberDetails,
  detailsOpen as detailsOpenOf,
  setDetailsOpen as setDetailsOpenOf
} from './ui-state.js';
import { setField as setFieldOf } from './field-setter.js';
import { createStage6Shell as buildShell } from './shell.js';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// installStage6App(ctx) — the Stage 6 shell bound to a host (PR 20 / refactor step 10).
//
// The registry and the shell were already built by the controller; what moves here is everything
// around them that read `S` — the state schema wrappers (`stage6Defaults`, `ensureStage6State`,
// `stage6MaxDepth`), the `<details>` memory, the bishop UI-state accessor and the two field
// setters. Bodies verbatim; `S` is `ctx.getActive()`.
//
//   ctx.document, ctx.getActive(),
//   ctx.retaining                     the installed retaining/ app (its state joins the registry)
//   ctx.bishopEnabled()               whether the Seep/Slope card is offered
//   ctx.apps                          the per-app adapters the shell renders through
//   ctx.workingLayers()               the Stage 4 → Stage 6 layer contract
//   ctx.hardeningSoilUi               STAGE6_ENABLE_HARDENING_SOIL_UI — the composed ensure()'s gate
//   ctx.deformationQuantityIds(...)   the Seep/Slope contour catalogue the migration calls back into
//   ctx.refreshBearingPreview()       setStage6Field's `bearing.Df` fast path
//
// `defaults()` is called from `newCptState()`, so the install has to run before PROJECT is built;
// everything it needs from later installs is reached through a ctx closure, never at install time.
export function installStage6App(ctx){
  const { document, getActive } = ctx;

  const registry = buildRegistry({
    retaining: ctx.retaining,
    bishopEnabled: () => ctx.bishopEnabled()
  });

  const app = {
    registry,

    defaults: () => stateDefaults(registry),

    /* Host hooks of the composed ensure(): the registry, the hardening-soil UI gate and the one
       Seep/Slope helper the state migration calls back into (seepslope/state/ensure.js header). */
    ensureCtx: () => ({
      registry,
      hardeningSoilUi: ctx.hardeningSoilUi,
      deformationQuantityIds: (analysisType, hasHs) => ctx.deformationQuantityIds(analysisType, hasHs)
    }),

    ensure(){
      ensureCptState(getActive(), app.ensureCtx());
    },

    maxDepth: () => layerBottom(getActive()),

    rememberDetailsState(){
      const root = document.getElementById('stage6Area');
      if(!root) return;
      app.ensure();
      rememberDetails(getActive().stage6, root);
    },

    detailsOpen(key){
      app.ensure();
      return detailsOpenOf(getActive().stage6, key);
    },

    setDetailsOpen(key, open = true){
      app.ensure();
      setDetailsOpenOf(getActive().stage6, key, open);
    },

    uiState(){
      app.ensure();
      return uiState(getActive().stage6);
    },

    setStage6Field(field, value){
      const S = getActive();
      app.ensure();
      app.rememberDetailsState();
      setFieldOf(S.stage6, app.defaults(), field, value);
      if(field === 'bearing.Df' && S.stage6.app === 'bearing'){
        ctx.refreshBearingPreview();
        return;
      }
      app.render();
    },

    setStage6App(appId){
      const S = getActive();
      app.ensure();
      app.rememberDetailsState();
      if(appId === 'bishop' && !ctx.bishopEnabled()) return;
      S.stage6.app = appId;
      app.render();
    }
  };

  const shell = buildShell({
    registry,
    getState: getActive,
    ensure: () => app.ensure(),
    rememberDetailsState: () => app.rememberDetailsState(),
    workingLayers: () => ctx.workingLayers(),
    apps: ctx.apps
  });
  app.shell = shell;
  app.render = () => shell.render();
  app.cardsHtml = (appId) => shell.cardsHtml(appId);
  app.sharedBanner = () => shell.sharedBanner();
  app.appIcon = (id) => shell.appIcon(id);

  app.handlers = {
    stage6Defaults: app.defaults,
    ensureStage6State: app.ensure,
    setStage6Field: app.setStage6Field,
    setStage6App: app.setStage6App,
    renderStage6: app.render
  };
  return app;
}
