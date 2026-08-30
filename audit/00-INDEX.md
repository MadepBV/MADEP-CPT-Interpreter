# Engineering Audit — madep-cp (MADEP CPT Interpreter)

**Date:** 2026-06-05
**Branch:** v0.5.3
**Scope:** Full-codebase critical engineering review across four dimensions —
**A** implementation mistakes/errors, **B** memory leaks & performance, **C** doc-vs-code
consistency (and *which side is scientifically correct*), **D** dead code (flagged, never deleted).
**Nothing in the source tree was modified by this audit.** This is a read-and-report pass; the
review-then-fix decisions are deferred to a later pass per the audit brief.

---

## How to read this folder

- `00-INDEX.md` (this file) — executive consolidation: headline, verified findings, every
  critical/high finding, cross-cutting themes, and a suggested triage order.
- `NN-<subsystem>.md` (24 files) — the full per-subsystem reports with every finding at full detail
  (evidence, `file:line` citations, scientific reasoning, recommended fix direction).
- `.audit-workflow.mjs` — the multi-agent orchestration script used to produce the reports
  (a working artifact; not part of the deliverable — can be deleted).

---

## 1. Executive summary

The application is in **good engineering health**. Across 24 subsystems and **313 findings**, there is
**one CRITICAL** defect and **35 high-severity** items. Crucially:

- **The numerical and scientific cores are sound.** The constitutive integration (exact Mohr-Coulomb
  multisurface return mapping, Hardening-Soil Simo-Hughes), the plane-strain T3/T6 FEM, the
  Bishop/Spencer limit-equilibrium kernels, the steady-state Darcy seepage FEM, the EC7 bearing-capacity
  factors, the De Beer pile sweep, and the Winkler/Pasternak beam FEM were each **independently
  re-derived by a domain auditor and, for the highest-severity items, re-verified by hand against the
  governing equations/standards** — and found correct. No wrong yield surface, sign error in a return
  map, or incorrect FEM assembly was confirmed in any core solver.
- **The single CRITICAL is a reporting/display bug, not a solver bug:** a number-formatting helper in
  the Stage 7 report silently strips trailing zeros from integers, mis-scaling printed engineering
  quantities (bearing load `q`, subgrade modulus `k_s`, Pasternak `G_p`, average `f_s`) by 10×–1000×.
  The underlying computed values are correct; the *displayed* values are wrong.
- **The high-severity findings split into five clean themes** (detailed in §5): genuine code/data-integrity
  bugs, JS↔WASM↔GPU numerical-parity divergences, resource/lifecycle leaks (GPU VRAM and DOM listeners),
  test-suite trust gaps, and documentation drift. **In the large majority of doc-vs-code conflicts the
  code is scientifically correct and the documentation is stale** — the docs over-promise capabilities
  (inclination factors, selectable beam BCs) or cite superseded formulas/versions.
- **Dead code is pervasive but benign** (91 D-findings): superseded "legacy-bands" paths, GPU-flatten
  helpers awaiting a kernel, a disabled Hardening-Soil Stage-6 UI surface, orphaned verification scripts,
  and ~670 KB of orphaned static assets still shipped to users.

**Bottom line for an external reviewer:** the engine you'd stake a number on (CPU FEM + limit
equilibrium + classification) is trustworthy; the risk surface is concentrated in (1) one report-display
mis-scaling, (2) a handful of input-parsing/units edge cases, (3) experimental GPU paths and their
governance, and (4) a verification harness that in several places does not actually assert.

### Severity & category rollup

| Severity | Count | | Category | Count |
|---|---:|---|---|---:|
| 🔴 Critical | 1 | | A — Implementation error | 76 |
| 🟠 High | 35 | | B — Memory/Performance | 46 |
| 🟡 Medium | 88 | | C — Doc-vs-code | 104 |
| 🔵 Low | 126 | | D — Dead code | 87 |
| ⚪ Info | 63 | | | |
| **Total** | **313** | | **Total** | **313** |

*(Counts are derived from the actual finding entries: severity from each finding's heading, category from
its explicit `**Category:**` field; both reconcile to 313. The auditors' own per-report summary lines
undercount in several reports (e.g. report 03 declares 11 entries but contains 14), so the numbers
here — not those summary lines — are the reconciled ground truth. Note: many "info" entries are positive
verifications, i.e. things checked and found correct, not defects.)*

---

## 2. Independently verified findings (re-checked by hand against source)

