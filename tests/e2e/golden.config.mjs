// SPDX-License-Identifier: AGPL-3.0-or-later
// Playwright config for the Tier C golden journeys (tests/e2e/golden-journey.spec.mjs).
// Separate from playwright.config.mjs on purpose: own port (5299, GOLDEN_PORT to override) so it can run next to
// the behaviour/visual suites, one worker (journeys share tests/golden/.actual), no
// retries (a retry would hide a determinism leak), and snapshotDir pointed at
// tests/golden/browser so `<journey>/<step>.png` sits next to state.json / dom.txt.
//
//   GOLDEN_MODE=record|check|update   (default check)  — see scripts/golden/lib/journey.mjs
//   GOLDEN_VISUAL=off|soft|strict     (default soft)   — PNG compare policy
//
//   npx playwright test --config tests/e2e/golden.config.mjs
import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const MODE = process.env.GOLDEN_MODE || 'check';

const PORT = Number(process.env.GOLDEN_PORT) || 5299;
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
    baseURL: `http://localhost:${PORT}`,
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
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: true,
    timeout: 60_000
  },
  projects: [{ name: 'golden' }]
});
