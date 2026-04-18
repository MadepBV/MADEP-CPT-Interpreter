<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
	import { onMount } from 'svelte';
	import CptInterpreterApp from '$lib/components/cpt/CptInterpreterApp.svelte';

	const pageTitle = 'CPT Interpreter — MADEP';
	const pageDescription =
		'Webapp voor CPT-interpretatie, laagindeling, EC7/NEN Tabel 3 parameterafleiding, zettingsscreening, draagkracht, bemalingseffecten en Stage 5 m-tuning.';
	const canonicalUrl = 'https://cpt.madep.be/';
	const ogImageUrl = 'https://cpt.madep.be/logo.png';
	const structuredData = {
		'@context': 'https://schema.org',
		'@type': 'SoftwareApplication',
		name: 'MADEP CPT Interpreter',
		applicationCategory: 'EngineeringApplication',
		operatingSystem: 'Web',
		url: canonicalUrl,
		description: pageDescription,
		image: ogImageUrl,
		provider: {
			'@type': 'Organization',
			name: 'MADEP',
			url: 'https://madep.be'
		}
	};

	onMount(() => {
		let cancelled = false;
		let destroy: (() => void) | undefined;

		(async () => {
			const mod = await import('$lib/cpt-app/legacy-controller.js');
			if (cancelled) return;
			destroy = mod.initLegacyController?.();
		})();

		return () => {
			cancelled = true;
			destroy?.();
		};
	});
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content={pageDescription} />
	<meta name="author" content="MADEP" />
	<link rel="canonical" href={canonicalUrl} />

	<meta property="og:type" content="website" />
	<meta property="og:locale" content="nl_BE" />
	<meta property="og:site_name" content="MADEP" />
	<meta property="og:title" content={pageTitle} />
	<meta property="og:description" content={pageDescription} />
	<meta property="og:url" content={canonicalUrl} />
	<meta property="og:image" content={ogImageUrl} />

	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:title" content={pageTitle} />
	<meta name="twitter:description" content={pageDescription} />
	<meta name="twitter:image" content={ogImageUrl} />

	<script type="application/ld+json">
		{JSON.stringify(structuredData)}
	</script>
	<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
</svelte:head>

<CptInterpreterApp />
