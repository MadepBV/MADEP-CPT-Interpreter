<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Beam / Slab on Elastic Foundation — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 beam or slab on elastic foundation workflow: Winkler equilibrium derivation, CPT-based subgrade modulus, Hetényi closed forms, characteristic length classification, Pasternak and Kerr extensions, and modelling limitations.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/beam';
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
				<a href="/docs/full#beam">Specification anchor</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / beam or slab on elastic foundation</p>
			<h1>Beam or slab on elastic foundation.</h1>
			<p class="hero__lead">
				The structural–geotechnical route solves a one-dimensional strip on elastic foundation.
				Subgrade support is reconstructed from the interpreted CPT stiffness profile through a
				Vesić-style conversion. This chapter derives the governing equations, the Hetényi closed
				forms used to interpret response, and the Pasternak / Kerr refinements the app exposes.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Beam on elastic foundation navigation">
			<div class="docs-nav__title">Beam / slab</div>
			<a href="#scope">Scope and intent</a>
			<a href="#derivation">Winkler equilibrium derivation</a>
			<a href="#ks">CPT-based subgrade modulus</a>
			<a href="#characteristic">Characteristic length and regimes</a>
			<a href="#closed">Hetényi closed forms</a>
			<a href="#bc">Boundary and loading cases</a>
			<a href="#pasternak">Pasternak shear layer</a>
			<a href="#kerr">Kerr three-parameter model</a>
			<a href="#numerics">Numerical discretization</a>
			<a href="#limits">Limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and engineering purpose</h2>
				<p>
					The beam route treats a strip of finite bending stiffness EI<sub>b</sub> resting on a
					soil foundation modelled as a distributed elastic reaction (Winkler) or as a
					spring + shear-layer pair (Pasternak). It is the appropriate screen for strip footings,
					narrow raft cuts, slab strips between movement joints, pipe bedding, and linear
					structures where bending along the strip governs the load-distribution pattern.
				</p>
				<div class="doc-callout">
					<strong>Transparency note.</strong> Support parameters are not read from a catalogue.
					They are reconstructed from the CPT-derived stiffness profile and are therefore
					<em>footing-dependent</em>, not universal soil constants. A different strip width or
					influence depth yields a different k<sub>s</sub>.
				</div>
				<div class="symbols">
					<div class="symbols__title">Primary quantities</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>w(x)</dt>
							<dd>Strip deflection [m], positive downwards.</dd>
						</div>
						<div class="symbols__row">
							<dt>M(x), V(x)</dt>
							<dd>Bending moment [kN·m/m] and shear [kN/m] per meter of strip width.</dd>
						</div>
						<div class="symbols__row">
							<dt>k<sub>s</sub></dt>
							<dd>Modulus of subgrade reaction [kN/m³ = kPa/m].</dd>
						</div>
						<div class="symbols__row">
							<dt>λ, β</dt>
							<dd>Characteristic length and its inverse β = 1/λ [m, 1/m].</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="derivation" class="doc-card">
				<p class="section-label">Derivation</p>
				<h2>2. Winkler equilibrium from strip kinematics</h2>
				<p>
					Winkler's hypothesis is that the reaction pressure at any point depends only on the
					local deflection: p<sub>soil</sub>(x) = k<sub>s</sub> w(x). Combined with
					Euler–Bernoulli beam kinematics (plane sections remain plane, rotations small) and
					equilibrium on an infinitesimal strip element of width b, the fourth-order ODE follows
					from sectional equilibrium on an infinitesimal slice.
				</p>
				<div class="equations">
					<div class="formula">M(x) = −EI<sub>b</sub> w''(x),     V(x) = M'(x) = −EI<sub>b</sub> w'''(x)</div>
					<div class="formula">Sectional equilibrium: dV/dx + q(x) − b k<sub>s</sub> w(x) = 0</div>
					<div class="formula">⇒  EI<sub>b</sub> w''''(x) + b k<sub>s</sub> w(x) = q(x)      (Winkler ODE)</div>
					<div class="formula">Non-dimensional form:  w'''' + 4 β<sup>4</sup> w = q(x)/EI<sub>b</sub>,   4β<sup>4</sup> = b k<sub>s</sub>/EI<sub>b</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>EI<sub>b</sub></dt>
							<dd>Bending stiffness per meter of strip width [kN·m²/m].</dd>
						</div>
						<div class="symbols__row">
							<dt>q(x)</dt>
							<dd>Distributed applied load [kN/m].</dd>
						</div>
						<div class="symbols__row">
							<dt>b</dt>
							<dd>Strip width used to convert modulus of subgrade reaction to a line reaction [m].</dd>
						</div>
					</dl>
				</div>
				<p>
					The operator w'''' + 4β<sup>4</sup>w is biharmonic plus reaction. Its Green function
					decays exponentially with a spatial scale set by 1/β, so loads are localized in their
					structural effect: a point load influences the strip essentially over ±3/β.
				</p>
			</section>

			<section id="ks" class="doc-card">
				<p class="section-label">Support derivation</p>
				<h2>3. Modulus of subgrade reaction from the interpreted CPT profile</h2>
				<p>
					For each numerical sublayer beneath the foundation, the app evaluates the stress-dependent
					stiffness from the interpreted Hardening Soil style layer model. The sublayer values are
					averaged over the chosen influence depth, and the resulting equivalent soil modulus is
					converted to a subgrade reaction through the Vesić expression for an infinite strip.
				</p>
				<div class="equations">
					<div class="formula">E<sub>oed,i</sub> = E<sub>oed,ref</sub>[(c′ cot φ′ + σ′<sub>v,i</sub>) / (c′ cot φ′ + p<sub>ref</sub>)]<sup>m</sup></div>
					<div class="formula">E<sub>s,i</sub> = E<sub>oed,i</sub> (1 + ν<sub>s</sub>)(1 − 2ν<sub>s</sub>) / (1 − ν<sub>s</sub>)</div>
					<div class="formula">E<sub>s,avg</sub> = (Σ E<sub>s,i</sub> Δz<sub>i</sub>) / (Σ Δz<sub>i</sub>)</div>
					<div class="formula">k<sub>s</sub> = [0.65 E<sub>s,avg</sub> / (B (1 − ν<sub>s</sub><sup>2</sup>))] · (E<sub>s,avg</sub> B<sup>4</sup> / (E<sub>b</sub> I<sub>b</sub>))<sup>1/12</sup></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>E<sub>oed,ref</sub>, m, p<sub>ref</sub></dt>
							<dd>Hardening Soil reference oedometric stiffness [kPa], stress exponent [-], and reference pressure [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>σ′<sub>v,i</sub></dt>
							<dd>Effective vertical stress at the centre of sublayer <em>i</em> [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>c′, φ′</dt>
							<dd>Effective cohesion [kPa] and effective friction angle [°] of the governing soil.</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>s,i</sub>, E<sub>s,avg</sub></dt>
							<dd>Plane-strain secant Young modulus in sublayer <em>i</em> and its thickness-weighted average [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>k<sub>s</sub></dt>
							<dd>Modulus of subgrade reaction applied to the strip [kN/m³].</dd>
						</div>
						<div class="symbols__row">
							<dt>B</dt>
							<dd>Strip width [m]. Enters through both the geometric stiffness and the B<sup>4</sup> coupling term.</dd>
						</div>
						<div class="symbols__row">
							<dt>ν<sub>s</sub></dt>
							<dd>Poisson ratio adopted for the soil support conversion [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>b</sub> I<sub>b</sub></dt>
							<dd>Per-meter bending stiffness of the structural strip [kN·m²/m].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The twelfth root of (E<sub>s</sub>B⁴/E<sub>b</sub>I<sub>b</sub>) captures the Vesić soil–beam stiffness coupling: stiffer strips see less uniform contact pressure.</li>
					<li>Because k<sub>s</sub> depends on B, E<sub>b</sub>I<sub>b</sub>, and the chosen influence zone, two footings on the same soil can carry materially different k<sub>s</sub>.</li>
					<li>Default averaging depths are 2B in sand and 1.5B in clay, and can be overridden in the app.</li>
				</ul>
			</section>

			<section id="characteristic" class="doc-card">
				<p class="section-label">Characteristic length</p>
				<h2>4. Characteristic length λ and response regimes</h2>
				<p>
					Non-dimensionalising the ODE identifies a single intrinsic length scale
					λ = (4 EI<sub>b</sub> / (b k<sub>s</sub>))<sup>1/4</sup>. Deflection, moment envelope,
					and contact-pressure distribution all scale with λ. The strip length L relative to this
					scale classifies the structural behaviour into short, intermediate, or long.
				</p>
				<div class="equations">
					<div class="formula">λ = (4 EI<sub>b</sub> / (b k<sub>s</sub>))<sup>1/4</sup>,   β = 1/λ</div>
					<div class="formula">βL &lt; π/4   (L ≲ 0.8 λ):      short strip, nearly rigid body</div>
					<div class="formula">π/4 ≤ βL ≤ π    (L ≈ 0.8–3 λ):   intermediate strip, elastic bending</div>
					<div class="formula">βL &gt; π     (L ≳ 3 λ):         long strip, response localized near loads</div>
				</div>
				<p>
					For short strips the moment envelope approaches the rigid-beam result; subgrade stiffness
					scatter matters less. For long strips a point load produces a decaying response beyond
					roughly ±π/β from the load — the strip isolates distant regions and far-field contact
					pressure becomes insensitive to local detail.
				</p>
			</section>

			<section id="closed" class="doc-card">
				<p class="section-label">Closed-form solutions</p>
				<h2>5. Hetényi solutions for canonical load cases</h2>
				<p>
					For an infinitely long beam on Winkler support, the fourth-order ODE admits closed-form
					solutions in terms of damped oscillatory kernels (Hetényi 1946). The deflection under a
					concentrated load at the origin is the Green function of the operator; the response to a
					distributed load is the convolution of that Green function with the load.
				</p>
				<div class="equations">
					<div class="formula">w(x) = (P β / (2 b k<sub>s</sub>)) e<sup>−β|x|</sup>[cos(β|x|) + sin(β|x|)]   (deflection under P at x=0)</div>
					<div class="formula">M(x) = (P / (4 β)) e<sup>−β|x|</sup>[cos(β|x|) − sin(β|x|)]</div>
					<div class="formula">V(x) = −(P/2) e<sup>−β|x|</sup> cos(β|x|) sgn(x)</div>
					<div class="formula">w<sub>max</sub> = P β / (2 b k<sub>s</sub>)   at x = 0</div>
					<div class="formula">M<sub>max</sub> = P / (4 β)   at x = 0</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Hetényi kernels</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>A(βx) = e<sup>−βx</sup>(cos βx + sin βx)</dt>
							<dd>Deflection kernel.</dd>
						</div>
						<div class="symbols__row">
							<dt>B(βx) = e<sup>−βx</sup> sin βx</dt>
							<dd>Rotation kernel.</dd>
						</div>
						<div class="symbols__row">
							<dt>C(βx) = e<sup>−βx</sup>(cos βx − sin βx)</dt>
							<dd>Moment kernel.</dd>
						</div>
						<div class="symbols__row">
							<dt>D(βx) = e<sup>−βx</sup> cos βx</dt>
							<dd>Shear kernel.</dd>
						</div>
					</dl>
				</div>
				<p>
					The kernels decay as e<sup>−βx</sup>, so the response to a load localized near x = 0 is
					numerically negligible beyond about 3/β. That bound justifies truncating the numerical
					strip when inputs would otherwise require an effectively infinite domain.
				</p>
			</section>

			<section id="bc" class="doc-card">
				<p class="section-label">Boundary and loading cases</p>
				<h2>6. Point, patch, and distributed loads with finite ends</h2>
				<p>
					For finite strips the app superposes particular solutions and applies end boundary
					conditions. Free-end strip footings carry M = V = 0 at the ends; fixed-end walls carry
					w = w′ = 0; hinged ends fix w and M. Patch loads of intensity q over [x<sub>1</sub>,
					x<sub>2</sub>] are handled by integrating the point-load Green function, giving
					closed-form end moments and deflections in terms of A, B, C, D kernels.
				</p>
				<div class="equations">
					<div class="formula">Uniform load q over [x<sub>1</sub>, x<sub>2</sub>], infinite strip:</div>
					<div class="formula">w(x) = (q / (2 b k<sub>s</sub>))[2 − A(β|x − x<sub>1</sub>|) − A(β|x − x<sub>2</sub>|)]</div>
					<div class="formula">M(x) = (q / (4 β<sup>2</sup>))[C(β|x − x<sub>1</sub>|) + C(β|x − x<sub>2</sub>|)]</div>
					<div class="formula">End-moment correction (finite strip):  superpose fictitious end moments enforcing M = 0 (free) or w′ = 0 (fixed).</div>
				</div>
				<ul class="notes">
					<li>For the common "point load on infinite strip" case, the decay factor e<sup>−β|x|</sup> gives a fast mental estimate of the affected zone: meaningful bending extends to ±π/(2β) on each side.</li>
					<li>Patch-load sensitivity is strongest when the patch width approaches 1/β; very wide patches approach a rigid pressure distribution, very narrow patches approach the point-load limit.</li>
					<li>End moments under uniform load on a finite strip can reverse sign relative to the infinite-beam field; the app reports the corrected envelope, not the superposition piece alone.</li>
				</ul>
			</section>

			<section id="pasternak" class="doc-card">
				<p class="section-label">Pasternak extension</p>
				<h2>7. Pasternak shear-layer coupling</h2>
				<p>
					Winkler independence is the main limitation of the single-parameter model: adjacent
					springs do not communicate, so the predicted contact-pressure field is discontinuous at
					load edges. The Pasternak extension restores shear coupling through a distributed shear
					layer on top of the springs. The governing equation acquires an extra w'' term.
				</p>
				<div class="equations">
					<div class="formula">p<sub>soil</sub>(x) = k<sub>s</sub> w(x) − G<sub>p</sub> w''(x)</div>
					<div class="formula">EI<sub>b</sub> w''''(x) − b G<sub>p</sub> w''(x) + b k<sub>s</sub> w(x) = q(x)</div>
					<div class="formula">G<sub>p</sub> = η G<sub>s,avg</sub> H<sub>p</sub></div>
					<div class="formula">G<sub>s,avg</sub> = E<sub>s,avg</sub> / [2(1 + ν<sub>s</sub>)]</div>
					<div class="formula">H<sub>p</sub> = z<sub>influence</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>G<sub>p</sub></dt>
							<dd>Pasternak shear-layer stiffness per unit area [kN/m²]. Physically the integrated shear stiffness of the soil column above the Winkler base.</dd>
						</div>
						<div class="symbols__row">
							<dt>η</dt>
							<dd>Calibration factor linking averaged shear stiffness to the Pasternak layer (default 1/3 for a linearly decaying shear profile).</dd>
						</div>
						<div class="symbols__row">
							<dt>G<sub>s,avg</sub>, H<sub>p</sub></dt>
							<dd>Averaged soil shear modulus [kPa] and adopted shear-layer thickness [m].</dd>
						</div>
					</dl>
				</div>
				<p>
					Physically G<sub>p</sub> smooths the contact-pressure field and introduces a correction to
					the characteristic length. The Pasternak ODE has two nested length scales: one dominated
					by flexure and one by the shear layer. The app reports both so the engineer can see
					whether shear-layer coupling materially changes the moment envelope.
				</p>
			</section>

			<section id="kerr" class="doc-card">
				<p class="section-label">Kerr extension</p>
				<h2>8. Kerr three-parameter model (diagnostic)</h2>
				<p>
					Kerr (1964) places a second spring layer in series with the shear layer. The extra
					parameter matches observed wheel-load response on pavements and softens the
					contact-pressure kinks that Pasternak can leave near load edges. The app exposes Kerr as
					a comparator, not a default design mode.
				</p>
				<div class="equations">
					<div class="formula">p = k<sub>1</sub> w<sub>1</sub>,   (k<sub>2</sub>(w − w<sub>2</sub>)) = p − G<sub>p</sub> w<sub>2</sub>''</div>
					<div class="formula">Consolidating gives a sixth-order ODE in w whose lowest-order terms recover Pasternak and whose highest-order term scales with G<sub>p</sub>/k<sub>1</sub>.</div>
				</div>
				<ul class="notes">
					<li>Kerr is supplied as a comparator for problems where Pasternak yields suspicious end moments or contact-pressure kinks.</li>
					<li>Production reporting remains on Winkler / Pasternak.</li>
				</ul>
			</section>

			<section id="numerics" class="doc-card">
				<p class="section-label">Numerical discretization</p>
				<h2>9. Finite-element implementation of the strip</h2>
				<p>
					The strip is discretised with two-node cubic-Hermite beam elements. Each element carries
					two nodal rotations and two nodal deflections (4 DOF), and Winkler support is assembled
					as a consistent line spring. Pasternak shear coupling adds a consistent element
					contribution proportional to G<sub>p</sub> ∫ N′<sub>i</sub> N′<sub>j</sub> dx.
				</p>
				<div class="equations">
					<div class="formula">K<sub>e</sub><sup>beam</sup> = ∫ EI N''<sup>T</sup> N'' dx</div>
					<div class="formula">K<sub>e</sub><sup>Winkler</sup> = ∫ b k<sub>s</sub> N<sup>T</sup> N dx</div>
					<div class="formula">K<sub>e</sub><sup>Pasternak</sup> = ∫ b G<sub>p</sub> N'<sup>T</sup> N' dx</div>
					<div class="formula">K w = f,   f<sub>e</sub> = ∫ N<sup>T</sup> q(x) dx + nodal actions</div>
				</div>
				<ul class="notes">
					<li>Element size defaults to min(λ/10, L/50) so the shortest retained wave of the Hetényi kernel is resolved by at least 10 elements per decay length.</li>
					<li>Point loads map onto nodal actions exactly; patch loads use Gauss integration on the element span.</li>
					<li>The linear system is symmetric positive definite for Winkler and for Pasternak when G<sub>p</sub> ≥ 0.</li>
				</ul>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Limitations</p>
				<h2>10. Assumptions and boundaries of validity</h2>
				<ul class="notes">
					<li>One-dimensional strip. Two-dimensional plate action (slab on column grid, orthotropic reinforcement) is outside this route.</li>
					<li>Winkler and Pasternak are <em>stiffness screens</em> derived from the CPT column. They do not capture yield beneath local high-pressure zones — that is the domain of the Stage 2 deformation solver.</li>
					<li>Contact uplift (tension under the footing) is not modelled in the public route. Strongly eccentric loads that would produce tensile reactions are flagged rather than auto-resolved.</li>
					<li>Support stiffness is footing-dependent (B, E<sub>b</sub>I<sub>b</sub>, influence depth) — neighbouring strips on the same soil can carry different k<sub>s</sub>.</li>
					<li>Pasternak's η is a calibration. The engineer should compare Winkler and Pasternak runs before committing to the larger envelope.</li>
					<li>The route is a preliminary sizing screen. A final structural design should carry the computed M, V, and contact-pressure fields into a dedicated structural model.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>Hetényi, M. (1946). <em>Beams on Elastic Foundation</em>. University of Michigan Press. Origin of the A/B/C/D damped-kernel closed forms used in §5.</li>
					<li>Vesić, A. B. (1961a). Bending of beams resting on isotropic elastic solid. <em>J. Engng. Mech. Div. ASCE</em> 87(EM2). Derivation of the twelfth-root k<sub>s</sub>(B, EI) coupling in §3.</li>
					<li>Vesić, A. B. (1961b). Beams on elastic subgrade and the Winkler hypothesis. <em>Proc. 5th ICSMFE</em>, Vol. 1.</li>
					<li>Pasternak, P. L. (1954). <em>On a new method of analysis of an elastic foundation by means of two foundation constants</em>. Gosudarstvennoe Izdatel'stvo Literaturi po Stroitel'stvu i Arkhitekture, Moscow.</li>
					<li>Kerr, A. D. (1964). Elastic and viscoelastic foundation models. <em>J. Appl. Mech.</em> 31(3), 491–498.</li>
					<li>Selvadurai, A. P. S. (1979). <em>Elastic Analysis of Soil–Foundation Interaction</em>. Elsevier.</li>
				</ul>
			</section>
		</main>
	</div>
</div>
