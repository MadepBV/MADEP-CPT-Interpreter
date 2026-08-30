# Audit — WASM bridge — wire format, pipeline, loader, runner, build-result
**Subsystem key:** def-wasm-glue
**Files reviewed:** src/lib/cpt-app/deformation/wasm/wire-format.js, src/lib/cpt-app/deformation/wasm/pipeline.js, src/lib/cpt-app/deformation/wasm/wasm-loader.js, src/lib/cpt-app/deformation/wasm/wasm-runner.js, src/lib/cpt-app/deformation/wasm/build-result.js, src/wasm/deformation/README.md, src/wasm/deformation/deformation_wasm.cpp (input reader + output writer), src/wasm/deformation/solver.hpp (strain/U_base path), src/lib/cpt-app/deformation/solver.js (element-cache GP indexing + pipeline call site), src/wasm/deformation/material_mc.hpp (tangent presence check)
**Finding counts:** critical=0 high=1 medium=2 low=4 info=3  |  A=3 B=1 C=4 D=2  |  total=10

## Overview
The JS↔C++ wire boundary is exceptionally tight and well disciplined: I traced every field of `encodeInputBuffer`/`decodeOutputBuffer` against the C++ `madepRunDeformationAnalysis` reader and writer offset-by-offset (header, regions incl. 13-f64 HS block, mechanical walls, constraints, RHS arrays, predictor block, per-GP initial σ/pore, RunSummary, displacements, wall stations, GP states, safety trials, safety curve) and every field order, type (u32/i32/u8/u16/f64), little-endian assumption, and computed byte-size constant agrees exactly. GP global indexing is element-major-sequential on both sides and matches. Heap views are re-read live after the solve (no stale-view-after-growth bug), and the runner frees all four `_malloc` blocks plus the C++ result buffer on every success and error path. The main correctness risks are not in the byte layout but in (1) the absence of a defensive `numGpTotal == numElements*numGpPerEl` check that the C++ trusts JS to get exactly right (potential WASM heap overwrite if a cache is malformed), and (2) a paired README that is badly stale (says "wire version 2", declares Hardening-Soil and consistent tangent "out of scope" when both are fully implemented and exercised by this very bridge).

## Findings

### [DEF-WASM-GLUE-A-01] high · C++ trusts JS `numGpTotal`; no bounds check before writing `materialPoints[idx]`
- **Location:** `src/wasm/deformation/deformation_wasm.cpp:640-650` (allocation + fill); JS source of the count: `src/lib/cpt-app/deformation/wasm/pipeline.js:40-46,100` (`countIntegrationPoints`)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** The wire carries `numGpTotal` as a u32 (header field 10). The C++ allocates `std::vector<MaterialPoint> materialPoints(numGpTotal)` (line 640) and then fills it via an element loop that writes `materialPoints[idx]` for `idx = 0 .. numElements*numGpPerEl - 1`, where `numGpPerEl` is recomputed in C++ as 3 (T6) / 1 (T3):
  ```cpp
  for (std::uint32_t e = 0; e < numElements; ++e) {
    for (int g = 0; g < numGpPerEl; ++g) {
      el.mpIdx[g] = idx;
      materialPoints[static_cast<std::size_t>(idx)].regionIndex = el.regionIndex;  // no bound check
      ++idx;
    }
  }
  ```
  There is **no check** that `numGpTotal == numElements * numGpPerEl`. The JS encoder derives `numGpTotal` from `countIntegrationPoints(elementCaches)` which is `Σ (ec.numGaussPoints || ec.integrationPoints?.length || 1)` — a fallback chain that yields **1** for any element cache that is missing both `numGaussPoints` and `integrationPoints`. For a T6 mesh the C++ assumes 3 GP/element unconditionally; a single malformed/partial T6 cache would make JS send `numGpTotal < numElements*3`, and the C++ fill loop then writes past the end of the `materialPoints` vector → WASM linear-memory corruption (silent wrong answers or a trap), and the output writer would also read those out-of-range points. In the normal path `numGaussPoints` is always set from the kernel (element-kernel.js: 1 for T3, 3 for T6) so the counts match and nothing fires — but the boundary has no defense, and the C++ explicitly relies on JS computing this exactly. This is the highest-risk item in the subsystem precisely because it is a JS↔WASM serialization invariant enforced on neither side.
- **Recommendation:** Add a guard in the C++ reader: reject (return 0 with `g_last_error`) unless `numGpTotalU == numElements * numGpPerEl`. Independently, harden the JS `countIntegrationPoints` fallback to use `numGpPerEl` per element-type rather than defaulting to 1, or assert `numGpTotal === numElements * (elementType==='t6'?3:1)` before encoding.

