# PLAXIS Export Reference

This note documents the **actual PLAXIS-related exports implemented in the app today**.
It replaces the earlier assumption that the app would write a native JSON-style
`*.matdb` file directly.

The current app has two PLAXIS-oriented exports:

1. **Stage 3 - simulated CPT export**
2. **Stage 4 - PLAXIS material-command export**

---

## 1. Current export strategy

### 1.1 Why the app does not write native `*.matXdb` directly

After reviewing Bentley's current workflow and testing against PLAXIS V22+:

- modern PLAXIS uses `*.matXdb`, not the older assumed JSON `*.matdb`
- `*.matXdb` content is XML-based on disk
- Bentley documents supported creation/editing workflows via PLAXIS commands and PLAXIS project materials
- Bentley also documents reusing project materials through the PLAXIS database workflow

The app therefore uses the **supported and robust route**:

- create materials through exported `soilmat` commands
- run those commands inside a PLAXIS project
- if needed, copy the resulting project materials into a reusable global material database from inside PLAXIS

So:

- **supported in the app**: command export
- **not generated directly by the app**: native `*.matXdb`

---

## 2. Stage 3 - simulated CPT export

### 2.1 Goal

Stage 3 exports the interpreted layering as a **measurement-style CPT text file**
for PLAXIS. The purpose is to generate a synthetic CPT that is a **1:1
representation of the chosen layer model**.

The export does **not** preserve the original pointwise variability in `qc` and
`fs`. Instead, it preserves:

- the original CPT depth sampling
- the CPT coordinates
- the final interpreted layer structure

Inside each interpreted layer, the exported CPT becomes piecewise constant.

### 2.2 Data mapping

For each original CPT row depth `z_j`, the app finds the active final layer and
writes:

```text
qc_export(z_j) = max(0, avgQc(layer(z_j)))         [MPa]
fs_export(z_j) = max(0, avgFs(layer(z_j)))         [MPa]
```

If `avgFs` is unavailable, the app reconstructs `fs` from the layer friction ratio:

```text
fs_export(z_j) = max(0, avgQc(layer(z_j)) * avgRf(layer(z_j)) / 100)   [MPa]
```

### 2.3 File format

The text export follows the PLAXIS-style CPT layout:

```text
X[m] <x coordinate>
Y[m] <y coordinate>
Z[m] <surface elevation>
D[m] Q[MPa] F[MPa] x
<depth> <qc> <fs> 0
<depth> <qc> <fs> 0
...
```

Implementation notes:

- `X`, `Y`, and `Z` come from the CPT metadata held by the app
- one output row is written for every original CPT depth row
- the last `x` column is currently written as `0`
- the downloaded filename is:

```text
CPT_<id>_plaxis_simulated.txt
```

---

## 3. Stage 4 - PLAXIS material-command export

### 3.1 Goal

Stage 4 exports the active layer model as a **PLAXIS command file** that creates
soil materials inside a PLAXIS project.

For every interpreted layer, the export writes:

- one **Mohr-Coulomb** material
- one **Hardening Soil** material

The downloaded filename is:

```text
CPT_<safe_id>_plaxis_materials_commands.txt
```

### 3.2 Material naming

Material names follow:

```text
<safe CPT id>_L<layer index>_<safe subtype>_MC
<safe CPT id>_L<layer index>_<safe subtype>_HS
```

The sanitiser:

- strips brackets and commas
- replaces whitespace by underscores
- removes unsafe characters
- normalises accents where possible

Example:

```text
CPT-1_demo_L1_zand_matig_MC
CPT-1_demo_L1_zand_matig_HS
```

---

## 4. Drainage rule used by the export

The current export rule is intentionally conservative:

```text
IF subtype contains '(lh)' OR '(kh)' OR wording such as
   'leemhoudend' OR 'klei-/leemhoudend':
    DrainageType = 'Undrained A'
ELSE IF type is Sand OR Gravel:
    DrainageType = 'Drained'
ELSE:
    DrainageType = 'Undrained A'
```

This means:

| App soil / subtype | PLAXIS DrainageType |
|---|---|
| `zand, ...` | `Drained` |
| `grind, ...` | `Drained` |
| `zand (lh), ...` | `Undrained A` |
| `grind (kh), ...` | `Undrained A` |
| `klei, ...` | `Undrained A` |
| `leem, ...` | `Undrained A` |
| `klei (zh), ...` | `Undrained A` |
| `leem (zh), ...` | `Undrained A` |
| `veen, ...` | `Undrained A` |

Important consequence:

- only **clean sand** and **clean gravel** are exported as `Drained`
- fines-bearing granular soils default to `Undrained A`

---

## 5. Mohr-Coulomb command content

Each Stage 4 layer exports one `soilmat` command with `SoilModel = 2`.

The app writes:

| PLAXIS key | Source in app |
|---|---|
| `Identification` | generated material name |
| `SoilModel` | fixed `2` |
| `DrainageType` | drainage rule above |
| `gammaUnsat` | Stage 3 / Stage 4 unsaturated unit weight |
| `gammaSat` | Stage 3 / Stage 4 saturated unit weight |
| `ERef` | current-stress `E50,i` from the selected Stage 4 stiffness method |
| `nu` | MC Poisson ratio from the app |
| `cRef` | `max(c', 0.1)` |
| `phi` | `phi'` |
| `psi` | dilatancy from the app |
| `PermHorizontalPrimary` | `kh_rep`, converted to `m/day` |
| `PermVertical` | `kv_rep`, converted to `m/day` |

