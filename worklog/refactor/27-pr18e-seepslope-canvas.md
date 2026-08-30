# 27 — PR 18e `refactor(seepslope): canvas — viewport, pointer, and the draw layers`

Base `integration-r` @ 3b84193 (v0.6.0 tip; controller 10 420 lines, PR 18a–d merged), the fifth
Seep / Slope sub-step of `01-monolith-map.md` §6.2 step 9 (PLAN §2 row 18e; map §2.11 groups
**"Canvas interaction"** and **"Canvas draw"**, §6.1 rows `canvas/viewport.js`, `canvas/snap.js`,
`canvas/pointer.js`, `canvas/draw/*.js`, and §6.3 item 4 — the 1 139-line `stage6BishopDrawCanvas`
"must be split by draw layer **with an explicit view-model**"). Executed by a Fable agent in an
isolated worktree, **one commit** — a pure move, no behaviour change, no
`tests/golden/CHANGELOG.md` entry.

| | hash | |
|---|---|---|
| 1 | `3d34e76` | `refactor(seepslope): canvas — viewport, pointer, and the draw layers` |

File set: `src/lib/cpt-app/legacy-controller.js` (the import block and the canvas region only),
new `src/lib/cpt-app/seepslope/canvas/**` (21 files), `src/lib/styles/theme.ts` (additive:
`seepslopeVizSeries()`), new `scripts/verify_seepslope_canvas.mjs`, this report. `package.json`,
`tests/**`, `scripts/golden/**`, `seepslope/{state,model,run,geometry,probe}/**`, the panel and
results regions (step 9f), `report/capture.js` (9g), every HTML string and every class attribute
untouched; nothing under `retaining/`, `import-review/` or `components.css`.

`npm run golden:check` **2 086 / 0 / 0 / 0**. `legacyApi` **167 names**, unchanged
(handler verifier: 295 files scanned, 429 inline `on*=` attributes, 180 published, every inline
handler resolved).

---

## 1. What moved

Line numbers are `integration-r` @ 3b84193. The region is contiguous: **5322-7409**, 2 088 lines —
the map's "Canvas interaction" group in full plus `stage6BishopDrawCanvas` and
`initStage6BishopCanvas`. It comes back as **371 lines** of façades, `env` objects and the frame's
host half.

### 1.1 `canvas/viewport.js` — world ↔ screen, and every px → world tolerance

| Monolith (old) | New export | Change | Controller now |
|---|---|---|---|
| `stage6BishopWorldToScreen` 5417 | `worldToScreen(pt, viewport)` | the `S` read became the second parameter | façade (also the `window.__bishopTest.worldToScreen` hook) |
| `stage6BishopScreenToWorld` 5406 | `screenToWorld(sx, sy, viewport)` + `screenToWorldFromClient(rect, clientX, clientY, viewport)` | the one `canvas.getBoundingClientRect()` hoisted out | façade reads the rect |
| `stage6BishopSnapToleranceWorld` 5425 | `snapToleranceWorld(viewport)` | signature | façade |
| `stage6BishopBoundaryPickToleranceWorld` 5322 | `boundaryPickToleranceWorld(viewport)` | signature — **the name PR 18d had to leave behind** (report 26 finding 2) | façade; `pickRegionBoundaryPoint`'s tolerance hook now resolves through it |
| `stage6BishopCanvasWorldBounds` 5537 | `canvasWorldBounds(bishop, model)` | signature (`sortedPolyline` / `wallEndpoints` imported) | façade |
| `fitStage6BishopViewport` 5564 | `fitViewport(bounds, rectWidth, rectHeight) → {scale, offsetX, offsetY, fitted}` | the **pure half**; the host still does `ensureStage6State()`, finds the canvas, measures it and redraws, and `Object.assign`s the four keys onto the live viewport object (identity and key order kept) | 9-line handler |
| `stage6BishopWheel` 6209 (zoom maths) | `zoomAtPoint(viewport, localX, localY, deltaY)` | the pure half | in `pointer.wheel` |
| `stage6BishopPointerMove` 6032 (pan maths) | `panOffsets(drag, clientX, clientY)` | the pure half | in `pointer.pointerMove` |
| `stage6BishopDrawGrid` 6221 (bounds maths) | `gridSpec(viewport, width, height, snapSize)` | the pure half; the strokes are `draw/background.js` | façade (no caller left) |
| the two inline `viewport.scale` divisions | `surfaceLoadPickHeightWorld`, `measurementLabelOffsetWorld` | the surface-load hit box (22 px, ≥ 0.8 m) and the Measure label offset (12 px, ≥ 0.2 m) were written out at their use site; they are px → world conversions and belong with the others | — |

`VIEWPORT_LIMITS` collects the twelve pixel constants (14 px snap, 12 px handle, 28 px fit margin,
8 / 4 / 220 px·m⁻¹ scale floors and ceiling, the 1.08 zoom factor, the 18 px grid cutoff, and the
`|| 24` fallback every `viewport.scale` division carried).

