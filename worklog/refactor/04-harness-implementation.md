# 04 — Characterization harness: implementation report (Node side)

Branch `v0.6.0`, HEAD `462fc50`, 2026-08-29. Implements parts 1, 2, 3, 4-partial (`retaining`,
`project-io`), 8 and 9 of `03-characterization-tests.md`. **No app source was modified** — every
stub lives in the harness. Working tree left uncommitted for review.

Gates run at the end, all green:

| Gate | Result |
|---|---|
| `npm run golden:fixtures` twice | fixtures + `manifest.json` bit-identical (sha256 of all 26 files) |
| `npm run golden:record` then `npm run golden:check` × 2 | 1 619 / 1 619 pass, 0 diffs both runs (≈ 29 s each) |
| mutation test (edited value + extra/missing key in one golden, one stray file) | `FAIL` with 3 diffs, `MISSING` for the stray file, exit 1; `--update --filter <case>` rewrote only that case, exit 0 |
| `npm run verify:retaining` | PASSED (ui verifier, 23/23, 81/81, 24/24) |
| native `g++ … test_native.cpp` | ALL CHECKS PASSED |
| `npm run build` | ✓ built (adapter-static) |

---

## 1. What was built

```
scripts/golden/
├── record.mjs / check.mjs        one runner (lib/runner.mjs), modes record|check; --update, --filter <glob>, --list
├── make-fixtures.mjs             seeded (mulberry32) GEF/CSV/XLSX + project fixtures + manifest.json (sha256)
├── fetch-vendor.mjs              Chart.js 4.4.1 from the URL in +page.svelte:66 → tests/golden/vendor/chart.umd.js
├── wasm-hash.mjs                 sha256 pin of static/wasm/** → tests/golden/wasm.sha256.json (--write | check)
├── lib/
│   ├── prng.mjs                  mulberry32 (+ source string for the browser init script)
│   ├── store.mjs                 paths, stable JSON layout, read/write goldens, .actual mirror, listGoldens, sha256
│   ├── normalize.mjs             the mask list (§2.5) + digest() for known duplicates
│   ├── compare.mjs               structural compare with {rel, abs}, formatDiffs, textDiff
│   ├── gef-writer.mjs            rows → GEF text (COLUMNINFO / MEASUREMENTVAR / ZID / EOH)
│   ├── html-text.mjs             HTML string → innerText-like text (Node stand-in for "DOM text")
│   ├── wasm.mjs                  retaining + deformation module instantiation from static/wasm
│   ├── load-controller.mjs       Tier B: Vite ssrLoadModule + DOM stub, Chart stub, sync rAF, download/alert capture
│   ├── context.mjs               ctx for suites: fixtures, controller (lazy), loadCpt() via the real loadGEF path
│   └── runner.mjs                record/check loop, PASS/FAIL/NEW/MISSING table, timings, exit code
└── suites/                       index.mjs + 15 suites (each exports { name, tolerance, description, cases(ctx) })
tests/golden/
├── README.md, CHANGELOG.md, tolerances.json, wasm.sha256.json, vendor/chart.umd.js
├── fixtures/{cpt,projects,models}/ + manifest.json        (26 files, 1.3 MB)
└── node/<suite>/                                          (1 619 goldens, 22.7 MB — see §4)
package.json   golden:fixtures / golden:record / golden:check / golden:update / golden:wasm-check / verify:core / test:all
.gitignore     tests/golden/.actual/
.github/workflows/ci.yml   node (wasm pin, svelte-check advisory, verify:core, golden:check, changelog guard,
                           .actual artefact) · native (retaining C++ tests) · browser (test:e2e; golden journeys plug in later)
```

### Tier B: the controller under Node — the stub was enough

`load-controller.mjs` follows §2.2 exactly (Vite `createServer({configFile:false, appType:'custom',
server:{middlewareMode:true}}).ssrLoadModule('/src/lib/cpt-app/legacy-controller.js')` +
`initLegacyController()`), with these additions found necessary while running the real chain:

