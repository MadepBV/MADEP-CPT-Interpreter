# 17 — PR 12c `refactor(settlement, dewatering, beam): packages in the retaining style`

Base `integration-r` @ 07f0645 (v0.6.0 tip: PR 4/5/6/8/9/11/12a/12b/14 merged; controller 13 301 lines), the
last three apps of `01-monolith-map.md` §6.2 step 7 (PLAN §2 row 12, map §2.9 Settlement / Dewatering / Beam,
§6.1 rows `settlement/`, `dewatering/`, `beam/`). Executed by a Fable agent in an isolated worktree, **three
commits, one per package, each leaving the tree green** — the order of the app switch:

| Commit | Package | Controller after |
|---|---|---|
| `5798592` `refactor(settlement): package in the retaining style` | `src/lib/cpt-app/settlement/` (6 files, 461 lines) | 13 089 lines (−212) |
| `26bed2a` `refactor(dewatering): package in the retaining style` | `src/lib/cpt-app/dewatering/` (6 files, 433 lines) | 12 883 lines (−206) |
| (this commit) `refactor(beam): package in the retaining style` | `src/lib/cpt-app/beam/` (7 files, 980 lines) | 12 192 lines (−691) |

File set: `src/lib/cpt-app/legacy-controller.js` (the three apps' regions only), the three new packages,
`src/lib/cpt-app/stage6/registry.js` + `stage6/apps/{settlement,dewatering,beam}-state.js` (minimal: the
package import / re-export), new `scripts/verify_settlement_dewatering_beam.mjs` (added in the first commit,
extended in each), this report. `package.json`, `tests/`, `scripts/golden/**`, `stage6-engineering.js`,
`chart-factories.js`, the bearing / pile / project / section / tuning / export / report / bishop regions and the
Svelte templates untouched.

Three pure moves: `npm run golden:check` 1 619 / 0 / 0 / 0 before and after every commit — no golden updated,
no `tests/golden/CHANGELOG.md` entry. The new verifier compares the base controller (integration-r, loaded from
git through the Tier-B loader) with the working tree: every rendered page of the three apps, every Chart.js
config, the beam geometry preview's canvas draw log, the cached analysis and the clamped config byte-identical
on the demo CPT through **every inline `setStage6Field` handler the three markups carry** (16 + 16 + 36) and on
the 7 CPTs of the three project fixtures; and the 56 + 56 + 63 `stage6-{settlement,dewatering,beam}` goldens
reproduced byte for byte from the pure package functions. Final run: **2 260 passed, 0 failed**.

## 1. What moved (verbatim bodies; only the controller-state reads became parameters)

Old line numbers are those of 07f0645 (integration-r). The generator that cut the bodies located each
`function name(` anchor (asserting uniqueness and the closing `}` at column 0) in the base controller, applied
the identifier renames below with asserted substitutions (every target present; the `S` reads replaced exactly
once), and scanned each module's code (comments excluded) for leftover controller identifiers (`S.`,
`stage6*(`, `stage6DetailsOpen`, `stage6NoteHtml`, `stage6Tooltip`, `stage6LoadSummaryHtml`,
`stage6DestroyChart`, `stage6CompactNumber`, `stage6MaxDepth`, `stage6WorkingLayers`, `PROJECT`): none.