### 1.2 `canvas/picking.js` — snapping, hit tests, and the two committing gestures

| Monolith (old) | New export | Change | Controller now |
|---|---|---|---|
| `stage6BishopCurrentDragKey` 5430 | `currentDragKey(drag)` | signature | façade |
| `stage6BishopSnapPointKey` 5437 | `snapPointKey` | none | façade |
| `stage6BishopCollectSnapPoints` 5441 | `collectSnapPoints(bishop, excludeKey)` | the live drag read became `excludeKey`, a string **or a function** (the value-or-function convention of PR 18a / 18d, so the drag is read at the same statement) | façade |
| `stage6BishopNearestPointSnap` 5493 | `nearestPointSnap(pt, mode, bishop, viewport, excludeKey)` | signature | façade |
| `stage6BishopSnapWorldPoint` 5513 | `snapWorldPoint(…)` | signature | façade |
| `stage6BishopNearestHandle` 5590 | `nearestHandle(bishop, viewport, rect, clientX, clientY, selectedRegion)` | the rect the monolith read **twice per candidate** inside its distance helper is a parameter; `selectedCustomRegion` is a value-or-function, called only when there are custom regions | façade |
| `stage6BishopPickSurfaceLoadAtWorld` 5643 | `pickSurfaceLoadAtWorld(bishop, world, viewport)` | signature | façade |
| `stage6BishopPickWallAtWorld` 5664 | `pickWallAtWorld(bishop, world, viewport)` | signature | façade |
| `stage6BishopCommitDrawPoint` 5680 (185 lines) | `commitDrawPoint(bishop, world, viewport, env, excludeKey)` | mutates the very block it is handed (so identity is kept) and reaches the host through `env` — 16 callbacks, each called at the statement the monolith called it. The two duplicated inline wall literals became one `newWall()` (report 21 follow-up 3, report 26 follow-up 2) | façade |
| `stage6BishopCompleteCurrentActionAt` 5865 | `completeCurrentActionAt(…)` | as above, same `env` | façade |
| the `else if` chain of `stage6BishopPointerMove` 6032 | `dragHandleTo(bishop, drag, world, viewport, excludeKey) → boolean` | new: the per-kind handle move, `false` where the monolith `return`ed **without redrawing** (a zero-length terrain / phreatic edge, an invalid region polygon, a vanished entity) | in `pointer.pointerMove` |

### 1.3 `canvas/pointer.js` — the state machine

`{down, move, up, cancel, leave, wheel}` over one `ctx = {bishop, viewport, canvasState, rect()}`.
`canvasState` is the host's three-field handle (`{canvas, pointerDrag, hoverWorld}`) and *is* the
machine's memory: `pointerDrag === null` is idle, otherwise one of the thirteen handle kinds or `'pan'`.

`stage6BishopUpdateHoverDom` 5339 splits into `hoverUpdate(ctx, clientX, clientY, env, wantTip)` —
which returns `{world, snapped, coordText, tip}` with `tip` `null` (hide), `{html, left, top}`
(show) or `undefined` (the host asked for none) — and a 20-line controller façade that performs the
four DOM writes. The three tooltip bodies are HTML, so they stay with the other HTML strings until
step 9f, as `seepslopeCanvasTooltipEnv(canvas, model)`.

**Effects.** Every transition returns an ordered effect log. `{type:'preventDefault'}` is the one
effect the host performs *after* the transition returns — a browser default action happens after
the handler, so its position inside cannot matter. The rest stay `env` callbacks called at the
monolith's statement and logged (`hover`, `draw`, `render`, `hideHover`, `setPointerCapture`,
`releasePointerCapture`), because their position **is** observable: a draw between two writes is
what the user sees, and `renderStage6()` replaces `#stage6Area`'s innerHTML — the canvas the gesture
started on is gone afterwards, so the capture release has to happen before `up`'s invalidation, not
after the transition. Logging them is what makes the order assertable without a DOM; the verifier
drives the machine with a recording `env` and compares the log (§4 group (d)).

### 1.4 `canvas/view-model.js` — the key step

`stage6BishopDrawCanvas` opened with a run of local `const`s and then closed over them from fourteen
drawing blocks. That closure is what made it unsplittable, and §6.3 item 4 named the fix. The run of
locals is now one pure function:

```js
buildCanvasViewModel({bishop, model, viewport, width, height, hoverWorld, excludeKey}, env)
```

**21 top-level derivations** (≈ 60 counting the nested ones): `workspace`,
`deformationAnalysisType`, `toScreen`, `snap`, `terrain`, `grid`, `regions` (`{show, showLabels,
items, preview, opacity, selectedId}`), `seepage` (`{mesh, result, display, contourMode,
contourDerived, stats}`), `deformation` (`{… dispScale, vectorMode, vectorReference,
deformedPoint}`), `circles` (`{results, keepBest, selectedIndex, previewCircle, selected}`),
`boundary` (`{edges, selected, hovered, showLabels}`), `cptMarker`, `editHandles`,
`selectedRegion`. Every guard is the monolith's, in the monolith's place: the seepage and
deformation blocks are only built when the workspace matches **and** a mesh **and** a result exist,
the boundary only in `seepage` with a model and `showBoundaryConditions !== false`, the handles only
in the `edit` tool.

