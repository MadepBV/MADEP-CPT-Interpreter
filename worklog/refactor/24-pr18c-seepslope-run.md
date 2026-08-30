# 24 — PR 18c `refactor/fix(seepslope): run orchestration and worker adapters`

Base `integration-r` @ f5b4a9b (v0.6.0 tip; controller 11 498 lines, PR 18a + 18b merged), the third
Seep / Slope sub-step of `01-monolith-map.md` §6.2 step 9 (PLAN §2 row 18c; map §2.11 group
"Workers & runs" 7582-8178, §5 engine rows 1-3, §3.4 **#8**, §6.1 row `seepslope/` `runs/*`).
Executed by a Fable agent in an isolated worktree, **two commits**:

| | hash | |
|---|---|---|
| 1 | `dd4a6cb` | `refactor(seepslope): run orchestration and worker adapters` — the pure move |
| 2 | `e29e01a` | `fix(seepslope): a rejected run clears its own progress.running` — the behaviour fix |

File set: `src/lib/cpt-app/legacy-controller.js` (the bishop run / worker region and the four run
message builders only), new `src/lib/cpt-app/seepslope/run/**` (6 files), new
`scripts/verify_seepslope_run.mjs`, this report. `package.json`, `tests/**`, `scripts/golden/**`,
the three worker entry files, `seepslope/state/**`, `seepslope/model/**`, every render function,
every HTML string and every class attribute untouched; nothing under `retaining/`.

`npm run golden:check` **2 086 / 0 / 0 / 0** before, after commit 1 and after commit 2 — **no
golden changed, no `tests/golden/CHANGELOG.md` entry**, including for the behaviour fix (the Node
suites have no `Worker`, so a run is never in flight there and the fix is invisible to them *by
construction*). What proves the fix is the verifier's `running-fix` group, which drives the three
runs through a recording Worker stub. `legacyApi` **167 names**, unchanged (handler verifier: 180
published, every inline handler resolved).

---

## 1. Commit 1 — what moved

Line numbers are `integration-r` @ f5b4a9b. Every moved body was cut at its `function name(` anchor
and read back against the new module; the only edits inside the bodies are in the "change" column.

| Monolith (old) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| the six module variables 301-306 (`stage6BishopWorker` / `RunId`, `SeepageWorker` / `RunId`, `DeformationWorker` / `RunId`) | `run/workers.js` → `createWorkerAdapter()` (`{worker, runId}` per kind) | the three `new Worker(new URL(…, import.meta.url), {type:'module'})` literals move with them (`DEFAULT_WORKER_FACTORIES`, `../../` paths) | one `const stage6BishopWorkers = seepslopeCreateWorkerAdapter();` |
| `stage6BishopStopSearch` 3846-3856 | `run/search.js` → `stopSearchPatch(bishop, silent)` | the `terminate()` half → `adapter.stop('search', {silent})`; the state writes became a patch | façade: `workers.stop` + `applyRunPatch` |
| `stage6BishopStopSeepage` 3790-3816 | `run/seepage.js` → `stopSeepagePatch(bishop, silent)` + `seepageStopMessage(runId)` | as above; the cooperative `{type:'stop-seepage', runId}` is the adapter's non-silent branch | as above |
| `stage6BishopStopDeformation` 3818-3844 | `run/deformation.js` → `stopDeformationPatch`, `deformationStopMessage` | as above | as above |
| `stage6BishopUpdateProgressDom` 3858-3870 | `run/progress.js` → `searchProgressDom(bishop) → {text, width}` | the two `document.getElementById` writes stay in the host; the computation is pure | façade: two DOM writes |
| `stage6BishopEnsureWorker` 3872-3918 (`onmessage` 3875-3904, `onerror` 3905-3916) | `run/search.js` → `reduceSearchMessage(bishop, payload) → {handled, kind, patch, effects}`, `searchWorkerErrorPatch()`; `run/workers.js` → `adapter.ensure('search', …)` | `S?.stage6?.bishop` → the `bishop` parameter (the host resolves it at message time through a `getState()`-shaped closure); the `payload.runId !== progress.runId` guard became the `handled:false` branch; the three effects (`updateProgressDom`, `drawCanvas`, `renderStage6`) became flags | 10-line façade: `workers.ensure` with `onMessage` / `onError` closures |
| `stage6BishopEnsureSeepageWorker` 3920-3994 | `run/seepage.js` → `reduceSeepageMessage`, `seepageWorkerErrorPatch` | as above; the "auto-enable the head contours after a successful solve" block is four conditional patch keys | as above |
| `stage6BishopEnsureDeformationWorker` 3996-4116 | `run/deformation.js` → `reduceDeformationMessage`, `deformationWorkerErrorPatch`; the 60-line status message 4024-4077 → `run/progress.js deformationCompleteMessage(status, output)` | as above; every derivation of the status message is still evaluated before the branch, as the monolith did | as above |
| `stage6BishopRunSearch` 4118-4176 | `run/search.js` → `prepareSearch`, `buildSearchInput`, `searchRequest`, `buildSearchRequest`, `startSearchPatch`, `searchNoWorkerPatch`, `SEARCH_MESSAGES` | the two pre-flight `return`s became `{ok:false, reject:{reason, message}, patch}`; the `input` literal and the `progress` replacement are unchanged | 23-line façade in the monolith's exact order |
| `stage6BishopRunSeepage` 4178-4245 | `run/seepage.js` → `prepareSeepage` (incl. the `validateDrains(model)` the handler stores), `buildSeepageInputModel`, `seepageRequest`, `buildSeepageRequest`, `startSeepagePatch`, `seepageNoWorkerPatch`, `SEEPAGE_MESSAGES` | the four pre-flight `return`s became the same result shape; `validateDrains` is imported from `seepage/drains.js` (pure, model-only) | 24-line façade |
| `stage6BishopRunDeformation` 4247-4371 (incl. the ~60-key option block 4307-4368) | `run/deformation.js` → `prepareDeformation`, `buildLastWallInputs`, `buildDeformationOptions`, `deformationRequest`, `buildDeformationRequest`, `startDeformationPatch`, `deformationNoWorkerPatch`, `deformationAnalysisType`, `DEFORMATION_MESSAGES` | `stage6BishopActiveSurfaceLoads('deformation')` → `state/surface-loads.js activeSurfaceLoads(bishop, 'deformation')` directly; the option literal is verbatim, comments included | 22-line façade |
| `stage6BishopMethodModeLabel` 4393, `stage6SecondsLabelFromMs` 4397, `stage6SafetyFinalizationStatusFromSolver` 4403, `stage6SeepageFlowErrorLabel` 4637 | `run/progress.js` (same names) | none (`stage6CompactNumber` → the `core/format.js` import) | import aliases |
| `stage6BishopRunningMessage` 4656, `ReadyMessage` 4662, `CompleteMessage` 4669, `SeepageCompleteMessage` 4681 | `run/progress.js` → `runningMessage(bishop)`, `readyMessage(bishop, runReady)`, `completeMessage(result, timing)`, `seepageCompleteMessage(result)` | `S.stage6?.bishop` → the first parameter | the two `S` readers are one-line façades; the two pure ones are import aliases |

Nothing else moved: `stage6BishopSelectResult` / `SelectedResult`, `stage6BishopSyncSeepageState`,
`stage6BishopCurrentSeepageBoundary`, the result HTML, the tool rail, the canvas and
`renderStage6BishopApp` are byte-identical.

### 1.1 Why the four label helpers came along

`methodModeLabel` / `secondsLabelFromMs` / `seepageFlowErrorLabel` /
`safetyFinalizationStatusFromSolver` also have readers in the results and panel regions (step 9f):
the progress line, the run button, the seepage and deformation result cards, the Spencer help
text. They are moved rather than duplicated because **the run is their only writer** — every string
they build lands on `progress.message` / `rejectReason` — and duplicating a formatter between the
package and the controller is exactly the drift a strangler step is supposed to remove. The four
controller names survive as import aliases, so the panel regions are untouched; step 9f will import
them from `seepslope/run/progress.js` (or move them on to a `results/` module) when it takes the
templates.

## 2. The package — `src/lib/cpt-app/seepslope/run/`

| File | Lines | Exports |
|---|---|---|
| `index.js` | 109 | the flat surface below, the `search` / `seepage` / `deformation` / `workers` / `progress` namespaces, and `applyRunPatch` (= `seepslope/model applySoilModelPatch`) |
| `search.js` | 209 | `SEARCH_MESSAGES`, `searchRejection`, `searchRejectionPatch`, `prepareSearch`, `searchNoWorkerPatch`, `buildSearchInput`, `searchRequest`, `buildSearchRequest`, `startSearchPatch`, `reduceSearchMessage`, `searchWorkerErrorPatch`, `stopSearchPatch` |
| `seepage.js` | 239 | `SEEPAGE_MESSAGES`, `SEEPAGE_INTERRUPT_ERROR/MESSAGE`, `seepageRejectionPatch`, `prepareSeepage`, `seepageNoWorkerPatch`, `buildSeepageInputModel`, `seepageRequest`, `buildSeepageRequest`, `startSeepagePatch`, `seepageStopMessage`, `reduceSeepageMessage`, `seepageWorkerErrorPatch`, `stopSeepagePatch` |
| `deformation.js` | 304 | `DEFORMATION_MESSAGES`, `DEFORMATION_INTERRUPT`, `deformationAnalysisType`, `deformationRejectionPatch`, `prepareDeformation`, `deformationNoWorkerPatch`, `buildLastWallInputs`, `buildDeformationOptions`, `deformationRequest`, `buildDeformationRequest`, `startDeformationPatch`, `deformationStopMessage`, `reduceDeformationMessage`, `deformationWorkerErrorPatch`, `stopDeformationPatch` |
| `workers.js` | 153 | `WORKER_KINDS`, `WORKER_STOP_TYPES`, `DEFAULT_WORKER_FACTORIES`, `createWorkerAdapter` |
| `progress.js` | 181 | `methodModeLabel`, `secondsLabelFromMs`, `seepageFlowErrorLabel`, `safetyFinalizationStatusFromSolver`, `runningMessage`, `readyMessage`, `completeMessage`, `seepageCompleteMessage`, `deformationCompleteMessage`, `searchProgressDom` |

1 195 lines. SPDX + `@ts-nocheck`, a header naming the source lines and the contract, `.js`
imports; loads under plain Node. Dependencies outside the package: `core/format.js compactNumber`,
`seepage/drains.js validateDrains`, `seepslope/state` (`sortZone`, `activeSurfaceLoads`,
`resolvedDeformationMeshTargetArea`) and `seepslope/model applySoilModelPatch` — no `S`, no DOM, no
`Worker` except inside `DEFAULT_WORKER_FACTORIES`.

**Contract.** Every run is the same three pure pieces, so the three façades read identically:

```js
prepareX(bishop, model)          → { ok, reject:{reason,message}|null, patch }   // pre-flight
buildXRequest(bishop, model, id) → { type, runId, input }                        // state → message
startXPatch(…, runId)            → patch                                          // the launch writes
reduceXMessage(bishop, payload)  → { handled, kind, patch, effects }              // message → patch
stopXPatch(bishop, silent)       → patch
xWorkerErrorPatch()              → patch
```

`kind` is `'stale' | 'progress' | 'result' | 'interrupted' | 'error'`; `effects` is
`{ render, drawCanvas, updateProgressDom }`. A patch is `{ key | dotted.path: value }` applied in
place by `applyRunPatch` in insertion order: every key it names exists after `ensure()`, so the
block's JSON text and key order are the monolith's and the nested objects keep their identity —
except `progress` (and `seepage.progress` / `deformation.progress`), which the launch replaces
wholesale exactly as the monolith replaced it (`bishop.progress` gains `runId`, absent from
`progressDefaults()`, in its own key order).

**The run-id guard** (map §3.4 #8) is the `handled:false` branch of the reducers — pure, and
therefore testable without a browser for the first time.

**The adapter:**

```js
const workers = createWorkerAdapter();               // or ({factories, hasWorker}) in a test
workers.ensure(kind, { onMessage(payload, adapter), onError(adapter) }) → Worker | null
workers.nextRunId(kind) / runId(kind) / get(kind) / post(kind, message) / snapshot()
workers.stop(kind, { silent, runId }) → 'terminated' | 'requested' | 'none'
workers.terminate(kind) / terminateAll()
```

`stop` encodes the asymmetry the monolith had inline: **silent** always terminates (an
invalidation, a CPT switch, the start of another run — the run is abandoned, not finished), while
**non-silent** posts the kind's stop message so a running solve can finish early and keep its
latest solved state. The search worker has no stop protocol (`analyzeBishopSearch` never yields),
so it is terminated either way. `onerror` runs the host handler and then terminates, in the
monolith's order.

### 2.1 The worker URLs moved into the package

`new Worker(new URL('../../stage6-bishop-worker.js', import.meta.url), {type:'module'})` and its
two siblings now live in `run/workers.js`. Vite still discovers all three statically — `npm run
build` emits `workers/stage6-bishop-worker-*.js` (48 kB), `workers/seepage-worker-*.js` (89 kB)
plus `workers/assets/triangle.out-*.wasm`, and `workers/deformation-worker-*.js` (568 kB), the same
set as before — and the seep-slope journey runs all three for real.

## 3. Controller

| | lines |
|---|---|
| before (f5b4a9b) | 11 498 |
| after | **11 093** (−405; `git diff --stat`: 153 insertions, 558 deletions) |

Hunks (`git diff integration-r`): the import block (one 34-name import after the `seepslope/model`
import, and the six worker/run-id `let`s replaced by the adapter instance), the run/worker region
3790-4371 (582 lines → 185 lines of façades under a `── seepslope/run façades ──` banner), the
three label helpers at 4393-4409, `stage6SeepageFlowErrorLabel` at 4637, and
`stage6BishopRunningMessage` / `ReadyMessage` / `CompleteMessage` / `SeepageCompleteMessage` at
4656-4699. Nothing else.

## 4. Commit 2 — a rejected run clears its own `progress.running`

Every pre-flight rejection returned **before** the silent stop the handler makes on its way to the
worker (`RunSearch` 4118-4133 vs `StopSearch(true)` 4150; `RunSeepage` 4185-4212 vs 4213-4214;
`RunDeformation` 4254-4270 vs 4271-4273). So pressing Run on a state that had become un-runnable
while a run was in flight left the run flag set next to the failure reason:

| run | what the user saw |
|---|---|
| search | `progress.running` stayed `true`: the progress line kept counting `Bishop + Spencer check · 0/0 Bishop trials (0%)` instead of showing the reason, and `stage6BishopDrawCanvas` (base line 8300, `if(bishop.progress?.running && bishop.progress.previewCircle)`) kept drawing the preview circle of a run whose result the guard would drop |
| seepage | `seepage.progress.running` stayed `true` next to `status: 'failed'` — a panel showing a failure and a running spinner at once |
| deformation | the same, on `deformation.progress.running` |

The three rejection patches now carry `progress.running: false`. Nothing else moves: the reason
strings, the status enums, the render and the worker traffic are unchanged; the no-Worker branch
already ran after the silent stops, so there the write is a no-op; and on a state with no run in
flight (every Node golden, every fresh panel) the flag was already `false`. `previewCircle` is
deliberately **not** cleared: the draw guards on `running`, so clearing the flag already removes
the stray circle, and clearing the circle too would be a second, unneeded write.

The verifier's `running-fix` group launches each run, makes the state un-runnable **under the
running worker** and presses Run again; it asserts that the base still reproduces the defect
(`running === true`) and the working tree clears it, and that this single flag is the **only**
difference between the two controllers over the whole 202-step walk.

## 5. `scripts/verify_seepslope_run.mjs` — **1 255 passed, 0 failed**

Pattern of `verify_seepslope_state.mjs` / `verify_seepslope_model.mjs`: the base controller
(`git show integration-r:…`, materialised as
`src/lib/cpt-app/__verify-seepslope-run-base.legacy-controller.js` and deleted in a `finally`) and
the working-tree controller each load in their own child process through the Tier-B loader, dump
the same observations as JSON with key order preserved, and the parent compares them byte for byte.
No `MOVED_SIBLINGS` are needed. `--base <ref>` / `--snapshot f.json` / `--against f.json` as usual.
≈ 6 min wall-clock.

**The one new idea: a recording `Worker` stub.** `installDomStub()` sets `globalThis.Worker =
undefined`, so under Node the monolith's run handlers never get past their "Web Worker is not
available" guard and *no message is ever posted* — the golden `bishop` suite locks that guard, not
the contract. This verifier replaces `Worker` with a class that logs every construction (which
entry module, which options), every `postMessage` (the full message, key order preserved) and every
`terminate()`, and injects replies by calling the instance's own `onmessage` / `onerror`. That is
what makes the three message contracts of map §5 — the 55 deformation option keys included —
observable under Node at all. The stub is removed again for the no-Worker group, which reproduces
the golden suites' environment exactly.

| Group | What |
|---|---|
| (a) the worker messages | the seeded `loadDemo()` CPT and every CPT of `legacy-v0.5.2` / `multi-3cpt` / `single-layered`, each made runnable the way the seep-slope journey makes it runnable (terrain + entry/exit zones, two side head BCs through `SelectSeepageBoundary` / `SetSeepageBcType` / `SetSeepageBcHead`, one surface load): `RunSearch` / `RunSeepage` / `RunDeformation`, and after each the constructed workers, the posted message (deep-equal, key order), the bishop block, the four status strings, `#stage6BishopProgress` / `…ProgressBar`, and `#stage6Area` on the demo |
| (b) the rejections | no model (× 3 runs), no zones (entry only, then neither), a flux-only BC set, no BC at all, a fixed free surface without a phreatic line, a one-point phreatic line, a drain above the terrain (`validateDrains`), no active surface load, the same as a `safety-cphi` analysis (accepted), and the **no-Worker guard** with the stub switched off — the state each writes and the fact that nothing is posted |
| (b2) the commit-2 fix | the three "a run is in flight and the state became un-runnable" scenarios (§4), each followed by a silent stop so the divergence cannot leak into later steps |
| (c) the replies | driven through the worker's own `onmessage`: **search** — a **real** `analyzeBishopSearch` result (the golden bishop suite's reduced grid on `layered`, with `timing` fixed) and its bishop-only / Spencer-fallback / no-critical-circle variants, progress at 10 % and 60 %, an empty progress payload, a stale runId, an error with and without a message, an unknown message type, `onerror`, and the Stop button while running and while idle; **seepage** — progress at every stage (`meshing` / `solving` / `post` / unknown), a result that auto-enables the head contours (every overlay switched off first) and one that does not, the four termination reasons, a result without a mesh, the interrupt error, a generic error, an empty error, `onerror`, the cooperative Stop (`stop-seepage` posted) followed by the interrupted result, the idle Stop and the silent stop; **deformation** — the four progress stages, **20 crafted solver outputs** that reach every branch of the 60-line status message, a result without a mesh, a result without an output, both interrupt errors, a generic error, an empty error, `onerror`, the cooperative Stop (`stop-deformation`), the idle Stop, the silent stop, and two option variants (T6 / js-cpu / total load / production-msf / staged off, and a wall for `lastWallInputs`) |
| (d) the progress strings | `#stage6BishopProgress`.textContent and `#stage6BishopProgressBar`.style.width after **every** step, plus the eight pure builders over crafted inputs in group (f) |
| (e) terminate on CPT switch | PLAN §4 defect 2, per run (each handler silently stops the other two, so only one worker is ever alive): launch on CPT 0 of `multi-3cpt` → `selectCpt(1)` → the worker must be terminated → a late reply from the abandoned run while CPT 1 is active must be dropped → back on CPT 0 nothing may be left running |
| (f) the package standalone | the 10 pure builders of `progress.js` over crafted inputs (every branch of `deformationCompleteMessage`, the four search outcomes, the four seepage termination reasons, the four `searchProgressDom` shapes); `stopXPatch(b, true)` ≡ `seepslope/model` `stopXState(b)` over 18 status combinations, and the non-silent branch; the 55 option keys with their pinned values; the five message shapes vs map §5; `buildSeepageInputModel` / `buildLastWallInputs`; the pure rejection helpers; and the **adapter driven directly with stub factories** — creates once and hands the same instance back, routes `onmessage` with the payload (an empty event → `{}`), per-kind monotonic run ids, `stop` terminating vs asking cooperatively, `onerror` terminating after the host handler, `terminateAll`, `ensure` → `null` without a `Worker` constructor, an unknown kind throwing |

Totals over the walk: **202 steps**, 79 workers constructed, 162 worker events, **19 `analyze` +
21 `run-seepage` + 41 `run-deformation` + 2 `stop-seepage` + 2 `stop-deformation` messages** all
deep-equal between the two controllers, plus the terminate log.

`package.json` line for the main session (**not** added here, as briefed):

```json
"verify:seepslope-run": "node scripts/verify_seepslope_run.mjs",
```

Like the other `verify_*` movers it needs the Vite dev dependency and a reachable base ref; on a PR
branch use `--base origin/main`, or `--against` a committed `--snapshot`.

## 6. Gates

Run after **each** commit; the table shows the final tree (commit 2).

| Gate | Result |
|---|---|
| `npm run golden:check` — base f5b4a9b | 2 086 PASS / 0 FAIL / 0 NEW / 0 MISSING, 64 s |
| `npm run golden:check` — commit 1 | **2 086 / 0 / 0 / 0**, 66 s |
| `npm run golden:check` — commit 2 | **2 086 / 0 / 0 / 0**, 73 s (`bishop` 71, `seepage` 41, `deformation` 37, `stage6-shared` 15, `report` 22 … all bit-identical) |
| `node scripts/verify_seepslope_state.mjs` | **1 110 / 1 110** (both commits) |
| `node scripts/verify_seepslope_model.mjs --base 09b9c9b` | **1 301 / 1 301** (both commits) |
| `node scripts/verify_seepslope_model.mjs` (default base `integration-r`) | 1 299 / 2 — **pre-existing, not this PR**, see §7.1 |
| `node scripts/verify_seepslope_run.mjs` | commit 1 **1 165 / 1 165**; commit 2 **1 255 / 1 255** |
| `npm run verify:core` | stops at `verify:seepslope-model` for the reason in §7.1; every step before it green (handlers OK — 180 published, **legacyApi 167**; core 18/18; model-params; classification-layers; load; export-report; bearing; pile; settlement-dewatering-beam; seepslope-state 1 110). Every step after it run individually: project-section-tuning 208/208, nen6740, stratigraphy, import-review, project-io, scia-db4, qc-only, retaining, wasm, bishop-phase-a — all exit 0 |
| `npm run build` | `✔ done`, exit 0; the three worker chunks emitted as before (§2.1) |
| `npm run check` | 499 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `seepslope/**` |
| `GOLDEN_PORT=5699 GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs --grep seep-slope` | **1 passed** after each commit (23.2 s / 26.1 s): 13 steps, state + DOM text byte-identical; bishop search 1 035 / 1 357 ms, seepage 273 / 250 ms, deformation 1 163 / 1 400 ms. No `09-seepage-bcs` flake in either run |

The journey ran against a dev server started from the worktree with a scratch `.mts` Vite config
under this session's scratchpad (report 19 §5 + report 22 §5.3: `root` = the worktree,
`server.fs.allow` += the real `node_modules` path, the `**/.claude/**` watcher ignore dropped, a
`node_modules` symlink next to the config), on port 5699; Playwright's `reuseExistingServer` picked
it up. The three `visual (soft)` mismatches (`01-bishop-empty`, `02-terrain`, `08-stability`) are
the pre-existing machine-wide PNG drift of report 22 §5.1 — the deterministic halves (`state.json`,
`dom.txt`) are byte-identical in every step.

