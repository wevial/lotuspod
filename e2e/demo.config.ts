import { defineConfig, devices } from '@playwright/test';

// Browser checks of the demo site (python -m demo.build) in a real Chromium,
// at 1280 px. `python -m demo.build --serve -- CMD` serves the built site,
// names its URL in LOTUSPOD_URL and its request log in LOTUSPOD_DEMO_LOG, so
// there is no webServer here; tests/test_demo_checks.py runs them.
export default defineConfig({
  testDir: 'demo',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: process.env.LOTUSPOD_URL,
    viewport: { width: 1280, height: 800 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
