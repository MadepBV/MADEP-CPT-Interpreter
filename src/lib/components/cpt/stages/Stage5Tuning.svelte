<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call } from '$lib/cpt-app/ui';
</script>

<div class="panel" id="p4">
	<div class="panel__head">
		<div>
			<div class="panel__title">
				Tuning — m fitting
			</div>
			<div class="panel__sub">
				Per-layer OLS regression of ln(E_oed,i) vs ln(σ'v0 stress ratio) to fit m and
				E_oed,ref from CPT data directly. Review each fit before accepting.
			</div>
		</div>
		<div class="panel__actions">
			<button class="btn btn--sm" onclick={() => call('runTuning')}>Run fitting</button>
		</div>
	</div>
	<div class="panel__body">
		<div class="verdict verdict--warn">
			<div class="verdict__body">
				The fitted m replaces the type-default only when the engineer explicitly accepts it per layer.
				Fit quality is shown as R² — values below 0.5 indicate too much scatter or insufficient depth
				range; keep the default in that case. Stage 5 is bedoeld als engineer preview.
				Representatieve m-waarden horen bij voorkeur uit laboproeven te komen.
				Verwacht in het algemeen een m-waarde tussen 0 en 1; waarden daarbuiten vragen extra
				engineering judgement.
			</div>
		</div>
		<div id="tuningArea" class="stack"></div>
		<div class="panel__foot">
			<button class="btn" onclick={() => call('goS', 3)}>← Back to parameters</button>
			<div class="panel__foot__note">
				<span>Use Stage 6 to turn the interpreted CPT into a first engineering estimate.</span>
				<button class="btn btn--sm" onclick={() => call('openStage7Report')}>Stage 7 Report</button>
			</div>
			<button class="btn" onclick={() => call('goS', 5)} style="border-color:var(--color-accent);color:var(--color-accent-text)">
				Stage 6 — Applications →
			</button>
		</div>
	</div>
</div>
