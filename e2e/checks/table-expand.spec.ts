import { expect, test, type Browser, type Page } from '@playwright/test';

// The Expand button on the capture fixture's two tables pages, one per
// variant, each opening on a ledger far wider than its column. By default
// every table keeps the width it has at 1920 pixels, the ledger scrolling
// inside itself; where the window has free width right of it, the ledger
// gets a button that widens it to its natural width or up to just short of
// the comments panel, its left edge and everything above it unmoved, what is
// below moving up as it gets shorter, and its top kept in place in the
// window. The widening follows the panel and the window, the choice is kept
// for the tab's session, and the button takes no room. The threads route is
// answered here with no threads.
const ARTICLE = { url: '/capture-tables.html', slug: 'capture-tables' };
const REPORT = { url: '/capture-tables-report.html', slug: 'capture-tables-report' };
const TARGETS = [ARTICLE, REPORT];
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': process.env.LOTUSPOD_TEST_ASSERTION ?? '' };
const TOP_LEVEL = '.artifact-body > table, .artifact-section-body > table';
const PANEL = 'aside.artifact-comments-panel';
const BUTTON = '.artifact-table-expand-button';
const ULTRAWIDE = { width: 3440, height: 1440 };
const WIDE = { width: 2560, height: 1440 };
const DEFAULT = { width: 1920, height: 1080 };
const LAPTOP = { width: 1440, height: 900 };
// The gutter the room keeps before the panel or the window's edge.
const GUTTER = 16;
// The fixture's tables, in page order: the ledger, the small table and the
// table inside a list item.
const LEDGER = 0;
const SMALL = 5;
const LISTED = 6;
// Where the ledger can be expanded: each page at 3440 with the panel folded
// and at 2560 with it open.
const EXPANDING = TARGETS.flatMap((target) => [
  { target, size: ULTRAWIDE, open: false },
  { target, size: WIDE, open: true },
]);

type Target = typeof ARTICLE;
type Size = typeof ULTRAWIDE;
type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

test.use({ extraHTTPHeaders: SIGNED_IN });

async function load(page: Page, target: Target) {
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: target.slug, threads: [] } }));
  await page.goto(`${target.url}?standalone`);
  await expect(page.locator('.artifact-body table')).toHaveCount(7);
  await settle(page);
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

async function foldPanel(page: Page) {
  const aside = page.locator(PANEL);
  await aside.getByRole('button', { name: 'Fold comments' }).click();
  await expect(aside.getByRole('button', { name: 'Comments', exact: true })).toBeVisible();
  await expect.poll(async () => (await aside.boundingBox())!.width).toBeLessThan(60);
  await settle(page);
}

// A page at a size with the panel open or folded.
async function at(page: Page, target: Target, size: Size, open: boolean) {
  await page.setViewportSize(size);
  await load(page, target);
  if (open) await openPanel(page);
}

// The panel's left edge; the panel is shown wherever these checks look.
async function panelLeft(page: Page) {
  const left = await page.evaluate((selector) => {
    const aside = document.querySelector(selector);
    const box = aside && aside.getBoundingClientRect();
    return box && box.width > 0 ? box.left : null;
  }, PANEL);
  expect(left).not.toBeNull();
  return left!;
}

function table(page: Page, index = LEDGER) {
  return page.locator('.artifact-body table').nth(index);
}

// The button that expands the table at index, found by the table it names.
async function button(page: Page, index = LEDGER) {
  const id = await table(page, index).getAttribute('id');
  expect(id, `table ${index} has an id`).toBeTruthy();
  return page.locator(`button[aria-controls="${id}"]`);
}

async function box(page: Page, index = LEDGER): Promise<Box> {
  return table(page, index).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      width: rect.width, height: rect.height,
    };
  });
}

// The ledger's natural width: a copy of it at width: max-content, uncapped.
async function natural(page: Page) {
  return table(page).evaluate((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.removeAttribute('id');
    copy.style.position = 'absolute';
    copy.style.visibility = 'hidden';
    copy.style.width = 'max-content';
    copy.style.maxWidth = 'none';
    node.parentNode!.appendChild(copy);
    const width = copy.getBoundingClientRect().width;
    copy.remove();
    return width;
  });
}

async function topLevelWidths(page: Page) {
  return page.locator(TOP_LEVEL).evaluateAll((tables) =>
    tables.map((node) => node.getBoundingClientRect().width));
}

async function sideways(page: Page) {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    window: window.innerWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.window);
}

