# Stage 6 — Engineering Use Cases: Technical Review

**Input data (from CSV)**
Per layer your program already outputs:
`Top_m, Bot_m, Top_TAW, Bot_TAW, Thick_m, γ, γ_sat, φ', c', c_u, E_oed,ref, E_oed,i, E50,ref, Eur,ref, m, K0_nc, ν_ur, k_h, k_v`.

This is sufficient for the current Stage 6 applications with only minor supplementary assumptions.

---

## 0A. Current implemented engineering models in Stage 6

The current Stage 6 implementation contains **four engineering applications**:

1. **Bearing capacity**
2. **Settlement**
3. **Dewatering**
4. **Beam / slab on elastic foundation**

This section records the **mathematical model actually implemented today**, so the review remains aligned with the live application.

### 0A.1 Bearing capacity — current implemented model

The current bearing-capacity application evaluates shallow-foundation resistance versus founding depth using:

- **Drained check**
  ```
  q_ult,d = c'·N_c·s_c + q'·N_q·s_q + 0.5·γ'·B·N_γ·s_γ
  ```
- **Undrained check**
  ```
  q_ult,u = q + 5.14·c_u·s_cu
  ```

with:
- `q'` = effective surcharge at foundation depth
- `γ'` = effective unit weight below the water table
- `s_*` = footing-type shape factors used in the app

In the current implementation, the drained bearing factors are evaluated as:
```
N_q = exp(π·tanφ') · tan²(45° + φ'/2)
N_c = (N_q − 1) / tanφ'
N_γ = 2·(N_q + 1)·tanφ'
```

The current app then converts ultimate resistance to the displayed design / allowable resistance as:
```
q_d       = q_ult / γ_Rd         # EC7 route
q_allow   = q_ult / ξ            # global-system-factor route
```

So the present Stage 6 bearing module is mathematically a **resistance-side screening tool**:
- it evaluates `q_ult`
- converts that to `q_d` or `q_allow`
- and optionally compares that against an applied stress in the UI

For the Belgian EC7 route, the current application does:

**DA1/1**
```
φ'_d = φ'_k
c'_d = c'_k
c_u,d = c_u,k
γ_R = 1.0
```

**DA1/2**
```
tanφ'_d = tanφ'_k / 1.25
c'_d    = c'_k / 1.25
c_u,d   = c_u,k / 1.40
γ_R = 1.0
```

and, in governing mode, takes:
```
q_d,drained   = min(q_d,DA1/1, q_d,DA1/2)      on the drained branch
q_d,undrained = min(q_d,DA1/1, q_d,DA1/2)      on the undrained branch
```

So the current app does **not** simply pick one global DA1 combination and reuse it for both modes; it forms the governing drained and undrained envelopes separately.

The current app applies the Belgian **DA1** philosophy as follows:
- `DA1/1` = unfactored soil strength (`M1`)
- `DA1/2` = reduced soil strength (`M2`)
- governing mode = most onerous result of the two

So, mathematically, the current implementation is:
- **strength reduction on soil parameters for M2**
- **no reduction on stiffness**
- `γ_R = 1.0`
- `γ_Rd` only as an optional model factor

This means the present Stage 6 bearing module should be read as:
- a **Belgian shallow-foundation ULS screening tool**
- based on drained / undrained classical bearing-capacity formulas
- with explicit DA1/1 and DA1/2 comparison

### 0A.2 Settlement — current implemented model

The current settlement module is implemented as a **centreline, one-dimensional constrained-settlement summation**:

1. compute `q_net`
2. compute `Δσ_v(z)` beneath the loaded area
3. compute `E_oed(z)` at the mean stress state
4. integrate:
   ```
   ΔS_i = (Δσ_v,i / E_oed,i) · Δz_i
   S = Σ ΔS_i
   ```

The present implementation supports two stress routes:
- **Boussinesq-based centreline stress**
- **2:1 stress spread**

The current settlement application evaluates settlement at:
- the **strip centreline** for strip geometry
- the **centre of the footprint** for rectangular / square / slab geometry

So the current mathematics is:
- not a full 2D settlement field
- not edge settlement
- not differential settlement between two points
- but a **single vertical settlement line beneath the centre of the loaded area**

For stress-dependent stiffness, the present implementation uses:
```
σ'_mean = σ'_v,0 + 0.5·Δσ_v
E_oed(σ'_mean) = E_oed,ref · [(c'·cotφ' + σ'_mean)/(c'·cotφ' + p_ref)]^m
```

The current app defaults are:
- **quasi-permanent SLS combination**
- **CPT bottom** as the practical truncation setting

### 0A.3 Dewatering — current implemented model

The current dewatering application is implemented as an **SLS screening model** with two linked parts:

1. **hydraulic drawdown estimate**
2. **effective-stress and settlement response at the CPT**

Hydraulically, the app currently uses:
- **radial Dupuit / Thiem-style screening** for:
  - single well
  - equivalent-radius excavation
- **linear screening interpolation** for:
  - line dewatering trench

The screening influence radius is:
```
R = C · s · √k
```

The settlement response is then derived from the CPT-side stress change:
```
Δσ'_v(z) = σ'_v,new(z) − σ'_v,old(z)
ΔS = Σ [Δσ'_v / E_oed(σ'_mean)] · Δz
```

The current implementation contains **two total-stress assumptions**:

**Conservative mode**
```
σ_v,new(z) = σ_v,old(z)
u_new(z)   = γ_w · max(0, z − z'_w)
σ'_v,new   = σ_v,old − u_new
```

**Realistic mode**
between the old and new phreatic levels, total stress is reduced by switching:
```
γ_sat  →  γ
```
so both `σ_v` and `u` change.

Therefore, the current dewatering module is mathematically not only:
- a drawdown estimator
but also:
- a **paired stress-path comparison**
  - conservative `σ_v` fixed
  - realistic `γ_sat → γ`

The current app reports both settlement outcomes explicitly so the sensitivity to this assumption is visible.

### 0A.4 Beam / slab on elastic foundation — current implemented model

The current structural-geotechnical application is a **1D strip / beam model**, not a 2D slab/plate model.

So the implemented governing equations are:

**Winkler**
```
EI · w'''' + k_s · b · w = q(x)
```

**Pasternak**
```
EI · w'''' − G_p · b · w'' + k_s · b · w = q(x)
```

The current app solves these numerically along a strip length `L`.

Important consequence:
- for **uniform full-length loading**, even Pasternak still admits nearly uniform settlement with low curvature, so bending moment can remain close to zero
- the implemented Pasternak model does **not** by itself create large bending under a perfectly uniform free-strip load

The subgrade model is currently linked to the CPT by:

**Winkler stiffness**
```
k_s = (0.65 · E_s) / [B · (1 − ν_s²)] · (E_s·B^4 / (E_b·I_b))^(1/12)
```

**Pasternak shear coupling**
```
G_p = η · G_s,avg · H_p
```

with:
```
G_s,avg = E_s,avg / [2·(1 + ν_s)]
H_p     = z_influence
```

and, in the current default implementation:
```
E_s = E_oed
ν_s = 0
=> G_s,avg = E_s,avg / 2
```

So the current Pasternak route is:
- an implemented **1D screening extension**
- not yet a continuum-calibrated Belgian design model
- not a true 2D slab formulation

### 0A.5 Reinforcement design — current implemented model

The current beam/slab module already carries the structural output through to **ULS reinforcement design**.

The implemented sequence is:

1. derive `M_Ed` from the **ULS beam/foundation solve**
2. convert materials to design values:
   ```
   f_cd = f_ck / γ_C
   f_yd = f_yk / γ_S
   ```
3. compute effective depth:
   ```
   d = h − c_nom − φ_bar/2
   ```
4. compute required steel:
   ```
   μ      = M_Ed / (b·d²·f_cd)
   ω      = 1 − √(1 − 2μ)
   A_s,req = ω · b · d · f_cd / f_yd
   ```
5. compare with minimum reinforcement and take the governing value

The current app also implements an **EC2 durability / cover route**, so the reinforcement calculation is not based on a manually guessed `c_nom` alone. Instead:
- exposure class
- design working life
- detailing assumptions
- EC2 structural class logic

feed the nominal cover used in the reinforcement calculation.

This is the same durability route later referenced in §9.5 and mirrored in the delivered `ec2_durability.py` helper: structural class selection, `c_min,dur` lookup from Table 4.4N, bond-cover check, then `Δc_dev`.

So, mathematically, the present beam/slab application is already a coupled:
- **soil stiffness model**
- **strip-on-foundation response model**
- **EC2 ULS reinforcement design**

---

## 0. Input legend (used throughout §§1–9)

Every pseudocode block below uses three tags:

| Tag | Meaning |
|---|---|
| `[SHARED]` | Already available from earlier stages — CPT profile, soil layers, ground water table (GWT). Pulled from `PROJECT.cpts[i]` state, not re-entered. |
| `[USER]` | Must be entered by the user in the Stage 6 UI. These are the *new* inputs for this module. |
| `[DEFAULT]` | Has a sensible default that the user can override. Show it pre-filled in the UI. |

Shared state already present from Stages 1–5:

```python
# [SHARED] — do not re-enter, read from PROJECT.cpts[i]
cpt = {
    "name":       str,               # e.g. "CPT_3_layers"
    "X":          float,             # planar coords (Lambert72 or local)
    "Y":          float,
    "z_ground":   float,             # ground-surface elevation, TAW [m]
    "z_w":        float,             # depth to phreatic surface below ground [m], OR:
    "head_TAW":   float,             # phreatic elevation in TAW [m] (preferred in Belgium)
    "layers":     list[Layer],       # from CSV: Top_m, Bot_m, Top_TAW, Bot_TAW,
                                     # gamma, gamma_sat, phi, c, cu,
                                     # Eoed_ref, Eoed_i, E50_ref, Eur_ref, m,
                                     # K0_nc, nu_ur, kh, kv
}
```

Global numerical constants (not user-editable):

```python
# [DEFAULT, not exposed in UI]
gamma_w  = 9.81        # [kN/m^3]
p_ref    = 100.0       # [kPa]   HS reference stress
g        = 9.81        # [m/s^2]
```

---

## 1. Global conventions (apply to every option)

### 1.1 Sign convention
Compression positive. Depth `z` measured downward from ground level. Elevation given in TAW.

### 1.2 In-situ effective stress and pore pressure profile
These are foundational; Options A and B both build on them. You likely already have this from Stages 3–5, but state it explicitly:

```
u(z)   = γ_w · max(0, z − z_w)           [kPa]     γ_w = 9.81 kN/m³
σ_v(z) = Σ γ_i · Δz_i    (use γ above z_w, γ_sat below z_w)
σ'_v(z) = σ_v(z) − u(z)
```

where `z_w` is the depth of the phreatic surface below ground level.

### 1.3 Reference stress convention for Hardening-Soil stiffness
The CSV already contains `E_oed,i` (stress-corrected at mid-layer) and `E_oed,ref` (at `p_ref = 100 kPa`). The HS stress-dependency law for oedometric stiffness (Schanz/Vermeer/Bonnier, 1999) is:

```
E_oed(σ'_1) = E_oed,ref · [ (c'·cot φ' + σ'_1) / (c'·cot φ' + p_ref) ]^m
```

For cohesionless soil (`c' = 0`) this reduces to:

```
E_oed(σ'_1) = E_oed,ref · (σ'_1 / p_ref)^m
```

The PLAXIS HS `E_oed` is governed by the **major principal effective stress** `σ'_1` (in oedometric loading this equals `σ'_v`). Many simplified implementations use `σ'_v` directly — that is consistent for 1D settlement on the centreline, but for off-centre points or biaxial loading the exact form above is required. For the present Stage 6 settlement route, use:
```
σ'_1 = σ'_v,initial + Δσ_v
```
at the mid-depth of each sublayer.

### 1.4 Integration scheme
Discretise the profile into sublayers `Δz ≤ 0.25 m` (finer than the layer thickness). Evaluate stresses at mid-depth of each sublayer. This is standard "stratification summation" and is what Terzaghi/Bowles/NEN all assume.

### 1.5 Inputs for the shared preprocessor

