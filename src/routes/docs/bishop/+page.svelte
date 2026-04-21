<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Bishop + Spencer — Engineering Note';
	const pageDescription =
		'Engineering note for the Stage 6 circular slope-stability workflow in the CPT app: Bishop search, Spencer verification, implemented algebra, report outputs, and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs/bishop';
	const ogImageUrl = 'https://cpt.madep.be/logo.png';

	const sections = [
		{ id: 'scope', title: '1. Scope and present model' },
		{ id: 'coordinates', title: '2. Coordinates and sign conventions' },
		{ id: 'geometry', title: '3. Geometry and soil model' },
		{ id: 'search', title: '4. Slip-circle search and validity filters' },
		{ id: 'slices', title: '5. Slice generation and multi-layer handling' },
		{ id: 'theory', title: '6. Implemented theory and algebra' },
		{ id: 'implementation', title: '7. Present Stage 6 implementation' },
		{ id: 'canvas', title: '8. Interactive canvas workflow' },
		{ id: 'verification', title: '9. Verification and testing' },
		{ id: 'limits', title: '10. Limitations and next steps' },
		{ id: 'references', title: 'References' }
	];
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
			</nav>
		</div>
	</header>

	<header class="hero">
		<div class="hero__inner">
			<p class="hero__eyebrow">Engineering note</p>
			<h1>Bishop and Spencer</h1>
			<p class="hero__lead">
				A technical note on the Stage 6 circular slope-stability workflow: terrain and phreatic
				geometry, soil regions derived from the active CPT, Bishop shortlist search, Spencer
				recheck, implemented slice algebra, and the behaviour of the interactive canvas.
			</p>
			<div class="hero__actions">
				<a class="btn btn--primary" href="/">Open the app</a>
				<a class="btn btn--outline-dark" href="#scope">Read the theory</a>
			</div>
			<div class="hero__trust">
				<span>Circular slip surfaces</span>
				<span>Bishop + Spencer</span>
				<span>Present implementation logic</span>
			</div>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Documentation navigation">
			<div class="docs-nav__title">Pages</div>
			<a href="/docs">Main theory</a>
			<a href="/docs/bishop" aria-current="page">Bishop simplified</a>
			<div class="docs-nav__title" style="margin-top:18px">On this page</div>
			{#each sections as section}
				<a href={`#${section.id}`}>{section.title}</a>
			{/each}
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Section</p>
				<h2>1. Scope and present model</h2>
				<p>
					The Stage 6 slope module is a <strong>two-dimensional circular-slip</strong>
					limit-equilibrium tool built around a <strong>Bishop Simplified search</strong> with an
					optional <strong>Spencer verification pass</strong>. In the present implementation, the
					engineer may run either <strong>Bishop only</strong> or
					<strong>Bishop + Spencer check</strong>.
				</p>
				<p>
					The present workflow employs the <strong>active CPT only</strong> as the soil source.
					The interpreted layer column from Stages 2 to 5 is converted into a slope soil model by
					extending those layers horizontally across the drawn section. Terrain, phreatic line,
					optional surcharge zone, and the entry and exit zones are then supplied by the Stage 6
					canvas.
				</p>
				<div class="doc-callout">
					<strong>Present scope.</strong> The present Stage 6 module is limited to circular slip
					surfaces, self-weight loading, one optional uniform vertical surcharge zone, and
					optional pore pressure from the drawn hydrostatic phreatic line or, when the seepage
					workspace has been solved and enabled, sampled FEM seepage pore pressure. Spencer is
					implemented for shortlisted circular surfaces only. Seismic loading, reinforcement,
					non-circular surfaces, and Morgenstern&ndash;Price do not form part of the present
					implementation.
				</div>
				<div class="doc-callout">
					<strong>Present load model.</strong> The load feature comprises one optional
					<strong>uniform vertical surcharge zone</strong> drawn on the terrain with the same
					two-click workflow as the entry and exit zones. It is interpreted as a strip surcharge
					over a finite horizontal interval, and not as a concentrated point load or an inclined
					load.
				</div>
				<div class="equations">
					<div class="formula">
						2D cross-section, unit width, circular slip surfaces, self-weight plus one optional
						uniform surcharge zone, with Bishop search and optional Spencer recheck
					</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt><em>F</em></dt>
							<dd>factor of safety [-]</dd>
						</div>
						<div class="symbols__row">
							<dt><em>c</em>′, φ′</dt>
							<dd>effective strength parameters [kPa, °]</dd>
						</div>
						<div class="symbols__row">
							<dt>γ, γ<sub>sat</sub></dt>
							<dd>dry and saturated unit weight [kN/m³]</dd>
						</div>
						<div class="symbols__row">
							<dt><em>u</em></dt>
							<dd>pore-water pressure on the slice base [kPa]</dd>
						</div>
						<div class="symbols__row">
							<dt><em>q</em></dt>
							<dd>uniform surcharge intensity on a drawn terrain interval [kPa = kN/m²]</dd>
						</div>
						<div class="symbols__row">
							<dt><em>Q</em><sub>i</sub></dt>
							<dd>vertical surcharge contribution acting on slice <em>i</em> [kN/m]</dd>
						</div>
						<div class="symbols__row">
							<dt><em>V</em><sub>i</sub></dt>
							<dd>total vertical slice load, with self-weight and surcharge included [kN/m]</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The Bishop module sits within the existing Stage 6 state and therefore preserves the interpreted CPT workflow.</li>
					<li>The full search is always executed with Bishop Simplified; Spencer is applied only to the shortlisted circles.</li>
					<li>The exposed search mode is entry-exit search; no separate centre-grid mode is presently exposed in the interface.</li>
					<li>The present implementation remains experimental, but it forms part of the visible Stage 6 workflow and the Stage 7 report payload.</li>
				</ul>
			</section>

			<section id="coordinates" class="doc-card">
				<p class="section-label">Section</p>
				<h2>2. Coordinates and sign conventions</h2>
				<p>
					The Bishop canvas uses world coordinates with <em>x</em> positive to the right and
					<em>y</em> positive upward. Terrain, phreatic line, entry zone, exit zone, and slip
					circles are all defined in that same world system. Screen pan and zoom are applied only
					in the rendering layer; the solver itself receives world coordinates only.
				</p>
				<p>
					The present implementation stores a signed base angle per slice. The sign is taken
					relative to the chosen movement direction from entry to exit, so the same circular
					geometry can be evaluated consistently whether the active branch lies on the lower or
					upper half of the parent circle.
				</p>
				<div class="equations">
					<div class="formula">x → right, y → upward</div>
					<div class="formula">
						α<sub>i</sub> = atan(−(dy/dx)<sub>base,i</sub> · sign(x<sub>exit</sub> − x<sub>entry</sub>))
					</div>
				</div>
				<div class="doc-callout doc-callout--warn">
					<strong>Implementation note.</strong> Unsigned base angles are no longer enforced. The
					signed-angle convention is essential for circles that pass across the lowest point of
					the arc, because the sign of α changes over the span and directly affects the Bishop
					driving term.
				</div>
			</section>

			<section id="geometry" class="doc-card">
				<p class="section-label">Section</p>
				<h2>3. Geometry and soil model</h2>

				<section class="doc-subsection">
					<h3>3.1 Terrain and phreatic polyline</h3>
					<p>
						The terrain is a user-drawn x-monotonic polyline. The application enforces
						left-to-right vertex ordering, and the terrain is queried by linear interpolation.
						The optional phreatic surface is another polyline in the same coordinate system.
					</p>
					<div class="equations">
						<div class="formula">
							y(x) = y<sub>j</sub> + (y<sub>j+1</sub> − y<sub>j</sub>) · (x − x<sub>j</sub>) / (x<sub>j+1</sub> − x<sub>j</sub>)
						</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>3.2 Soil model from the active CPT</h3>
					<p>
						The present application does <strong>not</strong> interpolate between multiple CPTs.
						Instead, it takes the active interpreted layer column and extends it horizontally
						across the full Bishop model width. The top band follows the drawn terrain, the
						intermediate bands are horizontal at the layer boundary elevations referenced to the
						active CPT position, and the deepest band extends down to the selected Bishop
						analysis depth.
					</p>
					<p>
						The analysis depth defaults to the <strong>CPT depth or 15 m</strong>, whichever is
						greater. If the engineer elects to analyse to a greater depth, the bottom layer is
						simply extrapolated downward.
					</p>
					<div class="equations">
						<div class="formula">
							y<sub>ground,CPT</sub> = y<sub>terrain</sub>(x<sub>CPT</sub>)
						</div>
						<div class="formula">
							y<sub>boundary,k</sub> = y<sub>ground,CPT</sub> − z<sub>boundary,k</sub>
						</div>
						<div class="formula">
							y<sub>bottom</sub> = y<sub>ground,CPT</sub> − max(z<sub>CPT,max</sub>, 15)
							&nbsp;&nbsp; by default
						</div>
					</div>
					<ul class="notes">
						<li>The first band follows terrain at the top boundary.</li>
						<li>Lower bands are clipped so they never extend above terrain.</li>
						<li>The present implementation builds closed, non-overlapping band polygons for rendering and region inspection.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>3.3 Material sets and design values</h3>
					<p>
						Bishop materials are imported automatically from the active CPT layers. The user may
						select between <strong>Characteristic</strong>,
						<strong>DA1/1 (M1)</strong>, and <strong>DA1/2 (M2)</strong>. For the design-value
						sets, the module reuses the same soil-parameter reduction logic as the remainder of
						Stage 6 before assigning Bishop base materials.
					</p>
					<div class="doc-table-wrap">
						<p class="doc-table-caption">Bishop material source modes used in the present implementation.</p>
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>Mode</th>
										<th>Meaning in the present implementation</th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<td>Characteristic</td>
										<td>Imports layer c′, φ′, γ, and γ<sub>sat</sub> directly from the active CPT interpretation.</td>
									</tr>
									<tr>
										<td>DA1/1 (M1)</td>
										<td>Imports the layer after applying the M1 soil-side design route.</td>
									</tr>
									<tr>
										<td>DA1/2 (M2)</td>
										<td>Imports the layer after applying the M2 soil-side design route.</td>
									</tr>
								</tbody>
							</table>
						</div>
					</div>
				</section>
			</section>

			<section id="search" class="doc-card">
				<p class="section-label">Section</p>
				<h2>4. Slip-circle search and validity filters</h2>

				<section class="doc-subsection">
					<h3>4.1 Entry-exit parameterization</h3>
					<p>
						The exposed v1 workflow is based on <strong>entry-exit search</strong>. The user
						draws an entry zone and an exit zone on the terrain. The application samples points
						along both zones, forms the entry-exit chord, and thereafter samples candidate
						circle centres on the perpendicular bisector of that chord.
					</p>
					<div class="equations">
						<div class="formula">
							R = |C − E| = |C − X|
						</div>
						<div class="formula">
							C = M + s · t · n̂
						</div>
						<div class="formula">
							M = (E + X) / 2
						</div>
					</div>
					<div class="symbols">
						<div class="symbols__title">Notation</div>
						<dl class="symbols__list">
							<div class="symbols__row">
								<dt>E, X</dt>
								<dd>entry and exit point on the terrain [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>C</dt>
								<dd>trial circle centre [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>M</dt>
								<dd>midpoint of the entry-exit chord [m]</dd>
							</div>
							<div class="symbols__row">
								<dt>n̂</dt>
								<dd>unit normal to the chord [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>s</dt>
								<dd>sign of the bisector direction, ±1 [-]</dd>
							</div>
							<div class="symbols__row">
								<dt>t</dt>
								<dd>center offset along the bisector [m]</dd>
							</div>
						</dl>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>4.2 Circle admissibility</h3>
					<p>
						Each trial circle is validated before slice generation. The active branch is chosen
						first, whereafter the circle is retained only if it daylights at the intended entry
						and exit points and remains below terrain in between.
					</p>
					<ul class="notes">
						<li>Exactly two terrain intersections are required inside the entry-exit span.</li>
						<li>Those two intersections must coincide with the chosen entry and exit points within tolerance.</li>
						<li>The active branch must remain below the terrain between entry and exit.</li>
						<li>The maximum slip thickness must exceed the user threshold.</li>
						<li>The absolute exit angle must remain below the user threshold.</li>
						<li>The Bishop iteration itself must converge and keep m<sub>α</sub> above the minimum admissible value.</li>
					</ul>
					<div class="equations">
						<div class="formula">
							|P<sub>intersection</sub> − E| ≤ tol, &nbsp; |P<sub>intersection</sub> − X| ≤ tol
						</div>
						<div class="formula">
							max(y<sub>terrain</sub>(x) − y<sub>slip</sub>(x)) ≥ h<sub>min</sub>
						</div>
						<div class="formula">
							|α<sub>exit</sub>| ≤ α<sub>exit,max</sub>
						</div>
					</div>
				</section>
			</section>

			<section id="slices" class="doc-card">
				<p class="section-label">Section</p>
				<h2>5. Slice generation and multi-layer handling</h2>

				<section class="doc-subsection">
					<h3>5.1 Slice boundaries</h3>
					<p>
						The implementation commences from an equally spaced slice backbone and then inserts
						additional cut positions at every relevant x-location: terrain vertices, phreatic
						vertices, slip-circle intersections with horizontal layer boundaries, and phreatic
						intersections with the active slip branch. The resulting cut set is then cleaned
						against a minimum slice width.
					</p>
					<div class="equations">
						<div class="formula">
							x<sub>cuts</sub> = &#123;x<sub>entry</sub>, x<sub>exit</sub>, x<sub>backbone</sub>, x<sub>terrain breaks</sub>, x<sub>layer intersections</sub>, x<sub>phreatic intersections</sub>&#125;
						</div>
					</div>
					<div class="doc-callout">
						<strong>Current surcharge rule.</strong> The load-zone start and end x-coordinates are
						also treated as mandatory cut positions so the applied load is not smeared across
						slices that only partly overlap the loaded interval.
					</div>
				</section>

				<section class="doc-subsection">
					<h3>5.2 Slice geometry and base material</h3>
					<p>
						For each slice, the top is the terrain, the base is the active circular branch, and the
						base material is found by probing slightly into the sliding mass just above the base at
						the slice midpoint.
					</p>
					<div class="equations">
						<div class="formula">
							b<sub>i</sub> = Δx<sub>i</sub>, &nbsp;&nbsp; l<sub>i</sub> = Δx<sub>i</sub> / cos α<sub>i</sub>
						</div>
					</div>
				</section>

				<section class="doc-subsection">
					<h3>5.3 Multi-layer slices in the present implementation</h3>
					<p>If a slice body passes through more than one soil layer, the present implementation handles it in the standard Bishop v1 manner:</p>
					<ul class="notes">
						<li><strong>Weight</strong> includes contributions from <em>all</em> layers intercepted by the slice body.</li>
						<li><strong>Strength</strong> uses the material at the <em>slice base</em> only.</li>
					</ul>
					<p>
						The present implementation computes layer-wise slice weight by integrating the
						overlapped band thickness and unit weight across the slice width by Simpson
						integration. It also stores the per-layer breakdown in <code>layerAreas</code> for
						inspection in the user interface.
					</p>
					<div class="equations">
						<div class="formula">
							W<sub>i</sub> = Σ<sub>j</sub> W<sub>ij</sub>
						</div>
						<div class="formula">
							W<sub>ij</sub> ≈ ∫ γ<sub>j</sub>(x) · t<sub>ij</sub>(x) dx
						</div>
						<div class="formula">
							(c′<sub>i</sub>, φ′<sub>i</sub>) = material at the slice base midpoint
						</div>
					</div>
					<div class="doc-callout">
						<strong>Present behaviour.</strong> The application attempts to place slice cuts at
						horizontal layer-boundary intersections so that one soil type remains along each base
						segment. If a very narrow interval is later merged by the minimum-slice-width
						cleanup, the strength side falls back to the material at the base midpoint.
					</div>
				</section>
			</section>

			<section id="theory" class="doc-card">
				<p class="section-label">Section</p>
				<h2>6. Implemented theory and algebra</h2>
				<p>
					This section documents the <strong>algebra actually used by the application</strong>.
					It is deliberately narrower than a full textbook treatment: the production code solves
					a circular Bishop equation for every trial surface, then optionally performs a Spencer
					force-equilibrium check on the shortlisted circles and reranks those results.
				</p>
				<section class="doc-subsection">
					<h3>6.1 Bishop equation actually solved in the present implementation</h3>
					<p>
						The Bishop search uses the slice vertical load
						<em>V</em><sub>i</sub> = <em>W</em><sub>i</sub> + <em>Q</em><sub>i</sub>, where
						<em>W</em><sub>i</sub> is the integrated self-weight and <em>Q</em><sub>i</sub> is
						the surcharge overlap load for the slice. The factor of safety is obtained from the
						fixed-point form set out below.
					</p>
					<div class="equations">
						<div class="formula">
							m<sub>α,i</sub>(F) = cosα<sub>i</sub> + [sinα<sub>i</sub> tanφ′<sub>i</sub>] / F
						</div>
						<div class="formula">
							F =
							Σ[(c′<sub>i</sub>b<sub>i</sub> + (V<sub>i</sub> − u<sub>i</sub>b<sub>i</sub>)tanφ′<sub>i</sub>) / m<sub>α,i</sub>(F)]
							/
							Σ[V<sub>i</sub> sinα<sub>i</sub>]
						</div>
					</div>
						<div class="doc-callout">
							<strong>Algebra form used in the solver.</strong> The Bishop fixed-point iteration
							is evaluated in the width form c′<sub>i</sub>b<sub>i</sub> and
							u<sub>i</sub>b<sub>i</sub>. These are exact projections of the textbook
							length-form quantities c′<sub>i</sub>l<sub>i</sub> and
							u<sub>i</sub>l<sub>i</sub> via l<sub>i</sub>cosα<sub>i</sub> = b<sub>i</sub>,
							after the moment equation is divided by cosα<sub>i</sub>. Width form and
							length form are therefore algebraically equivalent for circular surfaces; the
							choice is one of bookkeeping, not of theory. The Fellenius seed and the Spencer
							recheck in §6.3 still use the true base length l<sub>i</sub> where the
							Mohr-Coulomb law is expressed directly, keeping both conventions visible in the code.
						</div>
					<p>
						In the present code, <em>b</em><sub>i</sub> = Δx<sub>i</sub> is the horizontal
						slice width and <em>l</em><sub>i</sub> = Δx<sub>i</sub>/cosα<sub>i</sub> is still
						stored as the geometric base length. The Bishop iteration itself, however, is
						evaluated in the width form shown above.
					</p>
				</section>
				<section class="doc-subsection">
					<h3>6.2 Seed and slice diagnostics</h3>
					<p>
						The recorded Fellenius seed is evaluated on the <strong>true base length</strong>,
						even though the governing Bishop fixed-point iteration itself remains in the width
						form shown above:
					</p>
					<div class="equations">
						<div class="formula">
							F<sub>fellenius</sub> =
							Σ[c′<sub>i</sub>l<sub>i</sub> + (V<sub>i</sub>cosα<sub>i</sub> − u<sub>i</sub>l<sub>i</sub>)tanφ′<sub>i</sub>]
							/
							Σ[V<sub>i</sub> sinα<sub>i</sub>]
						</div>
					</div>
					<p>
						If that Fellenius value is non-finite or non-positive, the Bishop iteration falls
						back to the configured initial factor of safety; the raw Fellenius value is still
						retained as a QA diagnostic. After convergence, the application back-calculates the
						Bishop slice <strong>total normal force</strong> and mobilised shear for reporting by
						the same width-based algebra:
					</p>
					<div class="equations">
						<div class="formula">
							N<sub>i</sub> =
							[V<sub>i</sub> − ((c′<sub>i</sub>b<sub>i</sub> − u<sub>i</sub>b<sub>i</sub>tanφ′<sub>i</sub>)sinα<sub>i</sub>) / F]
							/
							m<sub>α,i</sub>(F)
						</div>
						<div class="formula">
							T<sub>i</sub> =
							[c′<sub>i</sub>b<sub>i</sub> + (N<sub>i</sub> − u<sub>i</sub>b<sub>i</sub>)tanφ′<sub>i</sub>] / F
						</div>
					</div>
					<p>
						These are the values exposed in the Stage 6 slice table for the selected Bishop
						result. They do not constitute an independent solver; they are diagnostics
						consistent with the governing Bishop equation used by the application. When a
						Spencer result is displayed, the normal-force column switches to the Spencer
						<strong>effective normal</strong> N′ rather than reusing the Bishop total-normal
						diagnostic.
					</p>
				</section>
				<section class="doc-subsection">
					<h3>6.3 Spencer algebra used for the recheck</h3>
						<p>
							For circular surfaces, the application now performs a <strong>full Spencer
							solve</strong>. The Bishop result is retained as a search engine and comparison
							value, but not as the Spencer moment branch:
						</p>
						<p>
							For circular surfaces with radius <em>R</em> and centre <em>C</em>, the two
							branch residuals are written explicitly as:
						</p>
						<div class="equations">
							<div class="formula">
								R<sub>m</sub>(F, &lambda;) = R · [ΣS<sub>i</sub> − ΣV<sub>i</sub> sinα<sub>i</sub>]
							</div>
							<div class="formula">
								R<sub>f</sub>(F, &lambda;) = E<sub>n,right</sub>
							</div>
							<div class="formula">
								S<sub>i</sub> = [c′<sub>i</sub>l<sub>i</sub> + N′<sub>i</sub>tanφ′<sub>i</sub>] / F
							</div>
						</div>
						<p>
							For a given trial factor of safety <em>F</em> and a constant interslice-force ratio
							&lambda; = <em>X</em>/<em>E</em>, the application propagates slice forces from left
							to right with <em>E</em><sub>0</sub> = 0, computes both the force-closure residual
							and the overall moment residual, and then solves the two Spencer branches
							<em>F</em><sub>m</sub>(&lambda;) and <em>F</em><sub>f</sub>(&lambda;). The moment
							branch <em>F</em><sub>m</sub>(&lambda;) is the factor of safety for which
							ΣS<sub>i</sub> = ΣV<sub>i</sub> sinα<sub>i</sub> at the fixed &lambda;. The force
							branch <em>F</em><sub>f</sub>(&lambda;) is the factor of safety for which
							<em>E</em> propagated left-to-right with <em>X</em> = &lambda;<em>E</em> closes to
							zero at the last slice.
						</p>
						<div class="equations">
							<div class="formula">
							a<sub>1,i</sub> = sinα<sub>i</sub> − [tanφ′<sub>i</sub> cosα<sub>i</sub>] / F
						</div>
						<div class="formula">
							a<sub>0,i</sub> = E<sub>L,i</sub> + u<sub>i</sub>b<sub>i</sub>tanα<sub>i</sub> − c′<sub>i</sub>b<sub>i</sub> / F
						</div>
							<div class="formula">
								N′<sub>i</sub> =
								[V<sub>i</sub> + &lambda;E<sub>L,i</sub> − &lambda;a<sub>0,i</sub> − u<sub>i</sub>b<sub>i</sub> − c′<sub>i</sub>b<sub>i</sub>tanα<sub>i</sub>/F]
								/
								[m<sub>α,i</sub>(F) + &lambda;a<sub>1,i</sub>]
							</div>
							<div class="formula">
								E<sub>R,i</sub> = a<sub>0,i</sub> + a<sub>1,i</sub>N′<sub>i</sub>
						</div>
						<div class="formula">
							X<sub>R,i</sub> = &lambda;E<sub>R,i</sub>
						</div>
					</div>
						<p>
							For a fixed &lambda;, the application finds <em>F</em><sub>m</sub>(&lambda;) from
							the Spencer moment residual and <em>F</em><sub>f</sub>(&lambda;) from the final
							force-closure residual <em>E</em><sub>final</sub> = <em>E</em><sub>R,n</sub>.
							Because both the resisting term ΣS<sub>i</sub> and the driving term
							ΣV<sub>i</sub> sinα<sub>i</sub> act on the same lever arm <em>R</em> for a
							circular surface, the <em>R</em> factor cancels in the
							<em>F</em><sub>m</sub> solve. The code therefore reports
							R<sub>m</sub> in unit kN/m as a force residual per metre run rather than in kN·m/m.
							It
							then scans and brackets &lambda; and concludes with bisection on
							<em>g</em>(&lambda;) = <em>F</em><sub>m</sub>(&lambda;) −
							<em>F</em><sub>f</sub>(&lambda;).
					</p>
					<p>
						The reported Spencer diagnostics now follow the classical sign convention used in the
						literature: positive &lambda; and positive E<sub>R</sub> correspond to the solver’s
						compression-positive interslice chain.
					</p>
					<div class="doc-callout">
						<strong>Present Spencer defaults.</strong> The present Stage 6 module starts from a
						&lambda; bracket of <strong>−0.6 to +0.6</strong>, uses branch tolerances of
						<strong>0.001</strong> on both the Spencer moment and force solves, accepts the
						outer solve on the branch-intersection residual
						<strong>|F<sub>m</sub> − F<sub>f</sub>| ≤ 0.001</strong>, and uses up to
						<strong>20 outer</strong> and <strong>30 inner</strong> iterations by default.
						The settings panel still retains a &lambda; tolerance field for backward
						compatibility with older saved configs, but the present solver does not use a
						separate &lambda;-collapse acceptance test. Spencer still rechecks only the top
						shortlisted Bishop circles. If Spencer cannot converge, the Bishop result is retained
						and the fallback is flagged in the interface and report.
					</div>
				</section>
				<section class="doc-subsection">
					<h3>6.4 Search architecture used by the present implementation</h3>
					<p>
						The solver architecture is intentionally asymmetric:
					</p>
					<ul class="notes">
						<li><strong>Bishop</strong> is used for the full circle search because it is fast and robust.</li>
						<li><strong>Spencer</strong> is run only on the shortlisted circles, not on every trial surface.</li>
						<li>When Spencer converges, the shortlisted circles are reranked by Spencer F.</li>
						<li>When Spencer fails on a shortlisted circle, the Bishop result is retained with a visible fallback note.</li>
					</ul>
				</section>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>Δx<sub>i</sub></dt>
							<dd>horizontal slice width [m]</dd>
						</div>
						<div class="symbols__row">
							<dt>l<sub>i</sub></dt>
							<dd>slice-base length [m]</dd>
						</div>
						<div class="symbols__row">
							<dt>W<sub>i</sub></dt>
							<dd>slice weight [kN/m]</dd>
						</div>
						<div class="symbols__row">
							<dt>u<sub>i</sub></dt>
							<dd>average base pore pressure [kPa]</dd>
						</div>
						<div class="symbols__row">
							<dt>N<sub>i</sub>, T<sub>i</sub></dt>
							<dd>Bishop total base normal force and mobilized shear force [kN/m]</dd>
						</div>
						<div class="symbols__row">
							<dt>N′<sub>i</sub></dt>
							<dd>Spencer effective base normal force [kN/m]</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>L</sub>, E<sub>R</sub></dt>
							<dd>left and right interslice normal forces [kN/m]</dd>
						</div>
						<div class="symbols__row">
							<dt>X<sub>L</sub>, X<sub>R</sub></dt>
							<dd>left and right interslice shear forces [kN/m]</dd>
						</div>
						<div class="symbols__row">
							<dt>&lambda;, &theta;</dt>
							<dd>constant Spencer interslice-force ratio and corresponding angle [-, °]</dd>
						</div>
					</dl>
				</div>
				<section class="doc-subsection">
					<h3>6.5 Uniform surcharge zone</h3>
					<p>
						The present application supports one optional <strong>uniform vertical surcharge zone</strong>
						drawn on the terrain between <em>x</em><sub>q,start</sub> and
						<em>x</em><sub>q,end</sub>. The entered value <em>q</em> is interpreted as a strip
						surcharge in kPa, which is numerically equal to kN/m². In the 2D unit-width Bishop
						model, that surcharge becomes an added vertical line load on each slice according to
						the part of the slice width that overlaps the drawn zone.
					</p>
					<div class="equations">
						<div class="formula">
							b<sub>load,i</sub> = max(0, min(x<sub>R,i</sub>, x<sub>q,end</sub>) −
							max(x<sub>L,i</sub>, x<sub>q,start</sub>))
						</div>
						<div class="formula">
							Q<sub>i</sub> = q · b<sub>load,i</sub>
						</div>
						<div class="formula">
							V<sub>i</sub> = W<sub>i</sub> + Q<sub>i</sub>
						</div>
					</div>
					<p>
						In practice, the present surcharge implementation simply replaces
						<em>W</em><sub>i</sub> by <em>V</em><sub>i</sub> wherever the Bishop solver uses the
						slice vertical load. The surcharge remains vertical and downward only; no load
						angle, horizontal component, or concentrated line-load distribution is assumed in
						this v1 step.
					</p>
					<ul class="notes">
						<li>The load applies only over slices that overlap the drawn zone and is zero outside it.</li>
						<li>The load is stored slice-by-slice as Q<sub>i</sub> so that the interface may show soil weight, surcharge, and total vertical load separately.</li>
						<li>The two-click terrain-anchored interaction should match the existing entry and exit zone workflow.</li>
					</ul>
					<div class="doc-callout">
						<strong>Implementation note.</strong> The present Stage 6 canvas shows the load zone as
						a highlighted terrain segment with a single intensity input <em>q</em>. If
						<em>q</em> = 0, the zone can remain drawn but contributes no surcharge to the slices.
					</div>
				</section>
				<details class="doc-details">
					<summary>Show present fixed-point workflow</summary>
					<pre><code>1. Build all valid trial circles from the entry-exit search.
2. Compute the recorded Fellenius seed:
   F_fellenius = Σ[c′·l + (V cosα − u·l)tanφ′] / Σ[V sinα]
   If F_fellenius is non-positive or non-finite, start Bishop from initialFS.
3. Solve each circle with Bishop Simplified using:
   F = Σ[(c′·b + (V − u·b)tanφ′) / mα(F)] / Σ[V sinα]
4. Rank all circles by Bishop F.
5. If Spencer mode is on, recheck only the shortlisted circles:
   a. Solve Fm(λ) from the Spencer moment residual
   b. Solve Ff(λ) from left-to-right force propagation
   c. Find λ where Fm(λ) = Ff(λ), using the residual intersection criterion
6. If Spencer converges, rerank the shortlist by Spencer F.
7. If Spencer fails, keep the Bishop result and flag the fallback.</code></pre>
				</details>
			</section>

			<section id="implementation" class="doc-card">
				<p class="section-label">Section</p>
				<h2>7. Present Stage 6 implementation</h2>
				<p>
					The present implementation is intentionally narrower than a general slope-stability
					package. The points set out below describe what the present Stage 6 circular solver
					actually does at present.
				</p>
				<div class="doc-table-wrap">
						<p class="doc-table-caption">Stage 6 slope-stability defaults and solver settings in the present implementation.</p>
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr>
									<th>Item</th>
									<th>Present implementation behaviour</th>
								</tr>
							</thead>
							<tbody>
								<tr><td>Soil source</td><td>Active CPT only, extended horizontally across the section</td></tr>
								<tr><td>Method mode</td><td>Bishop only or Bishop + Spencer check</td></tr>
								<tr><td>Search mode</td><td>Entry-exit search</td></tr>
								<tr><td>Entry / exit samples</td><td>10 / 10 by default</td></tr>
								<tr><td>Centers per chord</td><td>15 by default</td></tr>
								<tr><td>Target slices</td><td>30</td></tr>
								<tr><td>Max iterations</td><td>50</td></tr>
								<tr><td>Tolerance</td><td>1e−4</td></tr>
								<tr><td>Minimum m<sub>α</sub></td><td>1e−6</td></tr>
								<tr><td>Spencer shortlist</td><td>Top 10 circles by default, capped by the prevailing keep-best setting</td></tr>
								<tr><td>Spencer &lambda; bracket</td><td>−0.6 to +0.6 by default</td></tr>
								<tr><td>Spencer branch tolerances</td><td>0.001 on the Spencer moment branch and 0.001 on the Spencer force branch</td></tr>
								<tr><td>Spencer convergence</td><td>Residual-based on |F<sub>m</sub> − F<sub>f</sub>|, 0.001 by default</td></tr>
								<tr><td>Spencer outer / inner iterations</td><td>20 / 30 by default</td></tr>
								<tr><td>Pore pressure</td><td>Dry if no phreatic line is drawn; otherwise hydrostatic from the drawn phreatic line by default, with optional sampled FEM pore pressure from the seepage workspace when enabled. Outside the seepage mesh, or without a seepage result, the solver falls back to the hydrostatic route.</td></tr>
								<tr><td>Surface load</td><td>One optional uniform vertical surcharge zone on the terrain, with one shared q input in kPa</td></tr>
								<tr><td>Execution</td><td>Worker-backed search so the canvas remains responsive while solving</td></tr>
							</tbody>
						</table>
					</div>
				</div>
				<ul class="notes">
					<li>The active branch of the parent circle is resolved first and is stored with the trial circle for both rendering and solving.</li>
					<li>The results table stores ranked circles sorted by increasing FOS, using Spencer F for converged Spencer results and Bishop F for flagged fallbacks.</li>
					<li>The canvas may display the trial circle under evaluation while the worker is running.</li>
					<li>Selected Bishop results expose slice-by-slice values including W<sub>i</sub>, Q<sub>i</sub>, V<sub>i</sub>, α<sub>i</sub>, u<sub>i</sub>, m<sub>α,i</sub>, the Bishop total normal N<sub>i</sub>, and mobilized shear.</li>
					<li>When Spencer converges, the selected result relabels the normal column to the Spencer effective normal N′<sub>i</sub> and also exposes E<sub>R</sub>, X<sub>R</sub>, S<sub>mob</sub>, &lambda;, the branch values F<sub>m</sub> and F<sub>f</sub>, and the final moment and force residuals.</li>
					<li>If FEM pore pressure is enabled, slice-base pore pressure is sampled from the seepage field; outside the seepage mesh or without a seepage result, the solver falls back to the hydrostatic phreatic model.</li>
					<li>The Stage 7 report payload presently stores summary-level Bishop/Spencer values, convergence counts, and Spencer residual diagnostics, but not the full slice-force table.</li>
				</ul>
			</section>

			<section id="canvas" class="doc-card">
				<p class="section-label">Section</p>
				<h2>8. Interactive canvas workflow</h2>
				<p>
					The Bishop module is not merely a numerical solver; it is a geometry-driven Stage 6
					workflow. The canvas therefore forms part of the technical method. Geometry edits
					invalidate stale results forthwith, and the search runs only on the present canvas
					state.
				</p>
				<ol class="notes">
					<li>Draw terrain left to right and accept it with <strong>Finish line</strong> or right-click.</li>
					<li>Place the active CPT marker on that terrain.</li>
					<li>Optionally draw the phreatic line.</li>
					<li>Optionally draw the load zone on the terrain and assign the surcharge intensity <em>q</em>.</li>
					<li>Draw the entry and exit daylight zones on the terrain.</li>
					<li>Run either Bishop only or Bishop + Spencer check.</li>
				</ol>
				<p>
					The load zone uses the same terrain-anchored two-click interaction as the entry and
					exit zones: first click for the start of the loaded interval, second click for the end,
					whereafter the surcharge intensity <em>q</em> is assigned.
				</p>
				<p>
					The present canvas also supports metric grid display, snap-to-grid, continuous
					coordinate readout, middle-mouse panning, wheel zoom, hover tooltips for soil regions,
					a live trial-circle preview while the worker is evaluating circles, and a result table
					that shows the active method for each shortlisted circle.
				</p>
			</section>

			<section id="verification" class="doc-card">
				<p class="section-label">Section</p>
				<h2>9. Verification and testing</h2>
				<p>
					The recommended verification order is numerical first, thereafter geometric, and then
					benchmark comparison. The present implementation therefore has two numerical layers to
					verify: the Bishop search itself and the Spencer recheck on the shortlisted circles.
				</p>
				<ul class="notes">
					<li>Check one homogeneous dry slope against a hand or spreadsheet calculation.</li>
					<li>Check one slope with a phreatic line to verify the implemented <em>u·b</em> treatment in the Bishop equation.</li>
					<li>Check one layered slope to verify the distinction between full-slice weight and base-material strength.</li>
					<li>Check one near-steep exit case to verify the exit-angle and m<sub>α</sub> filters.</li>
					<li>Check one slope with a finite loaded crest zone to verify slice-overlap logic and the expected reduction in FOS.</li>
					<li>Check one benign circular case where Bishop and Spencer should agree closely.</li>
					<li>Check one published Spencer benchmark, such as Fredlund &amp; Krahn (1977) or a documented SLOPE/W case, to verify both the factor of safety and the sign of &lambda;.</li>
					<li>Check one case where Spencer is forced to fall back so that the interface and the Stage 7 report both show the fallback metadata cleanly.</li>
				</ul>
				<div class="doc-callout doc-callout--warn">
					<strong>Important.</strong> Passing code checks does not by itself validate the factor
					of safety. A Bishop solver ought always to be benchmarked against at least one known
					reference case before it is treated as a trusted engineering calculator.
				</div>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Section</p>
				<h2>10. Limitations and next steps</h2>
				<p>
					The present module is strongest where a circular rotational mechanism is a reasonable
					assumption. It is not the proper final framework for non-circular mechanisms, strong
					weak-seam control, reinforced slopes, or problems for which full force equilibrium is
					required.
				</p>
				<ul class="notes">
					<li>The full search still relies on Bishop Simplified. Spencer is only a recheck on the shortlisted circles, not a full-search engine.</li>
					<li>Bishop Simplified satisfies moment equilibrium and vertical slice equilibrium, but not full horizontal force equilibrium.</li>
					<li>The Spencer implementation is presently limited to circular surfaces with a constant interslice-force ratio.</li>
					<li>Non-circular failures and composite mechanisms are outside the scope of the present implementation.</li>
					<li>The natural next upgrade path is Morgenstern&ndash;Price or another rigorous noncircular workflow on top of the same geometry and slice framework.</li>
					<li>Later extension paths also include custom materials, multi-CPT interpolation, and richer pore-pressure models.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">Sources</p>
				<h2>References</h2>
				<p>
					The references below frame both the Bishop Simplified theory and the present Stage 6
					implementation choices.
				</p>
				<ul class="reference-list">
						<li><strong>Bishop, A.W. (1955)</strong> — The use of the slip circle in the stability analysis of slopes. Géotechnique, 5(1), 7–17.</li>
						<li><strong>Fellenius, W. (1927)</strong> — <em>Erdstatische Berechnungen</em>. W. Ernst u. Sohn, Berlin.</li>
						<li><strong>Spencer, E. (1967)</strong> — A method of analysis of the stability of embankments assuming parallel inter-slice forces. Géotechnique, 17(1), 11–26.</li>
						<li><strong>Fredlund, D.G. &amp; Krahn, J. (1977)</strong> — Comparison of slope stability methods of analysis. Canadian Geotechnical Journal, 14(3), 429–439.</li>
						<li><strong>Krahn, J. (2003)</strong> — The 2001 R.M. Hardy Lecture: The limits of limit equilibrium analyses. Canadian Geotechnical Journal, 40(3), 643–660. DOI: 10.1139/t03-024.</li>
						<li><strong>USACE EM 1110-2-1902</strong> — Slope Stability. U.S. Army Corps of Engineers.</li>
						<li><strong>GeoStudio / SLOPE/W documentation</strong> — Bishop Simplified method, entry-exit search, and variable slice widths.</li>
						<li><strong>EN 1997-1:2004+A1:2013</strong> — Eurocode 7 — Geotechnical design — General rules.</li>
						<li><strong>NBN EN 1997-1 ANB:2022</strong> — Belgian National Annex to EN 1997-1.</li>
				</ul>
			</section>
		</main>
	</div>

	<footer class="docs-footer">
		<div class="docs-footer__inner">
			<div class="docs-footer__brand">
				<a class="docs-footer__logo" href="https://madep.be">MADEP CPT Interpreter</a>
				<p class="docs-footer__tagline">
					Technical CPT interpretation, parameter derivation, engineering screening, and slope-stability documentation.
				</p>
			</div>
			<div class="docs-footer__links">
				<p class="docs-footer__heading">Navigation</p>
				<a href="/">CPT app</a>
				<a href="/docs">Main docs</a>
				<a href="/docs/bishop">Bishop docs</a>
				<a href="#scope">Scope</a>
				<a href="#references">References</a>
			</div>
		</div>
	</footer>
</div>
