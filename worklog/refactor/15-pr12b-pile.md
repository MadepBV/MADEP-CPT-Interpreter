# 15 — PR 12b `refactor(pile): package in the retaining style` (strangler step 7, pile app)

Base `integration-r` @ 96af6ca (PR 4/5/6/8/9/11/12a merged; controller 14 417 lines), second app of
`01-monolith-map.md` §6.2 step 7 (PLAN §2 row 12, map §2.8 Piles, §6.1 row `pile/`). Executed by a Fable
agent in an isolated worktree, started on 78a2e02 and rebased twice while PR 12a (30fd5a9), PR 8 (094205f)
and the plan update (96af6ca) landed on `integration-r`. File set: `src/lib/cpt-app/legacy-controller.js`
(pile regions only), new `src/lib/cpt-app/pile/**` (7 files, two of them moved), `src/lib/cpt-app/stage6/registry.js`
+ `stage6/apps/pile-state.js` (minimal), the two import updates in `scripts/validate-pile.js` and
`scripts/golden/suites/stage6-pile.mjs`, two temporary re-exports at the old module paths (§6.2), new
`scripts/verify_pile.mjs`, this report. `package.json`, `tests/`, `scripts/golden/lib/**`, the bearing /
settlement / dewatering / beam / project / section / tuning / export / report regions and the Svelte templates
untouched.