```python
# --- INPUTS for build_profile() + insitu_stresses() ---

# [SHARED]
cpt.layers         # list of layers with all CSV columns
cpt.z_w            # phreatic depth  (or derived: cpt.z_ground - cpt.head_TAW)

# [USER, only if finer control is wanted]
z_max              # deepest depth to analyse [m]
                   # default = last layer Bot_m
                   # override if the user wants to truncate (e.g. ignore a deep
                   # stiff layer that is not in the influence zone)

# [DEFAULT, override only for research]
dz          = 0.10  # [m] sublayer thickness. Smaller = slower but smoother.
p_ref       = 100.0 # [kPa]
gamma_w     = 9.81  # [kN/m^3]

# --- OUTPUTS ---
profile = list of Sublayer with:
    z_mid, dz, layer_index, gamma_eff,
    sigma_v_mid    (total vertical stress, mid-depth)
    u              (pore pressure, mid-depth)
    sigma_eff      (effective vertical stress, mid-depth)
```

This preprocessor runs **once per CPT per calculation**. All three options below consume `profile` as their starting point.

---

## 2. Option A — Dewatering impact estimator

### 2.1 Scope and structure
This option contains two linked parts:

1. **Drawdown at the CPT location** given a pumping configuration (hydrogeology)
2. **Effective stress and settlement response** at the CPT (geotechnics)

The first is a hydraulic screening estimate of the impact zone. The **second is the engineering deliverable**: stress change and settlement response from the lowered phreatic head.

### 2.2 Radius of influence — important caveat

The **Sichardt formula** in its original form is:

```
R = C · s · √k            [R in m, s in m, k in m/s]
C = 3000   (Kyrieleis & Sichardt, 1930; standard rule-of-thumb for sandy soils)
```

Note: some textbooks write `R = C · s · √(k in m/s)` which is identical; others misquote it as `R ≈ C · √(s·k)` — **that is wrong**. The correct form is linear in `s`.

**Literature warning** (Louwyck et al., 2022, "The Radius of Influence Myth", *Water*, MDPI): the Sichardt formula is inconsistent with fundamental groundwater flow principles and systematically underestimates the drawdown extent for long-duration pumping. It is widely used in Flanders/Netherlands as a rule of thumb but must be labelled as a **screening estimate only**, not a permit-grade groundwater assessment.

Better transient alternative (Theis-based, if you want to offer it):
```
R_Theis ≈ 1.5 · √(T · t / S)
```
where `T = k · H` (transmissivity), `S` is storativity, `t` is pumping duration. This is also approximate but physically consistent.

### 2.3 Steady-state inflow estimates — transmissivity-based screening model
The current app uses a **transmissivity-based screening model** for dewatering hydraulics.

For the interpreted pumped interval between the original water table and the chosen aquifer base, define the saturated transmissivity:
```
T = Σ(k_h,i · b_i)                         [m²/s]
```
where `b_i` is the saturated thickness of layer `i` inside that interval.

For a variable water level above the aquifer base, define the transmissivity as a function of saturated thickness `h` measured upward from the base:
```
T(h) = Σ(k_h,i · b_i(h))
```
and its cumulative moment:
```
M(h) = ∫_0^h T(ξ) dξ
```

This is the key improvement over a single lumped `k_h`: the solver tracks how the active transmissivity changes as the saturated thickness changes.

**Confined aquifer screening (Thiem, 1906; Bear, 1979)** — for the currently interpreted pumped interval:
```
Q = 2π · T_0 · (h_0 − h_w) / ln(R / r_w)
```
where:
- `T_0 = Σ(k_h,i · b_i)` at the original phreatic level
- `h_0`, `h_w` are head differences from a common datum (in the app: the chosen aquifer base)

This is still a **screening surrogate** in the current app, because no separate aquifer-top input is available yet.

**Unconfined aquifer screening (Dupuit, 1863; Bear, 1979; Freeze & Cherry, 1979)**:
```
Q = 2π · [M(h_0) − M(h_w)] / ln(R / r_w)
```
where `h_0`, `h_w` are the saturated thicknesses at the radius of influence and at the well, respectively.

For a homogeneous aquifer with constant `k`, this reduces exactly to the classical Dupuit form:
```
T(h) = k · h
M(h) = 0.5 · k · h²
Q    = π · k · (h_0² − h_w²) / ln(R / r_w)
```

For a **rectangular or equivalent-radius excavation** (not a single well), the app uses the Powers et al. (2007) equivalent-well approach:
```
r_w,eq = √(A / π)         where A = excavation plan area
```

For line dewatering (trench/slurry wall), the current app keeps a linear screening profile toward the CPT, but the flow estimate is made transmissivity-based:
```
q' = [M(h_0) − M(h_w)] / L_infl          [m³/s per m length]   unconfined
q' = T_0 · (h_0 − h_w) / L_infl          [m³/s per m length]   confined
```
with `L_infl` the distance to the recharge boundary (screened here by the Sichardt radius on one side).

### 2.4 Drawdown profile along a line from well to CPT
Given `Q` and `R`, the current app solves the unconfined radial drawdown through the transmissivity moment:
```
M(h(r)) = M(h_w) + Q / (2π) · ln(r / r_w)         for r_w ≤ r ≤ R
h(r)    = h_0                                      for r > R
```

So for the CPT at distance `r_CPT`:
```
Δh_CPT = h_0 − h(r_CPT)
```
This is what is passed to the stress calculation below.

For a homogeneous aquifer, this reduces exactly to the classical Dupuit profile:
```
h²(r) = h_w² + Q / (π·k) · ln(r / r_w)
```

### 2.5 Hydraulic conductivity and transmissivity handling
The CSV contains `k_h` and `k_v` per layer.

For horizontal flow from/to a vertical well, the app now uses:
```
T = Σ(k_h,i · b_i)
```
through the interpreted pumped interval, together with the depth-varying forms `T(h)` and `M(h)` above.

The equivalent reference conductivity still shown in the UI is:
```
k_eff,h = T_0 / H_0
```
with `H_0 = h_0`, so it remains the thickness-weighted arithmetic mean over the initially saturated interval:
```
k_eff,h = Σ(k_h,i · Δz_i) / ΣΔz_i
```

This `k_eff,h` is retained for the Sichardt radius estimate, while the actual flow and drawdown calculations use transmissivity.

For vertical flow (relevant for leakage through aquitards, not the current screening case), the harmonic mean would apply instead.

### 2.6 Effective stress recalculation — this is the engineering deliverable
Once you have the new phreatic level `z'_w` at the CPT:
```
u'(z)    = γ_w · max(0, z − z'_w)
σ'_v'(z) = σ_v(z) − u'(z)
Δσ'_v(z) = σ'_v'(z) − σ'_v(z)         (positive where stress has increased)
```
Note: `σ_v(z)` (total stress from self-weight using `γ` / `γ_sat`) **does change slightly** if soil above the new phreatic level desaturates from `γ_sat` to `γ` or moist `γ`. For screening, most practitioners either:
- **Option 1 (conservative):** keep `σ_v` unchanged and only reduce `u`. This maximises `Δσ'_v`.
- **Option 2 (realistic):** between old and new phreatic level, use `γ_moist ≈ γ` (your CSV's `γ`) instead of `γ_sat`, which gives a slightly smaller `Δσ'_v`.

The current Stage 6 logic exposes both assumptions so the sensitivity can be reviewed explicitly.

### 2.7 Dewatering-induced settlement at the CPT
This is where you link to Option B. For each sublayer:
```
Δε_v,i = Δσ'_v,i / E_oed,i
ΔS_dewatering = Σ Δε_v,i · Δz_i
```

**[IMPORTANT]** Use `E_oed,i` evaluated at the **mean** stress state between old and new:
```
σ'_mean = 0.5 · (σ'_v,old + σ'_v,new)
E_oed,i(σ'_mean) = E_oed,ref · [(c' cot φ' + σ'_mean)/(c' cot φ' + p_ref)]^m
```
This avoids double-correction if your CSV's `E_oed,i` is already at the original stress.

### 2.8 Time dependency (clay layers only)
For clay-containing layers, dewatering-induced consolidation is **not necessarily instantaneous** and can be described with the Terzaghi 1D consolidation route:
```
c_v = k_v · E_oed / γ_w                [m²/s]
T_v = c_v · t / H_d²                   (H_d = drainage path length)
U    ≈ √(4·T_v/π)          for T_v < 0.2
U    ≈ 1 − (8/π²)·exp(−π²·T_v/4)    for T_v ≥ 0.2
S(t) = U(t) · S_final
```
For the sandy clay layers in your CSV: `c_v ≈ 1.7e-7 · 6094/9.81 ≈ 1.06e-4 m²/s` → for `H_d = 6 m` (half-layer with two-way drainage through the overlying/underlying sand), `t_50 ≈ 0.2·H_d²/c_v ≈ 68 000 s ≈ 0.8 days` — so actually fast for that geometry. But for a thick undrained clay you'd get months. Worth flagging.

### 2.9 Outputs
- `z'_w` at CPT (table + before/after plot)
- `u(z)`, `u'(z)`, `σ'_v(z)`, `σ'_v'(z)` (profiles)
- `Δσ'_v(z)` profile
- `ΔS_dewatering` total + per-layer + cumulative `S(z)` plot
- (Optional) time curve `S(t)` for clay layers

### 2.9A Current implemented dewatering form in the app

The current app implementation expresses the dewatering result through the following delivered quantities:

1. **Hydraulic profile**
   - transmissivity-based radial or line-flow screening
   - phreatic level depth below ground as a function of distance from:
     - well centre
     - excavation centroid
     - trench axis

2. **Stress response at the CPT**
   - `σ_v,before(z)`
   - `σ_v,after(z)`
   - `σ'_v,before(z)`
   - `σ'_v,after(z)`
   - `Δσ'_v(z)`

3. **Settlement response**
   - total settlement at the CPT
   - per-layer settlement contribution
   - total settlement versus distance from source
   - optional `S(t)` time curve

The current app therefore does **not** present the dewatering output mainly as cumulative settlement versus depth anymore. The implemented public engineering output is:
```
S_total(x)
```
as a function of distance from the source, with the CPT location marked on that curve.

The current app also computes and reports both:
```
S_conservative
S_realistic
```
to show the effect of the selected total-stress assumption.

The hydraulic side now reports, and internally uses:
```
T_far field
T_at well
k_eff,h = T_0 / H_0
```
so the user can see both the transmissivity-based screening values and the legacy equivalent conductivity used in the Sichardt radius estimate.

### 2.10 Inputs for Option A

```python
# --- INPUTS for Option A: Dewatering impact estimator ---

# [SHARED]
profile            # from §1.5
cpt.z_w            # original phreatic depth
cpt.layers[*].kh   # horizontal conductivity per layer [m/s] (from CSV)
cpt.layers[*].kv   # vertical conductivity per layer [m/s]  (from CSV)

# [USER]
z_w_target         # [m] new target phreatic depth at the well/excavation
                   # (must be > cpt.z_w; drawdown s = z_w_target - cpt.z_w)
geometry           # ENUM {"single_well", "equivalent_well_rectangular_excavation",
                   #       "line_dewatering_trench"}

# Conditional on geometry:
if geometry == "single_well":
    r_w                # well radius [m]
    r_CPT              # distance from well to CPT [m]

if geometry == "equivalent_well_rectangular_excavation":
    L_pit              # excavation length [m]
    B_pit              # excavation width [m]
    r_CPT              # distance from excavation centroid to CPT [m]
    # --> r_w_eq = sqrt(L_pit * B_pit / pi)

if geometry == "line_dewatering_trench":
    L_trench           # trench length [m]
    distance_to_CPT    # perpendicular distance [m]
    # treated as plane-strain, uses linear Dupuit form

# [DEFAULT, user may override]
aquifer_type    = "unconfined"   # {"unconfined", "confined"}
C_sichardt      = 3000.0         # [-] Kyrieleis & Sichardt 1930 coefficient
sigma_v_mode    = "conservative" # {"conservative": sigma_v unchanged,
                                 #  "realistic":   gamma_sat→gamma between old/new WT}
time_days       = None           # [d] if not None, compute S(t) for clay layers
                                 #     via Terzaghi 1D consolidation (§2.8)

# --- OUTPUTS ---
result = {
    "R_influence":     float,        # [m]
    "Q_estimate":      float,        # [m^3/s]
    "drawdown_at_CPT": float,        # [m]
    "z_w_new_at_CPT":  float,        # [m] new phreatic depth at CPT
    "profile_before":  list,         # u, sigma_eff per sublayer
    "profile_after":   list,         # u', sigma_eff' per sublayer
    "delta_sigma_eff": list,         # Δσ'_v per sublayer
    "S_final":         float,        # [mm] total settlement at CPT
    "S_per_layer":     list,         # [mm] contribution per CSV layer
    "S_t":             list|None,    # [mm] time curve if time_days given
    "limit_state":     "SLS",        # always SLS — deformation output
    "load_comb":       "quasi-permanent",
}
```

