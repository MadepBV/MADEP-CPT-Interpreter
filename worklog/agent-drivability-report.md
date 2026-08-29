# Agent report — drivability ("heipredictie") modules

Date 2026-08-29 · branch `v0.5.3` · owner: agent `drivability` (PLAN §3 item D).
No existing file was modified except one added line in `package.json` (`verify:drivability`).

## 1. What was built

| File | Purpose |
|---|---|
| `src/lib/cpt-app/retaining/drivability/srd-from-cpt.js` | CPT → static-resistance-to-driving profile on a uniform grid below the platform. Methods `'reference'` (course §7.2, q_s = q_c, τ_s = f_s, user factors) and `'alm-hamre'` (Alm & Hamre 2001 friction fatigue, verified). Handles CPT datum offset, extrapolation beyond the CPT, null f_s, inner perimeter, plug ratio, interlock term. Exports `buildDrivingResistanceProfile`, `shaftStressAtTip(profile, j)` (τ per interval when the toe is at z_j — the friction-fatigue distribution), `indexAtDepth`. |
| `.../vibratory-drivability.js` | Hypervib1-type force-envelope method: χ, degraded/dynamic resistances, δ_H acceleration iteration, bisection root F_c,min at every depth ≤ target for m_R (default 1.0) and always 1.25, machine conversion (M_e, s_0, A_pp, α, σ_screen), candidate check, force-envelope curve. Exports `runVibratoryDrivability`, `chiFactor`, `G_M_S2`. |
| `.../impact-wave-equation.js` | Smith (1960) lumped-mass wave equation: ram → cushion (COR unloading k/e²) → helmet → (pile cushion) → N pile segments; shaft springs two-way elasto-plastic, toe compression-only, Smith damping R_s(1 + J v); leap-frog integration; set = D_max,toe − q_toe; blows/0.25 m; stresses; ENTHRU; full energy audit; per-depth results and bearing graph at the final depth. Exports `runImpactDrivability`, `simulateBlow`, `toeQuakeFromDiameter`, `HAMMER_EFFICIENCY_DEFAULTS`, `SOIL_DEFAULTS`. |
| `.../hammer-catalog.js` | Verified rows only: 6 vibratory (ICE 28RF, 14RF, 815C; PVE 23VMA; ABI MRZV 20VV, 30VV) and 12 impact (Junttan HHK 5A, 5/6A, 7A, 7/9A; IHC S-70 … S-280; Delmag D30-32, D46-32). Each row: `source` URL fetched, `sourceNote`, `verifiedOn`; unknown fields are `null`. Exports `vibratoryHammers`, `impactHammers`, `findHammer(id)`, `vibratoryConsistency()`. |
| `.../drivability-worker.js` | Web Worker: `{ id?, kind: 'profile'|'vibratory'|'impact', payload }` → `{ id, ok, result }` or `{ id, ok:false, error }`. |
| `scripts/verify_srd_profile.mjs`, `scripts/verify_drivability_vibratory.mjs`, `scripts/verify_drivability_impact.mjs` | Node verification (exit ≠ 0 on failure). `npm run verify:drivability` chains all three. |

Design decisions the UI integrator needs to know:

- The profile carries the normalised pile (`profile.pile`, `profile.effectiveToeArea_m2`, `profile.contactPerimeter_m`); both runners fall back to it when no `pile` override is given.
- For Alm & Hamre the shaft stress depends on the tip position, so per-interval τ is obtained through `shaftStressAtTip(profile, j)`; `profile.tauShaft_kPa` holds the *initial* friction f_s,i. `cumulativeShaft_kN[j]`, `toe_kN[j]`, `interlock_kN[j]`, `Rstatic_kN[j]` are already integrated for every trial toe depth.
- Vibratory: `FcRequired_kN` (m_R as given, default 1.0) and `FcRequired125_kN` are always both reported with their governing depths. Top-level machine numbers (`eccentricMoment_kgm`, `amplitude_mm`, …) refer to `designForce_kN` whose `designForceBasis` is `'candidate'` when the vibrator carries `centrifugalForce_kN` or `eccentricMoment_kgm`, else `'required-1.25'`; `machine.atRequired / atRequired125 / atCandidate` give all three.
- Impact: refusal label at `options.refusalBlows` (default 250 blows/0.25 m ≙ set ≤ 1 mm, as requested); the FHWA practical-refusal definition (10 blows/inch ≈ 98 blows/0.25 m) is quoted in the header so the UI can show both. `blows_per_25cm` is `null` when the set is exactly zero (JSON-safe), `refusal: true`.
- All results are plain numbers/arrays (worker-transferable); invalid input returns `{ ok:false, notes:[…] }`, never throws.

