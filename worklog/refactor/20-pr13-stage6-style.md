# 20 — PR 13 `style(stage6)`: shell tabs, accordions, three-column layout, viz colours for the five apps

_Worklog · refactor · 2026-08-30 · worktree branch off `integration-r` (a6a898e = v0.6.0 tip). Implements the Stage 6
shell parts of row **2d** and the pile + engineering-app row **2e** of `02-design-system.md` §5.2 on top of the shell PR
(f30d251) and the Stage 1–5 PR (8501cc1). The Bishop canvas shell, its legends and view menu stay for a later PR._

**TL;DR.** The Stage 6 shell and the five engineering apps (bearing, pile, settlement, dewatering, beam) now render
through `src/lib/styles/components.css` — the app switch is `.tabs.tabs--icon`, the `<details>` accordions are
`details.acc`, the inline `grid-template-columns:260px 1fr 250px …` grids are `.cols-3` on the `--col-side` /
`--col-inspector` tokens, the input columns are `.fields--stack` › `.field-stack` › `.input`, help notes are
`.card--quiet.card--note`, the key/value tables `.tbl--kv`, the row tables `.tbl-wrap › .tbl`, the charts sit in `.viz`
graph paper, and the pile section view + the four pile Chart.js panels take their colours from the `--viz-*` / `--soil-*`
tokens (through `var()` in the SVG, through `theme.ts` `pileVizSeries()` for Chart.js). Every id, `data-*` attribute,
`on*=` handler and visible string is unchanged: `golden:check` **1 619 / 1 619**, the browser DOM-text goldens of all five
apps **exact**, the 68 Stage 6 screenshot baselines reviewed and re-baselined, and Stage 1–5, both phases, docs, the
rekennota on screen and its print PDF page 1 **0 px**. Blur count with the Bishop dock + card open: **14 → 4** (the four
nested blurs of §4.1 rule 1 deleted); rAF during a 2 s Bishop search: **median 120 fps**.

---

## 1. What changed

### 1.1 `src/lib/styles/components.css` — sections 17–23 (layer `components`, `:where(.cpt-app)`-scoped, 779 → 1 063 lines)

