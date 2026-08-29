# 03 — Implementation summary (retaining-wall extension, 2026-08-29)

Read together with `01-course-review.md`, `02-app-review.md` and `PLAN.md` (§4 decision log).

## What was built

### Engine (C++/WASM, `src/wasm/retaining/`)
- **Engine v2 for embedded walls**: four Belgian design branches (DA1/2, DA1/1, BGT + α_ver × 1.35, SLS) with risk-class partial factors (RK1/RK2/RK3, generic ANB), selectable over-excavation rule, permanent + variable surcharge, retained berm as equivalent surcharge, tension-crack water, per-layer design strengths and Annex C coefficients, precomputed stress profiles (O(1) queries).
- **Soldier-pile (Berliner) walls**: hand calculation with effective widths (b, b_eff = min(k·b, s)) or Brinch Hansen net line resistance (Andersen–Lodahl term, row cap); lagging design pressure; PLAXIS EBR T_lat tables (characteristic / design / sensitivity; equal-level and Andersen–Lodahl conventions side by side).
- `brinch_hansen.hpp` — single source of truth for K_q(z/B), K_c(z/B) with φ → 0 limits.
- Solver: trapezoidal V/M integration with the support reaction applied at its exact elevation; free-earth closure; zero-net-pressure depth; factored key ordinates.
- JSON bridge v2 (backward compatible keys kept) — `retaining_wasm.cpp` header documents the schema.
- Native tests (`test_native.cpp`): course manual §6 (all branches to 4 digits), §4.3 cantilever, Brinch Hansen constants (φ = 20.5°, 25°, 0°), Rekennota HEA180 (t₀, D_req, M_Ed, V_Ed, lagging p_Ed, T_lat rows), undrained crack water, anchor clamping.

### JS modules (`src/lib/cpt-app/retaining/`, all single-purpose, all with Node verifiers)
- `soil-profile.js` — CPT layers → strata with **vertical shift** (top layer extended upward / cut off) and **per-layer overrides** (c′ first-class; also γ, γ_sat, φ′, c_u, drainage framework) keyed by a stable layer key; "c′ for all layers" action; overrides pruned when the layer model changes.
- `sections/` — 90 H/I profiles (EN 10365, cross-checked against ArcelorMittal) and 88 sheet-pile sections (ArcelorMittal 2024) with sources; SI conversion; EN 1993-1-1 class + M/V/M–V checks; EN 1993-5 sheet-pile checks (elastic default, plastic with β_B, corrosion factor); lagging plate; vertical equilibrium.
- `plaxis/plaxis-parameters.js` — Plate (EA, EI, w, M_p, N_p, d_eq, ν = 0), Plate-above/EBR-below for soldier piles (γ_eff, D_eq, ISF defaults, T_skin β-method, F_max), R_inter per layer, T_lat rows for PLAXIS.
- `drivability/` (agent, source-verified) — CPT → SRD (reference and Alm & Hamre), Hypervib1-type vibratory force envelope (reproduces the course §8 example and all sensitivities), Smith 1-D wave equation for impact hammers (energy audit, refusal, bearing graph), verified hammer catalogue.
- `vibration/` (agent, source-verified) — TRL 429 / BS 5228-2 predictors, SBR-A 2017 / DIN 4150-3 / BS 7385-2 receiver limits (never mixed), monitoring plan with frequency table (SBR-A example reproduced), attenuation calibration.
- UI: `retaining-ui.js` (shell only), `wall-state.js`, `wall-types.js`, `request-builder.js`, `scenes/`, `panels/` (geometry, section, soil profile with override table, loads, EC7, anchor, drivability, vibration), `results/` (summary, verifications, design branches, diagrams, structural, PLAXIS, gravity), `report/note-view.js`, `retaining-charts.js`, `retaining-styles.js`.
- Calculation note: `src/routes/report/retaining` — print-first Dutch rekennota (references, assumptions, geometry, soil table with overrides, partial factors per branch, PLAXIS sets incl. T_lat table, hand calculation per branch, verifications, drivability, vibration, conclusions).

