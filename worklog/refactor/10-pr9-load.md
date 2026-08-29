# 10 — PR 9 `refactor(load): parsers + apply-parsed-cpt`

Base 9acc3b7 (PR 5, `model-params/`), strangler step 5 of `01-monolith-map.md` §6.2 (PLAN §2 row 9).
Executed by a Fable agent in an isolated worktree. File set: `src/lib/cpt-app/legacy-controller.js`, new
`src/lib/cpt-app/load/**` (10 files), new `scripts/verify_load.mjs`, this report. `package.json`, `tests/`,
`scripts/golden/**`, `import-review/**` and the Svelte templates untouched.

One commit, one pure move: `npm run golden:check` 1 619 / 0 / 0 / 0 before and after — no golden updated,
no `tests/golden/CHANGELOG.md` entry. The two parser findings of the harness report are **not** fixed here
(§8: they are behaviour changes with their own golden update).

## 1. What moved

Old line numbers are those of 9acc3b7. Bodies are verbatim (a scratch script brace-matched every moved
function in the old controller against the new module and found 31/31 identical — the only edits are
`S.` → `cpt.` in the four DOM-sync bodies and `Math.random()` → `random()` in the demo loop).

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `stripCptFileExtension` 417-419, `isExcelCptFile` 421-427, `isCsvCptFile` 429-433 | `load/file-kind.js` → same names | none | deleted (only the loader and the CSV parser used them) |
| `importCptFiles` 436-488 (serial FileReader loop, **`S` swap**) | `load/import-files.js` → `importCptFiles(files, ctx)` | the swap is gone: the file's importer receives the **target CPT** (§2); `PROJECT` → `ctx.project`, `newCptState` / `renderBanner` / `alert` / `selectCpt` via `ctx` | wrapper `importCptFiles(files)` builds the ctx from `PROJECT`, `newCptState`, `cptFileImporters`, `selectCpt`/`renderBanner` |
| `pad2` 863, `formatExcelHeaderValue` 867-879, `normalizeExcelLabel` 881-888, `excelHeaderLookup` 890-897, `excelHeaderText` 899-904, `excelHeaderNumber` 906-908, `findExcelSheetName` 910-914 | `load/parsers/excel-headers.js` → same names | none | not imported (only `parseExcelCpt` reads them) |
| `xlsxModulePromise` 135 + `loadXlsxModule` 916-921 | `load/parsers/excel.js` → `loadXlsxModule()` (module-level cache moved with it) | none | imported (the Excel importer awaits it) |
| `parseExcelCpt(buffer, fname)` 962-1049 (async: xlsx read → header lookups → **review dialog → applyParsedCpt**) | `parsers/excel.js` → `parseExcelCpt(XLSX, buffer, fname)` — sync, pure | `alert(...); return false` → `return {ok:false, error}`; the dialog call and the apply call are gone: the result carries `review` (the staged object minus `context.assumedRf`) and the flat apply fields; `rows` are built with the auto-detected mapping (what an unchanged confirmation applies) | `parseExcelCpt(buffer,fname)` = `cptFileImporters.excel(buffer,fname,S)` |
| `splitDelimitedLine` 1051-1073, `parseDelimitedText` 1075-1081, `detectDelimitedTextSeparator` 1083-1100 | `parsers/csv.js` → same names | none | not imported |
| `parseCsvCpt(text, fname)` 1102-1144 | `parsers/csv.js` → `parseCsvCpt(text, fname)` — sync, pure | as Excel; `delimiter` and `skipped` exposed | `parseCsvCpt(text,fname)` = `cptFileImporters.csv(text,fname,S)` |
| `parseGEF(txt, fname)` 1149-1275 (the reading loop, channels, review, apply) | `parsers/gef.js` → `parseGEF(txt, fname)` — sync, pure; `GEF_CHANNELS` moved out of the body | loop and channel mapping verbatim; `review` + flat apply fields as above; `columns:{colMap, unitMap}` exposed | `parseGEF(txt,fname)` = `cptFileImporters.gef(txt,fname,S)` (still on `legacyApi`) |
| `applyParsedCpt({rows, meta, …})` 923-960 — state half (9 `S.` writes + `S.meta`) | `load/apply-parsed-cpt.js` → `applyParsedCpt(cpt, parsed) → patch \| null` | the `S.x/S.y` conditional became a value computation over `cpt.x/cpt.y` (a full patch: `data, wt, wtFromFile, wtSource, elev, elevFromFile, elevSource, x, y, meta`); `alert('No valid data rows found.')` → `null` (+ `NO_DATA_ROWS_MESSAGE`) | `applyParsedCptTo(cpt, parsed)`: patch → `Object.assign` → DOM sync → `requestAnimationFrame(()=>initCharts())` → `true`; `applyParsedCpt(parsed)` kept as the S wrapper |
| `applyParsedCpt` — DOM half 945-956 (wtR, wtN, elevN, cptX, cptY, `updateElevSrc`, `updateWTDisplay`, `updateAssumedRfControls`, `renderMeta`, `#s1body`) | `load/controls.js` → `syncWaterTableControls`, `syncElevationControl`, `syncCoordinateControls`, `showStage1Body`, composed by `syncParsedCptDom(document, cpt)` in the old order | `S.` → `cpt.`; `document` is a parameter | called from `applyParsedCptTo` |
| `updateElevSrc` 1277-1281, `updateWTDisplay` 1282-1290, `renderMeta` 1291-1308, `updateAssumedRfControls` 1368-1374 | `controls.js` → `renderElevationSource`, `renderWaterTableDisplay`, `renderMetaCard`, `renderAssumedRfControls` `(document, cpt)` | `S.` → `cpt.` | the four names stay as one-line wrappers over `S` (`updateElevSrc`, `updateWTDisplay`, `renderMeta` are on `legacyApi`; `selectCpt`, `setElev`, `setWT`, `setAssumedRf`, `projectIO.afterLoad` keep calling them) |
| `loadDemo` 1626-1654 | `load/demo.js` → `demoRows(random = Math.random)` (exact bands, step, rounding, two draws per reading in the old order) and `demoPatch(random)` (rows + wt/elev/meta as before, `depthMax` stays the loop bound 21.73); DOM syncs → `controls.js` `syncDemoDom` (the parsed set minus the coordinate inputs — `loadDemo` never wrote `cptX/cptY`) | `Math.random()` → `random()` | `loadDemo(){ Object.assign(S, demoPatch(Math.random)); syncDemoDom(document, S); requestAnimationFrame(()=>initCharts()); }` — the seeded golden replaces `Math.random` before the call, so the generator sees the seeded source |
| — (new) | `apply-parsed-cpt.js` → `reviewStaging(parsed, assumedRfText)` | `{...parsed.review, context:{...context, assumedRf}}` — `assumedRf` last, per-format shape preserved (GEF: `rows`+`channels`; CSV/Excel: `grid`+`headerIdx`+`cols`; CSV's context without `waterSource`/`elevationSource` as before) | used by `importParsedCpt` |
| — (new, controller) | `importParsedCpt(cpt, parsed)` | `!parsed.ok` → `alert(parsed.error)` (the old early returns, same texts, same order); `presentImportReview(reviewStaging(parsed, normalizeAssumedRf(cpt.assumedRf).toFixed(1)))` (what `assumedRfValue().toFixed(1)` read from the swapped `S`); `null` → `false`; else `applyParsedCptTo(cpt, {...parsed, rows: review.rows})` | the seam between the pure parse and the DOM |
| — (new) | `load/index.js` | re-exports the package surface | the controller imports only from `index.js`, in one block directly after the `core/` imports (the parallel PR adds its block after `model-params`) |

GEF used the parser's own `rows` for apply while CSV/Excel used `review.rows`; `importParsedCpt` uses
`review.rows` for all three — for GEF the dialog resolves `{rows: staged.rows}`, the same array reference.

Not moved (deliberately, per the map's `load/` row and PLAN §2 rows 10/14): `loadGEF`, `importGEFFiles`,
`loadSingleGEF`, `bindDropzone` (`dropzone.js`, DOM/event glue), `setElev`/`setWT`/`setCptCoord`/
`setAssumedRf`/`setMinThk`/`setSmartMerge*` (`controls.js` handlers, PR 10 with the Stage 1 markup),
`initCharts`/`refreshChartData`/`updateWTLine`/`*EmptyState*` (`raw-charts.js`), `drawLayerColumnSvg`/
`renderLayerPreviewSvg` (`layer-svgs.js`), `selectCpt`'s own control sync (project package, step 8).

## 2. The `importCptFiles` `S`-swap — deleted, and why nothing observable moved

Old 436-488 wrapped every parse in

```js
const prevActive=PROJECT.activeCptIdx; const prevS=S;
PROJECT.activeCptIdx=targetIdx; S=PROJECT.cpts[targetIdx];
try { ok=await parse*(…) … S.id=…; renderBanner(); } catch … 
if(fi===0) selectCpt(targetIdx); else { PROJECT.activeCptIdx=prevActive; S=prevS; renderBanner(); }
```

The swap existed only so that the chain `parse* → assumedRfValue() → presentImportReview → applyParsedCpt
(S writes + Stage 1 DOM syncs) → S.id=` operated on the target CPT. With `importParsedCpt(cpt, parsed)` /
`applyParsedCptTo(cpt, …)` / `syncParsedCptDom(document, cpt)` every one of those reads and writes takes the
target explicitly, so `S` and `PROJECT.activeCptIdx` are never re-pointed (`verify_load.mjs` §9: `S=` is
assigned only at its declaration and in `selectCpt`/`removeCpt`). What each piece did under the swap and
does now:

| Under the swap (old) | Explicit target (new) |
|---|---|
| review context `assumedRf` = `normalizeAssumedRf(S.assumedRf)`, `S` = target | `normalizeAssumedRf(cpt.assumedRf)`, `cpt` = target |
| `applyParsedCpt` writes `S` = target | `Object.assign(target, patch)` |
| the 15 Stage 1 DOM syncs read `S` = target (so after a multi-file import the Stage 1 controls, source tags and meta card show the **last** file's values while tab 1 stays active — the existing quirk, kept) | `syncParsedCptDom(document, target)` — same writes, same values |
| `S.id = stripCptFileExtension(name); renderBanner()` | `target.id = …; ctx.renderBanner()` |
| transient `renderBanner()` with `activeCptIdx` = target, immediately re-rendered with `prevActive` | rendered once with the unchanged active index — the final DOM is identical |
| fi = 0: `selectCpt(target)` (the target is the active CPT by construction) | `ctx.onImported(target, true)` → `selectCpt(target)` |
| fi > 0: restore + `renderBanner()`, also after a cancelled/failed parse | `ctx.onImported(target, false)` → `renderBanner()`, unconditional as before |
| `reader.onerror` → alert, next file | same |
| `requestAnimationFrame(()=>initCharts())` — `initCharts` reads `S` **at frame time** | unchanged line; `initCharts` reads `S` at frame time |

**Proof.** A scratch probe (`multi-import-snapshot.mjs`, Tier-B loader) ran six scenarios through the real
`loadGEF` path against the old controller (9acc3b7 swapped into the tree) and the new one: three files
GEF+GEF+CSV; XLSX first then GEF; a rejected CSV between two GEFs; a single `;`-comma CSV; a second import
into a project whose active tab is CPT-2; seeded `loadDemo`. Each snapshot records every CPT's Stage 1 state,
`activeCptIdx`, `S === cpts[active]`, `sectionOrder`, the 16 Stage 1 element ids (`value`, `textContent`,
`innerHTML`, `display`), the banner, alerts, review count and rAF errors — under the stub's synchronous
`requestAnimationFrame` **and** under a browser-like asynchronous one. Result (structured diff):

- every scenario, both timings: **identical** in everything except chart-instance ownership on the
  non-active target CPTs;
- old code: the non-active targets own Chart instances whose content depends on timing — with a synchronous
  frame they hold the target's rows (240/360/300 points), with an asynchronous frame **0 points**: the frame
  scheduled by `selectCpt(0)` fires inside the swap window of file 2 (while the modal is open, `S` = the
  not-yet-parsed target), so `initCharts()` builds the active tab's charts on the wrong, empty CPT and the
  active CPT's own charts are only built after the confirmation (in a real browser the second `new Chart` on
  the same canvases would then throw Chart.js' "canvas is already in use"). That is the swap's hidden
  coupling of map §3.4-1/7: any frame or timer callback firing during the modal read the swapped `S`;
- new code: non-active CPTs never own chart instances; the active CPT's charts are the same in both timings.

So the deterministic observables are equivalent bit for bit, and the single divergence is the removal of a
race that only the swap could produce (its outcome differed between the two frame timings of the old code
itself). The single-file path — the only one the goldens lock — has no swap window and is bit-identical
(`import` suite 86/86, and `verify_load.mjs` §8 compares wrapper against pure for GEF/CSV/XLSX).

The Stage 1 "last file wins" DOM quirk after a multi-file import is preserved on purpose (a fix — sync from
the active CPT instead — is a behaviour change; §8).

## 3. Controller line-count delta

| | lines (`wc -l`) |
|---|---|
| before (9acc3b7) | 18 047 |
| after | **17 596** (net **−451**) |

`git diff --stat`: `legacy-controller.js | 585 (67 insertions, 518 deletions)`. Insertions: the 17-line
import block, `cptFileImporters` (5 lines + 4 comment lines), the `importCptFiles` wrapper (17), the parsers
header comment (7), `importParsedCpt` (6), `applyParsedCptTo` (8 + 2 comment), `applyParsedCpt` wrapper (3),
the three parse wrappers, the four DOM wrappers, `loadDemo` (5). `legacyApi` exports the same 167 names
(`verify:handlers`: 180 published, unchanged). `load/`: 789 lines in 10 files (`parsers/gef.js` 147,
`parsers/excel.js` 122, `parsers/csv.js` 118, `controls.js` 107, `import-files.js` 73, `parsers/excel-headers.js`
62, `apply-parsed-cpt.js` 55, `demo.js` 44, `index.js` 37, `file-kind.js` 24) — the extra over the 451 cut is
headers, the result-shape documentation, the ctx documentation and the package index.

Every module: SPDX header, `// @ts-nocheck`, header comment naming source + old line range, `.js` imports so
the package loads under plain Node (`verify_load.mjs` §1-7 need no Vite; `xlsx` is imported dynamically by
`loadXlsxModule` exactly as before — Vite still emits it as a lazy chunk). Dependencies: `parsers/*` →
`../../import-review/tabular.js` (pure; never `modal.js`/`index.js`), `parsers/csv.js` → `../file-kind.js`,
`controls.js` → `../classification-core.js` (`normalizeAssumedRf`), `import-files.js` → `./file-kind.js`.
No `S`, no `document` outside `controls.js` (which takes it as a parameter), no `window`.

## 4. Callers, unchanged

`loadGEF` (file input, `Stage1Load.svelte` `call('loadGEF', event)`), `bindDropzone` → `importGEFFiles` →
`importCptFiles`; `loadSingleGEF` → `parseGEF(...).catch(...)` (the wrapper stays `async`, so a synchronous
parser throw still surfaces as a rejection); `selectCpt`, `setElev`, `setWT`, `setAssumedRf`,
`projectIO.afterLoad` → `updateElevSrc`/`updateWTDisplay`/`updateAssumedRfControls`/`renderMeta`;
`Stage1Load.svelte` `call('loadDemo')`; the golden `import` suite (`loadGEF` → … → `selectCpt`; seeded
`loadDemo`; demo-fixture parity) — all still the monolith names, all bit-identical.

## 5. `scripts/verify_load.mjs` — 45 checks, exit 0 (`--pure-only`: 40, 0.2 s, no Vite)

| Part | What |
|---|---|
| §1-5 unit (plain Node) | file-kind sniffing; `pad2`/`formatExcelHeaderValue` (date, time key, number, string, null), `normalizeExcelLabel`, header lookups (label order, comma decimals, unparseable → null), `findExcelSheetName` (exact before substring); `splitDelimitedLine` quoting, `parseDelimitedText` BOM/CRLF/blank rows, separator detection incl. the locked `;`+comma mis-detection; `parseCsvCpt` result shape + the two error texts; the GEF loop on a synthetic file (kPa units, corrected depth 11 over 1, cone-engaged skip, Rf clamp 20, Rf column preferred, out-of-range Rf → from fs, u2, `!` comments, location text, MEASUREMENTVAR 14 abs, aRatio, ZID) and the no-header defaults; `applyParsedCpt` (null on empty rows, wt default 1.5, `'file'` source fallback, the four coordinate rules, meta flags, exact patch key set) and `reviewStaging` |
| §6 demo | `demoRows(mulberry32(20260829))` == `node/import/demo-seeded.json` rows (1 080, exact); `demoPatch` on a fresh CPT == the whole golden pick; two draws per reading, band edges at 0.6/1.5/3.0/5.5/7.0/9.5/11 |
| §7 goldens are the truth | every file under `fixtures/cpt/` (manifest-driven, `wt-above-surface` = `layered.gef` + inject): pure parse → `applyParsedCpt(freshCpt, parsed)` → `id = stripCptFileExtension` → `deepStrictEqual` with `node/import/<fixture>.json` after the goldens' normalisation (tolerance "pure", exact) — **14 fixtures**, GEF/CSV/XLSX; the recorded `.review.txt` must contain the pure result's file line, row count and (GEF) channel sources; `.alerts.json` empty; `layered-comma.csv` locked at 341 rows / delimiter `,` |
| §8 wrappers ⇔ pure (Tier-B loader) | single `loadGEF` for GEF/CSV/XLSX == pure parse + apply; four-file `loadGEF` (GEF, GEF, XLSX, CSV): `activeCptIdx` stays 0, `S === cpts[0]`, `sectionOrder`, every CPT == its pure parse + apply, ids, 4 reviews, no alerts, first tab active, Stage 1 DOM synced from the last target as before; a rejected CSV in the middle (alert text, empty tab kept, later file imported); import into a non-first tab; seeded `loadDemo` == `demoPatch` and the golden, the Stage 1 DOM (`(from demo)`, `= 68.27 m TAW`, meta card), `parseGEF` on `legacyApi` resolves `true` into the active CPT; the Stage 1 names on `legacyApi` |
| §9 extraction complete | 21 moved declarations/fragments absent from the controller, the import block directly after `core/chart-host.js`, the 12 wrappers present verbatim, `S=PROJECT.cpts[` exactly 3× (declaration, `selectCpt`, `removeCpt`); the 10 module files, SPDX + `@ts-nocheck`, parsers/apply/demo/file-kind free of `document`/`window`/`S.` and of the dialog module |

## 6. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — before (9acc3b7) | 1 619 PASS / 0 FAIL / 0 NEW / 0 MISSING, 28.9 s, exit 0 |
| `npm run golden:check` — after the move | 1 619 / 0 / 0 / 0, 29.5 s, exit 0 (`import` 86 bit-identical: rows, sources, meta, review text, meta card, raw charts, banner, seeded demo, demo parity) |
| `npm run golden:check` — final (verifier + report in the tree) | 1 619 / 0 / 0 / 0, 28.9 s, exit 0 |
| `npm run verify:handlers` | OK — 428 inline handlers, 70 callees, 180 published names (legacyApi 167), exit 0 |
| `npm run verify:core-helpers` | 18/18, exit 0 |
| `node scripts/verify_model_params.mjs` | 188/188, exit 0 |
| `npm run verify:import-review` | all checks passed, exit 0 |
| `npm run verify:qc-only` | passed, exit 0 |
| `npm run verify:project-io` | all checks passed, exit 0 |
| `node scripts/verify_load.mjs` | 45/45, exit 0 (`--pure-only` 40/40) |
| `npm run build` | `✓ built in 2.52s`, exit 0 (xlsx still a lazy chunk) |
| `npm run check` | 399 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 warnings, 0 in `load/**` |

Playwright / dev server not run (pure move; README protocol step 5).

## 7. `package.json` line for the main session

```json
"verify:load": "node scripts/verify_load.mjs",
```

Suggested: add `&& npm run verify:load` to `verify:core` (§7-8 need `tests/golden/**` and, for §8, the Vite
dev dependency — both present in CI; `--pure-only` for a Vite-less run).

## 8. Follow-ups (not in this pure move)

1. **`;`-separated CSV with comma decimals is mis-detected as `,`-delimited** (`detectDelimitedTextSeparator`
   scores the decimals as extra columns → `layered-comma.csv` yields 341 garbage rows; README "Known app
   behaviour", locked by `node/import/layered-comma.csv.json` and `verify_load.mjs` §3/§7). Fix candidate:
   score a delimiter only when the numeric cells below the header parse under it, or try `;` before `,` when
   the sample's `,` count per line is uniform and odd. Behaviour change → own commit + golden update +
   CHANGELOG entry.
2. **`#COLUMNVOID` is ignored by the GEF parser** — a void marker (e.g. `-9999`) in a mapped column is taken
   as a reading (a void depth is filtered by `z<0` only when negative; a void qc passes the `qc<0.02` test
   when positive). Fix: parse `#COLUMNVOID= col, value` into a per-column void map and skip rows whose
   depth/qc equal it (fs/Rf/u2 → null). Behaviour change → own commit; needs a fixture with voids.
3. Multi-file import: the Stage 1 controls, source tags and meta card end up showing the **last** file's
   values while the first tab is active (pre-existing, preserved — §2). Fix: sync the DOM from the active
   CPT after the loop (or only for the first file). Small behaviour change, no golden covers it; a browser
   journey should.
4. `selectCpt` (project package, step 8) duplicates the Stage 1 control sync of `controls.js` inline
   (plus the smart-merge and method-button syncs); it should call `syncWaterTableControls` /
   `syncElevationControl` / `syncCoordinateControls` when it moves.
5. `applyParsedCpt(parsed)` is kept as the documented `S` wrapper but has no caller left (the three
   parse wrappers go through `applyParsedCptTo`); `loadSingleGEF` has no caller either (pre-existing). Both
   go with `dropzone.js` / step 10.
6. The GEF parser silently drops malformed rows; `parseCsvCpt`/`parseExcelCpt` expose `skipped` (from
   `buildRowsFromGrid`). A `skipped` list for GEF (non-numeric line, negative depth, cone not engaged) would
   let the review dialog show the same "overgeslagen" counts for GEF — additive, not done here.
7. `demoRows`/`demoPatch` and `scripts/golden/make-fixtures.mjs` `demoRows` are now two copies of the same
   loop; the fixture generator could import `load/demo.js` (it already imports the PRNG) — harness file, main
   session.
