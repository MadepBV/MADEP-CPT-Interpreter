# 23 — PR 15 `style(retaining)`: component classes replace the injected stylesheet

_Worklog · refactor · 2026-08-30 · worktree branch off `integration-r` (09b9c9b). Implements row **2f** of
`02-design-system.md` §5.2 on top of the shell PR (f30d251), the Stage 1–5 PR (8501cc1) and the Stage 6 PR
(the 2d/2e work of report 20). Continues an unverified WIP commit (`013fb9c`) — see §6 for what was kept,
fixed or discarded._

**TL;DR.** `src/lib/cpt-app/retaining/retaining-styles.js` is **deleted**: its 118 lines of injected
`<style>` are gone from the DOM and the retaining app renders through `src/lib/styles/components.css`
alone — `.card` / `.card--select` / `.acc` / `.field--inline` / `.tbl--dense` / `.verdict--hero` + `.meter`
/ `.tabs` / `.segmented` / `.pill` / `.viz` plus a retaining §24 (the 310 px / 1fr / 340 px workbench, the
sticky self-scrolling input column, the section-canvas frame, the utilisation meters, the `<dl>` key/value
list). The section canvas and the four result charts take every paint from `--viz-*` / `--soil-*` /
`--canvas-*` through `theme.ts`, so the section is finally **legible in dark mode** and follows the theme
toggle. Fixing that surfaced a real bug in `theme.ts` `token()` that PR 13 shipped (one shared probe
element → a batch read returns the same stale colour for every token); it is fixed here and the pile
charts get correct colours as a side effect. Every id, `data-*`, `on*=` handler and visible string is
unchanged: `golden:check` **2 086 / 2 086** bit-identical, the browser DOM-text goldens of
`#retwallInputs` / `#retwallSummary` / `#retwallResultTabs` / `#retwallResultBody` **exact**, the 44
retaining screenshot baselines reviewed and re-baselined, and Stages 1–5, the other Stage 6 apps, both
phases, docs, the rekennota on screen and its print PDF page 1 are **0 px**. Blur count on the retaining
app: **2** at 1 500 px (chrome + rail), **0** at 390 px — the canvas floats add none.

---

## 1. What changed

### 1.1 `src/lib/cpt-app/retaining/retaining-styles.js` — **deleted** (118 lines)

`RETWALL_STYLE` was a `<style>` string prepended to every `renderBody()`, re-inserted on every full
re-render, wrapped in `@layer legacy` since phase 1. Its import and its use in `renderBody` are gone;
`legacy.css` is **untouched** (the retaining rules were all private to that file — the census over `src`,
`scripts`, `tests` shows the legacy names retaining shared with others — `.mc2`, `.btn.sm/.pri`,
`.st6-help` — are still used by Bishop, the deformation/seepage controller and the five engineering apps).

`grep -rn "st6-rw-" src scripts tests` returns one line: the comment on the renamed assertion in
`scripts/verify_retaining_ui.mjs` (§1.6). No selector and no class attribute carries the prefix any more.

### 1.2 `src/lib/styles/components.css` — section 24 (layer `components`, `:where(.cpt-app)`-scoped, 1 063 → 1 277 lines)

