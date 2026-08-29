// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// settlement/state.js — state schema of the settlement app (stage6/apps/settlement-state.js until
// refactor step 7 / PR 12c; that path now re-exports this module): the `settlement` block of
// stage6Defaults() (legacy-controller.js 2250-2267 at integration-r @ c989770) and its clamp in
// ensureStage6State() (2735), verbatim. `defaults()` is the schema; `ensure()` clamps an existing
// block in place (the stage6/ shell merges the defaults in first). `env.maxDepth` is the shell's
// clamped layer bottom (max(stage6MaxDepth(), 0.5)) — the founding depth Df cannot leave the profile.
// stage6/registry.js reads defaults / ensure through settlement/index.js.

export function defaults(){
  return {
    footingType:'rectangular',
    B:2.00,
    L:2.00,
    D:2.00,
    Df:1.00,
    Gk:120,
    QLead:40,
    QOther:0,
    useCategory:'A',
    combination:'qp',
    stressMethod:'boussinesq',
    truncationRule:'CPT_bottom',
    dz:0.10,
    includeTime:false,
    timeDays:180,
    allowableSettlement:25
  };
}

export function ensure(stage6, env){
  const maxDepth = env.maxDepth;
  stage6.settlement.Df = Math.min(Math.max(+stage6.settlement.Df || 0.0, 0.0), maxDepth);
}
