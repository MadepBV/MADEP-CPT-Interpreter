<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Deformation Analysis — MADEP CPT Interpreter';
	const pageDescription =
		'Full technical engineering chapter for the Stage 6 deformation analysis: scope, finite-element theory, geostatic initialization, Mohr-Coulomb theory, Stage 1 and Stage 2.1 constitutive routes, nonlinear solver architecture, outputs, corrections, limitations, and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/deformation';
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
				<a href="/docs/full#deformation-stage6">Specification anchor</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / deformation analysis</p>
			<h1>Stage 6 deformation analysis.</h1>
			<p class="hero__lead">
				The deformation module is the mechanical finite-element branch of the Stage 6 section
				model. It combines a linear geostatic preparation step with a plane-strain load solve,
				offers multiple constitutive routes from linear elastic through Stage 1 pseudo-plasticity
				to Stage 2.1 smoothed elastoplasticity, and exposes displacement, strain, stress,
				utilization, and plastic-strain fields on the shared mesh.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Deformation documentation navigation">
			<div class="docs-nav__title">Deformation</div>
			<a href="#positioning">Scope and positioning</a>
			<a href="#assumptions">Applicability and assumptions</a>
			<a href="#inputs">Input model</a>
			<a href="#fetheory">Finite-element theory</a>
			<a href="#elasticity">Elasticity model</a>
			<a href="#initial">Initial stress state</a>
			<a href="#mc">Mohr-Coulomb theory</a>
			<a href="#plasticity">Plasticity theory</a>
			<a href="#routes">Shipped constitutive routes</a>
			<a href="#solver">Solver architecture</a>
			<a href="#outputs">Outputs and interpretation</a>
			<a href="#corrections">Corrections and transparency</a>
			<a href="#verification">Verification and acceptance</a>
			<a href="#limits">Limitations and roadmap</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="positioning" class="doc-card">
				<p class="section-label">Scope and positioning</p>
				<h2>1. Problem class, public purpose, and non-scope</h2>
				<p>
					The public deformation route is a <strong>small-strain plane-strain finite-element
					analysis</strong> on the shared Stage 6 cross-section. Its intended engineering use is
					settlement screening, displacement-field interpretation, stress redistribution,
					strain-localization inspection, and diagnosis of the onset of Mohr-Coulomb yielding or
					plasticity beneath a terrain load interval.
				</p>
				<div class="doc-callout">
					<strong>Public model class.</strong> This is a section-based mechanical screening tool.
					It is not a full three-dimensional foundation analysis, not a large-deformation or
					updated-Lagrangian algorithm, not a coupled consolidation analysis, and not yet an exact
					classical face-edge-apex Mohr-Coulomb plasticity implementation.
				</div>
				<p>
					The development path matters. The deformation route began as an elastic Mohr-Coulomb
					screening tool, evolved into a Stage 1 reduced-stiffness pseudo-plastic route, and now
					ships with a Stage 2.1 <strong>smoothed elastoplastic</strong> constitutive option as the
					default solver. The documentation below therefore distinguishes carefully between:
				</p>
				<ul class="notes">
					<li><strong>underlying theory</strong>,</li>
					<li><strong>current shipped implementation</strong>, and</li>
					<li><strong>planned but not yet shipped exact Mohr-Coulomb extensions</strong>.</li>
				</ul>
				<div class="symbols">
					<div class="symbols__title">Primary field quantities</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>u = (u<sub>x</sub>, u<sub>y</sub>)</dt>
							<dd>Nodal displacement vector in the section plane.</dd>
						</div>
						<div class="symbols__row">
							<dt>|u|</dt>
							<dd>Total displacement magnitude.</dd>
						</div>
						<div class="symbols__row">
							<dt>ε = (ε<sub>xx</sub>, ε<sub>yy</sub>, γ<sub>xy</sub>)</dt>
							<dd>Plane-strain engineering strain vector.</dd>
						</div>
						<div class="symbols__row">
							<dt>σ, σ′</dt>
							<dd>Total and effective stress states, with compression-positive geotechnical sign convention in public engineering interpretation.</dd>
						</div>
						<div class="symbols__row">
							<dt>η<sub>MC</sub></dt>
							<dd>Pointwise Mohr-Coulomb utilization ratio.</dd>
						</div>
						<div class="symbols__row">
							<dt>ε̄<sup>p</sup><sub>acc</sub></dt>
							<dd>Accumulated equivalent plastic strain in the Stage 2.1 route.</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="assumptions" class="doc-card">
				<p class="section-label">Applicability and assumptions</p>
				<h2>2. Modelling assumptions that govern all results</h2>

				<section class="doc-subsection">
					<h3>2.1 Plane strain</h3>
					<p>
						The deformation route is formulated in <strong>plane strain</strong>. Out-of-plane
						strain is zero, while the out-of-plane stress is recovered through the constitutive
						law.
					</p>
					<div class="equations">
						<div class="formula">ε<sub>zz</sub> = γ<sub>yz</sub> = γ<sub>xz</sub> = 0</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>ε<sub>zz</sub></dt>
								<dd>out-of-plane normal strain [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>γ<sub>yz</sub>, γ<sub>xz</sub></dt>
								<dd>out-of-plane engineering shear strains [-]</dd>
							</div>
						</dl>
					</div>
					<p>
						This is appropriate for long strip-like loading, long embankment sections, or
						sections where out-of-plane variation is secondary. It is not a substitute for a true
						three-dimensional footing or excavation model.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>2.2 Small strain</h3>
					<p>
						The kinematics are small-strain. Geometry is not updated during the solve, and the
						result is interpreted on the original mesh. This is appropriate for serviceability
						screening and early plastic-zone development, but not for large deformation or
						post-failure runout.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>2.3 Effective-stress interpretation</h3>
					<p>
						The route is fundamentally a drained effective-stress screen. Initial pore pressure
						comes from either the seepage workspace or a hydrostatic phreatic-line reconstruction.
						The mechanical load step itself does <strong>not</strong> generate excess pore pressure.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>2.4 Engineering interpretation of the current route</h3>
					<ul class="notes">
						<li>Use it for long-term drained settlement and stress-screening questions.</li>
						<li>Use it for plastic-zone visualization and displacement trends.</li>
						<li>Do not read it as an undrained short-term clay model.</li>
						<li>Do not read Stage 2.1 plastic bands as a fully validated FEM failure surface in the PLAXIS sense.</li>
					</ul>
				</section>
			</section>

			<section id="inputs" class="doc-card">
				<p class="section-label">Input model</p>
				<h2>3. Geometry, materials, load model, supports, and mesh</h2>

				<section class="doc-subsection">
					<h3>3.1 Shared geometry</h3>
					<p>
						The deformation workspace reuses the Stage 6 section geometry rather than introducing
						a second modelling environment. The active terrain polyline, model base, lateral
						boundaries, soil polygons, retaining-wall geometry, seepage field, and measurement
						line all live in the same shared state.
					</p>
					<ul class="notes">
						<li>If custom polygons are disabled, the interpreted CPT layer column is extended laterally across the section.</li>
						<li>If custom polygons are enabled, those polygons define the deformation regions.</li>
						<li>The same mesh backbone is shared conceptually with seepage, even if the mechanical and hydraulic analyses are solved separately.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>3.2 Material parameters carried into deformation</h3>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>Parameter</th>
										<th>Engineering meaning</th>
										<th>Current use in the deformation route</th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<td>E<sub>mc</sub></td>
										<td>Representative Young modulus for the Mohr-Coulomb route.</td>
										<td>Elastic stiffness basis in all current constitutive branches.</td>
									</tr>
									<tr>
										<td>ν</td>
										<td>Elastic Poisson ratio.</td>
										<td>Used only in the constitutive stiffness law, with numerical capping for T3 plane strain.</td>
									</tr>
									<tr>
										<td>c′, φ′</td>
										<td>Effective cohesion and friction angle.</td>
										<td>Used in Mohr-Coulomb yield evaluation and constitutive branching.</td>
									</tr>
									<tr>
										<td>ψ</td>
										<td>Dilation angle.</td>
										<td>Used by Stage 2.1 through a non-associated plastic potential.</td>
									</tr>
									<tr>
										<td>K<sub>0,nc</sub></td>
										<td>At-rest effective stress ratio.</td>
										<td>Used for initial confinement reconstruction, not as a substitute for ν.</td>
									</tr>
									<tr>
										<td>γ, γ<sub>sat</sub></td>
										<td>Bulk unit weights above and below the phreatic line.</td>
										<td>Used in the geostatic gravity step.</td>
									</tr>
									<tr>
										<td>r<sub>shear</sub></td>
										<td>Reduced shear-stiffness factor for Stage 1 only.</td>
										<td>Used only in the reduced-stiffness pseudo-plastic branch.</td>
									</tr>
									<tr>
										<td>σ<sub>t,allow</sub></td>
										<td>Optional tensile allowance.</td>
										<td>Carried in the material set; current practical use remains conservative and mostly diagnostic.</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>3.3 Load model</h3>
					<p>
						The user defines a terrain interval and applies either a direct pressure or an
						equivalent pressure derived from total load and out-of-plane length:
					</p>
					<div class="equations">
						<div class="formula">q = q<sub>user</sub></div>
						<div class="formula">q = P / (B L<sub>out</sub>)</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>q, q<sub>user</sub></dt>
								<dd>applied vertical terrain pressure [kPa = kN/m²]</dd>
							</div>
							<div class="symbols__row">
								<dt>P</dt>
								<dd>total applied vertical load in the out-of-plane-loaded strip [kN]</dd>
							</div>
							<div class="symbols__row">
								<dt>B</dt>
								<dd>loaded width measured in the section plane [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>L<sub>out</sub></dt>
								<dd>out-of-plane loaded length used for pressure conversion [m]</dd>
							</div>
						</dl>
					</div>
					<p>
						The current public route applies this as a vertical traction on the terrain interval.
						It does not yet introduce a rigid structural slab, contact law, interface element, or
						a structural plate stiffness in the deformation solve itself.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>3.4 Support conditions and domain sizing</h3>
					<p>
						The standard screening supports are used on a truncated half-space:
					</p>
					<div class="equations">
						<div class="formula">u<sub>y</sub> = 0 on the base</div>
						<div class="formula">u<sub>x</sub> = 0 on the left and right boundaries</div>
					</div>
					<p>
						This is acceptable only if the domain is sufficiently wide and deep. The technical
						guidance used in the spec is to keep the lateral and vertical extents on the order of
						several load widths, with roughly five load widths as a practical first-pass target.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>3.5 Mesh model</h3>
					<p>
						The current route uses a constrained triangular mesh with three-node constant-strain
						triangles. Automatic meshing starts relatively coarse for first-pass user runs and can
						be manually refined where needed.
					</p>
					<ul class="notes">
						<li>Local load-edge refinement is important because stresses and strains concentrate there.</li>
						<li>Slope crests and geometry kinks can legitimately create high gradients and local plasticity.</li>
						<li>Because the element is T3, mesh convergence should be checked for sensitive problems.</li>
					</ul>
				</section>
			</section>

			<section id="fetheory" class="doc-card">
				<p class="section-label">Finite-element theory</p>
				<h2>4. Kinematics, Voigt notation, internal force, and tangent stiffness</h2>

				<section class="doc-subsection">
					<h3>4.1 Small-strain kinematics</h3>
					<div class="equations">
						<div class="formula">u = [u<sub>x</sub>, u<sub>y</sub>]<sup>T</sup></div>
						<div class="formula">ε<sub>xx</sub> = ∂u<sub>x</sub>/∂x</div>
						<div class="formula">ε<sub>yy</sub> = ∂u<sub>y</sub>/∂y</div>
						<div class="formula">γ<sub>xy</sub> = ∂u<sub>x</sub>/∂y + ∂u<sub>y</sub>/∂x</div>
					</div>
					<p>
						The plane-strain engineering strain vector used in the element formulation is:
					</p>
					<div class="equations">
						<div class="formula">ε<sub>voigt,2D</sub> = [ε<sub>xx</sub>, ε<sub>yy</sub>, γ<sub>xy</sub>]<sup>T</sup></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>u, u<sub>x</sub>, u<sub>y</sub></dt>
								<dd>displacement vector and its Cartesian components [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>ε<sub>xx</sub>, ε<sub>yy</sub></dt>
								<dd>normal strain components [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>γ<sub>xy</sub></dt>
								<dd>engineering shear strain component [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>x, y</dt>
								<dd>section coordinates [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>ε<sub>voigt,2D</sub></dt>
								<dd>plane-strain engineering strain vector [-]</dd>
							</div>
						</dl>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>4.2 Full 3D stress or strain state inside the constitutive core</h3>
					<p>
						Although the global FE kinematics are plane strain, the constitutive logic is
						organized around full six-component stress or strain vectors, because Mohr-Coulomb
						yielding and plastic flow are naturally formulated in principal stress space.
					</p>
					<div class="equations">
						<div class="formula">σ<sub>voigt</sub> = [σ<sub>xx</sub>, σ<sub>yy</sub>, σ<sub>zz</sub>, τ<sub>xy</sub>, τ<sub>yz</sub>, τ<sub>xz</sub>]<sup>T</sup></div>
						<div class="formula">ε<sub>voigt</sub> = [ε<sub>xx</sub>, ε<sub>yy</sub>, ε<sub>zz</sub>, γ<sub>xy</sub>, γ<sub>yz</sub>, γ<sub>xz</sub>]<sup>T</sup></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>σ<sub>xx</sub>, σ<sub>yy</sub>, σ<sub>zz</sub>, τ<sub>xy</sub>, τ<sub>yz</sub>, τ<sub>xz</sub></dt>
								<dd>Cartesian stress components [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>ε<sub>xx</sub>, ε<sub>yy</sub>, ε<sub>zz</sub>, γ<sub>xy</sub>, γ<sub>yz</sub>, γ<sub>xz</sub></dt>
								<dd>engineering strain components [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ<sub>voigt</sub>, ε<sub>voigt</sub></dt>
								<dd>full six-component stress and strain vectors</dd>
							</div>
						</dl>
					</div>
					<p>
						This distinction is important: the deformation route uses
						<strong>engineering shear strain</strong> in Voigt notation. Therefore stress-like,
						strain-like, and gradient-like quantities are not interchangeable under a naive
						mapping, and work-conjugate handling of the shear terms must remain explicit.
					</p>
					<div class="doc-callout">
						<strong>Implementation consequence.</strong> Yield and plastic-potential gradients are
						strain-like objects in engineering Voigt notation. Their shear components must carry
						the conjugate factor implied by engineering shear strain. This is one of the critical
						mathematical safeguards of the Stage 2 constitutive implementation.
					</div>
				</section>

				<section class="doc-subsection">
					<h3>4.3 Element strain-displacement and internal force</h3>
					<p>
						For a constant-strain triangle:
					</p>
					<div class="equations">
						<div class="formula">ε = B u<sub>e</sub></div>
						<div class="formula">F<sub>int</sub> = Σ ∫<sub>Ωe</sub> B<sup>T</sup> σ dΩ</div>
					</div>
					<p>
						The global residual equation is:
					</p>
					<div class="equations">
						<div class="formula">R(u) = F<sub>ext</sub> − F<sub>int</sub>(u) = 0</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>ε</dt>
								<dd>element strain vector [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>B</dt>
								<dd>strain-displacement matrix [1/m]</dd>
							</div>
							<div class="symbols__row">
								<dt>u<sub>e</sub></dt>
								<dd>element nodal displacement vector [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>F<sub>int</sub>, F<sub>ext</sub>, R</dt>
								<dd>internal force, external force, and residual vectors [kN/m]</dd>
							</div>
							<div class="symbols__row">
								<dt>Ω<sub>e</sub></dt>
								<dd>element area [m²]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ</dt>
								<dd>stress vector in the constitutive integration point [kPa]</dd>
							</div>
						</dl>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>4.4 Tangent stiffness</h3>
					<p>
						The consistent linearization of the global solve is expressed through the material
						tangent returned by the constitutive update:
					</p>
					<div class="equations">
						<div class="formula">K<sub>tan</sub> = Σ ∫<sub>Ωe</sub> B<sup>T</sup> D<sub>tan</sub> B dΩ</div>
						<div class="formula">K<sub>tan</sub> Δu = R</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>K<sub>tan</sub></dt>
								<dd>global tangent stiffness matrix [kN/m²] for unit out-of-plane width</dd>
							</div>
							<div class="symbols__row">
								<dt>D<sub>tan</sub></dt>
								<dd>material tangent matrix [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>Δu</dt>
								<dd>incremental nodal displacement correction [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>R</dt>
								<dd>global residual force vector [kN/m]</dd>
							</div>
						</dl>
					</div>
					<p>
						For linear elasticity, D<sub>tan</sub> = D<sup>e</sup>. For Stage 1, the tangent is
						either elastic or reduced-shear. For Stage 2.1, the tangent is an approximate
						elastoplastic tangent derived from the local return map.
					</p>
				</section>
			</section>

			<section id="elasticity" class="doc-card">
				<p class="section-label">Elasticity model</p>
				<h2>5. Elastic constants, plane strain, and the out-of-plane stress component</h2>

				<section class="doc-subsection">
					<h3>5.1 Isotropic elastic constants</h3>
					<div class="equations">
						<div class="formula">G = E / [2(1 + ν)]</div>
						<div class="formula">K = E / [3(1 − 2ν)]</div>
						<div class="formula">λ = K − 2G/3</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>E</dt>
								<dd>Young modulus used by the active constitutive branch [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>ν</dt>
								<dd>Poisson ratio [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>G</dt>
								<dd>shear modulus [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>K</dt>
								<dd>bulk modulus [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>λ</dt>
								<dd>Lamé first parameter [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						These constants control both the linear elastic constitutive branch and the elastic
						part of the plastic constitutive update.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>5.2 Full 3D elastic stress law</h3>
					<div class="equations">
						<div class="formula">σ′ = D<sup>e</sup> ε<sup>e</sup></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>σ′</dt>
								<dd>effective stress vector [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>D<sup>e</sup></dt>
								<dd>elastic constitutive matrix [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>ε<sup>e</sup></dt>
								<dd>elastic strain vector [-]</dd>
							</div>
						</dl>
					</div>
					<p>
						The full six-by-six isotropic elastic matrix is used inside the constitutive logic so
						that the out-of-plane normal stress is available for principal-stress evaluation and
						Mohr-Coulomb checking.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>5.3 Plane-strain stress closure</h3>
					<p>
						Because ε<sub>zz</sub> = 0 in plane strain, the elastic constitutive law generates an
						out-of-plane normal stress increment:
					</p>
					<div class="equations">
						<div class="formula">Δσ′<sub>zz</sub> = λ(Δε<sub>xx</sub> + Δε<sub>yy</sub>)</div>
						<div class="formula">σ′<sub>zz,n+1</sub> = σ′<sub>zz,n</sub> + Δσ′<sub>zz</sub></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>Δσ′<sub>zz</sub></dt>
								<dd>increment of out-of-plane effective stress [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>λ</dt>
								<dd>Lamé first parameter [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>Δε<sub>xx</sub>, Δε<sub>yy</sub></dt>
								<dd>increments of in-plane normal strain [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>zz,n</sub>, σ′<sub>zz,n+1</sub></dt>
								<dd>out-of-plane effective stress at the previous and updated states [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						The incremental form matters. The absolute zero-state shortcut
						σ′<sub>zz</sub> = ν(σ′<sub>xx</sub> + σ′<sub>yy</sub>) is not valid once an initial
						geostatic stress field exists and pore pressure has been subtracted.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>5.4 Near-incompressibility safeguard</h3>
					<p>
						The public route presently uses T3 triangles. These are robust and easy to audit, but
						they are not ideal for near-incompressible elasticity. Poisson’s ratio is therefore
						capped for numerical stability in the current implementation.
					</p>
					<div class="doc-callout doc-callout--warn">
						<strong>Transparency note.</strong> This cap is not a material law. It is a numerical
						safeguard for the current T3 plane-strain formulation.
					</div>
				</section>
			</section>

			<section id="initial" class="doc-card">
				<p class="section-label">Initial stress state</p>
				<h2>6. Geostatic gravity turn-on, pore pressure, and K<sub>0,nc</sub> confinement</h2>

				<section class="doc-subsection">
					<h3>6.1 Linear gravity turn-on</h3>
					<p>
						The initial stress field is obtained from a <strong>linear elastic gravity solve</strong>
						on the same mesh and the same support set used by the subsequent deformation analysis.
						This is deliberate: geostatic preparation remains linear, while yielding and plasticity
						belong to the later load solve.
					</p>
					<div class="equations">
						<div class="formula">K u<sub>geo</sub> = F<sub>g</sub></div>
						<div class="formula">f<sub>g,e</sub> = A γ<sub>bulk</sub> / 3 [0, −1, 0, −1, 0, −1]<sup>T</sup></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>K</dt>
								<dd>elastic global stiffness matrix for the geostatic step [kN/m²]</dd>
							</div>
							<div class="symbols__row">
								<dt>u<sub>geo</sub></dt>
								<dd>geostatic displacement vector [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>F<sub>g</sub>, f<sub>g,e</sub></dt>
								<dd>global and element gravity load vectors [kN/m]</dd>
							</div>
							<div class="symbols__row">
								<dt>A</dt>
								<dd>triangle area [m²]</dd>
							</div>
							<div class="symbols__row">
								<dt>γ<sub>bulk</sub></dt>
								<dd>bulk unit weight, dry or saturated according to water level [kN/m³]</dd>
							</div>
						</dl>
					</div>
					<p>
						This gives a geometry-driven total stress state including non-zero initial shear stress
						on slopes and near geometry breaks.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>6.2 Effective stress reconstruction</h3>
					<p>
						After the gravity step, pore pressure is subtracted from the normal total stress
						components only:
					</p>
					<div class="equations">
						<div class="formula">σ′<sub>0,6</sub> = σ<sub>0,6</sub> − u<sub>0</sub>[1, 1, 1, 0, 0, 0]<sup>T</sup></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>σ′<sub>0,6</sub></dt>
								<dd>initial six-component effective stress vector [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ<sub>0,6</sub></dt>
								<dd>initial six-component total stress vector from the gravity step [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>u<sub>0</sub></dt>
								<dd>initial pore pressure [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						Storing the full six-component effective stress state is a crucial correction in the
						current solver architecture. Earlier shortcuts that stored only
						σ′<sub>xx</sub>, σ′<sub>yy</sub>, and τ<sub>xy</sub> were not sufficient for a
						reliable plane-strain Mohr-Coulomb route.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>6.3 K<sub>0,nc</sub> controls initial confinement, not ν</h3>
					<p>
						The present public route makes a strict conceptual distinction:
					</p>
					<ul class="notes">
						<li><strong>K<sub>0,nc</sub></strong> controls the in-situ effective confinement state.</li>
						<li><strong>ν</strong> controls elastic stiffness during the load solve.</li>
					</ul>
					<p>
						This is important because allowing elastic ν to control initial confinement can make
						weak soils appear to “fail” everywhere under light load simply because the lateral
						stress state starts too low.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>6.4 Flat K<sub>0</sub> fallback</h3>
					<p>
						If the gravity step fails numerically, the solver falls back to a flat-ground
						K<sub>0</sub> reconstruction. That fallback still constructs the total stress state
						first and only then subtracts pore pressure, so the out-of-plane effective stress is
						not corrupted by direct subtraction on an already reduced 2D state.
					</p>
					<div class="equations">
						<div class="formula">σ′<sub>yy,0</sub> = σ′<sub>v0</sub></div>
						<div class="formula">σ′<sub>xx,0</sub> = K<sub>0</sub> σ′<sub>v0</sub></div>
						<div class="formula">σ<sub>zz,0</sub> = ν(σ<sub>xx,0</sub> + σ<sub>yy,0</sub>)</div>
						<div class="formula">σ′<sub>zz,0</sub> = σ<sub>zz,0</sub> − u<sub>0</sub></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>σ′<sub>v0</sub></dt>
								<dd>initial vertical effective stress [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>K<sub>0</sub></dt>
								<dd>at-rest lateral earth pressure ratio [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>xx,0</sub>, σ′<sub>yy,0</sub>, σ′<sub>zz,0</sub></dt>
								<dd>initial effective stress components [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ<sub>xx,0</sub>, σ<sub>yy,0</sub>, σ<sub>zz,0</sub></dt>
								<dd>initial total stress components [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>ν</dt>
								<dd>Poisson ratio used in the elastic total-stress reconstruction [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>u<sub>0</sub></dt>
								<dd>initial pore pressure [kPa]</dd>
							</div>
						</dl>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>6.5 Effective stress and load increment</h3>
					<p>
						The FE solve returns an incremental stress field in the solver sign convention. For
						public engineering interpretation, the increment is converted back to geotechnical
						compression-positive convention and interpreted as an effective stress increment:
					</p>
					<div class="equations">
						<div class="formula">Δσ′ = Δσ′<sub>FE</sub></div>
						<div class="formula">σ′ = σ′<sub>0</sub> + Δσ′</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>Δσ′, Δσ′<sub>FE</sub></dt>
								<dd>effective stress increment from the finite-element load step [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>0</sub></dt>
								<dd>initial effective stress state [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′</dt>
								<dd>final effective stress state after load increment [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						If a seepage result exists, its pore pressure field provides u<sub>0</sub>. Otherwise
						the phreatic line provides a hydrostatic reconstruction.
					</p>
				</section>
			</section>

			<section id="mc" class="doc-card">
				<p class="section-label">Mohr-Coulomb theory</p>
				<h2>7. Yield function, utilization ratio, and tension cut-off</h2>

				<section class="doc-subsection">
					<h3>7.1 Classical shear yield function</h3>
					<p>
						For compression-positive principal effective stresses
						σ′<sub>1</sub> ≥ σ′<sub>2</sub> ≥ σ′<sub>3</sub>, the Mohr-Coulomb shear yield
						function is written as:
					</p>
					<div class="equations">
						<div class="formula">f<sub>s</sub> = (σ′<sub>1</sub> − σ′<sub>3</sub>) − (σ′<sub>1</sub> + σ′<sub>3</sub>) sin φ′ − 2c′ cos φ′</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>f<sub>s</sub></dt>
								<dd>Mohr-Coulomb shear yield function value [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>1</sub>, σ′<sub>3</sub></dt>
								<dd>major and minor effective principal stresses [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>φ′</dt>
								<dd>effective friction angle [°]</dd>
							</div>
							<div class="symbols__row">
								<dt>c′</dt>
								<dd>effective cohesion [kPa]</dd>
							</div>
						</dl>
					</div>
					<ul class="notes">
						<li>f<sub>s</sub> &lt; 0: elastic admissibility.</li>
						<li>f<sub>s</sub> = 0: on the yield surface.</li>
						<li>f<sub>s</sub> &gt; 0: elastic trial stress exceeds Mohr-Coulomb strength.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>7.2 Principal stress evaluation</h3>
					<p>
						For the in-plane stress pair:
					</p>
					<div class="equations">
						<div class="formula">p = (σ′<sub>xx</sub> + σ′<sub>yy</sub>) / 2</div>
						<div class="formula">r = √(((σ′<sub>xx</sub> − σ′<sub>yy</sub>) / 2)² + τ′<sub>xy</sub>²)</div>
						<div class="formula">σ′<sub>1</sub> = p + r</div>
						<div class="formula">σ′<sub>3</sub> = p − r</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>σ′<sub>xx</sub>, σ′<sub>yy</sub>, τ′<sub>xy</sub></dt>
								<dd>in-plane effective normal and shear stresses [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>p</dt>
								<dd>mean in-plane effective stress used in the two-dimensional principal-stress reduction [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>r</dt>
								<dd>in-plane Mohr-circle radius [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>1</sub>, σ′<sub>3</sub></dt>
								<dd>major and minor effective principal stresses [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						The Stage 2 constitutive route itself uses the full six-component stress state in
						principal-stress evaluation. The simpler in-plane pair remains relevant for some
						screening and plotting interpretations.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>7.3 Utilization ratio</h3>
					<div class="equations">
						<div class="formula">η<sub>MC</sub> = (σ′<sub>1</sub> − σ′<sub>3</sub>) / [(σ′<sub>1</sub> + σ′<sub>3</sub>) sin φ′ + 2c′ cos φ′]</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>η<sub>MC</sub></dt>
								<dd>Mohr-Coulomb utilization ratio [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>1</sub>, σ′<sub>3</sub></dt>
								<dd>major and minor effective principal stresses [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>φ′</dt>
								<dd>effective friction angle [°]</dd>
							</div>
							<div class="symbols__row">
								<dt>c′</dt>
								<dd>effective cohesion [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						This is a <strong>local reserve indicator</strong>, not a global factor of safety.
						Its interpretation is:
					</p>
					<ul class="notes">
						<li>η<sub>MC</sub> &lt; 1: inside the envelope.</li>
						<li>η<sub>MC</sub> ≈ 1: near yield.</li>
						<li>η<sub>MC</sub> &gt; 1: trial stress exceeds Mohr-Coulomb strength.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>7.4 Tension cut-off</h3>
					<p>
						Classical Mohr-Coulomb can imply a tensile capacity that is unrealistic for soils.
						The natural diagnostic tension-cutoff condition is therefore:
					</p>
					<div class="equations">
						<div class="formula">f<sub>t</sub> = −σ′<sub>3</sub> − σ<sub>t</sub> ≤ 0</div>
						<div class="formula">σ<sub>t</sub> = 0 for zero tensile strength</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>f<sub>t</sub></dt>
								<dd>tension cut-off function value [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>3</sub></dt>
								<dd>minor effective principal stress [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ<sub>t</sub></dt>
								<dd>allowed tensile stress, commonly zero for soil [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						In the current public solver, tension cut-off is treated differently by route:
					</p>
					<ul class="notes">
						<li>In Stage 1 it is <strong>diagnostic-only</strong>; it does not activate the reduced-shear branch.</li>
						<li>In Stage 2.1 it remains part of the engineering interpretation boundary, but exact multisurface tension plasticity is not yet exposed as a separate public active yield surface.</li>
					</ul>
				</section>
			</section>

			<section id="plasticity" class="doc-card">
				<p class="section-label">Plasticity theory</p>
				<h2>8. Additive strain split, non-associated flow, and return mapping</h2>

				<section class="doc-subsection">
					<h3>8.1 Additive strain split</h3>
					<div class="equations">
						<div class="formula">ε = ε<sup>e</sup> + ε<sup>p</sup></div>
						<div class="formula">σ′ = D<sup>e</sup>(ε − ε<sup>p</sup>)</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>ε</dt>
								<dd>total strain vector [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>ε<sup>e</sup>, ε<sup>p</sup></dt>
								<dd>elastic and plastic strain vectors [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′</dt>
								<dd>effective stress vector [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>D<sup>e</sup></dt>
								<dd>elastic constitutive matrix [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						Only Stage 2 computes true plastic strain. Stage 1 is not true plasticity and must
						not be described as such.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>8.2 Non-associated plastic potential</h3>
					<p>
						Soils are typically modelled with non-associated flow:
					</p>
					<div class="equations">
						<div class="formula">ψ ≤ φ′</div>
						<div class="formula">g<sub>s</sub> = (σ′<sub>1</sub> − σ′<sub>3</sub>) − (σ′<sub>1</sub> + σ′<sub>3</sub>) sin ψ</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>ψ</dt>
								<dd>dilation angle [°]</dd>
							</div>
							<div class="symbols__row">
								<dt>φ′</dt>
								<dd>effective friction angle [°]</dd>
							</div>
							<div class="symbols__row">
								<dt>g<sub>s</sub></dt>
								<dd>plastic potential function for shear flow [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>1</sub>, σ′<sub>3</sub></dt>
								<dd>major and minor effective principal stresses [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						The Stage 2.1 route uses a smoothed equivalent of this logic so that the local return
						map remains robust and differentiable.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>8.3 Flow rule and Kuhn-Tucker conditions</h3>
					<div class="equations">
						<div class="formula">Δε<sup>p</sup> = Δλ ∂g/∂σ′ = Δλ m</div>
						<div class="formula">Δλ ≥ 0, f ≤ 0, Δλ f = 0</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>Δε<sup>p</sup></dt>
								<dd>plastic strain increment [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>Δλ</dt>
								<dd>plastic multiplier increment, with strain-like units in the present stress-based formulation [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>g</dt>
								<dd>plastic potential function [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′</dt>
								<dd>effective stress vector [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>m</dt>
								<dd>plastic flow direction in engineering Voigt notation [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>f</dt>
								<dd>active yield function value [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						These conditions define elastic loading, plastic loading, and unloading or reloading
						around a plastic state.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>8.4 Backward-Euler return mapping</h3>
					<p>
						The Stage 2 constitutive path follows the standard elastic predictor/plastic
						corrector structure:
					</p>
					<div class="equations">
						<div class="formula">σ′<sub>trial</sub> = σ′<sub>n</sub> + D<sup>e</sup> Δε</div>
						<div class="formula">if f(σ′<sub>trial</sub>) ≤ 0 → elastic update</div>
						<div class="formula">if f(σ′<sub>trial</sub>) &gt; 0 → plastic correction and tangent update</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>σ′<sub>trial</sub></dt>
								<dd>elastic trial effective stress [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>n</sub></dt>
								<dd>effective stress at the start of the increment [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>D<sup>e</sup></dt>
								<dd>elastic constitutive matrix [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>Δε</dt>
								<dd>total strain increment [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>f</dt>
								<dd>yield function value used for the admissibility check [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						In the current public Stage 2.1 route, this is implemented on a
						<strong>smoothed Mohr-Coulomb or Drucker-Prager-like surface</strong> as the
						recommended first true-plastic route. Exact classical face return, edge return, and
						apex handling belong to later stages.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>8.5 Equivalent plastic strain diagnostic</h3>
					<p>
						The public route reports an accumulated equivalent plastic strain for visualization
						and interpretation:
					</p>
					<div class="equations">
						<div class="formula">Δε̄<sup>p</sup> = √(2/3 · Δε<sup>p</sup><sub>dev</sub> : Δε<sup>p</sup><sub>dev</sub>)</div>
						<div class="formula">ε̄<sup>p</sup><sub>acc,n+1</sub> = ε̄<sup>p</sup><sub>acc,n</sub> + Δε̄<sup>p</sup></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>Δε̄<sup>p</sup></dt>
								<dd>increment of equivalent plastic strain [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>Δε<sup>p</sup><sub>dev</sub></dt>
								<dd>deviatoric plastic strain increment tensor or its work-conjugate Voigt form [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>ε̄<sup>p</sup><sub>acc,n</sub>, ε̄<sup>p</sup><sub>acc,n+1</sub></dt>
								<dd>accumulated equivalent plastic strain before and after the increment [-]</dd>
							</div>
						</dl>
					</div>
					<p>
						This is a diagnostic localization measure, not a direct serviceability quantity.
					</p>
				</section>
			</section>

			<section id="routes" class="doc-card">
				<p class="section-label">Shipped constitutive routes</p>
				<h2>9. Linear elastic, Stage 1 reduced stiffness, and Stage 2.1 elastoplasticity</h2>

				<section class="doc-subsection">
					<h3>9.1 Linear elastic route</h3>
					<p>
						The linear elastic route is the baseline regression and comparison path. It uses the
						same mesh, the same geostatic preparation, and the same load model, but keeps the
						constitutive law purely elastic.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>9.2 Stage 1 reduced-stiffness pseudo-plasticity</h3>
					<p>
						Stage 1 exists to make incremental loading mechanically meaningful before full
						plasticity. It is a <strong>pseudo-plastic</strong> route:
					</p>
					<ul class="notes">
						<li>Compute an elastic trial stress.</li>
						<li>Evaluate Mohr-Coulomb shear exceedance.</li>
						<li>If exceeded, recompute the increment with reduced shear stiffness.</li>
						<li>Do not return the stress exactly to the yield surface.</li>
						<li>Do not accumulate true plastic strain.</li>
					</ul>
					<div class="equations">
						<div class="formula">G<sub>red</sub> = r<sub>shear</sub> G</div>
						<div class="formula">D<sub>red</sub> = D(K, G<sub>red</sub>)</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>G<sub>red</sub></dt>
								<dd>reduced shear modulus used by Stage 1 [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>r<sub>shear</sub></dt>
								<dd>user- or soil-derived reduced-shear factor [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>G</dt>
								<dd>elastic shear modulus [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>D<sub>red</sub></dt>
								<dd>reduced Stage 1 constitutive tangent [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>K</dt>
								<dd>bulk modulus kept unchanged in the current Stage 1 route [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						The current shipped Stage 1 branch remains <strong>monotonic or sticky within a run</strong>:
						once an element exceeds Mohr-Coulomb shear during that loading sequence, it remains on
						the reduced branch for the rest of that run. That is a documented implementation fact,
						not an idealized theory claim.
					</p>
					<div class="doc-callout doc-callout--warn">
						<strong>Transparency rule.</strong> Stage 1 is not true plasticity. It should be read
						as a conservative reduced-stiffness hotspot screen, not as an exact elastoplastic
						material law.
					</div>
				</section>

				<section class="doc-subsection">
					<h3>9.3 Stage 2.1 smoothed elastoplasticity</h3>
					<p>
						Stage 2.1 is the current public default and the first true-plastic route:
					</p>
					<ul class="notes">
						<li>It stores material-point plastic strain.</li>
						<li>It uses a local return map on a smoothed Mohr-Coulomb style surface.</li>
						<li>It supports non-associated flow through ψ.</li>
						<li>It returns an approximate elastoplastic tangent to the global solve.</li>
					</ul>
					<p>
						What it is <strong>not</strong> yet:
					</p>
					<ul class="notes">
						<li>not exact classical face return,</li>
						<li>not edge or apex active-set return,</li>
						<li>not full multisurface tension-cutoff plasticity,</li>
						<li>not yet the final Mohr-Coulomb implementation envisioned by the full theory stack.</li>
					</ul>
					<div class="doc-callout">
						<strong>Current engineering reading.</strong> Stage 2.1 is the correct public default
						for a first true-plastic deformation route, but it remains a smoothed approximation of
						classical Mohr-Coulomb rather than the exact final formulation.
					</div>
				</section>
			</section>

			<section id="solver" class="doc-card">
				<p class="section-label">Solver architecture</p>
				<h2>10. Material-point state, residual solve, cutback, and partial near-failure states</h2>

				<section class="doc-subsection">
					<h3>10.1 Material-point state structure</h3>
					<p>
						The constitutive architecture uses committed and trial material-point state. This
						separates local constitutive updates from global equilibrium acceptance and supports:
					</p>
					<ul class="notes">
						<li>load stepping,</li>
						<li>commit or rollback,</li>
						<li>plastic strain accumulation only on accepted states,</li>
						<li>diagnostic comparison between displayed and committed states.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>10.2 Global nonlinear solve</h3>
					<p>
						The global solve is residual-based:
					</p>
					<div class="equations">
						<div class="formula">R(u) = F<sub>ext</sub> − F<sub>int</sub>(u)</div>
						<div class="formula">K<sub>tan</sub> Δu = R</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>R(u)</dt>
								<dd>global residual force vector as a function of the current displacement state [kN/m]</dd>
							</div>
							<div class="symbols__row">
								<dt>F<sub>ext</sub>, F<sub>int</sub></dt>
								<dd>external and internal nodal force vectors [kN/m]</dd>
							</div>
							<div class="symbols__row">
								<dt>K<sub>tan</sub></dt>
								<dd>global tangent stiffness matrix [kN/m²]</dd>
							</div>
							<div class="symbols__row">
								<dt>Δu</dt>
								<dd>Newton or quasi-Newton displacement correction [m]</dd>
							</div>
						</dl>
					</div>
					<p>
						Load stepping, line search, and cutback are used to keep the solve robust once
						plasticity activates.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>10.3 Convergence and cutback</h3>
					<p>
						The public route exposes solver settings for nonlinear iteration limits, tolerances,
						initial load step, minimum load step, growth factors, cutback factors, and the
						optional unsymmetric plastic path. These are solver controls, not soil parameters.
					</p>
					<ul class="notes">
						<li>Stage 2.1 can use cautious growth after first yield.</li>
						<li>Plastic line-search failure or exhausted nonlinear iterations trigger cutback.</li>
						<li>Elastic low-load cases are intentionally kept close to the linear baseline.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>10.4 Partial shown state near failure</h3>
					<p>
						If the nonlinear solve cannot fully converge but has already developed a physically
						meaningful near-failure state, the app now keeps and shows that best available state
						instead of discarding the entire run.
					</p>
					<div class="doc-callout doc-callout--warn">
						<strong>Interpretation rule.</strong> A partial shown state is qualitative. It is
						useful for plastic-zone visualization and trend diagnosis near failure, but it should
						not be read as a fully converged final equilibrium solution.
					</div>
				</section>
			</section>

			<section id="outputs" class="doc-card">
				<p class="section-label">Outputs and interpretation</p>
				<h2>11. Contours, probe quantities, and engineering meaning of the plotted fields</h2>

				<section class="doc-subsection">
					<h3>11.1 Contour and legend system</h3>
					<p>
						The deformation workspace now supports high-contrast contour fills, isolines, and an
						in-canvas legend. The legend is placed inside the canvas and can be collapsed
						vertically.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>11.2 Available displacement, strain, and stress fields</h3>
					<ul class="notes">
						<li>u<sub>x,fin</sub>, u<sub>y,fin</sub>, |u|<sub>fin</sub>, and settlement</li>
						<li>ε<sub>xx,fin</sub>, ε<sub>yy,fin</sub>, γ<sub>xy,fin</sub></li>
						<li>σ′<sub>xx,init</sub>, σ′<sub>xx,fin</sub>, σ<sub>xx,init</sub>, σ<sub>xx,fin</sub></li>
						<li>σ′<sub>yy,init</sub>, σ′<sub>yy,fin</sub>, σ<sub>yy,init</sub>, σ<sub>yy,fin</sub></li>
						<li>τ<sub>xy</sub></li>
						<li>η<sub>MC</sub> and ε̄<sup>p</sup><sub>acc</sub></li>
					</ul>
					<p>
						In the current effective-stress interpretation, pore pressure shifts only the normal
						stress components. Therefore τ<sub>xy</sub> does not split into separate total and
						effective shear views.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>11.3 Measurement line and line probe</h3>
					<p>
						The shared Stage 6 measurement line acts as a line probe in deformation. The graph
						and clipboard export follow the selected quantity and return distance-value data along
						the line.
					</p>
					<p>
						Because the line probe samples the solved field, missing parts of the line outside the
						domain are shown as gaps rather than invented values.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>11.4 Interpretation of η<sub>MC</sub> and ε̄<sup>p</sup><sub>acc</sub></h3>
					<ul class="notes">
						<li>η<sub>MC</sub> is a pointwise reserve or utilization ratio, not a global factor of safety.</li>
						<li>ε̄<sup>p</sup><sub>acc</sub> is a plastic-history localization diagnostic, not a direct serviceability value.</li>
						<li>A plastic band is not yet automatically equivalent to a validated global failure plane.</li>
					</ul>
				</section>
			</section>

			<section id="corrections" class="doc-card">
				<p class="section-label">Corrections and transparency</p>
				<h2>12. Implemented solver corrections and public interpretation</h2>

				<section class="doc-subsection">
					<h3>12.1 Initial effective stress is stored as full stress<sub>6</sub></h3>
					<p>
						A major correctness fix in the current solver lineage was to stop storing only the
						in-plane effective stress components for the initial state. The public route now
						carries the full six-component effective stress vector through material-point seeding.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>12.2 K<sub>0,nc</sub> versus ν was separated explicitly</h3>
					<p>
						The current public route now uses K<sub>0,nc</sub> for initial in-situ confinement
						and ν for elastic stiffness. This correction was necessary because using ν to control
						the initial lateral stress state can produce unrealistic blanket yielding in weak
						soils under light loading.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>12.3 Stage 1 tension cut-off is diagnostic-only</h3>
					<p>
						Another important correction was to remove tension cut-off from Stage 1 reduced-shear
						activation. Stage 1 now interprets:
					</p>
					<ul class="notes">
						<li><strong>MC-active zone</strong> as a reduced-shear pseudo-plastic branch,</li>
						<li><strong>tension zone</strong> as a warning or diagnostic condition.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>12.4 Stage 1 is still monotonic, not the ideal reversible active set</h3>
					<p>
						The correction plan for Stage 1 identified the mathematically cleaner final target as
						a reversible active-set problem. That is important theory, but it is not yet the
						shipped public behavior. The current public Stage 1 branch remains monotonic within a
						run for robustness.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>12.5 Stage 2.1 is true plasticity, but still approximate</h3>
					<p>
						The current public default Stage 2.1 computes true plastic strain and performs a
						local return map, but it does so on a smoothed surface with an approximate
						elastoplastic tangent. It is therefore a real constitutive advance over Stage 1, but
						not yet the final exact Mohr-Coulomb implementation.
					</p>
				</section>
			</section>

			<section id="verification" class="doc-card">
				<p class="section-label">Verification and acceptance</p>
				<h2>13. Test philosophy, benchmark classes, and acceptance logic</h2>
				<p>
					The technical deformation stack is verified at three levels:
				</p>
				<ul class="notes">
					<li><strong>unit level</strong>: yield-function evaluation, Voigt work conjugacy, plane-strain stress handling, commit or rollback, and local return mapping;</li>
					<li><strong>element level</strong>: patch tests and stress-recovery sanity checks;</li>
					<li><strong>boundary-value level</strong>: loaded strip, settlement trend, symmetry, seepage coupling, geostatic slope initialization, unload or reload around a plastic state, and plastic slope or footing benchmarks.</li>
				</ul>
				<p>
					For Stage 2.1, the important practical acceptance criteria are:
				</p>
				<ul class="notes">
					<li>elastic cases regress to the linear baseline,</li>
					<li>plastic strain accumulates only in the Stage 2 route,</li>
					<li>unload or reload around a plastic state behaves elastically,</li>
					<li>the local return map drives the smoothed yield residual back inside tolerance,</li>
					<li>global plastic footing and slope cases converge or produce an explicitly flagged partial shown state.</li>
				</ul>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Limitations and roadmap</p>
				<h2>14. Important current limits and natural next extensions</h2>

				<section class="doc-subsection">
					<h3>14.1 Important present limits</h3>
					<ul class="notes">
						<li>Section-based plane strain only.</li>
						<li>Small-strain kinematics only.</li>
						<li>T3 triangle formulation, with the usual limitations for bending-dominated and near-incompressible cases.</li>
						<li>Drained effective-stress loading step only; no coupled excess pore-pressure generation.</li>
						<li>Stage 2.1 smoothed Mohr-Coulomb only; exact face-edge-apex return is not yet public.</li>
						<li>Tension cut-off plasticity is not yet a full public multisurface branch.</li>
						<li>The deformation route is not yet a strength-reduction FEM driver.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>14.2 Natural next steps</h3>
					<ul class="notes">
						<li>Stage 2.2 exact Mohr-Coulomb face return.</li>
						<li>Stage 2.3 edge and apex active-set return.</li>
						<li>Stage 2.4 explicit tension-cutoff plasticity.</li>
						<li>Optional c-φ strength reduction as a separate analysis driver.</li>
						<li>A Hardening Soil style deformation route for better serviceability realism.</li>
						<li>More advanced hydro-mechanical coupling in later development phases.</li>
					</ul>
				</section>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>15. Theory and source basis</h2>
				<ul class="notes">
					<li>Zienkiewicz, Taylor, and Zhu — The Finite Element Method</li>
					<li>de Souza Neto, Perić, and Owen — Computational Methods for Plasticity</li>
					<li>Sloan, Abbo, and related Mohr-Coulomb return-mapping literature</li>
					<li>PLAXIS Material Models Manual</li>
					<li>Schanz, Vermeer &amp; Bonnier (1999)</li>
					<li>Bishop (1955) and Spencer (1967) for the coupled Stage 6 stability context</li>
					<li>The current app-specific technical stack consolidated from the Mohr-Coulomb deformation specification, the plasticity implementation specification, and the Stage 1 correction plan</li>
				</ul>
				<p>
					The long-form audit trail remains available in the
					<a href="/docs/full#deformation-stage6">technical specification</a>, but the public
					chapter above is intended to carry the actual theory and engineering interpretation of
					the shipped deformation route rather than only a short summary.
				</p>
			</section>
		</main>
	</div>
</div>
