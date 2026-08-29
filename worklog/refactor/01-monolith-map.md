# 01 — Monolith map: `src/lib/cpt-app/legacy-controller.js`

Master reference for the incremental refactor of the MADEP CPT Interpreter controller.
Branch `v0.6.0`, HEAD `462fc50`. All line numbers refer to `src/lib/cpt-app/legacy-controller.js`
(18,503 lines) unless another file is named. Nothing in this document is inferred from
documentation; every statement was read from the code (grep/sed) or computed by a throw-away
call-graph script over the top-level function table (540 functions).

Contents

0. How the monolith is wired (one page)
1. Global state
2. Function inventory by stage (+ every `window.*` handler)
3. Cross-stage dependencies and hidden couplings
4. Render pipeline
5. Engine boundaries (workers / WASM)
6. Proposed module boundaries and extraction order
7. Metrics
8. Top 10 risks
9. Suggested first three extractions

---

## 0. How the monolith is wired (one page)

| Piece | Where | What it does |
|---|---|---|
| Svelte host | `src/routes/+page.svelte:27-40` | `onMount` → dynamic `import('$lib/cpt-app/legacy-controller.js')` → `mod.initLegacyController()`. Chart.js 4.4.1 comes from a CDN `<script>` in `<svelte:head>` (`+page.svelte:65`) and is used as the global `Chart`. |
| Static DOM | `src/lib/components/cpt/CptInterpreterApp.svelte`, `BannerPhaseShell.svelte`, `StageNav.svelte`, `stages/Stage1Load.svelte` … `Stage6Applications.svelte` | All stage panels (`#p0`…`#p5`), controls and container ids are static Svelte markup. Svelte never owns state; it calls `call('name', …)` from `src/lib/cpt-app/ui.ts:6` which is `window[name](...)`. |
| Controller entry | `initLegacyController` 18490-18503 | `Object.assign(window, legacyApi)` (166 names, 18321-18488) + `Object.assign(window, retainingApp.handlers)` (12 names); `bindDropzone()`; `#bishop` hash check; `renderBanner()`; `hashchange` listener. |
| Module-load side effect | 1047-1052 | `document.querySelectorAll('.si').forEach(addEventListener('click', goS))` runs at import time, outside `initLegacyController`. |
| Extracted packages already in target style | `retaining/` (`installRetainingApp(ctx)` 137-155), `stratigraphy/` (`installStratigraphyApp(ctx)` 157-172), `project-io/` (`installProjectIO(ctx)` 174-201), `import-review/` (pure + modal) | Installed at module scope with a small context: `getState: () => S`, `requestRender: () => renderStage6()`, `workingLayers`, `getCpt`, `getProjectMeta`, `getProject`, `layerParamsFor`, `requestSectionRender`, `newCptState`, `getActiveStage`, `afterLoad`. |
| Stage navigation | `goS(n)` 1029-1046 | Toggles `.panel`/`.si` classes, then `n===2 renderLayers`, `3 renderModel`, `4 renderTuning`, `5 renderStage6`. Stage 1/2 bodies are rendered by their event handlers, not by `goS`. |
| Phase views | `setPhase(ph)` 380-398 | Shows/hides `#nav`, `.wrap`, `#phaseCorr`, `#phaseSection`; `'correlation'` → `stratigraphyApp.render()`, `'section'` → `renderSection()`. |
| Stage 6 | `renderStage6()` 16772-16831 | Full `innerHTML` re-render of `#stage6Area` for the selected app, then `requestAnimationFrame` chart/canvas builds. Called from 71 sites. |
| Persistence | `project-io/snapshot.js`, `report-storage.js`, `stratigraphy/soilin-report.js`, `retaining/report/note-view.js` | Project → `.madep.json` download (no autosave); reports → `localStorage` key → `window.open('/report/…?key=')`. No settings persistence, no localStorage for app state. |

---

## 1. Global state

### 1.1 Project and per-CPT state

Created at 235-245:

```
PROJECT = { name, cpts:[newCptState('CPT-1')], activeCptIdx:0,
            phase:'analysis'|'correlation'|'section', stratigraphy:null, sectionOrder:[0] }   // 235-243
let S = PROJECT.cpts[0];                                                                        // 245
```

`S` is a **module-level `let` that is reassigned** — it is the active CPT. Every function in the file
closes over it. Reassignment sites:

| Site | Line | Why |
|---|---|---|
| `selectCpt(idx)` | 260 | user picks a tab / after load |
| `removeCpt(idx)` | 375 | after splice |
| `importCptFiles` | 439, 456 | temporarily switches `S` to the target CPT while a file parses, then restores |
| `installStratigraphyApp.layerParamsFor` | 160-166 | swaps `S = cpt` around `hsParams/khParams` so Stage 4 derivation runs "in the member layer's own CPT context" |

Per-CPT shape — `newCptState(id)` 209-232 (fields are exactly these; others are added lazily):

| Field | Default | Owner (writes) | Readers (count of `S.<f>` uses) |
|---|---|---|---|
| `id` | `'CPT'` | `importCptFiles` 446, `setCptName` 329 | 9 |
| `x`, `y` | null | `applyParsedCpt` 1131-1136, `setCptCoord` 483-493 | 8 / 8 |
| `data[]` rows `{z,qc,fs?,rf?,u2?,…}` | `[]` | `applyParsedCpt` 1123 (parsers), `loadDemo` | 42 |
| `wt`, `wtFromFile`, `wtSource` | 1.7/false/null | `applyParsedCpt`, `setWT` 1519-1540 | 36 |
| `elev`, `elevFromFile`, `elevSource` | null | `applyParsedCpt`, `setElev` 1510-1518 | 32 |
| `minThk`, `smartMerge`, `smartMergeSensitivity` | 0.50/true/1.10 | `setMinThk` 1602, `setSmartMerge` 1614, `setSmartMergeSensitivity` 1623 | 4/7/5 |
| `assumedRf` | `DEFAULT_ASSUMED_RF` (3.0) | `setAssumedRf` 1550 | 3 (+17 via `assumedRfValue()` 1983) |
| `method` | `'robertson2016'` | `selM` 1916-1923 | 13 |
| `alphaMethod`, `stiffMethod`, `khKvMethod`, `paramMethod` | B/B/A/sb260 | `setAlphaMethod` 3023, `setStiffMethod` 3029, `setKhKvMethod` 3043, `setParamMethod` 3050 | 11/8/4/6 |
| `stage6` | `stage6Defaults()` | `ensureStage6State` 4249-4646, `setStage6Field` 4850, all `stage6Bishop*` setters, `retainingApp` (`stage6.retwall`) | 318 |
| `stage6Cache` (volatile) | `{}` | `renderStage6` 16787-16806 (`bearing/pile/settlement/dewatering/beam`), `stage6BishopCurrentModel` 6509 (`bishopModel`), contour caches 5767-5784 / 6215-6234, line probe | 55 |
| `classified[]` | `[]` | `runClass` 2112 | 14 |
| `layers[]` | `[]` | `detectLayers` 2501-2530, `editL`/`changeSubtype`/`editAlpha…editNu` (overrides), `acceptFit`/`rejectFit` (`m_ovr`), `projectIO.afterLoad` 189 | 63 |
| `charts` `{qc,fs,rf}` (volatile Chart.js) | `{}` | `initCharts` 1690-1692, `selectCpt` 256/302 | 14 |
| `chartsReady` (volatile) | false | `initCharts` 1693, `selectCpt` 301 | 4 |
| `meta` | `{}` | `applyParsedCpt` 1137-1142 (`testid, fname, nRows, depthMin/Max, hasU2/hasFs/hasRf, zid, aRatio, project, location, owner, date`) | 19 |
| `tuning` | null | `runTuning` 3397 (`[{i, fit, previewM}]`) | 8 |
| `useSB260params` | false | `runClass` 2110 | 2 |
| `_maxStage` (added lazily) | — | `goS` 1031-1032 | 5 |
| `rfAssumedCount` (added lazily) | — | `runClass` 2128 | 2 |

Layer object shape (built in `detectLayers` 2527-2529, summarised by `segmentSummary` 2199-2226):
`{id, top, bot, type, subtype, avgQc, avgFs, avgRf, rfIndeterminate, g, gs, phi, c, cu, ovr:{}}`
plus lazily added override fields `aE_ovr`, `m_ovr`, `nu_ovr`, `rShear_ovr` with matching `ovr.<key>` flags
(editors 2883-2936, `acceptFit` 3408-3409). `stage6WorkingLayers()` 4162-4185 returns a *copy* enriched with
`index, Eoed_ref, Eoed_i, E50_ref, Eur_ref, m, Emc, nu, K0nc, rShear, psi, kh, kv, nu_ur` from `hsParams/khParams`.

### 1.2 Stage 6 sub-state (`S.stage6`)

`stage6Defaults()` 3736-4134 returns `{ app, ui, retwall, bearing, settlement, dewatering, pile, beam, bishop }`
(top-level keys at 3738-3873). `retwall` is `retainingApp.defaults()` (`retaining/wall-state.js:13`).
`ensureStage6State()` 4249-4646 deep-merges defaults (`stage6Merge` 4135-4146), calls `retainingApp.ensure(S.stage6)` (4252),
clamps bearing/settlement/dewatering/beam fields (4255-4278), calls `ensurePileState(maxDepth)` (4280),
then runs ~365 lines of **bishop schema migration** (4281-4646: `schemaVersion` → 3, measurement, lineProbe,
surface loads shape, walls, drains, custom regions, seepage/deformation options, mesh target areas…).

`S.stage6.bishop` keys (defaults 3873-4134): `schemaVersion, history, workspace ('stability'|'seepage'|'deformation'),
tool, useFemPorePressure, strengthSet, methodMode, useCustomRegions, customRegions, selectedRegionId,
regionDraftMaterialId, measurement, lineProbe, analysisTab, display, terrain, phreatic, walls, selectedWallId,
drains, selectedDrainId, draft, draftKind, activeCptX, cptInsertionOffset, entryZone, exitZone, viewport, gridSnap,
pointSnap, snapSize, analysisDepth, materials, sourceLayerSignature, search, solver, spencer, progress,
seepage {status, bcs, options, display, mesh, result, stale, progress, drainValidation, rejectReason …},
deformation {status, options (≈60 solver keys, see 8098-8160), display, mesh, result, warnings, stale,
progress, lastWallInputs, rejectReason}, results, selectedResult, stale, capturedView`.
Additional keys added lazily by handlers: `surfaceLoads[]`, `surfaceLoad` (legacy mirror, 5069-5101 / 6695-6700),
`selectedSurfaceLoadId`, `sourceStrengthSet`, `selectedBcId`, `bishopSettingsWide` etc. on `stage6.ui`.

`S.stage6.ui` holds `details: {<data-st6details key>: bool}` (34 distinct keys, e.g. `bishop-search`, `pile-cone`,
`bearing-advanced`) written by `stage6RememberDetailsState` 4647-4657 and read by `stage6DetailsOpen` 4658-4671, plus
bishop UI flags (`bishopSettingsWide`, `bishopCanvasToolsHidden`, `bishopActiveCanvasPanel`, `bishopActiveCanvasSheet`,
4738-4849).

Volatile `S.stage6Cache` keys: `bearing, pile, settlement, dewatering, beam, bishopModel, bishopSeepageBoundary,
bishopSeepageContourDerived, bishopDeformationContourDerived, bishopLineProbe` (+ pile canvas state via
`ensurePileCanvasState(S.stage6Cache)` 16791).

### 1.3 Module-level variables (hidden state)

