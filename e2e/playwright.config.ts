import { defineConfig, devices } from '@playwright/test';

// Captures of a rendered sample site. tests.capture_site serves the site and
// names its URL in LOTUSPOD_URL, so there is no webServer here.
export default defineConfig({
  testDir: 'smoke',
  testMatch: '**/*.capture.ts',
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
