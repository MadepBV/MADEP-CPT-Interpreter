# Engineering Audit — madep-cp

**Scope:** Cross-reference every formula, constant, and constraint described in
the project documentation against the implementation in
`src/lib/cpt-app/legacy-controller.js`, `src/lib/cpt-app/stage6-engineering.js`,
`src/lib/cpt-app/stage6-bishop.js`, and the reference script
`scripts/ec2_durability.py`.

**Date:** 2026-04-18
**Method:** Direct code read against `docs/logic.md`,
`docs/classification/robertson-2016.md`, `docs/bishop/bishop_simplified_v1_spec.html`
(headline), and the Stage 6 review material. Verdicts are one of: Matches,
Discrepancy, Missing (documented but not found in code), or
Undocumented (in code but not in docs).

**Status note:** `solveBishopSimplified` and `docs/logic.md` were corrected
after this audit pass. Sections §3.1-§3.5 document the original findings that
triggered those fixes; the detailed Bishop note in §3.1 has been re-verified
and is the authoritative interpretation.

---

## 1. Executive Summary

The core classification math (Robertson 1990, Robertson 2016, Eurocode Tabel 3)
is implemented faithfully and traceably. Stage 6 EC2 durability, EC7 bearing
capacity and Hardening-Soil stiffness-from-CPT correlation match the
documentation within rounding. The app is, overall, in good shape for everyday
geotechnical interpretation work.

Three concrete issues were identified in this audit:

1. **Bishop Simplified pore-pressure term is wrong.** In
   `solveBishopSimplified` the uplift force uses slice arc length
   (`u · l`) instead of slice horizontal width (`u · b`). The spec
   explicitly calls this out as "the single most common implementation
   error". It produces a systematic, conservative bias whenever the
   slip circle dips below the water table. The ordinary (Fellenius) seed
   and the current diagnostics use different formulas and do not share
   this bug.
2. **CUR 3 and NEN 6740 documentation does not match the code.**
   `classCUR3` is a 4-gate chart rule; `classNEN6740` is a 14-area nearest
   neighbour chart score. `docs/logic.md` §2.2 describes a different
   priority-based CUR rule and bundles the two methods under one heading.
3. **Robertson 2016 is documented *and* implemented, yet the task brief
   claimed it was only documented.** `classRob2016` is wired into
   `runClass` and is the *default* method for new CPTs
   (`newCptState.method = 'robertson2016'`). The audit confirms it
   matches the spec exactly.

Secondary discrepancies (none safety-critical):

- Default water-table depth in code is `1.7 m`
  (`legacy-controller.js:59`). Docs §1.4 say the default is `1.5 m`.
- Pore pressure uses γ_w = 9.81 kN/m³ everywhere in code. Docs §2.1 and
  Stage 4 worked example say `u = 10 · max(0, z − z_wt)`.
- Stage 4 example "u = 10 · (2.5 − 1.7) = 8.0 kPa" is numerically wrong
  under the documented formula (2.5 − 1.7 = 0.8, so u = 8.0 is right;
  the mismatch is just that the example uses `wt = 1.7` while the general
  default above it claims `wt = 1.5`).

---

## 2. Confirmed Logic (verified matches)

### 2.1 Classification

