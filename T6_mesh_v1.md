# T6 mesh implementation guide v1

## Goal

Add a deformation mesh setting that lets the engineer choose either:

- `T3`: current three-node linear triangles, constant strain, one material point per element.
- `T6`: six-node quadratic triangles, linearly varying strain, multiple integration points per element.

The end result should expose this in the Stage 6 deformation mesh settings and make the deformation solver run correctly for both choices.

This guide is written for the current codebase state:

- Mechanical mesh generation starts in `src/lib/cpt-app/deformation/mesh.js`.
- Common Triangle output is converted to app mesh objects in `src/lib/cpt-app/mesh/section-mesh.js`.
- The deformation solver is in `src/lib/cpt-app/deformation/solver.js`.
- The current element routines are T3-only in `src/lib/cpt-app/deformation/element-t3.js`.
- The current optional GPU element kernels are T3-only in `src/lib/cpt-app/deformation/gpu/elements.js`, `cpu-f32-backend.js`, and `webgl-backend.js`.
- The UI and state live mainly in `src/lib/cpt-app/legacy-controller.js`.

## Recommended implementation strategy

Use the existing Triangle constrained Delaunay path to generate the same robust linear triangulation, then upgrade the mechanical mesh to T6 inside the app by inserting shared mid-edge nodes.

Do not start by relying on Triangle's `-o2` switch. Triangle can output second-order elements, but an app-owned T3-to-T6 upgrade is safer for this codebase because:

1. It preserves all current PSLG recovery and retry behavior.
2. It lets us explicitly attach the mid-edge node to each constrained boundary edge.
3. It avoids uncertainty around `edgelist` / marker behavior for second-order Triangle output.
4. It keeps seepage unaffected. Seepage can remain T3 unless we later choose to add T6 seepage elements.
5. It lets us make T6 a mechanical element-order option rather than a different meshing engine.

The UI label should therefore be `Element order` or `Triangle element order`, not just `Mesh type`. The mesh is still a constrained triangular section mesh; the finite element interpolation order changes.

## High-level work plan

1. Add `deformation.options.elementOrder` to Stage 6 state and UI.
2. Pass `elementOrder` into the deformation worker.
3. Teach `buildSectionMesh()` to return either T3 or T6 connectivity.
4. Add a T6 element module with shape functions, quadrature, stiffness, body force, edge traction, and interpolation.
5. Refactor the deformation solver away from hard-coded 6-DOF T3 assumptions.
6. Change material-point storage from one point per element to one point per integration point.
7. Update boundary conditions, surface tractions, and support constraints so T6 mid-edge nodes are included.
8. Disable or guard T3-only GPU element kernels for T6 initially.
9. Update postprocessing and sampling to interpolate T6 displacements correctly.
10. Add tests, patch tests, and UI status/report updates.

## Phase 1: Add the UI/state option

### 1.1 Add default state

In `src/lib/cpt-app/legacy-controller.js`, inside `stage6Defaults().bishop.deformation.options`, add:

```js
elementOrder: 'T3',
```

Allowed values:

```js
const allowedElementOrders = ['T3', 'T6'];
```

### 1.2 Normalize existing saved state

In `ensureStage6State()`, after the deformation options object is created/merged, normalize:

```js
if (!['T3', 'T6'].includes(bishop.deformation.options.elementOrder)) {
  bishop.deformation.options.elementOrder = 'T3';
}
```

Use uppercase values in storage to avoid mixed casing later.

### 1.3 Add the control in Mesh & solve

In the deformation `Mesh & solve` details block in `renderStage6BishopApp()`, add a select near the target area controls:

```html
<label style="font-size:11px;color:var(--tx2)">Triangle element order
  <select onchange="stage6BishopSetField('deformation.options.elementOrder', this.value)">
    <option value="T3">T3 - linear, constant strain</option>
    <option value="T6">T6 - quadratic, 3 integration points</option>
  </select>
</label>
```

Use the selected state like other controls:

```js
const deformationElementOrder = deformation.options?.elementOrder === 'T6' ? 'T6' : 'T3';
```

Then render selected attributes from `deformationElementOrder`.

### 1.4 Update explanatory UI copy

Current deformation notes explicitly say the tool is on T3 triangles. Replace that with dynamic wording:

```js
{ level: 'warn', text: `This deformation workspace is a drained small-strain plane-strain tool on ${deformationElementOrder} triangles...` }
```

For T6, add a short note:

```txt
T6 uses quadratic displacement interpolation and integration-point material states. It can reduce mesh sensitivity but increases node count, DOF count, and nonlinear solve cost.
```

### 1.5 Pass the option to the worker

In `stage6BishopRunDeformation()`, include:

```js
elementOrder: bishop.deformation?.options?.elementOrder === 'T6' ? 'T6' : 'T3',
```

inside the `input.options` payload.

### 1.6 Result summary

In the deformation status/info panel, add:

```html
Element order: <strong>${deformation.result?.solver?.elementOrder || deformationElementOrder}</strong><br>
Integration points: <strong>${deformation.result?.solver?.integrationPointCount || '—'}</strong><br>
```

