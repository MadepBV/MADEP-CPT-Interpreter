<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';

	const pageTitle = 'Retaining Walls — MADEP CPT Interpreter';
	const pageDescription =
		'Technical chapter for the Stage 6 retaining-wall application: scope, Belgian Eurocode 7 (NBN EN 1997-1 ANB) design framework and partial factors, earth-pressure model, GEO/EQU/SLS verification of gravity and cantilever walls, embedded sheet-pile design, ground-anchor pull-out, structural design forces, assumptions, and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/retaining-wall';
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
			<p class="hero__eyebrow">Stage 6 / retaining walls</p>
			<h1>Stage 6 retaining-wall design.</h1>
			<p class="hero__lead">
				The retaining-wall application verifies gravity and reinforced-concrete cantilever
				walls and embedded sheet-pile walls (cantilever and singly anchored) to
				<strong>Eurocode 7</strong> as implemented for <strong>Belgium</strong> (NBN EN 1997-1 ANB,
				Design Approach 1). It computes earth pressures, every ULS/SLS verification, the
				ground-anchor pull-out and the structural design forces on a live, drag-editable
				section; foundation parameters come from the active CPT layer model and the backfill
				and front soil are user-defined.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Retaining-wall documentation navigation">
			<div class="docs-nav__title">Retaining walls</div>
			<a href="#scope">Scope and wall types</a>
			<a href="#framework">Belgian EC7 framework</a>
			<a href="#earth">Earth-pressure model</a>
			<a href="#gravity">Gravity & cantilever checks</a>
			<a href="#embedded">Embedded sheet-pile walls</a>
			<a href="#structural">Structural design forces</a>
			<a href="#equations">Implemented equations</a>
			<a href="#solver">Solver and inputs</a>
			<a href="#limits">Assumptions and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and positioning</p>
				<h2>1. Analysis class and intended use</h2>
				<p>
					The application performs <strong>ultimate and serviceability limit-state verification</strong>
					of retaining structures on a per-metre-run (plane-strain) section. Four wall families
					are covered:
				</p>
				<ul class="notes">
					<li><strong>RC cantilever (L / T-shaped)</strong> — stem, toe, heel and backfill; GEO sliding and bearing, eccentricity, EQU overturning, SLS, plus structural design forces.</li>
					<li><strong>Gravity / mass</strong> — resists by self-weight; the same GEO/EQU/SLS checks with active thrust on the inclined back face (Coulomb).</li>
					<li><strong>Embedded sheet pile (cantilever)</strong> — free-earth / Blum simplified embedment, maximum bending moment.</li>
					<li><strong>Anchored / propped sheet pile</strong> — free-earth-support embedment, anchor/prop force, maximum bending moment, and an <strong>EN 1537 ground-anchor pull-out</strong> verification.</li>
				</ul>
				<div class="doc-callout">
					<strong>What it is not.</strong> Per the agreed scope it delivers the geotechnical
					verification, the <strong>structural design forces</strong> (M<sub>Ed</sub>, V<sub>Ed</sub>,
					anchor force) and the ground-anchor <strong>pull-out</strong> check; it does not size
					reinforcement, compute crack widths, select or verify steel sheet-pile / tendon sections,
					or check the wall's vertical capacity for the inclined-anchor down-drag. Global/overall
					slope stability is handled by the separate Seep/Slope (Bishop/Spencer) application on the
					same section.
				</div>
			</section>

			<section id="framework" class="doc-card">
				<p class="section-label">Design framework</p>
				<h2>2. Belgian Eurocode 7 — Design Approach 1</h2>
				<p>
					Belgium adopts <strong>Design Approach 1 (DA1)</strong> for the GEO/STR ultimate limit
					states of retaining structures (NBN EN 1997-1 ANB). <strong>Both</strong> combinations are
					evaluated for <strong>every</strong> check and the more unfavourable governs:
				</p>
				<ul class="notes">
					<li><strong>Combination 1 (C1):</strong> A1 “+” M1 “+” R1 — actions amplified, soil strength full; usually governs structural forces.</li>
					<li><strong>Combination 2 (C2):</strong> A2 “+” M2 “+” R1 — soil strength reduced at source, actions near-unfactored; usually governs sliding, bearing and embedment.</li>
				</ul>
				<div class="symbols">
					<div class="symbols__title">Partial factors (verified NBN EN 1997-1 ANB values)</div>
					<dl class="symbols__list">
						<div class="symbols__row"><dt>Actions A1 / A2</dt><dd>γ<sub>G</sub> = 1.35 / 1.00 (unfav.), 1.00 / 1.00 (fav.); γ<sub>Q</sub> = 1.50 / <strong>1.30</strong> (unfav.), 0 (fav.).</dd></div>
						<div class="symbols__row"><dt>Materials M1 / M2</dt><dd>γ<sub>φ′</sub> = 1.00 / 1.25 (on tan φ′); γ<sub>c′</sub> = 1.00 / 1.25; γ<sub>cu</sub> = 1.00 / 1.40; γ<sub>γ</sub> = 1.00 (weight density never factored).</dd></div>
						<div class="symbols__row"><dt>Resistance R1</dt><dd>γ<sub>R;v</sub> = γ<sub>R;h</sub> = γ<sub>R;e</sub> = 1.00 for the wall body in both combinations.</dd></div>
						<div class="symbols__row"><dt>EQU</dt><dd>γ<sub>G;dst</sub> = 1.10, γ<sub>G;stb</sub> = 0.90, γ<sub>Q;dst</sub> = 1.50, materials M2.</dd></div>
						<div class="symbols__row"><dt>K<sub>FI</sub></dt><dd>Consequence-class multiplier on unfavourable actions: CC1 0.90, CC2 1.00, CC3 1.10.</dd></div>
					</dl>
				</div>
				<div class="doc-callout">
					<strong>Resolved contradiction.</strong> The default DA1 Combination-2 variable-action
					factor is <strong>γ<sub>Q</sub> = 1.30</strong> (the EN/ANB value), not the 1.10 of the
					optional Buildwise embedded-wall risk-class scheme. The risk-class overlay is provided
					only as a labelled, project-confirmed option. The factor sets are stored as configurable
					data so the 2nd-generation EN 1997-1:2024 verification cases can be mapped later.
				</div>
				<p>
					The <strong>single-source principle</strong> (EN 1997-1 §2.4.2(9)P) is honoured: all
					permanent earth-pressure components from one soil body carry the same factor within a
					combination (automatic in C2 where γ<sub>G</sub>&nbsp;=&nbsp;1.0), and is deliberately
					split only for the EQU overturning check.
				</p>
			</section>

			<section id="earth" class="doc-card">
				<p class="section-label">Earth pressure</p>
				<h2>3. Earth-pressure model</h2>
				<p>Pressures are computed on effective stress; water is added separately so each action type can be factored independently. A fine downward integration marches from the ground surface, accumulating the effective vertical stress σ′<sub>v</sub> and the permanent-earth, variable-surcharge and water resultants. <strong>The soil profile is subdivided layer-by-layer:</strong> σ′<sub>v</sub> is continuous across every boundary while K and the cohesion are read from the layer present at each depth, so the pressure diagram steps correctly at each interface. The same machinery runs on both faces of an embedded wall and on the front (passive) soil and resistance-side overburden of a gravity/cantilever wall, so a layered CPT profile is honoured throughout. The retained fill behind a gravity/cantilever wall is the single engineered backfill you define; the in-situ CPT layers drive the foundation, the passive toe and the overburden.</p>
					<p><strong>Method selection is automatic — there is no method menu.</strong> Active pressure uses <strong>Coulomb on the real inclined back face</strong> (mass-gravity wall, with δ and θ from the drawn geometry) or <strong>Rankine on the vertical virtual plane through the rear of the heel</strong> (RC cantilever / embedded wall). Passive resistance always uses the <strong>EN 1997-1:2004 Annex C closed form</strong>; the planar Coulomb-passive coefficient and the older lookup table were removed.</p>
				<div class="symbols">
					<div class="symbols__title">Coefficients</div>
					<dl class="symbols__list">
						<div class="symbols__row"><dt>K<sub>0</sub></dt><dd>1 − sin φ′ (Jaky), with OCR correction (1 − sin φ′)·OCR<sup>sin φ′</sup>.</dd></div>
						<div class="symbols__row"><dt>K<sub>a</sub> (Rankine)</dt><dd>tan²(45° − φ′/2) for level fill; sloping-backfill form for |β| &lt; φ′ (capped at the angle of repose to stay safe).</dd></div>
						<div class="symbols__row"><dt>K<sub>a</sub> (Coulomb)</dt><dd>Full wedge equation with wall friction δ, back batter θ and slope β; used for the mass-gravity back face (δ and θ taken from the drawn geometry).</dd></div>
						<div class="symbols__row"><dt>K<sub>p</sub> (EN Annex C)</dt><dd>Closed-form log-spiral passive coefficients (EN 1997-1:2004 eqs C.3–C.9): self-weight K<sub>p</sub>, surcharge K<sub>q</sub>, and cohesion K<sub>pc</sub> = (K<sub>n</sub>−1)·cot φ′. Reduces exactly to Rankine at δ = β = θ = 0 and is slightly lower (safer) than Kérisel–Absi at high δ/φ′. The planar Coulomb-passive value and the older lookup table were removed (Coulomb over-predicts K<sub>p</sub> once δ/φ′ ≳ ⅓). Passive wall friction δ<sub>p</sub> = ⅔ φ′<sub>d</sub> by default, recomputed per layer.</dd></div>
						<div class="symbols__row"><dt>Cohesion / crack</dt><dd>Active σ′<sub>a</sub> = K<sub>a</sub>σ′<sub>v</sub> − 2c′√K<sub>a</sub>; passive σ′<sub>p</sub> = K<sub>p</sub>σ′<sub>v</sub> + K<sub>pc</sub>c′ (Annex C.8). Tension-crack depth z<sub>0</sub> = 2c′/(γ√K<sub>a</sub>); the optional crack water is capped at the dry part of z<sub>0</sub> so it never double-counts the phreatic thrust.</dd></div>
						<div class="symbols__row"><dt>Water / surcharge</dt><dd>Hydrostatic u below the table added to the lateral pressure; uniform surcharge contributes K·q as a separable variable action.</dd></div>
					</dl>
				</div>
			</section>

			<section id="gravity" class="doc-card">
				<p class="section-label">Gravity & cantilever</p>
				<h2>4. GEO / EQU / SLS verification</h2>
				<p>
					For an RC cantilever, active thrust is taken on a <strong>vertical virtual plane through
					the rear of the heel</strong> (Rankine), with the soil wedge over the heel counted as
					gravity mass; for a mass gravity wall, Coulomb pressure acts on the real back face. Each
					check applies its own favourable / unfavourable action roles per EC7 and is run for both
					DA1 combinations.
				</p>
				<ul class="notes">
					<li><strong>Sliding (GEO):</strong> H<sub>d</sub> ≤ (V<sub>d</sub>·tan δ<sub>b,d</sub> + c<sub>a</sub>·B′)/γ<sub>R;h</sub> + R<sub>p,d</sub>; driving uses unfavourable factors, the resisting vertical load uses the favourable factor, and the base uplift is single-sourced with the water thrust. <strong>Passive resistance at the toe (R<sub>p,d</sub>)</strong> is the EN Annex C value at M-factored strength divided by R1 = 1.0 — <strong>no lumped mobilisation factor</strong>. The unplanned over-dig Δa = min(0.10·H, 0.5 m) automatically removes the top band (scour / future excavation), and the front soil subdivides per CPT layer; the toe passive can be switched off for a fully conservative design (see §8). The small vertical drag R<sub>p,v</sub> = R<sub>p,h</sub>·tan δ<sub>p</sub> is reported.</li>
					<li><strong>Bearing (GEO):</strong> V<sub>d</sub> ≤ B′·q<sub>Rd</sub>, effective width B′ = B − 2e (Meyerhof), single-source γ<sub>G</sub> on all permanent actions. Three selectable routes (see §7): EN 1997-1 Annex D (drained N<sub>q</sub>/N<sub>c</sub>/N<sub>γ</sub> + load-inclination factors) — the default — with optional Brinch-Hansen/Vesić <strong>depth factors</strong> for the buried toe, or the <strong>De Beer / NF P94-261 CPT-direct</strong> method (q<sub>net</sub> = k<sub>c</sub>·q<sub>ce</sub>). The inclined, eccentric load on a shallow footing is what governs bearing here.</li>
					<li><strong>Eccentricity:</strong> e ≤ B/3 (ULS) and the SLS middle-third e ≤ B/6 with the bearing-pressure distribution reported.</li>
					<li><strong>Overturning (EQU):</strong> M<sub>dst,d</sub> ≤ M<sub>stb,d</sub> with the 1.10 / 0.90 split — reported chiefly for rock/pinned bases, as toppling of a soil-founded wall is normally captured by the bearing/eccentricity check.</li>
						<li><strong>Uplift / flotation (UPL):</strong> the base hydrostatic uplift U must not exceed the favourable dead weight — γ<sub>G,dst</sub>·U ≤ γ<sub>G,stb</sub>·G (1.00 on uplift, 0.90 on weight). Reported for every wall; it governs only a deeply submerged, light section.</li>
				</ul>
			</section>

			<section id="embedded" class="doc-card">
				<p class="section-label">Embedded walls</p>
				<h2>5. Sheet-pile and embedded walls</h2>
				<p>
					Design strengths are factored at source (C2: tan φ′/1.25, c′/1.25) before the earth-pressure
					coefficients are formed. The net effective-pressure-plus-water diagram drives a
					moment-equilibrium solve for the embedment, expressed as an over-design factor
					<strong>ODF = M<sub>resist</sub> / M<sub>drive</sub> ≥ 1</strong>, located by bisection.
				</p>
				<ul class="notes">
					<li><strong>Cantilever:</strong> free-earth / Blum simplified method — moments about the toe give the free-earth depth d<sub>0</sub>, increased by ~20% for the equivalent toe reaction.</li>
					<li><strong>Anchored / propped:</strong> free-earth-support method — moments about the anchor give the embedment; horizontal equilibrium at that depth gives the anchor/prop force T, evaluated per combination at its own free-earth depth and enveloped.</li>
					<li><strong>Ground-anchor pull-out (EN 1537):</strong> characteristic resistance R<sub>a,k</sub> = π·Ø·L<sub>fixed</sub>·τ from the grout-body diameter Ø, fixed (bond) length L<sub>fixed</sub> and grout/soil bond τ; design R<sub>a,d</sub> = R<sub>a,k</sub>/γ<sub>a</sub>. The design force per anchor T<sub>d</sub> = T·s/cos(angle) (s = spacing) must satisfy T<sub>d</sub> ≤ R<sub>a,d</sub>. <strong>γ<sub>a</sub> = 1.1 is the EN 1997-1 Table A.12 anchor factor (temporary and permanent)</strong> and is EN-conforming — it is <em>not</em> the pile R4 set (≈ 1.5–1.6), which does not apply to anchors. The remaining caveat is that the calculated π·Ø·L·τ bond is untested and must be proven by EN 1537 acceptance testing (apply a model factor / reduce τ until then). The inclined anchor also applies V = T·tan(angle) downward — checked below.</li>
					<li><strong>Hydraulic heave / piping (HYD, §10.3):</strong> under a differential head Δh the excess pore pressure at the toe must not exceed the buoyant effective stress — γ<sub>G,dst</sub>·γ<sub>w</sub>Δh ≤ γ<sub>G,stb</sub>·γ′·d (1.35 / 0.90), the full head conservatively dissipated over the downstream embedment (steepest exit gradient).</li>
						<li><strong>Wall vertical equilibrium (anchored):</strong> the inclined anchors apply V = ΣT·tan(angle) downward; a screening check compares it against a conservative embedded shaft-friction estimate (base resistance neglected) — confirm against the real section.</li>
						<li><strong>Outputs:</strong> required embedment (governing combination), maximum bending moment from double integration of the net pressure, the anchor force, the pull-out utilisation, and the heave / vertical-equilibrium verdicts.</li>
				</ul>
				<div class="doc-callout">
					<strong>Passive de-rating.</strong> Under DA1, the M2 strength factor (γ<sub>φ′</sub> = 1.25)
					already de-rates passive resistance (an effective lumped factor of ≈ 1.5–2); no additional
					ULS lumped factor is applied (the passive enters at M-factored strength / R1 = 1.0, the same convention as the gravity-wall toe); a separate SLS displacement / passive-mobilisation check is
					required and is not performed here.
				</div>
			</section>

			<section id="structural" class="doc-card">
				<p class="section-label">Structural forces</p>
				<h2>6. Structural design forces</h2>
				<p>
					Per the agreed scope the application reports <strong>design forces only</strong>, as an
					envelope of the DA1 combinations. For gravity/cantilever walls it returns M<sub>Ed</sub> and
					V<sub>Ed</sub> at the stem base, toe (front face of stem) and heel (rear face of stem), from
					the factored earth pressure, surcharge, soil and bearing-pressure distributions. For
					embedded walls it returns the maximum bending moment, the anchor/prop force and the
					EN 1537 pull-out utilisation. Section sizing, reinforcement and crack-width design to
					EN 1992 / EN 1993-5 — with the Belgian National-Annex values (α<sub>cc</sub> = 0.85,
					γ<sub>c</sub> = 1.5, γ<sub>s</sub> = 1.15, the +25 % plate-shear NDP, cover/exposure and the
					0.3 mm crack limit) — remain the engineer’s responsibility.
				</p>
			</section>

			<section id="equations" class="doc-card">
				<p class="section-label">Equation reference</p>
				<h2>7. Implemented equations</h2>
				<p>
					Each topic below is given twice: first as <strong>clean, typeset formulas</strong> in the
					project house style, then as the <strong>literal as-evaluated block</strong> (subscripts written
					inline — <code>K_p</code>, <code>sigma'_v</code>, <code>phi'_d</code> — reading as the calculation
					the engine actually performs). Both were transcribed term-for-term from the C++ source and
					cross-checked against it; where a historical inline block disagreed with the code, the code wins
					and the typeset formula is authoritative.
				</p>

				<p><strong>Design values and partial-factor sets</strong> (γ never reduces unit weight).</p>
					<p>Design (material set M) strength reductions — γ never reduces unit weight (γ<sub>γ</sub> = 1.00).</p>
					<div class="equations">
					<div class="formula">φ′<sub>d</sub> = atan( tan φ′<sub>k</sub> / γ<sub>φ</sub> )</div>
					<div class="formula">c′<sub>d</sub> = c′<sub>k</sub> / γ<sub>c</sub></div>
					<div class="formula">c<sub>u,d</sub> = c<sub>u,k</sub> / γ<sub>cu</sub></div>
					</div>
					<p>Partial-factor sets — actions [γ<sub>G,unfav</sub>, γ<sub>G,fav</sub>, γ<sub>Q,unfav</sub>, γ<sub>Q,fav</sub>], materials [γ<sub>φ</sub>, γ<sub>c</sub>, γ<sub>cu</sub>, γ<sub>γ</sub>], resistance [γ<sub>R;v</sub>, γ<sub>R;h</sub>, γ<sub>R;e</sub>].</p>
					<div class="equations">
					<div class="formula">A1 = [1.35, 1.00, 1.50, 0]</div>
					<div class="formula">A2 = [1.00, 1.00, 1.30, 0]</div>
					<div class="formula">M1 = [1.00, 1.00, 1.00, 1.00]</div>
					<div class="formula">M2 = [1.25, 1.25, 1.40, 1.00]</div>
					<div class="formula">R1 = [1.00, 1.00, 1.00]</div>
					<div class="formula">K<sub>FI</sub> = 0.90 (CC1), 1.00 (CC2), 1.10 (CC3)   (multiplies the unfavourable actions)</div>
					</div>
					<p>Verification combinations — both DA1 sets run and the worst governs; the EQU/HYD/UPL action triple is [γ<sub>G,dst</sub>, γ<sub>G,stb</sub>, γ<sub>Q,dst</sub>].</p>
					<div class="equations">
					<div class="formula">DA1-C1 = A1 + M1 + R1</div>
					<div class="formula">DA1-C2 = A2 + M2 + R1</div>
					<div class="formula">EQU = [1.10, 0.90, 1.50] + M2 + R1   (stabilising/destabilising split, K<sub>FI</sub> = 1)</div>
					<div class="formula">HYD = [1.35, 0.90, 1.50] + M1 + R1</div>
					<div class="formula">UPL = [1.00, 0.90, 1.50] + M2 + R1</div>
					</div>
					<p>Optional Buildwise risk classes (project-confirmed only; default is the EN/ANB sets above). Each overrides A1, A2 as [γ<sub>G,unfav</sub> / γ<sub>Q,unfav</sub>] and M2 as [γ<sub>φ</sub>, γ<sub>c</sub>, γ<sub>cu</sub>].</p>
					<div class="equations">
					<div class="formula">RK1: A1 = [1.20 / 1.30], A2 = [1.00 / 1.10], M2 = [1.10, 1.10, 1.25]</div>
					<div class="formula">RK2: A1 = [1.35 / 1.50], A2 = [1.00 / 1.10], M2 = [1.25, 1.25, 1.40]</div>
					<div class="formula">RK3: A1 = [1.50 / 1.80], A2 = [1.00 / 1.20], M2 = [1.40, 1.40, 1.55]</div>
					</div>
