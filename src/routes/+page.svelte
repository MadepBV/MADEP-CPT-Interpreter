<script lang="ts">
	import { onMount } from 'svelte';
	import cptHtml from '../../cpt_app.html?raw';

	let host = $state<HTMLDivElement | null>(null);
	let isLoading = $state(true);
	let errorMessage = $state('');

	const STYLE_ID = 'cpt-app-runtime-style';
	const CHART_SCRIPT_ID = 'cpt-app-chartjs';
	const RUNTIME_SCRIPT_ID = 'cpt-app-runtime-script';
	const BRAND_OVERRIDES = `
[data-cpt-app-root]{
	--ac:#1f6b57;
	--acl:#e1eee9;
	--acb:#7ea998;
	--acd:#15493c;
	--wn:#9a6a2f;
	--wnl:#f3e6d4;
	--bg:#f4f1e8;
	--bg2:#ece7dc;
	--bg3:#e1dacc;
	--tx:#18201c;
	--tx2:#667067;
	--tx3:#8a9188;
	--bd:rgba(24,32,28,0.10);
	--bd2:rgba(24,32,28,0.18);
	font-family:"Avenir Next","Helvetica Neue",Helvetica,Arial,sans-serif;
	background:
		radial-gradient(circle at top left, rgba(31,107,87,0.09), transparent 28%),
		linear-gradient(180deg, #f6f3eb 0%, #f1ede2 100%);
}

[data-cpt-app-root] .nav,
[data-cpt-app-root] #banner{
	background:rgba(244,241,232,0.9);
	backdrop-filter:blur(10px);
}

[data-cpt-app-root] .sec-title,
[data-cpt-app-root] .mc h3,
[data-cpt-app-root] .ct,
[data-cpt-app-root] .mc2-sec{
	font-family:"Iowan Old Style","Palatino Linotype","Book Antiqua",Palatino,Georgia,serif;
	letter-spacing:0.01em;
}

[data-cpt-app-root] .sec-title{
	font-size:1.2rem;
}

[data-cpt-app-root] .panel,
[data-cpt-app-root] .cc,
[data-cpt-app-root] .col-card,
[data-cpt-app-root] .mc,
[data-cpt-app-root] .mc2,
[data-cpt-app-root] .dz,
[data-cpt-app-root] .ctrl-row{
	box-shadow:0 12px 30px rgba(39,44,40,0.04);
}

[data-cpt-app-root] .cc,
[data-cpt-app-root] .col-card,
[data-cpt-app-root] .mc,
[data-cpt-app-root] .mc2{
	border-radius:16px;
}

[data-cpt-app-root] .btn{
	border-radius:999px;
	padding:8px 15px;
}

[data-cpt-app-root] .btn.pri{
	box-shadow:0 8px 20px rgba(31,107,87,0.18);
}

[data-cpt-app-root] .dz{
	border-radius:18px;
	background:linear-gradient(180deg, rgba(255,255,255,0.45), rgba(255,255,255,0.18));
}

[data-cpt-app-root] .mi,
[data-cpt-app-root] .met,
[data-cpt-app-root] .info{
	border-radius:14px;
}

[data-cpt-app-root] .tbl th{
	letter-spacing:0.08em;
}

[data-cpt-app-root] .si.active::after{
	height:3px;
	border-radius:999px 999px 0 0;
}

@media (prefers-color-scheme: dark){
	[data-cpt-app-root]{
		--ac:#82b9a7;
		--acl:#21342d;
		--acb:#4a7a69;
		--acd:#b8dbcf;
		--wn:#c89c61;
		--wnl:#3a2d1f;
		--bg:#171c19;
		--bg2:#202723;
		--bg3:#28302c;
		--tx:#ebe6dc;
		--tx2:#b8b3a8;
		--tx3:#8c897f;
		--bd:rgba(255,255,255,0.08);
		--bd2:rgba(255,255,255,0.16);
		background:
			radial-gradient(circle at top left, rgba(130,185,167,0.11), transparent 28%),
			linear-gradient(180deg, #161b18 0%, #111513 100%);
		color-scheme:dark;
	}

	[data-cpt-app-root] .nav,
	[data-cpt-app-root] #banner{
		background:rgba(23,28,25,0.9);
	}

	[data-cpt-app-root] .dz{
		background:linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
	}
}
`;

	type RuntimeWindow = Window &
		typeof globalThis & {
			__cptAppRuntimeLoaded?: boolean;
			renderBanner?: () => void;
		};

	function removeNode(id: string) {
		document.getElementById(id)?.remove();
	}

	function ensureStyle(styleText: string) {
		removeNode(STYLE_ID);
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = styleText;
		document.head.appendChild(style);
	}

	function ensureExternalScript(src: string) {
		return new Promise<void>((resolve, reject) => {
			const existing = document.getElementById(CHART_SCRIPT_ID) as HTMLScriptElement | null;
			if (existing) {
				if ((existing as HTMLScriptElement).dataset.loaded === 'true') {
					resolve();
					return;
				}
				existing.addEventListener('load', () => resolve(), { once: true });
				existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
					once: true
				});
				return;
			}

			const script = document.createElement('script');
			script.id = CHART_SCRIPT_ID;
			script.src = src;
			script.async = true;
			script.addEventListener(
				'load',
				() => {
					script.dataset.loaded = 'true';
					resolve();
				},
				{ once: true }
			);
			script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), {
				once: true
			});
			document.head.appendChild(script);
		});
	}

	function toAppScopedCss(cssText: string) {
		const scoped = cssText
			.replace(/@media\s*\(prefers-color-scheme:dark\)\s*\{\s*:root\s*\{/g, '@media(prefers-color-scheme:dark){[data-cpt-app-root]{')
			.replace(/:root\s*\{/g, '[data-cpt-app-root]{')
			.replace(/\bbody\s*\{/g, '[data-cpt-app-root]{');

		return `${scoped}\n${BRAND_OVERRIDES}`;
	}

	onMount(() => {
		let cancelled = false;

		async function bootstrap() {
			try {
				const html = cptHtml;
				if (cancelled) return;

				const parser = new DOMParser();
				const doc = parser.parseFromString(html, 'text/html');

				const title = doc.querySelector('title')?.textContent?.trim();
				if (title) document.title = title;

				const styleText = doc.querySelector('style')?.textContent ?? '';
				ensureStyle(toAppScopedCss(styleText));

				const scriptSrc = doc.querySelector('script[src]')?.getAttribute('src');
				if (scriptSrc) await ensureExternalScript(scriptSrc);
				if (cancelled) return;

				const inlineScript =
					[...doc.querySelectorAll('script')].find((script) => !script.src)?.textContent ?? '';

				doc.querySelectorAll('script').forEach((script) => script.remove());

				if (!host) throw new Error('App host element is not available');
				host.innerHTML = doc.body.innerHTML;

				const runtimeWindow = window as RuntimeWindow;
				if (!runtimeWindow.__cptAppRuntimeLoaded) {
					removeNode(RUNTIME_SCRIPT_ID);
					const runtime = document.createElement('script');
					runtime.id = RUNTIME_SCRIPT_ID;
					runtime.textContent = `${inlineScript}\nwindow.__cptAppRuntimeLoaded = true;`;
					document.body.appendChild(runtime);
				}

				runtimeWindow.renderBanner?.();

				isLoading = false;
			} catch (error) {
				errorMessage = error instanceof Error ? error.message : 'Unknown startup error';
				isLoading = false;
			}
		}

		void bootstrap();

		return () => {
			cancelled = true;
			if (host) host.innerHTML = '';
		};
	});
</script>

<svelte:head>
	<title>CPT Interpreter — MADEP</title>
</svelte:head>

<div bind:this={host} data-cpt-app-root></div>

{#if isLoading}
	<div class="shell overlay">
		<div class="card">
			<h1>CPT Interpreter</h1>
			<p>Loading the converted SvelteKit app shell…</p>
		</div>
	</div>
{:else if errorMessage}
	<div class="shell overlay">
		<div class="card error">
			<h1>Startup Error</h1>
			<p>{errorMessage}</p>
			<p>The current embedded source is loaded from <code>cpt_app.html</code>.</p>
		</div>
	</div>
{/if}

<style>
	:global(html, body) {
		margin: 0;
		padding: 0;
		min-height: 100%;
	}

	[data-cpt-app-root] {
		min-height: 100vh;
	}

	.shell {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: 24px;
		background:
			radial-gradient(circle at top left, rgba(29, 158, 117, 0.18), transparent 34%),
			linear-gradient(180deg, #f4f5f1 0%, #e9ece6 100%);
		font-family:
			'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif;
		color: #1a1a18;
	}

	.overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
	}

	.card {
		width: min(560px, 100%);
		padding: 28px 30px;
		border-radius: 18px;
		background: rgba(255, 255, 255, 0.82);
		border: 1px solid rgba(0, 0, 0, 0.08);
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.08);
		backdrop-filter: blur(10px);
	}

	.card.error {
		border-color: rgba(180, 70, 40, 0.22);
	}

	h1 {
		margin: 0 0 10px;
		font-size: clamp(2rem, 4vw, 2.8rem);
		line-height: 1;
	}

	p {
		margin: 0;
		font-size: 1rem;
		line-height: 1.55;
	}

	p + p {
		margin-top: 10px;
	}

	code {
		font-family:
			'SFMono-Regular', ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas,
			monospace;
	}

	@media (prefers-color-scheme: dark) {
		.shell {
			background:
				radial-gradient(circle at top left, rgba(130, 185, 167, 0.16), transparent 34%),
				linear-gradient(180deg, #161b18 0%, #111513 100%);
			color: #ebe6dc;
		}

		.card {
			background: rgba(24, 29, 26, 0.88);
			border-color: rgba(255, 255, 255, 0.08);
			box-shadow: 0 18px 50px rgba(0, 0, 0, 0.28);
		}

		.card.error {
			border-color: rgba(200, 140, 110, 0.3);
		}
	}
</style>