### [DEF-WASM-GLUE-A-02] medium · Output decoder accepts legacy versions 6/7/11 but decodes them with the v12 body layout
- **Location:** `src/lib/cpt-app/deformation/wasm/wire-format.js:449-457` (version gate) and the entire decode body 458-792 (assumes v12)
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** `decodeOutputBuffer` accepts `version ∈ {12, 11(SHARED_TANGENT), 7(SAFETY_HISTORY), 6(LEGACY)}`. After the summary it reads the v12 layout largely unconditionally: it always reads the MC-tangent byte per GP (line 576), always calls `readHsState` keyed on `hasHsPayload` (which is `version >= 10 ? readU8() : ...`), and the wall-results block is gated on `version >= WALL_BEAM_OUTPUT_WIRE_VERSION (=12)`. A genuine v6/v7/v11 buffer does not have the v12 GP byte/wall layout at those offsets, so it would mis-parse silently (offsets drift; no magic re-check downstream). The C++ only ever emits version 12 (`WIRE_VERSION = 12u`, single `write_u32(q, WIRE_VERSION)` site), so today no legacy buffer is ever produced and the branch is unreachable in production — but the acceptance list is a latent foot-gun: it invites "compatibility" that the body cannot actually deliver, and it weakens the version handshake to a near no-op.
- **Recommendation:** Either (a) tighten the gate to `version === WIRE_VERSION` (the C++ already does exactly this on input: `version != WIRE_VERSION` → error), or (b) if true backward-compat is desired, add real per-version branching in the body. Given only v12 is emitted, (a) is the honest fix and removes the dead tolerance.

### [DEF-WASM-GLUE-A-03] medium · C++ input-length check uses `>` (accepts over-long buffers); JS exact-size only verified implicitly
- **Location:** `src/wasm/deformation/deformation_wasm.cpp:549-552`; JS sizing `src/lib/cpt-app/deformation/wasm/wire-format.js:118-146,283`
- **Category:** A — Implementation
- **Confidence:** confirmed
- **Analysis:** The only buffer-bounds validation on the C++ side is *after* parsing:
  ```cpp
  if (static_cast<std::size_t>(p - inputPtr) > inputLen) { g_last_error = "WASM input buffer truncated"; return 0; }
  ```
  This is checked only once, at the end, so a buffer that is *shorter* than required is read out-of-bounds during parsing (the reads at lines 384-547 run before the check; the check then catches that `p` overran, but the OOB reads already happened on the WASM heap). A buffer that is *longer* than required passes the `>` check silently. The JS `computeInputSize` and the C++ reader were verified to agree field-for-field, so in practice the lengths match exactly; the risk is purely defensive-robustness against a malformed/truncated buffer (e.g. a future schema drift on one side only). Note also the reads themselves are unchecked `memcpy`s from `p`, so a truncated input is a read-past-end before the trailing guard ever runs.
- **Recommendation:** Validate the expected total length up front (compute the exact required size from the header counts and compare `== inputLen`, or at minimum `>=` before each section), mirroring the precise JS `computeInputSize`. Consider a CRC/size field for defense in depth.

### [DEF-WASM-GLUE-B-01] low · Whole input buffer is rebuilt and copied JS→WASM each run; large meshes pay an extra full-array copy
- **Location:** `src/lib/cpt-app/deformation/wasm/wire-format.js:283-432` (ArrayBuffer alloc + per-element f64 writes) and `src/lib/cpt-app/deformation/wasm/wasm-runner.js:44-46` (`HEAPU8.set`)
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** `encodeInputBuffer` allocates one `ArrayBuffer(size)` and fills it field-by-field via `DataView` scalar writes, including the three full-DOF RHS arrays and the per-GP σ (6·numGpTotal f64) and pore arrays. The runner then `_malloc`s and `HEAPU8.set`s the whole thing — a second full copy into WASM memory. For the dominant T3 CPT workload this is small, but for large T6 meshes the per-scalar `DataView.setFloat64` loop over `6*numGpTotal` plus three `ndof`-length loops is non-trivial main-thread work and a redundant copy. This is run-once-per-analysis (not a hot inner loop) and the pipeline runs in a worker, so impact is bounded; flagged as an efficiency note, not a leak. No memory leak: the `ArrayBuffer` is GC'd and all WASM blocks are freed (see runner 44-92).
- **Recommendation:** Optional. For large meshes, bulk-copy the already-Float64Array RHS/σ/pore sections via `new Float64Array(buffer, byteOffset).set(src)` instead of scalar `writeF64` loops, and consider building directly into a `HEAPU8` subarray to skip the extra `.set` copy.

