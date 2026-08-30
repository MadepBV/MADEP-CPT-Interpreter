# Audit — CPT file import, parsing & layer detection
**Subsystem key:** cpt-parse-import
**Files reviewed:** /Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/legacy-controller.js (parse/import/layer-detection regions), /Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/dxf-terrain.js, /Users/mathiasdepelsmaeker/Projects/madep-cp/docs/logic.md (Stage 1, parts of Stage 2)
**Finding counts:** critical=0 high=2 medium=4 low=7 info=3  |  A=8 B=1 C=3 D=4  |  total=16

## Overview
The ingest layer is generally well-built: the number parser handles both European and US decimal/grouping conventions robustly, qc/fs units are converted via `cptValueToMPa`, depth-column priority (qid 11 over 1) matches the doc, and the DXF terrain importer is clean and defensive. The most consequential gaps are in GEF robustness against spec features that real Dutch GEF files use: commas inside `#COLUMNINFO` descriptions silently drop a quantity column, `u2` is never unit-converted despite its declared unit being captured, and there is no `#COLUMNVOID` (sentinel) or `#COLUMNSEPARATOR` handling. The doc also claims two filters/behaviours (all-zero row removal; depth monotonicity) that the GEF path does not actually implement. None of these crash the app, but each can produce a plausible-but-wrong profile (wrong qt, dropped fs, sentinel values entering stresses) without warning, which is the dangerous class for this subsystem.

## Findings

### [CPT-PARSE-IMPORT-A-01] high · GEF `#COLUMNINFO` quantity-id read by fixed token index — a comma inside the description silently drops the column
- **Location:** `legacy-controller.js:1545-1556`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** The COLUMNINFO parser splits the line on commas and reads the quantity id from a fixed 4th token:
  ```js
  const rest=l.slice(l.indexOf('=')+1).split(',');
  if(rest.length>=4){
    const ci=parseInt(rest[0].trim())-1;
    const unit=(rest[1]||'').trim();
    const qi=parseInt(rest[3].trim());   // <-- assumes description is exactly one comma-free token
    if(!isNaN(ci)&&!isNaN(qi)){ colMap[qi]=ci; unitMap[qi]=unit; }
  }
  ```
  The GEF-CPT format is `#COLUMNINFO= colIndex, unit, description, quantityNumber`, where the **quantity number is the last field**. Dutch descriptions frequently contain commas (e.g. `Plaatselijke wrijving, fs` or `gecorrigeerde diepte, NAP`). With such a description, `rest[3]` becomes a text fragment, `parseInt` yields `NaN`, the `!isNaN(qi)` guard fails, and the column is **silently never mapped**. If this happens to the qc or fs column, the entire quantity is lost (qc loss => no usable rows; fs loss => Rf falls back to the `(rf??3)` default), with no error surfaced. This is a real-data correctness hazard, not a theoretical one.
- **Recommendation:** Read the quantity id from the **last** comma-separated token (`rest[rest.length-1]`) rather than `rest[3]`, and treat everything between the unit and the last token as the (possibly comma-containing) description.

### [CPT-PARSE-IMPORT-A-02] high · GEF `u2` is never unit-converted; declared COLUMNINFO unit is captured but ignored
- **Location:** `legacy-controller.js:1594` (`const u2_v=get(6)`), `1608` (`const u2=u2_v!=null&&!isNaN(u2_v)?u2_v:null`); consumed at `2075` and `2119` (`qtCone = r.qc + (1-aRatio)*r.u2`)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** qc and fs are routed through `cptValueToMPa(value, unitFor(qid), kind)` (lines 1598-1599), but u2 is stored raw with no unit handling — the declared unit `unitMap[6]` is captured (line 1554) yet `unitFor(6)` is never called anywhere in the file (verified by grep). Downstream, the corrected cone resistance is computed as `qt = qc + (1-a)*u2` with qc in MPa, so u2 is implicitly assumed MPa. The doc (logic.md:40) states "u2: used as-is (expected MPa in the GEF file)", so doc and code agree — but the GEF standard permits u2 in kPa, and when a file declares u2 in kPa the qt correction is wrong by a factor of ~1000 in the `(1-a)*u2` term (with a≈0.8, the error term is `0.2*u2`, e.g. a 200 kPa pore pressure mis-scaled to 200 MPa added to qc). This then feeds Qt/Fr/Ic in classification. The fix infrastructure (`cptValueToMPa(..., 'fs')`-style) already exists.
- **Recommendation:** Convert u2 with the declared unit, e.g. `cptValueToMPa(u2_v, unitFor(6), 'u2')` (add a u2 fallback branch analogous to fs), and update logic.md:40 to state the unit is honoured rather than "used as-is".

