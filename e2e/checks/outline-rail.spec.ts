import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

// The outline on a wide page (core/theme/base.css, features/publish/ts/
// page-open.js): a handle in the left gutter that opens over the margin on
// hover or keyboard focus, and a pin that keeps it as a column beside the
// body, remembered over a reload. The header's metadata is one line under
// the title, the summary under it. On a phone the outline is the disclosure
// above the prose it was.
const ARTICLE = '/capture-article.html?standalone';
const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWNER = 'hermes';
const HEADED = 'outline-rail-header';
const SUMMARY = 'What the pond needs before the first frost, and who fits it.';

test.use({ extraHTTPHeaders: SIGNED_IN });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function rect(target: Locator) {
  return target.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, width: box.width, height: box.height };
  });
}

async function open(page: Page, address = ARTICLE) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(address);
  await expect(page.locator('nav.artifact-outline .artifact-outline-pin')).toBeAttached();
  return errors;
}

// A browser whose matches() throws on :has().
function withoutHasInMatches(page: Page) {
  return page.addInitScript(() => {
    const matches = Element.prototype.matches;
    Element.prototype.matches = function (this: Element, selector: string) {
      if (selector.includes(':has(')) throw new DOMException(`'${selector}' is not a valid selector`, 'SyntaxError');
      return matches.call(this, selector);
    };
  });
}

// hermes publishes the markdown as the page name, with comments and a
// one-line summary, in the article variant the capture article renders in,
// so its header has a summary, an owner, the comments link and the versions.
function publish(name: string, markdown: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-outline-rail-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = execFileSync(PYTHON, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', OUT,
      '--owner', OWNER, '--credential', HERMES, '--comments', '--summary', SUMMARY,
      '--variant', 'article'], {
      encoding: 'utf-8',
      env: { ...ENV, PYTHONPATH: SRC },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HEADED_SOURCE = [
  '# Outline rail header', '',
  'The pond, in winter.', '',
  '## Pump', '', 'The pond pump stops when the water freezes.', '',
  '## Heater', '', 'Fit a heater before the first frost.', '',
].join('\n');

test('closed to its handle the outline leaves the body the width, and opens on hover over the margin', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const handle = outline.locator('.artifact-outline-summary');
  const list = outline.locator('.artifact-outline-list');
  const body = page.locator('.artifact-body');

  await expect(handle).toHaveAccessibleName('On this page');
  await expect(handle).toBeVisible();
  await expect(list).toBeHidden();
  const before = await rect(body);
  expect(before.width).toBeGreaterThanOrEqual(880);
  // The handle is in the gutter left of the body.
  expect((await rect(handle)).right).toBeLessThanOrEqual(before.left);

  await handle.hover();
  await expect(list).toBeVisible();
  const during = await rect(body);
  expect(during.left).toBe(before.left);
  expect(during.width).toBe(before.width);
  // Open over the body, not beside it.
  expect((await rect(list)).right).toBeGreaterThan(before.left);

  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
  await expect(list).toBeHidden();
  expect((await rect(body)).left).toBe(before.left);
  expect(errors).toEqual([]);
});

test('keyboard focus from the title bar opens the outline, and an entry goes to its section', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const handle = outline.locator('.artifact-outline-summary');
  const list = outline.locator('.artifact-outline-list');
  await expect(list).toBeHidden();

  // The article fits the window; room below its end lets a section scroll
  // to the top, as on a longer page.
  await page.locator('.artifact-footer').evaluate((node) => { (node as HTMLElement).style.marginBottom = '2000px'; });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // The title bar's last control, then Tab.
  await page.locator('.artifact-topbar button:visible').last().focus();
  await page.keyboard.press('Tab');
  await expect(handle).toBeFocused();
  await expect(list).toBeVisible();
  // The summary reports the list it shows as expanded.
  await expect(outline.locator('details.artifact-outline-disclosure')).toHaveJSProperty('open', true);
  // Forward Tab reaches the pin first, then the entries.
  await page.keyboard.press('Tab');
  await expect(outline.getByRole('button', { name: 'Pin outline' })).toBeFocused();

  const entry = list.getByRole('link').last();
  const href = (await entry.getAttribute('href'))!;
  expect(href).toMatch(/^#./);
  await page.keyboard.press('Tab');
  while (!(await entry.evaluate((node) => node === document.activeElement))) {
    await expect(list).toBeVisible();
    await page.keyboard.press('Tab');
  }
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(href);
  const heading = page.locator(`[id="${decodeURIComponent(href.slice(1))}"]`);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const landed = await rect(heading);
  expect(landed.top).toBeGreaterThanOrEqual(0);
  expect(landed.top).toBeLessThan(120);

  // Focus moved out, the outline closes.
  await page.locator('.artifact-topbar-title').focus();
  await expect(list).toBeHidden();
  expect(errors).toEqual([]);
});

test('pinned, the outline is a column beside the body after a reload; unpinned, a handle again', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const handle = outline.locator('.artifact-outline-summary');
  const list = outline.locator('.artifact-outline-list');
  const pin = outline.getByRole('button', { name: 'Pin outline' });
  const body = page.locator('.artifact-body');
  const wide = await rect(body);

  await handle.hover();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-outline', 'pinned');
  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
  await expect(list).toBeVisible();
  await expect(handle).toHaveText('On this page');
  // Open as a disclosure too, so it reads as expanded and shows where
  // ::details-content is not understood.
  await expect(outline.locator('details.artifact-outline-disclosure')).toHaveJSProperty('open', true);
  const column = await rect(outline);
  const pinnedBody = await rect(body);
  expect(column.width).toBeGreaterThan(200);
  expect(column.right).toBeLessThanOrEqual(pinnedBody.left);
  expect(pinnedBody.left).toBeGreaterThan(wide.left);
  expect(pinnedBody.width).toBeLessThan(880);

  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('html')).not.toHaveAttribute('data-outline', /.*/);
  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
  await expect(list).toBeHidden();
  expect(await rect(body)).toEqual(wide);

  await page.reload();
  await expect(outline.locator('.artifact-outline-pin')).toBeAttached();
  await expect(list).toBeHidden();
  expect(errors).toEqual([]);
});

