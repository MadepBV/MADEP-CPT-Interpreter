import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	compilerOptions: {
		// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
		runes: ({ filename }) => (filename.split(/[/\\]/).includes('node_modules') ? undefined : true)
	},
	kit: {
		adapter: adapter(),
		typescript: {
			// keep the vendored Chart.js copy used by the golden browser tier out of svelte-check
			config: (cfg) => { cfg.exclude = [...(cfg.exclude || []), '../tests/golden/vendor/**']; return cfg; }
		}
	}
};

export default config;
