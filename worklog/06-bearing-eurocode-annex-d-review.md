# Bearing capacity — is the app using the Eurocode 7 / Belgian formula?

Review of `src/lib/cpt-app/bearing/compute.js` and the web docs page `/docs/engineering/bearing`
(plus `/docs/reference` §8.4 and `/docs/full` §7) against EN 1997-1:2004 Annex D and the Belgian
national annex NBN EN 1997-1 ANB:2022. Date: 2026-10-14. Verification script:
`worklog/verify/verify_bearing_annex_d.mjs` (run from the repo root with `node`).

## 1. Verdict in one paragraph

The N-factors and the shape factors are exactly the EN 1997-1 Annex D forms, and the DA1/1 + DA1/2
partial-factor sets (M1, M2, R1) match Table A.4 / A.5 of EN 1997-1 and the Belgian DA1 tables
republished by Buildwise (2022). The one substantive deviation is that the app multiplies every
term by **depth factors** (d_q, d_c, d_cu). Annex D contains **no depth factors at all**; they are a
Brinch Hansen (1970) / Vesić (1973) addition. For a 2 × 2 m footing at D_f = 1 m they raise the
drained resistance by ~10 % and the undrained resistance by ~18 %. If the goal is "fully Eurocode
factors", the depth factors must be switchable off (and arguably off by default), and the docs must
stop calling the shape factors "Brinch Hansen".

## 2. Factor-by-factor comparison

Source text: EN 1997-1:2004 Annex D (informative), D.3 undrained, D.4 drained. Verified against the
BS EN 1997-1:2004 text (ngm2016.com mirror, pp. 157–159).

