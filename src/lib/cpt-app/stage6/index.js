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
// legacy-controller.js keeps every old name (stage6Defaults, ensureStage6State, renderStage6,
// stage6CardsHtml, …) as a wrapper over these; the per-app render functions stay there until step 7.

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
