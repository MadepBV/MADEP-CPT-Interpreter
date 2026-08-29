# 21 — PR 18a `refactor(seepslope): state — defaults, ensure/migrations, surface loads, walls, drains, regions`

Base `integration-r` @ ff54aab (v0.6.0 tip: PR 4–17 merged; controller 12 192 lines), the first Seep / Slope
sub-step of `01-monolith-map.md` §6.2 step 9 (PLAN §2 row 18a; map §1.2 bishop sub-state, §2.11 groups
"Surface-load state" and "Zones/walls/drains/regions state" + the region / wall / drain handlers, §6.1 row
`seepslope/`, §6.3 items 2 / 4 / 5). Executed by a Fable agent in an isolated worktree, one commit. File set:
`src/lib/cpt-app/legacy-controller.js` (the bishop state regions + the import block only), new
`src/lib/cpt-app/seepslope/state/**` (9 files), `src/lib/cpt-app/stage6/apps/bishop-state.js` (→ re-export),
new `scripts/verify_seepslope_state.mjs`, this report. `package.json`, `tests/`, `scripts/golden/**`,
`stage6/state.js` / `registry.js`, every render function and every class attribute untouched (the Stage 6
restyle PR owns the templates).

One pure move: `npm run golden:check` **2 086 / 0 / 0 / 0** before, after the move and on the final tree —
no golden updated, no `tests/golden/CHANGELOG.md` entry. The new verifier compares the base controller
(integration-r, loaded from git with its **own** `stage6/apps/bishop-state.js`) with the working tree:
**1 110 / 1 110**, incl. 141 state-operation steps under a seeded clock whose `wall_` / `drain_` / `region_`
ids are compared verbatim. The seep-slope browser journey is green (state + DOM text, 13 steps).

## 1. What moved (verbatim bodies; only the `S` reads became parameters)

Old line numbers are those of ff54aab (integration-r); the stage6/apps/bishop-state.js lines are PR 11's.
Every moved body was cut at its `function name(` anchor and re-read against the new module; the only
edits inside the bodies are the ones listed in the "change" column.

