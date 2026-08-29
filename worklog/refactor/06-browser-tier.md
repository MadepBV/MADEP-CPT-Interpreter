# 06 — Characterization harness: browser tier (Tier C)

Branch `v0.6.0`, HEAD `7ccca23`, 2026-08-29. Implements part 6 of `03-characterization-tests.md`
(§2.3, §4.5, §4.6 browser parts) on top of the Node side from `04-harness-implementation.md`.
**No app source was modified**; `package.json`, `.gitignore`, `playwright.config.mjs` and `.github/**`
were left alone (the script / CI lines are listed in §7 for the main session). Nothing committed.

Gates run at the end:

| Gate | Result |
|---|---|
| `GOLDEN_MODE=record` both journeys | 63 + 64 steps, 249 files, 17.3 MB (7.5 MB of it PNG) |
| check mode **twice** | green both times, 0 JSON / text diffs, 0 visual warnings (same machine) |
| mutation test (edited number in `01-loaded.state.json`, edited word in `03-layers.dom.txt`, stray file) | `FAIL .active.wt: 1.8 → 1.7 (Δrel 5.56e-2)`, `FAIL line 34: …`, `MISSING zz-stray.dom.txt`, test fails |
| `npm run golden:check` (Node tier) after the `normalize.mjs` change | 1 619 / 1 619 pass |
| `npx playwright test tests/e2e/golden-journey.spec.mjs --project=e2e` (default config) | 2 skipped — the spec only runs under the `golden` project |

---

## 1. What was built

```
scripts/golden/lib/
├── browser-capture.js      injected (context.addInitScript) — window.__golden.{captureState, domText,
│                           localStorageByPrefix, live, evalPredicate, waitState, nextFrame}
└── journey.mjs             Node side: Journey class (step / stepPage / download / localStorage / json /
                            text / waitState / nextFrame / finish), modes record|check|update, digest-if-
                            unchanged, TEXT_MASKS, .actual mirror, MISSING check, visual policy
tests/e2e/
├── golden.config.mjs       dedicated Playwright config: port 5299 (vite dev --strictPort, cwd = repo root),
│                           reuseExistingServer, 1 worker, retries 0, nl-BE / Europe/Brussels, 1500×950,
│                           snapshotDir tests/golden/browser, updateSnapshots all|none by GOLDEN_MODE
└── golden-journey.spec.mjs demo-journey + gef-import-journey (shared stages2to7)
tests/golden/
├── browser/demo-journey/          123 files   9.1 MB
├── browser/gef-import-journey/    126 files   8.2 MB
├── tolerances.json                browser.maxDiffPixelRatio 0.02 added (screenshots only)
├── README.md                      "Browser journeys" section, masks, scripts
└── CHANGELOG.md                   baseline entry extended
scripts/golden/lib/normalize.mjs   MASK_SUBSTRING_PATTERNS (see §4)
```

### `browser-capture.js`

- `captureState()` → `{ stage, phase, activeCptIdx, project, active, cache }`. `project` is
  `PROJECT` with the active CPT replaced by `{"<active>": id}` (it is captured once, under `active`,
  minus `stage6Cache`); `cache` is the active CPT's `stage6Cache` (the Stage 6 analyses written by
  `renderStage6`). The JSON replacer drops `charts` / `chartsReady` (what `project-io/snapshot.js:21`
  strips) and functions, turns typed arrays into arrays, `Map`/`Set` into objects/arrays and
  NaN / ±Infinity into strings — so the Node normaliser sees the same shapes as in the Node tier.
- `domText(selectors)` → `## <selector>` header + `innerText` with whitespace collapsed per line,
  empty lines dropped; `<absent>` when nothing matches (so a vanished container is a diff, not silence).
- `evalPredicate(src)` evaluates a predicate *source string* against live (unstripped) references
  `{ project, active, cache, stage }`; the Node side passes `pred.toString()` through
  `page.waitForFunction` (polling 50 ms). `waitState(fn, ms)` is the in-page promise variant.
- `nextFrame()` = two `requestAnimationFrame`s (chart builds are scheduled in rAF, `renderStage6`).

### `journey.mjs`

