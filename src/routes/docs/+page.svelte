<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import { docsGroups, docsQuickLinks } from '$lib/docs/site';

	const pageTitle = 'Documentation — MADEP CPT Interpreter';
	const pageDescription =
		'Documentation for the MADEP CPT Interpreter: CPT interpretation flow, Stage 6 engineering analyses, methods and assumptions, standards and references, and the technical specification.';
	const canonicalUrl = 'https://cpt.madep.be/docs';
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
				<a href="/">App</a>
				<a href="/docs/workflow">Interpretation</a>
				<a href="/docs/engineering">Stage 6</a>
				<a href="/docs/theory">Methods</a>
				<a href="/docs/reference">References</a>
				<a href="/docs/full">Specification</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Documentation</p>
			<h1>Technical manual organized by application workflow.</h1>
			<p class="hero__lead">
				This manual documents the application in the order of use: CPT interpretation
				(Stages 1 to 5), Stage 6 engineering analyses, supporting methods, references, and
				the full technical specification.
			</p>
			<div class="hero__actions">
				<a class="btn btn--primary" href="/docs/workflow">Open CPT interpretation</a>
				<a class="btn btn--outline-dark" href="/docs/engineering">Open Stage 6 analyses</a>
			</div>
			<div class="hero__trust">
				<span>Application-flow structure</span>
				<span>Transparent methods and assumptions</span>
				<span>Dedicated references section</span>
			</div>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Documentation navigation">
			<div class="docs-nav__title">Docs</div>
			<a href="#overview">Overview</a>
			<a href="#flow">Application flow</a>
			<a href="#structure">Manual structure</a>
			<a href="#quick-links">Primary routes</a>
			<div class="docs-nav__title" style="margin-top:18px">Sections</div>
			{#each docsGroups as group}
				<a href={group.path}>{group.title}</a>
			{/each}
		</aside>

		<main class="docs-content">
			<section id="overview" class="doc-card">
				<p class="section-label">Overview</p>
				<h2>Scope</h2>
				<p>
					This manual defines the technical scope of the application and the function of each
					document route:
				</p>
				<ul class="notes">
					<li><strong>CPT interpretation:</strong> reconstruction, classification, layer derivation, and parameter assignment from the CPT trace.</li>
					<li><strong>Stage 6 engineering analyses:</strong> model definition, governing equations, reported outputs, and boundaries of validity for each analysis module.</li>
					<li><strong>Methods:</strong> notation, constitutive conventions, governing equations, discretization choices, and numerical procedures.</li>
					<li><strong>References:</strong> standards context, literature basis, quantity definitions, export fields, symbols, and units.</li>
					<li><strong>Technical specification:</strong> complete implementation detail for audit, review, and verification.</li>
				</ul>
			</section>

			<section id="flow" class="doc-card">
				<p class="section-label">Application flow</p>
				<h2>Relationship to the application workflow</h2>
				<div class="docs-link-grid">
					<a class="docs-link-card" href="/docs/workflow">
						<div class="docs-link-card__meta">Stages 1–5</div>
						<h3>CPT interpretation</h3>
						<p>
							This route documents the derivation of layer parameters, soil subtypes, and
							exported stiffness values from the raw CPT trace.
						</p>
					</a>
					<a class="docs-link-card" href="/docs/engineering">
						<div class="docs-link-card__meta">Stage 6</div>
						<h3>Stage 6 engineering analyses</h3>
						<p>
							This route documents slope stability, seepage, deformation, and the other
							engineering analyses on the interpreted section.
						</p>
					</a>
					<a class="docs-link-card" href="/docs/theory">
						<div class="docs-link-card__meta">Supporting basis</div>
						<h3>Methods and assumptions</h3>
						<p>
							This route records the governing equations, sign conventions, and numerical
							method boundaries that support the workflow and engineering analyses.
						</p>
					</a>
				</div>
			</section>

			<section id="structure" class="doc-card">
				<p class="section-label">Structure</p>
				<h2>Route structure and logic</h2>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr>
									<th>Route</th>
									<th>Primary scope</th>
									<th>Content</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td><a href="/docs/workflow">/docs/workflow</a></td>
									<td>Derivation of engineering layers and parameters from raw CPT readings.</td>
									<td>Stages 1 to 5: GEF/Excel/CSV import, classification, layer derivation, parameter assignment, and optional m-fitting.</td>
								</tr>
								<tr>
									<td><a href="/docs/engineering">/docs/engineering</a></td>
									<td>Definition and interpretation of the Stage 6 engineering analyses.</td>
									<td>Stage 6 analyses: slope stability, seepage, deformation, settlement screening, and related design checks.</td>
								</tr>
								<tr>
									<td><a href="/docs/theory">/docs/theory</a></td>
									<td>Governing equations, conventions, and numerical methods.</td>
									<td>Notation, effective stress, governing equations, finite-element conventions, and documented approximations.</td>
								</tr>
								<tr>
									<td><a href="/docs/reference">/docs/reference</a></td>
									<td>Documentary basis, standards context, and source families.</td>
									<td>Standards, literature, source families, and export meaning.</td>
								</tr>
								<tr>
									<td><a href="/docs/full">/docs/full</a></td>
									<td>Complete implementation detail and audit path.</td>
									<td>The long-form technical specification with detailed anchors, tables, and formulas.</td>
								</tr>
							</tbody>
						</table>
					</div>
				</div>
			</section>

			<section class="doc-card">
				<p class="section-label">Sections</p>
				<h2>Main sections of the manual</h2>
				<div class="docs-link-grid">
					{#each docsGroups as group}
						<a class="docs-link-card" href={group.path}>
							<div class="docs-link-card__meta">Section</div>
							<h3>{group.title}</h3>
							<p>{group.summary}</p>
							<ul class="docs-link-list">
								{#each group.pages as page}
									<li>{page.title}</li>
								{/each}
							</ul>
						</a>
					{/each}
				</div>
			</section>

			<section id="quick-links" class="doc-card">
				<p class="section-label">Primary routes</p>
				<h2>Primary manual entry points</h2>
				<div class="docs-link-grid">
					{#each docsQuickLinks as link}
						<a class="docs-link-card" href={link.path}>
							<div class="docs-link-card__meta">{link.tag ?? 'Route'}</div>
							<h3>{link.title}</h3>
							<p>{link.summary}</p>
						</a>
					{/each}
				</div>
			</section>
		</main>
	</div>
</div>
