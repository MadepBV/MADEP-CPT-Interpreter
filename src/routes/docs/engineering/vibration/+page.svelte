<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/styles/docs.css';
	import DocsHeader from '$lib/components/DocsHeader.svelte';

	const pageTitle = 'Vibration Impact — MADEP CPT Interpreter';
	const pageDescription =
		'Technical chapter for the Stage 6 construction-vibration route: source–path–receiver, the TRL 429 / BS 5228-2 vibratory and percussive PPV predictors, the SBR-A 2017, DIN 4150-3 and BS 7385-2 receiver frameworks and the BS 5228-2 human-response descriptors, the trigger-action monitoring plan, site calibration of the attenuation law, assumptions and references.';
	const canonicalUrl = 'https://cpt.madep.be/docs/engineering/vibration';
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
			<p class="hero__eyebrow">Stage 6 / vibration</p>
			<h1>Vibration impact.</h1>
			<p class="hero__lead">
				The vibration route screens the ground-borne vibration (trillingshinder, trillingsschade) that
				installing the wall elements may cause at neighbouring buildings. It predicts the peak particle
				velocity at a receiver distance with the empirical <strong>TRL 429 / BS 5228-2</strong>
				relationships (vibratory and percussive piling), compares it with <em>one</em> receiver framework —
				<strong>SBR-A 2017</strong> (Belgian/Dutch practice), <strong>DIN 4150-3:2016</strong> or
				<strong>BS 7385-2:1993</strong> — together with the BS 5228-2 human-response descriptors, builds a
				trigger-action monitoring plan with an SBR-A style frequency table, and calibrates a site-specific
				attenuation law from trial measurements. Nothing here is normative; results are for screening and
				for planning a monitored trial.
			</p>
		</div>
	</header>

	<div class="docs-shell">
		<aside class="docs-nav" aria-label="Vibration documentation navigation">
			<div class="docs-nav__title">Vibration</div>
			<a href="#scope">Source, path, receiver</a>
			<a href="#prediction">PPV prediction</a>
			<a href="#sbra">SBR-A 2017</a>
			<a href="#din">DIN 4150-3</a>
			<a href="#bs7385">BS 7385-2</a>
			<a href="#human">Human response</a>
			<a href="#monitoring">Monitoring plan</a>
			<a href="#calibration">Site calibration</a>
			<a href="#limits">Assumptions and limitations</a>
			<a href="#references">References</a>
		</aside>

		<main class="docs-content">
			<section id="scope" class="doc-card">
				<p class="section-label">Scope and positioning</p>
				<h2>1. Source–path–receiver</h2>
				<p>
					The vibrating or hammered pile is the <strong>source</strong>; the ground is the
					<strong>path</strong> along which the particle velocity reduces with distance through geometric
					spreading and material damping but can be amplified by layering and resonance; the building and
					its occupants are the <strong>receiver</strong>, each with its own criterion. The source strength
					is not uniquely defined by the vibrator's catalogue force, and CPT data do not define the
					vibration at a neighbour (course §1.3, §2.3): the predictor below is statistical and must be
					verified during execution. The drivability model of the
					<a href="/docs/engineering/drivability">drivability chapter</a> and the PPV model are linked
					only through the instrumented trial.
				</p>
				<div class="doc-callout">
					<strong>One framework per receiver function.</strong> Each receiver function is tied to one standard, says
					so in its result (<code>framework</code>, <code>source</code>, <code>quantity</code>), and the
					wrapper <code>assessReceiver</code> compares the prediction with that single framework. The
					limits refer to different quantities and locations — SBR-A: the velocity component
					V<sub>top</sub> at the measuring point; DIN 4150-3: the maximum component at the foundation or
					the horizontal component at the top floor; BS 7385-2: the peak component at the building base —
					whereas the predictors give the <em>resultant</em> PPV at the ground surface. Comparing a
					predicted resultant with a component limit is conservative; the notes repeat this.
				</div>
			</section>

			<section id="prediction" class="doc-card">
				<p class="section-label">Source and path</p>
				<h2>2. Empirical PPV predictors (ppv-prediction.js)</h2>
				<p><strong>Vibratory piling — TRL 429 (Hiller &amp; Crabb 2000) as reproduced in BS 5228-2:2009+A1:2014 Annex E, Table E.1.</strong> Resultant PPV at the ground surface at horizontal distance x from the active pile; k<sub>v</sub> carries an exceedance probability (a statistical predictor, not an upper bound), δ<sub>v</sub> the operating phase; calibration domain 1 ≤ x ≤ 100 m and 1.2 ≤ W<sub>c</sub> ≤ 10.7 kJ per cycle:</p>
				<div class="equations">
					<div class="formula">v<sub>res</sub> = k<sub>v</sub> · x<sup>−δ<sub>v</sub></sup>     [mm/s, x in m]</div>
					<div class="formula">k<sub>v</sub> = 60 (50 % exceedance),   126 (33.3 %),   266 (5 %)</div>
					<div class="formula">δ<sub>v</sub> = 1.4 (steady-state driving),   1.3 (all operations),   1.2 (start-up / run-down)</div>
				</div>
				<p>The app evaluates all nine (phase, probability) pairs for the receiver distance and plots the distance curves. Outside 1–100 m a note says extrapolation is not justified without site data; k<sub>v</sub> = 266 is flagged as an approximate 95th-percentile screening envelope, not a maximum. Course §11 values at 30 m (steady 0.513 / 1.078 / 2.275, all 0.721 / 1.514 / 3.196, start-up 1.013 / 2.127 / 4.491 mm/s) are reproduced.</p>
				<p><strong>Percussive (impact) piling — BS 5228-2 Annex E, Table E.1 equation with Table E.2 k<sub>p</sub>.</strong> W is the hammer energy per blow in joules (the app uses rated energy × efficiency), r the <em>slope</em> distance from the pile toe; calibration domain 1 ≤ L ≤ 27 m, 1 ≤ x ≤ 111 m, 1.5 ≤ W ≤ 85 kJ:</p>
				<div class="equations">
					<div class="formula">v<sub>res</sub> = k<sub>p</sub> · √W / r<sup>1.3</sup>,   r = √(L² + x²)     (L = toe depth; L = 0 → r = x, conservative)</div>
					<div class="formula">k<sub>p</sub> = 5 (all piles driven to refusal)</div>
					<div class="formula">k<sub>p</sub> = 3 (toe through very stiff cohesive, dense granular, or fill with large obstructions)</div>
					<div class="formula">k<sub>p</sub> = 1.5 (toe through stiff cohesive, medium dense granular, compacted fill)</div>
					<div class="formula">k<sub>p</sub> = 1 (toe through soft cohesive, loose granular, loose fill, organic soils)</div>
				</div>
				<div class="doc-callout">
					<strong>k<sub>p</sub> is a ground-condition factor, NOT a probability.</strong> BS 5228-2 attaches no
					exceedance probability to the percussive predictor; probabilistic k<sub>p</sub> values (50/33/5 %)
					do not exist in the standard and are not offered. An explicit site-calibrated k<sub>p</sub> may be
					passed instead of the class. In the app the toe depth is the retained height + embedment of the
					wall design.
				</div>
				<p><strong>Site-calibrated power law</strong> (course §9.4, §15.5), with K and n from §8:</p>
				<div class="equations">
					<div class="formula">v = K · x<sup>−n</sup></div>
				</div>
			</section>

			<section id="sbra" class="doc-card">
				<p class="section-label">Receiver framework 1</p>
				<h2>3. SBR Trillingsrichtlijn A: Schade aan bouwwerken (2017)</h2>
				<p>
					The framework used in Belgian monitoring practice (the T26L053 trillingsmonitoring example).
					The characteristic value V<sub>kar</sub> of the building part is reduced by three partial
					factors; the allowable measured top velocity follows from the SBR-A inequality
					V<sub>d</sub> = V<sub>top</sub>·γ<sub>v</sub> ≤ V<sub>r</sub> = V<sub>kar</sub>/(γ<sub>t</sub>·γ<sub>s</sub>):
				</p>
				<div class="equations">
					<div class="formula">V<sub>top,allow</sub> = V<sub>kar</sub> / (γ<sub>s</sub> · γ<sub>v</sub> · γ<sub>t</sub>)</div>
					<div class="formula">V<sub>r</sub> = V<sub>kar</sub> / (γ<sub>t</sub> · γ<sub>s</sub>)     (reported)</div>
				</div>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr><th>Table</th><th>Quantity</th><th>Values implemented</th></tr>
							</thead>
							<tbody>
								<tr><td>10.8</td><td>V<sub>kar</sub>, ground-floor load-bearing structure, f in Hz (linear interpolation)</td><td>category 1: 20 mm/s (0–10 Hz) → 40 (50 Hz) → 50 (100 Hz); category 2: 5 → 15 → 20 mm/s; above 100 Hz the 100 Hz value</td></tr>
								<tr><td>10.9</td><td>V<sub>kar</sub>, highest floor and non-load-bearing parts (all frequencies)</td><td>category 1: 40 mm/s; category 2: 15 mm/s</td></tr>
								<tr><td>10.7</td><td>γ<sub>s</sub> building condition / monumental status</td><td>normal 1.0; sensitive 1.7; monument 1.7</td></tr>
								<tr><td>9.2</td><td>γ<sub>v</sub> type of measurement</td><td>extensive 1.0; limited 1.4; indicative 1.6</td></tr>
								<tr><td>10.6</td><td>γ<sub>t</sub> type of vibration — structure and parts</td><td>short 1.0; repeated short-term 1.5; continuous 2.5</td></tr>
								<tr><td>10.6</td><td>γ<sub>t</sub> — settlement-sensitive foundation</td><td>short 1.0; repeated 1.6; continuous 2.0</td></tr>
								<tr><td>§10.3.5</td><td>Foundation (settlement) criterion, frequency-independent</td><td>V<sub>kar</sub> = 10·C<sub>D</sub>, C<sub>D</sub> = 1 + (8 − H)/7 ≤ 2 (H = thickness of the settlement-sensitive layer, m; unknown → C<sub>D</sub> = 1); a<sub>kar</sub> = 1 m/s² divided by γ<sub>v</sub> only (Table 10.11: γ<sub>t</sub>, γ<sub>s</sub>, C<sub>D</sub> do not apply to the acceleration)</td></tr>
								<tr><td>legacy</td><td>Category 3 (pre-2017 editions: monuments / poor-condition masonry)</td><td>3 → 8 → 10 mm/s (ground floor), 8 mm/s (top floor) — kept as an explicitly labelled legacy line; SBR-A 2017 replaced it by category 2 with γ<sub>s</sub> = 1.7 (kader 50), which the note recommends</td></tr>
							</tbody>
						</table>
					</div>
				</div>
				<p>
					Example reproduced exactly (T26L053 CN001A, category 2, γ<sub>s</sub> = 1.7, γ<sub>v</sub> = 1.6,
					γ<sub>t</sub> = 1.5 structure / 1.6 foundation): 1.23 mm/s (≤ 10 Hz), 1.53 (15), 2.45 (30), 3.68 (50),
					4.29 (75), 4.90 (100 Hz); top floor / non-load-bearing 3.68; foundation 10/(1.7·1.6·1.6) = 2.30 mm/s.
					The app's defaults are measurement type “indicative” and vibration type “repeated”.
				</p>
			</section>

			<section id="din" class="doc-card">
				<p class="section-label">Receiver framework 2</p>
				<h2>4. DIN 4150-3:2016-12</h2>
				<p>Guideline values (Anhaltswerte) for short-term vibration at the foundation (Table 1, frequency-dependent, linear interpolation) and in the plane of the floor of the uppermost storey (Table 1, all frequencies), and for long-term vibration at the uppermost floor (Table 3). The values are unchanged from the 1999 edition; the 2016 text itself is paywalled and was verified through reproductions plus the 2016 foreword.</p>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr><th>Line</th><th>Foundation 1–10 Hz</th><th>10–50 Hz</th><th>50–100 Hz</th><th>Top floor, short-term</th><th>Top floor, long-term (Table 3)</th></tr>
							</thead>
							<tbody>
								<tr><td>1 — commercial, industrial and similar</td><td>20</td><td>20–40</td><td>40–50</td><td>40</td><td>10</td></tr>
								<tr><td>2 — dwellings and similar</td><td>5</td><td>5–15</td><td>15–20</td><td>15</td><td>5</td></tr>
								<tr><td>3 — particularly sensitive / listed</td><td>3</td><td>3–8</td><td>8–10</td><td>8</td><td>2.5</td></tr>
							</tbody>
						</table>
					</div>
				</div>
				<ul class="notes">
					<li>Above 100 Hz at least the 100 Hz value applies (Table 1 footnote); below 1 Hz the 1 Hz value is used.</li>
					<li>Table 3 (long-term) is defined at the uppermost floor; asking for it at the foundation returns the Table 3 value with a note. DIN “short-term” is about the absence of fatigue and resonance, not calendar duration — vibratory piling may fall under the long-term provisions.</li>
					<li>Course check: line 2 at 35 Hz = 11.25 mm/s.</li>
				</ul>
			</section>

			<section id="bs7385" class="doc-card">
				<p class="section-label">Receiver framework 3</p>
				<h2>5. BS 7385-2:1993</h2>
				<p>Table 1 transient guide values for cosmetic damage, as peak component particle velocity at the base of the building, with the course §12.3 linear interpolation of line 2:</p>
				<div class="equations">
					<div class="formula">line 1 (reinforced / framed, industrial and heavy commercial):   50 mm/s at 4 Hz and above</div>
					<div class="formula">line 2 (unreinforced / light framed, residential and light commercial):   15 + (5/11)·(f − 4)   for 4 ≤ f ≤ 15 Hz</div>
					<div class="formula">line 2:   20 + (30/25)·(f − 15)   for 15 &lt; f &lt; 40 Hz;   50 mm/s at 40 Hz and above</div>
					<div class="formula">continuous vibration able to excite resonance:   guide value × 0.5   (BS 7385-2 allows a reduction of up to 50 % — conditional, not automatic; applied only when the option is set)</div>
				</div>
				<ul class="notes">
					<li>Below 4 Hz the standard also limits displacement (line 2: 0.6 mm zero-to-peak); the 4 Hz velocity value is used with a note to consult the standard.</li>
					<li>Course check: line 2 at 35 Hz = 44 mm/s (22 mm/s with the continuous-vibration reduction); 15 Hz → 20 → 7.5 mm/s reduced.</li>
					<li>The wording and the “up to 50 %” figure are verified; the exact clause number of the continuous-vibration reduction differs between fetched copies (the module cites §7.5) and is treated as unverified.</li>
				</ul>
			</section>

			<section id="human" class="doc-card">
				<p class="section-label">Occupants</p>
				<h2>6. Human response — BS 5228-2 Table B.1</h2>
				<p>Descriptors of the PPV at the point of entry into the recipient; these are <strong>not</strong> building-damage limits (a formal assessment uses BS 6472-1):</p>
				<div class="doc-table-wrap">
					<div class="doc-table-scroll">
						<table class="doc-table">
							<thead>
								<tr><th>PPV</th><th>Effect</th></tr>
							</thead>
							<tbody>
								<tr><td>0.14 mm/s</td><td>Might be just perceptible in the most sensitive situations for most construction vibration frequencies.</td></tr>
								<tr><td>0.3 mm/s</td><td>Might be just perceptible in residential environments.</td></tr>
								<tr><td>1.0 mm/s</td><td>Likely to cause complaint in residential environments, but can be tolerated if prior warning and explanation has been given to residents.</td></tr>
								<tr><td>10 mm/s</td><td>Likely to be intolerable for any more than a very brief exposure in most building environments.</td></tr>
							</tbody>
						</table>
					</div>
				</div>
				<p>The wrapper reports the band (below perception / perceptible / complaints likely / intolerable) next to the structural verdict, and a utilisation = predicted / limit with the verdict <em>ok</em>, <em>attention</em> (≥ 75 % of the limit by default) or <em>exceeds</em>.</p>
			</section>

			<section id="monitoring" class="doc-card">
				<p class="section-label">Execution control</p>
				<h2>7. Trigger-action monitoring plan (monitoring-plan.js)</h2>
				<p>
					<code>buildMonitoringPlan</code> assembles the traffic-light plan of course §16 with the levels of
					the Belgian example (alarm at the SBR-A limit, SMS at 75 %):
				</p>
				<div class="symbols">
					<div class="symbols__title">Levels</div>
					<dl class="symbols__list">
						<div class="symbols__row"><dt>Expected</dt><dd>Median-type prediction (e.g. TRL 429 k<sub>v</sub> = 60).</dd></div>
						<div class="symbols__row"><dt>Upper</dt><dd>Conservative prediction (e.g. k<sub>v</sub> = 266) — the prediction-review level. If it exceeds the stop level the method must be revised before work starts; if it exceeds the warning level amber events are to be expected.</dd></div>
						<div class="symbols__row"><dt>Stop (alarm)</dt><dd>The allowable value of the selected framework at the dominant frequency (SBR-A: V<sub>top,allow</sub>; DIN / BS: the guideline value). A project override may only <em>lower</em> it; a higher request is rejected with a note. Missing dominant frequency → the lowest-frequency (most conservative) limit.</dd></div>
						<div class="symbols__row"><dt>Warning (SMS)</dt><dd>warning = 0.75 × stop by default (the fraction is an input in (0, 1)).</dd></div>
						<div class="symbols__row"><dt>Structural guide</dt><dd>The unfactored V<sub>kar</sub> / guide value at the dominant frequency, or a project-supplied value.</dd></div>
						<div class="symbols__row"><dt>Human objective</dt><dd>1.0 mm/s (BS 5228-2 Table B.1 “complaints likely”), not a damage limit.</dd></div>
					</dl>
				</div>
				<p>The <strong>frequency table</strong> follows the SBR-A example (Figuur 2): for f = 0, 5, 10 … 100 Hz it lists V<sub>kar</sub>, V<sub>allow</sub> = V<sub>kar</sub>/(γ<sub>s</sub>γ<sub>v</sub>γ<sub>t</sub>) and the warning level; for DIN 4150-3 and BS 7385-2 the V<sub>kar</sub> column holds the guideline value and V<sub>allow</sub> equals it (those standards have no partial factors; f is floored at 1 Hz and 4 Hz respectively). The states are:</p>
				<ul class="notes">
					<li><strong>Green</strong> — PPV below the warning level, stable penetration, no abnormal movement: continue, log, review trends.</li>
					<li><strong>Amber</strong> — warning ≤ PPV &lt; stop, or the upper prediction reached, PPV rising with depth, penetration rate falling, complaint: reduce the eccentric moment / adjust the frequency, pause if needed, verify sensors and alignment.</li>
					<li><strong>Red</strong> — PPV ≥ stop, abnormal building or ground movement, sensor overload, prolonged refusal: stop immediately, inspect, notify the responsible engineer, revise the method before restart.</li>
				</ul>
				<p><code>suggestSensorLayout</code> proposes the course §15.2 layout: near-field control ≈ 5 m, intermediate ≈ 10 m and ≈ 20 m (only those closer than 0.8 × the receiver distance; an attenuation fit needs ≥ 3 distances) on triaxial geophones rigidly coupled to the ground, plus the receiver sensor on the lowest accessible load-bearing element on the source-facing side, all on a common time reference with depth, frequency and moment setting recorded simultaneously (course §15.3).</p>
				<div class="doc-callout">
					<strong>Stop level versus framework limit.</strong> The stop level must sit below the receiver
					limit by an allowance for instrument uncertainty, signal delay and run-down vibration
					(course §16.1); the plan says so in its notes, and the project must choose that allowance.
				</div>
			</section>

			<section id="calibration" class="doc-card">
				<p class="section-label">Instrumented trial</p>
				<h2>8. Site calibration of the attenuation law (attenuation-calibration.js)</h2>
				<p><strong>Two-point calibration</strong> (course §15.5) — two measurements (x₁, v₁), (x₂, v₂) give the power law directly; no residual estimate is possible:</p>
				<div class="equations">
					<div class="formula">n = ln(v₁/v₂) / ln(x₂/x₁),   K = v₁ · x₁<sup>n</sup></div>
				</div>
				<p><strong>Log-log least squares</strong> (course §15.6), N ≥ 3 points, X = ln x, Y = ln v:</p>
				<div class="equations">
					<div class="formula">n = −Σ(X<sub>i</sub> − X̄)(Y<sub>i</sub> − Ȳ) / Σ(X<sub>i</sub> − X̄)²,   ln K = Ȳ + n·X̄</div>
					<div class="formula">s = √[SSE/(N − 2)]     (residual standard deviation of ln v),   r² = 1 − SSE/S<sub>yy</sub></div>
				</div>
				<p><strong>One-sided 95 % upper prediction</strong> (course §15.7):</p>
				<div class="equations">
					<div class="formula">ln v₉₅(x) = ln K − n·ln x + z·s,   z = 1.645</div>
				</div>
				<ul class="notes">
					<li>Residuals in ln v are treated as normal with constant variance (homoscedastic in log space).</li>
					<li><strong>Small-N caveat:</strong> 1.645 is the large-sample one-sided 95 % normal quantile; with fewer than 6 points it underestimates the true prediction bound. The one-sided 95 % Student-t quantile for ν = N − 2 (6.314, 2.920, 2.353, 2.132, 2.015 … for ν = 1 … 5) is returned as <code>tFactor</code> for information and a note recommends a formal small-sample interval or a conservative envelope; the course expression (1.645) is what the upper prediction uses unless z is overridden.</li>
					<li>A fitted n ≤ 0 (no attenuation with distance) and s = 0 (two-point or perfect fit — no statistical allowance) are flagged. A best-fit line is not an upper bound; operational variability (start-up, refusal, depth) must be added separately. Separate fits are required for materially different source conditions.</li>
					<li>Course example reproduced: (10 m, 5.0 mm/s) and (20 m, 2.0 mm/s) → n = 1.3219, K = 104.93, v(30 m) = 1.17 mm/s.</li>
				</ul>
			</section>

			<section id="limits" class="doc-card">
				<p class="section-label">Assumptions and limitations</p>
				<h2>9. Documented assumptions</h2>
				<ul class="notes">
					<li>The TRL 429 / BS 5228-2 predictors are screening tools calibrated on a UK database (resultant PPV at the ground surface, 1–100 m); they use neither the vibrator force, the CPT data nor the soil damping, and the 5 % curve is not a maximum.</li>
					<li>No acceleration predictor exists for the SBR-A foundation criterion (a<sub>kar</sub> = 1 m/s²); it is exposed as a monitoring criterion only.</li>
					<li>Settlement and densification of loose saturated sand are not covered by any PPV criterion (course §13) and require a separate cyclic assessment.</li>
					<li>SBR-A category 3 is verified only for the pre-2017 editions and is labelled legacy; DIN 4150-3 values were verified through reproductions of the 1999 table and the 2016 foreword; the BS 7385-2 clause number of the continuous-vibration reduction is unverified (the value is not).</li>
					<li>Non-Belgian guidance (BS 5228-2, BS 7385-2, DIN 4150-3) is used only when specified or technically justified (course §3.2); none of it is a Eurocode partial-factor rule.</li>
					<li>Human exposure is a separate comfort assessment (BS 6472-1); the Table B.1 descriptors are indicative.</li>
				</ul>
			</section>

			<section id="references" class="doc-card">
				<p class="section-label">References</p>
				<h2>10. Reference basis</h2>
				<ul class="reference-list">
					<li><strong>Hiller, D.M. &amp; Crabb, G.I.</strong> (2000). <em>Groundborne vibration caused by mechanised construction works.</em> TRL Report 429 — the vibratory-piling predictor k<sub>v</sub>·x<sup>−δ</sup>.</li>
					<li><strong>BS 5228-2:2009+A1:2014</strong>. <em>Code of practice for noise and vibration control on construction and open sites — Part 2: Vibration.</em> Annex E Table E.1 (predictors and calibration ranges), Table E.2 (k<sub>p</sub>), Annex B Table B.1 (human response) — verified from the full text and cross-checked with NZTA research report 485.</li>
					<li><strong>SBR Trillingsrichtlijn A: Schade aan bouwwerken: 2017</strong> (SBRCURnet) — §9.5 Table 9.2, §10.3.2 Tables 10.6–10.7, §10.3.3 Table 10.8, §10.3.4 Table 10.9, §10.3.5 (foundation), Table 10.11, kader 50 — verified from the guideline text and a consultant's worked examples.</li>
					<li><strong>DIN 4150-3:2016-12</strong>. <em>Erschütterungen im Bauwesen — Einwirkungen auf bauliche Anlagen.</em> Table 1 (short-term), Table 3 (long-term).</li>
					<li><strong>BS 7385-2:1993</strong>. <em>Evaluation and measurement for vibration in buildings — Part 2: Guide to damage levels from groundborne vibration.</em> Table 1 and the continuous-vibration clause.</li>
					<li><strong>BS 6472-1:2008</strong> — human exposure to vibration in buildings (referenced, not implemented). <strong>ISO 4866:2010</strong> — measurement and evaluation of vibration effects on structures.</li>
					<li><strong>Course text</strong>: <em>Manual Design of Vibratory Pile Installation</em> (edition 1.0) — §9–12 quantities, TRL 429 worked example and receiver criteria, §15 instrumented trial and calibration, §16 trigger-action plan.</li>
					<li><strong>MADEP</strong>. <em>T26L053 CN001A — LL Trillingsmonitoring</em> (2026-08-27) — the Belgian SBR-A limit derivation V<sub>top,allow</sub> = V<sub>kar</sub>/(γ<sub>s</sub>·γ<sub>v</sub>·γ<sub>t</sub>) and the frequency table the plan reproduces.</li>
				</ul>
				<p class="refs-inline">
					Every coefficient on this page is transcribed from <code>ppv-prediction.js</code>,
					<code>receiver-criteria.js</code>, <code>attenuation-calibration.js</code> and
					<code>monitoring-plan.js</code>; the per-value verification trail is in
					<code>worklog/agent-vibration-report.md</code>. The three Node scripts (139 checks) run with
					<code>npm run verify:vibration</code>.
				</p>
			</section>
		</main>
	</div>
</div>
