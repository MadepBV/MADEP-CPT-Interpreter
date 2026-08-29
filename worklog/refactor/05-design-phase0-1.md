# 05 — Design system, Phase 0 (visual baselines) + Phase 1 (token reskin)

_Worklog · refactor · 2026-08-29 · branch `v0.6.0`. Implements §5.2 Phase 0 and Phase 1 of
`worklog/refactor/02-design-system.md`. Nothing committed; `package.json` / `.gitignore` untouched
(script lines to add are listed in §6)._

**TL;DR.** The app now has 126 deterministic Playwright screenshot baselines (1500×950 + 390×844, light + dark,
every stage, all Stage 6 apps, both phases, the import dialog, docs, the rekennota on screen, in print media and
as a rasterised PDF page 1). On top of them the token reskin landed as CSS only: `tokens.css` + `base.css` +
`glass.css` in `@layer tokens, base, legacy, components, utilities`, `legacy.css` / `docs.css` / the retaining
`<style>` demoted to the `legacy` layer, a pre-paint `data-theme` script, and `scripts/verify_tokens.mjs`
(token coverage, dark-block parity, literal canvas tokens, WCAG table). Every layout baseline changed in
colour only; the `/report/retaining` print PDF page 1 is **0 px** different; `build`, `check` (6 pre-existing
errors), `verify:retaining` and `test:e2e` pass.

---

## 1. What was built

### Phase 0 — visual baselines (`tests/visual/`)

| File | Role |
|---|---|
| `tests/visual/helpers.mjs` | Determinism: `page.addInitScript` installs **mulberry32** over `Math.random` (the demo profile is random, `loadDemo()` at `legacy-controller.js:1823`), `page.clock.setFixedTime('2026-08-29T10:00+02:00')` (report time stamps), `emulateMedia({colorScheme, reducedMotion:'reduce'})`, `document.fonts.ready`, pointer parked at (0,0) after clicks (Chromium re-evaluates `:hover` asynchronously after layout), `scrollTo(0,0)` before every full-page shot (sticky chrome lands at the *current* scroll offset in a full-page capture), `waitStable()` (polls `innerText` until result panels stop appending), a PDF rasteriser (`sips` on macOS, `pdftoppm` elsewhere) and a 60-row CSV that opens the import-review dialog. |
| `tests/visual/screenshot.css` | `canvas{visibility:hidden}` injected through `stylePath` for layout shots — the canvas box stays, the glass overlays floating over it (Bishop dock/card, retaining tools) stay visible; a `mask` would paint over them. |
| `tests/visual/app.spec.mjs` | One journey per variant: `/` empty → Stage 1 demo (+ canvas-only shot of `#cQc`) → Stage 2 → Stage 3 table → Stage 4 cards → Stage 5 → Stage 6 bearing / pile / settlement / dewatering / beam → Bishop with dock + "View" card open → retaining sheet pile (+ canvas-only shot) + all 8 result tabs → soldier pile drivability → Stratigrafie → Doorsnede → import-review dialog (last: cancelling runs `selectCpt()`, which resets the rail asynchronously). Asserts no `pageerror`. |
| `tests/visual/docs.spec.mjs` | `/docs`, `/docs/engineering`. |
| `tests/visual/report.spec.mjs` | `/report/retaining` from a frozen payload (`fixtures/retaining-note.json`, 191 KB, seeded journey, `generatedAt` = fixed clock) so the print gate isolates CSS from engine changes: screen, `emulateMedia({media:'print'})`, and `page.pdf({format:'A4'})` → page 1 rasterised → `toMatchSnapshot` at `maxDiffPixels: 0`. |
| `tests/visual/gen-retaining-note.mjs` | Regenerates the fixture from the seeded journey (`node tests/visual/gen-retaining-note.mjs` against a running dev server). |
| `tests/visual/__screenshots__/{app,docs,report}.spec.mjs/*.png` | 126 baselines (`{name}--{desktop|mobile}-{light|dark}.png`), 49 MB. |
| `playwright.config.mjs` | Projects `e2e` (`tests/e2e`, unchanged behaviour) and `visual` (`tests/visual`, `deviceScaleFactor: 1`, `animations: 'disabled'`, `caret: 'hide'`, `maxDiffPixels: 0`, `threshold: 0.01`, `snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}'`, 300 s per journey). `npx playwright test` still runs `tests/e2e` (now as project `e2e`) plus the visual project. |