- `document.querySelector(sel)` auto-creates too (`setPhase` does `document.querySelector('.wrap').style`).
- `requestAnimationFrame` runs **synchronously** (errors collected in `rafErrors`, none occurred) so the
  chart/canvas side effects of `renderStage6`, `initCharts`, `selectCpt` are complete and deterministic
  before a snapshot is taken.
- The `Chart` stub keeps the config it was constructed with, so the raw-profile chart configs
  (`buildRawProfileChartConfig`) are locked from `S.charts.qc.config` (§1.2 "raw chart series").
- The import-review overlay is auto-confirmed: `modal.js` appends the overlay to `document.body` and
  binds `[data-ir]` buttons via `querySelectorAll`; the stub hands it stable button objects and clicks
  `apply` one macrotask later. **So `parseGEF`, `parseCsvCpt`, `parseExcelCpt` and `applyParsedCpt` are
  exercised through `loadGEF → importCptFiles` (the real file-input path, with a `FileReader` stub)** —
  the design's "simpler fallback" (inject rows into `S.data`) was not needed.
- `getComputedStyle`, `matchMedia`, `ResizeObserver`, `location`, `localStorage`, `URL.createObjectURL`
  (blob capture for `saveProject`), `Worker = undefined`, `__APP_VERSION__` from package.json.

Controller load time: ≈ 0.85 s; the whole Stage 1–7 chain on one fixture ≈ 1 s. `happy-dom` was **not**
added; nothing in the exercised paths needed it.

### Fixtures (§3) — as specified, with the deviations in §2

`cpt/`: `demo-anonymous.gef` (the exact `loadDemo()` bands under `mulberry32(20260829)`; the `import`
suite proves `gefEqualsSeededLoadDemo: true`, 1 080 rows), `layered.gef` (6 layers, u2 column),
`clay-only`, `sand-only`, `wt-at-surface`, `short` (94 rows after the `qc<0.02` skip), `qc-only`,
`trailing-qc-only`, `kpa-units`, `corrected-depth`, `layered.csv`, `layered-comma.csv`, `layered.xlsx`
(Data + Header sheets via the `xlsx` dependency, `Props` dates fixed → deterministic bytes),
`wt-above-surface.state.json` (state injection `wt:-0.5`).
`projects/`: `single-layered` (Stages 2–6 through the controller: subtype edit, accepted fit, bearing /
pile / settlement configured, retwall soldierpile + one override), `multi-3cpt` (3 CPTs at 30 m, elevation
offsets 0 / +0.4 / −0.3, correlated via `setPhase('correlation')`, one `renameUnit`), `legacy-v0.5.2`
(post-0.5.2 keys removed). `models/`: the 9 solver JSONs copied from `scripts/fixtures/`.

---

## 2. Deviations from the design report (and why)

