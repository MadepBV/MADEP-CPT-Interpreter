# Audit — Stage 6 — bearing capacity, settlement, dewatering, EC2 reinforcement
**Subsystem key:** stage6-engineering
**Files reviewed:** src/lib/cpt-app/stage6-engineering.js (full), src/lib/cpt-app/legacy-controller.js (bearing block lines ~12343-13160, defaults ~4054-4070), src/routes/docs/engineering/bearing/+page.svelte (full), src/routes/docs/engineering/settlement/+page.svelte (full), src/routes/docs/engineering/dewatering/+page.svelte (full), src/routes/docs/engineering/reinforcement/+page.svelte (full), scripts/ec2_durability.py (full), docs/logic.md (bearing block lines ~1440-1604)
**Finding counts:** critical=0 high=2 medium=4 low=6 info=4  |  A=2 B=3 C=8 D=3  |  total=16

## Overview
The numerical core is in good health. The settlement Boussinesq/Fadum stress integration, the
Janbu/Hardening-Soil oedometer stiffness, the Terzaghi consolidation, the EC7 bearing factors
(Nq, Nc, Nγ=2(Nq−1)tanφ Annex D), the Meyerhof effective-area reduction, the Vesić subgrade modulus,
the Hermite beam + Pasternak FE, and the EC2 cover/μ-ω reinforcement routines are all implemented
correctly and agree with `docs/logic.md` and `scripts/ec2_durability.py`. The dominant problem class is
**doc-vs-code drift**: the in-app `/docs/engineering/bearing` and `/docs/engineering/dewatering` pages
describe capabilities (inclination factors, three-case Nγ water-table averaging, a Meyerhof Nγ form, a
1.40 γ_Rd, a factor-2 trench flow) that the code does not implement — and in several places the same page
contradicts itself (§4/§7 vs §11). `docs/logic.md` is the accurate reference and matches the code. No
critical numerical defects were confirmed; the two A-findings are minor robustness/edge issues, and the
in-app docs overstate the model rather than the code being wrong.

## Findings

