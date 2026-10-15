import { expect, test, type Page } from '@playwright/test';

// The capture fixture's calltree page (tests/capture_site.py): its first
// section holds a fence linked to GitHub, its second an unlinked fence with
// one line that doesn't parse.
const URL = '/capture-calltree.html?standalone';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': process.env.LOTUSPOD_TEST_ASSERTION ?? '' };
test.use({ viewport: { width: 1280, height: 800 }, extraHTTPHeaders: SIGNED_IN });

type Violation = { blockedURI: string; effectiveDirective: string };

async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    (window as any).__violations = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push({ blockedURI: event.blockedURI, effectiveDirective: event.effectiveDirective });
    });
  });
  return {
    async clean() {
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => (window as any).__violations as Violation[])).toEqual([]);
    },
  };
}

test('scripts load without console errors or CSP violations', async ({ page }) => {
  const seen = await watch(page);
  await page.goto(URL);
  await expect(page.locator('.calltree').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  await seen.clean();
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('all rows, marker colors and chips render statically', async ({ page }) => {
    await page.goto(URL);
    const tree = page.locator('.calltree').first();
    await expect(tree.locator('.calltree-row')).toHaveCount(10);
    await expect(tree.locator('.calltree-summary')).toHaveText('3 changed · 3 new · across 3 files');
    await expect(tree.locator('[data-kind="new"] .calltree-mark').first()).toHaveCSS('color', 'rgb(146, 217, 181)');
    await expect(tree.locator('[data-kind="changed"] .calltree-mark').first()).toHaveCSS('color', 'rgb(235, 197, 127)');
    await expect(tree.locator('[data-kind="context"] .calltree-name').first()).toHaveCSS('color', 'rgb(148, 138, 173)');
    await expect(tree.locator('[data-kind="context"] .calltree-chip').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const backgrounds = await Promise.all(['new', 'changed'].map(kind => tree.locator(`[data-kind="${kind}"] .calltree-chip`).first().evaluate(node => getComputedStyle(node).backgroundColor)));
    expect(backgrounds[0]).not.toBe(backgrounds[1]);
    for (const color of backgrounds) expect(color).not.toBe('rgba(0, 0, 0, 0)');
    await expect(page.locator('.calltree').nth(1).locator('a')).toHaveCount(0);
    await expect(page.locator('.calltree').nth(1).locator('[data-kind="text"]')).toHaveText('   <unparsed & "text">');
  });

  test('at 390px only the tree scrolls and the summary stays visible', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL);
    const tree = page.locator('.calltree').first();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const scroll = await tree.evaluate(node => {
      const overflow = node.scrollWidth > node.clientWidth;
      node.scrollLeft = 120;
      return { overflow, left: node.scrollLeft };
    });
    expect(scroll.overflow).toBe(true);
    expect(scroll.left).toBeGreaterThan(0);
    const box = (await tree.boundingBox())!;
    const summary = (await tree.locator('.calltree-summary').boundingBox())!;
    expect(summary.x).toBeGreaterThanOrEqual(box.x);
    expect(summary.x + summary.width).toBeLessThanOrEqual(box.x + box.width);
  });
});
