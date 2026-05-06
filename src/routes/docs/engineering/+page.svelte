<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';
	import { docsGroups } from '$lib/docs/site';

	const engineering = docsGroups.find((group) => group.path === '/docs/engineering')!;
	const pageTitle = 'Stage 6 Engineering Analyses — MADEP CPT Interpreter';
	const pageDescription =
		'Engineering analyses documentation for the CPT app: Stage 6 slope stability, seepage, deformation, and related screening tools.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering';
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
			<p class="hero__eyebrow">Stage 6 engineering analyses</p>
			<h1>Stage 6 analyses on the interpreted section.</h1>
			<p class="hero__lead">
				This section documents the engineering modules that sit on top of the interpreted CPT
				layer model. Each page explains analysis class, governing formulation, user inputs,
				output meaning, and implementation boundaries.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Engineering documentation navigation">
			<div class="docs-nav__title">Stage 6</div>
			<a href="#overview">Scope</a>
			<a href="#families">Analysis families</a>
			<a href="#foundation">Foundation design</a>
			<a href="#slope">Slope stability</a>
			<a href="#groundwater">Groundwater</a>
			<a href="#deformation">Deformation</a>
			<a href="#reading">Reading sequence</a>
		</aside>

		<main class="docs-content">
			<section id="overview" class="doc-card">
				<p class="section-label">Scope</p>
				<h2>Stage 6 scope</h2>
				<p>{engineering.summary}</p>
				<p>
					This chapter is organized by analysis family. Each route documents one engineering
					formulation, its governing equations, required inputs, reported outputs, and
					boundaries of validity. The chapters are equally first-class deliverables; the
					grouping below is by physical question, not by implementation cost.
				</p>
			</section>

			<section id="families" class="doc-card">
				<p class="section-label">Analysis families</p>
				<h2>Implemented analysis families</h2>
				<div class="equations">
					<div class="formula">foundation design → CPT-direct resistance + EC7 / Belgian ANB factors</div>
					<div class="formula">slope stability → limit equilibrium on slices</div>
					<div class="formula">groundwater → analytical drawdown screen and steady-state FE Darcy flow</div>
					<div class="formula">deformation → small-strain plane-strain FE equilibrium</div>
				</div>
				<ul class="notes">
					<li><strong>Foundation design</strong> covers the shallow- and deep-foundation routes (bearing, pile, settlement, beam / slab on elastic foundation, EC2 reinforcement) under EC7 with the Belgian National Annex and DM20 / ATG pile factors.</li>
					<li><strong>Slope stability</strong> uses Bishop simplified for the search and a full Spencer recheck on shortlisted circles.</li>
					<li><strong>Groundwater</strong> covers analytical radius-of-influence drawdown screening and a steady-state FE Darcy solver with free-surface iteration.</li>
					<li><strong>Deformation</strong> is a plane-strain FE solver with geostatic initialization and exact Mohr-Coulomb elastoplasticity with tension cut-off.</li>
				</ul>
			</section>

			<section id="foundation" class="doc-card">
				<p class="section-label">Foundation design</p>
				<h2>Foundation analyses</h2>
				<div class="docs-link-grid">
					<a class="docs-link-card" href="/docs/engineering/bearing">
						<div class="docs-link-card__meta">Shallow foundations · ULS</div>
						<h3>Bearing capacity</h3>
						<p>
							Brinch Hansen / EC7 Annex D factor chain, drained and undrained envelopes,
							effective dimensions, water-table averaging, and Belgian DA1 handling.
						</p>
					</a>
					<a class="docs-link-card" href="/docs/engineering/pile">
						<div class="docs-link-card__meta">Deep foundations · ULS &amp; SLS</div>
						<h3>Pile capacity</h3>
						<p>
							Axial pile resistance and SLS settlement: De Beer scale-effect base
							resistance, Belgian shaft-friction table, full ULS factor chain
							(γ<sub>Rd</sub>, ξ<sub>3</sub> / ξ<sub>4</sub>, γ<sub>b</sub>, γ<sub>s</sub>),
							F<sub>nk</sub> screening, and load-transfer settlement.
						</p>
					</a>
					<a class="docs-link-card" href="/docs/engineering/settlement">
						<div class="docs-link-card__meta">Shallow foundations · SLS</div>
						<h3>Settlement</h3>
						<p>
							Stress-increase integration, constrained-modulus settlement, truncation
							rules, and optional time-dependent interpretation.
						</p>
					</a>
					<a class="docs-link-card" href="/docs/engineering/beam">
						<div class="docs-link-card__meta">Structural–geotechnical strip</div>
						<h3>Beam / slab on elastic foundation</h3>
						<p>
							k<sub>s</sub> derivation from the CPT stiffness profile, Winkler and
							Pasternak strip equations, and the present screening route.
						</p>
					</a>
					<a class="docs-link-card" href="/docs/engineering/reinforcement">
						<div class="docs-link-card__meta">EC2 ULS output</div>
						<h3>ULS reinforcement output</h3>
						<p>
							Strip-based EC2 reinforcement screening from the design moment, material
							factors, and cover assumptions.
						</p>
					</a>
				</div>
			</section>

			<section id="slope" class="doc-card">
				<p class="section-label">Slope stability</p>
				<h2>Slope-stability analysis</h2>
				<div class="docs-link-grid">
					<a class="docs-link-card" href="/docs/engineering/bishop">
						<div class="docs-link-card__meta">Limit equilibrium · circular</div>
						<h3>Bishop + Spencer</h3>
						<p>
							Circular slip-surface search, slice equilibrium, Spencer verification, and
							references for the Stage 6 slope-stability route.
						</p>
					</a>
				</div>
			</section>

			<section id="groundwater" class="doc-card">
				<p class="section-label">Groundwater</p>
				<h2>Groundwater analyses</h2>
				<div class="docs-link-grid">
					<a class="docs-link-card" href="/docs/engineering/seepage">
						<div class="docs-link-card__meta">Steady-state FE Darcy flow</div>
						<h3>Seepage analysis</h3>
						<p>
							Steady-state Darcy flow, boundary-condition semantics, free-surface
							iteration, and coupled pore-pressure interpretation.
						</p>
					</a>
					<a class="docs-link-card" href="/docs/engineering/dewatering">
						<div class="docs-link-card__meta">Analytical drawdown screen</div>
						<h3>Dewatering</h3>
						<p>
							Radius-of-influence screening, layered transmissivity, drawdown profiles,
							and drawdown-induced effective-stress effects.
						</p>
					</a>
				</div>
			</section>

			<section id="deformation" class="doc-card">
				<p class="section-label">Deformation</p>
				<h2>Deformation analysis</h2>
				<div class="docs-link-grid">
					<a class="docs-link-card" href="/docs/engineering/deformation">
						<div class="docs-link-card__meta">Plane-strain FE equilibrium</div>
						<h3>Deformation analysis</h3>
						<p>
							Geostatic initialization, exact Mohr-Coulomb elastoplasticity with tension
							cut-off, plotted fields, and solver interpretation.
						</p>
					</a>
				</div>
			</section>

			<section id="reading" class="doc-card">
				<p class="section-label">Reading sequence</p>
				<h2>Recommended reading sequence</h2>
				<ul class="notes">
					<li><strong>CPT interpretation</strong> precedes any audit of Stage 6 parameters and soil-property origin.</li>
					<li><strong>Methods and assumptions</strong> should be consulted before detailed review of the module-specific equations.</li>
					<li>Individual engineering chapters may be consulted directly when the analysis class is already known.</li>
					<li><strong>Standards and references</strong> and the <strong>technical specification</strong> provide bibliographic traceability and the full equation-by-equation audit trail.</li>
				</ul>
			</section>
		</main>
	</div>
</div>
