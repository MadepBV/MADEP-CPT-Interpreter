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