test('the header is the title, one meta line and the summary', async ({ page }) => {
  for (const [key, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${key}`).toBeTruthy();
  }
  // Published twice, so the header carries its Versions link.
  publish(HEADED, HEADED_SOURCE);
  publish(HEADED, `${HEADED_SOURCE}\nDrain the pump before it stops.\n`);
  await page.setViewportSize(WIDE);
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: HEADED, threads: [] } }));
  const errors = await open(page, `/${HEADED}.html?standalone`);
  const header = page.locator('header.artifact-header');
  const meta = header.locator(':scope > .artifact-meta');
  const versions = meta.locator('.artifact-versions-link');
  const comments = header.locator(':scope > details.artifact-comment > summary');
  const action = comments.locator('.artifact-comment-chip-act');
  const owner = header.locator(':scope > .artifact-owner');
  const summary = header.locator(':scope > .artifact-summary');

  await expect(meta).toContainText('Created');
  await expect(versions).toHaveText(/^Versions · \d+$/);
  expect(Number((await versions.textContent())!.split('·')[1])).toBeGreaterThanOrEqual(2);
  await expect(comments).toHaveText('No comments · Comment on this page');
  await expect(action).toHaveText('Comment on this page');
  await expect(action).toBeVisible();
  await expect(owner).toHaveText(`by ${OWNER}`);
  await expect(summary).toHaveText(SUMMARY);

  // An authored rule for the page's own paragraphs does not reach the header's.
  await page.addStyleTag({ content: 'p { flex: 1; }' });
  const box = await rect(header);
  expect(box.bottom - box.top).toBeLessThanOrEqual(130);

  // Created, Versions, the comments link and the owner share one line.
  const line = await rect(meta);
  for (const part of [versions, comments, owner, action]) {
    const at = await rect(part);
    expect(Math.abs((at.top + at.bottom) / 2 - (line.top + line.bottom) / 2)).toBeLessThan(4);
  }
  expect(line.height).toBeLessThan(30);
  // The comments link ends the line, so its redraw moves nothing after it.
  const left = [await rect(meta), await rect(versions), await rect(owner), await rect(comments)].map((r) => r.left);
  expect([...left].sort((a, b) => a - b)).toEqual(left);
  const ends = await Promise.all([meta, versions, owner].map(async (part) => (await rect(part)).right));
  expect((await rect(action)).right).toBeGreaterThan(Math.max(...ends));
  const title = await rect(header.locator('.artifact-title'));
  expect(title.bottom).toBeLessThanOrEqual(line.top + 1);
  expect(line.bottom).toBeLessThanOrEqual((await rect(summary)).top + 1);
  expect(errors).toEqual([]);
});

test('on a phone the outline is the disclosure above the prose, and nothing scrolls sideways', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const summary = outline.locator('.artifact-outline-summary');
  const list = outline.locator('.artifact-outline-list');
  await expect(summary).toBeVisible();
  await expect(summary).toHaveText('On this page');
  await expect(list).toBeHidden();
  await expect(outline.locator('.artifact-outline-pin')).toBeHidden();
  const nav = await rect(outline);
  expect(nav.width).toBeGreaterThan(300);
  expect(nav.bottom).toBeLessThanOrEqual((await rect(page.locator('.artifact-body'))).top);

  await summary.click();
  await expect(list).toBeVisible();
  const scroll = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await scroll()).toBeLessThanOrEqual(0);

  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: 'capture-owned', threads: [] } }));
  await open(page, '/capture-owned.html?standalone');
  await expect(page.locator('header.artifact-header .artifact-owner')).toBeVisible();
  expect(await scroll()).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('a hover on the wide handle leaves the phone disclosure as the reader left it', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const list = outline.locator('.artifact-outline-list');
  await outline.locator('.artifact-outline-summary').hover();
  await expect(list).toBeVisible();
  await page.setViewportSize(PHONE);
  await page.mouse.move(PHONE.width - 20, PHONE.height - 20);
  await expect(list).toBeHidden();
  await expect(outline.locator('details.artifact-outline-disclosure')).toHaveJSProperty('open', false);
  expect(errors).toEqual([]);
});

test('open over the page the outline moves nothing below it, and closed it adds no scrolling', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await open(page);
  // An outline taller than the article it lists.
  await page.addStyleTag({ content: '.artifact-outline-list a { padding-bottom: 600px; }' });
  const outline = page.locator('nav.artifact-outline');
  const list = outline.locator('.artifact-outline-list');
  const footer = page.locator('.artifact-footer');
  const height = () => page.evaluate(() => document.documentElement.scrollHeight);
  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
  await expect(list).toBeHidden();
  const closed = await height();
  const below = (await rect(footer)).top;
  await outline.evaluate((node) => { (node as HTMLElement).style.display = 'none'; });
  expect(await height()).toBe(closed);
  await outline.evaluate((node) => { (node as HTMLElement).style.display = ''; });

  await outline.locator('.artifact-outline-summary').hover();
  await expect(list).toBeVisible();
  expect((await rect(footer)).top).toBe(below);
  // Nor does it lengthen the page.
  expect(await height()).toBe(closed);
  // Collapse all is in the panel, over the page, not under it.
  const all = outline.locator('.artifact-sections-all');
  await all.scrollIntoViewIfNeeded();
  expect(await all.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === node;
  })).toBe(true);
  expect(errors).toEqual([]);
});

test('the handle draws its rules in forced colors, and an authored nav rule paints neither handle nor column', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const handle = outline.locator('.artifact-outline-summary');
  await page.emulateMedia({ forcedColors: 'active' });
  expect(await handle.evaluate((node) => getComputedStyle(node, '::before').backgroundImage)).toContain('linear-gradient');
  await page.emulateMedia({ forcedColors: 'none' });

  await page.addStyleTag({ content: 'nav, nav[aria-label], .artifact nav[aria-label] { background: #224466; }' });
  const ground = () => outline.evaluate((node) => getComputedStyle(node).backgroundColor);
  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
  expect(await ground()).toBe('rgba(0, 0, 0, 0)');
  await handle.hover();
  await outline.getByRole('button', { name: 'Pin outline' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-outline', 'pinned');
  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
  expect(await ground()).toBe('rgba(0, 0, 0, 0)');
  await outline.getByRole('button', { name: 'Pin outline' }).click();
  expect(errors).toEqual([]);
});

test('Escape closes the open outline where the pointer and focus stay', async ({ page }) => {
  await page.setViewportSize(WIDE);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const handle = outline.locator('.artifact-outline-summary');
  const list = outline.locator('.artifact-outline-list');

  await handle.hover();
  await expect(list).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  // Leaving and coming back opens it again.
  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
  await handle.hover();
  await expect(list).toBeVisible();
  // Escape with focus on the handle under the pointer, then the pointer
  // leaves: focus still there keeps it closed.
  await page.locator('.artifact-topbar button:visible').last().focus();
  await page.keyboard.press('Tab');
  await expect(handle).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
  await expect(list).toBeHidden();

  // Escape under the pointer with focus in the title bar, then Tab: the
  // handle takes focus and opens.
  await handle.hover();
  await page.locator('.artifact-topbar button:visible').last().focus();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(handle).toBeFocused();
  await expect(list).toBeVisible();
  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);

  await page.locator('.artifact-topbar button:visible').last().focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(list.getByRole('link').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await expect(handle).toBeFocused();
  await expect(outline.locator('details.artifact-outline-disclosure')).toHaveJSProperty('open', false);
  // Tab from the handle opens it again.
  await page.keyboard.press('Tab');
  await expect(list).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('on a touch screen', () => {
  test.use({ hasTouch: true });

  test('a tap on the handle opens the outline, an entry goes to its section, and a tap elsewhere closes it', async ({ page }) => {
    await page.setViewportSize(WIDE);
    const errors = await open(page);
    const outline = page.locator('nav.artifact-outline');
    const list = outline.locator('.artifact-outline-list');
    await expect(list).toBeHidden();
    const handle = outline.locator('.artifact-outline-summary');
    await handle.tap();
    await expect(list).toBeVisible();
    // A second tap closes it, the hover the tap left behind aside.
    await handle.tap();
    await expect(list).toBeHidden();
    await handle.tap();
    await expect(list).toBeVisible();
    const entry = list.getByRole('link').first();
    const href = (await entry.getAttribute('href'))!;
    await entry.tap();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(href);
    // Followed, the entry closes it.
    await expect(list).toBeHidden();
    await handle.tap();
    await expect(list).toBeVisible();
    // A tap elsewhere closes it.
    await page.touchscreen.tap(WIDE.width - 40, WIDE.height - 40);
    await expect(list).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a tap in a panel the mouse opened reaches the entry or the pin tapped', async ({ page }) => {
    await page.setViewportSize(WIDE);
    const errors = await open(page);
    const outline = page.locator('nav.artifact-outline');
    const list = outline.locator('.artifact-outline-list');
    const handle = outline.locator('.artifact-outline-summary');
    await handle.hover();
    await expect(list).toBeVisible();
    const entry = list.getByRole('link').last();
    const href = (await entry.getAttribute('href'))!;
    await entry.tap();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe(href);

    await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
    await handle.hover();
    await expect(list).toBeVisible();
    const pin = outline.getByRole('button', { name: 'Pin outline' });
    await pin.tap();
    await expect(pin).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-outline', 'pinned');
    await pin.tap();
    await expect(pin).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  });
});

test.describe('without the page script', () => {
  test.use({ javaScriptEnabled: false });

  test('keyboard focus still opens the outline and reaches its entries', async ({ page }) => {
    await page.setViewportSize(WIDE);
    await page.goto(ARTICLE);
    const outline = page.locator('nav.artifact-outline');
    const list = outline.locator('.artifact-outline-list');
    await expect(list).toBeHidden();
    await page.locator('.artifact-topbar-title').focus();
    await page.keyboard.press('Tab');
    await expect(outline.locator('.artifact-outline-summary')).toBeFocused();
    await expect(list).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(list.getByRole('link').first()).toBeFocused();
    await expect(list).toBeVisible();
  });
});

test('pinning measures the tables again, so none runs under the comments panel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: 'capture-tables', threads: [] } }));
  const errors = await open(page, '/capture-tables.html?standalone');
  const aside = page.locator('aside.artifact-comments-panel');
  await aside.getByRole('button', { name: 'Comments', exact: true }).click();
  await expect(aside.getByRole('button', { name: 'Fold comments' })).toBeVisible();
  await expect.poll(async () => (await aside.boundingBox())!.width).toBeGreaterThan(300);
  const widest = () => page.evaluate(() => Math.max(...Array.from(
    document.querySelectorAll('.artifact-body table'), (node) => node.getBoundingClientRect().right)));
  const panel = async () => (await rect(aside)).left;
  await expect.poll(async () => (await widest()) <= (await panel())).toBe(true);

  await page.locator('nav.artifact-outline .artifact-outline-summary').hover();
  await page.locator('nav.artifact-outline').getByRole('button', { name: 'Pin outline' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-outline', 'pinned');
  await expect.poll(async () => (await widest()) <= (await panel())).toBe(true);
  expect(errors).toEqual([]);
});

test('a browser without :has() in matches() still opens the outline and starts the rest of the page', async ({ page }) => {
  await withoutHasInMatches(page);
  await page.setViewportSize(WIDE);
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: 'capture-owned', threads: [] } }));
  const errors = await open(page, '/capture-owned.html?standalone');
  const outline = page.locator('nav.artifact-outline');
  const list = outline.locator('.artifact-outline-list');
  const handle = outline.locator('.artifact-outline-summary');
  // The header's links come first.
  await page.locator('.artifact-topbar button:visible').last().focus();
  for (let step = 0; step < 8 && !(await handle.evaluate((node) => node === document.activeElement)); step++) {
    await page.keyboard.press('Tab');
  }
  await expect(handle).toBeFocused();
  await expect(list).toBeVisible();
  await expect(outline.locator('details.artifact-outline-disclosure')).toHaveJSProperty('open', true);
  await page.mouse.move(WIDE.width - 40, WIDE.height - 40);
  await page.locator('.artifact-topbar-title').focus();
  await expect(list).toBeHidden();
  // What starts after the outline still starts.
  await expect(page.locator('header.artifact-header .artifact-versions-link')).toBeVisible();
  expect(errors).toEqual([]);
});

test('pinned, the outline heading shows keyboard focus in forced colors', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.addInitScript(() => localStorage.setItem('lotuspod:outline', 'pinned'));
  const errors = await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-outline', 'pinned');
  await page.emulateMedia({ forcedColors: 'active' });
  const handle = page.locator('nav.artifact-outline .artifact-outline-summary');
  await page.locator('.artifact-topbar button:visible').last().focus();
  await page.keyboard.press('Tab');
  await expect(handle).toBeFocused();
  expect(await handle.evaluate((node) => parseFloat(getComputedStyle(node).outlineWidth))).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('a pin pressed in another open page of this browser holds in this one', async ({ page, context }) => {
  await page.setViewportSize(WIDE);
  const errors = await open(page);
  const other = await context.newPage();
  await other.setViewportSize(WIDE);
  await open(other);
  await other.locator('nav.artifact-outline .artifact-outline-summary').hover();
  await other.getByRole('button', { name: 'Pin outline' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-outline', 'pinned');
  await expect(page.getByRole('button', { name: 'Pin outline' })).toHaveAttribute('aria-pressed', 'true');
  await other.getByRole('button', { name: 'Pin outline' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-outline', /.*/);
  await expect(page.getByRole('button', { name: 'Pin outline' })).toHaveAttribute('aria-pressed', 'false');
  await other.close();
  expect(errors).toEqual([]);
});

test('in a short wide window a pointer resting low on the handle keeps the outline open, still', async ({ page }) => {
  const SHORT = { width: 1280, height: 280 };
  await page.setViewportSize(SHORT);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const list = outline.locator('.artifact-outline-list');
  const handle = await rect(outline.locator('.artifact-outline-summary'));
  // Below where a panel ending GAP above the window's bottom would end.
  const y = Math.min(handle.bottom, SHORT.height) - 2;
  expect(y).toBeGreaterThan(SHORT.height - 16);
  await outline.evaluate((node) => {
    (window as unknown as { leaves: number }).leaves = 0;
    node.addEventListener('pointerleave', () => { (window as unknown as { leaves: number }).leaves += 1; });
  });
  await page.mouse.move(handle.left + handle.width / 2, y);
  await expect(list).toBeVisible();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as unknown as { leaves: number }).leaves)).toBe(0);
  await expect(list).toBeVisible();
  const panel = await rect(outline);
  expect(panel.bottom).toBeGreaterThan(y);
  expect(panel.bottom).toBeLessThanOrEqual(SHORT.height);
  for (const link of await list.getByRole('link').all()) {
    expect((await rect(link)).bottom).toBeLessThanOrEqual(SHORT.height);
  }
  expect(errors).toEqual([]);
});

test('where ::details-content is not understood, the first hover in a short window shows every entry', async ({ page }) => {
  await page.route((url) => url.pathname.endsWith('/lotuspod.css'), async (route) => {
    const response = await route.fetch();
    const css = (await response.text()).replaceAll('::details-content', '::x-details-content');
    await route.fulfill({ response, body: css });
  });
  const SHORT = { width: 1280, height: 300 };
  await page.setViewportSize(SHORT);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const list = outline.locator('.artifact-outline-list');
  const handle = await rect(outline.locator('.artifact-outline-summary'));
  await page.mouse.move(handle.left + handle.width / 2, handle.top + handle.height / 2);
  await expect(list).toBeVisible();
  expect((await rect(outline)).bottom).toBeLessThanOrEqual(SHORT.height);
  for (const link of await list.getByRole('link').all()) {
    const at = await rect(link);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.bottom).toBeLessThanOrEqual(SHORT.height);
  }
  expect(errors).toEqual([]);
});

test('in a short wide window the open outline keeps its handle and entries in view', async ({ page }) => {
  const SHORT = { width: 1280, height: 280 };
  await page.setViewportSize(SHORT);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const list = outline.locator('.artifact-outline-list');
  // The pointer moved onto the handle where it is, the page not scrolled.
  const handle = await rect(outline.locator('.artifact-outline-summary'));
  expect(handle.bottom).toBeLessThan(SHORT.height);
  await page.mouse.move(handle.left + handle.width / 2, handle.top + handle.height / 2);
  await expect(list).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // Every entry, and the panel, within the window; the pointer still over it.
  await expect.poll(async () => (await rect(outline)).bottom).toBeLessThanOrEqual(SHORT.height);
  for (const link of await list.getByRole('link').all()) {
    const at = await rect(link);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.bottom).toBeLessThanOrEqual(SHORT.height);
  }
  const panel = await rect(outline);
  expect(panel.top).toBeLessThanOrEqual(handle.top + handle.height / 2);
  await expect(list).toBeVisible();
  // An entry goes to its section from there.
  const entry = list.getByRole('link').last();
  const href = (await entry.getAttribute('href'))!;
  await entry.click();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(href);
  expect(errors).toEqual([]);
});

test('a browser without :has() keeps the disclosure, and hovering it moves nothing', async ({ page }) => {
  // Every :has() in the theme unparsed, as there, and the page script's too.
  await page.route((url) => url.pathname.endsWith('/lotuspod.css'), async (route) => {
    const response = await route.fetch();
    const css = (await response.text()).replaceAll(':has(', ':x-has(');
    await route.fulfill({ response, body: css });
  });
  await withoutHasInMatches(page);
  await page.setViewportSize(WIDE);
  const errors = await open(page);
  const outline = page.locator('nav.artifact-outline');
  const summary = outline.locator('.artifact-outline-summary');
  const body = page.locator('.artifact-body');
  expect(await outline.evaluate((node) => getComputedStyle(node).position)).not.toBe('sticky');
  await expect(summary).toHaveText('On this page');
  expect((await rect(outline)).bottom).toBeLessThanOrEqual((await rect(body)).top);
  const before = await rect(body);
  await summary.hover();
  expect(await rect(body)).toEqual(before);
  await summary.click();
  await expect(outline.locator('.artifact-outline-list')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a pin kept in this browser shows the column on a page whose page script does not run', async ({ page }) => {
  await page.setViewportSize(WIDE);
  await page.addInitScript(() => localStorage.setItem('lotuspod:outline', 'pinned'));
  await page.route((url) => url.pathname.endsWith('/lotuspod-page.js'), (route) => route.abort());
  await page.goto(ARTICLE);
  await expect(page.locator('html')).toHaveAttribute('data-outline', 'pinned');
  const outline = page.locator('nav.artifact-outline');
  await expect(outline.locator('.artifact-outline-pin')).toHaveCount(0);
  const column = await rect(outline);
  expect(column.width).toBeGreaterThan(200);
  expect(column.right).toBeLessThanOrEqual((await rect(page.locator('.artifact-body'))).left);
  await expect(outline.locator('.artifact-outline-summary')).toHaveText('On this page');
});

test('the Versions and comments links arriving on a phone move nothing below the header', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const held: Array<() => Promise<void>> = [];
  await page.route((url) => url.pathname === '/api/versions', (route) => {
    const versions = Array.from({ length: 100 }, (_, n) => ({
      commit: n.toString(16).padStart(12, '0'), date: '2026-01-01T00:00:00Z', current: n === 0 }));
    held.push(() => route.fulfill({ json: { versions } }));
  });
  await page.route((url) => url.pathname === '/api/comments', (route) => {
    held.push(() => route.fulfill({ json: { page: 'capture-owned', threads: [] } }));
  });
  const errors = await open(page, '/capture-owned.html?standalone');
  const body = page.locator('.artifact-body');
  const header = page.locator('header.artifact-header');
  await expect(header.locator('.artifact-owner')).toBeVisible();
  await expect.poll(() => held.length).toBe(2);
  const before = (await rect(body)).top;
  for (const release of held) await release();
  await expect(header.locator('.artifact-versions-link')).toHaveText('Versions · 100');
  await expect(header.locator(':scope > details.artifact-comment > summary')).toHaveText('No comments · Comment on this page');
  expect((await rect(body)).top).toBe(before);
  expect(errors).toEqual([]);
});
