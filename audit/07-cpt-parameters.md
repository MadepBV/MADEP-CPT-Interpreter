# Audit — Geotechnical parameter derivation & PLAXIS export
**Subsystem key:** cpt-parameters
**Files reviewed:** src/lib/cpt-app/legacy-controller.js (parameter-derivation + export sections: 915–1119, 2017–2033, 2735–2934, 3283–3478, 3592–3760, 4464–4486, 17205–17390), docs/logic.md, docs/plaxis/plaxis_matdb_export.md, docs/classification/nen6740.md
**Finding counts:** critical=0 high=1 medium=5 low=4 info=1  |  A=0 B=1 C=7 D=2  |  total=11

## Overview
The parameter-derivation core (Sanglerat/SB260 α, CUR 2003-7 stiffness ratios, Jaky K0, cohesion-corrected reference-stress mapping, OLS m-fitting, OVAM/De-Smedt permeability, PLAXIS MC/HS `soilmat` command export) is numerically sound and internally self-consistent: units (MPa→kPa for E, m/s→m/day for k, kN/m³, degrees for φ/ψ, pref=100 kPa) are handled correctly and the two stiffness code paths (`hsParams` and `fitLayer`) agree with each other. No critical or confirmed implementation (A-category) defect was found in this subsystem. The weaknesses are almost entirely **doc-vs-code drift** (dimension C): several documented values (the m-by-type table, the m-fit clamp, the default method, the Sandy-clay 1.25 rule, peat ψ_unsat) disagree with the code, and in most cases the code is the scientifically defensible side while the doc is stale. Parameters here are table-driven from NEN/EC7 Tabel 3 (no Nkt→su or OCR/POP derivation exists in this subsystem, so those topics are out of scope by construction).

## Findings

### [CPT-PARAMETERS-B-01] high · `fitLayer` rebuilds the in-layer point cloud by full O(rows) scan of `S.classified` per layer, with per-point array allocation
- **Location:** `src/lib/cpt-app/legacy-controller.js:3594` (`S.classified.filter(...)`), `3616-3641` (per-row push), `3592-3710`
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** `fitLayer(l)` calls `S.classified.filter(r => r.z >= l.top && r.z <= l.bot && r.qc > 0.02)` and then loops to build `pts[]`. `runTuning()` (3712) calls `fitLayer` once per layer, so the total cost is O(layers × rows). For typical CPT datasets (a few thousand rows, <20 layers) this is acceptable, so I rate this high only as the single most material performance note in an otherwise allocation-light subsystem — it is not a hot interactive loop. `tuningPreviewEoedRef`/slider repaints reuse the cached `fit` (they do not re-scan), which is good. There is no leak; arrays are GC-eligible after render. The concern is only that a large multi-CPT batch export (`exportPlaxisCommands`/`exportCSV` → `hsParams`/`khParams` per layer, plus a Tuning run) recomputes everything from scratch with no memoization. `hsParams(l)` and `khParams(l)` are also recomputed at every render/export call site (3482, 4466, 17213, 17283, 17481) rather than computed once per layer and cached on the layer object.
- **Recommendation:** Pre-bucket `S.classified` rows by layer once (single O(rows) pass building per-layer index ranges, since rows are depth-sorted) and reuse it across `fitLayer`/render. Optionally memoize `hsParams`/`khParams` per layer keyed by the inputs that affect them (qc, φ, c, γ, method flags, overrides) and invalidate on edit.

### [CPT-PARAMETERS-C-01] medium · Doc §4.3 m-by-type table (Clay 0.85, Sandy clay 0.65) contradicts the binary m the code uses (1.0 / 0.5)
- **Location:** code `src/lib/cpt-app/legacy-controller.js:3437-3439` and `3606-3609`; doc `docs/logic.md:588-597`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) Doc §4.3 table states `Peat 1.00 | Clay/Soft clay 0.85 | Sandy clay 0.65 | Sand/Silty sand/Gravel 0.50`, yet the reference line directly under it (logic.md:597) says “CUR 2003-7. Zand m = 0.5, Klei/leem m = 1.0.” (2) Code uses a strict binary: `m = (cohesive || Sandy clay) ? 1.0 : 0.50` in `hsParams` (3437-3439) and the identical default in `fitLayer` (3606-3609). (3) The CUR 2003-7 convention is the binary one (granular 0.5, cohesive 1.0) — the code and the doc’s own reference line are correct; the 0.85/0.65 table values are unsupported and self-contradict the line below them. (4) Fix the doc: replace the §4.3 table with the binary `1.0 / 0.5` mapping (cohesive incl. leem = 1.0, granular = 0.5) to match `hsParams`.
- **Recommendation:** Correct the logic.md §4.3 table to the binary CUR 2003-7 values actually implemented; do not change the code.