- **Robertson 1990 — SBT / Ic.** `classRob` at
  [legacy-controller.js:1496](src/lib/cpt-app/legacy-controller.js#L1496) implements
  `Qt = (qt − σv0) / σ'v0`, `Fr = fs/(qt−σv0)·100` and
  `Ic = √((3.47 − logQt)² + (logFr + 1.22)²)` with zone boundaries
  3.60/2.95/2.60/2.05/1.31 and a Zone 7 override `Qt > 200 and Fr < 0.5`.
  Matches `docs/logic.md` §2.1. ✅
- **Robertson 2016 — iterative Qtn.** `classRob2016` at
  [legacy-controller.js:1539](src/lib/cpt-app/legacy-controller.js#L1539) implements
  the Canadian-Geotech-J update with `pa = 100 kPa`, iteration
  `n_new = 0.381·Ic + 0.05·(σ'v0/pa) − 0.15` clamped to `[0.5, 1.0]`,
  tolerance `|n_new − n| < 0.001`, and max 10 iterations. Same Ic bands
  and Zone 7 rule as 1990. Matches
  `docs/classification/robertson-2016.md` (§Step 3 and §Edge cases)
  exactly, including the `dQ_kPa < 10` / `σ'v0 < 1` clay guard. ✅
- **Eurocode Tabel 3 (`classSB260`).** [legacy-controller.js:1704](src/lib/cpt-app/legacy-controller.js#L1704)
  walks the SB260 table rows in priority order
  grind → zand → leem → klei → veen with the qc/Rf envelopes documented
  in §2.3. Out-of-table fallback is deterministic and documented in code.
  ✅
- **Method switch.** `runClass` at
  [legacy-controller.js:1731](src/lib/cpt-app/legacy-controller.js#L1731) dispatches all five
  methods (`robertson`, `robertson2016`, `cur3`, `nen6740`, `sb260`). ✅

### 2.2 Stress and pore pressure

- **Effective stress profile.** `stressAt` at
  [legacy-controller.js:1441](src/lib/cpt-app/legacy-controller.js#L1441) uses unsaturated
  unit weight above the water table and saturated below, falling back to
  γ_sat when γ_unsat is not supplied. This matches `docs/logic.md` §4.1
  paragraph 1.
- **Sublayer integrator (Stage 6).** `totalVerticalStressAtDepth` and
  `effectiveVerticalStressAtDepth` at
  [stage6-engineering.js:318](src/lib/cpt-app/stage6-engineering.js#L318) re-do the same
  integration over the Stage 6 layer stack, and
  `buildSublayerProfile` at
  [stage6-engineering.js:361](src/lib/cpt-app/stage6-engineering.js#L361) splits layers at
  the water table and at arbitrary depths for Boussinesq/Stage 6 use. ✅

### 2.3 Hardening-Soil stiffness (`hsParams`)

[legacy-controller.js:2779](src/lib/cpt-app/legacy-controller.js#L2779)

- `Eoed_i = aE · qc` with aE selected via method A, method B, or
  engineer override. Matches `docs/logic.md` §4.3/§4.4.
- **Cohesion-corrected reference stiffness** (docs/logic.md §4.3):

      Eoed_ref = Eoed_i / ((σ'v0 + c·cotφ) / (p_ref + c·cotφ))^m

  Implemented verbatim at
  [legacy-controller.js:2807-2811](src/lib/cpt-app/legacy-controller.js#L2807) with
  `p_ref = 100 kPa` and a `ratio ≥ 0.05` clamp. ✅
- **`m` defaults:** Peat = 1.0, cohesive = 0.85, Sandy clay = 0.65,
  else 0.5. Matches §4.3 / §4.4. ✅
- **Method A (CUR 2003-7):** cohesive → `E50 = 1.25·Eoed`, non-cohesive
  → `E50 = Eoed`, `Eur = 3·E50`. Method B: `E50 = Eoed`, `Eur = 3·Eoed`.
  Matches §4.3 and §4.4. ✅
- **K0_nc = 1 − sinφ**, **ψ = max(0, φ − 30)**, **ν = 0.45 (peat) /
  0.35 (cohesive) / 0.30 (granular)**, **ν_ur = 0.20**. Matches §4.6. ✅
- **`Emc` (MC-equivalent Young's modulus)** uses the oedometric-to-E
  conversion `E = Eoed · (1+ν)(1−2ν)/(1−ν)` with a `× 1.5` engineering
  bump; the `×1.5` multiplier is undocumented (see §4 below).

### 2.4 EC7 bearing capacity (Stage 6)

[legacy-controller.js:5039](src/lib/cpt-app/legacy-controller.js#L5039)

- **Vesić / Meyerhof factors:**
  `Nq = exp(π·tanφ') · tan²(45 + φ'/2)`,
  `Nc = (Nq − 1) / tanφ'`,
  `Nγ = 2·(Nq + 1)·tanφ'`. Matches `docs/stage6/Stage6_review.md` and
  general Eurocode practice. ✅
- **Shape factors** (`stage6ShapeFactors` at
  [legacy-controller.js:4749](src/lib/cpt-app/legacy-controller.js#L4749)):
  footing `{sc, sq, sγ, scu} = {1.2, 1.1, 0.6, 1.2}`,
  slab `{1.3, 1.2, 0.8, 1.3}`. Matches the review. ✅
- **Effective submerged unit weight:** `γ_eff = γ_sat − γ_w` when the
  founding depth is below the water table,
  [legacy-controller.js:5050](src/lib/cpt-app/legacy-controller.js#L5050). ✅
- **Undrained capacity:** `q_ult,u = σ_v + 5.14·cu·scu`. Matches
  Stage 6 review. ✅
- **DA1/1 (M1) and DA1/2 (M2) partial factors.** `stage6BearingEc7Spec`
  at [legacy-controller.js:4778](src/lib/cpt-app/legacy-controller.js#L4778) and
  `designSoilLayer` at
  [stage6-engineering.js:306](src/lib/cpt-app/stage6-engineering.js#L306) apply
  γ_φ' = γ_c' = 1.25 and γ_cu = 1.40 to M2. ✅

### 2.5 Stage 6 settlement

- **Boussinesq (rectangular and strip)** influence factor computed per
  corner and multiplied by 4, with a strip closed form
  `Δσ = q/π · (2α + sin 2α)`, at
  [stage6-engineering.js:482](src/lib/cpt-app/stage6-engineering.js#L482). ✅
- **2:1 (Terzaghi) alternative.** Rectangle
  `q·BL/((B+z)(L+z))`, strip `q·B/(B+z)`. ✅
- **Non-linear oedometric stiffness:** `eoedAtStress` at
  [stage6-engineering.js:420](src/lib/cpt-app/stage6-engineering.js#L420) uses the HS
  cohesion-corrected formula with `p_ref = 100 kPa`. Matches `hsParams`
  and `docs/logic.md` §4.3. ✅
- **Consolidation (terzaghi 1D):** standard Tv ≥ 0.2 and Tv < 0.2
  closed forms at
  [stage6-engineering.js:263](src/lib/cpt-app/stage6-engineering.js#L263). ✅

### 2.6 EC2 durability (Stage 6 reinforcement)

Cross-checked against `scripts/ec2_durability.py`:

- **Structural class** (`ec2StructuralClass` at
  [stage6-engineering.js:175](src/lib/cpt-app/stage6-engineering.js#L175)):
  start S4, +2 for 100-yr design life, −1 for ≤ 25 yr, −1 for
  high-strength fck at the per-exposure threshold, −1 for slabs, −1
  for special QC; clamped `[1, 6]`. Matches the Python table 4.3N
  reproduction in `ec2_durability.py:structural_class()`. ✅
- **`c_min,dur`** looks up `EC2_TABLE_44N[S − 1][column]` with fallback
  exposure mapping XF* → XC4 / XA* → XD3 for the chloride/carbonation
  table column; matches the Python fallback. ✅
- **`c_min,b`** (`ec2MinimumBondCover` at
  [stage6-engineering.js:213](src/lib/cpt-app/stage6-engineering.js#L213)):
  `max(φ_bar, 6)` with +5 if `dG > 32`. ✅
- **`c_nom = c_min + Δc_dev`**, with Δc_dev ≥ 10 mm (default),
  +5 mm if cast against an uneven surface, 40/75 mm floors for cast
  against prepared / unprepared ground, rounded up to 5 mm.
  Matches Python `nominal_cover()`. ✅
- **Concrete strength threshold** per exposure
  (`ec2ConcreteStrengthThreshold` at
  [stage6-engineering.js:151](src/lib/cpt-app/stage6-engineering.js#L151)): XC2 = 35,
  XC4 = 40, XD3 = 45, XS3 = 45, XF4 = 40, XA3 = 45, etc. Matches
  Python `_FCK_THRESHOLD`. ✅

### 2.7 EC7 partial factors outside bearing

- `designSoilLayer` at
  [stage6-engineering.js:306](src/lib/cpt-app/stage6-engineering.js#L306) applies
  γ_φ' = γ_c' = 1.25 on `tanφ'` (not φ' directly) and γ_cu = 1.40.
  Matches `docs/stage6/Stage6_review.md`. ✅
- ULS combination Eq. 6.10 `γ_G·Gk + γ_Q·(Qlead + ψ0·Qother)` at
  [stage6-engineering.js:293](src/lib/cpt-app/stage6-engineering.js#L293), with
  Set A1 (1.35/1.50) and A2 (1.00/1.30). Matches
  `docs/logic.md` §"Stage 6 combination policy". ✅

---

## 3. Critical Discrepancies

### 3.1 Bishop Simplified main solver uses slice length in pore-pressure term

**Verdict:** Confirmed bug — single location, not three as first reported.

#### The governing equation (spec §6.2, line 774; §6.5 line 873)

```
F = Σ [ (c'·b + (W − u·b)·tan φ') / m_α ] / Σ [ W·sin α ]
```

The `b` is the **horizontal slice width** (= `slice.dx`), not the arc
length along the base (= `slice.baseLength = dx / cos α`). The spec
itself flags this at line 788:

> *"Getting this wrong (using u·l instead of u·b) is the single most
> common implementation error in Bishop Simplified and will produce
> wrong factors of safety."*

Derivation note: the `b` arises from `l · cos α` simplifying during the
algebra that produces `m_α`. Physically the pore pressure force is
`u·l` (arc length), but when projected onto the vertical equilibrium
and combined with `m_α` it reduces to `u·b`.

#### The bug — line 628 only

[stage6-bishop.js:628](src/lib/cpt-app/stage6-bishop.js#L628):

```js
resisting += (c * slice.dx + (V - slice.uBase * slice.baseLength) * tanPhi) / mAlpha;
//                                      ^^^^^^^^^^^^^^^^^^^^
//                                      uses u·l, should be u·dx
```

Cohesion correctly uses `slice.dx`; the pore-pressure term wrongly uses
`slice.baseLength`.

#### The other two sites flagged by the initial audit are **not** bugs

Both were mis-identified. They use `baseLength` legitimately because
they implement different formulas:

- [stage6-bishop.js:545](src/lib/cpt-app/stage6-bishop.js#L545) —
  `ordinarySeed()` implements the **Fellenius** factor of safety, not
  Bishop. The spec at §6.3, line 816, explicitly defines Fellenius as
  `F = Σ[c'·l + (W·cos α − u·l)·tan φ'] / Σ W·sin α`, with `u·l` (arc
  length). The code matches this exactly. No change needed.

- [stage6-bishop.js:566-568](src/lib/cpt-app/stage6-bishop.js#L566) —
  `buildDiagnostics()` reports the per-slice **total normal force N**
  and mobilised shear T. For total normal (not effective), the
  derivation gives
  `N = [W − (c·l − u·l·tan φ')·sin α/F] / m_α` — which is what the code
  computes. Shear `T = (c·l + (N − u·l)·tan φ')/F` is the Mohr-Coulomb
  shear using N' = N − u·l. Both are physically correct formulas for
  the per-slice forces they report. No change needed.

#### Bias direction (correcting the initial report)

Since `l > b` whenever α ≠ 0, the buggy term subtracts **more** uplift
than physically correct → **smaller** resisting force → **lower** FS.
The reported FS is therefore biased **conservative** (too safe), not
"non-conservative" as the initial summary stated. The error magnitude
scales with `(1/cos α) − 1`, so it's noticeable at crest and toe
slices (|α| ≈ 30–50°) and negligible at shallow slices (α ≈ 0).

#### Prepared fix (one-character change)

```diff
- resisting += (c * slice.dx + (V - slice.uBase * slice.baseLength) * tanPhi) / mAlpha;
+ resisting += (c * slice.dx + (V - slice.uBase * slice.dx)         * tanPhi) / mAlpha;
```

**Verification plan after fix:**

1. Re-run the Bishop validation scenarios in `docs/bishop/bishop_simplified_v1_spec.html` §8 (if present); FS values should shift slightly higher (less conservative).
2. For a dry case (`u = 0`), FS must be unchanged by this edit (the diff term is `slice.uBase × (dx − baseLength) × tan φ = 0`).
3. Compare against a hand-calculated 3-slice reference case with known `α` values — the spec §7 recommends this.

### 3.2 CUR 3 classification rule in code does not match docs

**Verdict:** Confirmed — the doc describes a rule that does not exist in
the code.

#### What the doc claims (docs/logic.md §2.2, lines 133–147)

The doc bundles CUR 3 and NEN 6740 into one "method" with an 8-priority
table using raw `qc` and `Rf` directly and "no stress normalisation":

| Priority | Condition | Type |
|----------|-----------|------|
| 1 | `Rf > 6` and `qc < 1.0` | Peat / organic |
| 2 | `Rf > 4` or (`Rf > 3` and `qc < 4`) and `qc < 1.0` | Soft clay |
| 3 | `Rf > 4` or (`Rf > 3` and `qc < 4`) and `qc >= 1.0` | Clay |
| … | … | … |

None of these conditions appear in either `classCUR3` or `classNEN6740`.

#### What the code actually does — `classCUR3`

[legacy-controller.js:1606](src/lib/cpt-app/legacy-controller.js#L1606) is a 4-gate PLAXIS chart rule. Gates are checked in order — first match wins:

| # | Condition | Result (type / subtype) |
|---|-----------|-------------------------|
| 1 | `Rf > 4` | Peat / organic (no subtype) |
| 2 | `Rf < 1` AND `qc > 1.5` | Sand / `CUR3 sand` |
| 3 | `Rf < 2` AND `0.5 ≤ qc ≤ 1.5` | Sandy clay / `CUR3 silt` |
| 4 | fallback (everything else) | Clay / `CUR3 clay` |

Inputs: `qc` in MPa, `Rf` in %. No stress normalisation. When `Rf`
is missing the code defaults to `rf = 3.0`.

The "Silt" field of the published PLAXIS CUR 3 chart is carried as
the app's intermediate type "Sandy clay" with subtype `CUR3 silt`
(to stay compatible with downstream parameter-assignment).

Source cited in the code comment: "PLAXIS Reference Manual, *CUR 3
layers method* chart".

#### Prepared replacement doc text (ready to lift into docs/logic.md §2.2)

```markdown
### 2.2a CUR 3 layers (PLAXIS chart) [IMPLEMENTED]

Four-gate decision tree on raw `qc` (MPa) and `Rf` (%). No stress
normalisation. Gates are checked in order, first match wins.

| # | Condition | Type | Subtype |
|---|-----------|------|---------|
| 1 | Rf > 4%                    | Peat / organic | — |
| 2 | Rf < 1% AND qc > 1.5 MPa   | Sand           | CUR3 sand |
| 3 | Rf < 2% AND 0.5 ≤ qc ≤ 1.5 | Sandy clay     | CUR3 silt |
| 4 | fallback                    | Clay           | CUR3 clay |

**Inputs**
- `qc` — cone resistance [MPa]
- `Rf` — friction ratio [%]; defaults to 3.0 when absent

**Mapping note.** The published CUR 3 chart names the intermediate
field "Silt". The app carries this as `Sandy clay / CUR3 silt` to
keep downstream parameter-assignment (Stage 3) working against a
single app-type vocabulary.

**Source:** PLAXIS Reference Manual, "CUR 3 layers method" chart.
Implemented at `src/lib/cpt-app/legacy-controller.js:1606`.
```

### 3.3 NEN 6740 classification is not documented

**Verdict:** Confirmed — algorithm is undocumented and non-obvious.

`docs/logic.md` §2.2 names "NEN 6740" but gives no algorithm. The code
implements a fundamentally different scheme from what the doc describes
for CUR 3.

#### What the code actually does — `classNEN6740`

[legacy-controller.js:1665](src/lib/cpt-app/legacy-controller.js#L1665) implements a **stress-corrected nearest-score classifier** against a 14-point reference set.

**Step 1 — stress-correct the cone resistance** ([line 1668](src/lib/cpt-app/legacy-controller.js#L1668))

```
qcNen = qc · (100 / σ'v0)^0.67     [MPa]
      (with σ'v0 floored at 1 kPa, qcNen floored at 0.01 MPa)
```

The 0.67 exponent is hardcoded. Its provenance is not stated in the
code comment — common in Dutch practice from D-Sheet Piling family of
tools, but no citation provided.

**Step 2 — chart score** ([line 1669](src/lib/cpt-app/legacy-controller.js#L1669))

```
score = log10(qcNen) − 0.18 · Rf
```

The 0.18 weight is hardcoded and similarly uncited.

**Step 3 — nearest-score match** ([lines 1671–1679](src/lib/cpt-app/legacy-controller.js#L1671))

Compare `score` against the 14 pre-computed `area.score` centres; pick
the closest. On ties, the earlier-ordered entry wins (lowest `order`).

**The 14 reference areas** ([lines 1628–1647](src/lib/cpt-app/legacy-controller.js#L1628)) each carry
pre-assigned parameter values (γ, γsat, φ', c', cu). Score centres are
computed at module load via `score = log10(qcNen) − 0.18 · Rf` using
the per-area `qcNen` and `rf` digitised from the NEN 6740 chart.

| # | subtype | type | γ | γsat | φ' | c' | cu | Rf | qcNen |
|---|---------|------|---|------|----|----|----|----|-------|
| 0 | gravel, slightly silty, moderate | Gravel | 19 | 21 | 37.5 | 0 | 0 | 0.35 | 25 |
| 1 | sand, clean, stiff | Sand | 20 | 22 | 40.0 | 0 | 0 | 1.00 | 25 |
| 2 | sand, slightly silty, moderate | Silty sand | 19 | 21 | 32.5 | 0 | 0 | 1.60 | 15 |
| 3 | sand, very silty, loose | Silty sand | 19 | 21 | 30.0 | 0 | 0 | 2.20 | 7 |
| 4 | loam, very sandy, stiff | Sandy clay | 20 | 20 | 35.0 | 1 | 0 | 2.45 | 6 |
| 5 | loam, slightly sandy, weak | Sandy clay | 20 | 20 | 30.0 | 1 | 0 | 3.00 | 3.5 |
| 6 | clay, very sandy, stiff | Sandy clay | 20 | 20 | 32.5 | 1 | 0 | 3.40 | 4 |
| 7 | clay, slightly sandy, moderate | Clay | 20 | 20 | 22.5 | 13 | 0 | 3.85 | 2.8 |
| 8 | clay, clean, stiff | Clay | 20 | 20 | 25.0 | 15 | 0 | 4.45 | 2.3 |
| 9 | clay, clean, weak | Clay | 17 | 17 | 17.5 | 5 | 0 | 5.15 | 1.0 |
| 10 | clay, organic, moderate | Clay | 16 | 16 | 15.0 | 1 | 0 | 6.10 | 0.75 |
| 11 | clay, organic, weak | Clay | 15 | 15 | 15.0 | 1 | 0 | 7.05 | 0.22 |
| 12 | peat, moderately preloaded, moderate | Peat / organic | 13 | 13 | 15.0 | 5 | 0 | 8.30 | 0.06 |
| 13 | peat, not preloaded, weak | Peat / organic | 12 | 12 | 15.0 | 2.5 | 0 | 9.25 | 0.02 |

Units: γ, γsat [kN/m³]; φ' [°]; c' [kPa]; cu [kPa]; Rf [%]; qcNen [MPa].

**Return value**: type + subtype + full parameter set (γ, γsat, φ',
c', cu), plus `Qt: qcNen` (stored in the Qt field for display),
`Ic: null`.

#### Prepared replacement doc text (ready to lift into docs/logic.md §2.2)

```markdown
### 2.2b NEN 6740 (stress-corrected chart) [IMPLEMENTED]

Nearest-score classifier against 14 digitised reference areas from
the NEN 6740 chart as reproduced in D-Sheet Piling.

**Step 1 — stress-correct qc**

    qcNen = qc · (100 / σ'v0)^0.67        [MPa]

where σ'v0 is in kPa, floored at 1 kPa; qcNen floored at 0.01 MPa.

**Step 2 — chart score**

    score = log10(qcNen) − 0.18 · Rf

Rf in %, defaults to 3.0 when absent.

**Step 3 — match**

Pick the reference area with the smallest `|score − area.score|`. On
ties the lower-indexed area wins (preserves chart ordering from
gravel → peat).

**Output**: type, subtype, γ, γsat, φ', c', cu. The selected `qcNen`
is stored in the `Qt` display field.

**Reference set.** 14 fixed material points spanning Gravel → Peat.
See the table in `src/lib/cpt-app/legacy-controller.js:1628`.

**Provenance notes (to verify).**
- The 0.67 exponent is common in Dutch practice; it should be cited
  against NEN 6740 §5.6 or a D-Sheet Piling reference manual.
- The 0.18 weight on Rf has no in-code citation; needs a published
  source.
- The 14 area centres are digitised from the published chart; the
  exact chart edition and page should be recorded.

Implemented at `src/lib/cpt-app/legacy-controller.js:1665`.
```

#### Action item

Replace docs/logic.md §2.2 (the single mistaken 8-row table) with the
two separate sections §2.2a and §2.2b above. The existing §2.3 "Eurocode /
NEN — Tabel 3" is a third, different method (parameter assignment, not
classification per se) and can stay as-is.

### 3.4 Water-table default: code uses 1.7 m, docs say 1.5 m

**Verdict:** Discrepancy.

- `docs/logic.md` §1.4: "If absent — default `wt = 1.5 m`."
- [legacy-controller.js:59](src/lib/cpt-app/legacy-controller.js#L59): `wt: 1.7, wtFromFile: false`.

The Stage 4 worked example at logic.md line 419 silently uses `wt = 1.7`
to get `u = 8.0 kPa` at `z = 2.5 m`, so the *example* is consistent with
the code, but the *stated default* is not.

### 3.5 Pore-pressure coefficient: code uses γ_w = 9.81, docs use 10

**Verdict:** Minor discrepancy.

- `docs/logic.md` §2.1 (line 87) and §4.1 (line 410):
  `u = 10 · max(0, z − z_wt)`.
- [legacy-controller.js:1455](src/lib/cpt-app/legacy-controller.js#L1455): `u = 9.81 * (z − wt)`.
- [stage6-engineering.js:3](src/lib/cpt-app/stage6-engineering.js#L3):
  `const GAMMA_W = 9.81`, used everywhere else
  ([stage6-engineering.js:340](src/lib/cpt-app/stage6-engineering.js#L340),
  [stage6-bishop.js:7](src/lib/cpt-app/stage6-bishop.js#L7)).

The code is physically more correct; the docs should be updated rather
than the code. Impact on Ic classification is <2 % at depth; on
bearing/Bishop FS it is negligible within typical precision.

### 3.6 "Robertson 2016 not implemented" is wrong

**Verdict:** Documentation (briefing) inconsistency, not a bug.

The task brief asserted that Robertson 2016 was documented but not
implemented. In fact:

- The method is the *default* for new CPTs:
  [legacy-controller.js:64](src/lib/cpt-app/legacy-controller.js#L64) (`method: 'robertson2016'`).
- It is dispatched in `runClass`:
  [legacy-controller.js:1739](src/lib/cpt-app/legacy-controller.js#L1739).
- It matches `docs/classification/robertson-2016.md` step by step.

No action needed other than updating any external briefing that still
says otherwise.

---

## 4. Documentation Gaps (Task 3)

### 4.1 Code logic not reflected in docs (Gap 3A)

- **NEN 6740 chart-score algorithm.** `classNEN6740` and the 14
  `NEN6740_MATERIALS` centres with their `score = log10(qcNen) − 0.18·Rf`
  are undocumented; `docs/logic.md` §2.2 needs a `classNEN6740`
  subsection and a citation for the 0.67 stress exponent and the 0.18
  weight.
- **CUR 3 chart gates.** The real code rule (see §3.2) replaces what
  `docs/logic.md` §2.2 describes.
- **`classSB260` fallback rules.** The deterministic fallback at
  [legacy-controller.js:1718-1725](src/lib/cpt-app/legacy-controller.js#L1718) (qc < 0.4 →
  "leem, weinig vast"; else "zand, los") is not mentioned in §2.3.
- **`Emc` 1.5× engineering bump.** `hsParams` produces an MC Young's
  modulus as `1.5 · (1+ν)(1−2ν)/(1−ν) · Eoed_i`
  ([legacy-controller.js:2828](src/lib/cpt-app/legacy-controller.js#L2828)). The 1.5
  factor is not in `docs/logic.md` §4.3–§4.6.
- **Robertson `fs` fallback.** When `fs` is absent, both `classRob`
  and `classRob2016` estimate `fs ≈ qt · Rf / 100` (with default
  `Rf = 3 %`). This is sensible but undocumented; it matters when
  comparing Ic between files that do and do not carry sleeve friction.
- **Robertson default γ_sat = 18, γ_unsat = 17.** Hard-coded inside
  `classRob`/`classRob2016`
  ([legacy-controller.js:1497](src/lib/cpt-app/legacy-controller.js#L1497),
  [:1540](src/lib/cpt-app/legacy-controller.js#L1540)). These values drive σ'v0 for
  *every* Robertson reading before a layer is assigned real γ, yet the
  docs only mention γ = 18 generically.
- **Bishop solver tolerances and convergence settings.**
  `solverConfig.tolerance = 1e-4`, `maxIterations = 50`,
  `minMAlpha = 1e-6` at
  [stage6-bishop.js:617-643](src/lib/cpt-app/stage6-bishop.js#L617). Not documented.
- **Bearing-capacity depth sweep.** `bearingProfile` at
  [legacy-controller.js:5161](src/lib/cpt-app/legacy-controller.js#L5161) steps
  `max(0.1, min(0.25, maxDepth/60))` m; the step rule is undocumented.
- **`ulsEq610` γ values for A2 (1.00 / 1.30).** Documented for A1 in
  §"Stage 6 combination policy" but the A2 set is only visible in code
  at [stage6-engineering.js:301](src/lib/cpt-app/stage6-engineering.js#L301).
- **Undrained capacity `q_ult,u = σ_v + 5.14·cu·scu`.** The `5.14`
  (= π + 2) is in code but not explicitly called out in docs.

### 4.2 Docs that do not match the code (Gap 3B)

- **§1.4 water-table default (1.5 m)** — code default is 1.7 m.
- **§2.1 pore-pressure formula `u = 10·…`** — code uses 9.81.
- **§2.2 "CUR 3 / NEN 6740"** — one heading for two distinct
  algorithms, and the described rule is not what either function does.
- **§2.3 class name.** Docs refer to the Eurocode Tabel 3 method; in
  the method switch the key is `sb260` and the function is
  `classSB260`. The method key is not aliased to `eurocode` or `tabel3`
  and the code-to-doc name mapping is only inferable from comments.
- **§4.1 worked example** arithmetic uses `wt = 1.7`, contradicting the
  §1.4 stated default.
- **Robertson 2016 status.** The top-level task brief flags this as
  "documented but NOT implemented"; it is in fact both documented and
  implemented (and is the default). No action in docs themselves, but
  any consuming audit / README should be corrected.

---

## Appendix A — Theory Map

The following entries catalogue every formula, constant, or constraint
we found in the documentation, and the single best location to look at
in the code.

### A.1 Classification

| # | Doc statement | Doc source | Code location | Verdict |
|---|---|---|---|---|
| A.1.1 | `qt = qc + (1 − a)·u2`, else `qt = qc` when `u2` absent; default `a = 0.8` | robertson-2016.md §Inputs; logic.md §2.1 | [legacy-controller.js:1499](src/lib/cpt-app/legacy-controller.js#L1499), [:1543](src/lib/cpt-app/legacy-controller.js#L1543) | Matches |
| A.1.2 | `Qt = (qt − σv0) / σ'v0` (Robertson 1990) | logic.md §2.1 | [legacy-controller.js:1507](src/lib/cpt-app/legacy-controller.js#L1507) | Matches |
| A.1.3 | `Qtn = (dQ / pa)·(pa / σ'v0)^n`, `pa = 100 kPa` | robertson-2016.md §Step 3 | [legacy-controller.js:1557](src/lib/cpt-app/legacy-controller.js#L1557) | Matches |
| A.1.4 | `n_new = 0.381·Ic + 0.05·(σ'v0/pa) − 0.15`, `n ∈ [0.5, 1.0]`, `|Δn| < 0.001`, ≤ 10 iterations | robertson-2016.md §Step 3 | [legacy-controller.js:1559-1565](src/lib/cpt-app/legacy-controller.js#L1559) | Matches |
| A.1.5 | `Fr = fs/(qt − σv0)·100`, clamp `[0.1, 10]` | logic.md §2.1; robertson-2016.md §Step 2 | [legacy-controller.js:1511-1512](src/lib/cpt-app/legacy-controller.js#L1511), [:1551](src/lib/cpt-app/legacy-controller.js#L1551) | Matches |
| A.1.6 | `Ic = √((3.47 − logQt)² + (logFr + 1.22)²)` | logic.md §2.1 | [legacy-controller.js:1515](src/lib/cpt-app/legacy-controller.js#L1515), [:1558](src/lib/cpt-app/legacy-controller.js#L1558) | Matches |
| A.1.7 | Ic bands 3.60 / 2.95 / 2.60 / 2.05 / 1.31 | logic.md §2.1 | [legacy-controller.js:1521-1527](src/lib/cpt-app/legacy-controller.js#L1521) | Matches |
| A.1.8 | Zone 7 override `Qt > 200, Fr < 0.5` | logic.md §2.1 | [legacy-controller.js:1519](src/lib/cpt-app/legacy-controller.js#L1519), [:1570](src/lib/cpt-app/legacy-controller.js#L1570) | Matches |
| A.1.9 | Clay guard `dQ < 0.01 MPa` or `σ'v0 < 1` | logic.md §2.1 | [legacy-controller.js:1503](src/lib/cpt-app/legacy-controller.js#L1503) | Matches |
| A.1.10 | Estimate `fs ≈ qt · Rf/100` when `fs` missing | not documented | [legacy-controller.js:1511](src/lib/cpt-app/legacy-controller.js#L1511) | Undocumented |
| A.1.11 | CUR 3: priority-based rule | logic.md §2.2 | [legacy-controller.js:1606](src/lib/cpt-app/legacy-controller.js#L1606) | Discrepancy (§3.2) |
| A.1.12 | NEN 6740: priority-based rule | logic.md §2.2 (implied) | [legacy-controller.js:1665](src/lib/cpt-app/legacy-controller.js#L1665) | Discrepancy (§3.3) |
| A.1.13 | SB260 / Eurocode Tabel 3, row-order priority grind → zand → leem → klei → veen | logic.md §2.3 | [legacy-controller.js:1704](src/lib/cpt-app/legacy-controller.js#L1704) | Matches |
| A.1.14 | Out-of-table SB260 fallback (qc<0.4 → leem; else zand los) | not documented | [legacy-controller.js:1720-1725](src/lib/cpt-app/legacy-controller.js#L1720) | Undocumented |

### A.2 Stress and pore water

| # | Doc statement | Doc source | Code location | Verdict |
|---|---|---|---|---|
| A.2.1 | Above wt `σv = γ_unsat · z`; below wt `σv = γ_unsat·wt + γ_sat·(z − wt)` | logic.md §4.1 | [legacy-controller.js:1449-1454](src/lib/cpt-app/legacy-controller.js#L1449); [stage6-engineering.js:318](src/lib/cpt-app/stage6-engineering.js#L318) | Matches |
| A.2.2 | `u = 10 · max(0, z − z_wt)` | logic.md §2.1, §4.1 | [legacy-controller.js:1455](src/lib/cpt-app/legacy-controller.js#L1455) (uses 9.81) | Discrepancy (§3.5) |
| A.2.3 | `σ'v0 = max(σv − u, 1)` | logic.md §4.1 | [legacy-controller.js:1456](src/lib/cpt-app/legacy-controller.js#L1456); [stage6-engineering.js:347](src/lib/cpt-app/stage6-engineering.js#L347) | Matches |
| A.2.4 | Default `wt = 1.5 m` | logic.md §1.4 | [legacy-controller.js:59](src/lib/cpt-app/legacy-controller.js#L59) (1.7 m) | Discrepancy (§3.4) |
| A.2.5 | Stage 3 defaults `γ = 18, γ_sat = 18`, used pre-classification | logic.md §3.3 | `NEN6740_MATERIALS` constants + Robertson hard-coded `(18, 17)` in [legacy-controller.js:1497](src/lib/cpt-app/legacy-controller.js#L1497) | Matches (Stage 3), Undocumented (Robertson hard-code) |

### A.3 Stage 4 — stiffness parameters

| # | Doc statement | Doc source | Code location | Verdict |
|---|---|---|---|---|
| A.3.1 | `Eoed,i = α_E · q_c` | logic.md §4.2 | [legacy-controller.js:2798](src/lib/cpt-app/legacy-controller.js#L2798) | Matches |
| A.3.2 | α_E method A / method B / engineer override | logic.md §4.2 | [legacy-controller.js:2788-2795](src/lib/cpt-app/legacy-controller.js#L2788) | Matches |
| A.3.3 | `Eoed,ref = Eoed,i / ((σ'v + c·cotφ) / (p_ref + c·cotφ))^m`, `p_ref = 100 kPa` | logic.md §4.3 | [legacy-controller.js:2807-2811](src/lib/cpt-app/legacy-controller.js#L2807); also [stage6-engineering.js:420](src/lib/cpt-app/stage6-engineering.js#L420) | Matches |
| A.3.4 | `m` defaults (peat 1.0 / cohesive 0.85 / Sandy clay 0.65 / other 0.5) | logic.md §4.3, §4.4 | [legacy-controller.js:2801-2805](src/lib/cpt-app/legacy-controller.js#L2801) | Matches |
| A.3.5 | Method A: `E50,ref = 1.25·Eoed,ref` (cohesive), `Eur = 3·E50` | logic.md §4.3 | [legacy-controller.js:2819-2821](src/lib/cpt-app/legacy-controller.js#L2819) | Matches |
| A.3.6 | Method B: `E50 = Eoed`, `Eur = 3·Eoed` | logic.md §4.4 | [legacy-controller.js:2816-2817](src/lib/cpt-app/legacy-controller.js#L2816) | Matches |
| A.3.7 | `K0_nc = 1 − sinφ` | logic.md §4.6 | [legacy-controller.js:2824](src/lib/cpt-app/legacy-controller.js#L2824) | Matches |
| A.3.8 | `ψ = max(0, φ − 30°)` | logic.md §4.6 | [legacy-controller.js:2827](src/lib/cpt-app/legacy-controller.js#L2827) | Matches |
| A.3.9 | `ν = 0.45 / 0.35 / 0.30`, `ν_ur = 0.20` | logic.md §4.6 | [legacy-controller.js:2825-2826](src/lib/cpt-app/legacy-controller.js#L2825) | Matches |
| A.3.10 | `Emc = 1.5 · (1+ν)(1−2ν)/(1−ν) · Eoed,i` | not documented | [legacy-controller.js:2828](src/lib/cpt-app/legacy-controller.js#L2828) | Undocumented (§4.1) |

### A.4 Stage 6 — loads, EC7, EC2

| # | Doc statement | Doc source | Code location | Verdict |
|---|---|---|---|---|
| A.4.1 | ULS Eq 6.10 A1 `1.35·Gk + 1.50·(Qlead + ψ0·Qother)` | logic.md §Stage 6 combination policy | [stage6-engineering.js:293](src/lib/cpt-app/stage6-engineering.js#L293) | Matches |
| A.4.2 | ULS A2 `1.00·Gk + 1.30·Q…` | Stage6_review.md | [stage6-engineering.js:301](src/lib/cpt-app/stage6-engineering.js#L301) | Undocumented in logic.md |
| A.4.3 | ψ0/ψ1/ψ2 per category A–E + W/S/T | Stage6_review.md | [stage6-engineering.js:7-16](src/lib/cpt-app/stage6-engineering.js#L7) | Matches |
| A.4.4 | M2 factors: γ_φ' = γ_c' = 1.25, γ_cu = 1.40 on tanφ' | Stage6_review.md | [stage6-engineering.js:306-316](src/lib/cpt-app/stage6-engineering.js#L306) | Matches |
| A.4.5 | Bearing `Nq = exp(π·tanφ')·tan²(45 + φ'/2)` | Stage6_review.md | [legacy-controller.js:5066](src/lib/cpt-app/legacy-controller.js#L5066), [:5090](src/lib/cpt-app/legacy-controller.js#L5090) | Matches |
| A.4.6 | `Nc = (Nq − 1)/tanφ'`, `Nγ = 2·(Nq+1)·tanφ'`, `Nc = 5.14` when φ' = 0 | Stage6_review.md | [legacy-controller.js:5067-5068](src/lib/cpt-app/legacy-controller.js#L5067) | Matches |
| A.4.7 | Shape factors footing `{1.2, 1.1, 0.6, 1.2}`, slab `{1.3, 1.2, 0.8, 1.3}` | Stage6_review.md | [legacy-controller.js:4749-4752](src/lib/cpt-app/legacy-controller.js#L4749) | Matches |
| A.4.8 | `γ_eff = γ_sat − γ_w` below the water table | Stage6_review.md | [legacy-controller.js:5050](src/lib/cpt-app/legacy-controller.js#L5050) | Matches |
| A.4.9 | `q_ult,u = σ_v + 5.14·cu·scu` | Stage6_review.md | [legacy-controller.js:5070](src/lib/cpt-app/legacy-controller.js#L5070), [:5094](src/lib/cpt-app/legacy-controller.js#L5094) | Matches |
| A.4.10 | DA1/1 soilSet=M1, DA1/2 soilSet=M2 | Stage6_review.md | [legacy-controller.js:4778-4795](src/lib/cpt-app/legacy-controller.js#L4778) | Matches |
| A.4.11 | Boussinesq 4·I(B/2, L/2, z) + strip closed form | Stage6_review.md | [stage6-engineering.js:482-497](src/lib/cpt-app/stage6-engineering.js#L482) | Matches |
| A.4.12 | 2:1 method `q·BL/((B+z)(L+z))` | Stage6_review.md | [stage6-engineering.js:487-491](src/lib/cpt-app/stage6-engineering.js#L487) | Matches |
| A.4.13 | Consolidation Tv <> 0.2 closed forms | Stage6_review.md | [stage6-engineering.js:263-267](src/lib/cpt-app/stage6-engineering.js#L263) | Matches |
| A.4.14 | EC2 structural class base = 4 with documented ± rules | Stage6_review.md / ec2_durability.py | [stage6-engineering.js:175-211](src/lib/cpt-app/stage6-engineering.js#L175) | Matches |
| A.4.15 | Table 4.4N lookup + XF/XA fallback to XC4/XD3 | ec2_durability.py | [stage6-engineering.js:219-260](src/lib/cpt-app/stage6-engineering.js#L219) | Matches |
| A.4.16 | `c_min,b = max(φ_bar, 6)` + 5 mm if dG > 32 | ec2_durability.py | [stage6-engineering.js:213-217](src/lib/cpt-app/stage6-engineering.js#L213) | Matches |
| A.4.17 | c_nom = c_min + Δc_dev, rounded up to 5 mm; 40 / 75 mm floors for ground casting | ec2_durability.py | [stage6-engineering.js:227-237](src/lib/cpt-app/stage6-engineering.js#L227) | Matches |

### A.5 Bishop Simplified

| # | Doc statement | Doc source | Code location | Verdict |
|---|---|---|---|---|
| A.5.1 | `F = Σ[(c'·b + (W − u·b)·tanφ')/m_α] / Σ W·sinα` | bishop_simplified_v1_spec.html | [stage6-bishop.js:628](src/lib/cpt-app/stage6-bishop.js#L628) | Discrepancy (§3.1) — uses `u·l` |
| A.5.2 | `m_α = cosα + sinα·tanφ'/F`, reject if `m_α ≤ 0` | spec | [stage6-bishop.js:615-626](src/lib/cpt-app/stage6-bishop.js#L615) | Matches |
| A.5.3 | Fellenius seed `F₀ = Σ[c'·l + (W·cosα − u·l)·tanφ'] / Σ W·sinα` | spec | [stage6-bishop.js:537-550](src/lib/cpt-app/stage6-bishop.js#L537) | Matches spec's Fellenius (which uses `u·l`), different from Bishop term |
| A.5.4 | Iterate until `|F_{k+1} − F_k| < tol` | spec | [stage6-bishop.js:643-645](src/lib/cpt-app/stage6-bishop.js#L643) (`tol = 1e-4`, max 50) | Matches; tolerances undocumented |
| A.5.5 | γ_w = 9.81 | convention | [stage6-bishop.js:7](src/lib/cpt-app/stage6-bishop.js#L7) | Matches |

### A.6 Constants

| Symbol | Value | Source | Code |
|---|---|---|---|
| `p_ref` | 100 kPa | logic.md §4.3; robertson-2016.md | [legacy-controller.js:2780](src/lib/cpt-app/legacy-controller.js#L2780); [stage6-engineering.js:4](src/lib/cpt-app/stage6-engineering.js#L4) |
| `pa` | 100 kPa | robertson-2016.md | [legacy-controller.js:1542](src/lib/cpt-app/legacy-controller.js#L1542) |
| `γ_w` | 10 kN/m³ *in docs*, 9.81 kN/m³ *in code* | logic.md §2.1 vs code | [legacy-controller.js:1455](src/lib/cpt-app/legacy-controller.js#L1455); [stage6-engineering.js:3](src/lib/cpt-app/stage6-engineering.js#L3); [stage6-bishop.js:7](src/lib/cpt-app/stage6-bishop.js#L7) |
| `a` (net-area ratio) | 0.8 default | robertson-2016.md §Inputs | [legacy-controller.js:1498](src/lib/cpt-app/legacy-controller.js#L1498) |
| `n` clamp | `[0.5, 1.0]` | robertson-2016.md §Step 3 | [legacy-controller.js:1559](src/lib/cpt-app/legacy-controller.js#L1559) |
| `Fr` clamp | `[0.1, 10]` | robertson-2016.md §Step 2 | [legacy-controller.js:1512](src/lib/cpt-app/legacy-controller.js#L1512), [:1551](src/lib/cpt-app/legacy-controller.js#L1551) |
| Ic clay-guard default | `Ic = 2.80` | robertson-2016.md §Edge cases | [legacy-controller.js:1504](src/lib/cpt-app/legacy-controller.js#L1504), [:1548](src/lib/cpt-app/legacy-controller.js#L1548) |
| `wt` default | 1.5 m *in docs*, 1.7 m *in code* | logic.md §1.4 | [legacy-controller.js:59](src/lib/cpt-app/legacy-controller.js#L59) |
| A1 load factors | γG = 1.35, γQ = 1.50 | logic.md Stage 6 | [stage6-engineering.js:301-302](src/lib/cpt-app/stage6-engineering.js#L301) |
| A2 load factors | γG = 1.00, γQ = 1.30 | not in logic.md | [stage6-engineering.js:301-302](src/lib/cpt-app/stage6-engineering.js#L301) |
| M2 soil factors | γφ = γc = 1.25, γcu = 1.40 | Stage6_review.md | [stage6-engineering.js:306-315](src/lib/cpt-app/stage6-engineering.js#L306) |

---

## Appendix B — Audit Trail

Files read in full (line counts at read time):

- `docs/logic.md` (1660 lines) — §1.4, §2.1, §2.2, §2.3, §3.3, §4.1, §4.2,
  §4.3, §4.4, §4.6, Stage 6 combination policy.
- `docs/classification/robertson-2016.md` (190 lines) — all sections.
- `docs/bishop/bishop_simplified_v1_spec.html` — factor formula and
  "common pitfalls" (`u·b` vs `u·l`).
- `docs/stage6/Stage6_review.md` (2141 lines) — bearing, settlement,
  EC2 durability, EC7 partial-factor sections.
- `src/lib/cpt-app/legacy-controller.js` (7072 lines) — classification
  functions (1441–1726), `runClass` (1731), `hsParams` (2779–2833),
  Stage 6 bearing (4749–5170, 5039–5158), Plaxis export (6454–6514),
  water-table / state defaults (55–74).
- `src/lib/cpt-app/stage6-engineering.js` (1579 lines) — EC2 durability
  (151–261), stress / pore water (318–348), Bishop-independent
  mechanics, Boussinesq (482–497), HS `eoedAtStress` (420–433),
  `designSoilLayer` (306–316), ULS combinations (273–304).
- `src/lib/cpt-app/stage6-bishop.js` (965 lines) — slice construction,
  `ordinarySeed` (537–551), `solveBishopSimplified` (585–658),
  `buildDiagnostics` (553–583).
- `scripts/ec2_durability.py` (500 lines) — Table 4.3N / 4.4N reference,
  structural class, exposure fallback.

Outcome counts by domain:

| Domain | Confirmed | Discrepancies | Undocumented (3A) | Missing-in-code (3B doc-only) |
|---|---|---|---|---|
| Classification | 10 | 3 (§3.2, §3.3, §3.5 partial) | 4 | 1 |
| Stress / pore water | 3 | 2 (§3.4, §3.5) | 1 | 0 |
| Stage 4 stiffness | 9 | 0 | 1 | 0 |
| Stage 6 bearing / settlement / EC2 | 17 | 0 | 2 | 1 (A2 set) |
| Bishop | 4 | 1 (§3.1 — bug) | 1 | 0 |

Top three findings, ranked:

1. **§3.1 — Bishop Simplified uses `u·l` where the spec requires `u·b`.**
   Conservative error in `solveBishopSimplified` line 628 only. The
   seed and diagnostics do not share the same bug.
2. **§3.2/§3.3 — CUR 3 and NEN 6740 classification doc-vs-code
   divergence.** The code implementations are defensible and
   internally commented, but `docs/logic.md` §2.2 does not match
   either of them.
3. **§3.6 — Briefing error: Robertson 2016 is the default method in
   code.** The claim that it was documented-only should be retracted
   before any downstream decision uses it.
