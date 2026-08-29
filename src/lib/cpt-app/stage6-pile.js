// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// TEMPORARY re-export — the module moved to src/lib/cpt-app/pile/compute.js (refactor step 7,
// PR 12b) and nothing in the tree imports this path any more. It exists only so that verifiers
// which load the *base* controller of a ref that predates the move through a copy placed in this
// directory (scripts/verify_bearing.mjs, scripts/verify_stage6_shell.mjs: `git show
// integration-r:…legacy-controller.js`, which still imports './stage6-pile') keep resolving while
// PR 12b is not yet on that ref. Delete it (and stage6-pile-canvas.js) once integration-r contains
// the pile package; scripts/verify_pile.mjs does not need it (it materialises the base's own copies).
export * from './pile/compute.js';
