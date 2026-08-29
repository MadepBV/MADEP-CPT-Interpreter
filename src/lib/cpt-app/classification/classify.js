// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// classification/classify.js — per-reading classification dispatch for one CPT.
//
// Moved out of src/lib/cpt-app/legacy-controller.js (PR 6, refactor step 3), lines
// 1772-1893: assumedRfValue / cptHasFs / cptHasRf and the five method wrappers
// classRob / classRob2016 / classCUR3 / classNEN6740 / classSB260 around the pure
// classifiers of classification-core.js. The only change: every function takes the CPT
// state as its first argument instead of reading the module-level active CPT `S`
// (S.wt through stressAt, S.meta.aRatio / hasFs / hasRf, S.assumedRf, S.data).
// `classifyRow` is the dispatch that runClass used to inline.

import {
  classifyCUR3 as coreClassifyCUR3,
  classifyNEN6740 as coreClassifyNEN6740,
  classifyRobertson1990,
  classifyRobertson2016,
  classifyTabel3,
  normalizeAssumedRf
} from '../classification-core.js';
import { stressAt } from '../model-params/stress.js';

/* The classifier math lives in classification-core.js (pure, node-verified by
   scripts/verify_qc_only_handling.mjs). These wrappers supply the stress state
   and the app settings. assumedRfValue() is the explicit friction-ratio
   assumption used for readings without measured fs/Rf. */
export function assumedRfValue(cpt){
  return normalizeAssumedRf(cpt.assumedRf);
}

/* Single source of truth for fs/Rf availability — the meta flags are set at
   parse time; the cpt.data fallback covers states created before the flags. */
export function cptHasFs(cpt){
  return cpt.meta?.hasFs ?? cpt.data.some(r=>r.fs!=null);
}
export function cptHasRf(cpt){
  return cpt.meta?.hasRf ?? cpt.data.some(r=>r.rf!=null);
}

/* ════════════════════════════════
   CLASSIFICATION — Robertson (1990) SBT

   Source: Robertson, P.K. (1990). Soil classification using the CPT.
   Canadian Geotechnical Journal, 27(1), 151-158.

   Uses the Soil Behaviour Type (SBT) index Ic and the normalised
   Robertson chart. Nine zones mapped to practical soil types.

   STRESS NORMALISATION:
     Qt = (qc - σv0) / σ'v0        (dimensionless, cone resistance ratio)
     Fr = fs / (qc - σv0) × 100    (%, normalised friction ratio)
     Ic = √((3.47 - log Qt)² + (log Fr + 1.22)²)

   IC ZONE BOUNDARIES (Robertson 1990):
     Ic > 3.60  → Zone 2: Organic soils — clay / peat
     Ic > 2.95  → Zone 3: Clays — silty clay to clay
     Ic > 2.60  → Zone 4: Silt mixtures — clayey silt to silty clay
     Ic > 2.05  → Zone 5: Sand mixtures — silty sand to sandy silt
     Ic > 1.31  → Zone 6: Sands — clean sand to silty sand
     Ic ≤ 1.31  → Zone 7: Gravelly sand to dense sand
     (Zone 1 "sensitive fine-grained" is not defined by an Ic band alone.)

   MAPPING to app soil types:
     Zone 2 → Peat / organic
     Zone 3 → Clay
     Zone 4 → Sandy clay
     Zone 5 → Silty sand
     Zone 6 → Sand
     Zone 7 → Gravel
   Sensitive / structured fine-grained soils require judgement outside the
   Ic bands and are not inferred here from Ic alone.
════════════════════════════════ */
export function classRob(cpt, r){
  return classifyRobertson1990(r, {
    ...stressAt(cpt, r.z, 18, 17),
    aRatio: cpt.meta?.aRatio ?? 0.8,
    assumedRf: assumedRfValue(cpt)
  });
}

/* ════════════════════════════════
   CLASSIFICATION — Robertson (2016) SBT

   Uses the Robertson 2016 iterative Qtn normalisation while keeping the
   existing Ic-based app mapping to broad soil families.
════════════════════════════════ */
export function classRob2016(cpt, r){
  return classifyRobertson2016(r, {
    ...stressAt(cpt, r.z, 18, 17),
    aRatio: cpt.meta?.aRatio ?? 0.8,
    assumedRf: assumedRfValue(cpt)
  });
}

