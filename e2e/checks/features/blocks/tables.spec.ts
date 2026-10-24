import { expect, test, type Page } from '@playwright/test';

// Tables on the capture fixture's two tables pages, one per variant, each with
// the same tables and comments on: every table fits the width it is given or
// scrolls inside itself, so the page never scrolls sideways; a long first
// cell no longer starves the columns after it, and a many-column table
// scrolls rather than squeezing; a top-level table never runs under the
// comments panel, open or folded, nor under the outline rail, and follows the
// panel as the window is resized. The threads route is answered here with no
// threads.
const ARTICLE = { url: '/capture-tables.html', slug: 'capture-tables' };
const REPORT = { url: '/capture-tables-report.html', slug: 'capture-tables-report' };
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': process.env.LOTUSPOD_TEST_ASSERTION ?? '' };
const TOP_LEVEL = '.artifact-body > table, .artifact-section-body > table';
const PANEL = 'aside.artifact-comments-panel';
// The fixture's tables, in page order, after the ledger.
const WIDE = 1;
const LONG_FIRST = 2;
const FINDINGS = 3;

type Box = { left: number; right: number; top: number; bottom: number };

test.use({ extraHTTPHeaders: SIGNED_IN });

async function load(page: Page, target: { url: string; slug: string }) {
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: target.slug, threads: [] } }));
  await page.goto(`${target.url}?standalone`);
  await expect(page.locator('.artifact-body table')).toHaveCount(7);
}

// Wait until the panel, if shown, has finished changing width, and a frame
// has been laid out since.
async function settle(page: Page) {
  await expect.poll(() => page.evaluate((selector) => {
    const aside = document.querySelector(selector);
    return aside ? aside.getAnimations().length : 0;
  }, PANEL)).toBe(0);
  await page.evaluate(() => new Promise((done) =>
    requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function openPanel(page: Page) {
  const aside = page.locator(PANEL);
  await aside.getByRole('button', { name: 'Comments', exact: true }).click();
  await expect(aside.getByRole('button', { name: 'Fold comments' })).toBeVisible();
  await expect.poll(async () => (await aside.boundingBox())!.width).toBeGreaterThan(300);
  await settle(page);
}

// The panel's box, or null while it is not shown.
async function panelBox(page: Page): Promise<Box | null> {
  return page.evaluate((selector) => {
    const aside = document.querySelector(selector);
    const box = aside && aside.getBoundingClientRect();
    return box && box.width > 0
      ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null;
  }, PANEL);
}

async function tableBoxes(page: Page, selector: string): Promise<Box[]> {
  return page.locator(selector).evaluateAll((tables) => tables.map((table) => {
    const box = table.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
  }));
}

function intersects(a: Box, b: Box) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

// The widths of a table's first body row's cells, and the table's.
async function columns(page: Page, index: number) {
  return page.locator('.artifact-body table').nth(index).evaluate((table) => ({
    table: table.getBoundingClientRect().width,
    cells: Array.from(table.querySelectorAll('tbody tr:first-child > *'), (cell) =>
      cell.getBoundingClientRect().width),
  }));
}

for (const target of [ARTICLE, REPORT]) {
  for (const size of SIZES) {
    test(`${target.slug} at ${size.width}x${size.height} never scrolls sideways`, async ({ page }) => {
      await page.setViewportSize(size);
      await load(page, target);
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        window: window.innerWidth,
      }));
      expect(widths.scroll).toBeLessThanOrEqual(widths.window);
    });

    test(`${target.slug} at ${size.width}x${size.height}: each table fits the window or scrolls itself`, async ({ page }) => {
      await page.setViewportSize(size);
      await load(page, target);
      const tables = await page.locator('.artifact-body table').evaluateAll((all) => all.map((table) => {
        const fits = table.getBoundingClientRect().right <= window.innerWidth;
        const scrolls = table.scrollWidth > table.clientWidth;
        table.scrollLeft = table.scrollWidth;
        const box = table.getBoundingClientRect();
        const heads = table.querySelectorAll('thead th');
        const last = heads[heads.length - 1].getBoundingClientRect();
        const shown = last.left >= box.left - 0.5 && last.right <= box.right + 0.5;
        return { fits, scrolls, shown };
      }));
      for (const table of tables) {
        expect(table.fits || (table.scrolls && table.shown), JSON.stringify(table)).toBe(true);
      }
    });
  }

  test(`${target.slug} at 390x844: the eight-column table scrolls rather than squeezing its cells`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await load(page, target);
    const wide = await page.locator('.artifact-body table').nth(WIDE).evaluate((table) => ({
      rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
      scrolls: table.scrollWidth > table.clientWidth,
      cells: Array.from(table.querySelectorAll('tbody td'), (cell) => cell.getBoundingClientRect().width),
    }));
    expect(wide.cells.length).toBe(16);
    for (const cell of wide.cells) expect(cell).toBeGreaterThanOrEqual(6 * wide.rem - 0.5);
    expect(wide.scrolls).toBe(true);
  });

  for (const size of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    test(`${target.slug} at ${size.width}x${size.height}: no table starts under the outline rail`, async ({ page }) => {
      await page.setViewportSize(size);
      await load(page, target);
      const outline = (await page.locator('nav.artifact-outline').boundingBox())!;
      const lefts = (await tableBoxes(page, '.artifact-body table')).map((box) => box.left);
      for (const left of lefts) expect(left).toBeGreaterThanOrEqual(outline.x + outline.width);
    });
  }
}

