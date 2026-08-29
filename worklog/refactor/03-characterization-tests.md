# 03 — Characterization (golden-master) test harness

Branch `v0.5.3`, HEAD `462fc50`. Written 2026-08-29 from the real code (every claim below carries a
`file:line` that was read, not guessed). Purpose: lock today's observable behaviour of the app so that
(a) every incremental extraction out of `src/lib/cpt-app/legacy-controller.js` (18 503 lines) and
(b) the UI restyling can each be proven non-breaking by a mechanical check rather than by eye.

Nothing in the repo was modified for this report. No dev server or build was run.

---

## 0. Findings that shape the design (read first)

| # | Finding | Where | Consequence for the harness |
|---|---|---|---|
| F1 | **The demo profile is random.** `loadDemo()` draws every `qc`/`Rf` with `Math.random()`. | `legacy-controller.js:1823-1835` | The "Load demo" journey is not reproducible as-is. Either seed `Math.random` before the click (`page.addInitScript`) or import a committed GEF fixture instead. We do both (§3.1). |
| F2 | **No committed CPT fixture exists.** `docs/` is git-ignored (`.gitignore` line `/docs/`), so `docs/classification/2306609_S1.xls` is local-only; there is no `.gef` anywhere in the tree. Existing fixtures are solver-level only: `scripts/fixtures/bishop-phase-a/*.json`, `scripts/fixtures/hs_*.json`. | `.gitignore`, `scripts/fixtures/` | Fixtures must be generated deterministically (§3) and committed under `tests/golden/fixtures/`. |
| F3 | **`legacy-controller.js` cannot be imported by plain Node**: extension-less imports (`'./stage6-engineering'`, `'./chart-factories'`, …, lines 3-105), a Vite `define` (`__APP_VERSION__`, `vite.config.ts:11`), and top-level DOM access (`document.querySelectorAll('.si')` at :1047). | `legacy-controller.js:1-110, 1047` | Node-level tests of the controller go through Vite's `createServer({middlewareMode}).ssrLoadModule(...)` exactly like `scripts/verify_bishop_phase_a_parity.mjs:228-241`, plus the DOM stub pattern from `scripts/verify_retaining_ui.mjs:15-19`. Pure modules (`stage6-engineering.js`, `stage6-pile.js`, `classification-core.js`, `project-io/snapshot.js`, `stratigraphy/*`, `retaining/*`, `seepage/*`, `deformation/*`) import directly. |
| F4 | **Chart.js comes from a CDN** (`src/routes/+page.svelte:66`) and `initCharts()` polls every 120 ms until `Chart` exists (`legacy-controller.js:1670-1673`). An analytics script is also loaded (`src/app.html:10`). | | Browser runs must either serve a local copy via `page.route` or allow that one host; Node runs must define a `Chart` stub or the poll keeps the event loop alive forever. |
| F5 | **Non-deterministic fields** that must be masked before comparing: `generatedAt`/`savedAt`/`capturedAt` (`:18187`, `project-io/index.js:40`, `:17980`, `:18050`, `note-view.js:21`, `stratigraphy/index.js:72,88`); storage keys built from `Date.now()+Math.random()` (`report-storage.js:51`, `note-view.js:35`, `soilin-report.js:101`); entity ids `wall_*`, `drain_*`, `region_*`, `bc-*` (`legacy-controller.js:5182, 5323, 5390, 5524, 6286`); solver timings (`stage6-bishop.js:2572,2687`; `seepage/solver.js:2816`; `deformation/solver.js:7600`; `deformation/wasm/build-result.js:760`; `deformation/mesh.js:761`; `seepage/mesh-triangle.js:156`; `mesh/section-mesh.js:406`). Iteration counts are deterministic and are **kept**. | | A single `normalize.mjs` (§2.5) owns the mask list. |
| F6 | The retaining engine runs WASM on the **main thread** (`retaining/wasm-loader.js:6`), the Bishop search / seepage / deformation run in **module Workers** (`legacy-controller.js:7666, 7714, 7790`). Results land in state, not in return values. | | Browser tests wait on state predicates (`retwall.status==='done'`, `bishop.progress.running===false`, `seepage.status==='success'`, `deformation.status==='success'`) instead of `waitForTimeout`. |
| F7 | Everything observable is reachable from `window.PROJECT` (`legacyApi.PROJECT`, `:18322`; `Object.assign(window, legacyApi)` at `:18492`; retaining handlers at `:18493`). The active CPT is `PROJECT.cpts[PROJECT.activeCptIdx]` (`:245-260`). | | State snapshots are `JSON`-safe reads of `window.PROJECT` after stripping the same volatile keys the project-io strips (`charts`, `chartsReady`, `stage6Cache`, `project-io/snapshot.js:21`) **plus** `stage6Cache` captured separately because it holds the Stage 6 analyses (`:16787-16808`). |
| F8 | Downloads are `<a download>` clicks with `data:` or `blob:` hrefs (`exportCSV :17229`, `exportPlaxisCommands :17344`, `exportPlaxisCpt :17416`, `saveProject project-io/index.js:49-56`, `exportSectionSVG :795`, stratigraphy `download()` `stratigraphy/index.js:27`). Reports go through `localStorage` + `window.open` (`openStage7Report :18299-18308`, `note-view.js:51-54`, `stratigraphy/index.js:86-95`). | | Playwright: `page.waitForEvent('download')` → read file; `context.waitForEvent('page')` for report tabs. The payloads themselves are also obtainable without the tab: `window.buildStage7Payload()` (`:18166`, exported at `:18483`). |
| F9 | Existing E2E (`tests/e2e/retaining-walls.spec.mjs`) uses fixed sleeps and asserts only "renders without console errors". Playwright `1.62.1` is installed with Chromium; `playwright.config.mjs` starts `vite dev --port 5199`. | | Reuse the config; add a second project/spec. Replace sleeps with state waits. |
| F10 | There is **no CI** (`.github/` absent). WASM artefacts are committed prebuilt in `static/wasm/{deformation,retaining}/` and only rebuilt manually with `em++`. Native C++ tests exist for the retaining engine (`src/wasm/retaining/test_native.cpp`, g++ one-liner in its header). | | Workflow in §4.6 uses the prebuilt WASM and pins its SHA-256 so an unnoticed rebuild fails the check. |
| F11 | The water-table UI rejects negative values (`setWT :1520`), the slider is `min=0 max=15` (`Stage1Load.svelte:78-79`) and GEF `MEASUREMENTVAR 14` is `Math.abs`'d (`:1377`). "Water table above surface" is only reachable by state injection. | | Edge-case fixture uses `wt = 0` through the UI and `wt = -0.5` through state injection (both locked, the latter documents today's behaviour of `stressAt :1924`). |

---

## 1. What to lock — per stage / application

Conventions: `S` = `window.PROJECT.cpts[window.PROJECT.activeCptIdx]`. "State JSON" means the
normalised (§2.5) JSON of the listed paths. "DOM text" means `element.innerText` after whitespace
collapsing. **Canvas pixels are never a primary golden**; we lock the data that draws them (chart
configs, scene objects, series arrays) and keep screenshots as a secondary, tolerant signal (§2.3).

### 1.1 Phase / project shell (banner, multi-CPT, phases)

| Observable | Read from | Code |
|---|---|---|
| Project shape after load | `PROJECT.{name, activeCptIdx, phase, sectionOrder}` | `:235-243` |
| CPT list in banner | DOM text `#cptTabs` | `BannerPhaseShell.svelte:27`, `renderBanner :336` |
| Phase switch side effects | `PROJECT.phase`, visibility of `#nav`, `.wrap`, `#phaseCorr`, `#phaseSection` | `setPhase :380-395` |

### 1.2 Stage 1 — Load (GEF / CSV / XLSX import, demo, metadata)

| Observable | Read from | Code |
|---|---|---|
| Parsed rows | `S.data[]` = `{z, qc, fs, rf, u2}` (4/4/6/3 decimals) | `parseGEF :1346-1434`, `parseCsvCpt :1299`, `parseExcelCpt :1159` |
| Water table / elevation / coordinates + their sources | `S.{wt, wtFromFile, wtSource, elev, elevFromFile, elevSource, x, y}` | `applyParsedCpt :1120-1140` |
| Metadata | `S.meta` (`project, testid, date, owner, location, fname, importFormat, aRatio, zid, nRows, depthMin, depthMax, hasU2, hasFs, hasRf`) | `:1137-1141`, `:1470` |
| Import-review dialog content (columns, stats, quality notes) | DOM text of `.import-review-overlay` before clicking `[data-ir="apply"]` | `import-review/modal.js:75-86, 149, 192-193` |
| Tabular core (pure) | `detectColumns`, `findDataHeaderRow`, `buildRowsFromGrid`, `summarizeRows`, `cptValueToMPa`, `parseCptNumber` return values | `import-review/tabular.js` (re-exported `index.js:11-20`) |
| Stage-1 meta card | DOM text `#mgrid`, `#finfo`, `#wt-src`, `#elev-src`, `#wt-taw` | `renderMeta :1488`, `updateElevSrc :1474`, `updateWTDisplay :1479` |
| Raw chart series (the data behind `#cQc/#cFs/#cRf`) | `buildRawProfileChartConfig(...)` output → lock `data.datasets[*].data`, `options.scales` | `chart-factories.js:98`, used at `:1680` |
| Demo (seeded) | same as above after `loadDemo()` with seeded `Math.random` | `:1823` |

### 1.3 Stage 2 — Classification

