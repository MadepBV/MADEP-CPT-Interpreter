# Audit — Reporting, SVG/chart generation & report storage
**Subsystem key:** reporting
**Files reviewed:** src/lib/cpt-app/report-svg.js, src/lib/cpt-app/report-storage.js, src/lib/cpt-app/chart-factories.js, src/routes/report/+page.svelte, src/routes/report/+page.ts, src/routes/report/stage7/+page.svelte, src/routes/report/stage7/+page.ts, src/lib/cpt-app/legacy-controller.js (producer side: payload builder, stage7*Payload functions — read for cross-checking units/fields)
**Finding counts:** critical=1 high=1 medium=1 low=5 info=2  |  A=4 B=2 C=0 D=2  |  total=10

## Overview
The reporting subsystem is mostly well-structured: the producer (`legacy-controller.js`) and the report viewer agree on field names and units for the large majority of quantities (fs MPa→kPa conversion, deflection m→mm, Qtn/qc,NEN method metrics, TAW levels, etc. all check out), and chart factories are cleanly parameterised. However there is one **critical numeric-formatting bug**: the `fmt(value, 0)` helper strips trailing zeros from integers, so reported engineering quantities such as bearing load `q`, Winkler `k_s`, Pasternak `G_p`, and layer average `fs` are silently displayed off by powers of ten (e.g. 150 kPa → "15"). Beyond that, the profile-SVG ↔ legend hover-highlight linkage is broken by an index mismatch, an inclined retaining-wall "length" is mis-computed as a vertical span, the localStorage save path has no quota/error handling, and two payload blocks (`visuals.layerColumn`, `chartInputs.raw`) are generated, stored and validated-as-required but never consumed by the viewer (storage bloat + dead data). A stale hardcoded `appVersion` is also reported.

## Findings

### [REPORTING-A-01] critical · `fmt(value, 0)` strips trailing zeros from integers → reported kPa/kN values off by 10×–1000×
- **Location:** `src/routes/report/stage7/+page.svelte:42-46` (the `fmt` helper); call sites `:766` (avg fs), `:992` (bearing Load q), `:1053` (k_s), `:1054` (G_p), `:1101` (runtime)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** The formatter is
  ```js
  function fmt(value, digits = 2) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '—';
    return num.toFixed(digits).replace(/\.?0+$/, '');
  }
  ```
  The trailing-zero strip `/\.?0+$/` is intended to remove a fractional tail like `".50"→".5"` or `".00"→""`. With `digits >= 1`, `toFixed` always emits a decimal point, so the `\.?` matches the dot and only fractional zeros are removed — safe. But with `digits = 0`, `toFixed(0)` produces a bare integer string with **no decimal point**, and `0+$` then greedily eats the integer's own trailing zeros. Verified by execution:
  ```
  fmt(100, 0)  -> "1"     fmt(150...→"15")   fmt(1500,0) -> "15"
  fmt(200, 0)  -> "2"     fmt(9000,0) -> "9"  fmt(40,0)   -> "4"
  fmt(250, 0)  -> "25"    fmt(505,0)  -> "505" (only unaffected when no trailing zero)
  ```
  Impact on reported engineering quantities (all `fmt(...,0)` sites):
  - `:992` `Load q (kPa)` for EC7 bearing — a 150 kPa / 200 kPa surcharge prints as "15" / "2". This is a primary bearing-capacity input shown next to `q_d`.
  - `:1053` `k_s` (Winkler subgrade modulus, kN/m³) — e.g. 30000 → "3".
  - `:1054` `G_p` (Pasternak shear stiffness, kN/m) — same failure mode.
  - `:766` layer average `fs (kPa)` legend — e.g. 50 kPa → "5". (Note the same value is rendered correctly elsewhere as `fmt(layer.avgFsKPa, 1)` at `:834`, so the report is internally inconsistent for the same field.)
  - `:1101` runtime ms — cosmetic.
  This is exactly the "plausible-but-wrong engineering answer" failure class: values look reasonable but are silently mis-scaled. (The sibling helpers are safe: `fmtInt` uses `Math.round(...).toLocaleString` with no strip; `compactNumber` uses the anchored `/\.0$/`.)
- **Recommendation:** Make the strip only fire when a decimal point is present, e.g. `num.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')`, or guard with `digits > 0 ? str.replace(/\.?0+$/,'') : str`. After the fix, re-verify `fmt(100,0) === '100'`. Consider routing the integer call sites through `fmtInt` instead.