### [CPT-PARAMETERS-C-02] medium · Doc §4.5 claims `m_fit` is clamped to [0.30, 1.20]; code never clamps it
- **Location:** code `src/lib/cpt-app/legacy-controller.js:3661-3666`; doc `docs/logic.md:732`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) Doc §4.5 states `m_fit = cov(X,Y)/var(X)  clamped to [0.30, 1.20]`. (2) Code computes `m_raw = covXY/varX` then `m_fit = +m_raw.toFixed(3)` — there is no clamp anywhere; only soft quality flags are set (`m_fit < 0 || m_fit > 1.5` → warning at 3682, and `invalidSlope = m_fit <= 0` at 3666). The raw fitted slope is what gets stored when the engineer accepts (`acceptFit` 3724 stores `previewM` = `m_fit`). (3) Scientifically, a hard clamp to a physically plausible HS range [≈0.3, ≈1.0] is the safer behaviour, but the experimental tuning workflow deliberately surfaces out-of-range fits via warnings instead of silently clamping. Either side is defensible, but they must agree. The code is the truthful description of behaviour; the doc overstates the safety guard. (4) Fix direction: simplest is to fix the doc (remove the “clamped to [0.30, 1.20]” claim and describe the warning-only behaviour), OR add the clamp to the code if a hard guard is intended. Note the warning band in code is [0,1.5], not [0.30,1.20].
- **Recommendation:** Reconcile: change the doc to describe warning-only behaviour with the actual [0,1.5] band, or implement the documented clamp. Do not leave both inconsistent.

### [CPT-PARAMETERS-C-03] medium · Doc presents Method A as the “current/default” method, but the app defaults to Method B for both α and stiffness
- **Location:** code `src/lib/cpt-app/legacy-controller.js:123-126` (`alphaMethod:'B', stiffMethod:'B'`); doc `docs/logic.md:528,540,586`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) Doc §4.2 labels the fixed-α table “(current implementation)” (logic.md:528) and §4.3 says “This is the currently implemented approach” (586), strongly implying Method A is what a fresh session uses. (2) Code initialises `S.alphaMethod:'B'` and `S.stiffMethod:'B'` (123-124), so by default α is the SB260 qc-dependent rule (`alphaEB`) and stiffness is `E50 = Eoed`. The CSV/PLAXIS export and all per-layer cards therefore use Method B unless the engineer toggles to A. (3) Neither method is “wrong” physically — but the documentation misstates the active default, which is engineering-significant because Method A vs B changes E50,ref (and thus exported PLAXIS stiffness) by up to a factor 1.25 for cohesive soils and changes α materially for granular soils. (4) Fix the doc to state the real defaults (α=B, stiffness=B), or change the defaults if A was intended.
- **Recommendation:** Update logic.md §4.2/§4.3 to state Method B is the shipped default (or change the code defaults). Make the “current implementation” language match `S.alphaMethod`/`S.stiffMethod` init.

### [CPT-PARAMETERS-C-04] medium · MC-export E50,i applies the 1.25 cohesive factor to Sandy clay (leem), but the MC/PLAXIS docs list only Clay/Soft clay/Peat
- **Location:** code `src/lib/cpt-app/legacy-controller.js:3451` (`cohesiveForE50 = cohesive || l.type==='Sandy clay'`), `3459` (E50_i), `3473` (`Emc=E50_i`); doc `docs/logic.md:787-788` and `docs/plaxis/plaxis_matdb_export.md:200-201`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) plaxis_matdb_export.md:200 says “If Method A is active, `E50,i = 1.25·Eoed,i` for Clay / Soft clay / Peat and `E50,i = Eoed,i` for the other soils,” and logic.md §4.6:787 lists the 1.25 factor only for “Clay, Soft clay, Peat / organic.” Both omit Sandy clay (leem). (2) Code computes `cohesiveForE50 = cohesive || l.type==='Sandy clay'` and applies `E50_i = 1.25*Eoed_i` to Sandy clay too; since `Emc = E50_i`, the **exported MC `ERef` for leem layers is 1.25·Eoed,i**, not Eoed,i. (3) This is internally inconsistent within the docs themselves: logic.md §4.3:621 (the HS path) *does* include leem in the cohesive 1.25 set, citing CUR 2003-7 which treats loam as cohesive — so the code (1.25 for leem) is the CUR-consistent choice. The §4.6 and plaxis-export tables are the stale side. (4) Fix the docs (§4.6 and plaxis_matdb_export.md §5) to include Sandy clay/leem in the 1.25 set, matching §4.3 and the code.
- **Recommendation:** Update logic.md §4.6 and plaxis_matdb_export.md §5 to state E50,i = 1.25·Eoed,i for Clay, Soft clay, Peat **and Sandy clay (leem)**; do not change the code.

