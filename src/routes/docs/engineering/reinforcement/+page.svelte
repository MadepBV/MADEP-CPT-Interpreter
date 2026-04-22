<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'ULS Reinforcement Output — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 reinforcement output: EC2-style route from design moment to required steel area, material factors, cover assumptions, and present limits.';
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
				The reinforcement route carries the strip-on-foundation structural response through to an
				EC2-style steel requirement per meter width. It is intended as a ULS reinforcement screen
				on top of the beam or slab support analysis.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Reinforcement documentation navigation">
			<div class="docs-nav__title">Reinforcement</div>
			<a href="#scope">Scope and intent</a>
			<a href="#route">Design route from moment</a>
			<a href="#materials">Material factors and cover</a>
			<a href="#outputs">Outputs and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and meaning of the result</h2>
				<p>
					The reinforcement route is a <strong>strip-based ULS reinforcement screen</strong>. It
					starts from the design bending moment from the strip-on-foundation solve and converts
					that into a required reinforcement area per meter width.
				</p>
				<div class="doc-callout">
					<strong>Scope boundary.</strong> The result is not a full two-dimensional slab
					reinforcement layout. It is a strip interpretation intended to support preliminary
					sizing and engineering judgment.
				</div>
			</section>

			<section id="route" class="doc-card">
				<p class="section-label">Design route</p>
				<h2>2. From design moment to required steel area</h2>
				<p>
					Once the ULS moment is obtained from the strip analysis, the app converts concrete and
					steel to design strengths and computes an approximate required steel area.
				</p>
				<div class="equations">
					<div class="formula">f<sub>cd</sub> = f<sub>ck</sub> / γ<sub>C</sub></div>
					<div class="formula">f<sub>yd</sub> = f<sub>yk</sub> / γ<sub>S</sub></div>
					<div class="formula">d = h − c<sub>nom</sub> − φ<sub>bar</sub>/2</div>
					<div class="formula">μ = M<sub>Ed</sub> / (b d<sup>2</sup> f<sub>cd</sub>)</div>
					<div class="formula">ω = 1 − √(1 − 2μ)</div>
					<div class="formula">A<sub>s,req</sub> = ω b d f<sub>cd</sub> / f<sub>yd</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>f<sub>ck</sub>, f<sub>cd</sub></dt>
							<dd>Characteristic and design concrete compressive strength [MPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>f<sub>yk</sub>, f<sub>yd</sub></dt>
							<dd>Characteristic and design steel yield strength [MPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>γ<sub>C</sub>, γ<sub>S</sub></dt>
							<dd>Concrete and steel material factors [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>h, c<sub>nom</sub>, φ<sub>bar</sub>, d</dt>
							<dd>Section thickness, nominal cover, bar diameter, and effective depth [mm or m, used consistently].</dd>
						</div>
						<div class="symbols__row">
							<dt>M<sub>Ed</sub></dt>
							<dd>Design bending moment per meter strip width [kN·m/m].</dd>
						</div>
						<div class="symbols__row">
							<dt>b</dt>
							<dd>Reference strip width in the reinforcement equation [m or mm, used consistently].</dd>
						</div>
						<div class="symbols__row">
							<dt>μ, ω</dt>
							<dd>Dimensionless bending and section parameters [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>A<sub>s,req</sub></dt>
							<dd>Required steel area per meter width [mm²/m or consistent section units].</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="materials" class="doc-card">
				<p class="section-label">Material and detailing assumptions</p>
				<h2>3. Material factors, effective depth, and cover assumptions</h2>
				<p>
					The current route applies EC2-style material factors and derives effective depth from
					the chosen thickness, bar diameter, and nominal cover.
				</p>
				<ul class="notes">
					<li>Concrete and steel are converted from characteristic to design strengths through γ<sub>C</sub> and γ<sub>S</sub>.</li>
					<li>The route incorporates the current durability or cover assumptions rather than treating cover as an entirely free decorative input.</li>
					<li>The result is therefore sensitive not only to M<sub>Ed</sub>, but also to exposure-class and detailing choices.</li>
				</ul>
			</section>

			<section id="outputs" class="doc-card">
				<p class="section-label">Outputs and limitations</p>
				<h2>4. Reported quantities and boundaries of validity</h2>
				<p>
					The public output is an indicative required reinforcement area per meter width. It is a
					structural-geotechnical screening quantity that should later be checked inside a full
					structural design workflow.
				</p>
				<ul class="notes">
					<li>No full two-dimensional reinforcement arrangement is produced.</li>
					<li>Serviceability crack-width and deflection verification are outside this route.</li>
					<li>The deeper audit trail remains in <a href="/docs/full#reinforcement">the full technical specification</a>.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>EN 1992-1-1</li>
					<li>NBN EN 1992-1-1 ANB</li>
				</ul>
			</section>
		</main>
	</div>
</div>
