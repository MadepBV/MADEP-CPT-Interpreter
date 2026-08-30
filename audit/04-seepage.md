# Audit — Steady-state 2D FEM seepage (Triangle mesh, drains, BCs)
**Subsystem key:** seepage
**Files reviewed:** src/lib/cpt-app/seepage/solver.js, src/lib/cpt-app/seepage/boundary.js, src/lib/cpt-app/seepage/drains.js, src/lib/cpt-app/seepage/material.js, src/lib/cpt-app/seepage/mesh-triangle.js, src/lib/cpt-app/seepage/pslg.js, src/lib/cpt-app/seepage/triangle-runtime.js, src/lib/cpt-app/seepage/seepage-worker.js, docs/seep/seepage_analysis_v1_spec.md, docs/seep/drain.md, docs/seep/seepage_fix.md, src/routes/docs/engineering/seepage/+page.svelte (plus consumer cross-checks in stage6-bishop.js, legacy-controller.js)
**Finding counts:** critical=0 high=1 medium=4 low=5 info=4  |  A=3 B=3 C=4 D=4  |  total=14

## Overview
The seepage subsystem is in good numerical health. The T3 element conductivity matrix, anisotropic Darcy assembly, Jacobi-preconditioned CG, Dirichlet row/column elimination, the seepage-face and drain active-set complementarity loops, and the wet/dry free-surface treatment all match the governing equations and the in-app documentation closely. The element matrix, gradient/flux recovery, reaction recovery, and conductivity-scaling are correct and unit-consistent (γw = 9.81, MIN_CONDUCTIVITY = 1e-20, DRY_FACTOR = 1e-4, all as documented). The most material finding is a sign-convention inconsistency in the boundary-flux *labeling* (reaction branch labels domain outflow as inflow) that swaps the reported `inflow`/`outflow` fields in the report payload; it does not affect through-flow or convergence. The remaining findings are performance hot-loops (per-iteration `O(E)` recompute of edge maps / neighbor maps / drain entries), several doc-vs-code drifts (the v1 spec still describes a reduced-permeability/under-relaxation free-surface loop and a removed strip mesher), and dead code. No memory leaks of consequence were found; WASM heap is freed in `finally`.

## Findings

### [SEEPAGE-A-01] high · Boundary reaction-flux branch labels domain outflow as `inflow` (inverted vs. flux branch and documented sign)
- **Location:** `src/lib/cpt-app/seepage/solver.js:1577-1593` (reaction branch) vs `solver.js:1594-1617` (flux branch); reaction sign set at `solver.js:1194-1202`; consumed via `result.inflow`/`result.outflow` (`solver.js:2331-2332`) into the Stage 7 payload (`legacy-controller.js:17757-17758`)
- **Category:** A — Implementation
- **Confidence:** likely
- **Analysis:** The nodal reaction is `reactions[nodeId] = (Σ_j K_ij·h_j)·conductivityScale` with no extra sign (`solver.js:1197-1201`). For the FEM Galerkin seepage form with `q = -k∇h`, the boundary term is `(K·h)_i = -∮ N_i (q·n_out) dΓ`. Hence a **negative** reaction `R_i < 0` corresponds to `∮ q·n_out > 0`, i.e. water **leaving** the domain (outflow). The in-app doc states exactly this: `R_i < 0 = water leaving the domain (drain collecting)` (`+page.svelte:398-400`), and the drain summary code follows it: `if (reaction < 0) result._reactionInflow += -reaction` treats `reaction<0` as flow *into the drain* = out of the domain (`solver.js:1764`).
  But the boundary reaction branch does the opposite:
  ```js
  if (flux < 0) { totalInflow += fluxMagnitude; ... }   // solver.js:1584-1588
  totalOutflow += fluxMagnitude;                         // solver.js:1590
  ```
  So a Dirichlet node with `R_i < 0` (water leaving) is counted as `totalInflow`. The fallback flux branch uses the *opposite, correct* convention: `fluxNormal = q·n_out`, and `if (metrics.fluxNormal < 0) totalInflow += ...` (`solver.js:1605`) — there `fluxNormal<0` means inward flow = genuine inflow. The two branches therefore disagree about which sign is inflow, and the reaction branch (the normal solve path, since `reactions` is virtually always present) is the inverted one. Net effect: `result.inflow`/`result.outflow`, `prescribedHeadInflow/Outflow`, and `seepageFaceInflow/Outflow` are swapped when reactions are used. `throughFlow = max(inflow,outflow)` (`solver.js:1619`, `solver.js:2256-2259`) is symmetric and unaffected, and `normalizedFlowBalanceError` re-swaps them (`domainInflow = totalOutflow + drainOutflow`, `solver.js:636-637`) so the convergence/mass-balance error is also unaffected. The visible bug is the reported inflow/outflow magnitudes (Stage 7 payload + results panel) being interchanged in the dominant code path.
