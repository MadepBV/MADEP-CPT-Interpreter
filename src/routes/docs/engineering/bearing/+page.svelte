<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Bearing Capacity — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 bearing-capacity workflow: drained and undrained resistance, effective dimensions, EC7-style factors, Belgian DA1 handling, outputs, and limitations.';
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
	<header class="docs-header">
		<div class="docs-header__inner">
			<a class="docs-header__logo" href="https://madep.be">MADEP CPT Interpreter</a>
			<nav class="docs-header__nav" aria-label="Documentation navigation">
				<a href="/docs">Documentation</a>
				<a href="/docs/workflow">Interpretation</a>
				<a href="/docs/engineering">Stage 6</a>
				<a href="/docs/theory">Methods</a>
				<a href="/docs/reference">References</a>
				<a href="/docs/full#bearing">Specification anchor</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / bearing capacity</p>
			<h1>Stage 6 bearing capacity.</h1>
			<p class="hero__lead">
				The bearing-capacity route is a shallow-foundation ULS screening tool built on the
				interpreted CPT section. It evaluates drained and undrained bearing resistance, applies
				effective-dimension logic for eccentricity, and reports Belgian DA1-style design
				envelopes.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Bearing documentation navigation">
			<div class="docs-nav__title">Bearing</div>
			<a href="#scope">Scope and intent</a>
			<a href="#model">Resistance model</a>
			<a href="#factors">Shape, depth, and eccentricity</a>
			<a href="#design">Belgian design route</a>
			<a href="#outputs">Outputs and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and engineering meaning</h2>
				<p>
					The current public bearing-capacity workflow is a <strong>shallow-foundation ULS
					screen</strong>. It evaluates the resistance side of the problem from CPT-derived soil
					parameters and reports governing drained and undrained resistance envelopes versus
					founding depth.
				</p>
				<div class="doc-callout">
					<strong>Model class.</strong> This route is a Brinch Hansen / EC7 Annex D style
					screening implementation for vertical loading. It is not a full general-footing code
					check with sliding, uplift, inclined load, ground-slope correction, or structural
					interaction.
				</div>
				<div class="symbols">
					<div class="symbols__title">Primary quantities</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>q<sub>ult,d</sub></dt>
							<dd>Ultimate drained bearing resistance [kPa = kN/m²].</dd>
						</div>
						<div class="symbols__row">
							<dt>q<sub>ult,u</sub></dt>
							<dd>Ultimate undrained bearing resistance [kPa = kN/m²].</dd>
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

			<section id="model" class="doc-card">
				<p class="section-label">Resistance model</p>
				<h2>2. Drained and undrained resistance formulations</h2>
				<p>
					The app evaluates drained and undrained resistance separately. For drained loading it
					uses the conventional effective-stress form with surcharge, unit weight, and
					bearing-capacity factors. For undrained loading it falls back to the Prandtl-style
					undrained expression.
				</p>
				<div class="equations">
					<div class="formula">
						q<sub>ult,d</sub> = c′N<sub>c</sub>s<sub>c</sub>d<sub>c</sub> + q′N<sub>q</sub>s<sub>q</sub>d<sub>q</sub> + 0.5γ′B′N<sub>γ</sub>s<sub>γ</sub>d<sub>γ</sub>
					</div>
					<div class="formula">
						q<sub>ult,u</sub> = q + 5.14c<sub>u</sub>s<sub>cu</sub>d<sub>cu</sub>
					</div>
					<div class="formula">N<sub>q</sub> = exp(π tan φ′) tan<sup>2</sup>(45° + φ′ / 2)</div>
					<div class="formula">N<sub>c</sub> = (N<sub>q</sub> − 1) / tan φ′</div>
					<div class="formula">N<sub>γ</sub> = 2(N<sub>q</sub> − 1) tan φ′</div>
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
							<dt>γ′</dt>
							<dd>Effective unit weight [kN/m³].</dd>
						</div>
						<div class="symbols__row">
							<dt>c<sub>u</sub></dt>
							<dd>Undrained shear strength [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>s<sub>c</sub>, s<sub>q</sub>, s<sub>γ</sub>, s<sub>cu</sub></dt>
							<dd>Shape factors [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>d<sub>c</sub>, d<sub>q</sub>, d<sub>γ</sub>, d<sub>cu</sub></dt>
							<dd>Depth factors [-].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The public implementation keeps the EC7 Annex D style rough-base form for N<sub>γ</sub>.</li>
					<li>For φ′ → 0 the drained form collapses toward the undrained Prandtl limit and the undrained route becomes the relevant branch.</li>
					<li>The engineer may compare drained and undrained envelopes independently rather than collapsing them into one mixed interpretation.</li>
				</ul>
			</section>

			<section id="factors" class="doc-card">
				<p class="section-label">Geometric factors</p>
				<h2>3. Effective dimensions, shape factors, and depth factors</h2>
				<p>
					Eccentricity is converted into effective footing dimensions. Shape and depth factors are
					then built from those effective dimensions rather than from the original plan size.
				</p>
				<div class="equations">
					<div class="formula">B′ = B − 2e<sub>B</sub>, L′ = L − 2e<sub>L</sub></div>
					<div class="formula">r = B′ / L′ with B′ ≤ L′</div>
					<div class="formula">s<sub>q</sub> = 1 + r sin φ′</div>
					<div class="formula">s<sub>c</sub> = (s<sub>q</sub>N<sub>q</sub> − 1) / (N<sub>q</sub> − 1)</div>
					<div class="formula">s<sub>γ</sub> = max(0.6, 1 − 0.3r)</div>
					<div class="formula">η = D<sub>f</sub> / B′, k = η for η ≤ 1 else atan(η)</div>
					<div class="formula">d<sub>q</sub> = 1 + 2 tan φ′(1 − sin φ′)<sup>2</sup> k</div>
					<div class="formula">d<sub>γ</sub> = 1.0, d<sub>cu</sub> = 1 + 0.4k</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>B, L</dt>
							<dd>Entered footing width and length [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>e<sub>B</sub>, e<sub>L</sub></dt>
							<dd>Eccentricities in width and length direction [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>r</dt>
							<dd>Effective plan ratio B′/L′ [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>D<sub>f</sub></dt>
							<dd>Foundation depth below ground level [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>η</dt>
							<dd>Embedment ratio D<sub>f</sub>/B′ [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>k</dt>
							<dd>Auxiliary depth-factor parameter [-].</dd>
						</div>
					</dl>
				</div>
				<div class="doc-callout">
					<strong>Transparency note.</strong> The current public route can also be switched to a
					conservative shape-factor mode with all shape factors set to 1.0. That is a deliberate
					screening choice, not a second theory.
				</div>
			</section>

			<section id="design" class="doc-card">
				<p class="section-label">Design route</p>
				<h2>4. Belgian DA1 handling in the current app</h2>
				<p>
					For Belgian EC7 practice, the app distinguishes DA1/1 and DA1/2 through soil-strength
					reduction on the resistance side. The present public workflow is therefore a
					<strong>resistance-side Belgian screening tool</strong>, not a full action-side ULS
					verification engine.
				</p>
				<div class="equations">
					<div class="formula">tan φ′<sub>d</sub> = tan φ′<sub>k</sub> / 1.25</div>
					<div class="formula">c′<sub>d</sub> = c′<sub>k</sub> / 1.25</div>
					<div class="formula">c<sub>u,d</sub> = c<sub>u,k</sub> / 1.40</div>
					<div class="formula">q<sub>d</sub> = q<sub>ult</sub> / γ<sub>Rd</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>φ′<sub>k</sub>, c′<sub>k</sub>, c<sub>u,k</sub></dt>
							<dd>Characteristic soil strengths [°, kPa, kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>φ′<sub>d</sub>, c′<sub>d</sub>, c<sub>u,d</sub></dt>
							<dd>Design soil strengths after DA1 reduction [°, kPa, kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>q<sub>d</sub></dt>
							<dd>Design bearing resistance [kPa = kN/m²].</dd>
						</div>
						<div class="symbols__row">
							<dt>γ<sub>Rd</sub></dt>
							<dd>Resistance-side factor used in the public route [-].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>DA1/1 uses the unfactored M1 soil strength set.</li>
					<li>DA1/2 uses reduced M2 soil strengths.</li>
					<li>The governing drained and undrained envelopes are reported separately.</li>
				</ul>
			</section>

			<section id="outputs" class="doc-card">
				<p class="section-label">Outputs and limitations</p>
				<h2>5. Deliverables and boundaries of validity</h2>
				<p>
					The public output is a depth-wise resistance screen rather than a full foundation
					design report. It is intended for engineering orientation: plausible founding depth,
					order of magnitude of drained versus undrained resistance, and sensitivity to strength
					assumptions and eccentricity.
				</p>
				<ul class="notes">
					<li>Horizontal load, base tilt, ground slope, and full sliding verification remain outside the current app.</li>
					<li>The current implementation is shallow-foundation only.</li>
					<li>The three-case groundwater averaging route for the N<sub>γ</sub> term is not yet implemented as a separate public option.</li>
					<li>The deeper audit trail remains available under <a href="/docs/full#bearing">the full technical specification</a>.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>EN 1997-1:2004+A1:2013</li>
					<li>NBN EN 1997-1 ANB:2022</li>
					<li>EN 1990:2002+A1:2005</li>
					<li>NBN EN 1990 ANB:2005</li>
					<li>Vesić (1975)</li>
					<li>Terzaghi &amp; Peck (1967)</li>
				</ul>
			</section>
		</main>
	</div>
</div>
