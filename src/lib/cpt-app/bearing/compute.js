// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// bearing/compute.js — shallow-foundation bearing capacity from the interpreted CPT profile
// (01-monolith-map.md §2.7 "Compute", §6.1 row `bearing/`, refactor step 7 / PR 12a).
//
// Moved verbatim out of legacy-controller.js (integration-r line numbers), renamed to drop the
// `stage6Bearing*` prefix; the only body changes are the two `S` reads that became parameters:
//   layerAtDepth                9865-9869   (no stage6WorkingLayers() fallback — `layers` is required)
//   stage6BearingGeometry       9871-9906   → bearingGeometry
//   stage6BearingShapeModeLabel 9908-9912   → shapeModeLabel
//   stage6BearingNgammaLabel    9914-9916   → ngammaLabel
//   stage6BearingShapeFactors   9932-9948   → shapeFactors (the controller's stage6ShapeFactors alias)
//   stage6BearingDepthFactors   9950-9975   → depthFactors
//   stage6BearingNgamma         9981-9985   → ngamma
//   stage6UsesEc7Factors        9987-9989   → usesEc7Factors
//   stage6CapacityLabel         9991-9993   → capacityLabel
//   stage6FactorLabel           9995-9997   → factorLabel
//   stage6FactorValue           9999-10002 → factorValue
//   stage6BearingEc7Keys        10004-10008 → ec7Keys
//   stage6BearingEc7Spec        10010-10029 → ec7Spec (the Belgian DA1/1 · DA1/2 partial-factor sets)
//   bearingAtDepth              10339-10519 (`S.wt` → env.wt)
//   bearingProfile              10521-10540 (passes `env` down)
//
// Pure: no state, no DOM. Inputs are explicit —
//   cfg     the `stage6.bearing` block (bearing/state.js): foundationType, B, L, eB, eL, shapeMode,
//           load, factorMode, xi, gammaRd, ec7Combination, Df
//   layers  the Stage 4 → Stage 6 working layers (model-params workingLayers(cpt)): top, bot, phi,
//           c, cu, g, gs, type, subtype per layer
//   env     { wt } — the water-table depth below the surface (m); required, no default
// The host (legacy-controller.js) keeps `layerAtDepth`, `bearingAtDepth`, `bearingProfile` and
// `stage6ShapeFactors` as façades that fill `layers` from stage6WorkingLayers() and `env` from the
// active CPT, so the legacy window API is unchanged.
import { designSoilLayer, effectiveVerticalStressAtDepth, stage6Constants } from '../stage6-engineering.js';

/** The water-table input of the compute functions: explicit, finite, no fallback. */
function waterTableOf(env, fn){
  const wt = env ? env.wt : undefined;
  if(!Number.isFinite(wt)) throw new Error(`${fn}: env.wt (water-table depth below the surface, m) is required`);
  return wt;
}

export function layerAtDepth(z, layers){
  if(!layers || !layers.length) return null;
  return layers.find(l=>z >= l.top && z < l.bot) || layers[layers.length-1];
}

export function bearingGeometry(cfg){
  const rawB = Math.max(cfg.B || 0.1, 0.1);
  const rawL = Math.max(cfg.L || rawB, 0.1);
  const eB = Math.max(0, Math.min(cfg.eB || 0, Math.max(rawB / 2 - 0.025, 0)));
  const eL = Math.max(0, Math.min(cfg.eL || 0, Math.max(rawL / 2 - 0.025, 0)));
  const effB = Math.max(rawB - 2 * eB, 0.05);
  const effL = Math.max(rawL - 2 * eL, 0.05);
  if((cfg.foundationType || 'strip') === 'strip'){
    return {
      B:effB,
      L:Math.max(effL, effB),
      BRaw:rawB,
      LRaw:Math.max(rawL, rawB),
      BEff:effB,
      LEff:Math.max(effL, effB),
      eB,
      eL,
      ratio:0,
      label:'strip'
    };
  }
  const shortSide = Math.max(Math.min(effB, effL), 0.05);
  const longSide = Math.max(effB, effL);
  return {
    B:shortSide,
    L:longSide,
    BRaw:rawB,
    LRaw:rawL,
    BEff:shortSide,
    LEff:longSide,
    eB,
    eL,
    ratio:Math.max(0, Math.min(shortSide / longSide, 1)),
    label:'rectangular'
  };
}

export function shapeModeLabel(mode){
  return mode === 'conservative'
    ? 'Conservative (shape factors = 1.0)'
    : 'Brinch Hansen / Annex D';
}

export function ngammaLabel(){
  return 'EC7 Annex D rough base';
}