### [DEF-WASM-GLUE-C-01] high · README states "wire version 2" throughout; actual `WIRE_VERSION = 12`
- **Location:** `src/wasm/deformation/README.md:28,70,78,80` vs `src/lib/cpt-app/deformation/wasm/wire-format.js:10` and `src/wasm/deformation/deformation_wasm.cpp:190`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) Doc: README says "Encode the input buffer / decode the output buffer (wire version 2)", "### Wire format (version 2)", "both with version 2", and "Bump the version constant … if you change the schema." (2) Code: both sides define and enforce version **12** (`WIRE_VERSION = 12` in JS; `constexpr std::uint32_t WIRE_VERSION = 12u` in C++, checked on input at deformation_wasm.cpp:304 and written on output at :760). (3) The code is correct — version 12 is what is actually serialized and validated. (4) Fix the doc: update all "version 2" references to 12 and note the live-version constant location. (Also `wire-format.js:436` JSDoc "Decode the WASM output buffer (v2)" and `build-result.js:5` "WASM v2 solver output" carry the same stale "v2" label.)
- **Recommendation:** Fix doc/comments (README §"Wire format", the JS JSDoc at wire-format.js:436 and build-result.js:5). No code change.

### [DEF-WASM-GLUE-C-02] high · README declares Hardening-Soil and consistent/algorithmic MC tangent "out of scope", but both are implemented and driven through this bridge
- **Location:** `src/wasm/deformation/README.md:99,102-106,125-137` vs the HS/consistent-tangent wire + code paths
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) Doc: README "Out of scope (deliberately)" lists "Consistent (non-modified) algorithmic MC tangent …", "Hardening Soil and other future constitutive plugins"; the "Precision" section says "The WASM module currently uses **modified Newton** (elastic tangent at yielding Gauss points)." (2) Code: this very bridge has a full HS path — `constitutiveKindFor('hardening-soil') → HardeningSoil` (wire-format.js:65), a 13-f64 HS region block (writeHsParams), a `hasHsPayload` output flag, per-GP HS state decode (`readHsState`), HS aggregates in build-result, and C++ `material_hs.hpp` (4490 lines) wired in at deformation_wasm.cpp:554-561,738. A consistent/continuum MC tangent exists (`material_mc.hpp:283 continuum_tangent_mc_global`, selected via `symmetrizeTangent`/`useMcConsistentTangent`, MC-tangent-mode byte on the wire) and GMRES dispatch + arc-length continuation are present (summary `hsPlasticUsedGmres`, `lastLinearSolverKind`, arc-length safety-curve fields). (3) The code is current and correct; the README "Architecture/Precision/Out of scope" sections describe a much earlier MC-only modified-Newton module. This is the most misleading doc gap because an engineer reading the README would conclude HS results from the WASM backend are impossible, when they are in fact produced and rendered. (4) Fix the doc.
- **Recommendation:** Rewrite README §Precision and §"Out of scope" to reflect HS support, the consistent-tangent selector, GMRES, and arc-length continuation. No code change.

### [DEF-WASM-GLUE-C-03] medium · README "Multi-phase analysis modes" / input-field list is stale and incomplete vs the v12 wire
- **Location:** `src/wasm/deformation/README.md:59-90` vs `wire-format.js:118-146,254-433` and `deformation_wasm.cpp:302-547`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) Doc: README "Input fields (in order): nodes, elements, regions, fixed-DOF list, full gravity-DOF RHS, full surface-load RHS, per-GP initial K0 stress, per-GP pore pressure." (2) Code: the actual v12 input also contains, in order, a 312-byte header with ~28 tolerance/continuation/safety/arc-length f64 controls and mode bytes, a **mechanical-walls block** (between regions and constraints), and a **full-DOF predictor-displacement block** (between the two RHS arrays and the initial-σ block). The README omits all of these. The README also doesn't mention that DOF count is `max(ndofTotal, 2·numNodes)` to accommodate appended wall-rotation DOFs. (3) The code is correct (the wire is what is actually exchanged). (4) Fix the doc to list the real field order, or point to the authoritative byte-layout comment in deformation_wasm.cpp:5-109.
- **Recommendation:** Update README §"Wire format" input/output field lists. No code change.

### [DEF-WASM-GLUE-C-04] low · README/JS comments say the predictor block is "K0 predictor U" consumed for strain "at predictor + correction"; the C++ solver skips it (`U_base = nullptr`)
- **Location:** `wire-format.js:245,424-426` (JSDoc + comment) vs `deformation_wasm.cpp:530-538` and `solver.hpp:52-69`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) JS comment at wire-format.js:424-426: "Elastic K0 predictor displacement (full DOF). WASM solves correction displacements, but constitutive strain is evaluated at predictor + correction." (2) Code: the C++ reader explicitly **skips** the predictor bytes (`p += ndof * sizeof(double)`, lines 538) and the solver runs `strain_at_gauss(..., U_base=nullptr, ...)` (solver.hpp:63 → predictor not added). The C++ comment (lines 530-537) is candid: "The solver does not consume it — strain and beam internal force run with U_base = nullptr — so the bytes are skipped." Net effect is still correct end-to-end: the K0 stress was pre-baked into `initialSigma`, the C++ measures incremental displacement from that seeded state, and `build-result.js` (`applyPredictorToSolution`) adds the predictor back to recover total physical displacement — verified no double-count (predictor = `geostatic.solution`, the elastic-gravity displacement, solver.js:6698). So the engineering result is right; only the JS-side comment/JSDoc claiming the WASM constitutive update uses "predictor + correction" is inaccurate. (3) The C++ behavior is the operative one; the JS comment is the wrong description. (4) Fix the JS comment to match: the predictor block is wire-reserved padding the solver ignores; total displacement is reconstructed in build-result.
- **Recommendation:** Correct the comment/JSDoc at wire-format.js:245 and 424-426. No behavioral change.

