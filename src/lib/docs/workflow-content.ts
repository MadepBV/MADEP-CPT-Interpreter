export type Reference = {
	label: string;
	detail: string;
};

export type ReferenceGroup = {
	title: string;
	items: Reference[];
};

export type DocFigure = {
	src: string;
	alt: string;
	caption: string;
	collapsible?: boolean;
	summary?: string;
};

export type DocTable = {
	caption: string;
	note?: string;
	collapsible?: boolean;
	summary?: string;
	columns: { key: string; label: string }[];
	rows: Record<string, string>[];
};

export type DocSubsection = {
	id: string;
	title: string;
	paragraphs: string[];
	equations?: string[];
	bullets?: string[];
	symbols?: { term: string; meaning: string }[];
	figures?: DocFigure[];
	table?: DocTable;
};

export type DocSection = {
	id: string;
	title: string;
	intro: string;
	references: string[];
	subsections: DocSubsection[];
};

export const nenTable3Rows: Record<string, string>[] = [
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

export const alphaMethodRows: Record<string, string>[] = [
	{ method: 'A — Sanglerat', family: 'Behavioural type', soil: 'Peat / organic', qc: 'any', rule: 'Sanglerat fixed default', expression: 'α = 1.5' },
	{ method: 'A — Sanglerat', family: 'Behavioural type', soil: 'Soft clay', qc: 'any', rule: 'Sanglerat fixed default', expression: 'α = 3.0' },
	{ method: 'A — Sanglerat', family: 'Behavioural type', soil: 'Clay', qc: 'any', rule: 'Sanglerat fixed default', expression: 'α = 5.0' },
	{ method: 'A — Sanglerat', family: 'Behavioural type', soil: 'Sandy clay', qc: 'any', rule: 'Sanglerat fixed default', expression: 'α = 8.0' },
	{ method: 'A — Sanglerat', family: 'Behavioural type', soil: 'Silty sand', qc: 'any', rule: 'Sanglerat fixed default', expression: 'α = 10.0' },
	{ method: 'A — Sanglerat', family: 'Behavioural type', soil: 'Sand', qc: 'any', rule: 'Sanglerat fixed default', expression: 'α = 13.0' },
	{ method: 'A — Sanglerat', family: 'Behavioural type', soil: 'Gravel', qc: 'any', rule: 'Sanglerat fixed default', expression: 'α = 15.0' },
	{ method: 'B — SB260', family: 'Cohesive', soil: 'veen, ...', qc: 'any', rule: 'SB260 default when w unknown', expression: 'α = 1.5' },
	{ method: 'B — SB260', family: 'Cohesive', soil: 'klei, ...', qc: 'q<sub>c</sub> &lt; 0.7; 0.7 ≤ q<sub>c</sub> &lt; 2.0; q<sub>c</sub> ≥ 2.0', rule: 'SB260 GEO column by q<sub>c</sub> band', expression: 'α = 5.0; 3.0; 1.5' },
	{ method: 'B — SB260', family: 'Cohesive', soil: 'leem, ...', qc: 'q<sub>c</sub> &lt; 2.0; q<sub>c</sub> ≥ 2.0', rule: 'SB260 GEO column by q<sub>c</sub> band', expression: 'α = 4.0; 2.0' },
	{ method: 'B — SB260', family: 'Transition (overgangsgronden)', soil: 'klei (zh), ... / leem (zh), ... / zand (lh), ...', qc: 'q<sub>c</sub> &lt; 2.5', rule: 'SB260 transition rule', expression: 'α = 2.0' },
	{ method: 'B — SB260', family: 'Transition (overgangsgronden)', soil: 'klei (zh), ... / leem (zh), ... / zand (lh), ...', qc: '2.5 ≤ q<sub>c</sub> &lt; 5.0', rule: 'SB260 E<sub>s</sub> = 4q<sub>c</sub> − 5', expression: 'α = (4q<sub>c</sub> − 5) / q<sub>c</sub>' },
	{ method: 'B — SB260', family: 'Transition (overgangsgronden)', soil: 'klei (zh), ... / leem (zh), ... / zand (lh), ...', qc: 'q<sub>c</sub> ≥ 5.0', rule: 'SB260 transition cap (extrapolated)', expression: 'α = 2.0' },
	{ method: 'B — SB260', family: 'Granular (zandgronden)', soil: 'zand, ... / grind, ... / grind (kh), ...', qc: 'q<sub>c</sub> ≤ 10', rule: 'SB260 NC zandgronden', expression: 'E<sub>s</sub> = 4q<sub>c</sub>, so α = 4.0' },
	{ method: 'B — SB260', family: 'Granular (zandgronden)', soil: 'zand, ... / grind, ... / grind (kh), ...', qc: '10 &lt; q<sub>c</sub> ≤ 50', rule: 'SB260 NC zandgronden', expression: 'E<sub>s</sub> = 2q<sub>c</sub> + 20, so α = (2q<sub>c</sub> + 20) / q<sub>c</sub>' },
	{ method: 'B — SB260', family: 'Granular (zandgronden)', soil: 'zand, ... / grind, ... / grind (kh), ...', qc: 'q<sub>c</sub> &gt; 50', rule: 'SB260 NC zandgronden', expression: 'E<sub>s</sub> = 120, so α = 120 / q<sub>c</sub>' }
];

export const workflowReferenceGroups: ReferenceGroup[] = [
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
		title: 'Belgian and Dutch practice documents',
		items: [
			{ label: 'SB260', detail: 'Standaardbestek 260, artikel 21-6.4.10: karakteristieke grondparameters op basis van elektrische sondering.' },
			{ label: 'CUR 2003-7', detail: 'CPT-correlated geotechnical parameter guidance used in Belgian and Dutch practice.' },
			{ label: 'NEN 6740', detail: 'Dutch geotechnical design standard with stress-dependent CPT material classification.' },
			{ label: 'Deltares D-SHEET Piling User Manual', detail: 'Version 24.1; §34.2.2 documents the NEN stress-correction formula q<sub>c,NEN</sub> = q<sub>c</sub>(100 / σ′<sub>v0</sub>)<sup>0.67</sup>.' },
			{ label: 'PLAXIS 2D 2018 Reference Manual', detail: 'Reference manual showing the broad CUR 3 layers classification chart with Sand, Silt, Clay, and Peat fields.' }
		]
	},
	{
		title: 'PLAXIS workflows',
		items: [
			{ label: 'PLAXIS 2D Material Models Manual (2025.1)', detail: 'Official material-model manual giving the Mohr-Coulomb Young’s modulus guidance and Hooke-law stiffness relations.' },
			{ label: 'Bentley KB0109063', detail: 'How to define and edit a material via the command line; documents the supported soilmat workflow.' },
			{ label: 'Bentley KB0109071', detail: 'PLAXIS soil model numbers for command-line material creation.' },
			{ label: 'Bentley KB0043470', detail: 'Re-using materials from other projects in PLAXIS, including project-to-database workflows.' },
			{ label: 'Bentley KB0108936', detail: 'Material parameter datasets article whose sample package shows modern .matXdb content on disk.' }
		]
	},
	{
		title: 'Hydraulic conductivity and constitutive parameter sources',
		items: [
			{ label: 'Schanz, Vermeer & Bonnier (1999)', detail: 'The Hardening Soil model: formulation and stress-dependent stiffness basis.' },
			{ label: 'OVAM / I-RA-11461 (2002)', detail: 'Indicative hydraulic conductivity ranges by Belgian texture class.' },
			{ label: 'De Smedt / VUB (2005)', detail: 'Indicative hydraulic conductivity ranges by USDA texture class.' }
		]
	},
	{
		title: 'Classic theoretical references',
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
		title: 'Foundation models',
		items: [
			{ label: 'Hetényi (1946)', detail: 'Beams on Elastic Foundation.' },
			{ label: 'Vesić (1961a)', detail: 'Bending of beams resting on isotropic elastic solid.' },
			{ label: 'Vesić (1961b)', detail: 'Beams on elastic subgrade and Winkler’s hypothesis.' },
			{ label: 'Pasternak (1954)', detail: 'On a New Method of Analysis of an Elastic Foundation by Means of Two Foundation Constants.' },
			{ label: 'Kerr (1964)', detail: 'Elastic and viscoelastic foundation models.' }
		]
	}
];

