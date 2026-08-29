# 02 — Review of the current sheet-pile implementation against the course material

Scope: `src/wasm/retaining/{embedded_wall.hpp, earth_pressure.hpp, factors.hpp, retaining_wasm.cpp}`,
`src/lib/cpt-app/retaining/{retaining-ui.js, retaining-canvas.js}`, docs page
`src/routes/docs/engineering/retaining-wall/+page.svelte`. Baseline tests: `npm run verify:retaining`
(76 OK), native `test_native.cpp` (45 OK).

Grading: **OK** (matches course), **GAP** (missing feature the course/user requires), **ISSUE** (wrong or
misleading), **NOTE** (defensible difference, must be documented).

## 1. Mechanics
| # | Topic | Verdict | Detail |
|---|---|---|---|
| M1 | Rankine active on the vertical wall, effective stress, water added separately | OK | `netPressureAt` — K applied to σ′_v only; u added per face (course §2.2 "critical rule" respected). |
| M2 | Passive via EN 1997-1 Annex C closed form with δ_p = ⅔·φ′_d per layer | NOTE | Course baseline is Rankine (δ = 0); Annex C with δ_p = ⅔φ′ is allowed by the Belgian limits (curved surface, δ ≤ φ′_k − 2.5°). Ratio is applied to φ′_d (EC7 9.5.1(6) convention), slightly conservative vs. applying it to φ′_k. Must be shown in the results (currently invisible). |
| M3 | Layered profiles: σ′_v continuous, K per layer | OK | course §3.4. |
| M4 | Cohesion: p_a = K_a σ′_v − 2c′√K_a ≥ 0, tension-crack water; passive + K_pc c′ | OK | course eq. (6)–(7). |
| M5 | Undrained branch (φ_u = 0, total stress) | GAP | Engine supports it, but the UI derives `drained = !(phi<1 && cu>0)` from CPT layers → an undrained short-term branch can never be requested for a layer that has both φ′ and c_u. Course §3.2: "choose the framework deliberately". |
| M6 | Cantilever: moments about the toe, ODF by bisection, ×1.2 Blum | OK / NOTE | Same as Rekennota §7.4 (t₀ then 1.2·t₀). Label must say "Blum simplified; the 20 % is part of the method, not an EC7 verification" (course §4.3 box). |
| M7 | Anchored: moments about the anchor, T from horizontal equilibrium at the FES depth | OK | course §4.4. |
| M8 | Bending/shear by double integration, M_max at V = 0 crossing, tail clamp at closure | OK | course eq. (21)–(22). Shear diagram computed but not drawn. |
| M9 | HYD heave check (conservative exit gradient) | OK | course §4.7 lists it as a separate check — present. |
| M10 | Water: hydrostatic per face, no seepage | OK (documented) | course §3.3 allows with the same caveat; note is emitted. |
| M11 | Over-excavation | ISSUE | Hard-coded `max(min(0.1H, 0.5), 0.30)` (dry) applied to **every** combination. Course/guideline: +0.30 m for the ULS (DA1/2) branch; BGT + α_ver and SLS at the **nominal** excavation; EN 9.3.2.2 percentage rule is an alternative. → selectable rule, branch-specific application. |
| M12 | Minimum variable surcharge 10 kPa floor (embedded walls only) | ISSUE | Hidden in `buildRequest` (`minSurcharge: 10`); the user's own smaller value is silently overridden. Not a Belgian requirement (docs admit it). → visible input, default shown. |
| M13 | Surcharge always variable | GAP | No permanent surcharge (γ_G) and no retained berm/slope for embedded walls; the Rekennota needs a slope-as-surcharge. |
| M14 | Anchored wall Δa uses 10 % of height below the anchor | NOTE | EN rule; keep as option. |

## 2. Partial factors and design branches
| # | Topic | Verdict | Detail |
|---|---|---|---|
| P1 | Default C2 γ_Q = 1.30 (generic ANB); Buildwise RK scheme exists in `factors.hpp` but is **not exposed in the UI** (`riskScheme: 0` fixed) | ISSUE | Course §5.2 / Rekennota Table 4-3: embedded walls under the Belgian guideline use RK2 → γ_Q = 1.10. The docs even call the guideline an "optional overlay". → risk class selector (RK1/RK2/RK3/generic) defaulting to RK2 for embedded walls, with the generic ANB set retained. |
| P2 | K_FI consequence-class multiplier on unfavourable actions in C1/C2 | ISSUE (interaction) | When the Belgian RK scheme is active the reliability differentiation is already in the RK factors; applying K_FI on top double-counts. → K_FI forced to 1.0 (and hidden) when an RK scheme is selected; kept for the generic scheme. |
| P3 | Branches: only DA1-C1 and DA1-C2 | GAP | Course §5.4: DA1/2 (embedment, design excavation) · BGT + α_ver = 1.1 (nominal excavation, characteristic strength) with effects ×1.35 · SLS (characteristic). Structural envelope = max(DA1/2, DA1/1, 1.35·BGT). → add BGT+α_ver and SLS branches; report all. |
| P4 | "Passive de-rated by M2, no lumped factor" | OK | course §5.4 step 1 (100 % passive in the DA1/2 embedment calc). |

