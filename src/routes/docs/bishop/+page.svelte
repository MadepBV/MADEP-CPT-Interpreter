<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Bishop Simplified v1 — CPT App Documentation';
	const pageDescription =
		'Technical documentation for the Bishop Simplified v1 slope-stability module in the CPT app: geometry model, slice generation, search strategy, equations, current implementation, and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs/bishop';
	const ogImageUrl = 'https://cpt.madep.be/logo.png';

	const sections = [
		{ id: 'scope', title: '1. Scope and current model' },
		{ id: 'coordinates', title: '2. Coordinates and sign conventions' },
		{ id: 'geometry', title: '3. Geometry and soil model' },
		{ id: 'search', title: '4. Slip-circle search and validity filters' },
		{ id: 'slices', title: '5. Slice generation and multi-layer handling' },
		{ id: 'theory', title: '6. Bishop Simplified equations' },
		{ id: 'implementation', title: '7. Current Stage 6 implementation' },
		{ id: 'canvas', title: '8. Interactive canvas workflow' },
		{ id: 'verification', title: '9. Verification and testing' },
		{ id: 'limits', title: '10. Limitations and upgrade path' },
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
			<p class="hero__eyebrow">Technical documentation</p>
			<h1>Bishop simplified</h1>
			<p class="hero__lead">
				A technical implementation note for the Bishop slope-stability workflow in Stage 6:
				terrain and phreatic geometry, active-CPT-based soil regions, entry-exit search,
				slice generation, Bishop Simplified iteration, and the current interactive canvas behavior.
			</p>
			<div class="hero__actions">
				<a class="btn btn--primary" href="/">Open the app</a>
				<a class="btn btn--outline-dark" href="#scope">Read the theory</a>
			</div>
			<div class="hero__trust">
				<span>Circular slip surfaces</span>
				<span>Bishop Simplified</span>
				<span>Current app logic</span>
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
				<h2>1. Scope and current model</h2>
				<p>
					The Bishop module implemented in Stage 6 is a <strong>Bishop Simplified</strong>
					slope-stability tool for <strong>two-dimensional circular slip surfaces</strong>. It is
					intended as a practical first-pass stability module within the CPT app, not as a final
					rigorous limit-equilibrium platform.
				</p>
				<p>
					The current workflow uses the <strong>active CPT only</strong> as the soil source. The
					interpreted active-CPT layer column from Stages 2 to 5 is converted to a Bishop soil
					model by extending those layers horizontally across the drawn section. Terrain, phreatic
					line, optional surcharge zone, and entry and exit zones are then supplied by the Bishop
					canvas.
				</p>
				<div class="doc-callout">
					<strong>Current v1 scope.</strong> The current Stage 6 Bishop app is limited to
					circular slip surfaces, self-weight loading, one optional uniform vertical surcharge
					zone, and optional hydrostatic pore pressure from a drawn phreatic line. Seismic
					loading, reinforcement, noncircular surfaces, and rigorous force-and-moment methods
					such as Spencer or Morgenstern–Price are not part of the current implementation.
				</div>
				<div class="doc-callout">
					<strong>Current load model.</strong> The live load feature is one optional
					<strong>uniform vertical surcharge zone</strong> drawn on the terrain with the same
					two-click workflow as the entry and exit zones. It is interpreted as a strip surcharge
					over a finite horizontal interval, not as a concentrated point load or inclined load.
				</div>
				<div class="equations">
					<div class="formula">
						2D cross-section, unit width, circular slip surfaces, self-weight plus one optional
						uniform surcharge zone
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
					<li>The Bishop module sits inside the existing Stage 6 state and therefore preserves the interpreted CPT workflow.</li>
					<li>The current search mode visible in the app is entry-exit search; no separate center-grid mode is currently exposed in the UI.</li>
					<li>The current implementation is experimental, but it is part of the visible Stage 6 app set.</li>
				</ul>
			</section>

			<section id="coordinates" class="doc-card">
				<p class="section-label">Section</p>
				<h2>2. Coordinates and sign conventions</h2>
				<p>
					The Bishop canvas uses world coordinates with <em>x</em> positive to the right and
					<em>y</em> positive upward. Terrain, phreatic line, entry zone, exit zone, and slip
					circles are all defined in that same world system. Screen pan and zoom are applied only
					in the rendering layer; the solver sees world coordinates only.
				</p>
				<p>
					The current implementation stores a signed base angle per slice. The sign is taken
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
					<strong>Implementation note.</strong> The app no longer forces unsigned base angles.
					The signed-angle convention is essential for circles that pass across the lowest point
					of the arc, because the sign of α changes over the span and directly affects the Bishop
					driving term.
				</div>
			</section>

			<section id="geometry" class="doc-card">
				<p class="section-label">Section</p>
				<h2>3. Geometry and soil model</h2>

				<section class="doc-subsection">
					<h3>3.1 Terrain and phreatic polyline</h3>
					<p>
						The terrain is a user-drawn x-monotonic polyline. The app enforces left-to-right
						vertex ordering, and the terrain is queried by linear interpolation. The optional
						phreatic surface is another polyline in the same coordinate system.
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
						The current app does <strong>not</strong> interpolate between multiple CPTs. Instead,
						it takes the active interpreted layer column and extends it horizontally across the full
						Bishop model width. The top band follows the drawn terrain, the intermediate bands are
						horizontal at the layer boundary elevations referenced to the active CPT position, and
						the deepest band extends down to the selected Bishop analysis depth.
					</p>
					<p>
						The analysis depth defaults to the <strong>CPT depth or 15 m</strong>, whichever is
						greater. If the engineer chooses a deeper analysis depth, the bottom layer is simply
						extrapolated downward.
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
						<li>The current implementation builds closed, non-overlapping band polygons for rendering and region inspection.</li>
					</ul>
				</section>

				<section class="doc-subsection">
					<h3>3.3 Material sets and design values</h3>
					<p>
						Bishop materials are imported automatically from the active CPT layers. The app
						currently lets the user choose between <strong>Characteristic</strong>,
						<strong>DA1/1 (M1)</strong>, and <strong>DA1/2 (M2)</strong>. For the design-value
						sets, the module reuses the same soil-parameter reduction logic as the rest of
						Stage 6 before assigning Bishop base materials.
					</p>
					<div class="doc-table-wrap">
						<p class="doc-table-caption">Current Bishop material source modes.</p>
						<div class="doc-table-scroll">
							<table class="doc-table">
								<thead>
									<tr>
										<th>Mode</th>
										<th>Meaning in the current app</th>
									</tr>
								</thead>
								<tbody>
									<tr>
										<td>Characteristic</td>
										<td>Imports layer c′, φ′, γ, and γ<sub>sat</sub> directly from the current CPT interpretation.</td>
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
						The visible v1 workflow is based on <strong>entry-exit search</strong>. The user
						draws an entry zone and an exit zone on the terrain. The app samples points along both
						zones, forms the entry-exit chord, and then samples candidate circle centers on the
						perpendicular bisector of that chord.
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
						The app validates each trial circle before slice generation. The active branch is
						chosen first, then the circle is kept only if it daylights at the intended entry and
						exit points and remains below terrain in between.
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
						The app starts from an equally spaced slice backbone and then inserts additional cut
						positions at every relevant x-location: terrain vertices, phreatic vertices, slip-circle
						intersections with horizontal layer boundaries, and phreatic intersections with the
						active slip branch. The resulting cut set is then cleaned against a minimum slice width.
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
					<h3>5.3 Multi-layer slices in the current app</h3>
					<p>
						If a slice body passes through more than one soil layer, the current app handles it in
						the standard Bishop v1 manner:
					</p>
					<ul class="notes">
						<li><strong>Weight</strong> includes contributions from <em>all</em> layers intercepted by the slice body.</li>
						<li><strong>Strength</strong> uses the material at the <em>slice base</em> only.</li>
					</ul>
					<p>
						The current implementation computes layer-wise slice weight by integrating the
						overlapped band thickness and unit weight across the slice width with Simpson
						integration. It also stores the per-layer breakdown in <code>layerAreas</code> for UI
						inspection.
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
						<strong>Current behavior.</strong> The app tries to place slice cuts at horizontal
						layer-boundary intersections so that one soil type remains along each base segment. If a
						very narrow interval is later merged by the minimum-slice-width cleanup, the strength
						side falls back to the material at the base midpoint.
					</div>
				</section>
			</section>

			<section id="theory" class="doc-card">
				<p class="section-label">Section</p>
				<h2>6. Bishop Simplified equations</h2>
				<p>
					The current app uses the Bishop Simplified form for circular slip surfaces with optional
					base pore pressure and one optional uniform surcharge zone. The factor of safety appears
					inside m<sub>α,i</sub>, so the problem is solved by repeated substitution.
				</p>
				<div class="equations">
					<div class="formula">
						T<sub>i</sub> = [c′<sub>i</sub>l<sub>i</sub> + (N<sub>i</sub> − u<sub>i</sub>l<sub>i</sub>)tanφ′<sub>i</sub>] / F
					</div>
					<div class="formula">
						N<sub>i</sub> = [W<sub>i</sub> − T<sub>i</sub> sinα<sub>i</sub>] / cosα<sub>i</sub>
					</div>
					<div class="formula">
						m<sub>α,i</sub>(F) = cosα<sub>i</sub> + [sinα<sub>i</sub> tanφ′<sub>i</sub>] / F
					</div>
					<div class="formula">
						F =
						Σ[(c′<sub>i</sub>Δx<sub>i</sub> + (W<sub>i</sub> − u<sub>i</sub>l<sub>i</sub>)tanφ′<sub>i</sub>) / m<sub>α,i</sub>(F)]
						/
						Σ[W<sub>i</sub> sinα<sub>i</sub>]
					</div>
				</div>
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
							<dd>base normal force and mobilized shear force [kN/m]</dd>
						</div>
					</dl>
				</div>
				<p>
					The current solver seeds the iteration with the Ordinary Method of Slices value and then
					repeats until the FOS change falls below the configured tolerance or the iteration count
					is exhausted.
				</p>
				<section class="doc-subsection">
					<h3>6.1 Uniform surcharge zone</h3>
					<p>
						The current app supports one optional <strong>uniform vertical surcharge zone</strong>
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
						<div class="formula">
							F =
							Σ[(c′<sub>i</sub>Δx<sub>i</sub> + (V<sub>i</sub> −
							u<sub>i</sub>l<sub>i</sub>)tanφ′<sub>i</sub>) / m<sub>α,i</sub>(F)]
							/
							Σ[V<sub>i</sub> sinα<sub>i</sub>]
						</div>
					</div>
					<p>
						In practice, the current surcharge implementation simply replaces
						<em>W</em><sub>i</sub> by <em>V</em><sub>i</sub> everywhere the Bishop solver uses the
						slice vertical load. The surcharge remains vertical and downward only; no load angle,
						horizontal component, or concentrated line load distribution is assumed in this v1
						step.
					</p>
					<ul class="notes">
						<li>The load applies only over slices that overlap the drawn zone and is zero outside it.</li>
						<li>The load should be stored slice-by-slice as Q<sub>i</sub> so the UI can show soil weight, surcharge, and total vertical load separately.</li>
						<li>The two-click terrain-anchored interaction should match the existing entry and exit zone workflow.</li>
					</ul>
					<div class="doc-callout">
						<strong>Implementation note.</strong> The current Stage 6 canvas shows the load zone as
						a highlighted terrain segment with a single intensity input <em>q</em>. If
						<em>q</em> = 0, the zone can remain drawn but contributes no surcharge to the slices.
					</div>
				</section>
				<details class="doc-details">
					<summary>Show current fixed-point workflow</summary>
					<pre><code>1. Compute an ordinary-method seed F₀.
2. For each slice, evaluate mα,i(Fₖ).
3. Form the resisting numerator using c′, V, u, l, and φ′.
4. Divide by the driving sum Σ(Vᵢ sin αᵢ) to get Fₖ₊₁.
5. Stop when |Fₖ₊₁ − Fₖ| &lt; tolerance, or reject on no convergence or mα ≤ mα,min.</code></pre>
				</details>
			</section>

			<section id="implementation" class="doc-card">
				<p class="section-label">Section</p>
				<h2>7. Current Stage 6 implementation</h2>
				<p>
					The current app implementation is intentionally narrower than a general slope-stability
					package. The following points describe what the live Bishop module actually does today.
				</p>
				<div class="doc-table-wrap">
					<p class="doc-table-caption">Current Stage 6 Bishop defaults and solver settings.</p>
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr>
									<th>Item</th>
									<th>Current app behavior</th>
								</tr>
							</thead>
							<tbody>
								<tr><td>Soil source</td><td>Active CPT only, extended horizontally across the section</td></tr>
								<tr><td>Search mode</td><td>Entry-exit search</td></tr>
								<tr><td>Entry / exit samples</td><td>10 / 10 by default</td></tr>
								<tr><td>Centers per chord</td><td>15 by default</td></tr>
								<tr><td>Target slices</td><td>30</td></tr>
								<tr><td>Max iterations</td><td>50</td></tr>
								<tr><td>Tolerance</td><td>1e−4</td></tr>
								<tr><td>Minimum m<sub>α</sub></td><td>1e−6</td></tr>
								<tr><td>Pore pressure</td><td>Dry if no phreatic line is drawn; otherwise hydrostatic from the drawn phreatic line</td></tr>
								<tr><td>Surface load</td><td>One optional uniform vertical surcharge zone on the terrain, with one shared q input in kPa</td></tr>
								<tr><td>Execution</td><td>Worker-backed search so the canvas remains responsive while solving</td></tr>
							</tbody>
						</table>
					</div>
				</div>
				<ul class="notes">
					<li>The active branch of the parent circle is resolved first and is stored with the trial circle for both rendering and solving.</li>
					<li>The results table stores ranked circles sorted by increasing FOS.</li>
					<li>The canvas can display the trial circle being tested while the worker is running.</li>
					<li>Selected results expose slice-by-slice values including W<sub>i</sub>, Q<sub>i</sub>, V<sub>i</sub>, α<sub>i</sub>, u<sub>i</sub>, m<sub>α,i</sub>, N<sub>i</sub>, and mobilized shear.</li>
				</ul>
			</section>

			<section id="canvas" class="doc-card">
				<p class="section-label">Section</p>
				<h2>8. Interactive canvas workflow</h2>
				<p>
					The Bishop module is not just a numerical solver; it is a geometry-driven Stage 6 app.
					The canvas is therefore part of the technical workflow. Geometry edits invalidate stale
					results immediately, and the search only runs on the current canvas state.
				</p>
				<ol class="notes">
					<li>Draw terrain left to right and accept it with <strong>Finish line</strong> or right-click.</li>
					<li>Place the active CPT marker on that terrain.</li>
					<li>Optionally draw the phreatic line.</li>
					<li>Optionally draw the load zone on the terrain and assign the surcharge intensity <em>q</em>.</li>
					<li>Draw the entry and exit daylight zones on the terrain.</li>
					<li>Run the Bishop search.</li>
				</ol>
				<p>
					The load zone uses the same terrain-anchored two-click interaction as the entry and exit
					zones: first click for the loaded interval start, second click for the end, then assign
					the surcharge intensity <em>q</em>.
				</p>
				<p>
					The current canvas also supports metric grid display, snap-to-grid, live coordinate readout,
					middle-mouse panning, wheel zoom, hover tooltips for soil regions, and a live trial-circle
					preview while the worker is evaluating circles.
				</p>
			</section>

			<section id="verification" class="doc-card">
				<p class="section-label">Section</p>
				<h2>9. Verification and testing</h2>
				<p>
					The recommended verification order for Bishop v1 is numerical first, then geometric, then
					benchmark comparison. The current app already includes the numerical framework needed for
					this, but benchmark verification remains an engineering task rather than a purely code-level
					one.
				</p>
				<ul class="notes">
					<li>Check one homogeneous dry slope against a hand or spreadsheet calculation.</li>
					<li>Check one slope with a phreatic line to verify the <em>u·l</em> term.</li>
					<li>Check one layered slope to verify the distinction between full-slice weight and base-material strength.</li>
					<li>Check one near-steep exit case to verify the exit-angle and m<sub>α</sub> filters.</li>
					<li>Check one slope with a finite loaded crest zone to verify slice-overlap logic and the expected reduction in FOS.</li>
				</ul>
				<div class="doc-callout doc-callout--warn">
					<strong>Important.</strong> Passing code checks does not by itself validate the factor of
					safety. A Bishop solver should always be benchmarked against at least one known reference
					case before it is treated as a trusted engineering calculator.
				</div>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Section</p>
				<h2>10. Limitations and upgrade path</h2>
				<p>
					The current module is strongest where a circular rotational mechanism is a reasonable
					assumption. It is not the correct final framework for noncircular mechanisms, strong weak-seam
					control, reinforced slopes, or problems where full force equilibrium is required.
				</p>
				<ul class="notes">
					<li>Bishop Simplified satisfies moment equilibrium and vertical slice equilibrium, but not full horizontal force equilibrium.</li>
					<li>Noncircular failures and composite mechanisms are outside the scope of the current app.</li>
					<li>The natural future upgrade path is Spencer or Morgenstern–Price on top of the same geometry and slice framework.</li>
					<li>Later extension paths also include custom materials, multi-CPT interpolation, and richer pore-pressure models.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">Sources</p>
				<h2>References</h2>
				<p>
					The references below frame both the Bishop Simplified theory and the current Stage 6
					implementation choices.
				</p>
				<ul class="reference-list">
					<li><strong>Bishop, A.W. (1955)</strong> — The use of the slip circle in the stability analysis of slopes. Géotechnique, 5(1), 7–17.</li>
					<li><strong>USACE EM 1110-2-1902</strong> — Slope Stability. U.S. Army Corps of Engineers.</li>
					<li><strong>FHWA NHI-01-028</strong> — Soil Slope and Embankment Design Reference Manual.</li>
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
