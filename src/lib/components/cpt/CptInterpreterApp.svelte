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

<style>
	.docs-footer {
		max-width: 1280px;
		margin: 8px auto 28px;
		padding: 0 24px;
		text-align: right;
	}

	.docs-footer a {
		font-size: 12px;
		color: var(--tx3);
		text-decoration: none;
	}

	.docs-footer a:hover {
		color: var(--tx2);
		text-decoration: underline;
	}
	
	@media (max-width: 700px) {
		.docs-footer {
			text-align: left;
			margin-top: 0;
		}
	}
</style>
