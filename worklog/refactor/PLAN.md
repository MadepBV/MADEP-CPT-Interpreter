# v0.6 → v1.0 — Monolith refactor + liquid-glass UI overhaul: master plan

Branch: `v0.6.0` (from `v0.5.3` @ 462fc50). Owner: main session; work executed by Fable agents per PR.
Inputs (read these first): `01-monolith-map.md` (what the 18,503-line controller is), `02-design-system.md`
(what the UI must become), `03-characterization-tests.md` (how we prove nothing broke). This file is the
sequence, the gates and the division of labour.

## 0. Non-negotiables

1. **Every step ships.** After each PR the app builds, `npm run check` has only the 6 pre-existing errors,
   all `verify:*`, `golden:check`, `test:e2e` and `test:visual` gates are green. No "big bang" merge.
2. **Golden first.** No extraction is started before the golden-master baseline of its inputs/outputs is
   committed (03 §5.1). A pure move must be bit-identical (03 §5.2 rule 6b); an intended behaviour change is
   a separate commit with a `tests/golden/CHANGELOG.md` entry.
3. **Rekennota print stays pixel-identical** through every design phase (02 §5.3 print gate).
4. **The `retaining/` package is the reference style** for every extracted package: pure modules, `defaults()/ensure()`
   state schema, `panels/` + `results/` + `scenes/`, `install<Pkg>(ctx)` returning
   `{ defaults, ensure, renderBody, postRender, handlers, cardMeta }`, Node verifier per package.
5. **One agent, one file set.** Parallel agents never edit the same file; `package.json`, `.gitignore`,
   `playwright.config.mjs` and `src/app.css` are edited by the main session only (agents list needed lines in
   their report). Every agent finishes with a report in `worklog/refactor/NN-*.md`.
6. Accuracy first (numbers, references), no hidden defaults, English UI with Dutch practice terms, note in Dutch.

## 1. Workstreams

| Stream | Source | Deliverable |
|---|---|---|
| **H** Harness | 03 | Node golden tiers A/B (+ D), browser journeys (tier C), CI, refactor protocol |
| **D** Design | 02 | tokens/base/glass layers → component classes per stage → Svelte-owned shell/DOM → polish |
| **R** Refactor | 01 §6 | 16 packages carved out of `legacy-controller.js` in the 10-step strangler order; composition root last |

The streams interleave: H must lead; D and R alternate so that each Stage's markup is edited **once** for the
component classes (D phase 2) at the moment its render code is extracted (R), never twice.

## 2. Sequence (PR by PR)

Status: ☐ planned · ◐ in progress · ☑ merged. Sizes are the reports' estimates.

### Milestone v0.6.0 — foundation (harness, tokens, shell, pure extractions)