Keep `Triangles` as element count. For T6, add `Nodes` as total nodes including mid-edge nodes.

## Phase 2: Mesh data model

### 2.1 Existing mesh shape

`buildSectionMesh()` currently returns:

```js
{
  kind: 'triangle-cdt-fem',
  nodes,
  elements,       // currently [n0, n1, n2]
  cells,
  elementCell,
  elementData,    // area, centroid
  constraintEdges,
  domainPolygon,
  sampleGrid,
  sampleBins,
  meshStats
}
```

T6 should keep the same top-level shape but add explicit order metadata:

```js
{
  kind: 'triangle-cdt-fem',
  elementOrder: 'T6',
  nodes,          // includes corner and mid-edge nodes
  elements,       // [n0, n1, n2, n01, n12, n20]
  cornerElements, // optional: [n0, n1, n2] for drawing/search/debug
  ...
}
```

For T3:

```js
elementOrder: 'T3'
elements: [n0, n1, n2]
cornerElements: can be omitted or equal to elements
```

### 2.2 Add `elementOrder` to `buildSectionMesh()`

Change the signature in `src/lib/cpt-app/mesh/section-mesh.js`:

```js
export function buildSectionMesh({
  triangleOutput,
  pslg,
  regions,
  targetArea,
  elementOrder = 'T3',
  ...
})
```

Normalize:

```js
const resolvedElementOrder = elementOrder === 'T6' ? 'T6' : 'T3';
```

### 2.3 Pass the option from deformation mesh generation

In `src/lib/cpt-app/deformation/mesh.js`, update `buildDeformationMesh()`:

```js
return buildSectionMesh({
  triangleOutput,
  pslg,
  regions,
  targetArea: options?.meshTargetArea,
  elementOrder: options?.elementOrder === 'T6' ? 'T6' : 'T3',
  ...
});
```

Seepage should not pass `elementOrder` yet, so it remains T3.

### 2.4 Upgrade T3 connectivity to T6

Add a helper in `section-mesh.js`:

```js
function edgeKey(n1, n2) {
  return n1 < n2 ? `${n1}:${n2}` : `${n2}:${n1}`;
}

function midpointNode(nodes, n1, n2) {
  const a = nodes[n1];
  const b = nodes[n2];
  return {
    x: +((a.x + b.x) * 0.5).toFixed(8),
    y: +((a.y + b.y) * 0.5).toFixed(8)
  };
}

function getOrCreateMidNode(nodes, edgeMidNodeByKey, n1, n2) {
  const key = edgeKey(n1, n2);
  const existing = edgeMidNodeByKey.get(key);
  if (existing != null) return existing;
  const nodeId = nodes.length;
  nodes.push(midpointNode(nodes, n1, n2));
  edgeMidNodeByKey.set(key, nodeId);
  return nodeId;
}

function t6ConnectivityFromT3(nodes, edgeMidNodeByKey, tri) {
  const [n0, n1, n2] = tri;
  return [
    n0,
    n1,
    n2,
    getOrCreateMidNode(nodes, edgeMidNodeByKey, n0, n1),
    getOrCreateMidNode(nodes, edgeMidNodeByKey, n1, n2),
    getOrCreateMidNode(nodes, edgeMidNodeByKey, n2, n0)
  ];
}
```

Important: if `buildSectionMesh()` flips a clockwise triangle, flip the T3 corner order before calling `t6ConnectivityFromT3()`.

If a future implementation uses native Triangle `-o2`, then clockwise correction must reorder six nodes as:

```txt
old: [0, 1, 2, 3, 4, 5] = [v0, v1, v2, m01, m12, m20]
new: [0, 2, 1, 5, 4, 3] = [v0, v2, v1, m20, m12, m01]
```

With the recommended app-owned T6 upgrade, this reorder is not needed because mid nodes are created after the corner orientation is already normalized.

### 2.5 Keep cell polygons linear

Even for T6, keep:

```js
cell.polygon = [corner0, corner1, corner2]
cell.bbox = bboxForPolygon(cornerPts)
cell.centroid = corner centroid
cell.area = corner area
```

The current geometry has straight edges. T6 only changes displacement interpolation, not domain geometry.

### 2.6 Attach mid-edge nodes to constrained edges

Current `buildConstraintEdges()` returns:

```js
{ n1, n2, a, b, ...metadata }
```

For T6, extend it to:

```js
{
  n1,
  n2,
  nMid: edgeMidNodeByKey.get(edgeKey(n1, n2)) ?? null,
  nodeIds: nMid != null ? [n1, nMid, n2] : [n1, n2],
  a,
  b,
  ...metadata
}
```

This matters for:

- side support constraints
- base support constraints
- terrain surface traction

If `nMid` is missing for a constrained boundary edge, that means the boundary edge did not appear as an element edge. Treat this as a mesh assembly error for T6:

```txt
T6 boundary edge has no mid-edge node. The constrained Triangle edge was not found in the element edge map.
```

