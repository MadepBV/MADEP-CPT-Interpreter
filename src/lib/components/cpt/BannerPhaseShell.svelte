<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call, getLegacy } from '$lib/cpt-app/ui';
</script>

<div
	id="banner"
	style="background:var(--bg2);border-bottom:1px solid var(--bd);padding:0 16px;display:flex;align-items:center;gap:0;min-height:44px;flex-wrap:wrap"
>
	<span class="app-brand-mark" style="margin-right:10px" aria-hidden="true">MD</span>
	<input
		id="projName"
		type="text"
		value="CPT Project"
		oninput={(event) => {
			const target = event.currentTarget as HTMLInputElement;
			const legacy = getLegacy();
			if (legacy.PROJECT) legacy.PROJECT.name = target.value;
		}}
		style="font-size:12px;font-weight:600;border:none;background:transparent;color:var(--tx);width:120px;padding:0;outline:none"
	/>

	<div style="width:1px;height:24px;background:var(--bd);margin:0 12px"></div>

	<div id="cptTabs" style="display:flex;align-items:stretch;gap:2px;flex:1;overflow-x:auto"></div>
	<button class="btn sm" onclick={() => call('addCpt')} style="margin-left:8px;flex-shrink:0"
		>+ Import CPT(s)</button
	>

	<div style="width:1px;height:24px;background:var(--bd);margin:0 12px"></div>

	<div
		style="display:flex;border:1px solid var(--bd2);border-radius:var(--r);overflow:hidden;flex-shrink:0"
	>
		<button id="phaseA" class="togbtn active" onclick={() => call('setPhase', 'analysis')}
			>Analysis</button
		>
		<button id="phaseB" class="togbtn" onclick={() => call('setPhase', 'correlation')}
			>Correlatie</button
		>
		<button id="phaseC" class="togbtn" onclick={() => call('setPhase', 'section')}
			>Doorsnede</button
		>
	</div>
</div>

<div id="phaseCorr" style="display:none;padding:20px 24px;max-width:1280px;margin:0 auto">
	<div class="sec">
		<div>
			<div class="sec-title">Cross-CPT correlatie</div>
			<div class="sec-sub">
				Verbindt lagen over CPTs op basis van absolute hoogte (m TAW), grondsoort en qc.
				Vereist bevestigde maaiveldshoogte per CPT.
			</div>
		</div>
		<button class="btn pri sm" onclick={() => call('runCorrelation')}>Auto-correleer</button>
	</div>
	<div id="corrWarnings"></div>
	<div id="corrTable" style="overflow-x:auto;margin-top:12px"></div>
</div>

<div id="phaseSection" style="display:none;padding:20px 24px;max-width:1280px;margin:0 auto">
	<div class="sec">
		<div>
			<div class="sec-title">Geologische doorsnede</div>
			<div class="sec-sub">
				Projectie van gecorreleerde lagen op een verticaal vlak. Absolute hoogte (m TAW) op
				Y-as, afstand langs de doorsnede op X-as.
			</div>
		</div>
		<div style="display:flex;align-items:center;gap:10px">
			<span class="ctrl-lbl">Verticale schaal ×</span>
			<input
				type="range"
				id="vexag"
				min="1"
				max="10"
				step="0.5"
				value="2"
				style="width:80px"
				oninput={(event) => {
					const target = event.currentTarget as HTMLInputElement;
					const value = target.value;
					const label = document.getElementById('vexagV');
					if (label) label.textContent = value;
					call('renderSection');
				}}
			/>
			<span id="vexagV" style="font-size:12px;min-width:20px">2</span>
			<button class="btn sm" onclick={() => call('exportSectionSVG')}>SVG ↓</button>
		</div>
	</div>
	<div
		id="sectionCanvas"
		class="section-wrap"
		style="overflow:auto;border:1px solid var(--bd);border-radius:var(--r);background:var(--bg)"
	>
		<svg id="sectionSvg" style="display:block;min-width:600px"></svg>
		<div id="sectionTip" class="section-tip"></div>
	</div>
</div>
