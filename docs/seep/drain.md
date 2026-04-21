# Seepage Internal Drain Plan

**Module**: Stage 6 Bishop / Seepage workspace  
**Feature**: Internal drain line with one-way head capping  
**Status**: Implementation plan  
**Positioning**: This is an internal seepage feature, not an outer-boundary BC. The drain acts as a **maximum allowed head** along a user-drawn line.

---

## 1. Goal

Add a drain to the seepage workspace such that:

- the user draws a line inside the seepage domain
- the user assigns a drain head `h_d` in metres elevation
- the drain does **nothing** when the computed total head is already below `h_d`
- the drain becomes active only where the computed total head would otherwise rise above `h_d`
- the drain is **one-way only**
  - it may remove water from the soil
  - it may **not** inject water into the soil

So the drain acts as:

```text
head on drain line <= h_d
```

not as an always-on prescribed-head line.

This is exactly the behaviour you described: the drain sets a **cap** on the head, not a mandatory head everywhere and not an injection source.

---

## 2. Interpretation

For `v1`, the drain should be interpreted as a **perfect internal drain line** with negligible hydraulic resistance:

- when inactive, it is hydraulically invisible
- when active, it clamps the line to `h_d`
- it can collect inflow from either side of the line
- it cannot add water back into the model

This is conceptually close to the current seepage-face active-set logic in:

- [src/lib/cpt-app/seepage/solver.js](../../src/lib/cpt-app/seepage/solver.js)

but with two important differences:

- seepage faces are on the **outer boundary**
- drains are **internal line constraints**

So the drain should be implemented as an **internal one-way Dirichlet active set**.

---

## 3. Mathematical Statement

Let `h(x)` be the solved total head on the drain line and let `h_d` be the drain head.

The required complementarity behaviour is:

```text
h <= h_d
q_drain >= 0
(h_d - h) * q_drain = 0
```

where:

- `h <= h_d` means the drain caps the head
- `q_drain >= 0` means net flow is from soil into drain only
- the complementarity condition means:
  - if `h < h_d`, the drain is inactive and takes no water
  - if `q_drain > 0`, the drain is active and the line sits at `h = h_d`

This is the correct one-way drain model for `v1`.

---

## 4. Current Architecture Fit

### 4.1 What already helps

The current seepage stack already has the key ingredients:

- shared constrained meshing through:
  - [src/lib/cpt-app/seepage/pslg.js](../../src/lib/cpt-app/seepage/pslg.js)
  - [src/lib/cpt-app/mesh/section-pslg.js](../../src/lib/cpt-app/mesh/section-pslg.js)
- marker-preserving constraint edges in the mesh
- an active-set seepage solve for boundary seepage faces in:
  - [src/lib/cpt-app/seepage/solver.js](../../src/lib/cpt-app/seepage/solver.js)

That means we do **not** need a new solver class.

### 4.2 What is missing

Right now the seepage BC path only understands:

- outer-boundary `head`
- outer-boundary `seepage-face`
- outer-boundary `no-flow`

The outer-boundary BC preparation lives in:

- [src/lib/cpt-app/seepage/boundary.js](../../src/lib/cpt-app/seepage/boundary.js)
- [src/lib/cpt-app/seepage/solver.js](../../src/lib/cpt-app/seepage/solver.js)

And the UI currently states that interior edges are **not** seepage BCs:

- [src/lib/cpt-app/legacy-controller.js](../../src/lib/cpt-app/legacy-controller.js)

So the drain feature is mainly:

1. an internal geometry / UI feature
2. an internal active-set extension
3. an internal discharge post-processing feature

This is a **medium-complexity** feature, not a rewrite.

---

## 5. Recommended v1 Scope

Keep `v1` tight.

### 5.1 Geometry

Support:

- one straight internal drain segment per drain
- defined by two clicks

Do not support yet:

- multi-segment polyline drains
- curved drains
- touching or crossing the outer boundary
- intersecting other drains
- varying head along the drain
- resistance or capacity limits
- filter resistance
- wells or point drains

### 5.2 Hydraulic behaviour

Support:

- constant absolute drain head `h_d`
- one-way extraction only
- internal head capping

Do not support yet:

- injection
- mixed extraction / injection logic
- user-defined flux limit
- drain conductivity or skin resistance

### 5.3 UI

Support:

- draw drain
- select drain
- edit drain head
- delete drain
- show total drain discharge in results

Optional but useful:

- show active / inactive status on the canvas
- show discharge per drain if multiple drains exist

---

## 6. Data Model

Add a dedicated internal drain list to the seepage state instead of overloading outer-boundary BCs.

Recommended shape:

```ts
type SeepageDrain = {
  id: string
  a: { x: number, y: number }
  b: { x: number, y: number }
  head: number
  mode: 'max-head'
  allowInjection: false
}
```

Recommended Stage 6 state location:

```ts
bishop.seepage.drains: SeepageDrain[]
bishop.seepage.selectedDrainId: string
```

Why keep drains separate from `seepage.bcs`:

- boundary BCs are anchored to outer boundary edges
- drains are internal geometry
- their semantics are different
- migration / selection / editing logic is cleaner when kept separate

For future-proofing, carry these fields from day one:

```ts
mode: 'max-head'
allowInjection: false
```

Even if the UI does not expose them yet.

That keeps the API ready for a later injection toggle or other internal control types.

---

## 7. UI Plan

### 7.1 New tool

Add a new seepage workspace tool:

```text
Drain
```

Workflow:

1. User selects `Drain`
2. Click first point
3. Click second point
4. Segment is created
5. Default drain head is initialized, for example to the average `y` of the segment
6. User edits the head in the seepage side panel

### 7.2 Editing

In `Edit / pan` mode:

- clicking a drain selects it
- endpoints can be dragged
- selected drain head is editable in a number input
- delete selected drain button removes it

### 7.3 Visual style

Recommended canvas rendering:

- cyan or teal dashed internal line
- small end markers
- label such as:

```text
Drain h = 2.40 m
```

If post-processing is available, the label can add:

```text
Q = 1.2E-5 m3/s/m
```

### 7.4 Validation rules

For `v1`, reject drains that:

- have zero or near-zero length
- lie partly outside the seepage domain
- touch the outer boundary
- intersect another drain
- coincide with a wall line if that creates ambiguity

Keep the rules strict first. We can relax them later if needed.

---

## 8. Meshing Plan

### 8.1 PSLG representation

In [src/lib/cpt-app/seepage/pslg.js](../../src/lib/cpt-app/seepage/pslg.js), add drain segments as internal constraint segments.

Recommended marker info:

```ts
{
  markerType: 'drain',
  drainId: string
}
```

### 8.2 Why this works

The shared PSLG system already accepts internal constraint segments. So a drain can be inserted like:

- phreatic line constraints
- region boundaries
- other internal geometry constraints

This is the right approach because:

- the drain line becomes a real edge in the final mesh
- head capping is applied on actual mesh nodes / edges
- discharge can be computed on the drain line directly

### 8.3 Local refinement

The drain should force local refinement along its length.

Recommendation:

- target edge length along drain around the same scale as head BC edges
- slightly tighter refinement near drain endpoints

Reason:

- drain activation is sensitive to head gradients along the line
- a coarse mesh would make activation too blocky and discharge too noisy

---

## 9. Mesh Extraction Plan

Right now the solver builds `boundaryFaces` only for edges with one adjacent element.

For drains we also need internal line faces:

```ts
type DrainFace = {
  n1: number
  n2: number
  a: Pt
  b: Pt
  mid: Pt
  length: number
  drainId: string
  leftElementIndex: number
  rightElementIndex: number
}
```

These should be built from `mesh.constraintEdges` where:

- `markerType === 'drain'`
- the edge belongs to exactly two adjacent elements

Do not try to fake drains as `boundaryFaces`. They are not boundary edges.

Recommended new mesh attachments:

```ts
mesh.drainFaces: DrainFace[]
mesh.drainNodeIdsByDrain: Map<string, number[]>
```

---

## 10. Solver Plan

## 10.1 Core idea

Extend the current seepage active-set loop so it tracks:

- outer seepage-face activity
- internal drain activity

Recommended new state:

```ts
activeDrainFaces: boolean[]
```

### 10.2 Dirichlet application

In the current solver, Dirichlet heads are assembled in:

- `buildDirichletValues(...)`

Extend that function so active drain faces also merge:

```text
head = h_d
```

onto the drain nodes.

When a drain face is inactive:

- it contributes no Dirichlet constraint
- it behaves as a normal internal mesh line

That gives the right one-way semantics when combined with an active set.

### 10.3 Activation rule

After solving with the current active set, evaluate each drain face.

For `v1`, use face midpoint head or edge-average nodal head:

```text
if inactive and h_face > h_d + h_tol -> activate
```

This is the "max head" trigger.

### 10.4 Deactivation / no-injection rule

To guarantee one-way behaviour, do not keep a drain active when it would inject.

So for active drain faces, compute net flux **into** the drain from both adjacent elements.

Let `q_in` mean net flow from the soil into the drain.

Then:

```text
if active and q_in < -q_tol -> deactivate
```

This is the critical one-way safeguard.

A practical combined rule for `v1`:

```text
if active:
  keep active while
    h_face >= h_d - h_tol
    and q_in >= -q_tol
otherwise deactivate
```

This gives stable hysteresis and avoids chatter.

### 10.5 Flux evaluation

For each drain face:

1. find the two adjacent elements
2. compute element gradients on both sides
3. compute the edge normal from each element toward the drain edge
4. project Darcy flux onto each side's inward normal
5. sum the two inward contributions

That gives:

```text
q_in = q_from_left + q_from_right
```

This is also the basis for total drain discharge reporting.

### 10.6 Active-set loop shape

The seepage solve already has a boundary active-set loop. The drain can fit into the same outer iteration:

1. build Dirichlet values from:
   - outer prescribed-head edges
   - active seepage faces
   - active drain faces
