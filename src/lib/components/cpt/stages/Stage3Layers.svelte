<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel" id="p2">
	<div class="panel__head">
		<div>
			<div class="panel__title">Layer identification</div>
			<div class="panel__sub">
				Boundaries from soil-type changes + min-thickness filter. Edit any parameter — italic
				orange = manual override.
			</div>
		</div>
		<div class="panel__actions">
			<button class="btn btn--sm" onclick={() => call('exportPlaxisCpt')}>Export PLAXIS CPT</button>
		</div>
	</div>
	<div class="panel__body">
		<div class="fields">
			<div class="field">
				<span class="field__label">Parameter methode:</span>
				<div class="field__row">
					<div class="segmented" role="radiogroup" aria-label="Parameter methode">
						<button id="pmSB260" class="segmented__btn active" onclick={() => call('setParamMethod', 'sb260')}>
							NEN Tabel 3 / EC7
						</button>
						<button id="pmDEF" class="segmented__btn" onclick={() => call('setParamMethod', 'def')}
							>Generiek (DEF)</button
						>
					</div>
					<span class="field__hint" id="pmDesc"
						>Grondsoort en consistentie uit NEN Tabel 3 (EC7) — aanbevolen</span
					>
				</div>
			</div>
		</div>
		<div class="verdict verdict--info">
			<div class="verdict__body">
				Thin-layer merging uses the minimum thickness set in Stage 2. Values with
				<span style="color:var(--color-warn);font-style:italic">italic orange border</span> are manually
				overridden and feed into Stage 4. Dropdown shows ✓ for best qc/Rf match — greyed entries are
				outside the expected range for this layer.
			</div>
		</div>
		<div class="tbl-wrap">
			<table class="tbl" id="lt">
				<thead>
					<tr>
						<th>#</th>
						<th class="num">Top (m)</th>
						<th class="num">Bot (m)</th>
						<th class="num">Top (TAW)</th>
						<th class="num">Bot (TAW)</th>
						<th class="num">Thick.</th>
						<th>Soil type ▾ override</th>
						<th class="num">avg qc</th>
						<th class="num">avg fs</th>
						<th class="num">avg Rf%</th>
						<th class="num">γ (kN/m³)</th>
						<th class="num">γ_sat</th>
						<th class="num">φ' (°)</th>
						<th class="num">c' (kPa)</th>
						<th class="num">cu (kPa)</th>
					</tr>
				</thead>
				<tbody id="lb"></tbody>
			</table>
		</div>
		<div class="panel__foot">
			<button class="btn" onclick={() => call('goS', 1)}>← Back</button>
			<button class="btn btn--primary" onclick={() => call('goS', 3)}>Model parameters →</button>
		</div>
	</div>
</div>
