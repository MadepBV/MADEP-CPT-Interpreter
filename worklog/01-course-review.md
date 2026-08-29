# 01 — Review of the course material (accuracy, references, consistency)

Reviewer: Claude (session 2026-08-29). Method: every equation re-derived, every worked number
recomputed independently (`worklog/verify/verify_course_examples.py`, 176 checks, all pass), every
equation image inspected (`worklog/course-images/`), references checked for internal consistency
and against standards knowledge. Items are graded **OK** / **CHECK** (cannot be verified from the
material in this repo — needs the controlled standard/guideline) / **ISSUE** (defect or inconsistency).

---

## A. Sheet_Pile_Retaining_Walls_Manual_EC7_PLAXIS_v24 (Rev. 1, 27-08-2026)

### A.1 Mechanics and arithmetic — OK
| Item | Result |
|---|---|
| Rankine table §3.1 (20°–40°) | reproduced to 5 decimals |
| Eq. (11)–(12) segment integration | correct (trapezoid resultant, centroid ℓ(p₁+2p₂)/[3(p₁+p₂)]) |
| Cantilever §4.3, eq. (13)–(14); illustration H=3, φ=30, γ=18 | z₀ = 0.375 m, D₀ = 2.778 m, Rₜ = 108.2 kN/m — reproduced |
| One-level supported §4.4, eq. (15)–(22) | moment of pressure about the support derived correctly; V/M expressions correct |
| §6.2 SLS branch | D = 2.4362 m, T = 81.380 kN/m, z₀ = 0.8194, M = 144.209 kNm/m @ y = 4.6825 m — reproduced to 4–6 digits |
| §6.3 BGT + α_ver | D = 2.4513, T = 83.021 (×1.35 = 112.078), M = 146.265 (×1.35 = 197.458) — reproduced |
| §6.4 DA1/2 | φ_d = 24.7913°, K_a = 0.4091315, K_p = 2.4442018, A = 50.89596, B = −36.63127, M_above = 493.7256, D = 3.56806, T = 122.9213, z₀ = 1.38941, M = 258.2326 @ 5.19899 m; p = 4.500 / 50.896 / −79.807 kPa — all reproduced |
| §6.5 anchor conversion | F = 122.921·2/cos 15° = 254.5 kN, V = 65.9 kN — correct |
| §6.6 water sensitivity | D = 8.653 m reproduced within 0.5 % with the stated hydrostatic idealisation (retained WT at surface, front WT at excavation, γ_sat 20, γ_w 9.81) |
| §7.2 AZ 25 plate set | EA = 3.89·10⁶, EI = 1.10·10⁵, M_p = 690, N_p = 4440, w = 1.42 — arithmetic correct for the quoted A, I, W_pl, G_w |
| §8.5 R_inter = tan δ / tan φ′ | standard PLAXIS definition — OK |