### [STAGE6-ENGINEERING-A-01] low · Over-reinforced section (0.295 < μ < 0.5) still returns a singly-reinforced As with only a warning
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1465-1469`, `1482-1484`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** `omega = mu < 0.5 ? 1 - Math.sqrt(Math.max(1 - 2 * mu, 0)) : null;` then `AsReq = omega != null ? (omega*bw*d*fcd)/fyd : null`. For μ in (0.295, 0.5) the section is past the singly-reinforced ductility bound (EC2 ξ_lim≈0.617 ⇒ μ_lim≈0.372 for B500B per the doc) but the code still returns the closed-form singly-reinforced As and only pushes a warning. The returned As in that band is non-conservative because the rectangular block over-estimates lever arm once the steel no longer yields. For μ≥0.5 it returns `null`→falls back to AsMin, which is also physically meaningless (it would under-reinforce a heavily loaded section), though that band is far past any practical screen. This is acceptable for a "screening" tool given the explicit warning, but the numeric As in the (μ_lim, 0.5) window should be flagged as invalid rather than reported as a design quantity.
- **Recommendation:** Cap/null the closed-form As at the true ductility limit (μ_lim ≈ 0.372 for the implemented λ,η, or the documented 0.295 warning threshold) and surface "double reinforcement required" rather than emitting an As the engineer could mistake for usable.

### [STAGE6-ENGINEERING-A-02] low · `cMinB` adds a non-standard 6 mm bond-cover floor not present in the Python reference
- **Location:** `src/lib/cpt-app/stage6-engineering.js:213-217` (`ec2MinimumBondCover`)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** Code: `let cMinB = Math.max(positive(config.phiBar, 12), 6);`. EN 1992-1-1 Table 4.2 single-bar bond cover is `c_min,b = φ` with no 6 mm floor (the reference `scripts/ec2_durability.py:c_min_bond` returns exactly `phi_bar_mm`, then optionally +5 for d_g>32). The JS injects a 6 mm floor. In practice this never changes the result because `cMin = max(cMinDur, cMinB, 10)` already imposes a 10 mm absolute floor, so the 6 mm is dominated. Harmless but it is a deviation from the cited standard and from the paired reference script.
- **Recommendation:** Drop the `,6` floor to match EN 1992-1-1 Table 4.2 and `ec2_durability.py`; the 10 mm `cMin` floor already covers small bars. (Note: the in-app reinforcement doc §10 actually documents `max(φ_bar, 6 mm)`, so if the floor is kept, the discrepancy is only against the standard/Python ref.)

### [STAGE6-ENGINEERING-B-01] medium · Dewatering rebuilds the full sublayer profile 66× per analysis
- **Location:** `src/lib/cpt-app/stage6-engineering.js:875-890` (`dewateringSettlementResponse`), `965-978`, `1059-1067`
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** `analyzeDewatering` calls `dewateringSettlementResponse` twice up front (conservative + realistic, lines 965/972) and then 31 more times inside the distance-curve loop (line 1065, `idx` 0..30). Each call to `dewateringSettlementResponse` runs `buildSublayerProfile` **twice** (before, line 877; after, line 884). That is 33 × 2 = 66 full profile builds per dewatering run, each O(maxDepth/dz × nLayers). With dz=0.1 and a deep CPT this is the dominant cost of the route and runs on the main thread. The conservative+realistic pair is also fully recomputed even when only one mode is displayed (`cptResponse` picks one at line 979-980), and the realistic one is only needed for the `modeSensitivityMm` note.
- **Recommendation:** Build the "before" profile once (it never depends on `newWtAtLocation`) and reuse it across all calls; for the distance loop, only the pore-pressure column changes with distance, so recompute `u`/`sigmaEff` per sample instead of rebuilding the geometry/γ profile. Optionally compute the realistic-mode response lazily only when the sensitivity note needs it.

### [STAGE6-ENGINEERING-B-02] low · Beam-on-foundation uses a dense O(n³) solver and dense matrix on a banded (bandwidth-4) system
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1188-1227` (`zeroMatrix`, `solveLinearSystem`), `1376-1397`
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** `solveBeamOnElasticFoundation` allocates a full dense `dof×dof` matrix via `zeroMatrix(dof)` (dof = 2·(nElem+1), default nElem≈120 ⇒ ~242) and solves with full-pivot Gaussian elimination (O(n³)). The Hermite beam stiffness is symmetric and banded with half-bandwidth 3, so a banded/Thomas-style solve is O(n) and the dense allocation is ~58k cells where ~1.5k are nonzero. It is run twice (SLS + ULS). n is small so wall-clock impact is modest, but it is dense-where-sparse and allocates per solve.
- **Recommendation:** Use a banded solver (the system is pentadiagonal-block); or at minimum a typed-array dense store instead of array-of-arrays. Not urgent given n≈242.

