# 11 — PR 8 `refactor(export, report): pure text builders + Stage 7 payload with explicit deps`

Base c989770 (`integration-r` = PR 4/5/6/9 + the verify:core wiring), strangler step 4 of
`01-monolith-map.md` §6.2 (PLAN §2 row 8). Executed by a Fable agent in an isolated worktree. File set:
`src/lib/cpt-app/legacy-controller.js`, new `src/lib/cpt-app/export/**` (4 files), new
`src/lib/cpt-app/report/**` (6 new files + `report-svg.js` moved in as `report/svg.js`), new
`scripts/verify_export_report.mjs`, this report. `package.json`, `tests/`, `scripts/golden/**`,
`report-storage.js`, the report routes and the Svelte templates untouched.

One commit, one pure move: `npm run golden:check` 1 619 / 0 / 0 / 0 before and after — no golden updated,
no `tests/golden/CHANGELOG.md` entry. No behaviour-change commit was necessary.

## 0. Findings on the brief and the map

1. **The Stage 7 payload reads no retaining-wall state.** The brief lists a "retaining structural derivation"
   among the closure reads of `buildStage7Payload`; neither the payload nor the goldens (`report/*.json`
   `stage6.available` = bearing, settlement, dewatering, beam, pile) contain a `retwall` annex — the
   retaining note has its own storage (`retaining-note:*`). Nothing to pass in `deps` for it.
2. `stage7BishopPayload` called `stage6BishopSelectedResult()` (bishop region, reads `S`) for `selected`
   and computed the identical clamp inline for `selectedIndex`
   (`Math.min(Math.max(bishop.selectedResult||0,0), results.length-1)` over the same `allResults` array,
   `results.length ≥ 1` guaranteed by the early return). The pure version uses `results[selectedIndex]`
   — no dep needed; equivalence is by inspection and the annex is exercised by the verifier §2.
3. `ensureStage6State()` ran twice per payload build (top of `buildStage7Payload`, again inside
   `stage7DeformationPayload`). Both calls are kept through `deps.ensureStage6State` at the old positions
   (idempotent normalisation; the verifier locks the call order `ensure → workingLayers → ensure`).