Variants: 4 (desktop/mobile × light/dark); 108 app + 8 docs + 10 report snapshots; a full run takes ≈ 2.2 min
on 4 workers. Canvas-only shots use `maxDiffPixelRatio: 0.02`, `threshold: 0.2` (GPU anti-aliasing); every layout
shot is 0 px. Three consecutive runs on the untouched code were identical before Phase 1 started (see §4 for the
two sources of flakiness that had to be removed first).

### Phase 1 — token reskin, zero markup change

| File | Change |
|---|---|
| `src/lib/styles/tokens.css` (new, 276 lines) | §3.1 verbatim: brand palette, semantic, surfaces, liquid-glass tokens, geometry, elevation, type scale, spacing, z ladder, motion, data-viz + soil + region palettes; dark redefinition under **both** `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` and `:root[data-theme="dark"]` (the spec's "identical block — generated" placeholder is filled in; `verify_tokens` asserts parity); `@supports not (backdrop-filter)`, `prefers-reduced-transparency`, `[data-transparency="reduce"]`, `prefers-reduced-motion` overrides; the legacy alias block (`--tx`, `--bd`, `--panel-*`, `--ac`, `--app-*`, `--plot-*`, `--chart-*`, `--color-text-*`, …). Deviations in §3. |
| `src/lib/styles/base.css` (new) | `@layer base`: the eight `@font-face` rules moved out of `app.css`, `*{box-sizing}`, `html,body{background:var(--color-bg)}`, `body{color; font-family; 16px/1.78}` (the docs ground — unchanged values), `:focus-visible` 2 px accent ring (§4.4), `.skip-link` on tokens, `@media print` from §3.16 **without** `@page` (see §3). |
| `src/lib/styles/glass.css` (new) | §3.2 verbatim in `@layer components`: `.glass/.glass-float/--strong/--sm/--sheen`, `.glass-chrome(.is-scrolled)`, `.glass-rail`, `.glass-scrim`, `.glass-sheet`, `.control` washes, print fallback. Not yet applied to any element (phase 2a). |
| `src/lib/styles/theme.ts` (new) | §3.14: `token(name)` via a hidden probe `<span>` (resolves `color-mix()`/`var()` chains to `rgb()`), `vizTheme()`, `setTheme('light'|'dark'|'system')` (key `madep-theme`, `data-theme`, `madep:theme` event), `getTheme()`, `isDark()`, `onThemeChange()`; OS-preference changes re-emit the event; SSR-safe (probe created lazily). Not yet consumed by the canvases (phase 2b/2d/2f). |
| `src/app.css` | `@layer tokens, base, legacy, components, utilities;` declared first, then `@import` of `tokens.css`, `base.css`, `glass.css` (each file wraps itself in its own `@layer` block — see §3 for why the imports carry no `layer()`). |
| `src/lib/cpt-app/legacy.css` | Lines 1–182 (the old `:root` with three token vocabularies + the `prefers-color-scheme` block) deleted; the rest wrapped in `@layer legacy {}` (2 311 → 2 144 lines). The reset/body block (`*{margin:0}`, `body{14px/1.55}`, focus, skip-link) stays in this file — §3. |
| `src/lib/styles/docs.css` | The private `--color-*/--font-*/--radius-*/--shadow-*` copy on `.docs-page` (24 declarations) deleted; file wrapped in `@layer legacy {}` — docs now read the same tokens and the same dark block. |
| `src/lib/cpt-app/retaining/retaining-styles.js` | Injected `<style>` wrapped in `@layer legacy { … }` — the only non-CSS edit §5.1 asks for. |
| `src/app.html` | Two `theme-color` metas (`#F7F4EF` light / `#111110` dark) and the pre-paint script: `localStorage['madep-theme']` ∈ {light, dark} → `<html data-theme>` before first paint. |
| `vite.config.ts` | `server.watch.ignored: ['**/.claude/**', '**/test-results/**', '**/tests/visual/__screenshots__/**']` — see §4 (worktree builds were reloading every open page). |
| `scripts/verify_tokens.mjs` (new) | §5.2: (1) every `var(--…)` in `legacy.css`, `retaining-styles.js`, `docs.css`, `report/**/*.svelte`, `legacy-controller.js` is defined in `tokens.css` or locally in the same file (`--rpt-*`, `--st6-*`); informational sweep of the other 162 files under `src/lib`; (2) both dark blocks present and identical, the four preference blocks present; (3) every token read by JS (`readCssToken`/`getPropertyValue`: `--tx --tx2 --tx3 --bd --bg --wn --chart-* --canvas-text --canvas-text-halo` + `--viz-*`, `--canvas-*`) resolves through the alias chain to a literal colour — never `color-mix()`; (4) the §4.2 contrast table computed with the alpha-composite formula and asserted; (5) when a build exists, counts top-level rules outside `@layer` that are not Svelte-scoped. |

Not changed: any HTML string in `legacy-controller.js`, any Svelte markup, `+layout.svelte` (still imports
`app.css`), `CptInterpreterApp.svelte` (still imports `legacy.css` — deliberate, §3), `scripts/golden/**`,
`tests/golden/**`, `package.json`, `.gitignore`.

## 2. Before / after

Evidence copies (desktop, downscaled to 1000 px wide) in `worklog/refactor/05-screenshots/`; the full-resolution
"after" images are the live baselines under `tests/visual/__screenshots__/`.

| View | Before (phase 0) | After (phase 1) | What changed |
|---|---|---|---|
| App shell, empty | `phase0-before/home-empty--desktop-{light,dark}.png` | `phase1-after/home-empty--desktop-{light,dark}.png` | top bar `rgba(17,17,16,.94)` → 80 % dark glass chrome (`--app-panel-dark` → `--glass-bg-chrome`, blur 14 px was already on the rail); stage rail sand `rgba(237,233,225,.88)` → 66 % bone-white glass (`--nav-bg` → `--glass-bg`); muted text `#888890` → `#65656D` |
| Stage 3 layer table | `…/stage3-layers--desktop-*.png` | same names | all `th`/unit/help text AA muted; segmented control + inputs pick up `--surface-*`; row geometry identical (image height unchanged) |
| Stage 6 Bishop, dock + card | `…/stage6-bishop-dock-card--desktop-*.png` | same names | legends `--panel-strong` → `--glass-bg-strong`; the phase-0 copy was taken with the canvas *masked* (overlays hidden), the phase-1 baseline hides the canvas instead so the tool dock is in the baseline (the "View" card does not render on an empty geometry — 2d will pick a populated state) |
| Stage 6 retaining, sheet pile | `…/stage6-retwall-sheetpile--desktop-*.png` | same names | muted text, chrome, rail; `.st6-rw-*` px geometry untouched (`@layer legacy`) |
| Docs index | `…/docs-index--desktop-*.png` | same names | eyebrows/muted text AA, `--shadow-sm` gains the 1 px contact shadow (`--shadow-1`); dark docs unchanged except accent (`#3d6b6a` → `#6FA9A8`, the docs dark block never overrode it) |
| Rekennota `/report/retaining` | `…/report-retaining--desktop-*.png` | identical | **0 px** on screen, in print media and in the PDF page 1 (light and dark) — the route keeps its literal `--rpt-*` scale |

Diff ratios on the first Phase-1 run (before re-baselining), all colour-only: docs 0.01, app pages 0.03–0.61
(the Stage 3 table and Stage 1 metric grid are almost entirely muted text and quiet surfaces), report 0.00.
Image heights were identical for all 108 app snapshots after the geometry fix in §3.

## 3. Deviations from the spec and why

1. **`legacy.css` is not imported from `app.css`** (§5.1 lists it there). It carries unscoped selectors —
   `.btn`, `.panel`, `.info`, `.tbl`, `.nav`, `.wrap`, `.foot`, `button{border:0;background:none}`,
   `body{font-size:14px;line-height:1.55}`, `*{margin:0;padding:0}` — and the docs pages use `.btn.btn--primary`
   with docs.css's own `.docs-page .btn`. Loaded globally it would restyle the documentation (14 px body,
   `text-transform`/sheen on `.btn`, UA margins reset) — not colour-only, so it was not tried. It stays imported where it is today (`CptInterpreterApp.svelte` and the four
   `/report` routes), demoted by the `@layer legacy {}` wrapper *inside* the file, and repeats the layer-order
   statement at its top so the order is fixed even if a route stylesheet loads before `app.css`. Consequence for
   §5.2: the reset/body lines (`184–201`) are **kept in `legacy.css`** rather than moved to `base.css` — moving
   `body{14px}` and `*{margin:0}` into the global `base` layer would change the docs ground (16 px / 1.78, UA
   margins). `base.css` carries the global ground from the old `app.css` plus the new focus ring, skip link and
   print rules.