| Group | Classes | Spec | Notes |
|---|---|---|---|
| app frame | `.card__head--split` (title block left, actions right), `.actions` (inline action row), `.st6-retwall` (marker only, no rule — it names the app root like `.st6-bishop`) | §3.5 | The root is `.card.st6-retwall.stack`; **`mc2` is dropped** (unlike the five engineering apps it is not the `stage6-shared` golden's body marker — that suite covers `bearing…beam` only). |
| wall types | `.card-grid--sm` (`--card-min: 9rem`) + `button.card` (column layout, `text-align:left`, `font:inherit`) | §3.12 | The five wall types become a `.card--select` grid, not tabs, per §3.12. `auto-fit` collapses the empty tracks, so five cards fill the row exactly like `repeat(5,1fr)` and fall back to two columns below ≈ 530 px of container width — the legacy ≤ 900 px behaviour. |
| workbench | `.cols-3--wide` (`19.375rem / minmax(18.75rem,1fr) / 21.25rem`, two columns ≤ 1 200 px, one ≤ 1 100 px) | §5.2 row 2f | The legacy `310px minmax(300px,1fr) 340px` as tokens-driven rem. See §5.1 for why `.cols-3`'s `--col-side` / `--col-inspector` are too narrow here. |
| input column | `.col--sticky` — `position:sticky` under `calc(--sp-2 + --toolbar-h + --rail-h + --sp-3)`, `max-height:calc(100vh - that - --sp-3)`, `overflow-y:auto`, `overscroll-behavior:contain`; static + full height ≤ 1 100 px | §5.2 row 2f | Keeps `#retwallInputs` its own scroll container, which the controller's scroll-preservation logic (`renderInputs`, `captureScroll`/`restoreScroll`) depends on. The sticky offset now accounts for the chrome + rail (legacy `top:12px` put it under them). |
| accordions | `.acc__head--title` (the §3.6 recipe: 600 `--fs-sm` body font, mixed case), `.acc__body--dense`, `.acc__body > .card__eyebrow` rhythm, dense `.check` | §3.6 | The nine input panels are `details.acc` with the shared left chevron; `data-acc` keys unchanged (the open/closed set survives a re-render through them). |
| inline fields | `.field--inline` (label · control · unit on one line), `.field__text`, `.input--xs` / `.input--text`, `.cols-2--fields`, `.segmented--sm` | §3.7 | `.field` in the spec is a stacked label over a control; the retaining input column is a 310 px inspector where the label reads as a sentence to the left of its control. `.field__label` (mono uppercase eyebrow) is unused here; `.field__text` is its mixed-case sibling. |
| mixed case | `.tabs--text`, `.segmented--text`, `.btn--text`, `.pill--data` | §3.12/§3.7/§3.8/§3.9 | The result-tab labels, branch ids, wall-type names, section ids and the `copy … (TSV)` buttons are **data** — the DOM-text goldens read them through `innerText`, which applies `text-transform`. Only the buttons that were uppercase before (`.btn.sm` → `.btn.btn--sm`, `.btn.sm.pri` → `.btn--primary`) stay uppercase. |
| key/value | `.kv` (the `<dl>` form of `.tbl--kv`: `1fr auto` grid, mono tabular `dd`, `<small>` unit) | §3.10 | A `<dl>` keeps the goldens' innerText line structure (`dt` and `dd` are blockified either way) and lets the keys carry `<sub>`s (M<sub>Ed</sub>, d<sub>required</sub>). |
| utilisation | `.meter` + `__fill` / `__mark` + `--good/--warn/--bad`, `.verdict--hero` (flex-wrap, `--fs-md`, meter on its own row), `.util-list` + `__row` / `__val`, `td.tbl__util` | §3.11 | Exactly the spec's "plus a utilisation bar (`.meter`: 6 px track `--color-bg-alt`, fill tone-coloured, 1 px limit mark at 100 %)". The track runs to 1.5 and the mark sits at 1.0, as the legacy bar did. |
| tables | `.tbl--dense` cell padding, `.tbl--top`, `.tbl-wrap--capped` (`--tbl-wrap-max: 19rem`), `.tbl__name` / `__sub` / `__extra` / `__remark`, `.disclosure`, `.mono` | §3.10 | Every retaining table is now `.tbl-wrap > table.tbl` (the transitional scope of report 19 §3.1 covers it). |
| canvas + charts | `.viz--section > canvas` (`--viz-h` 27.5 rem, `touch-action:none`), `.viz--chart > canvas` (20 rem), `.viz--tall` (26.25 rem), `.viz--short` (15 rem), `.viz__tools`, `.viz__legend`, `.viz__hint`, `.viz__swatch` + `.series-1/-2/-3/-4/-6/-neutral/-water` | §3.13 | The section and the four charts sit on graph paper. **The floats are opaque chips, not `.glass`** — see §5.2. |
| results | `.card--tabs` (padding 0, tabs edge to edge), `.tabs__panel`, `.stack--sections`, `.stack--snug`, `.bullets`, `.card--branch` | §3.12/§3.5 | The result card is a `.card` whose `.tabs` row runs to its edges; `.stack--sections` gives the panel one rhythm instead of the 14 inline `margin-top` values it replaced. |
| shared | `.card.is-selected` (a *static* card marked as governing — the branch cards), `--card-min` on `.card-grid` | §3.5 | Two additive tweaks to §8; nothing existing changed. |

Media rules: ≤ 1 200 / 1 100 / 900 / 760 px + `forced-colors`.

### 1.3 Markup — `retaining-ui.js`, `panels/*`, `results/*`, `report/note-view.js`

| Legacy → component | Where |
|---|---|
| `.st6-retwall` root (`.mc2`) → `.card.st6-retwall.stack`; `.st6-rw-head` → `.card__head.card__head--split`; `.st6-rw-title` / `-subtitle` → `.card__title` / `.card__text`; `.st6-rw-actions` → `.actions` | `retaining-ui.js` |
| `.st6-rw-tabs` › `.st6-rw-tab(.sel)` › `<strong>` + `<span>` → `.card-grid.card-grid--sm` › `button.card.card--select[aria-pressed]` › `.card__title` + `.card__text` | `retaining-ui.js` |
| `.st6-rw-cols` → `.cols-3.cols-3--wide`; `.st6-rw-inputs` → `.col--sticky`; `.st6-rw-summary` → `.stack--snug` | `retaining-ui.js` |
| `.st6-rw-canvaswrap` → `.viz.viz--section`; `.st6-rw-canvastools` → `.viz__tools`; `.st6-rw-hint` → `.viz__hint`; `.st6-rw-legend` + inline-`background` `<i>`s → `.viz__legend` + `.viz__swatch.series-*` | `retaining-ui.js` |
| `.st6-rw-results` › `.st6-rw-rtabs` › `.st6-rw-rtab(.sel)` + `.st6-rw-rbody` → `.card.card--tabs` › `.tabs.tabs--text[role=tablist]` › `.tab[role=tab][aria-selected]` + `.tabs__panel.stack--sections` | `retaining-ui.js` |
| `.st6-rw-acc` / `summary` / `.st6-rw-accbody` → `details.acc` / `summary.acc__head.acc__head--title` / `.acc__body.acc__body--dense`; the summary pill → `.pill.pill--data.acc__badge` | `panels/panel-kit.js` |
| `.st6-rw-field` › `<span>` + `.st6-rw-inwrap` + `.st6-rw-unit` → `.field.field--inline` › `.field__text` + `.field__row` + `.field__unit`; bare `input[type=number]` → `.input.input--sm.input--num`; bare `select` → `.input.input--sm`; `input[type=text]` → `.input.input--sm.input--text`; `.st6-rw-check` → `.check`; `.st6-rw-seg` › `button.sel` → `.segmented.segmented--sm.segmented--text` › `.segmented__btn[aria-pressed]` | `panel-kit.js`, `section-panel.js`, `soil-panel.js`, `drivability-panel.js`, `vibration-panel.js` |
| `.st6-rw-soilgrid` → `.cols-2.cols-2--fields`; `.st6-rw-card-title` (+ its inline `margin-top`) → `.card__eyebrow`; `.st6-help` → `.card.card--quiet.card--note`; `.st6-rw-note(.warn)` → `.card__text` / `.verdict.verdict--warn` | all panels + result views |
| `.st6-rw-layerwrap` › `.st6-rw-layers` → `.tbl-wrap.tbl-wrap--capped` › `table.tbl.tbl--dense`; `input.ov` → `.input.input--sm.input--num.is-override`; `.base` → `.tbl__sub.mono` | `soil-panel.js` |
| `.st6-rw-verdict(.ok/.bad/.idle)` + `-tag` → `.verdict(--good/--bad/--neutral/--warn)` + `.verdict__tag` / `__body`; the summary verdict gains `--hero` + a `.meter` | `summary-card.js`, `retaining-ui.js`, `drivability-panel.js`, `vibration-panel.js` |
| `.st6-rw-card` + `.st6-rw-card-title` → `.card` + `.card__eyebrow`; the inline-styled limit-state rows → `.util-list` › `.util-list__row` › `.util-list__val` | `summary-card.js` |
| `.st6-rw-kv` → `.kv`; `.st6-rw-util*` → `.meter*`; `.st6-rw-badge(.ok/.bad/.info)` → `.pill(--good/--bad/--data)`; `.st6-rw-tablewrap` › `.st6-rw-table` → `.tbl-wrap` › `table.tbl.tbl--dense`; `.st6-rw-checks` → `.tbl-wrap` › `table.tbl.tbl--top`; `.st6-rw-checkname/-checksub/-checkextra` → `.tbl__name/__sub/__extra`; `.st6-rw-utilcell` → `td.tbl__util`; `.st6-rw-copy` → `.btn.btn--sm.btn--text` | `results/result-kit.js`, `checks-view.js`, `gravity-results.js`, `structural-view.js`, `plaxis-view.js` |
| `.st6-rw-branchcards` › `.st6-rw-branchcard(.gov)` › `h4` + `.f` → `.card-grid` › `.card.card--branch(.is-selected)[data-branch]` › `.card__title` + `.mono.ink-muted` | `branches-view.js` |
| `.st6-rw-grid2` / `-grid3` → `.cols-2`; `.st6-rw-chart(.tall)` `<canvas>` → `.viz.viz--chart(.viz--tall/--short)` › `<canvas>`; the `style="height:240px"` override → `.viz--short` | `diagrams-view.js`, `drivability-panel.js`, `vibration-panel.js` |
| `.st6-rw-note` bullet list → `.card__text.bullets`; `<details style>` → `.disclosure` | `report/note-view.js`, `plaxis-view.js` |

**Not touched**: any id (`retwallInputs`, `retwallCanvas`, `retwallSummary`, `retwallResultTabs`,
`retwallResultBody`, `retwallAllC`, the chart canvas ids), any `data-*` (`data-acc`, `data-copy`,
`data-branch`), any `on*=` handler, any `title`, any visible string or its casing, the drag-handle canvas
behaviour (`__rwTest` included), and the scroll-preservation logic. Added, never removed: `type="button"`
on the five wall-type buttons (they had none), `role`/`aria-selected`/`aria-pressed`/`aria-label` on the
tab and segmented groups (the same pattern `stage6/shell.js` uses), and `title="remove"` on the
icon-only `×` of the vibration calibration rows.

### 1.4 Colours — `theme.ts`, `retaining-charts.js`, `retaining-canvas.js`

**`retainingVizSeries()` (new, additive)** — the §3.13 assignment for the retaining app resolved for the
current theme, covering the section, the diagrams and the drivability / vibration charts: wall outline
`--viz-2` and body `--viz-neutral` @ .55, lagging `--viz-neutral` @ .28, concrete `--viz-neutral` @ .35,
retained / active pressure and every "limit" role `--viz-4`, passive resistance and every "accepted" role
`--viz-6`, berm / backfill / shear / warning `--viz-3`, water `--viz-water`, net pressure and the anchor
tendon `--viz-2`, moment and the drag handles `--viz-1`, dimension lines and the static reference
`--viz-neutral`, hatching / soil outlines from `--viz-axis`, paper / halo / ink from `--canvas-paper` /
`--viz-halo` / `--viz-text(-muted)`.

**`retaining-charts.js`** — `drawDepthChart` / `drawXYChart` read `vizTheme()` on **every draw** (grid,
axes, ticks, titles, legends, default marker and h/v-line colours), so a theme switch redraws in the new
palette. The series colours come from the caller.

**`diagrams-view.js`, `drivability-panel.js`, `vibration-panel.js`** — every `#7e50a8` / `#9b3a32` /
`#2e6f55` / `#8a620d` / `#3d6b6a` / `#18181a` / `#4a4a52` / `#b43c32` literal is a `retainingVizSeries()`
role. The moment curve moves from the legacy purple to `--viz-1` (teal), which is the §3.13 assignment
and the only palette change an engineer will notice.

**`retaining-canvas.js`** — the scene builders (`scenes/*.js`) are pure and **golden-locked**: their
literal palette is compared byte-for-byte in `tests/golden/node/retaining/*.scene.json`, so it cannot move
to tokens. The canvas therefore *maps* that palette onto the roles at paint time (a 24-entry
literal → role table covering every colour `embedded-scene.js` and `gravity-scene.js` can emit, including
the `hexToRgba(color, 0.16)` diagram fills), and takes the soil-band fills from the `--soil-*` tokens
through `SOIL_CLASS_NAMES` / `SOIL_FILL_COLORS` of `soil-styles.js` (a reverse map literal → token). An
unknown colour is painted as given, so a new scene colour degrades to its literal instead of vanishing.
The palette is resolved once and cached; `token('--viz-1')` — one `getComputedStyle` read — is the change
detector on each `render()`, which is cheap enough for the drag loop.

### 1.5 `theme.ts` `token()` — a real bug fixed (§7.1)

A single shared probe span whose `color` is rewritten per lookup is wrong: **inside one task Chromium
serves `getComputedStyle().color` from the previous style recalc**, so `vizTheme()` (20 reads in a row)
returns the *same* colour for every token — the value of whatever was written last, one task ago.
Reproduced deterministically after a `page.screenshot({fullPage:true})`:

```
plain (one probe, write→read per name):   every name → rgb(61, 107, 106)      ✗
+ forced reflow between write and read:   every name → rgb(24, 24, 26)        ✗
one probe per name, color written once:   --viz-1 rgb(61,107,106) · --viz-2 rgb(24,24,26) ·
                                          --soil-sand rgb(211,209,199) · --glass-bg-strong
                                          color(srgb 0.98 0.97 0.96 / 0.86)   ✓
```

The fix: **one probe element per token name**, its `color` written once at creation (a freshly attached
element always resolves correctly), the whole set dropped on `madep:theme` so a theme switch re-resolves
against fresh elements. `token()`'s contract, its SSR/Node behaviour (returns `''` → the `FALLBACK`
literals) and every caller are unchanged. This also fixes `pileVizSeries()`: the four pile Chart.js panels
were being recoloured with one colour for all series since PR 13 — invisible in the baselines because the
layout screenshots hide `<canvas>` and the pile app has no canvas baseline, visible in the browser.

