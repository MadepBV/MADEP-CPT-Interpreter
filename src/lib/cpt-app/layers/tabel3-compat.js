// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// layers/tabel3-compat.js — NEN / Eurocode 7 Tabel 3 compatibility of a CPT soil type.
//
// Moved verbatim out of src/lib/cpt-app/legacy-controller.js (PR 6, refactor step 3):
// CAT_GROUPS / COMPAT / compatLevel / qcRfFit / suggestSubtype (lines 2353-2506),
// subtypeGroup (2035-2038) and layerTypeCompatScore (512-551, the cross-CPT score shared
// with the section view and the smart-merge continuity term). None of them read the
// active CPT. The catalogue (CAT) itself lives in eurocode-tabel3.js; suggestSubtype
// accepts an alternative catalogue so a caller can score against a subset.

import { CAT } from '../eurocode-tabel3.js';

export const CAT_GROUPS={
  veen:'Veen',
  klei:'Klei / Klei zandhoudend',
  leem:'Leem / Zandhoudende leem',
  zand:'Zand / Leemhoudend zand',
  grind:'Grind',
};

/* Compatibility matrix: CPT type → {compatible grps, adjacent grps}
   'compatible' = expected match, no warning
   'adjacent'   = plausible (transition zone), show note in dropdown but allow
   anything else = incompatible, shown in disabled optgroup with warning */
/* COMPAT: CPT soil behaviour type → {ok: Tabel 3 groups, adj: adjacent groups}
   'ok'  = directly expected for this CPT type — shown first in dropdown, ✓/~/· hints
   'adj' = adjacent/transition — shown with ⚠ prefix, selectable
   rest  = incompatible — disabled

   Robertson types → Tabel 3 mapping:
     Peat/organic (Zone 2)  → veen
     Soft clay   (Zone 1)   → klei (sensitive clay), leem adj
     Clay        (Zone 3)   → klei, leem adj
     Sandy clay  (Zone 4)   → leem AND klei zh (both are silt mixtures in Tabel 3)
     Silty sand  (Zone 5)   → zandhoudende leem (leem grp) + leemhoudend zand (zand grp)
                              pure klei is not treated as an adjacent transition here
     Sand        (Zone 6)   → zand, grind adj
     Gravel      (Zone 7)   → grind, zand adj
*/
export const COMPAT={
  'Peat / organic': {ok:['veen'],             adj:[]},
  'Soft clay':      {ok:['klei'],             adj:['leem']},
  'Clay':           {ok:['klei'],             adj:['leem']},
  'Sandy clay':     {ok:['leem','klei'],      adj:['zand']},
  'Silty sand':     {ok:['leem','zand'],      adj:[]},
  'Sand':           {ok:['zand'],             adj:['grind','leem']},
  'Gravel':         {ok:['grind'],            adj:['zand']},
};

export function compatLevel(cptType, grp){
  const c=COMPAT[cptType]||{ok:[],adj:[]};
  if(c.ok.includes(grp))  return 'ok';
  if(c.adj.includes(grp)) return 'adj';
  return 'bad';
}

export function subtypeGroup(subtype){
  const ent=CAT.find(r=>r.subtype===subtype);
  return ent?ent.grp:'';
}

/* ── qc/Rf fit check ───────────────────────────────────────────────────
   Returns whether a CAT entry's qc and Rf ranges match the layer's
   average values. 'match'=within range, 'close'=within 50% margin,
   'out'=clearly outside. Only applied within compatible groups. */
export function qcRfFit(entry, avgQc, avgRf){
  /* Strict matching against NEN Tabel 3 qc and Rf ranges.

     BOUNDARY RULES from Tabel 3:
     - qc: lower bound inclusive, upper bound exclusive  (e.g. "2 ≤ qc < 4")
     - Rf: lower bound inclusive, upper bound inclusive  (e.g. "Rf 3–6%")
     - Exception: Rf < 1% entries (clean zand/grind) → upper bound is EXCLUSIVE
       because Rf=1.0% belongs to the leem/kleihoudend zone (Rf 1–2%)
     - Veen requires Rf > 6% (hard gate, no tolerance)

     Returns: 'match' = both qc and Rf in range for this entry
              'close' = qc matches, Rf within 0.3pp of boundary
              'out'   = clearly outside → shown as '·' hint only
  */
  const rf = avgRf ?? null;

  // Hard veen gate: must have Rf > 6%
  if(entry.grp === 'veen' && rf !== null && rf < 5.5) return 'out';

  // qc check (exclusive upper bound per Tabel 3 notation)
  const qcOk = avgQc >= entry.qcMin && avgQc < entry.qcMax;

  // Rf check — boundary inclusivity depends on entry type
  let rfOk;
  if(rf === null){
    rfOk = true;  // no Rf data: skip Rf check
  } else if(entry.rfMax === 1 && entry.rfMin === 0){
    // Clean zand / grind: Tabel 3 "Rf < 1%" → strict exclusive upper
    rfOk = rf >= 0 && rf < 1.0;
  } else if(entry.rfMax === 2 && entry.rfMin === 1){
    // Lh/kh zand / grind: Tabel 3 "Rf 1–2%" → inclusive both ends
    rfOk = rf >= 1.0 && rf <= 2.0;
  } else {
    // All other entries: inclusive both ends
    rfOk = rf >= entry.rfMin && rf <= entry.rfMax;
  }

  if(qcOk && rfOk) return 'match';

  // Close: qc in range, Rf within 0.3pp of boundary
  let rfClose;
  if(rf === null) rfClose = true;
  else rfClose = rf >= entry.rfMin - 0.3 && rf <= entry.rfMax + 0.3;
  if(qcOk && rfClose) return 'close';

  return 'out';
}

