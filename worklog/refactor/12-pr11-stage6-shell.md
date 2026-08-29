# 12 — PR 11 `refactor(stage6): registry, per-app defaults/ensure, shell render`

Base `integration-r` @ c989770 (PR 4/5/6/9 merged, controller 16 914 lines), strangler step 6 of
`01-monolith-map.md` §6.2 (PLAN §2 row 11, the medium-high-risk step: 78 callers of `ensureStage6State`,
71 of `renderStage6`). Executed by a Fable agent in an isolated worktree. File set:
`src/lib/cpt-app/legacy-controller.js`, new `src/lib/cpt-app/stage6/**` (13 files), new
`scripts/verify_stage6_shell.mjs`, this report. `package.json`, `tests/`, `scripts/golden/**`, the export /
report regions (`exportCSV` … `buildStage7Payload`, PR 8's file set) and the Svelte templates untouched.

One commit, one pure move: `npm run golden:check` 1 619 / 0 / 0 / 0 before and after (incl. `stage6-shared`
and the five `stage6-*` suites) — no golden updated, no `tests/golden/CHANGELOG.md` entry. The new verifier
compares the base controller (loaded from git through the Tier-B loader) with the working tree: 100 / 100,
every rendered Stage 6 page byte-identical for all seven apps.

## 1. What moved (verbatim bodies; only the `S` reads became parameters)

Old line numbers are those of c989770 (integration-r). The generator that cut the bodies asserted the
anchor lines before slicing, and a scan of every new module for leftover controller identifiers
(`stage6*`, `S.*`, `STAGE6_*`, `retainingApp`) came back empty.

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `stage6Defaults()` 2230-2627 (398 lines: `{app, ui, retwall, bearing, settlement, dewatering, pile, beam, bishop}`) | `stage6/state.js` → `defaults(registry)`; the six per-app literals → `apps/{bearing,settlement,dewatering,pile,beam,bishop}-state.js` → `defaults()`; `retwall` stays `retainingApp.defaults()` through the registry | literals unchanged (the bishop block keeps its two tab-indented lines); **key order kept** — `STATE_KEY_ORDER = [retwall, bearing, settlement, dewatering, pile, beam, bishop]` is the literal's order, not the card order, so a saved project still serialises `stage6` byte-identically | `stage6Defaults(){ return stage6StateDefaults(stage6Registry); }` (still on `legacyApi`; still called by `newCptState` at module load) |
| `stage6Merge` 2629-2639, `stage6Get` 2641-2643, `stage6Set` 2645-2654 | `stage6/merge.js` → `merge`, `get`, `set` (re-exported by `state.js`) | none | `stage6Get` / `stage6Set` imported under the old names (used by `stage6BishopSetField`); `stage6Merge` had no caller left → not imported |
| `stage6MaxDepth` 2660-2662 | `state.js` → `layerBottom(cpt)` | `S.layers` → `cpt.layers` | wrapper `stage6MaxDepth(){ return stage6LayerBottom(S); }` |
| `stage6BishopSeepageDomainArea` 2664-2683, `stage6BishopAutoSeepageMeshTargetArea` 2686-2690, `stage6BishopResolvedSeepageMeshTargetArea` 2692-2698, `stage6BishopAutoDeformationMeshTargetArea` 2700-2713, `stage6BishopResolvedDeformationMeshTargetArea` 2715-2721, `stage6BishopSortedPolyline` 3359-3369 | `apps/bishop-state.js` → `seepageDomainArea`, `autoSeepageMeshTargetArea`, `resolvedSeepageMeshTargetArea`, `autoDeformationMeshTargetArea`, `resolvedDeformationMeshTargetArea`, `sortedPolyline` (imports `terrainY` from `stage6-bishop.js`, `polygonArea` from `soil-regions.js`) | names only | destructured from the package under the old names (`stage6BishopSortedPolyline` ×6 and the four mesh helpers ×17 call sites in the bishop region); `stage6BishopSeepageDomainArea` had no other caller → not re-bound |
| `ensureStage6State()` 2723-3119 (397 lines) | `state.js` → `ensure(stage6, ctx)` (merge → every app's `ensure` → disabled-app guard) and `ensureCpt(cpt, ctx)` (the two CPT-level lines `S.stage6 = …` / `S.stage6Cache = {}` + `ensure`) | the clamps of 2729-2750 split per app (see next rows); `Math.max(stage6MaxDepth(), 0.5)` computed once in `ensure` and handed to every app as `env.maxDepth` (raw value as `env.rawMaxDepth`); `S.wt` → `env.wt`; the `stage6BishopEnabled()` guard became the registry's `enabled` hook | `ensureStage6State(){ stage6EnsureCpt(S, stage6EnsureCtx()); }` — `stage6EnsureCtx()` = `{registry, hardeningSoilUi: STAGE6_ENABLE_HARDENING_SOIL_UI, deformationQuantityIds, migrateSurfaceLoadsShape}` |
| bearing clamps 2729-2734 | `apps/bearing-state.js` → `ensure(stage6, env)` | `S.stage6.bearing` → `stage6.bearing`, `stage6Defaults().bearing.B` → `defaults().B` | — |
| settlement clamp 2735 · dewatering clamp 2736 · beam clamps 2737-2750 | `apps/settlement-state.js`, `apps/dewatering-state.js`, `apps/beam-state.js` → `ensure(stage6, env)` | `S.stage6.x` → `stage6.x`; dewatering `S.wt` → `wt` | — |
| `ensurePileState(maxDepth)` 11612-11681 | `apps/pile-state.js` → `ensure(stage6, env)` | `S.stage6.pile` → `stage6.pile`, `stage6Defaults().pile` → `defaults()` | wrapper `ensurePileState(maxDepth){ stage6PileState.ensure(S.stage6, {maxDepth}); }` (no caller left besides the old ensure; kept as a named façade) |
| bishop migration 2755-3118 (364 lines) | `apps/bishop-state.js` → `ensure(stage6, env)` | `S.stage6.bishop` → `stage6.bishop`, `stage6Defaults().bishop` → `defaults()`, `stage6Merge` → `merge`, `stage6MaxDepth()` → `env.rawMaxDepth`, `STAGE6_ENABLE_HARDENING_SOIL_UI` → `env.hardeningSoilUi`, `stage6BishopDeformationQuantityIds(` → `env.deformationQuantityIds(`, `stage6BishopMigrateSurfaceLoadsShape(` → `env.migrateSurfaceLoadsShape(`; the three mesh helpers by their new names — nothing else | the two hooks are the monolith's functions (bishop region, step 9 material) passed through `stage6EnsureCtx()` |
| `stage6RememberDetailsState` 3121-3130, `stage6DetailsOpen` 3132-3135, `STAGE6_SCROLL_PERSIST_SELECTORS` 3137-3144, `stage6ScrollTargetBaseKey` 3146-3154, `stage6ScrollTargets` 3156-3175, `stage6CaptureScrollState` 3177-3181, `stage6RestoreScrollState` 3183-3196, `stage6SetDetailsOpen` 3198-3203, `stage6BishopUiState` 3205-3210 | `stage6/ui-state.js` → `rememberDetailsState(stage6, root)`, `detailsOpen(stage6, key)`, `STAGE6_SCROLL_PERSIST_SELECTORS`, `scrollTargetBaseKey`, `scrollTargets`, `captureScrollState`, `restoreScrollState`, `setDetailsOpen(stage6, key, open)`, `uiState(stage6)` | DOM walks verbatim; `S.stage6` → parameter; the three `ui`/`ui.details` guards folded into `uiState` | four wrappers keep the `ensureStage6State()`-first behaviour: `stage6RememberDetailsState` (root check → ensure → package), `stage6DetailsOpen`, `stage6SetDetailsOpen`, `stage6BishopUiState`; the scroll helpers had `renderStage6` as their only caller → not re-bound |
| `setStage6Field` 3324-3341 (typed write) | `stage6/field-setter.js` → `coerceFieldValue(defaults, field, value)`, `setField(stage6, defaults, field, value)` | none | `setStage6Field` keeps ensure → remember → `stage6SetField(S.stage6, stage6Defaults(), field, value)` → bearing-preview short-circuit → `renderStage6()` |
| `stage6SharedBanner` 11564-11570, `stage6AppIcon` 11572-11585, `stage6CardsHtml` 11587-11610 | `stage6/shell.js` → `createStage6Shell(ctx).{sharedBanner, appIcon, cardsHtml}`; the seven glyph bodies and the card texts → `stage6/registry.js` (`cardMeta.icon`, `cardMeta.title/desc`, `short`) | template strings byte-identical (the verifier compares the rendered strings); the `cards` array and the `if(stage6BishopEnabled()) cards.push(bishop)` → `enabledApps(registry)`; the `switch` on the icon id → registry lookup with the same `default` rect | three one-line façades over `stage6Shell` |
| `renderStage6` 15188-15246 | `shell.js` → `createStage6Shell(ctx).render()`: ensure → capture scroll + `<details>` → no-layers placeholder → `adapter.compute(layers)` → `S.stage6Cache[id] = analysis` → `adapter.body(analysis)` → `innerHTML = cards + banner + body` → restore scroll → rAF(`adapter.postRender()`, restore scroll) | the seven-way `if/else` on `S.stage6.app` → a lookup in the `apps` map the host passes in; the `else` branch (any unknown id renders **beam**) is kept as `legacyFallbackApp: 'beam'` | `renderStage6(){ stage6Shell.render(); }` (on `legacyApi`, 71 callers unchanged) |

Not moved (deliberately): `stage6WorkingLayers` (model-params wrapper, unchanged), `setStage6App`,
`stage6BishopEnabled`, `stage6BishopHashActive`, the bishop UI toggles 3212-3322 (seepslope `ui-state.js`, step 9),
`stage6BishopMigrateSurfaceLoadsShape` and `stage6BishopDeformationQuantityIds` (bishop region, used by 8 / 2
other bishop functions — passed to the migration as hooks), the per-app render / chart / canvas functions
(step 7), `stage6DestroyChart` (already `core/chart-host.js`).

## 2. The registry and the shell instance

`src/lib/cpt-app/stage6/`:

| File | Lines | Exports |
|---|---|---|
| `registry.js` | 85 | `STAGE6_APP_ORDER` (`bearing · pile · settlement · dewatering · beam · retwall · bishop`), `STAGE6_DEFAULT_APP`, `STAGE6_ICON_FALLBACK`, `createStage6Registry({retaining, bishopEnabled})`, `registryEntry`, `enabledApps` — one entry per card `{id, short, cardMeta:{id,title,desc,icon}, state:{defaults, ensure}, enabled?}` |
| `state.js` | 84 | `defaults(registry)`, `ensure(stage6, ctx)`, `ensureCpt(cpt, ctx)`, `layerBottom(cpt)`, `STATE_KEY_ORDER`, `merge/get/set` |
| `merge.js` | 37 | `merge`, `get`, `set` |
| `ui-state.js` | 102 | `uiState`, `rememberDetailsState`, `detailsOpen`, `setDetailsOpen`, `STAGE6_SCROLL_PERSIST_SELECTORS`, `scrollTargetBaseKey`, `scrollTargets`, `captureScrollState`, `restoreScrollState` |
| `field-setter.js` | 29 | `coerceFieldValue`, `setField` |
| `shell.js` | 111 | `createStage6Shell(ctx) → {render, cardsHtml, sharedBanner, appIcon, resolveApp}`, `stage6IconSvg`, `STAGE6_NO_LAYERS_HTML` |
| `index.js` | 47 | the package surface + `bearingState … bishopState` namespaces |
| `apps/bearing-state.js` · `settlement-state.js` · `dewatering-state.js` · `pile-state.js` · `beam-state.js` | 36 · 32 · 32 · 124 · 67 | `defaults()`, `ensure(stage6, env)` |
| `apps/bishop-state.js` | 721 | `defaults()`, `ensure(stage6, env)`, `sortedPolyline`, `seepageDomainArea`, `auto/resolved{Seepage,Deformation}MeshTargetArea` — a holding place until step 9a |

Total 1 507 lines. Every module: SPDX + `@ts-nocheck`, header naming the source lines, `.js` imports (the
package loads under plain Node: `node -e "import('./src/lib/cpt-app/stage6/index.js')"` builds the registry with a
stub retaining app, `defaults()` and `ensureCpt()` run).

In the controller the two instances sit right after `installRetainingApp(...)` and before `stratigraphyApp`
(lines 253-308) — they **must** precede `const PROJECT` (383), because `newCptState()` calls `stage6Defaults()`
at module load; everything they reference is a hoisted function or `retainingApp`, nothing runs at that point:

```js
const stage6Registry = createStage6Registry({ retaining: retainingApp, bishopEnabled: () => stage6BishopEnabled() });
const stage6Shell = createStage6Shell({
  registry: stage6Registry, getState: () => S, ensure: () => ensureStage6State(),
  rememberDetailsState: () => stage6RememberDetailsState(), workingLayers: () => stage6WorkingLayers(),
  apps: {
    bearing:    { compute: (layers) => bearingProfile(S.stage6.bearing, layers), body: renderStage6BearingApp, postRender: buildStage6BearingChart },
    pile:       { compute: (layers) => analyzePile(layers, S.wt, S.data, S.stage6.pile), body: (a) => { ensurePileCanvasState(S.stage6Cache); return renderStage6PileApp(a); }, postRender: drawStage6PileSectionLive + buildStage6PileCharts },
    settlement / dewatering / beam: analyzeSettlement / analyzeDewatering / analyzeBeamAndReinforcement → renderStage6*App → buildStage6*Charts,
    retwall:    { body: retainingApp.renderBody, postRender: retainingApp.postRender },
    bishop:     { body: renderStage6BishopApp, postRender: initStage6BishopCanvas + buildStage6BishopLineProbeChart + buildStage6BishopWallCharts }
  }
});
```

(Written out as closures in the file so the hoisting stays explicit.) Step 7 replaces each `apps.<id>` entry
with the package's `install<App>(ctx)` result — `{defaults, ensure, renderBody, postRender, handlers, cardMeta}`
maps onto `state.defaults / state.ensure / body / postRender / cardMeta` without touching the shell.

### Ensure order

The monolith ran: merge → `retainingApp.ensure` → bearing → settlement → dewatering → beam → bishop-enabled
guard → `ensurePileState` → bishop. `state.js` runs merge → retwall → bearing → settlement → dewatering →
**pile → beam** → bishop → guard (state-key order). Each app's `ensure` reads only its own block plus
`env` (`maxDepth`, `rawMaxDepth`, `wt`, the flag and the two hooks), so the result is the same object —
proven by the verifier on the three project fixtures (7 CPTs), a fresh CPT, the stage6-shared "partial"
state extended with a v1 bishop block (`bottomMargin`, manual mesh area) and an unknown app id.

## 3. Controller line-count delta

| | lines |
|---|---|
| before (c989770) | 16 914 |
| after | **15 883** (net −1 031: 100 insertions, 1 131 deletions) |

`git diff --stat`: `legacy-controller.js | 1231 +++-------------------------------`. The diff is: the 16-line import
block + the 9-line destructuring (after the `layers/` block, lines 184-208), the 56-line registry/shell
instances (253-308), and the 13 replaced declarations listed in §1 (11 deleted outright). `legacyApi` still
exports the same **167** names (handler verifier: 180 published, 428 inline handlers, all resolved). No edit
outside lines 184-308, 2307-2496 (state / UI / setter region), 10 688-10 706 (shell façades + `ensurePileState`)
and 14 213-14 215 (`renderStage6`) — the export / report regions (PR 8) are untouched.

## 4. `scripts/verify_stage6_shell.mjs`

Two child processes, each loading one controller through the Tier-B loader (`installDomStub()` from
`scripts/golden/lib/load-controller.mjs` + its own Vite `ssrLoadModule`), dump the same observations as JSON
with key order preserved and `undefined`/`NaN` made visible; the parent compares the dumps byte for byte and
prints the first differing path / character on a mismatch. The base controller comes from
`git show <ref>:src/lib/cpt-app/legacy-controller.js` (default `integration-r`, `--base <ref>` otherwise) and is
materialised as `src/lib/cpt-app/__verify-stage6-base.legacy-controller.js` for the duration of the run (its
relative imports need that directory); it is deleted in a `finally`. `--snapshot f.json` / `--against f.json`
record and compare without git.

| Group | Checks (100 in total) |
|---|---|
| (a) `stage6Defaults()` | JSON text identical (deep-equal **and** key order); a second call is identical |
| (b) `ensureStage6State()` | `legacy-v0.5.2` (3 CPTs), `multi-3cpt` (3), `single-layered` (1) loaded through `loadProjectFromFile`: per CPT `stage6` identical + idempotent + same cache keys; fresh CPT; the partial/bogus state; `app:'not-an-app'` survives ensure unchanged in both |
| (c) rendered `#stage6Area` on `demo-anonymous` (sb260, `goS(3)`, `goS(5)`) | for each of the 7 apps: `setStage6App(app)` innerHTML byte-identical (bearing 19 296 chars · pile 25 261 · settlement 37 764 · dewatering 17 473 · beam 37 524 · retwall 36 882 · bishop 47 270), a second `renderStage6()` byte-identical, post-render rAF errors identical (0 everywhere — the pile canvas, bearing/settlement/dewatering/beam charts, retaining canvas + WASM kick-off and the bishop canvas/probe/wall charts all ran under the stub), alerts, no exception, cache keys, `S.stage6` after render; the unknown-id fallback (beam) identical; the no-layers placeholder; `stage6SharedBanner()`, `stage6CardsHtml('pile')`, `stage6AppIcon(id)` for the 7 ids + an unknown id |
| (d) order | base card order (parsed from the rendered `onclick="setStage6App('…')"`) == `STAGE6_APP_ORDER` == the registry built in-process == the new card order |

Runtime ≈ 45 s (two Vite loads). `package.json` line for the main session (not added here):

```json
"verify:stage6-shell": "node scripts/verify_stage6_shell.mjs",
```

Suggested: `&& npm run verify:stage6-shell` in `verify:core` (needs the Vite dev dependency and a reachable base
ref — in CI on a PR branch `--base origin/main` or, once merged, `--base HEAD~1` of the merge commit; or commit a
`--snapshot` dump next to the goldens and run `--against`).

## 5. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — before (c989770) | 1 619 PASS / 0 FAIL / 0 NEW / 0 MISSING, 29.6 s, exit 0 |
| `npm run golden:check` — after the move | 1 619 / 0 / 0 / 0, 35.4 s, exit 0 (`stage6-shared` 15, `stage6-bearing` 70, `-pile` 57, `-settlement` 56, `-dewatering` 56, `-beam` 63, `report` 22, `exports` 55, `project-io` 22 all bit-identical) |
| `npm run golden:check` — final (verifier + report in the tree, after the import clean-up) | 1 619 / 0 / 0 / 0, 29.6 s, exit 0 |
| `node scripts/verify_stage6_shell.mjs` | 100 / 100, exit 0 (run twice: before and after the import clean-up) |
| `npm run verify:core` | exit 0 — handlers OK (180 published, legacyApi 167), core 18/18, model-params 188/188, classification-layers 260/260, load 45/45, nen6740, stratigraphy, import-review, project-io, scia-db4, qc-only, retaining (31/31 behaviour + 226 OK), wasm, bishop-phase-a (6 fixtures) |
| `npm run verify:retaining` | exit 0 (226 OK lines, 31/31 behavioural expectations) |
| `npm run build` | `✔ done`, exit 0 |
| `npm run check` | 423 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `stage6/**` |

Playwright / dev server not run (pure move; README protocol step 5 — the browser journeys' `07-*` Stage 6
steps should be run by the main session before the fast-forward, as for every Stage 6 PR).

## 6. Findings on the map / plan

1. Map §1.2 counts "~365 lines of bishop schema migration": it is 364 (2755-3118). `ensureStage6State` is 397
   lines, not 398; `stage6Defaults` 398. Immaterial.
2. `ensurePileState(maxDepth)` has exactly one caller (`ensureStage6State`) and is not on `legacyApi`; the map's
   `pile/` row lists it as that package's `state.js` — it now is `stage6/apps/pile-state.js` `ensure()`, and the
   pile package of step 7 can adopt the file as-is.
3. The `else` branch of `renderStage6` rendered **beam** for any unknown `S.stage6.app` (a saved project with
   an app id from a future version, or a typo through `setStage6App`). Kept as `legacyFallbackApp: 'beam'` so
   the move stays pure; the sensible behaviour (fall back to `STAGE6_DEFAULT_APP` and normalise the id in
   `ensure`) is a one-line change in `shell.js` + `state.js` with its own golden case — proposed for step 7
   or the composition root, not done here.
4. `stage6BishopEnabled()` is a constant `true`; the registry keeps it as the `enabled` hook only because
   `stage6CardsHtml`, `setStage6App` and the ensure guard all read it. Step 10 can drop the three reads and the hook.
5. Every `setStage6Field` call still builds the full defaults tree (incl. `retainingApp.defaults()`) for the
   type lookup — unchanged cost, but `coerceFieldValue` now makes a per-app `defaults()` lookup trivial
   once step 7 routes `setStage6Field('bearing.B', …)` to the bearing package.
6. Six names disappeared from the controller because nothing else referenced them: `stage6Merge`,
   `stage6ScrollTargetBaseKey`, `stage6ScrollTargets`, `stage6CaptureScrollState`, `stage6RestoreScrollState`
   (only `renderStage6` used the scroll helpers) and `stage6BishopSeepageDomainArea` (only the mesh helpers).
   All live on in the package under their short names; none was on `legacyApi` or in an HTML string.

## 7. Follow-ups (not in this pure move)

1. Step 7 (`bearing/`, `pile/`, `settlement/`, `dewatering/`, `beam/`): each package's `install(ctx)` returns
   the retaining shape; the host swaps the `apps.<id>` closure for it and the registry entry's `state` for the
   package's `defaults/ensure` — `stage6/apps/<id>-state.js` moves into the package unchanged.
2. Step 9a: `apps/bishop-state.js` (defaults + migration + mesh helpers) becomes `seepslope/state/{defaults,ensure}.js`;
   the two `env` hooks (`deformationQuantityIds`, `migrateSurfaceLoadsShape`) come along, and the controller's
   destructuring of the mesh helpers goes.
3. Unknown-app fallback (finding 3) and `#bishop` hash (map §3.4 #11) → `STAGE6_DEFAULT_APP` / `project/phase.js`.
4. `ensureStage6State` is still re-run by all 78 callers (idempotent — verified per CPT). With per-app `ensure`
   in place, step 7 can call only the active app's `ensure` from its handlers and leave the full pass to
   `selectCpt` / `projectIO.afterLoad`.
5. `stage6-shared` golden `switch.*.head` still keys on `<div class="mc2` to cut the app body off; when the
   D-stream reskins the Stage 6 shell (PR 13) the suite needs a marker that is not a class name.
6. The verifier's base-ref dependency (§4): commit a `--snapshot` dump once the branch is merged, or point
   `--base` at the merge base in CI.
