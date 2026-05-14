<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';

	const pageTitle = 'Methods, Formulations, and Assumptions — MADEP CPT Interpreter';
	const pageDescription =
		'Cross-cutting technical methods for the MADEP CPT Interpreter: shared notation, governing equations, constitutive and hydraulic formulations, and declared modelling assumptions.';
	const canonicalUrl = 'https://cpt.madep.be/docs/theory';
	const ogImageUrl = 'https://cpt.madep.be/logo.png';
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
			<p class="hero__eyebrow">Methods, formulations, and assumptions</p>
			<h1>Shared notation, governing equations, and modelling assumptions.</h1>
			<p class="hero__lead">
				This chapter records the mathematical structure that is shared across the public
				manual: notation, sign conventions, hydraulic and mechanical governing equations,
				CPT-to-parameter relations, and the numerical assumptions that define the public
				solver routes.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Methods documentation navigation">
			<div class="docs-nav__title">Methods</div>
			<a href="#overview">Scope and structure</a>
			<a href="#conventions">Conventions and notation</a>
			<a href="#voigt">Voigt notation and elastic matrix</a>
			<a href="#classification">Classification and parameter logic</a>
			<a href="#seepage">Seepage formulation</a>
			<a href="#deformation">Deformation formulation</a>
			<a href="#mc">Mohr-Coulomb yield theory</a>
			<a href="#tension">Tension cut-off</a>
			<a href="#numerics">Numerical assumptions</a>
			<a href="#references">Source basis</a>
		</aside>

		<main class="docs-content">
			<section id="overview" class="doc-card">
				<p class="section-label">Scope</p>
				<h2>1. Scope, role, and document structure</h2>
				<p>
					This chapter consolidates the equations, conventions, and declared modelling
					assumptions that recur across the interpretation workflow and the Stage 6 engineering
					analyses. Its purpose is to make the mathematical basis of the public routes explicit,
					consistent, and auditable.
				</p>
				<ul class="notes">
					<li><strong>Interpretation</strong> documents how Stages 1 to 5 derive the engineering layer model from the CPT record.</li>
					<li><strong>Stage 6</strong> documents the individual engineering analyses and the interpretation of their outputs.</li>
					<li><strong>Methods</strong> records the shared theoretical framework used by those routes.</li>
					<li><strong>References</strong> records the standards, literature, and traceability basis.</li>
				</ul>

				<section class="doc-subsection">
					<h3>1.1 Coverage</h3>
					<p>
						The documentation covers the implemented interpretation workflow: CPT file parsing
						for GEF, Excel, and CSV sources, per-point CPT classification, layer detection,
						layer parameter assignment, stiffness derivation, and experimental m-fitting. It
						is intended as the full technical account of Stages 1 to 5 rather than a short
						product summary.
					</p>
					<p>
						Where the application contains an engineering simplification, the simplification
						is stated explicitly. The purpose is not to replace engineering judgement, but to
						make the implemented mathematics auditable and readable.
					</p>
					<ul class="notes">
						<li>Classification and boundary logic are documented separately from parameter assignment.</li>
						<li>Stage 6 uses the interpreted CPT state produced by the earlier stages rather than reclassifying the profile independently.</li>
						<li>The notation follows geotechnical convention with compression positive and depth measured downward.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>1.2 Layer quantities carried into engineering use</h3>
					<p>
						Per interpreted layer, the application carries the quantities needed by the
						engineering modules:
					</p>
					<div class="equations">
						<div class="formula">&#123; z<sub>top</sub>, z<sub>bot</sub>, γ, γ<sub>sat</sub>, φ′, c′, c<sub>u</sub>, E<sub>oed,ref</sub>, E<sub>oed,i</sub>, E<sub>50,ref</sub>, E<sub>ur,ref</sub>, m, K<sub>0,nc</sub>, ν<sub>ur</sub>, k<sub>h</sub>, k<sub>v</sub> &#125;</div>
					</div>
					<p>
						Geometry, load combination, hydraulic scenario, and optional Stage 5 tuning are
						then applied on top of those layer values. The Stage 6 analyses do not reclassify
						the profile — they consume the interpreted layer model directly.
					</p>
				</section>
			</section>

			<section id="conventions" class="doc-card">
				<p class="section-label">Conventions and notation</p>
				<h2>2. Shared sign, stress, kinematic, and hydraulic conventions</h2>

				<section class="doc-subsection">
					<h3>2.1 Effective stress convention</h3>
					<p>
						Compression is taken as positive throughout the engineering modules. Depth z is
						measured downward from ground level. Elevation values are interpreted in Belgian
						TAW convention where relevant. The in-situ effective-stress profile is
						reconstructed from the active groundwater level and the interpreted unit weights.
					</p>
					<div class="equations">
						<div class="formula">σ′ = σ − u I</div>
						<div class="formula">u(z) = γ<sub>w</sub> · max(0, z − z<sub>w</sub>)</div>
						<div class="formula">σ<sub>v</sub>(z) = Σ γ<sub>i</sub> · Δz<sub>i</sub> &nbsp;&nbsp; with γ<sub>i</sub> = γ for z<sub>i</sub> ≤ z<sub>w</sub>, γ<sub>i</sub> = γ<sub>sat</sub> for z<sub>i</sub> &gt; z<sub>w</sub></div>
						<div class="formula">σ′<sub>v</sub>(z) = σ<sub>v</sub>(z) − u(z)</div>
					</div>
					<p>
						Only the normal stress components are shifted by pore pressure — the shear
						components are unaffected. Above the phreatic level the dry unit weight γ is used;
						below it, γ<sub>sat</sub> is used. Compression-positive effective stress is the
						natural convention for Mohr-Coulomb evaluation and geostatic interpretation, and
						all later normal/effective distinctions in the deformation route follow from this
						sign rule.
					</p>
					<ul class="notes">
						<li>z is depth below ground level [m]; z<sub>w</sub> is the phreatic level depth below ground [m].</li>
						<li>γ is the unit weight above the phreatic level; γ<sub>sat</sub> below; γ<sub>w</sub> is the unit weight of water.</li>
						<li>Δz<sub>i</sub> is the thickness contribution of layer i; γ<sub>i</sub> is the unit weight selected for that layer's position relative to the phreatic level.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>2.2 Hydraulic head convention</h3>
					<p>
						The seepage route solves for total head, from which pore pressure is derived:
					</p>
					<div class="equations">
						<div class="formula">h = y + u / γ<sub>w</sub></div>
						<div class="formula">u = γ<sub>w</sub>(h − y)</div>
					</div>
					<p>
						This convention is consistent with the current Stage 6 seepage and coupling logic.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>2.3 Plane strain and small strain</h3>
					<p>
						The public deformation route uses plane strain on a two-dimensional section and
						assumes small strain:
					</p>
					<div class="equations">
						<div class="formula">ε<sub>zz</sub> = 0</div>
					</div>
					<p>
						The geometry is therefore not updated during the current equilibrium iterations.
					</p>
				</section>
			</section>

			<section id="voigt" class="doc-card">
				<p class="section-label">Voigt notation</p>
				<h2>3. Voigt-6 stress, strain, and elastic matrix</h2>
				<section class="doc-subsection">
					<h3>3.1 Vector convention and engineering shear</h3>
					<p>
						All six-component tensor quantities in the deformation route use the Voigt-6
						convention with engineering shear strain (γ = 2ε). The order is [xx, yy, zz, xy, yz,
						zx] for stress and strain; the engineering shear factor lets the stress-strain
						relation read linearly as σ = D ε in the shear block.
					</p>
					<div class="equations">
						<div class="formula">σ = [σ<sub>xx</sub>, σ<sub>yy</sub>, σ<sub>zz</sub>, τ<sub>xy</sub>, τ<sub>yz</sub>, τ<sub>zx</sub>]<sup>T</sup></div>
						<div class="formula">ε = [ε<sub>xx</sub>, ε<sub>yy</sub>, ε<sub>zz</sub>, γ<sub>xy</sub>, γ<sub>yz</sub>, γ<sub>zx</sub>]<sup>T</sup>,   γ<sub>ij</sub> = 2 ε<sub>ij</sub><sup>tensor</sup></div>
						<div class="formula">σ : ε = σ<sub>xx</sub>ε<sub>xx</sub> + σ<sub>yy</sub>ε<sub>yy</sub> + σ<sub>zz</sub>ε<sub>zz</sub> + τ<sub>xy</sub>γ<sub>xy</sub> + τ<sub>yz</sub>γ<sub>yz</sub> + τ<sub>zx</sub>γ<sub>zx</sub></div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>3.2 Isotropic linear-elastic stiffness</h3>
					<div class="equations">
						<div class="formula">D<sub>e</sub> = λ ι<sub>6</sub>ι<sub>6</sub><sup>T</sup> + 2G I<sub>6</sub>     (with ι<sub>6</sub> = [1,1,1,0,0,0]<sup>T</sup>, I<sub>6</sub> the Voigt identity with the half-factor on shear)</div>
						<div class="formula">λ = E ν / [(1+ν)(1−2ν)],   G = E / [2(1+ν)]</div>
						<div class="formula">In block form, with engineering shear:</div>
						<div class="formula">D<sub>e</sub> = [[λ+2G, λ, λ; λ, λ+2G, λ; λ, λ, λ+2G] ⊕ G·diag(1,1,1)]</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>3.3 Plane-strain reduction</h3>
					<p>
						For plane strain ε<sub>zz</sub> = γ<sub>yz</sub> = γ<sub>zx</sub> = 0. The reduced 3×3
						elastic matrix, acting on plane strains [ε<sub>xx</sub>, ε<sub>yy</sub>, γ<sub>xy</sub>],
						is the xx/yy/xy block of D<sub>e</sub>:
					</p>
					<div class="equations">
						<div class="formula">D<sub>2D</sub> = (E / [(1+ν)(1−2ν)]) · [[1−ν, ν, 0; ν, 1−ν, 0; 0, 0, (1−2ν)/2]]</div>
					</div>
					<p>
						The out-of-plane effective stress σ′<sub>zz</sub> is not constrained to a single elastic
						closed form in plastic runs: σ′<sub>zz</sub> becomes an internal state variable and its
						K<sub>0</sub>-controlled initialization is preserved through the Stage 2 return map.
					</p>
				</section>
			</section>

			<section id="classification" class="doc-card">
				<p class="section-label">Classification and parameter logic</p>
				<h2>3. CPT-derived classification and parameter derivation</h2>

				<section class="doc-subsection">
					<h3>3.1 Raw CPT quantities</h3>
					<p>
						The interpretation chain starts from depth, cone resistance q<sub>c</sub>, sleeve
						friction f<sub>s</sub>, and optionally pore pressure u<sub>2</sub>. The friction
						ratio is central enough to record at the top:
					</p>
					<div class="equations">
						<div class="formula">R<sub>f</sub> = |f<sub>s</sub>| / q<sub>c</sub> · 100</div>
						<div class="formula">0 ≤ R<sub>f</sub> ≤ 20 &nbsp;&nbsp; after app-side clamping</div>
					</div>

					<h4 style="font-size:13px;color:var(--tx2);margin-top:12px">Supported file structures and column mapping</h4>
					<p>
						GEF files declare their physical quantities through <code>#COLUMNINFO</code> lines.
						The application reads the quantity identifier and maps it to the relevant column
						index; column order is therefore never assumed.
					</p>
					<ul class="notes">
						<li>GEF quantity 1: penetration length.</li>
						<li>GEF quantity 2: q<sub>c</sub>.</li>
						<li>GEF quantity 3: f<sub>s</sub>.</li>
						<li>GEF quantity 4: R<sub>f</sub>.</li>
						<li>GEF quantity 6: u<sub>2</sub>.</li>
						<li>GEF quantity 11: corrected depth, used before quantity 1 when both are present.</li>
					</ul>
					<p>
						Excel workbooks are read from a <code>Data</code> sheet and, when present, a
						<code>Header</code> sheet. The Data sheet may contain depth, q<sub>c</sub>,
						f<sub>s</sub>, and R<sub>f</sub>; the Header sheet can provide project, test,
						location, date, water level, surface level, coordinates, and the net area ratio.
						CSV files are the reduced-input route — they must contain headers <code>depth</code>
						and <code>qc</code>; <code>fs</code> and <code>rf</code> are optional. Comma,
						semicolon, and tab delimiters are detected automatically.
					</p>

					<h4 style="font-size:13px;color:var(--tx2);margin-top:12px">Unit conversion and row filtering</h4>
					<p>
						The parser converts q<sub>c</sub> and f<sub>s</sub> to MPa based on the declared
						GEF unit string or the Excel/CSV column header. Headers containing MPa are used
						directly; kPa is divided by 1000; Pa is divided by 1 000 000. If the unit
						declaration is absent or ambiguous, a heuristic fallback is used so the file
						remains workable, but explicit unit labels are strongly recommended.
					</p>
					<ul class="notes">
						<li>Depth is expected in metres below surface; rows with z &lt; 0 are discarded.</li>
						<li>Rows with q<sub>c</sub> &lt; 0.02 MPa are treated as cone-not-engaged and discarded.</li>
						<li>All-zero rows appended by logging software are discarded.</li>
						<li>R<sub>f</sub> is optional; when absent or invalid, the app computes it from f<sub>s</sub> and q<sub>c</sub> via the equation above.</li>
					</ul>

					<h4 style="font-size:13px;color:var(--tx2);margin-top:12px">Water table, elevation, and TAW metadata</h4>
					<p>
						The phreatic level is taken from the GEF measurement variables or the Excel
						Header field <code>Waterniveau</code> when available; otherwise a default depth
						below surface is assigned. Surface elevation is read from the GEF ZID header,
						the Excel Header field <code>Grondniveau</code>, or entered manually.
					</p>
					<div class="equations">
						<div class="formula">z<sub>TAW</sub> = z<sub>surface</sub> − z</div>
					</div>
					<p>
						When surface elevation is present, all depth values can be expressed relative to
						TAW as well as depth below surface.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>3.2 Classification is not parameter assignment</h3>
					<p>
						This is one of the most important design choices in the app. Robertson, CUR,
						NEN 6740, and NEN Tabel 3 all appear in the workflow, but they do not all serve
						the same purpose. The classification stage creates a rationalized soil
						interpretation; the parameter stage maps the final layer to engineering
						properties.
					</p>
					<div class="doc-callout">
						<strong>Important.</strong> A behavioural classification route and an engineering
						parameter route are not the same thing. The app keeps those steps separate on
						purpose so the engineer can understand and override them independently. Stage 2
						is boundary logic only — it decides which soil type each CPT reading belongs to,
						and therefore where soil-type changes occur with depth. Stage 3 parameter
						assignment is independent of the chosen Stage 2 classification route: a layer
						identified by Robertson, CUR 3 layers, or NEN 6740 may still be assigned a
						NEN Tabel 3 subtype and its associated γ, γ<sub>sat</sub>, φ′, c′, and
						c<sub>u</sub> values.
					</div>

					<h4 style="font-size:13px;color:var(--tx2);margin-top:12px">Robertson (1990) — normalized SBT / I<sub>c</sub></h4>
					<p>
						Robertson uses a normalized q<sub>t</sub>–F<sub>r</sub> framework. Because final
						layer unit weights are not yet available at Stage 2, the route uses a preliminary
						stress estimate with fixed γ = 17 kN/m³ above the water table and γ<sub>sat</sub> =
						18 kN/m³ below.
					</p>
					<div class="equations">
						<div class="formula">q<sub>t</sub> = q<sub>c</sub> + u<sub>2</sub>(1 − a) &nbsp;&nbsp; (q<sub>t</sub> = q<sub>c</sub> when u<sub>2</sub> absent)</div>
						<div class="formula">Q<sub>t</sub> = max(0.1, (q<sub>t</sub> − σ<sub>v0</sub>/1000) / (σ′<sub>v0</sub>/1000))</div>
						<div class="formula">F<sub>r</sub> = clamp(|f<sub>s,eff</sub> / (q<sub>t</sub> − σ<sub>v0</sub>/1000)| · 100, 0.1, 10)</div>
						<div class="formula">I<sub>c</sub> = √[(3.47 − log<sub>10</sub>Q<sub>t</sub>)² + (log<sub>10</sub>F<sub>r</sub> + 1.22)²]</div>
					</div>
					<p>
						The result is mapped into the app's broad families: Gravel, Sand, Silty sand,
						Sandy clay, Clay, and Peat / organic. Sensitive fine-grained soil is not inferred
						separately from I<sub>c</sub> alone.
					</p>

					<h4 style="font-size:13px;color:var(--tx2);margin-top:12px">Robertson (2016) — iterative Q<sub>tn</sub></h4>
					<p>
						Robertson 2016 keeps the same SBT / I<sub>c</sub> family mapping but replaces the
						fixed-stress-exponent cone normalization with an iterative Q<sub>tn</sub>
						formulation. The exponent n varies with the inferred soil behaviour and is solved
						iteratively. This route is preferred when the input is a CPTu, but the
						implementation does not require measured u<sub>2</sub>.
					</p>
					<div class="equations">
						<div class="formula">Q<sub>tn</sub> = ((q<sub>t</sub> · 1000 − σ<sub>v0</sub>) / p<sub>a</sub>) · (p<sub>a</sub> / σ′<sub>v0</sub>)<sup>n</sup></div>
						<div class="formula">I<sub>c</sub> = √[(3.47 − log<sub>10</sub>Q<sub>tn</sub>)² + (log<sub>10</sub>F<sub>r</sub> + 1.22)²]</div>
						<div class="formula">n = clamp(0.381 I<sub>c</sub> + 0.05 σ′<sub>v0</sub>/p<sub>a</sub> − 0.15, 0.5, 1.0)</div>
					</div>

					<h4 style="font-size:13px;color:var(--tx2);margin-top:12px">CUR 3 layers — broad q<sub>c</sub>–R<sub>f</sub> zoning</h4>
					<p>
						The CUR 3 layers route is a direct q<sub>c</sub>–R<sub>f</sub> zoning rule based
						on the published broad chart with four material fields: Sand, Silt, Clay, and
						Peat. It is a boundary-generation method, not a detailed parameter catalogue.
						No stress correction is applied to q<sub>c</sub> before classification.
					</p>
					<div class="equations">
						<div class="formula">R<sub>f</sub> &lt; 1.5 and q<sub>c</sub> ≥ 1.5 &nbsp;&nbsp; → &nbsp;&nbsp; Sand</div>
						<div class="formula">else if R<sub>f</sub> &lt; 2.5 and q<sub>c</sub> ≥ 0.5 &nbsp;&nbsp; → &nbsp;&nbsp; Silt</div>
						<div class="formula">else if R<sub>f</sub> ≤ 5.0 and q<sub>c</sub> ≥ 0.2 &nbsp;&nbsp; → &nbsp;&nbsp; Clay</div>
						<div class="formula">else &nbsp;&nbsp; → &nbsp;&nbsp; Peat / organic</div>
					</div>
					<p>
						The chart field "Silt" is carried internally as the app's intermediate family
						(<em>CUR3 silt</em>) so that the downstream parameter workflow remains stable.
					</p>

					<h4 style="font-size:13px;color:var(--tx2);margin-top:12px">NEN 6740 — stress-dependent material classification</h4>
					<p>
						NEN 6740 uses a stress-corrected cone resistance and a graphical chart with
						fourteen material areas. The app evaluates the published Deltares stress
						correction and then applies a transparent representative-area rule that selects
						the nearest material area from a digitized fourteen-material set.
					</p>
					<div class="equations">
						<div class="formula">q<sub>c,NEN</sub> = q<sub>c</sub> · (100 / σ′<sub>v0</sub>)<sup>0.67</sup></div>
						<div class="formula">s = log<sub>10</sub>(q<sub>c,NEN</sub>) − 0.34 R<sub>f</sub></div>
						<div class="formula">i = arg min<sub>j</sub> |s − s<sub>j</sub>|</div>
					</div>
					<p>
						The 0.67 exponent is the documented Deltares implementation of the published NEN
						route. The 0.34 coefficient is not a normative NEN constant; it is the
						regression-fit semilog projection used by the app to deterministically reproduce
						the graphical chart.
					</p>

					<h4 style="font-size:13px;color:var(--tx2);margin-top:12px">NEN Tabel 3 — direct subtype classification</h4>
					<p>
						The NEN Tabel 3 route uses raw q<sub>c</sub> and R<sub>f</sub> and returns a
						detailed subtype together with the characteristic parameter row used later in the
						workflow. Because the table contains overlapping q<sub>c</sub>–R<sub>f</sub>
						envelopes, the app evaluates rows deterministically in table order: grind, zand,
						leem, klei, then veen. q<sub>c</sub> lower bounds are inclusive and upper bounds
						exclusive; the open R<sub>f</sub> bands &lt; 1 and &gt; 6 remain strict, while
						the bounded intervals are treated as closed. For this method, raw boundary logic
						follows the detailed subtype result rather than only the broad family.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>3.3 q<sub>c</sub>-to-E<sub>oed,i</sub> correlation and α methods</h3>
					<p>
						The first stiffness step converts the representative cone resistance into an
						oedometric modulus through one of two α correlations selected in the Stage 4 UI:
						<strong>Method A — Sanglerat literature</strong> (fixed α per behavioural soil
						type) or <strong>Method B — SB260-21-6.4.10</strong> (q<sub>c</sub>-graded family
						rules). Method A and Method B are alternative routes; they produce different α —
						and hence different E<sub>oed,i</sub> — for the same layer. The result
						E<sub>oed,i</sub> is a CPT-derived stiffness at the layer's in-situ stress level,
						<em>before</em> the Hardening Soil reference-stress correction.
					</p>
					<div class="equations">
						<div class="formula">E<sub>oed,i</sub> = α · avg q<sub>c</sub> · 1000</div>
					</div>
					<p>
						<strong>Method A — Sanglerat fixed α by behavioural type.</strong> Method A applies
						a fixed Sanglerat-style α default keyed to the broad layer <em>type</em>, so a
						single α applies to the whole layer regardless of q<sub>c</sub>.
					</p>
					<table class="doc-table">
						<thead>
							<tr>
								<th>Soil type</th>
								<th>α (Sanglerat literature)</th>
							</tr>
						</thead>
						<tbody>
							<tr><td>Peat / organic</td><td>1.5</td></tr>
							<tr><td>Soft clay</td><td>3.0</td></tr>
							<tr><td>Clay</td><td>5.0</td></tr>
							<tr><td>Sandy clay</td><td>8.0</td></tr>
							<tr><td>Silty sand</td><td>10.0</td></tr>
							<tr><td>Sand</td><td>13.0</td></tr>
							<tr><td>Gravel</td><td>15.0</td></tr>
						</tbody>
					</table>
					<p>
						<strong>Method B — SB260-21-6.4.10 by family, keyed to the EC7 subtype.</strong>
						Method B applies the Tabel 21-6-5 rules, structured around three families:
						<em>cohesive</em> (klei, leem, veen), <em>transition / overgangsgronden</em>
						(the (zh) and (lh) subtype variants), and <em>granular / zandgronden</em>
						(zand, grind, grind (kh)). The family is selected from the EC7 subtype string
						first, falling back to the broad type when no subtype is set.
					</p>
					<div class="equations">
						<div class="formula"><em>Cohesive:</em></div>
						<div class="formula">α = 1.5 &nbsp;&nbsp; for veen, ... (any q<sub>c</sub>; w unknown in the app)</div>
						<div class="formula">α = 5, 3, 1.5 &nbsp;&nbsp; for klei, ... with q<sub>c</sub> &lt; 0.7, 0.7–2.0, ≥ 2.0 MPa</div>
						<div class="formula">α = 4, 2 &nbsp;&nbsp; for leem, ... with q<sub>c</sub> &lt; 2.0, ≥ 2.0 MPa</div>
						<div class="formula"><em>Transition (overgangsgronden):</em></div>
						<div class="formula">α = 2.0; (4q<sub>c</sub> − 5)/q<sub>c</sub>; 2.0 &nbsp;&nbsp; for klei (zh) / leem (zh) / zand (lh) with q<sub>c</sub> &lt; 2.5, 2.5–5.0, ≥ 5.0 MPa</div>
						<div class="formula"><em>Granular (zandgronden):</em></div>
						<div class="formula">α = 4.0; (2q<sub>c</sub> + 20)/q<sub>c</sub>; 120/q<sub>c</sub> &nbsp;&nbsp; for zand / grind / grind (kh) with q<sub>c</sub> ≤ 10, 10–50, &gt; 50 MPa</div>
					</div>
					<ul class="notes">
						<li>Method A and Method B are <em>not interchangeable</em>: Method A is Sanglerat literature, with high α for granular soils (Sand = 13, Gravel = 15). Method B is SB260 with E<sub>s</sub> = 4q<sub>c</sub> in the granular family, which gives much smaller effective α (e.g. α = 4 for q<sub>c</sub> ≤ 10 MPa).</li>
						<li>The (zh) suffix on klei / leem and (lh) suffix on zand route to the <em>transition</em> family. The (kh) suffix on grind routes to the <em>granular</em> family.</li>
						<li>For peat, water content w is not available in the app, so Method B uses the SB260 default α = 1.5.</li>
						<li>For the full implemented α reference table — every family, q<sub>c</sub> band, and modulus formula — see Stage 4 §4.2 of the workflow specification.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>3.4 Effective stress at layer midpoint</h3>
					<p>
						The reference-stress correction below uses the effective vertical stress at layer
						midpoint as the in-situ anchor. Above the water table γ is used; below it,
						γ<sub>sat</sub> is used. Pore pressure is hydrostatic.
					</p>
					<div class="equations">
						<div class="formula">z<sub>mid</sub> = (z<sub>top</sub> + z<sub>bot</sub>) / 2</div>
						<div class="formula">σ<sub>v0</sub> = γ z<sub>mid</sub> &nbsp;&nbsp; for z<sub>mid</sub> ≤ z<sub>w</sub></div>
						<div class="formula">σ<sub>v0</sub> = γ z<sub>w</sub> + γ<sub>sat</sub>(z<sub>mid</sub> − z<sub>w</sub>) &nbsp;&nbsp; for z<sub>mid</sub> &gt; z<sub>w</sub></div>
						<div class="formula">u = γ<sub>w</sub> · max(0, z<sub>mid</sub> − z<sub>w</sub>)</div>
						<div class="formula">σ′<sub>v0</sub> = max(σ<sub>v0</sub> − u, 1)</div>
					</div>
					<p>
						The phreatic level therefore directly affects the reference stiffness correction
						in the next subsection.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>3.5 Reference-stress correction (shared by Methods A and B)</h3>
					<p>
						Both Method A and Method B apply the <em>same</em> Hardening Soil reference-stress
						correction to convert the in-situ E<sub>oed,i</sub> from §3.3 into the reference-stress
						quantity E<sub>oed,ref</sub> at p<sub>ref</sub> = 100 kPa. The cohesion-corrected
						form is used so the correction stays well-behaved in cohesive layers where
						σ′<sub>v0</sub> can be small relative to c′ cot φ′. Methods A and B differ <em>only</em>
						in how E<sub>50,ref</sub> and E<sub>ur,ref</sub> are derived from this shared
						E<sub>oed,ref</sub>; the depth correction itself is identical in both routes.
					</p>
					<div class="equations">
						<div class="formula">E<sub>oed,ref</sub> = E<sub>oed,i</sub> · [(p<sub>ref</sub> + c′ cot φ′) / (σ′<sub>v0</sub> + c′ cot φ′)]<sup>m</sup></div>
						<div class="formula">p<sub>ref</sub> = 100 kPa</div>
					</div>
					<p>
						The stress-exponent default uses the CUR 2003-7 binary: m = 0.5 for granular soils
						(Sand, Silty sand, Gravel) and m = 1.0 for cohesive soils — klei en leem (Clay,
						Soft clay, Sandy clay, Peat / organic). The grouping of "klei en leem" includes
						Sandy clay (leem), so leem is treated as cohesive in both the stress-exponent and
						the family-rule defaults. Stage 5 m-fitting can override m per layer when
						site-specific evidence supports a different value.
					</p>
					<table class="doc-table">
						<thead>
							<tr>
								<th>Soil</th>
								<th>m (default)</th>
								<th>ν<sub>ur</sub></th>
								<th>ψ<sub>unsat</sub> [m]</th>
							</tr>
						</thead>
						<tbody>
							<tr><td>Sand</td><td>0.5</td><td>0.20</td><td>0.1</td></tr>
							<tr><td>Silty sand</td><td>0.5</td><td>0.20</td><td>0.1</td></tr>
							<tr><td>Gravel</td><td>0.5</td><td>0.20</td><td>0.1</td></tr>
							<tr><td>Sandy clay (leem)</td><td>1.0</td><td>0.20</td><td>1.0</td></tr>
							<tr><td>Clay</td><td>1.0</td><td>0.20</td><td>3.0</td></tr>
							<tr><td>Soft clay</td><td>1.0</td><td>0.20</td><td>3.0</td></tr>
							<tr><td>Peat / organic</td><td>1.0</td><td>0.20</td><td>3.0</td></tr>
						</tbody>
					</table>
					<p style="font-size:11px;color:var(--tx2)">
						Sources: CUR 2003-7 (m binary, ν<sub>ur</sub>);
						Schanz, Vermeer &amp; Bonnier (1999) (HS reference-stress correction);
						SB260-21-6.4.10 (cohesion-corrected denominator form); PLAXIS 2D Material
						Models Manual (ψ<sub>unsat</sub>).
					</p>
				</section>

				<section class="doc-subsection">
					<h3>3.6 Method A — CUR 2003-7 stiffness ratios</h3>
					<p>
						Method A takes the shared E<sub>oed,ref</sub> from §3.5 and applies the CUR 2003-7
						family rule to derive E<sub>50,ref</sub>. E<sub>ur,ref</sub> is taken as three times
						E<sub>50,ref</sub>. The family rule treats klei and leem together, so Sandy clay
						(leem) is in the cohesive set with the 1.25 factor; for granular soils
						E<sub>50,ref</sub> is set equal to E<sub>oed,ref</sub>.
					</p>
					<div class="equations">
						<div class="formula">E<sub>50,ref</sub> = E<sub>oed,ref</sub> &nbsp;&nbsp; for granular soils (Sand, Silty sand, Gravel)</div>
						<div class="formula">E<sub>50,ref</sub> = 1.25 · E<sub>oed,ref</sub> &nbsp;&nbsp; for cohesive soils — klei en leem (Clay, Soft clay, Sandy clay, Peat)</div>
						<div class="formula">E<sub>ur,ref</sub> = 3 · E<sub>50,ref</sub></div>
						<div class="formula">K<sub>0,nc</sub> = 1 − sin φ′</div>
					</div>
					<table class="doc-table">
						<thead>
							<tr>
								<th>Soil</th>
								<th>E<sub>50,ref</sub> / E<sub>oed,ref</sub></th>
							</tr>
						</thead>
						<tbody>
							<tr><td>Sand, Silty sand, Gravel</td><td>1.0</td></tr>
							<tr><td>Sandy clay (leem), Clay, Soft clay, Peat / organic</td><td>1.25</td></tr>
						</tbody>
					</table>
					<p style="font-size:11px;color:var(--tx2)">
						Sources: CUR 2003-7 (E<sub>50</sub>/E<sub>oed</sub> ratio); aGEO
						(E<sub>ur,ref</sub> = 3 E<sub>50,ref</sub>); Jáky / EN 1997-1 (K<sub>0,nc</sub>).
					</p>
				</section>

				<section class="doc-subsection">
					<h3>3.7 Method B — E<sub>50,ref</sub> = E<sub>oed,ref</sub></h3>
					<p>
						Method B takes the shared E<sub>oed,ref</sub> from §3.5 and sets E<sub>50,ref</sub>
						equal to E<sub>oed,ref</sub> for all soils. E<sub>ur,ref</sub> remains three times
						the selected E<sub>50,ref</sub>.
					</p>
					<div class="equations">
						<div class="formula">E<sub>50,ref</sub> = E<sub>oed,ref</sub></div>
						<div class="formula">E<sub>ur,ref</sub> = 3 · E<sub>oed,ref</sub></div>
					</div>
					<p>
						This gives a single consistent reference stiffness and is sometimes preferred in
						practice when the engineer wants to avoid the cohesive-soil
						E<sub>50</sub>/E<sub>oed</sub> split.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>3.8 Hydraulic conductivity basis</h3>
					<p>
						The app uses indicative hydraulic conductivity values tied to Belgian and
						USDA-style texture classes, with OVAM 2002 (Tabel 2-44) and De Smedt / VUB 2005
						(Tabel 2-45) as the principal reference sources for the I/RA/11461.15.066/JSW
						guideline. The representative value is treated as a geometric-mean estimate
						within the adopted class range rather than a deterministic measurement.
					</p>
					<div class="equations">
						<div class="formula">k<sub>h,rep</sub> = √(k<sub>h,min</sub> k<sub>h,max</sub>)</div>
						<div class="formula">k<sub>v</sub> = k<sub>h</sub> / a<sub>kv</sub></div>
					</div>
					<p>
						Anisotropy is introduced through a k<sub>h</sub>/k<sub>v</sub> ratio. Sand and
						gravel are taken as isotropic. Cohesive soils (Clay, Sandy clay / leem, Peat) are
						taken as k<sub>h</sub>/k<sub>v</sub> = 3. Silty sand ("fijn zand") sits between the
						two regimes, and the engineer selects between two anisotropy methods in the
						Stage 4 UI:
					</p>
					<ul class="notes">
						<li><strong>Method A — OVAM / I/RA/11461 (default).</strong> Conservative Belgian engineering practice value. Silty sand is grouped with the fine soils, k<sub>h</sub>/k<sub>v</sub> = 3.</li>
						<li><strong>Method B — Bear (1979) academic.</strong> Literature-typical intermediate value for fine / silty sand, k<sub>h</sub>/k<sub>v</sub> = 2. Reflects the partly-cohesive nature of silty sand without lumping it fully with cohesive soils.</li>
					</ul>
					<table class="doc-table">
						<thead>
							<tr>
								<th>Soil</th>
								<th>k<sub>h</sub>/k<sub>v</sub> — Method A (OVAM)</th>
								<th>k<sub>h</sub>/k<sub>v</sub> — Method B (Bear)</th>
							</tr>
						</thead>
						<tbody>
							<tr><td>Sand, Gravel</td><td>1</td><td>1</td></tr>
							<tr><td>Silty sand (fijn zand)</td><td>3</td><td>2</td></tr>
							<tr><td>Sandy clay (leem), Clay, Soft clay, Peat / organic</td><td>3</td><td>3</td></tr>
						</tbody>
					</table>
					<p>
						In-situ measurement takes priority over the indicative table values when available.
						The engineer can override k<sub>h</sub> and k<sub>h</sub>/k<sub>v</sub> per layer.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>3.9 Experimental m-fitting</h3>
					<p>
						Stage 5 fits the Hardening Soil stress exponent m to the pointwise CPT-derived
						E<sub>oed,i</sub> values inside one layer. The oedometer law of the Hardening Soil
						model is linear in logarithmic form, so an OLS regression on
						(ln(stress ratio), ln(E<sub>oed,i</sub>)) pairs gives both m and
						E<sub>oed,ref</sub> directly:
					</p>
					<div class="equations">
						<div class="formula">E<sub>oed</sub>(z) = E<sub>oed,ref</sub> · [(σ′<sub>v0</sub>(z) + c′ cot φ′) / (p<sub>ref</sub> + c′ cot φ′)]<sup>m</sup></div>
						<div class="formula">X<sub>j</sub> = ln[(σ′<sub>v0</sub>(z<sub>j</sub>) + c′ cot φ′) / (p<sub>ref</sub> + c′ cot φ′)]</div>
						<div class="formula">Y<sub>j</sub> = ln[E<sub>oed,i</sub>(z<sub>j</sub>)]</div>
						<div class="formula">m<sub>fit</sub> = cov(X, Y) / var(X), &nbsp; E<sub>oed,ref,fit</sub> = exp(mean(Y) − m<sub>fit</sub> mean(X))</div>
						<div class="formula">R² = 1 − SS<sub>res</sub> / SS<sub>tot</sub></div>
					</div>
					<p>
						The fit is experimental and remains an engineer preview: the routine never
						overrides the CUR 2003-7 default automatically. The interface shows the default
						line, the fitted line, and the point cloud; the engineer may still adjust the
						previewed m before acceptance, and accepting the fit overrides m only — the
						reference stiffness is then recomputed from the accepted m.
					</p>
				</section>
			</section>

			<section id="seepage" class="doc-card">
				<p class="section-label">Seepage formulation</p>
				<h2>4. Darcy-flow model on the shared Stage 6 section</h2>

				<section class="doc-subsection">
					<h3>4.1 Governing PDE</h3>
					<p>
						The seepage route is a steady-state saturated-flow problem:
					</p>
					<div class="equations">
						<div class="formula">q = −k ∇h</div>
						<div class="formula">∇ · (k ∇h) = 0</div>
					</div>
					<p>
						For isotropic homogeneous soil this reduces to Laplace’s equation. In the app, the
						heterogeneous anisotropic form is preserved because material zones carry their own
						conductivity values.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>4.2 Boundary classes</h3>
					<p>
						The public seepage route distinguishes prescribed head, no-flow, and seepage-face
						boundaries. In the current workflow these are applied to the outer section boundary
						rather than arbitrary interior edges.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>4.3 Free-surface interpretation</h3>
					<p>
						Unconfined flow is nonlinear because the active saturated domain is itself part of
						the solution. The current public route therefore uses an iterative free-surface /
						seepage-face interpretation rather than a one-shot confined-flow solve.
					</p>
				</section>
			</section>

			<section id="deformation" class="doc-card">
				<p class="section-label">Deformation formulation</p>
				<h2>5. Plane-strain FE equilibrium and constitutive branching</h2>

				<section class="doc-subsection">
					<h3>5.1 Global equilibrium</h3>
					<p>
						The deformation route is written in residual form:
					</p>
					<div class="equations">
						<div class="formula">R(u) = F<sub>ext</sub> − F<sub>int</sub>(u) = 0</div>
						<div class="formula">F<sub>int</sub> = ∑<sub>e</sub> ∫<sub>Ωe</sub> B<sup>T</sup> σ′ dΩ</div>
						<div class="formula">K<sub>tan</sub> Δu = R</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>5.2 Geostatic preparation</h3>
					<p>
						The initial stress state is prepared by a linear gravity step and a
						K<sub>0,nc</sub>-controlled confinement reconstruction. Optionally, the seeded
						predictor may then be corrected by a plastic self-weight equilibration phase before
						the service-load step starts.
					</p>
					<div class="equations">
						<div class="formula">K u<sub>geo</sub> = F<sub>g</sub></div>
						<div class="formula">R<sub>0b</sub>(Δu) = F<sub>g</sub> - F<sub>int</sub>(σ′<sub>pred</sub> + Δσ′(Δu, history)) = 0</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>5.3 Constitutive staging</h3>
					<p>
						The current public deformation route supports three constitutive interpretations:
					</p>
					<ul class="notes">
						<li><strong>Linear elastic</strong> for baseline screening.</li>
						<li><strong>Stage 1 reduced stiffness</strong> as a pseudo-plastic exceedance route.</li>
						<li><strong>Stage 2 exact Mohr-Coulomb elastoplasticity</strong> as the current default plastic route.</li>
					</ul>
					<p>
						The shipped Stage 2 route stores plastic strain and uses an exact Mohr-Coulomb
						active-set return with shear face, shear edge, apex, tension-face, mixed
						shear-tension, and triple tension-point branches in principal effective stress
						space.
					</p>
				</section>
			</section>

			<section id="mc" class="doc-card">
				<p class="section-label">Mohr-Coulomb yield theory</p>
				<h2>6. Mohr-Coulomb yield function, flow rule, and algorithmic tangent</h2>
				<section class="doc-subsection">
					<h3>6.1 Yield function in principal stress space</h3>
					<p>
						Using compression-positive effective principal stresses ordered σ<sub>1</sub> ≥
						σ<sub>2</sub> ≥ σ<sub>3</sub>, the Mohr-Coulomb criterion in its critical form reads:
					</p>
					<div class="equations">
						<div class="formula">F(σ) = (σ<sub>1</sub> − σ<sub>3</sub>) − (σ<sub>1</sub> + σ<sub>3</sub>) sin φ′ − 2 c′ cos φ′ ≤ 0</div>
						<div class="formula">Equivalent: (1 − sin φ′) σ<sub>1</sub> − (1 + sin φ′) σ<sub>3</sub> − 2 c′ cos φ′ ≤ 0</div>
						<div class="formula">Apex location (hydrostatic tensile corner): p<sub>apex</sub> = c′ cot φ′</div>
					</div>
					<p>
						For the exact multisurface treatment, three pair-wise surfaces F<sub>ij</sub> (index
						pair ij ∈ &#123;12, 13, 23&#125;) are retained simultaneously. F<sub>13</sub> governs
						on the ordered face; F<sub>12</sub> and F<sub>23</sub> pick up the σ<sub>1</sub>=σ<sub>2</sub>
						and σ<sub>2</sub>=σ<sub>3</sub> edges respectively.
					</p>
					<div class="equations">
						<div class="formula">F<sub>ij</sub>(σ) = (1 − sin φ′) σ<sub>i</sub> − (1 + sin φ′) σ<sub>j</sub> − 2 c′ cos φ′</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>6.2 Non-associated flow rule</h3>
					<p>
						Plastic flow follows a plastic potential G built with the dilatancy angle ψ′ ≤ φ′.
						The flow is non-associated when ψ′ ≠ φ′; for dilatant soils ψ′ &gt; 0 introduces a
						volumetric plastic strain component.
					</p>
					<div class="equations">
						<div class="formula">G<sub>ij</sub>(σ) = (1 − sin ψ′) σ<sub>i</sub> − (1 + sin ψ′) σ<sub>j</sub> − const</div>
						<div class="formula">dε<sup>p</sup> = dλ ∂G/∂σ   (flow rule)</div>
						<div class="formula">n<sub>ij</sub> = ∂F<sub>ij</sub>/∂σ,    m<sub>ij</sub> = ∂G<sub>ij</sub>/∂σ</div>
						<div class="formula">Associated case: n<sub>ij</sub> = m<sub>ij</sub>,   ψ′ = φ′</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>6.3 Return mapping and algorithmic tangent</h3>
					<p>
						Because F is piecewise linear in stress, the return map closes in a single linear
						step on each active branch. The return equation and the algorithmic consistent tangent
						follow the Simo–Taylor form:
					</p>
					<div class="equations">
						<div class="formula">σ<sub>ret</sub> = σ<sub>trial</sub> − D<sub>e</sub> Σ<sub>i</sub> λ<sub>i</sub> m<sub>i</sub></div>
						<div class="formula">C<sub>ij</sub> = n<sub>i</sub><sup>T</sup> D<sub>e</sub> m<sub>j</sub>    (coupling matrix; unsymmetric for ψ ≠ φ)</div>
						<div class="formula">C λ = F(σ<sub>trial</sub>)    ⇒    λ = C<sup>-1</sup> F(σ<sub>trial</sub>)</div>
						<div class="formula">D<sub>ep</sub> = D<sub>e</sub> − Σ<sub>i,j</sub> (D<sub>e</sub> m<sub>i</sub>) (C<sup>-1</sup>)<sub>ij</sub> (D<sub>e</sub> n<sub>j</sub>)<sup>T</sup></div>
					</div>
					<p>
						The unsymmetric D<sub>ep</sub> is preserved by default in the shipped Stage 2 route.
						Symmetrization is offered as a convenience option but is theoretically a projection
						and loses accuracy on active-set transitions.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>6.4 Strength reduction (c-φ reduction)</h3>
					<p>
						The safety-by-c-φ-reduction route divides the strength parameters by a common
						multiplier Σ<sub>Msf</sub> and searches for the critical value at which equilibrium
						fails to close:
					</p>
					<div class="equations">
						<div class="formula">c′<sub>r</sub> = c′ / Σ<sub>Msf</sub>,    tan φ′<sub>r</sub> = tan φ′ / Σ<sub>Msf</sub></div>
						<div class="formula">tan ψ′<sub>r</sub> = tan ψ′ / Σ<sub>Msf</sub>,   σ<sub>t,r</sub> = σ<sub>t</sub> / Σ<sub>Msf</sub></div>
						<div class="formula">Apex invariant: c′<sub>r</sub> cot φ′<sub>r</sub> = c′ cot φ′ (the apex does not move under reduction)</div>
						<div class="formula">Constraints: ψ′<sub>r</sub> ≤ φ′<sub>r</sub>,    σ<sub>t,r</sub> ≤ c′<sub>r</sub> / tan φ′<sub>r</sub></div>
						<div class="formula">Factor of safety:  F<sub>s</sub> = Σ<sub>Msf, critical</sub></div>
					</div>
					<p>
						Reported factor of safety is the highest converged lower bound. The upper bound (first
						non-converging multiplier) and the bracket are reported alongside so the engineer can
						judge the numerical uncertainty on the critical state.
					</p>
				</section>
			</section>

			<section id="tension" class="doc-card">
				<p class="section-label">Tension cut-off</p>
				<h2>7. Tension cut-off, apex corners, and mixed branches</h2>
				<p>
					The Mohr-Coulomb surface by itself admits unlimited tensile strength once the apex
					cot(φ) fixes the hydrostatic corner. Real soils exhibit a finite tensile strength
					σ<sub>t</sub>. The tension cut-off is a supplementary surface active in the tensile
					region of principal stress space.
				</p>
				<div class="equations">
					<div class="formula">T<sub>i</sub>(σ) = −σ<sub>i</sub> − σ<sub>t</sub> ≤ 0    (per principal direction)</div>
					<div class="formula">Ordered form (σ<sub>3</sub> = least compressive):  T<sub>3</sub> = −σ<sub>3</sub> − σ<sub>t</sub> ≤ 0</div>
					<div class="formula">Apex invariant: σ<sub>t</sub> ≤ c′ / tan φ′ (cut-off cannot exceed MC apex)</div>
				</div>
				<p>
					The app's Stage 2 constitutive branch set covers the tension cut-off in combination
					with MC shear. The return map distinguishes:
				</p>
				<ul class="notes">
					<li>Pure shear branches: F<sub>13</sub> alone (face), F<sub>12</sub>+F<sub>13</sub> and F<sub>13</sub>+F<sub>23</sub> (edges), and the triple-shear apex branch.</li>
					<li>Pure tension branches: T<sub>3</sub> (face), T<sub>2</sub>+T<sub>3</sub> (edge at σ<sub>2</sub>=σ<sub>3</sub> cut-off), T<sub>1</sub>+T<sub>2</sub>+T<sub>3</sub> (hydrostatic tension apex).</li>
					<li>Mixed branches: F<sub>13</sub>+T<sub>3</sub> (edge), plus the lower and upper mixed shear-tension corners where one shear surface and the tension cut-off coincide.</li>
				</ul>
				<p>
					Each branch solves a linear system whose size equals the number of active surfaces; the
					active-set selection is driven by stress-gap and complementarity tolerances chosen
					relative to the local stress scale.
				</p>
			</section>

			<section id="numerics" class="doc-card">
				<p class="section-label">Numerical assumptions</p>
				<h2>6. Declared numerical approximations and modelling boundaries</h2>
				<p>
					The public routes are intended to be auditable engineering tools rather than opaque
					black-box solvers. The numerical choices listed below are therefore stated explicitly
					as part of the documented model definition.
				</p>
				<ul class="notes">
					<li>The shared seepage and deformation meshes use three-node constant-strain triangles.</li>
					<li>The deformation route caps high ν values for plane-strain stability and warns about T3 locking and coarse-mesh over-stiffness.</li>
					<li>The seepage route is steady-state only. Interior drains are exposed as head-prescribed polyline constraints with three gating modes (<code>always</code>, <code>when-saturated</code>, <code>head-cap</code>); the head-cap mode is solved as a primal–dual active-set semismooth Newton loop on the LCP <strong>h ≤ H<sub>d</sub>, R ≤ 0, (h − H<sub>d</sub>)·R = 0</strong>. Flow-prescribed line sinks and finite-resistance drains are not yet exposed.</li>
					<li>The deformation route can expose a partial near-failure state rather than discarding the best available non-converged plastic result.</li>
					<li>The current Stage 2 constitutive route is an exact Mohr-Coulomb active-set return in principal stress space, including tension-cutoff branches.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">Source basis</p>
				<h2>7. Principal source families and standards basis</h2>
				<p>
					The full traceable reference list backing every formula and parameter rule on this
					page. References are grouped by family and listed in the same order they are cited
					through the workflow specification.
				</p>

				<h3 style="font-size:14px;margin-top:18px">7.1 Eurocodes and Belgian National Annexes</h3>
				<ul class="reference-list">
					<li><strong>EN 1997-1:2004+A1:2013</strong> — Eurocode 7, geotechnical design, general rules.</li>
					<li><strong>NBN EN 1997-1 ANB:2022</strong> — Belgian National Annex to EN 1997-1, Design Approach 1.</li>
					<li><strong>EN 1990:2002+A1:2005</strong> — basis of structural design.</li>
					<li><strong>NBN EN 1990 ANB:2005</strong> — Belgian National Annex to EN 1990.</li>
					<li><strong>EN 1992-1-1</strong> — Eurocode 2, design of concrete structures.</li>
					<li><strong>NBN EN 1992-1-1 ANB</strong> — Belgian National Annex to EN 1992-1-1.</li>
				</ul>

				<h3 style="font-size:14px;margin-top:18px">7.2 Books and journal papers</h3>
				<ul class="reference-list">
					<li><strong>Terzaghi &amp; Peck (1967)</strong> — Soil Mechanics in Engineering Practice, 2nd ed.</li>
					<li><strong>Vesić (1975)</strong> — Bearing Capacity of Shallow Foundations, in <em>Foundation Engineering Handbook</em> (Winterkorn &amp; Fang, eds.).</li>
					<li><strong>Robertson (1990)</strong> — Soil classification using the CPT. <em>Canadian Geotechnical Journal</em>, 27(1), 151–158.</li>
					<li><strong>Robertson (2016)</strong> — Cone penetration test (CPT)-based soil behaviour type (SBT) classification system — an update. <em>Canadian Geotechnical Journal</em>, 53(12), 1910–1927.</li>
					<li><strong>Robertson &amp; Wride (1998)</strong> — Evaluating cyclic liquefaction potential using the CPT. <em>Canadian Geotechnical Journal</em>, 35, 442–459.</li>
				</ul>

				<h3 style="font-size:14px;margin-top:18px">7.3 Belgian and Dutch practice documents</h3>
				<ul class="reference-list">
					<li><strong>SB260</strong> — Standaardbestek 260, artikel 21-6.4.10: karakteristieke grondparameters op basis van elektrische sondering.</li>
					<li><strong>CUR 2003-7</strong> — CPT-correlated geotechnical parameter guidance used in Belgian and Dutch practice; basis of the Stage 4 Method-A m and E<sub>50</sub>/E<sub>oed</sub> defaults.</li>
					<li><strong>NEN 6740</strong> — Dutch geotechnical design standard with stress-dependent CPT material classification.</li>
					<li><strong>Deltares D-SHEET Piling User Manual</strong> (v24.1, §34.2.2) — documents the NEN stress-correction formula q<sub>c,NEN</sub> = q<sub>c</sub>(100/σ′<sub>v0</sub>)<sup>0.67</sup>.</li>
					<li><strong>PLAXIS 2D 2018 Reference Manual</strong> — broad CUR 3 layers classification chart (Sand, Silt, Clay, Peat).</li>
				</ul>

				<h3 style="font-size:14px;margin-top:18px">7.4 PLAXIS workflows</h3>
				<ul class="reference-list">
					<li><strong>PLAXIS 2D Material Models Manual (2025.1)</strong> — Mohr-Coulomb Young's modulus guidance, Hooke-law stiffness relations, ψ<sub>unsat</sub> defaults.</li>
					<li><strong>Bentley KB0109063</strong> — defining and editing a material via the command line; supported soilmat workflow.</li>
					<li><strong>Bentley KB0109071</strong> — PLAXIS soil model numbers for command-line material creation.</li>
					<li><strong>Bentley KB0043470</strong> — re-using materials from other projects in PLAXIS, including project-to-database workflows.</li>
					<li><strong>Bentley KB0108936</strong> — material parameter datasets article whose sample package shows modern .matXdb content on disk.</li>
				</ul>

				<h3 style="font-size:14px;margin-top:18px">7.5 Hydraulic conductivity and constitutive parameter sources</h3>
				<ul class="reference-list">
					<li><strong>Schanz, Vermeer &amp; Bonnier (1999)</strong> — The Hardening Soil model: formulation and stress-dependent stiffness basis (origin of m = 0.5 / 1.0 binary used by CUR 2003-7).</li>
					<li><strong>OVAM 2002 / I-RA-11461</strong> — indicative hydraulic conductivity ranges by Belgian texture class (Tabel 2-44); basis of k<sub>h</sub>/k<sub>v</sub> Method A.</li>
					<li><strong>De Smedt / VUB (2005)</strong> — indicative hydraulic conductivity ranges by USDA texture class (Tabel 2-45).</li>
					<li><strong>Bear (1979)</strong> — <em>Hydraulics of Groundwater</em>; literature-typical anisotropy used by k<sub>h</sub>/k<sub>v</sub> Method B.</li>
					<li><strong>Freeze &amp; Cherry (1979)</strong> — <em>Groundwater</em>; cross-reference for fine-soil anisotropy ranges.</li>
				</ul>

				<h3 style="font-size:14px;margin-top:18px">7.6 Classical theoretical references</h3>
				<ul class="reference-list">
					<li><strong>Boussinesq (1885)</strong> — Application des potentiels à l'étude de l'équilibre et du mouvement des solides élastiques.</li>
					<li><strong>Newmark (1935)</strong> — Simplified computation of vertical pressures in elastic foundations.</li>
					<li><strong>Fadum (1948)</strong> — Influence values for estimating stresses in elastic foundations.</li>
					<li><strong>Dupuit (1863)</strong> — Études théoriques et pratiques sur le mouvement des eaux.</li>
					<li><strong>Thiem (1906)</strong> — Hydrologische Methoden.</li>
					<li><strong>Kyrieleis &amp; Sichardt (1930)</strong> — Grundwasserabsenkung bei Fundierungsarbeiten.</li>
					<li><strong>Louwyck et al. (2022)</strong> — The Radius of Influence Myth. <em>Water</em>, 14(2), 149.</li>
					<li><strong>Powers et al. (2007)</strong> — Construction Dewatering and Groundwater Control, 3rd ed.</li>
				</ul>

				<h3 style="font-size:14px;margin-top:18px">7.7 Foundation models</h3>
				<ul class="reference-list">
					<li><strong>Hetényi (1946)</strong> — Beams on Elastic Foundation.</li>
					<li><strong>Vesić (1961a)</strong> — Bending of beams resting on isotropic elastic solid.</li>
					<li><strong>Vesić (1961b)</strong> — Beams on elastic subgrade and Winkler's hypothesis.</li>
					<li><strong>Pasternak (1954)</strong> — On a New Method of Analysis of an Elastic Foundation by Means of Two Foundation Constants.</li>
					<li><strong>Kerr (1964)</strong> — Elastic and viscoelastic foundation models.</li>
				</ul>

				<p class="refs-inline" style="margin-top:18px">
					For the complete citation list and route-specific implementation anchors, continue to
					<a href="/docs/reference">standards and references</a> or the
					<a href="/docs/full#references">technical specification</a>.
				</p>
			</section>
		</main>
	</div>
</div>
