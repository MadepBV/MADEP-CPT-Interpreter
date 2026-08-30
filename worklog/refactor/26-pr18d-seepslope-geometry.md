# 26 — PR 18d `refactor(seepslope): geometry and the line probe`

Base `integration-r` @ 4974167 (v0.6.0 tip; controller 11 093 lines, PR 18a + 18b + 18c merged), the
fourth Seep / Slope sub-step of `01-monolith-map.md` §6.2 step 9 (PLAN §2 row 18d; map §2.11 group
**"Geometry, picking, line probe"** 9354-10201 at 462fc50, §6.1 row `seepslope/` `geometry/polygons.js`
+ `geometry/line-probe.js`). Executed by a Fable agent in an isolated worktree, **one commit** — a pure
move, no behaviour change, no `tests/golden/CHANGELOG.md` entry.

| | hash | |
|---|---|---|
| 1 | *this commit* | `refactor(seepslope): geometry and the line probe` |

File set: `src/lib/cpt-app/legacy-controller.js` (the import block and the geometry / probe region
only), new `src/lib/cpt-app/seepslope/geometry/**` (6 files) and `src/lib/cpt-app/seepslope/probe/**`
(4 files), new `scripts/verify_seepslope_geometry.mjs`, this report. `package.json`, `tests/**`,
`scripts/golden/**`, `seepslope/{state,model,run}/**`, the canvas / pointer / viewport region (step 9e),
the panel and results regions (step 9f), every HTML string and every class attribute untouched; nothing
under `retaining/`, `import-review/` or `src/lib/styles/**`.

`npm run golden:check` **2 086 / 0 / 0 / 0** before and after. `legacyApi` **167 names**, unchanged
(handler verifier: 273 files scanned, 429 inline `on*=` attributes, 180 published, every inline handler
resolved).

---

## 1. What moved

Line numbers are `integration-r` @ 4974167. The region is contiguous: **5157-6003**, 847 lines, the map's
"Geometry, picking, line probe" group in full. Every moved body was cut at its `function name(` anchor and
read back against the new module; **31 of the 37 bodies are textually identical** after applying the
rename map (checked mechanically, comments and blank lines ignored), and the other **6 differ only in
their signature** — the explicit parameter that replaced an `S` read, a viewport read or a helper from a
region that is not extracted yet. Nothing else changed inside a body.

### 1.1 `seepslope/geometry/`

