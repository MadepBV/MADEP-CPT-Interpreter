# 30 — PR 20 `refactor(host): composition root` (refactor step 10)

Branch base: `integration-r` = v0.6.0 tip `968d2cf`. Eight commits, all gated.
`src/lib/cpt-app/legacy-controller.js`: **5 488 → 673 lines** (18 503 at v0.5.3).

| # | commit | what |
|---|---|---|
| 1 | `28cfceb` | stage rail bound in `init`, `#bishop` hash → `project/phase.js` |
| 2 | `43e7423` | Stage 1 → `load/` behind `installLoadApp(ctx)` |
| 3 | `5203141` | Stages 2–5 → `classification/`, `layers/`, `model-params/`, `tuning/` |
| 4 | `bc85a04` | Stage 6 shell → `installStage6App(ctx)` |
| 5 | `4bafbb7` | Seep/Slope contour catalogues, wall response, wall chart → `seepslope/{contours,wall}/` |
| 6 | `a7ee27c` | the Seep/Slope host layer → `seepslope/host.js` behind `installSeepSlopeApp(ctx)` |
| 7 | `14fc863` | per-package `handlers` replace `legacyApi`; export/ + report/ installs; dead façades deleted |
| 8 | `a65ce56` | comments and test titles that still said "legacyApi" |

---

## 1. Inventory of what was left, and where each piece went

The 5 488-line file at `integration-r` was five things. §6.2 step 10 asked for the last one only;
the first four were still there and moved.

| Region (lines at `integration-r`) | ~lines | Went to |
|---|---|---|
| Stage 1: parse → review → apply, multi-file loader, elevation / WT / assumed-Rf / min-thickness / smart-merge controls, the three raw charts, the two layer SVGs, the dropzone | 420 | `load/{raw-charts,layer-svgs,dropzone}.js` + `installLoadApp(ctx)` |
| Stage 2: method cards, `selM`, `runClass` render, the per-CPT classifier wrappers | 100 | `classification/method-cards.js` + `installClassificationApp(ctx)` |
| Stage 3: `buildSubtypeDropdown`, `renderLayers`, `renderCompatWarnings`, `changeSubtype`, the five editors, `setParamMethod`, the detection wrappers | 270 | `layers/{table,handlers}.js` + `installLayersApp(ctx)` |
| Stage 4: `renderModel` (the four parameter columns), `setAlphaMethod` / `setStiffMethod` / `setKhKvMethod`, `modelCtx` / `hsParams` / `khParams` / `stressAt` / `workingLayers` | 190 | `model-params/panel.js` + `installModelParamsApp(ctx)` |
| Stage 5: the seven tuning wrappers | 40 | `installTuningApp(ctx)` |
| Stage 6 shell: `stage6Defaults` / `ensureStage6State` (+ its host ensure-ctx) / `stage6MaxDepth`, the `<details>` memory, the UI-state accessor, `setStage6Field` / `setStage6App`, and the registry + shell build | 190 | `installStage6App(ctx)` |
| Seep/Slope contour catalogues (seepage + deformation) and their palettes | 770 | `seepslope/contours/{palettes,seepage,deformation}.js` |
| Seep/Slope wall response + the five small diagrams | 270 | `seepslope/wall/{response,chart}.js` |
| Seep/Slope host layer: UI toggles, state façades, invalidation, seepage BCs, soil model, regions / materials / walls / drains, `stage6BishopSetField`, workspace + tool, DXF, draft / clear, the three workers and the runs, the panel labels + `renderStage6BishopApp`, the geometry / probe / canvas façades and their three env objects, the Stage 7 capture | 2 250 | `seepslope/host.js` + `installSeepSlopeApp(ctx)` |
| Stage 4 exports (`exportCSV`, `exportPlaxisCommands`, `exportPlaxisCpt`) | 45 | `installExportApp(ctx)` in `export/index.js` |
| Stage 7 report (`stage7ControllerDeps`, `buildStage7Payload`, `openStage7Report`) | 40 | `installReportApp(ctx)` in `report/index.js` |
| bearing façades (11 published names) | 45 | `bearingApp.handlers` |
| pile / settlement / dewatering / beam façades (12 names) | 60 | **deleted** — dead since PR 12b/12c (§6) |
| `const SC = SOIL_CLASS_NAMES`, 244 unused named imports | 260 | **deleted** |
| host wiring: flags, `PROJECT` / `newCptState` / `S` / `setActive`, the installs, the published surface, `initLegacyController` | — | **stayed** |