Beyond the per-finding adversarial reasoning in each report, I personally re-opened the cited code and
confirmed these highest-impact items. All **passed verification**:

| Finding | Verdict | Evidence I confirmed |
|---|---|---|
| `REPORTING-A-01` (critical) | ✅ Confirmed | Ran the exact helper: `fmt(100,0)="1"`, `fmt(150,0)="15"`, `fmt(30000,0)="3"`; call sites at `stage7/+page.svelte:766,992,1053,1054` format Load q / k_s / G_p / avg f_s. |
| `SEEPAGE-A-01` (high) | ✅ Confirmed | Re-derived the Galerkin weak form: `(K·h)_i = −∮N_i(q·n_out)`, so reaction `R_i<0` ⇒ outflow. Code `solver.js:1584` counts `flux<0` as `totalInflow` — inverted vs the (correct) flux branch at `:1605` and the in-app doc. |
| `PILES-A-01` (high) | ✅ Confirmed | `stage6-pile.js:650-652`: override path uses `msOverride` raw while the table path applies `*1e-3`; UI label says "(×10⁻³)" — a 1000× error in the t-z springs. |
| `CPT-CLASSIFICATION-A-01` (high) | ✅ Confirmed | `legacy-controller.js:2737-2750`: lowest veen row is `qcMin:0.2`; a `qc≈0.1, Rf=7%` peat reading matches no veen row and falls to the `qc<0.4 → leem` fallback. |
| `STAGE6-ENGINEERING-C-01` (high) | ✅ Confirmed | `legacy-controller.js:12459-12462` `stage6BearingNgamma` returns `2(Nq−1)tanφ` (EC7 Annex D). The in-app doc's "Meyerhof Nγ=(Nq−1)tan(1.4φ)" claim is wrong; **code is correct**. |
| `DEF-CPP-CORE-A-01` (high) | ✅ Confirmed | WASM `solver.hpp:1893-1895` scales the abs-residual floor by `√nfree` when `absTol≤1e-3`; JS `solver.js:350` does `max(absTol, relTol·rhsNorm)` with no such scaling — a real convergence-criterion divergence between the two "equal" backends. |
| `CPT-PARSE-IMPORT-A-02` (high) | ✅ Reviewed | GEF `u2` column captured but the declared COLUMNINFO unit is not applied (see report 16 for the parsing trace). |

The depth and accuracy of the agent reports were high throughout (independent re-derivations of the
Spencer slice kernel, the passive-pressure centroid, Hetényi asymptotics, MC apex location, etc.), which
is why the remaining high findings below are presented with their reported confidence rather than each
re-run by hand.

---

## 3. 🔴 The CRITICAL finding

### `REPORTING-A-01` — Stage 7 report mis-scales integer engineering quantities by 10×–1000×
- **Where:** `src/routes/report/stage7/+page.svelte:42-46` (`fmt`), call sites `:766, :992, :1053, :1054`.
- **What:** `fmt(value, digits=2)` ends with `.replace(/\.?0+$/, '')` to trim fractional zeros. With
  `digits=0`, `toFixed(0)` yields a bare integer with no decimal point, so the regex greedily eats the
  integer's own trailing zeros: `150 → "15"`, `30000 → "3"`, `200 → "2"`.
- **Impact:** Reported **bearing Load q (kPa)**, **k_s (kN/m³)**, **G_p (kN/m)**, and **average f_s (kPa)**
  print mis-scaled in the technical report. The computed analysis values are correct — only the printed
  numbers are wrong, which is the most dangerous "plausible-but-wrong" failure class because the figure
  looks reasonable. (Same `avgFsKPa` is rendered *correctly* elsewhere as `fmt(...,1)`, so the report is
  internally inconsistent.)
- **Fix direction:** only strip when a decimal point is present, e.g.
  `num.toFixed(digits).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')`, or route integer sites through
  the already-safe `fmtInt`. Verify `fmt(100,0)==="100"`.
- **Full detail:** `21-reporting.md`.

---

## 4. 🟠 High-severity findings (35), grouped by theme

