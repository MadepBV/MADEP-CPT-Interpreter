// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser tests (Chromium). `npm run test:e2e` starts the Vite dev server itself.
//   e2e    — behaviour tests, tests/e2e            (npx playwright test --project=e2e)
//   visual — screenshot baselines, tests/visual    (npx playwright test --project=visual [--update-snapshots])
import { defineConfig } from '@playwright/test';
export default defineConfig({
  timeout: 90_000,
  retries: 0,
  use: { baseURL: 'http://localhost:5199', viewport: { width: 1500, height: 950 }, screenshot: 'only-on-failure' },
  webServer: { command: 'npx vite dev --port 5199 --strictPort', url: 'http://localhost:5199/', reuseExistingServer: true, timeout: 60_000 },
  reporter: [['list']],
  projects: [
    { name: 'e2e', testDir: 'tests/e2e' },
    {
      name: 'visual',
      testDir: 'tests/visual',
      timeout: 300_000,
      snapshotPathTemplate: '{testDir}/__screenshots__/{testFileName}/{arg}{ext}',
      use: { deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' },
      expect: {
        toHaveScreenshot: { animations: 'disabled', caret: 'hide', scale: 'css', maxDiffPixels: 0, threshold: 0.01 },
        toMatchSnapshot: { maxDiffPixels: 0, threshold: 0.01 }
      }
    }
  ]
});