One commit, one pure move: `npm run golden:check` 1 619 / 0 / 0 / 0 before (78a2e02) and after (on 96af6ca) —
no golden updated, no `tests/golden/CHANGELOG.md` entry. The new verifier compares the base controller
(loaded from git through the Tier-B loader, with the base's own `stage6-pile*.js`) with the working tree:
**586 / 586**, every rendered pile page, section SVG, Chart.js config, cached analysis and clamped config
byte-identical on the demo CPT (22 scenarios incl. the interactive section view driven through its own
listeners) and the 7 CPTs of the three project fixtures, and the 57 `stage6-pile` goldens reproduced byte for
byte from the pure package functions.

## 1. What moved (verbatim bodies; only the controller-state reads became parameters)

Old line numbers are those of 78a2e02 (integration-r when the work started). The generator that cut the
panel bodies asserted the anchor lines before slicing and scanned the result for leftover controller
identifiers (`S.`, `stage6DetailsOpen`, `stage6NoteHtml`, `stage6Max*`, `stage6Working*`, `PROJECT`): none.

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `src/lib/cpt-app/stage6-pile.js` (1 164 lines) | `pile/compute.js` (`git mv`, similarity 99 %) | one import (`./stage6-engineering.js` → `../`), one header line | imports nothing from it (`analyzePile` / `PILE_CONSTANTS` were only used by the pile region) |
| `src/lib/cpt-app/stage6-pile-canvas.js` (842) | `pile/canvas.js` (`git mv`) | two imports (`../stage6-canvas-utils.js`, `../soil-styles.js`), one header line | — (`drawStage6PileSection`, `ensurePileCanvasState`, `stage6PileSnapZ` were only used by the pile region; `stage6PileSnapZ` had no caller at all) |
| `stage6/apps/pile-state.js` (124, PR 11) | `pile/state.js` (`git mv`) → `defaults()`, `ensure(stage6, env)` | header only | `stage6/apps/pile-state.js` is a 7-line re-export (`export { defaults, ensure } from '../../pile/state.js'`), the pattern of PR 12a's `bearing-state.js`; `stage6/index.js`'s `pileState` namespace still resolves |
| `ensurePileState(maxDepth)` 10704-10706 | — | — | façade `pileApp.ensure(S.stage6, {maxDepth})` (no caller; kept as in PR 11) |
| `renderStage6PileApp(analysis)` 10708-10737 | `pile/panel.js` → `renderPileApp(cfg, analysis, detailsOpen)` | `const cfg = S.stage6.pile` → parameter; `stage6NoteHtml` → `noteHtml` (core/format.js) | façade `pileApp.renderBody(analysis)` |
| `renderPileInputsColumn(cfg)` 10739-10874 | `panel.js` → `renderPileInputsColumn(cfg, detailsOpen)` | the five `stage6DetailsOpen('pile-…')` → `detailsOpen('pile-…')` | dropped (internal helper; no other caller) |
| `renderPileVisualsColumn` 10876-10903, `renderPileSummaryColumn` 10905-10949, `renderPilePerLayerTable` 10951-10982, `renderPileFactorChainTable` 10984-11001 | `panel.js` → same names, exported | none | dropped (internal helpers; no other caller) |
| `buildStage6PileCharts()` 11003-11043 | `pile/charts.js` → `buildPileCharts({analysis, cfg, maxDepth})` + `PILE_CHART_IDS` | `S.stage6Cache?.pile`, `S.stage6.pile`, `stage6MaxDepth()` → parameters; `stage6DestroyChart` → `destroyChart` (core/chart-host.js); the four `buildPile*ChartConfig` imported from `../chart-factories.js` | façade `pileApp.buildCharts()` |
| `drawStage6PileSectionLive()` 11045-11072, `let __stage6PileLightRedrawHandle`, `requestStage6PileLightRedraw()` 11074-11106 | `pile/section-live.js` → `createPileSectionLive(ctx)` → `{ start, stop, draw, requestRedraw, pending }` | `S` → `ctx.getState()`, `stage6WorkingLayers()` → `ctx.workingLayers()`, `stage6MaxDepth()` → `ctx.layerBottom()`, `ensureStage6State()` → `ctx.ensure()`, `renderStage6()` → `ctx.requestRender()`; the module-level handle became the instance's `handle`; the duplicated `setField` / hooks literal of the two functions is one `hooks()` builder (same object shape, same closures) | façades `pileApp.sectionLive.draw()` / `.requestRedraw()` |
| shell adapter `apps.pile` 275-279 | `pile/index.js` → `installPileApp(ctx)` | — | `{ compute: pileApp.compute, body: pileApp.renderBody, postRender: pileApp.postRender }` |
| registry entry `entry('pile', 'Piles', 'Pile capacity', '…', pileState)` | `pile/index.js` → `cardMeta` | — | `entry('pile', 'Piles', pileApp.cardMeta.title, pileApp.cardMeta.desc, pileApp)` with `import * as pileApp from '../pile/index.js'` — PR 12a's pattern |

## 2. The package

`src/lib/cpt-app/pile/`:

| File | Lines | Exports |
|---|---|---|
| `index.js` | 101 | `installPileApp(ctx)`, `cardMeta`, and the package surface (`defaults`, `ensure`, `analyzePile`, `PILE_CONSTANTS`, `renderPileApp`, `buildPileCharts`, `PILE_CHART_IDS`, `createPileSectionLive`, `PILE_SECTION_ID`, `drawStage6PileSection`, `ensurePileCanvasState`, `stage6PileSnapZ`, `buildPileSectionMarkup`) |
| `state.js` | 125 | `defaults()`, `ensure(stage6, env)` |
| `compute.js` | 1 165 | `analyzePile`, `PILE_CONSTANTS`, `unitShaftFriction`, `pileGeometry`, `xiLookup`, `deBeerProfile`, … (unchanged surface) |
| `panel.js` | 313 | `renderPileApp(cfg, analysis, detailsOpen)`, `renderPileInputsColumn`, `renderPileVisualsColumn`, `renderPileSummaryColumn`, `renderPilePerLayerTable`, `renderPileFactorChainTable` — pure string builders |
| `charts.js` | 70 | `buildPileCharts({analysis, cfg, maxDepth})`, `PILE_CHART_IDS` |
| `canvas.js` | 843 | `drawStage6PileSection`, `ensurePileCanvasState`, `stage6PileSnapZ`, `buildPileSectionMarkup` (unchanged surface) |
| `section-live.js` | 120 | `createPileSectionLive(ctx)`, `PILE_SECTION_ID` |

Every module: SPDX + `@ts-nocheck`, header naming the source lines, `.js` imports; the package loads under
plain Node (`import('./src/lib/cpt-app/pile/index.js')`), so does `stage6/index.js` with the registry now
importing it.

```js
installPileApp(ctx) → { defaults, ensure, compute, renderBody, postRender, handlers: {}, cardMeta, buildCharts, sectionLive }
  ctx.getState()        S
  ctx.requestRender()   renderStage6()        — the drag-end full re-render (hooks.commitChange)
  ctx.workingLayers()   stage6WorkingLayers()
  ctx.layerBottom()     stage6MaxDepth()
  ctx.ensure()          ensureStage6State()   — before each live drag frame, as the monolith did
  ctx.detailsOpen(key)  stage6DetailsOpen(key)
```

`compute(layers)` = `analyzePile(layers, S.wt, S.data, S.stage6.pile)`; `renderBody(analysis)` first
creates the canvas state in `S.stage6Cache` (the old adapter closure did the same) then builds the page;
`postRender()` = `sectionLive.start()` + `buildCharts()`. `handlers` is empty: every input goes through
the shell's `setStage6Field('pile.…')`, the section view through the listeners canvas.js binds itself.

### `section-live.js` — explicit start / stop

`start()` draws the section from the cached analysis (the old `drawStage6PileSectionLive`); `requestRedraw()`
is the old `requestStage6PileLightRedraw` — at most one pending `requestAnimationFrame`, whose frame
re-clamps (`ctx.ensure()`), re-runs `analyzePile` into `S.stage6Cache.pile` and redraws, and does nothing
when `S.stage6.app` is no longer `'pile'`; `stop()` cancels a pending frame (new — nothing calls it yet,
see §7); `pending()` reports it. The `if(handle) return` / `handle = requestAnimationFrame(…)` ordering is
kept exactly, which matters under the golden loader's synchronous rAF (the callback nulls the handle before
the stub's `0` is assigned — the same as before).

### Controller wiring

```js
const pileApp = installPileApp({ getState: () => S, requestRender: () => renderStage6(), workingLayers: () => stage6WorkingLayers(),
                                 layerBottom: () => stage6MaxDepth(), ensure: () => ensureStage6State(), detailsOpen: (key) => stage6DetailsOpen(key) });
```

placed after `bearingApp` and before `stage6Registry` (hoisted references only — `newCptState()` still calls
`stage6Defaults()` at module load, which now reaches `pile/state.js` through the registry's import).

## 3. Controller line-count delta

| | lines |
|---|---|
| before (96af6ca) | 14 417 |
| after | **14 042** (net −375: 32 insertions, 407 deletions) |

Hunks (`git diff integration-r`): the four `buildPile*ChartConfig` names out of the `chart-factories` import
(54-57) and the two `stage6-pile*` imports (68-73) gone; `pileState as stage6PileState` out of the `stage6/`
import; `import { installPileApp } from './pile/index.js'` after the `bearing/` import; the `pileApp`
instance (13 lines) + the shell comment; the `apps.pile` adapter; the pile region 10 187-10 594 → 30 lines
(five façades). `legacyApi` still exports **167** names (handler verifier: 180 published, 428 inline
handlers, all resolved). No other region touched. Names gone from the controller because nothing else
referenced them (PR 11 finding 6 precedent): `renderPileInputsColumn`, `renderPileVisualsColumn`,
`renderPileSummaryColumn`, `renderPilePerLayerTable`, `renderPileFactorChainTable` (exported by
`panel.js`), `__stage6PileLightRedrawHandle`; the imported-but-unused `PILE_CONSTANTS` and `stage6PileSnapZ`.

## 4. `scripts/verify_pile.mjs`

Two child processes (pattern of `verify_stage6_shell.mjs`), each loading one controller through the Tier-B
loader; the parent compares the dumps byte for byte. The base controller comes from
`git show <ref>:src/lib/cpt-app/legacy-controller.js` (default `integration-r`, `--base <ref>` otherwise) and
is materialised as `src/lib/cpt-app/__verify-pile-base.legacy-controller.js`; when the base still has
`stage6-pile.js` / `stage6-pile-canvas.js`, **the base's own copies** are materialised next to it as
`__verify-pile-base.stage6-pile*.js` and the base's import specifiers rewritten (never the working tree's
re-exports at the old paths, §6.2) — so the old page is rendered by the old compute / canvas code. Everything
is deleted in a `finally`. `--snapshot f.json` / `--against f.json` as in the other verifiers.

| Group | Checks | What |
|---|---|---|
| (a) demo-anonymous, sb260 → `goS(3)` → `goS(5)`, `setStage6App('pile')` | 314 | 22 scenarios × {no exception, selected app, `#stage6Area` innerHTML, section `<svg>` markup + attributes, the four Chart.js configs (the loader's `Chart` stub keeps them), `S.stage6Cache.pile`, `S.stage6.pile`, canvas state, cache keys, rAF errors, alerts}: defaults (25 261 chars) · re-render · the golden suite's `heavy` / `edge` configs · square · rectangular · ATG + mechanical cone + moderate downdrag + typical-curve + steel (every `panel.js` branch) · severe downdrag + timber + overrides · all five `<details>` open · closed again · **the section view driven through the SVG's own listeners**: wheel zoom in / out (one light frame each), toe-handle drag (pointerdown → two moves → pointerup = live frames + the drag-end `renderStage6()`, page 27 891 → 28 288 chars), head drag with shift (free snap), base-edge drag, `pointercancel` mid-drag (config rolled back through `hooks.setField`), layer popover open + its snap-to-mid action (`commitChange`), a wheel on the pile SVG after `setStage6App('bearing')` (the frame returns without touching the cache), back to pile — plus five sanity checks that these scenarios actually moved something (z<sub>toe</sub> changed, popover markup appeared, cancel restored, …) |
| (b) `legacy-v0.5.2` (3 CPTs), `multi-3cpt` (3), `single-layered` (1) | 206 | per CPT the same observation after `setStage6App('pile')` and after the heavy config (24 932–25 961 chars each; all 7 CPTs have layers) |
| (c) `tests/golden/node/stage6-pile/*` from the pure functions | 58 | for the 7 profile fixtures on the working-tree controller's Stage 2–5 chain (`classify(fx,'sb260')` → `goS(3)` → `goS(5)`; the layers via `model-params/working-layers.js`, `wt` / `data` from the CPT): `state.js defaults()` + `ensure({maxDepth: max(layerBottom, 0.5)})`, `compute.js analyzePile()`, `panel.js renderPileApp()` inside the shell package's `cardsHtml('pile')` + `sharedBanner()` → `stableJson(normalize(…))` / `normalizeText(htmlToText(…))` **byte-identical** to `<fx>.{default,heavy,edge}.json`, `.config.json`, `.default.dom.txt`, `constants.json`, `.alerts.json` — all 57 files, and the file set matches |
| (d) registry / package | 8 | `stage6/apps/pile-state.js` re-exports `pile/state.js` (same function objects); `installPileApp()` returns the retaining shape with the package's `defaults` / `ensure` / `cardMeta`; the registry's pile entry is the package (state + card text + glyph), order unchanged, `ensure()` clamps through it |

Result: **586 passed, 0 failed**, ≈ 2 min (two Vite loads + 15 fixture imports). `package.json` line for the
main session (not added here):

```json
"verify:pile": "node scripts/verify_pile.mjs",
```

(Needs the Vite dev dependency and a reachable base ref, like `verify:bearing` / `verify:stage6-shell`; the
sibling materialisation means it keeps working against refs from before the move.)

## 5. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — before (78a2e02) | 1 619 PASS / 0 / 0 / 0, 29.1 s |
| `npm run golden:check` — after the move (78a2e02 base) and final (rebased on 96af6ca) | 1 619 / 0 / 0 / 0 (30.8 s, 28.6 s); `stage6-pile` 57, `stage6-shared` 15, `report` 22, `exports` 55 bit-identical |
| `node scripts/verify_pile.mjs` | 586 / 586 (run on 78a2e02, on 094205f and on the final tree) |
| `node scripts/verify_stage6_shell.mjs` (existing pile-rendering verifier) | 100 / 100 — plainly against `integration-r` on the final tree, and `--against` a `--snapshot` dump taken in a `git archive integration-r` copy |
| `node scripts/verify_bearing.mjs` (PR 12a, now inside `verify:core`) | 519 / 519 — plainly and `--against` a base snapshot |
| `node scripts/validate-pile.js` (existing pile verifier) | 41 ✓ / 0 ✗ |
| `npm run verify:core` | exit 0 — handlers OK (180 published, legacyApi 167), core, model-params, classification-layers, load, export-report, bearing 519/519, nen6740, stratigraphy, import-review, project-io, scia-db4, qc-only, retaining (31/31 + 226 OK), wasm, bishop-phase-a (6 fixtures) |
| `npm run verify:retaining` | exit 0 |
| `npm run build` | `✔ done` |
| `npm run check` | 447 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `pile/**` |

Playwright / dev server not run (pure move; README protocol step 5 — the `07-pile` step of the browser
journeys should be run by the main session before the fast-forward, as for every Stage 6 PR).

## 6. Findings

1. **`integration-r` moved three times during the PR** (12a → 30fd5a9, PR 8 → 094205f, plan/package.json →
   96af6ca). Rebased onto each; the only conflicts were with PR 12a in the controller's import block / the
   install region and in `registry.js`, resolved by adopting 12a's registry pattern (`import * as <pkg>App
   from '../<pkg>/index.js'`, `entry(id, short, <pkg>App.cardMeta.title, …, <pkg>App)`) instead of the
   optional-instance parameter this PR first had. `createStage6Registry`'s signature is unchanged.
2. **Base-ref verifiers break when the base controller imports a file the PR moved.** `verify_bearing.mjs`
   and `verify_stage6_shell.mjs` materialise only the base controller next to the working tree's modules;
   `integration-r`'s controller imports `./stage6-pile` and `./stage6-pile-canvas`, so both failed with
   "Failed to load url ./stage6-pile" the moment the files moved — and `verify:core` (which now runs
   `verify:bearing`) with them. Two ways around it, both applied:
   - `scripts/verify_pile.mjs` materialises the moved siblings from the base ref (§4) — the proper fix; the
     same 10 lines (`MOVED_SIBLINGS` + the specifier rewrite) fit `verify_bearing.mjs` /
     `verify_stage6_shell.mjs` verbatim, not done here (not in the file set);
   - **two temporary re-exports at the old paths**, `src/lib/cpt-app/stage6-pile.js` and
     `stage6-pile-canvas.js` (`export * from './pile/compute.js'` / `'./pile/canvas.js'`, 11 lines each,
     loud header), so the unmodified verifiers and `verify:core` are green on this branch. Nothing in the
     tree imports them (the remaining `stage6-pile` matches are the golden suite's own file name
     `scripts/golden/suites/stage6-pile.mjs`, header comments naming the old paths, and the planning
     reports). They are dead the moment `integration-r` contains the package — delete them then (§7.1).
     `verify_pile.mjs` never uses them (the base gets its own copies), so its base comparison stays strict.
   Without the base in the graph at all, the alternative is `--against` a `--snapshot` dump taken in a
   `git archive <base> | tar -x` copy (done above as a cross-check).
3. `renderStage6PileApp(analysis)` (façade) now also creates `S.stage6Cache.pileCanvas` (through
   `renderBody`); the old function did not, the old adapter closure did. No caller besides the adapter —
   unobservable.
4. `buildPileCharts` receives `maxDepth` as a value, so `stage6MaxDepth()` is now read before the
   `!analysis || typeof Chart === 'undefined'` early return instead of after; it is a pure read of
   `S.layers` — unobservable.
5. The drag path still bypasses `setStage6Field` and writes `S.stage6.pile.*` in place, relying on the next
   `ensure()` to re-clamp (map §3.4) — kept verbatim in `section-live.js` (`setField`), documented in its header.
6. `stage6PileSnapZ` was imported by the controller and never called; `PILE_CONSTANTS` was imported for
   nothing since the golden suite reads it from the module. Both dropped from the controller.
7. The 12a report's "step-7 template" holds: the pile package needed two more ctx hooks than bearing
   (`requestRender` for the drag-end re-render, `layerBottom` for the section / charts).

## 7. Follow-ups (not in this pure move)

1. Delete `src/lib/cpt-app/stage6-pile.js` and `stage6-pile-canvas.js` (the temporary re-exports, §6.2) once
   `integration-r` contains this PR — `git rm` them; no import to update.
2. Give `verify_bearing.mjs` / `verify_stage6_shell.mjs` the `MOVED_SIBLINGS` materialisation of
   `verify_pile.mjs`, or make it a helper in `scripts/golden/lib/` that every base-ref verifier shares —
   every further step-7 PR that moves an imported file (settlement / dewatering / beam have none today;
   step 9 moves `stage6-bishop.js`) hits the same wall.
3. `sectionLive.stop()` on app switch (`setStage6App`) and on `selectCpt` — today a light frame scheduled
   during a drag survives an app switch and is discarded by its own `app !== 'pile'` guard; the composition
   root (step 10) should cancel it instead.
4. The light frame still runs the full `ensureStage6State()` (all seven apps, incl. the bishop migration)
   60× per second during a drag; with per-app `ensure` in place it can call `pileApp.ensure(S.stage6,
   {maxDepth: max(stage6MaxDepth(), 0.5)})` — PR 11 follow-up 4.
5. `verify:pile` into `verify:core` (needs the Vite dev dependency; CI on a PR branch with
   `--base origin/main`, or a committed `--snapshot`).
6. D-stream (PLAN row 13): the pile markup is now `panel.js` + `canvas.js buildPileSectionMarkup` — the
   component classes (`.cols-3`, `.acc`, `.tbl--dense`, `.viz`) go in there; the `stage6-pile` golden locks
   the text, not the tags.
