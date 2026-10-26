import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Frame, type Page } from '@playwright/test';

// The title bar's Copy link (theme-head.js): a link icon button just before
// the theme switch that copies the page's address, origin and path alone, or
// the version's address on an earlier version. Where the clipboard refuses, a
// read-only field under the button holds the address, selected.
const PAGE = '/capture-palette.html';
const SLUG = 'capture-palette';
// The decisions page's title bar also holds the review sheet's controls.
const DECISIONS = '/capture-decisions.html';
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const WIDE = { width: 1440, height: 900 };

test.use({ viewport: WIDE, colorScheme: 'dark', extraHTTPHeaders: SIGNED_IN });

// The page polls /api/comments; a poll still in a route handler when a check
// ends would otherwise fail that check with "Test ended".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

async function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: SLUG, threads: [] } }));
  return errors;
}

// A current page listed on the index, opened at the top level, opens in the
// index's tabs (features/publish/ts/open-in-tabs.js): its title bar is then
// in the active tab's frame.
async function inTab(page: Page, name: string): Promise<Frame> {
  await expect(page).toHaveURL(new RegExp(`/#tabs=${name}&on=${name}`));
  const frame = await (await page.locator('iframe.pod-frame--active').elementHandle())!.contentFrame();
  await frame!.waitForLoadState('domcontentloaded');
  return frame!;
}

function copyLink(frame: Page | Frame) {
  return frame.locator('.artifact-topbar').getByRole('button', { name: 'Copy link', exact: true });
}

function clipboard(page: Page | Frame) {
  return page.evaluate(() => navigator.clipboard.readText());
}

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// hermes publishes the markdown as the page name, with comments, as
// versions.spec.ts publishes its pages.
function publish(name: string, markdown: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-copy-link-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', 'hermes',
      '--credential', HERMES, '--comments');
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('Copy link copies the page address alone, and shows it copied for a moment', async ({ page, context, baseURL }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  const errors = await watch(page);
  await page.goto(`${PAGE}?from=index#top`);
  const frame = await inTab(page, SLUG);
  const button = copyLink(frame);
  const status = frame.locator('.artifact-topbar > .artifact-copy-link-status[role="status"]');
  await button.click();
  await expect(button).toHaveAttribute('data-copied', '');
  await expect(status).toHaveText('Link copied');
  expect(await clipboard(frame)).toBe(`${new URL(baseURL!).origin}${PAGE}`);
  const pressedAt = Date.now();
  await expect(button).not.toHaveAttribute('data-copied', /.*/, { timeout: 3000 });
  await expect(status).toHaveText('');
  expect(Date.now() - pressedAt).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});

