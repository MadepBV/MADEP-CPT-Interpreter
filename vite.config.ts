import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
	plugins: [sveltekit()],
	define: {
		// Report traceability: the printed appVersion must follow package.json.
		__APP_VERSION__: JSON.stringify(pkg.version)
	},
	server: {
		allowedHosts: ['.skymetrics.be']
	},
	preview: {
		allowedHosts: ['.skymetrics.be']
	}
});
