# Stratigraphy module

Replaces the legacy cross-CPT "Correlatie" feature. Builds an engineering-grade
multi-CPT stratigraphy: shared **soil units** derived from the per-CPT layer
models, with pinch-outs and lenses, feeding the Doorsnede section and the
Plaxis 2D / SCIA SOILIN exports.

## Method

1. **Profiles** (`profiles.js`) — eligible CPTs (confirmed surface level +
   layer model) are projected onto the least-squares section line and their
   layers converted to absolute elevation (m TAW). A fingerprint of this input
   detects stale correlations.
2. **Pairwise alignment** (`alignment.js`, `similarity.js`) — *adjacent* CPT
   pairs along the section are aligned with an order-preserving
   Needleman–Wunsch dynamic program. Superposition is enforced by
   construction: correlation lines cannot cross. Layer similarity combines
   lithological compatibility (Tabel 3 groups + Robertson-type adjacency,
   `soil-knowledge.js`), elevation overlap, qc, Rf and thickness. A gap in
   the alignment *is* a pinch-out; its cost scales with bed thickness, so
   thin lenses wedge out readily. Lithologically incompatible layers
   (peat vs gravel) can never match.
3. **Units** (`correlate.js`, `units.js`) — pairwise links are chained with
   union–find into units, sorted by mean elevation. Unit properties are
   derived from the member layers: thickness-weighted means with min–max
   envelopes, lithology by thickness vote, Stage 4 stiffness parameters
   aggregated per member in its own CPT stress context, permeability as
   geometric mean. Strength characteristic: weighted mean or lower bound
   (user setting).
4. **Geometry** (`geometry.js`) — unit polygons in (chainage, m TAW).
   Between sampled CPTs boundaries interpolate linearly; where a unit is
   absent at the neighbouring CPT it pinches to a point halfway (the
   half-distance rule). Absence at an interior CPT splits the unit into
   lobes — lenses. No extrapolation beyond the outer CPTs.
5. **Interpretation** (`store.js`, `view.js`) — the engineer stays in
   control: reassign any layer to another unit, merge units, rename them.
   Manual edits are preserved until an explicit re-run (with confirmation).
   Input changes (layers, elevations, CPT set) flag the result as stale
   instead of silently rendering outdated numbers.

## Exports (`exports.js`, `soilin-report.js`)

- **Units CSV** — aggregate table + per-CPT presence matrix (audit trail).
- **PLAXIS 2D materials** — `soilmat` command per unit (Mohr-Coulomb +
  Hardening Soil), same grammar as the per-CPT Stage 4 export.
- **Section DXF** — the unit polygons as closed LWPOLYLINEs
  (X = chainage, Y = m TAW), importable as Plaxis 2D polygons.
- **SCIA SOILIN report** (`/report/soilin`) — printable report in the
  Stage 7 style: unit parameter legend (E_def, ν, γ_dry, γ_sat, m) and one
  borehole table per CPT listing **all units in fixed stratigraphic order**,
  locally absent units at 0.00 m thickness — exactly the form SOILIN's
  geological model expects.

## Integration

`index.js` exposes `installStratigraphyApp(ctx)`; the legacy controller wires
it with a small context (project accessor, Stage 4 parameter derivation,
section re-render trigger) — same pattern as the retaining-walls module. The
Doorsnede consumes `sectionGeometry()` / `projection()`, so the section view,
the correlation panel and the DXF export always agree.

State persists on `PROJECT.stratigraphy` (versioned, serialisable).

Verification: `npm run verify:stratigraphy` (`scripts/verify_stratigraphy.mjs`).
