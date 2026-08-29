# Section catalogues – fetch & verification report (2026-08-29)

Files written (nothing else in the repo was modified):

- `src/lib/cpt-app/retaining/sections/steel-h-sections.js` – 90 hot-rolled H/I profiles
- `src/lib/cpt-app/retaining/sections/sheet-pile-sections.js` – 88 sheet-pile sections
- this report

Both files load with `node -e "import(...)"` from the repo root; `findHSection('hea 180')` and
`findSheetPile('az 26-700')` resolve (see "Load checks" at the end).

## 1. Hot-rolled H/I sections

### Primary source (all 90 rows, `source: 'ea-en10365'`)

- eurocodeapplied.com, "Table of design properties for IPE, HEA, HEB, HEM profiles – Eurocode 3"
  (dimensions per EN 10365), https://eurocodeapplied.com/design/en1993/ipe-hea-heb-hem-design-properties
  The page serves the IPE table as HTML; the HEA/HEB/HEM tables were obtained by POSTing the page's own
  form (`Calculation.ProfileType` = 1/2/3, with the page's anti-forgery token). Numbers were parsed from the
  raw HTML table cells, not from a summary. Source units mm², ×10⁶ mm⁴, ×10³ mm³ were converted to
  cm², cm⁴, cm³ with decimal arithmetic (no float noise).
- Anchor check (task requirement): HEA 180 → h 171, b 180, tw 6.0, tf 9.5, r 15, A 45.25 cm², Iy 2510 cm⁴,
  Wel,y 293.6 cm³, Wpl,y 324.9 cm³, Iz 924.6, Wel,z 102.7, Wpl,z 156.5, Av,z 14.47 cm², 35.5 kg/m.
  **Every anchor value is reproduced exactly.**
- Avz is taken from the source ("shear area z-z for η = 1.2"). I recomputed Avz = A − 2·b·tf + (tw + 2r)·tf
  for all 90 rows: agreement within 1 % for 89 rows; IPE 80 differs (formula 3.53 cm² vs published 3.58 cm²,
  the ArcelorMittal PDF also prints 3.577). The header comment states this.

### Cross-check source (`'am-sections-2023'`, not used for any stored value)

- ArcelorMittal Europe – Long Products, "Sections and Merchant Bars – Sales programme", edition V2023-5 (PDF),
  https://sections.arcelormittal.com/repository2/Sections/Sections_MB_ArcelorMittal_FR_EN_DE_V2023-5.pdf
  Text extracted with `pdftotext -layout`, rows parsed programmatically (dimension table + property table
  per family), then compared with the primary source for **all 90 profiles** (not just three):

  | field | max. relative deviation | worst profile (EA vs AM) |
  |---|---|---|
  | h, b, tw, tf, r | 0 | identical for all 90 |
  | Iy | 0.09 % | HEB240 11260 vs 11250 |
  | Wel,y | 0.10 % | HEA280 1013 vs 1012 |
  | Wpl,y | 0.10 % | HEB800 10230 vs 10220 |
  | Iz | 0.10 % | IPE180 100.9 vs 100.8 |
  | Wel,z | 0.09 % | HEB160 111.2 vs 111.1 |
  | Wpl,z | 0.10 % | HEM240 1006 vs 1005 |
  | Avz | 0.09 % | HEA650 103.19 vs 103.1 |
  | A | 0.52 % | IPE80 7.64 vs 7.6 (AM prints A with 1 decimal) |
  | mass | 0.47 % | IPE550 105.5 vs 106 (AM prints 3 significant digits) |

  All differences are last-digit rounding of the printed tables. For the anchor HEA 180 the ArcelorMittal PDF
  prints A 45.3 (1 decimal), Wpl,y 324.8 and Wpl,z 156.4 (vs 324.9 / 156.5) – i.e. it does not reproduce the
  anchor to the last digit, which is why eurocodeapplied was chosen as the primary source.
- Explicit three-profile spot check, primary vs ArcelorMittal:
  - HEA 180: 45.25/2510/293.6/324.9/14.47/35.5 vs 45.3/2510/293.6/324.8/14.47/35.5
  - HEB 300: A 149.08, Iy 25170, Wel,y 1678, Wpl,y 1869, Avz 47.43, 117.0 kg/m vs 149.1/25160/1677/1868/47.42/117
  - HEM 200: A 131.28, Iy 10640, Wel,y 967.4, Wpl,y 1135, Avz 41.03, 103.1 kg/m vs 131.3/10640/967.4/1135/41.03/103
  - IPE 400: A 84.46, Iy 23130, Wel,y 1156, Wpl,y 1307, Avz 42.69, 66.3 kg/m vs 84.5/23120/1156/1307/42.69/66.3

### Coverage

| family | profiles | range |
|---|---|---|
| HEA | 24 | 100 … 1000 (task asked 100–600; 650–1000 also present in both sources, included) |
| HEB | 24 | 100 … 1000 (idem) |
| HEM | 24 | 100 … 1000 (task asked 100–400; 450–1000 included, cross-checked) |
| IPE | 18 | 80 … 600 (task asked 100–600; IPE 80 included) |

Not included: HE-AA, IPE A/AA/O/V, IPE 750, HE 1000 x mass variants, HD/HL/HP/UB/UC (outside the brief).

### Sources looked at and rejected for H sections

- Montanstahl "HEA/HEB/HEM datasheet" PDF: dimensions per EN 10365 but the properties are for laser-welded
  stainless profiles without root fillet (HE 180 A: A 43.35 cm², Iy 2410) – not the hot-rolled values. Rejected.
- structuralsteelcomponents.com: HEA 180 page lists r 16 mm, A 45.5 cm², Ixx 2524 cm⁴ – inconsistent with
  EN 10365 / the anchor. Rejected.
- calcresource.com and dlubal.com per-profile pages: values are rendered client-side; nothing verifiable was
  retrievable by fetch. Not used.

## 2. Steel sheet piles

### Primary source (all 88 rows, `source: 'am-cat-2024'`)

- ArcelorMittal Sheet Piling, "Steel Foundation Solutions – General Catalogue 2024" (PDF, 8.2 MB),
  https://sheetpiling.arcelormittal.com/sites/default/files/2024-04/AMCRPS_General_Catalogue_GB_2024-web2.pdf
  Text extracted with `pdftotext -layout`; the AZ (pp. 7–8), AU/PU/GU (pp. 17–18) and AS 500 tables were parsed
  programmatically (b, h, tf→`t`, tw→`s`, A cm²/m, mass kg/m per single pile, kg/m² of wall, Iy cm⁴/m,
  Wel cm³/m, static moment `Sy` cm³/m, Wpl cm³/m, and the eight class columns).
- The eight class columns are printed rotated in the PDF, so `pdftotext` scrambles their order. I verified the
  left-to-right order with pdfplumber word x-positions on the AZ page: S 240 GP, S 270 GP, S 320 GP,
  S 355 GP, S 390 GP, S 430 GP, S 460 GP, S 500 GP (x = 476 … 552 pt). `classByGrade` uses that order;
  grades printed as "–" (PU 12 / PU 12S for S240–S320, all GU for S500GP, GU 16-400/18-400 for S460/S500)
  are omitted from the object. Catalogue footnote: classification per EN 1993-5; class 1 is obtained by
  verifying the rotation capacity of a class-2 section.
- Catalogue statement carried into the header comment: the moment of inertia and section moduli assume
  correct shear transfer across the interlock.

### Cross-checks against the per-profile product pages (`'am-web'`)

Per-metre-of-wall rows read from the product pages (A cm²/m, G kg/m², Iy cm⁴/m, Wel cm³/m) vs catalogue:

| profile | product page | catalogue | result |
|---|---|---|---|
| AZ 26-700 | 187.2 / 146.9 / 59720 / 2600 | 187 / 147 / 59720 / 2600 | agree (catalogue rounds A, G) |
| AZ 12-770 | 120.1 / 94.3 / 21430 / 1245 | 120 / 94 / 21430 / 1245 | agree |
| AZ 25-800 | 163.3 / 128.2 / 59410 / 2500 | 163 / 128 / 59410 / 2500 | agree |
| PU 18 | 163.3 / 128.2 / 38650 / 1800 | 163 / 128 / 38650 / 1800 | agree |
| GU 16N | 154.2 / 121.0 / 35950 / 1670 | 154 / 121 / 35950 / 1670 | agree |

URLs: https://sheetpiling.arcelormittal.com/products/az-sections/az-700-and-az-770/az-26-700 ,
…/az-700-and-az-770/az-12-770 , …/az-sections/az-800/az-25-800 , …/u-sections/pu-sections/pu-18 ,
…/u-sections/gu-sections/gu-16n (all accessed 2026-08-29).

Sanity anchor from the task (older AZ 25: A ≈ 185, I ≈ 52 250, Wpl ≈ 2875, ≈ 145 kg/m²): the AZ 25 is no longer
in the 2024 catalogue, but its successor "AZ 26" (630 mm, still listed) has A 198, Iy 55 510, Wpl 3059,
155 kg/m² – consistent magnitudes.

**Note on the example row in the task text**: the example `AZ 26-700 … Iy 55510, Wpl 3059, massPerPile 103`
mixes the older AZ 26 (630 mm: Iy 55 510, Wpl 3059) with the AZ 26-700. The catalogue and the AZ 26-700
product page both give **Iy 59 720 cm⁴/m, Wpl 3070 cm³/m, 102.9 kg/m per pile** for AZ 26-700; the data file
uses the fetched values.

### Coverage

| family | rows | ids |
|---|---|---|
| AZ | 36 | AZ 18/20/22/23/25/27-800; AZ 28/30/32-750; AZ 12/13/14-770, AZ 14-770-10/10; AZ 12/13/14-700, AZ 13-700-10/10; AZ 17/18/19/20/24/26/28-700; AZ 36/38/40/42/44/46-700N; AZ 48/50/52-700; AZ 18, AZ 18-10/10, AZ 26 (630 mm) |
| AU | 6 | AU 14 … AU 25 |
| PU | 14 | PU 12, PU 12S, PU 18-1/18/18+1, PU 22-1/22/22+1, PU 28-1/28/28+1, PU 32-1/32/32+1 |
| GU | 26 | GU 6N … GU 33N (incl. GU 7S, GU 7HWS, GU 8S), GU 16-400, GU 18-400 |
| AS 500 | 6 | AS 500-9.5 … AS 500-13.0 (shape 'flat', per single pile, with `interlockResistance_kN_m` 3500–6000 kN/m) |

The task's "AZ 36-700 … AZ 46-700" are sold as the "N" generation (AZ 36-700N …) in the 2024 catalogue and are
stored under those ids. Requested profile names that no longer exist in the current catalogue (plain AZ 36-700
… AZ 46-700, AZ 25) are not invented.

### Not verified / omitted

- Coating areas per profile are not in the catalogue's main tables (product pages list them, but only the five
  pages above were fetched) – field omitted for all rows.