### [CPT-PARSE-IMPORT-A-03] medium · No `#COLUMNVOID` (sentinel) handling — void values enter qc/fs/u2/z directly
- **Location:** `legacy-controller.js:1531-1614` (whole GEF data loop; no COLUMNVOID branch — verified by grep, no `columnvoid`/`9999`/sentinel logic in file)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** GEF declares per-column sentinel values via `#COLUMNVOID= colIndex, voidValue` (commonly `-9999`, `999.999`, `-99999`). The parser never reads `#COLUMNVOID` and passes whatever number is present straight through `get(qid)`. The only implicit guards are `z<0` and `qc<0.02`. A positive sentinel such as `999.999` in qc survives (treated as 999.999 MPa), an fs sentinel survives into Rf, and a u2 sentinel survives into qt. This can corrupt a reading or an entire layer silently. The `qc<0.02` filter only catches the case where the void value happens to be small/negative.
- **Recommendation:** Parse `#COLUMNVOID` lines, build a per-quantity void map, and treat a value equal to its declared void as missing (null) before unit conversion and filtering.

### [CPT-PARSE-IMPORT-A-04] medium · GEF data section always split on whitespace — `#COLUMNSEPARATOR` ignored
- **Location:** `legacy-controller.js:1582` (`const parts=l.split(/\s+/).filter(Boolean);`); no `#COLUMNSEPARATOR` handling (verified by grep)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** GEF allows a declared `#COLUMNSEPARATOR=` (e.g. `;` or `,`). The data loop unconditionally splits on `/\s+/`. A GEF using a semicolon/comma separator would produce single-token "numbers" like `"1.5;2.3;..."`, which `parts.map(Number)` turns into `NaN`, so `vals.some(v=>isNaN(v))` skips every data row and the import yields zero rows (caught by the `!rows.length` alert, so at least it fails loudly rather than silently). Most GEF-CPT files use whitespace, so likelihood is moderate, but the failure is total when it occurs.
- **Recommendation:** Read `#COLUMNSEPARATOR` (and optionally `#RECORDSEPARATOR`) and split the data section accordingly, defaulting to whitespace when absent.

### [CPT-PARSE-IMPORT-A-05] medium · GEF rows are never sorted or checked for depth monotonicity (CSV/Excel are sorted)
- **Location:** `legacy-controller.js:1611-1623` (GEF: no `rows.sort`); contrast Excel `1373` and CSV `1508` which both do `rows.sort((a,b)=>a.z-b.z)`. Consumers assume order: `applyParsedCpt` `depthMin:rows[0].z, depthMax:rows[rows.length-1].z` (1298); `runClass` `max depth = cl[n-1].z` (2316); `segmentSummary` `bot = last row z`, `thk = bot-top` (2350-2371).
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** The GEF path trusts the file to be depth-ordered. If a GEF is out of order (or contains a reversed/append tail), `depthMin`/`depthMax`, the reported max depth, and per-segment thickness (`bot-top`, which can go negative) are all computed wrong, and `segmentTop`'s midpoint logic mis-locates boundaries. The doc does not promise monotonicity, but it also does not warn that GEF order is assumed. Normal GEF output is ordered, so impact is conditional.
- **Recommendation:** Sort GEF rows by `z` after parsing (as CSV/Excel already do) and/or drop strictly non-increasing duplicates; this makes the three parsers consistent.

### [CPT-PARSE-IMPORT-A-06] low · Two different default water-table values (1.7 vs 1.5) depending on code path
- **Location:** `legacy-controller.js:116` (`wt:1.7` in `newCptState`) vs `1284` (`S.wt=waterLevel??1.5` in `applyParsedCpt`); demo uses 1.7 (`1931`)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** A freshly created CPT tab carries `wt=1.7` m; but as soon as a file without a water-level header is imported, `applyParsedCpt` overwrites it with `1.5` m. So the "application default" depends on whether import ran, and the two constants disagree. The doc (logic.md:54) only says "application default" without a number, so it cannot adjudicate. This shifts the phreatic surface by 0.2 m for files lacking a WT, mildly affecting classification/effective stress.
- **Recommendation:** Pick one documented default constant and use it in both places (and in the demo), then state the number in logic.md:54.

### [CPT-PARSE-IMPORT-A-07] low · `#PROJECTID`/`#TESTID`/`#STARTDATE`/`#FILEOWNER` use `split('=')[1]` — undefined deref if `=` missing; loses text after a second `=`
- **Location:** `legacy-controller.js:1570-1573`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** `meta.project=l.split('=')[1].trim()` throws `TypeError` if a malformed header line lacks `=` (the `[1]` is undefined). It is inside the per-line work that is wrapped by the import-level try/catch (`importCptFiles` 350-353), so a single bad header aborts the whole import with a generic alert rather than skipping the line. Also, a value containing `=` is truncated to the first segment. Low likelihood (real GEF headers contain `=`), but it is a fragile parse.
- **Recommendation:** Use `l.slice(l.indexOf('=')+1).trim()` and guard for `indexOf('=')<0`.

