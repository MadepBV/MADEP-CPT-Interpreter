# 25 — PR 16 `style(dialogs, feedback)`: `<dialog>` import review, toast queue, tooltip helper

_Worklog · refactor · 2026-08-30 · worktree branch off `integration-r` (f5b4a9b). Implements row **2g** of
`02-design-system.md` §5.2 on top of the shell PR (f30d251), Stage 1–5 (8501cc1), Stage 6 (report 20) and
retaining (report 23)._

**TL;DR.** The app's three feedback surfaces get their design-system implementation. The import-review modal is a
native `<dialog>` in the top layer — `showModal()` supplies the focus trap, Escape and the inert page, `::backdrop`
carries the **one** blur of the composition (§4.1 rule 8) and the sheet adds none — with the backdrop click, the
focus restore and the DOM removal in a small shared `dialog.js` that also exposes `confirmDialog()`, the
`<dialog>`-based replacement for `window.confirm`. `src/lib/styles/toast.ts` is a new queue (≤ 3 visible, the rest
in order, a repeat coalesced into one card with a `×n` counter, errors persist, hover/focus holds the clock,
`aria-live="polite"` region + `role="status"`/`role="alert"` per card, safe to call before the DOM exists), and
**nine** `alert()` call sites now use it. `.tip` / `.st6-tip` becomes a components.css recipe and 103 lines leave
`legacy.css`. Every id, `data-*`, handler name and visible string is unchanged: `golden:check` **2 086 / 2 086**
bit-identical, the five browser journeys' `dom.txt` / `state.json` / `dialogs.json` **exact** (the
`gef-import-journey` drives this dialog four times), the 4 import-review baselines were reviewed and re-baselined,
4 new toast baselines added, and **everything else — Stages 1–6 × 4, both phases, docs × 2, `/report/retaining` on
screen, in print media and its PDF page 1 — is 0 px**. Blur count with the dialog open: **2 elements**
(`header.app-header.glass-chrome`, `nav.stage-rail.glass-rail`) **+ the `::backdrop` pseudo = 3**; the sheet's
computed `backdrop-filter` is `none`.

---

## 1. What changed

### 1.1 `src/lib/styles/toast.ts` — new, 217 lines

| Behaviour | How |
|---|---|
| `toast(message, { tone: 'info' \| 'ok' \| 'warn' \| 'bad', timeout })` | one export, returns nothing, never throws |
| tone defaults | `info`/`ok` 6 s, `warn` 8 s, **`bad` persists** (§3.15 "errors persist"); any `timeout` overrides, `0` = keep |
| queue | ≤ `MAX_VISIBLE` (3) on screen; the rest wait in FIFO order and appear as cards leave |
| repeats | an identical `(tone, message)` still on screen bumps `count` and shows a `×n` chip instead of a second card, and re-arms the timer — §3.15's "import errors accumulate into one toast with a count" |
| dismissal | a `.toast__close` button per card (`data-toast-close`), auto-timeout, and `toastClear()` |
| clock | `pointerenter` / `focusin` clear the timer, `pointerleave` / `focusout` re-arm it: reading a message never races it away |
| a11y | region `aria-live="polite" aria-atomic="false" aria-label="Meldingen"`, card `role="alert"` for `bad` else `role="status"`, close button `aria-label`; a **real space text node** between the mono tag, the text and the counter so the live region announces `LET OP Laad eerst een GEF bestand. ×2`, not `LET OPLaad…` (a CSS margin is not a word boundary) |
| before the DOM | `hasDom()` guards every path; calls with no `document`/`<body>` are buffered (≤ 20) and flushed by the first call that finds a DOM — nothing is lost or thrown during SSR or module-scope evaluation |
| Node hygiene | every timer is `unref()`ed when the runtime offers it, so a pending toast cannot hold the golden tier's Node process open |
| motion | enter/leave are CSS animations on `--motion-*`, which tokens.css already zeroes under `prefers-reduced-motion`; the removal falls back to a 400 ms timer when `animationend` never fires (reduced motion, `animations: disabled`) |

Tone words are `info` / `ok` / `let op` / `fout` — status is never colour-only (§4.2 rule b).

### 1.2 `src/lib/cpt-app/import-review/dialog.js` — new, 148 lines

