import { expect, test, type Locator, type Page } from '@playwright/test';

// The open comments panel resized from the handle on its left edge: dragged,
// or a rem at a time with the arrow keys, between 16rem and a maximum of
// 40rem, at most a third of the window, that never leaves the reading column
// narrower than 32rem; the width is remembered for every page, kept through a
// storage that throws, reset by a double-click, and clamped to a narrower
// window without being forgotten.
// A panel widened into the column narrows it and its tables, and the passage
// the reader was on stays put. The capture fixture's comments, sections and
// report tables pages at 1440 pixels; the threads route is answered here with
// no threads.
const COMMENTS = { url: '/capture-comments.html', slug: 'capture-comments' };
const SECTIONS = { url: '/capture-sections.html', slug: 'capture-sections' };
const TABLES = { url: '/capture-tables-report.html', slug: 'capture-tables-report' };
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': process.env.LOTUSPOD_TEST_ASSERTION ?? '' };
const WIDTH = 'lotuspod:comments-width';
const PANEL = 'aside.artifact-comments-panel';
const TOP_LEVEL = '.artifact-body > table, .artifact-section-body > table';
const WIDE = { width: 1440, height: 900 };
const REM = 16;

test.use({ viewport: WIDE, extraHTTPHeaders: SIGNED_IN });

// Console errors and uncaught exceptions.
function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

// A thread in the comments page's Findings section, answered by hermes.
const ROOT = {
  id: 951_001, page: COMMENTS.slug, section: 'findings', sectionTitle: 'Findings', revision: '',
  parent: null, text: 'Does the pump stop when the pond freezes?', quote: null,
  actor: { kind: 'human', name: 'maintainer' }, createdAt: '2026-10-02T10:00:00.000Z', state: 'answered',
};
const THREAD = {
  root: ROOT,
  replies: [{
    ...ROOT, id: 951_002, parent: ROOT.id, text: 'It does. It needs a heater beside it.',
    actor: { kind: 'agent', handle: 'hermes' }, createdAt: '2026-10-02T10:05:00.000Z',
  }],
  resolution: { resolved: false, actor: null, at: null },
};

async function load(page: Page, target = COMMENTS, threads: unknown[] = []) {
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: target.slug, threads } }));
  await page.goto(target.url);
  await expect(page.locator('details.artifact-comment').first()).toBeAttached();
  await expect(page.locator(PANEL)).toBeVisible();
  await settle(page);
}

function frames(page: Page) {
  return page.evaluate(() => new Promise((done) =>
    requestAnimationFrame(() => requestAnimationFrame(done))));
}

// Wait a frame for what was just done (a resize, a key) to start the panel's
// width changing, then until it has finished, and a frame laid out since.
async function settle(page: Page) {
  await frames(page);
  await expect.poll(() => page.evaluate((selector) => {
    const aside = document.querySelector(selector);
    return aside ? aside.getAnimations().length : 0;
  }, PANEL)).toBe(0);
  await frames(page);
}

function parts(page: Page) {
  const aside = page.locator(PANEL);
  return {
    aside,
    opener: aside.getByRole('button', { name: 'Comments', exact: true }),
    fold: aside.getByRole('button', { name: 'Fold comments' }),
    handle: aside.getByRole('separator', { name: 'Resize comments' }),
  };
}

async function openPanel(page: Page) {
  const side = parts(page);
  await side.opener.click();
  await expect(side.fold).toBeVisible();
  await settle(page);
  return side;
}

async function box(target: Locator) {
  return target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, width: rect.width };
  });
}

// The panel's width once it has settled.
async function width(page: Page) {
  await settle(page);
  return (await box(page.locator(PANEL))).width;
}

