# 14 — PR 12a `refactor(bearing): package in the retaining style`

Base `integration-r` @ 78a2e02 (PR 4/5/6/9/11 merged, controller 15 883 lines), strangler step 7 of
`01-monolith-map.md` §6.2, first of the five per-app PRs of PLAN §2 row 12. Executed by a Fable agent in an
isolated worktree. File set: `src/lib/cpt-app/legacy-controller.js` (bearing regions only),
new `src/lib/cpt-app/bearing/**` (7 files), `src/lib/cpt-app/stage6/registry.js` + `stage6/apps/bearing-state.js`
(minimal), new `scripts/verify_bearing.mjs`, this report. `package.json`, `tests/`, `scripts/golden/**`,
the Svelte templates and the pile / settlement / dewatering / beam / project / section / tuning / export
/ report regions of the controller untouched.

One commit, one pure move: `npm run golden:check` 1 619 / 0 / 0 / 0 before and after — no golden updated,
no `tests/golden/CHANGELOG.md` entry. The new verifier compares the base controller (integration-r, loaded
from git through the Tier-B loader) with the working tree: **519 / 519**, every rendered bearing page and
every partial update byte-identical on 8 CPTs, and the pure `compute.js` reproduces all 70 `stage6-bearing`
goldens from the goldens' own configs.

## 1. What moved (verbatim bodies; only the `S` reads became parameters)

Old line numbers are those of 78a2e02 (integration-r). A generator cut the bodies by name (asserting the
`function name(` anchor and the closing `}` of each), applied the identifier renames below and the five
explicit substitutions of `S` / `stage6WorkingLayers()` reads, and asserted that no module still mentions
`S.`, `stage6WorkingLayers` or a `stage6*` controller identifier (the DOM ids `stage6DfValue` … and
`stage6Cache`/`stage6Constants` excepted).

