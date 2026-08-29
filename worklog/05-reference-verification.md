# Reference verification — four course/calculation documents

Date of check: 2026-08-29. Method: every reference was checked online (Crossref/DataCite/doi.org resolution, publisher or catalogue records, NBN/Buildwise/BSI/ISO/DIN listings, or the source PDF itself where it is public). Where a PDF was public it was downloaded and text-extracted so that factual claims tied to the reference (TRL 429 coefficients, BS 5228-2 Table B.1/E.1, Belgian RK 2 factors, over-excavation rule) could be compared verbatim. No project file was modified.

Status key
- VERIFIED — reference exists and every element as written is correct (a note may add missing detail).
- VERIFIED-WITH-CORRECTION — reference exists but at least one element (year, edition, volume, pages, title, designation, attribution) must be changed; the replacement text is given in section 3.
- UNVERIFIABLE — could not be confirmed online (typically a Bentley knowledge-base page rendered by JavaScript, or a paywalled catalogue).
- WRONG — a key identifier (DOI, number) is invalid or the item does not exist as cited.

---

## 1. Summary per document

| Document | Refs | VERIFIED | VERIFIED-WITH-CORRECTION | UNVERIFIABLE | WRONG |
|---|---|---|---|---|---|
| 1. Sheet_Pile_Retaining_Walls_Manual_EC7_PLAXIS_v24 ([1]–[17]) | 17 | 8 | 7 | 2 | 0 |
| 2. Brinch_Hansen_Tlat_Soldier_Pile_Walls_Textbook_Section ([1]–[10]) | 10 | 5 | 5 | 0 | 0 |
| 3. Vibratory_Pile_Installation_Manual_Eurocode_Course_Chapter (21 entries) | 21 | 17 | 3 | 0 | 1 |
| 4. Rekennota_beschoeiing_berlinerwand_HEA180 (35 entries in 4 sections) | 35 | 23 | 11 | 1 (own tool, n/a) | 0 |
| **Total** | **83** | **53** | **26** | **3** | **1** |

