# Golden changelog

Every intentional golden update: date, commit, suite — reason — affected cases. CI requires an entry
here whenever `tests/golden/**` changes in a pull request.

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
