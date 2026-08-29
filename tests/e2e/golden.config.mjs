// SPDX-License-Identifier: AGPL-3.0-or-later
// Playwright config for the Tier C golden journeys (tests/e2e/golden-journey.spec.mjs).
// Separate from playwright.config.mjs on purpose: own port (5299) so it can run next to
// the behaviour/visual suites, one worker (journeys share tests/golden/.actual), no
// retries (a retry would hide a determinism leak), and snapshotDir pointed at
// tests/golden/browser so `<journey>/<step>.png` sits next to state.json / dom.txt.
//
//   GOLDEN_MODE=record|check|update   (default check)  — see scripts/golden/lib/journey.mjs
//   GOLDEN_VISUAL=off|soft|strict     (default soft)   — PNG compare policy
//   GOLDEN_PORT=<n>                   (default 5299)   — dev-server port, so two worktrees can
//                                                        run side by side (bisect-journey); also
//                                                        `--port=<n>` / `--port <n>` on the CLI
//
//   npx playwright test --config tests/e2e/golden.config.mjs
//   GOLDEN_PORT=5399 npx playwright test --config tests/e2e/golden.config.mjs
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const MODE = process.env.GOLDEN_MODE || 'check';
const cliPort = (() => {
  const i = process.argv.findIndex((a) => a === '--port' || a.startsWith('--port='));
  if (i < 0) return null;
  return process.argv[i].includes('=') ? process.argv[i].split('=')[1] : process.argv[i + 1];
})();
const PORT = Number(process.env.GOLDEN_PORT || cliPort || 5299);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: /golden-journey\.spec\.mjs$/,
  timeout: 900_000,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  // record/update: (re)write every PNG; check: compare only, a missing PNG is a (soft) mismatch
  updateSnapshots: MODE === 'check' ? 'none' : 'all',
  snapshotDir: '../golden/browser',
  snapshotPathTemplate: '{snapshotDir}/{arg}{ext}',
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1500, height: 950 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'nl-BE',
    timezoneId: 'Europe/Brussels',
    acceptDownloads: true,
    screenshot: 'off',
    trace: 'off',
    video: 'off'
  },
  webServer: {
    command: `npx vite dev --port ${PORT} --strictPort`,
    cwd: ROOT,
    url: `${BASE_URL}/`,
    reuseExistingServer: true,
    timeout: 60_000
  },
  projects: [{ name: 'golden' }]
});
