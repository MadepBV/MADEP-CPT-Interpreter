<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Dewatering — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 dewatering workflow: screened radius of influence, layered transmissivity, drawdown profiles, effective-stress change, settlement response, and limitations.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/dewatering';
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
				<a href="/docs/full#dewatering">Specification anchor</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / dewatering</p>
			<h1>Stage 6 dewatering.</h1>
			<p class="hero__lead">
				The dewatering route is a serviceability-oriented screening model that couples hydraulic
				drawdown with CPT-based effective-stress change and settlement response at the CPT
				location.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Dewatering documentation navigation">
			<div class="docs-nav__title">Dewatering</div>
			<a href="#scope">Scope and intent</a>
			<a href="#radius">Radius of influence</a>
			<a href="#transmissivity">Layered transmissivity</a>
			<a href="#profile">Drawdown profile</a>
			<a href="#stress">Stress and settlement response</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and engineering interpretation</h2>
				<p>
					The public dewatering route is a <strong>steady-state screening model</strong> for one
					well, an equivalent-radius excavation, or a line-dewatering trench. Its engineering
					deliverable is not only pumping demand, but also the effective-stress increase and
					settlement at the interpreted CPT position.
				</p>
				<div class="doc-callout">
					<strong>Model class.</strong> This route is a layered analytical screen. It is not a
					full transient groundwater model and not a substitute for a dedicated regional-flow
					study when hydraulic interaction becomes critical.
				</div>
			</section>

			<section id="radius" class="doc-card">
				<p class="section-label">Influence screening</p>
				<h2>2. Radius of influence and present simplification</h2>
				<p>
					The present public route still uses the classic Sichardt screening relation for the
					radius of influence. This is explicitly treated as a practical rule of thumb rather than
					a rigorous hydraulic boundary.
				</p>
				<div class="equations">
					<div class="formula">R = C s √k<sub>eff,h</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>R</dt>
							<dd>Screened radius of influence [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>C</dt>
							<dd>Sichardt coefficient [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>s</dt>
							<dd>Drawdown at the source [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>k<sub>eff,h</sub></dt>
							<dd>Equivalent horizontal conductivity [m/s].</dd>
						</div>
					</dl>
				</div>
				<div class="doc-callout doc-callout--warn">
					<strong>Transparency note.</strong> The app keeps Sichardt because it is a familiar
					screening rule in practice, but the method is documented as approximate and not as a
					rigorous outer boundary.
				</div>
			</section>

			<section id="transmissivity" class="doc-card">
				<p class="section-label">Layered hydraulic model</p>
				<h2>3. Transmissivity and transmissivity-moment formulation</h2>
				<p>
					The hydraulic core does not collapse the whole profile to one conductivity. Instead the
					app constructs the transmissivity of the currently saturated layered profile and updates
					that transmissivity as the phreatic level moves.
				</p>
				<div class="equations">
					<div class="formula">T = Σ(k<sub>h,i</sub>b<sub>i</sub>)</div>
					<div class="formula">T(h) = Σ(k<sub>h,i</sub>b<sub>i</sub>(h))</div>
					<div class="formula">M(h) = ∫<sub>0</sub><sup>h</sup> T(ξ) dξ</div>
					<div class="formula">Q = 2π[M(h<sub>0</sub>) − M(h<sub>w</sub>)] / ln(R / r<sub>w</sub>)</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>T</dt>
							<dd>Total transmissivity of the saturated profile [m²/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>k<sub>h,i</sub></dt>
							<dd>Horizontal conductivity of layer <em>i</em> [m/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>b<sub>i</sub></dt>
							<dd>Saturated thickness contribution of layer <em>i</em> [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>T(h)</dt>
							<dd>Transmissivity as a function of saturated thickness <em>h</em> [m²/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>M(h)</dt>
							<dd>Cumulative transmissivity moment [m³/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>h<sub>0</sub>, h<sub>w</sub></dt>
							<dd>Far-field and source saturated thickness [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>Q</dt>
							<dd>Screened steady-state discharge [m³/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>r<sub>w</sub></dt>
							<dd>Well radius or equivalent source radius [m].</dd>
						</div>
					</dl>
				</div>
				<p>
					For a homogeneous aquifer, the formulation collapses to the classical Dupuit-style
					unconfined expression. In the current app it remains layered by construction because the
					CPT-derived Stage 4 conductivity profile is preserved.
				</p>
			</section>

			<section id="profile" class="doc-card">
				<p class="section-label">Drawdown profile</p>
				<h2>4. Drawdown profile between the source and the CPT</h2>
				<p>
					For radial unconfined flow, the app solves the head profile through the transmissivity
					moment. The drawdown at the CPT is then sampled from that profile.
				</p>
				<div class="equations">
					<div class="formula">M(h(r)) = M(h<sub>w</sub>) + Q / (2π) · ln(r / r<sub>w</sub>)</div>
					<div class="formula">Δh<sub>CPT</sub> = h<sub>0</sub> − h(r<sub>CPT</sub>)</div>
					<div class="formula">h²(r) = h²<sub>w</sub> + Q/(πk) · ln(r / r<sub>w</sub>) in the homogeneous limit</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>r</dt>
							<dd>Radial distance from the source [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>h(r)</dt>
							<dd>Saturated thickness at radial distance <em>r</em> [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δh<sub>CPT</sub></dt>
							<dd>Drawdown at the CPT observation point [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>r<sub>CPT</sub></dt>
							<dd>Distance from the source to the CPT [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>k</dt>
							<dd>Homogeneous conductivity in the Dupuit limiting expression [m/s].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The CPT position is treated as the observation point of interest.</li>
					<li>For trenches, the displayed profile toward the CPT remains a linear screen even though the flow estimate itself is based on transmissivity.</li>
				</ul>
			</section>

			<section id="stress" class="doc-card">
				<p class="section-label">Stress and settlement</p>
				<h2>5. Effective stress change and settlement response</h2>
				<p>
					Once the new phreatic level at the CPT is known, the app recomputes pore pressure and
					effective stress and then evaluates settlement with the same constrained-modulus
					philosophy used in the settlement route.
				</p>
				<div class="equations">
					<div class="formula">u′(z) = γ<sub>w</sub> max(0, z − z′<sub>w</sub>)</div>
					<div class="formula">σ′<sub>v,new</sub>(z) = σ<sub>v</sub>(z) − u′(z)</div>
					<div class="formula">Δσ′<sub>v</sub>(z) = σ′<sub>v,new</sub>(z) − σ′<sub>v,old</sub>(z)</div>
					<div class="formula">Δε<sub>v,i</sub> = Δσ′<sub>v,i</sub> / E<sub>oed,i</sub></div>
					<div class="formula">ΔS<sub>dewatering</sub> = Σ Δε<sub>v,i</sub> Δz<sub>i</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>u′(z)</dt>
							<dd>Pore pressure after drawdown at depth <em>z</em> [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>z′<sub>w</sub></dt>
							<dd>New phreatic level depth below ground [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>σ′<sub>v,new</sub>, σ′<sub>v,old</sub></dt>
							<dd>New and original effective vertical stress [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δσ′<sub>v</sub></dt>
							<dd>Effective stress increase due to drawdown [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δε<sub>v,i</sub></dt>
							<dd>Vertical strain increment in sublayer <em>i</em> [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>oed,i</sub></dt>
							<dd>Oedometric stiffness in sublayer <em>i</em> [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δz<sub>i</sub></dt>
							<dd>Sublayer thickness [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>ΔS<sub>dewatering</sub></dt>
							<dd>Total dewatering-induced settlement [m].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The app reports both conservative and more realistic total-stress assumptions so the user can see the sensitivity of the result.</li>
					<li>Optional fine-grained time interpretation follows the same one-dimensional consolidation logic used in the settlement route.</li>
					<li>The current output is a settlement-at-CPT screen, not a full spatial settlement trough.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>Dupuit (1863)</li>
					<li>Thiem (1906)</li>
					<li>Bear (1979)</li>
					<li>Freeze &amp; Cherry (1979)</li>
					<li>Kyrieleis &amp; Sichardt (1930)</li>
					<li>Louwyck et al. (2022)</li>
					<li>Powers et al. (2007)</li>
				</ul>
			</section>
		</main>
	</div>
</div>