| Observable | Read from | Code |
|---|---|---|
| Classified rows | `S.classified[]` (row + `type, subtype, Ic/Qt, g, gs, phi, c, cu …`) for each of the 5 methods (`S.method` ∈ `robertson, robertson2016, cur3, nen6740, sb260`) | `runClass :2107-2120`, `classRob :1996`, `classRob2016 :2010`, `classCUR3 :2047`, `classNEN6740 :2077`, `classSB260 :2097` |
| Pure classifier functions | `classifyRobertson1990/2016`, `classifyCUR3`, `classifyNEN6740`, `classifyTabel3`, `simulatedLayerFsValue` on a fixed reading grid | `classification-core.js:46, 88, 140, 169, 191, 239` |
| Assumed-Rf bookkeeping | `S.rfAssumedCount`, `S.useSB260params` | `:2110, 2126` |
| Metrics + note | DOM text `#cmet`, `#classAssumedRfNote`, `#cmetricHead`, `#minThkInfo`; row count of `#cbody tr` | `:2129-2185` |
| Layer preview SVG | `#layerPreviewSvg.innerHTML`, `#layerColSvg.innerHTML` (pure text) | `renderLayerPreviewSvg :1763`, `drawLayerColumnSvg :1745`, `report-svg.js:5, 69` |

### 1.4 Stage 3 — Layers

| Observable | Read from | Code |
|---|---|---|
| Detected layers (the single most important golden) | `S.layers[]` = `{id, top, bot, type, subtype, avgQc, avgFs, avgRf, g, gs, phi, c, cu, ovr{…}, rfIndeterminate, …}` for `smartMerge` on/off and `minThk` ∈ {0.3, 0.5, 1.0}, `smartMergeSensitivity` ∈ {0.9, 1.1, 1.3} | `detectLayers :2478-2560`, `segmentSummary :2199`, `smartPostMerge`, `simpleUpwardMerge`, `suggestSubtype` |
| Manual edit paths | state after `editL`, `changeSubtype`, `editAlpha`, `editM`, `editRShear`, `editNu` (`ovr.*` flags, `*_ovr` values) | `changeSubtype :2813-2841`, handlers exported `:18389-18393` |
| Layer table + warnings | DOM text `#lb`, `#layerWarnings` (created lazily) | `renderLayers :2783`, `renderCompatWarnings :2843` |

### 1.5 Stage 4 — Model parameters

| Observable | Read from | Code |
|---|---|---|
| Per-layer HS/MC/hydraulic parameters for `alphaMethod` ∈ {A,B} × `stiffMethod` ∈ {A,B} × `khKvMethod` ∈ {A,B} × `paramMethod` ∈ {sb260, def} | `window.hsParams(l)` and `window.khParams(l)` return objects (`Eoed_i, E50_i, Eoed_ref, E50_ref, Eur_ref, m, K0nc, nu, nu_ur, beta, Edef, aE, sigV, u, sigVeff, psi, Emc, rShear, topTAW, botTAW` / `kh_rep, kv_rep, khkv, psi_unsat, infClass`) | `hsParams :3063-3146`, `khParams :2937`, exported `:18399, 18394` |
| Working layers (what every Stage 6 app consumes) | `stage6WorkingLayers()` result — reachable in browser as `window.buildStage7Payload().stage6.layers` or by calling `window.hsParams/khParams` per layer; in Node directly | `:4162-4184` |
| Exports (text) | CSV text (`exportCSV`), PLAXIS commands text (`exportPlaxisCommands`), simulated CPT text (`exportPlaxisCpt`) | `:17209-17230`, `:17271-17346`, `:17378-17418` |
| Model cards | DOM text `#ma` | `renderModel :3148` |

### 1.6 Stage 5 — Tuning (m-fit)

| Observable | Read from | Code |
|---|---|---|
| Fit per layer | `S.tuning[]` = `{i, previewM, fit:{m_fit, Eoed_ref_fit, R2, n, stressRangeFactor, quality, qMsg, invalidSlope, Xs, Ys, meanX, meanY, m_raw, depthPts, EoedI_pts, aE_pts, hsDefault_pts, hsFit_pts, Eoed_ref_default, mDefault, alphaDefault}}` | `runTuning :3396`, `fitLayer :3276-3394` |
| Accept / reject effects | `S.layers[i].m_ovr`, `S.layers[i].ovr.m`, then `hsParams` deltas | `acceptFit :3404`, `rejectFit :3417` |
| Report tuning payload | `buildStage7Payload().tuning` | `stage7TuningPayload :17478` |
| Cards | DOM text `#tuningArea` (numbers only; slider markup is style) | `renderTuning :3524` |

### 1.7 Stage 6 — shared

| Observable | Read from | Code |
|---|---|---|
| Defaults | `stage6Defaults()` (exported `:18412`) — lock the full object once; any extraction that changes a default is a behaviour change | `:3736-4134` |
| Ensure/migration | `S.stage6` after `ensureStage6State()` on (a) fresh state, (b) a v0.5.2-style saved project | `:4249` |
| App switch | `S.stage6.app`, DOM text `#stage6Area .app-switch` | `setStage6App :4869`, `stage6CardsHtml :13171` |
| Banner | DOM text `#stage6Area .info` | `stage6SharedBanner :13148` |

### 1.8 Stage 6 applications

