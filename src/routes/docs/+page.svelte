<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	const pageTitle = 'Technical Documentation — MADEP CPT Interpreter';
	const pageDescription =
		'Technical documentation for the MADEP CPT Interpreter: GEF loading, classification, layer derivation, model parameters, tuning, and Stage 6 engineering applications including Bishop/Spencer, seepage, and deformation, with formulas, notation, and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs';
	const ogImageUrl = 'https://cpt.madep.be/logo.png';

	type Reference = {
		label: string;
		detail: string;
	};

	type ReferenceGroup = {
		title: string;
		items: Reference[];
	};

	type DocFigure = {
		src: string;
		alt: string;
		caption: string;
		collapsible?: boolean;
		summary?: string;
	};

	type DocTable = {
		caption: string;
		note?: string;
		collapsible?: boolean;
		summary?: string;
		columns: { key: string; label: string }[];
		rows: Record<string, string>[];
	};

	type DocSubsection = {
		id: string;
		title: string;
		paragraphs: string[];
		equations?: string[];
		bullets?: string[];
		symbols?: { term: string; meaning: string }[];
		figures?: DocFigure[];
		table?: DocTable;
	};

	type DocSection = {
		id: string;
		title: string;
		intro: string;
		references: string[];
		subsections: DocSubsection[];
	};

	const nenTable3Rows: Record<string, string>[] = [
		{ family: 'Veen', subtype: 'veen, weinig vast', qc: '0.2 ≤ q<sub>c</sub> &lt; 0.5', rf: 'R<sub>f</sub> &gt; 6', gamma: '10', gammaSat: '10', phi: '15', c: '2', cu: '10' },
		{ family: 'Veen', subtype: 'veen, matig vast', qc: '0.5 ≤ q<sub>c</sub> &lt; 1.0', rf: 'R<sub>f</sub> &gt; 6', gamma: '12', gammaSat: '12', phi: '15', c: '5', cu: '20' },
		{ family: 'Veen', subtype: 'veen, vast', qc: 'q<sub>c</sub> ≥ 1.0', rf: 'R<sub>f</sub> &gt; 6', gamma: '14', gammaSat: '14', phi: '15', c: '10', cu: '40' },
		{ family: 'Klei', subtype: 'klei, weinig vast', qc: '0.4 ≤ q<sub>c</sub> &lt; 1.0', rf: '3 ≤ R<sub>f</sub> ≤ 6', gamma: '16', gammaSat: '16', phi: '20', c: '2', cu: '20' },
		{ family: 'Klei', subtype: 'klei, matig vast', qc: '1.0 ≤ q<sub>c</sub> &lt; 2.0', rf: '3 ≤ R<sub>f</sub> ≤ 6', gamma: '17', gammaSat: '17', phi: '20', c: '4', cu: '50' },
		{ family: 'Klei', subtype: 'klei, vrij vast', qc: '2.0 ≤ q<sub>c</sub> &lt; 4.0', rf: '3 ≤ R<sub>f</sub> ≤ 6', gamma: '18', gammaSat: '18', phi: '20', c: '8', cu: '100' },
		{ family: 'Klei', subtype: 'klei, vast', qc: 'q<sub>c</sub> ≥ 4.0', rf: '3 ≤ R<sub>f</sub> ≤ 6', gamma: '19', gammaSat: '19', phi: '20', c: '15', cu: '200' },
		{ family: 'Klei zandhoudend', subtype: 'klei (zh), weinig vast', qc: '0.4 ≤ q<sub>c</sub> &lt; 1.0', rf: '2 ≤ R<sub>f</sub> ≤ 5', gamma: '16', gammaSat: '16', phi: '22', c: '2', cu: '20' },
		{ family: 'Klei zandhoudend', subtype: 'klei (zh), matig vast', qc: '1.0 ≤ q<sub>c</sub> &lt; 2.0', rf: '2 ≤ R<sub>f</sub> ≤ 5', gamma: '17', gammaSat: '17', phi: '22', c: '4', cu: '50' },
		{ family: 'Klei zandhoudend', subtype: 'klei (zh), vrij vast', qc: '2.0 ≤ q<sub>c</sub> &lt; 4.0', rf: '2 ≤ R<sub>f</sub> ≤ 5', gamma: '18', gammaSat: '18', phi: '22', c: '8', cu: '100' },
		{ family: 'Klei zandhoudend', subtype: 'klei (zh), vast', qc: 'q<sub>c</sub> ≥ 4.0', rf: '2 ≤ R<sub>f</sub> ≤ 5', gamma: '19', gammaSat: '19', phi: '22', c: '15', cu: '200' },
		{ family: 'Leem', subtype: 'leem, weinig vast', qc: '0.4 ≤ q<sub>c</sub> &lt; 1.0', rf: '2 ≤ R<sub>f</sub> ≤ 4', gamma: '17', gammaSat: '17', phi: '22', c: '0', cu: '10' },
		{ family: 'Leem', subtype: 'leem, matig vast', qc: '1.0 ≤ q<sub>c</sub> &lt; 2.0', rf: '2 ≤ R<sub>f</sub> ≤ 4', gamma: '18', gammaSat: '18', phi: '22', c: '2', cu: '25' },
		{ family: 'Leem', subtype: 'leem, vrij vast', qc: '2.0 ≤ q<sub>c</sub> &lt; 4.0', rf: '2 ≤ R<sub>f</sub> ≤ 4', gamma: '19', gammaSat: '19', phi: '22', c: '4', cu: '50' },
		{ family: 'Leem', subtype: 'leem, vast', qc: 'q<sub>c</sub> ≥ 4.0', rf: '2 ≤ R<sub>f</sub> ≤ 4', gamma: '20', gammaSat: '20', phi: '22', c: '8', cu: '100' },
		{ family: 'Zandhoudende leem', subtype: 'leem (zh), weinig vast', qc: '0.4 ≤ q<sub>c</sub> &lt; 1.0', rf: '1 ≤ R<sub>f</sub> ≤ 3', gamma: '17', gammaSat: '17', phi: '25', c: '0', cu: '10' },
		{ family: 'Zandhoudende leem', subtype: 'leem (zh), matig vast', qc: '1.0 ≤ q<sub>c</sub> &lt; 2.0', rf: '1 ≤ R<sub>f</sub> ≤ 3', gamma: '18', gammaSat: '18', phi: '25', c: '2', cu: '25' },
		{ family: 'Zandhoudende leem', subtype: 'leem (zh), vrij vast', qc: '2.0 ≤ q<sub>c</sub> &lt; 4.0', rf: '1 ≤ R<sub>f</sub> ≤ 3', gamma: '19', gammaSat: '19', phi: '25', c: '4', cu: '50' },
		{ family: 'Zandhoudende leem', subtype: 'leem (zh), vast', qc: 'q<sub>c</sub> ≥ 4.0', rf: '1 ≤ R<sub>f</sub> ≤ 3', gamma: '20', gammaSat: '20', phi: '25', c: '8', cu: '100' },
		{ family: 'Zand', subtype: 'zand, los', qc: '2 ≤ q<sub>c</sub> &lt; 4', rf: 'R<sub>f</sub> &lt; 1', gamma: '16', gammaSat: '18', phi: '27', c: '0', cu: '0' },
		{ family: 'Zand', subtype: 'zand, matig', qc: '4 ≤ q<sub>c</sub> &lt; 10', rf: 'R<sub>f</sub> &lt; 1', gamma: '17', gammaSat: '19', phi: '30', c: '0', cu: '0' },
		{ family: 'Zand', subtype: 'zand, dicht', qc: '10 ≤ q<sub>c</sub> &lt; 15', rf: 'R<sub>f</sub> &lt; 1', gamma: '18', gammaSat: '20', phi: '32', c: '0', cu: '0' },
		{ family: 'Zand', subtype: 'zand, zeer dicht', qc: 'q<sub>c</sub> ≥ 15', rf: 'R<sub>f</sub> &lt; 1', gamma: '18', gammaSat: '20', phi: '35', c: '0', cu: '0' },
		{ family: 'Leemhoudend zand', subtype: 'zand (lh), los', qc: '2 ≤ q<sub>c</sub> &lt; 4', rf: '1 ≤ R<sub>f</sub> ≤ 2', gamma: '16', gammaSat: '18', phi: '25', c: '0', cu: '0' },
		{ family: 'Leemhoudend zand', subtype: 'zand (lh), matig', qc: '4 ≤ q<sub>c</sub> &lt; 10', rf: '1 ≤ R<sub>f</sub> ≤ 2', gamma: '17', gammaSat: '19', phi: '27', c: '0', cu: '0' },
		{ family: 'Leemhoudend zand', subtype: 'zand (lh), dicht', qc: '10 ≤ q<sub>c</sub> &lt; 15', rf: '1 ≤ R<sub>f</sub> ≤ 2', gamma: '18', gammaSat: '20', phi: '30', c: '0', cu: '0' },
		{ family: 'Leemhoudend zand', subtype: 'zand (lh), z.dicht', qc: 'q<sub>c</sub> ≥ 15', rf: '1 ≤ R<sub>f</sub> ≤ 2', gamma: '19', gammaSat: '20', phi: '32', c: '0', cu: '0' },
		{ family: 'Grind', subtype: 'grind, matig', qc: '10 ≤ q<sub>c</sub> &lt; 20', rf: 'R<sub>f</sub> &lt; 1', gamma: '18', gammaSat: '20', phi: '35', c: '0', cu: '0' },
		{ family: 'Grind', subtype: 'grind, dicht', qc: 'q<sub>c</sub> ≥ 20', rf: 'R<sub>f</sub> &lt; 1', gamma: '19', gammaSat: '21', phi: '40', c: '0', cu: '0' },
		{ family: 'Grind klei-/leemhoudend', subtype: 'grind (kh), matig', qc: '10 ≤ q<sub>c</sub> &lt; 20', rf: '1 ≤ R<sub>f</sub> ≤ 2', gamma: '19', gammaSat: '21', phi: '32', c: '0', cu: '0' },
		{ family: 'Grind klei-/leemhoudend', subtype: 'grind (kh), dicht', qc: 'q<sub>c</sub> ≥ 20', rf: '1 ≤ R<sub>f</sub> ≤ 2', gamma: '20', gammaSat: '22', phi: '37', c: '0', cu: '0' }
	];

	const alphaMethodRows: Record<string, string>[] = [
		{ method: 'A', family: 'Behavioural type', soil: 'Peat / organic', qc: 'any', rule: 'fixed α', expression: 'α = 1.5' },
		{ method: 'A', family: 'Behavioural type', soil: 'Soft clay / Clay', qc: 'any', rule: 'fixed α', expression: 'α = 3.0 or 5.0' },
		{ method: 'A', family: 'Behavioural type', soil: 'Sandy clay / Silty sand / Sand / Gravel', qc: 'any', rule: 'fixed α', expression: 'α = 8.0 / 10.0 / 13.0 / 15.0' },
		{ method: 'B', family: 'Cohesive', soil: 'veen, ...', qc: 'any', rule: 'SB260 default when w unknown', expression: 'α = 1.5' },
		{ method: 'B', family: 'Cohesive', soil: 'klei, ...', qc: 'q<sub>c</sub> &lt; 0.7; 0.7 ≤ q<sub>c</sub> &lt; 2.0; q<sub>c</sub> ≥ 2.0', rule: 'GEO values by q<sub>c</sub> band', expression: 'α = 5.0; 3.0; 1.5' },
		{ method: 'B', family: 'Cohesive', soil: 'leem, ...', qc: 'q<sub>c</sub> &lt; 2.0; q<sub>c</sub> ≥ 2.0', rule: 'GEO values by q<sub>c</sub> band', expression: 'α = 4.0; 2.0' },
		{ method: 'B', family: 'Transition', soil: 'klei (zh), ... / leem (zh), ... / zand (lh), ...', qc: 'q<sub>c</sub> &lt; 2.5', rule: 'transition rule', expression: 'α = 2.0' },
		{ method: 'B', family: 'Transition', soil: 'klei (zh), ... / leem (zh), ... / zand (lh), ...', qc: '2.5 ≤ q<sub>c</sub> &lt; 5.0', rule: 'E<sub>s</sub> = 4q<sub>c</sub> − 5', expression: 'α = (4q<sub>c</sub> − 5) / q<sub>c</sub>' },
		{ method: 'B', family: 'Transition', soil: 'klei (zh), ... / leem (zh), ... / zand (lh), ...', qc: 'q<sub>c</sub> ≥ 5.0', rule: 'transition cap', expression: 'α = 2.0' },
		{ method: 'B', family: 'Granular', soil: 'zand, ... / grind, ... / grind (kh), ...', qc: 'q<sub>c</sub> ≤ 10', rule: 'NC granular rule', expression: 'E<sub>s</sub> = 4q<sub>c</sub>, so α = 4.0' },
		{ method: 'B', family: 'Granular', soil: 'zand, ... / grind, ... / grind (kh), ...', qc: '10 &lt; q<sub>c</sub> ≤ 50', rule: 'NC granular rule', expression: 'E<sub>s</sub> = 2q<sub>c</sub> + 20, so α = (2q<sub>c</sub> + 20) / q<sub>c</sub>' },
		{ method: 'B', family: 'Granular', soil: 'zand, ... / grind, ... / grind (kh), ...', qc: 'q<sub>c</sub> &gt; 50', rule: 'NC granular rule', expression: 'E<sub>s</sub> = 120, so α = 120 / q<sub>c</sub>' }
	];

	const referenceGroups: ReferenceGroup[] = [
		{
			title: 'Eurocodes and Belgian National Annexes',
			items: [
				{ label: 'EN 1997-1:2004+A1:2013', detail: 'Eurocode 7 — Geotechnical design — General rules.' },
				{ label: 'NBN EN 1997-1 ANB:2022', detail: 'Belgian National Annex to EN 1997-1, Design Approach 1.' },
				{ label: 'EN 1990:2002+A1:2005', detail: 'Basis of structural design.' },
				{ label: 'NBN EN 1990 ANB:2005', detail: 'Belgian National Annex to EN 1990.' },
				{ label: 'EN 1992-1-1', detail: 'Eurocode 2 — Design of concrete structures.' },
				{ label: 'NBN EN 1992-1-1 ANB', detail: 'Belgian National Annex to EN 1992-1-1.' }
			]
		},
		{
			title: 'Books and Journal Papers',
			items: [
				{ label: 'Terzaghi & Peck (1967)', detail: 'Soil Mechanics in Engineering Practice, 2nd ed.' },
				{ label: 'Vesić (1975)', detail: 'Bearing Capacity of Shallow Foundations, in Foundation Engineering Handbook (Winterkorn & Fang, eds.).' },
				{ label: 'Robertson (1990)', detail: 'Soil classification using the CPT. Canadian Geotechnical Journal, 27(1), 151–158.' },
				{ label: 'Robertson (2016)', detail: 'Cone penetration test (CPT)-based soil behaviour type (SBT) classification system — an update. Canadian Geotechnical Journal, 53(12), 1910–1927.' },
				{ label: 'Robertson & Wride (1998)', detail: 'Evaluating cyclic liquefaction potential using the CPT. Canadian Geotechnical Journal, 35, 442–459.' }
			]
		},
		{
			title: 'Belgian/Dutch Practice Documents',
			items: [
				{ label: 'SB260', detail: 'Standaardbestek 260, artikel 21-6.4.10: karakteristieke grondparameters op basis van elektrische sondering.' },
				{ label: 'CUR 2003-7', detail: 'CPT-correlated geotechnical parameter guidance used in Belgian and Dutch practice.' },
				{ label: 'NEN 6740', detail: 'Dutch geotechnical design standard with stress-dependent CPT material classification.' },
				{ label: 'Deltares D-SHEET Piling User Manual', detail: 'Version 24.1; §34.2.2 documents the NEN stress-correction formula q<sub>c,NEN</sub> = q<sub>c</sub>(100 / σ′<sub>v0</sub>)<sup>0.67</sup>.' },
				{ label: 'PLAXIS 2D 2018 Reference Manual', detail: 'Reference manual showing the broad CUR 3 layers classification chart with Sand, Silt, Clay, and Peat fields.' }
			]
		},
		{
			title: 'PLAXIS Software Workflows',
			items: [
				{ label: 'PLAXIS 2D Material Models Manual (2025.1)', detail: 'Official material-model manual giving the Mohr-Coulomb Young’s modulus guidance and Hooke-law stiffness relations.' },
				{ label: 'Bentley KB0109063', detail: 'How to define and edit a material via the command line; documents the supported soilmat workflow.' },
				{ label: 'Bentley KB0109071', detail: 'PLAXIS soil model numbers for command-line material creation.' },
				{ label: 'Bentley KB0043470', detail: 'Re-using materials from other projects in PLAXIS, including project-to-database workflows.' },
				{ label: 'Bentley KB0108936', detail: 'Material parameter datasets article whose sample package shows modern .matXdb content on disk.' }
			]
		},
		{
			title: 'Constitutive Models and Hydraulic Conductivity',
			items: [
				{ label: 'Schanz, Vermeer & Bonnier (1999)', detail: 'The Hardening Soil model: formulation and stress-dependent stiffness basis.' },
				{ label: 'OVAM / I-RA-11461 (2002)', detail: 'Indicative hydraulic conductivity ranges by Belgian texture class.' },
				{ label: 'De Smedt / VUB (2005)', detail: 'Indicative hydraulic conductivity ranges by USDA texture class.' }
			]
		},
		{
			title: 'Classic Theoretical References',
			items: [
				{ label: 'Boussinesq (1885)', detail: 'Application des potentiels à l’étude de l’équilibre et du mouvement des solides élastiques.' },
				{ label: 'Newmark (1935)', detail: 'Simplified computation of vertical pressures in elastic foundations.' },
				{ label: 'Fadum (1948)', detail: 'Influence values for estimating stresses in elastic foundations.' },
				{ label: 'Dupuit (1863)', detail: 'Études théoriques et pratiques sur le mouvement des eaux.' },
				{ label: 'Thiem (1906)', detail: 'Hydrologische Methoden.' },
				{ label: 'Bear (1979)', detail: 'Hydraulics of Groundwater.' },
				{ label: 'Freeze & Cherry (1979)', detail: 'Groundwater.' },
				{ label: 'Kyrieleis & Sichardt (1930)', detail: 'Grundwasserabsenkung bei Fundierungsarbeiten.' },
				{ label: 'Louwyck et al. (2022)', detail: 'The Radius of Influence Myth. Water, 14(2), 149.' },
				{ label: 'Powers et al. (2007)', detail: 'Construction Dewatering and Groundwater Control, 3rd ed.' }
			]
		},
		{
			title: 'Foundation Models',
			items: [
				{ label: 'Hetényi (1946)', detail: 'Beams on Elastic Foundation.' },
				{ label: 'Vesić (1961a)', detail: 'Bending of beams resting on isotropic elastic solid.' },
				{ label: 'Vesić (1961b)', detail: 'Beams on elastic subgrade and Winkler’s hypothesis.' },
				{ label: 'Pasternak (1954)', detail: 'On a New Method of Analysis of an Elastic Foundation by Means of Two Foundation Constants.' },
				{ label: 'Kerr (1964)', detail: 'Elastic and viscoelastic foundation models.' }
			]
		}
	];

	const sections: DocSection[] = [
		{
			id: 'scope',
			title: '0A. Scope And Document Basis',
			intro:
				'This page documents the technical logic of the CPT interpreter from raw GEF import through Stage 6 engineering use. It is written as a theory-and-implementation note: formulas, classifications, parameter routes, engineering assumptions, and the principal references behind the current application.',
			subsections: [
				{
					id: 'scope-applications',
					title: '0A.1 Coverage',
					paragraphs: [
						'The documentation covers the current implemented workflow: GEF parsing, per-point CPT classification, layer detection, layer parameter assignment, stiffness derivation, experimental m-fitting, and the Stage 6 engineering applications.',
						'Where the application contains an engineering simplification, the simplification is stated explicitly. The purpose is not to replace engineering judgement, but to make the implemented mathematics auditable and readable.'
					],
					bullets: [
						'Classification and boundary logic are documented separately from parameter assignment.',
						'Stage 6 uses the interpreted CPT state produced by the earlier stages rather than reclassifying the profile independently.',
						'The notation below follows geotechnical convention with compression positive and depth measured downward.'
					]
				},
				{
					id: 'scope-inputs',
					title: '0A.2 Layer quantities carried into engineering use',
					paragraphs: [
						'Per interpreted layer, the application carries the quantities needed by the engineering modules: top and bottom depth, γ and γ<sub>sat</sub>, φ′, c′, c<sub>u</sub>, E<sub>oed,ref</sub>, E<sub>oed,i</sub>, E<sub>50,ref</sub>, E<sub>ur,ref</sub>, m, K<sub>0,nc</sub>, ν<sub>ur</sub>, k<sub>h</sub>, and k<sub>v</sub>.',
						'Geometry, load combination, hydraulic scenario, and optional Stage 5 tuning are then applied on top of those layer values.'
					]
				}
			],
			references: ['EN 1997-1:2004+A1:2013', 'NBN EN 1997-1 ANB:2022']
		},
		{
			id: 'stage1',
			title: '1. Stage 1 — GEF File Loading',
			intro:
				'The first stage reconstructs a usable CPT dataset from the GEF headers and data rows. The logic is header-driven rather than position-driven: physical quantities are mapped from quantity IDs, then converted and filtered into a consistent working dataset.',
			subsections: [
				{
					id: 'stage1-mapping',
					title: '1.1 Column mapping and physical quantities',
					paragraphs: [
						'GEF files declare their physical quantities through <code>#COLUMNINFO</code> lines. The application reads the quantity identifier and maps it to the relevant column index; column order is therefore never assumed.',
						'If both penetration length and corrected depth are present, corrected depth takes priority. This avoids using an uncorrected depth trace when the file already carries the corrected penetration geometry.'
					],
					bullets: [
						'Quantity 1: penetration length.',
						'Quantity 2: q<sub>c</sub>.',
						'Quantity 3: f<sub>s</sub>.',
						'Quantity 4: R<sub>f</sub>.',
						'Quantity 6: u<sub>2</sub>.',
						'Quantity 11: corrected depth.'
					]
				},
				{
					id: 'stage1-units',
					title: '1.2 Unit conversion and row filtering',
					paragraphs: [
						'The parser converts q<sub>c</sub> and f<sub>s</sub> to MPa based on the declared GEF unit string. If the unit declaration is absent or ambiguous, a heuristic fallback is used so the file remains workable.',
						'Rows are removed when they clearly do not represent meaningful CPT measurements, namely negative depths, values before cone engagement, or all-zero terminal rows.'
					],
					equations: [
						'R<sub>f</sub> = |f<sub>s</sub>| / q<sub>c</sub> · 100 &nbsp;&nbsp; when R<sub>f</sub> is absent or invalid',
						'0 ≤ R<sub>f</sub> ≤ 20 &nbsp;&nbsp; after app-side clamping'
					],
					symbols: [
						{ term: 'q<sub>c</sub>', meaning: 'cone resistance [MPa]' },
						{ term: 'f<sub>s</sub>', meaning: 'sleeve friction [MPa]' },
						{ term: 'R<sub>f</sub>', meaning: 'friction ratio [%]' },
						{ term: 'u<sub>2</sub>', meaning: 'pore pressure behind the cone [MPa]' }
					],
					bullets: [
						'Rows with z < 0 are discarded.',
						'Rows with q<sub>c</sub> < 0.02 MPa are treated as cone-not-engaged and discarded.',
						'All-zero rows appended by logging software are discarded.'
					]
				},
				{
					id: 'stage1-water',
					title: '1.3 Water table, elevation, and header metadata',
					paragraphs: [
						'The phreatic level is first taken from the GEF measurement variables when available; otherwise a default depth below surface is assigned. The engineer may override this value at any time.',
						'Surface elevation is read from the ZID header or entered manually. When present, all depth values can be expressed relative to TAW as well as depth below surface.'
					],
					equations: ['z<sub>TAW</sub> = z<sub>surface</sub> − z'],
					symbols: [
						{ term: 'z<sub>TAW</sub>', meaning: 'elevation relative to TAW [m]' },
						{ term: 'z<sub>surface</sub>', meaning: 'surface elevation [m TAW]' },
						{ term: 'z', meaning: 'depth below surface [m]' }
					]
				}
			],
			references: []
		},
		{
			id: 'stage2',
			title: '2. Stage 2 — Classification',
			intro:
				'Classification is applied per CPT reading rather than per final layer. The result is a behavioural or code-based soil type sequence that later controls where layer boundaries fall.',
			subsections: [
				{
					id: 'stage2-robertson',
					title: '2.1 Robertson (1990) — normalized SBT / I<sub>c</sub>',
					paragraphs: [
						'The Robertson route uses a normalized q<sub>t</sub>–F<sub>r</sub> framework. Because final layer unit weights are not yet available at Stage 2, the app uses a preliminary stress estimate with fixed unsaturated and saturated unit weights.',
						'If pore pressure u<sub>2</sub> and net area ratio a are available, the cone resistance is corrected to q<sub>t</sub>; otherwise the measured q<sub>c</sub> is used directly.'
					],
					equations: [
						'σ<sub>v0</sub> = 17z &nbsp;&nbsp; above the water table',
						'σ<sub>v0</sub> = 17z<sub>w</sub> + 18(z − z<sub>w</sub>) &nbsp;&nbsp; below the water table',
						'u = 9.81 · max(0, z − z<sub>w</sub>)',
						"σ'<sub>v0</sub> = max(σ<sub>v0</sub> − u, 1)",
						'q<sub>t</sub> = q<sub>c</sub> + u<sub>2</sub>(1 − a)',
						'Q<sub>t</sub> = max(0.1, (q<sub>t</sub> − σ<sub>v0</sub>/1000) / (σ′<sub>v0</sub>/1000))',
						'F<sub>r</sub> = clamp(|f<sub>s,eff</sub> / (q<sub>t</sub> − σ<sub>v0</sub>/1000)| · 100, 0.1, 10)',
						'I<sub>c</sub> = √[(3.47 − log<sub>10</sub>Q<sub>t</sub>)<sup>2</sup> + (log<sub>10</sub>F<sub>r</sub> + 1.22)<sup>2</sup>]'
					],
					symbols: [
						{ term: 'a', meaning: 'net area ratio [-]' },
						{ term: 'q<sub>t</sub>', meaning: 'corrected cone resistance [MPa]' },
						{ term: 'f<sub>s,eff</sub>', meaning: 'effective sleeve friction used in normalization [MPa]' },
						{ term: 'Q<sub>t</sub>', meaning: 'normalized cone-resistance parameter [-]' },
						{ term: 'F<sub>r</sub>', meaning: 'normalized friction ratio [%]' },
						{ term: 'I<sub>c</sub>', meaning: 'soil behaviour type index [-]' }
					],
					bullets: [
						'The current app groups the normalized result into Gravel, Sand, Silty sand, Sandy clay, Clay, and Peat / organic.',
						'Sensitive fine-grained soil is not inferred separately from I<sub>c</sub> alone.'
					]
				},
				{
					id: 'stage2-robertson2016',
					title: '2.2 Robertson (2016) — iterative normalized SBT / Q<sub>tn</sub>',
					paragraphs: [
						'The Robertson 2016 route keeps the same broad SBT / I<sub>c</sub> family mapping as the earlier normalized Robertson workflow, but replaces the fixed-stress-exponent cone normalization with the iterative Q<sub>tn</sub> formulation. The stress exponent n varies with the inferred soil behaviour and is solved iteratively.',
						'This route may be preferred when the input is a CPTu, but the implementation does not require measured u<sub>2</sub>. If u<sub>2</sub> is absent, the app uses q<sub>t</sub> = q<sub>c</sub> in the same way as the Robertson 1990 fallback.'
					],
					equations: [
						'q<sub>t</sub> = q<sub>c</sub> + u<sub>2</sub>(1 − a)',
						'Q<sub>tn</sub> = ((q<sub>t</sub> · 1000 − σ<sub>v0</sub>) / p<sub>a</sub>) · (p<sub>a</sub> / σ′<sub>v0</sub>)<sup>n</sup>',
						'I<sub>c</sub> = √[(3.47 − log<sub>10</sub>Q<sub>tn</sub>)<sup>2</sup> + (log<sub>10</sub>F<sub>r</sub> + 1.22)<sup>2</sup>]',
						'n = clamp(0.381I<sub>c</sub> + 0.05σ′<sub>v0</sub> / p<sub>a</sub> − 0.15, 0.5, 1.0)'
					],
					symbols: [
						{ term: 'Q<sub>tn</sub>', meaning: 'stress-normalized cone-resistance parameter with variable exponent [-]' },
						{ term: 'n', meaning: 'stress exponent solved iteratively from soil behaviour [-]' },
						{ term: 'p<sub>a</sub>', meaning: 'atmospheric reference pressure = 100 kPa' }
					],
					bullets: [
						'The implementation reuses the existing broad app families: Gravel, Sand, Silty sand, Sandy clay, Clay, and Peat / organic.',
						'The displayed method metric is Q<sub>tn</sub>; the I<sub>c</sub> boundaries remain the same as the Robertson 1990 route.'
					]
				},
				{
					id: 'stage2-cur',
					title: '2.3 CUR 3 layers — broad q<sub>c</sub>–R<sub>f</sub> zoning',
					paragraphs: [
						'The CUR 3 layers route is implemented as a direct q<sub>c</sub>–R<sub>f</sub> zoning rule based on the published broad chart with four material fields: Sand, Silt, Clay, and Peat. It is a boundary-generation method, not a detailed parameter catalogue.',
						'The implementation follows the chart as nested zones checked from the most specific region to the broadest envelope: sand first, then silt, then clay, with peat as the remaining outside region.',
						'To keep the downstream parameter workflow stable, the chart field “Silt” is carried internally as the app’s intermediate family and tagged with the subtype marker <em>CUR3 silt</em>. The chart logic itself remains four-zoned.'
					],
					equations: [
						'R<sub>f</sub> &lt; 1.5 and q<sub>c</sub> ≥ 1.5 &nbsp;&nbsp; → &nbsp;&nbsp; Sand',
						'else if R<sub>f</sub> &lt; 2.5 and q<sub>c</sub> ≥ 0.5 &nbsp;&nbsp; → &nbsp;&nbsp; Silt field',
						'else if R<sub>f</sub> ≤ 5.0 and q<sub>c</sub> ≥ 0.2 &nbsp;&nbsp; → &nbsp;&nbsp; Clay',
						'else &nbsp;&nbsp; → &nbsp;&nbsp; Peat / organic'
					],
					symbols: [
						{ term: 'q<sub>c</sub>', meaning: 'measured cone resistance [MPa]' },
						{ term: 'R<sub>f</sub>', meaning: 'measured friction ratio [%]' }
					],
					bullets: [
						'This route is direct and non-normalized: no stress correction is applied to q<sub>c</sub> before classification.',
						'The current app uses this route for broad layer boundary logic; detailed geotechnical parameter assignment is still handled later by the Stage 3 parameter method.',
						'Internal mapping note: the chart field “Silt” is stored as the app’s intermediate type family so that later parameter and compatibility tables remain usable.'
					],
					figures: [
						{
							src: '/docs/cur3-layers-chart.png',
							alt: 'Published CUR 3 layers chart showing Sand, Silt, Clay, and Peat zones in qc-Rf space.',
							caption:
								'Published CUR 3 layers chart as used for the broad direct q<sub>c</sub>–R<sub>f</sub> zoning route. Source context: PLAXIS 2D 2018 Reference Manual.',
							collapsible: true,
							summary: 'Show published CUR 3 chart'
						}
					]
				},
				{
					id: 'stage2-nen',
					title: '2.4 NEN 6740 — stress-dependent material classification',
					paragraphs: [
						'NEN 6740 uses a stress-corrected cone resistance together with friction ratio. The source method is graphical: a semilog chart with fourteen material areas rather than a closed algebraic decision tree.',
						'The app therefore separates the method into two parts. First it evaluates the published stress correction documented in the Deltares D-SHEET Piling manual. Then it applies a transparent representative-area rule that selects the nearest material area from a digitized fourteen-material set.'
					],
					equations: [
						'q<sub>c,NEN</sub> = q<sub>c</sub> · (100 / σ′<sub>v0</sub>)<sup>0.67</sup>',
						's = log<sub>10</sub>(q<sub>c,NEN</sub>) − 0.34R<sub>f</sub>',
						'i = arg min<sub>j</sub> |s − s<sub>j</sub>|'
					],
					symbols: [
						{ term: 'q<sub>c,NEN</sub>', meaning: 'stress-corrected cone resistance used by the NEN chart [MPa]' },
						{ term: 'σ′<sub>v0</sub>', meaning: 'initial effective vertical stress at the CPT reading [kPa]' },
						{ term: 's', meaning: 'implemented chart-coordinate projection used for the representative-area search [-]' },
						{ term: 's<sub>j</sub>', meaning: 'projected coordinate of representative material area j [-]' }
					],
					bullets: [
						'The stress-correction equation with exponent 0.67 is part of the documented Deltares implementation of the published NEN route; the one-dimensional score projection is the app’s deterministic way of reproducing the graphical chart.',
						'The score coefficient magnitude 0.34 is not a normative NEN coefficient. It is the regression-fit semilog projection magnitude through the fourteen stored representative centres used by the app.',
						'The representative materials are: gravel, slightly silty, moderate; sand, clean, stiff; sand, slightly silty, moderate; sand, very silty, loose; loam, very sandy, stiff; loam, slightly sandy, weak; clay, very sandy, stiff; clay, slightly sandy, moderate; clay, clean, stiff; clay, clean, weak; clay, organic, moderate; clay, organic, weak; peat, moderately preloaded, moderate; peat, not preloaded, weak.',
						'The weakest transition remains the area-5/area-6 pair (loam, slightly sandy, weak versus clay, very sandy, stiff). Near ties are resolved by the fixed chart order of the stored representative set.',
						'A repo verification script re-projects all fourteen centres at several effective stresses to ensure the stored centres and the implemented score formula stay in sync.',
						'The selected NEN material is then mapped into the app’s internal type families so that later layer grouping and parameter workflows remain consistent.'
					],
					figures: [
						{
							src: '/docs/nen6740-chart.png',
							alt: 'Published NEN 6740 stress-dependent chart with fourteen material areas in corrected cone resistance and friction ratio space.',
							caption:
								'Published NEN 6740 stress-dependent classification chart with fourteen material areas. The app uses the documented stress correction from this method and a transparent representative-area implementation calibrated to the stored chart centres.',
							collapsible: true,
							summary: 'Show published NEN 6740 chart'
						}
					]
				},
				{
					id: 'stage2-ec7',
					title: '2.5 NEN Tabel 3 — direct subtype classification',
					paragraphs: [
						'The Table 3 route uses raw q<sub>c</sub> and R<sub>f</sub> and returns a detailed subtype together with the characteristic parameter row used later in the workflow. The direct source documented here is the implemented NEN Tabel 3 catalogue itself, not a separate Eurocode classification chart.',
						'Because the table contains overlapping q<sub>c</sub>–R<sub>f</sub> envelopes, the app evaluates the rows deterministically in table order rather than assuming the source is mutually exclusive. The implemented family order is grind, zand, leem, klei, then veen. Within each family, subrows are checked top-to-bottom, with q<sub>c</sub> lower bounds inclusive and upper bounds exclusive. For R<sub>f</sub>, the open bands R<sub>f</sub> &lt; 1 and R<sub>f</sub> &gt; 6 remain strict, while the bounded intervals are treated as closed.',
						'For this method, the raw boundary logic follows the detailed subtype result rather than only the broad family. This means subtype changes such as density or consistency transitions inside one family can create provisional layer boundaries before smart merge and minimum-thickness correction simplify them.'
					],
					symbols: [
						{ term: 'q<sub>c</sub>', meaning: 'measured cone resistance [MPa]' },
						{ term: 'R<sub>f</sub>', meaning: 'measured friction ratio [%]' },
						{ term: 'γ', meaning: 'unit weight above the phreatic level [kN/m³]' },
						{ term: 'γ<sub>sat</sub>', meaning: 'unit weight below the phreatic level [kN/m³]' },
						{ term: 'φ′', meaning: 'effective friction angle [°]' },
						{ term: 'c′', meaning: 'effective cohesion [kPa]' },
						{ term: 'c<sub>u</sub>', meaning: 'undrained shear strength [kPa]' }
					],
					bullets: [
						'If no table row matches, the app keeps a deterministic fallback so the workflow can continue, but that fallback is not itself part of Table 3.',
						'The app UI may still show a legacy “EC7” label because the later parameter workflow is Eurocode-aligned. The direct q<sub>c</sub>–R<sub>f</sub> table documented in this section is the implemented NEN Tabel 3 source.'
					],
					table: {
						caption:
							'Implemented NEN Tabel 3 rows used by the direct subtype classifier. The table below is rendered from the active subtype catalogue rather than shown as a synthetic chart.',
						note:
							'All q<sub>c</sub> limits are applied as lower-inclusive and upper-exclusive. For R<sub>f</sub>, the open conditions R<sub>f</sub> &lt; 1 and R<sub>f</sub> &gt; 6 remain strict; the bounded intervals are treated as closed.',
						columns: [
							{ key: 'family', label: 'Family' },
							{ key: 'subtype', label: 'Subtype' },
							{ key: 'qc', label: 'q<sub>c</sub> range [MPa]' },
							{ key: 'rf', label: 'R<sub>f</sub> range [%]' },
							{ key: 'gamma', label: 'γ [kN/m³]' },
							{ key: 'gammaSat', label: 'γ<sub>sat</sub> [kN/m³]' },
							{ key: 'phi', label: 'φ′ [°]' },
							{ key: 'c', label: 'c′ [kPa]' },
							{ key: 'cu', label: 'c<sub>u</sub> [kPa]' }
						],
						rows: nenTable3Rows
					}
				},
				{
					id: 'stage2-separation',
					title: '2.6 Classification versus parameter assignment',
					paragraphs: [
						'Stage 2 is boundary logic only. The classification method decides which soil type each CPT reading belongs to and therefore where soil-type changes occur with depth.',
						'Stage 3 parameter assignment is independent of the chosen classification route. A layer identified by Robertson, CUR 3 layers, or NEN 6740 may still be assigned a Eurocode Table 3 subtype and its associated γ, γ<sub>sat</sub>, φ′, c′, and c<sub>u</sub> values.'
					]
				}
			],
			references: [
				'Robertson (1990)',
				'Robertson (2016)',
				'Robertson & Wride (1998)',
				'PLAXIS 2D 2018 Reference Manual',
				'NEN 6740',
				'Deltares D-SHEET Piling User Manual',
				'SB260'
			]
		},
		{
			id: 'stage3',
			title: '3. Stage 3 — Layer Detection And Parameter Assignment',
			intro:
				'Once every CPT reading carries a classification label from the selected Stage 2 method, the app converts that pointwise sequence into engineering layers in four steps: raw segmentation, optional smart boundary reduction, final minimum-thickness enforcement, and recomputation of the final layer properties from the merged geometry.',
			subsections: [
				{
					id: 'stage3-boundaries',
						title: '3.1 Raw segmentation and boundary placement',
						paragraphs: [
							'The first pass creates provisional raw segments directly from the pointwise Stage 2 classification sequence. For Robertson, CUR 3 layers, and NEN 6740, the raw segment key is the broad internal soil family. For NEN Tabel 3, the raw segment key is the pair {type, subtype}, so detailed subtype changes can create provisional layer boundaries before later simplification.',
							'Boundary depths are then constructed from the retained CPT rows. The first raw segment starts at ground level. Other raw segments start at the midpoint between the last CPT row of the previous segment and the first CPT row of the new segment, unless a downward merge has already handed them an inherited top boundary. If that straddling sample pair is unavailable or degenerate, the app falls back to the legacy 20 mm offset from the first row of the new segment. Segment thickness is always evaluated on these active layer boundaries rather than on the bare difference between first and last CPT reading.'
						],
						equations: [
							'k<sub>row</sub> = type &nbsp;&nbsp; for Robertson, CUR 3 layers, and NEN 6740',
							'k<sub>row</sub> = type :: subtype &nbsp;&nbsp; for NEN Tabel 3',
							'z<sub>top</sub> = 0 &nbsp;&nbsp; for the first raw segment',
							'z<sub>top</sub> = 0.5(z<sub>last row,prev</sub> + z<sub>first row,curr</sub>) &nbsp;&nbsp; for a new raw segment without inherited top and with valid straddling samples',
							'z<sub>top</sub> = z<sub>first row,curr</sub> − 0.02 &nbsp;&nbsp; fallback when the straddling samples are unavailable or degenerate',
							'z<sub>bot</sub> = z<sub>last row</sub>',
							't = z<sub>bot</sub> − z<sub>top</sub>'
						],
						symbols: [
							{ term: 'k<sub>row</sub>', meaning: 'raw segmentation key used to decide whether two consecutive CPT rows belong to the same provisional segment [-]' },
							{ term: 'z<sub>last row,prev</sub>, z<sub>first row,curr</sub>', meaning: 'last retained CPT depth in the segment above and first retained CPT depth in the new segment [m]' },
							{ term: 'z<sub>top</sub>, z<sub>bot</sub>', meaning: 'active top and bottom boundary of one provisional segment [m]' },
							{ term: 't', meaning: 'segment thickness from the active layer boundaries [m]' }
						],
						bullets: [
							'This means the NEN Tabel 3 route is intrinsically finer than the other Stage 2 routes, because subtype transitions inside one soil family are preserved in the raw segmentation.',
							'NEN 6740 currently uses the internal family only for raw layer generation; its 14 detailed material labels remain available for interpretation but do not by themselves create raw boundaries.',
							'The midpoint rule is self-calibrating to the actual CPT logging step and remains bounded by construction between the two samples that straddle the raw boundary.',
							'For uniform 40 mm sampling, the midpoint rule collapses exactly to the earlier 20 mm offset.'
						]
					},
				{
					id: 'stage3-smart-merge',
					title: '3.1A Smart merge correction',
					paragraphs: [
						'The smart-merge correction is an in-house MADEP post-processing heuristic. It is not a published external classification standard or code method.',
						'The app also provides a smart-merge mode. This mode is applied only after the original raw layering has already been created from the unmodified point-by-point classification sequence.',
						'In smart mode, the algorithm first removes highly compatible existing boundaries when the continuity score exceeds a sensitivity-controlled threshold. Only after that reduction step does it enforce the minimum thickness by merging every remaining sub-minimum layer with its most similar neighbor.',
						'The resulting smart-merged configuration becomes the active layer model. Layer boundaries, per-layer averages, subtype suggestion, and downstream parameter assignment are recalculated from the final merged geometry.'
					],
					equations: [
						'S = 0.24S<sub>type</sub> + 0.20S<sub>qc</sub> + 0.14S<sub>Rf</sub> + 0.14S<sub>subtype</sub> + 0.12S<sub>param</sub> + 0.08S<sub>compat</sub> + 0.08S<sub>cont</sub> − P',
						'S<sub>qc</sub> = max(0, 1 − |ln(q<sub>c,a</sub>/q<sub>c,b</sub>)| / ln 3)',
						'S<sub>Rf</sub> = max(0, 1 − |R<sub>f,a</sub> − R<sub>f,b</sub>| / 3)',
						'ΔS<sub>min</sub> = max(0.02, 0.14 − 0.08λ)',
						'S<sub>pair</sub> = (S<sub>left→right</sub> + S<sub>right→left</sub>) / 2',
						'S<sub>crit</sub> = max(0.35, 0.90 − 0.275λ)',
						'merge upward if S<sub>up</sub> &gt; S<sub>down</sub> + ΔS<sub>min</sub>; merge downward if S<sub>down</sub> &gt; S<sub>up</sub> + ΔS<sub>min</sub>',
						'merge adjacent baseline layers if S<sub>pair</sub> ≥ S<sub>crit</sub>'
					],
					symbols: [
						{ term: 'S', meaning: 'neighbor-merge score for one candidate direction [-]' },
						{ term: 'S<sub>type</sub>', meaning: 'type-family agreement score [-]' },
						{ term: 'S<sub>qc</sub>', meaning: 'cone-resistance similarity score [-]' },
						{ term: 'S<sub>Rf</sub>', meaning: 'friction-ratio similarity score [-]' },
						{ term: 'S<sub>subtype</sub>', meaning: 'Eurocode subtype-group similarity score [-]' },
						{ term: 'S<sub>param</sub>', meaning: 'parameter similarity score using φ′, γ, c′, and where relevant c<sub>u</sub> [-]' },
						{ term: 'S<sub>compat</sub>', meaning: 'compatibility score between the CPT family and neighboring subtype group [-]' },
						{ term: 'S<sub>cont</sub>', meaning: 'continuity score against the outer layer beyond the immediate neighbor [-]' },
						{ term: 'P', meaning: 'penalty term for sharp transitions and critical marker layers [-]' },
						{ term: 'λ', meaning: 'smart-merge sensitivity slider in the range 0…6 [-]' },
						{ term: 'ΔS<sub>min</sub>', meaning: 'minimum score lead required for one direction to override the tie-break rule [-]' },
						{ term: 'S<sub>pair</sub>', meaning: 'symmetric compatibility score of one existing baseline boundary [-]' },
						{ term: 'S<sub>crit</sub>', meaning: 'minimum pair score required for a post-merge removal of an existing boundary [-]' }
					],
					bullets: [
						'The original boundary detection step is never redefined by smart merge; smart merge operates only after the base layering algorithm has already run.',
						'In smart mode, similarity-based reduction is applied before the final minimum-thickness enforcement. The minimum thickness therefore acts as the last hard constraint, not as the first distortion of the layering.',
						'Very thin sections are intentionally down-weighted in the resistance to merging: sliver layers receive a small merge bonus, and sharp-transition penalties are attenuated when the layer thickness is small relative to a fixed sliver reference. This early similarity reduction is therefore independent of the chosen minimum thickness.',
						'Low sensitivity keeps smart merge closer to the conservative baseline behavior; high sensitivity allows smaller continuity advantages to influence the merge direction and makes it easier to remove highly compatible boundaries. At the extreme right-hand end of the range, the smart pass becomes willing to absorb almost all remaining compatible boundaries before the minimum-thickness rule is applied.',
						'The final layer count is not strictly monotonic with the sensitivity value. Because minimum-thickness enforcement runs after the smart-merge pass, a higher sensitivity can change the topology of the intermediate layering in a way that later produces either fewer or more final layers than a lower sensitivity case.',
						'If the two candidate directions are nearly equal, the app resolves the tie by merging into the thicker neighboring layer; if the thicknesses are equal, upward merge is chosen.',
						'The penalty term reduces the score for large q<sub>c</sub> jumps, large R<sub>f</sub> jumps, peat/non-peat transitions, gravel/non-gravel transitions, and thin layers that act as critical markers such as very weak peat, very coarse gravel, very high R<sub>f</sub>, or extreme q<sub>c</sub>.'
					]
				},
				{
					id: 'stage3-min-thk',
					title: '3.1B Minimum-thickness enforcement',
					paragraphs: [
						'The minimum layer thickness remains the final hard constraint on the smart-merge chain. In baseline mode, it is enforced directly by repeated upward merging. In smart mode, it is enforced only after the similarity-based boundary reduction described above.',
						'In smart mode, each remaining sub-minimum layer is merged with the more similar neighboring layer according to the directional score.'
					],
					equations: [
						'if t &lt; t<sub>min</sub>, merge the segment',
						'baseline mode: merge upward',
						'smart mode: merge toward the neighbor with the higher directional similarity score'
					],
					symbols: [
						{ term: 't<sub>min</sub>', meaning: 'minimum retained layer thickness [m]' }
					],
					bullets: [
						'This means the minimum-thickness setting does not control the early smart-similarity reduction itself; it only controls the last mandatory cleanup step.',
						'As a result, low t<sub>min</sub> preserves more of the similarity-reduced layering, while high t<sub>min</sub> forces stronger final consolidation of the remaining thin layers.'
					]
				},
				{
					id: 'stage3-usage',
					title: '3.1C Intended engineer workflow',
					paragraphs: [
						'The intended use of the layering controls is sequential. First select the Stage 2 classification method that best represents the CPT behaviour for the project. That method defines the provisional pointwise geology and therefore the raw segment sequence.',
						'Then use smart merge to remove boundaries that are judged highly compatible in the context of the surrounding profile. Only after that should the minimum thickness be used as the final hard cleanup rule for layers that remain too thin to retain.',
						'The minimum-thickness setting is therefore not intended to replace the geological interpretation performed by the selected classification method or by the smart-merge pass. It is the final practical consolidation rule applied after those interpretation steps.'
					],
					bullets: [
						'Choose the classification method first; it defines the raw boundaries that everything else works from.',
						'Use smart merge to smooth obviously over-segmented or highly compatible boundaries, not to force an arbitrary target layer count.',
						'Use minimum thickness last to eliminate remaining thin layers that are still impractical after the similarity-based cleanup.',
						'After every change, review the resulting boundaries against the q<sub>c</sub> and R<sub>f</sub> trends rather than judging only by the final number of layers.'
					]
				},
				{
					id: 'stage3-statistics',
					title: '3.2 Final layer statistics and boundary continuity',
					paragraphs: [
						'After the final merged geometry is fixed, the app recomputes each layer summary from the merged CPT rows. Mean q<sub>c</sub>, mean f<sub>s</sub>, and mean R<sub>f</sub> are taken over the valid CPT rows inside the final segment. The representative subtype string is the modal subtype within that final row set.',
						'The final layer table is then rebuilt with continuous boundaries: each layer top is taken from the previous final layer bottom, and each layer bottom is forced not to lie above its own top. These recomputed averages are the Stage 4 input for stiffness and conductivity derivation.'
					],
					equations: [
						'avg q<sub>c</sub> = mean(q<sub>c,j</sub>)',
						'avg f<sub>s</sub> = mean(f<sub>s,j</sub>)',
						'avg R<sub>f</sub> = mean(R<sub>f,j</sub>)',
						'z<sub>top,i</sub> = z<sub>bot,i−1</sub>',
						'z<sub>bot,i</sub> = max(z<sub>top,i</sub>, z<sub>bot,sum,i</sub>)'
					],
					symbols: [
						{ term: 'q<sub>c,j</sub>, f<sub>s,j</sub>, R<sub>f,j</sub>', meaning: 'valid CPT point values inside one final merged segment' },
						{ term: 'z<sub>bot,sum,i</sub>', meaning: 'bottom depth obtained from the merged-segment summary before final continuity enforcement [m]' }
					],
					bullets: [
						'Rows with q<sub>c</sub> ≤ 0.02 MPa are excluded from the averages when possible; if that would leave no rows, the full segment row set is used as fallback.',
						'So every time the merging changes, the boundaries and the engineering averages are recalculated consistently from the new merged geometry.'
					]
				},
				{
					id: 'stage3-parameters',
					title: '3.3 Subtype suggestion and parameter assignment',
					paragraphs: [
						'The final merged layer first inherits provisional parameters from the merged rows. For the NEN Tabel 3 classification route, the app can average the pointwise row parameters available from the table-matched CPT rows. For the other classification routes, it falls back initially to the generic family defaults.',
						'After that, the app auto-suggests the best Eurocode Table 3 subtype from the catalogue using the final layer average q<sub>c</sub>, average R<sub>f</sub>, and the compatibility matrix of the CPT family. If the active Stage 3 parameter method is the Eurocode Table 3 route, the suggested subtype also supplies the layer parameters. All assigned values remain editable, and manual overrides always take precedence over automatic assignment.'
					],
					equations: [
						'γ = mean(γ<sub>row</sub>)',
						'γ<sub>sat</sub> = mean(γ<sub>sat,row</sub>)',
						'φ′ = round(mean(φ′<sub>row</sub>))',
						'c′ = round(mean(c′<sub>row</sub>))',
						'c<sub>u</sub> = round(mean(c<sub>u,row</sub>))'
					],
					symbols: [
						{ term: 'γ, γ<sub>sat</sub>', meaning: 'unsaturated and saturated unit weight [kN/m³]' },
						{ term: 'φ′', meaning: 'effective friction angle [degrees]' },
						{ term: 'c′', meaning: 'effective cohesion [kPa]' },
						{ term: 'c<sub>u</sub>', meaning: 'undrained shear strength [kPa]' }
					],
					bullets: [
						'The suggested Eurocode subtype is selected from the full catalogue by compatibility first and q<sub>c</sub>/R<sub>f</sub> fit second.',
						'The final layer warnings below the table are then derived from the chosen subtype versus the CPT-family compatibility matrix, so the engineer can still see when a selected subtype lies only in an adjacent transition family.'
					]
				},
				{
					id: 'stage3-plaxis-export',
					title: '3.4 PLAXIS simulated CPT export',
					paragraphs: [
						'Stage 3 can export the active interpreted layer model as a measurement-style CPT text file for PLAXIS. The goal is to reproduce the final interpreted layering exactly, not to retain the original pointwise cone variability.',
						'The export reuses the original CPT depth rows and coordinates. For each original depth, the app finds the active final layer and writes that layer&apos;s representative values back as a synthetic CPT row. The result is therefore piecewise constant per interpreted layer, but sampled at the original CPT spacing.'
					],
					equations: [
						'q<sub>c,export</sub>(z<sub>j</sub>) = avg q<sub>c</sub>(layer(z<sub>j</sub>))',
						'f<sub>s,export</sub>(z<sub>j</sub>) = avg f<sub>s</sub>(layer(z<sub>j</sub>))',
						'f<sub>s,export</sub>(z<sub>j</sub>) = avg q<sub>c</sub>(layer(z<sub>j</sub>)) · avg R<sub>f</sub>(layer(z<sub>j</sub>)) / 100 &nbsp;&nbsp; fallback when avg f<sub>s</sub> is missing'
					],
					bullets: [
						'The header contains X[m], Y[m], Z[m], followed by a D[m] Q[MPa] F[MPa] x table.',
						'One exported row is written for every original CPT depth row, so the synthetic file remains aligned with the measured depth sampling.',
						'The final x column is currently written as 0, so the exported file behaves as a PLAXIS-compatible CPT with depth, cone resistance, and sleeve friction.'
					]
				}
			],
			references: ['EN 1997-1:2004+A1:2013', 'CUR 2003-7']
		},
		{
			id: 'stage4',
			title: '4. Stage 4 — Model Parameters',
			intro:
				'Stage 4 transforms the interpreted CPT layer into constitutive parameters for stiffness-based engineering use. The key tasks are effective-stress reconstruction, q<sub>c</sub>-to-stiffness correlation, reference-stress correction, derivation of auxiliary parameters such as K<sub>0,nc</sub>, ν<sub>ur</sub>, and hydraulic conductivity, and preparation of export-ready PLAXIS material data.',
			subsections: [
				{
					id: 'stage4-stress',
					title: '4.1 Effective stress at layer midpoint',
					paragraphs: [
						'Both model-parameter routes use the effective vertical stress at layer midpoint. The phreatic level therefore directly affects the reference stiffness correction.',
						'Above the water table, γ is used; below it, γ<sub>sat</sub> is used. Pore pressure is hydrostatic.'
					],
					equations: [
						'z<sub>mid</sub> = (z<sub>top</sub> + z<sub>bot</sub>) / 2',
						'σ<sub>v0</sub> = γz<sub>mid</sub> &nbsp;&nbsp; for z<sub>mid</sub> ≤ z<sub>w</sub>',
						'σ<sub>v0</sub> = γz<sub>w</sub> + γ<sub>sat</sub>(z<sub>mid</sub> − z<sub>w</sub>) &nbsp;&nbsp; for z<sub>mid</sub> &gt; z<sub>w</sub>',
						'u = 9.81 · max(0, z<sub>mid</sub> − z<sub>w</sub>)',
						"σ′<sub>v0</sub> = max(σ<sub>v0</sub> − u, 1)"
					],
					symbols: [
						{ term: 'z<sub>mid</sub>', meaning: 'layer midpoint depth [m]' },
						{ term: 'z<sub>top</sub>, z<sub>bot</sub>', meaning: 'layer top and bottom depth [m]' },
						{ term: 'z<sub>w</sub>', meaning: 'water-table depth below surface [m]' },
						{ term: 'σ<sub>v0</sub>', meaning: 'initial total vertical stress [kPa]' },
						{ term: 'σ′<sub>v0</sub>', meaning: 'initial effective vertical stress [kPa]' }
					]
				},
				{
					id: 'stage4-alpha',
					title: '4.2 q<sub>c</sub>-to-E<sub>oed,i</sub> correlation and α methods',
					paragraphs: [
						'The first stiffness step converts the representative cone resistance into an oedometric modulus through the Sanglerat or SB260 α correlation.',
						'Method A uses a fixed α per behavioural soil type. Method B uses the selected NEN Tabel 3 family and then applies the SB260 family-specific q<sub>c</sub> rules.',
						'The full implemented α mapping is shown in the expandable reference table below so the reader can audit exactly which family, q<sub>c</sub> band, or modulus formula is applied.'
					],
					equations: [
						'E<sub>oed,i</sub> = α · avg q<sub>c</sub> · 1000',
						'α = 5, 3, 1.5 &nbsp;&nbsp; for klei with q<sub>c</sub> &lt; 0.7, 0.7–2.0, ≥ 2.0 MPa',
						'α = 4 or 2 &nbsp;&nbsp; for leem below or above q<sub>c</sub> = 2.0 MPa',
						'E<sub>s</sub> = 4q<sub>c</sub> − 5 &nbsp;&nbsp; for SB260 overgangsgronden with 2.5 &lt; q<sub>c</sub> &lt; 5.0 MPa',
						'E<sub>s</sub> = 4q<sub>c</sub>, &nbsp; 2q<sub>c</sub> + 20, &nbsp; 120 &nbsp;&nbsp; for zandgronden over the SB260 q<sub>c</sub> ranges'
					],
					symbols: [
						{ term: 'α', meaning: 'Sanglerat / SB260 stiffness correlation factor [-]' },
						{ term: 'avg q<sub>c</sub>', meaning: 'mean cone resistance of the layer [MPa]' },
						{ term: 'E<sub>oed,i</sub>', meaning: 'CPT-derived oedometric stiffness before reference-stress correction [kPa]' }
					],
					bullets: [
						'For peat, water content w is not available in the app, so the SB260 default α = 1.5 is used.',
						'Transition soils are mapped from the selected EC7 subtype rather than from q<sub>c</sub> and R<sub>f</sub> alone.'
					],
					table: {
						caption:
							'Implemented α-reference table used by the current stiffness correlation logic for Method A and Method B.',
						note:
							'Method A is a behavioural-type default route. Method B is the SB260 family mapping currently driven by the selected NEN Tabel 3 subtype family in the app.',
						collapsible: true,
						summary: 'Show implemented α reference table',
						columns: [
							{ key: 'method', label: 'Method' },
							{ key: 'family', label: 'Family' },
							{ key: 'soil', label: 'Soil / subtype mapping' },
							{ key: 'qc', label: 'q<sub>c</sub> range [MPa]' },
							{ key: 'rule', label: 'Rule' },
							{ key: 'expression', label: 'Applied α or modulus relation' }
						],
						rows: alphaMethodRows
					}
				},
				{
					id: 'stage4-method-a',
					title: '4.3 Method A — CUR 2003-7 ratios',
					paragraphs: [
						'Method A applies a type-default stress exponent m and then corrects E<sub>oed,i</sub> to the reference stress p<sub>ref</sub> with the full cohesion-corrected Hardening Soil expression. E<sub>50,ref</sub> follows the CUR ratio rule and E<sub>ur,ref</sub> is taken as three times E<sub>50,ref</sub>.',
						'For cohesive soils, E<sub>50,ref</sub> is larger than E<sub>oed,ref</sub>; for granular soils they are set equal.'
					],
					equations: [
						"E<sub>oed,ref</sub> = E<sub>oed,i</sub> · [(p<sub>ref</sub> + c′cotφ′)/(σ′<sub>v0</sub> + c′cotφ′)]<sup>m</sup>",
						'E<sub>50,ref</sub> = E<sub>oed,ref</sub> &nbsp;&nbsp; granular soils',
						'E<sub>50,ref</sub> = 1.25E<sub>oed,ref</sub> &nbsp;&nbsp; cohesive soils',
						'E<sub>ur,ref</sub> = 3E<sub>50,ref</sub>',
						'K<sub>0,nc</sub> = 1 − sinφ′'
					],
					symbols: [
						{ term: 'E<sub>oed,ref</sub>', meaning: 'reference oedometric stiffness at p<sub>ref</sub> [kPa]' },
						{ term: 'E<sub>50,ref</sub>', meaning: 'reference secant stiffness for primary loading [kPa]' },
						{ term: 'E<sub>ur,ref</sub>', meaning: 'reference unloading/reloading stiffness [kPa]' },
						{ term: 'K<sub>0,nc</sub>', meaning: 'at-rest earth-pressure coefficient for normally consolidated state [-]' }
					]
				},
				{
					id: 'stage4-method-b',
					title: '4.4 Method B — E<sub>50,ref</sub> = E<sub>oed,ref</sub>',
					paragraphs: [
						'Method B uses the same E<sub>oed,i</sub> and reference-stress correction, but then sets E<sub>50,ref</sub> equal to E<sub>oed,ref</sub> for all soils. E<sub>ur,ref</sub> remains three times the selected E<sub>50,ref</sub>.',
						'This gives a single consistent reference stiffness and is sometimes preferred in practice when the engineer wants to avoid the cohesive-soil E<sub>50</sub>/E<sub>oed</sub> split.'
					],
					equations: [
						'E<sub>50,ref</sub> = E<sub>oed,ref</sub>',
						'E<sub>ur,ref</sub> = 3E<sub>oed,ref</sub>'
					]
				},
				{
					id: 'stage4-conductivity',
					title: '4.5 Hydraulic conductivity basis',
					paragraphs: [
						'The app uses indicative hydraulic conductivity values tied to Belgian and USDA-style texture classes, with OVAM and De Smedt as the principal reference sources. The representative value is treated as a geometric-mean estimate within the adopted class range rather than a deterministic measurement.',
						'Anisotropy is then introduced through a k<sub>h</sub>/k<sub>v</sub> ratio: isotropic for coarse granular soils, higher horizontal-than-vertical conductivity for fine-grained and layered soils.',
						'For the PLAXIS material-command export, the internally stored conductivities are converted from m/s to m/day before they are written to the command file.'
					],
					equations: [
						'k<sub>h,rep</sub> = √(k<sub>h,min</sub>k<sub>h,max</sub>)',
						'k<sub>v</sub> = k<sub>h</sub> / a<sub>kv</sub>',
						'k<sub>PLAXIS</sub> = 86400 · k<sub>app</sub>'
					],
					symbols: [
						{ term: 'k<sub>h,rep</sub>', meaning: 'representative horizontal conductivity [m/s]' },
						{ term: 'k<sub>h,min</sub>, k<sub>h,max</sub>', meaning: 'adopted conductivity range [m/s]' },
						{ term: 'a<sub>kv</sub>', meaning: 'anisotropy ratio k<sub>h</sub> / k<sub>v</sub> [-]' },
						{ term: 'k<sub>v</sub>', meaning: 'vertical conductivity [m/s]' },
						{ term: 'k<sub>PLAXIS</sub>', meaning: 'conductivity written to the PLAXIS command export [m/day]' }
					],
					bullets: [
						'Indicative anisotropy in the current logic is 1 for sand and gravel, and 3 for clay, loam, silty soils, and peat.',
						'In-situ measurement takes priority over indicative table values.'
					]
				},
				{
					id: 'stage4-plaxis-export',
					title: '4.6 PLAXIS material-command export',
					paragraphs: [
						'Stage 4 includes a dedicated PLAXIS material export in addition to the CSV layer table. The implemented export writes a text file containing supported soilmat commands, not a directly generated native .matXdb database.',
						'That choice is deliberate: in the modern PLAXIS workflow the app reliably creates project materials through command-line material creation, after which the engineer can copy those project materials into a reusable global material database from inside PLAXIS if desired.',
						'For every interpreted layer, the export writes two material definitions: one Mohr-Coulomb material and one Hardening Soil material.'
					],
					equations: [
						'name = safe(CPT id) + "_L" + i + "_" + safe(subtype) + "_MC/HS"',
						'DrainageType = Undrained A &nbsp;&nbsp; if the subtype contains (lh), (kh), or equivalent fines-bearing wording',
						'DrainageType = Drained &nbsp;&nbsp; only for clean Sand and clean Gravel',
						'E<sub>Ref</sub> = E<sub>50,i</sub> &nbsp;&nbsp; for the Mohr-Coulomb export',
						'c<sub>ref</sub> = max(c′, 0.1)'
					],
					bullets: [
						'Mohr-Coulomb export writes Identification, SoilModel = 2, DrainageType, gammaUnsat, gammaSat, ERef, nu, cRef, phi, psi, PermHorizontalPrimary, and PermVertical.',
						'Hardening Soil export writes Identification, SoilModel = 3, DrainageType, gammaUnsat, gammaSat, E50Ref, EOedRef, EURRef, PowerM, pRef = 100, cRef, phi, psi, PermHorizontalPrimary, and PermVertical.',
						'For the MC material, ERef follows the current-stress loading stiffness E50,i from the selected Stage 4 stiffness route rather than the Hardening Soil reference-stress quantity E50Ref.',
						'Method A gives E50,i = 1.25 EOed,i for Clay, Soft clay, and Peat / organic, and E50,i = EOed,i for the other soils. Method B gives E50,i = EOed,i for all soils.',
						'Only clean sand and clean gravel are exported as Drained by default. Fines-bearing granular subtypes such as zand (lh) and grind (kh) are exported as Undrained A.',
						'The export intentionally omits RF, nuUR, and K0NC in the current tested PLAXIS workflow so PLAXIS can keep those automatic or read-only values under its own control.',
						'cu and psi_unsat are not written by the material-command export. Undrained A uses the effective stress strength parameters, and psi_unsat remains available in the app without yet being exported.'
					]
				}
			],
			references: ['SB260', 'CUR 2003-7', 'Schanz, Vermeer & Bonnier (1999)', 'OVAM / I-RA-11461 (2002)', 'De Smedt / VUB (2005)', 'PLAXIS 2D Material Models Manual (2025.1)', 'Bentley KB0109063', 'Bentley KB0109071', 'Bentley KB0043470', 'Bentley KB0108936']
		},
		{
			id: 'stage5',
			title: '5. Stage 5 — Experimental m-Fitting',
			intro:
				'Stage 5 adds a layer-wise experimental fitting routine for the Hardening Soil stress exponent m. The fitted result is never applied automatically: the engineer previews the fit, may tweak the candidate value, and explicitly accepts or rejects the override per layer.',
			subsections: [
				{
					id: 'stage5-basis',
					title: '5.1 Log-linear basis of the fit',
					paragraphs: [
						'The oedometer law of the Hardening Soil model becomes linear in logarithmic form. This allows the app to fit a straight line to the pointwise CPT-derived E<sub>oed,i</sub> values inside one layer.',
						'The fitted slope is interpreted directly as m, while the fitted intercept gives E<sub>oed,ref</sub>.'
					],
					equations: [
						"E<sub>oed</sub>(z) = E<sub>oed,ref</sub> · [(σ′<sub>v0</sub>(z) + c′cotφ′)/(p<sub>ref</sub> + c′cotφ′)]<sup>m</sup>",
						'X<sub>j</sub> = ln[(σ′<sub>v0</sub>(z<sub>j</sub>) + c′cotφ′)/(p<sub>ref</sub> + c′cotφ′)]',
						'Y<sub>j</sub> = ln[E<sub>oed,i</sub>(z<sub>j</sub>)]',
						'Y<sub>j</sub> = a + mX<sub>j</sub>'
					],
					symbols: [
						{ term: 'X<sub>j</sub>, Y<sub>j</sub>', meaning: 'log-transformed stress-ratio and stiffness points for CPT point j' },
						{ term: 'a', meaning: 'intercept of the regression line; exp(a) = E<sub>oed,ref</sub>' }
					]
				},
				{
					id: 'stage5-ols',
					title: '5.2 OLS solution, fit quality, and acceptance',
					paragraphs: [
						'The regression is performed on all valid CPT points inside the layer, using the current α method and the current water table. The resulting m is clamped to the engineering range used by the app, and the fit quality is reported in log space.',
						'The current interface shows the default line, the fitted line, and the point cloud; the engineer may still adjust the previewed m before acceptance.'
					],
					equations: [
						'm<sub>fit</sub> = cov(X, Y) / var(X)',
						'E<sub>oed,ref,fit</sub> = exp(mean(Y) − m<sub>fit</sub>mean(X))',
						'R<sup>2</sup> = 1 − SS<sub>res</sub> / SS<sub>tot</sub>'
					],
					symbols: [
						{ term: 'm<sub>fit</sub>', meaning: 'fitted stress exponent before engineering acceptance [-]' },
						{ term: 'E<sub>oed,ref,fit</sub>', meaning: 'fitted reference oedometric stiffness [kPa]' },
						{ term: 'R²', meaning: 'coefficient of determination in log space [-]' }
					],
					bullets: [
						'The fit is experimental and remains an engineer preview.',
						'm is expected to remain between 0 and 1 in normal interpretation, even though the raw regression may suggest otherwise.',
						'Accepting the fit overrides m only; the reference stiffness is then recomputed from the accepted m.'
					]
				}
			],
			references: ['Schanz, Vermeer & Bonnier (1999)', 'CUR 2003-7', 'SB260']
		},
		{
			id: 'conventions',
			title: '6. Global Engineering Conventions',
			intro:
				'The Stage 6 calculations share one common stress and stiffness basis. The equations below define the sign convention, the in-situ stress profile, the Hardening Soil reference-stress convention, and the general profile discretisation logic used by the engineering applications.',
			subsections: [
				{
					id: 'conventions-sign',
						title: '6.1 Sign convention and in-situ stresses',
						paragraphs: [
							'Compression is taken as positive. Depth z is measured downward from ground level. Elevation values are interpreted in Belgian TAW convention where relevant.',
							'The in-situ effective-stress profile is reconstructed from the active groundwater level and the interpreted unit weights.'
						],
						equations: [
							'u(z) = γ<sub>w</sub> · max(0, z − z<sub>w</sub>)',
							'σ<sub>v</sub>(z) = Σ γ<sub>i</sub> · Δz<sub>i</sub> &nbsp;&nbsp; with γ<sub>i</sub> = γ for z<sub>i</sub> ≤ z<sub>w</sub>, γ<sub>i</sub> = γ<sub>sat</sub> for z<sub>i</sub> &gt; z<sub>w</sub>',
							"σ′<sub>v</sub>(z) = σ<sub>v</sub>(z) − u(z)"
						],
						symbols: [
							{ term: 'z', meaning: 'depth below ground level [m]' },
							{ term: 'z<sub>w</sub>', meaning: 'phreatic level depth below ground [m]' },
							{ term: 'γ', meaning: 'unit weight above the phreatic level [kN/m³]' },
							{ term: 'γ<sub>sat</sub>', meaning: 'saturated unit weight below the phreatic level [kN/m³]' },
							{ term: 'γ<sub>w</sub>', meaning: 'unit weight of water [kN/m³]' },
							{ term: 'γ<sub>i</sub>', meaning: 'unit weight selected for layer contribution i according to its position relative to the phreatic level [kN/m³]' },
							{ term: 'Δz<sub>i</sub>', meaning: 'thickness contribution of layer i [m]' },
							{ term: 'u', meaning: 'pore pressure [kPa]' },
							{ term: 'σ<sub>v</sub>', meaning: 'total vertical stress [kPa]' },
							{ term: 'σ′<sub>v</sub>', meaning: 'effective vertical stress [kPa]' }
						],
						bullets: [
							'Above the phreatic level, the dry unit weight γ is used; below it, γ<sub>sat</sub> is used. Pore pressure u(z) = γ<sub>w</sub> · max(0, z − z<sub>w</sub>) is subtracted from σ<sub>v</sub>(z) to form σ′<sub>v</sub>(z).'
						]
					},
				{
					id: 'conventions-hs',
					title: '6.2 Hardening Soil reference-stress convention',
					paragraphs: [
						'Stage 6 uses the Stage 4/5 Hardening Soil stiffness convention. E<sub>oed,ref</sub> is referenced at p<sub>ref</sub> = 100 kPa and stress-dependent stiffness is recovered from the interpreted m-value and effective stress level.',
						'For the current settlement and dewatering routes, the governing stress is the vertical effective stress on the evaluated centreline.'
					],
					equations: [
						"E<sub>oed</sub>(σ′<sub>1</sub>) = E<sub>oed,ref</sub> · [(c′cotφ′ + σ′<sub>1</sub>)/(c′cotφ′ + p<sub>ref</sub>)]<sup>m</sup>",
						"E<sub>oed</sub>(σ′<sub>1</sub>) = E<sub>oed,ref</sub> · (σ′<sub>1</sub>/p<sub>ref</sub>)<sup>m</sup> &nbsp;&nbsp; for c′ = 0"
					],
					symbols: [
						{ term: 'E<sub>oed</sub>', meaning: 'oedometric stiffness modulus [kPa or MPa, used consistently]' },
						{ term: 'E<sub>oed,ref</sub>', meaning: 'reference oedometric stiffness at p<sub>ref</sub> [kPa or MPa]' },
						{ term: 'σ′<sub>1</sub>', meaning: 'effective major principal stress, taken here as vertical effective stress [kPa]' },
						{ term: 'c′', meaning: 'effective cohesion [kPa]' },
						{ term: 'φ′', meaning: 'effective friction angle [degrees]' },
						{ term: 'p<sub>ref</sub>', meaning: 'reference stress, here 100 kPa' },
						{ term: 'm', meaning: 'Hardening Soil stress exponent [-]' }
					]
				},
				{
					id: 'conventions-integration',
					title: '6.3 Integration and sublayering',
					paragraphs: [
						'The engineering calculations use stratification summation. The profile is divided into sublayers, stresses are evaluated at sublayer mid-depth, and settlement or stress changes are integrated over depth.',
						'The application keeps interpreted layer boundaries and phreatic boundaries explicit in the discretisation so stiffness and stress changes are not smeared across those interfaces.'
					]
				}
			],
			references: ['Terzaghi & Peck (1967)', 'Schanz, Vermeer & Bonnier (1999)']
		},
		{
			id: 'bearing',
			title: '7. Bearing Capacity',
			intro:
				'The bearing-capacity application is a shallow-foundation ULS screening tool. It evaluates drained and undrained soil resistance versus founding depth and applies Belgian DA1 handling on the strength side.',
			subsections: [
				{
					id: 'bearing-model',
					title: '7.1 Current implemented resistance model',
					paragraphs: [
						'The application computes drained and undrained ultimate resistance separately and converts those results to q<sub>d</sub> or q<sub>allow</sub> depending on the selected safety route.',
						'The underlying reference family is the Brinch Hansen / EC7 Annex D shallow-foundation format. The current app implements the vertical-load subset of that model: no horizontal load, no ground slope, and no base tilt. Eccentricity is only used to derive the effective dimensions for the shape-factor route.'
					],
						equations: [
							"q<sub>ult,d</sub> = c′N<sub>c</sub>s<sub>c</sub>d<sub>c</sub> + q′N<sub>q</sub>s<sub>q</sub>d<sub>q</sub> + 0.5γ′B′N<sub>γ</sub>s<sub>γ</sub>d<sub>γ</sub>",
							'q<sub>ult,u</sub> = q + 5.14c<sub>u</sub>s<sub>cu</sub>d<sub>cu</sub>',
							'N<sub>q</sub> = exp(πtanφ′) · tan<sup>2</sup>(45° + φ′/2)',
							'N<sub>c</sub> = (N<sub>q</sub> − 1) / tanφ′ &nbsp;&nbsp; for φ′ &gt; 0',
							'N<sub>c</sub> → 5.14 &nbsp;&nbsp; as φ′ → 0 (Prandtl limit, corresponds to 5.14c<sub>u</sub> in the undrained form)',
							'N<sub>γ</sub> = 2(N<sub>q</sub> − 1)tanφ′',
							'B′ = B − 2e<sub>B</sub>; &nbsp; L′ = L − 2e<sub>L</sub>',
						'r = B′ / L′ &nbsp;&nbsp; with B′ ≤ L′; strip uses r = 0',
						's<sub>q</sub> = 1 + r sinφ′',
						's<sub>c</sub> = (s<sub>q</sub>N<sub>q</sub> − 1) / (N<sub>q</sub> − 1) &nbsp;&nbsp; for φ′ > 0',
						's<sub>γ</sub> = max(0.6, 1 − 0.3r)',
						's<sub>cu</sub> = 1 + 0.2r',
						'Conservative shape mode: s<sub>q</sub> = s<sub>c</sub> = s<sub>γ</sub> = s<sub>cu</sub> = 1.0',
						'η = D<sub>f</sub> / B′; &nbsp; k = η for η ≤ 1, else k = atan(η)',
						'd<sub>q</sub> = 1 + 2tanφ′(1 − sinφ′)<sup>2</sup>k',
						'd<sub>c</sub> = d<sub>q</sub> − (1 − d<sub>q</sub>) / (N<sub>c</sub>tanφ′) &nbsp;&nbsp; for φ′ > 0',
						'd<sub>γ</sub> = 1.0; &nbsp; d<sub>cu</sub> = 1 + 0.4k',
						'ΔD<sub>f</sub> = clamp(maxDepth / 60, 0.10, 0.25) &nbsp;&nbsp; for the founding-depth sweep'
					],
					symbols: [
						{ term: 'q<sub>ult,d</sub>', meaning: 'ultimate drained bearing resistance [kPa]' },
						{ term: 'q<sub>ult,u</sub>', meaning: 'ultimate undrained bearing resistance [kPa]' },
						{ term: 'c′', meaning: 'effective cohesion [kPa]' },
						{ term: 'q′', meaning: 'effective surcharge at foundation depth [kPa]' },
						{ term: 'γ′', meaning: 'effective unit weight below the water table [kN/m³]' },
						{ term: 'B, L', meaning: 'entered footing width and length [m]' },
						{ term: 'e<sub>B</sub>, e<sub>L</sub>', meaning: 'load eccentricities used to derive B′ and L′ [m]' },
						{ term: 'B′, L′', meaning: 'effective dimensions used for the shape-factor route [m]' },
						{ term: 'c<sub>u</sub>', meaning: 'undrained shear strength [kPa]' },
						{ term: 'N<sub>c</sub>, N<sub>q</sub>, N<sub>γ</sub>', meaning: 'bearing-capacity factors [-]' },
						{ term: 's<sub>c</sub>, s<sub>q</sub>, s<sub>γ</sub>, s<sub>cu</sub>', meaning: 'shape factors [-]' },
						{ term: 'd<sub>c</sub>, d<sub>q</sub>, d<sub>γ</sub>, d<sub>cu</sub>', meaning: 'depth factors [-]' },
						{ term: 'r', meaning: 'effective plan ratio B′/L′ used for non-strip shape factors [-]' },
						{ term: 'k', meaning: 'depth-factor embedment parameter derived from D<sub>f</sub>/B′ [-]' }
					],
					bullets: [
							'The app now keeps the EC7 Annex D rough-base N<sub>γ</sub> = 2(N<sub>q</sub> − 1)tanφ′ formulation consistently. The earlier Vesić variant 2(N<sub>q</sub> + 1)tanφ′ is slightly larger; Annex D is now preferred here because Stage 6 is an EC7-oriented screening tool and the Annex D form is slightly more conservative and easier to audit against the code text.',
							'Shape factors now default to Brinch Hansen / Annex D values derived from the effective plan ratio r = B′/L′. Users can switch to a conservative mode with all shape factors fixed to 1.0.',
							'For circular footings screened through this rectangular interface, use B = L and keep e<sub>B</sub> = e<sub>L</sub> = 0 so r = 1.',
							'For φ′ = 0, the drained block collapses to the undrained Prandtl expression q<sub>ult,u</sub> = q + 5.14c<sub>u</sub>s<sub>cu</sub>d<sub>cu</sub>; the drained expression is therefore not evaluated in that limit.',
							'The bearing-depth envelope is sampled from the selected starting depth upward to the model bottom using a depth increment clamped between 0.10 m and 0.25 m.',
							'This remains a shallow-foundation screening model: full inclined/eccentric-load verification, sliding, ground-slope effects, base tilt, and the full three-case groundwater averaging rule for the N<sub>γ</sub> term are still outside the current app.'
					]
				},
				{
					id: 'bearing-belgium',
					title: '7.2 Belgian DA1 handling in the current app',
					paragraphs: [
						'For Belgian EC7 practice, the application evaluates DA1/1 with M1 soil strengths and DA1/2 with reduced M2 soil strengths. It then forms the governing drained and undrained envelopes separately.',
						'The current Stage 6 app is therefore a resistance-side Belgian screening tool rather than a full action-side ULS verification engine.'
					],
					equations: [
						'tanφ′<sub>d</sub> = tanφ′<sub>k</sub> / 1.25 &nbsp;&nbsp; (DA1/2)',
						'c′<sub>d</sub> = c′<sub>k</sub> / 1.25',
						'c<sub>u,d</sub> = c<sub>u,k</sub> / 1.40',
						'q<sub>d</sub> = q<sub>ult</sub> / γ<sub>Rd</sub>',
						'q<sub>allow</sub> = q<sub>ult</sub> / ξ'
					],
					symbols: [
						{ term: 'φ′<sub>k</sub>, c′<sub>k</sub>, c<sub>u,k</sub>', meaning: 'characteristic soil strengths' },
						{ term: 'φ′<sub>d</sub>, c′<sub>d</sub>, c<sub>u,d</sub>', meaning: 'design soil strengths' },
						{ term: 'γ<sub>Rd</sub>', meaning: 'resistance/model factor in the EC7 route [-]' },
						{ term: 'ξ', meaning: 'global system factor [-]' }
					],
					bullets: [
						'DA1/1 uses unfactored M1 soil strengths.',
						'DA1/2 uses reduced M2 soil strengths.',
						'The governing drained and undrained results are formed independently.'
					]
				}
			],
			references: ['EN 1997-1:2004+A1:2013', 'NBN EN 1997-1 ANB:2022', 'EN 1990:2002+A1:2005', 'NBN EN 1990 ANB:2005', 'Vesić (1975)', 'Terzaghi & Peck (1967)']
		},
		{
			id: 'dewatering',
			title: '8. Dewatering',
			intro:
				'The dewatering application is an SLS screening model coupling hydraulic drawdown with CPT-based effective-stress and settlement response at the CPT location.',
			subsections: [
				{
					id: 'dewatering-scope',
					title: '8.1 Scope and radius of influence',
					paragraphs: [
						'The hydraulic part of the module estimates drawdown at the CPT for a single well, an equivalent-radius excavation, or a line dewatering trench. The engineering deliverable is not the pumping rate alone, but the stress change and settlement induced at the CPT.',
						'The current app still uses Sichardt to screen the extent of influence. This remains explicitly a rule-of-thumb estimate rather than a rigorous groundwater-flow boundary.'
					],
					equations: ['R = C · s · √k<sub>eff,h</sub>'],
					symbols: [
						{ term: 'R', meaning: 'screened radius of influence [m]' },
						{ term: 'C', meaning: 'Sichardt coefficient [-]' },
						{ term: 's', meaning: 'drawdown at the source [m]' },
						{ term: 'k<sub>eff,h</sub>', meaning: 'equivalent horizontal conductivity [m/s]' }
					],
					bullets: [
						'C = 3000 is the classic Kyrieleis & Sichardt coefficient used in sandy-soil rule-of-thumb practice.',
						'Louwyck et al. (2022) show why Sichardt should be treated as a screening estimate, not as a rigorous groundwater-flow boundary.'
					]
				},
				{
					id: 'dewatering-transmissivity',
					title: '8.2 Steady-state inflow — transmissivity-based screening model',
					paragraphs: [
						'The model treats the pumped zone as a stack of horizontal layers, each with its own horizontal conductivity k<sub>h</sub>. For any chosen saturated thickness, the saturated part of each layer contributes to the total transmissivity according to its own thickness and conductivity.',
						'Instead of representing the whole profile by one fixed conductivity, the model first constructs the transmissivity of the saturated profile and then updates that transmissivity as the phreatic level moves through the layered ground.',
						'For unconfined flow, this changing hydraulic capacity is handled through the cumulative transmissivity moment. In that way, the drawdown solution remains analytical while still reflecting the layered structure of the interpreted CPT profile.'
					],
					equations: [
						'T = Σ(k<sub>h,i</sub>b<sub>i</sub>)',
						'T(h) = Σ(k<sub>h,i</sub>b<sub>i</sub>(h))',
						'M(h) = ∫<sub>0</sub><sup>h</sup>T(ξ)dξ',
						'Q = 2π[M(h<sub>0</sub>) − M(h<sub>w</sub>)] / ln(R / r<sub>w</sub>) &nbsp;&nbsp; unconfined',
						'Q = 2πT<sub>0</sub>(h<sub>0</sub> − h<sub>w</sub>) / ln(R / r<sub>w</sub>) &nbsp;&nbsp; confined screening',
						'r<sub>w,eq</sub> = √(A / π)'
					],
					symbols: [
						{ term: 'T', meaning: 'transmissivity of the saturated profile [m²/s]' },
						{ term: 'k<sub>h,i</sub>', meaning: 'horizontal conductivity of layer i [m/s]' },
						{ term: 'b<sub>i</sub>', meaning: 'currently saturated thickness of layer i [m]' },
						{ term: 'T(h)', meaning: 'transmissivity as a function of saturated thickness h [m²/s]' },
						{ term: 'M(h)', meaning: 'cumulative transmissivity moment [m³/s]' },
						{ term: 'h<sub>0</sub>, h<sub>w</sub>', meaning: 'saturated thickness at far field and at the source [m]' },
						{ term: 'Q', meaning: 'screening discharge [m³/s]' },
						{ term: 'r<sub>w</sub>', meaning: 'well radius or equivalent well radius [m]' },
						{ term: 'A', meaning: 'excavation plan area [m²]' }
					],
					bullets: [
						'T is the total horizontal flow capacity of the currently saturated part of the interpreted profile.',
						'T(h) expresses how that flow capacity changes as the water table rises or falls relative to the aquifer base.',
						'M(h) is the cumulative transmissivity moment used to solve the radial unconfined flow relation.',
						'For a homogeneous aquifer, the formulation reduces exactly to the classical Dupuit expression.',
						'The CPT does not measure b<sub>i</sub>, T(h), or M(h) directly. The app derives them from the interpreted layer model: each layer receives k<sub>h</sub> in Stage 4.5, the aquifer base is set by the hydraulic screening setup, and b<sub>i</sub>(h) is then the overlap of layer i with the currently saturated interval between that base and the phreatic level.',
						'Once the interpreted layers and their k<sub>h</sub> values are known, T(h) follows by summing k<sub>h,i</sub>b<sub>i</sub>(h) over the intersected layers, and M(h) is the corresponding cumulative transmissivity moment of that piecewise profile.'
					]
				},
				{
					id: 'dewatering-profile',
					title: '8.3 Drawdown profile toward the CPT',
					paragraphs: [
						'For radial unconfined flow, the app solves the head profile from the transmissivity-moment equation. For homogeneous conditions, this collapses to the classical Dupuit h² law.',
						'For trenches, the displayed profile toward the CPT remains a linear screening interpolation, while the flow estimate itself is based on transmissivity.'
					],
					equations: [
						'M(h(r)) = M(h<sub>w</sub>) + Q/(2π) · ln(r / r<sub>w</sub>)',
						'Δh<sub>CPT</sub> = h<sub>0</sub> − h(r<sub>CPT</sub>)',
						'h<sup>2</sup>(r) = h<sub>w</sub><sup>2</sup> + Q/(πk) · ln(r / r<sub>w</sub>) &nbsp;&nbsp; homogeneous limit'
					],
					symbols: [
						{ term: 'r', meaning: 'radial distance from the source [m]' },
						{ term: 'r<sub>CPT</sub>', meaning: 'distance from the source to the CPT [m]' },
						{ term: 'h(r)', meaning: 'saturated thickness at distance r [m]' },
						{ term: 'Δh<sub>CPT</sub>', meaning: 'drawdown at the CPT [m]' }
					]
				},
				{
					id: 'dewatering-stress',
						title: '8.4 Effective stress and settlement response',
						paragraphs: [
							'Once the new phreatic level at the CPT is known, the app recomputes pore pressure and effective stress with two selectable total-stress assumptions: conservative σ<sub>v</sub> fixed, or realistic γ<sub>sat</sub> → γ between the old and new water levels.',
							'Settlement is then computed with the same constrained-modulus philosophy used in the settlement app, evaluated at the mean stress state between before and after drawdown.',
							'Optional time curve for fine-grained layers follows the same Terzaghi 1D consolidation route used in the settlement application, with the consolidation coefficient c<sub>v</sub> = k<sub>v</sub>E<sub>oed</sub> / γ<sub>w</sub> derived from the interpreted layer k<sub>v</sub> and the stiffness used for settlement.'
						],
						equations: [
							"u′(z) = γ<sub>w</sub> · max(0, z − z′<sub>w</sub>)",
							"σ′<sub>v</sub>′(z) = σ<sub>v</sub>(z) − u′(z)",
							"Δσ′<sub>v</sub>(z) = σ′<sub>v,new</sub>(z) − σ′<sub>v,old</sub>(z)",
							"σ′<sub>mean</sub> = 0.5(σ′<sub>v,old</sub> + σ′<sub>v,new</sub>)",
							"Δε<sub>v,i</sub> = Δσ′<sub>v,i</sub> / E<sub>oed,i</sub>",
							'ΔS<sub>dewatering</sub> = ΣΔε<sub>v,i</sub>Δz<sub>i</sub>'
						],
					symbols: [
						{ term: 'z′<sub>w</sub>', meaning: 'new phreatic level depth below ground [m]' },
						{ term: 'σ′<sub>v,new</sub>, σ′<sub>v,old</sub>', meaning: 'new and original effective vertical stress [kPa]' },
						{ term: 'Δσ′<sub>v</sub>', meaning: 'effective stress increase due to drawdown [kPa]' },
						{ term: 'σ′<sub>mean</sub>', meaning: 'mean effective stress used for stiffness evaluation [kPa]' },
						{ term: 'Δε<sub>v,i</sub>', meaning: 'vertical strain increment in sublayer i [-]' },
						{ term: 'ΔS<sub>dewatering</sub>', meaning: 'total dewatering-induced settlement [m or mm depending on output]' },
						{ term: 'k<sub>v</sub>', meaning: 'vertical conductivity [m/s]' },
						{ term: 'c<sub>v</sub>', meaning: 'consolidation coefficient [m²/s]' }
					],
					bullets: [
						'The app reports both S<sub>conservative</sub> and S<sub>realistic</sub> to expose the sensitivity to the chosen total-stress assumption.',
						'The public engineering output is total settlement versus distance from the source, with the active CPT position marked on that curve.'
					]
				}
			],
			references: ['Dupuit (1863)', 'Thiem (1906)', 'Bear (1979)', 'Freeze & Cherry (1979)', 'Kyrieleis & Sichardt (1930)', 'Louwyck et al. (2022)', 'Powers et al. (2007)']
		},
		{
			id: 'settlement',
			title: '9. Settlement',
			intro:
				'The settlement application is a centreline constrained-modulus summation. It evaluates the stress increase beneath the loaded area, updates E<sub>oed</sub> at the mean effective stress, and integrates settlement over depth.',
			subsections: [
				{
					id: 'settlement-summary',
					title: '9.1 Settlement method summary',
					paragraphs: [
						'The current implementation follows the classical constrained-modulus route: compute q<sub>net</sub>, derive Δσ<sub>v</sub> beneath the foundation, evaluate E<sub>oed</sub> at the mean stress level, and integrate ΔS = (Δσ<sub>v</sub> / E<sub>oed</sub>)Δz.',
						'The evaluated location is the strip centreline for strip geometry and the centre of footprint for rectangular, square, and slab geometry.'
					],
					equations: [
						'q<sub>net</sub> = q<sub>gross</sub> − σ<sub>v</sub>(D<sub>f</sub>)',
						'ΔS<sub>i</sub> = (Δσ<sub>v,i</sub> / E<sub>oed,i</sub>)Δz<sub>i</sub>',
						'S = ΣΔS<sub>i</sub>'
					],
					symbols: [
						{ term: 'q<sub>gross</sub>', meaning: 'gross applied stress at foundation level [kPa]' },
						{ term: 'q<sub>net</sub>', meaning: 'net applied stress after subtracting in-situ overburden [kPa]' },
						{ term: 'D<sub>f</sub>', meaning: 'founding depth below ground [m]' },
						{ term: 'ΔS<sub>i</sub>', meaning: 'settlement contribution of sublayer i [m or mm depending on output]' },
						{ term: 'S', meaning: 'total settlement [m or mm depending on output]' }
					]
				},
				{
					id: 'settlement-stress',
					title: '9.2 Vertical stress increase — exact forms',
					paragraphs: [
						'For strip footings, the application can use the exact Boussinesq centreline solution. For rectangular loaded areas, the centre stress is computed by four-quadrant superposition of the corrected Newmark/Fadum corner influence factor.',
						'The implementation includes the V &lt; V<sub>1</sub> branch correction so the formula remains valid in the shallow, wide-load regime.'
					],
					equations: [
						'α = atan(B / 2z)',
						'Δσ<sub>v</sub>(z) = (q<sub>net</sub> / π)[2α + sin(2α)] &nbsp;&nbsp; strip centreline',
						'm = B / z, &nbsp; n = L / z, &nbsp; V = m<sup>2</sup> + n<sup>2</sup> + 1, &nbsp; V<sub>1</sub> = m<sup>2</sup>n<sup>2</sup>',
						'A = 2mn√V / (V + V<sub>1</sub>)',
						'B<sub>factor</sub> = (V + 1) / V',
						'I<sub>z</sub> = (1 / 4π)[A · B<sub>factor</sub> + atan-term]',
						'Δσ<sub>v,center</sub>(z) = 4I<sub>z</sub>(B/2, L/2, z)q<sub>net</sub>',
						'Δσ<sub>v</sub>(z) = q<sub>net</sub>BL / [(B + z)(L + z)] &nbsp;&nbsp; 2:1 option'
					],
					symbols: [
						{ term: 'B, L', meaning: 'loaded width and length [m]' },
						{ term: 'z', meaning: 'depth below the loaded surface [m]' },
						{ term: 'α', meaning: 'strip-footing Boussinesq angle [rad]' },
						{ term: 'm, n', meaning: 'dimensionless geometry ratios B/z and L/z [-]' },
						{ term: 'V, V₁, A, B<sub>factor</sub>', meaning: 'intermediate Newmark/Fadum terms [-]' },
						{ term: 'I<sub>z</sub>', meaning: 'vertical stress influence factor [-]' },
						{ term: 'Δσ<sub>v</sub>', meaning: 'vertical stress increase [kPa]' }
					]
				},
				{
					id: 'settlement-stiffness',
					title: '9.3 Constrained-modulus integration',
					paragraphs: [
						'For each sublayer, the app forms the mean effective stress between the in-situ and loaded state, evaluates E<sub>oed</sub> at that level, and computes vertical strain and settlement increment from the constrained modulus.',
						'This is the current implemented route for settlement in both sands and clays.'
					],
					equations: [
						"σ′<sub>v,f,i</sub> = σ′<sub>v,0,i</sub> + Δσ<sub>v,i</sub>",
						"σ′<sub>mean,i</sub> = 0.5(σ′<sub>v,0,i</sub> + σ′<sub>v,f,i</sub>)",
						"E<sub>oed,i</sub> = E<sub>oed,ref</sub>[(c′cotφ′ + σ′<sub>mean,i</sub>)/(c′cotφ′ + p<sub>ref</sub>)]<sup>m</sup>",
						'Δε<sub>v,i</sub> = Δσ<sub>v,i</sub> / E<sub>oed,i</sub>',
						'ΔS<sub>i</sub> = Δε<sub>v,i</sub>Δz<sub>i</sub>'
					],
					symbols: [
						{ term: 'σ′<sub>v,0,i</sub>', meaning: 'initial effective stress in sublayer i [kPa]' },
						{ term: 'σ′<sub>v,f,i</sub>', meaning: 'final effective stress in sublayer i [kPa]' },
						{ term: 'σ′<sub>mean,i</sub>', meaning: 'mean effective stress in sublayer i [kPa]' },
						{ term: 'E<sub>oed,i</sub>', meaning: 'oedometric stiffness of sublayer i [kPa or MPa, used consistently]' },
						{ term: 'Δε<sub>v,i</sub>', meaning: 'vertical strain increment in sublayer i [-]' },
						{ term: 'Δz<sub>i</sub>', meaning: 'sublayer thickness [m]' }
					]
				},
				{
					id: 'settlement-output',
					title: '9.4 Output form and truncation',
					paragraphs: [
						'The review documents several truncation rules, but the current app lets the engineer choose the practical truncation setting. The present default in the interface is CPT bottom.',
						'The output is a single vertical settlement beneath the evaluation point, not a 2D settlement field or edge-settlement map.'
					],
					bullets: [
						'Selectable truncation settings: Δσ<sub>v</sub> &lt; 10%σ′<sub>v,0</sub>; Δσ<sub>v</sub> &lt; 20%q<sub>net</sub>; CPT bottom.',
						'Optional time curve for fine-grained layers follows the same Terzaghi 1D consolidation route used in the dewatering application.'
					]
				}
			],
			references: ['Terzaghi & Peck (1967)', 'Boussinesq (1885)', 'Newmark (1935)', 'Fadum (1948)']
		},
		{
			id: 'beam',
			title: '10. Beam / Slab On Elastic Foundation',
			intro:
				'The structural-geotechnical application is currently a 1D strip or beam model on elastic foundation with both Winkler and Pasternak support options. It is explicitly not yet a 2D slab plate solver.',
			subsections: [
				{
					id: 'beam-ks',
					title: '10.1 Modulus of subgrade reaction from CPT stiffness',
					paragraphs: [
						'The current implementation derives k<sub>s</sub> from CPT-linked stiffness using the Vesić route. The app does not read E<sub>s</sub> directly from a separate soil table at Stage 6; it derives the stiffness from the interpreted CPT layer model.',
						'For each numerical sublayer between D<sub>f</sub> and D<sub>f</sub> + z<sub>influence</sub>, the app evaluates E<sub>oed</sub> at the local effective stress using the current layer stiffness law. It then converts that sublayer stiffness to the selected E<sub>s</sub> route, averages it over the influence depth, and only then computes k<sub>s</sub>. The result is therefore a footing-dependent support parameter, not a pure soil constant.'
					],
					equations: [
						'E<sub>oed,i</sub> = E<sub>oed,ref</sub>[(c′cotφ′ + σ′<sub>v,i</sub>)/(c′cotφ′ + p<sub>ref</sub>)]<sup>m</sup>',
						'E<sub>s,i</sub> = E<sub>oed,i</sub> &nbsp;&nbsp; current default route',
						'E<sub>s,i</sub> = E<sub>oed,i</sub>[(1 + ν<sub>s</sub>)(1 − 2ν<sub>s</sub>)/(1 − ν<sub>s</sub>)] &nbsp;&nbsp; drained Young route',
						'E<sub>s,avg</sub> = Σ(E<sub>s,i</sub>Δz<sub>i</sub>) / ΣΔz<sub>i</sub> &nbsp;&nbsp; over z ∈ [D<sub>f</sub>, D<sub>f</sub> + z<sub>influence</sub>]',
						'k<sub>s</sub> = [0.65E<sub>s</sub> / B(1 − ν<sub>s</sub><sup>2</sup>)] · (E<sub>s</sub>B<sup>4</sup> / E<sub>b</sub>I<sub>b</sub>)<sup>1/12</sup>',
						'E<sub>s</sub> = E<sub>s,avg</sub>, &nbsp; ν<sub>s</sub> = 0 &nbsp;&nbsp; current default route'
					],
					symbols: [
						{ term: 'k<sub>s</sub>', meaning: 'modulus of subgrade reaction [kN/m³]' },
						{ term: 'E<sub>s</sub>', meaning: 'soil stiffness used for foundation response [kPa or MPa, used consistently]' },
						{ term: 'E<sub>s,i</sub>', meaning: 'soil stiffness contribution of sublayer i after route conversion [kPa or MPa, used consistently]' },
						{ term: 'E<sub>s,avg</sub>', meaning: 'thickness-weighted soil stiffness average over the chosen influence depth [kPa or MPa, used consistently]' },
						{ term: 'ν<sub>s</sub>', meaning: 'soil Poisson ratio [-]' },
						{ term: 'B', meaning: 'foundation width [m]' },
						{ term: 'E<sub>b</sub>', meaning: 'beam or slab Young modulus [consistent stress units]' },
						{ term: 'I<sub>b</sub>', meaning: 'second moment of area per strip [m⁴]' },
						{ term: 'D<sub>f</sub>', meaning: 'foundation depth below surface [m]' },
						{ term: 'z<sub>influence</sub>', meaning: 'depth range used for averaging the supporting soil stiffness [m]' }
					]
				},
				{
					id: 'beam-governing',
					title: '10.2 Governing equations and characteristic length',
					paragraphs: [
						'The beam is solved on either a Winkler or Pasternak elastic foundation. The corresponding differential equations are implemented numerically along the strip length.',
						'The characteristic length determines whether the strip behaves as short, intermediate, or long on elastic support.'
					],
					equations: [
						"EIw'''' + k<sub>s</sub>bw = q(x) &nbsp;&nbsp; Winkler",
						"EIw'''' − G<sub>p</sub>bw'' + k<sub>s</sub>bw = q(x) &nbsp;&nbsp; Pasternak",
						'λ = (4EI / k<sub>s</sub>b)<sup>1/4</sup>',
						'β = 1 / λ'
					],
					symbols: [
						{ term: 'E', meaning: 'structural Young modulus [consistent stress units]' },
						{ term: 'I', meaning: 'second moment of area [m⁴]' },
						{ term: 'w(x)', meaning: 'vertical deflection along the strip [m]' },
						{ term: 'b', meaning: 'beam or strip width [m]' },
						{ term: 'q(x)', meaning: 'line load distribution [kN/m]' },
						{ term: 'G<sub>p</sub>', meaning: 'Pasternak shear-layer parameter [kN/m]' },
						{ term: 'λ', meaning: 'characteristic length [m]' },
						{ term: 'β', meaning: 'inverse characteristic length [1/m]' }
					]
				},
				{
					id: 'beam-pasternak',
					title: '10.3 Pasternak 1D implementation',
					paragraphs: [
						'The Pasternak extension currently implemented in the app is a 1D strip formulation. The shear-layer parameter is not measured directly; it is inferred from the averaged soil shear modulus and a chosen influence depth.',
						'In the current app, G<sub>s,avg</sub> is obtained from the same CPT-derived stiffness profile used for k<sub>s</sub>. The app first builds E<sub>s,avg</sub> over the selected influence zone, then converts that average stiffness into the average shear modulus, and only then forms G<sub>p</sub>.',
						'This is why the Pasternak route is labeled as a screening extension rather than a continuum-calibrated Belgian design model.'
					],
					equations: [
						'G<sub>p</sub> = ηG<sub>s,avg</sub>H<sub>p</sub>',
						'G<sub>s,avg</sub> = E<sub>s,avg</sub> / [2(1 + ν<sub>s</sub>)]',
						'H<sub>p</sub> = z<sub>influence</sub>'
					],
					symbols: [
						{ term: 'η', meaning: 'engineer scaling factor for Pasternak coupling [-]' },
						{ term: 'G<sub>s,avg</sub>', meaning: 'average soil shear modulus obtained from the CPT-derived E<sub>s,avg</sub> over the influence zone [kPa or MPa, used consistently]' },
						{ term: 'H<sub>p</sub>', meaning: 'Pasternak influence depth [m]' },
						{ term: 'z<sub>influence</sub>', meaning: 'depth range used for averaging the supporting soil stiffness [m]' }
					],
					bullets: [
						'With the default app route, E<sub>s,i</sub> = E<sub>oed,i</sub> and ν<sub>s</sub> = 0, so G<sub>s,avg</sub> = E<sub>s,avg</sub>/2.',
						'Uniform full-length loading can still produce very low bending moment because the deflection field approaches nearly uniform settlement.',
						'Patch loads and point loads are more informative when the objective is bending-driven reinforcement screening.'
					]
				}
			],
			references: ['Hetényi (1946)', 'Vesić (1961a)', 'Vesić (1961b)', 'Pasternak (1954)', 'Kerr (1964)']
		},
		{
			id: 'reinforcement',
			title: '11. ULS Reinforcement Output',
			intro:
				'The beam/slab module carries the ULS strip response through to an EC2 reinforcement estimate using design strengths, effective depth, and the selected durability and cover assumptions.',
			subsections: [
				{
					id: 'reinforcement-route',
					title: '11.1 Structural design route from M<sub>Ed</sub>',
					paragraphs: [
						'Once the ULS moment is obtained from the strip-on-foundation solve, the app converts concrete and steel to design strengths and estimates the required reinforcement area per meter width.',
						'The current implementation also applies the EC2 durability and cover route, so c<sub>nom</sub> is not just a free guessed number.'
					],
					equations: [
						'f<sub>cd</sub> = f<sub>ck</sub> / γ<sub>C</sub>',
						'f<sub>yd</sub> = f<sub>yk</sub> / γ<sub>S</sub>',
						'd = h − c<sub>nom</sub> − φ<sub>bar</sub>/2',
						'μ = M<sub>Ed</sub> / (bd<sup>2</sup>f<sub>cd</sub>)',
						'ω = 1 − √(1 − 2μ)',
						'A<sub>s,req</sub> = ωbdf<sub>cd</sub> / f<sub>yd</sub>'
					],
					symbols: [
						{ term: 'f<sub>ck</sub>', meaning: 'characteristic concrete compressive strength [MPa]' },
						{ term: 'f<sub>cd</sub>', meaning: 'design concrete compressive strength [MPa]' },
						{ term: 'f<sub>yk</sub>', meaning: 'characteristic steel yield strength [MPa]' },
						{ term: 'f<sub>yd</sub>', meaning: 'design steel yield strength [MPa]' },
						{ term: 'γ<sub>C</sub>, γ<sub>S</sub>', meaning: 'partial factors for concrete and steel [-]' },
						{ term: 'h', meaning: 'member thickness [m]' },
						{ term: 'c<sub>nom</sub>', meaning: 'nominal concrete cover [same length unit as input]' },
						{ term: 'φ<sub>bar</sub>', meaning: 'bar diameter [same length unit as input]' },
						{ term: 'M<sub>Ed</sub>', meaning: 'design bending moment [kNm/m or consistent strip units]' },
						{ term: 'A<sub>s,req</sub>', meaning: 'required reinforcement area per meter width [mm²/m]' }
					],
					bullets: [
						'The result should be read as strip-based ULS reinforcement screening, not as a final 2D slab reinforcement layout.',
						'Exposure class, working life, and detailing assumptions feed the EC2 cover route used in the calculation.'
					]
				}
			],
			references: ['EN 1992-1-1', 'NBN EN 1992-1-1 ANB']
		},
		{
			id: 'seepage-stage6',
			title: '12. Stage 6 Seepage Workspace',
			intro:
				'The Stage 6 seepage workspace is a two-dimensional steady-state groundwater screening tool on the shared Bishop geometry. It reuses the same terrain, soil polygons, phreatic line, retaining-wall geometry, and section depth rather than introducing a second drawing model.',
			subsections: [
				{
					id: 'seepage-stage6-scope',
					title: '12.1 Present solver scope and geometry model',
					paragraphs: [
						'The current seepage module solves a steady-state Darcy/Laplace problem on a constrained triangular mesh. It is intended for cross-section screening, flow visualisation, exit-gradient checks, and optional pore-pressure handoff to Bishop.',
						'Unless custom polygons are enabled, the soil layout still starts from the <strong>active CPT column extended laterally across the section</strong>. If custom polygons are enabled, those polygons become the seepage regions on the shared canvas.'
					],
					equations: ['q = -k∇h', 'u = γ<sub>w</sub>(h - y)'],
					bullets: [
						'Only <strong>outer-boundary</strong> edges can currently carry seepage boundary conditions: terrain, base, left side, and right side.',
						'Interior region boundaries are meshing constraints only; they are not yet seepage BCs.',
						'The current module is steady-state only: no transient storage, no consolidation time response, and no Richards-type unsaturated flow law.',
						'Retaining walls are presently approximated as thin low-permeability regions rather than true zero-thickness duplicate-node cutoffs.',
						'Internal drains and line sinks are not yet part of the public seepage solver.'
					]
				},
				{
					id: 'seepage-stage6-free-surface',
					title: '12.2 Free surface, boundary logic, and numerical safeguards',
					paragraphs: [
						'The shipped default is the <strong>iterative free-surface</strong> mode. It keeps one fixed mesh, classifies elements as wet or dry from the current pressure-head state, and updates the atmospheric seepage-face activation set on the outer boundary.',
						'A second <strong>fixed phreatic</strong> mode remains available for benchmarking or sensitivity studies. In that mode the drawn phreatic line is imposed as an internal constraint and the solution is locked to that water-table geometry.'
					],
					equations: ['k<sub>dry</sub> = 10<sup>−4</sup>k', 'h = y &nbsp;&nbsp; on active seepage-face nodes'],
					bullets: [
						'A prescribed-head BC on a sloping or vertical edge applies only to the submerged part below the entered head elevation; the dry part above reverts to natural no-flow.',
						'Iterative convergence is accepted only when the seepage-face active set is stable, the boundary flow-rate error is within the target tolerance, and no disconnected wet islands remain.',
						'The current default flow-rate error target is 1%, with a 10 s runtime cap in iterative mode.',
						'If the wet/dry loop creates isolated wet pockets that are not connected to a prescribed-head boundary, the solver applies a connectivity fallback and dries those pockets out.',
						'This wet/dry handling is a practical engineering screening shortcut, not an unsaturated constitutive model.'
					]
				},
				{
					id: 'seepage-stage6-coupling',
					title: '12.3 Mesh controls, coupling, and public outputs',
					paragraphs: [
						'The seepage mesh is built with the same shared section mesher used by the deformation workspace. The global target element area can be left on automatic sizing or entered manually, and each polygon may apply a local <strong>coarseness</strong> factor to refine only that region.',
						'When the engineer enables <strong>Use FEM pore pressure</strong> in Bishop, the slice base samples pore pressure from the seepage field rather than from the drawn hydrostatic phreatic line. Outside the seepage mesh, or if no seepage result exists, the solver falls back safely to the hydrostatic route.'
					],
					bullets: [
						'Polygon <strong>coarseness</strong> is a mesh-density control only; it is not a hydraulic soil property.',
						'The current results panel can plot head, pore pressure, hydraulic gradient, specific discharge magnitude, and normal cross-flow along the shared measurement line.',
						'The line-probe graph is sampled from the solved field and can be copied to the clipboard as distance/value data.',
						'The seepage workspace is strongest as a 2D screening tool and as a pore-pressure source for the circular Bishop/Spencer solver; it is not yet a full groundwater package.'
					]
				}
			],
			references: ['Bear (1979)', 'Freeze & Cherry (1979)', 'Powers et al. (2007)']
		},
		{
			id: 'deformation-stage6',
			title: '13. Stage 6 Deformation Workspace',
			intro:
				'The Stage 6 deformation workspace is the first mesh-based mechanical screen on the shared Bishop geometry. It reuses the constrained triangular section mesh to compute displacements and stress screening beneath a terrain load interval.',
			subsections: [
				{
					id: 'deformation-stage6-model',
					title: '13.1 Present constitutive route and engineering meaning',
					paragraphs: [
						'The current deformation tool is intentionally the <strong>easy Mohr-Coulomb route</strong>: a <strong>linear-elastic plane-strain</strong> displacement solve followed by Mohr-Coulomb effective-stress screening in post-processing.',
						'This means the field quantities are useful for settlement shape, displacement trends, and proximity-to-yield visualisation, but the solver does <strong>not</strong> yet produce plastic strains, stress redistribution, or an emergent failure mechanism.'
					],
					equations: [
						'σ = Dε &nbsp;&nbsp; with linear-elastic plane-strain D',
						'η<sub>MC</sub> = (σ′<sub>1</sub> − σ′<sub>3</sub>) / [(σ′<sub>1</sub> + σ′<sub>3</sub>)sinφ′ + 2c′cosφ′]'
					],
					bullets: [
						'The displacement solve is linear elastic.',
						'<strong>Mohr-Coulomb is post-processing only</strong>; it is not an elastoplastic constitutive update.',
						'The tool should be read as <strong>long-term drained screening</strong>, not as an immediate undrained clay check.',
						'The current implementation uses the Stage 4/5 <strong>E<sub>mc</sub></strong> value directly as the elastic modulus E.',
						'The stored dilation angle ψ is carried through the data model, but it is not used until plasticity exists.'
					]
				},
				{
					id: 'deformation-stage6-loading',
					title: '13.2 Load model, supports, and initial stresses',
					paragraphs: [
						'The mechanical load is currently taken from the shared <strong>surface load</strong> interval on the terrain. In pressure mode the entered q is applied directly; in total-load mode the app converts the total slab load to an equivalent 2D pressure through the out-of-plane length.',
						'The initial effective stress field is reconstructed with a flat-ground at-rest approximation rather than a prior gravity step. Optional seepage coupling only changes the initial pore-pressure field used in that reconstruction.'
					],
					equations: [
						'q = P<sub>total</sub> / (B · L<sub>out</sub>) &nbsp;&nbsp; in total-load mode',
						'σ′<sub>h0</sub> = K<sub>0</sub>σ′<sub>v0</sub>, &nbsp; τ′<sub>xy,0</sub> = 0'
					],
					bullets: [
						'Bottom boundary: u<sub>y</sub> = 0. Side boundaries: u<sub>x</sub> = 0.',
						'A practical screening rule is to keep roughly 5B of width on each side of the load and 5B of depth below it; smaller domains will look too stiff.',
						'Retaining walls are visible in the shared geometry but are not active mechanical elements in the deformation solve.',
						'If seepage pore pressures are enabled and a seepage result exists, they are sampled into the initial stress field; otherwise the tool falls back to the drawn hydrostatic phreatic line.',
						'Results near steep slopes, embankments, and walls need caution because the current initialization ignores pre-existing shear stress.'
					]
				},
				{
					id: 'deformation-stage6-numerics',
					title: '13.3 Numerical safeguards and public outputs',
					paragraphs: [
						'The deformation solver uses 3-node constant-strain triangles. That choice is robust and fast on the shared mesh, but it comes with the usual stiffness issues for coarse meshes and near-incompressible Poisson ratios.',
						'The public results panel can display settlement, u<sub>x</sub>, u<sub>y</sub>, Δσ<sub>yy</sub>, and η<sub>MC</sub> contours, and the same shared measurement line can probe those quantities without covering the canvas.'
					],
					bullets: [
						'Poisson&apos;s ratio is capped at 0.49 for numerical stability in the plane-strain T3 solver.',
						'Load-edge refinement is added automatically beneath both ends of the loaded interval because coarse CST/T3 meshes become too stiff there.',
						'The MC screen uses the in-plane principal pair only and applies a zero-tension cut-off by default.',
						'Missing or non-positive E<sub>mc</sub> is replaced with a pragmatic fallback value of 1000 kPa, with a warning.',
						'Polygon coarseness remains a local mesh-refinement factor only.',
						'The line-probe graph can be copied to the clipboard as distance/value data for external checking.'
					]
				}
			],
			references: ['PLAXIS 2D Material Models Manual (2025.1)', 'Schanz, Vermeer & Bonnier (1999)', 'Boussinesq (1885)']
		}
	];

	const referencesTitle = `${sections.length + 1}. References`;
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content={pageDescription} />
	<link rel="canonical" href={canonicalUrl} />
	<meta property="og:type" content="article" />
	<meta property="og:locale" content="en_BE" />
	<meta property="og:site_name" content="MADEP" />
	<meta property="og:title" content={pageTitle} />
	<meta property="og:description" content={pageDescription} />
	<meta property="og:url" content={canonicalUrl} />
	<meta property="og:image" content={ogImageUrl} />
