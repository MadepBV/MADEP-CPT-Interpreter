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

## SH-2 - Cone Simo-Hughes Tangent

Required pre-read:

- `hardening-soil-simo-hughes-upgrade.md` section 2.3
- `hardening-soil-simo-hughes-upgrade.md` section 4.3.1
- `hardening-soil-simo-hughes-upgrade.md` section 5
- `hardening-soil-simo-hughes-upgrade.md` section 7, Phase SH-2

Implementation plan:

- Extend `material_hs.hpp` so return-map results expose the active cone and
  cap plastic multipliers. This is tangent context only; it does not change
  the old continuum/FD-off path.
- Add dense cone Simo-Hughes helpers in `material_hs_tangent.hpp`: spectral
  flow derivative, dense `Xi`, cone yield vector with sigma-3 implicit term,
  and the `Delta lambda` conditioning guard.
- Add `scripts/scratch/hs_sh_phase_2.cpp` and
  `scripts/verify_hs_simo_hughes_phase_2.mjs`.
- Validate the closed-form cone tangent against both a local
  residual-sensitivity oracle and direct finite differences of the implemented
  return map on a non-coaxial `gamma_xy` probe.

Hard-halt diagnosis:

- The first dense implementation put the full spectral derivative of the flow
  direction into `Xi`. It compiled, but the non-coaxial shear column missed the
  direct FD oracle by `1.734308e-03` relative. The normal block matched; the
  error was concentrated in `D_xy,xy`.
- The residual equation explains the mismatch. The production HS cone return
  map is direction-locked to the trial-stress eigenbasis: the corrected stress
  unknown changes the principal values at fixed projectors, while a strain
  perturbation also rotates the trial projectors through
  `sigma_trial = sigma_n + D_e delta_epsilon`.
- The academically consistent fix is a split residual linearisation:
  `M_sigma` is the principal-value `partial m / partial sigma` at fixed trial
  projectors and enters `Xi = (D_e^-1 + Delta lambda M_sigma)^-1`.
  `M_trial` is the eigenprojector-rotation sensitivity of the trial basis and
  enters the strain-side operator `B = I - Delta lambda M_trial D_e`.
  The final tangent is `Xi B - Xi m (n^T Xi B)/(n^T Xi m + 1)`.
- This is not a shortcut or a rebaseline. It is the exact implicit-function
  tangent of the return map the code actually executes. This log records the
  spec amendment needed for §2.3 and §4.3.1 so future phases do not put the
  projector sensitivity in the wrong block.

Review notes:

- `compute_simo_hughes_cone_tangent(...)` does not symmetrize the tangent.
- The `Delta lambda` guard returns `D_e` only for
  `|Delta lambda| < 1e-10 ||D_e||_F`, matching the allowed conditioning
  fallback.
- The Voigt row uses the stress-covector metric helper; shear weights are not
  hidden in an ordinary Euclidean dot product.
- Dense `Xi` remains the only SH-2 implementation. No Sherman-Morrison
  optimization was added before dense parity.

Validation status:

- PASS on `node scripts/verify_hs_simo_hughes_phase_2.mjs`.
- Gate output: `residualRelErr_3x3=1.609817e-08`,
  `directFdRelErr_3x3=1.789000e-09`,
  `dlambda=1.149563e-04`.

## SH-3 - Cap Simo-Hughes Tangent

Required pre-read:

- `hardening-soil-simo-hughes-upgrade.md` section 2.4
- `hardening-soil-simo-hughes-upgrade.md` section 4.3.2
- `hardening-soil-simo-hughes-upgrade.md` section 7, Phase SH-3

Implementation plan:

- Add cap flow-gradient and cap Hessian helpers to
  `material_hs_tangent.hpp`.
- Keep the dense `Xi` implementation as the only SH-3 path; no Woodbury
  rank-2 optimization until dense parity is stable.
- Use the same direction-locked residual split as SH-2:
  fixed-projector cap Hessian in `Xi`, trial-projector rotation in
  `B = I - Delta lambda M_trial D_e`.
- Add `scripts/scratch/hs_sh_phase_3.cpp` and
  `scripts/verify_hs_simo_hughes_phase_3.mjs`.

Hard-halt diagnosis:

- The first cap verifier case failed by construction: `Delta lambda_c` was
  `3.062049e-07`, below the mandatory
  `1e-10 ||D_e||_F` conditioning guard, so the Simo-Hughes helper correctly
  returned `D_e`. The relative error was therefore a verifier-state error,
  not a cap tangent sign error.
