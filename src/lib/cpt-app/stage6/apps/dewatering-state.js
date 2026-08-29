// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/apps/dewatering-state.js — the dewatering app's state schema moved into its package with
// refactor step 7 (PR 12c): src/lib/cpt-app/dewatering/state.js is the single source of truth. This
// re-export keeps the `dewateringState` namespace of stage6/index.js.
export { defaults, ensure } from '../../dewatering/state.js';
