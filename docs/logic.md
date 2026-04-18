# CPT Interpretation App — Logic Documentation

*Last updated: 2026-04-18. This document reflects the exact logic implemented in the SvelteKit CPT interpreter (`src/lib/components/cpt/*` UI plus `src/lib/cpt-app/legacy-controller.js`) and documents planned extensions. Sections marked [IMPLEMENTED] match the current code verbatim. Sections marked [PLANNED] are documented for upcoming implementation.*

---

## Stage 1 — GEF File Loading

### 1.1 Column mapping

GEF files map physical quantities to column positions via `#COLUMNINFO` header lines:

```
#COLUMNINFO= colIndex, unit, description, quantityID
```

The app reads the **4th token (quantityID)** and maps it to a 0-based column index (`colIndex - 1`). Column order is never assumed. Quantity IDs used:

| Quantity ID | Physical quantity | Unit in file |
|-------------|------------------|--------------|
| 1 | Penetration length (depth) | m |
| 2 | qc (cone resistance) | MPa |
| 3 | fs (sleeve friction) | MPa |
| 4 | Rf (friction ratio) | % |
| 6 | u2 (pore pressure) | MPa |
| 11 | Corrected depth | m |

When both quantity ID 11 and ID 1 are present, **ID 11 (corrected depth) takes priority**.

### 1.2 Unit detection and conversion

- **qc**: unit is read from `#COLUMNINFO` for quantity ID 2. `MPa` is used directly, `kPa` is divided by 1000, `Pa` by 1 000 000. If the unit string is missing or unclear, a heuristic fallback is used.
- **fs**: unit is read from `#COLUMNINFO` for quantity ID 3. `MPa` is used directly, `kPa` is divided by 1000, `Pa` by 1 000 000. If the unit string is missing or unclear, a heuristic fallback is used.
- **Rf**: used directly from column (declared as %). If Rf is absent, negative, or `>= 50`, computed as `|fs| / qc * 100`, clamped to [0, 20]
- **u2**: used as-is (expected MPa in the GEF file)

### 1.3 Row filtering

Rows are discarded if:
- `z < 0` (negative depth)
- `qc < 0.02 MPa` (cone not yet engaged)
- All-zero row (terminal row sometimes appended by logging software)

### 1.4 Water table

Source priority:
1. `#MEASUREMENTVAR= 14, value, m, WaterLevel` — `wt = |value|` (sign convention: negative = below surface, so absolute value taken)
2. If absent — default `wt = 1.7 m`

The engineer can override at any time via slider or numeric input. Display shows both depth-below-surface (m) and elevation (m TAW) when a surface elevation is set.

### 1.5 Surface elevation

Source priority:
1. `#ZID= datum, value, precision` — `elev = value` (m TAW)
2. Manual entry in the UI

When set: `TAW = elev - z` for all depth values.

### 1.6 Other header fields parsed

| Header | Used for |
|--------|----------|
| `#PROJECTID` | Metadata display |
| `#TESTID` | Metadata display |
| `#STARTDATE` | Metadata display |
| `#FILEOWNER` | Metadata display |
| `#MEASUREMENTTEXT` with "Lokatie" or "Location" | Location metadata |
| `#MEASUREMENTVAR= 3` | Net area ratio a (default 0.8) |

---

## Stage 2 — Classification

Classification is applied **per depth step** (every reading). Five methods are available. The
Robertson (2016) route is the default for new CPTs and is documented separately in `docs/classification/robertson-2016.md`.

### 2.1 Robertson (1990) — SBT / Ic [IMPLEMENTED]

The implementation uses the Robertson-style normalised chart with a fixed preliminary stress estimate because layer-specific unit weights are not yet known at Stage 2.

**Stress calculation**:

```
sigma_v0  = 17 * z                         [kPa] above WT
sigma_v0  = 17 * z_wt + 18 * (z-z_wt)      [kPa] below WT
u         = 9.81 * max(0, z - z_wt)        [kPa]
sigma_v0' = max(sigma_v0 - u, 1)           [kPa]
```

**Cone resistance used**:

```
qt = qc + u2 * (1 - a)     [MPa]  if u2 is available
qt = qc                    [MPa]  otherwise
```

where `a` is the net area ratio from `#MEASUREMENTVAR = 3` (default `0.8`).

**Normalised parameters**:

```
dQ  = qt - sigma_v0 / 1000                  [MPa]
Qt  = max(0.1, dQ / (sigma_v0' / 1000))     [-]
Fr  = clamp(|fs_eff / dQ| * 100, 0.1, 10)   [%]
```

where `fs_eff = fs` if measured, else `fs_eff = qt * (Rf / 100)`.

If `dQ < 0.01` or `sigma_v0' < 1`, the row defaults to `Clay` with `Ic = 2.80`.

**Soil Behaviour Type Index**:

```
Ic = sqrt((3.47 - log10(Qt))^2 + (log10(Fr) + 1.22)^2)
```

**Classification used by the app**:

| Condition | Assigned type |
|-----------|---------------|
| `Qt > 200` and `Fr < 0.5` | Gravel |
| `Ic > 3.60` | Peat / organic |
| `Ic > 2.95` | Clay |
| `Ic > 2.60` | Sandy clay |
| `Ic > 2.05` | Silty sand |
| otherwise | Sand |

This matches the standard Robertson Ic bands more closely than the earlier draft. The app does **not** infer “sensitive fine-grained soil” separately from Ic alone.

---

### 2.2a CUR 3 layers (PLAXIS chart) [IMPLEMENTED]

Four-gate decision tree on raw `qc` (MPa) and `Rf` (%). No stress
normalisation. Gates are checked in order, first match wins.

| # | Condition | Type | Subtype |
|---|-----------|------|---------|
| 1 | `Rf > 4%` | Peat / organic | — |
| 2 | `Rf < 1%` and `qc > 1.5 MPa` | Sand | CUR3 sand |
| 3 | `Rf < 2%` and `0.5 <= qc <= 1.5 MPa` | Sandy clay | CUR3 silt |
| 4 | fallback | Clay | CUR3 clay |

**Inputs**

- `qc` — cone resistance [MPa]
- `Rf` — friction ratio [%]; defaults to `3.0` when absent

**Mapping note.** The published CUR 3 chart names the intermediate
field "Silt". The app carries this as `Sandy clay / CUR3 silt` to
keep downstream parameter-assignment (Stage 3) working against a
single app-type vocabulary.

**Source:** PLAXIS Reference Manual, "CUR 3 layers method" chart.

### 2.2b NEN 6740 (stress-corrected chart) [IMPLEMENTED]

Nearest-score classifier against 14 digitised reference areas from
the NEN 6740 chart as reproduced in the Deltares D-SHEET Piling
manual.

**Step 1 — stress-correct qc**

```
qcNen = qc * (100 / sigma_v0')^0.67        [MPa]
```

where `sigma_v0'` is in kPa, floored at `1 kPa`; `qcNen` is floored at `0.01 MPa`.

**Step 2 — chart score**

```
score = log10(qcNen) - 0.34 * Rf
```

`Rf` is in % and defaults to `3.0` when absent.

**Step 3 — match**

Pick the reference area with the smallest `|score - area.score|`. On
ties the lower-indexed area wins, preserving the chart ordering from
gravel toward peat.

**Output**

- `type`, `subtype`, `gamma`, `gamma_sat`, `phi'`, `c'`, `cu`
- the selected `qcNen` is stored in the `Qt` display field

**Reference set.** Fourteen fixed material points spanning Gravel to
Peat. See `src/lib/cpt-app/nen6740.js` (`NEN6740_MATERIALS`)
for the exact subtype catalogue and parameter values.

**Provenance of the chart constants.**

- The stress exponent `0.67` is **not** prescribed algebraically by NEN
  6740 itself, but it **is** documented by the Deltares D-SHEET Piling
  User Manual (`v24.1`, §34.2.2) for the "NEN (Stress Dependent)" CPT
  interpretation route.
- The Rf coefficient magnitude `0.34` is **not** a published NEN or
  Deltares coefficient. It is an app-side chart-fit constant obtained
  from the regression magnitude of `log10(qcNen)` on `Rf` through the 14
  stored reference centres used by the deterministic nearest-score
  implementation.

**Calibration note.** Regression through the 14 stored centres gives
`|k_fit| ≈ 0.34` with `R² ≈ 0.98`, so the app now uses
`score = log10(qcNen) - 0.34 * Rf`. The earlier `k = 0.18`
under-weighted `Rf` and made the boundary between *loam, slightly sandy, weak* (area 5) and
*clay, very sandy, stiff* (area 6) nearly degenerate. Areas 5 and 6
remain the weakest neighbouring pair even after recalibration, so ties
and near-ties are still resolved deterministically by the stored
`order` of `NEN6740_MATERIALS`, which favours the lower-indexed area.

**Validation.** The repo includes a dedicated self-consistency check:

```
npm run verify:nen6740
```

That script:

- recomputes the regression slope through the 14 stored centres and
  checks its magnitude remains in sync with the configured `0.34`;
- re-projects every stored `(qcNen, Rf)` centre through the classifier
  at several representative `sigma_v0'` values and verifies that each
  centre still classifies back to itself.

This makes the chart-fit implementation explicit and guards against
future drift between the stored centres and the score formula.

---

### 2.3 Eurocode / NEN — Tabel 3 (Karakteristieke grondparameters) [IMPLEMENTED]

Uses raw `qc` (MPa) and `Rf` (%) and returns type, subtype, `gamma_k boven F.O.`, `gamma_k onder F.O.`, `phi'k`, `c'k`, `cu,k` directly from the table rows.

The implementation now follows the **table itself**. Because the table contains overlapping envelopes, rows are checked in **table order**:

