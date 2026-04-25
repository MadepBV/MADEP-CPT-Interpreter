# T6 (LST) Element Implementation Guide

**Document status:** forward implementation specification
**Goal:** add the option to mesh and solve the deformation problem with **T6** (six-node quadratic) triangles in addition to the current **T3** (three-node constant-strain) triangles. The element type becomes a user-selectable mesh setting; the solver, postprocessing, and verification all dispatch on it.

This guide is end-to-end and meant to be followed without further architectural decisions. It cites the actual call sites that change, gives the closed-form math, and lists every file that needs touching.

---

## 1. Why T6 and what changes mathematically

### 1.1 The element

T6 has six nodes: three at the corners and three at the edge midpoints. With area (barycentric) coordinates **L₁, L₂, L₃** (L₁ + L₂ + L₃ = 1), the standard quadratic shape functions are:

```
Corners:      N₁ = L₁(2L₁ − 1)
              N₂ = L₂(2L₂ − 1)
              N₃ = L₃(2L₃ − 1)
Midpoints:    N₄ = 4 L₂ L₃         (opposite node 1)
              N₅ = 4 L₃ L₁         (opposite node 2)
              N₆ = 4 L₁ L₂         (opposite node 3)
```

Node ordering matches Triangle's `o2` output exactly: corners first, then midpoints, with midpoint *i* opposite corner *i*. Keep this ordering invariant — every kernel below depends on it.

This is **not** the same as the common edge-walking order `[v1, v2, v3, m12, m23, m31]`. Triangle's observed `o2` order for a counter-clockwise triangle `[v1, v2, v3]` is:

```
[v1, v2, v3, m23, m31, m12]
```

That is why the midpoint shape functions above are written as `N4 = 4 L2 L3`, `N5 = 4 L3 L1`, and `N6 = 4 L1 L2`. If we later choose an app-owned T3-to-T6 upgrade instead of native Triangle `o2`, the upgrade code must either emit this exact ordering or the formulas must be changed together.

### 1.2 Strain field

The displacement field is **quadratic** in (x, y), so the strain field is **linear** in (x, y). T6 is therefore the **Linear Strain Triangle (LST)**. This is the principal benefit of the upgrade: bending and stress-gradient regions resolve at far coarser meshes than the constant-strain T3.

### 1.3 Consequences for the solver

| T3 | T6 |
|---|---|
| 3 nodes × 2 DOF = **6 DOF/element** | 6 nodes × 2 DOF = **12 DOF/element** |
| **B is constant** over the element (computed once) | **B(ξ, η) varies linearly** — must be evaluated at each Gauss point |
| Element stiffness K_e = A · B^T D B (one term) | K_e = Σ_g w_g · B(ξ_g)^T D B(ξ_g) det(J(ξ_g)) (Gauss sum) |
| **One material point per element** | **One material point per Gauss point** (3 or 7 per element) |
| Sparsity pattern: 36 entries per element block | Sparsity pattern: 144 entries per element block |
| Sparser global K (≈ 14–20 nnz/row in plane strain) | Denser global K (≈ 30–60 nnz/row) |

### 1.4 Numerical integration

For straight-edge T6, the Jacobian is **constant** over the element and equals **2A** (twice the corner-triangle area). For straight edges, B is linear, so B^T D B is quadratic in (ξ, η). The 3-point symmetric Gauss rule integrates degree-2 polynomials over a triangle exactly:

```
Gauss point     L₁          L₂          L₃          weight (on reference area 1/2)
1               2/3         1/6         1/6         1/6
2               1/6         2/3         1/6         1/6
3               1/6         1/6         2/3         1/6
                                                    ─────
                                                    1/2  (sum × 2A = A; absorbed below)
```

**Adopt 3-point Gauss as the production rule.** For straight-edged T6 with linear strain × constant material the integrand is exactly degree-2, so 3-point integration is *exact* for the elastic part. Triggers to revisit and adopt a 7-point Strang–Fix rule:

- Curved-edge isoparametric T6 (variable Jacobian — Phase 2).
- Stress concentrations near footing edges or excavation corners where the per-Gauss tangent transitions sharply between active sets within a single element.
- Future Hardening Soil work: stress-dependent stiffness gives a higher-order integrand even on straight edges, and the deviatoric-cone tangent can be near-singular at peak strength. Track convergence on a benchmarked excavation-corner case before deciding.

### 1.5 What stays unchanged

- The constitutive model: Linear elastic, Stage 1 reduced-stiffness, exact Stage 2 MC return mapping. All run **per material point** and are element-type agnostic.
- The global Newton residual solve, Armijo line search, adaptive continuation, and Krylov solvers in [solver.js](../../src/lib/cpt-app/deformation/solver.js).
- Voigt-6 conventions and the plane-strain reduction of the constitutive tangent.
- Safety (c-φ reduction) phase.

---

## 2. Implementation strategy

**Adopt parallel-module strategy, not in-place generalization.** Rationale: T3 is the production path on which all current verification cases pass; reckless generalization risks regressions. Add T6 alongside T3, dispatch on element type at the assembly layer, and keep both kernels first-class.

```
src/lib/cpt-app/deformation/
├── element-t3.js              (unchanged — production T3 kernel)
├── element-t6.js              (NEW — T6 kernel, mirrors element-t3.js API)
├── element-kernel.js          (NEW — small dispatcher / factory)
├── mesh.js                    (small change — emit element type)
├── material-models.js         (no constitutive math change; optional gpIndex metadata only)
├── solver.js                  (medium change — assembly loops over Gauss points)
└── gpu/                       (Phase 2 — T6 kernels optional)
```

Element type lives in the mesh: every element record carries its corner+midpoint connectivity and a `kind: 't3' | 't6'` tag. The solver picks the kernel from the tag.

---

## 3. Mesh layer changes

### 3.1 Triangle runtime status

The current local wrapper already supports `quadratic: true` in `buildSwitchesString()` and already reads the output stride with `output.numberofcorners`:

```js
get trianglelist() {
  return heapToArray(this.Module, this.arr[5], this.numberoftriangles * this.numberofcorners, Int32Array);
}
```

A local smoke test with one PSLG triangle and `{ quadratic: true, edges: true }` returns:

```js
{
  numberofcorners: 6,
  trianglelist: [0, 1, 2, 4, 5, 3]
}
```

So for the current deformation mesh path, **do not make a runtime change just to read native `o2` output**.

The only runtime weakness is the `trianglelist` setter, which divides input triangle connectivity by 3. That setter matters only if we later refine or pass an existing six-node `trianglelist` back into Triangle. The current deformation workflow builds from a PSLG, so it does not use this setter for elements. If we add a refine-from-existing-mesh path later, then fix it like this:

```js
// BEFORE
set trianglelist(value) {
  this.arr[5] = arrayToHeap(this.Module, value, Int32Array);
  this.arr[9] = value ? ~~(value.length / 3) : 0;
}

// AFTER, only when we support passing input T6 triangle lists
set trianglelist(value) {
  this.arr[5] = arrayToHeap(this.Module, value, Int32Array);
  const corners = this.arr[10] > 0 ? this.arr[10] : 3;
  this.arr[9] = value ? ~~(value.length / corners) : 0;
}
```

Do not set `input.numberofcorners = 6` for the current PSLG generation path. Triangle sets `output.numberofcorners` from the `o2` switch.

### 3.2 Wiring through `triangulatePslg`

[triangle-runtime.js](../../src/lib/cpt-app/seepage/triangle-runtime.js) accepts `quadratic: true` when the switches are passed as an object. The deformation mesh path currently builds a switch **string** through `triangleSwitchesForAttempt()` in [deformation/mesh.js](../../src/lib/cpt-app/deformation/mesh.js), so wire T6 there:

```js
function triangleSwitchesForAttempt(attempt, hasRegionAreaConstraints, elementType = 't3') {
  let out = 'pzQ';
  if (elementType === 't6') out += 'o2';
  // existing D/j/e/S/q/a flags stay unchanged
  return out;
}
```

Then call:

```js
triangleSwitchesForAttempt(
  { ...attempt, edges: true, jettison: true },
  hasRegionAreaConstraints,
  elementType
)
```

No extra output slicing is needed in `triangulatePslg()` itself; `output.trianglelist` already uses `output.numberofcorners`. The stride handling belongs in `buildSectionMesh()`.

### 3.3 Mesh builder (`mesh.js` and `section-mesh.js`)