### 1.1 Settlement (commit 1)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `stage6/apps/settlement-state.js` (32, PR 11) | `settlement/state.js` → `defaults()`, `ensure(stage6, env)` | header only | `stage6/apps/settlement-state.js` is a 7-line re-export (PR 12a/12b pattern); `stage6/index.js`'s `settlementState` namespace still resolves |
| `stage6UseCategoryOptions` 9185-9199, `stage6UseCategoryHelp` 9201-9213, `stage6SlsCombinationOptions` 9215-9224, `stage6SlsCombinationHelp` 9226-9238 | `settlement/options.js` → `useCategoryOptions`, `useCategoryHelp`, `slsCombinationOptions`, `slsCombinationHelp(selected, context)` | names only | four one-line façades **until commit 3** (the beam markup was their other caller), then gone |
| `renderStage6SettlementApp` 9478-9654 | `settlement/panel.js` → `settlementBodyHtml(analysis, cfg, {detailsOpen})` | `const cfg = S.stage6.settlement` → parameter; `stage6DetailsOpen(` → the `detailsOpen` host hook; `stage6LoadSummaryHtml` / `stage6NoteHtml` → `core/format`; the four option builders by their new names | façade `settlementApp.renderBody(analysis)` |
| `buildStage6SettlementCharts` 12485-12505 | `settlement/chart.js` → `buildSettlementCharts({analysis, maxDepth})` + `SETTLEMENT_CHART_IDS` | `S.stage6Cache?.settlement` → parameter; `maxDepth:stage6MaxDepth()` → `maxDepth`; `stage6DestroyChart` → `core/chart-host destroyChart` | façade `settlementApp.buildCharts()` |
| shell adapter `apps.settlement` 339-343 (`analyzeSettlement(layers, S.wt, S.stage6.settlement)`) | `settlement/compute.js` → `settlementAnalysis(cfg, layers, env)` (explicit-input contract around the unchanged `stage6-engineering.js analyzeSettlement`) + `settlement/index.js` → `installSettlementApp(ctx)` | — | `{ compute: settlementApp.compute, body: settlementApp.renderBody, postRender: settlementApp.postRender }` |
| registry entry `entry('settlement', 'Settlement', 'Settlement', '…', settlementState)` | `settlement/index.js` → `cardMeta` | — | `entry('settlement', 'Settlement', settlementApp.cardMeta.title, settlementApp.cardMeta.desc, settlementApp)` with `import * as settlementApp from '../settlement/index.js'` |

Imports dropped from the controller: `analyzeSettlement` (engineering), `buildSettlementCumulativeChartConfig`,
`buildSettlementStressChartConfig` (chart factories). Added, after the `pile/` import: `installSettlementApp` and
the four option builders under `settlement*` aliases (for the façades; gone in commit 3).

### 1.2 Dewatering (commit 2)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `stage6/apps/dewatering-state.js` (32, PR 11) | `dewatering/state.js` → `defaults()`, `ensure(stage6, env)` | header only | re-export at the old path |
| `stage6DewateringCombinationOptions` 9240-9246, `stage6DewateringCombinationHelp` 9248-9253 | `dewatering/options.js` → `combinationOptions`, `combinationHelp` | names only | dropped (one caller each, the moved panel) |
| `renderStage6DewateringApp` 9656-9832 | `dewatering/panel.js` → `dewateringBodyHtml(analysis, cfg, env)` | `const cfg = S.stage6.dewatering` → parameter; the **two `S.wt` reads** (the "Original WT" audit row, the `min` of the target-water-table input) → `env.wt` read once through `waterTableOf` (finite, throws otherwise); `stage6LoadSummaryHtml` / `stage6NoteHtml` → `core/format`; the two combination builders by their new names | façade `dewateringApp.renderBody(analysis)` |
| `buildStage6DewateringCharts` 12507-12534 | `dewatering/chart.js` → `buildDewateringCharts({analysis, maxDepth, originalWt})` + `DEWATERING_CHART_IDS` | `S.stage6Cache?.dewatering` → parameter; `maxDepth:stage6MaxDepth()` → `maxDepth`; `originalWt:S.wt` → `originalWt`; `stage6DestroyChart` → `destroyChart` | façade `dewateringApp.buildCharts()` |
| shell adapter `apps.dewatering` 344-348 | `dewatering/compute.js` → `dewateringAnalysis(cfg, layers, env)` + `dewatering/index.js` → `installDewateringApp(ctx)` | — | the package's three closures |
| registry entry | `dewatering/index.js` → `cardMeta` | — | `entry('dewatering', 'Dewatering', dewateringApp.cardMeta.title, …, dewateringApp)` |

Imports dropped: `analyzeDewatering`, the three `buildDewatering*ChartConfig` and `buildTimeChartConfig` (its
last controller caller went with the two chart modules). Added: `installDewateringApp`.

