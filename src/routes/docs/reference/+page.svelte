<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';
	import { docsGroups } from '$lib/docs/site';

	const reference = docsGroups.find((group) => group.path === '/docs/reference')!;
	const pageTitle = 'Standards and References — MADEP CPT Interpreter';
	const pageDescription =
		'Standards and references chapter for the CPT app: source families, standards, global units, exact export fields, Stage 7 payload semantics, quantity registries, and audit traceability.';
	const canonicalUrl = 'https://cpt.madep.be/docs/reference';
	const ogImageUrl = 'https://cpt.madep.be/logo.png';

	const globalUnits = [
		{
			quantity:
				'Depth, layer top, layer base, width, length, displacement, head, water-table elevation, TAW elevation',
			unit: 'm',
			note:
				'The public documentation uses metres as the base length unit. Displacements are stored internally in metres even when plots convert them to millimetres.'
		},
		{
			quantity: 'Cone resistance q_c',
			unit: 'MPa',
			note: 'The CPT workflow and raw/profile exports use MPa for cone resistance.'
		},
		{
			quantity: 'Sleeve friction f_s',
			unit: 'MPa in the PLAXIS-style simulated CPT export; kPa in report tables and layer summaries',
			note:
				'The raw workflow preserves the source quantity, while the report layer tables expose a converted kPa value for readability.'
		},
		{
			quantity: 'Friction ratio R_f',
			unit: '%',
			note: 'Computed and reported as a percentage ratio.'
		},
		{
			quantity: 'Unit weight gamma, gamma_sat, gamma_w',
			unit: 'kN/m^3',
			note:
				'Used across interpretation, seepage-pressure conversion, slope stability, and deformation.'
		},
		{
			quantity:
				'Stress, pore pressure, cohesion, undrained strength, stiffness parameters E, E_oed, E_50, E_ur, E_mc',
			unit: 'kPa',
			note: 'The constitutive, reporting, and layer-export routes use kPa consistently.'
		},
		{
			quantity: 'Angles phi, psi, theta',
			unit: 'degrees in the public manual and UI',
			note:
				'Internal solver routines may use radians, but the public representation is degrees unless stated otherwise.'
		},
		{
			quantity: 'K_0,nc, nu, nu_ur, m, alpha_E, r_shear, k_h/k_v, eta_MC, F, lambda',
			unit: 'dimensionless [-]',
			note: 'Dimensionless ratios are reported without unit conversion.'
		},
		{
			quantity: 'Hydraulic conductivity k_h, k_v, k_x, k_y',
			unit: 'm/s internally, in CSV export, and in report payloads; m/day in PLAXIS command export',
			note: 'The PLAXIS command export performs an explicit m/s-to-m/day conversion.'
		},
		{
			quantity: 'Darcy discharge q, q_x, q_y, q_n',
			unit: 'm/s',
			note: 'This is Darcy velocity or specific discharge, not pore-water velocity.'
		},
		{
			quantity: 'Through-flow, inflow, outflow',
			unit: 'm^3/s/m',
			note:
				'The seepage route is a two-dimensional section model and therefore reports discharge per metre out of plane.'
		},
		{
			quantity: 'Beam foundation modulus k_s',
			unit: 'kN/m^3',
			note: 'Reported as a Winkler bedding modulus.'
		},
		{
			quantity: 'Pasternak shear parameter G_p',
			unit: 'kN/m',
			note: 'Reported as the strip-shear parameter used by the beam/slab annex.'
		},
		{
			quantity: 'Moment for strip-based structural checks',
			unit: 'kNm/m',
			note: 'Per metre strip width.'
		},
		{
			quantity: 'Steel area A_s,req',
			unit: 'mm^2/m',
			note: 'Reported per metre strip width in the reinforcement annex.'
		}
	];

	const csvFields = [
		{ field: 'Layer', meaning: '1-based layer number in the exported CSV.', unit: '[-]', note: 'Administrative label only.' },
		{ field: 'Type', meaning: 'Broad engineering soil type.', unit: 'text', note: 'Examples include Sand, Clay, and Gravel.' },
		{ field: 'Subtype', meaning: 'Final subtype selection carried by the layer model.', unit: 'text', note: 'Usually the NEN Tabel 3 style subtype.' },
		{ field: 'Top_m', meaning: 'Layer top depth below ground level.', unit: 'm', note: 'Depth in the CPT reference system.' },
		{ field: 'Bot_m', meaning: 'Layer base depth below ground level.', unit: 'm', note: 'Depth in the CPT reference system.' },
		{
			field: 'Top_TAW',
			meaning: 'Layer top elevation relative to the site datum.',
			unit: 'text containing m TAW',
			note: 'This CSV field is exported as a formatted label, not a bare numeric field.'
		},
		{
			field: 'Bot_TAW',
			meaning: 'Layer base elevation relative to the site datum.',
			unit: 'text containing m TAW',
			note: 'This CSV field is exported as a formatted label, not a bare numeric field.'
		},
		{ field: 'Thick_m', meaning: 'Layer thickness.', unit: 'm', note: 'Equal to Bot_m minus Top_m.' },
		{ field: 'avgQc_MPa', meaning: 'Average cone resistance of the layer.', unit: 'MPa', note: 'Layer-average value after segmentation.' },
		{ field: 'avgRf_pct', meaning: 'Average friction ratio of the layer.', unit: '%', note: 'May be blank if the source record lacks sleeve friction.' },
		{ field: 'gamma', meaning: 'Representative bulk or unsaturated unit weight.', unit: 'kN/m^3', note: 'Exported as the Stage 4 engineering layer value.' },
		{ field: 'gamma_sat', meaning: 'Representative saturated unit weight.', unit: 'kN/m^3', note: 'Exported as the Stage 4 engineering layer value.' },
		{ field: 'phi', meaning: 'Effective friction angle.', unit: 'deg', note: 'Characteristic or design value according to the selected route.' },
		{ field: 'c', meaning: 'Effective cohesion.', unit: 'kPa', note: 'Characteristic or design value according to the selected route.' },
		{ field: 'cu', meaning: 'Undrained shear strength proxy.', unit: 'kPa', note: 'Provided for workflows that need undrained interpretation.' },
		{ field: 'alphaE', meaning: 'CPT-to-stiffness conversion factor alpha_E.', unit: '[-]', note: 'Selected by the current Stage 4 alpha method.' },
		{ field: 'alphaMethod', meaning: 'Alpha-method identifier.', unit: 'text', note: 'Method A = Sanglerat fixed; Method B = SB260 qc-dependent.' },
		{ field: 'Eoed_i_kPa', meaning: 'Current-stress constrained modulus E_oed,i.', unit: 'kPa', note: 'Computed at the representative layer stress state.' },
		{ field: 'Eoed_ref_kPa', meaning: 'Reference constrained modulus E_oed,ref.', unit: 'kPa', note: 'Reference-stress form used by the HS-style family.' },
		{ field: 'E50_ref_kPa', meaning: 'Reference secant stiffness E_50,ref.', unit: 'kPa', note: 'Derived from the selected stiffness method.' },
		{ field: 'Eur_ref_kPa', meaning: 'Reference unload-reload stiffness E_ur,ref.', unit: 'kPa', note: 'Derived from the selected stiffness method.' },
		{
			field: 'E_mc_kPa',
			meaning: 'Mohr-Coulomb stiffness exported for the current loading route.',
			unit: 'kPa',
			note: 'At present this is taken as E50,i, not an independent stiffness family.'
		},
		{ field: 'nu', meaning: 'Poisson ratio used by the Mohr-Coulomb family.', unit: '[-]', note: 'Layer default or manual override.' },
		{ field: 'rShear', meaning: 'Reduced Stage 1 shear factor.', unit: '[-]', note: 'Relevant only to the Stage 1 pseudo-plastic route.' },
		{ field: 'm', meaning: 'Stress-dependency exponent.', unit: '[-]', note: 'Manual override or default/tuned value.' },
		{ field: 'K0nc', meaning: 'At-rest earth pressure ratio for normally consolidated conditions.', unit: '[-]', note: 'Used for in-situ confinement interpretation.' },
		{ field: 'nu_ur', meaning: 'Unload-reload Poisson ratio.', unit: '[-]', note: 'Currently fixed by the Stage 4 route unless later extended.' },
		{ field: 'stiffMethod', meaning: 'Stiffness-family derivation method identifier.', unit: 'text', note: 'Method A = CUR 2003-7 ratios; Method B = E50 = Eoed.' },
		{ field: 'kh_ms', meaning: 'Representative horizontal conductivity.', unit: 'm/s', note: 'Exported in internal hydraulic units.' },
		{ field: 'kv_ms', meaning: 'Representative vertical conductivity.', unit: 'm/s', note: 'Exported in internal hydraulic units.' },
		{ field: 'khkv', meaning: 'Conductivity anisotropy ratio k_h/k_v.', unit: '[-]', note: 'Used for hydraulic interpretation and export traceability.' },
		{ field: 'psi_unsat_m', meaning: 'Unsaturated suction head proxy psi_unsat.', unit: 'm', note: 'Used for the hydraulic family and PLAXIS-style compatibility.' },
		{ field: 'Infiltratie_klasse', meaning: 'Infiltration class label.', unit: 'text', note: 'Design-oriented qualitative classification derived from k_h.' }
	];

	const plaxisMcFields = [
		{ field: 'Identification', meaning: 'Material name token for the MC export.', unit: 'text', note: 'Built from CPT id, layer number, subtype token, and suffix _MC.' },
		{ field: 'SoilModel = 2', meaning: 'PLAXIS Mohr-Coulomb model selector.', unit: '[-]', note: 'Hard-coded by the export route.' },
		{ field: 'DrainageType', meaning: 'PLAXIS drainage interpretation.', unit: 'text', note: 'Derived from the current layer type and subtype.' },
		{ field: 'gammaUnsat', meaning: 'Unsaturated unit weight.', unit: 'kN/m^3', note: 'Mapped from gamma.' },
		{ field: 'gammaSat', meaning: 'Saturated unit weight.', unit: 'kN/m^3', note: 'Mapped from gamma_sat.' },
		{ field: 'ERef', meaning: 'Exported MC Young modulus.', unit: 'kPa', note: 'Mapped from E_mc.' },
		{ field: 'nu', meaning: 'Poisson ratio.', unit: '[-]', note: 'Mapped directly from the interpreted layer.' },
		{ field: 'cRef', meaning: 'Effective cohesion for PLAXIS export.', unit: 'kPa', note: 'The current export enforces a minimum of 0.1 kPa for command generation.' },
		{ field: 'phi', meaning: 'Effective friction angle.', unit: 'deg', note: 'Mapped directly from the interpreted layer.' },
		{ field: 'psi', meaning: 'Dilation angle.', unit: 'deg', note: 'Derived in Stage 4 and exported if available.' },
		{ field: 'PermHorizontalPrimary', meaning: 'Primary horizontal conductivity.', unit: 'm/day', note: 'Converted explicitly from the internal m/s value.' },
		{ field: 'PermVertical', meaning: 'Vertical conductivity.', unit: 'm/day', note: 'Converted explicitly from the internal m/s value.' }
	];

	const plaxisHsFields = [
		{ field: 'Identification', meaning: 'Material name token for the HS export.', unit: 'text', note: 'Built from CPT id, layer number, subtype token, and suffix _HS.' },
		{ field: 'SoilModel = 3', meaning: 'PLAXIS Hardening Soil model selector.', unit: '[-]', note: 'Hard-coded by the export route.' },
		{ field: 'DrainageType', meaning: 'PLAXIS drainage interpretation.', unit: 'text', note: 'Derived from the current layer type and subtype.' },
		{ field: 'gammaUnsat', meaning: 'Unsaturated unit weight.', unit: 'kN/m^3', note: 'Mapped from gamma.' },
		{ field: 'gammaSat', meaning: 'Saturated unit weight.', unit: 'kN/m^3', note: 'Mapped from gamma_sat.' },
		{ field: 'E50Ref', meaning: 'Reference secant stiffness.', unit: 'kPa', note: 'Mapped from E50_ref.' },
		{ field: 'EOedRef', meaning: 'Reference constrained modulus.', unit: 'kPa', note: 'Mapped from Eoed_ref.' },
		{ field: 'EURRef', meaning: 'Reference unload-reload stiffness.', unit: 'kPa', note: 'Mapped from Eur_ref.' },
		{ field: 'PowerM', meaning: 'Stress-dependency exponent.', unit: '[-]', note: 'Mapped from m.' },
		{ field: 'pRef', meaning: 'Reference pressure used by the export.', unit: 'kPa', note: 'Currently fixed at 100 kPa.' },
		{ field: 'cRef', meaning: 'Effective cohesion for PLAXIS export.', unit: 'kPa', note: 'The current export enforces a minimum of 0.1 kPa for command generation.' },
		{ field: 'phi', meaning: 'Effective friction angle.', unit: 'deg', note: 'Mapped directly from the interpreted layer.' },
		{ field: 'psi', meaning: 'Dilation angle.', unit: 'deg', note: 'Derived in Stage 4 and exported if available.' },
		{ field: 'PermHorizontalPrimary', meaning: 'Primary horizontal conductivity.', unit: 'm/day', note: 'Converted explicitly from the internal m/s value.' },
		{ field: 'PermVertical', meaning: 'Vertical conductivity.', unit: 'm/day', note: 'Converted explicitly from the internal m/s value.' }
	];

	const simulatedCptFields = [
		{ field: 'X[m], Y[m], Z[m]', meaning: 'Reference coordinates of the CPT location used in the simulated export.', unit: 'm', note: 'Written as header lines in the text export.' },
		{ field: 'D[m]', meaning: 'Depth below ground level.', unit: 'm', note: 'One row per original CPT sample depth.' },
		{ field: 'Q[MPa]', meaning: 'Simulated cone resistance.', unit: 'MPa', note: 'Layer-average qc is written back to each row within the layer.' },
		{ field: 'F[MPa]', meaning: 'Simulated sleeve friction.', unit: 'MPa', note: 'Uses avgFs if available, otherwise qc x Rf / 100.' },
		{ field: 'x', meaning: 'Placeholder final column in the exported text format.', unit: '[-]', note: 'Currently written as 0; the app does not export Rf into this PLAXIS-style CPT text file.' }
	];

	const stage7RawFields = [
		{ field: 'depth', meaning: 'Raw CPT depth.', unit: 'm', note: 'Copied directly from the imported CPT row set.' },
		{ field: 'taw', meaning: 'Datum elevation corresponding to the row depth.', unit: 'm TAW', note: 'Only present when surface elevation is known.' },
		{ field: 'qc', meaning: 'Cone resistance.', unit: 'MPa', note: 'Raw row value.' },
		{ field: 'fsMPa', meaning: 'Sleeve friction in source or raw CPT units converted to MPa.', unit: 'MPa', note: 'May be null if unavailable.' },
		{ field: 'fsKPa', meaning: 'Sleeve friction converted for report display.', unit: 'kPa', note: 'Convenience conversion used by the report viewer.' },
		{ field: 'rf', meaning: 'Friction ratio.', unit: '%', note: 'May be null if unavailable.' },
		{ field: 'u2', meaning: 'Measured pore pressure column, if present in the source CPT.', unit: 'source units', note: 'The raw report preserves the imported value without forced reinterpretation.' }
	];

	const stage7ClassifiedFields = [
		{ field: 'depth', meaning: 'Depth of the classified point.', unit: 'm', note: 'Matches the row depth.' },
		{ field: 'taw', meaning: 'Datum elevation of the classified point.', unit: 'm TAW', note: 'Only present when surface elevation is known.' },
		{ field: 'qc', meaning: 'Cone resistance used by the classifier.', unit: 'MPa', note: 'Matches the classified row.' },
		{ field: 'fsKPa', meaning: 'Sleeve friction converted for report display.', unit: 'kPa', note: 'Convenience conversion for the report viewer.' },
		{ field: 'rf', meaning: 'Friction ratio.', unit: '%', note: 'Used by several classification routes.' },
		{ field: 'type', meaning: 'Classified broad soil type.', unit: 'text', note: 'Result of the active Stage 2 route.' },
		{ field: 'subtype', meaning: 'Classified subtype if available.', unit: 'text', note: 'Used where the chosen classification route produces a subtype.' },
		{ field: 'ic', meaning: 'Normalized behaviour index I_c.', unit: '[-]', note: 'Present for Robertson-style routes where calculated.' },
		{ field: 'qtOrQcNen', meaning: 'Method-specific auxiliary metric.', unit: 'MPa or normalized metric depending on route', note: 'The report viewer relabels this according to the active classification method.' }
	];

	const stage7LayerFields = [
		{ field: 'avgFsKPa', meaning: 'Average sleeve friction of the final layer.', unit: 'kPa', note: 'Report-friendly conversion of the layer-average sleeve friction.' },
		{ field: 'overrides', meaning: 'Boolean record of manual parameter overrides.', unit: 'object of flags', note: 'Identifies which layer properties were manually overridden.' },
		{ field: 'hasAcceptedTuning', meaning: 'Whether a Stage 5 fit was accepted into the layer.', unit: '[-]', note: 'Boolean diagnostic.' },
		{ field: 'manualMOverride', meaning: 'Whether m was manually overridden without a tuning fit.', unit: '[-]', note: 'Boolean diagnostic.' },
		{ field: 'hs.alphaE', meaning: 'CPT-to-stiffness conversion factor.', unit: '[-]', note: 'Mirror of alphaE in camelCase JSON form.' },
		{ field: 'hs.eOedI', meaning: 'Current-stress constrained modulus.', unit: 'kPa', note: 'Mirror of Eoed_i.' },
		{ field: 'hs.eOedRef', meaning: 'Reference constrained modulus.', unit: 'kPa', note: 'Mirror of Eoed_ref.' },
		{ field: 'hs.e50Ref', meaning: 'Reference secant stiffness.', unit: 'kPa', note: 'Mirror of E50_ref.' },
		{ field: 'hs.eurRef', meaning: 'Reference unload-reload stiffness.', unit: 'kPa', note: 'Mirror of Eur_ref.' },
		{ field: 'hs.m', meaning: 'Stress-dependency exponent.', unit: '[-]', note: 'Current accepted or default value.' },
		{ field: 'hs.k0nc', meaning: 'At-rest earth pressure ratio.', unit: '[-]', note: 'Mirror of K0nc.' },
		{ field: 'hs.nu', meaning: 'Poisson ratio.', unit: '[-]', note: 'Mirror of nu.' },
		{ field: 'hs.nuUr', meaning: 'Unload-reload Poisson ratio.', unit: '[-]', note: 'Mirror of nu_ur.' },
		{ field: 'hs.rShear', meaning: 'Stage 1 reduced-shear factor.', unit: '[-]', note: 'Relevant only to the Stage 1 constitutive route.' },
		{ field: 'hs.psi', meaning: 'Dilation angle.', unit: 'deg', note: 'Current Stage 4 derived value.' },
		{ field: 'hs.eMc', meaning: 'Current Mohr-Coulomb export stiffness.', unit: 'kPa', note: 'Mirror of E_mc.' },
		{ field: 'hs.sigmaV', meaning: 'Representative total vertical stress at the layer reference point.', unit: 'kPa', note: 'Used for parameter derivation traceability.' },
		{ field: 'hs.porePressure', meaning: 'Representative pore pressure at the layer reference point.', unit: 'kPa', note: 'Used for parameter derivation traceability.' },
		{ field: 'hs.sigmaVEff', meaning: 'Representative effective vertical stress at the layer reference point.', unit: 'kPa', note: 'Used for parameter derivation traceability.' },
		{ field: 'hydraulic.kh', meaning: 'Representative horizontal conductivity.', unit: 'm/s', note: 'Mirror of kh_ms.' },
		{ field: 'hydraulic.kv', meaning: 'Representative vertical conductivity.', unit: 'm/s', note: 'Mirror of kv_ms.' },
		{ field: 'hydraulic.khkv', meaning: 'Conductivity anisotropy ratio.', unit: '[-]', note: 'Mirror of khkv.' },
		{ field: 'hydraulic.psiUnsat', meaning: 'Unsaturated suction head proxy.', unit: 'm', note: 'Mirror of psi_unsat_m.' },
		{ field: 'hydraulic.infiltrationClass', meaning: 'Infiltration-class label.', unit: 'text', note: 'Mirror of Infiltratie_klasse.' }
	];

	const seepageQuantities = [
		{ symbol: 'h', meaning: 'Total hydraulic head.', unit: 'm', note: 'Primary solved field.' },
		{ symbol: 'u', meaning: 'Pore-water pressure.', unit: 'kPa', note: 'Derived from head and elevation.' },
		{ symbol: '|grad h|', meaning: 'Hydraulic-gradient magnitude.', unit: '[-]', note: 'Element-wise before contour post-processing.' },
		{ symbol: '|q|', meaning: 'Darcy discharge magnitude.', unit: 'm/s', note: 'Specific discharge magnitude.' },
		{ symbol: 'q_x, q_y', meaning: 'Darcy discharge components.', unit: 'm/s', note: 'Section-axis components.' },
		{ symbol: 'q_n', meaning: 'Probe-normal Darcy discharge.', unit: 'm/s', note: 'Line-probe quantity only.' },
		{ symbol: 'throughFlow, inflow, outflow', meaning: 'Section discharge rates.', unit: 'm^3/s/m', note: 'Reported per metre out of plane.' },
		{ symbol: 'flowError', meaning: 'Relative flow-balance error.', unit: '[-] or % in report display', note: 'Displayed as percent in the Stage 7 report.' },
		{ symbol: 'maxExitGradient', meaning: 'Maximum exit gradient.', unit: '[-]', note: 'Dimensionless hydraulic-gradient measure.' }
	];

	const deformationQuantities = [
		{ symbol: 'settlement', meaning: 'Vertical displacement plotted as settlement.', unit: 'mm in plots; m internally', note: 'Public charts use millimetres.' },
		{ symbol: 'u_x, u_y', meaning: 'Horizontal and vertical displacement components.', unit: 'mm in plots; m internally', note: 'Public charts use millimetres.' },
		{ symbol: '|u|', meaning: 'Total displacement magnitude.', unit: 'mm in plots; m internally', note: 'Public charts use millimetres.' },
		{ symbol: 'epsilon_xx, epsilon_yy, gamma_xy', meaning: 'Strain components.', unit: '% in plots; [-] internally', note: 'Displayed as percentages for readability.' },
		{ symbol: 'epsilon_p_acc', meaning: 'Accumulated equivalent plastic strain.', unit: '% in plots; [-] internally', note: 'Available only in Stage 2 routes.' },
		{ symbol: 'delta sigma_yy', meaning: 'Effective vertical stress increment.', unit: 'kPa', note: 'Incremental stress view.' },
		{ symbol: 'sigma_yy, sigma_xx families', meaning: 'Initial and final vertical and horizontal effective and total stresses.', unit: 'kPa', note: 'Compression-positive engineering interpretation.' },
		{ symbol: 'tau_xy', meaning: 'Shear stress.', unit: 'kPa', note: 'Same for total and effective stress under the current pore-pressure interpretation.' },
		{ symbol: 'eta_MC', meaning: 'Mohr-Coulomb utilization ratio.', unit: '[-]', note: 'Local indicator, not a global factor of safety.' }
	];

	const bishopQuantities = [
		{ symbol: 'F, F_bishop, F_m, F_f', meaning: 'Global factors of safety from Bishop and Spencer branches.', unit: '[-]', note: 'Dimensionless stability measures.' },
		{ symbol: 'lambda', meaning: 'Constant Spencer interslice-force ratio.', unit: '[-]', note: 'Reported only for Spencer results.' },
		{ symbol: 'theta', meaning: 'Equivalent Spencer interslice-force angle.', unit: 'deg', note: 'Derived user-facing angle.' },
		{ symbol: 'W_i, Q_i, V_i', meaning: 'Slice weight, surcharge contribution, and total vertical load.', unit: 'kN/m', note: 'Per metre out of plane.' },
		{ symbol: 'u_i', meaning: 'Average pore pressure on the slice base.', unit: 'kPa', note: 'Hydrostatic by default or seepage-sampled when enabled.' },
		{ symbol: 'alpha_i', meaning: 'Signed base inclination.', unit: 'deg in public tables', note: 'Internally handled through trigonometric functions.' },
		{ symbol: 'm_alpha,i', meaning: 'Bishop denominator term.', unit: '[-]', note: 'Dimensionless geometry-strength factor.' },
		{ symbol: 'N_i, T_i', meaning: 'Bishop base normal and mobilized shear forces.', unit: 'kN/m', note: 'Per metre out of plane.' },
		{ symbol: 'Nprime_i, E_L, E_R, X_L, X_R', meaning: 'Spencer effective normal and interslice forces.', unit: 'kN/m', note: 'Per metre out of plane.' },
		{ symbol: 'momentResidual, forceResidual', meaning: 'Spencer residual diagnostics.', unit: 'kN/m in the current normalized implementation', note: 'The current circular implementation reports the moment residual after cancellation of the common radius.' },
		{ symbol: 'wallForceTotal', meaning: 'Resultant retaining-wall contribution on the selected surface.', unit: 'kN/m', note: 'Relevant only when retaining walls are active.' }
	];

	const stage7Annexes = [
		{ annex: 'bearing', status: 'exported', fields: 'Df, B, L, eB, eL, Bprime, Lprime, qdDrained, qdUndrained, layer selection and chart inputs', units: 'm and kPa', note: 'Frozen only when a bearing analysis exists in the Stage 6 cache.' },
		{ annex: 'settlement', status: 'exported', fields: 'qGross, qNet, totalSettlementMm, sublayer stress and settlement curves, optional time curve', units: 'kPa, mm, days where applicable', note: 'Frozen only when a settlement analysis exists.' },
		{ annex: 'dewatering', status: 'exported', fields: 'targetWt, newWtAtCpt, drawdownAtCpt, totalSettlementMm, drawdown and stress curves', units: 'm, mm, kPa, days where applicable', note: 'Frozen only when a dewatering analysis exists.' },
		{ annex: 'beam', status: 'exported', fields: 'k_s, G_p, deflection, moment, x-samples and chart inputs', units: 'kN/m^3, kN/m, mm or m, kNm/m', note: 'Frozen only when a beam/slab analysis exists.' },
		{ annex: 'bishop', status: 'exported', fields: 'selected result, top results, lambda, residuals, wall interaction, timing, and frozen canvas view', units: 'dimensionless, kN/m, m, ms', note: 'Included only when Bishop results exist.' },
		{ annex: 'seepage', status: 'exported', fields: 'boundary conditions, permeability set, head range, flow rates, gradients, mesh and solver timing, and frozen canvas view', units: 'm, m/s, m^3/s/m, -, ms', note: 'Included only when seepage results exist.' },
		{ annex: 'deformation', status: 'not yet exported as a Stage 7 annex', fields: 'Display and solver fields exist in Stage 6 but are not currently frozen into the Stage 7 payload', units: 'see deformation quantity registry', note: 'This absence is intentional and should be read as a current reporting boundary.' }
	];
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content={pageDescription} />
	<link rel="canonical" href={canonicalUrl} />
	<meta property="og:title" content={pageTitle} />
	<meta property="og:description" content={pageDescription} />
	<meta property="og:type" content="article" />
	<meta property="og:url" content={canonicalUrl} />
	<meta property="og:image" content={ogImageUrl} />
