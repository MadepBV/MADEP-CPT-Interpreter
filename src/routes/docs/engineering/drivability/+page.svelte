<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';

	const pageTitle = 'Drivability — MADEP CPT Interpreter';
	const pageDescription =
		'Technical chapter for the Stage 6 drivability route: CPT-based static resistance to driving (reference and Alm & Hamre 2001 methods), element geometry from the wall section, the Hypervib1-type vibratory force-envelope method, the Smith (1960) one-dimensional wave equation for impact hammers with GRLWEAP / FHWA default parameters, the verified hammer catalogue, provenance and non-normative status, and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/drivability';
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
			<p class="hero__eyebrow">Stage 6 / drivability</p>
			<h1>Drivability.</h1>
			<p class="hero__lead">
				The drivability route answers the installation question for a steel element of the retaining
				wall — a single or paired sheet pile, or an H-pile of a soldier-pile wall — driven through the
				interpreted CPT profile. It turns the CPT trace into a <strong>static resistance to driving</strong>
				(SRD) at every trial toe depth, then runs either the <strong>vibratory force-envelope</strong> method
				(Hypervib1-type, CPT based) for a vibrodriver or the <strong>Smith (1960) one-dimensional wave
				equation</strong> for an impact hammer, and reports the required machine, the blow counts, the
				pile stresses and the transmitted energy. The models are empirical and
				<strong>non-normative</strong>: no Eurocode partial factor is applied to an installation resistance.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Drivability documentation navigation">
			<div class="docs-nav__title">Drivability</div>
			<a href="#scope">Scope and status</a>
			<a href="#srd">CPT → resistance profile</a>
			<a href="#geometry">Element geometry</a>
			<a href="#vibratory">Vibratory force envelope</a>
			<a href="#impact">Smith wave equation</a>
			<a href="#push">Static push-in</a>
			<a href="#hammers">Hammer catalogue</a>
			<a href="#datasheet">From a supplier data sheet</a>
			<a href="#outputs">Outputs and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and positioning</p>
				<h2>1. The four calculations that must not be confused</h2>
				<p>
					Following the course chapter (§2), four different engineering questions surround a driven
					element, and no single equation answers them all:
				</p>
				<ul class="notes">
					<li><strong>Permanent design</strong> — what geotechnical resistance and serviceability must the completed pile or wall provide? A Eurocode 7 problem, handled by the <a href="/docs/engineering/retaining-wall">retaining-wall</a>, <a href="/docs/engineering/soldier-pile">soldier-pile</a> and <a href="/docs/engineering/pile">pile-capacity</a> chapters.</li>
					<li><strong>Installation drivability</strong> — can the selected element and plant penetrate the actual profile without refusal, instability or unacceptable pile stress? This chapter.</li>
					<li><strong>Vibration emission and reception</strong> — what vibration reaches the neighbours? The <a href="/docs/engineering/vibration">vibration chapter</a>.</li>
					<li><strong>Execution verification</strong> — how are the predictions checked and updated on site? Instrumented trial and trigger-action plan (vibration chapter §7–8).</li>
				</ul>
				<div class="doc-callout">
					<strong>Non-normative status (PLAN D10; course §3.3, §7.1, §18.5).</strong> The drivability models
					are empirical research equations. Attaching a familiar factor such as 1.35 or 1.50 does not make
					them Eurocode compliant, and applying the permanent-design strength factors backwards to an
					installation resistance is <em>unsafe</em> for machine selection (a lower design strength makes
					the pile look easier to drive). The route therefore uses an <strong>upper-bound resistance
					profile</strong> and a transparent equipment reserve multiplier m<sub>R</sub>; no partial factor
					appears anywhere in <code>srd-from-cpt.js</code>, <code>vibratory-drivability.js</code> or
					<code>impact-wave-equation.js</code>. Results must be confirmed by an instrumented trial.
				</div>
			</section>

			<section id="srd" class="doc-card">
				<p class="section-label">Resistance profile</p>
				<h2>2. CPT → static resistance to driving</h2>
				<p>
					<code>buildDrivingResistanceProfile</code> resamples the CPT of the active sounding on a uniform
					grid of dz = 0.10 m below the driving platform (the same datum shift as the wall design; the CPT
					ground-level offset is honoured and reported). q<sub>c</sub> is read in MPa and converted to kPa;
					the shaft stress of interval j is taken at its centre, the toe value at z<sub>j</sub>. Rows with a
					missing f<sub>s</sub> use f<sub>s</sub> = R<sub>f,assumed</sub>·q<sub>c</sub> (default 1 %) with a
					note; depths beyond the CPT hold the last value (note emitted); an optional arithmetic averaging
					window ± w around the toe is available (default 0 = point value, as in the course).
				</p>
				<p><strong>Reference method</strong> (course §7.2 “static reference unit resistance”) — an illustrative upper-bound screen, not a pile design method; the user factors default to 1:</p>
				<div class="equations">
					<div class="formula">q<sub>s</sub>(z) = f<sub>toe</sub>·f<sub>SRD</sub>·q<sub>c</sub>(z),   τ<sub>s</sub>(z) = f<sub>shaft</sub>·f<sub>SRD</sub>·f<sub>s</sub>(z)</div>
					<div class="formula">FR(z) = 100·f<sub>s</sub>/q<sub>c</sub>     (percentage number)</div>
				</div>
				<p><strong>Alm &amp; Hamre (2001)</strong> — friction-fatigue model, coefficients transcribed from the ISSMGE open-access paper (15th ICSMGE Istanbul, pp. 1297–1302) and cross-checked against the OPILE and groundhog documentation. p₀′ = effective overburden at the interval centre (from the layer unit weights and a single water table unless σ′<sub>v0</sub>[] is supplied; floor 1 kPa), p<sub>a</sub> = 100 kPa, p = tip penetration, δ = constant-volume interface friction angle (per-layer input; module default 29°, not from the paper):</p>
				<div class="equations">
					<div class="formula">τ<sub>i</sub>(p) = f<sub>s,res</sub> + (f<sub>s,i</sub> − f<sub>s,res</sub>)·exp[−k·(p − z<sub>i</sub>)]     (eq. 1, friction fatigue)</div>
					<div class="formula">clay:   f<sub>s,i</sub> = f<sub>s</sub>(CPT),   f<sub>s,res</sub> = 0.004·q<sub>T</sub>·(1 − 0.0025·q<sub>T</sub>/p₀′)     (eq. 2)</div>
					<div class="formula">sand:   f<sub>s,i</sub> = K·p₀′·tan δ,   K·p₀′ = 0.0132·q<sub>T</sub>·(p₀′/p<sub>a</sub>)<sup>0.13</sup>,   f<sub>s,res</sub> = 0.2·f<sub>s,i</sub>     (eq. 3, 4)</div>
					<div class="formula">k = (q<sub>T</sub>/p₀′)<sup>0.5</sup> / 80     (eq. 5)</div>
					<div class="formula">sand:   q<sub>tip</sub> = 0.15·q<sub>T</sub>·(q<sub>T</sub>/p₀′)<sup>0.2</sup>;   clay:   q<sub>tip</sub> = 0.6·q<sub>T</sub>     (eq. 6)</div>
					<div class="formula">0 ≤ f<sub>s,res</sub> ≤ f<sub>s,i</sub>   (clip);   intervals outside the layer list → sand, δ = 29° (note)</div>
				</div>
				<ul class="notes">
					<li>q<sub>c</sub> is used where the paper writes q<sub>T</sub> (no pore-pressure correction is applied).</li>
					<li>The sand friction is calibrated for outside friction only; for open elements with inside friction the paper's recommendation — 50 % on both faces — is available (<code>insideFriction: 'half-both'</code>). Unplugged piles are assumed.</li>
					<li>The paper's ×1.25 for an upper-bound profile is the <code>srdFactor</code> option (applied to all unit resistances, note emitted).</li>
					<li>In the app the layer soil class comes from the interpreted CPT layer type (clay/peat → clay, otherwise sand for Alm &amp; Hamre; silt is a separate class only for the Smith damping).</li>
				</ul>
				<p>Integration at every trial toe depth z<sub>j</sub> (P = outer + inner contact perimeter, A<sub>toe</sub> = toe area × plug ratio, interlock resistance in kN per metre embedded):</p>
				<div class="equations">
					<div class="formula">R<sub>shaft</sub>(z<sub>j</sub>) = Σ<sub>i ≤ j</sub> τ<sub>i</sub>(z<sub>j</sub>)·P·dz     (Alm &amp; Hamre: τ<sub>i</sub> depends on the tip position)</div>
					<div class="formula">R<sub>interlock</sub>(z<sub>j</sub>) = r<sub>interlock</sub>·z<sub>j</sub>     (course §6.5: not derivable from CPT — experience / trial)</div>
					<div class="formula">R<sub>toe</sub>(z<sub>j</sub>) = q<sub>s</sub>(z<sub>j</sub>)·A<sub>toe</sub></div>
					<div class="formula">R<sub>static</sub>(z<sub>j</sub>) = R<sub>shaft</sub> + R<sub>interlock</sub> + R<sub>toe</sub></div>
				</div>
			</section>

			<section id="geometry" class="doc-card">
				<p class="section-label">Element geometry</p>
				<h2>3. Driven element from the wall section</h2>
				<p>
					The geometry comes from the catalogue section selected for the wall design
					(<code>drivenElement</code> in the drivability panel; SI properties from
					<code>section-properties.js</code>):
				</p>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr><th>Element</th><th>Toe area</th><th>Contact perimeter</th><th>Interlock</th><th>Mass</th></tr>
							</thead>
							<tbody>
								<tr><td>Sheet pile, single</td><td>A (m²/m) × b — steel area at the toe plane</td><td>developed perimeter ≈ 2·A/t per metre of wall × b (both faces of the developed section — a documented approximation)</td><td>two free interlocks: 2 × r<sub>interlock</sub></td><td>mass per single pile</td></tr>
								<tr><td>Sheet pile, pair</td><td>A × 2b</td><td>2·A/t × 2b</td><td>one free interlock: 1 × r<sub>interlock</sub></td><td>2 × mass per pile</td></tr>
								<tr><td>H-pile, unplugged (default)</td><td>steel area A</td><td>2b (flange faces) + 2h (web cavities)</td><td>0</td><td>catalogue kg/m</td></tr>
								<tr><td>H-pile, plugged</td><td>box area b·h</td><td>box perimeter 2(b + h)</td><td>0</td><td>catalogue kg/m</td></tr>
							</tbody>
						</table>
					</div>
				</div>
				<p>
					The steel area A<sub>s</sub> (for the stress screen and the wave-equation impedance) is always the
					steel area. The target depth defaults to the retained height + over-excavation + provided
					embedment of the wall design; the modelled pile length is the target depth + 0.5 m of stick-up.
					For the vibratory run the pile mass (mass per metre × pile length) is added to the vibrator's
					dynamic mass unless switched off.
				</p>
			</section>

			<section id="vibratory" class="doc-card">
				<p class="section-label">Vibrodriving</p>
				<h2>4. Vibratory force-envelope method (Hypervib1-type)</h2>
				<p>
					For every trial toe depth z<sub>j</sub> ≤ target, <code>runVibratoryDrivability</code> finds the
					smallest peak centrifugal force F<sub>c</sub> for which the peak downward force
					F<sub>c</sub> + W<sub>eff</sub> is at least m<sub>R</sub> times the vibratory driving resistance
					R<sub>drive</sub>(F<sub>c</sub>). Because the driving resistance itself depends on F<sub>c</sub>
					through the pile acceleration (higher acceleration → more degradation), the root is found by
					bisection with an inner acceleration iteration. Units kN, kPa, m, kg, Hz, g = 9.81 m/s².
				</p>
				<p>Degradation (course §5.2, §7.3; Holeyman 2002 eq. 18) — FR as a percentage number, Λ the liquefaction factor (default 6, clipped to the published 4–10 range with a note):</p>
				<div class="equations">
					<div class="formula">χ<sub>i</sub> = (1 − 1/Λ)·exp(−1/FR<sub>i</sub>) + 1/Λ     (FR = 0 → χ = 1/Λ)</div>
					<div class="formula">q<sub>l</sub> = χ·q<sub>s</sub>,   τ<sub>l</sub> = χ·τ<sub>s</sub>     (fully degraded, “liquefied”)</div>
				</div>
				<p>Acceleration-dependent resistance (course §7.5–7.6; Holeyman 2002 eq. 19), iterated to convergence (tolerance 0.01 on |Δa|/max(a, 0.01g), at most 50 iterations):</p>
				<div class="equations">
					<div class="formula">α = a/g</div>
					<div class="formula">q<sub>d</sub> = (q<sub>s</sub> − q<sub>l</sub>)·e<sup>−α</sup> + q<sub>l</sub>,   τ<sub>d</sub> = (τ<sub>s</sub> − τ<sub>l</sub>)·e<sup>−α</sup> + τ<sub>l</sub></div>
					<div class="formula">R<sub>s</sub> = Σ τ<sub>d,i</sub>·P·dz,   R<sub>b</sub> = q<sub>d,toe</sub>·A<sub>toe</sub>,   R<sub>drive</sub> = R<sub>s</sub> + R<sub>b</sub> + R<sub>interlock</sub></div>
					<div class="formula">a = max[0, 1000·(F<sub>c</sub> − δ<sub>H</sub>·R<sub>s</sub>) / M<sub>dyn</sub>]     (δ<sub>H</sub> = 0 → free acceleration, optimistic baseline)</div>
				</div>
				<p>Force envelope and root (course §4.4, §8; Holeyman 2002 §5.2 force-equilibrium class):</p>
				<div class="equations">
					<div class="formula">W<sub>eff</sub> = M<sub>dyn</sub>·g/1000 + F<sub>crowd</sub> − T<sub>line</sub>     [kN]</div>
					<div class="formula">G(F<sub>c</sub>) = F<sub>c</sub> + W<sub>eff</sub> − m<sub>R</sub>·R<sub>drive</sub>(F<sub>c</sub>)   ≥ 0</div>
					<div class="formula">F<sub>c,min</sub> = smallest F<sub>c</sub> with G ≥ 0   — bisection on [0, m<sub>R</sub>·R<sub>static</sub> + 1], 64 halvings   (G is monotone because R<sub>drive</sub> decreases with α)</div>
					<div class="formula">reported for m<sub>R</sub> (default 1.0) and always for m<sub>R</sub> = 1.25, each with its governing depth (max over the depths)</div>
				</div>
				<p>Conversion to a machine requirement at the operating frequency f, and the preliminary stress screen (course §4, §8.7–8.8):</p>
				<div class="equations">
					<div class="formula">ω = 2πf;   M<sub>e</sub> = 1000·F<sub>c</sub>/ω²     [kg·m]</div>
					<div class="formula">s₀ = M<sub>e</sub>/M<sub>dyn</sub>     [m];   A<sub>pp</sub> = 2·s₀</div>
					<div class="formula">α<sub>req</sub> = 1000·F<sub>c</sub>/(M<sub>dyn</sub>·g)</div>
					<div class="formula">σ<sub>screen</sub> = (F<sub>c</sub> + W<sub>eff</sub>)/A<sub>s</sub>     (uniform axial stress; not computed when A<sub>s</sub> is unknown)</div>
				</div>
				<p>
					A <strong>candidate machine</strong> (catalogue or custom F<sub>c</sub>, or M<sub>e</sub>·ω²/1000) is
					checked at every depth: the worst margins G(m<sub>R</sub> = 1) and G(1.25), α, R<sub>drive</sub>
					and the machine conversion at that force; the force-envelope curve G(F<sub>c</sub>) is plotted at the
					governing depth up to 1.4 × the largest force of interest.
				</p>
				<div class="symbols">
					<div class="symbols__title">Provenance and verification status (agent report §2.1)</div>
					<dl class="symbols__list">
						<div class="symbols__row"><dt>Verified verbatim</dt><dd>χ (eq. 18a/b), the acceleration interpolation q<sub>d</sub> = (q<sub>s</sub> − q<sub>l</sub>)e<sup>−α</sup> + q<sub>l</sub> (eq. 19a/b), FR as a percentage and “Λ chosen in the range of 4 to 10” — Holeyman, A. (2002) <em>Soil behavior under vibratory driving</em>, keynote TransVib 2002, pp. 14–15 (open PDF).</dd></div>
						<div class="symbols__row"><dt>Verified as a model class</dt><dd>The inequality F<sub>c</sub> + W<sub>eff</sub> &gt; R<sub>drive</sub> is the “force equilibrium model” class (Jonker 1987; Warrington 1989) reviewed in the same keynote §5.2 and in course §4.4.</dd></div>
						<div class="symbols__row"><dt>Course only</dt><dd>The δ<sub>H</sub> shaft-reaction reduction of the free acceleration and the m<sub>R</sub> reserve multiplier. The keynote describes Hypervib1 as an “iterative procedure to identify the coexisting acceleration and soil resistance” without giving δ<sub>H</sub>; Van Rompaey, Legrand &amp; Holeyman (1995) and Holeyman &amp; Whenham (2017) are paywalled and were <em>not</em> checked in full (the 2017 abstract confirms the Λ nomenclature).</dd></div>
						<div class="symbols__row"><dt>Numerical parity</dt><dd>Course §8 worked example reproduced to better than 4 significant figures: χ = 0.473233, R<sub>static</sub> = 252.794 kN, W<sub>eff</sub> = 36.582 kN, α(125 kN) = 5.7919, q<sub>d</sub> = 1424.522 kPa, R<sub>drive</sub> = 120.037 kN, G(1.25) = 11.536 kN, F<sub>c,min</sub> = 85.574 / 113.809 kN, M<sub>e</sub> = 2.5847 kg·m, s₀ = 1.175 mm, σ = 24.3 MPa, and the seven §8.9 sensitivities.</dd></div>
					</dl>
				</div>
				<div class="doc-callout">
					<strong>What it does not do.</strong> It does not predict the penetration rate, and it does not
					check amplitude under load, clamp capacity, power, wave stress or ground vibration
					(course §7.10) — those are separate checks. δ<sub>H</sub> = 0 is an optimistic baseline that
					should be calibrated against the measured amplitude of a trial (course §15.8). One FR per
					interval is used for both shaft and toe; no plug mass is modelled.
				</div>
			</section>

			<section id="impact" class="doc-card">
				<p class="section-label">Impact driving</p>
				<h2>5. Smith (1960) one-dimensional wave equation</h2>
				<p>
					<code>runImpactDrivability</code> simulates one hammer blow at each trial toe depth (every 0.5 m
					to the target in the app) on a lumped-mass chain: ram → hammer cushion → helmet → (pile
					cushion) → N pile segments, each a mass joined by a spring; the soil along the shaft and at the
					toe acts through elasto-plastic springs (quake q, ultimate R<sub>u</sub>) with Smith damping.
					Smith's paper itself is paywalled and was not read; the formulation follows the GRLWEAP
					descriptions cited below.
				</p>
				<div class="symbols">
					<div class="symbols__title">Model and defaults</div>
					<dl class="symbols__list">
						<div class="symbols__row"><dt>Hammer</dt><dd>Ram impact velocity v₀ = √(2·g·h·η) with h = rated energy/(m<sub>ram</sub>·g) when no stroke is given (GRLWEAP procedure). Efficiency η by class: hydraulic 0.80, diesel 0.80, hydraulic/diesel with internal energy monitoring 0.95, single-acting air/steam 0.67, double-acting air/steam or hydraulic 0.50; <strong>drop hammers 0.50 is a placeholder</strong> (not in the fetched source — set explicitly). <strong>Diesel hammers are modelled as an equivalent free-fall ram of the rated energy</strong>; combustion, pre-compression and the impact block are not modelled (note emitted).</dd></div>
						<div class="symbols__row"><dt>Cushions</dt><dd>Compression-only springs: loading stiffness k, unloading stiffness k/e² with the coefficient of restitution e (Smith 1960; default e = 0.8 hammer cushion, 0.5 pile cushion). App defaults: helmet 1500 kg, hammer cushion 2.5·10⁶ kN/m; the module falls back to a near-rigid contact of 10 × the pile segment stiffness when no cushion stiffness is given (note emitted).</dd></div>
						<div class="symbols__row"><dt>Pile</dt><dd>Uniform steel section: E = 210·10⁶ kPa, ρ = 7850 kg/m³, segments of 1.0 m (L/N), m<sub>seg</sub> = ρ·A·L<sub>seg</sub>, k<sub>pile</sub> = E·A/L<sub>seg</sub>, c = √(E/ρ), impedance Z = E·A/c; pile springs linear and tension-capable (continuous pile).</dd></div>
						<div class="symbols__row"><dt>Quakes</dt><dd>Shaft 2.5 mm; toe 2.5 mm, or D/120 (very dense/hard) … D/60 (softer/loose) for displacement piles — Rausche, <em>GRLWEAP Fundamentals</em> (PDCA) slides 38–40; FHWA GEC-12 Vol. II §12.5.</dd></div>
						<div class="symbols__row"><dt>Smith damping</dt><dd>Shaft: clay 0.65 s/m (0.20 s/ft), sand 0.16 s/m (0.05 s/ft), silt 0.40 s/m (intermediate); toe, all soils 0.50 s/m (0.15 s/ft) — GRLWEAP slide 42; GEC-12 §12.8. The app assigns the shaft value per CPT layer class and maps it to segments by resistance weighting.</dd></div>
						<div class="symbols__row"><dt>Refusal</dt><dd>Labelled at ≥ 250 blows/0.25 m (set ≤ 1 mm) by default; the FHWA GEC-12 Vol. II §17.2 practical refusal of 10 blows/inch ≈ 98 blows/0.25 m is quoted alongside.</dd></div>
					</dl>
				</div>
				<p>Soil springs at pile mass i (u displacement, v velocity, u<sub>P</sub> plastic displacement), Smith damping R<sub>dyn</sub> = R<sub>static</sub>·(1 + J·v):</p>
				<div class="equations">
					<div class="formula">shaft (two-way):   R<sub>s</sub> = k<sub>s</sub>·(u − u<sub>P</sub>),   k<sub>s</sub> = R<sub>u</sub>/q<sub>shaft</sub>,   |R<sub>s</sub>| ≤ R<sub>u</sub>  (u<sub>P</sub> updated on yield);   R = R<sub>s</sub>·max[0, 1 + J<sub>s</sub>·v·sign(R<sub>s</sub>)]</div>
					<div class="formula">toe (compression-only):   R<sub>t</sub> = k<sub>t</sub>·(u − u<sub>P,toe</sub>) ∈ [0, R<sub>u,toe</sub>],   k<sub>t</sub> = R<sub>u,toe</sub>/q<sub>toe</sub>;   R = R<sub>t</sub>·(1 + J<sub>t</sub>·max(0, v))</div>
					<div class="formula">the damping product is clipped at zero when the static and damping terms oppose — a numerical safeguard, not part of Smith's paper</div>
				</div>
				<p>Explicit central-difference (leap-frog) integration with an automatic time step; the run stops when the ram has separated, the toe has not advanced for 6·L/c and the pile has lost its kinetic energy (or all soil springs are unloaded), or after 40·L/c without further toe advance:</p>
				<div class="equations">
					<div class="formula">Δt = min(0.5·L<sub>seg</sub>/c,  0.1/ω<sub>max</sub>),   ω<sub>max</sub> = max √[k·(1/m<sub>i</sub> + 1/m<sub>i+1</sub>)]     (energy error ∝ (ωΔt)²; set within 0.5 % of a refined run)</div>
					<div class="formula">v<sub>n+½</sub> = v<sub>n−½</sub> + a<sub>n</sub>·Δt,   u<sub>n+1</sub> = u<sub>n</sub> + v<sub>n+½</sub>·Δt</div>
					<div class="formula">set = u<sub>P,toe</sub>  (= D<sub>max,toe</sub> − q<sub>toe</sub>, Smith 1960);   blows per 0.25 m = 0.25/set</div>
					<div class="formula">σ<sub>c,max</sub> = max(F<sub>segment</sub>, F<sub>top</sub>)/A,   σ<sub>t,max</sub> = max(−F<sub>segment</sub>)/A</div>
					<div class="formula">ENTHRU = ∫ F<sub>top spring</sub>·v<sub>pile top</sub> dt     (energy transmitted into the pile)</div>
					<div class="formula">energy audit:   E<sub>ram,0</sub> = E<sub>ram</sub> + E<sub>kin,others</sub> + E<sub>strain</sub> + W<sub>cushion</sub> + W<sub>contact</sub> + W<sub>soil</sub> + imbalance</div>
				</div>
				<p>
					<strong>Bearing graph.</strong> At the final depth the shaft and toe resistances are scaled together
					in 12 steps up to 3 × R<sub>static</sub> and the blow count, set, stresses and ENTHRU are tabulated
					against R<sub>u</sub> — the classical bearing graph, keeping the shaft/toe split of that depth.
				</p>
				<div class="doc-callout">
					<strong>Simplifications (documented in the module header).</strong> No gravity or static
					pre-equilibrium (self-weight ≪ driving forces); no residual stresses between blows; no splices or
					slacks; no pile-cap impedance change; no plug mass; single blow per depth; uniform pile
					section; set = D<sub>max</sub> − q ignores the residual elastic compression. The SRD profile of §2
					(upper bound) is the resistance input.
				</div>
			</section>

			<section id="push" class="doc-card">
				<p class="section-label">Static push-in</p>
				<h2>5b. Static push-in (press-in) — quasi-static force balance</h2>
				<p>
					For an element pushed in with a static force — excavator crowd through a driving cap, or the
					rated force of a press-in machine — <code>runPushIn</code> (<code>push-in.js</code>) answers
					"how deep does it go" with the force balance at every trial toe depth:
				</p>
				<div class="equations">
					<div class="formula">F<sub>push</sub> + W(z) ≥ m<sub>R</sub>·R<sub>static</sub>(z),   R<sub>static</sub> = R<sub>shaft</sub> + R<sub>toe</sub> + R<sub>interlock</sub>   (§2 profile, no dynamic degradation)</div>
					<div class="formula">W(z) = m′·g·z   (element self-weight over the embedded length; optional)</div>
					<div class="formula">refusal = first z with F<sub>push</sub> + W &lt; m<sub>R</sub>·R<sub>static</sub>;   F<sub>required</sub>(target) = max<sub>z ≤ target</sub> [m<sub>R</sub>·R<sub>static</sub>(z) − W(z)]</div>
				</div>
				<p>
					Reported for m<sub>R</sub> = 1.0 and 1.25 (equipment reserve, not a partial factor), with the
					governing depth, the margin at the target, the per-depth table, the depth chart (R<sub>static</sub>,
					F<sub>required</sub>, F<sub>push</sub>, refusal marker) and the outcome marker on the section.
				</p>
				<div class="doc-callout">
					<strong>Assumptions.</strong> Quasi-static (no rate effects, no set-up between strokes, no plug model
					beyond the element's toe-area choice); the static profile is the upper envelope of §2 — the right
					basis for "will it get there", too high for capacity. The Alm &amp; Hamre option with friction
					fatigue is the usual press-in basis (White &amp; Deeks 2007: press-in force ≈ static CPT-based
					capacity with friction fatigue). A press-in machine needs its reaction (installed elements or
					ballast); an excavator can push only what its weight and boom geometry allow — typically not more
					than 30–50 % of its operating weight through the boom. Obstructions and layers with
					q<sub>c</sub> &gt; 30 MPa refuse pressing regardless of the balance; pre-drilling or vibratory
					assistance is the usual answer (course §14).
				</div>
			</section>

			<section id="hammers" class="doc-card">
				<p class="section-label">Equipment data</p>
				<h2>6. Hammer catalogue policy</h2>
				<p>
					<code>hammer-catalog.js</code> is pure data. <strong>Only verified rows</strong> are exported:
					every row carries the URL that was actually fetched on the stated date (2026-08-29) and a source
					note; rows whose datasheet could not be retrieved are omitted, and fields a source did not state
					are <code>null</code> — the UI then asks the user, never guesses. A “custom” entry is always
					offered.
				</p>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr><th>Rows</th><th>Source fetched</th><th>Verified fields</th></tr>
							</thead>
							<tbody>
								<tr><td>ICE 28RF</td><td>Dieseko specification sheet (TWF mirror) + Dieseko product page</td><td>0–28 kgm, 2300 rpm, 0–1600 kN, dynamic mass 3900 kg (5400 with 200TU clamp), total 5900 kg, amplitude 14/10.4 mm, line pull 400 kN, pull-down 150 kN</td></tr>
								<tr><td>ICE 14RF, ICE 815C, PVE 23VMA</td><td>Dieseko product pages</td><td>moment, force, rpm only — dynamic mass <code>null</code> (datasheets behind a form)</td></tr>
								<tr><td>ABI MRZV 20VV / 30VV</td><td>ABI “Technical Data MRZV VV” sheet (A E Yates)</td><td>moment, dynamic mass 2810 / 3995 kg, nominal and max rpm, forces, total mass (the sheet's “100 kN” for the 20VV is an evident misprint for 1000 kN, noted)</td></tr>
								<tr><td>Junttan HHK 5A, 5/6A, 7A, 7/9A</td><td>Junttan data sheets 05/2011</td><td>ram 5000 / 6000 / 7000 / 9000 kg, 59 / 71 / 82 / 106 kJ, 1.2 m stroke, 40–100 bpm, total mass</td></tr>
								<tr><td>IHC S-70 … S-280</td><td>IHC Hydrohammer onshore brochure IHC02-30-11.12 (mirror) + PDI hammer database cross-check</td><td>ram, max net energy, blow rate, total mass</td></tr>
								<tr><td>Delmag D30-32, D46-32</td><td>Pileco / piledrivershop specification sheets</td><td>ram 3000 / 4600 kg, 48.1–95.1 / 71–166 kJ (pump settings), blow rate, total mass; PDI database values noted where they differ</td></tr>
							</tbody>
						</table>
					</div>
				</div>
				<p>
					<code>vibratoryConsistency()</code> checks F<sub>c</sub> ≈ M<sub>e</sub>·(2πf)²/1000 for every
					vibratory row against the stated force (all within 1.5 %). Impact rows carry the GRLWEAP class
					efficiency as <code>efficiencyDefault</code> (0.80 for all listed hydraulic and diesel hammers).
					For a vibratory catalogue row the app uses the dynamic mass with clamp when published and the
					maximum eccentric moment; for a custom machine the user supplies F<sub>c</sub> or M<sub>e</sub>.
				</p>
			</section>

			<section id="datasheet" class="doc-card">
				<p class="section-label">Data sheet → model</p>
				<h2>7. From a supplier data sheet to the model input — and how deep it drives</h2>
				<p>
					A supplier sheet describes a <em>machine</em> (centrifugal force, rpm range, amplitude, mass, oil
					flow, working pressure, motor power, carrier class). The force-envelope model needs the
					<em>mechanics</em>: eccentric moment M<sub>e</sub>, operating frequency f, attached (vibrating)
					mass M<sub>dyn</sub> and the static downforce. <code>vibrator-datasheet.js</code> translates one
					into the other with the relations of course §4.1–4.3 and records, for every derived number, which
					sheet value it came from. Blanks are derived; nothing is guessed silently.
				</p>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead><tr><th>Sheet line</th><th>Model quantity</th><th>Relation</th></tr></thead>
							<tbody>
								<tr><td>Centrifugal force F<sub>c</sub> (kN) — printed at the maximum rpm unless stated otherwise</td><td>Eccentric moment M<sub>e</sub></td><td>M<sub>e</sub> = 1000·F<sub>c</sub>/ω<sub>max</sub>², ω = 2π·rpm/60 (course §4.1). A printed M<sub>e</sub> takes precedence; a &gt;10 % mismatch with the force is flagged.</td></tr>
								<tr><td>Frequency range (rpm)</td><td>Operating frequency f; force at f</td><td>F<sub>c</sub>(f) = M<sub>e</sub>·(2πf)²/1000 — a fixed-moment machine loses force quadratically below its maximum rpm (205 kN at 2900 rpm is 140 kN at 2400 rpm). The check uses the maximum rpm unless an operating rpm is entered.</td></tr>
								<tr><td>Amplitude (mm)</td><td>Vibrating mass M<sub>dyn</sub> (when not printed)</td><td>Peak-to-peak: M<sub>dyn</sub> = 2000·M<sub>e</sub>/A<sub>pp</sub>; single: M<sub>dyn</sub> = 1000·M<sub>e</sub>/s₀ (course §4.2). Dieseko/ICE, PVE and ABI print the peak-to-peak free amplitude (ICE 28RF: 2·28/3900 = 14.4 mm ≈ sheet 14 mm; with the 200TU clamp 2·28/5400 = 10.4 mm = sheet). The convention is an input; a stated mass is checked against the amplitude.</td></tr>
								<tr><td>Vibrating mass / total mass (kg)</td><td>M<sub>dyn</sub>; static weight of the isolated part</td><td>W<sub>static</sub> = (M<sub>total</sub> − M<sub>dyn</sub>)·g — the suppressor housing rests on the pile through its springs and is added to the crowd (course §4.3, W<sub>transmitted</sub>); a crane line carrying part of the weight is entered as line pull.</td></tr>
								<tr><td>Oil flow, working pressure, motor power, carrier class</td><td>Carrier check (not part of the force envelope)</td><td>Hydraulic power P = p·Q/600 kW, reported at the working point and at the sheet maxima. The carrier must be inside the class range, deliver at least the working flow and pressure, and not exceed the machine maxima without a limiter / relief. Course §4.6: real power demand depends on the phase between force and velocity — the sheet values and a trial are the only reliable basis.</td></tr>
							</tbody>
						</table>
					</div>
				</div>
				<p>
					<strong>How deep will it drive?</strong> With a machine described (data sheet, catalogue row or a
					custom F<sub>c</sub> / M<sub>e</sub>) the runner adds the element mass to M<sub>dyn</sub>, evaluates the
					margin G(z) = F<sub>c</sub> + W<sub>eff</sub> − m<sub>R</sub>·R<sub>drive</sub>(z) at every trial toe depth
					from the platform down, and reports the <em>first</em> depth at which the envelope closes
					(G &lt; 0) as the predicted refusal — the machine cannot pass it, whatever the margin further down
					(course §4.4: the inequality identifies whether motion is mechanically possible; it does not
					give the penetration rate). Three outcomes are reported and drawn on the section:
				</p>
				<ul class="notes">
					<li><strong>Reaches target</strong> (green): G ≥ 0 down to the target with the 1.25 equipment reserve.</li>
					<li><strong>Marginal</strong> (amber): G ≥ 0 at m<sub>R</sub> = 1.0 but the 1.25 reserve is lost below the depth shown — plan a trial pile and a fallback (heavier head, crowd, pre-drilling).</li>
					<li><strong>Refusal</strong> (red): G &lt; 0 at the depth shown; the achievable depth is the last open trial depth (0.1 m steps). The shortfall to the target is printed.</li>
				</ul>
				<p>
					The <strong>minimum vibrator</strong> card is the inverse question: the smallest F<sub>c</sub> (and its
					M<sub>e</sub>, attached amplitude and acceleration at the chosen frequency and mass) for which the
					envelope stays open to the target — the specification to send to suppliers (course §7.9).
				</p>
				<div class="doc-callout">
					<strong>Plate compactors.</strong> An excavator compactor sheet (e.g. SAES HST) lists the same
					quantities but the machine has no clamp: the element is not rigidly attached, so the
					attached-mass assumption (M<sub>dyn</sub> includes the element) is optimistic. Use such a sheet for
					light trench sheets driven through a driving cap only, and expect a trial to govern.
					Amplitude under load, clamp grip, pile stress, resonance and ground vibration remain the separate
					checks of course §7.10.
				</div>
			</section>

			<section id="outputs" class="doc-card">
				<p class="section-label">Outputs and limitations</p>
				<h2>8. Reported results and documented limitations</h2>
				<ul class="notes">
					<li><strong>Profile:</strong> z, q<sub>toe</sub>, τ<sub>shaft</sub>, FR, cumulative shaft, interlock, toe and R<sub>static</sub> at every trial depth, with every assumption as a note (held values beyond the CPT, assumed f<sub>s</sub>, factors, unplugged assumption).</li>
					<li><strong>Vibratory:</strong> per depth R<sub>static</sub>, R<sub>liquefied</sub>, χ<sub>toe</sub>, R<sub>s</sub>, R<sub>b</sub>, R<sub>drive</sub>, α, q<sub>d</sub>, τ<sub>d</sub>, F<sub>c,min</sub>(m<sub>R</sub>) and F<sub>c,min</sub>(1.25); the governing depths; M<sub>e</sub>, s₀, A<sub>pp</sub>, α<sub>req</sub>, σ<sub>screen</sub> at the required, the 1.25-reserve and the candidate force; the candidate check; the force-envelope curve.</li>
					<li><strong>Impact:</strong> per depth R<sub>static</sub>, R<sub>shaft</sub>, R<sub>toe</sub>, set, blows/0.25 m, refusal flag, σ<sub>c,max</sub>, σ<sub>t,max</sub>, ENTHRU, maximum toe displacement and top force, the energy audit; the hammer (η, stroke, v₀, E<sub>kin</sub>), the pile model (segments, c, Z) and the bearing graph.</li>
					<li>All model outputs are plain numbers (worker-transferable); invalid input returns <code>ok: false</code> with notes, never throws.</li>
					<li>The two drivability models are <strong>not</strong> linked to the vibration prediction; the link is the instrumented trial (course preface).</li>
					<li>Extraction, offshore piles, obstructions, very long elastic piles and pore-pressure / liquefaction effects are outside the hand methods (course §1.2).</li>
					<li>The hand methods cannot give an exact vibrator force from q<sub>c</sub>, f<sub>s</sub>, length and embedment alone (course §1.3): geometry and toe condition, masses, frequency, moment, downforce, inner/outer contact, interlocks, groundwater, actual amplitude and power all matter — hence the explicit reserve multiplier and the trial.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>9. Reference basis</h2>
				<ul class="reference-list">
					<li><strong>Alm, T. &amp; Hamre, L.</strong> (2001). Soil model for pile driveability predictions based on CPT interpretations. <em>Proc. 15th ICSMGE, Istanbul</em>, pp. 1297–1302 (ISSMGE open-access PDF) — friction-fatigue SRD model, coefficients verified verbatim.</li>
					<li><strong>Holeyman, A.</strong> (2002). Soil behaviour under vibratory driving. Keynote, <em>TransVib 2002</em> (Louvain-la-Neuve; Balkema), pp. 14–15 — χ (eq. 18), acceleration interpolation (eq. 19), FR in percent, Λ ∈ [4, 10], force-equilibrium model class (§5.2), Hypervib1 (§5.5.1).</li>
					<li><strong>Van Rompaey, D., Legrand, C. &amp; Holeyman, A.</strong> (1995). A prediction method for the installation of vibratory driven piles. <em>WIT Trans. Built Env.</em> 14 (Proc. 7th Int. Conf. Soil Dynamics and Earthquake Engineering, Chania, 1995), 533–542, WIT Press e-library — original Hypervib1 formulation.</li>
					<li><strong>Holeyman, A. &amp; Whenham, V.</strong> (2017). Critical review of the Hypervib1 model to assess pile vibro-drivability. <em>Geotech. Geol. Eng.</em> 35, 1933–1951, doi 10.1007/s10706-017-0218-8 — Λ nomenclature confirmed from the abstract.</li>
					<li><strong>Smith, E.A.L.</strong> (1960). Pile-driving analysis by the wave equation. <em>ASCE J. Soil Mech. Found. Div.</em> 86(SM4), 35–61, doi 10.1061/JSFEAQ.0000281 — lumped-mass model, quake, damping R(1 + Jv), cushion restitution, set = D<sub>max</sub> − q (citation confirmed; full text paywalled).</li>
					<li><strong>Rausche, F.</strong> <em>GRLWEAP Fundamentals</em> (PDCA) — ram velocity √(2ghη) (slide 17), efficiencies (slide 28), quakes (slides 38–40), damping (slides 41–42). <strong>GRL</strong> (2007). <em>Hammer Types, Efficiencies and Models in GRLWEAP</em>. <strong>Rausche, Liang, Allin &amp; Rancman</strong> (2004). Applications and correlations of the wave equation analysis program GRLWEAP.</li>
					<li><strong>FHWA GEC-12</strong>, NHI-16-009 Vol. II (2016). <em>Design and Construction of Driven Pile Foundations</em> — §12.5, §12.8 quake and damping defaults, §17.2 practical / absolute refusal.</li>
					<li><strong>Course text</strong>: <em>Manual Design of Vibratory Pile Installation</em> (edition 1.0) — §2 the four calculations, §4 vibrator mechanics, §5–7 CPT model and force envelope, §8 worked example (reproduced), §18 common errors.</li>
					<li><strong>Manufacturer data</strong> as listed per catalogue row (Dieseko/ICE/PVE, ABI, Junttan, IHC Hydrohammer, Delmag) with the PDI hammer database as cross-check.</li>
					<li><strong>NBN EN 12699:2015 / NBN EN 12063</strong> — execution standards for driven displacement piles and sheet-pile walls (the execution specification the drivability screen feeds; not implemented as a check).</li>
				</ul>
				<p class="refs-inline">
					Every equation on this page is transcribed from <code>srd-from-cpt.js</code>,
					<code>vibratory-drivability.js</code> and <code>impact-wave-equation.js</code>; the verification
					status of each source is that of <code>worklog/agent-drivability-report.md</code>. The three Node
					scripts <code>verify_srd_profile.mjs</code>, <code>verify_drivability_vibratory.mjs</code> and
					<code>verify_drivability_impact.mjs</code> (171 checks) are run by <code>npm run verify:drivability</code>.
				</p>
			</section>
		</main>
	</div>
</div>