export const workflowScopeSection: DocSection = {
	id: 'scope',
	title: '0A. Scope And Document Basis',
	intro:
		'This chapter documents the technical logic of the CPT interpreter from raw CPT file import through the interpreted layer state handed into Stage 6. It is written as a theory-and-implementation record: formulas, classifications, parameter routes, engineering assumptions, and the principal references behind the current workflow.',
	subsections: [
		{
			id: 'scope-applications',
			title: '0A.1 Coverage',
			paragraphs: [
				'The documentation covers the current implemented interpretation workflow: CPT file parsing for GEF, Excel, and CSV sources, per-point CPT classification, layer detection, layer parameter assignment, stiffness derivation, and experimental m-fitting. It is intended as the full technical account of Stages 1 to 5 rather than a short product summary.',
				'Where the application contains an engineering simplification, the simplification is stated explicitly. The purpose is not to replace engineering judgement, but to make the implemented mathematics auditable and readable.'
			],
			bullets: [
				'Classification and boundary logic are documented separately from parameter assignment.',
				'Stage 6 uses the interpreted CPT state produced by the earlier stages rather than reclassifying the profile independently.',
				'The notation follows geotechnical convention with compression positive and depth measured downward.'
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
};

export const workflowStageSections: DocSection[] = [
	{
		id: 'stage1',
		title: '1. Stage 1 — CPT File Loading',
		intro:
			'The first stage reconstructs a usable CPT dataset from the uploaded source file. Rich GEF files and Excel workbooks with Header/Data sheets are preferred because they carry metadata, water level, surface level, and coordinates. Minimal CSV files are also accepted when only the measurement trace is available.',
		subsections: [
			{
				id: 'stage1-mapping',
				title: '1.1 Supported file structures and column mapping',
				paragraphs: [
					'GEF files declare their physical quantities through <code>#COLUMNINFO</code> lines. The application reads the quantity identifier and maps it to the relevant column index; column order is therefore never assumed.',
					'Excel workbooks are read from a <code>Data</code> sheet and, when present, a <code>Header</code> sheet. The Data sheet may contain depth, q<sub>c</sub>, f<sub>s</sub>, and R<sub>f</sub>; the Header sheet can provide project, test, location, date, water level, surface level, coordinates, and the net area ratio.',
					'CSV files are the reduced-input route. They must contain headers named <code>depth</code> and <code>qc</code>. Optional headers are <code>fs</code> and <code>rf</code>. Comma, semicolon, and tab delimiters are detected automatically.',
					'A recommended minimal CSV header is <code>depth [m], qc [MPa], fs [MPa]</code>. If decimal commas are used in the values, a semicolon-delimited CSV is recommended.'
				],
				bullets: [
					'GEF quantity 1: penetration length.',
					'GEF quantity 2: q<sub>c</sub>.',
					'GEF quantity 3: f<sub>s</sub>.',
					'GEF quantity 4: R<sub>f</sub>.',
					'GEF quantity 6: u<sub>2</sub>.',
					'GEF quantity 11: corrected depth, used before quantity 1 when both are present.',
					'Excel/CSV column headers may include units, for example <code>qc [MPa]</code>, <code>fs kPa</code>, or <code>Friction ratio (Rf) in %</code>.'
				]
			},
			{
				id: 'stage1-units',
				title: '1.2 Unit conversion and row filtering',
				paragraphs: [
					'The parser converts q<sub>c</sub> and f<sub>s</sub> to MPa based on the declared GEF unit string or the Excel/CSV column header. Headers containing MPa are used directly; kPa is divided by 1000; Pa is divided by 1 000 000.',
					'If the unit declaration is absent or ambiguous, a heuristic fallback is used so the file remains workable: q<sub>c</sub> values above 100 are treated as kPa, otherwise MPa; f<sub>s</sub> values above 1000 are treated as Pa, values above 10 as kPa, otherwise MPa. Explicit unit labels are therefore strongly recommended.',
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
					'Depth is expected in metres below surface.',
					'R<sub>f</sub> is optional; when absent or invalid, the app computes it from f<sub>s</sub> and q<sub>c</sub>.',
					'Rows with z &lt; 0 are discarded.',
					'Rows with q<sub>c</sub> &lt; 0.02 MPa are treated as cone-not-engaged and discarded.',
					'All-zero rows appended by logging software are discarded.'
				]
			},
			{
				id: 'stage1-water',
				title: '1.3 Water table, elevation, and header metadata',
				paragraphs: [
					'The phreatic level is first taken from the GEF measurement variables or the Excel Header field <code>Waterniveau</code> when available; otherwise a default depth below surface is assigned. CSV files do not carry this metadata, so the engineer should review or override the default after import.',
					'Surface elevation is read from the GEF ZID header, the Excel Header field <code>Grondniveau</code>, or entered manually. When present, all depth values can be expressed relative to TAW as well as depth below surface.'
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
				symbols: [{ term: 't<sub>min</sub>', meaning: 'minimum retained layer thickness [m]' }],
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
					'The first stiffness step converts the representative cone resistance into an oedometric modulus through one of two α correlations selected in the Stage 4 UI: <strong>Method A — Sanglerat literature</strong> (fixed α per behavioural soil type) or <strong>Method B — SB260-21-6.4.10</strong> (q<sub>c</sub>-graded family rules). Method A and Method B are alternative routes that produce different α — and hence different E<sub>oed,i</sub> — for the same layer.',
					'Method A applies fixed Sanglerat-style α defaults keyed to the broad layer <em>type</em> (Peat, Soft clay, Clay, Sandy clay, Silty sand, Sand, Gravel). All rows in the layer share one α regardless of q<sub>c</sub>.',
					'Method B applies the SB260-21-6.4.10 Tabel 21-6-5 rules, structured around three families — <strong>cohesive</strong> (klei, leem, veen), <strong>transition / overgangsgronden</strong> (the (zh) and (lh) subtype variants), and <strong>granular / zandgronden</strong> (zand, grind, grind (kh)). The family is selected from the EC7 subtype string first, falling back to the broad type when no subtype is set, and α (or E<sub>s</sub>) varies with q<sub>c</sub> within the family.',
					'The full implemented α mapping is shown in the expandable reference table below so the reader can audit exactly which family, q<sub>c</sub> band, or modulus formula is applied.'
				],
				equations: [
					'E<sub>oed,i</sub> = α · avg q<sub>c</sub> · 1000',
					'<em>Method A — Sanglerat fixed α by behavioural type:</em>',
					'α = 1.5 (Peat / organic), 3.0 (Soft clay), 5.0 (Clay), 8.0 (Sandy clay)',
					'α = 10.0 (Silty sand), 13.0 (Sand), 15.0 (Gravel)',
					'<em>Method B — SB260-21-6.4.10 by family, keyed to the EC7 subtype:</em>',
					'<em>Cohesive:</em>',
					'α = 1.5 &nbsp;&nbsp; for veen, ... (any q<sub>c</sub>; w unknown in app)',
					'α = 5, 3, 1.5 &nbsp;&nbsp; for klei, ... with q<sub>c</sub> &lt; 0.7, 0.7–2.0, ≥ 2.0 MPa',
					'α = 4, 2 &nbsp;&nbsp; for leem, ... with q<sub>c</sub> &lt; 2.0, ≥ 2.0 MPa',
					'<em>Transition (overgangsgronden):</em>',
					'α = 2.0; (4q<sub>c</sub> − 5)/q<sub>c</sub>; 2.0 &nbsp;&nbsp; for klei (zh) / leem (zh) / zand (lh) with q<sub>c</sub> &lt; 2.5, 2.5–5.0, ≥ 5.0 MPa',
					'<em>Granular (zandgronden):</em>',
					'α = 4.0; (2q<sub>c</sub> + 20)/q<sub>c</sub>; 120/q<sub>c</sub> &nbsp;&nbsp; for zand / grind / grind (kh) with q<sub>c</sub> ≤ 10, 10–50, &gt; 50 MPa'
				],
				symbols: [
					{ term: 'α', meaning: 'q<sub>c</sub>-to-stiffness correlation factor [-] (Sanglerat literature in Method A; SB260-21-6.4.10 in Method B)' },
					{ term: 'avg q<sub>c</sub>', meaning: 'mean cone resistance of the layer [MPa]' },
					{ term: 'E<sub>oed,i</sub>', meaning: 'CPT-derived oedometric stiffness before reference-stress correction [kPa]' },
					{ term: 'E<sub>s</sub>', meaning: 'SB260 secant stiffness used in the granular and transition rules [MPa]' }
				],
				bullets: [
					'Method A produces the higher α values for granular soils (Sand = 13, Gravel = 15) characteristic of Sanglerat literature. Method B uses the SB260 zandgronden rule E<sub>s</sub> = 4q<sub>c</sub> / 2q<sub>c</sub>+20 / 120, which gives much smaller effective α (e.g. α = 4 for q<sub>c</sub> ≤ 10 MPa). The two methods are not interchangeable — Method A and Method B will give different E<sub>oed,i</sub> for the same layer.',
					'Method A keys off the broad layer type (l.type) only. Method B keys off the EC7 subtype string first and falls back to type when no subtype is available.',
					'For peat, water content w is not available in the app, so Method B uses the SB260 default α = 1.5 (the conservative branch of Tabel 21-6-5 for veen).',
					'The (zh) / (lh) suffix on klei / leem / zand routes to the transition family. The (kh) suffix on grind routes to the granular family.'
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
				id: 'stage4-refstress',
				title: '4.3 Reference-stress correction (shared by Methods A and B)',
				paragraphs: [
					'Both Method A and Method B apply the same Hardening Soil reference-stress correction to convert the in-situ E<sub>oed,i</sub> from §4.2 into the reference-stress quantity E<sub>oed,ref</sub> at p<sub>ref</sub> = 100 kPa. The cohesion-corrected form is used so the correction remains well-behaved in cohesive layers where σ′<sub>v0</sub> can be small relative to c′cotφ′.',
					'Methods A and B differ <em>only</em> in how E<sub>50,ref</sub> and E<sub>ur,ref</sub> are derived from this shared E<sub>oed,ref</sub>; the depth correction itself is identical in both routes.',
					'The CUR 2003-7 stress-exponent default is binary: m = 0.5 for granular soils (Sand, Silty sand, Gravel) and m = 1.0 for cohesive soils (Sandy clay / leem, Clay, Soft clay, Peat / organic). The Stage 5 m-fitting routine can override the m default per layer when site-specific evidence supports a different value.'
				],
				equations: [
					"E<sub>oed,ref</sub> = E<sub>oed,i</sub> · [(p<sub>ref</sub> + c′cotφ′)/(σ′<sub>v0</sub> + c′cotφ′)]<sup>m</sup>",
					'p<sub>ref</sub> = 100 kPa',
					'm = 0.5 &nbsp;&nbsp; granular soils (Sand, Silty sand, Gravel)',
					'm = 1.0 &nbsp;&nbsp; cohesive soils (Sandy clay / leem, Clay, Soft clay, Peat)'
				],
				symbols: [
					{ term: 'E<sub>oed,ref</sub>', meaning: 'reference oedometric stiffness at p<sub>ref</sub> [kPa]' },
					{ term: 'm', meaning: 'Hardening Soil stress exponent [-]' },
					{ term: 'p<sub>ref</sub>', meaning: 'reference confining stress, 100 kPa' },
					{ term: 'σ′<sub>v0</sub>', meaning: 'effective vertical stress at layer midpoint [kPa]' },
					{ term: "c′, φ′", meaning: 'effective cohesion [kPa] and friction angle [°]' }
				],
				bullets: [
					'The stress-exponent default mirrors the CUR 2003-7 binary 0.5 / 1.0 split rather than the more nuanced PLAXIS-style 0.5 / 0.7 / 0.85 / 1.0 grading. The intent is to align the documented method (CUR 2003-7) with the implemented default; per-layer engineer override and Stage 5 m-fitting remain available.',
					'The cohesion-corrected denominator uses c′cotφ′ as a Mohr-Coulomb consistency term so the depth correction stays bounded in cohesive layers; this matches Schanz, Vermeer &amp; Bonnier (1999) and the SB260-21-6.4.10 form.'
				]
			},
			{
				id: 'stage4-method-a',
				title: '4.4 Method A — CUR 2003-7 stiffness ratios',
				paragraphs: [
					'Method A takes the shared E<sub>oed,ref</sub> from §4.3 and applies the CUR 2003-7 family rule to derive E<sub>50,ref</sub>. E<sub>ur,ref</sub> is taken as three times E<sub>50,ref</sub>. The family rule treats klei and leem together, so Sandy clay (leem) is in the cohesive set with the 1.25 factor; for granular soils E<sub>50,ref</sub> is set equal to E<sub>oed,ref</sub>. ν<sub>ur</sub> = 0.20 (CUR 2003-7 / PLAXIS 2D Manual).'
				],
				equations: [
					'E<sub>50,ref</sub> = E<sub>oed,ref</sub> &nbsp;&nbsp; granular soils',
					'E<sub>50,ref</sub> = 1.25E<sub>oed,ref</sub> &nbsp;&nbsp; cohesive soils (klei en leem)',
					'E<sub>ur,ref</sub> = 3E<sub>50,ref</sub>',
					'ν<sub>ur</sub> = 0.20',
					'K<sub>0,nc</sub> = 1 − sinφ′'
				],
				symbols: [
					{ term: 'E<sub>50,ref</sub>', meaning: 'reference secant stiffness for primary loading [kPa]' },
					{ term: 'E<sub>ur,ref</sub>', meaning: 'reference unloading/reloading stiffness [kPa]' },
					{ term: 'ν<sub>ur</sub>', meaning: 'unloading/reloading Poisson ratio [-]' },
					{ term: 'K<sub>0,nc</sub>', meaning: 'at-rest earth-pressure coefficient for normally consolidated state [-]' }
				],
				bullets: [
					'The cohesive set for the E<sub>50</sub>/E<sub>oed</sub> = 1.25 ratio includes Sandy clay (leem) — the CUR 2003-7 rule is "klei en leem", not "klei alone".',
					'E<sub>ur,ref</sub> = 3E<sub>50,ref</sub> follows aGEO practice and is a Hardening-Soil convention shared with the PLAXIS 2D Manual.'
				]
			},
			{
				id: 'stage4-method-b',
				title: '4.5 Method B — E<sub>50,ref</sub> = E<sub>oed,ref</sub>',
				paragraphs: [
					'Method B takes the shared E<sub>oed,ref</sub> from §4.3 and sets E<sub>50,ref</sub> equal to E<sub>oed,ref</sub> for all soils. E<sub>ur,ref</sub> remains three times the selected E<sub>50,ref</sub>.',
					'This gives a single consistent reference stiffness and is sometimes preferred in practice when the engineer wants to avoid the cohesive-soil E<sub>50</sub>/E<sub>oed</sub> split.'
				],
				equations: ['E<sub>50,ref</sub> = E<sub>oed,ref</sub>', 'E<sub>ur,ref</sub> = 3E<sub>oed,ref</sub>']
			},
			{
				id: 'stage4-conductivity',
				title: '4.6 Hydraulic conductivity basis',
				paragraphs: [
					'The app uses indicative hydraulic conductivity values tied to Belgian and USDA-style texture classes, with OVAM (Tabel 2-44) and De Smedt / VUB (Tabel 2-45) as the principal reference sources for the I/RA/11461.15.066/JSW guideline. The representative value is treated as a geometric-mean estimate within the adopted class range rather than a deterministic measurement.',
					'Anisotropy is then introduced through a k<sub>h</sub>/k<sub>v</sub> ratio. Sand and gravel are taken as isotropic. Cohesive soils (clay, sandy clay / leem, peat) are taken as k<sub>h</sub>/k<sub>v</sub> = 3. Silty sand ("fijn zand") sits between the two regimes; the engineer selects between a Stage 4 anisotropy method that controls how that intermediate case is treated.',
					'For the PLAXIS material-command export, the internally stored conductivities are converted from m/s to m/day before they are written to the command file.'
				],
				equations: [
					'k<sub>h,rep</sub> = √(k<sub>h,min</sub>k<sub>h,max</sub>)',
					'k<sub>v</sub> = k<sub>h</sub> / a<sub>kv</sub>',
					'a<sub>kv</sub> = 1 &nbsp;&nbsp; clean sand and gravel (both methods)',
					'a<sub>kv</sub> = 3 &nbsp;&nbsp; clay, sandy clay (leem), peat (both methods)',
					'a<sub>kv</sub> = 3 &nbsp;&nbsp; silty sand &nbsp; under method A (OVAM / I/RA/11461)',
					'a<sub>kv</sub> = 2 &nbsp;&nbsp; silty sand &nbsp; under method B (Bear, 1979)',
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
					'Method A — OVAM / I/RA/11461 (default): conservative engineering practice. Silty sand is grouped with the fine soils, k<sub>h</sub>/k<sub>v</sub> = 3.',
					'Method B — Bear (1979) academic: literature-typical intermediate value for fine / silty sand, k<sub>h</sub>/k<sub>v</sub> = 2. Reflects the partly-cohesive nature of silty sand without lumping it fully with cohesive soils.',
					'Sand and gravel remain isotropic (k<sub>h</sub>/k<sub>v</sub> = 1) under both methods. Cohesive soils (clay, sandy clay, peat) keep k<sub>h</sub>/k<sub>v</sub> = 3 under both methods.',
					'ψ<sub>unsat</sub> (height of partially saturated zone above the water table) follows the PLAXIS 2D Manual: 0.1 m for sand / silty sand / gravel, 1 m for sandy clay (leem), 3 m for clay and peat.',
					'In-situ measurement takes priority over indicative table values.'
				]
			},
			{
				id: 'stage4-plaxis-export',
				title: '4.7 PLAXIS material-command export',
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
					'Method A gives E50,i = 1.25 EOed,i for the cohesive set — Sandy clay (leem), Clay, Soft clay, and Peat / organic — and E50,i = EOed,i for the granular set (Sand, Silty sand, Gravel). Method B gives E50,i = EOed,i for all soils.',
					'Only clean sand and clean gravel are exported as Drained by default. Fines-bearing granular subtypes such as zand (lh) and grind (kh) are exported as Undrained A.',
					'The export intentionally omits RF, nuUR, and K0NC in the current tested PLAXIS workflow so PLAXIS can keep those automatic or read-only values under its own control.',
					'cu and psi_unsat are not written by the material-command export. Undrained A uses the effective stress strength parameters, and psi_unsat remains available in the app without yet being exported.'
				]
			}
		],
		references: [
			'SB260',
			'CUR 2003-7',
			'Schanz, Vermeer & Bonnier (1999)',
			'OVAM / I-RA-11461 (2002)',
			'De Smedt / VUB (2005)',
			'PLAXIS 2D Material Models Manual (2025.1)',
			'Bentley KB0109063',
			'Bentley KB0109071',
			'Bentley KB0043470',
			'Bentley KB0108936'
		]
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
	}
];

export const workflowConventionsSection: DocSection = {
	id: 'conventions',
	title: '6. Global Engineering Conventions',
	intro:
		'The engineering analyses that follow the interpretation workflow share one common stress and stiffness basis. The equations below define the sign convention, the in-situ stress profile, the Hardening Soil reference-stress convention, and the general profile discretisation logic used by the engineering applications.',
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
};

export const workflowSections: DocSection[] = [
	workflowScopeSection,
	...workflowStageSections,
	workflowConventionsSection
];
