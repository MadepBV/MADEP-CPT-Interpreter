# Audit — Pile design (axial capacity, settlement) & canvas
**Subsystem key:** piles
**Files reviewed:** src/lib/cpt-app/stage6-pile.js, src/lib/cpt-app/stage6-pile-canvas.js, src/routes/docs/engineering/pile/+page.svelte, scripts/validate-pile.js, docs/logic.md, src/lib/cpt-app/stage6-engineering.js (helpers), src/lib/cpt-app/legacy-controller.js (integration/UI)
**Finding counts:** critical=0 high=2 medium=4 low=5 info=4  |  A=4 B=1 C=5 D=5  |  total=15

## Overview
The pile subsystem is in good health and notably more correct than the "common implementation error" warning anticipated. The De Beer four-stage transformation has the **correct sweep asymmetry** (downward sweep limits the rate of q_b increase into a stiffer layer; upward sweep reduces q_b approaching weaker soil below); I verified this directionally with synthetic transitions. The factor chain (α_b, α_s, γ_Rd, ξ_3/ξ_4, γ_b, γ_s, e_b, β, λ), geometry formulas, η*_p table and the load-transfer settlement march all reproduce their documented values and pass the in-repo validation script. The most material defects are: a unit-scale bug in the `M_s` override (1000× off vs the table path and the UI's own "×10⁻³" label), and an undocumented, non-conservative `0.7·Fcd` heuristic in the downdrag ULS combination that disagrees with the doc's stated `Fcd + Fnk,d`. Two documentation claims describe capabilities the code does not have (a per-layer η*_p override; a BGGG "within 5%" verification not reproduced in any test). The De Beer Stage-2/3 "fraction-of-the-gap" form is a screening simplification of the true BGGG gradient limit and is openly documented as such.

## Findings

### [PILES-A-01] high · `M_s` override is applied without the ×10⁻³ scale the table path uses
- **Location:** `src/lib/cpt-app/stage6-pile.js:647-652` (`buildShaftSprings`); UI label `src/lib/cpt-app/legacy-controller.js:13454`
- **Category:** A — Implementation (unit / scale inconsistency)
- **Confidence:** confirmed
- **Analysis:** The table path scales the tabulated M_s by 1e-3:
  ```js
  const Ms = Number.isFinite(msOverride) && msOverride > 0
    ? msOverride                                  // override: NO ×1e-3
    : (msTable[group] || msTable.mixed) * 1e-3;   // table: ×1e-3
  ```
  `MS_TABLE_E3` stores values like `sand: 21`, `clay: 3.5`, which become `0.021`, `0.0035` after `* 1e-3` (the dimensionless M_s the doc §9 uses). The UI field is labelled `M_s override (×10⁻³, blank = table)` with `step:0.5` — i.e., the user is expected to enter on the *same numeric scale as the table* (e.g. `21`, `9`, `4.5`). But the override branch uses the raw entered number, so entering `21` yields `Ms = 21` instead of `0.021` — a **1000× error**. Downstream: `tMax = t10·(1 + 10·Ms)` becomes `t10·211` (≈200× too large) and `ks = tMax/(Ms·Ds)`. The result is a grossly wrong t-z spring and SLS settlement whenever the override is used. The doc §9 formula `t_max,i = t_10%,i·(1 + 10 M_s,i)` only makes physical sense with the small dimensionless M_s (~0.003–0.02), confirming the table scale is the intended one.
- **Recommendation:** Apply the same `* 1e-3` to the override path (`Ms = msOverride * 1e-3`), or change the UI label/placeholder to state the override is the raw dimensionless M_s (and then divide the table by 1e-3 consistently). Add a validation case with an explicit `MsOverride` to lock the scale.

### [PILES-A-02] high · Downdrag ULS uses an undocumented `0.7·Fcd` fallback that can drop F_nk from the demand
- **Location:** `src/lib/cpt-app/stage6-pile.js:933-938`
- **Category:** A — Implementation (governing-equation / conservatism) — also a doc discrepancy, see PILES-C-01
- **Confidence:** confirmed
- **Analysis:**
  ```js
  const downdragCombination = Number.isFinite(GkPerPile) && GkPerPile > 0
    ? (1.35 * GkPerPile + F_nk_design)
    : (FcdInput * 0.7 + F_nk_design); // 0.7 ≈ G/F_total share; conservative fallback
  const ulsLoad = Math.max(FcdInput, downdragCombination);
  ```
  When `GkPerPile` is blank (the common case — the controller defaults it to `null`, `legacy-controller.js:4119`), the downdrag combination is `0.7·Fcd + F_nk,d`. The comment calls this "conservative", but it is the opposite: it discards 30 % of `Fcd` from the permanent-plus-downdrag combination. I reproduced this: with `Fcd = 1000`, `F_nk,d = 384`, the code reports `ulsLoad = 1084` (util 0.280), whereas the doc's stated check `Fcd + F_nk,d` gives `1384` (util 0.358). When `F_nk,d < 0.3·Fcd`, `0.7·Fcd + F_nk,d < Fcd`, so `ulsLoad = Fcd` and **the negative skin friction is omitted from the reported utilisation entirely**, despite downdrag being selected. EC7/[3] do allow excluding transient loads from the downdrag combination, but `0.7·Fcd` is an arbitrary undocumented guess at the permanent fraction, not a standard rule.
- **Recommendation:** Require an explicit `Gk`/`Qk` (or `GkPerPile`) split when downdrag is active and form the proper EC7 combination `1.35·Gk(+1.5·ψ·Qk) + F_nk,d`; or, if a fallback must exist, default the permanent fraction to 1.0 (use full `Fcd`) so the screen is conservative. Note `QLeadPerPile`/`QOtherPerPile` are already stored in config (`legacy-controller.js:4120-4121`) but never read by `analyzePile` — wire them in.

### [PILES-A-03] medium · `Silty sand` (and any "silt"-named sand) classifies as `loam`, raising q_s non-conservatively
- **Location:** `src/lib/cpt-app/stage6-pile.js:151-157` (`mapLayerToBelgianCategory`); Stage-3 type strings at `legacy-controller.js:924-930`
- **Category:** A — Implementation (category routing)
- **Confidence:** confirmed
- **Analysis:** The classifier tests `type.includes('silt')` → `loam` **before** `type.includes('sand')` → `sand`. The Stage-3 catalogue uses the literal type `'Silty sand'` (`legacy-controller.js:928`), so a silty-sand layer is routed to `loam` (η*_p = 1/60) instead of `sand` (1/90) or `sandy_clay` (1/80). I confirmed: `mapLayerToBelgianCategory({type:'Silty sand'}) → 'loam'`. For a silty sand at q_c = 5 MPa this gives q_s = 1/60·5·1000 = 83 kPa vs sand's 56 kPa — i.e. the misroute *increases* shaft friction (less conservative on R_s) and changes the base category at the toe and the M_s/M_b spring group. The doc §6 lists a genuine "loam / silt" category so silt→loam is defensible for pure silt, but the predominant grain (sand) should win for "silty sand".
- **Recommendation:** Reorder so the dominant noun governs (test `sand`/`clay` before the `silt`→`loam` heuristic, or special-case `'silty sand'`/`'clayey sand'` → `sandy_clay`/`sand`). Since the promised per-layer override does not actually exist (PILES-C-02), this misroute is currently unfixable by the user.

### [PILES-A-04] low · `xiLookup` silently defaults an unknown `cptDensity` to the densest (least safe) column
- **Location:** `src/lib/cpt-app/stage6-pile.js:594-604`
- **Category:** A — Implementation (defensive default)
- **Confidence:** confirmed
- **Analysis:** `const colIdx = Math.max(0, XI_DENSITIES.indexOf(cptDensity));` — for an unrecognised density `indexOf` returns −1 and `Math.max(0, −1)` selects column 0 = `1/10m²`, which has the **lowest** ξ values (least conservative). Likewise `nPiles` falls back to `'1-3'`. Inside `analyzePile` this is harmless because `normalizeCfg` (`stage6-pile.js:1076`) coerces an invalid density to `'1/100m2'` first, but `xiLookup` is an exported function (used by `validate-pile.js`) and any direct caller with a typo'd density gets the unsafe column with no warning.
- **Recommendation:** When `indexOf` returns −1, default to the most conservative column (largest area / highest ξ) or throw, rather than column 0.

### [PILES-B-01] low · Live drag recomputes the full `analyzePile` (incl. De Beer + bisection settlement) on every pointermove
- **Location:** `src/lib/cpt-app/legacy-controller.js:13669-13675` (drag redraw), calling `analyzePile` (`stage6-pile.js:816`) which runs `resampleQc`, `deBeerProfile`, and `solveLoadTransfer` (up to 80 bisection iterations × full FD march)
- **Category:** B — Performance
- **Confidence:** likely
- **Analysis:** The comment at `legacy-controller.js:13669` acknowledges "analyzePile is fast (~ms-range) … doing it at 60 Hz". For each drag frame the pipeline re-resamples the raw CPT into 0.20 m bins (allocating fresh `Float64Array`/`Int32Array` and arrays of `{z,q}` objects across five stages in `deBeerProfile`), then runs the settlement bisection (each `solveLoadTransferOnce` allocates a `trace` array of length ~L/Δz and pushes to it). On a long pile with a deep CPT this is non-trivial per-frame garbage and O(n) De Beer work that does not change while only `zToe`/`Ds` move within the same bin grid. The geometry-only handles (`shaftL/R`, `baseL/R`) do not change the resampled q_c at all, yet still trigger the full De Beer recompute.
- **Recommendation:** Memoise `resampleQc`+`deBeerProfile` keyed on `(cptRaw identity, mechanicalCone, coneType, D_b_eq)` and only re-run when those change; reuse a single `trace` buffer in `solveLoadTransferOnce`. During an active drag, optionally skip the settlement bisection (only recompute on `commitChange`).

### [PILES-C-01] medium · Doc states the ULS check is `Fcd + Fnk,d`; code reports `max(Fcd, 0.7·Fcd + Fnk,d)`
- **Location:** Doc `src/routes/docs/engineering/pile/+page.svelte:350-354`; code `src/lib/cpt-app/stage6-pile.js:930-938`
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) The doc equation reads `F_c,d + F_nk,d ≤ R_c,d`. (2) The code computes `ulsLoad = max(Fcd, 0.7·Fcd + Fnk,d)` (or `1.35·Gk + Fnk,d` if `GkPerPile` is supplied). (3) Scientifically, EC7 with [3] permits *not* combining transient loads simultaneously with the long-term downdrag, so the "worse-of-two-combinations" intent (which the doc prose at lines 351-354 actually describes) is correct — but the headline equation `Fcd + Fnk,d` is not what the code does, and the `0.7` permanent-fraction heuristic appears in neither the doc nor the standard and is non-conservative (see PILES-A-02). (4) Fix direction: fix BOTH — make the doc equation match the two-combination logic explicitly, and fix the code's fallback to be conservative or to use a real Gk/Qk split.

