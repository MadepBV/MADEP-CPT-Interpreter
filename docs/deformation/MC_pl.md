# MC_pl.md — Mohr–Coulomb Plasticity Implementation Specification

**Document status:** implementation specification, draft v0.1  
**Target:** current 2D small-strain finite-element deformation solver  
**Primary goal:** add a nonlinear/plasticity-ready architecture without blocking a later full Mohr–Coulomb elastoplastic implementation  
**Secondary goal:** provide a manageable Stage 1 pseudo-plastic implementation that already feeds Mohr–Coulomb exceedance back into the solve

---

## 1. Executive summary

The current solver is linear elastic with a post-processing Mohr–Coulomb check. In that architecture, Mohr–Coulomb utilization does not affect the displacement field, stress redistribution, settlement, or failure mechanism. The solver can report where strength is exceeded, but it cannot generate plastic zones or collapse mechanisms.

The required architectural change is to introduce a **material-point constitutive update** inside an **incremental-iterative nonlinear equilibrium solver**. The global solver must no longer assume:

\[
\mathbf{K}\mathbf{u}=\mathbf{F}
\]

with one fixed elastic stiffness. It must solve:

\[
\mathbf{R}(\mathbf{u})=\mathbf{F}_{ext}-\mathbf{F}_{int}(\mathbf{u})=\mathbf{0}
\]

where:

\[
\mathbf{F}_{int}=\sum_e \int_{\Omega_e}\mathbf{B}^T\boldsymbol{\sigma}'\,d\Omega
\]

and the material model supplies both:

\[
\boldsymbol{\sigma}'
\]

and a tangent stiffness:

\[
\mathbf{D}_{tan}
\]

for every triangle or Gauss point.

The implementation should be staged:

1. **Refactor first**: create `MaterialModel.update()` and material-point state storage.
2. **Stage 1**: implement `MohrCoulombReducedStiffnessMaterial`, where MC exceedance activates a reduced shear stiffness. This is not true plasticity, but it makes incremental loading mechanically meaningful.
3. **Stage 2**: replace the Stage 1 material update with true elastoplastic return mapping. The global solver, material-point state management, commit/rollback logic, and visualization should remain the same.

The non-negotiable design point is:

\[
\boxed{\text{Stage 1 must be a material model plugged into the nonlinear solver, not a solver-level hack.}}
\]

---

## 2. Scope and non-scope

### 2.1 In scope

- Small-strain finite-element formulation.
- Plane strain geotechnical analysis, with full 3D stress state retained for Mohr–Coulomb evaluation.
- Effective-stress Mohr–Coulomb formulation.
- Incremental loading and nonlinear iterations.
- Material-point state storage, trial state, committed state, and rollback.
- Stage 1 reduced-stiffness pseudo-plasticity.
- Stage 2 true Mohr–Coulomb elastoplasticity by return mapping.
- Non-associated flow using dilation angle \(\psi\).
- Optional tension cut-off.
- Optional compression/yield stress logic using \(E_{oed}\), \(E_{ur}\), and \(\sigma'_Y\), kept separate from MC shear yield.

### 2.2 Out of scope for first implementation

- Large-deformation kinematics.
- Coupled consolidation and pore-pressure diffusion.
- Strain-softening and post-peak mesh-objective regularization.
- Shear band thickness regularization.
- Unsaturated soil mechanics.
- Dynamic loading.
- Automatic global slope factor of safety, unless a separate strength-reduction analysis driver is implemented.

---

## 3. Sign convention and notation

### 3.1 Sign convention

This specification uses **compression-positive effective stress**, which is the most convenient convention for geotechnical Mohr–Coulomb calculations.

Principal effective stresses are ordered as:

\[
\sigma'_1 \geq \sigma'_2 \geq \sigma'_3
\]

where \(\sigma'_1\) is the major compressive principal effective stress and \(\sigma'_3\) is the minor compressive principal effective stress.

If the existing finite-element code uses tension-positive stress internally, introduce a sign adapter at the material boundary:

\[
\boldsymbol{\sigma}'_{compression}= -\boldsymbol{\sigma}'_{tension}
\]

The Mohr–Coulomb model should evaluate and update stresses in one internal convention only. Do not mix conventions inside the material routine.

### 3.2 Effective stress

The material model should operate on effective stress:

\[
\boldsymbol{\sigma}' = \boldsymbol{\sigma} - u\mathbf{I}
\]

where \(u\) is pore pressure and \(\mathbf{I}\) is the identity tensor. If pore pressure is not modeled, use \(u=0\). If pore pressures are known from an external field, apply them before evaluating Mohr–Coulomb.

### 3.3 Core symbols

| Symbol | Meaning |
|---|---|
| \(\mathbf{u}\) | nodal displacement vector |
| \(\mathbf{F}_{ext}\) | external nodal force vector |
| \(\mathbf{F}_{int}\) | internal nodal force vector |
| \(\mathbf{R}\) | residual force vector |
| \(\mathbf{B}\) | strain-displacement matrix |
| \(\boldsymbol{\epsilon}\) | total strain vector/tensor |
| \(\boldsymbol{\epsilon}^e\) | elastic strain |
| \(\boldsymbol{\epsilon}^p\) | plastic strain |
| \(\boldsymbol{\sigma}'\) | effective stress tensor/vector |
| \(\mathbf{D}^e\) | elastic stiffness matrix |
| \(\mathbf{D}_{tan}\) | tangent stiffness returned by material routine |
| \(c'\) | effective cohesion |
| \(\phi'\) | effective friction angle |
| \(\psi\) | dilation angle |
| \(f\) | yield function |
| \(g\) | plastic potential |
| \(\Delta\lambda\) | plastic multiplier increment |
| \(\eta_{MC}\) | Mohr–Coulomb utilization ratio |

---

## 4. High-level implementation plan

### Phase 0 — preserve existing linear elastic behavior

Before adding nonlinear behavior, refactor the existing elastic solver so that linear elasticity also goes through a material interface:

```text
MaterialModel.update(strain_trial, committed_state, params)
    -> stress_trial
    -> tangent_matrix
    -> trial_state
    -> diagnostics
```

Definition of done:

- Existing linear elastic solutions remain numerically unchanged.
- Existing Mohr–Coulomb post-check can be reproduced from `diagnostics.eta_MC`.
- Element assembly no longer hardcodes one global elastic matrix directly.

### Phase 1 — material-point state infrastructure

Create a state object for every triangle or Gauss point.

For constant-strain triangles, one material point per triangle is acceptable. The data model should still be named as a **material point**, not a triangle state, so later Gauss integration does not require a conceptual rewrite.

Required state variables:

```text
MaterialPointState:
    total_strain_6              // full 3D Voigt strain, engineering shear convention
    plastic_strain_6            // zero in Stage 1, active in Stage 2
    effective_stress_6          // full 3D effective stress
    active_yield_surface        // NONE / MC_SHEAR / TENSION / COMPRESSION_CAP
    currently_MC_active         // active in current trial state
    has_ever_exceeded_MC        // diagnostic history only
    eta_MC_current              // diagnostic
    eta_MC_max_history          // diagnostic
    sigmaY                      // optional compression/preconsolidation stress
    hardening_variable          // reserved for later hardening/softening
    accumulated_plastic_strain  // zero in Stage 1, active in Stage 2
```

Use two copies of state:

```text
committed_state  // last converged state
test_state       // temporary state during current nonlinear iteration
```

Only commit test states after global convergence.

### Phase 2 — nonlinear residual solver

Move from direct linear solving to residual equilibrium:

\[
\mathbf{R}=\mathbf{F}_{ext}-\mathbf{F}_{int}
\]

with tangent solve:

\[
\mathbf{K}_{tan}\delta\mathbf{u}=\mathbf{R}
\]

Element-level quantities for a constant-strain triangle:

\[
\mathbf{F}_{int,e}=\mathbf{B}^T\boldsymbol{\sigma}'_{2D} A_e t
\]

\[
\mathbf{K}_{tan,e}=\mathbf{B}^T\mathbf{D}_{tan,2D}\mathbf{B}A_e t
\]

where \(A_e\) is the triangle area and \(t\) is the out-of-plane thickness.

Definition of done:

- Linear elastic model converges in one Newton iteration.
- Residual norm falls to machine tolerance for linear elastic cases.
- Commit/rollback works when a load step is rejected.

### Phase 3 — Stage 1 material: reduced-stiffness MC exceedance

Implement a material model that uses Mohr–Coulomb exceedance during assembly:

\[
f_{MC}>0 \Rightarrow \text{use reduced shear stiffness}
\]

This is not full plasticity. It is a pseudo-plastic active-set method.

Definition of done:

- If no point exceeds Mohr–Coulomb, result equals linear elastic solution.
- If points exceed Mohr–Coulomb, those points return a reduced shear tangent.
- Displacement and stress fields change relative to pure linear elastic analysis.
- `has_ever_exceeded_MC` is diagnostic only; it must not permanently damage stiffness unless a separate damage model is intentionally enabled.

### Phase 4 — Stage 2 material: true Mohr–Coulomb elastoplasticity

Replace the Stage 1 material update with a return-mapping stress update.

Definition of done:

- Elastic trial states inside the yield surface remain elastic.
- Trial states outside the yield surface are returned to \(f_{MC}=0\).
- Plastic strain increments are stored.
- The global solver assembles internal force from the corrected stress.
- Tangent stiffness is elastoplastic, not merely reduced elastic stiffness.

### Phase 5 — optional strength-reduction analysis driver

Do not embed global slope factor-of-safety logic inside the material law.

If needed, create a separate analysis driver:

\[
c'_r=\frac{c'}{F}
\]

\[
\tan\phi'_r=\frac{\tan\phi'}{F}
\]

\[
\phi'_r=\arctan\left(\frac{\tan\phi'}{F}\right)
\]

