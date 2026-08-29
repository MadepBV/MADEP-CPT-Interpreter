# 09 — PR 6 `refactor(classification, layers): pure compute, render split out`

Branch `v0.6.0` (base 9acc3b7 = PR 5), strangler step 3 of `01-monolith-map.md` §6.2 (PLAN §2 row 6).
Executed by a Fable agent in an isolated worktree. File set: `src/lib/cpt-app/legacy-controller.js`, new
`src/lib/cpt-app/classification/**` (5 files), new `src/lib/cpt-app/layers/**` (6 files), new
`scripts/verify_classification_layers.mjs`, this report. `package.json`, `tests/`, `scripts/golden`,
`src/lib/styles`, Svelte templates untouched.

One commit, one pure move: `npm run golden:check` 1 619 / 0 / 0 / 0 before and after — no golden updated,
no `tests/golden/CHANGELOG.md` entry needed. No behaviour-change commit was necessary.

## 0. One finding on the map

The map (§2.3, §3.1, §3.4 item 2, §6.2 step 3) says `detectLayers` "ends with `renderLayers()`". It does not —
neither at 9acc3b7 nor at the 462fc50 baseline (`git show 462fc50:… | awk '/^function detectLayers\(\)/,/^}/'`
has no `renderLayers` call; the function is 53 lines and ends with the `S.layers=merged.map(…)` assignment).
Rendering has always been the callers' job: `goS(2)` (`if(n===2)renderLayers()`), `setParamMethod`
(`detectLayers(); renderLayers();`), `refreshClassificationDerivedViews` (renders only when `#p2` is active),
and the golden `layers` suite calls `api.detectLayers()` and `api.renderLayers()` separately. So "detectLayers
stops calling renderLayers" needed no code change — the wrapper only assigns, and every caller keeps the DOM
it had. `runClass` did render four regions (`#cmet`, `#classAssumedRfNote`, `#cmetricHead`, `#cbody`) inline
and then call `detectLayers` + the two SVG renders; that is what was split.

## 1. What moved (verbatim bodies; only the `S` reads renamed)

Old line numbers are those of 9acc3b7.

### `classification/` (Stage 2)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `classificationMethodLabel` 1681-1689, `classificationMetricLabel` 1691-1696, `classificationMetricValue` 1698-1703 | `classification/labels.js` → same names | none | imported under the same names (`stage7MethodLabel`, method cards) |
| `assumedRfValue()` 1772-1774 | `classify.js` → `assumedRfValue(cpt)` | `S.assumedRf` → `cpt.assumedRf` | wrapper `assumedRfValue(){ return assumedRfValuePure(S); }` (19 callers unchanged) |
| `cptHasFs()` 1778-1780, `cptHasRf()` 1781-1783 | `classify.js` → `cptHasFs(cpt)`, `cptHasRf(cpt)` | `S.meta`/`S.data` → `cpt.*` | wrappers over `S` |
| `classRob` 1785-1791, `classRob2016` 1799-1805, `classCUR3` 1836-1838 (+ `classCUR` alias), `classNEN6740` 1866-1869, `classSB260` 1886-1891 (+ the four method comment blocks 1736-1767, 1793-1798, 1807-1835, 1841-1865, 1871-1885) | `classify.js` → same names with `(cpt, r)` | `stressAt(r.z,18,17)` → `stressAt(cpt, r.z, 18, 17)` (from `model-params/stress.js`), `S.meta?.aRatio` → `cpt.meta?.aRatio`, `assumedRfValue()` → `assumedRfValue(cpt)` | wrappers `classRob(r){ return classRobPure(S, r); }` … (`classRob`, `classCUR`, `classSB260` stay on `legacyApi`) |
| the `if/else if` method dispatch inside `runClass` 1902-1907 | `classify.js` → `classifyRow(cpt, row, method = cpt.method)` | same chain, unknown method falls through to Tabel 3 as before | — |
| `runClass` 1896-1980 compute part: `useSB260params`, `classified`, `n/fsRows/rfRows/avg`, `rfAssumedCount`, the six metric tiles' values, the note branch (`missing===0` / none measured / `≥ 5 %` / gaps with depths), the metric column label | `run.js` → `classifyCpt(cpt, ctx = {}) → { method, useSB260params, classified, rfAssumedCount, metrics, metricLabel, assumedRfNote }` | `S.data/S.method` → `cpt.*`; writes to `S` replaced by return values; the note's HTML replaced by `{kind: 'none'\|'none-measured'\|'partial'\|'gaps', missing, n, assumedRf, gaps[]}` | see §2 |
| `runClass` markup: `#cmet` tiles 1919-1926, `#classAssumedRfNote` variants 1932-1961, `#cbody` rows 1965-1975 | `panel.js` → `classificationMetricsHtml(metrics)`, `classificationAssumedRfNoteHtml(note)`, `classificationTableRowsHtml(classified, {method, elev})` | template strings unchanged; `SC` → `SOIL_CLASS_NAMES` (same object), `S.elev` → `elev`, `assumedRfValue().toFixed(1)` → `note.assumedRf.toFixed(1)` | the `innerHTML=` writes |
| — | `classification/index.js` | re-exports the package surface | the controller imports only from `index.js` |