| Term | Annex D | App (`compute.js`) | Status |
|---|---|---|---|
| N_q | e^(π tan φ') tan²(45° + φ'/2) | same | OK |
| N_c | (N_q − 1) cot φ' ; 5.14 at φ' = 0 | same | OK |
| N_γ | 2 (N_q − 1) tan φ', δ ≥ φ'/2 (rough base) | same, labelled "EC7 Annex D rough base" | OK |
| s_q | 1 + (B'/L') sin φ' | same (r = B'/L', 0 for strip) | OK |
| s_γ | 1 − 0.3 (B'/L') | `max(0.6, 1 − 0.3 r)` | OK numerically; the 0.6 floor is a Brinch Hansen remnant that can never trigger (r ≤ 1 ⇒ s_γ ≥ 0.7). Dead code. |
| s_c (drained) | (s_q N_q − 1)/(N_q − 1) | same | OK |
| s_c (undrained) | 1 + 0.2 (B'/L') | same | OK |
| b_c, b_q, b_γ (base inclination) | present | = 1 (horizontal base assumed) | OK, documented |
| i_c, i_q, i_γ, i_cu (load inclination) | present | = 1 (vertical load assumed) | OK, documented in §7 and §11 of the docs |
| d_q | **not in Annex D** | 1 + 2 tan φ' (1 − sin φ')² k | Deviation |
| d_c (φ' > 0) | **not in Annex D** | d_q − (1 − d_q)/(N_c tan φ') | Deviation (this is the Vesić 1973 relation, not Brinch Hansen's 1 + 0.4k) |
| d_cu, d_c (φ' = 0) | **not in Annex D** | 1 + 0.4 k | Deviation |
| k | — | D_f/B' for D_f/B' ≤ 1, atan(D_f/B') above | Brinch Hansen 1970 |
| d_γ | — | 1.0 | consistent with BH/Vesić |
| q' (drained surcharge) | design effective overburden at base level | σ'_v at D_f | OK |
| q (undrained) | total overburden at base level | σ_v at D_f | OK |
| γ' in the N_γ term | design effective weight density below base | three-case water-table interpolation (Das/Meyerhof) | Not Annex D wording but conservative-or-equal; acceptable, and documented in §8 |
| Effective dimensions | B' = B − 2e_B, L' = L − 2e_L (6.5.4) | same | OK |
| Design values enter the formula (φ'_d, c'_d, c_u,d) | yes (D.4 "design values of dimensionless factors") | yes; N and s factors recomputed with φ'_d | OK |

Numeric check (`verify_bearing_annex_d.mjs`, square 2 × 2 m, D_f = 1 m, φ'_k = 30°, c' = 0,
γ = 18 kN/m³, WT deep, M1):

| Quantity | Hand Annex D | App | Difference |
|---|---|---|---|
| q_ult drained, M1 | 750.0 kPa | 821.7 kPa | +9.6 % (d_q = 1.144) |
| q_ult undrained, c_u,k = 50 kPa, M2 | 238.3 kPa | 282.3 kPa | +18.5 % (d_cu = 1.20) |

With the depth factors removed the app reproduces the hand values exactly.

## 3. Partial factors (Belgian DA1)

| Item | EN 1997-1 Annex A (recommended) | Belgian ANB:2022 as republished by Buildwise (2022, Table 1/8, risk class 2) | App |
|---|---|---|---|
| Design approach | NDP | DA1, combinations 1 and 2 | DA1/1 and DA1/2, "governing" envelope by default | 
| γ_φ' (on tan φ'), M2 | 1.25 | 1.25 | 1.25 |
| γ_c', M2 | 1.25 | 1.25 | 1.25 |
| γ_cu, M2 | 1.40 | 1.40 | 1.40 |
| γ_γ | 1.00 | 1.00 | not factored (= 1.00) |
| γ_R;v, set R1 (spread footing bearing) | 1.00 (Table A.5) | 1.00 ("Set R1") | 1.00; separate optional model factor γ_Rd defaulting to 1.00 |
| γ_Q in DA1/2 (action side, not applied in the app) | 1.30 | **1.10** in the Buildwise table | docs page §9 says "1.0 G_k + 1.3 Q_k for DA1/2" |

Notes.
- The Buildwise guideline states that the Belgian annex "legt onder meer een aantal keuzes en waarden
  vast op nationaal niveau, maar bepaalt echter geen berekeningsmethoden". So Belgium does not
  prescribe a bearing formula: Annex D stays informative and is the natural Eurocode reference, and
  nothing in the ANB adds depth factors. I could not open the ANB:2022 text itself (paywalled at
  NBN); this statement rests on the Buildwise republication.
- The Buildwise risk-class tables (RK1 1.10/1.10/1.25, RK3 1.40/1.40/1.55) are explicitly labelled an
  indicative proposal for retaining walls, not an ANB requirement. No action needed in the app.
- The γ_Q = 1.10 value for DA1/2 in Buildwise Table 1 looks like the Belgian NBN EN 1990 ANB choice
  for the geotechnical combination (set C). The docs page prints the EN-recommended 1.3. Verify
  against NBN EN 1990 ANB:2013 Table A1.2(C) and correct the docs sentence if 1.10 is confirmed.

## 4. Documentation discrepancies on the public docs page

1. `/docs/engineering/bearing` §6 is titled "Brinch Hansen factors on effective dimensions" and the
   UI/select label reads "Brinch Hansen / Annex D". The shape factors are Annex D forms
   (s_γ coefficient 0.3). Brinch Hansen (1970) uses s_γ = 1 − 0.4 B'/L' with a 0.6 floor, and
   Vesić uses s_q = 1 + (B/L) tan φ'. Only the depth factors are Brinch Hansen/Vesić. The label should
   read something like "EN 1997-1 Annex D shape factors; Brinch Hansen (1970)/Vesić (1973) depth
   factors".
2. The hero paragraph and §1 say the route "builds Brinch-Hansen shape / depth / inclination
   factors". Inclination factors are not computed (correctly stated in §7 and §11); the hero text
   contradicts that.
3. Nowhere does the page say that Annex D has no depth factors and that including them is an
   extension beyond the Eurocode text. The reference page §8.4 likewise lists d-factors without that
   caveat. For a tool advertised as "Eurocode factors" this must be stated.
4. §9 bullet 3: the DA1/2 action factor (see §3 above).
5. §2 says Annex D is "eq. D.2"; the drained expression is indeed (D.2) and the undrained one (D.1).
   Fine.
6. `/docs/full` §7.1 says "Shape factors now default to Brinch Hansen / Annex D values" — same
   mislabel as item 1.

## 5. Context: second-generation Eurocode 7 (EN 1997-3:2024)

Lesny & Orr (ECSMGE 2024, "Eurocode 7 – second generation – spread foundations") report that the
new EN 1997-3 Annex B.4 bearing formula (a) adds depth factors "proposed by Brinch Hansen (1970) and
adopted by Vesić (1973)", (b) adds ground-inclination factors (Vesić 1975), (c) changes N_γ to
2 (N_q + 1) tan φ' (Caquot-Kérisel/Vesić), and (d) states the depth factors "should only be used when
the strength of the soil or fill in the embedment zone is equal to or greater than the strength of the
soil below foundation level". So the app's depth factors anticipate the 2024 text, but then it is
inconsistent to keep the 2004 N_γ. The embedment-zone condition is also relevant to this app: it
applies d-factors over the full D_f using only the layer at founding depth, even when the overlying
CPT layers are softer fill. I did not obtain the Annex B.4 formula text itself, only the paper's
description, so the exact 2024 d-factor expressions are unverified here.

## 6. Other findings seen while reading (not formula related)

- **Governing mode for sands.** `governingResistance()` takes min(q_d drained, q_d undrained). The
  working layers give c_u = 0 for Sand / Silty sand / Gravel / Sandy clay, so the undrained curve
  collapses to q = σ_v and the panel reports "Governing: Undrained, q_d = 16 kPa" for a sand
  (visible in `tests/golden/browser/demo-journey/07-bearing.dom.txt`, lines 45–52). The undrained
  check should be skipped (or shown as n/a) when c_u = 0, otherwise the headline number is wrong for
  every granular founding layer.
- The `max(0.6, …)` floor in `shapeFactors` is unreachable (see table above).

## 7. Recommended changes (for your decision)

1. Add a `depthFactors` option (`'none' | 'hansen'`) to the bearing state, default `'none'` so the
   default route is pure Annex D, with the Brinch Hansen/Vesić set as an explicit opt-in. Show
   "d = 1.00 (Annex D)" in the formula cards when off.
2. Rename the shape-factor mode label and docs headings as in §4 item 1; add one sentence in docs
   §6 and reference §8.4 that depth factors are not part of Annex D.
3. Fix the hero sentence (inclination) and the DA1/2 γ_Q statement after checking NBN EN 1990 ANB.
4. Suppress the undrained envelope / governing comparison when c_u = 0.
5. Optional: if the depth factors stay available, add the EN 1997-3 embedment-strength caveat to the
   notes, or disable them automatically when any overlying working layer is weaker than the founding
   layer.

## Sources

- EN 1997-1:2004 (BS EN mirror): https://www.ngm2016.com/uploads/2/1/7/9/21790806/eurocode_7_-_geotechnical_designen.1997.1.2004.pdf — Annex D pp. 157–159, Table A.4 p. 130, Table A.5 p. 131, 2.4.7.3.4.2 p. 32.
- NBN EN 1997-1 ANB:2022 catalogue entry (published 2022-04-15, replaces ANB:2014): https://app.nbn.be/data/r/platform/frontend/detail?p40_id=353682&p40_language_code=nl&p40_detail_id=115432&lang=nl
- Buildwise, Richtlijnen voor de toepassing van EC7 in België – beschoeiingen, maart 2022 (DA1 tables, ANB statement): https://www.buildwise.be/media/srahyb00/na-ec-7-beschoeiingen-2022-final-nl.pdf
- Lesny & Orr, Eurocode 7 – second generation – spread foundations, ECSMGE 2024: https://www.issmge.org/uploads/publications/51/126/908_C_eurocode_7__second_generation__spread_foundations.pdf
- Geocentrix forum note that Annex D omits depth factors (also noted in the UK NA): https://www.geocentrix.co.uk/forums/viewtopic.php?t=656
- Brinch Hansen depth-factor forms (lecture summary): https://docenti.ing.unipi.it/iarg2006/02_Didattica/07%20Fondazioni/04_FS.pdf

## 8. Addendum 2026-10-14 (later the same day): docs fixed, action factor resolved, SB 250 / SB 260

### 8.1 Docs changes made

- `src/routes/docs/engineering/bearing/+page.svelte`: hero and §1 now say "EN 1997-1 Annex D … extended
  with Brinch Hansen (1970) / Vesić (1973) depth factors; no inclination factors computed"; §6 renamed
  "Shape factors (EN 1997-1 Annex D) and depth factors (Brinch Hansen / Vesić)", with a paragraph
  saying the shape factors are *not* Brinch Hansen's (0.4 / 0.6 floor) or Vesić's (tan φ′), a callout
  stating Annex D has no depth factors with the +10 % / +20 % magnitudes and the EN 1997-3:2024
  embedment-strength condition, s_γ shown as 1 − 0.3 r; §9 DA1/2 action factors now cite NBN EN 1990
  ANB Table A1.2(C) and add the "ANB prescribes no calculation method" bullet; §11 adds the "d-factors
  are not Annex D" bullet; references expanded (Annex D role, ANB:2022, Buildwise 2022, Lesny & Orr
  2024, NBN EN 1990 ANB:2021).
- `src/routes/docs/reference/+page.svelte` §8.4: q_ult, s-factor and d-factor notes relabelled.
- `src/routes/docs/full/+page.svelte` §7.1: reference-family sentence, s_γ equation, shape-factor
  bullet, new depth-factor bullet, references (NBN EN 1990 ANB:2005 → 2021, + Brinch Hansen 1970,
  Vesić 1973).
- UI strings in `bearing/compute.js` / `bearing/notes.js` ("Brinch Hansen / Annex D") were left
  unchanged on purpose: they are pinned by the browser golden DOMs; change them together with the
  depth-factor toggle.
- `npm run check`: 0 errors in the edited files (6 pre-existing errors in
  `deformation/wall-result-staleness.js`, untouched).

### 8.2 DA1/2 action factor in Belgium — resolved

Febelcem "Compendium Eurocode 2" (2017) reproduces NBN EN 1990 ANB Table A1.2(C): γ_G = 1.0,
γ_Q,1 = 1.3, accompanying 1.1 ψ0,i; and states "Benadering 1 … is normatief in België". So the docs'
"1.0 G_k + 1.3 Q_k" was right; the 1.10 in the Buildwise retaining-wall table is the accompanying-action
factor / the guideline's simplified α_ver. The docs now give the full set-C expression. Current ANB
edition is NBN EN 1990 ANB:2021 (replaces 2013; SPW catalogue).

### 8.3 SB 250 and SB 260 (Flanders)

- **SB 250** (Standaardbestek voor de wegenbouw, now v5.0 mandatory from 2026-01-01) is an execution
  and materials specification. Its "draagvermogen" clauses concern pavement foundations (plate tests,
  M1 ≥ 80 MPa on crushed-stone layers). It contains no soil bearing-capacity formula. For structures
  it hands over to SB 260, whose first chapters are additions to the SB 250 chapter numbers.
- **SB 260** (kunstwerken en waterbouw; v2.0a + errata Dec 2021 were current until v3.0, July 2025).
  The design rules sit in Hoofdstuk 21 "Ontwerp, studie en berekeningsnota's" §6 and the geotechnical
  elements in Hoofdstuk 24. What the public errata text (Dec 2021) shows:
  - 21-6.3.2: the whole structure is Geotechnical Category 2 per NBN EN 1997-1:2005 unless stated.
  - 21-6.3.1: partial load factors from "NBN EN 1990+A1 NL:2015", consequence class CC2.
  - Table 21-6-2 (new): for "Glijvlakberekening, draagvermogen (gedraineerd)" the drained strength
    characteristics are φ′ at failure for sands and φ′, c′ at 5 % strain for clays (2 % for retaining
    structures).
  - Table 21-6-3: ULS verification list includes "horizontaal glijdingsevenwicht en kantelevenwicht
    van funderingen op staal" (moved from the SLS characteristic combination to ULS).
  - 21-6.4.3.1 references NEN-EN 1997-1+C1:2012/NB:2012 art. 9.5.4 (the Dutch NA) for active earth
    pressure.
  - 24-1.7.1.2.B.1 "Bepaling van het draagvermogen uit grondmechanisch oogpunt" exists (putten en
    caissons); the errata only renumber a figure in it.
  - Nowhere in the errata is a bearing-capacity formula, Nγ form, shape factor or depth factor
    prescribed; the SB 260 v2.0 info session likewise covers only pile capacity (WTCB report 19).
  - **Not verified:** the base text of Hoofdstuk 21 §6 and Hoofdstuk 24 v2.0a/v3.0 (the chapter PDFs
    are behind the MOW kennisplatform login; docplayer mirrors were unreachable). The base text could
    contain a prescribed method; if the user has the PDF, grep it for "draagvermogen", "Bijlage D",
    "Brinch Hansen", "dieptefactor".
- Conclusion for the app: neither SB 250 nor SB 260 (as far as publicly readable) prescribes a
  bearing-capacity formula or depth factors; they impose Eurocode 7 + the Belgian ANB with DA1 and
  the strength-selection rules of Table 21-6-2. The app's Annex D route is compatible; the depth
  factors remain an extension to flag or switch off.

Additional sources: Febelcem Compendium EC2 (https://febelcem.be/app/uploads/2026/07/16_nl_EC2Compendium.pdf);
SB 260 errata Dec 2021 (https://assets.vlaanderen.be/image/upload/v1653908288/SB260_2.0_SB_Errata_en_aanvullingen_bij_SB_260_2.0_qdnt9u.pdf);
SB 260 v2.0 info session (https://assets.vlaanderen.be/image/upload/v1634566446/infosessie_SB260_2.0_201805_deel1_algemeen_rev1_et6jmk.pdf);
MOW SB 260 page stating v3.0 July 2025 (https://www.vlaanderen.be/departement-mobiliteit-en-openbare-werken/expertise-beton-en-staal/standaardbestek-260);
NBN EN 1990 ANB:2021 catalogue (https://qc.spw.wallonie.be/servlet/qc/norme?lst=1&lang=fr&indicatif=NBN+EN+1990+ANB).

## 9. Addendum (same day): depth-factor toggle implemented; second-generation Eurocode check

### 9.1 Toggle

- New state field `stage6.bearing.depthFactors`: `'none'` (default) = strict EN 1997-1:2004 Annex D,
  d_c = d_q = d_γ = d_cu = 1; `'hansen'` = the previous Brinch Hansen (1970) / Vesić (1973) set.
  `ensure()` clamps unknown values to `'none'`, so projects saved before the field existed load with
  depth factors off (more conservative than before).
- `compute.js`: `depthFactors(Df, B, phi, Nc, mode)`, `depthModeLabel(mode)`; `bearingAtDepth` returns
  `depthMode` / `depthModeLabel`. Shape-factor label renamed "Brinch Hansen / Annex D" → "EN 1997-1
  Annex D" (mode key `hansen` kept for saved projects).
- `notes.js`: `depthModeOptions/Help`, conditional note text. `panel.js`: "Depth factors" select in the
  advanced panel, "Depth factors" row in both parameter tables and both formula cards.
  `report/stage7`: "Depth factors" row + sentence in the bearing annex.
- Verified: `worklog/verify/verify_bearing_annex_d.mjs` — with `'none'` the app reproduces the hand
  Annex D values exactly (750.0 kPa drained M1, 238.3 kPa undrained M2); with `'hansen'` the previous
  numbers (821.7 / 282.3). `npm run golden:check` 2086/2086 after `golden:update` (95 cases, see
  `tests/golden/CHANGELOG.md`); browser journeys re-recorded.

### 9.2 Where depth factors now appear in a published Eurocode

- **EN 1997-3:2025 "Eurocode 7 — Geotechnical design — Part 3: Geotechnical structures"** is the
  published second-generation part. The "2024" designation used in the ECSMGE paper is the formal
  vote draft (FprEN 1997-3:2024-10). National adoptions: BS EN 1997-3:2025 (March 2025),
  **NBN EN 1997-3:2025 (published 2025-03-20, status active, English)**, ELOT EN 1997-3:2025
  (2025-08-12). EN 1997-1:2024 (general rules) was published by CEN in November 2024. A draft
  amendment EN 1997-3:2025/prA1:2026 is already listed by DIN.
- Formula (5.7) of the main text includes d_c, d_q, d_γ; Formula (5.3) includes d_cu. Annex B.4
  (informative) gives, per the public enquiry draft prEN 1997-3 (Nov 2021, CEN/TC 250/SC 7 N 1570,
  the latest text I could read):
  - d_q = 1 + 2 tan φ′ (1 − sin φ′)² (D/B) for D/B ≤ 1; … tan⁻¹(D/B) for D/B > 1; d_c = d_q − (1 − d_q)/(N_c tan φ′); d_γ = 1
    → identical to the app's `'hansen'` set.
  - d_cu = 1 + 0.33 tan⁻¹(D/B) → differs from the app's Brinch Hansen 1 + 0.4 k (the app keeps 1 + 0.4 k;
    at D/B = 0.5 the two give 1.153 vs 1.20).
  - N_γ = 2 (N_q + 1) tan φ′ (rough base) → the app keeps the Annex D 2 (N_q − 1) tan φ′.
  - NOTE under B.4(3) and B.4(6): the depth factors "should be taken as 1.0 when the strength of the
    soil above the foundation depth D is less than that at foundation level".
  - Also in the draft: the formula should only be used where strengths differ < 5 % between layers in
    the zone of influence; groundwater cases for q′ and γ′ (γ′ = γ only when the water table is deeper
    than 1.5 B below the base — the app interpolates over B′).
  - Caveat: the final 2025 wording may differ in detail from the 2021 draft; Lesny & Orr (2024)
    confirm that depth factors, ground-inclination factors and the N_γ change survived to the
    post-enquiry draft of May 2023.
- **Belgium:** NBN EN 1997-3:2025 is on sale but, per Buildwise (status page, June 2025), the
  second-generation Eurocodes are informative only until their Belgian national annexes are
  published; the first generation remains the reference until the Date of Withdrawal, 30 March 2028
  (Date of Publication of all parts with ANBs: 30 September 2027). No ANB for EN 1997-3 was found.
- Consequence for the app: `'none'` is the compliant setting for today's normative framework
  (EN 1997-1:2004 + NBN EN 1997-1 ANB:2022); `'hansen'` anticipates EN 1997-3:2025 B.4 for the
  drained factors. A later "EN 1997-3" mode would additionally need the 0.33·atan undrained factor,
  the 2(N_q + 1) N_γ, the g-factors and the weaker-overburden guard.

Sources (addendum): prEN 1997-3 N1570 (https://www.ags.org.uk/content/uploads/2022/06/pr-EN1997-3-v2021.07_N1570.pdf);
NBN EN 1997-3:2025 (https://app.nbn.be/data/r/platform/frontend/detail?p40_id=2695684&p40_language_code=nl&p40_detail_id=1546690&lang=nl);
BS EN 1997-3:2025 listing (https://www.boutique.afnor.org/en-gb/standard/bs-en-199732025/eurocode-7-geotechnical-design-geotechnical-structures/eu190582/443340);
ELOT EN 1997-3:2025 (https://eshop.elot.gr/en/product/110584); FprEN 1997-3:2024-10 at DIN (https://dinmedia.de/en/draft-standard/fpren-1997-3/385133601);
EN 1997-1:2024 (https://genorma.com/en/standards/en-1997-1-2024); Buildwise status (https://www.buildwise.be/nl/nieuws/status-van-de-nieuwe-generatie-eurocodes/).
