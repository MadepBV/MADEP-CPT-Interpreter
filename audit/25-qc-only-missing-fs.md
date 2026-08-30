# Follow-up audit — qc-only imports (missing sleeve friction fs)

**Date:** 2026-08-08 (standalone follow-up; not part of the 2026-06-05 consolidation in `00-INDEX.md`)
**Status:** FIXED same day — see §7; classifier math extracted to `classification-core.js` /
`eurocode-tabel3.js` and verified by `npm run verify:qc-only`. Stage 3 catalogue-order parameter
assignment was deliberately kept (conservative for Flanders profiles, engineer overrides) but is now
flagged per layer; the PLAXIS simulated fs now uses per-type representative Rf so the export still
recreates the layering (its stated purpose) instead of reading as clean sand.
**Branch:** v0.5.3
**Scope:** What the app does when an imported file contains depth + qc but no fs (and no Rf) —
legacy CPTs. Import → classification → layers → parameters → Stage 6 → report → exports.
**Method:** code trace of `legacy-controller.js` + module sweep, plus a numerical replication of the
classifiers on a realistic qc-only profile (sand body / soft clay / dense sand).

---

## Headline

Import **works** for all three formats (GEF, Excel, CSV only require depth + qc; fs/rf columns are
optional and stored as `null` — `legacy-controller.js:1380,1515,1631`). **Nothing crashes** — every
`.toFixed()` on fs/rf is null-guarded and nothing divides by fs/rf.

The problem is that the whole pipeline then **silently substitutes defaults and zeros**:

- every classifier assumes **Rf = 3.0 %** (or worse, a fallback type) with no user control and no
  indication;
- the fs and Rf charts draw a **line at zero**, indistinguishable from a real fs ≈ 0 measurement;
- Stage 3 auto-assigns subtype **parameters** (φ′, c′, cu) that can only be told apart by Rf, so it
  silently picks the first qc-band match — silty sand gets **loam strength**;
- the PLAXIS export writes **fabricated fs = 0** rows; the Stage 7 report claims an fs plot that is
  blank.

**The user is never warned anywhere that fs is missing.** There is a `hasU2` presence flag and meta
row, but no `hasFs` analogue (`legacy-controller.js:1334, 1674-1685`).

---

## 1. Classification with fs = null (all five methods affected)

| Method | Null handling | Effect on a qc-only profile (verified numerically) |
|---|---|---|
| Robertson 1990 | `fs_eff = qt·(r.rf ?? 3)/100` → Fr ≈ 3 % (`:2122`) | Everything pulled toward the middle zones: sands → Silty sand, clays → Sandy clay |
| Robertson 2016 (default) | same substitution (`:2161`) | Shallow + dense sands → **Silty sand**; soft clay → **Sandy clay**; only mid-depth strong sand survives as Sand |
| CUR 3 layers | `rf = r.rf ?? 3.0` (`:2226`) | Rf = 3 can never enter the Sand (<1.5) or Silt (<2.5) zones → **the entire profile with qc ≥ 0.2 MPa becomes Clay** (rest Peat) |
| NEN 6740 | `rf ?? 3.0` (`:2271`; `NEN6740_DEFAULT_RF`) | Score = log10(qcNen) − 1.02 can no longer reach the clean-sand areas → dense sand (qc 20 MPa) → **"sand, very silty, loose"**: φ′ 30° instead of 40° |
| Eurocode Tabel 3 (sb260) | `eurocodeEntryMatches` returns **false** for every row when `rf == null` (`:2974`) | No table row ever matches → fallback (`:2314-2319`): qc < 0.4 → "leem, weinig vast", **everything else → "zand, los" with φ′ = 27°, c = 0, cu = 0** — including actual clays |

Numerical check (profile: sand 0.7–4.5 m true Rf 0.8, soft clay 4.7–7.9 m true Rf 4.5, dense sand
8.1–11.9 m true Rf 0.6): 14 of 18 point/method combinations change class vs. the same profile with
true Rf. Robertson 2016 misclassifies dense sand at 9.5–11.5 m as Silty sand; CUR3 calls the entire
sand body Clay.

## 2. Stage 1 charts