### 2.7 Mesh stats

Add stats:

```js
meshStats: {
  nodes: nodes.length,
  cornerNodes: originalCornerNodeCount,
  midEdgeNodes: nodes.length - originalCornerNodeCount,
  triangles: elements.length,
  elementOrder: resolvedElementOrder,
  integrationPointsPerElement: resolvedElementOrder === 'T6' ? 3 : 1,
  meanTriangleArea,
  triangleAttempt
}
```

## Phase 3: T6 element formulation

### 3.1 Create `element-t6.js`

Add:

```txt
src/lib/cpt-app/deformation/element-t6.js
```

Keep `element-t3.js` intact at first. Later we can merge both behind `element-triangle.js`.

### 3.2 Node ordering

Use this order everywhere:

```txt
0 = vertex 1
1 = vertex 2
2 = vertex 3
3 = midpoint edge 0-1
4 = midpoint edge 1-2
5 = midpoint edge 2-0
```

The displacement DOF order is:

```txt
ux0, uy0, ux1, uy1, ux2, uy2, ux3, uy3, ux4, uy4, ux5, uy5
```

### 3.3 Shape functions

Use area coordinates `L1`, `L2`, `L3`, where `L1 + L2 + L3 = 1`.

```txt
N1 = L1 * (2*L1 - 1)
N2 = L2 * (2*L2 - 1)
N3 = L3 * (2*L3 - 1)
N4 = 4 * L1 * L2
N5 = 4 * L2 * L3
N6 = 4 * L3 * L1
```

Code:

```js
export function shapeFunctionsT6(L1, L2, L3) {
  return [
    L1 * (2 * L1 - 1),
    L2 * (2 * L2 - 1),
    L3 * (2 * L3 - 1),
    4 * L1 * L2,
    4 * L2 * L3,
    4 * L3 * L1
  ];
}
```

### 3.4 Area-coordinate gradients

For the corner triangle:

```txt
dL1/dx = (y2 - y3) / area2
dL1/dy = (x3 - x2) / area2
dL2/dx = (y3 - y1) / area2
dL2/dy = (x1 - x3) / area2
dL3/dx = (y1 - y2) / area2
dL3/dy = (x2 - x1) / area2
```

This is the same information already embedded in `buildBMatrixT3()`.

Derivatives of T6 functions with respect to `L`:

```txt
dN1/dL1 = 4*L1 - 1
dN2/dL2 = 4*L2 - 1
dN3/dL3 = 4*L3 - 1

dN4/dL1 = 4*L2
dN4/dL2 = 4*L1

dN5/dL2 = 4*L3
dN5/dL3 = 4*L2

dN6/dL3 = 4*L1
dN6/dL1 = 4*L3
```

Then:

```txt
dNi/dx = dNi/dL1*dL1/dx + dNi/dL2*dL2/dx + dNi/dL3*dL3/dx
dNi/dy = dNi/dL1*dL1/dy + dNi/dL2*dL2/dy + dNi/dL3*dL3/dy
```

### 3.5 T6 B matrix

For each integration point:

```txt
B =
[ dN1/dx   0       dN2/dx   0       ... dN6/dx   0      ]
[ 0        dN1/dy  0        dN2/dy  ... 0        dN6/dy ]
[ dN1/dy   dN1/dx  dN2/dy   dN2/dx  ... dN6/dy   dN6/dx ]
```

Shape:

```txt
3 x 12
```

### 3.6 Quadrature

For T6 linear elastic stiffness with constant material tangent, `B` varies linearly and `B^T D B` is quadratic. A three-point degree-2 triangle rule is exact.

Use:

```js
export const TRIANGLE_GAUSS_3 = [
  { L1: 1 / 6, L2: 1 / 6, L3: 2 / 3, weight: 1 / 3 },
  { L1: 2 / 3, L2: 1 / 6, L3: 1 / 6, weight: 1 / 3 },
  { L1: 1 / 6, L2: 2 / 3, L3: 1 / 6, weight: 1 / 3 }
];
```

Each contribution is multiplied by:

```js
area * gp.weight
```

For nonlinear Mohr-Coulomb, this is also the first implementation target. A future option can add a 6- or 7-point rule, but do not introduce that complexity in v1 unless validation shows instability.

### 3.7 Stiffness

For each integration point:

```txt
K_e += B_gp^T * D_gp * B_gp * area * weight_gp
```

For linear-elastic assembly, `D_gp` is identical for all integration points in one element.

For elastoplastic assembly, `D_gp` comes from the material response at that integration point.

Return a 12 x 12 matrix.

### 3.8 Internal force

For each integration point:

```txt
f_int += B_gp^T * sigma_gp * area * weight_gp
```

Return length 12.

### 3.9 Body force / gravity load

Use the same quadrature:

```txt
f_body += N_gp^T * b * area * weight_gp
```

For constant gravity, the exact consistent T6 body-load result puts zero resultant on corner nodes and one third of the total load on each mid-edge node. That is mathematically correct for the quadratic Lagrange triangle, but it can surprise people reading nodal load dumps. The quadrature implementation should be used anyway because it is consistent with the element interpolation.

