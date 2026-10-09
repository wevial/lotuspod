import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The pinned Mermaid (e2e/package.json) answers jsDelivr's requests for it.
// The route keeps the URL, so the page policy applies as it does for readers.
const MERMAID_DIR = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/';
const MERMAID_COPY = path.join(__dirname, '..', 'node_modules', 'mermaid');

type Violation = { blockedURI: string; effectiveDirective: string };

async function watch(page: Page) {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as any).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  await page.route(`${MERMAID_DIR}**`, async (route) => {
    const file = path.join(MERMAID_COPY, route.request().url().slice(MERMAID_DIR.length));
    if (!file.startsWith(MERMAID_COPY + path.sep) || !fs.existsSync(file)) {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'text/javascript',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: fs.readFileSync(file),
    });
  });
  return {
    consoleErrors,
    violations: () => page.evaluate(() => (window as any).__violations as Violation[]),
  };
}

test('body scripts and inline handlers do not run', async ({ page }) => {
  const seen = await watch(page);
  await page.goto('/capture-scripts.html?standalone');
  await expect(page.locator('#inline-output')).toHaveText('Nothing written.');

  await page.getByRole('button', { name: 'Press me' }).click();
  await expect(page.locator('#handler-output')).toHaveText('Nothing written.');
  await expect(page.locator('#inline-output')).toHaveText('Nothing written.');

  await expect.poll(async () => (await seen.violations()).length).toBeGreaterThanOrEqual(3);
  const violations = await seen.violations();
  expect(violations).toContainEqual({ blockedURI: 'inline', effectiveDirective: 'script-src-elem' });
  expect(violations).toContainEqual({
    blockedURI: 'https://scripts.example.com/widget.js',
    effectiveDirective: 'script-src-elem',
  });
  expect(violations).toContainEqual({ blockedURI: 'inline', effectiveDirective: 'script-src-attr' });
});

test('the diagram is drawn under the policy', async ({ page }) => {
  const seen = await watch(page);
  await page.goto('/capture-diagram.html?standalone');
  await expect(page.locator('pre.mermaid svg')).toBeVisible();
  await expect(page.locator('pre.mermaid svg')).toContainText('Publish');

  expect(await seen.violations()).toEqual([]);
  expect(seen.consoleErrors).toEqual([]);
});
