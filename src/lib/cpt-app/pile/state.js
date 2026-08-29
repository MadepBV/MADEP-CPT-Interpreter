// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// pile/state.js — state schema of the pile app (stage6/apps/pile-state.js until refactor step 7 /
// PR 12b; that path now re-exports this module): the `pile` block of stage6Defaults()
// (legacy-controller.js 2285-2326 at integration-r) and the body of ensurePileState(maxDepth)
// (11612-11681), verbatim. `env.maxDepth` is the shell's clamped layer bottom.

export function defaults(){
  return {
    pileType:'driven',
    shape:'circular',
    Ds:0.40,
    Db:0.40,
    a:null,
    b:null,
    Ap:null,
    zHead:0.00,
    zToe:10.00,
    Fcd:500,
    Frep:350,
    loadFromComponents:false,
    GkPerPile:null,
    QLeadPerPile:null,
    QOtherPerPile:null,
    loadCategory:'A',
    slsCombination:'qp',
    ulsSet:'A1',
    sltCondition:'none',
    qaToggle:false,
    nCpt:1,
    nPiles:'1-3',
    cptDensity:'1/100m2',
    useAtg:false,
    atgAlphaB:null,
    atgAlphaS:null,
    atgGammaRd:null,
    atgGammaB:null,
    lambdaOverride:null,
    downdrag:'none',
    neutralPlane:null,
    pileMaterial:'concrete',
    Ep:30,
    EbOverride:null,
    MsOverride:null,
    MbOverride:null,
    sAllowable:10,
    mechanicalCone:false,
    coneType:'M1',
    settlementMethod:'transfer'
  };
}

/** ensurePileState(maxDepth) of the monolith: enums, geometry, depths, loads, overrides, neutral plane. */
export function ensure(stage6, env){
  const maxDepth = env.maxDepth;
  if(!stage6.pile) stage6.pile = defaults();
  const p = stage6.pile;
  const def = defaults();
  // Enums
  const pileTypes = ['driven','screw_displacement','screw_cased','cfa','bored'];
  if(!pileTypes.includes(p.pileType)) p.pileType = 'driven';
  if(!['circular','square','rectangular'].includes(p.shape)) p.shape = 'circular';
  if(!['none','comparable','jobsite'].includes(p.sltCondition)) p.sltCondition = 'none';
  if(!['1-3','4-10','>10'].includes(p.nPiles)) p.nPiles = '1-3';
  if(!['1/10m2','1/50m2','1/100m2','1/300m2','1/1000m2'].includes(p.cptDensity)) p.cptDensity = '1/100m2';
  if(!['M1','M2','M4'].includes(p.coneType)) p.coneType = 'M1';
  if(!['none','moderate','severe'].includes(p.downdrag)) p.downdrag = 'none';
  if(!['concrete','steel','timber'].includes(p.pileMaterial)) p.pileMaterial = 'concrete';
  if(!['transfer','typical-curve'].includes(p.settlementMethod)) p.settlementMethod = 'transfer';
  if(!['qp','frequent','characteristic'].includes(p.slsCombination)) p.slsCombination = 'qp';
  if(!['A1','A2'].includes(p.ulsSet)) p.ulsSet = 'A1';
  if(!['A','B','C','D','E','W','S','T'].includes(p.loadCategory)) p.loadCategory = 'A';
  // Geometry
  p.Ds = Math.max(+p.Ds || def.Ds, 0.05);
  p.Db = Math.max(+p.Db || p.Ds, p.Ds);
  if(p.shape === 'rectangular'){
    p.a = Math.max(+p.a || p.Ds, 0.05);
    p.b = Math.max(+p.b || p.a, p.a);
  } else if(p.shape === 'square'){
    p.a = Math.max(+p.a || p.Ds, 0.05);
    p.b = null;
  } else {
    p.a = null;
    p.b = null;
  }
  if(p.Ap != null && p.Ap !== '' && Number.isFinite(+p.Ap) && +p.Ap > 0) p.Ap = +p.Ap;
  else p.Ap = null;
  // Depths
  p.zHead = Math.max(+p.zHead || 0, 0);
  if(p.zHead > maxDepth - 0.5) p.zHead = Math.max(0, maxDepth - 0.5);
  p.zToe = Math.min(Math.max(+p.zToe || def.zToe, p.zHead + 0.50), maxDepth);
  // Loads
  p.Fcd = Math.max(+p.Fcd || 0, 0);
  p.Frep = Math.max(+p.Frep || 0, 0);
  // Toggles / counts
  p.qaToggle = !!p.qaToggle;
  p.useAtg = !!p.useAtg;
  p.mechanicalCone = !!p.mechanicalCone;
  p.loadFromComponents = !!p.loadFromComponents;
  p.nCpt = Math.max(1, Math.round(+p.nCpt || 1));
  p.sAllowable = Math.max(+p.sAllowable || 10, 0.1);
  // Material modulus
  if(p.pileMaterial === 'steel') p.Ep = +p.Ep > 0 ? +p.Ep : 210;
  else if(p.pileMaterial === 'timber') p.Ep = +p.Ep > 0 ? +p.Ep : 12;
  else p.Ep = +p.Ep > 0 ? +p.Ep : 30;
  // Optional overrides
  for(const key of ['atgAlphaB','atgAlphaS','atgGammaRd','atgGammaB','lambdaOverride','EbOverride','MsOverride','MbOverride','GkPerPile','QLeadPerPile','QOtherPerPile']){
    const v = p[key];
    if(v == null || v === '' || !Number.isFinite(+v) || +v <= 0) p[key] = null;
    else p[key] = +v;
  }
  // Lambda special: default 1.0 when relaxing flagged
  if(p.lambdaOverride != null && p.lambdaOverride > 1.0) p.lambdaOverride = 1.0;
  // Downdrag / neutral plane
  if(p.downdrag !== 'none'){
    if(p.neutralPlane == null || !Number.isFinite(+p.neutralPlane)){
      p.neutralPlane = Math.max(p.zHead + 0.5, p.zToe / 2);
    } else {
      p.neutralPlane = Math.min(Math.max(+p.neutralPlane, p.zHead + 0.05), p.zToe - 0.05);
    }
  } else {
    p.neutralPlane = null;
  }
}
