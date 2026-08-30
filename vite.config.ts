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
		allowedHosts: ['.skymetrics.be'],
		// Agent worktrees (.claude/worktrees/*) and Playwright output live inside the repo; a build in a
		// worktree writes build/*.html, which the watcher otherwise turns into full page reloads.
		watch: { ignored: ['**/.claude/**', '**/test-results/**', '**/tests/visual/__screenshots__/**', '**/.svelte-kit/output/**', '**/.svelte-kit/generated/**', '**/build/**'] },
		// An agent worktree symlinks node_modules to the main checkout, which lands outside the server
		// root; without this the SvelteKit client entry is served as 403 and every browser test fails
		// at its first click (PR 18e/18g). Harmless in the main checkout.
		fs: { allow: [new URL('.', import.meta.url).pathname, new URL('./node_modules', import.meta.url).pathname] }
	},
	preview: {
		allowedHosts: ['.skymetrics.be']
	}
});
