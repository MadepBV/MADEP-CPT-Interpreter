# 16 — PR 14 `refactor(project, section, tuning)` + `fix(project): terminate the deformation worker on CPT switch`

Base `integration-r` @ 78a2e02 (PR 4/5/6/9/11 merged, controller 15 883 lines), strangler step 8 of
`01-monolith-map.md` §6.2 (PLAN §2 row 14). Executed by a Fable agent in an isolated worktree, branch
`v0.5.3` of the worktree. Two commits:

| Commit | Content |
|---|---|
| **b2c3844** `refactor(project, section, tuning): …` | the pure move (§1–§3) + `scripts/verify_project_section_tuning.mjs` + the one-line invariant update in `scripts/verify_load.mjs` (§2.1) |
| **(this commit)** `fix(project): terminate the deformation worker on CPT switch` | PLAN §4 defect 2 / map §3.4 #8 (§4) + the Tier-B check (g) in the verifier + this report |

File set: `src/lib/cpt-app/legacy-controller.js` (project/banner/nav, section and tuning regions + one import
block after the `stage6/` imports), new `src/lib/cpt-app/core/state.js`, new `project/` (5 files), `section/`
(4), `tuning/` (4), new `scripts/verify_project_section_tuning.mjs`, `scripts/verify_load.mjs` (one assertion —
see §2.1, the only file outside the brief), this report. `package.json`, `tests/**`, `scripts/golden/**`, the
bearing / pile / export / report regions of the controller and the Svelte templates untouched.

Note on the base: `integration-r` moved on while this PR was in flight (PR 8 export/report, PR 12a bearing were
merged: 96af6ca). Both commits sit on 78a2e02, the `integration-r` the brief pointed at; the verifier below was
run with `--base 78a2e02`. The merge into the new tip touches only the shared import block (every step adds its
block "after the `stage6/` imports").

