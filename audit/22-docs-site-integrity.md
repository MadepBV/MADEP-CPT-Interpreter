# Audit — In-app docs site (theory/reference/full/workflow) vs implementation
**Subsystem key:** docs-site-integrity
**Files reviewed:** src/routes/docs/+page.svelte, src/routes/docs/theory/+page.svelte, src/routes/docs/reference/+page.svelte, src/routes/docs/full/+page.svelte, src/routes/docs/workflow/+page.svelte, src/routes/docs/engineering/+page.svelte, src/routes/docs/bishop/+page.ts, src/lib/docs/site.ts, src/lib/docs/workflow-content.ts, src/lib/cpt-app/legacy-controller.js, src/lib/cpt-app/nen6740.js, src/lib/cpt-app/stage6-engineering.js, src/lib/cpt-app/stage6-pile.js, src/lib/cpt-app/deformation/material.js, src/lib/cpt-app/deformation/material-models.js, src/lib/cpt-app/seepage/drains.js, src/lib/cpt-app/seepage/solver.js, src/wasm/deformation/material_mc.hpp, src/wasm/deformation/material_hs.hpp, src/wasm/deformation/solver.hpp
**Finding counts:** critical=0 high=0 medium=3 low=4 info=3  |  A=0 B=0 C=4 D=6  |  total=10

## Overview
This documentation subsystem is in unusually good scientific health. I sampled formulas, constants, partial factors and method descriptions across all five public doc routes (workflow / engineering / theory / reference / full) and cross-checked them against the actual JS, WASM-C++ and parameter-table implementations. The published formulas I could verify — Robertson 1990/2016 SBT, NEN 6740 stress correction (0.67) and chart-projection slope (0.34), CUR3 zoning, the full NEN Tabel 3 catalogue, Sanglerat/SB260 α rules, the HS reference-stress correction and m-binary, K0,nc = 1−sinφ′, the plane-strain elastic matrix, the exact Mohr-Coulomb yield/return/tension-cutoff surfaces, the HS stress-dependent stiffness and cap formulas, EC7 bearing factors (Nq, Nc, Nγ = 2(Nq−1)tanφ′, undrained 5.14), pile De Beer/η*p/β_b/t-z/q-z formulas, and the PLAXIS command export — all match the code. The defects found are integrity/maintenance issues, not wrong engineering claims: one broken internal anchor in `site.ts`, one soft mis-statement of a bearing default factor, duplicated section numbering on the theory page, and a large block of doc content in `full/+page.svelte` literally duplicated from `workflow-content.ts`. No Dimension-A or Dimension-B issues were found in the doc-facing code paths reviewed.

## Findings

### [DOCS-SITE-INTEGRITY-C-01] medium · Broken doc anchor: `/docs/theory#parameters` does not exist (target id is `#classification`)
- **Location:** `src/lib/docs/site.ts:131` (page path `'/docs/theory#parameters'`); target page `src/routes/docs/theory/+page.svelte` (ids: `overview, conventions, voigt, classification, seepage, deformation, mc, tension, numerics, references`)
- **Category:** C — Doc vs code (broken internal doc link)
- **Confidence:** confirmed
- **Analysis:** In `docsGroups`, the "Methods and assumptions" group page "CPT-to-parameter derivation" is given `path: '/docs/theory#parameters'`. The theory page has no element with `id="parameters"`; the CPT-derivation material lives under `<section id="classification">` (theory `+page.svelte:218`). I enumerated every `id="…"` on the theory page and every `/docs/theory#…` reference in `site.ts`: `#conventions`, `#deformation`, `#numerics`, `#seepage` all resolve, but `#parameters` is dangling. Currently this entry is rendered only as `<li>{page.title}</li>` text on the docs home page (`docs/+page.svelte:165`), so no user-visible 404 yet — but `page.path` values from `docsGroups` ARE rendered as live `href`s elsewhere (e.g. the reference "Reference map", `reference/+page.svelte:1165`), so this is a latent broken link and an internal inconsistency.
- **Recommendation:** Fix the doc data: change `'/docs/theory#parameters'` to `'/docs/theory#classification'` in `site.ts` (or add an `id="parameters"` anchor to the theory CPT-derivation section). Fix the doc/data, not the code.