### 1.3 Beam / slab (commit 3)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `stage6/apps/beam-state.js` (67, PR 11) | `beam/state.js` → `defaults()`, `ensure(stage6, env)` | header only | re-export at the old path |
| `stage6BeamUlsOptions` 9255-9261, `stage6BeamUlsHelp` 9263-9268, `stage6BeamLoadPatternHelp` 9270-9278, `stage6BeamModelModeOptions` 9280-9289, `stage6BeamModelModeLabel` 9291-9298, `stage6BeamAxisCopy` 9300-9341, `stage6BeamMomentContextHelp` 9343-9349, `stage6ExposureOptions` 9364-9368, `stage6ExposureHelp` 9370-9373 | `beam/options.js` → `ulsOptions`, `ulsHelp`, `loadPatternHelp`, `modelModeOptions`, `modelModeLabel`, `beamAxisCopy`, `momentContextHelp`, `exposureOptions`, `exposureHelp` (imports `EC2_EXPOSURE_META` from `stage6-engineering.js`) | names only | dropped (`stage6BeamModelModeLabel` had no caller at all — kept with the wording) |
| `stage6BeamOrientationHtml` 9351-9362, `stage6BeamDurabilityHtml` 9375-9410 | `beam/panel.js` → `orientationHtml(cfg, analysis)`, `durabilityHtml(reinf)` | `stage6Tooltip` → `core/format tooltip`; the wording builders by their new names | dropped (one caller each, the moved panel) |
| `renderStage6BeamApp` 9834-10083 | `beam/panel.js` → `beamBodyHtml(analysis, cfg, {detailsOpen})` | `const cfg = S.stage6.beam` → parameter; `stage6DetailsOpen(` → the host hook; `stage6Tooltip` / `stage6LoadSummaryHtml` / `stage6NoteHtml` → `core/format`; the beam wording → `options.js`, the Eurocode use-category / SLS-combination wording → `settlement/options.js` | façade `beamApp.renderBody(analysis)` |
| `buildStage6BeamCharts` 12536-12557 | `beam/chart.js` → `buildBeamCharts({analysis, cfg})` + `BEAM_CHART_IDS` | `S.stage6Cache?.beam` → parameter; `stage6DestroyChart` → `destroyChart`; `stage6CompactNumber` → `core/format compactNumber`; `drawStage6BeamGeometryPreview(analysis)` → `drawBeamGeometryPreview(analysis, cfg)` | façade `beamApp.buildCharts()` |
| `stage6BeamCanvasText` 12559-12569, `stage6BeamRoundedRect` 12571-12584, `stage6BeamDrawDimension` 12586-12614, `stage6BeamDrawLoadArrow` 12616-12632 | `beam/geometry-preview.js` → `canvasText`, `roundedRect`, `drawDimension`, `drawLoadArrow` | names only | dropped |
| `drawStage6BeamGeometryPreview` 12634-12813 | `geometry-preview.js` → `drawBeamGeometryPreview(analysis, cfg)` + `BEAM_GEOMETRY_CANVAS_ID` | `const cfg = S.stage6?.beam \|\| {}` → `cfg = cfg \|\| {}` (the parameter); the canvas id → the constant; `stage6BeamAxisCopy` → `options.js beamAxisCopy` | façade `beamApp.drawGeometryPreview(analysis)` (reads the active CPT's `stage6?.beam`, as before) |
| shell adapter `apps.beam` 349-353 | `beam/compute.js` → `beamAnalysis(cfg, layers, env)`, `subgradeReaction(cfg, layers, env)` (around the unchanged `analyzeBeamAndReinforcement` / `computeSubgradeReaction`) + `beam/index.js` → `installBeamApp(ctx)` | — | the package's three closures |
| registry entry | `beam/index.js` → `cardMeta` | — | `entry('beam', 'Beam/slab', beamApp.cardMeta.title, …, beamApp)` |

Imports dropped: `EC2_EXPOSURE_META`, `analyzeBeamAndReinforcement`, the two `buildBeam*ChartConfig`,
`loadSummaryHtml as stage6LoadSummaryHtml` (its last controller caller went with the beam panel), the four
`settlement*` option aliases of commit 1. Added: `installBeamApp`.

## 2. The packages

Every module: SPDX + `@ts-nocheck`, header naming the source lines and the renames, `.js` imports; each package
loads under plain Node (`import('./src/lib/cpt-app/<app>/index.js')`), so does `stage6/index.js` with the registry
importing all three.

| Package | File | Lines | Exports |
|---|---|---|---|
| `settlement/` | `index.js` | 73 | `installSettlementApp(ctx)`, `cardMeta`, + the surface below |
| | `state.js` | 36 | `defaults()`, `ensure(stage6, env)` |
| | `compute.js` | 41 | `settlementAnalysis(cfg, layers, env)`, `waterTableOf`, `layersOf`, re-export `analyzeSettlement` |
| | `options.js` | 71 | `useCategoryOptions`, `useCategoryHelp`, `slsCombinationOptions`, `slsCombinationHelp` |
| | `panel.js` | 194 | `settlementBodyHtml(analysis, cfg, {detailsOpen})` |
| | `chart.js` | 46 | `buildSettlementCharts({analysis, maxDepth})`, `SETTLEMENT_CHART_IDS` |
| `dewatering/` | `index.js` | 70 | `installDewateringApp(ctx)`, `cardMeta`, + the surface |
| | `state.js` | 37 | `defaults()`, `ensure(stage6, env)` |
| | `compute.js` | 43 | `dewateringAnalysis(cfg, layers, env)`, `waterTableOf`, `layersOf`, re-export `analyzeDewatering` |
| | `options.js` | 27 | `combinationOptions`, `combinationHelp` |
| | `panel.js` | 196 | `dewateringBodyHtml(analysis, cfg, env)` |
| | `chart.js` | 60 | `buildDewateringCharts({analysis, maxDepth, originalWt})`, `DEWATERING_CHART_IDS` |
| `beam/` | `index.js` | 82 | `installBeamApp(ctx)`, `cardMeta`, + the surface |
| | `state.js` | 72 | `defaults()`, `ensure(stage6, env)` |
| | `compute.js` | 51 | `beamAnalysis`, `subgradeReaction`, `waterTableOf`, `layersOf`, re-exports of the two engines |
| | `options.js` | 130 | the nine wording builders (§1.3) |
| | `panel.js` | 320 | `beamBodyHtml(analysis, cfg, {detailsOpen})`, `orientationHtml`, `durabilityHtml` |
| | `chart.js` | 47 | `buildBeamCharts({analysis, cfg})`, `BEAM_CHART_IDS` |
| | `geometry-preview.js` | 278 | `drawBeamGeometryPreview(analysis, cfg)`, the four canvas primitives, `BEAM_GEOMETRY_CANVAS_ID` |

```js
install<App>App(ctx) → { defaults, ensure, compute, renderBody, postRender, handlers: {}, cardMeta, buildCharts (+ beam: drawGeometryPreview) }
  ctx.getState()        S                      — all three
  ctx.layerBottom()     stage6MaxDepth()       — settlement, dewatering (the depth axis of the stress charts)
  ctx.detailsOpen(key)  stage6DetailsOpen(key) — settlement, beam (the `settlement-loads` / `beam-loads` accordions)
```

`compute(layers)` = `<app>Analysis(S.stage6.<app>, layers, {wt: S.wt})` — the engine call the shell adapter made
inline; `renderBody(analysis)` = the panel on the active config; `postRender()` = `buildCharts()`. `handlers` is
empty for all three: every input goes through the shell's `setStage6Field('<app>.…')` (16 + 16 + 36 inline
handlers, unchanged), and none of the three apps has a partial-update path like the bearing `Df` slider.

