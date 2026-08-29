# 07 — PR 4 `refactor(core): format, dom, css-tokens, chart-host + handler verifier`

Branch `v0.6.0`, strangler step 1 of `01-monolith-map.md` §6.2 (PLAN §2 row 4). Executed by a Fable agent;
nothing committed. File set touched: `src/lib/cpt-app/legacy-controller.js`, new `src/lib/cpt-app/core/**`,
new `scripts/verify_window_handlers.mjs`, new `scripts/verify_core.mjs`, this report. No changes under
`src/lib/styles`, `tests/`, `scripts/golden`, `.github`, or any config file; `package.json` untouched (lines
for the main session in §8).

Two commit-sized changes, in this order:

1. **Pure move** (bit-identical): nine helpers out of the controller into four `core/` modules, re-imported
   under their old names. `npm run golden:check` 1 619 / 0 before and after; no golden touched.
2. **Defect fix** (PLAN §4 item 1): `stage6BishopSetSelectedRegionCoarseness` published in `legacyApi`
   (+1 line). Goldens unchanged (UI handler); the handler verifier goes from FAIL → OK.

## 1. What moved (verbatim bodies, only the internal cross-references renamed)

| Monolith name (old lines, at 462fc50 / branch tip) | New module → export | Re-bound in the controller as | Uses in controller |
|---|---|---|---|
| `readCssToken` 3458-3461 (Stage 5 region) | `core/css-tokens.js` → `readCssToken` | `import { readCssToken }` | 27 |
| `stage6NoteHtml` 12433-12440 | `core/format.js` → `noteHtml` | `noteHtml as stage6NoteHtml` | 6 |
| `stage6EscAttr` 12442-12448 | `core/format.js` → `escAttr` | `escAttr as stage6EscAttr` | 151 |
| `stage6EscJsString` 12450-12452 | `core/format.js` → `escJsString` (calls `escAttr`) | `escJsString as stage6EscJsString` | 6 |
| `stage6Tooltip` 12454-12457 | `core/format.js` → `tooltip` (calls `escAttr`) | `tooltip as stage6Tooltip` | 27 |
| `stage6AuditTableHtml` 12686-12693 | `core/format.js` → `auditTableHtml` | `auditTableHtml as stage6AuditTableHtml` | 1 (+ `loadSummaryHtml`) |
| `stage6LoadSummaryHtml` 12695-12702 | `core/format.js` → `loadSummaryHtml` (calls `auditTableHtml`) | `loadSummaryHtml as stage6LoadSummaryHtml` | 3 |
| `stage6CompactNumber` 12704-12716 | `core/format.js` → `compactNumber` | `compactNumber as stage6CompactNumber` | 23 |
| `stage6DestroyChart` 16832-16836 | `core/chart-host.js` → `destroyChart` | `destroyChart as stage6DestroyChart` | 15 |

Cut from the controller including the blank separator after each block: 3458-3462 (5 lines), 12433-12458 (26),
12686-12717 (32), 16832-16837 (6) = **69 lines**; added: the 11-line import block after line 105
(`import { installProjectIO } …`). The controller keeps the extension-less import style for its own modules;
the `core/` imports use `.js` so the same files load under plain Node (`scripts/verify_core.mjs` needs no Vite).

Every module: SPDX header, `// @ts-nocheck`, header comment naming source + old line range, ES module,
no `S`, no imports.

### Deliberately **not** moved in this PR

- `arrMax`/`arrSafe` (1642-1643) and `safeClone` (17420-17422): map §9 mentions them for step 1, but the brief
  scoped `core/format.js` to exactly the seven format helpers. They stay in the controller (`arrMax`/`arrSafe` are
  also on `legacyApi`). Candidates for a `core/util.js` in PR 5 or 8 (`safeClone` has 48 uses, all Stage 7).
- The Stage 6 option/help-text builders in 12459-12685 (`stage6UseCategoryOptions` … `stage6ExposureHelp`):
  they belong to the per-app `options.js` files of step 7 (map §6.1 rows settlement/dewatering/beam).

## 2. New helpers (not wired — a pure move must stay bit-identical)

