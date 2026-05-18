<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';

	const pageTitle = 'Deformation Analysis — MADEP CPT Interpreter';
	const pageDescription =
		'Full technical engineering chapter for the Stage 6 deformation analysis: plane-strain finite-element theory, geostatic initialization, exact Mohr-Coulomb elastoplasticity with tension cut-off, solver architecture, outputs, verification, limitations, and references.';
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
	<DocsHeader />

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / deformation analysis</p>
			<h1>Stage 6 deformation analysis.</h1>
			<p class="hero__lead">
				The deformation module is the mechanical finite-element branch of the Stage 6 section
				model. It combines a geostatic predictor, an optional plastic self-weight equilibration
				phase, and a drained plane-strain service-load solve on the shared T3 mesh. The shipped
				constitutive hierarchy spans linear elasticity, Stage 1 reduced-stiffness screening, and
				an exact Stage 2 Mohr-Coulomb elastoplastic route with face, edge, apex, and tension
				cut-off branch handling in principal effective stress space. Displacement, stress,
				utilization, and plastic-history fields are exposed on the solved section.
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
			<a href="#hardening-soil">Hardening Soil model</a>
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
					The deformation route is a <strong>small-strain plane-strain finite-element
					analysis</strong> on the shared Stage 6 cross-section. Its intended engineering use is
					drained settlement assessment, displacement-field interpretation, stress
					redistribution, localization diagnostics, and evaluation of elastoplastic response
					under self-weight and service loading.
				</p>
				<div class="doc-callout">
					<strong>Model class.</strong> The implemented route is a drained section-based
					mechanical analysis. It is not a full three-dimensional foundation model, not a
					large-deformation or updated-Lagrangian formulation, and not a coupled
					consolidation analysis.
				</div>
				<p>
					The implementation contains three constitutive levels with different mathematical
					status and different engineering interpretation:
				</p>
				<ul class="notes">
					<li><strong>linear elasticity</strong> as the baseline regression path,</li>
					<li><strong>Stage 1 reduced stiffness</strong> as a conservative pseudo-plastic screen,</li>
					<li><strong>Stage 2 exact Mohr-Coulomb elastoplasticity</strong> as the current reference constitutive route.</li>
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
							<dd>Accumulated equivalent plastic strain in the Stage 2 route.</dd>
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
						<li>Do not read Stage 2 plastic bands as a fully validated FEM failure surface in the PLAXIS sense.</li>
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
										<td>Used by Stage 2 through a non-associated plastic potential.</td>
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
						The current route uses a constrained triangular mesh and supports two element
						families, dispatched per analysis through a unified element kernel:
					</p>
					<ul class="notes">
						<li><strong>T3</strong> — three-node constant-strain triangle, 1 Gauss point. Default for first-pass screening; fast and easy to audit.</li>
						<li><strong>T6</strong> — six-node quadratic triangle, 3 Gauss points. Used where bending response or near-incompressible behaviour matters; combines naturally with the B-bar near-incompressibility projection (§5.4).</li>
					</ul>
					<p>
						Automatic meshing starts relatively coarse for first-pass user runs and can be
						manually refined where needed. The element type is selected through the analysis
						options; T6 increases the free-DOF count by roughly 4× over a comparable T3 mesh
						and the solver warns when the resulting DOF count is large enough to slow the
						run materially.
					</p>
					<ul class="notes">
						<li>Local load-edge refinement is important because stresses and strains concentrate there.</li>
						<li>Slope crests and geometry kinks can legitimately create high gradients and local plasticity.</li>
						<li>For T3, mesh convergence should be checked for sensitive bending-dominated problems.</li>
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
						either elastic or reduced-shear. For Stage 2, the constitutive update returns the
						current elastoplastic tangent from the exact shear return; the default global solve
						uses its symmetrized form for robustness unless the optional unsymmetric path is
						enabled.
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
					<h3>5.4 Near-incompressibility handling</h3>
					<p>
						Plane-strain analysis can drive the volumetric response toward incompressibility,
						either through high Poisson ratio in elasticity or through low dilation angle
						(ψ → 0) under non-associated Mohr-Coulomb plastic flow. The current route treats
						this in two element-specific ways:
					</p>
					<ul class="notes">
						<li><strong>T3</strong> — single-Gauss-point constant-strain element. Volumetric locking is mitigated by capping Poisson’s ratio for numerical stability. The cap is a numerical safeguard, not a material law, and only matters as the ratio approaches 0.5.</li>
						<li><strong>T6</strong> — three-Gauss-point quadratic element. Volumetric locking is removed by the B-bar projection: the volumetric part of the strain-displacement matrix B is replaced by its element-average <strong>&lt;B&gt;</strong> while the deviatoric part is left untouched. The 2D plane-strain B-bar form is applied per Gauss point at element-stiffness assembly, so the same projection is consistent between K<sub>tan</sub> and the internal-force integration.</li>
					</ul>
					<div class="doc-callout">
						<strong>Engineering reading.</strong> Use T6 with B-bar where near-incompressible
						elastic or non-associated plastic flow is expected (undrained-like dilation angle,
						high-ν elasticity). Use T3 for first-pass screening on drained problems with
						moderate ν.
					</div>
				</section>
			</section>

			<section id="initial" class="doc-card">
				<p class="section-label">Initial stress state</p>
				<h2>6. Geostatic predictor, plastic self-weight equilibration, pore pressure, and K<sub>0,nc</sub> confinement</h2>

				<section class="doc-subsection">
					<h3>6.1 Linear gravity predictor</h3>
					<p>
						The initial route always begins with a <strong>linear elastic gravity predictor</strong>
						on the same mesh and the same support set used by the subsequent deformation analysis.
						This predictor provides a geometry-aware vertical stress and initial shear field and
						forms the starting point for both shipped initial-stress modes.
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
							on slopes and near geometry breaks. The production Stage 2 route does not use that
							field blindly: it rebuilds the normal confinement from K<sub>0,nc</sub>, keeps the
							recovered shear only as far as the exact Mohr-Coulomb and tension-cutoff envelope
							allow, and then solves the remaining self-weight equilibrium correction.
						</p>
				</section>

				<section class="doc-subsection">
					<h3>6.2 Effective stress reconstruction and K<sub>0,nc</sub> predictor state</h3>
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
					<p>
						The shipped predictor then reconstructs the in-situ normal confinement with the
						interpreted at-rest ratio rather than letting elastic Poisson coupling define the
						initial lateral stress state:
					</p>
					<div class="equations">
						<div class="formula">σ′<sub>yy,0</sub> = σ<sub>yy,total,gravity</sub> − u<sub>0</sub></div>
						<div class="formula">σ′<sub>xx,0</sub> = K<sub>0,nc</sub> σ′<sub>yy,0</sub></div>
						<div class="formula">σ′<sub>zz,0</sub> = K<sub>0,nc</sub> σ′<sub>yy,0</sub></div>
							<div class="formula">τ′<sub>xy,0</sub> = λ τ<sub>xy,total,gravity</sub>, 0 ≤ λ ≤ 1</div>
						</div>
						<p>
							Here λ is chosen per integration point by admissibility clipping: λ = 1 when the
							full recovered shear is inside the exact Mohr-Coulomb and tension envelope; otherwise
							a bisection search selects the largest admissible value. This preserves the useful
							slope-equilibrium shear without seeding an inadmissible stress state.
						</p>
					</section>

					<section class="doc-subsection">
						<h3>6.3 Plastic self-weight equilibration</h3>
						<p>
							The predictor state above is not accepted as the final production initial condition.
							It becomes the starting point for a full Stage 2 self-weight equilibrium correction
							under exact Mohr-Coulomb elastoplasticity. Service loading and c-phi reduction require
							this self-weight phase to converge.
						</p>
					<div class="equations">
						<div class="formula">R<sub>0b</sub>(Δu) = F<sub>g</sub> − F<sub>int</sub>(σ′<sub>pred</sub> + Δσ′(Δu, history)) = 0</div>
						<div class="formula">Δε = B Δu</div>
						<div class="formula">u<sub>total</sub> = u<sub>pred</sub> + Δu</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>R<sub>0b</sub></dt>
								<dd>initial plastic self-weight correction residual vector [kN/m]</dd>
							</div>
							<div class="symbols__row">
								<dt>F<sub>int</sub></dt>
								<dd>internal force vector assembled from the current exact constitutive stress state [kN/m]</dd>
							</div>
							<div class="symbols__row">
								<dt>σ′<sub>pred</sub></dt>
								<dd>effective predictor stress state obtained from the gravity-step-plus-K<sub>0,nc</sub> reconstruction [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>Δu</dt>
								<dd>predictor-relative correction displacement field [m]</dd>
							</div>
						</dl>
					</div>
					<p>
						This phase is a <strong>predictor-correction problem</strong>, not a fresh loading
						from a stress-free state and not a replay of the gravity-step displacement field.
						The constitutive update sees the incremental strain operator
						<em>B Δu</em> around the seeded predictor stress state. That distinction is required
						to prevent double-counting of the gravity strain field.
					</p>
					<ul class="notes">
						<li>If the correction converges, the equilibrated stress and plastic state become the constitutive reference state for the service phase.</li>
						<li>If the correction does not converge, the service phase is not started and the reported state remains the last accepted self-weight state.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>6.4 K<sub>0,nc</sub> controls initial confinement, not ν</h3>
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
					<h3>6.5 Displacement reset between the initial phase and service phase</h3>
					<p>
						If the plastic self-weight equilibration phase converges, the later service-load phase
						keeps the equilibrated stress state and plastic history but resets the displacement
						baseline for reported contour quantities. This matches the standard staged-analysis
						engineering reading used in commercial FEM workflows.
					</p>
					<div class="equations">
						<div class="formula">u<sub>displayed</sub> = u<sub>total</sub> − u<sub>0</sub></div>
					</div>
					<p>
						So the default deformation contours and settlement values still represent the
						<strong>service-load increment</strong>, not the sum of self-weight settlement and
						service settlement. The total and initial displacement fields are retained internally
						for diagnostics and reconstruction.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>6.6 Flat K<sub>0</sub> fallback</h3>
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
					<h3>6.7 Effective stress and load increment</h3>
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
						The constitutive algorithm works with the full compression-positive effective stress
						tensor in plane strain:
					</p>
					<div class="equations">
						<div class="formula">σ′ = Σ<sub>i=1</sub><sup>3</sup> σ′<sub>i</sub> P<sub>i</sub></div>
						<div class="formula">σ′<sub>1</sub> ≥ σ′<sub>2</sub> ≥ σ′<sub>3</sub></div>
						<div class="formula">P<sub>i</sub> P<sub>j</sub> = δ<sub>ij</sub> P<sub>i</sub>, &nbsp; Σ<sub>i=1</sub><sup>3</sup> P<sub>i</sub> = I</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>σ′<sub>i</sub></dt>
								<dd>ordered effective principal stresses [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>P<sub>i</sub></dt>
								<dd>spectral projectors of the effective stress tensor [-]</dd>
							</div>
						</dl>
					</div>
					<p>
						The full three-principal representation is required because the plane-strain
						constitutive state still carries an out-of-plane stress component and the exact
						Mohr-Coulomb active-set return is formulated in principal effective stress space.
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
						Classical Mohr-Coulomb can imply an unrealistic effective tensile capacity. The
						exact Stage 2 route therefore includes the optional tension cut-off:
					</p>
					<div class="equations">
						<div class="formula">f<sub>t</sub> = −σ′<sub>3</sub> − σ<sub>t</sub> ≤ 0</div>
						<div class="formula">σ<sub>t</sub> = 0 &nbsp; for zero tensile strength</div>
						<div class="formula">σ<sub>t</sub> ≤ c′ / tan φ′</div>
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
								<dd>allowed tensile effective stress, commonly zero for soil [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						The exact constitutive implementation uses one physical tension surface only:
					</p>
					<div class="equations">
						<div class="formula">T3 : −σ′<sub>3</sub> − σ<sub>t</sub> = 0</div>
					</div>
					<p>
						In Stage 1 this condition remains diagnostic-only. In Stage 2 it is now part of the
						exact active-set elastoplastic return. Tension-governed accepted states are reported
						with active yield surface <strong>TENSION</strong>; the app does not reinterpret those
						zones as ordinary finite shear-utilization states.
					</p>
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
						The shipped Stage 2 route uses this exact principal-stress logic for the Mohr-Coulomb
						shear return, with face and edge handling in the local active-set solve.
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
						<div class="formula">σ′<sub>n+1</sub> = σ′<sub>trial</sub> − D<sup>e</sup> Σ<sub>i∈A</sub> Δλ<sub>i</sub> m<sub>i</sub></div>
						<div class="formula">f<sub>i</sub>(σ′<sub>n+1</sub>) = 0 &nbsp; for every active surface i ∈ A</div>
						<div class="formula">H<sub>ij</sub> = n<sub>i</sub><sup>T</sup> D<sub>n</sub> m<sub>j</sub></div>
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
								<dt>A</dt>
								<dd>active set of yield surfaces for the accepted branch [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>n<sub>i</sub>, m<sub>i</sub></dt>
								<dd>yield and potential gradients in principal stress space for active surface i [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>H</dt>
								<dd>local active-set coupling matrix used to solve the plastic multipliers [-]</dd>
							</div>
						</dl>
					</div>
					<p>
						The shipped Stage 2 route uses an exact nonsmooth multisurface return in principal
						effective stress space. The accepted branch may be a shear face, a repeated-eigenvalue
						shear edge, the formal shear apex, a tension face, a mixed shear-tension branch, or
						the triple tension point.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>8.5 Exact Stage 2 branch structure</h3>
					<p>
						The present implementation exposes the following exact Stage 2 branch families:
					</p>
					<ul class="notes">
						<li><strong>MC face</strong>: single active shear surface.</li>
						<li><strong>MC edge</strong>: two active shear surfaces with repeated principal stresses.</li>
						<li><strong>MC apex</strong>: formal triple-shear branch where admissible.</li>
						<li><strong>Tension face</strong>: single active cut-off surface T3.</li>
						<li><strong>Mixed shear-tension</strong>: active set &#123;F13, T3&#125;.</li>
						<li><strong>Tension apex</strong>: hydrostatic cut-off point with σ′<sub>1</sub> = σ′<sub>2</sub> = σ′<sub>3</sub> = −σ<sub>t</sub>.</li>
					</ul>
					<p>
						Repeated-eigenvalue branches are solved with representative principal-space normals
						and flow directions rather than by reusing the distinct-stress formulas unchanged.
						This is required for projector stability and exact branch closure near
						σ′<sub>1</sub> = σ′<sub>2</sub> or σ′<sub>2</sub> = σ′<sub>3</sub>.
					</p>
					<div class="equations">
						<div class="formula">n<sub>t,23</sub> = m<sub>t,23</sub> = [0, −1/2, −1/2]</div>
						<div class="formula">n<sub>t,123</sub> = m<sub>t,123</sub> = [−1/3, −1/3, −1/3]</div>
						<div class="formula">n<sub>s,23</sub> = [1 − sinφ′, −(1 + sinφ′)/2, −(1 + sinφ′)/2]</div>
						<div class="formula">m<sub>s,23</sub> = [1 − sinψ, −(1 + sinψ)/2, −(1 + sinψ)/2]</div>
						<div class="formula">n<sub>s,12</sub> = [(1 − sinφ′)/2, (1 − sinφ′)/2, −(1 + sinφ′)]</div>
						<div class="formula">m<sub>s,12</sub> = [(1 − sinψ)/2, (1 − sinψ)/2, −(1 + sinψ)]</div>
					</div>
					<p>
						The mixed repeated shear-tension corners use branch-specific representative shear
						gradients in the repeated subspace; they are not treated as ad hoc stress clipping.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>8.6 Equivalent plastic strain diagnostic</h3>
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
				<h2>9. Linear elastic, Stage 1 reduced stiffness, and exact Stage 2 elastoplasticity</h2>

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
					<h3>9.3 Stage 2 exact Mohr-Coulomb elastoplasticity</h3>
					<p>
						Stage 2 is the current public default and the exact elastoplastic constitutive route:
					</p>
					<ul class="notes">
						<li>It stores material-point plastic strain.</li>
						<li>It uses a local active-set return in principal effective stress space.</li>
						<li>It supports non-associated flow through ψ.</li>
						<li>It supports shear face, edge, apex, tension-face, mixed shear-tension, and triple tension-point branches.</li>
						<li>It returns the current elastoplastic tangent, with the default global solve using the symmetrized form for robustness unless the optional unsymmetric path is enabled.</li>
					</ul>
					<p>
						The remaining limits are algorithmic and modelling limits, not missing core
						Mohr-Coulomb branch physics:
					</p>
					<ul class="notes">
						<li>it is not a large-deformation or post-failure formulation,</li>
						<li>it remains a drained small-strain section analysis on T3 / T6 triangles.</li>
					</ul>
					<div class="doc-callout">
						<strong>Current engineering reading.</strong> Stage 2 is the reference constitutive
						route for drained small-strain Mohr-Coulomb analysis in the present app. It is
						available across all three solver phases (gravity, service load, and c-phi safety
						reduction — see §10.5). The key remaining extensions are alternative constitutive
						models and alternative analysis drivers, not completion of the classical MC local
						branch set.
					</div>
				</section>
			</section>

			<section id="hardening-soil" class="doc-card">
				<p class="section-label">Hardening Soil model</p>
				<h2>9A. Hardening Soil: stress-dependent stiffness with two yield surfaces</h2>

				<section class="doc-subsection">
					<h3>9A.1 Engineering positioning and intended use</h3>
					<p>
						The <strong>Hardening Soil (HS)</strong> model (Schanz, Vermeer, and Bonnier 1999)
						is the alternative drained constitutive route shipped alongside the linear and
						Mohr-Coulomb routes. It is positioned for problems where the constant Young modulus
						of Mohr-Coulomb is the dominant error source for displacement predictions: drained
						settlement of footings on real granular and lightly overconsolidated soils,
						excavation response in stiffness-stratified profiles, and any case where the
						<strong>primary-loading and unloading-reloading branches need to be distinguished</strong>.
					</p>
					<ul class="notes">
						<li>Use the <strong>linear elastic</strong> route for regression baselines and for
							elastic-comparison plots.</li>
						<li>Use <strong>Stage 2 Mohr-Coulomb elastoplasticity</strong> for limit-state
							screening, c-φ safety, and slope-stability-style analyses where the failure
							envelope dominates the engineering output.</li>
						<li>Use <strong>Hardening Soil</strong> when serviceability displacements matter
							and the stiffness-versus-stress behaviour of the soil is the controlling
							feature of the analysis.</li>
					</ul>
					<div class="doc-callout">
						<strong>Runtime contract.</strong> Hardening Soil is implemented in the WASM CPU
						solver only. The JavaScript reference path rejects HS analyses at run-start with
						an explicit error. There is no GPU pipeline support; HS analyses run on the WASM
						CPU backend that is the default for the application.
					</div>
				</section>

				<section class="doc-subsection">
					<h3>9A.2 Stress-dependent power-law stiffness</h3>
					<p>
						HS replaces the constant E<sub>mc</sub> of Mohr-Coulomb with three reference
						stiffnesses, each calibrated at a reference pressure p<sub>ref</sub> (typically
						100 kPa), and each scaled by a power law in confinement:
					</p>
					<div class="equations">
						<div class="formula">E<sub>50</sub> = E<sub>50</sub><sup>ref</sup> · [(c′ cos φ′ + σ′<sub>3</sub> sin φ′) / (c′ cos φ′ + p<sub>ref</sub> sin φ′)]<sup>m</sup></div>
						<div class="formula">E<sub>ur</sub> = E<sub>ur</sub><sup>ref</sup> · [(c′ cos φ′ + σ′<sub>3</sub> sin φ′) / (c′ cos φ′ + p<sub>ref</sub> sin φ′)]<sup>m</sup></div>
						<div class="formula">E<sub>oed</sub> = E<sub>oed</sub><sup>ref</sup> · [(c′ cos φ′ + σ′<sub>1</sub> sin φ′) / (c′ cos φ′ + p<sub>ref</sub> sin φ′)]<sup>m</sup></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>E<sub>50</sub><sup>ref</sup></dt>
								<dd>secant Young modulus at 50% of the failure deviator, at the reference confining pressure [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>E<sub>oed</sub><sup>ref</sup></dt>
								<dd>tangent oedometric modulus at the reference vertical stress [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>E<sub>ur</sub><sup>ref</sup></dt>
								<dd>unload-reload Young modulus at the reference confining pressure, typically 3–6× E<sub>50</sub><sup>ref</sup> [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>m</dt>
								<dd>stress-dependence exponent [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>p<sub>ref</sub></dt>
								<dd>reference pressure [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						Typical exponent values: m ≈ 0.5 for cohesionless sands (Hardin and Drnevich
						1972 scaling), m ≈ 1.0 for soft normally-consolidated clays, and m ≈ 0.7–0.9 for
						stiff clays and silts. E<sub>50</sub> and E<sub>ur</sub> scale with the minor
						principal effective stress σ′<sub>3</sub> (the triaxial confining pressure), while
						E<sub>oed</sub> scales with the major effective stress σ′<sub>1</sub> consistent
						with the one-dimensional oedometric loading direction.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>9A.3 Hyperbolic primary-loading curve</h3>
					<p>
						HS reproduces the Duncan and Chang (1970) hyperbolic stress-strain relation in
						drained triaxial primary loading. For a deviator q below the Mohr-Coulomb
						failure deviator q<sub>f</sub>, the axial strain follows:
					</p>
					<div class="equations">
						<div class="formula">ε<sub>1</sub> = (1 / E<sub>i</sub>) · q / (1 − q / q<sub>a</sub>) &nbsp;&nbsp; for q &lt; q<sub>f</sub></div>
						<div class="formula">q<sub>f</sub> = (c′ cot φ′ + σ′<sub>3</sub>) · 2 sin φ′ / (1 − sin φ′)</div>
						<div class="formula">q<sub>a</sub> = q<sub>f</sub> / R<sub>f</sub>, &nbsp;&nbsp; E<sub>i</sub> = 2 E<sub>50</sub> / (2 − R<sub>f</sub>)</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>R<sub>f</sub></dt>
								<dd>failure ratio, user input, typically 0.9 [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>q<sub>f</sub></dt>
								<dd>deviator at Mohr-Coulomb failure [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>q<sub>a</sub></dt>
								<dd>asymptotic deviator of the hyperbolic curve, larger than q<sub>f</sub> by 1/R<sub>f</sub> [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>E<sub>i</sub></dt>
								<dd>initial Young modulus calibrated so that the secant at q = q<sub>f</sub>/2 equals E<sub>50</sub> [kPa]</dd>
							</div>
						</dl>
					</div>
					<p>
						The hyperbolic curve replaces the linear pre-yield response of Mohr-Coulomb with
						a continuously stiffening-then-softening secant stiffness as q approaches the
						Mohr-Coulomb envelope. The transition from elastic to plastic occurs at
						q = q<sub>f</sub> as in Mohr-Coulomb, but the path to it is governed by the
						accumulated plastic shear strain γ<sup>p</sup> through the cone hardening law
						of §9A.4.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>9A.4 Two yield surfaces: shear cone and volumetric cap</h3>
					<p>
						HS uses two yield surfaces in principal effective stress space:
					</p>
					<ul class="notes">
						<li>
							A <strong>shear yield surface</strong> (the cone), parameterised by the
							plastic shear strain γ<sup>p</sup>. The cone is Mohr-Coulomb-aligned: it
							depends on the major and minor principal effective stresses, mobilises with
							γ<sup>p</sup> from a soft initial state, and saturates as the stress path
							approaches the Mohr-Coulomb failure envelope. Non-associated flow on the cone
							is governed by Rowe's (1962) stress-dilatancy through a mobilised dilation
							angle ψ<sub>m</sub>.
						</li>
						<li>
							A <strong>volumetric cap yield surface</strong>, parameterised by the
							preconsolidation pressure p<sub>p</sub>. The cap is an ellipse in the
							meridional plane (p′, q̃) and grows monotonically with cap-mode plastic
							volumetric strain. Associated flow on the cap means the plastic potential
							equals the yield function.
						</li>
					</ul>
					<p>
						The two surfaces engage together along a K<sub>0,nc</sub> normal-consolidation
						path: the cap controls the volumetric (oedometric) stiffness while the cone
						controls the deviatoric mobilisation, and the calibration in §9A.6 pins both
						the cap shape parameter M and the cap-hardening modulus H<sub>cap</sub> from
						the user inputs E<sub>oed</sub><sup>ref</sup>, K<sub>0,nc</sub>, φ′, and
						ν<sub>ur</sub>. Tension cutoff is enforced in the same hierarchy as the exact
						Mohr-Coulomb route: the tension surface dominates the HS surfaces and the
						return follows the existing project-and-check pattern.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>9A.5 K<sub>0,nc</sub> consolidation and cap-cone interaction</h3>
					<p>
						Under one-dimensional normally consolidated loading (ε<sub>h</sub> = 0,
						σ<sub>v</sub> ramped), both yield surfaces are active. The cap activation forces
						the volumetric stiffness to match E<sub>oed</sub><sup>ref</sup> at p<sub>ref</sub>;
						the cone activation, with mobilised dilatancy from Rowe, sets the lateral stress
						ratio σ<sub>h</sub>/σ<sub>v</sub> to the user-supplied K<sub>0,nc</sub>. When
						K<sub>0,nc</sub> is supplied as zero, the Jaky (1944) default
						K<sub>0,nc</sub> = 1 − sin φ′ is used.
					</p>
					<p>
						The unload-reload Young modulus E<sub>ur</sub> is treated as the elastic
						stiffness inside both yield surfaces. The unload-reload Poisson ratio ν<sub>ur</sub>
						is the elastic Poisson value (typically 0.2) used for the isotropic elastic
						tangent on which the return mapping is built.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>9A.6 Parameter cookbook for typical soils</h3>
					<p>
						The parameter ranges below are reference values from Brinkgreve (2007), the
						standard PLAXIS HS calibration reference. They are starting points for
						preliminary analysis. Site-specific calibration against oedometer, triaxial, or
						field stiffness data should always supersede generic values.
					</p>
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr>
									<th>Soil class</th>
									<th>E<sub>50</sub><sup>ref</sup> [MPa]</th>
									<th>E<sub>oed</sub><sup>ref</sup> [MPa]</th>
									<th>E<sub>ur</sub><sup>ref</sup> [MPa]</th>
									<th>m [-]</th>
									<th>φ′ [°]</th>
									<th>ψ [°]</th>
									<th>c′ [kPa]</th>
								</tr>
							</thead>
							<tbody>
								<tr>
									<td>Loose sand</td>
									<td>15–20</td>
									<td>15–20</td>
									<td>45–60</td>
									<td>0.55</td>
									<td>30–32</td>
									<td>0–2</td>
									<td>0</td>
								</tr>
								<tr>
									<td>Medium-dense sand</td>
									<td>25–40</td>
									<td>25–40</td>
									<td>75–120</td>
									<td>0.50</td>
									<td>32–35</td>
									<td>2–5</td>
									<td>0</td>
								</tr>
								<tr>
									<td>Dense sand</td>
									<td>40–60</td>
									<td>40–60</td>
									<td>120–180</td>
									<td>0.45</td>
									<td>35–40</td>
									<td>5–10</td>
									<td>0</td>
								</tr>
								<tr>
									<td>Soft normally-consolidated clay</td>
									<td>3–6</td>
									<td>1.5–3</td>
									<td>10–20</td>
									<td>1.0</td>
									<td>20–24</td>
									<td>0</td>
									<td>1–5</td>
								</tr>
								<tr>
									<td>Stiff overconsolidated clay</td>
									<td>10–25</td>
									<td>5–15</td>
									<td>30–80</td>
									<td>0.7–0.9</td>
									<td>22–28</td>
									<td>0</td>
									<td>10–30</td>
								</tr>
							</tbody>
						</table>
					</div>
					<p class="doc-table-note">
						Common supporting defaults: ν<sub>ur</sub> ≈ 0.2, R<sub>f</sub> = 0.9,
						p<sub>ref</sub> = 100 kPa. K<sub>0,nc</sub> defaults to 1 − sin φ′ when not
						entered explicitly. OCR = 1 places the initial cap exactly on the in-situ
						vertical effective stress; OCR &gt; 1 shifts the cap outward and the cap remains
						inactive until subsequent loading reaches the preconsolidation level.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>9A.7 Implementation status and current limits</h3>
					<p>
						The HS plugin is production-ready for uniform-load benchmark cases within the
						convergence envelope characterised in the implementation rollout. The current
						implementation has documented limits relative to the published reference
						formulation:
					</p>
					<ul class="notes">
						<li>
							<strong>WASM-only.</strong> The HS update is implemented in C++ and dispatched
							inside the WASM solver. The JavaScript reference path rejects HS analyses at
							run-start. The GPU pipeline does not support HS.
						</li>
						<li>
							<strong>Elastic-tangent globalisation.</strong> The shipped tangent assembly
							uses the elastic (E<sub>ur</sub>-based) tangent for the global Newton solve
							rather than the consistent algorithmic tangent. Local admissibility per Gauss
							point is certified by the return mapping; the elastic globalisation costs a
							slower Newton convergence rate compared with a fully consistent tangent, but
							is robust and avoids the bookkeeping cost of differentiating the
							stress-dependent stiffness.
						</li>
						<li>
							<strong>Constant cap-hardening modulus.</strong> H<sub>cap</sub> is calibrated
							once per region at material setup from the K<sub>0,nc</sub> consistency
							condition and held constant during the analysis. PLAXIS uses a p<sub>p</sub>-
							dependent H<sub>cap</sub> that softens the cap as p<sub>p</sub> grows; this
							refinement is tracked as a follow-up improvement (see §2.6 of the feature
							specification for the closed-form Brinkgreve relation).
						</li>
						<li>
							<strong>Narrow convergence envelope at extreme parameters.</strong>
							Combinations of low confinement, low cohesion, and high friction angle can
							drive σ′<sub>3</sub> close to zero, where the power-law denominator hits the
							numerical floor (0.5 kPa) and the cone hardening law becomes ill-conditioned.
							The tension cutoff usually engages before the floor matters, but for very
							soft surface layers the solver may need finer load-step settings.
						</li>
						<li>
							<strong>c-φ safety with HS</strong> is supported: c′, tan φ′, tan ψ, and the
							tension allowable are reduced by Σ<sub>Msf</sub> at every active HS Gauss
							point; reference stiffnesses E<sub>50</sub><sup>ref</sup>,
							E<sub>oed</sub><sup>ref</sup>, E<sub>ur</sub><sup>ref</sup> and the exponent
							m are not scaled, matching PLAXIS convention. The HS region constants
							M<sub>cap</sub>, H<sub>cap</sub>, and sin φ<sub>cv</sub> are re-calibrated at
							every safety trial when φ′ changes via Σ<sub>Msf</sub>.
						</li>
					</ul>
					<div class="doc-callout">
						<strong>Reading the HS active-surface output.</strong> The result envelope reports
						a per-Gauss-point active-surface flag with five categories: elastic, cone, cap,
						corner (cone + cap), and tension. Plastic shear strain γ<sup>p</sup>,
						preconsolidation pressure p<sub>p</sub>, and total plastic volumetric strain
						ε<sub>v</sub><sup>p</sup> are exposed alongside the existing displacement, stress,
						and Mohr-Coulomb utilisation overlays.
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
					<p>
						For plastic geostatic initialization the state container distinguishes
						<strong>predictorState</strong>, <strong>referenceState</strong>,
						<strong>committedState</strong>, and <strong>trialState</strong>. Predictor audit
						quantities remain attached to the seeded initial state, while equilibrated-initial
						audit quantities are stamped separately after a converged self-weight correction.
					</p>
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
						<li>Stage 2 can use cautious growth after first yield.</li>
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

				<section class="doc-subsection">
					<h3>10.5 Three-phase staging: gravity → service → c-phi safety</h3>
					<p>
						The shipped solver runs as a three-phase staged analysis. Each phase reuses the
						previous phase's committed material-point state and plastic history; only the
						driving load and the convergence target change.
					</p>
					<ul class="notes">
						<li><strong>initial-gravity</strong> — geostatic predictor and plastic self-weight equilibration (§6).</li>
						<li><strong>service-load</strong> — drained service-load increment over the equilibrated initial state (§6.5, §6.7).</li>
						<li><strong>safety-cphi</strong> — c-phi (φ′ / c′) strength reduction safety analysis. Strength is reduced by a per-phase factor; the solver follows the load-factor branch until equilibrium is no longer attainable. Reports a safety load factor with the meaning <em>safety-strength-reduction</em>, plus the safety-phase plastic increment and settlement.</li>
					</ul>
					<div class="doc-callout">
						<strong>Engineering reading.</strong> The c-phi safety driver is an integrated
						strength-reduction FEM analysis on the same Stage 2 elastoplastic constitutive
						route used by the service phase. It is not a separate slip-line or limit-equilibrium
						calculation.
					</div>
				</section>

				<section class="doc-subsection">
					<h3>10.6 Arc-length continuation in the safety phase</h3>
					<p>
						Prescribed-strength continuation (the default <code>strength-control</code> mode)
						parameterises the c-φ safety solve by the imposed <strong>Σ<sub>Msf</sub></strong>
						and Newton-iterates for displacement at each prescribed reduction level. The
						prescribed control variable becomes a poor path parameter near a limit point: the
						load step shrinks below <strong>minLoadStep · 4</strong>, line search stalls, the
						plastic active set oscillates near a fixed Σ<sub>Msf</sub>, and the safety curve
						flattens before a coherent mechanism develops. At that point the solver can switch
						to a Crisfield–Riks spherical arc-length continuation in which displacement and
						continuation parameter are unknowns of the same Newton solve.
					</p>
					<div class="equations">
						<div class="formula">R(u, λ) = 0</div>
						<div class="formula">g(Δu, Δλ) = ‖W·Δu‖² + α²·Δλ² − Δs² = 0</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>R(u, λ)</dt>
								<dd>global residual at displacement <em>u</em> and continuation parameter <em>λ</em>; the safety mapping is <strong>Σ<sub>Msf</sub>(λ) = Σ<sub>start</sub> + λ·(Σ<sub>target</sub> − Σ<sub>start</sub>)</strong></dd>
							</div>
							<div class="symbols__row">
								<dt>g(Δu, Δλ)</dt>
								<dd>spherical arc-length constraint between the predictor base state and the current Newton iterate [m²]</dd>
							</div>
							<div class="symbols__row">
								<dt>W</dt>
								<dd>displacement scaling, optionally <strong>1/L<sub>model</sub></strong> from the mesh bounding-box diagonal</dd>
							</div>
							<div class="symbols__row">
								<dt>α</dt>
								<dd>continuation-vs-displacement weighting [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>Δs</dt>
								<dd>arc-length radius [m], adapted from achieved Newton iteration count</dd>
							</div>
						</dl>
					</div>
					<p>
						The corrector is the standard two-solve form (Crisfield 1981): at each Newton
						iteration the same tangent stiffness <strong>K</strong> is solved against
						<strong>−R</strong> and <strong>−∂R/∂λ</strong>, then the linearised constraint
						gives a scalar continuation correction and the displacement correction follows.
					</p>
					<div class="equations">
						<div class="formula">K · δu<sub>R</sub> = −R,&nbsp;&nbsp; K · δu<sub>λ</sub> = −∂R/∂λ</div>
						<div class="formula">dλ = (−g − g<sub>u</sub>·δu<sub>R</sub>) / (g<sub>u</sub>·δu<sub>λ</sub> + g<sub>λ</sub>),&nbsp;&nbsp; du = δu<sub>R</sub> + dλ·δu<sub>λ</sub></div>
					</div>
					<p>
						For c-φ safety <strong>∂R/∂λ</strong> is computed by finite difference on
						<strong>Σ<sub>Msf</sub></strong> against the same committed material state — central
						difference when both probes lie in the admissible domain
						<strong>Σ<sub>Msf</sub> ≥ 1</strong>, forward-only at <strong>Σ<sub>Msf</sub> = 1</strong>
						to respect the strength-reduction floor. Probe assemblies skip tangent construction
						(<code>wantTangent=false</code>) and never commit material state. The predictor
						sign is selected by dot-product against the previous accepted path increment, with
						positive Δλ forced on the first step within a phase; under the
						<code>arcLengthAllowPostPeakSafetyPath</code> option the predictor may descend
						(Σ<sub>Msf</sub> decreasing with growing displacement) from the second step onward
						for diagnostic purposes.
					</p>
					<p>
						The arc-length radius adapts after each accepted step from the achieved Newton
						iteration count relative to <code>arcLengthTargetIterations</code>, with separate
						shrink factors on rejection (controlled cutback) and on failure (faster cutback).
						Rejected steps restore committed displacement, material-point state, warm-start
						iterates, and active-set diagnostics exactly. Reported factor of safety remains the
						highest stable lower-bound Σ<sub>Msf</sub> regardless of post-peak descent; post-peak
						curve points are recorded for diagnostic display only and never replace the peak
						value.
					</p>
					<div class="doc-callout">
						<strong>Mode selection.</strong> Three values of
						<code>requestedContinuationMode</code> are exposed:
						<code>strength-control</code> (the prescribed-Σ default),
						<code>arc-length</code> (forced arc-length on the safety phase), and
						<code>auto</code> (start in strength control, fall back to arc-length when the
						strength-control diagnostics indicate a limit-point approach). The actual mode used
						is recorded per accepted continuation step in the safety-curve payload.
					</div>
					<p>
						Implemented on the WASM CPU path only at present. The GPU v2 pipeline retains
						prescribed strength control; arc-length on GPU is deferred.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>10.7 Material plugin registry</h3>
					<p>
						The deformation solver is constitutive-model-agnostic. Every constitutive route
						(linear elastic, Stage 1 reduced-stiffness, Stage 2 exact Mohr-Coulomb) is
						registered through the same material-plugin contract, dispatched by capability
						flags rather than by name string. Adding a new material model is a one-file
						change: write a factory returning a plugin object with the documented capability
						flags, then call <code>registerMaterialPlugin(name, factory)</code> once at module
						load. The solver picks up support for staged analysis, c-phi safety reduction,
						line-search, and predictor projection through the advertised flags.
					</p>
					<p>
						Three plugins ship at present:
					</p>
					<ul class="notes">
						<li><code>linear-elastic</code> — the baseline regression and comparison route.</li>
						<li><code>mc-reduced-stiffness</code> — Stage 1 pseudo-plastic reduced-shear path.</li>
						<li><code>mc-plastic</code> — Stage 2 exact Mohr-Coulomb elastoplasticity with tension cut-off.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>10.8 GPU pipelines</h3>
					<p>
						Two WebGPU pipelines are shipped alongside the CPU solver, both opt-in and selected
						through the analysis options.
					</p>
					<ul class="notes">
						<li><strong>v1</strong> (<code>runDeformationOnGpu</code>) — linear-elastic only. Mirrors
							the relevant subset of the CPU analyzer's contract: K<sub>0</sub>-controlled
							initial stress recovery, gravity, and surface load. Assembles a CSR-form K on
							device and runs CG with a 2×2 nodal block-Jacobi preconditioner. Bandwidth-
							bound at scale; remains the simpler audit path.</li>
						<li><strong>v2</strong> (<code>runFullDeformationAnalysisOnGpuV2</code>) — full
							elastoplastic resident pipeline. Single static-data handoff into device memory,
							then a resident Newton outer loop performs all three staged phases on device:
							<strong>geostatic predictor</strong>, <strong>service-load increment</strong>,
							and the optional <strong>c-phi safety reduction</strong>. The matrix-free K·x
							kernel recomputes element-wise <em>B<sup>T</sup>DB·u<sub>e</sub></em> on every
							iteration through a precomputed incidence list, eliminating the global K
							assembly. Per-GP exact Mohr-Coulomb return mapping (face / edge / apex / tension
							/ mixed branches) runs on device. CG is the primary linear solver; BiCGStab
							activates when the consistent tangent becomes unsymmetric under non-associated
							active plasticity, and as fallback. Jacobi or 2×2 block-Jacobi preconditioning
							per phase. Line-search residual trials happen on device; only one readback at
							the end.</li>
					</ul>
					<p>
						Probing and fall-back: callers test WebGPU availability through
						<code>probeGpuPipeline</code> (v1) and the v2 controller's analogous probe; failure
						or unsupported scope automatically routes to the CPU path. The matrix-free Kx
						kernels and plastic Newton loop are parity-tested against the v1 and CPU
						references through <code>scripts/verify_gpu_v2_parity.mjs</code>.
					</p>
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
					<p>
						When plastic geostatic equilibration is enabled and converges, the displayed
						displacement fields are the <strong>service-load increment relative to the equilibrated
						initial state</strong>. The solver still stores the total and initial displacement
						fields separately so the service increment can be reconstructed exactly as
						u<sub>total</sub> − u<sub>0</sub>.
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
						<li>In exact tension-cutoff-active zones, η<sub>MC</sub> is suppressed because tension admissibility, not shear utilization, governs the accepted state.</li>
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
					<h3>12.5 Stage 2 is exact for the classical Mohr-Coulomb branch set</h3>
					<p>
						The current public default Stage 2 computes true plastic strain and performs an exact
						Mohr-Coulomb active-set return in principal effective stress space. The shipped
						branch set now includes the shear faces, repeated-eigenvalue shear edges, the formal
						shear apex where admissible, the tension face, the mixed shear-tension branches, and
						the triple tension point.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>12.6 Tension cut-off is constitutive in Stage 2 and diagnostic in Stage 1</h3>
					<p>
						The public route now makes an explicit constitutive distinction:
					</p>
					<ul class="notes">
						<li><strong>Stage 1</strong>: tension cut-off is diagnostic-only and never enters the reduced-stiffness branch.</li>
						<li><strong>Stage 2</strong>: tension cut-off is part of the exact active-set return and is reported through the active surface label <strong>TENSION</strong>.</li>
					</ul>
					<p>
						This prevents the earlier ambiguity where tension-governed accepted states could be
						displayed as if they were unresolved or infinite shear-utilization states.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>12.7 Plastic geostatic initialization is a correction problem around the predictor</h3>
					<p>
						The initial plastic self-weight phase is formulated around the seeded geostatic
						predictor, not as a second gravity replay. The constitutive increment in that phase is
						driven by predictor-relative strain increments only. Predictor audit quantities and
						equilibrated-initial audit quantities are stored separately in the material-point
						state to avoid conflating inadmissible predictor diagnostics with the converged
						initial state.
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
					<li><strong>unit level</strong>: yield-function evaluation, Voigt work conjugacy, plane-strain stress handling, commit or rollback, and local branch return mapping;</li>
					<li><strong>element level</strong>: patch tests and stress-recovery sanity checks;</li>
					<li><strong>boundary-value level</strong>: loaded strip, settlement trend, symmetry, seepage coupling, geostatic slope initialization, unload or reload around a plastic state, and plastic slope or footing benchmarks.</li>
				</ul>
				<p>
					For Stage 2, the important practical acceptance criteria are:
				</p>
				<ul class="notes">
					<li>elastic cases regress to the linear baseline,</li>
					<li>plastic strain accumulates only in the Stage 2 route,</li>
					<li>unload or reload around a plastic state behaves elastically,</li>
					<li>the local return map drives the active-surface residuals back inside tolerance for face, edge, apex, and tension branches,</li>
					<li>plastic-geostatic slope cases progress beyond the raw predictor when exact tension-cutoff branches are available,</li>
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
						<li>T3 / T6 triangle formulations on the shared mesh; T6 with B-bar handles the near-incompressible case.</li>
						<li>Drained effective-stress loading step only; no coupled excess pore-pressure generation.</li>
						<li>No constitutive softening, fracture energy regularization, or strain localization control.</li>
						<li>No contact, interface, or structural-element coupling in the deformation solve.</li>
						<li>GPU v1 covers the linear-elastic route. GPU v2 covers the full elastoplastic pipeline including geostatic, service-load and c-phi safety phases with per-GP exact Mohr-Coulomb return mapping.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>14.2 Natural next steps</h3>
					<ul class="notes">
						<li>Consistent algorithmic tangent and p<sub>p</sub>-dependent cap-hardening modulus for the Hardening Soil plugin (currently elastic-tangent globalisation with a constant H<sub>cap</sub>); see §9A.7.</li>
						<li>HSsmall (small-strain stiffness) extension to the Hardening Soil family for cyclic and small-amplitude problems where the very-small-strain stiffness governs the response (Benz 2007).</li>
						<li>Arc-length continuation in the safety phase is available on the WASM CPU path (see §10.6) and is the default fallback when prescribed strength control approaches a limit point. The GPU v2 pipeline retains prescribed strength control only; arc-length on GPU is the next natural extension.</li>
						<li>Unsymmetric global Newton (GMRES with row/column equilibration) is the default linear solver whenever active non-associated plasticity is detected. The arc-length corrector reuses the same tangent across its two right-hand sides, with a scaling cache that skips redundant equilibration setup on the second solve.</li>
						<li>Hydro-mechanical and consolidation extensions beyond the present drained load-step assumption.</li>
						<li>T6 element coverage in the GPU v2 pipeline (currently T3-resident for the matrix-free Kx kernel).</li>
					</ul>
				</section>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>15. Theory and source basis</h2>
				<ul class="reference-list">
					<li><strong>Zienkiewicz, O. C., Taylor, R. L., and Zhu, J. Z.</strong> <em>The Finite Element Method</em>. 7th ed., Butterworth-Heinemann, 2013. General finite-element reference for small-strain plane-strain discretization and nonlinear solution structure.</li>
					<li><strong>Simo, J. C., and Taylor, R. L.</strong> “Consistent Tangent Operators for Rate-Independent Elastoplasticity.” <em>Computer Methods in Applied Mechanics and Engineering</em>, 48(1), 101-118, 1985. DOI: 10.1016/0045-7825(85)90070-2.</li>
					<li><strong>de Souza Neto, E. A., Perić, D., and Owen, D. R. J.</strong> <em>Computational Methods for Plasticity: Theory and Applications</em>. Wiley, 2008. General reference for backward-Euler return mapping, active-set logic, and algorithmic tangents.</li>
					<li><strong>Clausen, J. C., Damkilde, L., and Andersen, L.</strong> “An Efficient Return Algorithm for Non-Associated Plasticity With Linear Yield Criteria in Principal Stress Space.” <em>Computers &amp; Structures</em>, 85(23-24), 1795-1807, 2007. DOI: 10.1016/j.compstruc.2007.04.002.</li>
					<li><strong>Abbo, A. J., and Sloan, S. W.</strong> “A Smooth Hyperbolic Approximation to the Mohr-Coulomb Yield Criterion.” <em>Computers &amp; Structures</em>, 54(3), 427-441, 1995. DOI: 10.1016/0045-7949(94)00339-5.</li>
					<li><strong>Sloan, S. W., and Booker, J. R.</strong> “Removal of Singularities in Tresca and Mohr-Coulomb Yield Functions.” <em>Communications in Applied Numerical Methods</em>, 2(2), 173-179, 1986. DOI: 10.1002/cnm.1630020208.</li>
					<li><strong>Potts, D. M., and Zdravković, L.</strong> <em>Finite Element Analysis in Geotechnical Engineering: Theory</em>. Thomas Telford, 1999. Geotechnical interpretation reference for nonlinear soil analysis.</li>
					<li><strong>Itasca Consulting Group.</strong> <em>FLAC3D Theory and Background: Mohr-Coulomb Model</em>. Reference source for principal-stress formulation, non-associated flow, and tension cut-off semantics.</li>
					<li><strong>PLAXIS.</strong> <em>PLAXIS 2D Material Models Manual</em>, 2025.1. Reference source for staged deformation interpretation and drained small-strain Mohr-Coulomb benchmarking practice.</li>
					<li><strong>Riks, E.</strong> "An Incremental Approach to the Solution of Snapping and Buckling Problems." <em>International Journal of Solids and Structures</em>, 15(7), 529–551, 1979. DOI: 10.1016/0020-7683(79)90081-7. Original arc-length continuation method.</li>
					<li><strong>Crisfield, M. A.</strong> "A Fast Incremental/Iterative Solution Procedure That Handles 'Snap-Through'." <em>Computers &amp; Structures</em>, 13(1–3), 55–62, 1981. DOI: 10.1016/0045-7949(81)90108-5. Spherical arc-length corrector used in §10.6.</li>
					<li><strong>Crisfield, M. A.</strong> "An Arc-Length Method Including Line Searches and Accelerations." <em>International Journal for Numerical Methods in Engineering</em>, 19(9), 1269–1289, 1983. DOI: 10.1002/nme.1620190902. Basis for the combined-merit line search coupled with the arc-length corrector.</li>
					<li><strong>Tschuchnigg, F., Schweiger, H. F., and Sloan, S. W.</strong> "Slope Stability Analysis by Means of Finite Element Limit Analysis and Finite Element Strength Reduction Techniques. Part I: Numerical Studies Considering Non-Associated Plasticity." <em>Computers and Geotechnics</em>, 70, 169–177, 2015. DOI: 10.1016/j.compgeo.2015.06.018. Closest engineering parallel for the c-φ strength reduction with continuation methods near the limit point.</li>
					<li><strong>Smith, I. M., Griffiths, D. V., and Margetts, L.</strong> <em>Programming the Finite Element Method</em>. 5th ed., Wiley, 2014. ISBN 978-1-119-97334-8. Pedagogical reference for continuation methods and slope-stability strength reduction.</li>
					<li><strong>Schanz, T., Vermeer, P. A., and Bonnier, P. G.</strong> "The Hardening Soil Model: Formulation and Verification." In R. B. J. Brinkgreve (ed.), <em>Beyond 2000 in Computational Geotechnics — 10 Years of PLAXIS International</em>, Balkema, Rotterdam, 1999, pp. 281–296. Primary reference for the Hardening Soil model formulation, the cone and cap yield surfaces, and the hyperbolic primary-loading calibration.</li>
					<li><strong>Brinkgreve, R. B. J.</strong> "Selection of Soil Models and Parameters for Geotechnical Engineering Application." In <em>Soil Constitutive Models: Evaluation, Selection, and Calibration</em>, ASCE Geotechnical Special Publication No. 128, 2007, pp. 69–98. DOI: 10.1061/40771(169)4. Reference parameter ranges and the closed-form K<sub>0,nc</sub> calibration of the cap shape parameter M and the cap-hardening modulus H<sub>cap</sub>.</li>
					<li><strong>Duncan, J. M., and Chang, C.-Y.</strong> "Nonlinear Analysis of Stress and Strain in Soils." <em>Journal of the Soil Mechanics and Foundations Division</em>, ASCE, 96(SM5), 1629–1653, 1970. Origin of the hyperbolic stress-strain law underlying the HS primary-loading curve.</li>
					<li><strong>Rowe, P. W.</strong> "The Stress-Dilatancy Relation for Static Equilibrium of an Assembly of Particles in Contact." <em>Proceedings of the Royal Society of London A</em>, 269(1339), 500–527, 1962. DOI: 10.1098/rspa.1962.0193. Stress-dilatancy basis for the mobilised dilation angle ψ<sub>m</sub> used in HS non-associated cone flow.</li>
					<li><strong>Vermeer, P. A., and de Borst, R.</strong> "Non-Associated Plasticity for Soils, Concrete and Rock." <em>HERON</em>, 29(3), 1984. Treatment of non-associated flow rules in soil plasticity and the Mohr-Coulomb-type plastic potential used for the HS cone.</li>
					<li><strong>Hardin, B. O., and Drnevich, V. P.</strong> "Shear Modulus and Damping in Soils: Design Equations and Curves." <em>Journal of the Soil Mechanics and Foundations Division</em>, ASCE, 98(SM7), 667–692, 1972. Basis for the m ≈ 0.5 power-law stress dependence in granular soils.</li>
					<li><strong>Jaky, J.</strong> "The Coefficient of Earth Pressure at Rest." <em>Journal of the Society of Hungarian Architects and Engineers</em>, 22, 355–358, 1944. Origin of the K<sub>0,nc</sub> = 1 − sin φ′ default for HS at-rest consolidation.</li>
					<li><strong>Benz, T.</strong> <em>Small-Strain Stiffness of Soils and Its Numerical Consequences</em>. PhD dissertation, University of Stuttgart, Mitteilung 55 des Instituts für Geotechnik, 2007. Reference for the HSsmall extension to Hardening Soil (deferred to a follow-up phase).</li>
					<li><strong>Internal implementation notes.</strong> The app-specific theory basis is consolidated in the MADEP deformation notes <em>MC_pl</em>, <em>stage 2.2-f_MC_pl</em>, <em>stage 2.3-f_MC_pl</em>, and <em>stage 2.4-f_MC_pl</em>, with the website specification anchor at <a href="/docs/full">/docs/full</a>.</li>
				</ul>
				<p>
					The long-form audit trail remains available in the
					<a href="/docs/full">technical specification</a>, but the public
					chapter above is intended to carry the actual theory and engineering interpretation of
					the shipped deformation route rather than only a short summary.
				</p>
			</section>
		</main>
	</div>
</div>