2. **Imports carry no `layer()`.** `tokens.css` and `glass.css` in §3.1/§3.2 already open with
   `@layer tokens {` / `@layer components {`; importing them with `@import … layer(tokens)` would nest a
   `tokens.tokens` sub-layer. Each file owns its `@layer` block; `app.css` declares the order and imports plainly.
3. **Geometry aliases keep today's values** (colour-only gate of §5.2): `--text-xs/sm/base/lg/xl` keep the fluid
   `clamp()` (the spec maps them to the fixed `--fs-*` scale, which at 1500 px shrinks `.sec-title`/`.dz-title`
   by 1–2 px and shifted every layout below by 4 px — measured on the first run); `--app-toolbar-h: 4.25rem`
   (spec: `var(--toolbar-h)` = 4 rem, which moves the sticky rail); `--section-px` keeps
   `clamp(1.25rem, 3.5vw, 3rem)` (used by `.wrap`, the rail and the report routes; the spec's
   `clamp(1rem, 3vw, 2.5rem)` is noted in the file for the 2a shell). `--fs-*`, `--toolbar-h`, `--rail-h` are
   defined as spec'd for phase-2 consumers.
4. **`--motion-base: var(--motion-base)`** in the spec's alias block is a self-reference (invalid at
   computed-value time → every `transition` using it would drop). Removed; `--motion-base` is defined once in §10.
