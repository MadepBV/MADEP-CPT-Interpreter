// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// model-params/kh-params.js — hydraulic conductivity, k_h/k_v anisotropy, ψ_unsat and the
// VMM infiltration class of one layer.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 5, refactor step 2), lines 2948-3031.
// The only change: `S.khKvMethod` became `ctx.khKvMethod` ('A' OVAM / I/RA/11461 default,
// 'B' Bear 1979). ctx is the object built by cptModelCtx(cpt) in ./context.js, or any
// object carrying `khKvMethod`. Pure: no state, no DOM, no imports.

export function khParams(l, ctx){
  /* Hydraulic conductivity from I/RA/11461/15.066/JSW
     Tabel 2-44 (OVAM 2002) + Tabel 2-45 (De Smedt VUB)
     mapped to CPT soil types. Values in m/s.
     kh_min, kh_max = range; kh_rep = representative (geometric mean). */
  const sub=l.subtype||'';
  const isGranular=l.type==='Sand'||l.type==='Silty sand'||l.type==='Gravel';
  const isCohesive =l.type==='Clay'||l.type==='Soft clay';
  const isLeem     =l.type==='Sandy clay';
  const isPeat     =l.type==='Peat / organic';

  let kh_min,kh_max,kh_rep;

  if(l.type==='Gravel'){
    kh_min=2.3e-4; kh_max=1.2e-2; kh_rep=1e-3;
  } else if(l.type==='Sand'){
    // Sub-classify by SB260 consistency (subtype contains zand, los/matig/dicht/z.dicht)
    if(sub.includes('z.dicht')||sub.includes('zeer dicht')){kh_min=1.2e-4;kh_max=2.3e-4;kh_rep=2e-4;}
    else if(sub.includes('dicht'))                          {kh_min=1.2e-4;kh_max=2.3e-4;kh_rep=1.5e-4;}
    else if(sub.includes('matig'))                          {kh_min=1.2e-5;kh_max=1.2e-4;kh_rep=4e-5;}
    else /* los + kleihoudend */                            {kh_min=1.2e-6;kh_max=1.2e-5;kh_rep=3e-6;}
  } else if(l.type==='Silty sand'){
    kh_min=1.2e-6; kh_max=1.2e-5; kh_rep=3e-6;
  } else if(isLeem){
    kh_min=1.2e-7; kh_max=1.2e-6; kh_rep=5e-7;
  } else if(l.type==='Clay'){
    kh_min=1e-9; kh_max=1.2e-7; kh_rep=5e-8;
  } else if(l.type==='Soft clay'){
    kh_min=1e-10; kh_max=1.2e-7; kh_rep=2e-8;
  } else if(isPeat){
    kh_min=6e-8; kh_max=6e-7; kh_rep=2e-7;
  } else {
    kh_min=1e-6; kh_max=1e-4; kh_rep=1e-5; // fallback
  }

  // kh/kv ratio — engineer-selectable method.
  //
  //   Method A — OVAM / I/RA/11461 (default)
  //     Conservative engineering practice value used in the Belgian
  //     OVAM 2002 / I/RA/11461.15.066 reference.  Silty sand ("fijn zand"
  //     in the source) is grouped with the fine soils → k_h/k_v = 3.
  //
  //   Method B — Bear (1979) academic
  //     Bear's Hydraulics of Groundwater gives a literature-typical
  //     intermediate value for fine/silty sand: k_h/k_v ≈ 2.  Reflects
  //     the partly-cohesive nature of silty sand without lumping it
  //     fully with cohesive soils.
  //
  // Sand and gravel remain isotropic (k_h/k_v = 1) under both methods.
  // All cohesive soils (clay, sandy clay/leem, peat) get k_h/k_v = 3
  // under both methods.
  const isFineSand = l.type==='Silty sand';
  let khkv;
  if (isGranular && !isFineSand) {
    khkv = 1;                                   // clean sand or gravel
  } else if (isFineSand) {
    khkv = (ctx.khKvMethod === 'B') ? 2 : 3;      // OVAM=3 (default), Bear=2
  } else {
    khkv = 3;                                   // cohesive
  }
  const kv_rep = +(kh_rep / khkv).toExponential(1);

  // psi_unsat (Plaxis 2D Manual): granular 0.1 m, leem 1.0 m, cohesive 3.0 m.
  // Silty sand stays in the granular branch for ψ_unsat (height of partially
  // saturated zone above the water table) — it dries similarly to clean sand.
  const psi_unsat = isGranular ? 0.1 : isLeem ? 1.0 : 3.0;

  // Infiltration design class (VMM §5.2, I/RA/11461/15.066/JSW)
  let infClass;
  if(kh_rep > 0.5e-6)       infClass='Infiltratie (volledig)';
  else if(kh_rep > 0.1e-6)  infClass='Infiltratie (effectief)';
  else if(kh_rep > 0.01e-6) infClass='Infiltratie + buffer';
  else                        infClass='Buffer (infiltratie marginaal)';

  function fmtK(v){
    // Format as X.Xe-N
    const e=Math.floor(Math.log10(v));
    const m=+(v/Math.pow(10,e)).toFixed(1);
    return `${m}\u00d710\u207b${Math.abs(e)}`;  // m×10⁻N
  }

  return{kh_min,kh_max,kh_rep,khkv,kv_rep,psi_unsat,infClass,
    kh_rep_fmt:fmtK(kh_rep), kh_min_fmt:fmtK(kh_min), kh_max_fmt:fmtK(kh_max)};
}