// Every top-level block of the body, a section's blocks standing in for its
// wrapper, in page order and in page coordinates, the button holders left
// out; whether each is a section's comment box.
function blocks(page: Page) {
  return page.evaluate(() => {
    const body = document.querySelector('.artifact-body')!;
    const ledger = body.querySelector('table');
    const found: {
      name: string; ledger: boolean; comment: boolean;
      left: number; top: number; width: number; height: number;
    }[] = [];
    for (const child of Array.from(body.children)) {
      const inner = child.classList.contains('artifact-section-body') ? Array.from(child.children) : [child];
      for (const node of inner) {
        if (node.classList.contains('artifact-table-expand')) continue;
        const rect = node.getBoundingClientRect();
        found.push({
          name: `${node.tagName} ${found.length}`, ledger: node === ledger,
          comment: node.matches('details.artifact-comment'),
          left: rect.left, top: rect.top + window.scrollY, width: rect.width, height: rect.height,
        });
      }
    }
    return found;
  });
}

async function expectExpand(page: Page) {
  const expand = await button(page);
  await expect(expand).toBeVisible();
  await expect(expand).toHaveText('Expand');
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
}

async function expectCollapse(page: Page) {
  const expand = await button(page);
  await expect(expand).toBeVisible();
  await expect(expand).toHaveText('Collapse');
  await expect(expand).toHaveAttribute('aria-expanded', 'true');
}

// Press the ledger's button without Playwright scrolling it into view.
async function press(page: Page) {
  await (await button(page)).evaluate((node) => (node as HTMLButtonElement).click());
}

// The ledger expanded: it ends short of the panel, at its natural width or
// at the panel's gutter.
async function expectExpanded(page: Page, first: Box) {
  const now = await box(page);
  const limit = (await panelLeft(page)) - GUTTER;
  const want = await natural(page);
  expect(Math.abs(now.left - first.left)).toBeLessThanOrEqual(1);
  expect(now.right).toBeLessThanOrEqual(limit + 0.5);
  expect(Math.abs(now.width - want) <= 2 || limit - now.right <= 2,
    JSON.stringify({ now, want, limit })).toBe(true);
  await expectCollapse(page);
  await sideways(page);
  return now;
}

for (const target of TARGETS) {
  for (const size of [ULTRAWIDE, WIDE]) {
    for (const open of [false, true]) {
      test(`${target.slug} at ${size.width}x${size.height}, panel ${open ? 'open' : 'folded'}: tables keep their width at 1920`, async ({ page, context }) => {
        await at(page, target, size, open);
        const widths = await topLevelWidths(page);
        const scrolls = await table(page).evaluate((node) => node.scrollWidth > node.clientWidth);
        // The panel left as it was: a page loaded after this one opens it so.
        const fresh = await context.newPage();
        await fresh.setViewportSize(DEFAULT);
        await load(fresh, target);
        const opened = expect(fresh.locator(PANEL));
        await (open ? opened : opened.not).toHaveClass(/artifact-comments-panel--open/);
        const want = await topLevelWidths(fresh);
        await fresh.close();
        expect(widths.length).toBe(want.length);
        widths.forEach((width, index) =>
          expect(Math.abs(width - want[index]), `table ${index}: ${width}, at 1920 ${want[index]}`).toBeLessThanOrEqual(1));
        expect(scrolls).toBe(true);
      });
    }
  }

  test(`${target.slug} at 3440x1440: the ledger has an Expand button, the small and listed tables none`, async ({ page }) => {
    await at(page, target, ULTRAWIDE, false);
    await expectExpand(page);
    await expect(await button(page, SMALL)).toBeHidden();
    await expect(page.locator(`li table ~ ${BUTTON}, li .artifact-table-expand`)).toHaveCount(0);
    expect(await table(page, LISTED).evaluate((node) => node.closest('li') !== null)).toBe(true);
  });
}

for (const open of [false, true]) {
  test(`${REPORT.slug} at 1440x900, panel ${open ? 'open' : 'folded'}: no room, no button`, async ({ page }) => {
    await at(page, REPORT, LAPTOP, open);
    await expect(table(page)).toHaveAttribute('id', /.+/);
    await expect(await button(page)).toBeHidden();
  });
}

test(`${ARTICLE.slug} at 1440x900, panel folded: the ledger has an Expand button`, async ({ page }) => {
  await at(page, ARTICLE, LAPTOP, false);
  await expectExpand(page);
});