5. **No global `@page`** in `base.css` print rules: `/report/retaining` has no `@page` of its own, so
   `@page{size:A4;margin:16mm 14mm 18mm}` would re-flow its PDF (the 0 px gate); `/report/stage7` declares its own.
   To be added together with a matching rule on the retaining route in 2h.
6. **Theme storage key** is `madep-theme` (§3.14 code) — §1.11 says `madep.theme`; the code block wins.
   `+layout.svelte`'s existing `<meta name="theme-color" content="#16181A">` is left as is (spec: layout unchanged);
   the two media-scoped metas in `app.html` precede it.
7. **`@media (prefers-color-scheme: dark)` for the docs** still goes through docs.css's hand-made dark block
   (lines ≈ 800–936); only the light-mode private copy was deleted. Removing the dark block is 2h.
8. **Screenshots hide canvases via `stylePath` instead of `mask`** (spec: `mask:[page.locator('canvas')]`). A mask
   paints over the Stage 6 glass overlays that sit on top of the canvas (Bishop dock/card, retaining canvas
   tools), which are exactly the surfaces phase 2d re-skins. `visibility:hidden` keeps the layout and the
   overlays; canvas-only baselines still exist separately with the tolerant thresholds.
9. **`vite.config.ts` gained `server.watch.ignored`** (not in the spec) — see §4.

## 4. Flakiness removed before the baselines were trusted

- **Hover after layout change.** Clicking "Load demo" leaves the pointer over whatever lands under it later;
  Chromium re-evaluates `:hover` on a timer → a "← Back" button was sometimes hovered. Fix: `mouse.move(0,0)`.
- **Sticky chrome in full-page captures.** `goS()` scrolls smoothly; a full-page screenshot renders `position:sticky`
  elements at the current scroll offset → header/rail sometimes captured 300 px down. Fix: `scrollTo(0,0)` (instant)
  before every shot.
- **`selectCpt()` after the import-review cancel** resets the stage rail asynchronously; anything after it raced.
  Fix: the dialog is the last step of the journey.
- **Result panels that keep appending** (retaining tabs, drivability) → 21 px height differences. Fix: `waitStable()`.
- **Dev-server reloads from another agent's worktree.** `.claude/worktrees/agent-*/build/*.html` (another agent's
  `vite build` inside the repo) is watched by the root dev server, which issued `page reload` for every HTML file —
  journeys reset to the empty state mid-run (`vite.log 16:49:26`). Fix: `server.watch.ignored` in `vite.config.ts`.

## 5. Verification