| Name | Line | Kind | Used by |
|---|---|---|---|
| `__legacyControllerInitialized`, `__legacyControllerHashBound` | 109-110 | init guards | `initLegacyController` |
| `xlsxModulePromise` | 111 | lazy `xlsx` import cache | `loadXlsxModule` 1113 |
| `stage6BishopWorker` / `stage6BishopRunId` | 112-113 | Worker + run token | 7664-7711, 7910-7969, 7638-7649 |
| `stage6BishopSeepageWorker` / `stage6BishopSeepageRunId` | 114-115 | Worker + run token | 7712-7787, 7970-8038, 7582-7609 |
| `stage6BishopDeformationWorker` / `stage6BishopDeformationRunId` | 116-117 | Worker + run token | 7788-7909, 8039-8164, 7610-7637 |
| `classificationRefreshTimer` | 118 | debounce (90 ms) for min-thickness / smart-merge sliders | 1573-1601 |
| `stage6BishopCanvasState` `{canvas, pointerDrag, hoverWorld}` | 119-123 | canvas interaction state (not per CPT) | 10202-11122, 12251-12266 |
| `STAGE6_ENABLE_HARDENING_SOIL_UI = false`, `STAGE4_ENABLE_HARDENING_SOIL_PARAMS = true` | 127, 133 | feature flags | bishop render, `renderModel` |
| `retainingApp`, `stratigraphyApp`, `projectIO` | 137, 157, 174 | installed packages | shell, banner, section |
| `PROJECT`, `S` | 235, 245 | the state | everything |
| `SC`, `SCFILL`, `DEF`, `AE`, `MC_NU_BY_TYPE/SUBTYPE`, `MC_RSHEAR_BY_TYPE/SUBTYPE` | 808-905 | soil tables | Stage 3/4, Stage 6 |
| `classCUR = classCUR3` | 2051 | alias exported on window | — |
| `SMART_SLIVER_REF` | 2309 | merge constant | 2311-2347 |
| `CAT_GROUPS`, `COMPAT` | 2564, 2591 | Tabel 3 compatibility tables | 2601-2782 |
| `STAGE6_SCROLL_PERSIST_SELECTORS` | 4663 | scroll-restore selectors | 4682-4723 |
| `STAGE6_REGION_COORD_DECIMALS`, `STAGE6_REGION_COARSENESS_DECIMALS` | 5393-5394 | rounding | regions |
| `ST6_SEEPAGE_HYDRAULIC_FS_CAP`, `ST6_SEEPAGE_HYDRAULIC_FS_PALETTE`, `ST6_DEFORMATION_SEQ_PALETTE`, `ST6_DEFORMATION_SIGNED_PALETTE` | 5571-6109 | contour palettes | canvas |
| `STAGE6_BISHOP_EDITABLE_HS_FIELDS` | 7103 | HS editable set | 7105-7124 |
| `STAGE6_WALL_RESPONSE_QUANTITIES` | 7375 | wall chart quantities | 7341-7447 |
| `stage6ShapeFactors = stage6BearingShapeFactors` | 12381 | alias on window | — |
| `stage6BearingChartTimer` | 13115 | 120 ms debounce for bearing chart | 13116-13123 |
| `__stage6PileLightRedrawHandle` | 13633 | rAF token for pile drag | 13634-13665 |
| `legacyApi` | 18321 | the window surface | `initLegacyController` |

Timers / rAF (13 sites): 311, 1155, 1850 (`rAF initCharts` after DOM swap); 1575/1596 (classification debounce);
1671 (`setTimeout(initCharts,120)` polling until global `Chart` exists); 3253 and 3669 (`setTimeout(buildTuningCharts,50)`
from **both** `renderModel` and `renderTuning`); 4721 (scroll restore); 13117-13118 (bearing chart debounce);
13636 (pile light redraw); 16813 (`renderStage6` post-render).

### 1.4 Persistence

| Store | Writer | Reader | Contents |
|---|---|---|---|
| `.madep.json` file | `projectIO.saveProject` (`project-io/index.js:33-57`) via `buildProjectSnapshot` (`snapshot.js:39`) | `loadProjectFromFile` → `applyProjectSnapshot` (`snapshot.js:95`) → `ctx.afterLoad` (180-201) | `project.{name, activeCptIdx, phase, activeStage, sectionOrder, stratigraphy, cpts[]}`; per CPT everything except `VOLATILE_CPT_KEYS = ['charts','chartsReady','stage6Cache']` (`snapshot.js:21`). So `stage6` (incl. bishop `results`, `seepage.mesh/result`, `deformation.result`, `retwall.result`), `tuning`, `_maxStage`, `meta`, `classified` **are** persisted. `activeStage` is derived from the DOM (`getActiveStage` 177-181). |
| `localStorage` `stage7-report:*` | `openStage7Report` 18299-18310 (`saveStage7Payload` + `cleanupStage7Payloads`) | `/report/stage7` (`src/routes/report/stage7/+page.svelte:20`) | Stage 7 payload v4 (`buildStage7Payload` 18166-18298) |
| `localStorage` soilin | `stratigraphy/index.js:91` | `/report/soilin` | SOILIN payload |
| `localStorage` retaining note | `retaining/report/note-view.js openNote` | `/report/retaining` | calculation note |
| URL hash `#bishop` | — | `stage6BishopHashActive` 4881-4884, `stage6BishopHandleHashChange` 18311-18320, `initLegacyController` 18494 | forces `S.stage6.app='bishop'` |

No settings are persisted to localStorage; `PROJECT.name` is written directly by Svelte (`BannerPhaseShell.svelte:18`
`legacy.PROJECT.name = target.value`).

### 1.5 Ownership summary (who may mutate what)

| State slice | Owning functions |
|---|---|
| `PROJECT.cpts/activeCptIdx/sectionOrder` | `selectCpt`, `addCpt`, `removeCpt`, `importCptFiles`, `projectIO` |
| `S.data/meta/wt/elev/x/y` | parsers via `applyParsedCpt`, `setWT`, `setElev`, `setCptCoord`, `loadDemo` |
| `S.method/minThk/smartMerge*/assumedRf` | Stage 2 controls |
| `S.classified` | `runClass` only |
| `S.layers` | `detectLayers` (rebuilds, drops overrides), Stage 3 editors, `changeSubtype`, `acceptFit/rejectFit`, `projectIO.afterLoad` restore |
| `S.alphaMethod/stiffMethod/khKvMethod/paramMethod` | Stage 4/3 toggles |
| `S.tuning` | `runTuning` |
| `S.stage6.<app>` | `setStage6Field` (generic path-set with default-typed coercion 4850-4868), `ensureStage6State` clamps, `ensurePileState`, pile canvas `setField` hook 13650-13657 |
| `S.stage6.bishop` | 140+ `stage6Bishop*` functions; workers' `onmessage` (7667-7710, 7715-7770, 7791-7893) write `results/seepage/deformation` asynchronously |
| `S.stage6.retwall` | `retainingApp` only (via `ctx.getState().stage6.retwall`) |
| `S.stage6.ui` | `stage6RememberDetailsState`, `stage6SetDetailsOpen`, bishop UI toggles 4738-4849 |
| `S.charts/chartsReady` | `initCharts`, `selectCpt` |
| `PROJECT.stratigraphy` | `stratigraphy/store.js:33-39` |

---
## 2. Function inventory by stage

Legend: **H** = published on `window` via `legacyApi` and called from an HTML string `on*=` attribute or from a
Svelte `call()`; sizes are line counts (declaration to next declaration). Kind: S = state/compute, R = render
(DOM/innerHTML/canvas/SVG), E = event handler, U = helper.

### 2.0 Project, banner, navigation (209-398, 1029-1052) — 215 lines

| Function | Lines | Size | Kind | Notes |
|---|---|---|---|---|
| `newCptState` | 209-246 | 38 | S | schema of a CPT |
| `selectCpt` **H** | 247-317 | 71 | S+R+E | stops workers, destroys charts, resets nav, syncs 15 control ids, rebuilds `#chartArea` innerHTML, rAF `initCharts` |
| `addCpt` **H** | 318-327 | 10 | E | clicks `#fi` |
| `setCptName` | 328-335 | 8 | S | |
| `renderBanner` | 336-367 | 32 | R | innerHTML `#cptTabs`, inline `onclick="selectCpt(i)"`, delegated remove/keydown listeners, writes `#projName` |
| `removeCpt` | 368-379 | 12 | S+E | `confirm()` |
| `setPhase` **H** | 380-398 | 19 | R+E | phase switch |
| `goS` **H** | 1029-1046 | 18 | R+E | stage switch; tracks `S._maxStage` |
| (module code) | 1047-1052 | 6 | E | `.si` click binding at import time |

### 2.1 Stage 1 — Load & preview (396-488, 1054-1874) — ≈914 lines

| Group | Functions (lines, size) |
|---|---|
| Load orchestration (S/E) | `stripCptFileExtension` 399-402, `isExcelCptFile` 403-410, `isCsvCptFile` 411-417, `importCptFiles` 418-471 (54; serial FileReader, swaps `S`), `importGEFFiles` 472-476, `loadGEF` **H** 477-482, `loadDemo` **H** 1823-1855 (33), `loadSingleGEF` 1856-1861, `bindDropzone` 1862-1877 (document-level drag listeners) |
| Parsers (S) | `pad2` 1060, `formatExcelHeaderValue` 1064-1077, `normalizeExcelLabel` 1078-1086, `excelHeaderLookup` 1087-1095, `excelHeaderText` 1096-1102, `excelHeaderNumber` 1103-1106, `findExcelSheetName` 1107-1112, `loadXlsxModule` 1113-1119 (dynamic `import('xlsx')`), `applyParsedCpt` 1120-1158 (39; **writes S + 5 DOM controls + rAF initCharts**), `parseExcelCpt` 1159-1247 (89), `splitDelimitedLine` 1248-1271, `parseDelimitedText` 1272-1279, `detectDelimitedTextSeparator` 1280-1298, `parseCsvCpt` 1299-1345 (47), `parseGEF` 1346-1473 (128). All three parsers end in `presentImportReview` (import-review modal) then `applyParsedCpt`. |
| Meta & controls (R/E) | `updateElevSrc` 1474-1478, `updateWTDisplay` 1479-1487, `renderMeta` 1488-1509 (innerHTML `#mgrid`, `#finfo`), `setElev` **H** 1510-1518, `setWT` **H** 1519-1540, `updateWTLine` 1541-1549 (Chart.js dataset update), `setAssumedRf` **H** 1550-1564 (re-runs `runClass`), `updateAssumedRfControls` 1565-1572, `cancelClassificationRefresh` 1573-1579, `refreshClassificationDerivedViews` 1580-1591 (**calls Stage 3 `detectLayers` + `renderLayers`**), `scheduleClassificationDerivedViews` 1592-1601, `setMinThk` **H** 1602-1613, `setSmartMerge` **H** 1614-1622, `setSmartMergeSensitivity` **H** 1623-1641, `setCptCoord` **H** 483-493 |
| Raw charts (R) | `arrMax` 1642, `arrSafe` 1643-1648, `buildRawChartSeries` 1649-1663, `initCharts` 1664-1701 (38; `new Chart` ×3 into `S.charts`, polls for global `Chart`), `setChartEmptyState` 1702-1719, `updateRawChartEmptyStates` 1720-1724, `refreshChartData` 1725-1744 |
| Layer SVGs (R) | `drawLayerColumnSvg` 1745-1762 (`#layerColSvg`, via `report-svg.js`), `renderLayerPreviewSvg` 1763-1780 (`#layerPreviewSvg`), `bindLayerPreviewTooltip` 1781-1822 |

### 2.2 Stage 2 — Classification (1875-2195) — 321 lines

| Group | Functions |
|---|---|
| Method UI (R/E) | `classificationMethodLabel` 1878-1887, `classificationMetricLabel` 1888-1894, `classificationMetricValue` 1895-1901, `syncClassificationMethodCards` 1902-1915 (toggles `#mRob/#mRob16/#mCur/#mNen/#mSB`), `selM` **H** 1916-1923 |
| Stress (S) | `stressAt(z, gs, g)` 1924-1982 (59; walks `S.data`/`S.layers`, `S.wt`, `assumedRfValue`) |
| Classify (S) | `assumedRfValue` 1983-1988, `cptHasFs` 1989-1991, `cptHasRf` 1992-1995, `classRob` 1996-2009, `classRob2016` 2010-2046, `classCUR3` 2047-2076 (+alias `classCUR` 2051), `classNEN6740` 2077-2096, `classSB260` 2097-2106 — thin wrappers that call `classification-core.js` (`classifyRobertson1990/2016/CUR3/NEN6740/Tabel3`) with `stressAt` + `S.meta.aRatio` |
| Run (S+R) | `runClass` **H** 2107-2198 (92): writes `S.classified`, `S.useSB260params`, `S.rfAssumedCount`; innerHTML `#cmet`, `#classAssumedRfNote`, `#cmetricHead`, `#cbody`; shows `#classLayout`, `#btnToLayers`; then **calls Stage 3 `detectLayers`** and the two SVG renders |

### 2.3 Stage 3 — Layer identification (489-538, 2196-2933) — ≈785 lines

| Group | Functions |
|---|---|
| Detection (S, pure except `S` reads) | `segmentSummary` 2199-2226, `segmentTop` 2227-2245, `subtypeGroup` 2246-2250, `familyClass` 2251-2258, `qcSimilarity` 2259-2263, `rfSimilarity` 2264-2268, `subtypeSimilarity` 2269-2276, `paramSimilarity` 2277-2286, `compatSimilarity` 2287-2292, `continuityScore` 2293-2297, `isCriticalMarkerLayer` 2298-2310, `mergeCandidateScore` 2311-2347, `simpleUpwardMerge` 2348-2370, `mergeSegmentInDirection` 2371-2383, `chooseSimilarityMergeDirection` 2384-2404, `smartSimilarityReduce` 2405-2440, `enforceMinThicknessBySimilarity` 2441-2460, `smartPostMerge` 2461-2472, `classificationSegmentKey` 2473-2477, `detectLayers` 2478-2600 (123; writes `S.layers`, **ends with `renderLayers()`** at 2531 region), `layerTypeCompatScore` 494-538 (shared with section view) |
| Tabel 3 compatibility (S) | `compatLevel` 2601-2614, `qcRfFit` 2615-2665, `suggestSubtype` 2666-2718, tables `CAT_GROUPS` 2564, `COMPAT` 2591 |
| Table render (R) | `buildSubtypeDropdown` 2719-2782 (64; inline `onchange="changeSubtype(this)"`), `renderLayers` 2783-2812 (innerHTML `#lb`, inline `onchange="editL(this)"`), `renderCompatWarnings` 2843-2882 (creates `#layerWarnings` after `#lt`) |
| Editors (E) | `changeSubtype` **H** 2813-2842, `editL` **H** 2883-2887, `editAlpha` **H** 2888-2894, `editM` **H** 2895-2901, `editRShear` **H** 2902-2911, `editNu` **H** 2912-2936 (the last four are rendered by Stage 4 `renderModel` and re-call it) |

