# 19 — PR 10 `style(stage1-5)`: component classes replace legacy selectors

_Worklog · refactor · 2026-08-29 · worktree branch off `integration-r` (3f2166c). Implements rows **2b** (Stage 1–2)
and **2c** (Stage 3–5) of `02-design-system.md` §5.2 on top of the shell PR (f30d251)._

**TL;DR.** Stage 1–5 now render through the component vocabulary of `src/lib/styles/components.css` — panel anatomy,
cards + stat tiles, `.fields`/`.field` control bars with `.input`/`.range`/`.check`, the `.empty.dz` dropzone,
`.pill` soil badges, `table.tbl` inside `.tbl-wrap` + `.tbl--kv`, `.verdict` banners and `.viz` chart paper — all
tokens-only, dark mode through the tokens, no new blur. The five Svelte skeletons and every Stage 1–5 string builder
emit the new classes; 60 lines of fully replaced rules left `legacy.css`. Every id, `data-*` attribute, `on*=`
handler and visible string is unchanged: `golden:check` is 1 619/1 619 bit-identical, the browser DOM-text goldens
pass exactly, the 32 Stage 1–5 screenshot baselines were reviewed and re-baselined, and Stage 6, both phases, docs,
the rekennota on screen and its print PDF page 1 are **0 px**. Blur count on any Stage 1–5 page: **2** on desktop
(chrome + rail), **0** below 900 px.

---

## 1. What changed

### 1.1 `src/lib/styles/components.css` — sections 7–16 (layer `components`, `:where(.cpt-app)`-scoped)