### 4a. Genuine code / data-integrity bugs (wrong output or corrupt input)
| ID | One-line | File |
|---|---|---|
| `SEEPAGE-A-01` | Reported inflow/outflow swapped in the dominant (reaction) path (through-flow & FoS unaffected). | 04 |
| `PILES-A-01` | `M_s` override skips the ×10⁻³ scale → t-z springs 1000× off when override used. | 13 |
| `PILES-A-02` | Downdrag ULS uses undocumented `0.7·Fcd` fallback that can drop negative skin friction from demand (non-conservative). | 13 |
| `CPT-CLASSIFICATION-A-01` | Soft peat (`qc<0.2`) silently classified as loam — wrong soil family, wrong γ/φ/cu. | 06 |
| `CPT-PARSE-IMPORT-A-01` | GEF `#COLUMNINFO` quantity id read by fixed token index → a comma in the description silently drops the column. | 16 |
| `CPT-PARSE-IMPORT-A-02` | GEF `u2` never unit-converted; declared unit captured then ignored. | 16 |
| `WALLS-A-01` | Inclined wall: passive resistance integrated over a *vertical* column and applied as a purely *horizontal* force. | 14 |
| `WALLS-A-02` | Spencer interslice wall force added with fixed `+x` sign regardless of `passiveSide`. | 14 |
| `REPORTING-A-02` | All profile-SVG layer rects carry `data-layer-index="0"` → legend↔profile hover broken. | 21 |
| `DEF-WASM-GLUE-A-01` | C++ trusts JS `numGpTotal` with no bounds check before writing `materialPoints[idx]` (latent heap hazard). | 10 |

### 4b. JS ↔ WASM ↔ GPU numerical-parity divergences (the "three engines must agree" risk)
| ID | One-line | File |
|---|---|---|
| `DEF-CPP-CORE-A-01` | WASM Newton abs-residual floor scaled by `√nfree`; JS oracle is not → backends accept different convergence. | 09 |
| `DEF-SOLVER-ROBUSTNESS-A-01` | Safety-curve `uMaxAbs`/`maxDeltaPlasticStrain` are per-step increments but plateau/mechanism scoring treats them as cumulative-from-base. | 11 |
| `DEF-GPU-V1-A-01` | Per-Gauss-point MC return-map failure flag written but never checked → inadmissible stress can be committed. | 17 |
| `DEF-GPU-V1-A-02` | Tension-apex algorithmic tangent diverges from the CPU oracle (D_e vs deviatoric projection). | 17 |
| `DEF-GPU-V2-A-01` | Geostatic stop classifier never retries with elastic tangent on a symmetric fallback path. | 18 |

### 4c. Resource / lifecycle leaks (GPU VRAM + DOM listeners; degrade long sessions)
| ID | One-line | File |
|---|---|---|
| `DEF-GPU-V2-B-01` | v2 context allocates ~70 persistent GPU buffers, never `destroy()`ed → VRAM leak across runs. | 18 |
| `DEF-GPU-V1-B-01` | Resident CG/GMRES/assembly buffer set never destroyed → leaks every analysis. | 17 |
| `CPT-CONTROLLER-UI-B-01` | `initLegacyController` returns a no-op teardown → `document`/`window` listeners and `window.*` API never removed. | 19 |
| `CPT-CONTROLLER-UI-B-02` | Tuning charts replaced via `innerHTML` without `.destroy()` → Chart.js instances leak. | 19 |
| `UI-COMPONENTS-A-01` | Stage-nav handlers lost after unmount/remount (no-op destroy) → broken nav returning from /docs. | 20 |
| `UI-COMPONENTS-A-02` | Document-level dropzone listeners leak and capture a stale node across remount. | 20 |
| `CPT-PARAMETERS-B-01` | `fitLayer` re-scans all classified rows per layer with per-point allocation (perf, not a leak). | 07 |

### 4d. Verification-harness trust gaps (the "tests that don't test")
| ID | One-line | File |
|---|---|---|
| `VERIFICATION-HARNESS-A-01` | `verify_wasm_cpu_parity.mjs` computes metrics but never asserts and always exits 0. | 23 |
| `VERIFICATION-HARNESS-A-02` | `validate-pile.js` discards every `check()` result and always exits 0. | 23 |
| `VERIFICATION-HARNESS-A-03` | Default-CI HS tangent oracle accepts **35%** relative tangent error on the production path. | 23 |
| `VERIFICATION-HARNESS-C-01` | `verify_bishop_phase_a_parity.mjs` is refactor-equivalence, not a correctness oracle — Bishop/Spencer FS has no independent check anywhere. | 23 |