<pre>Design (material set M):   phi'_d = atan( tan phi'_k / g_phi )    c'_d = c'_k / g_c    cu_d = cu_k / g_cu

Action sets    [g_G,unfav · g_G,fav · g_Q,unfav · g_Q,fav]
   A1 = [1.35 · 1.00 · 1.50 · 0]         A2 = [1.00 · 1.00 · 1.30 · 0]
Material sets  [g_phi · g_c · g_cu · g_gamma]
   M1 = [1.00 · 1.00 · 1.00 · 1.00]      M2 = [1.25 · 1.25 · 1.40 · 1.00]
Resistance     R1 = [g_R;v · g_R;h · g_R;e] = [1.00 · 1.00 · 1.00]
K_FI = 0.90 (CC1) | 1.00 (CC2) | 1.10 (CC3)   — multiplies the UNFAVOURABLE actions

DA1-C1 = A1 + M1 + R1          DA1-C2 = A2 + M2 + R1     (both run; worst governs)
EQU = [1.10 · 0.90 · 1.50] + M2 + R1   (stabilising/destabilising split; K_FI = 1)
HYD = [1.35 · 0.90 · 1.50] + M1 + R1   UPL = [1.00 · 0.90 · 1.50] + M2 + R1

Optional Buildwise risk classes (project-confirmed only; default = EN/ANB above):
   RK1: A1[1.20/1.30]  A2[1.00/1.10]  M2[1.10, 1.10, 1.25]
   RK2: A1[1.35/1.50]  A2[1.00/1.10]  M2[1.25, 1.25, 1.40]
   RK3: A1[1.50/1.80]  A2[1.00/1.20]  M2[1.40, 1.40, 1.55]</pre>

				<p><strong>Earth-pressure coefficients</strong> — active by geometry, passive always EN Annex C.</p>
					<p>At-rest (Jáky), with the over-consolidation form capped at the passive limit.</p>
					<div class="equations">
					<div class="formula">K<sub>0</sub> = 1 − sin φ′</div>
					<div class="formula">K<sub>0,OC</sub> = min[ (1 − sin φ′) · max(OCR, 1)<sup>sin φ′</sup> , (1 + sin φ′) / (1 − sin φ′) ]</div>
					</div>
					<p>Rankine — active by geometry, level backfill.</p>
					<div class="equations">
					<div class="formula">K<sub>a</sub> = (1 − sin φ′) / (1 + sin φ′)     (Rankine, level)</div>
					<div class="formula">K<sub>p</sub> = (1 + sin φ′) / (1 − sin φ′)     (Rankine, level)</div>
					</div>
					<p>Rankine — sloping backfill slope β (engine caps |β| at φ′ − 0.1°).</p>
					<div class="equations">
					<div class="formula">r = √( cos²β − cos²φ′ )</div>
					<div class="formula">K<sub>a</sub> = cos β · (cos β − r) / (cos β + r)     (Rankine, sloping)</div>
					<div class="formula">K<sub>p</sub> = cos β · (cos β + r) / (cos β − r)     (Rankine, sloping)</div>
					</div>
					<p>Coulomb active — wall friction δ, wall batter θ from vertical, backfill slope β.</p>
					<div class="equations">
					<div class="formula">K<sub>a</sub> = cos²(φ′ − θ) / [ cos²θ · cos(δ + θ) · [ 1 + √( sin(δ + φ′) · sin(φ′ − β) / (cos(δ + θ) · cos(β − θ)) ) ]² ]     (Coulomb, active)</div>
					</div>
					<p>EN 1997-1:2004 Annex C passive (Brinch-Hansen log-spiral); passive wall friction δ recomputed per layer.</p>
					<div class="equations">
					<div class="formula">δ<sub>p</sub> = ⅔ · φ′<sub>d</sub></div>
					<div class="formula">s<sub>β</sub> = clamp( sin β / sin φ′ , −1 , 1 )</div>
					<div class="formula">s<sub>δ</sub> = clamp( sin δ / sin φ′ , −1 , 1 )</div>
					<div class="formula">m<sub>t</sub> = ½ ( arccos(−s<sub>β</sub>) − φ′ − β )     (C.3)</div>
					<div class="formula">m<sub>w</sub> = ½ ( arccos(s<sub>δ</sub>) − φ′ − δ )     (C.4)</div>
					<div class="formula">v = m<sub>t</sub> + β − m<sub>w</sub> − θ     (C.5)</div>
					<div class="formula">K<sub>n</sub> = [ 1 + sin φ′ · sin(2 m<sub>w</sub> + φ′) ] / [ 1 − sin φ′ · sin(2 m<sub>t</sub> + φ′) ] · exp( 2 v · tan φ′ )     (C.6)</div>
					<div class="formula">K<sub>p</sub> = K<sub>n</sub> · cos β · cos(β − θ)     (C.9)</div>
					<div class="formula">K<sub>q</sub> = K<sub>n</sub> · cos²β     (C.7)</div>
					<div class="formula">K<sub>pc</sub> = (K<sub>n</sub> − 1) · cot φ′     (C.8; = 2 √K<sub>p</sub> when δ = β = θ = 0)</div>
					</div>
