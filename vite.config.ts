import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [sveltekit()],
	server: {
		allowedHosts: ['.skymetrics.be']
	},
	preview: {
		allowedHosts: ['.skymetrics.be']
	}
});
