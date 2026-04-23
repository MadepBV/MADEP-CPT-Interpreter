<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
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
	<header class="docs-header">
		<div class="docs-header__inner">
			<a class="docs-header__logo" href="https://madep.be">MADEP CPT Interpreter</a>
			<nav class="docs-header__nav" aria-label="Documentation navigation">
				<a href="/docs">Documentation</a>
				<a href="/docs/workflow">Interpretation</a>
				<a href="/docs/engineering">Stage 6</a>
				<a href="/docs/theory">Methods</a>
				<a href="/docs/reference">References</a>
				<a href="/docs/full">Specification</a>
				<a href="/">App</a>
			</nav>
		</div>
	</header>

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
			<a href="#analysis-classes">Analysis classes</a>
			<a href="#modules">Core analyses</a>
			<a href="#checks">Supporting checks</a>
			<a href="#reading">Reading sequence</a>
		</aside>

		<main class="docs-content">
			<section id="overview" class="doc-card">
				<p class="section-label">Scope</p>
				<h2>Stage 6 scope</h2>
				<p>{engineering.summary}</p>
				<p>
					This chapter is organized by analysis class. Each route documents one engineering
					formulation, its governing equations, required inputs, reported outputs, and
					boundaries of validity.
				</p>
			</section>

			<section id="analysis-classes" class="doc-card">
				<p class="section-label">Analysis classes</p>
				<h2>Implemented analysis families</h2>
				<div class="equations">
					<div class="formula">slope stability → limit equilibrium on slices</div>
					<div class="formula">seepage → steady-state Darcy flow on a T3 mesh</div>
					<div class="formula">deformation → small-strain plane-strain FE equilibrium</div>
				</div>
				<ul class="notes">
					<li><strong>Bishop + Spencer</strong> is the most mature route for global slope failure interpretation.</li>
					<li><strong>Seepage</strong> is a steady-state hydraulic screen and can provide pore pressure to the stability workflow.</li>
					<li><strong>Deformation</strong> is a mesh-based mechanical screen with geostatic preparation and constitutive branching.</li>
				</ul>
			</section>

			<section id="modules" class="doc-card">
				<p class="section-label">Modules</p>
				<h2>Core analysis chapters</h2>
				<div class="docs-link-grid">
					<a class="docs-link-card" href="/docs/engineering/bishop">
						<div class="docs-link-card__meta">Limit equilibrium</div>
						<h3>Bishop + Spencer</h3>
						<p>
							Circular slip-surface search, slice equilibrium, Spencer verification, and
							references for the Stage 6 slope-stability route.
						</p>
					</a>
					<a class="docs-link-card" href="/docs/engineering/seepage">
						<div class="docs-link-card__meta">Finite element seepage</div>
						<h3>Seepage analysis</h3>
						<p>
							Steady-state Darcy flow, boundary-condition semantics, free-surface iteration,
							and coupled pore-pressure interpretation.
						</p>
					</a>
					<a class="docs-link-card" href="/docs/engineering/deformation">
						<div class="docs-link-card__meta">Finite element deformation</div>
						<h3>Deformation analysis</h3>
						<p>
							Geostatic initialization, exact Mohr-Coulomb elastoplasticity with tension
							cut-off, plotted fields, and solver interpretation.
						</p>
					</a>
				</div>
			</section>

			<section id="checks" class="doc-card">
				<p class="section-label">Supporting engineering checks</p>
				<h2>Additional Stage 6 analysis chapters</h2>
				<p>
					Stage 6 also contains supplementary screening and design-check modules. These are
					documented as separate technical chapters. The long technical specification remains
					the complete audit route.
				</p>
				<div class="docs-link-grid">
					{#each engineering.pages.filter((page) => !['/docs/engineering/bishop', '/docs/engineering/seepage', '/docs/engineering/deformation'].includes(page.path)) as page}
						<a class="docs-link-card" href={page.path}>
							<div class="docs-link-card__meta">Stage 6 chapter</div>
							<h3>{page.title}</h3>
							<p>{page.summary}</p>
						</a>
					{/each}
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