## 3. Transparency / output (course §10, Rekennota format)
| # | Topic | Verdict |
|---|---|---|
| T1 | Intermediates per branch (φ_d, K_a, K_p, A, B, z₀, D, T, y_Mmax, pressures at surface/excavation/toe) | GAP — engine emits only ODF, d_req, M_max, T. |
| T2 | Pressure diagram (back, front, net, water) for embedded walls | GAP — only M is drawn; V exists but is not drawn. |
| T3 | Steel section check (EN 1993-5 / EN 1993-1-1), section catalog | GAP. |
| T4 | PLAXIS input set (Plate: w, EA, EI, M_p, N_p, ν, R_inter, d_eq) | GAP. |
| T5 | Calculation-note export (Rekennota structure) | GAP. |
| T6 | "Method & assumptions" link | OK. |

## 4. Soil profile handling (user requirements)
| # | Topic | Verdict |
|---|---|---|
| S1 | CPT ground level pinned to the retained surface (`topEl = H − L.top`); no vertical shift | GAP — add "CPT ground level relative to retained surface" with upward extrapolation of the top layer and downward truncation; applies to gravity and embedded families. |
| S2 | Parameter overrides: only "single material" | GAP — add per-layer overrides (c′, φ′, γ, γ_sat, c_u, drainage) with a "set c′ = x for all layers" action; overrides stored in state and saved with the project. |
| S3 | Front profile = retained profile from the same surface | OK (same in-situ strata; excavation is a removal). |

## 5. UI/UX and code
| # | Topic | Verdict |
|---|---|---|
| U1 | `retaining-ui.js` is a single 800-line file mixing state, request building, scene building, rendering, styles | ISSUE for maintainability — split (see PLAN §2). |
| U2 | Label "δ/φ′ active (Coulomb back face)" shown for sheet piles although Rankine ignores δ | ISSUE — hide for embedded walls. |
| U3 | Text "γ_Q,C2 = 1.30 (NBN EN 1997-1 ANB)" | ISSUE once P1 is implemented. |
| U4 | Docs engineering index cards (`/docs/engineering/+page.svelte`) omit the retaining-wall page (it is in `site.ts` only) | ISSUE — add the card. |
| U5 | Code comments reference `docs/stage6/retaining_wall_methodology.md`, which does not exist | ISSUE — fix references. |
| U6 | Save/load | OK — `stage6.retwall` is part of the CPT state and is serialised; new fields must be merged in `ensure()`. |

## 6. Verified numerical parity (engine vs course §6.4) — measured
Run through the current WASM engine (scratch build) with the course DA1/2 example as an anchored wall
(H = 6.0 m, engine over-dig 0.30 m, a = 1.2 m, φ′_k = 30°, γ = 18, q_k = 10 kPa with RK2 scheme →
γ_Q = 1.10, δ_p = 0, surcharge floor off):

| Quantity | Engine (C2) | Course DA1/2 | Δ |
|---|---|---|---|
| d_required | 3.5681 m | 3.56806 m | < 0.01 % |
| T | 122.921 kN/m | 122.9213 kN/m | exact |
| M_max | 258.09 kNm/m | 258.2326 kNm/m | −0.05 % (plot subsampling) |

With the engine's default δ_p = ⅔·φ′_d (Annex C): d_required = 2.752 m, T = 112.6 kN/m, M_max = 218.0 kNm/m —
23 % less embedment than the Rankine baseline. The mechanics are therefore correct; the differences to the
course come from **assumptions that are currently invisible in the UI** (δ_p, surcharge floor, γ_Q scheme,
over-dig rule), which is exactly what the extension must make explicit.

## 7. Actions (implemented in this session unless marked)
1. factors: RK scheme first-class; K_FI interaction rule (P1, P2).
2. embedded engine: branches DA1/2, DA1/1, BGT+α_ver, SLS; over-dig rule; permanent + variable surcharge; retained berm option; drainage framework per layer; intermediates and pressure/shear diagrams in the JSON (M5, M11–M13, P3, T1, T2).
3. soldier pile engine (new).
4. sections + EN 1993 checks + PLAXIS sets (T3, T4).
5. soil-profile shift + overrides (S1, S2).
6. UI split + panels (U1–U3), docs fixes (U4, U5), calculation note (T5).
7. Not implemented (follow-up): nonlinear beam-on-springs SLS model (course §4.6 Algorithm C).