### [REPORTING-A-02] high · Profile-SVG layer rects all carry `data-layer-index="0"`, breaking legend↔profile hover highlight
- **Location:** `src/lib/cpt-app/report-svg.js:162-178` (`data-layer-index="${Number(layer.index ?? 0)}"`); consumer `src/routes/report/stage7/+page.svelte:120-164` (`syncProfileLayerHighlight`, `showProfileTooltip`); producer `src/lib/cpt-app/legacy-controller.js:18208-18216` (passes `layers:S.layers`) and `:2667` (`S.layers` items have `id:i` but **no `index` field**)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** `buildLayerPreviewSvgMarkup` writes `data-layer-index="${Number(layer.index ?? 0)}"` on both the visible fill rect and the hit rect. The producer feeds it `S.layers`, whose elements are created at `:2667` as `{id:i, top, bot, ...}` with **no `index` property** (confirmed by grep: no `.index=` assignment on `S.layers` items). Hence `layer.index ?? 0` is `0` for **every** layer → every rect gets `data-layer-index="0"`.
  In the report page, `payload.layers[].index` is **1-based** (`stage7WorkingLayerPayload` sets `index: index + 1`, `legacy-controller.js:17485`). The legend rows (`:757`) call `handleProfileLegendEnter(layer.index)` → `hoveredProfileLayerIndex` becomes 1,2,3,…. `syncProfileLayerHighlight` (`:126-140`) then compares those against the SVG rects' `data-layer-index` (always 0) → **no rect ever matches**, so legend hover never highlights the profile. Conversely `showProfileTooltip` (`:164`) does `Number(target.getAttribute('data-layer-index')||'') || null` → `Number('0')||null` → `null`, so hovering a profile band never highlights its legend row either. The tooltip text still works (it reads `data-*` attributes directly), but the intended bidirectional highlight is dead. The same `index ?? 0` defect exists for the in-app preview (`renderLayerPreviewSvg`, `:1862`), though there the impact is limited because that view only does tooltip binding.
- **Recommendation:** Either set a 1-based `index` on `S.layers` elements (or pass `index` explicitly into `buildLayerPreviewSvgMarkup` per `.map((l,i)=>...)`), and make producer + payload agree on the index base. Verify legend hover lights the matching profile band and vice-versa.

### [REPORTING-A-03] medium · Retaining-wall "Length (m)" reports vertical span, not true inclined length
- **Location:** `src/routes/report/stage7/+page.svelte:1154` (header "Length (m)"), `:1163` (`{fmt(wall.yTop - wall.yTip, 2)}`); wall geometry `src/lib/cpt-app/legacy-controller.js:5583-5608`, `:7448` (inclined: `tip.x = nextX + dx`)
- **Category:** A — Implementation
- **Confidence:** likely
- **Analysis:** The Bishop "Retaining Walls" table reports each wall's length as `wall.yTop - wall.yTip`. With the recent two-point inclined-wall geometry (commit "feat(walls): support two-point inclined wall geometry"; UI hint at `:8785` "can be vertical or inclined"), a wall stores `head:{x,y}` and `tip:{x,y}` with potentially differing x (`:7448` sets `tip.x = nextX + dx`). `yTop`/`yTip` are merely the legacy aliases `head.y`/`tip.y` (`:5607-5608`), so `yTop - yTip` is the **vertical extent only**. For an inclined wall the true length is `√((head.x-tip.x)² + (head.y-tip.y)²) > yTop - yTip`, so the column under-reports length and is mislabeled. The data needed for a correct value (`head`/`tip`) is already in the cloned `bishop.config.walls` payload (`:17547`), so the report could compute it but doesn't. Vertical walls are unaffected (Δx = 0).
- **Recommendation:** Compute length from `head`/`tip` when both endpoints exist: `hypot(wall.head.x - wall.tip.x, wall.head.y - wall.tip.y)`, falling back to `yTop - yTip`. Alternatively relabel the column "Vertical span (m)" if vertical extent is what is actually intended.

### [REPORTING-A-04] low · Reported `appVersion` is hardcoded and stale (`0.3.3` vs package `0.5.0` / branch v0.5.3)
- **Location:** producer `src/lib/cpt-app/legacy-controller.js:18148` (`appVersion:'0.3.3'`); displayed at `src/routes/report/stage7/+page.svelte:632` ("App version")
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** The Stage 7 payload pins `appVersion:'0.3.3'`, but `package.json` is `"version": "0.5.0"` (working branch `v0.5.3`). The report header prints this string verbatim as the "App version" of the frozen record, so every report mis-states the application version it was produced by — misleading for an archival/traceability field on engineering-critical output. (Distinct from `STAGE7_REPORT_VERSION`/`payload.version = 4`, which is the schema version and is consistent.)
- **Recommendation:** Source `appVersion` from `package.json`/build define (e.g. Vite `__APP_VERSION__`) instead of a literal, so it cannot drift.

