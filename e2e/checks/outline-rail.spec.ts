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

// hermes publishes the markdown as the page name, with comments and a
// summary, so its header has a summary, an owner, the comments link and
// the versions.
function publish(name: string, markdown: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-outline-rail-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = execFileSync(PYTHON, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', OUT,
      '--owner', OWNER, '--credential', HERMES, '--comments', '--summary', SUMMARY], {
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

  // The title bar's last control, then Tab.
  await page.locator('.artifact-topbar button:visible').last().focus();
  await page.keyboard.press('Tab');
  await expect(handle).toBeFocused();
  await expect(list).toBeVisible();

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
  await expect(heading).toBeInViewport();

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
  publish(HEADED, HEADED_SOURCE);
  await page.setViewportSize(WIDE);
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: HEADED, threads: [] } }));
  const errors = await open(page, `/${HEADED}.html?standalone`);
  const header = page.locator('header.artifact-header');
  const meta = header.locator(':scope > .artifact-meta');
  const versions = meta.locator('.artifact-versions-link');
  const comments = header.locator(':scope > details.artifact-comment > summary');
  const owner = header.locator(':scope > .artifact-owner');
  const summary = header.locator(':scope > .artifact-summary');

  await expect(meta).toContainText('Created');
  await expect(versions).toHaveText(/^Versions · \d+$/);
  await expect(comments).toContainText('No comments');
  await expect(owner).toHaveText(`by ${OWNER}`);
  await expect(summary).toHaveText(SUMMARY);

  const box = await rect(header);
  expect(box.bottom - box.top).toBeLessThanOrEqual(130);

  // Created, Versions, the comments link and the owner share one line.
  const line = await rect(meta);
  for (const part of [versions, comments, owner]) {
    const at = await rect(part);
    expect(Math.abs((at.top + at.bottom) / 2 - (line.top + line.bottom) / 2)).toBeLessThan(4);
  }
  expect(line.height).toBeLessThan(30);
  // The comments link ends the line, so its redraw moves nothing after it.
  const left = [await rect(meta), await rect(versions), await rect(owner), await rect(comments)].map((r) => r.left);
  expect([...left].sort((a, b) => a - b)).toEqual(left);
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