- `arrSafe` maps null → 0 (`:1800-1801`): fs and Rf canvases render a **solid vertical line at
  x = 0** with fabricated axes (fs 0–11.5 kPa, Rf 0–12 %) — looks like a measured zero profile
  (`:1813-1843`, same in `refreshChartData` `:1845-1868`).
- **Bug:** moving the water-table slider recomputes `maxFs = 0` and collapses the WT line on the fs
  chart to a zero-length segment — the dashed WT line vanishes from the fs chart only (`:1714-1721`).

## 3. Stage 2 UI

- Metric tiles show **"avg fs (kPa) 0.0"** and **"avg Rf (%) 0.00"** instead of "—" (`avgOf` returns
  0 for an empty filtered set, `:2342-2350`). The per-row table below renders "—" correctly.

## 4. Stage 3 layers — highest-impact finding

- `suggestSubtype` (`:3084-3130`): with `avgRf = null`, `qcRfFit`'s Rf check passes for every
  candidate, so all Rf-variants of a qc band tie and **CAT declaration order wins**. For
  `Silty sand` layers the loam entry precedes the sand entry → the layer silently receives
  **leem parameters (φ′ 22°, c′ 4, cu 50) instead of sand (φ′ 27°, c′ 0, cu 0)**. The layer keeps its
  "Silty sand" type label (only g/gs/φ/c/cu are copied at `:2696-2700`), making the substitution
  invisible. The veen hard-gate is also bypassed (`:3050`).
- Dropdown fit hints pass `l.avgRf ?? 3` (`:3141`) — inconsistent with the suggestion engine — so in
  a sand layer **no ✓ appears on any sand entry** (all scored as if Rf = 3).
- No compatibility warning mentions fs/Rf (`:3258-3291`, `:17845-17864`).

## 5. Stages 4–6

- Soil parameters (γ, φ′, c′, cu, OCR, moduli) have **no direct fs dependence** — they flow from
  type/subtype, i.e. they inherit the classification and Stage-3 errors above.
- α_E method B: with `avgRf = null` the `'transition'` family is unreachable (`:1118-1153`) → always
  granular α → shifted E_oed,i / E_oed,ref / E_50 / E_ur (Stage 4 and per-row Stage 5 `:3720`).
- Stage 6 pile: Belgian category falls back to type-string matching; classification bias propagates
  into shaft-friction category (`stage6-pile.js:142-169`). Bearing/settlement/Bishop/seepage/
  deformation/retaining have zero fs references (the Bishop/HS "R_f" is the failure ratio, not
  friction ratio).

## 6. Report and exports

- Stage 7 report figure is built with `showFs:true` → permanently **blank fs track with a fabricated
  0–100 kPa axis** (`report-svg.js:109-199`, invoked `:18636-18645`), and the report prose asserts
  "Profile rendered … with qc, fs, …" unconditionally (`report/stage7/+page.svelte:746`).
- `exportPlaxisCpt` (`:17766-17807`): `simulatedLayerFs` falls through to **`return 0`** → every
  exported row has `F[MPa] = 0.000000`. PLAXIS reads Rf = 0 % → clean sand everywhere. The docs
  page omits this third branch.
- `exportCSV` is clean (empty Rf field; no fs column by design). Cross-section tooltips render "—".

## 7. Ranked fixes

1. **Visibility first:** `hasFs` flag at parse time + "Sleeve friction fs: Present / —" meta row +
   Stage 2 warning badge; gate the report prose and fs track on it.
2. **Explicit assumed Rf:** `S.assumedRf` (default 3.0, user-editable) replacing the five hidden
   defaults, including `classSB260` (assume, don't fall through to loose sand).
3. `suggestSubtype`: refuse to auto-apply parameters (or flag the layer) when `avgRf == null` and
   several Rf-variants match the qc band.
4. Charts: pass nulls, not zeros (`spanGaps` already set); empty-state note on fs/Rf canvases; floor
   `maxFs` in `setWT` like `initCharts` does.
5. Stage 2 tiles: "—" instead of 0.0/0.00.
6. `exportPlaxisCpt`: warn or abort instead of writing fs = 0.
7. Dropdown hints: pass `l.avgRf ?? null` so hints match the suggestion engine.

Fix 1+2 are the companion change specified in
`docs/features/cpt-graph-digitizer-design.md` §9 (legacy-chart digitizer design).
