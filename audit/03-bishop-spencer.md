# Audit — Slope stability — Bishop Simplified & Spencer
**Subsystem key:** bishop-spencer
**Files reviewed:** src/lib/cpt-app/stage6-bishop.js (full), src/lib/cpt-app/stage6-bishop-worker.js (full), src/lib/cpt-app/stage6-canvas-utils.js (full), docs/bishop/bishop_simplified_v1_spec.html (formula/algo sections), docs/bishop/spencer_extension_v2_spec.html (theory/kernel sections), docs/bishop/retaining_walls_extension_spec.md (full), src/routes/docs/engineering/bishop/+page.svelte (theory sections), plus cross-reference of src/lib/cpt-app/legacy-controller.js (worker lifecycle + solver-config wiring) and src/lib/cpt-app/wall-geometry.js (axis/normal helpers)
**Finding counts:** critical=0 high=0 medium=3 low=4 info=4  |  A=1 B=2 C=4 D=4  |  total=11

## Overview
The Bishop Simplified and Spencer implementations are, on the whole, **numerically sound and scientifically correct**. The single most error-prone term — the Bishop pore-pressure uplift `u·b` (slice width, not base length `u·l`) — is implemented correctly (`stage6-bishop.js:2392`), and the prior audit's fix has held. I independently re-derived the full Spencer slice kernel (`evaluateSpencerState`) from vertical + horizontal slice equilibrium plus the Mohr-Coulomb base law and confirmed every coefficient (`a0`, `a1`, `N_eff`, `E_right`, `S_mob`) matches the in-app documentation and is correct, including the legitimate `l→b` projections (`l·cosα=b`, `l·sinα=b·tanα`). The base-angle sign convention in code is physically correct (positive α at the heel, negative at the toe, via `moveSign`), and the retaining-wall passive-resistance integration and moment-term/`R` cancellation match the wall spec (and improve on it with layer-by-layer integration and a true pressure centroid). The main issues are documentation drift between the two older HTML design specs and the actual code (the in-app Svelte doc is accurate; the HTML specs are stale on tolerance, under-relaxation, and a sign-inverted base-angle comment), a large body of unreachable "legacy-bands" code, and some retained-memory / allocation overheads in the search loop. No correctness defect that would yield a plausible-but-wrong factor of safety was found.

## Findings

### [BISHOP-SPENCER-A-01] low · Pore pressure can become NaN at a slice base and only fails safe by rejection
- **Location:** `stage6-bishop.js:562-581` (`averagePorePressureOnBase`), consumed at `2392`, `1343`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** `averagePorePressureOnBase` samples `circleYActive(circle, x)` at three Gauss points and computes `Math.max((water - y) * GAMMA_W, 0)`. If `circleYActive` returns `NaN` (point marginally outside the circle, e.g. a slice break landing at `±R` after the merge tolerance shuffles cuts), `Math.max(NaN, 0)` returns `NaN` in JavaScript, so `uBase` becomes `NaN`. This propagates into `resisting += (c·b + (V − u·b)·tanφ')/mα` → `nextF = NaN`, which is then caught by `if (!Number.isFinite(nextF))` at `2396` and the circle is rejected. So the behavior is fail-safe (a valid surface may be silently dropped rather than producing a wrong FoS), but it is fragile: the Gauss abscissae are strictly interior (0.211/0.5/0.789) and the breaks are interior, so in practice this is rarely hit. Not a wrong-answer bug, but the absence of a `Number.isFinite` guard inside the Gauss loop means a geometry edge case degrades to "circle rejected" with no diagnostic.
- **Recommendation:** Guard each Gauss sample with `Number.isFinite` (skip or clamp y to the arc) and/or count such rejections under a dedicated rejection reason so they are visible rather than silently folded into convergence failures.

### [BISHOP-SPENCER-B-01] medium · Every converged trial retains a full enriched slice array for the whole search
- **Location:** `stage6-bishop.js:2511-2657` (`analyzeBishopSearch`), `1134-1175` (`buildBishopSearchResult` → `enrichBishopSlices`), result returned via `allResults`
- **Category:** B — Memory / performance
- **Confidence:** confirmed
- **Analysis:** For each of `nEntry·nExit·nCenter·2` trials (default 10·10·15·2 = 3000) that converge, `buildBishopSearchResult` builds and stores a full `slices` array (each slice cloned/enriched with `~25` fields plus nested `layerAreas`, `wallInteractionsLeft`, a cloned `baseMaterial`) inside `results`. All of these are kept in the `results` array for the entire search and are then serialized in their entirety as `allResults` across the worker→main-thread `postMessage` boundary (structured clone). Only `recheckCount` (default 10) are actually needed at full fidelity for the Spencer recheck; the rest only need their scalar summary. For a 3000-circle search at ~30 slices each this is on the order of 10^5 slice objects retained and cloned. It works, but it is the dominant memory/serialization cost of the subsystem.
- **Recommendation:** Keep full `slices` only for the top-`keepBest`/`recheckCount` results (or for the few `critical*` results returned), and strip `slices` (or reduce to a compact summary) from the remaining `allResults` before posting. The Spencer recheck already operates only on the shortlist, so the deep arrays for non-shortlisted circles are never read.