Not moved (deliberately): `selM`, `syncClassificationMethodCards` (DOM, `method-cards.js` of the handlers
split), the `stressAt` wrapper (already PR 5; `classify.js` imports `model-params/stress.js`), the
`SOIL DEFS` header + `SC`/`SCFILL` aliases (still used by `renderLayers`, `renderModel`, the section view).

### `layers/` (Stage 3)

| Monolith (old lines) | New module → export | Change inside the body | Controller now |
|---|---|---|---|
| `layerTypeCompatScore` 512-551 (+ header comment 506-511) | `layers/tabel3-compat.js` → same name | none | imported (`legacyApi`, `continuityScore`, section view unchanged) |
| `CAT_GROUPS` 2353-2359, `COMPAT` 2380-2388 (+ the two comment blocks 2361-2379), `compatLevel` 2390-2395, `qcRfFit` 2404-2453, `suggestSubtype` 2455-2506 | `tabel3-compat.js` → same names | `suggestSubtype(l, catalogue = CAT)` — optional second argument, default = the module `CAT` | `CAT_GROUPS`, `compatLevel`, `qcRfFit`, `suggestSubtype` imported (`buildSubtypeDropdown`, `renderCompatWarnings`, Stage 7 warnings unchanged); `COMPAT` not imported (only `layerTypeCompatScore` read it) |
| `subtypeGroup` 2035-2038 | `tabel3-compat.js` → `subtypeGroup` | none | imported |
| `segmentSummary` 1988-2014 | `layers/segments.js` → `segmentSummary(seg, prevSeg, ctx = {})` | `S.useSB260params` → `ctx.useSB260params` | wrapper `segmentSummary(seg, prevSeg){ return segmentSummaryPure(seg, prevSeg, layersCtx(S)); }` |
| `segmentTop` 2016-2033, `familyClass` 2040-2046, `qcSimilarity` … `continuityScore` 2048-2085, `isCriticalMarkerLayer` 2087-2098, `SMART_SLIVER_REF` 2100, `mergeCandidateScore` 2102-2135 | `segments.js` → same names | none | the nine `legacyApi` names imported as they are; `segmentTop`, `SMART_SLIVER_REF` not needed in the controller |
| `simpleUpwardMerge` 2137-2158, `mergeSegmentInDirection` 2160-2171, `chooseSimilarityMergeDirection` 2173-2192, `smartSimilarityReduce` 2194-2228, `enforceMinThicknessBySimilarity` 2230-2248, `smartPostMerge` 2250-2260 | `layers/merge.js` → same names, `ctx` threaded as the last argument | `S.minThk` → `ctx.minThk` (2 reads), `S.smartMergeSensitivity` → `ctx.smartMergeSensitivity`; every `segmentSummary(…)` call gets `, ctx` | not imported (only `detectLayers` called them) |
| `classificationSegmentKey` 2262-2265 | `layers/detect.js` → `classificationSegmentKey(row, method)` | `S.method` → `method` | not imported |
| `detectLayers` 2267-2330 | `detect.js` → `detectLayers(cpt, ctx) → layers[]` | `S.classified` → `cpt.classified`; `S.smartMerge`/`S.paramMethod`/`S.method` → `cfg.*`; the catalogue for `suggestSubtype` and the `rfIndeterminate` filter comes from `cfg.catalogue`; `S.layers=merged.map(…)` → `return merged.map(…)` | wrapper `detectLayers(){ S.layers=detectLayersPure(S, layersCtx(S)); }` |
| — (new) | `layers/context.js` → `layersCtx(cpt, over = {})` | builds the ctx below from a CPT state, applies defined overrides | used by the two wrappers |
| — | `layers/index.js` | re-exports the package surface | the controller imports only from `index.js` |