Then solve repeatedly for increasing \(F\). This is a driver-level analysis, not a constitutive update.

---

## 5. Finite-element theory

### 5.1 Small-strain kinematics

For small strain:

\[
\boldsymbol{\epsilon}=\frac{1}{2}\left(\nabla\mathbf{u}+\nabla\mathbf{u}^T\right)
\]

For a 2D element using engineering shear strain:

\[
\boldsymbol{\epsilon}_{2D}
=
\begin{bmatrix}
\epsilon_{xx} \\
\epsilon_{yy} \\
\gamma_{xy}
\end{bmatrix}
=
\mathbf{B}\mathbf{u}_e
\]

For plane strain, lift this to full 3D Voigt strain:

\[
\boldsymbol{\epsilon}_{6}
=
\begin{bmatrix}
\epsilon_{xx} \\
\epsilon_{yy} \\
\epsilon_{zz} \\
\gamma_{xy} \\
\gamma_{yz} \\
\gamma_{xz}
\end{bmatrix}
=
\begin{bmatrix}
\epsilon_{xx} \\
\epsilon_{yy} \\
0 \\
\gamma_{xy} \\
0 \\
0
\end{bmatrix}
\]

The global 2D element only has \(x,y\) displacement degrees of freedom, but the material model must retain \(\sigma'_{zz}\) for the Mohr–Coulomb check.

### 5.1.1 Voigt mapping and work conjugacy

This specification uses **engineering shear strain**:

\[
\gamma_{xy}=2\epsilon_{xy}
\]

Therefore the implementation must **not** use one generic `tensor_to_voigt()` helper for every tensor-like quantity.

Use separate mappings:

\[
\boldsymbol{\sigma}_{v}=
\begin{bmatrix}
\sigma_{xx} \\
\sigma_{yy} \\
\sigma_{zz} \\
\tau_{xy} \\
\tau_{yz} \\
\tau_{xz}
\end{bmatrix}
\]

\[
\boldsymbol{\epsilon}_{v}=
\begin{bmatrix}
\epsilon_{xx} \\
\epsilon_{yy} \\
\epsilon_{zz} \\
\gamma_{xy} \\
\gamma_{yz} \\
\gamma_{xz}
\end{bmatrix}
=
\begin{bmatrix}
\epsilon_{xx} \\
\epsilon_{yy} \\
\epsilon_{zz} \\
2\epsilon_{xy} \\
2\epsilon_{yz} \\
2\epsilon_{xz}
\end{bmatrix}
\]

\[
\mathbf{n}_{v}=
\begin{bmatrix}
n_{xx} \\
n_{yy} \\
n_{zz} \\
2n_{xy} \\
2n_{yz} \\
2n_{xz}
\end{bmatrix},
\qquad
\mathbf{m}_{v}=
\begin{bmatrix}
m_{xx} \\
m_{yy} \\
m_{zz} \\
2m_{xy} \\
2m_{yz} \\
2m_{xz}
\end{bmatrix}
\]

The doubled shear terms in \(\mathbf{n}_v\) and \(\mathbf{m}_v\) are required to preserve work conjugacy:

\[
\mathbf{n}_{tensor}:\Delta\boldsymbol{\sigma}_{tensor}
=
\mathbf{n}_{v}^{T}\Delta\boldsymbol{\sigma}_{v}
\]

Recommended helper contract:

```text
stress_tensor_to_voigt(T)
strain_tensor_to_voigt(E)
gradient_tensor_to_voigt(G)
stress_voigt_to_tensor(v)
strain_voigt_to_tensor(v)
```

For invariant calculations involving two strain-like engineering-Voigt vectors, do not use a raw Euclidean dot product. Use the weighted contraction:

\[
\mathbf{a}:\mathbf{b}
=
\mathbf{a}_{v}^{T}\mathbf{W}\mathbf{b}_{v}
\]

with:

\[
\mathbf{W}=
\operatorname{diag}\left(1,1,1,\frac12,\frac12,\frac12\right)
\]

### 5.2 Internal force

The weak form leads to:

\[
\mathbf{F}_{int}=\sum_e\int_{\Omega_e}\mathbf{B}^T\boldsymbol{\sigma}'_{2D}\,d\Omega
\]

For constant-strain triangles:

\[
\mathbf{F}_{int,e}=\mathbf{B}^T\boldsymbol{\sigma}'_{2D}A_et
\]

where:

\[
\boldsymbol{\sigma}'_{2D}=\begin{bmatrix}\sigma'_{xx} & \sigma'_{yy} & \tau'_{xy}\end{bmatrix}^T
\]

### 5.3 Tangent stiffness

The tangent stiffness is:

\[
\mathbf{K}_{tan}=\sum_e\int_{\Omega_e}\mathbf{B}^T\mathbf{D}_{tan,2D}\mathbf{B}\,d\Omega
\]

For constant-strain triangles:

\[
\mathbf{K}_{tan,e}=\mathbf{B}^T\mathbf{D}_{tan,2D}\mathbf{B}A_et
\]

The tangent \(\mathbf{D}_{tan}\) must be provided by the material model.

---

## 6. Elasticity model

### 6.1 Isotropic elastic constants

Use:

\[
G=\frac{E}{2(1+\nu)}
\]

\[
K=\frac{E}{3(1-2\nu)}
\]

\[
\lambda=K-\frac{2G}{3}=\frac{E\nu}{(1+\nu)(1-2\nu)}
\]

where \(G\) is shear modulus, \(K\) is bulk modulus, and \(\lambda\) is the Lamé constant.

The inverse relations are:

\[
E=\frac{9KG}{3K+G}
\]

\[
\nu=\frac{3K-2G}{2(3K+G)}
\]

### 6.2 Full 3D elastic stiffness

Using Voigt notation:

\[
\boldsymbol{\sigma}
=
\begin{bmatrix}
\sigma_{xx} \\
\sigma_{yy} \\
\sigma_{zz} \\
\tau_{xy} \\
\tau_{yz} \\
\tau_{xz}
\end{bmatrix},
\quad
\boldsymbol{\epsilon}
=
\begin{bmatrix}
\epsilon_{xx} \\
\epsilon_{yy} \\
\epsilon_{zz} \\
\gamma_{xy} \\
\gamma_{yz} \\
\gamma_{xz}
\end{bmatrix}
\]

with engineering shear strains, the 3D elastic matrix is:

\[
\mathbf{D}^e =
\begin{bmatrix}
\lambda+2G & \lambda & \lambda & 0 & 0 & 0 \\
\lambda & \lambda+2G & \lambda & 0 & 0 & 0 \\
\lambda & \lambda & \lambda+2G & 0 & 0 & 0 \\
0 & 0 & 0 & G & 0 & 0 \\
0 & 0 & 0 & 0 & G & 0 \\
0 & 0 & 0 & 0 & 0 & G
\end{bmatrix}
\]

### 6.3 Plane strain elastic stiffness

For plane strain:

\[
\epsilon_{zz}=0
\]

but:

\[
\sigma'_{zz}\neq 0
\]

The 2D plane strain stiffness used in element assembly is:

\[
\mathbf{D}^e_{2D}=\begin{bmatrix}
\lambda+2G & \lambda & 0 \\
\lambda & \lambda+2G & 0 \\
0 & 0 & G
\end{bmatrix}
\]

The out-of-plane stress must be updated **incrementally**:

\[
\Delta\sigma'_{zz}=\lambda(\Delta\epsilon_{xx}+\Delta\epsilon_{yy})
\]

\[
\sigma'_{zz,n+1}=\sigma'_{zz,n}+\Delta\sigma'_{zz}
\]

For a purely elastic calculation started from a zero-stress state, this reduces to:

\[
\sigma'_{zz}=\lambda(\epsilon_{xx}+\epsilon_{yy})
\]

But geotechnical analyses normally start from a nonzero geostatic stress state, so the incremental form is the one that must be used in code. In elastoplastic increments, \(\sigma'_{zz}\) must be updated consistently by the constitutive routine, not recomputed from a zero-stress assumption.

---

## 7. Mohr–Coulomb yield theory

### 7.1 Classical shear yield function

For compression-positive principal effective stresses:

\[
\sigma'_1\geq\sigma'_2\geq\sigma'_3
\]

use the Mohr–Coulomb shear yield function:

\[
f_s
=
(\sigma'_1-\sigma'_3)
-
(\sigma'_1+\sigma'_3)\sin\phi'
-
2c'\cos\phi'
\]

Elastic admissibility:

\[
f_s\leq 0
\]

Yield condition:

\[
f_s=0
\]

In equivalent bearing-capacity form:

\[
N_\phi=\frac{1+\sin\phi'}{1-\sin\phi'}
\]

\[
f_s^*=\sigma'_1-N_\phi\sigma'_3-2c'\sqrt{N_\phi}
\]

where \(f_s=0\) and \(f_s^*=0\) define the same surface, up to a positive scaling.

### 7.2 Utilization ratio

For diagnostics, define:

\[
\eta_{MC}
=
\frac{\sigma'_1-\sigma'_3}
{(\sigma'_1+\sigma'_3)\sin\phi' + 2c'\cos\phi'}
\]

provided the denominator is positive and sufficiently large.

Interpretation:

\[
\eta_{MC}<1 \quad \text{inside envelope}
\]

\[
\eta_{MC}=1 \quad \text{on yield envelope}
\]

\[
\eta_{MC}>1 \quad \text{elastic trial stress exceeds MC strength}
\]

A local strength reserve can be reported as:

\[
F_{local}=\frac{1}{\eta_{MC}}
\]

This is **not** a global slope factor of safety. It is a pointwise reserve ratio.

### 7.3 Optional tension cut-off

Classical Mohr–Coulomb can imply tensile capacity that is unrealistic for soils. An optional tension cutoff may be used:

\[
f_t=-\sigma'_3-\sigma_t\leq 0
\]

where \(\sigma_t\geq0\) is the allowable tensile strength. For no tensile strength, use:

\[
\sigma_t=0
\]

A common upper bound for Mohr–Coulomb tensile strength is:

\[
\sigma_t \leq \frac{c'}{\tan\phi'}
\]

Do not implement tension cutoff inside Stage 1 unless the UI and tests explicitly include it. Stage 2 should reserve the `active_yield_surface` flag for `MC_SHEAR` and `TENSION`.

---

## 8. Plastic flow theory

### 8.1 Additive strain split

Small-strain plasticity uses:

\[
\boldsymbol{\epsilon}=\boldsymbol{\epsilon}^e+\boldsymbol{\epsilon}^p
\]

The stress is computed from elastic strain:

\[
\boldsymbol{\sigma}'=\mathbf{D}^e(\boldsymbol{\epsilon}-\boldsymbol{\epsilon}^p)
\]

### 8.2 Non-associated plastic potential

For soils, Mohr–Coulomb is normally used with non-associated flow:

\[
\psi \leq \phi'
\]

where \(\psi\) is the dilation angle. The associated case is:

\[
\psi=\phi'
\]

A suitable shear plastic potential is:

\[
g_s
=
(\sigma'_1-\sigma'_3)
-
(\sigma'_1+\sigma'_3)\sin\psi
\]

Only the gradient of \(g_s\) matters for plastic flow. Equivalently:

\[
g_s^*=\sigma'_1-N_\psi\sigma'_3
\]

with:

\[
N_\psi=\frac{1+\sin\psi}{1-\sin\psi}
\]

### 8.3 Flow rule

The plastic strain increment is:

\[
\Delta\boldsymbol{\epsilon}^p
=
\Delta\lambda\frac{\partial g}{\partial\boldsymbol{\sigma}'}
=
\Delta\lambda\mathbf{m}
\]

where:

\[
\mathbf{m}=\frac{\partial g}{\partial\boldsymbol{\sigma}'}
\]

### 8.4 Yield normal

Define:

\[
\mathbf{n}=\frac{\partial f}{\partial\boldsymbol{\sigma}'}
\]

For the smooth part of the MC surface, using principal stress projectors \(\mathbf{P}_1\) and \(\mathbf{P}_3\):

\[
\mathbf{n}=(1-\sin\phi')\mathbf{P}_1-(1+\sin\phi')\mathbf{P}_3
\]

\[
\mathbf{m}=(1-\sin\psi)\mathbf{P}_1-(1+\sin\psi)\mathbf{P}_3
\]

where:

\[
\mathbf{P}_i=\mathbf{v}_i\otimes\mathbf{v}_i
\]

and \(\mathbf{v}_i\) is the eigenvector associated with \(\sigma'_i\).

When represented in engineering Voigt notation, \(\mathbf{n}\) and \(\mathbf{m}\) are **gradient-like** vectors and therefore must carry doubled shear terms exactly as defined in §5.1.1. This affects both:

\[
\Delta\boldsymbol{\epsilon}^p=\Delta\lambda\mathbf{m}
\]

and:

\[
\mathbf{n}^T\mathbf{D}^e\mathbf{m}
\]

At corners, edges, and repeated principal stresses, the gradient is not unique. Stage 2 must either:

1. use a smoothed Mohr–Coulomb approximation, or
2. implement exact multisurface return mapping with active-set/corner handling.

### 8.5 Kuhn–Tucker conditions

For rate-independent perfect plasticity:

\[
\Delta\lambda\geq0
\]

\[
f(\boldsymbol{\sigma}'_{n+1})\leq0
\]

\[
\Delta\lambda f(\boldsymbol{\sigma}'_{n+1})=0
\]

For plastic loading:

\[
f(\boldsymbol{\sigma}'_{n+1})=0
\]

### 8.6 Stress update

Elastic trial stress:

\[
\boldsymbol{\sigma}'_{trial}
=
\boldsymbol{\sigma}'_n
+
\mathbf{D}^e\Delta\boldsymbol{\epsilon}
\]

If:

\[
f(\boldsymbol{\sigma}'_{trial})\leq0
\]

then:

\[
\boldsymbol{\sigma}'_{n+1}=\boldsymbol{\sigma}'_{trial}
\]

\[
\Delta\boldsymbol{\epsilon}^p=\mathbf{0}
\]

If:

\[
f(\boldsymbol{\sigma}'_{trial})>0
\]

then return mapping is required:

\[
\boldsymbol{\sigma}'_{n+1}
=
\boldsymbol{\sigma}'_{trial}
-
\mathbf{D}^e\Delta\boldsymbol{\epsilon}^p
\]

\[
\boldsymbol{\sigma}'_{n+1}
=
\boldsymbol{\sigma}'_{trial}
-
\Delta\lambda\mathbf{D}^e\mathbf{m}_{n+1}
\]

and the corrected stress must satisfy:

\[
f(\boldsymbol{\sigma}'_{n+1})=0
\]

### 8.7 Elastoplastic tangent

For a single smooth yield surface, the continuum elastoplastic tangent is:

\[
\mathbf{D}_{ep}
=
\mathbf{D}^e
-
\frac{\mathbf{D}^e\mathbf{m}\mathbf{n}^T\mathbf{D}^e}
{\mathbf{n}^T\mathbf{D}^e\mathbf{m}+H}
\]

where \(H\) is the hardening modulus. For perfect plasticity:

\[
H=0
\]

For non-associated flow:

\[
\mathbf{m}\neq\mathbf{n}
\]

so \(\mathbf{D}_{ep}\) is generally **non-symmetric**. The global linear solver must therefore support non-symmetric tangent matrices, or the code must deliberately use a symmetric approximation with the expectation of weaker Newton convergence.

A fully consistent algorithmic tangent should be implemented later. Simo and Taylor's consistent tangent framework is the reference model for this.

---

## 9. Stage 1 reduced-stiffness pseudo-plasticity

### 9.1 Purpose

Stage 1 exists to make the load increments mechanically meaningful before full plasticity is implemented.

Current behavior:

\[
\eta_{MC}\text{ is output only}
\]

Stage 1 behavior:

\[
\eta_{MC}\text{ changes the material tangent used during assembly}
\]

### 9.2 Reduced shear stiffness

Given elastic \(K\) and \(G\), define:

\[
G_{red}=rG
\]

where:

\[
0<r<1
\]

Recommended first range:

\[
r=0.02\text{ to }0.10
\]

Usually keep bulk stiffness unchanged:

\[
K_{red}=K
\]

Then construct a reduced stiffness matrix from \(K_{red}\) and \(G_{red}\).

If the existing code can assemble from \(K\) and \(G\), do that directly. If it requires \(E,\nu\), reconstruct:

\[
E_{red}=\frac{9K_{red}G_{red}}{3K_{red}+G_{red}}
\]

\[
\nu_{red}=\frac{3K_{red}-2G_{red}}{2(3K_{red}+G_{red})}
\]

Warning: as \(G_{red}\to0\), \(\nu_{red}\to0.5\). This can cause locking or ill-conditioning in plane strain. Prefer direct \(K,G\)-based stiffness assembly.

### 9.3 Active-state logic

Use two separate state fields:

```text
currently_MC_active   // affects tangent in current trial state
has_ever_exceeded_MC  // diagnostic history only
```

Do **not** use `has_ever_exceeded_MC` to permanently reduce stiffness unless a deliberate damage model is added. True plasticity does not mean a material point has zero stiffness forever; unloading and reloading still occur around the plastic strain state.

### 9.4 Stage 1 stress update

Stage 1 does not enforce:

\[
f_{MC}=0
\]

It only changes the tangent and stress increment when the elastic trial stress exceeds MC.

A simple Stage 1 update is:

1. Compute elastic trial stress.
2. Evaluate \(f_{MC}\) and \(\eta_{MC}\).
3. If \(f_{MC}\leq0\), return elastic stress and elastic tangent.
4. If \(f_{MC}>0\), recompute the stress increment with reduced shear stiffness and return reduced tangent.

This gives deformation feedback but does not compute plastic strain.

### 9.5 Stage 1 limitations

Stage 1 should be described in UI/documentation as one of:

- `MC-active reduced-stiffness model`
- `strength-exceeded reduced-stiffness zone`
- `pseudo-plastic MC-active zone`

Do not call Stage 1 output `plastic strain` because no plastic strain is computed.

---

## 10. Stage 2 true Mohr–Coulomb plasticity

### 10.1 Recommended first true-plastic route

Mohr–Coulomb has a non-smooth hexagonal-pyramid yield surface in principal stress space. The corners, edges, and apex introduce algorithmic difficulty because the yield gradient is not unique.

There are two viable approaches:

### Option A — smoothed Mohr–Coulomb, recommended first

Use a rounded/smoothed approximation of Mohr–Coulomb. This avoids undefined gradients and allows a standard single-surface return-mapping implementation.

Advantages:

- easier implementation,
- better Newton robustness,
- differentiable gradients,
- easier tangent calculation.

Disadvantages:

- not exactly classical Mohr–Coulomb,
- requires smoothing parameters.

### Option B — exact multisurface Mohr–Coulomb

Implement exact MC with active-set return to:

- smooth face,
- edge,
- apex,
- tension cutoff if enabled.

Advantages:

- exact classical MC geometry.

Disadvantages:

- more complex,
- corner handling required,
- tangent construction more difficult.

For this project, the safest sequence is:

```text
Stage 2.1: smoothed MC or Drucker-Prager test plasticity
Stage 2.2: exact MC face return
Stage 2.3: MC edge/apex active-set return
Stage 2.4: optional tension cut-off
```

### 10.2 Backward-Euler return mapping

Use backward Euler integration:

\[
\boldsymbol{\epsilon}^p_{n+1}
=
\boldsymbol{\epsilon}^p_n
+
\Delta\lambda\mathbf{m}_{n+1}
\]

\[
\boldsymbol{\sigma}'_{n+1}
=
\boldsymbol{\sigma}'_{trial}
-
\Delta\lambda\mathbf{D}^e\mathbf{m}_{n+1}
\]

\[
f(\boldsymbol{\sigma}'_{n+1})=0
\]

The local unknowns are:

\[
\boldsymbol{\sigma}'_{n+1},\Delta\lambda
\]

The local residual is:

\[
\mathbf{r}_{\sigma}
=
\boldsymbol{\sigma}'_{n+1}
-
\boldsymbol{\sigma}'_{trial}
+
\Delta\lambda\mathbf{D}^e\mathbf{m}_{n+1}
\]

\[
r_f=f(\boldsymbol{\sigma}'_{n+1})
\]

Solve:

\[
\begin{bmatrix}
\mathbf{r}_{\sigma} \\
r_f
\end{bmatrix}
=
\mathbf{0}
\]

by local Newton iteration.

### 10.3 Simpler first local corrector

A simpler cutting-plane corrector may be used first **only for a smoothed Mohr–Coulomb or Drucker–Prager-like surface**:

Given \(\boldsymbol{\sigma}^{(k)}\), compute:

\[
f^{(k)}=f(\boldsymbol{\sigma}^{(k)})
\]

\[
\mathbf{n}^{(k)}=\frac{\partial f}{\partial\boldsymbol{\sigma}'}\bigg|_{\boldsymbol{\sigma}^{(k)}}
\]

\[
\mathbf{m}^{(k)}=\frac{\partial g}{\partial\boldsymbol{\sigma}'}\bigg|_{\boldsymbol{\sigma}^{(k)}}
\]

where \(\mathbf{n}^{(k)}\) and \(\mathbf{m}^{(k)}\) are the work-conjugate engineering-Voigt gradients from §5.1.1.

\[
\delta\lambda^{(k)}
=
\frac{f^{(k)}}{(\mathbf{n}^{(k)})^T\mathbf{D}^e\mathbf{m}^{(k)}+H}
\]

\[
\boldsymbol{\sigma}^{(k+1)}
=
\boldsymbol{\sigma}^{(k)}
-
\delta\lambda^{(k)}\mathbf{D}^e\mathbf{m}^{(k)}
\]

Repeat until:

\[
|f^{(k)}| \leq \text{tol}_{local}
\]

This is easier but less robust than a fully consistent implicit return mapping.

For **exact** cornered Mohr–Coulomb, the cutting-plane iteration can oscillate across adjacent faces near edges or the apex because the surface normal changes discontinuously. Therefore:

- acceptable first use: smoothed MC / rounded MC / Drucker–Prager shakedown;
- not recommended: exact MC face-edge-apex return;
- preferred exact-MC route: local active-set backward-Euler return mapping.

### 10.4 Plastic strain update

After convergence:

\[
\Delta\boldsymbol{\epsilon}^p
=
\sum_k \delta\lambda^{(k)}\mathbf{m}^{(k)}
\]

or, for fully implicit backward Euler:

\[
\Delta\boldsymbol{\epsilon}^p
=
\Delta\lambda\mathbf{m}_{n+1}
\]

Then:

\[
\boldsymbol{\epsilon}^p_{n+1}
=
\boldsymbol{\epsilon}^p_n+\Delta\boldsymbol{\epsilon}^p
\]

### 10.5 Equivalent plastic strain diagnostic

For visualization, define an accumulated equivalent plastic strain. One common shear-type measure is:

\[
\Delta\bar{\epsilon}^p
=
\sqrt{\frac{2}{3}\Delta\boldsymbol{\epsilon}^p_{dev}:\Delta\boldsymbol{\epsilon}^p_{dev}}
\]

In engineering Voigt notation, do not evaluate this with a raw Euclidean norm. Use the weighted contraction from §5.1.1:

\[
\Delta\bar{\epsilon}^p
=
\sqrt{
\frac{2}{3}
\left(\Delta\boldsymbol{\epsilon}^p_{dev,v}\right)^T
\mathbf{W}
\left(\Delta\boldsymbol{\epsilon}^p_{dev,v}\right)
}
\]

Then:

\[
\bar{\epsilon}^p_{n+1}=\bar{\epsilon}^p_n+\Delta\bar{\epsilon}^p
\]

This is a diagnostic measure and should not be confused with settlement strain or volumetric plastic strain.

---

## 11. Optional compression-yield settlement module

This module is separate from Mohr–Coulomb shear plasticity.

It is also **out of scope for Stage 1** and should remain out of the first true-MC implementation unless a full tangent mapping is explicitly defined. The bilinear compression logic below is 1D vertical settlement logic; it is not yet a full multidimensional constitutive law.

### 11.1 Parameters

Use:

\[
E_{oed}=M_{oed}
\]

as the constrained oedometric modulus.

Use:

\[
M_{ur}=3M_{oed}
\]

as a practical unloading/reloading constrained modulus, if no better data is available.

If the global elastic model needs Young's modulus \(E\), convert from constrained modulus \(M\):

\[
M=\frac{E(1-\nu)}{(1+\nu)(1-2\nu)}
\]

\[
E=M\frac{(1+\nu)(1-2\nu)}{1-\nu}
\]

### 11.2 Preconsolidation/yield stress

Store:

\[
\sigma'_{v0}
\]

and:

\[
\sigma'_Y
\]

where \(\sigma'_Y\) is the vertical effective preconsolidation/yield stress.

Define:

\[
OCR=\frac{\sigma'_Y}{\sigma'_{v0}}
\]

or:

\[
\sigma'_Y=OCR\cdot\sigma'_{v0}
\]

### 11.3 Bilinear oedometric strain increment

For a vertical effective stress increment from \(\sigma'_{v,n}\) to \(\sigma'_{v,n+1}\):

If:

\[
\sigma'_{v,n+1}\leq\sigma'_Y
\]

then:

\[
\Delta\epsilon_v=\frac{\sigma'_{v,n+1}-\sigma'_{v,n}}{M_{ur}}
\]

If the increment crosses \(\sigma'_Y\):

\[
\sigma'_{v,n}<\sigma'_Y<\sigma'_{v,n+1}
\]

then:

\[
\Delta\epsilon_v
=
\frac{\sigma'_Y-\sigma'_{v,n}}{M_{ur}}
+
\frac{\sigma'_{v,n+1}-\sigma'_Y}{M_{oed}}
\]

If:

\[
\sigma'_{v,n}\geq\sigma'_Y
\]

then:

\[
\Delta\epsilon_v=\frac{\sigma'_{v,n+1}-\sigma'_{v,n}}{M_{oed}}
\]

This gives stress-history-dependent settlement behavior but is not Mohr–Coulomb shear plasticity. Keep its state flag separate:

```text
compression_yield_active != MC_yield_active
```

### 11.4 Dimensional consistency warning

The bilinear rule above defines a scalar vertical compression law, but the global finite-element solver requires a full tangent matrix:

\[
\mathbf{D}_{tan}
\]

Therefore, this module cannot enter the nonlinear equilibrium loop until one of the following is defined:

1. an **isotropic equivalent** mapping from the active constrained modulus \(M\) to \(E_{eq},\nu_{eq}\), then to \(K,G\), or
2. an **anisotropic tangent** in which only selected compression terms are degraded.

If this module is ever enabled inside the FE solve, the safest first route is:

\[
E_{eq}=M_{active}\frac{(1+\nu_{eq})(1-2\nu_{eq})}{1-\nu_{eq}}
\]

followed by reconstruction of an isotropic elastic tangent from \(E_{eq},\nu_{eq}\).

This is only an approximation, because it changes horizontal stiffness together with vertical stiffness. A more rigorous anisotropic tangent is a later enhancement. Do not mix this module into Stage 1 pseudo-plasticity.

---

## 12. Solver architecture

### 12.1 Required class/interface structure

Recommended conceptual structure:

```text
NonlinearSolver
    LoadStepper
    ConvergenceController
    LinearSolver
    Mesh
        Elements
            MaterialPoints
                MaterialModel
```

The element should not know whether the material is elastic, pseudo-plastic, or true plastic. It should only call `material.update()`.

### 12.2 Material update interface

```text
MaterialUpdateInput:
    strain_trial_6
    committed_state
    material_parameters
    analysis_context

MaterialUpdateResult:
    stress_trial_6
    tangent_6x6
    trial_state
    diagnostics
```

For 2D plane strain assembly, extract:

```text
stress_2d = [stress_6.xx, stress_6.yy, stress_6.xy]
D_2d = rows/cols [xx, yy, xy] from tangent_6x6
```

Keep \(\sigma'_{zz}\) in `stress_trial_6` for future material updates and Mohr–Coulomb evaluation.

### 12.3 Global nonlinear solve

```text
for load_step in load_steps:

    F_ext_target = F_ext_committed + ΔF_ext
    u_trial = u_committed

    for iteration in 1..max_iterations:

        K_tangent = zero_matrix()
        F_internal = zero_vector()
        state_change_count = 0

        for element in mesh.elements:

            u_e_trial = gather(u_trial, element.dofs)
            strain_2d = B[element] * u_e_trial
            strain_6 = lift_plane_strain_to_6D(strain_2d)

            mp = element.material_point

            update = mp.material.update(
                strain_trial_6 = strain_6,
                committed_state = mp.committed_state,
                material_parameters = mp.params
            )

            mp.trial_state = update.trial_state

            stress_2d = extract_2D_stress(update.stress_trial_6)
            D_2d = extract_2D_tangent(update.tangent_6x6)

            F_internal_e = transpose(B[element]) * stress_2d * element.area * thickness
            K_e = transpose(B[element]) * D_2d * B[element] * element.area * thickness

            assemble(F_internal, F_internal_e, element.dofs)
            assemble(K_tangent, K_e, element.dofs)

            if update.diagnostics.state_changed:
                state_change_count += 1

        residual = F_ext_target - F_internal
        apply_displacement_boundary_conditions(K_tangent, residual)

        if converged(residual, Δu_previous, state_change_count):
            commit_all_material_point_states()
            u_committed = u_trial
            F_ext_committed = F_ext_target
            break

        Δu = solve(K_tangent, residual)
        u_trial = u_trial + Δu

    if not converged:
        reject_step()
        reduce_ΔF_ext()
        restore_committed_states()
        retry_step()
```

### 12.4 Convergence criteria

Use at least residual convergence:

\[
\frac{\|\mathbf{R}_{free}\|}{\|\mathbf{F}_{ext,free}\|+F_{scale}}<\text{tol}_R
\]

Recommended first tolerance:

\[
\text{tol}_R=10^{-5}\text{ to }10^{-3}
\]

Also use displacement correction convergence:

\[
\frac{\|\delta\mathbf{u}\|}{\|\mathbf{u}\|+u_{scale}}<\text{tol}_u
\]

Recommended first tolerance:

\[
\text{tol}_u=10^{-5}\text{ to }10^{-3}
\]

For Stage 1 active-set behavior, also require that the active set is stable:

```text
state_change_count == 0
```

or below a small accepted threshold for the last iteration.

### 12.5 Load-step cutback

Reject and cut the load step if:

- nonlinear iterations exceed `max_iterations`,
- residual norm stagnates,
- active set oscillates,
- local return mapping fails,
- tangent matrix becomes singular or ill-conditioned.

Recommended cutback:

\[
\Delta F_{new}=0.5\Delta F_{old}
\]

Recommended load-step growth after successful convergence:

\[
\Delta F_{new}=\min(1.2\Delta F_{old},\Delta F_{max})
\]

---

## 13. Pseudocode — material models

### 13.1 Linear elastic material

```text
function LinearElastic.update(strain_trial_6, committed_state, params):

    Δε = strain_trial_6 - committed_state.total_strain_6

    σ_new = committed_state.effective_stress_6 + D_elastic(params) * Δε

    trial_state = copy(committed_state)
    trial_state.total_strain_6 = strain_trial_6
    trial_state.effective_stress_6 = σ_new
    trial_state.currently_MC_active = false

    diagnostics = evaluate_MC_diagnostics(σ_new, params.c, params.phi)

    return MaterialUpdateResult(
        stress_trial_6 = σ_new,
        tangent_6x6 = D_elastic(params),
        trial_state = trial_state,
        diagnostics = diagnostics
    )
```

### 13.2 Stage 1 — MC reduced stiffness material

```text
function MCReducedStiffness.update(strain_trial_6, committed_state, params):

    Δε = strain_trial_6 - committed_state.total_strain_6
    σ_old = committed_state.effective_stress_6

    D_e = build_elastic_stiffness(params.E, params.nu)

    // Elastic trial
    σ_elastic_trial = σ_old + D_e * Δε

    mc_trial = evaluate_MC(σ_elastic_trial, params.c, params.phi)

    if mc_trial.f <= params.yield_tolerance:

        σ_new = σ_elastic_trial
        D_tan = D_e
        currently_MC_active = false

    else:

        D_red = build_reduced_shear_stiffness(
            E = params.E,
            nu = params.nu,
            shear_reduction = params.r_shear,
            preserve_bulk = true
        )

        σ_new = σ_old + D_red * Δε
        D_tan = D_red
        currently_MC_active = true

    mc_final = evaluate_MC(σ_new, params.c, params.phi)

    trial_state = copy(committed_state)
    trial_state.total_strain_6 = strain_trial_6
    trial_state.effective_stress_6 = σ_new
    trial_state.currently_MC_active = currently_MC_active
    trial_state.has_ever_exceeded_MC =
        committed_state.has_ever_exceeded_MC OR currently_MC_active
    trial_state.eta_MC_current = mc_final.eta
    trial_state.eta_MC_max_history = max(
        committed_state.eta_MC_max_history,
        mc_final.eta
    )

    diagnostics = {
        f_MC_trial: mc_trial.f,
        eta_MC_trial: mc_trial.eta,
        f_MC_final: mc_final.f,
        eta_MC_final: mc_final.eta,
        currently_MC_active: currently_MC_active,
        state_changed: currently_MC_active != committed_state.currently_MC_active
    }

    return MaterialUpdateResult(
        stress_trial_6 = σ_new,
        tangent_6x6 = D_tan,
        trial_state = trial_state,
        diagnostics = diagnostics
    )
```

### 13.3 Stage 2 — true MC elastoplastic material

```text
function MCPlastic.update(strain_trial_6, committed_state, params):

    Δε = strain_trial_6 - committed_state.total_strain_6
    σ_old = committed_state.effective_stress_6
    εp_old = committed_state.plastic_strain_6

    D_e = build_elastic_stiffness(params.E, params.nu)

    σ_trial = σ_old + D_e * Δε

    mc_trial = evaluate_MC(σ_trial, params.c, params.phi)

    if mc_trial.f <= params.yield_tolerance:

        σ_new = σ_trial
        εp_new = εp_old
        D_tan = D_e
        active_surface = NONE
        Δεp = zero_vector_6()

    else:

        local_result = return_map_MC(
            σ_trial = σ_trial,
            D_e = D_e,
            c = params.c,
            phi = params.phi,
            psi = params.psi,
            hardening = params.hardening,
            tolerance = params.local_tolerance,
            max_iterations = params.local_max_iterations
        )

        if not local_result.converged:
            raise LocalReturnMappingFailure

        σ_new = local_result.stress
        Δεp = local_result.plastic_strain_increment
        εp_new = εp_old + Δεp
        D_tan = local_result.algorithmic_tangent
        active_surface = local_result.active_surface

    mc_final = evaluate_MC(σ_new, params.c, params.phi)

    trial_state = copy(committed_state)
    trial_state.total_strain_6 = strain_trial_6
    trial_state.plastic_strain_6 = εp_new
    trial_state.effective_stress_6 = σ_new
    trial_state.active_yield_surface = active_surface
    trial_state.currently_MC_active = active_surface == MC_SHEAR
    trial_state.has_ever_exceeded_MC =
        committed_state.has_ever_exceeded_MC OR (mc_trial.f > params.yield_tolerance)
    trial_state.eta_MC_current = mc_final.eta
    trial_state.eta_MC_max_history = max(
        committed_state.eta_MC_max_history,
        mc_final.eta
    )
    trial_state.accumulated_plastic_strain =
        committed_state.accumulated_plastic_strain + equivalent_plastic_strain_increment(Δεp)

    diagnostics = {
        f_MC_trial: mc_trial.f,
        eta_MC_trial: mc_trial.eta,
        f_MC_final: mc_final.f,
        eta_MC_final: mc_final.eta,
        plastic_increment_norm: norm(Δεp),
        active_surface: active_surface,
        local_iterations: local_result.iterations,
        state_changed: active_surface != committed_state.active_yield_surface
    }

    return MaterialUpdateResult(
        stress_trial_6 = σ_new,
        tangent_6x6 = D_tan,
        trial_state = trial_state,
        diagnostics = diagnostics
    )
```

### 13.4 Stage 2 local return mapping — simplified cutting-plane version for smoothed MC only

```text
function return_map_MC(σ_trial, D_e, c, phi, psi, hardening, tolerance, max_iterations):

    σ = σ_trial
    Δεp_total = zero_vector_6()
    Δλ_total = 0

    for k in 1..max_iterations:

        mc = evaluate_MC(σ, c, phi)

        if abs(mc.f) <= tolerance:
            D_ep = compute_elastoplastic_tangent(D_e, σ, c, phi, psi, hardening)
            return {
                converged: true,
                stress: σ,
                plastic_strain_increment: Δεp_total,
                algorithmic_tangent: D_ep,
                active_surface: MC_SHEAR,
                iterations: k
            }

        n = yield_gradient_MC(σ, phi)          // work-conjugate engineering-Voigt gradient
        m = potential_gradient_MC(σ, psi)      // work-conjugate engineering-Voigt gradient

        H = hardening_modulus(hardening)

        denominator = transpose(n) * D_e * m + H

        if denominator <= small_number or not finite(denominator):
            return { converged: false, reason: "bad plastic denominator" }

        δλ = mc.f / denominator

        if δλ < 0:
            return { converged: false, reason: "negative plastic multiplier" }

        Δεp = δλ * m
        σ = σ - D_e * Δεp

        Δεp_total = Δεp_total + Δεp
        Δλ_total = Δλ_total + δλ

    return { converged: false, reason: "max local iterations reached" }
```

This simplified corrector is acceptable only for a first **smoothed** implementation. For exact Mohr–Coulomb, replace it with a proper local active-set backward-Euler return to faces/edges/apex.

---

## 14. Mohr–Coulomb evaluation pseudocode

### 14.1 Principal stress evaluation

For plane strain, build the full stress tensor:

\[
\boldsymbol{\sigma}'=
\begin{bmatrix}
\sigma'_{xx} & \tau'_{xy} & 0 \\
\tau'_{xy} & \sigma'_{yy} & 0 \\
0 & 0 & \sigma'_{zz}
\end{bmatrix}
\]

Then compute eigenvalues and eigenvectors. Sort eigenvalues descending for compression-positive convention:

\[
\sigma'_1\geq\sigma'_2\geq\sigma'_3
\]

```text
function principal_stresses_and_projectors(stress_6):

    tensor = stress_voigt_to_tensor(stress_6)
    eigenpairs = symmetric_eigendecomposition(tensor)
    sort eigenpairs by eigenvalue descending

    σ1, v1 = eigenpairs[0]
    σ2, v2 = eigenpairs[1]
    σ3, v3 = eigenpairs[2]

    P1 = outer(v1, v1)
    P2 = outer(v2, v2)
    P3 = outer(v3, v3)

    return σ1, σ2, σ3, P1, P2, P3
```

Implementation note: `stress_voigt_to_tensor()` is a stress-like mapping. Do not reuse the strain-like converter here.

### 14.2 Yield and utilization

```text
function evaluate_MC(stress_6, c, phi):

    σ1, σ2, σ3, P1, P2, P3 = principal_stresses_and_projectors(stress_6)

    s = sin(phi)

    f = (σ1 - σ3) - (σ1 + σ3) * s - 2 * c * cos(phi)

    denom = (σ1 + σ3) * s + 2 * c * cos(phi)

    if denom > tiny:
        eta = (σ1 - σ3) / denom
    else:
        eta = +infinity if (σ1 - σ3) > 0 else 0

    return {
        f: f,
        eta: eta,
        σ1: σ1,
        σ2: σ2,
        σ3: σ3,
        P1: P1,
        P2: P2,
        P3: P3
    }
```

### 14.3 Yield gradient

```text
function yield_gradient_MC(stress_6, phi):

    σ1, σ2, σ3, P1, P2, P3 = principal_stresses_and_projectors(stress_6)

    s = sin(phi)

    n_tensor = (1 - s) * P1 - (1 + s) * P3

    return gradient_tensor_to_voigt(n_tensor)
```

### 14.4 Plastic potential gradient

```text
function potential_gradient_MC(stress_6, psi):

    σ1, σ2, σ3, P1, P2, P3 = principal_stresses_and_projectors(stress_6)

    s = sin(psi)

    m_tensor = (1 - s) * P1 - (1 + s) * P3

    return gradient_tensor_to_voigt(m_tensor)
```

`gradient_tensor_to_voigt()` must return:

\[
\begin{bmatrix}
g_{xx} &
g_{yy} &
g_{zz} &
2g_{xy} &
2g_{yz} &
2g_{xz}
\end{bmatrix}^T
\]

not the raw tensor off-diagonal terms.

### 14.5 Repeated eigenvalue warning

If:

\[
|\sigma'_i-\sigma'_j|<\text{tol}_{eig}
\]

then projectors and gradients may become unstable. For Stage 2, this is a reason to prefer a smoothed Mohr–Coulomb criterion or an exact multisurface algorithm. For Stage 1 and early diagnostics, a tiny perturbation such as \(10^{-6}\) kPa on one normal component is an acceptable stabilizing hack if it is clearly isolated and documented.

---

## 15. Data model details

### 15.1 Material parameters

```text
MohrCoulombMaterialParameters:
    E                         // Young's modulus, if isotropic elastic input
    nu                        // Poisson's ratio
    c                         // effective cohesion c'
    phi                       // effective friction angle, radians internally
    psi                       // dilation angle, radians internally
    tensile_strength          // optional, compression-positive cutoff uses -σ3 - σt
    r_shear                   // Stage 1 residual shear stiffness factor
    yield_tolerance
    local_tolerance
    local_max_iterations
    use_tension_cutoff
    use_compression_yield
    Eoed_or_Moed              // optional settlement module
    Eur_or_Mur                // optional settlement module
    sigmaY                    // optional preconsolidation/yield stress
```

Angles must be stored in radians internally.

### 15.2 Diagnostics

```text
MaterialDiagnostics:
    f_MC_trial
    eta_MC_trial
    f_MC_final
    eta_MC_final
    local_strength_reserve
    currently_MC_active
    has_ever_exceeded_MC
    active_yield_surface
    equivalent_plastic_strain
    volumetric_plastic_strain
    local_iterations
    state_changed
```

### 15.3 Visualization outputs

Recommended result maps:

- `eta_MC_current`
- `eta_MC_max_history`
- `local_strength_reserve = 1 / eta_MC`
- `currently_MC_active`
- `has_ever_exceeded_MC`
- `active_yield_surface`
- `equivalent_plastic_strain` after Stage 2
- `plastic_volumetric_strain` after Stage 2
- `settlement/load curve`
- `residual convergence history`
- `load step cutback history`

Recommended labels:

| Internal state | User-facing label |
|---|---|
| `currently_MC_active`, Stage 1 | MC-active reduced-stiffness zone |
| `has_ever_exceeded_MC`, Stage 1 | Mohr–Coulomb exceeded at least once |
| `active_yield_surface == MC_SHEAR`, Stage 2 | plastic shear yielding |
| nonzero `plastic_strain_6`, Stage 2 | accumulated plastic strain |

---

## 16. Numerical solver requirements

### 16.1 Linear solver

Stage 1 reduced-stiffness tangents can remain symmetric if \(\mathbf{D}_{red}\) is symmetric.

Stage 2 non-associated plasticity generally produces a non-symmetric elastoplastic tangent:

\[
\mathbf{D}_{ep}\neq\mathbf{D}_{ep}^T
\]

Therefore, the long-term solver should support general non-symmetric matrices.

Minimum acceptable options:

- sparse LU for smaller problems,
- GMRES/BiCGSTAB with preconditioning for larger problems,
- symmetric approximation only as a fallback/debug mode.

### 16.2 Robustness controls

Implement:

- load-step cutback,
- maximum iterations,
- local return-mapping failure handling,
- minimum load-step size,
- active-set oscillation detection,
- singular/ill-conditioned tangent detection.

### 16.3 Tolerances

Suggested starting values:

```text
global_residual_tolerance = 1e-4
global_displacement_tolerance = 1e-4
local_return_tolerance = 1e-8 to 1e-6
yield_tolerance = 1e-8 * stress_scale
max_global_iterations = 25
max_local_iterations = 30
minimum_load_step_fraction = 1e-4
```

Use stress-scaled tolerances rather than pure absolute values:

\[
\text{tol}_f=\epsilon_f\max(c',|\sigma'_1|,|\sigma'_3|,p_{ref})
\]

---

## 17. Testing and validation plan

### 17.1 Unit tests

#### Elastic regression

With MC disabled or with stresses far inside the yield envelope, nonlinear solver output must match the current linear elastic solver.

Expected:

```text
u_new ≈ u_existing
stress_new ≈ stress_existing
converges in one iteration
```

#### MC yield function test

For \(c'=0\), \(\phi'=30^\circ\):

\[
N_\phi=3
\]

Yield occurs at:

\[
\sigma'_1=3\sigma'_3
\]

Test:

```text
σ3 = 100 kPa
σ1 = 300 kPa
f_MC ≈ 0
eta_MC ≈ 1
```

#### Voigt work-conjugacy test

Create a random symmetric tensor \(\mathbf{A}\) and a random symmetric stress increment \(\Delta\boldsymbol{\sigma}\). Verify:

\[
\mathbf{A}:\Delta\boldsymbol{\sigma}
\approx
\left(gradient\_tensor\_to\_voigt(\mathbf{A})\right)^T
\left(stress\_tensor\_to\_voigt(\Delta\boldsymbol{\sigma})\right)
\]

Also verify that a pure-shear flow direction produces the correct engineering plastic shear increment \(\Delta\gamma_{xy}^p\), not half that value.

#### Cohesive MC yield test

For general \(c'\):

\[
\sigma'_1=N_\phi\sigma'_3+2c'\sqrt{N_\phi}
\]

should give:

```text
f_MC ≈ 0
eta_MC ≈ 1
```

#### Plane strain stress test

For a plane strain elastic increment:

\[
\epsilon_{zz}=0
\]

but:

\[
\Delta\sigma'_{zz}=\lambda(\Delta\epsilon_{xx}+\Delta\epsilon_{yy})
\]

and:

\[
\sigma'_{zz,n+1}=\sigma'_{zz,n}+\Delta\sigma'_{zz}
\]

Verify that the implementation updates \(\sigma'_{zz}\) incrementally and that \(\sigma'_{zz}\) is included in principal stress computation.

#### Commit/rollback test

Force a load step to fail after material trial states are created. Verify:

```text
committed_state unchanged
trial_state discarded
u_committed unchanged
```

#### Stage 1 activation test

Create a one-element test where the elastic trial stress exceeds MC.

Expected:

```text
currently_MC_active == true
D_tangent uses G_red
has_ever_exceeded_MC == true after commit
plastic_strain remains zero
```

#### Stage 2 return test

Create a one-material-point test with trial stress outside MC.

Expected:

```text
f_MC(stress_returned) ≈ 0
plastic_strain_increment nonzero
D_tangent != D_elastic
```

### 17.2 Patch tests

- Constant strain patch with elastic material.
- Constant strain patch with stresses below yield.
- Stage 1 should not break elastic patch behavior when MC inactive.

### 17.3 Single-element material tests

Run prescribed strain paths:

- isotropic compression,
- triaxial compression-like path,
- pure shear-like path,
- unloading after plastic loading.

Stage 2 should show elastic unloading around the plastic strain state.

### 17.4 Boundary-value benchmarks

Recommended benchmarks:

1. Strip footing bearing capacity under plane strain.
2. Slope under self-weight with plastic zone development.
3. Excavation/slope cutting staged construction.
4. Oedometer compression if the compression-yield module is enabled.

For slopes, do not infer global factor of safety unless a strength-reduction driver is implemented. A connected plastic zone is a useful diagnostic but not automatically a conventional slope FS.

---

## 18. Important implementation constraints

### 18.1 Do not hardcode plasticity into element assembly

Bad:

```text
if triangle.failed:
    element.E *= 0.05
```

Correct:

```text
update = material.update(...)
D_tangent = update.tangent_6x6
stress = update.stress_trial_6
```

The element only assembles what the material returns.

### 18.2 Do not permanently degrade based on history unless modeling damage

Bad:

```text
if has_ever_exceeded_MC:
    use reduced stiffness forever
```

Correct:

```text
if currently_MC_active:
    use active tangent
else:
    use elastic or elastoplastic unloading tangent
```

### 18.3 Do not update committed plastic strain during Newton iterations

Bad:

```text
state.plastic_strain += Δεp during every global iteration
```

Correct:

```text
trial_state = material.update(committed_state, trial_strain)
commit only after global convergence
```

### 18.4 Do not ignore \(\sigma'_{zz}\) in plane strain

For plane strain slope analysis, Mohr–Coulomb must be evaluated using the full 3D stress state.

### 18.5 Do not call Stage 1 true plasticity

Stage 1 is reduced-stiffness pseudo-plasticity. Only Stage 2 computes actual plastic strain.

---

## 19. Acceptance criteria

### Stage 1 acceptance

Stage 1 is accepted when:

- linear elastic results are unchanged when no MC exceedance occurs;
- load increments alter the solution once MC-active zones appear;
- MC-active zones reduce shear tangent through the material interface;
- global residual iterations converge or load-step cutback works;
- no committed state is mutated during unconverged iterations;
- visualization distinguishes `currently_MC_active` from `has_ever_exceeded_MC`;
- plastic strain is not reported.

### Stage 2 acceptance

Stage 2 is accepted when:

- trial stresses outside MC return to \(f_{MC}\approx0\);
- plastic strain increments are stored and accumulated;
- unloading/reloading behaves elastically around the plastic state;
- non-associated flow with \(\psi<\phi'\) is supported;
- the global solver can handle non-symmetric tangents, or a documented approximation is used;
- convergence/cutback behavior is robust for standard footing and slope examples.

---

## 20. References

[R1] Itasca Software. **Mohr-Coulomb Model — FLAC3D Theory and Background**. Documentation describes principal-stress formulation, non-associated shear flow, dilation angle \(\psi\), and tension cutoff concepts.  
URL: https://docs.itascacg.com/itasca900/common/models/mohr/doc/modelmohr.html

[R2] A. J. Abbo and S. W. Sloan. **A smooth hyperbolic approximation to the Mohr-Coulomb yield criterion**. *Computers & Structures*, 54(3), 427–441, 1995. DOI: `10.1016/0045-7949(94)00339-5`. Used as the main reference for smoothed Mohr–Coulomb implementation and the numerical issues caused by the MC edge/apex singularities.  
URL: https://doi.org/10.1016/0045-7949(94)00339-5

[R3] S. W. Sloan and J. R. Booker. **Removal of singularities in Tresca and Mohr-Coulomb yield functions**. *Communications in Applied Numerical Methods*, 2(2), 173–179, 1986. DOI: `10.1002/cnm.1630020208`. Used as a reference for rounding MC/Tresca vertices.  
URL: https://doi.org/10.1002/cnm.1630020208

[R4] J. C. Clausen, L. Damkilde, and L. Andersen. **An Efficient Return Algorithm for Non-Associated Plasticity With Linear Yield Criteria in Principal Stress Space**. *Computers & Structures*, 85(23–24), 1795–1807, 2007. DOI: `10.1016/j.compstruc.2007.04.002`. Used as a reference for exact/non-associated return mapping with linear yield planes in principal stress space.  
URL: https://doi.org/10.1016/j.compstruc.2007.04.002

[R5] J. C. Simo and R. L. Taylor. **Consistent tangent operators for rate-independent elastoplasticity**. *Computer Methods in Applied Mechanics and Engineering*, 48(1), 101–118, 1985. DOI: `10.1016/0045-7825(85)90070-2`. Used as the main reference for consistent tangent operators and Newton convergence in elastoplasticity.  
URL: https://doi.org/10.1016/0045-7825(85)90070-2

[R6] E. A. de Souza Neto, D. Perić, and D. R. J. Owen. **Computational Methods for Plasticity: Theory and Applications**. Wiley, 2008. ISBN: `978-0470694527`. Used as a general reference for return mapping, local constitutive integration, and plasticity implementation.  
URL: https://onlinelibrary.wiley.com/doi/book/10.1002/9780470694626

[R7] D. M. Potts and L. Zdravković. **Finite Element Analysis in Geotechnical Engineering: Theory**. Thomas Telford, 1999. ISBN: `978-0727739612` / related editions. Used as a geotechnical FE reference for nonlinear analysis, constitutive modeling, and interpretation of numerical results.  
URL: https://books.google.com/books/about/Finite_Element_Analysis_in_Geotechnical.html?id=9mmXzwEACAAJ

[R8] T. Zhang et al. **Elastoplastic Integration Method of Mohr-Coulomb Criterion**. *Foundations*, 2(3), 2022. Used as a recent open-access reference on nonsmooth MC multisurface integration, active-surface complexity, and return manipulation.  
URL: https://www.mdpi.com/2673-7094/2/3/29

[R9] DIANA FEA. **Mohr-Coulomb or Drucker-Prager Plasticity**. Software theory/manual documentation. Used as a secondary implementation reference for MC/DP plasticity model organization.  
URL: https://manuals.dianafea.com/d110/en/1286352-1287208-mohr-coulomb-or-drucker-prager-plasticity.html

---

## 21. Recommended next development tasks

1. Implement explicit `stress/strain/gradient` Voigt helper functions and weighted contraction helpers. Do not use a generic `tensor_to_voigt()`.
2. Implement `MaterialPointState`, `MaterialUpdateInput`, and `MaterialUpdateResult`.
3. Refactor current linear elasticity into `LinearElasticMaterial.update()`.
4. Implement residual-based nonlinear solver while preserving elastic regression behavior.
5. Move current MC utilization calculation into `evaluate_MC()` inside the material library.
6. Implement `MCReducedStiffnessMaterial` as Stage 1.
7. Add load stepping, commit/rollback, and cutback.
8. Add Stage 1 tests and visualization labels.
9. Implement a single-material-point return-mapping test harness before connecting Stage 2 to the global solver.
10. Implement Stage 2 smoothed MC or exact face return.
11. Extend Stage 2 to edges/apex/tension cutoff only after basic return mapping is stable.