## 7. Findings

1. **`verify_seepslope_model.mjs` against its default base is now two checks short — pre-existing.**
   Its group (c) asserts that the *base* controller still reproduces PLAN §4 defect 3 (the draw path
   mutating state). The default base is `integration-r`, which since `75878b9` **contains PR 18b's
   fix**, so the base leaves 24/24 frames identical and the two "the base mutated the block here"
   checks cannot pass. `--base 09b9c9b` (report 22's own base) is 1 301 / 1 301, and both failures
   read only `oldDump`, so they are independent of any working-tree change. `verify:core` stops
   there. Fix: pin `--base` in the npm script, or turn those two checks into "the base either
   reproduces the defect or is already fixed" — harness owner.
2. **The run-id guard does not protect against a reply that arrives after the run finished.** The
   guard is `payload.runId !== progress.runId` and the run id survives the result, so a `progress`
   message delivered after the `result` is accepted and re-arms `progress.running`. The verifier
   locks this as monolith behaviour (`search: a progress reply after the result is still accepted`);
   the real workers stop sending after the result, so it is unreachable in production. If step 9g or
   10 ever wants it closed, the cheap fix is for the terminal branches to clear `progress.runId`.
3. **`bc.status = 'orphaned'` does not stick**: `stage6BishopSyncSeepageState` re-derives the status
   from the boundary on the next sync, so a test that orphans a BC and expects the seepage
   pre-flight to reject actually launches a run. The verifier's "no head BC" scenarios use a type
   change and an empty list instead. Worth knowing for step 9f's panel tests.
4. **`stage6BishopSetField('surfaceLoad.*')` cannot create a load.** With an empty `surfaceLoads` it
   writes only the legacy mirror, which `syncLegacySurfaceLoadMirror` overwrites on the next sync —
   so the three fields land nowhere and the deformation pre-flight keeps rejecting. Only the canvas
   load tool and `CreateSurfaceLoadFromZone` create loads. Not a defect (the inputs are only
   rendered when a load exists), but it means the legacy mirror path at 3003-3011 (base) is dead
   for a fresh state; step 9f should delete it or make it create the load.
5. **The invalidators' `{stop, rerun}` result still has no reader** (report 22 finding 5). This PR
   deliberately did not wire it: the façades' ad-hoc `Stop*` calls are exactly what the transitions
   name, and swapping them for a loop over `result.stop` would be a behaviour change hidden inside a
   pure move. The adapter now makes it a one-liner
   (`for(const kind of result.stop) stage6BishopWorkers.stop(kind, {silent:true})`) — a good first
   commit for step 9g or the composition root, with the verifier's (b) group as its evidence.
6. **`prepareSeepage` calls `validateDrains` and the pre-flight stores its result** whether or not it
   rejects; that is the monolith's order (`bishop.seepage.drainValidation = drainValidation;` before
   the `if`). The façade therefore applies `prep.patch` before branching on `prep.ok` — the one place
   where the three run façades are not symmetrical, and it is commented as such.