| § | Classes | Spec | Notes |
|---|---|---|---|
| 7 | `.panel__head` `.panel__title` `.panel__sub` `.panel__actions` `.panel__body` `.panel__foot` `.panel__foot__note`; rhythm `:is(.panel__body,.stack) > * + *` + `> :empty { display:none }` | §3.5 | The `.panel` frame (`display:none` / `.active`) stays the legacy rule: Stage 6 shares it and its recipe already equals the spec through the token aliases. Empty placeholders the controller fills later (`#layerWarnings`, `#classAssumedRfNote`, `#ma`) take no room until they have content. |
| 8 | `.card` `--quiet` `--select` (`.sel`/`.is-selected`/`[aria-pressed]`), `.card__head` `__title` `__text` `__hint` `__eyebrow`, `.eyebrow`, `.card-grid`, `.stats` (`--dense`, `--meta`), `.stat` `__label` `__value` `__unit` | §3.5 | `.sel` is what `syncClassificationMethodCards()` toggles; aliased next to the spec name like the shell did for `.togbtn.active`. |
| 9 | `.fields`, `.field` `__label` `__row` `__unit` `__hint`, `.input` `--num` `--sm` (`.ovr`/`.is-override`), `.range`, `.check` | §3.7 | No `-1px` lift on focus; spin buttons hidden (Chrome reserves ~15 px for them even when invisible, which clipped the controller's 52 px inputs in Stage 4). |
| 10 | `.empty` `__icon` `__title` `__text`, `.empty.dz` (`.drag`) | §3.15 | `.drag` is toggled by the controller's dragover/dragleave. |
| 11 | `.pill` + `--good/--warn/--bad/--info/--neutral` (6 px dot), `.pill.s-*` soil fills from `--soil-*` | §3.9 | Soil badge keeps **mixed case** (the name is data and the innerText goldens read it); ink = `color-mix(--soil 28 %, --color-bg-dark)` — tokens only, dark in both themes on the fixed pastel. |
| 12 | `.tbl-wrap` (`--tbl-wrap-max`), `.tbl-wrap > .tbl` (sticky mono `th`, `.num`, `.key`, `.is-selected/.gov`, `.is-fail`), `.tbl--kv` (`.key` rows) | §3.10 | **Transitional scope** — see §3.1. |
| 13 | `.verdict` + tones, `__tag` `__body` `__meta`, `--inline`; `.verdict > br { display:none }` | §3.11 | Flex instead of the 3-column grid so a banner without a tag (Stage 3/5 notes) still fills; the string-rendered `renderCompatWarnings` keeps its `<br>` (that file is class-attributes-only) — hidden, and the innerText is the same either way (flex items are blockified). |
| 14 | `.viz` `__title` (`> svg` block) | §3.13 | Graph paper from `--canvas-grid` / `--canvas-paper`; `contain: layout paint`. |
| 15–16 | ≤ 900 / ≤ 760 px rules; `pointer:coarse`, reduced motion, forced colours | §4.3 | Mobile: every `.field` full-width, `.range` and `.input--num` share the row, stats in two columns. |

### 1.2 Markup — Stage 1–5 skeletons and string builders

| Legacy → component | Where |
|---|---|
| `.sec` / `.sec-title` / `.sec-sub` → `.panel__head` / `.panel__title` / `.panel__sub` (+ `.panel__actions` for the head buttons); direct children of `.panel` wrapped in one `.panel__body`; `.foot` → `.panel__foot` (inside the body — Stage 1's foot lives in `#s1body`) | `Stage1Load` … `Stage5Tuning.svelte` |
| `.dz`/`.dz-icon`/`.dz-title`/`.dz-copy` → `.empty.dz` / `.empty__icon` / `__title` / `__text` | `Stage1Load.svelte` |
| `.mgrid`/`.mi`/`.mi-l`/`.mi-v` → `.stats.stats--meta`/`.stat`/`.stat__label`/`.stat__value`; `.mrow`/`.met*` → `.stats.stats--dense`/`.stat*` | `Stage1Load.svelte`, `load/controls.js` (`renderMetaCard`), `Stage2Classification.svelte`, `classification/panel.js` |
| `.ctrl-row` bar → `.fields`; each label + controls → `.field` › `.field__label` + `.field__row`; `.ctrl-num` → `.input.input--num`; inline-styled unit/hint spans → `.field__unit` / `.field__hint`; range inputs → `.range`; the smart-merge `<label>` → `.check`; `.ctrl-sep` dropped (gap does the job); `#assumedRfCtrl` stays the wrapper the controller shows with `display:inline-flex`, the `.field` sits inside it | Stage 1, 2, 3, 4 skeletons |
| `.togbtn` groups in inline-styled boxes → `.segmented[role=radiogroup]` › `.segmented__btn` (`.active` still toggled by `setParamMethod` / `setAlphaMethod` / …) | Stage 3, 4 |
| `.mcards.stage2-methods` / `.mc` (+ `h3`, `p`) → `.card-grid` / `.card.card--select` / `.card__title` / `.card__text`; the “Recommended” span → `.card__hint` | Stage 2 |
| `.cc`/`.col-card`/`.ct` → `.viz`/`.viz__title` | `Stage1Load.svelte`, **`project/cpts.js`** (`CHART_AREA_HTML` — the same Stage 1 markup `selectCpt()` re-renders; found by the row-2b grep) , Stage 2 layer preview (the `.preview-wrap` + svg now sit in a `.viz`; the svg's inline border and the `!important` paper rule are gone) |
| `<div style="overflow-x:auto"><table class="tbl">` → `.tbl-wrap` › `table.tbl`; `th`/`td` gain `.num`/`.key`; the preview `thead` loses its inline sticky style; `--tbl-wrap-max: 20rem` replaces the inline max-height | Stage 2, 3 skeletons; `classification/panel.js` (`classificationTableRowsHtml`); `legacy-controller.js` `renderLayers` (class attributes only: `td.num`, `td.key`) |
| `.ed`(`.ovr`) → `.input.input--sm`(`.ovr`) | `renderLayers`, `renderModel` (class attributes only) |
| `.sb` → `.pill` | `classification/panel.js`, `renderLayers`, `renderModel`, `tuning/panel.js` |
| `.info` → `.verdict.verdict--info` (Stage 3) / `.verdict.verdict--warn` (Stage 5, inline amber style dropped); `.layerwarn(-bad/-adj)`/`-k`/`-msg` → `.verdict(--bad/--warn)`/`__tag`/`__body`; `.data-note` → `.verdict.verdict--inline.verdict--neutral` | Stage 3/5 skeletons, `classification/panel.js` |
| `.mc2`/`.mc2-head`/`.mc2-sec`/`.pt` → `.card`/`.card__head`/`.card__eyebrow`/`table.tbl.tbl--kv`; `#ma` and `#tuningArea` are `.stack`s; the tuning card's `[data-chart-pending]` element moved **inside** its card as a hidden last child (charts.js finds it by `querySelectorAll` + ids, so position is irrelevant) so cards are siblings and the stack rhythm applies | `renderModel` (class attributes only), `tuning/panel.js` |
| `.btn.pri` / `.btn.sm` / `.btn.pri.sm` → `.btn.btn--primary` / `.btn.btn--sm` | all five skeletons, `tuning/panel.js` |

Not touched: any id, `data-*`, `on*=` handler, `title`/`aria-*`, visible text or its casing (`text-transform` only where legacy already had it: `th`, eyebrows, mono labels); the `.st6-tip` tooltip buttons; the Stage 4/5 inline column grids (`grid-template-columns:200px 1fr 200px` etc. — their ≤ 900 px collapse rule in legacy.css still matches); the two coloured foot buttons (Stage 4 “Stage 5 — Tuning” amber outline, Stage 5 “Stage 6 →” accent) — inline, now on `--color-*` tokens.

### 1.3 `src/lib/cpt-app/legacy.css` — 44 edits, 2 008 → 1 947 lines (69 − / 9 +)

Deleted (fully replaced, no other consumer — census over `src`, `tests/e2e`, `scripts/golden`): `.dz-icon/.dz-title/.dz-copy`
(+ their ≤ 760 px sizes), `.mgrid`, `.mi/.mi-l/.mi-v`, `.met/.met-l/.met-v`, `.mrow`, `.ctrl-num` (rule + both selector-list
entries + the ≤ 760 px list), `.ctrl-sep` (+ mobile), `.cc/.col-card` (rule + padding), `.ct` (list entry + margin),
`.mcards` (+ ≤ 900 / ≤ 760 px), `.mc` `:hover` `.sel` `h3` `p`, `.stage2-methods`, `.stage2-method-card` ×3, `.sb`, the seven
`.s-*` fills, `.ed`, `.ed.ovr`, `.data-note` (+ `strong`), `.preview-wrap svg` from the `!important` paper rule, and the
`.mcards,.mc,` / `.mrow` entries of the min-width list. The `.panel > …{margin}` hack shrank to `.panel>#stage6Area` (desktop +
mobile). Kept on purpose — still used outside Stage 1–5: `.panel/.panel.active`, `.sec*` (Stage 6, phase panels, import dialog),
`.ctrl-row/.ctrl-lbl` (Stage 6 panels, banner, stratigraphy), `.dz/.dz:hover/.dz.drag` (`/report` gateway), `.tbl` (Stage 6,
`/report/stage7`), `.info`, `.layerwarn*` (stratigraphy), `.mc2*`, `.pt*`, `.foot`, `.report-stat`, `.report-canvas`,
`.mc2-sec` in the eyebrow list, and the Stage-specific leftovers `.chart-area`, `.class-layout`, `.preview-wrap`,
`.section-tip`, `.load-demo-row`, `#layerColSvg`.

### 1.4 Harness

- `playwright.config.mjs`: `const PORT = process.env.PW_PORT || '5199'` feeds `baseURL` and the `webServer` command/url — the only change in that file.
- `tests/visual/app.spec.mjs`: the Stage 4 ready selector `#ma .mc2` → `#ma .card`.
- 32 baselines re-written under `tests/visual/__screenshots__/app.spec.mjs/`: `home-empty`, `stage1-demo`, `canvas-stage1-qc`,
  `stage2-classification`, `stage3-layers`, `stage4-model`, `stage5-tuning`, `import-review` × {desktop, mobile} × {light, dark}.
  `home-empty` and `import-review` are Stage 1 states (the empty panel; the dialog over Stage 1). Nothing else was rewritten.

## 2. Before / after

`worklog/refactor/19-screenshots/{before,after}/<stage>--<desktop|mobile>-<light|dark>.png` — desktop downscaled to 1000 px,
mobile at its native 390 px; the full-resolution "after" images are the live baselines.

| Stage | First-run diff ratio (desktop light / dark) | What the eye sees |
|---|---|---|
| 1 `stage1-demo` | 0.18 / 0.16 (page 1446 → 1397 px tall) | Dropzone as `.empty` (32 px muted icon, 16 px title, ≤ 56ch copy); metadata as quiet `.stat` tiles at prose size; the control row is a `.fields` bar with eyebrow labels over their controls, hints inline; charts on graph paper with teal `.viz__title`; foot rule inset in the body. |
| 2 `stage2-classification` | 0.32 / 0.32 (1296 → 1303 px) | Method cards in a `.card-grid` (selected: teal wash + 2 px inset rule), metric tiles at `--fs-xl`, preview table with sticky mono head + right-aligned mono numbers + soil pills, the layer preview inside a `.viz` with its title. |
| 3 `stage3-layers` | 0.49 / 0.53 (1603 → 1581 px) | `.segmented` parameter switch with its hint, the note as a teal `.verdict--info`, the 15-column table in a `.tbl-wrap` — numbers right-aligned, never wrapping (the old "0.58 / m" break is gone), inputs `.input--sm` filling their cells, soil pills. |
| 4 `stage4-model` | 0.14 / 0.15 (5862 → 5805 px) | Layer cards (`.card` + `.card__head` with pill and σ′ summary), four `.card__eyebrow` columns, `.tbl--kv` key/value tables with accent `.key` rows; the ν / r_shear / αE / m inputs no longer clip. |
| 5 `stage5-tuning` | 0.03 / 0.03 | Amber `.verdict--warn`, placeholder, foot. After "Run fitting" (not baselined): tuning cards as `.card` with `.tbl--kv` numbers and `.btn--primary.btn--sm` accept. |

Mobile (390 px): every `.field` takes the full width with its range and number sharing the row (before: each label, input and hint on its own line), stats in two columns, `.tbl-wrap` scrolls horizontally with the sticky head, foot buttons full width.

## 3. Deviations from the spec and why

1. **`table.tbl` is scoped transitionally** to `:is(.tbl-wrap > .tbl, .tbl--kv)` inside `.cpt-app`. The spec's table class shares its name with the legacy `.tbl` that Stage 6 and `/report/stage7` still use; a global `.tbl` in the `components` layer would restyle them (the 0 px gate). Every Stage 1–5 table is wrapped or key/value, so the scope covers all of them. **2d/2h:** wrap the Stage 6 tables and widen the selector to `.tbl`, then delete legacy `.tbl`.
2. **Container / helper classes the spec does not name**, kept minimal and BEM-consistent: `.panel__title/__sub/__actions/__foot/__foot__note`, `.fields` (the control bar; the spec's `.field` is one label + control), `.field__hint`, `.card__title/__text/__hint`, `.card-grid`, `.stats` (+ `--dense`, `--meta`), `.eyebrow` (shared rule with `.card__eyebrow`/`.viz__title`), `.stack` (rhythm), `--tbl-wrap-max`.
3. `.stat__value` at `--fs-xl` is for metrics; Stage 1's file metadata (project, location, owner …) is prose, so `.stats--meta` sets it to `--fs-base` 500. `.empty__title` uses `--fs-lg` (spec: `--fs-base`) and `.empty__text` ≤ 56ch (spec ≤ 40ch): the dropzone line is the one sentence the page is about. `.field__unit` has no `min-width: 2.2rem` — in an inline bar there is nothing to align with and "X"/"Y" prefixes would float.
4. `.pill.s-*` keeps mixed case and `--fs-xs` (spec pill: uppercase `--fs-2xs`): the soil name is data and appears verbatim in the DOM-text goldens.
5. `.verdict` is flex, not the `auto 1fr auto` grid: half the banners have no tag, and a grid would leave the body in the `auto` column.
6. `.panel` itself is not redefined; `overflow:hidden` stays (`clip` would drop the scroll container the Bishop canvas shell may rely on) — a 2d decision.
7. Spin buttons on `.input[type=number]` are hidden — needed for the controller's 52 px inline widths; engineers type these values.
8. `project/cpts.js` was edited (class attributes of `CHART_AREA_HTML` only): it is the Stage 1 chart area that `selectCpt()` re-renders, so without it a CPT switch would fall back to the deleted `.cc`/`.ct` look.
9. The tuning card's `[data-chart-pending]` element is now a hidden child of its `.card` (was a sibling): position-independent for `charts.js`, and it lets `#tuningArea.stack` space the cards.
10. Legacy leftovers stay in `legacy.css` (`.load-demo-row`, `.chart-area`, `.class-layout`, `.preview-wrap`, `.section-tip`, `#layerColSvg`) — Stage-specific, outside rows 2b/2c, and the second (winning) copies of `.layerwarn*`/`.class-layout`/`.section-tip` are shared with the stratigraphy phase. The dead first copies (lines ≈ 273–303 / 1627) were left alone: not "replaced", just duplicated; a cleanup for the `legacy-leftovers.css` rename.

## 4. Verification

| Check | Command | Result |
|---|---|---|
| Layout + canvas screenshots | `PW_PORT=5499 npx playwright test --project=visual` | first run: exactly the 8 Stage 1–5 names × 4 variants failed (list in §1.4), **everything else 0 px** — Stage 6 × 12, both phases, docs × 2, rekennota screen + print media + **PDF page 1**; after `--update-snapshots`: **14/14** green, re-run **14/14** |
| Token integrity + contrast | `npm run verify:tokens` | OK — 191 `var()` usages defined, dark blocks identical, contrast table passes; built CSS: 6 unlayered rules, all report-route `:global` (unchanged) |
| Build | `npm run build` | OK |
| Type check | `npm run check` | 6 errors, 0 warnings — the pre-existing set (`vite.config.ts` node types, `wall-result-staleness.js`) |
| Node goldens | `npm run golden:check` | **1 619 / 1 619** identical, 0 mismatches |
| Behaviour | `PW_PORT=5499 npx playwright test --project=e2e` | 3/3 |
| Browser goldens | `GOLDEN_VISUAL=soft … golden.config` on port 5599 | **2/2** journeys pass — every `dom.txt` (innerText of `.panel.active` at Stage 1–5 steps, the report, the note) exact; the PNGs of the restyled steps report soft mismatches, as expected |
| Blur count | `getComputedStyle(el).backdropFilter !== 'none'` on each Stage 1–5 page | **2** (`header.app-header.glass-chrome`, `nav.stage-rail.glass-rail`) at 1500 px; **0** at 390 px (the ≤ 900 px rule) — components.css adds none |

## 5. Running the harness from an agent worktree (notes for the next PRs)

- `tests/e2e/golden.config.mjs` has **no** port override (5299 hard-coded, contrary to the brief); it was run through a scratchpad wrapper config that spreads it with `baseURL`/`webServer` on 5599 and absolute `testDir`/`snapshotDir`. Adding `GOLDEN_PORT` to that file is a one-liner for whoever owns it.
- `vite.config.ts` ignores `**/.claude/**` in its watcher so the *main* checkout's server does not reload on worktree builds — but a dev server whose root **is** a worktree under `.claude/` then never hot-reloads (the served `app.css` bundle went stale mid-review), and the symlinked `node_modules` resolves to a real path outside `server.fs.allow`. Both are fixed by a scratchpad config that extends the repo config (`fs.allow` + a watcher without that pattern) and is passed with `--config`; Playwright's `reuseExistingServer` picks that server up. Worth a `VITE_WORKTREE=1` switch in the repo config later.

## 6. Next (2d and later)

Widen `.tbl-wrap > .tbl` → `.tbl` and delete legacy `.tbl*` once Stage 6 tables are wrapped; move `.sec`, `.ctrl-row/.ctrl-lbl`, `.info`, `.mc2*`, `.pt*`, `.foot`, `.dz` (report gateway) and the `.btn.pri/.sm`/`.togbtn` aliases out with Stage 6 / the report toolbars (2d–2h); drop the duplicate `.layerwarn*`/`.class-layout`/`.section-tip` blocks with the `legacy-leftovers.css` rename.