### 1.6 Harness and scripts

- `tests/visual/app.spec.mjs`: **unchanged** — the retaining journey drives the app through
  `window.*` handlers and `#retwall*` ids only.
- 44 baselines re-written under `tests/visual/__screenshots__/app.spec.mjs/`:
  `canvas-retwall-sheetpile`, `stage6-retwall-sheetpile` + its 8 result tabs,
  `stage6-retwall-soldierpile-drivability` × {desktop, mobile} × {light, dark}. Nothing else.
- `scripts/verify_retaining_ui.mjs` — **one** assertion changed (the only `.st6-rw-*` reference outside
  the app):
  `ok('branches view renders 4 cards', (branchesView(rw, result).match(/st6-rw-branchcard/g) || …)`
  → `…match(/card--branch/g)…`. Nothing else in the file.
- `scripts/verify_tokens.mjs` — **necessary deviation from the file set** (§7.4): its §1 scope list
  contained the absolute path of the now-deleted `retaining-styles.js` and `read()` is a bare
  `readFileSync`, so `verify:tokens` crashed with `ENOENT`. The entry (and its mention in the header
  comment) is removed; the informational sweep over `src/lib` below it still covers every module.

## 2. Before / after

`worklog/refactor/23-screenshots/{before,after}/<shot>--<desktop|mobile>-<light|dark>.png` — 11 shots × 4
variants each side; desktop downscaled to 1 000 px on the long edge, mobile at its native 390 px. `before`
is the baseline set at `09b9c9b`; the full-resolution `after` images are the live baselines.

