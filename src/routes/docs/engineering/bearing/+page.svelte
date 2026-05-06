<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';

	const pageTitle = 'Bearing Capacity — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 bearing-capacity workflow: Prandtl-Reissner slip-line derivation, drained and undrained resistance, effective dimensions, shape and depth factors, inclination factors, water-table averaging, Belgian DA1 handling, and limitations.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/bearing';
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
			<p class="hero__eyebrow">Stage 6 / bearing capacity</p>
			<h1>Stage 6 bearing capacity.</h1>
			<p class="hero__lead">
				The bearing-capacity route is a shallow-foundation ULS screen for vertical loading on the
				interpreted CPT section. It evaluates drained and undrained resistance separately, applies
				effective-dimension logic for eccentricity, builds Brinch-Hansen shape / depth / inclination
				factors from the effective dimensions, averages the unit weight across the water table for
				the N<sub>γ</sub> term, and reports Belgian DA1-style design envelopes.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Bearing documentation navigation">
			<div class="docs-nav__title">Bearing</div>
			<a href="#scope">Scope and intent</a>
			<a href="#theory">Prandtl–Reissner derivation</a>
			<a href="#factors">Bearing-capacity factors</a>
			<a href="#model">Drained and undrained resistance</a>
			<a href="#dimensions">Effective dimensions</a>
			<a href="#shape">Shape and depth factors</a>
			<a href="#inclination">Inclination factors</a>
			<a href="#gamma">Water-table averaging for the N<sub>γ</sub> term</a>
			<a href="#design">Belgian DA1 handling</a>
			<a href="#deformation">Relation to Stage 2 deformation safety</a>
			<a href="#outputs">Outputs and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and engineering purpose</h2>
				<p>
					The bearing route is a <strong>shallow-foundation ULS screen</strong>. It evaluates the
					resistance side of the bearing problem from CPT-derived soil parameters and reports
					drained and undrained resistance envelopes versus founding depth.
				</p>
				<div class="doc-callout">
					<strong>Model class.</strong> Brinch Hansen / EC7 Annex D screening for vertical loading.
					Not a full general-footing check with sliding, uplift, ground slope, or base tilt. Those
					live in dedicated structural-geotechnical tools.
				</div>
				<div class="symbols">
					<div class="symbols__title">Primary quantities</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>q<sub>ult,d</sub></dt>
							<dd>Ultimate drained bearing resistance [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>q<sub>ult,u</sub></dt>
							<dd>Ultimate undrained bearing resistance [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>B′, L′</dt>
							<dd>Effective footing dimensions after eccentricity reduction [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>N<sub>c</sub>, N<sub>q</sub>, N<sub>γ</sub></dt>
							<dd>Bearing-capacity factors [-].</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="theory" class="doc-card">
				<p class="section-label">Theory</p>
				<h2>2. Prandtl–Reissner slip-line derivation</h2>
				<p>
					The drained bearing capacity is rooted in the Prandtl–Reissner plasticity solution for a
					weightless, cohesive, frictional half-space under a rigid strip footing. Slip lines
					partition the soil under the footing into three zones: a triangular active Rankine zone
					under the footing, a logarithmic-spiral Prandtl transition zone, and a triangular
					passive Rankine zone on each side. Equating the moments of the active and passive zones
					about the spiral centre gives the bearing expression with two of the three factors.
				</p>
				<div class="equations">
					<div class="formula">q<sub>ult,weightless</sub> = c′ N<sub>c</sub> + q′ N<sub>q</sub></div>
					<div class="formula">Active zone angle:  π/4 + φ′/2    (Rankine limit)</div>
					<div class="formula">Passive zone angle:  π/4 − φ′/2</div>
					<div class="formula">Prandtl spiral:  r(θ) = r<sub>0</sub> exp(θ tan φ′)</div>
					<div class="formula">N<sub>q</sub> = exp(π tan φ′) · tan²(π/4 + φ′/2)</div>
					<div class="formula">N<sub>c</sub> = (N<sub>q</sub> − 1) / tan φ′</div>
				</div>
				<p>
					The third factor, N<sub>γ</sub>, accounts for the self-weight of the soil inside the
					failure mechanism. Prandtl–Reissner cannot express it in closed form because adding
					self-weight destroys the kinematic separability that makes the spiral solution tractable.
					Several empirical closed forms are in circulation (Meyerhof, Vesić, Brinch Hansen); the
					app uses the Meyerhof-style expression below and flags the choice in the output.
				</p>
				<div class="equations">
					<div class="formula">N<sub>γ</sub>,Meyerhof = (N<sub>q</sub> − 1) tan(1.4 φ′)</div>
					<div class="formula">N<sub>γ</sub>,Vesić   = 2(N<sub>q</sub> + 1) tan φ′         (alternative, reported as comparator)</div>
					<div class="formula">N<sub>γ</sub>,EC7-Annex-D (rough base) = 2(N<sub>q</sub> − 1) tan φ′</div>
				</div>
				<ul class="notes">
					<li>For φ′ → 0, N<sub>q</sub> → 1 and N<sub>γ</sub> → 0; N<sub>c</sub> takes the limit by L'Hôpital and approaches the undrained Prandtl value 5.14.</li>
					<li>The drained form is exact for the cohesion and surcharge terms; the self-weight term is an empirical closure.</li>
				</ul>
			</section>

			<section id="factors" class="doc-card">
				<p class="section-label">Factors</p>
				<h2>3. Undrained bearing factor and Prandtl's 5.14</h2>
				<p>
					For saturated clays loaded faster than pore-pressure dissipation, the strength is taken
					as an undrained shear strength c<sub>u</sub>. The same slip-line mechanism with φ′ = 0
					collapses to Prandtl's original 1921 result: a kinematically admissible punching
					mechanism with spiral angle 2π and radius 2 r<sub>0</sub>, yielding the classical
					N<sub>c,u</sub> = π + 2 ≈ 5.14.
				</p>
				<div class="equations">
					<div class="formula">q<sub>ult,u</sub> = q + (π + 2) c<sub>u</sub> s<sub>cu</sub> d<sub>cu</sub> i<sub>cu</sub></div>
					<div class="formula">(π + 2) ≈ 5.14   (Prandtl 1921 result for φ′ = 0)</div>
				</div>
				<p>
					This is the limiting case and the reason drained and undrained routes are reported
					separately: a φ′ → 0 drained run approaches 5.14 c<sub>u</sub> + q only if c′ → c<sub>u</sub>
					and the depth / shape / inclination factors coincide. In layered CPT profiles, drained
					and undrained envelopes can cross over at different depths, so the engineer interprets
					them side-by-side rather than as a single mixed envelope.
				</p>
			</section>

			<section id="model" class="doc-card">
				<p class="section-label">Model</p>
				<h2>4. Complete drained and undrained expressions</h2>
				<div class="equations">
					<div class="formula">q<sub>ult,d</sub> = c′ N<sub>c</sub> s<sub>c</sub> d<sub>c</sub> i<sub>c</sub> + q′ N<sub>q</sub> s<sub>q</sub> d<sub>q</sub> i<sub>q</sub> + 0.5 γ′<sub>B</sub> B′ N<sub>γ</sub> s<sub>γ</sub> d<sub>γ</sub> i<sub>γ</sub></div>
					<div class="formula">q<sub>ult,u</sub> = q + (π + 2) c<sub>u</sub> s<sub>cu</sub> d<sub>cu</sub> i<sub>cu</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>c′</dt>
							<dd>Effective cohesion [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>φ′</dt>
							<dd>Effective friction angle [°].</dd>
						</div>
						<div class="symbols__row">
							<dt>q′</dt>
							<dd>Effective surcharge at foundation level [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>γ′<sub>B</sub></dt>
							<dd>Effective unit weight used in the N<sub>γ</sub> term [kN/m³]. Averaged across the water table where present — see §8.</dd>
						</div>
						<div class="symbols__row">
							<dt>c<sub>u</sub></dt>
							<dd>Undrained shear strength [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>s<sub>*</sub>, d<sub>*</sub>, i<sub>*</sub></dt>
							<dd>Shape, depth, and inclination factors for each resistance term.</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="dimensions" class="doc-card">
				<p class="section-label">Eccentricity</p>
				<h2>5. Effective dimensions after load eccentricity</h2>
				<p>
					An eccentric vertical load is equivalent to a centred load on a reduced footing. The
					"effective dimensions" (Meyerhof 1953) are the plan sides of the largest centred
					rectangle such that the centred load on that rectangle gives the same maximum contact
					pressure as the original eccentric load.
				</p>
				<div class="equations">
					<div class="formula">e<sub>B</sub> = M<sub>B</sub>/V,    e<sub>L</sub> = M<sub>L</sub>/V</div>
					<div class="formula">B′ = B − 2 e<sub>B</sub>,    L′ = L − 2 e<sub>L</sub></div>
					<div class="formula">r = B′/L′    with B′ ≤ L′</div>
				</div>
				<ul class="notes">
					<li>The app requires |e<sub>B</sub>| &lt; B/6 and |e<sub>L</sub>| &lt; L/6 to avoid tensile reactions under the footing corner; larger eccentricity is flagged.</li>
					<li>Shape, depth, and inclination factors are evaluated with B′ and L′, not with the nominal plan.</li>
				</ul>
			</section>

			<section id="shape" class="doc-card">
				<p class="section-label">Shape and depth factors</p>
				<h2>6. Brinch Hansen factors on effective dimensions</h2>
				<div class="equations">
					<div class="formula">s<sub>q</sub> = 1 + r sin φ′</div>
					<div class="formula">s<sub>c</sub> = (s<sub>q</sub> N<sub>q</sub> − 1) / (N<sub>q</sub> − 1)</div>
					<div class="formula">s<sub>γ</sub> = max(0.6, 1 − 0.3 r)</div>
					<div class="formula">s<sub>cu</sub> = 1 + 0.2 r</div>
					<div class="formula">η = D<sub>f</sub> / B′,    k = η   for η ≤ 1,    k = atan(η)   for η &gt; 1</div>
					<div class="formula">d<sub>q</sub> = 1 + 2 tan φ′ (1 − sin φ′)² k</div>
					<div class="formula">d<sub>c</sub> = d<sub>q</sub> − (1 − d<sub>q</sub>)/(N<sub>q</sub> tan φ′)    for φ′ &gt; 0</div>
					<div class="formula">d<sub>γ</sub> = 1.0</div>
					<div class="formula">d<sub>cu</sub> = 1 + 0.4 k</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>D<sub>f</sub></dt>
							<dd>Foundation embedment depth below ground level [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>η</dt>
							<dd>Embedment ratio D<sub>f</sub>/B′ [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>k</dt>
							<dd>Auxiliary depth-factor parameter [-], switching at η = 1 to cap k growth.</dd>
						</div>
					</dl>
				</div>
				<div class="doc-callout">
					<strong>Transparency note.</strong> The public route can also be switched to a
					conservative shape-factor mode with all shape factors set to 1.0. That is a deliberate
					screening choice, not a second theory — it returns the strip-centreline envelope on
					rectangular geometry.
				</div>
			</section>

			<section id="inclination" class="doc-card">
				<p class="section-label">Inclination</p>
				<h2>7. Inclination factors for horizontal load on the base</h2>
				<p>
					Horizontal load on the footing base reduces the bearing capacity of each term. The
					Brinch Hansen form expresses the reduction in closed-form in terms of the horizontal /
					vertical load ratio and a geometric exponent. The app uses it only when the engineer
					enters a non-zero horizontal action on the footing.
				</p>
				<div class="equations">
					<div class="formula">i<sub>q</sub> = (1 − H/(V + A′ c′ cot φ′))<sup>m</sup></div>
					<div class="formula">i<sub>γ</sub> = (1 − H/(V + A′ c′ cot φ′))<sup>m+1</sup></div>
					<div class="formula">i<sub>c</sub> = i<sub>q</sub> − (1 − i<sub>q</sub>)/(N<sub>q</sub> − 1)    for φ′ &gt; 0</div>
					<div class="formula">i<sub>cu</sub> = 0.5 (1 + √(1 − H/(A′ c<sub>u</sub>)))</div>
					<div class="formula">Exponent m for load in B-direction:  m<sub>B</sub> = (2 + B′/L′) / (1 + B′/L′)</div>
					<div class="formula">Exponent m for load in L-direction:  m<sub>L</sub> = (2 + L′/B′) / (1 + L′/B′)</div>
					<div class="formula">General bi-axial load:  m = m<sub>L</sub> cos²θ + m<sub>B</sub> sin²θ</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>H, V</dt>
							<dd>Horizontal and vertical components of the footing load [kN].</dd>
						</div>
						<div class="symbols__row">
							<dt>A′</dt>
							<dd>Effective plan area B′L′ [m²].</dd>
						</div>
						<div class="symbols__row">
							<dt>θ</dt>
							<dd>Azimuth of the horizontal load component, from the B-direction [rad].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The undrained form i<sub>cu</sub> is only valid while H ≤ A′ c<sub>u</sub> (the sliding limit on the footing base).</li>
					<li>If H / V exceeds the angle-of-friction limit tan φ′, no bearing equation applies and the engineer must switch to a combined bearing + sliding check.</li>
				</ul>
			</section>

			<section id="gamma" class="doc-card">
				<p class="section-label">Unit-weight averaging</p>
				<h2>8. Three-case water-table averaging for the N<sub>γ</sub> term</h2>
				<p>
					The N<sub>γ</sub> term contains the soil unit weight inside the failure wedge, which
					extends about one B below the footing. When the water table intersects that wedge, the
					appropriate "effective" γ is a spatial average of dry and submerged unit weights over the
					wedge depth. The app resolves this with three canonical cases depending on where the
					water table sits relative to the footing and the wedge bottom.
				</p>
				<div class="equations">
					<div class="formula">z<sub>w</sub>  ≤ D<sub>f</sub>          (WT above footing):         γ′<sub>B</sub> = γ<sub>sat</sub> − γ<sub>w</sub></div>
					<div class="formula">D<sub>f</sub>  &lt; z<sub>w</sub> ≤ D<sub>f</sub> + B  (WT within wedge):   γ′<sub>B</sub> = γ (z<sub>w</sub> − D<sub>f</sub>)/B + (γ<sub>sat</sub> − γ<sub>w</sub>)(D<sub>f</sub> + B − z<sub>w</sub>)/B</div>
					<div class="formula">z<sub>w</sub> &gt; D<sub>f</sub> + B    (WT deep):                    γ′<sub>B</sub> = γ</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>z<sub>w</sub></dt>
							<dd>Water-table depth below ground level [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>γ, γ<sub>sat</sub></dt>
							<dd>Dry and saturated unit weight of the soil inside the wedge [kN/m³].</dd>
						</div>
						<div class="symbols__row">
							<dt>γ<sub>w</sub></dt>
							<dd>Unit weight of water, 9.81 kN/m³.</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The surcharge q′ in the N<sub>q</sub> term uses the effective vertical stress at the foundation base, consistent with the standard EC7 convention.</li>
					<li>Transient drawdown during excavation (if modelled in the dewatering route) raises the effective surcharge and can increase q<sub>ult,d</sub>. The app exposes a coupled run for that sensitivity.</li>
				</ul>
			</section>

			<section id="design" class="doc-card">
				<p class="section-label">Design route</p>
				<h2>9. Belgian DA1/1 and DA1/2 handling</h2>
				<p>
					For Belgian EC7 practice, the app distinguishes DA1/1 and DA1/2 through resistance-side
					strength reduction. DA1/1 uses the unfactored M1 soil-strength set; DA1/2 reduces
					strength through the M2 soil-strength set. A resistance-side factor γ<sub>Rd</sub>
					scales the computed q<sub>ult</sub> to a design resistance.
				</p>
				<div class="equations">
					<div class="formula">tan φ′<sub>d</sub> = tan φ′<sub>k</sub> / γ<sub>φ</sub>,   γ<sub>φ</sub> = 1.00 (M1),  1.25 (M2)</div>
					<div class="formula">c′<sub>d</sub> = c′<sub>k</sub> / γ<sub>c</sub>,              γ<sub>c</sub> = 1.00 (M1),  1.25 (M2)</div>
					<div class="formula">c<sub>u,d</sub> = c<sub>u,k</sub> / γ<sub>cu</sub>,         γ<sub>cu</sub> = 1.00 (M1),  1.40 (M2)</div>
					<div class="formula">q<sub>d</sub> = q<sub>ult</sub>(φ′<sub>d</sub>, c′<sub>d</sub>, c<sub>u,d</sub>) / γ<sub>Rd</sub></div>
				</div>
				<ul class="notes">
					<li>The Belgian ANB γ<sub>Rd</sub> uses 1.40 for drained bearing on shallow footings; see NBN EN 1997-1 ANB Table A.NB.5.</li>
					<li>DA1/1 and DA1/2 envelopes are reported separately; the governing one is the minimum.</li>
					<li>Action-side partial factors (γ<sub>G</sub>, γ<sub>Q</sub>) are not applied here — they belong in the structural load combination producing q<sub>gross</sub>.</li>
				</ul>
			</section>

			<section id="deformation" class="doc-card">
				<p class="section-label">Deformation cross-check</p>
				<h2>10. Relation to the Stage 2 deformation safety analysis</h2>
				<p>
					The bearing route gives a <em>collapse-load</em> estimate from slip-line theory. The
					Stage 2 deformation solver gives a <em>strength-reduction factor</em> from a finite-element
					c-phi analysis on the same CPT section. The two should be consistent: for the same
					geometry and strengths, the deformation solver's factor of safety times the applied load
					should equal approximately q<sub>ult,d</sub>.
				</p>
				<ul class="notes">
					<li>When the two envelopes disagree by more than ~20%, the most common explanation is strength or stiffness layering the slip-line form ignores but the finite element captures.</li>
					<li>The engineer should run both routes on critical founding depths and compare.</li>
					<li>See <a href="/docs/engineering/deformation#mc">the Stage 2 MC chapter</a> for the finite-element theory.</li>
				</ul>
			</section>

			<section id="outputs" class="doc-card">
				<p class="section-label">Outputs and limitations</p>
				<h2>11. Deliverables and boundaries of validity</h2>
				<ul class="notes">
					<li>Depth-wise drained and undrained resistance envelopes; DA1/1 and DA1/2 design envelopes.</li>
					<li>Effective-dimension summary, shape / depth / inclination factor breakdown.</li>
					<li>N<sub>γ</sub> term's water-table case (above footing / in wedge / below wedge).</li>
					<li>Ground slope, base tilt, dynamic or seismic inclination, uplift, and sliding are not in the current route.</li>
					<li>Piled or combined-pile-raft foundations are outside the shallow-foundation screen.</li>
					<li>For two-layer soils where a stiff stratum is within 2B of the footing base, the slip-line solution can over-estimate capacity; the app flags the configuration for the engineer to reconsider.</li>
					<li>The deeper audit trail remains in <a href="/docs/full#bearing">the full technical specification</a>.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>Prandtl, L. (1921). Über die Eindringungsfestigkeit plastischer Baustoffe und die Festigkeit von Schneiden. <em>Z. Angew. Math. Mech.</em> 1(1), 15–20. Origin of the N<sub>c</sub> = π + 2 result.</li>
					<li>Reissner, H. (1924). Zum Erddruckproblem. <em>Proc. 1st Int. Congr. Appl. Mech.</em>, Delft, 295–311. Extension of Prandtl to weightless frictional soil.</li>
					<li>Meyerhof, G. G. (1953). The bearing capacity of foundations under eccentric and inclined loads. <em>Proc. 3rd ICSMFE</em>, Zurich, Vol. 1, 440–445.</li>
					<li>Brinch Hansen, J. (1970). A revised and extended formula for bearing capacity. <em>Bull. Danish Geotech. Inst.</em> 28, 5–11. Source of the shape/depth/inclination factors.</li>
					<li>Vesić, A. S. (1973). Analysis of ultimate loads of shallow foundations. <em>J. Soil Mech. Found. Div. ASCE</em> 99(SM1), 45–73.</li>
					<li>EN 1997-1:2004+A1:2013 — Eurocode 7, Part 1. Annex D.</li>
					<li>NBN EN 1997-1 ANB:2022 — Belgian National Annex to Eurocode 7.</li>
					<li>EN 1990:2002+A1:2005 — Basis of structural design.</li>
				</ul>
			</section>
		</main>
	</div>
</div>