```
1. grind
2. zand
3. leem
4. klei
5. veen
```

Within each soil family, subrows are checked top-to-bottom. Boundary handling follows the notation in the table:

- `qc` lower bounds are inclusive, upper bounds exclusive
- `Rf < 1` and `Rf > 6` are strict
- `Rf 1–2`, `2–4`, `2–5`, `3–6` are inclusive at both ends

#### Veen

Condition: `Rf > 6`

Sub-classification within veen by qc:

| qc | Subtype | gamma | gamma_sat | phi' | c' | cu |
|----|---------|-------|-----------|------|----|----|
| < 0.5 | veen, weinig vast | 10 | 10 | 15 | 2 | 10 |
| 0.5 to < 1.0 | veen, matig vast | 12 | 12 | 15 | 5 | 20 |
| >= 1.0 | veen, vast | 14 | 14 | 15 | 10 | 40 |

#### Klei

Condition: `3 <= Rf <= 6`

| qc | Subtype | gamma | gamma_sat | phi' | c' | cu |
|----|---------|-------|-----------|------|----|----|
| < 1.0 | klei, weinig vast | 16 | 16 | 20 | 2 | 20 |
| 1.0 to < 2.0 | klei, matig vast | 17 | 17 | 20 | 4 | 50 |
| 2.0 to < 4.0 | klei, vrij vast | 18 | 18 | 20 | 8 | 100 |
| >= 4.0 | klei, vast | 19 | 19 | 20 | 15 | 200 |

#### Klei zandhoudend

Condition: `2 <= Rf <= 5`

Same cu/c' scale as klei pure but phi' = 22 throughout.

| qc | Subtype | gamma | gamma_sat | phi' | c' | cu |
|----|---------|-------|-----------|------|----|----|
| < 1.0 | klei (zh), weinig vast | 16 | 16 | 22 | 2 | 20 |
| 1.0 to < 2.0 | klei (zh), matig vast | 17 | 17 | 22 | 4 | 50 |
| 2.0 to < 4.0 | klei (zh), vrij vast | 18 | 18 | 22 | 8 | 100 |
| >= 4.0 | klei (zh), vast | 19 | 19 | 22 | 15 | 200 |

#### Leem

Condition: `2 <= Rf <= 4`

| qc | Subtype | gamma | gamma_sat | phi' | c' | cu |
|----|---------|-------|-----------|------|----|----|
| < 1.0 | leem, weinig vast | 17 | 17 | 22 | 0 | 10 |
| 1.0 to < 2.0 | leem, matig vast | 18 | 18 | 22 | 2 | 25 |
| 2.0 to < 4.0 | leem, vrij vast | 19 | 19 | 22 | 4 | 50 |
| >= 4.0 | leem, vast | 20 | 20 | 22 | 8 | 100 |

#### Zandhoudende leem

Condition: `1 <= Rf <= 3`

Same as leem pure but phi' = 25.

| qc | Subtype | gamma | gamma_sat | phi' | c' | cu |
|----|---------|-------|-----------|------|----|----|
| < 1.0 | leem (zh), weinig vast | 17 | 17 | 25 | 0 | 10 |
| 1.0 to < 2.0 | leem (zh), matig vast | 18 | 18 | 25 | 2 | 25 |
| 2.0 to < 4.0 | leem (zh), vrij vast | 19 | 19 | 25 | 4 | 50 |
| >= 4.0 | leem (zh), vast | 20 | 20 | 25 | 8 | 100 |

#### Grind

Condition: `Rf < 1`

| qc | Subtype | gamma | gamma_sat | phi' | c' | cu |
|----|---------|-------|-----------|------|----|----|
| 10 to < 20 | grind, matig | 18 | 20 | 35 | 0 | 0 |
| >= 20 | grind, dicht | 19 | 21 | 40 | 0 | 0 |

#### Grind, leem- of kleihoudend

Condition: `1 <= Rf <= 2`

| qc | Subtype | gamma | gamma_sat | phi' | c' | cu |
|----|---------|-------|-----------|------|----|----|
| 10 to < 20 | grind (kh), matig | 19 | 21 | 32 | 0 | 0 |
| >= 20 | grind (kh), dicht | 20 | 22 | 37 | 0 | 0 |

#### Zand

Condition: `Rf < 1`

| qc | Subtype | gamma | gamma_sat | phi' | c' | cu |
|----|---------|-------|-----------|------|----|----|
| 2 to < 4 | zand, los | 16 | 18 | 27 | 0 | 0 |
| 4 to < 10 | zand, matig | 17 | 19 | 30 | 0 | 0 |
| 10 to < 15 | zand, dicht | 18 | 20 | 32 | 0 | 0 |
| >= 15 | zand, zeer dicht | 18 | 20 | 35 | 0 | 0 |

#### Leem- of kleihoudend zand

Condition: `1 <= Rf <= 2`

| qc | Subtype | gamma | gamma_sat | phi' | c' | cu |
|----|---------|-------|-----------|------|----|----|
| 2 to < 4 | zand (kh), los | 16 | 18 | 25 | 0 | 0 |
| 4 to < 10 | zand (kh), matig | 17 | 19 | 27 | 0 | 0 |
| 10 to < 15 | zand (kh), dicht | 18 | 20 | 30 | 0 | 0 |
| >= 15 | zand (kh), z.dicht | 18 | 20 | 32 | 0 | 0 |

#### Outside-table fallback

If a reading falls outside all table rows, the app keeps a deterministic fallback so the workflow can continue, but that fallback is **not** part of Eurocode Table 3.

### 2.4 Conceptual separation: classification vs. parameter assignment [IMPLEMENTED]

**Stage 2 = boundary logic only.** The classification method (Robertson / CUR 3 / Eurocode Table 3) determines which soil type each CPT reading belongs to, and therefore where layer boundaries fall. This is about soil behaviour in the CPT sense.

**Stage 3 = parameter assignment, independent of Stage 2.** Once layers exist, the engineer assigns geotechnical parameters (γ, φ', c', cu) via a parameter method. The default is the **NEN Tabel 3 / EC7 subtype catalogue**. This is independent of which classification method was used. A Robertson-classified "Sandy clay" layer can perfectly well be assigned "Zandhoudende leem — matig vast" parameters from Tabel 3.

**The dropdown in Stage 3** presents the full Eurocode / NEN Table 3 catalogue, organised into groups with a compatibility filter:
- **Compatible entries** (expected for the CPT type): shown at the top, fully enabled
- **Adjacent entries** (transition zone, plausible): shown after a divider, enabled, marked ⚠
- **Incompatible entries** (unrelated soil family): shown disabled, for reference only

Selecting a subtype auto-fills γ, γ_sat, φ', c', cu from Tabel 3 for any parameter not already manually overridden. Manual number inputs always take priority.

**Warning panel** below the table flags:
- Red warning (bad): selected subtype is in a completely unrelated soil family — engineer should check the CPT classification
- Amber note (adj): selected subtype is in an adjacent/transition family — acceptable if confirmed by boring or lab

**Critical distinction — leem vs. zand:**
- "Zandhoudende leem" = LEEM dominant with sand admixture → grp: leem, φ'=25°, cu=10-100 kPa
- "Leemhoudend zand" = ZAND dominant with silt admixture → grp: zand, φ'=25-32°, cu=0

These are fundamentally different. The catalogue has both, in their correct groups. The CPT type "Sandy clay" (intermediate, Rf 1–3%) is compatible with both, but the engineer must judge which applies based on boring descriptions or lab tests.

---

## Stage 3 — Layer Detection and Parameter Assignment

### 3.1 Layer boundary detection

**Step 1 — Group consecutive same-type rows:**
Scan all classified rows in depth order. A new segment begins when soil type changes.

**Step 2 — Iterative thin-layer merging:**
Engineer sets `t_min` (default `0.50 m`, range `0.05` to `2.0 m` via slider). Algorithm:

```
repeat until no changes:
  for each segment in depth order:
    thickness = z_last - z_first
    if thickness < t_min AND segment is not the first:
      merge segment rows into the segment above
      mark changed = true
```

Thin layers always merge **upward** into their predecessor. The first segment can never be merged regardless of thickness.

**Layer top and bottom:**
- First layer: top = 0.00 m
- All others: top = z_first_row - 0.02 m (fixed 0.02 m offset used by the app)
- Bottom: z_last_row of the segment

### 3.2 Per-layer statistics

From all rows with `qc > 0.02 MPa` within the merged segment:

```
avgQc  = mean of all qc values         [MPa]
avgFs  = mean of fs where fs != null   [MPa]
avgRf  = mean of Rf where Rf != null   [%]
```

Subtype: most frequently occurring subtype string in the segment (mode).

### 3.3 Default geotechnical parameters

**Robertson / CUR 3 methods** use the DEF table (generic values):

| Type | gamma | gamma_sat | phi' | c' | cu |
|------|-------|-----------|------|----|----|
| Peat / organic | 11 | 12 | 17 | 0 | 10 |
| Soft clay | 15 | 16 | 20 | 2 | 25 |
| Clay | 17 | 18 | 24 | 5 | 50 |
| Sandy clay | 18 | 19 | 28 | 2 | 0 |
| Silty sand | 19 | 20 | 31 | 0 | 0 |
| Sand | 19 | 20 | 34 | 0 | 0 |
| Gravel | 20 | 21 | 38 | 0 | 0 |

**Eurocode Table 3 method** averages the per-row table values across all rows in the merged segment:

```
gamma     = mean(row.gamma),     rounded
gamma_sat = mean(row.gamma_sat), rounded
phi'      = mean(row.phi'),      rounded to integer
c'        = mean(row.c'),        rounded to integer
cu        = mean(row.cu),        rounded to integer
```