The map's `core/` row also lists `dom.js (byId, setText, toggleClass)` and `chart-host.js (attachChart,
waitForChart)`. The controller has **no** such wrappers today (≈600 inline `document.getElementById`, 20
inline `canvas._chartRef = new Chart(…)`, the `typeof Chart` poll at 1670), so these are introduced now
for the following extraction steps to adopt, unit-checked, and **not** substituted into the monolith:

| File | Exports | Notes |
|---|---|---|
| `core/dom.js` | `byId`, `setText`, `setHtml`, `toggleClass` | null-safe, no-ops without `document` |
| `core/chart-host.js` | `attachChart(canvas, chart)`, `chartAvailable()`, `waitForChart(fn, intervalMs=120)` | next to the moved `destroyChart`; mirror the three idioms of map §4.3 pattern 3 and the `initCharts` poll |

`core/` after this PR: `format.js` 73 lines, `css-tokens.js` 15, `chart-host.js` 36, `dom.js` 36 (160 total).
`state.js`, `handlers.js`, `stage-visibility.js` of the map's `core/` row are out of scope (they need `S`,
step 8 / step 10).

## 3. Controller line-count delta

| | lines |
|---|---|
| before | 18 503 |
| after the move | 18 445 (−69 cut, +11 import) |
| after the defect fix | **18 446** (net **−57**) |

`git diff --stat`: `legacy-controller.js | 81 ++++++------- (12 insertions, 69 deletions)`. The diff contains
only the nine `function …` deletions, the import block and the one-line fix; `legacyApi` exports the same 166
names plus the fixed handler = 167.

## 4. `scripts/verify_window_handlers.mjs`

Walks all 148 `.js/.mjs/.ts` files under `src/lib/cpt-app/` (the monolith, `retaining/panels|results|report`,
`stratigraphy/view.js`, …), finds every `on<event>="…"` / `'…'` attribute in the source text (a small scanner,
so a quote inside a `${…}` interpolation does not end the value), strips the balanced `${…}` interpolations
(template-time, e.g. `${stage6EscJsString(id)}`), and collects every bare event-time call `name(` that is
not a member call, a keyword (`if`, `var`, …) or a runtime built-in (`Number`, `parseFloat`, `alert`, …).

Published names come from three sources, matching what `initLegacyController` does:
`const legacyApi={…}` parsed from the controller source (166 → 167 names), the `handlers` object returned by a
real `installRetainingApp(ctx)` under the DOM stub of `verify_retaining_ui.mjs` (12 `retwall*` names), and any
direct `window.<name> =` (1: the `__bishopTest` debug hook, 11153). Any other `Object.assign(window, X)` source
prints a `WARN` so a future package that publishes its own handlers has to be registered in `KNOWN_TARGETS`.
`--verbose` lists all 70 callees with their origin.

Output **before** the fix (post-move line numbers; the map's 9145 / 16198 / 16612-16613 shift by +6 above the 12433 cuts and by −52 below them):

```
scanned 148 files under src/lib/cpt-app, 428 inline on*= attributes, 70 distinct event-time callees
published on window: 179 names (legacyApi: 166, retainingApp.handlers: 12, window.<name> =: 1)
FAIL  stage6BishopSetSelectedRegionCoarseness is called from 4 inline handler(s) but is not published on window:
        src/lib/cpt-app/legacy-controller.js:9151
        src/lib/cpt-app/legacy-controller.js:16146
        src/lib/cpt-app/legacy-controller.js:16560
        src/lib/cpt-app/legacy-controller.js:16561

1 unpublished handler name(s). Add them to legacyApi (or the owning package's handlers).
exit=1
```

After the fix: `published on window: 180 names (legacyApi: 167, …)` → `OK    every inline handler callee is
published on window`, exit 0. The 428 attributes vs the map's 398: the map counted the monolith only; the
verifier also sees the 30 retaining-panel attributes.

## 5. Defect fix (separate commit)

`stage6BishopSetSelectedRegionCoarseness` (controller 6622-6637 after the move; 6616-6631 before — only the
`readCssToken` cut and the import block sit above it) is the `onchange`/`onkeydown` handler of the selected
custom-polygon coarseness input in the seep/slope panels (three panels: tool rail 9151, settings 16146, region
list 16560-16561). It was never in `legacyApi`, so every edit of that field threw
`ReferenceError: stage6BishopSetSelectedRegionCoarseness is not defined` in the browser and the value was
dropped until the next run: `stage6BishopRunSearch`/`RunSeepage`/`RunDeformation` (7919, 7979, 8048) flush the
input through the in-module `stage6BishopCommitPendingSelectedRegionCoarseness` (6638), which is why the field
appeared to work only once a solver was started.

```diff
--- a/src/lib/cpt-app/legacy-controller.js
+++ b/src/lib/cpt-app/legacy-controller.js
@@ -18375,6 +18375,7 @@
   stage6BishopSetUseCustomRegions,
   stage6BishopDeleteSelectedRegion,
   stage6BishopSetSelectedRegionMaterial,
+  stage6BishopSetSelectedRegionCoarseness,
   stage6BishopFinishDraft,
   stage6BishopPopDraftPoint,
   stage6BishopClear,
```

No golden covers window publication (the Node tier calls functions directly), so `golden:check` is unchanged
by construction: 1 619 / 0 after the fix. No `tests/golden/CHANGELOG.md` entry is needed (no golden moved);
the fix should still be its own commit per PLAN §0.2 ("intended behaviour change is a separate commit").

## 6. `scripts/verify_core.mjs` (18 checks, all OK)

Imports the four `core/` modules directly under Node. `escAttr` (entities, null/undefined/number, literal
double-escape), `escJsString` (= `escAttr(JSON.stringify(String(v)))` incl. embedded quotes), `tooltip`
(exact span with `ⓘ`), `noteHtml` (empty → `''`, level colours), `auditTableHtml`/`loadSummaryHtml`
(structure), `compactNumber` (non-finite → `—`, zero, `E` exponential bands with `digits`, the four fixed bands
with trailing-zero stripping, string input), `readCssToken` (no `document` → fallback; stub
`document.documentElement` + `getComputedStyle` → trimmed token / fallback on empty, and the stub records that
it was asked for `documentElement`), `destroyChart`/`attachChart`/`chartAvailable`/`waitForChart` (stub
document + stubbed `setTimeout`), `dom.js` (no-ops without `document`, then against a stub with a `classList`),
and an "extraction complete" check: none of the nine moved names is declared as `function` in the controller
again and the three `core/` imports are present.

## 7. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — before | 1 619 PASS / 0 FAIL / 0 NEW / 0 MISSING, 28.2 s, exit 0 |
| `npm run golden:check` — after the move (step 1) | 1 619 / 0 / 0 / 0, 29.4 s, exit 0 (bit-identical, no update) |
| `npm run golden:check` — after the defect fix (step 3) | 1 619 / 0 / 0 / 0, 30.2 s, exit 0 |
| `node scripts/verify_window_handlers.mjs` | pre-fix: FAIL (1 name, 4 sites, exit 1) → post-fix: OK, exit 0 |
| `node scripts/verify_core.mjs` | 18/18, exit 0 |
| `npm run verify:retaining` | 226 OK / 0 FAIL, exit 0 |
| `npm run verify:core` (existing chain: nen6740 … bishop-phase-a) | exit 0 |
| `npm run build` | `✓ built in 3.52s`, exit 0 (only the pre-existing chunk-size warning) |
| `npm run check` | the 6 pre-existing errors (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`) **plus 2 393 in `tests/golden/vendor/chart.umd.js`** — see note below; 0 in any file of this PR |

Note on `check`: `tests/golden/vendor/chart.umd.js` (committed by PR 1, 7a4a7ec) is inside the svelte-check
scope, so the "6 pre-existing errors" baseline is now 2 399 on the branch tip regardless of this PR. Not fixable
from this PR's file set; the main session may want to add `tests/golden/vendor` to the tsconfig `exclude` (or
re-point the vendor copy outside the checked tree) in PR 1's follow-up.

Playwright was not run (other agents own the dev servers); the step is a pure compute/format move, so the
browser tier is not required by the protocol (README "Refactor protocol" step 5).

## 8. `package.json` lines for the main session

```json
"verify:core-helpers": "node scripts/verify_core.mjs",
"verify:handlers": "node scripts/verify_window_handlers.mjs",
```

Suggested: append `&& npm run verify:core-helpers && npm run verify:handlers` to `verify:core` (or to
`test:all`) so CI runs both; `verify:handlers` is the gate every later extraction step must keep green.

## 9. Follow-ups noticed while here

- `core/` modules are the first tier-A-loadable pieces of the monolith: `verify_core.mjs` imports them without
  Vite. When the goldens migrate from tier B to tier A (README step 8), `format.js` is the first candidate.
- The verifier deliberately treats `retainingApp.handlers` by running `installRetainingApp`; when PR 11/12
  add per-package `handlers`, register each `Object.assign(window, …)` source in `KNOWN_TARGETS` (the script
  warns on an unknown one).
- `window.__bishopTest` (controller 11153) is a debug hook assigned at draw time; harmless, but it will have to
  go in step 10 (no module-load/runtime `window` writes outside the composition root).
