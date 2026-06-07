// SPDX-License-Identifier: AGPL-3.0-or-later

export type DocsLink = {
	title: string;
	path: string;
	summary: string;
	tag?: string;
};

export type DocsGroup = {
	title: string;
	path: string;
	summary: string;
	pages: DocsLink[];
};

export const docsGroups: DocsGroup[] = [
	{
		title: 'CPT interpretation',
		path: '/docs/workflow',
		summary:
			'Stages 1 to 5 of the application flow: GEF, Excel, and CSV import, CPT classification, layer derivation, parameter assignment, and optional stress-dependency fitting.',
		pages: [
			{
				title: 'Stage 1 — CPT loading',
				path: '/docs/workflow#stage1',
				summary: 'GEF, Excel Header/Data, and reduced CSV import with quantity mapping, unit conversion, and row filtering.'
			},
			{
				title: 'Stage 2 — Classification',
				path: '/docs/workflow#stage2',
				summary:
					'Robertson 1990 / 2016, CUR broad zoning, NEN 6740, and direct NEN Tabel 3 subtype assignment.'
			},
			{
				title: 'Stage 3 — Layers',
				path: '/docs/workflow#stage3',
				summary:
					'Raw segmentation, smart merge correction, minimum-thickness enforcement, and subtype suggestion.'
			},
			{
				title: 'Stage 4 — Model parameters',
				path: '/docs/workflow#stage4',
				summary:
					'Effective stress, alpha methods, stiffness derivation, conductivity defaults, and export-ready parameters.'
			},
			{
				title: 'Stage 5 — m-fitting',
				path: '/docs/workflow#stage5',
				summary:
					'Experimental stress-dependent stiffness fitting from CPT-derived oedometer trends.'
			}
		]
	},
	{
		title: 'Stage 6 engineering analyses',
		path: '/docs/engineering',
		summary:
			'Stage 6 of the application flow: slope stability, seepage, deformation, settlement screening, and related design checks.',
		pages: [
			{
				title: 'Slope stability',
				path: '/docs/engineering/bishop',
				summary:
					'Bishop Simplified search, Spencer verification, slice handling, and the current circular slope-stability workflow.',
				tag: 'Stage 6'
			},
			{
				title: 'Seepage analysis',
				path: '/docs/engineering/seepage',
				summary:
					'Steady-state FEM seepage, free-surface iteration, boundary-condition logic, and coupled outputs.'
			},
			{
				title: 'Deformation analysis',
				path: '/docs/engineering/deformation',
				summary:
					'Plane-strain deformation, geostatic initialization, Stage 1 and Stage 2 constitutive routes, and plotted fields.'
			},
			{
				title: 'Bearing capacity',
				path: '/docs/engineering/bearing',
				summary: 'Shallow-foundation bearing resistance, EC7 Annex D style factors, and Belgian DA1 handling.'
			},
			{
				title: 'Pile capacity',
				path: '/docs/engineering/pile',
				summary:
					'CPT-based axial pile resistance and SLS settlement: De Beer scale-effect base resistance, Belgian shaft-friction table, ULS factor chain, F_nk screening, and load-transfer settlement.'
			},
			{
				title: 'Dewatering',
				path: '/docs/engineering/dewatering',
				summary:
					'Radius-of-influence screening, layered transmissivity, drawdown profiles, and drawdown-induced stress effects.'
			},
			{
				title: 'Settlement',
				path: '/docs/engineering/settlement',
				summary:
					'Stress-increase integration, constrained-modulus settlement, truncation rules, and optional time interpretation.'
			},
			{
				title: 'Beam / slab on elastic foundation',
				path: '/docs/engineering/beam',
				summary:
					'k-s derivation from CPT stiffness, Winkler/Pasternak strip equations, and the present structural-geotechnical screening route.'
			},
			{
				title: 'ULS reinforcement output',
				path: '/docs/engineering/reinforcement',
				summary:
					'Strip-based EC2 reinforcement screening from design moment, material factors, and cover assumptions.'
			},
			{
				title: 'Retaining walls',
				path: '/docs/engineering/retaining-wall',
				summary:
					'Belgian Eurocode 7 (NBN EN 1997-1 ANB, DA1) verification of gravity, RC cantilever, and embedded sheet-pile walls: earth-pressure model, GEO/EQU/SLS checks, structural design forces, and the C++/WASM solver.',
				tag: 'Stage 6'
			}
		]
	},
	{
		title: 'Methods and assumptions',
		path: '/docs/theory',
		summary:
			'Cross-cutting notation, effective-stress conventions, CPT-to-parameter formulas, seepage equations, deformation equations, and documented numerical approximations.',
		pages: [
			{
				title: 'Core conventions',
				path: '/docs/theory#conventions',
				summary:
					'Compression-positive stress, effective stress, plane-strain assumptions, and the shared notation used by the engineering modules.'
			},
			{
				title: 'CPT-to-parameter derivation',
				path: '/docs/theory#parameters',
				summary:
					'Representative formulas for friction ratio, constrained modulus, reference-stress correction, and stiffness-family mapping.'
			},
			{
				title: 'Seepage governing equations',
				path: '/docs/theory#seepage',
				summary:
					'Darcy flow, the steady-state Laplace or Poisson problem, boundary-condition classes, and FEM interpretation.'
			},
			{
				title: 'Deformation governing equations',
				path: '/docs/theory#deformation',
				summary:
					'Residual equilibrium, plane-strain stress update, geostatic initialization, and constitutive branching.'
			},
			{
				title: 'Numerical approximations',
				path: '/docs/theory#numerics',
				summary:
					'Documented numerical choices including T3 triangles, smoothed Stage 2.1 plasticity, free-surface iteration, and related approximations.'
			}
		]
	},
	{
		title: 'Standards and references',
		path: '/docs/reference',
		summary:
			'The source library behind the app: standards, literature, bibliographic basis, export meaning, and audit links.',
		pages: [
			{
				title: 'Source families',
				path: '/docs/reference#families',
				summary:
					'Robertson, NEN, SB260, CUR, PLAXIS, Bishop, Spencer, Darcy flow, and related source families behind the app.',
				tag: 'Primary'
			},
			{
				title: 'Export meaning',
				path: '/docs/reference#external-exports',
				summary:
					'Meaning of exported stiffness, conductivity, and constitutive values in the app and in downstream workflows.'
			},
			{
				title: 'Technical specification',
				path: '/docs/full',
				summary:
					'The complete long-form implementation note with formulas, tables, symbols, and source groups.',
				tag: 'Long form'
			},
			{
				title: 'Global conventions',
				path: '/docs/theory#conventions',
				summary:
					'Sign conventions, in-situ stress assumptions, Hardening Soil reference-stress convention, and integration logic.'
			},
			{
				title: 'Classification methods',
				path: '/docs/workflow#stage2',
				summary:
					'The classification family in one place: Robertson, CUR zoning, NEN 6740, and NEN Tabel 3.'
			},
			{
				title: 'Parameter derivation',
				path: '/docs/workflow#stage4',
				summary:
					'Alpha methods, stiffness derivation, K0,nc defaults, conductivity rules, and PLAXIS material export.'
			},
			{
				title: 'Sources and references',
				path: '/docs/reference#families',
				summary:
					'The principal Eurocode, Belgian/Dutch, PLAXIS, constitutive-model, and theory references behind the app.'
			}
		]
	}
];

export const docsQuickLinks: DocsLink[] = [
	{
		title: 'Documentation home',
		path: '/docs',
		summary: 'Primary public entry page for the documentation set.',
		tag: 'Primary'
	},
	{
		title: 'Stage 6 engineering analyses',
		path: '/docs/engineering',
		summary: 'The engineering shelf of the app: slope stability, seepage, deformation, and related checks.'
	},
	{
		title: 'Methods and assumptions',
		path: '/docs/theory',
		summary: 'Cross-cutting formulas, governing equations, assumptions, and numerical conventions.'
	},
	{
		title: 'Standards and references',
		path: '/docs/reference',
		summary: 'Source families, standards, and export meanings behind the app.'
	},
	{
		title: 'Technical specification',
		path: '/docs/full',
		summary: 'The long-form implementation note for auditors and deep technical review.'
	}
];