| Monolith (old lines) | New module → export | Change inside the body |
|---|---|---|
| `layerAtDepth` 9865-9869 | `bearing/compute.js` → `layerAtDepth(z, layers)` | `layers \|\| stage6WorkingLayers()` fallback removed — `layers` is required (`null`/`[]` → `null`) |
| `stage6BearingGeometry` 9871-9906, `stage6BearingShapeModeLabel` 9908-9912, `stage6BearingNgammaLabel` 9914-9916, `stage6BearingShapeFactors` 9932-9948, `stage6BearingDepthFactors` 9950-9975, `stage6BearingNgamma` 9981-9985, `stage6UsesEc7Factors` 9987-9989, `stage6CapacityLabel` 9991-9993, `stage6FactorLabel` 9995-9997, `stage6FactorValue` 9999-10002, `stage6BearingEc7Keys` 10004-10008, `stage6BearingEc7Spec` 10010-10029 | `compute.js` → `bearingGeometry`, `shapeModeLabel`, `ngammaLabel`, `shapeFactors`, `depthFactors`, `ngamma`, `usesEc7Factors`, `capacityLabel`, `factorLabel`, `factorValue`, `ec7Keys`, `ec7Spec` | names only |
| `bearingAtDepth` 10339-10519 | `compute.js` → `bearingAtDepth(z, cfg, layers, env)` | `layers` required; the two `S.wt` reads → `env.wt` (checked finite by `waterTableOf`, throws otherwise — an explicit-input contract, unreachable through the façades) |
| `bearingProfile` 10521-10540 | `compute.js` → `bearingProfile(cfg, layers, env)` | `layers` required; passes `env` down |
| `stage6BearingShapeModeDetailHtml` 9918-9923, `…DetailText` 9925-9930, `stage6BearingEc7Options` 10210-10219, `stage6BearingEc7Help` 10221-10228, `stage6BearingShapeModeOptions` 10230-10238, `stage6BearingShapeModeHelp` 10240-10245, `stage6BearingNotes` 10295-10337 | `bearing/notes.js` → `shapeModeDetailHtml`, `shapeModeDetailText`, `ec7Options`, `ec7Help`, `shapeModeOptions`, `shapeModeHelp`, `bearingNotes` | names only |
| `stage6BearingSelectedDepthHtml` 10542-10567, `stage6BearingMaterialParamsHtml` 10569-10602, `stage6BearingDrainedFormulaHtml` 10604-10630, `stage6BearingUndrainedFormulaHtml` 10632-10653 | `bearing/panel.js` → `selectedDepthHtml`, `materialParamsHtml`, `drainedFormulaHtml`, `undrainedFormulaHtml` | names only (`stage6BearingShapeModeDetailHtml` → notes.js import) |
| `renderStage6BearingApp` 11107-11212 | `panel.js` → `bearingBodyHtml(profile, cfg, {detailsOpen})` | `S.stage6.bearing` → `cfg`; `stage6DetailsOpen(key)` → the `detailsOpen` host hook; `stage6NoteHtml` → `core/format noteHtml`; the two governing lines → `governingResistance(sel)` |
| `refreshStage6BearingPreview` 10664-10686 | `bearing/preview.js` → `refreshBearingPreview(cpt, workingLayers, queueChartBuild)` | `ensureStage6State()` stays with the host (index.js calls `ctx.ensure()` first); `S` → `cpt`; `stage6WorkingLayers()` → `workingLayers()` (still after the app guard); `bearingProfile(cfg, layers)` → `(cfg, layers, {wt: cpt.wt})`; the two governing lines → `governingResistance(sel)`; the queue is the parameter |
| `let stage6BearingChartTimer` 10655 + `queueStage6BearingChartBuild` 10656-10662 | `bearing/chart.js` → `createChartQueue(build, delayMs = 20)` | the module-level timer became a closure per installed app; same 20 ms debounce |
| `buildStage6BearingChart` 14217-14230 | `chart.js` → `buildBearingChart(cpt)` | `S` → `cpt`; `stage6DestroyChart` → `core/chart-host destroyChart`; the canvas id → `BEARING_CHART_ID` |
| `stage6/apps/bearing-state.js` (PR 11: `defaults`, `ensure`) | `bearing/state.js` (verbatim) | none; `stage6/apps/bearing-state.js` is now a re-export (one source of truth) |
| `const stage6ShapeFactors = stage6BearingShapeFactors` 9977-9979 | stays in the controller as `= bearingShapeFactors` (window API alias) | — |

`governingResistance(sel)` (panel.js) is the one new helper: `renderStage6BearingApp` and
`refreshStage6BearingPreview` both inlined `governing = min(qdDrained, qdUndrained)` / `governingMode`; the
maths is unchanged and the verifier locks both outputs.

## 2. The package

`src/lib/cpt-app/bearing/` — 986 lines, every module SPDX + `@ts-nocheck`, `.js` imports, header naming the
source lines; loads under plain Node (`node -e "import('./src/lib/cpt-app/bearing/index.js')"` installs the
app against a stub `ctx`):

| File | Lines | Exports |
|---|---|---|
| `state.js` | 43 | `defaults()`, `ensure(stage6, env)` |
| `compute.js` | 390 | `layerAtDepth`, `bearingGeometry`, `shapeModeLabel`, `ngammaLabel`, `shapeFactors`, `depthFactors`, `ngamma`, `usesEc7Factors`, `capacityLabel`, `factorLabel`, `factorValue`, `ec7Keys`, `ec7Spec`, `bearingAtDepth(z, cfg, layers, {wt})`, `bearingProfile(cfg, layers, {wt})` — imports `designSoilLayer`, `effectiveVerticalStressAtDepth`, `stage6Constants` from `stage6-engineering.js` |
| `notes.js` | 111 | `shapeModeDetailHtml/Text`, `ec7Options/Help`, `shapeModeOptions/Help`, `bearingNotes(sel, cfg)` |
| `panel.js` | 245 | `governingResistance`, `selectedDepthHtml`, `materialParamsHtml`, `drainedFormulaHtml`, `undrainedFormulaHtml`, `bearingBodyHtml(profile, cfg, {detailsOpen})` — imports `core/format noteHtml` |
| `preview.js` | 37 | `refreshBearingPreview(cpt, workingLayers, queueChartBuild)` |
| `chart.js` | 44 | `BEARING_CHART_ID`, `buildBearingChart(cpt)`, `createChartQueue(build, delayMs)` — imports `core/chart-host destroyChart`, `chart-factories buildBearingChartConfig` |
| `index.js` | 116 | `cardMeta`, `installBearingApp(ctx)`, and the package surface (state, compute, notes, panel, preview, chart re-exported) |