- HZ-M king piles, box piles, cold-formed (PAL/PAU/omega) sections, HP piles and tubes: outside the brief,
  not included. No `'omega'` rows exist in the file.
- AS 500: only per-single-pile A/I/W are published (stored as `APile`, `IyPile`, `WelPile`), no Wpl and no
  per-metre values; classes not published for straight-web piles.
- Steel-grade yield strengths and interlock/driving data were not captured.

## 3. Load checks (run from repo root)

```
node -e "import('./src/lib/cpt-app/retaining/sections/steel-h-sections.js').then(m=>console.log(m.STEEL_H_SECTIONS.length, m.findHSection('hea 180')))"
→ 90 { id: 'HEA180', h: 171, b: 180, tw: 6, tf: 9.5, r: 15, A: 45.25, Iy: 2510, Wely: 293.6, Wply: 324.9, Iz: 924.6, Welz: 102.7, Wplz: 156.5, Avz: 14.47, mass: 35.5, ... }
node -e "import('./src/lib/cpt-app/retaining/sections/sheet-pile-sections.js').then(m=>console.log(m.SHEET_PILE_SECTIONS.length, m.findSheetPile('az 26-700')))"
→ 88 { id: 'AZ 26-700', b: 700, h: 460, t: 12.2, s: 12.2, A: 187, Iy: 59720, Wel: 2600, Sy: 1535, Wpl: 3070, massPerM2: 147, massPerPile: 102.9, classByGrade: {...all 2}, ... }
```
`findHSection` also accepts 'HE 300 B' / 'ipe400'; `findSheetPile` accepts 'pu18', 'GU 16N', 'as500-12'; unknown ids return null.

## 4. Tooling notes

Raw downloads, extracted text and the parser/generator scripts are in the session scratchpad
(`eurocodeapplied.html`, `ea_post_{1,2,3}.html`, `am_sections_2023.pdf`, `am_catalogue_2024.pdf`,
`parse_am_sections.py`, `parse_am_cat.py`, `gen.py`). Nothing in the data files was typed by hand except the
six AS 500 rows, which were transcribed from the extracted catalogue text (page "AS 500® straight web sections").
