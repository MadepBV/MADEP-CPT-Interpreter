// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/registry.js — the ordered list of Stage 6 applications (01-monolith-map.md §6.1 row
// `stage6/`, refactor step 6). One entry per app card, in the order of the app switch
// (stage6CardsHtml, legacy-controller.js 11587-11610 at integration-r):
//
//   bearing · pile · settlement · dewatering · beam · retwall · bishop
//
// Each entry carries
//   id        the `S.stage6.app` value and the key of the app's state block / cache slot
//   short     the chip label of the app switch
//   cardMeta  { id, title, desc, icon } — the tab's tooltip text and its 18×18 line-art glyph
//             (inner SVG markup; stage6AppIcon in shell.js wraps it in the <svg> element)
//   state     { defaults(), ensure(stage6, env) } — the app's slice of the Stage 6 state schema
//   enabled   optional predicate; a disabled app is left out of the app switch and its selection
//             falls back to the first app (today only bishop has one, and it is always true)
//
// The retaining-walls app is the installed `retaining/` package (installRetainingApp(ctx)), so the
// registry is a factory: the host passes that instance in. The other six apps' state modules are
// pure and imported here directly; their render code still lives in the monolith until step 7.
import * as bearingState from './apps/bearing-state.js';
import * as pileState from './apps/pile-state.js';
import * as settlementState from './apps/settlement-state.js';
import * as dewateringState from './apps/dewatering-state.js';
import * as beamState from './apps/beam-state.js';
import * as bishopState from './apps/bishop-state.js';

/** App ids in app-switch order (the card order of the monolith). */
export const STAGE6_APP_ORDER = ['bearing', 'pile', 'settlement', 'dewatering', 'beam', 'retwall', 'bishop'];

/** The app selected by default and the fallback of a disabled selection. */
export const STAGE6_DEFAULT_APP = 'bearing';

// The 18×18 glyph bodies of stage6AppIcon (legacy-controller.js 11572-11585), verbatim.
const ICONS = {
  bearing:    '<path d="M2 12h14"/><rect x="6.5" y="3" width="5" height="6"/><path d="M3 12l1.5 3M15 12l-1.5 3M9 12v3"/>',
  pile:       '<path d="M2 5h14"/><rect x="7.5" y="5" width="3" height="11"/><path d="M2 5v2M16 5v2"/>',
  settlement: '<path d="M2 4h14"/><path d="M5 7v5M9 7v6M13 7v4"/><path d="M3.5 10.5L5 12l1.5-1.5M7.5 11.5L9 13l1.5-1.5M11.5 9.5L13 11l1.5-1.5"/>',
  dewatering: '<path d="M9 2c2.5 3 4 5 4 7a4 4 0 0 1-8 0c0-2 1.5-4 4-7z"/><path d="M2 15h14"/>',
  beam:       '<path d="M2 7h14"/><path d="M4 7l-1.5 3h3zM14 7l-1.5 3h3z"/><path d="M5 7v-2M9 7V5M13 7V5"/>',
  retwall:    '<path d="M3 15h12"/><path d="M5 15V4h2v9h6"/><path d="M9 11h5M9 8h5M9 5h5" stroke-width="0.9"/>',
  bishop:     '<path d="M2 15h14"/><path d="M3 15C3 8 8 4 15 4"/><path d="M4 13a9 9 0 0 1 9-7" stroke-dasharray="2 1.6"/>'
};

/** Glyph body for an unknown app id (the `default` branch of stage6AppIcon). */
export const STAGE6_ICON_FALLBACK = '<rect x="3" y="3" width="12" height="12" rx="2"/>';

/**
 * Build the registry.
 * @param {{ retaining: { cardMeta: {id, title, desc}, defaults: () => object, ensure: (stage6) => void },
 *           bishopEnabled?: () => boolean }} deps
 *   retaining     the installed retaining-walls app (its cardMeta / defaults / ensure are used as-is)
 *   bishopEnabled today's stage6BishopEnabled() (always true); kept as the `enabled` hook
 */
export function createStage6Registry({ retaining, bishopEnabled = () => true }) {
  const entry = (id, short, title, desc, state) => ({ id, short, cardMeta: { id, title, desc, icon: ICONS[id] }, state });
  const retwall = {
    id: retaining.cardMeta.id,
    short: 'Retaining walls',
    cardMeta: { id: retaining.cardMeta.id, title: retaining.cardMeta.title, desc: retaining.cardMeta.desc, icon: ICONS.retwall },
    state: { defaults: () => retaining.defaults(), ensure: (stage6) => retaining.ensure(stage6) }
  };
  const bishop = entry('bishop', 'Seep/Slope', 'Seep / Slope', 'Slope-stability, seepage and deformation workspace on the active CPT soil model.', bishopState);
  bishop.enabled = bishopEnabled;
  return [
    entry('bearing', 'Bearing', 'Bearing capacity', 'Drained and undrained shallow-foundation resistance vs founding depth.', bearingState),
    entry('pile', 'Piles', 'Pile capacity', 'Axial pile resistance and settlement from CPT (DM20 / De Beer).', pileState),
    entry('settlement', 'Settlement', 'Settlement', 'SLS settlement from CPT-derived E_oed with Boussinesq or 2:1 stress spread.', settlementState),
    entry('dewatering', 'Dewatering', 'Dewatering', 'Drawdown screening plus induced stress change and settlement at the CPT.', dewateringState),
    entry('beam', 'Beam/slab', 'Beam / slab on Winkler', '1D strip-on-elastic-foundation screening with EC2 reinforcement output.', beamState),
    retwall,
    bishop
  ];
}

/** Registry entry by app id, or null. */
export function registryEntry(registry, id) {
  return registry.find((a) => a.id === id) || null;
}

/** The entries shown in the app switch (every app whose `enabled` hook is absent or true). */
export function enabledApps(registry) {
  return registry.filter((a) => !a.enabled || a.enabled());
}