| Check | Command | Result |
|---|---|---|
| Layout screenshots (126, canvases hidden) | `npx playwright test --project=visual` | **14/14 pass, twice in a row** after re-baselining on Phase 1 (2.5 min per run); the Phase 0 baselines had passed three runs in a row on the untouched code |
| Canvas screenshots | same (`canvas-stage1-qc`, `canvas-retwall-sheetpile`, 4 variants each) | pass at `maxDiffPixelRatio 0.02` |
| Print PDF page 1 | `--grep "print pdf"` | **0 px** vs the Phase 0 raster, light and dark |
| Token integrity + contrast | `node scripts/verify_tokens.mjs` | OK — 201 `var()` usages in the gated set all defined, 162 other files swept with no gap, dark blocks identical (72 tokens), 14 JS-read tokens literal, contrast table below all pass |
| No unlayered app CSS | `verify_tokens` §5 after `npm run build` | 568 top-level unlayered rules → **6**, all Svelte `:global()` rules of the report routes (`body`, `.btn[disabled]`, `.report-print-chart`) |
| Existing behaviour | `npm run verify:retaining` | PASSED 24/24 (+ wasm / ui / behaviour / soil-profile / sections-plaxis / request scripts) |
| Browser tests | `npm run test:e2e` (= `playwright test`: projects `e2e` + `visual`) | **17/17 pass** (3 retaining-wall e2e + 14 visual, 2.5 min) |
| Type check | `npm run check` | 6 errors, 0 warnings — identical to the pre-change baseline (`vite.config.ts` node types, `deformation/wall-result-staleness.js`) |
| Build | `npm run build` | OK (adapter-static, `build/` written) |

Runtime sanity (Playwright script, dev server): `/` and `/report/*` body 14 px / 1.55, `/docs` 16 px / 1.78; layer
list on every route = `tokens, base, legacy, components, utilities`; `--tx3` → `#65656D`; `--chart-green` →
`#6F8F64`; `#nav` background = 66 % glass tint + `blur(14px)`; `#banner` = 80 % chrome; `localStorage.madep-theme =
'dark'` under a light OS → `--bg #111110`; `'light'` under a dark OS → `--bg #F7F4EF`.

### `verify:tokens` contrast table (light values unless noted)

