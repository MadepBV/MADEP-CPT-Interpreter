# Robertson 2016 — Soil Behaviour Type Classification

**Source:** Robertson, P.K. (2016). Cone penetration test (CPT)-based soil
behaviour type (SBT) classification system — an update. *Canadian Geotechnical
Journal*, 53(12), 1910–1927.

---

## Why 2016 vs 1990

Robertson 1990 normalises cone resistance as:

```
Qt = (qt − σv0) / σ'v0
```

This is stress-dependent: at shallow depth σ'v0 is small, so Qt inflates for
a given qt. At depth the same soil reads a lower Qt. The result is that the
same physical soil can fall in different SBT zones depending purely on depth,
not behaviour.

Robertson 2016 fixes this with a variable stress exponent `n` that accounts
for the compressibility of the soil:

```
Qtn = (qt − σv0) / pa  ×  (pa / σ'v0)^n
```

where `pa = 100 kPa` (atmospheric pressure, a reference constant).

For clean sands `n ≈ 0.5`; for clays `n ≈ 1.0` (reducing to the 1990
formula). The exponent itself depends on the soil type being inferred, so the
calculation is iterative.

The zone boundaries and the Ic formula are **identical** to 1990. Only `Qt`
is replaced by `Qtn`.

---

## Inputs

| Symbol | Description | Unit | Source in app |
|---|---|---|---|
| `qt` | Corrected cone resistance | MPa | `qc + (1 − a) × u2`; falls back to `qc` when u2 absent |
| `fs` | Sleeve friction | MPa | From file; estimated from Rf when absent |
| `σv0` | Total overburden stress | kPa | `stressAt(z)` |
| `σ'v0` | Effective overburden stress | kPa | `stressAt(z)` |
| `pa` | Atmospheric pressure | kPa | Constant = 100 kPa |
| `a` | Net area ratio (cone geometry) | — | `S.meta.aRatio`, default 0.8 |

**u2 (pore pressure) is optional.** When absent the app uses `qt = qc`,
identical to the existing Robertson 1990 fallback. The 2016 method adds no new
pore-pressure dependency.

---

## Formulas

### Step 1 — cone resistance correction and unit conversion

```
qt_MPa    = qc + (1 − a) × u2               (use qt = qc when u2 is absent)
qt_kPa    = qt_MPa × 1000
dQ_kPa    = qt_kPa − σv0                    (σv0 already in kPa)
pa        = 100 kPa                         (atmospheric pressure, constant)
```

All subsequent formulas operate in **kPa** so every ratio is truly
dimensionless.

### Step 2 — normalised friction ratio (unchanged from 1990)

```
fs_kPa = fs_MPa × 1000
Fr     = (fs_kPa / dQ_kPa) × 100      [%]     (clamp to [0.1, 10])
```

### Step 3 — iterative stress-normalised cone resistance

Initial guess: `n = 1.0`

Repeat until `|n_new − n| < 0.001` (typically 3–5 iterations):

```
Qtn   = (dQ_kPa / pa) × (pa / σ'v0)^n
Ic    = √( (3.47 − log₁₀ Qtn)² + (log₁₀ Fr + 1.22)² )
n_new = 0.381 × Ic + 0.05 × (σ'v0 / pa) − 0.15
n     = clamp(n_new, 0.5, 1.0)
```

After convergence the final `Qtn` and `Ic` are used for zone classification.

> **Consistency check:** when the converged `n = 1.0`, `Qtn` reduces to
> `dQ_kPa / σ'v0 = Qt` (the Robertson 1990 ratio). So for clays Robertson 2016
> gives the same result as 1990 by construction.
>
> **n bounds:** Robertson (2009), carried into 2016, specifies `0.5 ≤ n ≤ 1.0`.
> The lower bound is what stops n from drifting to unphysical values in very
> clean, high-Qtn points during early iterations.

### Step 4 — zone boundaries (identical to Robertson 1990)

| Ic | Zone | SBT description |
|---|---|---|
| > 3.60 | 2 | Organic soils — clay / peat |
| > 2.95 | 3 | Clays — silty clay to clay |
| > 2.60 | 4 | Silt mixtures — clayey silt to silty clay |
| > 2.05 | 5 | Sand mixtures — silty sand to sandy silt |
| > 1.31 | 6 | Sands — clean sand to silty sand |
| ≤ 1.31 | 7 | Gravelly sand to dense sand |
| — | 1 | Sensitive fine-grained (not determinable from Ic alone) |

Zone 7 override (same logic as 1990): if `Qtn > 200` and `Fr < 0.5`, classify
as Gravel regardless of Ic.

---

## Mapping to app soil types

| Zone | App type |
|---|---|
| 2 | Peat / organic |
| 3 | Clay |
| 4 | Sandy clay |
| 5 | Silty sand |
| 6 | Sand |
| 7 | Gravel |

Zone 1 (sensitive / structured fine-grained) requires engineering judgement and
is not inferred from Ic alone. Not mapped automatically.

---

## Edge cases and guards

| Condition | Action |
|---|---|
| `dQ_kPa < 10` or `σ'v0 < 1 kPa` | Return Clay (Ic = 2.80) — same guard as 1990 |
| u2 absent | `qt = qc` — no correction applied |
| `Qtn < 0.1` after iteration | Clamp to 0.1 before log |
| `Fr` out of range | Clamp to [0.1, 10] |
| `n` out of range | Clamp to [0.5, 1.0] — per Robertson (2009/2016) |
| Non-convergence after 10 iterations | Use last value — in practice never occurs for normal CPT ranges |

---

## Return value (same shape as classRob)

```js
{
  type,           // app soil type string
  subtype: '',    // empty — no sub-classification
  Ic,             // final converged Ic (2 decimal places)
  Qt,             // final converged Qtn (1 decimal place) — reuses Qt field
  g:    null,     // unit weight — not provided by this method
  gs:   null,
  phi:  null,
  c:    null,
  cu:   null
}
```

The `Qt` field stores `Qtn` for display — the field name is kept for
downstream compatibility.

---

## Method identifier

| Key | Label |
|---|---|
| `'robertson2016'` | Robertson (2016) |

Sits alongside existing options: `'robertson'` (1990), `'cur3'`, `'nen6740'`.

---

## Differences from Robertson 1990 at a glance

| | Robertson 1990 | Robertson 2016 |
|---|---|---|
| Cone resistance ratio | `Qt = dQ / (σ'v0/1000)` | `Qtn = (dQ/pa) × (pa/σ'v0)^n` (iterative) |
| Stress exponent | Fixed = 1.0 | Variable, soil-dependent |
| Fr formula | Identical | Identical |
| Ic formula | Identical | Identical |
| Zone boundaries | Identical | Identical |
| u2 required | No | No |
| Extra inputs | None | `pa = 100 kPa` (constant) |
| Deep/OC soils | Over-estimates Qt | Corrected |
| Shallow soils | Under-estimates Qt | Corrected |