| Shot | Δ height (desktop) / changed-pixel ratio (light · dark) | What the eye sees |
|---|---|---|
| `stage6-retwall-sheetpile` (and `--checks`) | 2 130 → 2 049 px · 0.22 / 0.25 | Head as a card head with the note button right; the five wall types as a `.card--select` grid (selected = teal wash + inset accent rule) instead of bordered chips; the input column as `details.acc` cards with left chevrons and pill badges; the section on graph paper with the tools and the legend as floating chips; the summary as a hero verdict with a tone-coloured utilisation meter over quiet cards; the verification table inside a bordered `.tbl-wrap` with a mono sticky head, right-aligned numbers, `.meter` utilisation cells and PASS/FAIL pills. |
| `--branches` | 3 049 → 2 835 px · 0.26 / 0.27 | Four branch cards on the card grid, the governing one carrying the accent rule and a `governs` pill; the factor chain as a mono muted line; the retained / excavation tables as eyebrow + `.tbl-wrap`. |
| `--diagrams` | 2 243 → 2 179 px · 0.32 / 0.33 | Two segmented controls on one `.actions` row; the two 420 px charts on graph paper with a hairline frame. |
| `--structural` | 2 106 → 1 991 px · 0.23 / 0.25 | Section resistance / design effects as two `.kv` columns under eyebrows; the steel checks as a dense table with UC values and pills. |
| `--plaxis` | 2 667 → 2 485 px · 0.23 / 0.25 | Four parameter tables in `.tbl-wrap`s, the T<sub>lat</sub> set switch as a segmented control, the Brinch Hansen constants behind a `.disclosure`. |
| `--drivability` · `--vibration` · `--note` | 1 785 → 1 686 · 2 361 → 2 327 · 1 923 → 1 853 px · 0.22–0.29 | Same anatomy; the note tab's checklist as `.bullets`, its primary action as `.btn--primary`. |
| `stage6-retwall-soldierpile-drivability` | 2 905 → 2 754 px · 0.29 / 0.31 | The soldier-pile panel with its lagging / resistance-model / PLAXIS eyebrow groups; the drivability verdict as a `.verdict` and the per-depth table in a `.tbl-wrap`. |
| `canvas-retwall-sheetpile` | 441 px · 0.81 / 0.83 | The section itself. Light: same drawing on graph paper, steel in warm grey, the moment curve teal instead of purple, dimension callouts on a `--viz-halo` plate. **Dark: readable for the first time** — the labels, dimensions, hatching and axes flip with the theme while the `--soil-*` bands keep their identity. The high ratio is geometry, not colour: the section column is 32 px narrower (the `.card` padding and `--sp-4` gaps replace `1rem` + `14px`), so the whole drawing is re-fitted. |

