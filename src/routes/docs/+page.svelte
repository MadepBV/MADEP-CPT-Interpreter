<script lang="ts">
	const pageTitle = 'Technical Documentation — MADEP CPT Interpreter';
	const pageDescription =
		'Technical Stage 6 documentation for the MADEP CPT Interpreter: bearing capacity, settlement, dewatering, and beam/slab on elastic foundation.';
	const canonicalUrl = 'https://cpt.madep.be/docs';
	const ogImageUrl = 'https://cpt.madep.be/logo.png';

	type Reference = {
		label: string;
		detail: string;
	};

	type DocSubsection = {
		id: string;
		title: string;
		paragraphs: string[];
		equations?: string[];
		bullets?: string[];
	};

	type DocSection = {
		id: string;
		title: string;
		intro: string;
		references: string[];
		subsections: DocSubsection[];
	};

	const references: Reference[] = [
		{
			label: 'EN 1997-1:2004+A1:2013',
			detail: 'Eurocode 7 — Geotechnical design — General rules.'
		},
		{
			label: 'NBN EN 1997-1 ANB:2022',
			detail: 'Belgian National Annex to EN 1997-1, Design Approach 1.'
		},
		{
			label: 'EN 1990:2002+A1:2005',
			detail: 'Basis of structural design.'
		},
		{
			label: 'NBN EN 1990 ANB:2005',
			detail: 'Belgian National Annex to EN 1990.'
		},
		{
			label: 'EN 1992-1-1',
			detail: 'Eurocode 2 — Design of concrete structures.'
		},
		{
			label: 'NBN EN 1992-1-1 ANB',
			detail: 'Belgian National Annex to EN 1992-1-1.'
		},
		{
			label: 'Terzaghi & Peck (1967)',
			detail: 'Soil Mechanics in Engineering Practice, 2nd ed.'
		},
		{
			label: 'Boussinesq (1885)',
			detail: 'Application des potentiels à l’étude de l’équilibre et du mouvement des solides élastiques.'
		},
		{
			label: 'Newmark (1935)',
			detail: 'Simplified computation of vertical pressures in elastic foundations.'
		},
		{
			label: 'Fadum (1948)',
			detail: 'Influence values for estimating stresses in elastic foundations.'
		},
		{
			label: 'Dupuit (1863)',
			detail: 'Études théoriques et pratiques sur le mouvement des eaux.'
		},
		{
			label: 'Thiem (1906)',
			detail: 'Hydrologische Methoden.'
		},
		{
			label: 'Bear (1979)',
			detail: 'Hydraulics of Groundwater.'
		},
		{
			label: 'Freeze & Cherry (1979)',
			detail: 'Groundwater.'
		},
		{
			label: 'Kyrieleis & Sichardt (1930)',
			detail: 'Grundwasserabsenkung bei Fundierungsarbeiten.'
		},
		{
			label: 'Louwyck et al. (2022)',
			detail: 'The Radius of Influence Myth. Water, 14(2), 149.'
		},
		{
			label: 'Powers et al. (2007)',
			detail: 'Construction Dewatering and Groundwater Control, 3rd ed.'
		},
		{
			label: 'Hetényi (1946)',
			detail: 'Beams on Elastic Foundation.'
		},
		{
			label: 'Vesić (1961a)',
			detail: 'Bending of beams resting on isotropic elastic solid.'
		},
		{
			label: 'Vesić (1961b)',
			detail: 'Beams on elastic subgrade and Winkler’s hypothesis.'
		},
		{
			label: 'Pasternak (1954)',
			detail: 'On a New Method of Analysis of an Elastic Foundation by Means of Two Foundation Constants.'
		},
		{
			label: 'Kerr (1964)',
			detail: 'Elastic and viscoelastic foundation models.'
		}
	];

	const sections: DocSection[] = [
		{
			id: 'scope',
			title: '0A. Scope And Implemented Models',
			intro:
				'This page documents the mathematics and engineering assumptions currently implemented in Stage 6 of the MADEP CPT Interpreter. It follows the structure of the internal Stage 6 technical review and is intended as a technical implementation note rather than a user guide.',
			subsections: [
				{
					id: 'scope-applications',
					title: '0A.1 Current applications',
					paragraphs: [
						'The current Stage 6 implementation contains four engineering applications: bearing capacity, settlement, dewatering, and beam/slab on elastic foundation.',
						'The purpose of the page is to keep the public technical explanation aligned with the live application and with the internal Stage 6 review document.'
					],
					bullets: [
						'The page is intentionally theory-based and technical.',
						'Only the currently implemented Stage 6 models are documented here.',
						'Stage 6 builds on the interpreted CPT, current water table, current parameter source, and accepted Stage 5 tuning.'
					]
				},
				{
					id: 'scope-inputs',
					title: '0A.2 Layer data used as input',
					paragraphs: [
						'Per interpreted layer, the application already carries the quantities needed for Stage 6: top and bottom depth, γ and γ_sat, φ\', c\', c_u, E_oed,ref, E_oed,i, E50,ref, Eur,ref, m, K0_nc, ν_ur, k_h, and k_v.',
						'These layer quantities are treated as the starting point for the Stage 6 applications, with geometry, load, and hydraulic scenario inputs added in the relevant calculator.'
					]
				}
			],
			references: ['EN 1997-1:2004+A1:2013', 'NBN EN 1997-1 ANB:2022']
		},
		{
			id: 'conventions',
			title: '1. Global Conventions',
			intro:
				'The Stage 6 calculations share one common stress and stiffness basis. The equations below define the sign convention, the in-situ stress profile, the Hardening Soil reference-stress convention, and the general profile discretisation logic used by the applications.',
			subsections: [
				{
					id: 'conventions-sign',
					title: '1.1 Sign convention and in-situ stresses',
					paragraphs: [
						'Compression is taken as positive. Depth z is measured downward from ground level. Elevation values are interpreted in Belgian TAW convention where relevant.',
						'The in-situ effective-stress profile is reconstructed from the active groundwater level and the interpreted unit weights.'
					],
					equations: [
						'u(z) = γ<sub>w</sub> · max(0, z − z<sub>w</sub>)',
						'σ<sub>v</sub>(z) = Σ γ<sub>i</sub> · Δz<sub>i</sub>',
						"σ'<sub>v</sub>(z) = σ<sub>v</sub>(z) − u(z)"
					]
				},
				{
					id: 'conventions-hs',
					title: '1.2 Hardening Soil reference-stress convention',
					paragraphs: [
						'Stage 6 uses the Stage 4/5 Hardening Soil stiffness convention. E_oed,ref is referenced at p_ref = 100 kPa and stress-dependent stiffness is recovered from the interpreted m-value and effective stress level.',
						'For the current settlement and dewatering routes, the governing stress is the vertical effective stress on the evaluated centreline.'
					],
					equations: [
						"E<sub>oed</sub>(σ'<sub>1</sub>) = E<sub>oed,ref</sub> · [(c'·cotφ' + σ'<sub>1</sub>)/(c'·cotφ' + p<sub>ref</sub>)]<sup>m</sup>",
						"E<sub>oed</sub>(σ'<sub>1</sub>) = E<sub>oed,ref</sub> · (σ'<sub>1</sub>/p<sub>ref</sub>)<sup>m</sup> &nbsp;&nbsp; for c' = 0"
					]
				},
				{
					id: 'conventions-integration',
					title: '1.3 Integration and sublayering',
					paragraphs: [
						'The engineering calculations use stratification summation. The profile is divided into sublayers, stresses are evaluated at sublayer mid-depth, and settlement or stress changes are integrated over depth.',
						'The application keeps interpreted layer boundaries and phreatic boundaries explicit in the discretisation so stiffness and stress changes are not smeared across those interfaces.'
					]
				}
			],
			references: ['Terzaghi & Peck (1967)', 'EN 1997-1:2004+A1:2013']
		},
		{
			id: 'bearing',
			title: '2. Bearing Capacity',
			intro:
				'The bearing-capacity application is a shallow-foundation ULS screening tool. It evaluates drained and undrained soil resistance versus founding depth and applies Belgian DA1 handling on the strength side.',
			subsections: [
				{
					id: 'bearing-model',
					title: '2.1 Current implemented resistance model',
					paragraphs: [
						'The application computes drained and undrained ultimate resistance separately and converts those results to q_d or q_allow depending on the chosen safety route.',
						'The formulas used are the standard classical shallow-foundation expressions currently implemented in the app.'
					],
					equations: [
						"q<sub>ult,d</sub> = c'·N<sub>c</sub>·s<sub>c</sub> + q'·N<sub>q</sub>·s<sub>q</sub> + 0.5·γ'·B·N<sub>γ</sub>·s<sub>γ</sub>",
						'q<sub>ult,u</sub> = q + 5.14·c<sub>u</sub>·s<sub>cu</sub>',
						'N<sub>q</sub> = exp(π·tanφ\') · tan<sup>2</sup>(45° + φ\'/2)',
						'N<sub>c</sub> = (N<sub>q</sub> − 1) / tanφ\'',
						'N<sub>γ</sub> = 2·(N<sub>q</sub> + 1)·tanφ\''
					]
				},
				{
					id: 'bearing-belgium',
					title: '2.2 Belgian DA1 handling in the current app',
					paragraphs: [
						'For Belgian EC7 practice, the application evaluates DA1/1 with M1 soil strengths and DA1/2 with reduced M2 soil strengths. It then forms the governing drained and undrained envelopes separately.',
						'The current Stage 6 app is therefore a resistance-side Belgian screening tool rather than a full action-side ULS verification engine.'
					],
					equations: [
						"tanφ'<sub>d</sub> = tanφ'<sub>k</sub> / 1.25 &nbsp;&nbsp; (DA1/2)",
						"c'<sub>d</sub> = c'<sub>k</sub> / 1.25",
						'c<sub>u,d</sub> = c<sub>u,k</sub> / 1.40',
						'q<sub>d</sub> = q<sub>ult</sub> / γ<sub>Rd</sub>',
						'q<sub>allow</sub> = q<sub>ult</sub> / ξ'
					],
					bullets: [
						'DA1/1 uses unfactored M1 soil strengths.',
						'DA1/2 uses reduced M2 soil strengths.',
						'The governing drained and undrained results are formed independently.'
					]
				}
			],
			references: ['EN 1997-1:2004+A1:2013', 'NBN EN 1997-1 ANB:2022', 'EN 1990:2002+A1:2005', 'NBN EN 1990 ANB:2005']
		},
		{
			id: 'dewatering',
			title: '3. Dewatering',
			intro:
				'The dewatering application is an SLS screening model coupling hydraulic drawdown with CPT-based effective-stress and settlement response at the CPT location.',
			subsections: [
				{
					id: 'dewatering-scope',
					title: '3.1 Scope and radius of influence',
					paragraphs: [
						'The hydraulic part of the module estimates drawdown at the CPT for a single well, an equivalent-radius excavation, or a line dewatering trench. The engineering deliverable is not the pumping rate alone, but the stress change and settlement induced at the CPT.',
						'The current app still uses Sichardt to screen the extent of influence. This remains explicitly a rule-of-thumb estimate rather than a rigorous hydrogeological boundary.'
					],
					equations: ['R = C · s · √k<sub>eff,h</sub>'],
					bullets: [
						'C = 3000 is the classic Kyrieleis & Sichardt coefficient used in sandy-soil rule-of-thumb practice.',
						'Louwyck et al. (2022) show why Sichardt should be treated as a screening estimate, not as a rigorous groundwater-flow boundary.'
					]
				},
				{
					id: 'dewatering-transmissivity',
					title: '3.2 Steady-state inflow — transmissivity-based screening model',
					paragraphs: [
						'The model treats the pumped zone as a stack of horizontal layers, each with its own horizontal conductivity k_h. For any chosen saturated thickness, the saturated part of each layer contributes to the total transmissivity according to its own thickness and conductivity.',
						'Instead of representing the whole profile by one fixed conductivity, the model first constructs the transmissivity of the saturated profile and then updates that transmissivity as the phreatic level moves through the layered ground.',
						'For unconfined flow, this changing hydraulic capacity is handled through the cumulative transmissivity moment. In that way, the drawdown solution remains analytical while still reflecting the layered structure of the interpreted CPT profile.'
					],
					equations: [
						'T = Σ(k<sub>h,i</sub> · b<sub>i</sub>)',
						'T(h) = Σ(k<sub>h,i</sub> · b<sub>i</sub>(h))',
						'M(h) = ∫<sub>0</sub><sup>h</sup> T(ξ) dξ',
						'Q = 2π · [M(h<sub>0</sub>) − M(h<sub>w</sub>)] / ln(R / r<sub>w</sub>) &nbsp;&nbsp; unconfined',
						'Q = 2π · T<sub>0</sub> · (h<sub>0</sub> − h<sub>w</sub>) / ln(R / r<sub>w</sub>) &nbsp;&nbsp; confined screening',
						'r<sub>w,eq</sub> = √(A / π)'
					],
					bullets: [
						'T is the total horizontal flow capacity of the currently saturated part of the interpreted profile.',
						'T(h) expresses how that flow capacity changes as the water table rises or falls relative to the aquifer base.',
						'M(h) is the cumulative transmissivity moment used to solve the radial unconfined flow relation.',
						'For a homogeneous aquifer, the formulation reduces exactly to the classical Dupuit expression.'
					]
				},
				{
					id: 'dewatering-profile',
					title: '3.3 Drawdown profile toward the CPT',
					paragraphs: [
						'For radial unconfined flow, the app solves the head profile from the transmissivity-moment equation. For homogeneous conditions, this collapses to the classical Dupuit h² law.',
						'For trenches, the displayed profile toward the CPT remains a linear screening interpolation, while the flow estimate itself is based on transmissivity.'
					],
					equations: [
						'M(h(r)) = M(h<sub>w</sub>) + Q / (2π) · ln(r / r<sub>w</sub>)',
						'Δh<sub>CPT</sub> = h<sub>0</sub> − h(r<sub>CPT</sub>)',
						'h<sup>2</sup>(r) = h<sub>w</sub><sup>2</sup> + Q / (πk) · ln(r / r<sub>w</sub>) &nbsp;&nbsp; homogeneous limit'
					]
				},
				{
					id: 'dewatering-stress',
					title: '3.4 Effective stress and settlement response',
					paragraphs: [
						'Once the new phreatic level at the CPT is known, the app recomputes pore pressure and effective stress with two selectable total-stress assumptions: conservative σ_v fixed, or realistic γ_sat → γ between the old and new water levels.',
						'Settlement is then computed with the same constrained-modulus philosophy used in the settlement app, evaluated at the mean stress state between before and after drawdown.'
					],
					equations: [
						"u'(z) = γ<sub>w</sub> · max(0, z − z'<sub>w</sub>)",
						"σ'<sub>v</sub>'(z) = σ<sub>v</sub>(z) − u'(z)",
						"Δσ'<sub>v</sub>(z) = σ'<sub>v,new</sub>(z) − σ'<sub>v,old</sub>(z)",
						"σ'<sub>mean</sub> = 0.5 · (σ'<sub>v,old</sub> + σ'<sub>v,new</sub>)",
						"Δε<sub>v,i</sub> = Δσ'<sub>v,i</sub> / E<sub>oed,i</sub>",
						'ΔS<sub>dewatering</sub> = Σ Δε<sub>v,i</sub> · Δz<sub>i</sub>',
						'c<sub>v</sub> = k<sub>v</sub> · E<sub>oed</sub> / γ<sub>w</sub>'
					],
					bullets: [
						'The app reports both S_conservative and S_realistic to expose the sensitivity to the chosen total-stress assumption.',
						'The public engineering output is total settlement versus distance from the source, with the active CPT position marked on that curve.'
					]
				}
			],
			references: [
				'Dupuit (1863)',
				'Thiem (1906)',
				'Bear (1979)',
				'Freeze & Cherry (1979)',
				'Kyrieleis & Sichardt (1930)',
				'Louwyck et al. (2022)',
				'Powers et al. (2007)'
			]
		},
		{
			id: 'settlement',
			title: '4. Settlement',
			intro:
				'The settlement application is a centreline constrained-modulus summation. It evaluates the stress increase beneath the loaded area, updates E_oed at the mean effective stress, and integrates settlement over depth.',
			subsections: [
				{
					id: 'settlement-summary',
					title: '4.1 Settlement method summary',
					paragraphs: [
						'The current implementation follows the classical constrained-modulus route: compute q_net, derive Δσ_v beneath the foundation, evaluate E_oed at the mean stress level, and integrate ΔS = (Δσ_v / E_oed)·Δz.',
						'The evaluated location is the strip centreline for strip geometry and the centre of footprint for rectangular, square, and slab geometry.'
					],
					equations: [
						'q<sub>net</sub> = q<sub>gross</sub> − σ<sub>v</sub>(D<sub>f</sub>)',
						'ΔS<sub>i</sub> = (Δσ<sub>v,i</sub> / E<sub>oed,i</sub>) · Δz<sub>i</sub>',
						'S = ΣΔS<sub>i</sub>'
					]
				},
				{
					id: 'settlement-stress',
					title: '4.2 Vertical stress increase — exact forms',
					paragraphs: [
						'For strip footings, the application can use the exact Boussinesq centreline solution. For rectangular loaded areas, the centre stress is computed by four-quadrant superposition of the corrected Newmark/Fadum corner influence factor.',
						'The implementation includes the V < V1 branch correction so the formula remains valid in the shallow, wide-load regime.'
					],
					equations: [
						'α = atan(B / (2z))',
						'Δσ<sub>v</sub>(z) = (q<sub>net</sub> / π) · [2α + sin(2α)] &nbsp;&nbsp; strip centreline',
						'm = B / z, &nbsp; n = L / z, &nbsp; V = m<sup>2</sup> + n<sup>2</sup> + 1, &nbsp; V<sub>1</sub> = m<sup>2</sup>n<sup>2</sup>',
						'A = (2mn√V) / (V + V<sub>1</sub>)',
						'B<sub>factor</sub> = (V + 1) / V',
						'I<sub>z</sub> = (1 / 4π) · [A · B<sub>factor</sub> + atan-term]',
						'Δσ<sub>v,center</sub>(z) = 4 · I<sub>z</sub>(B/2, L/2, z) · q<sub>net</sub>',
						'Δσ<sub>v</sub>(z) = q<sub>net</sub> · (B·L) / ((B + z)(L + z)) &nbsp;&nbsp; 2:1 option'
					]
				},
				{
					id: 'settlement-stiffness',
					title: '4.3 Constrained-modulus integration',
					paragraphs: [
						'For each sublayer, the app forms the mean effective stress between the in-situ and loaded state, evaluates E_oed at that level, and computes vertical strain and settlement increment from the constrained modulus.',
						'This is the current implemented route for settlement in both sands and clays.'
					],
					equations: [
						"σ'<sub>v,f,i</sub> = σ'<sub>v,0,i</sub> + Δσ<sub>v,i</sub>",
						"σ'<sub>mean,i</sub> = 0.5 · (σ'<sub>v,0,i</sub> + σ'<sub>v,f,i</sub>)",
						"E<sub>oed,i</sub> = E<sub>oed,ref</sub> · [(c'·cotφ' + σ'<sub>mean,i</sub>)/(c'·cotφ' + p<sub>ref</sub>)]<sup>m</sup>",
						'Δε<sub>v,i</sub> = Δσ<sub>v,i</sub> / E<sub>oed,i</sub>',
						'ΔS<sub>i</sub> = Δε<sub>v,i</sub> · Δz<sub>i</sub>'
					]
				},
				{
					id: 'settlement-output',
					title: '4.4 Output form and truncation',
					paragraphs: [
						'The review documents several truncation rules, but the current app lets the engineer choose the practical truncation setting. The present default in the interface is CPT bottom.',
						'The output is a single vertical settlement beneath the evaluation point, not a 2D settlement field or edge-settlement map.'
					],
					bullets: [
						'Selectable truncation settings: Δσ_v < 10% σ′_v,0; Δσ_v < 20% q_net; CPT bottom.',
						'Optional time curve for fine-grained layers follows the same Terzaghi 1D consolidation route used in the dewatering application.'
					]
				}
			],
			references: ['Terzaghi & Peck (1967)', 'Boussinesq (1885)', 'Newmark (1935)', 'Fadum (1948)']
		},
		{
			id: 'beam',
			title: '5. Beam / Slab On Elastic Foundation',
			intro:
				'The structural-geotechnical application is currently a 1D strip or beam model on elastic foundation with both Winkler and Pasternak support options. It is explicitly not yet a 2D slab plate solver.',
			subsections: [
				{
					id: 'beam-ks',
					title: '5.1 Modulus of subgrade reaction from CPT stiffness',
					paragraphs: [
						'The current implementation derives k_s from CPT-linked stiffness using the Vesić route. The app offers a self-consistent default route in which E_s is taken from E_oed and ν_s = 0, consistent with the oedometric nature of the interpreted stiffness.',
						'The stiffness is averaged over an influence depth below the foundation, so k_s is not treated as a pure soil constant but as a footing-dependent support parameter.'
					],
					equations: [
						'k<sub>s</sub> = (0.65 · E<sub>s</sub>) / [B · (1 − ν<sub>s</sub><sup>2</sup>)] · (E<sub>s</sub>·B<sup>4</sup> / (E<sub>b</sub>·I<sub>b</sub>))<sup>1/12</sup>',
						'E<sub>s</sub> ≈ E<sub>oed</sub>, &nbsp; ν<sub>s</sub> = 0 &nbsp;&nbsp; current default route'
					]
				},
				{
					id: 'beam-governing',
					title: '5.2 Governing equations and characteristic length',
					paragraphs: [
						'The beam is solved on either a Winkler or Pasternak elastic foundation. The corresponding differential equations are implemented numerically along the strip length.',
						'The characteristic length determines whether the strip behaves as short, intermediate, or long on elastic support.'
					],
					equations: [
						"EI · w'''' + k<sub>s</sub> · b · w = q(x) &nbsp;&nbsp; Winkler",
						"EI · w'''' − G<sub>p</sub> · b · w'' + k<sub>s</sub> · b · w = q(x) &nbsp;&nbsp; Pasternak",
						'λ = (4EI / (k<sub>s</sub>·b))<sup>1/4</sup>',
						'β = 1 / λ'
					]
				},
				{
					id: 'beam-pasternak',
					title: '5.3 Pasternak 1D implementation',
					paragraphs: [
						'The Pasternak extension currently implemented in the app is a 1D strip formulation. The shear-layer parameter is not measured directly; it is inferred from the averaged soil shear modulus and a chosen influence depth.',
						'This is why the Pasternak route is labeled as a screening extension rather than a continuum-calibrated Belgian design model.'
					],
					equations: [
						'G<sub>p</sub> = η · G<sub>s,avg</sub> · H<sub>p</sub>',
						'G<sub>s,avg</sub> = E<sub>s,avg</sub> / [2·(1 + ν<sub>s</sub>)]',
						'H<sub>p</sub> = z<sub>influence</sub>'
					],
					bullets: [
						'Uniform full-length loading can still produce very low bending moment because the deflection field approaches nearly uniform settlement.',
						'Patch loads and point loads are more informative when the objective is bending-driven reinforcement screening.'
					]
				}
			],
			references: ['Hetényi (1946)', 'Vesić (1961a)', 'Vesić (1961b)', 'Pasternak (1954)', 'Kerr (1964)']
		},
		{
			id: 'reinforcement',
			title: '6. ULS Reinforcement Output',
			intro:
				'The beam/slab module carries the ULS strip response through to an EC2 reinforcement estimate using design strengths, effective depth, and the selected durability and cover assumptions.',
			subsections: [
				{
					id: 'reinforcement-route',
					title: '6.1 Structural design route from M<sub>Ed</sub>',
					paragraphs: [
						'Once the ULS moment is obtained from the strip-on-foundation solve, the app converts concrete and steel to design strengths and estimates the required reinforcement area per meter width.',
						'The current implementation also applies the EC2 durability and cover route, so c_nom is not just a free guessed number.'
					],
					equations: [
						'f<sub>cd</sub> = f<sub>ck</sub> / γ<sub>C</sub>',
						'f<sub>yd</sub> = f<sub>yk</sub> / γ<sub>S</sub>',
						'd = h − c<sub>nom</sub> − φ<sub>bar</sub>/2',
						'μ = M<sub>Ed</sub> / (b·d<sup>2</sup>·f<sub>cd</sub>)',
						'ω = 1 − √(1 − 2μ)',
						'A<sub>s,req</sub> = ω · b · d · f<sub>cd</sub> / f<sub>yd</sub>'
					],
					bullets: [
						'The result should be read as strip-based ULS reinforcement screening, not as a final 2D slab reinforcement layout.',
						'Exposure class, working life, and detailing assumptions feed the EC2 cover route used in the calculation.'
					]
				}
			],
			references: ['EN 1992-1-1', 'NBN EN 1992-1-1 ANB']
		}
	];
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
			<a class="docs-header__logo" href="/">MADEP CPT Interpreter</a>
			<nav class="docs-header__nav" aria-label="Documentation navigation">
				<a href="/">App</a>
				<a href="#references">References</a>
			</nav>
		</div>
	</header>

	<header class="hero">
		<div class="hero__inner">
			<p class="hero__eyebrow">Technical documentation</p>
			<h1>Stage 6 engineering theory, structured and referenced.</h1>
			<p class="hero__lead">
				A technical implementation note for the live MADEP CPT applications: bearing
				capacity, dewatering, settlement, and strip-on-foundation response, documented from
				the current Stage 6 theory and references.
			</p>
			<div class="hero__actions">
				<a class="btn btn--primary" href="/">Open the app</a>
				<a class="btn btn--outline-dark" href="#conventions">Read the theory</a>
			</div>
			<div class="hero__trust">
				<span>Belgium</span>
				<span>Stage 6 implementation</span>
				<span>Technical reference</span>
			</div>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="On this page">
			<div class="docs-nav__title">Contents</div>
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
					<p>{section.intro}</p>

					{#each section.subsections as subsection}
						<section id={subsection.id} class="doc-subsection">
							<h3>{@html subsection.title}</h3>
							{#each subsection.paragraphs as paragraph}
								<p>{paragraph}</p>
							{/each}

							{#if subsection.equations}
								<div class="equations">
									{#each subsection.equations as eq}
										<div class="formula" aria-label="Engineering formula">{@html eq}</div>
									{/each}
								</div>
							{/if}

							{#if subsection.bullets}
								<ul class="notes">
									{#each subsection.bullets as bullet}
										<li>{bullet}</li>
									{/each}
								</ul>
							{/if}
						</section>
					{/each}

					<p class="refs-inline">
						<strong>Primary references:</strong>
						{section.references.join('; ')}.
					</p>
				</section>
			{/each}

			<section id="references" class="doc-card">
				<p class="section-label">Sources</p>
				<h2>7. References</h2>
				<p>
					The references below are the principal sources used to frame the current Stage 6
					implementation. Project-specific design remains subject to the governing code,
					national annex, site investigation, and engineering judgement.
				</p>
				<ul class="reference-list">
					{#each references as reference}
						<li>
							<strong>{reference.label}</strong> — {reference.detail}
						</li>
					{/each}
				</ul>
			</section>
		</main>
	</div>

	<footer class="docs-footer">
		<div class="docs-footer__inner">
			<div class="docs-footer__brand">
				<div class="docs-footer__logo">MADEP CPT Interpreter</div>
				<p class="docs-footer__tagline">
					Technical CPT interpretation, parameter derivation, and Stage 6 engineering screening.
				</p>
			</div>
			<div class="docs-footer__links">
				<p class="docs-footer__heading">Navigation</p>
				<a href="/">CPT app</a>
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
		background: linear-gradient(180deg, rgba(247, 244, 239, 0.92), rgba(247, 244, 239, 0));
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
		padding: 6.5rem 24px 3.75rem;
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
	}

	.doc-card {
		padding: 28px 28px 26px;
		border-top: 1px solid var(--color-border);
		background: transparent;
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
	}

	.equations {
		display: grid;
		gap: 10px;
		margin: 16px 0;
	}

	.equations :global(.formula),
	.equations :global(div) {
		margin: 0;
		padding: 10px 0 10px 18px;
		border-radius: 0;
		background: transparent;
		border: none;
		border-left: 2px solid rgba(24, 24, 26, 0.12);
		line-height: 1.45;
		white-space: normal;
		word-break: break-word;
		font-family: Georgia, 'Times New Roman', serif;
		font-size: 1rem;
		color: var(--color-primary);
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
		border-radius: var(--radius-sm);
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
			background: linear-gradient(180deg, rgba(17, 17, 16, 0.92), rgba(17, 17, 16, 0));
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