- Goldens live at `tests/golden/browser/<journey>/<step>.{state.json,dom.txt,png}`; extra JSON /
  text goldens use the same prefix (`10-note.payload.json`, `11-exportcsv.csv`, `11-saveproject.json`,
  `12-report.payload.json`, `11-dialogs.json`).
- `record` writes; `check` compares (`compare.mjs` with `tolerances.browser`, `textDiff` for text),
  writes the normalised actual to `tests/golden/.actual/browser/<journey>/` (cleared per journey at
  start) and fails at `finish()` with `FAIL/NEW/MISSING` + the first 25 diffs per file; `update`
  rewrites only the failing/new files. Page errors and console errors are collected on every page
  (main + report tabs) and asserted empty at `finish()` (both journeys: none).
- Digest-if-unchanged (`DIGEST_IF_UNCHANGED`): `active.data`, `active.classified`, `active.tuning`,
  `retwall.result`, `retwall.drivability.result`, `bishop.results` (+ seepage/deformation mesh/result
  for later journeys), `project.cpts[*].data/classified`, every `cache.*` entry. At the step where the
  part changes it is stored in full; at every later step where it is byte-identical it becomes
  `{"<unchanged-since>": "<step>", "<digest>": …, bytes, n}`. Any change still flips the golden; the
  readable diff lives at the owning step. Without this the demo journey was ≈ 3× larger.
- Downloads: `download(name, dl)` — `.json` → normalised `{ filename, snapshot }` with explicit digest
  paths (`saveProject`: rows, classified, tuning, retwall result, bishop results — all locked in
  state.json steps); other files verbatim under a `# <filename>` header.
- Screenshots: `expect(page).toHaveScreenshot([journey, step.png], { mask: canvases, maxDiffPixelRatio })`.
  `GOLDEN_VISUAL=off|soft|strict` — `soft` (default) reports a mismatch as a "visual" line in the
  journey summary and never fails; `strict` fails (intended for CI where the baseline was recorded).
  Missing PNG in check mode = soft mismatch too (config uses `updateSnapshots: 'none'` there).

---

## 2. Journeys and steps

Both journeys share `stages2to7()`; only the load differs.