### [DOCS-SITE-INTEGRITY-C-02] medium · `full/+page.svelte` duplicates the NEN Tabel 3 catalogue and α-method table verbatim from `workflow-content.ts`
- **Location:** `src/routes/docs/full/+page.svelte:57` (`const nenTable3Rows`), `:91` (`const alphaMethodRows`) vs `src/lib/docs/workflow-content.ts:47` (`export const nenTable3Rows`), `:80` (`export const alphaMethodRows`)
- **Category:** C — Doc vs code consistency (single-source-of-truth violation; risk of future divergence) / overlaps D
- **Confidence:** confirmed
- **Analysis:** `workflow-content.ts` already exports `nenTable3Rows` and `alphaMethodRows`, and the workflow page imports/renders them. `full/+page.svelte` does NOT import these; it redefines its own private inline copies. I diffed the two `nenTable3Rows` arrays (full page lines 58–89 vs workflow-content lines 48–78) — they are byte-identical modulo indentation (32 rows). Both also match the authoritative `CAT` table in `legacy-controller.js:2732–2927` (veen/klei/klei(zh)/leem/leem(zh)/zand/zand(lh)/grind/grind(kh): γ, γsat, φ′, c′, cu, and the qc/Rf bands all agree). Because the published parameter table is duplicated in three places (code `CAT`, `workflow-content.ts`, `full/+page.svelte`) with no shared source, a future edit to one is very likely to leave the others stale — exactly the doc-vs-code drift this audit guards against. The values are currently correct; the risk is structural.
- **Recommendation:** Have `full/+page.svelte` import `nenTable3Rows`/`alphaMethodRows` from `$lib/docs/workflow-content` instead of redefining them, so there is one doc-side source of truth. (Ideally the doc tables would be generated from the code `CAT`/`AE`/`alphaEB` constants, but that is a larger refactor.) Do not delete; flag only.

### [DOCS-SITE-INTEGRITY-C-03] medium · `full/+page.svelte` re-implements the full Stage 0A–6 workflow narrative already provided by `workflow-content.ts` / the workflow page
- **Location:** `src/routes/docs/full/+page.svelte:194` (`const sections: DocSection[]`, ~1600 lines of inline section data) vs `src/lib/docs/workflow-content.ts` (`workflowSections`) rendered by `src/routes/docs/workflow/+page.svelte`
- **Category:** C/D — duplicated published content
- **Confidence:** confirmed
- **Analysis:** The full-spec page hard-codes its own `DocSection[]` covering scope, Stage 1 loading, Stage 2 classification, Stage 3 layering, Stage 4 parameters, Stage 5 m-fitting and global conventions — the same material that `workflow-content.ts` already structures and the workflow page already renders. Spot-checking confirms the prose, equations and reference lists are near-identical (e.g. full `:476` references `'PLAXIS 2D 2018 Reference Manual'`, full `:848` repeats the Stage-4 reference block identical to `workflow-content.ts:846`). The full page additionally carries deformation/HS detail not on the workflow page, so it is not a pure superset duplicate, but a large fraction is redundant copy. This 2816-line page is the primary maintenance hazard for future doc/code drift because none of its content is sourced from the shared module.
- **Recommendation:** Consolidate the overlapping Stage 1–5 narrative so the full page reuses `workflowSections` (or clearly demote the full page to "delta over the per-topic pages"). Flag only — no edits.

