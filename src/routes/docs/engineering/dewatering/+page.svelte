<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';

	const pageTitle = 'Dewatering — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 dewatering workflow: Dupuit-Forchheimer radial flow, transmissivity-moment formulation, layered conductivity, Sichardt screening radius, image method for trenches, drawdown profile, effective-stress change, settlement response, and limitations.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/dewatering';
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
				<a href="/docs/full#dewatering">Specification anchor</a>
			</nav>
		</div>
	</header>

	<header class="hero hero--compact">
		<div class="hero__inner">
			<p class="hero__eyebrow">Stage 6 / dewatering</p>
			<h1>Stage 6 dewatering.</h1>
			<p class="hero__lead">
				The dewatering route couples a steady-state unconfined radial-flow model with the CPT-based
				effective-stress change and settlement response at the CPT location. It derives the
				Dupuit–Forchheimer expression for layered profiles, uses the Sichardt screening radius for
				the outer boundary, handles the trench case via the image method, and feeds the resulting
				drawdown into the same constrained-modulus integration used in the settlement route.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Dewatering documentation navigation">
			<div class="docs-nav__title">Dewatering</div>
			<a href="#scope">Scope and intent</a>
			<a href="#darcy">Darcy's law and radial flow</a>
			<a href="#dupuit">Dupuit-Forchheimer derivation</a>
			<a href="#transmissivity">Transmissivity and layered profile</a>
			<a href="#profile">Drawdown profile between source and CPT</a>
			<a href="#radius">Radius of influence (Sichardt)</a>
			<a href="#image">Trenches and the image method</a>
			<a href="#stress">Effective stress and settlement response</a>
			<a href="#limits">Limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and deliverable</h2>
				<p>
					The dewatering route is a <strong>serviceability-oriented screening model</strong>. It
					couples hydraulic drawdown with CPT-based effective-stress change to report pumping rate
					and settlement at the CPT location. It is layered by construction — the Stage 4
					interpreted conductivity profile is preserved rather than collapsed to one equivalent k.
				</p>
				<div class="doc-callout">
					<strong>Model class.</strong> Steady-state analytical screen. Not a full transient
					groundwater model, not a substitute for a regional flow study when hydraulic interaction
					becomes critical, and not an unsaturated-flow engine.
				</div>
				<div class="symbols">
					<div class="symbols__title">Primary quantities</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>Q</dt>
							<dd>Steady-state discharge from the source [m³/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>s(r), Δh<sub>CPT</sub></dt>
							<dd>Drawdown field and drawdown at the CPT observation point [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>T(h)</dt>
							<dd>Transmissivity of the currently saturated profile as a function of saturated thickness [m²/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>ΔS<sub>dewatering</sub></dt>
							<dd>Settlement at the CPT induced by the drawdown [m].</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="darcy" class="doc-card">
				<p class="section-label">Darcy's law</p>
				<h2>2. Darcy flow, radial co-ordinates, and saturated thickness</h2>
				<p>
					Saturated flow through a porous medium is described by Darcy's law: specific discharge is
					proportional to the hydraulic gradient with the conductivity as the proportionality
					constant. In radial co-ordinates about an axisymmetric source, continuity over a
					cylinder of radius r couples the specific discharge to the total discharge Q.
				</p>
				<div class="equations">
					<div class="formula">q = −k ∇h       (Darcy's law)</div>
					<div class="formula">Q = 2πr · h(r) · q<sub>r</sub>        (continuity across radius r)</div>
					<div class="formula">q<sub>r</sub> = −k dh/dr          (radial specific discharge)</div>
					<div class="formula">⇒  Q = −2πr k h(r) dh/dr</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>q, q<sub>r</sub></dt>
							<dd>Darcy specific discharge (flux per unit area), general and radial component [m/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>h(r)</dt>
							<dd>Saturated thickness above the aquifer base at radial distance r from the source [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>k</dt>
							<dd>Local horizontal hydraulic conductivity [m/s].</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="dupuit" class="doc-card">
				<p class="section-label">Dupuit-Forchheimer</p>
				<h2>3. Dupuit-Forchheimer derivation for the unconfined aquifer</h2>
				<p>
					For the unconfined case the upper boundary of the flow domain is the phreatic surface,
					which moves toward the source during pumping. Dupuit's approximation ignores the
					vertical flow component at the phreatic surface, so the head gradient reduces to
					dh/dr, independent of elevation. Integrating the continuity equation from the source
					(r<sub>w</sub>, h<sub>w</sub>) to the far field (R, h<sub>0</sub>) yields the classical
					Dupuit expression.
				</p>
				<div class="equations">
					<div class="formula">Q = −2πr k h dh/dr     (from continuity)</div>
					<div class="formula">∫<sub>r<sub>w</sub></sub><sup>R</sup> dr/r = −(2π k / Q) ∫<sub>h<sub>w</sub></sub><sup>h<sub>0</sub></sup> h dh</div>
					<div class="formula">⇒ ln(R/r<sub>w</sub>) = (π k / Q)(h<sub>0</sub>² − h<sub>w</sub>²)</div>
					<div class="formula">Q = πk(h<sub>0</sub>² − h<sub>w</sub>²) / ln(R/r<sub>w</sub>)   (Dupuit formula, homogeneous)</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>r<sub>w</sub></dt>
							<dd>Source radius (well, well-point radius, or equivalent outer radius of a trench image) [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>h<sub>w</sub>, h<sub>0</sub></dt>
							<dd>Saturated thickness at the source and at the far-field boundary [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>R</dt>
							<dd>Radius of influence — outer boundary at which h ≈ h<sub>0</sub> [m]. See §6.</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>Dupuit assumes horizontal flow, hydrostatic pressure on verticals, and a phreatic surface shallow relative to the aquifer depth. For shallow drawdown this is tight; for deep drawdown the true phreatic surface dips steeper near the well than Dupuit predicts.</li>
					<li>The expression assumes isotropic k. When vertical and horizontal k differ, the effective k in the formula is k<sub>h</sub>; vertical flow losses are a correction, not a redefinition.</li>
				</ul>
			</section>

			<section id="transmissivity" class="doc-card">
				<p class="section-label">Transmissivity moment</p>
				<h2>4. Transmissivity and transmissivity-moment formulation for a layered profile</h2>
				<p>
					The CPT column is layered, and collapsing it to a single conductivity would lose most of
					the information the interpretation captures. The transmissivity-moment formulation keeps
					the layering by generalising the Dupuit integrand: the function T(h) returns the
					transmissivity of the profile when the saturated thickness is h, and M(h) is its
					integral. Substituting M into the Dupuit derivation replaces the h·dh integral directly
					without any further assumption about layer geometry.
				</p>
				<div class="equations">
					<div class="formula">T(h) = Σ<sub>i</sub> k<sub>h,i</sub> b<sub>i</sub>(h)    (layered transmissivity at saturated thickness h)</div>
					<div class="formula">M(h) = ∫<sub>0</sub><sup>h</sup> T(ξ) dξ                    (transmissivity moment)</div>
					<div class="formula">Q dr / r = 2π dM(h)    ⇒    Q ln(R/r<sub>w</sub>) = 2π [M(h<sub>0</sub>) − M(h<sub>w</sub>)]</div>
					<div class="formula">Q = 2π [M(h<sub>0</sub>) − M(h<sub>w</sub>)] / ln(R/r<sub>w</sub>)</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>k<sub>h,i</sub></dt>
							<dd>Horizontal conductivity of layer <em>i</em> [m/s].</dd>
						</div>
						<div class="symbols__row">
							<dt>b<sub>i</sub>(h)</dt>
							<dd>Saturated-thickness contribution of layer <em>i</em> as a function of saturated thickness h [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>T, M</dt>
							<dd>Transmissivity [m²/s] and transmissivity moment [m³/s].</dd>
						</div>
					</dl>
				</div>
				<p>
					For a homogeneous aquifer (one layer, k<sub>h,1</sub> = k), T(h) = k h, so M(h) = kh²/2
					and the formulation collapses exactly to the classical Dupuit expression
					Q = πk(h<sub>0</sub>² − h<sub>w</sub>²) / ln(R/r<sub>w</sub>). In the general layered case the
					evaluation is numerical but cheap — the app integrates M(h) analytically through each
					piecewise-constant layer.
				</p>
			</section>

			<section id="profile" class="doc-card">
				<p class="section-label">Drawdown profile</p>
				<h2>5. Drawdown profile between the source and the CPT</h2>
				<p>
					For a radial source the head profile between r<sub>w</sub> and R follows from the same
					transmissivity-moment integration, solved forward in r rather than at the boundaries.
					The drawdown at the CPT observation point is then sampled from the profile.
				</p>
				<div class="equations">
					<div class="formula">M(h(r)) = M(h<sub>w</sub>) + (Q / 2π) ln(r/r<sub>w</sub>)</div>
					<div class="formula">h(r) = M<sup>−1</sup>(M(h<sub>w</sub>) + (Q/2π) ln(r/r<sub>w</sub>))</div>
					<div class="formula">Δh<sub>CPT</sub> = h<sub>0</sub> − h(r<sub>CPT</sub>)</div>
					<div class="formula">Homogeneous limit:  h²(r) = h<sub>w</sub>² + (Q/(πk)) ln(r/r<sub>w</sub>)</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>r<sub>CPT</sub></dt>
							<dd>Horizontal distance from the source to the CPT observation point [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>M<sup>−1</sup></dt>
							<dd>Inverse of the transmissivity-moment function. For a homogeneous aquifer, h = √(2M/k).</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>M is monotonically non-decreasing in h because T ≥ 0 everywhere, so the inverse is well-defined up to numerical precision.</li>
					<li>The CPT location is treated as the observation point. For a design using multiple CPTs, the app runs one evaluation per location.</li>
				</ul>
			</section>

			<section id="radius" class="doc-card">
				<p class="section-label">Radius of influence</p>
				<h2>6. Sichardt screening radius and its limitations</h2>
				<p>
					The Dupuit expression requires an outer boundary condition h = h<sub>0</sub> at r = R.
					In the absence of a natural boundary (a stream, a lake, a low-permeability barrier), the
					engineer adopts a screening radius. The most widely used rule is Sichardt (1928), which
					relates R to the drawdown and the effective conductivity.
				</p>
				<div class="equations">
					<div class="formula">R = C s √k<sub>eff,h</sub>     (Sichardt screen)</div>
					<div class="formula">C ≈ 3000 (well) – 2000 (trench)     with s in m and k in m/s</div>
					<div class="formula">s = h<sub>0</sub> − h<sub>w</sub>      (drawdown at the source)</div>
					<div class="formula">k<sub>eff,h</sub> = Σ k<sub>h,i</sub> b<sub>i</sub> / Σ b<sub>i</sub>     (thickness-weighted horizontal conductivity)</div>
				</div>
				<div class="doc-callout doc-callout--warn">
					<strong>Transparency note.</strong> Sichardt is a practical screening rule with no
					mechanical derivation. The app reports it because the rule is widely used in engineering
					practice, but documents it as approximate and provides the option to override R with a
					project-specific value sourced from observed responses on similar works nearby.
				</div>
			</section>

			<section id="image" class="doc-card">
				<p class="section-label">Trenches and line sources</p>
				<h2>7. Trench geometry and the image method</h2>
				<p>
					A pumped trench is a line source rather than a point source. For steady-state
					axisymmetric flow, the equivalent radial form is recovered through the image method:
					replace the line source with an infinite sequence of point sources (or, equivalently, an
					integrated line sink). For short trenches compared to the radius of influence, the
					equivalent radius r<sub>w,eq</sub> of the trench is approximately π times the half-length
					divided by 2; for long trenches parallel to the aquifer boundary, a two-sided linear
					seepage form is used.
				</p>
				<div class="equations">
					<div class="formula">Short trench (L ≪ R):     r<sub>w,eq</sub> ≈ π L / 2       (Dupuit form with L = trench half-length)</div>
					<div class="formula">Long trench (L ≫ R):     Q = k (h<sub>0</sub>² − h<sub>w</sub>²) · (L<sub>t</sub>/R)     (linear seepage form per unit length)</div>
					<div class="formula">Intermediate: app linearly blends the two limits on L/R</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>L, L<sub>t</sub></dt>
							<dd>Half-length [m] and full length [m] of the trench.</dd>
						</div>
						<div class="symbols__row">
							<dt>r<sub>w,eq</sub></dt>
							<dd>Equivalent radial source radius used in the Dupuit form [m].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The trench is treated as a single equivalent source; well-point arrays are modelled by this route as well, with r<sub>w,eq</sub> estimated from the array span.</li>
					<li>Head losses inside the trench itself (skin losses, filter-cake effects) are not modelled explicitly — the engineer handles them by adjusting h<sub>w</sub>.</li>
				</ul>
			</section>

			<section id="stress" class="doc-card">
				<p class="section-label">Stress and settlement</p>
				<h2>8. Effective-stress change and settlement response</h2>
				<p>
					Once the new phreatic level at the CPT is known, pore pressure and effective stress are
					recomputed and settlement is evaluated with the same constrained-modulus philosophy used
					in the settlement route. Drawdown loads the soil column by removing a portion of the
					buoyancy the water once provided.
				</p>
				<div class="equations">
					<div class="formula">z′<sub>w</sub> = z<sub>w,0</sub> + Δh<sub>CPT</sub>      (new phreatic depth)</div>
					<div class="formula">u′(z) = γ<sub>w</sub> max(0, z − z′<sub>w</sub>)</div>
					<div class="formula">σ<sub>v</sub>(z) unchanged; σ′<sub>v,new</sub>(z) = σ<sub>v</sub>(z) − u′(z)</div>
					<div class="formula">Δσ′<sub>v</sub>(z) = σ′<sub>v,new</sub>(z) − σ′<sub>v,old</sub>(z) = u<sub>old</sub>(z) − u′(z)</div>
					<div class="formula">Δε<sub>v,i</sub> = Δσ′<sub>v,i</sub> / E<sub>oed,i</sub>    (constrained-modulus constitutive relation)</div>
					<div class="formula">ΔS<sub>dewatering</sub> = Σ Δε<sub>v,i</sub> Δz<sub>i</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>z<sub>w,0</sub>, z′<sub>w</sub></dt>
							<dd>Original and post-drawdown phreatic-level depth below ground [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>u<sub>old</sub>, u′</dt>
							<dd>Pore pressure before and after drawdown [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>Δσ′<sub>v</sub></dt>
							<dd>Effective-stress increase from drawdown [kPa]. Positive under the phreatic fall.</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>oed,i</sub></dt>
							<dd>Oedometric stiffness in sublayer <em>i</em> [kPa], evaluated at the mean stress level between the old and new state.</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The app reports two σ<sub>v</sub> assumptions (saturated-weight everywhere and original layering) so the user can see how sensitive the result is to the assumed total stress in the partially submerged column.</li>
					<li>Optional fine-grained time interpretation follows the same Terzaghi consolidation logic used in the settlement route.</li>
					<li>The settlement output is at the CPT, not a spatial settlement field.</li>
				</ul>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Limitations</p>
				<h2>9. Assumptions and boundaries of validity</h2>
				<ul class="notes">
					<li>Steady-state only. Transient drawdown (Theis, Jacob) is not in the current route.</li>
					<li>Dupuit assumption: horizontal flow, hydrostatic pressure on verticals. Near the well the true phreatic surface dips steeper; Q is typically conservative relative to true 3D flow.</li>
					<li>Sichardt for R is a screening rule, not a boundary condition. The engineer should override R with observed or modelled values when hydraulic sensitivity matters.</li>
					<li>Aquifer bottom is assumed horizontal and impermeable.</li>
					<li>Radial symmetry breaks down near streams, sheet piles, and other hydraulic boundaries. The trench image limit helps but does not reproduce partial boundary conditions.</li>
					<li>Partial-penetration effects (well screen shorter than saturated thickness) are not modelled; the app assumes full penetration.</li>
					<li>Unsaturated-zone transient effects in the capillary fringe are not captured.</li>
					<li>The deeper audit trail remains in <a href="/docs/full#dewatering">the full technical specification</a>.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<ul class="notes">
					<li>Dupuit, J. (1863). <em>Études théoriques et pratiques sur le mouvement des eaux dans les canaux découverts et à travers les terrains perméables</em>. Dunod, Paris.</li>
					<li>Forchheimer, P. (1886). Ueber die Ergiebigkeit von Brunnen-Anlagen und Sickerschlitzen. <em>Z. des Vereins deutscher Ingenieure</em>.</li>
					<li>Sichardt, W. (1928). <em>Das Fassungsvermögen von Bohrbrunnen und seine Bedeutung für die Grundwasserabsenkung, insbesondere für größere Absenkungstiefen</em>. Springer, Berlin.</li>
					<li>Theis, C. V. (1935). The relation between the lowering of the piezometric surface and the rate and duration of discharge of a well using ground-water storage. <em>Trans. Am. Geophys. Union</em> 16(2), 519–524.</li>
					<li>Cooper, H. H. & Jacob, C. E. (1946). A generalized graphical method for evaluating formation constants and summarizing well-field history. <em>Trans. Am. Geophys. Union</em> 27(4), 526–534.</li>
					<li>Powers, J. P., Corwin, A. B., Schmall, P. C. & Kaeck, W. E. (2007). <em>Construction Dewatering and Groundwater Control — New Methods and Applications</em>. Wiley.</li>
				</ul>
			</section>
		</main>
	</div>
</div>