// The handle's middle, where a drag starts.
async function grip(handle: Locator) {
  const rect = (await handle.boundingBox())!;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// Drag the handle to x, the mouse held down for each of the steps.
async function dragTo(page: Page, handle: Locator, x: number) {
  const from = await grip(handle);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(x, from.y, { steps: 8 });
  await page.mouse.up();
}

// The widest the panel may be in this window, in pixels: 40rem, a third of
// the window, or what leaves the column 32rem and the 1rem gutter before the
// panel, whichever is least.
async function widest(page: Page) {
  return page.evaluate((rem) => {
    const left = document.querySelector('.artifact-body')!.getBoundingClientRect().left;
    const across = document.documentElement.clientWidth;
    return Math.min(40 * rem, across / 3, across - left - 33 * rem);
  }, REM);
}

// Press a key on the handle until its value stops changing.
async function pressToEnd(page: Page, handle: Locator, key: string) {
  for (let presses = 0; presses < 40; presses += 1) {
    const before = await handle.getAttribute('aria-valuenow');
    await page.keyboard.press(key);
    if (await handle.getAttribute('aria-valuenow') === before) return;
  }
  throw new Error(`${key} never reached the end`);
}

test('the open panel has a focusable separator on its left edge, and the folded rail none', async ({ page }) => {
  const errors = watch(page);
  await load(page);
  const side = parts(page);
  await expect(side.opener).toBeVisible();
  await expect(side.handle).toHaveCount(0);
  await expect(page.locator('.artifact-comments-resize')).toBeHidden();

  await openPanel(page);
  await expect(side.handle).toBeVisible();
  await expect(side.handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(side.handle).toHaveAttribute('tabindex', '0');
  await expect(side.handle).toHaveAttribute('aria-valuemin', '16');
  await expect(side.handle).toHaveAttribute('aria-valuenow', '20');
  expect(Number(await side.handle.getAttribute('aria-valuemax'))).toBeCloseTo((await widest(page)) / REM, 1);
  const aside = await box(side.aside);
  expect(aside.width).toBeCloseTo(20 * REM, 0);
  const handle = await box(side.handle);
  expect(Math.abs((handle.left + handle.right) / 2 - aside.left)).toBeLessThanOrEqual(1);
  // The fold control has the focus once the panel opens; Shift+Tab reaches
  // the handle before it.
  await expect(side.fold).toBeFocused();
  for (let presses = 0; presses < 10; presses += 1) {
    if (await side.handle.evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press('Shift+Tab');
  }
  await expect(side.handle).toBeFocused();

  await side.fold.click();
  await expect(side.opener).toBeVisible();
  await expect(side.handle).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('dragging the handle 160 pixels left keeps the edge under the pointer and widens the panel by as much', async ({ page }) => {
  await load(page);
  const side = await openPanel(page);
  const before = await width(page);
  const from = await grip(side.handle);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 80, from.y, { steps: 5 });
  // No lag: the edge is under the pointer in the same frame.
  expect(Math.abs((await box(side.aside)).left - (from.x - 80))).toBeLessThanOrEqual(2);
  await page.mouse.move(from.x - 160, from.y, { steps: 5 });
  expect(Math.abs((await box(side.aside)).left - (from.x - 160))).toBeLessThanOrEqual(2);
  await page.mouse.up();
  const after = await box(side.aside);
  expect(Math.abs(after.left - (from.x - 160))).toBeLessThanOrEqual(2);
  expect(Math.abs(after.width - (before + 160))).toBeLessThanOrEqual(2);
  expect(Math.abs((await width(page)) - (before + 160))).toBeLessThanOrEqual(2);
});

test('the panel stops at its maximum, leaving the column 32rem, and at 16rem', async ({ page }) => {
  await load(page);
  const side = await openPanel(page);
  await dragTo(page, side.handle, 0);
  await settle(page);
  const panel = await box(side.aside);
  const column = await box(page.locator('.artifact-body'));
  expect(panel.width).toBeLessThanOrEqual(40 * REM + 0.5);
  expect(Math.abs(panel.width - await widest(page))).toBeLessThanOrEqual(1);
  expect(column.width).toBeGreaterThanOrEqual(32 * REM);
  expect(column.right).toBeLessThanOrEqual(panel.left);
  expect(Number(await side.handle.getAttribute('aria-valuenow'))).toBeCloseTo(panel.width / REM, 1);

  await dragTo(page, side.handle, WIDE.width - 1);
  expect(Math.abs((await width(page)) - 16 * REM)).toBeLessThanOrEqual(0.5);
  await expect(side.handle).toHaveAttribute('aria-valuenow', '16');
});

test('Left Arrow widens the panel a rem a step and Right Arrow narrows it, the value following', async ({ page }) => {
  await load(page);
  const side = await openPanel(page);
  const first = await width(page);
  await side.handle.focus();
  for (const step of [1, 2, 3]) {
    await page.keyboard.press('ArrowLeft');
    await expect(side.handle).toHaveAttribute('aria-valuenow', String(20 + step));
  }
  expect(Math.abs((await width(page)) - (first + 3 * REM))).toBeLessThanOrEqual(0.5);
  for (const step of [1, 2, 3]) {
    await page.keyboard.press('ArrowRight');
    await expect(side.handle).toHaveAttribute('aria-valuenow', String(23 - step));
  }
  expect(Math.abs((await width(page)) - first)).toBeLessThanOrEqual(0.5);
});

test('a width of 28rem opens again after a reload and on another page', async ({ page }) => {
  await load(page);
  const side = await openPanel(page);
  await side.handle.focus();
  for (let step = 0; step < 8; step += 1) await page.keyboard.press('ArrowLeft');
  await expect(side.handle).toHaveAttribute('aria-valuenow', '28');
  expect(await page.evaluate((key) => localStorage.getItem(key), WIDTH)).toBe('28');

  await page.reload();
  await expect(side.fold).toBeVisible();
  // It opens at that width, not sliding to it.
  expect(Math.abs((await box(side.aside)).width - 28 * REM)).toBeLessThanOrEqual(0.5);
  expect(Math.abs((await width(page)) - 28 * REM)).toBeLessThanOrEqual(0.5);

  await load(page, SECTIONS);
  await expect(side.fold).toBeVisible();
  expect(Math.abs((await width(page)) - 28 * REM)).toBeLessThanOrEqual(0.5);
  await expect(side.handle).toHaveAttribute('aria-valuenow', '28');
});

test('with a storage that throws on every call the panel opens at 20rem and still resizes, logging no error', async ({ page }) => {
  const errors = watch(page);
  await page.addInitScript(() => {
    for (const name of ['getItem', 'setItem', 'removeItem', 'clear', 'key'] as const) {
      Object.defineProperty(Storage.prototype, name, {
        configurable: true,
        value() {
          throw new DOMException('The storage is refused', 'SecurityError');
        },
      });
    }
  });
  await load(page);
  const side = await openPanel(page);
  expect(Math.abs((await width(page)) - 20 * REM)).toBeLessThanOrEqual(0.5);
  const from = await grip(side.handle);
  await dragTo(page, side.handle, from.x - 96);
  expect(Math.abs((await width(page)) - 26 * REM)).toBeLessThanOrEqual(2);
  await side.handle.focus();
  await page.keyboard.press('ArrowRight');
  await side.handle.dblclick();
  expect(Math.abs((await width(page)) - 20 * REM)).toBeLessThanOrEqual(0.5);
  expect(errors).toEqual([]);
});

test('a double-click on the handle goes back to 20rem and forgets the stored width', async ({ page }) => {
  await load(page);
  const side = await openPanel(page);
  await side.handle.focus();
  for (let step = 0; step < 10; step += 1) await page.keyboard.press('ArrowLeft');
  expect(Math.abs((await width(page)) - 30 * REM)).toBeLessThanOrEqual(0.5);

  await side.handle.dblclick();
  expect(Math.abs((await width(page)) - 20 * REM)).toBeLessThanOrEqual(0.5);
  await expect(side.handle).toHaveAttribute('aria-valuenow', '20');
  expect(await page.evaluate((key) => localStorage.getItem(key), WIDTH)).toBeNull();

  await page.reload();
  await expect(side.fold).toBeVisible();
  expect(Math.abs((await width(page)) - 20 * REM)).toBeLessThanOrEqual(0.5);
});

test('a panel widened to its maximum narrows the column and its tables, and the passage read stays put', async ({ page }) => {
  await load(page, TABLES);
  const side = await openPanel(page);
  // A paragraph in the middle of the page, the one over the Findings table,
  // at the top of the window. Named by its words, not counted: the page's
  // paragraphs change as the fixture grows.
  const passage = page.locator('.artifact-body p', { hasText: "What the winter's inspections found" });
  await expect(passage).toHaveCount(1);
  await passage.evaluate((node) => window.scrollBy(0, node.getBoundingClientRect().top));
  await frames(page);
  const before = (await box(passage)).top;
  expect(Math.abs(before)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

  await side.handle.focus();
  await pressToEnd(page, side.handle, 'ArrowLeft');
  await settle(page);
  const panel = await box(side.aside);
  expect(Math.abs(panel.width - await widest(page))).toBeLessThanOrEqual(1);
  const column = await box(page.locator('.artifact-body'));
  expect(column.right).toBeLessThanOrEqual(panel.left);
  expect(column.width).toBeGreaterThanOrEqual(32 * REM);
  const tables = await page.locator(TOP_LEVEL).evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().right));
  expect(tables.length).toBeGreaterThan(0);
  for (const right of tables) expect(right).toBeLessThanOrEqual(panel.left);
  const fit = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth, viewport: window.innerWidth,
  }));
  expect(fit.scroll).toBeLessThanOrEqual(fit.viewport);
  expect(Math.abs((await box(passage)).top - before)).toBeLessThanOrEqual(4);
});

