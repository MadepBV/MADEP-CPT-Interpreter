<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel" id="p5">
	<div class="sec">
		<div>
			<div class="sec-title">Applications</div>
			<div class="sec-sub">
				Use the interpreted CPT profile for first engineering calculations. Stage 6 reuses the
				active CPT, current layer model, current water table, and accepted Stage 5 tuning.
			</div>
		</div>
		<div style="display:flex;gap:8px;flex-wrap:wrap">
			<button class="btn sm" onclick={() => call('renderStage6')}>Refresh</button>
			<button class="btn sm" onclick={() => call('openStage7Report')}>Stage 7 Report</button>
		</div>
	</div>
	<div class="info" style="background:var(--wnl);border-color:var(--wn)">
		Stage 6 is a screening workspace. Where the underlying method or a default assumption is
		uncertain, the application now shows that explicitly inside the relevant calculator.
	</div>
	<div id="stage6Area"></div>
	<div class="foot">
		<button class="btn" onclick={() => call('goS', 4)}>← Back to tuning</button>
		<div style="display:flex;gap:8px;flex-wrap:wrap">
			<button class="btn sm" onclick={() => call('exportCSV')}>Export CSV</button>
			<button class="btn sm" onclick={() => call('openStage7Report')}>Print Stage 7</button>
		</div>
	</div>
</div>
