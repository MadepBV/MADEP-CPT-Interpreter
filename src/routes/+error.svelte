<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	let { error, status } = $props();
</script>

<svelte:head>
	<title>{status} | CPT Interpreter</title>
</svelte:head>

<div class="shell">
	<div class="card">
		<p class="eyebrow">Application Error</p>
		<h1>{status}</h1>
		<p>{error?.message ?? 'An unexpected error occurred.'}</p>
	</div>
</div>

<style>
	.shell {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 24px;
		background:
			radial-gradient(circle at top left, rgba(29, 158, 117, 0.16), transparent 34%),
			linear-gradient(180deg, #f4f5f1 0%, #e9ece6 100%);
	}

	.card {
		width: min(520px, 100%);
		padding: 28px 30px;
		border-radius: 18px;
		background: rgba(255, 255, 255, 0.88);
		border: 1px solid rgba(0, 0, 0, 0.08);
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.08);
	}

	.eyebrow {
		margin: 0 0 8px;
		font-size: 0.8rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #0f6e56;
	}

	h1 {
		margin: 0 0 10px;
		font-size: clamp(2.4rem, 5vw, 3.4rem);
		line-height: 1;
	}

	p {
		margin: 0;
		line-height: 1.5;
	}
</style>
