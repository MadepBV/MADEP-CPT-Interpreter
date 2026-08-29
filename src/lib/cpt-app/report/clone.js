// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// report/clone.js — the JSON deep clone every Stage 7 payload part uses (functions,
// undefined and typed arrays do not survive it, which is what the report wants: the
// payload goes through localStorage as JSON). Moved verbatim out of
// src/lib/cpt-app/legacy-controller.js (PR 8; old lines 15830-15832 at c989770). The
// controller imports it back for the workspace captures that stay there until step 9g.

export function safeClone(value){
  return value == null ? value : JSON.parse(JSON.stringify(value));
}