for (const size of [{ width: 1024, height: 768 }, { width: 768, height: 1024 }]) {
  test(`${REPORT.slug} at ${size.width}x${size.height}: a long first cell leaves the second column its room`, async ({ page }) => {
    await page.setViewportSize(size);
    await load(page, REPORT);
    const { table, cells } = await columns(page, LONG_FIRST);
    expect(cells.length).toBe(2);
    expect(cells[1] / table).toBeGreaterThanOrEqual(0.4);
  });
}

for (const size of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
  test(`${REPORT.slug} at ${size.width}x${size.height}: the findings table's long first column starves no other`, async ({ page }) => {
    await page.setViewportSize(size);
    await load(page, REPORT);
    await settle(page);
    const { table, cells } = await columns(page, FINDINGS);
    expect(cells.length).toBe(3);
    expect(Math.min(...cells) / table).toBeGreaterThanOrEqual(0.2);
    expect(cells[0] / table).toBeLessThanOrEqual(0.6);
  });
}

for (const [target, size] of [
  [REPORT, { width: 1440, height: 900 }],
  [REPORT, { width: 1700, height: 1000 }],
  [ARTICLE, { width: 1360, height: 900 }],
] as const) {
  test(`${target.slug} at ${size.width}x${size.height}: no top-level table runs under the open panel`, async ({ page }) => {
    await page.setViewportSize(size);
    await load(page, target);
    const aside = page.locator('aside.artifact-comments-panel');
    await aside.getByRole('button', { name: 'Comments', exact: true }).click();
    await expect(aside.getByRole('button', { name: 'Fold comments' })).toBeVisible();
    await expect.poll(async () => (await aside.boundingBox())!.width).toBeGreaterThan(300);
    await expect.poll(() => aside.evaluate((node) => node.getAnimations().length)).toBe(0);
    const left = (await aside.boundingBox())!.x;
    const rights = await page.locator(TOP_LEVEL).evaluateAll((tables) =>
      tables.map((table) => Math.round(table.getBoundingClientRect().right)));
    expect(rights.length).toBeGreaterThan(0);
    for (const right of rights) expect(right).toBeLessThanOrEqual(left);
  });
}

test(`${REPORT.slug} at 1440x900: no top-level table runs under the folded rail`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await load(page, REPORT);
  const aside = page.locator(PANEL);
  await expect(aside.getByRole('button', { name: 'Comments', exact: true })).toBeVisible();
  await expect(aside).not.toHaveClass(/artifact-comments-panel--open/);
  await settle(page);
  const rail = (await panelBox(page))!;
  expect(rail.right - rail.left).toBeLessThan(60);
  const tables = await tableBoxes(page, TOP_LEVEL);
  expect(tables.length).toBeGreaterThan(0);
  for (const table of tables) expect(intersects(table, rail), JSON.stringify({ table, rail })).toBe(false);
});

test(`${REPORT.slug}: the tables follow the open panel as the window is resized`, async ({ page, context }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await load(page, REPORT);
  await openPanel(page);
  for (const size of [
    { width: 1700, height: 1000 },
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 768, height: 1024 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(size);
    await settle(page);
    const resized = await tableBoxes(page, '.artifact-body table');
    const panel = await panelBox(page);
    for (const table of resized) {
      if (panel) expect(intersects(table, panel), `${size.width}: ${JSON.stringify({ table, panel })}`).toBe(false);
    }
    // A fresh load at this size, with the panel left open as the reader
    // left it.
    const fresh = await context.newPage();
    await fresh.setViewportSize(size);
    await load(fresh, REPORT);
    await settle(fresh);
    expect(await panelBox(fresh) === null).toBe(panel === null);
    const loaded = await tableBoxes(fresh, '.artifact-body table');
    await fresh.close();
    expect(resized.length).toBe(loaded.length);
    resized.forEach((table, index) => {
      const width = table.right - table.left;
      const want = loaded[index].right - loaded[index].left;
      expect(Math.abs(width - want), `${size.width}: table ${index} is ${width}, fresh ${want}`).toBeLessThanOrEqual(1);
    });
  }
});