Not moved (deliberately, per the brief): `buildSubtypeDropdown`, `renderLayers`, `renderCompatWarnings`
(`layers/table.js` of a later step — PLAN row 10 restyles that markup together with the render wrappers),
`changeSubtype`, `editL`, `editAlpha/M/RShear/Nu` (`layers/handlers.js`), `setParamMethod`. The "LAYER TABLE"
conceptual comment stays in front of `buildSubtypeDropdown`.

### The ctx (`layersCtx(cpt)`)

| Field | Was | Read by |
|---|---|---|
| `catalogue` | the module-level `CAT` import | `detectLayers` (subtype suggestion + `rfIndeterminate` tie check) — default `CAT`; the merge scores keep the module `CAT` (documented in `tabel3-compat.js`) |
| `method` | `S.method` | `classificationSegmentKey` (sb260 splits on `type::subtype`) |
| `paramMethod` | `S.paramMethod` | `detectLayers` (apply the Tabel 3 suggestion's γ/φ/c/cu only under `sb260`) |
| `useSB260params` | `S.useSB260params` (set by `runClass`) | `segmentSummary` (average the Tabel 3 row params vs `DEF[type]`) |
| `smartMerge` | `S.smartMerge` | `detectLayers` (smart chain vs upward merge) |
| `minThk` | `S.minThk` | `simpleUpwardMerge`, `enforceMinThicknessBySimilarity` |
| `smartMergeSensitivity` | `S.smartMergeSensitivity` | `smartPostMerge` (clamped 0-6, default 1.1 — unchanged) |

The wrappers build the ctx from the live `S` at call time, exactly when the old bodies read those fields
(nothing mutates `S` inside a detection run), so the snapshot is not observable — `layers` goldens are
bit-identical for all 165 cases.

## 2. `runClass` and `detectLayers` after the move

```js
function runClass(){
  if(!S.data.length){alert('Laad eerst een GEF bestand.');return;}

  const result=classifyCpt(S);
  S.useSB260params=result.useSB260params;
  S.classified=result.classified;
  S.rfAssumedCount=result.rfAssumedCount;

  document.getElementById('cmet').innerHTML=classificationMetricsHtml(result.metrics);
  const assumedNote=document.getElementById('classAssumedRfNote');
  if(assumedNote) assumedNote.innerHTML=classificationAssumedRfNoteHtml(result.assumedRfNote);
  const metricHead=document.getElementById('cmetricHead');
  if(metricHead) metricHead.innerHTML=result.metricLabel;
  document.getElementById('cbody').innerHTML=classificationTableRowsHtml(result.classified,{method:S.method,elev:S.elev});

  document.getElementById('classLayout').style.display='';   // ← unchanged tail
  detectLayers();
  renderLayerPreviewSvg('layerPreviewSvg');
  drawLayerColumnSvg('layerColSvg',S.layers,S.data[S.data.length-1].z+0.5);
  document.getElementById('minThkInfo').textContent='-> '+S.layers.length+' layers';
  document.getElementById('btnToLayers').style.display='';
}

function segmentSummary(seg, prevSeg){ return segmentSummaryPure(seg, prevSeg, layersCtx(S)); }
function detectLayers(){ S.layers=detectLayersPure(S, layersCtx(S)); }
```

Order of the `S` writes (`useSB260params`, `classified`, `rfAssumedCount`) and of the DOM writes is the
old one; nothing between them read `S` before, so compute-then-assign is equivalent. `classifyCpt` does not
alert on empty data (the wrapper keeps the guard) and requires `cpt.data.length > 0` like the old body.

## 3. Controller diff

| | lines |
|---|---|
| before (9acc3b7) | 18 047 |
| after | **17 365** (net **−682**) |

`git diff --stat`: `legacy-controller.js | 824 (71 insertions, 753 deletions)` in exactly seven hunks:
the two import blocks (+37, directly after `} from './model-params/index.js';` — the `core/` import block is
untouched for the parallel PR), `layerTypeCompatScore` cut (506-551), the three labels (1681-1703), the
classifier region (1736-1893 → 33 lines of wrappers), `runClass` (1896-1980 → 34 lines), the detection region
(1985-2330 → 16 lines), `CAT_GROUPS … suggestSubtype` (2353-2506 → a 2-line note + the kept dropdown comment).
`legacyApi` is untouched and still exports **167** names (`verify:handlers`: 180 published).

New packages: `classification/` 401 lines (classify 195, run 84, panel 65, labels 32, index 25), `layers/`
671 lines (tabel3-compat 216, segments 164, merge 138, detect 83, context 35, index 35). Every module: SPDX
header, `// @ts-nocheck`, header comment naming source + old line range, `.js` imports (plain-Node loadable —
the verifier's pure part needs no Vite), no `document`/`window`/`alert`, no `S`.

## 4. `scripts/verify_classification_layers.mjs` — 260 checks, exit 0

| Part | What |
|---|---|
| §1-7 unit (pure, no Vite) | labels; `assumedRfValue`/`cptHasFs`/`cptHasRf` on the CPT; `classRob`/`classRob2016`/`classNEN6740` use `stressAt(cpt,…)`, `meta.aRatio` (0.8 default) and the assumed Rf, `classCUR3 === classCUR`, `classSB260`; `classifyRow` dispatch + Tabel 3 fall-through; `classifyCpt` (no write to the CPT, `useSB260params` only for sb260, metrics, the four note kinds incl. the 5 % boundary and the ≤ 3 depth list); the three panel builders; `COMPAT`/`CAT_GROUPS`/`compatLevel`/`subtypeGroup`; `qcRfFit` boundary rules (Rf < 1 % exclusive, 1-2 % inclusive, veen gate, ±0.3 pp close); `suggestSubtype` priorities, veen block, `catalogue` argument; `layerTypeCompatScore` 1.0/0.9/0.5/0.4/0; `segmentTop`; `segmentSummary` DEF vs Tabel 3 row params, qc ≤ 0.02 skipped; the similarity terms; `simpleUpwardMerge` vs `ctx.minThk`; `smartPostMerge` = reduce → enforce with the clamped sensitivity; `classificationSegmentKey`; `layersCtx` copy + defined-only overrides; `detectLayers` returns fresh layers with the 15 keys, contiguous tops, writes nothing; ctx overrides (`smartMerge`, `paramMethod: 'def'` keeps the segment params, `minThk`, `catalogue`); qc-only `rfIndeterminate` |
| §8 classification goldens are the truth | every `tests/golden/node/classification/<fx>.<method>.json` (**45** = 9 profile fixtures × 5 methods) recomputed with `classifyCpt()` from the fixture's import golden (`data`, `wt`, `elev`, `meta`, `assumedRf`; manifest `inject` applied for `wt-above-surface`): `classified` deep-equal after the goldens' normalisation, `rfAssumedCount`, `useSB260params`, `cbodyRows` = `<tr>` count of `classificationTableRowsHtml`, `layerCount` = `detectLayers().length`; every `<fx>.<method>.metrics.txt` (**45**) rebuilt as `[#cmet]`/`[#cmetricHead]`/`[#classAssumedRfNote]`/`[#minThkInfo]` through `htmlToText` of the panel builders — exact; the two `qc-only.sb260.assumedRf{2,5}.json` (classified + rfAssumedCount + layers) |
| §9 layers goldens are the truth | every `detectLayers()` golden — `<fx>.<method>.{smart,simple}.json`, `<fx>.minThk{0.3,1}.json`, `<fx>.sens{0.9,1.3}.json` (**126** files, asserted = the count on disk) — recomputed from the classification golden's rows with the suite's settings, deep-equal; the `edited` / `dom-lb` / `warnings` goldens belong to the controller's edit path and table render and stay locked by `golden:check` only |
| §10 wrappers ⇔ pure (Tier-B loader, DOM stub) | demo fixture × 5 methods, `qc-only` (none-measured note; assumed Rf 2 re-run), `trailing-qc-only` (partial/gaps note): `runClass()` state (`classified`, `rfAssumedCount`, `useSB260params`) == `classifyCpt(S)`, the four DOM regions' `innerHTML` == the panel builders (exact strings), `S.layers` == `detectLayers(S)`, `#minThkInfo`; `api.detectLayers()` == pure for smartMerge off / minThk 0.3, 1.0 / sensitivity 0.9, 1.3 / paramMethod def; `api.segmentSummary` == pure with `layersCtx(S)` with and without `useSB260params`; `classRob`/`classCUR`/`classSB260`/`stressAt` wrappers == pure on the row grid; the 14 S-free Stage 3 helpers on `legacyApi` == the package on the demo layers; a second CPT state classifies/detects independently and leaves the active CPT untouched; the 27 Stage 2/3 names still on `legacyApi` |
| §11 extraction complete | none of the 25 moved function declarations, `const CAT_GROUPS/COMPAT/SMART_SLIVER_REF`, the old dispatch, the old merge/assign lines remain; both imports present and directly after the `model-params` block; the 11 wrapper/assignment fragments present; the `runClass` render tail byte-identical; the `detectLayers` wrapper contains no render; the 11 modules carry SPDX + `@ts-nocheck`, touch no DOM, read no `S` |

`--pure-only` skips §10 (no Vite): 246 checks in ≈ 11 s (the 126 layer recomputations dominate); the full run
with the Tier-B loader ≈ 31 s.

## 5. Gates

| Gate | Result |
|---|---|
| `npm run golden:check` — before (9acc3b7) | 1 619 PASS / 0 FAIL / 0 NEW / 0 MISSING, 29.6 s, exit 0 |
| `npm run golden:check -- --filter classification` / `layers` — right after the move | 188 / 0 and 165 / 0, bit-identical |
| `npm run golden:check` — after the move | 1 619 / 0 / 0 / 0, 32.3 s, exit 0 (no golden touched) |
| `npm run golden:check` — final (verifier + report in the tree) | 1 619 / 0 / 0 / 0, exit 0 |
| `npm run verify:handlers` | OK — 166 files scanned, 428 inline handlers, 70 callees, 180 published names (legacyApi 167), exit 0 |
| `npm run verify:core-helpers` | 18/18, exit 0 |
| `node scripts/verify_model_params.mjs` | 188/188, exit 0 |
| `npm run verify:stratigraphy` | all checks passed, exit 0 |
| `npm run verify:qc-only` | all 7 sections passed, exit 0 |
| `npm run verify:retaining` | wasm · ui PASSED · behaviour · soil-profile · sections-plaxis · request 24/24 (232 OK lines), exit 0 |
| `node scripts/verify_classification_layers.mjs` | 260/260, exit 0 (`--pure-only` 246/246) |
| `npm run build` | `✓ built in 2.69s`, exit 0 |
| `npm run check` | 400 files, **6 errors** = the 6 pre-existing (5 × `deformation/wall-result-staleness.js`, 1 × `vite.config.ts`), 0 in this PR's files |

Playwright / dev server not run (pure compute move; README protocol step 5).

## 6. `package.json` line for the main session

```json
"verify:classification-layers": "node scripts/verify_classification_layers.mjs",
```

Suggested: add `&& npm run verify:classification-layers` to `verify:core` (needs `tests/golden/**` and, for
§10, the Vite dev dependency — both present in CI).

## 7. Left in place / follow-ups

- `layers/table.js` (`renderLayers`, `buildSubtypeDropdown`, `renderCompatWarnings`) and `layers/handlers.js`
  (`changeSubtype`, `editL`, `editAlpha/M/RShear/Nu`, `setParamMethod`): the markup is restyled once in PLAN
  row 10, together with the Stage 2 `panel.js` strings; the goldens `layers/*.edited*`, `*.dom-lb.txt`,
  `*.warnings.txt` lock them meanwhile.
- `selM` / `syncClassificationMethodCards` → `classification/method-cards.js` with the handlers split (step 10).
- `assumedRfValue()` now has a one-line wrapper (19 callers across Stage 1/2/7); `model-params/context.js`
  still normalises `cpt.assumedRf` itself — the two agree by construction (`normalizeAssumedRf`).
- `classifyCpt(cpt, ctx)` accepts only `ctx.method` today; `aRatio`/`assumedRf`/`wt` are read from the CPT
  (through `classifyRow(cpt, …)` and `stressAt(cpt, …)`) — when `setActive()` arrives (step 8) the wrappers
  become `classifyCpt(getActive())` / `detectLayers(getActive())` and can go.
- The `catalogue` override of `layersCtx` reaches the subtype suggestion and the `rfIndeterminate` check;
  the merge scores (`subtypeGroup`, `layerTypeCompatScore`) still use the module `CAT` — fine while there is
  one catalogue; thread it through `segments.js` if a second catalogue ever appears.
- `01-monolith-map.md` §2.3 / §3.4 item 2 should drop the "`detectLayers` ends with `renderLayers()`" claim
  (§0 above).