- **Recommendation:** Make the reaction branch agree with the flux branch and the documented convention: `flux < 0` (reaction negative = water leaving) should accumulate `totalOutflow`, `flux > 0` should accumulate `totalInflow`. Add a regression on a simple head/head 1D case where the upstream (higher-head) boundary must be inflow and the downstream outflow, and assert `result.inflow ≈ k·Δh·H/L` enters at the upstream side.

### [SEEPAGE-A-02] low · `conductivityTensorFromMaterial` can produce a non-positive-definite dry tensor (off-diagonal not co-scaled with diagonal floor)
- **Location:** `src/lib/cpt-app/seepage/solver.js:132-143`
- **Category:** A — Implementation
- **Confidence:** likely
- **Analysis:** For a dry element, `kx`/`ky` go through `effectiveElementConductivity`, which floors at `MIN_CONDUCTIVITY` first and *then* multiplies by `DRY_FACTOR` only when above the floor path: `dry ? Math.max(base*DRY_FACTOR, MIN_CONDUCTIVITY*DRY_FACTOR) : base`. Meanwhile `kxy = kxyRaw * (dry ? DRY_FACTOR : 1)` (`solver.js:141`). When the soil `kx`/`ky` are at/near the `MIN_CONDUCTIVITY` floor but `kxy` is comparatively large (a user/wall material could in principle set `kxy ~ kx`), the dry tensor `[[kx_dry, kxy_dry],[kxy_dry, ky_dry]]` is positive-definite only if `kxy_dry² < kx_dry·ky_dry`. Because the diagonal is floored (lifted) independently of the off-diagonal, the dry scaling does not guarantee the original PD margin is preserved; a borderline-PD tensor could lose PD-ness, weakening CG (Jacobi-preconditioned CG assumes SPD). In practice soil regions have `kxy = 0` (only wall-auto regions and section materials set `kxy`), so the risk is small, but it is unguarded.
- **Recommendation:** Clamp `|kxy| ≤ sqrt(kx·ky)·(1-ε)` after flooring/scaling (both wet and dry), or scale `kxy` by the same factor actually applied to the diagonal. Document that the off-diagonal must keep the tensor SPD.

### [SEEPAGE-A-03] low · Drain per-segment inflow can be misattributed when two drains share a mesh edge (`drainId` from edge vs. nearest-segment from a different drain’s geometry is consistent, but segment lookup uses `nearestDrainSegmentIndex` against the owning drain only)
- **Location:** `src/lib/cpt-app/seepage/solver.js:1743-1748`, `nearestDrainSegmentIndex` at `solver.js:1634-1652`
- **Category:** A — Implementation
- **Confidence:** uncertain
- **Analysis:** In `summarizeDrainFluxes`, each drain constraint edge is attributed to `edge.drainId` (`solver.js:1743`) and the segment index is recomputed by projecting the edge midpoint onto *that* drain's polyline (`nearestDrainSegmentIndex(drain, mid)`). For overlapping/touching drains sharing nodes (allowed when heads match per `validateDrains` `drain-conflicting-heads`), a single mesh edge has one `edge.drainId`, so its flux is credited to only one drain even though physically the collected water belongs to both coincident drains. This is an edge case (coincident drains with equal head) and the per-drain *total* is still reconciled to the Dirichlet reaction sum, so totals stay correct; only the per-segment spatial distribution between coincident drains is arbitrary. The code already documents per-segment inflow as APPROXIMATE (`solver.js:1678-1685`).
- **Recommendation:** No action required for v1; if coincident drains are ever a supported workflow, split shared-edge flux between the drains that own the shared nodes. Keep the existing "per-segment is approximate" caveat.

