# Retaining-wall extension — master plan & resume point

Session started 2026-08-29. Branch `v0.5.3`. This file is the single resume point:
read it first, then `PROGRESS.md` (chronological log), then the numbered review docs.

## 0. Inputs (all converted to text under `worklog/course-text/`, images under `worklog/course-images/`)

| Source | Role |
|---|---|
| `Sheet_Pile_Retaining_Walls_Manual_EC7_PLAXIS_v24.docx` | sheet-pile hand calc, Belgian RK2 workflow, PLAXIS Plate input |
| `Brinch_Hansen_Tlat_Soldier_Pile_Walls_Textbook_Section.docx` | Brinch Hansen (1961) Kq/Kc, Andersen–Lodahl soldier-wall term, PLAXIS EBR |
| `Vibratory_Pile_Installation_Manual_Eurocode_Course_Chapter.docx` | Hypervib1-type drivability, TRL 429 PPV, receiver criteria, trial calibration |
| `NUMGE2023-25.pdf` | Andersen & Lodahl 2023 — plate above / EBR below excavation |
| `Rekennota_beschoeiing_berlinerwand_HEA180.docx` | target calculation-note format (Berliner wall, HEA180, PLAXIS parameter set) |
| `T26L053 ... LLTrillingsmonitoring.pdf` | SBR-A vibration limit derivation example (γs·γv·γt) |

All worked examples verified numerically: `worklog/verify/verify_course_examples.py` → 176/176 OK.

## 1. Deliverables (user's numbered tasks)

1. **Course-material review** → `worklog/01-course-review.md`
2. **App-vs-course review of the current sheet-pile implementation** → `worklog/02-app-review.md`
3. **Implementation** (this plan §3–§6)
   - sheet pile: Belgian RK2 branches, transparent intermediates, section catalog + EN 1993-5 checks
   - soldier pile (Berliner wall): Blum hand calc with effective width (EAB / Belgian §5) **and** Brinch Hansen line resistance; lagging check; vertical equilibrium
   - PLAXIS 2D input parameters (Plate for sheet pile; Plate + Embedded Beam Row for soldier pile incl. multilinear T_lat table, T_skin, F_max, ISF)
   - stratigraphy vertical shift (CPT ground level ≠ wall datum) — all retaining-wall types
   - per-layer parameter overrides (c′ first-class, also φ′, γ, c_u) — all retaining-wall types
   - drivability ("heipredictie"): vibratory (Hypervib1-type, CPT-based) + impact (Smith 1-D wave equation) with blow-count / force-envelope graphs
   - vibration impact assessment: TRL 429 / BS 5228 prediction, SBR-A / DIN 4150-3 / BS 7385-2 receiver limits, monitoring trigger levels, two-point calibration
   - calculation-note output (Rekennota-style, printable) with all PLAXIS values copyable
   - docs: theory pages for every new feature, with references and stated assumptions
4. Save/load: already exists (commit 4761c16) — verify it round-trips the new retaining state.
5. Monolith refactor — **separate task, after 1–4** (do not start; only keep new code clean).

## 2. Architecture decisions (final)

- **Engine stays C++/WASM** (`src/wasm/retaining/`). `em++` 5.0.7 is installed (`/opt/homebrew/bin/em++`);
  build: `bash src/wasm/retaining/build.sh` → `static/wasm/retaining/retaining.{js,wasm}`.
  Native unit tests: `g++ -std=c++20 -O2 -I src/wasm/retaining src/wasm/retaining/test_native.cpp -o /tmp/rwtest`.
  - new header `soldier_pile_wall.hpp` (Blum GEO with effective width **or** Brinch Hansen net line resistance; both per pile)
  - new header `brinch_hansen.hpp` (Kq/Kc coefficients, single source of truth; emits T_lat tables for PLAXIS)
  - `embedded_wall.hpp`: Belgian RK2 branches (DA1/2 embedment; BGT+α_ver ×1.35 structural; DA1/1; SLS), configurable over-dig rule, configurable surcharge floor, transparent intermediates
  - `factors.hpp`: risk-class scheme becomes first-class (RK1/RK2/RK3 + "EN/ANB generic")
- **JS side** `src/lib/cpt-app/retaining/` split into small, single-purpose files (no god file):
  - `retaining-ui.js` — shell only (tabs, layout, dispatch, handlers registry)
  - `wall-types.js` — wall-type registry (id, label, family, engine key)
  - `soil-profile.js` — CPT layers → engine strata: vertical shift, extend-top-layer, per-layer overrides
  - `request-builder.js` — state → engine JSON
  - `scenes/gravity-scene.js`, `scenes/embedded-scene.js` — canvas scene builders
  - `panels/*.js` — one file per input panel (geometry, soil-profile, sections, loads, ec7, plaxis, drivability, vibration)
  - `results/*.js` — results rendering per family + calculation-note payload builder
  - `sections/steel-h-sections.js`, `sections/sheet-pile-sections.js`, `sections/section-properties.js`
  - `plaxis/plaxis-parameters.js` — Plate / EBR parameter derivation (pure)
  - `drivability/` — `vibratory-drivability.js` (Hypervib1-type), `impact-wave-equation.js` (Smith), `srd-from-cpt.js`, `hammer-catalog.js`, `drivability-worker.js`
  - `vibration/` — `ppv-prediction.js` (TRL 429), `receiver-criteria.js` (SBR-A, DIN 4150-3, BS 7385-2, BS 5228 human), `attenuation-calibration.js`
  - `report/retaining-note-payload.js` + route `src/routes/report/retaining/+page.svelte` (print-first note)