### [DOCS-SITE-INTEGRITY-C-04] low · Reference page states `gamma_Rd = 1.40` is applied for drained bearing, but the implemented default γ_Rd is 1.00
- **Location:** `src/routes/docs/reference/+page.svelte:278` (`gamma_Rd … '1.40 for drained shallow-foundation bearing; applied to q_ult to obtain q_d.'`) vs `src/lib/cpt-app/legacy-controller.js:4066` (`gammaRd:1.00`), applied at `:12895` (`qdDrained = qultDrained / factor`, `factor = stage6FactorValue(cfg)` → `cfg.gammaRd`, `:12478`)
- **Category:** C — Doc vs code consistency
- **Confidence:** confirmed
- **Analysis:** The bearing q_d is computed as `q_ult / γ_Rd` where `γ_Rd` is the user-editable `bearing.gammaRd`, whose default in `stage6Defaults()` is **1.00** (`:4066`), with a min of 1.0 in the UI (`:13767`). The value 1.40 in the code is the EC7 DA1/2 undrained material factor `gammaMcu:1.40` (`:12505`) and the global-SF default `xi:2.0` (`:4065`) — neither is "γ_Rd = 1.40 for drained". So the reference registry's statement that a 1.40 drained resistance factor is applied is not what the code does by default; the drained reduction is the configurable γ_Rd (default 1.00) and the soil-side reduction comes through the DA1 material partial factors (γMφ, γMc). Engineering note: applying only γ_Rd = 1.00 to q_ult while the soil strengths are reduced via M1/M2 is a defensible EC7 DA1 reading; the doc text simply over-states a fixed 1.40 drained factor that is not the default.
- **Recommendation:** Fix the doc: describe γ_Rd as the user-set drained resistance factor (default 1.00) and separately note the DA1/2 material factors (γMφ = γMc = 1.25, γMcu = 1.40); do not attribute a hard 1.40 to the drained γ_Rd. Fix doc, not code.

### [DOCS-SITE-INTEGRITY-D-01] low · Theory page has duplicated section numbers (§3, §6 and §7 each appear twice)
- **Location:** `src/routes/docs/theory/+page.svelte` — h2 "3. Voigt-6 …" (`:174`) and h2 "3. CPT-derived classification …" (`:220`); h2 "6. Mohr-Coulomb …" (`:737`) and h2 "6. Declared numerical approximations …" (`:849`); h2 "7. Tension cut-off …" (`:819`) and h2 "7. Principal source families …" (`:866`)
- **Category:** D — duplicated/inconsistent published structure
- **Confidence:** confirmed
- **Analysis:** The visible section numbering on the methods page is internally inconsistent: there are two §3, two §6 and two §7. The nav `id`s are unique and resolve correctly, so navigation works, but a reader citing "Methods §3" or "§7" is ambiguous between the Voigt/CPT and the Tension/References sections. This is a presentation-integrity defect on a page that explicitly markets itself as "auditable" and "consistent".
- **Recommendation:** Renumber the theory page headings monotonically (1→…→10). Doc-only edit.

### [DOCS-SITE-INTEGRITY-D-02] low · Duplicated `nenTable3Rows` data block (cross-reference to C-02)
- **Location:** `src/routes/docs/full/+page.svelte:57–89` and `src/lib/docs/workflow-content.ts:47–78`
- **Category:** D — dead/duplicated content
- **Confidence:** confirmed
- **Analysis:** Logged separately under Dimension D for completeness. The 32-row NEN Tabel 3 array is maintained in two doc locations plus the code `CAT`; the two doc copies are verbatim-identical today (verified by sorted diff). See C-02 for the consolidation recommendation.
- **Recommendation:** Single-source the table (import from `workflow-content.ts`). Flag only.

### [DOCS-SITE-INTEGRITY-D-03] low · Duplicated `alphaMethodRows` data block
- **Location:** `src/routes/docs/full/+page.svelte:91` and `src/lib/docs/workflow-content.ts:80`
- **Category:** D — dead/duplicated content
- **Confidence:** confirmed
- **Analysis:** Same pattern as D-02: the α-method reference table is duplicated between the full page and `workflow-content.ts`. The values match the implemented `AE` (Sanglerat) map and `alphaEB`/`sb260GranularAlpha`/`sb260TransitionAlpha` rules in `legacy-controller.js:933,1071–1119`.
- **Recommendation:** Import from the shared module rather than redefining. Flag only.

