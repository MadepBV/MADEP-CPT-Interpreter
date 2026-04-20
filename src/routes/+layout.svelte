<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" type="image/png" href="/favicon.png" />
	<link rel="shortcut icon" href="/favicon.png" />
	<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
	<meta name="application-name" content="MADEP CPT Interpreter" />
	<meta name="theme-color" content="#1D9E75" />
	<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
</svelte:head>

{@render children()}