**Important audit note:** Option A produces a **deformation** output (ΔS). It is therefore always SLS. The groundwater-table lowering `s = z_w_target − z_w` is the *action* and is entered as a characteristic (expected) value. Do **not** factor it by γ_Q.

---

## 3. Option B — Settlement estimator

### 3.1 Settlement method summary
- Classical constrained-modulus approach using `E_oed`
- Stratification summation
- Boussinesq influence factors for stress increase
- Link to Stage 5 tuned `m`

### 3.2 Vertical stress increase formulas — exact forms

Use the **exact Boussinesq forms**, not only tabulated influence factors.

#### 3.2.1 Strip footing (plane strain), width `B`, uniform pressure `q_net`
Along the centreline at depth `z` below the footing:
```
α = atan(B / (2z))
Δσ_v(z) = (q_net / π) · [2α + sin(2α)]
```
Closed-form, no tables needed.

#### 3.2.2 Rectangular footing (B × L), corner, Newmark (1935) / Fadum (1948)
Let:
```
m_N = B / z
n_N = L / z
V   = m_N² + n_N² + 1
V1  = m_N² · n_N²
```

Influence factor under the **corner**:
```
A        = (2·m_N·n_N·√V) / (V + V1)
B_factor = (V + 1) / V          = (m_N² + n_N² + 2) / (m_N² + n_N² + 1)
```

Use the robust `atan`-branch form:
```
if V > V1:
    atan_term = atan( 2·m_N·n_N·√V / (V − V1) )
elif V < V1:
    atan_term = atan( 2·m_N·n_N·√V / (V − V1) ) + π
else:
    atan_term = π/2

I_z = (1/(4π)) · [ A · B_factor + atan_term ]

Δσ_v,corner(z) = q_net · I_z
```

Notes:
- `m_N` and `n_N` are interchangeable; the result is symmetric in `B` and `L`.
- The `V < V1` branch occurs for shallow, wide loaded areas. Many simplified reproductions silently return the principal value of `atan`, which is wrong in that regime.
- An equivalent `asin` form exists, but the `atan + π` branch above is numerically safer and avoids the `asin(A) > 1` pathology.

Under the **centre** of a rectangle, use the 4-quadrant superposition with `(B/2) × (L/2)` sub-rectangles:
```
Δσ_v,center(z) = 4 · I_z(B/2, L/2, z) · q_net
```

#### 3.2.3 Isolated footing — same as 3.2.2 with `B = L`.

#### 3.2.4 2:1 method (simple alternative for rough checks)
```
Δσ_v(z) = q_net · (B·L) / ((B + z)·(L + z))
```
For strip:
```
Δσ_v(z) = q_net · B / (B + z)
```
Include this as a comparison option — it's what most engineers check first.

### 3.3 Net foundation pressure
Use:
```
q_gross = (total structural load + self-weight of footing + backfill) / (B·L)
q_net   = q_gross − σ_v(D_f)          [kPa]
```
where `σ_v(D_f)` is the in-situ total stress at founding depth. Only `q_net` drives additional settlement.

### 3.4 Constrained-modulus settlement
For each sublayer `i` at mid-depth `z_i`, compute:
```
σ'_v,0,i         = in-situ effective stress (from §1.2)
Δσ_v,i           = stress increase from §3.2 at z_i
σ'_v,f,i         = σ'_v,0,i + Δσ_v,i
σ'_mean,i        = 0.5·(σ'_v,0,i + σ'_v,f,i)

E_oed,i          = E_oed,ref · [(c'·cot φ' + σ'_mean,i)/(c'·cot φ' + p_ref)]^m_i

Δε_v,i           = Δσ_v,i / E_oed,i
ΔS_i             = Δε_v,i · Δz_i

S_total          = Σ ΔS_i
```

### 3.5 Depth of influence
The theoretical truncation rule is:
- `Δσ_v(z) < 0.1 · σ'_v,0(z)` (10% rule, Bowles)  **or**
- `Δσ_v(z) < 0.2 · q_net` (20% rule, old conservative)  **or**
- the CPT bottom depth

Report which criterion terminated the integration so the user knows whether the profile was deep enough.

### 3.6 Immediate vs consolidation settlement
The `E_oed`-based method gives **drained, one-dimensional constrained settlement**, which is the primary consolidation settlement for saturated clay and essentially the total settlement for sand. For the current screening implementation, separating "immediate" and "consolidation" is not necessary if `E_oed` is used consistently.

If you want to be more rigorous, split:
```
S_i (immediate, undrained)   — use E_u, ν = 0.5, elastic half-space solution
S_c (consolidation, drained) — use E_oed, method above
S_total = S_i + S_c
```
For the current Stage 6 screening implementation, the `E_oed` sum alone is defensible.

### 3.7 Time curve for clay layers — same as §2.8
Same Terzaghi 1D consolidation formulas apply.

### 3.8 Outputs
- Table per sublayer: `z_i, σ'_v,0, Δσ_v, σ'_v,f, E_oed, Δε, ΔS`
- Profile plots: `Δσ_v(z)`, `E_oed(z)`, cumulative `S(z)`
- Total `S`
- Truncation depth + criterion
- (Optional) `S(t)` for clay layers

### 3.8A Current implemented settlement form in the app

The current app implementation should be understood as:

**Evaluation location**
```
settlement = vertical settlement beneath the centre of the loaded area
```
meaning:
- strip footing → centreline in section
- rectangle / square / slab → centre of plan footprint

So the current app does **not** yet calculate:
- edge settlement
- average settlement over the whole loaded area
- differential settlement between two distinct points

The current implemented outputs are:
- total settlement `S_total`
- per-layer settlement contribution
- sublayer audit table
- cumulative settlement versus depth
- optional settlement time curve

The current app also implements these practical settings:
- stress method selectable:
  - Boussinesq
  - 2:1
- truncation setting selectable:
  - `Δσ_v < 10% σ'_v,0`
  - `Δσ_v < 20% q_net`
  - `CPT bottom`

and currently defaults to:
```
truncation = CPT bottom
```
in the user interface.

### 3.9 Inputs for Option B

```python
# --- INPUTS for Option B: Settlement estimator ---

# [SHARED]
profile            # from §1.5 (σ_v, σ'_v already computed)
cpt.layers         # E_oed_ref, m, c, phi per layer

# [USER] — footing geometry
footing_type   # ENUM {"slab", "strip", "rectangular", "square", "circular"}
D_f            # [m] founding depth below ground surface

# Conditional on footing_type:
if footing_type == "strip":
    B              # [m] strip width
    # L = inf  (plane strain)

if footing_type in {"rectangular", "slab"}:
    B              # [m] width (shorter side)
    L              # [m] length (longer side)

if footing_type == "square":
    B              # [m] side length
    # L = B

if footing_type == "circular":
    D_circ         # [m] diameter
    # convert internally: B = L = D_circ * sqrt(pi)/2  (equal-area square)

# [USER] — loads (Option B is SLS only)
G_k            # [kN] or [kN/m²] characteristic permanent load
Q_k_lead       # [kN] or [kN/m²] leading variable load (characteristic)
Q_k_other      # [kN] or [kN/m²] list of other variable loads (characteristic)
use_category   # ENUM {"A","B","C","D","E","W","S","T"}  → picks ψ₂ from §9.2.2

# [DEFAULT]
combination        = "quasi_permanent"  # EN 1997-1 §2.4.8(2) default for settlement
                                        # alternatives: "characteristic", "frequent"
truncation_rule    = "10%_sigma_eff"    # {"10%_sigma_eff", "20%_q_net", "CPT_bottom"}
dz                 = 0.10               # [m] sublayer thickness (inherits from §1)
include_consolidation_time = False      # if True, compute S(t) for clay layers

# --- INTERNAL COMPUTATION ---
# q_gross = SLS_combination(G_k, Q_k_lead, Q_k_other, ψ₂ from use_category) / (B*L)
# q_net   = q_gross - σ_v(D_f)
# For each sublayer below D_f:
#   Δσ_v from Boussinesq centreline (4-quadrant superposition for rectangle)
#   E_oed at σ_mean = σ'_v,0 + 0.5·Δσ_v
#   ΔS = (Δσ_v / E_oed) · dz
# Truncate when criterion met; sum ΔS.

# --- OUTPUTS ---
result = {
    "q_gross":          float,   # [kPa]
    "q_net":            float,   # [kPa]
    "S_total":          float,   # [mm]
    "S_per_layer":      list,    # [mm]
    "z_truncation":     float,   # [m] depth at which integration stopped
    "truncation_cause": str,     # which rule triggered
    "per_sublayer":     list[{   # full audit trail
        "z_mid":    float,
        "sigma_eff_0": float,
        "delta_sigma_v": float,
        "sigma_eff_f": float,
        "E_oed":    float,
        "delta_eps": float,
        "dS":       float,
    }],
    "S_t":              list|None,  # time curve if requested
    "limit_state":      "SLS",
    "load_comb":        "quasi-permanent",
    "soil_params":      "characteristic",
}
```

**Reminder:** for the separate **bearing-capacity ULS check** (Brinch-Hansen / Vesić), see §9.6 — that is a different function with ULS load combination (`γ_G=1.35, γ_Q=1.50`) and M2-factored soil strengths (`φ'_d`, `c'_d`). Don't mix it into the settlement routine.

---

## 4. Option C — Slab bending & reinforcement

Option C provides a CPT-linked structural screening route for bending and reinforcement of strips / beams on elastic foundation, plus the associated EC2 reinforcement check.

### 4.1 Modulus of subgrade reaction `k_s` from CPT

`k_s` has units **kN/m³** (pressure per unit settlement). It is **not a soil property** — it depends on footing size, shape, and stiffness, and on the soil stiffness profile.