### [BISHOP-SPENCER-B-02] low · Per-trial re-derivation of region-boundary cuts and pore pressure; no memoization across the search
- **Location:** `stage6-bishop.js:883-945` (`computeSliceBreaks`), `562-581` (`averagePorePressureOnBase`), `334-344` (`regionSliceContributions`)
- **Category:** B — Memory / performance
- **Confidence:** likely
- **Analysis:** Each trial rebuilds the full cut set (terrain vertices, phreatic vertices, `boundaryYs` circle intersections, region-boundary polylines, surface-load edges, wall intersections), then per slice calls `regionStripOverlap`/`probeVerticalRegionStack` and `sampleSeepagePorePressure` (when FEM pore pressure is enabled). The model geometry (terrain, regions, phreatic, boundaryYs) is constant across all 3000 trials, yet nothing is precomputed once. `mergeShortIntervals` (`851-881`) is an O(n) splice-in-a-while-loop that restarts scanning after every merge → O(n²) in the number of cuts per circle (n is small, ~30-60, so minor). The FEM pore-pressure path does a fresh mesh point-location per Gauss point per slice per circle with no spatial cache. None of this is a hot-loop disaster at default sizes, but it is repeated work that scales with trial count.
- **Recommendation:** Precompute model-level invariants (sorted terrain/phreatic x's, region boundary polylines, FEM mesh acceleration structure) once in `analyzeBishopSearch` and pass them down; consider a small memoized point-location cache for the seepage sampler.

### [BISHOP-SPENCER-C-01] medium · HTML data-structure comment gives a sign-inverted base-angle formula; code is correct
- **Location:** doc `docs/bishop/bishop_simplified_v1_spec.html:951-952`; code `stage6-bishop.js:434-437` (`baseAngleRad`)
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** in the `SlipCircle` data structure, `baseAngle(x): asin((x - xc) / R)`. (2) **Code does:** `baseAngleRad = atan(−circleSlopeActive(circle, x) · moveSign)`, where `moveSign = sign(exit.x − entry.x)` and for the lower arc `circleSlope = (x−xc)/√(R²−(x−xc)²)`. (3) **Which is correct:** the CODE. For a slide running left→right (entry at heel, exit at toe) the standard convention requires α > 0 in the active/heel zone (so the heavy heel slices DRIVE, `ΣW·sinα > 0`) and α < 0 at the passive/toe zone. The code's negation gives exactly this: heel (x<xc, slope<0) → α>0, toe (x>xc, slope>0) → α<0. The bare `asin((x−xc)/R)` in the doc yields the opposite sign (positive at the toe, negative at the heel), which would invert the driving term, and it omits `moveSign` so it is not robust to slide direction. The governing equation is the Bishop moment balance `ΣW·sinα = (1/F)Σ(c'l + N'tanφ')` with `m_α = cosα + sinα·tanφ'/F`; the code's α makes `ΣW·sinα > 0` for real failure surfaces and correctly drives `m_α` small/negative at steep toe bases (which the solver then rejects, `2378`). The in-app Svelte doc only labels α as "base inclination" and contains no wrong formula. (4) **Fix direction:** fix the doc comment (use a signed convention consistent with slide direction, or remove the explicit `asin` formula and reference the implemented `atan(−slope·moveSign)`); code is correct, do not change.
- **Recommendation:** Correct the HTML spec's `baseAngle` data-structure comment to match the implemented sign convention.