| Monolith (old) | New module → export | Change | Controller now |
|---|---|---|---|
| `stage6BishopDist` 5157 | `points.js` → `dist` | none | import alias |
| `stage6BishopSegmentOrientation` 5656 | `points.js` → `segmentOrientation` | none | import alias |
| `stage6BishopPointOnSegment` 5707 | `points.js` → `pointOnSegment` | none | import alias |
| `stage6BishopSegmentsIntersectClosed` 5660 | `points.js` → `segmentsIntersectClosed` | none | import alias |
| `stage6BishopClosestPointOnSegment` 5730 | `points.js` → `closestPointOnSegment` | none (`clampRegionPoint` from `seepslope/state/regions.js`) | import alias |
| `stage6BishopUniqueSortedNumbers` 5837 | `points.js` → `uniqueSortedNumbers` | none | import alias |
| `stage6BishopPointInPolygon` 5161 | `polygons.js` → `pointInPolygon` | none | import alias |
| `stage6BishopPointInsideOrBoundary` 5720 | `polygons.js` → `pointInsideOrBoundary` | none | import alias |
| `stage6BishopPolygonCentroid` 5205 | `polygons.js` → `polygonCentroid` | none | import alias |
| `stage6BishopPolygonIsValid` 5652 | `polygons.js` → `polygonIsValid` | none | import alias |
| `stage6BishopValidateHolePolygon` 5677 | `polygons.js` → `validateHolePolygon` | none | import alias |
| `stage6BishopPickRegionBoundaryPoint` 5746 | `boundary.js` → `pickRegionBoundaryPoint(region, world, tolerance)` | **signature**: the viewport-derived pick tolerance became a third parameter, a number **or a `() => number`**, resolved at the very statement the monolith called `stage6BishopBoundaryPickToleranceWorld()` — after the nearest-edge loop, and only when an edge was found | façade `(region, world)` passing the tolerance function |
| `stage6BishopTraverseBoundary` 5792 | `boundary.js` → `traverseBoundary` | none | import alias |
| `stage6BishopBuildSplitBoundary` 5804 | `boundary.js` → `buildSplitBoundary` | none | import alias |
| `stage6BishopBoundaryYAtX` 5846 | `boundary.js` → `boundaryYAtX` | none | import alias |
| `stage6BishopPolygonIntervalsDetailed` 5855 | `boundary.js` → `polygonIntervalsDetailed` | none | import alias |
| `stage6BishopSubtractDetailedIntervals` 5890 | `boundary.js` → `subtractDetailedIntervals` | none | import alias |
| `stage6BishopSubtractHoleFromPolygon` 5932 | `boundary.js` → `subtractHoleFromPolygon` | none | import alias |
| `stage6BishopSplitRegionPolygon` 5963 | `boundary.js` → `splitRegionPolygon` | none | import alias (still the `splitPolygon` hook of `state/regions.js splitSelectedRegion`) |
| `stage6BishopDisplayRegions` 5640 | `regions.js` → `displayRegions(model, bishop)` | **signature**: `S?.stage6?.bishop`, which the body read *only* as an existence guard, became the second parameter | façade `(model)` |
| `stage6BishopShowingCustomRegionPreview` 5648 | `regions.js` → `showingCustomRegionPreview` | none | import alias |
| `stage6BishopRegionAtPoint` 5175 | `regions.js` → `regionAtPoint` | none | import alias |
| `stage6BishopTooltipHtml` 5184 | `regions.js` → `regionTooltipHtml(region, env)` | **signature**: `env.strengthSet` (a value **or a function**) and `env.strengthSetLabel`; the body is otherwise verbatim, the template literal included | façade passing `() => S.stage6.bishop.strengthSet` and `stage6BishopStrengthSetLabel` |
| `stage6BishopRegionShortLabel` 5199 | `regions.js` → `regionShortLabel` | none | import alias |
| `stage6BishopRegionLegendItems` 5235 | `regions.js` → `regionLegendItems` | none | import alias |
| `stage6BishopMeasurementMetrics` 5254 | `measurement.js` → `measurementMetrics` | none | import alias |
| `stage6BishopMeasurementLabel` 5275 | `measurement.js` → `measurementLabel` | none | import alias |
| `stage6BishopMeasurementVectors` 5423 | `measurement.js` → `measurementVectors` | none | import alias |

### 1.2 `seepslope/probe/`

| Monolith (old) | New module → export | Change | Controller now |
|---|---|---|---|
| `stage6BishopLineProbeOptions` 5280 | `options.js` → `lineProbeOptions(workspace, analysisType, hasHs, env)` | **signature**: the deformation branch's three catalogue calls became `env.*` hooks (§2.1); `readCssToken` is imported from `core/css-tokens.js` | façade passing `SEEPSLOPE_PROBE_ENV` |
| `stage6BishopLineProbeMeta` 5341 | `options.js` → `lineProbeMeta(…, env)` | **signature**: forwards `env` | façade |
| `stage6BishopLineProbeFormatValue` 5346 | `options.js` → `lineProbeFormatValue` | none (`compactNumber` from `core/format.js`) | import alias |
| `stage6ClipboardNumber` 5352 | `clipboard.js` → `clipboardNumber` | none | import alias |
| `stage6BishopLineProbeClipboardValueHeader` 5361 | `clipboard.js` → `lineProbeClipboardValueHeader` | none | import alias |
| `stage6BishopLineProbeClipboardText` 5375 | `clipboard.js` → `lineProbeClipboardText` | none | import alias |
| `stage6BishopLineProbeStats` 5433 | `line-probe.js` → `lineProbeStats` | none | import alias |
| `stage6BishopIntegrateLineProbe` 5452 | `line-probe.js` → `integrateLineProbe` | none | import alias |
| `stage6BishopBuildLineProbe` 5468 (148 lines) | `line-probe.js` → `buildLineProbe(bishop, workspace, measurementMetrics, env)` | **signature**: `S?.stage6?.bishop` became the first parameter, `STAGE6_ENABLE_HARDENING_SOIL_UI` and two catalogue calls became `env.*`; the four samplers are imported from `seepage/solver.js` and `deformation/solver.js` | façade `(workspace, measurementMetrics)` |

### 1.3 What deliberately stayed in the controller

