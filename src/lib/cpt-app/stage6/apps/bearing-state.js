// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/apps/bearing-state.js — state schema of the bearing-capacity app: the `bearing` block of
// stage6Defaults() (legacy-controller.js 2235-2249 at integration-r) and its clamps in
// ensureStage6State() (2729-2734), verbatim. `env.maxDepth` is the shell's clamped layer bottom
// (max(stage6MaxDepth(), 0.5)).

export function defaults(){
  return {
    foundationType:'strip',
    B:1.50,
    L:1.50,
    eB:0.00,
    eL:0.00,
    shapeMode:'hansen',
    load:150,
    factorMode:'ec7',
    xi:2.0,
    gammaRd:1.00,
    ec7Combination:'governing',
    Df:1.00,
    showMode:'both'
  };
}

/** Clamp the bearing config in place (same statements, same order as the monolith). */
export function ensure(stage6, env){
  const maxDepth = env.maxDepth;
  stage6.bearing.B = Math.max(+stage6.bearing.B || defaults().B, 0.1);
  stage6.bearing.L = Math.max(+stage6.bearing.L || stage6.bearing.B, 0.1);
  stage6.bearing.Df = Math.min(Math.max(+stage6.bearing.Df || 0.2, 0.2), maxDepth);
  stage6.bearing.eB = Math.max(0, Math.min(+stage6.bearing.eB || 0, Math.max((+stage6.bearing.B || 0.1) / 2 - 0.025, 0)));
  stage6.bearing.eL = Math.max(0, Math.min(+stage6.bearing.eL || 0, Math.max((+stage6.bearing.L || 0.1) / 2 - 0.025, 0)));
  if(!['hansen','conservative'].includes(stage6.bearing.shapeMode)) stage6.bearing.shapeMode = 'hansen';
}
