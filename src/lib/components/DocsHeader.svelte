<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	// Shared documentation site header. Visual identity matches madep.be:
	// a dark, glass-blur floating bar on the cream page, cream nav links
	// with an animated underline, a subtle outlined CTA, and a hamburger
	// that morphs to an X. Hamburger / mobile-panel pattern follows
	// docs/style.md.
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

<div
	class="dh__backdrop"
	class:visible={menuOpen}
	role="button"
	tabindex="-1"
	aria-label="Close menu"
	aria-hidden={!menuOpen}
	onclick={close}
	onkeydown={(e) => { if (e.key === 'Escape') close(); }}
></div>

<style>
	/* ─── outer fixed shell ───────────────────────────────────────────── */
	.dh {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		z-index: 1000;
		padding:
			calc(env(safe-area-inset-top, 0px) + 0.65rem)
			clamp(0.75rem, 2vw, 1.25rem)
			0;
		pointer-events: none; /* outer padding is click-through */
		transition: padding-top 0.25s ease-in-out;
	}

	/* ─── inner glass bar (dark, blur, floating on cream page) ────────── */
	.dh__inner {
		pointer-events: auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1.5rem;
		max-width: 1300px;
		margin: 0 auto;
		padding: 0.85rem 1.5rem;
		border: 1px solid rgba(237, 233, 225, 0.1);
		border-radius: 6px;
		background: rgba(17, 17, 16, 0.62);
		backdrop-filter: blur(16px);
		-webkit-backdrop-filter: blur(16px);
		box-shadow: 0 8px 24px rgba(17, 17, 16, 0.1);
		transition:
			background 0.25s ease-in-out,
			border-color 0.25s ease-in-out,
			box-shadow 0.25s ease-in-out;
	}

	/* ─── logo (cream wordmark on dark) ───────────────────────────────── */
	.dh__logo {
		flex-shrink: 0;
		font-family: 'DM Sans', system-ui, sans-serif;
		font-size: 0.94rem;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: #ede9e1;
		text-decoration: none;
		white-space: nowrap;
		opacity: 0.94;
		transition: opacity 0.2s ease-in-out, transform 0.2s ease-in-out;
	}

	.dh__logo:hover {
		opacity: 1;
		transform: translate3d(0, -1px, 0);
	}

	/* ─── nav (desktop layout) ────────────────────────────────────────── */
	.dh__nav {
		display: flex;
		align-items: center;
		gap: 1.6rem;
		margin-left: auto;
	}

	.dh__link {
		position: relative;
		font-size: 0.76rem;
		font-weight: 400;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: rgba(237, 233, 225, 0.78);
		text-decoration: none;
		transition: color 0.2s ease-in-out;
	}

	/* animated underline indicator (matches madep.be) */
	.dh__link::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: -0.45rem;
		height: 1px;
		background: currentColor;
		opacity: 0;
		transform: scaleX(0.45);
		transform-origin: left;
		transition:
			opacity 0.25s ease-in-out,
			transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
	}

	.dh__link:hover {
		color: rgba(237, 233, 225, 0.96);
	}

	.dh__link:hover::after,
	.dh__link:focus-visible::after {
		opacity: 0.72;
		transform: scaleX(1);
	}

	/* ─── CTA (subtle outlined, matches madep.be "Contacteer ons") ─────── */
	.dh__cta {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: #ede9e1;
		background-color: rgba(237, 233, 225, 0.08);
		padding: 0.65rem 1.1rem;
		border: 1px solid rgba(237, 233, 225, 0.16);
		border-radius: 3px;
		text-decoration: none;
		transition:
			background-color 0.25s ease-in-out,
			border-color 0.25s ease-in-out,
			transform 0.2s ease-in-out;
	}

	.dh__cta:hover,
	.dh__cta:focus-visible {
		background-color: rgba(237, 233, 225, 0.14);
		border-color: rgba(237, 233, 225, 0.28);
		transform: translate3d(0, -1px, 0);
	}

	/* ─── hamburger (cream bars on dark; 22×2 px, matches madep.be) ────── */
	.dh__hamburger {
		display: none;
		flex-direction: column;
		gap: 5px;
		padding: 4px;
		background: transparent;
		border: 0;
		cursor: pointer;
		z-index: 1001;
		align-items: center;
		justify-content: center;
	}

	.dh__hamburger span {
		display: block;
		width: 22px;
		height: 2px;
		background-color: #ede9e1;
		transform-origin: center;
		transition:
			opacity 0.25s ease-in-out,
			transform 0.25s ease-in-out,
			background-color 0.25s ease-in-out;
	}

	.dh__hamburger.open span:nth-child(1) {
		transform: translateY(7px) rotate(45deg);
	}
	.dh__hamburger.open span:nth-child(2) {
		opacity: 0;
	}
	.dh__hamburger.open span:nth-child(3) {
		transform: translateY(-7px) rotate(-45deg);
	}

	/* ─── backdrop (only visible when menu is open) ───────────────────── */
	/*
	 * iOS Safari leaves a rasterized "ghost band" at the top of a
	 * position:fixed element with backdrop-filter when its opacity
	 * transitions to 0 — the filter pass keeps drawing a faint blur strip
	 * even at opacity 0. Two-pronged fix:
	 *   1. Apply backdrop-filter ONLY in the .visible state, so the closed
	 *      element has no filter pass to leak.
	 *   2. Toggle visibility (transitioned with the same timing as opacity)
	 *      so the closed element is fully removed from compositing.
	 */
	.dh__backdrop {
		position: fixed;
		inset: 0;
		background: rgba(18, 20, 22, 0);
		z-index: 998;
		opacity: 0;
		visibility: hidden;
		pointer-events: none;
		transition:
			opacity 0.25s ease-in-out,
			background 0.25s ease-in-out,
			visibility 0s linear 0.25s;
		cursor: pointer;
	}

	.dh__backdrop.visible {
		opacity: 1;
		visibility: visible;
		pointer-events: auto;
		background: rgba(18, 20, 22, 0.36);
		-webkit-backdrop-filter: blur(4px);
		backdrop-filter: blur(4px);
		transition:
			opacity 0.25s ease-in-out,
			background 0.25s ease-in-out,
			visibility 0s linear 0s;
	}

	/* ─── responsive: collapse to hamburger panel ─────────────────────── */
	@media (max-width: 920px) {
		.dh {
			padding-top: calc(env(safe-area-inset-top, 0px) + 0.5rem);
		}

		.dh__inner {
			position: relative;
			padding: 0.75rem 1.1rem;
		}

		.dh__hamburger {
			display: flex;
		}

		/*
		 * iOS Safari leaves a backdrop-filter ghost band when the panel
		 * fades from opacity 1 → 0 while still position:absolute. Same
		 * pattern as the backdrop above: filter + visibility flip on the
		 * .open state only.
		 */
		.dh__nav {
			position: absolute;
			top: calc(100% + 0.6rem);
			left: 0;
			right: 0;
			display: grid;
			gap: 0.85rem;
			padding: 1.1rem;
			margin-left: 0;
			border-radius: 6px;
			background: rgba(17, 17, 16, 0);
			border: 1px solid rgba(237, 233, 225, 0);
			box-shadow: 0 16px 40px rgba(17, 17, 16, 0);
			opacity: 0;
			visibility: hidden;
			transform: translateY(-8px);
			pointer-events: none;
			z-index: 999;
			transition:
				opacity 0.25s ease-in-out,
				transform 0.25s ease-in-out,
				background 0.25s ease-in-out,
				border-color 0.25s ease-in-out,
				box-shadow 0.25s ease-in-out,
				visibility 0s linear 0.25s;
		}

		.dh__nav.open {
			opacity: 1;
			visibility: visible;
			transform: translateY(0);
			pointer-events: auto;
			background: rgba(17, 17, 16, 0.97);
			border-color: rgba(237, 233, 225, 0.1);
			box-shadow: 0 16px 40px rgba(17, 17, 16, 0.22);
			-webkit-backdrop-filter: blur(16px);
			backdrop-filter: blur(16px);
			transition:
				opacity 0.25s ease-in-out,
				transform 0.25s ease-in-out,
				background 0.25s ease-in-out,
				border-color 0.25s ease-in-out,
				box-shadow 0.25s ease-in-out,
				visibility 0s linear 0s;
		}

		/* staggered entry of nav items, matching madep.be */
		.dh__nav.open .dh__link,
		.dh__nav.open .dh__cta {
			animation: dh-nav-item-in 0.36s cubic-bezier(0.22, 1, 0.36, 1) both;
		}
		.dh__nav.open .dh__link:nth-child(1) { animation-delay: 30ms; }
		.dh__nav.open .dh__link:nth-child(2) { animation-delay: 60ms; }
		.dh__nav.open .dh__link:nth-child(3) { animation-delay: 90ms; }
		.dh__nav.open .dh__link:nth-child(4) { animation-delay: 120ms; }
		.dh__nav.open .dh__link:nth-child(5) { animation-delay: 150ms; }
		.dh__nav.open .dh__cta { animation-delay: 180ms; }

		.dh__link {
			font-size: 0.8rem;
			padding: 0.1rem 0;
		}

		.dh__link::after {
			bottom: -0.3rem;
		}

		.dh__cta {
			justify-content: center;
			padding: 0.8rem 1.1rem;
			text-align: center;
		}
	}

	@keyframes dh-nav-item-in {
		from { opacity: 0; transform: translateY(-6px); }
		to { opacity: 1; transform: translateY(0); }
	}

	@media (prefers-reduced-motion: reduce) {
		.dh__nav.open .dh__link,
		.dh__nav.open .dh__cta {
			animation: none;
		}
	}
</style>