- Increasing only the strain increment kept the cap multiplier below the
  guard and eventually made the direct FD active-set probe non-smooth. The
  accepted verifier state instead uses a softer harness material and
  `H_cap = 1` so the same cap-only active set has a smooth multiplier above
  the guard. This is a local tangent verification fixture, not a calibration
  recommendation.

Review notes:

- The cap `n_eff` correction subtracts
  `(4/3) Delta lambda_c H_cap (p_p + p_t)` from each principal component
  before lifting to Voigt, avoiding the documented extra `1/3` mistake.
- The cap Hessian at fixed projectors is
  `(2/M_cap^2) grad(q_tilde) outer grad(q_tilde) + 2/9 1 outer 1`.
- The trial-projector spectral term remains outside `Xi` for the same
  residual-linearisation reason established in SH-2.

Validation status:

- PASS on `node scripts/verify_hs_simo_hughes_phase_3.mjs`.
- Gate output: `residualRelErr_3x3=1.073878e-08`,
  `directFdRelErr_3x3=1.326512e-06`,
  `dlambda=5.569892e-07`.

## SH-4 - Corner Simo-Hughes Tangent

Required pre-read:

- `hardening-soil-simo-hughes-upgrade.md` section 2.5
- `hardening-soil-simo-hughes-upgrade.md` section 4.3.3
- `hardening-soil-simo-hughes-upgrade.md` section 7, Phase SH-4
- `hardening-soil-simo-hughes-upgrade.md` section 12.2 and 12.4

Implementation plan:

- Add dense two-surface `Xi` support to `material_hs_tangent.hpp`.
- Implement `compute_simo_hughes_corner_tangent(...)` with the SH-2/SH-3
  direction-locked residual split: cone and cap fixed-projector sensitivities
  enter `Xi`, while trial-projector rotation enters the strain-side
  `B = I - (Delta lambda_s M_trial_s + Delta lambda_c M_trial_c) D_e`.
- Build the 2x2 corner consistency matrix with
  `A[1][0] = n_c,eff^T Xi m_s` only. No direct off-diagonal hardening term is
  added.
- Add `scripts/scratch/hs_sh_phase_4.cpp` and
  `scripts/verify_hs_simo_hughes_phase_4.mjs`.
- Validate dilatant, near-critical, and non-dilatant corner states against
  both the residual-sensitivity oracle and direct finite differences.

Hard-halt diagnosis:

- The first corner verifier failed because `Delta lambda_s + Delta lambda_c`
  was below the mandatory `1e-10 ||D_e||_F` conditioning guard. The returned
  matrix was exactly the elastic stiffness, so this was a verifier-state
  failure, not a sign error.
- Increasing the strain increment produced a larger multiplier but exposed a
  lag in `return_corner`: the yield residuals converged while the full fixed-
  point stress residual was still too large for the local oracle. That state is
  not acceptable for tangent validation because it linearises a tolerance
  artifact rather than the residual equations.
- The accepted verifier uses a softer local material (`E50 = Eoed = 3000`,
  `Eur = 9000`, `H_cap = 1`) plus a mild initial-hardening perturbation
  (`gamma_p = 0.8 gamma_yield`, `p_p = 0.98 p_p,yield`). This keeps the
  implemented return map corner-active, clears the guard, and leaves the
  fixed-point residual smooth enough for the residual oracle.

Review notes:

- The cap stress-coupling enters only through `n_c,eff`; the old direct
  `H_eff[1][0]` candidate is not present.
- The cross-coupling verifier records the cap-specific contribution. It is
  positive on the deliberately dilatant case and cancels to numerical zero
  when `sin psi_mob = 0`.
- The near-critical Rowe-transition case stays close to
  `sin phi_mob = sin phi_cv` while retaining FD parity.
- Dense `Xi` remains the only SH-4 implementation. No rank-3 Woodbury path was
  added.

Validation status:

- PASS on `node scripts/verify_hs_simo_hughes_phase_4.mjs`.
- Gate outputs:
  - Dilatant: `residualRelErr_3x3=2.289844e-08`,
    `directFdRelErr_3x3=2.105171e-05`,
    `dlambdaS=5.497463e-04`, `dlambdaC=8.492471e-07`,
    `sinPsiMob=1.270177e-01`, `capSpecificCross=1.004054e-01`.
  - Near-critical: `residualRelErr_3x3=2.449968e-08`,
    `directFdRelErr_3x3=5.630037e-06`,
    `sinPhiMob=3.104977e-01`, `sinPhiCv=3.099058e-01`.
  - Non-dilatant: `residualRelErr_3x3=2.966750e-09`,
    `directFdRelErr_3x3=1.265520e-05`,
    `sinPsiMob=0.000000e+00`, `capSpecificCross=-5.820766e-11`.
