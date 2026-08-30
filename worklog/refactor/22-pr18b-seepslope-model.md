# 22 — PR 18b `refactor/fix(seepslope): soil-model sync, invalidation, and a draw path that stops mutating state`

Base `integration-r` @ 09b9c9b (controller 11 627 lines; PR 18a merged), the second Seep / Slope sub-step of
`01-monolith-map.md` §6.2 step 9 (PLAN §2 row 18b and **§4 defect 3**; map §2.11 groups "Soil model bridge"
and "Seepage BC handlers + invalidation", §3.4 **#5** and **#9**, §6.3 item 5). Executed by a Fable agent in
an isolated worktree, **two commits**:

| | hash | |
|---|---|---|
| 1 | `44deb8c` | `refactor(seepslope): soil-model sync and invalidation as pure model functions` — the pure move |
| 2 | *this commit* | `fix(seepslope): the canvas draw path no longer mutates state` — PLAN §4 defect 3 |

File set: `src/lib/cpt-app/legacy-controller.js` (the bishop soil-model / invalidation regions and the
`stage6BishopDrawCanvas` model line only), new `src/lib/cpt-app/seepslope/model/**` (4 files), new
`scripts/verify_seepslope_model.mjs`, this report. `package.json`, `tests/**`, `scripts/golden/**`,
`stage6-bishop.js` (the engine), `seepslope/state/**`, every render function, every HTML string and every
class attribute untouched; nothing under `retaining/` (a parallel PR owns it).

`npm run golden:check` **2 086 / 0 / 0 / 0** before, after commit 1 and after commit 2 — **no golden changed,
no `tests/golden/CHANGELOG.md` entry**, including for the behaviour fix. The Node suites never enter the draw
path (there is no canvas under the DOM stub), so commit 2 is invisible to them *by construction*; what proves
it is the browser journey (which does click `#stage6BishopCanvas`, 13 steps, state + DOM text byte-identical)
and the verifier's group (c), which drives 24 real frames through the bound pointer handlers in five
scenarios.

---

## 0. The WIP that was handed over, reviewed line by line

The starting point was `wip-pr18b-seepslope-model` @ 19931d8 — ~1 400 lines never run, never verified. It was
read against `git show integration-r:src/lib/cpt-app/legacy-controller.js` statement for statement before
anything was built on it. **The verdict is: the move itself was right, the claims about it were not.** What
follows is the audit.

### Kept verbatim (checked against the base, then proved by the verifier)

| WIP artefact | Checked against | Verdict |
|---|---|---|
| `model/signature.js` (62 lines) | base 2880-2889 | correct — `materialsSource` reproduces the monolith's `if` exactly (`signature !== sourceLayerSignature \|\| !materials.length \|\| strengthSetChanged`), `materialsInvalidation` its `if(hadSignature)` and the strength-set-wins message precedence |
| `model/invalidate.js` (157 lines) | base 1954-1972 (`InvalidateSeepage`), 2821-2845 (`InvalidateDeformation`), 2847-2869 (`Invalidate`), 2871-2874 (`InvalidateWallGeometry`), 3930-3996 (the three `Stop*(true)`) | correct, statement for statement. The two long "**Status honesty**" comments read like an invented behaviour change; they are **verbatim from the monolith** (base 2840-2843 and 2864-2865) and the `progress.message` writes they describe are the monolith's. Kept, comments included. |
| `model/sync-soil-model.js` bodies (321 lines) | base 2876-3005 | correct. The one non-obvious decision — `draft.surfaceLoads = bishop.surfaceLoads.slice()` before `migrateSurfaceLoadsShape` — is **necessary**: `state/surface-loads.js migrateSurfaceLoadsShape` *pushes* the legacy seed into the existing array before reassigning it, so without the copy the "pure" sync would write through into `S.stage6.bishop`. Good catch by the WIP. |
| the patch design (`SOIL_MODEL_PATCH_KEYS`, `applySoilModelPatch`, `previewState`, `soilModelFromState`) | — | kept; it is what "an explicit result, no hidden mutation" has to look like, and (d) proves the applied patch reproduces the controller's block byte for byte in all 58 replayed states |
| `model/index.js`, the three controller invalidator façades, the sync façade | base | correct |
| the verifier's architecture — two child processes through the Tier-B loader, the base controller materialised from `git show` and deleted in a `finally`, `--base` / `--snapshot` / `--against`, the (a)–(e) grouping, the legacy v1 / v2 blocks, the seeded clock + PRNG | `scripts/verify_seepslope_state.mjs` | correct and reused as is |

Purity was not taken on trust: `state/{surface-loads,walls,drains,regions,domain}.js` `sortZone`,
`normalizeSurfaceLoad`, `syncLegacySurfaceLoadMirror`, `sortedPolyline`, `normalizeWalls`, `normalizeDrains`,
`normalizeCustomRegions` and the engine's `importBishopMaterialsFromLayers` /
`buildBishopModelFromStageLayers` were each read and confirmed to build new objects rather than mutate their
inputs — which is what makes `syncSoilModel` genuinely pure. (d) asserts `inputUntouched` on every state it
replays, so the property is now checked, not assumed.

### Changed

1. **`stage6BishopInvalidateWallGeometry` was never wired** — the controller kept its old body (two façade
   calls) while `invalidate.js` exported an `invalidateWallGeometry` nobody called: dead code in a package
   whose whole point is to own the transition. The façade now terminates the search, deformation and seepage
   workers up front and calls the package (equivalent: `terminate()` has no effect on the block, and the
   package's own transition performs the same state writes in the same order). (b) + (d) prove it.
2. **The sync façade's ordering was undocumented.** The monolith fires `stage6BishopInvalidate` *in the
   middle* of the sync (right after the re-import, before the HS mirror / geometry / pruning); the façade
   applies the whole patch first and invalidates after. The two are equivalent — the invalidator writes
   `results` / `selectedResult` / `stale` / `progress.message` / `deformation.*`, none of which the sync
   touches, and every key exists after `ensure()` so no key order moves. Written into the façade's comment
   and checked by (a).
3. **`sync-soil-model.js` claimed idempotence it does not have.** See §6 finding 1 — the header now
   documents the two convergence cases instead.
4. **`setStiffMethod('B')`** in the verifier's walk. `'B'` is the *default* (`S.stiffMethod`), so the step
   that was supposed to exercise the HS mirror was a no-op and two assertions built on it were vacuous or
   false. Now `'A'`.
5. **The "terrain normalised" walk assertion expected `tool === 'edit'`.** The monolith keeps `regionSplit`
   there, because the same pruning pass refilled `selectedRegionId` from the two custom regions the previous
   step added. Expectation corrected and the reason written down; the `tool → edit` branch is reached (and
   still asserted) by the following step, which clears the polygons.
6. **The blanket idempotence assertion `walk: the sync-only re-runs never change the block` was false** — of
   the monolith, not of the package (§6 finding 1). Replaced by a third-sync convergence check (12 triples,
   third run added to the demo / project-fixture / legacy walks), an "a sync right after a render is a no-op"
   check (11 steps), and, at package level, `againPatchKeys ⊆ {walls}` + `thirdChanged === false`.
7. **The (d) transition replay compared apples with oranges** — it invalidated a copy of the pre-step block
   and compared it with a controller step that had *also* stored the setter's field
   (`seepage.options.maxRuntimeMs`, `deformation.options.maxLoadSteps`, `useFemPorePressure`), producing four
   false failures. `transition()` now records the handler-owned paths and the replay applies them before the
   transition, so the comparison is about the invalidator alone.
8. **The `soilModelFromState` purity check was wrong by construction** — `ser(copy) === ser(model.state)` is
   false whenever the sync patches anything, because `previewState` deliberately returns a *different*
   object. Replaced by the property that matters: `soilModelFromState` leaves the block it is handed
   untouched.
9. **`drawFrames` called `fitStage6BishopViewport()` on one frame in six.** Fit is not a frame: it writes
   `bishop.viewport` and goes through `stage6BishopCurrentModel()` (i.e. it syncs, legitimately). Leaving it
   in would have made commit 2's whole assertion untestable. Frames are now only the two published paths
   that are pure draw: `onpointermove` (→ `UpdateHoverDom` → `DrawCanvas`) and `onpointerleave`.
   `stage6BishopDrawCanvas` itself is not on `legacyApi`.
10. The (c) section was written as if commit 2 already existed. It ships as base-vs-tree parity in commit 1
    (where the draw still syncs, and the report line *measures* the defect) and as the state-identity +
    model-parity assertion in commit 2, on five scenarios instead of three.

### Discarded

Only one thing: a `dump.pure.models` block that computed a `{post, cache}` map nothing ever asserted, around
a `void layersLabel` no-op. Nothing else was thrown away.

---

## 1. Commit 1 — what moved

Line numbers are integration-r @ 09b9c9b. Every moved body was cut at its `function name(` anchor and read
back against the new module; the only edits inside the bodies are in the "change" column.

| Monolith (old) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `stage6BishopSyncSoilModel` 2876-3005 (130) | `model/sync-soil-model.js` → `syncSoilModel(bishop, layers, env)` + the four steps it composes: `syncMaterials`, `mirrorHsParams`, `normalizeSoilGeometry`, `pruneSelections` | `S.stage6.bishop` → the `bishop` parameter; every `bishop.x = …` became a write on a shallow draft and every `material.x = …` a write on `{...material}` / `{...material.hs}` **in the same key order**; the mid-sync `stage6BishopInvalidate` became the returned `invalidation`; the ids `normalizeCustomRegions` allocates come from `env.ids` | façade: `ensure` → `stage6WorkingLayers()` → `syncSoilModel` → `applySoilModelPatch` → `stage6BishopInvalidate(sync.invalidation.message)`; returns the layers, as before |
| the signature decision inside it, 2880-2889 | `model/signature.js` → `materialsSignature`, `materialsSource`, `materialsInvalidation`, `MATERIALS_INVALIDATION_MESSAGES` | the `if` and its two message strings became data | — (used by `syncMaterials`) |
| `stage6BishopCurrentModel` 3007-3013 | `model/sync-soil-model.js` → `buildBishopModel(layers, bishop, env)`, `soilModelFromState(bishop, layers, env)` | `soilModelFromState` returns `{model, sync, state}` without mutating; the seepage-state sync (`stage6BishopSyncSeepageState`) stays a host concern until step 9c | unchanged (still sync → build → cache → seepage sync) |
| `stage6BishopInvalidateSeepage` 1954-1972 | `model/invalidate.js` → `invalidateSeepage(bishop, {message, keepMesh, preserveSolvedState})` | `S.stage6.bishop` → parameter; `ensure` + the worker `terminate()` out; the early `return` became the `{stop, rerun, keptSolvedState, render}` result | façade: ensure + `stage6BishopStopSeepage(true)` + the package |
| `stage6BishopInvalidateDeformation` 2821-2845 | → `invalidateDeformation(bishop, opts)` | as above | as above with `StopDeformation` |
| `stage6BishopInvalidate` 2847-2869 (22 callers) | → `invalidateBishop(bishop, message)` | as above | façade: ensure + `StopSearch(true)` + `StopDeformation(true)` + the package |
| `stage6BishopInvalidateWallGeometry` 2871-2874 | → `invalidateWallGeometry(bishop, message)` | composes the two transitions and merges their `stop` / `rerun` | façade: ensure + the three silent stops + the package (**newly wired**, §0 change 1) |
| the state half of `StopSeepage` / `StopDeformation` / `StopSearch` with `silent = true` (3930-3996) | → `stopSeepageState`, `stopDeformationState`, `stopSearchState` | the `terminate()` half and the non-silent messages stay in the host (step 9c owns the workers) | unchanged — the host functions keep both halves; the package's copies are what the transitions call |

Nothing else moved: `stage6BishopSyncSeepageState`, `stage6BishopCurrentSeepageBoundary`, the deformation
contour helpers, `stage6BishopSetField`, the run handlers and the canvas remain in place.

## 2. The package — `src/lib/cpt-app/seepslope/model/`

| File | Lines | Exports |
|---|---|---|
| `index.js` | 61 | the flat surface below, the `signature` / `sync` / `invalidate` namespaces, and `buildBishopModelFromStageLayers` / `importBishopMaterialsFromLayers` / `bishopLayerSignature` re-exported from `stage6-bishop.js` (the engine stays where it is; the package is the single import point) |
| `signature.js` | 62 | `materialsSignature`, `materialsSource`, `materialsInvalidation`, `MATERIALS_INVALIDATION_MESSAGES` |
| `sync-soil-model.js` | 334 | `SOIL_MODEL_PATCH_KEYS` (21), `HS_PROMPT_PATH`, `mirrorHsParams`, `syncMaterials`, `normalizeSoilGeometry`, `pruneSelections`, `syncSoilModel`, `applySoilModelPatch`, `previewState`, `buildBishopModel`, `soilModelFromState` |
| `invalidate.js` | 157 | `stopSearchState`, `stopSeepageState`, `stopDeformationState`, `invalidateSeepage`, `invalidateDeformation`, `invalidateBishop`, `invalidateWallGeometry` |

614 lines. SPDX + `@ts-nocheck`, a header naming the source lines and the contract, `.js` imports; loads
under plain Node. Dependencies outside the package: `stage6-bishop.js` (the engine) and `seepslope/state/**`
— no `S`, no DOM.

**Contract.**

```js
syncSoilModel(bishop, layers, env) → {
  changed,        // patch has at least one key
  patch,          // { key: value } — only the keys whose serialised value the monolith's writes would
                  // change, in the monolith's first-write order; one dotted path,
                  // 'deformation.options.hsConsistentTangentPromptPending', for the HS tangent prompt
  invalidation,   // null | { kind:'bishop', message } — the Bishop invalidation a re-import carries
  reimported, source, layers
}
applySoilModelPatch(bishop, patch)   // in place; the block and its nested objects keep their identity
previewState(bishop, patch)          // a new object along every written path; `bishop` untouched
soilModelFromState(bishop, layers, env) → { model, sync, state }   // the same model everywhere

invalidate*(bishop, …) → { stop: ['search'|'seepage'|'deformation'…],
                           rerun: ['bishop'|'seepage'|'deformation'…],
                           keptSolvedState, render: true }
```

The patch, rather than a whole replacement block, is what keeps the move bit-identical: a key whose value the
sync would rewrite to the same JSON is simply not in the patch, so the block keeps the very object it had —
which is what 20-odd controller regions that hold `S.stage6.bishop.<x>` references rely on.

## 3. Commit 2 — the draw path (PLAN §4 defect 3, map §3.4 #5 / #9)

`stage6BishopDrawCanvas` (1 128 lines) opened with

```js
  stage6BishopSyncSoilModel();
  const model = buildBishopModelFromStageLayers(stage6WorkingLayers(), bishop);
  S.stage6Cache.bishopModel = model;
```

so **every animation frame ran the full soil-model sync**: on a canvas drawn after a Stage 3/4 edit or a
strength-set change, the first frame re-imported the materials and — through the invalidation that re-import
carries (map §3.4 #9) — cleared the Bishop *and* deformation results the user was looking at, from inside a
pointer-move handler. During a pan or a handle drag the sync also re-sorted the terrain and re-normalised the
walls, drains and regions under the pointer.

The fix is the first line, deleted. The sync now runs only where the inputs change, and every one of those
places already existed:

| Input change | Where it syncs |
|---|---|
| app entry, CPT switch, and every re-render | `renderStage6BishopApp()` → `stage6BishopCurrentModel()` (top of the function) |
| Stage 3 / 4 / 5 layer edits | the next `renderStage6()` — Stage 6 is not visible while they happen |
| material / wall / drain / region handlers | the 13 explicit `stage6BishopSyncSoilModel()` calls in `SetSelectedRegionMaterial`, `SetSelectedRegionCoarseness`, `SetMaterialField`, `SetMaterialHsField`, `ResolveHsConsistentTangentMigration`, `SetMaterialPermeability`, `SetWallField`, `SetWallMaterialField`, `DeleteWall`, `SetDrainField`, `DeleteDrain`, `RunSeepage`, `RunDeformation` |
| every other handler (`SetField`'s 139 inline uses, `SetTool`, `Clear`, `FinishDraft`, `ImportDxf`, `SetUseCustomRegions`, `CopyCurrentRegionsToCustom`, `SplitSelectedRegion`, the surface-load and zone setters) | the `renderStage6()` each of them ends with |
| a pointer drag | `stage6BishopPointerUp` → the per-kind invalidator → `renderStage6()` |
| before a run | `RunSearch` → `stage6BishopCurrentModel()`; `RunSeepage` / `RunDeformation` → `SyncSoilModel()` **and** `CurrentModel()` |
| fit view / auto-fit | `fitStage6BishopViewport()` → `stage6BishopCurrentModel()` |

By the time a frame is drawn the block is therefore already synced, and the remaining line is a pure read of
it that yields the very model those callers built — which is the "the same model is used everywhere" half of
the fix. Only `S.stage6Cache` (the volatile model cache, map §1.2 — not `S.stage6`) is still written, on
purpose: the hover tooltip and the pointer picking read `S.stage6Cache.bishopModel || stage6BishopCurrentModel()`,
and leaving the cache empty would have moved the sync from the draw into the *hover*.

## 4. `scripts/verify_seepslope_model.mjs` — **1 301 passed, 0 failed**

Pattern of `verify_seepslope_state.mjs`: the base controller (`git show integration-r:…`, materialised as
`src/lib/cpt-app/__verify-seepslope-model-base.legacy-controller.js` and deleted in a `finally`) and the
working-tree controller each load in their own child process through the Tier-B loader, dump the same
observations as JSON with key order preserved, and the parent compares them byte for byte. No `MOVED_SIBLINGS`
were needed: this PR does not change any module the base imports. `--base <ref>` / `--snapshot f.json` /
`--against f.json` as usual. ≈ 4 min wall-clock (two Vite loads, 15 fixture imports, 7 in-process searches).

| Group | Checks | What |
|---|---|---|
| (a) the sync | 416 | per step: no exception / same message, `S.stage6.bishop` deep-equal **+ key order**, the four status strings, `S.stage6Cache.bishopModel` (where a render ran), app / cache keys / rAF errors / alerts / `Date.now()`+`Math.random()` call count. Steps: the seeded `loadDemo()` CPT; all 7 CPTs of `legacy-v0.5.2` / `multi-3cpt` / `single-layered` through `loadProjectFromFile`; the two synthetic legacy bishop blocks (v1 and v2 era shapes) fresh **and** on a layered CPT; and a 30-step walk on the `layered` fixture under a seeded clock + PRNG that reaches **every** branch of the sync — first import, the HS mirror after a Stage 4 `setStiffMethod('A')` (materials patched, no re-import, no invalidation), a Stage 3 `editL` (signature → "Active CPT layers changed…", results cleared), a strength-set change ("Material strength set changed…"), a legacy `material.hs` without `useConsistentTangent` (prompt raised, `reserved` → `nearSurfaceMinConfiningStress`, the five legacy stiffness keys stripped, `rShear` filled), `useConsistentTangent: 0.7` → `true` with the migration resolved, a region without an id (a `region_` id allocated and compared verbatim) / an unknown material / a degenerate polygon, unsorted terrain + out-of-range CPT / zones / loads + a legacy `x`-`yTop`-`yTip` wall + a one-vertex drain + dangling wall / drain / region / draft-material selections, `customRegions` not an array, `useCustomRegions` without polygons, the split and hole tools without a selection, a one-point terrain (model `null`), and back. Plus 10 assertions that the walk did what its labels say, the third-sync convergence (12 triples, 8 of which were already a no-op on the second run) and "a sync right after a render is a no-op" (11 steps). 94 steps in all. |
| (b) the invalidation | 435 | every façade through its published handler on synthetic result states — seepage × 5 statuses × 3 (mesh, result) combinations × 2 entry points, deformation × 6 statuses × 3 × 4 entry points, plus `results = null` and two wall-geometry edits; **105 transitions** (107 steps with the two shell renders), each compared on the same observation set as (a). The Stage 6 shell sits on the **bearing** app during this walk so `renderStage6()` cannot re-sync the bishop block in between. |
| (c) the draw path | 22 | 24 frames through `onpointermove` / `onpointerleave` on `#stage6BishopCanvas` in five scenarios: a synced state; layers changed underneath; the same after the next render; strength set changed underneath; the same after the next render. **Working tree: 24/24 frames leave `S.stage6.bishop` byte-identical in all five.** On the three synced scenarios the model the frames drew is byte-identical to the base's. On the two "changed underneath" scenarios the base is asserted to still *reproduce the defect* (it mutates from frame 0) and the transient model difference is printed. The `renderStage6()` after every scenario converges both controllers on the same state **and** the same model. |
| (d) the package standalone | 408 | `syncSoilModel` replayed on a copy of the pre-step state of all **58** replayable (a) steps, with the exact `now` / `random` values the controller consumed: the input is never mutated, `applySoilModelPatch` (+ `invalidateBishop` when the result says so) reproduces the controller's post-step block byte for byte, the sync converges (second run patches at most `walls`, third patches nothing), `soilModelFromState` never touches the block it is handed, and a converged sync only keeps re-invalidating when the CPT has no layers. Every (b) transition replayed the same way (with the field the handler itself stored applied first) plus its `{stop, rerun, keptSolvedState}`. Unit checks: `materialsSource` / `materialsInvalidation` decision table, `previewState` vs `applySoilModelPatch` identity semantics, `mirrorHsParams` key order and clamps, the 21 patch keys, the engine re-exports, the three stop-state writers. |
| (e) the bishop goldens | 20 | the 6 `tests/golden/node/bishop/<id>.model.json` recomputed with the package's `buildBishopModel` on the solver fixtures, and `cpt.<fx>.model.json` / `.materials.json` for the 7 Stage 6 profile fixtures recomputed with `soilModelFromState` on the pre-sync state (`defaults()` + `merge` + `ensure()` + the suite's terrain) **and** on the synced state — byte-identical to the files on disk, and equal to `S.stage6Cache.bishopModel`. |

`package.json` line for the main session (**not** added here, as briefed):

```json
"verify:seepslope-model": "node scripts/verify_seepslope_model.mjs",
```

Like the other `verify_*` movers it needs the Vite dev dependency and a reachable base ref; on a PR branch use
`--base origin/main`, or `--against` a committed `--snapshot`.

## 5. Gates

Run after **each** commit; the table shows the final tree (commit 2), with commit 1 in brackets where it differs.

| Gate | Result |
|---|---|
| `npm run golden:check` — base 09b9c9b | 2 086 PASS / 0 FAIL / 0 NEW / 0 MISSING, 64 s |
| `npm run golden:check` — commit 1 | **2 086 / 0 / 0 / 0** |
| `npm run golden:check` — commit 2 | **2 086 / 0 / 0 / 0** (`bishop` 71, `seepage` 41, `deformation` 37, `report` 22, `report-svg` 48, `stage6-shared` 15 … all bit-identical) |
| `npm run verify:core` | exit 0 — handlers OK, core, model-params, classification-layers, load, export-report, bearing, pile, settlement-dewatering-beam, project-section-tuning, nen6740, stratigraphy, import-review, project-io, scia-db4, qc-only, retaining, wasm, bishop-phase-a (6 fixtures). The `verify:classification-layers` 259/260 that report 21 §6.4 flagged is fixed on this base and the chain no longer stops. |
| `node scripts/verify_seepslope_state.mjs` | **1 110 / 1 110** (both commits) |
| `node scripts/verify_seepslope_model.mjs` | **1 301 / 1 301** (commit 1: 1 277 / 1 277) |
| `npm run build` | `✔ done`, exit 0 |
| `npm run check` | 494 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `seepslope/**` |
| `GOLDEN_PORT=5699 GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs --grep seep-slope` | **1 passed** (29 s): 13 steps, state + DOM text byte-identical; bishop search 1 302 ms, seepage 288 ms, deformation 1 358 ms |
| the full journey suite (`GOLDEN_VISUAL=off`), 8 runs | 5 passed in 7 of them; 1 run failed `seep-slope 09/10` — **the same flake reproduces on integration-r**, see §5.2 |

Controller: 11 627 → **11 498** lines (−129; commit 1 −140, commit 2 +11 comment lines).

### 5.1 The browser PNG baselines have drifted on this machine — pre-existing, not this PR

The seep-slope journey reports `visual (soft)` mismatches on `01-bishop-empty`, `02-terrain` and
`08-stability`. They are **not** caused by this PR: the same three, and only those three, appear when the
journey is run from this worktree with the tree checked out at `09b9c9b` (integration-r, no PR 18b at all).
The diff images show a uniform vertical offset of the whole page, not a content change, and the deterministic
halves of the journey — `state.json` and `dom.txt` — are byte-identical in every step.

The drift is not limited to seep-slope: `demo-journey` mismatches on **every** step (`01-loaded` through the
Stage 6 apps and the retaining-wall steps), again with identical `state.json` / `dom.txt`. That also explains
why the full suite is slow to a fresh reader — under `GOLDEN_VISUAL=soft` each mismatching step burns the
10 s `expect` timeout with retries, so five journeys take ~20 min instead of ~2. Only the seep-slope journey
is a gate for this PR and it passes; whoever owns `tests/golden/browser` should re-record the PNGs on a
reference machine or pin the rendering environment.

### 5.2 A pre-existing flake in `seep-slope-journey` step 09 (1 run in 7, on both trees)

Running the **full** journey suite (5 journeys, one worker) occasionally fails `seep-slope-journey` at
`09-seepage-bcs` and everything downstream of it:

```
.active.stage6.bishop.seepage.bcs:            "len 2" → "len 1"
.active.stage6.bishop.seepage.selectedEdgeKey: "side-right:0" → "side-left:0"
dom line 64: "Left side Prescribed head 3.00 m" → "Left side Prescribed head -0.50 m"
```

The journey picks the two side boundary edges by clicking `#stage6BishopCanvas` at their midpoints
(`clickWorld`, spec 280-290). When the *second* click lands outside `stage6BishopSnapToleranceWorld()` of the
right-side edge, `stage6BishopCommitDrawPoint` only writes the "Click near an outer-boundary edge…" message —
but the journey's `waitState((s) => selectedEdgeKey !== '')` is already satisfied by the first click, so it
proceeds and applies the right-side head (−0.5 m) to the **left** edge. One lost click, eight failed files.

**It is not this PR.** It appeared once in 8 full-suite runs on the PR branch and once in 7 on `09b9c9b`
(integration-r, run 6), with byte-identical failure output; `seep-slope-journey` run on its own passed 5/5 on
the PR branch. The BC pick reads `S.stage6Cache.bishopSeepageBoundary`, a cache the draw path never wrote, so
commit 2 cannot reach it. Worth hardening in the spec regardless — `waitState` should assert the *expected*
`selectedEdgeKey`, not merely a non-empty one, so a lost click fails loudly at the click instead of silently
corrupting the next eight goldens. Filed for the harness owner.

### 5.3 Running the harness from an agent worktree (addendum to report 19 §5)

The scratch Vite config recipe still applies (`server.fs.allow` += the real `node_modules` path, drop the
`**/.claude/**` watcher ignore, a `node_modules` symlink next to the config). One thing report 19 does not
say: the scratch config must be **`.mts`** (or the scratch directory needs a `package.json` with
`"type": "module"`), otherwise Vite bundles it as CJS and fails with `@sveltejs/kit/vite … is ESM only but it
was tried to load by require`.

## 6. Findings

1. **The soil-model sync converges on the third run, not the second** — the monolith's own behaviour, now
   documented in `sync-soil-model.js` and pinned by (a) and (d). Three drivers:
   *(a)* `state/walls.js normalizeWalls` writes `mechanicalActivationPromptPending = !hasMechanicalActiveField`
   in the same pass that writes `mechanicalActive`, so a wall saved before that field existed raises the
   prompt on the first sync and clears it on the second; *(b)* `ensure()`'s auto mesh target area is
   recomputed from the terrain the first sync sorted, so it drifts once (`0.117 → 0.121` on the demo);
   *(c)* a CPT with **no layers** has no materials, so `source.empty` stays true and every sync re-imports
   and — once a signature is stored — re-fires "Active CPT layers changed; Bishop results were cleared."
   Observable behaviour is unaffected in all three cases, because the panel HTML is always built from the
   block the *render's* sync left: the "N existing retaining walls opened from older project data" note
   (`pendingWallActivationCount`, line 5064) is rendered on exactly one render, before and after commit 2 —
   only the sync that clears the flag moves, from the draw of that same frame to the next render's.
   Worth a behaviour commit later: make `normalizeWalls` leave the prompt flag alone once
   `mechanicalActive` exists, and skip the re-import when `layers.length === 0`.
2. **Defect 3 was worse than "the draw mutates state".** The mutation the draw performed included the
   *invalidation* a materials re-import carries — so a Stage 3/4 edit followed by a mouse move over the
   Seep / Slope canvas silently destroyed solved Bishop and deformation results, from a handler that is
   supposed to paint. (c) reproduces it against the base controller (`materials.0.sourceStrengthSet:
   "characteristic" → "da1_1"` at frame 0) and asserts it is gone.
3. **`buildBishopModelFromStageLayers` re-imports the materials itself** (engine line 2893, from
   `bishopState.materials` as the `existing` set). The model therefore depends on the *synced* materials,
   which is why "the sync runs where the inputs change" is a precondition of commit 2 and not merely a
   tidy-up — and why (c) checks the drawn model, not only the state.
4. **`S.stage6Cache` is the seam between "state" and "frame output".** The draw still writes
   `S.stage6Cache.bishopModel`; the hover tooltip and pointer picking read it. If that cache write were also
   removed, the first hover after a render would call `stage6BishopCurrentModel()` and re-introduce the
   defect one level up. Step 9e should give the pointer module the model instead of letting it fetch one.
5. **The invalidators' `{stop, rerun}` result has no reader yet.** It is the contract step 9c needs (the run
   handlers must terminate exactly the workers the transition names, instead of the ad-hoc `Stop*` calls the
   façades make today); it is asserted by (d) so it cannot rot in the meantime.
6. `stage6BishopMigrateSurfaceLoadsShape(bishop)` is still called at the top of `renderStage6BishopApp`
   (line 8605) even though `syncSoilModel` runs it one line earlier through `stage6BishopCurrentModel()`.
   Harmless (it is idempotent on a synced block) but redundant — step 9f's view-model should drop it.
7. **`stage7CaptureBishopWorkspaceView` draws without re-rendering** in its fast path (`syncBishopCanvas`
   calls `stage6BishopDrawCanvas()` directly when the app is already bishop). With commit 2 that capture now
   paints the state as the user left it instead of a state the capture itself re-synced — one less
   side effect in report generation (map §3.4 #10). The `report` (22) and `report-svg` (48) golden suites
   are bit-identical, and `demo-journey`, which walks Stage 1 → 7 including that capture, passed in all 8
   full-suite runs (§5.2).

## 7. Follow-ups (not in this PR)

1. Finding 1 as a behaviour commit with a golden case: `normalizeWalls`' one-shot prompt flag and the
   no-layers re-import.
2. Step 9c: give the run handlers and the worker callbacks the invalidators' `{stop, rerun}` result, and move
   `stage6BishopSyncSeepageState` / `stage6BishopCurrentSeepageBoundary` into `seepslope/seepage/`. The
   `model` hooks PR 18a left in `createDrainFromVertices` / `copyCurrentRegionsToCustom` can then take
   `soilModelFromState` directly.
3. Step 9e: hand the pointer / draw modules the model and the canvas wrapper as inputs (findings 4 and
   report 21 finding 2), and replace the two duplicated inline wall-creation blocks with `walls.addWall`.
4. Step 9f: drop the redundant `stage6BishopMigrateSurfaceLoadsShape` call (finding 6).
5. Main session / harness owner: `"verify:seepslope-model": "node scripts/verify_seepslope_model.mjs"` in
   `package.json` (§4), and both seepslope verifiers into `verify:core` once a base ref or a committed
   snapshot is available in CI. Re-record the browser PNGs on a reference machine (§5.1). Harden
   `seep-slope-journey`'s boundary-edge clicks so a lost click fails at the click (§5.2).