### [CPT-PARSE-IMPORT-A-08] low · Async Excel import swaps the global `S` across an `await`, risking write into the wrong CPT
- **Location:** `legacy-controller.js:335-345` (`reader.onload=async e=>{ ... PROJECT.activeCptIdx=targetIdx; S=PROJECT.cpts[targetIdx]; ... ok=await parseExcelCpt(...)`); `applyParsedCpt` mutates whatever `S` currently is (1283-1314)
- **Category:** A — Implementation
- **Confidence:** likely
- **Analysis:** `parseExcelCpt` is `async` and awaits `loadXlsxModule()`/`XLSX.read`. During that await the event loop can run other handlers (e.g. a `selectCpt(...)` from a tab click), which reassign the module-global `S`. When the awaited parse resumes and calls `applyParsedCpt`, it writes `S.data`, `S.wt`, etc. into the CPT that is *currently* active, not the import target. Single-threaded UI makes this unlikely in practice, but it is a genuine reentrancy hazard inherent to driving parse state through a mutable global during async work. The GEF/CSV paths are synchronous and not affected.
- **Recommendation:** Pass the target CPT object explicitly to the parsers (or capture `const target=S` and write through `target`) instead of relying on the global `S` surviving the await.

### [CPT-PARSE-IMPORT-B-01] low · Layer-merge passes recompute `segmentSummary` repeatedly with no memoization (O(N²) summaries on fine initial layering)
- **Location:** `legacy-controller.js:2552-2606` (`smartSimilarityReduce`, `enforceMinThicknessBySimilarity`), each calling `segmentSummary` (2346-2372) for left/right/outer on every pair every pass
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** Both reduce loops are `while(changed)` and, on each pass, call `segmentSummary` ~4× per adjacent pair; each `segmentSummary` re-iterates all rows in a segment (averages of qc/fs/rf, subtype counts). Since each merge removes one segment, the number of passes scales with the segment count, giving roughly O(segments² × rows-per-segment) summary work with full recomputation each pass — nothing is cached even though segment contents only change at the merge site. For typical CPTs (≈1000 readings, tens of segments post-classification) this is negligible, but a pathologically fine initial layering (many single-reading segments) makes it quadratic and main-thread-blocking.
- **Recommendation:** Memoize `segmentSummary` per segment object (invalidate only the two segments touched by a merge), or precompute summaries once per pass and update incrementally.

### [CPT-PARSE-IMPORT-C-01] medium · Doc claims all-zero terminal rows are discarded; GEF parser has no such filter
- **Location:** Doc: `docs/logic.md:47` ("All-zero row (terminal row sometimes appended by logging software)"). Code: GEF data loop `legacy-controller.js:1581-1614` filters only `z<0` and `qc<0.02`; no all-zero / all-fields check exists (verified by grep — no `every`/all-zero logic).
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) The doc lists three discard rules, including all-zero terminal rows. (2) The code implements only `z<0` and `qc<0.02 MPa`. An all-zero row is in fact caught incidentally because `qc=0 < 0.02`, so the *effect* roughly holds for all-zero rows — but a row that is zero except for a nonzero depth, or a sentinel-laden terminal row, is not what the doc describes and is not handled as a distinct rule. (3) Scientifically the `qc<0.02` engagement filter is the correct primary guard; an explicit all-zero rule is a reasonable extra but currently absent. (4) Fix direction: either add the explicit all-zero filter the doc promises, or soften the doc to state that the `qc<0.02` rule subsumes all-zero terminal rows (and note that it does NOT remove sentinel rows — see A-03).
- **Recommendation:** Align by adding the all-zero filter, or amend logic.md:47 to describe the actual behaviour.

### [CPT-PARSE-IMPORT-C-02] low · Doc says u2 "expected MPa, used as-is"; this documents a latent unit bug rather than correct behaviour
- **Location:** Doc: `docs/logic.md:40`. Code: `legacy-controller.js:1594,1608` (raw u2). Cross-ref A-02.
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) Doc states u2 is used as-is and assumed MPa. (2) Code matches the doc (no conversion). (3) The GEF standard allows u2 in kPa; the scientifically correct behaviour is to honour the declared `#COLUMNINFO` unit (which the parser already captures), exactly as qc and fs are handled. So here doc and code agree, but both are wrong relative to the standard. (4) Fix direction: fix the **code** (convert via declared unit), then update the doc to match.
- **Recommendation:** Implement unit-aware u2 (A-02) and revise logic.md:40.