| # | PR | Stream | Content | Gate | Status |
|---|---|---|---|---|---|
| 0 | planning reports | — | 01, 02, 03 | — | ☑ |
| 1 | `test(golden): harness + baseline at 462fc50` | H | 03 parts 1, 2, 3, 4-partial (retaining, project-io), 8, 9: `scripts/golden/**`, `tests/golden/**` (fixtures, node goldens, tolerances, README, CHANGELOG), `.github/workflows/ci.yml`, npm scripts `golden:*`, `verify:core`, `test:all` | `golden:check` green twice; `verify:*`, build | ☑ 7a4a7ec + 2f970a3 |
| 2 | `test(visual): Phase 0 screenshot baselines` + `style(tokens): Phase 1 reskin` | D | 02 §5.2 phases 0–1: `tests/visual/*.spec.mjs` (Playwright `visual` project, seeded demo, canvases masked, print-PDF gate), `src/lib/styles/{tokens,base,glass}.css`, `theme.ts`, `src/app.css` layer order, `legacy.css` demoted to `@layer legacy`, retaining `<style>` wrapped, `scripts/verify_tokens.mjs` | print page-1 0 px; other diffs reviewed + re-baselined; `verify:tokens`, e2e | ☑ b6d046f + 7734ce4 |
| 3 | `test(golden): browser journeys (tier C)` | H | 03 §2.3/§4.5: `golden-journey.spec.mjs`, `browser-capture.js`, demo + GEF-import journeys, seeded PRNG init script, Chart.js routed to vendor copy, `golden:browser*` scripts, CI browser job | journeys green twice | ☑ 5bb2030 |
| 4 | `refactor(core): format, dom, css-tokens, chart-host + handler verifier` | R step 1 | 01 §6.2 step 1 (~300 lines) + `scripts/verify_window_handlers.mjs` (every `on*="name("` in HTML strings is published on `legacyApi`) — this also fixes the latent `stage6BishopSetSelectedRegionCoarseness` ReferenceError (separate fix commit) | golden:check, handler verifier | ☑ 5eb544d + 9391124 |
| 5 | `refactor(model-params): hsParams/khParams/stressAt with explicit ctx` | R step 2 | ~500 lines; wrappers keep the monolith names; stratigraphy `S`-swap (160-166) deleted | golden `model/*`, `tuning/*`, stratigraphy verifiers bit-identical | ☑ 9acc3b7 (merged 29573c4) |
| 6 | `refactor(classification, layers): pure compute, render split out` | R step 3 | ~900 lines; `detectLayers` stops calling `renderLayers`; `runClass` becomes a thin render wrapper | golden `classification/*`, `layers/*` | ☑ 01759ec (merged 29573c4) — note: `detectLayers` never rendered; map §2.3/§3.4 corrected by 09 report |
| 7 | `style(shell): Phase 2a liquid-glass chrome + stage rail` | D 2a | 02 §5.2 row 2a: `.app-header.glass-chrome`, `.stage-rail.glass-rail` (7 stages), `.btn` family, segmented — the visible "liquid glass" moment | visual re-baseline (shell only), e2e | ☐ |
| 8 | `refactor(export, report-payload)` | R step 4 | ~1,100 lines; `stage7Capture*` stays until step 9g | golden `exports/*`, `report/*` | ◐ agent |
| 9 | `refactor(load): parsers + apply-parsed-cpt` | R step 5 | ~600 lines; parsers return patches; `controls.js` keeps the 15 DOM syncs | golden fixtures (GEF/CSV/XLSX), `verify_import_review` | ☑ 450b6be (merged 29573c4) |
| 5 | `refactor(model-params): hsParams/khParams/stressAt with explicit ctx` | R step 2 | ~500 lines; wrappers keep the monolith names; stratigraphy `S`-swap (160-166) deleted | golden `model/*`, `tuning/*`, stratigraphy verifiers bit-identical | ☑ 9acc3b7 (integration-r) |
| 6 | `refactor(classification, layers): pure compute, render split out` | R step 3 | ~900 lines; `detectLayers` stops calling `renderLayers`; `runClass` becomes a thin render wrapper | golden `classification/*`, `layers/*` | ☑ 01759ec (integration-r) — note: `detectLayers` never rendered; map §2.3/§3.4 corrected by 09 report |
| 7 | `style(shell): Phase 2a liquid-glass chrome + stage rail` | D 2a | 02 §5.2 row 2a: `.app-header.glass-chrome`, `.stage-rail.glass-rail` (7 stages), `.btn` family, segmented — the visible "liquid glass" moment | visual re-baseline (shell only), e2e | ◐ agent (main tree) |
| 8 | `refactor(export, report-payload)` | R step 4 | ~1,100 lines; `stage7Capture*` stays until step 9g | golden `exports/*`, `report/*` | ☑ 0081510 (integration-r) |
| 9 | `refactor(load): parsers + apply-parsed-cpt` | R step 5 | ~600 lines; parsers return patches; `controls.js` keeps the 15 DOM syncs | golden fixtures (GEF/CSV/XLSX), `verify_import_review` | ☑ 450b6be (integration-r) |
| 10 | `style(stage1-2)` then `style(stage3-5)` | D 2b, 2c | component classes for the Stage 1–5 templates, done **together with** the render wrappers left by PRs 6/9 (edit the markup once) | visual re-baseline per stage; golden DOM text unchanged | ☐ |