### [DEF-WASM-GLUE-D-01] low · Legacy output-version constants and v<12 decode branches are effectively dead
- **Location:** `wire-format.js:12-14` (`SHARED_TANGENT_OUTPUT_WIRE_VERSION=11`, `LEGACY_OUTPUT_WIRE_VERSION=6`, `SAFETY_HISTORY_OUTPUT_WIRE_VERSION=7`) and the `version >= 7` / `version >= 8` / `version >= 10` conditional branches in `decodeOutputBuffer`
- **Category:** D — Dead Code
- **Confidence:** confirmed
- **Analysis:** The C++ only ever writes `WIRE_VERSION = 12`, so the decoder's lower-version branches (`version >= 7`, `version >= 8`, `version >= 10`, the `else` legacy-trial branch at lines 620-628, and the `version >= WALL_BEAM_OUTPUT_WIRE_VERSION` else-path) are never taken in production. They are not merely unused — see DEF-WASM-GLUE-A-02 — they are also incapable of correctly parsing the older formats given the rest of the body. The constants are referenced only by the over-broad version gate.
- **Recommendation:** FLAG ONLY. Either delete the legacy version tolerance (recommended, pairs with A-02) or restore genuine version branching; do not leave half-supported.

### [DEF-WASM-GLUE-D-02] info · `decodeOutputBuffer` always allocates `safetyTrials`/`safetyCurve`/`emptyMechanism` even for non-safety runs
- **Location:** `wire-format.js:592-764` (safety block always parsed); `build-result.js:726-745` `emptyMechanism` literal
- **Category:** D — Dead Code (minor)
- **Confidence:** confirmed
- **Analysis:** The output always carries the safety header + (empty) trial/curve arrays even for Mode-1 (non-safety) runs, so the decoder always walks the safety section; `summary.safetyRan` then gates whether the parsed arrays are surfaced (`summary.safetyRan ? safetyCurve : []`). This is benign and by design (fixed-layout wire), but the parsed-then-discarded arrays for non-safety runs and the always-constructed `emptyMechanism` object are minor redundant work/allocation. Not a correctness issue.
- **Recommendation:** FLAG ONLY. Acceptable as-is given the fixed wire layout; no action required.

## Notes / limitations of this audit pass
- I verified the wire format by reading both ends (JS `wire-format.js` and the C++ reader/writer in `deformation_wasm.cpp`) and cross-checking every field offset, type, count, and the six byte-size constants (`kInputHeaderBytes=312`, `kSummaryBytes=88`, `kGpStateBytes=284`, `kHsGpStateBytes=32`, `kSafetyHeaderBytes=48`, `kSafetyTrialBytes=40`, `kSafetyCurvePointBytes=200`). All agreed. I did **not** independently re-derive `types.hpp` struct member padding for `RegionParams`/`MaterialPoint`/`WallBeam` because the wire uses explicit scalar reads/writes (no `memcpy` of whole structs across the boundary), so host struct padding does not affect the wire — a quick grep confirmed the C++ uses field-by-field `read_*`/`write_*`, not bulk struct copies, for the wire.
- I did not execute the build (`npm run build:wasm:deformation`) or the parity scripts (`verify_wasm_cpu_parity.mjs`, `verify_hs_app_safety_path.mjs`, `verify_wall_beam_wasm_pipeline.mjs`); my offset cross-check is static. A dynamic run would confirm A-01's bound assumption holds for all production meshes.
- I confirmed the predictor is not double-counted by tracing `predictorSolution = geostatic.solution` (solver.js:6698) and the C++ `U_base=nullptr` strain path; if the geostatic seeding semantics change upstream, re-verify C-04/A-related reconstruction in `build-result.js`.
- Numerical/constitutive correctness *inside* `solver.hpp`/`material_*.hpp` (return mapping, consistent tangent, c-φ bracketing) is outside this subsystem's scope and was only touched where it bears on the wire (U_base path, GP indexing, tangent-mode byte). A separate solver-internals pass is warranted.