### [REPORTING-B-01] medium · No quota/error handling on the localStorage save path (large base64 view images can exceed quota)
- **Location:** `src/lib/cpt-app/report-storage.js:54-59` (`saveStage7Payload` → bare `storage.setItem(key, JSON.stringify(payload))`); producer call `src/lib/cpt-app/legacy-controller.js:18256` (`openStage7Report`, no try/catch); image capture `:17876-17904`
- **Category:** B — Memory/Performance (robustness)
- **Confidence:** confirmed
- **Analysis:** The payload embeds full `rawRows`, `classifiedRows`, every tuning `fit` array, and base64 view screenshots for bishop/seepage/deformation (`stage7CaptureCanvasImage`, JPEG up to 1400px wide). For a long CPT plus several captured Stage-6 views this can approach or exceed the ~5 MB per-origin `localStorage` quota. `saveStage7Payload` calls `setItem` with no try/catch; on `QuotaExceededError` it throws. The in-app entry point `openStage7Report` (`:18253-18263`) has no surrounding try/catch, so the exception surfaces unhandled to the user (the alert at `:18258` only covers the empty-key case, not a throw). The `/report` file-open path is more robust because `+page.svelte:27-47` wraps `persistStage7Payload` in try/catch. Additionally `cleanupStage7Payloads` only runs *after* a successful save, so a failed save leaves no room reclaimed. Note `JSON.stringify` of the whole payload (rows + images) also runs synchronously on the main thread on each open.
- **Recommendation:** Wrap `setItem` in try/catch, return `''` (or a typed error) on quota failure, and have both entry points surface a clear message ("report too large to store; remove captured images or reduce rows"). Consider proactively cleaning old keys before saving, and/or capping captured-image size more aggressively.

### [REPORTING-B-02] low · `visuals.layerColumn` + `chartInputs.raw` are serialized into every payload but never read by the viewer
- **Location:** producer `src/lib/cpt-app/legacy-controller.js:18193-18204` (`layerColumn` markup), `:18219-18224` (`chartInputs.raw`); validator requires them `src/lib/cpt-app/report-storage.js:75,77-78`; no consumer in `src/routes/report/**` (grep confirms zero references)
- **Category:** B — Memory/Performance (also D — dead data)
- **Confidence:** confirmed
- **Analysis:** `buildLayerColumnSvgMarkup` is invoked to build a full SVG string stored under `visuals.layerColumn.markup`, and `chartInputs.raw = {maxDepth, maxQc, maxFs}` is computed and stored, yet the Stage 7 report page never references `visuals.layerColumn` or `chartInputs` anywhere (only `visuals.layerProfile` is rendered, `:721/:730`). These payload blocks add serialization cost and localStorage bytes (compounding REPORTING-B-01) on every report for no rendered output. Because `isStage7Payload` marks both as *required* (`:75` / `:77-78`), they cannot simply be removed without bumping `STAGE7_REPORT_VERSION`.
- **Recommendation:** Either render the column SVG / a raw-profile chart in the report (use `buildRawProfileChartConfig` with `chartInputs.raw`), or drop both blocks and relax the validator behind a version bump. Decide based on whether the column/raw chart are wanted in the report.

### [REPORTING-B-03] low · `buildTuningDepthChartConfig` axis uses `Math.max(...allE)` with no empty/NaN guard
- **Location:** `src/lib/cpt-app/chart-factories.js:239-240` (`const allE = [...eoedI, ...hsDefault, ...hsPreview]; const xMax = Math.ceil(Math.max(...allE) / 5000) * 5000;`)
- **Category:** B — Memory/Performance (robustness) / A-adjacent
- **Confidence:** likely
- **Analysis:** If `eoedI`, `hsDefault`, `hsPreview` are all empty, `Math.max()` returns `-Infinity` and `xMax` becomes `-Infinity`, producing a degenerate axis (`min:0, max:-Infinity`) and bad band/WT line coordinates. The chart is only mounted when `item.fit` exists, and the storage validator does not check the inner `fit` arrays (`report-storage.js:83` only checks `Array.isArray(payload.tuning)`), so a payload with a `fit` object whose point arrays are empty/absent would reach this path. Also `tuningLogLine` (`+page.svelte:255`) does `Math.min(...fit.xs)` which would be `Infinity` for an empty `xs`. Low likelihood in normal data, but no defensive clamp exists.
- **Recommendation:** Clamp: `const finiteE = allE.filter(Number.isFinite); const xMax = finiteE.length ? Math.ceil(Math.max(...finiteE)/5000)*5000 : 5000;` and guard `tuningLogLine`/`tuningHsPreview` against empty `xs`. Optionally tighten `isStage7Payload` to validate tuning `fit` array shapes so corrupt payloads are rejected at load rather than crashing render.