| Name | Why |
|---|---|
| `stage6CopyTextFallback` 5387, `stage6CopyTextToClipboard` 5410 | browser clipboard APIs (`navigator.clipboard`, a `<textarea>` in `document.body`) — not maths |
| `stage6BishopCopyLineProbeData` 5617 **H** | a handler: `ensureStage6State()` + `S.stage6Cache` + `renderStage6()` |
| `stage6BishopBoundaryPickToleranceWorld` 5742 | reads the canvas viewport (`stage6BishopSnapToleranceWorld()`) — **step 9e** |

Everything else in the map's group (`ScreenToWorld`, `WorldToScreen`, `SnapToleranceWorld`,
`CollectSnapPoints`, `NearestPointSnap`, `SnapWorldPoint`, `NearestHandle`, `PickSurfaceLoadAtWorld`,
`PickWallAtWorld`, `CommitDrawPoint`, the pointer handlers, `UpdateHoverDom`) is pointer / viewport /
DOM and is left for **step 9e** as briefed.

Imports dropped from the controller because their last reader moved: `isSimplePolygon` and `polygonArea`
(`soil-regions`), `sampleSeepageHead`, `sampleSeepagePorePressure`, `sampleSeepageFlowState`
(`seepage/solver`). `normalizeRegionPolygon`, `contourSegmentsForTriangles`, `sampleDeformationState`,
`readCssToken` and `stage6CompactNumber` still have readers and stay.

## 2. The packages

| File | Lines | Exports |
|---|---|---|
| `geometry/index.js` | 25 | the flat surface below + the `points` / `polygons` / `boundary` / `regions` / `measurement` namespaces (33 names) |
| `geometry/points.js` | 87 | `dist`, `segmentOrientation`, `pointOnSegment`, `segmentsIntersectClosed`, `closestPointOnSegment`, `uniqueSortedNumbers` |
| `geometry/polygons.js` | 116 | `pointInPolygon`, `pointInsideOrBoundary`, `polygonCentroid`, `polygonIsValid`, `validateHolePolygon` |
| `geometry/boundary.js` | 311 | `pickRegionBoundaryPoint`, `traverseBoundary`, `buildSplitBoundary`, `boundaryYAtX`, `polygonIntervalsDetailed`, `subtractDetailedIntervals`, `subtractHoleFromPolygon`, `splitRegionPolygon` |
| `geometry/regions.js` | 90 | `displayRegions`, `showingCustomRegionPreview`, `regionAtPoint`, `regionTooltipHtml`, `regionShortLabel`, `regionLegendItems` |
| `geometry/measurement.js` | 59 | `measurementMetrics`, `measurementLabel`, `measurementVectors` |
| `probe/index.js` | 28 | the flat surface below + the `options` / `clipboard` / `lineProbe` namespaces (12 names) |
| `probe/options.js` | 105 | `lineProbeOptions`, `lineProbeMeta`, `lineProbeFormatValue` |
| `probe/clipboard.js` | 54 | `clipboardNumber`, `lineProbeClipboardValueHeader`, `lineProbeClipboardText` |
| `probe/line-probe.js` | 226 | `lineProbeStats`, `integrateLineProbe`, `buildLineProbe` |

1 101 lines. SPDX + `@ts-nocheck`, a header naming the source lines and the contract, `.js` imports; both
packages load under plain Node. Dependencies outside the packages: `soil-regions.js`
(`polygonArea` / `isSimplePolygon` / `normalizeRegionPolygon`), `seepslope/state/regions.js`
(`clampRegionPoint` / `roundRegionCoord`), `core/format.js` (`compactNumber`), `core/css-tokens.js`
(`readCssToken` — it falls back to the light palette without a document, as PR 13 made it), and the two
solver samplers. **No `S`, no DOM, no canvas, no viewport, no render.**

Every degenerate answer is the monolith's and is documented per function: an empty polygon is never
"inside", a zero-area polygon falls back to the vertex average for its centroid, a horizontal edge is
skipped by the ray cast (the `|| 1e-12` guard), a zero-length segment falls back to the distance to its
start point, a non-finite coordinate reads as 0 in `dist`, `uniqueSortedNumbers` drops NaN / ±Infinity,
`measurementVectors` divides by 1e-9 on a degenerate line, and a probe sample outside the solved domain
keeps its `x / y / s` and stores `value: null` so the chart shows a gap instead of dropping the abscissa.