If numerical behavior is poor under gravity-only geostatic initialization, add an explicit optional lumped load mode later. Do not start with lumping unless validation requires it.

### 3.10 Edge traction

For a quadratic edge under constant traction:

```txt
f_edge = length / 6 * [t_corner_a, 4*t_mid, t_corner_b]
```

In DOF order:

```js
[
  length / 6 * tx,
  length / 6 * ty,
  4 * length / 6 * tx,
  4 * length / 6 * ty,
  length / 6 * tx,
  length / 6 * ty
]
```

The corresponding global DOF list is:

```js
[2*n1, 2*n1+1, 2*nMid, 2*nMid+1, 2*n2, 2*n2+1]
```

For T3 keep the existing:

```txt
length / 2 * [t_a, t_b]
```

## Phase 4: Generic element interface

Add a small adapter module:

```txt
src/lib/cpt-app/deformation/element-triangle.js
```

It should export generic functions used by the solver:

```js
export function elementLocalDofCount(elementOrder) {}
export function elementIntegrationScheme(elementOrder, nodes) {}
export function elementDofMap(element) {}
export function elementStiffnessFromIntegrationResponses(elementCache, tangentByGp) {}
export function elementBodyForceVector(elementCache, bx, by) {}
export function edgeTractionDofsAndVector(edge, elementOrder, tx, ty) {}
export function interpolateElementValue(elementOrder, point, nodes, nodalValues) {}
```

For T3:

- one integration point at centroid
- `B` is 3 x 6
- one material point
- 6 local DOFs

For T6:

- three integration points
- each has `B` 3 x 12 and `N` length 6
- three material points
- 12 local DOFs

The solver should import from this generic module instead of importing T3-specific functions directly.

## Phase 5: Solver refactor

The main solver currently assumes every element has exactly:

- 3 nodes
- 6 DOFs
- one `B` matrix
- one `area`
- one material point

T6 breaks all four assumptions.

### 5.1 Replace fixed local sizes

Change all loops like:

```js
for (let localRow = 0; localRow < 6; localRow += 1)
```

to:

```js
const localDofCount = elementCache.localDofCount;
for (let localRow = 0; localRow < localDofCount; localRow += 1)
```

Functions that need this change:

- `addMatrixBlockFlat()`
- `addMatrixBlockToCompressedRows()`
- `addMatrixBlockFlatToCompressedRows()`
- `addVectorBlockToFreeRhs()`
- `addVectorBlockFlatToFreeRhs()`
- `buildCompressedAssemblyPattern()`
- any local stiffness assembly loop in nonlinear assembly

For generic flat matrices, base stride must become:

```js
elementCache.localDofCount * elementCache.localDofCount
```

### 5.2 Generalize DOF mapping

Replace:

```js
function elementDofMap(element) {
  return [2 * element[0], 2 * element[0] + 1, ...];
}
```

with:

```js
function elementDofMap(element) {
  const out = [];
  element.forEach((nodeId) => {
    out.push(2 * nodeId, 2 * nodeId + 1);
  });
  return out;
}
```

### 5.3 Build element caches with integration points

Current `buildDeformationElementCaches()` should return:

```js
{
  elementIndex,
  cellIndex,
  element,
  nodes,
  cornerNodes,
  area,
  centroid,
  elementOrder,
  localDofCount,
  dofs,
  integrationPoints: [
    {
      gpIndex,
      weight,
      areaWeight,
      L1,
      L2,
      L3,
      x,
      y,
      N,
      B,
      materialPointIndex: -1
    }
  ],
  freeRowIndices,
  assemblyLocalSlots
}
```

For T3:

```txt
integrationPoints.length = 1
areaWeight = area
B = current constant T3 B
```

For T6:

```txt
integrationPoints.length = 3
areaWeight = area / 3
B = T6 B at each Gauss point
N = T6 shape functions at each Gauss point
```

### 5.4 Material points become integration-point points

Current:

```js
materialPoints[elementIndex]
```

New:

```js
materialPoints[materialPointIndex]
elementCache.integrationPoints[gpIndex].materialPointIndex
```

Create them in a flat array:

```js
function buildIntegrationPointMaterialPoints(mesh, elementCaches, regionConstitutiveByRegion, initialField, options, warnings) {
  const materialPoints = [];
  elementCaches.forEach((elementCache) => {
    const cell = mesh.cells[elementCache.cellIndex];
    const constitutive = regionConstitutiveForCell(regionConstitutiveByRegion, cell, options, warnings);
    elementCache.integrationPoints.forEach((gp, gpIndex) => {
      const materialPointIndex = materialPoints.length;
      gp.materialPointIndex = materialPointIndex;
      const initialStress6 = initialField?.[materialPointIndex];
      materialPoints.push(createMaterialPoint({
        materialModel: constitutive.materialModel,
        materialParameters: constitutive.materialParameters,
        committedState: seedMaterialPointStateFromEffectiveStress6(initialStress6, constitutive.materialParameters),
        elementIndex: elementCache.elementIndex,
        integrationPointIndex: gpIndex,
        regionIndex: cell?.regionIndex ?? -1
      }));
    });
  });
  return materialPoints;
}
```