**Nothing in the file writes.** PLAN §4 defect 3 / PR 18b's fix is now structural rather than a
convention: the view model is pure and the layers only paint, so a frame *cannot* mutate the state.
The one write the monolith did on the same line — `S.stage6Cache.bishopModel = model`, the volatile
model cache, not `S.stage6` — stays in the host sequencer. The verifier asserts the property
directly (§4 group (c)).

### 1.5 `canvas/draw/*.js` — fourteen layers and a sequencer

`draw/index.js` exports `DRAW_LAYERS`, the paint order written out once (it is what the visual
baselines lock, so it is never implied by import order), and `drawCanvasFrame(ctx, vm, theme)`:

| # | layer | file | monolith lines |
|---:|---|---|---|
| 1 | background | `background.js` `drawBackground` | 6267-6270 |
| 2 | grid | `background.js` `drawGrid` | 6271 → 6221-6251 |
| 3 | soil regions + labels | `regions.js` | 6299-6357 |
| 4 | seepage field (contours, lines, free surface, flow lines, exit gradient) | `seepage.js` | 6425-6484 |
| 5 | deformation field (contours incl. T6 sub-triangles, lines, plastic points, displacement vectors, both meshes) | `deformation.js` | 6486-6742 |
| 6 | phreatic line | `water.js` `drawPhreatic` | 7044 |
| 7 | drains | `water.js` `drawDrains` | 7045-7050 |
| 8 | the current draft | `water.js` `drawDraft` | 7051-7059 |
| 9 | the active tool's hover preview | `hover.js` | 7060-7158 |
| 10 | entry / exit windows + surface loads | `loads.js` | 7160-7202 |
| 11 | walls | `walls.js` `drawWalls` | 7203 |
| 12 | wall responses (deflection, M / V / N overlay, station dots, extremum callouts) | `walls.js` | 7204-7213 → 6852-7043 |
| 13 | the committed Measure line | `measurement.js` | 7214-7216 |
| 14 | slip circles, slices and wall reactions | `slip-circles.js` | 7218-7286 |
| 15 | terrain | `terrain.js` | 7288 |
| 16 | seepage boundary conditions + labels | `boundary-conditions.js` | 7290-7332 |
| 17 | the active-CPT marker | `cpt-marker.js` | 7334-7373 |
| 18 | the Edit tool's handles | `handles.js` | 7375-7390 |