All parameters are editable in Stage 3. Overrides tracked per field in `layer.ovr{}`.

### 3.4 PLAXIS simulated CPT export [IMPLEMENTED]

Stage 3 includes a dedicated PLAXIS export that converts the active interpreted layer model back into a measurement-style CPT text file. The purpose is to create a synthetic CPT that is a **1:1 representation of the final interpreted layering**, not to preserve the original pointwise variability.

The export reuses the original CPT sampling depths and the available CPT coordinates (`X`, `Y`, `Z`). For each original CPT reading depth `z_j`, the app finds the active final layer and writes that layer's representative values as a synthetic CPT row. The result is therefore piecewise constant within each interpreted layer, while preserving the original measurement spacing.

```
qc_export(z_j) = max(0, avgQc(layer(z_j)))                        [MPa]
fs_export(z_j) = max(0, avgFs(layer(z_j)))                        [MPa]
fs_export(z_j) = max(0, avgQc(layer(z_j)) * avgRf(layer(z_j))/100) [MPa], fallback if avgFs missing
```

The exported text format is:

```
X[m] <x coordinate>
Y[m] <y coordinate>
Z[m] <surface elevation>
D[m] Q[MPa] F[MPa] x
<depth> <qc> <fs> 0
...
```

Implementation notes:
- One exported row is written for every original CPT depth row in `S.data`.
- `qc` comes from the final layer average `avgQc`.
- `fs` comes from `avgFs` if available, otherwise from reconstructed `avgQc * avgRf / 100`.
- The last column is currently written as `0`; the export is intended as a PLAXIS-compatible measurement-style CPT with depth, cone resistance, and sleeve friction.
- The downloaded filename is `CPT_<id>_plaxis_simulated.txt`.

---

## Stage 4 — Model Parameters

The engineer selects one of two model parameter methods, independent of the classification method used in Stage 2. The choice applies to all layers and affects how Eoed,ref, E50,ref, Eur,ref and m are derived.

### 4.1 Effective stress at layer midpoint [IMPLEMENTED]

Used by both stiffness methods. The calculation correctly accounts for the position of the water table — above the WT, the unsaturated unit weight γ applies; below, γ_sat applies.

```
z_mid    = (top + bot) / 2
wt       = water table depth (m below surface, set in Stage 1)

sigma_v0 = gamma * wt  +  gamma_sat * (z_mid - wt)    [kPa]  if z_mid > wt
sigma_v0 = gamma * z_mid                                [kPa]  if z_mid <= wt

u        = 9.81 * max(0, z_mid - wt)                  [kPa]  (hydrostatic)
sigma_v0'= max(sigma_v0 - u, 1)                         [kPa]  (floor 1 kPa)
```

where γ = l.g (unsaturated unit weight from Stage 3) and γ_sat = l.gs (saturated).

**Example:** layer top=1.0m, bot=4.0m → z_mid=2.5m. Water table at 1.7m. γ=18, γ_sat=19 kN/m³.
```
sigma_v0 = 18 * 1.7  +  19 * (2.5 - 1.7) = 30.6 + 15.2 = 45.8 kPa
u        = 9.81 * (2.5 - 1.7) = 7.85 kPa
sigma_v0'= 45.8 - 7.85 = 37.95 kPa
```

The Stage 4 layer card shows: σv0 [value] − u [value] = σ'v0 [value] kPa, so the engineer can immediately verify the stress state.

**Note on Robertson (Stage 2):** the Robertson classification uses fixed preliminary unit weights `γ_unsat = 17 kN/m³` and `γ_sat = 18 kN/m³`. This is intentional at Stage 2 because layer-specific values are not yet known. The Stage 4 stiffness calculation always uses the Stage 3 layer values (`γ` and `γ_sat`), including overrides.

### 4.2 Alpha (alphaE) — Sanglerat / SB260 correlation [IMPLEMENTED]

The per-layer oedometer stiffness is estimated from qc via:

```
Eoed,i = alphaE * avgQc * 1000    [kPa]
```

**Method A — Fixed alpha by soil type (current implementation):**

| Type | alphaE |
|------|--------|
| Peat / organic | 1.5 |
| Soft clay | 3.0 |
| Clay | 5.0 |
| Sandy clay | 8.0 |
| Silty sand | 10.0 |
| Sand | 13.0 |
| Gravel | 15.0 |

These are the Sanglerat values as referenced in SB260-21-6.4.10 and commonly applied in Belgian practice.

**Method B — SB260 family mapping from selected EC7 Table 3 soil name [IMPLEMENTED]:**

Source: SB260-21-6.4.10 text + Tabel 21-6-5 (GEO column). The selected **Stage 3 EC7 Table 3 subtype** is the primary mapping key; `avgQc` is then evaluated against the rule for that family. `avgRf` is used indirectly to arrive at the selected EC7 subtype in Stage 3, and as fallback context only if no subtype is available.

The implemented mapping is:

| Family | Soil name | `qc` (MPa) | Rule | Formula / GEO value |
|---|---|---:|---|---|
| Cohesive | `veen, ...` | any | Default SB260 peat rule when `w` unknown | `alpha = 1.5` |
| Cohesive | `klei, ...` | `< 0.7` | CL, GEO default | `alpha = 5` |
| Cohesive | `klei, ...` | `0.7 - <2.0` | CL, GEO default | `alpha = 3` |
| Cohesive | `klei, ...` | `>= 2.0` | CL, GEO default | `alpha = 1.5` |
| Cohesive | `leem, ...` | `< 2.0` | ML, GEO default | `alpha = 4` |
| Cohesive | `leem, ...` | `>= 2.0` | Practical ML/CH mapping | `alpha = 2` |
| Transition | `klei (zh), ...` | `< 2.5` | Transition soil rule | `alpha = 2` |
| Transition | `klei (zh), ...` | `2.5 - <5.0` | Transition soil rule | `Es = 4qc - 5`, so `alpha = (4qc - 5) / qc` |
| Transition | `klei (zh), ...` | `>= 5.0` | Transition soil rule capped beyond formula range | `alpha = 2` |
| Transition | `leem (zh), ...` | `< 2.5` | Transition soil rule | `alpha = 2` |
| Transition | `leem (zh), ...` | `2.5 - <5.0` | Transition soil rule | `Es = 4qc - 5`, so `alpha = (4qc - 5) / qc` |
| Transition | `leem (zh), ...` | `>= 5.0` | Transition soil rule capped beyond formula range | `alpha = 2` |
| Transition | `zand (lh), ...` | `< 2.5` | Transition soil rule | `alpha = 2` |
| Transition | `zand (lh), ...` | `2.5 - <5.0` | Transition soil rule | `Es = 4qc - 5`, so `alpha = (4qc - 5) / qc` |
| Transition | `zand (lh), ...` | `>= 5.0` | Transition soil rule capped beyond formula range | `alpha = 2` |
| Granular | `zand, ...` | `<= 10` | Normally consolidated sand | `Es = 4qc`, so `alpha = 4` |
| Granular | `zand, ...` | `> 10 - <= 50` | Normally consolidated sand | `Es = 2qc + 20`, so `alpha = (2qc + 20) / qc` |
| Granular | `zand, ...` | `> 50` | Normally consolidated sand | `Es = 120`, so `alpha = 120 / qc` |
| Granular | `grind, ...` | `<= 10` | Granular mapped to NC sand rule | `Es = 4qc`, so `alpha = 4` |
| Granular | `grind, ...` | `> 10 - <= 50` | Granular mapped to NC sand rule | `Es = 2qc + 20`, so `alpha = (2qc + 20) / qc` |
| Granular | `grind, ...` | `> 50` | Granular mapped to NC sand rule | `Es = 120`, so `alpha = 120 / qc` |
| Granular | `grind (kh), ...` | `<= 10` | Granular mapped to NC sand rule | `Es = 4qc`, so `alpha = 4` |
| Granular | `grind (kh), ...` | `> 10 - <= 50` | Granular mapped to NC sand rule | `Es = 2qc + 20`, so `alpha = (2qc + 20) / qc` |
| Granular | `grind (kh), ...` | `> 50` | Granular mapped to NC sand rule | `Es = 120`, so `alpha = 120 / qc` |

**Implementation assumptions:**
- `klei (zh)` and `leem (zh)` are treated as **transition soils**, not as plain cohesive soils.
- `zand (lh)` is treated as a **transition soil**.
- `grind` and `grind (kh)` are treated as **granular soils**.
- `w` is **not available in the app**, so peat / veen always defaults to `alpha = 1.5`.
- Overconsolidated sand rules from SB260 are **not implemented** because the app has no OC/NC indicator; all sand and gravel use the **normally consolidated** branch.

The Stage 4 UI provides a toggle: **A — Sanglerat (fixed)** vs **B — SB260 qc-dependent**. The computed alpha is shown per layer card with an inline override input. Engineer override takes absolute priority over both methods.

### 4.3 Model parameter method A — CUR 2003-7 ratios [IMPLEMENTED]

This is the currently implemented approach. It is valid and commonly used in practice.

**m by soil type (fixed defaults, engineer can override):**

| Type | m |
|------|---|
| Peat / organic | 1.00 |
| Clay, Soft clay | 0.85 |
| Sandy clay | 0.65 |
| Sand, Silty sand, Gravel | 0.50 |

Reference: CUR 2003-7. Zand m = 0.5, Klei/leem m = 1.0.

**Eoed,ref — corrected for reference pressure using cohesion:**

The full SB260/CUR 2003-7 formula accounts for cohesion in the reference stress:

```
Eoed,ref = Eoed,i * ((p_ref + c' * cot(phi')) / (sigma_v0' + c' * cot(phi')))^m    [kPa]
```