### A.2 Normative statements — CHECK / notes
- **RK2 partial factors (§5.2)**: DA1/2 γ_Q = 1.10, M2 = 1.25/1.25/1.40 — consistent with the Rekennota (same guideline, Table 8). The *generic* NBN EN 1997-1 ANB set A2 has γ_Q = 1.30 (the app's current default). Both cannot be "the" default: the guideline value applies to embedded walls designed under its risk-class scheme. **Decision for the app: expose the risk class explicitly (RK1/RK2/RK3 + "generic ANB") with RK2 as the default for embedded walls, documented.**
- **Over-excavation (§5.3)**: +0.30 m dry (ULS); Δa = min(0.1h, 0.5 m) under water — consistent with Rekennota §4.5. EN 1997-1 §9.3.2.2(2) itself gives 10 % of the retained height (≤ 0.5 m) for cantilever walls / 10 % of the height below the lowest support for supported walls. The manual does not mention that the EN rule can be *larger* than 0.30 m for tall dry cantilever walls (H > 3 m). **CHECK against the guideline §3.3 text; the app will offer both rules.**
- **Wall friction (§3.5)**: |δ| ≤ ⅔φ′_k (straight), φ′_k − 2.5° and ≤ 30° (curved), δ = 0 in peat — attributed to the guideline. Consistent with EN 1997-1 §9.5.1(6) (k ≤ ⅔ for steel sheet piles). The Berliner-wall limits in the Rekennota (φ′_k/3 straight, φ′_k/2 curved, Table 4) are different and plausible for a discontinuous wall. **CHECK against the guideline Table 4.**
- **Structural route (§5.4)**: characteristic strengths + α_ver = 1.1 on variable actions, effects × 1.35 — consistent with Rekennota §3.5/§6.1.
- **φ-c reduction ≥ 1.25 (§5.5)** — consistent with Rekennota.
- **k_h from CPT (§4.6)**: 1–2 q_c (NC) / 2–4 q_c (OC) MN/m³ — attributed to the guideline; not verifiable here. **CHECK.**
- **EN 1997-1:2024 / EN 1993-5:2025 status (§1.3)** — time-dependent statements; correct in spirit (re-check at design date).

### A.3 References — mostly OK, two ISSUEs
- [7] "Bentley Systems (2026)" KB article with the AZ 25 example: exists as a Bentley KB item ("How to derive plate properties for sheet pile walls"); year unverifiable. OK-ish.
- [13] Schanz, Vermeer, Bonnier 1999 — correct. [14] Simpson & Powrie 2001, 15th ICSMGE Istanbul — correct.
- **ISSUE A-1**: [6] cites **NBN EN 12063:2024** while the Rekennota cites **NBN EN 12063:1999**. Only one can be current; the Rekennota should be updated if the 2024 edition is published as NBN.
- **ISSUE A-2**: The docx package embeds 20 images that belong to the Brinch Hansen chapter (media/image1–20) although only image21–30 are displayed. Harmless for readers, but the file carries foreign figures — clean the media folder before distribution.
- Minor: the notation box uses D for embedment, the Brinch Hansen chapter uses D_e — deliberate, stated.

### A.4 Content gaps relevant to the app
- No treatment of EN 1993-5 interlock/β_B reduction for U-piles beyond a reminder (§7.3).
- No sloping/bermed retained surface method (says: Annex C or wedge) — the Rekennota uses a 45°-spread equivalent-surcharge approximation for a berm; the app labels that as an approximation.
- SLS movement only via the beam-on-springs outline (Algorithm C) — not implemented in this session (scope), documented as a follow-up.

---

## B. Brinch_Hansen_Tlat_Soldier_Pile_Walls_Textbook_Section (Rev. 1, 26-08-2026)

### B.1 Equations — OK (verified against the 1961 formulation, the NUMGE paper and the Rekennota)
- Eq. (2): P_q = e^{(π/2+φ)tanφ}·cosφ·tan(45°+φ/2); K_q^A = e^{−(π/2−φ)tanφ}·cosφ·tan(45°−φ/2); K_q⁰ = P_q − K_q^A; K_c⁰ = (P_q − 1)cotφ.
- Eq. (3): K₀ = 1 − sinφ; d_c^∞ = 1.58 + 4.09 tan⁴φ; N_c = [e^{π tanφ} tan²(45°+φ/2) − 1]cotφ; K_c^∞ = N_c d_c^∞; K_q^∞ = K_c^∞ K₀ tanφ.
- Eq. (4): K_q(ξ) = (K_q⁰ + K_q^∞ a_q ξ)/(1 + a_q ξ), a_q = K_q⁰/(K_q^∞ − K_q⁰)·K₀ sinφ/sin(45°+φ/2); K_c likewise with a_c = K_c⁰/(K_c^∞ − K_c⁰)·2 sin(45°+φ/2).
- Eq. (5) (Andersen–Lodahl): e_w(z) = (γ′z + p_f)K_q(z) + cK_c(z) − (γ′H + p_b)K_q^A — identical to NUMGE2023-25 eq. (2)+(3).
- §3.7 φ→0 limits: K_c⁰ → 1+π/2 = 2.5708, N_c → π+2, K_c^∞ → 8.1237, a_c → 0.6547 — reproduced numerically (φ = 10⁻⁴°).
- §7.3 constants for φ_d = 20.5° (P_q … a_c): all 11 reproduced to 6 decimals. Table §7.4: K_q(z), e_w(z), T_lat reproduced; zero crossing 0.198 m; R_u = 6.981 kN, M_u = 7.066 kNm, z̄ = 1.012 m reproduced.
- §7.5 Rankine comparison 2.78 kN/m at the toe — reproduced.

### B.2 Engineering interpretation — OK with clear labelling
- The positive-part operator, the row-interaction cap min{B[e_w]⁺, s·p_net,continuous} and the "recompute T_lat at φ_d" rule are correctly declared as the chapter's own implementation rules, not Brinch Hansen's.
- §4.1 warns against double-subtracting active pressure — correct and important (K_q is already net).
- §2.1: "d/B ≈ 3 is not a code rule" — faithful to NUMGE (single granular case).

### B.3 References — OK / CHECK
- [1] Brinch Hansen 1961, DGI Bulletin 12 pp. 5–9; [2] Christensen 1961 same bulletin — consistent with NUMGE reference list. OK.
- [3] DOI 10.53243/NUMGE2023-25 — matches the PDF. OK.
- [9] "PLAXIS 2D 2025.1.2 release notes item 1749896 (T_lat strength reduction)" — **CHECK** (cannot verify offline; the design consequence — run an explicit DA1/2 plastic phase with recomputed T_lat,d — is prudent regardless).
- [8] "2D Analysis of an Anchored Soldier Pile Wall, PLAXIS 2D 2024.3 tutorial, May 2025" — **CHECK**.

### B.4 Gaps
- Equations (1), (6)–(11) are images only (no OMML) — fine for reading, but not machine-checkable; the app documents them in HTML.
- No worked example of the row cap or of a layered profile; the app implements both.

---

## C. Vibratory_Pile_Installation_Manual_Eurocode_Course_Chapter (edition 1.0, 29-08-2026)

### C.1 Arithmetic — OK
- §8: χ = 0.473233; A_b, P, A_s, pile mass 313.7 kg; W_eff = 36.582 kN; R_static = 252.794 kN; Table 8A/8B (α, q_d, τ_d, R_s, R_b, margins) reproduced; roots 85.574 / 113.809 kN; M_e = 2.5847 kg·m; s₀ = 1.175 mm; σ = 24.3 MPa; all six sensitivity roots reproduced (54.0 / 240.7 / 130.0 / 101.3 / 128.4 / 104.3).
- §11: TRL values at 30 m for all nine (k_v, δ_v) pairs reproduced; §12.5 BS 7385-2 44 mm/s at 35 Hz and DIN 11.25 mm/s reproduced; §15.5 two-point calibration (n = 1.3219, K = 104.93, v₃₀ = 1.17) reproduced.

### C.2 Model provenance — CHECK
- The degradation law χ = (1 − 1/Λ)e^{−1/FR} + 1/Λ and the exponential interpolation q_d = (q_s − q_l)e^{−α} + q_l are presented as the Van Rompaey–Legrand–Holeyman (1995) / Hypervib1 model. The chapter is internally consistent, but the primary source is not in the repo; **the drivability agent has been asked to verify against open-access material**. Until verified, the app labels the model "as reproduced in the course chapter (Van Rompaey et al. 1995; Holeyman & Whenham 2017 critical review)".
- "1,281 vibratory-piling observations", "1.2 ≤ W_c ≤ 10.7 kJ/cycle" — TRL 429 database facts, **CHECK**.
- The chapter omits impact hammers entirely; the app adds a Smith wave-equation route with its own references (Smith 1960; FHWA NHI-16-009) because the user requires hammer-driving prediction.

### C.3 Receiver criteria — OK
- BS 7385-2 line 2: 15 → 20 → 50 mm/s at 4 / 15 / 40 Hz and the ≤ 50 % reduction for continuous vibration — correct.
- DIN 4150-3 line 2 (dwellings): 5 / 5–15 / 15–20 mm/s — correct.
- BS 5228-2 human-response descriptors 0.14 / 0.3 / 1.0 / 10 mm/s — correct.
- SBR-A (the framework actually used in the Belgian monitoring example) is **absent** from the chapter; the app implements it as a first-class framework.

### C.4 References — OK / CHECK
- Hiller & Crabb 2000 TRL 429 — correct. BS 5228-2:2009+A1:2014, BS 7385-2:1993, DIN 4150-3:2016-12, BS 6472-1:2008, ISO 4866:2010 — correct designations.
- Van Rompaey et al. 1995 WIT Trans. Built Env. 15, DOI 10.2495/SD950601; Holeyman & Whenham 2017 GGE 35:1933–1951, DOI 10.1007/s10706-017-0218-8; Massarsch et al. 2022 ICE GE 175(1) — plausible, **CHECK** DOIs online.
- JRC 2024 "Implementation of Design during Execution and Service Life", DOI 10.2760/9211877 — **CHECK**.

---

## D. NUMGE2023-25 (Andersen & Lodahl 2023) — OK
- Eq. (1)–(4) consistent with the chapter; conclusions (EBR below excavation; d/B ≲ 3 behaves as a full wall; plate-only unsafe for d/B > 3; deformations overestimated with default ISF) are faithfully summarised in the chapter and the Rekennota.

---

## E. Rekennota_beschoeiing_berlinerwand_HEA180 (v01, MADEP)

### E.1 Arithmetic — OK
- HEA180 section: A_v,z = 1447 mm², classification class 1, M_pl,Rd = 76.35, M_el,Rd = 69.00, V_pl,Rd = 196.3 kN — reproduced.
- Plate: EA = 9.503·10⁵ kN/m, EI = 5271 kNm²/m, d_eq = 0.2580 m, w = 1.140 kN/m/m — reproduced.
- EBR: γ_eff = 59.0; ISF = 0.905 / 9.050 — reproduced; T_skin slope 3.009 kN/m per m — reproduced; F_max 46.2 kN — reproduced.
- Brinch Hansen constants for φ = 25° and φ_red = 19.733° (Table 5-6) — all reproduced to 4 decimals; Table 5-7 (K_q, K_c, p_u char/red, K_p σ′_v s) — reproduced.
- Blum: K_a/K_p for SF 1.0/1.25/1.30; F_a = 26.55 kN, a = 0.6394 m, t₀ = 3.5393 m (SF 1.30) and 3.431 m (SF 1.25); D_req = 4.247 / 4.117 — reproduced.
- Lagging: M = 3.798 kNm/m, σ = 227.9 MPa, UC 0.970 — reproduced.

### E.2 Findings
- **ISSUE E-1 (naming)**: §5.4 calls √(12I/A) = 0.258 m "R_eq" (equivalent radius). In PLAXIS 2D the ISF default uses the equivalent *diameter* D_eq = √(12·EI/EA) (same number). The ISF values (0.905/9.050) are unaffected, but the symbol should read D_eq to match the PLAXIS manual. **CHECK against the PLAXIS 2D reference manual wording.**
- **ISSUE E-2 (reference)**: "NBN EN 12063:1999" vs the manual's "NBN EN 12063:2024" (see A-1).
- **CHECK E-3**: Table 3-2 attributes φ′_k = 25°, c′_k = 4 kPa, c_u,k = 50 kPa, γ = 19 kN/m³ to "leem, zandhoudend, vrij vast" (2 ≤ q_c < 4 MPa) in Table 3 of the guideline. The app's NEN Tabel 3 dataset lists different values for its "Leem" rows; the Belgian ANB Table 3 row must be confirmed by the engineer (the app will simply use the CPT-derived layer values plus explicit overrides).
- **Note E-4**: the slope behind the wall is idealised as an equivalent surcharge averaged under a 45° spread (§7.3). This is an approximation (not Annex C sloping ground); it is conservative for the vertical stress near the surface but not a rigorous earth-pressure solution — the app implements it as a labelled option.
- **Note E-5**: the GEO check applies passive over b_eff = min(3b, s) with plane-strain K_p and active below excavation over b (EAB / guideline §5). This is a *different* model from Brinch Hansen; the note itself insists they must not be mixed (§5.7). The app follows that: hand calc = effective-width Blum (default) **or** Brinch Hansen Blum; PLAXIS EBR table = Brinch Hansen with B = b, always.
- **ISSUE E-7 (method discrepancy with the BH chapter)**: Table 5-7 enters p_u = B·(σ′_v·K_q + c′·K_c) as the PLAXIS T_lat (equal-level Brinch Hansen resistance, **without** the Andersen–Lodahl retained-height active term), whereas the BH chapter §4.1/§8.3 and NUMGE2023-25 eq. (2) define the EBR cap as B·[e_w]⁺ **including** −(γ′H + p_b)·K_q^A. For H = 1.916 m, γ = 19.5, K_q^A(25°) ≈ 0.36 the term is ≈ 13.5 kPa → ≈ 2.4 kN/m per pile, i.e. the Rekennota table is 5–45 % higher than the A–L cap over the first 2 m. The Rekennota does not discuss the choice. **Resolved (revision 2 of the chapter, 29-08-2026):** the retained-height (Andersen–Lodahl) form is the physically consistent PLAXIS cap — the EBR lateral interface is a spring limited by a maximum force that transfers the *net* soil–pile interaction (Sluis 2012; Torggler 2016) — so the equal-level table is unconservative by B·Δσ′v·K_q^A. Quantified for the HEA180 case: ratio A–L/equal-level 0.33 at z = 0.25 m, 0.85 at 1 m, 0.97 at the toe; ∫T_lat 265 vs 286 kN per pile. A Blum hand calculation with the Brinch Hansen resistance needs t₀ = 4.13 m (with row cap) / 3.90 m (without) against 3.54 m with the effective-width model. New sections 4.5–4.6, Tables 4.1–4.3 and references [11]–[13] were added to the chapter; the app defaults to Andersen–Lodahl and prints the equal-level column beside it.
- **Note E-6**: SF 1.30 (SB260) vs 1.25 (guideline) — the note is explicit that 1.30 is the stricter, deliberately adopted value; the app exposes both (RK2 = 1.25 default, SB260 1.30 option).

---

## F. T26L053 LLTrillingsmonitoring (SBR-A example) — OK
- V_top,allow = V_kar/(γ_s·γ_v·γ_t) with γ_s = 1.7 (sensitive), γ_v = 1.6 (indicative), γ_t = 1.5 (structure, repeated short-term) / 1.6 (foundation): 5/(1.7·1.6·1.5) = 1.23 mm/s; 15/(…) = 3.68; 10/(1.7·1.6·1.6) = 2.30 — reproduced. Frequency table (5 → 15 → 20 mm/s at ≤10 / 50 / 100 Hz, category 2) consistent with SBR-A Table.
- The report gives limits but no prediction; the app closes that gap with the TRL 429 predictor and the same SBR-A limit derivation, so the "Figuur 2/3" table and graph can be generated from the app.

---

## G. Cross-document consistency
| Topic | Manual | BH chapter | Rekennota | Verdict |
|---|---|---|---|---|
| RK2 DA1/2 factors | 1.00/1.10; 1.25/1.25/1.40 | same | same (Table 4-3) | consistent |
| Over-dig | 0.30 m dry | 0.30 m dry | 0.30 m | consistent |
| φ-c reduction | ≥ 1.25 | ≥ 1.25 | ≥ 1.25 (adopts 1.30) | consistent |
| δ limits | ⅔φ′_k / φ′_k−2.5° (sheet piles) | — | φ′_k/3 / φ′_k/2 (Berliner) | wall-type specific — plausible |
| EN 12063 | 2024 | — | 1999 | **inconsistent** |
| Plate w for Berliner | — | — | includes lagging weight | fine (documented) |
| ν for plate | "use material value" | — | 0 for discrete walls | consistent with PLAXIS advice |

**Overall verdict:** the three course chapters are numerically correct and internally consistent; the normative statements are consistent with each other and with EN 1997-1, but several guideline-specific values (Table 4 δ limits, k_h correlations, over-dig wording) must be confirmed against the controlled BGGG/WTCB 2022 text, which is not in the repo. Two reference inconsistencies (EN 12063 edition; R_eq vs D_eq naming) should be corrected.


## H. Reference verification (29 Aug 2026) — DONE

All 83 references of the four documents were checked online (agent report `05-reference-verification.md` + hyperlink addendum §6): 53 verified as written, 26 corrected, 1 wrong DOI (JRC 10.2760/9211877 → 10.2760/8383117), 1 non-resolving DOI dropped (Van Rompaey et al. 1995, WIT vol. 14 not 15). Corrections applied to the docx files by `worklog/verify/apply_reference_corrections.py`:
- Sheet-pile manual → Revision 1b: guideline issuer (NBN E25007), EN 12063:2024 full title, Bentley KB numbers, Simpson & Powrie pp. 2505–2524, Piling Handbook 9th ed. 2016 rev. 2022, anchor guideline "Deel 3" title, URLs; Prevent-punching attribution softened.
- Brinch Hansen chapter → Revision 2 (reference list verified): PLAXIS 2024.3 → 2025, release-notes date February 2026 + KB0047805, KB0045693, EN 1997-1:2024 status page.
- Vibratory chapter → edition 1.0a: Van Rompaey vol. 14 + WIT URL, Holeyman 2002 editors/venue, Holeyman & Whenham title "Pile Vibro-Drivability" + issue 5, JRC authors/EUR 40128/ISBN/DOI, CIRIA R185 1999.
- Rekennota: NBN EN 1990 ANB:2021, NBN EN 1993-1-1 ANB:2018, NBN EN ISO 22476-1:2023, NBN EN 12063:2024 (+ scope remark on Berliner walls), Infofiche 56.2 "vóór", BGGG CPT procedure 2016, CUR 166 6e druk 2012, DIN 4150-3:2016-12, PLAXIS publisher/version placeholders, verification sentence.
- App: the same items in the docs pages (retaining-wall, soldier-pile, drivability), the calculation note (EN 1993-1-1 ANB:2018, EN 12063:2024) and `vibratory-drivability.js`.
Factual claims tied to sources (TRL 429 coefficients, BS 5228-2 Tables B.1/E.1, BS 7385-2, DIN 4150-3 Line 2, guideline Tabel 8, §3.3 over-dig, §3.5 FEM procedure) were confirmed verbatim.