Mobile (390 px): the workbench stacks; the wall types keep two columns; the result tabs **wrap** instead
of scrolling horizontally (all eight are reachable without a hidden scroll); the input column becomes a
normal, full-height block instead of an 820 px nested scroll area — which is why the mobile pages are
15–35 % taller than before (e.g. `--drivability` 3 336 → 4 598 px). Both are deliberate, see §5.3.

## 3. Verification

| Check | Command | Result |
|---|---|---|
| Layout + canvas screenshots | `PW_PORT=5499 npx playwright test --project=visual` | first run: exactly the 11 retaining names × 4 variants failed — **everything else 0 px**: Stages 1–5 × 4, the five engineering apps, `stage6-bishop-dock-card`, both phases, docs × 2, `/report/retaining` on screen, in print media and its **PDF page 1**. After `--update-snapshots` (44 files, all retaining): **14/14**, re-run **14/14**, and again **14/14** |
| Token integrity + contrast | `npm run verify:tokens` | OK — 173 `var()` usages defined (was 191; the 18 in the deleted stylesheet are gone), dark blocks identical, contrast table passes; built CSS: 6 unlayered rules, all report-route `:global` (unchanged) |
| Build | `npm run build` | OK |
| Type check | `npm run check` | 6 errors, 0 warnings — the pre-existing set (`vite.config.ts` node types, `wall-result-staleness.js`) |
| Node goldens | `npm run golden:check` | **2 086 / 2 086** identical, 0 mismatches (run after the markup, after the canvas work, and at the end) |
| Retaining behaviour | `npm run verify:retaining` | all six scripts exit 0 — wasm verifier 0 failures, **ui verifier passes** (50/50), behaviour 31/31, soil profile 23/23, sections+PLAXIS 81/81, request 24/24 |
| Behaviour (browser) | `PW_PORT=5499 npx playwright test --project=e2e` | 3 passed, 5 skipped (as before). The three retaining tests cover every wall type × every result tab, the **handle drag** (`__rwTest` → embedment increases), the data-sheet re-run, the **inputs-column scroll preservation** (`scrollTop` 300 survives a `retwallSet`) and the calculation note tab |
| Browser goldens | `GOLDEN_PORT=5599 GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs` | **5/5** journeys pass — every `dom.txt` exact, including the 35 `08-retwall-*` `dom.txt` steps (5 wall types + one per result tab) and `09-drivability`, which lock `innerText` of `#retwallInputs`, `#retwallSummary`, `#retwallResultTabs` and `#retwallResultBody`. PNGs report soft mismatches, as they have since PR 10 |
| Blur count | `getComputedStyle(el).backdropFilter !== 'none'` over `document.querySelectorAll('*')` on the retaining app | **2** at 1 500 px (`header.app-header.glass-chrome`, `nav.stage-rail.glass-rail`); **0** at 390 px. §24 adds none — see §5.2 |

