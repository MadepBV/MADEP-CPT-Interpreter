<script lang="ts">
	const pageTitle = 'Technical Documentation — MADEP CPT Interpreter';
	const pageDescription =
		'Technical documentation for the MADEP CPT Interpreter: GEF loading, classification, layer derivation, model parameters, tuning, and engineering applications, with formulas, notation, and references.';
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

	type DocSubsection = {
		id: string;
		title: string;
		paragraphs: string[];
		equations?: string[];
		bullets?: string[];
		symbols?: { term: string; meaning: string }[];
	};

	type DocSection = {
		id: string;
		title: string;
		intro: string;
		references: string[];
		subsections: DocSubsection[];
	};

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
				{ label: 'Robertson (1990)', detail: 'Soil classification using the CPT. Canadian Geotechnical Journal, 27(1), 151–158.' },
				{ label: 'Robertson & Wride (1998)', detail: 'Evaluating cyclic liquefaction potential using the CPT. Canadian Geotechnical Journal, 35, 442–459.' }
			]
		},
		{
			title: 'Belgian/Dutch Practice Documents',
			items: [
				{ label: 'SB260', detail: 'Standaardbestek 260, artikel 21-6.4.10: karakteristieke grondparameters op basis van elektrische sondering.' },
				{ label: 'CUR 2003-7', detail: 'CPT-correlated geotechnical parameter guidance used in Belgian and Dutch practice.' },
				{ label: 'NEN 6740', detail: 'Dutch geotechnical design standard with stress-dependent CPT material classification.' },
				{ label: 'Deltares D-SHEET Piling User Manual', detail: 'Comparative implementation guidance for CUR and NEN CPT material classification methods.' },
				{ label: 'PLAXIS 2D 2018 Reference Manual', detail: 'Reference manual showing the broad CUR 3 layers classification chart with Sand, Silt, Clay, and Peat fields.' }
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
				'This page documents the technical logic of the MADEP CPT Interpreter from raw GEF import through Stage 6 engineering use. It is written as a theory-and-implementation note: formulas, classifications, parameter routes, engineering assumptions, and the principal references behind the current application.',
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
						{ term: 'q_c', meaning: 'cone resistance [MPa]' },
						{ term: 'f_s', meaning: 'sleeve friction [MPa]' },
						{ term: 'R_f', meaning: 'friction ratio [%]' },
						{ term: 'u_2', meaning: 'pore pressure behind the cone [MPa]' }
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
						{ term: 'z_TAW', meaning: 'elevation relative to TAW [m]' },
						{ term: 'z_surface', meaning: 'surface elevation [m TAW]' },
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
						'u = 10 · max(0, z − z<sub>w</sub>)',
						"σ'<sub>v0</sub> = max(σ<sub>v0</sub> − u, 1)",
						'q<sub>t</sub> = q<sub>c</sub> + u<sub>2</sub>(1 − a)',
						'Q<sub>t</sub> = max(0.1, (q<sub>t</sub> − σ<sub>v0</sub>/1000) / (σ′<sub>v0</sub>/1000))',
						'F<sub>r</sub> = clamp(|f<sub>s,eff</sub> / (q<sub>t</sub> − σ<sub>v0</sub>/1000)| · 100, 0.1, 10)',
						'I<sub>c</sub> = √[(3.47 − log<sub>10</sub>Q<sub>t</sub>)<sup>2</sup> + (log<sub>10</sub>F<sub>r</sub> + 1.22)<sup>2</sup>]'
					],
					symbols: [
						{ term: 'a', meaning: 'net area ratio [-]' },
						{ term: 'q_t', meaning: 'corrected cone resistance [MPa]' },
						{ term: 'f_s,eff', meaning: 'effective sleeve friction used in normalization [MPa]' },
						{ term: 'Q_t', meaning: 'normalized cone-resistance parameter [-]' },
						{ term: 'F_r', meaning: 'normalized friction ratio [%]' },
						{ term: 'I_c', meaning: 'soil behaviour type index [-]' }
					],
					bullets: [
						'The current app groups the normalized result into Gravel, Sand, Silty sand, Sandy clay, Clay, and Peat / organic.',
						'Sensitive fine-grained soil is not inferred separately from I<sub>c</sub> alone.'
					]
				},
				{
					id: 'stage2-cur',
					title: '2.2 CUR 3 layers — broad q<sub>c</sub>–R<sub>f</sub> zoning',
					paragraphs: [
						'The CUR 3 layers route is implemented as a direct q<sub>c</sub>–R<sub>f</sub> zoning rule based on the published broad chart with four material fields: Sand, Silt, Clay, and Peat. It is a boundary-generation method, not a detailed parameter catalogue.',
						'To keep the downstream parameter workflow stable, the chart field “Silt” is carried internally as the app’s intermediate family and tagged with the subtype marker <em>CUR3 silt</em>. The chart logic itself remains four-zoned.'
					],
					equations: [
						'R<sub>f</sub> &gt; 4.0 &nbsp;&nbsp; → &nbsp;&nbsp; Peat / organic',
						'R<sub>f</sub> &lt; 1.0 and q<sub>c</sub> &gt; 1.5 &nbsp;&nbsp; → &nbsp;&nbsp; Sand',
						'R<sub>f</sub> &lt; 2.0 and 0.5 ≤ q<sub>c</sub> ≤ 1.5 &nbsp;&nbsp; → &nbsp;&nbsp; Silt field',
						'otherwise &nbsp;&nbsp; → &nbsp;&nbsp; Clay'
					],
					symbols: [
						{ term: 'q_c', meaning: 'measured cone resistance [MPa]' },
						{ term: 'R_f', meaning: 'measured friction ratio [%]' }
					],
					bullets: [
						'This route is direct and non-normalized: no stress correction is applied to q<sub>c</sub> before classification.',
						'The current app uses this route for broad layer boundary logic; detailed geotechnical parameter assignment is still handled later by the Stage 3 parameter method.',
						'Internal mapping note: the chart field “Silt” is stored as the app’s intermediate type family so that later parameter and compatibility tables remain usable.'
					]
				},
				{
					id: 'stage2-nen',
					title: '2.3 NEN 6740 — stress-dependent material classification',
					paragraphs: [
						'NEN 6740 uses a stress-corrected cone resistance together with friction ratio. The source method is graphical: a semilog chart with fourteen material areas rather than a closed algebraic decision tree.',
						'The app therefore separates the method into two parts. First it evaluates the published stress correction. Then it applies a transparent implementation rule that selects the nearest representative area from a digitized fourteen-material set.'
					],
					equations: [
						'q<sub>c,NEN</sub> = q<sub>c</sub> · (100 / σ′<sub>v0</sub>)<sup>0.67</sup>',
						's = log<sub>10</sub>(q<sub>c,NEN</sub>) − 0.18R<sub>f</sub>',
						'i = arg min<sub>j</sub> |s − s<sub>j</sub>|'
					],
					symbols: [
						{ term: 'q_c,NEN', meaning: 'stress-corrected cone resistance used by the NEN chart [MPa]' },
						{ term: 'σ′_v0', meaning: 'initial effective vertical stress at the CPT reading [kPa]' },
						{ term: 's', meaning: 'implemented chart-coordinate projection used for the representative-area search [-]' },
						{ term: 's_j', meaning: 'projected coordinate of representative material area j [-]' }
					],
					bullets: [
						'The stress-correction equation is part of the published NEN route; the one-dimensional chart projection is an implementation device used by the app to turn the graphical source into a deterministic classifier.',
						'The representative materials are: gravel, slightly silty, moderate; sand, clean, stiff; sand, slightly silty, moderate; sand, very silty, loose; loam, very sandy, stiff; loam, slightly sandy, weak; clay, very sandy, stiff; clay, slightly sandy, moderate; clay, clean, stiff; clay, clean, weak; clay, organic, moderate; clay, organic, weak; peat, moderately preloaded, moderate; peat, not preloaded, weak.',
						'The selected NEN material is then mapped into the app’s internal type families so that later layer grouping and parameter workflows remain consistent.'
					]
				},
				{
					id: 'stage2-ec7',
					title: '2.4 NEN Tabel 3 / EC7 — direct subtype classification',
					paragraphs: [
						'The Table 3 route uses raw q<sub>c</sub> and R<sub>f</sub> and returns not only a soil family but the corresponding Eurocode subtype and its characteristic parameter row. Because the original table contains overlapping envelopes, the app checks rows in table order rather than trying to enforce mutual exclusivity.',
						'The implemented family order is grind, zand, leem, klei, then veen. Within each family, subrows are checked top-to-bottom, with lower bounds inclusive and upper bounds exclusive unless the source notation states a closed interval.',
						'For this method, the raw boundary logic follows the detailed Eurocode subtype result rather than only the broad family. This means subtype changes such as density or consistency transitions inside one family can create provisional layer boundaries before smart merge and minimum-thickness correction simplify them.'
					],
					bullets: [
						'The table distinguishes, for example, zandhoudende leem from leemhoudend zand; those are not interchangeable.',
						'If no table row matches, the app keeps a deterministic fallback so the workflow can continue, but that fallback is not itself part of Table 3.'
					]
				},
				{
					id: 'stage2-separation',
					title: '2.5 Classification versus parameter assignment',
					paragraphs: [
						'Stage 2 is boundary logic only. The classification method decides which soil type each CPT reading belongs to and therefore where soil-type changes occur with depth.',
						'Stage 3 parameter assignment is independent of the chosen classification route. A layer identified by Robertson, CUR 3 layers, or NEN 6740 may still be assigned a Eurocode Table 3 subtype and its associated γ, γ<sub>sat</sub>, φ′, c′, and c<sub>u</sub> values.'
					]
				}
			],
			references: [
				'Robertson (1990)',
				'Robertson & Wride (1998)',
				'PLAXIS 2D 2018 Reference Manual',
				'NEN 6740',
				'Deltares D-SHEET Piling User Manual',
				'EN 1997-1:2004+A1:2013'
			]
		},
		{
			id: 'stage3',
			title: '3. Stage 3 — Layer Detection And Parameter Assignment',
			intro:
				'Once every CPT reading carries a classification label, the app converts that pointwise sequence into engineering layers by grouping consecutive identical types and then merging thin segments upward.',
			subsections: [
				{
					id: 'stage3-boundaries',
					title: '3.1 Boundary detection and upward thin-layer merging',
					paragraphs: [
						'The first pass creates a new segment whenever the classified type changes. In baseline mode, a second pass then merges thin segments upward into their predecessor until all remaining segments satisfy the chosen minimum thickness.',
						'The thickness check is applied to the segment boundaries used by the layer model, not merely to the difference between first and last retained CPT reading. The topmost segment is never merged upward because there is no segment above it. This makes the merge direction deterministic and reproducible.'
					],
					equations: [
						't = z<sub>bot</sub> − z<sub>top</sub>',
						'if t &lt; t<sub>min</sub> and the segment is not the first, merge upward'
					],
					symbols: [
						{ term: 't', meaning: 'segment thickness from the active layer boundaries [m]' },
						{ term: 't_min', meaning: 'minimum retained layer thickness [m]' }
					]
				},
				{
					id: 'stage3-smart-merge',
					title: '3.1A Smart merge correction',
					paragraphs: [
						'The app also provides a smart-merge mode. This mode is applied only after the original raw layering has already been created from the unmodified point-by-point classification sequence and after the baseline upward thin-layer merge has been carried out.',
						'It therefore acts as a post-correction on the provisional layers. First it removes highly compatible existing boundaries when the continuity score exceeds a sensitivity-controlled threshold. Only after that reduction step does it enforce the minimum thickness by merging every remaining sub-minimum layer with its most similar neighbor.',
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
						{ term: 'S_type', meaning: 'type-family agreement score [-]' },
						{ term: 'S_qc', meaning: 'cone-resistance similarity score [-]' },
						{ term: 'S_Rf', meaning: 'friction-ratio similarity score [-]' },
						{ term: 'S_subtype', meaning: 'Eurocode subtype-group similarity score [-]' },
						{ term: 'S_param', meaning: 'parameter similarity score using φ′, γ, c′, and where relevant c_u [-]' },
						{ term: 'S_compat', meaning: 'compatibility score between the CPT family and neighboring subtype group [-]' },
						{ term: 'S_cont', meaning: 'continuity score against the outer layer beyond the immediate neighbor [-]' },
						{ term: 'P', meaning: 'penalty term for sharp transitions and critical marker layers [-]' },
						{ term: 'λ', meaning: 'smart-merge sensitivity slider in the range 0…2 [-]' },
						{ term: 'ΔS_min', meaning: 'minimum score lead required for one direction to override the tie-break rule [-]' },
						{ term: 'S_pair', meaning: 'symmetric compatibility score of one existing baseline boundary [-]' },
						{ term: 'S_crit', meaning: 'minimum pair score required for a post-merge removal of an existing boundary [-]' }
					],
					bullets: [
						'The original boundary detection step is never redefined by smart merge; smart merge operates only after the base layering algorithm has already run.',
						'In smart mode, similarity-based reduction is applied before the final minimum-thickness enforcement. The minimum thickness therefore acts as the last hard constraint, not as the first distortion of the layering.',
						'Because it is a post-merge correction, smart merge can only keep or further reduce the raw layer count; it does not create a finer final layering than the original classification-derived segmentation.',
						'Very thin sections are intentionally down-weighted in the resistance to merging: sliver layers receive a small merge bonus, and sharp-transition penalties are attenuated when the layer thickness is small relative to a fixed sliver reference. This early similarity reduction is therefore independent of the chosen minimum thickness.',
						'Low sensitivity keeps smart merge closer to the conservative baseline behavior; high sensitivity allows smaller continuity advantages to influence the merge direction and makes it easier to remove highly compatible boundaries.',
						'If the two candidate directions are nearly equal, the app resolves the tie by merging into the thicker neighboring layer; if the thicknesses are equal, upward merge is chosen.',
						'The penalty term reduces the score for large q_c jumps, large R_f jumps, peat/non-peat transitions, gravel/non-gravel transitions, and thin layers that act as critical markers such as very weak peat, very coarse gravel, very high R_f, or extreme q_c.',
						'If smart merge is turned off, the app reverts to the simpler correction rule: every sub-minimum segment is merged upward into the preceding segment, except the first segment which cannot merge upward.'
					]
				},
				{
					id: 'stage3-statistics',
					title: '3.2 Per-layer statistics',
					paragraphs: [
						'After merging, the layer stores mean q<sub>c</sub>, mean f<sub>s</sub>, and mean R<sub>f</sub> over all valid CPT points in the merged segment. The representative subtype string is the modal subtype within that segment.',
						'These average values provide the Stage 4 input for stiffness and conductivity derivation.'
					],
					equations: [
						'avg q<sub>c</sub> = mean(q<sub>c,j</sub>)',
						'avg f<sub>s</sub> = mean(f<sub>s,j</sub>)',
						'avg R<sub>f</sub> = mean(R<sub>f,j</sub>)'
					],
					symbols: [
						{ term: 'q_c,j, f_s,j, R_f,j', meaning: 'valid CPT point values inside one merged segment' }
					]
				},
				{
					id: 'stage3-parameters',
					title: '3.3 Default parameter assignment',
					paragraphs: [
						'For Robertson and CUR classifications, the app assigns default geotechnical values from a generic type table. For the Eurocode Table 3 route, the app instead averages the row parameters that matched each CPT point inside the merged segment.',
						'All assigned values remain editable, and manual overrides always take precedence over automatic assignment.'
					],
					equations: [
						'γ = mean(γ<sub>row</sub>)',
						'γ<sub>sat</sub> = mean(γ<sub>sat,row</sub>)',
						'φ′ = round(mean(φ′<sub>row</sub>))',
						'c′ = round(mean(c′<sub>row</sub>))',
						'c<sub>u</sub> = round(mean(c<sub>u,row</sub>))'
					],
					symbols: [
						{ term: 'γ, γ_sat', meaning: 'unsaturated and saturated unit weight [kN/m³]' },
						{ term: 'φ′', meaning: 'effective friction angle [degrees]' },
						{ term: 'c′', meaning: 'effective cohesion [kPa]' },
						{ term: 'c_u', meaning: 'undrained shear strength [kPa]' }
					]
				}
			],
			references: ['EN 1997-1:2004+A1:2013', 'CUR 2003-7']
		},
		{
			id: 'stage4',
			title: '4. Stage 4 — Model Parameters',
			intro:
				'Stage 4 transforms the interpreted CPT layer into constitutive parameters for stiffness-based engineering use. The key tasks are effective-stress reconstruction, q<sub>c</sub>-to-stiffness correlation, reference-stress correction, and the assignment of auxiliary parameters such as K<sub>0,nc</sub>, ν<sub>ur</sub>, and hydraulic conductivity.',
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
						'u = 10 · max(0, z<sub>mid</sub> − z<sub>w</sub>)',
						"σ′<sub>v0</sub> = max(σ<sub>v0</sub> − u, 1)"
					],
					symbols: [
						{ term: 'z_mid', meaning: 'layer midpoint depth [m]' },
						{ term: 'z_top, z_bot', meaning: 'layer top and bottom depth [m]' },
						{ term: 'z_w', meaning: 'water-table depth below surface [m]' },
						{ term: 'σ_v0', meaning: 'initial total vertical stress [kPa]' },
						{ term: 'σ′_v0', meaning: 'initial effective vertical stress [kPa]' }
					]
				},
				{
					id: 'stage4-alpha',
					title: '4.2 q<sub>c</sub>-to-E<sub>oed,i</sub> correlation and α methods',
					paragraphs: [
						'The first stiffness step converts the representative cone resistance into an oedometric modulus through the Sanglerat or SB260 α correlation.',
						'Method A uses a fixed α per behavioural soil type. Method B uses the selected EC7 Table 3 soil family and then applies the SB260 family-specific q<sub>c</sub> rules.'
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
						{ term: 'avg q_c', meaning: 'mean cone resistance of the layer [MPa]' },
						{ term: 'E_oed,i', meaning: 'CPT-derived oedometric stiffness before reference-stress correction [kPa]' }
					],
					bullets: [
						'For peat, water content w is not available in the app, so the SB260 default α = 1.5 is used.',
						'Transition soils are mapped from the selected EC7 subtype rather than from q<sub>c</sub> and R<sub>f</sub> alone.'
					]
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
						{ term: 'E_oed,ref', meaning: 'reference oedometric stiffness at p_ref [kPa]' },
						{ term: 'E_50,ref', meaning: 'reference secant stiffness for primary loading [kPa]' },
						{ term: 'E_ur,ref', meaning: 'reference unloading/reloading stiffness [kPa]' },
						{ term: 'K_0,nc', meaning: 'at-rest earth-pressure coefficient for normally consolidated state [-]' }
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
						'Anisotropy is then introduced through a k<sub>h</sub>/k<sub>v</sub> ratio: isotropic for coarse granular soils, higher horizontal-than-vertical conductivity for fine-grained and layered soils.'
					],
					equations: [
						'k<sub>h,rep</sub> = √(k<sub>h,min</sub>k<sub>h,max</sub>)',
						'k<sub>v</sub> = k<sub>h</sub> / a<sub>kv</sub>'
					],
					symbols: [
						{ term: 'k_h,rep', meaning: 'representative horizontal conductivity [m/s]' },
						{ term: 'k_h,min, k_h,max', meaning: 'adopted conductivity range [m/s]' },
						{ term: 'a_kv', meaning: 'anisotropy ratio k_h / k_v [-]' },
						{ term: 'k_v', meaning: 'vertical conductivity [m/s]' }
					],
					bullets: [
						'Indicative anisotropy in the current logic is 1 for sand and gravel, and 3 for clay, loam, silty soils, and peat.',
						'In-situ measurement takes priority over indicative table values.'
					]
				}
			],
			references: ['SB260', 'CUR 2003-7', 'Schanz, Vermeer & Bonnier (1999)', 'OVAM / I-RA-11461 (2002)', 'De Smedt / VUB (2005)']
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
						{ term: 'X_j, Y_j', meaning: 'log-transformed stress-ratio and stiffness points for CPT point j' },
						{ term: 'a', meaning: 'intercept of the regression line; exp(a) = E_oed,ref' }
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
						{ term: 'm_fit', meaning: 'fitted stress exponent before engineering acceptance [-]' },
						{ term: 'E_oed,ref,fit', meaning: 'fitted reference oedometric stiffness [kPa]' },
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
						'σ<sub>v</sub>(z) = Σ γ<sub>i</sub> · Δz<sub>i</sub>',
						"σ′<sub>v</sub>(z) = σ<sub>v</sub>(z) − u(z)"
					],
					symbols: [
						{ term: 'z', meaning: 'depth below ground level [m]' },
						{ term: 'z_w', meaning: 'phreatic level depth below ground [m]' },
						{ term: 'γ_w', meaning: 'unit weight of water [kN/m³]' },
						{ term: 'γ_i', meaning: 'unit weight of layer i [kN/m³]' },
						{ term: 'Δz_i', meaning: 'thickness contribution of layer i [m]' },
						{ term: 'u', meaning: 'pore pressure [kPa]' },
						{ term: 'σ_v', meaning: 'total vertical stress [kPa]' },
						{ term: 'σ′_v', meaning: 'effective vertical stress [kPa]' }
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
						{ term: 'E_oed', meaning: 'oedometric stiffness modulus [kPa or MPa, used consistently]' },
						{ term: 'E_oed,ref', meaning: 'reference oedometric stiffness at p_ref [kPa or MPa]' },
						{ term: 'σ′_1', meaning: 'effective major principal stress, taken here as vertical effective stress [kPa]' },
						{ term: 'c′', meaning: 'effective cohesion [kPa]' },
						{ term: 'φ′', meaning: 'effective friction angle [degrees]' },
						{ term: 'p_ref', meaning: 'reference stress, here 100 kPa' },
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
						'The formulas used are the standard classical shallow-foundation expressions currently implemented in the app.'
					],
					equations: [
						"q<sub>ult,d</sub> = c′N<sub>c</sub>s<sub>c</sub> + q′N<sub>q</sub>s<sub>q</sub> + 0.5γ′BN<sub>γ</sub>s<sub>γ</sub>",
						'q<sub>ult,u</sub> = q + 5.14c<sub>u</sub>s<sub>cu</sub>',
						'N<sub>q</sub> = exp(πtanφ′) · tan<sup>2</sup>(45° + φ′/2)',
						'N<sub>c</sub> = (N<sub>q</sub> − 1) / tanφ′',
						'N<sub>γ</sub> = 2(N<sub>q</sub> + 1)tanφ′'
					],
					symbols: [
						{ term: 'q_ult,d', meaning: 'ultimate drained bearing resistance [kPa]' },
						{ term: 'q_ult,u', meaning: 'ultimate undrained bearing resistance [kPa]' },
						{ term: 'c′', meaning: 'effective cohesion [kPa]' },
						{ term: 'q′', meaning: 'effective surcharge at foundation depth [kPa]' },
						{ term: 'γ′', meaning: 'effective unit weight below the water table [kN/m³]' },
						{ term: 'B', meaning: 'foundation width [m]' },
						{ term: 'c_u', meaning: 'undrained shear strength [kPa]' },
						{ term: 'N_c, N_q, N_γ', meaning: 'bearing-capacity factors [-]' },
						{ term: 's_c, s_q, s_γ, s_cu', meaning: 'shape factors [-]' }
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
						{ term: 'φ′_k, c′_k, c_u,k', meaning: 'characteristic soil strengths' },
						{ term: 'φ′_d, c′_d, c_u,d', meaning: 'design soil strengths' },
						{ term: 'γ_Rd', meaning: 'resistance/model factor in the EC7 route [-]' },
						{ term: 'ξ', meaning: 'global system factor [-]' }
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
						{ term: 'k_eff,h', meaning: 'equivalent horizontal conductivity [m/s]' }
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
						{ term: 'k_h,i', meaning: 'horizontal conductivity of layer i [m/s]' },
						{ term: 'b_i', meaning: 'currently saturated thickness of layer i [m]' },
						{ term: 'T(h)', meaning: 'transmissivity as a function of saturated thickness h [m²/s]' },
						{ term: 'M(h)', meaning: 'cumulative transmissivity moment [m³/s]' },
						{ term: 'h_0, h_w', meaning: 'saturated thickness at far field and at the source [m]' },
						{ term: 'Q', meaning: 'screening discharge [m³/s]' },
						{ term: 'r_w', meaning: 'well radius or equivalent well radius [m]' },
						{ term: 'A', meaning: 'excavation plan area [m²]' }
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
						{ term: 'r_CPT', meaning: 'distance from the source to the CPT [m]' },
						{ term: 'h(r)', meaning: 'saturated thickness at distance r [m]' },
						{ term: 'Δh_CPT', meaning: 'drawdown at the CPT [m]' }
					]
				},
				{
					id: 'dewatering-stress',
					title: '8.4 Effective stress and settlement response',
					paragraphs: [
						'Once the new phreatic level at the CPT is known, the app recomputes pore pressure and effective stress with two selectable total-stress assumptions: conservative σ<sub>v</sub> fixed, or realistic γ<sub>sat</sub> → γ between the old and new water levels.',
						'Settlement is then computed with the same constrained-modulus philosophy used in the settlement app, evaluated at the mean stress state between before and after drawdown.'
					],
					equations: [
						"u′(z) = γ<sub>w</sub> · max(0, z − z′<sub>w</sub>)",
						"σ′<sub>v</sub>′(z) = σ<sub>v</sub>(z) − u′(z)",
						"Δσ′<sub>v</sub>(z) = σ′<sub>v,new</sub>(z) − σ′<sub>v,old</sub>(z)",
						"σ′<sub>mean</sub> = 0.5(σ′<sub>v,old</sub> + σ′<sub>v,new</sub>)",
						"Δε<sub>v,i</sub> = Δσ′<sub>v,i</sub> / E<sub>oed,i</sub>",
						'ΔS<sub>dewatering</sub> = ΣΔε<sub>v,i</sub>Δz<sub>i</sub>',
						'c<sub>v</sub> = k<sub>v</sub>E<sub>oed</sub> / γ<sub>w</sub>'
					],
					symbols: [
						{ term: 'z′_w', meaning: 'new phreatic level depth below ground [m]' },
						{ term: 'σ′_v,new, σ′_v,old', meaning: 'new and original effective vertical stress [kPa]' },
						{ term: 'Δσ′_v', meaning: 'effective stress increase due to drawdown [kPa]' },
						{ term: 'σ′_mean', meaning: 'mean effective stress used for stiffness evaluation [kPa]' },
						{ term: 'Δε_v,i', meaning: 'vertical strain increment in sublayer i [-]' },
						{ term: 'ΔS_dewatering', meaning: 'total dewatering-induced settlement [m or mm depending on output]' },
						{ term: 'k_v', meaning: 'vertical conductivity [m/s]' },
						{ term: 'c_v', meaning: 'consolidation coefficient [m²/s]' }
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
						{ term: 'q_gross', meaning: 'gross applied stress at foundation level [kPa]' },
						{ term: 'q_net', meaning: 'net applied stress after subtracting in-situ overburden [kPa]' },
						{ term: 'D_f', meaning: 'founding depth below ground [m]' },
						{ term: 'ΔS_i', meaning: 'settlement contribution of sublayer i [m or mm depending on output]' },
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
						{ term: 'V, V₁, A, B_factor', meaning: 'intermediate Newmark/Fadum terms [-]' },
						{ term: 'I_z', meaning: 'vertical stress influence factor [-]' },
						{ term: 'Δσ_v', meaning: 'vertical stress increase [kPa]' }
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
						{ term: 'σ′_v,0,i', meaning: 'initial effective stress in sublayer i [kPa]' },
						{ term: 'σ′_v,f,i', meaning: 'final effective stress in sublayer i [kPa]' },
						{ term: 'σ′_mean,i', meaning: 'mean effective stress in sublayer i [kPa]' },
						{ term: 'E_oed,i', meaning: 'oedometric stiffness of sublayer i [kPa or MPa, used consistently]' },
						{ term: 'Δε_v,i', meaning: 'vertical strain increment in sublayer i [-]' },
						{ term: 'Δz_i', meaning: 'sublayer thickness [m]' }
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
						'The current implementation derives k<sub>s</sub> from CPT-linked stiffness using the Vesić route. The app offers a self-consistent default route in which E<sub>s</sub> is taken from E<sub>oed</sub> and ν<sub>s</sub> = 0, consistent with the oedometric nature of the interpreted stiffness.',
						'The stiffness is averaged over an influence depth below the foundation, so k<sub>s</sub> is not treated as a pure soil constant but as a footing-dependent support parameter.'
					],
					equations: [
						'k<sub>s</sub> = [0.65E<sub>s</sub> / B(1 − ν<sub>s</sub><sup>2</sup>)] · (E<sub>s</sub>B<sup>4</sup> / E<sub>b</sub>I<sub>b</sub>)<sup>1/12</sup>',
						'E<sub>s</sub> ≈ E<sub>oed</sub>, &nbsp; ν<sub>s</sub> = 0 &nbsp;&nbsp; current default route'
					],
					symbols: [
						{ term: 'k_s', meaning: 'modulus of subgrade reaction [kN/m³]' },
						{ term: 'E_s', meaning: 'soil stiffness used for foundation response [kPa or MPa, used consistently]' },
						{ term: 'ν_s', meaning: 'soil Poisson ratio [-]' },
						{ term: 'B', meaning: 'foundation width [m]' },
						{ term: 'E_b', meaning: 'beam or slab Young modulus [consistent stress units]' },
						{ term: 'I_b', meaning: 'second moment of area per strip [m⁴]' }
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
						{ term: 'G_p', meaning: 'Pasternak shear-layer parameter [kN/m]' },
						{ term: 'λ', meaning: 'characteristic length [m]' },
						{ term: 'β', meaning: 'inverse characteristic length [1/m]' }
					]
				},
				{
					id: 'beam-pasternak',
					title: '10.3 Pasternak 1D implementation',
					paragraphs: [
						'The Pasternak extension currently implemented in the app is a 1D strip formulation. The shear-layer parameter is not measured directly; it is inferred from the averaged soil shear modulus and a chosen influence depth.',
						'This is why the Pasternak route is labeled as a screening extension rather than a continuum-calibrated Belgian design model.'
					],
					equations: [
						'G<sub>p</sub> = ηG<sub>s,avg</sub>H<sub>p</sub>',
						'G<sub>s,avg</sub> = E<sub>s,avg</sub> / [2(1 + ν<sub>s</sub>)]',
						'H<sub>p</sub> = z<sub>influence</sub>'
					],
					symbols: [
						{ term: 'η', meaning: 'engineer scaling factor for Pasternak coupling [-]' },
						{ term: 'G_s,avg', meaning: 'average soil shear modulus over the influence zone [consistent stress units]' },
						{ term: 'H_p', meaning: 'Pasternak influence depth [m]' },
						{ term: 'z_influence', meaning: 'depth range used for averaging the supporting soil stiffness [m]' }
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
						{ term: 'f_ck', meaning: 'characteristic concrete compressive strength [MPa]' },
						{ term: 'f_cd', meaning: 'design concrete compressive strength [MPa]' },
						{ term: 'f_yk', meaning: 'characteristic steel yield strength [MPa]' },
						{ term: 'f_yd', meaning: 'design steel yield strength [MPa]' },
						{ term: 'γ_C, γ_S', meaning: 'partial factors for concrete and steel [-]' },
						{ term: 'h', meaning: 'member thickness [m]' },
						{ term: 'c_nom', meaning: 'nominal concrete cover [same length unit as input]' },
						{ term: 'φ_bar', meaning: 'bar diameter [same length unit as input]' },
						{ term: 'M_Ed', meaning: 'design bending moment [kNm/m or consistent strip units]' },
						{ term: 'A_s,req', meaning: 'required reinforcement area per meter width [mm²/m]' }
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
			<h1>CPT interpretation and engineering theory, structured and referenced.</h1>
			<p class="hero__lead">
				A technical implementation note for the live MADEP CPT workflow: GEF loading,
				classification, layer and parameter derivation, experimental tuning, and the current
				engineering applications, documented from the active logic and reference base.
			</p>
			<div class="hero__actions">
				<a class="btn btn--primary" href="/">Open the app</a>
				<a class="btn btn--outline-dark" href="#stage1">Read the theory</a>
			</div>
			<div class="hero__trust">
				<span>Belgium</span>
				<span>Full CPT workflow</span>
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
					<div class="docs-footer__logo">MADEP CPT Interpreter</div>
					<p class="docs-footer__tagline">
						Technical CPT interpretation, parameter derivation, and engineering screening.
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
