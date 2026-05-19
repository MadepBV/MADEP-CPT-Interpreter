# MC-SH-0 Diagnostic Report

Date: 2026-05-19

## Scope

MC-SH-0 investigated the documented failure of
`material_mc.hpp::continuum_tangent_mc_global`. The verifier is local and
does not enable the tangent in the analysis path.

## Code-Spec Observation

The appendix describes `material_mc.hpp::run_mc_return_mapping` as the
shipping MC path. In the current code, full FE MC dispatch goes through
`solver.hpp::evaluate_gp_response_ex` and `material_mc_exact.hpp`; the older
`material_mc.hpp` path is still compiled and used by HS Rankine helpers and
local harnesses, but `run_mc_return_mapping` is not the live FE return map.
Any MC-SH-1 wire-up must account for this before changing solver defaults.

## Bisection

The finite-difference oracle first compared the old tangent with the
implemented return map on two differentiable smooth-face states:

- `axis-face`: coaxial stress update, no edge/apex/tension activation.
- `rotated-face`: non-coaxial trial stress with an `xy` shear component,
  still on the same smooth MC face.

The old tangent missed the oracle by roughly 8.4 percent on the coaxial case
and 17.8 percent on the rotated case. Rebuilding the tangent in the returned
eigenbasis instead of the trial eigenbasis gave the same error. This ruled out
the documented trial-vs-converged-basis hypothesis for the smooth branch and
also meant GMRES/global assembly could not be the first root cause: the local
tangent itself was wrong.

## Root Cause

The old formula

```text
C_ep = C - (C m) (n C) / (n C m)
```

is the derivative of the principal values for coaxial perturbations, but the
implemented return is a spectral tensor map:

```text
sigma_new = V(sigma_trial) diag(s_new(w_trial)) V(sigma_trial)^T
```

For a differentiable spectral map, the derivative has two parts:

- principal-value sensitivity:

```text
d s_new / d w_trial = I - (D_e m) n^T / (n^T D_e m)
```

- eigenvector/off-diagonal sensitivity:

```text
d sigma_new,ij = ((s_new_i - s_new_j) / (w_i - w_j)) d sigma_trial,ij
```

The missing second term is the MC-SH-0 bug.

## Fix

`continuum_tangent_mc_global` now constructs each Voigt column by:

1. applying the elastic stiffness to a strain basis vector,
2. rotating the trial stress rate into the trial principal frame,
3. applying the principal-value consistency derivative to diagonal terms,
4. applying the spectral divided-difference derivative to off-diagonal terms,
5. rotating the stress rate back to global Voigt form.

If any trial principal pair is nearly repeated, the selected smooth-face
derivative is not unique. The helper returns the elastic tangent in that case;
edge/apex/tension active sets belong to the exact active-set machinery.

## Validation

`scripts/verify_mc_simo_hughes_phase_0.mjs` compiles
`scripts/scratch/mc_sh_phase_0.cpp` and asserts relative in-plane Frobenius
error below `1e-4` against central finite differences on both smooth-face
states.