export function shapeFactors(geometry, phiDeg, Nq, mode){
  if(mode === 'conservative'){
    return {sc:1, sq:1, sg:1, scu:1};
  }
  const r = geometry?.ratio || 0;
  const phiRad = Math.max(phiDeg || 0, 0) * Math.PI / 180;
  const sq = 1 + r * Math.sin(phiRad);
  const sc = phiDeg > 0
    ? (sq * Nq - 1) / Math.max(Nq - 1, 1e-6)
    : 1 + 0.2 * r;
  return {
    sc,
    sq,
    sg:Math.max(0.6, 1 - 0.3 * r),
    scu:1 + 0.2 * r
  };
}

export function depthFactors(Df, B, phiDeg, Nc){
  const eta = Math.max(Df || 0, 0) / Math.max(B || 0.1, 0.1);
  const k = eta <= 1 ? eta : Math.atan(eta);
  if(phiDeg > 0){
    const phiRad = phiDeg * Math.PI / 180;
    const sinPhi = Math.sin(phiRad);
    const tanPhi = Math.tan(phiRad);
    const dq = 1 + 2 * tanPhi * (1 - sinPhi) ** 2 * k;
    return {
      eta,
      k,
      dq,
      dc:dq - (1 - dq) / (Math.max(Nc, 1e-6) * Math.max(tanPhi, 1e-6)),
      dg:1.0,
      dcu:1 + 0.4 * k
    };
  }
  return {
    eta,
    k,
    dq:1.0,
    dc:1 + 0.4 * k,
    dg:1.0,
    dcu:1 + 0.4 * k
  };
}

export function ngamma(phiDeg, Nq){
  if(!(phiDeg > 0)) return 0;
  const phiRad = phiDeg * Math.PI / 180;
  return Math.max(0, 2 * Math.max(Nq - 1, 0) * Math.tan(phiRad));
}

export function usesEc7Factors(cfg){
  return (cfg.factorMode || 'ec7') === 'ec7';
}

export function capacityLabel(cfg){
  return usesEc7Factors(cfg) ? 'q_d' : 'q_allow';
}

export function factorLabel(cfg){
  return usesEc7Factors(cfg) ? 'γ_Rd' : 'ξ';
}

export function factorValue(cfg){
  if(usesEc7Factors(cfg)) return Math.max(cfg.gammaRd || 1, 0.1);
  return Math.max(cfg.xi || 1, 0.1);
}

export function ec7Keys(mode){
  if(mode === 'da1_1') return ['da1_1'];
  if(mode === 'da1_2') return ['da1_2'];
  return ['da1_1', 'da1_2'];
}

export function ec7Spec(key){
  if(key === 'da1_1'){
    return {
      key,
      label:'DA1/1',
      soilSet:'M1',
      gammaMphi:1.00,
      gammaMc:1.00,
      gammaMcu:1.00
    };
  }
  return {
    key:'da1_2',
    label:'DA1/2',
    soilSet:'M2',
    gammaMphi:1.25,
    gammaMc:1.25,
    gammaMcu:1.40
  };
}

