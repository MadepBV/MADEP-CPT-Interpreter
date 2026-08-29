<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
	App header — the dark liquid-glass chrome (worklog/refactor/02-design-system.md §3.3) — plus the
	Stratigrafie / Doorsnede phase panels. The legacy controller reads `#banner`, `#projName`,
	`#cptTabs` (renderBanner writes the CPT tabs into it), `#projFileInput`, `#phaseA/B/C`
	(setPhase toggles `.active`), `#phaseCorr`, `#phaseSection`, `#stratPanel`, `#vexag`, `#vexagV`,
	`#sectionCanvas`, `#sectionSvg`, `#sectionTip` — all kept. This component adds the scroll
	sentinel that densifies the chrome (`.is-scrolled`) and mirrors the phase switch's `.active`
	to `aria-checked` (role="radiogroup" / "radio", §4.4).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { call, getLegacy } from '$lib/cpt-app/ui';

	let sentinel: HTMLElement;
	let header: HTMLElement;
	let phaseGroup: HTMLElement;

	onMount(() => {
		// `.is-scrolled` once the page top has passed under the chrome (IntersectionObserver, no scroll handler).
		const io = new IntersectionObserver(
			([entry]) => header.classList.toggle('is-scrolled', !entry.isIntersecting),
			{ threshold: 0 }
		);
		io.observe(sentinel);

		// Phase switch: the controller toggles `.active` by id; mirror it to aria-checked.
		const radios = Array.from(phaseGroup.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
		const syncPhase = () => {
			for (const r of radios) {
				const checked = r.classList.contains('active') ? 'true' : 'false';
				if (r.getAttribute('aria-checked') !== checked) r.setAttribute('aria-checked', checked);
				const tab = r.classList.contains('active') ? '0' : '-1';
				if (r.getAttribute('tabindex') !== tab) r.setAttribute('tabindex', tab);
			}
		};
		const mo = new MutationObserver(syncPhase);
		radios.forEach((r) => mo.observe(r, { attributes: true, attributeFilter: ['class'] }));
		syncPhase();

		return () => {
			io.disconnect();
			mo.disconnect();
		};
	});

	/** Arrow keys move between the three phases (radiogroup contract). */
	function onPhaseKeydown(event: KeyboardEvent) {
		if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
		const radios = Array.from(phaseGroup.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
		const current = radios.indexOf(document.activeElement as HTMLButtonElement);
		if (current < 0) return;
		event.preventDefault();
		const dir = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
		const next = radios[(current + dir + radios.length) % radios.length];
		next.focus();
		next.click();
	}
</script>

<div class="app-header__sentinel" aria-hidden="true" bind:this={sentinel}></div>

<header id="banner" class="app-header glass-chrome" bind:this={header}>
	<label class="app-brand" for="projName">
		<img class="app-brand-logo" src="/MADEP_logo-on-dark.svg" alt="MADEP" />
		<span class="app-brand__text">
			<input
				id="projName"
				type="text"
				value="CPT Project"
				aria-label="Project name"
				autocomplete="off"
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
		<button type="button" class="btn btn--sm btn--ghost-dark" onclick={() => call('addCpt')}>Import CPT(s)</button>
		<button
			type="button"
			class="btn btn--sm btn--icon btn--ghost-dark"
			title="Project opslaan (.madep.json)"
			aria-label="Project opslaan"
			onclick={() => call('saveProject')}
		>
			<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
				<path d="M8 2v8m0 0l-3-3m3 3l3-3" />
				<path d="M2.5 11.5v1.5a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-1.5" />
			</svg>
		</button>
		<button
			type="button"
			class="btn btn--sm btn--icon btn--ghost-dark"
			title="Project laden — ga verder waar je gebleven was"
			aria-label="Project laden"
			onclick={() => document.getElementById('projFileInput')?.click()}
		>
			<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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

	<div class="segmented" role="radiogroup" aria-label="Application phase" bind:this={phaseGroup}>
		<button
			id="phaseA"
			type="button"
			class="segmented__btn active"
			role="radio"
			aria-checked="true"
			tabindex="0"
			onkeydown={onPhaseKeydown}
			onclick={() => call('setPhase', 'analysis')}>Analysis</button
		>
		<button
			id="phaseB"
			type="button"
			class="segmented__btn"
			role="radio"
			aria-checked="false"
			tabindex="-1"
			onkeydown={onPhaseKeydown}
			onclick={() => call('setPhase', 'correlation')}>Stratigrafie</button
		>
		<button
			id="phaseC"
			type="button"
			class="segmented__btn"
			role="radio"
			aria-checked="false"
			tabindex="-1"
			onkeydown={onPhaseKeydown}
			onclick={() => call('setPhase', 'section')}>Doorsnede</button
		>
	</div>
</header>

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