### [STAGE6-ENGINEERING-B-03] low · `solveLinearSystem` deep-copies the matrix as array-of-arrays per solve
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1192-1194`
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** `const A = matrix.map((row) => row.slice());` copies the entire dense n×n nested array on every solve (twice per beam analysis). Combined with B-02 this is the per-iteration allocation hot spot for the beam route. Bounded by the small n, so low severity.
- **Recommendation:** Solve in-place over a flat Float64Array, or skip the copy if the caller can tolerate matrix mutation.

### [STAGE6-ENGINEERING-C-01] high · In-app bearing doc claims a Meyerhof Nγ = (Nq−1)tan(1.4φ′); code uses EC7 Annex D 2(Nq−1)tanφ′
- **Location:** doc `src/routes/docs/engineering/bearing/+page.svelte:118-125`; code `src/lib/cpt-app/legacy-controller.js:12459-12463` (`stage6BearingNgamma`), `12392-12394` (`stage6BearingNgammaLabel`); confirmation `docs/logic.md:1495-1508`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** "the app uses the Meyerhof-style expression below and flags the choice in the output: Nγ,Meyerhof = (Nq − 1) tan(1.4 φ′)" (§2, lines 119-122), listing Vesić and EC7 Annex D only as "alternative/comparator". (2) **Code does:** `stage6BearingNgamma` returns `Math.max(0, 2*Math.max(Nq-1,0)*Math.tan(phiRad))` = `2(Nq−1)tanφ′`, and the in-app label/formula display says "EC7 Annex D rough base" (`stage6BearingNgammaLabel`, and live formula at legacy-controller.js:13114). (3) **Correct:** the **code** is internally consistent and matches `docs/logic.md:1501` (`Ngamma = 2*(Nq-1)*tan(phi')`) and EN 1997-1 Annex D.4 (rough base) Nγ = 2(Nq−1)tanφ′. The in-app doc §2 prose is wrong about which formula ships. (4) **Fix direction:** fix the doc (state Annex D 2(Nq−1)tanφ′ as the implemented form; demote the Meyerhof tan(1.4φ′) line to the comparator list). Numerically the difference is material — at φ′=30°, Meyerhof tan(1.4·30)=tan(42°)=0.90 vs Annex D form, giving Nγ values differing by tens of percent.

### [STAGE6-ENGINEERING-C-02] high · In-app bearing doc presents inclination factors as implemented (§4 main equation + full §7); code applies none
- **Location:** doc `src/routes/docs/engineering/bearing/+page.svelte:159` (§4), `252-291` (§7), contradicted by `377` (§11); code `src/lib/cpt-app/legacy-controller.js:12893`, `12928` (qult assembly has no i-terms); confirmation `docs/logic.md:1470-1491`, `1594`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** §4 main equation is `q_ult,d = c′Nc sc dc ic + q′Nq sq dq iq + 0.5 γ′ B′ Nγ sγ dγ iγ` and `q_ult,u = q + (π+2)cu scu dcu icu`, and §7 ("Inclination factors for horizontal load on the base") gives full closed forms for iq, iγ, ic, icu, m_B, m_L "The app uses it only when the engineer enters a non-zero horizontal action." (2) **Code does:** `qultDrained = cD*Nc*shp.sc*dep.dc + qDrain*Nq*shp.sq*dep.dq + 0.5*gammaEff*geo.BEff*Ng*shp.sg*dep.dg` and `qultUndrained = qUndrain + 5.14*cuD*undShp.scu*undDep.dcu` — **no inclination factors anywhere**, and there is no horizontal-load input field. A full-codebase grep for `iq`/`icu`/inclination in the bearing path returns nothing. (3) **Correct:** the **code** is right for its stated vertical-only scope; `docs/logic.md:1475` ("vertical load only, so H = 0 and no load-inclination factors") and the in-app §11 ("inclination... are not in the current route") both confirm. The in-app §4/§7 overstate the model and the page contradicts itself. (4) **Fix direction:** fix the doc — drop the i-terms from the §4 implemented equation (or clearly mark them as "set to 1.0 in the current route") and reframe §7 as "out of scope / future" to match §11 and logic.md.

### [STAGE6-ENGINEERING-C-03] medium · In-app bearing doc §8 describes a three-case Nγ water-table averaging the code does not do
- **Location:** doc `src/routes/docs/engineering/bearing/+page.svelte:293-329` (§8); code `src/lib/cpt-app/legacy-controller.js:12869` (`gammaEff`); confirmation `docs/logic.md:1465`, `1600`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** §8 gives three canonical cases for the Nγ-term effective unit weight, including a wedge-averaged case for `Df < z_w ≤ Df + B`: `γ′_B = γ(z_w−Df)/B + (γ_sat−γ_w)(Df+B−z_w)/B`. (2) **Code does:** a single founding-depth value `gammaEff = z <= S.wt ? l.g : Math.max((l.gs||l.g) − gammaW, 1.0)` — dry weight if the founding depth is above the WT, buoyant γ′ if below; no averaging over the failure wedge `[Df, Df+B]`. (3) **Correct:** for engineering rigor the doc's wedge averaging is the more defensible treatment, but the **code** is internally consistent and `docs/logic.md:1600` explicitly lists "the full three-case groundwater averaging rule for the 0.5*gamma'*B'*Ngamma term" as **not modelled**. So the in-app §8 overstates what ships. (4) **Fix direction:** fix the in-app doc to match logic.md (state single-point γ′ at founding depth, list wedge averaging as a known simplification) — or, if wedge averaging is desired, implement it in `bearingAtDepth` (this would be a code change, not part of this audit).

### [STAGE6-ENGINEERING-C-04] medium · In-app bearing doc §9 states "Belgian ANB γ_Rd uses 1.40"; code defaults γ_Rd = 1.00 and never auto-applies 1.40
- **Location:** doc `src/routes/docs/engineering/bearing/+page.svelte:347`; code default `src/lib/cpt-app/legacy-controller.js:4066` (`gammaRd:1.00`), UI note `legacy-controller.js:12847`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** §9 note "The Belgian ANB γ_Rd uses 1.40 for drained bearing on shallow footings; see NBN EN 1997-1 ANB Table A.NB.5." (2) **Code does:** `gammaRd` defaults to `1.00`; `stage6FactorValue` returns `max(cfg.gammaRd||1, 0.1)`; nothing applies 1.40 automatically (grep for 1.40 in the bearing path finds nothing), and the in-app UI note at legacy-controller.js:12847 tells the user "Leave it at 1.0 unless you intentionally want an extra correction for simplified analytical model bias." (3) **Correct:** the standard EN 1997-1 DA1 resistance factor for spread-foundation bearing is γR;v = 1.0 (R1), so a γ_Rd of 1.0 as the default is the defensible EC7 value; the doc's claim that ANB mandates 1.40 is at best a model factor and is not what the code applies. The two are inconsistent and a user could read §9 as "the tool already factors by 1.40" when it does not. (4) **Fix direction:** fix the doc to state that γ_Rd defaults to 1.0 (optional model factor, user-entered), and verify the 1.40/Table A.NB.5 citation before presenting it as a required value.

### [STAGE6-ENGINEERING-C-05] medium · Dewatering doc §7 long-trench flow drops the factor 1/2 (Q = k(h0²−hw²)·Lt/R); code correctly uses /2R
- **Location:** doc `src/routes/docs/engineering/dewatering/+page.svelte:281`; code `src/lib/cpt-app/stage6-engineering.js:845-848`, `854`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** §7 long-trench limit `Q = k (h0² − hw²) · (Lt/R)`. (2) **Code does:** `qPrime = Math.max(MFar - MWell, 0) / Math.max(R, 1e-6)` (unconfined), then `Q = qPrime * trenchLength`. For a homogeneous aquifer `MFar − MWell = ∫T dh = k(h0²−hw²)/2`, so the code yields `Q = Lt · k(h0²−hw²)/(2R)`. (3) **Correct:** the **code** is right — the 1D Dupuit linear-seepage discharge per unit length toward a drain at distance R is `q′ = k(h0²−hw²)/(2R)` (the ½ comes from integrating the parabolic free surface). The doc formula is high by a factor of 2. (4) **Fix direction:** fix the doc — insert the 1/2: `Q = k(h0²−hw²)·Lt/(2R)`.

### [STAGE6-ENGINEERING-C-06] low · Dewatering doc §7 short-trench equivalent radius (r_w,eq ≈ πL/2) is neither used by the code nor dimensionally consistent
- **Location:** doc `src/routes/docs/engineering/dewatering/+page.svelte:275-280`; code `src/lib/cpt-app/stage6-engineering.js:752-761` (`dewateringGeometry` trench branch), `837-873` (`drawdownCurveTrench`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** §7 "for short trenches... the equivalent radius r_w,eq of the trench is approximately π times the half-length divided by 2 ... r_w,eq ≈ π L / 2 (Dupuit form with L = trench half-length)". (2) **Code does:** the trench geometry branch sets `wellRadius: null` and never forms a `πL/2` equivalent radius; `drawdownCurveTrench` uses a linear-seepage `qPrime` model with a linear drawdown interpolation, not a radial Dupuit form. The `sqrt(A/π)` equivalent radius the code does use is for the **rectangular excavation** ("equivalent well"), not the trench. (3) **Correct:** the code's line-flow trench treatment is reasonable; the doc's `r_w,eq ≈ πL/2` claim describes a method the app does not run and is dimensionally odd as written. (4) **Fix direction:** fix the doc to describe the actual line-flow trench model (linear screening drawdown + transmissivity-moment q′), and remove or correct the πL/2 equivalent-radius claim.

### [STAGE6-ENGINEERING-C-07] low · Dewatering doc §6 says Sichardt C ≈ 2000 for trenches; code uses one `CSichardt` (default 3000) for all geometries
- **Location:** doc `src/routes/docs/engineering/dewatering/+page.svelte:255`; code `src/lib/cpt-app/stage6-engineering.js:957-958`, default `legacy-controller.js:4100` (`CSichardt:3000`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** "C ≈ 3000 (well) – 2000 (trench)". (2) **Code does:** `radiusInfluence = positive(config.CSichardt, 3000) * wellDrawdown * Math.sqrt(Math.max(effectiveK, 1e-12))` — a single user-supplied constant defaulting to 3000, applied identically to the radial and trench paths. There is no automatic switch to 2000 for the trench geometry. (3) **Correct:** Sichardt is explicitly a screening rule (both doc and code acknowledge this), so neither is "wrong" scientifically, but the doc implies an automatic geometry-dependent C the code does not provide. (4) **Fix direction:** fix the doc to say the single C is user-set (default 3000) and the engineer should lower it (~2000) for line/trench sources; or branch C by geometry in code.

### [STAGE6-ENGINEERING-C-08] low · Settlement doc §7 U(Tv) branch switch is stated at U=0.6; code switches at Tv=0.2 (U≈0.505)
- **Location:** doc `src/routes/docs/engineering/settlement/+page.svelte:283-284`; code `src/lib/cpt-app/stage6-engineering.js:263-267` (`consolidationDegree`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) **Doc says:** parabolic `U ≈ √(4Tv/π) for U < 0.6` and exponential `for U > 0.6`. (2) **Code does:** `if (Tv < 0.2) return √(4Tv/π); else return 1 − (8/π²)exp(−π²Tv/4)` — i.e., the switch is at Tv=0.2, which corresponds to U≈0.505, not 0.6. (3) **Correct:** both are accepted Terzaghi approximations; importantly the two formulas cross near Tv≈0.2 (parabolic 0.5046 vs exponential 0.5051 at Tv=0.2), so the **code's** switch point is the continuous crossover and is the cleaner choice — the doc's "U=0.6" boundary would introduce a small discontinuity. The numerical result is essentially unaffected. (4) **Fix direction:** fix the doc to state the switch at Tv≈0.2 (U≈0.5), matching the code's continuous transition.

### [STAGE6-ENGINEERING-D-01] low · Dead backward-compat alias `stage6ShapeFactors` exposed on the window API with no caller
- **Location:** `src/lib/cpt-app/legacy-controller.js:12455-12457` (alias), `18426` (window export)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `const stage6ShapeFactors = stage6BearingShapeFactors;` is documented as a "Backward-compatible alias for any external callers that still expect the old helper name" and is re-exported on the legacy window API. A grep across `src` and `tests` finds no reference other than the definition and the export itself — there is no external caller. FLAG ONLY.
- **Recommendation:** Confirm no runtime/window consumer depends on it, then remove the alias and its export.

### [STAGE6-ENGINEERING-D-02] info · Two near-identical `qult` assembly blocks in `bearingAtDepth` (EC7 branch vs global-SF branch)
- **Location:** `src/lib/cpt-app/legacy-controller.js:12884-12894` and `12919-12929`
- **Category:** D — Dead code (duplicate logic)
- **Confidence:** confirmed
- **Analysis:** The Nq/Nc/Ng/shape/depth/qultDrained/qultUndrained computation is duplicated verbatim between the `useEc7` map callback and the `else` (global SF) branch. Not dead, but duplicated logic that must be kept in lockstep — a future Nγ or shape-factor change would have to be applied in two places (a maintenance hazard given the C-01/C-02 doc drift already present). FLAG ONLY.
- **Recommendation:** Extract a single `computeBearingTerms(designedLayer, geo, z, factors)` helper used by both branches.

### [STAGE6-ENGINEERING-D-03] info · `nuAvg` computed in `averageSoilStiffness` but the caller overrides ν from `EsMode`, leaving the weighted average unused
- **Location:** `src/lib/cpt-app/stage6-engineering.js:1133-1138` (`nuSum`/`nuAvg`), `1156-1158` (caller recomputes `nu`)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `averageSoilStiffness` accumulates `nuSum` and returns `nuAvg`, but `computeSubgradeReaction` destructures `{ EsAvg, nuAvg }` and then immediately defines its own `const nu = config.EsMode === 'young_drained' ? 0.30 : 0.0;` and uses that everywhere (Gs, ks), and even returns `nuAvg: nu` (the recomputed scalar) rather than the weighted `nuAvg`. The depth-weighted `nuAvg` is effectively dead. Harmless (the per-segment ν is constant anyway), but the accumulation and return value are misleading. FLAG ONLY.
- **Recommendation:** Drop `nuSum`/`nuAvg` from `averageSoilStiffness`, or actually consume the weighted value instead of recomputing `nu` in the caller.

## Notes / limitations of this audit pass
- The bearing-capacity engine lives in `legacy-controller.js` (an 18k-line file), not in `stage6-engineering.js` as the brief implied; I located and read the full bearing block (~12343-13160) plus defaults, but did not exhaustively read the rest of that file, so cross-cutting state (`S.wt`, `S.stage6`) wiring was only spot-checked.
- I verified the Fadum corner-influence factor (`rectCornerInfluenceFactor`) algebraically against the standard form including the quadrant correction for V<V1 — it is correct; the in-app settlement doc §3 shows a different-but-equivalent algebraic arrangement (simpler atan argument valid only when m²n²<m²+n²+1), which I treated as an acceptable doc simplification, not a finding.
- I did not execute `scripts/ec2_durability.py` or the JS to numerically diff cover values; the cross-check was by reading. The Table 4.4N matrix, exposure-column map, XF/XA fallbacks, structural-class thresholds, and rounding all match between the JS `ec2DurabilityCover`/`ec2StructuralClass` and the Python reference.
- The EN 1990 ψ factors (PSI_FACTORS) and the SLS/ULS combination algebra (qp/frequent/characteristic, Eq.6.10 A1/A2) were checked against EN 1990 Table A1.1/A1.2 and are correct.
- γ_Rd ANB = 1.40 (C-04): I could not verify NBN EN 1997-1 ANB Table A.NB.5 directly; I flagged the doc/code inconsistency and noted that standard EN 1997-1 DA1 uses γR;v=1.0. A standards specialist should confirm the correct Belgian value before either side is changed.
- A second pass focused on the beam/Pasternak boundary conditions (the system appears to be solved with free ends — no Dirichlet BCs applied — which is physically valid for a free Winkler beam but means the global stiffness is non-singular only because of the soil springs; worth confirming `kLine>0` is always guaranteed before `solveLinearSystem` to avoid the "singular matrix" throw on zero-stiffness soil).