Add a single option `meshElementType: 't3' | 't6'` (default `'t3'`). The plumbing point is [mesh.js:284](../../src/lib/cpt-app/deformation/mesh.js#L284) where `triangulatePslg(...)` is called.

```js
const elementType = options?.meshElementType === 't6' ? 't6' : 't3';
const triangleOutput = await triangulatePslg(
  {
    pointlist: pslg.pointlist,
    segmentlist: pslg.segmentlist,
    segmentmarkerlist: pslg.segmentmarkerlist,
    regionlist: hasRegionAreaConstraints ? pslg.regionlist : undefined
  },
  triangleSwitchesForAttempt({ ...attempt, edges: true, jettison: true }, hasRegionAreaConstraints, elementType)
);
```

Then transform the output in [section-mesh.js](../../src/lib/cpt-app/mesh/section-mesh.js), not just in `deformation/mesh.js`. The mesh object the solver consumes already has shape `{ nodes, elements, cells, elementCell, elementData, constraintEdges, ... }`. Extend it as follows:

- **`mesh.elementType`** — `'t3' | 't6'` set globally for the run.
- **`mesh.elements`** — for T6 each entry has six indices in the Triangle order `[corner1, corner2, corner3, mid_opp_1, mid_opp_2, mid_opp_3]`. For T3 keep the existing length-3 form.
- **`mesh.nodes`** — already a flat list; T6 simply has more nodes (corners + midpoints).
- **`mesh.constraintEdges`** — currently each edge stores `{a, b, n1, n2, ...}` (two corner nodes). For T6 add a third `nMid` field with the index of the midpoint between `n1` and `n2`.

Important correction: Triangle's `edgelist` still reports **two endpoint nodes per edge** in the local wrapper, even in `o2` mode. It does not directly report the midpoint node. Build an edge-to-midpoint lookup from the six-node element connectivity:

```js
function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function addT6ElementEdges(edgeMidNodeByKey, element) {
  const [n1, n2, n3, m23, m31, m12] = element;
  edgeMidNodeByKey.set(edgeKey(n2, n3), m23);
  edgeMidNodeByKey.set(edgeKey(n3, n1), m31);
  edgeMidNodeByKey.set(edgeKey(n1, n2), m12);
}
```

Then `buildConstraintEdges()` can set:

```js
const nMid = mesh.elementType === 't6' ? edgeMidNodeByKey.get(edgeKey(n1, n2)) : null;
```

If `nMid` is missing for a T6 constrained edge, fail the mesh with a clear error.

### 3.3.1 Orientation correction for T6

`buildSectionMesh()` currently flips clockwise corner connectivity by swapping the second and third corner. For native Triangle `o2`, the midpoint order must be flipped too.

If the original T6 element is:

```txt
[n1, n2, n3, m23, m31, m12]
```

and we flip to `[n1, n3, n2]`, the correct full T6 connectivity becomes:

```txt
[n1, n3, n2, m23, m12, m31]
```

So the reorder is:

```js
element = [old[0], old[2], old[1], old[3], old[5], old[4]];
```

Do not use the T3-only swap on the first three entries and leave the midpoints untouched; that silently corrupts the shape functions.

### 3.4 Mesh validation

Add a per-element sanity check at the end of `buildDeformationMesh`:

- T6 only: verify each midpoint index resolves to a node whose coordinates match the correct opposite-edge midpoint within `GEOM_EPS`:
  - `element[3]` equals midpoint of `element[1]` and `element[2]`
  - `element[4]` equals midpoint of `element[2]` and `element[0]`
  - `element[5]` equals midpoint of `element[0]` and `element[1]`
  If not, the ordering is wrong — abort with a clear error rather than silently producing garbage stiffness.
- All elements: corner triangle area > `AREA_EPS` (already enforced in [element-t3.js:27](../../src/lib/cpt-app/deformation/element-t3.js#L27)).

---

## 4. Element T6 kernel module (new file)

Create `src/lib/cpt-app/deformation/element-t6.js`. The API mirrors `element-t3.js` so callers can dispatch on element type without restructuring.

### 4.1 Shape-function gradients in (x, y)

Let the corner coordinates be `(x_i, y_i)` for `i = 1, 2, 3`. Define the geometric constants:

```
2A   = (x₂ − x₁)(y₃ − y₁) − (x₃ − x₁)(y₂ − y₁)        (signed twice-area)
b_i  = y_(i+1) − y_(i+2)        (cyclic indices mod 3)
c_i  = x_(i+2) − x_(i+1)
```

These are the **same b_i, c_i** already used in [element-t3.js](../../src/lib/cpt-app/deformation/element-t3.js); reuse the helper. The gradients of the area coordinates with respect to (x, y) are:

```
∂L_i/∂x = b_i / (2A)
∂L_i/∂y = c_i / (2A)
```

The shape-function gradients follow by chain rule:

```
∂N_i/∂x = (4 L_i − 1) · b_i / (2A)             corner i ∈ {1,2,3}
∂N_i/∂y = (4 L_i − 1) · c_i / (2A)
```

For midpoint nodes (using the convention "midpoint k is opposite corner k", with the two adjacent corners being k+1 and k+2 mod 3):

```
∂N_(3+k)/∂x = 4 (L_(k+1) b_(k+2) + L_(k+2) b_(k+1)) / (2A)
∂N_(3+k)/∂y = 4 (L_(k+1) c_(k+2) + L_(k+2) c_(k+1)) / (2A)
```

### 4.2 B-matrix at a Gauss point

Voigt-3 plane-strain B is 3×12 (three strain components × twelve DOFs):

```
       ⎡ ∂N₁/∂x   0       ∂N₂/∂x   0       …   ∂N₆/∂x   0      ⎤
B(ξ) = ⎢ 0        ∂N₁/∂y  0        ∂N₂/∂y  …   0        ∂N₆/∂y ⎥
       ⎣ ∂N₁/∂y   ∂N₁/∂x  ∂N₂/∂y   ∂N₂/∂x  …   ∂N₆/∂y   ∂N₆/∂x ⎦
```

Implement as `buildBMatrixT6AtGauss(corners, L1, L2, L3) → 3×12 matrix`. `corners` is the 3-element array of corner node coordinates, sufficient to recover b_i, c_i, 2A.

### 4.3 Element stiffness

```js
// element-t6.js
export const GAUSS_T6_3PT = [
  { L1: 2/3, L2: 1/6, L3: 1/6, w: 1/6 },
  { L1: 1/6, L2: 2/3, L3: 1/6, w: 1/6 },
  { L1: 1/6, L2: 1/6, L3: 2/3, w: 1/6 }
];

export function elementStiffnessT6FromTangents2D(corners, tangents2DAtGp, area) {
  const out = Array.from({ length: 12 }, () => new Float64Array(12));
  const detJ = 2 * area;
  for (let g = 0; g < GAUSS_T6_3PT.length; g += 1) {
    const gp = GAUSS_T6_3PT[g];
    const tangent2D = tangents2DAtGp[g];
    const B = buildBMatrixT6AtGauss(corners, gp.L1, gp.L2, gp.L3);
    const wDet = gp.w * detJ;
    // K_gp[i][j] = wDet · Σ_k Σ_l B[k][i] D[k][l] B[l][j]
    for (let i = 0; i < 12; i += 1) {
      const Bi0 = B[0][i], Bi1 = B[1][i], Bi2 = B[2][i];
      for (let j = 0; j < 12; j += 1) {
        const Bj0 = B[0][j], Bj1 = B[1][j], Bj2 = B[2][j];
        const DB0 = tangent2D[0][0]*Bj0 + tangent2D[0][1]*Bj1 + tangent2D[0][2]*Bj2;
        const DB1 = tangent2D[1][0]*Bj0 + tangent2D[1][1]*Bj1 + tangent2D[1][2]*Bj2;
        const DB2 = tangent2D[2][0]*Bj0 + tangent2D[2][1]*Bj1 + tangent2D[2][2]*Bj2;
        out[i][j] += wDet * (Bi0*DB0 + Bi1*DB1 + Bi2*DB2);
      }
    }
  }
  return out;
}
```

For an unsymmetric tangent2D (Stage 2 non-associated MC), retain the full sum — do **not** symmetrize. For a symmetric D you can halve the work by mirroring; not worth doing in the first iteration.

The function accepts one tangent per Gauss point from the start. For linear elastic runs **with constant material per element** those three tangents are identical; for Stage 2 plasticity they can differ because each integration point has its own active set. For any future stress-dependent constitutive model (Hardening Soil, MIT-S1) D varies per Gauss point even in elastic predictor steps because stiffness is a function of the local stress level. Do not optimize away the per-Gauss tangent argument on the assumption that D is constant — the optimization breaks the moment HS lands.

### 4.4 Internal force vector

```js
export function elementInternalForceVectorT6(corners, stress2DAtGaussPoints, area) {
  const out = new Float64Array(12);
  const detJ = 2 * area;
  for (let g = 0; g < GAUSS_T6_3PT.length; g += 1) {
    const gp = GAUSS_T6_3PT[g];
    const sigma = stress2DAtGaussPoints[g];   // {sxx, syy, txy}
    const B = buildBMatrixT6AtGauss(corners, gp.L1, gp.L2, gp.L3);
    const wDet = gp.w * detJ;
    for (let i = 0; i < 12; i += 1) {
      out[i] += wDet * (B[0][i]*sigma.sxx + B[1][i]*sigma.syy + B[2][i]*sigma.txy);
    }
  }
  return out;
}
```

The caller passes one stress per Gauss point, in the order matching `GAUSS_T6_3PT`.

### 4.5 Body force vector (gravity, distributed)

For T6 with constant body force `(bx, by)` and straight edges, integrate **N_i · (bx, by) dA**. The integrals are:

```
∫_T  N_corner_i  dA = 0
∫_T  N_midpoint_k dA = A/3
```

These are exact, not Gauss-approximated. So the consistent T6 body-force vector concentrates the load **entirely on the midpoint nodes**:

```js
export function elementBodyForceVectorT6FromArea(area, bx = 0, by = 0) {
  const m = area / 3;   // each midpoint integral
  return new Float64Array([
    0, 0,                                // corner 1
    0, 0,                                // corner 2
    0, 0,                                // corner 3
    m * bx, m * by,                      // midpoint 4 (opp 1)
    m * bx, m * by,                      // midpoint 5 (opp 2)
    m * bx, m * by                       // midpoint 6 (opp 3)
  ]);
}
```

This is correct (zero-corner integrals are not a bug — corner shape functions are zero at the centroid and the weighted average over the triangle is zero) but it is a recurring source of confusion. Add a one-line comment in the code so a maintainer doesn't "fix" it.

### 4.6 Edge traction vector

For an edge that carries traction (tx, ty) along it, T6 has a midpoint node on the edge. Integrating the quadratic shape functions along a straight edge of length L gives the **Simpson's-rule pattern**:

```
∫_edge N_corner_a · t dL = L/6 · t
∫_edge N_corner_b · t dL = L/6 · t
∫_edge N_midpoint  · t dL = 4L/6 · t = 2L/3 · t
```

So for a quadratic edge:

```js
export function edgeTractionVectorT6(edge, tx, ty) {
  const length = Math.hypot(edge.b.x - edge.a.x, edge.b.y - edge.a.y);
  const corner = length / 6;
  const mid    = (2 * length) / 3;
  // Returns 6 entries: [ux_a, uy_a, ux_b, uy_b, ux_mid, uy_mid]
  return new Float64Array([
    corner * tx, corner * ty,      // corner a (n1)
    corner * tx, corner * ty,      // corner b (n2)
    mid    * tx, mid    * ty       // edge midpoint (nMid)
  ]);
}
```

The caller scatters using DOFs `[2*n1, 2*n1+1, 2*n2, 2*n2+1, 2*nMid, 2*nMid+1]`.

### 4.7 Module exports

```js
// element-t6.js exports:
export const T6_NUM_NODES = 6;
export const T6_NUM_DOFS  = 12;
export const T6_NUM_GP    = 3;       // Gauss points per element

export function buildBMatrixT6AtGauss(corners, L1, L2, L3) { ... }
export function elementStiffnessT6FromTangents2D(corners, tangents2DAtGp, area) { ... }
export function elementInternalForceVectorT6(corners, stressAtGp, area) { ... }
export function elementBodyForceVectorT6FromArea(area, bx, by) { ... }
export function edgeTractionVectorT6(edge, tx, ty) { ... }
export function gaussPointsXYT6(corners) {
  // Returns the (x, y) coordinates of each Gauss point in physical space.
  // Used to compute initial stress, body forces, and material parameters
  // at the actual integration locations rather than at the centroid.
}
```

### 4.8 Element-kernel dispatcher (new file)

Create `src/lib/cpt-app/deformation/element-kernel.js`. Do not import `element-kernel.js` from `element-t6.js`; that creates a circular import because the dispatcher imports the concrete element modules. Keep Gauss constants in `element-t6.js` or in a separate `triangle-quadrature.js`.

```js
import * as T3 from './element-t3.js';
import * as T6 from './element-t6.js';

export function elementKernelFor(kind) {
  if (kind === 't6') {
    return {
      kind: 't6',
      numNodes: 6,
      numDofs: 12,
      numGaussPoints: 3,
      buildB: T6.buildBMatrixT6AtGauss,
      elementStiffness: T6.elementStiffnessT6FromTangents2D,
      elementInternalForce: T6.elementInternalForceVectorT6,
      elementBodyForceFromArea: T6.elementBodyForceVectorT6FromArea,
      edgeTraction: T6.edgeTractionVectorT6,
      gaussPointsXY: T6.gaussPointsXYT6
    };
  }
  return {
    kind: 't3',
    numNodes: 3,
    numDofs: 6,
    numGaussPoints: 1,           // T3 has one (centroid) integration point
    // ... wrap the existing T3 functions with the same shapes
  };
}
```

The solver then uses `kernel = elementKernelFor(mesh.elementType)` and calls `kernel.elementStiffness(...)` etc., never branching on element type at the inner loop. This is the single point of dispatch and the entire reason for choosing parallel-module strategy.

---

## 5. Material-point and state changes

### 5.1 Per-Gauss-point material points

Currently [solver.js:1819](../../src/lib/cpt-app/deformation/solver.js#L1819) builds **one material point per element**. For T6 you need **N_gp material points per element** (3 with the default rule).

Two options:

**Option A — flat list, indexed (elementIndex, gpIndex):**
```js
mesh.elements.length * numGaussPoints   total material points
materialPoints[elementIndex * numGaussPoints + gpIndex]
```

**Option B — nested:**
```js
materialPoints[elementIndex] = [gp1State, gp2State, gp3State]
```

**Adopt Option A** — flat array indexing matches the existing T3 layout (where T3 = N_gp = 1, so flat is identical to nested). Less churn, fewer special cases.

Add a helper `gaussPointIndex(elementIndex, gpIndex, numGp)` returning the flat index. For T3 with `numGp = 1` the helper degenerates to the identity mapping.

### 5.2 `createMaterialPoint` / state seeding

[material-models.js `createMaterialPoint`](../../src/lib/cpt-app/deformation/material-models.js) takes `{ materialModel, materialParameters, committedState, elementIndex, regionIndex }`. Add an optional `gaussPointIndex` and store it on the point. No other change to state structure: `committedState`, `trialState`, `predictorState`, `referenceState`, `materialParameters` are all per-Gauss-point already in the sense that each material point owns its own state.

### 5.3 K0-controlled initial stress at Gauss points

[solver.js `buildK0ControlledInitialEffectiveStress6`](../../src/lib/cpt-app/deformation/solver.js#L1687) currently computes one stress per element from the centroid. For T6, evaluate the in-situ vertical stress at the **(x, y) of each Gauss point** instead:

```js
const gpXY = kernel.gaussPointsXY(corners);    // [{x, y}, ...]
for (let g = 0; g < gpXY.length; g += 1) {
  const u0 = sampleInitialPorePressure(model, gpXY[g].x, gpXY[g].y, options, warnings);
  initialStress6PerGp[g] = buildK0ControlledInitialEffectiveStress6(
    totalStress6AtGp[g], constitutive.materialParameters, u0
  );
}
```

The plastic geostatic equilibration phase already operates on `materialPoint.committedState`; once the seeding is correct per Gauss point, the rest is unchanged.

### 5.4 Element analysis state (`buildElementAnalysisState`)

[solver.js:1606](../../src/lib/cpt-app/deformation/solver.js) `buildElementAnalysisState` reads `B`, `dofs`, computes `ue` from `U[dofs[i]]`, multiplies `B · ue` to get `strain`, lifts to `strainTrial6`, and is currently structured for one strain per element.

For T6, replace with a per-Gauss-point function:

```js
function buildElementAnalysisStateT6(elementCache, U, kernel) {
  const ue = new Float64Array(12);
  for (let i = 0; i < 12; i += 1) ue[i] = U[elementCache.dofs[i]];
  const states = [];
  for (let g = 0; g < kernel.numGaussPoints; g += 1) {
    const gp = kernel.gaussPoints[g];
    const B = kernel.buildB(elementCache.corners, gp.L1, gp.L2, gp.L3);
    const strain = multiplyMat3xN_VecN(B, ue);    // 3×12 · 12 = 3
    states.push({
      gpIndex: g,
      ue,                          // shared across the element
      area: elementCache.area,
      B,
      strain,
      strainTrial6: liftPlaneStrainStrainTo6(strain)
    });
  }
  return states;
}
```

T3 returns a single state; T6 returns an array of three. The constitutive response is then computed per state, and the per-Gauss stresses + tangents are passed to `kernel.elementStiffness` and `kernel.elementInternalForce`.

### 5.5 Per-Gauss tangent

For Stage 2 non-associated MC the consistent tangent is a function of the active set at each Gauss point. The element stiffness loop in §4.3 should take a list `tangent2DAtGp[g]` and pull the matching tangent inside the Gauss loop:

```js
for (const [g, gp] of GAUSS_T6_3PT.entries()) {
  const D = tangent2DAtGp[g];
  const B = buildBMatrixT6AtGauss(corners, gp.L1, gp.L2, gp.L3);
  // accumulate w·B^T D B det(J) using D for this Gauss point
}
```

Implement `elementStiffnessT6FromTangents2D()` this way from the start. Do not first write a single-tangent T6 stiffness helper and then retrofit per-Gauss tangents later; that creates an avoidable plasticity refactor.

---

## 6. Solver assembly changes

### 6.1 `elementDofMap` generalization

[solver.js:1481](../../src/lib/cpt-app/deformation/solver.js#L1481):

```js
// BEFORE
function elementDofMap(element) {
  return [2*element[0], 2*element[0]+1, 2*element[1], 2*element[1]+1, 2*element[2], 2*element[2]+1];
}

// AFTER
function elementDofMap(element) {
  // element is length 3 for T3, length 6 for T6.
  const dofs = new Array(2 * element.length);
  for (let i = 0; i < element.length; i += 1) {
    dofs[2*i]     = 2 * element[i];
    dofs[2*i + 1] = 2 * element[i] + 1;
  }
  return dofs;
}
```

The generalized form returns 6 or 12 entries depending on connectivity length. T3 path is unchanged.

### 6.2 `buildDeformationElementCaches`

[solver.js:1486](../../src/lib/cpt-app/deformation/solver.js#L1486):

- Compute `area` from the **three corner nodes only** (T6 corners are always `element[0..2]`).
- Compute `corners = [nodes[element[0]], nodes[element[1]], nodes[element[2]]]` and store on the cache. T6 kernels need this.
- For T3, also compute and store `B` (constant) as today. For T6, store nothing precomputed beyond corners — B varies per Gauss point and is cheap to rebuild.
- `dofs = Int32Array.from(elementDofMap(element))` — length 6 or 12, generalized.
- Add `cache.kind = mesh.elementType` and `cache.numGaussPoints = numGp`.

### 6.3 Sparsity pattern (the big one)

[solver.js `buildCompressedAssemblyPattern`](../../src/lib/cpt-app/deformation/solver.js#L1508):

```js
// BEFORE — hard-codes 6
const freeRowIndices = new Int32Array(6);
elementCache.assemblyLocalSlots = new Int32Array(36);

// AFTER — uses element DOF count
const ndof_e = elementCache.dofs.length;     // 6 (T3) or 12 (T6)
const freeRowIndices = new Int32Array(ndof_e);
elementCache.assemblyLocalSlots = new Int32Array(ndof_e * ndof_e);
```

The fill loops also use `ndof_e` instead of literal 6:

```js
for (let localRow = 0; localRow < ndof_e; localRow += 1) {
  const freeRowIndex = freeRowIndices[localRow];
  if (freeRowIndex < 0) continue;
  const template = rowTemplates[freeRowIndex];
  for (let localCol = 0; localCol < ndof_e; localCol += 1) {
    const freeColIndex = freeRowIndices[localCol];
    if (freeColIndex < 0) continue;
    const slotIndex = template.slotByCol.get(freeColIndex);
    if (slotIndex != null) {
      elementCache.assemblyLocalSlots[localRow * ndof_e + localCol] = slotIndex;
    }
  }
}
```

The `*  6` indexing in [solver.js `addMatrixBlockToCompressedRows`](../../src/lib/cpt-app/deformation/solver.js#L801) needs the same generalization — replace `localRow * 6 + localCol` with `localRow * ndof_e + localCol`. Same for the `for (let i = 0; i < 6; ...)` loop in `addVectorBlockToFreeRhs` ([solver.js:814](../../src/lib/cpt-app/deformation/solver.js#L814)).

### 6.4 Memory note

Going from T3 to T6:
- Per-element block size: 36 → 144 entries (4×).
- Average row nnz: roughly 2× (each node connects to more elements through midpoint sharing).
- Total `compressedRows.values` allocation scales by ~8×.

For meshes with N_el ≈ 5000, memory goes from ~6 MB → ~50 MB for the global K. Manageable. For very large T6 meshes consider switching the long-term assembly map from `Map<col, slot>` to `Int32Array` indexing during pattern build.

### 6.5 `assembleNonlinearSystem` — core change

[solver.js `assembleNonlinearSystem`](../../src/lib/cpt-app/deformation/solver.js) currently walks one material point per element. For T6 it walks `numGaussPoints` material points per element:

```js
for (let elementIndex = 0; elementIndex < elementCaches.length; elementIndex += 1) {
  const elementCache = elementCaches[elementIndex];
  const corners = elementCache.corners;
  const numGp = elementCache.numGaussPoints;
  const tangentsAtGp = new Array(numGp);
  const stressesAtGp = new Array(numGp);
  // Per-Gauss-point constitutive update
  for (let g = 0; g < numGp; g += 1) {
    const mpIndex = gaussPointIndex(elementIndex, g, numGp);
    const materialPoint = materialPoints[mpIndex];
    const elementState = buildElementAnalysisStateAtGp(elementCache, UTrial, g, kernel);
    const update = materialPoint.materialModel.update({
      strainTrial6: elementState.strainTrial6,
      committedState: materialPoint.committedState,
      materialParameters: materialPoint.materialParameters,
      analysisContext: { stage: stageLabel, loadFactor, gpIndex: g }
    });
    materialPoint.trialState = update.trialState;
    materialPoint.diagnostics = update.diagnostics;
    tangentsAtGp[g]   = extractTangent2DFrom6(update.tangent6x6);
    stressesAtGp[g]   = extractStress2DFrom6(update.stressTrial6);
    // Active-set diagnostics, eta, etc. — accumulate as today.
  }
  // Single element-stiffness call per element using the list of Gauss tangents
  const Ke = kernel.elementStiffness(corners, tangentsAtGp, elementCache.area);
  const fInt_e = kernel.elementInternalForce(corners, stressesAtGp, elementCache.area);
  addMatrixBlockToCompressedRows(compressedRows, elementCache, Ke);
  addVectorBlockToFreeRhs(internalForceFree, elementCache.freeRowIndices, fInt_e);
}
```

`elementStiffness` for T6 takes a **list** of tangents (one per Gauss point); `elementInternalForce` takes a list of stresses. T3 keeps its current scalar-tangent / single-stress signature, so add a thin adapter in the dispatcher to coerce a list-of-1 to the T3 form.

### 6.6 Body force and surface traction assembly

[solver.js gravity assembly loop near §3667](../../src/lib/cpt-app/deformation/solver.js#L3683) currently calls `elementGravityVectorT3FromArea(area, gammaBulk)`. Replace with `kernel.elementBodyForceFromArea(area, 0, -gammaBulk)`. Block size matches automatically (6 or 12).

The terrain-edge traction loop calls `edgeTractionVector(edge, 0, -load.q)` and scatters into 4 DOFs. For T6 it scatters into **6 DOFs**:

```js
const dofs = mesh.elementType === 't6'
  ? [2*edge.n1, 2*edge.n1+1, 2*edge.n2, 2*edge.n2+1, 2*edge.nMid, 2*edge.nMid+1]
  : [2*edge.n1, 2*edge.n1+1, 2*edge.n2, 2*edge.n2+1];
const f = kernel.edgeTraction(edge, 0, -load.q);
addVectorBlock(loadRhs, dofs, f);
```

Use this only after `buildConstraintEdges()` guarantees `edge.nMid` exists for every loaded T6 terrain edge. Missing `nMid` should be a hard meshing error, not a skipped load contribution.

### 6.7 Initial stiffness assembly (geostatic predictor)

[solver.js geostatic stiffness assembly](../../src/lib/cpt-app/deformation/solver.js#L4002):

```js
addMatrixBlock(rows, elementCache.dofs, kernel.elementStiffness(
  elementCache.corners,
  Array(elementCache.numGaussPoints).fill(extractTangent2DFrom6(constitutive.materialModel.initialTangent6x6)),
  elementCache.area
));
```

For T3 the array degenerates to a single tangent; for T6 it's three identical tangents (constant elastic D over the element).

---

## 7. Postprocessing and sampling

### 7.1 `sampleDeformationState`

The line-probe uses barycentric interpolation on triangles. For T6, there are two valid choices:

- **Linear interpolation on corner displacements only** (treats the element as if it were T3 for sampling). Simple and fast, but it throws away the mid-edge displacement information. Use this only as a temporary fallback.
- **Quadratic interpolation using all six nodes** via the shape functions evaluated at the sample point's `(L1, L2, L3)`. More accurate but requires solving the inverse mapping `(x, y) → (L1, L2, L3)`, which for straight-edge T6 is the **same as for T3** because the geometry is still linear (only the field is quadratic).

Adopt the second: build `(L1, L2, L3)` at the sample point exactly as today (corner-only barycentric inversion), then evaluate `u(x, y) = Σ N_i(L1, L2, L3) · u_i` over all six nodes.

### 7.2 Element results

Output today carries one `elementResult` per element. For T6, also carry per-Gauss-point material state. Two strategies:

- **Centroid-only** (no plot change): the element result reports an average over the three Gauss points (e.g., mean of η_MC, mean of σ', mean of plastic strain). Plotting at the centroid then shows the average.
- **Per-Gauss-point** (richer plots): expose `gaussPoints[g].sigma`, `gaussPoints[g].materialState`. For displacement-like fields, contour plots can subdivide each T6 into 4 sub-T3 (corner-corner-midpoint trios) and evaluate the quadratic nodal field at the sub-triangle centroids. For stress and plasticity fields, plot the Gauss-point values directly or add an explicit stress-recovery/extrapolation step later; do not pretend Gauss-point values are nodal T6 values.

For first delivery: ship **element-averaged stress/plasticity results** and **quadratic displacement sampling**. If contour fill is currently triangle-based, subdivide each T6 triangle visually into four straight T3 subtriangles for displacement-like fields:

```txt
[corner1, midpoint12, midpoint31]
[midpoint12, corner2, midpoint23]
[midpoint31, midpoint23, corner3]
[midpoint12, midpoint23, midpoint31]
```

With Triangle ordering `[corner1, corner2, corner3, midpoint23, midpoint31, midpoint12]`, that subdivision maps to:

```txt
[0, 5, 4]
[5, 1, 3]
[4, 3, 2]
[5, 3, 4]
```

For stress, MC utilization, and plastic history, keep one value per parent element until per-Gauss-point plotting is added. Do not smooth averaged stresses to the T6 nodes; that would imply a stress field the constitutive integration did not compute.

### 7.3 Element-cell assignment

`mesh.elementCell` (which region each element belongs to) is unchanged — Triangle assigns region attributes per-triangle, not per-node, so T6 inherits from T3 directly.

---

## 8. Constitutive layer

The Stage 2 MC return map is **element-type-agnostic**. It runs on a strain-trial-6 input, returns an updated stress-6 and tangent-6×6, and only sees a single point's state. **No change to [material-models.js](../../src/lib/cpt-app/deformation/material-models.js) is needed for T6 plasticity**.

The two adjustments are administrative:

1. `cloneMaterialPoint` already deep-clones state — extending the per-point structure is transparent.
2. The `analysisContext` passed into `recoverElementMaterialResponse` should now carry `gpIndex` so safety/diagnostic logging can attribute per-Gauss observations.

---

## 9. GPU backend strategy

The GPU element kernels in [src/lib/cpt-app/deformation/gpu/elements.js](../../src/lib/cpt-app/deformation/gpu/elements.js) (and the `cpu-f32-backend`, `webgl-backend` consumers) currently assume T3 strides:

- B-matrix stride: 18 (3×6)
- DOF stride: 6
- Strain stride: 3 (per element)
- Internal-force stride: 6
- Element-stiffness stride: 36

For T6 the conceptual strides become much larger:

- B data: 3 Gauss points × 3 strain rows × 12 local DOFs = 108 values per element
- DOFs: 12
- strain output: 3 Gauss points × 3 components = 9
- internal force: 12
- stiffness: 144

**Do not refactor the GPU backend in the same PR as the T6 element work.** The current backend object exposes both sparse matvec and T3 element kernels. The solver opportunistically calls `elementStrain`, `elementInternalForce`, and `elementElasticStiffness` when they exist, so a T6 run must not receive the current backend unless those element-kernel calls are guarded.

Phase 1 rule:

- T6 runs on the **CPU f64 path only**.
- Before `createLinearAlgebraBackend(...)`, if `mesh.elementType === 't6'`, force `useGpuAcceleration = false` and add a warning:

```txt
T6 deformation currently uses the CPU f64 element path because the mixed-precision element kernels are T3-only.
```

Phase 2 option:

- Split backend capabilities into `matvec` and `elementKernels`.
- Allow T6 to use GPU/CPU-f32 matvec only while all element-level strain, stiffness, and force routines stay CPU f64.
- Later add true T6 element kernels with the 108/12/9/12/144 data layout above.

The sparse matvec itself is element-type agnostic after the global matrix is assembled. The danger is not matvec; it is accidentally packing a T6 element cache into the current T3-only element-kernel buffers.

---

## 10. UI / option wiring

### 10.1 Defaults block ([legacy-controller.js stage6Defaults](../../src/lib/cpt-app/legacy-controller.js))

Add `meshElementType: 't3'` to `bishop.deformation.options`.

### 10.2 Validator

Add the corresponding validation:

```js
if (!['t3', 't6'].includes(bishop.deformation.options.meshElementType)) {
  bishop.deformation.options.meshElementType = 't3';
}
```

### 10.3 Worker payload

Forward `meshElementType` to the worker at [legacy-controller.js postMessage block](../../src/lib/cpt-app/legacy-controller.js#L6191). The solver reads it from `input.options.meshElementType`.

### 10.4 Solver options pickup

In [solver.js `analyzeDeformationModel` options block](../../src/lib/cpt-app/deformation/solver.js#L3825):

```js
meshElementType: input?.options?.meshElementType === 't6' ? 't6' : 't3',
```

Pass `meshElementType` into `buildDeformationMesh` and into `buildDeformationElementCaches`.

### 10.5 UI control

Add a select in the deformation options panel near the mesh-target-area input:

```html
<label style="font-size:11px;color:var(--tx2)">Element type
  <select onchange="stage6BishopSetField('deformation.options.meshElementType', this.value)">
    <option value="t3" selected>T3 (constant strain, fast)</option>
    <option value="t6">T6 (linear strain, accurate)</option>
  </select>
</label>
<div class="st6-help">T6 (LST) elements use 6 nodes per triangle and resolve bending and stress gradients accurately on coarser meshes. Choose T6 for footing-edge stress concentrations or thin-strip bending; choose T3 for fast preliminary screens.</div>
```

### 10.6 Status display

The solver output already exposes `solver.constitutiveModel`, `solver.method`, etc. Extend with `mesh.elementType` and surface it in the deformation status table (next to "Free DOFs" — both are mesh-state quantities). Users can then audit which element type produced any saved result.

### 10.7 Result sealing

Mesh element type is part of the input identity for caching. If a saved Bishop+deformation run record predates the toggle, treat it as `t3` retroactively. Migration: add a `version: 5` bump to the deformation run record schema and default the missing field to `t3`.

---

## 11. Verification

Add the following cases to `scripts/verify_deformation_phase_1.mjs`. Each uses the existing benchmark structure but runs both element types and asserts convergence.

### 11.1 Patch tests (mandatory)

A finite-element discretization should reproduce its theoretical accuracy class exactly regardless of mesh distortion. T3 represents constant strain exactly; T6 must additionally represent linear strain exactly. Two patch tests are required, and **both must run on a deliberately distorted mesh** (e.g. a unit square split by an irregular interior vertex placed at (0.7, 0.3)). A regular-grid mesh can pass a buggy B-matrix by symmetry.

- **Test T6-A — constant-strain patch test (necessary, not sufficient).** Apply boundary displacements consistent with `ux = a·x + b·y`, `uy = c·x + d·y`; check that all internal Gauss points recover `exx = a`, `eyy = d`, `gxy = b + c` at near machine precision. **This passes for both T3 and T6** and therefore validates basic plumbing — DOF maps, B-matrix sign conventions, area/Jacobian sign — but does not distinguish T6 from T3.
- **Test T6-B — linear-strain (quadratic-displacement) patch test (the discriminating test).** Impose a quadratic displacement field directly:

```
ux(x, y) = a·x² + b·x·y + c·y²
uy(x, y) = d·x² + e·x·y + f·y²
```

The corresponding exact strain field is linear:
```
exx_exact(x, y) = 2·a·x + b·y
eyy_exact(x, y) = e·x + 2·f·y
gxy_exact(x, y) = (b + 2·d)·x + (2·c + e)·y
```

Pre-set every node's displacement to the analytical field and evaluate `B(L1_g, L2_g, L3_g) · u_e` at each Gauss point. T6 must reproduce the linear strain field at each Gauss point at near machine precision. **T3 cannot pass this test by construction** — its B is constant, so the recovered strain is the volume average instead of the per-point value. This is the test that actually validates the T6 element; without it a node-ordering bug or a midpoint-ordering bug in `element-t6.js` can pass T6-A silently.

Run both tests on (a) a regular mesh with right-triangle elements, and (b) a deliberately skewed mesh with at least one corner displaced by 30°. Both meshes must pass.

For full solver runs, do not demand `1e-12` on the global residual path. Use `1e-10` to `1e-8` depending on whether the solve is dense/unit-level or iterative sparse/Krylov.

### 11.2 h-refinement convergence

For a strip-footing problem with a known closed-form elastic solution (Boussinesq centreline displacement), run h-refinement on T3 and T6 and verify:

- Rate of convergence: in a smooth elastic benchmark, T3 should show roughly first-order convergence in strain/energy norm and T6 should improve materially, ideally toward second-order in that same norm. Displacement norms can converge one order faster, while footing-edge singularities and finite-domain boundary effects can degrade the observed rate.
- At equal numbers of DOFs, T6 error should be at least 4× lower than T3 on the same problem.

Treat the exact rates as a benchmark target, not a blocker for the first CPU implementation, because finite domain size, boundary conditions, and the current geostatic initialization can dominate the theoretical asymptotic rate.

### 11.3 Stage 2 plasticity parity

A uniform-strength MC slope problem solved with both element types on a refined mesh should converge to the same factor of safety within 1% (for the c-φ reduction route). Add this as a new case in the verification script.

### 11.4 Per-Gauss-point return-map check

For a single T6 element subjected to a non-uniform strain field that activates plasticity at one Gauss point and not at the other two, verify that:

- Plasticity activates at exactly the expected Gauss point.
- The element-level reported stress is the **integrated** average, not the centroid value.
- The consistent tangent reflects the active-set state at each Gauss point independently.

### 11.5 Load-conservation tests (hard gate)

These two tests are **mandatory before any T6 result is shown to a user**. They are cheap, deterministic, and they catch every variant of "midpoint contribution wrong / forgotten / double-counted" — which is the most common T6 implementation error class.

- **Surface traction conservation.** Apply a uniform line load `q` (kN/m) over a terrain interval of length L. Assemble only the load vector (no solve). Sum the y-components of the assembled `loadRhs` over **all nodes** (corners + midpoints for T6). The total must equal `−q · L` to within `1e-10` relative.
- **Gravity conservation.** Apply gravity `γ` over the whole mesh. Assemble only the gravity vector. Sum the y-components over all nodes. The total must equal `−Σ γ_e · A_e` (sum of element gravity over corner-triangle areas) to within `1e-10` relative.

Run both tests on T3 and T6 on the same mesh. T3 must already pass; the T6 result must be numerically identical in total. If it is not — even by 0.01 % — the T6 edge-traction or body-force kernel has a bug. Stop and fix before continuing.

The "zero on corners, A/3 on midpoints" pattern of §4.5 looks wrong to anyone who has not derived it. This test is what proves it correct.

### 11.6 Existing T3 cases must not regress

Every existing test in `verify_deformation_phase_1.mjs` (Cases 0 through 44, including the GPU-parity cases) must pass unchanged with `meshElementType: 't3'` (the default). This is a non-negotiable acceptance criterion: T3 is the production path and the T6 work is purely additive.

### 11.7 Build and svelte-check

`npm run check` and `npm run build` must remain clean. The GPU verification cases (39–44) continue to exercise the matvec and CPU-f32 backends; they are element-type agnostic.

---

## 12. Sequencing and risk

### 12.1 Recommended sequence

1. **Mesh layer**. `mesh.elementType` flag (§3.3), native `o2` switch in the deformation Triangle switch builder, T6 stride handling in `buildSectionMesh`, orientation reorder, midpoint lookup, and midpoint validation (§3.4). Ship with T3 still the only option exposed in UI; add a hidden test for the T6 mesh path that just round-trips.
2. **Element T6 module**. Implement `element-t6.js` with shape gradients, B at Gauss points, stiffness, internal force, body force, edge traction. Unit-test in isolation against analytical patch-test results.
3. **Element-kernel dispatcher**. Add `element-kernel.js`. Convert the T3 path to call through the dispatcher (with an adapter so signature is unified). Verify all existing tests still pass.
4. **Solver assembly generalization**. `elementDofMap`, sparsity pattern, assembly loops. Still only T3 elements in production; the generalized code should be a drop-in for the T3 case.
5. **Per-Gauss material-point structure**. Flat-list extension. Run all T3 verification cases at numGp=1 to confirm zero behavioural change.
6. **Wire T6 end-to-end**. Open the UI option, run patch tests T6-A / T6-B, then h-refinement and Stage 2 plasticity parity.
7. **Postprocessing**. Quadratic line-probe sampling, per-Gauss element results.
8. **GPU backend extension** (separate PR). Add T6 element kernels.

### 12.2 Risk areas

- **Triangle output stride** (§3.1). One miscount of `numberofcorners` corrupts the entire mesh silently. Add an assertion that `mesh.elements[k].length === expectedNumNodes` for every element.
- **Midpoint ordering and orientation flips**. Triangle's `o2` output orders midpoints opposite the corresponding corner. The shape functions in §1.1 assume that ordering. If `buildSectionMesh()` flips a clockwise triangle, reorder the midpoint nodes too. Add §3.4's validation early — failing fast catches both reordering bugs in Triangle output and any user-supplied mesh.
- **Per-Gauss tangent in Stage 2**. Active-set transitions can flip discontinuously between Gauss points within the same element. The Newton-Raphson converges fine, but residual-norm history can be choppier than T3. The robustness path-following infrastructure (residual-merit Armijo, adaptive continuation) handles this; do not "fix" it by averaging the tangent across Gauss points — that destroys consistency.
- **Body-force concentration on midpoints** (§4.5). The "zero on corners" is correct but counterintuitive. Comment explicitly. Verify on an isolated single-element gravity check.
- **Memory growth**. The 4× per-element block size and ~2× row nnz combine into ~8× sparse-matrix memory. Confirm on the largest verification benchmark before defaulting any user to T6.
- **Solver iteration counts**. The unsymmetric Stage-2 BiCGStab can take more iterations on T6 because the tangent is denser and the condition number rises. Track linear iteration counts in the verification cases; if Stage 2 T6 grows past 4× the T3 counts on the same problem, revisit preconditioning before declaring T6 production-ready.
- **Underconstrained T6 boundaries.** If a side or base support fixes only `n1` and `n2` of a T6 boundary edge, the midpoint node `nMid` remains free and the quadratic boundary deforms even though both corners are pinned. The constraint builder must constrain the **full set of edge nodes**, not just the two corners. Make `nMid` missing on a constrained T6 edge a hard meshing error in [§3.3](#33-mesh-builder-meshjs-and-section-meshjs); never let it fall back silently to a corner-only constraint.
- **GPU element-kernel buffers**. The current element kernels in [gpu/elements.js](../../src/lib/cpt-app/deformation/gpu/elements.js) hard-code 6 local DOFs and 18-float B layouts. If a T6 element cache reaches them by accident the kernel will write garbage. Gate the GPU element-kernel calls explicitly on `mesh.elementType === 't3'` until Phase 2 lands T6 strides.

### 12.3 Out of scope (Phase 2 work)

- Curved-edge isoparametric T6 (variable Jacobian, 7-point Gauss).
- T6 GPU kernels.
- Quadrilateral elements (Q4, Q8). The mesh layer would need a different generator; not on the critical path.
- p-refinement (mixed T3/T6 in the same mesh). The single-element-type assumption is preserved here; mixing is straightforward to add later but adds enough dispatcher complexity that it deserves a separate plan.

---

## 13. File-change checklist

| File | Change | Effort |
|---|---|---|
| `src/lib/cpt-app/seepage/triangle-runtime.js` | no required change for PSLG `o2` output; optional future fix only if we pass input T6 triangle lists for refinement | None / small later |
| `src/lib/cpt-app/deformation/mesh.js` | thread `meshElementType`, add `o2` to the generated Triangle switch string | Small |
| `src/lib/cpt-app/mesh/section-mesh.js` | preserve six-node connectivity, reorder T6 midpoints on orientation flip, build edge-to-midpoint lookup, add `nMid` on constrained edges, validate midpoint coordinates | Medium |
| `src/lib/cpt-app/deformation/element-t6.js` | **NEW** — shape gradients, B-at-Gauss, stiffness, internal force, body force, edge traction, gauss-points-XY helper | Medium |
| `src/lib/cpt-app/deformation/element-kernel.js` | **NEW** — dispatcher object, Gauss point constants | Small |
| `src/lib/cpt-app/deformation/element-t3.js` | unchanged | None |
| `src/lib/cpt-app/deformation/solver.js` | generalize `elementDofMap`, sparsity pattern, assembly, per-Gauss material-point loop, body-force / edge-traction dispatch, status output | Medium-large |
| `src/lib/cpt-app/deformation/material-models.js` | add `gpIndex` to material-point context (cosmetic) | Small |
| `src/lib/cpt-app/deformation/gpu/index.js` / solver backend setup | force CPU f64 for T6 or split backend capabilities before allowing matvec-only GPU acceleration | Small |
| `src/lib/cpt-app/legacy-controller.js` | add `meshElementType` default + UI control + worker plumbing + status row | Small-medium |
| `scripts/verify_deformation_phase_1.mjs` | add T6 patch tests, h-refinement convergence, Stage 2 parity, per-Gauss return-map test | Medium |

Total new lines of code, conservative estimate: **~900 LOC** of which `element-t6.js` is ~300, dispatcher + solver generalization ~200, UI/wiring ~80, verification cases ~250, mesh-layer adjustments ~70. No part of this requires touching the MC return map or the GPU matvec.

---

## 14. Acceptance criteria

A T6 implementation is considered production-ready when **all** the following hold:

1. `npm run check` and `npm run build` are clean with `meshElementType: 't6'` added to defaults.
2. All existing T3 verification cases pass unchanged on the T3 path.
3. **Patch tests T6-A and T6-B both pass on a regular mesh and a deliberately distorted mesh.** T6-B (linear-strain via quadratic-displacement field) is the discriminating test for T6 correctness — passing T6-A alone is necessary but not sufficient.
4. **Load-conservation tests pass for T6 within 1e-10 relative**, both for surface tractions and for gravity. T3 must continue to pass at the same tolerance.
5. h-refinement on the selected elastic benchmark shows materially better convergence for T6 than T3 at comparable DOF count.
6. **Stage 2 c-φ safety analysis on T6 produces a converged factor of safety on the standard slope benchmark**, agreeing within 1 % with the T3-refined run at equal DOF count. This explicitly includes the plastic geostatic equilibration phase running on per-Gauss-point material points.
7. The UI toggle round-trips: a deformation run on T6 reports `mesh.elementType = 't6'` in its status block and reuses correctly on re-run.
8. Memory consumption and Krylov iteration counts on the largest benchmark stay within the §12.2 bounds.
9. The deformation status panel displays element type, mesh node count, midpoint-node count, and integration-point count, so any saved result is auditable.

Once those criteria are met, T6 may be promoted to a recommended option for stress-gradient-sensitive problems while T3 remains the default for fast screening.
