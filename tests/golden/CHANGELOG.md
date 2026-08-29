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