- Every pure module gets a Node verify script `scripts/verify_retaining_<topic>.mjs`, registered in `package.json`.
- Docs: extend `src/routes/docs/engineering/retaining-wall/+page.svelte`; add `soldier-pile`, `drivability`, `vibration` pages; register in `src/lib/docs/site.ts`; references page.

## 3. Work breakdown & ownership

| # | Work item | Owner | Depends on | Status |
|---|---|---|---|---|
| A | Section catalogs (HEA/HEB/HEM/IPE EN 10365; AZ/PU/GU ArcelorMittal) with per-entry source | agent `catalogs` | — | DONE (90 + 88 rows) |
| B | C++ engine: `brinch_hansen.hpp`, `soldier_pile_wall.hpp`, RK2 branches in `embedded_wall.hpp`, JSON bridge, native tests | main | — | DONE (native + wasm green) |
| C | JS `soil-profile.js` (shift + overrides) + `request-builder.js` + verify | main | B (schema) | DONE |
| D | Drivability modules + verify | agent `drivability` | A (section geometry contract) | DONE (171 checks) |
| E | Vibration modules + verify | agent `vibration` | — | DONE (139 checks) |
| F | PLAXIS parameter module + verify (Rekennota numbers as fixtures) | main | A, B | DONE |
| G | UI split + new panels + scenes | main | B–F | DONE (Node-verified + Playwright E2E) |
| H | Calculation-note report route | main | G | DONE (`/report/retaining`) |
| I | Docs pages + site nav + references | main (+agent for drafting) | B–H | DONE (retaining page rewritten; soldier-pile / drivability / vibration pages + nav) |
| J | E2E: build wasm, `npm run check`, all verify scripts, browser E2E (Playwright, `npm run test:e2e`) | main | all | DONE (build OK; check: only pre-existing errors; 3/3 Playwright tests pass) |
| K | Course material: T_lat convention section (BH chapter rev. 2 §4.5–4.6), cross-reference in sheet-pile manual, reference verification of all three docx | main + agent `references` | 01 review | DONE (83 refs verified; corrections applied to all four documents + app reference lists; see 05 + 01 §H) |

## 4. Engineering decisions log (transparent, to be echoed in docs)

- D1. Default partial-factor scheme for **embedded walls** = Belgian embedded-wall guideline (BGGG/WTCB 2022) **RK2**: A2 γ_Q = 1.10, M2 = 1.25/1.25/1.40. The generic NBN EN 1997-1 ANB set (γ_Q,C2 = 1.30) stays selectable. Gravity/cantilever walls keep the generic ANB default (guideline scope is embedded walls).
- D2. Over-excavation rule selectable: Belgian (dry +0.30 m ULS; under water min(0.1h, 0.5 m)) [default]; EN 1997-1 §9.3.2.2 (10 %, ≤ 0.5 m); custom. Applied to ULS branches only; BGT+α_ver and SLS use the nominal excavation (guideline §3.3).
- D3. Branches reported for embedded walls: DA1/2 (embedment, design excavation) · DA1/1 · BGT+α_ver (×1.35 on effects for STR) · SLS (characteristic). Structural envelope = max(DA1/2, DA1/1, 1.35·BGT+α_ver).
- D4. Cantilever embedment: free-earth depth from moment equilibrium about the rotation point, ×1.2 (Blum). Reported as "Blum simplified", not as an EC7 verification of the toe reaction.
- D5. Soldier pile GEO hand calc: driving = active × s above excavation; below excavation active × b (flange width) and passive × b_eff = min(3b, s) with plane-strain K_p (EAB / Belgian guideline §5) — **method "effective width"**; alternative **method "Brinch Hansen"**: net line resistance B·[e_w(z)]⁺ with the Andersen–Lodahl additional active term, capped by s·p_net,continuous. Never mixed (Rekennota §5.7).
- D6. PLAXIS EBR T_lat table always Brinch Hansen with B = flange width (not 3b, not R_eq), per pile, not divided by spacing; characteristic and design (recomputed at φ_d) columns.
- D7. Wall friction defaults: sheet pile δ_p = ⅔·φ′ (Belgian cap for straight surfaces; Annex C curved surface would allow φ′_k − 2.5°); soldier pile δ = 0 (Rankine, Rekennota) with cap φ′/2 (Belgian Table 4 curved) shown.
- D8. Surcharge floor is an explicit, visible input (default 10 kPa, labelled as a practice value, not a Belgian requirement).
- D9. Steel checks: EN 1993-1-1 (H-sections, class 1 plastic) and EN 1993-5 (sheet piles: elastic W_el by default, W_pl optional with β_B input); γ_M0 = 1.00 (NBN EN 1993-1-1 ANB). Corrosion: optional uniform section-loss factor.
- D10. Drivability is non-normative (Van Rompaey/Legrand/Holeyman 1995; Smith 1960). No Eurocode partial factors on installation resistance; upper-bound SRD, transparent reserve multiplier m_R.
- D11. Vibration prediction TRL 429 (Hiller & Crabb 2000) k_v ∈ {60,126,266}, δ_v ∈ {1.2,1.3,1.4}. Receiver frameworks selectable, never mixed.

## 5. Conventions for all new code

- ES modules, `// SPDX-License-Identifier: AGPL-3.0-or-later` header, `// @ts-nocheck` only where the legacy pattern requires it.
- Pure calculation modules: no DOM, no globals, JSDoc-typed inputs/outputs, SI units (kN, kPa, m, kg) explicit in names.
- Every number that appears in the UI must be traceable: results objects carry `{value, unit, formula?, note?}` where relevant.
- UI text: English (app language), Dutch terms in parentheses where the Belgian practice uses them (e.g. "over-excavation (overdiepte)").
- No hidden defaults that change results (e.g. the old hidden 10 kPa floor).
