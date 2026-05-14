<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';

	const pageTitle = 'Seepage Analysis — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 seepage analysis: scope, governing equations, boundary-condition semantics, finite-element formulation, free-surface iteration, outputs, assumptions, and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/seepage';
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
			<p class="hero__eyebrow">Stage 6 / seepage analysis</p>
			<h1>Stage 6 seepage analysis.</h1>
			<p class="hero__lead">
				The seepage module is the hydraulic branch of the shared Stage 6 section model. It solves
				a steady-state saturated-flow problem on the constrained triangular mesh, exposes head,
				pore-pressure, and discharge fields, and can pass FEM pore pressure back into the
				slope-stability workflow.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Seepage documentation navigation">
			<div class="docs-nav__title">Seepage</div>
			<a href="#scope">Scope and positioning</a>
			<a href="#equations">Governing equations</a>
			<a href="#inputs">Geometry, materials, and inputs</a>
			<a href="#boundary">Boundary conditions</a>
			<a href="#formulation">Finite-element formulation</a>
			<a href="#freesurface">Free surface and seepage face</a>
			<a href="#outputs">Outputs and interpretation</a>
			<a href="#coupling">Coupling to slope stability</a>
			<a href="#limits">Assumptions and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and positioning</p>
				<h2>1. Analysis class and intended engineering use</h2>
				<p>
					The public seepage route is a <strong>two-dimensional steady-state saturated-flow
					analysis</strong> on the Stage 6 section. It is intended for cross-sectional
					engineering interpretation: phreatic-line refinement, pore-pressure distribution,
					exit-gradient checking, discharge visualization, and support of slope-stability
					assessment on the same section geometry.
				</p>
				<div class="doc-callout">
					<strong>Model class.</strong> The present public route is a Darcy-flow FEM screen on a
					2D section. It is not a transient groundwater package, not an unsaturated-flow
					solver, and not a coupled hydro-mechanical consolidation analysis.
				</div>
				<div class="symbols">
					<div class="symbols__title">Primary quantities</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>h(x, y)</dt>
							<dd>Total hydraulic head [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>u(x, y)</dt>
							<dd>Pore-water pressure [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>q = (q<sub>x</sub>, q<sub>y</sub>)</dt>
							<dd>Darcy velocity or specific discharge vector [m/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>∇h</dt>
							<dd>Hydraulic gradient vector [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>k = diag(k<sub>x</sub>, k<sub>y</sub>)</dt>
							<dd>Permeability tensor aligned with the section axes in the current implementation [m/s].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The default soil source is the interpreted CPT-derived layer model unless custom polygons are enabled.</li>
					<li>The same shared measurement line used elsewhere in Stage 6 is used here for arbitrary line probing.</li>
					<li>The result may be sampled by Bishop when FEM pore pressure is explicitly enabled.</li>
				</ul>
			</section>

			<section id="equations" class="doc-card">
				<p class="section-label">Governing equations</p>
				<h2>2. Darcy flow, head field, and derived pore pressure</h2>

				<section class="doc-subsection">
					<h3>2.1 Darcy’s law</h3>
					<p>
						The seepage solver follows the classical Darcy formulation for saturated flow:
					</p>
					<div class="equations">
						<div class="formula">q = −k ∇h</div>
						<div class="formula">q<sub>x</sub> = −k<sub>x</sub> ∂h/∂x</div>
						<div class="formula">q<sub>y</sub> = −k<sub>y</sub> ∂h/∂y</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>q, q<sub>x</sub>, q<sub>y</sub></dt>
								<dd>Darcy discharge vector and its Cartesian components [m/s]</dd>
							</div>
							<div class="symbols__row">
								<dt>k, k<sub>x</sub>, k<sub>y</sub></dt>
								<dd>hydraulic conductivity tensor and its principal components [m/s]</dd>
							</div>
							<div class="symbols__row">
								<dt>h</dt>
								<dd>total hydraulic head referenced to the section datum [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>x, y</dt>
								<dd>section coordinates [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>∂h/∂x, ∂h/∂y</dt>
								<dd>head gradient components [-]</dd>
							</div>
						</dl>
					</div>
					<p>
						Here <strong>q</strong> is the Darcy velocity or specific discharge, not the
						actual pore-water velocity. In the current public workflow this distinction is
						important because the plotted discharge field is a Darcy field; no porosity-based
						seepage-velocity correction is currently exposed.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>2.2 Continuity and the steady-state PDE</h3>
					<p>
						Under steady-state conditions, continuity combined with Darcy’s law gives:
					</p>
					<div class="equations">
						<div class="formula">∂/∂x (k<sub>x</sub> ∂h/∂x) + ∂/∂y (k<sub>y</sub> ∂h/∂y) = 0</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>k<sub>x</sub>, k<sub>y</sub></dt>
								<dd>conductivity components in the section axes [m/s]</dd>
							</div>
							<div class="symbols__row">
								<dt>h</dt>
								<dd>total hydraulic head [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>x, y</dt>
								<dd>section coordinates [m]</dd>
							</div>
						</dl>
					</div>
					<p>
						For homogeneous isotropic soil, this reduces to Laplace’s equation. In the app,
						the general anisotropic region-wise form is kept because the section can contain
						multiple permeability zones.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>2.3 Head and pore pressure</h3>
					<p>
						Once the total head field is known, pore pressure follows directly:
					</p>
					<div class="equations">
						<div class="formula">u = γ<sub>w</sub>(h − y)</div>
						<div class="formula">h = y + u / γ<sub>w</sub></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>u</dt>
								<dd>pore-water pressure [kPa]</dd>
							</div>
							<div class="symbols__row">
								<dt>γ<sub>w</sub></dt>
								<dd>unit weight of water [kN/m³]</dd>
							</div>
							<div class="symbols__row">
								<dt>h</dt>
								<dd>total hydraulic head [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>y</dt>
								<dd>elevation relative to the section datum [m]</dd>
							</div>
						</dl>
					</div>
					<p>
						The public seepage route is therefore most naturally interpreted as a
						<strong>head solver</strong> with pore pressure and discharge derived afterward.
						The phreatic line is the locus where <strong>u = 0</strong>, equivalently
						<strong>h = y</strong>.
					</p>
				</section>
			</section>

			<section id="inputs" class="doc-card">
				<p class="section-label">Input model</p>
				<h2>3. Shared geometry, materials, and hydraulic inputs</h2>

				<section class="doc-subsection">
					<h3>3.1 Shared Stage 6 geometry</h3>
					<p>
						The seepage workspace does not introduce a second drawing model. It reuses the
						shared Stage 6 section geometry: terrain polyline, model base, lateral boundaries,
						soil polygons, retaining-wall geometry, and the interpreted layer state when custom
						polygons are not active.
					</p>
					<ul class="notes">
						<li>Custom polygons can locally replace the default laterally extended CPT layering.</li>
						<li>Retaining walls are represented hydraulically through permeability contrast, not as structural seepage elements. Per-wall material now carries anisotropic conductivity in the wall-local frame (k<sub>⊥</sub> across, k<sub>∥</sub> along); see §4.5.</li>
						<li>The seepage mesh is geometry-consistent with the shared Stage 6 section workflow.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>3.2 Material data</h3>
					<p>
						Each soil zone contributes hydraulic conductivity data:
					</p>
					<div class="equations">
						<div class="formula">k = diag(k<sub>x</sub>, k<sub>y</sub>)</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>k</dt>
								<dd>axis-aligned conductivity tensor [m/s]</dd>
							</div>
							<div class="symbols__row">
								<dt>k<sub>x</sub>, k<sub>y</sub></dt>
								<dd>horizontal and vertical conductivity components in the section axes [m/s]</dd>
							</div>
						</dl>
					</div>
					<p>
						The current public implementation assumes the conductivity tensor is aligned with
						the global section axes. Rotated permeability tensors are outside the current
						public scope.
					</p>
					<div class="doc-callout">
						<strong>Transparency note.</strong> The app preserves manual permeability overrides,
						uses CPT-derived representative conductivity when present, and otherwise falls back
						to a documented soil-type heuristic. This is a practical engineering workflow, not
						a substitute for laboratory or pumping-test calibration.
					</div>
				</section>

				<section class="doc-subsection">
					<h3>3.3 Hydraulic boundary inputs</h3>
					<p>
						The public route exposes head-type and no-flow-type semantics on the
						<strong>outer boundary</strong> of the section. This design keeps the model
						auditable: the engineer can see exactly where hydraulic conditions are imposed.
					</p>
				</section>
			</section>

			<section id="boundary" class="doc-card">
				<p class="section-label">Boundary conditions</p>
				<h2>4. Boundary-condition semantics in the public workflow</h2>

				<section class="doc-subsection">
					<h3>4.1 Prescribed head</h3>
					<div class="equations">
						<div class="formula">h = h<sub>0</sub> on Γ<sub>h</sub></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>h</dt>
								<dd>solved total head on the boundary [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>h<sub>0</sub></dt>
								<dd>prescribed boundary head [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>Γ<sub>h</sub></dt>
								<dd>boundary segment carrying the Dirichlet head condition</dd>
							</div>
						</dl>
					</div>
					<p>
						This is the standard Dirichlet condition. It is used for reservoir levels,
						tailwater levels, water-filled excavation boundaries, and other edges where the
						total head is known.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>4.2 No flow</h3>
					<div class="equations">
						<div class="formula">q<sub>n</sub> = 0 on Γ<sub>q</sub></div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>q<sub>n</sub></dt>
								<dd>normal Darcy flux across the boundary [m/s]</dd>
							</div>
							<div class="symbols__row">
								<dt>Γ<sub>q</sub></dt>
								<dd>boundary segment carrying the Neumann no-flow condition</dd>
							</div>
						</dl>
					</div>
					<p>
						No-flow is the natural zero-flux boundary. In the current workflow it is the
						default condition for any outer edge that has not been explicitly assigned another
						condition.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>4.3 Seepage face</h3>
					<p>
						A seepage face is a boundary segment where water may exit freely, so the pore
						pressure is atmospheric and the hydraulic head equals the elevation:
					</p>
					<div class="equations">
						<div class="formula">h = y on the active seepage face</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>h</dt>
								<dd>total head on the active seepage-face segment [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>y</dt>
								<dd>boundary elevation [m]</dd>
							</div>
						</dl>
					</div>
					<p>
						The difficulty is that the active extent is not known a priori. The public route
						therefore uses an iterative active-set style update in which the candidate seepage
						face is adjusted until the head field and active boundary extent are mutually
						compatible.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>4.4 Interior drains</h3>
					<p>
						A drain is a one-dimensional submanifold <strong>Γ<sub>d</sub> ⊂ Ω</strong> on which
						the head field is controlled by a user-specified target. The polyline is enforced as a
						constrained edge in the Triangle PSLG (marker <code>markerType: 'drain'</code>) so the
						mesh conforms to the drain trace; nodes on Γ<sub>d</sub> are then candidate Dirichlet
						sites for the seepage solver.
					</p>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>Γ<sub>d</sub></dt>
								<dd>drain trace, a polyline embedded in the analysis domain</dd>
							</div>
							<div class="symbols__row">
								<dt>H<sub>d</sub></dt>
								<dd>prescribed drain head [m]; constant per drain in the current release</dd>
							</div>
							<div class="symbols__row">
								<dt>ψ<sub>i</sub> = h<sub>i</sub> − y<sub>i</sub></dt>
								<dd>pressure head at drain node <em>i</em> [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>R<sub>i</sub></dt>
								<dd>Galerkin reaction at constrained drain node <em>i</em>; sign convention
									<strong>R<sub>i</sub> &lt; 0</strong> = water leaving the domain (drain
									collecting)</dd>
							</div>
						</dl>
					</div>
					<p>Three gating modes are exposed:</p>
					<ul class="notes">
						<li><strong><code>always</code></strong> — Γ<sub>d</sub> enforces <strong>h = H<sub>d</sub></strong> at every accepted Newton iterate, independent of pressure state. Appropriate when the drain is permanently below the water table and extraction direction is known a priori.</li>
						<li><strong><code>when-saturated</code></strong> — Dirichlet on Γ<sub>d</sub> is gated by a hysteretic pressure-and-flux active set, in direct analogy with the outer-boundary seepage-face logic. A node activates when <strong>ψ<sub>i</sub> ≥ ψ<sub>activate</sub></strong> and the predicted reaction does not indicate injection; it deactivates when ψ<sub>i</sub> falls below −ψ<sub>keep</sub> or the reaction crosses the injection threshold. Mirrors a relief drain above the water table.</li>
						<li><strong><code>head-cap</code></strong> — one-way head capping. Operationally a linear complementarity problem on Γ<sub>d</sub>:</li>
					</ul>
					<div class="equations">
						<div class="formula">h<sub>i</sub> − H<sub>d</sub> ≤ 0,&nbsp;&nbsp; R<sub>i</sub> ≤ 0,&nbsp;&nbsp; (h<sub>i</sub> − H<sub>d</sub>)·R<sub>i</sub> = 0&nbsp;&nbsp;&nbsp;∀ i ∈ Γ<sub>d</sub></div>
					</div>
					<p>
						These are the Karush–Kuhn–Tucker conditions of an obstacle problem: the head is capped
						at <strong>H<sub>d</sub></strong>, the drain may only extract, and complementarity
						forces each node into either slack (<strong>h<sub>i</sub> &lt; H<sub>d</sub></strong>,
						<strong>R<sub>i</sub> = 0</strong>) or active-at-cap
						(<strong>h<sub>i</sub> = H<sub>d</sub></strong>, <strong>R<sub>i</sub> &lt; 0</strong>).
						The system is solved by a primal–dual active-set semismooth Newton loop run jointly
						with the outer-boundary seepage-face active set; the joint iteration terminates when
						the combined mask signature is stable or has entered a two-cycle, with an iteration
						cap as a final safeguard.
					</p>
					<div class="doc-callout">
						<strong>Discharge.</strong> Per-drain inflow is reported as a two-element-sided Darcy
						flux integral across each drain mesh edge, summed over Γ<sub>d</sub>. The reaction
						sum <strong>Q<sub>R</sub> = −Σ R<sub>i</sub></strong> over active nodes is computed in
						parallel as a self-test and must agree with the per-edge integral to FEM
						mass-balance accuracy. Reported values are <strong>m²/s</strong> per metre of
						out-of-plane length, consistent with the plane-strain convention.
					</div>
					<p>
						Drain ↔ wall geometry handles weep-hole configurations explicitly: drain segments may
						share boundary edges with a wall polygon, in which case the drain Dirichlet wins at
						the shared nodes and the wall material continues to govern element assembly off Γ<sub>d</sub>.
						Drains buried inside or bisecting a wall polygon are rejected at validation.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>4.5 Per-wall hydraulic conductivity</h3>
					<p>
						Each retaining wall carries its own material with anisotropic conductivity in the
						wall-local (across, along) frame:
					</p>
					<div class="equations">
						<div class="formula">K<sub>wall</sub><sup>local</sup> = diag(k<sub>⊥</sub>, k<sub>∥</sub>) ≡ diag(k<sub>across</sub>, k<sub>along</sub>)</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>k<sub>⊥</sub></dt>
								<dd>across-wall conductivity [m/s]; controls leakage normal to the wall plane</dd>
							</div>
							<div class="symbols__row">
								<dt>k<sub>∥</sub></dt>
								<dd>along-wall conductivity [m/s]; controls leakage along the wall axis (sheet-pile joints, slurry-wall vertical pathways)</dd>
							</div>
						</dl>
					</div>
					<p>
						For the axis-aligned vertical walls supported in the current public route, the
						global-frame tensor is <strong>K<sub>wall</sub><sup>global</sup> = diag(k<sub>⊥</sub>, k<sub>∥</sub>)</strong>
						and the element conductivity matrix is unchanged in form. General-orientation walls
						require the full 2×2 tensor in the element matrix and are deferred.
					</p>
					<p>Five engineering presets are exposed:</p>
					<ul class="notes">
						<li><strong>Sheet pile</strong> — k<sub>⊥</sub> ≈ 10<sup>−10</sup> m/s, k<sub>∥</sub> ≈ 10<sup>−8</sup> m/s. Joint leakage along the sheet interlocks is a small but non-negligible vertical pathway.</li>
						<li><strong>Slurry / diaphragm wall</strong> — isotropic 10<sup>−9</sup> m/s.</li>
						<li><strong>Soil-mix wall</strong> — isotropic 10<sup>−7</sup> m/s.</li>
						<li><strong>Relief wall</strong> — 10<sup>−6</sup> to 10<sup>−5</sup> m/s. Deliberate leakage by design.</li>
						<li><strong>Legacy impermeable</strong> — k<sub>⊥</sub> = k<sub>∥</sub> = 10<sup>−10</sup> m/s. Back-fill default for saved projects predating per-wall material; result identical to the legacy hard-coded cut-off within FEM tolerance.</li>
					</ul>
					<div class="doc-callout doc-callout--warn">
						<strong>Numerical floor.</strong> The element-matrix conductivity floor is
						<strong>10<sup>−20</sup> m/s</strong>, set to keep the assembled system non-singular.
						In practice a wall conductivity below <strong>10<sup>−10</sup> × k<sub>soil,min</sub></strong>
						is asymptotically indistinguishable from a hard cut-off and degrades CG convergence
						without changing the head field; the UI flags this as the practical floor.
					</div>
				</section>
			</section>

			<section id="formulation" class="doc-card">
				<p class="section-label">Finite-element formulation</p>
				<h2>5. T3 formulation, assembly, and solution strategy</h2>

				<section class="doc-subsection">
					<h3>5.1 Element family</h3>
					<p>
						The public seepage route uses three-node linear triangles. The head field is
						interpolated linearly over each element, and the hydraulic gradient is therefore
						constant within an individual triangle.
					</p>
					<div class="doc-callout">
						<strong>Interpretation consequence.</strong> The plotted head field is nodal and
						continuous, but <strong>|∇h|</strong>, <strong>|q|</strong>, and the directional
						discharge components are piecewise constant at the element level before contour
						post-processing.
					</div>
				</section>

				<section class="doc-subsection">
					<h3>5.2 Element conductivity matrix</h3>
					<p>
						For each T3 element, the conductivity matrix is assembled in the standard form:
					</p>
					<div class="equations">
						<div class="formula">K<sub>e</sub> = ∫<sub>Ωe</sub> B<sup>T</sup> D B dΩ</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>K<sub>e</sub></dt>
								<dd>element conductivity matrix [m/s] for unit out-of-plane thickness</dd>
							</div>
							<div class="symbols__row">
								<dt>Ω<sub>e</sub></dt>
								<dd>element area [m²]</dd>
							</div>
							<div class="symbols__row">
								<dt>B</dt>
								<dd>head-gradient matrix of the T3 shape functions [1/m]</dd>
							</div>
							<div class="symbols__row">
								<dt>D</dt>
								<dd>element conductivity tensor [m/s]</dd>
							</div>
						</dl>
					</div>
					<p>
						where <strong>D</strong> is the element conductivity tensor and
						<strong>B</strong> is the gradient matrix associated with the linear head shape
						functions.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>5.3 Global assembly and BC application</h3>
					<p>
						The global head system is assembled from the element matrices and then modified for
						the imposed Dirichlet conditions. The resulting linear system is symmetric positive
						definite under the normal well-posed seepage configurations used in the public app.
					</p>
				</section>

				<section class="doc-subsection">
					<h3>5.4 Mesh generation and region tagging</h3>
					<p>
						The mesh is built from the constrained section geometry. Material regions are
						preserved as meshing constraints, so hydraulic interfaces remain explicit in the FE
						model. Region tagging determines which conductivity tensor is assigned to each
						element.
					</p>
				</section>
			</section>

			<section id="freesurface" class="doc-card">
				<p class="section-label">Free surface</p>
				<h2>6. Free-surface iteration and seepage-face activation</h2>
				<p>
					Unconfined flow introduces nonlinearity because the extent of the saturated domain is
					part of the solution. The current public route avoids remeshing on every iteration by
					using a practical active/inactive treatment of wet and dry regions together with the
					seepage-face update.
				</p>
				<ul class="notes">
					<li>The entire section is meshed once; the wet or dry interpretation is updated iteratively.</li>
					<li>The seepage face is activated only where the solution indicates outward drainage under atmospheric pressure.</li>
					<li>The public route is therefore a practical engineering free-surface approximation, not a fully general transient saturation algorithm.</li>
				</ul>
			</section>

			<section id="outputs" class="doc-card">
				<p class="section-label">Outputs and interpretation</p>
				<h2>7. Head, pore pressure, discharge, and arbitrary line probes</h2>

				<section class="doc-subsection">
					<h3>7.1 Canvas fields</h3>
					<div class="doc-table-wrap">
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>Field</th>
										<th>Meaning</th>
										<th>Interpretation note</th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<td>h</td>
										<td>Total head</td>
										<td>Primary solved nodal field.</td>
									</tr>
									<tr>
										<td>u</td>
										<td>Pore pressure</td>
										<td>Derived from <code>u = γw(h - y)</code>.</td>
									</tr>
									<tr>
										<td>|∇h|</td>
										<td>Hydraulic-gradient magnitude</td>
										<td>Element-wise constant before contour post-processing.</td>
									</tr>
									<tr>
										<td>|q|, q<sub>x</sub>, q<sub>y</sub></td>
										<td>Darcy discharge field</td>
										<td>Specific discharge, not pore-water velocity.</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>7.2 Shared line probe</h3>
					<p>
						The shared Stage 6 measurement line doubles as a seepage probe. It can sample head,
						pore pressure, gradient magnitude, discharge magnitude, directional discharge
						components, and the line-normal discharge:
					</p>
					<div class="equations">
						<div class="formula">q<sub>n</sub> = q · n</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>q<sub>n</sub></dt>
								<dd>probe-normal Darcy discharge component [m/s]</dd>
							</div>
							<div class="symbols__row">
								<dt>q</dt>
								<dd>Darcy discharge vector at the sampled point [m/s]</dd>
							</div>
							<div class="symbols__row">
								<dt>n</dt>
								<dd>unit normal to the user-defined probe line [-]</dd>
							</div>
						</dl>
					</div>
					<p>
						Because <strong>q<sub>n</sub></strong> depends on probe orientation, it is
						intentionally a line quantity rather than a global contour variable.
					</p>
				</section>
			</section>

			<section id="coupling" class="doc-card">
				<p class="section-label">Coupling</p>
				<h2>8. Coupling of seepage results to slope stability</h2>
				<p>
					The seepage result can replace the simple hydrostatic pore-pressure interpretation in
					the Bishop workflow. When enabled, slice-base pore pressure is sampled from the FEM
					field rather than from the drawn phreatic line alone.
				</p>
				<div class="doc-callout">
					<strong>Important.</strong> This coupling is opt-in. If no seepage result exists, or if
					a requested point lies outside the seepage solution domain, the stability workflow
					falls back to its hydrostatic interpretation rather than silently failing.
				</div>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Assumptions and limitations</p>
				<h2>9. Transparent modeling boundaries</h2>
				<ul class="notes">
					<li>The public seepage route is steady-state only.</li>
					<li>Unsaturated flow, suction, and Richards-equation behavior are not exposed.</li>
					<li>No hydro-mechanical coupling is exposed in the public workflow.</li>
					<li>Permeability anisotropy in soil regions is axis-aligned in the current implementation. Wall material now exposes an anisotropic (k<sub>⊥</sub>, k<sub>∥</sub>) tensor in the wall-local frame; general-orientation walls requiring a full 2×2 global tensor are deferred.</li>
					<li>Head-prescribed interior drains with three gating modes (<code>always</code>, <code>when-saturated</code>, <code>head-cap</code>) are supported through a Dirichlet active-set on the conforming PSLG. Flow-prescribed line sinks (<strong>q = −Q&nbsp;δ(x − x<sub>w</sub>)</strong>), finite-resistance Cauchy drains (<strong>q = β(h − H<sub>d</sub>)</strong>), and drain-water-level coupling to an outlet elevation are not yet exposed.</li>
					<li>The route is intended for engineering screening and coupled interpretation, not as a replacement for a dedicated regional hydrogeological model.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>10. Reference basis</h2>
				<ul class="reference-list">
					<li><strong>Darcy, H. (1856)</strong> — foundational law for saturated flow through porous media.</li>
					<li><strong>EN 1997-1</strong> — Eurocode 7 hydraulic-heave and piping context for geotechnical interpretation.</li>
					<li><strong>Bear, J.</strong> <em>Hydraulics of Groundwater</em>. McGraw-Hill, 1979. ISBN 0-07-004170-9. Reference for anisotropic Darcy flow and the wall-local conductivity tensor framing in §4.5.</li>
					<li><strong>Bathe, K.-J., and Khoshgoftaar, M. R.</strong> "Finite Element Free Surface Seepage Analysis Without Mesh Iteration." <em>International Journal for Numerical and Analytical Methods in Geomechanics</em>, 3(1), 13–22, 1979. DOI: 10.1002/nag.1610030103. Reference for the fixed-mesh wet/dry residual-flow approach used in <code>iterate</code> mode and shared by the drain active-set update.</li>
					<li><strong>Hintermüller, M., Ito, K., and Kunisch, K.</strong> "The Primal-Dual Active Set Strategy as a Semismooth Newton Method." <em>SIAM Journal on Optimization</em>, 13(3), 865–888, 2002. DOI: 10.1137/S1052623401383558. Mathematical basis for the <code>head-cap</code> LCP solver and its joint coupling with the outer seepage-face active set in §4.4.</li>
					<li><strong>Standard finite-element seepage formulations</strong> — the present route follows the classical T3 Darcy/Laplace formulation documented in the project seepage specification.</li>
					<li><strong>GeoStudio / SEEP/W style free-surface practice</strong> — relevant as background for the practical active-set and reduced-dry-zone style interpretation used in engineering seepage workflows.</li>
				</ul>
				<p class="refs-inline">
					For the exhaustive derivation, pseudocode, and implementation-specific notes, continue
					to the <a href="/docs/full">full seepage reference section</a>.
				</p>
			</section>
		</main>
	</div>
</div>
