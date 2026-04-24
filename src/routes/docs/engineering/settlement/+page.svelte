<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Settlement — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 settlement workflow: net pressure definition, Boussinesq strip and rectangular-area stress derivations, constrained-modulus integration, truncation rules, Terzaghi time factor, and limitations.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/settlement';
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
				<a href="/docs/full#settlement">Specification anchor</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / settlement</p>
			<h1>Stage 6 settlement.</h1>
			<p class="hero__lead">
				The settlement route integrates vertical strain along the CPT column under the stress
				increase imposed by a footing. Stress is built from the Boussinesq solution for strip or
				rectangular geometry; stiffness is the interpreted Hardening Soil oedometric modulus at
				the mean stress level; optional Terzaghi time-rate interpretation is available for
				fine-grained layers.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Settlement documentation navigation">
			<div class="docs-nav__title">Settlement</div>
			<a href="#scope">Scope and intent</a>
			<a href="#net">Net foundation pressure</a>
			<a href="#stress">Stress-increase solutions</a>
			<a href="#integration">Constrained-modulus integration</a>
			<a href="#trunc">Truncation rules</a>
			<a href="#rigid">Rigid-footing and layer corrections</a>
			<a href="#time">Terzaghi consolidation and time factor</a>
			<a href="#limits">Limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and the meaning of the computed settlement</h2>
				<p>
					The settlement route is a <strong>centreline constrained-modulus integration</strong>. It
					evaluates stress increase beneath the loaded area, updates E<sub>oed</sub> at the mean
					effective stress in each sublayer, and integrates vertical strain over depth to yield a
					single scalar settlement S at the evaluation point.
				</p>
				<div class="equations">
					<div class="formula">q<sub>net</sub> = q<sub>gross</sub> − σ<sub>v</sub>(D<sub>f</sub>)</div>
					<div class="formula">S = Σ ΔS<sub>i</sub>,    ΔS<sub>i</sub> = Δσ<sub>v,i</sub>/E<sub>oed,i</sub> · Δz<sub>i</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Primary quantities</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>q<sub>gross</sub>, q<sub>net</sub></dt>
							<dd>Gross and net foundation pressure [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>σ<sub>v</sub>(D<sub>f</sub>)</dt>
							<dd>In-situ total vertical stress at foundation depth [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>D<sub>f</sub></dt>
							<dd>Foundation embedment depth [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>S</dt>
							<dd>Total settlement at the evaluation point [m].</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="net" class="doc-card">
				<p class="section-label">Net load</p>
				<h2>2. Net pressure definition and physical meaning</h2>
				<p>
					The soil below the foundation is pre-loaded by the weight of excavated material that the
					structure displaces. Only the additional stress above that pre-existing state contributes
					to strain. The net foundation pressure is therefore the quantity that drives the
					Boussinesq integral; the full q<sub>gross</sub> drives the bearing-capacity check, not the
					settlement integration.
				</p>
				<div class="equations">
					<div class="formula">q<sub>net</sub> = q<sub>gross</sub> − γ D<sub>f</sub>   (dry column)</div>
					<div class="formula">q<sub>net</sub> = q<sub>gross</sub> − [γ z<sub>w</sub> + γ<sub>sat</sub> (D<sub>f</sub> − z<sub>w</sub>)] + γ<sub>w</sub>(D<sub>f</sub> − z<sub>w</sub>)   (partially submerged)</div>
				</div>
				<ul class="notes">
					<li>Net pressure is the quantity that drives settlement. Gross pressure drives bearing capacity.</li>
					<li>For deep foundations with effective-stress relief larger than q<sub>gross</sub>, q<sub>net</sub> can be negative — the app flags this as a heave condition rather than a settlement.</li>
				</ul>
			</section>

			<section id="stress" class="doc-card">
				<p class="section-label">Stress increase</p>
				<h2>3. Boussinesq solutions for strip and rectangular geometry</h2>
				<p>
					Vertical stress beneath a surface load is obtained from the Boussinesq half-space
					solution. The app provides three routes: an exact closed form for the strip centreline,
					a Newmark / Fadum four-quadrant superposition for rectangular areas, and a simplified
					2:1 distribution for quick screens.
				</p>
				<div class="equations">
					<div class="formula">Strip centreline:  Δσ<sub>v</sub>(z) = (q<sub>net</sub>/π)[2α + sin(2α)]</div>
					<div class="formula">α = atan(B/(2z))     (half-angle subtended by the strip from the depth point)</div>
					<div class="formula">Corner of rectangle B × L at depth z (Fadum / Newmark):</div>
					<div class="formula">Δσ<sub>v</sub> = (q<sub>net</sub>/(2π))[ (m n (m² + n² + 2))/((m² + 1)(n² + 1)√(m² + n² + 1)) + atan(m n / √(m² + n² + 1)) ]</div>
					<div class="formula">m = B/z,   n = L/z</div>
					<div class="formula">Centre of rectangle: Δσ<sub>v,centre</sub>(z) = 4 I<sub>z</sub>(B/2, L/2, z) q<sub>net</sub>    (four-quadrant superposition of the corner formula)</div>
					<div class="formula">2:1 approximation:  Δσ<sub>v</sub>(z) = q<sub>net</sub> B L / [(B + z)(L + z)]</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>α</dt>
							<dd>Strip-foundation geometric angle [rad].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δσ<sub>v</sub>(z)</dt>
							<dd>Vertical stress increase at depth <em>z</em> [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>B, L</dt>
							<dd>Foundation width and length [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>m, n</dt>
							<dd>Influence-chart ratios B/z and L/z [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>I<sub>z</sub></dt>
							<dd>Newmark/Fadum corner influence factor (the bracketed quantity above divided by q<sub>net</sub>).</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The strip closed form is exact at the centreline; off-centre points require superposition of two half-strips.</li>
					<li>The four-quadrant superposition gives Δσ<sub>v</sub> at the centre of a rectangle. Δσ<sub>v</sub> at other plan points requires decomposing the loaded area into rectangles that share a corner at the target.</li>
					<li>The 2:1 rule over-predicts near the surface and under-predicts at depth relative to Boussinesq; it is offered as a sensitivity check, not as the primary route.</li>
					<li>Boussinesq assumes a homogeneous isotropic elastic half-space. Layered stiffness contrasts shift the Δσ<sub>v</sub>(z) profile; Westergaard would be closer for strongly layered fabrics but is not in the current route.</li>
				</ul>
			</section>

			<section id="integration" class="doc-card">
				<p class="section-label">Integration</p>
				<h2>4. Constrained-modulus integration of vertical strain</h2>
				<p>
					For each sublayer the app forms the mean effective stress between the in-situ and loaded
					state, evaluates the stress-dependent oedometric modulus at that level, and computes the
					vertical strain increment through the one-dimensional constitutive relation
					Δε<sub>v</sub> = Δσ<sub>v</sub>/E<sub>oed</sub>.
				</p>
				<div class="equations">
					<div class="formula">σ′<sub>v,f,i</sub> = σ′<sub>v,0,i</sub> + Δσ<sub>v,i</sub></div>
					<div class="formula">σ′<sub>mean,i</sub> = 0.5 (σ′<sub>v,0,i</sub> + σ′<sub>v,f,i</sub>)</div>
					<div class="formula">E<sub>oed,i</sub> = E<sub>oed,ref</sub>[(c′ cot φ′ + σ′<sub>mean,i</sub>) / (c′ cot φ′ + p<sub>ref</sub>)]<sup>m</sup></div>
					<div class="formula">Δε<sub>v,i</sub> = Δσ<sub>v,i</sub> / E<sub>oed,i</sub></div>
					<div class="formula">ΔS<sub>i</sub> = Δε<sub>v,i</sub> Δz<sub>i</sub>,   S = Σ ΔS<sub>i</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>σ′<sub>v,0,i</sub>, σ′<sub>v,f,i</sub></dt>
							<dd>Initial and final effective vertical stress in sublayer <em>i</em> [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>σ′<sub>mean,i</sub></dt>
							<dd>Mean effective stress used for stiffness evaluation [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>oed,ref</sub>, m, p<sub>ref</sub></dt>
							<dd>Hardening Soil reference oedometric stiffness [kPa], stress exponent [-], and reference pressure [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>c′, φ′</dt>
							<dd>Effective cohesion and friction angle [kPa, °]. Used in the Janbu-style pressure offset c′ cot φ′.</dd>
						</div>
						<div class="symbols__row">
							<dt>Δε<sub>v,i</sub></dt>
							<dd>Vertical strain increment in sublayer <em>i</em> [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δz<sub>i</sub></dt>
							<dd>Sublayer thickness [m].</dd>
						</div>
					</dl>
				</div>
				<div class="doc-callout">
					<strong>Engineering meaning.</strong> The settlement result is directly tied to the
					interpretation workflow: E<sub>oed,ref</sub>, m, c′, and φ′ all come from the interpreted
					CPT layer model. Changes to the Stage 4 / Stage 5 interpretation propagate immediately to
					the settlement output.
				</div>
			</section>

			<section id="trunc" class="doc-card">
				<p class="section-label">Truncation</p>
				<h2>5. Practical truncation and the "depth of influence"</h2>
				<p>
					The integral is taken to a finite depth z<sub>max</sub>. Truncation choice matters
					because the constrained-modulus form weights deeper, stiffer, lower-stress layers
					lightly but not negligibly over many sublayers. The app exposes three truncation rules
					so the engineer can match the question being asked.
				</p>
				<div class="equations">
					<div class="formula">(a) Δσ<sub>v</sub>(z<sub>max</sub>) ≤ 0.1 σ′<sub>v,0</sub>(z<sub>max</sub>)   — classical "10% of in-situ" rule</div>
					<div class="formula">(b) Δσ<sub>v</sub>(z<sub>max</sub>) ≤ 0.10 q<sub>net</sub>         — load-scaled rule (Lunne default)</div>
					<div class="formula">(c) z<sub>max</sub> = z<sub>CPT,bottom</sub>                  — cap at the sounding depth</div>
				</div>
				<ul class="notes">
					<li>Rule (a) is the most engineering-defensible for deep loaded zones below stiff layers.</li>
					<li>Rule (b) is the default Lunne / Robertson CPT practice; it converges faster in weak soils where σ′<sub>v,0</sub> is small.</li>
					<li>Rule (c) trades physical meaning for auditability: the integration stops where the interpretation stops.</li>
					<li>The app reports the truncation rule alongside S so the number is not interpretable without its provenance.</li>
				</ul>
			</section>

			<section id="rigid" class="doc-card">
				<p class="section-label">Corrections</p>
				<h2>6. Rigid-footing and finite-layer corrections</h2>
				<p>
					The centreline integral over-estimates settlement for a rigid footing because the
					contact pressure is not uniform but bowl-shaped. It can over- or under-estimate for a
					flexible footing at points off-centre. Two corrections are retained in the app as
					switchable options for comparison with closed-form elastic estimates.
				</p>
				<div class="equations">
					<div class="formula">Rigid-footing reduction (Skempton–Bjerrum style):  S<sub>rigid</sub> ≈ κ<sub>r</sub> S<sub>centreline</sub>,   κ<sub>r</sub> ≈ 0.80 for rectangles, 0.85 for strips</div>
					<div class="formula">Finite-layer correction (Christian–Carrier):  S<sub>finite</sub> = μ<sub>0</sub> μ<sub>1</sub> q<sub>net</sub> B / E<sub>s</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>κ<sub>r</sub></dt>
							<dd>Rigidity reduction coefficient. Derived by equating the rigid-footing closed-form elastic displacement to the flexible-footing centreline displacement.</dd>
						</div>
						<div class="symbols__row">
							<dt>μ<sub>0</sub>, μ<sub>1</sub></dt>
							<dd>Christian–Carrier embedment and finite-layer factors from the chart. Used as sensitivity comparators, not as the primary estimate.</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The rigid-footing reduction applies to the centreline integration only. For off-centre points the flexible-footing integral is more direct.</li>
					<li>The Christian–Carrier form assumes uniform elastic stiffness over the layer; it is a comparator in layered CPT profiles, not a replacement for the constrained-modulus integral.</li>
				</ul>
			</section>

			<section id="time" class="doc-card">
				<p class="section-label">Time rate</p>
				<h2>7. Terzaghi consolidation and the time factor</h2>
				<p>
					For saturated fine-grained layers the total settlement develops over time as excess pore
					pressure dissipates. The app exposes the one-dimensional Terzaghi route as a companion
					output. It does not replace transient consolidation; it converts the total S to a U(t)
					percentage so the engineer can compare early-life and long-term behaviour.
				</p>
				<div class="equations">
					<div class="formula">∂u/∂t = c<sub>v</sub> ∂²u/∂z²    (1D consolidation)</div>
					<div class="formula">c<sub>v</sub> = k E<sub>oed</sub>/γ<sub>w</sub></div>
					<div class="formula">T<sub>v</sub> = c<sub>v</sub> t / H<sub>d</sub>²</div>
					<div class="formula">U(T<sub>v</sub>) ≈ √(4 T<sub>v</sub>/π)             for U &lt; 0.6</div>
					<div class="formula">U(T<sub>v</sub>) ≈ 1 − (8/π²) exp(−π²T<sub>v</sub>/4)   for U &gt; 0.6</div>
					<div class="formula">S(t) = U(T<sub>v</sub>(t)) · S<sub>∞</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>c<sub>v</sub></dt>
							<dd>Coefficient of consolidation [m²/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>H<sub>d</sub></dt>
							<dd>Longest drainage path in the consolidating layer [m]. Half-layer thickness for double drainage, full layer for single drainage.</dd>
						</div>
						<div class="symbols__row">
							<dt>T<sub>v</sub></dt>
							<dd>Dimensionless time factor [-].</dd>
						</div>
						<div class="symbols__row">
							<dt>U(T<sub>v</sub>)</dt>
							<dd>Average degree of consolidation [-].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>Layers are identified as consolidating (fine-grained) from the Stage 3 classification and the interpreted conductivity.</li>
					<li>The consolidation integration is one-dimensional; radial drainage (wick drains) is outside the current route.</li>
					<li>For overlapping fine-grained layers, the app reports both single-layer U(t) and a conservative envelope using the largest H<sub>d</sub>.</li>
				</ul>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Limitations</p>
				<h2>8. Assumptions and boundaries of validity</h2>
				<ul class="notes">
					<li>Centreline integration by default; differential settlement across a footing is not produced unless the engineer repeats the calculation at multiple plan positions.</li>
					<li>Boussinesq (homogeneous isotropic half-space). Strong stiffness layering biases the Δσ<sub>v</sub>(z) shape; Westergaard and Fröhlich are alternative transforms and are not in the current route.</li>
					<li>Creep (secondary compression) is not integrated; the result is the primary-consolidation estimate.</li>
					<li>Soft clay at high stress level sits outside the Janbu-style constitutive form; the app warns when the mean stress exceeds a configurable limit relative to the yield stress.</li>
					<li>Time-rate output is a 1D comparison; true 3D consolidation with radial drainage requires a dedicated transient model.</li>
					<li>The deeper audit trail remains in <a href="/docs/full#settlement">the full technical specification</a>.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>Boussinesq, J. (1885). <em>Application des potentiels à l'étude de l'équilibre et du mouvement des solides élastiques</em>. Gauthier-Villars.</li>
					<li>Newmark, N. M. (1935). Simplified computation of vertical pressures in elastic foundations. <em>Univ. of Illinois Eng. Exp. Sta., Circ. 24</em>.</li>
					<li>Fadum, R. E. (1948). Influence values for estimating stresses in elastic foundations. <em>Proc. 2nd ICSMFE</em>, Vol. 3, 77–84.</li>
					<li>Terzaghi, K. & Peck, R. B. (1967). <em>Soil Mechanics in Engineering Practice</em>. Wiley.</li>
					<li>Janbu, N. (1963). Soil compressibility as determined by oedometer and triaxial tests. <em>Proc. Eur. Conf. on Soil Mech.</em>, Wiesbaden.</li>
					<li>Christian, J. T. & Carrier, W. D. (1978). Janbu, Bjerrum and Kjaernsli's chart reinterpreted. <em>Can. Geotech. J.</em> 15(1), 123–128.</li>
					<li>Lunne, T., Robertson, P. K. & Powell, J. J. M. (1997). <em>Cone Penetration Testing in Geotechnical Practice</em>. Blackie Academic & Professional.</li>
				</ul>
			</section>
		</main>
	</div>
</div>