### 2.1 The two `env` hooks, and why they are hooks and not a duplicated catalogue

The line probe's deformation quantity list *is* the deformation-contour catalogue
(`stage6BishopNormalizedDeformationAnalysisType`, `DeformationContourOptions`, `DeformationContourMeta`)
and its `hydraulicFs` sample *is* the seepage-contour helper (`stage6BishopSeepageHydraulicFs`). Both live
in map §2.11's "Deformation contours" / "Seepage state + contours" groups — regions this PR must not
touch (their extraction is its own step). Duplicating 24 quantity metas into the probe package is exactly
the drift a strangler step is supposed to remove, so they are passed in instead, as one object built in
the geometry region of the controller:

```js
const SEEPSLOPE_PROBE_ENV = {
  hardeningSoilUi: STAGE6_ENABLE_HARDENING_SOIL_UI,
  normalizedDeformationAnalysisType: (t = null) => stage6BishopNormalizedDeformationAnalysisType(t),
  deformationContourOptions: (t, hs) => stage6BishopDeformationContourOptions(t, hs),
  deformationContourMeta: (id, t) => stage6BishopDeformationContourMeta(id, t),
  seepageHydraulicFs: (g, m) => stage6BishopSeepageHydraulicFs(g, m)
};
```

`env` is only read in the deformation branch and in the `hydraulicFs` sample; the seepage and stability
branches are pure, and `lineProbeOptions('seepage')` works with no `env` at all (the verifier's (d) group
proves it). When the contour catalogues are extracted, `env` shrinks to the `hardeningSoilUi` flag and the
package imports them directly.

The same value-or-function convention that PR 18a used for `createDrainFromVertices({model})` is used
twice more here, and for the same reason — to keep the **timing** of a host read identical:
`pickRegionBoundaryPoint`'s `tolerance` is read after the nearest-edge loop and only when an edge was
found; `regionTooltipHtml`'s `strengthSet` is read only for a material without a `sourceStrengthSet`, and
never for a region without a material.

## 3. Controller

| | lines |
|---|---|
| before (4974167) | 11 093 |
| after | **10 414** (−679; `git diff --stat`: 88 insertions, 767 deletions) |

Three hunks only (`git diff integration-r`): the two `./seepage/solver` / `./soil-regions` import lines
(dead names dropped), one 53-line block of two new imports placed **after** the `seepslope/run` import
(29 geometry names + 9 probe names, under a comment naming the step), and the geometry / probe region
5157-6003 (847 lines → 115 lines: a banner, `SEEPSLOPE_PROBE_ENV`, six façades and the three functions of
§1.3, verbatim). Nothing else — the canvas, the pointer handlers, the tool rail, the panels, the results,
`renderStage6BishopApp` and every HTML string are byte-identical.

## 4. `scripts/verify_seepslope_geometry.mjs` — **1 833 passed, 0 failed**

Pattern of `verify_seepslope_{state,model,run}.mjs`: two child processes, each loading one controller
through the Tier-B loader in its own Vite server, dumping the same observations as JSON with key order
preserved; the parent compares byte for byte and prints the first differing path.
`--base <ref>` / `--snapshot f.json` / `--against f.json` as usual. ≈ 11 min wall-clock.

**The one new idea: both controllers are materialised with the same appended `export { … }` block.**
The moved functions are module-local in the base and import aliases / façades in the working tree, and
almost none of them is on `legacyApi` — so neither dump could reach them. The parent writes
`src/lib/cpt-app/__verify-seepslope-geometry-{base,tree}.legacy-controller.js` = the controller text +
an identical 52-name `export { … }` block (`export { x }` is legal for an imported binding, so the same
text works on both sides), and deletes both in a `finally`. The block adds exports and nothing else; it is
what makes a *pure-function* extraction directly comparable base-vs-tree for the first time.

