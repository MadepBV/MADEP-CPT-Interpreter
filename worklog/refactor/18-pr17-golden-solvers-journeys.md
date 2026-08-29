# 18 — PR 17: golden solver suites and the remaining journeys

Branch `v0.6.0`, base `07f0645` (integration-r), 2026-08-29. Implements parts 4-remainder, 5 and 7 of
`03-characterization-tests.md` on top of `04-harness-implementation.md` (Node tier) and
`06-browser-tier.md` (Tier C). **No app source was modified** (`src/**` untouched); everything lives
under `scripts/golden/**`, `tests/golden/**`, `tests/e2e/golden-journey.spec.mjs`,
`tests/e2e/golden.config.mjs` and this report.

Gates run at the end (Apple Silicon, Node 25, Chromium via Playwright 1.62.1, dev server on port 5399):

| Gate | Result |
|---|---|
| `npm run golden:fixtures` twice | 39 fixture files + `manifest.json` bit-identical (sha256 over the set) |
| `npm run golden:check` | 2 086 / 2 086 pass — three consecutive runs with the final normaliser, 0 diffs (62–68 s) |
| `golden:browser` (5 journeys) | green twice in a row, 0 JSON / text diffs, 0 visual warnings on the second pass (53–57 s + server) |
| existing 1 619 Node goldens | untouched (no FAIL before or after the new suites and the normaliser additions) |

---

## 1. Tier A — the solver suites (`scripts/golden/suites/`)

