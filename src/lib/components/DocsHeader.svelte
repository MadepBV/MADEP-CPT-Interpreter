<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	// Shared documentation site header. Structural pattern adopted from
	// docs/style.md (4 px radius, 0.2 s ease-in-out transitions, 700-weight
	// labels, 3 px hamburger bars morphing to X), brand colours from MADEP.
	let menuOpen = $state(false);
	const close = () => { menuOpen = false; };
</script>

<header class="dh">
	<div class="dh__inner">
		<a class="dh__logo" href="https://madep.be" onclick={close}>MADEP CPT Interpreter</a>

		<nav
			class="dh__nav"
			class:open={menuOpen}
			id="docs-mobile-nav"
			aria-label="Documentation navigation"
		>
			<a class="dh__link" href="/docs" onclick={close}>Docs</a>
			<a class="dh__link" href="/docs/workflow" onclick={close}>Interpretation</a>
			<a class="dh__link" href="/docs/engineering" onclick={close}>Stage 6</a>
			<a class="dh__link" href="/docs/theory" onclick={close}>Methods</a>
			<a class="dh__link" href="/docs/reference" onclick={close}>References</a>
			<a class="dh__cta" href="/" onclick={close}>App ↗</a>
		</nav>

		<button
			class="dh__hamburger"
			class:open={menuOpen}
			aria-label={menuOpen ? 'Close menu' : 'Open menu'}
			aria-expanded={menuOpen}
			aria-controls="docs-mobile-nav"
			onclick={() => (menuOpen = !menuOpen)}
		>
			<span></span><span></span><span></span>
		</button>
	</div>
</header>

{#if menuOpen}
	<div
		class="dh__backdrop"
		role="button"
		tabindex="-1"
		aria-label="Close menu"
		onclick={close}
		onkeydown={(e) => { if (e.key === 'Escape') close(); }}
	></div>
{/if}

<style>
	/* ─── header bar ───────────────────────────────────────────── */
	.dh {
		position: sticky;
		top: 0;
		z-index: 30;
		padding: 10px 16px 0;
		background: linear-gradient(180deg, rgba(247, 244, 239, 0.92), rgba(247, 244, 239, 0));
	}

	.dh__inner {
		max-width: 1300px;
		margin: 0 auto;
		padding: 0.7rem 1.25rem;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1.25rem;
		border: 1px solid rgba(24, 24, 26, 0.1);
		border-radius: 0.25rem;            /* 4 px per style guide */
		background: rgba(247, 244, 239, 0.94);
		backdrop-filter: blur(16px);
		box-shadow: 0 8px 24px rgba(17, 17, 16, 0.08);
	}

	.dh__logo {
		font-family: 'DM Sans', system-ui, sans-serif;
		font-size: 0.94rem;
		font-weight: 700;
		letter-spacing: -0.02em;
		color: #18181a;
		text-decoration: none;
		white-space: nowrap;
	}

	.dh__nav {
		display: flex;
		align-items: center;
		gap: 1.25rem;
		flex: 1;
		justify-content: flex-end;
	}

	.dh__link {
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: #18181a;
		text-decoration: none;
		transition: color 0.2s ease-in-out;
	}

	.dh__link:hover,
	.dh__link:focus-visible {
		color: #3d6b6a;                    /* MADEP accent */
	}

	.dh__cta {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.55rem 1rem;
		font-size: 0.78rem;
		font-weight: 700;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #f7f4ef;
		background: #18181a;
		border: 2px solid #18181a;         /* 2 px button border per style guide */
		border-radius: 0.25rem;
		text-decoration: none;
		transition: all 0.2s ease-in-out;
	}

	.dh__cta:hover,
	.dh__cta:focus-visible {
		background: #f7f4ef;
		color: #18181a;                    /* invert on hover per style guide */
	}

	/* ─── hamburger (mobile only) ──────────────────────────────── */
	.dh__hamburger {
		display: none;
		flex-direction: column;
		gap: 5px;
		width: 40px;
		height: 40px;
		padding: 8px 9px;
		background: transparent;
		border: 0;
		border-radius: 0.25rem;
		cursor: pointer;
		align-items: center;
		justify-content: center;
		transition: background 0.2s ease-in-out;
	}

	.dh__hamburger:hover,
	.dh__hamburger:focus-visible {
		background: rgba(24, 24, 26, 0.06);
	}

	.dh__hamburger span {
		display: block;
		width: 22px;
		height: 3px;                       /* 3 px per style guide */
		background: #18181a;
		border-radius: 1.5px;
		transform-origin: center;
		transition:
			transform 0.25s ease-in-out,
			opacity 0.15s ease-in-out;
	}

	.dh__hamburger.open span:nth-child(1) {
		transform: translateY(8px) rotate(45deg);
	}
	.dh__hamburger.open span:nth-child(2) {
		opacity: 0;
		transform: scaleX(0.6);
	}
	.dh__hamburger.open span:nth-child(3) {
		transform: translateY(-8px) rotate(-45deg);
	}

	.dh__backdrop {
		position: fixed;
		inset: 0;
		z-index: 25;
		background: rgba(15, 15, 16, 0.45);
		cursor: pointer;
		animation: dh-fade-in 0.2s ease-in-out;
	}

	@keyframes dh-fade-in {
		from { opacity: 0; }
		to   { opacity: 1; }
	}

	/* ─── responsive: collapse to hamburger ────────────────────── */
	@media (max-width: 760px) {
		.dh {
			padding: 8px 12px 0;
		}

		.dh__inner {
			padding: 0.6rem 0.85rem;
			gap: 0.75rem;
		}

		.dh__hamburger {
			display: flex;
		}

		.dh__nav {
			position: absolute;
			top: calc(100% + 6px);
			left: 12px;
			right: 12px;
			flex-direction: column;
			align-items: stretch;
			justify-content: flex-start;
			gap: 0.15rem;
			padding: 0.85rem 1rem 1.1rem;
			background: rgba(247, 244, 239, 0.98);
			border: 1px solid rgba(24, 24, 26, 0.1);
			border-radius: 0.25rem;
			box-shadow: 0 12px 32px rgba(17, 17, 16, 0.16);
			backdrop-filter: blur(16px);
			max-height: 0;
			overflow: hidden;
			pointer-events: none;
			opacity: 0;
			transform: translateY(-4px);
			transition:
				max-height 0.25s ease-in-out,
				opacity 0.2s ease-in-out,
				transform 0.25s ease-in-out,
				padding 0.25s ease-in-out;
		}

		.dh__nav.open {
			max-height: 80vh;
			opacity: 1;
			pointer-events: auto;
			transform: translateY(0);
		}

		.dh__link {
			padding: 0.7rem 0.6rem;
			font-size: 0.86rem;
			letter-spacing: 0.08em;
			border-radius: 0.25rem;
			transition: background 0.2s ease-in-out, color 0.2s ease-in-out;
		}

		.dh__link:hover,
		.dh__link:focus-visible {
			background: rgba(24, 24, 26, 0.06);
			color: #3d6b6a;
		}

		.dh__cta {
			margin-top: 0.4rem;
			justify-content: center;
			padding: 0.7rem 1rem;
			font-size: 0.82rem;
		}
	}

	@media (min-width: 761px) {
		.dh__backdrop {
			display: none;
		}
	}
</style>