Reference: SB260-21-6.4.10 (Sanglerat), CUR 2003-7.

For cohesionless soils (c' = 0) this simplifies to:

```
Eoed,ref = Eoed,i * (p_ref / sigma_v0')^m    [kPa]
```

**Implementation note:** The app uses the full cohesion-corrected formula (SB260-21-6.4.10). For c' = 0 soils this reduces to the simple ratio formula.

**E50,ref (CUR 2003-7):**

```
E50,ref = Eoed,ref                   (zand, grind — all granular)
E50,ref = 1.25 * Eoed,ref            (klei, leem, veen — all cohesive)
```

**[IMPLEMENTED]** E50,ref = 1.25 × Eoed,ref for cohesive soils (klei, leem, veen); E50,ref = Eoed,ref for granular. Eur,ref = 3 × E50,ref (not 3 × Eoed,ref).

**Eur,ref (aGEO):**

```
Eur,ref = 3 * E50,ref    [kPa]
```

Note: this is 3 * E50,ref, not 3 * Eoed,ref directly.

**nu_ur (CUR 2003-7 & Plaxis 2D Manual):**

```
nu_ur = 0.2    (for all soil types in unloading/reloading)
```

**K0,nc:**

```
K0,nc = 1 - sin(phi')
```

**Rf:**

```
Rf = 0.90  (fixed)
```

### 4.4 Model parameter method B — E50,ref = Eoed,ref [IMPLEMENTED]

This is an alternative SB260-accepted approach where Eoed,ref and E50,ref are set equal, and the reference stiffness is derived directly from a single consistent value. This method is used in practice when the engineer prefers to work with a single reference stiffness and derive Eur from it.

**Procedure:**

Step 1 — Compute Eoed,i from CPT (identical to Method A):
```
Eoed,i = alphaE * avgQc * 1000    [kPa]
```

Step 2 — Compute Eoed,ref using the full cohesion-corrected formula:
```
Eoed,ref = Eoed,i * ((p_ref + c' * cot(phi')) / (sigma_v0' + c' * cot(phi')))^m    [kPa]
```

Step 3 — Set E50,ref equal to Eoed,ref:
```
E50,ref = Eoed,ref    (for all soil types)
```

Step 4 — Derive Eur,ref:
```
Eur,ref = 3 * E50,ref = 3 * Eoed,ref    [kPa]
```

**Rationale:** In Plaxis, Eoed (tangent stiffness for primary loading) and E50 (secant stiffness at 50% failure stress) are related parameters that depend on the stress path. Setting Eoed,ref = E50,ref is a simplification that is reasonable when Eoed,i is derived from a CPT correlation that already incorporates the stress-path averaging inherent in the CPT measurement. This is the interpretation used in some SB260-compliant geotechnical reports in Flanders.

**Difference from Method A:**
- Method A: E50,ref = 1.25 * Eoed,ref (klei/leem), E50,ref = Eoed,ref (zand)
- Method B: E50,ref = Eoed,ref (all types)
- Eur,ref differs accordingly: Method B gives a slightly lower Eur,ref for cohesive soils (by factor 1/1.25 = 0.8)

**When to use:**
- Method A is preferred when following CUR 2003-7 strictly, particularly for klei and leem where the 1.25 ratio is substantiated
- Method B is acceptable as a conservative simplification, or when the engineer wants a single consistent reference stiffness

The Stage 4 UI provides a toggle: **A — CUR 2003-7 ratios** vs **B — E50 = Eoed**. The active method is shown on each layer card and recorded in the CSV export.

### 4.5 m-fitting from CPT profile — Stage 5 "Tuning" [IMPLEMENTED — experimental]

Accessible via the **Stage 5 — Tuning ⚗** tab, flagged experimental. The engineer runs fitting per-session and explicitly accepts or rejects the result per layer. The type-default m remains in use until accepted.

**Conceptual basis:**

The HS oedometer law is:

```
Eoed(z) = Eoed,ref * ((sigma_v0'(z) + c'*cot(phi')) / (p_ref + c'*cot(phi')))^m
```

Taking the natural log of both sides gives a straight line in log-log space:

```
Y_j = a + m * X_j
where:
  X_j = ln((sigma_v0'(z_j) + c'*cot(phi')) / (p_ref + c'*cot(phi')))
  Y_j = ln(Eoed,i(z_j))
  a   = ln(Eoed,ref)    -->  Eoed,ref = exp(a)
  m   = slope
```

Both the CPT-derived Eoed,i points and the HS model curve are straight on this log-log plot. **Matching their slopes is equivalent to matching their derivatives d(ln Eoed)/d(ln stress_ratio) = m.** OLS regression finds the m that minimises sum of squared log-residuals, which is the same as best-matching the derivative of both lines.

**Procedure per layer:**

For every CPT reading z_j with qc > 0.02 MPa within the layer:

```
sigma_v0'(z_j) = stressAt(z_j, gamma_sat, gamma)  [correct WT split]
Eoed,i(z_j)    = alphaE * qc(z_j) * 1000          [kPa]
c_cotphi       = c' * cos(phi') / sin(phi')        (0 for c'=0)

X_j = ln((sigma_v0'(z_j) + c_cotphi) / (p_ref + c_cotphi))
Y_j = ln(Eoed,i(z_j))
```

OLS solution:

```
m_fit    = cov(X,Y) / var(X)                 clamped to [0.30, 1.20]
Eoed_ref = exp(mean_Y - m_fit * mean_X)      [kPa]
R2       = 1 - SS_res / SS_tot               (in log space)
```

**Quality flags:**

| Condition | Flag |
|---|---|
| n < 10 readings | Warning: too few points |
| max(sigma'v0) / min(sigma'v0) < 1.5 | Warning: stress range too small |
| layer top < 0.5 m | Warning: too shallow |
| R2 < 0.50 | Warning: poor fit — heterogeneous layer? |
| R2 0.50-0.70 | Acceptable — review chart |
| R2 >= 0.70 | Good fit |

**Workflow:**

1. Complete Stage 4 (review default stiffness)
2. Open Stage 5 — Tuning ⚗, click "Run fitting"
3. Each layer shows: scatter of CPT data points + blue default line + green fitted line
4. "Accepteer fit" stores m_ovr → Stage 4 immediately recomputes Eoed,ref with new m
5. "Herstel default" reverts to type-default at any time

**Engineer control:** accepting a fit sets layer.ovr.m = true and layer.m_ovr = m_fit. Eoed,ref is always recalculated — never stored separately. The Stage 4 inline m input overrides anything, including the fitted value. Changing alpha method (Stage 4) changes both scatter and fitted line — rerun fitting after changing alpha.
### 4.6 Additional parameters [IMPLEMENTED / PLANNED]

**nu_ur [IMPLEMENTED]:**
```
nu_ur = 0.2    (CUR 2003-7 & Plaxis 2D Manual)
```

**Mohr-Coulomb E_ref [IMPLEMENTED]:**
```
nu     = 0.45  (Peat)
       = 0.35  (Clay, Soft clay)
       = 0.30  (all others)

E_ref  = E50,i                                      [kPa]

Method A (CUR 2003-7 ratios):
E50,i  = 1.25 * Eoed,i    (Clay, Soft clay, Peat / organic)
E50,i  = Eoed,i           (all other soils)

Method B (E50 = Eoed):
E50,i  = Eoed,i           (all soils)

psi    = max(0, phi' - 30)     [degrees, dilatancy angle]
```

**Source basis.** The official PLAXIS Material Models Manual states that the
Mohr-Coulomb model uses Young's modulus `E` as its basic stiffness parameter and
that, for loading of soils, one generally uses `E50` rather than `E0`. Because
the Mohr-Coulomb export is a constant-stiffness material, the app uses the
current-stress loading stiffness `E50,i`, not the Hardening-Soil reference-stress
quantity `E50,ref`.

**Implementation note.** No extra empirical multiplier is applied. The earlier
`× 1.5` heuristic was removed because no primary source was retained for it.

### 4.7 Hydraulic conductivity kh and kv [IMPLEMENTED / PLANNED]

Reference sources used (in order of preference for Belgian practice):

1. **Tabel 2-44** — OVAM (2002): kh richtwaarden per Belgian texture class. Source: I/RA/11461/15.066/JSW, p. 149.
2. **Tabel 2-45** — De Smedt (VUB, 2005): k richtwaarden per USDA texture class. Source: I/RA/11461/15.066/JSW, p. 150.

Both tables give ranges for undisturbed soils (ongestoorde gronden). The report explicitly notes that within a single texture class, values can vary by a factor 10 to 100. In situ measurement always takes priority over table values.

#### Mapping from CPT soil type to kh

The CPT app maps its classified soil types to kh using **Tabel 2-44 (OVAM)** as primary reference, supplemented by Tabel 2-45 for finer granular subdivision. The mapping is:

| CPT type (app) | Belgian texture class (OVAM Tabel 2-44) | kh,min (m/s) | kh,max (m/s) | kh,rep (m/s) |
|---|---|---|---|---|
| Peat / organic | veen (not in OVAM table — De Beer / Tabel 2-46) | 6e-8 | 6e-7 | 2e-7 |
| Clay | klei | < 1.2e-7 | 1.2e-7 | 5e-8 |
| Soft clay | klei (weinig vast) | < 1.2e-7 | 1.2e-7 | 2e-8 |
| Sandy clay | leem; zandige leem; kleiig zand | 1.2e-7 | 1.2e-6 | 5e-7 |
| Silty sand | lemig zand; fijn zand (lower bound) | 1.2e-6 | 1.2e-5 | 3e-6 |
| Sand | lemig zand; fijn zand to middelgrof zand | 1.2e-6 | 2.3e-4 | 1e-5 |
| Gravel | grind | 2.3e-4 | 1.2e-2 | 1e-3 |

**kh,rep** is the representative (geometric mean of range) value pre-filled by the app. The engineer must always review and override with site-specific values or in situ test results.

For the Sand type, the range spans lemig zand to middelgrof zand. Sub-classification using the SB260 subtype (zand los / matig / dicht / zeer dicht) refines this:

| SB260 subtype | kh range (m/s) | kh,rep (m/s) |
|---|---|---|
| zand, los (qc 2-4 MPa) | 1.2e-6 to 1.2e-5 | 3e-6 |
| zand, matig (qc 4-10 MPa) | 1.2e-5 to 1.2e-4 | 4e-5 |
| zand, dicht (qc 10-15 MPa) | 1.2e-4 to 2.3e-4 | 1.5e-4 |
| zand, zeer dicht (qc >= 15 MPa) | 1.2e-4 to 2.3e-4 | 2e-4 |

For Gravel, Tabel 2-45 gives further subdivision:

| Tabel 2-45 textuur | k (m/s) |
|---|---|
| Grof grind | > 0.1 |
| Medium grind | 0.01 to 0.1 |
| Fijn grind | 1e-3 to 1e-2 |

#### kh/kv anisotropy ratio

Source: CUR 2003-7 (referenced in model parameter table).

```
kh/kv = 1    (zand, grind — isotropic)
kh/kv = 3    (klei, leem, fijn zand — layered anisotropy)
kh/kv = 3    (veen — typically higher, but 3 used as conservative minimum)
```

In Plaxis: kx = kh (horizontal), ky = kv = kh / (kh/kv ratio).

#### Design thresholds for infiltration (from §5.2, I/RA/11461/15.066/JSW)

The report provides the following decision thresholds for infiltration design, based on hydraulic conductivity:

| Infiltratiecapaciteit | Design recommendation |
|---|---|
| k > 0.50e-6 m/s | Full infiltration only — no buffer needed |
| 0.10e-6 to 0.50e-6 m/s | Infiltration still effective for RWZI load reduction and groundwater recharge |
| 0.01e-6 to 0.10e-6 m/s | Combine infiltration and buffer (equal volumes) to reduce peak discharges |
| k < 0.01e-6 m/s | Buffer only (if area >= 5000 m²); infiltration contribution negligible |

These thresholds apply to the **in situ measured infiltration capacity**, not to the table-derived kh. The app displays the applicable recommendation based on the kh,rep value, flagged clearly as indicative only.

The Stage 4 implementation currently derives and shows:
- `kh_min`, `kh_max`, `kh_rep`
- `kh/kv`
- `kv_rep`
- infiltration class
- `psi_unsat` suggestion

The CSV export records `kh_ms`, `kv_ms`, `khkv`, `psi_unsat_m`, and the infiltration class. The current PLAXIS material-command export uses **only** `kh_rep` and `kv_rep`, converted from `m/s` to `m/day`.

#### psi_unsat — unsaturated suction head [PLANNED]

Source: Plaxis 2D Manual.

```
psi_unsat = 0.1 m    (zand)
           = 1.0 m    (leem)
           = 3.0 m    (klei)
           = 1.0 m    (veen — approximation)
```

Used in Plaxis groundwater flow boundary conditions for the unsaturated zone above the water table.

### 4.8 PLAXIS material export [IMPLEMENTED]

Stage 4 includes a second export path, in addition to the CSV layer table: a PLAXIS material-command export for the currently active layer model.

After implementation review and testing, the app does **not** attempt to write native `*.matXdb` files directly. Bentley V22+ `*.matXdb` files are XML-based on disk and the public supported workflow is to create project materials through `soilmat` commands or through the PLAXIS UI, then optionally copy those project materials into a reusable global material database from inside PLAXIS itself.

The app therefore exports a plain-text command file. For every interpreted layer, it writes:
- one **Mohr-Coulomb** material command
- one **Hardening Soil** material command

Material names follow:

```
name = safe(CPT_id) + "_L" + layer_index + "_" + safe(subtype) + "_MC"
name = safe(CPT_id) + "_L" + layer_index + "_" + safe(subtype) + "_HS"
```

where `safe(...)` removes or normalises spaces, brackets, commas, and other unsafe characters.

**Drainage rule used by the export:**

```
IF subtype contains '(lh)' OR '(kh)' OR wording such as 'leemhoudend' / 'klei-/leemhoudend':
    DrainageType = 'Undrained A'
ELSE IF type is Sand or Gravel:
    DrainageType = 'Drained'
ELSE:
    DrainageType = 'Undrained A'
```

This means:
- clean sand and clean gravel export as `Drained`
- `zand (lh)` and `grind (kh)` export as `Undrained A`
- all clay, loam, peat, and other non-clean granular materials export as `Undrained A`

**Properties written for Mohr-Coulomb (`SoilModel = 2`):**
- `Identification`
- `SoilModel`
- `DrainageType`
- `gammaUnsat`
- `gammaSat`
- `ERef`
- `nu`
- `cRef = max(c', 0.1)`
- `phi`
- `psi`
- `PermHorizontalPrimary`
- `PermVertical`

**Properties written for Hardening Soil (`SoilModel = 3`):**
- `Identification`
- `SoilModel`
- `DrainageType`
- `gammaUnsat`
- `gammaSat`
- `E50Ref`
- `EOedRef`
- `EURRef`
- `PowerM`
- `pRef = 100`
- `cRef = max(c', 0.1)`
- `phi`
- `psi`
- `PermHorizontalPrimary`
- `PermVertical`

**Properties intentionally not written in the current PLAXIS command export:**
- `RF`
- `nuUR`
- `K0NC`
- `cu`
- `psi_unsat`

Rationale:
- `RF` caused a read-only property error in the tested PLAXIS workflow.
- `nuUR` and `K0NC` are intentionally left to PLAXIS to calculate or manage automatically in the current workflow.
- `cu` is not required for `Undrained A`, which uses effective parameters.
- `psi_unsat` is available in the app but is not yet written by the export.

**Hydraulic conductivity units:**

The app stores and displays the representative conductivity values in `m/s`, but the PLAXIS material command export converts them to `m/day` before writing:

```
k_plaxis = 86400 * k_app
```

so:

```
PermHorizontalPrimary = 86400 * kh_rep
PermVertical          = 86400 * kv_rep
```

**Engineer workflow:**
1. Review and, if needed, override the final Stage 3 parameters and Stage 4 stiffness/hydraulic values.
2. Export the PLAXIS command file from Stage 4.
3. Run the commands inside a PLAXIS project to create the project materials.
4. If a reusable `*.matXdb` is needed, copy the created project materials into the global PLAXIS material database from inside PLAXIS.

---

## Known limitations

**Robertson single-pass:** Stage 2 uses fixed preliminary unit weights (`γ_unsat = 17`, `γ_sat = 18 kN/m³`) and, when available, corrects `qc` to `qt` using `u2` and net area ratio `a`. This is still a preliminary classification-stage estimate, not a final stress model.

**Eurocode / NEN Table 3 order and Rf ranges:**

| Gate | Rf range | qc condition | Result |
|---|---|---|---|
| Grind | < 1% | qc ≥ 10 | Gravel |
| Grind, leem- of kleihoudend | 1–2% | qc ≥ 10 | Gravel |
| Zand | < 1% | qc ≥ 2 | Sand |
| Leem- of kleihoudend zand | 1–2% | qc ≥ 2 | Sand |
| Leem | 2–4% | qc ≥ 0.4 | Sandy clay |
| Zandhoudende leem | 1–3% | qc ≥ 0.4 | Sandy clay |
| Klei | 3–6% | qc ≥ 0.4 | Clay |
| Klei zandhoudend | 2–5% | qc ≥ 0.4 | Clay |
| Veen | > 6% | qc ≥ 0.2 | Peat / organic |

Within each gate, qc determines consistency (weinig vast / matig vast / vrij vast / vast) or compaction (los / matig / dicht / z.dicht).

**Overlap handling:** because the table itself overlaps, the app resolves matches in the same order as the table rows: grind, zand, leem, klei, veen.

**Thin-layer merge direction:** upward only. The topmost segment is never merged regardless of t_min.

**E50,ref for clay:** Method A correctly uses 1.25 × Eoed,ref (CUR 2003-7). Method B uses E50,ref = Eoed,ref. Both implemented.

**m fitting:** Stage 5 fitting is implemented, but remains an engineer-accepted override rather than an automatic replacement of the type default.

**Cohesion correction in Eoed,ref:** The full SB260-21-6.4.10 formula including c' × cot(φ') is now implemented. For c' = 0 soils the result is identical to the simplified form.