| Suite | Cases | ms (full run) | Size | What is locked |
|---|---|---|---|---|
| `bishop` | 71 | 3 300 | 1.9 MB | `fixtures/models/bishop-*.json` (6): the `buildBishopModelFromStageLayers` model, `analyzeBishopSearch` on the region source (critical circle with slices in full; shortlist scalars with slice tables digested; `criticalOverall/ThroughWall/BelowWall` marked `<same as critical>` when identical), the legacy-band pair of the parity script, `importBishopMaterialsFromLayers` × {characteristic, da1_1, da1_2} and the re-import identity rules (same layer keeps an override, shifted layer does not, strength-set change refreshes), builder guards; per CPT profile fixture (5): the app-built model + materials (`setStage6App('bishop')` → `stage6BishopCurrentModel`, with the HS mirror), a reduced-grid search (4 × 4 × 6, keepBest 3, Spencer recheck 2), the no-Worker guard of `stage6BishopRunSearch`. Tolerance `iterative`; `timing` masked; rejection counts and iteration counts exact. Each fixture search 36–235 ms. |
| `seepage` | 41 | 800 | 2.6 MB | `fixtures/models/seepage-*.json` (8): `analyzeSeepageModel` mesh (nodes, elements, elementCell, boundary faces, constraint edges; per-cell geometry digested with count + area sum + per-region count), result (heads, element heads / dry mask / wet fraction, element gradients as rows, flow lines, equipotentials, phreatic segments, drains, boundary gradients, scalars, `solver`, `solverStats` = `result.timing` without the ms fields → outer / linear / active-set iteration counts exact), 12-point sampler grid (`sampleSeepageHead`, `sampleSeepageFlowState`), outer boundary + `seepageGeometryHash`, guard errors, `makeBoundaryCondition`; the app-built `layered` model with side heads through `stage6BishopSelectSeepageBoundary` / `SetSeepageBcType` / `SetSeepageBcHead` / `SetField('seepage.options.meshTargetArea')` and the no-Worker guard. Each model 16–85 ms. |
| `deformation` | 37 | 24 500–27 400 | 4.8 MB | `fixtures/models/deformation-*.json`: 12 grid points (table below) — nodal displacements (total / initial / service), terrain settlement profile, summaries, `solver` (load-step history, convergence phases; the c-phi safety curve as flat rows, `safetyResult.curve` digested), `wallResults`, per-element state as flat rows `[index, region, σ'xx, σ'yy, τxy, s1, s3, η_mc, εxx, εyy, γxy, u, ε_p, yield surface]` + `elementResults` digest, mesh connectivity (cells digested), 12-point `sampleDeformationState` grid, guard errors (HS on js-cpu, safety with linear-elastic, no load, no regions). WASM injected through `__setDeformationWasmModuleForTests` from `static/wasm/deformation` (pinned by `wasm.sha256.json`). |
| `stratigraphy` | 67 | 40–60 | 0.9 MB | `multi-3cpt` and its first two CPTs: profiles + projection, correlation (default / minMatch 0.3 / 0.7), unit properties (wmean / min), section polygons, store `run`/`derived` and the fixture's saved (renamed) result, manual split / merge, staleness after a layer edit, settings; per state: units CSV, PLAXIS commands, section DXF, export names, SOILIN payload (+ validator), db4 payload text and container SHA-256 (Node zlib deflate); Doorsnede markup (`buildSectionSvg`, vex 2 / 4 / stale) + `sectionSvgDocument`; single-CPT / no-elevation guards; with the controller's Stage 4 `hsParams`/`khParams` as `layerParamsFor` (unit params + PLAXIS export with values). |
| `report-svg` | 48 | 1 400–1 600 | 0.4 MB | `buildLayerColumnSvgMarkup` (with / without water table) and `buildLayerPreviewSvgMarkup` (Rf / fs / qc-only) on every profile fixture + the empty placeholders. |
| `chart-configs` | 203 | 2 800 | 2.2 MB | per Stage 6 fixture: the Stage 1 raw charts (`S.charts.*.config`), the Stage 5 tuning charts (`buildTuningRegressionChartConfig` / `buildTuningDepthChartConfig` on the `data-*` attributes tuning/panel.js writes — the stub has no `querySelectorAll`, so the builders are called exactly as tuning/charts.js does; the parsed attributes are locked as `.tuning.blocks`), the Stage 6 canvases after `setStage6App` (`stage6BearingChart`, 4 pile, 3 settlement, 4 dewatering, 2 beam → `canvas._chartRef.config`; a 40 ms wait covers the bearing chart's 20 ms debounce), `buildLineProbeChartConfig` on a synthetic probe. Functions dropped by the normaliser. |
| **total new** | **467** | ≈ 33 s | 12.8 MB | Node tier now 2 086 cases, 35.5 MB, ≈ 65 s |

Deformation grid (each < 10 s on Apple Silicon; the js-cpu path is the in-process JS solver, wasm-cpu the
pinned engine):

| model | backend | material | element | area | type | wall time |
|---|---|---|---|---|---|---|
| base | js-cpu | linear-elastic | t3 | 0.5 | deformation | 0.2 s |
| base | wasm-cpu | linear-elastic | t3 | 0.5 | deformation | 0.1 s |
| base | js-cpu | mc-plastic | t3 | 0.5 | deformation | 2.0 s |
| base | wasm-cpu | mc-plastic | t3 | 0.5 | deformation | 1.4 s |
| base | wasm-cpu | linear-elastic | t6 | 2.0 | deformation | 0.4 s |
| base | wasm-cpu | mc-plastic | t6 | 6.0 | deformation | 2.0 s |
| sloped | js-cpu | linear-elastic | t3 | 1.0 | deformation | 0.3 s |
| sloped | wasm-cpu | mc-plastic | t3 | 1.0 | deformation | 4.8 s |
| sloped | wasm-cpu | linear-elastic | t6 | 1.0 | deformation | 0.4 s |
| sloped | wasm-cpu | mc-plastic | t3 | 5.0 | safety-cphi | 6.5 s |
| hs-drained-footing | wasm-cpu | hardening-soil | t3 | 0.75 | deformation | 6.5 s |
| hs-oc-excavation | wasm-cpu | hardening-soil | t3 | 1.0 | deformation | 0.9 s |

Left out for the 10 s rule (measured, documented, model fixtures kept): sloped mc-plastic on js-cpu (27 s at
area 3.0, 51 s at 1.0), base safety-cphi (17–24 s at every mesh — the flat section has no mechanism, so the
σ_Msf search runs far), base mc-plastic t6 at area 2.0 (26 s), `hs-softclay-embankment` (19–34 s at every mesh
with the fixture's 200 kPa; 8.8 s only at half load — not a fixture constant).

### Model fixtures (`scripts/golden/lib/solver-models.mjs` → `make-fixtures.mjs` → `fixtures/models/`)

Pure functions of constants: `seepageBaseFixedModel` / `seepageLayeredIterateModel`
(verify_seepage_phase_2.mjs:194-306), `seepageDrainWallModel` + `seepageDrain` (verify_seepage_drains_walls.mjs:20-95),
`deformationBaseModel` / `deformationSlopedModel` (verify_deformation_phase_1.mjs:165-268), `hsBenchmarkModel`
(the `loose_sand` / `stiff_clay_oc` bundles of verify_hs_phase_8.mjs:75-118 on the geometry / loading constants
of `scripts/fixtures/hs_*.json`, as a Bishop-style section with a uniform strip load — the phase-8 harness feeds
a hand-built rectangular grid to the raw WASM entry point, which is not the app's path; the excavation case runs
as the same |−10| kPa in loading because `analyzeDeformationModel` needs a positive load).

Deviation: the two **wall** seepage models use a confined, fixed-phreatic layout (left head 10, right head 8,
wall tip lifted to 0.5 m). The verify script's equal-head layout (10 m on every edge) only checks legacy/explicit
material parity and always ends on the 5 s `maxRuntimeMs` limit (8 900 outer iterations, `terminationReason:
"time-limit"`) — a clock-dependent result that cannot be a golden.

---

## 2. Tier C — the three journeys (`tests/e2e/golden-journey.spec.mjs`)

| Journey | Steps | Files | Size | record | check #1 | check #2 |
|---|---|---|---|---|---|---|
| `seep-slope-journey` | 13 (+ `13-report-annexes.json`) | 35 | 5.0 MB | 20.9 s | 20.3 s | 22.2 s |
| `multi-cpt-journey` | 10 (+ `05-soilin.payload`, 4 downloads, db4 hash, `07-section.svg`, dialogs) | 31 | 2.5 MB | 4.7 s | 4.0 s | 4.2 s |
| `save-load-journey` | 7 (+ `01-saveproject.json`, `02-restored-vs-saved.json`, dialogs) | 17 | 1.6 MB | 3.8 s | 3.3 s | 3.4 s |

Per-step timings of `seep-slope-journey` (check): 01 bishop-empty 1 235 ms (import + charts), 02 terrain 138,
03 zones 166, 04 phreatic 151, 05 wall 99, 06 drain 72, 07 model 12, 08 stability 937 (Bishop + Spencer search in
the Worker ≈ 0.93 s), 09 seepage-bcs 148, 10 seepage 260 (solve ≈ 0.22 s), 11 deformation-setup 113,
12 deformation 1 001 (**the deformation run completes in ≈ 0.95 s** — mc-plastic, T3, 2.0 m², wasm-cpu, with
the wall's beam + interface — well inside the 90 s budget; the fallback that stops and locks the run as stopped
never triggered), 13 final 124.

### What the seep-slope journey drives, and how

The canvas tools are driven by **real pointer events** on `#stage6BishopCanvas`
(`page.locator(...).click({ position })` at the screen position of a world point through the app's own
viewport transform — the inverse of `stage6BishopScreenToWorld`; the app snaps to its 0.5 m grid; a right
click is `stage6BishopCompleteCurrentActionAt`): terrain (3 clicks + right-click), entry / exit zones (2 clicks
each), phreatic line, wall (head on the terrain, tip below), drain (2 clicks; the tool switches to the seepage
workspace), seepage boundary edges (BC tool click on the side mid-points), surface load (load tool). The panel
setters are the window handlers: `stage6BishopSetTool`, `SetWallField` (passive side, interface R_inter),
`SetDrainField` (head, gating), `SetSeepageBcType/Head`, `SetField` (mesh target areas, runtime limit,
element type), `SetSurfaceLoadField` (q), `SetWorkspace`, the three `Run*` handlers,
`stage7CaptureWorkspaceView` × 3, `buildStage7Payload`. Determinism lesson: every commit re-renders the app
and re-binds the canvas handlers in the postRender frame, so `clickWorld` waits two animation frames after
each click (the first attempt lost the phreatic clicks).

Drain gating is set to `always`: with the default `when-saturated` gating the free-surface iteration on this
section never stabilises its active set and ends on the 10 s runtime limit (`"Seepage stopped after 10.11 s at
the configured runtime limit"`) — clock-dependent. With `always` + a 60 s limit the solve converges on its
flow-error criterion in 0.22 s (`terminationReason: "flow-error"`, `activeSetStable: true`).

### `save-load-journey` — round-trip identity

`02-restored-vs-saved.json` is computed in the spec with the harness' own `normalize` + `compare`
(`pure` tolerance) over `project`, `active`, `stage`, `phase`, `activeCptIdx` of the captured state before the
download and after loading it through `#projFileInput` on a fresh page, plus the text of `#lb`, `#ma`,
`#tuningArea`, `#stage6Area` after walking Stages 3–6 (the panels render when their stage is visited). Result
locked: **`stateDiffs: []`, all four panels identical** — the save/load path is the identity after
normalisation (`stage6.ui`, the `<details>` bookkeeping, is render state and excluded per design §1.12).
`03-legacy-loaded` locks the forward-compat merge of `legacy-v0.5.2` loaded over work (confirm auto-accepted;
the three dialogs in `04-dialogs.json`).

### `multi-cpt-journey`

Three GEF files in one picker action (sequential review dialogs), coordinates / elevations through
`setCptCoord` / `setElev`, classification per CPT, `setPhase('correlation')` (auto-correlation → 3 units),
rename through the `[data-rename]` input (`fill` + Tab → `change` → `store.renameUnit`), SOILIN tab +
`soilin-report:*` payload, CSV / PLAXIS / DXF downloads as text, db4 as size + SHA-256 (1 015 bytes; the deflate
comes from Chromium's `CompressionStream` — a different Chromium may change the bytes, the payload text is
locked in the Node `stratigraphy` suite), Doorsnede `#sectionSvg` markup + `exportSectionSVG` download.

---

## 3. Determinism — what leaked and how it was masked (never a tolerance)

| Leak | Where | Fix |
|---|---|---|
| `wall-material-wall_<Date36>_<rand>` | `stage6BishopDefaultWallMaterial` id = `wall-material-${wallId}` | `normalize.mjs` whole-string mask `<id>` |
| drain ids inside `seepage.geometryHash` (a JSON text) | `seepageGeometryHash` | substring mask `<id>` for `wall_/drain_/region_` ids in longer strings |
| drain ids as object **keys** of `mesh.drainNodeIdsByDrain`, `drainEdgesByDrain`, `drainNodeArcLengthByNode` | seepage mesh | keys matching an id pattern are renamed `<id:n>` in insertion order (`ID_KEY_PATTERNS`) |
| `"Seepage solved in 0.22 s with flow-rate error …"` | `stage6BishopSeepageCompleteMessage` (`stage6SecondsLabelFromMs`) | substring mask `<n> s` → `<s> s`, excluding units (`0.5 s/m` in the drivability notes — the first version of the mask flipped 6 retaining goldens, refined with a `(?!\/)` guard) |
| seepage run ending on the runtime limit | see above | drain gating `always`, limit 60 s — a determinism fix in the journey, not a mask |
| 56 MB seep-slope journey | `cache.bishopModel` embeds the seepage / deformation state objects; `deformation.result.elementResults` (2.6 MB), `result.mesh` = `deformation.mesh`, `mesh.cells`, contour derivatives | `DIGEST_ALWAYS` in `journey.mjs` → 5 MB; the numbers are locked in full in the Node suites |

`golden:check` (Node) was rerun after every normaliser change: 2 086 / 2 086 each time (the `<n> s` mask needed
the refinement above; nothing else touched an existing golden).

---

## 4. Other findings (app behaviour documented, not changed)

- **Browser baseline drift at HEAD**: `demo-journey` / `gef-import-journey` failed 34 `state.json` each on
  `07f0645` before any change here — a9b5d7f added the drivability defaults (`drivability.push`,
  `vibrator.sheet.massSource`) and updated the Node goldens, but the browser goldens were not re-recorded; the
  Phase 2a restyle (f30d251) also moved every PNG. Both journeys were brought up to date with
  `GOLDEN_MODE=update` (110 files: 68 state / 43 PNG; no DOM text changed) — see `tests/golden/CHANGELOG.md`.
- **Project fixtures drift**: `make-fixtures.mjs` at HEAD regenerated `projects/single-layered` and
  `projects/multi-3cpt` with the same drivability defaults (the committed files predate a9b5d7f). Regenerated
  and committed; `golden:check` unchanged (`applyProjectSnapshot` + `ensureStage6State` merge the same
  defaults), `manifest.json` follows.
- **`project-io` is order-dependent when run alone**: `npm run golden:check -- --filter project-io` reports 3
  `loaded-via-controller.dom.txt` mismatches (`#ma` empty) because the model panel is only rendered once Stage 4
  has been visited in the process; in the full run an earlier suite has done so. Pre-existing; the full run is
  the contract. Worth a `goS(3)` in that suite's own setup at some point.
- `bishop-retaining_wall` (fixture): the search returns **no** admissible circle (all trials rejected as
  "stable by wall alone", "arc above terrain", …) — locked as such.
- `deformation` `sloped` safety run: `loadFactorCommitted 1`, σ_Msf bracket 1.05–1.10 (`safetyTrialHistory`
  locked).
- Worktree note: with `node_modules` symlinked to the main checkout, `vite dev` refuses to serve
  `@sveltejs/kit/src/runtime/client/entry.js` ("outside of Vite serving allow list") — the app never boots and
  every journey hangs on the import-review overlay. The recordings here ran a dev server started with a scratch
  config adding the real `node_modules` path to `server.fs.allow` (outside the repo); CI has a real
  `node_modules` and needs nothing.

---

## 5. CI / npm changes needed (owned by the main session — nothing changed here)

`package.json`: **no new script is required.** `golden:check` picks the six suites up from `suites/index.mjs`;
`golden:browser` / `golden:browser:record` / `golden:browser:update` run the five journeys from the one spec;
`test:all` already chains `golden:check` and `golden:browser`. Optional: `"golden:browser:bisect": "GOLDEN_PORT=5399 playwright test --config tests/e2e/golden.config.mjs"`
for the side-by-side worktree run (`GOLDEN_PORT` / `--port` are read by `tests/e2e/golden.config.mjs`; the
default 5299 is unchanged).

`.github/workflows/ci.yml`: no step to add. Budget: the Node job's `golden:check` grows from ≈ 30 s to ≈ 65 s
(the `deformation` suite is 25 s of it — WASM + the js-cpu MC solve); the browser job's `golden:browser` from
≈ 30 s to ≈ 60 s. Keep `GOLDEN_VISUAL: soft` until a Linux PNG baseline is recorded on the runner (the 43
re-recorded PNGs of demo / gef and the 21 new ones are macOS renders). The changelog guard is satisfied
(`tests/golden/CHANGELOG.md` has the entry).

---

## 6. Files

New: `scripts/golden/lib/solver-models.mjs`, `scripts/golden/suites/{bishop,seepage,deformation,stratigraphy,report-svg,chart-configs}.mjs`,
`tests/golden/fixtures/models/{seepage-*,deformation-*}.json` (13), `tests/golden/node/{bishop,seepage,deformation,stratigraphy,report-svg,chart-configs}/` (467),
`tests/golden/browser/{seep-slope-journey,multi-cpt-journey,save-load-journey}/` (83), this report.
Modified: `scripts/golden/make-fixtures.mjs`, `scripts/golden/suites/index.mjs`, `scripts/golden/lib/normalize.mjs`,
`scripts/golden/lib/journey.mjs`, `tests/e2e/golden-journey.spec.mjs`, `tests/e2e/golden.config.mjs`,
`tests/golden/{README,CHANGELOG}.md`, `tests/golden/fixtures/{manifest.json,projects/*.madep.json}`,
`tests/golden/browser/{demo-journey,gef-import-journey}/` (110).
Untouched: `src/**`, `package.json`, `.github/**`, `playwright.config.mjs`, `static/**`.
