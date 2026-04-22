<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Methods, Formulations, and Assumptions — MADEP CPT Interpreter';
	const pageDescription =
		'Cross-cutting technical methods for the MADEP CPT Interpreter: shared notation, governing equations, constitutive and hydraulic formulations, and declared modelling assumptions.';
	const canonicalUrl = 'https://cpt.madep.be/docs/theory';
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
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Methods, formulations, and assumptions</p>
			<h1>Shared notation, governing equations, and modelling assumptions.</h1>
			<p class="hero__lead">
				This chapter records the mathematical structure that is shared across the public
				manual: notation, sign conventions, hydraulic and mechanical governing equations,
				CPT-to-parameter relations, and the numerical assumptions that define the public
				solver routes.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Methods documentation navigation">
			<div class="docs-nav__title">Methods</div>
			<a href="#overview">Scope and structure</a>
			<a href="#conventions">Conventions and notation</a>
			<a href="#classification">Classification and parameter logic</a>
			<a href="#seepage">Seepage formulation</a>
			<a href="#deformation">Deformation formulation</a>
			<a href="#numerics">Numerical assumptions</a>
			<a href="#references">Source basis</a>
		</aside>

		<main class="docs-content">
			<section id="overview" class="doc-card">
				<p class="section-label">Scope</p>
				<h2>1. Scope, role, and document structure</h2>
				<p>
					This chapter consolidates the equations, conventions, and declared modelling
					assumptions that recur across the interpretation workflow and the Stage 6 engineering
					analyses. Its purpose is to make the mathematical basis of the public routes explicit,
					consistent, and auditable.
				</p>
				<ul class="notes">
					<li><strong>Interpretation</strong> documents how Stages 1 to 5 derive the engineering layer model from the CPT record.</li>
					<li><strong>Stage 6</strong> documents the individual engineering analyses and the interpretation of their outputs.</li>
					<li><strong>Methods</strong> records the shared theoretical framework used by those routes.</li>
					<li><strong>References</strong> records the standards, literature, and traceability basis.</li>
				</ul>
			</section>

			<section id="conventions" class="doc-card">
				<p class="section-label">Conventions and notation</p>
				<h2>2. Shared sign, stress, kinematic, and hydraulic conventions</h2>

				<section class="doc-subsection">
					<h3>2.1 Effective stress convention</h3>
					<p>
						The engineering modules follow a geotechnical effective-stress interpretation. In
						the theory, compression-positive effective stress is the most natural convention for
						Mohr-Coulomb evaluation and geostatic interpretation:
					</p>
					<div class="equations">
						<div class="formula">σ′ = σ − u I</div>
					</div>
					<p>
						Only the normal stress components are shifted by pore pressure. This becomes
						important in the deformation route, where normal total and effective stresses are
						distinguished while the shear stress component is unaffected by pore pressure.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>2.2 Hydraulic head convention</h3>
					<p>
						The seepage route solves for total head, from which pore pressure is derived:
					</p>
					<div class="equations">
						<div class="formula">h = y + u / γ<sub>w</sub></div>
						<div class="formula">u = γ<sub>w</sub>(h − y)</div>
					</div>
					<p>
						This convention is consistent with the current Stage 6 seepage and coupling logic.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>2.3 Plane strain and small strain</h3>
					<p>
						The public deformation route uses plane strain on a two-dimensional section and
						assumes small strain:
					</p>
					<div class="equations">
						<div class="formula">ε<sub>zz</sub> = 0</div>
					</div>
					<p>
						The geometry is therefore not updated during the current equilibrium iterations.
					</p>
				</section>
			</section>

			<section id="classification" class="doc-card">
				<p class="section-label">Classification and parameter logic</p>
				<h2>3. CPT-derived classification and parameter derivation</h2>

				<section class="doc-subsection">
					<h3>3.1 Raw CPT quantities</h3>
					<p>
						The interpretation chain starts from depth, cone resistance, sleeve friction, and
						optionally pore pressure. The friction ratio is central enough to record here:
					</p>
					<div class="equations">
						<div class="formula">R<sub>f</sub> = |f<sub>s</sub>| / q<sub>c</sub> · 100</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>3.2 Classification is not parameter assignment</h3>
					<p>
						This is one of the most important design choices in the app. Robertson, CUR, NEN
						6740, and NEN Tabel 3 all appear in the workflow, but they do not all serve the
						same purpose. The classification stage creates a rationalized soil interpretation;
						the parameter stage maps the final layer to engineering properties.
					</p>
					<div class="doc-callout">
						<strong>Important.</strong> A behavioural classification route and an engineering
						parameter route are not the same thing. The app keeps those steps separate on
						purpose so the engineer can understand and override them independently.
					</div>
				</section>

				<section class="doc-subsection">
					<h3>3.3 CPT-based stiffness route</h3>
					<p>
						The representative constrained modulus route is central to the Stage 4 parameter
						model:
					</p>
					<div class="equations">
						<div class="formula">E<sub>oed,i</sub> = α<sub>E</sub> q<sub>c</sub></div>
						<div class="formula">E<sub>oed,ref</sub> = E<sub>oed,i</sub> / ratio<sup>m</sup></div>
					</div>
					<p>
						The coefficient <strong>α<sub>E</sub></strong> comes from the selected Sanglerat or
						SB260-style route. The exponent <strong>m</strong> comes from the Hardening Soil
						style stress-dependency framework. Downstream, the app derives the stiffness family
						<strong>E<sub>oed</sub></strong>, <strong>E<sub>50</sub></strong>, and
						<strong>E<sub>ur</sub></strong> from that reference basis according to the selected
						method.
					</p>
				</section>
			</section>

			<section id="seepage" class="doc-card">
				<p class="section-label">Seepage formulation</p>
				<h2>4. Darcy-flow model on the shared Stage 6 section</h2>

				<section class="doc-subsection">
					<h3>4.1 Governing PDE</h3>
					<p>
						The seepage route is a steady-state saturated-flow problem:
					</p>
					<div class="equations">
						<div class="formula">q = −k ∇h</div>
						<div class="formula">∇ · (k ∇h) = 0</div>
					</div>
					<p>
						For isotropic homogeneous soil this reduces to Laplace’s equation. In the app, the
						heterogeneous anisotropic form is preserved because material zones carry their own
						conductivity values.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>4.2 Boundary classes</h3>
					<p>
						The public seepage route distinguishes prescribed head, no-flow, and seepage-face
						boundaries. In the current workflow these are applied to the outer section boundary
						rather than arbitrary interior edges.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>4.3 Free-surface interpretation</h3>
					<p>
						Unconfined flow is nonlinear because the active saturated domain is itself part of
						the solution. The current public route therefore uses an iterative free-surface /
						seepage-face interpretation rather than a one-shot confined-flow solve.
					</p>
				</section>
			</section>

			<section id="deformation" class="doc-card">
				<p class="section-label">Deformation formulation</p>
				<h2>5. Plane-strain FE equilibrium and constitutive branching</h2>

				<section class="doc-subsection">
					<h3>5.1 Global equilibrium</h3>
					<p>
						The deformation route is written in residual form:
					</p>
					<div class="equations">
						<div class="formula">R(u) = F<sub>ext</sub> − F<sub>int</sub>(u) = 0</div>
						<div class="formula">F<sub>int</sub> = ∑<sub>e</sub> ∫<sub>Ωe</sub> B<sup>T</sup> σ′ dΩ</div>
						<div class="formula">K<sub>tan</sub> Δu = R</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>5.2 Geostatic preparation</h3>
					<p>
						The initial stress state is prepared by a linear gravity step. This is an important
						explicit modeling choice: geostatic initialization stays linear, while yielding and
						plasticity are reserved for the subsequent load solve.
					</p>
					<div class="equations">
						<div class="formula">K u<sub>geo</sub> = F<sub>g</sub></div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>5.3 Constitutive staging</h3>
					<p>
						The current public deformation route supports three constitutive interpretations:
					</p>
					<ul class="notes">
						<li><strong>Linear elastic</strong> for baseline screening.</li>
						<li><strong>Stage 1 reduced stiffness</strong> as a pseudo-plastic exceedance route.</li>
						<li><strong>Stage 2.1 smoothed elastoplasticity</strong> as the current default plastic route.</li>
					</ul>
					<p>
						Stage 2.1 already stores plastic strain, but it is intentionally documented as a
						smoothed intermediate constitutive stage rather than the final exact
						face-edge-apex Mohr-Coulomb return.
					</p>
				</section>
			</section>

			<section id="numerics" class="doc-card">
				<p class="section-label">Numerical assumptions</p>
				<h2>6. Declared numerical approximations and modelling boundaries</h2>
				<p>
					The public routes are intended to be auditable engineering tools rather than opaque
					black-box solvers. The numerical choices listed below are therefore stated explicitly
					as part of the documented model definition.
				</p>
				<ul class="notes">
					<li>The shared seepage and deformation meshes use three-node constant-strain triangles.</li>
					<li>The deformation route caps high ν values for plane-strain stability and warns about T3 locking and coarse-mesh over-stiffness.</li>
					<li>The seepage route is steady-state only and keeps interior drains outside the current public boundary-condition set.</li>
					<li>The deformation route can expose a partial near-failure state rather than discarding the best available non-converged plastic result.</li>
					<li>The current Stage 2.1 constitutive route is smoothed and approximate by design; exact return-mapping is documented as the next constitutive stage rather than implied to exist already.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">Source basis</p>
				<h2>7. Principal source families and standards basis</h2>
				<ul class="reference-list">
					<li><strong>Robertson (1990, 2016)</strong> and <strong>Robertson &amp; Wride (1998)</strong> for CPT-based soil-behaviour interpretation.</li>
					<li><strong>NEN 6740</strong> and <strong>NEN Tabel 3</strong> for stress-corrected classification and characteristic subtype mapping.</li>
					<li><strong>SB260</strong>, <strong>Sanglerat</strong>, and <strong>CUR 2003-7</strong> for CPT-to-stiffness correlation and Hardening Soil style parameter families.</li>
					<li><strong>PLAXIS Material Models manuals</strong> for constitutive conventions and export interpretation.</li>
					<li><strong>Darcy flow and standard seepage FEM theory</strong> for the hydraulic module.</li>
					<li><strong>Classical small-strain FE equilibrium and Mohr-Coulomb plasticity theory</strong> for the deformation route.</li>
				</ul>
				<p class="refs-inline">
					For the complete citation list and route-specific implementation anchors, continue to
					<a href="/docs/reference">standards and references</a> or the
					<a href="/docs/full#references">technical specification</a>.
				</p>
			</section>
		</main>
	</div>
</div>
