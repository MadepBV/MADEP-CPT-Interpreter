// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-nocheck
//
// model-params/soil-defaults.js — Stage 4 soil parameter tables and the α (Sanglerat / SB260) helpers.
//
// Moved verbatim out of src/lib/cpt-app/legacy-controller.js (PR 5, refactor step 2), lines 821-1035:
//   DEF                        821-829   generic per-type γ/γsat/φ/c/cu defaults
//   AE                         831-834   α Method A (SB260-21-6.4.10 fixed Sanglerat values)
//   MC_NU_BY_TYPE / _SUBTYPE   858-903   drained Poisson ratio ν' defaults (CSN 73 1001 / SCIA)
//   MC_RSHEAR_BY_TYPE/_SUBTYPE 906-951   interface shear ratio defaults
//   mohrCoulombNuDefault       954-958
//   mohrCoulombRShearDefault   960-964
//   sb260GranularAlpha         987-991   α Method B — SB260-21-6.4.10 Tabel 21-6-5
//   sb260TransitionAlpha       993-997
//   sb260AlphaFamily           999-1022
//   alphaEB                    1024-1035
// Pure constants and functions: no state, no DOM, no imports — safe under plain Node.

export const DEF={
  'Peat / organic':{g:11,gs:12,phi:17,c:0,cu:10},
  'Soft clay':     {g:15,gs:16,phi:20,c:2,cu:25},
  'Clay':          {g:17,gs:18,phi:24,c:5,cu:50},
  'Sandy clay':    {g:18,gs:19,phi:28,c:2,cu:0},
  'Silty sand':    {g:19,gs:20,phi:31,c:0,cu:0},
  'Sand':          {g:19,gs:20,phi:34,c:0,cu:0},
  'Gravel':        {g:20,gs:21,phi:38,c:0,cu:0}
};
/* Alpha Method A — fixed Sanglerat values (SB260-21-6.4.10) */
export const AE={
  'Peat / organic':1.5,'Soft clay':3.0,'Clay':5.0,
  'Sandy clay':8.0,'Silty sand':10.0,'Sand':13.0,'Gravel':15.0
};

/* Default drained Poisson ratios nu' for the Mohr-Coulomb deformation export
   and for Edef = beta*Eoed,i (beta = (1+nu)(1-2nu)/(1-nu), SCIA / CSN 73 1001).
   Priority: selected EC7 subtype first, then broad CPT soil family fallback.
   Provenance (full derivation + bibliography in /docs/workflow#stage4-scia-edef):
   - Mineral soils are anchored to the CSN 73 1001 directive normative
     characteristics (as reproduced in the SCIA Engineer 25.0 help), the native
     parameter set of the beta/Edef convention: gravels G1-G5 0.20-0.30, sands
     S1-S5 0.28-0.35, fine soils F1-F4 0.35 / F5-F7 0.40; capped at 0.40
     (0.42-0.45 are near-undrained magnitudes; nu_u = 0.5 is a short-term
     state, not a drained parameter — EN 1997-2:2007 Annex K.2(3), prEN 1997-2
     9.1.2.2, Buildwise 2022 sec 4.2.5).
   - veen uses measured drained values: nu' = 0.10-0.15 for fibrous peat with
     a K0-implied ceiling of ~0.21-0.26 (O'Kelly 2017); CSN has no peat class
     and the previous 0.40-0.45 was an undrained magnitude (beta down to 0.26).
   - leem keeps the international silt band 0.30-0.35 (AASHTO 10.6.2.2.3b-1,
     Bowles Table 2-7) — a deliberate departure from CSN F5 = 0.40, since
     Belgian leem is a low-plasticity loess silt.
   - Density grading rises in granular soils (Kulhawy & Mayne 1990:
     nu_d = 0.1 + 0.3(phi'-25)/20); consistency grading falls in clays
     (K0nc = 1-sin phi' matching, PLAXIS MMM 3.3.2). Family ordering
     Gravel < Sand reflects fines/plasticity control, per CSN G1-G2 0.20
     < S1-S2 0.28: nu' tracks fines content, not grain size. */
export const MC_NU_BY_TYPE={
  'Peat / organic':0.20,
  'Soft clay':0.40,
  'Clay':0.38,
  'Sandy clay':0.33,
  'Silty sand':0.30,
  'Sand':0.30,
  'Gravel':0.28
};

export const MC_NU_BY_SUBTYPE={
  'veen, weinig vast':0.15,
  'veen, matig vast':0.20,
  'veen, vast':0.25,

  'klei, weinig vast':0.40,
  'klei, matig vast':0.38,
  'klei, vrij vast':0.36,
  'klei, vast':0.35,
  'klei (zh), weinig vast':0.35,
  'klei (zh), matig vast':0.34,
  'klei (zh), vrij vast':0.33,
  'klei (zh), vast':0.32,

  'leem, weinig vast':0.35,
  'leem, matig vast':0.33,
  'leem, vrij vast':0.32,
  'leem, vast':0.30,
  'leem (zh), weinig vast':0.33,
  'leem (zh), matig vast':0.32,
  'leem (zh), vrij vast':0.31,
  'leem (zh), vast':0.30,

  'zand, los':0.28,
  'zand, matig':0.30,
  'zand, dicht':0.33,
  'zand, zeer dicht':0.35,
  'zand (lh), los':0.30,
  'zand (lh), matig':0.32,
  'zand (lh), dicht':0.34,
  'zand (lh), z.dicht':0.35,

  'grind, matig':0.28,
  'grind, dicht':0.30,
  'grind (kh), matig':0.30,
  'grind (kh), dicht':0.32
};