| # | Design | Implemented | Why |
|---|---|---|---|
| D1 | Tier B feeds rows into `S.data` (fallback) or auto-applies the review dialog | Auto-applied dialog through `loadGEF` (real path) — **plus a new `import` suite** | Locks the parsers and `applyParsedCpt` (§1.2) in Node instead of only in the browser tier; the review overlay text is locked too |
| D2 | `stage6Defaults` / `ensureStage6State` / app switch listed under §1.7 without a suite | New `stage6-shared` suite | §1.7 observables needed a home; `report` was the wrong place |
| D3 | Profile step not specified (demo 0.02 m, short 0.02 m) | 0.05 m for layered / clay-only / sand-only (360 / 240 / 300 rows) | Golden size (classified rows × 5 methods × fixtures) |
| D4 | Every golden stored in full | `digest()` (`{<digest>, bytes, n}`) for known duplicates: the retaining note's `result/structural/layers`, `cpts[*].data/classified` in project snapshots, the report's row tables + annex analyses for fixtures other than `layered`, branch diagram vectors of the RK-variant retaining results, `ksInfo.profile` in the beam heavy/edge configs and in `computeSubgradeReaction` cases | First recording was **55 MB**; now 22.7 MB. Each digested part is locked in full in the suite that owns it; any change still flips the golden |
| D5 | Stage 6 / report suites over every fixture | `trailing-qc-only` and `wt-above-surface` skipped there (`ctx.fixtures.stage6Names()`) | Their only difference is upstream (locked in import / classification / layers / model); saves 22 % |
| D6 | `legacy-v0.5.2` = trimmed `single-layered` | trimmed `multi-3cpt`; removes `retwall.drivability`, `retwall.vibration`, `deformation.options.useWallInterface`, `assumedRf`, `smartMergeSensitivity`, `stratigraphy.settings.characteristic` | `single-layered` has no stratigraphy, so the `characteristic` trim would have been meaningless |
| D7 | `project-io` with a mirrored `newCptState` (as `verify_project_io.mjs`) | the controller's own `newCptState` (+ a `loaded-via-controller` case through `loadProjectFromFile → afterLoad`) | Locks the real forward-compat merge onto today's defaults and the restore glue (§1.10 "Restore") |
| D8 | `retaining` × "RK scheme 0/2" | `riskScheme 0` (ANB generic + CC3) and `riskScheme 2` (+ material-override factors) as two variants, on two hand-written profiles | Tier A stays independent of Tier B; the grid is 2 profiles × 5 types × 4 variants |
| D9 | `wasm-hash` pins `*.wasm` | pins the Emscripten glue `.js` as well | The glue's memory layout is part of the engine contract |
| D10 | `MASK_KEY_PATTERNS` `/^_/` with a note that `_maxStage` is kept | implemented as `/^_(?!maxStage$)/` | The literal regex would have masked it |
| D11 | 2-space pretty JSON | keys sorted, but arrays of flat rows one element per line and long numeric vectors chunked at ≈ 100 chars | Diffable *and* compact; `JSON.parse` unaffected |
| D12 | classifier grid z 0.5…20 step 0.5 (40 values) | z ∈ {0.5,1,2,4,8,12,16,20}; `assumedRf ∈ {2,5}` only for `rf=null` readings | 28 800 → 2 560 results; assumedRf has no effect when Rf is measured |
| D13 | `test:all` includes `golden:browser` | omitted until `tests/e2e/golden-journey.spec.mjs` exists; CI browser job runs `test:e2e` with a comment | Browser tier is a separate task |
| D14 | `check --update` rewrites failing cases | also writes NEW cases; in record/update mode a no-longer-produced golden is reported as `STALE` (not deleted) | Deleting is the engineer's decision |
| D15 | — | `.actual/` is cleared at the start of an unfiltered check; `--filter` accepts a glob on the suite name or `suite/case` | Keeps the mirror meaningful |