### [CPT-PARSE-IMPORT-C-03] low · Doc table 1.6 omits the Excel-only header fields actually parsed (Beta, Cone Number, Penetration depth, Operator, coordinates)
- **Location:** Doc: `docs/logic.md:30, 67-76`. Code: `legacy-controller.js:1377-1388` parses `Beta Factor`, `Conus Nummer`/`Cone Number`, `Penetratiediepte`/`Penetration depth`, `Operator`, `E/N Coordinate`.
- **Category:** C — Doc vs code
- **Confidence:** confirmed
- **Analysis:** (1) The doc lists GEF header fields and a brief Excel summary (line 30) but does not enumerate the Excel `betaFactor`/`coneNumber`/`penetrationDepth`/`operator` fields the code reads. (2) The code parses and stores them in `meta`. (3) Neither side is "wrong" scientifically; this is a completeness gap. Note `betaFactor`/`coneNumber`/`penetrationDepth` are parsed but never consumed (see D-04). (4) Fix direction: either document these Excel fields, or stop parsing the unused ones.
- **Recommendation:** Update logic.md to list the Excel header fields, or remove the dead ones.

### [CPT-PARSE-IMPORT-D-01] low · `loadSingleGEF` is dead — no callers, not exported
- **Location:** `legacy-controller.js:1949-1954`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `loadSingleGEF(evt)` reads a single file and calls `parseGEF` directly (bypassing format detection and the multi-CPT loader). Grep across `src/` finds no callers and it is absent from the export block at ~18284 (which exports `loadGEF`, `loadDemo`). It is a superseded single-file loader replaced by `importCptFiles`/`loadGEF`.
- **Recommendation:** Flag for removal; confirm no dynamic/global reference first.

### [CPT-PARSE-IMPORT-D-02] info · `importGEFFiles` is a redundant one-line alias for `importCptFiles`
- **Location:** `legacy-controller.js:372-374`, used only by the drop handler at `1963`
- **Category:** D — Dead code (duplicate logic)
- **Confidence:** confirmed
- **Analysis:** `function importGEFFiles(files){ importCptFiles(files); }` adds no behaviour; the drop handler could call `importCptFiles` directly. The name is also misleading since the loader handles Excel/CSV too. Harmless but redundant indirection.
- **Recommendation:** Flag; inline `importCptFiles` at the call site and drop the alias.

### [CPT-PARSE-IMPORT-D-03] info · Redundant identical ternary in `formatExcelHeaderValue`
- **Location:** `legacy-controller.js:1199` (`return Number.isInteger(value)?String(value):String(value);`)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** Both branches return `String(value)`, so the `Number.isInteger` test is a no-op. Likely a leftover from an intended integer/float formatting split.
- **Recommendation:** Flag; collapse to `return String(value);` or implement the intended distinct formatting.

### [CPT-PARSE-IMPORT-D-04] info · Excel `betaFactor`, `coneNumber`, `penetrationDepth` parsed and stored but never read
- **Location:** `legacy-controller.js:1380,1387,1388` (parse) and `1409-1412` (store into meta); no downstream reads (verified by grep — only the definition/store sites match)
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** These three Excel header values are extracted and placed in `meta` but never displayed, exported, or used in any calculation. `coneNumber`/`penetrationDepth` are at least plausible future metadata; `betaFactor` has no consumer anywhere. They are inert payload.
- **Recommendation:** Flag; either surface them (metadata panel / report) or remove the parsing, and reconcile with C-03.

## Notes / limitations of this audit pass
- I read the parse/import/layer-detection regions of `legacy-controller.js` (≈ lines 110-380, 1150-1640, 1700-1960, 2017-2110, 2290-2670) plus all of `dxf-terrain.js` and Stage 1 / parts of Stage 2 of `logic.md`. The remaining ~16k lines of `legacy-controller.js` (chart rendering, Stage 6, walls, piles, seepage UI) were only grepped, so non-ingest consumers of parsed fields were spot-checked, not exhaustively traced.
- The Robertson 1990/2016 classification math itself is owned by the cpt-classification subsystem (audited separately); I cross-referenced it only insofar as parsed units (qc/fs MPa, u2 raw) flow into it. The doc-vs-standard adjudication on stress constants (γ=17/18, γ_w=9.81) was verified consistent and left to that audit.
- I could not exercise the parsers against real GEF files (no sample `.gef` in-repo was opened); findings A-01/A-03/A-04 are reasoned from the GEF-CPT spec and the literal code, with confidence "confirmed" for the code behaviour and "real-data likelihood" stated qualitatively. A second pass with a corpus of Dutch GEF files (especially ones with comma-bearing COLUMNINFO descriptions, kPa-declared u2, and COLUMNVOID sentinels) would quantify how often A-01/A-02/A-03 actually bite.
- The async-reentrancy hazard (A-08) is rated "likely" for the mechanism but was not reproduced; it requires a user interaction during the Excel module/parse await.
