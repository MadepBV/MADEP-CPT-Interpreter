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
		watch: { ignored: ['**/.claude/**', '**/test-results/**', '**/tests/visual/__screenshots__/**'] }
	},
	preview: {
		allowedHosts: ['.skymetrics.be']
	}
});
