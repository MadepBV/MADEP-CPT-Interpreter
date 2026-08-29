# Golden changelog

Every intentional golden update: date, commit, suite — reason — affected cases. CI requires an entry
here whenever `tests/golden/**` changes in a pull request.

## 2026-08-29 — baseline

- Baseline characterization of branch `v0.6.0` at HEAD `462fc50` (unmodified app source). 1 619 Node-tier
  cases over 15 suites recorded with `npm run golden:record`; `npm run golden:check` green twice.
- Fixtures generated with seed 20260829 (`fixtures/manifest.json`); Chart.js 4.4.1 vendored; WASM pinned.