### 5.5 Initial stress field at integration points

Replace element-centroid initial fields with integration-point fields.

Current:

```js
buildFlatK0InitialEffectiveStressField(mesh, model, options, warnings)
```

returns one stress per element.

New approach:

```js
buildFlatK0InitialEffectiveStressFieldForIntegrationPoints(elementCaches, mesh, model, options, warnings)
```

Loop over `elementCache.integrationPoints` and sample at `gp.x`, `gp.y`.

Likewise, `recoverInitialFieldFromGeostaticSolution()` must recover stress at each integration point after `Ugeo`.

### 5.6 Strain recovery

Replace:

```js
multiplyMat3x6Displacement(B, U, dofs)
```

with:

```js
function multiplyBDisplacement(B, U, dofs) {
  const out = { exx: 0, eyy: 0, gxy: 0 };
  for (let i = 0; i < dofs.length; i += 1) {
    const u = Number(U[dofs[i]]) || 0;
    out.exx += (Number(B[0]?.[i]) || 0) * u;
    out.eyy += (Number(B[1]?.[i]) || 0) * u;
    out.gxy += (Number(B[2]?.[i]) || 0) * u;
  }
  return out;
}
```

Then material response should be at an integration point:

```js
function recoverIntegrationPointMaterialResponse(elementCache, gp, U, materialPoint, analysisContext) {
  const strain = multiplyBDisplacement(gp.B, U, elementCache.dofs);
  ...
}
```

### 5.7 Nonlinear assembly

Current nonlinear assembly loops once per element. New loop:

```js
for each elementCache:
  localK = zeros(localDofCount x localDofCount)
  localInternal = zeros(localDofCount)
  elementActive = false

  for each gp:
    materialPoint = materialPoints[gp.materialPointIndex]
    response = recoverIntegrationPointMaterialResponse(...)
    localK += B_gp^T * tangent_gp * B_gp * gp.areaWeight
    localInternal += B_gp^T * stress_gp * gp.areaWeight
    update active counters

  add localK to compressed rows
  add localInternal to internalForceFree
```

For T3 this produces the same result as the current one-point implementation.

Counters:

- Keep `activeMcElementCount`: count an element active if any integration point is active.
- Add `activeMcIntegrationPointCount`: count all active integration points.
- For UI compatibility, continue filling `peakActiveMcElements` with element count.
- Add optional `peakActiveMcIntegrationPoints`.

### 5.8 Initial elastic stiffness and gravity assembly

Current code builds one local T3 stiffness and one T3 gravity vector per element.

New generic version:

```js
const localK = elementElasticStiffness(elementCache, (gp) => tangent2D);
addMatrixBlock(rows, elementCache.dofs, localK);

const localGravity = elementBodyForceVector(elementCache, 0, -gammaBulkAtGpOrElement);
addVectorBlock(gravityRhs, elementCache.dofs, localGravity);
```

For gravity, `gammaBulk` can be sampled per integration point:

```js
const gammaByGp = elementCache.integrationPoints.map((gp) => {
  const u0 = sampleInitialPorePressure(model, gp.x, gp.y, options, warnings);
  return initialBulkUnitWeightFromPorePressure(material, u0);
});
```

The T3 result remains identical if using the centroid.

### 5.9 Pore pressure storage

Replace:

```js
porePressureByElement[elementIndex]
```

with:

```js
porePressureByMaterialPoint[materialPointIndex]
```

or:

```js
porePressureByIntegrationPoint[flatGpIndex]
```

For element summaries, report a weighted average and optionally max:

```js
elementPorePressureAvg
elementPorePressureMax
```

### 5.10 Result recovery

`recoverElementResults()` should:

1. Recover response at every integration point.
2. Build weighted averages for stresses and strains.
3. Build max values for utilization/plasticity diagnostics.
4. Store optional integration-point detail.

Recommended element result shape:

```js
{
  elementIndex,
  centroid,
  strain: weightedAverageStrain,
  stressIncrement: weightedAverageStressIncrement,
  effectiveStress: weightedAverageEffectiveStress,
  totalStress: weightedAverageTotalStress,
  porePressure: weightedAveragePorePressure,
  mc: {
    eta: maxEtaOverIntegrationPoints,
    state: governingState
  },
  materialState: {
    accumulatedPlasticStrain: maxAccumulatedPlasticStrain
  },
  integrationPointResults: [
    {
      x,
      y,
      weight,
      strain,
      effectiveStress,
      porePressure,
      mc,
      materialState,
      materialDiagnostics
    }
  ]
}
```

Keep the current fields so contour code does not break, but source them from weighted averages or maxima.

## Phase 6: Boundary conditions and loads

### 6.1 Supports

Current support constraints in `buildConstraintSets()` only add `edge.n1` and `edge.n2`.