---

---

## Multi-CPT Project — Architecture and Design [PLANNED]

This section documents the design for extending the single-CPT tool into a full multi-CPT project workflow. The existing 5-tab analysis view (Stages 1–5) is preserved unchanged and continues to work for a single CPT. The multi-CPT layer sits above it.

---

### Project structure — three phases

The multi-CPT workflow has three distinct phases, accessible via a phase switcher in the top banner:

```
Phase A — Analysis    : single-CPT view (the existing 5-tab system)
Phase B — Correlation : cross-CPT layer matching
Phase C — Section     : geological cross-section visualisation
```

A project can contain 1 to N CPTs. With a single CPT, Phase B and C are still available but trivially simple.

---

### UI architecture [PLANNED]

#### Top banner (always visible, above the nav bar)

```
┌─────────────────────────────────────────────────────────────────────┐
│ 📁 Bosrede 2A     CPT-1 ✓  CPT-2 ✓  CPT-3 ⚡  + Add CPT          │
│                   [Analysis]  [Correlation]  [Cross-section]         │
└─────────────────────────────────────────────────────────────────────┘
```

- **Project name** (editable, click to rename)
- **CPT tabs** — one tab per loaded CPT:
  - ✓ = analysis complete through Stage 4 (layers confirmed)
  - ⚡ = loaded but not yet fully analysed
  - ✗ = load error
  - Active CPT highlighted
  - "+ Add CPT" button opens file picker or drag target
