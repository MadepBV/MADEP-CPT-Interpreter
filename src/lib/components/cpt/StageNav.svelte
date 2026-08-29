<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<!--
	Stage rail (worklog/refactor/02-design-system.md §3.4, §4.4).

	The legacy controller owns the stage *state*: goS() / selectCpt() toggle `.active` / `.done` /
	`.locked` on every `.si` button (indexed by DOM order, `data-s` = stage index) and attach the
	click handlers. This component owns the *markup and the ARIA*: it mirrors those classes to
	`aria-current="step"` / `aria-disabled` / `title`, keeps a roving tabindex with arrow-key
	navigation, and drives the progress hairline. Stage 7 (Report) is not a `.si` — the controller
	never sees it — it opens the report the same way the Stage 4–6 buttons do (`openStage7Report`)
	once model parameters (Stage 4) have been reached.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { call } from '$lib/cpt-app/ui';

	const STAGES = [
		'Load & preview',
		'Classification',
		'Layer identification',
		'Model parameters',
		'Tuning',
		'Applications'
	];
	/** Stage 7 unlocks once this stage index has been reached (buildStage7Payload needs layers + model). */
	const REPORT_UNLOCK_AT = 3;

	let nav: HTMLElement;
	let reportBtn: HTMLButtonElement;

	function setAttr(el: Element, name: string, value: string | null) {
		if (value === null) {
			if (el.hasAttribute(name)) el.removeAttribute(name);
		} else if (el.getAttribute(name) !== value) {
			el.setAttribute(name, value);
		}
	}

	function stages(): HTMLButtonElement[] {
		return Array.from(nav.querySelectorAll<HTMLButtonElement>('.stage'));
	}

	/** Mirror the controller's classes to ARIA + roving tabindex + progress. Idempotent (no writes when unchanged). */
	function sync() {
		const items = Array.from(nav.querySelectorAll<HTMLButtonElement>('.si'));
		let maxReached = -1;
		let done = 0;
		items.forEach((el, i) => {
			const active = el.classList.contains('active');
			const isDone = el.classList.contains('done');
			const locked = el.classList.contains('locked');
			if (active || isDone) maxReached = Math.max(maxReached, i);
			if (isDone) done += 1;
			setAttr(el, 'aria-current', active ? 'step' : null);
			setAttr(el, 'aria-disabled', locked ? 'true' : null);
			setAttr(el, 'title', locked ? `Voltooi stap ${i} eerst` : null);
			setAttr(el, 'tabindex', active ? '0' : '-1');
		});
		const reportReady = maxReached >= REPORT_UNLOCK_AT;
		reportBtn.classList.toggle('locked', !reportReady);
		setAttr(reportBtn, 'aria-disabled', reportReady ? null : 'true');
		setAttr(reportBtn, 'title', reportReady ? 'Opent het Stage 7 rapport in een nieuw tabblad' : `Voltooi stap ${REPORT_UNLOCK_AT + 1} eerst`);
		setAttr(reportBtn, 'tabindex', '-1');
		nav.style.setProperty('--rail-progress', String(done / 7));
	}

	function openReport() {
		if (reportBtn.getAttribute('aria-disabled') === 'true') return;
		call('openStage7Report');
	}

	/** Roving tabindex: ← → Home End move focus between all seven items (locked ones included, §4.4). */
	function onKeydown(event: KeyboardEvent) {
		const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End'];
		if (!keys.includes(event.key)) return;
		const items = stages();
		const current = items.indexOf(document.activeElement as HTMLButtonElement);
		if (current < 0) return;
		event.preventDefault();
		let next = current;
		if (event.key === 'ArrowRight') next = (current + 1) % items.length;
		else if (event.key === 'ArrowLeft') next = (current - 1 + items.length) % items.length;
		else if (event.key === 'Home') next = 0;
		else next = items.length - 1;
		items.forEach((el, i) => setAttr(el, 'tabindex', i === next ? '0' : '-1'));
		items[next].focus();
		items[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}

	onMount(() => {
		const observer = new MutationObserver(sync);
		nav.querySelectorAll('.si').forEach((el) => observer.observe(el, { attributes: true, attributeFilter: ['class'] }));
		sync();
		return () => observer.disconnect();
	});
</script>

<nav class="stage-rail glass-rail" id="nav" aria-label="CPT interpretation stages" bind:this={nav}>
	<ol class="stage-rail__list">
		{#each STAGES as label, i (i)}
			<li>
				<button
					type="button"
					class="stage si {i === 0 ? 'active' : 'locked'}"
					data-s={i}
					aria-current={i === 0 ? 'step' : undefined}
					aria-disabled={i === 0 ? undefined : 'true'}
					tabindex={i === 0 ? 0 : -1}
					onkeydown={onKeydown}
				>
					<span class="stage__num">{i + 1}</span>
					<span class="stage__label">{label}</span>
				</button>
			</li>
		{/each}
		<li>
			<button
				type="button"
				class="stage stage--report locked"
				data-stage="7"
				aria-disabled="true"
				tabindex="-1"
				bind:this={reportBtn}
				onkeydown={onKeydown}
				onclick={openReport}
			>
				<span class="stage__num">7</span>
				<span class="stage__label">Report</span>
			</button>
		</li>
	</ol>
	<div class="stage-rail__progress" aria-hidden="true"></div>
</nav>
