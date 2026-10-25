import { expect, test, type Page } from '@playwright/test';

// serve's out-of-date marks on the capture fixture's stale page, which links
// a GitHub pull request the states file beside the database holds merged
// after the page's publish: its header's date line ends, after the Updated
// date, in the mark, and its index row in "may be out of date". A current
// page's row has none, and the page does not scroll sideways on a phone.
const PAGE = '/capture-stale.html';
const STALE = 'capture-stale';
const CURRENT = 'capture-owned';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': process.env.LOTUSPOD_TEST_ASSERTION ?? '' };
const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 360, height: 780 };
const MARK = 'may be out of date · 1 linked PR merged since';

test.use({ extraHTTPHeaders: SIGNED_IN });

async function open(page: Page, path: string) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(path);
  return errors;
}

function row(page: Page, name: string) {
  return page.locator(`.index-table tbody tr[data-page="${name}"]`);
}

for (const [label, size] of [['wide', WIDE], ['phone', PHONE]] as const) {
  test(`the stale page's header line holds the mark after its Updated date (${label})`, async ({ page }) => {
    await page.setViewportSize(size);
    const errors = await open(page, `${PAGE}?standalone`);
    const line = page.locator('header.artifact-header .artifact-meta');
    const mark = line.locator('.artifact-stale');
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText(MARK);
    await expect(mark).toHaveAttribute('title', 'acme/pond#7');
    const text = (await line.textContent()) ?? '';
    expect(text.indexOf('Updated')).toBeGreaterThan(-1);
    expect(text.indexOf(MARK)).toBeGreaterThan(text.indexOf('Updated'));
    expect(await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth,
    })).then(({ scroll, viewport }) => scroll <= viewport)).toBe(true);
    expect(errors).toEqual([]);
  });
}

test("the index marks the stale page's row and not a current one's", async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await open(page, '/');
  const stale = row(page, STALE);
  await expect(stale).toHaveCount(1);
  const mark = stale.locator('td.episode-title .index-stale');
  await expect(mark).toBeVisible();
  await expect(mark).toHaveText('may be out of date');
  // The mark ends the title cell, after its tags.
  expect(await stale.locator('td.episode-title').evaluate((cell) =>
    cell.lastElementChild?.className)).toBe('index-stale');
  await expect(row(page, CURRENT)).toHaveCount(1);
  await expect(row(page, CURRENT).locator('.index-stale')).toHaveCount(0);
  await expect(page.locator('.index-stale')).toHaveCount(1);
  expect(errors).toEqual([]);
});