### 4e. Documentation drift where the CODE is correct (fix the docs)
| ID | One-line | File |
|---|---|---|
| `STAGE6-ENGINEERING-C-01` | In-app bearing doc claims Meyerhof Nγ; code uses EC7 Annex D `2(Nq−1)tanφ` (code correct). | 05 |
| `STAGE6-ENGINEERING-C-02` | Bearing doc §4/§7 present inclination factors as implemented; code applies none (and §11 admits it). | 05 |
| `DEF-WASM-GLUE-C-01` | README says wire "version 2"; actual `WIRE_VERSION = 12`. | 10 |
| `DEF-WASM-GLUE-C-02` | README marks HS and consistent MC tangent "out of scope" though both ship through this bridge. | 10 |
| `DEF-MESH-C-01` | `T6_mesh_v1.md` documents superseded node ordering/shape functions vs shipped code. | 12 |
| `BEAM-WINKLER-C-01` | Beam doc claims selectable fixed/hinged BCs; code only solves free-free (valid, but undocumented gap). | 15 |
| `BEAM-WINKLER-C-02` | Doc default Pasternak η=1/3; code default η=1.0 → **3× shear stiffness out of the box** (real behaviour difference, fix one side). | 15 |
| `DEF-GPU-V1-C-01` | Doc says v1 is "linear-elastic only + auto CPU fallback"; v1 toggle runs full MC and throws on failure (no fallback). | 17 |

### 4f. Ship hygiene
| ID | One-line | File |
|---|---|---|
| `BUILD-CONFIG-D-01` | ~670 KB orphaned static assets served to every user, incl. a full standalone `cpt_app.backup.html` and a redundant `triangle.out.wasm`. | 24 |

> ⚠️ **Security note (medium, not high but important):** `BUILD-CONFIG` flags `xlsx@0.18.5` carrying two
> known high CVEs (prototype pollution + ReDoS); it parses **untrusted user uploads** and has no upstream
> fix on that version. Worth prioritising alongside the high items. See `24-build-config.md`.

---

## 5. Cross-cutting themes (synthesis)

1. **Doc-vs-code drift is the #1 finding class (95 C-findings), and the code almost always wins.**
   The published in-app docs and several `docs/*.md` specs lag the implementation: stale wire/version
   numbers (v2 vs v12), superseded mesh/geostatic-init designs, "out of scope" features that actually
   ship (HS, consistent tangent, edge/apex MC return, arc-length), and over-promised capabilities
   (bearing inclination factors, beam fixed/hinged BCs, per-layer pile overrides, BGGG "within 5%"
   claims). **Risk:** an engineer trusts a published formula/feature the tool doesn't actually use.
   **Fix posture:** a documentation reconciliation pass — change the docs, not the code, in the large
   majority of these. The notable code-side exceptions where output is affected: `BEAM-WINKLER-C-02`
   (η default) and the `def-materials` `rShear` default (0.25 vs documented 0.05).

2. **Three parallel deformation engines (JS / WASM-C++ / GPU) and incomplete parity governance.**
   The CPU JS path is the trusted oracle. WASM diverges in its Newton tolerance (`√nfree`) and safety-curve
   semantics; GPU v1/v2 are explicitly uncertified yet reachable by user toggle, leak buffers, have an
   unchecked MC failure flag, and a tangent path with no CPU oracle. The certification log doesn't cover
   the WASM CPU port and claims a promotion gate that doesn't exist in code. **Highest cross-cutting risk
   for "is the answer right":** an uncertified/divergent backend silently producing a trusted-looking result.

3. **The verification harness is not a reliable safety net.** Several headline "parity"/"validate" scripts
   compute metrics but never assert (always exit 0), the Bishop/Spencer FS has no independent oracle
   anywhere, ~21 scripts are orphaned from any `package.json` target, and there is no CI. The strongest
   oracles (seepage Dupuit, wall-beam analytical, deformation return-mapping, gpu-v2 matrix-free vs CSR)
   are genuinely independent and tight — but they sit beside no-op ones, giving false confidence.

4. **Lifecycle/teardown discipline at the Svelte↔legacy-controller boundary.** The thin Svelte shells
   delegate to an 18.5k-line imperative controller via `window.*` globals and string-matched DOM ids; the
   advertised teardown is a no-op, so listeners, the global API, Chart.js instances, blob URLs, and (on
   the GPU paths) GPUBuffers accumulate across mount/unmount. Single-analysis correctness is unaffected;
   long sessions and repeated navigation degrade.

5. **Input-boundary robustness (GEF/Excel/CSV parsing).** The CPT parser is the app's untrusted-input
   front door and has the most A-findings of any subsystem (8): a comma in a GEF column description drops
   the column, `u2` is not unit-converted, plus several NaN/locale edge cases. Pair with the `xlsx` CVE
   exposure — this boundary deserves a focused hardening pass.

