<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { call, getLegacy } from '$lib/cpt-app/ui';
</script>

<div id="banner" class="app-header">
	<label class="app-brand" for="projName">
		<img class="app-brand-logo" src="/MADEP_logo.svg" alt="MADEP" />
		<span class="app-brand__text">
			<input
				id="projName"
				type="text"
				value="CPT Project"
				aria-label="Project name"
				oninput={(event) => {
					const target = event.currentTarget as HTMLInputElement;
					const legacy = getLegacy();
					if (legacy.PROJECT) legacy.PROJECT.name = target.value;
				}}
			/>
		</span>
	</label>

	<div class="app-divider" aria-hidden="true"></div>

	<div class="cpt-tabs-wrap">
		<div id="cptTabs" class="cpt-tabs" aria-label="Imported CPT profiles"></div>
		<button class="btn btn--compact" onclick={() => call('addCpt')}>Import CPT(s)</button>
		<button
			class="btn btn--compact btn--icon"
			title="Project opslaan (.madep.json)"
			aria-label="Project opslaan"
			onclick={() => call('saveProject')}
		>
			<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M8 2v8m0 0l-3-3m3 3l3-3" />
				<path d="M2.5 11.5v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.5" />
			</svg>
		</button>
		<button
			class="btn btn--compact btn--icon"
			title="Project laden — ga verder waar je gebleven was"
			aria-label="Project laden"
			onclick={() => document.getElementById('projFileInput')?.click()}
		>
			<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M8 10V2m0 0L5 5m3-3l3 3" />
				<path d="M2.5 11.5v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.5" />
			</svg>
		</button>
		<input
			id="projFileInput"
			type="file"
			accept=".json,application/json"
			style="display:none"
			onchange={(event) => {
				const target = event.currentTarget as HTMLInputElement;
				const file = target.files?.[0];
				target.value = '';
				if (file) call('loadProjectFromFile', file);
			}}
		/>
	</div>

	<div class="app-divider" aria-hidden="true"></div>

	<div class="segmented" aria-label="Application phase">
		<button id="phaseA" class="togbtn active" onclick={() => call('setPhase', 'analysis')}
			>Analysis</button
		>
		<button id="phaseB" class="togbtn" onclick={() => call('setPhase', 'correlation')}
			>Stratigrafie</button
		>
		<button id="phaseC" class="togbtn" onclick={() => call('setPhase', 'section')}
			>Doorsnede</button
		>
	</div>
</div>

<div id="phaseCorr" class="phase-panel">
	<div class="sec">
		<div>
			<div class="sec-title">Stratigrafie</div>
			<div class="sec-sub">
				Bouwt grondeenheden op uit de laagmodellen van meerdere CPTs: lagen die dezelfde
				geologische eenheid aanboren worden gecorreleerd (uitwiggende lagen en lenzen
				inbegrepen), en elke eenheid ontleent haar parameters aan de deelnemende lagen.
				Vereist bevestigde maaiveldshoogte (m TAW) per CPT.
			</div>
		</div>
	</div>
	<div id="stratPanel" style="margin-top:12px"></div>
</div>

<div id="phaseSection" class="phase-panel">
	<div class="sec">
		<div>
			<div class="sec-title">Geologische doorsnede</div>
			<div class="sec-sub">
				Stratigrafische eenheden geprojecteerd op de meetlijn, met uitwiggingen en lenzen.
				Absolute hoogte (m TAW) op Y-as, afstand langs de doorsnede op X-as.
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