### Drivability from a supplier data sheet (added 29 Aug, afternoon)
- `drivability/vibrator-datasheet.js` translates a supplier sheet (F_c, rpm range, amplitude + convention, masses, flow/pressure/power, carrier class) into M_e, f, M_dyn, static downforce and a carrier suitability table; provenance of every derived value is reported.
- `vibratory-drivability.js` now drives the candidate machine to refusal: first depth with G < 0 (m_R 1.0 and 1.25), achievable depth, margins per depth; `drivability-outcome.js` gives the one-line verdict used by the section canvas, the results tab and the note.
- Answer to "how deep will this machine drive it": verdict card (reaches / marginal / refusal with shortfall), marker on the section drawing, refusal line in the depth chart.

### Documentation
- `src/routes/docs/engineering/retaining-wall/+page.svelte` rewritten where the behaviour changed (framework, embedded walls, assumptions, references).
- New pages `/docs/engineering/soldier-pile`, `/docs/engineering/drivability`, `/docs/engineering/vibration` (docs agent, checked against the modules) + `site.ts` entries and a new "Retaining walls" card section on `/docs/engineering` (the retaining-wall card had been missing there).
- `docs/stage6/retaining_wall_methodology.md` — developer map referenced from the C++ headers.

## Verification status
| Suite | Result |
|---|---|
| `worklog/verify/verify_course_examples.py` | 176/176 |
| native `test_native.cpp` | all pass |
| `npm run verify:retaining` (wasm, ui, behaviour, soil-profile, sections/plaxis, request→engine) | 220 OK (incl. Alm & Hamre SRD contract fix found by the docs agent) |
| `npm run verify:drivability` | 171 OK |
| `npm run verify:vibration` | 139 OK |
| `npm run verify:project-io` | pass |
| `npm run build` | OK |
| `npm run check` | only pre-existing errors (vite.config node types, deformation/wall-result-staleness.js) |
| Browser E2E (`npm run test:e2e`, Playwright/Chromium) | 3/3 pass — every wall type × tab renders without console errors; section-handle drag re-runs the analysis; drivability + vibration + calculation note (`/report/retaining`) render |

## Findings the user should act on
1. **Rekennota T_lat convention** differs from the course chapter / NUMGE (equal-level vs Andersen–Lodahl). Resolved: the Andersen–Lodahl (retained-height) cap is the physically consistent PLAXIS input (EBR lateral interface = spring with a maximum force, Sluis 2012 / Torggler 2016); the equal-level value is unconservative by B·Δσ′v·K_q^A (HEA180: ratio 0.33 at 0.25 m below excavation, 0.85 at 1 m, 0.97 at the toe; ∫T_lat 265 vs 286 kN/pile). App default = A–L, both columns shown; written up in the Brinch Hansen chapter rev. 2 §4.5. Brinch Hansen as the *hand-calculation* resistance (§4.6): t₀ 4.131 m (row cap) / 3.901 m (no cap) vs 3.540 m with the effective-width model — the effective-width model remains the hand-calc default, BH resistance selectable (`resistanceModel`).
2. **DA1/1 passive treatment**: the Rekennota's separate-source DA1/1 (γ_G 1.35 driving, 1.00 passive) governs the STR forces over the guideline's BGT × 1.35 route; default kept as in the Rekennota, single-source selectable.
3. **References**: all 83 course references verified online; 26 corrected (incl. one wrong JRC DOI, one dead WIT DOI, superseded NBN ANB editions, EN 12063:2024) — applied to the documents and the app (`worklog/05-reference-verification.md`).
4. Guideline-specific values (Table 4 δ limits, k_h correlations, over-dig wording) still to be confirmed against the controlled BGGG/Buildwise text.
5. The old engine's hidden 10 kPa surcharge floor and hidden γ_Q = 1.30 are now visible inputs — existing saved projects will show slightly different embedded-wall results for that reason (documented).

## Not done / follow-ups
- Nonlinear beam-on-springs SLS model (course §4.6 Algorithm C).
- Stage 7 report annex for retaining walls (the dedicated calculation note covers the output need).
- The monolith refactor (`legacy-controller.js`) — explicitly deferred by the user.