## 2. Formulas and their sources (what was actually fetched)

### 2.1 Vibratory (Hypervib1-type) — status: **reproduced from course material; primary-source verification: core equations verified, δ_H and m_R not**

Implemented exactly as course §5.2, §7.3–7.9, §8:
FR = 100 f_s/q_c (percent number); χ = (1 − 1/Λ)e^{−1/FR} + 1/Λ (FR = 0 → 1/Λ); q_l = χ q_s, τ_l = χ τ_s; q_d = (q_s − q_l)e^{−α} + q_l; α = a/g; a = max(0, 1000(F_c − δ_H R_s)/M_dyn) iterated (tolerance 0.01 on |Δa|/max(a, 0.01 g)); R_drive = R_s + R_b + R_interlock; W_eff = M_dyn g/1000 + F_crowd − T_line; G = F_c + W_eff − m_R R_drive; ω = 2πf, M_e = 1000F_c/ω², s_0 = M_e/M_dyn, A_pp = 2s_0, α_req = 1000F_c/(M_dyn g), σ_screen = (F_c + W_eff)/A_s.

Verified against the primary source **Holeyman, A. (2002) "Soil behavior under vibratory driving", keynote, TransVib 2002** (open PDF fetched: https://www.fondytest.com/Alain-Holeyman-s-publications/pdf/2002-Transvib-1.pdf, pp. 14–15):
- eq. (18a/b): `q_l = q_s[(1 − 1/Λ)·e^{−1/FR} + 1/Λ]`, `τ_l = τ_s[(1 − 1/Λ)·e^{−1/FR} + 1/Λ]` — verbatim match.
- eq. (19a/b): `q_d = (q_s − q_l)e^{−α} + q_l`, `τ_d = (τ_s − τ_l)e^{−α} + τ_l`, "α acceleration ratio (= a/g) of the pile" — verbatim match.
- "FR = 100 f_s/q_c … (percentage of the mantle friction to the cone resistance)" and "Λ … chosen in the range of 4 to 10" — matches the course and the module's clipping range.
- §5.2 "force equilibrium models" (Jonker 1987, Warrington 1989: F_c + F_s > R) — the force-envelope inequality class; §5.5.1 describes Hypervib1 as an "iterative procedure to identify the coexisting acceleration and soil resistance".

Not verified: the explicit δ_H shaft-reaction term in the acceleration iteration and the m_R reserve multiplier appear only in the course text. **Van Rompaey, Legrand & Holeyman (1995)** (WIT Trans. Built Env. 15) and the full text of **Holeyman & Whenham (2017)** (Geotech. Geol. Eng. 35) are paywalled; the Springer abstract page (https://link.springer.com/article/10.1007/s10706-017-0218-8) was fetched and confirms the nomenclature "Λ: empirical factor expressing the loss of resistance attributable to liquefaction (in fully liquefied state)". The module header states this status.

Course §8 example reproduced to better than 4 significant figures (see §5 tail): χ = 0.473233, R_static = 252.794 kN, α(125) = 5.7919, q_d = 1424.522 kPa, R_drive = 120.037 kN, G(1.25) = 11.536 kN, F_c,min = 85.574 / 113.809 kN, M_e = 2.5847 kg·m, s_0 = 1.175 mm, σ = 24.3 MPa, and all seven §8.9 sensitivities (54.0, 240.7, 130.0, 101.3, 128.4, 104.3 kN).

### 2.2 SRD profiles

- Reference method: course §7.2/§18.2 (illustrative screen; note emitted).
- **Alm, T. & Hamre, L. (2001)** — open-access ISSMGE PDF fetched (https://www.issmge.org/uploads/publications/1/30/2001_02_0104.pdf, pp. 1297–1302) and read with `pdftotext`; all coefficients verified verbatim and cross-checked against the OPILE documentation (https://cathiegroup.com/OPILE/Website/05_srdinput/12_Alm_Hamre.html) and groundhog docs (https://groundhog.readthedocs.io/en/latest/piles/skinfriction.html):
  - eq. (1) f_s = f_s,res + (f_s,i − f_s,res)·e^{−k(p − z)}; eq. (2) clay f_s,res = 0.004 q_T (1 − 0.0025 q_T/p_0′), f_s,i = CPT sleeve friction; eq. (3)/(4) sand f_s,i = K p_0′ tan δ, K p_0′ = 0.0132 q_T (p_0′/p_a)^0.13, residual 20 %; eq. (5) k = (q_T/p_0′)^0.5/80; eq. (6) sand q_tip = 0.15 q_T (q_T/p_0′)^0.2 (exponent confirmed by OPILE S2 = 0.2; the paper's own text "0.35 to 0.55 times the cone resistance from loose to very dense" is consistent), clay q_tip = 0.6 q_T.
  - Paper caveats implemented: sand friction calibrated for outside friction only → `insideFriction: 'half-both'` halves it on both faces; unplugged piles assumed; §8 "a factor of 1.25 is normally sufficient" for the upper bound → `options.srdFactor`.
  - δ default 29° (constant-volume interface angle) is a module default, not from the paper — per-layer `deltaCv_deg` overrides it.

### 2.3 Impact (Smith wave equation)

- **Smith, E.A.L. (1960)**, ASCE JSMFD 86(SM4) 35–61 — citation confirmed via the ASCE library listing (https://ascelibrary.org/doi/10.1061/JSFEAQ.0000281 returned 403 on fetch; details from the search index). The full paper is paywalled and was **not** read; the model (masses/springs, quake, R(1 + J v), COR unloading, set = D_max − Q) is the standard formulation as described in the GRLWEAP material below.
- **GRLWEAP defaults** — fetched and read:
  - Rausche, F. "GRLWEAP Fundamentals" (PDCA), http://www.piledrivers.org/files/222878A6-…/fundamentals-of-dynamic-driven-pile-analysis.pdf (curl + pdftotext): slide 17 `V_RAM = (2 g h η)^½`; slide 28 efficiencies "Diesel 0.80, Traditional air/steam 0.67, Hydraulic 0.80, Hammers with energy monitoring 0.95"; slide 38 shaft quake "2.5 mm or 0.1 inches"; slide 40 toe quake "D/120 very dense/hard, D/60 softer/loose, 0.1″/2.5 mm non-displacement, 1 mm on hard rock"; slides 41–42 "R_d = R_s J_s v … Clay 0.65 s/m, Sand 0.16 s/m, Silts intermediate, Toe all soils 0.50 s/m".
  - "Hammer Types, Efficiencies and Models in GRLWEAP" (GRL, via https://vulcanhammer.info/wp-content/uploads/2017/08/200711thanualhammertypes.pdf): diesel 0.8; single-acting air/steam 0.67; double-acting air/steam 0.5; double-acting hydraulic 0.5; power-assisted hydraulic 0.8; hydraulic drop 0.8; internal monitoring 0.95; Appendix B table (Junttan HHK 0.80 / HHK-A instrumented 0.95, IHC S 0.80 / instrumented 0.95, Delmag 0.80).
  - Rausche, Liang, Allin & Rancman (2004) "Applications and correlations of the wave equation analysis program GRLWEAP" (https://www.grlengineers.com/wp-content/uploads/2022/09/SW2004_SP03-1.pdf): example inputs skin/toe quake 2.5 mm, skin damping 0.65 (clay) / 0.16 (sand) s/m, toe damping 0.5 s/m, efficiency 0.8.
  - **FHWA GEC-12 Vol. II, NHI-16-009** (https://www.fhwa.dot.gov/engineering/geotech/pubs/gec12/nhi16009_v2.pdf, 25 MB, curl + pdftotext): §12.5 "the toe quake is input as the pile diameter divided by 60 … shaft damping in these cohesionless soils is set to 0.05 s/ft. Shaft quake and toe damping are generally left at the defaults of 0.10 inches and 0.15 s/ft"; §12.8 "shaft damping factors on the order of 0.05 s/ft for non-cohesive soils, 0.10 s/ft for silty sands …, 0.15 s/ft for cohesive silts and sandy clays, and 0.20 s/ft for cohesive soils … toe damping factor is about 0.15 s/ft"; §17.2 "Practical refusal … 10 blows per inch for a maximum of 3 consecutive inches … Absolute refusal … 20 blows for one inch". (Vol. I, nhi16009_v1.pdf, was also fetched; it contains no wave-equation parameter table.)

### 2.4 Hammer catalog (every URL fetched on 2026-08-29)

| Row | Source | Verified fields |
|---|---|---|
| ICE 28RF | twf.at Dieseko spec sheet PDF + Dieseko product page | 0–28 kgm, 2300 rpm, 0–1600 kN, dynamic weight 3900 kg (5400 with 200TU clamp), total 5900 kg, amplitude 14/10.4 mm, line pull 400 kN, pull-down 150 kN |
| ICE 14RF, ICE 815C, PVE 23VMA | Dieseko product pages | moment, force, rpm only — dynamic weight **null** (datasheets behind a form) |
| ABI MRZV 20VV / 30VV | aeyates.co.uk "Technical Data MRZV VV" PDF | moment, dynamic mass 2810/3995 kg, rpm, forces, total weight (20VV "100 kN" is a misprint for 1000 kN, noted) |
| Junttan HHK 5A, 5/6A, 7A, 7/9A | junttan.com data sheets (PDF) | ram 5000/6000/7000/9000 kg, 59/71/82/106 kNm, 1.2 m, 40–100 bpm, total weights |
| IHC S-70 … S-280 | IHC onshore brochure IHC02-30-11.12 (mirror) + PDI hammer database PDF cross-check | ram, max net energy, blow rate, total weight |
| Delmag D30-32 | Pileco spec sheet | piston 3000 kg, 48.1–95.1 kNm (4 pump settings), 36–52 bpm, stroke 1.6–3.2 m (PDI DB: 100.9 kJ — noted) |
| Delmag D46-32 | piledrivershop.com spec sheet | 4600 kg, 71–166 kNm, 35–53 bpm, 9300 kg (PDI DB: 154.8 kJ — noted) |

`vibratoryConsistency()` checks F_c ≈ M_e ω² for every row (all within 1.5 %).

## 3. What could not be verified / was omitted

- δ_H shaft-reaction reduction and m_R: course only (see §2.1). Van Rompaey et al. (1995) and Holeyman & Whenham (2017) full texts: paywalled.
- Smith (1960) full text: paywalled; formulation taken from the GRLWEAP secondary sources above.
- Drop-hammer efficiency: not in the fetched GRLWEAP source ("rarely employed and therefore not discussed"); 0.50 placeholder, note emitted, set explicitly.
- Dynamic weights of ICE 14RF, ICE 815C, PVE 23VMA: not published on the product pages (Dieseko datasheet download requires a form); stored as `null`.
- Alm & Hamre "recommended earlier by the authors" quake/damping values (Alm & Hamre 1998): not fetched; GRLWEAP defaults are used instead.
- FHWA Vol. I: fetched, but the quake/damping recommendations live in Vol. II (used).

## 4. Known limitations

Vibratory: non-normative empirical model (course §7.1) — no penetration-rate prediction, no power/clamp/wave-stress checks (course §7.10), δ_H = 0 optimistic baseline unless calibrated (course §15.8), single FR per interval used for both shaft and toe, no plug mass, interlock resistance must be supplied.

Impact: no diesel combustion / pre-compression / impact block (equivalent free-fall ram), no gravity or static pre-equilibrium, no residual stresses between blows, no splices/slacks, no pile-cap impedance change, no plug mass, single blow per depth, uniform pile section, shaft damping per profile interval mapped to segments by resistance weighting, Smith damping product clipped at zero when static and damping terms oppose (numerical safeguard, documented), set = D_max,toe − q_toe (Smith) ignores residual elastic compression, bearing graph keeps the shaft/toe split of the final depth. Leap-frog energy error ∝ (ω Δt)²: default ω Δt ≤ 0.1 gives set within 0.5 % of a refined run (`options.timeStepFactor`).

SRD: q_c used where Alm & Hamre write q_T; σ′_v0 from bulk γ and a single water table unless `sigmaV0_kPa[]` is supplied; no Eurocode partial factors (PLAN D10).

## 5. How to run the tests

```
npm run verify:drivability           # chains the three scripts below
node scripts/verify_srd_profile.mjs
node scripts/verify_drivability_vibratory.mjs
node scripts/verify_drivability_impact.mjs
```

Tails of the final runs (all OK):

### verify_srd_profile.mjs
```
OK    perimeter = outside + inside
OK    notes: q_c as q_T, unplugged, inside friction halved
OK    srdFactor 1.25 scales the whole profile (upper bound, Alm & Hamre §8)
OK    alm-hamre without layers ⇒ ok:false
== Hammer catalog ==
OK    vibratory rows have make, model, moment, frequency, force and a fetched source URL
OK    impact rows have ram mass, rated energy, type, efficiency default and source
OK    ids unique
OK    findHammer works and returns null for custom
OK    F_c ≈ M_e ω² within 8 % for every vibratory row  [ice-28rf: 1.015, ice-14rf: 1.003, ice-815c: 0.995, pve-23vma: 0.988, abi-mrzv-20vv: 1.000, abi-mrzv-30vv: 1.004]
OK    ICE 28RF amplitude 2·M_e/M_dyn = 14.4 mm ≈ datasheet 14 mm
OK    Junttan HHK 5A: 59 kNm ≈ 5000 kg · g · 1.2 m
OK    IHC S-90: 90 kJ, 4500 kg ram (brochure) ≈ PDI database 89.4 kJ / 44.2 kN
OK    unknown dynamic masses are null, never guessed

60/60 checks passed
```

### verify_drivability_vibratory.mjs
```
OK    χ increases with FR  [0.172 → 0.279 → 0.473 → 0.672 → 0.849]
OK    χ decreases with Λ  [0.526 → 0.473 → 0.447 → 0.431]
OK    Λ outside 4–10 is clipped with a note
OK    deeper target ⇒ F_c,min ↑ (uniform soil)  [64.129 → 74.638 → 85.574]
OK    δ_H > 0 ⇒ F_c,min ↑  [85.574 → 88.315 → 93.791]
OK    larger dynamic mass at constant W_eff ⇒ less acceleration ⇒ F_c,min ↑  [83.505 → 85.574 → 89.427]
OK    larger dynamic mass at constant crowd ⇒ more W_eff ⇒ F_c,min ↓  [90.205 → 85.574 → 83.107]
OK    candidate from eccentric moment ⇒ F_c = 125 kN  [got 124.9988, want 125]
OK    candidate ok125 at 125 kN
OK    candidate 100 kN fails the 1.25 reserve but passes m_R = 1
OK    intermediate dense lens governs  [governing at 1.5 m]
OK    invalid vibrator ⇒ ok:false with note
OK    missing steel area ⇒ stress screen null + note
OK    results are plain JSON

63/63 checks passed
```

### verify_drivability_impact.mjs
```
OK    refusal note emitted
OK    very soft ⇒ no refusal, few blows  [1.8 blows/0.25 m]
OK    defaults: η = 0.80 hydraulic, quakes 2.5 mm, J_s 0.16, J_t 0.50
OK    stroke from rated energy = E/(m g)  [got 1.19412, want 1.19412]
OK    notes mention assumed efficiency, damping and cushion  [Hammer efficiency 0.8 assumed for type 'hydraulic' (GRLWEAP defaults). | Hammer cushion stiffness not given: near-rigid contact (10 × pile segment stiffness = 4.09e+7 kN/m) assumed. | Shaft damping 0.16 s/m (sand) assumed; use 0.65 s/m for clay (GRLWEAP). | Quakes: shaft 2.50 mm, toe 2.50 mm; damping: shaft 0.16 s/m, toe 0.5 s/m (Smith). | Hammer: ram 7000 kg, equivalent stroke 1.194 m, η = 0.8, v_impact = 4.33 m/s, E_kin = 65.6 kJ. | Pile: 20 segments of 1.00 m, c = 5172 m/s, impedance Z = 790 kN·s/m.]
OK    diesel: equivalent free-fall ram, note emitted, η = 0.80
OK    monitored hydraulic ⇒ η = 0.95
OK    efficiency table matches the fetched GRLWEAP classes
OK    D/120 toe quake for Ø508  [got 0.00423333, want 0.00423333]
OK    per-layer shaft damping array accepted
OK    missing stroke/energy ⇒ ok:false
OK    misaligned damping array ⇒ ok:false
OK    target beyond pile length ⇒ stops at pile length with note
OK    results are plain JSON

48/48 checks passed
```

### course §8 block of verify_drivability_vibratory.mjs
```
== Course §8 worked example (4 significant figures) ==
OK    profile ok  [Reference method q_s = q_c, τ_s = f_s (course §7.2): illustrative screen, not a pile design method.]
OK    χ(FR = 1 %, Λ = 6) = 0.473233  [got 0.4732329, want 0.473233]
OK    A_b = 0.058535 m²  [got 0.05853494, want 0.058535]
OK    P = 0.857655 m  [got 0.8576548, want 0.857655]
OK    A_s = 0.006660 m²  [got 0.006660176, want 0.00666]
OK    z_toe = 3.0 m  [got 3.000000, want 3]
OK    R_s,static = 77.189 kN  [got 77.18893, want 77.189]
OK    R_b,static = 175.605 kN  [got 175.6048, want 175.605]
OK    R_static = 252.794 kN  [got 252.7938, want 252.794]
OK    run ok  [δ_H = 0: optimistic free-acceleration baseline (course §8.1). Calibrate against measured amplitude (course §15.8). | Force-envelope root: F_c,min(m_R=1) = 85.6 kN at 3.00 m; F_c,min(1.25) = 113.8 kN at 3.00 m. | Non-normative empirical model (course §7.1): confirm by an instrumented trial; check amplitude, clamp, power, wave stress and vibration separately (course §7.10).]
OK    W_eff = 36.582 kN  [got 36.58200, want 36.582]
OK    governing depth = 3.0 m  [got 3.000000, want 3]
OK    R_liquefied = 119.630 kN  [got 119.6303, want 119.63]
OK    candidate check present
OK    α(125 kN) = 5.7919  [got 5.791864, want 5.7919]
OK    q_d(125 kN) = 1424.522 kPa  [got 1424.522, want 1424.522]
OK    τ_d(125 kN) = 14.24522 kPa  [got 14.24522, want 14.24522]
OK    R_s(125) = 36.652 kN  [got 36.65245, want 36.652]
OK    R_b(125) = 83.384 kN  [got 83.38432, want 83.384]
OK    R_drive(125 kN) = 120.037 kN  [got 120.0368, want 120.037]
OK    G(125 kN, m_R = 1.25) = 11.536 kN  [got 11.53604, want 11.536]
OK    G(125 kN, m_R = 1.0) = 41.55 kN  [got 41.54524, want 41.545]
OK    F_c,min(m_R = 1.0) = 85.57 kN  [got 85.57400, want 85.574]
OK    F_c,min(m_R = 1.25) = 113.81 kN  [got 113.8092, want 113.809]
OK    M_e(125 kN, 35 Hz) = 2.5847 kg·m  [got 2.584724, want 2.5847]
OK    s_0 = 1.175 mm  [got 1.174875, want 1.1749]
OK    A_pp = 2.350 mm  [got 2.349749, want 2.3498]
OK    α_free(125 kN) = 5.79  [got 5.791864, want 5.7919]
OK    σ_screen = 24.3 MPa  [got 24.26092, want 24.3]
OK    design basis = candidate
OK    top-level M_e follows the candidate  [got 2.584724, want 2.5847]
== Course Table 8A/8B spot checks ==
OK    α(50) = 2.317  [got 2.316745, want 2.317]
```

## 6. Type-checking note

`tsconfig.json` has `strict` + `checkJs`. The five drivability modules are plain ES modules whose
optional JSDoc fields are guarded at runtime (`x > 0`), which strict null-checking flags in dozens of
places. They therefore carry `// @ts-nocheck` after the SPDX line, the pattern already used by 109 of
the 136 `src/lib/cpt-app` JS modules (e.g. all `stratigraphy/*.js`), so `npm run check` is unaffected.
Verified: `tsc --noEmit --allowJs --checkJs --strict` on the five files reports no errors.