For T6:

```js
const nodeIds = edge.nodeIds || [edge.n1, edge.n2];
nodeIds.forEach((nodeId) => fixUx.add(nodeId));
```

Rules remain:

- side-left and side-right: fix `ux`
- base: fix `uy`

This is required. If the mid-edge node is not constrained, the quadratic boundary can deform even when the two corner nodes are fixed.

### 6.2 Surface load

Current:

```js
addVectorBlock(loadRhs, [2*n1, 2*n1+1, 2*n2, 2*n2+1], edgeTractionVector(edge, 0, -load.q));
```

Replace with:

```js
const { dofs, vector } = edgeTractionDofsAndVector(edge, mesh.elementOrder, 0, -load.q);
addVectorBlock(loadRhs, dofs, vector);
```

For T6, `edge.nodeIds` must be `[n1, nMid, n2]`.

### 6.3 Load conservation test

For a loaded terrain interval, verify:

```txt
sum(loadRhs_y) = -q * loaded_length
```

This must pass for both T3 and T6.

For gravity:

```txt
sum(gravityRhs_y) = -sum(gamma_bulk * element_area)
```

This must pass for both T3 and T6.

## Phase 7: GPU and backend handling

### 7.1 Current limitation

The optional GPU/CPU-f32 element kernels assume T3:

- `ELEMENT_DOF_STRIDE = 6`
- `ELEMENT_B_STRIDE = 18`
- `ELEMENT_FORCE_STRIDE = 6`
- `ELEMENT_STIFFNESS_STRIDE = 36`
- WebGL kernels read exactly six displacements.

These cannot be used for T6 without rewriting them.

### 7.2 MVP behavior

For v1, keep sparse matvec acceleration optional only if it does not call T3 element kernels. The safest first implementation is:

- If `elementOrder === 'T6'`, force element-kernel acceleration off.
- Either force all GPU acceleration off for T6, or create a backend flag so only matvec is used.

The lowest-risk option:

```js
if (options.elementOrder === 'T6' && options.useGpuAcceleration) {
  warnings.push('GPU element kernels are currently T3-only, so the T6 run used the CPU f64 assembly/element path.');
  options.useGpuAcceleration = false;
}
```

This keeps T6 correctness ahead of speed.

### 7.3 Future GPU support

To support T6 element kernels later:

- Generalize `deformation/gpu/elements.js` to accept variable local DOF count.
- Add `ELEMENT_DOF_STRIDE = 12` mode.
- Store B for each integration point: `3 gp * 3 strain rows * 12 dofs = 108` floats per element.
- Store `areaWeight` per integration point.
- Element strain output becomes `elementCount * gpCount * 3`.
- Internal force output becomes `elementCount * 12`.
- Stiffness output becomes `elementCount * 144`.
- WebGL kernels need extra loops over 12 local DOFs and 3 integration points.

Do this after CPU T6 is fully validated.

## Phase 8: Postprocessing, sampling, and canvas

### 8.1 Nodal displacements

`result.nodalDisplacements` should continue to have one entry per mesh node. For T6 this includes mid-edge nodes.

No UI code should assume only corner nodes exist.

### 8.2 Sampling displacement inside a T6 element

`sampleDeformationState()` currently uses linear barycentric interpolation from the three corner nodes.

Replace with element-order-aware interpolation:

```js
function sampleTriangleValue(point, triPoints, triValues, elementOrder = 'T3') {
  const { L1, L2, L3 } = barycentric(point, triPoints[0], triPoints[1], triPoints[2]);
  if (elementOrder !== 'T6') {
    return L1 * triValues[0] + L2 * triValues[1] + L3 * triValues[2];
  }
  const N = shapeFunctionsT6(L1, L2, L3);
  let value = 0;
  for (let i = 0; i < 6; i += 1) value += N[i] * triValues[i];
  return value;
}
```

`triPoints` for point-in-triangle checks should still use the first three corner nodes.

### 8.3 Contour rendering

Search in `legacy-controller.js` for deformation canvas rendering. Any code that draws:

```js
element[0], element[1], element[2]
```

can keep doing that for mesh outlines because T6 edges are straight.

For filled displacement contours, T6 should use a visual subdivision to benefit from mid-node displacement values:

```txt
subtri 1: [0, 3, 5]
subtri 2: [3, 1, 4]
subtri 3: [5, 4, 2]
subtri 4: [3, 4, 5]
```

For each subtriangle, use the corresponding nodal values. This gives a visibly smoother T6 contour without implementing curved triangle rasterization.

For element-result contours such as stress or MC eta, keep one color per parent element or draw integration point markers. Do not pretend element-averaged stress is nodally smooth.

### 8.4 Active plastic points

For T3, one marker at centroid is fine.

For T6, use integration point markers:

```js
elementResult.integrationPointResults
  .filter(gp => gp.materialState?.currentlyMcActive || gp.materialDiagnostics?.tensionCutoffActive)
  .forEach(gp => drawMarker(gp.x, gp.y))
```