- **Phase switcher** — three buttons: Analysis | Correlation | Cross-section
  - Analysis: shows the 5-tab stage nav below
  - Correlation: replaces the 5-tab view with the correlation panel
  - Cross-section: replaces the 5-tab view with the section canvas

The 5-tab nav (Load, Classification, Layer ID, Model, Tuning) is only visible in Analysis phase. The CPT tabs and phase switcher are always visible.

#### Backward compatibility

With a single CPT loaded, the UI is nearly identical to the current single-CPT tool. The banner adds one row at the top. Phase B shows a message "Load at least 2 CPTs for correlation." Phase C shows a message "Load at least 2 CPTs for cross-section." The existing behaviour of all 5 stages is unchanged.

---

### State architecture [PLANNED]

#### Project-level state

```javascript
PROJECT = {
  name: 'Bosrede 2A',
  cpts: [CPT_STATE, CPT_STATE, ...],  // one per loaded CPT
  activeCptIdx: 0,                     // which CPT is shown in the 5-tab view
  correlations: [],                    // cross-CPT layer matches (Phase B output)
  sectionOrder: [0, 1, 2],            // CPT indices in section-left-to-right order
}
```

#### Per-CPT state (CPT_STATE)

Identical to the current `S` object, extended with:

```javascript
{
  // existing S fields (data, wt, elev, classified, layers, tuning, etc.)
  ...S,

  // new project-level fields
  id:       'CPT-1',          // display name, editable
  x:        0.0,              // easting coordinate (m)
  y:        0.0,              // northing coordinate (m)
  // elev already exists (m TAW from ZID or override)
}
```

#### Active CPT proxy

`S` (the global used by all existing functions) is a live reference to `PROJECT.cpts[PROJECT.activeCptIdx]`. Switching CPTs reassigns this reference:

```javascript
function selectCpt(idx){
  PROJECT.activeCptIdx = idx;
  S = PROJECT.cpts[idx];       // all existing functions pick up new state
  renderActiveCptBanner();
  goS(0);                      // reset to Stage 1 of new CPT
}
```

All existing functions (parseGEF, runClass, detectLayers, hsParams, renderModel, fitLayer, etc.) reference `S` and require no changes.

---

### Phase A — Analysis

Unchanged. The 5-tab stage nav operates on the currently selected CPT (S = PROJECT.cpts[active]). The only addition is that after loading a file, the CPT's `id` is set from the filename (stripping `.GEF`), and `x` / `y` coordinates can be entered in Stage 1.

#### Stage 1 additions for multi-CPT

In Stage 1 (Load & preview), two additional fields appear in the metadata grid:
- **CPT name** — editable text input (default: filename without extension)
- **X coordinate (m)** — numeric input, local or RD coordinate system
- **Y coordinate (m)** — numeric input

These feed into Phase B and C. They are optional for single-CPT use.

---

### Phase B — Cross-CPT Correlation [PLANNED]

#### Goal

Find which layers in CPT-A correspond to the same geological unit as layers in CPT-B (and CPT-C, etc.). The result is a set of **correlated layer groups** — each group contains one layer per CPT (or a gap marker where the layer is absent).

#### Coordinate system

All correlations are done in **absolute elevation (m TAW)**, not depth. This requires a confirmed surface elevation for each CPT. If a CPT has no elevation set, it is flagged and excluded from correlation.

```
layer_top_TAW    = CPT.elev - layer.top    [m TAW]
layer_bot_TAW    = CPT.elev - layer.bot    [m TAW]
layer_mid_TAW    = (layer_top_TAW + layer_bot_TAW) / 2
```

#### Distance between CPTs

```
distance(A, B) = sqrt((Ax - Bx)^2 + (Ay - By)^2)    [m, horizontal]
```

#### Correlation algorithm

**Step 1 — Build candidate pairs (per CPT pair)**

For each pair of CPTs (A, B):
For each layer L_A in CPT-A:
  For each layer L_B in CPT-B:
    Compute match_score(L_A, L_B)

**Match score:**

```
elevation_overlap:
  top_A = layer_A.top_TAW,  bot_A = layer_A.bot_TAW
  top_B = layer_B.top_TAW,  bot_B = layer_B.bot_TAW
  overlap_m  = max(0, min(top_A, top_B) - max(bot_A, bot_B))
  union_m    = max(top_A, top_B) - min(bot_A, bot_B)
  IoU        = overlap_m / union_m    (Intersection over Union, 0–1)

elevation_gap:
  gap_m = max(0, max(bot_A, bot_B) - min(top_A, top_B))
  gap_tolerance = 0.30 + 0.01 * distance(A,B)    [m, grows 1cm per meter distance]
  gap_score = max(0, 1 - gap_m / gap_tolerance)

type_score:
  'ok'  = same CPT type             → 1.0
  'adj' = adjacent/compatible type  → 0.5
  'bad' = incompatible type         → 0.0
  (uses existing COMPAT matrix)

qc_score:
  qc_ratio = min(avgQc_A, avgQc_B) / max(avgQc_A, avgQc_B)    [0–1]
  (penalises large qc differences, allowing for natural variation)

match_score = 0.5 * IoU + 0.3 * gap_score + 0.15 * type_score + 0.05 * qc_score
```

If match_score < 0.25 → no match (layers are unrelated).

**Step 2 — Greedy assignment**

Sort all candidate pairs by match_score descending. Assign greedily: accept a pair if neither layer has been matched yet. Result: a set of matched pairs for each CPT-CPT combination.

**Step 3 — Group transitivity**

If A-B and B-C have matches, and A-C also has a match, merge into a triple group. Use union-find (disjoint set) to propagate matches across all CPTs.

Formally: each matched pair creates an edge in a graph where nodes are (CPT_idx, layer_idx). Connected components of this graph become correlated groups.

**Step 4 — Gap detection**

