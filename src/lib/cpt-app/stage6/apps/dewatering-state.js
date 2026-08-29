// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// stage6/apps/dewatering-state.js — state schema of the dewatering app: the `dewatering` block of
// stage6Defaults() (legacy-controller.js 2268-2284 at integration-r) and its clamp in
// ensureStage6State() (2736), verbatim. `env.wt` is the active CPT's water table (S.wt).

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
