<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';

	const pageTitle = 'Soldier-Pile (Berliner) Walls — MADEP CPT Interpreter';
	const pageDescription =
		'Technical chapter for the Stage 6 soldier-pile (Berliner wall, berlinerwand) application: hybrid lagging/discrete-pile idealisation, effective-width and Brinch Hansen (1961) resistance models with the Andersen–Lodahl (2023) term, the Belgian embedded-wall design branches, Blum embedment, lagging and EN 1993-1-1 section checks, vertical equilibrium, the PLAXIS 2D Plate + Embedded Beam Row parameter set, verification cases and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/soldier-pile';
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
			<p class="hero__eyebrow">Stage 6 / soldier-pile walls</p>
			<h1>Soldier-pile (Berliner) walls.</h1>
			<p class="hero__lead">
				The soldier-pile route (berlinerwand, beschoeiing met profielen en houten/stalen beschotting)
				verifies a wall of discrete H/I piles at spacing s with lagging between the flanges, cantilevered
				or singly anchored, under the <strong>Belgian embedded-wall design branches</strong> (BGGG/Buildwise
				2022 guideline on NBN EN 1997-1 ANB, Design Approach 1). Below the excavation the pile resistance is
				computed either with the <strong>effective-width</strong> hand method (EAB / Belgian guideline §5) or
				with the <strong>Brinch Hansen (1961)</strong> net line resistance including the
				<strong>Andersen–Lodahl (2023)</strong> retained-height term; the same Brinch Hansen coefficients
				produce the multilinear <strong>T<sub>lat</sub></strong> tables of the PLAXIS 2D Embedded Beam Row.
				The chapter also covers the lagging plate check, the EN 1993-1-1 section checks of the pile, the
				vertical equilibrium screen and the complete PLAXIS 2D parameter set in the format of the MADEP
				calculation note (Rekennota).
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Soldier-pile documentation navigation">
			<div class="docs-nav__title">Soldier piles</div>
			<a href="#scope">Scope and idealisation</a>
			<a href="#branches">Design branches</a>
			<a href="#pressures">Pressure model</a>
			<a href="#effwidth">Model A — effective width</a>
			<a href="#brinch">Model B — Brinch Hansen</a>
			<a href="#embedment">Embedment and diagrams</a>
			<a href="#structural">Lagging, section, vertical</a>
			<a href="#plaxis">PLAXIS 2D parameter set</a>
			<a href="#verified">Verified against</a>
			<a href="#limits">Assumptions and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and positioning</p>
				<h2>1. Analysis class and the hybrid idealisation</h2>
				<p>
					A soldier-pile wall is not a plane-strain wall. Above the excavation the lagging spans
					horizontally between the flanges and transfers the earth pressure of the whole tributary width
					<strong>s</strong> (centre-to-centre spacing) to the pile; below the excavation only the discrete
					pile of flange width <strong>b</strong> is in the ground and the passive resistance is
					three-dimensional. The engine therefore models the wall as a <strong>hybrid</strong>
					(<code>embedded_model.hpp</code>, kinds <code>SoldierEffWidth</code> and
					<code>SoldierBrinchHansen</code>):
				</p>
				<ul class="notes">
					<li><strong>Above the excavation:</strong> the retained-side ordinates (earth, variable surcharge, and water only when the lagging is declared watertight) are multiplied by the tributary width s. All quantities are <strong>per pile</strong> (kN/m of pile, kN, kNm).</li>
					<li><strong>Below the excavation — Model A, effective width:</strong> the active pressure acts on the flange width b and the passive resistance on b<sub>eff</sub> = min(k·b, s) with the plane-strain K<sub>p</sub> (EAB / Belgian guideline §5); k = 3 by default.</li>
					<li><strong>Below the excavation — Model B, Brinch Hansen:</strong> the net line resistance of one pile B·[e<sub>w</sub>(z)]⁺ from the Brinch Hansen (1961) coefficients K<sub>q</sub>(z/B), K<sub>c</sub>(z/B), with the Andersen–Lodahl (2023) additional active term for the higher retained side, optionally capped by the continuous-wall tributary resistance s·p<sub>net</sub>.</li>
					<li><strong>Never mixed:</strong> the hand calculation runs one of the two models; the PLAXIS Embedded Beam Row T<sub>lat</sub> tables are <em>always</em> Brinch Hansen with B = flange width, never divided by the spacing and never 3b (Rekennota §5.7; course chapter §8.3).</li>
				</ul>
				<p>
					Everything else — the four design branches, the over-excavation rule, the Blum embedment, the
					support reaction, the shear and moment diagrams and the anchor pull-out — is shared with the
					sheet-pile engine (<code>embedded_branches.hpp</code>, <code>embedded_solver.hpp</code>,
					<code>embedded_wall.hpp</code>) and documented in the
					<a href="/docs/engineering/retaining-wall">retaining-wall chapter</a>; this chapter repeats
					what the soldier-pile route needs and adds the pile-specific parts.
				</p>
				<div class="doc-callout">
					<strong>Outputs.</strong> Required embedment (GEO), M<sub>Ed</sub>, V<sub>Ed</sub>,
					T<sub>Ed</sub> per pile (STR envelope), the factored lagging pressure, the lagging plate
					check, the EN 1993-1-1 checks of the H/I section (class, M<sub>c,Rd</sub>, V<sub>pl,Rd</sub>,
					M–V), a vertical-equilibrium screen, and the PLAXIS 2D Plate + Embedded Beam Row parameter set
					(EA, EI, w, ISF, T<sub>skin</sub>, F<sub>max</sub>, T<sub>lat</sub>). It does not compute wall
					displacements (SSI/FE) and it does not verify the timber or the pile-to-lagging connection.
				</div>
			</section>

			<section id="branches" class="doc-card">
				<p class="section-label">Design framework</p>
				<h2>2. Design branches (Belgian guideline)</h2>
				<p>
					Embedded walls follow the risk-class (RK) workflow of the Belgian embedded-wall guideline
					(BGGG/Buildwise 2022, “Richtlijnen EC7 beschoeiingen”) as implemented in
					<code>embedded_branches.hpp</code>. Every analysis runs four branches and reports each with its
					full intermediate set:
				</p>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr><th>Branch</th><th>Actions</th><th>Strength</th><th>Excavation level</th><th>Role</th></tr>
							</thead>
							<tbody>
								<tr><td><strong>DA1/2</strong> (A2 + M2)</td><td>γ<sub>G</sub> = 1.00 both sides; γ<sub>Q</sub> of the risk class (1.10 RK1/RK2, 1.20 RK3; 1.30 generic ANB)</td><td>M2 of the risk class</td><td>design = nominal − Δa</td><td>governs the embedment (GEO)</td></tr>
								<tr><td><strong>DA1/1</strong> (A1 + M1)</td><td>γ<sub>G</sub> = 1.35 (RK2) on the retained-side actions, γ<sub>Q</sub> = 1.50; passive resistance and front water at γ<sub>G,fav</sub> = 1.00 (<em>separate source</em>, default) or at 1.35 (<em>single source</em>, EN 1997-1 §2.4.2(9)P)</td><td>M1</td><td>design = nominal − Δa</td><td>STR envelope; governs embedment only with the generic ANB sets</td></tr>
								<tr><td><strong>BGT + α<sub>ver</sub></strong></td><td>γ = 1.0; α<sub>ver</sub> = 1.10 on the variable surcharge</td><td>characteristic (M1)</td><td>nominal</td><td>section and support forces × 1.35 for STR</td></tr>
								<tr><td><strong>SLS</strong></td><td>γ = 1.0</td><td>characteristic (M1)</td><td>nominal</td><td>serviceability reference</td></tr>
							</tbody>
						</table>
					</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Factor sets (factors.hpp; γ never reduces the unit weight)</div>
					<dl class="symbols__list">
						<div class="symbols__row"><dt>Generic NBN EN 1997-1 ANB</dt><dd>A1 = [1.35, 1.00, 1.50, 0]; A2 = [1.00, 1.00, 1.30, 0]; M2 = [1.25, 1.25, 1.40, 1.00]; K<sub>FI</sub> = 0.90 / 1.00 / 1.10 (CC1/CC2/CC3) on the unfavourable actions — applied only with this scheme.</dd></div>
						<div class="symbols__row"><dt>RK1</dt><dd>A1 = [1.20 / 1.30], A2 = [1.00 / 1.10], M2 = [1.10, 1.10, 1.25].</dd></div>
						<div class="symbols__row"><dt>RK2 (default for embedded walls)</dt><dd>A1 = [1.35 / 1.50], A2 = [1.00 / 1.10], M2 = [1.25, 1.25, 1.40].</dd></div>
						<div class="symbols__row"><dt>RK3</dt><dd>A1 = [1.50 / 1.80], A2 = [1.00 / 1.20], M2 = [1.40, 1.40, 1.55].</dd></div>
						<div class="symbols__row"><dt>Material override</dt><dd>Optional replacement of M2 in DA1/2, e.g. the SB260 value γ<sub>φ</sub> = γ<sub>c</sub> = 1.30 (γ<sub>cu</sub> = 1.40) used in the Rekennota; also drives the “sensitivity” T<sub>lat</sub> table.</dd></div>
						<div class="symbols__row"><dt>STR envelope</dt><dd>M<sub>Ed</sub>, V<sub>Ed</sub>, T<sub>Ed</sub> and the lagging pressure = max over DA1/2, DA1/1 and 1.35 × (BGT + α<sub>ver</sub>) (guideline §3.5). SLS is reported, never enveloped.</dd></div>
					</dl>
				</div>
				<p><strong>Over-excavation Δa (overdiepte)</strong> — a ULS geometry assumption applied to the two ULS branches only; BGT + α<sub>ver</sub> and SLS use the nominal excavation (guideline §3.3). h is the retained height for a cantilever, or the height below the lowest support for an anchored wall; “under water” means the front water table lies above the nominal excavation.</p>
				<div class="equations">
					<div class="formula">Belgian (default):   Δa = 0.30 m (dry),   Δa = min(0.1·h, 0.5 m) (under water)</div>
					<div class="formula">EN 1997-1 §9.3.2.2:   Δa = min(0.1·h, 0.5 m)</div>
					<div class="formula">custom:   Δa = user value (≥ 0);   none:   Δa = 0</div>
					<div class="formula">toe elevation = nominal excavation − Δa − d<sub>provided</sub>   (the provided embedment counts below the design excavation)</div>
				</div>
				<div class="doc-callout">
					<strong>Model B and DA1/1.</strong> The Brinch Hansen net coefficient cannot separate the active
					from the passive part below the excavation. In DA1/1 the γ<sub>G</sub> = 1.35 factor is therefore
					applied to the retained-side load <em>above</em> the excavation and to the variable-surcharge part
					of the Andersen–Lodahl term; the net line resistance below the excavation carries
					γ<sub>G,fav</sub> (1.00 separate-source, 1.35 single-source). The engine prints this as a note.
				</div>
			</section>

			<section id="pressures" class="doc-card">
				<p class="section-label">Pressure model</p>
				<h2>3. Ordinates, widths and water</h2>
				<p>
					Design strengths are formed at source per branch (φ′<sub>d</sub> = atan(tan φ′<sub>k</sub>/γ<sub>φ</sub>),
					c′<sub>d</sub> = c′<sub>k</sub>/γ<sub>c</sub>, c<sub>u,d</sub> = c<sub>u,k</sub>/γ<sub>cu</sub>), then the
					per-layer coefficients: active Rankine on a vertical wall with δ = 0 (K<sub>a</sub>, K<sub>ac</sub> = 2√K<sub>a</sub>),
					passive from the EN 1997-1 Annex C closed form with δ<sub>p</sub> = (δ<sub>p</sub>/φ′)·φ′<sub>d</sub>
					(K<sub>p</sub>, K<sub>pc</sub>), and the Brinch Hansen constants of §5 at the design φ′. Undrained layers
					use K<sub>a</sub> = K<sub>p</sub> = 1, K<sub>ac</sub> = K<sub>pc</sub> = 2 on the <em>total</em> vertical stress with c<sub>u</sub>,
					and the φ → 0 Brinch Hansen limits. The vertical effective stress on each side is precomputed on a
					1 cm grid (<code>stress_profile.hpp</code>) so every ordinate query is O(1); σ′<sub>v</sub> is
					continuous across layer boundaries while K and c are read from the layer present at each depth.
				</p>
				<div class="symbols">
					<div class="symbols__title">Soldier-pile inputs and defaults (wall-state.js / request-builder.js)</div>
					<dl class="symbols__list">
						<div class="symbols__row"><dt>b, s</dt><dd>Flange width of the catalogue section (normal to the loading) and centre-to-centre spacing (default 1.00 m).</dd></div>
						<div class="symbols__row"><dt>k</dt><dd>Effective-width factor, b<sub>eff</sub> = min(k·b, s); default 3.</dd></div>
						<div class="symbols__row"><dt>δ<sub>p</sub>/φ′</dt><dd>Passive wall-friction ratio; default <strong>0</strong> for soldier piles (Rankine, as in the Rekennota; the Belgian guideline Table 4 caps a discontinuous wall at φ′<sub>k</sub>/3 straight and φ′<sub>k</sub>/2 curved), ⅔ for sheet piles.</dd></div>
						<div class="symbols__row"><dt>Surcharge floor</dt><dd>Explicit, visible minimum variable surcharge (default 10 kPa, a practice value — not a Belgian requirement); q<sub>var</sub> = max(q<sub>user</sub>, floor).</dd></div>
						<div class="symbols__row"><dt>Row cap</dt><dd>Model B cap by s·p<sub>net,continuous</sub>; on by default.</dd></div>
						<div class="symbols__row"><dt>Watertight lagging</dt><dd>Off by default (permeable lagging).</dd></div>
					</dl>
				</div>
				<p>Retained (active) face ordinate at elevation el, per unit area, unfactored (<code>activeOrdinate</code>):</p>
				<div class="equations">
					<div class="formula">σ<sub>ref</sub> = σ′<sub>v</sub>   (drained)      σ<sub>ref</sub> = σ′<sub>v</sub> + u   (undrained)</div>
					<div class="formula">p<sub>a</sub> = [K<sub>a</sub>·σ<sub>ref</sub> − K<sub>ac</sub>·c]⁺</div>
					<div class="formula">p<sub>surch</sub> = K<sub>a</sub>·q<sub>var</sub>     (variable, γ<sub>Q</sub>)</div>
					<div class="formula">u<sub>back</sub> = γ<sub>w</sub>·(WT<sub>ret</sub> − el)   below the retained water table (drained layers)</div>
					<div class="formula">tension crack (p<sub>a</sub> = 0, option on):   u<sub>crack</sub> = γ<sub>w</sub>·(surface − el)   above the phreatic line, else γ<sub>w</sub>·(surface − WT<sub>ret</sub>)   (EN 1997-1 §9.6(5)P)</div>
				</div>
				<p>σ′<sub>v</sub> on the retained side includes the permanent surcharge and, optionally, a retained berm or slope treated as an <strong>equivalent surcharge spread under 45°</strong> (Rekennota §7.3). This is an approximation, <em>not</em> EN 1997-1 Annex C sloping ground; Δh is the berm height, β its slope, γ the fill unit weight (top stratum by default), L = Δh/tan β:</p>
				<div class="equations">
					<div class="formula">q<sub>berm</sub>(z) = γ·tan β·z/2     (z ≤ L)</div>
					<div class="formula">q<sub>berm</sub>(z) = γ·Δh·(1 − L/(2z))     (z &gt; L)</div>
				</div>
				<p>Net terms handed to the solver, already multiplied by the acting width (positive pushes the pile toward the excavation):</p>
				<div class="equations">
					<div class="formula">above the excavation:   p<sub>earth</sub>·s,   p<sub>surch</sub>·s,   u<sub>back</sub>·s only if the lagging is watertight (else 0)</div>
					<div class="formula">below the excavation:   no water on either face (permeable lagging / flow around the pile)</div>
					<div class="formula">Model A:   p<sub>earth</sub>·b,   p<sub>surch</sub>·b   driving;   (K<sub>p</sub>·σ<sub>ref,f</sub> + K<sub>pc</sub>·c)·b<sub>eff</sub>   resisting</div>
					<div class="formula">Model B:   B·K<sub>q</sub><sup>A</sup>·q<sub>var</sub>   driving (variable);   T<sub>lat,perm</sub>(z)   resisting  (§5)</div>
					<div class="formula">factored drive = γ<sub>G</sub>·(p<sub>earth</sub> + u<sub>back</sub>) + γ<sub>Q</sub>·p<sub>surch</sub>;   factored resist = γ<sub>G,resist</sub>·(p<sub>resist</sub> + u<sub>front</sub>)</div>
				</div>
				<div class="doc-callout">
					<strong>Water assumption.</strong> With permeable lagging no water pressure is applied to the wall,
					which presumes free drainage through the lagging and a dewatered pit. When the retained water
					table lies above the design excavation the engine flags this as a <strong>binding execution
					condition</strong> (Rekennota §8.1). Tick “watertight lagging” to apply the hydrostatic thrust
					over the tributary width above the excavation.
				</div>
			</section>

			<section id="effwidth" class="doc-card">
				<p class="section-label">Hand calculation A</p>
				<h2>4. Effective-width model (EAB / Belgian guideline §5)</h2>
				<p>
					The conventional Berliner-wall hand calculation. Below the excavation the active earth pressure
					(and the variable surcharge) act on the flange width b; the passive resistance acts on an
					effective width b<sub>eff</sub> that accounts for the three-dimensional wedge in front of the
					pile, computed with the plane-strain passive coefficient:
				</p>
				<div class="equations">
					<div class="formula">b<sub>eff</sub> = min(k·b, s)     (k = 3 default)</div>
					<div class="formula">e<sub>a</sub>(z) = [K<sub>a</sub>·σ<sub>ref,b</sub> − K<sub>ac</sub>·c<sub>b</sub>]⁺·b + K<sub>a</sub>·q<sub>var</sub>·b</div>
					<div class="formula">e<sub>p</sub>(z) = [K<sub>p</sub>·σ<sub>ref,f</sub> + K<sub>pc</sub>·c<sub>f</sub>]⁺·b<sub>eff</sub>     (K<sub>p</sub>, K<sub>pc</sub> from EN 1997-1 Annex C with δ<sub>p</sub>)</div>
				</div>
				<p>
					σ<sub>ref,f</sub> is the front-side vertical stress from the design excavation level downward (a
					fresh stress profile starting at zero at the excavation). This is the model used for the
					Rekennota parity case in §9 (HEA180, k = 3, δ<sub>p</sub> = 0). It is the default hand
					model in the app.
				</p>
			</section>

			<section id="brinch" class="doc-card">
				<p class="section-label">Hand calculation B and PLAXIS T<sub>lat</sub></p>
				<h2>5. Brinch Hansen (1961) net line resistance</h2>
				<p>
					<code>brinch_hansen.hpp</code> is the single source of truth for the coefficients — the hand
					calculation and the PLAXIS Embedded-Beam-Row tables both use it. The ultimate net pressure around
					a rigid pile of width B at depth z below the excavation is e(z) = q̄(z)·K<sub>q</sub>(z/B) + c·K<sub>c</sub>(z/B),
					with the depth-dependent coefficients interpolated rationally between the surface and the
					great-depth values (Brinch Hansen 1961, DGI Bulletin 12, pp. 5–9). Angles in radians; φ is the
					design friction angle of the front layer.
				</p>
				<p>Surface coefficients (rough wall, translation):</p>
				<div class="equations">
					<div class="formula">P<sub>q</sub> = exp[(π/2 + φ)·tan φ]·cos φ·tan(45° + φ/2)</div>
					<div class="formula">K<sub>q</sub><sup>A</sup> = exp[−(π/2 − φ)·tan φ]·cos φ·tan(45° − φ/2)</div>
					<div class="formula">K<sub>q</sub>⁰ = P<sub>q</sub> − K<sub>q</sub><sup>A</sup></div>
					<div class="formula">K<sub>c</sub>⁰ = (P<sub>q</sub> − 1)·cot φ</div>
				</div>
				<p>Great-depth coefficients (Jáky K₀, deep depth factor d<sub>c</sub><sup>∞</sup>, bearing factors):</p>
				<div class="equations">
					<div class="formula">K₀ = 1 − sin φ</div>
					<div class="formula">d<sub>c</sub><sup>∞</sup> = 1.58 + 4.09·tan⁴φ</div>
					<div class="formula">N<sub>q</sub> = exp(π·tan φ)·tan²(45° + φ/2)</div>
					<div class="formula">N<sub>c</sub> = (N<sub>q</sub> − 1)·cot φ</div>
					<div class="formula">K<sub>c</sub><sup>∞</sup> = N<sub>c</sub>·d<sub>c</sub><sup>∞</sup></div>
					<div class="formula">K<sub>q</sub><sup>∞</sup> = K<sub>c</sub><sup>∞</sup>·K₀·tan φ</div>
				</div>
				<p>Interpolation parameters and depth-dependent coefficients (ξ = z/B ≥ 0):</p>
				<div class="equations">
					<div class="formula">a<sub>q</sub> = K<sub>q</sub>⁰ / (K<sub>q</sub><sup>∞</sup> − K<sub>q</sub>⁰) · K₀·sin φ / sin(45° + φ/2)     (0 if K<sub>q</sub><sup>∞</sup> ≤ K<sub>q</sub>⁰)</div>
					<div class="formula">a<sub>c</sub> = K<sub>c</sub>⁰ / (K<sub>c</sub><sup>∞</sup> − K<sub>c</sub>⁰) · 2·sin(45° + φ/2)     (0 if K<sub>c</sub><sup>∞</sup> ≤ K<sub>c</sub>⁰)</div>
					<div class="formula">K<sub>q</sub>(ξ) = (K<sub>q</sub>⁰ + K<sub>q</sub><sup>∞</sup>·a<sub>q</sub>·ξ) / (1 + a<sub>q</sub>·ξ)</div>
					<div class="formula">K<sub>c</sub>(ξ) = (K<sub>c</sub>⁰ + K<sub>c</sub><sup>∞</sup>·a<sub>c</sub>·ξ) / (1 + a<sub>c</sub>·ξ)</div>
				</div>
				<p>φ → 0 limits (used for φ &lt; 10⁻⁴ rad, i.e. undrained φ<sub>u</sub> = 0 layers; Brinch Hansen 1961, course chapter §3.7):</p>
				<div class="equations">
					<div class="formula">P<sub>q</sub> = K<sub>q</sub><sup>A</sup> = 1,   K<sub>q</sub>⁰ = K<sub>q</sub><sup>∞</sup> = 0,   a<sub>q</sub> = 0   ⇒   K<sub>q</sub> ≡ 0</div>
					<div class="formula">K<sub>c</sub>⁰ = 1 + π/2 = 2.5708,   K₀ = 1,   d<sub>c</sub><sup>∞</sup> = 1.58,   N<sub>q</sub> = 1,   N<sub>c</sub> = π + 2 = 5.1416</div>
					<div class="formula">K<sub>c</sub><sup>∞</sup> = N<sub>c</sub>·d<sub>c</sub><sup>∞</sup> = 8.1237,   a<sub>c</sub> = K<sub>c</sub>⁰/(K<sub>c</sub><sup>∞</sup> − K<sub>c</sub>⁰)·2·sin 45° = 0.6547</div>
				</div>
				<p>
					<strong>Net line resistance of one pile</strong> (<code>brinchHansenOrdinate</code>), z measured from
					the branch's design excavation, B = flange width b, σ<sub>ref,f</sub> the front-side vertical stress
					(effective, or total for undrained layers), and Δq the retained-minus-front vertical-stress
					difference at the same elevation — layered, including the berm equivalent surcharge and the
					permanent surcharge — times the shallow active coefficient (Andersen &amp; Lodahl 2023, eq. 2–3;
					course chapter eq. 5):
				</p>
				<div class="equations">
					<div class="formula">e<sub>equal</sub>(z) = σ<sub>ref,f</sub>·K<sub>q</sub>(z/B) + c·K<sub>c</sub>(z/B)     (equal-level convention, Rekennota Table 5-7)</div>
					<div class="formula">Δq = [σ<sub>ref,b</sub> − σ<sub>ref,f</sub>]⁺   (+ q<sub>var</sub> in the T<sub>lat</sub> tables)</div>
					<div class="formula">e<sub>w</sub>(z) = e<sub>equal</sub>(z) − Δq·K<sub>q</sub><sup>A</sup>     (Andersen–Lodahl convention)</div>
					<div class="formula">T<sub>lat,perm</sub>(z) = B·[e<sub>w</sub>(z)]⁺     [kN/m of pile]</div>
					<div class="formula">p<sub>net,cont</sub> = (K<sub>p</sub>·σ<sub>ref,f</sub> + K<sub>pc</sub>·c<sub>f</sub>) − [K<sub>a</sub>·σ<sub>ref,b</sub> − K<sub>ac</sub>·c<sub>b</sub>]⁺     (continuous wall, per unit width)</div>
					<div class="formula">row cap:   T<sub>lat</sub> ≤ s·[p<sub>net,cont</sub>]⁺     (the tributary strip cannot supply more than the continuous wall)</div>
					<div class="formula">hand calculation, driving side:   B·K<sub>q</sub><sup>A</sup>·q<sub>var</sub>   (variable surcharge part of the A–L term, γ<sub>Q</sub>)</div>
				</div>
				<div class="doc-callout">
					<strong>Two conventions, one choice.</strong> The Rekennota Table 5-7 enters the equal-level value
					B·(σ′<sub>v</sub>K<sub>q</sub> + c′K<sub>c</sub>) as the PLAXIS T<sub>lat</sub>; the course chapter
					and Andersen &amp; Lodahl (NUMGE 2023) define the Embedded-Beam-Row cap as B·[e<sub>w</sub>]⁺ with the
					−(γ′H + p<sub>b</sub>)·K<sub>q</sub><sup>A</sup> term. For the Rekennota case the difference is
					≈ 2.4 kN/m per pile over the first 2 m (5–45 %). The engine tabulates both columns side by side;
					the hand calculation uses the Andersen–Lodahl form, the PLAXIS export defaults to it, and the
					engineer must pick and justify (worklog review E-7). The positive-part operator, the row cap and
					the rule to recompute T<sub>lat</sub> at φ<sub>d</sub> are the chapter's implementation rules, not
					Brinch Hansen's.
				</div>
			</section>

			<section id="embedment" class="doc-card">
				<p class="section-label">Limit equilibrium</p>
				<h2>6. Blum embedment, support reaction and diagrams</h2>
				<p>
					The solver (<code>embedded_solver.hpp</code>) is idealisation-agnostic: it only sees the factored
					net terms of §3. The net pressure is integrated over 800 cells from the retained surface to the
					trial toe.
				</p>
				<div class="equations">
					<div class="formula">ODF(d) = |M<sub>resist</sub>| / |M<sub>drive</sub>|   about the toe (cantilever) or about the anchor (anchored)</div>
					<div class="formula">d₀:   ODF(d₀) = 1   by bisection on [0.05 m, 40 m], 60 halvings   (not bracketed within 40 m → flagged)</div>
					<div class="formula">cantilever:   d<sub>design</sub> = 1.2·d₀     (Blum 1931; Rekennota §7.4 — the 20 % is part of the method, not an EC7 factor)</div>
					<div class="formula">anchored:   d<sub>design</sub> = d₀   (free-earth support),   T = H<sub>drive</sub> − H<sub>resist</sub> at d₀   (≥ 0)</div>
					<div class="formula">GEO:   d<sub>provided</sub> ≥ d<sub>required</sub> = max d<sub>design</sub> over the branches that govern the embedment   (DA1/2; also DA1/1 with the generic ANB sets)</div>
				</div>
				<p>Shear and moment on the <em>provided</em> pile by trapezoidal double integration on 600 cells (course manual eq. 21–22); the anchor reaction enters as a shear jump −T at its exact elevation:</p>
				<div class="equations">
					<div class="formula">V ← V + ½·(net<sub>i−1</sub> + net<sub>i</sub>)·dz,   M ← M + ½·(V<sub>i−1</sub> + V<sub>i</sub>)·dz     (anchor: V ← V − T)</div>
					<div class="formula">M<sub>max</sub> = largest |M| at a zero-shear crossing inside the model-valid depth (≤ H + d₀ + tol), else max |M|</div>
					<div class="formula">beyond the last moment zero-crossing (free-earth closure) V and M are set to 0 — the tail diverges by construction</div>
					<div class="formula">M<sub>Ed</sub> = M<sub>max</sub>·f<sub>effect</sub>,   V<sub>Ed</sub> = V<sub>max</sub>·f<sub>effect</sub>,   T<sub>Ed</sub> = T·f<sub>effect</sub>     (f<sub>effect</sub> = 1.35 for BGT + α<sub>ver</sub>, else 1)</div>
				</div>
				<p>
					For an anchored soldier pile the EN 1537 pull-out check of the
					<a href="/docs/engineering/retaining-wall">retaining-wall chapter</a> is applied with the
					reaction converted to a per-metre value T/s before the per-anchor axial force
					(T/s)/cos α · s<sub>anchor</sub> is formed. The HYD heave check and the wall vertical screening
					of continuous walls are not run for soldier piles; the pile's own vertical equilibrium is
					checked in §7.
				</p>
			</section>

			<section id="structural" class="doc-card">
				<p class="section-label">Structural verifications</p>
				<h2>7. Lagging, EN 1993-1-1 section checks, vertical equilibrium</h2>
				<p><strong>Lagging design pressure</strong> (<code>laggingPressureAt</code>, course/Rekennota §7.8) — the factored horizontal pressure on the deepest lagging board, at the branch's excavation level, enveloped over the non-SLS branches:</p>
				<div class="equations">
					<div class="formula">p<sub>Ed</sub> = f<sub>effect</sub>·[γ<sub>G</sub>·(K<sub>a</sub>σ<sub>ref</sub> − K<sub>ac</sub>c)⁺ + γ<sub>Q</sub>·K<sub>a</sub>·q<sub>var</sub> + γ<sub>G</sub>·u (watertight only)]   at z = design excavation of the branch</div>
				</div>
				<p><strong>Lagging plate</strong> (<code>steel-checks.js</code>, <code>checkLaggingPlate</code>) — a steel plate of thickness t spanning horizontally between the flanges; span L = s (centre-to-centre, conservative, default) or the clear span s − b (min 0.05 m); per metre height; elastic by default:</p>
				<div class="equations">
					<div class="formula">M<sub>Ed</sub> = p<sub>Ed</sub>·L²/8     [kNm/m]</div>
					<div class="formula">W<sub>el</sub> = t²/6,   W<sub>pl</sub> = t²/4     [m³/m]</div>
					<div class="formula">M<sub>Rd</sub> = W·f<sub>y</sub>/γ<sub>M0</sub>   (W<sub>el</sub> elastic default, W<sub>pl</sub> plastic option),   σ = M<sub>Ed</sub>/W<sub>el</sub></div>
					<div class="formula">δ = 5·p<sub>k</sub>·L⁴ / (384·EI),   EI = E·t³/12     (characteristic pressure p<sub>k</sub>, informational)</div>
				</div>
				<p><strong>H/I pile section</strong> (<code>hSectionClass</code>, <code>checkHPile</code>) — NBN EN 1993-1-1 with the ANB γ<sub>M0</sub> = 1.00; E = 210 000 N/mm², γ<sub>steel</sub> = 78.5 kN/m³, f<sub>y</sub> per EN 10025-2 (S235/S275/S355 for t ≤ 40 mm). Section properties come from the EN 10365 catalogue (90 HEA/HEB/HEM/IPE profiles; A<sub>v,z</sub> is the catalogue shear area for η = 1.2).</p>
				<div class="equations">
					<div class="formula">ε = √(235/f<sub>y</sub>)</div>
					<div class="formula">flange:   c/t = [(b − t<sub>w</sub> − 2r)/2] / t<sub>f</sub>   ≤ 9ε (class 1), 10ε (2), 14ε (3), else 4     (Table 5.2, outstand in compression)</div>
					<div class="formula">web:   c/t = (h − 2t<sub>f</sub> − 2r) / t<sub>w</sub>   ≤ 72ε (1), 83ε (2), 124ε (3), else 4     (Table 5.2, web in bending)</div>
					<div class="formula">class = max(flange, web)</div>
					<div class="formula">M<sub>pl,Rd</sub> = W<sub>pl,y</sub>·f<sub>y</sub>/γ<sub>M0</sub>,   M<sub>el,Rd</sub> = W<sub>el,y</sub>·f<sub>y</sub>/γ<sub>M0</sub>;   M<sub>c,Rd</sub> = M<sub>pl,Rd</sub> (class 1–2) or M<sub>el,Rd</sub> (class 3)     (§6.2.5)</div>
					<div class="formula">V<sub>pl,Rd</sub> = A<sub>v,z</sub>·(f<sub>y</sub>/√3)/γ<sub>M0</sub>     (§6.2.6)</div>
					<div class="formula">M–V:   no reduction if V<sub>Ed</sub> ≤ 0.5·V<sub>pl,Rd</sub>;   else ρ = (2V<sub>Ed</sub>/V<sub>pl,Rd</sub> − 1)²,   M<sub>y,V,Rd</sub> = [W<sub>pl,y</sub> − ρ·A<sub>w</sub>²/(4t<sub>w</sub>)]·f<sub>y</sub>/γ<sub>M0</sub>,   A<sub>w</sub> = (h − 2t<sub>f</sub>)·t<sub>w</sub>     (§6.2.8(5))</div>
					<div class="formula">N<sub>pl,Rd</sub> = A·f<sub>y</sub>/γ<sub>M0</sub>     (reported)</div>
				</div>
				<p>The elastic bending check is always printed as a control row next to the plastic one. For continuous sheet piles the same module applies EN 1993-5 §5.2.2 (β<sub>B</sub>·W<sub>pl</sub> or W<sub>el</sub>; shear area Σ webs per metre × t<sub>w</sub>·(h − t<sub>f</sub>) with the <strong>web inclination neglected — conservative</strong>; M–V interaction at 0.5·V<sub>pl,Rd</sub>); an optional uniform corrosion loss is applied as a plain reduction factor on the thickness-driven properties.</p>
				<p><strong>Vertical equilibrium of one pile</strong> (<code>checkVerticalEquilibrium</code>, EN 1997-1 §9.7.5; Rekennota §7.10) — self-weight (plus the anchor down-drag T·tan α when present) against the β-method shaft resistance of §8 integrated over the embedment; base resistance is not credited:</p>
				<div class="equations">
					<div class="formula">G = w<sub>pile</sub>·L<sub>pile</sub> + γ<sub>steel</sub>·t<sub>lagging</sub>·H<sub>lagging</sub>·s + V<sub>extra</sub></div>
					<div class="formula">R<sub>s</sub> = slope·d² / 2     (slope = dT<sub>skin</sub>/dz′ of §8, uniform γ below the excavation)</div>
					<div class="formula">pass:   G ≤ R<sub>s</sub></div>
				</div>
			</section>

			<section id="plaxis" class="doc-card">
				<p class="section-label">PLAXIS 2D input</p>
				<h2>8. PLAXIS 2D (v24) parameter set</h2>
				<p>
					<code>plaxis-parameters.js</code> derives the values the engineer copies into the calculation
					note, following the hybrid model of Andersen &amp; Lodahl (NUMGE 2023) and the Rekennota §5:
					a <strong>Plate</strong> from the pile head to the design excavation and a <strong>user-defined
					Embedded Beam Row</strong> below it. E = 210·10⁶ kN/m², γ<sub>steel</sub> = 78.5 kN/m³ unless
					overridden. A<sub>p</sub>, I<sub>p</sub> are the catalogue properties of one pile.
				</p>
				<p><strong>Plate above the excavation</strong> (per metre of wall):</p>
				<div class="equations">
					<div class="formula">EA₁ = EA₂ = E·A<sub>p</sub>/s     [kN/m]</div>
					<div class="formula">EI = E·I<sub>p</sub>/s     [kNm²/m]   (lagging stiffness omitted: EI<sub>lagging</sub> = E·t³/12 ≪ profile and no composite action)</div>
					<div class="formula">w = γ<sub>steel</sub>·(A<sub>p</sub>/s + t<sub>lagging</sub>)     [kN/m/m]   (the lagging self-weight IS included)</div>
					<div class="formula">ν = 0     (wall of discrete elements; PLAXIS reference manual)</div>
					<div class="formula">d<sub>eq</sub> = √(12·I<sub>p</sub>/A<sub>p</sub>)     (independent of s; computed by PLAXIS)</div>
					<div class="formula">interfaces both sides,   R<sub>inter</sub> = tan δ / tan φ′   per layer (clamped to [0.01, 1]),   Rayleigh damping 0 (static)</div>
				</div>
				<p><strong>Embedded Beam Row below the excavation</strong> (properties of ONE pile — never divided by the spacing; PLAXIS smears the row itself):</p>
				<div class="equations">
					<div class="formula">L<sub>spacing</sub> = s;   A = A<sub>p</sub>;   I = I<sub>p</sub>;   E</div>
					<div class="formula">γ<sub>eff</sub> = γ<sub>steel</sub> − γ<sub>soil</sub>     (the row occupies no soil volume)</div>
					<div class="formula">D<sub>eq</sub> = √(12·I/A)</div>
					<div class="formula">ISF<sub>RS</sub> = ISF<sub>RN</sub> = 2.5·(L<sub>spacing</sub>/D<sub>eq</sub>)<sup>−0.75</sup>,   ISF<sub>KF</sub> = 25·(L<sub>spacing</sub>/D<sub>eq</sub>)<sup>−0.75</sup>     (PLAXIS 2D reference-manual defaults — a mismatch means A, I or L<sub>spacing</sub> were mistyped)</div>
					<div class="formula">continuity at the transition:   EI/s of the plate = E·I<sub>p</sub>/s of the row</div>
				</div>
				<p><strong>Axial skin resistance, linear (β-method, Rekennota §5.5)</strong> — K = K₀ = 1 − sin φ′<sub>k</sub> by default (the lower bound of the allowed installation methods: pre-augering with backfill), steel–soil friction δ = ⅔·φ′<sub>k</sub> on the outer flange faces O<sub>steel</sub> = 2b, soil–soil shear at φ′<sub>k</sub> on the plug faces O<sub>plug</sub> = 2h between the flanges; z′ from the design excavation:</p>
				<div class="equations">
					<div class="formula">T<sub>skin</sub>(z′) = σ′<sub>v</sub>(z′)·K·[O<sub>steel</sub>·tan δ + O<sub>plug</sub>·tan φ′<sub>k</sub>]     [kN/m]</div>
					<div class="formula">slope = K·[…]·γ     [kN/m per m]   (uniform γ below the excavation — a simplification when layered)</div>
					<div class="formula">T<sub>skin,start,max</sub> = 1.0 kN/m   (numerical floor at z′ = 0),   T<sub>skin,end,max</sub> = slope·d   at z′ = d</div>
					<div class="formula">R<sub>s</sub> = slope·d²/2</div>
				</div>
				<p><strong>Base resistance</strong> from the cone resistance near the toe (the least substantiated parameter of the set — a toe force approaching F<sub>max</sub> in the results requires a separate pile calculation under NBN EN 1997-1 ANB):</p>
				<div class="equations">
					<div class="formula">F<sub>max</sub> = α<sub>b</sub>·q<sub>c</sub>·A<sub>b</sub>,   A<sub>b</sub> = b·h (plugged box area),   α<sub>b</sub> = 0.5 default</div>
					<div class="formula">F<sub>max,unplugged</sub> = q<sub>c</sub>·A<sub>steel</sub>     (alternative, reported)</div>
				</div>
				<p><strong>Lateral resistance, multilinear T<sub>lat</sub></strong> (<code>buildTlatTable</code>) — rows every 0.25 m from the top of the row (= the ULS design excavation), plus every layer boundary inside the embedment (two rows, ± 0.1 mm) and the toe. Each row carries z, σ′<sub>v,f</sub>, Δq, K<sub>q</sub>, K<sub>c</sub>, K<sub>q</sub><sup>A</sup>, the equal-level value, the Andersen–Lodahl value, the row cap and the adopted value; the table is built with γ<sub>G</sub> = γ<sub>Q</sub> = 1 and Δq including the variable surcharge (representative loads). Three sets are produced:</p>
				<ul class="notes">
					<li><strong>Characteristic (M1)</strong> — staged/SLS phases and the φ-c reduction.</li>
					<li><strong>Design (M2 of the risk class)</strong> — for an explicit DA1/2 plastic phase (T<sub>lat</sub> recomputed at φ<sub>d</sub>; the chapter's rule, prompted by the PLAXIS 2D T<sub>lat</sub> strength-reduction release note).</li>
					<li><strong>Sensitivity</strong> — only when a material override is active (e.g. γ<sub>φ</sub> = 1.30).</li>
				</ul>
				<div class="equations">
					<div class="formula">T<sub>adopted</sub>(z) = min(T<sub>AL</sub>, s·p<sub>net,cont</sub>)   (cap on)   or   T<sub>AL</sub>;   PLAXIS export: convention 'AL' (default) or 'equal', cap on/off</div>
					<div class="formula">R<sub>u</sub> = ∫ T<sub>adopted</sub> dz,   M<sub>u</sub> = ∫ T<sub>adopted</sub>·z dz,   z̄ = M<sub>u</sub>/R<sub>u</sub>     (trapezoidal, kN and kNm per pile about the row top)</div>
				</div>
				<p>For a <strong>continuous sheet pile</strong> the same module returns the Plate set per metre of wall (course manual §8.4; Bentley KB): EA₁ = E·A, EI = E·I, w = mass per m² × g, M<sub>p</sub> = f<sub>y</sub>·W<sub>pl</sub> and N<sub>p</sub> = f<sub>y</sub>·A as numerical yield caps (not an EN 1993-5 verification), d<sub>eq</sub> = √(12EI/EA), ν = 0 (no out-of-plane plate action for a corrugated section), EA₂ only from interlock tests (EA₁/20 is illustrative), “prevent punching” off.</p>
			</section>

			<section id="verified" class="doc-card">
				<p class="section-label">Verification</p>
				<h2>9. Verified against</h2>
				<p>
					The native test suite (<code>src/wasm/retaining/test_native.cpp</code>) and the Node script
					<code>scripts/verify_retaining_sections_plaxis.mjs</code> reproduce the worked examples of the
					course chapter and of the MADEP Rekennota “beschoeiing berlinerwand HEA180” (h.o.h. 1.00 m,
					S235, lagging 10 mm). All checks pass within the stated tolerances.
				</p>
				<ul class="notes">
					<li><strong>Brinch Hansen constants, φ = 20.5°</strong> (course §7.3, 6 decimals): P<sub>q</sub> = 2.776880, K<sub>q</sub><sup>A</sup> = 0.412869, K<sub>q</sub>⁰ = 2.364011, K<sub>c</sub>⁰ = 4.752482, K₀ = 0.649793, d<sub>c</sub><sup>∞</sup> = 1.659923, N<sub>c</sub> = 15.314396, K<sub>c</sub><sup>∞</sup> = 25.420725, K<sub>q</sub><sup>∞</sup> = 6.175902, a<sub>q</sub> = 0.171761, a<sub>c</sub> = 0.377861; K<sub>q</sub>(z/B = 10) = 4.7732, K<sub>q</sub>(14) = 5.0563.</li>
					<li><strong>φ = 25°</strong> (Rekennota Table 5-6): K<sub>q</sub>⁰ = 3.2869, K<sub>c</sub>⁰ = 5.6339, K<sub>q</sub><sup>∞</sup> = 9.8932, K<sub>c</sub><sup>∞</sup> = 36.7454, a<sub>q</sub> = 0.14395, a<sub>c</sub> = 0.30545. <strong>φ = 0</strong>: K<sub>c</sub>⁰ = 2.5708, K<sub>c</sub><sup>∞</sup> = 8.1237, a<sub>c</sub> = 0.6547, K<sub>q</sub> ≡ 0.</li>
					<li><strong>Rekennota Blum, Model A</strong> (HEA180, b = 0.180 m, s = 1.00 m, k = 3, φ′<sub>k</sub> = 25°, γ = 19.5 kN/m³, berm 1.577 m at 45°, δ<sub>p</sub> = 0, Δa = 0.30 m, γ<sub>φ</sub> = γ<sub>c</sub> = 1.30): φ<sub>red</sub> = 19.733°, K<sub>a</sub> = 0.4952, K<sub>p</sub> = 2.0195, design excavation 69.300, σ′<sub>v,a</sub> at H<sub>d</sub> = 55.46 kPa, <strong>t₀ = 3.539 m</strong>, <strong>D<sub>req</sub> = 1.2·t₀ = 4.247 m</strong> against 4.484 m provided (UC 0.947); with RK2 γ<sub>φ</sub> = 1.25: t₀ = 3.431 m. DA1/1 (separate source, passive at 1.00): t₀ = 3.346 m, <strong>M<sub>Ed</sub> = 57.6 kNm/pile</strong>, V<sub>Ed</sub> = 85.0 kN/pile, lagging p<sub>Ed</sub> = 30.39 kPa.</li>
					<li><strong>T<sub>lat</sub> tables</strong> (c′ = 0.5 kPa, equal-level rows): characteristic z = 1 m: K<sub>q</sub> = 6.223, K<sub>c</sub> = 25.210, T = 24.11 kN/m; z = 3 m: 86.56 kN/m; γ<sub>φ</sub> = 1.30 at z = 1 m: 15.10 kN/m; the row cap reproduces K<sub>p</sub>σ′<sub>v</sub>s minus the active term; last row at the toe z = 4.484 m.</li>
					<li><strong>HEA180 section and EN 1993-1-1</strong>: A = 45.25 cm², I<sub>y</sub> = 2510 cm⁴, W<sub>el,y</sub> = 293.6, W<sub>pl,y</sub> = 324.9 cm³, A<sub>v,z</sub> = 14.47 cm²; flange c/t = 7.58, web c/t = 20.33 → class 1; M<sub>pl,Rd</sub> = 76.35 kNm, M<sub>el,Rd</sub> = 69.00 kNm, V<sub>pl,Rd</sub> = 196.3 kN, N<sub>pl,Rd</sub> = 1063 kN; at M<sub>Ed</sub> = 57.64 kNm, V<sub>Ed</sub> = 85.03 kN: UC 0.755 (plastic) / 0.835 (elastic) / 0.433 (shear), V/(0.5V<sub>pl,Rd</sub>) = 0.866 → no M–V reduction.</li>
					<li><strong>PLAXIS Plate</strong>: EA = 9.503·10⁵ kN/m, EI = 5271 kNm²/m, d<sub>eq</sub> = 0.2580 m, w = 1.140 kN/m/m (0.355 profile + 0.785 lagging), EI<sub>lagging</sub> = 17.5 kNm²/m, ν = 0. <strong>EBR</strong>: γ<sub>eff</sub> = 59.0 kN/m³, L/D<sub>eq</sub> = 3.876, ISF<sub>RS</sub> = ISF<sub>RN</sub> = 0.905, ISF<sub>KF</sub> = 9.050 (HEA240 at 1.5 m: 0.8360 / 8.361). <strong>T<sub>skin</sub></strong>: K₀ = 0.5774, T<sub>skin</sub>/σ′<sub>v</sub> = 0.15431 m, slope 3.009 kN/m per m, T<sub>end</sub> = 13.49 kN/m, R<sub>s</sub> = 30.25 kN. <strong>F<sub>max</sub></strong> (q<sub>c</sub> = 3 MPa, α<sub>b</sub> = 0.5): A<sub>b</sub> = 0.03078 m², q<sub>b</sub> = 1500 kPa, F<sub>max</sub> = 46.2 kN (unplugged 13.6 kN).</li>
					<li><strong>Lagging 10 mm S235</strong> (p<sub>Ed</sub> = 30.39 kPa, p<sub>k</sub> = 22.51 kPa): M<sub>Ed</sub> = 3.798 kNm/m, σ = 227.9 N/mm², UC 0.970 elastic (0.646 plastic), δ ≈ 17 mm at L = 1.00 m; clear span 0.82 m: M<sub>Ed</sub> = 2.554, UC 0.652, δ ≈ 7.6 mm; 12 mm plate: σ = 158.3, UC 0.674. <strong>Vertical</strong>: G = 3.73 kN (Rekennota 3.78 with g ≈ 10), R<sub>s</sub> = 30.25 kN, UC 0.125.</li>
				</ul>
				<p>
					The course manual's sheet-pile branches (§6.2 SLS, §6.3 BGT + α<sub>ver</sub>, §6.4 DA1/2 with
					D = 3.568 m, T = 122.92 kN/m, M = 258.23 kNm/m) and its §4.3 cantilever illustration are
					reproduced by the same engine and are listed in the retaining-wall chapter.
				</p>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Assumptions and limitations</p>
				<h2>10. Documented assumptions</h2>
				<ul class="notes">
					<li>All soldier-pile quantities are per pile; the per-metre values of the anchor check are obtained by dividing by s.</li>
					<li>The effective-width factor k = 3 is the usual EAB / Belgian guideline value, not a code rule; Andersen &amp; Lodahl note that d/B ≈ 3 behaving as a full wall is a single granular case (course §2.1).</li>
					<li>Model B applies the row cap to the permanent part of the net resistance; the variable-surcharge part of the Andersen–Lodahl term is carried on the driving side with γ<sub>Q</sub>. The positive-part operator, the row cap and the recomputation at φ<sub>d</sub> are the course chapter's rules, not Brinch Hansen's.</li>
					<li>No water pressure below the excavation on either face and none above it unless the lagging is watertight; pore pressures are hydrostatic, no seepage.</li>
					<li>The berm/slope behind the wall is an equivalent surcharge averaged under a 45° spread (Rekennota §7.3) — conservative near the surface, not a rigorous sloping-ground earth-pressure solution.</li>
					<li>Cantilever embedment is the Blum simplified method (d₀ × 1.2); reported as “Blum simplified”, not as an EC7 verification of the toe reaction. Wall displacement, passive mobilisation and SSI are not computed.</li>
					<li>The β-method T<sub>skin</sub> uses a uniform γ below the excavation and K = K₀ (no installation increase); F<sub>max</sub> = α<sub>b</sub>·q<sub>c</sub>·A<sub>b</sub> is a preliminary value.</li>
					<li>The lagging check is for a steel plate in pure bending (M = pL²/8) with elastic W<sub>el</sub> by default; timber lagging, the plate-to-flange bearing and the connection are not verified.</li>
					<li>The soil profile is the interpreted CPT stratigraphy, vertically shifted to the wall datum (layers above the reference surface are cut off; a CPT ground level below the surface extends the uppermost layer upward, which is reported) with per-layer overrides of c′, φ′, γ, γ<sub>sat</sub>, c<sub>u</sub> and the drainage framework.</li>
					<li>Guideline-specific values (Table 4 wall-friction limits, over-dig wording, risk-class factors) must be confirmed against the controlled BGGG/Buildwise 2022 text for a stamped design.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>11. Reference basis</h2>
				<ul class="reference-list">
					<li><strong>Brinch Hansen, J.</strong> (1961). <em>The ultimate resistance of rigid piles against transversal forces.</em> Danish Geotechnical Institute, Bulletin No. 12, pp. 5–9 — surface and great-depth coefficients K<sub>q</sub>, K<sub>c</sub> and the rational interpolation.</li>
					<li><strong>Andersen, K. &amp; Lodahl, M.</strong> (2023). Soldier-pile walls in PLAXIS 2D: plate above / embedded beam row below the excavation. <em>Proc. NUMGE 2023</em>, doi <a href="https://doi.org/10.53243/NUMGE2023-25">10.53243/NUMGE2023-25</a> — the retained-height active term and the hybrid idealisation.</li>
					<li><strong>BGGG / Buildwise (WTCB/CSTC)</strong> (2022). <em>Richtlijnen EC7 beschoeiingen</em> — Belgian embedded-wall guideline: risk classes RK1–RK3, DA1/2 embedment, BGT + α<sub>ver</sub> structural route, over-excavation, wall-friction limits, effective width (§5).</li>
					<li><strong>EAB</strong> — Empfehlungen des Arbeitskreises “Baugruben” (DGGT): effective-width treatment of soldier piles below the excavation.</li>
					<li><strong>EN 1997-1:2004 &amp; NBN EN 1997-1 ANB</strong> — Design Approach 1, §2.4.2(9)P single-source principle, §9.3.2.2 over-excavation, §9.6(5)P tension-crack water, §9.7.5 vertical equilibrium, Annex C passive coefficients, Table A.12 anchors.</li>
					<li><strong>NBN EN 1993-1-1 + ANB</strong> — Table 5.2 classification, §6.2.5 bending, §6.2.6 shear, §6.2.8 M–V interaction; γ<sub>M0</sub> = 1.00. <strong>NBN EN 1993-5</strong> — sheet-pile section resistance (§5.2.2).</li>
					<li><strong>NBN EN 10365</strong> — hot-rolled H/I dimensions; catalogue values from eurocodeapplied.com cross-checked against the ArcelorMittal sales programme V2023-5 (≤ 0.1 % on section properties). <strong>EN 10025-2 / EN 10248</strong> — yield strengths.</li>
					<li><strong>Blum, H.</strong> (1931). <em>Einspannungsverhältnisse bei Bohlwerken</em> — equivalent-beam / free-earth embedment with the 20 % toe allowance.</li>
					<li><strong>Bentley Systems</strong>. <em>PLAXIS 2D Reference Manual</em> (v24) — Plate and Embedded Beam Row parameters, ISF defaults, d<sub>eq</sub>, ν for discrete walls; PLAXIS Knowledge Base “Material datasets for plates: sheet pile wall in bending” (KB0110039).</li>
					<li><strong>MADEP</strong>. <em>Rekennota beschoeiing berlinerwand HEA180</em> (v01) — the calculation-note format this route reproduces (§5 PLAXIS set, §5.7 “never mixed”, §7.3 berm, §7.4 Blum, §7.8 lagging, §7.10 vertical, §8.1 water).</li>
					<li><strong>Course texts</strong>: <em>Brinch Hansen T<sub>lat</sub> for soldier-pile walls</em> (Rev. 1) and <em>Sheet-pile retaining walls manual, EC7 / PLAXIS v24</em> (Rev. 1) — worked constants (φ = 20.5°) and the Belgian branch workflow, verified numerically (176/176 checks).</li>
				</ul>
				<p class="refs-inline">
					The coefficient set of §5 and the branch definitions of §2 are transcribed term-for-term from
					<code>brinch_hansen.hpp</code> and <code>embedded_branches.hpp</code>; the structural and PLAXIS
					formulas from <code>steel-checks.js</code>, <code>section-properties.js</code> and
					<code>plaxis-parameters.js</code>. Where a source could not be checked offline (PLAXIS release
					note on T<sub>lat</sub> strength reduction; guideline Table 4) the worklog review says so.
				</p>
			</section>
		</main>
	</div>
</div>
