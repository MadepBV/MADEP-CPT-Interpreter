# 28 — PR 18f `refactor(seepslope): panels and the tool rail`

Base `integration-r` @ d4db625 (v0.6.0 tip; controller 8 741 lines, PR 18a–e merged), the sixth
Seep / Slope sub-step of `01-monolith-map.md` §6.2 step 9 (PLAN §2 row 18f; map §6.2 step 9f
"panels, one `data-st6details` group at a time, plus the tool rail", §6.3 item 4 — the two giant
render functions "have ~130 local derivations shared across the template; they must be split by …
`data-st6details` group **with an explicit view-model**"). Executed by a Fable agent in an isolated
worktree, **one code commit** — a pure move, no behaviour change, no `tests/golden/CHANGELOG.md`
entry — plus this report.

| | hash | |
|---|---|---|
| 1 | `57e3335` | `refactor(seepslope): panels and the tool rail` |
| 2 | *(this file)* | `docs(refactor): report 28 — PR 18f Seep / Slope panels and the tool rail` |

File set: `src/lib/cpt-app/legacy-controller.js` (the import block and the panel / tool-rail region
only), new `src/lib/cpt-app/seepslope/panels/**` (38 files), new
`scripts/verify_seepslope_panels.mjs`, this report. `package.json`, `tests/**`, `scripts/golden/**`,
`src/lib/styles/**`, `seepslope/{state,model,run,geometry,probe,canvas}/**`, `report/capture.js`
(9g), every other app and **every class attribute** untouched (the restyle is PR 19).

`npm run golden:check` **2 086 / 0 / 0 / 0**. `legacyApi` **167 names**, unchanged (handler
verifier: 333 files scanned, 429 inline `on*=` attributes, 180 published, every inline handler
resolved). The controller is **8 741 → 5 514 lines** (−3 227).

---

## 1. What moved

Line numbers are `integration-r` @ d4db625. Two regions:

| Region | Lines | Now |
|---|---|---|
| the label / icon / tool-rail block | 4125-5248 (1 124) | 13 façades, 45 lines |
| `renderStage6BishopApp` | 5839-8229 (2 391) | one 12-line host half + a 36-hook `env` |

`renderStage6BishopApp` was the last giant function in the codebase: a prelude of **198 local
derivations** followed by **twenty-six template locals** that closed over them and a 245-line
`return`. That closure is what made it unsplittable, exactly as §6.3 item 4 predicted, and the fix
is the one PR 18e used on the canvas:

```
state → view-model.js → sections/*.js · sheets · results · tool rail → layout.js
```

### 1.1 The moved names

| Monolith (old) | New export | Change | Controller now |
|---|---|---|---|
| `stage6BishopStrengthSetLabel` 4125 | `labels.strengthSetLabel` | none | façade |
| `stage6DepthBandReportHtml` 4135 | `labels.depthBandReportHtml` | none | façade (keeps the default `title`) |
| `stage6BishopSafetyCurveHtml` 4163 (166 lines) | `safety.safetyCurveHtml` | none | façade |
| `stage6BishopSafetyMechanismHtml` 4330 | `safety.safetyMechanismHtml` | none | façade |
| `stage6BishopSeepageTerminationLabel` 4363 | `labels.seepageTerminationLabel` | none | façade |
| `stage6BishopResultMethodLabel` 4371 | `labels.resultMethodLabel` | none | façade (also `stage7ControllerDeps`' `resultMethodLabel`) |
| `stage6BishopModeMeta` 4389 (85 lines) | `labels.modeMeta(bishop)` | its one `S` read became the parameter | façade |
| `stage6BishopToolIcon` 4475 | `icons.toolIcon` | none | façade |
| `stage6BishopCanvasToolButton` 4523 | `icons.canvasToolButton` | none | façade |
| `stage6BishopWallMechanicalLabel` 4540 | `labels.wallMechanicalLabel` | none | façade |
| `stage6BishopPartialLoadBadgeHtml` 4557 | `labels.partialLoadBadgeHtml` | none | façade |
| `stage6BishopWallInfoPanelHtml` 4566 | `tool-rail.wallInfoPanelHtml(bishop, env)` | its `S` read became the parameter | façade |
| `stage6BishopCanvasToolRailHtml` 4742 (507 lines) | `tool-rail.canvasToolRailHtml(context, env)` | the two `S` fallbacks became `env` hooks | façade |
| `renderStage6BishopApp` 5839 (2 391 lines) | `view-model.buildPanelsViewModel` + `layout.bishopAppHtml` | see below | 12-line host half |

### 1.2 `panels/view-model.js` — the key step

`buildPanelsViewModel({bishop, bishopUi, model, modeMeta, selected}, env)` is the monolith's prelude,
**verbatim and in its order** — controller 5849-6105, 6107-6451, 7025-7026, 7059-7082, 7133-7162 and
7366-7381 — 198 derivations, the fifteen table-row builders included (`materialRows`, `wallRows`,
`hsInheritedRows` / `hsEditableRows` / `hsDerivedRows` / `hsMaterialWarnings`, `permeabilityRows`,
`seepageBcRows`, `drainRows`, `drainResultRows`, `resultRows`, `deformationProfileRows`,
`deformationWallRows`, `analysisWallOptionHtml`, `wallChartsHtml`, `drainValidationHtml`). They are
computed **once** and read by every section, sheet, tool-rail card and results panel — the brief's
"do not recompute per section if the monolith computed once, and vice versa".

**Nothing in the file writes.** The two statements the monolith interleaved that do are the host's:

* `stage6BishopMigrateSurfaceLoadsShape(bishop)` (5848) runs **before** the view model, at exactly
  the point the monolith ran it — after the five `S` reads, so `stage6BishopCurrentModel()` still
  sees the pre-migration shape;
* `S.stage6Cache.bishopLineProbe = lineProbe` (6106) runs right **after** it. Nothing between that
  line and the end of the render reads the key back — its only reader is
  `buildStage6BishopLineProbeChart` (8257), which runs after the `innerHTML` swap — so the move is
  observationally identical. The verifier's 978 renders are the evidence.

The verifier asserts the property directly: the `bishop` block and the section model come back byte
identical, two builds agree, and rendering the whole app twice leaves the state untouched (§4 (g)).

### 1.3 `panels/sections/*.js` — one module per `data-st6details` group

The **twenty-four** groups the app owns, in DOM order. Each module is a pure string builder that
returns exactly the monolith's own text for that `<details>` — its leading newline included, so the
composition is `${…}` substitution and nothing else:

| # | `data-st6details` | module | monolith |
|---:|---|---|---|
| 1 | `bishop-geo-terrain` | `sections/geometry-terrain.js` | 8013-8025 |
| 2 | `bishop-geo-regions` | `sections/geometry-regions.js` | 8026-8081 |
| 3 | `bishop-geo-setup` | `sections/geometry-setup.js` | 8082-8113 |
| 4 | `bishop-geo-analysis` | `sections/geometry-analysis.js` | 6453-6476 |
| 5 | `bishop-geo-seepage-boundary` | `sections/geometry-seepage-boundary.js` | 6478-6507 |
| 6 | `bishop-geo-deformation` | `sections/geometry-deformation.js` | 6509-6579 |
| 7 | `bishop-geo-clear` | `sections/geometry-clear.js` | 8115-8130 |
| 8 | `bishop-walls` | `sections/walls.js` | 8133-8144 |
| 9 | `bishop-search` | `sections/search.js` | 6582-6624 |
| 10 | `bishop-spencer` | `sections/spencer.js` | 6625-6664 |
| 11 | `bishop-materials` | `sections/materials.js` | 6665-6676 |
| 12 | `bishop-seepage-perm` | `sections/seepage-permeability.js` | 6678-6689 |
| 13 | `bishop-seepage-bcs` | `sections/seepage-bcs.js` | 6690-6711 |
| 14 | `bishop-seepage-drains` | `sections/seepage-drains.js` | 6712-6739 |
| 15 | `bishop-seepage-options` | `sections/seepage-options.js` | 6740-6787 |
| 16 | `bishop-seepage-integration` | `sections/seepage-integration.js` | 6788-6797 |
| 17 | `bishop-deformation-materials` | `sections/deformation-materials.js` | 6799-6821 |
| 18 | `bishop-deformation-solve` | `sections/deformation-solve.js` | 6822-6897 |
| 19 | `bishop-deformation-diagnostics` | `sections/deformation-diagnostics.js` | 6888-6894 (nested in 18) |
| 20 | `bishop-deformation-solver-settings` | `sections/deformation-solver-settings.js` | 6898-6973 |
| 21 | `bishop-geo-view` | `sections/view.js` | 7163-7311 |
| 22 | `bishop-deformation-contour-legend` | `sections/deformation-contour-legend.js` | 7312-7332 |
| 23 | `bishop-seepage-contour-legend` | `sections/seepage-contour-legend.js` | 7333-7353 |
| 24 | `bishop-canvas-view-menu` | `sections/canvas-view-menu.js` | 7357-7558 |

The two contour legends keep their own guard (`derived && showContourLegend && (showContours ||
showContourLines)`), so the module owns the whole `const … = cond ? … : ''`. `canvas-view-menu.js`
also owns the two fragments only it uses — the contour-mode select (7382-7394) and the overlay icon
grid (7395-7512) with the monolith's `viewMenuIconButton` closure (7357-7365).

`workspace-sections.js` is the two per-workspace pickers: `workspaceGeometrySectionHtml` picks one
of groups 4/5/6, `workspaceSettingsHtml` concatenates 9-11 / 12-16 / 17+18+20 — the monolith's own
ternaries, with the branch bodies replaced by the calls.

### 1.4 The rest of the package

| File | Lines | What |
|---|---:|---|
| `panels/index.js` | 113 | the flat surface, `PANEL_DETAILS_KEYS`, `TOOL_RAIL_DETAILS_KEYS` |
| `panels/view-model.js` | 932 | `buildPanelsViewModel` — the 198 derivations |
| `panels/layout.js` | 145 | the twenty-six locals in the monolith's order + the 245-line return |
| `panels/tool-rail.js` | 579 | `canvasToolRailHtml`, `wallInfoPanelHtml` |
| `panels/sheets.js` | 242 | the eight canvas sheets + the `canvasSheets` lookup |
| `panels/results.js` | 230 | `workspaceResultsHtml`, one shape per workspace |
| `panels/labels.js` | 181 | the seven pure label / badge helpers |
| `panels/safety.js` | 209 | the ΣMsf curve and the mechanism summary |
| `panels/icons.js` | 75 | `toolIcon` (the 40-glyph set) + `canvasToolButton` |
| `panels/analysis.js` | 74 | the Structure tab, its tab strip and the Analysis sheet |
| `panels/header.js` | 80 | the app header, the settings head, the command bar |
| `panels/workspace-info.js` | 67 | the per-workspace summary card + the canvas help line |
| `panels/line-probe.js` | 51 | the probe summary and the probe side panel |
| `panels/workspace-sections.js` | 37 | the two per-workspace pickers |
| `panels/sections/*.js` (24) | 1 329 | one module per `data-st6details` group |

**4 344 lines over 38 files.** SPDX + `@ts-nocheck`, a header naming the source lines, `.js`
imports. Dependencies outside the package: `seepslope/{state,geometry,run,probe}` (PRs 18a-18d),
`core/format.js`, `stage6-bishop` (the two HS correlations), `seepage/{material,drains}`,
`wall-geometry.js`. **No `S`, no DOM, no canvas, no clock** (the one `new Date(...)` is the
monolith's own capture-timestamp label, formatted from a value in the state).

### 1.5 What deliberately stayed in the controller

| Name | Why |
|---|---|
| the five `S` reads of the render's head | `S.stage6.bishop`, `stage6BishopUiState()`, `stage6BishopCurrentModel()`, `stage6BishopModeMeta()`, `stage6BishopSelectedResult()` |
| `stage6BishopMigrateSurfaceLoadsShape(bishop)` | the one prelude statement that writes state |
| `S.stage6Cache.bishopLineProbe = …` | the volatile cache the chart builder reads after the swap |
| `stage6BishopRenderWallChart` / `buildStage6BishopWallCharts` 4617-4740 | canvas drawing, not HTML — they belong with the chart hosts |
| `stage6BishopTooltipHtml` 5275 | canvas hover tooltip; step 9e left it, and it reads the *geometry* region's region model, not the panels' view model (§6 finding 5) |

## 2. The host `env`

`SEEPSLOPE_PANELS_ENV` (**36 hooks**) carries only what a region step 9f must not touch (map §2.11):

* the Stage 6 shell — `stage6DetailsOpen`, `stage6MaxDepth`, `stage6BishopUiState`, and the two
  reads the prelude made of `S` directly (`cachedSeepageBoundary`, `stage6ActiveBishop`);
* the seepage-BC lookup — `CurrentSeepageBoundary`, `SelectedBoundaryEdge`, `SeepageBcForEdge`,
  `SeepageEdgeLabel`, `SeepageBcTypeLabel`, `DisplayRegions`, `ReadyMessage`, `LineProbeOptions`,
  `BuildLineProbe`;
* the wall-result readers — `AnalysisWallId`, `WallResultForId`, `WallResultSeries`,
  `SelectedWallResult`, `WallQuantityStats`, `WallQuantityFormat`, `WallOverlayQuantity`,
  `STAGE6_WALL_RESPONSE_QUANTITIES`;
* the seepage- and deformation-contour catalogues — 6 + 7 hooks;
* `STAGE6_ENABLE_HARDENING_SOIL_UI`.

Everything the earlier steps already own is imported, not hooked: `sortZone`, `validZone`,
`effectiveSurfaceLoadQ`, `activeSurfaceLoads`, `selectedSurfaceLoad`, `surfaceLoadSummary`,
`selectedCustomRegion`, `normalizeRegionCoarseness`, the four mesh-target-area helpers,
`resultWallLabel`, `wallMaterialPresetKey`, `drainValidationSummary`, `drainGatingLabel`,
`measurementMetrics`, `measurementLabel`, `showingCustomRegionPreview`, `regionLegendItems`,
`methodModeLabel`, `secondsLabelFromMs`, `seepageFlowErrorLabel`,
`safetyFinalizationStatusFromSolver`, `lineProbeFormatValue`, `escAttr` / `escJsString` / `tooltip`
/ `noteHtml` / `compactNumber`, `wallEndpoints` / `wallLength`, the four `seepage/material` helpers,
`drainHeadValueAt` / `drainTotalLength`, `bishopHsJakyK0nc` / `bishopHsRowePhiCvDeg`.

The four surface-load / region façades the prelude called (`stage6BishopSelectedSurfaceLoad`,
`stage6BishopSelectedCustomRegion`, `stage6BishopActiveSurfaceLoads`,
`stage6BishopEffectiveSurfaceLoadQ`) are re-bound inside the view model to the block it was handed
instead of to `S.stage6.bishop` — the same `seepslope/state` functions with the same signatures.
The tool rail does the same for `EffectiveSurfaceLoadQ` and `SurfaceLoadSummary`.

## 3. How the move was made (and why it is byte-identical by construction)

The requirement is stricter than usual: the emitted HTML must match **whitespace, tab indentation
and attribute order** — and this region carries **131 tab-indented lines in 25 runs** (controller
4935-4937, 4956-4963, 4975-4985, 5228-5229, 5235-5237, 6082-6092, 6151-6156, 6549-6552, 6571-6573,
6844, 6916-6919, 6944-6954, 7006-7008, 7022-7024, 7919-7930, 7943-7960, 7967-7990, 8011, 8205-8226),
every one of which is inside a template literal and therefore part of the output.
So the extraction was done by a throw-away generator rather than by hand: it slices exact line
ranges out of the controller, never reformats them, and only re-plumbs the code **inside `${…}`**
that used to resolve through module scope. Each builder's `const { … } = vm` / `= env` list is
computed from an **acorn parse of the generated body** — the identifiers actually referenced — so a
view-model key whose name also occurs as plain text in the template (`<summary>`, "layer model")
is not bound, and a missing one is impossible.

The generator lives in the agent's scratchpad, not in the repo: it is a one-shot tool, and the
thing that has to keep being true — the HTML — is what `scripts/verify_seepslope_panels.mjs` locks.

## 4. `scripts/verify_seepslope_panels.mjs` — **1 980 passed, 0 failed**

Pattern of `verify_seepslope_{state,model,run,geometry,canvas}.mjs`: two child processes, each
loading one controller through the Tier-B loader in its own Vite server, dumping the same
observations as JSON; the parent compares byte for byte and prints the first differing chunk.
Both controllers are materialised with the **same appended `export { … }` block**, so the moved
functions — module-local in the base, façades in the working tree — are directly comparable.
`--base <ref>` / `--snapshot f.json` / `--against f.json` as usual. ≈ 20 min wall-clock.

**The observation is the whole `#stage6Area` innerHTML** after `renderStage6()` — not a text
extract — as a sha-256 plus a chunked hash list (2 000 chars per chunk, so the parent names the
first differing chunk), the head and tail verbatim, and the sorted list of `data-st6details`
attributes with the count of open ones.

| Group | What |
|---|---|
| (a) geometry, selections and tools — **978 states, 62.3 M characters**, over the seeded `loadDemo()` CPT **and all 7 CPTs of the three project fixtures** (`legacy-v0.5.2`, `multi-3cpt`, `single-layered`) | per CPT: the empty section, terrain, the entry / exit zones, the phreatic line, a wall, a drain, two surface loads (one disabled, one in total-load mode), the custom-region preview and the committed set, each of the four entity selections, the measurement with one and with two points, **all 14 tools** with and without the draft that tool would carry, the three workspaces × the two analysis tabs, the settings column wide and narrow, the three strength sets, both method modes and the four polygon display toggles |
| (b) every `<details>` state the state can express | `S.stage6.ui.details` is a flat map of independent booleans and each key contributes exactly one ` open` attribute, so the sweep toggles **each of the 26 keys against both extremes** — open with all others closed, closed with all others open — plus all-open, all-closed and the default absent map (55 renders per fixture, on the demo and on `legacy-v0.5.2#0`). That is exhaustive over the lattice one independent attribute per key can generate; 2²⁶ renders are not |
| (c) the solved workspaces | a real in-process `analyzeBishopSearch` (the bishop suite's reduced grid) with its first and second result, its running preview and a forced no-valid-circle result; a real `analyzeSeepageModel` on the app's own model with **all five contour modes** and **all nine display toggles**, the three BC types, both free-surface modes, manual mesh sizing, the stale banner and **every line-probe quantity**; a real js-cpu linear-elastic `analyzeDeformationModel` written in as the run reducer writes it, with **all seven contour modes**, **all nine display toggles**, the five wall-overlay quantities, a synthetic wall response (the Structure tab's five charts and their ranges), the partial-load badge, the three constitutive models, both load modes, both element types, the whole **c-phi safety** catalogue (curve, mechanism, open-ended FoS) and every deformation line-probe quantity |
| (d) the tool rail | each of the **7 cards** and each of the **8 sheets** open, in **each of the 3 workspaces**, plus the hidden rail and the wall-info card with the wall mechanically active and inactive |
| (e) error and warning states | a rejected and a running seepage solve, drain-validation errors *and* warnings, an orphaned BC, a rejected / stale / running deformation solve with solver warnings, the depth-band plasticity diagnostics, the legacy wall-activation prompt, the Hardening-Soil material warnings with the Simo-Hughes migration prompt, and a stopped search |
| (f) the inline handler names | `scripts/verify_window_handlers.mjs` is **run as a child process**, so the panels' `on*="…"` strings are checked with the repo's own logic rather than a copy of it: 333 files, 429 inline attributes, 70 distinct callees, 180 published (`legacyApi` 167 + `retainingApp.handlers` 12 + 1 direct) |
| (g) the package standalone (working tree) | the view model **does not mutate** the `bishop` block or the section model it is handed, two builds agree, rendering the app twice leaves the state untouched and the layout is a pure function of the view model; every monolith panel name survives as a function and **11 façades are asserted to be exactly their package function** applied to the host state; the package's `PANEL_DETAILS_KEYS` + `TOOL_RAIL_DETAILS_KEYS` are exactly the 26 keys; and **every one of the 22 section modules emits its own `data-st6details` key** |

Two masking decisions, both documented in the script and applied identically to both controllers:

1. **Wall-clock durations.** `seepage.result.timing` / `deformation.result.timing` reach the HTML
   through the "Runtime" rows, so they differ between two processes by construction. Every key
   ending in `Ms` (and not starting with `max`, which is a configured budget) is frozen to a fixed
   value **immediately after the solve**, before any render. Nothing else is masked — every node,
   every head, every stress, every formatted number in 62.3 M characters is compared byte for byte.
2. **Entity ids** come from `Date.now()` / `Math.random()`, so the steps that allocate one (the wall
   / drain / load commits, the region copy, the BC assignment) run under a seeded clock and PRNG
   (mulberry32). The three solvers keep the real clock, so no internal time budget is disturbed.

`package.json` line for the main session (**not** added here, as briefed):

```json
"verify:seepslope-panels": "node scripts/verify_seepslope_panels.mjs",
```

and into `verify:core` after `verify:seepslope-canvas`.

### 4.1 What the verifier caught

The first full run failed **12 of 1 980** checks, all the same shape: the `view` sheet was **3
characters** shorter in the working tree, on every fixture and in every workspace. `viewSectionHtml`
is not a section that gets concatenated but a `const … = \`…\`` local of its own, so its value ends
with the monolith's trailing `"\n  "`; the generator had emitted it with the section convention
(leading newline, no trailing indent). Three invisible whitespace characters, in a sheet reachable
only through one tool-rail button — exactly the class of regression a DOM-text golden cannot see and
a screenshot would not notice either. It is the reason the observation is the raw innerHTML.

## 5. Gates

Every row was re-run against `57e3335` itself (the numbers below are from that run, not from an
earlier working state).

| Gate | Result |
|---|---|
| `npm run golden:check` | **2 086 / 0 / 0 / 0**, 60 s — every suite bit-identical |
| `node scripts/verify_seepslope_panels.mjs` | **1 980 / 1 980**, 978 states, 62.3 M characters, 8 CPTs |
| `npm run verify:core` | **exit 0** — every step green, including `verify:seepslope-state` 1 110, `verify:seepslope-model` 1 301, `verify:seepslope-run` 1 255, `verify:seepslope-geometry` 1 833 and `verify:seepslope-canvas` **1 142**. Handler verifier: 180 published, **legacyApi 167** |
| `npm run build` | `✔ done`, exit 0; the three worker chunks emitted as before |
| `npm run check` | 571 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `seepslope/**` |
| `GOLDEN_PORT=5699 GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs --grep seep-slope` | **1 passed**, 13 steps, 21.1 s; state + DOM text byte-identical; bishop search 873 ms, seepage 227 ms, deformation 916 ms. **No `09-seepage-bcs` flake** (PLAN §6). The three `visual (soft)` mismatches (`01-bishop-empty`, `02-terrain`, `08-stability`) are the pre-existing machine-wide PNG drift of report 22 §5.1 — the same three shots report 27 saw |
| `PW_PORT=5499 npx playwright test --project=visual --workers=1` | **14 passed** (3.0 min), all at `maxDiffPixels: 0` — including the four `stage6-bishop-dock-card` variants and the rekennota print page 1. No capture timeouts (report 27 §5.2): the box was quiet and the run was single-worker |

Both browser suites ran against dev servers started **from the worktree** with a scratch Vite
config (report 27 §5): `npx vite dev --config <scratch>.mts --port <n> --strictPort`, `server.fs.allow`
extended with the real `node_modules` path (it is a symlink into the main checkout), and the repo's
`**/.claude/**` watcher ignore replaced by the generated trees a concurrent build rewrites
(`.svelte-kit/{output,generated}`, `build/`, `test-results/`, the visual baselines, `tests/golden/`).
Playwright's `reuseExistingServer` picked both up. Ports 5699 (journey) and 5499 (visual).

### 5.1 The Bishop visual shot proves finding 1

`tests/visual/app.spec.mjs:71` sets `stage6BishopSetCanvasPanel('view')` before the
`stage6-bishop-dock-card` shot — and the baseline shows the dock **without** a card, because the
tool rail maps `bishopActiveCanvasPanel === 'view'` to `''` (finding 1). The four 0-px shots
therefore also lock the tool rail's dock, the floating View menu, the contour legends and the whole
settings column around the (masked) canvas; the card the shot is named after has never been in it.

## 6. Findings

1. **The tool rail's View *card* is unreachable.** `stage6BishopCanvasToolRailHtml` opens with
   `const activePanel = ui.bishopActiveCanvasPanel === 'view' ? '' : (ui.bishopActiveCanvasPanel || '')`,
   so the `view` entry of its `panelBody` map can never be selected — the dock's View button is a
   *sheet* button (`stage6BishopSetCanvasSheet('view')` → `viewSectionHtml`). Its 55-line body and
   the two `data-st6details` groups it owns (`bishop-view-quick-snap`, `bishop-view-quick-layers`)
   are dead HTML. Kept verbatim; the verifier asserts they stay unreachable **in both controllers**
   and the package names them separately (`TOOL_RAIL_DETAILS_KEYS`) so the composition root can drop
   them or the card can be revived deliberately.
2. **Three write-only UI flags.** `ui.bishopSettingsCollapsed` is written in six places
   (`stage6BishopToggleSettingsPanel`, `…SettingsWidth`, `…OpenSettingsDetail`, `setStage6App`, …)
   but the render reads a hard-coded `const settingsCollapsed = true` (controller 5883), so the
   settings column is permanently in the `--settings-collapsed` layout and the **Hide** button only
   re-renders. `ui.bishopToolRailExpanded` (written by `stage6BishopToggleToolRail`, itself
   published on `legacyApi` but called from no HTML string) has no reader at all. Behaviour /
   cleanup commit; PR 19 will want to decide whether the column is collapsible.
3. **Five blocks are duplicated between the settings column and the canvas sheets**, now visible as
   separate modules rather than as separate stretches of one 2 400-line function: the drain tools +
   info + validation list (`sections/seepage-drains.js` ⇄ `sheets.structuresSheetHtml`), the wall
   table (`sections/walls.js` ⇄ `structuresSheetHtml`), the assigned-BC table
   (`sections/seepage-bcs.js` ⇄ `boundarySheetHtml`), the region tools and the selected-polygon
   editor (`sections/geometry-regions.js` ⇄ `regionsSheetHtml`), and the three material tables
   (`sections/{materials,seepage-permeability,deformation-materials}.js` ⇄ `materialsSheetHtml`).
   They are *not* identical — the sheets use `.st6-canvas-card-*` wrappers and shorter copy — so
   folding them is a behaviour change, not a move. PR 19 is the moment: one component per block,
   two wrappers.
4. **The whole settings column is a second copy of the tool rail's job.** With the split done, the
   duplication above is one instance of a bigger one: `st6-bishop-settings-panel` (groups 1-3, 7-20)
   and the canvas dock reach the same state through different markup. That is a design decision for
   PR 19 / phase 3, not a refactor step, but the module boundaries now make it cheap to try.
5. **`stage6BishopTooltipHtml` stays with the geometry region, not the panels.** Report 27 §7.3
   expected the three canvas hover tooltips to move here. Two of them are built by
   `seepslopeCanvasTooltipEnv` from `regionTooltipHtml` (already `seepslope/geometry`), and the
   third is the measurement label; none of them reads the panels' view model. Moving them into
   `panels/` would give the tooltip a dependency on the whole 198-derivation prelude for two `<div>`s.
   Left where they are; the composition root can group them with the canvas.
6. **The six `SEEPSLOPE_CANVAS_ENV` hooks report 27 §7.3 wanted to retire are still hooks.**
   `SelectedResult`, `WallOverlayQuantity`, `WallNodeValuesForOverlay`, `WallQuantityFormat`,
   `CssColorWithAlpha`, `ContrastingTextColor` belong to the map's "Wall results" and "Result HTML /
   labels" groups — but the *readers* that moved here are the panels, not those producers. The
   producers (`stage6BishopWallResult*`, `stage6BishopWallQuantity*`, controller 3699-3860) are a
   region of their own and are now hooked from **two** packages instead of one. They are the obvious
   next extraction: a `seepslope/results/` package would drop 8 hooks from `SEEPSLOPE_PANELS_ENV`
   and 6 from `SEEPSLOPE_CANVAS_ENV` at once.
7. **Any deformation option edit invalidates the solved field.** Found while writing the verifier:
   `stage6BishopSetField('deformation.options.…')` runs the PR 18b invalidation, so a solved result
   cannot survive a settings change. That is the intended behaviour (the result no longer matches
   the inputs), but it means the verifier has to re-install the solved field before every group that
   must render one — documented in the script, and both controllers do it identically.
8. **`renderStage6BishopApp` read `S` five times and wrote it twice.** For the record, that is the
   whole host surface of a 2 391-line function: `S.stage6.bishop`, `stage6BishopUiState()`,
   `stage6BishopCurrentModel()`, `stage6BishopModeMeta()`, `stage6BishopSelectedResult()`, and the
   two writes of §1.2. Everything else was pure — which is why the move is a pure move.

## 7. Follow-ups (not in this PR)

1. Main session / harness owner: `"verify:seepslope-panels": "node scripts/verify_seepslope_panels.mjs"`
   in `package.json` (§4), and it into `verify:core` after `verify:seepslope-canvas`.
2. **PR 19 (`style(seepslope)`)**: the class attributes of `seepslope/panels/**` are untouched here
   by design. The restyle now has 38 files with one concern each instead of one 2 400-line function;
   findings 3 and 4 are the two decisions it has to make first. `scripts/verify_seepslope_panels.mjs`
   must be re-run there with `--base` at the commit before it (the HTML will legitimately change;
   that is the point), and the `data-st6details` keys must survive — they are what
   `stage6RememberDetails` persists.
3. **Step 9g (`report/capture.js`)**: `renderStage6BishopApp` is now
   `buildPanelsViewModel` + `bishopAppHtml`, both pure, so the Stage 7 capture can build a view
   model for the target workspace and render it without the app / workspace switching of map
   §6.3 item 7 — the same shape PR 18e left for the canvas.
4. **A `seepslope/results/` package** (finding 6): `stage6BishopWallResult*` /
   `stage6BishopWallQuantity*` / `stage6BishopSelectedResult` / the two contour catalogues. It is
   the last non-trivial Seep / Slope region left in the controller and it would shrink both
   `SEEPSLOPE_PANELS_ENV` (36 → ~20) and `SEEPSLOPE_CANVAS_ENV` (23 → ~9).
5. Findings 1 and 2 (the dead View card, the three write-only flags): behaviour / cleanup commits
   with a golden case each.