`openModal(dialog, onClose) → close(result)` is the seam: it remembers `document.activeElement`, calls
`showModal()` (falling back to an `open` attribute **plus a hand-rolled Tab trap and Escape handler** where
`<dialog>` is not implemented — the Node golden harness stubs elements as plain objects), takes over the `cancel`
event so Escape runs the one close path, closes on a `mousedown` whose target is the dialog element itself (the
backdrop), removes the element and restores focus to the opener.

`confirmDialog({ title, body, confirmLabel, cancelLabel, tone })` builds a `.modal.modal--ask.glass-sheet` inside a
`dialog.modal-host`, wires `aria-labelledby` to the title, focuses **cancel** when `tone === 'danger'` (the safe
answer under the return key) and resolves `true` / `false`. With no DOM it resolves `false` rather than throwing.

It lives in `import-review/` because that is the app's first modal and the two share the plumbing; `index.js`
re-exports `confirmDialog` and `openModal`. A later PR that gives the app a `src/lib/ui/` should move it there.

### 1.3 `src/lib/cpt-app/import-review/modal.js` — `<div>` overlay → `<dialog>`

- `document.createElement('dialog')`, `className` **exactly** `'import-review-overlay'` (see §3.1), same
  `role` / `aria-modal` / `aria-label`, still appended to `document.body`, still rendered synchronously right
  after; `close` now comes from `openModal(overlay, resolve)` and the module's own `document`-level `keydown`
  listener and `mousedown` handler are gone.
- The template keeps every tag, every nesting level and every source line break — `htmlToText` (Node goldens)
  turns each closing `div`/`tr`/`option` into a line and each closing `td` into a tab, and the browser goldens
  read `innerText`, so the block structure is load-bearing. What changed is classes and two attributes:

