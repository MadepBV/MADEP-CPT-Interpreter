// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// dewatering/state.js — state schema of the dewatering app (stage6/apps/dewatering-state.js until
// refactor step 7 / PR 12c; that path now re-exports this module): the `dewatering` block of
// stage6Defaults() (legacy-controller.js 2268-2284 at integration-r @ c989770) and its clamp in
// ensureStage6State() (2736), verbatim. `defaults()` is the schema; `ensure()` clamps an existing
// block in place (the stage6/ shell merges the defaults in first). `env.maxDepth` is the shell's
// clamped layer bottom (max(stage6MaxDepth(), 0.5)), `env.wt` the active CPT's water table (S.wt):
// the target water table stays between the water table and 0.2 m above the profile bottom.
// stage6/registry.js reads defaults / ensure through dewatering/index.js.

export function defaults(){
  return {
    combination:'characteristic',
    targetWt:3.00,
    geometry:'single_well',
    aquiferType:'unconfined',
    rw:0.15,
    rCPT:0.00,
    LPit:12.00,
    BPit:8.00,
    LTrench:20.00,
    distanceToCPT:10.00,
    CSichardt:3000,
    sigmaVMode:'conservative',
    aquiferBaseDepth:null,
    dz:0.10,
    timeDays:0
  };
}

export function ensure(stage6, env){
  const maxDepth = env.maxDepth;
  const wt = env.wt;
  stage6.dewatering.targetWt = Math.min(Math.max(+stage6.dewatering.targetWt || (wt + 0.5), wt), Math.max(wt, maxDepth-0.2));
}
