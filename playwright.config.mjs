// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser end-to-end tests (Chromium). `npm run test:e2e` starts the Vite dev server itself.
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  retries: 0,
  use: { baseURL: 'http://localhost:5199', viewport: { width: 1500, height: 950 }, screenshot: 'only-on-failure' },
  webServer: { command: 'npx vite dev --port 5199 --strictPort', url: 'http://localhost:5199/', reuseExistingServer: true, timeout: 60_000 },
  reporter: [['list']]
});
