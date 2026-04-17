<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel" id="p2">
	<div class="sec">
		<div>
			<div class="sec-title">Layer identification</div>
			<div class="sec-sub">
				Boundaries from soil-type changes + min-thickness filter. Edit any parameter — italic
				orange = manual override.
			</div>
		</div>
		<button class="btn sm" onclick={() => call('exportPlaxisCpt')}>Export PLAXIS CPT</button>
	</div>
	<div class="ctrl-row" style="margin-bottom:14px;flex-wrap:wrap;gap:14px">
		<span class="ctrl-lbl" style="white-space:nowrap;font-weight:500">Parameter methode:</span>
		<div style="display:flex;border:1px solid var(--bd2);border-radius:var(--r);overflow:hidden">
			<button id="pmSB260" class="togbtn active" onclick={() => call('setParamMethod', 'sb260')}>
				NEN Tabel 3 / EC7
			</button>
			<button id="pmDEF" class="togbtn" onclick={() => call('setParamMethod', 'def')}
				>Generiek (DEF)</button
			>
		</div>
		<span style="font-size:11px;color:var(--tx3)" id="pmDesc"
			>Grondsoort en consistentie uit NEN Tabel 3 (EC7) — aanbevolen</span
		>
	</div>
	<div class="info">
		Thin-layer merging uses the minimum thickness set in Stage 2. Values with
		<span style="color:var(--wn);font-style:italic">italic orange border</span> are manually
		overridden and feed into Stage 4. Dropdown shows ✓ for best qc/Rf match — greyed entries are
		outside the expected range for this layer.
	</div>
	<div style="overflow-x:auto">
		<table class="tbl" id="lt">
			<thead>
				<tr>
					<th>#</th>
					<th>Top (m)</th>
					<th>Bot (m)</th>
					<th>Top (TAW)</th>
					<th>Bot (TAW)</th>
					<th>Thick.</th>
					<th>Soil type ▾ override</th>
					<th>avg qc</th>
					<th>avg fs</th>
					<th>avg Rf%</th>
					<th>γ (kN/m³)</th>
					<th>γ_sat</th>
					<th>φ' (°)</th>
					<th>c' (kPa)</th>
					<th>cu (kPa)</th>
				</tr>
			</thead>
			<tbody id="lb"></tbody>
		</table>
	</div>
	<div class="foot">
		<button class="btn" onclick={() => call('goS', 1)}>← Back</button>
		<button class="btn pri" onclick={() => call('goS', 3)}>Model parameters →</button>
	</div>
</div>
