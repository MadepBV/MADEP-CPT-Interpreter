# Stage 2.4 exact tension cut-off for Mohr-Coulomb plasticity

This note records the exact Stage `2.4` constitutive extension now implemented in the deformation
solver. It is intentionally narrow: it defines the drained small-strain Mohr-Coulomb tension
cut-off branch set that extends the exact Stage `2.3` shear face/edge/apex return.

The scope is the **local constitutive integration** only:

- exact tension-cut-off admissibility in principal effective stress space,
- exact backward-Euler return to the active tension branch,
- exact mixed shear-tension active sets,
- repeated-eigenvalue representative branches needed for robust projector recovery,
- consistent local branch tangents for the accepted tension state,
- solver/UI semantics so tension-governed zones are not misreported as `eta_MC = infinity`.

The note does **not** redefine the global nonlinear strategy. It extends the local model so the
global solver has a mathematically closed constitutive response near free surfaces and slope crests.

---

## 1. Governing surface

For the optional tension cut-off, the admissible domain includes:

\[
f_t = -\sigma'_3 - \sigma_t \le 0
\]

with:

- `sigma'_1 >= sigma'_2 >= sigma'_3` in compression-positive sign convention,
- `sigma_t >= 0`,
- default soil setting `sigma_t = 0`,
- upper bound

\[
\sigma_t \le \frac{c'}{\tan \phi'}
\]

when `phi' > 0`.

The implementation clamps the user input `sigmaTAllow` to this upper bound before the local branch
solve is formed.

---

## 2. Exact Stage 2.4 branch set

Only **one physical tension surface** exists in the exact model:

- `T3 : -sigma'_3 - sigma_t = 0`

The local active-set logic still needs several **branch kinds** because the projector recovery and
the reduced principal representation differ at repeated eigenvalues.

The exact Stage `2.4` branch set is:

1. `TENSION_FACE_T3`
   distinct-principal return to the single tension face.
2. `TENSION_EDGE_T23`
   lower repeated-eigenvalue tension return with `sigma'_2 = sigma'_3 = -sigma_t`.
3. `TENSION_EDGE_F13_T3`
   mixed shear-tension branch with active set `{F13, T3}`.
4. `TENSION_CORNER_S23_T3`
   lower repeated mixed corner with `sigma'_2 = sigma'_3` and active set `{F13, T3}`.
5. `TENSION_CORNER_S12_T3`
   upper repeated mixed corner with `sigma'_1 = sigma'_2` and active set `{F13, T3}`.
6. `TENSION_APEX_T123`
   triple repeated hydrostatic cut-off point with `sigma'_1 = sigma'_2 = sigma'_3 = -sigma_t`.

These are **branch identifiers**, not extra physical cutoff surfaces. The constitutive system still
uses one real tension criterion only.

---

## 3. Local return equations

For a chosen active set `A`, the exact backward-Euler return keeps the Stage `2.3` structure:

\[
\sigma' = \sigma'^{tr} - D^e \sum_{i \in A} \Delta \lambda_i m_i
\]

subject to:

\[
f_i(\sigma') = 0 \quad \forall i \in A
\]

\[
\Delta \lambda_i \ge 0 \quad \forall i \in A
\]

For a single-surface tension return, the active set is `{T3}`.

For mixed shear-tension returns, the active set is `{F13, T3}`.

The exact local solve is performed in principal space with the standard active-set coupling matrix:

\[
H_{ij} = n_i^T D_n m_j
\]

and right-hand side formed from the **branch-specific** trial surface values.

That last point matters. At repeated eigenvalues the representative branch definitions differ from
the generic distinct-stress formulas, so the active-set residual cannot be taken blindly from the
generic trial surface table.

---

## 4. Representative repeated-eigenvalue branches

The exact tension cut-off is simple as a physical surface, but repeated eigenvalues still require
care because the principal projectors and the representative surface gradients are not unique if one
keeps using the distinct-principal formulas directly.

The implemented representative principal gradients are:

### 4.1 Distinct tension face

\[
n_t = m_t = [0, 0, -1]
\]

### 4.2 Lower repeated tension branch

For `sigma'_2 = sigma'_3`, the single physical `T3` surface is represented in the repeated
subspace by:

\[
n_t = m_t = [0, -1/2, -1/2]
\]

### 4.3 Triple tension point

For `sigma'_1 = sigma'_2 = sigma'_3 = -sigma_t`, the representative branch uses:

\[
n_t = m_t = [-1/3, -1/3, -1/3]
\]

### 4.4 Mixed repeated shear-tension corners

At the lower mixed corner, the distinct `F13` shear face must also be replaced by its lower
repeated representative form:

\[
n_s = [1-\sin\phi,\ -\tfrac{1}{2}(1+\sin\phi),\ -\tfrac{1}{2}(1+\sin\phi)]
\]

\[
m_s = [1-\sin\psi,\ -\tfrac{1}{2}(1+\sin\psi),\ -\tfrac{1}{2}(1+\sin\psi)]
\]

At the upper mixed corner, the representative shear surface becomes:

\[
n_s = [\tfrac{1}{2}(1-\sin\phi),\ \tfrac{1}{2}(1-\sin\phi),\ -(1+\sin\phi)]
\]

\[
m_s = [\tfrac{1}{2}(1-\sin\psi),\ \tfrac{1}{2}(1-\sin\psi),\ -(1+\sin\psi)]
\]

These representative gradients are not a cosmetic change. They are what makes the exact local
branch solve robust when the trial state approaches repeated eigenvalues from different directions.

---

## 5. Admissibility and diagnostics

For exact Stage `2.4` states:

- `active_yield_surface = TENSION` whenever the accepted constitutive state is governed by the
  tension cut-off,
- `eta_MC` is not the governing admissibility measure in those zones,
- post-processing should therefore not report tension-governed elements as ordinary finite
  Mohr-Coulomb shear utilization.

The shipped implementation follows that rule:

- exact tension-cut-off states are labeled `state = tension-cutoff`,
- element summaries mark those zones as tension-cut-off-active,
- contour sampling suppresses `eta_MC` there,
- the UI reports `n/a (tension cut-off active)` instead of a fake infinite shear utilization.

---

## 6. Practical effect on geostatic plastic initialization

The main engineering value of Stage `2.4` is in the initial plastic self-weight equilibration of
slopes and free surfaces.

Before this extension, near-surface elements could enter a `tension pending` diagnostic state:

- the local trial stress was outside the admissible domain,
- but the constitutive model had no exact tension branch to return to,
- so the global solve could stall even when the visible failure mechanism looked geotechnically
  plausible.

With the exact Stage `2.4` branch set in place:

- the local constitutive problem is closed,
- the global solver can continue through free-surface tension activation,
- serviceable slopes are less likely to fail artificially during the initial gravity phase,
- truly unstable slopes are exposed more honestly because the model no longer borrows fictitious
  tensile effective strength.

---

## 7. Regression requirements

The implementation is only acceptable with branch-specific tests.

The verification suite now includes:

1. exact tension-face return,
2. lower repeated tension return,
3. mixed shear-tension edge return,
4. lower mixed shear-tension corner,
5. upper mixed shear-tension corner,
6. triple tension point,
7. tension-violating trial that still returns on a shear branch,
8. plastic-geostatic slope initialization with exact tension-cut-off activation.

Those regressions are the minimum needed to trust the implementation in a high-stakes engineering
workflow.