4. `report-svg.js` imported `./soil-styles` extension-less, which made it impossible to load under plain
   Node (the Tier-A half of the verifier). It moved to `report/svg.js` with `'../soil-styles.js'` — its only
   importer was the controller (the report routes import `report-storage.js`, which stays where it is:
   the golden suite `scripts/golden/suites/report.mjs` and two Svelte routes import it and are outside
   this PR's file set).
5. `integration-r` advanced to 78a2e02 (PR 11, Stage 6 shell) while this PR was in progress; see §6.

## 1. What moved (verbatim bodies; only the closure reads renamed)

Old line numbers are those of c989770. A scratch script brace-matched every moved function in the old
controller against the new modules: **24/24 helper bodies and the 6 builder bodies are identical after the
rename list below** (the CSV header string is lifted into `LAYERS_CSV_HEADER`; the goldens prove it equal).

### `export/` (text builders `(cpt, ctx) → text`, `ctx` = `cptModelCtx(cpt)` by default)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `exportCSV` 15619-15640, text half | `export/csv.js` → `buildLayersCsv(cpt, ctx)`, `layersCsvFilename(cpt)`, `LAYERS_CSV_HEADER`, `NO_LAYERS_MESSAGE` | `S.` → `cpt.`; `hsParams(l)`/`khParams(l)` → `(l, ctx)`; the `alphaMethod`/`stiffMethod` columns print `ctx.*` (= `cpt.*` for the default ctx — the columns must match the h values the ctx produced) | wrapper: guard + alert, builder, `<a download>` click (same MIME `text/csv;charset=utf-8`, same `encodeURIComponent` data URL, same file name) |
| `safeMaterialToken`, `plaxisDrainageType`, `plaxisDisplayName`, `plaxisCommandValue`, `buildPlaxisSoilmatCommand`, `msToMday` 15642-15679 | `export/plaxis-commands.js` → same names | none | not imported (only the builders use them) |
| `exportPlaxisCommands` 15681-15756, text half + the nu′/drainage check | `plaxis-commands.js` → `buildPlaxisCommandsText(cpt, ctx)`, `plaxisNuDrainageConflicts(cpt, ctx)`, `plaxisNuDrainageAlertMessage(conflicts)`, `plaxisCptId(cpt)`, `plaxisCommandsFilename(cpt)` | `S.` → `cpt.`; `hsParams/khParams` get `ctx`; the alert text is a function of the conflict list | wrapper: guard → text → conflicts → alert → download, the old order |
| `findLayerForDepth` 15758-15765, `simulatedLayerFs` 15772-15774, `layerFsIsSynthetic` 15776-15779, `formatPlaxisCoord` 15781-15786 | `export/plaxis-cpt.js` → same names | `findLayerForDepth(layers, z)` (was `S.layers`), `simulatedLayerFs(layer, assumedRf)` (was `assumedRfValue()`) | not imported |
| `exportPlaxisCpt` 15788-15828, rows + text half | `plaxis-cpt.js` → `simulatedCptRows(cpt, ctx)`, `buildPlaxisCptText(cpt, ctx) → text \| null`, `plaxisCptFilename(cpt)`, `NO_LAYER_MODEL_MESSAGE`, `NO_SIMULATED_ROWS_MESSAGE` | `S.` → `cpt.`; `assumedRfValue()` → `ctx.assumedRf` (same normalised value); "no rows" → `null` instead of the alert | wrapper: guard, builder, `null` → alert, download |
| — | `export/index.js` | re-exports the package surface (24 names) | the controller imports 11 of them |

### `report/` (Stage 7 payload)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `safeClone` 15830-15832 | `report/clone.js` → `safeClone` | none | imported back (the four `stage7Capture*` functions that stay use it) |
| `stage7MethodLabel`, `stage7ParamMethodLabel`, `stage7AlphaMethodLabel`, `stage7StiffMethodLabel` 15834-15848 | `report/payload.js` → same names | none | deleted (no caller left) |
| `stage7WtSourceLabel`, `stage7ElevSourceLabel` 15850-15856 | `payload.js` → `(cpt)` | `S.` → `cpt.` | deleted |
| `stage7LayerWarnings` 15858-15886 | `payload.js` → `stage7LayerWarnings(cpt, catalogue = CAT)` | `S.layers` → `cpt.layers`; `CAT.find` → `catalogue.find` (default = the module `CAT`); `compatLevel` from `layers/` | deleted |
| `stage7TuningPayload` 15888-15925 | `payload.js` → `(cpt)` | `S.` → `cpt.` | deleted |
| `stage7WorkingLayerPayload` 15927-15979 | `payload.js` → `(cpt, layer, index, deps)` | `hsParams/khParams` → `deps.hsParams/khParams`; `S.` → `cpt.` | deleted |
| `stage7BishopPayload` 15981-16062 | `report/payload-seepslope.js` → `(cpt, deps)` | `S.` → `cpt.`; `stage6BishopResultMethodLabel` → `deps.seepslope.resultMethodLabel`; `selected = results[selectedIndex]` (§0.2) | deleted |
| `stage7SeepagePayload` 16064-16258 | `payload-seepslope.js` → `(cpt, deps)` | `S.` → `cpt.`; the four Seep/Slope helpers → `deps.seepslope.*`; `normalizeWallMaterial`/`wallMaterialSourceLabel`/`seepageSourceLabel`/`drainTotalLength`/`wallEndpoints` imported from `seepage/` and `wall-geometry.js` as before | deleted |
| `stage7DeformationPayload` 16264-16319 | `payload-seepslope.js` → `(cpt, deps)` | `ensureStage6State()` → `deps.ensureStage6State()`; `stage7CaptureBishopWorkspaceView('deformation')` → `deps.captureBishopWorkspaceView('deformation')` — under the same "manual view first" conditional | deleted |
| `stage7Stage6Payload` 16495-16574 | `report/payload-stage6.js` → `(cpt, workingLayers, deps)` | `S.` → `cpt.`; the two automatic captures (`'stability'`, `'seepage'`) → `deps.captureBishopWorkspaceView`, called **only when the annex exists and no manual capture is stored** (the old conditional, verbatim) | deleted |
| `buildStage7Payload` 16576-16707 | `payload.js` → `buildStage7Payload(project, cpt, deps) → payload \| null`, `STAGE7_GUARD_MESSAGE` | `PROJECT.name/phase` → `project.*`; `S.` → `cpt.`; `ensureStage6State()`/`stage6WorkingLayers()` → `deps.*`; `cptHasFs/cptHasRf/assumedRfValue` → the pure `classification/` functions over `cpt`; `__APP_VERSION__` → `deps.appVersion` (default: the same `typeof` expression); the guard `alert` → `return null`; `arrMax` (1012, still used by the Stage 1 charts) and the one-line `stage6MaxDepth` are local copies | wrapper: guard + alert, then `buildStage7PayloadPure(PROJECT, S, stage7ControllerDeps())` |
| — (new) | `report/deps.js` → `stage7Deps(cpt, over)`, `seepslopeDeps(over)` | the explicit deps, see below | `stage7ControllerDeps()` builds them from the controller's own functions |
| `report-svg.js` (whole file) | `report/svg.js` | `import … from './soil-styles'` → `'../soil-styles.js'` | `import { buildLayerColumnSvgMarkup, buildLayerPreviewSvgMarkup } from './report/svg.js'` (same position) |
| — | `report/index.js` | re-exports the package surface (20 names) | the controller imports `STAGE7_GUARD_MESSAGE`, `safeClone`, `buildStage7Payload as buildStage7PayloadPure` |

Not moved (deliberately, per the brief — step 9g): `stage7CaptureCanvasImage`, `stage7CaptureWorkspaceView` **H**,
`stage7ClearWorkspaceCapture` **H**, `stage7CaptureBishopWorkspaceView` (switches `S.stage6.app` /
`bishop.workspace`, re-renders, draws, restores — map §3.4 #10), `openStage7Report` **H** (localStorage +
`window.open`) and `stage6BishopHandleHashChange`. The Seep/Slope helpers `stage6BishopResultMethodLabel`,
`stage6BishopSeepageEdgeLabel`, `stage6BishopSeepageBcTypeLabel`, `stage6BishopDrainGatingLabel`,
`stage6BishopResolvedSeepageMeshTargetArea` (the last one is a chain through the terrain polyline / domain
area) stay in the bishop region and reach the payload through `deps.seepslope`.

### The deps (`report/deps.js`, `stage7Deps(cpt, over)` — idempotent, every field optional)

| Field | Was (closure) | Default | Controller passes |
|---|---|---|---|
| `hsParams(layer)`, `khParams(layer)` | `hsParams(l)` / `khParams(l)` over `S` | `model-params` pure with `cptModelCtx(cpt)` | its wrappers `hsParams`, `khParams` |
| `workingLayers()` | `stage6WorkingLayers()` | `workingLayers(cpt)` | `stage6WorkingLayers` |
| `ensureStage6State()` | `ensureStage6State()` (mutates `S.stage6`) | no-op | `ensureStage6State` |
| `captureBishopWorkspaceView(ws)` | `stage7CaptureBishopWorkspaceView(ws)` (mutates UI state) | `() => null` (no canvas) | `stage7CaptureBishopWorkspaceView` |
| `appVersion` | `__APP_VERSION__` (Vite define) | the monolith's `typeof` expression (`'0.5.x'` without the define) | — (default) |
| `seepslope.{resultMethodLabel, seepageEdgeLabel, seepageBcTypeLabel, drainGatingLabel, resolvedSeepageMeshTargetArea}` | the five bishop-region helpers | **none** — a thrower naming the missing dep (only reached when a bishop / seepage annex exists; the report goldens never do) | the five controller functions |

`generatedAt` is still `new Date().toISOString()` inside the pure builder (the payload's own timestamp, masked
by the goldens). `console.error` in the seepage fallback branch is kept.

## 2. The wrappers after the move

```js
function exportCSV(){
  if(!S.layers.length){alert(NO_LAYERS_MESSAGE);return;}
  const csv=buildLayersCsv(S, modelCtx());
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download=layersCsvFilename(S);
  a.click();
}
function exportPlaxisCommands(){
  if(!S.layers.length){ alert(NO_LAYERS_MESSAGE); return; }
  const txt=buildPlaxisCommandsText(S, modelCtx());
  const nuDrainageConflicts=plaxisNuDrainageConflicts(S, modelCtx());
  if(nuDrainageConflicts.length){ alert(plaxisNuDrainageAlertMessage(nuDrainageConflicts)); }
  … data:text/plain download, plaxisCommandsFilename(S)
}
function exportPlaxisCpt(){
  if(!S.layers.length || !S.data.length){ alert(NO_LAYER_MODEL_MESSAGE); return; }
  const txt=buildPlaxisCptText(S, modelCtx());
  if(txt==null){ alert(NO_SIMULATED_ROWS_MESSAGE); return; }
  … data:text/plain download, plaxisCptFilename(S)
}
function stage7ControllerDeps(){
  return { hsParams, khParams, workingLayers:stage6WorkingLayers, ensureStage6State,
    captureBishopWorkspaceView:stage7CaptureBishopWorkspaceView,
    seepslope:{ resultMethodLabel:stage6BishopResultMethodLabel, seepageEdgeLabel:stage6BishopSeepageEdgeLabel,
      seepageBcTypeLabel:stage6BishopSeepageBcTypeLabel, drainGatingLabel:stage6BishopDrainGatingLabel,
      resolvedSeepageMeshTargetArea:stage6BishopResolvedSeepageMeshTargetArea } };
}
function buildStage7Payload(){
  if(!S.layers.length || !S.data.length){ alert(STAGE7_GUARD_MESSAGE); return null; }
  return buildStage7PayloadPure(PROJECT, S, stage7ControllerDeps());
}
```

`modelCtx()` is the PR 5 wrapper (`cptModelCtx(S)`), so the builders compute the same `hsParams/khParams` the
old bodies got from the controller wrappers. `openStage7Report` and the captures are byte-identical.

## 3. Controller diff

| | lines |
|---|---|
| before (c989770) | 16 914 |
| after | **16 096** (net **−818**) |
| after the rebase onto 78a2e02 (PR 11: 15 883) | **15 065** (same −818) |

`git diff --stat`: `legacy-controller.js | 946 (64 insertions, 882 deletions)` in exactly four hunks: the
import blocks (+19, directly after `} from './load/index.js';`, before the `model-params` block — the
PR 6 and PR 9 verifiers' import-order checks still hold), the `report-svg` import path, the unused
`simulatedLayerFsValue` import dropped, and the export/report region (15616-16707 → 3 export wrappers +
the STAGE 7 header + `stage7ControllerDeps` + the `buildStage7Payload` wrapper; the four capture functions
and `openStage7Report` untouched in between). `legacyApi` is untouched and still exports **167** names
(`verify:handlers`: 180 published).

New packages: `export/` 313 lines (csv 47, plaxis-commands 140, plaxis-cpt 99, index 27); `report/` 694 new
lines (payload 329, payload-seepslope 372, payload-stage6 99, deps 61, index 33, clone 12) + `svg.js` 212
moved. Every module: SPDX header, `// @ts-nocheck`, header comment naming source + old line range, `.js`
imports (plain-Node loadable — the verifier's pure part needs no Vite), no `document`/`window`/`alert`/
`localStorage`, no `S`/`PROJECT`.

## 4. `scripts/verify_export_report.mjs` — 57 checks, exit 0 (`--pure-only` 37)

| Part | What |
|---|---|
| §1 export/ unit (pure) | `safeMaterialToken` (NFKD, brackets/commas, whitespace, fallback), `plaxisDrainageType` (lh/kh/leemhoudend, Sand/Gravel), `plaxisDisplayName`/`plaxisCommandValue` (−0, NaN, ∞, quotes)/`buildPlaxisSoilmatCommand`/`msToMday`, `findLayerForDepth` half-open intervals + last-layer inclusive bottom, `layerFsIsSynthetic`, `formatPlaxisCoord` (−0, 1e-9, trailing zeros); `buildLayersCsv` on a two-layer state (header, TAW, empty avgRf cell, hs/kh columns against `model-params`, no elev → empty TAW, ctx override prints the method it derived with, file names); `buildPlaxisCommandsText` (4 CRLF lines, MC line reconstructed from `hsParams/khParams`, cohesion floor, names); conflicts + alert wording; `simulatedCptRows` (readings below the last layer dropped, synthetic fs through classification-core with the ctx assumed Rf, measured layers unchanged), `buildPlaxisCptText` (X/Y/Z, the note counts synthetic layers, `null` when no row falls in a layer, null coordinates → 0); the three guard messages |
| §2 report/ unit (pure, stub deps) | `safeClone`; every label helper; `stage7LayerWarnings` (bad/adj/ok via `compatLevel`, the qc-only note, `(overridden)`/empty/unknown subtypes skipped, catalogue argument); `stage7TuningPayload` mapping; `stage7WorkingLayerPayload` (deps drive hs/hydraulic, tuning flags, defaults = model-params); `stage7Deps` defaults/overrides/idempotence/throwers; `stage7BishopPayload` (clamp above and below, keepBest slice, labels via deps, clones, `bishop_only` default, missing dep throws); `stage7SeepagePayload` (null without setup, a reject reason counts as setup; counts, geometry, walls via `wallEndpoints`, drains via `drainTotalLength`, materials, BCs incl. the unmatched-edge labels, mesh incl. the `Map` drain edges, result; the degraded fallback on an assembly failure with `console.error`; a helper the catch branch needs propagates); `stage7DeformationPayload` (manual view wins — no capture; auto capture via deps with `source: 'auto'`; null capture → no annex; ensure called); `stage7Stage6Payload` (annexes by cache thresholds and their order, cloned layers, functions dropped, **capture asked for only with results and no manual view**, seepage capture, null → no `view`); `buildStage7Payload` (guards, `ensure → workingLayers → ensure`, project/cpt/metadata/replication/summary/chartInputs/rows/layers/visuals against the svg builders, `stage6` null without annexes, the input state untouched, `isStage7Payload` true) |
| §3 exports goldens are the truth (pure, no Vite) | for each of the **9** profile fixtures the CPT state is rebuilt from the upstream goldens (`node/import/<fx>.json` rows — digest asserted equal to the one in the project snapshot — + `node/exports/<fx>.project.json` layers/methods/meta); `<fx>.layers.csv`, `.plaxis.txt`, `.plaxis-alerts.json`, `.plaxis-cpt.txt` and the three names of `.filenames.json` are compared with the golden **file text** (`normalizeText` / `stableJson(normalize())`, what the runner writes); `no-layers.alerts.json` from the guard constants; `report/no-layers.json` from the pure guard; every file on disk covered (55) |
| §4 report goldens are the truth (Tier-B loader) | for each of the **7** Stage 6 fixtures the report suite's chain (sb260 → `changeSubtype` → tuning + `acceptFit(0)` → five apps rendered) is replayed through the controller to obtain the CPT state; the payload is built by the **pure** `buildStage7Payload({name, phase}, S, {appVersion})` — model-params defaults, no ensure, no capture, the seepslope throwers — and must equal `report/<fx>.json` **bit for bit** (the suite's digests applied for the non-`layered` fixtures) and `.valid.json`; the state is proven untouched (JSON before/after); `api.buildStage7Payload()` (controller deps) deep-equals the pure payload after normalisation; `openStage7Report()` side effects == `.open.json`; `no-layers.json` through the wrapper (alert) and the pure builder (null, silent); every file on disk covered (22) |
| §5 wrappers ⇔ pure (Tier-B) | for every profile fixture (demo included): `exportCSV`/`exportPlaxisCommands`/`exportPlaxisCpt` downloads decoded == the pure text, MIME prefixes, file names, the nu′ alert; the controller's `hsParams/khParams` == pure with `cptModelCtx(S)`; the no-layers guards (three alerts, no download) and the no-rows guard of `exportPlaxisCpt`; the seven names on `legacyApi` |
| §6 extraction complete | 24 moved declarations + the old template fragments absent; the import blocks directly after `load/` and before `model-params/`; the svg import re-pointed; the four wrappers verbatim, `stage7ControllerDeps` wiring, the five kept functions; `legacyApi` = 167 names; the 11 module files with SPDX + `@ts-nocheck`, `.js`-suffixed relative imports, no DOM/alert/S/PROJECT; `report-svg.js` gone, `report-storage.js` and its two route imports in place |

`--pure-only` (no Vite) ≈ 1 s; the full run ≈ 12 s.

## 5. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — before (c989770) | 1 619 PASS / 0 FAIL / 0 NEW / 0 MISSING, 29.7 s, exit 0 |
| `npm run golden:check -- --filter exports` / `report` — right after the move | 55 / 0 and 22 / 0, bit-identical |
| `npm run golden:check` — after (verifier + report in the tree) | 1 619 / 0 / 0 / 0, 28.5 s, exit 0 (no golden touched) |
| `npm run verify:core` | exit 0 — handlers OK (180 published, legacyApi 167), core-helpers 18/18, model-params 188/188, classification-layers 260/260, load 45/45, nen6740, stratigraphy, import-review, project-io, scia-db4, qc-only, retaining (ui PASSED, behaviour 31/31, soil-profile 23/23, sections-plaxis 81/81, request 24/24), wasm, bishop-phase-a 6 fixtures |
| `node scripts/verify_export_report.mjs` | 57/57, exit 0 (`--pure-only` 37/37) |
| `npm run build` | `✓ built in 2.23s`, exit 0 |
| `npm run check` | 420 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `export/**`, `report/**` |

Playwright / dev server not run (pure move; README protocol step 5).

Re-run after the rebase onto 78a2e02 (§6), same tree state otherwise: `golden:check` 1 619 / 0 / 0 / 0
(28.7 s); `verify:core` exit 0 (handlers 180 published / legacyApi 167, 18/18, 188/188, 260/260, 45/45,
the rest green); `verify_export_report.mjs` 57/57; `build` ✓ 2.15 s; `check` 433 files, the same 6
pre-existing errors, 0 warnings.

## 6. Branch state

The work was done on c989770, the `integration-r` tip at the start of the task (commit ff11aec). PR 11
(`78a2e02 refactor(stage6): registry, per-app defaults/ensure, shell render`) was merged into
`integration-r` while this PR was in progress; its nine controller hunks are in the Stage 6 state region
(old 2658-3213) and its import block sits after the `layers/` block, so the two PRs touch disjoint hunks.
The commit was rebased onto 78a2e02 without conflicts (`git rebase 78a2e02`: clean; import order now
`core → load → export → report → model-params → classification → layers → stage6`) and every gate was
re-run on the rebased tree (§5). The commit to merge is the rebased one.

One cross-PR note: PR 11's `scripts/verify_stage6_shell.mjs` loads the **`integration-r` controller as a
sibling file of the working tree** (`--base`, default `integration-r`). Run inside this worktree before
the merge it fails at the base's `import … from './report-svg'` (the file is now `report/svg.js`); once
this commit is on `integration-r` the default base is this controller and the verifier runs as before.
`verify:core` does not include it; no shim at the old path was added (every importer is updated).

## 7. `package.json` line for the main session

```json
"verify:export-report": "node scripts/verify_export_report.mjs",
```

Suggested: add `&& npm run verify:export-report` to `verify:core` (§4-5 need `tests/golden/**` and the Vite
dev dependency — both present in CI; `--pure-only` for a Vite-less run).

## 8. Left in place / follow-ups

1. `stage7Capture*` (canvas capture that switches the Stage 6 app) and `openStage7Report` → `report/capture.js`
   / `report/open.js` in step 9g, when the `seepslope/canvas/draw` modules can render to an offscreen canvas
   without touching `S.stage6.app`. Then `deps.captureBishopWorkspaceView` becomes a pure render.
2. `deps.seepslope.*`: the five label / mesh-area helpers move with `seepslope/` (step 9); the deps object
   shrinks to `{ensureStage6State, captureBishopWorkspaceView}` and the throwers can go.
3. `arrMax` is duplicated (controller 1012 for the Stage 1 charts, `report/payload.js`); it belongs in
   `core/format.js` or `load/raw-charts.js` when the Stage 1 charts move (PLAN row 10).
4. `ensureStage6State` runs twice per payload build (§0.3) — harmless, but the second call (deformation
   annex) can be dropped once the payload is built from a state that is normalised by construction (step 6/9a).
5. The pure `buildStage7Payload` still stamps `generatedAt` itself; a `deps.now` would make the builder fully
   deterministic for a future Tier-A golden of the whole payload.
6. `report-storage.js` (`saveStage7Payload`, `cleanupStage7Payloads`, `isStage7Payload`, …) should move to
   `report/storage.js` together with the two route imports and the golden suite import — main-session file set.
7. The exports suite's `saveProject` download (`<fx>.project.json`, `filenames.project`) is project-io
   territory and is not touched here.