## 4. Kept, fixed and discarded from the WIP (`013fb9c`)

The previous attempt had converted the panels and result views and written §24 and
`retainingVizSeries()`, but had not touched `retaining-ui.js` (17 `.st6-rw-*` references), had not deleted
`retaining-styles.js`, and had run no gate. On review:

**Kept as-is (the bulk — it was good work).** The whole `panels/*` and `results/*` conversion, the
`panel-kit` / `result-kit` primitives (`accordion` → `.acc`, `numberRow`/`selectRow`/`checkRow` →
`.field--inline` / `.check`, `segmented` → `.segmented[aria-pressed]`, `table` → `.tbl-wrap > .tbl--dense`,
`utilBar` → `.meter`, `badge` → `.pill`, `kvList` → `.kv`, `copyButton` → `.btn--sm.btn--text`), the
`retaining-charts.js` `vizTheme()` conversion, the chart series maps in `diagrams-view.js` /
`drivability-panel.js` / `vibration-panel.js`, and §24's field / accordion / meter / table / tabs-panel /
stack recipes. `golden:check` was already 2 086/2 086 on the WIP tree, which is the evidence that the
markup rewrite preserved every string.

**Fixed.**
1. `retaining-ui.js` was never converted and `RETWALL_STYLE` was still imported and injected — the whole
   shell (head, wall-type grid, three-column workbench, canvas frame, legend, result card and tabs) is
   this PR's work, and the stylesheet is deleted.