for (const { target, size, open } of EXPANDING) {
  const name = `${target.slug} at ${size.width}x${size.height}, panel ${open ? 'open' : 'folded'}`;

  test(`${name}: Expand widens the ledger to the right, Collapse restores it`, async ({ page }) => {
    await at(page, target, size, open);
    await expectExpand(page);
    const first = await box(page);
    await (await button(page)).click();
    await expectExpanded(page, first);
    await (await button(page)).click();
    const back = await box(page);
    expect(Math.abs(back.width - first.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.height - first.height)).toBeLessThanOrEqual(1);
    await expectExpand(page);
  });

  test(`${name}: nothing above or beside the ledger moves, what is below moves up`, async ({ page }) => {
    await at(page, target, size, open);
    const outline = page.locator('nav.artifact-outline');
    const rail = (await outline.boundingBox())!;
    const before = await blocks(page);
    const first = await box(page);
    await (await button(page)).click();
    const expanded = await expectExpanded(page, first);
    const after = await blocks(page);
    expect(after.length).toBe(before.length);
    const shorter = first.height - expanded.height;
    expect(shorter).toBeGreaterThan(0);
    const ledger = before.findIndex((block) => block.ledger);
    expect(ledger).toBeGreaterThan(0);
    before.forEach((was, index) => {
      const now = after[index];
      const label = `${was.name}: ${JSON.stringify({ was, now })}`;
      expect(Math.abs(now.left - was.left), label).toBeLessThanOrEqual(1);
      if (index < ledger) {
        expect(Math.abs(now.top - was.top), label).toBeLessThanOrEqual(1);
        expect(Math.abs(now.width - was.width), label).toBeLessThanOrEqual(1);
        expect(Math.abs(now.height - was.height), label).toBeLessThanOrEqual(1);
      } else if (index > ledger) {
        expect(Math.abs(now.width - was.width), label).toBeLessThanOrEqual(1);
        expect(Math.abs(was.top - now.top - shorter), label).toBeLessThanOrEqual(1);
      }
    });
    const railNow = (await outline.boundingBox())!;
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      expect(Math.abs(railNow[key] - rail[key]), key).toBeLessThanOrEqual(1);
    }
  });

  for (const offset of [200, -300]) {
    test(`${name}: with the ledger's top ${offset} px into the window, it stays there`, async ({ page }) => {
      await at(page, target, size, open);
      await page.evaluate(({ index, offset }) => {
        const node = document.querySelectorAll('.artifact-body table')[index];
        window.scrollTo(0, node.getBoundingClientRect().top + window.scrollY - offset);
      }, { index: LEDGER, offset });
      await settle(page);
      const first = await box(page);
      expect(Math.abs(first.top - offset)).toBeLessThanOrEqual(1);
      await press(page);
      await settle(page);
      await expectCollapse(page);
      expect(Math.abs((await box(page)).top - offset)).toBeLessThanOrEqual(1);
      await press(page);
      await settle(page);
      await expectExpand(page);
      const back = await box(page);
      expect(Math.abs(back.top - offset)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.height - first.height)).toBeLessThanOrEqual(1);
    });
  }
}

test(`${ARTICLE.slug} at 3440x1440: Enter and Space on the focused button expand and collapse`, async ({ page }) => {
  await at(page, ARTICLE, ULTRAWIDE, false);
  const expand = await button(page);
  for (let presses = 0; presses < 60; presses += 1) {
    await page.keyboard.press('Tab');
    if (await expand.evaluate((node) => node === document.activeElement)) break;
  }
  await expect(expand).toBeFocused();
  const first = await box(page);
  await page.keyboard.press('Enter');
  await expectExpanded(page, first);
  await expect(expand).toBeFocused();
  await page.keyboard.press('Space');
  await expectExpand(page);
  await expect(expand).toBeFocused();
  expect(Math.abs((await box(page)).width - first.width)).toBeLessThanOrEqual(1);
});

for (const target of TARGETS) {
  test(`${target.slug} at 3440x1440: the expanded ledger follows the panel opening and folding`, async ({ page }) => {
    await at(page, target, ULTRAWIDE, false);
    const first = await box(page);
    await (await button(page)).click();
    const expanded = await expectExpanded(page, first);
    await openPanel(page);
    const beside = await box(page);
    expect(beside.right).toBeLessThanOrEqual((await panelLeft(page)) - GUTTER + 0.5);
    await expectCollapse(page);
    await foldPanel(page);
    expect(Math.abs((await box(page)).width - expanded.width)).toBeLessThanOrEqual(1);
    await expectCollapse(page);
  });
}