### 2.4 Stage 4 — Model parameters (805-1028, 2937-3255) — ≈543 lines

| Group | Functions |
|---|---|
| Soil tables & α (S) | `DEF` 810, `AE` 820, `MC_NU_BY_TYPE` 847, `MC_NU_BY_SUBTYPE` 857, `MC_RSHEAR_BY_TYPE` 895, `MC_RSHEAR_BY_SUBTYPE` 905, `mohrCoulombNuDefault` 943-948, `mohrCoulombRShearDefault` 949-975, `sb260GranularAlpha` 976-981, `sb260TransitionAlpha` 982-987, `sb260AlphaFamily` 988-1012, `alphaEB` 1013-1028 |
| Derivation (S) | `khParams(l)` 2937-3022 (86; reads `S.khKvMethod`) → `{kh_min,kh_max,kh_rep,khkv,kv_rep,psi_unsat,infClass,*_fmt}`; `hsParams(l)` 3063-3147 (85; reads `S.alphaMethod`, `S.stiffMethod`, `S.elev`, `stressAt`, `assumedRfValue`, `l.ovr.*`) → `{Eoed_i,E50_i,Eoed_ref,E50_ref,Eur_ref,m,K0nc,nu,nu_ur,beta,Edef,aE,sigV,u,sigVeff,psi,Emc,rShear,topTAW,botTAW}` |
| Toggles (E) | `setAlphaMethod` **H** 3023-3028, `setStiffMethod` **H** 3029-3042, `setKhKvMethod` **H** 3043-3049, `setParamMethod` **H** 3050-3062 (Stage 3 control: re-runs `detectLayers`+`renderLayers`) |
| Render (R) | `renderModel` 3148-3275 (128; innerHTML `#ma` with inline `onchange="editAlpha/editM/editRShear/editNu(this)"`; ends with `setTimeout(buildTuningCharts,50)`) |

### 2.5 Stage 5 — Tuning (3276-3735) — 480 lines

| Function | Lines | Size | Kind |
|---|---|---|---|
| `fitLayer` | 3276-3395 | 120 | S (OLS on `S.classified`, uses `hsParams`, `alphaEB`, `stressAt`) |
| `runTuning` **H** | 3396-3403 | 8 | S+R |
| `acceptFit` **H** / `rejectFit` **H** | 3404-3416 / 3417-3423 | 13/7 | S (writes `layers[i].m_ovr`, `ovr.m`) + re-render Stage 4 if visible |
| `getTuningPreviewM`, `tuningSliderBounds`, `tuningPreviewEoedRef`, `tuningPreviewLineData` | 3424-3457 | | U |
| `readCssToken` | 3458-3462 | 5 | U (**shared by section, charts, bishop canvas**) |
| `updateTuningPreviewM` **H** | 3463-3523 | 61 | R+E (live slider, updates chart datasets) |
| `renderTuning` | 3524-3671 | 148 | R (innerHTML `#tuningArea`; canvases `id="${chartId}"`/`${chartId}d` with `data-chart-pending` + JSON in `data-*`) |
| `buildTuningCharts` | 3672-3735 | 64 | R (`new Chart` ×2 per layer from `data-*`; `canvas._built` guard) |

### 2.6 Stage 6 — shell, state, shared UI (3736-4884, 13148-13195, 16772-16837) — ≈1,245 lines

| Group | Functions |
|---|---|
| State schema | `stage6Defaults` 3736-4134 (399), `stage6Merge` 4135-4146, `stage6Get` 4147-4150, `stage6Set` 4151-4161, `stage6WorkingLayers` 4162-4185, `stage6MaxDepth` 4186-4189, `stage6BishopSeepageDomainArea` 4190-4211, `stage6BishopAutoSeepageMeshTargetArea` 4212-4217, `stage6BishopResolvedSeepageMeshTargetArea` 4218-4225, `stage6BishopAutoDeformationMeshTargetArea` 4226-4240, `stage6BishopResolvedDeformationMeshTargetArea` 4241-4248 |
| Ensure/migrate | `ensureStage6State` 4249-4646 (398; called from **78** functions) |
| UI state | `stage6RememberDetailsState` 4647-4657 (26 callers), `stage6DetailsOpen` 4658-4671, `stage6ScrollTargetBaseKey` 4672-4681, `stage6ScrollTargets` 4682-4702, `stage6CaptureScrollState` 4703-4708, `stage6RestoreScrollState` 4709-4723, `stage6SetDetailsOpen` 4724-4730, `stage6BishopUiState` 4731-4737, `stage6BishopToggleSettingsPanel` **H** 4738-4746, `stage6BishopToggleSettingsWidth` **H** 4747-4754, `stage6BishopToggleToolRail` **H** 4755-4762, `stage6BishopToggleCanvasTools` **H** 4763-4769, `stage6BishopSetCanvasPanel` **H** 4770-4779, `stage6BishopSheetDetails` 4780-4802, `stage6BishopSetCanvasSheet` **H** 4803-4816, `stage6BishopOpenSettingsDetail` **H** 4817-4849 |
| Dispatch | `setStage6Field` **H** 4850-4868 (84 inline uses; generic `path` set with type coercion from defaults; `bearing.Df` short-circuits to `refreshStage6BearingPreview`), `setStage6App` **H** 4869-4876, `stage6BishopEnabled` 4877-4880 (always true), `stage6BishopHashActive` 4881-4884 |
| Shell render | `stage6SharedBanner` 13148-13155, `stage6AppIcon` 13156-13170, `stage6CardsHtml` 13171-13195 (inline `onclick="setStage6App('…')"`), `renderStage6` 16772-16831 (60; **71 callers**), `stage6DestroyChart` 16832-16837 |

### 2.7 Stage 6 — Bearing (12267-13147, 13666-13772, 16838-16852) — ≈1,000 lines

| Group | Functions |
|---|---|
| Compute (S) | `layerAtDepth` 12267-12272, `stage6BearingGeometry` 12273-12309, `stage6BearingShapeFactors` 12334-12351 (alias `stage6ShapeFactors` 12381), `stage6BearingDepthFactors` 12352-12382, `stage6BearingNgamma` 12383-12388, `stage6UsesEc7Factors` 12389-12392, `stage6BearingEc7Keys` 12406-12411, `stage6BearingEc7Spec` 12412-12432, `bearingAtDepth` 12799-12980 (182; uses `designSoilLayer`, `effectiveVerticalStressAtDepth` from `stage6-engineering`), `bearingProfile` 12981-13001 |
| Shared Stage 6 helpers defined here but used everywhere (U) | `stage6NoteHtml` 12433-12441, `stage6EscAttr` 12442-12449, `stage6EscJsString` 12450-12453, `stage6Tooltip` 12454-12458, `stage6CompactNumber` 12704-12717, `stage6AuditTableHtml` 12686-12694, `stage6LoadSummaryHtml` 12695-12703, options/help text builders `stage6UseCategoryOptions/Help`, `stage6SlsCombinationOptions/Help`, `stage6DewateringCombinationOptions/Help`, `stage6BeamUlsOptions/Help`, `stage6BeamLoadPatternHelp`, `stage6BeamModelModeOptions/Label`, `stage6BeamAxisCopy`, `stage6BeamMomentContextHelp`, `stage6BeamOrientationHtml`, `stage6BearingEc7Options/Help`, `stage6BearingShapeModeOptions/Help`, `stage6ExposureOptions/Help`, `stage6BeamDurabilityHtml`, `stage6BearingNotes`, `stage6ShapeModeLabel`, `stage6BearingNgammaLabel`, `stage6BearingShapeModeDetailHtml/Text`, `stage6CapacityLabel`, `stage6FactorLabel`, `stage6FactorValue` (12310-12798) |
| Render (R) | `stage6BearingSelectedDepthHtml` 13002-13028, `stage6BearingMaterialParamsHtml` 13029-13063, `stage6BearingDrainedFormulaHtml` 13064-13091, `stage6BearingUndrainedFormulaHtml` 13092-13115, `queueStage6BearingChartBuild` 13116-13123, `refreshStage6BearingPreview` 13124-13147 (partial DOM update of `#stage6DfValue/#stage6SelectedDepth/#stage6UlsParams/#stage6DrainedFormula/#stage6UndrainedFormula`), `renderStage6BearingApp(profile)` 13666-13772 (107, 13 inline handlers, canvas `#stage6BearingChart`), `buildStage6BearingChart` 16838-16852 |

### 2.8 Stage 6 — Piles (13196-13665) — 470 lines

| Function | Lines | Kind |
|---|---|---|
| `ensurePileState(maxDepth)` | 13196-13266 | S (enum clamps) |
| `renderStage6PileApp(analysis)` | 13267-13297 | R |
| `renderPileInputsColumn(cfg)` | 13298-13434 | R (inline `setStage6Field`) |
| `renderPileVisualsColumn` | 13435-13463 | R (`#stage6PileSection` host + 4 chart canvases) |
| `renderPileSummaryColumn`, `renderPilePerLayerTable`, `renderPileFactorChainTable` | 13464-13561 | R |
| `buildStage6PileCharts` | 13562-13603 | R (`new Chart` ×4 on `canvas._chartRef`) |
| `drawStage6PileSectionLive` | 13604-13633 | R (delegates to `stage6-pile-canvas.js drawStage6PileSection` with hooks) |
| `requestStage6PileLightRedraw` | 13634-13665 | R (rAF; re-runs `analyzePile` per frame during drag; `commitChange: renderStage6`) |

### 2.9 Stage 6 — Settlement / Dewatering / Beam (13773-14379, 16853-17182)

| App | Render | Charts / canvas |
|---|---|---|
| Settlement | `renderStage6SettlementApp(analysis)` 13773-13950 (178, 16 inline handlers, 3 canvases) | `buildStage6SettlementCharts` 16853-16874 |
| Dewatering | `renderStage6DewateringApp(analysis)` 13951-14128 (178, 16 handlers, 4 canvases) | `buildStage6DewateringCharts` 16875-16903 |
| Beam/slab | `renderStage6BeamApp(analysis)` 14129-14379 (251, 35 handlers, 2 chart canvases + `#stage6BeamGeometryCanvas`) | `buildStage6BeamCharts` 16904-16926, `stage6BeamCanvasText` 16927-16938, `stage6BeamRoundedRect` 16939-16953, `stage6BeamDrawDimension` 16954-16983, `stage6BeamDrawLoadArrow` 16984-17001, `drawStage6BeamGeometryPreview` 17002-17182 (181, 2D canvas) |

Compute for these three lives in `stage6-engineering.js` (`analyzeSettlement` :529, `analyzeDewatering` :950,
`analyzeBeamAndReinforcement` :1508) and is invoked only from `renderStage6` 16793-16806.

### 2.10 Stage 6 — Retaining walls

Fully extracted: `retaining/retaining-ui.js` (`installRetainingApp`), state `retaining/wall-state.js`, engine bridge
`retaining/wasm-loader.js`, panels/results/scenes/report subpackages. Monolith touch points: install 137-155,
`retainingApp.ensure` 4252, `retainingApp.cardMeta` 13179, `retainingApp.renderBody()` 16801,
`retainingApp.postRender()` 16825, `Object.assign(window, retainingApp.handlers)` 18493.

### 2.11 Stage 6 — Seep / Slope ("bishop") (4885-12266, 14380-16771, 17183-17208) — ≈9,800 lines, 260 functions