(Eighteen entries for fourteen *layers*: water and walls each contribute more than one step, in the
monolith's order.) `primitives.js` holds the six helpers the monolith declared as closures inside
`stage6BishopDrawCanvas` and shared between blocks — `drawPolyline`, `drawPolylineArrows`,
`drawCircleArc`, `drawWall`, `drawLoadZoneMarkers`, `drawMeasurementOverlay` — each verbatim with
the context and the view model made parameters.

### 1.6 What deliberately stayed in the controller

| Name | Why |
|---|---|
| `stage6BishopHideHoverDom` 5332 | four DOM writes, no maths |
| `stage6BishopAutoFitViewportIfNeeded` 5586 | one `S` read + the handler |
| `initStage6BishopCanvas` 7392 | binds eight DOM handlers on the element |
| the frame's host half of `stage6BishopDrawCanvas` | the element, `getBoundingClientRect`, `devicePixelRatio`, the backing-store resize, `getContext('2d')`, `setTransform`, the `window.__bishopTest` E2E hook, the model build + cache, and the theme |
| the three tooltip bodies | HTML strings — step 9f |

## 2. The package

| File | Lines | Exports |
|---|---|---|
| `canvas/index.js` | 26 | the flat surface below + the `viewport` / `picking` / `pointer` / `viewModel` / `draw` namespaces |
| `canvas/viewport.js` | 213 | `worldToScreen`, `screenToWorld`, `screenToWorldFromClient`, `snapToleranceWorld`, `boundaryPickToleranceWorld`, `surfaceLoadPickHeightWorld`, `measurementLabelOffsetWorld`, `canvasWorldBounds`, `fitViewport`, `zoomAtPoint`, `panOffsets`, `gridSpec`, `VIEWPORT_LIMITS`, `EMPTY_WORLD_BOUNDS` |
| `canvas/picking.js` | 615 | `currentDragKey`, `snapPointKey`, `collectSnapPoints`, `nearestPointSnap`, `snapWorldPoint`, `nearestHandle`, `pickSurfaceLoadAtWorld`, `pickWallAtWorld`, `commitDrawPoint`, `completeCurrentActionAt`, `dragHandleTo` |
| `canvas/pointer.js` | 326 | `hoverUpdate`, `pointerDown`, `pointerMove`, `pointerUp`, `pointerCancel`, `pointerLeave`, `wheel`, `TIP_LAYOUT` |
| `canvas/view-model.js` | 199 | `buildCanvasViewModel`, `canvasWorkspace`, `handlePoints` |
| `canvas/draw/*.js` (16 files) | 1 339 | `DRAW_LAYERS`, `drawCanvasFrame`, the eighteen layer functions and the six primitives |

2 718 lines. SPDX + `@ts-nocheck`, a header naming the source lines and the contract, `.js`
imports. Dependencies outside the package: `seepslope/{state,geometry}` (PRs 18a / 18d),
`core/format.js`, `stage6-bishop.js` (`terrainY`), `wall-geometry.js`,
`deformation/{solver,wall-result-staleness}.js` and `src/lib/styles/theme.ts`. **No `S`, no DOM,
no canvas element, no clock.**

### 2.1 The two host `env` objects

`SEEPSLOPE_CANVAS_ENV` (**23 hooks**, read once per frame by the view model and by the two field
layers) carries only what a region that is *not* extracted yet owns:

* the deformation-contour catalogue — `NormalizedDeformationAnalysisType`, `ContourDerived`,
  `ContourValue`, `ContourColor`, `ContourLineColor`, `VectorMode`, `PlasticPointSets`,
  `FiniteScalarOrNull`, `AverageFiniteValues`, `T6VisualSubtriangles` (map §2.11 "Deformation
  contours");
* the seepage-contour catalogue — `ContourDerived`, `ContourValue`, `ContourColor`,
  `ContourLineColor` (map §2.11 "Seepage state + contours");
* the seepage BC lookup — `CurrentSeepageBoundary`, `SelectedBoundaryEdge`, `HoveredSeepageEdge`,
  `SeepageBcForEdge` (map §2.11 "Seepage BC handlers");
* the wall-response overlay and the selected search result — `SelectedResult`,
  `WallOverlayQuantity`, `WallNodeValuesForOverlay`, `WallQuantityFormat`, `CssColorWithAlpha`,
  `ContrastingTextColor` (map §2.11 "Result HTML / labels", step 9f).

`seepslopeCanvasEnv(canvas)` (**26 hooks**) is a *gesture's* effects: the six the machine logs, and
the twenty handlers a committed draw point ends in (`finishDraft`, `createDrainFromVertices`,
`splitSelectedRegion`, `createSurfaceLoadFromZone`, the four invalidators, `clearCustomRegions`,
the wall-id / passive-side / material allocators, …). Everything the packages already own —
`sortZone`, `validZone`, `zoneKey`, `zoneLabel`, `zoneColor`, `normalizeWalls`, `normalizeDrains`,
`clampRegionPoint`, `polygonIsValid`, `dist`, `selectedSurfaceLoad`, `selectedCustomRegion`,
`syncLegacySurfaceLoadMirror`, `displayRegions`, `regionShortLabel`, `polygonCentroid`,
`measurementMetrics` / `measurementLabel`, `pickRegionBoundaryPoint`, `effectiveSurfaceLoadQ`,
`defaultPassiveSide`, `wallResultIsStale`, `sampleDeformationState` — is imported directly, not
hooked. `sampleDeformationState` was the controller's last reader of `deformation/solver.js`, so
that import is gone.

## 3. Colours (`src/lib/styles/theme.ts`, additive)

`seepslopeVizSeries()` joins `vizTheme()` / `pileVizSeries()` / `retainingVizSeries()`. It is
resolved **once per frame** by the sequencer and handed to every layer as `theme`.

* **The six tokens the monolith already read per frame** now go through `token()` — the one-probe-
  per-token resolver of PR 15, which resolves any token form (`color-mix()` included) to an `rgb()`
  string a canvas can parse — with the monolith's own literal as the no-DOM fallback:
  `--bg` → `paper` (`#fff`), `--canvas-text` → `text` (`#213142`), `--canvas-text-halo` → `halo`,
  `--chart-blue` → `bcHead`, `--chart-green` → `bcSeepageFace` / `phreaticSolved`,
  `--chart-neutral` → `bcNoFlow`. All six resolve through `var()` chains that end in plain hex /
  `rgba()` literals, so the painted colour is identical; the browser check of §5.1 proves it.
* **The other 40 roles are still the monolith's literals**, named. PR 18e is a pure move whose gate
  is 0 px, so no colour may shift; naming them is what makes PR 19 (`style(seepslope)`, PLAN §2 row
  19) a one-file change — map each literal onto its `--viz-*` token there, with a re-baseline.

The four zone colours stay in `seepslope/state/surface-loads.js` (`zoneColor(kind)`, PR 18a): they
are also read by the tool rail and the panels, so PR 19 should move them into the series in the same
pass.

## 4. `scripts/verify_seepslope_canvas.mjs` — **1 142 passed, 0 failed**

Pattern of `verify_seepslope_{state,model,run,geometry}.mjs`: two child processes, each loading one
controller through the Tier-B loader in its own Vite server, dumping the same observations as JSON
with key order preserved; the parent compares byte for byte and prints the first differing path.
Both controllers are materialised with the **same appended `export { … }` block** (the PR 18d idea),
so the moved functions — module-local in the base, façades in the working tree — are directly
comparable. `--base <ref>` / `--snapshot f.json` / `--against f.json` as usual. ≈ 13 min wall-clock.

**The one new idea: a recording 2D context.** The Tier-B DOM stub hands every canvas the same
`new Proxy({}, …)` whose methods swallow their arguments, so `stage6BishopDrawCanvas` runs to
completion under Node but leaves no trace — which is why no golden and no verifier has ever covered
the 1 139-line draw path. This verifier replaces the bishop canvas' context with one that logs every
call and every property assignment in order — `fillStyle`, `strokeStyle`, `globalAlpha`,
`setLineDash`, every `moveTo` / `lineTo` / `arc` coordinate — and compares the two logs. That is what
makes "the rendered pixels must not change" checkable without a browser: the paint *is* the sequence
of calls the context receives. (`verify_settlement_dewatering_beam.mjs` introduced the idea for the
beam geometry preview; this is its first use on a real drawing.) The recorder keeps the stub's
`{width: 0}` return value so `ctx.measureText(t).width` still reads 0, and returns a function for
every property get so `typeof ctx.roundRect === 'function'` stays true — the monolith branches on it.

| Group | What |
|---|---|
| (a) the draw-call log — **464 frames, 1 776 402 recorded calls** | the seeded `loadDemo()` CPT and the first CPT of `legacy-v0.5.2` / `multi-3cpt` / `single-layered`, each driven through a 116-step matrix: the empty section, terrain, the entry / exit windows, three viewports (fitted / zoomed 3.5× / panned far out), the phreatic line, a wall, a drain and two surface loads drawn through `CommitDrawPoint`, the custom-region preview and the committed set, the four selections (region / wall / load / drain), **every one of the 14 tools × {no hover, hover, hover with the tool's own draft}**, the measurement, the three region display toggles, a **real in-process `analyzeBishopSearch`** (the bishop suite's reduced grid) with its second-best circle and its running preview circle, the seepage BC editor with and without labels and with the BC tool hovering an edge, a **real `analyzeSeepageModel`** on the app's own model followed by its 5 contour modes and 7 display toggles, a **real js-cpu linear-elastic `analyzeDeformationModel`** written in as the run reducer writes it followed by its 7 contour modes, 8 display toggles, 3 wall-overlay quantities, a 25× displacement scale, the `safety-cphi` catalogue and a wall hover, and 7 wall-response frames (both passive signs, a flat overlay, the overlay switched off, and the staleness guard with a mismatched and a matching `lastWallInputs` snapshot). Per frame: the **sha-256 of the whole call log**, its length, the per-method call counts, a chunked hash list (100 calls per chunk, so the parent names the first differing chunk), the head and tail verbatim, the model the frame cached, and whether `S.stage6.bishop` survived. **16 solved-workspace frames alone carry 141 694 calls**, and the logs carry 17 distinct fill / stroke colours, so the theme is part of what is compared |
| (b) the pointer state machine — **52 recorded events** | on `layered` under a seeded clock (1 s ticks) + PRNG (mulberry32) so entity ids are compared verbatim: hover on / off the section and `pointerleave`; a region drawn with four clicks and closed on its first point; a second draft completed with the **right button**; a terrain draft, `PopDraftPoint` and `Clear('draft')`; a wall drawn, then its head **grabbed, dragged over two moves and released**; a **click-without-drag on a handle with a solved seepage result present** (PR 18b's fix — the result must survive); point-snap and grid-snap clicks placed just off a terrain vertex and off a grid node; a **`pointercancel` mid-drag** and a move after it; a middle-button **pan**; **wheel** in, out, and 60 notches into the 220 px/m clamp; `fitStage6BishopViewport`; the three edit-mode selections (load, wall, custom region) and a click on empty space that starts a pan; the Measure tool and a right click with nothing to complete. After every event: exception, `S.stage6.bishop` (deep-equal **+ key order**), `S.stage6.ui`, `canvasState.pointerDrag` and `hoverWorld`, the `setPointerCapture` / `releasePointerCapture` log, `#stage6BishopTip` (display, left, top, innerHTML) and `#stage6BishopCoord`, the frame's draw-log sha and call count, the alerts, the rAF errors and the running id-call count (20, identical) — plus 11 assertions that the walk did what its labels say |
| (c) the draw path does not write — **5 scenarios × 8 frames** | a synced state, layers changed underneath, the strength set changed underneath, a hover point set, and the edit tool with a selection: `S.stage6.bishop` byte-identical before and after, **and the 8 frames identical to each other** (so nothing accumulates), in both controllers |
| (d) the package standalone (working tree) | the eighteen layers are sequenced in the documented order and every entry is a function; every monolith canvas name survives as a function **and** the package exports its body; **10 façades are asserted to be exactly their package function applied to the host state**; `worldToScreen`/`screenToWorld` round-trip exactly; the four tolerances are 14 / 22 / 12 px over the scale at 7 scales including 0, NaN, `undefined` and no viewport at all (the monolith's `|| 24` and `max(…, 1)`); zooming keeps the world point under the cursor; `fitViewport` centres with a 28 px margin and floors at 8 px/m; the grid hides itself below 18 px; `canvasWorldBounds` falls back to the monolith's `{0, 20, −10, 5}`; the **view model does not mutate the block it is handed** and exposes its 21 derivations; **picking never mutates** over the whole mode × point grid; the six drag keys are the monolith's strings; `pointerCancel === pointerUp`; and the machine's **effect log** for seven transitions — `down` with the middle button previews the pan and takes the capture, `move` without a drag only refreshes the hover, `up` without a drag does nothing at all, `leave` hides the hover and redraws, `wheel` prevents the default and redraws |

One masking decision, documented in the script: the cached model embeds the whole
`bishop.seepage` / `bishop.deformation` block, solver output included, and that carries wall-clock
durations. Only keys ending in `Ms` and not starting with `max` are masked — the five that actually
occur are printed and compared (`generatedMs`, `meshMs`, `postMs`, `solveMs`, `totalMs`), so a
configured budget like `maxRuntimeMs` stays compared and every other number in the model — every
node, every head, every stress — is compared byte for byte.

Entity ids are allocated from `Date.now()` / `Math.random()`, so the four steps of the matrix that
allocate one (the wall / drain / load commits, the region copy, the BC assignment) run under the
seeded clock and PRNG; the three solvers keep the real clock, so no internal time budget is
disturbed.

`package.json` line for the main session (**not** added here, as briefed):

```json
"verify:seepslope-canvas": "node scripts/verify_seepslope_canvas.mjs",
```

Like the other `verify_*` movers it needs the Vite dev dependency and a reachable base ref; on a PR
branch use `--base origin/main`, or `--against` a committed `--snapshot`.

## 5. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` | **2 086 / 0 / 0 / 0**, 70 s — every suite bit-identical with the files on disk, which `integration-r` @ 3b84193 already locked (`bishop` 71, `seepage` 41, `deformation` 37, `stage6-shared` 15, `chart-configs` 203, `report` 22 …) |
| `node scripts/verify_seepslope_canvas.mjs` | **1 142 / 1 142** |
| `npm run verify:core` | **exit 0** — every step green, including `verify:seepslope-state` 1 110, `verify:seepslope-model` 1 301, `verify:seepslope-run` **1 255** and `verify:seepslope-geometry` 1 833. (Report 26 finding 1's base drift is gone: 3b84193 made the run verifier tolerate a base that already carries the 18c fix.) Handler verifier: 180 published, **legacyApi 167** |
| `npm run build` | `✔ done`, exit 0; the three worker chunks emitted as before |
| `npm run check` | 532 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `seepslope/**` |
| `GOLDEN_PORT=5699 GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs --grep seep-slope` | **1 passed**, 13 steps, 24.6 s; state + DOM text byte-identical; bishop search 942 ms, seepage 231 ms, deformation 1 009 ms. **No `09-seepage-bcs` flake** (report 22 §5.2). The three `visual (soft)` mismatches (`01-bishop-empty`, `02-terrain`, `08-stability`) are the pre-existing machine-wide PNG drift of report 22 §5.1 |
| `PW_PORT=5499 npx playwright test --project=visual --grep "app journey"` | **4 passed** (2.5 min) — all four variants at `maxDiffPixels: 0`, `stage6-bishop-dock-card` included |
| `PW_PORT=5499 npx playwright test --project=visual` (all 14) | **13 passed, 1 failed** — see §5.2: a load-induced *capture* timeout, no pixel comparison ever ran; the failing spec passes on a re-run |
| the Bishop canvas, rasterised base vs tree (§5.1) | **19 / 19 PNGs byte-identical** |

Both browser suites ran against dev servers started from the worktree with a scratch `.mts` Vite
config under this session's scratchpad (report 19 §5 + report 22 §5.3), with **two corrections to
the recipe**:

* **Run it from the worktree** (`npx vite dev --config <scratch>.mts`), not with `root` set in the
  config. `sveltekit()` overrides `root` — it prints "The following Vite config options will be
  overridden by SvelteKit: - root" and then fails with `src/app.html does not exist`. The cwd is
  what it uses to find `svelte.config.js` and the project.
* **Ignore the generated trees explicitly.** Dropping the repo's `**/.claude/**` watcher ignore is
  necessary (the worktree *is* under `.claude/`, so keeping it silences everything) but not
  sufficient: an `npm run build` next to a running dev server rewrites `.svelte-kit/output/**` and
  `build/**`, the watcher invalidates the client module graph mid-run, and the next navigation dies
  with `Failed to fetch dynamically imported module … /.svelte-kit/generated/client/nodes/25.js` —
  an "Application Error" page that looks exactly like a regression. It cost one full visual run
  here (`report retaining — screen` timed out waiting for `.report-sheet`). The scratch config now
  ignores `**/.svelte-kit/{output,generated}/**`, `**/build/**`, `**/test-results/**`,
  `**/tests/visual/__screenshots__/**` and `**/tests/golden/**`, and the suite passes.

`server.fs.allow` += the real `node_modules` path as before. Ports 5499 (visual) and 5699
(journey); Playwright's `reuseExistingServer` picked both up.

### 5.1 The pixel proof

`--project=visual` hides every canvas in its page shots (`shotPage` → `screenshot.css`; chart
anti-aliasing is GPU-dependent, layout is not), so its 0 px covers the dock card, the tool rail, the
legends and the view menus around the canvas — not the canvas itself. The canvas needed its own
proof, and it got two:

1. **Under Node, the whole draw-call log**: 1 776 402 calls over 464 frames, byte-identical between
   the base and the working-tree controller (§4 group (a)). Every coordinate and every colour string
   the context ever receives, in order, for every state the matrix reaches — including 141 694 calls
   of real solved seepage, deformation and Bishop-search fields.
2. **In a real browser, the rasterised canvas**: a throwaway Playwright script drove the app on the
   seeded demo profile through 19 states — empty, terrain, zones + phreatic, wall / drain / load
   placed with **real pointer clicks**, custom regions, a solved Bishop search with its circles,
   slices and wall reactions, the seepage BC editor before and after the two side heads, the
   deformation workspace with vectors and the undeformed mesh, six tools' hover previews and the
   frame after the pointer leaves — screenshotting `#stage6BishopCanvas` each time. The two
   changed files were then swapped for their `integration-r` versions
   (`git checkout integration-r -- legacy-controller.js theme.ts`), the same script re-run, and the
   PNGs compared: **19 / 19 byte-identical**, 0 page errors on both sides, the same viewport to the
   last digit.

Run 2 is what proves the `theme.ts` change specifically. All six token reads are covered by it:
`--bg` paints every shot's background, `--canvas-text` / `--canvas-text-halo` paint the region
labels and the BC labels, and `--chart-blue` / `--chart-green` / `--chart-neutral` paint the
boundary-condition edges in `07-seepage-bcs-empty` and `08-seepage-bcs`. `token()`'s probe returns
`rgb(111, 143, 100)` where `getPropertyValue()` returned `#6F8F64` — a different *string*, the same
*paint*, and the byte-identical PNGs are the evidence.

What run 2 does **not** cover: the seepage and deformation **solves rejected on the demo profile**
(`status: "failed"` in both controllers, identically), so the solved-contour layers were not
rasterised in the browser. They are covered by run 1 on real solved fields, and the one token they
add (`phreaticSolved`) is the very same `token('--chart-green')` call that `bcSeepageFace` makes and
that run 2 does cover. A follow-up could drive the journey's `layered` fixture instead of the demo
to close that gap in the browser too.

### 5.2 The visual suite is capture-timeout-flaky on a loaded machine

Worth writing down because it looks exactly like a regression and is not one. `toHaveScreenshot`
has a 5 s expect timeout (`playwright.config.mjs` sets `maxDiffPixels: 0` but leaves
`expect.timeout` at its 5 s default), and the app journey takes ~40 full-page captures of a 1500 ×
950 page. On this box under load — three Vite servers, another agent's suites, `load average 45` —
the *capture* times out before any comparison happens:

```
Error: expect(page).toHaveScreenshot(expected) failed
  Timeout: 5000ms
  Snapshot: stage6-retwall-sheetpile--note--desktop-light.png
```

The tell is in `test-results/`: a failed **comparison** writes `-expected.png`, `-actual.png` and
`-diff.png`; a failed **capture** writes only `-expected.png` and the page's `test-failed-1.png`.
Every failure seen here was the latter, and the shot that timed out moved between runs
(`stage2-classification`, then `stage6-retwall-sheetpile--note`) — a pixel regression does not
wander. Run 1 (load ≈ 5) and run 3 (load ≈ 11) both passed **4 / 4**; run 2, taken at load ≈ 45
with the other two specs on parallel workers, failed one. Nothing in this PR touches either shot.
A `--workers=1` run once the box is quiet is the reliable form.

## 6. Findings

1. **`pointercancel` is bound to `stage6BishopPointerUp`, so a cancelled gesture commits.**
   `initStage6BishopCanvas` sets `canvas.onpointercancel = stage6BishopPointerUp`, and `up`
   invalidates on `drag.moved`. Because `move` writes the geometry directly there is nothing to roll
   back to, so this is the only coherent behaviour today — but it means a cancelled drag (the
   browser taking the pointer away mid-gesture) leaves the geometry wherever the last `move` put it
   *and* clears the solved results. Kept verbatim and documented on `pointerCancel`; the verifier
   pins it (group (b), events 32-35). A real cancel would need `down` to snapshot the entity it
   grabbed — a behaviour commit with a golden case.
2. **The draw path's purity is now structural, not conventional.** PR 18b fixed defect 3 by deleting
   a `syncSoilModel()` call from the frame; PR 18e makes the frame *unable* to write: the view model
   is a pure function and the layers only receive `(ctx, vm, theme)`. Group (c) asserts it in both
   controllers, so the guarantee survives the next person who edits a layer.
3. **`stage6BishopDrawGrid` and `stage6BishopWallResultIsStale` now have no caller.** Both are kept
   as façades under the strangler rule (every monolith name survives), but they are dead: the grid
   is a draw layer and the staleness predicate is imported straight from
   `deformation/wall-result-staleness.js` by `draw/walls.js`. The composition root (step 10) can
   drop both.
4. **Report 26 finding 3 was half right.** `sampleDeformationState` was indeed the draw path's own
   import and is gone from the controller, but `contourSegmentsForTriangles` is **not** a draw-path
   helper — it is used by the two contour catalogues (controller 2383 and 2833), which belong to
   regions this step must not touch. `./seepage/solver` therefore stays imported until those move.
5. **`nearestHandle` read the canvas rect twice per candidate.** The monolith's `screenDist` closure
   called `canvas.getBoundingClientRect()` inside `Math.hypot(...)`, twice, for every handle — on a
   section with 40 handles that is 80 forced layouts per `pointerdown`. The package takes the rect
   as a parameter and the façade reads it once. No behaviour change (nothing moves mid-handler), a
   free win for the frame budget.
6. **The theme is now one style read per token per frame instead of four `getComputedStyle` calls
   per frame.** The monolith did one `getComputedStyle(document.documentElement)` plus three
   `readCssToken` calls (each its own `getComputedStyle`), lazily, inside branches; the sequencer
   resolves the six tokens once through cached probe elements. Slightly more reads on a frame that
   draws no boundary conditions, fewer on one that does, and all of them off cached elements after
   the first frame.
7. **`stage6BishopCommitDrawPoint`'s `cpt` branch builds a `terrain` object it never uses.**
   Kept verbatim — it is dead code, not behaviour; the composition root can drop it.
8. **The `region` / `regionHole` branch of `FinishDraft` and the two inline wall literals** were the
   two duplications report 21 follow-up 3 and report 26 follow-up 2 named. The wall literal is now
   one `newWall()` shared by `commitDrawPoint` and `completeCurrentActionAt`; the `region` branch of
   `FinishDraft` still lives in the field / tool / draft region and is step 9f's to fold into
   `state/regions.js addCustomRegion`.

## 7. Follow-ups (not in this PR)

1. Main session / harness owner: `"verify:seepslope-canvas": "node scripts/verify_seepslope_canvas.mjs"`
   in `package.json` (§4), and it into `verify:core` after `verify:seepslope-geometry`.
2. **PR 19 (`style(seepslope)`)**: `seepslopeVizSeries()` is the single file to change — 40 literal
   roles named and grouped, plus `zoneColor(kind)` in `seepslope/state/surface-loads.js`. Every
   change there needs a visual re-baseline *and* a rerun of this verifier with `--base` at the
   commit before it (the draw-call log will legitimately change; that is the point).
3. **Step 9f (panels + tool rail)**: the three hover-tooltip bodies
   (`seepslopeCanvasTooltipEnv`) are HTML strings that belong with the panels, and the six
   `SEEPSLOPE_CANVAS_ENV` hooks of the "Result HTML / labels" group (`SelectedResult`,
   `WallOverlayQuantity`, `WallNodeValuesForOverlay`, `WallQuantityFormat`, `CssColorWithAlpha`,
   `ContrastingTextColor`) shrink to direct imports once `results/` exists.
4. **The contour catalogues** (map §2.11 "Seepage state + contours" / "Deformation contours"): when
   they move to `seepslope/seepage/contours.js` / `seepslope/deformation/contours.js`,
   `SEEPSLOPE_CANVAS_ENV` loses 14 of its 23 hooks and `draw/{seepage,deformation}.js` import them
   directly — and `SEEPSLOPE_PROBE_ENV` shrinks to its `hardeningSoilUi` flag at the same time
   (report 26 §2.1).
5. **Step 9g (`report/capture.js`)**: `drawCanvasFrame(ctx, vm, theme)` takes any 2D context, so the
   Stage 7 capture can render to an offscreen canvas from a view model built for the target
   workspace — without the app/workspace switching of map §6.3 item 7. The view model needs
   `{bishop, model, viewport, width, height}` and nothing else.
6. Finding 1 (a real `pointercancel`), finding 3 (two dead façades) and finding 7 (a dead local):
   behaviour / cleanup commits.