| Group | What |
|---|---|
| (a) the grid — **34 function groups, 5 393 cases** | every moved function over a grid built from 13 points, 15 polygons, 10 segments, 5 tolerances, 6 materials, 19 numbers, region / model / probe / sample / interval literals and 3 viewport scales. Degenerate on purpose: empty, one- and two-point polygons, coincident points, vertical and zero-length segments, a bow-tie, collinear and duplicated vertices, a 1e-3 m² polygon, a 1e10 m² polygon, NaN / ±Infinity / string / null / missing coordinates, `null` regions and models, unknown quantities, an out-of-range edge index. **30 calls throw — the exception message is compared too.** Coverage assertions: `splitRegionPolygon` reached **5 distinct refusals and 62 successful splits** (a second group feeds it cut points that really come from `pickRegionBoundaryPoint`, so they carry `edgeIndex` / `vertexIndex` / `t`), `validateHolePolygon` its three refusals and its success, `pickRegionBoundaryPoint` vertex hits at `t = 0` and `t = 1`, edge points and `null`, `lineProbeOptions` the 8 seepage quantities and a non-empty deformation list |
| (b) the probe readout — **8 CPTs, 800 observations** | the seeded `loadDemo()` CPT and every CPT of `legacy-v0.5.2` / `multi-3cpt` / `single-layered`, each made runnable the way the seep-slope journey makes it runnable (the bishop suite's terrain + zones, two side head BCs through `SelectSeepageBoundary` / `SetSeepageBcType` / `SetSeepageBcHead`, mesh 1.0 m²) and then **solved in process** — `analyzeSeepageModel` on the app's own model, plus one js-cpu linear-elastic `analyzeDeformationModel` written into `bishop.deformation` exactly as the run reducer writes it (`mesh = output.mesh`, `result = output`). Per CPT: 8 seepage × 5 lines + 10 deformation × 5 lines + the stability refusal + the "solved mesh, no result" refusal + the `safety-cphi` catalogue = 99 observations, each with the **full probe object** (deep-equal + key order), its clipboard text and header, and the three formatted statistics; plus one `renderStage6()` per workspace with `#stage6Area` innerHTML (54–83 k chars) and `stage6BishopCopyLineProbeData()` byte for byte. The five measurement lines are derived from each model's own bounds — across the section, partly outside, wholly outside, vertical, degenerate — so **every probe status is reached** (ready 440, no-valid-samples 144, missing-measurement 144, missing-result 8, unsupported 40), 208 of them with partial coverage and 24 with the two `normalFlow` cross-flow integrals |
| (c) the callers — **23 steps** | a walk on `layered` under a seeded clock (1 s ticks) + PRNG (mulberry32) so `region_` ids are compared verbatim: copy-regions-to-custom, use-custom-regions, four region drafts (valid, degenerate, self-intersecting, two-point), five splits (two boundary points, coincident, outside, no draft, no selection), four hole drafts (inside, outside its parent, two-point, self-intersecting), a terrain draft, `PopDraftPoint`, the measure tool, `CopyLineProbeData` without a solved field, `ClearMeasurement` and two `Clear` modes. After every step: exception, `S.stage6.bishop` (deep-equal + key order), `S.stage6.ui`, `progress.message`, `#stage6Area` innerHTML, the alerts, the rAF errors and the running `Date.now()` / `Math.random()` count — plus 7 assertions that the walk did what its labels say (the monolith's refusal strings, verbatim) |
| (d) the packages standalone (working tree) | the **31 controller names are the package's own function objects** (`geom.dist === stage6BishopDist`, …); both index modules expose their per-file namespaces and **exactly** the 33 / 12 documented names; **no geometry function mutates any of its inputs** over the whole polygon × point × segment grid; `pickRegionBoundaryPoint` gives the same answer for a number and a `() => number` and calls the function **once, only when an edge was found**; `regionTooltipHtml` reads the fallback strength set **lazily** (never without a material, never when the material carries its own); `buildLineProbe` leaves the bishop block it is handed untouched, drives the env hooks in order and reaches `ready`; `displayRegions` returns `[]` without a bishop block; `lineProbeOptions` works with no `env` in seepage and stability |
| (e) the goldens — **37 files** | recomputed in **both** controllers and compared byte for byte with the files on disk: `tests/golden/node/bishop/cpt.<fx>.{model,materials,search,run-handler}.json` for the 7 Stage 6 profile fixtures (the app path that renders through `displayRegions` / `regionLegendItems` / `measurementLabel` / `lineProbeOptions`), `tests/golden/node/seepage/{cpt.layered.app-boundary,cpt.layered.state,cpt.layered.run-handler,cpt.layered.mesh,cpt.layered.result,base-fixed-head.samples}.json` and `tests/golden/node/deformation/base.js-cpu.linear-elastic.t3.a0.5.{mesh,result,samples}.json` — the two `.samples.json` cases are the very `sampleSeepage*` / `sampleDeformationState` calls `buildLineProbe` makes |

One masking decision, documented in the script: the Stage 6 panel prints the solver's **wall-clock
runtime** (`Total runtime: 0.0792 s`, `Runtime: 0.1694 s`), which differs between two processes by
construction, so `#stage6Area` is compared after the golden harness's own two timing patterns
(`normalize.mjs` `MASK_SUBSTRING_PATTERNS`: `<n> ms` and `<n> s`) — and **only** those, so entity ids and
every other number in the markup stay compared byte for byte.

`package.json` line for the main session (**not** added here, as briefed):

```json
"verify:seepslope-geometry": "node scripts/verify_seepslope_geometry.mjs",
```

Like the other `verify_*` movers it needs the Vite dev dependency and a reachable base ref; on a PR
branch use `--base origin/main`, or `--against` a committed `--snapshot`.

## 5. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — base 4974167 | 2 086 PASS / 0 FAIL / 0 NEW / 0 MISSING, 67 s |
| `npm run golden:check` — after the move | **2 086 / 0 / 0 / 0**, 67 s (`bishop` 71, `seepage` 41, `deformation` 37, `stage6-shared` 15, `chart-configs` 203, `report` 22 … all bit-identical) |
| `node scripts/verify_seepslope_state.mjs` | **1 110 / 1 110** |
| `node scripts/verify_seepslope_model.mjs --base 09b9c9b` | **1 301 / 1 301** |
| `node scripts/verify_seepslope_run.mjs` | 1 249 / 6 — **pre-existing base drift, not this PR**, see §6.1 |
| `node scripts/verify_seepslope_geometry.mjs` | **1 833 / 1 833** |
| `npm run verify:core` | stops at `verify:seepslope-run` for the reason in §6.1; every other step green, run individually: handlers OK (180 published, **legacyApi 167**), core-helpers, model-params, classification-layers, load, export-report, bearing, pile, settlement-dewatering-beam, seepslope-state, seepslope-model, project-section-tuning, nen6740, stratigraphy, import-review, project-io, scia-db4, qc-only, retaining, wasm, bishop-phase-a — all exit 0 |
| `npm run build` | `✔ done`, exit 0; the three worker chunks emitted as before |
| `npm run check` | 509 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `seepslope/**` |
| `GOLDEN_PORT=5699 GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs --grep seep-slope` | **1 passed** twice (25.4 s before the commit, 1.7 min on the committed tree — the second run shared the machine with a golden suite): 13 steps, state + DOM text byte-identical; bishop search 1 082 / 1 604 ms, seepage 244 / 595 ms, deformation 1 101 / 2 707 ms. **No `09-seepage-bcs` flake** (report 22 §5.2) in either run |

The journey ran against a dev server started from the worktree with a scratch `.mts` Vite config under
this session's scratchpad (report 19 §5 + report 22 §5.3: `root` = the worktree, `server.fs.allow` += the
real `node_modules` path, the `**/.claude/**` watcher ignore dropped — the worktree *is* under
`.claude/`, so keeping it would silence the whole tree — and a `node_modules` symlink next to the
config), on port 5699; Playwright's `reuseExistingServer` picked it up. The three `visual (soft)`
mismatches (`01-bishop-empty`, `02-terrain`, `08-stability`) are the pre-existing machine-wide PNG drift
of report 22 §5.1; the deterministic halves (`state.json`, `dom.txt`) are byte-identical in every step.

### 5.1 A mechanical fidelity check next to the behavioural one

Besides the verifier, each moved body was compared **textually** with the base after applying the
rename map (comments and blank lines ignored): **31 of the 37 bodies are character-for-character
identical**, and the 6 that differ do so **only in their signature** — `regionTooltipHtml(region, env)`,
`lineProbeOptions(…, env)`, `lineProbeMeta(…, env)`, `buildLineProbe(bishop, …, env)`,
`displayRegions(model, bishop)`, `pickRegionBoundaryPoint(region, world, tolerance)` — exactly the six
"change" rows of §1. The script is a throwaway (it lives in the session scratchpad, not in the repo);
what ships as evidence is the verifier.

## 6. Findings

1. **`verify:seepslope-run` is 6 checks short against its default base — pre-existing, not this PR.**
   Its `running-fix` group asserts that the *base* controller still reproduces the defect PR 18c commit 2
   fixed (a rejected run leaving `progress.running = true`). The fix, however, lives in
   `seepslope/run/search.js` / `seepage.js` / `deformation.js` — **the package**, which the base
   controller imports from the working tree (report 24 §5: "No `MOVED_SIBLINGS` are needed"). So the base
   carries the fix whatever `--base` says: `--base dd4a6cb` (PR 18c commit 1, before the fix) fails the
   same 6 checks, and each failure reads `base false → tree false`. This is the same class of base drift
   report 24 §7.1 found — and 4974167 fixed — for `verify:seepslope-model`. Fix: materialise the base's
   own `seepslope/run/**` as `MOVED_SIBLINGS`, or make the three checks read "the base either reproduces
   the defect or already carries the fix", as the model verifier now does. Harness owner. `verify:core`
   stops there, so the later steps were run one by one (§5).
2. **`stage6BishopBoundaryPickToleranceWorld` is the only thing keeping `pickRegionBoundaryPoint` out of
   the pure package**, and it is a two-line viewport read (`14 / max(scale, 1)`). When step 9e extracts
   `canvas/viewport.js`, the façade becomes a one-liner over the package's `snapToleranceWorld(viewport)`
   and the value-or-function convention can go.
3. **The line probe is the only reader of three seepage samplers and of `STAGE6_ENABLE_HARDENING_SOIL_UI`
   inside Stage 6's geometry.** With the samplers moved, the controller's `seepage/solver` import is down
   to `contourSegmentsForTriangles` (a draw-path helper, step 9e) — so after 9e that import disappears
   entirely.
4. **`stage6BishopDisplayRegions` never needed the bishop block.** It reads it only as a guard
   (`if(!model || !bishop) return []`), so under the composition root the parameter can simply go. Kept
   verbatim here because dropping the guard would change what an un-ensured state renders.
5. **The split tool's cut points must come from `pickRegionBoundaryPoint`.** A hand-written `{x, y}` pair
   has no `edgeIndex` / `vertexIndex`, so `buildSplitBoundary` inserts nothing and `splitRegionPolygon`
   always answers "Choose two separate polygon-boundary points" — which is why the verifier's grid feeds
   it *picked* points as well as raw literals (62 successful splits vs 0). Worth knowing for step 9e's
   pointer tests and for any future API that takes a chord.
6. **`stage6BishopTooltipHtml` is the last geometry reader of the results region** (it formats the
   strength set with `stage6BishopStrengthSetLabel`, map §2.11 "Result HTML / labels"). Step 9f should
   import `regionTooltipHtml` and hand it the label function from the results module, or move the
   4-line `strengthSetLabel` into `seepslope/results/` and drop the hook.
7. **`stage6BishopRegionLegendItems`, `RegionShortLabel`, `PolygonCentroid` and `MeasurementLabel` are
   canvas *and* panel readers** — all four are pure, so they moved (the brief's "move it only if it is
   pure" rule). The canvas keeps them under their monolith names as import aliases, so step 9e's draw
   split will not have to touch them.

## 7. Follow-ups (not in this PR)

1. Main session / harness owner: `"verify:seepslope-geometry": "node scripts/verify_seepslope_geometry.mjs"`
   in `package.json` (§4), and finding 1 (`verify:seepslope-run`'s base drift).
2. Step 9e: `canvas/viewport.js snapToleranceWorld` → drop the tolerance hook (finding 2); the pointer
   module takes the model and the canvas wrapper as inputs (report 21 finding 2, report 22 finding 4);
   replace the two duplicated inline wall-creation blocks with `state/walls.js addWall` and the `region`
   branch of `FinishDraft` with `state/regions.js addCustomRegion`.
3. The deformation- and seepage-contour catalogues (map §2.11): when they move to
   `seepslope/deformation/contours.js` / `seepslope/seepage/contours.js`, `SEEPSLOPE_PROBE_ENV` shrinks
   to the `hardeningSoilUi` flag and `probe/options.js` imports them directly (§2.1; report 21 finding 5
   named this step).
4. Step 9f: import the probe's formatters and `regionTooltipHtml` in the panel modules (they already take
   explicit inputs), and settle `strengthSetLabel` (finding 6).