### [PILES-C-02] medium · Doc claims a per-layer η*_p / category override that does not exist in the code
- **Location:** Doc `src/routes/docs/engineering/pile/+page.svelte:302-303` and `:497-499` ("The UI exposes a per-layer override"); no such field in `legacy-controller.js` or `stage6-pile.js`
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) The doc says twice that the η*_p mapping is approximate and "The UI exposes a per-layer override," and the canvas section (`:497-499`) implies per-layer category control. (2) I grepped the controller and pile module for any per-layer category/η*_p override (`categoryOverride`, `belgianCategory`, per-layer setField, popover category actions) and found none — the only per-layer interaction is the toe-snap popover (top/mid/bot). The category is derived solely from `mapLayerToBelgianCategory` with no user escape hatch. (3) The doc is wrong (overstates capability); the code is the source of truth. This matters because the only documented mitigation for the `Silty sand→loam` misroute (PILES-A-03) is the non-existent override. (4) Fix direction: either implement the per-layer override, or remove the two doc claims.

### [PILES-C-03] medium · Doc asserts De Beer verified "within 5%" of BGGG worked examples; no such test exists in the repo
- **Location:** Doc `src/routes/docs/engineering/pile/+page.svelte:214-221`; validation `scripts/validate-pile.js:252-301` (Case 4)
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) The doc callout states "The implementation is verified against the BGGG worked examples to within 5 % relative error on q_b." (2) `validate-pile.js` contains no BGGG benchmark — Case 1/2 are self-consistent hand-calcs against the same factor tables (the file's own header says "These are NOT third-party benchmarks"), and Case 4 only checks a qualitative 5–25 % reduction *band*, not a numeric BGGG value. The Stage-2/3 transform is moreover a "fraction-of-the-gap" screening simplification (doc lines 214-221), not the true BGGG gradient limit, so a tight 5 % match to BGGG examples is implausible without the real algorithm. (3) The doc claim is unsubstantiated by the codebase. (4) Fix direction: add an actual BGGG worked-example regression test, or soften the doc to "qualitatively consistent / not benchmarked against BGGG."

### [PILES-C-04] low · Doc cites mechanical-cone ω for M1/M2/M4 only; code's `coneType` set and table omit any M3/electric entry
- **Location:** Doc `src/routes/docs/engineering/pile/+page.svelte:222-225`; code `OMEGA_TABLE` `stage6-pile.js:107-111`, `normalizeCfg` `:1077`
- **Category:** C — Doc vs code (minor)
- **Confidence:** confirmed
- **Analysis:** Doc says "ω = 1.30 for M1 and M2 in tertiary clay, 1.15 for M4, 1.00 elsewhere; default cone is CPT-E (electric, ω = 1.00)." The code matches the M1/M2/M4 values, and "electric" is represented by `mechanicalCone=false` (returns raw q_c) rather than a `coneType` of its own. This is internally consistent but the mapping "electric = the toggle, not a cone type" is implicit; `applyMechanicalCone` falls back to `OMEGA_TABLE.M1` for any unknown `coneType` (`:297`), so a stray cone type silently gets the strongest reduction. Low impact because `normalizeCfg` constrains `coneType` to M1/M2/M4.
- **Recommendation:** State in the doc that electric (ω=1) corresponds to leaving the mechanical-cone toggle off; consider a defined `'E'` cone type returning ω=1 to avoid the M1 fallback for unknown values.

### [PILES-C-05] low · Doc lists `A_p ≠ A_b` for open tubes/steel, but `analyzePile` never receives shape `tube`/`steel-section` and `A_p` defaults to the solid section
- **Location:** Doc `src/routes/docs/engineering/pile/+page.svelte:163-166`; code `pileGeometry` `stage6-pile.js:239-245`
- **Category:** C — Doc vs code (scope)
- **Confidence:** likely
- **Analysis:** The doc notation says A_p (axial-stiffness section) differs from A_b for open tubes and steel sections, and `pileGeometry` does honour an explicit `cfg.Ap`. But the supported `shape` set is only `circular`/`square`/`rectangular` (`normalizeCfg:1073`), and no UI path supplies `Ap` (grep shows no `pile.Ap` field). So in practice A_p always equals the solid concrete section. The doc's open-tube/steel A_p distinction is aspirational; the §3 notes already say open tubes/steel are out of scope, so this is a mild internal inconsistency rather than a wrong result.
- **Recommendation:** Note that A_p override is API-only / not surfaced, or remove the open-tube A_p language from the in-scope notation block.

### [PILES-D-01] low · Dead local constant `GAMMA_W = 9.81` in stage6-pile.js
- **Location:** `src/lib/cpt-app/stage6-pile.js:21`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `GAMMA_W` is declared and never referenced anywhere in the module (effective-stress comes from the imported `effectiveVerticalStressAtDepth`, which carries its own default γ_w). Flagging only — note that if it were ever used it would correctly be 9.81, matching the engineering helper.
- **Recommendation:** Remove, or wire it through to the imported helper for a single source of truth.

### [PILES-D-02] low · Dead function `svgSubInline` in the canvas module
- **Location:** `src/lib/cpt-app/stage6-pile-canvas.js:840-842`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `svgSubInline(main, sub, tail)` is defined with a descriptive comment but is referenced nowhere (only `svgSub` is used, 5 call sites). Grep across `src` finds it only at its own definition.
- **Recommendation:** Remove.

### [PILES-D-03] low · Dead local `xHalf` in `buildPileSectionMarkup`
- **Location:** `src/lib/cpt-app/stage6-pile-canvas.js:155-156`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `const xHalf = Math.max(2.0, xWidth * 1.5);` is computed in `buildPileSectionMarkup` but never read; the markup uses `xWidth` directly. (The separate `xHalf` inside `computeWorldBox:602` *is* used and is fine.)
- **Recommendation:** Remove the unused local.

### [PILES-D-04] info · Stored-but-unread config fields `QLeadPerPile` / `QOtherPerPile`
- **Location:** `src/lib/cpt-app/legacy-controller.js:4120-4121,13276`; never read in `stage6-pile.js`
- **Category:** D — Dead code (config) — couples to PILES-A-02
- **Confidence:** confirmed
- **Analysis:** Both fields are initialised, normalised (coerced to numbers), and persisted in the saved config (`legacy-controller.js:18072` clones the pile config), but `analyzePile` only ever reads `Fcd` and `GkPerPile`. The transient/variable load split is collected from the user and silently ignored, which is also why the downdrag combination cannot form a proper `1.35Gk + 1.5Qk`.
- **Recommendation:** Either consume them in the ULS combination (preferred, see PILES-A-02) or remove the inputs to avoid implying they affect the result.

### [PILES-D-05] info · De Beer Stage-1 identity and "fraction-of-the-gap" Stages 2/3 are superseded-by-screening simplifications (documented)
- **Location:** `src/lib/cpt-app/stage6-pile.js:375-433`; doc callouts `+page.svelte:206-221`
- **Category:** D — Dead code / simplified-path (flag only)
- **Confidence:** confirmed
- **Analysis:** Stage 1 is `q_h = q_c` (identity) and the gradient limit in Stages 2/3 is a proportional approach (`q_d += ratio·(q_h − q_d)`, `ratio = D_c/D_b,eq`) rather than the additive bounded gradient of the true BGGG procedure. This is **not a bug** — the sweep asymmetry is directionally correct and the simplification is explicitly disclosed in two doc callouts and the runtime notes. I flag it so a future pass knows the "real" BGGG homogeneous conversion and gradient limit are intentionally absent, and any claim of BGGG-grade accuracy (PILES-C-03) should be treated skeptically.
- **Recommendation:** No action beyond resolving PILES-C-03; keep the simplification clearly fenced behind the screening disclaimers.

### [PILES-D-06] info · Canvas shaft/base drag handles write only `Ds`/`Db`, ignored for `square`/`rectangular` geometry
- **Location:** `src/lib/cpt-app/stage6-pile-canvas.js:763-774`; geometry uses `a`/`b` for non-circular (`stage6-pile.js:224-244`)
- **Category:** D — Dead code path / inert control (flag only)
- **Confidence:** likely
- **Analysis:** Dragging `shaftL/R` or `baseL/R` calls `setField('pile.Ds'/'pile.Db')`. For circular piles this is correct. For square/rectangular piles `pileGeometry` derives `A_b`, `χ_s`, `D_b,eq` from `cfg.a`/`cfg.b` (falling back to `Ds` only when `a` is absent), so once `a`/`b` are explicitly set the width handles update an unused field and the rendered/computed pile does not respond. The display-width helpers (`pileSectionDisplayWidth`) also read `a`/`b` for non-circular, so the visual width won't track the drag either. Low impact since the default shape is circular.
- **Recommendation:** Branch the width-handle writes on `cfg.shape` to set `a`/`b` for square/rectangular, or hide the width handles for non-circular shapes.

## Notes / limitations of this audit pass
- I could not cross-check the numeric factor tables (α_b/α_s defaults, γ_Rd, ξ_3/ξ_4, ω, M_s/M_b) against the primary sources [3]/[5]/BGGG [4] themselves — those PDFs are not in the repo. The audit confirms the code matches the *in-app doc* and the validation script's reproduction of those tables, and that ξ_3/ξ_4 spot values pass; it does not independently certify the tabulated constants against the cited standards. The α_b/α_s/γ_Rd/γ_b values are openly labelled "screening midpoints" with an ATG override path, so this is by design.
- De Beer correctness was verified directionally (sweep asymmetry, reduction near soft-over-dense and dense-over-soft transitions, full q_c retained deep in a uniform layer) and against the repo's own qualitative band test, not against external BGGG worked examples (see PILES-C-03). A genuine BGGG benchmark would be the highest-value follow-up.
- The settlement load-transfer march was checked for physical consistency (w decreasing toe→head, N decreasing head→toe, convergence of the outer bisection) but not against an independent t-z reference solution; the hyperbolic spring calibration constants from [5] were taken as given.
- The `M_s` override unit bug (PILES-A-01) and the `0.7·Fcd` downdrag fallback (PILES-A-02) were both reproduced numerically in this session and are confirmed.
