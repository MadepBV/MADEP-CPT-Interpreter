<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel" id="p4">
	<div class="sec">
		<div>
			<div class="sec-title">
				Tuning — m fitting
				<span style="font-size:11px;font-weight:400;color:var(--wn);margin-left:8px"
					>⚠ experimental</span
				>
			</div>
			<div class="sec-sub">
				Per-layer OLS regression of ln(E_oed,i) vs ln(σ'v0 stress ratio) to fit m and
				E_oed,ref from CPT data directly. Review each fit before accepting.
			</div>
		</div>
		<button class="btn sm" onclick={() => call('runTuning')}>Run fitting</button>
	</div>
	<div class="info" style="background:var(--wnl);border-color:var(--wn)">
		<strong>Experimental.</strong> The fitted m replaces the type-default only when the engineer
		explicitly accepts it per layer. Fit quality is shown as R² — values below 0.5 indicate too
		much scatter or insufficient depth range; keep the default in that case. Stage 5 is bedoeld
		als engineer preview. Representatieve m-waarden horen bij voorkeur uit laboproeven te komen.
		Verwacht in het algemeen een m-waarde tussen 0 en 1; waarden daarbuiten vragen extra
		engineering judgement.
	</div>
	<div id="tuningArea"></div>
	<div class="foot">
		<button class="btn" onclick={() => call('goS', 3)}>← Back to parameters</button>
		<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
			<span style="font-size:12px;color:var(--tx2)"
				>Use Stage 6 to turn the interpreted CPT into a first engineering estimate.</span
			>
			<button class="btn sm" onclick={() => call('openStage7Report')}>Stage 7 Report</button>
		</div>
		<button class="btn" onclick={() => call('goS', 5)} style="border-color:var(--ac);color:var(--ac)">
			Stage 6 — Applications →
		</button>
	</div>
</div>