Notes:

- For the MC material the app writes `ERef = E50,i`, not `E50Ref`.
- If Stage 4 Method A is active, `E50,i = 1.25 · Eoed,i` for Clay / Soft clay / Peat and `E50,i = Eoed,i` for the other soils.
- If Stage 4 Method B is active, `E50,i = Eoed,i` for all soils.
- This follows the PLAXIS Material Models Manual guidance that for loading of soils one generally uses `E50` as the Young's modulus for the Mohr-Coulomb model.
- `cRef` is floored to `0.1 kPa` to avoid zero-cohesion export edge cases
- `psi` follows the app's current Stage 4 logic
- permeability is exported even for undrained materials because PLAXIS still uses
  permeability in relevant groundwater and consolidation calculations

Example structure:

```text
soilmat "Identification" "CPT-1_demo_L1_zand_matig_MC" "SoilModel" 2 \
        "DrainageType" "Drained" "gammaUnsat" 17 "gammaSat" 19 \
        "ERef" 26132 "nu" 0.3 "cRef" 0.1 "phi" 30 "psi" 0 \
        "PermHorizontalPrimary" 3.456 "PermVertical" 3.456
```

---

## 6. Hardening Soil command content

Each Stage 4 layer exports one `soilmat` command with `SoilModel = 3`.

The app writes:

| PLAXIS key | Source in app |
|---|---|
| `Identification` | generated material name |
| `SoilModel` | fixed `3` |
| `DrainageType` | drainage rule above |
| `gammaUnsat` | Stage 3 / Stage 4 unsaturated unit weight |
| `gammaSat` | Stage 3 / Stage 4 saturated unit weight |
| `E50Ref` | Stage 4 Hardening Soil stiffness |
| `EOedRef` | Stage 4 Hardening Soil stiffness |
| `EURRef` | Stage 4 Hardening Soil stiffness |
| `PowerM` | Stage 4 `m` |
| `pRef` | fixed `100` |
| `cRef` | `max(c', 0.1)` |
| `phi` | `phi'` |
| `psi` | dilatancy from the app |
| `PermHorizontalPrimary` | `kh_rep`, converted to `m/day` |
| `PermVertical` | `kv_rep`, converted to `m/day` |

Example structure:

```text
soilmat "Identification" "CPT-1_demo_L1_zand_matig_HS" "SoilModel" 3 \
        "DrainageType" "Drained" "gammaUnsat" 17 "gammaSat" 19 \
        "E50Ref" 47114 "EOedRef" 47114 "EURRef" 141342 \
        "PowerM" 0.5 "pRef" 100 "cRef" 0.1 "phi" 30 "psi" 0 \
        "PermHorizontalPrimary" 3.456 "PermVertical" 3.456
```

---

## 7. Parameters intentionally omitted from the HS command

The current export does **not** write the following HS parameters:

| Parameter | Reason |
|---|---|
| `RF` | PLAXIS reported it as read-only in the tested workflow |
| `nuUR` | intentionally left to PLAXIS / automatic workflow |
| `K0NC` | intentionally left to PLAXIS / automatic workflow; also reported as read-only in testing |

Other values currently **not exported**:

| Value | Reason |
|---|---|
| `cu` | not required for `Undrained A`; that option uses effective stress strength parameters |
| `psi_unsat` | available in the app, but not yet written by the command export |

So the export philosophy is:

- write the parameters that PLAXIS accepts reliably in the tested workflow
- avoid writing properties that are read-only or better left automatic

---

## 8. Hydraulic conductivity units

Inside the app, the representative conductivities are derived and stored in:

- `kh_rep` in `m/s`
- `kv_rep` in `m/s`

PLAXIS in this workflow expects the exported command values in `m/day`.
The app therefore converts:

```text
k_plaxis = 86400 * k_app
```

So:

```text
PermHorizontalPrimary = 86400 * kh_rep
PermVertical          = 86400 * kv_rep
```

This conversion is applied to both:

- Mohr-Coulomb export
- Hardening Soil export

---

## 9. Engineer workflow in PLAXIS

Recommended workflow:

1. Complete Stage 3 and review the final interpreted layers.
2. Complete Stage 4 and review:
   - stiffness method
   - `m`
   - hydraulic conductivity
   - any manual overrides
3. Export the PLAXIS command file.
4. Run the commands inside a PLAXIS project.
5. Review the created project materials.
6. If a reusable global material library is needed, copy those project materials
   into the global PLAXIS material database from inside PLAXIS.

---

## 10. What the app exports today

### Stage 3

- synthetic CPT text file
- original depth sampling retained
- piecewise-constant `qc` and `fs` per interpreted layer

### Stage 4

- CSV layer export
- PLAXIS material-command export
- one `MC` and one `HS` material per interpreted layer
- hydraulics written in `m/day`
- drainage defaults applied as documented above

### Not exported directly

- native `*.matXdb`
- `RF` in HS command
- `nuUR` in HS command
- `K0NC` in HS command
- `psi_unsat` in the current command export

---

## 11. Sources used for the export design

- Bentley Systems, KB0109063: *How to define and edit a material via the command line*
- Bentley Systems, KB0109071: *PLAXIS soil model numbers in the command line*
- Bentley Systems, KB0043470: *Re-using materials from other projects in PLAXIS*
- Bentley Systems, KB0108936: *Material parameter datasets for sheetpiles and beams*
- PLAXIS 2D Material Models Manual (2025.1), §3.3.1: Young's modulus in the Mohr-Coulomb model
