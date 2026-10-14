# Golden changelog

Every intentional golden update: date, commit, suite — reason — affected cases. CI requires an entry
here whenever `tests/golden/**` changes in a pull request.

## 2026-10-14 — bearing depth-factor toggle, strict Annex D default (v0.6.0)

`stage6.bearing.depthFactors` added (`'none'` default = EN 1997-1:2004 Annex D, every d = 1; `'hansen'` = the
previous Brinch Hansen / Vesić embedment factors, now opt-in). Review: `worklog/06-bearing-eurocode-annex-d-review.md`.
Node tier, 95 cases rewritten with `golden:update`: `stage6-bearing` (56: every analysis / at-depth / config / dom —
d_q, d_c, d_cu → 1, lower q_ult / q_d, new `depthMode` / `depthModeLabel` keys, the new "Depth factors" select,
shape-factor label "Brinch Hansen / Annex D" → "EN 1997-1 Annex D"), `stage6-shared` (4: the new default key),
`project-io` (12: snapshot carries the key; byte counts), `exports` (9: saveProject snapshot), `report` (7: bearing
annex digests), `chart-configs` (7: bearing chart axis max follows the lower resistance). Browser tier (`GOLDEN_MODE=update`): every `*.state.json` / `*-saveproject.json` / report payload of the five journeys
(the new `bearing.depthFactors` key), the bearing and report DOMs of `demo-journey` / `gef-import-journey`, and only the
`07-bearing.png` / `12-report.png` screenshots of those two journeys; the other screenshots differed by local Chromium
rendering alone (soft signal) and were restored. Check mode green twice.

## 2026-08-29 — baseline

- Baseline characterization of branch `v0.6.0` at HEAD `462fc50` (unmodified app source). 1 619 Node-tier
  cases over 15 suites recorded with `npm run golden:record`; `npm run golden:check` green twice.
- Fixtures generated with seed 20260829 (`fixtures/manifest.json`); Chart.js 4.4.1 vendored; WASM pinned.
- Browser tier (Tier C) baseline: `browser/demo-journey` (63 steps) and `browser/gef-import-journey`
  (64 steps) recorded with `GOLDEN_MODE=record`, check green twice (macOS Chromium; PNGs are a soft
  signal off-CI). `normalize.mjs` gained the `<n> ms` substring mask; `tolerances.json#browser` gained
  `maxDiffPixelRatio: 0.02` (screenshots only — numeric tolerances unchanged).

## 2026-08-29 — PR 17 solver suites and remaining journeys (v0.6.0, on 07f0645)

New Node-tier suites recorded (no existing golden changed): `stratigraphy` (67), `report-svg` (48),
`chart-configs` (203), `bishop` (71), `seepage` (41), `deformation` (37) — 467 cases, tolerance class
`iterative` for the three solvers. New browser journeys recorded: `seep-slope-journey`,
`multi-cpt-journey`, `save-load-journey`. Fixtures: `models/seepage-*.json`, `models/deformation-*.json`
added (lifted from the verify scripts by `make-fixtures.mjs` via `scripts/golden/lib/solver-models.mjs`);
`projects/single-layered.madep.json` and `projects/multi-3cpt.madep.json` regenerated — they now carry the
drivability defaults (`drivability.push`, `vibrator.sheet.massSource`) that a9b5d7f added after the fixtures
were first written; `golden:check` is unchanged by this (1 619 / 1 619 before recording the new suites) because
`applyProjectSnapshot` + `ensureStage6State` merged the same defaults. `manifest.json` updated accordingly.

Normaliser (`scripts/golden/lib/normalize.mjs`, no Node golden changed): `<n> s` substring mask (the seepage
completion message embeds `stage6SecondsLabelFromMs`; units such as `0.5 s/m` are left alone), entity ids inside
longer strings (`seepage.geometryHash` carries the drain ids) and as object keys (`mesh.drainNodeIdsByDrain` →
`<id:n>`), `wall-material-wall_*` ids. Browser tier (`scripts/golden/lib/journey.mjs`): `DIGEST_ALWAYS` — the
Bishop model's embedded seepage / deformation state, `deformation.result.elementResults` / `.mesh`, per-cell mesh
geometry and the contour derivatives are stored as digests at every step (the seep-slope journey was 56 MB,
now 5 MB); the same text masks as the normaliser.

`browser/demo-journey` and `browser/gef-import-journey` updated with `GOLDEN_MODE=update`: 34 `state.json` per
journey gained the drivability defaults of a9b5d7f (the browser baseline had not been re-recorded then),
`cache.bishopModel.seepage/deformation` became digests (above), and the PNGs were re-recorded after the Phase 2a
restyle (f30d251) — soft signal only. No DOM text changed.

## 2026-08-29 — a9b5d7f drivability features (v0.6.0)
Suites `retaining` (59), `exports` (9), `project-io` (12), `stage6-shared` (4): intentional behaviour change —
new state defaults `drivability.push {force_kN, includeWeight}` and `drivability.vibrator.sheet.massSource`
(static push-in method; data-sheet essentials), new `sensitivity` key on vibratory results with a candidate,
drivability result card title "Achievable depth — …" and carrier-check rows in the DOM text. No numeric
result changed. Commits 1c2bdab, 2cc597b, 4367bea merged with integration-r in a9b5d7f.

## 2026-08-29 — browser journeys after the drivability features
`gef-import-journey` / `demo-journey` state snapshots: the same two new state keys as the Node update above
(`drivability.push`, `drivability.vibrator.sheet.massSource`) on every step that carries the retaining state.
No DOM text or numeric change.

## 2026-08-30 — chart-configs after the Stage 6 restyle (PR 13, db27c9c)
28 pile chart configs: series colours now come from the `--viz-*` tokens through `theme.ts` (teal / ink /
ochre / brick / slate / moss) instead of the legacy literal rgba values. Data unchanged. `vizTheme()` falls
back to the light-theme literals when no DOM is present, so the Node goldens carry the real palette.