| § | Classes | Spec | Notes |
|---|---|---|---|
| 17 | `.tabs` (hairline-bottomed flex row), `.tab` (`--control-h`, 2 px accent underline on `[aria-selected=true]` / `.is-selected`, hover wash), `.tab__icon` (18 px, accent when hovered/selected), `.tab__label`, `.tabs--icon` (mixed-case `--fs-sm` 500 labels; icons only ≤ 680 px) | §3.12 | The shell already emitted `aria-selected`; `.tab` is uppercase per spec, the icon variant is not — the app names are data the DOM-text goldens read. `.tabs` must stay a flex container: its items are blockified, which is what keeps one tab label per innerText line (a block `.tabs` with inline-flex tabs would join them). |
| 18 | `.acc` (card, `padding:0`), `summary.acc__head` (mono `--fs-xs` 500 uppercase eyebrow, 14 px stroked chevron mask on the **left** rotating 90° on `[open]`, hover wash), `.acc__badge` (float right), `.acc__body` (grid, `--sp-3` gap, hairline top) | §3.6 | Replaces `.st6-adv` / `.st6-adv-body` and the `'+'`/`'−'` text marker for the five apps. The head is `display:block`, not flex: a flex head blockifies the `<sub>`s of "Factor chain (γ<sub>Rd</sub> / ξ / …)" and splits its innerText line (§3.2). |
| 19 | `.cols-3` (`var(--col-side) minmax(0,1fr) var(--col-inspector)`, `--sp-4` gap, one column ≤ 1 100 px), `.cols-2` (one column ≤ 900 px), `.viz-grid` (auto-fit 16 rem), `.stack--tight` (`--sp-2` rhythm for eyebrow → table → note inside a quiet card), `.st6-switch` / `.st6-banner` (`--sp-4` below the shell parts — `#stage6Area` is the Svelte skeleton's, so its children space themselves), `.card__head--stack` (title over subtitle), `.card--note` (dense help: `--sp-2 --sp-3` padding, `--fs-xs`, ink-2), `.formula` (mono equation line), `.fieldset` (hairline-topped group), `.verdict--prose` (block verdict for the shared banner), the `.is-computing` de-blur hook, the transitional `.st6-app .info` recipe | §5.2 row 2e, §3.5, §3.11, §4.1 rule 3 | See §3 for `.st6-app .info` and `.verdict--prose`. |
| 20 | `.fields--stack` (the quiet input column: one field per row), `.field-stack` (label text over a full-width control — sets **no** `display`), `.field-stack > .input/.range` (`inline-block; width:100%`), `.check--row`, `select.input` (appearance none, 12 px chevron, dark variant) | §3.7 | `.field-stack` keeps its in-flow display on purpose: as a grid item it is blockified (one field per line), inside the beam EC2 `.fieldset` — a plain block — it stays inline, and the innerText line structure of `07-beam.dom.txt` ("Concrete class fck (MPa)ⓘ Steel fyk (MPa)ⓘ Exposure classⓘ" on one line) follows from exactly that. |
| 21 | `.tbl--kv tr.tbl__sec` (left-aligned eyebrow section rows with rules; `.series-3/-6` tones), `td.tbl__k` / `td.tbl__v` (multi-pair rows: mono keys **in their own case**, medium values), `td.tbl__note` (trailing comment cell), `tr.is-ok` / `tr.is-fail` (utilisation rows), `.tbl--sm`, `td.tbl__empty`, `.ink-good/-bad/-muted`, `.pills` (flex row of pills) | §3.9, §3.10 | The multi-pair keys keep mixed case because `07-bearing.dom.txt` reads "DRAINED COMBO DA1/2 Undrained combo DA1/1 γ_Rd 1.00" — only the first column was ever uppercase. |
| 22 | `.viz__label` (mixed-case caption, body `--fs-xs` 500 ink-2), `.viz__body` (`position:relative; height: var(--viz-h, 13.75rem)`), `.viz--section > svg` (`--viz-h` height), `.viz__key` (8 px series dot + label; `.series-1/-3/-6`), `.card__eyebrow.series-3/-6` | §3.13 | `--viz-h` replaces the inline `height:420px` and its `[style*="height:420px"]` attribute override; ≤ 900 px it is capped at 62 vh like before. |
| 23 | ≤ 1 100 / ≤ 900 / ≤ 760 px rules; `pointer:coarse` (44 px tabs/heads); forced colours | §4.3 | |

### 1.2 Markup — the shell and the five app templates

| Legacy → component | Where |
|---|---|
| `.app-switch` › `.app-chip(.sel)` › `.app-chip-ico` / `.app-chip-lbl` → `.tabs.tabs--icon.st6-switch` › `.tab` (`aria-selected` already there) › `.tab__icon` / `.tab__label`; the shared banner `.info` + inline style → `.verdict.verdict--neutral.verdict--prose.st6-banner`; the no-layers placeholder → `.empty` › `.empty__text` | `stage6/shell.js` |
| App root `.mc2` → `.mc2.card.st6-app.stack` (see §3.1 for the kept `mc2`); `.mc2-head` + two inline-styled spans → `.card__head.card__head--stack` › `span.card__title` / `span.card__text` (spans on purpose: `</span>` is not a line break for the Node goldens, the flex head blockifies them for innerText exactly as `.mc2-head` did) | all five `panel.js` |
| `style="display:grid;grid-template-columns:260px 1fr 250px;…"` (bearing), `280px 1fr 260px` (settlement, dewatering), `300px 1fr 280px` (beam), `.st6-pile-cols` (pile) → `.cols-3`; the `1fr 1fr` audit rows and `.st6-pile-tables` → `.cols-2`; `.st6-pile-charts` → `.viz-grid`; `.st6-pile-visuals` → `.stack`; the `margin-top:14px` siblings → the root's `.stack` rhythm | all five |
| "Inputs" / "Summary" `<div style="font-size:10px;…;text-transform:uppercase">` → `.card__eyebrow`; `.ctrl-row` + inline grid → `.fields.fields--stack`; `<label style="font-size:11px…">text<select style="…">` → `label.field-stack` › `select.input`; number inputs → `.input.input--num` (right-aligned mono); the Df slider block → `div.field-stack` › `input.range`; checkbox labels (inline `display:flex`) → `label.check.check--row`; the beam EC2 block → `.fieldset` | all five |
| `<details class="st6-adv">` / `<summary>` / `.st6-adv-body` → `details.acc` / `summary.acc__head` / `.acc__body` (`data-st6details` keys unchanged) | bearing, pile, settlement, beam |
| `.st6-help` → `.card.card--quiet.card--note` | all five |
| Chart captions `<div style="font-size:10px;color:var(--tx2)">` + `<div style="position:relative;height:Npx">` → `.viz` › `.viz__label` + `.viz__body[style="--viz-h:Npx"]`; the bearing legend spans → `.viz__key.series-6/-3/-1`; pile `.st6-pile-chart` / `__title` (uppercase) / `__cv` → `.viz` / `.viz__title` / `.viz__body`; the pile `<svg style="height:520px;background:…;border:…">` → `.viz.viz--section[style="--viz-h:520px"]` › `svg` | bearing, pile, settlement, dewatering, beam |
| `table.pt` → `table.tbl.tbl--kv`; the inline-styled `colspan="2"` section cells → `tr.tbl__sec` (+ `.series-6` Drained / `.series-3` Undrained); the 6-column parameter tables → `td.tbl__k` / `td.tbl__v`; the factor-chain comment column → `td.tbl__note`; governing rows → `tr.key`; `utilColor()` inline colours → `tr.is-ok` / `tr.is-fail` | bearing, pile, settlement, dewatering, beam |
| `.info` boxes the panels own (ULS parameters, formula route, per-layer cards) → `.card.card--quiet` (+ `.stack--tight`) with `.card__eyebrow` (+ `.series-*`), `.formula`, `.card__text`; `.mc2` › `.mc2-sec` › `table.tbl` → eyebrow + `.tbl-wrap` › `table.tbl` (`th.num` / `td.num`); the audit-sublayers `max-height:320px` → `--tbl-wrap-max:20rem` | bearing, pile, settlement, dewatering, beam |
| Pile PASS/FAIL badges (inline pills) → `.pills` › `.pill.pill--good/--bad`; per-layer status spans → `.ink-good/-bad/-muted` | `pile/panel.js` |

Not touched: any id, `data-*`, `on*=` handler, `title` / `aria-*`, visible text or its casing; `core/format.js` (`noteHtml`,
`loadSummaryHtml`, `tooltip` — outside the file set, still emitting `.info` / `.tbl.st6-audit` / `.st6-tip`, see §3.2);
`chart-factories.js`; the Stage 6 Svelte skeleton (`.sec`, `.foot`, `#stage6Area`); the Bishop and retaining regions.
The Stage 6 shared builders left in `legacy-controller.js` are one-line façades over the packages (no markup) — nothing
to edit there.

### 1.3 Colours — `theme.ts`, `pile/charts.js`, `pile/canvas.js`

- `theme.ts` gains `withAlpha(color, a)` (alpha on a resolved `rgb()` token) and `pileVizSeries()` — the §3.13 assignment
  for the pile app resolved for the current theme: De Beer `qc` → `--viz-neutral`, `qh` → `--viz-2` (dashed), `qd` →
  `--viz-3`, `qu` → `--viz-5`, `qp` → `--viz-6`, toe marker → `--viz-4`; shaft rows excluded / above N.P. / contributing →
  neutral @ .6 / `--viz-3` / `--viz-6`; load–settlement + N(z) → `--viz-1` (+ .12 fill), `F_rep` → `--viz-2`, `R_c,d` →
  `--viz-4`, `s_allow` → `--viz-3`.
- `pile/charts.js` recolours the factory configs by dataset label (`applyPileSeriesColours`, `applyPileShaftColours`)
  before `new Chart()` — `chart-factories.js` still carries the legacy `rgba(216,90,48)/(40,90,180)/(29,158,117)` set but
  is outside this PR's file set. The bearing / settlement / dewatering / beam factories already read `--chart-*`, which
  alias to `--viz-*` in `tokens.css`, so those charts were on the palette since phase 1.
- `pile/canvas.js`: every paint of the SVG section is a `var(--token, <light literal>)` — paper `--canvas-paper`, grid
  `--canvas-grid`, hatches / axis / soil strokes `--viz-axis`, labels `--viz-text` (+ `--viz-text-muted` ticks) with a
  `--viz-halo` stroke, pile outline `--viz-2`, handles `--viz-1` on `--canvas-paper`, water `--viz-water`, neutral plane
  / downdrag hatch / timber `--viz-3`, active shaft `--viz-6` @ .18, dimensions `--viz-neutral`, tooltips
  `--viz-tooltip-bg`; soil fills `--soil-*` through `SOIL_CLASS_NAMES`. The `<style>` block's `prefers-color-scheme`
  override is gone — the section now follows the in-app theme toggle too. `#dimArrow` is still referenced without a
  definition (pre-existing).

### 1.4 `src/lib/cpt-app/legacy.css` — 1 948 → 1 887 lines

Deleted (no consumer left; census over `src`, `tests`, `scripts`): `.app-switch`, `.app-chip` (+ `:hover`, `.sel`, `-ico`,
`-ico svg`, `-lbl`, the ≤ 680 px block), `.mc2-body` ×3 incl. its `[style*="grid-template-columns:1fr 1fr 1fr"]` override,
the eight `.st6-pile-*` rules + their two media blocks, the dead `#stage6Area>.mcards` (its class left in PR 10), and —
from the ≤ 900 px block — the `[style*="grid-template-columns:260px 1fr 250px"]`, `280px 1fr 260px`, `300px 1fr 280px`
and `[style*="height:420px"]` attribute overrides. Four nested `backdrop-filter`s removed (§1.5). **Kept** (see §3.4):
the `[style*="grid-template-columns:1fr 1fr 1fr"]`, `200px 1fr 200px`, `1fr 1fr` and `[style*="height:380px"]`
overrides — they serve the Stage 2/4/5 inline grids and the Stage 1 chart heights PR 10 left in place. Kept on purpose
(Bishop / retaining / stratigraphy / report consumers): `.mc2`, `.mc2-head`, `.mc2-sec`, `.pt`, `.info`, `.tbl`, `.st6-adv*`,
`.st6-help`, `.ctrl-row`, `.st6-tip`.

### 1.5 §4.1 blur rules

- Rule 1 — the `blur(12px)` on `.st6-canvas-tool-btn` and `.st6-canvas-card-close` and the `blur(10px)` on
  `.st6-canvas-card-section` and `.st6-canvas-card-note` are deleted (legacy.css; they sat *inside* the blurred dock /
  card). The controls keep their wash. This is the one Bishop-shell touch: CSS only, no markup.
- Rule 3 — `components.css` §19 carries the `.is-computing` contract: `.is-computing :is(.glass, .glass-float,
  .st6-canvas-dock, .st6-canvas-card, .st6-bishop-view-menu, .st6-canvas-capture)` → `backdrop-filter:none` +
  `--glass-bg-strong`. The JS toggle on the canvas stage belongs to the Bishop shell PR (the search runner is in the
  controller's Bishop region, off-limits here), so the rule is inert until then.

### 1.6 Harness

- `tests/visual/app.spec.mjs`: the Stage 6 ready selector `#stage6Area .app-chip` → `#stage6Area .tabs--icon .tab`.
- 68 baselines re-written under `tests/visual/__screenshots__/app.spec.mjs/`: `stage6-{bearing,pile,settlement,dewatering,
  beam}`, `stage6-bishop-dock-card`, `stage6-retwall-sheetpile` + its 8 tabs, `stage6-retwall-soldierpile-drivability`,
  `canvas-retwall-sheetpile` × {desktop, mobile} × {light, dark}. Nothing else was rewritten.

## 2. Before / after

`worklog/refactor/20-screenshots/{before,after}/<shot>--<desktop|mobile>-<light|dark>.png` — desktop downscaled to 1 000 px,
mobile at its native 390 px; the full-resolution "after" images are the live baselines.

| Shot | First-run diff ratio (desktop light) | What the eye sees |
|---|---|---|
| shell (all Stage 6 shots) | — | Icon tabs on a hairline with the accent underline instead of pill chips; the context line as a neutral verdict with a 3 px rule. |
| `stage6-bearing` | 0.46 (2 056 → 2 109 px) | `.cols-3` on the tokens; a quiet input column with eyebrow-labelled fields, right-aligned mono numbers, custom select chevrons, the accordion with a left chevron; the chart on graph paper with dot-keyed legend; the selected-depth table as `.tbl--kv` with eyebrow section rows in the series colours; the DA1 parameter card, the two formula cards and the notes as quiet cards. |
| `stage6-pile` | 0.44 (2 987 → 2 931 px) | Section view inside a `.viz` on paper, tokens-only paints (dark theme follows the toggle); four chart papers; summary table with `.key` R_c,d and utilisation rows in tone; PASS/FAIL as pills; per-layer table in a scrolling `.tbl-wrap` with right-aligned numbers; factor chain with a muted comment column. |
| `stage6-settlement` | 0.50 (2 608 → 2 540 px) | Same anatomy; the load audit scrolls horizontally instead of breaking words; per-layer + audit tables in `.tbl-wrap` (the audit capped at 20 rem). |
| `stage6-dewatering` | 0.43 (2 952 → 2 903 px) | Same; the three summary notes as quiet notes under the table. |
| `stage6-beam` | 0.39 (3 941 → 4 142 px) | Same; the EC2 reinforcement `.fieldset` keeps its in-flow labels (spaced through the inputs' bottom margin); the durability audit as a quiet card. |
| `stage6-bishop-dock-card` | 0.09 | Shell parts only (tabs, banner) + the dock buttons / card sections without their nested blur — a solid wash on the glass dock instead of blur-in-blur. |
| `stage6-retwall-*` (10 shots), `canvas-retwall-sheetpile` | 0.08–0.11 / 0.01 | Shell parts only: the page is 5 px taller (tabs + banner), everything below shifts. The canvas shot differs by ~1 800 px (0.5 %) from the sub-pixel offset the shift gives the `<canvas>` (the raster is identical in size); the visual project's `maxDiffPixels: 0` also applies to the "tolerant" canvas shots (min of the two limits), so it had to be re-baselined. |

Mobile (390 px): tabs collapse to icons ≤ 680 px, `.cols-3` / `.cols-2` stack ≤ 1 100 / 900 px, chart hosts cap at 62 vh,
the section view at 62 vh, tables scroll inside their wrap.

## 3. Deviations from the spec and why

1. **The app root keeps `mc2` as its first class** (`class="mc2 card st6-app stack"`). `scripts/golden/suites/stage6-shared.mjs`
   slices the shell head at `html.indexOf('<div class="mc2')` — with any other first class the `switch.<app>.head`
   goldens would compare the wrong text (and `scripts/golden` is outside this PR's file set). `.card` (layer `components`)
   wins over the legacy `.mc2` recipe for everything but its `margin-bottom`, which keeps today's spacing under the app.
   Rename when the suite marker moves to `.st6-app`.
2. **`core/format.js` output is styled transitionally** — `noteHtml` (notes), `loadSummaryHtml` (load audits) and
   `tooltip` (`.st6-tip`) are shared helpers outside the file set. `.st6-app .info` takes the quiet-card recipe (their
   inline tone colours stay), and `.st6-app .st6-audit` becomes a nowrap, horizontally scrolling table instead of the
   fixed-layout word-broken one. Bishop's `.info` boxes are outside `.st6-app` and unchanged.
3. **`.acc__head` is the legacy mono-uppercase eyebrow, not the spec's 600 `--fs-sm` body font** — the browser goldens read
   "LOAD ASSUMPTIONS AND EUROCODE COMBINATION" (the second, winning copy of `.st6-adv summary` in legacy.css already
   upper-cased it). Likewise `.tabs--icon .tab` and `.viz__label` are mixed case, `.viz__title` (pile chart titles) is
   uppercase: each follows the casing its golden already had.
4. **Four `[style*="…"]` attribute overrides survive in legacy.css** (`1fr 1fr 1fr`, `200px 1fr 200px`, `1fr 1fr`,
   `height:380px`): they collapse the Stage 2/4/5 inline grids and cap the Stage 1 chart heights on mobile — PR 10 left
   those inline styles in place, and deleting the overrides moved Stage 1/2/4 mobile shots (found by the first visual
   run, restored). They go with the Stage 1–5 inline grids.
5. **`.verdict--prose`** — the shared banner is a `.verdict` with `display:block`: the flex verdict blockifies the
   `<strong>`s and splits the innerText line "Active CPT: CPT-1 · WT = 1.70 m …" the goldens read.
6. **`.field-stack` sets no `display`** and the beam EC2 block is a plain `.fieldset` (see §1.1 row 20).
7. **Helper classes the spec does not name**, kept minimal: `.cols-2`, `.viz-grid`, `.stack--tight`, `.card__head--stack`,
   `.card--note`, `.formula`, `.fieldset`, `.fields--stack`, `.field-stack`, `.check--row`, `.viz__label`, `.viz__body`,
   `.viz--section`, `.viz__key`, `.tbl__sec`, `.tbl__k`, `.tbl__v`, `.tbl__note`, `.tbl--sm`, `.tbl__empty`, `.pills`,
   `.ink-*`, `.series-*`, `.st6-app`, `.st6-switch`, `.st6-banner`.
8. **Chart.js recolouring lives in `pile/charts.js`**, not in the factories (§1.3).
9. The Bishop root (`.mc2.st6-bishop`) and the retaining root (`.mc2.st6-retwall`) still get the legacy `.mc2` — untouched
   by design (2d canvas shell / 2f).

## 4. Verification

| Check | Command | Result |
|---|---|---|
| Layout + canvas screenshots | `PW_PORT=5499 npx playwright test --project=visual` | baseline run on the untouched tree: 14/14 (harness sane). First run after the restyle: the Stage 6 set + (from the deleted overrides) Stage 1/2/4 mobile — fixed (§3.4), second run: **only Stage 6 names** differ, Stages 1–5 × 4, both phases, docs × 2, rekennota screen + print media + **PDF page 1 = 0 px**. After `--update-snapshots` (68 files, all Stage 6): **14/14**, re-run **14/14** (twice: once more after the de-blur). |
| Token integrity + contrast | `npm run verify:tokens` | OK — 191 `var()` usages defined, dark blocks identical, contrast table passes; built CSS: 6 unlayered rules, the report-route `:global` ones (unchanged) |
| Build | `npm run build` | OK |
| Type check | `npm run check` | 6 errors, 0 warnings — the pre-existing set (`vite.config.ts`, `wall-result-staleness.js`) |
| Node goldens | `npm run golden:check` | **1 619 / 1 619**, 0 mismatches (run after the markup, and again at the end) |
| Behaviour | `PW_PORT=5499 npx playwright test --project=e2e` | 3 passed, 2 skipped (as before) |
| Browser goldens | `GOLDEN_PORT=5599 GOLDEN_VISUAL=soft …golden.config.mjs` | **2/2** — every `dom.txt` exact (the five `07-<app>` steps and their field steps included); PNGs soft-mismatch as before (never re-recorded since PR 10) |
| Blur count | `getComputedStyle(el).backdropFilter !== 'none'`, 1 500 px | **2** on each of the five apps (chrome + rail); **4** on Bishop with the dock + "View" card open (chrome, rail, dock, view menu) — was **14** before §1.5 |
| Frame budget | rAF counter during a 2 s `stage6BishopRunSearch()` with the dock + card open (headless Chromium, `--use-gl=angle`) | **240 frames, median 120 fps, p95 frame 9.5 ms** |
| `verify:core` | `npm run verify:core` + the chain's tail one by one | see §5 |

## 5. `verify:core` — what fails and why

`npm run verify:core` exits 1 at its fifth link, **`verify:classification-layers` — 259/260**: the check "metric tiles,
note variants and the row table are the runClass markup" asserts the legacy `.met` / `.met-l` / `.layerwarn-bad` /
`.data-note` classes that PR 10 renamed to `.stat` / `.verdict` in `classification/panel.js`. It fails on `integration-r`
itself (a PR 10 leftover, not touched here — `scripts/` is outside this PR's file set); the `&&` chain then skips
everything after it. The tail of the chain was run one script at a time:

| Script | Result |
|---|---|
| `verify_window_handlers`, `verify_core` (18/18), `verify_model_params` (188/188) | OK — before the broken link |
| `verify_load` 45/45 · `verify_export_report` 57/57 · `verify_project_section_tuning` 63/63 · `verify_nen6740` · `verify_stratigraphy` · `verify_import_review` · `verify_project_io` · `verify_scia_db4` · `verify_qc_only_handling` · `verify_bishop_phase_a_parity` · `verify:retaining` · `verify:wasm` | all exit 0 |
| `verify_bearing` **519 / 519** · `verify_pile` **586 / 586** · `verify_settlement_dewatering_beam` **2 260 / 2 260** · `verify_stage6_shell` **100 / 100** | exit 0 — **no assertion fails on the class names**, for a reason worth knowing: |

The four base-ref verifiers materialise only the base *controller* (`git show integration-r:legacy-controller.js`) next to
the working tree and let it import the app packages from there (`verify_pile`'s `MOVED_SIBLINGS` re-materialises only the
pre-PR 12b `stage6-pile*.js` modules, which the integration-r controller no longer imports; the other two lists are empty).
Both sides therefore render the *same* PR 13 panels, and the "byte-identical innerHTML" checks compare the working tree
with itself — vacuous for markup since PR 12a–c moved the builders out of the controller. The half that still bites is
(c): the `tests/golden/node/stage6-*` files recomputed from the pure packages, which are `htmlToText` **text** (plus the
analysis JSON) and pass because no string changed. So: nothing to list as "fails purely because of class names"; the
verifiers stopped guarding Stage 6 markup byte-identity the day the packages became the source of truth. A markup gate that
would catch a class rename now lives in the screenshot baselines and the DOM-text goldens (both green).

## 6. Running the harness from an agent worktree (adds to report 19 §5)

- The scratch Vite config must be an `.mts` file that does **not** import `vite` (the scratchpad has no `node_modules`):
  spread the repo config from an absolute path and override `root`, `server.fs.allow` and `server.watch.ignored`. Two
  servers (5499 for `playwright.config.mjs`, 5599 for `golden.config.mjs` via `GOLDEN_PORT`) start with `--config <scratch>`
  and both Playwright configs pick them up through `reuseExistingServer`.
- Do not edit `src/` while a visual run is in flight — HMR ships the edit into the next screenshot.
- The "tolerant" canvas shots are effectively 0 px: the project-level `maxDiffPixels: 0` is combined with `shotCanvas`'s
  `maxDiffPixelRatio: 0.02` as the *minimum* of the two. Worth an override in `helpers.mjs` (`maxDiffPixels: undefined`).

## 7. Next (2d Bishop shell, 2f, and later)

Toggle `.is-computing` on the Bishop canvas stage around searches / drags (the CSS is in place); move the dock / card /
view menu to `.glass-float` + `.acc` (2d); migrate `core/format.js` to `.verdict` / `.card--quiet` + `.tbl-wrap` and
`.tip` (2g), then drop the `.st6-app .info` / `.st6-audit` transitional rules; move the `stage6-shared` golden marker off
`<div class="mc2` and rename the root; delete the last four `[style*=…]` overrides with the Stage 1–5 inline grids; widen
`.tbl-wrap > .tbl` → `.tbl` once Bishop / retaining / the report tables are wrapped.
