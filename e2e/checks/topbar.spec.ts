import { expect, test, type Locator, type Page } from '@playwright/test';

// The title bar from the top of the page: the capture fixture's palette
// page, which has five sections, comments and room to scroll 600 pixels at
// 1440 by 900, and the same page on a 360-pixel phone.
// The bar is visible at scroll 0, the page reserves its height so nothing in
// the page starts under it, and the open comments panel meets the bar's
// bottom edge wherever the page is scrolled. The threads route is answered
// here, with no threads, so the check posts nothing to the site.
const PAGE = '/capture-palette.html';
const SLUG = 'capture-palette';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': process.env.LOTUSPOD_TEST_ASSERTION ?? '' };
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 360, height: 780 };
const SCROLL = 600;

test.use({ extraHTTPHeaders: SIGNED_IN });

function rect(target: Locator) {
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
  });
}

// What the bar's computed style says about whether it shows.
function shown(bar: Locator) {
  return bar.evaluate((node) => {
    const style = getComputedStyle(node);
    return { opacity: style.opacity, transform: style.transform, visibility: style.visibility };
  });
}

async function load(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: SLUG, threads: [] } }));
  await page.goto(PAGE);
  await expect(page.locator('details.artifact-comment').first()).toBeAttached();
  expect(await page.locator('.artifact-body h2').count()).toBeGreaterThanOrEqual(2);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  return errors;
}

async function scrollTo(page: Page, y: number) {
  await page.evaluate((top) => window.scrollTo(0, top), y);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(y);
}

test('at scroll 0 the bar is visible and the back link starts below it', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await load(page);
  const bar = page.locator('.artifact-topbar');
  await expect(bar).toBeVisible();
  expect(await shown(bar)).toEqual({ opacity: '1', transform: 'none', visibility: 'visible' });
  const edge = (await rect(bar)).bottom;
  expect(edge).toBeGreaterThan(0);
  const back = page.locator('.artifact-nav a');
  await expect(back).toHaveText(/Lotuspod/);
  expect((await rect(back)).top).toBeGreaterThanOrEqual(edge);
  expect((await rect(page.locator('.artifact-header'))).top).toBeGreaterThanOrEqual(edge);
  expect((await rect(page.locator('.artifact-outline'))).top).toBeGreaterThanOrEqual(edge);
  expect(errors).toEqual([]);
});

test('the open panel meets the bar at scroll 0 and after scrolling, and does not move', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await load(page);
  const bar = page.locator('.artifact-topbar');
  const aside = page.locator('aside.artifact-comments-panel');
  await aside.getByRole('button', { name: 'Comments', exact: true }).click();
  await expect(aside.getByRole('button', { name: 'Fold comments' })).toBeVisible();
  const atTop = { bar: await rect(bar), panel: await rect(aside) };
  expect(Math.abs(atTop.panel.top - atTop.bar.bottom)).toBeLessThanOrEqual(1);

  // The page is long enough to scroll the whole way.
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight))
    .toBeGreaterThanOrEqual(SCROLL);
  await scrollTo(page, SCROLL);
  expect(await shown(bar)).toEqual({ opacity: '1', transform: 'none', visibility: 'visible' });
  const scrolled = { bar: await rect(bar), panel: await rect(aside) };
  expect(Math.abs(scrolled.panel.top - scrolled.bar.bottom)).toBeLessThanOrEqual(1);
  expect(scrolled.panel.top).toBe(atTop.panel.top);
  expect(scrolled.bar).toEqual(atTop.bar);
  expect(errors).toEqual([]);
});

test('on a phone the bar is visible at scroll 0, the title is clear of it, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const errors = await load(page);
  const bar = page.locator('.artifact-topbar');
  await expect(bar).toBeVisible();
  expect(await shown(bar)).toEqual({ opacity: '1', transform: 'none', visibility: 'visible' });
  const edge = (await rect(bar)).bottom;
  const title = page.locator('h1.artifact-title');
  const heading = await rect(title);
  expect(heading.top).toBeGreaterThanOrEqual(edge);
  // Nothing lies over the title: the topmost node at its middle is the title.
  const middle = { x: (heading.left + heading.right) / 2, y: (heading.top + heading.bottom) / 2 };
  expect(await page.evaluate(({ x, y }) =>
    document.elementFromPoint(x, y)?.closest('h1.artifact-title') !== null, middle)).toBe(true);
  expect((await rect(page.locator('.artifact-nav a'))).top).toBeGreaterThanOrEqual(edge);
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.viewport);
  expect(errors).toEqual([]);
});