/* ════════════════════════════════
   CLASSIFICATION — CUR 3 layers

   Source: PLAXIS Reference Manual, "CUR 3 layers method" chart.

   This is a broad layering rule, not a detailed parameter catalogue.
   The published chart contains four fields:
     - Sand
     - Silt
     - Clay
     - Peat

   The app keeps downstream compatibility with the existing parameter
   workflow by carrying the intermediate "Silt" field as the app's
   intermediate type "Sandy clay", with subtype marker "CUR3 silt".

   Implemented chart zones:
     - Sand: Rf < 1.5% and qc ≥ 1.5 MPa
     - Silt: Rf < 2.5% and qc ≥ 0.5 MPa
     - Clay: Rf ≤ 5.0% and qc ≥ 0.2 MPa
     - Peat: all remaining points

   The chart is implemented as nested zones checked from the most
   specific region to the broadest:
     1. Sand
     2. Silt
     3. Clay
     4. Peat (complement of the three zones above)
════════════════════════════════ */
export function classCUR3(cpt, r){
  return coreClassifyCUR3(r, {assumedRf: assumedRfValue(cpt)});
}

export const classCUR = classCUR3;

/* ════════════════════════════════
   CLASSIFICATION — NEN 6740 (stress dependent)

   Source: NEN 6740 chart as reproduced in D-SHEET Piling and related
   engineering manuals. The source is a 14-area semilog chart rather
   than a closed algebraic decision tree.

   The app therefore implements a transparent fixed discretisation:
     1. compute stress-corrected q_c,NEN
     2. compute chart score = log10(q_c,NEN) - 0.34 * R_f
     3. choose the nearest of the 14 published material areas

   The 14 area centres are digitised from the published chart and tied
   to the representative NEN material set commonly used by software
   implementations of the rule.

   Provenance:
   - the stress correction exponent 0.67 follows the Deltares D-SHEET
     Piling manual for the NEN (Stress Dependent) rule;
   - the RF slope 0.34 is an app-side regression fit through the 14
     digitised centres, not a published NEN coefficient. It replaced the
     earlier 0.18 slope after audit validation showed that 0.18 collapsed
     the boundary between the stored areas 5 and 6 into a near tie.
════════════════════════════════ */
export function classNEN6740(cpt, r){
  const {sigVeff} = stressAt(cpt, r.z, 18, 17);
  return coreClassifyNEN6740(r, {sigVeff, assumedRf: assumedRfValue(cpt)});
}

/* ════════════════════════════════
   CLASSIFICATION — Eurocode / NEN Tabel 3
   "Karakteristieke grondparameters op basis van de resultaten
   uit een elektrische sondering"

   The Eurocode table contains overlapping qc/Rf envelopes.
   For deterministic classification the implementation checks the exact
   table rows in table order:
     grind → zand → leem → klei → veen
   and, within each group, top-to-bottom row order.
   Range handling follows the table notation exactly:
     qc lower bound inclusive, upper bound exclusive
     Rf < 1 and Rf > 6 are strict
     banded Rf ranges (1–2, 2–4, 2–5, 3–6) are inclusive.
════════════════════════════════ */
export function classSB260(cpt, r){
  /* Readings without measured Rf are classified with the explicit assumed Rf
     (previously they skipped Tabel 3 entirely and every qc-only reading fell
     through to the loose-sand fallback). */
  return classifyTabel3(r, {assumedRf: assumedRfValue(cpt)});
}

/**
 * Classify one reading with the CPT's method (runClass' former inline dispatch:
 * every method other than the four named ones falls through to Tabel 3).
 * @param {object} cpt     CPT state: wt, meta.aRatio, assumedRf are read
 * @param {object} row     reading {z, qc, fs, rf, u2}
 * @param {string} method  defaults to cpt.method
 */
export function classifyRow(cpt, row, method = cpt.method){
  if(method==='robertson')          return classRob(cpt, row);
  else if(method==='robertson2016') return classRob2016(cpt, row);
  else if(method==='cur3')          return classCUR3(cpt, row);
  else if(method==='nen6740')       return classNEN6740(cpt, row);
  return classSB260(cpt, row);
}