<pre>At rest:   K0 = 1 − sin phi'        K0,OC = min( (1−sin phi')·OCR^(sin phi') ,  (1+sin phi')/(1−sin phi') )

Rankine, level:   Ka = (1−sin phi')/(1+sin phi')        Kp = (1+sin phi')/(1−sin phi')
Rankine, slope b  (|b| capped at phi'−0.1°):   r = sqrt( cos²b − cos²phi' )
   Ka = cos b·(cos b − r)/(cos b + r)          Kp = cos b·(cos b + r)/(cos b − r)

Coulomb active (wall friction d, back batter t, slope b):
   Ka = cos²(phi'−t) / [ cos²t · cos(d+t) · [ 1 + sqrt( sin(d+phi')·sin(phi'−b) / (cos(d+t)·cos(b−t)) ) ]² ]

EN 1997-1:2004 Annex C passive (log spiral); d_p = (2/3)·phi'_d recomputed per layer:
   sb = sin b / sin phi'      sd = sin d / sin phi'           (each clamped to [−1, 1])
   m_t = ½( arccos(−sb) − phi' − b )                          (C.3)
   m_w = ½( arccos( sd) − phi' − d )                          (C.4)
   v   = m_t + b − m_w − t                                    (C.5)
   K_n = [1 + sin phi'·sin(2 m_w + phi')] / [1 − sin phi'·sin(2 m_t + phi')] · exp(2 v · tan phi')   (C.6)
   K_p  = K_n·cos b·cos(b−t)     (C.9)      K_q = K_n·cos²b     (C.7)
   K_pc = (K_n − 1)·cot phi'     (C.8)   →   equals 2·sqrt(K_p) when d = b = t = 0</pre>

				<p><strong>Effective-stress pressure integration</strong> (per cell, midpoint march, layered).</p>
					<p>Downward cell march (surface → base): resolution, effective unit weight, and the running effective vertical stress.</p>
					<div class="equations">
					<div class="formula">N<sub>cells</sub> = max(n<sub>steps</sub>, 50)     dz = (surface − base) / N<sub>cells</sub>     γ<sub>w</sub> = 9.81 kN/m³</div>
					<div class="formula">γ<sub>eff</sub> = γ<sub>sat</sub> − γ<sub>w</sub>   (cell below water table)     γ<sub>eff</sub> = γ<sub>moist</sub>   (cell above)</div>
					<div class="formula">σ′<sub>v,mid</sub> = σ′<sub>v</sub> + ½ γ<sub>eff</sub> dz     (stress at the cell midpoint)</div>
					<div class="formula">σ′<sub>v</sub> ← σ′<sub>v</sub> + γ<sub>eff</sub> dz     (carried to the next cell, continuous across layers)</div>
					</div>
					<p>Lateral pressure ordinate at the cell midpoint — drained on effective σ′<sub>v</sub>, undrained on total σ<sub>v</sub>.</p>
					<div class="equations">
					<div class="formula">σ′<sub>a</sub> = K<sub>a</sub> · σ′<sub>v,mid</sub> − 2√K<sub>a</sub> · c′     (drained active; set to 0 if σ′<sub>a</sub> &lt; 0)</div>
					<div class="formula">σ′<sub>p</sub> = K<sub>p</sub> · σ′<sub>v,mid</sub> + K<sub>pc</sub> · c′     (drained passive; cohesion adds, K<sub>pc</sub> from C.8)</div>
					<div class="formula">σ = (σ′<sub>v,mid</sub> + u) ∓ 2 c<sub>u</sub>     (undrained φ<sub>u</sub> = 0; − active, + passive)</div>
					<div class="formula">Δσ<sub>h</sub> = K · q     (surcharge; K = K<sub>a</sub> active, C.7 K<sub>q</sub> passive, 1 undrained)</div>
					<div class="formula">u = γ<sub>w</sub> · (WT − el)     (pore pressure on a submerged cell)</div>
					</div>
					<p>Tension crack and ponded crack-water (active face only).</p>
					<div class="equations">
					<div class="formula">z<sub>0</sub> = 2 c′ / (γ √K<sub>a</sub>)     (level backfill; in code z<sub>0</sub> = depth of the first non-tension cell)</div>
					<div class="formula">z<sub>c</sub> = min(z<sub>0</sub>, depth to WT)     (dry-capped crack column)</div>
					<div class="formula">P<sub>crack</sub> = ½ γ<sub>w</sub> · z<sub>c</sub>²   acting at   ⅔ z<sub>c</sub>     (hydrostatic over the dry crack)</div>
					</div>
					<p>Resultant on a face and projection onto the analysed (virtual or battered) plane.</p>
					<div class="equations">
					<div class="formula">N = Σ σ · dz</div>
					<div class="formula">zbar = (Σ σ · dz · depth) / N     (lever below region top)</div>
					<div class="formula">H<sub>v</sub> = top-of-wall + heel · tan β     (virtual-plane height)</div>
					<div class="formula">θ = atan( (t<sub>b</sub> − t<sub>t</sub>) / H<sub>stem</sub> )     (back batter from drawn taper)</div>
					<div class="formula">δ<sub>a</sub> = (δ<sub>a</sub>/φ′) · φ′<sub>d</sub>     (0 on the Rankine plane)</div>
					<div class="formula">H<sub>soil</sub> = N · cos(incl)     V<sub>soil</sub> = N · sin(incl)</div>
					<div class="formula">y = H<sub>v</sub> − zbar     (water and crack thrusts stay horizontal, no cosine)</div>
					</div>
<pre>N = max(n_steps, 50) cells,  dz = (surface − base)/N,  g_w = 9.81 kN/m³
   g_eff = g_sat − g_w  below the water table, else g_moist
   sigma'_v,mid = sigma'_v + ½ g_eff dz        sigma'_v += g_eff dz     (continuous across layers)

Drained ordinates (design strength):
   active:   sigma'_a = Ka·sigma'_v,mid − 2·sqrt(Ka)·c'      (if sigma'_a &lt; 0 ⇒ 0; first non-tension cell sets z0)
   passive:  sigma'_p = Kp·sigma'_v,mid + K_pc·c'            (cohesion ADDS; K_pc from C.8)
Undrained (phi_u = 0):   sigma = (sigma'_v,mid + u) ∓ 2·cu          u = g_w·(WT − el)
Surcharge:  d_sigma_h = K·q          Water:  u = g_w·(WT − el)
Tension crack (level):  z0 = 2c'/(g·sqrt(Ka))
   crack water (drained, dry-capped):  P = ½ g_w · z_c²  at  (2/3) z_c,   z_c = min(z0, depth to WT)
Resultant on a face:    N = Σ sigma·dz        lever  zbar = (Σ sigma·dz·depth) / N

Active thrust on the analysed plane:
   virtual-plane height  H_v = top-of-wall + heel·tan b
   back batter from drawn taper  t = atan( (t_b − t_t)/H_stem );   d = k_a·phi'_d  (0 on the Rankine plane)
   H_soil = N·cos(incl)   V_soil = N·sin(incl)   y = H_v − zbar     (water/crack horizontal, no cosine)</pre>

				<p><strong>Gravity / cantilever — free body, bearing, and the GEO/EQU/SLS/UPL checks.</strong></p>
					<p>Geometry, resultant position and effective base width.</p>
					<div class="equations">
					<div class="formula">B = L<sub>toe</sub> + t<sub>b</sub> + L<sub>heel</sub></div>
					<div class="formula">H<sub>top</sub> = t<sub>base</sub> + H<sub>stem</sub>   (top-of-wall elevation above base underside)</div>
					<div class="formula">x<sub>R</sub> = (M<sub>stb</sub> − M<sub>dst</sub>) / V   (resultant position from toe; V, M per check below)</div>
					<div class="formula">e = | B/2 − x<sub>R</sub> |</div>
					<div class="formula">B′ = max(B − 2e, 0.05·B)   (Meyerhof effective width)</div>
					</div>
					<p>Permanent vertical free-body weights and lever arms about the toe tip (characteristic; γ is never factored).</p>
					<div class="equations">
					<div class="formula">W<sub>base</sub> = γ<sub>conc</sub>·B·t<sub>base</sub>   at   x = B/2</div>
					<div class="formula">A<sub>stem</sub> = ½(t<sub>t</sub> + t<sub>b</sub>)·H<sub>stem</sub></div>
					<div class="formula">W<sub>stem</sub> = γ<sub>conc</sub>·A<sub>stem</sub>   at   x = L<sub>toe</sub> + (t<sub>b</sub>² + t<sub>b</sub>t<sub>t</sub> + t<sub>t</sub>²) / (3(t<sub>b</sub> + t<sub>t</sub>))</div>
					<div class="formula">W<sub>key</sub> = γ<sub>conc</sub>·d<sub>key</sub>·t<sub>key</sub>   at   x = L<sub>toe</sub> + ½ t<sub>b</sub>   (only if d<sub>key</sub> &gt; 0 and t<sub>key</sub> &gt; 0)</div>
					<div class="formula">WT<sub>clip</sub> = clamp(WT<sub>ret</sub>, t<sub>base</sub>, H<sub>top</sub>),   h<sub>above</sub> = H<sub>top</sub> − WT<sub>clip</sub>,   h<sub>below</sub> = WT<sub>clip</sub> − t<sub>base</sub></div>
					<div class="formula">W<sub>heel-soil</sub> = L<sub>heel</sub>·(γ<sub>moist</sub>·h<sub>above</sub> + γ<sub>sat</sub>·h<sub>below</sub>)   at   x = L<sub>toe</sub> + t<sub>b</sub> + ½ L<sub>heel</sub></div>
					<div class="formula">W<sub>wedge</sub> = ½ γ<sub>moist</sub>·L<sub>heel</sub>²·tan β   at   x = L<sub>toe</sub> + t<sub>b</sub> + ⅔ L<sub>heel</sub>   (sloping backfill, β &gt; 0)</div>
					<div class="formula">ΣW = Σ W<sub>i</sub>,   ΣW·x ≡ Σ W<sub>i</sub>·x<sub>i</sub></div>
					</div>
					<p>Base hydrostatic uplift on the underside (permanent water action, single-source with the lateral water thrust; γ<sub>w</sub> = 9.81 kN/m³).</p>
					<div class="equations">
					<div class="formula">u<sub>F</sub> = γ<sub>w</sub>·max(WT<sub>front</sub>, 0),   u<sub>B</sub> = γ<sub>w</sub>·max(WT<sub>ret</sub>, 0)</div>
					<div class="formula">U = ½(u<sub>F</sub> + u<sub>B</sub>)·B</div>
					<div class="formula">x<sub>U</sub> = B·(u<sub>F</sub> + 2u<sub>B</sub>) / (3(u<sub>F</sub> + u<sub>B</sub>))   (= B/2 when u<sub>F</sub> + u<sub>B</sub> = 0)</div>
					</div>
					<p>Annex D bearing resistance (strip, shape factors = 1; φ′<sub>d</sub> floored at 1°; design strengths). The depth factors d<sub>c</sub>, d<sub>q</sub>, d<sub>γ</sub> are the optional Brinch-Hansen / Vesić refinement detailed by the bearing family (d<sub>γ</sub> = 1, and d = 1 when disabled).</p>
					<div class="equations">
					<div class="formula">N<sub>q</sub> = exp(π tan φ′<sub>d</sub>) · tan²(45° + φ′<sub>d</sub>/2)</div>
					<div class="formula">N<sub>c</sub> = (N<sub>q</sub> − 1) · cot φ′<sub>d</sub></div>
					<div class="formula">N<sub>γ</sub> = 2(N<sub>q</sub> − 1) · tan φ′<sub>d</sub></div>
					<div class="formula">base = 1 − H<sub>d</sub> / (V<sub>d</sub> + B′·c′<sub>d</sub>·cot φ′<sub>d</sub>)   (clamped to [0, 1]; m = 2, strip)</div>
					<div class="formula">i<sub>q</sub> = base²,   i<sub>γ</sub> = base³,   i<sub>c</sub> = i<sub>q</sub> − (1 − i<sub>q</sub>) / (N<sub>c</sub>·tan φ′<sub>d</sub>)   (clamped to [0, 1])</div>
					<div class="formula">q<sub>Rd</sub> = c′<sub>d</sub>·N<sub>c</sub>·i<sub>c</sub>·d<sub>c</sub> + q′·N<sub>q</sub>·i<sub>q</sub>·d<sub>q</sub> + ½·γ′·B′·N<sub>γ</sub>·i<sub>γ</sub>·d<sub>γ</sub></div>
					<div class="formula">undrained (φ<sub>u</sub> = 0):   q<sub>Rd</sub> = (π + 2)·c<sub>u,d</sub>·i<sub>c</sub>·d<sub>c</sub> + q′,   i<sub>c</sub> = ½(1 + √(1 − H<sub>d</sub>/(B′·c<sub>u,d</sub>)))</div>
					</div>
					<p>Design partial factors and design strengths used in the checks.</p>
					<div class="equations">
					<div class="formula">γ<sub>G</sub> = γ<sub>G,unfav</sub>·K<sub>FI</sub>,   γ<sub>Q</sub> = γ<sub>Q,unfav</sub>·K<sub>FI</sub>,   γ<sub>Gf</sub> = γ<sub>G,fav</sub></div>
					<div class="formula">φ′<sub>d</sub> = atan(tan φ′ / γ<sub>φ</sub>),   c′<sub>d</sub> = c′ / γ<sub>c</sub>,   c<sub>u,d</sub> = c<sub>u</sub> / γ<sub>cu</sub></div>
					</div>
					<p>Sliding (GEO) — favourable weights, uplift single-sourced with the water thrust at γ<sub>G</sub>.</p>
					<div class="equations">
					<div class="formula">H<sub>d</sub> = γ<sub>G</sub>·H<sub>soil</sub> + γ<sub>Q</sub>·H<sub>surch</sub> + γ<sub>G</sub>·(H<sub>w</sub> + H<sub>crack</sub>)</div>
					<div class="formula">V<sub>res</sub> = γ<sub>Gf</sub>·(ΣW + V<sub>soil</sub>) − γ<sub>G</sub>·U</div>
					<div class="formula">M<sub>stb</sub> = γ<sub>Gf</sub>·(ΣW·x + V<sub>soil</sub>·B) − γ<sub>G</sub>·U·x<sub>U</sub></div>
					<div class="formula">M<sub>dst</sub> = γ<sub>G</sub>·(H<sub>soil</sub>·y<sub>soil</sub> + H<sub>w</sub>·y<sub>w</sub> + H<sub>crack</sub>·y<sub>crack</sub>) + γ<sub>Q</sub>·H<sub>surch</sub>·y<sub>surch</sub></div>
					<div class="formula">x<sub>R</sub> = (M<sub>stb</sub> − M<sub>dst</sub>) / V<sub>res</sub>   →   e, B′</div>
					<div class="formula">tan δ<sub>b</sub> = tan[ (δ<sub>b</sub>/φ′)·φ′<sub>d</sub> ]   (δ<sub>b</sub>/φ′ = 1 cast-in-situ, ⅔ precast)</div>
					<div class="formula">R<sub>d</sub> = (V<sub>res</sub>·tan δ<sub>b</sub> + c<sub>a</sub>·B′) / γ<sub>R;h</sub> + R<sub>p</sub></div>
					<div class="formula">undrained:   R<sub>d</sub> = min(c<sub>u,d</sub>·B′ / γ<sub>R;h</sub>,  0.4·V<sub>res</sub>) + R<sub>p</sub></div>
					<div class="formula">pass:   H<sub>d</sub> ≤ R<sub>d</sub></div>
					</div>
					<p>Bearing (GEO) — single-source γ<sub>G</sub> on all permanent actions including uplift.</p>
					<div class="equations">
					<div class="formula">V<sub>d</sub> = γ<sub>G</sub>·(ΣW + V<sub>soil</sub> − U)</div>
					<div class="formula">H<sub>d</sub> = γ<sub>G</sub>·H<sub>soil</sub> + γ<sub>Q</sub>·H<sub>surch</sub> + γ<sub>G</sub>·(H<sub>w</sub> + H<sub>crack</sub>)</div>
					<div class="formula">M<sub>stb</sub> = γ<sub>G</sub>·(ΣW·x + V<sub>soil</sub>·B − U·x<sub>U</sub>)</div>
					<div class="formula">M<sub>dst</sub> = γ<sub>G</sub>·(H<sub>soil</sub>·y<sub>soil</sub> + H<sub>w</sub>·y<sub>w</sub> + H<sub>crack</sub>·y<sub>crack</sub>) + γ<sub>Q</sub>·H<sub>surch</sub>·y<sub>surch</sub></div>
					<div class="formula">x<sub>R</sub> = (M<sub>stb</sub> − M<sub>dst</sub>) / V<sub>d</sub>   →   e, B′</div>
					<div class="formula">q<sub>Ed</sub> = V<sub>d</sub> / B′</div>
					<div class="formula">R<sub>d</sub> = B′·q<sub>Rd</sub> / γ<sub>R;v</sub>   (Annex D; the De Beer route carries its own γ<sub>R;v</sub>·γ<sub>R;d</sub>, so R<sub>d</sub> = B′·q<sub>Rd</sub>)</div>
					<div class="formula">pass:   V<sub>d</sub> ≤ R<sub>d</sub></div>
					</div>
					<p>Eccentricity (ULS) — evaluated on the bearing-case loads.</p>
					<div class="equations">
					<div class="formula">e ≤ B/3</div>
					</div>
					<p>EQU static equilibrium — overturning about the toe (γ<sub>G,dst</sub> = 1.10, γ<sub>G,stb</sub> = 0.90, γ<sub>Q,dst</sub> = 1.50; no K<sub>FI</sub>).</p>
					<div class="equations">
					<div class="formula">M<sub>dst</sub> = γ<sub>G,dst</sub>·(H<sub>soil</sub>·y<sub>soil</sub> + H<sub>w</sub>·y<sub>w</sub> + H<sub>crack</sub>·y<sub>crack</sub> + U·x<sub>U</sub>) + γ<sub>Q,dst</sub>·H<sub>surch</sub>·y<sub>surch</sub></div>
					<div class="formula">M<sub>stb</sub> = γ<sub>G,stb</sub>·(ΣW·x + V<sub>soil</sub>·B)</div>
					<div class="formula">pass:   M<sub>dst</sub> ≤ M<sub>stb</sub></div>
					</div>
					<p>SLS bearing-pressure distribution (characteristic strength, set M1; unfactored actions).</p>
					<div class="equations">
					<div class="formula">V = ΣW + V<sub>soil</sub> − U</div>
					<div class="formula">M<sub>stb</sub> = ΣW·x + V<sub>soil</sub>·B − U·x<sub>U</sub></div>
					<div class="formula">M<sub>dst</sub> = H<sub>soil</sub>·y<sub>soil</sub> + H<sub>w</sub>·y<sub>w</sub> + H<sub>crack</sub>·y<sub>crack</sub> + H<sub>surch</sub>·y<sub>surch</sub></div>
					<div class="formula">x<sub>R</sub> = (M<sub>stb</sub> − M<sub>dst</sub>) / V,   e = | B/2 − x<sub>R</sub> |</div>
					<div class="formula">if e ≤ B/6:   q<sub>max</sub>, q<sub>min</sub> = (V/B)(1 ± 6e/B)</div>
					<div class="formula">if e &gt; B/6:   q<sub>max</sub> = 2V / (3(B/2 − e)),   q<sub>min</sub> = 0   (triangular fallback)</div>
					<div class="formula">pass:   e ≤ B/6</div>
					</div>
					<p>UPL flotation (γ<sub>G,dst</sub> = 1.00 on uplift, γ<sub>G,stb</sub> = 0.90 on favourable weight; side/base friction neglected).</p>
					<div class="equations">
					<div class="formula">G<sub>stb</sub> = ΣW + V<sub>soil</sub></div>
					<div class="formula">pass:   γ<sub>G,dst</sub>·U ≤ γ<sub>G,stb</sub>·G<sub>stb</sub></div>
					</div>
<pre>B = toe + t_b + heel        top-of-wall = baseThk + H_stem        B' = max(B − 2e, 0.05 B)
W_base = g_c·B·baseThk @ B/2     W_stem = g_c·½(t_t+t_b)·H_stem @ toe+(t_b²+t_b t_t+t_t²)/(3(t_b+t_t))
W_heelsoil = heel·(g_moist·h_above + g_sat·h_below) @ heel mid   (split at retained WT)
W_wedge = ½ g_moist·heel²·tan b @ toe+t_b+(2/3)heel   (sloping fill)
Base uplift:  u_F = g_w·max(WT_front,0),  u_B = g_w·max(WT_ret,0)
   U = ½(u_F + u_B)·B    at   x = B·(u_F + 2u_B)/(3(u_F + u_B))

Bearing factors (Annex D, strip; phi' floored at 1°):
   N_q = e^(pi·tan phi')·tan²(45° + phi'/2)    N_c = (N_q − 1)/tan phi'    N_g = 2(N_q − 1)·tan phi'
   base = 1 − H/(V + B'·c'/tan phi');   i_q = base²,  i_g = base³,  i_c = i_q − (1−i_q)/(N_c·tan phi')
   q_Rd = c'·N_c·i_c·d_c + q'·N_q·i_q·d_q + ½ g'·B'·N_g·i_g·d_g    (d_* = Brinch-Hansen/Vesic depth factors, default-on, d_g=1, =1 when off)
        (undrained: q_Rd = (pi+2)·cu·i_c·d_c + q',  i_c = ½(1+sqrt(1−H/(B'·cu))),  d_c = 1 + 0.4·k)

Checks   (g_G = g_G,unfav·K_FI,  g_Q = g_Q,unfav·K_FI,  g_Gf = g_G,fav):
 Sliding (GEO):  H_d = g_G·H_soil + g_Q·H_surch + g_G·(H_w + H_crack)
   V_res = g_Gf·(ΣW + V_soil) − g_G·U;   d_b = (d_b/phi')·phi'_d
   R_d = (V_res·tan d_b + c_a·B')/g_R;h + R_p     [undrained: R_d = min(cu_d·B'/g_R;h, 0.4·V_res) + R_p]   pass: H_d ≤ R_d
 Bearing (GEO, single-source g_G incl. U):  V_d = g_G·(ΣW + V_soil − U);  q_Ed = V_d/B';  R_d = B'·q_Rd/g_R;v;  pass: V_d ≤ R_d
 Eccentricity:  e ≤ B/3
 EQU:  M_dst = g_G,dst·(H_soil·y + H_w·y + H_crack·y + U·x) + g_Q,dst·H_surch·y ≤ M_stb = g_G,stb·(ΣW·x + V_soil·B)   (1.10/0.90)
 SLS (characteristic, M1):  e ≤ B/6;   q_max,min = (V/B)(1 ± 6e/B)   [if e ≤ B/6, else q_max = 2V/(3(B/2−e)), q_min = 0]
 UPL flotation:  g_G,dst·U ≤ g_G,stb·(ΣW + V_soil)   (1.00/0.90)</pre>

				<p><strong>Bearing resistance — three selectable routes.</strong> The default is EN 1997-1 Annex D with the depth-factor refinement; the De Beer / NF P94-261 CPT-direct method is selectable when a CPT profile is present.</p>
					<p>Route 1 — EN 1997-1 Annex D, analytical c′–φ′ (strip; shape and base factors = 1; inside DA1, R1 = 1.0). φ′<sub>d</sub> floored at 1°.</p>
					<div class="equations">
					<div class="formula">N<sub>q</sub> = exp(π tan φ′<sub>d</sub>) · tan²(45° + φ′<sub>d</sub>/2)</div>
					<div class="formula">N<sub>c</sub> = (N<sub>q</sub> − 1) · cot φ′<sub>d</sub></div>
					<div class="formula">N<sub>γ</sub> = 2(N<sub>q</sub> − 1) · tan φ′<sub>d</sub></div>
					<div class="formula">base = 1 − H<sub>d</sub> / (V<sub>d</sub> + B′·c′<sub>d</sub>·cot φ′<sub>d</sub>)</div>
					<div class="formula">i<sub>q</sub> = base²</div>
					<div class="formula">i<sub>γ</sub> = base³</div>
					<div class="formula">i<sub>c</sub> = i<sub>q</sub> − (1 − i<sub>q</sub>) / (N<sub>c</sub>·tan φ′<sub>d</sub>)</div>
					<div class="formula">q<sub>Rd</sub> = c′<sub>d</sub>·N<sub>c</sub>·i<sub>c</sub>·d<sub>c</sub> + q′·N<sub>q</sub>·i<sub>q</sub>·d<sub>q</sub> + ½·γ′·B′·N<sub>γ</sub>·i<sub>γ</sub>·d<sub>γ</sub></div>
					<div class="formula">B′ = B − 2e (Meyerhof effective width)</div>
					<div class="formula">R<sub>d</sub> = B′·q<sub>Rd</sub> / γ<sub>R;v</sub></div>
					</div>
					<p>Annex D — undrained branch (founding stratum total-stress, φ = 0).</p>
					<div class="equations">
					<div class="formula">i<sub>c</sub> = ½·(1 + √(1 − H<sub>d</sub> / (B′·c<sub>u,d</sub>)))</div>
					<div class="formula">q<sub>Rd</sub> = (π + 2)·c<sub>u,d</sub>·i<sub>c</sub>·d<sub>c</sub> + q′</div>
					</div>
					<p>Route 2 — Brinch-Hansen / Vesic depth factors (opt-in refinement, default on; credits the soil shear above the buried toe; d<sub>γ</sub> = 1 always). D = founding depth below the design front level.</p>
					<div class="equations">
					<div class="formula">k = D / B′ (for D/B′ ≤ 1)</div>
					<div class="formula">k = arctan(D / B′) (for D/B′ &gt; 1; radians)</div>
					<div class="formula">d<sub>q</sub> = 1 + 2·tan φ′<sub>d</sub>·(1 − sin φ′<sub>d</sub>)²·k</div>
					<div class="formula">d<sub>c</sub> = d<sub>q</sub> − (1 − d<sub>q</sub>) / (N<sub>c</sub>·tan φ′<sub>d</sub>)</div>
					<div class="formula">d<sub>γ</sub> = 1</div>
					<div class="formula">d<sub>c</sub> = 1 + 0.4·k (undrained, φ = 0; applied to the (π + 2)·c<sub>u,d</sub> term)</div>
					</div>
					<p>Route 3 — De Beer / NF P94-261 CPT-direct (shallow strip toe; selected when a CPT q<sub>c</sub> profile is present, else reverts to Annex D). q<sub>cm</sub> = mean q<sub>c</sub> over the influence zone; q<sub>cc</sub> is the peak-clipped cone resistance.</p>
					<div class="equations">
					<div class="formula">q<sub>cc</sub> = min(q<sub>c</sub>, 1.3·q<sub>cm</sub>) (De Beer peak clip)</div>
					<div class="formula">q<sub>ce</sub> = mean of q<sub>cc</sub> over [founding, founding − 1.5·B′]</div>
					<div class="formula">D<sub>e</sub> = (1 / q<sub>ce</sub>) · ∫<sub>0</sub><sup>D</sup> q<sub>cc</sub> dz</div>
					<div class="formula">k<sub>c</sub> = min[ k<sub>c0</sub> + (a + b·D<sub>e</sub>/B′)·(1 − exp(−c·D<sub>e</sub>/B′)) , k<sub>c,max</sub> ]</div>
					<div class="formula">i<sub>δ</sub> = [clamp(1 − H<sub>d</sub>/V<sub>d</sub>, 0, 1)]²</div>
					<div class="formula">q<sub>net</sub> = k<sub>c</sub>·q<sub>ce</sub>·i<sub>δ</sub></div>
					<div class="formula">R<sub>d</sub> = B′·( q<sub>net</sub> / (γ<sub>R;v</sub>·γ<sub>R;d</sub>) + q<sub>0</sub> ),  γ<sub>R;v</sub>·γ<sub>R;d</sub> = 1.4 · 1.2</div>
					</div>
					<p>NF P94-261 Tableau E.2.3 — penetrometric bearing factor k<sub>c</sub> (strip, B/L = 0; founding stratum auto-classified).</p>
					<div class="equations">
					<div class="formula">sand and gravel (drained, φ′ ≥ 25°):  k<sub>c0</sub> = 0.09, a = 0.04, b = 0.006, c = 2.0, k<sub>c,max</sub> = 0.141</div>
					<div class="formula">clay and silt (otherwise):  k<sub>c0</sub> = 0.27, a = 0.07, b = 0.007, c = 1.3, k<sub>c,max</sub> = 0.348</div>
					</div>
<pre>(1) EN 1997-1 ANNEX D — analytical c-φ (informative sample method; inside DA1, R1 = 1.0)
   N_q = e^(pi·tan phi'_d)·tan²(45° + phi'_d/2)     N_c = (N_q − 1)·cot phi'_d     N_gamma = 2(N_q − 1)·tan phi'_d
   strip shape factors s = 1, horizontal base b = 1.   Load inclination (m = 2, strip):
      base = 1 − H_d/(V_d + B'·c'_d·cot phi'_d);   i_q = base²,   i_gamma = base³,   i_c = i_q − (1−i_q)/(N_c·tan phi'_d)
   q_Rd = c'_d·N_c·i_c·d_c + q'·N_q·i_q·d_q + ½·gamma'·B'·N_gamma·i_gamma·d_gamma
   B' = B − 2e (Meyerhof effective width); q' and the N_gamma soil use the LAYERED front profile; R_d = B'·q_Rd / gamma_R;v.
   Annex D itself omits depth factors (d = 1) — so the inclined, eccentric load on a shallow footing governs.

(2) DEPTH FACTORS (Brinch-Hansen 1970 / Vesic 1973; opt-in refinement, default ON)
   D = founding depth below the design front level;   k = D/B'  if D/B' ≤ 1,   else   arctan(D/B')  [radians]
   d_q = 1 + 2·tan phi'_d·(1 − sin phi'_d)²·k       d_c = d_q − (1 − d_q)/(N_c·tan phi'_d)       d_gamma = 1  (always)
   undrained (phi = 0):   d_c = 1 + 0.4·k   on the (pi + 2)·c_u term.
   Credits the soil shear above the buried toe; switching it off reverts to the conservative pure-Annex-D value.

(3) DE BEER / NF P94-261 — CPT-direct (Fascicule 62-V; De Beer shallow-footing lineage; a DIRECT method)
   q_ce = mean q_c over [founding, founding − 1.5 B'], with the De Beer peak clip:  q_c &gt; 1.3·q_cm  ⇒  clip to 1.3·q_cm
   D_e  = (1/q_ce)·∫₀^D min(q_c, 1.3·q_cm) dz     (equivalent embedment; SAME De Beer clip as q_ce; weak surface cover ⇒ D_e &lt; D)
   k_c  = min[ k_c0 + (a + b·D_e/B')·(1 − exp(−c·D_e/B')) ,  k_c,max ]      (unconditional cap; strip footing, B/L = 0)
   i_delta = [ clamp(1 − H_d/V_d, 0, 1) ]²        (load-inclination surrogate, clamped then squared)
   q_net = k_c·q_ce·i_delta;      R_d = B'·( q_net/(gamma_R;v·gamma_R;d) + q0 ),      gamma_R;v·gamma_R;d = 1.4 · 1.2
   NF P94-261 Tableau E.2.3 (strip):    sand &amp; gravel   k_c0 = 0.09   (a 0.04, b 0.006, c 2.0, k_c,max 0.141)
                                         clay &amp; silt     k_c0 = 0.27   (a 0.07, b 0.007, c 1.3, k_c,max 0.348)
   A shallow toe mobilises only k_c ≪ 1 of q_c. DISTINCT from the deep-pile BGGG-GBMS De Beer method (q_b ≈ q_c) in the
   pile module — surface-shear (shallow toe) vs deep-punching (pile base). Reverts to Annex D if no q_c is supplied.</pre>

				<p>
					<strong>Parameters.</strong> φ′<sub>d</sub>, c′<sub>d</sub> — design (M-factored) friction and cohesion of the
					founding stratum; q′ — effective overburden at founding from the layered front soil above the design dig
					level; γ′ — buoyant unit weight of the N<sub>γ</sub> failure wedge (submerged when either water table reaches
					founding); B′ = B − 2e — the Meyerhof effective width; H<sub>d</sub>, V<sub>d</sub> — the factored horizontal and
					vertical actions; q<sub>c</sub> — the CPT cone resistance; q<sub>ce</sub> — the De Beer equivalent cone resistance
					near founding; D<sub>e</sub> — the equivalent embedment; k<sub>c</sub> — the NF penetrometric bearing factor
					(largest in clay, smallest in sand, because q<sub>ce</sub> is small in clay and large in sand).
				</p>
				<p>
					<strong>The two frameworks differ and are not combined.</strong> Annex D is the analytical method inside
					Design Approach 1 — soil strength is M-factored at source and the resistance factor is R1 = 1.0. The De Beer /
					NF P94-261 route is a <em>direct</em> method: the resistance is the measured q<sub>c</sub>, divided by the NF
					resistance + model factors (γ<sub>R;v</sub>·γ<sub>R;d</sub> = 1.4·1.2). Both descend from Egide De Beer's work,
					but the <em>shallow</em> toe (q<sub>net</sub> = k<sub>c</sub>·q<sub>ce</sub>, k<sub>c</sub> ≪ 1, a general/surface
					shear mechanism) and the <em>deep</em> pile base (q<sub>b</sub> ≈ q<sub>c</sub> via the BGGG-GBMS scale
					transformation used in the pile module, a deep-punching mechanism) are physically different problems and
					therefore correctly different formulas — they should not be conflated. For dense sand the De Beer route
					typically returns a higher capacity than the φ-capped Annex D method; for soft or low-q<sub>c</sub> ground the
					Annex D c-φ method is the more reliable choice.
				</p>
				<p>
					<strong>Modelling notes (De Beer route — verified against NF P94-261).</strong> A handful of
					implementation choices are worth stating explicitly so the route is transparent and auditable:
				</p>
				<ul>
					<li>
						<strong>Effective width.</strong> The equivalent-resistance window depth (1.5·B′) and the De Beer
						embedment ratio D<sub>e</sub>/B′ both use the Meyerhof <em>effective</em> width B′ = B − 2e, not the
						gross width. Using B′ keeps the q<sub>ce</sub>-averaging depth and the k<sub>c</sub> penetration ratio
						consistent with the eccentric contact area, and the seating resistance is likewise R<sub>0</sub> =
						q<sub>0</sub>·B′ (per metre run). This is conservative for an eccentric base.
					</li>
					<li>
						<strong>Per-layer q<sub>c</sub>.</strong> q<sub>ce</sub> is the De Beer-clipped mean of the measured
						q<sub>c</sub> over the window — each stratum contributes its own q<sub>c</sub> (parsed per layer), so a
						layered profile is integrated cell-by-cell rather than with a single representative value. The clip
						(q<sub>c</sub> &gt; 1.3·q<sub>cm</sub> → 1.3·q<sub>cm</sub>, NF C.2.2) is applied inside <em>both</em> the
						q<sub>ce</sub> mean and the D<sub>e</sub> = (1/q<sub>ce</sub>)∫q<sub>c</sub> dz integral, so a thin stiff
						lens cannot inflate either quantity.
					</li>
					<li>
						<strong>Load inclination.</strong> NF P94-261 reduces the CPT bearing term with an inclination factor
						i<sub>δ</sub>. We use the conservative surrogate i<sub>δ</sub> = (1 − H<sub>d</sub>/V<sub>d</sub>)²,
						clamped to [0, 1], which collapses to 1 for a vertical resultant and degrades faster than the
						φ-dependent Annex D form — a deliberately safe choice when no founding-level φ is invoked by the direct
						method.
					</li>
					<li>
						<strong>Sand vs clay k<sub>c</sub>.</strong> The k<sub>c</sub> coefficient set is selected by soil
						class at founding level: φ′ ≥ 25° (or a granular classification) takes the sand row, otherwise the clay
						row. Because k<sub>c</sub> is larger in clay but q<sub>ce</sub> is far larger in sand, the product
						q<sub>net</sub> = k<sub>c</sub>·q<sub>ce</sub> still ranks sand above clay.
					</li>
					<li>
						<strong>CPT depth caveat.</strong> The direct route is only as deep as the CPT sounding. If the founding
						level or the 1.5·B′ window extends below the deepest q<sub>c</sub> reading the mean is taken over the
						available data only — extend the sounding past the influence zone for a fully governed result.
					</li>
				</ul>

				<p><strong>Embedded walls — net pressure, embedment, heave, anchor force.</strong></p>
					<p>Unplanned over-excavation (EN 1997-1 §9.3.2.2): the engine lowers the front level by Δa before any pressures are built. Cantilever walls use 10% of the retained height; anchored walls 10% of the height below the lowest support (both capped at 0.5 m). With a dry front (no standing water in the pit) the Belgian dry-excavation floor of 0.30 m applies on top of the percentage rule.</p>
					<div class="equations">
					<div class="formula">excavation<sub>el</sub> ← excavation<sub>el</sub> − max(Δa, 0)</div>
					<div class="formula">Δa = min(0.10·H<sub>ret</sub>, 0.5 m)      (cantilever)</div>
					<div class="formula">Δa = min(0.10·(H<sub>ret</sub> − h<sub>anchor</sub>), 0.5 m)      (anchored / propped)</div>
					<div class="formula">Δa ← max(Δa, 0.30 m)      (dry front only)</div>
					</div>
					<p>Net horizontal pressure per cell — back active over the full retained height, front passive only below the (over-dug) excavation level; permanent earth and water by γ<sub>G</sub>, variable surcharge by γ<sub>Q</sub>.</p>
					<div class="equations">
					<div class="formula">drive = γ<sub>G</sub>·(p<sub>a</sub> + u<sub>back</sub>) + γ<sub>Q</sub>·p<sub>surch</sub></div>
					<div class="formula">p<sub>a</sub> = K<sub>a</sub>·σ′<sub>v</sub> − 2·√K<sub>a</sub>·c′      (p<sub>a</sub> ≥ 0, tension cut-off)</div>
					<div class="formula">p<sub>surch</sub> = K<sub>a</sub>·q</div>
					<div class="formula">resist = γ<sub>G</sub>·(p<sub>resist</sub> + u<sub>front</sub>)</div>
					<div class="formula">p<sub>resist</sub> = K<sub>p</sub>·σ′<sub>v</sub> + K<sub>pc</sub>·c′      (Annex C)</div>
					</div>
					<p>Limiting-equilibrium embedment — moments about the rotation point (toe for a cantilever, anchor/prop for a propped wall), with the over-design factor driven to unity by bisection.</p>
					<div class="equations">
					<div class="formula">toe<sub>el</sub> = excavation<sub>el</sub> − d,      ref = toe<sub>el</sub> (cantilever) or anchor<sub>el</sub> (propped)</div>
					<div class="formula">M = Σ (drive − resist)·dz·(el − ref)</div>
					<div class="formula">ODF = |M<sub>resist</sub>| / |M<sub>drive</sub>| ≥ 1</div>
					<div class="formula">d<sub>req</sub>: solve ODF(d) = 1 by bisection on d ∈ [0.10, 40] m</div>
					</div>
					<p>Design embedment — Blum 20% addition for a cantilever, none when propped; governed by the worst of the two DA1 combinations. The moment/shear diagrams and M<sub>max</sub> are computed on the <em>provided</em> pile (a diagram cannot be longer than the structure it acts on); embedment adequacy is reported separately as the d<sub>provided</sub> ≥ d<sub>required</sub> check, with the moment-equilibrium ODF at the provided depth alongside.</p>
					<div class="equations">
					<div class="formula">d<sub>design</sub> = 1.2·d<sub>req</sub>      (cantilever, Blum)</div>
					<div class="formula">d<sub>design</sub> = d<sub>req</sub>      (propped / anchored)</div>
					<div class="formula">d<sub>required</sub> = max(d<sub>design,C1</sub>, d<sub>design,C2</sub>)</div>
					<div class="formula">analysis depth = d<sub>provided</sub> (≥ 0.10 m);   adequacy: d<sub>provided</sub> ≥ d<sub>required</sub></div>
					</div>
					<p>Hydraulic heave / piping (HYD, EN 1997-1 §10.3) at the toe — destabilising excess pore pressure versus stabilising buoyant effective stress, the full differential head dissipated over the embedment.</p>
					<div class="equations">
					<div class="formula">Δh = z<sub>w,retained</sub> − z<sub>w,front</sub></div>
					<div class="formula">E<sub>d</sub> = 1.35·γ<sub>w</sub>·Δh ≤ R<sub>d</sub> = 0.90·γ′·d</div>
					<div class="formula">i<sub>exit</sub> = Δh / d</div>
					<div class="formula">i<sub>crit</sub> = γ′ / γ<sub>w</sub></div>
					</div>
					<p>Anchor / prop force — free-earth horizontal equilibrium of the factored thrusts at the equilibrium (FES) depth, per combination.</p>
					<div class="equations">
					<div class="formula">H<sub>drive</sub> = Σ drive·dz</div>
					<div class="formula">H<sub>resist</sub> = Σ resist·dz</div>
					<div class="formula">T = H<sub>drive</sub> − H<sub>resist</sub>      (≥ 0)</div>
					</div>
<pre>Engine over-dig:  excavationEl ← excavationEl − max(da, 0),   da = min(0.10·H_ret, 0.5 m)
Net pressure per cell (back active / front passive; passive only below excavation):
   drive  = g_G·(p_a + u_back) + g_Q·p_surch        p_a = Ka·sigma'_v − 2·sqrt(Ka)·c'
   resist = g_G·(p_resist + u_front)                p_resist = Kp·sigma'_v + K_pc·c'   (Annex C)
Moment about the rotation point (toe = cantilever, anchor = propped):  M = Σ (drive − resist)·dz·(el − ref)
Over-design factor:  ODF = |M_resist| / |M_drive| ≥ 1   →   required d by bisection on [0.10, 40] m
   cantilever:  d_design = 1.2·d_req (Blum)        propped:  d_design = d_req
   governing d = max over [C1, C2];   analysis depth = max(d_required, d_provided)
HYD heave/piping:  E_d = 1.35·g_w·dh ≤ R_d = 0.90·g'·d        i_exit = dh/d,   i_crit = g'/g_w
Anchor/prop force (free-earth horizontal equilibrium at the FES depth):  T = H_drive − H_resist</pre>

				<p><strong>Structural design forces and the anchor / wall-vertical checks.</strong></p>
					<p>Gross contact pressure for slab design — base uplift is NOT subtracted (handled by superposition), so V<sub>d</sub> carries γ<sub>G</sub> on all permanent vertical load. e is signed, positive toward the toe.</p>
					<div class="equations">
					<div class="formula">V<sub>d</sub> = γ<sub>G</sub>·(Σ W + V<sub>soil</sub>)   (gross — base uplift not subtracted)</div>
					<div class="formula">M<sub>stb</sub> = γ<sub>G</sub>·(Σ W·x + V<sub>soil</sub>·B)</div>
					<div class="formula">M<sub>dst</sub> = γ<sub>G</sub>·(H<sub>soil</sub>·y<sub>soil</sub> + H<sub>w</sub>·y<sub>w</sub> + H<sub>crack</sub>·y<sub>crack</sub>) + γ<sub>Q</sub>·H<sub>surch</sub>·y<sub>surch</sub></div>
					<div class="formula">x<sub>R</sub> = (M<sub>stb</sub> − M<sub>dst</sub>) / V<sub>d</sub></div>
					<div class="formula">e = B/2 − x<sub>R</sub>   (signed, + toward toe)</div>
					<div class="formula">q<sub>mean</sub> = V<sub>d</sub> / B</div>
					</div>
					<p>For |e| ≤ B/6 the bearing diagram is linear across the full base (q<sub>toe</sub> at x = 0, q<sub>heel</sub> at x = B); beyond B/6 it is triangular over the contact length a, with the peak at the loaded edge.</p>
					<div class="equations">
					<div class="formula">|e| ≤ B/6:   q<sub>toe</sub> = q<sub>mean</sub>·(1 + 6e/B),   q<sub>heel</sub> = q<sub>mean</sub>·(1 − 6e/B)   (linear)</div>
					<div class="formula">|e| &gt; B/6:   a = 3·(B/2 − |e|),   q<sub>pk</sub> = 2·V<sub>d</sub> / a   (triangular)</div>
					</div>
					<p>Stem design forces — active backfill thrust over the stem height H<sub>s</sub>, moment taken about the stem base. N is the soil active-thrust resultant; z<sub>i</sub> is each resultant's depth below the top of the stem.</p>
					<div class="equations">
					<div class="formula">M<sub>stem</sub> = γ<sub>G</sub>·N·(H<sub>s</sub> − z<sub>N</sub>) + γ<sub>Q</sub>·M<sub>surch</sub> + γ<sub>G</sub>·M<sub>w</sub>   (about stem base)</div>
					<div class="formula">M<sub>surch</sub> = N<sub>surch</sub>·(H<sub>s</sub> − z<sub>surch</sub>),   M<sub>w</sub> = N<sub>w</sub>·(H<sub>s</sub> − z<sub>w</sub>) + N<sub>crack</sub>·(H<sub>s</sub> − z<sub>crack</sub>)</div>
					<div class="formula">V<sub>stem</sub> = γ<sub>G</sub>·N + γ<sub>Q</sub>·N<sub>surch</sub> + γ<sub>G</sub>·(N<sub>w</sub> + N<sub>crack</sub>)</div>
					</div>
					<p>Toe slab — net upward bearing pressure relieved by the favourable toe self-weight, moment about the stem front. x runs from the toe tip (x = 0) to the stem front (x = L<sub>toe</sub>); γ<sub>conc</sub> = concrete unit weight, t<sub>base</sub> = base-slab thickness.</p>
					<div class="equations">
					<div class="formula">M<sub>toe</sub> = ∫<sub>0</sub><sup>L<sub>toe</sub></sup> [ q(x) − γ<sub>G,fav</sub>·γ<sub>conc</sub>·t<sub>base</sub> ]·(L<sub>toe</sub> − x) dx   (slab self-weight = favourable relief)</div>
					</div>
					<p>Heel slab — downward soil + slab + surcharge load minus the upward bearing pressure, moment about the stem back x<sub>b</sub>. The retained soil column is split at the water table z<sub>w</sub> into a moist part above and a saturated part below; y<sub>top</sub> = top-of-wall elevation.</p>
					<div class="equations">
					<div class="formula">surf(x) = y<sub>top</sub> + (x − x<sub>b</sub>)·tan β,   h(x) = surf(x) − t<sub>base</sub>   (soil-column height over the heel)</div>
					<div class="formula">h<sub>above</sub> = surf(x) − z<sub>w</sub>,   h<sub>below</sub> = z<sub>w</sub> − t<sub>base</sub>   (z<sub>w</sub> clamped to [t<sub>base</sub>, surf(x)])</div>
					<div class="formula">w(x) = γ<sub>G</sub>·(γ<sub>moist</sub>·h<sub>above</sub> + γ<sub>sat</sub>·h<sub>below</sub>) + γ<sub>G</sub>·γ<sub>conc</sub>·t<sub>base</sub> + γ<sub>Q</sub>·q</div>
					<div class="formula">M<sub>heel</sub> = ∫<sub>heel</sub> [ w(x) − q(x) ]·(x − x<sub>b</sub>) dx</div>
					</div>
					<p>Embedded wall — factored bending moment by double integration of the net pressure down the wall; the structural maximum is the governing (largest-|M|) zero-shear crossing per Blum — each V = 0 crossing is a local moment extremum, and for anchored walls the first crossing is not necessarily the largest. The cohesion c′ enters through p<sub>a</sub> and p<sub>resist</sub>.</p>
					<div class="equations">
					<div class="formula">p<sub>a</sub> = K<sub>a</sub>·σ′<sub>v</sub> − 2√K<sub>a</sub>·c′,   p<sub>resist</sub> = K<sub>p</sub>·σ′<sub>v</sub> + K<sub>pc</sub>·c′   (Annex C)</div>
					<div class="formula">net = γ<sub>G</sub>·(p<sub>a</sub> + u<sub>back</sub>) − γ<sub>G</sub>·(p<sub>resist</sub> + u<sub>front</sub>) + γ<sub>Q</sub>·p<sub>surch</sub></div>
					<div class="formula">V(z) ← V + net·dz   (V ← V − T at the anchor level)</div>
					<div class="formula">M(z) ← M + V·dz</div>
					<div class="formula">M<sub>max</sub> = largest |M| among the V = 0 crossings (Blum),   else max |M|</div>
					</div>
					<p>Ground-anchor pull-out (EN 1537) — calculated grout-body bond resistance, checked per anchor at the design axial force. T = anchor force per metre run, α = inclination from horizontal, s = horizontal spacing, Ø = grout-body diameter, L<sub>fixed</sub> = fixed (bond) length, τ = characteristic bond stress.</p>
					<div class="equations">
					<div class="formula">R<sub>a,k</sub> = π·Ø·L<sub>fixed</sub>·τ</div>
					<div class="formula">R<sub>a,d</sub> = R<sub>a,k</sub> / γ<sub>a</sub>   (γ<sub>a</sub> = 1.1, EN 1997-1 Table A.12)</div>
					<div class="formula">T<sub>axial</sub> = (T / cos α)·s   (design axial force per anchor)</div>
					<div class="formula">V = T·tan α   (down-drag on the wall, per m run)</div>
					<div class="formula">pass:  T<sub>axial</sub> ≤ R<sub>a,d</sub></div>
					</div>
					<p>Wall vertical equilibrium (screening) — the inclined-anchor down-drag must be carried by the embedded shaft friction over both faces (Jaky K<sub>0</sub> = 1 − sin φ′, δ = ⅔ φ′; base resistance and wall self-weight neglected). σ′<sub>v</sub> is the front-soil effective vertical stress from the excavation level down.</p>
					<div class="equations">
					<div class="formula">R<sub>v</sub> = Σ 2·(1 − sin φ′)·σ′<sub>v</sub>·tan(⅔ φ′)·dz   (over the embedment, both faces)</div>
					<div class="formula">pass:  V ≤ R<sub>v</sub>   (V = T·tan α)</div>
					</div>
<pre>Contact pressure for slab design (gross — base uplift NOT subtracted, by superposition):
   V_d = g_G·(ΣW + V_soil),   e signed (+ toward toe)
   |e| ≤ B/6:  q(x) = q_mean·(1 ± 6e/B) (linear)    |e| beyond B/6:  triangular over a = 3(B/2−|e|), peak q_pk = 2V_d/a
Stem (about base):  M = g_G·N·(H_s − zbar) + g_Q·M_surch + g_G·M_water     V = g_G·N + g_Q·N_surch + g_G·(N_w + N_crack)
Toe  (about stem front):  M = integral over [0,toe] of [ q(x) − g_Gf·g_c·baseThk ]·(toe − x) dx     (slab self-weight = favourable relief)
Heel (about stem back):   M = integral over the heel of [ (g_G·g_soil·h(x) + g_G·g_c·baseThk + g_Q·q) − q(x) ]·(x − x_b) dx
   h(x) = top-of-wall + (x − x_b)·tan b − baseThk     (carries the sloping wedge), split at the WT
Embedded M_max:  double integration  V ← V + net·dz,  M ← M + V·dz,  anchor adds  V ← V − T;
   M_max at the first zero-shear crossing (Blum), else max|M|

Ground-anchor pull-out (EN 1537):  R_ak = pi·D·L_fixed·tau;   R_ad = R_ak/g_a   (g_a = 1.1, EN Table A.12)
   axial per anchor  T_axial = T/cos(alpha)·s;   down-drag  V = T·tan(alpha);   pass: T_axial ≤ R_ad
Wall vertical equilibrium (screening; base resistance neglected):
   R_v = Σ 2·(1 − sin phi')·sigma'_v·tan((2/3) phi')·dz   over the embedded length, both faces;   pass: V ≤ R_v</pre>
			</section>

			<section id="solver" class="doc-card">
				<p class="section-label">Inputs and workflow</p>
				<h2>8. Inputs and interactive section</h2>
				<p>
					Foundation / in-situ parameters default from the active CPT layer model
					(γ, γ<sub>sat</sub>, φ′, c′, c<sub>u</sub>) and are editable; the backfill behind a
					gravity/cantilever wall is a separate user-defined material; the front soil supplies the
					passive resistance. The section is drawn live — the CPT soil layers, the wall, water,
					surcharge, the active/passive pressure and bending-moment diagrams, and the ground anchor
					are all to scale, and the geometry can be edited by dragging the handles directly on the
					drawing. The earth-pressure method is fixed by the geometry (no method menu). Editable settings are the active, base and passive wall-
					friction ratios (δ/φ′), the consequence
					class, the surcharge, and the full anchor configuration. The unplanned over-dig Δa is applied automatically (EN 1997-1 §9.3.2.2) and drawn on the section. Every
					verification reports the governing DA1 combination, the demand, the resistance and the
					utilisation.
				</p>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Assumptions and limitations</p>
				<h2>9. Documented assumptions</h2>
				<ul class="notes">
					<li>Built on EN 1997-1:2004 + NBN EN 1997-1 ANB (DA1). Factor sets are configurable for the 2nd-generation EN 1997-1:2024 verification cases.</li>
					<li>DA1 Combination-2 variable-action factor defaults to 1.30; the Buildwise risk-class scheme (γ<sub>Q</sub> 1.10/1.20) is an optional, project-confirmed overlay only.</li>
					<li>R1 = 1.0 applies to the wall body. <strong>Ground anchors</strong> are verified here for <strong>pull-out</strong> only (R<sub>a,k</sub> = π·Ø·L<sub>fixed</sub>·τ, R<sub>a,d</sub> = R<sub>a,k</sub>/γ<sub>a</sub>): <strong>γ<sub>a</sub> = 1.1 is the EN 1997-1 Table A.12 anchor factor (temporary and permanent) and is EN-conforming</strong> — the ~1.5–1.6 range is the pile R4 set and does not apply to anchors. The real caveat is that the calculated π·Ø·L·τ bond is untested and must be proven by EN 1537 acceptance testing (apply a model factor / reduce τ until then). The tendon/steel design and the free-length adequacy remain the engineer's responsibility. The inclined anchor's downward component V = ΣT·tan(angle) is carried into a screening wall vertical-equilibrium check (embedded shaft friction only, base neglected) that must be confirmed against the real section. Axially-loaded piles are out of scope.</li>
					<li><strong>Passive resistance at the toe</strong> is computed from the EN 1997-1 Annex C closed form at M-factored strength / R1 = 1.0 — <strong>no lumped mobilisation factor</strong>. The unplanned over-dig Δa = min(0.10·H, 0.5 m) removes the top band (scour/future excavation), the front soil and overburden subdivide per CPT layer, and the value is the rigorous log-spiral coefficient for all δ (planar Coulomb passive was removed). Full passive needs large movement — verify SLS displacement separately, or disable the toe passive for a fully conservative design.</li>
					<li>Brinch-Hansen/Vesić depth factors are applied to the Annex D bearing check <strong>by default</strong> (Annex D itself omits them; untick “Bearing depth factors” for the strict, more conservative Annex-D form). The cantilever uses the virtual-plane Rankine idealisation; for a <strong>short heel</strong> (heel below H<sub>v</sub>/tan(45°+φ′<sub>d</sub>/2)) the active wedge is interrupted by the stem, so the engine flags it at runtime and recommends a Coulomb-on-stem cross-check.</li>
					<li><strong>Deliberate conservative simplifications</strong> (all err safe): the base uplift uses a linear head toe→heel (no flow net); the resisting front-water thrust and the shear-key passive block are neglected; the passive vertical drag R<sub>p,v</sub> = R<sub>p,h</sub>·tan δ<sub>p</sub> is reported but not credited to vertical equilibrium; and the unplanned over-dig removes the top band of front soil so the passive starts at zero effective stress at the design dig level.</li>
					<li>Embedded-wall embedment uses the simplified free-earth / Blum method (conservative); SLS wall displacement and passive mobilisation are not computed.</li>
					<li>No Belgian-codified minimum backfill surcharge exists. Gravity/cantilever walls use a prudent default surcharge that is fully editable; <strong>embedded walls additionally enforce a 10 kPa minimum variable surcharge floor</strong> (UK/CIRIA practice) — entering a lower value is honoured for gravity walls but floored at 10 kPa for embedded walls.</li>
					<li>The in-situ / foundation profile is modelled as the full layered CPT stratigraphy — σ′<sub>v</sub> continuous, K and cohesion per layer — on both embedded faces and for the gravity/cantilever foundation, passive toe and overburden. The retained fill behind a gravity/cantilever wall is a single engineered backfill material (placed fill is uniform by design); a layered retained profile for walls retaining natural ground is a planned extension.</li>
						<li>Hydraulic limit states are verified: <strong>HYD</strong> heave/piping for embedded walls (conservative exit gradient — confirm with a flow net for stratified ground) and <strong>UPL</strong> flotation for gravity walls. SLS is limited to the bearing-resultant middle-third / eccentricity; settlement, tilt and embedded-wall deflection (SSI/FE) are not yet automated and remain the engineer's responsibility.</li>
					<li>The partial factors and equations were verified against the EN/ANB recommended values and multiple independent sources; for a stamped design every National-Annex value must still be confirmed against the controlled standards (NBN EN 1997-1 ANB, NBN EN 1992-1-1 ANB:2010, Buildwise).</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>10. Reference basis</h2>
				<ul class="reference-list">
					<li><strong>EN 1997-1:2004 (Eurocode 7) &amp; NBN EN 1997-1 ANB</strong> — geotechnical design; Design Approach 1, partial-factor sets A1/A2, M1/M2, R1, and the Belgian National Annex values.</li>
					<li><strong>EN 1990 &amp; NBN EN 1990 ANB</strong> — basis of structural design; action combinations 6.10 / 6.10a-b, ψ factors, consequence-class K<sub>FI</sub>.</li>
					<li><strong>EN 1992-1-1 &amp; NBN EN 1992-1-1 ANB:2010</strong> — concrete design parameters referenced for structural-force interpretation.</li>
					<li><strong>EN 1993-5</strong> — design of steel sheet piles (section resistance, referenced for the structural force context).</li>
					<li><strong>Bond, A. &amp; Harris, A.</strong> <em>Decoding Eurocode 7.</em> Taylor &amp; Francis, 2008 — worked-example basis for the DA1 retaining-wall verification recipes.</li>
					<li><strong>EN 1997-1:2004 Annex C</strong> (Brinch-Hansen log-spiral) — the closed-form active/passive coefficients (eqs C.3–C.9) the engine evaluates for passive resistance. <strong>Kérisel, J. &amp; Absi, E.</strong> <em>Tables for the Calculation of Passive Pressure…</em> Gauthier-Villars — retained only as an independent cross-check of the closed form.</li>
					<li><strong>Coulomb (1776), Rankine (1857)</strong> — classical earth-pressure theory; <strong>Blum (1931)</strong> — embedded-wall equivalent-beam method.</li>
					<li><strong>CIRIA C760</strong> — guidance on embedded retaining walls (over-dig, passive mobilisation, hydraulic checks) used for context.</li>
					<li><strong>Buildwise (WTCB/CSTC)</strong> — Belgian embedded-wall guideline (March 2022), provided as the optional risk-class overlay.</li>
				</ul>
				<p class="refs-inline">
					The partial-factor tables (§2), earth-pressure equations (§3) and verification
					recipes (§4–§6) on this page are the complete methodology the application implements;
					the assumptions and limitations are listed in full in §8. For a stamped design,
					confirm each National-Annex value against the controlled NBN EN 1997-1 ANB,
					NBN EN 1992-1-1 ANB and Buildwise texts.
				</p>
			</section>
		</main>
	</div>
</div>
