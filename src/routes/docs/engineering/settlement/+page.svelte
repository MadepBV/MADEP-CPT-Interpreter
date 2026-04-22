<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Settlement — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 settlement workflow: stress increase beneath foundations, constrained-modulus integration, truncation rules, optional time interpretation, and limitations.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/settlement';
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
				<a href="/docs/full#settlement">Specification anchor</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / settlement</p>
			<h1>Stage 6 settlement.</h1>
			<p class="hero__lead">
				The settlement route is a centreline constrained-modulus integration on the interpreted
				CPT profile. It evaluates stress increase beneath the loaded area, updates
				E<sub>oed</sub> at the mean effective stress, and integrates settlement over depth.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Settlement documentation navigation">
			<div class="docs-nav__title">Settlement</div>
			<a href="#scope">Scope and intent</a>
			<a href="#stress">Stress increase</a>
			<a href="#integration">Constrained-modulus integration</a>
			<a href="#time">Time and truncation</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and public model</h2>
				<p>
					The public settlement workflow is a <strong>serviceability screen</strong> beneath a
					strip or rectangular loaded area. It does not build a two-dimensional settlement
					basin; instead it evaluates the centreline or centre-of-footprint response and reports
					total vertical settlement.
				</p>
				<div class="equations">
					<div class="formula">q<sub>net</sub> = q<sub>gross</sub> − σ<sub>v</sub>(D<sub>f</sub>)</div>
					<div class="formula">S = Σ ΔS<sub>i</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>q<sub>gross</sub>, q<sub>net</sub></dt>
							<dd>Gross and net foundation pressure [kPa = kN/m²].</dd>
						</div>
						<div class="symbols__row">
							<dt>σ<sub>v</sub>(D<sub>f</sub>)</dt>
							<dd>In-situ total vertical stress at foundation depth [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>D<sub>f</sub></dt>
							<dd>Foundation depth below ground level [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>S, ΔS<sub>i</sub></dt>
							<dd>Total settlement and sublayer settlement increment [m].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The present model is stiffness-based and uses the Stage 4/5 Hardening Soil style E<sub>oed</sub> route.</li>
					<li>The public output is a one-dimensional settlement quantity at the evaluation point.</li>
				</ul>
			</section>

			<section id="stress" class="doc-card">
				<p class="section-label">Stress increase</p>
				<h2>2. Vertical stress increase beneath the loaded area</h2>
				<p>
					For strip geometry, the app can use the exact Boussinesq centreline solution. For a
					rectangular loaded area, the centre stress is built by four-quadrant superposition of a
					corrected Newmark or Fadum influence factor. A simplified 2:1 option also remains
					available.
				</p>
				<div class="equations">
					<div class="formula">α = atan(B / 2z)</div>
					<div class="formula">Δσ<sub>v</sub>(z) = (q<sub>net</sub> / π)[2α + sin(2α)] for strip centreline</div>
					<div class="formula">m = B / z, n = L / z</div>
					<div class="formula">Δσ<sub>v,center</sub>(z) = 4 I<sub>z</sub>(B/2, L/2, z) q<sub>net</sub></div>
					<div class="formula">Δσ<sub>v</sub>(z) = q<sub>net</sub> B L / [(B + z)(L + z)] for the 2:1 option</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>α</dt>
							<dd>Strip-foundation geometric angle [rad].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δσ<sub>v</sub>(z), Δσ<sub>v,center</sub>(z)</dt>
							<dd>Vertical stress increase at depth <em>z</em> [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>B, L</dt>
							<dd>Foundation width and length [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>z</dt>
							<dd>Evaluation depth below the foundation base [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>m, n</dt>
							<dd>Influence-chart ratios B/z and L/z [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>I<sub>z</sub></dt>
							<dd>Influence factor for the rectangular stress solution [-].</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="integration" class="doc-card">
				<p class="section-label">Integration</p>
				<h2>3. Constrained-modulus settlement calculation</h2>
				<p>
					For each sublayer, the app forms the mean effective stress between the in-situ and
					loaded state, evaluates the oedometric modulus at that level, and computes the vertical
					strain increment.
				</p>
				<div class="equations">
					<div class="formula">σ′<sub>v,f,i</sub> = σ′<sub>v,0,i</sub> + Δσ<sub>v,i</sub></div>
					<div class="formula">σ′<sub>mean,i</sub> = 0.5(σ′<sub>v,0,i</sub> + σ′<sub>v,f,i</sub>)</div>
					<div class="formula">E<sub>oed,i</sub> = E<sub>oed,ref</sub>[(c′cotφ′ + σ′<sub>mean,i</sub>) / (c′cotφ′ + p<sub>ref</sub>)]<sup>m</sup></div>
					<div class="formula">Δε<sub>v,i</sub> = Δσ<sub>v,i</sub> / E<sub>oed,i</sub></div>
					<div class="formula">ΔS<sub>i</sub> = Δε<sub>v,i</sub> Δz<sub>i</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>σ′<sub>v,0,i</sub>, σ′<sub>v,f,i</sub></dt>
							<dd>Initial and final effective vertical stress in sublayer <em>i</em> [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>σ′<sub>mean,i</sub></dt>
							<dd>Mean effective stress used for stiffness evaluation [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>oed,ref</sub>, E<sub>oed,i</sub></dt>
							<dd>Reference and evaluated oedometric stiffness [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>c′, φ′</dt>
							<dd>Effective cohesion and friction angle [kPa, °].</dd>
						</div>
						<div class="symbols__row">
							<dt>p<sub>ref</sub></dt>
							<dd>Reference stress in the stiffness law [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>m</dt>
							<dd>Stress-dependency exponent [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δε<sub>v,i</sub></dt>
							<dd>Vertical strain increment in sublayer <em>i</em> [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δz<sub>i</sub></dt>
							<dd>Sublayer thickness [m].</dd>
						</div>
					</dl>
				</div>
				<div class="doc-callout">
					<strong>Engineering meaning.</strong> The settlement route is therefore directly tied to
					the interpretation workflow: E<sub>oed,ref</sub>, m, c′, and φ′ all come from the
					interpreted CPT layer model.
				</div>
			</section>

			<section id="time" class="doc-card">
				<p class="section-label">Time and truncation</p>
				<h2>4. Practical truncation and optional time interpretation</h2>
				<p>
					The public settlement output is sensitive to the chosen depth of integration. The app
					exposes practical truncation rules so the engineer can stop integration at a depth that
					matches the project question.
				</p>
				<ul class="notes">
					<li>Selectable truncation routes include Δσ<sub>v</sub> relative to in-situ effective stress, Δσ<sub>v</sub> relative to q<sub>net</sub>, and CPT-bottom truncation.</li>
					<li>Optional time interpretation for fine-grained layers follows the same one-dimensional Terzaghi-style consolidation logic used in the dewatering route.</li>
					<li>The current app does not expose a full spatial settlement field or slab-edge differential settlement map.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>Terzaghi &amp; Peck (1967)</li>
					<li>Boussinesq (1885)</li>
					<li>Newmark (1935)</li>
					<li>Fadum (1948)</li>
				</ul>
			</section>
		</main>
	</div>
</div>