`compute.js` is the package's explicit-input contract around the **unchanged** engines of
`stage6-engineering.js` (`analyzeSettlement` :529, `analyzeDewatering` :950, `computeSubgradeReaction` :1141,
`analyzeBeamAndReinforcement` :1508 — not touched): `layers` must be an array and `env.wt` a finite number, else
the function throws (the bearing contract of PR 12a); the host façades never reach that path. The dewatering
panel reads the water table through the same `waterTableOf`.

### Controller wiring

```js
const settlementApp = installSettlementApp({ getState: () => S, layerBottom: () => stage6MaxDepth(), detailsOpen: (key) => stage6DetailsOpen(key) });
const dewateringApp = installDewateringApp({ getState: () => S, layerBottom: () => stage6MaxDepth() });
const beamApp       = installBeamApp({ getState: () => S, detailsOpen: (key) => stage6DetailsOpen(key) });
```

after `pileApp` and before `stage6Registry` (hoisted references only — `newCptState()` still calls
`stage6Defaults()` at module load, which reaches the three `state.js` through the registry's imports). The
three `apps.<id>` adapters of the shell are `{ compute, body, postRender }` closures over the instances, as for
bearing / pile.

## 3. Controller line-count delta

| | lines |
|---|---|
| before (07f0645) | 13 301 |
| after commit 1 (settlement) | 13 089 (−212) |
| after commit 2 (dewatering) | 12 883 (−206) |
| after commit 3 (beam) | **12 192** (−691; −1 109 over the three commits, 8.3 %) |

Hunks (`git diff integration-r`): the imports (§1), the three install blocks + the shell comment, the three
`apps.<id>` adapters, the settlement region 9185-9238 + 9478-9654 → two façades, the dewatering region
9240-9253 + 9656-9832 → two façades, the beam region 9255-9410 + 9834-10083 → one façade, the chart / canvas
region 12485-12813 → four façades (`buildStage6SettlementCharts`, `buildStage6DewateringCharts`,
`buildStage6BeamCharts`, `drawStage6BeamGeometryPreview`). `legacyApi` still exports **167** names (handler
verifier: 180 published, every inline handler resolved). Names gone from the controller because nothing else
referenced them (PR 11 finding 6 / PR 12b precedent): the fifteen option / help / wording builders
(`stage6UseCategory*`, `stage6SlsCombination*`, `stage6DewateringCombination*`, `stage6BeamUls*`,
`stage6BeamLoadPatternHelp`, `stage6BeamModelMode*`, `stage6BeamAxisCopy`, `stage6BeamMomentContextHelp`,
`stage6Exposure*`), `stage6BeamOrientationHtml`, `stage6BeamDurabilityHtml`, the four canvas primitives — all
exported by the packages.

## 4. `scripts/verify_settlement_dewatering_beam.mjs`

Two child processes (pattern of `verify_pile.mjs`), each loading one controller through the Tier-B loader; the
parent compares the dumps byte for byte. The base controller comes from `git show <ref>:…` (default
`integration-r`, `--base <ref>` otherwise), materialised as `src/lib/cpt-app/__verify-sdb-base.legacy-controller.js`
and deleted in a `finally`; the `MOVED_SIBLINGS` materialisation of `verify_pile.mjs` is in place but empty —
this PR moves no file the base imports (`stage6/apps/*-state.js` stay as re-exports). `--snapshot f.json` /
`--against f.json` as in the other verifiers.

| Group | Checks (final) | What |
|---|---|---|
| (a) demo-anonymous, sb260 → `goS(3)` → `goS(5)`, per app | 1 400 | per scenario: no exception (or the same known error, §6.1) · exception message · `#stage6Area` innerHTML · every Chart.js config of the app (+ the sampled tick / tooltip formatters, since JSON drops functions) · `S.stage6Cache.<app>` · `S.stage6.<app>` · cache keys · rAF errors · alerts · **beam: the geometry preview's canvas draw log** (§4.1). Scenarios: `setStage6App` (37 764 / 17 473 / 37 524 chars of `#stage6Area`) · `renderStage6()` · the golden suite's `heavy` · `edge` · the defaults again · **every inline `setStage6Field('<app>.…')` handler** with a value that differs from the defaults, ordered so the conditional inputs render too (circular D, the time horizon, the three dewatering geometries with their own inputs, Pasternak eta / G_p, patch start / end, point x, all five EC2 execution flags, the three model modes) · `<details>` open · closed. Plus: the scenarios rendered distinct pages (the walk proves something), the preview drew on every beam render |
| (b) `legacy-v0.5.2` (3 CPTs), `multi-3cpt` (3), `single-layered` (1) | 654 | per CPT and app the same observation after `setStage6App` and after the heavy config |
| (c) `tests/golden/node/stage6-{settlement,dewatering,beam}/*` from the pure packages | 178 | for the 7 profile fixtures on the working-tree controller's Stage 2–5 chain (layers via `model-params/working-layers.js`, `wt` from the CPT): `state.js defaults()` + `ensure({maxDepth: max(layerBottom, 0.5), wt})`, `compute.js <app>Analysis()`, `panel.js <app>BodyHtml()` inside the shell package's `cardsHtml` + `sharedBanner` → `stableJson(normalize(…))` / `normalizeText(htmlToText(…))` byte-identical to `<fx>.{default,heavy,edge}.json`, `.config.json`, `.default.dom.txt`, `.alerts.json`, beam `.subgrade.json` (`subgradeReaction` on the post-edge config, the suite's `extra`) — all 175 files, and the file sets match |
| (d) registry / packages | 28 | per app: `stage6/apps/<app>-state.js` re-exports `<app>/state.js` (same function objects); `install<App>App()` returns the retaining shape with the package's `defaults` / `ensure` / `cardMeta`; the registry entry is the package (state + card text + glyph); `ensure()` clamps through it (Df, targetWt, modelMode / gpOverride / cNomOverride); `<app>Analysis` throws without `env.wt` and without `layers`; the app order unchanged |

### 4.1 The geometry preview under the DOM stub

`drawStage6BeamGeometryPreview` returns at once unless the element is an `HTMLCanvasElement` with a layout box —
under the Tier-B stub it never drew, so the goldens never locked it. The verifier's child gives the
`stage6BeamGeometryCanvas` stub element `HTMLCanvasElement.prototype`, a 640 × 220 `getBoundingClientRect` and a
`getContext` returning a recording proxy (every method call with its arguments, every property set), and the
draw log — 728 entries for the default demo page, 591 for the heavy config — is compared verbatim between the
base and the working tree for every beam scenario, together with the backing-store size (640 × 220 at the stub's
`devicePixelRatio` 1).

Result: **2 260 passed, 0 failed** (1 400 + 654 + 178 + 28), 8 s wall-clock on the agent's machine (two Vite loads + 15 fixture imports; `verify_bearing` / `verify_pile` took 8 s / 5 s on the same run — the ≈ 2 min of the 12a/12b reports were another machine). `package.json` line for the
main session (not added here):

```json
"verify:settlement-dewatering-beam": "node scripts/verify_settlement_dewatering_beam.mjs",
```

(Needs the Vite dev dependency and a reachable base ref, like `verify:bearing` / `verify:pile`; `--against` a
committed `--snapshot` dump avoids git once the branch is merged.)

## 5. Gates

Run on each commit's tree before committing.

| Gate | after commit 1 (settlement) | after commit 2 (dewatering) | after commit 3 (beam) |
|---|---|---|---|
| `npm run golden:check` (before: 1 619 / 0 / 0 / 0 on 07f0645) | 1 619 / 0 / 0 / 0 | 1 619 / 0 / 0 / 0 | 1 619 / 0 / 0 / 0 |
| `node scripts/verify_stage6_shell.mjs` | 100 / 100 | 100 / 100 | 100 / 100 |
| `node scripts/verify_bearing.mjs` | 519 / 519 | 519 / 519 | 519 / 519 |
| `node scripts/verify_pile.mjs` | 586 / 586 | 586 / 586 | 586 / 586 |
| `node scripts/verify_settlement_dewatering_beam.mjs` | 2 121 / 2 121 (settlement in (c)/(d)) | 2 187 / 2 187 (+ dewatering) | 2 260 / 2 260 (+ beam) |
| `npm run verify:core` | exit 0 — handlers OK (180 published, legacyApi 167), core, model-params, classification-layers, load, export-report, bearing, pile, project-section-tuning, nen6740, stratigraphy, import-review, project-io, scia-db4, qc-only, retaining, wasm, bishop-phase-a | exit 0 | exit 0 |
| `npm run build` | `✔ done` | `✔ done` | `✔ done` |
| `npm run check` | 468 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings | 6 pre-existing | 481 files, 6 pre-existing, 0 warnings, 0 in the packages |

Playwright / dev server not run (pure moves; README protocol step 5 — the `07-settlement` / `07-dewatering` /
`07-beam` steps of the browser journeys should be run by the main session before the fast-forward, as for every
Stage 6 PR).

## 6. Findings

1. **Monolith defect, kept (behaviour): `dewatering.aquiferBaseDepth` crashes the page once typed.** Its default
   is `null`, so `stage6/field-setter.js coerceFieldValue` (numbers are coerced only after a *number* default)
   stores the input's string as-is, and the next render's `cfg.aquiferBaseDepth.toFixed(2)` throws — in the
   base as in the working tree, and on every later dewatering render of that CPT (the string stays in the
   state; `ensure()` does not clamp it). The verifier walks this handler last and asserts that **both**
   controllers throw the same `TypeError` (`KNOWN_DEFECTS`), so the parity claim stays strict. The fix (coerce
   `''` → `null`, else `+value`, in `dewatering/state.js ensure()` or a nullable-number rule in the field setter)
   is a behaviour change with its own commit and golden case — PLAN §4 candidate. `beam.gpOverride` /
   `beam.cNomOverride` have the same `null` default but their `ensure()` coerces them (PR 11 kept that), so the
   beam page survives the same input.
2. The Eurocode use-category / SLS-combination wording (`useCategoryOptions`, `useCategoryHelp`,
   `slsCombinationOptions`, `slsCombinationHelp(selected, context)`) is shared by the settlement and beam load
   accordions. It lives in `settlement/options.js` (the app that owns the `context === 'settlement'` default);
   `beam/panel.js` imports it from there — a package-to-package dependency, documented in both headers. The
   alternative homes (`core/format.js`, `stage6/`) were outside this PR's file set; see §7.
3. `stage6BeamModelModeLabel` had no caller anywhere (map §2.9 lists it among the wording builders); moved to
   `beam/options.js modelModeLabel` with the rest of the wording rather than deleted (a deletion is a surface
   change for a possible future caller, and it costs 8 lines).
4. `buildSettlementCharts` / `buildDewateringCharts` receive `maxDepth` (and `originalWt`) as values, so
   `stage6MaxDepth()` / `S.wt` are read before the `!analysis || typeof Chart === 'undefined'` early return
   instead of after — pure reads of `S.layers` / `S.wt`, unobservable (PR 12b finding 4).
5. `drawBeamGeometryPreview(analysis, cfg)` takes the config explicitly; `buildBeamCharts({analysis, cfg})`
   passes the same `S.stage6.beam` the monolith read inside the preview. The controller façade
   `drawStage6BeamGeometryPreview(analysis)` still reads `S.stage6?.beam` itself (`beamApp.drawGeometryPreview`).
6. The dewatering panel's two `S.wt` reads (audit row, input `min`) became one `waterTableOf(env)` read — the
   same number twice, `toFixed(2)` unchanged.
7. The Tier-B stub never exercised the geometry preview (§4.1) — 180 lines of canvas code that were only
   covered by the browser journeys' masked screenshots. The recording-context approach of this verifier is
   reusable for the pile section view's `<canvas>` fallback and the bishop canvas (step 9e's "canvas draw-call
   recorder", map §6.2).
8. The verifier's field walk covers every inline handler of the three panels — a grep of
   `setStage6Field('<app>.` in the moved `panel.js` files gives 16 / 15 / 36 distinct fields (17 / 16 / 37
   handler strings: settlement's `D` and `L` alternate, dewatering's `rCPT` appears in two geometries) and
   every one is in the walk; each step rendered a distinct page (the re-renders and the known-defect step
   excepted).
9. The generator's leftover-identifier scan does not see **shadowing**: `stage6BeamAxisCopy` renamed to
   `axisCopy` collided with the local `const axisCopy = stage6BeamAxisCopy(…)` of `renderStage6BeamApp` and
   `drawStage6BeamGeometryPreview` (`ReferenceError: Cannot access 'axisCopy' before initialization` on the
   first beam render). Caught by the first gate run of commit 3 (`golden:check` and the verifier both stopped
   at the first beam render), fixed by naming the builder `beamAxisCopy` — the monolith's own noun — before
   the commit; the gates were re-run from scratch on the corrected tree.

## 7. Follow-ups (not in these pure moves)

1. Finding 1 — `dewatering.aquiferBaseDepth` coercion, as a behaviour commit with a golden update (the
   `stage6-dewatering` suite has no case that types the field; add one).
2. A shared home for the Eurocode combination wording (finding 2) once the composition root (step 10) defines
   what `core/` may know about Stage 6 — or leave it in `settlement/` and let `beam/` depend on it, which is
   what the code says today.
3. `verify:settlement-dewatering-beam` into `verify:core` (needs the Vite dev dependency; CI on a PR branch with
   `--base origin/main`, or a committed `--snapshot`).
4. With all five analysis apps packaged, the shell's `apps` map can take the install results directly
   (`renderBody` → `body`) — PR 11 report §7.4 / PR 12a §7.2 — and `stage6/registry.js` can drop the
   `apps/*-state.js` indirection entirely once nothing imports the `<app>State` namespaces of `stage6/index.js`.
5. D-stream (PLAN row 13): the three markups are now `settlement/panel.js`, `dewatering/panel.js`,
   `beam/panel.js` (+ `beam/geometry-preview.js`); the component classes (`.cols-3`, `.acc`, `.tbl--dense`,
   `.viz`) go in there; the `stage6-*` goldens lock the text, not the tags.
6. Composition root (step 10): publish the three packages' `handlers` (empty today) and drop the seven façades
   (`renderStage6*App`, `buildStage6*Charts`, `drawStage6BeamGeometryPreview`) — none is on `legacyApi`, so
   the verifier (a)/(b) is the only thing that reaches them through the shell.
