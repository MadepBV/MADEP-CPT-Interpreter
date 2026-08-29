// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/apps/pile-state.js — the pile app's state schema moved into its package with refactor
// step 7 (PR 12b): src/lib/cpt-app/pile/state.js is the single source of truth. This re-export
// keeps the `pileState` namespace of stage6/index.js and the registry's fallback entry working.
export { defaults, ensure } from '../../pile/state.js';