export function bearingAtDepth(z, cfg, layers, env){
  const l = layerAtDepth(z, layers);
  if(!l) return null;
  const wt = waterTableOf(env, 'bearingAtDepth');
  const stress = effectiveVerticalStressAtDepth(layers, z, wt, stage6Constants().gammaW);
  const geo = bearingGeometry(cfg);
  const B = geo.B;
  const phiK = Math.max(l.phi || 0, 0);
  const cK = Math.max(l.c || 0, 0);
  const cuK = Math.max(l.cu || 0, 0);
  const useEc7 = usesEc7Factors(cfg);
  // Three-case water-table rule for the N_gamma-term unit weight (Das PoFE
  // "Effect of Water Table" Case I/II/III; Meyerhof): buoyant gamma' when the
  // WT is at/above the base; moist gamma when it lies deeper than the failure
  // wedge (~B' below the base); linear interpolation in between. A binary
  // switch at the base level would credit full moist gamma to a wedge that is
  // almost entirely submerged (unconservative for 0 < d_w < B').
  const gammaWConst = stage6Constants().gammaW;
  const gammaMoistL = l.g;
  const gammaBuoyL = Math.max((l.gs || l.g) - gammaWConst, 1.0);
  const dWater = wt - z;  // depth of the water table below the founding level
  let gammaEff;
  let wtCase;
  if(!(dWater > 0)){
    gammaEff = gammaBuoyL; wtCase = 'WT at/above base: buoyant γ′';
  } else if(dWater >= geo.BEff){
    gammaEff = gammaMoistL; wtCase = 'WT deeper than wedge (≥ B′): moist γ';
  } else {
    gammaEff = gammaBuoyL + (dWater / Math.max(geo.BEff, 1e-6)) * (gammaMoistL - gammaBuoyL);
    wtCase = 'WT within wedge: interpolated γ';
  }
  const qDrain = Math.max(stress.sigmaEff, 0);
  const qUndrain = Math.max(stress.sigmaV, 0);
  const factor = factorValue(cfg);
  const shapeMode = cfg.shapeMode || 'hansen';
  let drainedCalc = null;
  let undrainedCalc = null;
  let ec7Results = [];
  if(useEc7){
    ec7Results = ec7Keys(cfg.ec7Combination || 'governing').map(key=>{
      const spec = ec7Spec(key);
      const designed = designSoilLayer(l, spec.soilSet);
      const phiD = Math.max(designed.phi || 0, 0);
      const cD = Math.max(designed.c || 0, 0);
      const cuD = Math.max(designed.cu || 0, 0);
      const phiDRad = phiD * Math.PI / 180;
      const tanPhi = Math.tan(phiDRad);
      const Nq = phiD > 0 ? Math.exp(Math.PI * tanPhi) * Math.tan(Math.PI/4 + phiDRad/2)**2 : 1;
      const Nc = phiD > 0 ? (Nq - 1) / Math.max(tanPhi, 1e-6) : 5.14;
      const Ng = ngamma(phiD, Nq);
      const shp = shapeFactors(geo, phiD, Nq, shapeMode);
      const dep = depthFactors(z, B, phiD, Nc);
      const undShp = shapeFactors(geo, 0, 1, shapeMode);
      const undDep = depthFactors(z, B, 0, 5.14);
      const qultDrained = Math.max(0, cD * Nc * shp.sc * dep.dc + qDrain * Nq * shp.sq * dep.dq + 0.5 * gammaEff * geo.BEff * Ng * shp.sg * dep.dg);
      const qultUndrained = Math.max(0, qUndrain + 5.14 * cuD * undShp.scu * undDep.dcu);
      const qdDrained = qultDrained / factor;
      const qdUndrained = qultUndrained / factor;
      return {
        ...spec,
        phiD, cD, cuD, Nq, Nc, Ng,
        shape:shp,
        depth:dep,
        undrainedShape:undShp,
        undrainedDepth:undDep,
        shapeModeLabel:shapeModeLabel(shapeMode),
        ngammaFormulaLabel:ngammaLabel(),
        qultDrained, qultUndrained, qdDrained, qdUndrained
      };
    });
    drainedCalc = ec7Results.reduce((best, item)=>
      !best || item.qdDrained < best.qdDrained ? item : best
    , null);
    undrainedCalc = ec7Results.reduce((best, item)=>
      !best || item.qdUndrained < best.qdUndrained ? item : best
    , null);
  } else {
    const phiD = phiK;
    const cD = cK;
    const cuD = cuK;
    const phiDRad = phiD * Math.PI / 180;
    const tanPhi = Math.tan(phiDRad);
    const Nq = phiD > 0 ? Math.exp(Math.PI * tanPhi) * Math.tan(Math.PI/4 + phiDRad/2)**2 : 1;
    const Nc = phiD > 0 ? (Nq - 1) / Math.max(tanPhi, 1e-6) : 5.14;
    const Ng = ngamma(phiD, Nq);
    const shp = shapeFactors(geo, phiD, Nq, shapeMode);
    const dep = depthFactors(z, B, phiD, Nc);
    const undShp = shapeFactors(geo, 0, 1, shapeMode);
    const undDep = depthFactors(z, B, 0, 5.14);
    const qultDrained = Math.max(0, cD * Nc * shp.sc * dep.dc + qDrain * Nq * shp.sq * dep.dq + 0.5 * gammaEff * geo.BEff * Ng * shp.sg * dep.dg);
    const qultUndrained = Math.max(0, qUndrain + 5.14 * cuD * undShp.scu * undDep.dcu);
    drainedCalc = undrainedCalc = {
      label:'Global SF',
      soilSet:'M1',
      gammaMphi:1,
      gammaMc:1,
      gammaMcu:1,
      phiD, cD, cuD, Nq, Nc, Ng,
      shape:shp,
      depth:dep,
      undrainedShape:undShp,
      undrainedDepth:undDep,
      shapeModeLabel:shapeModeLabel(shapeMode),
      ngammaFormulaLabel:ngammaLabel(),
      qultDrained, qultUndrained,
      qdDrained: qultDrained / factor,
      qdUndrained: qultUndrained / factor
    };
  }
  const qdDrained = drainedCalc.qdDrained;
  const qdUndrained = undrainedCalc.qdUndrained;
  return{
    layer:l,
    z,
    B:+B.toFixed(2),
    L:+geo.L.toFixed(2),
    BRaw:+geo.BRaw.toFixed(2),
    LRaw:+geo.LRaw.toFixed(2),
    BEff:+geo.BEff.toFixed(2),
    LEff:+geo.LEff.toFixed(2),
    eB:+geo.eB.toFixed(2),
    eL:+geo.eL.toFixed(2),
    r:+geo.ratio.toFixed(3),
    eta:+drainedCalc.depth.eta.toFixed(3),
    k:+drainedCalc.depth.k.toFixed(3),
    sigV:+stress.sigmaV.toFixed(1),
    sigVeff:+stress.sigmaEff.toFixed(1),
    qDrain:+qDrain.toFixed(1),
    qUndrain:+qUndrain.toFixed(1),
    gammaEff:+gammaEff.toFixed(2),
    wtCase,
    phiK:+phiK.toFixed(1),
    phiD:+drainedCalc.phiD.toFixed(1),
    cK:+cK.toFixed(1),
    cD:+drainedCalc.cD.toFixed(1),
    cuK:+cuK.toFixed(1),
    cuD:+undrainedCalc.cuD.toFixed(1),
    drainedComboLabel:useEc7 ? drainedCalc.label : 'Global SF',
    undrainedComboLabel:useEc7 ? undrainedCalc.label : 'Global SF',
    gammaMphi:+drainedCalc.gammaMphi.toFixed(2),
    gammaMc:+drainedCalc.gammaMc.toFixed(2),
    gammaMcu:+undrainedCalc.gammaMcu.toFixed(2),
    useEc7,
    gammaRd:+(cfg.gammaRd || 1).toFixed(2),
    xi:+(cfg.xi || 1).toFixed(2),
    ec7CombinationMode:cfg.ec7Combination || 'governing',
    ec7CombinationLabel:useEc7
      ? drainedCalc.label === undrainedCalc.label
        ? drainedCalc.label
        : `drained ${drainedCalc.label} / undrained ${undrainedCalc.label}`
      : null,
    ec7Results:ec7Results.map(item=>({
      label:item.label,
      qdDrained:+item.qdDrained.toFixed(1),
      qdUndrained:+item.qdUndrained.toFixed(1)
    })),
    capacityLabel:capacityLabel(cfg),
    factorLabel:factorLabel(cfg),
    shapeMode:shapeMode,
    shapeModeLabel:drainedCalc.shapeModeLabel,
    ngammaFormulaLabel:drainedCalc.ngammaFormulaLabel,
    Nc:+drainedCalc.Nc.toFixed(3),
    Nq:+drainedCalc.Nq.toFixed(3),
    Ng:+drainedCalc.Ng.toFixed(3),
    sc:+drainedCalc.shape.sc.toFixed(2),
    sq:+drainedCalc.shape.sq.toFixed(2),
    sg:+drainedCalc.shape.sg.toFixed(2),
    scu:+undrainedCalc.undrainedShape.scu.toFixed(2),
    dc:+drainedCalc.depth.dc.toFixed(2),
    dq:+drainedCalc.depth.dq.toFixed(2),
    dg:+drainedCalc.depth.dg.toFixed(2),
    dcu:+undrainedCalc.undrainedDepth.dcu.toFixed(2),
    factor:+factor.toFixed(2),
    qultDrained:+drainedCalc.qultDrained.toFixed(1),
    qultUndrained:+undrainedCalc.qultUndrained.toFixed(1),
    qdDrained:+qdDrained.toFixed(1),
    qdUndrained:+qdUndrained.toFixed(1),
    utilDrained: cfg.load > 0 ? +(cfg.load / Math.max(qdDrained, 1e-6)).toFixed(2) : null,
    utilUndrained: cfg.load > 0 ? +(cfg.load / Math.max(qdUndrained, 1e-6)).toFixed(2) : null
  };
}

export function bearingProfile(cfg, layers, env){
  if(!layers || !layers.length) return null;
  const maxDepth = layers[layers.length-1].bot;
  const step = Math.max(0.1, Math.min(0.25, maxDepth / 60));
  const depths = [];
  for(let z = Math.max(cfg.Df, 0.2); z <= maxDepth + 1e-9; z += step){
    depths.push(+z.toFixed(3));
  }
  if(!depths.length || depths[0] !== +cfg.Df.toFixed(3)) depths.unshift(+cfg.Df.toFixed(3));
  const pts = depths.map(z=>bearingAtDepth(z, cfg, layers, env)).filter(Boolean);
  const selected = bearingAtDepth(cfg.Df, cfg, layers, env);
  return{
    pts,
    selected,
    drained:pts.map(p=>({x:p.qdDrained, y:p.z})),
    undrained:pts.map(p=>({x:p.qdUndrained, y:p.z})),
    maxDepth
  };
}
