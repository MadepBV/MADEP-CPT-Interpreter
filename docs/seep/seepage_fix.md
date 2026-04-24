# Seepage Fix Plan v2

## Goal

Replace the current structured seepage strip mesh with a true high-quality triangular mesh suitable for FEM seepage, while keeping the existing seepage physics, Stage 6 workflow, and Bishop pore-pressure handoff intact.

This plan is a reset of the earlier triangulation attempt. The earlier note mixed solver fixes with mesher experimentation. The new target is clearer:

- keep the seepage solver fixes that are already correct
- stop treating the current strip mesh as "good enough"
- stop trying to hand-roll a PLAXIS-like mesh from custom face-walking + ear clipping
- move to a proper constrained Delaunay triangulation workflow

---

## Investigation Summary

### 1. The active mesh is still rectangular-strip based

The live seepage path is in [solver.js](../../src/lib/cpt-app/seepage/solver.js):

- [buildMeshCoordinates](../../src/lib/cpt-app/seepage/solver.js#L882)
- [splitSegmentsToAtomicPieces](../../src/lib/cpt-app/seepage/solver.js#L912)
- [buildTrianglesForPolygon](../../src/lib/cpt-app/seepage/solver.js#L998)
- [generateTriangulatedMesh](../../src/lib/cpt-app/seepage/solver.js#L1554)

Despite the function name `generateTriangulatedMesh`, the active path is:

1. Build regular `x` and `y` axes from `meshTargetArea`
2. Inject terrain / region / phreatic coordinates into those axes
3. Split region and phreatic segments against the strip grid
4. Build strip cells under the terrain
5. Split those strip cells by internal segments
6. Triangulate each resulting polygon with a simple fan

So the solver does use T3 triangles, but the mesh topology is inherited from an axis-aligned strip grid.

### 2. The file still contains a second, inactive custom triangulation attempt

There is also a dormant arrangement-based mesher earlier in the same file:

- [buildConstraintSegments](../../src/lib/cpt-app/seepage/solver.js#L437)
- [splitConstraintSegments](../../src/lib/cpt-app/seepage/solver.js#L536)
- [buildPlanarFacesFromSegments](../../src/lib/cpt-app/seepage/solver.js#L544)
- [triangulatePolygonEarClip](../../src/lib/cpt-app/seepage/solver.js#L650)
- [performLawsonDelaunayFlips](../../src/lib/cpt-app/seepage/solver.js#L726)

These helpers are not the active path anymore. They represent the previous attempt to get to a real triangle mesh, but they are not robust enough to become the foundation.

### 3. Why the current strip mesh is not sufficient

The current active mesh is robust enough to solve, but it is not the mesh we want:

- boundaries are still fundamentally strip-driven, not geometry-driven
- sloped terrain and sloped region contacts are approximated through strip subdivision
- triangle quality is incidental, not controlled
- local refinement near wall tips, seepage faces, corners, and thin regions is weak
- the mesh does not resemble the clean unstructured triangular meshes used in PLAXIS-class tools
- the solver still has to recover outer-boundary semantics geometrically instead of reading them from native mesh boundary markers

### 4. Why the previous custom triangulation attempt should not be revived

The earlier attempt was moving in the right direction conceptually, but the wrong direction technically.

The problems are structural:

- custom planar arrangement extraction is hard to make numerically robust in JavaScript
- ear clipping is not a quality mesher
- Lawson flipping improves local diagonals but does not replace a proper CDT + refinement pipeline
- tolerance handling becomes fragile around near-coincident points and shallow intersection angles
- quality refinement was being approximated by polygon splitting rather than by proper Steiner-point insertion

That is why the mesh never looked "clean" enough even when the solve technically worked.

Conclusion: we should not keep iterating on the custom face-arrangement mesher. We should replace it with a real constrained Delaunay meshing workflow.

---

## Target Mesh

The target is a **constrained Delaunay triangulation with quality refinement**, i.e. the same class of meshing strategy used by professional 2D FEM tools.

For this app, "PLAXIS-like" means:

- exact outer boundary representation
- exact region-boundary representation
- exact wall-boundary representation
- exact fixed-phreatic internal constraint when `freeSurface = fixed`
- preserved boundary markers for BC assignment
- preserved region markers for material assignment
- local Steiner-point refinement where needed
- minimum-angle quality control
- smooth size transitions instead of abrupt strip changes

Not required:

- we do not need quadratic elements
- we do not need adaptive remeshing during the solve
- we do not need full PLAXIS feature parity

We do need:

- a real unstructured triangular mesh
- robust constrained boundary handling
- reproducible quality refinement

---

## Recommendation

### Use a proven CDT/refinement mesher, not a custom one

Primary recommendation:

- integrate a proven constrained-Delaunay mesher with refinement into the seepage worker
- use a Triangle-class approach: PSLG input, segment constraints, region markers, quality refinement, local max-area control

Important caveat:

- mesher choice must pass legal/license review before integration

If the preferred mesher cannot be used for legal or packaging reasons, the fallback should still be:

- another robust CDT + refinement library

The fallback should **not** be:

- reviving the custom face-arrangement + ear-clipping path
- continuing with the strip mesh as the long-term architecture

---

## Implementation Path

### Phase 0 — Freeze the current strip mesh as legacy

Before introducing a new triangular mesher:

1. Rename the active path conceptually to `generateStructuredStripMesh`
2. Leave it available behind a developer flag during migration
3. Keep the current seepage solver fixes on both paths:
   - seepage-face-gated exit gradient
   - flux-based seepage-face activation
   - strict boundary-face matching
   - non-converged solve rejection

Reason:

- we need a stable reference during migration
- we need a way to compare seepage results between old and new meshes

### Phase 1 — Build a canonical PSLG representation

Add a new module, for example:

- `src/lib/cpt-app/seepage/pslg.js`

This module should produce a single canonical planar straight-line graph from the Bishop geometry.

Input sources:

- outer boundary from terrain + left side + base + right side
- all soil polygon boundaries
- retaining wall boundaries
- fixed phreatic line, when applicable

Output:

- `points[]`
- `segments[]`
- `holes[]`
- `regions[]`
- per-segment markers
- per-region markers

Rules:

- merge points with one tolerance only
- reject zero-length segments
- reject self-intersections before meshing
- keep segment provenance:
  - `outer`
  - `region`
  - `wall`
  - `phreatic`
  - `bc:<edgeKey>`

This is the most important separation of concerns in the redesign. Geometry preparation must stop living inside the mesher.

### Phase 2 — Introduce a real mesher adapter

Add a dedicated mesher boundary, for example:

- `src/lib/cpt-app/seepage/mesh-cdt.js`

Responsibilities:

- accept PSLG input
- call the selected CDT/refinement backend
- return a clean FEM mesh model

Required mesh output:

- `nodes[]`
- `elements[]`
- `elementRegionId[]`
- `boundaryEdges[]`
- `segmentMarkers[]`
- `regionMarkers[]`

Desired quality controls:

- default minimum angle target around `28°–30°`
- global max element area derived from `meshTargetArea`
- local refinement multipliers near:
  - retaining-wall tips
  - seepage-face edges
  - BC-type transitions
  - re-entrant corners
  - thin polygons
  - phreatic line endpoints

This phase should end with a mesh that is truly unstructured and visibly triangular.

### Phase 3 — Replace geometric boundary recovery with marker-driven boundary faces

Current code in [buildBoundaryFaces](../../src/lib/cpt-app/seepage/solver.js#L1330) reconstructs boundary semantics by matching triangle edges back to the outer boundary geometry.

That should be removed for the CDT path.

New behavior:

- boundary faces come directly from mesher boundary edges
- each boundary edge already knows:
  - which original segment it belongs to
  - which BC edge key it maps to
  - its outward normal

Result:

- no more midpoint matching
- no more tolerance-based "is this really on the outer boundary?"
- BC assignment becomes deterministic

### Phase 4 — Move region/material assignment to element markers

Current strip path assigns material by centroid lookup after cell splitting.

For the CDT path:

- each element should inherit a region marker from the mesher
- that marker should map directly to the source soil polygon or wall region

This avoids:

- ambiguous centroid classification near boundaries
- accidental wrong-material triangles in thin regions

### Phase 5 — Add a real triangle locator for post-processing

Current seepage sampling still has strip-era behavior in mind:

- [samplePointCandidates](../../src/lib/cpt-app/seepage/solver.js#L1828)

For the new mesh we should add:

- triangle AABB spatial index or uniform spatial hash
- direct point-to-triangle lookup

Use that for:

- `sampleSeepageHead`
- contouring
- Bishop pore-pressure sampling
- report spot sampling if needed later

This should be triangle-based, not cell-based.

### Phase 6 — Keep the FEM solver, change only the mesh plumbing

The good news is that the actual FEM assembly is already T3-triangle based:

- [elementMatrix](../../src/lib/cpt-app/seepage/solver.js#L1009)
- [solveHeadField](../../src/lib/cpt-app/seepage/solver.js#L1204)
- [computeElementGradients](../../src/lib/cpt-app/seepage/solver.js#L1288)

That means the migration does **not** require a new seepage equation solver.

We should keep:

- T3 linear triangles
- current matrix assembly
- CG solve
- current seepage-face iteration logic

We should replace:

- mesh generation
- mesh metadata
- sampling/indexing
- boundary-face extraction

### Phase 7 — Update canvas rendering to show the actual triangular mesh

For the new mesh to be inspectable:

- add a mesh overlay toggle that draws actual triangle edges
- head fill should be element-based or nodally interpolated on triangles
- flow vectors should be element-based

Important:

- the main seepage visualization should not look rectangular once the new mesher is live

### Phase 8 — Remove the dead mesher paths

Once the new CDT path is stable:

Delete or isolate:

- strip-mesh-only helpers:
  - [buildMeshCoordinates](../../src/lib/cpt-app/seepage/solver.js#L882)
  - [splitSegmentsToAtomicPieces](../../src/lib/cpt-app/seepage/solver.js#L912)
  - [buildTrianglesForPolygon](../../src/lib/cpt-app/seepage/solver.js#L998)
  - [chooseQuadDiagonal](../../src/lib/cpt-app/seepage/solver.js#L992)
- dormant custom arrangement helpers:
  - [buildConstraintSegments](../../src/lib/cpt-app/seepage/solver.js#L437)
  - [splitConstraintSegments](../../src/lib/cpt-app/seepage/solver.js#L536)
  - [buildPlanarFacesFromSegments](../../src/lib/cpt-app/seepage/solver.js#L544)
  - [triangulatePolygonEarClip](../../src/lib/cpt-app/seepage/solver.js#L650)
  - [performLawsonDelaunayFlips](../../src/lib/cpt-app/seepage/solver.js#L726)

Only one production mesher should remain.

---

## Quality Requirements

The new triangular mesh should satisfy the following practical requirements.

### Geometry fidelity

- outer boundary exact to source geometry
- region boundaries exact
- walls exact
- fixed phreatic line exact

### Mesh quality

- no zero-area triangles
- no duplicate nodes
- no unconstrained edge crossing a constrained segment
- minimum angle target enforced by refinement
- local gradation should look smooth, not strip-based

### Solver behavior

- head/head case: zero exit gradient
- seepage-face case: positive exit gradient
- fixed-phreatic case: `h = y` on the fixed phreatic line
- iterate case: Dupuit-style regression still passes
- Bishop/Spencer with seepage off: unchanged
- Bishop/Spencer with seepage on: FEM pore pressure sampling works on the new mesh

### Runtime

The target should remain interactive in-browser:

- moderate case should stay under a few seconds
- mesh size should scale predictably with `meshTargetArea`

If the chosen mesher backend misses the runtime target badly, that is a blocker, not a polish issue.

---

## What Should Not Be Done

Do not:

- add more special cases to the current strip mesh hoping it becomes "almost triangular"
- continue the custom face-arrangement + ear-clipping path as the main solution
- treat Lawson flips as a substitute for a real CDT/refinement backend
- keep BC recovery dependent on midpoint geometry matching once a marked boundary mesh exists

Those all spend effort in the wrong layer.

---

## Practical Recommendation

The implementation path should be:

1. freeze the current strip mesh as legacy
2. build a canonical PSLG builder
3. integrate a proven CDT/refinement mesher in the worker
4. keep the current FEM solve and seepage-face logic
5. switch boundary handling to marker-driven edges
6. add triangle-based sampling and display
7. remove the dead mesher code

This is the shortest path to the kind of mesh quality we actually want.

---

## Decision

Recommended direction:

- **Proceed with a true constrained Delaunay triangulation implementation**
- **Do not continue iterating on the current custom triangulation attempt**
- **Keep the current rectangular strip mesh only as the temporary fallback during migration**

That is the path most likely to produce the clean, professional triangular mesh we are looking for.