export const MC_RSHEAR_BY_TYPE={
  'Peat / organic':0.12,
  'Soft clay':0.14,
  'Clay':0.16,
  'Sandy clay':0.22,
  'Silty sand':0.28,
  'Sand':0.33,
  'Gravel':0.34
};

export const MC_RSHEAR_BY_SUBTYPE={
  'veen, weinig vast':0.10,
  'veen, matig vast':0.12,
  'veen, vast':0.15,

  'klei, weinig vast':0.12,
  'klei, matig vast':0.15,
  'klei, vrij vast':0.18,
  'klei, vast':0.20,
  'klei (zh), weinig vast':0.15,
  'klei (zh), matig vast':0.18,
  'klei (zh), vrij vast':0.20,
  'klei (zh), vast':0.22,

  'leem, weinig vast':0.18,
  'leem, matig vast':0.20,
  'leem, vrij vast':0.22,
  'leem, vast':0.25,
  'leem (zh), weinig vast':0.20,
  'leem (zh), matig vast':0.22,
  'leem (zh), vrij vast':0.25,
  'leem (zh), vast':0.28,

  'zand, los':0.30,
  'zand, matig':0.33,
  'zand, dicht':0.35,
  'zand, zeer dicht':0.35,
  'zand (lh), los':0.28,
  'zand (lh), matig':0.30,
  'zand (lh), dicht':0.32,
  'zand (lh), z.dicht':0.33,

  'grind, matig':0.33,
  'grind, dicht':0.35,
  'grind (kh), matig':0.30,
  'grind (kh), dicht':0.33
};

export function mohrCoulombNuDefault(type, subtype){
  const key=(subtype||'').trim().toLowerCase();
  if(key && Object.prototype.hasOwnProperty.call(MC_NU_BY_SUBTYPE, key)) return MC_NU_BY_SUBTYPE[key];
  return MC_NU_BY_TYPE[type] ?? 0.30;
}

export function mohrCoulombRShearDefault(type, subtype){
  const key=(subtype||'').trim().toLowerCase();
  if(key && Object.prototype.hasOwnProperty.call(MC_RSHEAR_BY_SUBTYPE, key)) return MC_RSHEAR_BY_SUBTYPE[key];
  return MC_RSHEAR_BY_TYPE[type] ?? 0.25;
}

/* Alpha Method B — SB260 family mapping driven by the selected EC7 subtype.
   Stage 4 uses layer avgQc; Stage 5 may pass row qc for pointwise fitting.
   Peat water content w is not available in the app, so veen defaults to α=1.5. */
/* ════════════════════════════════
   ALPHA METHOD B — SB260-21-6.4.10 Tabel 21-6-5
   
   Definitive subtype→rule-family mapping. Priority: subtype string first, then type.
   
   Cohesive:
   - veen, ...      → α=1.5 (w unknown in app)
   - klei, ...      → qc<0.7 => 5 ; 0.7-2 => 3 ; >=2 => 1.5
   - leem, ...      → qc<2 => 4 ; >=2 => 2

   Transition:
   - klei (zh), ... / leem (zh), ... / zand (lh), ...
     qc<2.5 => α=2 ; 2.5-5 => Es=4qc-5 ; >=5 => α=2

   Granular:
   - zand, ... / grind, ... / grind (kh), ...
     qc<=10 => Es=4qc ; 10-50 => Es=2qc+20 ; >50 => Es=120
════════════════════════════════ */
export function sb260GranularAlpha(qc){
  if(qc <= 10) return 4.0;
  if(qc <= 50) return +(((2*qc) + 20) / qc).toFixed(3);
  return +(120 / qc).toFixed(3);
}

export function sb260TransitionAlpha(qc){
  if(qc < 2.5) return 2.0;
  if(qc < 5.0) return +(((4*qc) - 5) / qc).toFixed(3);
  return 2.0;
}

export function sb260AlphaFamily(type, subtype, rf){
  const sub=(subtype||'').toLowerCase();

  if(sub.includes('veen')) return 'cohesive-peat';
  if(sub.includes('klei (zh)')) return 'transition';
  if(sub.includes('leem (zh)')) return 'transition';
  if(sub.includes('zand (lh)')) return 'transition';
  if(sub.includes('grind (kh)')) return 'granular';
  if(sub.includes('grind')) return 'granular';
  if(sub.includes('zand')) return 'granular';
  if(sub.includes('klei')) return 'cohesive-clay';
  if(sub.includes('leem')) return 'cohesive-loam';

  // Fallback by type if no EC7 subtype is available.
  if(type==='Peat / organic') return 'cohesive-peat';
  if(type==='Gravel') return 'granular';
  if(type==='Sand'||type==='Silty sand'){
    if(rf != null && rf >= 1 && rf <= 2) return 'transition';
    return 'granular';
  }
  if(type==='Clay'||type==='Soft clay') return 'cohesive-clay';
  if(type==='Sandy clay') return 'cohesive-loam';
  return 'cohesive-clay';
}

export function alphaEB(type, avgQc, subtype, avgRf){
  const qc = Math.max(avgQc||0.1, 0.01);
  const family = sb260AlphaFamily(type, subtype, avgRf);

  if(family==='transition') return sb260TransitionAlpha(qc);
  if(family==='granular') return sb260GranularAlpha(qc);
  if(family==='cohesive-peat') return 1.5;
  if(family==='cohesive-loam') return qc < 2.0 ? 4.0 : 2.0;
  if(family==='cohesive-clay') return qc < 0.7 ? 5.0 : (qc < 2.0 ? 3.0 : 1.5);

  return AE[type]||5.0;  // fallback Method A
}