`installBearingApp(ctx)` with `ctx = { getState, ensure, workingLayers, detailsOpen }` returns the retaining
shape `{ defaults, ensure, renderBody, postRender, handlers, cardMeta }` plus what the shell adapter and the
window façades need: `compute(layers)` (the profile the shell writes to `S.stage6Cache.bearing`),
`refreshPreview()` (= `refreshStage6BearingPreview`: `ctx.ensure()` → `refreshBearingPreview`),
`queueChartBuild()` and `buildChart()`. `handlers` is `{}`: every inline handler of the bearing markup is the
shell's `setStage6Field` (13 sites), and the compute / panel names the window API publishes stay façades in
the host (below). Nothing in the package reads `S`, the DOM ids are only written by preview.js / read by
chart.js, and the package has no dependency on `stage6/` (the `<details>` memory comes through
`ctx.detailsOpen`, today the controller's ensure-first `stage6DetailsOpen`).

### Registry

`stage6/registry.js` imports `* as bearingApp from '../bearing/index.js'` and builds the bearing entry from
it — `cardMeta.title` / `cardMeta.desc` and `state = {defaults, ensure}` — instead of the `apps/bearing-state.js`
module and the literal strings (glyph unchanged, in the registry). `stage6/apps/bearing-state.js` re-exports
`bearing/state.js` so `stage6/index.js`'s `bearingState` namespace still works;
`createStage6Registry({ retaining })` with a stub retaining app (the shell verifier's step d) still builds.

## 3. Controller

| | lines |
|---|---|
| before (78a2e02) | 15 883 |
| after | **15 235** (net −648: 46 insertions, 694 deletions) |

Edits, all in the bearing regions plus the two agreed hook points:

- 200-209: the `bearing/index.js` import block, directly after the `stage6/` imports (`installBearingApp` and
  the pure / panel functions under `bearing*` aliases).
- 265-273: `const bearingApp = installBearingApp({ getState, ensure, workingLayers, detailsOpen })` after
  `retainingApp`, before the registry / shell instances (hoisted references only — `newCptState()` still calls
  `stage6Defaults()` at module load and nothing here runs).
- 292-296: the shell's `apps.bearing` closure now delegates to `bearingApp.compute / renderBody / postRender`
  (the comment above the shell instance updated accordingly).
- 9887-9904: the compute façades — `layerAtDepth(z, layers)`, `bearingAtDepth(z, cfg, layers)`,
  `bearingProfile(cfg, layers)` fill `layers || stage6WorkingLayers()` and `{wt: S.wt}` (so `bearingAtDepth(z, cfg, null)`
  and `layerAtDepth(z)` as the goldens call them keep working); `const stage6ShapeFactors = bearingShapeFactors`.
- 10133-10156: the four `stage6Bearing*Html` façades, `queueStage6BearingChartBuild` → `bearingApp.queueChartBuild()`,
  `refreshStage6BearingPreview` → `bearingApp.refreshPreview()`.
- 13580-13582: `buildStage6BearingChart` → `bearingApp.buildChart()`.
- `renderStage6BearingApp` deleted (its only caller was the shell closure; not on `legacyApi`, not in an HTML string).

Untouched: `setStage6Field` (still `… → bearing.Df short-circuit → refreshStage6BearingPreview() → return`),
`setStage6App`, `legacyApi` (**167** names, the 11 bearing names included — handler verifier: 180 published,
428 inline handlers, all resolved), `initLegacyController` (no `Object.assign(window, bearingApp.handlers)`:
the object is empty and the handler verifier only knows `legacyApi` / `retainingApp.handlers` as assign
targets), the option / help builders of the other apps that sit between the bearing functions
(`stage6UseCategoryOptions` … `stage6BeamDurabilityHtml`, `stage6ExposureOptions/Help` — they stay for the
settlement / dewatering / beam PRs).

## 4. `scripts/verify_bearing.mjs`

Same skeleton as `verify_stage6_shell.mjs`: two child processes, each loading one controller through the
Tier-B loader (`installDomStub()` + its own Vite `ssrLoadModule`; the base controller materialised from
`git show <ref>:…` as `src/lib/cpt-app/__verify-bearing-base.legacy-controller.js` and deleted in a `finally`;
`--base <ref>`, `--snapshot`, `--against` as there).

| Group | Checks |
|---|---|
| (A) render parity, base vs working tree — `demo-anonymous` (sb260, `goS(3)`, `goS(5)`) and every CPT of `legacy-v0.5.2` (3), `multi-3cpt` (3), `single-layered` (1) = 8 CPTs × 48 | `setStage6App('bearing')` innerHTML byte-identical + rAF errors / exception / clamped config / cached profile / chart config; each of the 12 inline `setStage6Field('bearing.…')` handlers (showMode, foundationType, B, L, shapeMode, eB, eL, load, ec7Combination, gammaRd, factorMode, xi — through the shell, full re-render) → innerHTML byte-identical + config / chart / rAF; the `bearing.Df` slider: the page is **not** re-rendered (both), `#stage6DfValue` and the four fragments `#stage6SelectedDepth / #stage6UlsParams / #stage6DrainedFormula / #stage6UndrainedFormula` byte-identical, the chart is rebuilt only after the 20 ms debounce with an identical config, cache / config / rAF identical; `renderStage6()` after the Df move byte-identical; the window API: `bearingProfile(cfg, null)` and with explicit layers, `bearingAtDepth(z, cfg, null)` at 6 depths and with `[]`, `layerAtDepth(z)` / `(z, [])`, `stage6ShapeFactors` × 4, the four `stage6Bearing*Html`; alerts |
| (B) pure `compute.js` vs `tests/golden/node/stage6-bearing/*` — the 7 profile fixtures × 19 + 2 | with the working layers (`buildStage7Payload().stage6.layers`, the suite's own accessor) and `S.wt` the working-tree controller reports after `classify(fx, 'sb260')`, `bearingProfile(cfg, layers, {wt})` from `<fx>.{default,heavy,edge}.config.json` reproduces `<fx>.{default,heavy,edge}.json`; `bearingAtDepth` at the suite's 5 depths from the edge config + `{Df:1, B:1.5, L:1.5, eB:0, eL:0, load:150}` reproduces `<fx>.at-depth.json`; `layerAtDepth` reproduces `<fx>.layer-at-depth.json` — each compared through the harness' `normalize` + `compare` (tolerance class `pure`, 1e-9) **and** as `stableJson` text (identical); `bearingAtDepth` without `env.wt` throws; `bearingProfile` / `layerAtDepth` without layers return `null` |

Result: **519 passed, 0 failed** (384 in A, 135 in B), ≈ 2 min (two Vite loads + 15 fixture imports). The
8 CPTs of (A) all have layers (`demo-anonymous` 19 296 chars; `layered` 19 290 / 19 298, `sand-only` 19 290,
`clay-only` 19 276 in the project fixtures), so every path — 12 field re-renders, the Df partial update, the
re-render, the window API — was exercised on each.
`package.json` line for the main session (not added here):

```json
"verify:bearing": "node scripts/verify_bearing.mjs",
```

(Needs the Vite dev dependency and a reachable base ref, like `verify:stage6-shell`; `--against` a committed
`--snapshot` dump avoids git once the branch is merged.)

## 5. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — before (78a2e02) | 1 619 PASS / 0 FAIL / 0 NEW / 0 MISSING, 28.7 s, exit 0 |
| `npm run golden:check` — after | 1 619 / 0 / 0 / 0, 29.0 s, exit 0 (`stage6-bearing` 70, `stage6-shared` 15, `report` 22, `exports` 55, `project-io` 22 all bit-identical) |
| `node scripts/verify_stage6_shell.mjs` (vs integration-r) | 100 / 100 — all seven apps' `#stage6Area` byte-identical, incl. bearing 19 296 chars |
| `node scripts/verify_bearing.mjs` (vs integration-r + goldens) | 519 / 519, exit 0 (run twice) |
| `npm run verify:core` | exit 0 — handlers OK (180 published, legacyApi 167), core, model-params, classification-layers, load, nen6740, stratigraphy, import-review, project-io, scia-db4, qc-only, retaining, wasm, bishop-phase-a (6 fixtures) |
| `npm run verify:retaining` | exit 0 — ui verifier PASSED (226 OK lines), behaviour 31/31, soil profile 23/23, sections/PLAXIS 81/81, request 24/24 |
| `npm run build` | `✔ done`, exit 0 |
| `npm run check` | 430 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `bearing/**` |

Playwright / dev server not run (pure move; README protocol step 5 — the `07-bearing` steps of the browser
journeys should be run by the main session before the fast-forward, as for every Stage 6 PR).

## 6. Findings

1. Map §2.7 lists `stage6BearingShapeModeDetailHtml/Text` under the "shared helpers" group; they are
   bearing-only (one caller each) and went to `notes.js`. Likewise `stage6CapacityLabel`, `stage6FactorLabel`,
   `stage6FactorValue`, `stage6UsesEc7Factors` have no caller outside the bearing region (verified by grep
   before the cut) and are `compute.js` exports; nothing else in the controller referenced any moved name.
2. `bearingAtDepth` read `S.wt` twice and `stage6Constants().gammaW` twice; the pure version reads `env.wt`
   once (`waterTableOf`) — the constant is still called twice, so the arithmetic is unchanged.
3. `layerAtDepth(z)` with no second argument is what the goldens (and `bearingAtDepth`'s callers through the
   window API) rely on; the fallback now lives in the controller façade only. The pure function returning
   `null` for `null` layers is a stricter contract than the monolith's `stage6WorkingLayers()` fallback and
   is covered by the verifier (B).
4. The `governing` / `governingMode` pair was computed in two places with the same two lines; one helper
   now (`governingResistance`), locked by the verifier through both the page and the partial update.
5. The chart debounce timer was a module-level `let` shared by every CPT; as a closure of the installed app it
   is still one per page (one install), so the behaviour is the same — but a future per-CPT install would get
   its own timer for free.
6. `ec7Combination` reaches `ec7Keys` un-normalised (the `heavy` golden config stores `'DA1-2'`, which is not
   one of `governing | da1_1 | da1_2` and therefore evaluates **both** combinations, i.e. behaves as
   `governing`). Not changed — the goldens lock it; a `state.js` clamp of `ec7Combination` (like `shapeMode`)
   would be a behaviour change with its own golden case.

## 7. Follow-ups (not in this pure move)

1. The four remaining apps (pile, settlement, dewatering, beam) follow the same generator pattern: cut by
   `function name(` anchors, rename, replace `S` reads by parameters, façades in place; `stage6/apps/<id>-state.js`
   becomes a re-export of `<id>/state.js`; the registry entry takes the package's `cardMeta` and state.
2. Once every app is a package, the shell's `apps` map can take the install results directly (`renderBody`
   → `body`), and `setStage6Field('bearing.…')` can route to `bearingApp.ensure` instead of the full
   `ensureStage6State()` (PR 11 report §7.4).
3. Composition root (step 10): publish `bearingApp.handlers` (empty today) and drop the 11 bearing façades
   from `legacyApi` once the goldens call the package's tier-A functions directly; a `stage6-bearing` tier-A
   case on `compute.js` is what verifier (B) already does and can move into `scripts/golden/suites/`.
4. Finding 6 (`ec7Combination` clamp) as a separate behaviour commit with a golden update.