`npm run golden:check` 1 619 / 0 / 0 / 0 before, after the move and after the fix — no golden updated, no
`tests/golden/CHANGELOG.md` entry (no worker runs in the golden suites; the three project fixtures are all
`idle` in bishop/seepage/deformation, so the fix's `progress` writes are no-ops there).

## 1. What moved (verbatim bodies; only the `S` / `PROJECT` reads became parameters)

Old line numbers are those of 78a2e02. The cut script asserted the first line and a unique last line of every
region before slicing (five regions, 912 lines out, 84 lines of wrappers in).

### 1.1 `project/` (map §2.0)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `selectCpt` 395-464 | `project/cpts.js` → `selectCpt(project, idx, ctx)`; the control sync 421-449 → `syncCptControls(document, cpt, ctx)`; the `#chartArea` markup → `CHART_AREA_HTML`; the "reset nav to Stage 1" loop 411-416 → `nav.js` `resetStageNav(document)` (= `applyStageNav(document, 0, 0)`, same classList calls in the same order) | `S.charts` of the CPT being left → `ctx.getActive().charts` (read *before* the switch — after a project load `S` still points at the pre-load CPT, whose Chart.js instances are the ones to destroy); `PROJECT.activeCptIdx=idx; S=…` → `ctx.setActive(idx)`; the wtR/wtN/elevN/cptX/cptY/elev-src/wt-src/assumedRf writes reuse `load/controls.js` (`syncWaterTableControls`, `syncElevationControl`, `syncCoordinateControls`, `renderElevationSource`, `renderWaterTableDisplay`, `renderAssumedRfControls`, `renderMetaCard` — the same statements PR 9 moved); workers / classification timer / method cards / `initCharts` / `drawLayerColumnSvg` via `ctx` | `selectCpt(idx){ projectApp.selectCpt(idx); }` |
| `addCpt` 466-474, `setCptName` 476-479, `removeCpt` 516-526 | `cpts.js` → `addCpt(project, ctx)`, `setCptName(project, idx, name, ctx)`, `removeCpt(project, idx, ctx)` | `PROJECT` → `project`; `confirm()` → `ctx.confirm` (the global, passed by the host); removeCpt's `PROJECT.activeCptIdx=newActive; S=…` → `ctx.setActive(newActive)` | one-line wrappers |
| `renderBanner` 484-514 | `project/banner.js` → `bannerTabsHtml(project)` (pure string) + `bindBannerTabs(tabs, {selectCpt, removeCpt})` + `renderBanner(document, project, handlers)` | none (the CPT id stays unescaped, as before) | `renderBanner(){ projectApp.renderBanner(); }` |
| `setPhase` 528-543 | `project/phase.js` → `setPhase(document, project, ph, {renderCorrelation, renderSection})`, `PHASES` | `stratigraphyApp.render()` / `renderSection()` → the two hooks | wrapper |
| `goS` 876-895 | `project/nav.js` → `trackMaxStage(cpt, n)` (state), `applyStageNav(document, n, maxReached)` (DOM), `goS(document, cpt, n, renderStage)` | the four `if(n===k)render…()` → `ctx.renderStage(n)` (the host's dispatch, same four lines) | `goS(n){ projectApp.goS(n); }` |
| module code 896-900 (`.si` click binding at import time) | `nav.js` → `bindStageNav(document, goS)` | none | `bindStageNav(document, goS);` at the same module-scope spot (the load-time side effect of map §0 stays until step 10) |
| — (new) | `project/index.js` → `installProject(ctx)` returns `{renderBanner, selectCpt, addCpt, setCptName, removeCpt, setPhase, goS, bindStageNav}` | | `const projectApp = installProject({document, getProject, getActive, setActive, newCptState, confirm, stopWorkers, cancelClassificationRefresh, syncClassificationMethodCards, initCharts, drawLayerColumnSvg, renderCorrelation, renderSection, renderStage})` right after `let S` — hoisted references and closures only, nothing runs at install |

### 1.2 `section/` (map §2.12)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `sectionProjection` 601-608 | `section/render.js` → `sectionCpts(project, projection)` | `stratigraphyApp.projection()` is the parameter | `sectionProjection(){ return sectionApp.sectionProjection(); }` |
| `renderSection` 610-813 (204 lines) | `render.js` → `buildSectionSvg({projCpts, vex, getGeometry, allCpts, tokens}) → {html, attrs, complete}` (pure) + `sectionTokens(readToken)` + the thin `renderSection(document, ctx)` | the SVG text is verbatim; `readCssToken(…)` ×5 → `tokens.{text,muted,subtle,blue}` (read once by the wrapper with `core/css-tokens.js`); `stratigraphyApp.sectionGeometry()` → `getGeometry()` (a thunk, still called only once the section has data, at the same point); `PROJECT.cpts` (the legend reads *all* CPTs, not the projected ones) → `allCpts`; `SCFILL` → `soil-styles.js SOIL_FILL_COLORS`; the three `svg.setAttribute` + `svg.innerHTML` writes → `attrs` (`null` in the "Geen data." branch, which never set them) and `html`; `bindSectionTooltip()` only when `complete` (the two early returns never bound it) | `renderSection(){ sectionApp.renderSection(); }` |
| `bindSectionTooltip` 815-855 | `section/tooltip.js` → `sectionTooltipHtml(dataset)` (pure), `sectionTooltipPosition({clientX, clientY, rect, scrollLeft, scrollTop})` (pure, `SECTION_TIP_W/H/PAD`), `bindSectionTooltip(document)` | none | wrapper |
| `exportSectionSVG` 857-865 | `section/export-svg.js` → `sectionSvgDocument(outerHTML)`, `sectionSvgFileName(projectName)` (pure), `exportSectionSVG(document, project)` | none | wrapper |
| `const SCFILL = SOIL_FILL_COLORS;` 871 | — | only the section read it → deleted (`SC` stays: Stage 3/4 markup) | the `SOIL_FILL_COLORS` name in the shared import block at line 87 is now unused there — left for the main session (the import block is edited by every parallel PR) |
| — (new) | `section/index.js` → `installSection(ctx)` returns `{sectionProjection, renderSection, bindSectionTooltip, exportSectionSVG}` | | `const sectionApp = installSection({document, getProject, projection, sectionGeometry, readToken: readCssToken})` |

### 1.3 `tuning/` (map §2.5)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `fitLayer` 1852-1970 (119 lines) | `tuning/fit.js` → `fitLayer(l, ctx)` + `tuningCtx(cpt)` = `{classified, alphaMethod, assumedRf, stressAt}` | `S.classified` → `ctx.classified`, `S.alphaMethod` → `ctx.alphaMethod`, `assumedRfValue()` → `ctx.assumedRf` (`classification/classify.js`, a pure `normalizeAssumedRf` — evaluated once instead of lazily inside the `??`, same value), `stressAt(z, gs, g)` → `ctx.stressAt` (`model-params/stress.js` bound to the CPT); `AE`, `alphaEB` imported from `model-params/` | `fitLayer(l){ return fitLayerPure(l, tuningCtx(S)); }` |
| `runTuning` 1972-1978 | `fit.js` → `runTuningFits(layers, ctx)` (the `map`) | none | `runTuning(){ S.tuning = runTuningFits(S.layers, tuningCtx(S)); renderTuning(); }` |
| `acceptFit` 1980-1991, `rejectFit` 1993-1998 | `fit.js` → `acceptFit(cpt, i) → boolean`, `rejectFit(cpt, i) → boolean` (the state half; `false` where the old body returned before rendering) | none | `acceptFit(i){ if(!acceptFitPure(S, i)) return; renderTuning(); if(#p3 .active) renderModel(); }`, `rejectFit` likewise — the render-after-write and the DOM visibility sniff (map §3.4 #2/#3) stay in the controller |
| `getTuningPreviewM` 2000-2005, `tuningSliderBounds` 2007-2016, `tuningPreviewEoedRef` 2018-2020, `tuningPreviewLineData` 2022-2032 | `fit.js` → same names | none | imported under the same names (they read no `S`; still on `legacyApi`) |
| `updateTuningPreviewM` 2034-2092 | value half → `fit.js` `tuningPreviewView(t, rawValue)` = `{parsed, invalid, previewM, preview, mText, refText, noteText, regressionLabel, depthLabel, dashed}`; DOM/chart half → `tuning/charts.js` `applyTuningPreview(document, i, view, {chartRed, chartGreen})`; `updateTuningPreviewM(document, tuning, i, rawValue)` composes them (`t.previewM = parsed` first, then the two `readCssToken`, as before) | the two `borderDash` expressions became `view.dashed ? [5,4] : []` (a fresh array per chart, as before) | `updateTuningPreviewM(i, rawValue){ updateTuningPreviewPure(document, S.tuning, i, rawValue); }` |
| `renderTuning` 2095-2241 (147 lines) | `tuning/panel.js` → `tuningAreaHtml(cpt)` (placeholder or all cards), `tuningLayerCardHtml(cpt, t)`, `TUNING_PLACEHOLDER_HTML` | markup verbatim; `S.layers/alphaMethod/wt/tuning` → `cpt.*`, `SC` → `SOIL_CLASS_NAMES`; the unused `const pref=100` dropped | `renderTuning(){ el.innerHTML = tuningAreaHtml(S); if(!S.tuning) return; setTimeout(buildTuningCharts, 50); }` |
| `buildTuningCharts` 2243-2304 | `charts.js` → `buildTuningCharts(document, ChartCtor = globalThis.Chart)` | `new Chart(…)` → `new ChartCtor(…)` (the global stays the default, resolved per call) | `buildTuningCharts(){ buildTuningChartsPure(document); }` — `renderModel` (line 1829 old / model region) still schedules it by this name |
| — (new) | `tuning/index.js` re-exports the package surface | | one import block |

Not moved (deliberately): `SC` (used by Stage 3/4 markup), the `chart-factories.js` tuning config builders (they
were already a module; `charts.js` imports them — their two names in the controller's shared import block are
now unused there, like `SOIL_FILL_COLORS`), `readCssToken` (core, PR 4), `stressAt`/`assumedRfValue` wrappers
(classification region).

## 2. The `S` reassignment behind `setActive(idx)`

`core/state.js` (new): `activeCpt(project)`, `isCptIndex(project, idx)`, `setActiveCpt(project, idx)` — the one
write of `activeCptIdx`, returning the CPT. The controller keeps `let S=PROJECT.cpts[0];` as the façade every
remaining function closes over, and re-points it in exactly one place:

```js
function setActive(idx){
  S=setActiveCpt(PROJECT, idx);
  return S;
}
```

`selectCpt` (old 407-408) and `removeCpt` (old 522-523) call `ctx.setActive(...)`; `installProject` gets
`getActive: () => S` for the one read that must see the *previous* CPT (the chart destroy, §1.1). The verifier's
(b) proves the façade: after every `selectCpt(idx)` of the round trip a write through an S-based handler
(`setCptCoord('x', …)`) lands on `PROJECT.cpts[PROJECT.activeCptIdx]` (old and new alike). `S` is otherwise
written nowhere (`verify_load.mjs` §9 asserts `let S=PROJECT.cpts[0]` + one `S=setActiveCpt(PROJECT, idx)` and no
other `S =` statement).

### 2.1 The one edit outside the brief: `scripts/verify_load.mjs` line 474

PR 9's verifier asserted `S=PROJECT.cpts[` appears exactly three times (declaration, selectCpt, removeCpt). That
invariant is what this step changes by design, so the assertion was rewritten to the new one (three lines, quoted
above); every other check of the file is untouched (45/45). Without it `verify:core` cannot be green — flagged here
rather than silently absorbed. Nothing else outside the file set was touched.

## 3. Hooks the controller hands to the packages (all hoisted references)

```
installProject : document, getProject, getActive, setActive, newCptState, confirm,
                 stopWorkers (search + seepage [+ deformation, §4]), cancelClassificationRefresh,
                 syncClassificationMethodCards, initCharts, drawLayerColumnSvg,
                 renderCorrelation (stratigraphyApp.render), renderSection, renderStage(n)
installSection : document, getProject, projection, sectionGeometry (stratigraphyApp), readToken (readCssToken)
tuning         : no install — the wrappers pass S / S.tuning / document explicitly
```

The `legacyApi` object is unchanged (same 167 names; `verify:handlers` 180 published). Every inline handler the
moved markup emits (`selectCpt(i)` in the banner, `updateTuningPreviewM`, `acceptFit`, `rejectFit` in the tuning
cards) still resolves through `window`.

## 4. The fix commit — `selectCpt` terminates the deformation worker (PLAN §4 defect 2, map §3.4 #8)

Old `selectCpt` 397-398 stopped the search and seepage workers (`stage6BishopStopSearch(true)`,
`stage6BishopStopSeepage(true)`) but not the deformation worker: after a switch mid-run the worker's messages were
dropped by the `payload.runId !== progress.runId` guard (the guard reads `S` at message time, i.e. the *new* CPT)
and the originating CPT kept `deformation.progress.running = true`, `status = 'solving'`, with nothing left to
finish it. The fix is the third call in the host's `stopWorkers` hook:

```js
stopWorkers: () => { stage6BishopStopSearch(true); stage6BishopStopSeepage(true); stage6BishopStopDeformation(true); },
```

`stage6BishopStopDeformation(true)` (bishop region, unchanged) terminates the singleton worker and, on the CPT
still active at that moment (the originating one), sets `progress.running = false`, `progress.percent = 0` and
`status = 'idle'` when it was `meshing`/`solving`/`post` — exactly the silent-stop treatment the seepage run gets.
`runId` and `message` are kept (as for seepage).

Tier-B proof — verifier check (g): multi-3cpt, `selectCpt(0)`, a run put in flight by hand on CPT 0
(`deformation.progress = {running:true, percent:42, runId:7, …}`, `status:'solving'`; seepage and search likewise),
`selectCpt(1)`:

- new: `running=false`, `percent=0`, `status='idle'`, `runId=7` and the message kept; the search and seepage stops
  as before; the diff of CPT 0's whole `stage6` (key order kept) before/after is **exactly** the five
  search/seepage paths + the three deformation paths — nothing else moved; CPT 1's state after the switch and CPT
  0's state before it are byte-identical to the base;
- base (78a2e02): `running=true`, `status='solving'` after the switch — the stuck flag, printed as `info`; its diff
  is the five search/seepage paths only.

No `Worker` exists under Node (the loader sets `globalThis.Worker = undefined`), so the flag is the whole
observable; the browser-side `terminate()` follows the existing `stage6BishopStopSeepage(true)` path. Goldens
untouched (all fixtures idle, §0).

## 5. `scripts/verify_project_section_tuning.mjs`

Same shape as `verify_stage6_shell.mjs`: the base controller (`git show <base>:…`, materialised next to the
working tree's, deleted whatever happens) and the working-tree controller are loaded in two child processes through
the Tier-B loader and dumped to JSON; a third child recomputes the tuning goldens through the golden context.
Options `--base <ref>` (default `integration-r`), `--snapshot f.json`, `--against f.json`.

| Section | Compared byte for byte (old vs new) |
|---|---|
| (a) banner | `#cptTabs` innerHTML + `#projName` + project shape after: fresh load, demo import, `setCptName` (trimmed / blank → default id), `addCpt` (+ the `#fi` click count, sectionOrder), `removeCpt` (+ the single-CPT guard), each of the three project fixtures — and every stub element (60 ids) where a switch happened |
| (b) selectCpt | multi-3cpt, sequence `[0,1,2,0,2,1,3,-1]`: active index + id, `chartsReady` / chart keys, rAF errors, every stub element (Stage 1 controls, method cards, chart area, layer column, nav…), and the `S`-façade probe (§2) |
| (c) goS | `[1,2,3,4,2,0]`: `_maxStage` + every stub element (the rendered stage bodies) |
| (d) phases + section | per project fixture: `setPhase` over `analysis → correlation → section → analysis` (phase + every stub element), `#sectionSvg` innerHTML + viewBox/width/height (36 613 chars for the two multi-CPT fixtures, the 116-char placeholder for single-layered and the demo import), the section at vex 3, the tooltip listeners fired with synthetic events (near, flipped at the far corner, miss, leave; listener counts after a second `renderSection` = no double binding), `exportSectionSVG` (download name + blob text) |
| (e) tuning | demo + every CPT of the three fixtures (8 CPTs; 1–9 layers): placeholder before the run, `S.tuning`, `#tuningArea` innerHTML (23–130 k chars), slider helpers, `fitLayer` per layer, the Chart.js configs of every card (`buildTuningCharts` twice, fed the `[data-chart-pending]` elements parsed from the markup — the `_built` guard), the live slider ×5 (valid, `0.25`, `-1`, `abc`, empty: `previewM`, the five DOM ids, both chart datasets), `acceptFit(0)`, accept-all, bogus index, reject-all, bogus index, `acceptFit` with `#p3` active (every stub element: the Stage 4 re-render), final `S.tuning` |
| (g) deformation switch | §4 |
| (f) Tier A | `bannerTabsHtml` == `#cptTabs` for the 11 banner states; `sectionTooltipHtml` / `sectionTooltipPosition` == the tip's html / left / top; `sectionSvgFileName` == the download name; **`tests/golden/node/tuning/*` (63 cases) recomputed with `tuning/fit.js` + `panel.js` on a plain copy of each classified CPT** (`runTuningFits`, `tuningAreaHtml` → `htmlToText`, the helpers, `acceptFit`/`rejectFit` + `hsParams(l, cptModelCtx(cpt))`, `tuningPreviewView`) and compared after the harness normalisation — the suite's Tier-A migration per `tests/golden/README.md` step 8, without touching `tests/` or `scripts/golden/` |

Result: **208 / 208** (`--base 78a2e02`; 200 / 200 at the pure-move commit before (g) existed). npm line for
`package.json` (main session):

```
"verify:project-section-tuning": "node scripts/verify_project_section_tuning.mjs",
```

(as for `verify:stage6-shell`: needs a reachable base ref — `--base` at the merge base in CI, or a committed
`--snapshot` dump and `--against`).

## 6. Gates

| Gate | Pure move (b2c3844) | Fix commit |
|---|---|---|
| `npm run golden:check` before (78a2e02) | 1 619 / 0 / 0 / 0, 28.9 s | — |
| `npm run golden:check` after | 1 619 / 0 / 0 / 0, 28.9 s (`tuning` 63, `project-io` 22, `stage6-shared` 15, `stage6-*` 302, `report` 22, `exports` 55 all bit-identical) | 1 619 / 0 / 0 / 0 |
| `node scripts/verify_project_section_tuning.mjs --base 78a2e02` | 200 / 200 | 208 / 208 |
| `npm run verify:core` (handlers 180 published / legacyApi 167, core 18/18, model-params 188/188, classification-layers 260/260, **load 45/45**, nen6740, stratigraphy, import-review, **project-io**, scia-db4, qc-only, **retaining** 31/31 + 226 OK, wasm, bishop-phase-a 6 fixtures) | exit 0 | exit 0 |
| `npm run build` | `✔ done` | `✔ done` |
| `npm run check` | 437 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in the new packages | same (437 files, 6 errors) |

Playwright / dev server not run (per the brief). The browser journeys' save-load and multi-CPT steps (PLAN row 14
gate "golden save-load journey") should be run by the main session before the fast-forward.

## 7. Findings on the map / plan

1. Map §2.0 says `selectCpt` "syncs 15 control ids": it is 17 writes over 13 ids in the sync block (wtR, wtN,
   elevN, smartMergeChk, smartMergeSensR, smartMergeSensN, smartMergeControls, cptX, cptY, btnAlphaA/B,
   btnStiffA/B, btnKhKvA/B) plus the four `update*`/`renderMeta` groups; seven of those writes are the very
   statements PR 9 put in `load/controls.js`, which `syncCptControls` now reuses — nothing is written twice.
2. Map §1.1 lists the `removeCpt` reassignment; it re-pointed `S` and then called `selectCpt(newActive)`, which
   re-pointed it again — so the Chart.js instances destroyed on a remove are those of the *new* active CPT, not
   the removed one (the removed CPT's charts are on DOM canvases `selectCpt` re-creates anyway). Kept as-is (pure
   move); harmless because `selectCpt` rebuilds `#chartArea`.
3. `renderSection` read `readCssToken('--tx3')` in both early-return branches and the four tokens again in the
   full branch; the wrapper reads the four once. `readCssToken` is a `getComputedStyle` read — no observable
   difference (verified: every section string identical).
4. The legend of the section reads `PROJECT.cpts` (all CPTs), not the projected ones — a CPT without coordinates
   still contributes its soil types to the legend. Preserved (`allCpts`), noted for the D-stream restyle.
5. `renderTuning` declared `const pref=100` and never used it; dropped.
6. The `S`-count assertion in `verify_load.mjs` shows the cost of asserting source text: each step that changes
   the invariant must rewrite it. The new assertion is phrased against the target (one declaration, one
   `setActive`) so step 10 (composition root) only has to delete it.
7. `integration-r` advanced during this PR (§0). The stage6 verifier's `--base integration-r` default has the
   same weakness once a step is merged (its report §6.6); this verifier documents the same `--snapshot` escape.

## 8. Follow-ups (not in this PR)

1. Main session: `package.json` line (§5); drop `buildTuningDepthChartConfig`, `buildTuningRegressionChartConfig`
   and `SOIL_FILL_COLORS` from the controller's shared import block (unused there now; left to avoid a
   three-way conflict with PR 8 / 12a on the same lines).
2. Step 10: `bindStageNav` moves inside `installProject` (the import-time side effect of map §0), `#bishop` hash
   into `project/phase.js`, `getActiveStage` of `projectIO` onto `nav.js` state instead of `.panel.active`.
3. Stage 2 `cancelClassificationRefresh` / `syncClassificationMethodCards` and Stage 1 `initCharts` /
   `drawLayerColumnSvg` are still controller closures handed through `ctx`; PR 10 (`style(stage1-2)`) can route
   them through the `load/` and `classification/` packages' handlers.
4. `acceptFit`'s "re-render Stage 4 if `#p3` is active" (map §3.4 #2) is now the last DOM-visibility sniff in the
   tuning path; it becomes a `ctx.isStageVisible(3)` when stage visibility gets a state mirror (step 10).
5. The deformation-worker `onmessage` closures still read `S` at message time (map §3.4 #8 second half) — step 9c
   (runs return patches keyed by the originating CPT) is the structural fix; this commit closes the user-visible
   half (the stuck flag).
