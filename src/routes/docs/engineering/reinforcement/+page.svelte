<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'ULS Reinforcement Output — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 reinforcement output: EC2 strain-compatibility derivation, rectangular stress-block factors, mu-omega closed form, ductility bound, minimum and maximum steel ratios, cover and exposure class.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/reinforcement';
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
	<header class="docs-header">
		<div class="docs-header__inner">
			<a class="docs-header__logo" href="https://madep.be">MADEP CPT Interpreter</a>
			<nav class="docs-header__nav" aria-label="Documentation navigation">
				<a href="/docs">Documentation</a>
				<a href="/docs/workflow">Interpretation</a>
				<a href="/docs/engineering">Stage 6</a>
				<a href="/docs/theory">Methods</a>
				<a href="/docs/reference">References</a>
				<a href="/docs/full#reinforcement">Specification anchor</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / reinforcement output</p>
			<h1>ULS reinforcement output.</h1>
			<p class="hero__lead">
				The reinforcement route converts the ULS bending moment from the strip-on-foundation solve
				into a required area of tension reinforcement per meter width, using EC2 strain
				compatibility on the parabola–rectangle concrete law and an elastic–perfectly-plastic steel
				law. The derivation below is the screening-level theory backing that output.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Reinforcement documentation navigation">
			<div class="docs-nav__title">Reinforcement</div>
			<a href="#scope">Scope and intent</a>
			<a href="#kinematics">Kinematics and constitutive laws</a>
			<a href="#block">Rectangular stress block</a>
			<a href="#route">Dimensionless route (μ, ω)</a>
			<a href="#ductility">Ductility and double reinforcement</a>
			<a href="#minmax">Minimum and maximum steel</a>
			<a href="#shear">Shear screening</a>
			<a href="#materials">Material factors, cover, exposure</a>
			<a href="#outputs">Outputs and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and meaning of the result</h2>
				<p>
					The reinforcement route is a <strong>strip ULS reinforcement screen</strong>. It takes the
					design bending moment per meter of strip width that the beam-on-foundation solver reports
					and returns the tension reinforcement area required to develop that moment, assuming a
					singly reinforced rectangular section and EC2 material laws.
				</p>
				<div class="doc-callout">
					<strong>Scope boundary.</strong> The result is a <em>one-dimensional strip</em>
					reinforcement quantity. It does not produce a two-dimensional bar layout, does not size
					shear links, does not verify serviceability crack widths or deflections, and does not
					account for punching at column heads. It is a preliminary sizing screen that the engineer
					then carries into a dedicated structural design tool.
				</div>
				<div class="symbols">
					<div class="symbols__title">Primary quantities</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>M<sub>Ed</sub></dt>
							<dd>Design bending moment per meter strip width [kN·m/m].</dd>
						</div>
						<div class="symbols__row">
							<dt>A<sub>s,req</sub></dt>
							<dd>Required tension reinforcement area per meter width [mm²/m].</dd>
						</div>
						<div class="symbols__row">
							<dt>μ, ω</dt>
							<dd>Dimensionless bending moment and mechanical reinforcement ratio [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>ξ<sub>lim</sub></dt>
							<dd>Limiting neutral-axis ratio for tension-controlled (ductile) failure [-].</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="kinematics" class="doc-card">
				<p class="section-label">Kinematics and constitutive laws</p>
				<h2>2. Plane sections, concrete law, and steel law</h2>
				<p>
					The formulation is the standard EC2 ULS bending assumption for reinforced concrete:
					plane sections remain plane, strain varies linearly through the depth, concrete
					in tension is ignored, and steel and concrete are each represented by an idealized
					constitutive law.
				</p>
				<div class="equations">
					<div class="formula">ε(y) = ε<sub>c</sub>(y<sub>top</sub> − y)/x linear strain profile</div>
					<div class="formula">σ<sub>c</sub>(ε<sub>c</sub>) = f<sub>cd</sub>[1 − (1 − ε<sub>c</sub>/ε<sub>c2</sub>)<sup>n</sup>]  for 0 ≤ ε<sub>c</sub> ≤ ε<sub>c2</sub></div>
					<div class="formula">σ<sub>c</sub>(ε<sub>c</sub>) = f<sub>cd</sub>                         for ε<sub>c2</sub> ≤ ε<sub>c</sub> ≤ ε<sub>cu2</sub></div>
					<div class="formula">n = 2,   ε<sub>c2</sub> = 2.0‰,   ε<sub>cu2</sub> = 3.5‰  (f<sub>ck</sub> ≤ 50 MPa)</div>
					<div class="formula">σ<sub>s</sub>(ε<sub>s</sub>) = E<sub>s</sub> ε<sub>s</sub>  for |ε<sub>s</sub>| ≤ f<sub>yd</sub>/E<sub>s</sub></div>
					<div class="formula">σ<sub>s</sub>(ε<sub>s</sub>) = sign(ε<sub>s</sub>) · f<sub>yd</sub>     beyond yield (horizontal branch adopted)</div>
					<div class="formula">f<sub>cd</sub> = α<sub>cc</sub> f<sub>ck</sub>/γ<sub>C</sub>,   f<sub>yd</sub> = f<sub>yk</sub>/γ<sub>S</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>ε<sub>c</sub>, ε<sub>c2</sub>, ε<sub>cu2</sub></dt>
							<dd>Concrete compressive strain, strain at peak, and ultimate strain [-]. Values for f<sub>ck</sub> ≤ 50 MPa.</dd>
						</div>
						<div class="symbols__row">
							<dt>n</dt>
							<dd>Exponent of the parabolic branch (n = 2 for normal strength).</dd>
						</div>
						<div class="symbols__row">
							<dt>x</dt>
							<dd>Neutral-axis depth from the compressed fibre [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>s</sub></dt>
							<dd>Steel Young modulus, 200 GPa.</dd>
						</div>
						<div class="symbols__row">
							<dt>α<sub>cc</sub></dt>
							<dd>Sustained-load coefficient (1.00 in the Belgian ANB; 0.85 in the base EN text for normal loading).</dd>
						</div>
						<div class="symbols__row">
							<dt>γ<sub>C</sub>, γ<sub>S</sub></dt>
							<dd>Partial material factors for concrete and steel. Default ULS: γ<sub>C</sub> = 1.50, γ<sub>S</sub> = 1.15.</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="block" class="doc-card">
				<p class="section-label">Rectangular stress block</p>
				<h2>3. Equivalent rectangular block and its λ, η factors</h2>
				<p>
					Integrating the parabola–rectangle law across the compression zone and equating force and
					moment to an equivalent uniform block of depth λx and intensity η f<sub>cd</sub> produces
					the EC2 rectangular block with λ = 0.8 and η = 1.0 for normal-strength concrete. The
					factors retain the same resultant force and lever arm as the exact integral.
				</p>
				<div class="equations">
					<div class="formula">C<sub>c</sub> = ∫<sub>0</sub><sup>x</sup> σ<sub>c</sub>(ε(y)) b dy = η f<sub>cd</sub> b λ x</div>
					<div class="formula">ȳ<sub>c</sub> = ∫ σ<sub>c</sub> y b dy / C<sub>c</sub> = λx / 2   (by construction)</div>
					<div class="formula">λ = 0.8,   η = 1.0       for f<sub>ck</sub> ≤ 50 MPa</div>
					<div class="formula">λ = 0.8 − (f<sub>ck</sub> − 50)/400,   η = 1.0 − (f<sub>ck</sub> − 50)/200  for 50 &lt; f<sub>ck</sub> ≤ 90 MPa</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>C<sub>c</sub></dt>
							<dd>Resultant concrete compressive force per meter of strip [kN/m].</dd>
						</div>
						<div class="symbols__row">
							<dt>λ</dt>
							<dd>Reduced depth factor for the equivalent stress block.</dd>
						</div>
						<div class="symbols__row">
							<dt>η</dt>
							<dd>Reduced intensity factor (η = 1.0 for normal strength; &lt; 1 for high strength).</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="route" class="doc-card">
				<p class="section-label">Design route</p>
				<h2>4. Dimensionless moment μ and mechanical ratio ω</h2>
				<p>
					The closed-form route for a singly reinforced rectangular section drops out of equilibrium
					and the rectangular stress block. Denote the normalized moment
					μ = M<sub>Ed</sub>/(b d² f<sub>cd</sub>) and the mechanical reinforcement ratio
					ω = A<sub>s</sub> f<sub>yd</sub>/(b d f<sub>cd</sub>). Axial equilibrium gives
					ω = η λ ξ with ξ = x/d, and moment equilibrium about the tension bars yields a quadratic
					in ω whose tension-controlled solution is the classical closed form.
				</p>
				<div class="equations">
					<div class="formula">d = h − c<sub>nom</sub> − φ<sub>link</sub> − φ<sub>bar</sub>/2</div>
					<div class="formula">μ = M<sub>Ed</sub> / (b d² f<sub>cd</sub>)</div>
					<div class="formula">N = 0:  A<sub>s</sub> f<sub>yd</sub> = η f<sub>cd</sub> b λ x   ⇒   ω = η λ ξ</div>
					<div class="formula">M<sub>Rd</sub> about tension steel:   M<sub>Rd</sub> = η f<sub>cd</sub> b λ x (d − λx/2)</div>
					<div class="formula">μ = ω (1 − ω/(2η))    ⇒    ω = η [1 − √(1 − 2μ/η)]</div>
					<div class="formula">For η = 1 (normal strength): ω = 1 − √(1 − 2μ)</div>
					<div class="formula">A<sub>s,req</sub> = ω b d f<sub>cd</sub> / f<sub>yd</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>h, c<sub>nom</sub>, φ<sub>link</sub>, φ<sub>bar</sub>, d</dt>
							<dd>Section thickness, nominal cover, link diameter (where present), tension-bar diameter, effective depth [mm].</dd>
						</div>
						<div class="symbols__row">
							<dt>b</dt>
							<dd>Reference width used in the section check (1000 mm per metre of strip).</dd>
						</div>
						<div class="symbols__row">
							<dt>ξ = x/d</dt>
							<dd>Relative neutral-axis depth.</dd>
						</div>
						<div class="symbols__row">
							<dt>M<sub>Rd</sub></dt>
							<dd>Section design moment resistance [kN·m/m].</dd>
						</div>
					</dl>
				</div>
				<p>
					The closed-form ω = η[1 − √(1 − 2μ/η)] is the tension-controlled root: the steel yields
					before the concrete crushes, so σ<sub>s</sub> = f<sub>yd</sub> is the right assumption.
					The alternative compression-controlled root would require a brittle-failure
					interpretation and is excluded by the ductility bound below.
				</p>
			</section>

			<section id="ductility" class="doc-card">
				<p class="section-label">Ductility bound</p>
				<h2>5. Limiting neutral-axis depth and the case for compression steel</h2>
				<p>
					The closed form is only valid while steel yields before concrete crushes
					(ε<sub>s</sub> ≥ f<sub>yd</sub>/E<sub>s</sub> at ε<sub>c</sub> = ε<sub>cu2</sub>). Linear
					strain compatibility translates this into a limit on ξ; above that limit the section is
					over-reinforced and the rectangular block overestimates capacity unless compression
					reinforcement is introduced.
				</p>
				<div class="equations">
					<div class="formula">ε<sub>s,min</sub> = f<sub>yd</sub>/E<sub>s</sub></div>
					<div class="formula">ξ<sub>lim</sub> = ε<sub>cu2</sub> / (ε<sub>cu2</sub> + ε<sub>s,min</sub>)</div>
					<div class="formula">For B500B, f<sub>yd</sub> = 435 MPa, E<sub>s</sub> = 200 GPa:  ε<sub>s,min</sub> ≈ 2.175‰</div>
					<div class="formula">⇒ ξ<sub>lim</sub> ≈ 0.617,   ω<sub>lim</sub> = η λ ξ<sub>lim</sub> ≈ 0.494</div>
					<div class="formula">μ<sub>lim</sub> = ω<sub>lim</sub> (1 − ω<sub>lim</sub>/(2η)) ≈ 0.372</div>
				</div>
				<ul class="notes">
					<li>If μ &gt; μ<sub>lim</sub>, the closed form is no longer valid. The current route then flags the section: the engineer must increase depth, raise f<sub>ck</sub>, or add compression reinforcement A′<sub>s</sub> sized to carry M<sub>Ed</sub> − M<sub>Rd,lim</sub>.</li>
					<li>The Belgian ANB keeps the same ξ<sub>lim</sub> framing; national redistribution limits on δ may tighten the usable ξ further at plastic-hinge regions.</li>
					<li>Tension-controlled failure is the default EC2 design target because it gives warning by cracking and deflection before collapse.</li>
				</ul>
			</section>

			<section id="minmax" class="doc-card">
				<p class="section-label">Detailing bounds</p>
				<h2>6. Minimum and maximum reinforcement area</h2>
				<p>
					Strain compatibility only sets the <em>required</em> area for the given moment. EC2
					detailing rules then impose a minimum and a maximum. The minimum protects against brittle
					cracking under the tensile capacity that the gross uncracked section can sustain; the
					maximum protects against congestion and compression-controlled behaviour.
				</p>
				<div class="equations">
					<div class="formula">A<sub>s,min</sub> = max(0.26 f<sub>ctm</sub>/f<sub>yk</sub> b<sub>t</sub> d,   0.0013 b<sub>t</sub> d)</div>
					<div class="formula">f<sub>ctm</sub> = 0.30 f<sub>ck</sub><sup>2/3</sup>   for f<sub>ck</sub> ≤ 50 MPa</div>
					<div class="formula">f<sub>ctm</sub> = 2.12 ln(1 + (f<sub>cm</sub>/10))   for f<sub>ck</sub> &gt; 50 MPa</div>
					<div class="formula">A<sub>s,max</sub> = 0.04 A<sub>c</sub> (outside lap zones)</div>
					<div class="formula">A<sub>s,eff</sub> = max(A<sub>s,req</sub>, A<sub>s,min</sub>)</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>f<sub>ctm</sub></dt>
							<dd>Mean axial tensile strength of concrete [MPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>f<sub>cm</sub></dt>
							<dd>Mean compressive cylinder strength, f<sub>cm</sub> = f<sub>ck</sub> + 8 MPa.</dd>
						</div>
						<div class="symbols__row">
							<dt>b<sub>t</sub></dt>
							<dd>Width of the tension zone of the section (b for a rectangular strip).</dd>
						</div>
						<div class="symbols__row">
							<dt>A<sub>c</sub></dt>
							<dd>Cross-sectional area of concrete (b·h per meter of strip).</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>For typical slab-on-ground strip problems with moderate moment, A<sub>s,min</sub> frequently governs in the span fields and away from local peaks.</li>
					<li>The app reports A<sub>s,req</sub> directly from the strain-compatibility calculation; the engineer compares against A<sub>s,min</sub> in the structural workflow downstream.</li>
				</ul>
			</section>

			<section id="shear" class="doc-card">
				<p class="section-label">Shear screening</p>
				<h2>7. Shear capacity without stirrups (V<sub>Rd,c</sub>)</h2>
				<p>
					The reinforcement output is a flexural quantity, but shear almost always governs detailing
					for thin slab strips on elastic foundation. The EC2 empirical expression for
					members without shear reinforcement is included here for continuity; the engineer runs it
					against the V<sub>Ed</sub> envelope from the beam solver.
				</p>
				<div class="equations">
					<div class="formula">V<sub>Rd,c</sub> = [C<sub>Rd,c</sub> k (100 ρ<sub>l</sub> f<sub>ck</sub>)<sup>1/3</sup> + k<sub>1</sub> σ<sub>cp</sub>] b<sub>w</sub> d</div>
					<div class="formula">V<sub>Rd,c,min</sub> = (v<sub>min</sub> + k<sub>1</sub> σ<sub>cp</sub>) b<sub>w</sub> d</div>
					<div class="formula">k = min(1 + √(200/d[mm]),  2.0)</div>
					<div class="formula">ρ<sub>l</sub> = min(A<sub>sl</sub>/(b<sub>w</sub> d),  0.02)</div>
					<div class="formula">C<sub>Rd,c</sub> = 0.18/γ<sub>C</sub>,   k<sub>1</sub> = 0.15,   v<sub>min</sub> = 0.035 k<sup>3/2</sup> f<sub>ck</sub><sup>1/2</sup></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>ρ<sub>l</sub></dt>
							<dd>Longitudinal reinforcement ratio using the tension steel anchored past the section.</dd>
						</div>
						<div class="symbols__row">
							<dt>k</dt>
							<dd>Size-effect factor capped at 2.0.</dd>
						</div>
						<div class="symbols__row">
							<dt>σ<sub>cp</sub></dt>
							<dd>Mean compressive stress from axial load (taken positive) [MPa]. Zero for an unprestressed slab strip.</dd>
						</div>
						<div class="symbols__row">
							<dt>b<sub>w</sub></dt>
							<dd>Minimum web width at the shear section (equal to b for a slab strip).</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>If V<sub>Ed</sub> &gt; V<sub>Rd,c</sub>, the section needs shear reinforcement; that is outside the reinforcement-screen route.</li>
					<li>Size effect k is meaningful for thin slabs because d is in the denominator of the √(200/d) term.</li>
				</ul>
			</section>

			<section id="materials" class="doc-card">
				<p class="section-label">Material and detailing assumptions</p>
				<h2>8. Material factors, effective depth, and exposure class</h2>
				<p>
					The route applies EC2 partial factors and derives the effective depth from the geometric
					inputs. Concrete cover is built from the exposure class, concrete class, and design
					working life per EC2 §4.4.1. The resulting c<sub>nom</sub> feeds directly into the
					effective depth.
				</p>
				<div class="equations">
					<div class="formula">c<sub>nom</sub> = c<sub>min</sub> + Δc<sub>dev</sub></div>
					<div class="formula">c<sub>min</sub> = max(c<sub>min,b</sub>,  c<sub>min,dur</sub> + Δc<sub>dur,γ</sub> − Δc<sub>dur,st</sub> − Δc<sub>dur,add</sub>,  10 mm)</div>
					<div class="formula">c<sub>min,b</sub> ≥ φ<sub>bar</sub>   (bond requirement)</div>
					<div class="formula">Δc<sub>dev</sub> = 10 mm  typical cast-in-place    (may be 5 mm with QA)</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>c<sub>min,b</sub></dt>
							<dd>Minimum cover for bond, equal to bar diameter.</dd>
						</div>
						<div class="symbols__row">
							<dt>c<sub>min,dur</sub></dt>
							<dd>Minimum cover for durability, from EC2 Table 4.4N by exposure class and structural class.</dd>
						</div>
						<div class="symbols__row">
							<dt>Δc<sub>dev</sub></dt>
							<dd>Allowance for execution deviation (EC2 §4.4.1.3).</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>Common ULS defaults: γ<sub>C</sub> = 1.50, γ<sub>S</sub> = 1.15, α<sub>cc</sub> follows the national annex (1.00 in NBN EN 1992-1-1 ANB).</li>
					<li>Belgian ANB also governs the choice of concrete strength class coupled to exposure.</li>
					<li>For fire design, a separate c<sub>min,fire</sub> from EN 1992-1-2 may govern. That route is outside the current screen.</li>
				</ul>
			</section>

			<section id="outputs" class="doc-card">
				<p class="section-label">Outputs and limitations</p>
				<h2>9. Reported quantities and boundaries of validity</h2>
				<p>
					The public output is an indicative tension reinforcement area per meter width consistent
					with the section’s moment capacity under the assumed plane-section and EC2 material laws.
					It is a structural-geotechnical screening quantity and is explicitly not a substitute for
					a full structural design workflow.
				</p>
				<ul class="notes">
					<li>No bar schedule, no two-dimensional layout, no detailing at openings or supports.</li>
					<li>Serviceability verifications (crack width w<sub>k</sub>, deflection, stress limitation) are outside this route.</li>
					<li>Shear, punching, torsion, fatigue, and anchorage checks are outside this route.</li>
					<li>Compression reinforcement is not sized; the app flags μ &gt; μ<sub>lim</sub> rather than auto-sizing A′<sub>s</sub>.</li>
					<li>The underlying specification anchor is <a href="/docs/full#reinforcement">the full technical specification</a>.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>EN 1992-1-1:2004+A1:2014 — Eurocode 2: Design of concrete structures. Part 1-1: General rules. §3.1, §3.2, §6.1, §9.2.1.</li>
					<li>NBN EN 1992-1-1 ANB:2010 — Belgian National Annex to Eurocode 2.</li>
					<li>EN 1990:2002+A1:2005 — Basis of structural design (partial factors).</li>
					<li>fib Model Code for Concrete Structures 2010 — background for the parabola–rectangle law and the rectangular block derivation.</li>
				</ul>
			</section>
		</main>
	</div>
</div>