2. `verify:retaining` was **failing** on the WIP tree (`branches view renders 4 cards` asserted the
   renamed `.st6-rw-branchcard`). The branch card gains a real `card--branch` class — a styled class, not
   a test hook — and the verifier asserts that.
3. `theme.ts` `token()` — the stale-probe bug of §1.5. Without it the section painted in one flat hue
   (the first visual run produced an all-salmon and an all-teal canvas on consecutive runs); it also made
   the canvas baseline non-deterministic.
4. `retainingVizSeries().wallFill` was `--viz-2` @ .72 — near-black for a steel sheet pile that reads as
   mid grey. It is `--viz-neutral` @ .55, the role the legacy `#8a8f98` played. `soilLine`,
   `concreteStroke`, `anchorGrout`, `bad/warn/good` and `textMuted` were added for the canvas; `hatch`
   was re-alphaed to .25 to match the legacy hatching weight.
5. `drivability-panel.js` `textRow()` emitted a **class-less** `<input type="text">` — it had lost all
   styling, and §24's `.input--text` had no consumer. Now `.input.input--sm.input--text`.
6. `.field__text` had a rule only as a child of `.field--inline`; the one in the soil panel's "c′ for all
   layers" action row was unstyled. It has a base rule now.
7. §24's `.viz__tools` / `.viz__legend` had no background at all — invisible text over the drawing. They
   are opaque chips (§5.2).
8. The head "Calculation note ↗" button had been given `.btn--text`, turning the legacy uppercase label
   into mixed case. It is a plain `.btn.btn--sm` again (uppercase, as `.btn.sm` rendered it).
9. §24 had `.card-grid--sm` but nothing for the 310/1fr/340 workbench: `.cols-3--wide` is new.
   `.meter--good` and `.viz__swatch.series-neutral` were referenced-but-undefined and are defined.

**Discarded.** `retainingVizSeries()`'s `labelMuted` (`--viz-text` @ .65 — `textMuted` is the token that
already means this) and its duplicated `momentFill`/`shearFill`/`retainedFill` ordering; the WIP's
`worklog/refactor/23-screenshots/before/` set was regenerated from `09b9c9b` (identical content,
downscaled to the report-20 convention) and an `after/` set added.

## 5. Deviations from the spec and why

1. **`.cols-3--wide` instead of `.cols-3`'s tokens.** `--col-side: minmax(17rem,19rem)` /
   `--col-inspector: minmax(16rem,18rem)` is the Stage 6 engineering-app proportion. The retaining input
   column carries label + control + unit on one line (272 px clips the longest labels) and the summary
   column a hero verdict with a meter, so the variant re-declares the two tokens as 19.375 rem / 21.25 rem
   — the legacy 310 px / 340 px — and gives the middle column a 300 px floor. It collapses to two columns
   at ≤ 1 200 px and one at ≤ 1 100 px, matching the legacy 1 200 / 900 px breaks more closely than
   `.cols-3`'s single ≤ 1 100 px break.
2. **The canvas floats are chips, not `.glass`.** §3.13 calls `.viz__legend` / `.viz__readout` "small
   `.glass--sm` chips". `.glass` carries `backdrop-filter`, and §4.1 names this exact surface — "Retaining:
   a 440 px canvas redrawn on every handle drag" — as the case where blur costs a full re-rasterise of
   everything behind it *per frame*. `.viz__legend`, `.viz__hint` and the Fit button take
   `--glass-bg-strong` (a token colour, correct in both themes) with the `.glass--sm` hairline + shadow
   recipe written out, and no filter. Blur count stays at 2.
