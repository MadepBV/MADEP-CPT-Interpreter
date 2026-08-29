// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// core/css-tokens.js — read a CSS custom property (design token) off :root.
//
// Moved verbatim out of src/lib/cpt-app/legacy-controller.js (PR 4, refactor step 1):
//   readCssToken  3458-3461  (was defined in the Stage 5 region, used by 7
//                             functions across Stages 1, 5, 6 and the report)
// Resolves `document` / `getComputedStyle` as globals at call time, exactly as
// the monolith did, so the Node golden harness stubs keep working unchanged.

export function readCssToken(name, fallback){
  if(typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
