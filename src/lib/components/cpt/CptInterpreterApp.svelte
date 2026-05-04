<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '$lib/cpt-app/legacy.css';
	import BannerPhaseShell from './BannerPhaseShell.svelte';
	import StageNav from './StageNav.svelte';
	import Stage1Load from './stages/Stage1Load.svelte';
	import Stage2Classification from './stages/Stage2Classification.svelte';
	import Stage3Layers from './stages/Stage3Layers.svelte';
	import Stage4Model from './stages/Stage4Model.svelte';
	import Stage5Tuning from './stages/Stage5Tuning.svelte';
	import Stage6Applications from './stages/Stage6Applications.svelte';
</script>

<a class="skip-link" href="#main">Ga naar inhoud</a>

<main id="main" class="cpt-app" aria-label="MADEP CPT Interpreter">
	<BannerPhaseShell />
	<StageNav />

	<div class="wrap">
		<Stage1Load />
		<Stage2Classification />
		<Stage3Layers />
		<Stage4Model />
		<Stage5Tuning />
		<Stage6Applications />
	</div>

	<footer class="docs-footer">
		<a href="/docs">Technical documentation</a>
	</footer>
</main>

<style>
	.docs-footer {
		width: 100%;
		max-width: var(--container-max);
		margin: 0 auto;
		padding: 0 var(--section-px) 2rem;
		text-align: right;
	}

	.docs-footer a {
		color: var(--tx3);
		font-family: var(--font-mono);
		font-size: 0.7rem;
		text-transform: uppercase;
		text-decoration: none;
		transition:
			color var(--transition-fast),
			transform var(--motion-base) var(--ease-luxury);
	}

	.docs-footer a:hover {
		color: var(--acd);
	}
	
	@media (max-width: 700px) {
		.docs-footer {
			text-align: left;
			margin-top: 0;
		}
	}
</style>