| App | Compute entry (pure) | Result location in browser | Config path | Extra observables |
|---|---|---|---|---|
| Bearing | `bearingProfile(cfg, layers)` → `{pts[], selected, drained[], undrained[], maxDepth}`; `bearingAtDepth(z,cfg,layers)` | `S.stage6Cache.bearing` (`:16787`) | `S.stage6.bearing` (`:3741-3755`) | `buildBearingChartConfig` datasets; DOM text of `#stage6Area` selected-depth card (`stage6BearingSelectedDepthHtml :13002`) |
| Piles | `analyzePile(layers, wt, cptRaw, cfg)` → `{capacity{deBeer, R_b, R_s, R_c, R_c_k, R_c_d, perLayer, …}, settlement{sHead_mm, curve, …}, notes}` | `S.stage6Cache.pile` (`:16791`) | `S.stage6.pile` (`:3791-3832`) | `PILE_CONSTANTS`; chart configs `buildPileDeBeerChartConfig/…` (`chart-factories.js:1082-1321`); per-layer table DOM (`renderPilePerLayerTable :13510`) |
| Settlement | `analyzeSettlement(layers, wt, cfg)` → `{qGross, qNet, totalSettlementMm, perLayer, sublayers, deltaStressCurve, eoedCurve, cumulativeCurve, truncationDepth, truncationCause, timeCurve, notes}` | `S.stage6Cache.settlement` (`:16796`) | `S.stage6.settlement` (`:3756-3773`) | `stage6-engineering.js:529-656` |
| Dewatering | `analyzeDewatering(layers, wt, cfg)` (drawdown curve, stress change, settlement) | `S.stage6Cache.dewatering` (`:16800`) | `S.stage6.dewatering` (`:3774-3790`) | `stage6-engineering.js:950`; note `waterTableAtDistance` is a **function** on the result (`:827`) — strip functions in normaliser |
| Beam / slab | `analyzeBeamAndReinforcement(layers, wt, cfg)` (SLS/ULS samples, reinforcement) | `S.stage6Cache.beam` (`:16808`) | `S.stage6.beam` (`:3833-3872`) | `stage6-engineering.js:1508`, `computeSubgradeReaction :1141` |
| Retaining walls | `buildRequest(rw, layers)` → `{request, profile}`; WASM `runRetainingAnalysis(request)`; `computeEmbeddedStructural(rw, result, profile)`; `runDrivability(rw, cpt, layers)`; `buildNotePayload(...)` | `S.stage6.retwall.{status, result, error, drivability.result}`; note payload via `window.retwallOpenNote()` → localStorage `retaining-note:*` | `S.stage6.retwall` (`wall-state.js:13`), 5 wall types × result tabs | Node verifier already exists (`scripts/verify_retaining_ui.mjs`) — golden adds the **numbers**. Views are HTML strings: `summaryCard, checksView, branchesView, plaxisView, structuralView, drivabilityView, vibrationView` → lock as text. Scene: `buildEmbeddedScene/buildGravityScene` objects (dims, polygons) → lock (this is what the canvas draws). |
| Seep / Slope — stability | worker `analyzeBishopSearch(input)` (`stage6-bishop.js:2571`); model `buildBishopModelFromStageLayers(layers, bishopState)` (`:2868`) | `S.stage6.bishop.results{allResults[], summary, wallSummary, rejectionCounts, timing}` (`:7685-7690`), `S.stage6Cache.bishopModel` (`:6509`) | `S.stage6.bishop.{terrain, phreatic, activeCptX, entryZone, exitZone, search, solver, spencer, materials, walls, surfaceLoads}` (`:3873-4134`) | Mask `timing`. `materials` are derived from layers by `importBishopMaterialsFromLayers` (`:2720`) — lock them (they carry the HS mirror written at `:6402-6414`). |
| Seep / Slope — seepage | worker `analyzeSeepageModel({model})` (`seepage/solver.js:2787`) | `S.stage6.bishop.seepage.{mesh, result, status, rejectReason}` (`:7731-7736`) | `bishop.seepage.{bcs, options}` (`:3979-4027`); BCs are assigned per outer edge (`stage6BishopSelectSeepageBoundary :6257`, edges from `S.stage6Cache.bishopSeepageBoundary :5475`) | Lock `result.{head[], flowError, solver.converged, solver.iterations, …}` and `mesh.{nodes.length, elements.length, cells[*].area sum}`; mask `*Ms`. Triangle mesh is deterministic for a fixed PSLG (Shewchuk's Triangle). |
| Seep / Slope — deformation | worker `analyzeDeformationModel(input)` (`deformation/solver.js:6354`) with `solverBackend` `wasm-cpu` (default) or `js-cpu` | `S.stage6.bishop.deformation.{mesh, result, status, warnings}` (`:7808-7812`) | `bishop.deformation.options` (`:4028-4134`), full option list posted at `:8094-8161` | Lock `result.summary.{maxSettlementMm, maxDisplacementMm}`, `result.loadFactor`, `solver.{convergenceState, iterations, safety*}`, nodal `u` arrays (tolerance 1e-6 across WASM); mask `timing`. Line probe: `stage6BishopBuildLineProbe :9665` (pure sampler over result) — lock its samples. |

### 1.9 Stratigraphy (Correlatie) and Doorsnede

| Observable | Read from | Code |
|---|---|---|
| Correlation result | `PROJECT.stratigraphy.{version, settings, result{fingerprint, units[{id, name, members[]}], manual}}` | `stratigraphy/store.js:32-72` |
| Derived units + polygons | `store.derived()` (not on `window`; reachable in Node via `createStratigraphyStore`) → in the browser lock the SOILIN payload instead (below) | `store.js:54 run, :166 derived`, `units.js:82`, `geometry.js:28` |
| SOILIN report payload | localStorage `soilin-report:*` after "Open SOILIN report" → `buildSoilinReportPayload` | `soilin-report.js:25, 99`; `stratigraphy/index.js:86-95` |
| Exports | CSV / PLAXIS / DXF text; db4 bytes (binary, compare SHA-256) | `exports.js:47, 176, 243`; `scia-db4.js:101, 140` (already verified byte-exact in `verify_scia_db4.mjs`) |
| Section SVG | `#sectionSvg.innerHTML` (pure markup, deterministic) | `renderSection :548`, `exportSectionSVG :795` |
| Correlation panel | DOM text `#stratPanel` | `stratigraphy/view.js` |

### 1.10 Project save / load

| Observable | Read from | Code |
|---|---|---|
| Snapshot | `buildProjectSnapshot(PROJECT, {activeStage, savedAt:'<fixed>', appVersion})` — in browser via download of `saveProject()` (`project-io/index.js:36-56`); in Node directly | `project-io/snapshot.js:39-55` |
| Validation | `validateProjectSnapshot` on {good, foreign, wrong kind, older version} | `snapshot.js:57` |
| Restore | `PROJECT` after `applyProjectSnapshot` + `afterLoad` (banner, `runClass`, layers restored, `goS`, `setPhase`) | `snapshot.js:95`, `legacy-controller.js:182-200` |
| Round-trip identity | `normalize(snapshot(load(snapshot(P)))) === normalize(snapshot(P))` | — |

### 1.11 Stage 7 report and calculation notes

| Observable | Read from | Code |
|---|---|---|
| Report payload (the canonical Stage 7 golden) | `window.buildStage7Payload()` — full object incl. `visuals.layerColumn.markup` / `visuals.layerProfile.markup` (SVG strings), `rawRows`, `classifiedRows`, `layers[*].hs/hydraulic`, `tuning`, `stage6.{bearing,pile,settlement,dewatering,beam,bishop,seepage,deformation}` | `:18166-18297`, `stage7Stage6Payload :18085`, `stage7WorkingLayerPayload :17517` |
| Report page | new tab `/report/stage7?key=…` → `innerText` of `.report-shell`; the annex charts are canvases (`stage7-*` ids, `report/stage7/+page.svelte:1043-1104`) — not locked; their configs come from the same `chart-factories.js` builders which are locked in Node | `report/stage7/+page.svelte` |
| Retaining note | `retaining-note:*` payload (`buildNotePayload`) + `/report/retaining` page `innerText` (`h1` contains "Verificatie", body contains "Laterale weerstand", "Toetsingen" — see existing spec) | `note-view.js:15-32`, `report/retaining/+page.svelte:42-45` |
| SOILIN report | `/report/soilin?key=…` `innerText` | `report/soilin/+page.svelte` |
| Payload validators | `isStage7Payload` on each recorded payload (guards schema drift) | `report-storage.js:61-90` |

### 1.12 Explicitly **not** locked

`S.charts` / `S.chartsReady` (Chart.js instances), `S.stage6.ui.details` and scroll state (`:4647-4730`), `bishop.viewport`, `bishop.progress.message` strings while running, canvas pixel data (`retwallCanvas`, Bishop canvas, pile section canvas, beam preview), `capturedView.*.dataUrl` PNGs (`stage7CaptureCanvasImage :17916` — mask to `<png:len>`), worker progress events, GPU pipeline (disabled: `useNewGpuPipeline:false` at `:8156`).

---

## 2. Harness design

Three tiers, one snapshot format, one normaliser, one comparer.

```
tests/golden/
├── README.md                     # how to run / update; the mask list is documented here
├── CHANGELOG.md                  # every intentional golden update: date, commit, reason
├── fixtures/                     # inputs (committed, generated by scripts/golden/make-fixtures.mjs)
│   ├── cpt/                      # demo-anonymous.gef, layered.gef, clay-only.gef, sand-only.gef,
│   │                             # wt-at-surface.gef, short.gef, qc-only.gef, kpa-units.gef,
│   │                             # layered.csv, layered-comma.csv, layered.xlsx
│   ├── projects/                 # *.madep.json saved projects (v0.5.3 format) incl. multi-CPT
│   ├── models/                   # bishop/seepage/deformation model JSONs (reuse scripts/fixtures/*)
│   └── manifest.json             # fixture name → file, sha256, generator seed
├── node/                         # Tier A+B goldens: <suite>/<fixture>.<case>.json
│   ├── classification/
│   ├── layers/
│   ├── model/
│   ├── tuning/
│   ├── stage6-bearing/  stage6-pile/  stage6-settlement/  stage6-dewatering/  stage6-beam/
│   ├── retaining/
│   ├── bishop/  seepage/  deformation/
│   ├── stratigraphy/
│   ├── project-io/
│   ├── report/
│   └── exports/                  # *.csv, *.txt as plain text goldens
├── browser/                      # Tier C goldens: <journey>/<step>.{state.json,dom.txt,png}
│   ├── demo-journey/
│   ├── gef-import-journey/
│   ├── seep-slope-journey/
│   ├── multi-cpt-journey/
│   └── save-load-journey/
└── .actual/                      # git-ignored; written on mismatch for `git diff --no-index`
```

### 2.1 Tier A — pure modules under Node (no Vite)

Direct ESM imports, same as the existing verifiers (`verify_project_io.mjs:14-20`,
`verify_stratigraphy.mjs:14-21`, `verify_seepage_phase_2.mjs:1-2`, `verify_deformation_phase_1.mjs:1-38`).
WASM engines load from `static/wasm/**` via `pathToFileURL` (`verify_retaining_ui.mjs:36-38`) and, for
deformation, `__setDeformationWasmModuleForTests(instance)` (`deformation/wasm/wasm-loader.js:62`).
Triangle WASM already resolves from disk under Node (`seepage/triangle-runtime.js:4, 33-37`).

Suites (case = fixture × parameter grid):

| Suite | Function(s) | Grid |
|---|---|---|
| `classification` | `classifyRobertson1990/2016, classifyCUR3, classifyNEN6740, classifyTabel3` | readings grid z∈{0.5..20 step 0.5} × qc∈{0.1,0.5,1,2,5,10,20,40} × rf∈{null,0.5,1,2,4,8}; `assumedRf` ∈ {2,3,5} |
| `stage6-*` | `analyzeSettlement, analyzeDewatering, analyzeBeamAndReinforcement, computeSubgradeReaction, analyzePile` | each fixture's working layers (from Tier B) × 3 configs (defaults, heavy, edge) |
| `retaining` | `buildRequest → wasm → computeEmbeddedStructural → views → buildNotePayload → runDrivability` | 5 wall types × {default, overrides, RK scheme 0/2} |
| `bishop` | `buildBishopModelFromStageLayers, analyzeBishopSearch` | `scripts/fixtures/bishop-phase-a/*.json` + one model per CPT fixture |
| `seepage` | `buildTriangleMesh, analyzeSeepageModel` | `baseFixedModel`/`layeredIterateModel` lifted from `verify_seepage_phase_2.mjs:194, 225` into `fixtures/models/` |
| `deformation` | `analyzeDeformationModel` js-cpu **and** wasm-cpu | `baseModel`/`slopedModel` from `verify_deformation_phase_1.mjs:165, 215` + `hs_*.json`; small meshes only (< 10 s each) |
| `stratigraphy` | `buildProfiles, correlateProfiles, deriveUnitProperties, buildSectionPolygons, buildSoilinReportPayload, buildUnitsCsv, buildPlaxisUnitCommands, buildSectionDxf, buildGeologicProfilesPayload` | 2- and 3-CPT projects |
| `project-io` | `buildProjectSnapshot, validateProjectSnapshot, applyProjectSnapshot` | each project fixture |
| `report-svg` | `buildLayerColumnSvgMarkup, buildLayerPreviewSvgMarkup` | layers from each CPT fixture |
| `chart-configs` | all `build*ChartConfig` in `chart-factories.js` | fed with the Stage 6 analyses above; strip functions (tick formatters) in normaliser |

### 2.2 Tier B — the controller under Node (Vite SSR + DOM stub)

This is the tier that makes extraction safe, because it exercises the *monolith's own* functions
(`runClass`, `detectLayers`, `hsParams`, `khParams`, `fitLayer`, `bearingProfile`, `exportCSV`,
`buildStage7Payload`, `stage6WorkingLayers`, `ensureStage6State`, `applyProjectSnapshot` glue).

Loading recipe (`scripts/golden/lib/load-controller.mjs`):

```js
// 1. DOM stub — auto-creating elements (verify_retaining_ui.mjs:15-19, extended)
const els = new Map();
const mk = (id) => ({ id, innerHTML:'', textContent:'', value:'', style:{}, dataset:{}, classList:{add(){},remove(){},toggle(){},contains:()=>false},
  getAttribute:()=>null, setAttribute(){}, removeAttribute(){}, querySelector:()=>null, querySelectorAll:()=>[], appendChild(){}, remove(){},
  addEventListener(){}, getBoundingClientRect:()=>({width:800,height:400,left:0,top:0}), getContext:()=>new Proxy({}, {get:()=>()=>({})}),
  click(){ captured.push({href:this.href, download:this.download}); }, parentElement:null });
globalThis.document = { getElementById:(id)=>els.get(id) ?? els.set(id, mk(id)).get(id), createElement:(t)=>mk('tmp:'+t),
  querySelector:()=>null, querySelectorAll:()=>[], body:{appendChild(){}}, addEventListener(){}, removeEventListener(){} };
globalThis.window = globalThis;                       // legacyApi is Object.assign'ed onto window (:18492)
globalThis.requestAnimationFrame = (fn)=>setTimeout(fn,0);
globalThis.alert = (m)=>{ alerts.push(m); };            // every guard path calls alert()
globalThis.confirm = ()=>true;
globalThis.Chart = class { constructor(){ this.data={datasets:[]}; } update(){} destroy(){} };  // F4: stops the 120 ms poll
globalThis.localStorage = memoryStorage();             // openStage7Report / notes
globalThis.Worker = undefined;                          // bishop/seepage/deformation guarded (:7665, :7713, :7789)
globalThis.URL.createObjectURL ??= ()=>'blob:stub'; globalThis.Blob ??= class{};
globalThis.__APP_VERSION__ = '0.5.3';                   // vite define (vite.config.ts:11) — ssrLoadModule with configFile:false does NOT apply it

// 2. Vite SSR load (verify_bishop_phase_a_parity.mjs:228-241)
const server = await createServer({ configFile:false, appType:'custom', logLevel:'error',
  server:{ middlewareMode:true, hmr:false, ws:false }, resolve:{ alias:{ $lib: resolve(root,'src/lib') } } });
const ctl = await server.ssrLoadModule('/src/lib/cpt-app/legacy-controller.js');
ctl.initLegacyController();                              // :18490
return { api: globalThis /* == window */, captured, alerts, server };
```

Then a golden case is just a script against `window.*`:

```js
const S = api.PROJECT.cpts[0];
S.data = fixtureRows; S.wt = 1.7; S.elev = 69.97; S.meta = {...};   // exactly what applyParsedCpt sets (:1123-1140)
for (const method of METHODS) { S.method = method; api.runClass(); snap(`classification/${fx}.${method}`, S.classified); snap(`layers/${fx}.${method}`, S.layers); }
S.method='sb260'; api.runClass();
for (const [a,s,k,p] of grid) { S.alphaMethod=a; S.stiffMethod=s; S.khKvMethod=k; S.paramMethod=p;
  snap(`model/${fx}.${a}${s}${k}.${p}`, S.layers.map(l=>({hs:api.hsParams(l), kh:api.khParams(l)}))); }
api.runTuning(); snap(`tuning/${fx}`, S.tuning); api.acceptFit(0); snap(`tuning/${fx}.accepted0`, S.layers.map(l=>api.hsParams(l)));
api.exportCSV(); snapText(`exports/${fx}.layers.csv`, decodeDataUrl(captured.pop().href));
api.exportPlaxisCommands(); snapText(`exports/${fx}.plaxis.txt`, ...); api.exportPlaxisCpt(); snapText(`exports/${fx}.plaxis-cpt.txt`, ...);
api.goS(5); for (const app of ['bearing','pile','settlement','dewatering','beam']) { api.setStage6App(app); snap(`stage6-${app}/${fx}.default`, S.stage6Cache[app]); }
snap(`report/${fx}`, api.buildStage7Payload());
```

Known rough edges to budget for: `renderStage6` schedules `requestAnimationFrame` work that touches
canvases (`:16813-16829`) — the `getContext` Proxy absorbs it; `stage6CaptureScrollState` reads
`querySelectorAll` (returns `[]`); `buildStage7Payload` calls `stage7CaptureBishopWorkspaceView`
only when Bishop results exist (`:18129`), so the canvas path is not hit for the basic fixtures.
If the stub turns out too brittle, the fallback is `happy-dom` as a devDependency (not present today).

### 2.3 Tier C — browser goldens with Playwright

One spec file, several journeys, each journey a linear list of **steps**; every step records:

1. `state.json` — `page.evaluate(() => window.__golden.captureState())` where `captureState`
   (injected by `page.addInitScript` from `scripts/golden/lib/browser-capture.js`) returns
   `{ project: strip(PROJECT), active: {stage6Cache: strip(S.stage6Cache)}, stage: activePanelIndex(), phase: PROJECT.phase }`.
   `strip` = JSON round-trip that drops `charts`, `chartsReady`, functions, and `dataUrl` strings.
2. `dom.txt` — `innerText` of a step-specific list of containers (§1), whitespace-collapsed.
3. `png` — `page.screenshot({fullPage:false})` of the active panel, **secondary**, compared with
   `maxDiffPixelRatio: 0.02` and never blocking `golden:check` unless `--strict-visual`.
4. `console.txt` — page errors and console errors (must be empty; already the existing spec's rule).

Determinism setup per test (`beforeEach`):

```js
await page.addInitScript(({seed, epoch}) => {
  // F1: seeded PRNG (mulberry32) so loadDemo() is reproducible
  let t = seed >>> 0; Math.random = () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
  // F5: frozen clock for generatedAt/savedAt/ids (masking still applies as belt-and-braces)
  const RealDate = Date; const fixed = new RealDate(epoch);
  globalThis.Date = class extends RealDate { constructor(...a){ super(...(a.length ? a : [fixed])); } static now(){ return fixed.getTime(); } };
  let p = 0; performance.now = () => (p += 1);
}, { seed: 20260829, epoch: '2026-01-01T00:00:00Z' });
await page.route('https://cdnjs.cloudflare.com/ajax/libs/Chart.js/**', r => r.fulfill({ path: 'tests/golden/vendor/chart.umd.js', contentType: 'text/javascript' }));   // F4
await page.route('https://analytics.madep.digital/**', r => r.abort());
```

Journeys (each is one Playwright `test`, steps numbered so the file list sorts):

| Journey | Steps |
|---|---|
| `gef-import-journey` | goto `/` → `setInputFiles('#fi', fixtures/cpt/layered.gef)` → dom(`.import-review-overlay`) → click `[data-ir="apply"]` → wait `S.data.length>0 && S.chartsReady` → **01-loaded** → `runClass()` for each method (`window.selM`/`S.method`) → **02-classified-<method>** → `goS(2)` → **03-layers** → `changeSubtype` on layer 1 via `#lb select` → **04-layers-edited** → `goS(3)` + toggle `setAlphaMethod('A'/'B')`, `setStiffMethod`, `setParamMethod` → **05-model-\*** → `goS(4)`, `runTuning()`, `acceptFit(0)` → **06-tuning** → `goS(5)` → for app in bearing, pile, settlement, dewatering, beam: `setStage6App(app)`, tweak one field via `setStage6Field` → **07-<app>** → `setStage6App('retwall')` → per wall type: `retwallSetType`, wait `retwall.status==='done'`, click every `#retwallResultTabs button`, dom(`#retwallSummary`, `#retwallResultBody`) → **08-retwall-<type>-<tab>** → `retwallRunDrivability()` wait `drivability.status==='done'` → **09-drivability** → `retwallOpenNote()` → note tab dom → **10-note** → downloads: `exportCSV`, `exportPlaxisCommands`, `exportPlaxisCpt`, `saveProject` → **11-exports** (text + normalised project JSON) → `openStage7Report()` → report tab dom + `buildStage7Payload()` → **12-report** |
| `demo-journey` | same as above but starts with the "Load demo — anonymous profile" button under the seeded PRNG (locks `loadDemo` itself: `:1823-1846` metadata, 1080 rows) |
| `seep-slope-journey` | after layers exist: `setStage6App('bishop')`; inject geometry by state: `S.stage6.bishop.terrain=[{x:0,y:4},{x:8,y:4},{x:20,y:0}]`, `entryZone={xStart:1,xEnd:5}`, `exitZone={xStart:13,xEnd:19}`, `search.keepBest=6`, then `renderStage6()` (`stage6BishopSyncSoilModel` fills `activeCptX` `:6457`) → **01-model** (`S.stage6Cache.bishopModel`, `bishop.materials`) → `stage6BishopRunSearch()` wait `!bishop.progress.running && bishop.results` → **02-stability** (`bishop.results` masked) → `stage6BishopSetWorkspace('seepage')`; pick edges from `S.stage6Cache.bishopSeepageBoundary` by `edgeKey` prefix `side-left`/`side-right` (`seepage/boundary.js:108-110`), `stage6BishopSelectSeepageBoundary(key)`, `stage6BishopSetSeepageBcType('head')`, `stage6BishopSetSeepageBcHead(h)` → `stage6BishopRunSeepage()` wait `seepage.status==='success'` → **03-seepage** → `stage6BishopSetWorkspace('deformation')`; `stage6BishopSetSurfaceLoadField` on a load created via `S.stage6.bishop.surfaceLoads=[{xStart:2,xEnd:6,q:20,active:true}]` → `stage6BishopRunDeformation()` wait `deformation.status==='success'` (T3, small `meshTargetArea` for speed) → **04-deformation** → `stage7CaptureWorkspaceView('stability')` → `buildStage7Payload().stage6.{bishop,seepage,deformation}` → **05-report-annexes** |
| `multi-cpt-journey` | import 3 GEF fixtures at once (`setInputFiles('#fi', [a,b,c])`, apply 3× — the dialog is sequential, `importCptFiles :418`) → set `S.x/S.y/S.elev` per CPT via `setCptCoord`/`setElev` → `setPhase('correlation')` → dom(`#stratPanel`), state `PROJECT.stratigraphy` → SOILIN report tab → `setPhase('section')` → `#sectionSvg.innerHTML` → exports (csv/plaxis/dxf downloads; db4 → sha256) |
| `save-load-journey` | run `gef-import-journey` to step 07 → `saveProject()` download → reload page → `loadProjectFromFile(File)` via `setInputFiles('#projFileInput', …)` (`BannerPhaseShell.svelte:52`) → **02-restored** must equal **01-saved** after normalisation (`savedAt`, `activeStage`), and `#lb`, `#ma`, `#stage6Area` dom must match |

Waits: `page.waitForFunction(pred, {timeout})` on state, never `waitForTimeout`, except a single
`requestAnimationFrame` tick after `renderStage6` (charts build in rAF `:16813`).

### 2.4 Tier D — WASM / native (already present, wired in, not duplicated)

- `npm run verify:wasm` (deformation smoke, T6, plastic, MC unit, MC local parity) and
  `npm run verify:retaining` (`verify_retaining_wasm.mjs` + UI + behaviour + soil profile + PLAXIS + request).
- Native: `g++ -std=c++20 -O2 -I src/wasm/retaining src/wasm/retaining/test_native.cpp -o /tmp/rwtest && /tmp/rwtest`.
- New: `scripts/golden/wasm-hash.mjs` records `sha256(static/wasm/*/*.wasm)` into
  `tests/golden/wasm.sha256.json`; `golden:check` fails if the binaries changed without the
  golden being updated. This is what makes "1e-6 across WASM" an honest tolerance — the same
  binary is under test on every machine.

### 2.5 Snapshot format, normalisation, tolerance, diffing

**Format.** One JSON file per case, pretty-printed with 2-space indent and **sorted keys** at every
level (so diffs are positional-noise free). Numbers are stored raw (no rounding at record time —
rounding hides drift; tolerance is applied at compare time). Text goldens (`.txt`, `.csv`, `.svg`)
are stored verbatim with `\n` line endings.

**Normaliser** (`scripts/golden/lib/normalize.mjs`), applied at both record and check time:

```js
export const MASK_KEYS = new Set(['generatedAt','savedAt','capturedAt','timing','totalMs','solveMs','generatedMs','elapsedMs','runId','dataUrl','copyMessage','copyTone']);
export const MASK_KEY_PATTERNS = [/Ms$/, /^_/];                       // *_Ms timings, private/transient (_maxStage kept: it is behaviour)
export const MASK_STRING_PATTERNS = [
  [/^(wall|drain|region)_[0-9a-z]+_[0-9a-z]{5}$/, '<id>'],           // :5182, :5323, :5390
  [/^bc-[0-9a-z]+-[0-9a-z]{4}$/, '<id>'],                              // :5524, :6286
  [/^(stage7-report|retaining-note|soilin-report):\d+-[0-9a-z]+$/, '<key>'],
  [/^data:image\/png;base64,.*/, '<png>'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, '<iso>']
];
export const DROP_KEYS = new Set(['charts','chartsReady']);           // Chart.js instances (snapshot.js:22)
export function normalize(v, path='') {
  if (typeof v === 'function' || v === undefined) return undefined;   // dewatering result carries a function (:827); tick formatters in chart configs
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);   // NaN/Infinity survive JSON as strings
  if (typeof v === 'string') { for (const [re, rep] of MASK_STRING_PATTERNS) if (re.test(v)) return rep; return v; }
  if (Array.isArray(v)) return v.map((x,i)=>normalize(x, `${path}[${i}]`));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) {
      if (DROP_KEYS.has(k)) continue; if (MASK_KEYS.has(k) || MASK_KEY_PATTERNS.some(re=>re.test(k))) { o[k] = '<masked>'; continue; }
      const n = normalize(v[k], `${path}.${k}`); if (n !== undefined) o[k] = n; } return o; }
  return v;
}
```

**Tolerance** (`scripts/golden/lib/compare.mjs`): per-suite `{rel, abs}` read from
`tests/golden/tolerances.json`:

| Suite class | rel | abs | Rationale |
|---|---|---|---|
| Pure JS (classification, layers, model, tuning, stage6-bearing/pile/settlement/dewatering/beam, stratigraphy, project-io, report, chart-configs, retaining JS views) | `1e-9` | `1e-12` | Same Node version, same code path → identical; 1e-9 only absorbs future `Math.pow` micro-differences across V8 versions |
| Anything crossing WASM (retaining engine numbers, deformation wasm-cpu, MC/HS material points) | `1e-6` | `1e-9` | `-ffast-math` builds (`build.sh:26`) and different Emscripten/host FP paths |
| Iterative JS solvers (bishop, seepage, deformation js-cpu) | `1e-6` | `1e-9` | Accumulated ordering effects when a loop is extracted/refactored; iteration counts must still match exactly |
| Text goldens | exact | — | After normalisation |
| Screenshots | `maxDiffPixelRatio 0.02` | — | Secondary only |

Comparison is structural: same key set (missing/extra key = failure, no matter the value), same
array lengths, numbers compared with `|a-b| <= max(abs, rel*max(|a|,|b|))`, everything else `===`.

**Readable diff.** On mismatch `check.mjs` prints, per case, the first 25 differences as
`path: expected → actual (Δrel)` and writes the full normalised actual to
`tests/golden/.actual/<same relative path>` so the engineer can run
`git diff --no-index tests/golden/node tests/golden/.actual/node` (or open both in an editor). A
summary table at the end lists `PASS/FAIL/NEW/MISSING` counts per suite. Exit code 1 on any FAIL
or MISSING (a golden present on disk but no longer produced — this catches silently dropped
outputs during extraction).

**`--update` semantics.** `record.mjs` writes everything; `check.mjs --update` rewrites only the
failing cases and prints what it rewrote; `--update --filter <glob>` scopes it. Any update must be
accompanied by an entry in `tests/golden/CHANGELOG.md` (the PR template asks for it; CI greps that
the changelog changed whenever `tests/golden/**` changed — see §4.6).

---

## 3. Fixtures

### 3.1 CPT inputs (`tests/golden/fixtures/cpt/`)

All generated by `scripts/golden/make-fixtures.mjs` from a **seeded** PRNG (mulberry32, seed in
`manifest.json`) so they can be regenerated bit-identically; committed anyway so the goldens do not
depend on the generator.

| Fixture | Content | Why |
|---|---|---|
| `demo-anonymous.gef` | The exact profile shape of `loadDemo()` (`:1825-1836`: 8 depth bands, 0.14–21.73 m, 0.02 m step, `fs = qc·rf/100`) with seed 20260829; GEF header `#COLUMNINFO` 1/2/3/4 (depth/qc/fs/Rf), `#MEASUREMENTVAR= 14, 1.70`, `#ZID= 31000, 69.97`, `#TESTID`, `#PROJECTID` | Deterministic stand-in for the demo; goes through the real GEF parser (`:1346`) |
| `layered.gef` | 6 clean layers (fill / sand / clay / sandy clay / sand / clay), 0–18 m, small noise, u2 column present (quantity 6) | Main fixture for every suite; exercises `hasU2` |
| `clay-only.gef` | qc 0.4–1.5 MPa, Rf 3–6 %, 0–12 m | One-type profile, cohesive param path (`hsParams` m=1.0 branch `:3093-3095`), settlement-heavy |
| `sand-only.gef` | qc 8–30 MPa, Rf 0.4–1.2 %, 0–15 m | Granular branch, `alphaEB` sand family, pile capacity |
| `wt-at-surface.gef` | `layered` with `MEASUREMENTVAR 14 = 0.0` | `stressAt` with `z<=wt` never true (`:1933`); dewatering `targetWt` guards |
| `short.gef` | 2.0 m, 0.02 m step (94 rows after `qc<0.02` skip) | `fitLayer` `rows<5` branch (`:3281`), `bearingProfile` step clamp (`:12985`), `analysisDepth` floor (`stage6-bishop.js:2888`) |
| `qc-only.gef` | `layered` without columns 3/4 | assumed-Rf path everywhere (`:2129`, `classAssumedRfNote :2147-2156`, `rfIndeterminate :2517`), simulated fs export (`:17362`) |
| `trailing-qc-only.gef` | `layered` whose last 3 rows lack fs/Rf | the "quiet data note" branch (`:2166-2172`), import-review `missingOnlyTrailing` note (`modal.js:45-51`) |
| `kpa-units.gef` | `layered` with `#COLUMNINFO` units `kPa` for qc and fs | `cptValueToMPa` label conversion (`tabular.js`, `:1413-1414`) |
| `corrected-depth.gef` | `layered` with quantity 11 (corrected depth) **and** 1 | `get(11)??get(1)` precedence (`:1405`) |
| `layered.csv`, `layered-comma.csv` | `depth,qc,fs` (README format) and `;`-separated with comma decimals | `parseCsvCpt :1299`, `parseDelimitedText :1272`, `parseCptNumber` |
| `layered.xlsx` | `Data` + `Header` sheets written with the `xlsx` dependency (already in `package.json`) — Header carries project, CPT number, water level, ground level, X/Y | `parseExcelCpt :1159`, header lookups |
| `wt-above-surface.state.json` | not a file import: `{wt:-0.5}` applied by state injection on `layered` | F11 — documents today's behaviour |

### 3.2 Projects (`tests/golden/fixtures/projects/`)

- `single-layered.madep.json` — produced by Tier B from `layered.gef` after Stages 2–6 (bearing +
  pile + settlement configured, retwall `soldierpile` with one override), `savedAt` fixed.
- `multi-3cpt.madep.json` — 3 CPTs (`layered`, `sand-only`, `clay-only`) with `x/y/elev` set so the
  stratigraphy correlates (spacing 30 m, elevation offsets 0 / +0.4 / −0.3); `phase:'correlation'`,
  one manual unit rename (`store.renameUnit`, as in `verify_project_io.mjs:97`).
- `legacy-v0.5.2.madep.json` — hand-trimmed copy of `single-layered` with the newer keys removed
  (`stage6.retwall.drivability`, `bishop.deformation.options.useWallInterface`, `stratigraphy.settings.characteristic`)
  to lock the forward-compat merge (`snapshot.js:74-85`, `wall-state.js:84 ensure`, `store.js:37`).

### 3.3 Solver models (`tests/golden/fixtures/models/`)

Copied/lifted, not invented: `scripts/fixtures/bishop-phase-a/{homogeneous_dry,benchmark_spencer}.json`,
`scripts/fixtures/hs_*.json`, and the inline model builders of `verify_seepage_phase_2.mjs:174-306`
and `verify_deformation_phase_1.mjs:165-268` exported to JSON by `make-fixtures.mjs` (they are pure
functions of constants). Plus one model per CPT fixture produced by
`buildBishopModelFromStageLayers(workingLayers, bishopStateWithTerrain)` in Tier B.

### 3.4 Vendor (`tests/golden/vendor/chart.umd.js`)

Downloaded once by `scripts/golden/fetch-vendor.mjs` from the same pinned URL as
`+page.svelte:66` (Chart.js 4.4.1), sha256 recorded in `manifest.json`. Committed (≈200 kB) so CI
runs offline; the browser tests `page.route` the CDN URL to it.

---

## 4. Concrete scripts

```
scripts/golden/
├── record.mjs                 # runs all Node suites, writes tests/golden/node/**
├── check.mjs                  # runs all Node suites, compares; --update, --filter, --list
├── make-fixtures.mjs          # generates tests/golden/fixtures/** + manifest.json (seeded)
├── fetch-vendor.mjs           # chart.umd.js → tests/golden/vendor
├── wasm-hash.mjs              # sha256 of static/wasm/**/*.wasm → tests/golden/wasm.sha256.json
├── lib/
│   ├── normalize.mjs          # §2.5
│   ├── compare.mjs            # tolerance compare + diff formatter
│   ├── store.mjs              # read/write goldens, .actual, sorted-key JSON
│   ├── prng.mjs               # mulberry32 (shared with browser init script)
│   ├── gef-writer.mjs         # rows → GEF text (COLUMNINFO/MEASUREMENTVAR/ZID/EOH)
│   ├── load-controller.mjs    # §2.2 Vite SSR + DOM stub → { api, captured, alerts, close() }
│   ├── wasm.mjs               # retaining + deformation module instantiation from static/wasm
│   └── browser-capture.js     # injected into the page: window.__golden.{captureState, domText, waitState}
└── suites/                    # one file per suite, each exports { name, tolerance, async *cases(ctx) }
    ├── classification.mjs   layers.mjs   model.mjs   tuning.mjs   exports.mjs   report.mjs
    ├── stage6-bearing.mjs   stage6-pile.mjs   stage6-settlement.mjs   stage6-dewatering.mjs   stage6-beam.mjs
    ├── retaining.mjs   bishop.mjs   seepage.mjs   deformation.mjs   stratigraphy.mjs   project-io.mjs
    └── chart-configs.mjs   report-svg.mjs
tests/e2e/golden-journey.spec.mjs   # Tier C
tests/e2e/golden.config.mjs         # Playwright project "golden" (reuses playwright.config.mjs webServer)
```

### 4.1 `scripts/golden/lib/store.mjs`

```js
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const GOLDEN = resolve(ROOT, 'tests/golden');
export const stableJson = (v) => JSON.stringify(v, null, 2) + '\n';          // v already key-sorted by normalize()
export function readGolden(rel) { const p = join(GOLDEN, rel); return existsSync(p) ? (rel.endsWith('.json') ? JSON.parse(readFileSync(p,'utf8')) : readFileSync(p,'utf8')) : undefined; }
export function writeGolden(rel, v) { const p = join(GOLDEN, rel); mkdirSync(dirname(p), {recursive:true}); writeFileSync(p, typeof v === 'string' ? v : stableJson(v)); }
export function writeActual(rel, v) { writeGolden(join('.actual', rel), v); }
export function listGoldens(prefix) { /* walk GOLDEN/prefix, return relative paths */ }
```

### 4.2 `scripts/golden/lib/compare.mjs`

```js
export function compare(expected, actual, { rel, abs }, path = '', out = []) {
  if (out.length > 500) return out;
  const te = typeof expected, ta = typeof actual;
  if (te === 'number' && ta === 'number') { const d = Math.abs(expected - actual); if (d > Math.max(abs, rel * Math.max(Math.abs(expected), Math.abs(actual)))) out.push({ path, expected, actual, drel: d / Math.max(Math.abs(expected), 1e-300) }); return out; }
  if (Array.isArray(expected) && Array.isArray(actual)) { if (expected.length !== actual.length) { out.push({ path, expected: `len ${expected.length}`, actual: `len ${actual.length}` }); return out; } expected.forEach((e, i) => compare(e, actual[i], {rel, abs}, `${path}[${i}]`, out)); return out; }
  if (expected && actual && te === 'object' && ta === 'object') { const ke = Object.keys(expected), ka = Object.keys(actual); for (const k of ke) if (!(k in actual)) out.push({ path: `${path}.${k}`, expected: '<present>', actual: '<missing>' }); for (const k of ka) if (!(k in expected)) out.push({ path: `${path}.${k}`, expected: '<absent>', actual: '<new key>' }); for (const k of ke) if (k in actual) compare(expected[k], actual[k], {rel, abs}, `${path}.${k}`, out); return out; }
  if (expected !== actual) out.push({ path, expected, actual });
  return out;
}
export function formatDiffs(diffs, limit = 25) { return diffs.slice(0, limit).map(d => `  ${d.path || '<root>'}: ${fmt(d.expected)} → ${fmt(d.actual)}${d.drel != null ? `  (Δrel ${d.drel.toExponential(2)})` : ''}`).join('\n') + (diffs.length > limit ? `\n  … ${diffs.length - limit} more` : ''); }
```

### 4.3 `scripts/golden/record.mjs` and `check.mjs` (one runner, two modes)

```js
// scripts/golden/lib/runner.mjs — shared by record.mjs / check.mjs
import * as suites from '../suites/index.mjs';                 // { classification, layers, ... }
export async function run({ mode, filter, update, strict }) {  // mode: 'record' | 'check'
  const tol = JSON.parse(readFileSync(join(GOLDEN, 'tolerances.json')));
  const ctx = await makeContext();                              // loads fixtures manifest, wasm modules (lazy), controller (lazy, once)
  const summary = {}; let failed = 0;
  for (const suite of Object.values(suites)) {
    if (filter && !minimatch(suite.name, filter)) continue;
    const seen = new Set(); const s = summary[suite.name] = { pass:0, fail:0, new:0, missing:0 };
    for await (const { id, value, kind = 'json' } of suite.cases(ctx)) {        // id like 'layered.robertson2016'
      const rel = `node/${suite.name}/${id}.${kind === 'json' ? 'json' : kind}`;
      const actual = kind === 'json' ? normalize(value) : value;  seen.add(rel);
      if (mode === 'record') { writeGolden(rel, actual); s.pass++; continue; }
      const expected = readGolden(rel);
      if (expected === undefined) { s.new++; if (update) writeGolden(rel, actual); else { writeActual(rel, actual); failed++; console.log(`NEW   ${rel}`); } continue; }
      const diffs = kind === 'json' ? compare(expected, actual, tol[suite.tolerance || 'pure']) : (expected === actual ? [] : textDiff(expected, actual));
      if (!diffs.length) { s.pass++; continue; }
      s.fail++; failed++; writeActual(rel, actual); console.log(`FAIL  ${rel}\n${formatDiffs(diffs)}`);
      if (update) { writeGolden(rel, actual); console.log(`      updated`); }
    }
    for (const rel of listGoldens(`node/${suite.name}`)) if (!seen.has(rel)) { s.missing++; failed++; console.log(`MISSING ${rel} (golden exists, no longer produced)`); }
  }
  printTable(summary); await ctx.close();
  process.exit(failed && !update ? 1 : 0);
}
// record.mjs:  run({ mode:'record', filter: argv.filter })
// check.mjs:   run({ mode:'check', filter: argv.filter, update: argv.update, strict: argv.strict })
```

`makeContext()` exposes: `fixtures.cpt(name) → rows` (parsed by the controller's own `parseGEF` in Tier B — with `presentImportReview` short-circuited by stubbing the overlay's `[data-ir="apply"]`; simpler: the suite calls `api.parseGEF(text, name)` and immediately resolves the review by dispatching `close(result)` — since `presentImportReview` is DOM-only, Tier B replaces it by monkey-patching `document.body.appendChild` to auto-click `apply`. If this is too fiddly, Tier B injects rows straight into `S.data` as `applyParsedCpt` does (`:1123-1140`) and the GEF **parser** is locked separately in Tier C), `controller()` (lazy `load-controller.mjs`), `retainingWasm()`, `deformationWasm()`.

### 4.4 A suite in full — `scripts/golden/suites/layers.mjs`

```js
export const name = 'layers'; export const tolerance = 'pure';
const METHODS = ['robertson','robertson2016','cur3','nen6740','sb260'];
export async function* cases(ctx) {
  const { api } = await ctx.controller();
  for (const fx of ctx.fixtures.cptNames()) {                       // layered, clay-only, sand-only, wt-at-surface, short, qc-only, trailing-qc-only, kpa-units, corrected-depth, demo-anonymous
    ctx.loadCpt(api, fx);                                            // sets S.data/wt/elev/meta exactly like applyParsedCpt (:1123-1140)
    const S = api.PROJECT.cpts[api.PROJECT.activeCptIdx];
    for (const method of METHODS) {
      S.method = method; S.smartMerge = true; S.minThk = 0.5; S.smartMergeSensitivity = 1.1; api.runClass();
      yield { id: `${fx}.${method}.smart`, value: S.layers };
      S.smartMerge = false; api.detectLayers();
      yield { id: `${fx}.${method}.simple`, value: S.layers };
    }
    S.method = 'sb260'; S.smartMerge = true;
    for (const minThk of [0.3, 1.0]) { S.minThk = minThk; api.detectLayers(); yield { id: `${fx}.minThk${minThk}`, value: S.layers }; }
    for (const sens of [0.9, 1.3]) { S.minThk = 0.5; S.smartMergeSensitivity = sens; api.detectLayers(); yield { id: `${fx}.sens${sens}`, value: S.layers }; }
    // manual edit path (Stage 3): subtype change + override flags
    S.minThk = 0.5; S.smartMergeSensitivity = 1.1; api.detectLayers();
    api.changeSubtype({ dataset:{ i:'1' }, value: 'klei, vast' });
    api.editL({ dataset:{ i:'0', f:'phi' }, value: '35' });
    yield { id: `${fx}.edited`, value: S.layers };
    yield { id: `${fx}.edited.dom-lb`, kind: 'txt', value: domText(api, 'lb') };   // innerHTML of the stub → tag-stripped text
  }
}
```

`stage6-*.mjs` suites feed `api.hsParams/khParams`-decorated layers (`stage6WorkingLayers`
equivalent, `:4162`) into the pure analyses with three configs each (`stage6Defaults()` values,
a "heavy" set, an "edge" set: `Df` deeper than the CPT, `B=0.3`, `targetWt` below CPT, `Gk=0`).

`retaining.mjs` mirrors `verify_retaining_ui.mjs:38-104` but **yields the objects** (`built.request`,
`result`, `st`, `drv`, `payload`, each view's HTML as `.txt`, `buildEmbeddedScene(...)` as JSON).

`report.mjs` yields `api.buildStage7Payload()` after each Stage 6 app has been rendered once (the
annexes only appear when `stage6Cache` is populated, `:18087-18118`), plus `isStage7Payload(payload) === true` as a boolean golden.

### 4.5 `tests/e2e/golden-journey.spec.mjs` (Tier C)

```js
import { test, expect } from '@playwright/test';
import { Journey } from '../../scripts/golden/lib/journey.mjs';     // wraps record/check for browser goldens
const MODE = process.env.GOLDEN_MODE || 'check';                     // 'record' | 'check' | 'update'

test.beforeEach(async ({ page, context }) => { await installDeterminism(page); await installCapture(page); page.on('pageerror', …); });

test('gef-import-journey', async ({ page, context }) => {
  const j = new Journey('gef-import-journey', { page, context, mode: MODE, dom: ['#mgrid','#cmet','#lb','#ma','#tuningArea','#stage6Area','#classAssumedRfNote'] });
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.setInputFiles('#fi', 'tests/golden/fixtures/cpt/layered.gef');
  await page.locator('.import-review-overlay').waitFor();
  await j.step('00-import-review', { dom: ['.import-review-overlay'] });
  await page.click('[data-ir="apply"]');
  await j.waitState(s => s.active.data.length > 0 && s.active.chartsReady);
  await j.step('01-loaded');
  for (const m of ['robertson','robertson2016','cur3','nen6740','sb260']) { await page.evaluate(m => { window.PROJECT.cpts[window.PROJECT.activeCptIdx].method = m; window.runClass(); }, m); await j.step(`02-classified-${m}`); }
  await page.evaluate(() => window.goS(2)); await j.step('03-layers');
  await page.selectOption('#lb tr:nth-child(2) select', { label: /klei, vast/ }); await j.step('04-layers-edited');
  await page.evaluate(() => window.goS(3)); await j.step('05-model-BBA');
  await page.evaluate(() => { window.setAlphaMethod('A'); window.setStiffMethod('A'); }); await j.step('05-model-AAA');
  await page.evaluate(() => { window.goS(4); window.runTuning(); window.acceptFit(0); }); await j.step('06-tuning');
  await page.evaluate(() => window.goS(5));
  for (const app of ['bearing','pile','settlement','dewatering','beam']) { await page.evaluate(a => window.setStage6App(a), app); await j.nextFrame(); await j.step(`07-${app}`); }
  await page.evaluate(() => window.setStage6App('retwall'));
  for (const t of ['cantilever','gravity','sheetpile','anchored','soldierpile']) {
    await page.evaluate(t => window.retwallSetType(t), t);
    await j.waitState(s => s.active.stage6.retwall.status === 'done');
    for (const tab of await page.locator('#retwallResultTabs button').allTextContents()) {
      await page.locator('#retwallResultTabs button', { hasText: tab }).click(); await j.nextFrame();
      await j.step(`08-retwall-${t}-${slug(tab)}`, { dom: ['#retwallSummary','#retwallResultBody'], screenshot: false });
    }
  }
  await page.evaluate(() => window.retwallRunDrivability()); await j.waitState(s => s.active.stage6.retwall.drivability.status === 'done'); await j.step('09-drivability', { dom: ['#retwallResultBody'] });
  const [note] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => window.retwallOpenNote())]); await note.waitForLoadState('networkidle');
  await j.stepPage('10-note', note, { dom: ['.report-shell'], localStorageKeyPrefix: 'retaining-note:' });
  for (const fn of ['exportCSV','exportPlaxisCommands','exportPlaxisCpt','saveProject']) { const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(f => window[f](), fn)]); await j.download(`11-${fn}`, dl); }   // saveProject → normalised JSON, others → text
  const [rep] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => window.openStage7Report())]); await rep.waitForLoadState('networkidle');
  await j.stepPage('12-report', rep, { dom: ['.report-shell'], payload: () => page.evaluate(() => window.buildStage7Payload()) });
  await j.finish();   // in check mode: expect(j.failures).toEqual([])
});
```

`Journey.step(name, opts)` = capture state (`window.__golden.captureState()`), dom text of `opts.dom ?? defaults`, optional screenshot, then `record` → write, `check` → compare against `tests/golden/browser/<journey>/<name>.*` with `tolerances.browser` (`1e-6`, because the retaining numbers cross WASM and the seep/slope runs cross Workers/WASM; state that is pure-JS is still expected to be identical), `update` → overwrite failing. Screenshots use Playwright's own `expect(page).toHaveScreenshot(name, { maxDiffPixelRatio: 0.02 })` with `snapshotDir: 'tests/golden/browser'` so `--update-snapshots` handles PNG updates natively and separately from the JSON/text goldens.

`browser-capture.js` (injected):

```js
window.__golden = {
  captureState() { const P = window.PROJECT; const S = P.cpts[P.activeCptIdx];
    const strip = (v) => JSON.parse(JSON.stringify(v, (k, x) => (k === 'charts' || k === 'chartsReady' || typeof x === 'function') ? undefined : x));
    const panels = [...document.querySelectorAll('.panel')]; return { stage: panels.findIndex(p => p.classList.contains('active')), phase: P.phase,
      project: strip({ ...P, cpts: P.cpts.map(c => ({ ...c, stage6Cache: undefined })) }), active: strip({ ...S, charts: undefined }), cache: strip(S.stage6Cache || {}) }; },
  domText(sel) { return [...document.querySelectorAll(sel)].map(e => e.innerText.replace(/\s+/g, ' ').trim()).join('\n'); }
};
```

### 4.6 npm scripts and CI

`package.json` additions (no existing script is touched):

```json
"golden:fixtures": "node scripts/golden/make-fixtures.mjs && node scripts/golden/fetch-vendor.mjs && node scripts/golden/wasm-hash.mjs --write",
"golden:record":   "node scripts/golden/record.mjs",
"golden:check":    "node scripts/golden/check.mjs",
"golden:update":   "node scripts/golden/check.mjs --update",
"golden:browser":  "playwright test tests/e2e/golden-journey.spec.mjs",
"golden:browser:record": "GOLDEN_MODE=record playwright test tests/e2e/golden-journey.spec.mjs --update-snapshots",
"golden:browser:update": "GOLDEN_MODE=update playwright test tests/e2e/golden-journey.spec.mjs --update-snapshots",
"verify:core":     "npm run verify:nen6740 && npm run verify:stratigraphy && npm run verify:import-review && npm run verify:project-io && npm run verify:scia-db4 && npm run verify:qc-only && npm run verify:retaining && npm run verify:wasm && npm run verify:bishop-phase-a",
"test:all":        "npm run check && npm run verify:core && npm run golden:check && npm run golden:browser && npm run test:e2e"
```

(`verify:core` deliberately excludes the long GPU / HS / arc-length phase suites; they stay on-demand.)

`.github/workflows/ci.yml` outline:

```yaml
name: ci
on: { push: { branches: [main, 'v*'] }, pull_request: {} }
jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: node scripts/golden/wasm-hash.mjs --check          # prebuilt static/wasm/** must match tests/golden/wasm.sha256.json
      - run: npm run check                                       # svelte-check (known pre-existing errors → allow-failure until fixed, see PROGRESS 11:19)
        continue-on-error: true
      - run: npm run verify:core
      - run: npm run golden:check
      - name: golden changelog guard
        if: github.event_name == 'pull_request'
        run: |
          git fetch origin ${{ github.base_ref }} --depth=1
          if git diff --name-only origin/${{ github.base_ref }}...HEAD | grep -q '^tests/golden/' ; then
            git diff --name-only origin/${{ github.base_ref }}...HEAD | grep -q '^tests/golden/CHANGELOG.md' || { echo 'tests/golden changed without CHANGELOG entry'; exit 1; }; fi
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: golden-actual, path: tests/golden/.actual }
  browser:
    runs-on: ubuntu-latest
    needs: node
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - uses: actions/cache@v4
        with: { path: ~/.cache/ms-playwright, key: pw-${{ runner.os }}-${{ hashFiles('package-lock.json') }} }
      - run: npx playwright install --with-deps chromium
      - run: npm run golden:browser
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright, path: | 
                test-results
                tests/golden/.actual }
  native:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: g++ -std=c++20 -O2 -I src/wasm/retaining src/wasm/retaining/test_native.cpp -o /tmp/rwtest && /tmp/rwtest
```

Notes: `vite dev` is started by Playwright's `webServer` (`playwright.config.mjs:9`) — CI needs no
extra server step. Chart.js is served from `tests/golden/vendor` through `page.route`, so the
browser job has no outbound dependency except the Playwright download (cached). Linux Chromium
fonts differ from macOS → screenshots are recorded on CI (Linux) and only compared there; local
`golden:browser` skips PNG comparison unless `GOLDEN_VISUAL=1` (documented in README).

---

## 5. Refactor protocol

### 5.1 Before the first extraction (one-off)

1. `npm run golden:fixtures` → commit `tests/golden/fixtures/**`, `vendor/`, `wasm.sha256.json`.
2. `npm run golden:record` and `npm run golden:browser:record` on HEAD → commit `tests/golden/**`
   as **"test(golden): baseline characterization at 462fc50"**. From now on the goldens travel with
   the code; "baseline of the previous commit" is simply the checked-in golden at the parent commit.
3. Run `npm run golden:check` twice in a row and `golden:browser` twice; both must be green. Any
   flake at this point is a determinism leak (F1/F5) — fix the mask or the seeding before proceeding,
   never widen tolerances.

### 5.2 Per extraction step (repeat for every module carved out of `legacy-controller.js`)

```
1. git switch -c refactor/<n>-<module>     (from the branch tip; goldens are green there by construction)
2. npm run golden:check                    → must be green before touching code (proves the environment, not the code)
3. Extract:  move functions into src/lib/cpt-app/<module>.js, import them back into the controller,
             keep the window.* names in legacyApi (:18321) unchanged for this step.
4. npm run golden:check                    → Node tiers, ~1–3 min
5. npm run golden:browser                  → browser tier, ~5–10 min (run when the step touches rendering,
                                             Stage 6, project-io or report; skip for pure-compute moves after step 4 is green)
6. Review any diff:
     a. Diff only in masked/volatile fields  → mask is incomplete → fix normalize.mjs, not the golden.
     b. Numeric diff within 1e-9 (pure JS)   → not allowed. A pure move must be bit-identical; find the reordered
                                              floating-point operation or the changed default and undo it.
     c. Numeric diff across WASM/iterative   → allowed only inside the suite tolerance; if outside, it is a bug.
     d. Structural diff (key added/removed)  → behaviour change → must be split out of the extraction commit.
7. If (and only if) a behaviour change is *intended* (e.g. an extraction also fixes a bug found on the way):
     - commit the extraction with goldens untouched (green),
     - commit the fix separately with `npm run golden:update -- --filter <suite>` and a CHANGELOG.md entry:
       "2026-09-03 <sha> settlement: truncationDepth now honours CPT_bottom when Df > CPT depth (was NaN) — cases: stage6-settlement/short.*".
8. Extend the harness in the same PR when the extraction exposes a new pure function:
     add a Tier A case for it (this is how the harness migrates from Tier B — controller-under-Node —
     to Tier A — pure modules — as the monolith shrinks).
9. Commit with DCO sign-off (CONTRIBUTING.md), PR passes `ci.yml`.
```

Optional belt-and-braces for high-risk moves (Stage 6 render dispatch, `ensureStage6State`,
`applyProjectSnapshot` glue): run the browser journey against **both** `HEAD~1` and `HEAD` in
`record` mode into two temp dirs and `git diff --no-index` them — `scripts/golden/bisect-journey.sh`
(two `git worktree add`s, two ports via `PORT`/`--port` override in `golden.config.mjs`).

### 5.3 UI restyling — verified separately

The restyle must not change **state** or **text**; it will change **pixels** and may change
markup. Protocol:

1. Restyling happens on its own branch after the extraction wave that moves rendering out of the
   controller (or at least after `legacyApi` selectors are stable).
2. Selectors used by the harness live in one file (`scripts/golden/lib/selectors.mjs`, imported by
   both `browser-capture.js` and the spec). If a restyle renames an id/class, the change is made
   there and nowhere else, and the PR shows it.
3. `dom.txt` goldens compare **innerText** (not innerHTML) so class/style/markup changes are
   invisible; but text order and wording are locked. If the restyle intentionally rewords or
   reorders (e.g. moves the Stage 6 banner), that is a golden update with a CHANGELOG entry that
   lists the affected steps — reviewers read the text diff, not screenshots.
4. `state.json` goldens must remain byte-identical (rel 0 effectively). Any state diff during a
   restyle is a regression by definition.
5. Screenshots: after visual review of the new look (on CI's Linux renderer), run
   `golden:browser:update` **with `--update-snapshots` only** (PNG baseline), commit as
   "test(golden): visual baseline after restyle <theme>". From then on the tolerant PNG compare
   again guards against accidental layout regressions.
6. Retaining-wall views are HTML strings from `results/*.js`/`panels/*.js` (locked as text in
   Tier A `retaining` suite). A restyle that rewrites those templates updates those `.txt` goldens
   in a dedicated commit; the numeric goldens (`request`, `result`, `st`) in the same suite must
   not move.

---

## 6. Effort estimate and build order

| # | Part | Effort | Must exist before first extraction? |
|---|---|---|---|
| 1 | `lib/{store,compare,normalize,prng,gef-writer}.mjs`, `record.mjs`, `check.mjs`, `tolerances.json`, README | 1.0 d | yes |
| 2 | `make-fixtures.mjs` (GEF/CSV/XLSX writers, seeded profiles, manifest), `fetch-vendor.mjs`, `wasm-hash.mjs` | 0.5 d | yes |
| 3 | `load-controller.mjs` (Vite SSR + DOM stub, Chart stub, download capture) + Tier B suites `classification, layers, model, tuning, exports, report, stage6-*` | 1.5 d (stub brittleness is the main risk; budget +0.5 d for `happy-dom` fallback) | yes — this is what proves the Stage 2–6 extractions |
| 4 | Tier A suites: `retaining`, `project-io`, `stratigraphy`, `report-svg`, `chart-configs` | 1.0 d | `project-io` and `retaining` yes; others before the corresponding extraction |
| 5 | Tier A solver suites `bishop`, `seepage`, `deformation` (lift model builders to fixtures; wasm module bootstrap; keep each case < 10 s) | 1.0 d | before the Seep/Slope extraction only |
| 6 | Tier C `journey.mjs` + `browser-capture.js` + `gef-import-journey` + `demo-journey` (determinism init script, downloads, report tabs) | 1.5 d | yes — first extraction touches rendering paths (`renderStage6`, `goS`) |
| 7 | Tier C `seep-slope-journey`, `multi-cpt-journey`, `save-load-journey` | 1.0 d | before Seep/Slope / stratigraphy / project-io extractions |
| 8 | CI workflow, caches, artefacts, changelog guard; `test:all`; Linux screenshot baseline | 0.5 d | yes (otherwise the discipline erodes) |
| 9 | Protocol doc in `tests/golden/README.md`, PR template checklist, `bisect-journey.sh` | 0.5 d | yes |
| | **Total** | **≈ 8.5 dev-days** (≈ 5 days for the "must exist first" subset: 1, 2, 3, 4-partial, 6, 8, 9) | |

Build order: 1 → 2 → 3 → 6 → 8 → 9 (minimum viable gate, ≈5 d) → 4 → 7 → 5. The first extraction
candidates that this minimum gate fully covers are the ones with the least DOM coupling: the CPT
parsers (`parseGEF/parseCsvCpt/parseExcelCpt/applyParsedCpt`, `:1113-1490`), the layer-detection
block (`:2205-2780`), `hsParams/khParams` (`:2937-3146`), the tuning block (`:3276-3520`), the
exports (`:17209-17420`), and the Stage 7 payload builders (`:17420-18297`). Stage 6 rendering,
Bishop/seepage/deformation glue (`:4190-12250`, `:14380-16770`) and the multi-CPT/section code
(`:318-808`) come after parts 5 and 7 exist.