Headline findings
1. **One invalid DOI (WRONG):** JRC "Implementation of Design during Execution & Service Life" is cited with DOI 10.2760/9211877, which does not resolve. The real record is JRC139606 / EUR 40128, DOI **10.2760/8383117** (online), December 2024, 12 named authors.
2. **One non-resolving DOI on an otherwise real paper:** Van Rompaey, Legrand & Holeyman (1995) — DOI 10.2495/SD950601 returns 404 at doi.org and is absent from Crossref (including a prefix-restricted search of 10.2495). The paper is real: WIT *Transactions on the Built Environment* **vol. 14** (not 15), pp. 533–542, ISSN 1743-3509. Drop the DOI, cite the WIT Press URL.
3. **Wrong years/editions:** CIRIA R185 is 1999 (not 2000); PLAXIS 2D 2025.1.2 release notes are February 2026 (not 2025); PLAXIS 2024.3 was released in 2025 (so the "2024.3 Reference Manual (2024)" is mis-dated); NBN EN 1990 ANB:2013 and NBN EN 1993-1-1 ANB:2010 are superseded (2021 and 2018); NBN EN ISO 22476-1 "2013" should be 2012 (registered edition) and is superseded by NBN EN ISO 22476-1:2023; NBN EN 12063:1999 is superseded by NBN EN 12063:2024 (and EN 12063 explicitly excludes Berliner walls); BGGG CPT standard procedure Deel 1 current version is 14 July 2016.
4. **Wrong titles:** Holeyman & Whenham (2017) is "Critical Review of the Hypervib1 Model to Assess **Pile Vibro-Drivability**"; WTCB Infofiche 56.2 is "Type 2: beschottingen aanbrengen **vóór** de uitgraving" (the Rekennota copied a typo that also sits in the Belgian guideline's own reference list); Bentley KB article on sheet-pile plate properties is titled "Material datasets for plates: sheet pile wall in bending".
5. **Page ranges:** Simpson & Powrie (2001) is pp. 2505–2524 per the University of Southampton record (manual says 2505–2522). Brinch Hansen (1961) pp. 5–9 is consistently cited; the page range of the companion Christensen paper (pp. 10–16) could not be confirmed from an openable copy of Bulletin 12.
6. **All factual claims tied to fetchable sources check out:** TRL 429 k_v = 60/126/266 (50 %/33 %/5 %), δ = 1.2/1.3/1.4, 1281 observations, 1 ≤ x ≤ 100 m, 1.2 ≤ W_c ≤ 10.7 kJ; BS 5228-2 Table B.1 descriptors and Table E.1 vibratory-piling predictor; BS 7385-2 Table 1 (15 → 20 → 50 mm/s at 4 / 15 / 40 Hz); DIN 4150-3 Line 2 (5, 5–15, 15–20 mm/s; 15 mm/s top floor); Belgian guideline Tabel 8 for RK 2 (γ_G 1.00, γ_Q 1.10, γ_φ 1.25, γ_c 1.25, γ_cu 1.40), §3.3 over-excavation +0.3 m in the dry (with the 48 h blinding-concrete relaxation), §3.5 FEM procedure (α_ver = 1.1, ×1.35, ΣMsf ≥ 1.25).

---

## 2. Per-reference rows

### 2.1 Sheet_Pile_Retaining_Walls_Manual_EC7_PLAXIS_v24.md — "# References"

| # | Reference as written | Status | What was checked | Correction / note |
|---|---|---|---|---|
| [1] | Buildwise. EN 1997-1:2024 status page … does not replace NBN EN 1997-1:2005/A1:2014 pending the Belgian ANB | VERIFIED | Fetched https://www.buildwise.be/en/publications/standards-regulations/en-1997-1-2024-en/ — text: "does not yet have the status of a Belgian standard … can only be applied from the moment its corresponding Belgian national annex (ANB) is published … does not replace the existing standard NBN EN 1997-1:2005 and its amendment NBN EN 1997-1/A1:2014". | Add the URL. |
| [2] | NBN EN 1997-1 ANB:2022 | VERIFIED | NBN catalogue record (app.nbn.be p40_id=353682); Buildwise page; also listed as ref. [4] in the 2022 Belgian guideline. | — |
| [3] | BGGG/GBMS and Buildwise (2022). Richtlijnen voor de toepassing van EC7 in België volgens NBN EN 1997-1 ANB — Het grondmechanische ontwerp van ingebedde kerende constructies: beschoeiingen. March 2022 | VERIFIED-WITH-CORRECTION | Downloaded and text-extracted https://www.buildwise.be/media/srahyb00/na-ec-7-beschoeiingen-2022-final-nl.pdf (39 pp., footer "maart 2022"). Cover: "Richtlijnen voor de toepassing van de Eurocode 7 in België volgens NBN EN 1997-1 ANB – Het grondmechanische ontwerp van ingebedde kerende constructies: beschoeiingen". Front matter: approved by normalisation commission **NBN E25007 "Eurocode 7"**, secretariat WTCB and SECO; also hosted by BGGG-GBMS. | Attribution should name the NBN E25007 commission (WTCB/Buildwise–SECO secretariat), not "BGGG/GBMS and Buildwise" as authors. Title uses "de Eurocode 7". See §3. |
| [4] | NBN EN 1993-5:2007 + AC:2009. Eurocode 3 — Part 5: Piling | VERIFIED | Buildwise record "NBN EN 1993-5 NL … (+ AC:2009)"; NBN record NBN EN 1993-5 ANB:2011 (p40_id=349535). | Optionally add "with NBN EN 1993-5 ANB:2011". |
| [5] | Buildwise. EN 1993-5:2025 status page | VERIFIED | Fetched https://www.buildwise.be/en/publications/standards-regulations/en-1993-5-2025-en/ — "does not yet have the status of a Belgian standard … can only be applied once its corresponding Belgian National Annex (ANB) has been published … does not replace … NBN EN 1993-5:2007 and … NBN EN 1993-5 NL:2011". EN 1993-5:2025 itself published by CEN 15 Oct 2025 (BSI/iTeh records). | Add URL. |
| [6] | NBN EN 12063:2024. Execution of special geotechnical work — Sheet-pile walls | VERIFIED-WITH-CORRECTION | NBN record NBN EN 12063:2024 (app.nbn.be p40_id=2546300); BSI/NEN/iTeh: EN 12063:2024 published 31 May 2024, supersedes EN 12063:1999. Full title: "Execution of special geotechnical work — Sheet pile walls, combined pile walls, high modulus walls". | Complete the title. |
| [7] | Bentley Systems (2026). How to derive plate properties for sheet pile walls in PLAXIS 2D. Official KB article, worked AZ 25 example | VERIFIED-WITH-CORRECTION (date UNVERIFIABLE) | The Bentley KB article on this subject is **"Material datasets for plates: sheet pile wall in bending"** (KB0110039; legacy wiki id 45929). Page body is JavaScript-rendered, so the "2026" date and the "AZ 25" example could not be read. | Use the real title + KB number; drop "(2026)" unless confirmed. |
| [8] | Bentley Systems. Modelling soil-structure interaction: interfaces. Official PLAXIS KB | UNVERIFIABLE | No KB article with this title found by search; Bentley KB pages cannot be fetched. Interface behaviour is documented in the PLAXIS 2D Reference Manual (Seequent, files.seequent.com) — prefer citing that. | Replace with Reference Manual citation or supply KB number. |
| [9] | Bentley Systems. End bearing of plates / Prevent punching. States option shall not be used for sheet-pile walls | VERIFIED-WITH-CORRECTION | KB article **"End bearing of plates"** exists: KB0110231 (legacy wiki 46016, created 19 Apr 2016). The "shall not be used for sheet-pile walls" statement could not be read (JS-rendered). | Cite as "End bearing of plates (KB0110231)"; keep the claim only if confirmed in the article. |
| [10] | Bentley Systems. Permeability in interfaces: Practical situations | UNVERIFIABLE | Not found. (A Bentley attachment "Definition of the Equivalent Permeability for a 2D Plane Strain Analysis of PVD", Aug 2024, surfaced instead — not this.) | Supply KB number or drop. |
| [11] | Bentley Systems. Permeability in interfaces. Definition of hydraulic resistance d/k and drainage conductivity d·k | VERIFIED | docs.bentley.com "Interfaces tabsheet" (PLAXIS help) defines hydraulic resistance = d/k [time] and drainage conductivity = d·k [volume/time/width]. | Cite the Reference Manual section "Interfaces tabsheet / permeability" rather than an unnamed KB page. |
| [12] | Bentley Systems. PLAXIS 2D Tutorial Manual — Dry excavation using a tie back wall | VERIFIED | Tutorial 6 in PLAXIS 2D 2025.1 Tutorial Manual (files.seequent.com, last updated 24 Sep 2025): node-to-node anchor = free length, embedded beam (row) = grouted length, T_skin = 400 kN/m. The explicit sentence "2D model cannot evaluate anchor pull-out" was not located in the excerpt read. | Add version/date. |
| [13] | Schanz, Vermeer & Bonnier (1999) … Beyond 2000 in Computational Geotechnics — 10 Years of PLAXIS, Balkema, pp. 281–296 | VERIFIED | Taylor & Francis chapter record (10.1201/9781315138206-27); Balkema, Rotterdam, pp. 281–296. | — |
| [14] | Simpson & Powrie (2001). Embedded retaining walls: theory, practice and understanding. 15th ICSMGE Istanbul, pp. 2505–2522 | VERIFIED-WITH-CORRECTION | ISSMGE online-library PDF (title/authors confirmed, 20 text pages); University of Southampton e-prints 53163 and Semantic Scholar list **pp. 2505–2524**. | Pages 2505–2524; add "Vol. 4, Balkema". |
| [15] | ArcelorMittal Sheet Piling. Piling Handbook, 9th edition (2016–2022) | VERIFIED-WITH-CORRECTION | ArcelorMittal download centre: 9th edition **2016**; "9th edition, revision 2022" (chapters 1 and 3 revised). | Write "9th ed., 2016, rev. 2022". |
| [16] | Bentley Systems. PLAXIS manuals — official current manual index | VERIFIED | files.seequent.com/PLAXIS/Manuals/PLAXIS_2D/English/ (2025.1 manuals, last updated 24 Sep 2025). | Add URL. |
| [17] | Buildwise / GBMS (2024). Belgian EC7 guideline for the geotechnical design of prestressed ground anchors | VERIFIED-WITH-CORRECTION | Downloaded https://www.buildwise.be/media/mxyludtd/nb-ec-7-grondankers.pdf — cover: "Richtlijnen voor de toepassing van de Eurocode 7 in België volgens NBN EN 1997-1 ANB – **Deel 3: Het grondmechanische ontwerp van voorgespannen groutankers**", footer "maart 2024"; prepared by Buildwise werkgroep "Beschoeiingen", approved by NBN E25007. Buildwise news item announces publication (2025). | Year 2024 is right; give the real title and issuer. |

### 2.2 Brinch_Hansen_Tlat_Soldier_Pile_Walls_Textbook_Section.md — "# References"

| # | Reference as written | Status | What was checked | Correction / note |
|---|---|---|---|---|
| [1] | Brinch Hansen, J. (1961). The Ultimate Resistance of Rigid Piles against Transversal Forces. Bulletin No. 12, DGI, Copenhagen, pp. 5–9 | VERIFIED | Geo (ex-DGI) library listing "Bulletin 12, 1961" with both papers; WorldCat/CiNii records; pp. 5–9 consistently given by citing literature (e.g. Springer, ASCE papers). Bulletin itself not openable online. | — |
| [2] | Christensen, N. H. (1961). Model Tests with Transversally Loaded Rigid Piles in Sand. Bulletin No. 12, DGI, pp. 10–16 | VERIFIED (pages unconfirmed) | Geo library listing confirms the paper and title in Bulletin 12 (1961). Page range 10–16 could not be confirmed (Scribd copy not readable; WorldCat blocked). | Keep; mark pages "to be checked against bulletin". |
| [3] | Andersen & Lodahl (2023). Modelling of soldier pile walls in PLAXIS 2D. NUMGE 2023. DOI 10.53243/NUMGE2023-25 | VERIFIED | doi.org resolves (302) to https://www.issmge.org/uploads/publications/51/119/NUMGE2023-25.pdf; ISSMGE publication page; local copy header: "Proceedings 10th NUMGE 2023, Zdravkovic L, Kontoe S, Taborda DMG, Tsiampousi A (eds)", authors F. Andersen, M.R. Lodahl (COWI, Aalborg). | Optionally add editors/publisher (ISSMGE). |
| [4] | BGGG and WTCB (2022). Richtlijnen … beschoeiingen. March 2022 | VERIFIED-WITH-CORRECTION | Same PDF as Doc 1 [3]. | Attribution/title as in §3. |
| [5] | NBN EN 1997-1:2005 … including A1:2014 and corrigenda | VERIFIED | Buildwise: "NBN EN 1997-1:2005 and its amendment NBN EN 1997-1/A1:2014"; AC:2009 (Buildwise NBN EN 1997-1 "(+AC:2009)"). | — |
| [6] | NBN EN 1997-1 ANB:2022 | VERIFIED | NBN record. | — |
| [7] | Bentley Systems / Seequent (2024). PLAXIS 2D 2024.3 Reference Manual | VERIFIED-WITH-CORRECTION | PLAXIS 2024.3 was released in **2025** (Geoengineer/Seequent "PLAXIS 2024.3 New Release", May 2025); current manuals on files.seequent.com are 2025.1 (24 Sep 2025). | Year 2025; publisher "Seequent, The Bentley Subsurface Company". |
| [8] | Bentley/Seequent (2025). 2D Analysis of an Anchored Soldier Pile Wall, PLAXIS 2D 2024.3 tutorial, May 2025 | VERIFIED-WITH-CORRECTION | KB article "2D Analysis of an Anchored Soldier Pile Wall" exists (KB0045693; search index shows created/modified 2 June 2025). The Bentley attachment dated "May 2025" that surfaced is the *Soil Nail Wall* tutorial (PLAXIS 2D 2024.2), not this one; the "May 2025"/"2024.3" details could not be confirmed. | Cite KB0045693; date "2025". |
| [9] | Bentley (2025). "New in PLAXIS 2D 2025.1.2." Release notes item 1749896 (Tlat strength reduction) | VERIFIED-WITH-CORRECTION | PLAXIS 2D 2025.1 Release Notes (KB0047805), section 2025.1.2, dated **February 2026**: "The strength of Tlat for embedded beams is now correctly reduced in a safety calculation when Apply Strength Reduction marked active on this structural element [1749896]". | Year 2026; KB number. |
| [10] | NBN (2024). NBN EN 1997-1:2024 standard record; status note | VERIFIED-WITH-CORRECTION | Buildwise/NBN: EN 1997-1:2024 is available "for information" and "does not yet have the status of a Belgian standard". | Designation is "EN 1997-1:2024" (not yet "NBN EN"); cite the Buildwise status page. |

### 2.3 Vibratory_Pile_Installation_Manual_Eurocode_Course_Chapter.md — "# References"

| # | Reference as written | Status | What was checked | Correction / note |
|---|---|---|---|---|
| 1 | CEN. EN 1990:2002+A1:2005 … NBN EN 1990 ANB:2021 | VERIFIED | NBN record NBN EN 1990 ANB:2021 (p40_id=351534); EN 1990:2002/A1:2005 standard CEN designation. | — |
| 2 | CEN. EN 1997-1:2004+A1:2013 … NBN EN 1997-1 ANB:2022 | VERIFIED | CEN designation EN 1997-1:2004/A1:2013; NBN ANB:2022 record. | — |
| 3 | CEN. EN 1997-2:2007 | VERIFIED | Standard designation (Buildwise Eurocode 7 pages); no separate catalogue record fetched. | — |
| 4 | CEN. EN 1997-1:2024 … status must be checked | VERIFIED | Buildwise status page (see Doc 1 [1]). | — |
| 5 | De Vos & Huybrechts (2020). Richtlijnen … axiaal belaste funderingspalen en micropalen … Dimensioneringsmethode 20, 56 p. | VERIFIED | https://www.buildwise.be/nl/publicaties/dimensioneringsmethodes/20/ — authors De Vos (M.), Huybrechts (N.), 2020, 56 pp., "vervangt nr 19". Title matches exactly. | — |
| 6 | CEN. EN 12699:2015 Displacement piles | VERIFIED | NBN record NBN EN 12699:2015 (p40_id=215601); BSI: published 30 Apr 2015, supersedes EN 12699:2001; still current. | — |
| 7 | CEN. EN 12063:2024 … Sheet pile walls, combined pile walls, high modulus walls | VERIFIED | As Doc 1 [6]; published 31 May 2024. | — |
| 8 | ISO 4866:2010 … confirmed by ISO review in 2021 | VERIFIED | iso.org/standard/38967 (via search index; direct fetch blocked): "last reviewed and confirmed in 2021"; note it is again "under periodical review" (April 2026). | — |
| 9 | BSI (2009, amended 2014). BS 5228-2:2009+A1:2014 | VERIFIED | Public PDF text-extracted: "BS 5228-2:2009+A1:2014 … Published by BSI Standards Limited 2014, ISBN 978 0 580 77750 9". | — |
| 10 | BSI (1993). BS 7385-2:1993 | VERIFIED | BSI/Intertek records; still current. | — |
| 11 | DIN (2016). DIN 4150-3:2016-12 | VERIFIED | Baunormenlexikon / MyStandards: DIN 4150-3:2016-12, published 1 Dec 2016. | — |
| 12 | BSI (2008). BS 6472-1:2008 | VERIFIED | BSI Knowledge: effective 30 June 2008; supersedes BS 6472:1992 (with Part 2). | — |
| 13 | Hiller & Crabb (2000). Groundborne vibration caused by mechanised construction works. TRL Report 429. Crowthorne: TRL | VERIFIED | https://www.trl.co.uk/uploads/trl/documents/TRL429.pdf downloaded and text-extracted: "TRL REPORT 429, First Published 2000, ISSN 0968-4107, D M Hiller and G I Crabb". | Optionally add ISSN. |
| 14 | Van Rompaey, Legrand & Holeyman (1995). A prediction method for the installation of vibratory driven piles. WIT Trans. Built Env., 15, 533–542. https://doi.org/10.2495/SD950601 | VERIFIED-WITH-CORRECTION (DOI invalid) | Paper PDF (witpress.com …/SD95/SD95060FU.pdf) extracted: header "Transactions on the Built Environment **vol 14**, © 1995 WIT Press, ISSN 1743-3509", running head "Soil Dynamics and Earthquake Engineering", pages 533–542 (10 pp.). Fondytest publication list: Proc. 7th Int. Conf. Soil Dynamics and Earthquake Engineering, Chania, Crete, 24–26 May 1995. DOI 10.2495/SD950601: doi.org 404, Crossref 404, absent from Crossref prefix 10.2495 search. | Volume 14; delete DOI; add URL. |
| 15 | Holeyman (2002). Soil behavior under vibratory driving. Keynote, TransVib 2002, 3–20. Lisse: Balkema | VERIFIED | Fondytest list: Proc. Int. Conf. on Vibratory Pile Driving and Deep Soil Compaction (TRANSVIB 2002), Louvain-la-Neuve, 9–10 Sept 2002, Balkema, Lisse, pp. 3–20; eds Holeyman, Vanden Berghe, Charue. | Title spelling in source is "behaviour"; add editors. |
| 16 | Holeyman & Whenham (2017). Critical Review of the Hypervib1 Model to Assess Vibratory Pile Drivability. GGE 35, 1933–1951. DOI 10.1007/s10706-017-0218-8 | VERIFIED-WITH-CORRECTION | Crossref: title "Critical Review of the Hypervib1 Model to Assess **Pile Vibro-Drivability**", Geotech. Geol. Eng. 35(5), 1933–1951, Springer; DOI resolves. | Title; add issue (5). |
| 17 | Massarsch, Wersäll & Fellenius (2022). Vibratory driving of piles and sheet piles – state of practice. Proc. ICE GE 175(1), 31–48. DOI 10.1680/jgeen.20.00127 | VERIFIED | Crossref: vol. 175(1), 31–48, online 5 Feb 2021, print 2022; DOI resolves. | — |
| 18 | Robertson (2009). Interpretation of cone penetration tests — a unified approach. CGJ 46(11), 1337–1355. DOI 10.1139/T09-065 | VERIFIED | Crossref; DOI resolves (registered lower-case t09-065; DOIs are case-insensitive). | — |
| 19 | European Commission, JRC (2024). Implementation of Design during Execution and Service Life. Publications Office. https://doi.org/10.2760/9211877 | **WRONG (DOI)** | doi.org and Crossref return 404 for 10.2760/9211877. JRC repository (JRC139606) and eurocodes.jrc.ec.europa.eu: "Implementation of Design during Execution & Service Life — Guidelines for the application of the 2nd generation of Eurocode 7: Geotechnical design", EUR 40128, Dec 2024, ISBN 978-92-68-22436-6 (online), **DOI 10.2760/8383117** (online) / 10.2760/9429668 (print); authors Bogusz, Caplane, Hard, Idda, Ingram, Kanty, Kushwaha, Nayrand, Sand, Sciarretta, Tsitsas, Vogt. | Replace DOI and complete citation (§3). |
| 20 | Nicholson, Tse & Penny (2000). The Observational Method in Ground Engineering: Principles and Applications. CIRIA R185 | VERIFIED-WITH-CORRECTION | CIRIA / NBS index / JRC listing: Report R185, published **October 1999**, 214 pp. | Year 1999. |
| 21 | Massarsch, Wersäll & Fellenius (2021). Dynamic Ground Response during Vibratory Sheet Pile Driving. JGGE 147(7), 04021043. DOI 10.1061/(ASCE)GT.1943-5606.0002520 | VERIFIED | Crossref; DOI resolves. | — |

### 2.4 Rekennota_beschoeiing_berlinerwand_HEA180.md — "# Referenties en bronnen"

#### Europese en Belgische normen

| Reference as written | Status | What was checked | Correction / note |
|---|---|---|---|
| NBN EN 1990:2002 (incl. A1:2005 en AC:2010) | VERIFIED | Buildwise Eurocode 0 fiche; EN 1990:2002/A1:2005/AC:2010 exists. | — |
| NBN EN 1990 ANB:2013 | VERIFIED-WITH-CORRECTION | NBN: NBN EN 1990 ANB:2021 is current; approval of the 2013 edition withdrawn by Royal Decree of 9 March 2021. | Cite NBN EN 1990 ANB:2021. |
| NBN EN 1991-1-1:2002 | VERIFIED | Buildwise record "NBN EN 1991-1-1 … (+ AC:2009)". | Add "(incl. AC:2009)". |
| NBN EN 1993-1-1:2005 (incl. AC:2009) | VERIFIED | Buildwise consolidated record (incl. AC:2009). | Note A1:2014 also exists. |
| NBN EN 1993-1-1 ANB:2010 | VERIFIED-WITH-CORRECTION | NBN records: ANB:2010 existed; current is NBN EN 1993-1-1 ANB:2018 (p40_id=350203). | Cite ANB:2018. |
| NBN EN 1993-5:2007 (incl. AC:2009) | VERIFIED | As Doc 1 [4]. | — |
| NBN EN 1993-5 ANB:2011 | VERIFIED | NBN record (nbn.be/shop … 27692). | — |
| NBN EN 1997-1:2005 (incl. AC:2009 en A1:2014) | VERIFIED | As Doc 2 [5]. | — |
| NBN EN 1997-1 ANB:2022 | VERIFIED | NBN record. | — |
| NBN EN 1997-2:2007 | VERIFIED | Designation (Buildwise); no record fetched. | — |
| NBN EN ISO 22476-1:2013 | VERIFIED-WITH-CORRECTION | Belgian registered edition is **NBN EN ISO 22476-1:2012** (EN ISO 22476-1:2012; C1/AC 2013) — cited as such by the BGGG CPT procedure and the Flemish DOV documentation; superseded by **NBN EN ISO 22476-1:2023** (ISO 22476-1:2022 = EN ISO 22476-1:2023; NBN record p40_id=413764). | Cite 2023 edition (or 2012 if the CPT was executed under it). |
| NBN EN 10365:2017 | VERIFIED | NBN shop record 563418. | — |
| NBN EN 10025-2:2019 | VERIFIED | NBN shop record 23502. | — |
| NBN EN 12063:1999 | VERIFIED-WITH-CORRECTION | Superseded by NBN EN 12063:2024 (EN 12063:2024, 31 May 2024). Note: EN 12063:2024 scope states "Composite structures such as Berliner walls … are not covered by this document" — relevant for a berlinerwand rekennota. | Cite 2024 edition and state scope limitation. |

#### Richtlijnen, standaardbestekken en overheidsreferenties

| Reference as written | Status | What was checked | Correction / note |
|---|---|---|---|
| NBN E25007 / Buildwise (2022). Richtlijnen … beschoeiingen. Maart 2022 | VERIFIED | Cover/front matter of the PDF; attribution to commission NBN E25007 is the most accurate of the three documents. | Add URL and "39 p." |
| Standaardbestek 260 (SB260), MOW. Hoofdstuk 21 – Geotechniek | VERIFIED-WITH-CORRECTION | SB260 versie 2.0 (March 2018) + "Errata en aanvullingen" (2022, mandatory from 1 Aug 2022); new versions of SB250/SB260 mandatory from 1 Jan 2026. Chapter 21 exists and covers geotechnical items (gronddruk, diepe glijvlakken). | Add version used (2.0 + errata 2022, or 2026 edition). |
| Standaardbestek 250, AWV | VERIFIED-WITH-CORRECTION | Exists; new version mandatory from 1 Jan 2026. Version not stated. | Add version. |
| WTCB/Buildwise Infofiche 56.1 – Berlijnse wanden. Type 1: beschottingen aanbrengen tijdens de uitgraving (2012) | VERIFIED | WTCB/Buildwise record: Infofiche 56.1, July 2012, title as written. | — |
| WTCB/Buildwise Infofiche 56.2 – Berlijnse wanden. Type 2: beschottingen aanbrengen tijdens de uitgraving (2012) | VERIFIED-WITH-CORRECTION (title) | WTCB record WTCB00000177: Infofiche 56.2, July 2012, "Berlijnse wanden. Type 2: beschottingen aanbrengen **vóór** de uitgraving". (The 2022 Belgian guideline's own ref. [7] carries the same typo.) | Fix title. |
| BGGG (2012). Standaardprocedures voor geotechnisch onderzoek. Sonderingen, Deel 1 | VERIFIED-WITH-CORRECTION | bggg-gbms.be PDF extracted: "Standaardprocedures voor geotechnisch onderzoek: SONDERINGEN – Deel 1: planning, uitvoering en rapportering, **14 juli 2016**" (doc code BGGG-CPT-pt1-2016; some footers still read pt1-2012, confirming a 2012 predecessor). Deel 2 (interpretatie) dated 27 Apr 2017. | Cite 2016 version. |
| CUR-rapport 2003-7. Bepaling geotechnische parameters. CUR, Gouda | VERIFIED | Handboek Tunnelbouw / CROW references: CUR 2003-7, Gouda, 2003. | Add year 2003. |
| CUR-publicatie 166. Damwandconstructies. CUR, Gouda (4e/6e druk) | VERIFIED-WITH-CORRECTION | CUR 166 Damwandconstructies, deel 1 en 2, **6e druk, Gouda 2012** (errata 4 Aug 2014). | Cite one edition: 6e druk 2012. |
| EAB (2012). Empfehlungen des Arbeitskreises "Baugruben", 5. Auflage. DGGT, Ernst & Sohn | VERIFIED | Ernst & Sohn / Wiley-VCH: 5. Auflage, Sept 2012, XVIII+332 pp. | — |

#### Wetenschappelijke publicaties en rekenmethoden

| Reference as written | Status | What was checked | Correction / note |
|---|---|---|---|
| Blum, H. (1931). Einspannungsverhaeltnisse bei Bohlwerken. Wilhelm Ernst & Sohn, Berlin | VERIFIED | Multiple German references (Springer/Wiley): "Blum, H.: Einspannungsverhältnisse bei Bohlwerken. Berlin: Ernst & Sohn 1931". | Use "Einspannungsverhältnisse" if diacritics are available. |
| Brinch Hansen (1961) … Bulletin 12, pp. 5–9 | VERIFIED | As Doc 2 [1]. | — |
| Brinch Hansen (1970). A revised and extended formula for bearing capacity. Bulletin No. 28, DGI | VERIFIED | Semantic Scholar / TRID / Google Books: DGI Bulletin 28, 1970, Copenhagen. | — |
| Schanz, Vermeer & Bonnier (1999) … pp. 281–296 | VERIFIED | As Doc 1 [13]. | — |
| Sanglerat (1972). The Penetrometer and Soil Exploration. Elsevier, Amsterdam | VERIFIED | ADS book review / AbeBooks: Elsevier, Amsterdam 1972, Developments in Geotechnical Engineering vol. 1, 464 pp. | — |
| Terzaghi, Peck & Mesri (1996). Soil Mechanics in Engineering Practice. 3rd ed., Wiley | VERIFIED | Wiley catalogue: 3rd ed. 1996, ISBN 978-0-471-08658-1. | — |
| Burland & Wroth (1974) … Pentech Press, pp. 611–654 | VERIFIED | WorldCat / TRID / ResearchGate: Proc. Conf. Settlement of Structures, Cambridge, Pentech Press, pp. 611–654. | — |
| Verruijt (2012). Soil Mechanics. Delft University of Technology | VERIFIED | geo.verruijt.net "Soil Mechanics, A. Verruijt, Delft University of Technology, 2001, 2012" (free PDF); TU Delft repository; VSSD print edition. | Add URL. |
| DIN 4150-3:2016 – Erschuetterungen im Bauwesen. Teil 3 | VERIFIED | As Doc 3 no. 11. | Designation "DIN 4150-3:2016-12". |

#### Software en handleidingen

| Reference as written | Status | What was checked | Correction / note |
|---|---|---|---|
| Bentley Systems (2024). PLAXIS 2D Reference Manual, Version 24. Bentley Systems, Delft | VERIFIED-WITH-CORRECTION | Official naming is "PLAXIS 2D 2024.x" (2024.1 / 2024.2 / 2024.3; 2024.3 released 2025); publisher "Seequent, The Bentley Subsurface Company"; manuals at files.seequent.com. | State exact version (e.g. 2024.2) and publisher. |
| Bentley Systems (2024). PLAXIS 2D Material Models Manual, Version 24 | VERIFIED-WITH-CORRECTION | Same. | Same. |
| MADEP CPT (madep.be) | n/a (own tool) | Not verified — internal tool. | Add version/date of the tool used. |

Body-text mentions without a reference entry (for completeness): "Caquot–Kérisel, Kérisel–Absi" tables (Rekennota §4, line 132) — not in the list and not verified; if kept, cite Kérisel, J. & Absi, E. (1990), *Active and Passive Earth Pressure Tables*, 3rd ed., Balkema, Rotterdam. Bond & Harris (2008) *Decoding Eurocode 7* is not cited in any of the four documents.

---

## 3. Corrections to apply (exact replacement text)

**Document 1 — Sheet pile manual**

- [3] → `Normalisatiecommissie NBN E25007 "Eurocode 7" (WTCB/Buildwise – SECO) (2022). Richtlijnen voor de toepassing van de Eurocode 7 in België volgens NBN EN 1997-1 ANB – Het grondmechanische ontwerp van ingebedde kerende constructies: beschoeiingen. Maart 2022, 39 p. Brussels: Buildwise / BGGG-GBMS. https://www.buildwise.be/media/srahyb00/na-ec-7-beschoeiingen-2022-final-nl.pdf`
- [6] → `NBN EN 12063:2024. Execution of special geotechnical work — Sheet pile walls, combined pile walls, high modulus walls. Brussels: NBN (EN 12063:2024, CEN, May 2024; supersedes EN 12063:1999).`
- [7] → `Seequent / Bentley Systems. Material datasets for plates: sheet pile wall in bending. PLAXIS Knowledge Base article KB0110039 (formerly wiki 45929). [date and AZ-profile example to be confirmed on the page]`
- [8] → replace by `Seequent (2025). PLAXIS 2D 2025.1 Reference Manual, chapter "Interfaces" (interface strength, stiffness and permeability). Seequent, The Bentley Subsurface Company. https://files.seequent.com/PLAXIS/Manuals/PLAXIS_2D/English/` (or supply the KB number of the intended article).
- [9] → `Seequent / Bentley Systems. End bearing of plates. PLAXIS Knowledge Base article KB0110231 (formerly wiki 46016, 2016).` Keep the "not for sheet-pile walls" sentence only after re-reading the article.
- [10] → supply KB number or delete; the d/k and d·k definitions are covered by [11].
- [11] → `Seequent (2025). PLAXIS 2D 2025.1 Reference Manual, "Interfaces tabsheet — hydraulic resistance (d/k) and drainage conductivity (d·k)". Seequent, The Bentley Subsurface Company.`
- [12] → `Seequent (2025). PLAXIS 2D 2025.1 Tutorial Manual, Tutorial 6: Dry excavation using a tie back wall (last updated 24 September 2025). https://files.seequent.com/PLAXIS/Manuals/PLAXIS_2D/English/PLAXIS_2D_1_Tutorial%20Manual.pdf`
- [14] → `Simpson, B. and Powrie, W. (2001). Embedded retaining walls: theory, practice and understanding. Proceedings of the 15th International Conference on Soil Mechanics and Geotechnical Engineering, Istanbul, Vol. 4, Balkema, pp. 2505–2524.`
- [15] → `ArcelorMittal Sheet Piling (2016, rev. 2022). Piling Handbook, 9th edition (2016; chapters 1 and 3 revised 2022). Luxembourg: ArcelorMittal Commercial RPS.`
- [17] → `Buildwise werkgroep "Beschoeiingen" / Normalisatiecommissie NBN E25007 (2024). Richtlijnen voor de toepassing van de Eurocode 7 in België volgens NBN EN 1997-1 ANB – Deel 3: Het grondmechanische ontwerp van voorgespannen groutankers. Maart 2024. https://www.buildwise.be/media/mxyludtd/nb-ec-7-grondankers.pdf`

**Document 2 — Brinch Hansen / T_lat section**

- [2] → keep text; append `(page range to be confirmed against the bulletin)` or cite as `Bulletin No. 12, The Danish Geotechnical Institute, Copenhagen` without pages.
- [4] → same replacement as Doc 1 [3].
- [7] → `Seequent, The Bentley Subsurface Company (2025). PLAXIS 2D 2024.3 Reference Manual.` (or the 2025.1 manual, 24 Sept 2025, if that is what was used).
- [8] → `Seequent / Bentley Systems (2025). 2D Analysis of an Anchored Soldier Pile Wall. PLAXIS Knowledge Base tutorial KB0045693 (2025).`
- [9] → `Seequent / Bentley Systems (2026). PLAXIS 2D 2025.1 Release Notes, section "New in PLAXIS 2D 2025.1.2" (February 2026), fixed issue [1749896]: "The strength of Tlat for embedded beams is now correctly reduced in a safety calculation when Apply Strength Reduction marked active on this structural element." Knowledge Base article KB0047805.`
- [10] → `Buildwise (2024–2026). EN 1997-1:2024 – Eurocode 7: Geotechnical design – Part 1: General rules — status page: available for information only, not yet a Belgian standard pending the Belgian National Annex; NBN EN 1997-1:2005 + A1:2014 remain applicable. https://www.buildwise.be/en/publications/standards-regulations/en-1997-1-2024-en/`

**Document 3 — Vibratory pile installation chapter**

- No. 14 → `Van Rompaey, D., Legrand, C. and Holeyman, A. (1995). "A prediction method for the installation of vibratory driven piles." Proceedings of the 7th International Conference on Soil Dynamics and Earthquake Engineering (SDEE 95), Chania, Crete, 24–26 May 1995. WIT Transactions on the Built Environment, 14, 533–542. Southampton: WIT Press. ISSN 1743-3509. https://www.witpress.com/Secure/elibrary/papers/SD95/SD95060FU.pdf` (remove the DOI — it does not resolve).
- No. 16 → `Holeyman, A. and Whenham, V. (2017). "Critical Review of the Hypervib1 Model to Assess Pile Vibro-Drivability." Geotechnical and Geological Engineering, 35(5), 1933–1951. https://doi.org/10.1007/s10706-017-0218-8`
- No. 19 → `Bogusz, W., Caplane, C., Hard, D., Idda, K., Ingram, P., Kanty, P., Kushwaha, A., Nayrand, N., Sand, O., Sciarretta, F., Tsitsas, G. and Vogt, H. (2024). Implementation of Design during Execution & Service Life – Guidelines for the application of the 2nd generation of Eurocode 7: Geotechnical design. JRC Technical Report JRC139606, EUR 40128. Luxembourg: Publications Office of the European Union. ISBN 978-92-68-22436-6. https://doi.org/10.2760/8383117`
- No. 20 → `Nicholson, D., Tse, C.-M. and Penny, C. (1999). The Observational Method in Ground Engineering: Principles and Applications. CIRIA Report R185. London: CIRIA. 214 pp.`
- (optional) No. 15 → `Holeyman, A. E. (2002). "Soil behaviour under vibratory driving." Keynote lecture, in Holeyman, A., Vanden Berghe, J.-F. and Charue, N. (eds), Vibratory Pile Driving and Deep Soil Compaction – TRANSVIB 2002, Louvain-la-Neuve, 9–10 September 2002. Lisse: A.A. Balkema / Swets & Zeitlinger, pp. 3–20.`

**Document 4 — Rekennota**

- `NBN EN 1990 ANB:2013` → `NBN EN 1990 ANB:2021 - Eurocode 0: Grondslag voor het constructief ontwerp. Nationale Bijlage`
- `NBN EN 1991-1-1:2002` → `NBN EN 1991-1-1:2002 - … (incl. AC:2009)`
- `NBN EN 1993-1-1 ANB:2010` → `NBN EN 1993-1-1 ANB:2018 - Belgische Nationale Bijlage bij EN 1993-1-1`
- `NBN EN ISO 22476-1:2013` → `NBN EN ISO 22476-1:2023 - Geotechnisch onderzoek en beproeving. Veldproeven. Deel 1: Elektrische sondering met en zonder waterspanningsmeting (vervangt NBN EN ISO 22476-1:2012)` — if the CPTs were executed before 2023, cite `NBN EN ISO 22476-1:2012 (+ AC:2013)`.
- `NBN EN 12063:1999` → `NBN EN 12063:2024 - Uitvoering van bijzonder geotechnisch werk. Damwanden, combiwanden en wanden met hoge stijfheid (vervangt NBN EN 12063:1999; berlinerwanden vallen buiten het toepassingsgebied)`
- `Standaardbestek 260 …` → add `versie 2.0 (maart 2018) incl. Errata en aanvullingen (2022)` or the 2026 edition actually used; same for SB250.
- `WTCB/Buildwise Infofiche 56.2 - Berlijnse wanden. Type 2: beschottingen aanbrengen tijdens de uitgraving (2012)` → `WTCB/Buildwise Infofiche 56.2 - Berlijnse wanden. Type 2: beschottingen aanbrengen vóór de uitgraving (juli 2012)`
- `BGGG (2012). Standaardprocedures …` → `BGGG-GBMS (2016). Standaardprocedures voor geotechnisch onderzoek: Sonderingen. Deel 1: planning, uitvoering en rapportering (BGGG-CPT-pt1-2016, 14 juli 2016). www.bggg-gbms.be` (add Deel 2, 27 april 2017, if interpretation rules are used).
- `CUR-rapport 2003-7 …` → `CUR-rapport 2003-7 (2003). Bepaling geotechnische parameters. Stichting CUR, Gouda.`
- `CUR-publicatie 166 … (4e/6e druk)` → `CUR-publicatie 166 (2012). Damwandconstructies, deel 1 en 2, 6e druk. Stichting CUR, Gouda (incl. errata 2014).`
- `Bentley Systems (2024). PLAXIS 2D Reference Manual, Version 24. Bentley Systems, Delft` → `Seequent, The Bentley Subsurface Company (2024). PLAXIS 2D 2024.x Reference Manual` with the exact minor version used; same for the Material Models Manual. Add the URL https://files.seequent.com/PLAXIS/Manuals/PLAXIS_2D/English/.
- `DIN 4150-3:2016` → `DIN 4150-3:2016-12`.

---

## 4. Factual claims tied to references — result of the check

| Claim in document | Source fetched | Result |
|---|---|---|
| TRL 429 vibratory piling: v_res = k_v / x^δ; k_v = 60 (50 %), 126 (33 %), 266 (5 %); δ = 1.2 start-up/run-down, 1.3 all operations, 1.4 steady state; 1281 observations; 1 ≤ x ≤ 100 m; 1.2 ≤ W_c ≤ 10.7 kJ/cycle | TRL429.pdf §5.6.3 and summary table (text-extracted) | **Confirmed verbatim**: "kv = 60, with a 50 per cent probability … kv = 126, 33 per cent … kv = 266, 5 per cent … δ = 1.2 (start-up and run-down); 1.4 (steady-state); or 1.3 (all operations)"; "a total of 1281 observations"; table: "1 ≤ x ≤ 100 m, 1.2 ≤ Wc ≤ 10.7 kJ". Also reproduced in BS 5228-2:2009+A1:2014 Annex E, Table E.1. |
| BS 5228-2 human-response descriptors (0.14 / 0.3 / 1.0 / 10 mm/s) | BS 5228-2:2009+A1:2014 Table B.1 (text-extracted) | **Confirmed**: 0.14 "might be just perceptible in the most sensitive situations for most vibration frequencies associated with construction"; 0.3 "might be just perceptible in residential environments"; 1.0 "likely … cause complaint, but can be tolerated if prior warning and explanation has been given"; 10 "likely to be intolerable for any more than a very brief exposure". Manual's paraphrase is faithful. |
| BS 7385-2:1993 Table 1 (residential/light-framed): 15 mm/s at 4 Hz rising to 20 mm/s at 15 Hz, 50 mm/s at 40 Hz and above; below 4 Hz displacement governs | BSI/Intertek/ResearchGate reproductions of Table 1 | **Confirmed** end-point values (0.6 mm zero-to-peak below 4 Hz). Caveat: the manual's straight-line interpolation formulae reproduce the table end-points but BS 7385-2 Figure 1 is drawn on log-log axes, so intermediate values are an approximation — say so. |
| DIN 4150-3 Line 2 (dwellings), short-term: 5 mm/s (1–10 Hz), 5–15 mm/s (10–50 Hz), 15–20 mm/s (50–100 Hz) | Secondary reproduction of Table 1 (Millar vibration-standards review, 1999 edition) | **Confirmed** for Line 2 (and top-floor 15 mm/s; Line 1: 20 / 20–40 / 40–50). Not confirmed against a fetched copy of the 2016-12 edition; the 2016-12 revision is generally reported to keep the Table 1 values. |
| Belgian guideline RK 2, DA1/2: γ_G 1.00/1.00, γ_Q 1.10/0.00, γ_γ 1.00, γ_φ 1.25, γ_c 1.25, γ_cu 1.40 (Tabel 8); RK 3 γ_φ 1.40 | Guideline PDF, Tabel 8 (p. 26) and Tabel 9 | **Confirmed verbatim** (Tabel 8 "DA 1/2 1.00 1.00 1.10 0.00 1.00 1.25 1.25 1.40"; Tabel 9 RK 3: γ_φ 1.40, γ_cu 1.55). Sheet-pile manual §5.2 table and Rekennota §4.4 table match. |
| +0.30 m over-excavation in ULS for dry excavation, relaxable with control measures (regular checks, blinding concrete within 48 h); underwater min[0.1h; 0.5 m] | Guideline §3.3 "Rekenwaarde uitgravingsniveau" (p. 11–12) | **Confirmed verbatim**: "Bij UGT en bij uitgraving in den droge dient er een overdiepte van 0.3 m opgeteld te worden bij de nominale diepte. Indien hiervan afgeweken wordt, dienen er duidelijke afspraken gemaakt te worden … (regelmatige controles van de uitgravingsdiepte, aanbrengen van een laag zuiverheidsbeton … binnen 48 uur na uitgraving, …)". Section number §3.3 as cited in the Rekennota is correct. |
| FEM procedure: all phases with SLS factors and α_ver = 1.1 on variable loads; internal forces ×1.35; φ-c reduction ≥ 1.25 for RK 2 (§3.5) | Guideline §3.5 "Rekenmethodologie voor de wandberekening" (p. 15–19) | **Confirmed**: "alle fasen doorgerekend met de factoren van de BGT en met de factor αver gelijk aan 1.1 … Op de maatgevende fase wordt vervolgens een φ-c reductie toegepast, waarbij een veiligheid van minimum 1.25 dient te worden gehaald"; the ×1.35 step is in the spring-model procedure ("De maatgevende snedekrachten … worden met een factor 1,35 vermenigvuldigd"). Section number §3.5 correct. |
| NUMGE 2023 paper studied one cantilever wall in frictional soil (Doc 2 source note) | NUMGE2023-25 PDF | **Confirmed** ("comparisons are based on a situation with a cantilever wall placed in friction material"). |

---

## 5. Not verifiable online — what would be needed

| Item | Why | What would settle it |
|---|---|---|
| Doc 1 [7] Bentley KB "plate properties for sheet pile walls" — date "(2026)" and AZ 25 worked example | Bentley KB pages (service-now) are JavaScript-rendered; only the title "Material datasets for plates: sheet pile wall in bending" (KB0110039) is visible. | Open KB0110039 in a browser; record "last updated" date and the profile used. |
| Doc 1 [8] "Modelling soil-structure interaction: interfaces" | No article with this title located. | KB number/URL from the author, or replace by the Reference Manual. |
| Doc 1 [9] statement that "Prevent punching shall not be used for sheet-pile walls" | Article "End bearing of plates" (KB0110231) exists but body not readable. | Open KB0110231 and quote. |
| Doc 1 [10] "Permeability in interfaces: Practical situations" | Not found. | KB number/URL. |
| Doc 1 [12] sentence "2D model cannot evaluate anchor pullout capacity" | Tutorial 6 confirmed; this sentence not located (manual PDF > 10 MB, could not be fully read). | Search the 2025.1 Tutorial Manual PDF locally. |
| Doc 2 [2] Christensen (1961) pp. 10–16 | Bulletin 12 not openable (Scribd/WorldCat blocked); geo.dk listing gives no pagination. | Physical/PDF copy of DGI Bulletin 12 (Geo library, Lyngby). |
| Doc 2 [8] "May 2025" and "PLAXIS 2D 2024.3" for the anchored soldier-pile-wall tutorial | KB0045693 exists (index date 2 June 2025); attachment not retrievable. | Open KB0045693; record date/version on the PDF title page. |
| Doc 3 no. 11 / Doc 4 DIN 4150-3:2016-12 Table 1 values | Only a reproduction of the 1999 table was fetchable. | Copy of DIN 4150-3:2016-12 (Beuth) to confirm Table 1 unchanged. |
| Doc 3 no. 8 ISO 4866:2010 current status | iso.org blocks automated fetch; search index states "confirmed 2021; under periodical review April 2026". | Check iso.org/standard/38967 manually for the review outcome. |
| Doc 4 SB260 "Hoofdstuk 21 – Geotechniek" chapter title and SB250 version | Chapter exists; exact chapter title and the version actually used not confirmed. | State the SB260/SB250 version and check the chapter heading in that version. |
| Doc 4 NBN EN 1997-2:2007 / EN 1997-2:2007 | Designation is standard but no catalogue record was fetched. | Trivial — NBN record lookup. |
| Doc 4 MADEP CPT | Internal tool. | Add version/date. |

Local working copies used for the verbatim checks (scratchpad, not part of the repo): Belgian guideline text (`beschoeiingen2022.txt`), TRL 429 (`trl429.txt`), BS 5228-2 (`bs5228.txt`), WIT 1995 paper (`wit.txt`), Simpson & Powrie ISSMGE PDF (`simpson2.txt`), Buildwise anchor guideline (`anchors.txt`), BGGG CPT Deel 1 (`bggg.txt`).

---

## 6. Post-check addendum (main session, 29 Aug 2026) — hyperlinks embedded in the manual

The "[working source]" tags in the sheet-pile manual are hyperlinks. Their targets settle three of the UNVERIFIABLE rows above:

| Ref | Hyperlink target | Finding |
|---|---|---|
| [7] | KB0051314 | Article number not indexed; the two Bentley KB articles on sheet-pile plate data sets are "Material datasets for plates: sheet pile wall in bending" (KB0110039 / wiki 45929, last modified 11 July 2025) and "Material parameter datasets for sheetpiles and beams" (wiki 46023). Entry rewritten to cite both; the "(2026)" date and the AZ 25 attribution are dropped from the reference (the body keeps the worked values). |
| [8] | KB0110020 | **Exists** with the manual's title "Modelling soil-structure interaction: interfaces" (PLAXIS 2D/3D, created 20 Aug 2012) — status upgraded to VERIFIED; KB number added. |
| [9] | KB0110231 | "End bearing of plates" — matches. The sentence "Bentley explicitly states that Prevent punching shall not be used for sheet-pile walls" could not be read on the JS-rendered page; the body now states the elastic-zone nature of the option and the manual's own decision (Prevent punching = No) without the verbatim attribution. |
| [10] | KB0109902 | **Exists** with the manual's title "Permeability in interfaces: Practical situations" (Tips and tricks, created 4 Jul 2017) — VERIFIED; KB number added. |
| [11] | KB0109451 | **Exists**: "Permeability in interfaces" — VERIFIED; KB number added. |
| [12] | service-now attachment 2f303437… | Tutorial PDF attachment; entry now cites the 2025.1 Tutorial Manual, Tutorial 6. |
| [13] | KB0110202 | Bentley KB copy of the Schanz et al. (1999) paper — consistent. |
| [16] | KB0107989 | PLAXIS manuals index article — consistent. |

Applied corrections: `worklog/verify/apply_reference_corrections.py` (first pass) and `--fixup` (this addendum). All four documents edited; originals in `worklog/course-originals/`; text copies regenerated in `worklog/course-text/`.
Not applied (judgement calls left to the author): Christensen (1961) page range kept (pp. 10–16, consistently cited in the literature); the Rekennota's SB250/SB260 version and PLAXIS sub-version are left as «in te vullen» placeholders in the template style of that document.