### [DOCS-SITE-INTEGRITY-D-04] info · `classCUR`/`classSB260` const aliases and legacy "EC7" label duplication
- **Location:** `src/lib/cpt-app/legacy-controller.js:2209` (`const classCUR = classCUR3;`), `:2929` (`EUROCODE_CLASS_ENTRIES`), and the doc note `workflow-content.ts:426` ("UI may still show a legacy 'EC7' label")
- **Category:** D — superseded naming / aliasing (doc acknowledges it)
- **Confidence:** confirmed
- **Analysis:** Not a doc error — the docs explicitly disclose that the NEN Tabel 3 route is still surfaced under a legacy "EC7" label in places, and `classCUR` is an alias of `classCUR3`. Logged as info so a future reviewer is aware the "EC7" vs "NEN Tabel 3" naming is an intentional legacy alias rather than a doc/code mismatch.
- **Recommendation:** No action required for correctness; consider retiring the "EC7" label for clarity. Flag only.

### [DOCS-SITE-INTEGRITY-C-05] info · WASM-C++ MC yield uses tension-positive sign convention; docs use compression-positive (consistent, not a bug)
- **Location:** `src/wasm/deformation/material_mc.hpp:125` (`f = (s1_tr − s3_tr) + (s1_tr + s3_tr)*sinPhi − 2 c cosPhi`) and the flip comment `material_hs.hpp:13`; vs theory `+page.svelte:745` and full `+page.svelte` MC yield `F = (σ1−σ3) − (σ1+σ3)sinφ′ − 2c′cosφ′`; JS mirror `material-models.js:2518` matches the docs.
- **Category:** C — Doc vs code (sign convention)
- **Confidence:** confirmed
- **Analysis:** The published yield function (and the JS reference in `material-models.js:2516–2519`, including η_MC = (s1−s3)/[(s1+s3)sinφ+2c·cosφ]) is compression-positive and matches the docs exactly. The compiled C++ kernel works in an internal tension-positive principal frame (note the documented flip `sigma_voigt[k] = -sigma3d[i][j]`), which is why its yield expression carries `+(s1+s3)sinPhi`. Substituting the sign flip makes the two algebraically identical, so this is a convention difference, not an error. I verified the same sign-consistency for the HS power-law stiffness (`material_hs.hpp:256–271` → full `:1558–1560`, σ3 for E50/Eur, σ1 for Eoed), q_f (`:243` → full `:1581`), sinφ_cv (`:289` → full `:1603`), sinφ_m (`:301` → full `:1602`), sinψ_m (`:313` → full `:1604`), and the cap δ/q̃ (`:427` → full `:1627`). Recorded as info so auditors comparing the WASM source to the docs are not misled by the apparent sign discrepancy.
- **Recommendation:** Optionally add a one-line note in the deformation/full docs that the compiled kernel uses an internal tension-positive frame while the published equations are compression-positive. No correctness fix needed.

