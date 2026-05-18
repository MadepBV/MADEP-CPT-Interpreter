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

## SH-0 - Residual-Sensitivity Oracle

Required pre-read:

- `hardening-soil-simo-hughes-upgrade.md` section 2
- `hardening-soil-simo-hughes-upgrade.md` section 4
- `hardening-soil-simo-hughes-upgrade.md` section 7, Phase SH-0

Implementation plan:

- Add `src/wasm/deformation/material_hs_tangent.hpp` for Voigt-dual metric
  helpers and dense `Xi` helpers.
- Add `scripts/scratch/hs_sh_phase_0.cpp` as a harness-only residual oracle;
  it is compiled by a verifier and is not included in the WASM module.
- Add `scripts/verify_hs_simo_hughes_phase_0.mjs` to compile and run the
  harness.
- Validate elastic, cone, cap, and corner cases against direct strain finite
  differences of `update_plane_strain` on the in-plane 3 by 3 block.

Review notes:

- The metric helpers encode the engineering-strain/stress duality explicitly:
  stress-covector contraction weights tensor shear slots by 2, flow tensors are
  converted to engineering strain vectors by doubling shear slots, and
  `D_e^T a` is computed with the same stress-side metric.
- The dense `Xi` implementation inverts `D_e^{-1} + sum(lambda_a dm_a/dsigma)`
  directly. This is intentionally not optimized with Woodbury/rank updates in
  SH-0; later phases may optimize only after dense parity is established.
- The first cone oracle attempt failed although the local yield residual was
  small. The disagreement was traced to the live cone return accepting yield
  convergence before the stress-flow fixed point was equally converged. The
  return map now gates cone convergence on both yield residual and a
  scale-aware fixed-point stress change. This is a mathematical convergence
  criterion, not a tangent fallback.
- The residual equations freeze the active set used by the converged return.
  For cone/corner checks, the oracle projects the unknown stress onto the
  trial-stress eigenprojectors because the implemented return map locks the
  principal-frame directions to the trial stress during the local solve.
- Re-running SH-P0 after the cone fixed-point gate exposed a hard halt in the
  live T6/B-bar app path: nonlinear HS geostatic re-equilibration was creating
  artificial geostatic plasticity before service loading. The accepted fix is
  to keep HS on the stress-only K0 baseline and reserve nonlinear plastic
  geostatic correction for MC. This preserves the incremental-stress service
  formulation and prevents the B-bar T6 operator from re-equilibrating a
  depth-wise K0 seed.

Validation status:

- PASS on `node scripts/verify_hs_t6_flat_strip.mjs` after rebuilding the
  deformation WASM. Gate output: 121 nodes, 50 T6 elements, 150 Gauss points,
  load sum `-10`, geostatic converged, service converged, final load factor
  `1`, residual `0.0017345637481164051`, 54 Newton iterations, 3,554 linear
  iterations, 9 accepted load steps, 2 rejected load steps, final active count
  `11`, last linear solver kind `1` (GMRES), sticky
  `hsPlasticUsedGmres = true`, max settlement `0.6549828822673904 mm`.
- Final pre-commit rerun after making the SH-0 harness self-contained:
  residual `0.0032542607147844614`, 28 Newton iterations, 1,665 linear
  iterations, 7 accepted load steps, 0 rejected load steps, final active count
  `11`, last linear solver kind `1`, `hsPlasticUsedGmres = true`,
  max settlement `0.6080248757199712 mm`.
- PASS on `node scripts/verify_hs_simo_hughes_phase_0.mjs`.
- SH-0 oracle relative errors:
  elastic `3.850655e-12`, cone `1.150391e-08`, cap `1.057031e-07`,
  corner `1.521867e-06`.

## SH-1 - Sigma-3 Derivative Helpers

Required pre-read:

- `hardening-soil-simo-hughes-upgrade.md` section 2.3.1
- `hardening-soil-simo-hughes-upgrade.md` section 4
- `hardening-soil-simo-hughes-upgrade.md` section 7, Phase SH-1
- `hardening-soil-simo-hughes-upgrade.md` section 12.1

Implementation plan:

- Extend `material_hs_tangent.hpp` with scalar derivatives for the HS
  power-law stiffnesses, asymptotic deviator, cone implicit yield partial,
  and Rowe dilatancy chain rule.
- Add `HsAlgorithmicTangentContext` and `build_sh_context(...)` so later
  SH-2/3/4 tangent builders consume one audited bundle of converged-state
  scalars.
- Add a harness-only verifier for analytic-vs-finite-difference checks.
- Before SH-1 could be committed, a clean-worktree WASM rebuild exposed a
  hard halt: SH-P0 reached full load but stayed all-elastic
  (`finalActiveCount = 0`, `hsPlasticUsedGmres = false`). That meant the
  phase chain was relying on dirty prerequisite HS source/artifact state.
  Corrective commit `d8350ed` makes the SH-P0 baseline self-contained by
  landing the live HS production baseline before these SH-1 helpers.

Review notes:

- The stiffness derivatives call `effective_confining_stress(...)`,
  `effective_confining_stress_derivative(...)`, and
  `numerical_pressure_floor(...)`. The near-surface floor case is explicitly
  checked and returns zero derivative.
- The cone implicit derivative is split into the three §12.1 partials
  `df/dE_i`, `df/dE_ur`, and `df/dq_a` before combining, preserving the
  mixed signs and the `q <= 0.999 q_a` clamp.
- The Rowe helpers follow the production `mobilised_sin_phi` /
  `mobilised_sin_psi` formulas. The context builder treats the pre-critical
  region, the Rowe psi cap, and the void-ratio dilatancy cutoff as
  zero-derivative regions.
- The clean-build hard-halt diagnosis was mathematically specific: the old
  K0 history seed used a hidden `OCR >= 2` floor, over-hardening the SH-P0
  strip so the service load never engaged HS plasticity. The landed baseline
  seeds cone history from the actual principal K0 pair and leaves HS on the
  stress-only K0 baseline for service increments.

Validation status:

- PASS on `node scripts/verify_hs_simo_hughes_phase_1.mjs`.
- Representative relative errors: `dE50/dsigma3 1.279631e-11`,
  `dEur/dsigma3 1.876824e-11`, `dEi/dsigma3 4.913464e-12`,
  `dqf/dsigma3 4.774958e-12`, `dqa/dsigma3 4.774972e-12`,
  `df/dsigma3 implicit 1.011311e-14`,
  `d sinpsi/dsigma1 4.008079e-14`,
  `d sinpsi/dsigma3 1.711166e-13`.
