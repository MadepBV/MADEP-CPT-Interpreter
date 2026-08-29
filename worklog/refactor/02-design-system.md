# 02 — Design system: liquid glass for the MADEP CPT Interpreter

_Worklog · refactor · 2026-08-29 · branch `v0.5.3`. Sources read: this repo (`legacy.css`, `docs.css`, `retaining-styles.js`, `app.css`, `+layout.svelte`, `app.html`, `components/cpt/*`, `report/*`, `docs/style.md`), `../gis/web/src/styles.css`, `../geon/{start,ios,site,cloud}`, `../BC-sizer/{design/design-system.md,src/app.css}`, `../madep-stability/src/lib/styles/tokens.css`, `../madep-structures/src/lib/styles/app.css`, `../madep-rebar/apps/web/src/app.css`, `../madep-website/{src/app.css,src/lib/components/Header.svelte,designlanguage3.md}`, `../rebar-website/app/globals.css`, `../rebar/apps/BarformTauri/src/styles/base.css`, plus grondspot / geotech / MADEP-DIGITAL-Website (outliers). No file other than this report was modified; no build or server was run._

**TL;DR.** MADEP already has a written brand system ("engineering notebook on warm paper": bone `#F7F4EF`, ink `#18181A`, one teal `#3D6B6A`, DM Sans / Manrope / JetBrains Mono, radii 3/6/10, `--ease-luxury`) and, in three apps, a *liquid-glass* layer on top of it. The most explicit spec is BC-sizer's `design/design-system.md` (glass as "earned depth" on chrome / hero cards / overlays only); the most complete implementation is gis `styles.css` (+ its descendant `madep-stability/tokens.css`). The CPT app is 80% on-brand at the token level but its 2 311-line `legacy.css` has grown three token vocabularies, 26 font sizes, two duplicated rule sets and one glass recipe locked inside the Stage 6 canvas overlay. The plan: a `tokens.css` + `glass.css` pair loaded in `@layer tokens, base, legacy, components`, aliasing every legacy variable so **phase 1 is a zero-markup reskin**, then replacing legacy classes per stage, then re-owning DOM in Svelte where it pays.

Contents: §1 inventory of the liquid-glass language across MADEP apps · §2 audit of the CPT app · §3 target design system (tokens + glass CSS + component specs) · §4 performance & accessibility · §5 migration plan with verification.

---

## 1. Inventory — the liquid-glass language across MADEP apps

### 1.1 Who implements what

