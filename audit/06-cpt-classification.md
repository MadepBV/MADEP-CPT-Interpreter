# Audit — CPT soil classification (Robertson 1990/2016, NEN 6740, CUR, EC7 Tabel 3)
**Subsystem key:** cpt-classification
**Files reviewed:** src/lib/cpt-app/legacy-controller.js (classification block ~920-3120 + export list), src/lib/cpt-app/nen6740.js, src/lib/cpt-app/soil-regions.js, src/lib/cpt-app/soil-styles.js, scripts/verify_nen6740.mjs, docs/logic.md, docs/classification/robertson-2016.md, docs/classification/nen6740.md, docs/deformation/ENGINEERING_AUDIT.md
**Finding counts:** critical=0 high=1 medium=3 low=4 info=2  |  A=1 B=0 C=7 D=2  |  total=10

## Overview
The classification math is in good shape. The Robertson 1990 / 2016 `Ic` formula, the `Fr`/`Qt`/`Qtn`
normalisation, the iterative stress exponent `n`, the unit conversions (kPa/MPa), the log base (`log10` for
`Ic` and the NEN score; natural log only used in dimensionless ratio scoring), the atmospheric pressure
`pa=100`, the γ_w=9.81 pore-pressure term, and the NEN 6740 stress correction (`(100/σ'v0)^0.67`) and
nearest-centre score (`log10(qcNen) − 0.34·Rf`) all match the standards and the docs; the NEN self-consistency
script passes (slope −0.340, R²=0.978, all 14 centres round-trip). The prior ENGINEERING_AUDIT resolutions
(0.34 slope, 9.81, wt=1.7, classRob2016 present) are all reflected in the current code. The one genuine
implementation defect is a coverage gap in the EC7/NEN Tabel 3 router for very-low-`qc` peat readings, which
silently misroutes very soft peat to the wrong soil family. The remainder are doc-vs-code mismatches (Robertson
Zone-7 `Ic≤1.31` row, a `zand (lh)`/`zand (kh)` label slip, Tabel 3 lower-bound omissions in the doc, the
silently-defaulted missing `Rf`) and two minor dead-code items.

## Findings

### [CPT-CLASSIFICATION-A-01] high · EC7/NEN Tabel 3 router misclassifies very-low-qc peat readings via the fallback
- **Location:** `src/lib/cpt-app/legacy-controller.js:2737-2750` (veen `qcMin`), `:2937-2945` (`eurocodeEntryMatches`), `:2277-2284` (fallback)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** Every Tabel 3 row in `CAT` carries a `qcMin`, and `eurocodeEntryMatches` rejects a reading
  before the family/Rf test if `qc < entry.qcMin`:
  ```js
  function eurocodeEntryMatches(entry, qc, rf){
    if(qc < entry.qcMin || qc >= entry.qcMax) return false;   // returns BEFORE the veen rf>6 check
    ...
    if(entry.grp === 'veen') return rf > 6;
  ```
  The lowest veen row is `qcMin:0.2` (`veen, weinig vast`, line 2740). A peat reading with `Rf > 6` and
  `0 < qc < 0.2 MPa` (typical of very soft / not-preloaded peat) therefore matches **no** veen row, exhausts
  `EUROCODE_CLASS_ENTRIES`, and hits the deterministic fallback (lines 2277-2284):
  ```js
  if(qc < 0.4){ return{type:'Sandy clay', subtype:'leem, weinig vast', g:17,gs:17,phi:22,c:0,cu:10,...}; }
  ```
  So very soft peat (e.g. `qc=0.1`, `Rf=8`) is returned as **Sandy clay / leem** — a granular-leaning
  intermediate family with φ′=22°, γ=17, instead of peat (φ′=15°, γ≈10-14). That is an engineering-significant
  misclassification of the weakest, most compressible soil, exactly where it matters most for settlement and
  stability. The doc (`docs/logic.md:271`) lists veen *weinig vast* as `qc < 0.5` with **no** lower bound,
  confirming the intent is to cover all low-qc peat; the `qcMin:0.2` in code is the cause. (The same shape of
  gap exists for low-qc klei/leem at `qcMin:0.4`, but there the fallback lands in the same broad cohesive
  family, so the impact is much smaller, and the published NEN table genuinely imposes a 0.4 lower limit there —
  the peat case is the one true misroute.)
- **Recommendation:** For the veen group, drop or lower `qcMin` (e.g. `qcMin:0`) or test `rf>6` independently of
  a lower bound so any `Rf>6` reading is captured as peat; alternatively make the fallback peat-aware (route
  `Rf>6` to a peat subtype rather than `Sandy clay/leem`). Reconcile the doc "< 0.5" with the final bound.