</svelte:head>

<div class="docs-page">
	<DocsHeader />

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Standards and references</p>
			<h1>Source basis, quantity definitions, export semantics, and audit traceability.</h1>
			<p class="hero__lead">
				This chapter records the documentary basis of the app and the meaning of its exported
				quantities: source families, standards context, units, field names, report-payload
				semantics, and the route from the public manual into the long-form technical
				specification.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="References documentation navigation">
			<div class="docs-nav__title">References</div>
			<a href="#overview">Scope</a>
			<a href="#units">Units and conventions</a>
			<a href="#families">Source families</a>
			<a href="#standards">Codes and standards</a>
			<a href="#layer-exports">Layer-model exports</a>
			<a href="#external-exports">External engineering exports</a>
			<a href="#stage7">Stage 7 payload</a>
			<a href="#registries">Quantity registries</a>
			<a href="#anchors">Reference map</a>
		</aside>

		<main class="docs-content">
			<section id="overview" class="doc-card">
				<p class="section-label">Scope</p>
				<h2>1. Scope, traceability, and reporting boundaries</h2>
				<p>
					This chapter is the registry chapter of the public manual. It records the source
					basis, the unit system, the exact meaning of exported fields, the naming used by the
					Stage 7 report payload, and the quantity registries used by the engineering modules.
					Its function is to make the app auditable: a reviewer should be able to identify what a
					field means, what unit it uses, where it comes from, and whether it is displayed only,
					report-exported, or exported to an external workflow.
				</p>
				<ul class="notes">
					<li>The interpretation chapter documents how the layer model and parameter families are derived from the CPT record.</li>
					<li>The Stage 6 chapters document the governing theory and solver behaviour of each engineering analysis.</li>
					<li>This chapter defines unit conventions, export semantics, and reference traceability.</li>
					<li>The technical specification remains the long-form implementation note for full internal detail.</li>
				</ul>
				<div class="doc-callout">
					<strong>Reporting boundary.</strong> Not every displayed Stage 6 quantity is currently
					frozen into the Stage 7 payload. Where a quantity is display-only, Stage 7-exported, or
					exported to an external format such as PLAXIS, that status is stated explicitly below.
				</div>
			</section>

			<section id="units" class="doc-card">
				<p class="section-label">Units and conventions</p>
				<h2>2. Global unit system, sign conventions, and quantity semantics</h2>
				<p>
					The app uses a mixed but explicit engineering unit system. Length is expressed in
					metres, cone resistance in megapascals, stiffness and stress in kilopascals, unit
					weight in kilonewtons per cubic metre, and hydraulic conductivity internally in metres
					per second. Public plots sometimes rescale stored quantities for readability; those
					conversions form part of the declared quantity semantics.
				</p>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr>
									<th>Quantity family</th>
									<th>Public unit</th>
									<th>Technical note</th>
								</tr>
							</thead>
							<tbody>
								{#each globalUnits as row}
									<tr>
										<td>{row.quantity}</td>
										<td>{row.unit}</td>
										<td>{row.note}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
				<div class="doc-callout">
					<strong>Conversion note.</strong> The deformation route stores displacement in metres
					and strain in dimensionless form, but the public plots present displacement in
					millimetres and strain in percent. The seepage and layer-model routes store
					conductivity in m/s, while the PLAXIS material export converts conductivity to m/day.
				</div>
			</section>

			<section id="families" class="doc-card">
				<p class="section-label">Source families</p>
				<h2>3. Principal literature and method families used by the app</h2>

				<section class="doc-subsection">
					<h3>3.1 CPT classification and interpretation</h3>
					<ul class="reference-list">
						<li><strong>Robertson (1990)</strong> — normalized CPT soil-behaviour framework.</li>
						<li><strong>Robertson (2016)</strong> — updated iterative normalized SBT formulation.</li>
						<li><strong>Robertson and Wride (1998)</strong> — normalization background used widely in CPT interpretation practice.</li>
						<li><strong>NEN 6740</strong> — stress-corrected Dutch classification route.</li>
						<li><strong>NEN Tabel 3</strong> — characteristic subtype catalogue used for engineering parameter mapping.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>3.2 Stiffness and constitutive parameter derivation</h3>
					<ul class="reference-list">
						<li><strong>Sanglerat</strong> — q_c-to-stiffness correlation basis.</li>
						<li><strong>SB260</strong> — Belgian practice route for characteristic parameters from electrical sounding.</li>
						<li><strong>CUR 2003-7</strong> — reference family for Hardening Soil style parameter ratios and stress dependence.</li>
						<li><strong>PLAXIS Material Models manuals</strong> — constitutive naming, parameter meaning, and export interpretation.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>3.3 Stage 6 engineering analyses</h3>
					<ul class="reference-list">
						<li><strong>Bishop (1955)</strong> and <strong>Spencer (1967)</strong> — slope-stability foundation methods.</li>
						<li><strong>Standard Darcy seepage theory</strong> — basis for the seepage route.</li>
						<li><strong>Classical small-strain finite-element mechanics</strong> and <strong>Mohr-Coulomb plasticity</strong> — basis for the deformation route.</li>
						<li><strong>Boussinesq</strong> and related elastic half-space solutions — verification and interpretation context for settlement-type fields.</li>
					</ul>
				</section>
			</section>

			<section id="standards" class="doc-card">
				<p class="section-label">Codes and standards</p>
				<h2>4. Standards and code context within the app</h2>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr>
									<th>Source family</th>
									<th>Main role in the app</th>
									<th>Current public relevance</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td>EN 1997 and national-annex context</td>
									<td>General geotechnical design context and hydraulic-heave / piping framing.</td>
									<td>Reference basis for engineering interpretation and some design-oriented routes.</td>
								</tr>
								<tr>
									<td>NEN 6740</td>
									<td>Stress-corrected CPT classification.</td>
									<td>Available directly in Stage 2 classification.</td>
								</tr>
								<tr>
									<td>SB260</td>
									<td>Characteristic parameter and stiffness-family mapping.</td>
									<td>Used directly in Stage 4 parameter derivation.</td>
								</tr>
								<tr>
									<td>PLAXIS manuals</td>
									<td>Material naming, constitutive parameter interpretation, and export compatibility.</td>
									<td>Important for Stage 4 exports and Stage 6 constitutive documentation.</td>
								</tr>
							</tbody>
						</table>
					</div>
				</div>
			</section>

			<section id="layer-exports" class="doc-card">
				<p class="section-label">Layer-model exports</p>
				<h2>5. Layer CSV, layer payload, and parameter-field semantics</h2>
				<p>
					The layer CSV export is the most direct public export of the interpreted engineering
					model. The field names below are the exact CSV header names currently written by the
					app.
				</p>

				<section class="doc-subsection">
					<h3>5.1 Layer CSV export</h3>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>CSV field</th>
										<th>Meaning</th>
										<th>Unit or type</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each csvFields as row}
										<tr>
											<td><code>{row.field}</code></td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>5.2 Stage 7 layer payload additions</h3>
					<p>
						The Stage 7 JSON payload carries the final layer model again in camelCase form,
						together with additional provenance fields that are not present in the CSV export.
						The entries below are the fields that materially extend the CSV meaning.
					</p>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>Stage 7 field</th>
										<th>Meaning</th>
										<th>Unit or type</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each stage7LayerFields as row}
										<tr>
											<td><code>{row.field}</code></td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>5.3 Stage 7 raw and classified row payloads</h3>
					<p>
						The Stage 7 report stores both the raw CPT table and the pointwise classified row
						set. Their field semantics are defined below.
					</p>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th colspan="4">rawRows</th>
									</tr>
									<tr>
										<th>Field</th>
										<th>Meaning</th>
										<th>Unit or type</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each stage7RawFields as row}
										<tr>
											<td><code>{row.field}</code></td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>

					<div class="doc-table-wrap" style="margin-top:16px">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th colspan="4">classifiedRows</th>
									</tr>
									<tr>
										<th>Field</th>
										<th>Meaning</th>
										<th>Unit or type</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each stage7ClassifiedFields as row}
										<tr>
											<td><code>{row.field}</code></td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</section>
			</section>

			<section id="external-exports" class="doc-card">
				<p class="section-label">External engineering exports</p>
				<h2>6. PLAXIS command export and simulated CPT export</h2>

				<section class="doc-subsection">
					<h3>6.1 PLAXIS material command export</h3>
					<p>
						The current PLAXIS export writes two material-command lines per layer: one
						Mohr-Coulomb material and one Hardening Soil material. The tables below document the
						current field mapping exactly as exported.
					</p>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th colspan="4">Mohr-Coulomb command fields</th>
									</tr>
									<tr>
										<th>PLAXIS field</th>
										<th>Meaning</th>
										<th>Unit or type</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each plaxisMcFields as row}
										<tr>
											<td><code>{row.field}</code></td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>

					<div class="doc-table-wrap" style="margin-top:16px">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th colspan="4">Hardening Soil command fields</th>
									</tr>
									<tr>
										<th>PLAXIS field</th>
										<th>Meaning</th>
										<th>Unit or type</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each plaxisHsFields as row}
										<tr>
											<td><code>{row.field}</code></td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>6.2 Simulated PLAXIS CPT text export</h3>
					<p>
						The app can also write a simplified CPT text file intended for PLAXIS-style import
						workflows. The format is deliberately simple and the field semantics are fixed.
					</p>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>Export field</th>
										<th>Meaning</th>
										<th>Unit or type</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each simulatedCptFields as row}
										<tr>
											<td><code>{row.field}</code></td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</section>
			</section>

			<section id="stage7" class="doc-card">
				<p class="section-label">Stage 7 payload</p>
				<h2>7. Report-payload structure, annex availability, and field semantics</h2>
				<p>
					The Stage 7 export is a structured JSON payload. At top level it contains project and
					replication metadata, raw and classified CPT rows, final layers, optional tuning
					results, and optional Stage 6 annexes. The annex set is not fixed; it depends on which
					analyses were actually solved when the report was opened.
				</p>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr>
									<th>Payload block</th>
									<th>Meaning</th>
									<th>Technical note</th>
								</tr>
							</thead>
							<tbody>
								<tr><td><code>version</code>, <code>stage</code>, <code>generatedAt</code>, <code>appVersion</code></td><td>Export-version metadata.</td><td>Used for compatibility and audit trace.</td></tr>
								<tr><td><code>project</code>, <code>cpt</code>, <code>metadata</code></td><td>Project identity, CPT identity, and source-file provenance.</td><td>Coordinates are in metres; imported metadata are preserved where available.</td></tr>
								<tr><td><code>replication</code></td><td>Active methods and settings needed to reproduce the interpretation.</td><td>Includes classification method, alpha method, stiffness method, water table, and elevation provenance.</td></tr>
								<tr><td><code>summary</code></td><td>High-level counts and report-level diagnostics.</td><td>Includes layer count, depth range, and list of attached Stage 6 annexes.</td></tr>
								<tr><td><code>visuals</code>, <code>chartInputs</code></td><td>Report-rendering helpers.</td><td>Not primary engineering quantities, but required to reproduce the report layout.</td></tr>
								<tr><td><code>rawRows</code>, <code>classifiedRows</code></td><td>Raw CPT data and classified row set.</td><td>Field semantics are defined in Section 5.3.</td></tr>
								<tr><td><code>layers</code>, <code>layerWarnings</code>, <code>tuning</code></td><td>Final layer model, warnings, and optional Stage 5 fitting data.</td><td>Field semantics are defined in Sections 5.1 and 5.2.</td></tr>
								<tr><td><code>stage6</code></td><td>Optional engineering annexes.</td><td>Availability depends on which Stage 6 modules were solved.</td></tr>
							</tbody>
						</table>
					</div>
				</div>

				<div class="doc-table-wrap" style="margin-top:16px">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr>
									<th>Stage 6 annex</th>
									<th>Current status</th>
									<th>Reported field family</th>
									<th>Public units</th>
									<th>Technical note</th>
								</tr>
							</thead>
							<tbody>
								{#each stage7Annexes as row}
									<tr>
										<td><code>{row.annex}</code></td>
										<td>{row.status}</td>
										<td>{row.fields}</td>
										<td>{row.units}</td>
										<td>{row.note}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				</div>
			</section>

			<section id="registries" class="doc-card">
				<p class="section-label">Quantity registries</p>
				<h2>8. Stage 6 quantity names, symbols, and public units</h2>

				<section class="doc-subsection">
					<h3>8.1 Seepage quantity registry</h3>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>Symbol</th>
										<th>Meaning</th>
										<th>Public unit</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each seepageQuantities as row}
										<tr>
											<td>{row.symbol}</td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>8.2 Deformation quantity registry</h3>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>Symbol</th>
										<th>Meaning</th>
										<th>Public unit</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each deformationQuantities as row}
										<tr>
											<td>{row.symbol}</td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>8.3 Slope-stability quantity registry</h3>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>Symbol</th>
										<th>Meaning</th>
										<th>Public unit</th>
										<th>Technical note</th>
									</tr>
								</thead>
								<tbody>
									{#each bishopQuantities as row}
										<tr>
											<td>{row.symbol}</td>
											<td>{row.meaning}</td>
											<td>{row.unit}</td>
											<td>{row.note}</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					</div>
				</section>
			</section>

			<section id="anchors" class="doc-card">
				<p class="section-label">Reference map</p>
				<h2>9. Route map to topic-specific technical chapters</h2>
				<div class="docs-link-grid">
					{#each reference.pages as page}
						<a class="docs-link-card" href={page.path}>
							<div class="docs-link-card__meta">{page.tag ?? 'Reference'}</div>
							<h3>{page.title}</h3>
							<p>{page.summary}</p>
						</a>
					{/each}
				</div>
			</section>
		</main>
	</div>
</div>