| Legacy → component | Note |
|---|---|
| `.import-review` → `.import-review.modal.glass-sheet` | `.modal` is the second component scope (§1.4) |
| `.ir-head` / `.ir-title` / `.ir-file` → `.modal__head` / `h2.modal__title` / `.modal__meta` | `<div>` → `<h2>`: both close to a newline in `htmlToText`, both are blocks for `innerText` |
| `.ir-section` → `.modal__section`, all four wrapped in one `.modal__body` | the scroll area of the `auto / 1fr / auto` sheet grid |
| `.ir-sec-title` → `.eyebrow` | §8 |
| `.ir-table` → `.tbl-wrap > table.tbl`; `.ir-ch` → `td.modal__ch`; `.ir-samples` → `td.modal__samples`; the bare `<select>` → `.input.input--sm` | §12 / §9 / §20 |
| `.ir-hint` → `.field__hint` | §9 |
| `.ir-stats` / `.ir-stat` / its `<span>` / `<strong>` → `.stats.stats--dense.stats--meta` / `.stat` / `span.stat__label` / `strong.stat__value` | §8. The label stays a **`<span>`** (a `<div>` would split the Node golden's `metingen360` line) and `.stat__label` gains `display: block` so the browser's `innerText` keeps `METINGEN` / `360` on two lines |
| `.ir-note` + its inline `style="color:…"` → `.verdict` + `--good` / `--warn` / `--bad` / `--inline.--neutral` (`NOTE_COLORS` → `NOTE_VERDICT`) | §13, no `__tag`: the notes are sentences the goldens read |
| `.ir-meta` / `.ir-src` → `.modal__meta-table` / `.modal__src` | a §25 recipe, not `.tbl--kv`: the values are prose, not right-aligned numbers |
| `.ir-foot` → `.modal__foot`; `.btn.sm` ✕ → `.btn.btn--sm.btn--icon`; `.btn` / `.btn.pri` → `.btn` / `.btn.btn--primary` | §3 |

Added, never removed: `type="button"` on the three buttons. Untouched: every id, `data-ir` / `data-col`, the
`change` / `click` bindings, `headerOptions()`, `channelRows()`, `qualityNotes()`, every visible string and its casing.

### 1.4 `src/lib/styles/components.css` — a second scope, then §25–§27 (1 277 → 1 541 lines)

**The scope.** A `<dialog>` renders in the top layer as a child of `<body>`, outside `<main class="cpt-app">`, so
none of the `:where(.cpt-app) …` component rules reach it. The six families the sheet reuses — §3 buttons, §8
stats + eyebrow, §9 fields/inputs, §12 tables, §13 verdicts, §20 `select.input` — now read
`:where(.cpt-app, .modal)`. `:where()` is zero-specificity and `.modal` exists on nothing but a dialog sheet, so
this is 100 mechanically identical lines and no rule outside a dialog changes. (Adding `cpt-app` to the sheet
instead was rejected: `legacy.css` gives `.cpt-app` `min-height:100dvh`, a graph-paper background and a
`letter-spacing:0!important` sweep.)

| § | Classes | Spec |
|---|---|---|
| 25 | `dialog.modal-host` / `dialog.import-review-overlay` (+`[open]`, `::backdrop`), `.modal` (+`--ask`), `.modal__head/__title/__meta/__body/__section/__foot`, `.modal__meta-table`, `.modal__src`, `.modal__ch`, `.modal__samples`, `.modal__ask-body`; ≤ 760 px, reduced transparency, reduced motion, forced colours, print | §3.15 modal, §4.1 rule 8 |
| 26 | `.toast-region`, `.toast` (+ four tones), `.toast__dot/__body/__tag/__text/__count/__close`; ≤ 760 px, reduced motion, forced colours | §3.15 toast |
| 27 | `.tip`, `.st6-tip` (alias), `::before` hit area, `::after` bubble, `.tip--on-dark`; ≤ 760 px, forced colours | §3.15 tooltip, §4.4 |

The sheet is `width: min(45rem, 100%)` / `max-height: min(84vh, 860px)` on a `auto minmax(0,1fr) auto` grid,
enters with `translateY(10px) scale(.985)` over `--motion-base --ease-luxury` and the scrim fades over
`--motion-quick`, exactly as §3.15 asks.

### 1.5 `alert()` / `confirm()` — nine converted, thirteen listed

Converted to `toast()`:

| Site | Message | Tone |
|---|---|---|
| `legacy-controller.js` `importCptFiles` ctx | the ctx key `alert` is renamed **`notify`** and bound to `toast(…, {tone:'bad'})`; it feeds `load/import-files.js`'s two call sites (`Error importing …`, `Error reading …`) — the loader is already moving to the next file, so a modal would stack in front of the queue | bad |
| `legacy-controller.js` `applyParsedCptTo` | `NO_DATA_ROWS_MESSAGE` | warn |
| `legacy-controller.js` `loadSingleGEF` | `Error importing <file>: …` | bad |
| `legacy-controller.js` `runClass` | `Laad eerst een GEF bestand.` | warn |
| `legacy-controller.js` `openStage7Report` | `The Stage 7 report payload could not be validated for saving.` | bad |
| `stratigraphy/index.js` `export('db4')` | `Het db4-bestand kon niet worden aangemaakt: …` | bad |
| `stratigraphy/index.js` `openSoilinReport` | `Het SOILIN-rapport kon niet worden opgeslagen voor weergave.` | bad |
| `retaining/retaining-ui.js` `retwallOpenNote` | `Calculation note could not be generated: …` | bad |
| `project-io/index.js` `saveProject` | `Project kon niet worden opgeslagen: …` | bad |

Converted to `confirmDialog()`: **`stratigraphy/view.js` `confirmRerun`** (both call sites — the `run` action and
the `minMatch` setting). It keeps the synchronous fast path: with no manual edits nothing is asked and
`store.run(); render(); onChanged()` still happen in the same task, exactly as before; only the case that used to
block on `window.confirm` is deferred to the promise. Declining still re-renders without `onChanged()`.

**Kept blocking, and why** — every one of these has its text locked by a golden, so converting it means
re-recording a golden this PR is not allowed to touch, or it genuinely gates a flow:

| Site | Message | Locked by |
|---|---|---|
| `legacy-controller.js:706` `importParsedCpt` | `parsed.error` | `scripts/verify_load.mjs:402` asserts `c.alerts === ['Could not find depth/qc columns in the CSV file.']` |
| `legacy-controller.js` `exportCSV`, `exportPlaxisCommands` | `NO_LAYERS_MESSAGE` ×2 | `tests/golden/node/exports/no-layers.alerts.json` |
| `legacy-controller.js` `exportPlaxisCpt` | `NO_LAYER_MODEL_MESSAGE` | same file |
| `legacy-controller.js` `exportPlaxisCpt` | `NO_SIMULATED_ROWS_MESSAGE` | not locked, but it is the second guard of the same function — splitting the modality inside one function would be worse than leaving both |
| `legacy-controller.js` `exportPlaxisCommands` | `plaxisNuDrainageAlertMessage(…)` | **genuinely gates**: the download runs *after* the acknowledgement, so it must stay blocking regardless. Also `exports/*.plaxis-alerts.json` and the `demo` / `gef-import` `11-dialogs.json` |
| `legacy-controller.js` `buildStage7Payload` | `STAGE7_GUARD_MESSAGE` | `tests/golden/node/report/no-layers.json` |
| `project-io/index.js` `loadProjectFromFile` | the two invalid-file alerts | `tests/golden/node/project-io/invalid-files.json` + `save-load-journey/04-dialogs.json` |
| `project-io/index.js` `loadProjectFromFile` | `window.confirm('Project "…" laden? …')` | `save-load-journey/04-dialogs.json` |
| `project/cpts.js` `removeCpt` | `confirm('CPT "…" verwijderen?')` | `scripts/verify_project_section_tuning.mjs` calls `api.removeCpt(1)` **synchronously** and snapshots the banner on the next line; a promise-based confirm would move the removal a microtask later and break the Node goldens |
| `legacy-controller.js:3224, :3231` `stage6BishopImportDxf` | `<file>: <message>`, `Error reading <file>` | **skipped, not locked**: the Bishop / seep-slope regions of the controller belong to a parallel PR (18a–18c) |

Nothing was dropped: every message still reaches the engineer, thirteen of them still through `window.alert` /
`window.confirm`. The first eight convert in one commit together with a golden re-record; the last two convert
with whichever PR owns the Bishop region next.

### 1.6 `src/lib/cpt-app/legacy.css` — 103 lines deleted (1 887 → 1 784)

Fully replaced, no other consumer (census over `src`, `scripts`, `tests`): the whole
`/* ── Import review dialog ── */` block (`.import-review-overlay`, `.import-review`, `.ir-head/-title/-file/
-section/-sec-title/-table/-ch/-samples/-hint/-stats/-stat/-note/-meta/-src/-foot`, 36 lines), **both**
`.st6-tip` blocks — the dead first copy at ~283 and the winning copy at ~1611 including its `content:none`
override pair — and the ≤ 760 px `.st6-tip::after` / `::before` placement, which moves to §27. `grep -rn "ir-\|
import-review-overlay" src scripts tests` now returns only the modal, the golden harness hook, the journeys and
the visual spec.

### 1.7 Harness

- `tests/visual/app.spec.mjs`: **one step added** right after `home-empty` — `window.runClass()` twice on the
  empty project (the app's own guard message) → `shotPage(page, 'toast', v)` → click `[data-toast-close]` → wait
  for detach. Two calls prove the coalescing: one card with `×2`.
- 8 baselines under `tests/visual/__screenshots__/app.spec.mjs/`: `import-review` × 4 rewritten, `toast` × 4 new.
  Nothing else was written.
- No `scripts/**` change: `verify_import_review.mjs` covers `tabular.js` (the pure core), which is untouched.

## 2. Before / after

`worklog/refactor/25-screenshots/{before,after}/…` — desktop downscaled to 1 000 px, mobile at its native 390 px;
the full-resolution "after" images are the live baselines.

| Shot | What the eye sees |
|---|---|
| `import-review--{desktop,mobile}-{light,dark}` | The scrim is a real blur behind the sheet instead of a 2 px wash on a `z-index: 400` div. The sheet is a `.glass-sheet` with a hairline-separated head (16 px DM Sans title over a mono `file · format · testid` line, an icon close button), a scrolling body and a hairline-topped foot whose actions sit right. Inside: mono `.eyebrow` section titles, the recognised-columns table in a bordered `.tbl-wrap` with a sticky mono head and a chevroned `.input--sm` select, the reading statistics as four `.stat` tiles, the data-quality note as a green `.verdict--good` banner, the file metadata as mono uppercase keys against prose values. Mobile: `--sp-3` padding, full width, foot buttons stretching. |
| `toast--{desktop,mobile}-{light,dark}` (new) | Bottom-right card: amber dot, mono `LET OP`, the message, a `×2` chip, a ✕. Opaque in both themes. On mobile it spans the width between the `--sp-3` margins. |
| `confirm-dialog--desktop-{light,dark}` (new, report only) | `confirmDialog` in its `danger` tone: title, body, `ANNULEER` focused with the teal two-tone ring, a red `DOORGAAN`. |

There is no "before" for the toast or the confirm dialog: the before is `window.alert` / `window.confirm`, which
the browser paints outside the page and Playwright dismisses without rendering.

## 3. Deviations from the spec and why

1. **`className` on the import dialog is a single name.** `scripts/golden/lib/load-controller.mjs` recognises the
   overlay with `node.className === 'import-review-overlay'` (exact match) when it is appended to `document.body`,
   and auto-applies it so every Node import golden runs the real path. So the dialog cannot also carry
   `.modal-host`, and §25 lists both selectors side by side. The generic name is `.modal-host` for every future
   dialog; this one is grandfathered with a comment in both files.
2. **The sheet drops `backdrop-filter`.** `glass.css`'s `.glass-sheet` carries one; §4.1 rule 8 says the scrim
   carries the blur *once* and the sheet is 93 % opaque. `.modal.glass-sheet { backdrop-filter: none }` in §25
   (same layer, higher specificity) is that rule, verified in the browser: the sheet computes to `none` and the
   `::backdrop` to `blur(6px) saturate(1.05)`.
3. **The toast and the tooltip are opaque, not glass.** §3.15 gives both `.glass--strong` (86 %). Two reasons not
   to: (a) a toast can land over an animating canvas — a Bishop search, a retaining handle drag — which §4.1 names
   as the expensive case, and blur there costs a full re-rasterise per frame (the PR 15 precedent for the canvas
   chips); (b) without a blur underneath, 86 % — and even `--glass-fallback`'s 95 %, as the first baseline showed —
   lets page text ghost through a message that has to be read at a glance. Both take
   `background-color: var(--surface-page)` under `background-image: linear-gradient(var(--glass-fallback), …)`:
   the same material, fully opaque, tokens only, correct in both themes. Blur count stays at 2 + `::backdrop`.
4. **The tooltip's resting badge is reproduced verbatim** — `1rem`, `--radius-sm`, `0.62rem`/`700`,
   `--color-line-strong` on `--color-bg-alt` — rather than moved onto the type scale. `.st6-tip` is visible in the
   `stage2-classification` baseline and in every Stage 6 app (`core/format.js` `tooltip()`), all of which must stay
   0 px. Only the bubble, which exists only on hover / focus, is the new recipe: light in both themes (§3.15 drops
   the forced dark box), `--fs-xs`, ≤ 18 rem, `--glass-fallback`, 300 ms in / 0 out.
5. **The bubble is generated on hover / focus only** (`content: none` → `content: attr(data-tip)`), which is what
   legacy.css did and why: a permanently present, absolutely-positioned 18 rem box that is merely `visibility:
   hidden` still widens the scrollable overflow of the `.tbl-wrap`s and `.viz`es the badges sit in, which would
   put scrollbars into Stage 6 baselines. The 300 ms delay is therefore an `animation-delay` with `both` fill,
   not a `transition-delay`.
6. **The 24 px pointer target is a `::before` at `inset: -4px`** — no layout box changes, so the 16 px badge keeps
   its place in the line (§4.4 asks for exactly this: "keep visual 16 px but pad the hit area to 24"). Verified:
   the four Stage 6 app baselines and `stage2-classification` are 0 px.
7. **`.st6-tip` keeps its name.** `core/format.js` emits the span and `scripts/verify_core.mjs:52` asserts that
   exact string; the Stage 2 buttons are in `Stage2Classification.svelte`, outside this PR's file set. §27 styles
   `.tip, .st6-tip` together and `.tip` is what new markup should use.
8. **`:where(.cpt-app, .modal)` rather than a global rescope.** Only the six families the dialog actually uses were
   widened (100 lines); the other 307 `:where(.cpt-app)` selectors are untouched.
9. **The quality notes carry no `.verdict__tag`.** §3.11 banners have a mono tag word; adding one here would add
   text to `00-import-review.dom.txt` and to eight `*.review.txt` Node goldens. The tone is carried by the
   coloured left rule and the wording ("Geen gemeten fs/Rf in het bestand …"), which is already a sentence.
10. **Helper classes the spec does not name**, kept minimal and BEM-consistent: `.modal-host`, `.modal__meta`,
    `.modal__section`, `.modal__meta-table`, `.modal__src`, `.modal__ch`, `.modal__samples`, `.modal--ask`,
    `.modal__ask-body`, `.toast__dot/__body/__tag/__text/__count/__close`, `.tip--on-dark`.
11. **`ctx.alert` → `ctx.notify`** in the `importCptFiles` contract (`load/import-files.js` + its one caller):
    a key named `alert` bound to a toast reads as a bug. No verifier asserts that file's source.

## 4. Verification

| Check | Command | Result |
|---|---|---|
| Layout + canvas screenshots | `PW_PORT=5499 npx playwright test --project=visual` | first run: exactly `import-review` × 4 and the 4 new `toast` names — **everything else 0 px**: Stages 1–5 × 4, the five Stage 6 engineering apps, `stage6-bishop-dock-card`, the 11 retaining shots, both phases, docs × 2, `/report/retaining` on screen, in print media and its **PDF page 1**. After `--update-snapshots` (8 files): **14/14**, re-run **14/14** |
| Token integrity + contrast | `npm run verify:tokens` | OK — 173 `var()` usages defined, dark blocks identical, contrast table passes; built CSS: 6 unlayered rules, all report-route `:global` (unchanged) |
| Build | `npm run build` | OK |
| Type check | `npm run check` | **6 errors, 0 warnings** — the pre-existing set (`vite.config.ts` node types, `wall-result-staleness.js`); `toast.ts` is clean |
| Node goldens | `npm run golden:check` | **2 086 / 2 086** identical, 0 mismatches (run after the markup and again at the end) |
| Import-review core | `npm run verify:import-review` | all checks pass |
| Behaviour (browser) | `PW_PORT=5499 npx playwright test --project=e2e` | 3 passed, 5 skipped (as before) |
| Browser goldens | `GOLDEN_PORT=5599 GOLDEN_VISUAL=soft npx playwright test --config tests/e2e/golden.config.mjs` | **5/5** journeys — every `dom.txt`, `state.json`, `payload.json`, `dialogs.json` and download exact. `gef-import-journey` and `multi-cpt-journey` open this dialog and lock `00-import-review.dom.txt`; the PNGs soft-mismatch as they have since PR 10 |
| `verify:core` | `npm run verify:core` | see §5 |
| Blur count, dialog open | `getComputedStyle(el).backdropFilter !== 'none'` over `document.querySelectorAll('*')`, 1 500 px | **2** — `header.app-header.glass-chrome`, `nav.stage-rail.glass-rail` — plus the `::backdrop` pseudo (`blur(6px) saturate(1.05)`), which `querySelectorAll` cannot see: **3 blurred layers**, budget 5. `getComputedStyle(sheet).backdropFilter === 'none'` |
| Dialog contract | Playwright probe (not committed) | `<dialog>` · `:modal` true · `className === 'import-review-overlay'` · focus lands inside on `[data-ir="apply"]` · Escape removes it and restores focus to the opener · a backdrop click cancels · apply imports 20 rows |
| Toast contract | same probe | region `aria-live="polite"`, two identical calls → **one** card, `role="status"`, `backdropFilter: none`, the close button removes it |
| `confirmDialog` contract | same probe | `dialog.modal-host`, `:modal`, `aria-labelledby` wired, `danger` focuses cancel, resolves `false`, element removed |

## 5. `verify:core` — what fails and why

`npm run verify:core` exits 1 at `verify:seepslope-model` with **2 failures**, and they are **pre-existing**: the
same two fail on the untouched tree (a `verify:core` run before the first edit of this PR produced exactly
`1299 passed, 2 failed — draw layers changed underneath (signature) … the scenario no longer reproduces the
defect`). The commit that is now the tip of `integration-r` (`4974167`) is titled _"model verifier tolerates a base
that already carries the 18b fix"_, i.e. it is fixed upstream.

A second, purely environmental effect surfaced mid-run: **`integration-r` moved** from `f5b4a9b` (the ref this
worktree is built on, per the brief) to `4974167` while the PR was in flight. The five base-ref verifiers default
to `--base integration-r`, so they began materialising a controller that imports `./seepslope/run/index.js`, a
module that does not exist at `f5b4a9b`, and died with `ERR_LOAD_URL` before running a single check. Re-run against
the pinned base they all pass:

| Script | Result |
|---|---|
| `verify_window_handlers` · `verify_core` 18/18 · `verify_model_params` 188/188 · `verify_classification_layers` **260/260** · `verify_load` 45/45 · `verify_export_report` 57/57 | OK |
| `verify_bearing --base f5b4a9b` **519/519** · `verify_pile --base f5b4a9b` **586/586** · `verify_settlement_dewatering_beam --base f5b4a9b` **2 260/2 260** · `verify_stage6_shell --base f5b4a9b` **100/100** · `verify_seepslope_state --base f5b4a9b` **1 110/1 110** · `verify_project_section_tuning --base f5b4a9b` **208/208** | OK |
| `verify_seepslope_model --base f5b4a9b` | **1 299 passed, 2 failed** — the pre-existing pair above |
| `verify_nen6740` · `verify_stratigraphy` · `verify_import_review` · `verify_project_io` · `verify_scia_db4` · `verify_qc_only_handling` · `verify:retaining` (6/6, ui 50/50, request 24/24) · `verify:wasm` · `verify:bishop-phase-a` | OK |

Note for the rebase: `verify_load.mjs` asserts `assert.deepEqual(c.alerts, ['Could not find depth/qc columns in
the CSV file.'])`, which is why `importParsedCpt`'s `alert(parsed.error)` is one of the thirteen left alone.

## 6. Notes for the next PRs

- **The thirteen remaining `alert()` / `confirm()` sites are one commit away**, and it is a *golden* commit, not a
  UI one: convert them, then re-record `exports/no-layers.alerts.json`, `exports/*.plaxis-alerts.json`,
  `report/no-layers.json`, `project-io/invalid-files.json`, `save-load-journey/04-dialogs.json` and the two
  `11-dialogs.json`, and relax `verify_load.mjs:402` from `c.alerts` to whatever seam the toast exposes. The
  PLAXIS ν note should become a `confirmDialog` (it gates a download), and `removeCpt` needs its verifier call
  awaited before it can take one.
- **`dialog.js` wants to be `src/lib/ui/dialog.js`** once anything outside the import review uses it; the
  stratigraphy view already imports it across a package boundary.
- **`.st6-canvas-tool-btn`'s `data-tip` tooltip in legacy.css still carries its own `backdrop-filter: blur(12px)`**
  — the blur-in-blur §4.1 rule 1 names. It is the Bishop canvas dock, which a parallel PR owns and whose
  baselines must stay 0 px here, so it was left alone; it converts to `.tip` with the dock's own PR.
- **`toastClear()` exists for tests**; the visual suite dismisses through the close button instead, which is the
  more honest path.
- Running the harness from an agent worktree: reports 19 §5, 20 §6 and 23 §6 still apply. Three additions —
  (a) a base-ref verifier must be given `--base <sha>` when `integration-r` has moved past the worktree
  (`git log --oneline -1 integration-r` before blaming a diff); (b) report 20 §6's "do not edit `src/` while a
  visual run is in flight" is stronger than it reads: an edit during `--update-snapshots` re-baselined 16 Stage 6
  shots from a run whose dev server had died, and `git checkout -- tests/visual/__screenshots__` undoes that only
  for *tracked* files — always read the "is re-generated" list before trusting an update run; (c) **restart the
  dev server after `npm run build` or `npm run check`.** Both rewrite `.svelte-kit/` under a running `vite dev`,
  and a server that survives it can serve a module graph the app boots from but never finishes hydrating —
  `demo-journey` then dies on `waitForFunction` at step 1 with a fully rendered but empty Stage 1, twice in a row,
  which reads exactly like a regression. On a freshly started server the same tree is 5/5.