3. **The input column stops being a scroll container below 1 100 px.** The legacy `max-height:
   calc(100vh - 24px); overflow-y:auto` applied at every width, so on a phone the nine input panels lived
   in an 820 px nested scroll area inside the page scroll — a touch trap, and it hid the layer-override
   table. `.col--sticky` is static and full height there. The mobile pages get taller; that is the point.
4. **The result tabs wrap on mobile** (`.tabs` is `flex-wrap: wrap`, shared with the Stage 6 app switch)
   instead of the legacy `overflow-x: auto`. All eight labels are visible at 390 px.
5. **Mixed case is preserved by class, not by exception**: `.tabs--text`, `.segmented--text`,
   `.btn--text`, `.pill--data`, `.acc__head--title` and `.field__text`. Every one of them labels data the
   DOM-text goldens read through `innerText`; `.btn`, `.tab`, `.segmented__btn`, `.pill`, `.acc__head` and
   `.card__eyebrow` keep their uppercase spec recipe everywhere else.
6. **The wall-type buttons are `.card--select`, not `.tabs`** — §3.12 says so explicitly
   ("`.st6-rw-tabs` (5 wall-type cards → becomes `.card--select` grid, not tabs)").
7. **`.st6-retwall` survives as a class with no rule**, the way `.st6-app` / `.st6-bishop` name their
   roots. It is the only DOM handle on the app root now that `mc2` is gone.
8. **The scene palette stays literal.** `scenes/*.js` are pure modules whose output is locked in
   `*.scene.json`; tokens enter at paint time in `retaining-canvas.js` (§1.4). The soil bands keep the
   legacy 0.55 alpha rather than the spec's 0.85 — the section draws pressure diagrams, wedges and the
   wall on top of them, and 0.85 buries them.
9. **The anchor keeps two tones**: tendon + head plate `--viz-2` (ink), grout body `--viz-3` — §3.13's
   "anchors `--viz-3`" is the grout body, which is what identifies an anchor in the drawing.
10. **Shear stays `--viz-3`** (ochre) rather than §3.13's "moment/shear overlays `--viz-1`/`--viz-4`":
    `--viz-4` is also the retained-pressure and over-excavation role, and on the section the shear
    overlay sits directly over the over-excavation band. Moment does move to `--viz-1` as specified.
11. **Helper classes the spec does not name**, kept minimal and BEM-consistent: `.actions`,
    `.card__head--split`, `.card--branch`, `.card--tabs`, `.card-grid--sm`, `.cols-3--wide`,
    `.cols-2--fields`, `.col--sticky`, `.acc__head--title`, `.acc__body--dense`, `.field--inline`,
    `.field__text`, `.input--xs`, `.input--text`, `.segmented--sm`, `.tabs--text`, `.segmented--text`,
    `.btn--text`, `.pill--data`, `.kv`, `.util-list`, `.mono`, `.tbl--top`, `.tbl-wrap--capped`,
    `.tbl__util/__name/__sub/__extra/__remark`, `.disclosure`, `.viz--section/--chart/--tall/--short`,
    `.viz__tools/__legend/__hint/__swatch`, `.tabs__panel`, `.stack--sections`, `.stack--snug`,
    `.bullets`, `.st6-retwall`.

## 6. Notes for the next PRs

- **`token()` was the sharp edge here.** Anything that resolves more than one token in a synchronous
  batch was silently getting one colour. Worth a `verify` step: toggle `data-theme` in Playwright and
  assert two different `--viz-*` resolve to two different values (§5.4 of the design doc already asks for
  the chart half of this).
- `.cols-3--wide` and `.col--sticky` are generic; the Bishop shell (2d) wants both.
- The transitional `table.tbl` scope (`:is(.tbl-wrap > .tbl, .tbl--kv)`, report 19 §3.1) now covers
  Stage 1–5, the five engineering apps **and** retaining. Only Bishop and `/report/stage7` still use a
  bare `.tbl`; widening the selector and deleting legacy `.tbl*` is a two-line change after 2d/2h.
- `legacy.css` is unchanged at 1 887 lines. What retaining still shared with it (`.btn.pri/.sm` aliases)
  goes with the alias cleanup, not with this row.
- Running the harness from an agent worktree: reports 19 §5 and 20 §6 still apply, plus one addition —
  a fresh worktree has no `.svelte-kit/`, and without it `vite:oxc` fails to load `tsconfig.json` for any
  `.ts` import, so `golden:check` dies before the first suite. `npx svelte-kit sync` once, first.