| Group (lines) | Functions |
|---|---|
| Surface-load state (4885-5147) | `stage6BishopSortedPolyline`, `SortZone`, `ValidZone`, `AllocateSurfaceLoadId`, `NormalizeSurfaceLoad`, `SyncLegacySurfaceLoadMirror`, `LegacySurfaceLoadSeed`, `MigrateSurfaceLoadsShape`, `SelectedSurfaceLoad`, `PrimarySurfaceLoad`, `EffectiveSurfaceLoadQ`, `SurfaceLoadSummary`, `ActiveSurfaceLoads`, `SetSurfaceLoadField` **H**, `SelectSurfaceLoad` **H**, `DeleteSurfaceLoad` **H**, `CreateSurfaceLoadFromZone` |
| Zones/walls/drains/regions state (5148-5452) | `ZoneKey`, `ZoneLabel`, `ZoneColor`, `PassiveSideLabel`, `DefaultPassiveSide`, `WallId`, `DefaultWallMaterial`, `WallMaterialPreset`, `WallMaterialPresetKey`, `NormalizeWalls` (76), `DrainId`, `NormalizeDrains`, `DefaultDrainHead`, `CreateDrainFromVertices`, `DrainValidationSummary`, `DrainGatingLabel`, `RegionId`, `RoundRegionCoord`, `NormalizeRegionCoarseness`, `ClampRegionPoint`, `NormalizeCustomRegions`, `SelectedCustomRegion`, `ResultWallLabel` |
| Seepage state + contours (5453-5784) | `InvalidateSeepage`, `CurrentSeepageBoundary`, `SelectedBoundaryEdge`, `HoveredSeepageEdge`, `SeepageBcForEdge`, `SeepageEdgeLabel`, `SeepageBcTypeLabel`, `RememberSeepageBcPreset`, `AutoApplySeepagePreset`, `SeepageHeadColor`, `SeepageContourMeta/Options/CriticalGradient/HydraulicFs/ElementContourValue/ContourValue/ContourModeIsSigned/ContourStats/ContourNodalValues/ContourRgb/ContourColor/ContourLineColor/ContourLegendGradient/ContourLegendTicks/ContourLegendValue/ContourLevels/ContourDerived` |
| Deformation contours (5785-6234) | `NormalizedDeformationAnalysisType`, `DeformationQuantityIds`, `DeformationContourMeta/Options`, `DeformationVectorMode`, `T6VisualSubtriangles`, `DeformationPlasticPointSets` (61), `DeformationFiniteScalar(/OrNull)`, `DeformationElementEtaMc`, `AverageFiniteValues`, `DeformationCellTriangleIndices/CellNodeIds`, `DeformationElementContourValue/ContourValue/ContourModeIsSigned/ContourStats/ContourNodalValues/VisualContourMesh`, `InterpolatePalette`, `DeformationContourRgb/Color/LineColor/LegendGradient/LegendTicks/LegendValue/FlatTolerance/Levels/Derived` |
| Seepage BC handlers + invalidation (6235-6374) | `SyncSeepageState`, `SelectSeepageBoundary` **H**, `SetSeepageBcType` **H**, `SetSeepageBcHead` **H**, `DeleteSeepageBc` **H**, `InvalidateDeformation`, `Invalidate` (22 callers), `InvalidateWallGeometry` |
| Soil model bridge (6375-6513) | `stage6BishopSyncSoilModel` 6375-6505 (131; `bishopLayerSignature`/`importBishopMaterialsFromLayers`, mirrors HS params from working layers onto materials, prunes selections), `stage6BishopCurrentModel` 6506-6513 (`buildBishopModelFromStageLayers` → `S.stage6Cache.bishopModel`) |
| Region handlers (6514-6678) | `SetSelectedRegion`, `CopyCurrentRegionsToCustom` **H**, `ExportRegionsDxf` **H** (dxf-regions), `SetUseCustomRegions` **H**, `ClearCustomRegions`, `DeleteSelectedRegion` **H**, `SetSelectedRegionMaterial` **H**, `SetSelectedRegionCoarseness` (**called from HTML at 9145, 16198, 16612-16613 but NOT in `legacyApi` — see risk #9**), `CommitPendingSelectedRegionCoarseness`, `SplitSelectedRegion` |
| Field / tool / draft handlers (6679-7085) | `stage6BishopSetField` **H** 6679-6827 (149; **139 inline uses**; path-based setter with invalidation rules), `SetWorkspace` **H**, `SetTool` **H**, `TriggerDxfImport` **H**, `ApplyImportedTerrain` (dxf-terrain), `ImportDxf` **H**, `PopDraftPoint` **H**, `FinishDraft` **H** (85), `ClearMeasurement`, `Clear` **H** (67; 22 inline uses with mode arg) |
| Material / wall / drain handlers (7086-7581) | `SetMaterialField` **H**, `SetMaterialHsField` **H**, `ResolveHsConsistentTangentMigration` **H**, `SetMaterialPermeability` **H**, `ResetMaterialPermeability` **H**, `SetWallField` **H**, `SetWallMaterialField` **H**, `DeleteWall` **H**, `SelectWall` **H**, `ToggleWallMomentOverlay` **H**, `OpenAnalysisTab` **H**, `SetAnalysisTab` **H**, `ResolveWallMechanicalActivation` **H**, `WallResultSeries`, `WallResponseMeta`, `WallOverlayQuantity`, `WallQuantitySeries/Stats/Format`, `CssColorWithAlpha`, `ContrastingTextColor`, `WallNodeValuesForOverlay`, `WallResultIsStale`, `WallResultForId`, `SelectedWallResult`, `AnalysisWallId`, `CopyWallData` **H** (clipboard), `SelectDrain` **H**, `SetDrainField` **H**, `DeleteDrain` **H** |
| Workers & runs (7582-8178) | `StopSeepage` 7582-7609, `StopDeformation` 7610-7637, `StopSearch` 7638-7649, `UpdateProgressDom` 7650-7663, `EnsureWorker` 7664-7711, `EnsureSeepageWorker` 7712-7787, `EnsureDeformationWorker` 7788-7909, `RunSearch` **H** 7910-7969, `RunSeepage` **H** 7970-8038, `RunDeformation` **H** 8039-8164, `SelectResult` **H**, `SelectedResult` |
| Result HTML / labels (8179-8845) | `StrengthSetLabel`, `MethodModeLabel`, `stage6SecondsLabelFromMs`, `stage6SafetyFinalizationStatusFromSolver`, `stage6DepthBandReportHtml`, `SafetyCurveHtml` (167), `SafetyMechanismHtml`, `stage6SeepageFlowErrorLabel`, `SeepageTerminationLabel`, `ResultMethodLabel`, `Running/Ready/Complete/SeepageCompleteMessage`, `ModeMeta` (86), `ToolIcon`, `CanvasToolButton`, `WallMechanicalLabel`, `PartialLoadBadgeHtml`, `WallInfoPanelHtml`, `RenderWallChart` 8721-8831 (Chart.js), `buildStage6BishopWallCharts` 8832-8845 |
| Tool rail (8846-9353) | `stage6BishopCanvasToolRailHtml(context)` (508; builds draw/boundary/regions/view/solve/reset panels + sheets) |
| Geometry, picking, line probe (9354-10201) | `Dist`, `PointInPolygon`, `RegionAtPoint`, `TooltipHtml`, `RegionShortLabel`, `PolygonCentroid`, `RegionLegendItems`, `MeasurementMetrics/Label/Vectors`, `LineProbeOptions/Meta/FormatValue/ClipboardValueHeader/ClipboardText/Stats`, `stage6ClipboardNumber`, `stage6CopyTextFallback`, `stage6CopyTextToClipboard`, `IntegrateLineProbe`, `BuildLineProbe` (149; samples seepage/deformation fields via `sampleSeepage*`/`sampleDeformationState`), `CopyLineProbeData` **H**, `DisplayRegions`, `ShowingCustomRegionPreview`, `PolygonIsValid`, `SegmentOrientation`, `SegmentsIntersectClosed`, `ValidateHolePolygon`, `PointOnSegment`, `PointInsideOrBoundary`, `ClosestPointOnSegment`, `BoundaryPickToleranceWorld`, `PickRegionBoundaryPoint`, `TraverseBoundary`, `BuildSplitBoundary`, `UniqueSortedNumbers`, `BoundaryYAtX`, `PolygonIntervalsDetailed`, `SubtractDetailedIntervals`, `SubtractHoleFromPolygon`, `SplitRegionPolygon` |
| Canvas interaction (10202-11122) | `HideHoverDom`, `UpdateHoverDom` (writes `#stage6BishopTip/#stage6BishopCoord`), `ScreenToWorld`, `WorldToScreen`, `SnapToleranceWorld`, `CurrentDragKey`, `SnapPointKey`, `CollectSnapPoints`, `NearestPointSnap`, `SnapWorldPoint`, `CanvasWorldBounds`, `fitStage6BishopViewport` **H**, `AutoFitViewportIfNeeded`, `NearestHandle`, `PickSurfaceLoadAtWorld`, `PickWallAtWorld`, `CommitDrawPoint` (185), `CompleteCurrentActionAt`, `PointerDown` (91), `PointerMove` (98), `PointerUp` (73), `PointerLeave`, `Wheel`, `DrawGrid` |
| Canvas draw (11123-12266) | `stage6BishopDrawCanvas` 11123-12250 (**1,128 lines**, one function: DPR sizing, regions, seepage contours/vectors, deformation contours/plastic points/wall response, loads, walls, drains, drafts, measurement, slip circles, legend), `initStage6BishopCanvas` 12251-12266 (assigns `canvas.onpointer*`/`onwheel` each render) |
| App render (14380-16771) | `renderStage6BishopApp()` (**2,392 lines**, one function, 251 inline handlers: ~130 local `const` derivations 14381-14750, then a template with `<details data-st6details="…">` sections `bishop-geo-analysis`, `bishop-geo-seepage-boundary`, `bishop-geo-deformation`, `bishop-search`, `bishop-spencer`, `bishop-materials`, `bishop-seepage-perm/bcs/drains/options/integration`, `bishop-deformation-materials/solve/diagnostics/solver-settings`, canvas card + tool rail + analysis tabs 15597-15705, view menus, legend, `bishop-geo-terrain/regions/setup/clear`, `bishop-walls`, progress bar `#stage6BishopProgress/#stage6BishopProgressBar/#stage6BishopMode`, canvas `#stage6BishopCanvas`, `#stage6BishopDxfInput`) |
| Chart | `buildStage6BishopLineProbeChart` 17183-17208 |

### 2.12 Section view "Doorsnede" (536-804) — 269 lines

`sectionProjection` 539-547 (delegates to `stratigraphyApp.projection()`), `renderSection` 548-752 (205; SVG innerHTML into
`#sectionSvg`, reads `#vexag`), `bindSectionTooltip` 753-794, `exportSectionSVG` **H** 795-942 (148; download).

### 2.13 Exports (17209-17419) — 211 lines

`exportCSV` **H** 17209-17231, `safeMaterialToken`, `plaxisDrainageType`, `plaxisDisplayName`, `plaxisCommandValue`,
`buildPlaxisSoilmatCommand`, `msToMday` 17232-17270, `exportPlaxisCommands` **H** 17271-17347, `findLayerForDepth`,
`simulatedLayerFs`, `layerFsIsSynthetic`, `formatPlaxisCoord` 17348-17377, `exportPlaxisCpt` **H** 17378-17419.

### 2.14 Stage 7 — Report (17420-18320) — 901 lines

`safeClone` 17420-17423, label helpers 17424-17447, `stage7LayerWarnings` 17448-17477, `stage7TuningPayload` 17478-17516,
`stage7WorkingLayerPayload` 17517-17570, `stage7BishopPayload` 17571-17653, `stage7SeepagePayload` 17654-17853 (200),
`stage7DeformationPayload` 17854-17915, `stage7CaptureCanvasImage` 17916-17951 (offscreen canvas → dataURL),
`stage7CaptureWorkspaceView` **H** 17952-17988, `stage7ClearWorkspaceCapture` **H** 17989-17998,
`stage7CaptureBishopWorkspaceView` 17999-18084 (**temporarily switches `S.stage6.app`/`bishop.workspace`, re-renders, draws, restores**),
`stage7Stage6Payload` 18085-18165, `buildStage7Payload` 18166-18298, `openStage7Report` **H** 18299-18310,
`stage6BishopHandleHashChange` 18311-18320.

### 2.15 Every `window.*` handler

**Published surface:** `legacyApi` 18321-18488 = 166 names (incl. `PROJECT`, `newCptState`, `classCUR`, `stage6ShapeFactors`,
`saveProject`, `loadProjectFromFile`) + `retainingApp.handlers` = 12 names (`retwallFit, retwallSetType, retwallSet,
retwallSetBool, retwallOverride, retwallOverrideDrained, retwallSetAllC, retwallClearOverrides, retwallCopy,
retwallRunDrivability, retwallCalPoint, retwallOpenNote`, `retaining-ui.js:265-350`). Total **178 window globals**.

**Called from HTML strings in the monolith (398 `on*="…"` attributes; 57 distinct runtime functions, by count):**
`stage6BishopSetField` ×139, `setStage6Field` ×84, `stage6BishopClear` ×22, `stage6BishopSetTool` ×21,
`stage6BishopSetMaterialField` ×20, `stage6BishopSetWallMaterialField` ×8, `stage6BishopSetWallField` ×8,
`stage6BishopSetSurfaceLoadField` ×8, `stage6BishopSetMaterialHsField` ×7, `stage6BishopSetDrainField` ×5,
`stage6BishopFinishDraft` ×5, `stage6BishopSetSelectedRegionCoarseness` ×4 (**unpublished**), `stage6BishopSetWorkspace` ×3,
`stage6BishopSetSelectedRegionMaterial` ×3, ×2 each: `stage6BishopSetUseCustomRegions, SetSeepageBcType, SetSeepageBcHead,
SetMaterialPermeability, SetAnalysisTab, SelectWall, ResolveWallMechanicalActivation, ResolveHsConsistentTangentMigration,
OpenAnalysisTab, DeleteSelectedRegion, CopyWallData, CopyCurrentRegionsToCustom, fitStage6BishopViewport`; ×1 each:
`updateTuningPreviewM, stage7CaptureWorkspaceView, stage6BishopTriggerDxfImport, ToggleWallMomentOverlay,
ToggleSettingsWidth, ToggleSettingsPanel, ToggleCanvasTools, SetCanvasSheet, SetCanvasPanel, SelectSurfaceLoad,
SelectSeepageBoundary, SelectResult, SelectDrain, ResetMaterialPermeability, PopDraftPoint, OpenSettingsDetail, ImportDxf,
DeleteWall, DeleteSeepageBc, DeleteDrain, CopyLineProbeData, setStage6App, selectCpt, rejectFit, acceptFit, editRShear,
editNu, editM, editL, editAlpha, changeSubtype`. Attribute bodies use `this.value` (232×), `this.checked` (62×), `event` (3×).
`stage6EscAttr`/`stage6EscJsString` appear inside attribute *values* but are evaluated at template time.

**Called from Svelte via `call()` (28 names + direct `PROJECT`):** `goS, loadGEF, loadDemo, setElev, setWT, setCptCoord,
selM, setSmartMerge, setSmartMergeSensitivity, setMinThk, setAssumedRf, runClass, exportPlaxisCpt, setParamMethod,
exportPlaxisCommands, exportCSV, setAlphaMethod, setStiffMethod, setKhKvMethod, openStage7Report, runTuning, renderStage6,
addCpt, saveProject, loadProjectFromFile, setPhase, renderSection, exportSectionSVG` (files: `BannerPhaseShell.svelte`,
`stages/Stage1Load.svelte` … `Stage6Applications.svelte`).

**Called from retaining panel HTML:** the 12 `retwall*` handlers (`retaining/panels/*.js`, `results/*.js`).

The remaining ~80 `legacyApi` names (e.g. `parseGEF`, `stressAt`, `detectLayers`, `hsParams`, `bearingAtDepth`, `renderLayers`,
`buildStage7Payload`, all `stage6Bishop*Run/Stop*`) are exported for console/debug and the stage7 capture path; nothing in
`src/` reads them through `window` except `ui.ts`/Svelte and the inline strings above.

---

## 3. Cross-stage dependencies and hidden couplings

### 3.1 The compute chain

```
file → parseGEF/parseExcelCpt/parseCsvCpt (1159-1473) → presentImportReview → applyParsedCpt (1120)
     → S.data, S.meta, S.wt, S.elev, S.x/y → initCharts (1664)
runClass (2107)  → classRob/…/classSB260 (1996-2106) → stressAt (1924) → S.classified
                 → detectLayers (2478) → segmentSummary/smart merges → suggestSubtype/qcRfFit/compatLevel → S.layers
                 → renderLayers (2783) [called from inside detectLayers]
                 → renderLayerPreviewSvg / drawLayerColumnSvg
Stage 4          → renderModel (3148) → hsParams (3063) → stressAt, alphaEB, mohrCoulomb* ; khParams (2937)
Stage 5          → runTuning → fitLayer (3276) → hsParams/alphaEB/stressAt ; acceptFit → layers[i].m_ovr → renderModel
Stage 6          → renderStage6 (16772) → ensureStage6State → stage6WorkingLayers (4162) → hsParams+khParams per layer
                 → bearingProfile | analyzePile | analyzeSettlement | analyzeDewatering | analyzeBeamAndReinforcement
                 | renderStage6BishopApp → stage6BishopCurrentModel → stage6BishopSyncSoilModel (bishopLayerSignature,
                   importBishopMaterialsFromLayers) → buildBishopModelFromStageLayers → workers
                 | retainingApp.renderBody → buildRequest(rw, ctx.workingLayers()) → WASM
Stage 7          → buildStage7Payload (18166) → stage6WorkingLayers, hsParams/khParams, stage6Cache.*, stage7*Payload
Exports          → exportCSV / exportPlaxisCommands → hsParams/khParams ; exportPlaxisCpt → S.data + layers
Stratigraphy     → ctx.layerParamsFor(cpt, layer) → swaps S → hsParams/khParams
Section          → sectionProjection → stratigraphyApp.projection() → PROJECT.cpts[].elev/layers
```

### 3.2 Most-called functions (call-graph hubs, callers among top-level functions)

| Function | Callers | Meaning for the refactor |
|---|---|---|
| `ensureStage6State` 4249 | 78 | every Stage 6 entry point re-runs the full migration; must become idempotent per-app `ensure()` |
| `renderStage6` 16772 | 71 | the only re-render path for Stage 6; workers call it on every progress/result |
| `stage6RememberDetailsState` 4647 | 26 | DOM→state sync before every re-render |
| `stage6BishopInvalidate` 6346 | 22 | result invalidation policy |
| `assumedRfValue` 1983 | 17 | used by parsers, classification, Stage 4, Stage 5, export, report |
| `stage6BishopInvalidateSeepage` 5453 | 16 | |
| `stage6BishopSyncSoilModel` 6375 | 15 | layers → materials bridge |
| `stage6CompactNumber` 12704 / `stage6EscAttr` 12442 | 14 / 10 | shared formatters living in the bearing region |
| `stage6WorkingLayers` 4162 | 11 | the Stage 4 → Stage 6 contract |
| `renderModel` 3148 | 9 | |
| `readCssToken` 3458 | 7 | defined in Stage 5, used by section, Stage 1 charts, bishop canvas/charts |
| `hsParams` / `khParams` | 6 / 5 | `renderModel, fitLayer, stage6WorkingLayers, exportCSV, exportPlaxisCommands, stage7WorkingLayerPayload` |
| `stressAt` 1924 | 5 | `classRob, classRob2016, classNEN6740, hsParams, fitLayer` |
| `compatLevel` 2601 | 7 | Stage 3 + `stage7LayerWarnings` |

### 3.3 Cross-region edges that cross stage boundaries (computed by the call-graph script; counts are function-to-function edges)

| From → To | Edges | Examples |
|---|---|---|
| Stage 1 controls → Stage 3 | 3 | `refreshClassificationDerivedViews → detectLayers/renderLayers`, `setElev → renderLayers` |
| Stage 1 controls → Stage 2 run | 1 | `setAssumedRf → runClass` |
| Stage 2 run → Stage 3 | 1 | `runClass → detectLayers` |
| Stage 3 detect → Stage 3 table | 6 | `detectLayers → renderLayers` (render inside compute) |
| Stage 3 editors → Stage 4 | 4 | `editAlpha/editM/editRShear/editNu → renderModel` |
| Stage 4 → Stage 3 | 6 | `setParamMethod → detectLayers/renderLayers`; `renderModel` renders the Stage 3 editors |
| Stage 5 → Stage 4 | 2 | `fitLayer → hsParams`, `acceptFit → renderModel` |
| Stage 6 state → Stage 4 | 2 | `stage6WorkingLayers → hsParams/khParams` |
| Stage 6 bishop → Stage 6 shell | 56 | every handler ends in `renderStage6()` |
| Stage 6 bishop → Stage 6 ui | 98 | `ensureStage6State`/`stage6RememberDetailsState` prologue |
| Stage 6 bishop → bearing-region helpers | 26 | `stage6EscAttr`, `stage6CompactNumber`, `stage6Tooltip`, `stage6NoteHtml` |
| Stage 6 bishop → Stage 5 | 3 | `readCssToken` |
| Stage 7 → Stage 6 bishop/shell/ui | 18 | payload builders read bishop labels; `stage7CaptureBishopWorkspaceView → renderStage6 + stage6BishopDrawCanvas` |
| Exports → Stage 4 | 4 | `hsParams/khParams` |
| Section → Stage 5 | 1 | `readCssToken` |
| Project → Stage 6 bishop | 2 | `selectCpt → stage6BishopStopSearch/StopSeepage` |

### 3.4 Hidden couplings (must be made explicit before extraction)

1. **`S` closure + reassignment** (1.1). Every extracted module needs `getState()`/`getProject()` accessors (as retaining does)
   or explicit parameters. The stratigraphy `layerParamsFor` swap (160-166) exists only because `hsParams/khParams` read `S`.
2. **Render inside compute:** `detectLayers` calls `renderLayers()`; `runClass` renders four DOM regions and calls `detectLayers`;
   `applyParsedCpt` writes controls and schedules charts; `acceptFit` re-renders Stage 4 if `#p3` is `.active` (3414);
   `setElev` re-renders Stage 3 if `#p2` is `.active` (1517). Visibility checks read DOM classes instead of state.
3. **Stage visibility lives only in the DOM** (`.panel.active`, `.si.locked/done`); `projectIO.getActiveStage` (177-181)
   reads it back from the DOM. `S._maxStage` is the only state mirror.
4. **Shared helpers defined in the "wrong" region:** `readCssToken` (3458, Stage 5) used by 7 functions across 4 stages;
   `stage6EscAttr/EscJsString/Tooltip/NoteHtml/CompactNumber/LoadSummaryHtml` (12433-12717, bearing region) used by every
   Stage 6 app; `arrMax` (1642) used by `setWT` and `buildStage7Payload`; `layerTypeCompatScore` (494) used by Stage 3 merges
   and the section view; `safeClone` (17420) used by Stage 7 only.
5. **Chart.js as a global** (`typeof Chart==='undefined'` polls at 1670-1671, 16841). Stage 1 charts live in `S.charts` and are
   destroyed on CPT switch (256); Stage 5 charts are built from `data-*` JSON with a `canvas._built` flag (3678); Stage 6 charts
   hang on `canvas._chartRef` and are destroyed by `stage6DestroyChart` — three different lifecycles.
6. **DOM ids shared across stages/apps:** `#stage6Area` (all apps), `#minThkInfo` written by Stage 2 run, Stage 1 controls and
   `projectIO.afterLoad` (193); `#layerColSvg` rebuilt by `selectCpt`, drawn by Stage 1 init, Stage 2 run and control debounce;
   `#p2/#p3` `.active` sniffed by Stage 1/5; `#fi` clicked by `addCpt`.
7. **Timers spanning modules:** `setTimeout(buildTuningCharts,50)` fired by both `renderModel` (3253) and `renderTuning` (3669)
   — `buildTuningCharts` scans the whole document for `[data-chart-pending]`; `classificationRefreshTimer` is shared by three
   controls; bearing chart debounce; pile rAF token; `renderStage6` rAF.
8. **Workers are module singletons keyed by run-id** (112-117) and their `onmessage` closures read `S?.stage6?.bishop` **at message
   time** (7667-7669, 7715-7717, 7791-7793) with a `payload.runId !== progress.runId` guard. `selectCpt` terminates the search and
   seepage workers (249-250) but **not** the deformation worker: after a CPT switch mid-run its messages are dropped by the guard
   and the original CPT keeps `deformation.progress.running = true` with no worker to finish it (stuck state until a new run).
9. **Bishop materials are derived from layers by signature** (`bishopLayerSignature`, 6379-6383) — any Stage 3/4 change silently
   clears bishop results on next Stage 6 render; HS stiffness fields are mirrored from `stage6WorkingLayers()` every sync (6394-6402).
10. **Stage 7 capture mutates UI state** (`stage7CaptureBishopWorkspaceView` 17999-18084 switches app/workspace, re-renders,
    captures canvas, restores) — report generation is not side-effect free.
11. **`#bishop` hash** is a second source of truth for `S.stage6.app` (4881, 18311-18320, 18494).
12. **`stage6BishopCanvasState` is global**, not per CPT; `initStage6BishopCanvas` rebinds `canvas.onpointer*` on every render.
13. **`retainingApp` is installed at module scope** (137) with `requestRender: () => renderStage6()` — a hoisted-function reference;
    fine today, but any extraction of `renderStage6` must keep the closure valid.
14. **Feature flags** `STAGE6_ENABLE_HARDENING_SOIL_UI`/`STAGE4_ENABLE_HARDENING_SOIL_PARAMS` are consts read in bishop render
    (14735, 8974) and `renderModel` (3168).

---

## 4. Render pipeline

### 4.1 Static DOM (Svelte) → controller

| Svelte file | Ids it owns (written by the controller) |
|---|---|
| `BannerPhaseShell.svelte` | `#banner #projName #cptTabs #projFileInput #phaseA #phaseB #phaseC #phaseCorr #stratPanel #phaseSection #vexag #vexagV #sectionCanvas #sectionSvg #sectionTip` |
| `StageNav.svelte` | `#nav`, six `.si[data-s]` buttons |
| `Stage1Load.svelte` (`#p0`) | `#dz #fi #s1body #mgrid #ctrlRow #elevN #elev-src #wtR #wtN #wt-taw #wt-src #cptX #cptY #chartArea #layerColSvg #cQc #cFs #cRf #finfo` |
| `Stage2Classification.svelte` (`#p1`) | `#mRob #mRob16 #mCur #mNen #mSB #smartMergeChk #smartMergeControls #smartMergeSensR #smartMergeSensN #minThkR #minThkN #minThkInfo #assumedRfCtrl #assumedRfN #classAssumedRfNote #classLayout #cmet #cmetricHead #cbody #layerPreviewSvg #layerPreviewTip #btnToLayers` |
| `Stage3Layers.svelte` (`#p2`) | `#pmSB260 #pmDEF #pmDesc #lt #lb` (+ `#layerWarnings` created by 2847) |
| `Stage4Model.svelte` (`#p3`) | `#btnAlphaA/B #btnStiffA/B #btnKhKvA/B #ma` |
| `Stage5Tuning.svelte` (`#p4`) | `#tuningArea` |
| `Stage6Applications.svelte` (`#p5`) | `#stage6Area` |

The controller uses 77 distinct `getElementById` ids; 34 static ids are created by its own HTML strings
(`#layerColSvg #cQc #cFs #cRf` re-created by `selectCpt` 306-310; `#stage6Pile*` 13440-13457; `#stage6DfValue`, `#stage6BearingChart`,
`#stage6SelectedDepth #stage6UlsParams #stage6DrainedFormula #stage6UndrainedFormula` 13702-13766; settlement/dewatering/beam chart
canvases 13880-14322; `#stage6BishopLineProbeChart #stage6BishopDxfInput #st6-bishop-selected-region-coarseness
#stage6BishopProgress #stage6BishopMode #stage6BishopProgressBar #stage6BishopCanvas #stage6BishopTip #stage6BishopCoord`
15597-16748) plus dynamic tuning ids `id="${chartId}"`/`${chartId}d` (3591, 3603).

### 4.2 Render functions and triggers

| Region | Render function | Trigger(s) | Technique |
|---|---|---|---|
| CPT tabs | `renderBanner` 336 | init, `selectCpt`, `setCptName`, `removeCpt`, `importCptFiles`, `projectIO.afterLoad` | innerHTML + delegated listeners |
| Stage 1 meta/charts | `renderMeta` 1488, `initCharts` 1664 / `refreshChartData` 1725 | `applyParsedCpt`, `loadDemo`, `selectCpt` (rebuilds `#chartArea` then rAF) | innerHTML; Chart.js instances in `S.charts` |
| Stage 1/2 SVGs | `drawLayerColumnSvg` 1745, `renderLayerPreviewSvg` 1763 | `runClass`, `refreshClassificationDerivedViews`, `selectCpt`, `projectIO.afterLoad` | SVG innerHTML via `report-svg.js` |
| Stage 2 table | inside `runClass` 2131-2185 | Apply button, `setAssumedRf` | innerHTML `#cmet/#cbody/#classAssumedRfNote` |
| Stage 3 table | `renderLayers` 2783 (+`renderCompatWarnings`) | `goS(2)`, `detectLayers`, `changeSubtype`, `setParamMethod`, `setElev`, debounce | innerHTML `#lb`, inline handlers |
| Stage 4 cards | `renderModel` 3148 | `goS(3)`, Stage 4 toggles, Stage 3 editors, `acceptFit` | innerHTML `#ma`; schedules `buildTuningCharts` |
| Stage 5 | `renderTuning` 3524 → `buildTuningCharts` 3672 | `goS(4)`, `runTuning`, `acceptFit/rejectFit`; slider → `updateTuningPreviewM` | innerHTML `#tuningArea`; charts from `data-*` |
| Stage 6 | `renderStage6` 16772 | `goS(5)`, Refresh button, **every** Stage 6 handler, worker messages, hashchange, `stage7Capture*` | full innerHTML of `#stage6Area` = `stage6CardsHtml + stage6SharedBanner + body`; scroll & `<details>` state captured/restored (4647-4723); rAF post-render builds charts/canvas |
| Stage 6 partial paths | `refreshStage6BearingPreview` 13124 (bearing Df slider), `requestStage6PileLightRedraw` 13634 (pile drag), `stage6BishopUpdateProgressDom` 7650 + `stage6BishopDrawCanvas` (bishop progress), `stage6BishopUpdateHoverDom` (hover) | | targeted DOM writes / canvas redraw without innerHTML |
| Bishop canvas | `initStage6BishopCanvas` 12251 → `stage6BishopDrawCanvas` 11123 | post-render rAF, pointer/wheel events, worker progress, viewport fit | 2D canvas, DPR-scaled, reads `S.stage6.bishop` + `S.stage6Cache` |
| Pile section | `drawStage6PileSection` (`stage6-pile-canvas.js:92`) | post-render, rAF drag loop | 2D canvas with hooks `{getLayers,getWt,getMaxDepth,setField,requestRedraw,commitChange}` 13645-13662 |
| Beam geometry | `drawStage6BeamGeometryPreview` 17002 | `buildStage6BeamCharts` | 2D canvas |
| Retaining | `retainingApp.renderBody()` / `postRender()` / internal `renderInputs/updateResultsDom/drawCanvas` | via shell + own handlers | package-internal |
| Stratigrafie | `stratigraphyApp.render()` | `setPhase('correlation')` | `stratigraphy/view.js` into `#stratPanel` |
| Doorsnede | `renderSection` 548 | `setPhase('section')`, `#vexag` input, stratigraphy `onChanged` | SVG innerHTML `#sectionSvg` |
| Reports | `openStage7Report` 18299 | buttons | localStorage + `window.open('/report/stage7?key=…')`; route `src/routes/report/stage7/+page.svelte` re-creates charts with `chart-factories` |

### 4.3 Chart/canvas lifecycles (three patterns)

| Pattern | Where | Create | Destroy |
|---|---|---|---|
| Per-CPT registry | `S.charts.{qc,fs,rf}` | `initCharts` (`new Chart`) | `selectCpt` 256 destroys all, `#chartArea` innerHTML replaced |
| Data-attribute deferred | Stage 5 `[data-chart-pending]` | `buildTuningCharts` (JSON in `data-scatter/default-line/fit-line…`), `canvas._built` | never destroyed explicitly; innerHTML replacement drops them |
| Element-attached | Stage 6 `canvas._chartRef` (bearing, settlement×3, dewatering×4, beam×2, pile×4, bishop line probe, bishop wall charts) | `build*Charts` in post-render rAF | `stage6DestroyChart(id)` 16832 before rebuild |

`<canvas` occurrences in strings: 23 (+1 `createElement('canvas')` for report capture 17926); `new Chart` sites: 20;
`getContext('2d')` sites: 4 (bishop canvas 11132, beam preview, capture, pile via package).

---

## 5. Engine boundaries

| # | Engine | Call site (monolith) | Transport | Request | Response → state |
|---|---|---|---|---|---|
| 1 | Bishop / Spencer slope search (`stage6-bishop.js analyzeBishopSearch` :2571) | `stage6BishopRunSearch` 7910-7969 via `stage6BishopEnsureWorker` 7664-7711 | Worker `./stage6-bishop-worker.js` (module) | `{type:'analyze', runId, input:{model, entryZone, exitZone, methodMode, searchConfig:{...bishop.search, minSliceWidth}, solverConfig:{...bishop.solver}, spencerConfig:{...bishop.spencer}}}`; `model = buildBishopModelFromStageLayers(layers, bishop)` (`stage6-bishop.js:2868`) | `{type:'progress', runId, progress:{trial,total,percent,previewCircle}}` → `bishop.progress` + canvas redraw; `{type:'result', runId, result:{allResults, summary, wallSummary, timing,…}}` → `bishop.results`, `selectedResult=0`, `stale=false`, `renderStage6`; `{type:'error'}`. Stop = `terminate()` (7638-7649). |
| 2 | Seepage FEM (`seepage/solver.js analyzeSeepageModel(input,onProgress,runControl)` :2787; mesh via `seepage/triangle-runtime.js triangulatePslg` :301 → `assets/triangle.out.wasm`) | `stage6BishopRunSeepage` 7970-8038 via `stage6BishopEnsureSeepageWorker` 7712-7787 | Worker `./seepage/seepage-worker.js` | `{type:'run-seepage', runId, input:{model:{...model, seepage:{...model.seepage, mesh:null, result:null}}}}`; `{type:'stop-seepage', runId}` | progress `{percent,message,stage:'meshing'|'solving'|'post'}` → `seepage.status/progress` + `renderStage6`; result `{output:{mesh,result}}` → `seepage.mesh/result/stale/status('success'|'failed')`, auto-enables contour display; error/interrupt handling 7761-7771. Main-thread sampling: `sampleSeepageHead/PorePressure/FlowState`, `contourSegmentsForTriangles` (import 45) used by line probe and canvas. |
| 3 | Deformation FEM (`deformation/solver.js analyzeDeformationModel(input,onProgress,runControl)` :6354; WASM CPU pipeline `deformation/wasm/pipeline.js` → `wasm-runner.js` → `wasm-loader.js` loading `/wasm/deformation/deformation.js` + `.wasm` from `static/wasm/deformation/`, C++ in `src/wasm/deformation/`) | `stage6BishopRunDeformation` 8039-8164 via `stage6BishopEnsureDeformationWorker` 7788-7909 | Worker `./deformation/deformation-worker.js` | `{type:'run-deformation', runId, input:{model, options:{analysisType:'deformation'|'safety-cphi', meshTargetArea, meshElementType:'t3'|'t6', constitutiveModel, initialStressMode:'plastic-geostatic', loadMode, totalLoad, outOfPlaneLength, useSeepagePorePressures, …≈45 solver tolerances/flags…, solverBackend:'wasm-cpu'|'js-cpu', useWasmCpuPipeline, useNewGpuPipeline:false, gpuPipelineVersion:'v1', wasmRobustNonlinearMode:false}}}` (8098-8160); `{type:'stop-deformation', runId}` | progress stages meshing/solving/post; result `{output:{mesh, solver:{analysisType, convergenceState, displayedLoadFactor, loadFactorCommitted, safetyResult, …}, summaries:{maxSettlement, maxMcEta, …}, warnings}}` → `deformation.mesh/result/warnings/status`, 60-line status message 7808-7876; `bishop.deformation.lastWallInputs` snapshot 8079-8089. Main-thread: `sampleDeformationState` (47), `wallResultIsStale` (48). |
| 4 | Retaining walls (C++ `src/wasm/retaining/`, glue `static/wasm/retaining/retaining.js`) | `retaining/retaining-ui.js runAnalysis` (65-82) — not in the monolith | main thread, `retaining/wasm-loader.js runRetainingAnalysis(request)` (JSON string → `_madepRunRetainingAnalysis(ptr,len)` → JSON) | `buildRequest(rw, layers)` (`retaining/request-builder.js`) | `rw.result`, `rw.status`, `rw.error`; token guard `analysisToken`. Drivability runs synchronously in a `setTimeout` (`retaining-ui.js retwallRunDrivability`); `retaining/drivability/drivability-worker.js` exists (`{id,kind,payload}` → `{id,ok,result|error}`) but has no importer. |
| 5 | Pile (`stage6-pile.js analyzePile(layers, wt, cptRaw, cfg)` :816) | `renderStage6` 16789, `requestStage6PileLightRedraw` 13645 | main thread, sync | working layers, `S.wt`, `S.data`, `S.stage6.pile` | `S.stage6Cache.pile` |
| 6 | Settlement / dewatering / beam (`stage6-engineering.js` :529/:950/:1508) | `renderStage6` 16793-16806 | main thread, sync | `(layers, wt, cfg)` | `S.stage6Cache.{settlement,dewatering,beam}` |
| 7 | Bearing (`bearingAtDepth` 12799, `bearingProfile` 12981 in the monolith; uses `designSoilLayer`, `effectiveVerticalStressAtDepth`) | `renderStage6` 16785, `refreshStage6BearingPreview` | main thread, sync | `(S.stage6.bearing, layers)` | `S.stage6Cache.bearing` |
| 8 | Classification kernels (`classification-core.js`) | 1996-2106 | sync | `(row, {sigV, sigVeff, aRatio, assumedRf})` | row `{type, subtype, Ic/Qt…}` |
| 9 | Stratigraphy (`stratigraphy/store.js`) | `setPhase`, `sectionProjection` | sync | `PROJECT.cpts[].{id,elev,layers,data,wt}` | `PROJECT.stratigraphy` |

Worker/WASM inventory across the package: 3 workers instantiated by the monolith (112-117), 1 unused worker (drivability),
2 Emscripten modules (`deformation`, `retaining`; `_malloc`/`stringToUTF8` bridges in `wasm-runner.js:59-64` and
`retaining/wasm-loader.js:53`), 1 raw WASM (`triangle.out.wasm`, `seepage/triangle-runtime.js:5`). GPU code under
`deformation/gpu/` is present but forced off (`useNewGpuPipeline:false` 8157).

---
## 6. Proposed module boundaries and extraction order

### 6.1 Target layout (`src/lib/cpt-app/`)

The model is `retaining/`: pure modules, a state schema with `defaults()/ensure()`, `panels/` returning HTML strings,
`results/`, `scenes/`+canvas, an `install<Pkg>(ctx)` shell that returns `{defaults, ensure, renderBody, postRender, handlers, cardMeta}`,
and Node verifiers under `scripts/verify_*.mjs` with DOM stubs (`scripts/verify_retaining_ui.mjs:14-19`).

| Package | Files | Exports | Source lines today |
|---|---|---|---|
| `core/` | `state.js` (`newCptState`, `createProject`, `getActive()/setActive()`), `dom.js` (`byId`, `setText`, `toggleClass`), `format.js` (`escAttr`, `escJsString`, `compactNumber`, `tooltip`, `noteHtml`, `loadSummaryHtml`, `auditTableHtml`), `css-tokens.js` (`readCssToken`), `chart-host.js` (`destroyChart`, `attachChart`, `waitForChart`), `handlers.js` (`publishHandlers(window, …)`), `stage-visibility.js` (`activeStage`, `maxStage`) | pure helpers, no `S` | 209-246, 1642-1648, 3458-3462, 12433-12717, 16832-16837, 17420-17423 |
| `load/` (Stage 1) | `parsers/gef.js`, `parsers/excel.js`, `parsers/csv.js`, `parsers/excel-headers.js`, `apply-parsed-cpt.js` (pure: returns patch for the CPT), `import-files.js` (`importCptFiles` serial loader with explicit target CPT), `demo.js`, `dropzone.js`, `raw-charts.js` (`initCharts/refreshChartData/emptyStates/updateWTLine`), `meta-panel.js`, `controls.js` (`setElev/setWT/setCptCoord/setAssumedRf/setMinThk/setSmartMerge*`), `layer-svgs.js` (`drawLayerColumnSvg`, `renderLayerPreviewSvg`, tooltip), `index.js` (`installLoadApp(ctx)`) | handlers: `loadGEF, loadDemo, setElev, setWT, setCptCoord, setAssumedRf, setMinThk, setSmartMerge, setSmartMergeSensitivity` | 396-488, 1054-1874 |
| `classification/` (Stage 2) | `stress.js` (`stressAt(cpt, z, gs, g)`), `classify.js` (`classifyRow(cpt, row)` dispatch over `classification-core`), `run.js` (`classifyCpt(cpt) → {classified, rfAssumedCount, useSB260params}`), `panel.js` (metrics/notes/table html), `method-cards.js`, `index.js` (`installClassificationApp(ctx)`) | handlers: `selM, runClass` | 1875-2195 |
| `layers/` (Stage 3) | `segments.js` (`segmentSummary`, `segmentTop`, similarity scores), `merge.js` (`simpleUpwardMerge`, `smartPostMerge`…), `detect.js` (`detectLayers(cpt, {catalogue, paramMethod}) → layers[]` **pure, no render**), `tabel3-compat.js` (`compatLevel`, `qcRfFit`, `suggestSubtype`, `COMPAT`, `CAT_GROUPS`, `layerTypeCompatScore`), `table.js` (`renderLayers`, `buildSubtypeDropdown`, `renderCompatWarnings`), `handlers.js` (`editL`, `changeSubtype`, `editAlpha/M/RShear/Nu`), `index.js` | handlers: `editL, changeSubtype, editAlpha, editM, editRShear, editNu, setParamMethod` | 489-538, 2196-2933, 3050-3062 |
| `model-params/` (Stage 4) | `soil-defaults.js` (`DEF, AE, MC_*`, `mohrCoulomb*`, `sb260*`, `alphaEB`), `hs-params.js` (`hsParams(layer, ctx)` with `ctx = {alphaMethod, stiffMethod, elev, assumedRf, stressAt}`), `kh-params.js` (`khParams(layer, {khKvMethod})`), `working-layers.js` (`workingLayers(cpt)` = today's `stage6WorkingLayers`), `panel.js` (`renderModel`), `index.js` | handlers: `setAlphaMethod, setStiffMethod, setKhKvMethod` | 805-1028, 2937-3049, 3148-3275, 4162-4185 |
| `tuning/` (Stage 5) | `fit.js` (`fitLayer`, bounds, preview helpers), `panel.js` (`renderTuning`), `charts.js` (`buildTuningCharts`, `updateTuningPreviewM`), `index.js` | handlers: `runTuning, acceptFit, rejectFit, updateTuningPreviewM` | 3276-3735 |
| `stage6/` (shell) | `registry.js` (app list + `cardMeta` per app), `shell.js` (`renderStage6` = ensure → compute → body → post-render, `stage6CardsHtml`, `stage6SharedBanner`, `stage6AppIcon`), `state.js` (`defaults()` = merge of per-app defaults, `ensure()` = per-app `ensure()` calls, `get/set/merge`), `ui-state.js` (`details`, scroll capture/restore), `field-setter.js` (`setStage6Field`, `setStage6App`), `index.js` | handlers: `setStage6Field, setStage6App, renderStage6` | 3736-3740, 4135-4161, 4647-4737, 4850-4884, 13148-13195, 16772-16837 |
| `bearing/` | `state.js`, `compute.js` (`bearingAtDepth`, `bearingProfile`, factors, EC7 spec), `panel.js`, `preview.js` (`refreshStage6BearingPreview`), `chart.js`, `notes.js`, `index.js` | `{defaults, ensure, renderBody, postRender, handlers:{}, cardMeta}` | 3741-3755, 4255-4260, 12267-12432, 12638-12674, 12755-13147, 13666-13772, 16838-16852 |
| `pile/` | `state.js` (`ensurePileState`), `panel.js` (4 column renderers), `charts.js`, `section-live.js` (rAF loop + hooks), `index.js` (+ existing `stage6-pile.js`, `stage6-pile-canvas.js` move in) | same shape | 3791-3832, 13196-13665 |
| `settlement/`, `dewatering/`, `beam/` | each `state.js`, `panel.js`, `charts.js`, `options.js` (the help/option text builders 12459-12754), `index.js`; beam also `geometry-preview.js` (16927-17182) | same shape | 3756-3872, 13773-14379, 16853-17182 |
| `seepslope/` (bishop) | `state/defaults.js` (3873-4134 split per concern), `state/ensure.js` (4281-4646), `state/surface-loads.js` (4885-5147), `state/walls.js`, `state/drains.js`, `state/regions.js` (5148-5452, 6514-6678), `model/sync-soil-model.js` (6375-6513), `model/invalidate.js` (5453-5472, 6320-6374), `seepage/bcs.js` (6235-6319), `seepage/contours.js` (5473-5784), `deformation/contours.js` (5785-6234), `runs/search.js`, `runs/seepage.js`, `runs/deformation.js` (worker lifecycle + messages 7582-8178, each returning state patches, no `renderStage6`), `geometry/polygons.js` (9849-10201), `geometry/line-probe.js` (9451-9836), `canvas/viewport.js` (10276-10459), `canvas/snap.js` (10295-10406), `canvas/pointer.js` (10460-11090), `canvas/draw/*.js` (split of 11123-12250: grid, regions, seepage, deformation, loads, walls, drains, drafts, measurement, circles, legend), `panels/*.js` (one file per `data-st6details` group of 14380-16771), `tool-rail.js` (8846-9353), `results/*.js` (8179-8720), `wall-charts.js` (8721-8845, 17183-17208), `ui-state.js` (4738-4849), `field-setter.js` (6679-6827), `index.js` (`installSeepSlopeApp(ctx)`) | same shape; ~105 handlers | 4190-4248, 4281-4646, 4738-4849, 4885-12266, 14380-16771, 17183-17208 |
| `report/` (Stage 7) | `payload.js` (`buildStage7Payload(project, cpt, deps)`), `payload-stage6.js`, `payload-seepslope.js`, `capture.js` (canvas capture without app switching — render to an offscreen canvas via the `seepslope/canvas/draw` modules), `open.js` | handlers: `openStage7Report, stage7CaptureWorkspaceView, stage7ClearWorkspaceCapture` | 17420-18320 |
| `export/` | `csv.js`, `plaxis-commands.js`, `plaxis-cpt.js` | handlers: `exportCSV, exportPlaxisCommands, exportPlaxisCpt` | 17209-17419 |
| `section/` | `render.js` (`renderSection`), `tooltip.js`, `export-svg.js`, `index.js` | handlers: `renderSection, exportSectionSVG` | 536-804 |
| `project/` | `banner.js` (`renderBanner`), `cpts.js` (`selectCpt`, `addCpt`, `removeCpt`, `setCptName`), `phase.js` (`setPhase`), `nav.js` (`goS`, `.si` binding inside install), `index.js` | handlers: `selectCpt, addCpt, setPhase, goS, saveProject, loadProjectFromFile` | 209-398, 1029-1052 |
| `host/legacy-controller.js` (composition root) | creates `PROJECT`, installs every package with a shared `ctx`, publishes handlers, binds hash/dropzone, exports `initLegacyController` | — | 1-208, 18321-18503 |

Shared `ctx` (one object, passed to every `install*`):
`{ getProject, getActive, setActive, requestRender(stage), requestStage6Render, workingLayers, stressAt, hsParams, khParams,
assumedRfValue, cssToken, chartHost, dom, flags }`.

### 6.2 Extraction order (strangler: extract → import back into the monolith → delete the original)

| Step | Scope | Lines moved | Prerequisites | Risk | Verifier |
|---|---|---|---|---|---|
| 1 | `core/format.js`, `core/css-tokens.js`, `core/chart-host.js`, `core/dom.js` | ≈300 | none (pure) | **Low** | unit checks for `escAttr`, `compactNumber` |
| 2 | `model-params/` (`soil-defaults`, `hsParams`, `khParams`, `workingLayers`) with explicit `ctx` instead of `S`; keep monolith wrappers `hsParams(l) => hsParamsPure(l, ctxFromS())` | ≈500 | step 1; `stressAt` extracted alongside (needs `cpt.data/layers/wt`) | **Medium** — 6 callers + stratigraphy `S`-swap (160-166) is deleted | `scripts/verify_model_params.mjs`: golden values for fixture layers under A/B × A/B × A/B method combos; `verify_stratigraphy.mjs` must still pass |
| 3 | `classification/` compute (`stress.js`, `classify.js`, `run.js`) + `layers/` compute (`segments`, `merge`, `detect`, `tabel3-compat`) — pure; monolith `runClass`/`detectLayers` become thin render wrappers | ≈900 | step 2 (`compatLevel` etc. are shared) | **Medium** — `detectLayers` must stop calling `renderLayers`; `S.useSB260params` and `S.paramMethod` become inputs | `verify_qc_only_handling.mjs` (exists) + new golden layer tables per method on the demo profile |
| 4 | `export/` + `report/payload*.js` (consumers only) | ≈1,100 | steps 2-3 | **Low-Medium** — `stage7Capture*` stays in the monolith until step 9 | golden Stage 7 payload JSON for the demo CPT |
| 5 | `load/parsers/*` + `apply-parsed-cpt.js` (return a patch; DOM sync stays in a small `controls.js`) | ≈600 | step 1 | **Low** — parsers already funnel through `import-review` | `verify_import_review.mjs` (exists) + GEF/CSV/XLSX fixtures |
| 6 | `stage6/` shell + per-app state split: `stage6Defaults` → per-app `defaults()`, `ensureStage6State` → per-app `ensure()`; registry-driven `renderStage6` | ≈1,000 | step 1 | **Medium-High** — 78 callers of `ensureStage6State`, 71 of `renderStage6`; keep both names as façades | snapshot of `stage6Defaults()` before/after (deep-equal) and `ensure()` idempotence on saved `.madep.json` fixtures |
| 7 | `bearing/`, `settlement/`, `dewatering/`, `beam/`, `pile/` as retaining-style packages | ≈2,000 | step 6 | **Medium** — 84 inline `setStage6Field` strings keep working through the shell | render each app headless (DOM stub pattern of `verify_retaining_ui.mjs`) and diff HTML against the monolith for the demo CPT |
| 8 | `project/` (banner, cpts, phase, nav) + `section/` + `tuning/` | ≈1,000 | steps 2-3 | **Medium** — `selectCpt` touches 15 Stage-1 ids and stops workers; `S` reassignment moves behind `setActive()` | `verify_project_io.mjs` (exists) round-trip after load |
| 9 | `seepslope/` in sub-steps: 9a state+ensure+migrations; 9b soil-model sync/invalidate; 9c runs/workers (return patches, host re-renders); 9d geometry + line probe; 9e canvas (viewport/snap/pointer, then `draw/*` split); 9f panels (one `data-st6details` group at a time) + tool rail; 9g `report/capture.js` | ≈9,800 | steps 1, 2, 6 | **High** — 2,392-line and 1,128-line functions, ~105 handlers, 3 worker singletons, canvas state, `#bishop` hash | `verify_bishop_phase_a_parity.mjs`, `verify_seepage_*`, `verify_app_multiple_surface_loads.mjs` (exist, engine-level); add headless render parity per panel and a canvas draw-call recorder |
| 10 | Composition root: delete `legacyApi`, publish per-package `handlers`, typed `ctx`, remove module-load side effect (1047), remove `#bishop` hash or move it into `project/phase.js` | ≈300 | all | **Low** once 1-9 are done | Playwright `tests/e2e/retaining-walls.spec.mjs` + a new smoke spec through all six stages |

After every step the app must build unchanged: each extracted module is imported back into `legacy-controller.js` under the
same function names (or thin wrappers), the `legacyApi` object keeps exporting the same 166 names, and Svelte templates are
untouched until step 10.

### 6.3 Hardest couplings (explicit)

1. `S` closure everywhere (1.1) — solved by `ctx.getActive()`; the stratigraphy swap and `importCptFiles` swap disappear once
   `hsParams/khParams/stressAt` take the CPT as a parameter.
2. `ensureStage6State` (398 lines, 78 callers) mixing seven apps' migrations; bishop migration alone is 365 lines and reads
   `stage6MaxDepth()`/`S.wt` (dependent on layers).
3. `renderStage6` as the universal reaction (71 callers, incl. worker callbacks) with scroll/details restoration.
4. `renderStage6BishopApp` (2,392 lines) and `stage6BishopDrawCanvas` (1,128 lines): single functions with ~130 local derivations
   shared across the template; they must be split by `data-st6details` section / draw layer with an explicit view-model.
5. Bishop materials ↔ Stage 3/4 layers (signature, HS mirror 6394-6402) and `stage6BishopSyncSoilModel` being invoked from the
   canvas draw path (11155 → `buildBishopModelFromStageLayers` on every frame).
6. Worker singletons with `S`-at-message-time (3.4 #8) and `selectCpt` not terminating the deformation worker.
7. Stage 7 capture that mutates app/workspace state (17999-18084).
8. Chart.js global + three chart lifecycles (4.3).
9. Stage visibility only in the DOM (`.panel.active`), read by Stage 1/5 handlers and `projectIO`.
10. Unpublished handler `stage6BishopSetSelectedRegionCoarseness` (latent `ReferenceError`), proof that the window surface is
    unchecked — a per-package `handlers` object plus a verifier that greps HTML strings for `on*="name("` and asserts publication
    should be part of step 1.

---

## 7. Metrics

### 7.1 Whole file

| Metric | Value | Source |
|---|---|---|
| Lines | 18,503 | `wc -l` |
| Top-level functions / nested | 540 / 13 | `grep -cE '^(async )?function '` |
| Module-level `let/const` | 47 (11 `let`) | §1.3 |
| Imports (source modules) | 22 modules, 90 symbols | 3-105 |
| Names published on `window` | 178 (166 `legacyApi` + 12 retaining) | 18321-18493 |
| Inline `on*="…"` attributes in HTML strings | 398 (`this.value` 232, `this.checked` 62) | grep |
| Distinct handler functions called from HTML strings | 57 (+1 unpublished) | §2.15 |
| Svelte `call()` names | 28 (+ `PROJECT` direct) | components |
| `innerHTML =` assignments | 32 | §7.2 |
| Static `id="…"` in HTML strings / dynamic | 34 / 2 | grep |
| Distinct `getElementById` ids | 77 | grep |
| Ids in Svelte templates | 78 | grep |
| `<canvas` in strings / `createElement('canvas')` / `getContext` | 23 / 1 / 4 | grep |
| `new Chart(` sites | 20 | grep |
| `<svg` in strings (+3 Svelte-owned SVG hosts) | 6 | grep |
| Workers created | 3 (+1 unused in package) | 112-117 |
| Timer/rAF sites | 13 | §1.3 |
| `addEventListener` sites | 11 | grep |
| `alert/confirm` calls | 21 | grep |
| `try/catch` | 14 | grep |
| `data-st6details` keys | 34 | grep |
| `.st6-*` CSS classes in `legacy.css` (2,311 lines) | 130 | grep |
| Node verifiers in `package.json` | 60+ scripts (none for Stages 1-5 UI; `verify_qc_only_handling`, `verify_project_io`, `verify_stratigraphy`, `verify_import_review`, `verify_retaining_ui` touch controller-adjacent code) | `package.json` |
| E2E | 1 Playwright spec (`tests/e2e/retaining-walls.spec.mjs`) | |

### 7.2 Per region

| Region | Lines | Fns | Inline handlers | `innerHTML=` | `<canvas` | static ids | Share |
|---|---:|---:|---:|---:|---:|---:|---:|
| imports + state + installs (1-208) | 208 | 0 | 0 | 0 | 0 | 0 | 1.1 % |
| project + banner + phase (209-395) | 187 | 7 | 1 | 2 | 3 | 4 | 1.0 % |
| navigation `goS` (1026-1053) | 28 | 1 | 0 | 0 | 0 | 0 | 0.2 % |
| Stage 1 load + parsers + controls + charts + demo (396-488, 1054-1874) | 914 | 49 | 0 | 4 | 0 | 0 | 4.9 % |
| Stage 2 (1875-2195) | 321 | 15 | 0 | 7 | 0 | 0 | 1.7 % |
| Stage 3 (489-535, 2196-2933) | 785 | 33 | 2 | 3 | 0 | 0 | 4.2 % |
| Stage 4 (805-1025, 2934-3255) | 543 | 13 | 4 | 1 | 0 | 0 | 2.9 % |
| Stage 5 (3256-3735) | 480 | 12 | 3 | 2 | 2 | 0 | 2.6 % |
| Section view (536-804) | 269 | 4 | 0 | 4 | 0 | 0 | 1.5 % |
| Stage 6 state + ensure + ui + dispatch (3736-4884) | 1,149 | 32 | 0 | 0 | 0 | 0 | 6.2 % |
| Stage 6 bishop core (4885-12266) | 7,382 | 258 | 53 | 3 | 0 | 0 | 39.9 % |
| Stage 6 bearing + shared helpers (12267-13147) | 881 | 52 | 1 | 4 | 0 | 0 | 4.8 % |
| Stage 6 shell (13148-13195, 16772-16837) | 114 | 5 | 1 | 2 | 0 | 0 | 0.6 % |
| Stage 6 pile (13196-13665) | 470 | 10 | 3 | 0 | 4 | 5 | 2.5 % |
| Stage 6 bearing render (13666-13772) | 107 | 1 | 13 | 0 | 1 | 6 | 0.6 % |
| Stage 6 settlement (13773-13950) | 178 | 1 | 16 | 0 | 3 | 3 | 1.0 % |
| Stage 6 dewatering (13951-14128) | 178 | 1 | 16 | 0 | 4 | 4 | 1.0 % |
| Stage 6 beam (14129-14379) | 251 | 1 | 35 | 0 | 3 | 3 | 1.4 % |
| Stage 6 bishop render (14380-16771) | 2,392 | 1 | 251 | 0 | 3 | 9 | 12.9 % |
| Stage 6 charts + beam canvas (16838-17208) | 371 | 10 | 0 | 0 | 0 | 0 | 2.0 % |
| Exports (17209-17419) | 211 | 13 | 0 | 0 | 0 | 0 | 1.1 % |
| Stage 7 report (17420-18320) | 901 | 21 | 0 | 0 | 0 | 0 | 4.9 % |
| `legacyApi` + init (18321-18503) | 183 | 0 | 0 | 0 | 0 | 0 | 1.0 % |

Aggregates: **Stage 6 = 13,473 lines (72.8 %)**, of which Seep/Slope ≈ 9,774 (+ ≈630 of its state defaults/migration) ≈ **10,400
lines (56 %)**; Stages 1-5 together = 3,043 lines (16.4 %); Stage 7 + exports = 1,112 (6.0 %).

---

## 8. Top 10 risks

1. **`S` is a reassignable module global** (245; reassigned at 260, 375, 439/456, 160-166). Any extraction that captures `S` by
   value breaks CPT switching; any that keeps the closure keeps the monolith. Mitigation: `ctx.getActive()` from step 1 on.
2. **`renderStage6` full re-render is the reaction model** (71 callers, worker callbacks included). Splitting apps without a
   registry/façade will regress scroll/`<details>` restoration (4647-4723) and post-render chart builds.
3. **`ensureStage6State` migrations** (4249-4646) run on every Stage 6 call and are order-dependent (retaining `ensure` 4252,
   pile 4280, bishop 4281-4646 reading `stage6MaxDepth()`); saved `.madep.json` files from earlier versions depend on them.
4. **Bishop worker callbacks read `S` at message time** (7667-7710, 7715-7770, 7791-7893); `selectCpt` terminates search and
   seepage (249-250) but not deformation → after a CPT switch during a deformation run the result is dropped by the `runId`
   guard and the originating CPT is left with `progress.running = true` (no result, no error).
5. **Compute/render entanglement in Stages 2-3** (`runClass` → `detectLayers` → `renderLayers`; `setParamMethod`; the 90 ms
   debounce 1592-1601). Extracting `detectLayers` as pure changes call ordering visible in `#minThkInfo` and Stage 3 table.
6. **`projectIO.afterLoad` (180-201) replays `runClass()` then overwrites `S.layers`** — a pure `detectLayers` must keep
   this path (manual overrides restored after auto-detection) intact.
7. **Chart.js global & three lifecycles** (§4.3). Moving chart code changes when `Chart` is polled (1670, 16841) and who
   destroys instances; leaks or "canvas already in use" errors are the failure mode.
8. **Stage 7 capture side effects** (17999-18084): switching app/workspace and re-rendering during payload build; extracting
   render code changes what the capture sees. Needs an offscreen render path first.
9. **Unverified window surface**: `stage6BishopSetSelectedRegionCoarseness` is called from 4 HTML sites (9145, 16198, 16612-16613)
   but missing from `legacyApi` (18321-18488) → `ReferenceError` on use today; refactoring will create more of these unless a
   verifier asserts every `on*="fn("` name is published.
10. **The two giant functions** (`renderStage6BishopApp` 2,392 lines with ~130 shared locals; `stage6BishopDrawCanvas` 1,128
    lines with closures over `ctx`, `model`, `bishop`) cannot be split mechanically; each needs a view-model object first,
    and the canvas draw path calls `stage6BishopSyncSoilModel` (11155) — a state mutation inside a draw.

Secondary: module-load side effect at 1047; `#bishop` hash coupling (4881, 18311-18320); `readCssToken`/`stage6EscAttr` living
in unrelated regions; `buildTuningCharts` scanning the whole document from two stages (3253, 3669); DOM-only stage visibility
read by `projectIO.getActiveStage` (177-181), `setElev` (1517), `acceptFit` (3414), `refreshClassificationDerivedViews` (1587).

---

## 9. Suggested first three extractions

1. **`core/` foundations + handler verifier (step 1).** Move `stage6EscAttr`, `stage6EscJsString`, `stage6Tooltip`,
   `stage6NoteHtml`, `stage6CompactNumber`, `stage6LoadSummaryHtml`, `stage6AuditTableHtml` (12433-12717), `readCssToken`
   (3458), `arrMax/arrSafe` (1642-1648), `safeClone` (17420), `stage6DestroyChart` (16832) into `core/format.js`,
   `core/css-tokens.js`, `core/chart-host.js`; re-import under the old names. Add `scripts/verify_window_handlers.mjs` that parses
   every `on*="…("` name in `legacy-controller.js` and the retaining panels and asserts it is in `legacyApi`/`handlers` — this
   immediately catches `stage6BishopSetSelectedRegionCoarseness`. Zero behaviour change, ≈300 lines, one afternoon.
2. **`model-params/` (step 2): `stressAt`, `hsParams`, `khParams`, soil tables, `alphaEB`, `stage6WorkingLayers`** with an explicit
   `(layer, ctx)` signature where `ctx = {data, layers, wt, elev, alphaMethod, stiffMethod, khKvMethod, assumedRf}` is built by
   a `cptParamContext(cpt)` helper. Delete the `S`-swap in `installStratigraphyApp` (160-166) by passing `cpt` directly. Callers:
   `renderModel`, `fitLayer`, `stage6WorkingLayers`, `exportCSV`, `exportPlaxisCommands`, `stage7WorkingLayerPayload`,
   `stratigraphy`. Golden-value verifier over the demo profile for all 8 method combinations. This is the contract every
   downstream stage (5, 6, 7, exports, stratigraphy) depends on, so fixing it first de-risks everything after.
3. **`layers/` + `classification/` pure compute (step 3): `classifyCpt(cpt)` and `detectLayers(cpt, opts) → layers[]`** with
   `renderLayers` removed from inside `detectLayers` and moved to the callers (`runClass` 2193, `refreshClassificationDerivedViews`
   1583, `setParamMethod` 3061). Include `segmentSummary`, the merge family, `compatLevel/qcRfFit/suggestSubtype`, `COMPAT`,
   `CAT_GROUPS`, `layerTypeCompatScore`. Verifier: layer tables for the demo CPT under the 5 methods × smart-merge on/off ×
   paramMethod, compared to the current output captured before the move. After this, Stages 1-5 are thin render shells and the
   Stage 6 shell split (step 6) can start on a stable layer contract.