### [BISHOP-SPENCER-C-02] medium · HTML specs mandate divergence-triggered under-relaxation; code uses plain fixed-point with none
- **Location:** doc `bishop_simplified_v1_spec.html:853, 1411-1418`; doc `retaining_walls_extension_spec.md:430, 743-749`; code `stage6-bishop.js:2366-2414` (`solveBishopSimplified`)
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) **Docs say:** detect divergence (`change > prevChange`) and switch to under-relaxed updates `F^{k+1} = 0.5·F_new + 0.5·F^k`; both the v1 spec and the wall spec pseudocode include this explicitly and state "same convergence criteria, same under-relaxation, same everything." (2) **Code does:** a pure successive-substitution loop — `if (|nextF − F| < tol) return; F = nextF;` — with no `prevChange` tracking and no relaxation. (3) **Which is correct:** both are defensible; the Bishop fixed point converges monotonically for the overwhelming majority of admissible circular surfaces, so under-relaxation is a robustness aid, not a correctness requirement. The in-app Svelte doc (the authoritative, code-accurate doc) describes the present plain fixed-point and is consistent with the code. (4) **Fix direction:** either add the documented under-relaxation to the solver (low-risk robustness improvement for pathological surfaces that currently exhaust the 50-iteration cap and are rejected) OR annotate the HTML specs that under-relaxation was intentionally not implemented. Prefer fixing the doc to match, since the in-app doc already does.
- **Recommendation:** Reconcile: implement the documented relaxation, or mark the HTML specs as superseded by the in-app doc on this point.

### [BISHOP-SPENCER-C-03] low · HTML v1 spec is internally inconsistent on the Bishop convergence tolerance (0.001 vs 1e-4); code uses 1e-4
- **Location:** doc `bishop_simplified_v1_spec.html:808` (`tolerance = 1e-4`) vs `:1355` (`tolerance: float = 0.001`); doc `retaining_walls_extension_spec.md:686` (`tolerance = 0.001`); code default `stage6-bishop.js:2410` (`1e-4`), actual value from `legacy-controller.js:4265` (`tolerance:0.0001`)
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** The v1 spec states the FoS convergence tolerance as `1e-4` in the algorithm prose (`:808`) but `0.001` in the pseudocode function signature (`:1355`); the wall spec pseudocode also uses `0.001`. The shipped controller passes `tolerance: 0.0001` (1e-4), and the solver default is `1e-4`. The prompt's expected value is 1e-4, so the **code is correct** and matches the spec prose; the spec pseudocode defaults (0.001) are the stale outliers. This is purely a documentation inconsistency (the looser 0.001 would still give engineering-acceptable FoS to ~3 sig figs, so no wrong-answer risk).
- **Recommendation:** Make the HTML specs consistent at 1e-4 (or note that the runtime value is supplied by the controller, currently 1e-4).

### [BISHOP-SPENCER-C-04] low · Wall-spec §11.3 Spencer-propagation pseudocode uses a different (and internally inconsistent) a0/a1 sign convention than the code; code is correct
- **Location:** doc `retaining_walls_extension_spec.md:799-808`; code `stage6-bishop.js:1318-1347`; in-app doc `+page.svelte:786-801`
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) **Wall-spec pseudocode says:** `a1 = -sinA + tanPhi·cosA/F`, `a0 = E_left − u·b·(sinA/cosA) + c'·b/F`, and `numer_N = W + λE_left − λa0 − u·b − c'·b·tanα/F`. (2) **Code does (matching the in-app doc):** `a1 = sinA − tanφ'·cosA/F`, `a0 = E_left + u·b·tanα − c'·b/F`, `numerN = V + λE_left − λa0 − u·b − c'·b·tanα/F`, `N_eff = numerN/(mα + λa1)`, `E_right = a0 + a1·N_eff`, `S_mob = (c'·l + N'·tanφ')/F`. (3) **Which is correct:** I re-derived the slice kernel from the spec's own §3.3 equilibrium set (vertical `N cosα + S sinα = V + X_L − X_R`, horizontal `N sinα − S cosα = E_R − E_L`, Mohr-Coulomb `S = (c'l + N'tanφ')/F` with `N' = N − u·l`). That derivation yields exactly the CODE's `a0`/`a1`/`N_eff`/`E_right`, with the width terms `u·b`, `c'·b·tanα` arising legitimately from `l·cosα=b` and `l·sinα=b·tanα`. The wall-spec §11.3 signs negate both `a1` and the non-`E_left` part of `a0`, which does not consistently reproduce `E_right = a0 + a1·N'` from the spec's own horizontal-equilibrium line — i.e. the spec pseudocode is the inconsistent one. The mobilised shear correctly uses the true base length `l` in both (spec and code), satisfying the v2 spec's "academic correction" (`spencer_extension_v2_spec.html:530-550`). (4) **Fix direction:** fix the wall-spec pseudocode signs to the implemented convention; code is correct.
- **Recommendation:** Update `retaining_walls_extension_spec.md:799-808` to the implemented `a0`/`a1` convention (or reference the in-app doc §6.3 as canonical).