### [CPT-CLASSIFICATION-C-01] medium · Robertson docs claim an `Ic ≤ 1.31 → Gravel` (Zone 7) band the code does not implement
- **Location:** doc `docs/classification/robertson-2016.md:109-114`; doc `docs/logic.md` Robertson zone table; code `src/lib/cpt-app/legacy-controller.js:2097-2103` (classRob) and `:2148-2154` (classRob2016)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:**
  1. **Doc says:** robertson-2016.md Step-4 table lists `Ic > 1.31 → Zone 6 (Sands)` and `Ic ≤ 1.31 → Zone 7
     (Gravelly sand to dense sand)`, immediately followed by a separate "Zone 7 override: if Qtn>200 and Fr<0.5
     classify as Gravel". The table row and the override note give two contradictory routes into Zone 7.
  2. **Code does:** there is **no** `Ic ≤ 1.31` branch. The chain is `... else if(Ic > 2.05) Silty sand; else
     Sand;`, so any `Ic ≤ 2.05` (including `Ic < 1.31`) maps to **Sand**. Gravel is assigned **only** by the
     override `(Qt/Qtn > 200 && Fr < 0.5)`. A point with `Ic = 1.0`, `Qtn = 150`, `Fr = 0.6` → doc table says
     Gravel, code says Sand.
  3. **Which is correct:** In Robertson 1990/2016, `Ic < 1.31` *is* Zone 7, but Robertson explicitly cautions
     that `Ic` poorly separates the high-Qt / low-Fr corner (Zones 7-9), which is why a Qt/Fr corner test is the
     conventional way to flag gravel — so the code's override-only approach is engineering-defensible. The doc
     is internally inconsistent and does not describe the code.
  4. **Fix direction:** Fix the doc — remove or annotate the `Ic ≤ 1.31 → Zone 7` row ("not used — gravel set by
     the Qt/Fr override below") in both robertson-2016.md and logic.md so the table matches `classRob`/
     `classRob2016`. (If Ic-based Zone 7 is actually wanted, add the branch to code and re-validate, since it
     changes output.)
- **Recommendation:** Align the Robertson zone tables in both docs to the override-only gravel logic in code.

### [CPT-CLASSIFICATION-C-02] medium · NEN 6740 silently defaults a missing Rf to 3.0 instead of returning `Undetermined`
- **Location:** code `src/lib/cpt-app/legacy-controller.js:2236` (`classNEN6740`), `:2191` (`classCUR3`); doc `docs/classification/nen6740.md:57-59, 85, 334-352`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:**
  1. **Doc says:** nen6740.md is explicit that a faithful implementation must "return `Undetermined` when …
     required inputs are missing" and must **not** "default a missing friction ratio to an arbitrary constant
     and continue as if the input were valid" (lines 57-59); "If neither `fs` nor `Rf` is available, the result
     should be `Undetermined`, not a guessed material" (line 85).
  2. **Code does:** `const rf = r.rf != null ? r.rf : 3.0;` — a missing `Rf` is silently replaced by 3.0 and the
     point classified as if valid (same pattern in `classCUR3:2191`). There is no `Undetermined` path.
  3. **Which is correct:** Scientifically the doc is correct — `Rf` is the primary chart axis; a fixed 3.0 can
     land an unknown-Rf point anywhere from clay to silt and yields a confidently-wrong label. The doc frames
     the strict behaviour as a target ("stricter than the current app behaviour"), so this is an acknowledged
     deviation rather than a hidden bug, but the divergence is real and user-visible.
  4. **Fix direction:** Prefer fixing the code to surface `Undetermined` (or flag the row) when `Rf`/`fs` is
     absent on the NEN/CUR routes; if the product intent is to keep the 3.0 default, state that explicitly in
     `docs/logic.md §2.2b` as a deliberate deviation from `docs/classification/nen6740.md`.
- **Recommendation:** Decide product intent and make doc and code agree; do not leave strict doc + lenient code
  unreconciled.

### [CPT-CLASSIFICATION-C-03] medium · Tabel 3 subtype label mismatch: code `zand (lh)` vs doc `zand (kh)`
- **Location:** doc `docs/logic.md:352-361` ("zand (kh)" keys); code `src/lib/cpt-app/legacy-controller.js:2881-2896` and parameter maps at `:979-982`, `:1027-1030`, `:1088-1090`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:**
  1. **Doc says:** the "Leem- of kleihoudend zand" rows use subtypes `zand (kh), los / matig / dicht / z.dicht`.
  2. **Code does:** the corresponding `CAT` rows and **all** downstream maps (`MC_NU_BY_SUBTYPE`, the HS-variant
     map, and the family classifier `if(sub.includes('zand (lh)'))`) consistently use `zand (lh), …`.
  3. **Which is correct:** the group label is "Leemhoudend zand", so the abbreviation should be **lh**
     (leemhoudend). The **code is correct and internally self-consistent** (no broken lookups); the doc's
     `zand (kh)` is the typo, but it would confuse a reader cross-checking subtype keys (and `(kh)` is already
     used for grind klei/leem-houdend, compounding the confusion).
  4. **Fix direction:** Fix the doc to `zand (lh)`.
- **Recommendation:** Update the `docs/logic.md §2.3` "Leem- of kleihoudend zand" subtype keys to `zand (lh)`.

### [CPT-CLASSIFICATION-C-04] low · Tabel 3 doc omits the lowest-row qc lower bounds that the code enforces
- **Location:** doc `docs/logic.md:271, 281, 305, 318` (rows shown "< 0.5"/"< 1.0", no lower bound); code `src/lib/cpt-app/legacy-controller.js:2740, 2759, 2807, 2832` (`qcMin:0.2`/`0.4`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** The doc presents the lowest qc band of veen (`< 0.5`), klei (`< 1.0`), leem (`< 1.0`) and leem
  zh (`< 1.0`) as open-ended downward, but the code rows carry `qcMin` (veen 0.2; klei/leem 0.4). This is the
  documentation face of A-01: a reader using the doc assumes full low-qc coverage the code does not provide, so
  sub-bound points silently divert to the fallback. The published NEN Tabel 3 does define qc lower limits, so
  the *code* is closer to the standard for klei/leem; the doc should disclose the bound (and the veen lower
  bound should be removed per A-01).
- **Recommendation:** Add the explicit lower qc bound to each lowest row in `docs/logic.md §2.3` and document the
  out-of-table fallback for sub-bound readings.

### [CPT-CLASSIFICATION-C-05] low · `pointInPolygonHalfOpen` is boundary-inclusive despite its "half-open" name
- **Location:** `src/lib/cpt-app/soil-regions.js:217-234`
- **Category:** C — Doc vs Code (self-documenting name vs behaviour)
- **Confidence:** confirmed
- **Analysis:** The name promises half-open containment (one boundary included, the opposite excluded — the
  usual convention to avoid double-counting shared edges between adjacent polygons), but the implementation
  first returns `true` for **any** point on **any** edge (`pointOnSegment(...) → return true`, lines 221-223),
  i.e. fully inclusive on all sides, before the ray cast. For a point exactly on a shared edge between two
  stacked regions, both polygons report containment; `materialAt` happens to resolve this by taking the topmost
  region (iterates high→low index, line 237), so there is no functional bug today, but the name misleads future
  callers who might rely on half-open semantics for disjoint partitioning.
- **Recommendation:** Rename to `pointInPolygonInclusive`, or implement true half-open edge ownership; at minimum
  document the inclusive-boundary behaviour at the call sites that assume non-overlap.

### [CPT-CLASSIFICATION-D-01] low · Redundant `rfMin===1 && rfMax===2` branch in `eurocodeEntryMatches`
- **Location:** `src/lib/cpt-app/legacy-controller.js:2943`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:**
  ```js
  if(entry.rfMin === 0 && entry.rfMax === 1) return rf < 1;             // needed: strict, differs from fallback
  if(entry.rfMin === 1 && entry.rfMax === 2) return rf >= 1 && rf <= 2; // redundant
  return rf >= entry.rfMin && rf <= entry.rfMax;                        // fallback yields the same for 1..2
  ```
  The middle branch returns exactly what the general fallback returns for `rfMin=1, rfMax=2`, so it never
  changes the result (dead). Only the `0..1` special case is load-bearing (it makes the upper bound strict,
  `rf<1`, which the inclusive fallback would not). Harmless, but it implies a special treatment of 1-2 that does
  not exist.
- **Recommendation:** Remove the redundant branch (the doc, logic.md:261, says 1-2 is inclusive both ends, so
  removal is correct).

### [CPT-CLASSIFICATION-D-02] low · `SOIL_CLASS_NAMES`/`SOIL_FILL_COLORS` define `Soft clay`, never produced by Stage-2 classifiers
- **Location:** `src/lib/cpt-app/soil-styles.js:4,13`; classifiers `legacy-controller.js:2097-2103, 2148-2154, 2189-2207, 2240-2245, 2269-2284`
- **Category:** D — Dead code (partial)
- **Confidence:** likely
- **Analysis:** None of `classRob`, `classRob2016`, `classCUR3`, `classNEN6740`, `classSB260` ever returns
  `type: 'Soft clay'` (they emit Peat/organic, Clay, Sandy clay, Silty sand, Sand, Gravel). The `Soft clay`
  style/colour entries are therefore unreachable from the classification path. They are not strictly orphaned —
  `familyClass` (line 2402), `DEF`, and `MC_NU_BY_TYPE` reference `Soft clay` as a possible (manually-assigned)
  type — so this is flagged, not asserted dead. Worth confirming whether any UI path can set `Soft clay`; if
  not, the style entries are dead. FLAG ONLY.
- **Recommendation:** Confirm whether `Soft clay` is ever assignable; drop the style entries only if it is purely
  leftover, otherwise leave as-is.

### [CPT-CLASSIFICATION-C-06] info · NEN 6740 standalone spec describes a polygon/`Undetermined` target the code intentionally does not meet (acknowledged)
- **Location:** doc `docs/classification/nen6740.md` (whole "Target Algorithm"); code `src/lib/cpt-app/nen6740.js` (nearest-centre score)
- **Category:** C — Doc vs Code (intentional, informational)
- **Confidence:** confirmed
- **Analysis:** nen6740.md advocates digitised-polygon membership, 3-point-average preprocessing, and
  `Undetermined` handling, none of which the current nearest-centre score classifier
  (`classifyNen6740ReferenceSpace`) implements. The doc explicitly frames this as "stricter than the current app
  behaviour" / a future target, and `docs/logic.md §2.2b` plus the in-code provenance comments
  (legacy-controller.js:2211-2234, nen6740.js:5-14) honestly disclose that `0.34` is an app-side regression fit
  (not a NEN constant) and `0.67` is the Deltares value. So the code↔logic.md pair is consistent and
  transparent; the nen6740.md gap is by design. The missing-`Rf` default (C-02) is the one concrete user-visible
  divergence from that spec worth fixing.
- **Recommendation:** No code change required; keep the gap visible. If the polygon route is ever adopted, ship
  the `Undetermined` behaviour (C-02) with it.

### [CPT-CLASSIFICATION-C-07] info · Robertson Stage-2 preliminary stress model (γ_unsat=17, γ_sat=18, γ_w=9.81) verified to match code and docs
- **Location:** code `legacy-controller.js:2073, 2116` (`stressAt(r.z, 18, 17)`), `:2017-2032` (`stressAt`); doc `docs/logic.md:92-95, 518`
- **Category:** C — Doc vs Code (positive confirmation)
- **Confidence:** confirmed
- **Analysis:** `stressAt(z, gamma_sat=18, gamma_unsat=17)` yields σv0 = 17·z above WT and
  17·z_wt + 18·(z−z_wt) below WT, u = 9.81·max(0, z−z_wt), σ'v0 = max(σv0−u, 1) — matches the doc's Stage-2
  stress model verbatim, including the 9.81 pore-pressure constant and the 1 kPa floor. The unit conversions
  `dQ = qt − σv0/1000` (kPa→MPa) and `Qt = dQ/(σ'v0/1000)` are dimensionally correct, and the early-return
  guards are consistent (`dQ < 0.01 MPa` ≡ `dQKPa < 10 kPa`). No discrepancy; recorded as a verified match.
- **Recommendation:** None.

## Notes / limitations of this audit pass
- I read the classification block of `legacy-controller.js` in full (≈lines 920-3120) plus the export list and
  all natural-/base-10-log call sites; the remaining ~15 000 lines (Stage 4/5/6, charts, FEM) were out of scope
  for this subsystem and only grepped to confirm no second/divergent `Ic`/`Qtn` implementation exists (none
  found — the only natural-log sites are dimensionless ratio scoring and HS regression, where the log base
  cancels).
- I confirmed the NEN 6740 self-consistency numerically by running `scripts/verify_nen6740.mjs` (passes: slope
  −0.340, R²=0.978, 14×3 round-trips OK). Without a licensed NEN 6740 / D-SHEET reference dataset I could not
  independently validate the *absolute* correctness of the 14 digitised centres or the 0.67/0.34 constants
  beyond their documented provenance — the doc and code are transparent that 0.34 is an app fit.
- The exact published NEN Tabel 3 qc lower bounds (A-01/C-04) were judged from the code/doc and general
  practice; a licensed copy of NEN 6740 / SB260 Tabel 3 should set the definitive veen lower bound. The misroute
  mechanism (low-qc/high-Rf → fallback → Sandy clay) is confirmed directly from the code regardless of the
  precise bound.
- `soil-regions.js` band-building, `regionStripOverlap` (Simpson-rule strip integration), and
  `probeVerticalRegionStack` are region/FEM-meshing utilities rather than CPT classification math; I reviewed
  `pointInPolygonHalfOpen`/`materialAt` for the point-in-polygon concern in the brief (C-05) but did not deeply
  audit the strip integration, which belongs to the deformation/FEM subsystem.