### [CPT-PARAMETERS-C-05] medium · ψ_unsat for peat/veen is 3.0 m in code but documented as 1.0 m
- **Location:** code `src/lib/cpt-app/legacy-controller.js:3348` (`const psi_unsat = isGranular ? 0.1 : isLeem ? 1.0 : 3.0;`); doc `docs/logic.md:916` and `docs/logic.md:912-917`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) Doc §4.7 lists ψ_unsat = 0.1 (zand) / 1.0 (leem) / 3.0 (klei) / **1.0 (veen — approximation)**. (2) In `khParams`, `isLeem` is true only for `type==='Sandy clay'`; peat (`'Peat / organic'`) is neither granular nor leem, so it falls to the final `: 3.0` branch — peat gets **3.0 m**, not the documented 1.0 m. The code comment above (3345) even says “granular 0.1 m, leem 1.0 m, cohesive 3.0 m,” which silently lumps peat into cohesive. (3) Physically peat has a large suction/capillary zone, so 3.0 m (cohesive grouping) is arguably more realistic than 1.0 m, but this value feeds the CSV `psi_unsat_m` and Plaxis groundwater BC guidance, so the mismatch is engineering-relevant. ψ_unsat is currently **not** written into the PLAXIS command export (confirmed: not in `exportPlaxisCommands` 17291-17323), limiting impact to the CSV/UI. (4) Decide the intended peat value and align: either fix the doc to 3.0 m (cohesive grouping) or add an explicit peat branch returning 1.0 m.
- **Recommendation:** Add an explicit peat branch in `khParams` (or fix logic.md §4.7) so the documented and computed ψ_unsat for veen agree.

### [CPT-PARAMETERS-C-06] low · `kh_rep` is labelled “geometric mean of range” in code/doc but is a hardcoded representative value that is not the geometric mean
- **Location:** code `src/lib/cpt-app/legacy-controller.js:3287` (comment), `3296-3316` (hardcoded values); doc `docs/logic.md:855`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** The `khParams` header comment says “kh_rep = representative (geometric mean)” and logic.md:855 says “kh,rep is the representative (geometric mean of range).” But the values are hand-picked table entries that are not the geometric mean of the stated [min,max]. Example — Clay: min=1e-9, max=1.2e-7 ⇒ geo-mean = √(1e-9·1.2e-7) ≈ 1.1e-8, but code uses kh_rep = 5e-8. Soft clay: √(1e-10·1.2e-7) ≈ 3.5e-9 vs code 2e-8. (Sand-matig and gravel happen to be near the geo-mean, which is why the label looks plausible.) The values themselves are reasonable OVAM/De-Smedt representatives; only the “geometric mean” characterisation is inaccurate. Code values are the intended source-table picks (correct); the descriptive label is wrong.
- **Recommendation:** Change the comment and doc wording from “geometric mean” to “representative value from OVAM/De-Smedt tables (engineer-overridable),” keeping the code values.

### [CPT-PARAMETERS-C-07] low · `psi` (dilatancy) export rounds `phi-30`, which the doc formula `max(0, phi'-30)` does not mention
- **Location:** code `src/lib/cpt-app/legacy-controller.js:3470`; doc `docs/logic.md:793`
- **Category:** C — Doc vs Code
- **Confidence:** likely
- **Analysis:** Doc §4.6 states `psi = max(0, phi' - 30)`. Code is `psi = Math.max(0, l.phi>30 ? Math.round(l.phi-30) : 0)`. Two minor divergences from the literal formula: (a) it rounds the result, and (b) the `phi>30` gate combined with `max(0,...)` is equivalent to the doc for all inputs (at φ=30 both give 0; below 30 both give 0). The rounding is a true behavioural difference for non-integer φ (e.g. φ=33.5 → code ψ=4, doc ψ=3.5). In practice φ comes from the integer EC7/Tabel-3 catalogue (2735–2926) so `phi-30` is already integer and the rounding is a no-op; it only bites if an engineer overrides φ to a non-integer. Code behaviour is acceptable; the doc should mention rounding (or the code should drop it).
- **Recommendation:** Add “rounded to the nearest degree” to the §4.6 ψ formula, or remove `Math.round` from the code for exactness.

### [CPT-PARAMETERS-D-01] low · Unreachable `m_fit < 0` quality-flag branch in `fitLayer`
- **Location:** `src/lib/cpt-app/legacy-controller.js:3666` and `3681-3682`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `invalidSlope = m_fit <= 0` is computed at 3666 and the flag chain at 3681 returns `quality='invalid'` whenever `invalidSlope` is true. The next `else if` at 3682 tests `m_fit < 0 || m_fit > 1.5`; the `m_fit < 0` disjunct can never be reached because any `m_fit < 0` already satisfied `invalidSlope` at 3681 and short-circuited. Only the `m_fit > 1.5` part of 3682 is live. Harmless, but the `m_fit < 0` sub-condition is dead.
- **Recommendation:** (Flag only) Simplify the 3682 condition to `m_fit > 1.5`.