7. **The request is built at the monolith's timing point, not at one uniform point.** `RunSearch`
   builds its `input` *before* the silent stops (the pre-post `renderStage6()` re-runs `ensure()` and
   the soil-model sync, which can still clamp the zones or the search config on a state that has not
   converged — report 22 finding 1); `RunSeepage` strips the mesh after the launch patch; and
   `RunDeformation` reads its ~60 options *at the post*, where the monolith read them inline in the
   `postMessage` literal. The package exposes both granularities (`buildXInput` / `xRequest` and the
   composed `buildXRequest`) so the façade can keep the order and a future host can use the one-call
   form.

## 8. Follow-ups (not in this PR)

1. Main session / harness owner: `"verify:seepslope-run": "node scripts/verify_seepslope_run.mjs"`
   in `package.json` (§5), and finding 1 (`verify:seepslope-model`'s default base).
2. Step 9g / PR 20: let the run handlers drive the workers from the invalidators' `{stop, rerun}`
   (finding 5), and give `createWorkerAdapter` a `terminateAll()` caller in `project/cpts.js`
   `stopWorkers` instead of the three named façades.
3. Step 9f: import the four label helpers and `readyMessage` from `seepslope/run/progress.js` in the
   panel modules (they already take the `bishop` block), and clean up the dead legacy
   `surfaceLoad.*` setter branch (finding 4).
4. Step 9e: `reduceSearchMessage`'s `effects.drawCanvas` is the last caller of
   `stage6BishopDrawCanvas` outside the canvas region — the pointer/draw module should take the
   effect instead of the host reaching for a global.
5. Optional behaviour commit: clear `progress.runId` in the terminal reducer branches so a reply
   after the run really is stale (finding 2).