| Monolith (old) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `stage6/apps/bishop-state.js defaults()` (PR 11; monolith 3873-4134 at 462fc50) | `seepslope/state/defaults.js` → `defaults()` + 17 per-concern builders (`lineProbeDefaults`, `searchDefaults`, `spencerDefaults`, `seepageOptionsDefaults`, `deformationOptionsDefaults`, …) | the literal is split into builders; `defaults()` composes them in the literal's key order (the two tab-indented surface-load lines included) | `stage6Defaults()` unchanged — reaches it through the registry and the re-export |
| `bishop-state.js ensure(stage6, env)` (PR 11; monolith 4281-4646, 364 lines) | `seepslope/state/ensure.js` → `ensure(stage6, env)` + 30 named steps (§2) | statements regrouped into named functions in the **same order**; `defaults().x` → the builder `xDefaults()`; the `env.migrateSurfaceLoadsShape` hook → the package's own `migrateSurfaceLoadsShape` | `stage6EnsureCtx()` no longer passes `migrateSurfaceLoadsShape` (`stage6/state.js` still forwards `ctx.migrateSurfaceLoadsShape` = undefined into `env`, harmless, see §7) |
| `bishop-state.js sortedPolyline, seepageDomainArea, auto/resolved{Seepage,Deformation}MeshTargetArea` (monolith 4147-4204, 4885-4895) | `seepslope/state/domain.js` (same six names) | none | the five monolith names are import aliases (`sortedPolyline as stage6BishopSortedPolyline`, …) instead of the destructuring of `stage6BishopState` |
| `stage6BishopSortZone` 1810, `ValidZone` 1819, `ZoneKey` 2061, `ZoneLabel` 2068, `ZoneColor` 2075, `AllocateSurfaceLoadId` 1826, `NormalizeSurfaceLoad` 1833, `LegacySurfaceLoadSeed` 1867, `MigrateSurfaceLoadsShape` 1882 | `surface-loads.js` → `sortZone`, `validZone`, `zoneKey`, `zoneLabel`, `zoneColor`, `allocateSurfaceLoadId`, `normalizeSurfaceLoad`, `legacySurfaceLoadSeed`, `migrateSurfaceLoadsShape` | names only (they already took `bishop`) | import aliases under the monolith names |
| `SyncLegacySurfaceLoadMirror(bishop = S.stage6?.bishop)` 1853, `SelectedSurfaceLoad()` 1915, `PrimarySurfaceLoad(create)` 1921, `EffectiveSurfaceLoadQ(load, workspace = S…)` 1947, `SurfaceLoadSummary` 1968, `ActiveSurfaceLoads` 1975 | `surface-loads.js` → `syncLegacySurfaceLoadMirror(bishop)`, `selectedSurfaceLoad(bishop)`, `primarySurfaceLoad(bishop, create)`, `effectiveSurfaceLoadQ(bishop, load, workspace = bishop?.workspace \|\| 'stability')`, `surfaceLoadSummary(bishop, load, workspace)`, `activeSurfaceLoads(bishop, workspace)` | `S.stage6?.bishop` → the first parameter | six one-line façades with the old signatures (default arguments still read `S`) |
| `SetSurfaceLoadField` 1982 **H**, `SelectSurfaceLoad` 2015 **H**, `DeleteSurfaceLoad` 2023 **H**, `CreateSurfaceLoadFromZone` 2037 | `surface-loads.js` → `setSurfaceLoadField(bishop, loadId, field, value) → load \| null`, `selectSurfaceLoad(bishop, loadId)`, `deleteSurfaceLoad(bishop, loadId) → boolean`, `createSurfaceLoadFromZone(bishop, zone) → load \| null` | `ensureStage6State` / `stage6RememberDetailsState` / `stage6BishopInvalidate` / `renderStage6` out; the early `return`s became `null` / `false` return values | façades: ensure + remember → the op → invalidate (only when the op reports a change) → render — same message strings, same conditions |
| `PassiveSideLabel` 2082, `DefaultPassiveSide()` 2086, `WallId()` 2094, `DefaultWallMaterial` 2098, `WallMaterialPreset` 2116, `WallMaterialPresetKey` 2142, `NormalizeWalls` 2159, `ResultWallLabel` 2359 | `walls.js` → `passiveSideLabel`, `defaultPassiveSide(terrain = [])`, `wallId(ids = DEFAULT_IDS)`, `defaultWallMaterial`, `wallMaterialPreset`, `wallMaterialPresetKey`, `normalizeWalls`, `resultWallLabel` | `S.stage6?.bishop?.terrain \|\| []` → the `terrain` parameter; `Date.now()` / `Math.random()` → `ids.now()` / `ids.random()` (`ids.js entityId`) | aliases for the pure ones; `stage6BishopDefaultPassiveSide()` / `stage6BishopWallId()` façades |
| `SetWallField` 4081 **H**, `SetWallMaterialField` 4126 **H**, `DeleteWall` 4180 **H**, `SelectWall` 4192 **H** | `walls.js` → `setWallField(bishop, index, field, value) → 'mechanical' \| 'geometry' \| 'other' \| null`, `setWallMaterialField(…) → { seepage, deformation } \| null`, `deleteWall(bishop, index) → wall \| null`, `selectWall(bishop, wallId, ui = null) → wall \| null` | the invalidation `if` chains became return values; the rejected-value `return`s (`!(nextValue > 0)`, ν ∉ [0, 0.5)) became `return null` **after** the same `normalizeWallMaterial(…, 'user')` mutation; the UI flags of `selectWall` are written on the `ui` parameter | façades: ensure + `stage6BishopSyncSoilModel()` → the op → the invalidator the class names → render; `SelectWall` passes `stage6BishopUiState()` |
| the inline wall creation of `stage6BishopCommitDrawPoint` 7621-7641 and `CompleteCurrentActionAt` 7696-7716 (duplicated, canvas pointer region) | `walls.js` → `addWall(bishop, head, tip, ids) → id` | new function, the same object literal + `normalizeWalls` + selection | **not wired** (the pointer region is step 9e's); the verifier proves it reproduces the pointer path's wall bit for bit (§4 d) |
| `DrainId()` 2235, `NormalizeDrains` 2239, `DefaultDrainHead` 2249, `DrainValidationSummary` 2288, `DrainGatingLabel` 2296 | `drains.js` → `drainId(ids)`, `normalizeDrains` (the app's wrapper; `seepage/drains.js normalizeDrains` imported as `normalizeDrainModels`), `defaultDrainHead`, `drainValidationSummary`, `drainGatingLabel` | ids as above | aliases (`normalizeDrains as stage6BishopNormalizeDrains`), `stage6BishopDrainId()` façade |
| `CreateDrainFromVertices` 2257 | `drains.js` → `createDrainFromVertices(bishop, vertices, { model, ids }) → { ok, drainId?, validation }` | `S.stage6Cache?.bishopModel \|\| stage6BishopCurrentModel() \|\| {}` → the `model` option (a value **or a function**, read after the candidate is built — the monolith's order); `stage6SetDetailsOpen` + `stage6BishopInvalidateSeepage` out | façade passes `model: () => S.stage6Cache?.bishopModel \|\| stage6BishopCurrentModel() \|\| {}`, opens the drains accordion and invalidates seepage on `ok` |
| `SelectDrain` 4453 **H**, `SetDrainField` 4460 **H**, `DeleteDrain` 4482 **H** | `drains.js` → `selectDrain(bishop, drainId)`, `setDrainField(bishop, index, field, value) → drain \| null`, `deleteDrain(bishop, index) → drain \| null` | host calls out; the non-finite-head `return` → `null` | façades; `SetDrainField` keeps the model re-validation (`validateDrains(stage6BishopCurrentModel())`, step 9b territory) |
| `RegionId()` 2302, `STAGE6_REGION_COORD_DECIMALS` / `_COARSENESS_DECIMALS` 2306, `RoundRegionCoord` 2309, `NormalizeRegionCoarseness` 2313, `ClampRegionPoint` 2319, `NormalizeCustomRegions` 2326, `SelectedCustomRegion()` 2353 | `regions.js` → `regionId(ids)`, `REGION_COORD_DECIMALS`, `REGION_COARSENESS_DECIMALS`, `roundRegionCoord`, `normalizeRegionCoarseness`, `clampRegionPoint`, `normalizeCustomRegions(regions, terrain, materials, ids = DEFAULT_IDS)`, `selectedCustomRegion(bishop)` | `S?.stage6?.bishop` → parameter; ids as above | aliases; `stage6BishopRegionId()` / `stage6BishopSelectedCustomRegion()` façades; the two constants had no other reader and are gone from the controller |
| `SetSelectedRegion` 3427, `CopyCurrentRegionsToCustom` 3433 **H**, `SetUseCustomRegions` 3484 **H**, `ClearCustomRegions` 3493, `DeleteSelectedRegion` 3502 **H**, `SetSelectedRegionMaterial` 3517 **H**, `SetSelectedRegionCoarseness` 3529 **H**, `SplitSelectedRegion` 3552 | `regions.js` → `setSelectedRegion(bishop, id)`, `copyCurrentRegionsToCustom(bishop, model, ids) → boolean`, `setUseCustomRegions(bishop, value) → boolean`, `clearCustomRegions(bishop)`, `deleteSelectedRegion(bishop) → boolean`, `setSelectedRegionMaterial(bishop, id) → region \| null`, `setSelectedRegionCoarseness(bishop, value) → region \| null`, `splitSelectedRegion(bishop, { splitPolygon, ids }) → { ok }` | `stage6BishopCurrentModel()` → the `model` parameter (copy) / a second call kept in the façade (the re-sync after enabling); `stage6BishopSplitRegionPolygon` (geometry, step 9d) → the `splitPolygon` hook; `stage6BishopSyncSoilModel` / invalidators / render out | façades with the same messages and branch structure; `ExportRegionsDxf` (DOM download) and `CommitPendingSelectedRegionCoarseness` (reads an input) untouched |
| the `region` branch of `stage6BishopFinishDraft` 3872-3884 (draft handlers region) | `regions.js` → `addCustomRegion(bishop, polygon, ids) → id \| null` | new function, the same literal + `normalizeCustomRegions` + selection (after the caller's polygon validation) | **not wired** (step 9e / 9d); proven against `FinishDraft` by the verifier |

Imports dropped from the controller because their last reader moved: `normalizeDrain`, `normalizeDrains`
(seepage/drains), `wallMechanicalPresetById` (seepage/material). `validateDrains`, `normalizeWallMaterial`,
`defaultWallMechanicalMaterial`, `resolveWallMechanicalSection`, `wallEndpoints`, `wallAxis`, `isSimplePolygon`,
`normalizeRegionPolygon`, `polygonArea` still have readers in other regions and stay.

## 2. The package — `src/lib/cpt-app/seepslope/state/`

| File | Lines | Exports |
|---|---|---|
| `index.js` | 61 | the surface below; `ensureSteps` (the ensure module as a namespace), `surfaceLoads` / `walls` / `drains` / `regions` namespaces |
| `defaults.js` | 356 | `defaults()`, `measurementDefaults`, `lineProbeDefaults`, `displayDefaults`, `surfaceLoadMirrorDefaults`, `viewportDefaults`, `searchDefaults`, `solverDefaults`, `spencerDefaults`, `progressDefaults`, `runProgressDefaults`, `seepageOptionsDefaults`, `seepageDisplayDefaults`, `seepageDefaults`, `deformationOptionsDefaults`, `deformationDisplayDefaults`, `deformationDefaults`, `capturedViewDefaults` |
| `ensure.js` | 618 | `ensure(stage6, env)` + the steps: `migrateSchemaVersion`, `ensureWorkspace`, `ensureMeasurement`, `ensureLineProbe`, `migrateAnalysisDepth`, `ensureCanvasSettings`, `ensureSearch`, `ensureMethodAndSolver`, `migrateSpencer`, `ensureGeometryCollections`, `ensureSeepage` (→ `migrateSeepageMeshTargetArea`), `ensureDeformation` (→ `ensureConstitutiveModel`, `ensureDeformationRunState`, `migrateHsConsistentTangentPrompt`, `ensureDeformationLoadOptions`, `migrateRetunedSolverDefaults`, `ensureNonlinearSolverOptions`, `migrateGeostaticInitialization`, `ensureGeostaticOptions`, `removeSchwarzPreconditioner`, `ensureSafetyOptions`, `migrateSolverBackend`, `migrateDeformationMeshTargetArea`, `ensureDeformationDisplay`), `ensureAnalysisTab`, `migrateSurfaceLoads`, `ensureViewport`, `ensureStrengthSet` — each with a doc comment naming the legacy shape it upgrades (v1 `bottomMargin`, v2 `FfTolerance` / `FfBracket*`, the single `surfaceLoad`, upper-case `meshElementType`, the predictor `initialStressMode`, the re-tuned solver defaults, the historical geostatic method strings, the Schwarz / GPU option carriers, `useWasmCpuPipeline` → `solverBackend`, the `syy` / `mc` contour ids, the manual-0.5 m² mesh, …) |
| `domain.js` | 88 | `sortedPolyline`, `seepageDomainArea`, `autoSeepageMeshTargetArea`, `resolvedSeepageMeshTargetArea`, `autoDeformationMeshTargetArea`, `resolvedDeformationMeshTargetArea` |
| `ids.js` | 20 | `DEFAULT_IDS` (`{ now: Date.now, random: Math.random }`), `entityId(prefix, ids)` — `<prefix>_<now36>_<5 random base36>` |
| `surface-loads.js` | 307 | §1: 9 pure helpers, 6 readers, 6 state operations |
| `walls.js` | 359 | §1: 8 pure helpers, `addWall`, `setWallField`, `setWallMaterialField`, `deleteWall`, `selectWall` |
| `drains.js` | 135 | §1: 5 pure helpers, `createDrainFromVertices`, `selectDrain`, `setDrainField`, `deleteDrain` |
| `regions.js` | 226 | §1: 6 pure helpers + 2 constants, `setSelectedRegion`, `addCustomRegion`, `copyCurrentRegionsToCustom`, `setUseCustomRegions`, `clearCustomRegions`, `deleteSelectedRegion`, `setSelectedRegionMaterial`, `setSelectedRegionCoarseness`, `splitSelectedRegion` |

Total 2 170 lines. Every module: SPDX + `@ts-nocheck`, header naming the source lines and the contract, `.js`
imports; the package loads under plain Node (`import('./src/lib/cpt-app/seepslope/state/index.js')` — the
verifier's (d) group runs it without Vite). Dependencies outside the package: `stage6/merge.js` (the
schema merge, as PR 11's bishop-state had), `stage6-bishop.js terrainY`, `soil-regions.js`,
`seepage/material.js`, `seepage/drains.js`, `wall-geometry.js` — all engine / geometry modules, no `S`, no DOM.

Contract of the state operations (documented in each header): they take the `bishop` block, mutate it
exactly as the monolith did, and return what the host needs to decide on **invalidation and render** —
the changed entity (or `null` for the monolith's silent early returns), a boolean "removed", the
invalidation class of a wall field (`'mechanical'` → `InvalidateDeformation`, `'geometry'` →
`InvalidateWallGeometry`, `'other'` → `Invalidate`), `{ seepage, deformation }` for a wall material field,
`{ ok, drainId, validation }` for a drain. Ids come from an explicit `{ now, random }` (default: the real
clock and PRNG) so the verifier can seed them; `normalizeCustomRegions` takes `ids` as an optional fourth
argument (it allocates ids for regions that lack one). Two geometry / model dependencies stay hooks:
`splitSelectedRegion({ splitPolygon })` (the polygon split of step 9d) and `createDrainFromVertices({ model })`
/ `copyCurrentRegionsToCustom(bishop, model)` (the soil model of step 9b).

`stage6/apps/bishop-state.js` (721 → 19 lines) re-exports `defaults`, `ensure` and the six domain helpers
from the package — the pattern of the five other `apps/*-state.js`; `stage6/registry.js` and
`stage6/index.js` (`bishopState` namespace) are untouched and resolve to the package.

## 3. Controller

| | lines |
|---|---|
| before (ff54aab) | 12 192 |
| after | **11 627** (−565; `git diff --stat`: 126 insertions, 691 deletions) |

Hunks (`git diff integration-r`): the import block (the `bishopState as stage6BishopState` line and the
9-line destructuring of the mesh helpers replaced by one 62-name import from `./seepslope/state/index.js`,
placed after the `beam/` import; three names dropped from the `seepage/drains` / `seepage/material`
imports), `stage6EnsureCtx()` (one hook fewer), the surface-load / zone / wall / drain / region helper
region 1810-2364 (555 lines → 91 lines of façades under a `── seepslope/state façades ──` banner), the
region handlers 3427-3590 (minus `ExportRegionsDxf` / `CommitPending…`, untouched in place), the wall
handlers 4081-4207 and the drain handlers 4453-4493. Nothing else: the canvas pointer handlers, `FinishDraft`,
`SetField`, `SyncSoilModel`, the invalidators, the render functions and every HTML string are byte-identical
(the handler verifier: 180 names published, **`legacyApi` 167**, every inline handler resolved).

Names that stay in the controller as import aliases (their monolith signature never read `S`):
`stage6BishopSortedPolyline`, the four mesh-area helpers, `SortZone`, `ValidZone`, `ZoneKey/Label/Color`,
`AllocateSurfaceLoadId`, `NormalizeSurfaceLoad`, `LegacySurfaceLoadSeed`, `MigrateSurfaceLoadsShape`,
`PassiveSideLabel` (no caller anywhere, kept), `DefaultWallMaterial`, `WallMaterialPreset`,
`WallMaterialPresetKey`, `NormalizeWalls`, `ResultWallLabel`, `NormalizeDrains`, `DefaultDrainHead`,
`DrainValidationSummary`, `DrainGatingLabel`, `RoundRegionCoord`, `NormalizeRegionCoarseness`,
`ClampRegionPoint`, `NormalizeCustomRegions`. Names that stay as functions (façades): the 31 listed in §1.

## 4. `scripts/verify_seepslope_state.mjs`

Two child processes (pattern of `verify_stage6_shell.mjs` / `verify_settlement_dewatering_beam.mjs`), each
loading one controller through the Tier-B loader (`installDomStub()` + its own Vite `ssrLoadModule`), dumping
the same observations as JSON with key order preserved; the parent compares byte for byte and prints the first
differing path. The base controller is `git show <ref>:…` (default `integration-r`, `--base <ref>` otherwise)
materialised as `src/lib/cpt-app/__verify-seepslope-base.legacy-controller.js` **together with the base's own
`stage6/index.js`, `stage6/registry.js` and `stage6/apps/bishop-state.js`** (`MOVED_SIBLINGS`, specifiers
rewritten) — without them the base would import the working tree's re-export and (a)/(b) would compare the
new package with itself. All four are deleted in a `finally`. `--snapshot f.json` / `--against f.json` as usual.

| Group | Checks | What |
|---|---|---|
| (a) `stage6Defaults()` | 2 | JSON text identical (deep-equal **and** key order); a second call identical |
| (b) `ensureStage6State()` | 39 | `legacy-v0.5.2` (3 CPTs — the forward-compat fixture), `multi-3cpt` (3), `single-layered` (1) through `loadProjectFromFile`: per CPT `stage6` identical + idempotent + cache keys; a fresh CPT; the stage6-shared "partial" state (+ a bishop `bottomMargin` / manual mesh area); two synthetic legacy bishop blocks — **v1** (schemaVersion 1, `bottomMargin` 7 + `analysisDepth: ''`, `FfTolerance` / `FfBracket*`, single `surfaceLoad`, legacy `x / yTop / yTip` walls, a one-vertex drain, a region with an unknown material, the predictor `initialStressMode`, `'T6'`, `hardening-soil` with the HS UI off, the old solver defaults, `'direct-k0'`, a string tangent schedule, the Schwarz + GPU carriers, `useWasmCpuPipeline: false`, `'syy'`, `wallOverlayQuantity 'Q'`, bogus enums everywhere) and **v2** (schemaVersion 2, duplicate / degenerate loads, `'gravity-ramp'` with linear-elastic, `solverBackend 'gpu'`, `'mc'`, manual 0.7 m² seepage mesh, `meshTargetAreaAuto: false` without a value, an unordered F bracket, the safety-only probe quantity) — on a fresh CPT and on the layered CPT; each identical + idempotent, and the two blocks are asserted to have **reached** every migration (§6.1 for what the merge hides) |
| (c) state operations on `layered` | 997 | sb260 → `goS(3)` → `goS(5)` → the bishop suite's terrain / zones → `setStage6App('bishop')`; then **141 steps** under a seeded `Date.now` (1 s ticks) and `Math.random` (mulberry32) so the `wall_` / `drain_` / `region_` ids are deterministic and compared verbatim: the canvas tools by synthetic pointer events on `#stage6BishopCanvas` (world → screen through the live viewport; the stub canvas gets `setPointerCapture` and a `parentElement` for the hover tooltip): wall × 2, load × 2, drain × 2 (one rejected by `validateDrains` — above the terrain), region (4 clicks + `PopDraftPoint` + right click), region split (two boundary clicks), a split click off the boundary, a terrain draft + `PopDraftPoint` (the only undo the app has); the panel handlers: `SetWallField` × 16 (every field incl. rejected / cleared values and an unknown wall), `SetWallMaterialField` × 21 (preset × 4, both mechanical models, every mechanical key incl. rejected E / ν / kAlong, label, conductivities), `SelectWall` / `DeleteWall` (+ unknown), `ToggleWallMomentOverlay`, `SetSurfaceLoadField` × 11 (+ unknown load), `SetField('surfaceLoad.*')` × 5 (the primary-load path, the total-mode conversion, the legacy mirror without loads), `SelectSurfaceLoad` × 3, `DeleteSurfaceLoad` × 2, `SetDrainField` × 9 (+ unknown), `SelectDrain` × 3, `DeleteDrain` × 2, `SetWorkspace`, `CopyCurrentRegionsToCustom`, `SetSelectedRegionMaterial` × 2, `SetSelectedRegionCoarseness` × 3, `SetUseCustomRegions` × 3, `DeleteSelectedRegion` × 2, `Clear` × 6 (`load`, `draft` × 2, `customRegions`, `walls`, `drains`, `terrain`), `RunSearch` (the no-Worker guard). After every step: no exception / same message, `S.stage6.bishop` deep-equal + key order, `S.stage6.ui`, `progress.message`, `#stage6Area` innerHTML byte-identical (≈ 47–60 k chars), cache keys, rAF errors, alerts; plus the number of `Date.now()` / `Math.random()` calls over the walk (identical → no id consumer appeared or vanished) and eight assertions that the walk did what its labels say (two `wall_` ids, `load-1` over 10–14 m, a `drain_` id and the seepage workspace, the rejected drain's message, `region_` ids, the added polygon, the split, 16 SetWallField steps producing distinct states except the rejected ones) |
| (d) the package standalone | 43 | `defaults()` == `stage6Defaults().bishop` (key order); `ensure()` run **without the shell** (the package's merge + `env = { rawMaxDepth, hardeningSoilUi:false, deformationQuantityIds }`) on a copy of every pre-ensure state of (b) — 13 states — equals the controller's bishop block and is idempotent; the three un-wired "add" operations replayed on a copy of the pre-step state with the very `now` / `random` values the controller consumed (`addWall` × 2, `createDrainFromVertices` with the cached model — plus the rejected drain, `addCustomRegion` with `normalizeRegionPolygon(draft)`) give the same walls / drains / regions, selection and workspace as the pointer / `FinishDraft` path; `stage6/apps/bishop-state.js` and the registry entry hand out the package's function objects; `entityId` with `{ now: 1000, random: 0.5 }` → `wall_rs_i`; 30 named steps; `defaults()` returns fresh objects; the operations on a minimal state (`setWallField` classes, `setWallMaterialField` flags and rejections, `selectWall` opening the structures panel, `deleteWall`, the surface-load and region operations) |
| (e) `tests/golden/node/bishop/cpt.*` | 29 | for the 7 Stage 6 profile fixtures the bishop state is **seeded from the package** (`defaults()` + `ensure()`), the suite's terrain assigned, `setStage6App('bishop')` → `cpt.<fx>.model.json`, `.materials.json`, `.search.json` (`analyzeBishopSearch`, reduced grid), `.run-handler.json` recomputed through `normalize` + `stableJson` and compared byte for byte with the 28 files on disk (+ the file set) |

Result: **1 110 passed, 0 failed**; ≈ 3.5 min wall-clock (two Vite loads, 15 fixture imports, 7 in-process
searches). `package.json` line for the main session (not added here):

```json
"verify:seepslope-state": "node scripts/verify_seepslope_state.mjs",
```

(Needs the Vite dev dependency and a reachable base ref, like the other `verify_*` movers; CI on a PR branch
with `--base origin/main`, or `--against` a committed `--snapshot`.)

## 5. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — before (ff54aab) | 2 086 PASS / 0 FAIL / 0 NEW / 0 MISSING, 62 s |
| `npm run golden:check` — after the move | 2 086 / 0 / 0 / 0, 60 s (`bishop` 71, `seepage` 41, `deformation` 37, `stage6-shared` 15, `report` 22, `project-io` 22 … all bit-identical) |
| `npm run golden:check` — final tree (verifier + report in place) | 2 086 / 0 / 0 / 0, 65 s |
| `node scripts/verify_stage6_shell.mjs` | 100 / 100 |
| `node scripts/verify_seepslope_state.mjs` | 1 110 / 1 110 |
| `npm run verify:core` | handlers OK (180 published, legacyApi 167), core 18/18, model-params 188/188; **stops at `verify:classification-layers` (259/260)** — pre-existing on integration-r, see §6.4; every step after it run individually: load 45/45, export-report 57/57, bearing 519, pile 586, settlement-dewatering-beam 2 260, project-section-tuning 208, nen6740, stratigraphy, import-review, project-io, scia-db4, qc-only, retaining, wasm, bishop-phase-a (6 fixtures) — all exit 0 |
| `npm run build` | `✔ done`, exit 0 |
| `npm run check` | 490 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `seepslope/**` |
| `GOLDEN_PORT=5699 GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs --grep seep-slope` | **1 passed** (23.5 s): 13 steps, state + DOM text identical, no visual warning; bishop search 976 ms, seepage 278 ms, deformation 1 106 ms |

The journey ran against a dev server started from the worktree with a scratch config under the session
scratchpad (report 19 §5: `server.fs.allow` += the real `node_modules` path, the `**/.claude/**` watcher
ignore dropped, a `node_modules` symlink next to the config so `@sveltejs/kit/vite` resolves), on port 5699;
Playwright's `reuseExistingServer` picked it up.

## 6. Findings

1. **Dead legacy branches under the shell's merge.** `stage6/state.js ensure()` merges the defaults into
   the state *before* the bishop migration, and `merge` fills every `null` / `undefined` leaf. So a saved
   session that lacks a key never reaches the migration's "missing key" branches: `spencer.momentTolerance ??
   FfTolerance` sees the default 0.001 (the v2 `FfTolerance` / `FfBracketLow` / `FfBracketHigh` keys are never
   read), `typeof safetyFinalizationMode === 'string'` is always true (the "missing → legacy-bracket" branch
   is dead), `meshTargetAreaAuto == null` is never true (the "manual 0.5 m² means auto" detection is dead),
   and `analysisDepth == null` only fires for the literal empty string (the `bottomMargin` migration is
   reachable through `''` alone — which the field setter never stores). The verifier's legacy fixtures
   document this (the v1 block uses `analysisDepth: ''` to reach the branch, and asserts the *default*
   tolerances). Kept verbatim — the pure move — and worth either deleting the dead branches or running the
   bishop migration before the merge as a behaviour commit with a golden case (the `stage6-shared`
   `ensure.legacy-v0.5.2` case would move).
2. **`stage6BishopUpdateHoverDom` needs `canvas.parentElement`** (the tooltip is positioned in the wrapper):
   under the Tier-B stub every pointer click on a region / load / wall throws before the draw path. The
   verifier gives the canvas stub a wrapper; the golden `bishop` suite never clicks, so it never saw it.
   The same holds for `setPointerCapture`. Step 9e's pointer module should take the wrapper as an input.
3. The wall creation of the canvas pointer path is **duplicated** (`CommitDrawPoint` 7621-7641 and
   `CompleteCurrentActionAt` 7696-7716, byte-identical) — `walls.addWall` is the single replacement for
   step 9e; likewise `regions.addCustomRegion` for the `region` branch of `FinishDraft`. Both are proven
   against the controller path by (d) but not wired here (outside the state regions).
4. **Pre-existing `verify:core` failure**: `verify:classification-layers` 259/260 — "metric tiles … are the
   runClass markup" expects six `<div class="met">` tiles, and `classification/panel.js` has none since PR 10's
   restyle (8501cc1, `style(stage1-5)`); the file is untouched by this PR (`git diff integration-r --name-only`
   = the four files of §0). The chain stops there, so the later steps were run one by one (§5). The
   verifier's expectation needs the restyle's class name — main session / PR 10 owner.
5. `stage6BishopDeformationQuantityIds` stays a host hook of `ensure()` (`env.deformationQuantityIds`): it
   lives in the deformation-contours region (map §2.11) and its unknown-type fallback reads `S`. Under the
   composed ensure that fallback reads the same block it is validating, so a pure
   `(analysisType, hasHs)` version (the verifier's (d) uses one) is equivalent — step 9b/9d moves it into
   `seepslope/deformation/contours.js` and the hook goes.
6. `stage6/state.js` still forwards `ctx.migrateSurfaceLoadsShape` into `env` (now `undefined`; the package
   ignores it) — one line to drop in the shell (outside this PR's file set).
7. `stage6BishopSetSelectedRegion` and `stage6BishopPassiveSideLabel` have no caller in the controller nor
   in an HTML string (map §2.11 lists both); kept as a façade / an alias, the package has the functions.
8. `verify_stage6_shell.mjs` (a)/(b) now compare the base controller **with the working tree's package** for
   the bishop block (the base imports `stage6/apps/bishop-state.js`, a re-export since this PR): it stays
   100/100 and is still a strict check of the shell, but the bishop-schema half of its evidence comes from
   this PR's verifier (`MOVED_SIBLINGS` materialise the base's own schema files).
9. The state-operation walk consumed exactly the same number of `Date.now()` / `Math.random()` calls in both
   controllers (checked) — the only clock / PRNG consumers on these paths are the three id generators, so
   the `{ now, random }` injection changed nothing observable.

## 7. Follow-ups (not in this pure move)

1. Finding 1 — the dead migration branches: a behaviour commit (delete, or migrate-before-merge) with a
   golden case in `stage6-shared`.
2. Step 9b (`model/sync-soil-model.js`, `model/invalidate.js`): the remaining `S` readers around the state
   operations are the invalidators and `stage6BishopSyncSoilModel` / `CurrentModel` (the `model` hooks of
   `createDrainFromVertices` / `copyCurrentRegionsToCustom` / `setDrainField`'s re-validation); `env.
   deformationQuantityIds` moves with the deformation contours (finding 5).
3. Step 9e: replace the two inline wall-creation blocks with `addWall`, the `region` branch of `FinishDraft`
   with `addCustomRegion`, and give the pointer module the canvas wrapper (finding 2).
4. `stage6/state.js`: drop `migrateSurfaceLoadsShape` from `ctx` / `env` (finding 6); `verify:seepslope-state`
   into `verify:core` (needs the base ref or a committed snapshot); fix `verify_classification_layers`
   (finding 4).
5. Step 9f (panels): the readers `effectiveSurfaceLoadQ` / `surfaceLoadSummary` / `activeSurfaceLoads` /
   `wallMaterialPresetKey` / `drainGatingLabel` / `resultWallLabel` are the panels' view-model inputs — they
   already take the `bishop` block, so the panel modules can import them directly.