/* ── Auto-suggest best CAT entry for a layer ──────────────────────────
   Called when layer has no subtype yet (or on param method change).
   Picks the highest-scoring compatible entry based on qc and Rf. */
export function suggestSubtype(l, catalogue = CAT){
  /* Suggest the single best CAT entry for this layer's qc and Rf.

     Priority:
     1. Compatible group (COMPAT.ok) with qc AND Rf matching → score 10
     2. Compatible group with qc matching, Rf close (±0.5pp) → score 5
     3. Compatible group with qc matching, Rf out → score 2
        BUT: never suggest veen if Rf < 6% (Tabel 3 hard gate)
        AND: if the best ok-candidate has Rf mismatch, also check adj groups
     4. Adjacent group with qc+Rf match → score 3 (preferred over ok+Rf mismatch)
     5. Proximity-based fallback within ok group
  */
  const qc  = l.avgQc;
  const rf  = l.avgRf ?? null;

  // Hard veen exclusion: veen entries require Rf>6%
  const rfBlocksVeen = rf !== null && rf < 5.0;

  let best = null, bestScore = -99;

  const levels = ['ok', 'adj'];
  for(const level of levels){
    const candidates = catalogue.filter(r => compatLevel(l.type, r.grp) === level);
    for(const r of candidates){
      // Hard exclusion: never suggest veen if Rf clearly not peat-range
      if(r.grp === 'veen' && rfBlocksVeen) continue;

      const fit = qcRfFit(r, qc, rf);
      let score = 0;
      if(level === 'ok'){
        if(fit === 'match')      score = 10;
        else if(fit === 'close') score = 5;
        else {
          // qc out of range — penalise by distance
          const qcDist = qc < r.qcMin ? r.qcMin - qc : Math.max(0, qc - r.qcMax);
          score = 2 - qcDist;
        }
      } else {
        // adj group — only suggest if it fits better than ok candidates
        if(fit === 'match')      score = 4;   // slightly below ok-match
        else if(fit === 'close') score = 2;
        else score = -1;
      }
      // Tie-break: prefer entry whose qc midpoint is closest to layer avgQc
      const qcMid = (r.qcMin + Math.min(r.qcMax, 20)) / 2;
      score += 0.01 * (1 - Math.abs(qc - qcMid) / Math.max(qcMid, 1));

      if(score > bestScore){ bestScore = score; best = r; }
    }
  }
  return best;
}

/* ════════════════════════════════
   CROSS-CPT LAYER COMPATIBILITY
   (used by Stage 3 smart-merge continuity scoring and the section view;
   the multi-CPT correlation itself lives in src/lib/cpt-app/stratigraphy/)
════════════════════════════════ */
export function layerTypeCompatScore(lA, lB){
  /* Multi-level type compatibility for correlation.
     Uses both the COMPAT matrix (grp-based) AND direct type matching.
     Mixed/transition layers (Sandy clay = leem/klei border) get adjacency credit
     on both sides of the boundary. */
  const compatA=COMPAT[lA.type]||{ok:[],adj:[]};
  const compatB=COMPAT[lB.type]||{ok:[],adj:[]};

  // Get Eurocode Table 3 group of each layer's subtype
  const entA=CAT.find(r=>r.subtype===lA.subtype);
  const entB=CAT.find(r=>r.subtype===lB.subtype);
  const grpA=entA?entA.grp:'';
  const grpB=entB?entB.grp:'';

  // Direct type match (both same CPT type)
  if(lA.type===lB.type) return 1.0;

  // A's subtype group is in B's compat.ok
  if(grpA&&compatB.ok.includes(grpA)) return 0.9;
  // B's subtype group is in A's compat.ok
  if(grpB&&compatA.ok.includes(grpB)) return 0.9;

  // Adjacent type (transition zones)
  if(grpA&&compatB.adj.includes(grpA)) return 0.5;
  if(grpB&&compatA.adj.includes(grpB)) return 0.5;

  // CPT types are compatible (even without subtype info)
  const cpttypes_compat={
    'Sandy clay': ['Clay','Soft clay','Silty sand'],
    'Silty sand': ['Sandy clay','Sand'],
    'Soft clay':  ['Clay','Sandy clay'],
    'Clay':       ['Soft clay','Sandy clay'],
    'Sand':       ['Silty sand','Gravel'],
    'Gravel':     ['Sand'],
  };
  if((cpttypes_compat[lA.type]||[]).includes(lB.type)) return 0.4;
  if((cpttypes_compat[lB.type]||[]).includes(lA.type)) return 0.4;

  return 0.0; // genuinely incompatible
}
