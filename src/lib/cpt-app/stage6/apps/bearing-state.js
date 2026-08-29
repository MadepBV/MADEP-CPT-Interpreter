// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/apps/bearing-state.js — the bearing app's state schema moved into its package with
// refactor step 7 (PR 12a): src/lib/cpt-app/bearing/state.js is the one source of truth. This
// re-export keeps the `bearingState` namespace of stage6/index.js.
export { defaults, ensure } from '../../bearing/state.js';
