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
			<a href="#voigt">Voigt notation and elastic matrix</a>
			<a href="#classification">Classification and parameter logic</a>
			<a href="#seepage">Seepage formulation</a>
			<a href="#deformation">Deformation formulation</a>
			<a href="#mc">Mohr-Coulomb yield theory</a>
			<a href="#tension">Tension cut-off</a>
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

			<section id="voigt" class="doc-card">
				<p class="section-label">Voigt notation</p>
				<h2>3. Voigt-6 stress, strain, and elastic matrix</h2>
				<section class="doc-subsection">
					<h3>3.1 Vector convention and engineering shear</h3>
					<p>
						All six-component tensor quantities in the deformation route use the Voigt-6
						convention with engineering shear strain (γ = 2ε). The order is [xx, yy, zz, xy, yz,
						zx] for stress and strain; the engineering shear factor lets the stress-strain
						relation read linearly as σ = D ε in the shear block.
					</p>
					<div class="equations">
						<div class="formula">σ = [σ<sub>xx</sub>, σ<sub>yy</sub>, σ<sub>zz</sub>, τ<sub>xy</sub>, τ<sub>yz</sub>, τ<sub>zx</sub>]<sup>T</sup></div>
						<div class="formula">ε = [ε<sub>xx</sub>, ε<sub>yy</sub>, ε<sub>zz</sub>, γ<sub>xy</sub>, γ<sub>yz</sub>, γ<sub>zx</sub>]<sup>T</sup>,   γ<sub>ij</sub> = 2 ε<sub>ij</sub><sup>tensor</sup></div>
						<div class="formula">σ : ε = σ<sub>xx</sub>ε<sub>xx</sub> + σ<sub>yy</sub>ε<sub>yy</sub> + σ<sub>zz</sub>ε<sub>zz</sub> + τ<sub>xy</sub>γ<sub>xy</sub> + τ<sub>yz</sub>γ<sub>yz</sub> + τ<sub>zx</sub>γ<sub>zx</sub></div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>3.2 Isotropic linear-elastic stiffness</h3>
					<div class="equations">
						<div class="formula">D<sub>e</sub> = λ ι<sub>6</sub>ι<sub>6</sub><sup>T</sup> + 2G I<sub>6</sub>     (with ι<sub>6</sub> = [1,1,1,0,0,0]<sup>T</sup>, I<sub>6</sub> the Voigt identity with the half-factor on shear)</div>
						<div class="formula">λ = E ν / [(1+ν)(1−2ν)],   G = E / [2(1+ν)]</div>
						<div class="formula">In block form, with engineering shear:</div>
						<div class="formula">D<sub>e</sub> = [[λ+2G, λ, λ; λ, λ+2G, λ; λ, λ, λ+2G] ⊕ G·diag(1,1,1)]</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>3.3 Plane-strain reduction</h3>
					<p>
						For plane strain ε<sub>zz</sub> = γ<sub>yz</sub> = γ<sub>zx</sub> = 0. The reduced 3×3
						elastic matrix, acting on plane strains [ε<sub>xx</sub>, ε<sub>yy</sub>, γ<sub>xy</sub>],
						is the xx/yy/xy block of D<sub>e</sub>:
					</p>
					<div class="equations">
						<div class="formula">D<sub>2D</sub> = (E / [(1+ν)(1−2ν)]) · [[1−ν, ν, 0; ν, 1−ν, 0; 0, 0, (1−2ν)/2]]</div>
					</div>
					<p>
						The out-of-plane effective stress σ′<sub>zz</sub> is not constrained to a single elastic
						closed form in plastic runs: σ′<sub>zz</sub> becomes an internal state variable and its
						K<sub>0</sub>-controlled initialization is preserved through the Stage 2 return map.
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
						The initial stress state is prepared by a linear gravity step and a
						K<sub>0,nc</sub>-controlled confinement reconstruction. Optionally, the seeded
						predictor may then be corrected by a plastic self-weight equilibration phase before
						the service-load step starts.
					</p>
					<div class="equations">
						<div class="formula">K u<sub>geo</sub> = F<sub>g</sub></div>
						<div class="formula">R<sub>0b</sub>(Δu) = F<sub>g</sub> - F<sub>int</sub>(σ′<sub>pred</sub> + Δσ′(Δu, history)) = 0</div>
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
						<li><strong>Stage 2 exact Mohr-Coulomb elastoplasticity</strong> as the current default plastic route.</li>
					</ul>
					<p>
						The shipped Stage 2 route stores plastic strain and uses an exact Mohr-Coulomb
						active-set return with shear face, shear edge, apex, tension-face, mixed
						shear-tension, and triple tension-point branches in principal effective stress
						space.
					</p>
				</section>
			</section>

			<section id="mc" class="doc-card">
				<p class="section-label">Mohr-Coulomb yield theory</p>
				<h2>6. Mohr-Coulomb yield function, flow rule, and algorithmic tangent</h2>
				<section class="doc-subsection">
					<h3>6.1 Yield function in principal stress space</h3>
					<p>
						Using compression-positive effective principal stresses ordered σ<sub>1</sub> ≥
						σ<sub>2</sub> ≥ σ<sub>3</sub>, the Mohr-Coulomb criterion in its critical form reads:
					</p>
					<div class="equations">
						<div class="formula">F(σ) = (σ<sub>1</sub> − σ<sub>3</sub>) − (σ<sub>1</sub> + σ<sub>3</sub>) sin φ′ − 2 c′ cos φ′ ≤ 0</div>
						<div class="formula">Equivalent: (1 − sin φ′) σ<sub>1</sub> − (1 + sin φ′) σ<sub>3</sub> − 2 c′ cos φ′ ≤ 0</div>
						<div class="formula">Apex location (hydrostatic tensile corner): p<sub>apex</sub> = c′ cot φ′</div>
					</div>
					<p>
						For the exact multisurface treatment, three pair-wise surfaces F<sub>ij</sub> (index
						pair ij ∈ &#123;12, 13, 23&#125;) are retained simultaneously. F<sub>13</sub> governs
						on the ordered face; F<sub>12</sub> and F<sub>23</sub> pick up the σ<sub>1</sub>=σ<sub>2</sub>
						and σ<sub>2</sub>=σ<sub>3</sub> edges respectively.
					</p>
					<div class="equations">
						<div class="formula">F<sub>ij</sub>(σ) = (1 − sin φ′) σ<sub>i</sub> − (1 + sin φ′) σ<sub>j</sub> − 2 c′ cos φ′</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>6.2 Non-associated flow rule</h3>
					<p>
						Plastic flow follows a plastic potential G built with the dilatancy angle ψ′ ≤ φ′.
						The flow is non-associated when ψ′ ≠ φ′; for dilatant soils ψ′ &gt; 0 introduces a
						volumetric plastic strain component.
					</p>
					<div class="equations">
						<div class="formula">G<sub>ij</sub>(σ) = (1 − sin ψ′) σ<sub>i</sub> − (1 + sin ψ′) σ<sub>j</sub> − const</div>
						<div class="formula">dε<sup>p</sup> = dλ ∂G/∂σ   (flow rule)</div>
						<div class="formula">n<sub>ij</sub> = ∂F<sub>ij</sub>/∂σ,    m<sub>ij</sub> = ∂G<sub>ij</sub>/∂σ</div>
						<div class="formula">Associated case: n<sub>ij</sub> = m<sub>ij</sub>,   ψ′ = φ′</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>6.3 Return mapping and algorithmic tangent</h3>
					<p>
						Because F is piecewise linear in stress, the return map closes in a single linear
						step on each active branch. The return equation and the algorithmic consistent tangent
						follow the Simo–Taylor form:
					</p>
					<div class="equations">
						<div class="formula">σ<sub>ret</sub> = σ<sub>trial</sub> − D<sub>e</sub> Σ<sub>i</sub> λ<sub>i</sub> m<sub>i</sub></div>
						<div class="formula">C<sub>ij</sub> = n<sub>i</sub><sup>T</sup> D<sub>e</sub> m<sub>j</sub>    (coupling matrix; unsymmetric for ψ ≠ φ)</div>
						<div class="formula">C λ = F(σ<sub>trial</sub>)    ⇒    λ = C<sup>-1</sup> F(σ<sub>trial</sub>)</div>
						<div class="formula">D<sub>ep</sub> = D<sub>e</sub> − Σ<sub>i,j</sub> (D<sub>e</sub> m<sub>i</sub>) (C<sup>-1</sup>)<sub>ij</sub> (D<sub>e</sub> n<sub>j</sub>)<sup>T</sup></div>
					</div>
					<p>
						The unsymmetric D<sub>ep</sub> is preserved by default in the shipped Stage 2 route.
						Symmetrization is offered as a convenience option but is theoretically a projection
						and loses accuracy on active-set transitions.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>6.4 Strength reduction (c-φ reduction)</h3>
					<p>
						The safety-by-c-φ-reduction route divides the strength parameters by a common
						multiplier Σ<sub>Msf</sub> and searches for the critical value at which equilibrium
						fails to close:
					</p>
					<div class="equations">
						<div class="formula">c′<sub>r</sub> = c′ / Σ<sub>Msf</sub>,    tan φ′<sub>r</sub> = tan φ′ / Σ<sub>Msf</sub></div>
						<div class="formula">tan ψ′<sub>r</sub> = tan ψ′ / Σ<sub>Msf</sub>,   σ<sub>t,r</sub> = σ<sub>t</sub> / Σ<sub>Msf</sub></div>
						<div class="formula">Apex invariant: c′<sub>r</sub> cot φ′<sub>r</sub> = c′ cot φ′ (the apex does not move under reduction)</div>
						<div class="formula">Constraints: ψ′<sub>r</sub> ≤ φ′<sub>r</sub>,    σ<sub>t,r</sub> ≤ c′<sub>r</sub> / tan φ′<sub>r</sub></div>
						<div class="formula">Factor of safety:  F<sub>s</sub> = Σ<sub>Msf, critical</sub></div>
					</div>
					<p>
						Reported factor of safety is the highest converged lower bound. The upper bound (first
						non-converging multiplier) and the bracket are reported alongside so the engineer can
						judge the numerical uncertainty on the critical state.
					</p>
				</section>
			</section>

			<section id="tension" class="doc-card">
				<p class="section-label">Tension cut-off</p>
				<h2>7. Tension cut-off, apex corners, and mixed branches</h2>
				<p>
					The Mohr-Coulomb surface by itself admits unlimited tensile strength once the apex
					cot(φ) fixes the hydrostatic corner. Real soils exhibit a finite tensile strength
					σ<sub>t</sub>. The tension cut-off is a supplementary surface active in the tensile
					region of principal stress space.
				</p>
				<div class="equations">
					<div class="formula">T<sub>i</sub>(σ) = −σ<sub>i</sub> − σ<sub>t</sub> ≤ 0    (per principal direction)</div>
					<div class="formula">Ordered form (σ<sub>3</sub> = least compressive):  T<sub>3</sub> = −σ<sub>3</sub> − σ<sub>t</sub> ≤ 0</div>
					<div class="formula">Apex invariant: σ<sub>t</sub> ≤ c′ / tan φ′ (cut-off cannot exceed MC apex)</div>
				</div>
				<p>
					The app's Stage 2 constitutive branch set covers the tension cut-off in combination
					with MC shear. The return map distinguishes:
				</p>
				<ul class="notes">
					<li>Pure shear branches: F<sub>13</sub> alone (face), F<sub>12</sub>+F<sub>13</sub> and F<sub>13</sub>+F<sub>23</sub> (edges), and the triple-shear apex branch.</li>
					<li>Pure tension branches: T<sub>3</sub> (face), T<sub>2</sub>+T<sub>3</sub> (edge at σ<sub>2</sub>=σ<sub>3</sub> cut-off), T<sub>1</sub>+T<sub>2</sub>+T<sub>3</sub> (hydrostatic tension apex).</li>
					<li>Mixed branches: F<sub>13</sub>+T<sub>3</sub> (edge), plus the lower and upper mixed shear-tension corners where one shear surface and the tension cut-off coincide.</li>
				</ul>
				<p>
					Each branch solves a linear system whose size equals the number of active surfaces; the
					active-set selection is driven by stress-gap and complementarity tolerances chosen
					relative to the local stress scale.
				</p>
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
					<li>The current Stage 2 constitutive route is an exact Mohr-Coulomb active-set return in principal stress space, including tension-cutoff branches.</li>
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
