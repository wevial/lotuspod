import { defineConfig, devices } from '@playwright/test';

// Browser checks of a rendered sample site in a real Chromium.
// tests.capture_site serves the site and names its URL in LOTUSPOD_URL, so
// there is no webServer here; tests/test_browser_checks.py runs them.
export default defineConfig({
  testDir: 'checks',
  testMatch: '**/*.spec.ts',
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: 'line',
  use: {
    baseURL: process.env.LOTUSPOD_URL,
    // A dark system, so a page left on Auto reads in Night, the theme these
    // were written against; a check of Dawn asks for it.
    colorScheme: 'dark',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