</svelte:head>

<div class="docs-page">
	<header class="docs-header">
		<div class="docs-header__inner">
			<a class="docs-header__logo" href="https://madep.be">MADEP CPT Interpreter</a>
			<nav class="docs-header__nav" aria-label="Documentation navigation">
				<a href="/">App</a>
			</nav>
		</div>
	</header>

	<header class="hero">
		<div class="hero__inner">
			<p class="hero__eyebrow">Technical documentation</p>
			<h1>CPT theory and references.</h1>
			<p class="hero__lead">
				A technical implementation note for the CPT app workflow: GEF loading,
				classification, layer and parameter derivation, experimental tuning, and the current
				engineering applications including Bishop/Spencer, seepage, and deformation,
				documented from the active logic and reference base.
			</p>
			<div class="hero__actions">
				<a class="btn btn--primary" href="/">Open the app</a>
				<a class="btn btn--outline-dark" href="#stage1">Read the theory</a>
			</div>
			<div class="hero__trust">
				<span>Full CPT workflow</span>
				<span>Technical reference</span>
			</div>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="On this page">
			<div class="docs-nav__title">Pages</div>
			<a href="/docs" aria-current="page">Main theory</a>
			<a href="/docs/bishop">Bishop simplified v1</a>
			<div class="docs-nav__title" style="margin-top:18px">On this page</div>
			{#each sections as section}
				<a href={`#${section.id}`}>{section.title}</a>
			{/each}
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			{#each sections as section}
				<section id={section.id} class="doc-card">
					<p class="section-label">Section</p>
					<h2>{section.title}</h2>
					<p>{@html section.intro}</p>

					{#each section.subsections as subsection}
						<section id={subsection.id} class="doc-subsection">
							<h3>{@html subsection.title}</h3>
							{#each subsection.paragraphs as paragraph}
								<p>{@html paragraph}</p>
							{/each}

							{#if subsection.equations}
								<div class="equations">
									{#each subsection.equations as eq}
										<div class="formula" aria-label="Engineering formula">{@html eq}</div>
									{/each}
								</div>
							{/if}

							{#if subsection.symbols}
								<div class="symbols">
									<div class="symbols__title">Notation</div>
									<dl class="symbols__list">
										{#each subsection.symbols as symbol}
											<div class="symbols__row">
												<dt>{@html symbol.term}</dt>
												<dd>{symbol.meaning}</dd>
											</div>
										{/each}
									</dl>
								</div>
							{/if}

							{#if subsection.figures}
								<div class="doc-figures">
									{#each subsection.figures as figure}
										{#if figure.collapsible}
											<details class="doc-figure-toggle">
												<summary>{figure.summary ?? 'Show source figure'}</summary>
												<figure class="doc-figure">
													<img src={figure.src} alt={figure.alt} loading="lazy" />
													<figcaption>{figure.caption}</figcaption>
												</figure>
											</details>
										{:else}
											<figure class="doc-figure">
												<img src={figure.src} alt={figure.alt} loading="lazy" />
												<figcaption>{figure.caption}</figcaption>
											</figure>
										{/if}
									{/each}
								</div>
							{/if}

							{#if subsection.table}
								<div class="doc-table-wrap">
									{#if subsection.table.collapsible}
										<details class="doc-table-toggle">
											<summary>{subsection.table.summary ?? 'Show table'}</summary>
											<p class="doc-table-caption">{subsection.table.caption}</p>
											<div class="doc-table-scroll">
												<table class="doc-table">
													<thead>
														<tr>
															{#each subsection.table.columns as column}
																<th>{@html column.label}</th>
															{/each}
														</tr>
													</thead>
													<tbody>
														{#each subsection.table.rows as row}
															<tr>
																{#each subsection.table.columns as column}
																	<td>{@html row[column.key]}</td>
																{/each}
															</tr>
														{/each}
													</tbody>
												</table>
											</div>
											{#if subsection.table.note}
												<p class="doc-table-note">{@html subsection.table.note}</p>
											{/if}
										</details>
									{:else}
										<p class="doc-table-caption">{subsection.table.caption}</p>
										<div class="doc-table-scroll">
											<table class="doc-table">
												<thead>
													<tr>
														{#each subsection.table.columns as column}
															<th>{@html column.label}</th>
														{/each}
													</tr>
												</thead>
												<tbody>
													{#each subsection.table.rows as row}
														<tr>
															{#each subsection.table.columns as column}
																<td>{@html row[column.key]}</td>
															{/each}
														</tr>
													{/each}
												</tbody>
											</table>
										</div>
										{#if subsection.table.note}
											<p class="doc-table-note">{@html subsection.table.note}</p>
										{/if}
									{/if}
								</div>
							{/if}

							{#if subsection.bullets}
								<ul class="notes">
									{#each subsection.bullets as bullet}
										<li>{@html bullet}</li>
									{/each}
								</ul>
							{/if}
						</section>
					{/each}

					{#if section.references.length}
						<p class="refs-inline">
							<strong>Primary references:</strong>
							{section.references.join('; ')}.
						</p>
					{/if}
				</section>
			{/each}

			<section id="references" class="doc-card">
				<p class="section-label">Sources</p>
				<h2>{referencesTitle}</h2>
				<p>
					The references below are the principal sources used to frame the current
					implementation. Project-specific design remains subject to the governing code,
					national annex, site investigation, and engineering judgement.
				</p>
				{#each referenceGroups as group}
					<section class="reference-group">
						<h3>{group.title}</h3>
						<ul class="reference-list">
							{#each group.items as reference}
								<li>
									<strong>{reference.label}</strong> — {reference.detail}
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			</section>
		</main>
	</div>

	<footer class="docs-footer">
		<div class="docs-footer__inner">
				<div class="docs-footer__brand">
					<a class="docs-footer__logo" href="https://madep.be">MADEP CPT Interpreter</a>
					<p class="docs-footer__tagline">
						Technical CPT interpretation, parameter derivation, and engineering screening.
					</p>
			</div>
			<div class="docs-footer__links">
				<p class="docs-footer__heading">Navigation</p>
				<a href="/">CPT app</a>
				<a href="/docs">Main docs</a>
				<a href="/docs/bishop">Bishop docs</a>
				<a href="#scope">Scope</a>
				<a href="#references">References</a>
			</div>
		</div>
	</footer>
</div>

<style>
	.docs-page {
		min-height: 100vh;
		background: #f7f4ef;
		color: #18181a;
		--color-primary: #18181a;
		--color-primary-light: #282828;
		--color-accent: #3d6b6a;
		--color-accent-hover: #4f8584;
		--color-accent-text: #2e5150;
		--color-accent-soft: rgba(61, 107, 106, 0.1);
		--color-bg: #f7f4ef;
		--color-bg-alt: #ede9e1;
		--color-bg-dark: #111110;
		--color-bg-darker: #0c0c0b;
		--color-text: #18181a;
		--color-text-light: #4a4a52;
		--color-text-muted: #888890;
		--color-text-on-dark: #ede9e1;
		--color-text-on-dark-muted: #8a8a82;
		--color-border: rgba(24, 24, 26, 0.1);
		--color-border-strong: rgba(24, 24, 26, 0.18);
		--font-heading: 'DM Sans', system-ui, sans-serif;
		--font-body: 'Manrope', system-ui, sans-serif;
		--font-mono: 'JetBrains Mono', 'Courier New', monospace;
		--radius-sm: 3px;
		--radius-md: 6px;
		--shadow-sm: 0 2px 8px rgba(18, 18, 20, 0.05);
		--shadow-md: 0 6px 24px rgba(18, 18, 20, 0.07);
		font-family: var(--font-body);
	}

	.docs-header {
		position: sticky;
		top: 0;
		z-index: 20;
		padding: 10px 16px 0;
		margin-bottom: -5.75rem;
		background: transparent;
	}

	.docs-header__inner {
		max-width: 1300px;
		margin: 0 auto;
		padding: 0.85rem 1.5rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1.5rem;
		border: 1px solid rgba(24, 24, 26, 0.1);
		border-radius: 6px;
		background: rgba(247, 244, 239, 0.86);
		backdrop-filter: blur(16px);
		box-shadow: 0 8px 24px rgba(17, 17, 16, 0.08);
	}

	.docs-header__logo {
		font-family: var(--font-heading);
		font-size: 0.94rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--color-primary);
		text-decoration: none;
	}

	.docs-header__nav {
		display: flex;
		align-items: center;
		gap: 1.25rem;
	}

	.docs-header__nav a {
		font-size: 0.76rem;
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--color-text-light);
		text-decoration: none;
	}

	.docs-header__nav a:hover {
		color: var(--color-primary);
	}

	.hero {
		padding: 12.25rem 24px 3.75rem;
		background:
			linear-gradient(135deg, rgba(61, 107, 106, 0.08), transparent 40%),
			linear-gradient(180deg, #f7f4ef 0%, #ede9e1 100%);
	}

	.hero__inner,
	.docs-shell,
	.docs-footer__inner {
		max-width: 1180px;
		margin: 0 auto;
	}

	.hero__eyebrow {
		margin: 0 0 12px;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-accent-text);
	}

	h1 {
		margin: 0;
		font-family: var(--font-heading);
		font-size: clamp(2.9rem, 6.2vw, 5.2rem);
		line-height: 1.02;
		letter-spacing: -0.03em;
		max-width: 12ch;
	}

	.hero__lead {
		max-width: 760px;
		margin: 18px 0 0;
		font-size: 1.04rem;
		line-height: 1.65;
		color: var(--color-text-light);
	}

	.hero__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.85rem;
		margin-top: 28px;
	}

	.hero__trust {
		display: flex;
		flex-wrap: wrap;
		gap: 1rem;
		margin-top: 24px;
		font-size: 0.82rem;
		color: var(--color-text-light);
	}

	.hero__trust span {
		position: relative;
		padding-right: 1rem;
	}

	.hero__trust span:not(:last-child)::after {
		content: '';
		position: absolute;
		right: 0.25rem;
		top: 50%;
		width: 3px;
		height: 3px;
		border-radius: 999px;
		background: rgba(24, 24, 26, 0.28);
		transform: translateY(-50%);
	}

	.docs-shell {
		display: grid;
		grid-template-columns: 230px minmax(0, 1fr);
		gap: 36px;
		padding: 28px 24px 72px;
	}

	.docs-nav {
		position: sticky;
		top: 92px;
		align-self: start;
		padding: 18px 0;
	}

	.docs-nav__title {
		margin-bottom: 12px;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		font-weight: 400;
		color: var(--color-accent-text);
		text-transform: uppercase;
		letter-spacing: 0.16em;
	}

	.docs-nav a {
		display: block;
		padding: 0.38rem 0;
		color: var(--color-text-light);
		text-decoration: none;
		font-size: 0.92rem;
	}

	.docs-nav a:hover {
		text-decoration: underline;
	}

	.docs-content {
		display: grid;
		gap: 28px;
		min-width: 0;
	}

	.doc-card {
		padding: 28px 28px 26px;
		border-top: 1px solid var(--color-border);
		background: transparent;
		min-width: 0;
	}

	.doc-subsection + .doc-subsection {
		margin-top: 28px;
	}

	.section-label {
		margin: 0 0 10px;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: var(--color-accent-text);
	}

	h2 {
		margin: 0 0 10px;
		font-family: var(--font-heading);
		font-size: clamp(1.9rem, 3vw, 2.5rem);
		letter-spacing: -0.025em;
	}

	h3 {
		margin: 0 0 10px;
		font-family: var(--font-heading);
		font-size: 1.18rem;
		line-height: 1.2;
		letter-spacing: -0.02em;
		color: var(--color-primary);
	}

	p {
		margin: 0 0 12px;
		line-height: 1.72;
		color: var(--color-text-light);
		max-width: 72ch;
		overflow-wrap: anywhere;
		word-break: normal;
		hyphens: auto;
	}

	li,
	dt,
	dd,
	figcaption,
	summary,
	.docs-nav a,
	.docs-footer__tagline,
	.docs-footer__links a,
	.refs-inline {
		overflow-wrap: anywhere;
		word-break: normal;
		hyphens: auto;
	}

	.equations {
		display: grid;
		gap: 10px;
		margin: 16px 0;
	}

	.equations :global(.formula),
	.equations :global(div) {
		margin: 0;
		padding: 12px 18px;
		border-radius: 0;
		background: transparent;
		border: none;
		border-left: 2px solid rgba(24, 24, 26, 0.12);
		line-height: 1.45;
		white-space: normal;
		word-break: break-word;
		font-family: Georgia, 'Times New Roman', serif;
		font-size: 1.03rem;
		text-align: center;
		color: var(--color-primary);
	}

	.doc-figures {
		display: grid;
		gap: 14px;
		margin: 16px 0 18px;
	}

	.doc-figure {
		margin: 0;
		padding: 12px;
		border: 1px solid var(--color-border);
		background: rgba(255,255,255,0.55);
	}

	.doc-figure-toggle {
		border: 1px solid var(--color-border);
		background: rgba(255, 255, 255, 0.44);
	}

	.doc-figure-toggle summary {
		cursor: pointer;
		padding: 0.8rem 1rem;
		font-size: 0.92rem;
		font-weight: 600;
		color: var(--color-primary);
		list-style: none;
	}

	.doc-figure-toggle summary::-webkit-details-marker {
		display: none;
	}

	.doc-figure-toggle summary::after {
		content: '▾';
		float: right;
		color: var(--color-text-light);
	}

	.doc-figure-toggle[open] summary::after {
		content: '▴';
	}

	.doc-figure-toggle .doc-figure {
		border: none;
		border-top: 1px solid var(--color-border);
		background: transparent;
	}

	.doc-figure img {
		display: block;
		width: 100%;
		height: auto;
		border: 1px solid var(--color-border);
		background: #fff;
	}

	.doc-figure figcaption {
		margin-top: 8px;
		font-size: 0.92rem;
		line-height: 1.55;
		color: var(--color-text-light);
	}

	.doc-table-wrap {
		margin: 1rem 0 1.25rem;
	}

	.doc-table-toggle {
		border: 1px solid var(--color-border);
		background: rgba(255, 255, 255, 0.44);
	}

	.doc-table-toggle summary {
		cursor: pointer;
		padding: 0.8rem 1rem;
		font-size: 0.92rem;
		font-weight: 600;
		color: var(--color-primary);
		list-style: none;
	}

	.doc-table-toggle summary::-webkit-details-marker {
		display: none;
	}

	.doc-table-toggle summary::after {
		content: '▾';
		float: right;
		color: var(--color-text-light);
	}

	.doc-table-toggle[open] summary::after {
		content: '▴';
	}

	.doc-table-toggle .doc-table-caption,
	.doc-table-toggle .doc-table-note {
		padding-left: 1rem;
		padding-right: 1rem;
	}

	.doc-table-toggle .doc-table-scroll {
		margin: 0 1rem;
	}

	.doc-table-caption,
	.doc-table-note {
		font-size: 0.95rem;
	}

	.doc-table-caption {
		margin-bottom: 0.65rem;
		color: var(--color-primary);
	}

	.doc-table-note {
		margin-top: 0.65rem;
		color: var(--color-text-light);
	}

	.doc-table-scroll {
		overflow-x: auto;
		border: 1px solid var(--color-border);
		background: rgba(255, 255, 255, 0.55);
	}

	.doc-table {
		width: 100%;
		min-width: 860px;
		border-collapse: collapse;
		font-size: 0.92rem;
	}

	.doc-table th,
	.doc-table td {
		padding: 0.7rem 0.8rem;
		border-bottom: 1px solid var(--color-border);
		text-align: left;
		vertical-align: top;
	}

	.doc-table th {
		font-family: var(--font-heading);
		font-size: 0.8rem;
		letter-spacing: 0.04em;
		color: var(--color-primary);
		background: rgba(24, 24, 26, 0.03);
	}

	.doc-table td {
		color: var(--color-text-light);
	}

	.doc-table tbody tr:last-child td {
		border-bottom: none;
	}

	.notes,
	.reference-list {
		margin: 0;
		padding-left: 1.15rem;
		line-height: 1.7;
	}

	.notes {
		margin: 0.2rem 0 0.8rem;
	}

	.reference-group + .reference-group {
		margin-top: 1.4rem;
	}

	.reference-group h3 {
		margin: 0 0 0.55rem;
		font-family: var(--font-heading);
		font-size: 1rem;
		color: var(--color-primary);
	}

	.symbols {
		margin: 14px 0 10px;
		padding-top: 10px;
		border-top: 1px solid var(--color-border);
	}

	.symbols__title {
		margin-bottom: 8px;
		font-family: var(--font-mono);
		font-size: 0.68rem;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--color-text-muted);
	}

	.symbols__list {
		margin: 0;
	}

	.symbols__row {
		display: grid;
		grid-template-columns: minmax(120px, 180px) minmax(0, 1fr);
		gap: 12px;
		padding: 5px 0;
	}

	.symbols__row dt {
		font-family: Georgia, 'Times New Roman', serif;
		color: var(--color-primary);
	}

	.symbols__row dd {
		margin: 0;
		color: var(--color-text-light);
		min-width: 0;
	}

	.refs-inline {
		margin-top: 12px;
		margin-bottom: 0;
		color: var(--color-text-light);
	}

	.btn {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.85rem 1.6rem;
		font-family: var(--font-body);
		font-size: 0.76rem;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		text-decoration: none;
		transition:
			background-color 0.22s ease,
			color 0.22s ease,
			border-color 0.22s ease,
			transform 0.22s ease,
			box-shadow 0.22s ease;
	}

	.btn--primary {
		background: var(--color-primary);
		color: var(--color-text-on-dark);
	}

	.btn--primary:hover {
		background: var(--color-bg-darker);
		transform: translateY(-1px);
		box-shadow: var(--shadow-sm);
	}

	.btn--outline-dark {
		background: transparent;
		color: var(--color-primary);
		border-color: var(--color-border-strong);
	}

	.btn--outline-dark:hover {
		border-color: var(--color-primary);
		background: rgba(24, 24, 26, 0.03);
	}

	.docs-footer {
		background: var(--color-bg-darker);
		color: var(--color-text-on-dark-muted);
		padding: 4.5rem 24px 2rem;
	}

	.docs-footer__inner {
		display: grid;
		grid-template-columns: 1.8fr 1fr;
		gap: 3rem;
		padding-bottom: 2rem;
		border-bottom: 1px solid rgba(237, 233, 225, 0.08);
	}

	.docs-footer__logo {
		font-family: var(--font-heading);
		font-size: 1rem;
		font-weight: 600;
		color: var(--color-text-on-dark);
		margin-bottom: 1rem;
	}

	.docs-footer__tagline {
		max-width: 34ch;
		color: var(--color-text-on-dark-muted);
	}

	.docs-footer__heading {
		margin: 0 0 1rem;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		letter-spacing: 0.16em;
		text-transform: uppercase;
		color: rgba(237, 233, 225, 0.58);
	}

	.docs-footer__links {
		display: flex;
		flex-direction: column;
		gap: 0.7rem;
	}

	.docs-footer__links a {
		color: var(--color-text-on-dark-muted);
		text-decoration: none;
		font-size: 0.92rem;
	}

	.docs-footer__links a:hover {
		color: var(--color-text-on-dark);
	}

	@media (max-width: 900px) {
		.docs-header__inner {
			padding: 0.8rem 1rem;
		}

		.docs-shell {
			grid-template-columns: 1fr;
			padding: 22px 18px 56px;
			gap: 20px;
		}

		.docs-nav {
			position: static;
			padding-top: 8px;
		}

		.docs-footer__inner {
			grid-template-columns: 1fr;
			gap: 2rem;
		}
	}

	@media (max-width: 680px) {
		.docs-header {
			padding: 8px 12px 0;
		}

		.docs-header__inner {
			padding: 0.8rem 0.9rem;
			gap: 0.85rem;
			flex-wrap: wrap;
		}

		.docs-header__nav {
			width: 100%;
			justify-content: flex-start;
			gap: 0.9rem;
			flex-wrap: wrap;
		}

		.hero {
			padding: 5rem 18px 2.75rem;
		}

		.hero__lead {
			font-size: 0.98rem;
			line-height: 1.62;
		}

		.hero__actions {
			flex-direction: column;
			align-items: stretch;
		}

		.hero__actions .btn {
			justify-content: center;
			width: 100%;
		}

		.hero__trust {
			gap: 0.55rem 1rem;
			font-size: 0.78rem;
		}

		.docs-shell {
			padding: 20px 14px 48px;
		}

		.doc-card {
			padding: 22px 0 20px;
		}

		h1,
		h2,
		h3 {
			overflow-wrap: anywhere;
			hyphens: auto;
		}

		.doc-subsection + .doc-subsection {
			margin-top: 22px;
		}

		.equations :global(.formula),
		.equations :global(div) {
			padding: 10px 12px;
			font-size: 0.96rem;
			line-height: 1.4;
			text-align: left;
			overflow-x: auto;
		}

		.symbols__row {
			grid-template-columns: 1fr;
			gap: 4px;
			padding: 8px 0;
		}

		.doc-figure,
		.doc-figure-toggle .doc-figure {
			padding: 10px;
		}

		.doc-figure-toggle summary,
		.doc-table-toggle summary {
			padding: 0.75rem 0.85rem;
			font-size: 0.88rem;
		}

		.doc-table-toggle .doc-table-caption,
		.doc-table-toggle .doc-table-note {
			padding-left: 0.85rem;
			padding-right: 0.85rem;
		}

		.doc-table-toggle .doc-table-scroll {
			margin: 0 0.85rem;
		}

		.doc-table {
			font-size: 0.88rem;
			min-width: 720px;
		}

		.doc-table th,
		.doc-table td {
			padding: 0.62rem 0.68rem;
		}

		.notes,
		.reference-list {
			padding-left: 1rem;
		}

		.notes li,
		.reference-list li,
		.symbols__row dd,
		.doc-figure figcaption,
		.doc-table-caption,
		.doc-table-note,
		.refs-inline,
		.docs-nav a {
			overflow-wrap: anywhere;
			word-break: normal;
			hyphens: auto;
		}

		.docs-footer {
			padding: 3.5rem 18px 1.75rem;
		}
	}

	@media (max-width: 460px) {
		.hero__trust span {
			padding-right: 0;
		}

		.hero__trust span::after {
			display: none;
		}

		.docs-shell {
			padding-left: 12px;
			padding-right: 12px;
		}

		.doc-table {
			min-width: 640px;
		}
	}

	@media (prefers-color-scheme: dark) {
		.docs-page {
			background: #111110;
			color: #ede9e1;
			--color-primary: #ede9e1;
			--color-text: #ede9e1;
			--color-text-light: #c5c1ba;
			--color-text-muted: #8a8a82;
			--color-border: rgba(237, 233, 225, 0.09);
			--color-border-strong: rgba(237, 233, 225, 0.18);
		}

		.docs-header {
			margin-bottom: -5.75rem;
			background: transparent;
		}

		.docs-header__inner {
			background: rgba(17, 17, 16, 0.88);
			border-color: rgba(237, 233, 225, 0.08);
			box-shadow: 0 8px 24px rgba(12, 12, 11, 0.32);
		}

		.docs-header__logo,
		.docs-header__nav a {
			color: var(--color-text-on-dark);
		}

		.hero {
			background:
				linear-gradient(135deg, rgba(79, 133, 132, 0.12), transparent 38%),
				linear-gradient(180deg, #111110 0%, #181818 100%);
		}

		.hero__eyebrow,
		.docs-nav__title,
		.section-label {
			color: var(--color-accent-hover);
		}

		p,
		.refs-inline,
		.docs-nav a,
		.hero__lead,
		.hero__trust {
			color: var(--color-text-on-dark-muted);
		}

		.symbols {
			border-top-color: rgba(237, 233, 225, 0.08);
		}

		.symbols__title {
			color: var(--color-text-muted);
		}

		.symbols__row dt {
			color: var(--color-text-on-dark);
		}

		.symbols__row dd {
			color: var(--color-text-on-dark-muted);
		}

		h3 {
			color: var(--color-text-on-dark);
		}

		.doc-card {
			border-top-color: rgba(237, 233, 225, 0.08);
		}

		.equations :global(.formula),
		.equations :global(div) {
			background: transparent;
			border: none;
			border-left: 2px solid rgba(237, 233, 225, 0.14);
			color: var(--color-text-on-dark);
		}

		.doc-figure {
			background: rgba(255,255,255,0.03);
			border-color: rgba(237, 233, 225, 0.08);
		}

		.doc-figure-toggle {
			border-color: rgba(237, 233, 225, 0.08);
			background: rgba(255, 255, 255, 0.03);
		}

		.doc-figure-toggle summary {
			color: var(--color-text-on-dark);
		}

		.doc-figure-toggle summary::after {
			color: var(--color-text-on-dark-muted);
		}

		.doc-figure-toggle .doc-figure {
			border-top-color: rgba(237, 233, 225, 0.08);
		}

		.doc-table-toggle {
			border-color: rgba(237, 233, 225, 0.08);
			background: rgba(255, 255, 255, 0.03);
		}

		.doc-table-toggle summary {
			color: var(--color-text-on-dark);
		}

		.doc-table-toggle summary::after {
			color: var(--color-text-on-dark-muted);
		}

		.doc-figure img {
			border-color: rgba(237, 233, 225, 0.08);
			background: #f7f4ef;
		}

		.doc-figure figcaption {
			color: var(--color-text-on-dark-muted);
		}

		.doc-table-scroll {
			border-color: rgba(237, 233, 225, 0.08);
			background: rgba(255, 255, 255, 0.03);
		}

		.doc-table th,
		.doc-table td {
			border-bottom-color: rgba(237, 233, 225, 0.08);
		}

		.doc-table th {
			background: rgba(237, 233, 225, 0.05);
			color: var(--color-text-on-dark);
		}

		.doc-table td,
		.doc-table-note {
			color: var(--color-text-on-dark-muted);
		}

		.doc-table-caption {
			color: var(--color-text-on-dark);
		}

		.btn--primary {
			background: var(--color-text-on-dark);
			color: #111110;
		}

		.btn--primary:hover {
			background: #ffffff;
		}

		.btn--outline-dark {
			color: var(--color-text-on-dark);
			border-color: rgba(237, 233, 225, 0.18);
		}

		.btn--outline-dark:hover {
			background: rgba(237, 233, 225, 0.05);
			border-color: rgba(237, 233, 225, 0.32);
		}
	}
</style>