### [REPORTING-A-05] low · Unescaped soil-type label text in generated SVG markup (`{@html}`)
- **Location:** `src/lib/cpt-app/report-svg.js:14` (`${emptyLabel}`), `:30` (`${shortLabel}` in `<text>`), `:121-126/:192-199` axis labels; rendered via `{@html payload.visuals.layerProfile.markup}` at `src/routes/report/stage7/+page.svelte:730`
- **Category:** A — Implementation (robustness/correctness)
- **Confidence:** confirmed (behavior), low impact
- **Analysis:** The hit-rect `data-*` attributes are escaped via `esc()` (`:165-167`), but the visible `<text>` content (`shortLabel` derived from `layer.type`) and `emptyLabel` are interpolated raw into the SVG string, which is then injected with `{@html}`. If a soil `type`/label ever contained `<`, `>` or `&`, it would corrupt the SVG or inject markup. Current soil types come from the fixed classification catalogue (e.g. "Sand", "Peat / organic") with no user free-text, so impact is presently nil, but the asymmetry (attributes escaped, text not) is a latent correctness/robustness gap given the `{@html}` sink.
- **Recommendation:** Run `shortLabel`/`emptyLabel`/axis labels through `esc()` for defense-in-depth, matching the attribute handling.

### [REPORTING-D-01] info · Unused viewport/display capture fields and unused tuning payload fields
- **Location:** payload `hsFitPts` (`legacy-controller.js:17472`) and `:17518-17520` HS extras vs report consumption; chart-factory `buildBeamMomentChartConfig`/`buildBeamDeflectionChartConfig` unused in report? (they are used) — see analysis
- **Category:** D — Dead Code
- **Confidence:** confirmed
- **Analysis:** Within the reporting surface, several stored fields are never consumed by the viewer: `tuning[].fit.hsFitPts` is serialized (`:17472`) but `renderCharts` recomputes the preview line via `tuningHsPreview` and never reads `hsFitPts`. Likewise `layer.hs.sigmaV`, `porePressure`, `sigmaVEff`, `eMc`, `rShear`, `psi`, `nu` (`:17515-17520`) are carried in the payload but the Model-Parameters table only renders `alphaE, eOedI, eOedRef, e50Ref, eurRef, m, k0nc, nuUr` and the hydraulic block — the rest are dead w.r.t. the report (they may be consumed elsewhere, but not in `/report/**`). This is benign data carried for completeness but it adds to payload/storage size. (All chart-factory exports are reachable: report uses 11; the pile/line-probe/raw-profile factories are used by `legacy-controller.js`, so none of `chart-factories.js` is orphaned.)
- **Recommendation:** No action required for correctness; if trimming payload size for storage (REPORTING-B-01), drop fields not consumed by the report after confirming they aren't needed for round-trip re-edit.

### [REPORTING-D-02] info · `+page.ts` files are identical duplicates (acceptable SvelteKit boilerplate)
- **Location:** `src/routes/report/+page.ts` and `src/routes/report/stage7/+page.ts` (both: `export const ssr = false; export const prerender = true;`)
- **Category:** D — Dead Code (duplicate logic)
- **Confidence:** confirmed
- **Analysis:** The two route configs are byte-identical. This is normal SvelteKit per-route configuration, not removable duplication, but noted for completeness since the subsystem brief asked for duplicate-logic flagging. No defect.
- **Recommendation:** None — leave as-is (per-route config is intentional in SvelteKit).

## Notes / limitations of this audit pass
- I cross-checked units/field-names against the **producer** (`legacy-controller.js`, ~18 kLOC). I read the payload-builder functions in full (`buildStage7Payload`, `stage7WorkingLayerPayload`, `stage7BishopPayload`, `stage7SeepagePayload`, `stage7TuningPayload`, and the stage6 wrapper) but did not exhaustively read all upstream analysis modules; unit correctness of source-module *values* (vs their *display*) is in scope of other subsystem audits.
- The `fmt(...,0)` bug (REPORTING-A-01) is confirmed by direct Node execution of the exact helper. Its visible impact depends on the runtime values: it only mis-renders when the integer ends in one or more zeros — but that includes the most common bearing loads (100/150/200 kPa) and typical k_s/G_p magnitudes, so it will fire frequently in practice.
- REPORTING-A-03 (inclined wall length) is marked *likely* rather than confirmed because I did not execute the app to produce an actual inclined wall; the code path (`tip.x = nextX + dx`) and label clearly support the conclusion.
- I did not run the SvelteKit dev server or render a real report; findings are from static reading of code + the producer. A second pass that opens a real Stage 7 report with a bearing annex and an inclined wall would empirically confirm REPORTING-A-01 and REPORTING-A-03 end-to-end.
- No paired docs (`docs/*.md`) cover this subsystem, so dimension C yielded no doc-vs-code discrepancies; the in-app reference page (`src/routes/docs/reference/+page.svelte`) was not deeply reviewed for reporting claims.
