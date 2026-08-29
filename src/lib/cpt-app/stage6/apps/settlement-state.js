// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/apps/settlement-state.js — the settlement app's state schema moved into its package with
// refactor step 7 (PR 12c): src/lib/cpt-app/settlement/state.js is the single source of truth. This
// re-export keeps the `settlementState` namespace of stage6/index.js.
export { defaults, ensure } from '../../settlement/state.js';