Not built (outside the requested scope, still per the design's build order): Tier A `stratigraphy`,
`report-svg`, `chart-configs` (part 4 remainder), `bishop` / `seepage` / `deformation` (part 5), and the
whole Tier C (part 6/7). `models/` fixtures, `lib/wasm.mjs::deformationModule()`, `prng.mjs`
(`MULBERRY32_SOURCE`) and `tolerances.json` (`iterative`, `browser`) are already in place for them.

---

## 3. Case counts and timing per suite (from the last full `golden:check`, Apple Silicon, Node 25)

| Suite | Tier | Cases | ms |
|---|---|---|---|
| import | B | 86 | 200 |
| classification | B + A | 188 | 3 100 |
| layers | B | 165 | 9 500 |
| model | B | 180 | 5 000 |
| tuning | B | 63 | 1 350 |
| exports | B | 55 | 1 300 |
| stage6-shared | B | 15 | 110 |
| stage6-bearing | B + A | 70 | 1 200 |
| stage6-pile | B + A | 57 | 1 200 |
| stage6-settlement | B | 56 | 1 150 |
| stage6-dewatering | B | 56 | 1 200 |
| stage6-beam | B + A | 63 | 1 500 |
| report | B | 22 | 1 300 |
| retaining | A (WASM) | 521 | 550 |
| project-io | A + B glue | 22 | 190 |
| **total** | | **1 619** | **≈ 29 s** (+ 0.85 s controller load, once) |

`layers` dominates because every fixture is re-classified 5× (smart + simple each) plus the thickness /
sensitivity grid; `model` because `setParamMethod` re-detects layers per combination.

---

## 4. Sizes

| Part | Files | Size |
|---|---|---|
| `fixtures/` | 26 | 1.3 MB (projects 1.0 MB: `saveProject`'s indent-1 layout with all rows, as the app writes it) |
| `vendor/chart.umd.js` | 1 | 0.2 MB |
| `node/` total | 1 619 | 22.7 MB — retaining 5.0, classification 4.8, stage6-beam 2.5, stage6-bearing 2.0, report 1.4, dewatering 1.2, project-io 1.1, import 1.0; the rest < 1 MB each |

The retaining engine result (4 branches × 7 diagram vectors) and the beam sublayer profile (182 ×
12 fields) are the intrinsically large outputs; both are the numbers the canvases draw, so they stay.

---

## 5. Findings while locking (app behaviour documented, not changed)

- **CSV delimiter mis-detection**: `fixtures/cpt/layered-comma.csv` (`;`-separated, comma decimals,
  fs in kPa — a normal Belgian Excel export) is parsed with `,` as delimiter: `detectDelimitedTextSeparator`
  scores the comma decimals as extra columns (`+maxCols*3`), both delimiters find a header row, so `,`
  wins → 341 rows of garbage (`node/import/layered-comma.csv.json`). Bug candidate for a separate,
  golden-updating commit.
- **`#COLUMNVOID` is ignored by `parseGEF`**: a void value such as `-9999` is a valid number for the
  row filter, so a GEF that marks missing fs/Rf with the void value would classify with Rf = 20 %. The
  `trailing-qc-only` fixture therefore writes the trailing rows with fewer columns (which the parser does
  handle, `:1405-1409`). Worth a look before the parser extraction.
- `exportPlaxisCommands` raises a nu′/Undrained-A alert on most profiles; locked as `exports/*.plaxis-alerts.json`.
- `stage6-pile`: `renderStage6` also writes `stage6Cache.pileCanvas` (viewport state, `ensurePileCanvasState`);
  only `stage6Cache.pile` is locked, as designed.
- `openStage7Report` / `openNote` storage keys and report URLs contain `Date.now()` — masked (`<key>`,
  URL `key=<key>`).

---

## 6. What remains for the browser tier (part 6/7) and the other Tier A suites

Ready to reuse: `tests/golden/vendor/chart.umd.js` (route the CDN URL to it), `lib/prng.mjs`
(`MULBERRY32_SOURCE` for `page.addInitScript`), `tolerances.json#browser`, `lib/normalize.mjs` +
`lib/compare.mjs` (same masks/tolerances for `state.json`), `fixtures/cpt/*.gef|csv|xlsx` and
`fixtures/projects/*.madep.json` for `setInputFiles`, `lib/html-text.mjs` (if DOM text is captured as
HTML), the `.actual/` convention and the CHANGELOG guard in CI.

To build: `scripts/golden/lib/journey.mjs`, `lib/browser-capture.js` (`window.__golden`),
`lib/selectors.mjs`, `tests/e2e/golden-journey.spec.mjs` + `tests/e2e/golden.config.mjs`, the
`golden:browser[:record|:update]` scripts (then add `golden:browser` to `test:all` and to the CI browser
job), the Linux PNG baseline policy, `bisect-journey.sh`, the PR template checklist. Note for the
save-load journey: `saveProject`'s file name carries a `YYYYMMDD-HHMM` stamp (masked here with
`_<stamp>.madep.json`), and the frozen `Date` in the init script makes it constant in the browser.

Tier A still to add before the corresponding extractions: `stratigraphy`, `report-svg`, `chart-configs`;
`bishop`, `seepage`, `deformation` (models already under `fixtures/models/`).

---

## 7. Files touched outside `scripts/golden/`, `tests/golden/`, `.github/`

`package.json` (7 scripts added, none changed), `.gitignore` (`tests/golden/.actual/`), this report.
`playwright.config.mjs`, `worklog/PROGRESS.md` and `tests/visual/` were already modified/untracked in the
working tree by another task and were not touched.