2. solve head field
3. update seepage-face activity
4. update drain activity
5. update wet/dry flags
6. repeat until all masks are stable

Recommended convergence condition:

- seepage-face mask unchanged
- drain-face mask unchanged
- wet/dry mask stable enough
- flow balance converged as today

---

## 11. Post-Processing

For each drain:

- total discharge into drain
- active length fraction
- number of active faces

Recommended result fields:

```ts
result.drainSummary = [
  {
    drainId,
    head,
    discharge,
    activeFaceCount,
    totalFaceCount,
    activeLength,
    totalLength
  }
]
```

This should appear in:

- seepage results panel
- exported Stage 7 payload if seepage is included there later

Useful later:

- line plot of discharge density along the drain
- active/inactive colouring on the drain line

---

## 12. Implementation Path

### Phase 1 — State and UI

Files likely touched:

- [src/lib/cpt-app/legacy-controller.js](../../src/lib/cpt-app/legacy-controller.js)

Tasks:

- add `bishop.seepage.drains`
- add `selectedDrainId`
- add `Drain` draw tool
- add drain rendering
- add head edit UI
- add delete / clear actions
- add validation
- add drains to seepage geometry invalidation

### Phase 2 — PSLG and meshing

Files likely touched:

- [src/lib/cpt-app/seepage/pslg.js](../../src/lib/cpt-app/seepage/pslg.js)
- [src/lib/cpt-app/mesh/section-pslg.js](../../src/lib/cpt-app/mesh/section-pslg.js)
- [src/lib/cpt-app/mesh/section-mesh.js](../../src/lib/cpt-app/mesh/section-mesh.js) or seepage mesh extraction

Tasks:

- add drain constraint segments
- add drain markers
- extract `mesh.drainFaces`
- store adjacency to both neighboring elements

### Phase 3 — Solver

Files likely touched:

- [src/lib/cpt-app/seepage/solver.js](../../src/lib/cpt-app/seepage/solver.js)

Tasks:

- add active drain mask
- extend Dirichlet assembly
- compute drain activation / deactivation
- compute inward drain flux
- integrate drain state into outer active-set convergence

### Phase 4 — Results and verification

Files likely touched:

- [src/lib/cpt-app/legacy-controller.js](../../src/lib/cpt-app/legacy-controller.js)
- [scripts/verify_seepage_phase_2.mjs](../../scripts/verify_seepage_phase_2.mjs)

Tasks:

- show drain discharge summary
- show active / inactive drain state
- add regression tests

---

## 13. Verification Cases

Minimum verification set:

### Case 1 — Drain below natural head activates

- homogeneous soil
- drain line at mid-depth
- left/right outer heads produce a phreatic field above drain head

Expected:

- drain activates over at least part of its length
- head along active part is capped near `h_d`
- total drain discharge is positive

### Case 2 — Drain above natural head stays inactive

- same geometry
- set `h_d` above the computed natural head field

Expected:

- drain discharge approximately zero
- seepage result matches the no-drain case closely

### Case 3 — One-way rule prevents injection

- choose `h_d` above nearby head on one side of the model but below head elsewhere

Expected:

- drain does not create net inflow from drain to soil
- active mask deactivates where injection would otherwise occur

### Case 4 — Symmetry

- symmetric geometry and symmetric outer heads
- centered horizontal drain

Expected:

- symmetric head field
- symmetric drain activation
- symmetric discharge split

### Case 5 — Cross-layer drain

- drain passes through multiple materials

Expected:

- activation still works
- no disconnected wet-region artifacts
- discharge remains finite and stable

---

## 14. v1 Limitations

The first version should state these explicitly:

- straight drain segments only
- constant head along the drain
- one-way extraction only
- no drain resistance
- no capacity limit
- no touching outer boundary
- no drain intersections
- no well points

This is fine for `v1`.

It still gives a very useful engineering feature:

- gravel trench drains
- toe drains
- horizontal drains in slopes
- internal drainage strips in embankments

as long as we are comfortable modelling them as ideal one-way head caps.

---

## 15. Future Extensions

Natural extensions after `v1`:

- polyline drains instead of one straight segment
- optional injection toggle
- optional finite drain resistance
- discharge density along the drain
- drain-water level tied to an outlet elevation
- well / point drain support
- coupling drain results into the deformation workflow

To support that future cleanly, the internal drain API should already carry:

```ts
mode: 'max-head'
allowInjection: false
```

from day one.

---

## 16. Recommendation

Implement this as a **dedicated internal drain feature**, not as a variant of outer-boundary BC assignment.

That is the cleanest design because:

- the geometry is internal
- the semantics are one-way active-set semantics
- the meshing path already supports internal constraint segments
- the current seepage solver architecture is already close to what we need

So the right plan is:

1. add drain geometry and UI
2. mesh the drain as an internal marked line
3. add an internal one-way active-set head cap
4. report total drain discharge

That should deliver a strong `v1` without overcomplicating the seepage workspace.