### Milestone v0.7.0 — Stage 6 shell and the five small apps

| # | PR | Stream | Content | Gate | Status |
|---|---|---|---|---|---|
| 11 | `refactor(stage6): registry, per-app defaults/ensure, shell render` | R step 6 | ~1,000 lines; `stage6Defaults`/`ensureStage6State`/`renderStage6` kept as façades (78 / 71 callers) | snapshot of `stage6Defaults()` identical; golden stage6-*; e2e | ☑ 78a2e02 (integration-r) |
| 12 | `refactor(bearing, pile, settlement, dewatering, beam)` | R step 7 | ~2,000 lines, one package per app in the retaining style, one PR per app (5 PRs) | headless render diff vs monolith HTML for the demo CPT; golden | ☑ bearing 30fd5a9, pile 1644f16, settlement 5798592, dewatering 26bed2a, beam d0bc5e7 |
| 13 | `style(stage6 shell + apps)` | D 2d (shell parts), 2e | `.tabs--icon`, `.acc`, `.cols-3`, `.viz`, De Beer colours → `--viz-*`, nested blurs removed; done in the same PRs as 12 where the app's markup is touched | visual; blur count ≤ 5; frame budget ≥ 50 fps | ☐ |
| 14 | `refactor(project, section, tuning)` | R step 8 | ~1,000 lines; `S` reassignment behind `setActive()`; `selectCpt` also terminates the deformation worker (bug fix commit) | `verify_project_io`, golden save-load journey | ☑ b2c3844 + fix 504abef (integration-r) |
| 15 | `style(retaining): delete retaining-styles.js, use component classes` | D 2f | `.st6-rw-*` → `.card/.acc/.field/.tbl--dense/.verdict--hero/.tabs/.segmented/.pill/.viz`; charts read `vizTheme()` | visual; retaining e2e; rekennota print 0 px | ☐ |
| 16 | `style(dialogs, feedback)` | D 2g | `<dialog class="glass-sheet">` for import-review, `toast()` replaces the 20 `alert()`s, `.tip` helper | visual; e2e | ☐ |

### Milestone v0.8.0 — Seep/Slope (56 % of the file)

| # | PR | Stream | Content | Gate | Status |
|---|---|---|---|---|---|
| 17 | golden tier A solver suites + seep-slope journey | H parts 5, 7 | bishop / seepage / deformation suites, `seep-slope-journey`, `multi-cpt-journey`, `save-load-journey` | green twice | ◐ agent |
| 18a–g | `refactor(seepslope): …` | R step 9 | 9a state+ensure+migrations · 9b soil-model sync/invalidate (canvas draw stops mutating state) · 9c runs/workers return patches · 9d geometry + line probe · 9e canvas (viewport/snap/pointer, then `draw/*`) · 9f panels one `data-st6details` group at a time + tool rail (view-model for the 2,392-line `renderStage6BishopApp`) · 9g `report/capture.js` without app switching | golden bishop/seepage/deformation within 1e-6, iteration counts exact; journeys; frame budget | ☐ |
| 19 | `style(seepslope)` | D 2d (rest) | canvas shell `.glass-float`, legends/view menu `.glass-float.acc`, `.is-computing` de-blur | visual; blur count; fps | ☐ |

### Milestone v0.9.0 — composition root and Svelte ownership