For each correlated group, check which CPTs are missing from the group. A CPT is "missing" if:
- Its surface elevation is within the expected elevation range of the group (i.e., the group should be present in that CPT's depth range)
- But no layer from that CPT was assigned to the group

If missing: the layer is either:
- **Absent** (pinched out, eroded, not deposited) — flagged with a gap marker
- **Not resolved** (classification ambiguity, thin layer merged away) — flagged differently

Heuristic: if the CPT's qc profile in the expected elevation range shows the same soil type as the group, it was likely merged or not detected. Otherwise it is genuinely absent.

**Step 5 — Manual override**

The engineer can in Phase B:
- Manually link two layers that the algorithm did not match
- Break an automatically created link
- Mark a gap as "pinched out" or "not resolved"
- Reorder CPTs along the section

#### Limitations and failure modes

- **Dipping stratigraphy:** if layers dip steeply, the elevation-based IoU underestimates correlation. The gap_tolerance partially compensates via the distance term. If the dip is known (e.g. from geological maps), the engineer can apply a dip correction to the expected elevations before running correlation — not automated in Phase B, but documented as a manual workflow.

- **Faulted or disturbed ground:** the algorithm assumes continuous (or gently varying) stratigraphy. If there is a fault between CPTs, the algorithm may produce spurious matches. Phase B provides a visual comparison table (see below) to detect this.

- **Only 2 CPTs:** transitivity step is trivially satisfied. Match score is the only criterion.

- **Unequal depth ranges:** CPT-A may be deeper than CPT-B. Layers below CPT-B's toe are automatically marked as "not sampled" in CPT-B.

#### Phase B UI — Correlation table

A matrix view: rows = correlated groups (sorted by mean elevation, top to bottom), columns = CPTs (sorted by section distance left to right).

```
Group │ Elev. range (TAW) │  CPT-1  │  CPT-2  │  CPT-3
──────┼───────────────────┼─────────┼─────────┼──────────
  1   │ +68.5 to +67.0   │  zand   │  zand   │  zand ✓
  2   │ +67.0 to +64.5   │  klei   │  klei   │  ─── ⚠
  3   │ +64.5 to +62.0   │  leem   │  leem   │  leem ✓
  4   │ +62.0 to +58.0   │  ─── ⚠ │  zand   │  zand ✓
  5   │ +58.0 to +54.0   │  zand   │  zand   │  zand ✓
```

- ✓ = matched, good confidence (score > 0.7)
- ~ = matched, moderate confidence (score 0.4–0.7), shown with amber highlight
- ─── ⚠ = gap (layer absent or not detected in this CPT)

Each cell is clickable to:
- View that CPT's layer detail (depth, avgQc, subtype)
- Manually link/unlink
- Override gap classification

Below the table: "Run auto-correlation" button + match confidence summary.

---

### Phase C — Cross-section [PLANNED]

#### Goal

Render a geological cross-section: vertical slice through the ground showing all correlated layers as colored bands between CPT positions, with correct absolute elevations.

#### Projection onto the section plane

The section is a vertical plane through the CPT positions. With N CPTs at (xi, yi), the section line is the best-fit straight line (PCA of the XY coordinates). Each CPT is projected onto this line:

```
centroid = mean(xi, yi)
[dx, dy] = first eigenvector of cov([[xi-cx], [yi-cy]])    (unit vector along section)

section_distance(i) = (xi - cx) * dx + (yi - cy) * dy    [m]
```

CPTs are then sorted by section_distance. The engineer can manually reorder if the auto-sort is wrong (e.g. for a non-straight section through 3+ CPTs).

#### Canvas coordinate system

```
canvas_x = margin_left + (section_distance - min_section_dist) / total_section_length * canvas_width
canvas_y = margin_top  + (max_elev_TAW - elev_TAW) / elev_range * canvas_height
```

Scale bars shown for both horizontal (m) and vertical (m TAW) axes.

#### Rendering layers (correlated groups)

For each correlated group:
1. Collect (section_distance, top_TAW, bot_TAW) for each CPT that has this layer
2. Sort by section_distance
3. Draw a polygon:
   - Upper edge: line connecting (sd_i, top_TAW_i) for all CPTs with this layer
   - Lower edge: line connecting (sd_i, bot_TAW_i) for all CPTs with this layer, reversed
   - Fill with the soil type color (SCFILL)
   - Stroke with a thin dark line

**Pinch-out handling (gap CPTs):**

If CPT-B is missing from a correlated group (gap), but CPT-A and CPT-C both have it:
- Interpolate the expected layer at CPT-B: `top_B_interp = interp(top_A, top_C, dist_A, dist_B, dist_C)`
- Draw the polygon as if the layer tapers to zero thickness at CPT-B's position:
  - Taper point: `(sd_B, (top_B_interp + bot_B_interp) / 2)` — a pinch point
  - The polygon narrows to this point on both upper and lower edges
- Draw a vertical dashed line at CPT-B's position indicating the gap

**No-match layers (layer present in only one CPT):**

Draw as a lens shape: the polygon is triangular, tapering from full thickness at the CPT position to zero at a distance of `d_taper = min(0.5 * distance_to_nearest_neighbor, 5.0)` on each side.

**Unresolved zones (CPTs with completely different stratigraphy):**

If two adjacent CPTs have zero matched groups between them: draw a vertical hatched zone between them labelled "Stratigrafie niet gecorreleerd." The engineer should inspect both CPTs and either (a) add a manual boundary, or (b) accept that the ground conditions are genuinely discontinuous.

#### CPT columns at their positions

At each CPT's section_distance position, draw a narrow vertical column (width = 10–15px) showing:
- The soil-type color per layer (same as the polygon fill)
- The CPT identifier at the top
- Depth/elevation labels at layer boundaries

#### Water table line

For each CPT that has a confirmed water table and surface elevation, plot the WT at `elev_wt_TAW = CPT.elev - CPT.wt`. Connect the WT points between CPTs with a blue dashed line. Mark with "Freatisch oppervlak" label.

#### Scale, legend, export

- Horizontal and vertical scale bars
- Legend: soil type color swatches + labels
- 1:1 vs exaggerated vertical scale toggle (geotechnical cross-sections typically exaggerate vertical 2–5×)
- Export as SVG (button) or PNG

#### Limitations

- **Non-planar sections:** the projection assumes a straight line. For curved sections (e.g. following a road alignment), the user must split into multiple straight sub-sections.
- **Vertical exaggeration:** geological cross-sections routinely use 2–5× vertical exaggeration to make thin layers visible. The default is 2×, with a slider.
- **Interpolation between CPTs:** linear interpolation of layer boundaries is the default. This is geologically naive (layers can dip, lens, erode) but is correct as a first approximation. The engineer must use geological judgement.
- **No fault modelling:** discontinuities across faults are represented as gaps only.

---

### Implementation sequence [PLANNED]

1. **Refactor state** — wrap S into PROJECT.cpts[], implement selectCpt() proxy
2. **Top banner** — CPT tabs, project name, phase switcher HTML + CSS
3. **Stage 1 additions** — CPT name, X/Y coordinate inputs
4. **Multi-CPT upload** — drag multiple files, add-CPT button
5. **Phase B** — correlation algorithm, correlation table UI, manual link/unlink
6. **Phase C** — section projection, SVG renderer, pinch-out, legend, export

Stages 1–5 of the per-CPT analysis require no changes.

---

## Stage 6 — First engineering use cases from a single CPT [DRAFT / REVIEW]

### Scope

Stage 6 is the first step from **soil interpretation** to **engineering use**. To keep the first implementation basic and auditable, Stage 6 should initially work on **one CPT only**:

- use the layered profile from Stages 2–5
- use the current phreatic level and layer parameters from Stages 3–5
- produce a simple, vertically resolved engineering estimate
- avoid 2D / 3D groundwater flow or full FEM at this stage

This section outlines **three candidate features** for review before implementation.

### Stage 6 combination policy [Belgium]

To keep the Stage 6 tools transparent in Belgian practice, each application should expose the relevant combination route instead of hiding it:

- **Bearing capacity**
  - Belgian EC7 **ULS**
  - default = **governing of DA1/1 and DA1/2**
  - `DA1/1 = 1.35 * Gk + 1.50 * (Qlead + psi0 * Qother)` with M1 soil strengths
  - `DA1/2 = 1.00 * Gk + 1.30 * (Qlead + psi0 * Qother)` with M2 soil strengths
  - user may inspect `DA1/1` or `DA1/2` separately

- **Settlement**
  - **SLS**
  - default = **quasi-permanent** combination
  - `frequent` and `characteristic` remain selectable for shorter-term serviceability screening

- **Dewatering**
  - **SLS only**
  - use the **characteristic expected drawdown** directly
  - do **not** factor the drawdown by EC7 ULS partial factors in this module

- **Beam / slab on Winkler**
  - **SLS** combination selectable for deflection
  - default = **quasi-permanent** for long-term deflection
  - **ULS** action set selectable for reinforcement
  - default = **Eq. 6.10 A1** for ordinary building gravity loading in this screening tool

### Option A — Dewatering impact estimator [DRAFT]

#### Goal

Estimate how a change in phreatic head affects the groundwater level and the effective stress profile beneath / around a dewatered zone, using an analytical method from the groundwater literature.

#### Intended user workflow

1. User starts from one CPT with a known ground level and default water table
2. User sets:
   - initial phreatic level / head
   - target lowered head
   - geometry assumption (first-pass: circular pit or equivalent radius, or line dewatering / trench)
   - optional hydraulic conductivity per layer or representative global value
3. Program estimates the phreatic drawdown profile analytically
4. Program recalculates:
   - water table at the CPT
   - pore pressure `u(z)`
   - effective stress `σ'v(z)`
   - indicative impact on `E_oed,ref` / settlements if linked later

#### First-pass analytical basis

For a first implementation, use a **Dupuit-Thiem style steady-state analytical approach**:

- unconfined aquifer: Dupuit approximation
- confined aquifer: Thiem equation

Possible basic formulas:

**Confined aquifer, radial steady flow:**
```
Q = 2 * pi * k * H * (h0 - hw) / ln(R / rw)
```

**Unconfined aquifer, Dupuit approximation:**
```
Q = pi * k * (h0^2 - hw^2) / ln(R / rw)
```

where:
- `k` = hydraulic conductivity
- `h0` = initial head
- `hw` = target head at well / excavation
- `R` = radius of influence
- `rw` = equivalent well radius

For the radius of influence, a simple engineering first pass can use a **Sichardt-type estimate**:
```
R ≈ C * s * sqrt(k)
```

where:
- `s` = drawdown
- `k` in m/s
- `C` = empirical factor per chosen convention

#### Outputs

- estimated head at CPT location
- updated water table elevation
- updated `u(z)` and `σ'v(z)` profiles
- table / plot of drawdown versus depth or distance
- optional “before / after dewatering” profile comparison

#### Why it fits this app

- directly reuses the current water-table-aware stress calculation
- does not require a finite element groundwater model
- is useful for excavation and temporary works screening

#### Limitations / caveats

- strongly idealised steady-state flow
- layered anisotropy and leakage are simplified or ignored
- one-CPT mode means lateral heterogeneity is not modelled explicitly
- should be presented as a **screening tool**, not a permit-grade groundwater study

#### Draft references

- Dupuit, J. (1863). *Études théoriques et pratiques sur le mouvement des eaux*.
- Thiem, G. (1906). *Hydrologische Methoden*.
- Sichardt, W. (1928). empirical radius-of-influence relation for dewatering practice.
- Bear, J. (1979). *Hydraulics of Groundwater*.

### Option B — Settlement estimator [DRAFT]

#### Goal

Estimate 1D settlement beneath a simple loaded foundation using the CPT-derived layered profile.

#### Intended user workflow

1. User chooses foundation type:
   - slab
   - strip footing
   - isolated footing
2. User enters geometry:
   - width `B`
   - length `L` where relevant
   - founding depth `Df`
3. User enters load:
   - characteristic / design load
   - optionally self-weight and surcharge separately
4. Program calculates vertical stress increase with depth along the centreline
5. Program integrates settlement over the compressible layers

#### First-pass analytical basis

Use a classical **1D constrained settlement approach**, linked to the CPT-derived `E_oed`:

For each layer increment:
```
dS = (delta_sigma_v / E_oed,used) * dz
```

Total settlement:
```
S = integral(dS) ≈ sum((delta_sigma_v,i / E_oed,i) * dz_i)
```

Stress increase beneath the centreline can be obtained analytically from influence-factor methods:

- strip footing: Boussinesq / elastic influence factors in 2D plane strain approximation
- rectangular footing / slab patch: Boussinesq-based rectangular loaded area solution
- practical implementation option: Newmark / Fadum style influence factors

General form:
```
delta_sigma_v(z) = q_net * I_z(B, L, z)
```

where:
- `q_net` = net foundation pressure
- `I_z` = vertical stress influence factor

#### First-pass options for stiffness choice

To keep it simple, the first version should allow:

1. `E_oed,ref` from Stage 4 + stress correction to depth, or
2. direct use of `E_oed,i` / tuned `m` profile from Stage 5

This gives a settlement profile that is fully traceable back to the CPT.

#### Outputs

- total estimated settlement
- settlement contribution per layer
- stress increase with depth along the centreline
- plot:
  - `delta_sigma_v(z)`
  - `E_oed(z)`
  - cumulative settlement `S(z)`

#### Why it fits this app

- directly uses the current layered CPT-derived stiffness model
- naturally benefits from Stage 5 tuning of `m`
- produces a useful geotechnical screening result without needing FEM

#### Limitations / caveats

- first version is 1D / centreline only
- no raft redistribution, no edge effects, no nonlinear bearing interaction
- immediate settlement only unless consolidation is added later
- should be labelled as **screening / preliminary design**

#### Draft references

- Terzaghi, K. & Peck, R.B. (1967). *Soil Mechanics in Engineering Practice*.
- Poulos, H.G. & Davis, E.H. (1974). *Elastic Solutions for Soil and Rock Mechanics*.
- Newmark, N.M. influence chart method for vertical stress under loaded areas.
- Boussinesq, J. (1885). elastic stress solution for a loaded half-space.

### Option C — Slab bending and reinforcement estimator [DRAFT]

#### Goal

Calculate the design bending moment in a simple slab strip and determine the required reinforcement area according to Eurocode 2.

#### Intended user workflow

1. User sets:
   - slab width / design strip width
   - slab thickness `h`
   - exposure class and durability assumptions
   - concrete class (default e.g. `C30/37`)
   - steel grade (default e.g. `BE500S`)
   - load / line load / soil reaction assumption
2. Program calculates:
   - design bending moment
   - effective depth `d`
   - recommended EC2 nominal cover `c_nom`
   - required steel area `A_s,req`
3. Program returns:
   - required `mm²/m`
   - EC2 durability audit for the chosen exposure
   - optional bar spacing suggestions later

#### First-pass analytical basis

This is the simplest option mathematically, but it is also the least directly CPT-driven unless tied to a soil reaction model.

For a basic reinforced-concrete strip:
```
M_Ed = function(load, support model, strip width)
```

Then:
```
d = h - c_nom - phi_bar / 2
z ≈ 0.9 * d
f_yd = f_yk / gamma_s
```

Required steel:
```
A_s,req = M_Ed / (z * f_yd)
```

#### Durability / cover route now intended for Stage 6

The beam / slab-on-Winkler tool should not ask the engineer to guess `c_nom` first. It should derive the recommended cover from EC2 durability logic and still allow an explicit override.

Use the following EC2 route:

1. **Exposure class selection**
   - use the EC2 / EN 1992-1-1 Table 4.1 exposure classes
   - the dropdown should spell out the meaning of the class, e.g.:
     - `XC2 = wet, rarely dry`
     - `XC4 = cyclic wet and dry`
     - `XD3 = chlorides, cyclic wet and dry`
     - `XF4 = freeze-thaw, severe`

2. **Structural class**
   - start from `S4`
   - modify per EC2 Table 4.3N:
     - `+2` for 100-year design working life
     - `-1` for design working life `<= 25 years`
     - `-1` if `fck` reaches the exposure-dependent high-strength threshold
     - `-1` for slab-like geometry
     - `-1` for special quality control
   - clamp to `S1 ... S6`

3. **Durability cover**
   - get `c_min,dur` from EC2 Table 4.4N using structural class and exposure column
   - for `XF` and `XA`, use the corrosion-cover fallback route:
     - `XF1`, `XF2`, `XF3`, `XA1`, `XA2` -> `XC4`
     - `XF4`, `XA3` -> `XD3`
   - note in the app that XF/XA concrete mix requirements still need a separate EN 206 durability check

4. **Bond cover**
   - `c_min,b = phi_bar`
   - add `5 mm` if `d_g > 32 mm`

5. **Nominal cover**
   - `c_min = max(c_min,b, c_min,dur, 10)`
   - `c_nom,raw = c_min + Delta c_dev + extra_ground_cast`
   - if cast against prepared ground, `c_nom >= 40 mm`
   - if cast against unprepared ground, `c_nom >= 75 mm`
   - round `c_nom` up to the next `5 mm`

6. **Engineer override**
   - the engineer may override `c_nom`
   - if the override is lower than the EC2 recommendation, the app should keep it visible but show a warning

This gives a fully auditable Stage 6 durability output:
- selected exposure class and meaning
- structural class
- `c_min,dur`
- `c_min,b`
- `c_min`
- `Delta c_dev`
- ground-cast additions / floors
- recommended `c_nom`
- actual `c_nom` used in the reinforcement calculation

#### How CPT could enter later

In a later stage, the slab could be linked to a **Winkler subgrade model** using CPT-derived subgrade stiffness:

```
q = k_s * w
```

where:
- `k_s` = modulus of subgrade reaction estimated from CPT-derived stiffness
- `w` = settlement / slab deflection

But for the first version, the slab reinforcement calculation can remain a **simple structural calculator** with user-defined moment input or idealised support condition.

#### Outputs

- design moment `M_Ed`
- effective depth `d`
- required steel area `A_s,req`
- optional minimum reinforcement check

#### Why it fits this app

- easiest to implement mathematically
- directly useful for preliminary concrete sizing

#### Limitations / caveats

- weakest coupling to the CPT unless subgrade modelling is added
- structural design should stay within a narrow, explicit scope
- not a substitute for a full slab-on-grade structural model

#### Draft references

- EN 1992-1-1 (Eurocode 2): Design of concrete structures.
- NBN EN 1992-1-1 Belgian National Annex.
- classic slab / RC design formulas for singly reinforced rectangular sections.

### First recommendation

If Stage 6 must remain **basic, geotechnical, and clearly tied to the CPT**, the best first candidate is:

1. **Settlement estimator**

Reasons:
- strongest link to the CPT-derived `E_oed` and tuned `m`
- directly uses the profile already built in Stages 1–5
- analytically feasible in 1D
- useful for early foundation screening

Second candidate:

2. **Dewatering impact estimator**

Reasons:
- also strongly geotechnical
- elegant analytical basis
- useful for temporary works and excavation screening
- but needs more assumptions on lateral geometry and permeability

Third candidate:

3. **Slab reinforcement estimator**

Reasons:
- easiest math
- structurally useful
- but least directly connected to the CPT unless a soil-reaction model is added


## References

- Robertson, P.K. (1990). Soil classification using the CPT. Canadian Geotechnical Journal, 27(1), 151-158.
- Robertson, P.K. (2016). Cone penetration test (CPT)-based soil behaviour type (SBT) classification system — an update. Canadian Geotechnical Journal, 53(12), 1910-1927.
- Robertson, P.K. & Wride, C.E. (1998). Evaluating cyclic liquefaction potential using the CPT. Canadian Geotechnical Journal, 35, 442-459.
- CUR Rapport 166 (2005). Damwandconstructies. SBRCURnet.
- CUR 2003-7. Geotechnische aspecten van ondergrondse infra. Aanbevelingen voor Plaxis HS modelparameters.
- NEN 6740:2006. Geotechniek - TGB 1990 - Basiseisen en belastingen.
- Deltares (2024). D-SHEET Piling User Manual, version 24.1, §34.2.2
  "CPT interpretation acc. NEN 6740".
- SB260 Standaardbestek 260, artikel 21-6.4.10: Karakteristieke grondparameters op basis van elektrische sondering (Sanglerat).
- Sanglerat, G. (1972). The Penetrometer and Soil Exploration. Elsevier.
- PLAXIS 2D Material Models Manual (2025.1). Bentley Systems.
- Bentley Systems. KB0109063. How to define and edit a material via the command line.
- Bentley Systems. KB0109071. PLAXIS soil model numbers in the command line.
- Bentley Systems. KB0043470. Re-using materials from other projects in PLAXIS.
- Bentley Systems. KB0108936. Material parameter datasets for sheetpiles and beams.
- aGEO (internal practice): Eur,ref = 3 * E50,ref.
- IMDC nv i.s.m. Bodemkundige Dienst van België vzw (2016). Opstellen van richtlijnen voor het meten van de infiltratiecapaciteit en het modelmatig onderbouwen voor de dimensionering van infiltratievoorzieningen. Report I/RA/11461/15.066/JSW, versie 9.0, 30/11/2016. Commissioned by Vlaamse Milieumaatschappij (VMM).
  - Tabel 2-44 (p. 149): Richtwaarden kh per Belgische textuurklasse (OVAM, 2002).
  - Tabel 2-45 (p. 150): Richtwaarden k per USDA textuurklasse (De Smedt, VUB, 2005).
  - Tabel 2-46 (p. 153): Ruwe inschatting infiltratiecapaciteit per grondsoort.
  - §5.2 (p. 335): Ontwerprichtlijnen infiltratievoorzieningen op basis van infiltratiecapaciteit.
- De Beer, E. (1971). Grondmechanica Deel I: Inleidende begrippen (9e herziene druk). Tabel 2-47: doorlatendheidscoëfficiënt k voor typische grondmonsters.
- Dupuit, J. (1863). Études théoriques et pratiques sur le mouvement des eaux.
- Thiem, G. (1906). Hydrologische Methoden.
- Bear, J. (1979). Hydraulics of Groundwater. McGraw-Hill.
- Terzaghi, K. & Peck, R.B. (1967). Soil Mechanics in Engineering Practice.
- Poulos, H.G. & Davis, E.H. (1974). Elastic Solutions for Soil and Rock Mechanics.
- Boussinesq, J. (1885). Application des potentiels à l'étude de l'équilibre et du mouvement des solides élastiques.
- EN 1992-1-1. Eurocode 2: Design of concrete structures.
