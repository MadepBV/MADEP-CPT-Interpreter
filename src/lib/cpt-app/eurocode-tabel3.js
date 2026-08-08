// SPDX-License-Identifier: AGPL-3.0-or-later
// NEN / Eurocode 7 Tabel 3 catalogue + row matcher.
// Extracted verbatim from legacy-controller.js so the table and its
// boundary rules are importable by the node verification scripts
// (scripts/verify_qc_only_handling.mjs) and by classification-core.js.

/* ═══════════════════════════════════════════════════════════════════════
   NEN / Eurocode 7 Tabel 3 — COMPLETE CATALOGUE
   "Karakteristieke grondparameters op basis van de resultaten uit
    een elektrische sondering"
   
   Every entry corresponds EXACTLY to one row of Tabel 3.
   No entries outside the table. No invented entries.
   
   Columns verified against table image:
     grp    = grondsoort family (determines dropdown grouping)
     label  = displayed name in dropdown
     type   = CPT soil behaviour type (for COMPAT routing)
     subtype= exact internal key (matches classSB260 output)
     g      = γ boven F.O. (kN/m³)
     gs     = γ onder F.O. (kN/m³)
     phi    = φ'k (°)
     c      = c'k (kPa)
     cu     = cu,k (kPa)
     qcMin  = lower qc bound (MPa, inclusive)
     qcMax  = upper qc bound (MPa, exclusive)
     rfMin  = lower Rf bound (%, inclusive)
     rfMax  = upper Rf bound (%, inclusive)
   
   GRIND: Tabel 3 shows qc ≥ 10 for matig and qc ≥ 20 for dicht.
   VEEN:  Tabel 3 shows Rf > 6% (hard gate). qc 0.2-0.5 / 0.5-1 / ≥1.
   ZAND:  Clean: Rf < 1%. With fines (lh/kh): Rf 1-2%.
   LEEM:  Pure: Rf 2-4%. Zandhoudend: Rf 1-3%.
   KLEI:  Pure: Rf 3-6%. Zandhoudend: Rf 2-5%.
   
   "Siltig zand" is NOT in Tabel 3 and has been removed.
   Robertson Zone 5 (Silty sand CPT type) maps to leemhoudend zand / 
   zandhoudende leem entries via COMPAT.
═══════════════════════════════════════════════════════════════════════ */
export const CAT=[
  // ──────────────────────────────────────────────────────────────────────
  // VEEN  Tabel 3: Rf > 6%, qc ranges as shown
  // γ boven/onder F.O.: 10/10, 12/12, 14/14  φ'=15°  c'=2,5,10  cu=10,20,40
  // ──────────────────────────────────────────────────────────────────────
  {grp:'veen', label:'Veen — weinig vast  (qc 0.2–0.5, Rf >6%)',
   type:'Peat / organic', subtype:'veen, weinig vast',
   g:10, gs:10, phi:15, c:2,  cu:10,
   qcMin:0.2, qcMax:0.5, rfMin:6, rfMax:99},

  {grp:'veen', label:'Veen — matig vast  (qc 0.5–1.0, Rf >6%)',
   type:'Peat / organic', subtype:'veen, matig vast',
   g:12, gs:12, phi:15, c:5,  cu:20,
   qcMin:0.5, qcMax:1.0, rfMin:6, rfMax:99},

  {grp:'veen', label:'Veen — vast  (qc ≥1.0, Rf >6%)',
   type:'Peat / organic', subtype:'veen, vast',
   g:14, gs:14, phi:15, c:10, cu:40,
   qcMin:1.0, qcMax:99,  rfMin:6, rfMax:99},

  // ──────────────────────────────────────────────────────────────────────
  // KLEI (pure)  Tabel 3: Rf 3–6%
  // γ: 16/16, 17/17, 18/18, 19/19  φ'=20°  c'=2,4,8,15  cu=20,50,100,200
  // ──────────────────────────────────────────────────────────────────────
  {grp:'klei', label:'Klei — weinig vast  (qc 0.4–1, Rf 3–6%)',
   type:'Clay', subtype:'klei, weinig vast',
   g:16, gs:16, phi:20, c:2,  cu:20,
   qcMin:0.4, qcMax:1.0, rfMin:3, rfMax:6},

  {grp:'klei', label:'Klei — matig vast  (qc 1–2, Rf 3–6%)',
   type:'Clay', subtype:'klei, matig vast',
   g:17, gs:17, phi:20, c:4,  cu:50,
   qcMin:1.0, qcMax:2.0, rfMin:3, rfMax:6},

  {grp:'klei', label:'Klei — vrij vast  (qc 2–4, Rf 3–6%)',
   type:'Clay', subtype:'klei, vrij vast',
   g:18, gs:18, phi:20, c:8,  cu:100,
   qcMin:2.0, qcMax:4.0, rfMin:3, rfMax:6},

  {grp:'klei', label:'Klei — vast  (qc ≥4, Rf 3–6%)',
   type:'Clay', subtype:'klei, vast',
   g:19, gs:19, phi:20, c:15, cu:200,
   qcMin:4.0, qcMax:99,  rfMin:3, rfMax:6},

  // ──────────────────────────────────────────────────────────────────────
  // KLEI ZANDHOUDEND  Tabel 3: Rf 2–5%
  // γ: 16/16, 17/17, 18/18, 19/19  φ'=22°  c'=2,4,8,15  cu=20,50,100,200
  // ──────────────────────────────────────────────────────────────────────
  {grp:'klei', label:'Klei zandhoudend — weinig vast  (qc 0.4–1, Rf 2–5%)',
   type:'Clay', subtype:'klei (zh), weinig vast',
   g:16, gs:16, phi:22, c:2,  cu:20,
   qcMin:0.4, qcMax:1.0, rfMin:2, rfMax:5},

  {grp:'klei', label:'Klei zandhoudend — matig vast  (qc 1–2, Rf 2–5%)',
   type:'Clay', subtype:'klei (zh), matig vast',
   g:17, gs:17, phi:22, c:4,  cu:50,
   qcMin:1.0, qcMax:2.0, rfMin:2, rfMax:5},

  {grp:'klei', label:'Klei zandhoudend — vrij vast  (qc 2–4, Rf 2–5%)',
   type:'Clay', subtype:'klei (zh), vrij vast',
   g:18, gs:18, phi:22, c:8,  cu:100,
   qcMin:2.0, qcMax:4.0, rfMin:2, rfMax:5},

  {grp:'klei', label:'Klei zandhoudend — vast  (qc ≥4, Rf 2–5%)',
   type:'Clay', subtype:'klei (zh), vast',
   g:19, gs:19, phi:22, c:15, cu:200,
   qcMin:4.0, qcMax:99,  rfMin:2, rfMax:5},

  // ──────────────────────────────────────────────────────────────────────
  // LEEM (pure)  Tabel 3: Rf 2–4%
  // γ: 17/17, 18/18, 19/19, 20/20  φ'=22°  c'=0,2,4,8  cu=10,25,50,100
  // ──────────────────────────────────────────────────────────────────────
  {grp:'leem', label:'Leem — weinig vast  (qc 0.4–1, Rf 2–4%)',
   type:'Sandy clay', subtype:'leem, weinig vast',
   g:17, gs:17, phi:22, c:0, cu:10,
   qcMin:0.4, qcMax:1.0, rfMin:2, rfMax:4},

  {grp:'leem', label:'Leem — matig vast  (qc 1–2, Rf 2–4%)',
   type:'Sandy clay', subtype:'leem, matig vast',
   g:18, gs:18, phi:22, c:2, cu:25,
   qcMin:1.0, qcMax:2.0, rfMin:2, rfMax:4},

  {grp:'leem', label:'Leem — vrij vast  (qc 2–4, Rf 2–4%)',
   type:'Sandy clay', subtype:'leem, vrij vast',
   g:19, gs:19, phi:22, c:4, cu:50,
   qcMin:2.0, qcMax:4.0, rfMin:2, rfMax:4},

  {grp:'leem', label:'Leem — vast  (qc ≥4, Rf 2–4%)',
   type:'Sandy clay', subtype:'leem, vast',
   g:20, gs:20, phi:22, c:8, cu:100,
   qcMin:4.0, qcMax:99,  rfMin:2, rfMax:4},

  // ──────────────────────────────────────────────────────────────────────
  // LEEM ZANDHOUDEND  Tabel 3: Rf 1–3%
  // (= zandhoudende leem: leem dominant with sand admixture)
  // γ: 17/17, 18/18, 19/19, 20/20  φ'=25°  c'=0,2,4,8  cu=10,25,50,100
  // ──────────────────────────────────────────────────────────────────────
  {grp:'leem', label:'Zandhoudende leem — weinig vast  (qc 0.4–1, Rf 1–3%)',
   type:'Sandy clay', subtype:'leem (zh), weinig vast',
   g:17, gs:17, phi:25, c:0, cu:10,
   qcMin:0.4, qcMax:1.0, rfMin:1, rfMax:3},

  {grp:'leem', label:'Zandhoudende leem — matig vast  (qc 1–2, Rf 1–3%)',
   type:'Sandy clay', subtype:'leem (zh), matig vast',
   g:18, gs:18, phi:25, c:2, cu:25,
   qcMin:1.0, qcMax:2.0, rfMin:1, rfMax:3},

  {grp:'leem', label:'Zandhoudende leem — vrij vast  (qc 2–4, Rf 1–3%)',
   type:'Sandy clay', subtype:'leem (zh), vrij vast',
   g:19, gs:19, phi:25, c:4, cu:50,
   qcMin:2.0, qcMax:4.0, rfMin:1, rfMax:3},

  {grp:'leem', label:'Zandhoudende leem — vast  (qc ≥4, Rf 1–3%)',
   type:'Sandy clay', subtype:'leem (zh), vast',
   g:20, gs:20, phi:25, c:8, cu:100,
   qcMin:4.0, qcMax:99,  rfMin:1, rfMax:3},

  // ──────────────────────────────────────────────────────────────────────
  // ZAND (clean)  Tabel 3: Rf < 1%
  // γ boven F.O.: 16,17,18,18  γ onder: 18,19,20,20  φ'=27,30,32,35°
  // c'=0  cu=—
  // ──────────────────────────────────────────────────────────────────────
  {grp:'zand', label:'Zand — los  (qc 2–4, Rf <1%)',
   type:'Sand', subtype:'zand, los',
   g:16, gs:18, phi:27, c:0, cu:0,
   qcMin:2,  qcMax:4,  rfMin:0, rfMax:1},

  {grp:'zand', label:'Zand — matig  (qc 4–10, Rf <1%)',
   type:'Sand', subtype:'zand, matig',
   g:17, gs:19, phi:30, c:0, cu:0,
   qcMin:4,  qcMax:10, rfMin:0, rfMax:1},

  {grp:'zand', label:'Zand — dicht  (qc 10–15, Rf <1%)',
   type:'Sand', subtype:'zand, dicht',
   g:18, gs:20, phi:32, c:0, cu:0,
   qcMin:10, qcMax:15, rfMin:0, rfMax:1},

  {grp:'zand', label:'Zand — zeer dicht  (qc ≥15, Rf <1%)',
   type:'Sand', subtype:'zand, zeer dicht',
   g:18, gs:20, phi:35, c:0, cu:0,
   qcMin:15, qcMax:99, rfMin:0, rfMax:1},

  // ──────────────────────────────────────────────────────────────────────
  // ZAND leem/kleihoudend  Tabel 3: Rf 1–2%
  // (= leemhoudend zand: zand dominant with silt/clay admixture)
  // γ boven F.O.: 16,17,18,19  γ onder: 18,19,20,20  φ'=25,27,30,32°
  // c'=0  cu=—
  // ──────────────────────────────────────────────────────────────────────
  {grp:'zand', label:'Leemhoudend zand — los  (qc 2–4, Rf 1–2%)',
   type:'Sand', subtype:'zand (lh), los',
   g:16, gs:18, phi:25, c:0, cu:0,
   qcMin:2,  qcMax:4,  rfMin:1, rfMax:2},

  {grp:'zand', label:'Leemhoudend zand — matig  (qc 4–10, Rf 1–2%)',
   type:'Sand', subtype:'zand (lh), matig',
   g:17, gs:19, phi:27, c:0, cu:0,
   qcMin:4,  qcMax:10, rfMin:1, rfMax:2},

  {grp:'zand', label:'Leemhoudend zand — dicht  (qc 10–15, Rf 1–2%)',
   type:'Sand', subtype:'zand (lh), dicht',
   g:18, gs:20, phi:30, c:0, cu:0,
   qcMin:10, qcMax:15, rfMin:1, rfMax:2},

  {grp:'zand', label:'Leemhoudend zand — zeer dicht  (qc ≥15, Rf 1–2%)',
   type:'Sand', subtype:'zand (lh), z.dicht',
   g:19, gs:20, phi:32, c:0, cu:0,
   qcMin:15, qcMax:99, rfMin:1, rfMax:2},

  // ──────────────────────────────────────────────────────────────────────
  // GRIND (clean)  Tabel 3: Rf < 1%, qc ≥ 10
  // γ: 18/20, 19/21  φ'=35,40°  c'=0  cu=—
  // ──────────────────────────────────────────────────────────────────────
  {grp:'grind', label:'Grind — matig  (qc 10–20, Rf <1%)',
   type:'Gravel', subtype:'grind, matig',
   g:18, gs:20, phi:35, c:0, cu:0,
   qcMin:10, qcMax:20, rfMin:0, rfMax:1},

  {grp:'grind', label:'Grind — dicht  (qc ≥20, Rf <1%)',
   type:'Gravel', subtype:'grind, dicht',
   g:19, gs:21, phi:40, c:0, cu:0,
   qcMin:20, qcMax:99, rfMin:0, rfMax:1},

  // ──────────────────────────────────────────────────────────────────────
  // GRIND leem/kleihoudend  Tabel 3: Rf 1–2%, qc ≥ 10
  // γ: 19/21, 20/22  φ'=32,37°  c'=0  cu=—
  // ──────────────────────────────────────────────────────────────────────
  {grp:'grind', label:'Grind klei-/leemhoudend — matig  (qc 10–20, Rf 1–2%)',
   type:'Gravel', subtype:'grind (kh), matig',
   g:19, gs:21, phi:32, c:0, cu:0,
   qcMin:10, qcMax:20, rfMin:1, rfMax:2},

  {grp:'grind', label:'Grind klei-/leemhoudend — dicht  (qc ≥20, Rf 1–2%)',
   type:'Gravel', subtype:'grind (kh), dicht',
   g:20, gs:22, phi:37, c:0, cu:0,
   qcMin:20, qcMax:99, rfMin:1, rfMax:2},
];

export const EUROCODE_CLASS_ENTRIES=[
  ...CAT.filter(r=>r.grp==='grind'),
  ...CAT.filter(r=>r.grp==='zand'),
  ...CAT.filter(r=>r.grp==='leem'),
  ...CAT.filter(r=>r.grp==='klei'),
  ...CAT.filter(r=>r.grp==='veen'),
];

/**
 * @param {{grp:string, qcMin:number, qcMax:number, rfMin:number, rfMax:number}} entry
 * @param {number} qc
 * @param {number|null|undefined} rf
 */
export function eurocodeEntryMatches(entry, qc, rf){
  if(qc < entry.qcMin || qc >= entry.qcMax) return false;
  if(rf == null) return false;

  if(entry.grp === 'veen') return rf > 6;
  if(entry.rfMin === 0 && entry.rfMax === 1) return rf < 1;
  if(entry.rfMin === 1 && entry.rfMax === 2) return rf >= 1 && rf <= 2;
  return rf >= entry.rfMin && rf <= entry.rfMax;
}
