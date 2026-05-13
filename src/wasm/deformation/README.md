# Deformation WASM solver

A parallel implementation of the deformation analysis pipeline written
in C++ and compiled to WebAssembly. The CPU JavaScript path under
`src/lib/cpt-app/deformation/` remains the reference implementation;
this module is an opt-in fast path that the user toggles on from the
Stage 6 deformation panel under "Use WASM CPU pipeline (C++ port)".

## What is inside

```
src/wasm/deformation/
├── deformation_wasm.cpp     Emscripten entry point. Owns the binary wire format.
├── types.hpp                Shared structs (Node, ElementCache, RegionParams, …).
├── linalg.hpp               Voigt-6 algebra, 3×3 Jacobi eigendecomposition.
├── element.hpp              T3 + T6 kernels (B, B-bar projection, integrals).
├── sparse.hpp               CSR build + scatter, 2×2 block-Jacobi preconditioner.
├── cg.hpp                   Conjugate gradient + restarted GMRES.
├── material_mc.hpp          Mohr-Coulomb return mapping in principal stress space.
├── solver.hpp               Multi-phase Newton + adaptive load stepping + c-φ safety.
└── build.sh                 emcc invocation. Drops the artifacts into static/wasm/deformation/.
```

The JS side bridge is under `src/lib/cpt-app/deformation/wasm/`:

```
wasm-loader.js     Singleton emscripten instance per worker.
wire-format.js     Encode the input buffer / decode the output buffer (wire version 2).
wasm-runner.js     Encode → call → decode round trip.
build-result.js    Synthesise the result object the CPU path produces.
pipeline.js        Top-level orchestrator (dispatched from solver.js).
```

## Building

```sh
source ~/tools/emsdk/emsdk_env.sh            # makes emcc available
npm run build:wasm:deformation               # rebuilds static/wasm/deformation/*
npm run verify:wasm                          # runs the Node smoke tests
node scripts/verify_wasm_cpu_parity.mjs      # full CPU-vs-WASM parity test
npm run build                                # production build picks up static/*
```

Emscripten 5.x is sufficient. The build script writes
`static/wasm/deformation/deformation.{js,wasm}` and these get shipped
by the static adapter as a side effect of `npm run build`.

## Architecture

The WASM dispatch happens inside `_analyzeDeformationModelImpl` in
`solver.js`, *after* the CPU has computed the slope-aware K0 stress
field via `buildGeostaticInitialization`. The C++ module then runs the
plastic geostatic equilibration (Phase A), the service-load Newton
(Phase B), and — when `analysisType === 'safety-cphi'` — the c-φ
strength-reduction bracketing (Phase C). The result is reassembled in
JS with the same shape `analyzeDeformationModel` returns from the CPU
path, so the rest of the app cannot tell the backends apart.

### Multi-phase analysis modes

| Mode                    | Phase A        | Phase B           | Phase C            |
|-------------------------|----------------|-------------------|--------------------|
| ServiceOnly             | —              | gravity-ramp      | —                  |
| GeostaticPlusService    | K0 → equilibrium | service-load ramp | —                  |
| GeostaticServiceSafety  | K0 → equilibrium | service-load ramp | c-φ bracketing     |

The default for any non-safety analysis is `GeostaticPlusService`.
`analysisType === 'safety-cphi'` triggers `GeostaticServiceSafety`.

### Wire format (version 2)

Both encode and decode live next to each other:

- C++ side: `deformation_wasm.cpp` (`madepRunDeformationAnalysis`).
- JS side: `wire-format.js` (`encodeInputBuffer` / `decodeOutputBuffer`).

The header magic is `'TDCM'` (`0x4D434454`) for input and `'TDKM'`
(`0x4D444B54`) for output, both with version 2. Bump the version
constant on either side if you change the schema and update the magic
check in the C++ reader.

Input fields (in order): nodes, elements, regions, fixed-DOF list, full
gravity-DOF RHS, full surface-load RHS, per-Gauss-point initial K0
effective stress (Voigt-6, tension positive), per-GP pore pressure.

Output fields: a `RunSummary` block, service-end displacements,
geostatic-end displacements, per-GP states (stress, plastic strain,
accumulated plastic strain, η, reference stress, geostatic stress and
plastic-strain snapshots, pore pressure, plastic / tension flags), and
a `SafetyResult` block with the trial history.

## Precision

| Case                      | Max settlement error vs CPU | Max DOF error vs CPU |
|---------------------------|------------------------------|----------------------|
| T3 linear-elastic         | 1e-7 m                       | 1e-7 relative        |
| T3 MC plastic             | 0.5 % settlement             | ~0.5 % relative      |
| T6 linear-elastic (no B-bar) | 1e-7 m                    | 1e-7 relative        |
| T6 MC plastic             | engineering grade (modified Newton, slow) |        |
| Safety c-φ                | within bracket tolerance     | n/a                  |

The WASM module currently uses **modified Newton** (elastic tangent at
yielding Gauss points). The converged stress / displacement state is
identical to the CPU consistent-tangent outcome; Newton just takes more
iterations to reach it. For T3 meshes — the workhorse for CPT analyses
— this still completes in well under a second.

## Convention notes

- **Stress / strain Voigt-6**: tension-positive, engineering shear
  (γ_xy at slot V_XY). The MC yield function in this convention is
  `f = (σ1 - σ3) + (σ1 + σ3) sin φ - 2 c cos φ` with σ1 ≥ σ2 ≥ σ3
  (sorted descending). The CPU path uses compression-positive
  principals and so has a leading minus sign on the second term;
  both forms agree under the sign flip σ' = -σ.
- **K0 seed projection**: every material point is initialised with the
  K0 stress field passed from the CPU. When the seed violates the MC
  envelope at a Gauss point (rare with the slope-aware admissibility
  clipping the CPU already does, but possible for unusual material
  combinations), a zero-strain return mapping admissibility-projects
  it before Phase A starts.
- **Rankine tension cut-off**: orthogonal projection in the elastic-
  strain-energy norm, not component-wise clamping.

## Out of scope (deliberately)

The following CPU-path features are intentionally not in the WASM
module yet. They can be added behind explicit option flags as needed.

- Consistent (non-modified) algorithmic MC tangent in the global frame
  via 4th-order rotation through the trial-stress eigenvector basis.
  Enabled would require a GMRES dispatch for non-associated flow.
- Exact two-surface (edge) MC return mapping; currently the edge
  overshoot regime falls back to an admissible apex projection.
- Adaptive Newton continuation that targets a specific iteration
  count (currently uses simple growth/cutback).
- Hardening Soil and other future constitutive plugins.