test(`${REPORT.slug}: the expanded ledger re-fits as the window is resized`, async ({ page, browser }) => {
  await at(page, REPORT, ULTRAWIDE, false);
  const first = await box(page);
  await (await button(page)).click();
  const expanded = await expectExpanded(page, first);
  for (const size of [WIDE, LAPTOP, ULTRAWIDE]) {
    await page.setViewportSize(size);
    await settle(page);
    const now = await box(page);
    expect(now.right, `${size.width}`).toBeLessThanOrEqual((await panelLeft(page)) - GUTTER + 0.5);
    await sideways(page);
    if (size === LAPTOP) {
      await expect(await button(page)).toBeHidden();
      const collapsed = await freshWidth(browser, REPORT, LAPTOP);
      expect(Math.abs(now.width - collapsed)).toBeLessThanOrEqual(1);
    } else {
      await expectCollapse(page);
    }
  }
  expect(Math.abs((await box(page)).width - expanded.width)).toBeLessThanOrEqual(1);
});

// The ledger's width on a fresh visit at a size.
async function freshWidth(browser: Browser, target: Target, size: Size) {
  const context = await browser.newContext({ viewport: size, extraHTTPHeaders: SIGNED_IN });
  const page = await context.newPage();
  await load(page, target);
  const width = (await box(page)).width;
  await context.close();
  return width;
}

test(`${ARTICLE.slug} at 3440x1440: the choice is kept for the tab's session`, async ({ page, browser }) => {
  await at(page, ARTICLE, ULTRAWIDE, false);
  const first = await box(page);
  await (await button(page)).click();
  const expanded = await expectExpanded(page, first);
  await page.reload();
  await expect(page.locator('.artifact-body table')).toHaveCount(7);
  await settle(page);
  await expectCollapse(page);
  expect(Math.abs((await box(page)).width - expanded.width)).toBeLessThanOrEqual(1);

  const context = await browser.newContext({ viewport: ULTRAWIDE, extraHTTPHeaders: SIGNED_IN });
  const fresh = await context.newPage();
  await load(fresh, ARTICLE);
  await expectExpand(fresh);
  expect(Math.abs((await box(fresh)).width - first.width)).toBeLessThanOrEqual(1);
  await context.close();
});

test(`${ARTICLE.slug} at 3440x1440: with sessionStorage refused, Expand still works, unremembered`, async ({ browser }) => {
  const context = await browser.newContext({ viewport: ULTRAWIDE, extraHTTPHeaders: SIGNED_IN });
  await context.addInitScript(() => {
    const refuse = () => { throw new DOMException('The operation is insecure.', 'SecurityError'); };
    Object.defineProperty(window, 'sessionStorage', { configurable: true, get: refuse });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await load(page, ARTICLE);
  expect(await page.evaluate(() => {
    try {
      return window.sessionStorage === null;
    } catch {
      return 'refused';
    }
  })).toBe('refused');
  const first = await box(page);
  await (await button(page)).click();
  await expectExpanded(page, first);
  await page.reload();
  await expect(page.locator('.artifact-body table')).toHaveCount(7);
  await settle(page);
  await expectExpand(page);
  expect(Math.abs((await box(page)).width - first.width)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
  await context.close();
});

// Both pages are measured as they load, nothing hidden or left out but the
// holders, which a page without scripts does not have and which must have
// no height: every block, comment boxes included, has the same top and
// height with scripts as without.
for (const target of TARGETS) {
  test(`${target.slug} at 3440x1440: the buttons take no room`, async ({ browser }) => {
    const pages: Awaited<ReturnType<typeof blocks>>[] = [];
    for (const javaScriptEnabled of [true, false]) {
      const context = await browser.newContext({ viewport: ULTRAWIDE, extraHTTPHeaders: SIGNED_IN, javaScriptEnabled });
      const page = await context.newPage();
      await page.route((url) => url.pathname === '/api/comments', (route) =>
        route.fulfill({ json: { page: target.slug, threads: [] } }));
      await page.goto(`${target.url}?standalone`);
      await expect(page.locator('.artifact-body table')).toHaveCount(7);
      if (javaScriptEnabled) {
        await settle(page);
        await expectExpand(page);
        const holders = await page.locator('.artifact-table-expand').evaluateAll((nodes) =>
          nodes.map((node) => node.getBoundingClientRect().height));
        expect(holders.length).toBeGreaterThan(0);
        for (const height of holders) expect(height).toBe(0);
      }
      pages.push(await blocks(page));
      await context.close();
    }
    const [scripted, plain] = pages;
    expect(scripted.map((block) => block.name)).toEqual(plain.map((block) => block.name));
    scripted.forEach((block, index) => {
      const counterpart = plain[index];
      const label = `${block.name}: ${JSON.stringify({ block, counterpart })}`;
      expect(block.comment, label).toBe(counterpart.comment);
      expect(Math.abs(block.top - counterpart.top), label).toBeLessThanOrEqual(1);
      expect(Math.abs(block.height - counterpart.height), label).toBeLessThanOrEqual(1);
    });
  });
}