### [CPT-PARAMETERS-D-02] low · `MC_RSHEAR_BY_TYPE` / r_shear plumbed through derivation and CSV but not used by the PLAXIS command export (and r_shear is a screening-only quantity)
- **Location:** `src/lib/cpt-app/legacy-controller.js:990-998` (`MC_RSHEAR_BY_TYPE`), `3466-3468`, `3476`, `4479`, `17220`; export omits it (17291-17323)
- **Category:** D — Dead code (partial / scope)
- **Confidence:** confirmed
- **Analysis:** `rShear` is derived in `hsParams`, surfaced in the CSV (`rShear` column, 17220), and passed to the Stage-6 deformation handoff (4479), but is **not** part of either PLAXIS `soilmat` command (it is not a PLAXIS material key). The doc itself (logic.md:817-820) flags it as “a Stage 1 deformation-screening hack only … not a formal Mohr-Coulomb post-yield modulus.” This is not dead per se (the deformation workspace consumes it), but within the **PLAXIS-export** scope of this subsystem it is inert and could be mistaken for an exported material parameter. Flagging so a future reader does not assume `rShear` reaches PLAXIS.
- **Recommendation:** (Flag only) No action needed for correctness; consider a code comment clarifying `rShear` is screening-only and intentionally never exported to PLAXIS.

### [CPT-PARAMETERS-C-08] info · `stressAt` hardcodes γ_w = 9.81 while Stage-6 uses a configurable `gammaW`; both default to 9.81 so no numerical divergence today
- **Location:** `src/lib/cpt-app/legacy-controller.js:2031` (`u = 9.81*(z-wt)`) vs `5873`, `12862`, `12869` (Stage-6 `stage6Constants().gammaW`, default 9.81)
- **Category:** C — Doc vs Code (consistency)
- **Confidence:** confirmed
- **Analysis:** Parameter-derivation effective stress (`stressAt`, used by `hsParams`/`fitLayer`) uses a literal 9.81 kN/m³ for pore pressure, whereas Stage-6 stability/seepage read a user-configurable `gammaW` that defaults to 9.81. Today these agree, so σ′v0 (and hence Eoed,ref) is consistent with the Stage-6 stress model. If a user ever sets the Stage-6 `gammaW` to 10, the parameter-derivation σ′v0 would silently stay on 9.81, producing a small inconsistency between the exported stiffness reference stress and the Stage-6 analysis. Recording as info because both paths default to 9.81 and the doc (nen6740.md:122-126) only specifies the σ′v0 = max(σv0−u, 1) form, which the code honours.
- **Recommendation:** (Optional) Route `stressAt`’s pore-pressure constant through the same configurable γ_w so parameter derivation and Stage-6 cannot diverge if the constant is changed.

## Notes / limitations of this audit pass
- This subsystem derives parameters from the NEN/EC7 Tabel 3 catalogue (`CAT`, 2735–2926) rather than computing su via Nkt or OCR/POP from CPT; those correlations (mentioned in the brief) are **not present** in `legacy-controller.js`, so the “su (Nkt) / OCR / POP” line items had no code to audit here. I verified the Tabel-3 γ/γ_sat/φ′/c′/cu rows are read straight from the catalogue into layer parameters; I spot-checked the catalogue against logic.md §2.3 but did not exhaustively re-derive every Tabel-3 row against a licensed NEN 6740/Tabel-3 copy (not available), so the numeric catalogue values are taken as the intended source.
- I did not execute the app; all findings are from static reading of the actual code and the three paired docs. The PLAXIS `soilmat` key names (e.g. `EOedRef`, `PermHorizontalPrimary`, `SoilModel` 2/3) were checked for internal consistency and against plaxis_matdb_export.md, but not against a live PLAXIS instance.
- `nen6740.md` describes the *classification chart* route (boundary logic), not parameter derivation; it was reviewed for the σ′v0 floor and provenance only — no parameter-derivation discrepancy is attributable to it.
- I confirmed the OLS m-fit, R², cohesion-corrected reference-stress mapping, Jaky K0, α tables (Method A and B), permeability/anisotropy, ψ, ν, and all unit conversions (MPa↔kPa, m/s↔m/day) are correct; no confirmed A-category numerical bug was found. A second pass with a runnable PLAXIS target and a licensed NEN Tabel-3 reference would let the catalogue values and the `soilmat` key acceptance be verified end-to-end.