New files (4 496 lines): `seepslope/host.js` 2 538 · `seepslope/contours/deformation.js` 470 ·
`seepslope/contours/seepage.js` 289 · `seepslope/wall/response.js` 195 · `layers/table.js` 178 ·
`model-params/panel.js` 160 · `load/raw-charts.js` 126 · `seepslope/wall/chart.js` 125 ·
`layers/handlers.js` 116 · `seepslope/index.js` 109 · `load/layer-svgs.js` 87 ·
`seepslope/contours/palettes.js` 57 · `classification/method-cards.js` 24 · `load/dropzone.js` 22.

### What the composition root is now (673 lines)

1. the two feature flags (`STAGE6_ENABLE_HARDENING_SOIL_UI`, `STAGE4_ENABLE_HARDENING_SOIL_PARAMS`);
2. `newCptState()`, `PROJECT`, the single `let S` and `setActive(idx)` — still the only write of `S`;
3. eighteen `install<Pkg>(ctx)` calls;
4. the monolith names each install answers to, as module bindings;
5. `handlers` — the union of the packages' maps;
6. `initLegacyController()`.

The only pieces of *logic* left are genuinely host-shaped: the `apps` map that wires each package's
`compute` / `body` / `postRender` into the Stage 6 shell, `projectIO`'s `getActiveStage` (it reads
`.panel.active`, the DOM-only stage visibility of map §3.4 #9) and its `afterLoad` sequence,
`stratigraphyApp.layerParamsFor` (the Stage 4 derivation in a *member* CPT's context), and the
seven cross-stage hooks (`renderStage(n)`, `runClass`, `detectLayers`, `renderLayers`,
`renderModel`, `renderSection`, `stopWorkers`).

### The seepslope host layer is one closure — why

`seepslope/host.js` is a single 2 538-line `createSeepSlopeHost(env)` rather than eight files. The
~230 names in it reference each other densely (a field setter calls an invalidator, which stops a
worker, which patches the block, which the canvas env reads back), and inside one closure they keep
referring to each other **exactly as they did at module scope in the monolith**. That made the move
verbatim: the only identifiers that changed are the ones the controller owned —

* `S` → `getActive()` (206 occurrences, each at the statement the monolith read it),
* `STAGE6_ENABLE_HARDENING_SOIL_UI` → `hardeningSoilUi`,
* `document` and the twelve Stage 6 shell hooks → members of `env`.

The 14 lines that *begin* inside a multi-line template literal keep the monolith's own column, so
every emitted string is byte-identical. (`verify_seepslope_canvas` caught the one hover card where
the two-space indent had leaked into the string — see §5.)

Splitting `host.js` further is a good follow-up, but it should be its own PR with the byte-exact
verifiers as the gate, not folded into a 4 400-line move.

---

## 2. The published surface: `legacyApi` → per-package `handlers`

`const legacyApi = {…}` is gone. Every package now hands the root a `handlers` map and the root
composes them:

```js
const handlers = {
  PROJECT, newCptState,
  ...projectApp.handlers,        //  7      ...stage6App.handlers,     //  5
  ...projectIO.handlers,         //  2      ...bearingApp.handlers,    // 11
  ...loadApp.handlers,           // 21      ...retainingApp.handlers,  // 12
  ...classificationApp.handlers, //  5      ...seepslopeApp.handlers,  // 54
  ...layersApp.handlers,         // 27      ...sectionApp.handlers,    //  4
  ...modelParamsApp.handlers,    // 11      ...exportApp.handlers,     //  3
  ...tuningApp.handlers,         // 11      ...reportApp.handlers      //  2
};
```

`initLegacyController()` does one `Object.assign(window, handlers)` (it used to do two — the
retaining app's twelve names are in the same object now).

**The surface is bit-for-bit what it was: 179 names** = the 167 of `legacyApi` + the 12 of
`retainingApp.handlers`. I diffed the real runtime surface (load the controller under the Tier-B
stub, run `initLegacyController()`, take the keys added to `globalThis`) against the pre-PR-20 list
name by name: `missing: []`, `extra: []`. **No name was removed**, so §2's "prove it has no caller"
clause did not need to be exercised.

Two names moved *category* without leaving the surface:

* `window.__bishopTest` (the e2e hook `stage6BishopDrawCanvas` sets on every frame) is now assigned
  from `seepslope/host.js` instead of the controller. It is still set at exactly the same moment;
  the handler verifier's old "window.`<name>` =" bucket simply no longer sees it by source-grepping
  the controller, which is why its summary now reads 179 rather than 180 published + 1 direct.
* `stage6BishopHashActive` / `stage6BishopHandleHashChange` were never published; they are deleted
  (see §3).

---

## 3. Module-load side effect, `ctx`, `#bishop`

**Side effect** — `bindStageNav(document, goS)` (map §0 "Module-load side effect", old line 1047)
was the *only* top-level statement with an effect. `initLegacyController()` now calls
`projectApp.bindStageNav()` next to `bindDropzone()`. The controller is dynamically imported from
`+page.svelte`'s `onMount` and initialised in the same tick, so the binding still happens at the
same moment for the user; under the Node stub `querySelectorAll('.si')` returned `[]` either way.

**`ctx`** — documented in one place, the controller's module header (§"The shared ctx"): what each
member means and the rule that every hook is an arrow, so nothing is *called* while the module
evaluates and the installs may reference each other in any order. There is deliberately no single
shared object literal: each package's `index.js` documents the subset it needs, and passing a
package a member it does not use would re-create the god-object the refactor is removing. The one
hard ordering constraint is stated there too — `stage6App` must be installed above `PROJECT`,
because `stage6Defaults()` runs inside `newCptState()`.

**`#bishop`** — moved into `project/phase.js` (map §3.4 #11): `BISHOP_HASH`, `bishopHashActive(win)`,
`applyBishopHash(cpt, active)`, `handleBishopHashChange(cpt, {render, win})`, `bindBishopHash(win, fn)`.
It is a *phase* concern — a URL fragment that decides which view the app opens on — and the
Seep/Slope package never reads `window.location`. Semantics verbatim: the hash forces Stage 6 to
Seep/Slope, its absence sends a Stage 6 that *is* on Seep/Slope back to `bearing`, any other app is
left alone, and a `hashchange` re-renders whenever the CPT has Stage 6 state — whether or not the
app actually changed. `installProject(ctx)` gained `ctx.window` / `ctx.renderStage6` and exposes
`bishopHashActive`, `applyOpeningBishopHash`, `handleBishopHashChange`, `bindBishopHash`.

---

## 4. The rename was **not** done — the path stays `src/lib/cpt-app/legacy-controller.js`

The task allows the rename to `host/controller.js` "only if every importer is updated and all gates
pass". It is not a path update; it changes what the parity gates compare, so I left it.

* **18 code references** would be mechanical: `src/routes/+page.svelte:32`,
  `scripts/golden/lib/load-controller.mjs:22`, `scripts/verify_window_handlers.mjs:151`,
  `scripts/verify_tokens.mjs:56` and the `CTRL` / `CTRL_REL` constant of eleven verifiers.
* **Ten verifiers materialise a base copy**: `verify_{bearing,pile,project_section_tuning,
  settlement_dewatering_beam,seepslope_state,seepslope_model,seepslope_run,seepslope_geometry,
  seepslope_canvas,seepslope_panels,seepslope_report}.mjs` write
  `git show integration-r:src/lib/cpt-app/legacy-controller.js` to
  `src/lib/cpt-app/__verify-*-base.legacy-controller.js`. That text's imports are relative to
  `src/lib/cpt-app/`, so **the base copy cannot move**. The tree copy would have to live in
  `host/`, i.e. base and tree in different directories.
* **Four of them append an `export { … }` block to both copies** and their whole design rests on it
  being *the same block* ("so the moved functions — module-local in the base, façades in the
  working tree — are directly comparable"). With the two copies in different directories the
  re-export lines this PR added to `verify_seepslope_geometry` (`… from './seepslope/geometry/index.js'`)
  resolve differently on each side, so the block would have to fork.
* `verify_seepslope_state.mjs` additionally materialises *sibling* files next to the base copy.

Rewriting that machinery is the opposite of a path update, and it would weaken the very gate that
proves this PR is a pure move. **It becomes a genuine one-line path update as soon as the base ref
advances past PR 20** — base and tree then both live in `host/` — so the rename belongs in the
first PR after this one lands on `integration-r`. Recommend doing it there.

---

## 5. Verifier changes, and why each was unavoidable

Constraint: `scripts/**` "only path/import updates required by the rename". The rename did not
happen, but the *move* did, and a set of verifiers pin the shape of the intermediate strangler
state — "legacy-controller.js still declares wrapper X, verbatim". Those assertions exist to prove
each earlier PR was a pure move; PR 20 is the step that ends the strangler, so they had to follow
the code. **Every behavioural check is untouched.** What changed:

| File | Change | Why |
|---|---|---|
| `verify_window_handlers.mjs` | stopped parsing `const legacyApi={…}`; now loads the controller under the Tier-B DOM stub, runs `initLegacyController()` and diffs the keys of `globalThis`, attributing each name to the owning package's `handlers` map | the object it parsed no longer exists — task item 2 requires this. The check is *stronger*: it now measures the real browser surface instead of a source literal. The attribute scan, callee extraction and failure report are byte-identical. |
| `verify_load.mjs` §9 | "the controller still declares wrapper X" → "the package declares X and the controller binds it from the install"; file list + the three new modules; import-block regex | the wrappers moved into `installLoadApp` |
| `verify_classification_layers.mjs` §11 | same shape; the module lists split into `pure` (still "no document / window / alert / S") and `dom` (`index.js`, `method-cards.js`, `table.js`, `handlers.js`) | the packages now own their DOM half |
| `verify_model_params.mjs` §9 | same shape; `panel.js` added to the file list | idem |
| `verify_export_report.mjs` §6 | the four verbatim bodies are asserted in `export/index.js` / `report/index.js`; the Stage 7 capture decls in `seepslope/host.js`; the purity contract skips `index.js`; the `legacyApi has 167 names` assertion is replaced by the (stronger) runtime diff in `verify_window_handlers` | the bodies moved |
| `verify_core.mjs` | "the controller imports core/format + css-tokens + chart-host" → "the controller imports css-tokens, and the packages that render import format / chart-host / css-tokens" | the controller does not format anything any more |
| `verify_seepslope_geometry.mjs` | 31 of its `EXPORT_BLOCK` names re-exported straight from `seepslope/{geometry,probe}` | those 31 were **already import aliases in the base controller** (PR 18d moved their bodies), so both sides still export the very same functions — the comparison is unchanged, and the composition root stops importing 31 names it does not use |
| `verify_seepslope_report.mjs` | the "the capture region no longer renders / switches the app / re-inits the canvas" source check reads `seepslope/host.js` | the region moved; the assertion is identical |
| `verify_hs_phase_6.mjs` | slices its four helpers out of `seepslope/contours/deformation.js` and stubs `env` instead of `S` | the functions moved; the stub gives the same "no analysis type" fallback |
| eight files | comment / test-title wording that said "legacyApi" | accuracy only (commit 8) |

`tests/golden/README.md:155` still says "name in `legacyApi` unchanged for this step" — left
untouched on purpose (the file set forbids `tests/golden/**`). One-line doc follow-up.

---

## 6. Dead code removed (all previously flagged, none reachable)

* **12 façades** — `ensurePileState`, `renderStage6PileApp`, `buildStage6PileCharts`,
  `drawStage6PileSectionLive`, `requestStage6PileLightRedraw`, `renderStage6SettlementApp`,
  `buildStage6SettlementCharts`, `renderStage6DewateringApp`, `buildStage6DewateringCharts`,
  `renderStage6BeamApp`, `buildStage6BeamCharts`, `drawStage6BeamGeometryPreview`. None is on the
  published surface, none is called from an inline handler, and the Stage 6 shell has rendered
  through the packages directly since PR 12b/12c. Verified by a repo-wide scan: the only
  occurrences were the declaration and its own comment.
* `const SC = SOIL_CLASS_NAMES` and its import — `renderLayers` / `renderModel` took it with them.
* **244 named imports** the root no longer uses (317 → 73).
* `stage6BishopHashActive` / `stage6BishopHandleHashChange` — dead once `project/phase.js` owned
  the deep link.
* `loadSingleGEF` (audit/16 `CPT-PARSE-IMPORT-D-01`, no caller since the multi-CPT loader) moved
  *with* its file set into `load/index.js` and stays unpublished, rather than being deleted — a
  behaviour-neutral home, and the deletion is a one-liner whenever the audit item is closed.

---

## 7. Gates

All green, from this worktree, on the final tree.

| Gate | Result |
|---|---|
| `npm run golden:check` | **2 086 pass, 0 fail, 0 new, 0 missing** (~60 s) |
| `npm run verify:core` | exit 0 — every package verifier |
| ↳ `verify:handlers` | 179 names published, 431 inline `on*=` attributes, 70 callees, 0 unpublished |
| ↳ `verify:core-helpers` 18/18 · `verify:load` 45/45 · `verify:classification-layers` 260/260 · `verify:model-params` 188/188 · `verify:export-report` 57/57 | |
| ↳ `verify:bearing` 519/0 · `verify:pile` 586/0 · `verify:settlement-dewatering-beam` 2 260/0 · `verify:project-section-tuning` 208/0 | |
| ↳ `verify:seepslope-state` 1 110/0 · `-model` 1 301/0 · `-run` 1 255/0 · `-geometry` 1 833/0 · `-canvas` 1 142/0 (1.78 M draw calls) · `-panels` 1 980/0 (byte-identical `#stage6Area` HTML over 978 states) · `-report` 192/0 | |
| ↳ `verify:nen6740` · `stratigraphy` · `import-review` · `project-io` · `scia-db4` · `qc-only` · `retaining` (6) · `wasm` (5) · `bishop-phase-a` (6 fixtures) | pass |
| `npm run build` | exit 0 |
| `npm run check` | **6 errors** — the 6 pre-existing ones (`vite.config.ts` `node:fs` types, 5 in `deformation/wall-result-staleness.js`) |
| `npx playwright test --project=e2e` | **3 passed**, 5 skipped (the golden journeys run in their own config) |
| `GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs` | **5 passed** — demo, gef-import, seep-slope, multi-cpt, save-load. State and DOM text exact; the 4 soft PNG notes are the known machine-wide baseline drift (PLAN §6 open item) |
| `npx playwright test --project=visual --workers=1` | **14 passed, 0 px** (incl. the rekennota print page-1 gate) |
| `node scripts/verify_window_handlers.mjs` | OK |

Also re-ran, before and after the seepslope move, the two byte-exactness verifiers that are this
PR's real safety net: `verify_seepslope_panels` (62.3 M chars of HTML) and `verify_seepslope_canvas`
(1.78 M draw calls). Both identical to the `integration-r` controller.

### Worktree-only note on the browser gates

The three Playwright gates initially failed at their first click with `window.goS is not a
function`. Cause: this agent worktree symlinks `node_modules` to the main checkout, Vite resolves
the realpath, and `vite.config.ts`'s `server.fs.allow` lists only the worktree's own path — so
`@sveltejs/kit/src/runtime/client/entry.js` was served as **403** and the client entry never ran.
Reproduced with a plain `curl` against a bare `vite dev` (403 before, 200 after), i.e. entirely
independent of this PR. I ran the browser gates against a **temporary, uncommitted**
`vite.gate.config.ts` identical to `vite.config.ts` except that `fs.allow` also lists
`realpathSync(node_modules)`; it was deleted before the first commit and is in no diff.

**Suggested one-line fix for the main session** (`vite.config.ts`, main-session-owned file), so the
next agent does not hit it — PLAN's "worktree dev servers work out of the box" note is not true for
Playwright yet:

```ts
import { readFileSync, realpathSync } from 'node:fs';
…
fs: { allow: [new URL('.', import.meta.url).pathname,
              new URL('./node_modules', import.meta.url).pathname,
              realpathSync(new URL('./node_modules', import.meta.url).pathname)] }
```

---

## 8. Findings and follow-ups

1. **`vite.config.ts` `fs.allow` misses the realpath of a symlinked `node_modules`** — see §7.
   Blocks every browser gate in an agent worktree. One line.
2. **The rename to `host/controller.js`** should be the first PR after this lands on
   `integration-r` (§4): once the base ref is past PR 20 it is a pure path update in 18 places.
3. **`seepslope/host.js` (2 538 lines) wants splitting** into `host/{ui,entities,seepage,model,
   runs,canvas,panels,report}.js`, each an `install(app, env)` that assigns onto a shared `app`.
   Deliberately not done here: it is a second, independent restructuring and the byte-exact
   verifiers make it cheap to do safely on its own.
4. **The composition root still carries a 67-name "Node-verifier surface"** — one labelled
   destructuring block of names nothing in the file reads, bound only so
   `verify_seepslope_{geometry,canvas,panels,report}` can append their export block. It disappears
   with the rename PR (§4), when those verifiers can be re-pointed.
5. **`tests/golden/README.md:155`** still mentions `legacyApi` (outside the allowed file set).
6. **The 12 dead pile/settlement/dewatering/beam façades are gone** (§6) — worth a line in the
   audit follow-up, together with `loadSingleGEF`, which is now parked in `load/index.js`.
7. **Two names the map listed as host concerns turned out to be package concerns** and moved
   accordingly: `stage6BishopEnabled()` stayed (it is a feature flag next to the other two), and
   `stage6WorkingLayers` is now simply `modelParamsApp.workingLayers` — the Stage 4 → Stage 6
   contract has one owner instead of a controller wrapper.
8. **`ensureStage6State`'s host ctx still calls back into Seep/Slope** for
   `deformationQuantityIds` (`seepslope/state/ensure.js` needs the contour catalogue during the
   schema migration). It is a ctx hook now rather than a closure, but the cycle stage6 → seepslope →
   stage6 is still there and is the one place the package graph is not a DAG. Worth breaking by
   moving the quantity list into `seepslope/state/`, since it is pure data.