| pair | fg | bg | ratio | min | ok |
|---|---|---|---|---|---|
| paper · ink | #18181A | #F7F4EF | 16.16 | 15 | yes |
| paper · ink-2 | #4A4A52 | #F7F4EF | 8.00 | 8 | yes |
| paper · ink-3 (muted, AA) | #65656D | #F7F4EF | 5.26 | 4.5 | yes |
| paper · accent-text | #2E5150 | #F7F4EF | 7.95 | 7 | yes |
| paper · accent (UI 3:1) | #3D6B6A | #F7F4EF | 5.45 | 3 | yes |
| paper · good | #2E6F55 | #F7F4EF | 5.44 | 4.5 | yes |
| paper · warn | #8A620D | #F7F4EF | 4.99 | 4.5 | yes |
| paper · bad | #9B3A32 | #F7F4EF | 6.29 | 4.5 | yes |
| paper · neutral | #6D6962 | #F7F4EF | 4.98 | 4.5 | yes |
| glass-bg (66 %) over soil-clay (#BAB5ED) · ink | #18181A | #E4E1F2 | 13.85 | 12 | yes |
| glass-bg (66 %) over soil-clay · ink-3 (borderline — rule (a): muted text only on --glass-bg-strong) | #65656D | #E4E1F2 | 4.51 | 4.5 | yes |
| glass-bg-strong (86 %) over soil-clay (#F1EFF4) · ink-3 | #65656D | #F1EFF4 | 5.05 | 4.5 | yes |
| chrome (80 %) over cream (#40403E) · on-dark | #EDE9E1 | #40403E | 8.61 | 4.5 | yes |
| chrome over cream · on-dark-2 (72 %) | #BDBAB3 | #40403E | 5.36 | 4.5 | yes |
| chrome scrolled (#2D2C2B) · on-dark | #EDE9E1 | #2D2C2B | 11.50 | 10 | yes |
| dark paper · ink | #EDE9E1 | #111110 | 15.60 | 15 | yes |
| dark paper · ink-2 | #BCB6AC | #111110 | 9.38 | 9 | yes |
| dark paper · ink-3 | #9A948A | #111110 | 6.28 | 6 | yes |
| dark paper · accent | #6FA9A8 | #111110 | 7.12 | 7 | yes |
| dark paper · good | #6FA585 | #111110 | 6.65 | 4.5 | yes |
| dark paper · warn | #C99961 | #111110 | 7.39 | 4.5 | yes |
| dark paper · bad | #D2776E | #111110 | 5.94 | 4.5 | yes |
| dark canvas (#181816) · --viz-1 | #86C0BF | #181816 | 8.73 | 4.5 | yes |
| dark canvas (#181816) · --viz-2 | #EDE9E1 | #181816 | 14.68 | 4.5 | yes |
| dark canvas (#181816) · --viz-3 | #C99961 | #181816 | 6.95 | 4.5 | yes |
| dark canvas (#181816) · --viz-4 | #D2776E | #181816 | 5.59 | 4.5 | yes |
| dark canvas (#181816) · --viz-5 | #7FAAD0 | #181816 | 7.25 | 4.5 | yes |
| dark canvas (#181816) · --viz-6 | #9CBF8E | #181816 | 8.68 | 4.5 | yes |
| dark canvas · viz-text-muted | #BCB6AC | #181816 | 8.83 | 4.5 | yes |
| canvas (#FBF9F5) · --viz-1 (graphic 3:1) | #3D6B6A | #FBF9F5 | 5.69 | 3 | yes |
| canvas (#FBF9F5) · --viz-2 (graphic 3:1) | #18181A | #FBF9F5 | 16.86 | 3 | yes |
| canvas (#FBF9F5) · --viz-3 (graphic 3:1) | #8A620D | #FBF9F5 | 5.21 | 3 | yes |
| canvas (#FBF9F5) · --viz-4 (graphic 3:1) | #9B3A32 | #FBF9F5 | 6.56 | 3 | yes |
| canvas (#FBF9F5) · --viz-5 (graphic 3:1) | #3C6F97 | #FBF9F5 | 5.10 | 3 | yes |
| canvas (#FBF9F5) · --viz-6 (graphic 3:1) | #6F8F64 | #FBF9F5 | 3.45 | 3 | yes |
| canvas (#FBF9F5) · --viz-neutral (graphic 3:1) | #6D6962 | #FBF9F5 | 5.19 | 3 | yes |

## 6. npm scripts to add (package.json is owned by another agent)

```json
"verify:tokens": "node scripts/verify_tokens.mjs",
"test:visual": "playwright test --project=visual",
"test:visual:update": "playwright test --project=visual --update-snapshots"
```

`.gitignore` already ignores `test-results/` and `playwright-report/`; its `screenshots/` pattern does not match
`__screenshots__`, so the baselines under `tests/visual/__screenshots__/` are tracked — they **must be committed**
with the phase.

## 7. Next steps — Phase 2a (shell)

1. `components.css` (layer `components`): `.btn` + variants (§3.8), `.segmented`/`.segmented__btn` (§3.7),
   `.pill` (§3.9), `.stage-rail/.stage/.stage__num/.stage__label` (§3.4), `.app-header` grid (§3.3); import it from
   `app.css` after `glass.css`.
2. Markup (first HTML edits): `BannerPhaseShell.svelte` — `header.app-header` gains `glass-chrome`, the inset
   floating variant ≥ 1100 px (`margin: var(--sp-2) var(--section-px) 0; border-radius: var(--radius-md)`), an
   IntersectionObserver sentinel toggling `.is-scrolled`; `.cpt-tab` → `.control`, status chip → `.pill`; the logo
   swaps to a cream SVG variant (delete the 5-step `filter:` chain, `legacy.css` ≈ line 60). `StageNav.svelte` —
   `nav.stage-rail.glass-rail` with **7** items (`Stage 7 Report` opens `/report/stage7`), `aria-current="step"`,
   `.is-done`, `aria-disabled` instead of `pointer-events:none`, the 2 px progress hairline. Controller: `goS()` /
   `updateNav()` (`legacy-controller.js` ≈ 1047) toggle the new class names.
3. Switch the geometry tokens deferred in §3.3 above: `--app-toolbar-h → var(--toolbar-h)` (4 rem; the Bishop view-menu
   `max-height` calc at legacy.css ≈ 1267/1720 reads it), `--section-px → clamp(1rem, 3vw, 2.5rem)`; then delete the
   legacy `.app-header/.cpt-tabs/.nav/.si/.sn/.togbtn/.btn` rules.
4. Theme toggle in the ⚙ menu wired to `setTheme()`; add `:root[data-theme="light"]{color-scheme:light}` /
   `:root[data-theme="dark"]{color-scheme:dark}` to `tokens.css` so form controls follow an explicit choice.
5. Gates: re-baseline only `home-empty`, `stage*` (shell region), keep the print PDF at 0 px; add the blur-count check
   (`≤ 5` elements with `backdrop-filter`) to `verify_tokens` or a new Playwright assertion.