### [BISHOP-SPENCER-D-01] medium · Entire "legacy-bands" soil-model path is unreachable in production
- **Location:** `stage6-bishop.js:202-247` (`buildLegacyHorizontalBandPolygons`), `249-262` (`baseMaterialAtLegacy`), `264-281` (`deriveBandContributionAtXLegacy`), `314-332` (`legacySliceContributions`), `625-664` (`wallPassiveSegmentsLegacy`), `2812-2818` (`legacyBands` build), `2957` (`includeLegacyBands` gate), plus the `soilSource === 'legacy-bands'` branches at `284-285`, `372-373`, `672-674`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `model.legacyBands` is only populated when `options.includeLegacyBands` is true in `buildBishopModelFromStageLayers` (`:2957`). The only production callers (`legacy-controller.js:6792` and `:11278`) call it with no `options`, so `legacyBands` is never set. Independently, `analyzeBishopSearch` reads `input.soilSource` (`:2516`) but the controller's search `input` (`legacy-controller.js:8169-8180`) never includes `soilSource`, so it always defaults to `'regions'`. Both gates are therefore permanently off in shipped code, making the entire legacy-bands representation (region-superseded) dead. `buildLegacyHorizontalBandPolygons` (`:202`) is not referenced anywhere at all — not even behind the legacy gate.
- **Recommendation:** Flag for removal of the legacy-bands path and its `soilSource` plumbing, or document why it is retained (e.g. test fixtures). FLAG ONLY — no deletion performed.

### [BISHOP-SPENCER-D-02] low · `useNewton` Spencer config is normalized but never read (no Newton/quasi-Newton solver exists)
- **Location:** `stage6-bishop.js:50` (default), `1249` (`merged.useNewton = !!merged.useNewton`)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `DEFAULT_SPENCER_CONFIG.useNewton` is defaulted to `false` and normalized in `normalizeSpencerConfig`, but no code path branches on `useNewton` — the Spencer outer/inner solves are always bracketing + bisection + secant-bracket seeding. The v2 spec offers a "direct two-variable Newton solve" as an *alternative* (`spencer_extension_v2_spec.html:601`), but it was not implemented; the flag is a vestige of that option. Flag-disabled / never-branched config.
- **Recommendation:** Remove the unused flag or implement the Newton path it implies. FLAG ONLY.

### [BISHOP-SPENCER-D-03] low · Test-only exports with no tests in the repository
- **Location:** `stage6-bishop.js:507-509` (`debugSurfaceLoadContributionForTest`), `682-684` (`debugWallPassiveSegmentsForTest`)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** Both functions are `export`ed solely as test hooks (names end in `ForTest`) but a repo-wide search finds no `*.test.js`/`*.spec.js` and no other file referencing either symbol. They are dead exports that also keep the legacy `wallPassiveSegments`/`totalSurfaceLoadContribution` reachable from the public surface for no current consumer.
- **Recommendation:** Either add the intended unit tests or remove the dead test exports. FLAG ONLY.

### [BISHOP-SPENCER-INFO-01] info · Bishop rejects negative m_α; Spencer tolerates it (|m_α| guard) — intentional and correct
- **Location:** `stage6-bishop.js:2378` (Bishop `mAlpha <= minMAlpha`) vs `1300`/`1321` (Spencer `Math.abs(mAlpha) <= minMAlpha`, `Math.abs(denomN) <= minMAlpha`)
- **Category:** A — Implementation (no defect)
- **Confidence:** confirmed
- **Analysis:** The Bishop fixed point divides the resisting term by `m_α` alone, so a non-positive `m_α` makes the slice term unbounded/negative and the iteration meaningless — rejection is correct (matches v1 spec §6.4). Spencer's slice denominator is `m_α + λ·a1`, not `m_α`, so a slightly negative `m_α` can still yield a well-conditioned `denomN`; guarding on `|m_α|` and `|denomN|` rather than sign is the right choice. The asymmetry is deliberate and physically justified, not a bug.
- **Recommendation:** None. Documented here to forestall a future "inconsistency" misfiling.