| # | PR | Stream | Content | Gate | Status |
|---|---|---|---|---|---|
| 20 | `refactor(host): composition root` | R step 10 | delete `legacyApi`, per-package `handlers`, typed `ctx`, no module-load side effects, `#bishop` hash into `project/phase.js` | all gates; new smoke spec through all 7 stages | ☐ |
| 21 | `style(docs, reports)` | D 2h | `docs.css` on tokens + components, report toolbars; `--rpt-*` untouched | print gates; visual | ☐ |
| 22 | `feat(ui): Svelte re-owns shell + tables` | D phase 3 | `StageRail.svelte`, `TopBar.svelte` (store-driven state, theme toggle), `LayerTable.svelte`, then per churn × pain | visual; a11y (axe) 0 serious | ☐ |
| 23 | `feat(ui): polish` | D phase 4 | sliding tab indicator, count-up governing values, toast queue, keyboard handle nudging, `<dialog>` everywhere, density toggle | visual; a11y | ☐ |

v1.0.0 = 23 merged, `legacy-controller.js` gone, `legacy-leftovers.css` < 300 lines, CI green on every PR.

## 3. Division of labour (Fable agents)

- **Main session**: sequencing, `package.json`/config edits, code review of every agent PR against the gates,
  commits, pushes, this file's status column, `PROGRESS.md`.
- **Agent per PR**, briefed with: the report sections that specify it, the exact file set it owns, the gates to
  run, "do not commit", and the report file to write. Parallelism rules: H-stream and D-stream agents may run
  concurrently with an R-stream agent only when their file sets are disjoint (e.g. PR 3 ∥ PR 4 ∥ PR 7 is fine;
  PR 10 must wait for 6 and 9).
- **Review checklist** (main session, before commit): gates green locally; diff limited to the owned file set; no
  behaviour change hidden in a "pure move" (golden bit-identical); new pure functions got a tier-A case; report written.

## 4. Known defects to fix in dedicated commits (found by the mapping)

1. `stage6BishopSetSelectedRegionCoarseness` called from HTML strings but not published → `ReferenceError` on
   region-coarseness edits (fix in PR 4 with the handler verifier).
2. `selectCpt` does not terminate the deformation worker; a switch mid-run leaves `progress.running = true` on the
   originating CPT (fix in PR 14).
3. `stage6BishopDrawCanvas` mutates state (`stage6BishopSyncSoilModel` on every frame) (fixed by 18b).
4. Muted text `#888890` fails WCAG AA (fixed by PR 2 tokens).
5. `dewatering.aquiferBaseDepth`: typing a value stores a string (null default) → `.toFixed` TypeError on every later dewatering render (found by PR 12c; locked as-is in its verifier — fix as a behaviour commit with a golden case).

## 5. Status log

- 2026-08-29 — reports 01/02/03 done; PR 1 merged (7a4a7ec, 2f970a3; 1 619 goldens, 29 s); PR 3 (5bb2030), PR 4 (5eb544d + fix 9391124) on v0.6.0. PR 5/6/9 merged on `integration-r` (controller 16 914 lines), waiting for PR 2 (design 0–1, main tree) before fast-forwarding v0.6.0. PR 8 and PR 11 started in worktrees.
- 2026-08-29 (evening) — PR 2 merged (b6d046f visual project, 7734ce4 Phase 1 tokens; 126 baselines); integration-r merged into v0.6.0 (29573c4): controller 16 914 lines, packages core/ model-params/ classification/ layers/ load/. PR 8 and PR 11 in worktrees; PR 7 (design 2a shell) next on the main tree.
- 2026-08-29 (late) — PR 7 shell restyle committed on v0.6.0 after gates; PR 12c / PR 17 agents lost to the session limit — to relaunch. Drivability push-in + data-sheet simplification + note error reporting landed on both v0.6.0 and v0.5.3.
- 2026-08-29 (night) — integration-r 070ed7e: PR 8, 11, 12a merged; controller 14 417 lines. PR 12b/12c/14 in worktrees, PR 7 on the main tree.
- 2026-08-29 (night) — integration-r: PR 14 and PR 12b merged; controller 13 301 lines; pile shims removed.
- 2026-08-29 (late) — PR 12c merged (controller 12 192 lines). Known defect logged: dewatering.aquiferBaseDepth string → TypeError on render (fix as behaviour commit). PR 17 agent running.
