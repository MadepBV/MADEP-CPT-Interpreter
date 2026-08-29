# Agent `vibration` — construction-vibration impact assessment

Date 2026-08-29 · branch `v0.5.3` · work item **E** of `worklog/PLAN.md` §3.

## 1. What was built

All new files; the only edit to an existing file is one script line in `package.json`.

| File | Purpose |
|---|---|
| `src/lib/cpt-app/retaining/vibration/ppv-prediction.js` | TRL 429 / BS 5228-2 Annex E vibratory predictor `v = k_v·x^(−δ_v)`; BS 5228-2 percussive predictor `v = k_p·√W / r^1.3`; site power law `v = K·x^(−n)`; distance curve for plotting |
| `src/lib/cpt-app/retaining/vibration/receiver-criteria.js` | SBR-A 2017 (`sbrAAllowableVelocity`), DIN 4150-3 (`din4150Guideline`), BS 7385-2 (`bs7385Guideline`), BS 5228-2 Table B.1 human response (`humanResponseDescriptor`), one-framework wrapper `assessReceiver` |
| `src/lib/cpt-app/retaining/vibration/attenuation-calibration.js` | `calibrateTwoPoint`, `calibrateLeastSquares` (log-log, N ≥ 3, residual s, r², t-factor), `upperPrediction` (ln v95 = ln K − n ln x + 1.645 s), `predictFromFit` |
| `src/lib/cpt-app/retaining/vibration/monitoring-plan.js` | `buildMonitoringPlan` → expected / upper / warning / stop / structural guide / human objective, SBR-A-style frequency table 0–100 Hz in 5 Hz steps, traffic-light states, `suggestSensorLayout` (course §15.2) |
| `scripts/verify_vibration_ppv.mjs` | 38 checks |
| `scripts/verify_vibration_criteria.mjs` | 72 checks (criteria + monitoring plan) |
| `scripts/verify_vibration_calibration.mjs` | 29 checks |
| `package.json` | `"verify:vibration"` chaining the three scripts |

Coding rules followed: SPDX header, JSDoc with units/references/assumptions, pure functions (no DOM, no globals), explicit units in names (`_mm_s`, `_Hz`, `_m`, `_J`, `_m_s2`), `notes: string[]` instead of throws, every result tagged with its `framework` / `source` / `formula` / `quantity`. Strict `checkJs` reports no errors in the new files (`npx tsc --noEmit --ignoreConfig --allowJs --checkJs --strict --target es2022 --module esnext --moduleResolution bundler --skipLibCheck src/lib/cpt-app/retaining/vibration/*.js` → exit 0); no `// @ts-nocheck` was needed.

## 2. Every coefficient and where it was verified