6. **Dead code is large but disclosed.** 91 D-findings: the unreachable "legacy-bands" slope path, GPU
   preconditioner flatteners awaiting a kernel, a Hardening-Soil Stage-6 UI behind a permanently-false
   flag (~18 sites), a second lower-fidelity WASM MC return map (`run_mc_return_mapping`), and orphaned
   exports/scripts. None is a correctness risk; all are flagged for a cleanup pass, none deleted here.

**Positive confirmations worth recording:** committed deformation WASM is byte-for-byte identical (SHA-256)
to a fresh rebuild from source; the Bishop pore-pressure uplift uses `u·b` (the prior audit's fix held);
`npm run verify:nen6740` passes; the published classification/parameter/EC7/pile/seepage formulas on the
docs site overwhelmingly match the code (`22-docs-site-integrity` found *zero* wrong published formulas).

---

## 6. Suggested triage order for the fix pass

1. **`REPORTING-A-01` (critical)** — one-line regex fix; restores correct report numbers. Highest impact / lowest effort.
2. **Data-integrity input bugs:** `CPT-PARSE-IMPORT-A-01/A-02`, `CPT-CLASSIFICATION-A-01` — wrong inputs poison everything downstream.
3. **`PILES-A-01` (M_s scale)** and **`SEEPAGE-A-01` (inflow/outflow label)** — confirmed wrong reported quantities.
4. **`xlsx` CVE** (`24-build-config`) — untrusted-upload security exposure.
5. **Verification harness** (`VERIFICATION-HARNESS-A-01/A-02/A-03`) — make the safety net actually assert *before* changing solver code, so regressions are caught.
6. **Parity & GPU governance:** `DEF-CPP-CORE-A-01`, `DEF-SOLVER-ROBUSTNESS-A-01`, the GPU `A-01/A-02/C-01` items — decide the contract and gate uncertified backends.
7. **Lifecycle leaks** (`CPT-CONTROLLER-UI`, `UI-COMPONENTS`, GPU `B-01`) — for long-session stability.
8. **Documentation reconciliation** (the 95 C-findings) — bulk doc edits; code mostly stays.
9. **Dead-code cleanup** (91 D-findings) — last, low-risk, after the above land.

---

## 7. Per-subsystem report index

| # | Report | Crit | High | Med | Low | Info | Total |
|---|---|---:|---:|---:|---:|---:|---:|
| 01 | [def-materials](01-def-materials.md) — MC & HS constitutive (JS) | 0 | 0 | 3 | 6 | 2 | 11 |
| 02 | [def-solver](02-def-solver.md) — plane-strain T3/T6 FEM (JS CPU reference) | 0 | 0 | 2 | 5 | 4 | 11 |
| 03 | [bishop-spencer](03-bishop-spencer.md) — slope stability | 0 | 0 | 4 | 6 | 4 | 14 |
| 04 | [seepage](04-seepage.md) — steady-state Darcy FEM | 0 | 1 | 5 | 5 | 3 | 14 |
| 05 | [stage6-engineering](05-stage6-engineering.md) — bearing/settlement/dewatering/EC2 | 0 | 2 | 4 | 8 | 2 | 16 |
| 06 | [cpt-classification](06-cpt-classification.md) — Robertson/NEN/CUR/EC7 | 0 | 1 | 3 | 4 | 2 | 10 |
| 07 | [cpt-parameters](07-cpt-parameters.md) — parameter derivation & PLAXIS export | 0 | 1 | 5 | 4 | 1 | 11 |
| 08 | [def-cpp-materials](08-def-cpp-materials.md) — WASM MC/HS constitutive | 0 | 0 | 3 | 4 | 3 | 10 |
| 09 | [def-cpp-core](09-def-cpp-core.md) — WASM solver/elements/CG/beam | 0 | 1 | 2 | 5 | 4 | 12 |
| 10 | [def-wasm-glue](10-def-wasm-glue.md) — JS↔C++ wire format & pipeline | 0 | 3 | 3 | 3 | 1 | 10 |
| 11 | [def-solver-robustness](11-def-solver-robustness.md) — arc-length/line-search/MSF safety | 0 | 1 | 3 | 6 | 2 | 12 |
| 12 | [def-mesh](12-def-mesh.md) — T3/T6 mesh generation | 0 | 1 | 5 | 6 | 2 | 14 |
| 13 | [piles](13-piles.md) — De Beer axial capacity & settlement | 0 | 2 | 4 | 7 | 3 | 16 |
| 14 | [walls](14-walls.md) — retaining/sheet-pile geometry & coupling | 0 | 2 | 5 | 4 | 3 | 14 |
| 15 | [beam-winkler](15-beam-winkler.md) — beam/slab on elastic foundation | 0 | 2 | 4 | 7 | 2 | 15 |
| 16 | [cpt-parse-import](16-cpt-parse-import.md) — GEF/Excel/CSV import & layering | 0 | 2 | 4 | 7 | 3 | 16 |
| 17 | [def-gpu-v1](17-def-gpu-v1.md) — WebGPU resident CG/GMRES | 0 | 4 | 8 | 6 | 3 | 21 |
| 18 | [def-gpu-v2](18-def-gpu-v2.md) — WebGPU matrix-free | 0 | 2 | 7 | 6 | 4 | 19 |
| 19 | [cpt-controller-ui](19-cpt-controller-ui.md) — legacy-controller orchestration | 0 | 2 | 3 | 5 | 2 | 12 |
| 20 | [ui-components](20-ui-components.md) — Svelte shell & stages | 0 | 2 | 2 | 5 | 2 | 11 |
| 21 | [reporting](21-reporting.md) — report SVG/storage/Stage 7 | **1** | 1 | 2 | 4 | 2 | 10 |
| 22 | [docs-site-integrity](22-docs-site-integrity.md) — published docs vs code | 0 | 0 | 3 | 4 | 3 | 10 |
| 23 | [verification-harness](23-verification-harness.md) — the de-facto test suite | 0 | 4 | 3 | 5 | 2 | 14 |
| 24 | [build-config](24-build-config.md) — build/config/tooling/security | 0 | 1 | 1 | 4 | 4 | 10 |
| | **Totals** | **1** | **35** | **88** | **126** | **63** | **313** |

---

## 8. Method, caveats & remaining work

**Method.** 24 domain-specialist auditors (one per subsystem; large monoliths split by concern) each
performed a deep read across dimensions A–D and wrote its own report with `file:line` citations and
scientific reasoning. Big files were mapped (function/symbol grep) then deep-read in the numerically
load-bearing regions. The orchestration is in `.audit-workflow.mjs`. I (the lead) then read the reports
and independently re-verified the critical and the highest-impact high findings against the actual source
(§2).

**Caveats — what this pass did *not* do:**
- **No code executed beyond targeted checks.** Findings are from static reading plus a few hand/Node
  numerical checks (e.g. the `fmt` bug, the seepage weak-form sign). The solvers and verification scripts
  were not run end-to-end; runtime confirmation of e.g. `REPORTING-A-01`, `SEEPAGE-A-01`, and the
  inclined-wall force model in a live report would strengthen them from "confirmed by reading" to
  "confirmed in-app."
- **Standards tables not cross-checked against licensed sources.** NEN 6740 / EC7 Tabel 3 numeric cells
  (γ, φ′, c′, cu) and the Belgian pile factor tables (BGGG/De Beer) were verified for internal
  consistency (code ↔ code-comment ↔ doc) but **not** against licensed copies. A couple of findings
  (`CPT-CLASSIFICATION-C-03` γ=18 vs 19; the ANB γ_Rd=1.40) need a standards specialist to decide which
  side is authoritative.
- **HS/MC C++ kernels read selectively.** The 4.5k-line `material_hs.hpp` corner-Newton Jacobian and the
  large arc-length phase functions were read at interface level, relying on the documented FD/residual
  oracle errors rather than a full symbolic re-derivation.

**Remaining audit work (deferred — a new session usage limit was hit mid-run):**
- Two planned **synthesis deep-dives were not written as standalone files**: `90-cross-implementation-parity.md`
  and `91-completeness-and-gaps.md`. Their substance is captured in §5 (themes 2 and 3) and §6 here; the
  dedicated files can be generated when usage capacity resets if a deeper standalone treatment is wanted.
- Recommended **second passes** (per the report "Notes" sections): a JS↔WASM safety-curve numeric parity
  fixture; a single-material-point MC return-mapping test harness; a runtime render of a Stage 7 report
  with a bearing annex + inclined wall; and a fuzzed JS-vs-WASM stress sweep including degenerate
  axisymmetric/committed-projector states.

*No source files were modified. All findings are flagged for your review-then-fix pass.*
