// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// model-params/stress.js — total / pore / effective vertical stress at depth z for one CPT.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 5, refactor step 2), lines 1935-1951.
// The only change: the water-table depth is read from the explicit `cpt` argument
// (`cpt.wt`, m below surface) instead of the module-level active-CPT `S`. Any object
// with a numeric `wt` works (a CPT state or a model-params ctx). Returns
// { sigV, u, sigVeff } in kPa with the same rounding as before.

export function stressAt(cpt, z, gamma_sat, gamma_unsat){
  /* Correct effective stress accounting for water table position.
     Above WT: use gamma_unsat (unsaturated unit weight = gamma, Stage 3).
     Below WT: use gamma_sat.
     If gamma_unsat not supplied, falls back to gamma_sat for both zones
     (conservative, used during Stage 2 classification where only gamma=18 known). */
  const wt = cpt.wt;
  const gu = gamma_unsat ?? gamma_sat; // fallback
  let sigV;
  if(z <= wt){
    sigV = gu * z;
  } else {
    sigV = gu * wt + gamma_sat * (z - wt);
  }
  const u = z > wt ? 9.81 * (z - wt) : 0;
  return{sigV: +sigV.toFixed(2), u: +u.toFixed(2), sigVeff: Math.max(sigV - u, 1)};
}
