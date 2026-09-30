import { defineConfig, devices } from '@playwright/test';

// Browser checks of a rendered sample site in a real Chromium.
// tests.capture_site serves the site and names its URL in LOTUSPOD_URL, so
// there is no webServer here; tests/test_browser_checks.py runs them.
export default defineConfig({
  testDir: 'checks',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: 0,
  reporter: 'line',
  use: {
    baseURL: process.env.LOTUSPOD_URL,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
