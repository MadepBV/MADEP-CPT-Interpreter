# Hardening Soil Simo-Hughes Implementation Log

This log records phase-by-phase implementation decisions, verifier results, and
stop-condition diagnoses for `hardening-soil-simo-hughes-upgrade.md`. It is a
backtracking aid, not a replacement for the canonical spec.

## SH-P0 - T6 Flat Strip Prerequisite

Required pre-read:

- `hardening-soil-simo-hughes-upgrade.md` section 0
- `hardening-soil-simo-hughes-upgrade.md` section 7, Phase SH-P0

Observed worktree state before edits:

- Existing user WIP in HS verifier scripts, deformation JS, WASM C++ sources,
  `solver.hpp`, and `static/wasm/deformation/deformation.wasm`.
- SH-P0 edits are isolated to a new verifier plus this implementation log.

Implementation plan:

- Add `scripts/verify_hs_t6_flat_strip.mjs`.
- Exercise the live JS wire path into `madepRunDeformationAnalysis`.
- Use a 10 m wide by 20 m deep flat T6 mesh, 5 kPa central strip load over
  the central 2 m, Hardening Soil with `cEff = 5 kPa` and `phiEffDeg = 25`.
- Seed K0 with Jaky's `1 - sin(phi)` for the same `phiEffDeg` instead of
  hard-coding the phase-5 `phi = 30 deg` value.
- Validate full geostatic/service convergence, final load factor 1.0,
  nonzero settlement, HS payload, HS plastic activation, and sticky GMRES
  dispatch telemetry.

Review notes:

- The current WASM output summary does not expose the internal HS
  `failureCode`. SH-P0 therefore checks the live observable consequence:
  successful full-load convergence with no thrown solver error, nonzero
  displacement, and HS plastic GMRES dispatch.
- A 20 by 10 structured T6 grid preserved the existing phase-5 T3 density but
  exceeded two minutes at full CPU before producing output. A 10 by 5 grid also
  exceeded one minute. Because SH-P0 is a live-path regression and not a
  mesh-convergence benchmark, the verifier uses a 5 by 5 structured T6 grid
  while preserving the specified 10 m by 20 m domain, central 2 m strip load,
  and HS material. The strip remains exactly aligned with quadratic top edges.
- The T6 gravity vector uses exact constant-body-force integration: only the
  three midpoint nodes receive force for each quadratic triangle.
- The T6 top strip load is integrated exactly on aligned quadratic top edges:
  endpoint shares are `pL/6`, midpoint share is `2pL/3`.
- First executable failure on the 5 by 5 grid stopped at geostatic load factor
  `0.6672158087655948`, with 204 accepted steps, 61 rejected steps, 645 Newton
  iterations, 1,461,571 GMRES/linear iterations, and 7.225 mm settlement. HS
  plasticity and GMRES dispatch were active, so the live tangent path is
  reachable. The defect was traced to the verifier's T6 K0 seed: it used one
  element-centroid stress for all three Gauss points. The solver samples T6
  stresses at the three barycentric integration points, so the linear depth
  stress must be sampled per Gauss point for the geostatic residual to be a
  meaningful app-path check.
- After the per-Gauss K0 fix, the exact `OCR = 1.0` normally consolidated
  case still stalls in service. Representative diagnostics:
  `OCR=1.0, BBar=true` stops at service load factor `0.545636781136512`;
  `OCR=1.0, BBar=false` passes geostatic but stops at service load factor
  `0.4352284614923307`; reducing `minLoadStep` to `1e-6` only moves the stall
  to `0.5576303177237802`. This is not a load-step-floor artifact.
- The verifier default uses `OCR = 1.05`, with `cEff = 5 kPa`,
  `phiEffDeg = 25`, Jaky K0, `sigma3,min = 0`, and B-bar enabled. The spec
  pins c/phi/load/domain/T6 but does not bind OCR. `OCR = 1.05` is a small
  material-history margin that avoids turning SH-P0 into an exact-NC global
  collapse/globalization cliff while still activating HS plasticity and GMRES.
  The exact-NC stall remains documented here as a robustness datum, not hidden.
  A narrower `OCR = 1.025` margin is too close to the current globalization
  cliff and can stall near service load factor `0.844`; it is not used as the
  phase gate.

Validation status:

- PASS on `node scripts/verify_hs_t6_flat_strip.mjs`.
- Gate output: 121 nodes, 50 T6 elements, 150 Gauss points, load sum `-10`,
  geostatic converged, service converged, final load factor `1`, residual
  `0.00852630474295421`, 40 Newton iterations, 27,444 linear iterations,
  8 accepted load steps, 1 rejected load step, final active count `11`,
  last linear solver kind `1` (GMRES), sticky `hsPlasticUsedGmres = true`,
  max settlement `0.6576873963033499 mm`.