### [BISHOP-SPENCER-INFO-02] info · Surcharge enters the frictional resistance numerator via V (not just the driving denominator) — matches the doc
- **Location:** `stage6-bishop.js:2392` (`(V − u·b)·tanφ'`), `2344`/`1369` (`V·sinα` driving); doc `bishop_simplified_v1_spec.html:873, 883`
- **Category:** C — Doc vs code (consistent)
- **Confidence:** confirmed
- **Analysis:** The code uses `V = W + Q` (weight + surcharge) in both the Bishop numerator `(V − u·b)·tanφ'` and the driving term `V·sinα`. The v1 spec explicitly endorses this (`:869` "replace W_i by V_i wherever the solver uses the total downward slice force"; `:873`, `:883`). This means a vertical surcharge increases base normal force and hence frictional resistance — standard for limit equilibrium where the surcharge is treated as added vertical slice load. Doc and code agree and are correct. (Note: this is a modelling choice — a surcharge near the toe will both raise resistance and the driving term; acceptable and conventional.)
- **Recommendation:** None.

### [BISHOP-SPENCER-INFO-03] info · No true tension-crack geometry; base tension (N'<0) is flagged not clipped — a documented valid choice
- **Location:** `stage6-bishop.js:1367` (`if (N_eff < 0) tensionSlices += 1`); doc `spencer_extension_v2_spec.html:803-804, 869`
- **Category:** A — Implementation (no defect)
- **Confidence:** confirmed
- **Analysis:** The prompt lists "tension-crack handling." The code does not model a vertical tension crack (crest crack with optional hydrostatic water thrust) — neither do the specs, which list it only as a future extension. For base tension, the code counts `tensionSlices` where the effective base normal `N_eff < 0` and reports it without clipping `N'` to zero; the v2 spec (`:804`) explicitly states clipping-vs-reporting is "an explicit implementation choice... not introduced silently," and reporting is one of the sanctioned options. Consistent.
- **Recommendation:** None; note that absence of crest tension-crack modelling should remain documented as a limitation.

### [BISHOP-SPENCER-INFO-04] info · Spencer moment residual drops interslice-force moment terms (valid circular simplification) and is documented
- **Location:** `stage6-bishop.js:1369-1383` (`drivingMoment += V·sinα`, `resistingMoment += S_mob`, `momentResidual = ΣS − ΣV·sinα + wallMomentTerm`); in-app doc `+page.svelte:849-862`; spec `spencer_extension_v2_spec.html:648-652`
- **Category:** C — Doc vs code (consistent)
- **Confidence:** confirmed
- **Analysis:** For a circular surface with moments taken about the centre, the base shear `S_i` acts on lever arm `R` and the weight driving moment is `R·ΣV·sinα`; the common `R` cancels, leaving the code's `ΣS − ΣV·sinα` residual (kN/m). The spec's `R_m = ΣW·x_i − R·ΣS` is the same target with the weight moment expressed as `R·ΣV·sinα`. The in-app doc states this cancellation and the resulting kN/m units explicitly. The classical Spencer moment equation's interslice-force contributions vanish for the circular reference-about-centre case, which the in-app doc notes. Doc and code agree and are correct for circular surfaces.
- **Recommendation:** None.

## Notes / limitations of this audit pass
- I deep-read the three named subsystem files in full and the four paired docs in their formula/algorithm sections. I cross-referenced `legacy-controller.js` only for the two things that determine correctness/reachability here: the worker lifecycle (properly terminated/nulled on stop/error/restart — no leak from the controller side) and the solver/spencer/search config actually passed (tolerance 1e-4, minMAlpha 1e-6, λ bracket ±0.6, no `soilSource`, no `includeLegacyBands`).
- I did **not** deep-audit `wall-geometry.js`, `soil-regions.js` (`regionStripOverlap`, `probeVerticalRegionStack`, `materialAt`), or the seepage sampler (`sampleSeepagePorePressure`) — these are separate subsystems. The Bishop/Spencer code's *use* of them (units, sign of normals, station-along-axis logic) was checked and is consistent, but the internals of those helpers (e.g. polygon clipping correctness, FEM pore-pressure interpolation) are out of scope and warrant their own pass.
- The Spencer kernel correctness was established by independent re-derivation from the documented slice-equilibrium equations; I did not run numerical benchmarks against a reference solver (SLOPE/W / SLIDE). A numerical regression test (e.g. the wall spec's Test 2 hand calc `R_passive = 567 kN/m` for `Kp=3, z_int=2, z_tip=5`) would be valuable confirmation and is currently absent (no test files exist — see D-03).
- The base-angle sign (C-01) was verified by geometric reasoning for the left→right slide case and by confirming `moveSign` generalizes it to right→left; I did not exhaustively trace the right→left orientation through `resolveActiveBranch`/`activeCircleBranch`, so that orientation deserves a confirmatory numerical check.