| # | Step(s) | Action | Wait |
|---|---|---|---|
| 00 | `00-import-review` (gef only) | `setInputFiles('#fi', fixtures/cpt/layered.gef)` | `.import-review-overlay` visible; dom of the overlay |
| 01 | `01-loaded` | demo: click "Load demo — anonymous profile" under seeded `Math.random`; gef: click `[data-ir="apply"]` | `active.data.length > 0 && active.chartsReady === true` |
| 02 | `02-classified`, `02-classified-{robertson,robertson2016,cur3,nen6740}` | `goS(1); runClass()` then `selM(m)`; back to `sb260` | rAF ×2 |
| 03/04 | `03-layers`, `04-layers-edited` | `goS(2)`; first alternative option of `#lb select[data-i="1"]` via `selectOption` (real `changeSubtype` path) | rAF |
| 05 | `05-model-default`, `05-model-alphaA-stiffA` | `goS(3)`; `setAlphaMethod('A'); setStiffMethod('A')` | rAF |
| 06 | `06-tuning`, `06-tuning-accepted0` | `goS(4); runTuning()`; `acceptFit(0)` | rAF |
| 07 | `07-<app>`, `07-<app>-<field>-<value>` for bearing (`bearing.B` 2), pile (`pile.zToe` 12), settlement (`settlement.Gk` 200), dewatering (`dewatering.targetWt` 4), beam (`beam.L` 8) | `goS(5); setStage6App(app)`; `setStage6Field` | rAF |
| 08 | `08-retwall-<type>` (state + `#retwallInputs/#retwallSummary/#retwallResultTabs` + png) and `08-retwall-<type>-<tab>` (`#retwallResultBody` text only) for cantilever, gravity, sheetpile, anchored, soldierpile | `setStage6App('retwall'); retwallSetType(t)`; click every `#retwallResultTabs button` | `retwall.status === 'done'` (type switch resets to `idle` synchronously, so `done` is this type's) |
| 09 | `09-drivability` | `retwallRunDrivability()` on the soldier-pile wall | `retwall.drivability.status !== 'running'` |
| 10 | `10-note.payload.json`, `10-note` (dom `.report-shell` + png) | `retwallOpenNote()` → popup `/report/retaining` | `page` event, networkidle, `.report-shell` |
| 07b | `07-bishop-model`, `07-bishop-stability` | terrain `[{0,4},{8,4},{20,0}]`, entry 1–5, exit 13–19, `keepBest 3` by state; `setStage6App('bishop')`; `stage6BishopRunSearch()` (Worker) | `bishop.progress.running === false && results`, 60 s budget (skips with a note if exceeded — it takes ≈ 1 s) |
| 11 | `11-exportcsv.csv`, `11-exportplaxiscommands.txt`, `11-exportplaxiscpt.txt`, `11-saveproject.json`, `11-dialogs.json` | `exportCSV / exportPlaxisCommands / exportPlaxisCpt / saveProject` → `waitForEvent('download')`; alerts auto-accepted and locked | download event |
| 12 | `12-report.payload.json`, `12-report` (dom `.report-shell` + png) | `buildStage7Payload()`; `openStage7Report()` → popup `/report/stage7` | `page` event, networkidle, `.report-shell canvas` present |
| 13 | `13-final` | closing state | — |

Seepage and deformation were **not** included (they need boundary-edge selection / surface loads
and a WASM solver in a Worker — the dedicated `seep-slope-journey`, §6). The Bishop stability search
is in because it completes in ≈ 1 s.

---

## 3. Timings (Apple Silicon, Chromium via Playwright 1.62.1, Vite dev server already warm)

| Run | demo-journey | gef-import-journey | total wall time |
|---|---|---|---|
| record | 17.5 s (63 steps) | 14.5 s (64 steps) | 35 s |
| check #1 | 13.9 s | 11.0 s | 27.5 s |
| check #2 | 14.4 s | 10.7 s | 27.6 s |

Per step: load 1.3 s (charts), report tabs 0.9–1.3 s, Bishop search ≈ 0.9–1.1 s, every other step
10–110 ms. First cold start of `vite dev` on port 5299 adds ≈ 5–10 s (webServer timeout 60 s).

---

## 4. Determinism — what leaked and how it was masked

Three record → check cycles were needed:

| Leak | Where | Fix (never a tolerance) |
|---|---|---|
| `bishop.progress.message` = `"Search + Spencer check complete in 943 ms."` (varies per run) | `stage6BishopCompleteMessage` writes `timing.totalMs` into a state string that is saved with the project and rendered in the Stage 6 banner | `normalize.mjs`: new `MASK_SUBSTRING_PATTERNS` `[/\b\d+(?:\.\d+)? ms\b/g, '<ms> ms']` applied inside strings that do not match a whole-string mask. Node tier unaffected (no Node golden contains such a string; `golden:check` 1 619/1 619 after the change). The same regex is in `journey.mjs` `TEXT_MASKS` for DOM text (`RUNTIME <ms> ms` in the report annex). |
| raw byte count of the `saveProject` download | harness-added `bytes` field — the raw file contains the unmasked `savedAt` and the timing digits | field removed from the download golden (`{ filename, snapshot }`) |
| nl-BE date-time in report headers (`fmtDateTime(generatedAt)`, `/report/stage7` and `/report/retaining`) | the journey clock is shifted to `2026-01-01T00:00:00Z` but still advances (Chart.js animations poll `Date.now()`; a frozen clock would stall them), so the minute depends on run speed | `TEXT_MASKS`: `1 jan 2026 01:00` → `<datetime>` (DOM text only; `generatedAt` in state is already `<masked>`) |
| `saveProject` file name `CPT_Project_20260101-0100.madep.json` | `fileStamp(new Date())` | `TEXT_MASKS`: `_YYYYMMDD-HHMM` → `_<stamp>` |

Pre-empted by the setup (no leak observed): `loadDemo()` rows (seeded `Math.random`), entity ids
and storage keys (masked by `normalize.mjs`), `generatedAt` / `capturedAt` (masked keys), Chart.js
animation frames (vendored copy served with `Chart.defaults.animation = false` appended by the
route — the vendored file itself is unchanged), analytics script (`page.route` → empty JS, so no
`net::ERR_FAILED` console error), locale / timezone (config), viewport (config).

Everything else (classification, layers, HS parameters, tuning, the five Stage 6 analyses, the
retaining WASM results incl. all diagram vectors, drivability, the Bishop search results, exports,
the project snapshot, the Stage 7 payload, all DOM text) was byte-identical across the runs.

Caveat worth knowing before the restyle: `innerText` reflects CSS `text-transform` (the button
reads `LOAD DEMO — ANONYMOUS PROFILE` in `01-loaded.dom.txt`) and layout visibility. A restyle that
changes casing or hides a container will show up in `dom.txt`; that is a golden update with a
CHANGELOG entry, per design §5.3.

---

## 5. Files touched (all harness / docs)

New: `scripts/golden/lib/browser-capture.js`, `scripts/golden/lib/journey.mjs`,
`tests/e2e/golden.config.mjs`, `tests/e2e/golden-journey.spec.mjs`, `tests/golden/browser/**` (249 files),
this report. Modified: `scripts/golden/lib/normalize.mjs` (substring mask), `tests/golden/tolerances.json`
(`browser.maxDiffPixelRatio`), `tests/golden/README.md`, `tests/golden/CHANGELOG.md`.

Not touched: `src/**`, `package.json`, `.gitignore`, `playwright.config.mjs`, `.github/**`,
`tests/visual/**`, `src/lib/styles/**`. Note for the owner of `playwright.config.mjs`: its `e2e`
project (`testDir: tests/e2e`) now lists the golden spec, which self-skips outside the `golden`
project (`test.skip(testInfo.project.name !== 'golden')`); a `testIgnore: /golden-journey/` there
would hide it from `npm run test:e2e` entirely.

---

## 6. What remains

- **`seep-slope-journey`** (design §2.3): after `07-bishop-model`, `stage6BishopSetWorkspace('seepage')`,
  pick `side-left` / `side-right` edges from `cache.bishopSeepageBoundary`, `stage6BishopSelectSeepageBoundary`,
  `stage6BishopSetSeepageBcType('head')`, `…SetSeepageBcHead`, `stage6BishopRunSeepage()` → wait
  `seepage.status === 'success'`; then a surface load + `stage6BishopRunDeformation()` → wait
  `deformation.status === 'success'` (small `meshTargetArea`); `stage7CaptureWorkspaceView`. The
  `DIGEST_IF_UNCHANGED` entries for `seepage.mesh/result` and `deformation.mesh/result` are already
  there; the waits are the predicates listed above. Budget the deformation run (WASM in a Worker).
- **`multi-cpt-journey`**: `setInputFiles('#fi', [layered, sand-only, clay-only])` (sequential review
  dialogs), `setCptCoord` / `setElev`, `setPhase('correlation')` → `#stratPanel` + `PROJECT.stratigraphy`,
  SOILIN report tab (`soilin-report:*` via `localStorageByPrefix`), `setPhase('section')` →
  `#sectionSvg.innerHTML`, csv/plaxis/dxf downloads, db4 → sha256 (`store.sha256Hex`).
- **`save-load-journey`**: run to `07-*`, `saveProject` download, `page.reload()`,
  `setInputFiles('#projFileInput', downloadPath)`, then `02-restored` must equal `01-saved` after
  normalisation (`savedAt`, `activeStage`).
- Linux PNG baseline on CI (`GOLDEN_VISUAL=strict` there once recorded on the runner);
  `bisect-journey.sh` (two worktrees, two ports) from design §5.2.
- Wire `golden:browser` into `test:all` and the CI browser job (§7).

---

## 7. Lines for `package.json` and `.github/workflows/ci.yml` (owned by the main session)

`package.json` scripts:

```json
"golden:browser":        "playwright test --config tests/e2e/golden.config.mjs",
"golden:browser:record": "GOLDEN_MODE=record playwright test --config tests/e2e/golden.config.mjs",
"golden:browser:update": "GOLDEN_MODE=update playwright test --config tests/e2e/golden.config.mjs"
```

(and `npm run golden:browser` appended to `test:all`.)

CI `browser` job steps (after `npx playwright install --with-deps chromium`):

```yaml
      - run: npm run golden:browser
        env: { GOLDEN_VISUAL: soft }        # switch to strict once a Linux PNG baseline is recorded on the runner
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright
          path: |
            test-results
            tests/golden/.actual
```