test('a stored 36rem is clamped to a narrower window and shown again once it widens, and without room a thread opens in a popover', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await load(page, COMMENTS, [THREAD]);
  await page.evaluate((key) => localStorage.setItem(key, '36'), WIDTH);
  await page.reload();
  await expect(page.locator(PANEL)).toBeVisible();
  const side = await openPanel(page);
  expect(Math.abs((await width(page)) - 36 * REM)).toBeLessThanOrEqual(0.5);

  // At 1440 pixels the window's maximum is under 36rem, and the panel
  // shrinks to it without the stored width being written back.
  await page.setViewportSize(WIDE);
  const most = await widest(page);
  expect(most).toBeLessThan(36 * REM);
  expect(Math.abs((await width(page)) - most)).toBeLessThanOrEqual(1);
  await expect(side.handle).toHaveAttribute('aria-valuenow', String(Math.round(most / REM * 100) / 100));
  const column = await box(page.locator('.artifact-body'));
  expect(column.right).toBeLessThanOrEqual((await box(side.aside)).left);
  expect(column.width).toBeGreaterThanOrEqual(32 * REM);
  expect(await page.evaluate((key) => localStorage.getItem(key), WIDTH)).toBe('36');

  // Back at 1920 pixels it is 36rem again.
  await page.setViewportSize({ width: 1920, height: 1080 });
  expect(Math.abs((await width(page)) - 36 * REM)).toBeLessThanOrEqual(0.5);
  await expect(side.handle).toHaveAttribute('aria-valuenow', '36');
  expect(await page.evaluate((key) => localStorage.getItem(key), WIDTH)).toBe('36');

  // Below the panel's room the thread opens from its chip in a popover over
  // the text, never in its box.
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(side.aside).toBeHidden();
  const findings = page.locator('details.artifact-comment[data-section="findings"]');
  await expect(findings.locator(':scope > summary')).toHaveText('1 reply · ✓ hermes answered');
  await findings.locator(':scope > summary').click();
  const popover = page.locator('.artifact-comments-popover');
  await expect(popover).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Section Findings' })).toBeVisible();
  const thread = popover.locator(`.artifact-comment-thread[data-thread="${ROOT.id}"]`);
  await expect(thread).toBeVisible();
  await expect(thread.locator('.artifact-comment-item--reader .artifact-comment-text'))
    .toHaveText('Does the pump stop when the pond freezes?');
  await expect(thread.locator('.artifact-comment-item--agent .artifact-comment-text'))
    .toHaveText('It does. It needs a heater beside it.');
  await expect(findings).not.toHaveAttribute('open');
});
