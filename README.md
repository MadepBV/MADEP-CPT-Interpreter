# MADEP CPT Interpreter

MADEP CPT Interpreter is a browser-based geotechnical engineering application for
interpreting Cone Penetration Test (CPT) data and carrying that interpretation
into early-stage design checks.

The app is built for Belgian and Dutch geotechnical practice. It reads CPT files,
derives soil layers and representative parameters, documents the assumptions
behind those parameters, and provides screening tools for bearing capacity,
settlement, dewatering, slope stability, seepage, deformation, beam/slab support,
and reinforcement checks.

Production site: <https://cpt.madep.be/>

## What It Does

- Imports CPT data from GEF, Excel, and reduced CSV files.
- Classifies CPT measurements using Robertson, CUR-style broad zones, NEN 6740,
  and NEN Tabel 3 / EC7 subtype routes.
- Detects and edits interpreted soil layers.
- Derives geotechnical model parameters, including unit weights, effective
  strength, undrained strength, stiffness, K0,nc, permeability, and PLAXIS-ready
  material values.
- Supports optional stress-dependent stiffness fitting from the CPT profile.
- Exports interpreted layers, PLAXIS material commands, and simulated CPT traces.
- Runs Stage 6 engineering checks from the interpreted layer model:
  - shallow foundation bearing capacity;
  - settlement screening;
  - dewatering and drawdown screening;
  - Bishop Simplified slope stability with Spencer verification paths;
  - steady-state 2D seepage on triangular FEM meshes;
  - plane-strain deformation on T3/T6 triangular meshes;
  - beam/slab-on-elastic-foundation checks using Winkler/Pasternak style models;
  - EC2-style reinforcement screening from calculated design moments;
  - retaining walls to Eurocode 7 (Belgium): gravity / RC cantilever walls, continuous
    sheet-pile walls and soldier-pile (Berliner) walls with the Belgian embedded-wall
    design branches, EN 1993 steel checks, PLAXIS 2D input sets (Plate / Embedded Beam
    Row incl. Brinch Hansen T_lat), a drivability estimator (vibratory force envelope and
    Smith wave equation) and a vibration impact assessment (TRL 429 / SBR-A / DIN 4150-3 /
    BS 7385-2), with a print-ready calculation note.
- Produces browser-side technical reports for review and documentation.

## Supported CPT Inputs

Preferred input formats:

- `.gef` files with `#COLUMNINFO` metadata.
- `.xls` / `.xlsx` workbooks with a `Data` sheet and, when available, a
  `Header` sheet.
- `.csv` files for reduced datasets.

Minimal CSV input should contain:

```csv
depth,qc,fs
0.00,0.50,0.004
0.02,0.55,0.004
```

Expected reduced-input units:

- `depth`: metres below local ground level.
- `qc`: MPa.
- `fs`: MPa when present.
- `rf`: percent when present, although the app also calculates its own friction
  ratio from `qc` and `fs`.

Excel workbooks may provide metadata such as project name, CPT number, cone
number, location, operator, date, water level, ground level, coordinates, alpha
factor, and beta factor through the `Header` sheet.

## Engineering Scope

This is an engineering interpretation and screening tool, not a replacement for
professional geotechnical judgement.

The application aims to make its calculations auditable: assumptions, formulas,
classification routes, file parsing, parameter mapping, and numerical models are
documented in the public docs and in the implementation notes under `docs/`.

Important modelling notes:

- CPT interpretation and layer assignment remain engineer-controlled workflows.
- Stage 6 analyses reuse the interpreted layer model instead of reclassifying the
  soil profile.
- Deformation analysis is a drained small-strain plane-strain FEM workflow with
  linear-elastic and Mohr-Coulomb plastic routes.
- T6 elements are supported for deformation meshes, but mesh sensitivity and
  convergence still require engineering review.
- GPU deformation work is experimental unless explicitly verified for the target
  case. CPU paths remain the trusted reference for engineering-critical runs.

## Documentation

The app exposes technical documentation in the site itself:

- Documentation home: <https://cpt.madep.be/docs>
- Workflow documentation: <https://cpt.madep.be/docs/workflow>
- Engineering analyses: <https://cpt.madep.be/docs/engineering>
- Methods and assumptions: <https://cpt.madep.be/docs/theory>
- References: <https://cpt.madep.be/docs/reference>

Relevant repository docs include:

- `docs/logic.md` — long-form implementation logic for the CPT workflow.
- `docs/classification/` — classification-specific notes.
- `docs/deformation/` — deformation, material, mesh, and solver notes.
- `docs/seep/` — seepage FEM notes.
- `docs/bishop/` — Bishop/Spencer slope-stability specifications.
- `docs/plaxis/` — PLAXIS export notes.

## Technology

- SvelteKit / Svelte 5
- TypeScript and browser-side JavaScript
- Vite
- `triangle-wasm` for constrained triangular meshing
- `xlsx` for Excel import
- Browser workers for long-running engineering calculations

The app is intentionally browser-first: most engineering workflows run locally in
the user's browser after the page has loaded.

## Local Development

Requirements:

- Node.js `>=22.12.0`
- npm

Install dependencies:

```sh
npm install
```

Start the development server:

```sh
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173/`.

## Build

Create a production build:

```sh
npm run build
```

Preview the production build locally:

```sh
npm run preview
```

## Verification

Useful checks:

```sh
npm run check
npm run verify:nen6740
npm run verify:bishop-phase-a
npm run verify:deformation-phase-1
npm run verify:seepage-phase-2
npm run verify:integrated-plan
```

GPU-related verification exists separately:

```sh
npm run verify:gpu
```

Treat GPU verification as hardware- and browser-sensitive. Passing CPU
verification is the baseline for engineering confidence.

## Repository Structure

```text
src/routes/                  SvelteKit pages
src/lib/components/cpt/       CPT app shell and stage components
src/lib/cpt-app/              legacy controller, engineering modules, workers
src/lib/cpt-app/deformation/  deformation FEM, materials, meshing, GPU experiments
src/lib/cpt-app/seepage/      seepage meshing and solver
src/lib/docs/                 site documentation content
docs/                         technical notes and implementation records
scripts/                      verification and regression scripts
static/                       public assets and bundled WASM/vendor files
```

## Search Keywords

CPT interpretation, cone penetration test, geotechnical engineering, soil
classification, Robertson CPT, NEN 6740, NEN Tabel 3, Eurocode 7, Belgian
geotechnics, Dutch geotechnics, PLAXIS export, bearing capacity, settlement,
dewatering, Bishop slope stability, Spencer slope stability, FEM seepage,
Mohr-Coulomb deformation, T3 mesh, T6 mesh, Winkler foundation, Pasternak
foundation.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
workflow and the Developer Certificate of Origin (DCO) sign-off requirement:

```sh
git commit -s
```

For engineering-model changes, include focused verification or regression cases
where possible. Small UI/documentation changes can stay correspondingly light.

## License

Copyright (C) 2025 Mathias De Pelsmaeker and contributors.

This program is free software: you can redistribute it and/or modify it under
the terms of the **GNU Affero General Public License** as published by the
Free Software Foundation, either version 3 of the License, or (at your option)
any later version.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the [GNU AGPL v3](LICENSE) for more details.

SPDX-License-Identifier: `AGPL-3.0-or-later`

### What AGPL-3.0 Means In Practice

- You can use, modify, and redistribute this software freely.
- If you distribute it or run a modified version as a network service, you must
  make your source code available to users under the same license.
- Forks and derivative works must also be released under AGPL-3.0-or-later.
- Consulting work and internal modifications are fine; running a modified public
  version without publishing your changes is not.