### 2.1 TRL 429 / BS 5228-2:2009+A1:2014 Annex E — vibratory piling
Verified from the full text of BS 5228-2:2009+A1:2014, Table E.1 (uncontrolled copy hosted at
<https://www.omegawestdocuments.com/media/documents/43/CD43.12%20-%204%20Code%20of%20practice%20for%20noise%20and%20vibration%20control%20on%20construction%20and%20open%20sites%20part%202%20vibration;.pdf>),
and cross-checked against the course chapter §10–11 and the NZ Transport Agency research report 485 (<https://www.epa.govt.nz/assets/FileAPI/proposal/NSP000005/Hearings/f73d4769a3/APSOC-Closing-Subs-Attachment-report.pdf>, §8.1.2, "reproduced from table E.1").

| Item | Value | Source line (Table E.1) |
|---|---|---|
| k_v | 60 (50 %), 126 (33.3 %), 266 (5 %) | "kv = 60 (50%) / kv = 126 (33.3%) / kv = 266 (5%)" |
| δ_v | 1.3 all operations, 1.2 start-up/run-down, 1.4 steady state | "d = 1.3 (all operations) / d = 1.2 (start up and run down) / d = 1.4 (steady state operation)" |
| domain | 1 ≤ x ≤ 100 m; 1.2 ≤ W_c ≤ 10.7 kJ | Table E.1 parameter range |

Course table reproduced to 3 decimals at x = 30 m: steady 0.513 / 1.078 / 2.275, all 0.721 / 1.514 / 3.196, start-up 1.013 / 2.127 / 4.491 mm/s.

### 2.2 BS 5228-2 Annex E — percussive (impact) piling
Same source, Table E.1 + Table E.2. The equation is `v_res = k_p · √W / r^1.3` with **r = slope distance from the pile toe, r² = L² + x²**, W in joules, and **k_p is a ground-condition factor, not a probability**:

| Ground condition (Table E.2) | k_p |
|---|---|
| All piles driven to refusal | 5 |
| Toe through very stiff cohesive / dense granular / fill with large obstructions | 3 |
| Toe through stiff cohesive / medium dense granular / compacted fill | 1.5 |
| Toe through soft cohesive / loose granular / loose fill / organic soils | 1 |

Domain: 1 ≤ L ≤ 27 m, 1 ≤ x ≤ 111 m, 1.5 ≤ W ≤ 85 kJ. Independently confirmed by NZTA report 485 Table 5.1 (same four classes, same values). **Deviation from the task text:** the task asked for k_p "for 50/33/5 %" — such probabilistic k_p values do not exist in BS 5228-2; the implemented `predictImpactPpv({ distance_m, hammerEnergy_J, toeDepth_m, groundCondition | kp })` follows the standard and says so in its notes.

### 2.3 BS 5228-2 Table B.1 — human response
Same source, Annex B, Table B.1: 0.14 mm/s "just perceptible in the most sensitive situations", 0.3 mm/s "just perceptible in residential environments", 1.0 mm/s "likely … cause complaint, but can be tolerated if prior warning and explanation has been given", 10 mm/s "likely to be intolerable for any more than a very brief exposure". Cross-checked with NZTA 485 Table 3.1.

### 2.4 SBR Trillingsrichtlijn A: Schade aan bouwwerken: 2017
Verified from the full guideline text (PDF hosted at <https://www.basystemen.nl/media/3a2dj1ai/sbr-trillingsrichtlijn-a-schade-aan-bouwwerken-2017.pdf>) and a consultant's summary/worked examples (<https://www.twenterand.nl/_flysystem/media/trillingspredictie-in-en-uittrillen-stalen-damwand.pdf>, bijlage D). Also the CROW kennisbank fragment for §10.3.5 (<https://kennisbank.crow.nl/public/gastgebruiker/FUNT/Trillingsrichtlijn_A_-_Schade_aan_bouwwerken_2017/Grenswaarden_voor_de_trillingsgevoelige_fundering/112246>).

| Item | Value | SBR-A 2017 reference |
|---|---|---|
| V_kar ground-floor load-bearing structure, cat. 1 | 20 (0–10 Hz) → 40 (50 Hz) → 50 (100 Hz), linear between; 5 Hz table values e.g. 15 Hz 22.5, 55 Hz 41 | Table 10.8 |
| V_kar cat. 2 | 5 → 15 → 20 mm/s (15 Hz 6.25, 30 Hz 10, 55 Hz 15.5) | Table 10.8 |
| V_kar highest floor / non-load-bearing parts | cat. 1: 40, cat. 2: 15 (frequency-independent) | Table 10.9 |
| γ_t structure and parts | 1.0 short / 1.5 repeated short / 2.5 continuous | Table 10.6 |
| γ_t foundation (settlement) | 1.0 / 1.6 / 2.0 | Table 10.6 |
| γ_s | 1.0 normal; 1.7 sensitive condition and/or monument | Table 10.7 |
| γ_v | 1.6 indicative / 1.4 limited / 1.0 extensive | Table 9.2 |
| Formula | V_r = V_kar/(γ_t·γ_s), V_d = V_top·γ_v ≤ V_r ⇔ V_top,allow = V_kar/(γ_s·γ_v·γ_t) | §10.3.1 Fig. 10.2; example note |
| Foundation acceleration | a_kar = 1 m/s²; γ_t, γ_s, C_D **not** applied to a_kar (only γ_v on the measured a_top) | §10.3.5, Table 10.11 |
| Foundation velocity | V_kar = 10·C_D, C_D = 1 + (8 − H)/7 ≤ 2 (Table 10.10: H = 1 → 2.00 … H = 8 → 1.00) | §10.3.5 |
| Category 3 | **not in the 2017 edition** — replaced by γ_s = 1.7 (kader 50: "5/2.5/1.7 = 1.18 mm/s" vs old "3/2.5 = 1.2 mm/s") | kader 50 |

Category 3 line 3 → 8 → 10 mm/s (pre-2017 editions) verified from <https://trillingen.com/artikelen/trillingsmetingen-sbr-richtlijn-a>; it is kept as `category: 3` but every result carries a legacy note recommending category 2 + `condition: 'sensitive'`.

Example note (T26L053 CN001A) reproduced exactly: 1.23 (≤ 10 Hz), 1.53 (15), 2.45 (30), 3.68 (50), 4.29 (75), 4.90 (100 Hz); top-floor/non-load-bearing 3.68; foundation 10/(1.7·1.6·1.6) = 2.30 mm/s. (The example prints 2.77 at 35 Hz because it rounds V_kar to 11.3 first; the exact value is 11.25/4.08 = 2.757.)

### 2.5 DIN 4150-3:2016-12
Table 1 (short-term, foundation and uppermost floor) verified from a reproduction of the 1999 table (Peter Millar, Appendix B, <https://promising-sparkle-d7f0c0cfc9.media.strapiapp.com/peter_millar_appendix_b_9d042ff732.pdf>, Table 2) and from IPM (<https://ipm.my/wp-content/uploads/2023/03/Vibration-Limit-For-Concrete-Floor-Slab_.pdf>, Tables 2 and 3, citing DIN 4150-3). The DIN 4150-3:2016 foreword (sample at <https://www.civilenghub.com/NewSamples/DIN/191933714/DIN-4150-3-2016-1.pdf>) lists the 2016 changes (new Table 2 for underground cavities, alternative foundation evaluation) — the Table 1/Table 3 values are unchanged.

| Line | Foundation 1–10 Hz | 10–50 Hz | 50–100 Hz | Top floor (short) | Top floor (long-term, Table 3) |
|---|---|---|---|---|---|
| 1 commercial/industrial | 20 | 20–40 | 40–50 | 40 | 10 |
| 2 dwellings | 5 | 5–15 | 15–20 | 15 | 5 |
| 3 sensitive / listed | 3 | 3–8 | 8–10 | 8 | 2.5 |

Footnote implemented: above 100 Hz at least the 100 Hz value applies. Course check: line 2 at 35 Hz = 11.25 mm/s.

### 2.6 BS 7385-2:1993
Table 1 verified from NZTA report 485 Table 3.4 (verbatim reproduction incl. notes) and from the pdfcoffee copy of the standard (<https://pdfcoffee.com/bs-7385-2-1993-pdf-free.html>): line 1 "50 mm/s at 4 Hz and above"; line 2 "15 mm/s at 4 Hz increasing to 20 mm/s at 15 Hz" and "20 mm/s at 15 Hz increasing to 50 mm/s at 40 Hz and above"; Note 1 values at the base of the building; Note 2 below 4 Hz displacement 0.6 mm (zero-to-peak). Continuous-vibration clause ("guide values in Table 1 may need to be reduced by up to 50 %" where resonance magnifies) confirmed from the same copy and from <https://www.sensorbee.com/guides/construction-vibration-monitoring-ppv-bs7385>. Linear interpolation as in the course §12.3: 35 Hz → 44 mm/s; 15 → 7.5 mm/s with the 50 % reduction.

### 2.7 Calibration (course §15.5–15.7)
Two-point example (10 m, 5.0) & (20 m, 2.0) → n = 1.3219, K = 104.93, v(30) = 1.17 mm/s reproduced. Least-squares formulas and the 1.645 s upper prediction implemented as printed; the small-sample caveat (N < 6) is emitted as a note and the one-sided 95 % t-quantile for ν = N − 2 is returned as `tFactor` for information (course: "use a formal small-sample prediction interval or a conservative envelope").

## 3. What could not be verified / deviations
* **Probabilistic k_p (50/33/5 %) for impact piling — does not exist in BS 5228-2.** Implemented the standard's ground-condition k_p (Table E.2) instead and documented it. Nothing omitted.
* **Exact clause number of the BS 7385-2 continuous-vibration reduction.** The wording and the "up to 50 %" figure are verified; one fetched copy labels it §7.4.3, the module cites "continuous-vibration clause (§7.5)" — treat the clause number as unverified; the value is not.
* **SBR-A category 3 (3/8/10)** is verified only for the pre-2017 editions (secondary source). The 2017 guideline explicitly dropped it; the code labels it legacy.
* **DIN 4150-3:2016** values verified through reproductions of the 1999 table plus the 2016 foreword (no change to Table 1/3); the 2016 text itself is paywalled.

## 4. Limitations (also stated in the JSDoc)
* TRL 429 / BS 5228-2 predictors are screening tools calibrated on a UK database (resultant PPV at the ground surface, 1–100 m); they do not use vibrator force, CPT data or soil damping, and the 5 % curve is not a maximum.
* Receiver limits refer to different quantities and locations (SBR-A: V_top component at the measuring point; DIN: max. component at the foundation / horizontal at the top floor; BS 7385-2: component at the building base). The wrapper never mixes frameworks and repeats this in its notes; comparing a predicted resultant with a component limit is conservative.
* The SBR-A foundation acceleration criterion is exposed (`aKar_m_s2`, `aAllow_m_s2 = 1/γ_v`) but no acceleration predictor exists here — it is a monitoring criterion.
* Settlement / densification of loose saturated sand is not covered by any PPV criterion (course §13).
* The monitoring plan's stop level defaults to the framework limit; the course requires a project allowance below the limit — a note says so, and `stop_mm_s` can only lower it.

## 5. How to run
```
npm run verify:vibration
# or individually
node scripts/verify_vibration_ppv.mjs
node scripts/verify_vibration_criteria.mjs
node scripts/verify_vibration_calibration.mjs
```
All three exit 0; any `FAIL` line exits 1.

## 6. Test tails
```
$ node scripts/verify_vibration_ppv.mjs | tail -n 6
== Power law and curve ==
OK    K = 104.93, n = 1.3219, x = 30 → 1.17 mm/s (course §15.5)  [1.170]
OK    curve has 4 points, x=30 matches scalar
OK    impact curve monotone
OK    unknown predictor → empty + note

38/38 OK

$ node scripts/verify_vibration_criteria.mjs | tail -n 8
OK    receiver at 8 m → control 5 m + receiver only, with note
OK    stop override above limit is rejected
OK    stop override below limit honoured
OK    DIN plan: stop 11.25, warning 5.625, table row 50 Hz = 15
OK    BS plan: stop 22 (44 × 0.5), vKar column 44

72/72 OK

$ node scripts/verify_vibration_calibration.mjs | tail -n 6
OK    s = 0 → v95 = fit, with note
OK    custom z (t-factor) increases the bound
OK    invalid input → NaN + note
OK    upper prediction envelopes all six noisy points  [6/6]

29/29 OK
```
