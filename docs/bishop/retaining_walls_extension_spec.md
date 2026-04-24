# Rigid Vertical Retaining Walls in Bishop/Spencer Analysis

**Extension to**: Bishop Simplified v1 + Spencer v2 slope stability solver  
**Scope**: Infinitely stiff vertical walls — no wall deformation, no bending analysis  
**Purpose**: Model the stabilising effect of retaining structures (sheet piles, diaphragm walls, soldier pile walls, gravity walls) on circular slip surface factors of safety  

---

## Contents

1. [What This Adds](#1-what-this-adds)
2. [Is This Easy to Integrate?](#2-is-this-easy-to-integrate)
3. [Physical Model](#3-physical-model)
4. [Wall Geometry & Slice Interaction](#4-wall-geometry--slice-interaction)
   - 4.1 [Wall definition](#41-wall-definition)
   - 4.2 [How the slip circle intersects a wall](#42-how-the-slip-circle-intersects-a-wall)
   - 4.3 [Truncated vs. passing circles](#43-truncated-vs-passing-circles)
5. [Wall Resistance Force](#5-wall-resistance-force)
   - 5.1 [Passive earth pressure (soil limit)](#51-passive-earth-pressure)
   - 5.2 [Wall structural capacity (structure limit)](#52-wall-structural-capacity)
   - 5.3 [Governing resistance](#53-governing-resistance)
   - 5.4 [Point of application](#54-point-of-application)
6. [Modified Bishop Equation](#6-modified-bishop-equation)
   - 6.1 [Additional moment from wall force](#61-additional-moment-from-wall-force)
   - 6.2 [Modified governing equation](#62-modified-governing-equation)
   - 6.3 [Iteration — nothing changes](#63-iteration--nothing-changes)
7. [Modified Spencer Equation](#7-modified-spencer-equation)
   - 7.1 [Wall force in moment equilibrium (F_m)](#71-wall-force-in-moment-equilibrium)
   - 7.2 [Wall force in force equilibrium (F_f)](#72-wall-force-in-force-equilibrium)
   - 7.3 [The outer solver is unchanged](#73-the-outer-solver-is-unchanged)
8. [Modified Slice Builder](#8-modified-slice-builder)
9. [Search Modifications](#9-search-modifications)
10. [Data Structures](#10-data-structures)
11. [Complete Pseudocode](#11-complete-pseudocode)
12. [Verification](#12-verification)
13. [Limitations & Future Extensions](#13-limitations--future-extensions)
14. [References](#14-references)

---

## 1. What This Adds

A user places one or more vertical walls on the cross-section. Each wall is defined by an x-position, a top elevation, and a bottom elevation (tip depth). When a trial slip circle intersects a wall, the wall provides a horizontal resisting force that enters the equilibrium equations as an additional stabilising term. The factor of safety increases because the wall adds resisting moment (in Bishop) and resisting horizontal force (in Spencer).

This models the common practical scenario: a slope or embankment is stabilised by driving sheet piles, installing a secant pile wall, or constructing a diaphragm wall. The engineer wants to know how much the wall improves the factor of safety and whether the critical slip surface shifts.

The wall itself is not analysed structurally in this module — it is assumed infinitely stiff and strong enough to mobilise the resistance computed. A separate structural check (bending moment, shear, embedment adequacy) must be performed outside this module. This is standard practice: SLOPE/W, SLIDE, and other commercial tools handle walls the same way — as a force input to the limit-equilibrium calculation.

---

## 2. Is This Easy to Integrate?

**Yes.** The integration touches only three places in the existing code:

| Change | Where | Effort |
|--------|-------|--------|
| Add a mandatory slice cut at the wall x-position | Slice builder (`buildSlices`) | 3 lines of code |
| Compute wall resistance force R_wall and its application point | New function, ~50 lines | Half a day |
| Add R_wall's moment contribution to the Bishop numerator | `computeBishopF` inner loop | 4 lines of code |
| Add R_wall's force contribution to Spencer force chain | `propagateForces` | 6 lines of code |
| Wall definition UI (draw a vertical line, set properties) | Canvas interaction | 1–2 days |

The solver structure, the iteration scheme, the search strategy, and the convergence logic are all unchanged. The wall force is an additive external force — it does not change the form of the equations, only adds a term.

**Total effort: 2–3 days**, including UI. If you skip the UI and hardcode wall positions for testing: half a day.

---

## 3. Physical Model

Consider a vertical wall embedded in a slope. A circular slip surface passes through the soil and intersects the wall at some depth. The sliding mass is divided into two parts by the wall:

```
                    ╱ terrain
                   ╱
    ┌─────────────╱──────────────────────
    │ ACTIVE SIDE │    PASSIVE SIDE
    │ (driving)   │    (resisting)
    │     ╲       │WALL     ╱
    │      ╲      │  ║     ╱
    │       ╲     │  ║    ╱
    │        ╲────│──║───╱  ← slip circle
    │              │  ║
    │              │  ║ ← wall tip
    └──────────────│──────────────────────

The wall provides a horizontal force R_wall that resists the
sliding mass. This force is limited by the LESSER of:
  a) The passive earth pressure the soil on the resisting side
     can develop over the depth from the slip circle intersection
     to the wall tip
  b) The structural shear capacity of the wall at the slip
     circle intersection point

For an infinitely stiff wall, (b) is infinite, so (a) governs.
In practice, you should still allow the user to input a maximum
wall force to capture structural limits.
```

The wall force R_wall acts horizontally (perpendicular to the wall face) at a specific depth on the wall. It is the net force: passive pressure on the resisting side minus active pressure on the driving side, integrated over the relevant depth range. But in the context of limit-equilibrium slope stability, the standard simplification is to treat R_wall as a single horizontal force applied at a defined point.

---

## 4. Wall Geometry & Slice Interaction

### 4.1 Wall definition

A wall is defined by:

```
struct RetainingWall {
  x:          float    // horizontal position (m)
  yTop:       float    // top of wall elevation (m) — typically at terrain
  yTip:       float    // bottom of wall (tip) elevation (m)

  // Structural properties (for force limiting)
  maxShearForce:  float   // maximum horizontal force the wall can resist
                          // (kN/m run). Set to Infinity for infinitely
                          // strong wall. Typical: 200–1000 kN/m for
                          // sheet piles, higher for diaphragm walls.

  // Soil interaction
  passiveSide:  enum { LEFT, RIGHT }
    // Which side of the wall develops passive pressure.
    // For a wall stabilising a slope that descends left→right,
    // the passive side is typically RIGHT (downslope, resisting).
    // The solver can infer this from the slip direction, but
    // explicit specification avoids ambiguity.
}
```

### 4.2 How the slip circle intersects a wall

For a given slip circle (xc, yc, R) and a wall at x = x_wall:

```
Intersection of circle with vertical line x = x_wall:

  y_intersect = yc - sqrt(R² - (x_wall - xc)²)

  (take the LOWER root — the slip surface, not the upper arc)

Conditions for a valid intersection:
  1. |x_wall - xc| < R   (wall is within the circle's horizontal extent)
  2. y_intersect > yTip   (circle crosses above the wall tip)
  3. y_intersect < yTop   (circle crosses below the wall top)
  4. x_wall is between entry.x and exit.x  (wall is within the sliding mass)

If all conditions are met, the circle intersects the wall at
(x_wall, y_intersect). This is the point where the wall force acts.

If condition 2 fails (circle goes below the wall tip), the circle
passes UNDER the wall — the wall has no effect on this surface.

If condition 3 fails (circle is above the wall top), the circle
passes OVER the wall — only possible if the wall is short.

If condition 4 fails, the wall is outside the sliding mass entirely.
```

### 4.3 Truncated vs. passing circles

Two cases arise when a slip circle encounters a wall:

**Case A: Circle intersects the wall within its depth range.** This is the common case. The wall provides a resisting force. The slip surface is NOT truncated — it continues through the soil below the wall tip. The slices are generated normally, with the wall x-position as a mandatory slice cut. The wall force is applied as an external force at the wall location.

**Case B: Circle passes below the wall tip.** The wall has no effect. The slip surface passes entirely below the wall's influence zone. This is an important scenario to capture — deep-seated failures can undermine a wall. The solver should analyse these surfaces normally, without any wall force.

```
For v1, only Case A needs implementation. Case B is the default
(no wall intersection → no wall force → existing solver unchanged).

DO NOT truncate the slip circle at the wall. The slip continues
through the soil on both sides. The wall is a force, not a
geometric barrier to the failure surface. This is how SLOPE/W
and SLIDE handle structural elements in limit equilibrium.
```

---

## 5. Wall Resistance Force

### 5.1 Passive earth pressure (soil limit)

The maximum horizontal force the soil on the passive side can provide over the depth from the slip circle intersection to the wall tip is the passive earth pressure resultant:

```
PASSIVE RESISTANCE (Rankine, simplified)

The passive pressure at depth z below terrain on the passive side:
  σ_p(z) = Kp · γ · z + 2 · c' · sqrt(Kp)

where:
  Kp = tan²(45° + φ'/2)    — Rankine passive coefficient
  γ  = unit weight of soil on the passive side (kN/m³)
  c' = effective cohesion of soil on the passive side (kPa)
  z  = depth below terrain surface at the wall location

The total passive force over the embedded depth below the slip
circle intersection:

  d = y_intersect - yTip    (depth from slip intersection to wall tip)

For uniform soil:
  R_passive = 0.5 · Kp · γ · (z_tip² - z_int²) + 2 · c' · sqrt(Kp) · d

where:
  z_int = yTerrain(x_wall) - y_intersect   (depth of intersection below terrain)
  z_tip = yTerrain(x_wall) - yTip          (depth of wall tip below terrain)
  d     = z_tip - z_int                     (effective wall depth below slip)

For multi-layer soil (layers with different c', φ', γ):
  Integrate the passive pressure over each layer within the range
  [y_intersect, yTip], summing the trapezoidal contributions.

ACTIVE PRESSURE on the driving side (opposing the passive):
  In a rigorous analysis, the active pressure on the driving side
  reduces the net wall force:

  σ_a(z) = Ka · γ · z - 2 · c' · sqrt(Ka)
  Ka = tan²(45° - φ'/2)

  R_active = 0.5 · Ka · γ · (z_tip² - z_int²) - 2 · c' · sqrt(Ka) · d

  Net wall force: R_wall = R_passive - R_active
  (R_active is subtracted because it pushes in the sliding direction)

For v1 simplification:
  Use only the net passive resistance. This is conservative because
  the active pressure on the driving side is already implicitly
  accounted for in the slice weights and the Bishop/Spencer
  equilibrium — the slices on the driving side of the wall
  contribute their full driving moment. Adding R_active explicitly
  would partially double-count the driving force.

  The standard approach in SLOPE/W is to input R_wall as the net
  restoring force. For v1, compute R_passive only over the depth
  below the slip intersection to the wall tip.
```

### 5.2 Wall structural capacity (structure limit)

```
For an infinitely stiff and strong wall: no structural limit.

For a real wall, the force is limited by:
  1. Shear capacity: R_wall ≤ V_Rd (design shear resistance)
  2. Moment capacity: the wall must resist the bending moment
     from the force distribution. This depends on the fixity
     condition at the base and any anchors.

For v1: the user inputs a maxShearForce value (kN/m).
  If not specified, treat as infinity (soil limit governs).
  This keeps the solver simple while allowing structural limits.
```

### 5.3 Governing resistance

```
R_wall = min(R_passive, maxShearForce)

If R_wall ≤ 0: the wall provides no resistance for this slip surface
(e.g. the slip barely intersects the wall, or the soil is very weak).
Treat as if the wall does not exist for this surface.
```

### 5.4 Point of application

The passive pressure distribution is triangular (or trapezoidal with cohesion). The resultant force acts at a specific elevation:

```
For triangular passive pressure (c' = 0, uniform γ):
  The resultant acts at 1/3 of the embedded depth above the wall tip:
  y_application = yTip + d/3

For uniform passive pressure (c' only, φ' = 0):
  The resultant acts at the midpoint:
  y_application = yTip + d/2

For the general case (both c' and φ'):
  Compute the centroid of the pressure distribution numerically.
  Practical simplification: use y_application = yTip + d/3
  (this is slightly conservative — the actual point is slightly
  higher when cohesion is present, which gives a smaller moment
  arm and thus less stabilising moment).

The moment arm from the wall force to the circle centre:
  arm = yc - y_application    (vertical distance, since R_wall is horizontal)

  — wait, more precisely:

  R_wall is horizontal, acting at (x_wall, y_application).
  The moment about the circle centre (xc, yc) is:

  M_wall = R_wall × (yc - y_application)

  This is because a horizontal force at elevation y_application
  creates a moment about (xc, yc) equal to force × vertical
  lever arm. The horizontal distance (x_wall - xc) does not
  contribute to the moment of a horizontal force about any point
  — horizontal force × horizontal arm = zero moment.

  Actually, let me be more careful. The moment of R_wall about (xc, yc):

  M_wall = R_wall × perpendicular distance from (xc, yc) to the
           line of action of R_wall.

  R_wall is horizontal, acting at y = y_application.
  Perpendicular distance from (xc, yc) to this horizontal line = |yc - y_application|.

  Since yc (circle centre) is above the slope and y_application
  is below, the distance is (yc - y_application), always positive.

  The sign: R_wall resists sliding, so it creates a RESTORING moment
  (same sign as the shear forces on the slip base).

  M_wall = R_wall × (yc - y_application)

  This is added to the NUMERATOR of the Bishop equation (resisting side).
```

---

## 6. Modified Bishop Equation

### 6.1 Additional moment from wall force

The wall provides a resisting moment about the circle centre. In the Bishop equation, this enters as an additional term in the numerator:

```
ORIGINAL BISHOP:

            Σ [ (c'·b + (W - u·b)·tan(φ')) / m_α ]
  F  =  ──────────────────────────────────────────────
                      Σ [ W · sin(α) ]

MODIFIED BISHOP (with wall force):

            Σ [ (c'·b + (W - u·b)·tan(φ')) / m_α ]  +  R_wall × (yc - y_app) / R
  F  =  ──────────────────────────────────────────────────────────────────────────────
                      Σ [ W · sin(α) ]

where:
  R_wall  = wall resistance force (kN/m)
  y_app   = elevation where R_wall acts (m)
  yc      = circle centre y-coordinate (m)
  R       = circle radius (m)

The wall moment term is divided by R because the original Bishop equation
has R cancelled from numerator and denominator. To be precise:

Original moment equation (before R cancels):
  Σ W·R·sin(α) = (1/F) × Σ [c'·l·R + N'·tan(φ')·R] + M_wall / F

Wait — I need to be more careful about whether the wall moment is
divided by F. Let me re-derive.
```

### 6.2 Modified governing equation

The wall force is an external force, not a mobilised soil resistance. Therefore it does NOT get divided by F. The full derivation:

```
MOMENT EQUILIBRIUM about the circle centre:

  Driving moment = Resisting moment

  Σ W_i · R · sin(α_i)  =  Σ S_i · R  +  M_wall

where:
  S_i = (1/F) × (c'_i · l_i + N'_i · tan(φ'_i))    (mobilised shear)
  M_wall = R_wall × (yc - y_application)              (wall restoring moment)

Rearranging:
  Σ W_i · R · sin(α_i) - M_wall  =  Σ S_i · R

  Σ W_i · sin(α_i) - M_wall/R  =  (1/F) × Σ (c'_i · l_i + N'_i · tan(φ'_i))

  But this is wrong — the wall force is a RESTORING force, so it
  should be on the resisting side:

  Σ W_i · R · sin(α_i)  =  (1/F) × Σ (c'_i · l_i + N'_i · tan(φ'_i)) · R  +  M_wall

Solving for F:

            Σ (c'_i · l_i + N'_i · tan(φ'_i))
  F  =  ──────────────────────────────────────────
          Σ W_i · sin(α_i) - M_wall / R
```

**This is the critical insight: the wall moment reduces the effective driving moment in the denominator, rather than adding to the numerator (which would be divided by F).** The wall force is an applied external force at its full magnitude, not something that gets mobilised proportionally to F.

Now substituting the Bishop expression for N' (from v1 spec §6.2):

```
MODIFIED BISHOP SIMPLIFIED — FINAL FORM

            Σ [ (c'_i · b_i + (W_i - u_i · b_i) · tan(φ'_i)) / m_α(i) ]
  F  =  ─────────────────────────────────────────────────────────────────────
                Σ [ W_i · sin(α_i) ]  -  R_wall · (yc - y_app) / R

where m_α(i) = cos(α_i) + sin(α_i) · tan(φ'_i) / F

The ONLY change from the original Bishop equation is in the DENOMINATOR:
  - Original:  Σ W_i · sin(α_i)
  - Modified:  Σ W_i · sin(α_i)  -  R_wall · (yc - y_app) / R

Everything else — the numerator, the m_α function, the iteration
scheme — is identical.
```

> **Implementation note**: if multiple walls intersect the same slip circle, sum their contributions: `Σ R_wall_j × (yc - y_app_j) / R` for each wall j.

### 6.3 Iteration — nothing changes

The fixed-point iteration is identical. F appears only in m_α (in the numerator). The denominator is a constant for a given slip surface and wall configuration. The iteration:

```
1. Compute denominator:
     D = Σ W_i · sin(α_i) - Σ_j [ R_wall_j · (yc - y_app_j) / R ]

   Check: D must be > 0. If D ≤ 0, the wall alone stabilises the
   slope (the restoring moment exceeds the driving moment even
   without soil shear resistance). F → ∞. Report "stable by wall
   alone" and move to the next surface.

2. Iterate F exactly as before:
     F^{k+1} = numerator(F^k) / D

   Same convergence criteria, same under-relaxation, same everything.
```

---

## 7. Modified Spencer Equation

### 7.1 Wall force in moment equilibrium (F_m)

For circular surfaces, F_m is computed by the Bishop solver (as established in the Spencer spec §5.1). The modification is identical to §6.2 above — the wall moment reduces the denominator:

```
F_m = computeBishopF(slices, walls)

where computeBishopF now uses the modified denominator:
  D = Σ W_i · sin(α_i) - Σ_j [ R_wall_j · (yc - y_app_j) / R ]
```

### 7.2 Wall force in force equilibrium (F_f)

The Spencer force equilibrium propagates interslice forces from left to right. The wall force enters as an additional external horizontal force at the wall location. Specifically, at the slice immediately to the right of the wall, an extra horizontal force R_wall is applied.

```
In the propagateForces() function:

When processing the slice whose left edge is at x_wall
(the first slice to the right of the wall):

  E_left for this slice = E_right_previous + R_wall

That is, the wall force adds to the interslice force at the
wall boundary. The wall "pushes" the passive-side slices with
an additional horizontal force R_wall.

This is a one-line change in the propagation loop:

  for each slice s:
    let E_left = E_right_previous

    // Add wall force if this slice is at a wall
    if s.xL == wall.x (within tolerance):
      E_left += R_wall    // wall pushes this slice

    // ... rest of propagation unchanged ...

The force-equilibrium closure condition is still E_final = 0.
The wall force has been absorbed into the interslice force chain.
```

### 7.3 The outer solver is unchanged

The bisection on λ to find where F_m(λ) = F_f(λ) is identical. Both F_m and F_f now include the wall force, but the structure of the solver (bracket λ, evaluate g(λ) = F_m - F_f, bisect) does not change.

---

## 8. Modified Slice Builder

The slice builder from v1 spec §5 needs one addition: a mandatory slice cut at each wall x-position.

```
In buildSlices():

  // Add to the mandatory cut positions (Step 1):
  for each wall in model.walls:
    if wall.x > entry.x and wall.x < exit.x:
      cuts.add(wall.x)

That's it. The wall x-position becomes a slice edge, ensuring
that the wall force is applied at a clean slice boundary.

Additionally, tag the slice at the wall:
  for each slice s:
    for each wall in model.walls:
      if abs(s.xL - wall.x) < tolerance:
        s.wallOnLeft = wall
      if abs(s.xR - wall.x) < tolerance:
        s.wallOnRight = wall
```

---

## 9. Search Modifications

The search grid and search strategy from v1/v2 are unchanged. However, the presence of a wall shifts the critical slip surface. Two additional considerations:

### 9.1 Ensure the search captures wall-intersecting surfaces

The grid-radius search should include circles that intersect the wall at various depths. This happens naturally if the wall is within the slope extent, but verify that the search grid includes circle centres that produce intersections at all relevant wall depths.

### 9.2 Circles passing below the wall

These are deep-seated failures that the wall cannot prevent. They should be included in the search — in fact, they may become the new critical surface when the wall successfully prevents shallower failures. The solver handles them automatically: no wall intersection → no wall force → standard Bishop/Spencer.

### 9.3 Ranking

With walls, the ranking should distinguish between:
- Surfaces that intersect the wall (wall-stabilised F)
- Surfaces that pass below the wall (unstabilised F)

Report the critical surface for each category separately. The engineer needs to know both: "the wall raises the shallow critical F from 1.1 to 1.6, but there is a deep-seated surface at F = 1.25 that bypasses the wall."

```
struct SearchResultWithWalls {
  // ... existing fields ...
  criticalThroughWall: StabilityResult      // lowest F among wall-intersecting surfaces
  criticalBelowWall: StabilityResult        // lowest F among surfaces passing below wall
  criticalOverall: StabilityResult           // the absolute minimum F
  wallEffective: bool                        // true if the wall improves the overall F
}
```

---

## 10. Data Structures

```
// ── Wall definition ──

struct RetainingWall {
  x: float                // wall x-position (m)
  yTop: float             // top of wall (m)
  yTip: float             // bottom of wall (m)
  maxShearForce: float    // structural shear limit (kN/m), default Infinity
  passiveSide: enum { LEFT, RIGHT }  // which side develops passive pressure
}


// ── Wall intersection result (per slip circle) ──

struct WallIntersection {
  wall: RetainingWall
  y_intersect: float       // elevation where slip circle crosses the wall
  d_embedded: float        // depth below intersection to wall tip (m)
  R_passive: float         // passive resistance force (kN/m)
  R_wall: float            // governing wall force = min(R_passive, maxShear) (kN/m)
  y_application: float     // elevation where R_wall acts (m)
  moment_arm: float        // yc - y_application (m)
  M_wall: float            // R_wall × moment_arm (kN·m/m)
}


// ── Modified SlopeModel ──

struct SlopeModel {
  // ... existing fields ...
  walls: RetainingWall[]   // NEW: array of retaining walls
}


// ── Slice additions ──

struct Slice {
  // ... existing fields ...
  wallOnLeft: RetainingWall or null     // wall at left edge of this slice
  wallOnRight: RetainingWall or null    // wall at right edge of this slice
}
```

---

## 11. Complete Pseudocode

### 11.1 Wall intersection computation

```
function computeWallIntersections(
  circle: SlipCircle,
  walls: RetainingWall[],
  model: SlopeModel,
  entry: Point,
  exit: Point
) → WallIntersection[]:

  let intersections = []

  for each wall in walls:
    // Check if wall is within the sliding mass
    if wall.x <= entry.x or wall.x >= exit.x:
      continue

    // Check if circle reaches the wall
    let dx = wall.x - circle.xc
    if abs(dx) >= circle.R:
      continue    // wall outside circle

    // Compute intersection elevation (lower arc)
    let y_intersect = circle.yc - sqrt(circle.R² - dx²)

    // Check if intersection is within wall depth
    if y_intersect <= wall.yTip:
      continue    // circle passes below wall → no effect
    if y_intersect >= wall.yTop:
      continue    // circle passes above wall → no effect

    // Compute embedded depth below slip intersection
    let d = y_intersect - wall.yTip

    // Compute passive resistance
    // Get soil properties on the passive side at the wall location
    let soilAtWall = findRegionContaining(model.regions,
      {x: wall.x + 0.01 * (wall.passiveSide == RIGHT ? 1 : -1),
       y: (y_intersect + wall.yTip) / 2})

    let phi = toRadians(soilAtWall.soilType.phi_eff)
    let c = soilAtWall.soilType.c_eff
    let gamma = soilAtWall.soilType.gamma

    let Kp = tan(PI/4 + phi/2) ^ 2

    // Depth below terrain at wall location
    let yTerrain = terrainY(model.terrain, wall.x)
    let z_int = yTerrain - y_intersect    // depth of intersection
    let z_tip = yTerrain - wall.yTip      // depth of wall tip

    // Passive force over the depth range [z_int, z_tip]
    // Triangular component (friction): 0.5 · Kp · γ · (z_tip² - z_int²)
    // Uniform component (cohesion): 2 · c · sqrt(Kp) · d

    let R_passive = 0.5 * Kp * gamma * (z_tip*z_tip - z_int*z_int)
                  + 2.0 * c * sqrt(Kp) * d

    if R_passive <= 0:
      continue    // no passive resistance (shouldn't happen if d > 0 and φ > 0)

    // Governing force
    let R_wall = min(R_passive, wall.maxShearForce)

    // Point of application (1/3 above tip for triangular, simplification)
    let y_application = wall.yTip + d / 3.0

    // Moment arm to circle centre
    let moment_arm = circle.yc - y_application
    let M_wall = R_wall * moment_arm

    intersections.push(WallIntersection {
      wall: wall,
      y_intersect: y_intersect,
      d_embedded: d,
      R_passive: R_passive,
      R_wall: R_wall,
      y_application: y_application,
      moment_arm: moment_arm,
      M_wall: M_wall
    })

  return intersections
```

### 11.2 Modified Bishop solver

```
function computeBishopF(
  slices: Slice[],
  wallIntersections: WallIntersection[],    // NEW parameter
  circle: SlipCircle,                        // NEW parameter (for R)
  maxIter: int = 50,
  tolerance: float = 0.001
) → BishopResult:

  // ── Compute denominator (modified) ──
  let sumWsinAlpha = 0.0
  for each s in slices:
    sumWsinAlpha += s.W * sin(s.alpha)

  // Subtract wall moment contribution (divided by R)
  let wallMomentTerm = 0.0
  for each wi in wallIntersections:
    wallMomentTerm += wi.R_wall * (circle.yc - wi.y_application) / circle.R

  let denominator = sumWsinAlpha - wallMomentTerm

  // Check: if denominator ≤ 0, the wall alone stabilises the slope
  if denominator <= 0.001:
    return BishopResult {
      F: Infinity,
      converged: true,
      iterations: 0,
      wallStabilised: true,
      rejectReason: "Wall restoring moment exceeds driving moment"
    }

  // ── Fellenius initial guess (unchanged numerator) ──
  let felleniusNum = 0.0
  for each s in slices:
    let l = s.baseLength
    felleniusNum += s.c_eff * l + (s.W * cos(s.alpha) - s.u * l) * tan(s.phi_eff)

  let F = felleniusNum / denominator
  if F < 0.1: F = 1.0

  // ── Bishop iteration (ONLY the denominator changed) ──
  let prevChange = Infinity
  let useRelaxation = false

  for iter = 1 to maxIter:
    let numerator = 0.0
    let mAlphaOk = true

    for each s in slices:
      let mAlpha = cos(s.alpha) + sin(s.alpha) * tan(s.phi_eff) / F
      if mAlpha <= 0.0:
        mAlphaOk = false
        break

      let term = (s.c_eff * s.b + (s.W - s.u * s.b) * tan(s.phi_eff)) / mAlpha
      numerator += term

    if not mAlphaOk:
      return {F: F, converged: false, ...}

    let F_new = numerator / denominator    // ← modified denominator

    let change = abs(F_new - F)
    if change > prevChange and not useRelaxation:
      useRelaxation = true

    if useRelaxation:
      F = 0.5 * F_new + 0.5 * F
    else:
      F = F_new

    if change < tolerance:
      return {F: F, converged: true, iterations: iter, ...}

    prevChange = change

  return {F: F, converged: false, iterations: maxIter, ...}
```

### 11.3 Modified Spencer force propagation

```
function propagateForces(
  slices: Slice[],
  lambda: float,
  F_trial: float,
  wallIntersections: WallIntersection[]    // NEW parameter
) → {E_final, valid, sliceForces}:

  // Build a lookup: which slices have a wall force on their left edge
  let wallForceAtSlice = {}    // map: slice_index → R_wall
  for each wi in wallIntersections:
    for each s in slices:
      if abs(s.xL - wi.wall.x) < 1e-6:
        wallForceAtSlice[s.index] = wi.R_wall
        break

  let E_left = 0.0
  let forces = []
  let valid = true

  for each s in slices:
    // ── NEW: add wall force to interslice force at wall location ──
    if wallForceAtSlice contains s.index:
      E_left += wallForceAtSlice[s.index]

    // ... rest of propagation IDENTICAL to Spencer spec §7.2 ...
    // (compute N', E_right, S_mob using E_left, lambda, F_trial)

    let sinA = sin(s.alpha)
    let cosA = cos(s.alpha)
    let tanPhi = tan(s.phi_eff)
    let l = s.b / cosA
    let mAlpha = cosA + sinA * tanPhi / F_trial

    if abs(mAlpha) < 1e-10:
      valid = false
      break

    let a1 = -sinA + tanPhi * cosA / F_trial
    let a0 = E_left - s.u * s.b * (sinA / cosA) + s.c_eff * s.b / F_trial

    let denom_N = mAlpha + lambda * a1
    if abs(denom_N) < 1e-10:
      valid = false
      break

    let numer_N = s.W + lambda * E_left - lambda * a0
                  - s.u * s.b - s.c_eff * s.b * (sinA / cosA) / F_trial

    let N_eff = numer_N / denom_N
    let E_right = a0 + a1 * N_eff
    let S_mob = (s.c_eff * l + N_eff * tanPhi) / F_trial

    forces.push({N_eff, S_mob, E_right})
    E_left = E_right

  return {E_final: E_left, valid: valid, sliceForces: forces}
```

### 11.4 Modified search driver

```
function searchWithWalls(
  model: SlopeModel,
  searchConfig: SearchConfig,
  spencerConfig: SpencerConfig
) → SearchResultWithWalls:

  // The search loop is identical to v1/v2, but each trial surface
  // now computes wall intersections before calling the solver.

  // Inside the per-surface evaluation:

  for each trial circle:
    // ... validate (unchanged) ...
    // ... buildSlices (with wall cuts added) ...

    let wallInts = computeWallIntersections(circle, model.walls, model, entry, exit)

    // Bishop solve with wall force
    let bishopResult = computeBishopF(slices, wallInts, circle)

    // Tag whether this surface intersects a wall
    bishopResult.intersectsWall = wallInts.length > 0
    bishopResult.wallForces = wallInts

    // ... store result ...

  // After search: separate results by wall interaction
  let throughWall = results.filter(r → r.intersectsWall)
  let belowWall = results.filter(r → not r.intersectsWall)

  return SearchResultWithWalls {
    criticalThroughWall: throughWall.sortBy(r → r.F).first,
    criticalBelowWall: belowWall.sortBy(r → r.F).first,
    criticalOverall: results.sortBy(r → r.F).first,
    wallEffective: criticalThroughWall.F > criticalBelowWall.F
  }
```

---

## 12. Verification

### Test 1: Wall has no effect (circle below wall tip)

Place a 3 m deep wall on a 10 m slope. Run a search. Verify that slip circles passing below the wall tip produce the same F as the no-wall case. This confirms the wall force is correctly applied only when the circle intersects the wall.

### Test 2: Horizontal ground with wall (passive pressure check)

Flat ground, uniform soil (c' = 0, φ' = 30°, γ = 18 kN/m³), wall at x = 10 m with 5 m embedment. Force a specific slip circle that intersects the wall at 2 m depth. Hand-calculate R_passive over the 3 m below the intersection and verify the solver's R_wall matches:

```
Kp = tan²(60°) = 3.0
z_int = 2 m, z_tip = 5 m, d = 3 m
R_passive = 0.5 × 3.0 × 18 × (5² - 2²) = 0.5 × 3 × 18 × 21 = 567 kN/m
```

### Test 3: Slope with and without wall

Run the standard test slope (10 m, 2H:1V, c' = 10 kPa, φ' = 25°, γ = 18 kN/m³) from the v1 spec. Then add a wall at the toe. Verify:
- F increases (wall is stabilising)
- The critical surface shifts (may become deeper to bypass the wall)
- The through-wall critical F is higher than the no-wall critical F
- The below-wall critical F is identical to the no-wall case (if such surfaces exist)

### Test 4: Compare with commercial software

If access to SLOPE/W or SLIDE is available, model the same slope + wall configuration and compare F values. Agreement within 5% is expected.

---

## 13. Limitations & Future Extensions

### What v1 does NOT model

1. **Wall deformation**: the wall is infinitely stiff. No bending, no deflection, no soil-wall interaction. Use PLAXIS for this.
2. **Anchors / tiebacks**: additional restraining forces at specific elevations along the wall. Extension: each anchor is another horizontal (or inclined) force applied at a specific point, entering the equations the same way as R_wall.
3. **Inclined walls**: only vertical walls. Battered or inclined walls would require modifying the intersection geometry and the force direction.
4. **Wall base friction**: for gravity walls, base sliding resistance could be modelled as a horizontal friction force. Not included in v1.
5. **Non-circular surfaces**: a wall often forces the critical failure surface to be non-circular (composite: circular above, passing along the wall face, then circular below). This is a geometry extension, not a solver extension.

### Natural v2 extensions (in priority order)

1. **Anchors/tiebacks**: straightforward — each anchor is a force vector (magnitude, direction, application point) that enters the equilibrium exactly like R_wall but at an angle. Add the anchor's horizontal component to the Spencer force chain and its moment about the circle centre to the Bishop denominator.
2. **User-input wall force**: instead of computing R_passive, let the user directly specify R_wall and y_application. This is useful when the wall design is already done and the engineer just wants to check slope stability with the known wall capacity.
3. **Surcharge loads**: a distributed or point load on the terrain surface. Enters as an additional W (weight) on the affected slices. This is trivial — add the surcharge to the slice weight calculation.
4. **Non-circular composite surfaces**: allow the failure surface to follow the wall face for a segment, then resume as a circular arc. This requires a modified surface geometry (circle-line-circle composite) but uses the same Bishop/Spencer equations on each segment.

---

## 14. References

1. Duncan, J.M. & Wright, S.G. (2005). *Soil Strength and Slope Stability*. Wiley. Chapter 14: Reinforced slopes and embankments.
2. USACE (2003). *EM 1110-2-1902: Slope Stability*. Section on structural elements in limit equilibrium.
3. GeoStudio / Seequent (2024). SLOPE/W: Reinforcement and structural elements. Online documentation.
4. Rocscience (2024). SLIDE2: Support modelling. Online documentation.
5. EN 1997-1:2004. *Eurocode 7: Geotechnical design*. Section 9: Retaining structures.
6. FHWA (2001). *NHI-01-028*. Section on slope stabilisation with structural elements.