#### 4.1.1 Vesić (1961) formula — the one to use
For a strip or rectangular footing of width `B`, thickness `h`, stiffness `E_b`, moment of inertia `I_b` on a soil with Young's modulus `E_s` and Poisson's ratio `ν_s`:
```
k_s = (0.65 / B) · (E_s / (1 − ν_s²)) · ⁿ√( E_s·B⁴ / (E_b·I_b) )   
```
with `n = 12` (twelfth root). Explicit form:
```
k_s = (0.65 · E_s) / ( B · (1 − ν_s²) ) · [ E_s·B⁴ / (E_b·I_b) ]^(1/12)
```
The twelfth root makes `k_s` very weakly dependent on `E_b·I_b` — this is intentional (Vesić's whole point).

#### 4.1.2 What `E_s` to use from the CPT
The HS `E_oed,ref` is an **oedometric** (zero-lateral-strain, `ν = 0`) stiffness. In elastic terms:
```
E_oed = E · (1 − ν) / [ (1 + ν)·(1 − 2ν) ]
```
For Winkler/Vesić you want the **drained Young's modulus at the stress state under the footing**. Two options:

**Option 1 (simple, consistent with oedometric assumptions):** treat the Winkler spring as oedometric — use `E_oed` directly and `ν_s = 0` in Vesić. This is what Kotsanis-Pantelidis (2020) recommends for consistency with Winkler deformation (compression without lateral strain):
```
E_s = E_oed,i,mean            ν_s = 0
```
where `E_oed,i,mean` is thickness-weighted-averaged over the **influence zone** (roughly `z = 0` to `z = 2B` below the footing).

**Option 2 (classical):** use Young's modulus with typical `ν_s`:
```
E_s ≈ E_oed · (1 + ν_s)·(1 − 2·ν_s) / (1 − ν_s)      with ν_s = 0.30
     ≈ 0.74 · E_oed
ν_s ≈ 0.30       (drained, sand)   or 0.20 (stiff clay, undrained ν = 0.5)
```
For your CSV the `ν_ur = 0.20` already — that's the HS unload-reload Poisson's ratio and is a reasonable drained value.

Current Stage 6 route: offer both, with Option 1 (`E_s = E_oed`, `ν_s = 0`) as default because it is self-consistent with the present `E_oed,ref` derivation route.

#### 4.1.3 Influence-zone averaging
```
z_influence = 2·B   (rule of thumb; use 1·B for strip, 2·B for square, up to 2·L for long rectangle)
E_s,avg = Σ(E_oed,i · Δz_i) / Σ Δz_i    over z ∈ [D_f, D_f + z_influence]
```
If stiffness varies strongly with depth, a weighted average with influence-factor weighting can be justified. For the current screening implementation, the simple arithmetic thickness-weighted mean is adequate.

### 4.2 Beam on elastic foundation — the governing equation
For a beam of width `b`, bending stiffness `EI`, on a Winkler foundation of modulus `k_s` (kN/m³):
```
EI · d⁴w/dx⁴ + k_s · b · w(x) = q(x)
```
Let `k = k_s · b` be the **line spring stiffness** (kN/m per m beam, i.e. kN/m²). Then:
```
EI · w''''(x) + k · w(x) = q(x)
```

### 4.3 Characteristic length
The length scale over which loads spread:
```
λ = ⁴√( 4·EI / k ) = ⁴√( 4·EI / (k_s · b) )       [m]
β = 1/λ                                              [1/m]
```

**Classification** (Hetényi, 1946):
```
β·L < π/4  ≈ 0.79    → "short" beam, nearly rigid on soil
π/4 ≤ β·L ≤ π       → intermediate (use general finite-beam solution)
β·L > π               → "long" beam, can use infinite-beam solution
```

### 4.4 Infinite beam with concentrated load `P` at origin
Displacement, slope, moment, shear at distance `x ≥ 0`:
```
A(βx) = e^(−βx) · [cos(βx) + sin(βx)]
B(βx) = e^(−βx) · sin(βx)
C(βx) = e^(−βx) · [cos(βx) − sin(βx)]
D(βx) = e^(−βx) · cos(βx)

w(x) = (P · β) / (2·k) · A(βx)
θ(x) = −(P · β²) / k · B(βx)
M(x) = P / (4·β) · C(βx)
V(x) = −P / 2 · D(βx)
```
**Maximum bending moment** (under the load, `x = 0`):
```
M_max = P / (4·β) = (P · λ) / 4
```
This is the single most useful formula for screening: **a point load P on a beam on soil produces M_max = P·λ/4.**

### 4.5 Infinite beam with concentrated moment `M_0` at origin
```
w(x) = (M_0 · β²) / k · B(βx)
M(x) = (M_0 / 2) · D(βx)      [same sign as M_0 at x=0]
```

### 4.6 Infinite beam with uniform line load `q` over length `2a`, centred at origin
Centreline (x = 0):
```
w(0)   = q/k · [1 − D(βa)]               # when a ≫ λ  →  w = q/k, M = 0 (fully supported)
M(0)   = q/(2β²) · B(βa)                 # maximum positive moment
```
For distributed load inboard of edges, moments decay quickly as load length grows beyond `~3λ`.

### 4.7 Finite beam of length `L` with free ends — superposition method
Use the **method of end-conditioning forces** (Hetényi): solve the infinite-beam response, then add end shear and moment corrections so shear and moment vanish at `x = 0` and `x = L`. This is tedious but fully analytical. For practical use:
- If `β·L > π` (about 4 m for typical concrete strip on medium sand): use infinite-beam formulas directly, error < 5%.
- If `β·L < π`: solve the ODE numerically (finite differences with ~100 nodes, or transfer matrix).

Current interpretation: the infinite-beam formulas are appropriate when `β·L > π`; otherwise a finite-beam numerical solve is preferred.

### 4.8 Slab on elastic foundation (plate, not beam)
For a plate of thickness `h`, `E`, `ν`:
```
D = E · h³ / (12·(1 − ν²))                 # plate bending stiffness, kN·m

EI → D
Governing:  D · ∇⁴w + k_s · w = q(x,y)
```
Characteristic length:
```
ℓ = ⁴√( D / k_s )
```
Under a concentrated load `P` on an infinite plate (Timoshenko & Woinowsky-Krieger; Westergaard 1926 interior case):
```
w(0) = P / (8·k_s·ℓ²)
M_r + M_θ at x = 0 ≈ (P / 4π) · [ ln(ℓ/r_eq) + 0.6159 ]     (Westergaard, interior load)
```
where `r_eq = √(a² + h²) − 0.675·h` for loaded radius `a < 1.724·h`, else `r_eq = a`.

For a **uniformly loaded rectangular slab** on Winkler foundation, closed-form solutions are cumbersome — use Timoshenko's series or FE. For screening, use:
- interior point load → Westergaard formula above
- edge/corner loads → Westergaard edge/corner formulas (different coefficients, see any slab-on-grade reference)

For true 2D plates, FE or a dedicated plate solver remains the appropriate route; the current app stays intentionally at strip level.

### 4.8A Pasternak foundation and current 1D implementation
The Pasternak two-parameter foundation is the current extension beyond pure Winkler in Stage 6. It keeps the vertical spring term from Winkler, but adds a **shear-interaction layer** between the springs so neighboring points on the soil can interact.

That fixes the biggest weakness of Winkler:
- Winkler: each spring acts independently
- Pasternak: the soil support spreads locally through an added shear layer

So Pasternak is especially useful when:
- you have slabs rather than narrow beams
- you expect local load spreading in the support
- pure Winkler gives unrealistically sharp local curvature or too little lateral coupling

#### 4.8A.1 Foundation law
Write the foundation reaction as:
```
p(x,y) = k_s · w(x,y) − G_p · ∇²w(x,y)
```
where:
- `k_s` = Winkler vertical subgrade modulus `[kN/m³]`
- `G_p` = Pasternak shear-interaction parameter `[kN/m]`
- `w` = downward deflection `[m]`

The second term is what spreads support laterally. If `G_p = 0`, you recover the ordinary Winkler model.

#### 4.8A.2 Beam on Pasternak foundation
For a beam/strip of width `b`, stiffness `EI`, with distributed load `q(x)`:
```
EI · w''''(x) − G_p,lin · w''(x) + k_lin · w(x) = q(x)
```
with:
```
k_lin   = k_s · b          [kN/m²]
G_p,lin = G_p · b          [kN]
```

This is the current Stage 6 extension of the Winkler strip model: the numerical beam solver keeps the same foundation ODE structure and adds the `−G_p,lin · w''` coupling term.

#### 4.8A.3 Plate on Pasternak foundation
For a plate of bending stiffness `D`:
```
D · ∇⁴w − G_p · ∇²w + k_s · w = q(x,y)
```
This is much more suitable for a real slab than a 1D strip model. It gives `w(x,y)` and, from the plate curvatures, the bending moments:
```
M_x  = −D · (w,xx + ν · w,yy)
M_y  = −D · (w,yy + ν · w,xx)
M_xy = −D · (1 − ν) · w,xy
```

For a rectangular slab this is already a genuine plate problem, not a beam approximation.

#### 4.8A.4 What extra parameter is needed?
Winkler needs only `k_s`. Pasternak needs:
- `k_s`  vertical stiffness
- `G_p`  shear interaction

`k_s` can stay exactly as in §4.1 using the Vesić/CPT route.

`G_p` is the hard part. It is **not** directly available from the current CPT workflow, so you must derive it from a rational engineering approximation.

#### 4.8A.5 First-pass CPT-based route for `G_p`
For a first implementation, define an equivalent soil shear layer over the same influence depth used for `E_s` averaging:
```
H_p = z_influence     (default ~ 2·B)
G_s,avg = E_s,avg / [2·(1 + ν_s)]
G_p ≈ η · G_s,avg · H_p
```
where:
- `E_s,avg` comes from the CPT-derived stiffness profile, as in §4.1
- `ν_s` is the same Poisson ratio used in the `E_s` conversion
- `η` is an empirical shape/calibration factor

This gives the right units:
```
[kPa] · [m] = [kN/m]
```

For the current screening implementation, keeping `η = 1.0` as the default is reasonable. But `η` should be presented as **calibration-dependent**, not as a universal soil constant. Kerr (1964), for example, derives `η = 1/6` for a plane-strain shear layer of finite thickness, which is much lower than the broad screening range often used in practice. So the practical reading for the app is:
- `η = 1.0` default for initial screening
- override or calibrate `η` if better benchmark data or FE back-analysis is available

**Current app implementation note**

In the present Stage 6 implementation, the Pasternak screening parameter is derived exactly as:
```
G_p = η · G_s,avg · H_p
```
with:
- `H_p = z_influence`
- `z_influence` = the user input `Influence depth for Es averaging (m)`
- `G_s,avg = E_s,avg / [2·(1 + ν_s)]`

The app obtains `E_s,avg` as a thickness-weighted average over the zone:
```
z = Df  ...  Df + z_influence
```
using the current CPT-derived stiffness profile at the local effective stress.

So, in practical app terms:
- `H_p` = “how thick the active averaging zone below the foundation is”
- `G_s,avg` = “the average shear modulus of the soil in that same zone”

By default, the app uses the route:
```
E_s = E_oed
ν_s = 0
```
which means:
```
G_s,avg = E_s,avg / 2
```

So under the default Stage 6 beam/slab settings, the inferred Pasternak parameter becomes:
```
G_p = η · 0.5 · E_s,avg · H_p
```

Example:
```
E_s,avg = 6016 kPa
ν_s = 0
G_s,avg = 3008 kPa
H_p = 2.0 m
η = 1.0
=> G_p = 1.0 · 3008 · 2.0 = 6016 kN/m
```

**Important engineering note:** this `G_p` route is a screening approximation, not a code-calibrated Belgian design value. If you implement it, the UI should state clearly that the Pasternak shear parameter is inferred from CPT-derived stiffness and should be treated as **experimental / model-dependent** unless calibrated against a more advanced continuum or FE model.

#### 4.8A.6 Practical interpretation
Compared with Winkler:
- increasing `k_s` makes the support stiffer vertically
- increasing `G_p` makes the support distribute load more laterally

Typical effect of Pasternak relative to Winkler:
- lower local peaks in deflection
- broader bending-moment distribution
- often more realistic slab behavior for local/patch loading

For a full-area uniform load, however, even Pasternak will still tend toward nearly uniform settlement with limited bending. So it does **not** turn a uniformly loaded free slab into a high-moment case by itself.

#### 4.8A.7 Current scope boundary
The current app implements the **1D Pasternak strip / beam** route. A true **2D Pasternak plate** remains outside the present scope and would require a dedicated plate solver or FE workflow.

### 4.9 Structural design from `M_Ed`
Once `M_max` is known (and convert to design value with partial factor, `M_Ed = γ_Q · M_max` or similar):

Eurocode 2 singly reinforced rectangular section, width `b_w` = 1 m (per-meter basis for slabs):
```
f_cd = f_ck / γ_C             γ_C = 1.5
f_yd = f_yk / γ_S             γ_S = 1.15
d    = h − c_nom − φ_bar/2

μ   = M_Ed / (b_w · d² · f_cd)     # normalized moment
ω   = 1 − √(1 − 2·μ)                # mechanical reinforcement ratio (simplified rectangular stress block)
A_s,req = ω · b_w · d · f_cd / f_yd
```

Minimum reinforcement (EN 1992-1-1 §9.2.1.1):
```
A_s,min = max( 0.26 · (f_ctm / f_yk) · b_w · d ,  0.0013 · b_w · d )
where f_ctm = 0.30 · f_ck^(2/3)   for f_ck ≤ 50 MPa
```

Ductility and reinforcement-limit check:
```
x/d ≤ 0.45    for C ≤ 50/60    (EC2 ductility)
```

Flag if `μ > 0.295` (approx) → section is outside the intended singly reinforced range; increase `h`.

### 4.10 Outputs
- `k_s` (kN/m³) + how derived (Vesić, `E_s` avg, `ν_s`)
- `λ` (m), `β·L` classification
- Bending moment envelope `M(x)` for the applied load case
- `M_max` and location
- `A_s,req` (mm²/m), `A_s,min`, governing value
- Optional: bar spacing suggestion given `A_s,req` and a user-picked bar diameter
- Diagnostic plot: `w(x)`, `M(x)`, `V(x)` along beam

### 4.11 Inputs for Option C

Option C splits into three sub-modules: (a) `k_s` from CPT, (b) Winkler beam/plate analysis, (c) EC2 reinforcement design. Inputs are listed per sub-module.

#### 4.11.a — `k_s` computation (Vesić)

```python
# [SHARED]
profile            # from §1.5
cpt.layers[*].Eoed_ref, .m, .c, .phi, .nu_ur

# [USER]
B              # [m] footing/beam width — FROM THE STRUCTURE the user is designing.
               # If user is sizing a strip footing, this is the strip width.
               # If sizing a slab-on-grade, this is the slab dimension for k_s
               # size correction (use shorter plan dimension).
D_f            # [m] founding depth
Eb             # [kPa] Young's modulus of the structural element (e.g. 33e6 for C30/37)
Ib             # [m^4] moment of inertia of the element cross-section per meter width
               #       For a rectangular slab of thickness h: Ib = h^3 / 12  (per m width)

# [DEFAULT]
Es_mode     = "oedometric"   # {"oedometric" → Es=E_oed, ν_s=0;
                             #  "young_drained" → Es = E_oed · (1+ν)(1-2ν)/(1-ν) with ν=0.30}
z_influence = 2 * B          # [m] depth over which E_s is averaged, from D_f downward
                             # override only with geotechnical justification

# --- OUTPUT ---
ks            # [kN/m^3] modulus of subgrade reaction for this geometry
```

#### 4.11.b — Beam/plate on Winkler (analytical)

```python
# [SHARED from 4.11.a]
ks            # [kN/m^3]

# [USER] — structural geometry
element_type   # ENUM {"beam_strip", "plate_slab"}
L              # [m] length of the beam (strip footing or ground beam)
b              # [m] cross-section width of the beam  (= B in most cases; re-stated so
               #     user can distinguish "beam width" from "effective soil width")
h              # [m] section thickness
Ec             # [kPa] concrete Young's modulus (e.g. 33e6 for C30/37)

# [USER] — loading. Option C is where SLS and ULS DIVERGE:
limit_state    # ENUM {"SLS_deflection", "ULS_bending"}

# For ULS_bending — apply Eq. 6.10 (Belgian NA) internally:
G_k            # [kN] or [kN/m] characteristic permanent
Q_k_lead       # [kN] or [kN/m] leading variable (characteristic)
Q_k_other      # list of other characteristic variables
use_category   # ENUM for ψ₀, ψ₂ selection (§9.2.2)

# For SLS_deflection — user chooses combination (default qp for foundations):
sls_combination = "quasi_permanent"   # {"quasi_permanent", "frequent", "characteristic"}

# Load distribution along the beam:
load_pattern   # ENUM {"point_load_at_x",
               #       "line_load_uniform",
               #       "line_load_partial",
               #       "multiple_point_loads"}
# parameters depend on pattern, e.g.
if load_pattern == "point_load_at_x":
    x_load     # [m] position from left end

# [DEFAULT]
n_nodes_if_FD  = 200    # used only if βL < π and numerical solve kicks in
allowable_deflection = L/500   # [m] default SLS check

# --- INTERNAL ---
# λ = (4·EI / (ks·b))^(1/4),  β = 1/λ,  βL classification.
# Compute load effects at chosen limit state.

# --- OUTPUT ---
result = {
    "ks":        float,
    "lambda":    float,        # [m]
    "betaL":     float,
    "classification": str,     # "short" / "intermediate" / "long"
    "M_x":       list,         # bending moment envelope along x [kNm or kNm/m]
    "V_x":       list,         # shear envelope                 [kN  or kN/m]
    "w_x":       list,         # deflection along x              [mm]
    "M_max":     float,
    "M_max_pos": float,        # x-coordinate of M_max [m]
    "w_max":     float,        # [mm]
    "utilisation_SLS": float|None,  # w_max / allowable_deflection
    "limit_state":   str,      # echoes input
    "load_comb":     str,      # "Eq.6.10" or "SLS_qp" etc.
}
```

#### 4.11.c — Reinforcement design (EC2, ULS only)

**This is the "something else" alongside material strength you were trying to remember: exposure class + structural class, driving minimum cover `c_nom`.** Together with `f_ck`, `f_yk`, `γ_C`, `γ_S`, these fully parametrise an EC2 bending design.

```python
# [SHARED]
M_Ed           # [kNm/m] design bending moment from 4.11.b (ULS_bending output)
               # if that module was run; else user enters directly

# [USER — materials & exposure]
f_ck           # [MPa] concrete characteristic cylinder strength (e.g. 30 for C30/37)
f_yk           # [MPa] steel characteristic yield strength       (e.g. 500 for BE500)
exposure_class # ENUM {"X0","XC1","XC2","XC3","XC4","XD1","XD2","XD3",
                      # "XS1","XS2","XS3","XF1","XF2","XF3","XF4",
                      # "XA1","XA2","XA3"}
                # EN 1992-1-1 §4.2 + EN 206. Typical Belgian cases:
                #   XC1 — dry internal / permanently wet
                #   XC2 — wet, rarely dry (foundations below WT)
                #   XC3 — moderate humidity (sheltered external)
                #   XC4 — cyclic wet/dry  (foundations above WT, outer walls)

structural_class_adjustment  = {
    "design_life_100y":        +2,   # else 0 for 50-year design
    "member_is_slab_or_plate": -1,   # platform-like load paths
    "special_QC":              -1,   # factory precast
    "high_strength_concrete":  -1,   # C ≥ C35/45 for XC; C ≥ C40/50 for XD/XS
}
# Starting class S4 (50 years), apply deltas, clamp to [S1, S6]

# [USER — geometry & detailing]
h              # [m] slab/beam section thickness  (inherited from 4.11.b)
b_w            # [mm] section width for reinforcement (default 1000 for slabs)
phi_bar        # [mm] rebar diameter (e.g. 12, 16)

# [DEFAULT]
delta_c_dev    = 10    # [mm] execution tolerance:
                       #   10 mm on site (EC2 default)
                       #    5 mm for factory-controlled precast
                       #    0 mm only if actual cover is monitored (rare)

alpha_cc       = 1.00  # Belgian NA
alpha_ct       = 1.00  # Belgian NA
gamma_C        = 1.50  # ULS persistent/transient
gamma_S        = 1.15  # ULS persistent/transient

# --- INTERNAL COMPUTATION ---
# 1. structural_class = 4 + sum(applicable structural_class_adjustment deltas)
# 2. c_min_dur = lookup(Table 4.4N, structural_class, exposure_class)
# 3. c_min_b   = phi_bar   (EN 1992-1-1 §4.4.1.2(3))
# 4. c_min     = max(c_min_dur, c_min_b, 10)
# 5. c_nom     = c_min + delta_c_dev
# 6. d         = h*1000 - c_nom - phi_bar/2          [mm]
# 7. f_cd      = alpha_cc * f_ck / gamma_C
# 8. f_yd      = f_yk / gamma_S
# 9. μ         = M_Ed*1e6 / (b_w * d² * f_cd)        # M_Ed in kNm → N·mm; b_w in mm
# 10. assert μ < 0.295  (singly-reinforced ductility limit for C ≤ 50/60; raise h if not)
# 11. ω        = 1 − √(1 − 2μ)
# 12. As_req   = ω · b_w · d · f_cd / f_yd           [mm²/m]
# 13. f_ctm    = 0.30 · f_ck^(2/3)                    [MPa]
# 14. As_min   = max(0.26·f_ctm/f_yk, 0.0013) · b_w · d     [mm²/m]
# 15. As       = max(As_req, As_min)

# --- OUTPUT ---
result = {
    "structural_class": int,      # S1..S6
    "c_min_dur":        float,    # [mm]
    "c_nom":            float,    # [mm]
    "d":                float,    # effective depth [mm]
    "f_cd":             float,    # [MPa]
    "f_yd":             float,    # [MPa]
    "mu":               float,    # utilisation of concrete
    "omega":            float,
    "As_req":           float,    # [mm²/m]
    "As_min":           float,    # [mm²/m]
    "As_provided_note": "choose bar diameter + spacing s.t. As_bar*1000/s ≥ As",
    "limit_state":      "ULS",
    "load_comb":        "Eq.6.10",
    "code":             "EN 1992-1-1 + NBN EN 1992-1-1 ANB",
}
```

---

## 5. Technical pseudocode summary (matches the math above)

```python
# === Shared core ===
def build_profile(layers, z_w, dz=0.10):
    """Discretise CSV layers into sublayers of thickness dz."""
    profile = []
    for lay in layers:
        n = int(round((lay.Bot_m - lay.Top_m) / dz))
        for j in range(n):
            z_mid = lay.Top_m + (j + 0.5)*dz
            gamma_eff = lay.gamma_sat if z_mid > z_w else lay.gamma
            profile.append(Sublayer(z_mid=z_mid, dz=dz, layer=lay, gamma=gamma_eff))
    return profile

def insitu_stresses(profile, z_w, gamma_w=9.81):
    sigma_v = 0.0
    for s in profile:
        # integrate total stress
        sigma_v += s.gamma * s.dz
        s.sigma_v_top = sigma_v - s.gamma*s.dz     # total stress at top of sublayer
        s.sigma_v_mid = sigma_v - 0.5*s.gamma*s.dz
        s.u = gamma_w * max(0.0, s.z_mid - z_w)
        s.sigma_eff = s.sigma_v_mid - s.u

def E_oed_at(sigma_eff, layer, p_ref=100.0):
    num = layer.c*1/tan(radians(layer.phi)) + sigma_eff if layer.c > 0 else sigma_eff
    den = layer.c*1/tan(radians(layer.phi)) + p_ref      if layer.c > 0 else p_ref
    return layer.Eoed_ref * (num/den)**layer.m


# === Option B: Settlement ===
def boussinesq_rect_corner(q_net, B, L, z):
    mN = B/z; nN = L/z
    V  = mN**2 + nN**2 + 1.0
    V1 = (mN*nN)**2
    A  = (2*mN*nN*sqrt(V)) / (V + V1)
    Bc = (V + 1.0) / V
    num = 2*mN*nN*sqrt(V)
    if V == V1:
        atan_term = pi / 2.0
    else:
        atan_term = atan(num/(V - V1))
        if V < V1:
            atan_term += pi
    Iz = (1.0/(4*pi)) * (A*Bc + atan_term)
    return q_net * Iz

def settlement(profile, footing, q_net, truncation_rule="10%_sigma_eff"):
    """Centreline settlement of rectangular footing B x L at founding depth Df."""
    S = 0.0
    audit = []
    z_trunc = None
    cause = None
    for s in profile:
        if s.z_mid < footing.Df: continue
        z_rel = s.z_mid - footing.Df
        # 4-quadrant superposition for centre under rectangle
        dsig = 4 * boussinesq_rect_corner(q_net, footing.B/2, footing.L/2, z_rel)
        sigma_mean = s.sigma_eff + 0.5*dsig
        Eoed = E_oed_at(sigma_mean, s.layer)
        deps = dsig / Eoed
        dS   = deps * s.dz
        S   += dS
        audit.append(dict(
            z_mid=s.z_mid, sigma_eff_0=s.sigma_eff,
            delta_sigma_v=dsig, sigma_eff_f=s.sigma_eff + dsig,
            E_oed=Eoed, delta_eps=deps, dS=dS,
        ))
        if truncation_rule == "10%_sigma_eff" and dsig < 0.10 * s.sigma_eff:
            z_trunc, cause = s.z_mid, "Δσ_v < 10% σ'_v,0"
            break
        elif truncation_rule == "20%_q_net" and dsig < 0.20 * q_net:
            z_trunc, cause = s.z_mid, "Δσ_v < 20% q_net"
            break
        # "CPT_bottom" -> loop until profile ends naturally
    return dict(S_total=S, per_sublayer=audit,
                z_truncation=z_trunc, truncation_cause=cause)


# === Bearing capacity ===
def bearing_capacity(layer, footing, stresses, route="EC7_DA1_governing", gamma_Rd=1.0, xi=2.0):
    q_eff = stresses.sigma_eff_foundation
    q_tot = stresses.sigma_total_foundation
    gamma_eff = stresses.gamma_eff_below_base

    def drained(phi_deg, c_eff):
        phi = radians(phi_deg)
        Nq = exp(pi * tan(phi)) * tan(pi/4 + phi/2)**2
        Nc = (Nq - 1) / tan(phi) if phi_deg > 0 else 5.14
        Ng = 2 * (Nq + 1) * tan(phi)
        return c_eff * Nc * footing.s_c + q_eff * Nq * footing.s_q + 0.5 * gamma_eff * footing.B * Ng * footing.s_g

    def undrained(cu):
        return q_tot + 5.14 * cu * footing.s_cu

    if route == "global_xi":
        return dict(
            q_allow_drained=drained(layer.phi, layer.c) / xi,
            q_allow_undrained=undrained(layer.cu) / xi
        )

    # Belgian DA1 envelope
    qd11_d = drained(layer.phi, layer.c) / gamma_Rd
    qd11_u = undrained(layer.cu) / gamma_Rd
    phi_d = degrees(atan(tan(radians(layer.phi)) / 1.25))
    c_d = layer.c / 1.25
    cu_d = layer.cu / 1.40
    qd12_d = drained(phi_d, c_d) / gamma_Rd
    qd12_u = undrained(cu_d) / gamma_Rd
    return dict(
        q_d_drained=min(qd11_d, qd12_d),
        q_d_undrained=min(qd11_u, qd12_u)
    )


# === Option C: Winkler beam ===
def ks_vesic(Es, nu_s, B, EbIb):
    return (0.65 * Es) / (B * (1 - nu_s**2)) * (Es * B**4 / EbIb)**(1/12)

def oedometric_to_young(E_oed, nu):
    return E_oed * (1 + nu) * (1 - 2*nu) / (1 - nu)

def Es_average(profile, Df, B, mode="oedometric", nu=0.30):
    z_end = Df + 2*B
    num = 0.0; den = 0.0
    for s in profile:
        if s.z_mid < Df or s.z_mid > z_end: continue
        Eoed = E_oed_at(s.sigma_eff, s.layer)
        E = Eoed if mode == "oedometric" else oedometric_to_young(Eoed, nu)
        num += E * s.dz; den += s.dz
    return num/den

def beam_on_winkler_point_load(P, beam, ks):
    k = ks * beam.b
    beta = (k / (4*beam.EI))**0.25
    lam  = 1/beta
    M_max = P / (4*beta)      # = P*lam/4
    betaL = beta * beam.L
    classification = "long" if betaL > pi else ("intermediate" if betaL > pi/4 else "short")
    return dict(k_s=ks, beta=beta, lam=lam, M_max=M_max, betaL=betaL, classification=classification)

def M_x_point_load(x, P, beta, k):
    bx = beta*abs(x)
    C = exp(-bx) * (cos(bx) - sin(bx))
    return P/(4*beta) * C

def design_reinforcement(M_Ed, h, c_nom, phi_bar, fck, fyk, b_w=1000, gammaC=1.5, gammaS=1.15):
    fcd = fck / gammaC;  fyd = fyk / gammaS
    d   = h - c_nom - phi_bar/2
    mu  = M_Ed*1e6 / (b_w * d**2 * fcd)      # units: N, mm
    assert mu < 0.295, "Section under-reinforced — increase h"
    omega = 1 - sqrt(1 - 2*mu)
    As_req = omega * b_w * d * fcd / fyd     # mm²/m
    fctm   = 0.30 * fck**(2/3)
    As_min = max(0.26*fctm/fyk, 0.0013) * b_w * d
    return dict(d=d, mu=mu, As_req=As_req, As_min=As_min, As=max(As_req, As_min))

def _test_boussinesq():
    """Regression checks against published values."""
    tol = 1e-3

    I = boussinesq_rect_corner(1.0, 1.0, 1.0, 1.0)
    assert abs(I - 0.1752) < tol

    sig = boussinesq_rect_corner(80.0, 2.0, 4.0, 5.0)
    assert abs(sig - 7.45) < 0.01

    sig_c = 4.0 * boussinesq_rect_corner(1.0, 1.0, 1.0, 2.0)
    assert abs(sig_c - 0.336) < tol

    I_v = boussinesq_rect_corner(1.0, 2.0, 2.0, 1.0)
    assert abs(I_v - 0.2325) < tol

    I_inf = boussinesq_rect_corner(1.0, 100.0, 100.0, 1.0)
    assert abs(I_inf - pi/8) < 1e-3

    sig_strip = boussinesq_strip_centreline(1.0, 2.0, 1.0)
    assert abs(sig_strip - 0.8183) < tol


# === Option A: Dewatering ===
def sichardt_R(s, k, C=3000.0):
    return C * s * sqrt(k)

def dupuit_unconfined_h_r(r, Q, k, h_w, r_w, R):
    if r >= R: return None  # outside influence, h = h_0
    return sqrt(h_w**2 + (Q/(pi*k)) * log(r/r_w))

def dewatering_settlement(profile, z_w_old, z_w_new, gamma_w=9.81):
    S = 0.0
    for s in profile:
        u_old = gamma_w * max(0, s.z_mid - z_w_old)
        u_new = gamma_w * max(0, s.z_mid - z_w_new)
        sig_eff_old = s.sigma_v_mid - u_old
        sig_eff_new = s.sigma_v_mid - u_new     # σ_v unchanged (conservative)
        dsig = sig_eff_new - sig_eff_old
        if dsig <= 0: continue
        sigma_mean = 0.5*(sig_eff_old + sig_eff_new)
        Eoed = E_oed_at(sigma_mean, s.layer)
        S += (dsig / Eoed) * s.dz
    return S
```

---

## 6. Validation checks — required before trusting results

1. **Self-weight sanity**: integrate `γ(z)` and recover in-situ `σ'_v` matching your CSV-generating program within 0.1 kPa.
2. **Boussinesq closed form**: for strip width B=2 m, q=100 kPa, z=2 m → `Δσ_v ≈ 55 kPa` (classic result, check against any textbook figure).
3. **Rectangular corner benchmark**: for `m = n = 1`, `I_z = 0.1752`; for `m = n = 2`, `I_z = 0.2325`. These two checks catch both the wrong `B_factor` and the missing `+π` branch.
4. **Worked example benchmark**: `q = 80 kPa`, `B = 2 m`, `L = 4 m`, `z = 5 m` → `Δσ_v,corner ≈ 7.45 kPa`.
5. **Rectangular centreline superposition**: `B = L = 2 m`, `z = 2 m`, `q = 1 kPa` → `Δσ_v,center ≈ 0.336 kPa`.
6. **Large-footing limit**: `I_z → π/8 ≈ 0.2498` as `m, n → ∞`.
7. **Winkler point load**: for `P=100 kN`, `EI=1.5e5 kN·m²` (0.4×0.6 m concrete beam), `k_s=20 000 kN/m³`, `b=0.4 m` → `λ ≈ 1.32 m`, `M_max ≈ 33 kNm`. Your code should reproduce this.
8. **Settlement regression**: synthetic uniform layer E_oed=10 MPa, q_net=100 kPa, 2×2 m footing → hand calc via 2:1 method should match within 20% of your Boussinesq implementation.
9. **Vesić dimensional check**: `k_s` should land in the 5 000–100 000 kN/m³ range for typical soils. Way off → check unit conversion on `E_s·B⁴/(E_b·I_b)`.

---

## 7. Reference list

**Added/corrected:**
- Schanz, T., Vermeer, P.A. & Bonnier, P.G. (1999). The hardening soil model: formulation and verification. *Beyond 2000 in Computational Geotechnics*, Balkema.
- Vesić, A.B. (1961). Bending of beams resting on isotropic elastic solid. *J. Eng. Mech. Div. ASCE*, 87(EM2): 35–53.
- Vesić, A.B. (1961). Beams on elastic subgrade and Winkler's hypothesis. *Proc. 5th ICSMFE, Paris*, 1: 845–850.
- Pasternak, P.L. (1954). *On a New Method of Analysis of an Elastic Foundation by Means of Two Foundation Constants*. Gosudarstvennoe Izdatelstvo Literatury po Stroitelstvu i Arkhitekture, Moscow. [Russian]
- Kerr, A.D. (1964). Elastic and viscoelastic foundation models. *Journal of Applied Mechanics*, 31(3): 491–498.
- Hetényi, M. (1946). *Beams on Elastic Foundation*. University of Michigan Press.
- Newmark, N.M. (1935). Simplified computation of vertical pressures in elastic foundations. University of Illinois Eng. Exp. Station Circular 24.
- Fadum, R.E. (1948). Influence values for estimating stresses in elastic foundations. *Proc. 2nd ICSMFE*, 3: 77–84.
- Kyrieleis, W. & Sichardt, W. (1930). *Grundwasserabsenkung bei Fundierungsarbeiten*. Springer, Berlin.
- Louwyck, A., Vandenbohede, A., Libbrecht, D. et al. (2022). The Radius of Influence Myth. *Water*, 14(2): 149. MDPI.
- Powers, J.P. et al. (2007). *Construction Dewatering and Groundwater Control*, 3rd ed. Wiley.
- Kotsanis, D. & Pantelidis, L. (2020). On the modulus of subgrade reaction for shallow foundations on homogeneous or stratified mediums. *Proc. Geotech. Eng.*
- Timoshenko, S. & Woinowsky-Krieger, S. (1959). *Theory of Plates and Shells*, 2nd ed. McGraw-Hill.
- Westergaard, H.M. (1926). Stresses in concrete pavements computed by theoretical analysis. *Public Roads*, 7(2): 25–35.

**Keep from original:**
- EN 1992-1-1 (Eurocode 2) + Belgian NA — reinforcement design
- Terzaghi & Peck (1967) — 1D consolidation
- Boussinesq (1885) — elastic solutions
- Bear, J. (1979). *Hydraulics of Groundwater*. McGraw-Hill.
- Freeze, R.A. & Cherry, J.A. (1979). *Groundwater*. Prentice-Hall.
- Dupuit (1863), Thiem (1906) — classical groundwater-flow solutions

**For partial factors (Section 9):**
- EN 1990:2002+A1:2005 — *Basis of structural design*.
- NBN EN 1990 ANB:2005 — Belgian National Annex to EN 1990 (Eq. 6.10, ξ = 0.85, ψ factors).
- EN 1997-1:2004+A1:2013 — *Geotechnical design — General rules*, Annex A (normative partial factors).
- **NBN EN 1997-1 ANB:2022** — Belgian National Annex to EN 1997-1 (Design Approach 1).
- Buildwise Rapport 20 (2022) — *Richtlijnen voor de toepassing van de Eurocode 7 in België voor het ontwerp van paalfunderingen* (pile-specific model and correlation factors, referenced by NBN EN 1997-1 ANB:2022).
- EN 1992-1-1 + Belgian NA — concrete γ_C = 1.50, steel γ_S = 1.15, α_cc = α_ct = 1.00.

**Optional extension reference:**
- Poulos & Davis (1974) — useful if the app later adds a more explicit elastic-settlement route based on Young's modulus.

---

## 8. Transition from implemented characteristic models to code checks

Sections `0A ... 7` describe the **implemented physical models** now used in Stage 6: bearing resistance, settlement, dewatering response, and strip-on-foundation bending. The next section changes layer from soil/structure mechanics to **code-formatting of actions, strengths, and design values**.

So the split is:
- Sections `0A ... 7` = how the app computes the engineering response
- Section `10` = how characteristic values are turned into SLS / ULS design checks

This keeps the mechanics and the Eurocode factor route clearly separated.

---

## 9. Eurocode partial factors — characteristic → design values

### 9.1 Governing principle — SLS vs ULS

**Two parallel calculation paths for every engineering check, using the same soil profile:**

| Check | Limit state | Load combination | Soil parameters | Output compared to |
|---|---|---|---|---|
| **Deformation** (settlement, drawdown-induced settlement, slab deflection, allowable rotation) | **SLS** | Characteristic / quasi-permanent / frequent (γ = 1.0 on everything) | **Characteristic** values (CSV as-is) | Serviceability criteria (EN 1997-1 Annex H, project spec) |
| **Strength / rupture** (bearing resistance, slope stability, passive earth pressure, slab bending capacity, shear capacity, structural cross-section) | **ULS** | Fundamental (Eq. 6.10 with γ_G, γ_Q) | **Design** values (γ_M applied) | Resistance R_d (with γ_R / γ_M,concrete,steel) |

**Hard rule for the code:** every function must carry an explicit flag `limit_state ∈ {"SLS", "ULS"}`. The same stress/deformation routines run in both modes; only the input factors change. **Never mix**: e.g. do not design reinforcement from an SLS moment, and do not compare an ULS settlement to a serviceability tolerance.

### 9.2 EN 1990 — Actions (loads)

**Belgian NA: NBN EN 1990 ANB:2005 uses Eq. 6.10 (NOT 6.10a/b).**

#### 9.2.1 ULS — fundamental combination, Eq. 6.10

```
E_d = Σ γ_G,j · G_k,j  +  γ_Q,1 · Q_k,1  +  Σ γ_Q,i · ψ_0,i · Q_k,i
```

Belgian NA partial factors (persistent/transient, STR/GEO):

| Action | Unfavourable γ | Favourable γ |
|---|---|---|
| Permanent G (Set B / STR) | **1.35** | 1.00 |
| Permanent G (Set C / GEO, DA1-C2) | **1.00** | 1.00 |
| Variable Q leading | **1.50** | 0 |
| Variable Q accompanying | 1.50 · ψ_0 | 0 |

ξ (reduction factor for unfavourable G in Eq. 6.10a/b) = **0.85** — not used if only Eq. 6.10 is applied.

#### 9.2.2 ψ factors (Belgian NA, NBN EN 1990 ANB)

| Use category | ψ_0 | ψ_1 | ψ_2 |
|---|---|---|---|
| A — domestic, residential | 0.7 | 0.5 | 0.3 |
| B — offices | 0.7 | 0.5 | 0.3 |
| C — congregation | 0.7 | 0.7 | 0.6 |
| D — shopping | 0.7 | 0.7 | 0.6 |
| E — storage | 1.0 | 0.9 | 0.8 |
| Wind (W) | 0.6 | 0.2 | 0.0 |
| Snow (< 1000 m, Belgium) | 0.5 | 0.2 | 0.0 |
| Temperature (non-fire) | 0.6 | 0.5 | 0.0 |

#### 9.2.3 SLS combinations

```
Characteristic (rare) : E_d = Σ G_k,j + Q_k,1 + Σ ψ_0,i · Q_k,i        (Eq. 6.14b)
Frequent              : E_d = Σ G_k,j + ψ_1,1·Q_k,1 + Σ ψ_2,i·Q_k,i   (Eq. 6.15b)
Quasi-permanent       : E_d = Σ G_k,j + Σ ψ_2,i · Q_k,i               (Eq. 6.16b)
```
All SLS partial factors γ = 1.0.

**For settlement checks on foundations (EN 1997-1 §2.4.8(2)):** **use the quasi-permanent SLS combination.** This is the right thing for consolidation and long-term settlements. Immediate / short-term deflection uses the characteristic combination.

### 9.3 EN 1997-1 — Soil parameters (GEO / STR limit states)

**Belgium uses Design Approach 1 (DA1)** per NBN EN 1997-1 ANB:2022. Two combinations, the **most onerous governs**:

```
DA1 Combination 1 (C1):  A1 + M1 + R1     — loads factored up, soil unfactored
DA1 Combination 2 (C2):  A2 + M2 + R1     — loads mostly unity, soil strength factored down
```

Typical ruling case:
- **C1 governs for structural forces** (base pressure, pile loads, internal forces in retaining walls)
- **C2 governs for geotechnical failure modes** (bearing capacity, slope stability, passive resistance)

So you must run both and report the worst for each check.

#### 9.3.1 Set A — actions

| Set | γ_G (unfav.) | γ_G (fav.) | γ_Q (unfav.) | γ_Q (fav.) |
|---|---|---|---|---|
| **A1** (C1) | 1.35 | 1.00 | 1.50 | 0 |
| **A2** (C2) | 1.00 | 1.00 | 1.30 | 0 |

#### 9.3.2 Set M — soil material factors [critical for your code]

| Parameter | Symbol | γ_M in **M1** | γ_M in **M2** |
|---|---|---|---|
| Angle of shearing resistance (on tan φ') | γ_φ' | 1.00 | **1.25** |
| Effective cohesion | γ_c' | 1.00 | **1.25** |
| Undrained shear strength | γ_cu | 1.00 | **1.40** |
| Unconfined compressive strength | γ_qu | 1.00 | 1.40 |
| Weight density | γ_γ | 1.00 | 1.00 |

Characteristic-to-design conversion **(apply when `limit_state == "ULS"` and combination M2)**:

```
tan(φ'_d) = tan(φ'_k) / γ_φ'          →   φ'_d = atan(tan(φ'_k) / 1.25)
c'_d      = c'_k      / γ_c'          →   c'_d = c'_k / 1.25
c_u,d     = c_u,k     / γ_cu          →   c_u,d = c_u,k / 1.40
γ_d       = γ_k                                   (unit weight unchanged)
```

Worked numbers for your CSV:
- Layer 3 (sand, φ' = 30°): `tan(30°)/1.25 = 0.462` → `φ'_d = atan(0.462) = 24.8°`
- Layer 5 (sandy clay, φ' = 22°, c' = 8 kPa, c_u = 100 kPa):
  - `φ'_d = atan(tan(22°)/1.25) = atan(0.3232) = 17.9°`
  - `c'_d = 8/1.25 = 6.4 kPa`
  - `c_u,d = 100/1.40 = 71.4 kPa`

#### 9.3.3 Set R — resistance factors (for DA1, R1 is used in both combinations)

For **spread foundations** (EN 1997-1 Table A.5), DA1 uses **R1**:

| Resistance | Symbol | R1 | R2 | R3 |
|---|---|---|---|---|
| Bearing | γ_R,v | **1.00** | 1.40 | 1.00 |
| Sliding | γ_R,h | **1.00** | 1.10 | 1.00 |

For **piles** (DA1, R1 and R4 for C1/C2 respectively in earlier NAs, but **NBN EN 1997-1 ANB:2022 now refers to Buildwise Report 20** for pile-specific model factors and correlation factors — these are pile-system-specific and are not a simple 1.0/1.4 factor). If you later implement pile resistance, you must read Buildwise Rapport 20 directly; do not hard-code anything for piles.

For **slope / overall stability** (EN 1997-1 Table A.14), DA1 uses **R3 = 1.00** (safety comes entirely from M2-factored strength). This matches your Bosrede 2A SB260 workflow where you reduce `tan φ'` and `c'` and target a unity-check `SF ≥ 1.0` in the factored model — or equivalently leave strengths characteristic and target `SF ≥ 1.25` in an unfactored slope-stability program. SB260 uses the latter convention with its minimum `SF = 1.3`.

### 9.4 EN 1997-1 — Stiffness parameters are NOT factored

**Critical point for your CSV:** the partial factors in Set M apply to **strength** parameters (`φ'`, `c'`, `c_u`), **not to stiffness** (`E_oed`, `E_50`, `E_ur`, `m`, `k_s`, `k_h`, `k_v`).

```
E_oed,design = E_oed,characteristic                  (no γ applied)
k_s,design   = k_s,characteristic                    (no γ applied)
ν_ur,design  = ν_ur,characteristic                   (no γ applied)
K0_nc,design = K0_nc,characteristic                  (no γ applied)
```

**Reasoning:** stiffness is used for deformation prediction, which is an SLS matter. In ULS, EN 1997-1 is silent on stiffness factoring because strength — not stiffness — is what governs rupture. If you need a more conservative stiffness for ULS (e.g. for a deformation-based ULS check in a retaining wall), apply a **model factor** explicitly, not a partial factor on E.

**Consequence for your code:** when routing the CSV through the ULS pipeline, reduce strengths only. Leave the stiffness columns untouched.

### 9.5 EN 1992-1-1 — Concrete and reinforcement (Option C, §4.9)

The current app route for `c_nom` follows the EC2 durability logic described in §4.9 and mirrors the same Table 4.3N / Table 4.4N sequence as the delivered `ec2_durability.py` helper: choose structural class, read `c_min,dur`, combine with bond cover `c_min,b`, then add `Δc_dev`.

#### 9.5.1 Partial factors (Belgian NA and EC2 main text agree)

| Material | Symbol | ULS persistent/transient | ULS accidental | SLS |
|---|---|---|---|---|
| Concrete | γ_C | **1.50** | 1.20 | 1.00 |
| Reinforcing steel | γ_S | **1.15** | 1.00 | 1.00 |
| Prestressing steel | γ_S | 1.15 | 1.00 | 1.00 |

Design values:
```
f_cd = α_cc · f_ck / γ_C           α_cc = 1.00 (Belgian NA)
f_yd = f_yk / γ_S
f_ctd = α_ct · f_ctk,0.05 / γ_C    α_ct = 1.00 (Belgian NA)
```

For your typical choices: C30/37 + BE500S →
```
f_cd  = 30 / 1.50       = 20.0 MPa
f_yd  = 500 / 1.15      = 434.8 MPa
f_ctm = 0.30 · 30^(2/3) = 2.90 MPa
f_ctd = 0.7·f_ctm / 1.5 = 1.35 MPa    (5% fractile / γ_C)
```

#### 9.5.2 SLS stress limits (EN 1992-1-1 §7.2)

Crack-control / durability, typical for exposure class XC2/XC3/XC4:

```
σ_c ≤ 0.60 · f_ck    under characteristic combination   (avoid longitudinal cracking)
σ_c ≤ 0.45 · f_ck    under quasi-permanent combination  (linear creep)
σ_s ≤ 0.80 · f_yk    under characteristic combination   (crack limitation, tension)
```

These are relevant if you extend Option C to SLS crack width checks.

### 9.6 Mapping to the current Stage 6 applications

| Application | SLS use | ULS use | Partial factors applied |
|---|---|---|---|
| **Dewatering** | Primary output: drawdown-induced settlement at the CPT or along the source-distance line. **SLS** response using characteristic soil and water-table assumptions. | Secondary only if the resulting effective-stress state is exported to another ULS check outside this module. | Usually **SLS only** inside the dewatering application. |
| **Settlement** | Primary output: `S_total` at footing. **SLS quasi-permanent** combination for `q_net`. Characteristic `E_oed`. | No separate ULS path inside this app. | **SLS only** for the settlement application. |
| **Bearing capacity** | Not the primary mode. | Primary output: drained and undrained bearing resistance under Belgian DA1. | **ULS** with M1/M2 envelope, R1, optional `γ_Rd`, or legacy `ξ` route. |
| **Beam / slab on elastic foundation** | Deflection `w(x)` and differential deflection from **SLS** characteristic or quasi-permanent loading. Characteristic `k_s`. | Bending moment `M_Ed` from **ULS** load combination, then EC2 reinforcement with `γ_C = 1.5`, `γ_S = 1.15`. | **Both SLS (deflection) and ULS (reinforcement).** |

### 9.7 Code additions to the pseudocode

The helper layer is:

```python
def design_values(layer, limit_state="SLS", combination="M1"):
    """Return a factored copy of a layer for ULS checks.
       Only strengths are modified. Stiffnesses and weights are passed through."""
    if limit_state == "SLS" or combination == "M1":
        return layer                           # unfactored
    # ULS with M2 (Belgian DA1-C2)
    gamma_phi = 1.25
    gamma_c   = 1.25
    gamma_cu  = 1.40
    d = copy(layer)
    d.phi = degrees(atan(tan(radians(layer.phi)) / gamma_phi))
    d.c   = layer.c  / gamma_c
    d.cu  = layer.cu / gamma_cu
    # stiffness, gamma, K0_nc, nu_ur UNCHANGED
    return d


def load_combination(G_k, Q_k_lead, Q_k_other=None, psi0=None,
                     limit_state="ULS", eq="6.10", variant="unfav",
                     ga_G=1.35, ga_Q=1.50):
    """Belgian NA: default Eq. 6.10 (not 6.10a/b).
       limit_state='SLS' with variant in {'characteristic','frequent','qp'}."""
    if limit_state == "ULS":
        q_other = sum(ga_Q * psi0[i] * Q_k_other[i] for i in range(len(Q_k_other or [])))
        return ga_G * G_k + ga_Q * Q_k_lead + q_other
    # SLS
    if variant == "characteristic":
        q_other = sum(psi0[i] * Q_k_other[i] for i in range(len(Q_k_other or [])))
        return G_k + Q_k_lead + q_other
    if variant == "frequent":
        return G_k + psi1_lead * Q_k_lead + sum(psi2[i]*Q for i,Q in enumerate(Q_k_other or []))
    if variant == "qp":
        return G_k + sum(psi2[i]*Q for i,Q in enumerate(Q_k_other or []))


def settlement(profile, footing, q_SLS_qp, ...):
    # Use characteristic soil, SLS quasi-permanent load
    ...

def bearing_capacity(profile, footing, q_ULS, combination="M2"):
    profile_d = [design_values(s.layer, "ULS", combination) for s in profile]
    # Brinch-Hansen / Vesic with phi'_d, c'_d; compare q_ULS ≤ q_Rd / gamma_R
    ...

def beam_on_winkler_ULS(P_ULS, beam, ks_characteristic):
    # k_s is NOT factored; the governing moment is P_ULS · lambda / 4
    ...
    M_Ed = P_ULS * lam / 4
    return M_Ed

def reinforcement(M_Ed, h, c_nom, phi_bar, f_ck=30, f_yk=500, ...):
    gammaC = 1.50; gammaS = 1.15
    # as already written in §4.9 / §5
```

### 9.8 Reporting / audit trail

For every Stage 6 output, the report must state:

1. **Limit state**: SLS or ULS
2. **Load combination**: Eq. 6.10 + values of `γ_G`, `γ_Q`, leading Q, `ψ` factors
3. **Soil combination**: M1 or M2, with listed `γ_φ'`, `γ_c'`, `γ_cu`
4. **Resistance set**: R1 (DA1 default)
5. **Design Approach**: DA1 (NBN EN 1997-1 ANB:2022)
6. **Material partial factors** (for Option C): `γ_C = 1.50`, `γ_S = 1.15`
7. **System safety factor** `SF_calc` vs `SF_required` (for ruptures) or `δ_calc` vs `δ_allowable` (for SLS)

This auditability is what makes the output defensible in a gerechtelijk or permit context. Without it, the calculation is just a number.

### 9.9 Summary rule-of-thumb card

```
┌─────────────────────────────────────────────────────────────┐
│  DEFORMATION  →  SLS  →  γ = 1.0 everywhere                 │
│                          Use characteristic E, c, φ, γ, k_s │
│                          Combine loads per Eq. 6.16b (qp)   │
│                          for settlement; 6.14b for stiffness│
│                                                             │
│  STRENGTH     →  ULS  →  Loads: Eq. 6.10  (γ_G=1.35,γ_Q=1.5)│
│                          Soil: M1 (unity) AND M2 (run both) │
│                              φ'_d = atan(tan φ'_k / 1.25)   │
│                              c'_d = c'_k / 1.25             │
│                              c_u,d = c_u,k / 1.40           │
│                          Stiffness: UNFACTORED              │
│                          Resistance: R1 (γ_R = 1.0 for DA1) │
│                          Concrete: f_cd = f_ck/1.5          │
│                          Steel:    f_yd = f_yk/1.15         │
│                                                             │
│  Belgian NA (NBN EN 1997-1 ANB:2022): Design Approach 1,   │
│      two combinations, most onerous governs                 │
│  Belgian NA (NBN EN 1990 ANB:2005):   Eq. 6.10, ξ = 0.85   │
└─────────────────────────────────────────────────────────────┘
```

### 9.10 Resistance factor vs. model factor vs. system safety factor — don't conflate them

This is the single most common source of confusion when moving from characteristic to design resistance. There are **three** different factors in play and they have different origins, different values, and different combination rules. Getting them right matters because stacking them all multiplicatively produces absurd designs; missing one produces unsafe designs.

#### 9.10.1 The three factors

| Factor | Symbol | Applies to | Typical value (DA1, Belgian NA) | Origin |
|---|---|---|---|---|
| **Material partial factor** | γ_M (γ_φ', γ_c', γ_cu) | Characteristic soil **strengths** before entering the resistance formula | 1.00 (M1) / 1.25–1.40 (M2) | EC7 Annex A |
| **Resistance partial factor** | γ_R (γ_Rv, γ_Rh, γ_Re) | Computed **resistance output** of a formula | 1.00 (R1) / 1.10–1.40 (R2, R3) | EC7 Annex A |
| **Model factor** | γ_Rd (also γ_{R;d}, γ_{Sd}) | The **calculation model itself**, to account for its inherent inaccuracy | 1.00–1.40 depending on method | EC7 §2.4.1, §6.5.2, NAs |
| (Legacy) **Global / system safety factor** | SF | Ratio R_char / S_char, outside the partial-factor framework | 2.0–3.0 bearing, 1.3–1.5 slopes | Pre-EC / SB260 / Terzaghi |

#### 9.10.2 What each factor does

**Material partial factor γ_M** — reduces the *input* to the resistance model. Applied once, at the top:
```
φ'_d = atan(tan φ'_k / γ_φ')
c'_d = c'_k / γ_c'
c_u,d = c_u,k / γ_cu
```
This is the M2 route. It models uncertainty *in the soil itself*.

**Resistance partial factor γ_R** — reduces the *output* of the resistance model. Applied once, at the bottom:
```
R_d = R_k / γ_R           (DA2 route)
```
or:
```
R_d = R(X_d) / γ_R        (DA1-C1 route, γ_R = 1.0 in R1)
```
This is a calibration factor on the total resistance, *not* on strength parameters. In DA1, γ_R is 1.0 for spread foundation bearing and sliding — because M2 already does the work. You do **not** double-count by applying both M2 strength reduction *and* a γ_R > 1 in the same verification.

**Model factor γ_Rd** — applied to the resistance to cover *systematic bias* of the calculation method itself. Examples:
- Brinch-Hansen/Vesić bearing on layered soil → `γ_Rd ≈ 1.1–1.4` (the formula was calibrated on homogeneous profiles)
- Slip-circle slope stability (Bishop) → often taken as 1.0 because the method is well-validated
- Winkler-beam bending moment → conservatively `γ_Rd = 1.0` (the moment comes from a calibration-independent ODE)

The Belgian pile framework is the cleanest example: **Buildwise Rapport 20** specifies `γ_b`, `γ_s` (base and shaft installation factors) and `ξ_3`/`ξ_4` correlation factors — these are all **model factors** wrapped under different names. For shallow foundations EC7-1 Annex D does **not** prescribe a γ_Rd, but second-generation EC7 and the French NA do (`γ_{R;d;v}`).

**Global safety factor SF** — the pre-Eurocode framework, still used in SB260 (Belgium) for slope stability:
```
SF = R_char(φ_k, c_k, ...) / S_char           (both unfactored)
SF ≥ SF_required                               (e.g. 1.3 for slopes per SB260)
```
It is **mathematically equivalent** to M2 with `γ_M = SF_required` and γ_R = 1.0 — but philosophically different: EC7 calibrates γ_M on statistical variability of the parameter; SF lumps everything (parameter uncertainty + model uncertainty + consequences) into one number.

#### 9.10.3 How they combine — the rules

**Rule 1: Don't stack γ_M and γ_R on the same uncertainty.**
DA1-C2 uses M2 + R1 (γ_R = 1.0). DA2 uses M1 (γ_M = 1.0) + R2. You pick a philosophy — factor inputs or factor output — not both.

**Rule 2: γ_Rd is *always* allowed on top, if the method warrants it.**
γ_Rd is orthogonal to γ_M and γ_R: it corrects the *formula*, not the soil or the loads. You always apply it when prescribed:
```
R_d = R_k(X_d) / (γ_R · γ_Rd)
```
This is how French EC7-NA writes it: `R_{v;d} = R_{v;k} / (γ_{R;v} · γ_{R;d;v})`.

**Rule 3: Don't mix SF with partial factors.**
Running an EC7 calculation *and* checking SF ≥ 1.3 afterwards on characteristic parameters is valid — as long as you report both separately and don't multiply them. SB260 for Bosrede 2A is an SF-framework calc, not an EC7-partial-factor calc, even though the underlying soil parameters come from EC7 Annex B procedures. This is a subtlety worth stating in the report.

**Rule 4: For verification, compare like with like.**
```
ULS unity check:   E_d ≤ R_d          (both factored)
SLS check:         E_k (any combo) ≤ C_d                  (both unfactored, no γ at all)
SF check (SB260):  SF_char ≥ SF_req   (both unfactored)
```

#### 9.10.4 Concrete worked example — bearing of a spread footing on sand

Given: 2 × 2 m square footing, `D_f = 1.5 m`, sand with `φ'_k = 30°`, `γ_k = 17 kN/m³`. Characteristic load: `V_Gk = 400 kN`, `V_Qk = 200 kN`.

**DA1-C1 (A1 + M1 + R1)**:
```
V_Ed  = 1.35·400 + 1.50·200 = 840 kN
φ'_d  = 30°                              (γ_φ' = 1.0)
R_k   = q_ult(φ'=30°, ...) · A           (Brinch-Hansen)
      ≈ 1880 kPa · 4 m² ≈ 7520 kN
R_d   = 7520 / 1.0 = 7520 kN             (γ_Rv = 1.0 in R1)
Utilisation: 840 / 7520 = 0.112  → OK, loads govern
```

**DA1-C2 (A2 + M2 + R1)**:
```
V_Ed  = 1.00·400 + 1.30·200 = 660 kN
φ'_d  = atan(tan 30° / 1.25) = 24.8°     (γ_φ' = 1.25)
R_k   = q_ult(φ'=24.8°, ...) · A         (Brinch-Hansen)
      ≈ 820 kPa · 4 m² ≈ 3280 kN
R_d   = 3280 / 1.0 = 3280 kN             (γ_Rv = 1.0 in R1)
Utilisation: 660 / 3280 = 0.201  → OK, soil governs
```

Governing: **C2 with 0.201**. Note:
- γ_M was applied to *inputs* (`φ'`), **not** to the resistance output.
- γ_R was 1.0, so no post-division.
- If we *also* applied a model factor γ_Rd = 1.1 (for Brinch-Hansen on layered profile), `R_d` would become 3280 / 1.1 = 2982 kN, utilisation 0.221.

**Comparison with pre-EC global SF (for intuition)**:
```
R_char = q_ult(φ'=30°) · A = 7520 kN
SF     = R_char / V_char = 7520 / (400 + 200) = 12.5
```
A pre-EC engineer would report "SF = 12.5, required 3.0, OK". An EC7 engineer reports "C2 utilisation 0.20, OK". Both designs are safe, and EC7 arrived at the same conclusion through explicit uncertainty decomposition instead of a lumped SF. **Do not combine them** — never report `SF / γ_R / γ_M` as a stacked product.

#### 9.10.5 Summary for Stage 6 implementation

| Stage 6 output | Uses γ_M? | Uses γ_R? | Uses γ_Rd? | Uses SF? |
|---|---|---|---|---|
| Option A — dewatering settlement | No (SLS) | No | No | No |
| Option B — settlement | No (SLS) | No | No | No |
| Option B — bearing capacity (add-on) | **Yes**, M1 and M2 | **Yes**, R1 (=1.0 in DA1) | Optional (1.0 default) | No |
| Option C — SLS deflection | No | No | No | No |
| Option C — ULS bending → reinforcement | No (concrete γ_C, γ_S are EC2-side) | No | No | No |
| **Slope stability (SB260, external to these options)** | No (SF framework) | No | No | **Yes, SF ≥ 1.3** |

**For your code:** expose `γ_Rd` as a **separate** user input with default 1.0, documented as "model factor (EC7 §2.4.1) — leave at 1.0 unless the calculation model is known to be biased". Do not fold it into `γ_R` and do not fold `γ_R` into `γ_M`. Keep the three separate all the way through, both in the calculation pipeline and in the report. That's what makes the audit trail defensible.

```
q_ult    →  [÷ γ_Rd model factor]   →  [÷ γ_R resistance factor]   =  q_d
(unfactored resistance)              (formula correction)             (resistance partial factor)    (design resistance)

with soil strengths at design values (c'_d, φ'_d, cu_d) from γ_M inside q_ult.
```

Applied as a single equation:
```
q_d = q_ult(φ'_d, c'_d, γ_k, geometry) / (γ_R · γ_Rd)
```

### 9.11 Inputs for the partial-factor helpers

These helpers are called internally by every Option; they are not separate UI forms but their inputs must be traceable.

```python
# --- INPUTS for design_values() and load_combination() ---

# [SHARED]
layer              # Layer dataclass with characteristic soil parameters

# [USER — only at the top of the calculation flow, then propagated]
limit_state        # ENUM {"SLS", "ULS"}
                   # Chosen by the Option being run:
                   #   Dewatering → "SLS"
                   #   Settlement → "SLS"
                   #   Bearing capacity → "ULS"
                   #   Beam/slab deflection → "SLS"
                   #   Beam/slab reinforcement → "ULS"

combination        # ENUM {"M1", "M2"}  (only for ULS)
                   # Run BOTH for DA1, report the onerous one per check.

use_category       # ENUM for ψ-selection (§9.2.2)
                   # Picked from a dropdown in the Stage 6 UI.

# [DEFAULT — Belgian NA]
# Action partial factors — not user-editable (would break Belgian compliance)
gamma_G_unfav_A1  = 1.35
gamma_G_fav_A1    = 1.00
gamma_Q_unfav_A1  = 1.50
gamma_G_unfav_A2  = 1.00
gamma_Q_unfav_A2  = 1.30

# Soil material partial factors — not user-editable
gamma_phi_M2      = 1.25
gamma_c_M2        = 1.25
gamma_cu_M2       = 1.40

# Resistance factors (DA1 uses R1 in both C1 and C2 for spread foundations)
gamma_R_bearing_R1 = 1.00
gamma_R_sliding_R1 = 1.00

# Concrete / steel (EC2 + Belgian NA)
gamma_C           = 1.50
gamma_S           = 1.15
alpha_cc          = 1.00
alpha_ct          = 1.00

# Design equation used
load_eq           = "6.10"   # Belgian NA: NOT 6.10a/b
xi_factor         = 0.85     # only used if "6.10a/b" selected (non-standard in BE)

# ψ tables per use_category (§9.2.2) — built-in lookup
psi0_lookup       = { ... }
psi1_lookup       = { ... }
psi2_lookup       = { ... }
```

---