| App | Path | Role | Glass? | Dark? |
|---|---|---|---|---|
| madep.be website | `madep-website/src/app.css`, `Header.svelte`, `designlanguage3.md` | **Brand rulebook** (typography, radius, motion, palette names `--color-*`) | header only | no (dark *sections*) |
| BC-sizer | `BC-sizer/design/design-system.md`, `src/app.css` | **Glass spec**: `--glass-*` tokens, 3 surface classes, fallbacks, print report | yes (spec'd) | no |
| geoterrain GIS | `gis/web/src/styles.css` | **Glass reference implementation** over a full-bleed map; `data-theme` light/dark | yes | yes |
| madep-stability | `madep-stability/src/lib/styles/tokens.css` | gis tokens re-based on madep.be hexes + WCAG-checked status tokens + spring motion + full fallbacks | yes | yes |
| madep-structures | `madep-structures/src/lib/styles/app.css` | website tokens verbatim + `--app-*` shell layer (what CPT's legacy.css was copied from) | HUD only | no |
| madep-rebar (Rebar Studio) | `madep-rebar/apps/web/src/app.css` | dark-first re-tokenisation (`--ink/--paper/--accent`), `.glass` islands | yes | dark only |
| geon cloud | `geon/cloud/src/lib/styles/tokens.css` | most *elaborate* glass (two materials, SVG refraction lens, rim/sheet/ring) — but palette drifted to cool grey `#eff0f4` / teal `#14706d` and system fonts | yes | yes |
| geon iOS | `geon/ios/RX2Field/Sources/FieldUI/Design/Tokens.swift`, `Glass.swift` | Apple Liquid Glass (`.glassEffect(.regular)`), system colours, springs | native | system |
| geon site | `geon/site/styles.css` | flat paper/ink/moss/orange, no blur — **not** glass | no | no |
| rebar-website, BarformTauri | `rebar-website/app/globals.css`, `rebar/apps/BarformTauri/src/styles/base.css` | same fonts/teal but own night palette; Tauri app is Apple-native (SF, `AccentColor`, blur 28px) | yes | yes |
| grondspot, geotech, MADEP-DIGITAL-Website | — | Next/Tailwind default, 2025 hacker-dark, 2025 Gelion/orange | no | — |
| madep-cp `docs/style.md` | `madep-cp/docs/style.md` | the HTML-app style guide the CPT app was built against (1 525 lines) | header pill | no |

### 1.2 Colour palette

**Brand (identical in website, structures, BC-sizer, cp, docs/style.md):**

| Token | Light | Notes / file |
|---|---|---|
| `--color-bg` | `#F7F4EF` | bone paper — `madep-website/src/app.css:43`; stability drifted to `#f7f5f0` (`tokens.css:68`) |
| `--color-bg-alt` | `#EDE9E1` | sand |
| `--color-bg-panel` | `#FBF9F5` | BC-sizer `app.css:10`; CPT `--canvas-bg` |
| `--color-bg-dark` / `-darker` | `#111110` / `#0C0C0B` | |
| `--color-primary` / `--color-text` | `#18181A` | ink |
| `--color-text-light` | `#4A4A52` | |
| `--color-text-muted` | **`#65656D`** (website `app.css:50`, BC-sizer, gis `--muted`) vs **`#888890`** (spec, structures, CPT) | **inconsistency — `#888890` fails AA (3.0:1); adopt `#65656D`** |
| `--color-text-on-dark` / `-muted` | `#EDE9E1` / `#8A8A82` | |
| `--color-accent` / `-hover` / `-text` | `#3D6B6A` / `#4F8584` / `#2E5150` | the single accent |
| `--color-accent-soft` / `-border` | `rgba(61,107,106,.10)` / `rgba(61,107,106,.34)` | border token only in BC-sizer `app.css:23` |
| `--color-border` / `-strong` | `rgba(24,24,26,.10)` / `.18` | hairlines |

**Dark palettes** (three variants exist):

| | gis / stability (`styles.css:31–53`, `tokens.css:190–240`) | CPT legacy.css:114–182 | madep-rebar `app.css:37–60` |
|---|---|---|---|
| bg / bg-2 | `#111110` / `#1b1b19` | `#111110` / `#181818` | `#0c0c0b` / `#111110` / `#171716` |
| text / muted | `#ede9e1` / `#8a8a82` | `#EDE9E1` / `#8A8478` | `#ede9e1` / `#8a8a82` |
| accent / hover | `#4f8584` / `#6ba3a2` | `#6FA9A8` / `#86C0BF` | `#4f8584` / `#63a3a1` |
| line | `rgba(237,233,225,.13)` | `.10` / `.20` | `.08` / `.16` |
| panel | `rgba(17,17,16,.96)` | `rgba(33,36,34,.62)` | `rgba(20,20,19,.68)` glass |

**Semantic / status** (four sets — the real inconsistency):

| Set | good | warn | bad | info | Where |
|---|---|---|---|---|---|
| madep.be app tokens | `#2E6F55` (+`rgba(46,111,85,.10)`) | `#8A620D` (+`.12`) | `#9B3A32` (+`.10`) | = accent | `docs/style.md` §App Tokens; structures; CPT; BC-sizer |
| stability (WCAG-checked "4.5:1 at 11px on white") | `#1f7d50` / dark `#4fbf8b` | `#a85e10` / `#e8a04f` | `#b4452f` / `#ef8a7e` | `#2f6396` / `#6ba3d8` | `tokens.css:80–84, 196–199` |
| geon cloud | `#1f7d50` / `#4fc98f` | `#a05a10` / `#e9a44f` | `#b23f2c` / `#f08a7c` | `#2f6396` / `#74a9dd` | `cloud/.../tokens.css` |
| gis | (none) | amber `rgba(245,158,11,…)` + `#fde68a` | `#8b0000` on `#fde8e8`; `--danger:#b4452f` unused | accent | `styles.css:385–407` |
| CPT dark | `#6FA585` | `#C99961` | `#D2776E` | — | `legacy.css:150–155` |

### 1.3 Glass surface recipes (quoted)

| Source | background | backdrop-filter | border / ring | inner highlight | shadow | radius |
|---|---|---|---|---|---|---|
| **BC-sizer `.glass-card`** (`app.css:171–188`) | `color-mix(in srgb, var(--glass-tint) 66%, transparent)`, tint = `color-mix(#f7f4ef 62%, #fff 38%)` | `blur(18px) saturate(1.22)` | `1px solid rgba(255,255,255,.45)` | `inset 0 1px 0 rgba(255,255,255,.55)`, `inset 0 -1px 0 rgba(24,24,26,.06)` | `0 10px 32px rgba(18,18,20,.10), 0 1px 4px …04` | 10px |
| **BC-sizer `.glass-chrome`** (dark bar, `:204–218`) | `color-mix(color-mix(#111110 78%, #18181a 22%) 68%, transparent)` | `blur(14px) saturate(1.1)` | `1px solid rgba(237,233,225,.10)` | `inset 0 1px 0 rgba(237,233,225,.06)` | `0 7px 20px rgba(0,0,0,.18)` | 6px |
| **gis `.glass`** (`styles.css:21–29, 203–210`) | `color-mix(in srgb, #fff 60%, transparent)` (dark `#16181a 66%`) | `blur(18px) saturate(1.25)` (dark 1.2) | `1px solid rgba(24,24,26,.12)` | ring `inset 0 0 0 1px color-mix(rgba(255,255,255,.6) 60%, var(--line))` | `0 22px 58px rgba(22,28,36,.16), 0 4px 14px …08` | 16 / 12 / 13 |
| gis header (`:69–79`) | `rgba(17,18,20,.62)` dark in both themes | `blur(16px) saturate(1.25)` | `inset 0 0 0 1px rgba(237,233,225,.12)` | — | `0 14px 34px rgba(0,0,0,.32)` | 14px |
| gis modal (`:466–487`) | sheet `color-mix(var(--bg) 93%, transparent)`; scrim `rgba(17,18,20,.42)` | scrim `blur(6px) saturate(1.05)` | as `.glass` | | | 16px |
| **madep.be header** (`Header.svelte`) | `linear-gradient(180deg, rgba(36,38,42,.64), rgba(22,23,26,.66))`; scrolled `.9/.92` | `blur(18px) saturate(1.4)` | `1px solid rgba(237,233,225,.12)` | `inset 0 1px 0 rgba(255,255,255,.06)` | `0 10px 30px rgba(12,12,11,.18)` | 16px |
| CPT DocsHeader / docs/style.md header | `rgba(17,17,16,.62)` | `blur(16px)` | `1px solid rgba(237,233,225,.10)` | — | `0 8px 24px rgba(17,17,16,.10)` | 6px |
| **CPT Stage 6 `.st6-canvas-shell`** (`legacy.css:~1010`) | `color-mix(var(--panel-solid) 58%, transparent)` | `blur(18px) saturate(1.22)` | — | ring `inset 0 0 0 1px color-mix(rgba(255,255,255,.42) 62%, var(--bd2))` | `0 22px 58px rgba(22,28,36,.16), 0 4px 14px …08` | 12px |
| stability `.glass` light / dark (`tokens.css:96–108, 205–214`) | `color-mix(#fff 72%, transparent)` / `color-mix(#1c1f23 58%, transparent)` | `blur(12px) saturate(1.1)` / `blur(26px) saturate(1.7)` | `rgba(20,20,12,.10)` | sheen gradient top `.22→0`, dark: hairline top + base insets | `0 1px 2px …04, 0 14px 34px …06` | 12 / 20 |
| madep-rebar `.glass` (`app.css:199–217`) | `rgba(20,20,19,.68)` | `blur(22px) saturate(1.15)` | `rgba(237,233,225,.09)` | `linear-gradient(180deg, rgba(255,255,255,.055), transparent 38%)` + `inset 0 1px 0 rgba(255,255,255,.04)` | `0 12px 40px rgba(0,0,0,.45)` | 10px |
| geon cloud `.glass` (`tokens.css:438–464`) | `rgba(255,255,255,.6)` + sheet gradient | `blur(20px) saturate(1.8)` (+ `url(#geom-lens)` for "clear") | ring `.34` | rim-top `.62`, rim-bottom `.16` | `0 1px 2px …05, 0 8px 20px …08` | 8–30 |
| structures HUD | `rgba(247,244,239,.84)` | `blur(10px)` | `rgba(24,24,26,.12)` | — | `--shadow-sm` | 6px |
| BarformTauri `.glass` | `rgba(245,248,252,.61)` + diagonal highlight | `blur(28px) saturate(165%)` | `rgba(255,255,255,.58)` | `inset 0 1px rgba(255,255,255,.36)` | `0 10px 30px rgba(20,35,55,.16)` | 14px |

Convergence: **blur 18px, saturate 1.2–1.25, warm tint 60–70% opaque, whiter-than-paper 1px rim, deep two-stop shadow (22/58 + 4/14)** appears in BC-sizer, gis, stability-dark and CPT's own Stage 6 shell. That is the canonical recipe (§3.2). Dark chrome converges on **blur 14–18, `rgba(17,17,16,.62–.68)`, cream 10–12% border, 1px `.06` inner highlight**.

Fallbacks: BC-sizer (`app.css:501–520`), stability, geon cloud (`tokens.css:504–528, 751–803` incl. `prefers-contrast: more` and `forced-colors`) and BarformTauri all ship `@supports not (backdrop-filter)` + `prefers-reduced-transparency`; **gis, structures, rebar and CPT ship none**.

### 1.4 Radii

| Source | Scale |
|---|---|
| madep.be / structures / rebar / BC-sizer / CPT tokens | **3 / 6 / 10** — "precise, no pills" (`madep-website/app.css:70`, `designlanguage3.md`) |
| BC-sizer glass | 10 (cards) / 6 (chrome) — "the ONE place 10px applies to UI" |
| gis | 3 … 16 (panels 16, popovers 12, inputs 9, buttons 10, pills 999) |
| stability | 12 panels, 13 buttons, 20 dark glass, 999 pills/clusters |
| geon cloud / iOS | 8/10/14/18/24/30 + pill · iOS 10/14/18/24 |
| CPT actual | 3/6/10 tokens + raw 4, 5, 7, 8, 9, 12, 999 |

**Inconsistency to settle:** brand says max 10 and no pills; gis/stability/geon (map apps) use 12–20 and pills. **Recommendation:** CPT is a document-like engineering app, not a map — follow the brand: 3 / 6 / 10, `999px` only on progress tracks, dots and the boolean switch.

### 1.5 Typography

| Source | Families | Scale | Weights | Mono usage |
|---|---|---|---|---|
| madep.be (`app.css:57–69`) | DM Sans (heading), Manrope (body), JetBrains Mono | `--text-xs clamp(.70rem,1vw,.76rem)` … `--text-display clamp(3.6rem,7vw,5.8rem)`; body 16/1.78 | 400/600 headings `-0.025em`, lh 1.06 | `.label`: mono `--text-xs` 400 `0.14em` uppercase accent-text |
| BC-sizer (`app.css:62–70`) | same, self-hosted; note "instrument-panel scale — type runs small" | `--text-xs clamp(.66rem,.85vw,.72rem)`, `-sm clamp(.76rem,1vw,.82rem)`, `-base clamp(.85rem,1.05vw,.92rem)` | 600 headings, 650 bold | buttons are mono `--text-xs` `0.12em`; `tabular-nums` on `.num` |
| gis (`index.html:92–98`, `styles.css:16–18`) | same via **Google Fonts** | px: 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 14 / 15 / 16 | 400/500/600/650/700 | pills, CRS chip, extents |
| stability | same via Google Fonts | nav mono `.7rem` `0.08em`; th mono `.6rem` `0.06em` | | |
| geon cloud | **system-ui** (CSP) | Apple ramp 11/12/13/15/17/20/25/32 + display; tracking `-0.028em … 0.005em` | 600/650/700 | numeric cells `tabular-nums` |
| CPT | same, self-hosted variable woff2 (`src/app.css`) — **best font setup of all apps** (latin/latin-ext/greek subsets, full weight axes) | 26 ad-hoc sizes; body 14px; `letter-spacing:0!important` | 500/600/650/700 | eyebrows, th, units, pills |

**Inconsistencies:** Google Fonts (gis, stability, structures) vs self-hosted (website, BC-sizer, rebar, CPT) — the brand says self-host (privacy). Tracking: site 0.12–0.16em, apps 0.04–0.10em, CPT 0. **Recommendation:** keep CPT's font files; adopt a fixed px-exact rem scale (§3.1 `--fs-*`), mono tracking `0.08em` in-app / `0.12em` for eyebrows; drop the global `letter-spacing:0!important`.

### 1.6 Spacing

- madep.be spec: `--space-1…32` = 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128 px (`designlanguage3.md` §4.1).
- gis/stability/geon: `--sp-1…8` = 4, 8, 12, 16, 20, 24, 32 px; chrome inset 14–16 px; iOS `xxs 2 … xxl 32`.
- BC-sizer: `--app-gap clamp(.65rem,2vw,1rem)`, `--section-px clamp(1.25rem,3.5vw,3rem)`, header 4.25rem.
- CPT: rem soup (0.25 … 1.3rem) + px in Stage 6/retaining (6, 7, 8, 9, 10, 11, 12, 14). → §3.1 `--sp-1…12` on a 4-pt grid.

### 1.7 Iconography

No icon library anywhere. All apps hand-inline **Feather/Lucide-style 24-viewBox stroked SVGs**, `fill="none" stroke="currentColor" stroke-linecap/linejoin="round"`, stroke-width **1.5–2** (gis gear 1.7, search 2, chevron 2.2; CPT tool icons 1.7, brand icons 1.5; BC-sizer spec 1.5). Sizes 14 / 16 / 18 (chips) / 24. Unicode glyphs (`▸ ▾ ✓ ◳ ⓘ`) are used as fallbacks in gis and CPT. Brand mark: cream wordmark/`M` on dark. **Recommendation:** one `icons.ts` sprite (24-viewBox, stroke 1.6, sizes 14/16/20), no unicode glyphs in chrome.

### 1.8 Motion

| Source | Durations | Easings | Idioms |
|---|---|---|---|
| madep.be (`app.css:88–104`) | micro 120 / quick 200 / base 320 / slow 600 / reveal 960 ms | `--ease-smooth (0,0,.2,1)`, `-snappy (.4,0,.2,1)`, `-reveal (.22,1,.36,1)`, `-luxury (.16,1,.3,1)` | hover lift −1/−2 px; diagonal sheen sweep `translateX(-120%→120%)` .6s luxury; teal underline `scaleX(0→1)`; scroll reveal 26 px / 960 ms |
| BC-sizer | + `--motion-count .9s` | same | result-reveal choreography; "no spinner-block"; `will-change` only during animation |
| gis / stability / geon | `--t-fast 130 / -med 220 / -slow 360 ms` | `--ease-spring (.22,1,.36,1)`, `--ease-emph (.16,1,.3,1)`, `--ease-out (.25,1,.5,1)` | `glass-rise`, `glass-pop`, `status-pulse`, `arrival-snap` keyframes; press `scale(.94–.97)` |
| geon iOS | spring `response .38 / damping .82`, snappy `.28 / .86`, fade `.22s` | | press `scale .96 + opacity .85` |
| CPT | website tokens; Stage 6 raw `.12s ease`, `.15s` | | sheen on all `.btn`; `-1px` lift on input focus (bad in tables) |

**Recommendation:** website names/durations (they are the brand), add gis's `--ease-reveal` = "spring" for panel rise; press feedback = `scale(.97)` on coarse pointers only; sheen only on primary/default buttons and hero glass.

### 1.9 Focus / hover / elevation / z-index

- Focus: madep.be/structures/CPT `outline: 2px solid rgba(61,107,106,.45); outline-offset: 3px`; rebar `rgba(79,133,132,.55)` offset 2; geon/stability two-tone ring `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)`; gis **none** (only `border-color` on inputs). → §4.4: solid 2px accent outline, 2px offset, plus the two-tone ring on glass.
- Hover: consistent `border-color → ink`, `background → rgba(24,24,26,.035)`, `translateY(-1px)`; cards `-2/-3px`. Gis/geon: `color → accent`.
- Elevation: paper `--shadow-sm/md/lg` (`0 2px 8px .05`, `0 6px 24px .07`, `0 12px 40px .09`) everywhere on-brand; glass gets its own deeper pair (BC-sizer `--glass-shadow-sm/lg`, gis `--glass-shadow`); geon adds `--card-rim` inset ring for dark ("dark elevation is carried by a rim light, not a shadow" — `tokens.css:4–31`). gis 4-level model: flat card → small glass control → floating glass → opaque popover.
- z-index: gis `1 th / 5 panel / 6 addr / 7 attribution / 20 header / 50 popover / 100 modal`; rebar `60 modal / 100 top bar+palette`; structures `9000 modal`; CPT `2 3 5 8 30 40 400 9999`. → §3.1 `--z-*` ladder.

### 1.10 Data-viz colours

- Brand plot tokens (`docs/style.md`, structures, CPT): `--plot-primary #3D6B6A`, `-secondary #18181A`, `-tertiary #8A620D`, `-danger #9B3A32`, `-grid rgba(24,24,26,.10)`, `-fill rgba(61,107,106,.10)`.
- structures load cases: Dead `#4A4A52`, Wind `#4477AA`, Snow `#88CCEE`, Accidental `#CC6677` (Paul Tol), materials steel `#a83a30` / timber `#8a5a2b` / concrete `#5a5a5a`, selection `#ff8b1f`.
- gis: everything reads `--accent` at render time; 3D elevation ramp teal→green→olive→tan→brown→white; contours accent 1.8/0.9 px.
- geon: map points by status token; lines `#3b82f6` (Tailwind leftover).
- CPT: chart-factories uses the brand set; Stage 6 leaks 40+ literal hexes (§2.5 G11); soil fills `#C0DD97 #B5D4F4 #AFA9EC #FAC775 #F4C0D1 #D3D1C7 #F0997B`; Bishop regions 8 muted earths.
- **Recommendation:** six-series brand ladder `--viz-1…6` (teal, ink, ochre, brick, slate-blue *for water only*, moss) with light/dark variants (§3.1), soil and region palettes promoted to tokens, canvases re-read on theme change.

### 1.11 Dark-mode mechanism

| Mechanism | Apps |
|---|---|
| `data-theme` on `<html>` + localStorage + `prefers-color-scheme` fallback + anti-FOUC inline script + `<meta theme-color>` swap | gis (`gt-theme`, default light, no system follow), stability (`madep.theme`, follows system until toggled), geon cloud (`geon.theme`), rebar-website (`barform-theme`) |
| `prefers-color-scheme` only | CPT (`legacy.css:114`), BarformTauri, grondspot |
| none / light only | website, structures, BC-sizer, docs/style.md (`color-scheme: light`) |
| dark only | madep-rebar |

**Recommendation:** stability's model — `:root` light, `@media (prefers-color-scheme: dark) :root:not([data-theme=light])`, `:root[data-theme=dark]`, key `madep.theme`, inline pre-paint script in `app.html`, `theme-color` `#F7F4EF` / `#111110`. Charts must subscribe (§3.14).

### 1.12 The canonical set (decision)

| Concern | Canonical source | Why |
|---|---|---|
| Palette names + values | `madep-website/src/app.css` `--color-*` (with `--color-text-muted:#65656D`) | brand of record; structures/CPT/BC-sizer already use the names |
| Dark palette | gis / stability values (`#111110`, `#ede9e1`, `#8a8a82`, accent `#4f8584→#6ba3a2`), **but** keep CPT's lighter accent `#6FA9A8` for AA on dark canvases | tested in two shipping dark apps |
| Semantic states | madep.be app tokens `#2E6F55 / #8A620D / #9B3A32` light; CPT dark `#6FA585 / #C99961 / #D2776E`; add `info = accent`, `neutral #6D6962` | already in CPT, engineers know "italic orange" |
| Glass recipe | BC-sizer `--glass-*` tokens + gis hairline ring + gis 93%-opaque modal sheet + gis "dark chrome in both themes" | most explicit spec + most battle-tested implementation, and CPT's own Stage 6 shell is already this |
| Fallbacks | BC-sizer + geon (`@supports`, `reduced-transparency`, `reduced-motion`, `prefers-contrast`) | |
| Radii | 3 / 6 / 10 | brand rule; CPT is not a map |
| Type | CPT's self-hosted fonts; BC-sizer "instrument-panel" small scale, px-exact | |
| Spacing | 4-pt `--sp-*` (gis/stability names) | |
| Motion | website tokens + `--ease-reveal` as spring | |
| Focus | 2px solid accent outline + two-tone ring on glass (stability/geon) | |
| Dark mode | stability mechanism | |
| Print | Stage 7 / BC-sizer "MADEP Engineering Report" rules (white paper, mono running head, text+colour verdicts) | already implemented in `/report/*` |

---

## 2. Audit of the current CPT app UI

### 2.1 Where the CSS lives (five sources, three token vocabularies)

| Source | Lines | Scope | Loaded by |
|---|---|---|---|
| `src/app.css` | 128 | `@font-face` (DM Sans / Manrope / JetBrains Mono, self-hosted variable woff2 under `static/fonts/`), `html/body` base (`background:#f7f4ef; color:#18181a; font-size:16px; line-height:1.78`) | `src/routes/+layout.svelte` (global) |
| `src/lib/cpt-app/legacy.css` | 2311 | The app: `:root` tokens, dark-scheme override, shell, stage rail, cards, tables, Stage 6 Bishop/pile/canvas overlays, import-review modal, responsive + reduced-motion | `CptInterpreterApp.svelte` (global, unscoped) |
| `src/lib/styles/docs.css` | 936 | Docs pages, all rules prefixed `.docs-page`; **redeclares** the brand tokens on `.docs-page` (lines 1–29) | `src/routes/docs/**/+page.svelte` |
| `src/lib/cpt-app/retaining/retaining-styles.js` | 115 | `RETWALL_STYLE` = a `<style>` string injected with the Stage 6 retaining-wall body; 100+ `.st6-rw-*` rules, all px-based | `retaining-ui.js` at render |
| Svelte `<style>` blocks | — | `CptInterpreterApp.svelte` (docs footer), `DocsHeader.svelte` (fixed dark glass bar), `report/+page.svelte`, `report/stage7/+page.svelte` (3041 lines, own `--rpt-*` ink scale), `report/retaining/+page.svelte`, `report/soilin/+page.svelte` | route-scoped |

Plus **548 inline `style="…"` attributes** in `legacy-controller.js` (18 503 lines) — the top three alone: `style="font-size:11px;color:var(--tx2)"` ×157, the 76× field recipe `style="margin-top:3px;font-size:12px;padding:5px 7px;border:1px solid var(--bd2);border-radius:6px;background:var(--bg);width:100%"`, and `style="background:var(--bg2);border-color:var(--bd2)"` ×21. Five Stage 6 sub-apps hard-code their three-column grid inline (`grid-template-columns:200px 1fr 200px`, `260px 1fr 250px`, `280px 1fr 260px` ×2, `300px 1fr 280px` at lines 3580, 13677, 13791, 13975, 14161) and legacy.css has to fight them with attribute selectors + `!important` (`.cpt-app [style*="grid-template-columns:280px 1fr 260px"]{grid-template-columns:minmax(0,1fr)!important}`, lines ~2170–2185).

### 2.2 What `legacy.css` defines — the token layers

`:root` (lines 1–112) stacks **three vocabularies** on top of each other:

1. **Brand tokens** (copied verbatim from `docs/style.md` / madep.be): `--color-primary:#18181A`, `--color-accent:#3D6B6A`, `--color-accent-hover:#4F8584`, `--color-accent-text:#2E5150`, `--color-accent-soft:rgba(61,107,106,0.10)`, `--color-bg:#F7F4EF`, `--color-bg-alt:#EDE9E1`, `--color-bg-dark:#111110`, `--color-bg-darker:#0C0C0B`, `--color-text:#18181A`, `--color-text-light:#4A4A52`, `--color-text-muted:#888890`, `--color-text-on-dark:#EDE9E1`, `--color-text-on-dark-muted:#8A8A82`, `--color-border:rgba(24,24,26,0.10)`, `--color-border-strong:rgba(24,24,26,0.18)`; fonts `--font-heading:'DM Sans'`, `--font-body:'Manrope'`, `--font-mono:'JetBrains Mono'`; fluid type `--text-xs … --text-xl` (clamp); `--container-max:1300px`, `--section-px:clamp(1.25rem,3.5vw,3rem)`; `--radius-sm:3px / -md:6px / -lg:10px`; `--shadow-sm:0 2px 8px rgba(18,18,20,0.05)`, `-md:0 6px 24px …0.07`, `-lg:0 12px 40px …0.09`; motion `--motion-base:0.32s`, `--motion-slow:0.60s`, `--transition-fast:0.12s ease`, `--transition-base:0.22s ease`, `--transition-slow:0.40s ease`, `--ease-smooth:cubic-bezier(0,0,0.2,1)`, `--ease-luxury:cubic-bezier(0.16,1,0.3,1)`.
2. **App tokens** (also from `docs/style.md` §App Tokens): `--app-panel:rgba(255,255,255,0.52)`, `--app-panel-muted:rgba(237,233,225,0.70)`, `--app-panel-dark:rgba(17,17,16,0.94)`, `--app-line`, `--app-hover:rgba(24,24,26,0.035)`, `--app-active`, `--app-good:#2E6F55` (+bg 0.10), `--app-warn:#8A620D` (+bg 0.12), `--app-danger:#9B3A32` (+bg 0.10), `--app-toolbar-h:4.25rem`, `--app-gap:1rem`, `--plot-primary/secondary/tertiary/danger/grid/fill`.
3. **Legacy short aliases** (lines 71–96) — the names the 18k-line controller actually uses: `--ac`, `--acl`, `--acb`, `--acd`, `--wn`, `--wnl`, `--ok`, `--ok-text`, `--ok-soft`, `--info*`, `--bad`, `--bad-text`, `--bad-soft`, `--neutral-text:#6D6962`, `--neutral-soft`, `--bg`, `--bg2`, `--bg3:#E6E0D6`, `--tx`, `--tx2`, `--tx3`, `--bd`, `--bd2`, `--panel`, `--panel-muted:rgba(247,244,239,0.48)`, `--panel-soft`, `--panel-solid:rgba(255,255,255,0.62)`, `--panel-strong:rgba(255,255,255,0.72)`, `--hover-soft`, `--chart-grid`, `--chart-grid-strong:rgba(24,24,26,0.16)`, `--chart-blue/purple/green/orange/red/neutral/blue-soft`, `--r`, `--r2`, `--sh`, `--input-bg:#fff`, `--input-bg-hover:#fafafa`, `--canvas-text:#213142`, `--canvas-text-halo`, `--chart-band-fill`, `--chart-tooltip-bg`, `--nav-bg:rgba(237,233,225,0.88)`, `--canvas-bg:#FBF9F5`, `--canvas-grid-line`, `--btn-pri-hover`.

Good news: the alias layer means **`legacy-controller.js` never references a brand token directly** — everything goes through `--tx/--bd/--panel-*/--ac/…`. That is the hinge for the phase-1 reskin (§5).

Dark scheme (lines 114–182): `@media (prefers-color-scheme: dark)` only — no `data-theme` attribute, no toggle, no `light-dark()`. Values: `--color-bg:#111110`, `--color-bg-alt:#181818`, `--color-text:#EDE9E1`, `--color-accent:#6FA9A8` (hover `#86C0BF`, text `#9FD3D2`), `--app-panel:rgba(33,36,34,0.62)`, `--panel-solid:rgba(33,36,34,0.85)`, `--app-good:#6FA585`, `--app-warn:#C99961`, `--app-danger:#D2776E`, `--canvas-bg:#181816`, `--input-bg:rgba(8,8,7,0.55)`, shadows `0 2px 8px rgba(0,0,0,0.32)` … `0 12px 40px rgba(0,0,0,0.48)`.

### 2.3 Layout skeleton (what the DOM looks like)

```
main.cpt-app  (grid rows: auto auto 1fr auto; graph-paper bg 2rem, rgba(24,24,26,0.026))
├─ #banner.app-header        sticky top:0  z:40  — DARK, opaque-ish (rgba(17,17,16,0.94)), NO blur
│   ├─ label.app-brand > img.app-brand-logo (filter-tinted) + input#projName (DM Sans 600)
│   ├─ .app-divider
│   ├─ .cpt-tabs-wrap > #cptTabs.cpt-tabs (.cpt-tab[.active] + .cpt-tab__status[--ready|--data] + .cpt-tab__remove) + .btn.btn--compact ×3
│   └─ .segmented > .togbtn#phaseA/B/C  (Analysis | Stratigrafie | Doorsnede)
├─ #phaseCorr.phase-panel / #phaseSection.phase-panel   (Stratigrafie / Doorsnede, hidden unless phase)
├─ nav.nav#nav               sticky top:4.25rem  z:30 — light, rgba(237,233,225,0.88) + blur(14px)
│   └─ button.si[data-s=0..5][.active|.done|.locked] > span.sn (number box)   ← stages 1–6 only; "Stage 7 Report" is a button in .foot, not a rail item
├─ .wrap (max 1300px)
│   ├─ .panel#p0.active  > .sec (title/sub) > .dz (dropzone) > #s1body > .mgrid(.mi) + .ctrl-row + .chart-area(.col-card + .cc×3 canvases 380px) + .foot
│   ├─ .panel#p1  > .sec > .mcards.stage2-methods(.mc.stage2-method-card[.sel]) > .ctrl-row > .class-layout (result + 260px preview)
│   ├─ .panel#p2  > .sec > .ctrl-row(segmented .togbtn) > .info > table.tbl#lt (15 columns, .ed inputs, .sb soil badges) > .foot
│   ├─ .panel#p3  > .sec > .ctrl-row(3 segmented groups) > #ma (.mc2 cards with .mc2-head/.mc2-body/.mc2-sec/.pt tables) > .foot
│   ├─ .panel#p4  > .sec > .info(warn) > #tuningArea > .foot
│   └─ .panel#p5  > .sec > #stage6Area
│         ├─ .app-switch > .app-chip[.sel] (pill chips w/ 18px icons — the only pill-radius component)
│         ├─ Bishop:  .st6-bishop-layout (300px | 1fr) > settings side + .st6-bishop-canvas-stage (canvas 560px + .st6-canvas-shell glass dock/card/sheet + legends)
│         ├─ Pile:    .st6-pile-cols (300px | 1fr | 280px) + .st6-pile-charts (4 canvases 220px)
│         ├─ Retaining: .st6-retwall > .st6-rw-tabs(5) > .st6-rw-cols (310px | 1fr | 340px) > sticky .st6-rw-inputs(.st6-rw-acc accordions) | .st6-rw-canvaswrap(440px) | .st6-rw-summary(.st6-rw-verdict, .st6-rw-checks) ; .st6-rw-results > .st6-rw-rtabs > .st6-rw-rbody (charts 320/420px)
│         └─ others: inline `grid-template-columns:280px 1fr 260px`
└─ footer.docs-footer
.import-review-overlay (fixed, z:400, rgba(18,18,20,0.45) + blur(2px)) > .import-review (720px, var(--panel))
```

Feedback surfaces: `.info` (warn-tinted paragraph), `.layerwarn[-bad|-adj]`, `.data-note`, `.st6-help`, `.st6-rw-verdict.ok/.bad/.idle`, `.st6-rw-badge`, `.st6-rw-pill`, `.st6-bishop-source-pill--cpt/--user/--sbtn-default`, `.cpt-tab__status`. Errors use `window.alert()` (20 occurrences in the controller, e.g. lines 452, 1121, 1165, 2108, 6911). **There is no toast, no dialog primitive, no empty-state component** — empty states are ad-hoc `style="text-align:center;color:var(--tx2)"` spans (×13).

Tooltips: `.st6-tip[data-tip]` CSS-only (`::after`, dark `rgba(17,17,16,0.96)`), `.section-tip` (SVG hover), dock `::after` tips in the Bishop canvas; native `title=` everywhere else.

Icons: inline SVG strings, 24-viewBox, `stroke-width:1.7`, round caps (`stage6BishopToolIcon`, `stage6AppIcon` in the controller; `.dz-icon` stroke 1.5; top-bar save/load 16-viewBox stroke 1.5). Unicode glyphs elsewhere (`▸ ▾ + − ✓ ↓ →`).

### 2.4 The docs site look

`docs.css` is a **marketing-page** system (hero `h1 clamp(2.9rem,6.2vw,5.2rem)`, eyebrows with `letter-spacing:0.14em`, `.docs-shell` 230px nav + content, `.doc-card` sections separated by hairlines, serif Georgia formulas). `DocsHeader.svelte` is the madep.be floating **dark glass pill**: `position:fixed; background:rgba(17,17,16,0.62); backdrop-filter:blur(16px); border:1px solid rgba(237,233,225,0.1); border-radius:6px; box-shadow:0 8px 24px rgba(17,17,16,0.1)`, links `0.76rem / 0.12em uppercase`, animated `::after` underline `scaleX(0.45→1)` with `cubic-bezier(0.22,1,0.36,1)`. Dark mode is a hand-maintained override block (docs.css 760–936) that re-colours ~25 selectors instead of swapping tokens — the reason docs dark and app dark drift (docs `--color-text-light:#c5c1ba`, app `#BCB6AC`).

Reports (`/report/*`): a deliberately **fixed light "sheet"** (`--rpt-paper:#fff`, `--rpt-ink:#18181a`, `--rpt-accent:#3d6b6a`, `--rpt-pass:#2e6f55`, `--rpt-fail:#9b3a32`) inside a `<table class="report-sheet">` with running head/foot rows for print, and `@media print` blocks at stage7:2577, retaining:384, soilin:530 (`font-size:8pt`, `print-color-adjust:exact`, `.no-print{display:none}`, `break-inside:avoid` on rows). This is already the right model; it must survive the overhaul untouched (§3.16).

### 2.5 Concrete gaps vs the target language

| # | Gap | Evidence |
|---|---|---|
| G1 | **Two glass dialects inside one file.** The Stage 6 canvas overlay (`.st6-canvas-shell`, legacy.css ~1000–1180) already implements the full recipe — `--st6-glass-filter:blur(18px) saturate(1.22)`, hairline `color-mix(in srgb, rgba(255,255,255,0.42) 62%, var(--bd2))`, shadow `0 22px 58px rgba(22,28,36,0.16), 0 4px 14px …, inset 0 0 0 1px hairline` — but it is **scoped as local custom properties on one element** and cannot be reused. The nav uses `blur(14px)` with no saturate; the Bishop legends `blur(4px)`/`blur(6px)`; the import-review scrim `blur(2px)`; the retaining canvas tools plain `rgba(255,255,255,0.88)` with no blur. BC-sizer's `--glass-*` tokens (the canonical set) are absent. |
| G2 | **No specular edge anywhere except `.st6-canvas-tools-restore`** (`inset 0 1px 0 rgba(255,255,255,0.34)`). Panels are flat translucent white (`--app-panel rgba(255,255,255,0.52)`) with paper shadows — they read as "washed" not "glass". |
| G3 | **Top bar is opaque dark (0.94) with no blur and no border radius**, while every other MADEP surface (madep.be, DocsHeader, BC-sizer `glass-chrome`, geon/gis top bars) is a floating dark glass bar. The logo is recoloured through a 5-step `filter:` chain (line ~224) instead of using the cream SVG. |
| G4 | **Stage rail is a bordered strip of mono-uppercase buttons** (`.si` 0.7rem, `border-right` dividers, radius only on first/last). No progress affordance (done/locked = colour/opacity only, `.locked{opacity:.42; pointer-events:none}` is not announced to AT). Stage 7 is absent from the rail. |
| G5 | **Type scale is unmanaged.** legacy.css uses more than 25 distinct font sizes (`11px`×23, `10px`×16, `0.68rem`×11, `0.72rem`×10 … `9px`, `12.5px`); retaining-styles.js adds `9.5px`, `10.5px`, `11.5px`. Body is 14px in the app but 16px in `app.css` (the docs). Letter-spacing is globally nuked (`.cpt-app *{letter-spacing:0!important}`, line 197) which kills the brand's tracked-mono eyebrow idiom, then re-added locally (`letter-spacing:0.04em` ×20 in Stage 6 titles — which the `!important` silently overrides). |
| G6 | **Radii are inconsistent**: 3/6/10 tokens exist, but Stage 6 uses raw `7px, 8px, 9px, 10px, 12px`, `999px` pills (`.app-chip`, `.st6-bishop-source-pill`, progress tracks), `4px/5px` in retaining. The brand rule is 3 / 6 / 10 and "never pill-rounded for actions". |
| G7 | **Duplicate/overriding rule blocks.** `.st6-adv`, `.st6-help`, `.st6-tip`, `.layerwarn`, `.st6-bishop-layout`, `.st6-bishop-canvas`, `.st6-bishop-region-legend` are each declared twice (px version ~lines 570–700 and 1310–1340, then a rem "reskin" pass ~1930–2100). `.st6-tip::after{content:none}` followed by `.st6-tip:hover::after{content:attr(data-tip)}` is a patch on a patch. 12 `!important`s. |
| G8 | **Inputs**: 76 inline-styled fields in the controller with `border-radius:6px` (should be 3px), `.ed` cells at `0.72rem`, retaining `.st6-rw-field input` at `11.5px` right-aligned; three visual recipes for the same control. Number inputs lack `font-variant-numeric:tabular-nums` and a unit affordance. Checkboxes/ranges are native with only `accent-color`. |
| G9 | **Tables**: `.tbl`, `.pt`, `.st6-audit`, `.st6-rw-table`, `.st6-rw-layers`, `.st6-rw-checks`, `.ir-table`, `.rn-table` — eight table recipes, three header treatments (bg2 fill / bare hairline / sticky). Numeric columns are not consistently right-aligned or tabular. |
| G10 | **Dark mode is half-finished**: canvases/SVGs read `getComputedStyle` once at chart creation (`chart-factories.js:27`) and never re-read on scheme change; retaining charts hard-code `TEXT='#4a4a52'`, `GRID='rgba(24,24,26,0.08)'`, `background:#fff` (`.st6-rw-chart`), canvas labels `#18181a`; `report-svg.js` hard-codes `#9a9a96`, `#378ADD`; the section view forces `#FBF9F5!important`. Header tints (`rgba(237,233,225,…)`) are literal, not tokens. |
| G11 | **Data-viz palette is unmanaged**: chart-factories falls back to brand colours but Stage 6 sprinkles `#b3477a`, `#7e50a8`, `#2d3a4a`, `#667085`, `#2f7fda`, `#1D9E75`, `#128a99`, `#7a2dd2`, `#1f6feb` (40+ literal hexes, cool-blue/purple — off-brand); Bishop region palette is its own 8-colour set (`#b68a60 #7aa6c2 #a67bbd #d6b26f #94b47b #d38d8d #8f9aa7 #b7a27c`). Soil colours (`soil-styles.js`) are fine but only defined in JS + `.s-*` classes, not as tokens. |
| G12 | **Motion**: buttons carry the madep sheen sweep, but hover transforms (`translateY(-1px)` on inputs' focus) run on **every field** including table cells (`.ed`), causing layout jitter in the 15-column layer table. Reduced-motion is handled (line 2300). No `prefers-reduced-transparency` or `@supports not (backdrop-filter)` anywhere. |
| G13 | **Elevation/z-index** is ad hoc: 2, 3, 5, 8, 30, 40, 400, 9999 (+1000 in DocsHeader). Tooltips (z:40) sit at the same level as the sticky header. |
| G14 | **Focus**: `:focus-visible{outline:2px solid rgba(61,107,106,0.45); outline-offset:3px}` is good, but `.st6-tip:focus{outline:none}`, `#projName{outline:none}`, `.st6-canvas-capture:focus-visible{outline:2px solid rgba(40,90,180,0.4)}` (a random blue) break it. `.si.locked{pointer-events:none}` without `disabled`/`aria-disabled`. |
| G15 | **Accessibility of colour**: `--color-text-muted:#888890` on `#F7F4EF` is **3.0:1** (fails AA for text; it is used for `.mi-l`, `.ctrl-lbl`'s siblings, `.st6-rw-unit` etc.). `.cpt-tab` text `rgba(237,233,225,0.72)` on `#111110` ≈ 8:1 OK; `.app-header .togbtn` at 0.70 OK. Dark-mode accent `#6FA9A8` on `#111110` = 7.4:1 OK. |
| G16 | **Print**: the app itself has no `@media print`; only the report routes do. Printing the app page prints the sticky header, rail and canvases as-is. |
| G17 | **Density**: the retaining module is a separate 10–11.5px world in px, the Bishop module 0.72rem, the top-level stages 0.78–0.82rem. There is no shared `--density` control. |

---

## 3. Target design system for the CPT app

### 3.0 Principles (the four rules everything below follows)

1. **Paper is the ground, glass is the figure.** Glass appears on exactly four surface classes — the dark top bar (`glass-chrome`), the light sticky stage rail (`glass-rail`), overlays that float *over a canvas* (`glass-float`: tool docks, legends, inspector cards, tooltips), and modal sheets + scrims (`glass-sheet`, `glass-scrim`). Stage panels, cards, tables, accordions and form fields are **flat bone paper with 1px hairlines** — no blur. This is what BC-sizer calls "earned depth" and it is also the only way to keep 27 canvases at 60 fps (§4).
2. **One accent.** Teal `#3D6B6A` for interaction; semantic green/amber/brick only for verdicts. No cool blues/purples in UI or charts.
3. **Mono is structure.** Every eyebrow, unit, table header, stat label, stage number and status pill is JetBrains Mono, uppercase, tracked `0.08–0.12em` (app density; the site uses 0.14–0.16). Numbers are `tabular-nums`.
4. **Radius 3 / 6 / 10.** Controls 3, panels 6, floating glass 10. No `999px` pills on actions.

### 3.1 `src/lib/styles/tokens.css` — paste-ready

Rules baked in: (a) every token has a light definition on bare `:root`; dark is a **redefinition** under both `prefers-color-scheme` (guarded by `:root:not([data-theme="light"])`) and `[data-theme="dark"]`, so an explicit toggle wins in both directions; (b) **tokens that JS reads for canvases (`--viz-*`, `--canvas-*`) are literal hex/rgba only** — never `color-mix()` or `light-dark()`, because `getComputedStyle(root).getPropertyValue()` returns custom properties *unresolved* and `CanvasRenderingContext2D` cannot parse them (see §3.14 for the resolver helper); (c) glass recipes are exposed as tokens *and* as classes so the string-rendered monolith can use either.

```css
/* src/lib/styles/tokens.css — MADEP CPT Interpreter design tokens
   Layer order is declared once in app.css:  @layer tokens, base, legacy, components, utilities;  */
@layer tokens {
  :root {
    color-scheme: light dark;

    /* ── 1. Brand palette (madep.be / docs/style.md — do not change) ─────────── */
    --color-bg:            #F7F4EF;   /* bone paper */
    --color-bg-alt:        #EDE9E1;   /* sand: table heads, quiet panels */
    --color-bg-panel:      #FBF9F5;   /* near-white flat panel + canvas paper */
    --color-bg-dark:       #111110;
    --color-bg-darker:     #0C0C0B;
    --color-ink:           #18181A;
    --color-ink-2:         #4A4A52;   /* body / secondary text */
    --color-ink-3:         #65656D;   /* muted labels — 5.0:1 on bone (AA). NOT #888890 (3.0:1) */
    --color-ink-4:         #8A8A82;   /* decorative only: dividers-as-text, disabled */
    --color-on-dark:       #EDE9E1;
    --color-on-dark-2:     rgba(237,233,225,0.72);
    --color-on-dark-3:     #8A8A82;
    --color-accent:        #3D6B6A;
    --color-accent-hover:  #4F8584;
    --color-accent-text:   #2E5150;   /* 7.6:1 on bone */
    --color-accent-soft:   rgba(61,107,106,0.10);
    --color-accent-border: rgba(61,107,106,0.34);
    --color-line:          rgba(24,24,26,0.10);
    --color-line-strong:   rgba(24,24,26,0.18);
    --color-line-heavy:    rgba(24,24,26,0.28);

    /* ── 2. Semantic ───────────────────────────────────────────────────────── */
    --color-good:          #2E6F55;  --color-good-soft:   rgba(46,111,85,0.10);  --color-good-border:   rgba(46,111,85,0.28);
    --color-warn:          #8A620D;  --color-warn-soft:   rgba(138,98,13,0.12);  --color-warn-border:   rgba(138,98,13,0.30);
    --color-bad:           #9B3A32;  --color-bad-soft:    rgba(155,58,50,0.10);  --color-bad-border:    rgba(155,58,50,0.30);
    --color-info:          var(--color-accent);
    --color-info-text:     var(--color-accent-text);
    --color-info-soft:     var(--color-accent-soft);
    --color-neutral:       #6D6962;  --color-neutral-soft: rgba(109,105,98,0.12);

    /* ── 3. Surfaces (flat paper) ──────────────────────────────────────────── */
    --surface-page:        var(--color-bg);
    --surface-panel:       rgba(255,255,255,0.56);   /* stage panel */
    --surface-card:        rgba(255,255,255,0.66);   /* .card, .mc2, accordions */
    --surface-quiet:       rgba(247,244,239,0.55);   /* help notes, muted groups */
    --surface-raised:      #FFFFFF;                  /* inputs, popover content */
    --surface-hover:       rgba(24,24,26,0.035);
    --surface-active:      var(--color-accent-soft);
    --surface-selected:    rgba(61,107,106,0.14);
    --paper-grid:          rgba(24,24,26,0.026);     /* page graph paper */
    --canvas-paper:        #FBF9F5;                  /* literal — read by JS */
    --canvas-grid:         rgba(24,24,26,0.05);      /* literal — read by JS */

    /* ── 4. Liquid glass ───────────────────────────────────────────────────── */
    --glass-blur:          18px;
    --glass-blur-chrome:   14px;
    --glass-blur-scrim:    6px;
    --glass-sat:           1.22;
    --glass-tint:          color-mix(in srgb, #F7F4EF 62%, #FFFFFF 38%);
    --glass-alpha:         0.66;
    --glass-bg:            color-mix(in srgb, var(--glass-tint) calc(var(--glass-alpha) * 100%), transparent);
    --glass-bg-strong:     color-mix(in srgb, var(--glass-tint) 86%, transparent);   /* inspector cards over busy canvases */
    --glass-bg-sheet:      color-mix(in srgb, var(--color-bg) 93%, transparent);     /* modals: readable, not muddy (gis rule) */
    --glass-border:        rgba(255,255,255,0.45);
    --glass-hairline:      color-mix(in srgb, rgba(255,255,255,0.60) 60%, var(--color-line-strong));
    --glass-edge-light:    rgba(255,255,255,0.55);   /* inset top specular */
    --glass-edge-shadow:   rgba(24,24,26,0.06);      /* inset bottom weight */
    --glass-sheen:         linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.22) 48%, transparent 66%);
    --glass-shadow:        0 22px 58px rgba(22,28,36,0.16), 0 4px 14px rgba(22,28,36,0.08);
    --glass-shadow-sm:     0 8px 20px rgba(22,28,36,0.12), 0 1px 3px rgba(22,28,36,0.06);
    --glass-fallback:      #FBF9F5F2;                /* opaque bone when blur is unavailable / reduced */
    --glass-tint-dark:     color-mix(in srgb, #111110 78%, #18181A 22%);
    --glass-alpha-chrome:  0.80;   /* BC-sizer uses .68 for a 4-link header; CPT's bar carries text tabs → .80 for AA (§4.2) */
    --glass-bg-chrome:     color-mix(in srgb, var(--glass-tint-dark) calc(var(--glass-alpha-chrome) * 100%), transparent);
    --glass-bg-chrome-scrolled: rgba(17,17,16,0.88);
    --glass-border-chrome: rgba(237,233,225,0.10);
    --glass-edge-chrome:   rgba(237,233,225,0.06);
    --glass-shadow-chrome: 0 8px 24px rgba(0,0,0,0.18);
    --glass-fallback-chrome: #111110;
    --scrim:               rgba(17,17,16,0.36);

    /* ── 5. Geometry ───────────────────────────────────────────────────────── */
    --radius-sm: 3px;  --radius-md: 6px;  --radius-lg: 10px;  --radius-round: 999px; /* round: progress tracks + dots only */
    --hairline: 1px solid var(--color-line);
    --hairline-strong: 1px solid var(--color-line-strong);

    /* ── 6. Elevation (paper) ──────────────────────────────────────────────── */
    --shadow-0: none;
    --shadow-1: 0 1px 2px rgba(18,18,20,0.04), 0 2px 8px rgba(18,18,20,0.05);
    --shadow-2: 0 6px 24px rgba(18,18,20,0.07);
    --shadow-3: 0 12px 40px rgba(18,18,20,0.09);
    --shadow-focus: 0 0 0 3px var(--color-accent-soft);

    /* ── 7. Typography ─────────────────────────────────────────────────────── */
    --font-heading: 'DM Sans', system-ui, sans-serif;
    --font-body:    'Manrope', system-ui, sans-serif;
    --font-mono:    'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    /* app scale — instrument panel; rem is 16px so these are exact px */
    --fs-2xs:  0.625rem;   /* 10px  mono micro (units, table meta) */
    --fs-xs:   0.6875rem;  /* 11px  mono labels, eyebrows, pills, th */
    --fs-sm:   0.75rem;    /* 12px  dense body, table cells, help */
    --fs-md:   0.8125rem;  /* 13px  default control + body text in app */
    --fs-base: 0.875rem;   /* 14px  panel body, sec-sub */
    --fs-lg:   1rem;       /* 16px  panel title */
    --fs-xl:   1.25rem;    /* 20px  metric value */
    --fs-2xl:  1.5rem;     /* 24px  hero metric / report h2 */
    --lh-tight: 1.2;  --lh-snug: 1.35;  --lh-body: 1.5;  --lh-loose: 1.65;
    --track-mono: 0.08em;  --track-eyebrow: 0.12em;  --track-heading: -0.015em;
    --fw-regular: 400;  --fw-medium: 500;  --fw-semibold: 600;  --fw-bold: 650;

    /* ── 8. Spacing (4-pt) ─────────────────────────────────────────────────── */
    --sp-1: 0.25rem; --sp-2: 0.5rem; --sp-3: 0.75rem; --sp-4: 1rem; --sp-5: 1.25rem;
    --sp-6: 1.5rem;  --sp-8: 2rem;   --sp-10: 2.5rem; --sp-12: 3rem;
    --gap-tight: var(--sp-2);  --gap: var(--sp-3);  --gap-loose: var(--sp-4);
    --pad-control: 0.45rem 0.6rem;   /* inputs, compact buttons */
    --pad-card: var(--sp-4);
    --pad-panel: var(--sp-4) var(--sp-5);
    --container-max: 1300px;  --container-narrow: 760px;
    --section-px: clamp(1rem, 3vw, 2.5rem);
    --toolbar-h: 4rem;  --rail-h: 3.25rem;
    --control-h: 2.1rem;  --control-h-sm: 1.75rem;  --touch-min: 2.75rem;
    --col-side: minmax(17rem, 19rem);  --col-inspector: minmax(16rem, 18rem);   /* Stage 6 three-column */

    /* ── 9. Z layers ───────────────────────────────────────────────────────── */
    --z-base: 0; --z-raised: 1; --z-sticky-cell: 2; --z-canvas-overlay: 10; --z-rail: 20;
    --z-header: 30; --z-popover: 40; --z-tooltip: 50; --z-scrim: 60; --z-modal: 61; --z-toast: 70; --z-skiplink: 100;

    /* ── 10. Motion ────────────────────────────────────────────────────────── */
    --motion-micro: 0.12s; --motion-quick: 0.20s; --motion-base: 0.32s; --motion-slow: 0.60s; --motion-reveal: 0.96s;
    --ease-smooth: cubic-bezier(0, 0, 0.2, 1);
    --ease-snappy: cubic-bezier(0.4, 0, 0.2, 1);
    --ease-reveal: cubic-bezier(0.22, 1, 0.36, 1);
    --ease-luxury: cubic-bezier(0.16, 1, 0.3, 1);
    --transition-fast: var(--motion-micro) ease;
    --transition-base: 0.22s ease;
    --lift-1: translateY(-1px);  --lift-2: translateY(-2px);

    /* ── 11. Data-viz (all literal; read by Chart.js + 2D canvases + SVG) ──── */
    --viz-1: #3D6B6A;  /* teal   — primary series (qc, main curve)            */
    --viz-2: #18181A;  /* ink    — secondary series (fs, envelopes)           */
    --viz-3: #8A620D;  /* ochre  — tertiary (Rf, neutral plane, warnings)     */
    --viz-4: #9B3A32;  /* brick  — limits, failure, φ' reduction               */
    --viz-5: #3C6F97;  /* slate  — water / pore pressure ONLY                  */
    --viz-6: #6F8F64;  /* moss   — accepted / fitted                            */
    --viz-neutral: #6D6962;
    --viz-1-soft: rgba(61,107,106,0.12); --viz-3-soft: rgba(138,98,13,0.16); --viz-4-soft: rgba(155,58,50,0.12); --viz-5-soft: rgba(60,111,151,0.12);
    --viz-grid: rgba(24,24,26,0.08);  --viz-grid-strong: rgba(24,24,26,0.16);  --viz-axis: rgba(24,24,26,0.55);
    --viz-text: #18181A;  --viz-text-muted: #4A4A52;  --viz-halo: rgba(255,255,255,0.92);
    --viz-band: rgba(24,24,26,0.05);  --viz-tooltip-bg: rgba(255,255,255,0.96);
    --viz-water: #3C6F97;  --viz-water-soft: rgba(60,111,151,0.10);
    /* soil units (soil-styles.js) — keep in sync; the JS map is the source */
    --soil-peat: #C0DD97; --soil-sclay: #B5D4F4; --soil-clay: #AFA9EC; --soil-sclayl: #FAC775;
    --soil-ssand: #F4C0D1; --soil-sand: #D3D1C7; --soil-gravel: #F0997B;
    /* Bishop / seepage region palette (stage6-bishop.js) — muted earth, 8 stops */
    --region-1:#b68a60; --region-2:#7aa6c2; --region-3:#a67bbd; --region-4:#d6b26f;
    --region-5:#94b47b; --region-6:#d38d8d; --region-7:#8f9aa7; --region-8:#b7a27c;
  }

  /* ── Dark theme: redefine only what changes ──────────────────────────────── */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --color-bg: #111110; --color-bg-alt: #181818; --color-bg-panel: #16161A; --color-bg-dark: #0C0C0B; --color-bg-darker: #050504;
      --color-ink: #EDE9E1; --color-ink-2: #BCB6AC; --color-ink-3: #9A948A; --color-ink-4: #6E6A62;
      --color-accent: #6FA9A8; --color-accent-hover: #86C0BF; --color-accent-text: #9FD3D2;
      --color-accent-soft: rgba(111,169,168,0.16); --color-accent-border: rgba(111,169,168,0.40);
      --color-line: rgba(237,233,225,0.10); --color-line-strong: rgba(237,233,225,0.20); --color-line-heavy: rgba(237,233,225,0.32);
      --color-good: #6FA585; --color-good-soft: rgba(111,165,133,0.16); --color-good-border: rgba(111,165,133,0.36);
      --color-warn: #C99961; --color-warn-soft: rgba(201,153,97,0.16); --color-warn-border: rgba(201,153,97,0.36);
      --color-bad:  #D2776E; --color-bad-soft:  rgba(210,119,110,0.16); --color-bad-border: rgba(210,119,110,0.36);
      --color-neutral: #BCB6AC; --color-neutral-soft: rgba(237,233,225,0.08);
      --surface-panel: rgba(33,36,34,0.62); --surface-card: rgba(33,36,34,0.85); --surface-quiet: rgba(24,24,22,0.55);
      --surface-raised: rgba(8,8,7,0.55); --surface-hover: rgba(237,233,225,0.06); --surface-selected: rgba(111,169,168,0.22);
      --paper-grid: rgba(237,233,225,0.035); --canvas-paper: #181816; --canvas-grid: rgba(237,233,225,0.06);
      --glass-tint: color-mix(in srgb, #16181A 80%, #2A2D2B 20%);
      --glass-bg-strong: color-mix(in srgb, var(--glass-tint) 90%, transparent);
      --glass-border: rgba(237,233,225,0.12);
      --glass-hairline: color-mix(in srgb, rgba(255,255,255,0.22) 50%, var(--color-line-strong));
      --glass-edge-light: rgba(255,255,255,0.10); --glass-edge-shadow: rgba(0,0,0,0.35);
      --glass-sheen: linear-gradient(105deg, transparent 30%, rgba(255,255,255,0.08) 48%, transparent 66%);
      --glass-shadow: 0 22px 58px rgba(0,0,0,0.55), 0 4px 14px rgba(0,0,0,0.32);
      --glass-shadow-sm: 0 8px 20px rgba(0,0,0,0.40), 0 1px 3px rgba(0,0,0,0.30);
      --glass-fallback: #1A1A18F5;
      --scrim: rgba(0,0,0,0.55);
      --shadow-1: 0 1px 2px rgba(0,0,0,0.30), 0 2px 8px rgba(0,0,0,0.32); --shadow-2: 0 6px 24px rgba(0,0,0,0.40); --shadow-3: 0 12px 40px rgba(0,0,0,0.48);
      --viz-1: #86C0BF; --viz-2: #EDE9E1; --viz-3: #C99961; --viz-4: #D2776E; --viz-5: #7FAAD0; --viz-6: #9CBF8E; --viz-neutral: #BCB6AC;
      --viz-1-soft: rgba(134,192,191,0.18); --viz-3-soft: rgba(201,153,97,0.18); --viz-4-soft: rgba(210,119,110,0.16); --viz-5-soft: rgba(127,170,208,0.16);
      --viz-grid: rgba(237,233,225,0.12); --viz-grid-strong: rgba(237,233,225,0.22); --viz-axis: rgba(237,233,225,0.55);
      --viz-text: #EDE9E1; --viz-text-muted: #BCB6AC; --viz-halo: rgba(8,8,7,0.92);
      --viz-band: rgba(237,233,225,0.06); --viz-tooltip-bg: rgba(24,24,22,0.96);
      --viz-water: #7FAAD0; --viz-water-soft: rgba(127,170,208,0.14);
    }
  }
  :root[data-theme="dark"] {
    /* identical block to the media query above — keep the two in sync (generated; see scripts/verify_tokens.mjs in §5) */
  }

  /* ── Reduced transparency / no backdrop-filter → opaque paper ─────────────── */
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    :root { --glass-bg: var(--glass-fallback); --glass-bg-strong: var(--glass-fallback); --glass-bg-sheet: var(--glass-fallback);
            --glass-bg-chrome: var(--glass-fallback-chrome); --glass-blur: 0px; --glass-blur-chrome: 0px; --glass-blur-scrim: 0px; }
  }
  @media (prefers-reduced-transparency: reduce) {
    :root { --glass-bg: var(--glass-fallback); --glass-bg-strong: var(--glass-fallback); --glass-bg-sheet: var(--glass-fallback);
            --glass-bg-chrome: var(--glass-fallback-chrome); --glass-blur: 0px; --glass-blur-chrome: 0px; --glass-blur-scrim: 0px;
            --glass-sheen: none; --scrim: rgba(17,17,16,0.55); }
  }
  :root[data-transparency="reduce"] { /* in-app toggle, same values as the media query */
    --glass-bg: var(--glass-fallback); --glass-bg-strong: var(--glass-fallback); --glass-bg-sheet: var(--glass-fallback);
    --glass-bg-chrome: var(--glass-fallback-chrome); --glass-blur: 0px; --glass-blur-chrome: 0px; --glass-blur-scrim: 0px; --glass-sheen: none;
  }
  @media (prefers-reduced-motion: reduce) {
    :root { --motion-micro: 0.001ms; --motion-quick: 0.001ms; --motion-base: 0.001ms; --motion-slow: 0.001ms; --motion-reveal: 0.001ms;
            --lift-1: none; --lift-2: none; --glass-sheen: none; }
  }

  /* ── Legacy aliases (phase 1 — the 18k-line controller keeps working) ─────── */
  :root {
    --ac: var(--color-accent); --acl: var(--color-accent-soft); --acb: var(--color-accent-hover); --acd: var(--color-accent-text);
    --wn: var(--color-warn); --wnl: var(--color-warn-soft); --wn-soft: var(--color-warn-soft);
    --ok: var(--color-good); --ok-text: var(--color-good); --ok-soft: var(--color-good-soft);
    --info: var(--color-info); --info-text: var(--color-info-text); --info-soft: var(--color-info-soft);
    --bad: var(--color-bad); --bad-text: var(--color-bad); --bad-soft: var(--color-bad-soft);
    --neutral-text: var(--color-neutral); --neutral-soft: var(--color-neutral-soft);
    --bg: var(--color-bg); --bg2: var(--color-bg-alt); --bg3: var(--color-bg-panel);
    --tx: var(--color-ink); --tx2: var(--color-ink-2); --tx3: var(--color-ink-3);
    --bd: var(--color-line); --bd2: var(--color-line-strong);
    --panel: var(--surface-panel); --panel-muted: var(--surface-quiet); --panel-soft: var(--surface-quiet);
    --panel-solid: var(--surface-card); --panel-strong: var(--glass-bg-strong);
    --hover-soft: var(--surface-hover); --input-bg: var(--surface-raised); --input-bg-hover: var(--surface-raised);
    --r: var(--radius-md); --r2: var(--radius-lg); --sh: var(--shadow-1);
    --nav-bg: var(--glass-bg); --canvas-bg: var(--canvas-paper); --canvas-grid-line: var(--canvas-grid);
    --canvas-text: var(--viz-text); --canvas-text-halo: var(--viz-halo);
    --chart-grid: var(--viz-grid); --chart-grid-strong: var(--viz-grid-strong); --chart-band-fill: var(--viz-band); --chart-tooltip-bg: var(--viz-tooltip-bg);
    --chart-blue: var(--viz-1); --chart-purple: var(--viz-2); --chart-green: var(--viz-6); --chart-orange: var(--viz-3); --chart-red: var(--viz-4);
    --chart-neutral: var(--viz-neutral); --chart-blue-soft: var(--viz-1-soft);
    --plot-primary: var(--viz-1); --plot-secondary: var(--viz-2); --plot-tertiary: var(--viz-3); --plot-danger: var(--viz-4); --plot-grid: var(--viz-grid); --plot-fill: var(--viz-1-soft);
    --btn-pri-hover: var(--color-bg-darker);
    --app-panel: var(--surface-panel); --app-panel-muted: var(--surface-quiet); --app-panel-dark: var(--glass-bg-chrome);
    --app-line: var(--color-line); --app-line-strong: var(--color-line-strong); --app-hover: var(--surface-hover); --app-active: var(--surface-active);
    --app-good: var(--color-good); --app-good-bg: var(--color-good-soft); --app-warn: var(--color-warn); --app-warn-bg: var(--color-warn-soft);
    --app-danger: var(--color-bad); --app-danger-bg: var(--color-bad-soft); --app-toolbar-h: var(--toolbar-h); --app-gap: var(--gap-loose);
    --color-primary: var(--color-ink); --color-primary-light: #282828; --color-primary-lighter: #404040;
    --color-text: var(--color-ink); --color-text-light: var(--color-ink-2); --color-text-muted: var(--color-ink-3);
    --color-text-on-dark: var(--color-on-dark); --color-text-on-dark-muted: var(--color-on-dark-3);
    --color-border: var(--color-line); --color-border-strong: var(--color-line-strong);
    --text-xs: var(--fs-xs); --text-sm: var(--fs-sm); --text-base: var(--fs-base); --text-lg: var(--fs-lg); --text-xl: var(--fs-xl);
    --shadow-sm: var(--shadow-1); --shadow-md: var(--shadow-2); --shadow-lg: var(--shadow-3);
    --motion-base: var(--motion-base); --transition-slow: 0.40s ease;
  }
}
```

Notes on deliberate deviations from today's values: `--tx3` moves from `#888890` (3.0:1) to `#65656D` (5.0:1) — the single biggest accessibility win, zero markup change; `--panel-solid` gains 4% opacity (0.62→0.66) to match BC-sizer's `--glass-alpha-light`; `--chart-green` now maps to moss `--viz-6` rather than the teal (it was identical to `--plot-primary`, so qc and "fitted" series were indistinguishable); `--nav-bg` becomes the glass token so the rail is glass in phase 1 automatically.

### 3.2 Core glass surface — exact CSS (`src/lib/styles/glass.css`, layer `components`)

```css
@layer components {
  /* Base material: frost + tint + specular edge + lift. Never on scrolling lists or table rows. */
  .glass,
  .glass-float {
    position: relative;
    isolation: isolate;
    contain: paint;
    border-radius: var(--radius-lg);
    background: var(--glass-bg);
    border: 1px solid var(--glass-border);
    box-shadow:
      inset 0 1px 0 var(--glass-edge-light),
      inset 0 -1px 0 var(--glass-edge-shadow),
      0 0 0 1px var(--glass-hairline),
      var(--glass-shadow);
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
    color: var(--color-ink);
  }
  .glass--strong { background: var(--glass-bg-strong); }          /* inspector cards over dense canvases */
  .glass--sm     { box-shadow: inset 0 1px 0 var(--glass-edge-light), inset 0 -1px 0 var(--glass-edge-shadow), 0 0 0 1px var(--glass-hairline), var(--glass-shadow-sm); }
  .glass--sheen::before {                                            /* optional refraction sweep (hero cards, on reveal) */
    content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none;
    background: var(--glass-sheen); transform: translateX(-120%);
    transition: transform var(--motion-slow) var(--ease-luxury);
  }
  .glass--sheen:hover::before, .glass--sheen[data-revealed]::before { transform: translateX(120%); }

  /* Dark chrome: the top bar. Dark in both themes (madep.be / gis rule). */
  .glass-chrome {
    background: var(--glass-bg-chrome);
    border: 1px solid var(--glass-border-chrome);
    box-shadow: inset 0 1px 0 var(--glass-edge-chrome), var(--glass-shadow-chrome);
    -webkit-backdrop-filter: blur(var(--glass-blur-chrome)) saturate(1.1);
    backdrop-filter: blur(var(--glass-blur-chrome)) saturate(1.1);
    color: var(--color-on-dark);
  }
  .glass-chrome.is-scrolled { background: var(--glass-bg-chrome-scrolled); }

  /* Light rail: sticky stage navigation under the chrome. Lower blur; no lift shadow (it is attached, not floating). */
  .glass-rail {
    background: var(--glass-bg);
    border-bottom: 1px solid var(--color-line);
    box-shadow: inset 0 1px 0 var(--glass-edge-light);
    -webkit-backdrop-filter: blur(var(--glass-blur-chrome)) saturate(var(--glass-sat));
    backdrop-filter: blur(var(--glass-blur-chrome)) saturate(var(--glass-sat));
  }

  /* Sheet + scrim: modals. The sheet is 93% opaque (readable over canvases), the scrim carries the blur. */
  .glass-scrim {
    position: fixed; inset: 0; z-index: var(--z-scrim);
    background: var(--scrim);
    -webkit-backdrop-filter: blur(var(--glass-blur-scrim)) saturate(1.05);
    backdrop-filter: blur(var(--glass-blur-scrim)) saturate(1.05);
  }
  .glass-sheet {
    position: relative; z-index: var(--z-modal);
    border-radius: var(--radius-lg);
    background: var(--glass-bg-sheet);
    border: 1px solid var(--glass-border);
    box-shadow: inset 0 1px 0 var(--glass-edge-light), 0 0 0 1px var(--glass-hairline), var(--glass-shadow);
    -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
    backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-sat));
  }

  /* Controls that sit ON glass: a wash, not a second blur (blur-in-blur is the #1 GPU cost). */
  .glass .control, .glass-float .control, .glass-chrome .control {
    background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
  }
  .glass .control:hover, .glass-float .control:hover { background: color-mix(in srgb, #FFFFFF 28%, var(--surface-panel) 72%); }
  .glass .control[aria-pressed="true"], .glass .control.active { background: var(--surface-active); color: var(--color-accent); box-shadow: inset 0 0 0 1px var(--color-accent-border); }
  .glass-chrome .control { color: var(--color-on-dark-2); border-color: rgba(237,233,225,0.16); }
  .glass-chrome .control:hover { color: var(--color-on-dark); border-color: rgba(237,233,225,0.40); background: rgba(255,255,255,0.05); }
  .glass-chrome .control.active { background: rgba(61,107,106,0.34); border-color: rgba(61,107,106,0.55); color: var(--color-on-dark); }

  /* Print: glass becomes paper. */
  @media print {
    .glass, .glass-float, .glass-sheet, .glass-rail { background: #fff; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; border-color: #999; }
    .glass-chrome, .glass-scrim { display: none !important; }
  }
}
```

The `0 0 0 1px var(--glass-hairline)` ring is the gis technique (a whiter-than-border rim = lit edge); the two inset lines are BC-sizer's specular top/bottom. Together they produce the "liquid" read; either alone reads as plain blur.

### 3.3 App shell / top bar (`glass-chrome`)

- `header.app-header.glass-chrome`: `position:sticky; top:0; z-index:var(--z-header); min-height:var(--toolbar-h)`; **inset floating variant on ≥1100px**: `margin: var(--sp-2) var(--section-px) 0; border-radius: var(--radius-md)` (madep.be / DocsHeader pill), full-bleed with `border-radius:0` below. `.is-scrolled` (IntersectionObserver sentinel) densifies to `--glass-bg-chrome-scrolled` and `min-height: 3.5rem`.
- Grid: `minmax(10rem,13rem) auto minmax(0,1fr) auto auto`. Brand = cream SVG (`/MADEP_logo.svg` gets an `--on-dark` variant; delete the 5-step `filter:` chain). Project name input: DM Sans 600 `--fs-base`, transparent, underline-on-focus (1px teal `scaleX` wipe — the brand motif), never `outline:none` without a replacement.
- CPT tabs: `.cpt-tab` = `.control` height `var(--control-h)`, radius 3, `--fs-sm`; active = teal wash; status chip `.cpt-tab__status` mono `--fs-2xs` uppercase `--track-mono` with 1px border (`--ready` good-border, `--data` warn-border).
- Phase switch: `.segmented` (§3.7) on dark.
- Actions: `.btn.btn--ghost-dark` (icon 16px, stroke 1.5).

### 3.4 Stage rail (`glass-rail`)

- `nav.stage-rail.glass-rail`: `position:sticky; top:var(--toolbar-h); z-index:var(--z-rail); height:var(--rail-h); padding-inline:var(--section-px)`. Items are **7** (add Stage 7 Report as a rail item; it opens the report route) laid out as a single `display:flex` row scrolling horizontally on narrow widths with `scroll-snap-type:x proximity`.
- `.stage` = `button` with `.stage__num` (1.35rem square, radius 3, mono 600 `--fs-xs`) + `.stage__label` (mono uppercase `--fs-xs`, tracked `--track-mono`, weight 500). No borders between items; a **1px teal underline** `::after` (`scaleX 0→1`, `--motion-base --ease-luxury`) marks the active stage — the madep.be nav idiom.
- States: `[aria-current="step"]` active → num filled teal on cream; `.is-done` → num `--color-accent-soft` bg + teal text + a 10px check glyph; `[aria-disabled="true"]` locked → `opacity:.5`, `cursor:not-allowed`, still focusable, `title="Voltooi stap N eerst"`. Remove `pointer-events:none`.
- A thin 2px progress hairline along the rail's bottom edge (`.stage-rail__progress`, teal, width = done/7) doubles as the "densify on scroll" cue.

### 3.5 Panels & cards (flat paper)

| Class | Recipe |
|---|---|
| `.panel` (stage) | `background:var(--surface-panel); border:var(--hairline); border-radius:var(--radius-md); box-shadow:var(--shadow-1); overflow:clip` |
| `.panel__head` (= `.sec`) | `padding:var(--pad-panel); border-bottom:var(--hairline); display:flex; gap:var(--gap-loose)`; title DM Sans 600 `--fs-lg` `--track-heading`; sub Manrope `--fs-md` `--color-ink-2` max 68ch |
| `.panel__body` | `padding:var(--pad-panel)` — replaces the 10-selector `.panel>.dz,.panel>#s1body…{margin:.95rem}` hack |
| `.card` (= `.mc2`, `.st6-rw-card`, `.st6-bishop-*-card`) | `background:var(--surface-card); border:var(--hairline); border-radius:var(--radius-md); padding:var(--pad-card); box-shadow:none` — hover: none (cards are containers, not buttons) |
| `.card--quiet` (= `.panel-soft` uses, `.st6-help`) | `background:var(--surface-quiet)` |
| `.card--select` (= `.mc`, `.st6-rw-tab`, `.st6-rw-branchcard`) | interactive: `cursor:pointer; transition: border-color, box-shadow, transform var(--motion-base) var(--ease-luxury)`; hover `border-color:var(--color-line-strong); transform:var(--lift-2); box-shadow:var(--shadow-1)`; `[aria-pressed=true]/.is-selected` → `background:var(--surface-active); border-color:var(--color-accent-border); box-shadow: inset 2px 0 0 var(--color-accent)` |
| `.card__eyebrow` (= `.mc2-sec`, `.st6-*-title`, `.ct`) | mono `--fs-xs` 500 uppercase `--track-eyebrow` `--color-accent-text`; bottom hairline optional |
| `.stat` (= `.mi`, `.met`, `.st6-bishop-status-stat`, `.ir-stat`) | quiet card; `.stat__label` mono `--fs-2xs` `--color-ink-3`; `.stat__value` DM Sans 600 `--fs-xl` `tabular-nums`; `.stat__unit` mono `--fs-2xs` `--color-ink-3` after value |

Nesting rule: **card → quiet card → nothing**. Three levels of boxes (e.g. `.st6-bishop-visuals > .st6-bishop-tool-group > .st6-bishop-check`) become card → fieldset with a hairline top.

### 3.6 Accordions (`details.acc`)

`.acc` = `.card` with `padding:0`; `summary.acc__head` `min-height:var(--control-h); padding:var(--sp-2) var(--sp-3); display:flex; gap:var(--sp-2); font: 600 var(--fs-sm) var(--font-body); list-style:none`; chevron is a 14px stroked SVG rotating 90° (`--motion-quick --ease-snappy`), placed **left** (retaining convention) — replace the `'+'/'−'` and `'▸'/'▾'` text markers; `.acc__badge` (pill) right-aligned via `margin-left:auto`. `.acc__body{padding: 0 var(--sp-3) var(--sp-3); border-top:var(--hairline)}`. Unifies `.st6-adv`, `.st6-rw-acc`, `.st6-canvas-mini-details`, `.doc-details`, Bishop legends.

### 3.7 Form fields

- `.field` = `display:grid; gap:var(--sp-1)`; `.field__label` mono `--fs-2xs` uppercase `--track-mono` `--color-ink-3`; `.field__row` = `display:flex; align-items:center; gap:var(--sp-1)`; `.field__unit` mono `--fs-2xs` `--color-ink-3` `min-width:2.2rem`.
- `.input` (number/text/select/textarea): `height:var(--control-h); padding:var(--pad-control); border:var(--hairline-strong); border-radius:var(--radius-sm); background:var(--surface-raised); color:var(--color-ink); font: 400 var(--fs-md)/1 var(--font-body); font-variant-numeric: tabular-nums`. Number inputs **right-aligned** (`.input--num{text-align:right; font-family:var(--font-mono); font-size:var(--fs-sm)}`). Focus: `border-color:var(--color-accent); box-shadow:var(--shadow-focus)` — **no transform** (the `-1px` lift on focus is dropped for inputs; it jitters in 15-column tables). `.input--sm` = `--control-h-sm`, `--fs-xs` (table cells `.ed`, `.st6-rw-layers input`). Override state `.input.is-override` = `border-color:var(--color-warn); color:var(--color-warn); font-style:italic` (keeps the "italic orange" convention engineers know). Mobile: `font-size:16px` to stop iOS zoom (keep the existing rule).
- `select.input`: custom 12px chevron (`background-image` data-URI, `padding-right:1.6rem`, `appearance:none`).
- `.segmented` (= `.togbtn` groups and `.st6-rw-seg`, `.st6-analysis-tabs`): `display:inline-flex; padding:2px; gap:2px; border:var(--hairline-strong); border-radius:var(--radius-sm); background:var(--surface-quiet)`; `.segmented__btn{height:calc(var(--control-h) - 4px); padding:0 var(--sp-3); border-radius:2px; font: 600 var(--fs-xs) var(--font-body); text-transform:uppercase; letter-spacing:var(--track-mono); color:var(--color-ink-2)}`; `[aria-pressed=true]` → `background:var(--surface-raised); color:var(--color-accent-text); box-shadow: var(--shadow-1), inset 0 0 0 1px var(--color-accent-border)`. Use `role="radiogroup"`.
- `.check` (checkbox/radio): native input `accent-color:var(--color-accent); width:0.95rem; height:0.95rem`; label `--fs-sm` `--color-ink-2`; hit area ≥ `--control-h` via padding. `.switch` for boolean display toggles (Bishop "show …" options): 1.6rem × 0.95rem track radius-round, thumb 0.75rem, teal when on — the *only* legitimate use of `--radius-round` on a control.
- `.range`: native with `accent-color`; paired numeric `.input--num` mandatory (already the pattern).

### 3.8 Buttons

`.btn` base: `height:var(--control-h); padding:0 var(--sp-4); border:var(--hairline-strong); border-radius:var(--radius-sm); background:transparent; color:var(--color-ink); font: 600 var(--fs-xs)/1 var(--font-body); text-transform:uppercase; letter-spacing:var(--track-mono); gap:var(--sp-2); position:relative; isolation:isolate; overflow:hidden; transition: background-color, border-color, color, box-shadow var(--transition-base), transform var(--motion-quick) var(--ease-luxury)`. Hover: `border-color:var(--color-ink); background:var(--surface-hover); transform:var(--lift-1)`. Sheen sweep `::before` kept **only on `.btn--primary` and `.btn` (default)** — not on `--ghost`, `--icon`, `--sm` (the madep rule: "primary commands, not every tiny icon button").

| Variant | Recipe |
|---|---|
| `.btn--primary` (= `.pri`) | `background:var(--color-ink); border-color:var(--color-ink); color:var(--color-bg)`; hover `background:var(--color-bg-darker); box-shadow:var(--shadow-1)`. Dark theme: bone on ink inverted automatically via tokens |
| `.btn--accent` | teal fill for the one "Run/Compute" action per panel: `background:var(--color-accent); color:#F7F4EF`; hover `--color-accent-hover` |
| `.btn--ghost` | no border; hover wash; for toolbars |
| `.btn--icon` | `width:var(--control-h); padding:0`; svg 16px stroke 1.5 |
| `.btn--sm` (= `.sm`, `.btn--compact`, `.st6-rw-copy`) | `height:var(--control-h-sm); padding:0 var(--sp-3); font-size:var(--fs-2xs)` |
| `.btn--danger` | `color:var(--color-bad); border-color:var(--color-bad-border)`; hover `background:var(--color-bad-soft)` |
| `.btn[disabled]` | `opacity:.5; pointer-events:none` (present in report page; make global) |
| `.btn.is-busy` | 1px teal indeterminate wipe along the bottom edge (`::after`, `--motion-reveal` loop) instead of a spinner |

Touch: `@media (pointer:coarse){ .btn, .input, .segmented__btn { min-height: var(--touch-min) } }`.

### 3.9 Badges / pills / status

`.pill`: `display:inline-flex; align-items:center; gap:.35em; height:1.25rem; padding:0 .45rem; border:1px solid; border-radius:var(--radius-sm); font: 500 var(--fs-2xs)/1 var(--font-mono); text-transform:uppercase; letter-spacing:var(--track-mono)`. Tones: `--good` (`good-soft`/`good-border`/`color-good`), `--warn`, `--bad`, `--info` (accent), `--neutral`. A leading 6px dot `::before` in the tone colour makes the state legible without colour (plus the text — never colour alone). Unifies `.sb` (soil badge — keeps its soil fills but adopts the geometry), `.st6-rw-pill`, `.st6-rw-badge`, `.st6-bishop-source-pill`, `.cpt-tab__status`, `.st6-bishop-region-legend-count`. Replace all `border-radius:999px` on these.

### 3.10 Tables

One recipe, `table.tbl` (+ `.tbl-wrap{overflow:auto; border:var(--hairline); border-radius:var(--radius-md); background:var(--surface-card)}`):

- `th`: `position:sticky; top:0; z-index:var(--z-sticky-cell); background:var(--color-bg-alt); font: 500 var(--fs-2xs)/1.3 var(--font-mono); text-transform:uppercase; letter-spacing:var(--track-mono); color:var(--color-ink-3); padding:var(--sp-2) var(--sp-3); border-bottom:var(--hairline-strong); text-align:left` — numeric headers `th.num{text-align:right}`.
- `td`: `padding:var(--sp-2) var(--sp-3); border-bottom:var(--hairline); font-size:var(--fs-sm); vertical-align:middle`; `td.num{ text-align:right; font-family:var(--font-mono); font-variant-numeric:tabular-nums; font-size:var(--fs-xs)}`; `td.key` first-column label `--color-ink-2`.
- Row states: hover `background:var(--surface-hover)`; `.is-selected`/`.gov` (governing) `background:var(--surface-active); box-shadow:inset 2px 0 0 var(--color-accent)`; `.is-fail td{color:var(--color-bad)}`.
- Modifiers: `.tbl--dense` (td padding `var(--sp-1) var(--sp-2)`, `--fs-xs`) for Bishop materials and retaining layers; `.tbl--kv` (2-col key/value, replaces `.pt`, `.st6-rw-kv`, `.ir-meta`); `.tbl--fixed` (`table-layout:fixed; overflow-wrap:anywhere`) replaces `.st6-audit`. Inline inputs inside cells use `.input--sm` with `width:100%`.
- Mobile (<640px) opt-in `.tbl--stack` renders each row as a card (`display:grid`, `td::before{content:attr(data-label)}` mono label) — for the layer table on phones.

### 3.11 Verdict banners

`.verdict` (= `.st6-rw-verdict`, `.rn-verdict`, `.info`, `.layerwarn`, `.data-note`, `.report-gateway__error`): `display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:var(--sp-3); align-items:center; padding:var(--sp-3) var(--sp-4); border:1px solid; border-left-width:3px; border-radius:var(--radius-sm); font-size:var(--fs-sm); line-height:var(--lh-body)`. `.verdict__tag` = mono 600 `--fs-xs` uppercase tracked (`VOLDOET` / `GRENS` / `VOLDOET NIET` / `INFO`); `.verdict__body` Manrope; `.verdict__meta` mono `--fs-2xs` right (utilisation ratio, γ). Tones `--good/--warn/--bad/--info/--neutral` set soft bg + border + tag colour. `.verdict--inline` (no left rule, 1px border) is the `.data-note` replacement; `.verdict--hero` for Stage 6 governing results: `--fs-md`, tag `--fs-sm`, plus a utilisation bar (`.meter`: 6px track `--color-bg-alt`, fill tone-coloured, 1px limit mark at 100%).

### 3.12 Tabs

`.tabs` (`role="tablist"`): a hairline-bottomed row; `.tab` = `height:var(--control-h); padding:0 var(--sp-3); font: 600 var(--fs-xs) var(--font-body); text-transform:uppercase; letter-spacing:var(--track-mono); color:var(--color-ink-2); border-bottom:2px solid transparent; margin-bottom:-1px`; `[aria-selected=true]` → `color:var(--color-accent-text); border-bottom-color:var(--color-accent)`; hover → `color:var(--color-ink)`. The sliding underline is a shared `::after` on the container positioned via `--tab-x/--tab-w` set from JS (`--motion-base --ease-luxury`); acceptable to skip in the string-rendered phase. Replaces `.st6-rw-rtab` (folder tabs), `.st6-rw-tabs` (5 wall-type cards → becomes `.card--select` grid, not tabs), `.st6-analysis-tabs` (→ `.segmented`), `.app-switch/.app-chip` (→ `.tabs.tabs--icon` with 18px icons, radius 3, no pills).

### 3.13 Charts & canvases

- Container `.viz` (= `.cc`, `.col-card`, `.st6-bishop-canvas`, `.st6-rw-canvaswrap`, `.st6-rw-chart`, `.st6-pile-chart__cv`): `border:var(--hairline-strong); border-radius:var(--radius-md); background: linear-gradient(var(--canvas-grid) 1px,transparent 1px), linear-gradient(90deg,var(--canvas-grid) 1px,transparent 1px), var(--canvas-paper); background-size:2rem 2rem; box-shadow:var(--shadow-1); overflow:clip; position:relative; contain: layout paint`. `.viz__title` = `.card__eyebrow`. `.viz__legend` bottom-left, `.viz__readout` bottom-right: small `.glass--sm` chips (mono `--fs-2xs`).
- Series colour assignment (JS constants → tokens): qc `--viz-1`, fs `--viz-2`, Rf `--viz-3`, u2/water `--viz-water`, limits/failure `--viz-4`, accepted/fitted `--viz-6`, excluded `--viz-neutral` @ .6. Chart.js grid `--viz-grid`, ticks `--viz-text-muted` in `--font-mono` 10px, tooltip `--viz-tooltip-bg` with `--glass-hairline` border. De Beer curves: qc `--viz-neutral`, qh `--viz-2` dashed, qd `--viz-3`, qu `--viz-5`, qp `--viz-6` — replaces the `rgba(216,90,48)/(40,90,180)/(29,158,117)` set. Pile/retaining canvases: soil fills from `--soil-*` at 0.85, hatch strokes `--viz-axis`, wall `--viz-2`, anchors `--viz-3`, water `--viz-water`, dimension lines `--viz-neutral`, handles `--viz-1` (fill `--canvas-paper`), moment/shear overlays `--viz-1`/`--viz-4`.
- Theme re-read: canvases must subscribe to theme changes (§3.14 helper emits `madep:theme`), re-read tokens and re-render; today they read once.

### 3.14 Token resolver for canvases (`src/lib/styles/theme.ts`)

```ts
const probe = document.createElement('span'); probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
document.body.append(probe);
export function token(name: string): string {           // resolves color-mix()/light-dark()/var() to an rgb() string
  probe.style.color = `var(${name})`;
  return getComputedStyle(probe).color;
}
export function vizTheme() { return { s1: token('--viz-1'), s2: token('--viz-2'), s3: token('--viz-3'), s4: token('--viz-4'), s5: token('--viz-5'), s6: token('--viz-6'),
  grid: token('--viz-grid'), gridStrong: token('--viz-grid-strong'), axis: token('--viz-axis'), text: token('--viz-text'), textMuted: token('--viz-text-muted'),
  halo: token('--viz-halo'), band: token('--viz-band'), tooltipBg: token('--viz-tooltip-bg'), paper: token('--canvas-paper'), water: token('--viz-water') }; }
export function setTheme(t: 'light'|'dark'|'system') { t === 'system' ? delete document.documentElement.dataset.theme : document.documentElement.dataset.theme = t;
  localStorage.setItem('madep-theme', t); window.dispatchEvent(new CustomEvent('madep:theme')); }
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => window.dispatchEvent(new CustomEvent('madep:theme')));
```
Reading via `probe.style.color` resolves any token form, so `--viz-*` *could* use `color-mix()` — keep them literal anyway (rule b) for `report-svg.js` string templates and for the print path.

### 3.15 Modals, toasts, tooltips, empty states

- **Modal**: `.glass-scrim` + `.glass-sheet.modal{width:min(720px, calc(100vw - 2*var(--sp-6))); max-height:min(84vh,860px); display:grid; grid-template-rows:auto minmax(0,1fr) auto}`; `.modal__head` (title DM Sans 600 `--fs-lg`, mono file/meta line, close `.btn--icon`), `.modal__body{overflow:auto; padding:var(--pad-panel)}`, `.modal__foot` hairline-top, right-aligned actions. Use `<dialog>` + `showModal()` for focus trap and `Esc`; enter `translateY(10px) scale(.985)→none` `--motion-base --ease-luxury`, scrim fade `--motion-quick`. The import-review modal migrates first (it already has this anatomy).
- **Toast** (new — replaces `alert()`): `.toast-region{position:fixed; inset:auto var(--sp-4) calc(var(--sp-4) + env(safe-area-inset-bottom)) auto; z-index:var(--z-toast); display:grid; gap:var(--sp-2)}`; `.toast` = `.glass--strong` (radius `--radius-md`, `padding:var(--sp-3) var(--sp-4)`, `max-width:24rem`, `display:grid; grid-template-columns:auto 1fr auto`), tone dot + mono tag + body `--fs-sm`, auto-dismiss 6s (errors persist), `role="status"` / `role="alert"`. `window.alert` calls become `toast.error(msg)`; import errors accumulate into one toast with a count.
- **Tooltip**: `.tip` — `.glass--strong` at `--radius-sm`, `padding:var(--sp-2) var(--sp-3)`, `--fs-xs`, `max-width:18rem`, `z-index:var(--z-tooltip)`; dark-on-light in both themes (drop the forced dark `rgba(17,17,16,.96)` box — on the dark top bar use `.tip--on-dark`). Delay 300ms in, 0 out; positioned by a tiny JS helper (`data-tip` attribute stays the API).
- **Empty state** `.empty`: centred, `padding:var(--sp-10) var(--sp-6)`, 32px stroked icon in `--color-ink-4`, DM Sans 600 `--fs-base` title, Manrope `--fs-sm` `--color-ink-2` body ≤ 40ch, optional `.btn--sm` action ("Laad demo"). Dropzone `.dz` is `.empty` + dashed `--color-line-strong` border on `--surface-card`; drag → `--color-accent-border` + `--surface-active`.
- **Popover / view menu** (Bishop): `.glass-float` at `--radius-lg`; collapsed = 34px `.btn--icon` on glass.

### 3.16 Print / report styles

- The report routes keep their own `--rpt-*` ink scale (already print-clean). Add `src/lib/styles/print.css` (layer `base`) loaded globally: `@page{size:A4; margin:16mm 14mm 18mm}`; `@media print { .app-header,.stage-rail,.toast-region,.glass-scrim,.no-print{display:none!important} .panel,.card{background:#fff;box-shadow:none;border-color:#999;break-inside:avoid} canvas{max-width:100%} }` so Ctrl-P on the app page yields the active panel only.
- The rekennota (`/report/retaining`) must stay: white paper, 8pt Manrope, mono 6–7.5pt uppercase running head/foot, verdicts as **text + colour** (`.rn-verdict.ok/.bad` keep their `rgba` soft fills with `print-color-adjust:exact`), tables with hairline rules only, `break-inside:avoid` on rows. Only change: alias `--rpt-*` to the new tokens (`--rpt-ink: var(--color-ink)` is wrong for dark — keep the report **fixed light** by defining `--rpt-*` literally as today).
- Report toolbar (`.report-toolbar`) adopts `.btn` + `.segmented`; on screen the sheet keeps its `0 18px 48px` paper shadow (it is paper, not glass).

---

## 4. Performance and accessibility

### 4.1 What `backdrop-filter` actually costs here

A blurred element forces the compositor to (1) promote the element to its own layer, (2) rasterise **everything behind it** into a texture, (3) run a separable Gaussian blur (cost ∝ area × radius) and a colour-matrix pass for `saturate()`, (4) re-composite — **every frame that anything underneath changes**. On the CPT app the "anything underneath" is:

- Stage 1: three Chart.js canvases (380 px tall each) re-rendered on hover (tooltips) and on slider drag (water table);
- Stage 6 Bishop: a 560 px `<canvas>` redrawn per animation frame during searches, plus the glass dock/card/sheet **on top of it** (`.st6-canvas-shell`), plus tooltips on the dock that carry a *second* blur (`.st6-canvas-tool-btn` has its own `backdrop-filter: blur(12px)` — blur-in-blur, legacy.css ~1075);
- Retaining: a 440 px canvas redrawn on every handle drag + four result charts;
- the 15-column layer table with 60+ rows scrolling under the sticky rail.

Measured rule of thumb (Chromium, integrated GPU, 2× DPR): a full-width 4 rem bar at `blur(14px)` ≈ 0.4–0.8 ms/frame; a 340×500 card at `blur(18px)` over a live canvas ≈ 1–2 ms; every *nested* blur roughly doubles that region's cost. Budget: **≤ 3 ms of compositor time on the worst page** (Stage 6 Bishop with the dock, card, view menu and a tooltip open).

**Layering rules (enforced by the class model in §3.2):**

1. **Blur only on the four surface classes.** Panels, cards, accordions, tables, inputs, chips, tooltips inside a glass card: never. `.glass .control` and `.glass-float .glass-float` get a *wash* (semi-opaque tint), not a second `backdrop-filter`. Delete the `blur(12px)` on `.st6-canvas-tool-btn`, `.st6-canvas-card-close`, `.st6-canvas-card-section` (`blur(10px)`), `.st6-canvas-card-note` (`blur(10px)`).
2. **Isolate the blurred region.** Every glass surface has `isolation:isolate; contain:paint` so its backdrop capture is bounded to its own box and the canvas can stay in a separate layer (`.viz{contain:layout paint}`).
3. **Blur must not intersect an animating canvas while it animates.** During a Bishop search / handle drag, add `.is-computing` on the canvas stage → glass children switch to `--glass-bg-strong` and `backdrop-filter:none` (`.is-computing .glass-float{backdrop-filter:none;background:var(--glass-bg-strong)}`), restored at idle. Result: 0 ms blur cost precisely when the GPU is busiest, and the engineer sees a solid (not flickering) inspector.
4. **Sticky header + rail are the only page-scroll blurs.** They overlap at most the top 7.25 rem; keep the rail at `blur(14px)`, never 18. On `< 900px` (where they become `position:static` today) drop blur entirely (`@media (max-width:900px){.glass-rail{backdrop-filter:none;background:var(--glass-fallback)}}`).
5. **No blur on scroll containers or table rows** (`.st6-rw-layers thead th{position:sticky}` uses a solid `--color-bg-alt`, not glass — geon's blurred sticky `th` is explicitly *not* adopted).
6. **Never animate `backdrop-filter`** except the one-shot "settle" on modal open (24→18 px, 320 ms) — and skip it under reduced-motion. Never animate `box-shadow` on glass (repaints the blur); animate `transform`/`opacity` only.
7. `will-change` only inside an active animation (Svelte action / `animationstart`/`animationend` in the monolith), never as a static declaration — permanent layer promotion of 27 canvases would blow the GPU memory budget on laptops.
8. Modals: the **scrim** carries the blur (6 px, once), the sheet is 93% opaque (gis rule) — a full-content dialog over Stage 6 stays legible and cheap.

**How to measure (add to the PR checklist):**

- Chrome DevTools → Performance, 6× CPU throttle, record 5 s of: Stage 1 slider drag; Stage 6 Bishop search with dock + card open; retaining handle drag. Look at the "Rasterize Paint"/"Composite Layers" tracks; the frame budget line must stay under 16.7 ms and there must be no purple "Layout" spikes from glass (there shouldn't be any — glass is paint-only).
- Layers panel: count layers with `backdrop-filter`; expected ≤ 5 on any page (header, rail, dock, card, one popover).
- `chrome://gpu` memory: before/after < +40 MB on Stage 6.
- Automated smoke: Playwright `page.evaluate(() => performance.measure)` around `stage6BishopRun` plus `requestAnimationFrame` counting — assert ≥ 50 fps median during a 2 s search with overlays open (Chromium headless with `--use-gl=angle` gives comparable numbers).
- Real devices: one 2019 Intel MacBook Air, one mid-range Android (Chrome), one iPad — iOS Safari is the slowest at `backdrop-filter`; if it drops frames, the one-time probe below flips reduced transparency for the session.

```ts
// boot probe (theme.ts): 300 ms of rAF while a test glass element animates; < 45 fps → data-transparency="reduce"
```

### 4.2 Contrast on glass (WCAG 2.2 AA)

Glass has no fixed background, so contrast must be computed against the **worst plausible backdrop** — for the light glass float that is the darkest soil fill or canvas line it can sit over; for dark chrome it is the cream page.

| Surface | Backdrop assumed | Text | Ratio | Verdict |
|---|---|---|---|---|
| Paper `#F7F4EF` | — | ink `#18181A` | 15.9:1 | AAA |
| Paper | — | ink-2 `#4A4A52` | 8.4:1 | AAA |
| Paper | — | **ink-3 `#65656D`** | 5.0:1 | AA (replaces `#888890` = 3.0:1 ✗) |
| Paper | — | accent-text `#2E5150` | 7.6:1 | AAA |
| Paper | — | good `#2E6F55` / warn `#8A620D` / bad `#9B3A32` | 5.6 / 5.4 / 6.9 | AA |
| Light glass float (`--glass-bg` 66% bone-white) over `--soil-clay #AFA9EC` (darkest soil at 0.85) | composite ≈ `#E4E2E6` | ink | 13.1:1 | AAA |
| same | ink-3 | 4.3:1 | **fails AA for small text** → use `--glass-bg-strong` (86%) for cards containing muted text over soil/region fills: composite ≈ `#F0EEEF`, ink-3 = 4.7:1 ✓ |
| Dark chrome `--glass-bg-chrome` (68% of `#131312`) over cream page | composite ≈ `#5A5A57` | on-dark `#EDE9E1` | 5.1:1 | AA — hence the `.is-scrolled` densify to 88% (composite `#242422`, 12.8:1) when content scrolls under it; at rest only the page top (bone) is behind it |
| Dark chrome | on-dark-2 `rgba(237,233,225,.72)` | ≈ 3.9:1 at 68% | **AA only for ≥ 18.5px/bold** → tab labels (`--fs-sm` 600) fail; set `.cpt-tab{color:var(--color-on-dark)}` and use `-2` only for the mono status chips ≥ 11px bold *or* keep chrome ≥ 80% opaque. **Decision: `--glass-alpha-chrome: 0.80`** for the CPT top bar (it always has text tabs, unlike madep.be's 4-link header). |
| Dark theme paper `#111110` | — | ink `#EDE9E1` / ink-2 `#BCB6AC` / ink-3 `#9A948A` | 15.6 / 9.5 / 6.1 | AA+ |
| Dark theme | accent `#6FA9A8` | 7.4:1 | AA+ (gis's `#4f8584` is 3.9:1 — too low for body text, fine for 3:1 UI) |

Rules: (a) muted text (`--color-ink-3`) is allowed on paper and on `--glass-bg-strong`, **not** on `--glass-bg`; (b) status is never colour-only — every pill/verdict carries a mono tag word and a dot; (c) focus rings and control borders need 3:1 against adjacent colours — teal `#3D6B6A` on bone is 4.5:1 ✓, on dark chrome 2.6:1 ✗ → chrome controls use `--color-on-dark` outlines; (d) canvases: axis text `--viz-text-muted` with `--viz-halo` stroke (already the `.pile-text-haloed` technique) so labels survive any fill.

Verification: a `scripts/verify_contrast.mjs` that composites glass tokens over the soil/region palettes with the alpha formula and asserts the table above (same style as the existing `verify_*.mjs` scripts); run in CI.

### 4.3 Media queries and user preferences

```css
@media (prefers-reduced-motion: reduce)        /* tokens zero durations; sheen/lift off; count-ups render final value */
@media (prefers-reduced-transparency: reduce)  /* glass → --glass-fallback, blur 0, scrim darker */
@supports not (backdrop-filter: blur(1px))     /* same as above */
@media (prefers-contrast: more)                /* --color-line → .28, --glass-alpha → .92, focus outline 3px */
@media (forced-colors: active)                 /* glass → Canvas/CanvasText, borders → CanvasText, remove box-shadow rings; pills keep text tags */
@media (pointer: coarse)                       /* control min-height 2.75rem, no hover lifts, press scale(.97) */
@media print                                   /* §3.16 */
```
All four preference states are also exposed as in-app toggles under the ⚙ menu (`data-theme`, `data-transparency`, `data-motion`, `data-density`) — engineers on projector/site laptops need them regardless of OS settings, and Playwright can set them deterministically.

### 4.4 Keyboard and screen-reader contract

- **Focus ring**: global `:focus-visible{outline:2px solid var(--color-accent); outline-offset:2px; border-radius:inherit}`; on glass and dark chrome `box-shadow: 0 0 0 2px var(--surface-page), 0 0 0 4px var(--color-accent)` (two-tone, always visible). Remove every `outline:none` (`#projName`, `.st6-tip:focus`, zoom-style buttons) and the stray blue ring on `.st6-canvas-capture`.
- **Stage rail** = `nav > ol > li > button` with `aria-current="step"`; locked steps `aria-disabled="true"` (focusable, announces "Voltooi stap 2 eerst" via `aria-describedby`), never `pointer-events:none`. Arrow keys move between stages (roving tabindex).
- **Segmented controls** = `role="radiogroup"` + `role="radio" aria-checked`; **tabs** = `role="tablist"/"tab"/"tabpanel"` with `aria-controls` (retaining result tabs already have the DOM, add the roles); arrow-key navigation via one shared `keydown` delegate in the controller.
- **Cards that select** (`.mc`, wall-type cards) = `button` elements, not `div[role=button]` + keydown shims (the Stage 2 markup has six copies of the Enter/Space handler).
- **Modals**: `<dialog>` + `showModal()` gives focus trap, `Esc`, `inert` background for free; `aria-labelledby` the title. Toasts: `role="status"` (`aria-live="polite"`); errors `role="alert"`.
- **Tooltips**: `data-tip` content mirrored to `aria-describedby` on a hidden span; show on focus as well as hover (already true for `.st6-tip`, make it true for the dock).
- **Canvases**: keep `aria-label` + fallback text (present on Stage 1), add a visually-hidden data table (`.sr-only`) or a "Copy data" action next to every result chart so values are reachable without vision; Bishop/retaining canvases get `role="img"` + `aria-label` summarising the governing result and are `tabindex="0"` with keyboard handle nudging (arrow keys ± step) — the drag-only embedment handle is the one keyboard-inaccessible input in the app today.
- **Tables**: `<th scope="col">`, numeric cells `class="num"`; sticky headers keep `z-index:var(--z-sticky-cell)` below overlays.
- **Colour independence**: override inputs are italic **and** carry `aria-description="handmatige override"`; verdict tags are words.
- **Language**: `<html lang="nl">` but most UI copy is English/Dutch mixed — mark English fragments with `lang="en"` where they are sentences (screen-reader pronunciation), and decide a UI language in the copy pass of phase 3.
- **Skip link** stays; add a second target `#stage-content` that moves with the active panel.
- Target sizes: 24×24 CSS px minimum everywhere (WCAG 2.2 2.5.8); `.cpt-tab__remove` is 1.3 rem = 20.8 px → 24 px; `.st6-tip` 16 px → keep visual 16 px but pad the hit area to 24.

### 4.5 Legibility on canvases in dark mode

Today dark mode paints charts on `--canvas-bg #181816` with `--chart-*` read once. Rules: text `--viz-text` with `--viz-halo` (`rgba(8,8,7,.92)`) stroke 3 px; gridlines `--viz-grid` never below 0.12 alpha on dark; series colours are the *dark* ladder (`#86C0BF`, `#EDE9E1`, `#C99961`, `#D2776E`, `#7FAAD0`, `#9CBF8E`) — each ≥ 4.5:1 on `#181816`; soil fills stay light pastels at 0.85 with ink labels + halo (pastel over dark reads fine and matches the printed rekennota).

---

## 5. Migration approach — coexisting with HTML-string rendering

### 5.0 Constraints that shape the plan

- `legacy-controller.js` (18 503 lines) renders HTML strings with 548 inline styles and `onclick="fn()"` globals; the retaining module injects its own `<style>`; Svelte owns only the shell, the six stage skeletons and the report routes. Any plan that requires touching markup first will stall — **so the palette and glass must land through the cascade, not through the DOM.**
- The `verify:*` Node scripts and the Playwright spec (`tests/e2e/retaining-walls.spec.mjs`) are the safety net; there are no screenshot baselines yet.
- The rekennota routes are print-critical and must not change visually except through token aliases.

### 5.1 Cascade architecture

`src/app.css` becomes the single entry that declares layer order **first** (an unlayered rule beats every layered one, so order matters):

```css
/* src/app.css */
@layer tokens, base, legacy, components, utilities;
@import './lib/styles/tokens.css'  layer(tokens);
@import './lib/styles/base.css'    layer(base);      /* @font-face, reset, html/body, focus, skip-link, print */
@import './lib/cpt-app/legacy.css' layer(legacy);    /* unchanged file, now demoted */
@import './lib/styles/glass.css'   layer(components);
@import './lib/styles/components.css' layer(components);
@import './lib/styles/utilities.css'  layer(utilities);
```

Consequences: (1) every new `.card`, `.btn--primary`, `.tbl` rule in `components` **wins over legacy** regardless of specificity, even against `legacy.css`'s `!important`-free attribute hacks — because layer order trumps specificity; (2) `legacy.css`'s own `!important`s (12) still win over layered rules — those are removed in phase 2; (3) inline `style=""` attributes still win over everything — those are removed per stage in phase 3; (4) `retaining-styles.js`'s injected `<style>` is unlayered → it would beat `components`. Fix in phase 1: wrap the injected string in `@layer legacy { … }` (one-line change in `retaining-styles.js`), which is the *only* non-CSS edit phase 1 needs. `CptInterpreterApp.svelte` stops importing `legacy.css` directly (it is imported by `app.css`) and `docs.css` gets the same treatment for the docs routes (`layer(legacy)`).

Svelte component `<style>` blocks compile to unlayered scoped rules — fine, they are the future owners; they should consume tokens only.

### 5.2 Phase plan

**Phase 0 — baselines (½ day).** Before any CSS change: add `tests/visual/*.spec.mjs` with Playwright `toHaveScreenshot()` at 1500×950 and 390×844, light and dark (`page.emulateMedia({colorScheme})`), reduced-motion on, for: `/` empty; Stage 1 after demo load; Stage 2; Stage 3 table; Stage 4 cards; Stage 5; Stage 6 × {bishop with dock+card open, pile, retwall sheetpile + each result tab, soldier pile drivability}; Stratigrafie + Doorsnede phases; import-review modal; `/docs`, `/docs/engineering`; `/report/retaining` (screen) and the same with `page.emulateMedia({media:'print'})` → PDF via `page.pdf()` compared by rasterising page 1. Commit the PNGs under `tests/visual/__screenshots__/`. Mask canvases (`mask:[page.locator('canvas')]`) in the *layout* baselines and add separate *canvas-only* baselines with `maxDiffPixelRatio: 0.02` — chart anti-aliasing differs across GPUs, layout must not. Playwright config gains a `visual` project with `deviceScaleFactor: 1` and `animations: 'disabled'`.

**Phase 1 — token reskin, zero markup change (1–2 days).**
Files: **new** `src/lib/styles/tokens.css` (§3.1), `src/lib/styles/base.css` (move `@font-face` + reset out of `app.css`/`legacy.css`, add print + focus rules), `src/lib/styles/glass.css` (§3.2); **edit** `src/app.css` (layer order + imports), `retaining-styles.js` (`@layer legacy{}` wrap), `legacy.css` (delete lines 1–182 — the old `:root` and dark block — and the reset lines 184–201; nothing else), `+layout.svelte` (unchanged — still imports `app.css`), `app.html` (inline theme script + two `theme-color` metas), `CptInterpreterApp.svelte` (drop the `legacy.css` import).
What changes visually without touching markup: muted text becomes AA; `--nav-bg` → glass rail (blur was already there); `--app-panel-dark` → 80%-glass chrome; `--panel-strong` legends → glass-strong; `--chart-green` → moss so fitted ≠ qc; dark theme gains a toggle. `docs.css` lines 1–29 (its private `--color-*` copy) are deleted so docs pick up the same tokens and dark block. Expected screenshot diff: colour-only; the layout baselines must pass with `maxDiffPixelRatio ≤ 0.01` after re-baselining colours (review each diff by eye once, then accept).
Add `scripts/verify_tokens.mjs`: parses `tokens.css`, asserts every `--*` used in `legacy.css`, `retaining-styles.js`, `docs.css`, `report/**/*.svelte` and `legacy-controller.js` (`var(--…)` in HTML strings) is defined; asserts the dark media block and `[data-theme=dark]` block are identical; runs the contrast table (§4.2). Register as `verify:tokens`.

**Phase 2 — component classes replace legacy selectors, stage by stage (≈ 6 days, one PR per row).**
Each PR: add the component CSS (`components.css`), *edit the HTML-string templates in the controller to use the new classes*, delete the corresponding legacy rules, re-baseline that stage's screenshots, run `verify:*` + e2e.

| PR | Scope | Legacy → component | Files |
|---|---|---|---|
| 2a | Shell | `.app-header`→`.app-header.glass-chrome`, `.nav/.si/.sn`→`.stage-rail.glass-rail/.stage/.stage__num` (+ Stage 7 item), `.btn/.pri/.sm/.btn--compact`→`.btn/--primary/--sm`, `.togbtn`+`.segmented`→`.segmented__btn` | `BannerPhaseShell.svelte`, `StageNav.svelte`, `CptInterpreterApp.svelte`, controller `goS/updateNav` (class names), `components.css` |
| 2b | Stage 1–2 | `.sec`→`.panel__head`, `.dz`→`.empty.dz`, `.mgrid/.mi`→`.stat`, `.ctrl-row/.ctrl-lbl/.ctrl-num`→`.field/.field__label/.input--num`, `.mc`→`.card--select`, `.cc/.col-card/.ct`→`.viz/.viz__title` | `Stage1Load.svelte`, `Stage2Classification.svelte`, controller `renderMeta`, `chart-factories.js` (theme via `vizTheme()`) |
| 2c | Stage 3–5 | `.tbl/.ed/.sb`→`.tbl/.input--sm/.pill`, `.info/.layerwarn/.data-note`→`.verdict`, `.mc2/.mc2-head/.mc2-sec/.pt`→`.card/.card__head/.card__eyebrow/.tbl--kv` | `Stage3/4/5*.svelte`, controller `renderLayers/renderModel/renderTuning` |
| 2d | Stage 6 shell + Bishop | `.app-switch/.app-chip`→`.tabs--icon`, `.st6-adv`→`.acc`, `.st6-help`→`.card--quiet`, `.st6-canvas-*`→`.glass-float/.control/.acc`, legends/view menu→`.glass-float.acc`, `.st6-bishop-source-pill`→`.pill`, remove nested blurs, add `.is-computing` | controller Stage 6 render fns, `stage6-bishop.js` (region tokens), `stage6-canvas-utils.js` |
| 2e | Stage 6 pile + engineering | inline three-column grids → `.cols-3{grid-template-columns:var(--col-side) minmax(0,1fr) var(--col-inspector)}`; charts → `.viz`; De Beer colours → `--viz-*` | controller lines ~3580, 13677–14161; `stage6-pile.js`, `stage6-pile-canvas.js`, `stage6-engineering.js` |
| 2f | Retaining | delete `retaining-styles.js`; `.st6-rw-*` → `.card/.acc/.field/.tbl--dense/.verdict--hero/.tabs/.segmented/.pill/.viz`; charts read `vizTheme()` | `retaining-ui.js`, `retaining-canvas.js`, `retaining-charts.js` |
| 2g | Dialogs + feedback | import-review → `<dialog class="glass-sheet">`; `alert()` → `toast()`; `.st6-tip`/`data-tip` → `.tip` helper | `import-review/modal.js`, new `src/lib/styles/toast.ts`, controller alert call sites |
| 2h | Docs + reports | `docs.css` → tokens + `components` (`.doc-card`, `.docs-link-card`→`.card--select`), delete its hand-made dark block; report toolbars → `.btn/.segmented`; `--rpt-*` untouched | `docs.css`, `DocsHeader.svelte`, `report/**` |

After 2h, `legacy.css` should be < 300 lines (Stage-specific leftovers) and is renamed `legacy-leftovers.css`; the `legacy` layer stays declared so anything missed still works.

**Phase 3 — Svelte re-owns the DOM where it pays (ongoing, per module).** Order by (churn × pain): (1) `StageRail.svelte` + `TopBar.svelte` (real state: active/done/locked from a store; `is-scrolled`; theme toggle); (2) `LayerTable.svelte` (Stage 3: 15 columns, editable cells, override state — the biggest inline-style consumer); (3) `Stage6Retaining/*.svelte` (already modular JS with panels/results — one panel at a time behind the existing `retwallSet` API); (4) `ImportReviewDialog.svelte`; (5) Bishop inspector card. The controller keeps computing; components subscribe to `S` through a thin store (`ui.ts` grows `subscribe()`), and render fns get replaced by `mount()` calls. Every migrated component ships with its own `<style>` using tokens only, and its screenshots move from "stage" to "component" baselines.

**Phase 4 — polish that needs DOM ownership:** sliding tab indicator, teal underline wipe on section titles, count-up on governing values, toast queue, keyboard handle nudging, `<dialog>` everywhere, density toggle.

### 5.3 Verification per phase

| Check | Command | Gate |
|---|---|---|
| Layout screenshots (canvases masked) | `npx playwright test tests/visual --project=visual` | 0 px diff after accepted re-baseline |
| Canvas screenshots | same, `--grep canvas` | `maxDiffPixelRatio 0.02` |
| Print PDF page 1 | `--grep print` | 0 px diff **throughout every phase** (rekennota) |
| Token integrity + contrast | `npm run verify:tokens` | pass |
| Existing behaviour | `npm run verify:retaining && npm run test:e2e` | pass |
| No unlayered app CSS | `verify:tokens` greps built CSS for rules outside `@layer` (except Svelte scoped) | pass |
| Blur count | Playwright: `document.querySelectorAll('*')` filter `getComputedStyle(el).backdropFilter !== 'none'` on Stage 6 with overlays open | ≤ 5 |
| Frame budget | Playwright rAF counter during Bishop search (2 s) | median ≥ 50 fps |
| A11y | `@axe-core/playwright` on each stage, light + dark | 0 serious/critical |
| Type check | `npm run check` | pass |

Manual sign-off per phase: light/dark/reduced-transparency at 1500 px and 390 px; one print of `/report/retaining` and `/report/stage7` to PDF, compared side by side with the phase-0 PDF.

### 5.4 Risks and how the plan handles them

- **Inline styles winning over components** — phase 2 removes them stage by stage; until then the `legacy` layer aliasing keeps them on-palette. Attribute-selector overrides in `legacy.css` (`[style*="grid-template-columns:…"]`) are deleted in 2e together with the inline grids.
- **`getComputedStyle` reading unresolved `color-mix()`** — `--viz-*`/`--canvas-*` are literal (rule b), plus the probe-element `token()` helper resolves anything else.
- **Dark-mode canvases not updating** — `madep:theme` event + `vizTheme()` re-read; a `verify` step toggles `data-theme` in Playwright and asserts the chart's `options.scales.x.grid.color` changed.
- **Retaining `<style>` injection** — wrapped in `@layer legacy` in phase 1, deleted in 2f.
- **Glass over live canvases** — `.is-computing` de-blur (§4.1 rule 3).
- **Print regressions** — PDF page-1 baseline gates every PR.
- **Sticky header + rail heights** — `--toolbar-h` and `--rail-h` are tokens consumed by both CSS (`top:`) and the Bishop view-menu max-height calc; changing the header to the inset floating variant must update the token, not the selectors.

### 5.5 Immediate next actions (this week)

1. Phase 0 baselines PR (`tests/visual/`, Playwright `visual` project, masks).
2. Phase 1 PR: `tokens.css`, `base.css`, `glass.css`, `app.css` layers, `legacy.css` head deletion, `retaining-styles.js` layer wrap, `app.html` theme script, `verify:tokens`.
3. Phase 2a (shell) — the visible "liquid glass" moment: floating dark chrome, glass rail with 7 stages, brand buttons.
