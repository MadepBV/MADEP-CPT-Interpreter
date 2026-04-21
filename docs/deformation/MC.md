# Mohr-Coulomb Mesh Deformation Screening - Technical Specification

**Module**: 2D deformation / settlement screening on the shared Bishop-Seepage geometry  
**Method**: Linear elastic plane-strain FEM on the existing triangular mesh, with Mohr-Coulomb effective-stress post-processing  
**Status**: Draft v0.1  
**Positioning**: This is the "easy MC route". It is intentionally **not** a full elastoplastic Mohr-Coulomb solver.

---

## Contents

1. [Scope and Positioning](#1-scope-and-positioning)
2. [What This Module Does](#2-what-this-module-does)
3. [What It Explicitly Does Not Do](#3-what-it-explicitly-does-not-do)
4. [Why This Is the Right v1](#4-why-this-is-the-right-v1)
5. [Applicability and Modelling Assumptions](#5-applicability-and-modelling-assumptions)
6. [Input Model](#6-input-model)
7. [Theory](#7-theory)
   - 7.1 [Plane-strain kinematics](#71-plane-strain-kinematics)
   - 7.2 [Linear elastic constitutive law](#72-linear-elastic-constitutive-law)
   - 7.3 [T3 triangle element](#73-t3-triangle-element)
   - 7.4 [Boundary traction from slab / load patch](#74-boundary-traction-from-slab--load-patch)
   - 7.5 [Initial stress state](#75-initial-stress-state)
   - 7.6 [Effective stress and pore pressure](#76-effective-stress-and-pore-pressure)
   - 7.7 [Mohr-Coulomb yield indicator](#77-mohr-coulomb-yield-indicator)
8. [Application Design](#8-application-design)
9. [Data Structures](#9-data-structures)
10. [Implementation Path](#10-implementation-path)
11. [Complete Pseudocode](#11-complete-pseudocode)
12. [Verification and Test Cases](#12-verification-and-test-cases)
13. [Limitations and Future Extensions](#13-limitations-and-future-extensions)

---

## 1. Scope and Positioning

This module reuses the existing 2D cross-section geometry and constrained triangular mesh to compute:

- Nodal displacements `ux, uy`
- Settlement under a slab / loaded patch
- Incremental stress and strain in each triangle
- Mohr-Coulomb utilization / proximity-to-yield contours
- A deformed mesh visualisation

The key choice is:

**v1 is an elastic FEM solver with Mohr-Coulomb stress screening.**

That means:

- The displacement solve is linear elastic.
- The existing Stage 4 Mohr-Coulomb inputs (`E`, `nu`, `c`, `phi`, `psi`, `K0`) are reused.
- Mohr-Coulomb is used to evaluate the solved stress field, not to produce plastic strains.

This keeps the implementation realistic and fast while still giving engineers a very useful "where is the stress going, what is settling, and where are we close to MC yield?" tool.

---

## 2. What This Module Does

Given:

- The shared Bishop / seepage geometry
- Soil polygons with imported materials
- A load patch or slab footprint on the terrain
- Optional seepage pore pressures from the seepage solver

It computes:

- Incremental displacements caused by the applied load
- Vertical settlement profile along the terrain or slab base
- Element strains `eps_xx, eps_yy, gamma_xy`
- Element stress increments `delta_sigma_xx, delta_sigma_yy, delta_tau_xy`
- Total effective stress state after combining:
  - in-situ geostatic stress
  - optional seepage pore pressure
  - mechanical stress increment from the FEM solve
- Principal effective stresses `sigma_1'`, `sigma_3'`
- Mohr-Coulomb utilization ratio `eta_MC`
- Deformed mesh overlay and contour plots

---

## 3. What It Explicitly Does Not Do

This v1 does **not** do:

- full elastoplastic Mohr-Coulomb
- return mapping / plastic correction
- load stepping with yield surface updates
- dilation-driven plastic strains
- Cam Clay or critical-state soil behaviour
- coupled flow-deformation
- dynamic analysis
- true 3D slab behaviour

So this is **not** PLAXIS-like nonlinear FE. It is a high-value screening tool that fits the current app architecture.

---

## 4. Why This Is the Right v1

The current app already has most of the needed ingredients:

- Shared geometry and materials from `buildBishopModelFromStageLayers(...)` in [stage6-bishop.js](/Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/stage6-bishop.js:2583)
- Existing MC-oriented material derivation (`Emc`, `nu`, `K0nc`, `phi`, `psi`) in [legacy-controller.js](/Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/legacy-controller.js:2845)
- Existing settlement stress logic based on Boussinesq in [stage6-engineering.js](/Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/stage6-engineering.js:482)
- Existing triangular mesh tooling in:
  - [pslg.js](/Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/seepage/pslg.js:400)
  - [mesh-triangle.js](/Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/seepage/mesh-triangle.js:186)
- Existing worker pattern in [seepage-worker.js](/Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/seepage/seepage-worker.js:1)

So the easiest useful path is:

1. Reuse the mesh.
2. Reuse the MC material parameters.
3. Solve elastic displacements.
4. Add MC stress diagnostics afterward.

This is much easier than Cam Clay and much easier than full elastoplastic MC.

---

## 5. Applicability and Modelling Assumptions

### 5.1 Plane strain

The analysis is 2D plane strain. It is appropriate for:

- long strip foundations
- long walls
- the middle cross-section of a long slab / raft

It is less representative for:

- short slabs
- isolated pads
- compact foundations with small out-of-plane length

Rule of thumb:

- If `L_out / B >= 4`, plane strain is often acceptable for screening.
- If `L_out / B < 4`, the result is still usable as a quick screen, but the existing settlement tool may be closer to the intended 3D footing behaviour.

### 5.2 Small strain

Displacements are assumed small enough that geometry does not need to be updated during the solve.

### 5.3 Elastic mechanical response in v1

The FEM solve uses linear elasticity with:

- `E = Emc`
- `nu = nu`

The parameter `psi` is stored but not used in the v1 solver, because dilation matters only once plasticity is introduced.

### 5.4 Incremental load analysis

The simplest and safest v1 is **incremental**:

- solve only the displacement increment due to the applied slab / surface load
- do not solve self-weight settlement again
- reconstruct total effective stress afterward by adding the incremental stress field to the in-situ stress field

This keeps the solver stable and aligns with the current settlement workflow.

### 5.5 Effective-stress screening

The deformation solve is best interpreted as a drained effective-stress screening model. If seepage results are available, their pore pressures should be used in the initial stress reconstruction.

---

## 6. Input Model

### 6.1 Geometry

Use the existing Stage 6 Bishop geometry model:

- terrain
- analysis bottom
- regions
- optional custom polygons
- optional seepage result

### 6.2 Materials

For each region, define:

```ts
type MechanicalMaterial = {
  id: string
  label: string
  gamma: number
  gammaSat: number
  Emc: number
  nu: number
  cEff: number
  phiEffDeg: number
  psiDeg: number
  K0nc: number
}
```

These values already exist conceptually in the Stage 4 / Stage 6 pipeline.

### 6.3 Load model

For v1, do **not** block the module on a full slab-structure model. Use a staged load definition:

```ts
type DeformationLoad = {
  kind: 'slab-strip'
  xStart: number
  xEnd: number
  inputMode: 'pressure' | 'lineLoad' | 'totalLoad'
  q?: number
  lineLoad?: number
  totalLoad?: number
  outOfPlaneLength?: number
}
```

Recommended UI path:

- Reuse the existing Bishop `surfaceLoad` zone as the computational load interval.
- Add one more deformation input block:
  - load input mode
  - out-of-plane length
  - optional "draw slab" visual object later

For a loaded width `B = xEnd - xStart`:

```text
If pressure is entered:
  q = q_user

If line load is entered [kN/m along the section]:
  q = lineLoad / B

If total load is entered [kN]:
  q = totalLoad / (B * L_out)
```

Once `q` is known, the 2D FE solve is identical. The out-of-plane length matters only for converting total load to pressure.

### 6.4 Boundary conditions

Default v1 mechanical supports:

- `uy = 0` along the bottom boundary
- `ux = 0` on the left and right vertical boundaries

This is a standard screening set for a truncated half-space. The domain must be wide enough that side restraints do not dominate the loaded zone.

---

## 7. Theory

### 7.1 Plane-strain kinematics

Let the nodal displacement field be:

```text
u(x, y) = [ux(x, y), uy(x, y)]^T
```

Under plane strain:

```text
eps = [eps_xx, eps_yy, gamma_xy]^T

eps_xx = d(ux)/dx
eps_yy = d(uy)/dy
gamma_xy = d(ux)/dy + d(uy)/dx
```

In matrix form for an element:

```text
eps = B * u_e
```

where `u_e = [ux1, uy1, ux2, uy2, ux3, uy3]^T`.

### 7.2 Linear elastic constitutive law

Use standard FE sign convention internally:

- tension positive
- compression negative

For isotropic plane strain:

```text
sigma = D * eps

D = E / ((1 + nu) * (1 - 2*nu)) *
    [ 1 - nu   nu         0                ]
    [ nu       1 - nu     0                ]
    [ 0        0          (1 - 2*nu) / 2   ]
```

where:

- `E = Emc`
- `nu = nu`

### 7.3 T3 triangle element

For a 3-node triangle with nodes:

```text
(x1, y1), (x2, y2), (x3, y3)
```

Define:

```text
A = 0.5 * det([1 x1 y1; 1 x2 y2; 1 x3 y3])

b1 = y2 - y3    c1 = x3 - x2
b2 = y3 - y1    c2 = x1 - x3
b3 = y1 - y2    c3 = x2 - x1
```

Then:

```text
B = 1 / (2*A) *
    [ b1  0   b2  0   b3  0  ]
    [ 0   c1  0   c2  0   c3 ]
    [ c1  b1  c2  b2  c3  b3 ]
```

With unit out-of-plane thickness `t = 1 m`, the element stiffness is:

```text
k_e = t * A * B^T * D * B
```

This is exact for the constant-strain triangle.

### 7.4 Boundary traction from slab / load patch

For a uniform vertical traction over a loaded boundary edge:

```text
t_bar = [tx, ty]^T
```

For a two-node edge of length `L_e`, the consistent nodal load vector is:

```text
f_edge = t * L_e / 2 * [tx, ty, tx, ty]^T
```

For the slab load patch:

```text
tx = 0
ty = -q
```

with `q` in `kN/m^2`.

The total external load vector is the sum over all top-boundary edge fragments that lie inside `[xStart, xEnd]`.

### 7.5 Initial stress state

The FEM solve is incremental, but MC screening needs total effective stress.

Use:

```text
sigma_v0'(y) = sigma_v0(y) - u0(y)
sigma_h0'(y) = K0 * sigma_v0'(y)
tau_xy0' = 0
```

where:

- `sigma_v0` = in-situ vertical total stress from overburden
- `u0` = initial pore pressure
- `K0 = K0nc`

The initial effective stress tensor in geotechnical compression-positive convention is:

```text
sigma0' =
  [ sigma_h0'    0        ]
  [ 0            sigma_v0']
```

### 7.6 Effective stress and pore pressure

The elastic FE solve returns an incremental stress field `delta_sigma` in **tension-positive** sign convention.

Convert it to geotechnical compression-positive convention:

```text
delta_sigma_c = -delta_sigma
```

Interpret the elastic increment as an effective stress increment:

```text
delta_sigma' = delta_sigma_c
```

Then the total effective stress used for MC screening is:

```text
sigma' = sigma0' + delta_sigma'
```

If a seepage result exists, use the seepage pore pressure field to build `u0`.
If not, derive `u0` hydrostatically from the phreatic line.

### 7.7 Mohr-Coulomb yield indicator

For each element, compute principal effective stresses in compression-positive convention:

```text
p = (sigma_xx' + sigma_yy') / 2
r = sqrt(((sigma_xx' - sigma_yy') / 2)^2 + tau_xy'^2)

sigma_1' = p + r
sigma_3' = p - r
```

with `sigma_1' >= sigma_3'`.

The Mohr-Coulomb criterion in principal stress form is:

```text
F_MC =
  (sigma_1' - sigma_3')
  - (sigma_1' + sigma_3') * sin(phi')
  - 2 * c' * cos(phi')
```

Interpretation:

- `F_MC < 0`: inside the MC envelope
- `F_MC = 0`: on the envelope
- `F_MC > 0`: beyond the envelope

For plotting, define a utilization ratio:

```text
eta_MC =
  (sigma_1' - sigma_3') /
  max((sigma_1' + sigma_3') * sin(phi') + 2*c'*cos(phi'), eps)
```

Interpretation:

- `eta_MC < 1`: below yield
- `eta_MC ~= 1`: near yield
- `eta_MC > 1`: would exceed MC strength if plasticity were allowed

This is the key v1 post-processing quantity.

---

## 8. Application Design

### 8.1 User workflow

1. User builds / imports the Bishop geometry.
2. User assigns or edits soil polygons and materials.
3. User defines a load interval:
   - initially by reusing the existing `surfaceLoad` zone
   - later optionally by drawing a slab footprint
4. User enters load intensity or total load and out-of-plane length.
5. User runs "Deformation (MC screening)".
6. App shows:
   - deformed mesh
   - settlement contour / settlement profile
   - horizontal displacement contour
   - `delta_sigma_yy` contour
   - MC utilization contour

### 8.2 Slab drawing logic

Do not make slab drawing the blocker for v1.

Recommended staged approach:

- `v1a`: computationally use only the load interval and `q`
- `v1b`: allow drawing a slab polygon, but treat its base projection as the load interval
- `v2`: optionally add rigid slab compatibility or a beam / plate coupling layer

### 8.3 Reuse of the existing mesh

The seepage mesher is already the right foundation:

- same terrain and bottom boundary
- same polygon regions
- same Triangle-based meshing route

The deformation solver should share the same domain meshing logic, but it does not need seepage-only internal boundary semantics.

Recommended refactor:

- extract the reusable Triangle domain builder from the seepage module into a shared mesh helper
- keep seepage on top of that helper
- let deformation call the same helper

### 8.4 Worker execution

Use the same pattern as the seepage worker:

- start run with `runId`
- stream progress messages
- support cooperative stop
- return mesh + fields + summaries

---

## 9. Data Structures

```ts
type DeformationInput = {
  model: BishopModel
  load: DeformationLoad
  options: {
    meshTargetArea: number
    useCustomRegions: boolean
    useSeepagePorePressures: boolean
    displacementScale: number
  }
}

type DeformationElementResult = {
  elementIndex: number
  regionIndex: number
  area: number
  centroid: { x: number, y: number }
  strain: { exx: number, eyy: number, gxy: number }
  stressIncrement: { sxx: number, syy: number, txy: number } // tension-positive FE sign
  effectiveStress: { sxx: number, syy: number, txy: number } // compression-positive geotech sign
  principal: { s1: number, s3: number }
  mc: { F: number, eta: number }
}

type DeformationOutput = {
  mesh: {
    nodes: Array<{ x: number, y: number }>
    elements: number[][]
  }
  nodalDisplacements: Array<{ ux: number, uy: number }>
  elementResults: DeformationElementResult[]
  summaries: {
    maxSettlement: number
    maxHorizontalDisplacement: number
    maxMcEta: number
  }
}
```

For smoothed nodal plots, use area-weighted averaging:

```text
sigma_node = sum(A_e * sigma_e) / sum(A_e)
```

This is where averaging is appropriate. It is for visualisation only, not for enforcing compatibility.

---

## 10. Implementation Path

### Phase 1 - Data and UI plumbing

Touch:

- [legacy-controller.js](/Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/legacy-controller.js)
- [stage6-bishop.js](/Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/stage6-bishop.js)

Add:

- `bishop.deformation` state block
- load input mode
- out-of-plane length
- run / stop / clear actions
- result display toggles

### Phase 2 - Shared mesh extraction

Extract from the seepage stack:

- shared polygon-to-PSLG
- shared Triangle call
- shared region tagging

Recommended files:

- `src/lib/cpt-app/mesh/shared-triangle.js`
- `src/lib/cpt-app/deformation/mesh.js`

### Phase 3 - Mechanical solver core

Add:

- `src/lib/cpt-app/deformation/solver.js`
- `src/lib/cpt-app/deformation/element-t3.js`
- `src/lib/cpt-app/deformation/material.js`
- `src/lib/cpt-app/deformation/post.js`

Implement:

- stiffness assembly
- traction load assembly
- Dirichlet supports
- linear solve
- stress recovery
- MC post-processing

### Phase 4 - Worker integration

Add:

- `src/lib/cpt-app/deformation/deformation-worker.js`

Mirror the seepage worker contract:

- `run-deformation`
- `stop-deformation`
- `progress`
- `result`
- `error`

### Phase 5 - Visualisation

Show:

- undeformed / deformed mesh
- settlement contours
- horizontal displacement contours
- `delta_sigma_yy` contours
- MC utilization contours

### Phase 6 - Optional seepage coupling

If a seepage result exists:

- sample pore pressure at element centroids
- use it in `sigma0'`
- optionally plot deformation and seepage together

No feedback from deformation to seepage is needed in v1.

---

## 11. Complete Pseudocode

### 11.1 Main run flow

```ts
function runMcDeformationScreening(input):
  model = input.model
  load = normalizeLoad(input.load)

  mesh = buildMechanicalMesh(model, input.options)
  materials = mapMeshElementsToMaterials(mesh, model.regions)

  constraints = buildMechanicalSupports(mesh, model)
  tractionEdges = findLoadedTopEdges(mesh, load.xStart, load.xEnd)

  K = zeroMatrix(2 * mesh.nodeCount, 2 * mesh.nodeCount)
  F = zeroVector(2 * mesh.nodeCount)

  for each element in mesh.elements:
    ke = elementStiffnessT3(element, materials[element.regionIndex])
    assemble(K, ke, element.dofMap)

  for each edge in tractionEdges:
    fe = edgeTractionVector(edge, load.q)
    assemble(F, fe, edge.dofMap)

  applyDirichlet(K, F, constraints)

  U = solveLinearSystem(K, F)

  initialField = buildInitialEffectiveStressField(mesh, model, input.options)
  elementResults = recoverElementResults(mesh, U, materials, initialField)

  nodalDisplacements = unpackNodalDisplacements(U)
  summaries = summarizeDeformation(nodalDisplacements, elementResults)

  return { mesh, nodalDisplacements, elementResults, summaries }
```

### 11.2 Element stiffness

```ts
function elementStiffnessT3(element, material):
  A = triangleArea(element.nodes)
  B = buildBMatrixT3(element.nodes, A)
  D = planeStrainElasticMatrix(material.Emc, material.nu)
  return A * transpose(B) * D * B
```

### 11.3 Edge traction assembly

```ts
function edgeTractionVector(edge, q):
  L = distance(edge.nodeA, edge.nodeB)
  tx = 0
  ty = -q
  return (L / 2) * [tx, ty, tx, ty]
```

### 11.4 Initial effective stress field

```ts
function buildInitialEffectiveStressField(mesh, model, options):
  out = []
  for each element in mesh.elements:
    c = element.centroid
    material = model.regions[element.regionIndex].material

    sigmaV0 = verticalOverburdenStressAt(model, c.y)
    u0 = options.useSeepagePorePressures
      ? sampleSeepagePorePressure(model.seepage, c.x, c.y)
      : hydrostaticPorePressureFromPhreatic(model.phreatic, c.x, c.y)

    sigmaV0Eff = max(sigmaV0 - u0, 0)
    sigmaH0Eff = material.K0nc * sigmaV0Eff

    out.push({
      sxx: sigmaH0Eff,
      syy: sigmaV0Eff,
      txy: 0
    })
  return out
```

### 11.5 Stress recovery and MC screening

```ts
function recoverElementResults(mesh, U, materials, initialField):
  out = []

  for each element in mesh.elements:
    ue = gatherElementDofs(U, element.dofMap)
    A = triangleArea(element.nodes)
    B = buildBMatrixT3(element.nodes, A)
    D = planeStrainElasticMatrix(materials[element.regionIndex].Emc,
                                 materials[element.regionIndex].nu)

    strain = B * ue
    sigmaIncrementFE = D * strain              // tension-positive
    sigmaIncrementGeo = negateNormalAndShear(sigmaIncrementFE) // compression-positive

    sigma0 = initialField[element.index]
    sigmaEff = addStress(sigma0, sigmaIncrementGeo)

    principal = principalStress2DCompressionPositive(sigmaEff)
    mc = mohrCoulombIndicator(principal, materials[element.regionIndex])

    out.push({
      elementIndex: element.index,
      regionIndex: element.regionIndex,
      area: A,
      centroid: element.centroid,
      strain,
      stressIncrement: sigmaIncrementFE,
      effectiveStress: sigmaEff,
      principal,
      mc
    })

  return out
```

### 11.6 Mohr-Coulomb indicator

```ts
function mohrCoulombIndicator(principal, material):
  phi = degToRad(material.phiEffDeg)
  c = material.cEff
  s1 = principal.s1
  s3 = principal.s3

  denom = max((s1 + s3) * sin(phi) + 2 * c * cos(phi), 1e-6)
  F = (s1 - s3) - (s1 + s3) * sin(phi) - 2 * c * cos(phi)
  eta = (s1 - s3) / denom

  return { F, eta }
```

### 11.7 Terrain settlement profile

```ts
function sampleSettlementProfile(mesh, nodalDisplacements, terrainPolyline, xs):
  curve = []
  for each x in xs:
    y = terrainY(terrainPolyline, x)
    uy = interpolateUyAt(mesh, nodalDisplacements, x, y)
    curve.push({ x, settlement: -uy })
  return curve
```

---

## 12. Verification and Test Cases

### 12.1 Patch test

Apply a displacement field that corresponds to constant strain and verify the T3 element reproduces constant stress exactly.

### 12.2 Loaded strip sanity check

Use a homogeneous elastic half-space approximation:

- loaded width `B`
- uniform pressure `q`
- compare the vertical stress increment under the centreline against the existing Boussinesq routine in [stage6-engineering.js](/Users/mathiasdepelsmaeker/Projects/madep-cp/src/lib/cpt-app/stage6-engineering.js:482)

The FE result will not match exactly at all depths in a truncated domain, but it should show the same shape and order of magnitude.

### 12.3 Settlement comparison

For a homogeneous profile:

- compare centreline settlement from the existing settlement tool
- compare average FE settlement beneath the loaded width

The tools are not identical, but they should trend consistently.

### 12.4 Symmetry test

For a symmetric domain and symmetric load:

- horizontal displacement on the symmetry line should be near zero
- settlement profile should be symmetric

### 12.5 MC utilization sanity check

For a low load:

- `eta_MC` must remain comfortably below 1

For a high load:

- `eta_MC` should rise first beneath load edges and in weaker layers

### 12.6 Seepage coupling test

Run the same mechanical load:

- once without seepage
- once with a high pore pressure field

The high-pore-pressure case should show lower effective-stress reserve and higher `eta_MC`.

---

## 13. Limitations and Future Extensions

### 13.1 Important v1 limitations

- No plastic strains: if `eta_MC > 1`, the app reports overstress, but does not redistribute stress.
- `psi` is carried but unused.
- Settlement is elastic screening settlement, not consolidation settlement.
- Short slabs remain a 3D problem; plane strain is only a screening approximation.
- Boundary effects matter if the domain is too narrow or too shallow.

### 13.2 Natural v2 extensions

- staged loading
- excavation / unloading steps
- self-weight mechanical solve
- rigid slab compatibility
- beam / plate coupling
- elastoplastic Mohr-Coulomb
- deformation-dependent seepage coupling

### 13.3 Natural v3 extensions

- Hardening Soil
- Modified Cam Clay
- transient consolidation
- true coupled hydro-mechanical analysis

---

## Practical Conclusion

This specification deliberately avoids the trap of "stretching triangles manually". The triangles stay connected because the **nodal displacements are solved globally**. Averaging is used only for smoothing element results onto nodes for plotting.

So the implementation strategy is:

1. reuse the existing triangular mesh,
2. solve a small-strain elastic plane-strain FEM problem,
3. reconstruct total effective stresses,
4. evaluate Mohr-Coulomb utilization afterward.

That is the fastest path to a useful deformation module that still feels mechanically coherent.
