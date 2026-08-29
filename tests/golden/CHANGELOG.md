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
