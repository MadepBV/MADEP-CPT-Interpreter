# 29 — PR 18g `refactor(seepslope): report capture without switching the app`

Base `integration-r` @ c5fa2c0 (v0.6.0 tip; controller 5 514 lines, PR 18a–f merged), the **last**
Seep / Slope sub-step of `01-monolith-map.md` §6.2 step 9 (PLAN §2 row 18g; map §2.14
`stage7CaptureBishopWorkspaceView` and §3.4 #10 / §6.3 item 7 — "Stage 7 capture that mutates
app/workspace state"). Executed by a Fable agent in an isolated worktree, **one commit**: the image
is byte-identical, so the second (behaviour) commit the brief allowed for was not needed and there
is **no `tests/golden/CHANGELOG.md` entry**.

| | commit | |
|---|---|---|
| 1 | the branch tip | `refactor(seepslope): report capture without switching the app` |

File set: `src/lib/cpt-app/legacy-controller.js` (the import block and the Stage 7 capture region
only), new `src/lib/cpt-app/seepslope/report/{capture,index}.js`, `src/lib/cpt-app/report/`
(`deps.js` wiring + three header comments), new `scripts/verify_seepslope_report.mjs`, this report.
`package.json`, `tests/**`, `scripts/golden/**`, `src/lib/styles/**`, every other
`seepslope/**` package and every class attribute untouched.

`npm run golden:check` **2 086 / 0 / 0 / 0**. `legacyApi` **167 names**, unchanged.
Controller **5 514 → 5 488** lines.

---

## 1. What the capture was, and what it is now

`stage7CaptureBishopWorkspaceView(workspace)` is the report's fallback when the engineer never
pressed "Capture for report": `buildStage7Payload()` calls it once per annex (stability, seepage,
deformation) through `deps.captureBishopWorkspaceView`. It could only photograph what was on screen,
so it *made* the screen show it (base 5193-5266):

```js
prevApp = stage6.app; prevWorkspace = bishop.workspace;
stage6.app = 'bishop'; bishop.workspace = targetWorkspace;   // ← writes S.stage6
syncBishopCanvas();                    // renderStage6() + initStage6BishopCanvas() (auto-fit!) or a redraw
const image = stage7CaptureCanvasImage('stage6BishopCanvas');
…
finally { stage6.app = prevApp; bishop.workspace = prevWorkspace; syncBishopCanvas() | renderStage6(); }
```

PR 18e made that unnecessary and said so (report 27 §7.5): `buildCanvasViewModel` is pure and
`drawCanvasFrame(ctx, vm, theme)` takes **any** 2D context. So the capture is now an ordinary frame,
painted on a canvas nobody ever sees:

```js
captureWorkspaceImage(state, results, options) → {mimeType, width, height, dataUrl}
```

with `state = {bishop, model}`, `results = {workspace, width, height, dpr}` and `options` the host's
three impure pieces (`createCanvas`, `theme`, `env`). The workspace is an override on a **shallow
copy** of the block — `canvasWorkspace(bishop)` is the only thing the view model reads it for — not a
write to `bishop.workspace`.

### 1.1 The package — `seepslope/report/capture.js` (311 lines)

| Export | From | Note |
|---|---|---|
| `captureWorkspace` | base 18001-18006 (`targetWorkspace`) | the three-way switch; anything else is `stability` |
| `isCaptureWorkspace` / `CAPTURE_WORKSPACES` | 17955 (`valid`) | the manual button's guard |
| `workspaceHasContent` | 18007-18012 (`hasContent`) | mesh+result / result / `allResults.length` |
| `autoCaptureDisplay` | 18046-18066 | the **nine-flag** seepage projection, the clamped stability pair |
| `manualCaptureDisplay` | 17968-17978 | deliberately *different*: it clones the display and does not clamp |
| `captureViewport` | 4685-4687 + `fitViewport` | see §1.3 |
| `rasteriseCanvas` | `stage7CaptureCanvasImage` 17916-17951 | the ≤ 1400 px down-scale, white fill, JPEG 0.9 |
| `renderWorkspaceFrame` | `stage6BishopDrawCanvas`'s host half 4764-4810 | backing store, `setTransform(dpr,…)`, view model, `drawCanvasFrame` |
| `captureWorkspaceImage` | — | the brief's `(state, results, options) → dataURL` |
| `captureBishopWorkspaceView` | 18042-18069 | the annex entry, key for key, in the same order |
| `bishopWorkspaceCapture(cpt, host)` | — | `deps.captureBishopWorkspaceView(workspace)` bound to one CPT |
| `bishopCanvasProbeHtml` | `seepslope/panels/layout.js` | §1.2 |

No `S`, no DOM, no canvas element, no clock, and **nothing writes**. Dependencies:
`seepslope/canvas` (`buildCanvasViewModel`, `canvasWorkspace`, `canvasWorldBounds`,
`drawCanvasFrame`, `fitViewport`) and `report/clone.js` (`safeClone`).

### 1.2 The one thing the package cannot know: how big the canvas is

Today's image is the *live* canvas: `round(cssWidth·dpr) × round(cssHeight·dpr)`, painted under
`setTransform(dpr,0,0,dpr,0,0)` from a view model built with the **CSS** width and height, then
down-scaled and encoded. Reproducing it offscreen therefore needs the box the canvas has — or would
have. The host resolves it in `stage6BishopCanvasBox()`:

1. the live `#stage6BishopCanvas` when the Seep / Slope app is open (the common case, and exactly what
   the monolith measured);
2. otherwise a **zero-height probe**: `bishopCanvasProbeHtml()` is the class chain
   `panels/layout.js` puts the canvas in — `.mc2.st6-bishop › .st6-bishop-layout[--settings-collapsed]
   [--settings-wide] › (.st6-bishop-side.st6-bishop-settings-panel) › .st6-bishop-main ›
   .st6-bishop-canvas-wrap › .st6-bishop-canvas-stage › canvas.st6-bishop-canvas`. Appended to
   `#stage6Area` (a plain block whose children all get its content width, and which holds the app body
   as a direct child), measured and removed inside one task, so nothing is painted, no state is
   touched and the real stylesheet does the arithmetic. The verifier asserts every class in the probe
   is a class the layout really emits;
3. otherwise `null` — Stage 6 is not laid out (`.panel` is `display:none`, e.g. the report is built
   from the Stage 4 or Stage 5 button), the state in which the monolith measured a 0 × 0 canvas and
   `stage7CaptureCanvasImage`'s `!canvas.width` guard returned null too. Confirmed identical in a real
   browser (§5.2, `hidden`).

The empty settings panel is in the probe so the grid places the main column in the cell it really
occupies whichever of the two layout modifiers is on; `settingsCollapsed` is the render's own
hard-coded `true` (`panels/view-model.js:84`, PLAN §6 "three write-only UI flags") and `settingsWide`
is `ui.bishopSettingsWide === true` (:85).

### 1.3 The auto-fit, reproduced without writing it back

The monolith's app-switch branch re-rendered, and the Bishop post-render runs
`initStage6BishopCanvas` → `stage6BishopAutoFitViewportIfNeeded()`, which **writes** a fitted viewport
into `S.stage6` before the frame is drawn. `captureViewport(bishop, model, width, height)` reproduces
the fit for its own frame (`fitViewport(canvasWorldBounds(bishop, model), width, height)` merged onto
the block's viewport) and does not write it back. On screen `fitted` is true by the time a report can
be built — every Bishop render ends in the same auto-fit — so this branch is only reachable through a
state loaded with `fitted:false`; the verifier records that the viewport was already fitted in the
matrix it ran.

### 1.4 What deliberately stayed in the controller (147 lines, was 185)

| Name | Why |
|---|---|
| `stage7OffscreenCanvas(w, h)` | `document.createElement('canvas')` + the monolith's `instanceof HTMLCanvasElement` guard, moved from the source canvas to the target one — so SSR and the Node golden harness still get **no image** |
| `stage6BishopCanvasBox()` | `getBoundingClientRect`, `devicePixelRatio` and the probe's DOM |
| `stage7CaptureHost()` | the four hooks (`ensure`, `box`, `model`, `createCanvas`, `theme`, `env`), value-or-function as PR 18a's convention |
| `stage7CaptureCanvasImage(id, opts)` | reads `#stage6BishopCanvas` **by id** — the manual button's source |
| `stage7CaptureWorkspaceView` / `stage7ClearWorkspaceCapture` | the toolbar button: it writes `S.stage6` and re-renders **on purpose** (the badge). Only its `valid` array and its `display` branch moved |
| `stage7CaptureBishopWorkspaceView(workspace)` | the façade: `bishopWorkspaceCapture(S, stage7CaptureHost())(workspace)` |

### 1.5 The model, and why the host still writes one cache line

`stage7CaptureHost().model()` is the frame's own line (`stage6BishopDrawCanvas` 4797-4798), the
volatile cache write included:

```js
const model = buildBishopModelFromStageLayers(stage6WorkingLayers(), S.stage6.bishop);
S.stage6Cache.bishopModel = model;
```

`S.stage6Cache` is not `S.stage6` — PR 18e already kept this write in the host sequencer — and it
matters here: `stage7SeepagePayload` reads `stage6Cache.bishopModel` back **after** the stability
capture has run, so dropping the write would change `buildStage7Payload()`. Nothing else is written.

## 2. The wiring (`report/deps.js`)

```js
captureBishopWorkspaceView: over.captureBishopWorkspaceView || bishopWorkspaceCapture(cpt, over.captureHost)
```

The default is now the package capture bound to the CPT and to `over.captureHost`; without a host it
is still `() => null`, so a payload built under Node has no image exactly as before. The controller
keeps passing its own façade under the dep name PR 8 gave it — `scripts/verify_export_report.mjs:691`
pins that line, and the façade *is* the same `bishopWorkspaceCapture(S, stage7CaptureHost())` value —
so both paths lead to `seepslope/report/capture.js` and nothing downstream changed. The composition
root (step 10) can drop the façade and pass `captureHost` straight through.

## 3. `scripts/verify_seepslope_report.mjs` — **192 passed, 0 failed**

Pattern of `verify_seepslope_{state,model,run,geometry,canvas,panels}.mjs`: two child processes, each
loading one controller through the Tier-B loader in its own Vite server, dumping the same observations
as JSON; the parent compares byte for byte. Both controllers are materialised with the **same**
appended `export { … }` block. `--base <ref>` / `--snapshot f.json` / `--against f.json`.
≈ 9 min wall-clock.

**How a data URL is compared under Node.** There is no rasteriser in Node, so both controllers get a
canvas whose 2D context *records* every call and every property assignment in order (report 27 §4's
device) and whose `toDataURL(mimeType, quality)` returns

```
data:<mimeType>;q=<quality>;w=<w>;h=<h>;calls=<n>;sha256=<sha of the call log>
```

`drawImage(source, …)` records the **source canvas' own call-log digest**, so the down-scale carries
the whole painted frame into the final digest. `setTransform` delimits a frame — the host issues it
exactly once per frame and nothing in `seepslope/canvas/**` ever touches the transform — so a canvas'
log is always *the calls that produced the pixels it holds now*, which is what makes a live canvas the
base drew three times comparable with a freshly created offscreen one. Two byte-identical data URLs
here therefore mean: the same context calls, in the same order, with the same arguments, on canvases
of the same size, asked for the same encoding. **The pixels themselves are proved in a real browser
(§5.2)** — that is where a JPEG can actually be encoded.

Both `#stage6BishopCanvas` and every `document.createElement('canvas')` get `HTMLCanvasElement` on
their prototype, so the monolith's `instanceof` guard passes and the base really does take its
"switch the app, re-render, read the live canvas" path.

| Group | What |
|---|---|
| (a) the capture — **36 captures** | the seeded `loadDemo()` CPT and the first CPT of `legacy-v0.5.2`, `multi-3cpt`, `single-layered`, each with a real in-process `analyzeBishopSearch` (10 circles), a real `analyzeSeepageModel` on the app's own model and a real js-cpu linear-elastic `analyzeDeformationModel` written in as the run reducer writes it — × the three workspaces × three host states: **same workspace** (no switch), **another workspace** (`bishop.workspace` was written) and **another Stage 6 app** (`S.stage6.app` was written and Stage 6 re-rendered twice). Compared: the whole returned view — `workspace`, `app`, `capturedAt`, `display`, `viewport` and `image {mimeType, width, height, dataUrl}` — under a **frozen `Date`**, so `capturedAt` is compared rather than masked |
| (b) `buildStage7Payload()` — **24 builds** | every host state, **with and without a stored manual capture** (the payload prefers the manual one and only then calls the automatic capture, so both branches run), byte-identical as a sha + chunked hash list. ≈ 475 kB each. Only wall-clock keys are masked, and the masked key list is itself compared: `generatedMs, meshMs, postMs, solveMs, totalMs` |
| (c) the UI is not perturbed | the working tree: `S.stage6` byte-identical, `S.stage6.app` / `bishop.workspace` / the active CPT unchanged, and **zero** rewrites of `#stage6Area` — per capture *and* per `buildStage7Payload()`. The base: asserted as "either shows the defect or already carries the fix", and it shows it — **12 re-renders of `#stage6Area` in 36 captures**, 0 in the working tree |
| (d) the manual button — **16 states** | `stage7CaptureWorkspaceView` in each workspace on each fixture plus the cleared state: `bishop.capturedView` identical in both controllers (it writes and re-renders on purpose; only its `display` branch moved) |
| (e) the package standalone | **the offscreen frame issues exactly the live frame's draw calls** in all three workspaces (stability 21 783, seepage 1 530 414, deformation 328 774 characters of call log, identical); `renderWorkspaceFrame` mutates neither the block nor the model and two frames agree; the three-way workspace switch and the `valid` array; the nine-flag seepage projection **in key order**; `manualCaptureDisplay ≠ autoCaptureDisplay` for seepage and `null` for an unknown workspace; `workspaceHasContent`; the down-scale arithmetic at six sizes (800×400 → 800×400, 2800×1120 → 1400×560, 0×0 → null); the defaults 1400 / 0.9 / `image/jpeg`; **every class in the probe is a class the layout really emits**; `report/deps.js` builds the same capture from `over.captureHost`, still `() => null` without one, and an explicit override still wins; the three null guards (no block, no box, no real canvas); the five monolith names survive; and the controller's capture region **no longer contains `renderStage6()`, an `app =` / `workspace =` write or `initStage6BishopCanvas`** |

`package.json` line for the main session (**not** added here, as briefed):

```json
"verify:seepslope-report": "node scripts/verify_seepslope_report.mjs",
```

and into `verify:core` after `verify:seepslope-panels`.

## 4. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` | **2 086 / 0 / 0 / 0**, 62 s — every suite bit-identical, `report` 22 and `report-svg` 48 included |
| `node scripts/verify_seepslope_report.mjs` | **192 / 192** |
| `npm run verify:core` | **exit 0** — every step green: `verify:handlers` (335 files, 429 inline `on*=`, 180 published, **legacyApi 167**), core-helpers 18, model-params 188, classification-layers 260, load 45, **export-report 57**, bearing 519, pile 586, settlement/dewatering/beam 2 260, seepslope-state 1 110, -model 1 301, -run 1 255, -geometry 1 833, -canvas **1 142**, -panels **1 980**, project-section-tuning 208, and the rest |
| `node scripts/verify_export_report.mjs` | **57 / 57** |
| `npm run build` | `✔ done`, exit 0; the three worker chunks emitted as before |
| `npm run check` | 572 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `seepslope/**` |
| `GOLDEN_PORT=5699 GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs` | **5 passed**, 1.2 min — all five journeys, state and DOM text byte-identical. `seep-slope-journey` 13 steps / 20.3 s (search 874 ms, seepage 225 ms, deformation 879 ms), **no `09-seepage-bcs` flake**. The 45 `visual (soft)` PNG mismatches are the pre-existing machine-wide browser-journey drift (PLAN §6, report 22 §5.1) |
| `PW_PORT=5499 npx playwright test --project=visual --workers=1` | **14 passed**, 3.0 min — **0 px**, the rekennota print-PDF gate included |
| the capture, rasterised base vs tree in a real browser (§5.2) | **24 / 24 JPEG data URLs byte-identical** |

### 4.1 The worktree needs its own dev server (`server.fs.allow`)

Worth writing down, because it looks exactly like a total regression and is not one. Both Playwright
configs start `npx vite dev` with the **repo's** `vite.config.ts`, which has no `server.fs.allow`. In
an agent worktree `node_modules` is a symlink to the real tree, so every
`/@fs/…/madep-cp/node_modules/…` request is answered **403**, the SvelteKit client entry never loads,
and every journey fails at its first interaction with a bare `waitForFunction` timeout and a page
snapshot that looks like a dead app:

```
console: Failed to load resource: the server responded with a status of 403 (Forbidden)
pageerror: Failed to fetch dynamically imported module: …/node_modules/@sveltejs/kit/src/runtime/client/entry.js
```

The fix is report 27 §5's recipe: start the servers yourself on 5699 / 5499 from **inside** the
worktree with a scratch `.mts` config carrying `server.fs.allow += <real node_modules path>` (and the
`.svelte-kit/{output,generated}` / `build` watcher ignores), then let `reuseExistingServer: true` pick
them up. One more correction to add to the recipe: the scratch config must live **in the worktree**,
not in a scratchpad outside it — Vite loads it with Node's resolver, and from `/tmp` it cannot find
`@sveltejs/kit` or `vite` at all.

## 5. The proof that the image did not change

### 5.1 Under Node — the whole draw-call log

Group (e) compares `stage6BishopDrawCanvas()`'s log with `renderWorkspaceFrame`'s for the same state
and the same box, in all three workspaces: 1.88 M characters of `moveTo` / `lineTo` / `arc` /
`fillStyle` / `font` calls, identical. Group (a) then compares the encoded data URL — a digest over
that log plus the down-scale and the encoding arguments — for 36 captures across four fixtures and
three host states, base against working tree.

### 5.2 In a real browser — the JPEG bytes

A throwaway Playwright script (kept in the session scratchpad, like report 27 §5.1 run 2) drove the
app on `layered.gef` through the seep-slope journey's own setup — terrain, entry/exit zones, phreatic
line, a wall and a surface load placed with **real pointer clicks**, then a real Bishop + Spencer
search (10 circles, 747 ms), a real seepage solve and a real deformation solve — and then called
`window.buildStage7Payload()` (the user's path: no manual capture is stored, so the payload calls the
automatic capture once per annex) in four host states × two device pixel ratios, recording the three
annex `image.dataUrl` strings. The four changed files were then swapped for their `integration-r`
versions (`git stash`) and the same script re-run.

| | dpr | image | base | working tree |
|---|---|---|---|---|
| stability | 1 | 1138 × 560 | 53 579 B `e719a00f43ea` | 53 579 B `e719a00f43ea` |
| seepage | 1 | 1138 × 560 | 83 675 B `b6409adb40be` | 83 675 B `b6409adb40be` |
| deformation | 1 | 1138 × 560 | 82 379 B `33a98a9e96b5` | 82 379 B `33a98a9e96b5` |
| stability | 2 | 1400 × 689 | 74 867 B `322c5e4de0fc` | 74 867 B `322c5e4de0fc` |
| seepage | 2 | 1400 × 689 | 108 987 B `64593ed36e87` | 108 987 B `64593ed36e87` |
| deformation | 2 | 1400 × 689 | 103 155 B `a49f971248cf` | 103 155 B `a49f971248cf` |

**24 / 24 byte-identical** (4 host states × 3 annexes × 2 DPRs), 0 page errors on either side, and the
view metadata — `viewport`, `display`, `image.width/height` — identical too. The four host states
were: the app already on the captured workspace, the app on another workspace, **the app not on Bishop
at all** (the probe path of §1.2 — the probe measured the very same 1138 px box the base's re-render
produced) and the settings column set wide. dpr = 2 exercises the `setTransform(dpr,…)` backing store
*and* the 1400 px clamp (2276 → 1400).

The same run is the behaviour evidence:

| | base | working tree |
|---|---|---|
| `#stage6Area` rewritten during the capture (app not on Bishop) | **6 ×** (2 per annex) | **0** |
| `#stage6Area` content changed during the capture (other host states) | **yes** | **no** |
| `S.stage6` changed | no (restored in the `finally`) | no |
| Stage 6 not laid out (report built from Stage 4) | no image | no image |

And the payloads: identical after normalising the two per-session values a second browser run cannot
reproduce — the wall's `Date.now()`-derived id and `timing.avgMsPerTrial` — which is exactly what
group (b) compares byte for byte under Node with a frozen clock.

## 5.3 `seepslope/results/` (report 28 finding 5) — **not taken**

The brief allowed it "only if it falls out cleanly". It does not, for three reasons:

1. **It is not in this PR's file set.** The producers are `stage6BishopWallResult*` /
   `stage6BishopWallQuantity*` / `stage6BishopSelectedResult` (controller 3699-3860) and the two
   contour catalogues (≈ 2383 and ≈ 2833) — four regions of the controller a capture PR must not
   touch, and none of them is read by `seepslope/report/capture.js`. The capture reaches them the way
   every frame does, through `SEEPSLOPE_CANVAS_ENV`, and gains nothing from their moving.
2. **The hooks it would retire belong to two other packages.** Dropping 8 hooks from
   `SEEPSLOPE_PANELS_ENV` and 6 from `SEEPSLOPE_CANVAS_ENV` means editing `seepslope/panels/**` and
   `seepslope/canvas/**` and re-running both their verifiers with a `--base` at the commit before —
   ≈ 35 min of gate on top of a change with no relation to the capture.
3. **Its byte-identity proof is a different proof.** The contour catalogues feed every seepage and
   deformation frame *and* every results panel, so the move has to be locked by
   `verify_seepslope_canvas.mjs`'s 1.78 M draw calls and `verify_seepslope_panels.mjs`'s 62.3 M
   characters of HTML — i.e. exactly the two suites PR 18e and PR 18f built. It is its own PR, and
   the last non-trivial Seep / Slope region left in the controller (report 28 §7.4).

## 6. Findings

1. **The monolith's capture was already restoring the state; what it could not undo was the work.**
   `S.stage6.app` and `bishop.workspace` come back in the `finally`, so a naive before/after
   comparison sees nothing. The observable difference is the *re-rendering*: building a report from a
   non-Bishop Stage 6 app rewrote `#stage6Area` six times (twice per annex — switch and restore), each
   a full `renderStage6()` with `syncSoilModel`, `syncSeepageState`, the scroll/`<details>`
   save-restore and a canvas re-bind, and the user saw an app they had not opened flash past three
   times. Both verifiers count the rewrites rather than diffing the state.
2. **The auto-fit was a real state write, and it is the one piece of the old behaviour that had to be
   *reproduced* rather than dropped.** The switch branch's re-render fitted an unfitted viewport into
   `S.stage6` and then drew with it; `captureViewport` fits for the frame only. Without it a state
   loaded with `fitted:false` would have been photographed at a different zoom.
3. **The capture is the last reader of `S.stage6Cache.bishopModel` in the payload chain.**
   `stage7SeepagePayload` reads the cache *after* the stability capture has run, so the frame's cache
   write is load-bearing for `buildStage7Payload()` byte-identity, not an artefact. A `seepslope/`
   composition root should make the payload take the model explicitly instead.
4. **The manual capture and the automatic one record different `display` blocks, and always have.**
   The manual button clones `seepage.display` / `deformation.display` as they are and does not clamp
   `selectedResult`; the automatic one projects nine named seepage flags with the render's defaults
   and clamps `selectedResult` to the result count. Both are kept verbatim as two exported functions,
   and the verifier asserts they differ — it looks like a bug on first reading and is not one to
   change inside a pure move.
5. **The report image already varied with the screen, and now it varies with the layout instead.**
   The capture is `min(1, 1400 / round(cssWidth·dpr))` of the live canvas, so the same project printed
   from a 1× laptop and a 2× display gives 1138 × 560 and 1400 × 689. That is unchanged here (it is
   what "byte-identical" means), but with the frame now built from a box rather than read off the
   screen, a **fixed report resolution** is a two-line change in `stage6BishopCanvasBox()` and would
   make the printed annex reproducible. It is a deliberate behaviour change with a golden entry, so it
   is not in this PR.
6. **`bishopCanvasProbeHtml` is a second place that knows the Seep / Slope layout classes.** It is
   asserted against the classes `bishopAppHtml` really emits (group (e)), so it cannot drift silently,
   but PR 19 (`style(seepslope)`) must update it in the same pass — it is listed in §7.

## 7. Follow-ups (not in this PR)

1. Main session / harness owner: `"verify:seepslope-report": "node scripts/verify_seepslope_report.mjs"`
   in `package.json`, and into `verify:core` after `verify:seepslope-panels`.
2. **`01-monolith-map.md` §3.4 #10 and §6.3 item 7 can be struck**: the Stage 7 capture no longer
   mutates app/workspace state, so "report generation is not side-effect free" is no longer true.
   §2.14's line for `stage7CaptureBishopWorkspaceView` ("temporarily switches
   `S.stage6.app`/`bishop.workspace`, re-renders, draws, restores") is now wrong, and its
   `stage7CaptureCanvasImage` line ("offscreen canvas → dataURL") now describes the whole capture.
   The map is not in this PR's file set. (PLAN §4's five defects are untouched — the capture was
   never one of them; it was mapped, not listed there.)
3. **PR 19 (`style(seepslope)`)**: `bishopCanvasProbeHtml` in `seepslope/report/capture.js` carries the
   canvas' class chain and must move with `panels/layout.js`; `scripts/verify_seepslope_report.mjs`
   asserts the two agree, so the gate will catch it.
4. **A fixed capture resolution** (finding 5) and **the report taking the section model explicitly**
   (finding 3) — one behaviour commit each, with a golden case.
5. Step 10 (composition root): `stage7ControllerDeps()` can pass `captureHost` instead of the façade,
   and `stage7CaptureBishopWorkspaceView` — module-local, not on `legacyApi` — can go.
6. Harness owner: consider adding `server.fs.allow` to the repo's `vite.config.ts` (§4.1) so an agent
   worktree's browser suites work with the configs as committed, instead of every agent rediscovering
   the 403.