This will make the plastic zone view more truthful.

## Phase 9: Result and report payloads

Wherever deformation result payloads are summarized, include:

```js
elementOrder: mesh.elementOrder,
integrationPointCount: result.solver.integrationPointCount,
integrationPointsPerElement: result.solver.integrationPointsPerElement,
midEdgeNodes: mesh.meshStats.midEdgeNodes
```

Likely places:

- deformation result object in `solver.js`
- UI result table in `legacy-controller.js`
- Stage 7 payload, if deformation mesh/result is included
- docs page `src/routes/docs/engineering/deformation/+page.svelte`

Keep old keys stable. Add new keys rather than renaming existing ones.

## Phase 10: Verification tests

Add tests to `scripts/verify_deformation_phase_1.mjs` or a new script `scripts/verify_deformation_t6.mjs`.

### 10.1 Shape function tests

Test:

- partition of unity: `sum(Ni) = 1`
- Kronecker property at all six nodes
- midpoint node values:
  - at edge 0-1 midpoint, `N4 = 1`, all others 0
  - at edge 1-2 midpoint, `N5 = 1`
  - at edge 2-0 midpoint, `N6 = 1`
- derivative finite and no NaN at all Gauss points

### 10.2 Mesh upgrade tests

Create one square split into two triangles. Upgrade to T6 and assert:

- adjacent triangles share the same mid-edge node on their common edge
- boundary edges expose `nMid`
- total node count is `cornerNodes + uniqueEdges`
- all T6 elements have 6 nodes
- all element areas equal the original T3 areas

### 10.3 Load conservation tests

For a simple rectangular domain:

- apply a terrain pressure `q`
- assemble only load vector
- assert total vertical load equals `-q * loaded_length`

For gravity:

- assemble gravity vector
- assert total vertical gravity equals `-gamma * area`

Run both T3 and T6.

### 10.4 Constant strain patch test

Use a small mesh and impose a displacement field:

```txt
ux = a*x + b*y
uy = c*x + d*y
```

For every T6 integration point, recovered strain must be:

```txt
exx = a
eyy = d
gxy = b + c
```

This test is critical. If it fails, the T6 B matrix or node ordering is wrong.

### 10.5 Constant stress equilibrium test

For a linear elastic material under a known imposed displacement field, internal forces should balance equivalent boundary tractions. This is a classic patch test. It is more work than the strain test but should be added before enabling T6 by default.

### 10.6 T3 parity test

Run the existing deformation verification script with `elementOrder: 'T3'`. Results should remain unchanged within current tolerances.

### 10.7 T6 smoke tests

Use the same base model as existing deformation tests and run:

- linear elastic T6
- MC reduced stiffness T6
- MC plastic T6 with predictor initial stress
- MC plastic T6 with plastic geostatic initial stress
- safety-cphi T6, if runtime is acceptable

Expected:

- no NaNs
- solver converges for simple cases
- load and gravity totals are conserved
- displacement magnitude is in the same engineering range as T3
- T6 is less mesh-sensitive at comparable element size

## Phase 11: Documentation updates

Update:

- `src/routes/docs/engineering/deformation/+page.svelte`
- `docs/logic.md`

Explain:

```txt
T3 is the current default constant-strain triangle. It is fast and robust but can be stiff and mesh-sensitive.

T6 adds mid-edge nodes and quadratic displacement interpolation. Strain varies inside the triangle and the solver uses integration-point material states. It can improve displacement and stress-gradient representation, especially near load edges, but increases DOFs and nonlinear cost.
```

Also state:

```txt
T6 in v1 is a straight-sided quadratic triangle. Geometry boundaries remain linear between drawn section vertices. It is not a curved-boundary isoparametric mesh.
```

## Phase 12: Implementation checklist by file

### `src/lib/cpt-app/legacy-controller.js`

Change:

- Add default `deformation.options.elementOrder`.
- Normalize `elementOrder` in `ensureStage6State()`.
- Add select control in deformation `Mesh & solve`.
- Pass `elementOrder` into `stage6BishopRunDeformation()`.
- Display element order and integration point count in deformation summary.
- Replace T3-only note with dynamic T3/T6 note.
- Update contour rendering if it can use T6 subdivision.

### `src/lib/cpt-app/deformation/mesh.js`

Change:

- Pass `options.elementOrder` into `buildSectionMesh()`.
- Keep Triangle switches unchanged for v1. Do not add `o2` yet.

### `src/lib/cpt-app/mesh/section-mesh.js`

Change:

- Accept `elementOrder`.
- Build T3 corner triangles as before.
- If T6, append shared mid-edge nodes and store 6-node element connectivity.
- Add `elementOrder`, `cornerElements`, and extended `meshStats`.
- Attach `nMid` / `nodeIds` to `constraintEdges`.
- Preserve T3 output shape for existing seepage and deformation defaults.

### `src/lib/cpt-app/deformation/element-t6.js`

Add:

- `shapeFunctionsT6()`
- `shapeFunctionDerivativesT6()`
- `buildBMatrixT6At()`
- `integrationPointsT6()`
- `elementStiffnessT6()`
- `elementInternalForceT6()`
- `elementBodyForceVectorT6()`
- `edgeTractionVectorT6()`
- `interpolateT6Value()`

### `src/lib/cpt-app/deformation/element-triangle.js`

Add:

- Generic wrapper over T3 and T6.
- Solver-facing functions should live here so `solver.js` no longer imports T3-only routines.

### `src/lib/cpt-app/deformation/solver.js`

Change:

- Parse `options.elementOrder`.
- Force/guard GPU element kernels for T6.
- Build element caches with `localDofCount` and integration points.
- Replace hard-coded 6-length local loops.
- Refactor material points to integration-point material points.
- Refactor initial stress field to integration points.
- Refactor stiffness, gravity, nonlinear tangent, and internal force assembly.
- Refactor result recovery to weighted averages plus integration-point detail.
- Include `elementOrder`, `integrationPointsPerElement`, and `integrationPointCount` in `result.solver`.

### `src/lib/cpt-app/deformation/post.js`

Change:

- Any initial stress function that returns one value per element should have an integration-point version.
- Keep current functions for T3 compatibility or wrap them.

### `src/lib/cpt-app/deformation/gpu/*`

MVP:

- Guard element kernels so they are used only for T3.
- Add warnings/fallback for T6.

Later:

- Generalize strides and WebGL kernels for 12 DOF and 3 integration points.

### `scripts/verify_deformation_phase_1.mjs`

Change:

- Add T3 regression run.
- Add T6 shape, mesh-upgrade, load-conservation, and patch tests.

Optional:

- Create `scripts/verify_deformation_t6.mjs` and add npm script:

```json
"verify:deformation-t6": "node scripts/verify_deformation_t6.mjs"
```

## Phase 13: Acceptance criteria

T6 is ready when all of these are true:

1. UI exposes `T3` and `T6` in deformation mesh settings.
2. Existing T3 results and tests remain unchanged.
3. T6 mesh generation produces 6-node elements with shared mid-edge nodes.
4. Boundary supports constrain T6 mid-edge nodes.
5. Surface tractions include T6 mid-edge nodes and conserve total load.
6. Gravity load conserves total self-weight.
7. T6 shape functions pass partition, Kronecker, and constant-strain patch tests.
8. Linear elastic T6 deformation runs converge on the base verification model.
9. MC reduced-stiffness and MC plastic T6 runs do not crash or produce NaNs on simple verification models.
10. T6 result payload states `elementOrder: 'T6'`.
11. The UI/result summary reports nodes, triangles, element order, and integration points.
12. GPU acceleration is either correctly disabled for T6 with a warning or fully generalized and verified.
13. Docs explain that T6 improves interpolation but costs more DOFs and nonlinear work.

## Main risk areas

### Risk 1: One material point per T6 element

Do not keep one material point at the centroid for T6 plasticity. That would erase the main benefit of T6 and make nonlinear results inconsistent because strain varies across the element.

Use one material point per integration point.

### Risk 2: Boundary mid-node not fixed

If only the two corner nodes are fixed on a T6 boundary edge, the mid-edge node can still move. That makes the support condition wrong.

Always constrain `edge.nodeIds`, not just `edge.n1` and `edge.n2`.

### Risk 3: T3 GPU kernels silently used on T6

The current element kernels are hard-coded for six local DOFs. If they run on T6, results will be wrong.

Disable or guard them before enabling T6.

### Risk 4: Wrong T6 node order

If the mid-edge node order is wrong, the patch test will fail and results may look plausible but be incorrect.

Use `[v0, v1, v2, m01, m12, m20]` everywhere and test it.

### Risk 5: Comparing T3 and T6 at the wrong cost

T6 has more nodes and more integration points per element. It is not fair to expect the same runtime at the same triangle count.

Compare T6 to T3 by accuracy per DOF or by mesh sensitivity, not just by element count.

## Suggested implementation order

1. Add `elementOrder` state/UI/payload only, no solver behavior yet.
2. Add mesh T6 upgrade and inspect mesh stats in UI, but keep solver rejecting T6 with a clear message.
3. Add T6 element math and standalone tests.
4. Refactor solver local DOF loops generically while still running T3 only.
5. Refactor material points to integration-point storage while proving T3 parity.
6. Enable T6 linear elastic with CPU only.
7. Enable T6 MC reduced stiffness.
8. Enable T6 MC plastic and plastic geostatic.
9. Update sampling/contours.
10. Update docs and verification scripts.
11. Only then consider GPU element-kernel support for T6.

## Definition of done for v1

For v1, it is acceptable that T6 runs CPU-only. Correctness is more important than acceleration.

The v1 feature is complete when an engineer can:

1. Open Stage 6 deformation.
2. Choose `T3` or `T6` under mesh settings.
3. Run the same deformation model with either element order.
4. See result metadata showing the selected element order.
5. Get stable, load-conserving, validated results.
6. Read docs explaining what changed and when to use T6.