### [SEEPAGE-B-01] medium · `buildEdgeMap` (O(E)) and `ensureElementNeighbors` rebuilt repeatedly inside the active-set / outer loops
- **Location:** `buildEdgeMap` `src/lib/cpt-app/seepage/solver.js:540-555`; called from `buildBoundaryFaces` (`solver.js:1257`, `solver.js:1303`), `summarizeDrainFluxes` (`solver.js:1711`), and `ensureElementNeighbors` (`solver.js:670`). `ensureElementNeighbors` itself is called from `wetConnectivityDiagnostics` once per outer iteration (`solver.js:2597-2601`, `solver.js:2613-2617`).
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** `buildEdgeMap` walks every element edge and allocates a `Map` with string keys (`${n1}:${n2}`) on every call — O(E) allocations and string concatenations. `summarizeDrainFluxes` calls it every active-set/outer iteration (it is invoked inside `solveSeepageBoundaryActiveSet`'s loop via `summarizeBoundaryFluxes`/post path and again per outer iteration in `solveSeepage`). For a 5k–10k element mesh with up to `MAX_ACTIVE_SET_ITER=12` × several outer iterations, this is tens of full edge-map rebuilds per solve, each O(E) with heavy string-key allocation. `ensureElementNeighbors` memoizes onto `mesh.elementNeighbors` (good), but the connectivity diagnostic runs twice per outer iteration. The string-keyed `Map` is the dominant avoidable cost.
- **Recommendation:** Build the edge map and the drain-edge adjacency once after meshing, cache on the mesh object (like `mesh._seepageElementsByNode` and `mesh.elementNeighbors` already do), and reuse. Prefer an integer key (`n1*N + n2`) over a string key to cut allocation.

### [SEEPAGE-B-02] medium · `drainEntriesForMesh` recomputed (with sort + per-node arc-length map lookups) on every call across the hot path
- **Location:** `src/lib/cpt-app/seepage/solver.js:717-746`; called from `buildDirichletValues` (`solver.js:1383`), `activeDrainNodesFromSolve` (`solver.js:842`), `initialActiveDrainNodes` (`solver.js:806`), `dirichletBoundaryNodeTypes` (`solver.js:1410`), `summarizeDrainFluxes` (`solver.js:1705`), `activeDrainNodeIdSet` (`solver.js:763`).
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** Each call re-normalizes drains (`normalizeDrains`), iterates every drain node set, sorts by arc length, and rebuilds the `entries` array including a `drainHeadValueAt` evaluation per node. This is invoked multiple times per active-set iteration (`buildDirichletValues` + `activeDrainNodesFromSolve` + `initialActiveDrainNodes` inside the same loop body, `solver.js:1029`, `solver.js:1065`, `solver.js:992`) and again per outer iteration in summaries. The result is deterministic for a given mesh+model, so the repeated sorting/allocation is pure overhead proportional to (drain nodes) × (active-set iters) × (outer iters).
- **Recommendation:** Memoize `drainEntriesForMesh(mesh, model)` on the mesh (keyed by a cheap model-drain fingerprint, or just compute once per solve and thread it through). The downstream functions already accept the derived structures; passing a cached `entries` array would remove most redundant work.
- **Note:** `normalizeDrains` is also called independently in `summarizeDrainFluxes` (`solver.js:1704`), `drainEntriesForMesh` (`solver.js:718`), `buildDrainConstraintMaps` (`mesh-triangle.js:40`), `buildSeepagePslg` (`pslg.js:209`), and `seepageGeometryHash` (`boundary.js:231`) — same memoization opportunity.

### [SEEPAGE-B-03] medium · `computeElementGradients` and per-cell post-processing allocate full element-length arrays repeatedly
- **Location:** `computeElementGradients` `src/lib/cpt-app/seepage/solver.js:1213-1250`; `postProcess` cell aggregation `solver.js:2216-2229` (`gradients.map((item)=>item.qx)` etc., four full passes); `solveHeadField` rebuilds `rows = Array.from({length: nodes}, () => new Map())` every active-set iteration (`solver.js:1136`).
- **Category:** B — Performance
- **Confidence:** confirmed
- **Analysis:** `computeElementGradients` returns a fresh object array of length E and is called per active-set iteration (`solver.js:1055`) and again in `activeSeepageFacesFromFlux` when no gradients are passed (`solver.js:1510`). In `postProcess`, `cellGradients` builds four separate `gradients.map(...)` temporary arrays of length E (`solver.js:2217-2220`) for each of qx/qy/dhdx/dhdy, then `cellValueFromTriangles` iterates per cell — O(E) temporaries × 4. `solveHeadField` reallocates the entire row-`Map[]` adjacency structure and re-derives every element matrix (incl. `conductivityTensorFromMaterial`) on each active-set iteration even though geometry/`dNdx`/`dNdy` are invariant — only the dry flags and conductivity scaling change. This is the largest per-iteration allocation cost in the solver.
- **Recommendation:** Cache the geometric element data (`dNdx`, `dNdy`, `area`, `centroid`) once after meshing; on each assembly only scale by the current per-element conductivity. Avoid the four `.map` temporaries in `postProcess` by accumulating qx/qy/dhdx/dhdy in a single pass over each cell's triangle indices. These are post-stability optimizations; correctness is unaffected.

### [SEEPAGE-C-01] medium · v1 spec describes a reduced-permeability + under-relaxation free-surface loop; code implements a fixed-mesh active-set / wet-fraction classifier
- **Location:** Spec §4.5 / §8 (`docs/seep/seepage_analysis_v1_spec.md:307-340`, `:1374-1421`); code `classifyElementWet`/`updateDryFlagsFromHeads`/`solveSeepageBoundaryActiveSet` (`solver.js:684-699`, `:877-893`, `:977-1133`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** (1) The spec's recommended v1 algorithm (§8) is the reduced-permeability method with element on/off by centroid `h<y` and explicit under-relaxation `y_new = y_old + ω(h_computed - y_old)` / `k_new = k_old·(k_target/k_old)^ω`. (2) The code never under-relaxes the free surface; it classifies elements by pressure-head sign *and* wet-area fraction with hysteresis (`classifyElementWet`, `solver.js:694-699`), scales dry conductivity by `DRY_FACTOR=1e-4` (not /1000), couples a seepage-face and drain active set, and adds a wet-connectivity fallback that dries disconnected islands (`solver.js:907-975`). (3) Scientifically the *code's* approach is the more correct/robust one and matches the cited Bathe & Khoshgoftaar (1979) fixed-mesh residual-flow method referenced in the in-app docs (`+page.svelte:689`). The dry factor `1e-4` is also internally documented (`spec §5.6.11`, `:1115`) — so the spec is internally inconsistent (`1/1000` in §8 vs `1e-4` in §5.6.11). The in-app docs (`+page.svelte` §6) accurately describe the shipped active-set/wet-dry method.
- **Recommendation:** Fix the doc: update spec §8 (and the §4.5 "k/1000" passages) to describe the shipped active-set/wet-fraction method and the `DRY_FACTOR=1e-4` value, cross-referencing §5.6.11 and the Bathe-Khoshgoftaar reference. Code is correct; no code change.

### [SEEPAGE-C-02] medium · `seepage_fix.md` references functions and a strip mesher that no longer exist in `solver.js`
- **Location:** `docs/seep/seepage_fix.md:20-49`, `:135-188`, `:227-334` (cites `buildMeshCoordinates`, `splitSegmentsToAtomicPieces`, `buildTrianglesForPolygon`, `buildConstraintSegments`, `triangulatePolygonEarClip`, `performLawsonDelaunayFlips`, plus line numbers like `solver.js#L882`, `#L1330`, `#L1828`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** The current `solver.js` (2885 lines) contains none of the strip-mesh or custom-arrangement helpers the fix plan describes; meshing is fully delegated to Triangle WASM via `mesh-triangle.js` → `triangle-runtime.js` and PSLG assembly in `pslg.js`. The cited line numbers (`buildBoundaryFaces` at L1330, `samplePointCandidates` at L1828, `elementMatrix` at L1009) no longer match (actual: `buildBoundaryFaces` L1252, `samplePointCandidates` L2821, `elementMatrix` L358). `seepage_fix.md` is a historical migration plan that has been fully executed; it now misleads a reader to look for removed code. The code is the correct/current state.
- **Recommendation:** Mark `seepage_fix.md` as historical/completed (status banner) or move it to an archive folder; optionally strip the stale `#Lnnn` deep links. No code change.

### [SEEPAGE-C-03] low · Spec §7.5 / §3 prescribe dense/banded Cholesky for n<3000; code uses Jacobi-preconditioned CG only
- **Location:** Spec `docs/seep/seepage_analysis_v1_spec.md:1344-1370`, `:126`, `:139`; code `solveCg` (`solver.js:473-538`), called from `solveHeadField` (`solver.js:1182`)
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** The spec repeatedly recommends dense/banded Cholesky as the primary solver with CG as a fallback ("Use dense Cholesky for n < 3000, banded Cholesky above that. Implement CG as a fallback", `:1366-1369`). The shipped solver is exclusively a diagonal (Jacobi)-preconditioned CG with `MAX_CG_ITER=2500`, `CG_TOL=1e-6`, throwing on non-convergence (`solver.js:1183-1185`). There is no Cholesky path. Scientifically CG-on-SPD is a fully valid choice (and §5.6.5 of the same spec, `:994`, already says "~120-LoC CG + Jacobi preconditioner ... Banded Cholesky added only if CG fails" — again internally inconsistent with §7.5). Compensated (Kahan) summation in `dot`/`sparseMatVec` is a nice numerical touch. No correctness issue; the convergence criterion (`residualNorm/bNorm ≤ tol`, `bNorm=max(||rhs||,1)`) is standard.
- **Recommendation:** Reconcile spec §7.5 with §5.6.5 to state CG+Jacobi is the shipped solver. No code change.

### [SEEPAGE-C-04] low · Spec §5.2 / "internal drains are not part of the solver" contradicts the shipped drain feature
- **Location:** Spec `docs/seep/seepage_analysis_v1_spec.md:507`, `:1113` ("Internal drains, relief wells, and line sinks are not yet part of the solver"); contradicted by the fully implemented drain pipeline in `drains.js`, `pslg.js:71-97`, `mesh-triangle.js:39-68`, and the drain active-set in `solver.js:805-875`, `:1694-1843`
- **Category:** C — Doc vs Code
- **Confidence:** confirmed
- **Analysis:** Drains with three gating modes (`always`, `when-saturated`, `head-cap`) are shipped and well-described in `drain.md` and the in-app `+page.svelte` §4.4. The main spec (`seepage_analysis_v1_spec.md`) still asserts drains are "planned separately and not part of the current solver" in two places. The drain Signorini complementarity (`h ≤ h_d, q_drain ≥ 0, (h_d-h)·q=0`) in `drain.md §3` matches the code's active-set logic (`activeDrainNodesFromSolve`, `solver.js:833-875`). So `drain.md` + in-app docs are correct and current; the v1 spec is stale.
- **Recommendation:** Update spec §5.2 and §5.6.11 to note drains are now implemented (pointer to `drain.md`). No code change.

### [SEEPAGE-D-01] low · Dead function `elementNormalAndGradient`
- **Location:** `src/lib/cpt-app/seepage/solver.js:557-561`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** `elementNormalAndGradient(mesh, elementIndex, gradients)` simply returns `gradients[elementIndex]`. A repo-wide grep finds no caller (`grep -rn elementNormalAndGradient src` returns only the definition). Superseded by direct `gradients[face.elementIndex]` indexing in `boundaryFaceFluxMetrics` and `summarizeDrainFluxes`.
- **Recommendation:** Flag for removal (not deleting per audit scope).

### [SEEPAGE-D-02] info · `MAX_RUNTIME_MS` constant unused; runtime bound comes from `DEFAULT_MAX_RUNTIME_MS`
- **Location:** `src/lib/cpt-app/seepage/solver.js:18` (`DEFAULT_MAX_RUNTIME_MS = 10000`) is used; verify no orphan `MAX_RUNTIME_MS`
- **Category:** D — Dead code
- **Confidence:** confirmed
- **Analysis:** Not actually an orphan — `DEFAULT_MAX_RUNTIME_MS` and `DEFAULT_FLOW_ERROR_TOL` are both consumed (`solver.js:2287-2289`, `:2351-2352`, `:2468-2469`). This entry is retained only to record that the runtime/flow-error constants were checked and are live. No dead constant found among the top-of-file constants; `EPS`, `GEOM_EPS`, `DRY_FACTOR`, `MIN_CONDUCTIVITY`, `WALL_THICKNESS`, `CG_*`, `MAX_ACTIVE_SET_ITER` are all referenced.
- **Recommendation:** None.

### [SEEPAGE-D-03] info · Wall mechanical material machinery in `material.js` is unused by the seepage solver
- **Location:** `src/lib/cpt-app/seepage/material.js:15-168` (`WALL_MECHANICAL_PRESETS`, `defaultWallMechanicalMaterial`, `normalizeWallMechanicalMaterial`, `resolveWallMechanicalSection`, `wallMechanicalPresetById`, `WALL_DEFAULT_MECHANICAL_*`)
- **Category:** D — Dead code (scope note)
- **Confidence:** confirmed
- **Analysis:** Only `normalizeWallMaterial` (hydraulic: `kAcross`, `kAlong`, `gamma`, `gammaSat`) is consumed by the seepage path (`solver.js:311`, `boundary.js`/`pslg.js`/`drains.js`). The mechanical-section exports (`EA/EI/GA`, kappa, presets) belong to the retaining-wall/deformation subsystem and are imported there, not here. This is not dead globally — flagging it only so the seepage auditor's mental model is correct: these symbols live in `seepage/material.js` but are not part of seepage numerics. Verify ownership when refactoring module boundaries.
- **Recommendation:** Consider moving wall *mechanical* material helpers out of `seepage/` into a wall/deformation module to keep the seepage module hydraulic-only. No behavior change.

### [SEEPAGE-D-04] info · `seepage-worker.js` `IS_NODE`/node-fs path in `triangle-runtime.js` is a test/SSR-only branch
- **Location:** `src/lib/cpt-app/seepage/triangle-runtime.js:4`, `:33-44`
- **Category:** D — Dead code (conditional)
- **Confidence:** confirmed
- **Analysis:** The `IS_NODE` branch (`loadWasmBinary` reading from `node:fs/promises`) is only exercised under Node (verification scripts / SSR), never in the browser worker. It is legitimately used by `scripts/verify_seepage_phase_2.mjs`-style harnesses, so it is not removable; recording it so the browser-path reviewer does not mistake it for unreachable code. WASM heap is correctly freed in `triangulatePslg`'s `finally` (`input.destroy(true)`, `output.destroy()`, `Module._free(switchPtr)`), and the module is reset on error (`resetTriangleModule`) to avoid a corrupted-instance leak — good hygiene.
- **Recommendation:** None.

## Notes / limitations of this audit pass
- The SEEPAGE-A-01 inflow/outflow sign finding rests on the FEM weak-form orientation (`(K·h)_i = -∮N_i q·n_out`) and the cross-consistency between the boundary reaction branch, the boundary flux branch, the drain reaction branch, and the in-app doc's stated `R_i<0 = leaving`. Three of those four agree; the boundary reaction branch is the outlier. I rated it `likely` rather than `confirmed` because I did not execute a numerical fixture to print `result.inflow` vs the physical upstream/downstream boundary on a known head/head case — that one runtime check would settle it definitively and should be the first verification step.
- I did not read `src/lib/cpt-app/mesh/section-pslg.js` / `section-mesh.js` in full (they are shared with deformation and outside the seepage file list); the region-tagging exactness, domain-polygon construction, `mesh.cells`, `mesh.elementData`, `mesh.constraintEdges`, and `drainNodeArcLengthByNode` are assumed correct as produced there. The drain/boundary-face extraction in `solver.js`/`mesh-triangle.js` was reviewed against the contract those modules expose.
- I did not verify the Triangle WASM `TriangulateIO` struct field offsets (`triangle-runtime.js:131-299`) against the upstream `triangle-wasm` ABI; an off-by-one in the `arr[index]` mapping or `destroy()` free-list would be a serious leak/corruption, but the indices match the documented `triangulateio` layout and the package's own bindings, and the mesher round-trips in production.
- Per-segment drain inflow is explicitly documented as approximate (P1 piecewise-constant gradients reconciled to the Dirichlet reaction total); I confirmed the reconciliation preserves per-drain totals and did not treat the spatial redistribution as a defect.
- Element matrix, gradient/flux recovery, reaction recovery, Dirichlet elimination, CG, conductivity scaling, γw, MIN_CONDUCTIVITY, DRY_FACTOR, seepage-face outward-normal orientation, and drain Signorini complementarity were all checked against the governing equations and found correct.
