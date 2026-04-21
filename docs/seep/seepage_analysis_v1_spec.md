# 2D Steady-State Seepage Analysis — Technical Specification

**Module**: Seepage / Flow-net analysis
**Prerequisites**: Existing geometry canvas, polygonal soil regions, terrain polyline
**Method**: Finite Element Method (FEM) — 3-node triangular elements, Laplace/Darcy formulation
**Status**: v1.2 — current Stage 6 seepage workflow documented as shipped on 2026-04-22. The solver remains experimental, but this spec now records the live implementation choices and numerical shortcuts in addition to the theory.

---

## Contents

1. [Scope & Positioning](#1-scope--positioning)
2. [What This Module Does](#2-what-this-module-does)
3. [Difficulty Assessment](#3-difficulty-assessment)
4. [Theory](#4-theory)
   - 4.1 [Darcy's Law](#41-darcys-law)
   - 4.2 [Governing equation — the Laplace/Poisson problem](#42-governing-equation)
   - 4.3 [Anisotropic permeability](#43-anisotropic-permeability)
   - 4.4 [Boundary conditions](#44-boundary-conditions)
   - 4.5 [The free surface (phreatic line) problem](#45-the-free-surface-problem)
   - 4.6 [Quantities derived from the head field](#46-quantities-derived-from-the-head-field)
5. [Application Design](#5-application-design)
   - 5.1 [Soil regions and permeability (Phase A shipped, Phase 2 adds kx, ky)](#51-soil-regions-and-permeability-phase-a-shipped-phase-2-adds-kx-ky)
   - 5.2 [Boundary condition assignment on geometry edges](#52-boundary-condition-assignment)
   - 5.3 [Reuse from slope stability module (post-Phase-A)](#53-reuse-from-slope-stability-module-post-phase-a)
   - 5.4 [Workflow (single geometry, seepage as an overlay)](#54-workflow-single-geometry-seepage-as-an-overlay)
   - 5.5 [Phase A — Polygon soil regions for the slope solver (shipped)](#55-phase-a--polygon-soil-regions-for-the-slope-solver-prerequisite)
   - 5.6 [Phase 2 — Seepage implementation plan (Phase A landed)](#56-phase-2--seepage-implementation-plan-phase-a-landed)
6. [Mesh Generation](#6-mesh-generation)
   - 6.1 [Constrained Delaunay triangulation](#61-constrained-delaunay-triangulation)
   - 6.2 [Mesh density control](#62-mesh-density-control)
   - 6.3 [Region tagging](#63-region-tagging)
7. [Finite Element Formulation](#7-finite-element-formulation)
   - 7.1 [Element type — 3-node triangle (T3)](#71-element-type)
   - 7.2 [Element conductivity matrix](#72-element-conductivity-matrix)
   - 7.3 [Global assembly](#73-global-assembly)
   - 7.4 [Boundary condition application](#74-boundary-condition-application)
   - 7.5 [Solving the system](#75-solving-the-system)
8. [Free-Surface Iteration](#8-free-surface-iteration)
9. [Post-Processing](#9-post-processing)
   - 9.1 [Flow vectors and gradients](#91-flow-vectors-and-gradients)
   - 9.2 [Equipotential lines and flow lines](#92-equipotential-lines-and-flow-lines)
   - 9.3 [Pore-pressure field for slope stability](#93-pore-pressure-field-for-slope-stability)
   - 9.4 [Exit gradient and piping check](#94-exit-gradient-and-piping-check)
   - 9.5 [Total flow rate](#95-total-flow-rate)
   - 9.6 [Arbitrary line probe along the shared measurement tool](#96-arbitrary-line-probe-along-the-shared-measurement-tool)
10. [Data Structures](#10-data-structures)
11. [Complete Pseudocode](#11-complete-pseudocode)
    - 11.1 [Mesh generation wrapper](#111-mesh-generation-wrapper)
    - 11.2 [Element conductivity matrix](#112-element-conductivity-matrix)
    - 11.3 [Global assembly and BC application](#113-global-assembly-and-bc-application)
    - 11.4 [Sparse solver](#114-sparse-solver)
    - 11.5 [Free-surface iteration loop](#115-free-surface-iteration-loop)
    - 11.6 [Post-processing: gradients, velocities, flow rate](#116-post-processing)
12. [Integration with Slope Stability](#12-integration-with-slope-stability)
13. [Verification & Test Cases](#13-verification--test-cases)
14. [References](#14-references)

---

## 1. Scope & Positioning

This module solves 2D steady-state seepage through saturated soil. It computes the total hydraulic head field h(x, y) across a cross-section, from which pore pressures, flow velocities, gradients, flow rates, and the phreatic surface location can be derived.

**What it is**: a finite-element seepage solver that takes user-drawn geometry with assigned head/flux boundary conditions and produces a head field with flow-net-style visualisation.

**What it is not**: it is not a transient analysis (no time-dependent consolidation or drawdown), not unsaturated flow (no suction, no Richards equation), and not coupled with deformation (no flow-deformation coupling as in PLAXIS). These are v2/v3 extensions.

The primary value propositions are:

- **Standalone**: visualise seepage through embankments, dams, levees, cofferdams, dewatering scenarios, and retaining structures. Engineers can see flow nets, check exit gradients for piping, and compute seepage quantities.
- **Coupled with slope stability**: the computed pore-pressure field feeds directly into the Bishop/Spencer solver, replacing the simplified phreatic-surface assumption with a physically derived pore-pressure distribution. This is especially valuable for embankment dams and slopes with complex drainage.

---

## 2. What This Module Does

Given:
- A 2D cross-section with user-defined soil regions (each with permeability kx, ky)
- Boundary conditions on outer-boundary edges (prescribed head, no-flow, seepage face)

It computes:
- Total head h(x, y) at every node in the mesh
- Pore-water pressure u(x, y) = γw × (h - y) at every point
- Darcy velocity vectors q(x, y) = -k · ∇h at every element
- Hydraulic gradient i(x, y) = |∇h| at every element
- Equipotential contours (lines of constant h)
- Flow lines (streamlines, perpendicular to equipotentials in isotropic soil)
- The phreatic surface (line where u = 0, i.e. h = y)
- Total seepage flow rate Q through the section
- Exit gradient at the downstream face (for piping assessment)
- Head, pore-pressure, gradient, and discharge plots along an arbitrary measured line

---

## 3. Difficulty Assessment

This is a harder problem than slope stability, but not dramatically so. Here's a realistic breakdown:

### What you already have (reusable)

With Phase A merged, the slope-stability geometry model is the seepage geometry model. There is exactly one drawing set.

| Component | File | Reuse status |
|-----------|------|--------------|
| Drawing canvas, polyline tools | Bishop Svelte panel | Direct |
| Terrain polyline (`model.terrain`) | [stage6-bishop.js:2035](src/lib/cpt-app/stage6-bishop.js#L2035) | Direct |
| Soil region polygons (`model.regions[]`) | [soil-regions.js](src/lib/cpt-app/soil-regions.js) | Direct |
| `materialAt(regions, x, y)` (last-wins half-open rule) | [soil-regions.js:235](src/lib/cpt-app/soil-regions.js#L235) | Direct — use for element region tagging |
| `polygonArea`, `isSimplePolygon`, `normalizeRegionPolygon` | [soil-regions.js](src/lib/cpt-app/soil-regions.js) | Direct — use for mesh input validation |
| Phreatic polyline (`model.phreatic`) | [stage6-bishop.js:2069-2077](src/lib/cpt-app/stage6-bishop.js#L2069-L2077) | Reused as an initial free-surface guess; seepage outputs a refined one |
| CPT auto-region generator (`buildCptAutoRegions`) | [soil-regions.js:187](src/lib/cpt-app/soil-regions.js#L187) | Direct — already populates `model.autoRegions` |
| Layer permeability (`layer.kh_rep`, `layer.kv_rep`, m/s) | [legacy-controller.js:3627-3628](src/lib/cpt-app/legacy-controller.js#L3627-L3628) | Plumb into the Bishop `Material` — small additive edit |
| Material schema (`{ id, color, cEff, phiEffDeg, gamma, gammaSat }`) | [stage6-bishop.js:1983](src/lib/cpt-app/stage6-bishop.js#L1983) | Extend with `kx`, `ky` (see §5.1) |

### What's new

| Component | Complexity | Effort estimate |
|-----------|-----------|-----------------|
| `kx`, `ky` fields on `Material` (plumb from `layer.kh_rep/kv_rep`) | Easy | 0.5 day — edit `importBishopMaterialsFromLayers`, carry through |
| Seepage BC data (edge assignments on the existing model) | Easy–Medium | 1–2 days — stable `edgeKey` scheme + defaults |
| BC assignment UI (click edges on the existing canvas) | Medium | 2–3 days — new overlay, no new canvas |
| Mesh generation (constrained Delaunay triangulation) | **Hard — but use a library** | 1 day to integrate a library, 2–4 weeks to write from scratch |
| Element stiffness matrix (T3 triangle) | Easy | 0.5 day — 3×3 closed form |
| Global assembly + Dirichlet application | Easy–Medium | 1 day |
| Sparse linear solver (CG + Jacobi, SPD matrix) | **Use a library or ~200 LoC of JS** | 0.5–1 day |
| Free-surface iteration (reduced-permeability method) | Medium | 2–3 days |
| Post-processing (gradients, isolines, streamlines, exit gradient) | Medium | 3–4 days |
| Visualisation overlays on existing canvas (head, |q|, arrows, h=y line) | Medium | 3–5 days |
| Worker thread (mesh + solve off main thread) | Easy | 1 day |
| Parity guard: seepage disabled ⇒ Bishop/Spencer bit-identical | Easy | 0.5 day (extend Phase A parity harness) |

### Critical dependencies: use libraries, don't write from scratch

Two components would take weeks to implement from scratch but are available as well-tested libraries:

1. **Mesh generation**: Use [Triangle](https://www.cs.cmu.edu/~quake/triangle.html) (C, public domain) via a JS/WASM port, or [earcut](https://github.com/mapbox/earcut) for simple cases, or [poly2tri](https://github.com/nickmccurdy/poly2tri) for constrained Delaunay. For a browser app, [triangle-wasm](https://github.com/nickmccurdy/triangle-wasm) wraps Shewchuk's Triangle in WebAssembly. This is the single highest-leverage library choice.

2. **Sparse linear solver**: For a browser-based app, typical mesh sizes (1,000–10,000 nodes) can be solved with a banded or sparse Cholesky solver. Options: write a simple banded solver (the matrix is symmetric positive definite, so Cholesky decomposition is straightforward and numerically stable), or use [numeric.js](https://github.com/nickmccurdy/numericjs) / [ml-matrix](https://github.com/mljs/matrix). For meshes under 5,000 nodes, even a dense Cholesky works in <1 second in JavaScript. Above that, you need sparse storage (CSR format + sparse Cholesky).

### Total effort estimate

With libraries for meshing and linear algebra: **3–4 weeks** for a working v1 with visualisation.
Without libraries (everything from scratch): **8–12 weeks**. Don't do this.

### Comparison with slope stability

| Aspect | Slope stability (Bishop) | Seepage (FEM) |
|--------|-------------------------|---------------|
| Mathematical class | Nonlinear algebraic (iteration) | Linear algebra (matrix solve) |
| Discretisation | Vertical slices (~30) | Triangular mesh (~1,000–10,000 elements) |
| Solver | Fixed-point iteration | Direct matrix factorisation |
| Mesh generation | Not needed (slices are trivial) | Required — constrained Delaunay |
| Nonlinearity | F appears on both sides | Free surface position (outer iteration) |
| Visualisation | Circle + slices overlay | Contour plots, vector fields, colormaps |
| Implementation effort | ~2 weeks | ~3–4 weeks with libraries |

---

## 4. Theory

### 4.1 Darcy's Law

Darcy's law relates the flow velocity through soil to the hydraulic gradient:

```
q = -k · ∇h

where:
  q   = Darcy velocity vector (m/s) — also called specific discharge
  k   = hydraulic conductivity (m/s)
  h   = total hydraulic head (m) = elevation head + pressure head
      = y + u/γw
  ∇h  = gradient of total head = (∂h/∂x, ∂h/∂y)

In component form:
  qx = -kx · ∂h/∂x
  qy = -ky · ∂h/∂y

where kx, ky are the horizontal and vertical hydraulic conductivities.
```

The total head h at any point in the saturated zone is:

```
h = y + p/(ρg) = y + u/γw

where:
  y   = elevation (m)
  u   = pore-water pressure (kPa)
  γw  = unit weight of water = 9.81 kN/m³
  p   = pore-water pressure (Pa)

Rearranging for pore pressure:
  u = γw · (h - y)

At the phreatic surface: u = 0, so h = y.
Above the phreatic surface (unsaturated): u < 0 (suction) — ignored in v1.
Below the phreatic surface (saturated): u > 0, h > y.
```

### 4.2 Governing equation

For steady-state flow through saturated soil, conservation of mass (continuity) combined with Darcy's law gives:

```
∂/∂x (kx · ∂h/∂x) + ∂/∂y (ky · ∂h/∂y) = 0

For isotropic soil (kx = ky = k):
  k · (∂²h/∂x² + ∂²h/∂y²) = 0
  
  which is Laplace's equation:  ∇²h = 0

For homogeneous isotropic soil, k cancels and the head distribution
depends only on geometry and boundary conditions, not on k.
The magnitude of k only affects the flow rate Q, not the head field.

For heterogeneous or anisotropic soil, k varies spatially and the
full form must be used. This is handled naturally by the FEM
formulation — each element has its own k values.
```

This is an elliptic PDE. It has a unique solution for well-posed boundary conditions (Dirichlet on at least part of the boundary). The finite element method converts it to a linear system Kh = f.

### 4.3 Anisotropic permeability

Many soils have higher horizontal permeability than vertical (due to depositional layering). This is captured by separate kx and ky values per soil region. The permeability tensor for a soil region aligned with the global axes is:

```
[k] = | kx   0  |
      | 0    ky |

Common ratios:
  kx/ky = 1      isotropic (clean sand, gravel)
  kx/ky = 2–5    mildly anisotropic (many natural soils)
  kx/ky = 10–100 strongly anisotropic (layered clay/silt deposits)

The ratio affects the shape of the flow net: in anisotropic soil,
flow lines and equipotentials are NOT perpendicular.
```

For v1, assume the permeability tensor is aligned with the global x-y axes (no rotation). Supporting rotated permeability tensors (e.g. for tilted strata) is a v2 extension — it requires a coordinate transformation in the element stiffness matrix.

### 4.4 Boundary conditions

Three types of boundary conditions are used in seepage analysis. These are applied to edges (line segments) of the geometry, not to individual points.

#### Type 1: Prescribed head (Dirichlet)

```
h = h₀  on the boundary edge

Examples:
  - Upstream water level: h = elevation of reservoir surface
    (constant along the submerged face of a dam)
  - Downstream water level: h = elevation of tailwater
  - Dewatering well: h = drawdown level at the well boundary
  - Piezometer: h = measured head at a specific point

This is the most common BC. At least one Dirichlet BC is
required for the problem to be well-posed.
```

#### Type 2: Prescribed flux (Neumann)

```
q_n = q₀  on the boundary edge

where q_n is the flux normal to the boundary (m³/s per m of boundary).

Examples:
  - Impermeable boundary: q_n = 0 (no-flow)
    Applied to: base of model, symmetry lines, impermeable walls,
    sheet pile cutoffs
  - Known inflow/outflow: q_n = specified value
    (rare in practice — usually head is known instead)

The default BC for any boundary edge that is not explicitly
assigned a condition is NO-FLOW (q_n = 0). This is the natural
BC in the FEM formulation — edges with no assignment automatically
get zero flux.
```

#### Type 3: Seepage face

```
A seepage face is a boundary where water exits the soil and flows
freely under gravity. It is the downstream face of an embankment
or dam above the tailwater level.

Condition: h = y  (pore pressure = 0)
           AND flow must be outward (q_n > 0)

The complication: the extent of the seepage face is unknown
in advance — it depends on the solution. The seepage face
starts where the phreatic surface intersects the downstream
slope and extends down to the tailwater level (or ground
surface if no tailwater).

Implementation: treat as a Dirichlet BC (h = y) on the
expected seepage face nodes. After solving, check that flow
is outward at each seepage face node. If flow is inward at
any node, that node is not actually on the seepage face —
remove it from the seepage face, re-solve, and iterate.
```

### 4.5 The free surface problem

In unconfined flow (e.g. through an earth dam with no tailwater), the upper boundary of the saturated zone — the phreatic surface — is not known in advance. It is part of the solution. This makes the problem nonlinear even though the underlying PDE is linear.

```
Phreatic surface conditions:
  1. h = y  along the phreatic surface (u = 0 by definition)
  2. The phreatic surface is a flow line (no flow crosses it)

The standard iterative approach:
  1. Assume an initial phreatic surface position (e.g. straight
     line from upstream to downstream water level)
  2. Generate mesh for the saturated zone below this surface
  3. Apply h = y as Dirichlet BC on the phreatic surface nodes
  4. Solve the FEM system
  5. At each phreatic surface node, check if the computed h
     equals y (within tolerance)
  6. Adjust the phreatic surface: move nodes up or down so that
     the new surface is at h = y from the solution
  7. Re-mesh and re-solve until convergence

Convergence typically takes 5–15 iterations. The adjustment
in step 6 should use under-relaxation:
  y_new = y_old + ω · (h_computed - y_old)
  where ω = 0.3–0.5 (under-relaxation factor)

An alternative approach (simpler for v1): instead of re-meshing,
use the full domain but assign very low permeability (k/1000)
to elements above the phreatic surface. This avoids re-meshing
but introduces a small error. GeoStudio's SEEP/W uses a similar
approach with a conductivity function.
```

**Recommended v1 approach**: use the reduced-permeability method for the free surface. It avoids re-meshing entirely and converges well. Mesh the entire domain once. After each solve, identify elements where the computed h < y at the centroid (above the phreatic surface) and reduce their permeability by a factor of 1000. Re-solve. Iterate until the phreatic surface position stabilises.

### 4.6 Quantities derived from the head field

Once h(x, y) is known at all nodes, everything else follows:

```
Pore-water pressure:
  u(x, y) = γw · (h(x,y) - y)             [kPa]

Hydraulic gradient vector:
  i = ∇h = (∂h/∂x, ∂h/∂y)                 [dimensionless]
  |i| = magnitude of gradient              [dimensionless]

Darcy velocity (specific discharge):
  qx = -kx · ∂h/∂x                         [m/s]
  qy = -ky · ∂h/∂y                         [m/s]

Seepage velocity (actual velocity through pores):
  vx = qx / n                              [m/s]
  vy = qy / n                              [m/s]
  where n = porosity (not used in v1 but useful for display)

Total flow rate through a cross-section:
  Q = ∫ q_n · ds  along a flow cross-section   [m³/s per m run]
  In practice: sum q_n × edge_length for all element edges
  crossing the desired section.

Exit gradient:
  i_exit = |∇h| at the downstream exit face
  Critical gradient for piping: i_cr = (G_s - 1) / (1 + e) ≈ 1.0
  Factor of safety against piping: F_piping = i_cr / i_exit
```

---

## 5. Application Design

### 5.1 Soil regions and permeability (Phase A shipped, Phase 2 adds `kx`, `ky`)

Phase A shipped the polygon soil-region model. The user already draws, auto-generates, and edits regions in the Bishop/Spencer panel:

- `model.regions[]` is the single source of truth — an ordered array of `{ id, polygon, material, source }` with `source ∈ { 'cpt-auto', 'cpt-copy', 'edited', 'custom', 'hole' }`.
- `materialAt(regions, x, y)` returns the last region whose polygon contains the point (half-open rule, deterministic on shared edges). See [soil-regions.js:235](src/lib/cpt-app/soil-regions.js#L235).
- `buildCptAutoRegions(terrain, layers, cptX, analysisBottomY, materials)` builds the horizontal-band polygons from CPT layering and tags them `source: 'cpt-auto'`. See [soil-regions.js:187](src/lib/cpt-app/soil-regions.js#L187).
- User-drawn regions are validated with `normalizeRegionPolygon`, `isSimplePolygon`, and a minimum-area guard in [stage6-bishop.js:2053-2065](src/lib/cpt-app/stage6-bishop.js#L2053-L2065).

#### What Phase 2 adds to `Material`

Two new fields on the Bishop `Material` record, both in m/s:

```
Material {
  id, label, color,
  sourceType, sourceSubtype, sourceStrengthSet,
  cEff, phiEffDeg, gamma, gammaSat,
  kx: float,            // horizontal hydraulic conductivity (m/s), NEW
  ky: float,            // vertical hydraulic conductivity   (m/s), NEW
  kSource: 'cpt' | 'sbtn-default' | 'user'   // provenance, NEW
}
```

The plumbing is one edit inside `importBishopMaterialsFromLayers` at [stage6-bishop.js:1983](src/lib/cpt-app/stage6-bishop.js#L1983). The CPT layer record that reaches Bishop carries plain `.kh` / `.kv` in m/s — the `_rep` suffix at the classification site ([legacy-controller.js:3627](src/lib/cpt-app/legacy-controller.js#L3627)) is mapped to `.kh` / `.kv` before the layer enters the Bishop pipeline:

```
// PSEUDOCODE — add to existing return object
const kh = Number(layer.kh);            // m/s, rep value from CPT
const kv = Number(layer.kv);
const haveCpt = Number.isFinite(kh) && Number.isFinite(kv) && kh > 0 && kv > 0;

// Preserve ONLY user overrides across re-imports; CPT-sourced values
// get re-derived from the current layer so reclassification takes effect.
const keepPrior = prior.kSource === 'user' && Number.isFinite(prior.kx) && Number.isFinite(prior.ky);

return {
  ...existingFields,
  kx: keepPrior ? prior.kx : (haveCpt ? kh : defaultKx(layer)),
  ky: keepPrior ? prior.ky : (haveCpt ? kv : defaultKy(layer)),
  kSource: keepPrior ? 'user' : (haveCpt ? 'cpt' : 'sbtn-default')
};
```

`defaultKx` / `defaultKy` use the built-in classified-soil heuristic in the next subsection. The UI still tags that path as `kSource = 'sbtn-default'` for continuity with the existing Bishop material editor, but it should be read as a practical default rather than a measured permeability. The `kSource === 'user'` guard is intentional: `c'`, `phi'` have an analogous preservation rule via `canReuseStrengthValues` keyed on `sourceStrengthSet`, but for permeability there is no strength-set analogue — the only thing worth preserving across a CPT re-import is an explicit manual override. CPT-sourced values are replaced by the fresh layer values so that reclassification flows through.

**Backward compatibility**: `kx` / `ky` are optional — Bishop/Spencer never read them. A `model` with materials that don't have `kx`/`ky` must still solve identically, so the parity harness from Phase A §5.5.7 gets one extra fixture: "materials without permeability fields produce the same F, λ, and slice outputs".

#### Permeability values from soil classification

For CPT-derived regions, the soil type from the CPT classification (Robertson SBTn) can provide default permeability estimates:

```
SBTn Zone   Soil behaviour type              Typical k (m/s)
────────────────────────────────────────────────────────────────
1           Sensitive fine grained            1e-9 to 1e-8
2           Organic soil                      1e-8 to 1e-6
3           Clay                             1e-10 to 1e-8
4           Silt mixture                      1e-8 to 1e-6
5           Sand mixture                      1e-6 to 1e-4
6           Sand                              1e-4 to 1e-2
7           Dense sand / gravelly sand        1e-3 to 1e-1
8           Very stiff sand to clayey sand    1e-6 to 1e-4
9           Very stiff fine grained           1e-9 to 1e-7

These are order-of-magnitude defaults. The user should always
verify and adjust based on lab tests or local experience.
Permeability varies over 10+ orders of magnitude across soil
types — getting within one order of magnitude is considered
acceptable for many practical problems.

Common anisotropy ratios (kx/ky):
  Clean sand:       1–2
  Silty sand:       2–5
  Layered silt/clay: 5–50
  Varved clay:      10–100+
```

### 5.2 Boundary condition assignment

Boundary conditions are assigned only to **outer-boundary** edges. In the current Stage 6 workflow an "edge" means one segment on:

- the terrain polyline
- the model base
- the left side boundary
- the right side boundary

Interior soil-region edges are meshing constraints only. They preserve material interfaces, but they do not currently accept seepage BCs.

#### Assignment UX

1. User enters "BC mode" (a tool/mode selector in the toolbar).
2. User clicks on an outer-boundary edge.
3. A panel appears with BC type selection:
   - **Prescribed head**: enter h value in metres (or pick from a water level line on the canvas)
   - **No flow**: default — no input needed
   - **Seepage face**: no input needed (h = y is automatic)
4. Assigned edges are visually distinguished:
   - Prescribed head: blue edge with h value label and a water-level indicator
   - No flow: grey dashed edge
   - Seepage face: green edge with water drops icon
5. Edges without explicit assignment default to no-flow (the natural BC).

#### Typical configurations

```
Earth dam with reservoir:
  - Upstream face (submerged): h = reservoir level
  - Dam base: no-flow (impermeable foundation) or h = prescribed
    (pervious foundation)
  - Downstream face above tailwater: seepage face
  - Downstream face below tailwater: h = tailwater level
  - Model sides (far-field): no-flow (if far enough) or h = ambient
    water table

Cofferdam / sheet pile:
  - Upstream: h = upstream water level
  - Downstream: h = downstream water level
  - Sheet pile (thin vertical element): no-flow on both sides
    (or very low k element)
  - Base: no-flow (deep impermeable stratum)

Slope with drainage blanket:
  - Upstream: h = groundwater head
  - Downstream outer face: seepage face (where water exits)
  - Toe / tailwater zone: h = tailwater level when submerged
  - Base: no-flow
```

Internal drains are planned separately and are not part of the current solver. See [drain.md](drain.md) for the one-way drain design note.

### 5.3 Reuse from slope stability module (post-Phase-A)

Everything geometry-shaped is already shipped. Phase 2 is additive.

| Component | File / symbol | Reuse status |
|-----------|---------------|--------------|
| Drawing canvas + interaction | Bishop Svelte panel | Direct reuse |
| Terrain polyline | `model.terrain`, `terrainY(pl, x)` in [stage6-bishop.js:85](src/lib/cpt-app/stage6-bishop.js#L85) | Direct |
| Soil region polygons | `model.regions[]` | Direct |
| Point-in-polygon (half-open) | `pointInPolygonHalfOpen` in [soil-regions.js:216](src/lib/cpt-app/soil-regions.js#L216) | Direct — use for element region tagging |
| Shoelace area formula | `polygonArea` in [soil-regions.js:31](src/lib/cpt-app/soil-regions.js#L31) | Direct |
| Coordinate system | shared (y up, x right, m) | Direct |
| Initial phreatic polyline | `model.phreatic` | Reused as initial free-surface guess; seepage outputs a refined h=y isoline |
| CPT layer interpolation | `buildCptAutoRegions` in [soil-regions.js:187](src/lib/cpt-app/soil-regions.js#L187) | Direct |
| Pore pressure at a point | currently hydrostatic from `model.phreatic` inside [stage6-bishop.js:228](src/lib/cpt-app/stage6-bishop.js#L228) | Keep as default; add opt-in FEM-field source (see §12) |
| Material record | extended with `kx`, `ky` (§5.1) | Extend, don't replace |
| Parity harness (Phase A) | `scripts/verify_bishop_phase_a_parity.mjs` | Extend with new fixtures (§5.6.7) |

### 5.4 Workflow (single geometry, seepage as an overlay)

```
Geometry (already drawn for Bishop/Spencer — unchanged):
   a. Terrain polyline
   b. Regions (auto from CPT, or user-drawn / edited)
   c. Materials with c', phi', gamma, gamma_sat
   d. Optional: phreatic polyline, retaining wall(s), surface load

Seepage tab (new, sits on the same canvas):
   1. Assign kx, ky per material
      - Defaults come from CPT kh_rep, kv_rep when available
      - Fallback: built-in classified-soil heuristic (§5.1)
      - User edits tagged kSource='user', preserved across reclassification

   2. Boundary conditions
      - Enter BC mode; click an outer-boundary edge
      - Choose: prescribed head (value), no-flow (default), seepage face
      - Edges identified by stable edgeKey so BCs survive
        geometry edits that do not touch the edge
      - Validation: at least one prescribed-head edge required to solve

   3. Mesh + solve (single action)
      - Click "Run seepage"
      - Worker runs: CDT of (terrain + base + sides) with region
        boundaries as internal constraints, then FEM assembly + CG solve
      - For unconfined problems: outer loop on reduced-permeability
      - Target: <1 s for <3000 nodes, <3 s for <10000 nodes

   4. Results overlays (togglable, rendered on the same canvas):
      - Head field (filled colormap + equipotential isolines)
      - |q| field (colormap) and q vector arrows (downsampled)
      - h = y isoline = water-table line (the "h=0" line in the
        user's shorthand — clarified in §9.1)
      - Exit-gradient ribbon on seepage-face edges
      - Single-number readouts: Q (m^3/s/m run), max exit gradient,
        i_cr/i for piping assessment

Use in Bishop/Spencer (opt-in, §12):
   - Checkbox "Use FEM pore pressure" on the slope panel
   - Off: Bishop/Spencer use the drawn phreatic, unchanged (bit-identical)
   - On:  Bishop/Spencer read u(x, y) from the seepage result via
          element shape functions; if the slice base falls outside
          the mesh, fall back to the hydrostatic value
```

The single-geometry rule is load-bearing: there is **one** geometry model, produced once by `buildBishopModelFromStageLayers`. The seepage subsystem reads it and writes only into `bishopState.seepage.*` slices. Bishop/Spencer never read from those slices unless the opt-in switch is on.

---

## 5.5 Phase A — Polygon soil regions for the slope solver (prerequisite)

### 5.5.1 Why Phase A exists

The seepage module (Phase C) and the user-drawn soil region UI (Phase B) both depend on the slope and retaining-wall solvers reading soil properties from **polygon regions** instead of horizontal bands. The current slope-stability code (`src/lib/cpt-app/stage6-bishop.js`) carries both representations side-by-side:

- `model.bands[]` — horizontal strips `{ topY, botY, topFollowsTerrain, material }`. This is the representation **actually consumed by the solver** for material lookup and weight integration.
- `model.regions[]` — closed polygons built from those bands via `buildHorizontalBandPolygons`. Currently used only for rendering and region inspection.

Phase A removes the band abstraction from the solver path and makes polygon regions the single source of truth. CPT-derived horizontal layering is preserved as the default, produced as flat-topped polygons (possibly following terrain on the top band), so the existing one-click CPT-to-slope workflow is **unchanged from the user's point of view**.

Phase A introduces no new user-facing features. It is a pure refactor with a numerical-parity gate.

### 5.5.2 Current solver touch-points that depend on `bands`

Three sites in `stage6-bishop.js` consume `model.bands`:

1. **`baseMaterialAt(model, x, yBase)` at L196–L209** — returns the material the slice base sits in. Used by slice construction and by diagnostics.
2. **Slice weight integration at L669–L700** — iterates `model.bands.forEach((band) => ...)` inside each slice, computing Simpson-integrated area and weight per band via `deriveBandContributionAtX` (L211). Produces the `layerAreas[]` breakdown exposed in the Stage 6 UI.
3. **Retaining-wall passive-side integration at L420–L460** — identical band-overlap loop used to build passive-thrust segments along the wall probe line.

All three assume horizontal strips with at most one "follows terrain" flag on the top band. These are the only three sites that need to change.

The Bishop/Spencer kernels (`evaluateSpencerState`, `ordinarySeed`, `buildDiagnostics`, `finalizeSpencerSlices`) do **not** read bands or regions — they operate on already-built slices. They stay untouched.

### 5.5.3 Target data model

```text
SoilRegion {
  id:                 string         // stable identifier
  polygon:            Point[]        // closed, CCW, non-self-intersecting
  material:           Material       // reference into the existing material library
  source:             'cpt-auto' | 'user-drawn'
  topFollowsTerrain:  bool           // true only for CPT-auto regions whose top
                                     //   edge should track terrain edits
}

Material (existing, unchanged in Phase A) {
  id, label, cEff, phiEffDeg, gammaDry, gammaSat, ...
  // kx, ky, porosity, etc. added in Phase C, NOT Phase A.
}

model = {
  terrain:         Polyline
  phreatic:        Polyline | null
  regions:         SoilRegion[]       // single source of truth
  surfaceLoad:     SurfaceLoad | null
  cptX:            number
  analysisBottomY: number
  // bands[] REMOVED once Phase A flag is flipped
}
```

**Polygon invariants enforced at model build time:**
- Vertices counter-clockwise, no self-intersection, no duplicate consecutive vertices.
- Regions tile the modeled domain (`xMin..xMax × analysisBottomY..terrain(x)`) with no gaps and no overlap. Overlap is a hard error; gaps are a hard error unless explicitly marked as `void`.
- On shared edges, a **half-open ownership rule** applies: a point lying on the top or left edge of a region is owned by that region; a point on the bottom or right edge is owned by the neighbor. This makes `materialAt` deterministic and matches the current band tie-breaking behavior.

### 5.5.4 Replacement primitives

Two new pure functions replace all band-dependent logic. Both live in a new module `src/lib/cpt-app/soil-regions.js` so they can be unit-tested in isolation.

#### A. `materialAt(regions, x, y) → Material | null`

Strength-side probe used by `baseMaterialAt`. Linear scan is adequate (typical region count ≤ 20). For performance, wrap behind a lazily-built index keyed by `x`-bucket; not required for v1.

```text
function materialAt(regions, x, y):
  for region in regions:
    if pointInPolygonHalfOpen(region.polygon, x, y):
      return region.material
  return null
```

The `pointInPolygonHalfOpen` routine uses the standard ray-casting algorithm with the half-open edge rule described in §5.5.3. Deterministic on shared boundaries.

#### B. `regionStripOverlap(regions, xL, xR, yTop(x), yBase(x)) → StripContribution[]`

Weight-side integration used by slice construction and by the wall passive-side probe. Returns a list `{ material, area, weight }` — one entry per region that intersects the slice strip.

Mathematically: for each region, compute the area of the intersection of its polygon with the slice strip `{ (x, y) : xL ≤ x ≤ xR, yBase(x) ≤ y ≤ yTop(x) }`, and the weighted area that splits at the phreatic line into `γ` and `γ_sat` contributions.

```text
function regionStripOverlap(regions, xL, xR, yTopFn, yBaseFn, phreaticFn):
  contributions = []
  for region in regions:
    // Step 1: clip the region polygon against the vertical strip xL..xR
    //         using Sutherland-Hodgman (two axis-aligned half-planes).
    clipped = clipPolygonToXRange(region.polygon, xL, xR)
    if clipped is empty: continue

    // Step 2: clip against the curved top and base.
    //         For the slope solver, yTop(x) = terrain(x) (piecewise linear)
    //         and yBase(x) is the circular arc sampled at xL, xMid, xR
    //         (matches the current Simpson scheme exactly for horizontal
    //         bands, generalises cleanly for arbitrary polygons).
    clipped = clipPolygonAboveCurve(clipped, yBaseFn)
    clipped = clipPolygonBelowCurve(clipped, yTopFn)
    if clipped is empty: continue

    // Step 3: split by phreatic to separate dry/wet weight.
    if phreaticFn:
      aboveWater = clipPolygonAboveCurve(clipped, phreaticFn)
      belowWater = clipPolygonBelowCurve(clipped, phreaticFn)
    else:
      aboveWater = clipped
      belowWater = empty

    areaAbove = polygonArea(aboveWater)   // shoelace
    areaBelow = polygonArea(belowWater)
    area      = areaAbove + areaBelow
    if area < GEOM_EPS: continue

    weight = areaAbove * region.material.gammaDry
           + areaBelow * region.material.gammaSat

    contributions.push({ material: region.material, area, weight })

  return contributions
```

**Numerical equivalence with the current Simpson scheme.** For horizontal-top, horizontal-bottom polygons (the CPT-auto case), `clipPolygonAboveCurve` with a linearized parabolic base is algebraically identical to the current three-point Simpson rule when the slice width is small enough that the base arc is well-approximated by a parabola. For the slice widths currently used (≤1 m, typical arc sag ≪ 1 cm across a slice), the difference is below floating-point noise. This is the property the parity harness (§5.5.7) verifies.

**Base-curve sampling.** To keep the arc approximation parity-identical to the current code, Phase A samples the slip circle at the same three `x` stations (`xL, xMid, xR`) and builds a piecewise-linear three-segment lower edge for the clip. Phase A does **not** attempt to clip against the true arc; that can come in a later refactor if it ever matters numerically.

### 5.5.5 CPT-to-regions generator

Replaces the current `bands` construction in `buildBishopModel`. Emits one polygon per CPT layer, terrain-following on the topmost layer, flat elsewhere, and fully tiling the domain down to `analysisBottomY`.

```text
function buildCptAutoRegions(terrain, layers, cptX, analysisBottomY, materials):
  yGround = terrainY(terrain, cptX)
  xL      = terrain.vertices[0].x
  xR      = terrain.vertices[last].x

  regions = []
  for i, layer in enumerate(layers):
    topY = yGround - layer.top
    botY = (i === last) ? analysisBottomY : yGround - layer.bot
    followsTerrain = (i === 0)

    polygon = buildBandPolygon(terrain, xL, xR, topY, botY, followsTerrain)
    regions.push({
      id:                `cpt-${i}`,
      polygon,
      material:           materials[i],
      source:            'cpt-auto',
      topFollowsTerrain:  followsTerrain
    })
  return regions
```

`buildBandPolygon` is the existing `buildHorizontalBandPolygons` logic, retained verbatim and renamed — it already produces exactly the right polygons, we just start trusting them.

**Regeneration rule:** whenever terrain or CPT layer boundaries change, `cpt-auto` regions are rebuilt from scratch; `user-drawn` regions are preserved. This is enforced at the state-update boundary, not inside the solver.

### 5.5.6 Site-by-site migration

| Site | Current | After Phase A |
|---|---|---|
| [stage6-bishop.js:196-209](src/lib/cpt-app/stage6-bishop.js#L196-L209) `baseMaterialAt` | `for band of model.bands: if upper ≥ probeY ≥ lower ...` | `materialAt(model.regions, x, yBase + 0.05)` |
| [stage6-bishop.js:669-700](src/lib/cpt-app/stage6-bishop.js#L669-L700) slice weight loop | `model.bands.forEach(band => simpsonIntegrate(...))` | `regionStripOverlap(model.regions, xL, xR, terrainY, arcY, phreaticY)`; sum `{area, weight}` into `layerAreas[]` keyed by `material.id` |
| [stage6-bishop.js:420-460](src/lib/cpt-app/stage6-bishop.js#L420-L460) wall passive probe | same band-overlap loop along wall line | same `regionStripOverlap` call with `yTop, yBase` from the wall-probe geometry |
| [stage6-bishop.js:1834-1852](src/lib/cpt-app/stage6-bishop.js#L1834-L1852) model build | builds `bands[]` then derives `regions[]` | builds `regions[]` directly via `buildCptAutoRegions`; `bands[]` deleted |

Everything else in the solver — slice cut placement, surcharge overlap, Bishop iteration, Spencer kernel, diagnostics, finalize, report — is unchanged.

### 5.5.7 Parity harness (the gate for merging Phase A)

Before the `useRegionsForSolver` feature flag is flipped, the following test suite must be green:

```text
For each fixture in test/fixtures/bishop-regression/*.json:
  Build model with the legacy bands pipeline   → resultLegacy
  Build model with the new regions pipeline    → resultRegions

  assert abs(resultLegacy.F_bishop - resultRegions.F_bishop) ≤ 1e-6
  assert abs(resultLegacy.F_spencer - resultRegions.F_spencer) ≤ 1e-6  (if Spencer enabled)
  assert abs(resultLegacy.lambda - resultRegions.lambda) ≤ 1e-6

  For each slice i:
    assert abs(legacy.slices[i].weight - regions.slices[i].weight) ≤ 1e-6
    assert legacy.slices[i].baseMaterial.id === regions.slices[i].baseMaterial.id
    For each entry in layerAreas:
      assert abs(legacy.area - regions.area) / max(legacy.area, 1e-6) ≤ 1e-6

  For each wall-probe segment j (retaining-wall cases):
    assert abs(legacy.segments[j].weight - regions.segments[j].weight) ≤ 1e-6
    assert legacy.segments[j].material.id === regions.segments[j].material.id
```

**Fixture coverage required before the flag flips:**
- Homogeneous dry slope.
- Slope with phreatic line crossing multiple layers.
- Layered slope with 4+ CPT layers.
- Near-steep exit case (tests `m_α` robustness).
- Slope with a surcharge zone straddling slice boundaries.
- Retaining-wall case with multi-layer passive side.
- A Fredlund & Krahn 1977-style published Spencer case.

A CI job runs the harness on every commit to the slope-stability code.

### 5.5.8 Rollout plan

1. **Land `soil-regions.js`** with `materialAt`, `regionStripOverlap`, `buildCptAutoRegions`, and unit tests for each primitive (polygon clipping, point-in-polygon half-open rule, area computation). No solver changes yet.
2. **Wire the parity harness** with both pipelines running side by side under a feature flag `useRegionsForSolver: false`. On every fixture, compute both results, diff them, log the maximum per-slice residual. Do not gate execution on parity yet — just collect data.
3. **Tighten the clipping until residuals are below 1e-6.** Expected work: 2–3 days to chase down edge cases (points exactly on polygon edges, slice boundaries coincident with region boundaries, near-horizontal slip arcs at tangent to a layer boundary).
4. **Flip the flag** when the harness is clean across the full fixture set. Delete `bands[]`, `deriveBandContributionAtX`, and `baseMaterialAt`'s band-iteration branch.
5. **Single follow-up PR** removes the feature flag itself and all dead-branch code.

Expected total effort for Phase A: **4–6 working days** for a clean landing, including the parity harness and fixture creation. Most of the risk lives in step 3.

### 5.5.9 Acceptance criteria for Phase A

- All existing Stage 6 Bishop, Spencer, and retaining-wall fixtures produce bit-equivalent outputs (≤1e-6 relative) with the regions-based solver.
- `model.bands` no longer exists in the codebase.
- `model.regions` is the single source of truth, tagged with `source`.
- The Stage 6 UI and Stage 7 report are byte-identical to the pre-Phase-A output on the fixture set.
- The material library is unchanged. No `kx, ky` or seepage-specific fields added in Phase A.
- No user-visible change in the app. The "Import from CPT" button, the polygon drawing tool, and the seepage tab are **deferred to Phase B and Phase C**.

### 5.5.10 What Phase A explicitly does NOT include

- No user-drawn polygon UI (Phase B).
- No `kx, ky` fields on Material (Phase C).
- No seepage solver, mesh generator, or FEM assembly (Phase C).
- No change to pore-pressure computation — still hydrostatic from the drawn phreatic line.
- No change to slice generation, Bishop iteration, Spencer kernel, or retaining-wall thrust math.
- No new report fields, no new Stage 7 payload keys.

Phase A is a structural prerequisite. It ships invisible to the end user and buys us the freedom to add Phase B and Phase C without rewriting the slope-stability solver again.

---

## 5.6 Phase 2 — Seepage implementation plan (Phase A landed)

Phase 2 adds steady-state seepage analysis on top of the existing geometry. It reuses the model `buildBishopModelFromStageLayers` already builds and writes into a new `bishopState.seepage.*` slice. Bishop/Spencer default behaviour is unchanged; FEM pore pressure is an opt-in switch on the slope panel.

### 5.6.1 Module layout

New code lives under `src/lib/cpt-app/seepage/`:

```
src/lib/cpt-app/seepage/
  boundary.js           // outer boundary extraction, edgeKey migration, geometry hash
  material.js           // kx, ky defaults and CPT/user override logic
  pslg.js               // seepage-specific PSLG build on the shared section mesher
  mesh-triangle.js      // Triangle adapter + region tagging
  triangle-runtime.js   // low-level Triangle WASM wrapper
  solver.js             // FEM assembly, active-set seepage faces, wet/dry iteration, post-processing
  seepage-worker.js     // worker entry point: mesh + solve

src/lib/cpt-app/mesh/
  section-pslg.js       // shared section-to-PSLG helpers reused by deformation
  section-mesh.js       // shared mesh assembly helpers reused by deformation

scripts/verify_seepage_phase_2.mjs
```

The current implementation intentionally keeps most seepage numerics in `solver.js` rather than splitting them into separate `fem.js`, `free-surface.js`, and `post.js` modules. That keeps the active-set, wet/dry, and boundary-flux logic in one place while the architecture is still stabilizing.

All new modules are tree-shakeable — they are only imported from the seepage panel and the opt-in pore-pressure hook. The existing `stage6-bishop.js` gets two small additions:

1. `importBishopMaterialsFromLayers` plumbs `kx`, `ky`, `kSource` (§5.1).
2. The slice pore-pressure evaluation grows one branch that reads `bishopState.seepage.result` (via the `model.seepage` passthrough that `buildBishopModelFromStageLayers` will copy, mirroring how it already copies `phreatic` and `surfaceLoad`) when `bishopState.useFemPorePressure` is on **and** a result exists. The default branch is byte-identical to today.

### 5.6.2 Single geometry, zero schema churn on the Bishop model

The seepage subsystem never mutates `model.regions`, `model.terrain`, `model.phreatic`, or any existing field. It reads them and writes results into a sibling slice:

```
bishopState {
  ...existing Phase A fields...
  seepage: {
    bcs: SeepageBC[],            // user-assigned edge BCs (persistent)
    mesh: SeepageMesh | null,    // last generated mesh (invalidated on geom edit)
    result: SeepageResult | null,// last solved field (invalidated on mesh edit)
    status: 'idle' | 'meshing' | 'solving' | 'success' | 'failed',
    rejectReason: string,
    geometryHash: string | null, // cheap fingerprint of the model inputs that
                                 // produced mesh+result; compared on rebuild to
                                 // detect stale state (see §5.6.2)
    options: {
      freeSurface: 'fixed' | 'iterate',
      usePhreaticAsSeed: boolean,
      flowErrorTolerance: number,
      maxRuntimeMs: number,
      meshTargetArea: number,
      meshTargetAreaAuto: boolean
    },
    display: {
      showBoundaryConditions: boolean,
      showBoundaryLabels: boolean,
      showHead: boolean,
      showEquipotentials: boolean,
      showFlowVectors: boolean,
      showExitGradient: boolean
    }
  },
  useFemPorePressure: boolean    // opt-in switch, off by default
}
```

Invalidation rules (all triggered on every `buildBishopModelFromStageLayers` call, by comparing `geometryHash` to a freshly computed hash of the current inputs):

- Any change to `terrain`, `regions`, `walls`, `analysisBottomY`, or `materials[*].{kx, ky}` → clear `seepage.mesh` **and** `seepage.result`.
- Change to `phreatic` while `options.freeSurface === 'fixed'` → clear both (the phreatic is an internal mesh constraint in that mode; see §5.6.6).
- Change to `phreatic` while `options.freeSurface === 'iterate'` → clear only `seepage.result` (mesh is independent of the phreatic).
- Change to any `seepage.bcs` entry → clear only `seepage.result`.
- Change to `options.freeSurface`, `options.usePhreaticAsSeed`, `options.meshTargetArea`, or `options.meshTargetAreaAuto` → clear the cached state whenever the geometry hash changes.

The seepage panel UI reflects invalidation with a dirty-state pill so the user knows the displayed field matches the current geometry.

### 5.6.3 Outer boundary and `edgeKey` (BC persistence)

The domain for the FEM solve is the closed polygon:

```
outerBoundary = terrain (left→right)
              + right-side vertical segment (x_right, y_ground_right → y_base)
              + model base (right→left at y = model.analysisBottomY)
              + left-side vertical segment (x_left, y_base → y_ground_left)
```

`model.analysisBottomY` already exists ([stage6-bishop.js:2040](src/lib/cpt-app/stage6-bishop.js#L2040)) and is the base of the slope-stability analysis window, so the two solvers share the same depth extent.

BCs are attached to outer-boundary **segments** (consecutive polyline pairs). Each BC carries both an ephemeral `edgeKey` (valid for the current model build only) and a persistent **anchor** — the midpoint coordinates and tangent direction at the time the BC was assigned:

```
Persistent (survives geometry edits):
  anchor: { mid: { x, y }, tangent: { dx, dy }, source: 'terrain'|'base'|'side-left'|'side-right' }

Ephemeral (rebuilt on every buildBishopModelFromStageLayers call):
  edgeKey: `terrain:${i}-${i+1}`      // index pair into model.terrain.vertices
         | 'base'
         | 'side-left' | 'side-right'
```

Migration on rebuild: `boundary.js:migrateBcs(oldBcs, newOuterBoundary)` snaps each BC's anchor to the nearest new outer-boundary segment by midpoint distance (with a tangent check to reject wraparound matches). If the nearest match is within a tight tolerance (say, 0.5 × segment length), the BC carries over and gets a fresh `edgeKey`. Otherwise `status: 'orphaned'` and the panel prompts the user to reassign. This is the same "match-by-geometry, cache-by-index" pattern Phase A's region migration uses for CPT re-imports.

Region boundary edges (interior) never carry BCs — they are constraint edges for the mesher only.

### 5.6.4 Mesh generation contract

`mesh.generate(model, options)` is the single entry point:

```
Input:
   outerBoundary   : from §5.6.3                  (polyline, closed)
   internalEdges   : for each region r, segments of r.polygon that are
                     NOT on outerBoundary (deduplicated across regions
                     via shared-edge detection with GEOM_EPS tolerance)
   phreaticEdges   : only when options.freeSurface === 'fixed' — the
                     segments of model.phreatic clipped to the domain
                     interior; added as an internal constraint so the
                     mesh has a crease along the water table
   wallRegions     : for each retaining wall in model.walls, a thin
                     rectangle (default thickness 0.1 m) around the
                     segment (wall.x, wall.yTop) → (wall.x, wall.yTip),
                     auto-promoted to a region with a fixed low-k
                     material (k = 1e-10 m/s) and source='wall-auto';
                     see §5.6.10 for the rationale (zero-thickness
                     node-splitting is deferred)
   regionSeeds     : one interior point per region (centroid works if
                     polygonArea(r.polygon) > threshold; otherwise walk
                     to a vertex and inset by ε along the inward normal)
   maxArea         : from options.meshTargetArea
                     auto mode   = clamp(domainArea / 3500, 0.05, 1.5) m^2
                     manual mode = positive user-entered target area
   regionAreaLimit : max(maxArea * region.coarseness, 1e-4)
   minAngleDeg     : 20

Output:
   nodes           : Float64Array (x0, y0, x1, y1, ...)
   elements        : Uint32Array  (n1, n2, n3, ...)
   elementRegion   : Uint16Array  (index into model.regions)
   boundaryEdges   : Uint32Array  (n1, n2, edgeKeyIndex, ...)
   edgeKeys        : string[]     (edgeKeyIndex → edgeKey)
   interiorEdgeTags: Uint8Array   (per internal constraint edge: 0=region,
                                   1=phreatic) — used during BC
                                   assembly to apply no-flow / h=y.
                                   Wall constraints are absorbed into
                                   regions (wallRegions above), so they
                                   appear with tag 0 like any other
                                   region boundary.
```

This is the single place where `model.phreatic` and `model.walls` enter the seepage pipeline. They are read, never mutated — §5.6.2's invariant holds.

Two key invariants:

- **Region tagging is exact**, not by centroid lookup. The mesher receives `regionSeeds` (one interior point per region) and propagates the tag through triangle adjacency. This is what Triangle's `-A` flag does natively. Fallback when a seed falls on a region edge: walk the centroid inward by ε along the local inward normal; if still ambiguous, pick the region with larger `polygonArea` (deterministic).
- **Boundary edges carry an edgeKey**, so Dirichlet BCs can be assembled without a second point-in-polyline pass during solve.

**Mesher choice**

Shewchuk's Triangle is the reference CDT that handles PSLGs with quality constraints in production. The current implementation uses a Triangle WASM adapter behind `triangle-runtime.js`. Required capabilities remain:

- ESM import compatible with Vite / SvelteKit
- region markers (Triangle's regional-attribute mechanism with `-A`)
- area constraints (`-a`)
- quality constraints (`-q20`)
- permissive license (Triangle itself is redistributable non-commercially, but Shewchuk has clarified commercial redistribution arrangements — verify license for the specific WASM port and for this repo's AGPL-3.0-or-later top-level license)
- bundle footprint target: <300 kB gzipped

Evaluation gate: a 5-line round-trip test on a known PSLG fixture, checking node/element counts and region-tag correctness against the Phase A fixtures. If no port clears the gate, the fallback is a pure-JS poly2tri adapter plus a post-mesh smoother to enforce minimum-angle quality. That is a 2–3 week detour; avoid if possible.

### 5.6.5 FEM kernel (unchanged from §7, summary)

The element and assembly math is fully specified in §7. Key points for integration:

- T3 CST elements, constant conductivity per element. The lookup is via the region the element belongs to, **not** a parallel `materials[]` array index: `model.regions[elementRegion[e]].material.{kx, ky}` — each region already carries a direct `.material` reference ([stage6-bishop.js:2060-2062](src/lib/cpt-app/stage6-bishop.js#L2060-L2062), [soil-regions.js:200](src/lib/cpt-app/soil-regions.js#L200)).
- Anisotropy handled at assembly time; no global rotation needed because `kx`, `ky` are aligned to world axes.
- Dirichlet via row-elimination (§7.4 Method 1) — preserves SPD for CG.
- `solver.js` is a ~120-LoC CG + Jacobi preconditioner on CSR. Banded Cholesky added only if CG fails to converge in 500 iterations (hasn't been needed in SPD Laplacians on quality meshes).

### 5.6.6 Free-surface handling (two modes)

For the shipped workflow the user picks one:

- **`iterate`**: this is the current default. The solver keeps one full-domain mesh, classifies elements by pressure-head sign and wet area fraction, scales dry conductivity by `k × 1e-4`, and runs an outer loop that couples:
  - wet/dry reclassification,
  - outer-boundary seepage-face activation,
  - boundary-flow balance checking.
  Convergence is accepted only when the seepage-face active set is stable, the normalized boundary flow error is within `flowErrorTolerance` (default `1%`), and no disconnected wet islands remain. The run is also bounded by `maxRuntimeMs` (default `10 s`). If `usePhreaticAsSeed` is on, the drawn phreatic line is used only as a warm start for the first wet/dry guess.
- **`fixed`**: take `model.phreatic` as given. Meshing treats the phreatic polyline as an internal constraint (via `phreaticEdges` in §5.6.4). Elements above it are treated as dry with `k × 1e-4`, and the phreatic nodes are clamped to `h = y`. This is useful for benchmarking, sensitivity checks, or intentionally locking the seepage geometry to a known water table.

The important implementation detail is that the live iterative mode does **not** remesh the phreatic surface geometry itself. It solves on one fixed mesh and updates the saturated subset numerically.

### 5.6.7 Parity harness extension

The Phase A harness `scripts/verify_bishop_phase_a_parity.mjs` gets a new suite:

```
For each fixture:
  Case A — useFemPorePressure = false, seepage not configured
    → Bishop/Spencer outputs must be bit-identical to the Phase A baseline
      (F, lambda, slice weights, layer areas, wall forces, all within 1e-9)

  Case B — useFemPorePressure = true, seepage.result = null
    → Bishop/Spencer must fall back to hydrostatic and produce Case A output
      (graceful degradation, no crash, visible warning in diagnostics)

  Case C — useFemPorePressure = true, seepage.result from a known FEM field
    → Pore pressure at each slice base midpoint matches direct sampling
      of h(x, y) from the mesh, within 1e-6 kPa. This is a clean exact
      test of the interpolation, independent of the solver.
    → Sign consistency: if the FEM field has u(xMid, yBase) systematically
      higher than the hydrostatic model (wet core, slow drainage), F must
      be lower than Case A. Symmetric for drier fields. No strong
      numerical equality is asserted — the Bishop iteration couples slice
      u into m_alpha, so no closed-form F delta is available.

Plus two new seepage-only fixtures (not Bishop):
  Case D — confined flow under a sheet pile (Test 1 of §13)
    → compare FEM heads at 10 probe points to analytical ≤ 2% of Δh
  Case E — homogeneous dam (Test 2 of §13)
    → compare phreatic y(x) at 10 x-stations to Casagrande ≤ 5% of dam height
```

`scripts/verify_seepage_phase_2.mjs` runs Cases D–E in CI. Cases A–C extend the existing Bishop parity job.

### 5.6.8 Landing path (historical, now largely shipped)

```
Step 1 (plumbing, ~2 days):
  - Extend Material with kx, ky, kSource
  - SBTn-default table in seepage/material.js
  - Extend Phase A parity harness with Case A (materials-with-k, still identical F)
  - Ship: no visible change

Step 2 (mesher integration, ~3 days):
  - Integrate triangle-wasm (ESM + worker)
  - boundary.js: outer boundary + edgeKey
  - pslg.js + mesh-triangle.js: PSLG assembly, region seeding, tagging
  - Unit tests: round-trip a known fixture, check node/element counts and
    tag correctness against expected region ownership
  - Ship: no visible change

Step 3 (seepage panel + BC UI, ~3 days):
  - New Svelte tab on the Bishop panel
  - Material k editor (kx, ky with SBTn defaults, unit hints)
  - BC mode on the canvas: click edge → head / no-flow / seepage face
  - edgeKey migration across geometry edits
  - Ship behind a feature flag (seepage-panel-v1)

Step 4 (FEM solve + visualisation, ~5 days):
  - solver.js (SPD CG + active-set seepage faces + post-processing)
  - fixed mode first, then iterative wet/dry mode
  - Canvas overlays: head colormap, |q| colormap, arrows, h=y line
  - Single-number readouts (Q, max exit gradient, piping factor)
  - Ship under seepage-panel-v1 flag (Phase 2 MVP)

Step 5 (free-surface iteration, ~2 days):
  - 'iterate' mode + outer loop
  - Convergence diagnostics
  - Extend fixtures (Test 2 of §13)
  - Ship: flip 'iterate' option on, still behind flag

Step 6 (Bishop integration, opt-in, ~2 days):
  - useFemPorePressure switch on slope panel
  - element containment + shape-function interpolation inside the seepage solver helpers
  - Fallback to hydrostatic outside the mesh
  - Case B and Case C parity tests must pass before the switch is visible
  - Ship: flag flips to public

Total: 15–17 working days (~3 weeks) for the full path to public release.
Steps 1–4 alone (~13 days) produce a shippable standalone seepage tool.
```

### 5.6.9 Acceptance criteria

- With `useFemPorePressure = false`, every Phase A fixture produces bit-identical outputs before and after Phase 2 is merged (same F, same λ, same slice forces, same layer areas, same wall thrust — within 1e-9 across all existing regression fixtures).
- With the seepage panel closed and no `seepage.*` state, the Bishop/Spencer code paths are syntactically unchanged from Phase A (verified by checking that the `seepage.*` branches are only entered when `bishopState.seepage?.result` is non-null).
- On a homogeneous isotropic domain with h-Dirichlet on upstream and downstream sides and no-flow elsewhere, the FEM head field is linear and flow is 1D, matching Q = k·Δh·H/L within 1%.
- Materials without `kx`/`ky` (old saved states) load without errors; the seepage panel surfaces a "assign permeability" warning instead of crashing.
- The Stage 7 report payload gets an optional `seepage` sub-object. Absence of the key must render identically to today (hydrostatic diagram, no seepage panel in the PDF). The Stage 7 payload validator is extended to accept the new key without requiring it.

### 5.6.10 What Phase 2 explicitly does NOT include

- No transient / unsaturated flow (no consolidation time curves, no Richards equation — v3).
- No coupled flow-deformation (no PLAXIS-style effective-stress update — v3).
- No 3D — 2D plane strain only.
- No true zero-thickness sheet-pile / cutoff interface yet. The current retaining-wall approximation is a **thin region** (default thickness `0.1 m`) of fixed low conductivity (`k = 1e-10 m/s`) auto-generated from each `model.walls[i].{x, yTop, yTip}`. This is useful and already shipped, but it is still an approximation to a duplicated-node cutoff interface.
- No second geometry tab. No separate terrain, no separate regions, no separate phreatic.
- No change to Bishop/Spencer math when `useFemPorePressure` is false.

### 5.6.11 Current implementation decisions and shortcuts

The live Stage 6 seepage tool makes the following deliberate modelling and numerical choices. These are important for interpretation:

- The shared section still starts from **one active CPT column**. Unless custom polygons are enabled, the interpreted CPT layers are extended laterally across the whole section before seepage is run.
- When permeability is not explicitly supplied from CPT data or a user override, the current `kSource = 'sbtn-default'` path uses built-in soil-type heuristics from the classified layer labels. Treat those values as practical starting points, not measured conductivity.
- Only **outer-boundary** edges can carry seepage BCs. Internal drains, relief wells, and line sinks are not yet part of the solver; see [drain.md](drain.md) for the planned one-way drain design.
- A prescribed-head BC on a sloping or vertical outer edge is applied only to the **submerged** part below `y = h`. The dry portion above that elevation reverts to natural no-flow.
- The iterative free-surface solve uses a **dry-conductivity scaling** (`DRY_FACTOR = 1e-4`) and a conductivity floor (`1e-20 m/s`) as numerical safeguards. This is a practical wet/dry screening model, not an unsaturated constitutive law.
- If the wet/dry iteration creates disconnected wet pockets that are not connected to a prescribed-head boundary, the solver applies a **connectivity fallback** and dries those islands out. This avoids spurious trapped saturated zones on a single-domain mesh.
- Retaining walls are represented as thin low-`k` polygons, not as true zero-thickness duplicate-node cutoffs. Tip gradients should still be checked with a mesh sensitivity run on important cases.
- The seepage mesh target is exposed as a **numeric target area**, not just coarse/medium/fine presets. In auto mode it scales with the section area; in manual mode it uses the user value directly.
- Polygon `coarseness` multiplies the local mesh target area by `global meshTargetArea × coarseness`. This is a numerical refinement control only; it is not a soil property.
- Bishop/Spencer coupling samples `u = gamma_w * (h - y)` from the seepage mesh, clamps suction to zero, and falls back to hydrostatic phreatic pore pressure whenever a sample point lies outside the mesh or no seepage result exists.

---

## 6. Mesh Generation

### 6.1 Constrained Delaunay triangulation

The domain (the cross-section below the terrain, bounded by model edges) must be discretised into non-overlapping triangles. The triangulation must respect all geometry constraints: region boundaries, terrain segments, and internal features (drains, cutoffs) must appear as element edges. This is called a *constrained Delaunay triangulation* (CDT).

```
Input to the mesher:
  - Outer boundary: terrain polyline + model base + model sides
    (forms a closed polygon — the PSLG outer boundary)
  - Internal constraints: all region boundary edges
  - Holes: none in v1 (the entire domain is soil)
  - Optional: point constraints at BC locations for refinement

Output from the mesher:
  - nodes[]: array of {x, y, index}
  - elements[]: array of {n1, n2, n3} (three node indices per triangle)
  - boundary_edges[]: array of {n1, n2} edges on the outer boundary

PSLG = Planar Straight Line Graph — the standard input format for
constrained Delaunay triangulators. Your geometry polygons are
already essentially a PSLG.
```

**Library recommendation**: use Shewchuk's Triangle algorithm (via a WASM port for the browser). It produces quality meshes with minimum angle constraints, handles PSLGs natively, and supports area constraints for mesh density control. If Triangle is not available, poly2tri is a simpler alternative but with fewer quality controls.

### 6.2 Mesh density control

The mesh should be finer where gradients are steep (near boundaries, corners, transitions between soil types) and coarser in the interior.

```
Mesh density strategy:
  - Auto mode: maximum element area = clamp(domain_area / 3500, 0.05, 1.5) m^2
    This keeps larger sections from silently becoming too dense.
  - Manual mode: the entered meshTargetArea is used directly.
  - Region coarseness: local max area = global meshTargetArea × region.coarseness
  - Boundary densification: prescribed-head, seepage-face, terrain,
    and fixed-phreatic segments are split to shorter target edge lengths.
  - Region-boundary densification: internal material interfaces inherit
    a segment length derived from the local area target.

Quality constraint:
  - Minimum angle ≥ 20° (prevents degenerate slivers).
    Triangle's -q20 flag does this automatically.
  - Maximum angle < 120° (follows from minimum angle for
    well-shaped triangles).

Typical mesh sizes for practical problems:
  - Simple embankment: 500–2000 elements, <0.5 s solve time
  - Complex layered section: 2000–5000 elements, <2 s solve time
  - Fine detail (thin drains, cutoffs): 5000–10000 elements, <5 s
```

### 6.3 Region tagging

Each element must be tagged with the `model.regions[]` index it belongs to. Do this through Triangle's region-marker mechanism (the `-A` flag), not a per-element point-in-polygon scan:

```
Input to the mesher for each region r in model.regions:
  regionSeed = interiorPoint(r.polygon)
  regionMarker = index of r in model.regions

Triangle propagates the marker through adjacency within each
connected component bounded by constraint edges.

Post-mesh, elementRegion[e] lets us look up k directly:
  mat = model.materials[model.regions[elementRegion[e]].material?.id]
  e.kx = mat.kx
  e.ky = mat.ky
```

Fallback when a seed computation is ambiguous (skinny region, centroid outside polygon): use the same `pointInPolygonHalfOpen` rule Phase A already relies on ([soil-regions.js:216](src/lib/cpt-app/soil-regions.js#L216)) to verify, then inset the seed along the inward normal. If a tie survives, pick the region with the larger `polygonArea` — this is the same deterministic tiebreak Phase A uses when regions overlap.

**Do not** use `materialAt(regions, xc, yc)` per element for tagging. The half-open rule in `materialAt` is designed for point sampling in the slope solver and is deliberately last-wins over the regions array. During tagging we need **one** region per element, chosen by topological connectivity from a seed — which is exactly what Triangle provides.

---

## 7. Finite Element Formulation

### 7.1 Element type

The 3-node triangle (T3, also called CST — Constant Strain Triangle) is the simplest 2D element. Within each element, the head varies linearly:

```
h(x, y) = N1·h1 + N2·h2 + N3·h3

where:
  h1, h2, h3 = head values at the three nodes (the unknowns)
  N1, N2, N3 = linear shape functions

  N1 = (a1 + b1·x + c1·y) / (2·A)
  N2 = (a2 + b2·x + c2·y) / (2·A)
  N3 = (a3 + b3·x + c3·y) / (2·A)

  where A = element area (from shoelace formula)
  and the coefficients are:
    a1 = x2·y3 - x3·y2       b1 = y2 - y3       c1 = x3 - x2
    a2 = x3·y1 - x1·y3       b2 = y3 - y1       c2 = x1 - x3
    a3 = x1·y2 - x2·y1       b3 = y1 - y2       c3 = x2 - x1

The gradient of h within the element is constant (hence "constant
strain triangle"):
  ∂h/∂x = (b1·h1 + b2·h2 + b3·h3) / (2·A)
  ∂h/∂y = (c1·h1 + c2·h2 + c3·h3) / (2·A)
```

The T3 element is adequate for seepage analysis because the head field is typically smooth. For problems with very steep gradients (e.g. near a singularity at a sheet pile tip), mesh refinement is more effective than higher-order elements.

### 7.2 Element conductivity matrix

The element conductivity matrix relates the nodal heads to the element's contribution to the global flow balance. For a T3 element with anisotropic permeability:

```
The element conductivity matrix [K]e is a 3×3 symmetric matrix:

[K]e = (1 / (4·A)) · [B]ᵀ · [D] · [B]

where:

  [B] = | b1  b2  b3 |    (gradient-displacement matrix)
        | c1  c2  c3 |

  [D] = | kx   0 |        (constitutive matrix — Darcy's law)
        |  0  ky |

  A = element area

Expanding:
  [K]e = (1 / (4·A)) · | b1  c1 |   | kx  0 |   | b1  b2  b3 |
                        | b2  c2 | · |  0  ky | · | c1  c2  c3 |
                        | b3  c3 |

  K_ij = (1 / (4·A)) · (kx·bi·bj + ky·ci·cj)

  for i, j = 1, 2, 3.

This is a CLOSED-FORM expression — no numerical integration needed.
Each element stiffness matrix takes ~20 floating-point operations.
For 5000 elements: 100,000 operations — negligible.
```

**Critical check**: the element area A must be positive. If A ≤ 0, the triangle has clockwise winding (or is degenerate). Either reverse the node ordering or reject the element.

### 7.3 Global assembly

The global conductivity matrix [K] is assembled by summing element contributions:

```
Global system:  [K] · {h} = {f}

where:
  [K] = n×n global conductivity matrix (n = number of nodes)
  {h} = n×1 vector of unknown nodal heads
  {f} = n×1 vector of applied flux (zero for no-flow nodes)

Assembly procedure:
  Initialize K = 0 (sparse), f = 0

  For each element e with nodes (i, j, k):
    Compute [K]e (3×3 matrix)
    Add to global matrix:
      K[i,i] += K_e[1,1]    K[i,j] += K_e[1,2]    K[i,k] += K_e[1,3]
      K[j,i] += K_e[2,1]    K[j,j] += K_e[2,2]    K[j,k] += K_e[2,3]
      K[k,i] += K_e[3,1]    K[k,j] += K_e[3,2]    K[k,k] += K_e[3,3]

The resulting global matrix is:
  - Symmetric (K_ij = K_ji) — store only upper or lower triangle
  - Positive definite (for well-posed problems)
  - Sparse — each row has at most ~7 non-zero entries (typical
    for triangular meshes where each node connects to ~6 neighbours)
  - Banded — the bandwidth depends on node numbering
```

### 7.4 Boundary condition application

#### Prescribed head (Dirichlet)

```
For each node i with prescribed head h_i = h₀:

Method 1 — Row elimination (recommended for clarity):
  1. Set f[j] -= K[j,i] · h₀  for all j ≠ i
  2. Set row i and column i of K to zero
  3. Set K[i,i] = 1
  4. Set f[i] = h₀

This modifies the system so that the i-th equation becomes
h_i = h₀, while preserving symmetry and the solution for all
other nodes.

Method 2 — Penalty method (simpler to code):
  1. Add a large number P (e.g. 1e20 × max(K_ii)) to K[i,i]
  2. Set f[i] = P · h₀

This forces h_i ≈ h₀ without modifying the matrix structure.
Less precise but avoids index manipulation.
```

#### No flow (Neumann)

```
No action needed — the natural boundary condition in the FEM
formulation is zero flux. Any boundary node that is not assigned
a Dirichlet BC automatically has zero flux.
```

#### Prescribed non-zero flux (Neumann)

```
For an edge with prescribed flux q₀ (m³/s per m² of boundary):

Distribute the flux to the two edge nodes:
  f[n1] += q₀ · L_edge / 2
  f[n2] += q₀ · L_edge / 2

where L_edge is the length of the boundary edge.

Positive q₀ = inflow, negative = outflow.
```

### 7.5 Solving the system

The system [K]{h} = {f} is a symmetric positive-definite linear system. For the mesh sizes in this application (1,000–10,000 nodes), the following solvers are practical:

```
For n < 3,000 nodes:
  Dense Cholesky decomposition (L·Lᵀ factorisation)
  Time: O(n³/3) ≈ 9 billion ops for n=3000 → ~2 seconds in JS
  Memory: n² × 8 bytes ≈ 72 MB for n=3000 — acceptable

For n = 3,000–10,000 nodes:
  Banded Cholesky (exploit sparsity structure)
  Bandwidth ≈ sqrt(n) for well-numbered meshes
  Time: O(n × bw²) — much faster than dense
  Alternatively: Conjugate Gradient (iterative, no factorisation)
  CG converges in ~50–100 iterations for well-conditioned seepage

For n > 10,000 nodes:
  Sparse Cholesky (CSR storage + elimination tree)
  Or preconditioned CG with incomplete Cholesky preconditioner
  This is where a proper sparse library pays off

Recommendation for v1:
  Use dense Cholesky for n < 3000, banded Cholesky above that.
  Implement CG as a fallback. Target mesh sizes of 1000–3000
  elements (500–2000 nodes), which solve in <1 second.
```

---

## 8. Free-Surface Iteration

For unconfined flow problems (where the phreatic surface location is unknown), an outer iteration loop adjusts the phreatic surface until it converges.

```
REDUCED-PERMEABILITY METHOD (recommended for v1)

1. Generate mesh for the ENTIRE domain (below terrain, above and
   below the expected phreatic surface).

2. Initial guess: set all elements to their full permeability.
   Assign initial phreatic surface as a straight line from
   upstream head to downstream head.

3. Solve loop:
   for iter = 1 to max_iter (max_iter = 30):

     a. Assemble and solve the FEM system → get h at all nodes.

     b. For each element e, compute head at centroid:
          h_centroid = (h[n1] + h[n2] + h[n3]) / 3
          y_centroid = (y[n1] + y[n2] + y[n3]) / 3

        If h_centroid < y_centroid (element is "above" phreatic):
          e.kx_effective = e.kx / 1000
          e.ky_effective = e.ky / 1000
        Else:
          e.kx_effective = e.kx   (full permeability)
          e.ky_effective = e.ky

     c. Check convergence:
          Count elements that changed state (wet→dry or dry→wet)
          If count == 0 or count < 0.1% of total elements:
            CONVERGED → extract phreatic surface and stop

     d. Re-assemble K with updated permeabilities and re-solve.

4. Extract phreatic surface:
   The phreatic surface passes through points where h = y.
   For each element that has both "wet" and "dry" nodes,
   interpolate to find the h = y contour line within the element.
   Connect these points to form the phreatic surface polyline.

Convergence: typically 5–15 iterations. Under-relaxation on the
permeability switch can help:
  k_new = k_old × (k_target / k_old)^ω
  where ω = 0.5 (blend old and new permeability)
```

---

## 9. Post-Processing

### 9.1 Flow vectors and gradients

Within each T3 element, the gradient and velocity are constant (because the head field is linear within the element):

```
For element e with nodes (1, 2, 3):

  ∂h/∂x = (b1·h1 + b2·h2 + b3·h3) / (2·A)
  ∂h/∂y = (c1·h1 + c2·h2 + c3·h3) / (2·A)

  where b and c coefficients are from §7.1

  Hydraulic gradient magnitude:
    |i| = sqrt((∂h/∂x)² + (∂h/∂y)²)

  Darcy velocity:
    qx = -kx · ∂h/∂x
    qy = -ky · ∂h/∂y

  Display: draw an arrow at the element centroid with direction
  (qx, qy) and length proportional to |q|. Scale the arrows so
  the largest is ~1/20 of the domain width.
```

### 9.2 Equipotential lines and flow lines

```
Equipotential lines (contours of constant h):
  Use a standard marching-squares or element-by-element contour
  tracing algorithm. For each contour value h_c:
    - For each element edge, check if h_c lies between the head
      values at the two endpoints
    - If yes, linearly interpolate to find the crossing point
    - Connect crossing points within each element to form
      contour line segments
    - Connect segments across elements to form continuous contours

  Recommended contour interval: (h_max - h_min) / 10–20

Flow lines (streamlines):
  In isotropic soil, flow lines are perpendicular to equipotentials.
  For anisotropic soil, they are NOT perpendicular — the angle
  depends on kx/ky.

  To trace a flow line from a starting point:
    1. Find the element containing the starting point
    2. Compute the velocity vector (qx, qy)
    3. Step a small distance in the velocity direction:
       x_new = x + qx/|q| · ds
       y_new = y + qy/|q| · ds
       where ds = typical_element_size / 5
    4. Find the new element, repeat
    5. Stop when reaching a boundary or after max steps

  For display, ~10 flow lines evenly spaced across the
  upstream head boundary provide a good flow net.
```

### 9.3 Pore-pressure field for slope stability

This is the key integration point with the existing slope stability module.

```
For any point (x, y) in the domain:
  1. Find the element containing the point
  2. Interpolate h using the shape functions:
     h = N1·h1 + N2·h2 + N3·h3
  3. Compute pore pressure:
     u = γw · (h - y)

For the slope stability module:
  The slice builder in §5 of the Bishop spec computes u at each
  slice base midpoint. Currently it uses the hydrostatic model:
    u = γw · (y_phreatic - y_base)

  Replace this with:
    u = γw · (h_interpolated - y_base)

  where h_interpolated comes from the FEM solution.

  This requires passing the FEM mesh + nodal heads to the slope
  stability module, and implementing a point-location function
  (find which element contains a given point) plus the shape-
  function interpolation.
```

### 9.4 Exit gradient and piping check

```
Exit gradient is the hydraulic gradient at the downstream exit face
(the point where flow exits the soil).

For each element touching the downstream boundary:
  Compute |i| = sqrt((∂h/∂x)² + (∂h/∂y)²)

The maximum exit gradient is the piping-critical value.

Critical gradient for piping (Terzaghi):
  i_cr = (γ_sat - γw) / γw = (G_s - 1) / (1 + e) ≈ 1.0

Factor of safety against piping:
  F_piping = i_cr / i_exit_max

Eurocode 7 (EN 1997-1, §10.4) requires:
  Design approach 1:
    i_exit,d = i_exit,k × γ_H  (γ_H = 1.35 for unfavourable)
    i_cr,d = i_cr,k / γ_φ       (γ_φ = 1.25)
    Check: i_exit,d ≤ i_cr,d

Display: colour-code the exit face by gradient magnitude.
Red = critical, green = safe, with the F_piping value shown.
```

### 9.5 Total flow rate

```
Total seepage flow rate Q through the section:

Method 1 — integrate flux across a vertical section:
  Choose a vertical line x = x_section between upstream and
  downstream boundaries.
  Q = Σ (qx_e · A_e_projected)
  where the sum is over all elements crossed by the line.

Method 2 — sum flux at boundary nodes:
  Q = Σ f_reaction_i  for all prescribed-head nodes
  where f_reaction_i is the reaction force at Dirichlet nodes.
  After solving Kh = f, the reactions at Dirichlet nodes are:
    f_reaction_i = Σ_j K_ij · h_j - f_i  (row i of original K)

  This is the more accurate method and doesn't require choosing
  a section line.

Method 2 is recommended. Display Q in m³/s per metre run
(or litres/day per metre run for practical display).
```

### 9.6 Arbitrary line probe along the shared measurement tool

The current Stage 6 seepage workspace reuses the shared measurement line as a **post-processing probe**. This is distinct from boundary flux accounting: it samples the solved field along an arbitrary segment `A -> B` drawn by the user.

Supported plotted quantities:

- head `h`
- pore pressure `u`
- hydraulic gradient magnitude `|∇h|`
- specific discharge magnitude `|q|`
- normal discharge `q_n`

Current implementation details:

- The line is sampled at `21-201` evenly spaced points; the default is `81`.
- `h` is sampled by barycentric interpolation of the nodal head field inside the containing triangle.
- `u` is then computed as `gamma_w * (h - y)` at the sampled point.
- `|∇h|`, `|q|`, and `q_n` come from the containing T3 element's constant gradient / Darcy state, so they are piecewise constant between triangle boundaries.
- `q_n` uses the line normal pointing to the **left** of the measurement direction `A -> B`. Reversing the line flips the sign.
- For `q_n`, the UI reports both the **net cross-flow** and the **absolute cross-flow** by integrating `q_n ds` along the sampled line.
- Samples outside the seepage domain are returned as gaps rather than extrapolated values.
- The graph can be copied to the clipboard as distance/value columns for external review.

---

## 10. Data Structures

```
// ── Material extension (§5.1) ──
// Added to the Phase A Material record in stage6-bishop.js.
// Bishop/Spencer ignore these fields.

struct Material {
  // ... existing Phase A fields ...

  kx: float           // horizontal hydraulic conductivity (m/s), NEW
  ky: float           // vertical hydraulic conductivity   (m/s), NEW
  kSource: enum { 'cpt', 'sbtn-default', 'user' }        // provenance, NEW
}

// ── Seepage BC (persistent per edge, survives geometry edits) ──

struct SeepageBC {
  edgeKey: string     // 'terrain:i-j' | 'base' | 'side-left' | 'side-right'
  type: enum { PRESCRIBED_HEAD, NO_FLOW, SEEPAGE_FACE, PRESCRIBED_FLUX }
  value: float        // head (m) if PRESCRIBED_HEAD; flux (m/s) if PRESCRIBED_FLUX
  status: 'active' | 'orphaned'   // orphaned = geometry changed beneath it
}


// ── Mesh ──

struct MeshNode {
  index: int
  x: float
  y: float
  h: float           // computed total head (m) — the unknown
  bc_type: enum { NONE, PRESCRIBED_HEAD, SEEPAGE_FACE }
  bc_value: float    // prescribed head value (if bc_type = PRESCRIBED_HEAD)
}

struct MeshElement {
  index: int
  n1, n2, n3: int    // node indices (counterclockwise)
  regionIndex: int   // which soil region this element belongs to
  kx: float          // effective kx (may differ from region kx during
  ky: float          //   free-surface iteration when element is "dry")
  area: float        // element area (precomputed)

  // shape function coefficients (precomputed)
  b1, b2, b3: float  // ∂N/∂x coefficients × 2A
  c1, c2, c3: float  // ∂N/∂y coefficients × 2A

  // post-processing results
  dhdx: float        // ∂h/∂x (computed after solve)
  dhdy: float        // ∂h/∂y (computed after solve)
  qx: float          // Darcy velocity x-component
  qy: float          // Darcy velocity y-component
  gradient_mag: float // |∇h|
}

struct BoundaryEdge {
  n1, n2: int        // node indices
  bc_type: enum { NO_FLOW, PRESCRIBED_HEAD, PRESCRIBED_FLUX, SEEPAGE_FACE }
  bc_value: float    // head or flux value
}

struct SeepageMesh {
  nodes: MeshNode[]
  elements: MeshElement[]
  boundary_edges: BoundaryEdge[]
  n_nodes: int
  n_elements: int
}


// ── Boundary condition definition (user-facing) ──

struct BoundaryCondition {
  edge_vertices: Point[]     // the geometry edge this BC applies to
  type: enum { PRESCRIBED_HEAD, NO_FLOW, SEEPAGE_FACE, PRESCRIBED_FLUX }
  value: float               // head (m) or flux (m³/s/m²)
}


// ── Seepage model (top-level) ──

struct SeepageModel {
  terrain: Polyline
  regions: SoilRegion[]       // with kx, ky populated
  boundaryConditions: BoundaryCondition[]
  modelBase: float            // y-coordinate of model bottom
  mesh: SeepageMesh           // generated mesh
}


// ── Seepage result ──

struct SeepageResult {
  heads: float[]              // h at each node (length = n_nodes)
  phreatic_surface: Point[]   // extracted phreatic line
  total_flow_rate: float      // Q in m³/s per m run
  max_exit_gradient: float    // maximum |∇h| at exit face
  f_piping: float             // i_cr / max_exit_gradient
  converged: bool             // free-surface iteration converged?
  iterations: int             // number of free-surface iterations
  
  // per-element results (for visualisation)
  element_velocities: {qx, qy}[]
  element_gradients: float[]
}


// ── Sparse matrix storage (CSR format) ──

struct SparseMatrix {
  values: float[]     // non-zero values
  col_indices: int[]  // column index for each value
  row_ptr: int[]      // index into values/col_indices for each row start
  n: int              // matrix dimension

  // methods:
  get(i, j): float
  add(i, j, value): void
  solve(rhs: float[]): float[]    // Cholesky or CG
}
```

---

## 11. Complete Pseudocode

### 11.1 Mesh generation wrapper

```
function generateMesh(
  model: SeepageModel,
  density: enum { COARSE, MEDIUM, FINE }
) → SeepageMesh:

  // ── Build PSLG (Planar Straight Line Graph) ──
  let pslg_points = []
  let pslg_segments = []
  let pslg_regions = []

  // Outer boundary: terrain + model sides + model base
  // Trace clockwise: terrain left→right, right side down,
  // base right→left, left side up
  let xMin = model.terrain.vertices[0].x
  let xMax = model.terrain.vertices[last].x
  let yBase = model.modelBase

  // Terrain vertices (top boundary)
  for each v in model.terrain.vertices:
    pslg_points.push(v)

  // Right side: (xMax, yTerrain_right) → (xMax, yBase)
  pslg_points.push({x: xMax, y: yBase})
  
  // Base: (xMax, yBase) → (xMin, yBase)
  pslg_points.push({x: xMin, y: yBase})

  // Left side closes back to terrain start

  // Connect consecutive points as segments
  for i = 0 to pslg_points.length - 1:
    pslg_segments.push({p1: i, p2: (i + 1) % pslg_points.length})

  // Internal constraints: region boundary edges
  for each region in model.regions:
    for each edge (p1, p2) in region.polygon:
      // Add points (dedup if already present)
      let i1 = addOrFindPoint(pslg_points, p1)
      let i2 = addOrFindPoint(pslg_points, p2)
      pslg_segments.push({p1: i1, p2: i2})

  // Region markers (interior points for Triangle to tag regions)
  for each region in model.regions:
    let interior = computeInteriorPoint(region.polygon)
    pslg_regions.push({
      point: interior,
      regionId: region.index,
      maxArea: areaConstraint(density, region)
    })

  // ── Call triangulator ──
  // maxArea controls mesh density
  let maxArea = match density:
    COARSE: domainArea / 200
    MEDIUM: domainArea / 1000
    FINE:   domainArea / 5000

  let result = triangulate(pslg_points, pslg_segments,
                           pslg_regions,
                           minAngle: 20, maxArea: maxArea)

  // ── Build mesh structure ──
  let mesh = SeepageMesh {
    nodes: result.points.map((p, i) → MeshNode {
      index: i, x: p.x, y: p.y, h: 0,
      bc_type: NONE, bc_value: 0
    }),
    elements: result.triangles.map((t, i) → {
      let n1 = t[0], n2 = t[1], n3 = t[2]
      let x1 = mesh.nodes[n1].x, y1 = mesh.nodes[n1].y
      let x2 = mesh.nodes[n2].x, y2 = mesh.nodes[n2].y
      let x3 = mesh.nodes[n3].x, y3 = mesh.nodes[n3].y

      let area = 0.5 * ((x2-x1)*(y3-y1) - (x3-x1)*(y2-y1))
      if area < 0:
        swap(n2, n3)  // ensure CCW
        area = -area

      // shape function coefficients
      let b1 = y2-y3, b2 = y3-y1, b3 = y1-y2
      let c1 = x3-x2, c2 = x1-x3, c3 = x2-x1

      // region tagging
      let xc = (x1+x2+x3)/3, yc = (y1+y2+y3)/3
      let region = findRegionContaining(model.regions, {x: xc, y: yc})

      MeshElement {
        index: i, n1, n2, n3,
        regionIndex: region.index,
        kx: region.soilType.kx,
        ky: region.soilType.ky,
        area: area,
        b1, b2, b3, c1, c2, c3,
        dhdx: 0, dhdy: 0, qx: 0, qy: 0, gradient_mag: 0
      }
    }),
    boundary_edges: result.boundary_edges
  }

  // ── Assign BCs to mesh nodes ──
  assignBoundaryConditions(mesh, model.boundaryConditions)

  return mesh
```

### 11.2 Element conductivity matrix

```
function elementConductivityMatrix(
  e: MeshElement
) → float[3][3]:

  // K_ij = (1 / (4·A)) · (kx·bi·bj + ky·ci·cj)

  let factor = 1.0 / (4.0 * e.area)
  let b = [e.b1, e.b2, e.b3]
  let c = [e.c1, e.c2, e.c3]

  let Ke = new float[3][3]

  for i = 0 to 2:
    for j = 0 to 2:
      Ke[i][j] = factor * (e.kx * b[i] * b[j] + e.ky * c[i] * c[j])

  return Ke
```

### 11.3 Global assembly and BC application

```
function assembleAndSolve(
  mesh: SeepageMesh
) → float[]:  // returns nodal head vector

  let n = mesh.n_nodes

  // ── Initialise sparse matrix and RHS ──
  let K = SparseMatrix(n)
  let f = new float[n]  // initialised to 0

  // ── Assemble element contributions ──
  for each e in mesh.elements:
    let Ke = elementConductivityMatrix(e)
    let nodes = [e.n1, e.n2, e.n3]

    for i = 0 to 2:
      for j = 0 to 2:
        K.add(nodes[i], nodes[j], Ke[i][j])

  // ── Apply prescribed flux BCs ──
  for each edge in mesh.boundary_edges:
    if edge.bc_type == PRESCRIBED_FLUX:
      let L = dist(mesh.nodes[edge.n1], mesh.nodes[edge.n2])
      let q0 = edge.bc_value
      f[edge.n1] += q0 * L / 2.0
      f[edge.n2] += q0 * L / 2.0

  // ── Apply prescribed head BCs (row elimination) ──
  // Collect all Dirichlet nodes first
  let dirichlet_nodes = []
  for each node in mesh.nodes:
    if node.bc_type == PRESCRIBED_HEAD or node.bc_type == SEEPAGE_FACE:
      let h0 = node.bc_value
      if node.bc_type == SEEPAGE_FACE:
        h0 = node.y   // h = y on seepage face
      dirichlet_nodes.push({index: node.index, value: h0})

  // Modify K and f for each Dirichlet node
  for each dn in dirichlet_nodes:
    let i = dn.index
    let h0 = dn.value

    // Modify RHS for all rows connected to this node
    for each j in K.nonzero_columns(i):
      if j != i:
        f[j] -= K.get(j, i) * h0
        K.set(j, i, 0.0)
        K.set(i, j, 0.0)

    K.set(i, i, 1.0)
    f[i] = h0

  // ── Solve ──
  let h = K.solve(f)    // Cholesky or CG

  return h
```

### 11.4 Sparse solver

```
// ── Conjugate Gradient solver (for SPD systems) ──
// Recommended for browser implementation: simple, no factorisation,
// low memory, and converges fast for well-conditioned seepage problems.

function conjugateGradient(
  K: SparseMatrix,
  f: float[],
  tol: float = 1e-8,
  maxIter: int = 1000
) → float[]:

  let n = K.n
  let h = new float[n]  // initial guess: 0
  let r = f.copy()       // residual r = f - K·h = f (since h=0)
  let p = r.copy()       // search direction
  let rsOld = dot(r, r)

  for iter = 1 to maxIter:
    let Kp = K.multiply(p)       // matrix-vector product
    let alpha = rsOld / dot(p, Kp)

    // Update solution and residual
    for i = 0 to n-1:
      h[i] += alpha * p[i]
      r[i] -= alpha * Kp[i]

    let rsNew = dot(r, r)

    if sqrt(rsNew) < tol:
      return h    // converged

    let beta = rsNew / rsOld
    for i = 0 to n-1:
      p[i] = r[i] + beta * p[i]

    rsOld = rsNew

  warn("CG did not converge in " + maxIter + " iterations")
  return h


// ── Dense Cholesky (fallback for small systems) ──

function choleskyDense(
  K: float[][],   // n×n symmetric positive definite
  f: float[]
) → float[]:

  let n = K.length
  let L = new float[n][n]

  // Factorisation: K = L · Lᵀ
  for j = 0 to n-1:
    let sum = 0
    for k = 0 to j-1:
      sum += L[j][k] * L[j][k]
    L[j][j] = sqrt(K[j][j] - sum)

    for i = j+1 to n-1:
      sum = 0
      for k = 0 to j-1:
        sum += L[i][k] * L[j][k]
      L[i][j] = (K[i][j] - sum) / L[j][j]

  // Forward substitution: L · y = f
  let y = new float[n]
  for i = 0 to n-1:
    let sum = 0
    for j = 0 to i-1:
      sum += L[i][j] * y[j]
    y[i] = (f[i] - sum) / L[i][i]

  // Back substitution: Lᵀ · h = y
  let h = new float[n]
  for i = n-1 downto 0:
    let sum = 0
    for j = i+1 to n-1:
      sum += L[j][i] * h[j]
    h[i] = (y[i] - sum) / L[i][i]

  return h
```

### 11.5 Free-surface iteration loop

```
function solveWithFreeSurface(
  model: SeepageModel,
  mesh: SeepageMesh,
  maxIter: int = 30,
  relaxation: float = 0.5
) → SeepageResult:

  // Store original permeabilities
  for each e in mesh.elements:
    e.kx_original = e.kx
    e.ky_original = e.ky

  let converged = false
  let h = null

  for iter = 1 to maxIter:
    // Solve the system
    h = assembleAndSolve(mesh)

    // Update node heads
    for each node in mesh.nodes:
      node.h = h[node.index]

    // Check each element: is it above or below the phreatic surface?
    let stateChanges = 0

    for each e in mesh.elements:
      let h_centroid = (h[e.n1] + h[e.n2] + h[e.n3]) / 3.0
      let y_centroid = (mesh.nodes[e.n1].y + mesh.nodes[e.n2].y
                        + mesh.nodes[e.n3].y) / 3.0

      let wasWet = (e.kx >= e.kx_original * 0.5)  // threshold for "wet"
      let isWet = (h_centroid >= y_centroid)

      if isWet:
        let kx_target = e.kx_original
        let ky_target = e.ky_original
      else:
        let kx_target = e.kx_original / 1000.0
        let ky_target = e.ky_original / 1000.0

      // Under-relaxed update
      let kx_new = e.kx * (kx_target / e.kx) ^ relaxation
      let ky_new = e.ky * (ky_target / e.ky) ^ relaxation

      if wasWet != isWet:
        stateChanges += 1

      e.kx = kx_new
      e.ky = ky_new

    // Check convergence
    if stateChanges == 0 or stateChanges < mesh.n_elements * 0.001:
      converged = true
      break

  // ── Post-processing ──
  computeGradientsAndVelocities(mesh, h)
  let phreatic = extractPhreaticSurface(mesh, h)
  let Q = computeFlowRate(mesh, h)
  let exitGrad = computeExitGradient(mesh, h)

  return SeepageResult {
    heads: h,
    phreatic_surface: phreatic,
    total_flow_rate: Q,
    max_exit_gradient: exitGrad.max,
    f_piping: 1.0 / exitGrad.max,  // i_cr ≈ 1.0
    converged: converged,
    iterations: iter,
    element_velocities: mesh.elements.map(e → {qx: e.qx, qy: e.qy}),
    element_gradients: mesh.elements.map(e → e.gradient_mag)
  }
```

### 11.6 Post-processing

```
function computeGradientsAndVelocities(
  mesh: SeepageMesh,
  h: float[]
):
  for each e in mesh.elements:
    let h1 = h[e.n1], h2 = h[e.n2], h3 = h[e.n3]
    let twoA = 2.0 * e.area

    e.dhdx = (e.b1 * h1 + e.b2 * h2 + e.b3 * h3) / twoA
    e.dhdy = (e.c1 * h1 + e.c2 * h2 + e.c3 * h3) / twoA

    e.qx = -e.kx * e.dhdx
    e.qy = -e.ky * e.dhdy

    e.gradient_mag = sqrt(e.dhdx * e.dhdx + e.dhdy * e.dhdy)


function extractPhreaticSurface(
  mesh: SeepageMesh,
  h: float[]
) → Point[]:

  // The phreatic surface is the h = y contour (u = 0)
  // For each element edge, check if (h - y) changes sign

  let segments = []

  for each e in mesh.elements:
    let nodes = [e.n1, e.n2, e.n3]
    let vals = []
    for ni in nodes:
      vals.push(h[ni] - mesh.nodes[ni].y)  // positive = saturated

    // Check each edge of the triangle
    for edge in [(0,1), (1,2), (2,0)]:
      let v1 = vals[edge[0]], v2 = vals[edge[1]]
      if v1 * v2 < 0:
        // Sign change → phreatic surface crosses this edge
        let t = v1 / (v1 - v2)  // interpolation parameter
        let n1 = nodes[edge[0]], n2 = nodes[edge[1]]
        let px = mesh.nodes[n1].x + t * (mesh.nodes[n2].x - mesh.nodes[n1].x)
        let py = mesh.nodes[n1].y + t * (mesh.nodes[n2].y - mesh.nodes[n1].y)
        segments.push({x: px, y: py, elementIndex: e.index})

  // Connect segments into a continuous polyline
  // Sort by x, remove duplicates, smooth if needed
  segments.sortBy(s → s.x)
  let surface = removeDuplicates(segments, tolerance: 1e-4)
  return surface


function computeFlowRate(
  mesh: SeepageMesh,
  h: float[]
) → float:

  // Sum reactions at all Dirichlet nodes on the upstream boundary
  // This equals the total inflow = total outflow = Q

  let Q = 0.0

  for each node in mesh.nodes:
    if node.bc_type == PRESCRIBED_HEAD:
      // Compute reaction: sum of K[i,j]·h[j] for original K
      // This requires access to the original (pre-BC-modification) K
      // Alternatively, integrate flux across a control section

      // Simpler approach: integrate qx across a vertical section
      // at x = x_midpoint
      pass

  // Practical approach: sum qx × projected_area across a vertical line
  let xMid = (model.xMin + model.xMax) / 2.0
  for each e in mesh.elements:
    let x1 = mesh.nodes[e.n1].x
    let x2 = mesh.nodes[e.n2].x
    let x3 = mesh.nodes[e.n3].x

    if min(x1,x2,x3) < xMid and max(x1,x2,x3) > xMid:
      // Element crosses the section line
      // Approximate: Q += qx × element_height_at_section
      let yRange = max(y1,y2,y3) - min(y1,y2,y3)
      Q += e.qx * yRange  // crude — refine with proper edge clipping

  return abs(Q)


function computeExitGradient(
  mesh: SeepageMesh,
  h: float[]
) → {max: float, location: Point}:

  let maxGrad = 0.0
  let maxLoc = {x: 0, y: 0}

  // Find elements on the downstream exit face
  for each e in mesh.elements:
    // Check if any edge of this element is on the downstream boundary
    // and has a seepage face or prescribed head BC
    let isExitElement = false
    for each edge in e.edges:
      if edge.bc_type == SEEPAGE_FACE or
         (edge.bc_type == PRESCRIBED_HEAD and edge is on downstream side):
        isExitElement = true

    if isExitElement and e.gradient_mag > maxGrad:
      maxGrad = e.gradient_mag
      maxLoc = elementCentroid(e)

  return {max: maxGrad, location: maxLoc}
```

---

## 12. Integration with Slope Stability

The seepage module produces a pore-pressure field u(x, y). The slope-stability module currently uses a hydrostatic model from `model.phreatic`. Integration is **opt-in** via `bishopState.useFemPorePressure` and never changes the default Bishop/Spencer code path.

```
CURRENT (Bishop v1.1, always on):
  For each slice, at base midpoint (x_mid, y_base):
    if model.phreatic != null:
      u = 9.81 × (phreatic.interpolateY(x_mid) - y_base)
    else:
      u = 0

WITH SEEPAGE OPT-IN (Phase 2, gated):
  if !bishopState.useFemPorePressure || bishopState.seepage?.result == null:
     fall through to the CURRENT branch — bit-identical to Phase A

  else:
     For each slice, at base midpoint (x_mid, y_base):
        let elem = findElementContaining(bishopState.seepage.mesh, x_mid, y_base)
        if elem == null:
           // slice base outside the FEM domain (deep slip beneath model.base)
           u = 9.81 × (phreatic.interpolateY(x_mid) - y_base)   // fallback
           slice.porePressureSource = 'hydrostatic-fallback'
        else:
           u = interpolatePorePressure(bishopState.seepage.result, elem, x_mid, y_base)
           slice.porePressureSource = 'fem'

The switch is parity-tested in §5.6.7 Case A/B/C. When off, Bishop and
Spencer must produce byte-identical outputs to the Phase A baseline.

function interpolatePorepressure(
  result: SeepageResult,
  x: float,
  y: float
) → float:
  // Find element containing (x, y)
  let e = findElementContaining(mesh, x, y)
  if e == null: return 0  // point outside mesh

  // Interpolate head using shape functions
  let x1 = mesh.nodes[e.n1].x, y1 = mesh.nodes[e.n1].y
  let x2 = mesh.nodes[e.n2].x, y2 = mesh.nodes[e.n2].y
  let x3 = mesh.nodes[e.n3].x, y3 = mesh.nodes[e.n3].y
  let h1 = result.heads[e.n1]
  let h2 = result.heads[e.n2]
  let h3 = result.heads[e.n3]

  let twoA = 2.0 * e.area
  let N1 = ((x2*y3 - x3*y2) + (y2-y3)*x + (x3-x2)*y) / twoA
  let N2 = ((x3*y1 - x1*y3) + (y3-y1)*x + (x1-x3)*y) / twoA
  let N3 = ((x1*y2 - x2*y1) + (y1-y2)*x + (x2-x1)*y) / twoA

  let h = N1*h1 + N2*h2 + N3*h3
  let u = 9.81 * (h - y)

  return max(u, 0)  // no suction in v1 — clamp to 0

// Point-in-element test:
function findElementContaining(mesh, x, y) → MeshElement:
  // For each element, check if (x,y) is inside the triangle
  // Use barycentric coordinates: if N1, N2, N3 all >= 0, point is inside
  //
  // For efficiency, build a spatial index (grid or R-tree) over
  // element bounding boxes. For meshes < 5000 elements, a simple
  // grid index is sufficient.

  for each e in mesh.elements:
    let N1, N2, N3 = barycentricCoords(e, x, y)
    if N1 >= -1e-10 and N2 >= -1e-10 and N3 >= -1e-10:
      return e

  return null  // not found
```

---

## 13. Verification & Test Cases

### Test 1: Confined flow under a sheet pile (known analytical solution)

| Parameter | Value |
|-----------|-------|
| Geometry | 10 m wide, 5 m deep, sheet pile at x = 5 m extending 3 m below surface |
| Soil | k = 1e-4 m/s, isotropic |
| BCs | Upstream h = 5 m, downstream h = 2 m, base and sides no-flow |
| Expected | Head drop concentrated around the sheet pile tip. Total head loss = 3 m. Approximately 6 equipotential drops. Exit gradient at downstream toe should be ~0.5–0.8 depending on embedment. |
| Validation | Compare head profile along the base to the analytical Khosla solution or published flow-net results. |

### Test 2: Homogeneous earth dam (classic textbook problem)

| Parameter | Value |
|-----------|-------|
| Geometry | 10 m high dam, upstream slope 3H:1V, downstream slope 2.5H:1V, crest width 3 m |
| Soil | k = 1e-5 m/s, isotropic |
| BCs | Upstream face (submerged): h = 10 m. Downstream toe: h = 0 m (or seepage face). Base: no-flow |
| Expected | Parabolic phreatic surface (Dupuit parabola). Seepage face on downstream slope. Q ≈ k·h²/(2L) for Dupuit approximation. |
| Reference | Compare phreatic surface to Casagrande's graphical construction or SEEP/W output. |

### Test 3: Two-layer system with permeability contrast

| Parameter | Value |
|-----------|-------|
| Geometry | 10 m wide, upper layer 3 m thick (k = 1e-4 m/s), lower layer 7 m thick (k = 1e-7 m/s) |
| BCs | Left: h = 10 m, right: h = 7 m, top and base: no-flow |
| Expected | Most flow in the upper (permeable) layer. Head drop nearly linear in the upper layer, nearly zero in the lower layer. Refraction of flow at the interface (Snell's law analogy: tan(θ1)/tan(θ2) = k1/k2). |

### Test 4: Bishop/Spencer parity with seepage off

| Parameter | Value |
|-----------|-------|
| Geometry | Every Phase A regression fixture (homogeneous, layered, walled, phreatic-crossing, Fredlund-Krahn) |
| Config | `useFemPorePressure = false`, with `Material.kx`, `Material.ky` populated |
| Expected | F_bishop, F_spencer, λ, all slice weights, layer areas, and wall thrusts are bit-identical to the Phase A baseline (≤ 1e-9 absolute) |
| Purpose | Guarantees that Phase 2 plumbing does not perturb the default solver path |

### Test 5: Bishop/Spencer graceful fallback with seepage on but no result

| Parameter | Value |
|-----------|-------|
| Config | `useFemPorePressure = true`, `seepage.result = null` |
| Expected | Bishop/Spencer produce Test 4 output (hydrostatic fallback) and raise a single diagnostic warning per solve; no exceptions |
| Purpose | Covers the case where a saved state has the opt-in flag but the mesh was invalidated by a geometry edit |

### Verification protocol

1. For Test 1, compare computed heads at 10+ points against published solutions. Error should be < 2% of total head drop.
2. For Test 2, compare phreatic surface position to Casagrande's construction. The FEM surface should be within 5% of the dam height at any cross-section.
3. For Test 3, verify that the total flow rate Q agrees with the analytical one-dimensional solution for parallel layers: Q = Σ(ki · hi) × Δh/L.
4. For Test 4, run the entire Phase A fixture set through the Phase 2 build and diff against the committed baseline. Any non-zero delta is a ship-blocker.
5. For Test 5, run one representative fixture with the opt-in flag forced on and `seepage.result = null`. Output must equal Test 4 output and emit the expected diagnostic.
6. Run a mesh convergence study: refine the mesh from 200 to 5000 elements and verify that the solution changes by less than 1% beyond 1000 elements.
7. Check global mass balance: total inflow at upstream boundary should equal total outflow at downstream boundary, to within 0.1%.

---

## 14. References

1. Cedergren, H.R. (1989). *Seepage, Drainage, and Flow Nets*. 3rd Edition, Wiley.
2. Harr, M.E. (1962). *Groundwater and Seepage*. McGraw-Hill.
3. GeoStudio / Seequent (2024). SEEP/W Engineering Methodology. Online documentation.
4. Zienkiewicz, O.C. & Taylor, R.L. (2000). *The Finite Element Method — Volume 1: The Basis*. 5th Edition, Butterworth-Heinemann.
5. Potts, D.M. & Zdravković, L. (1999). *Finite Element Analysis in Geotechnical Engineering: Theory*. Thomas Telford.
6. EN 1997-1:2004. *Eurocode 7: Geotechnical design — Part 1: General rules*. Section 10.4: Hydraulic heave and piping.
7. Shewchuk, J.R. (1996). "Triangle: Engineering a 2D Quality Mesh Generator and Delaunay Triangulator." *First Workshop on Applied Computational Geometry*.
8. Freeze, R.A. & Cherry, J.A. (1979). *Groundwater*. Prentice-Hall.
9. Verruijt, A. (2001). *Soil Mechanics*. Delft University of Technology. Chapter on groundwater flow.
10. USACE (1993). *EM 1110-2-1901: Seepage Analysis and Control for Dams*. U.S. Army Corps of Engineers.