test('on an earlier version Copy link copies that version address', async ({ page, context, baseURL }) => {
  for (const [key, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${key}`).toBeTruthy();
  }
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const name = 'copy-link-versions';
  const source = (edition: string) => [
    '# Copy link versions', '', `Edition: ${edition}.`, '',
    '## Pond', '', 'The pond freezes in January.', '',
  ].join('\n');
  publish(name, source('first'));
  publish(name, source('second'));
  const answered = await page.request.get(`/api/versions?page=${name}`);
  expect(answered.status()).toBe(200);
  const older = (await answered.json()).versions[1];
  expect(older.current).toBe(false);

  await page.goto(`/${name}.html?version=${older.commit}`);
  await expect(page.locator('.artifact-body')).toContainText('Edition: first.');
  const button = copyLink(page);
  await button.click();
  await expect(button).toHaveAttribute('data-copied', '');
  expect(await clipboard(page)).toBe(`${new URL(baseURL!).origin}/${name}.html?version=${older.commit}`);

  // With any other query the server shows the current page, so the link is
  // the current page's.
  await page.goto(`/${name}.html?version=${older.commit}&utm_source=test`);
  await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
  await copyLink(page).click();
  await expect(copyLink(page)).toHaveAttribute('data-copied', '');
  expect(await clipboard(page)).toBe(`${new URL(baseURL!).origin}/${name}.html`);
  expect(errors).toEqual([]);
});

test('where the clipboard refuses, a selected read-only field holds the address until Escape', async ({ page, baseURL }) => {
  const errors = await watch(page);
  await page.addInitScript(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('Refused', 'NotAllowedError'));
  });
  await page.goto(`${PAGE}?standalone#top`);
  const address = `${new URL(baseURL!).origin}${PAGE}`;
  const button = copyLink(page);
  await button.click();
  const field = page.locator('input.artifact-copy-link-field');
  await expect(field).toBeVisible();
  await expect(field).toHaveAttribute('readonly', '');
  await expect(field).toBeFocused();
  await expect(field).toHaveValue(address);
  expect(await field.evaluate((input: HTMLInputElement) =>
    [input.selectionStart, input.selectionEnd])).toEqual([0, address.length]);
  await expect(button).not.toHaveAttribute('data-copied', /.*/);
  const box = (await field.boundingBox())!;
  const under = (await button.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(under.y + under.height);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(WIDE.width);

  await page.keyboard.press('Escape');
  await expect(field).toBeHidden();
  await expect(button).toBeFocused();

  // A press of the button again closes it, as a click elsewhere does.
  await button.click();
  await expect(field).toBeFocused();
  await button.click();
  await expect(field).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  await expect(field).toBeVisible();
  await page.locator('.artifact-body').click();
  await expect(field).toBeHidden();
  await expect(button).toBeFocused();
  expect(errors).toEqual([]);
});

test('a refusal that settles after the field was dismissed opens nothing', async ({ page }) => {
  const errors = await watch(page);
  await page.addInitScript(() => {
    const pending: Array<() => void> = [];
    (window as any).refuse = (index: number) => pending[index]();
    navigator.clipboard.writeText = () => new Promise((_, reject) =>
      pending.push(() => reject(new DOMException('Refused', 'NotAllowedError'))));
  });
  await page.goto(`${PAGE}?standalone`);
  const button = copyLink(page);
  const field = page.locator('input.artifact-copy-link-field');
  await button.click();
  await button.click();
  await page.evaluate(() => (window as any).refuse(1));
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field).toBeHidden();
  await page.evaluate(() => (window as any).refuse(0));
  await page.evaluate(() => new Promise((done) => setTimeout(done, 100)));
  await expect(field).toBeHidden();
  await expect(button).toBeFocused();
  expect(errors).toEqual([]);
});

test('the field stays in the window when the window narrows', async ({ page }) => {
  const errors = await watch(page);
  await page.addInitScript(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('Refused', 'NotAllowedError'));
  });
  await page.goto(`${PAGE}?standalone`);
  await copyLink(page).click();
  const field = page.locator('input.artifact-copy-link-field');
  await expect(field).toBeVisible();
  await page.setViewportSize({ width: 390, height: 780 });
  await expect.poll(async () => (await field.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  const box = (await field.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(errors).toEqual([]);
});

test('on a phone beside the review sheet the button and every theme button stay in the window', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto(`${DECISIONS}?standalone`);
  await expect(page.locator('.artifact-review-bar')).toBeVisible();
  const bar = (await page.locator('.artifact-topbar').boundingBox())!;
  const group = page.getByRole('group', { name: 'Theme' });
  const buttons = [copyLink(page), ...['Night', 'Dawn', 'Auto'].map((name) =>
    group.getByRole('button', { name, exact: true }))];
  for (const button of buttons) {
    await expect(button).toBeVisible();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(box.y).toBeGreaterThanOrEqual(bar.y);
    expect(box.y + box.height).toBeLessThanOrEqual(bar.y + bar.height);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  expect(errors).toEqual([]);
});

test.describe('with scripts off', () => {
  test.use({ javaScriptEnabled: false });

  test('the page shows no Copy link button', async ({ page }) => {
    await page.goto(`${PAGE}?standalone`);
    await expect(page.locator('.artifact-topbar-title')).toBeVisible();
    await expect(page.locator('button.artifact-copy-link')).toBeHidden();
  });
});
