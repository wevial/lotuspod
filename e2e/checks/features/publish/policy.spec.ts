import { expect, test, type Page } from '@playwright/test';

type Violation = { blockedURI: string; effectiveDirective: string };

async function watch(page: Page) {
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as any).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  return {
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
