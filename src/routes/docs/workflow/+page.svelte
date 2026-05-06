<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';
	import { docsGroups } from '$lib/docs/site';
	import { workflowReferenceGroups, workflowSections } from '$lib/docs/workflow-content';

	const workflow = docsGroups.find((group) => group.path === '/docs/workflow')!;
	const pageTitle = 'CPT Interpretation — MADEP CPT Interpreter';
	const pageDescription =
		'Technical documentation for the CPT interpretation workflow: scope, GEF/Excel/CSV loading, classification, layering, parameter derivation, experimental m-fitting, engineering conventions, formulas, tables, assumptions, and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs/workflow';
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
			<p class="hero__eyebrow">CPT interpretation</p>
			<h1>Technical interpretation workflow of the application.</h1>
			<p class="hero__lead">
				This chapter records the full interpretation chain from raw CPT file input to the
				engineered layer state used by Stage 6: scope, file reconstruction, point
				classification, layer rationalization, parameter derivation, optional
				stress-dependency fitting, and the shared engineering conventions carried forward.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Workflow documentation navigation">
			<div class="docs-nav__title">Pages</div>
			<a href="/docs">Documentation</a>
			<a href="/docs/workflow" aria-current="page">Interpretation</a>
			<a href="/docs/engineering">Stage 6</a>
			<a href="/docs/theory">Methods</a>
			<a href="/docs/reference">References</a>
			<a href="/docs/full">Specification</a>
			<div class="docs-nav__title" style="margin-top:18px">On this page</div>
			<a href="#overview">Overview</a>
			<a href="#flow">Application sequence</a>
			{#each workflowSections as section}
				<a href={`#${section.id}`}>{section.title}</a>
			{/each}
			<a href="#bibliography">Bibliography</a>
			<a href="#related">Related chapters</a>
		</aside>

		<main class="docs-content">
			<section id="overview" class="doc-card">
				<p class="section-label">Overview</p>
				<h2>{workflow.title}</h2>
				<p>{workflow.summary}</p>
				<p>
					This route is the detailed record of what the application actually does from the
					start of interpretation through the layer state handed into Stage 6. The formulas,
					tables, subtype catalogues, smart-merge rules, stiffness routes, engineering
					conventions, and source basis are reproduced here so the application sequence can
					be read without falling back to the long-form specification.
				</p>
				<ul class="notes">
					<li>Stage 6 does not reinterpret the CPT independently; it reuses the interpreted layer state produced here.</li>
					<li>Boundary detection, parameter assignment, and engineering analysis are intentionally separated because they answer different questions.</li>
					<li>The long-form specification remains available as the exhaustive implementation trace, but this chapter is intended to be self-sufficient for the application workflow itself.</li>
				</ul>
			</section>

			<section id="flow" class="doc-card">
				<p class="section-label">Sequence</p>
				<h2>Application sequence</h2>
				<p>
					The workflow is sequential by design. The application first reconstructs a usable
					CPT trace from the uploaded file, then classifies every point, then converts that
					pointwise sequence into layers, then assigns engineering parameters to those
					layers, and only after that passes the resulting interpreted state into the Stage 6
					engineering analyses.
				</p>
				<div class="equations">
					<div class="formula">
						file import → point classification → layer boundaries → model parameters → optional
						m-fitting → Stage 6 engineering use
					</div>
				</div>
				<ul class="notes">
					<li>Stage 2 is classification per CPT point.</li>
					<li>Stage 3 is the translation from pointwise classification to an engineering layer stack.</li>
					<li>Stage 4 derives the constitutive and hydraulic parameter set that Stage 6 consumes.</li>
					<li>Stage 5 is optional and experimental: it adjusts only the Hardening Soil stress exponent m after engineer approval.</li>
				</ul>
			</section>

			{#each workflowSections as section}
				<section id={section.id} class="doc-card">
					<p class="section-label">Stage</p>
					<h2>{section.title}</h2>
					<p>{@html section.intro}</p>

					{#each section.subsections as subsection}
						<section id={subsection.id} class="doc-subsection">
							<h3>{@html subsection.title}</h3>
							{#each subsection.paragraphs as paragraph}
								<p>{@html paragraph}</p>
							{/each}

							{#if subsection.equations}
								<div class="equations">
									{#each subsection.equations as eq}
										<div class="formula" aria-label="Engineering formula">{@html eq}</div>
									{/each}
								</div>
							{/if}

							{#if subsection.symbols}
								<div class="symbols">
									<div class="symbols__title">Notation</div>
									<dl class="symbols__list">
										{#each subsection.symbols as symbol}
											<div class="symbols__row">
												<dt>{@html symbol.term}</dt>
												<dd>{symbol.meaning}</dd>
											</div>
										{/each}
									</dl>
								</div>
							{/if}

							{#if subsection.figures}
								<div class="doc-figures">
									{#each subsection.figures as figure}
										{#if figure.collapsible}
											<details class="doc-figure-toggle">
												<summary>{figure.summary ?? 'Show source figure'}</summary>
												<figure class="doc-figure">
													<img src={figure.src} alt={figure.alt} loading="lazy" />
													<figcaption>{@html figure.caption}</figcaption>
												</figure>
											</details>
										{:else}
											<figure class="doc-figure">
												<img src={figure.src} alt={figure.alt} loading="lazy" />
												<figcaption>{@html figure.caption}</figcaption>
											</figure>
										{/if}
									{/each}
								</div>
							{/if}

							{#if subsection.table}
								<div class="doc-table-wrap">
									{#if subsection.table.collapsible}
										<details class="doc-table-toggle">
											<summary>{subsection.table.summary ?? 'Show table'}</summary>
											<p class="doc-table-caption">{@html subsection.table.caption}</p>
											<div class="doc-table-scroll">
												<table class="doc-table">
													<thead>
														<tr>
															{#each subsection.table.columns as column}
																<th>{@html column.label}</th>
															{/each}
														</tr>
													</thead>
													<tbody>
														{#each subsection.table.rows as row}
															<tr>
																{#each subsection.table.columns as column}
																	<td>{@html row[column.key]}</td>
																{/each}
															</tr>
														{/each}
													</tbody>
												</table>
											</div>
											{#if subsection.table.note}
												<p class="doc-table-note">{@html subsection.table.note}</p>
											{/if}
										</details>
									{:else}
										<p class="doc-table-caption">{@html subsection.table.caption}</p>
										<div class="doc-table-scroll">
											<table class="doc-table">
												<thead>
													<tr>
														{#each subsection.table.columns as column}
															<th>{@html column.label}</th>
														{/each}
													</tr>
												</thead>
												<tbody>
													{#each subsection.table.rows as row}
														<tr>
															{#each subsection.table.columns as column}
																<td>{@html row[column.key]}</td>
															{/each}
														</tr>
													{/each}
												</tbody>
											</table>
										</div>
										{#if subsection.table.note}
											<p class="doc-table-note">{@html subsection.table.note}</p>
										{/if}
									{/if}
								</div>
							{/if}

							{#if subsection.bullets}
								<ul class="notes">
									{#each subsection.bullets as bullet}
										<li>{@html bullet}</li>
									{/each}
								</ul>
							{/if}
						</section>
					{/each}

					{#if section.references.length}
						<p class="refs-inline">
							<strong>Primary references:</strong>
							{section.references.join('; ')}.
						</p>
					{/if}
				</section>
			{/each}

			<section id="bibliography" class="doc-card">
				<p class="section-label">Bibliography</p>
				<h2>Workflow source basis</h2>
				<p>
					The sources below are the principal references that frame the implemented Stage 1–5
					workflow. The chapter above states the implemented equations and rules explicitly;
					this bibliography makes the source families and adopted practice transparent.
				</p>
				{#each workflowReferenceGroups as group}
					<section class="doc-subsection">
						<h3>{group.title}</h3>
						<ul class="reference-list">
							{#each group.items as item}
								<li>
									<strong>{item.label}:</strong> {@html item.detail}
								</li>
							{/each}
						</ul>
					</section>
				{/each}
			</section>

			<section id="related" class="doc-card">
				<p class="section-label">Related chapters</p>
				<h2>Relation to the remaining manual</h2>
				<p>
					Once the interpretation chain is clear, the next route is
					<a href="/docs/engineering">Stage 6 engineering analyses</a>. The cross-cutting
					notation and global assumptions are collected in
					<a href="/docs/theory">Methods</a>. The
					<a href="/docs/full">technical specification</a> remains the longer implementation
					record that spans the full application.
				</p>
			</section>
		</main>
	</div>
</div>
