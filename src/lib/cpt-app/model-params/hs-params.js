// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// model-params/hs-params.js — Hardening-Soil / Mohr-Coulomb stiffness set of one layer
// (E_oed,i / E_oed,ref / E_50 / E_ur, m, K0nc, ν, β, E_def, ψ, R_inter, stresses, TAW levels).
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 5, refactor step 2), lines 3074-3157.
// Every read of the module-level active CPT `S` became an explicit field of `ctx`:
//   S.alphaMethod        → ctx.alphaMethod   'A' fixed Sanglerat α (AE) | 'B' SB260 Tabel 21-6-5 (alphaEB)
//   S.stiffMethod        → ctx.stiffMethod   'A' CUR 2003-7 (E50 = 1.25·Eoed cohesive) | 'B' E50 = Eoed
//   S.elev               → ctx.elev          surface level m TAW (null → '—' in topTAW/botTAW)
//   assumedRfValue()     → ctx.assumedRf     normalised assumed R_f (%) for layers without measured R_f
//   stressAt(z, gs, g)   → (ctx.stressAt || stressAt)(ctx, z, gs, g) — reads ctx.wt (m below surface);
//                          ctx.stressAt is an optional override hook, unused by the app today.
// Layer overrides (l.ovr.aE/m/nu/rShear with l.aE_ovr/m_ovr/nu_ovr/rShear_ovr) are read
// from the layer as before. cptModelCtx(cpt) in ./context.js builds the ctx from a CPT state.
// Pure: no DOM, no module state.

import { AE, alphaEB, mohrCoulombNuDefault, mohrCoulombRShearDefault } from './soil-defaults.js';
import { stressAt } from './stress.js';

export function hsParams(l, ctx){
  const pref=100;
  const midZ=(l.top+l.bot)/2;
  /* Pass both gamma_sat (l.gs) and gamma_unsat (l.g) so that stress
     above the water table uses the unsaturated unit weight. */
  const {sigV, u, sigVeff}=(ctx.stressAt||stressAt)(ctx, midZ, l.gs, l.g);
  const cohesive=l.type==='Clay'||l.type==='Soft clay'||l.type==='Peat / organic';

  /* ── Alpha selection ── */
  let aE;
  if(l.ovr.aE){
    aE=l.aE_ovr;  // engineer override takes absolute priority
  } else if(ctx.alphaMethod==='B'){
    // Fall back to the explicit assumed Rf when the CPT has no measured Rf,
    // so the sand/transition α-family split stays consistent with Stage 2.
    aE=alphaEB(l.type, l.avgQc, l.subtype, l.avgRf ?? ctx.assumedRf);
  } else {
    aE=AE[l.type]||10;
  }

  /* ── Eoed,i ── */
  const Eoed_i=+(aE*l.avgQc*1000).toFixed(0);

  /* ── m (type default, engineer can override) ──
     CUR 2003-7 binary stress-exponent convention: m = 0.5 for granular soils
     (sand, silty sand, gravel) and m = 1.0 for cohesive soils (clay, soft
     clay, sandy clay / leem, peat).  This is the documented method's
     conservative default — Stage 5 m-fitting is available per layer when
     site-specific evidence supports a different value.
     References: CUR 2003-7; Schanz, Vermeer & Bonnier (1999). */
  const m=l.ovr.m ? l.m_ovr
          : (cohesive || l.type==='Sandy clay') ? 1.0
          : 0.50;

  /* ── Eoed,ref (full cohesion-corrected formula per SB260-21-6.4.10) ── */
  const cotphi = l.phi>0 ? Math.cos(l.phi*Math.PI/180)/Math.sin(l.phi*Math.PI/180) : 0;
  const cCotPhi = l.c * cotphi;
  const ratio = Math.max((sigVeff + cCotPhi) / (pref + cCotPhi), 0.05);
  const Eoed_ref = +(Eoed_i / Math.pow(ratio, m)).toFixed(0);

  /* ── Stiffness Method A (CUR 2003-7) or B (E50 = Eoed) ──
     CUR 2003-7 treats klei AND leem (Sandy clay) as the cohesive set for
     the E50/Eoed = 1.25 ratio.  The earlier code excluded Sandy clay,
     which disagreed with the documented method. */
  const cohesiveForE50 = cohesive || l.type==='Sandy clay';
  let E50_i, E50_ref, Eur_ref;
  if(ctx.stiffMethod==='B'){
    E50_i = Eoed_i;
    E50_ref = Eoed_ref;
    Eur_ref = +(3*Eoed_ref).toFixed(0);
  } else {
    // Method A: CUR 2003-7
    E50_i = cohesiveForE50 ? +(1.25*Eoed_i).toFixed(0) : Eoed_i;
    E50_ref = cohesiveForE50 ? +(1.25*Eoed_ref).toFixed(0) : Eoed_ref;
    Eur_ref = +(3*E50_ref).toFixed(0);
  }

  const K0nc=+(1-Math.sin(l.phi*Math.PI/180)).toFixed(3);
  const nu = l.ovr && l.ovr.nu
    ? Math.max(Math.min(Number(l.nu_ovr) || 0.30, 0.49), 0.05)
    : mohrCoulombNuDefault(l.type, l.subtype);
  const rShear = l.ovr && l.ovr.rShear
    ? Math.max(Math.min(Number(l.rShear_ovr) || 0.25, 1), 0.01)
    : mohrCoulombRShearDefault(l.type, l.subtype);
  const nu_ur=0.20;
  /* ── SCIA Engineer deformation modulus ──
     Edef = beta * Eoed,i with beta = (1+nu)(1-2nu)/(1-nu): the isotropic-
     elasticity link between the constrained (oedometric) modulus and the
     Young-type deformation modulus that SCIA's subsoil input (Soilin)
     expects, following the CSN 73 1001 convention (Eoed = Edef / beta).
     Edef uses the in-situ Eoed,i, not the p_ref-normalised Eoed,ref.
     Edef is computed from the ROUNDED beta so the reported numbers
     reproduce exactly when the engineer checks beta x Eoed,i by hand. */
  const beta=+(((1+nu)*(1-2*nu))/(1-nu)).toFixed(3);
  const Edef=+(beta*Eoed_i).toFixed(0);
  const psi=Math.max(0,l.phi>30?Math.round(l.phi-30):0);
  /* MC export uses the current-stress loading stiffness E50,i.
     The earlier x1.5 conversion from Eoed,i had no retained source basis. */
  const Emc=E50_i;
  const taw=z=>ctx.elev!=null?(ctx.elev-z).toFixed(2)+'m TAW':'—';
  return{Eoed_i,E50_i,Eoed_ref,E50_ref,Eur_ref,m,K0nc,nu,nu_ur,beta,Edef,aE:+aE.toFixed(2),
    sigV:+sigV.toFixed(1),u:+u.toFixed(1),sigVeff:+sigVeff.toFixed(1),psi,Emc,rShear,
    topTAW:taw(l.top),botTAW:taw(l.bot)};
}
