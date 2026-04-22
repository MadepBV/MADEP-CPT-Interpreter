<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Beam / Slab on Elastic Foundation — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 beam or slab on elastic foundation workflow: CPT-derived subgrade modulus, Winkler and Pasternak strip equations, and structural-geotechnical interpretation.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/beam';
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
				<a href="/docs/full#beam">Specification anchor</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / beam or slab on elastic foundation</p>
			<h1>Beam or slab on elastic foundation.</h1>
			<p class="hero__lead">
				The structural-geotechnical route is currently a one-dimensional strip model on elastic
				foundation. It derives subgrade support from the interpreted CPT stiffness profile and
				solves the strip on Winkler or Pasternak support.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Beam on elastic foundation navigation">
			<div class="docs-nav__title">Beam / slab</div>
			<a href="#scope">Scope and intent</a>
			<a href="#ks">CPT-based subgrade modulus</a>
			<a href="#governing">Governing equations</a>
			<a href="#pasternak">Pasternak extension</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and present public model</h2>
				<p>
					The current route is a <strong>1D strip or beam on elastic foundation</strong>. It is
					not yet a two-dimensional slab or plate solver. The public engineering purpose is
					screening of support stiffness, deflection trend, and bending or reaction distribution
					for slab strips and beams supported by soil.
				</p>
				<div class="doc-callout">
					<strong>Transparency note.</strong> The support parameters are not read from a
					separate table. They are reconstructed from the CPT-derived stiffness profile and are
					therefore footing-dependent, not universal soil constants.
				</div>
			</section>

			<section id="ks" class="doc-card">
				<p class="section-label">Support derivation</p>
				<h2>2. Modulus of subgrade reaction from the interpreted CPT profile</h2>
				<p>
					For each numerical sublayer beneath the foundation, the app evaluates the current
					stiffness from the interpreted Hardening Soil style layer model. Those sublayer values
					are averaged over the chosen influence depth, and the result is then transformed into a
					modulus of subgrade reaction through the Vesić-style route.
				</p>
				<div class="equations">
					<div class="formula">E<sub>oed,i</sub> = E<sub>oed,ref</sub>[(c′cotφ′ + σ′<sub>v,i</sub>) / (c′cotφ′ + p<sub>ref</sub>)]<sup>m</sup></div>
					<div class="formula">E<sub>s,avg</sub> = Σ(E<sub>s,i</sub>Δz<sub>i</sub>) / ΣΔz<sub>i</sub></div>
					<div class="formula">k<sub>s</sub> = [0.65E<sub>s</sub> / B(1 − ν<sub>s</sub><sup>2</sup>)] · (E<sub>s</sub>B<sup>4</sup> / E<sub>b</sub>I<sub>b</sub>)<sup>1/12</sup></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>E<sub>oed,ref</sub>, E<sub>oed,i</sub></dt>
							<dd>Reference and evaluated oedometric stiffness [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>σ′<sub>v,i</sub></dt>
							<dd>Effective vertical stress used for sublayer <em>i</em> [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>c′, φ′, p<sub>ref</sub>, m</dt>
							<dd>Effective cohesion [kPa], friction angle [°], reference stress [kPa], and stress exponent [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>s,avg</sub></dt>
							<dd>Averaged soil modulus over the influence zone [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>s,i</sub>, Δz<sub>i</sub></dt>
							<dd>Sublayer stiffness and thickness used in averaging [kPa, m].</dd>
						</div>
						<div class="symbols__row">
							<dt>k<sub>s</sub></dt>
							<dd>Modulus of subgrade reaction [kN/m³].</dd>
						</div>
						<div class="symbols__row">
							<dt>B</dt>
							<dd>Strip width [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>ν<sub>s</sub></dt>
							<dd>Poisson ratio adopted for the soil support conversion [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>b</sub>, I<sub>b</sub></dt>
							<dd>Beam Young modulus [kPa or MPa, used consistently] and second moment of area [m⁴].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>With the default app route, E<sub>s,i</sub> is taken from the interpreted oedometric stiffness family.</li>
					<li>The support stiffness therefore changes with footing width and influence depth.</li>
				</ul>
			</section>

			<section id="governing" class="doc-card">
				<p class="section-label">Strip equations</p>
				<h2>3. Governing equations and characteristic length</h2>
				<p>
					The structural strip is solved on either a Winkler or Pasternak foundation. In both
					cases the current public route is one-dimensional in the strip direction.
				</p>
				<div class="equations">
					<div class="formula">EI w'''' + k<sub>s</sub> b w = q(x) for Winkler support</div>
					<div class="formula">EI w'''' − G<sub>p</sub> b w'' + k<sub>s</sub> b w = q(x) for Pasternak support</div>
					<div class="formula">λ = (4EI / k<sub>s</sub>b)<sup>1/4</sup></div>
					<div class="formula">β = 1 / λ</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>E, I, EI</dt>
							<dd>Beam Young modulus [kPa or MPa], second moment of area [m⁴], and bending stiffness [consistent force·length²].</dd>
						</div>
						<div class="symbols__row">
							<dt>w(x)</dt>
							<dd>Vertical deflection along the strip [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>q(x)</dt>
							<dd>Distributed load along the strip [kN/m].</dd>
						</div>
						<div class="symbols__row">
							<dt>b</dt>
							<dd>Effective strip width in the 1D model [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>λ</dt>
							<dd>Characteristic length of the beam-foundation system [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>β</dt>
							<dd>Inverse characteristic length [1/m].</dd>
						</div>
						<div class="symbols__row">
							<dt>G<sub>p</sub></dt>
							<dd>Pasternak shear-layer stiffness per unit area [kN/m²].</dd>
						</div>
					</dl>
				</div>
				<p>
					The characteristic length is used to interpret whether the strip behaves as short,
					intermediate, or long on the computed elastic foundation.
				</p>
			</section>

			<section id="pasternak" class="doc-card">
				<p class="section-label">Pasternak extension</p>
				<h2>4. Pasternak shear-layer interpretation</h2>
				<p>
					The Pasternak extension in the public app is a screening enhancement rather than a
					continuum-calibrated soil model. The shear-layer parameter is derived from the averaged
					soil shear modulus and the selected influence depth.
				</p>
				<div class="equations">
					<div class="formula">G<sub>p</sub> = η G<sub>s,avg</sub> H<sub>p</sub></div>
					<div class="formula">G<sub>s,avg</sub> = E<sub>s,avg</sub> / [2(1 + ν<sub>s</sub>)]</div>
					<div class="formula">H<sub>p</sub> = z<sub>influence</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>η</dt>
							<dd>Calibration factor linking averaged soil shear stiffness to the Pasternak layer [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>G<sub>s,avg</sub></dt>
							<dd>Averaged soil shear modulus over the influence zone [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>ν<sub>s</sub></dt>
							<dd>Poisson ratio used to convert E<sub>s,avg</sub> to G<sub>s,avg</sub> [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>H<sub>p</sub>, z<sub>influence</sub></dt>
							<dd>Adopted Pasternak shear-layer thickness or influence depth [m].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The current route is most useful as a comparative screening tool for support coupling rather than as a final structural design model.</li>
					<li>Patch loads and point loads are generally more informative than fully uniform loading when bending-driven output is the goal.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>Hetényi (1946)</li>
					<li>Vesić (1961a)</li>
					<li>Vesić (1961b)</li>
					<li>Pasternak (1954)</li>
					<li>Kerr (1964)</li>
				</ul>
			</section>
		</main>
	</div>
</div>
