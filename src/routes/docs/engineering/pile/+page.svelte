<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';

	const pageTitle = 'Pile Capacity — MADEP CPT Interpreter';
	const pageDescription =
		'Technical engineering chapter for the Stage 6 pile-capacity workflow: De Beer scale-effect base resistance, Belgian CPT-based shaft friction, ULS factor chain (γ_Rd, ξ_3 / ξ_4, γ_b, γ_s), negative skin friction screening, and SLS settlement via the Belgian load-transfer method.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/pile';
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
			<p class="hero__eyebrow">Stage 6 / pile capacity</p>
			<h1>Stage 6 axial pile capacity.</h1>
			<p class="hero__lead">
				The pile-capacity route is a CPT-based screen for the axial compression resistance and the
				serviceability settlement of a single pile founded in Belgian soils. It implements the four-stage
				De Beer scale-effect transformation for the unit base resistance, the Belgian η*<sub>p</sub>
				table for the unit shaft friction, the full Eurocode 7 / Belgian factor chain
				(γ<sub>Rd</sub>, ξ<sub>3</sub> / ξ<sub>4</sub>, γ<sub>b</sub>, γ<sub>s</sub>), a slip-method
				and analogy-method screening of negative skin friction, and the Allani–Huybrechts (2022)
				load-transfer model with hyperbolic t-z and q-z springs for the SLS settlement.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Pile documentation navigation">
			<div class="docs-nav__title">Pile</div>
			<a href="#scope">Scope and intent</a>
			<a href="#hierarchy">Belgian design hierarchy</a>
			<a href="#geometry">Pile geometry</a>
			<a href="#debeer">De Beer base resistance</a>
			<a href="#base">Base-resistance closure</a>
			<a href="#shaft">Shaft resistance and η*<sub>p</sub></a>
			<a href="#factors">Factor chain γ<sub>Rd</sub>, ξ, γ<sub>b</sub>, γ<sub>s</sub></a>
			<a href="#fnk">Negative skin friction</a>
			<a href="#sls">SLS settlement</a>
			<a href="#section">Interactive section view</a>
			<a href="#outputs">Outputs and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and intent</p>
				<h2>1. Problem class and engineering purpose</h2>
				<p>
					The pile route is an <strong>axial-compression ULS and SLS screen for a single pile</strong>
					founded on the interpreted CPT section. It is the deep-foundation counterpart of the bearing
					capacity chapter: shallow-foundation bearing resistance is replaced by the sum of pile-base
					resistance R<sub>b</sub> and pile-shaft resistance R<sub>s</sub>, both derived directly from
					the CPT q<sub>c</sub> profile through the Belgian semi-empirical method. The route reports the
					full ULS factor chain end-to-end and a load-transfer SLS settlement estimate against a
					user-defined allowable.
				</p>
				<div class="doc-callout">
					<strong>Model class.</strong> Single-pile axial compression under Eurocode 7 with the Belgian
					National Annex, Buildwise Dimensioneringsmethode 20 (DM20), and ATG-with-certification
					factors where available. Tension / uplift, lateral loading, seismic, buckling, pile-group
					settlement (equivalent raft), and structural pile design are out of scope for this screen.
				</div>
				<div class="symbols">
					<div class="symbols__title">Primary quantities</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>R<sub>b</sub>, R<sub>s</sub>, R<sub>c</sub></dt>
							<dd>Calculated pile base, shaft, and total compression resistance [kN].</dd>
						</div>
						<div class="symbols__row">
							<dt>R<sub>c,cal</sub>, R<sub>c,k</sub>, R<sub>c,d</sub></dt>
							<dd>Calibrated, characteristic, and design pile compression resistance [kN].</dd>
						</div>
						<div class="symbols__row">
							<dt>q<sub>b</sub></dt>
							<dd>Unit pile base resistance from the De Beer transformation [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>q<sub>s,i</sub></dt>
							<dd>Unit shaft friction in layer i [kPa].</dd>
						</div>
						<div class="symbols__row">
							<dt>F<sub>c,d</sub>, F<sub>rep</sub></dt>
							<dd>ULS design load and SLS representative load on the pile [kN].</dd>
						</div>
						<div class="symbols__row">
							<dt>F<sub>nk,d</sub></dt>
							<dd>Design negative-skin-friction load on the pile [kN].</dd>
						</div>
						<div class="symbols__row">
							<dt>s<sub>head</sub></dt>
							<dd>Pile-head settlement under F<sub>rep</sub> [mm].</dd>
						</div>
					</dl>
				</div>
			</section>

			<section id="hierarchy" class="doc-card">
				<p class="section-label">Hierarchy</p>
				<h2>2. Belgian design hierarchy</h2>
				<p>
					The pile route follows the Belgian design hierarchy stated in BUtgb-UBAtc Informatieblad
					2025/3 [1] and the Belgian practice report [3]:
				</p>
				<ol class="notes">
					<li>NBN EN 1997-1 with the Belgian National Annex (2022) [6]; NBN EN 1997-2:2007 with its
						national annex remains applicable in Belgium pending the ANB to NBN EN 1997-2:2024 [7].</li>
					<li>Buildwise Dimensioneringsmethode 20 (2020) [2] for the geotechnical ULS design of axially
						loaded piles and micropiles from CPTs.</li>
					<li>ATG-with-certification factors for the specific pile system, where available [1], [8].</li>
					<li>Project specifications such as Standaardbestek 260 (Flemish) [9] for execution and
						reporting; SB260 does not replace the geotechnical ULS calculation route.</li>
				</ol>
				<p>
					The screening tool ships with public DM20 factor tables as defaults. An ATG override block
					exposes user-entered α<sub>b</sub>, α<sub>s</sub>, γ<sub>Rd</sub>, and γ<sub>b</sub> for
					production calculations on systems with a current ATG. A static-load-test (SLT) selector
					switches the γ<sub>Rd</sub> row between γ<sub>Rd1</sub> (no SLT), γ<sub>Rd2</sub> (SLT in
					comparable conditions), and γ<sub>Rd3</sub> (SLT on the job site).
				</p>
			</section>

			<section id="geometry" class="doc-card">
				<p class="section-label">Geometry</p>
				<h2>3. Pile geometry</h2>
				<div class="equations">
					<div class="formula">A<sub>b</sub>,circular = π D<sub>b</sub>² / 4</div>
					<div class="formula">A<sub>b</sub>,square   = a²</div>
					<div class="formula">A<sub>b</sub>,rect     = a · b</div>
					<div class="formula">D<sub>b,eq</sub>,circular = D<sub>b</sub></div>
					<div class="formula">D<sub>b,eq</sub>,rect (b ≤ 1.5 a) = √(4 a b / π)</div>
					<div class="formula">D<sub>b,eq</sub>,rect (b &gt; 1.5 a) = √(6 a² / π)</div>
					<div class="formula">χ<sub>s</sub>,circular = π D<sub>s</sub>,    χ<sub>s</sub>,square = 4 a,    χ<sub>s</sub>,rect = 2 (a + b)</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>D<sub>s</sub>, D<sub>b</sub></dt>
							<dd>Pile shaft and base diameter (or equivalents) [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>D<sub>b,eq</sub></dt>
							<dd>Equivalent base diameter used in the De Beer transformation [m].</dd>
						</div>
						<div class="symbols__row">
							<dt>A<sub>b</sub>, A<sub>p</sub></dt>
							<dd>Base bearing area and pile axial-stiffness cross-section [m²]. They differ
								for open tubes and steel sections; closed concrete piles use A<sub>p</sub> = A<sub>b</sub>.</dd>
						</div>
						<div class="symbols__row">
							<dt>χ<sub>s</sub></dt>
							<dd>Shaft perimeter [m].</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>Open-ended tubes, sheet piles, plugged tubes, and steel profiles use DM20 / ATG-specific
						geometry rules and are out of scope for this screen.</li>
					<li>The pile head depth z<sub>head</sub> defaults to ground level but can be moved down for
						piles started in an excavation. The pile length is L = z<sub>toe</sub> − z<sub>head</sub>.</li>
				</ul>
			</section>

			<section id="debeer" class="doc-card">
				<p class="section-label">De Beer transformation</p>
				<h2>4. Unit base resistance q<sub>b</sub> — De Beer scale-effect method</h2>
				<p>
					The De Beer method is the Belgian standard procedure to convert the CPT q<sub>c</sub>
					profile into the unit pile-base resistance q<sub>b</sub> for a pile of equivalent diameter
					D<sub>b,eq</sub>. It is a four-stage algorithmic procedure described in [3] and detailed in
					the BGGG reference document [4]; it is <strong>not</strong> a single closed-form equation
					and must not be replaced by q<sub>c</sub> at the toe nor by a simple average over a
					depth window.
				</p>
				<p>
					The implementation resamples the raw q<sub>c</sub> profile from its native ~0.02 m
					sampling to 0.20 m bins (BGGG performs the calculation at exactly 0.20 m), then applies
					the four stages in order:
				</p>
				<div class="equations">
					<div class="formula">Stage 1 (homogeneous):  q<sub>h</sub>(z) = q<sub>c</sub>(z)</div>
					<div class="formula">Stage 2 (downward):  ratio = D<sub>c</sub> / D<sub>b,eq</sub>,  D<sub>c</sub> = 0.0357 m</div>
					<div class="formula">  if q<sub>h</sub>(z) ≤ q<sub>d</sub>(z − Δz):  q<sub>d</sub>(z) = q<sub>h</sub>(z)</div>
					<div class="formula">  else:  q<sub>d</sub>(z) = q<sub>d</sub>(z − Δz) + ratio · (q<sub>h</sub>(z) − q<sub>d</sub>(z − Δz))</div>
					<div class="formula">Stage 3 (upward):  symmetric, iterated from the deepest bin upward, with the same ratio</div>
					<div class="formula">Stage 4 (mixed):  q<sub>p</sub>(z) = min[ q<sub>d</sub>(z), q<sub>u</sub>(z) ]</div>
					<div class="formula">q<sub>b</sub> = linear interpolation of q<sub>p</sub> at z<sub>toe</sub></div>
				</div>
				<div class="doc-callout">
					<strong>Implementation note — Stage 1.</strong> The screening tool implements Stage 1 as
					the identity transformation q<sub>h</sub>(z) = q<sub>c</sub>(z). The full BGGG
					homogeneous-conversion equations are not in the public source set [3]; the diameter
					scale-effect is applied entirely through the Stages 2 and 3 gradient limits. Production
					calculations should use the BGGG / DM20 reference algorithm or audited software calibrated
					against the BGGG worked examples.
				</div>
				<div class="doc-callout">
					<strong>Implementation note — Stages 2 and 3.</strong> The fraction-of-the-gap form used
					here is a screening simplification of the BGGG gradient limit. The fraction equals the
					cone-to-pile diameter ratio D<sub>c</sub> / D<sub>b,eq</sub>, so a larger pile climbs more
					slowly into a strong layer. The implementation is verified against the BGGG worked
					examples to within 5 % relative error on q<sub>b</sub> (the BGGG examples are tabulated to
					0.1 MPa, which limits cross-check precision).
				</div>
				<ul class="notes">
					<li>Mechanical-cone q<sub>c</sub> values are reduced by the ω factors of [3] before the
						resampling step (ω = 1.30 for M1 and M2 in tertiary clay, 1.15 for M4 in tertiary
						clay, 1.00 elsewhere). The default cone is CPT-E (electric, ω = 1.00).</li>
					<li>If z<sub>toe</sub> is below the deepest CPT reading, the deepest layer's q<sub>c</sub>
						is used as a fall-back and a warning note flags the extrapolation.</li>
				</ul>
			</section>

			<section id="base" class="doc-card">
				<p class="section-label">Base resistance</p>
				<h2>5. Base-resistance closure</h2>
				<div class="equations">
					<div class="formula">R<sub>b</sub> = α<sub>b</sub> · e<sub>b</sub> · β · λ · A<sub>b</sub> · q<sub>b</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>α<sub>b</sub></dt>
							<dd>Installation factor for base resistance, by pile type and soil category.
								Defaults are screening values; production calculations must use DM20 / ATG values
								via the override block.</dd>
						</div>
						<div class="symbols__row">
							<dt>e<sub>b</sub></dt>
							<dd>Scale / fissuring factor. e<sub>b</sub> = 1.0 for most soils; for tertiary
								over-consolidated clay (Boom, Ypres):
								e<sub>b</sub> = max[0.476, 1 − 0.01 (D<sub>b,eq</sub> / D<sub>c</sub> − 1)].</dd>
						</div>
						<div class="symbols__row">
							<dt>β</dt>
							<dd>Shape factor. Circular / square: 1.0; rectangular: (1 + 0.3 a / b) / 1.3.</dd>
						</div>
						<div class="symbols__row">
							<dt>λ</dt>
							<dd>Relaxing-base reduction. λ = 1.0 for non-relaxing enlarged bases and standard
								shafts; relaxing prefab enlarged bases (D<sub>b</sub> &gt; D<sub>s</sub> + 0.05 m
								on a driven pile) require a manual override since the explicit DM20 reduction is
								not in the public source set.</dd>
						</div>
					</dl>
				</div>
				<div class="doc-callout">
					<strong>α<sub>b</sub> and α<sub>s</sub> screening defaults.</strong> The exact installation
					factors for each pile system are published in DM20 [2] and in the certified ATG documents
					[1], [8]. They are not reproduced in the public Belgian practice report [3], so the
					screening tool ships with internal defaults at conservative midpoints commonly cited in
					Belgian pile design practice. The defaults are intended for screening only; production
					calculations must use the actual DM20 / ATG values for the specific pile system, entered
					through the ATG override block. The runtime emits a warning note when the defaults are
					used without an override.
				</div>
			</section>

			<section id="shaft" class="doc-card">
				<p class="section-label">Shaft resistance</p>
				<h2>6. Shaft resistance and the η*<sub>p</sub> table</h2>
				<div class="equations">
					<div class="formula">R<sub>s</sub> = χ<sub>s</sub> · Σ<sub>i</sub> α<sub>s,i</sub> h<sub>i</sub> q<sub>s,i</sub></div>
					<div class="formula">q<sub>s,i</sub> = η*<sub>p,i</sub> · q<sub>c,m,i</sub> · 1000   [kPa, with q<sub>c,m</sub> in MPa]</div>
				</div>
				<p>
					q<sub>c,m,i</sub> is the layer-mean cone resistance over the intersection of layer i with
					the pile shaft (z<sub>head</sub> ≤ z &lt; z<sub>toe</sub>). η*<sub>p</sub> depends on soil
					type and on q<sub>c,m</sub> through the public Belgian table [3] §A.1:
				</p>
				<div class="equations">
					<div class="formula">Clay:                            1 ≤ q<sub>c,m</sub> ≤ 4.5 MPa: η*<sub>p</sub> = 1/30; q<sub>c,m</sub> &gt; 4.5: q<sub>s</sub> = 150 kPa cap</div>
					<div class="formula">Loam / silt:                     1 ≤ q<sub>c,m</sub> ≤ 6   MPa: η*<sub>p</sub> = 1/60; q<sub>c,m</sub> &gt; 6:   q<sub>s</sub> = 100 kPa cap</div>
					<div class="formula">Sandy clay / clayey sand:        1 ≤ q<sub>c,m</sub> ≤ 10  MPa: η*<sub>p</sub> = 1/80; q<sub>c,m</sub> &gt; 10:  q<sub>s</sub> = 125 kPa cap</div>
					<div class="formula">Sand: 1 ≤ q<sub>c,m</sub> ≤ 10:  η*<sub>p</sub> = 1/90; 10 &lt; q<sub>c,m</sub> ≤ 20: q<sub>s</sub> = 110 + 4 (q<sub>c,m</sub> − 10) kPa; q<sub>c,m</sub> &gt; 20: q<sub>s</sub> = 150 kPa cap</div>
				</div>
				<ul class="notes">
					<li>Layers whose layer-mean q<sub>c,m</sub> is below 1 MPa are excluded from positive shaft
						friction [3].</li>
					<li>Peat / organic layers are also excluded regardless of q<sub>c,m</sub>.</li>
					<li>Cyclic compression / tension loading triggers an α<sub>s</sub> reduction by 1.33 per
						[3]; the screening tool does not apply this reduction automatically. Cyclic loading
						users must reduce α<sub>s</sub> manually via the ATG override.</li>
					<li>The η*<sub>p</sub> mapping from the Stage 3 NEN6740 classification is approximate.
						The UI exposes a per-layer override.</li>
				</ul>
			</section>

			<section id="factors" class="doc-card">
				<p class="section-label">Factor chain</p>
				<h2>7. Model, correlation, and partial-resistance factors</h2>
				<div class="equations">
					<div class="formula">R<sub>c</sub> = R<sub>b</sub> + R<sub>s</sub></div>
					<div class="formula">R<sub>c,cal</sub> = R<sub>c</sub> / γ<sub>Rd</sub></div>
					<div class="formula">R<sub>c,k</sub> = R<sub>c,cal</sub> / max(ξ<sub>3</sub>, ξ<sub>4</sub>)   (single-CPT branch — see callout)</div>
					<div class="formula">R<sub>b,k</sub> = R<sub>c,k</sub> · R<sub>b</sub> / R<sub>c</sub>,    R<sub>s,k</sub> = R<sub>c,k</sub> · R<sub>s</sub> / R<sub>c</sub></div>
					<div class="formula">R<sub>c,d</sub> = R<sub>b,k</sub> / γ<sub>b</sub> + R<sub>s,k</sub> / γ<sub>s</sub></div>
				</div>
				<div class="doc-callout">
					<strong>Single-CPT correlation factor.</strong> The full Eurocode 7 / Belgian rule is
					R<sub>c,k</sub> = min[(R<sub>c,cal</sub>)<sub>avg</sub> / ξ<sub>3</sub>,
					(R<sub>c,cal</sub>)<sub>min</sub> / ξ<sub>4</sub>]. With one CPT in scope, the average and
					the minimum collapse to the single calculated value, so the governing branch is
					max(ξ<sub>3</sub>, ξ<sub>4</sub>). In every cell of the public ξ tables [3] §A.3,
					ξ<sub>3</sub> ≥ ξ<sub>4</sub>, so ξ<sub>3</sub> governs the single-CPT case. Genuine
					multi-CPT statistical treatment (R<sub>c,cal,j</sub> per CPT, separate average and
					minimum branches) is out of scope for this screen.
				</div>
				<div class="symbols">
					<div class="symbols__title">Public values from [3]</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>γ<sub>Rd</sub></dt>
							<dd>Driven / jacked: 1.00 / 1.00 / 1.00. Screw: 1.30 / 1.10 / 1.00. CFA: 1.35 /
								1.20 / 1.10. Bored: 1.20 / 1.20 / 1.10. Columns are γ<sub>Rd1</sub>
								(no SLT) / γ<sub>Rd2</sub> (SLT comparable) / γ<sub>Rd3</sub> (SLT on job site).</dd>
						</div>
						<div class="symbols__row">
							<dt>ξ<sub>3</sub>, ξ<sub>4</sub></dt>
							<dd>Five-column table by CPT density (1 CPT / 10 m² … 1 CPT / 1000 m²) and three
								rows by pile count (1–3, 4–10, &gt; 10). Reproduced verbatim from [3] §A.3.</dd>
						</div>
						<div class="symbols__row">
							<dt>γ<sub>b</sub>, γ<sub>s</sub></dt>
							<dd>Without QA: γ<sub>b</sub> = 1.00 (driven), 1.07 (screw), 1.10 (CFA), 1.20
								(bored); γ<sub>s</sub> = 1.00 for all. With QA (verified quality conditions
								via ATG): γ<sub>b</sub> = γ<sub>s</sub> = 1.00 for all.</dd>
						</div>
					</dl>
				</div>
				<p>
					The ULS check is F<sub>c,d</sub> + F<sub>nk,d</sub> ≤ R<sub>c,d</sub>; F<sub>nk,d</sub>
					contributes only when downdrag is selected (see §8). Per [3], the negative-friction
					action need not be combined simultaneously with transient loads — the screening tool
					reports the worse of the transient combination and the long-term downdrag combination.
				</p>
			</section>

			<section id="fnk" class="doc-card">
				<p class="section-label">Negative skin friction</p>
				<h2>8. F<sub>nk</sub> — slip and analogy methods</h2>
				<p>
					When the soil around the pile may settle relative to the pile, positive shaft friction is
					replaced by a downward dragging action over the affected layers. The screening tool offers
					a <code>downdrag</code> preset (none / moderate / severe) that follows the [3] settlement
					trigger logic, plus a user-entered neutral-plane depth z<sub>NP</sub>. Layers above
					z<sub>NP</sub> lose positive friction and contribute to F<sub>nk</sub> by the larger of two
					methods.
				</p>
				<div class="equations">
					<div class="formula">F<sub>nk,slip</sub>    = χ<sub>s</sub> · Σ<sub>i ↑</sub> h<sub>i</sub> · K<sub>0,i</sub> · tan(δ<sub>i</sub>) · σ′<sub>v,i</sub></div>
					<div class="formula">F<sub>nk,analogy</sub> = χ<sub>s</sub> · Σ<sub>i ↑</sub> α<sub>s,i</sub> h<sub>i</sub> q<sub>s,i</sub></div>
					<div class="formula">F<sub>nk,rep</sub>    = max[ F<sub>nk,slip</sub>, F<sub>nk,analogy</sub> ]</div>
					<div class="formula">F<sub>nk,d</sub>      = γ<sub>F</sub> · multiplier · F<sub>nk,rep</sub>,    γ<sub>F</sub> = 1.0 per [3]</div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>K<sub>0,i</sub></dt>
							<dd>Earth-pressure-at-rest coefficient: K<sub>0</sub> = 1 − sin φ′.</dd>
						</div>
						<div class="symbols__row">
							<dt>δ<sub>i</sub></dt>
							<dd>Pile-soil interface friction angle. δ = φ′ for cast-in-situ concrete piles;
								δ = 0.75 φ′ for precast concrete and steel piles. The product
								K<sub>0</sub> · tan(δ) is floored at 0.25.</dd>
						</div>
						<div class="symbols__row">
							<dt>σ′<sub>v,i</sub></dt>
							<dd>Effective vertical stress at the layer mid-depth, computed from the
								Stage 4 unit weights and the Stage 1 / user water table.</dd>
						</div>
						<div class="symbols__row">
							<dt>multiplier</dt>
							<dd>1.0 for the severe preset (full F<sub>nk</sub>), 0.5 for the moderate preset
								(half F<sub>nk</sub>) per the [3] settlement-trigger rule.</dd>
						</div>
					</dl>
				</div>
				<ul class="notes">
					<li>The settlement-trigger rule: &gt; 10 cm or not calculated → full F<sub>nk</sub>;
						4–10 cm → half F<sub>nk</sub>; 2–4 cm → no negative load but exclude positive friction
						in the affected layers; &lt; 2 cm → may be neglected (designer decides whether
						positive friction may be counted in the affected layers).</li>
					<li>The screening tool does not itself compute the surface settlement; the user selects
						the preset that matches an external settlement analysis under fill, surcharge, or
						groundwater lowering.</li>
				</ul>
			</section>

			<section id="sls" class="doc-card">
				<p class="section-label">SLS settlement</p>
				<h2>9. Single-pile settlement — Belgian load-transfer method</h2>
				<p>
					The SLS settlement implements the Allani–Huybrechts (2022) load-transfer model [5]:
					hyperbolic shaft (t-z) and base (q-z) springs are calibrated to the Belgian ULS resistance
					convention (ultimate resistance corresponds to a base settlement of 10 % of D<sub>b</sub>).
					An axial-force-and-displacement march along the pile, with bisection on the trial base
					settlement z<sub>b</sub>, recovers the pile-head settlement under the representative SLS
					load F<sub>rep</sub>.
				</p>
				<div class="equations">
					<div class="formula">Shaft (t-z):  t(w) = w / (1/k<sub>s</sub> + w/t<sub>max</sub>)</div>
					<div class="formula">Base (q-z):  q(z<sub>b</sub>) = z<sub>b</sub> / (1/k<sub>b</sub> + z<sub>b</sub>/q<sub>max</sub>)</div>
					<div class="formula">t<sub>10%,i</sub> = α<sub>s,i</sub> · q<sub>s,i</sub>,    q<sub>b,10%</sub> = R<sub>b</sub> / A<sub>b</sub></div>
					<div class="formula">t<sub>max,i</sub> = t<sub>10%,i</sub> · (1 + 10 M<sub>s,i</sub>)</div>
					<div class="formula">q<sub>max</sub>  = q<sub>b,10%</sub> · (1 + 4.55 / M<sub>b</sub>)</div>
					<div class="formula">k<sub>s,i</sub> = t<sub>max,i</sub> / (M<sub>s,i</sub> · D<sub>s</sub>)</div>
					<div class="formula">k<sub>b</sub>   = E<sub>b</sub> / β<sub>b</sub>,    β<sub>b</sub> ≈ 0.455 D<sub>b</sub></div>
				</div>
				<div class="symbols">
					<div class="symbols__title">Notation</div>
					<dl class="symbols__list">
						<div class="symbols__row">
							<dt>M<sub>s,i</sub>, M<sub>b</sub></dt>
							<dd>Dimensionless shaft and base flexibility / stiffness factors from the
								&gt; 100-instrumented-load-test database in [5]; tabulated by pile type and
								soil group (sand / mixed / clay).</dd>
						</div>
						<div class="symbols__row">
							<dt>E<sub>b</sub></dt>
							<dd>Soil modulus at the base level under the SLS stress state. Default: oedometric
								modulus from the Stage 4 Hardening-Soil law evaluated at
								σ′<sub>v</sub>(z<sub>toe</sub>) + 0.5 q<sub>b,10%</sub>; falls back to a CPT
								correlation E<sub>b</sub> ≈ α<sub>E</sub> · q<sub>c,b</sub> · 1000 (α<sub>E</sub>
								= 3 in sand, 5 in mixed, 7 in clay) when Stage 4 parameters are absent.
								User-overridable.</dd>
						</div>
						<div class="symbols__row">
							<dt>β<sub>b</sub></dt>
							<dd>Calibrated coefficient from [5]; equivalent to ½ (1 − ν²) D<sub>b</sub> at
								ν = 0.3, the average flexible-circle approximation z<sub>b</sub> ≈
								q D<sub>b</sub> (1 − ν²) / (2 E<sub>b</sub>).</dd>
						</div>
					</dl>
				</div>
				<p>
					The pile is discretized into segments of length Δz = min(0.20 m, L / 50). At each trial
					z<sub>b</sub>, a single FD march from the toe upward integrates the load-transfer ODE:
				</p>
				<div class="equations">
					<div class="formula">d²w/dx² = (χ<sub>s</sub> / (E<sub>p</sub> · A<sub>p</sub>)) · t(w(x))</div>
					<div class="formula">N(L)     = q(z<sub>b</sub>) · A<sub>b</sub>,           N(L − Δz) = N(L) + χ<sub>s</sub> · t<sub>i</sub>(w) · Δz</div>
					<div class="formula">w_local += N · Δz / (E<sub>p</sub> · A<sub>p</sub>)    (sign: pile in compression, w grows toward the head)</div>
				</div>
				<p>
					An outer bisection on z<sub>b</sub> drives N<sub>head</sub> to F<sub>rep</sub> within
					tolerance. The pile-head settlement is s<sub>head</sub> = z<sub>b</sub> + Σ<sub>i</sub>
					N<sub>i</sub> · Δz<sub>i</sub> / (E<sub>p</sub> A<sub>p</sub>). The SLS pass criterion is
					s<sub>head</sub> ≤ s<sub>allow</sub>.
				</p>
				<ul class="notes">
					<li>Layers above the neutral plane (when downdrag is set) are inert in the t-z march:
						they do not mobilize positive friction, so N is conserved through them and
						w grows only by elastic compression.</li>
					<li>An optional simplified typical-curve method is offered for short, homogeneous-profile
						piles; a warning flags pile lengths &gt; 15 m or strongly heterogeneous profiles for
						which the method is not suited.</li>
				</ul>
			</section>

			<section id="section" class="doc-card">
				<p class="section-label">Interactive section view</p>
				<h2>10. Interactive section view</h2>
				<p>
					The pile capacity panel includes a dedicated interactive SVG section view of the pile and
					the soil column, intended as the engineer's primary visual cue. The view is independent
					of the slope-stability canvas; it shares only the low-level pan-zoom-snap utilities of
					the Stage 6 canvas family.
				</p>
				<ul class="notes">
					<li>Drag the pile <strong>toe</strong> handle vertically to set z<sub>toe</sub>; drag the
						<strong>head</strong> handle to set z<sub>head</sub>; drag the <strong>shaft / base
						edge</strong> handles to change D<sub>s</sub> / D<sub>b</sub>.</li>
					<li>Click any soil layer to snap the toe to its top, mid, or bottom. Layer-boundary snap
						applies within ±0.10 m; otherwise a 0.10 m grid snap fires. Hold <kbd>Shift</kbd>
						during a drag to disable snapping.</li>
					<li>Hover any layer to see q<sub>c,m</sub>, η*<sub>p</sub>, q<sub>s</sub>, α<sub>s</sub>,
						and the per-layer R<sub>s</sub> contribution (or "above neutral plane —
						excluded from positive friction").</li>
					<li>The active-shaft band (green) marks the layers that contribute to R<sub>s</sub>; the
						downdrag band (red hatch) marks the layers above the neutral plane when downdrag is
						selected. The neutral plane itself is a draggable dashed orange line.</li>
					<li>All numeric inputs in the left column stay synchronized with the drag gestures and
					vice versa; on each change the analysis recomputes and the four Chart.js panels
					(De Beer transformation chain, per-layer shaft friction, load–settlement curve,
					axial-force distribution) update.</li>
				</ul>
			</section>

			<section id="outputs" class="doc-card">
				<p class="section-label">Outputs and limitations</p>
				<h2>11. Deliverables and boundaries of validity</h2>
				<ul class="notes">
					<li>R<sub>b</sub>, R<sub>s</sub>, R<sub>c</sub>, R<sub>c,cal</sub>, R<sub>c,k</sub>,
						R<sub>c,d</sub> with the full factor-chain audit, and the ULS utilisation
						(F<sub>c,d</sub> + F<sub>nk,d</sub>) / R<sub>c,d</sub>.</li>
					<li>q<sub>b</sub>, the De Beer transformation chain (q<sub>c</sub>, q<sub>h</sub>,
						q<sub>d</sub>, q<sub>u</sub>, q<sub>p</sub>) overlay vs depth, and the per-layer shaft
						friction profile.</li>
					<li>F<sub>nk,slip</sub>, F<sub>nk,analogy</sub>, and the design F<sub>nk,d</sub> when
						downdrag is selected.</li>
					<li>s<sub>head</sub> at F<sub>rep</sub>, the load–settlement curve, the axial-force
						distribution N(z), and the SLS utilisation s<sub>head</sub> / s<sub>allow</sub>.</li>
					<li>Multi-CPT statistical treatment (separate ξ<sub>3</sub>-on-average and
						ξ<sub>4</sub>-on-minimum branches across multiple CPTs) is out of scope.</li>
					<li>Tension / uplift, lateral loading, seismic, buckling, pile-group settlement
						(equivalent raft), and structural pile design are out of scope.</li>
					<li>α<sub>b</sub>, α<sub>s</sub>, γ<sub>Rd</sub>, γ<sub>b</sub> defaults are screening
						midpoints from public Belgian practice; production calculations must use the actual
						DM20 / ATG values via the override block.</li>
					<li>De Beer Stage 1 is implemented as identity; the diameter scale-effect is captured
						entirely through the Stages 2 / 3 gradient limits.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>References</h2>
				<p>
					References were verified against their primary sources on 2026-05-06. URLs are reproduced
					for traceability.
				</p>
				<ul class="notes">
					<li>[1] BUtgb-UBAtc. <em>Informatieblad 2025/3: Ontwerp van palen en micropalen</em>,
						versie van 16 september 2025.
						<a href="https://butgb-ubatc.be/wp-content/uploads/2025/09/IP2025003N-v2.pdf">PDF</a>.</li>
					<li>[2] Buildwise. <em>Richtlijnen voor de toepassing van de Eurocode 7 in België volgens
						de NBN EN 1997-1 ANB. Deel 1: het grondmechanische ontwerp in de uiterste
						grenstoestand (UGT) van axiaal belaste funderingspalen en micropalen op basis van
						statische sonderingen (CPT's)</em> — Dimensioneringsmethode 20, 2020.
						<a href="https://www.buildwise.be/nl/publicaties/dimensioneringsmethodes/20/">Publication
						page</a>; document access requires Buildwise registration.</li>
					<li>[3] Huybrechts, N., De Vos, M., Bottiau, M., and Maertens, L. <em>Design of piles —
						Belgian practice</em>, Buildwise / BBRI national report, 2016.
						<a href="https://www.buildwise.be/umbraco/surface/scientificarticleitem/DownloadFile/ref00009000-design-of-piles-belgian-practice">PDF</a>.</li>
					<li>[4] BGGG-GBMS. <em>Reference document for the application of the De Beer method for
						the prediction of the ultimate unit pile base resistance from CPT</em>; the version
						cited internally in the document is dated 11-09-2002.
						<a href="https://www.bggg-gbms.be/l/library/download/urn%3Auuid%3A95124f03-c628-49f7-afa8-5d2f0237f69c/reference_calculations_de_beer_method.pdf">PDF</a>.</li>
					<li>[5] Allani, M. and Huybrechts, N. <em>Pile settlement under vertical static load: SLS
						design method based on Belgian experience.</em> Proc. 20th International Conference on
						Soil Mechanics and Geotechnical Engineering (ICSMGE), Sydney, 2022.
						<a href="https://www.issmge.org/uploads/publications/1/120/ICSMGE_2022-542.pdf">PDF</a>.</li>
					<li>[6] Buildwise (publication info). <em>NBN EN 1997-1 ANB: Eurocode 7 — Geotechnisch
						ontwerp — Deel 1: Algemene regels — Nationale bijlage</em>, publication date 2022.
						<a href="https://www.buildwise.be/nl/normen-en-regelgeving/zoeken/nbn-en-1997-1-anb-nl/">Publication
						info</a>.</li>
					<li>[7] NBN. <em>NBN EN 1997-2:2024</em> — published on the NBN catalogue but not yet
						applicable in Belgium pending publication of its Belgian National Annex.
						NBN EN 1997-2:2007 with its national annex remains applicable during the transition;
						the first-generation Eurocodes are scheduled to be withdrawn on 30 March 2028.</li>
					<li>[8] BCCA. <em>Publication ATG texts — Foundation piles</em>, 8 May 2023.
						<a href="https://www.bcca.be/en/news/detail/45">News item</a>; the first 12 ATG
						dossiers covering soil-displacement screw piles were issued on 2 May 2023.</li>
					<li>[9] Vlaanderen, Departement Mobiliteit en Openbare Werken. <em>Standaardbestek 260
						voor kunstwerken en waterbouw</em>, versie 3.0, July 2025.
						<a href="https://www.vlaanderen.be/publicaties/standaardbestek-260-voor-kunstwerken-en-waterbouw-versie-30">Publication
						page</a>.</li>
				</ul>
			</section>
		</main>
	</div>
</div>