### [DOCS-SITE-INTEGRITY-C-06] info · Verified-consistent claims (no defect) — recorded for traceability
- **Location:** multiple (see analysis)
- **Category:** C — doc/code agreement (positive verification)
- **Confidence:** confirmed
- **Analysis:** The following published statements were checked and found correct, and are listed so the audit is not mistaken for incomplete coverage:
  (a) Robertson 1990 `Qt`, `Fr`, `Ic` and the 17/18 kN/m³ preliminary unit weights — `legacy-controller.js:2072–2107`; Robertson 2016 iterative `Qtn`, `n = clamp(0.381 Ic + 0.05 σ′v0/pa − 0.15, 0.5, 1.0)` — `:2115–2158`.
  (b) NEN 6740 `qc,NEN = qc·(100/σ′v0)^0.67`, `s = log10(qcNen) − 0.34·Rf`, 14 reference centres — `nen6740.js:13–83`.
  (c) CUR3 zoning thresholds (Rf<1.5 & qc≥1.5 → Sand; <2.5 & ≥0.5 → Silt; ≤5.0 & ≥0.2 → Clay; else Peat) — `:2189–2207`.
  (d) Effective stress at midpoint with γw = 9.81 and σ′v0 = max(σv0−u, 1) — `:3414`, `stage6-engineering.js:3` (`GAMMA_W = 9.81`); no γw=10 inconsistency anywhere.
  (e) `Eoed,ref = Eoed,i·[(pref+c′cotφ′)/(σ′v0+c′cotφ′)]^m`, pref=100, m-binary 0.5/1.0, E50/Eoed=1.25 (klei en leem incl. Sandy clay), Eur,ref=3·E50,ref, K0nc=1−sinφ′, νur=0.20, Emc=E50,i — `:3409–3477`.
  (f) PLAXIS export: SoilModel 2/3, cRef=max(c′,0.1), pRef=100, m/s→m/day ×86400 — `:17265–17323`.
  (g) Bearing: Nq=exp(π tanφ)·tan²(45°+φ/2), Nc=(Nq−1)/tanφ, Nγ=2(Nq−1)tanφ′, undrained q+5.14·cu·scu·dcu, shape sq=1+r·sinφ′, depth dq=1+2tanφ′(1−sinφ′)²k — `:12459–12462`, `:12886–12929`, `:12410–12456`.
  (h) Pile: Dc=0.0357, η*p clay 1/30 / loam 1/60 / sandy-clay 1/80 / sand 1/90, βb=0.455·Db, t-z/q-z hyperbolas, tmax=t10(1+10Ms), qmax=qb10(1+4.55/Mb), ks=tmax/(Ms·Ds) — `stage6-pile.js:22,184–204,629–700`.
  (i) Seepage drain gating modes `always`/`when-saturated`/`head-cap` and the active-set/Signorini LCP — `seepage/drains.js:196`, `seepage/solver.js:812–867`.
  (j) `bishop/+page.ts` 308-redirect to `/docs/engineering/bishop`, and all 9 engineering subpage routes exist.
- **Recommendation:** None — informational confirmation.

## Notes / limitations of this audit pass
- The Hardening Soil and exact-MC constitutive kernels are compiled to WASM; I verified the published HS/MC formulas against the C++ source (`src/wasm/deformation/*.hpp`) and the JS mirror (`material-models.js`), but did not (and cannot from this layer) confirm the compiled `.wasm` artefact matches its C++ source, nor exercise numerical behaviour. The GPU v2 WGSL plasticity path (`deformation/gpu/v2/wgsl-v2/*`) was not line-checked against the docs; it is claimed in the reference deformation registry (`reference/+page.svelte:266`) as the "full elastoplastic resident pipeline" but I did not verify GPU/CPU equivalence — a second pass focused on GPU-vs-doc parity would be worthwhile.
- I did not exhaustively read the nine engineering sub-route pages (`/docs/engineering/{bearing,pile,settlement,beam,reinforcement,bishop,seepage,deformation,dewatering}/+page.svelte`) line-by-line; I confirmed they exist and spot-verified the formulas surfaced through the reference registry and full spec. A dedicated per-subpage formula pass (esp. settlement Boussinesq/Newmark integration, dewatering Sichardt C≈3000, beam Winkler/Pasternak λ, EC2 As,req stress block) against `stage6-engineering.js` / `stage6-pile.js` / the beam/reinforcement code would deepen Dimension-C coverage.
- Doc anchor checking was done by enumerating `id="…"` vs `href="#…"` and `site.ts` paths; cross-page hash links to dynamically-generated workflow ids (`#stage1…#stage5`, `#scope`, `#conventions`) were confirmed against `workflow-content.ts` section ids. External (https://) reference links were not network-validated.
