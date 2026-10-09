import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';

// serve remembers the revision the reader last opened each page at, and the
// index marks the pages republished since. Each check publishes a page of its
// own on the capture fixture's site with a real `lotuspod publish`, opens it
// signed in, publishes it again with changed text and opens the index.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWNER = 'hermes';
const SEEN = '/api/seen';

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// A page's markdown, the edition named in its text.
function source(title: string, edition: string) {
  return [`# ${title}`, '', `Edition: ${edition}.`, '', '## Findings', '',
    'The pond freezes in January, and the pump stops with it.', ''].join('\n');
}

// hermes publishes markdown as the page name; the revision it is now at.
function publish(name: string, markdown: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-seen-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES);
    const revision = /at revision ([0-9a-f]{12})/.exec(said)?.[1] ?? '';
    expect(revision, said).not.toBe('');
    return revision;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Other checks open pages and publish them again: the reader catches up on
// every one, so only this check's page can be marked. A page never opened,
// listed for its unread replies, is never marked.
async function catchUp(request: APIRequestContext) {
  const response = await request.get(SEEN, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  const { pages } = (await response.json()) as { pages: Record<string, { revision: string; seen: string | null }> };
  for (const [name, entry] of Object.entries(pages)) {
    if (entry.seen === null || entry.seen === entry.revision) continue;
    const seen = await request.post(SEEN, {
      headers: SIGNED_IN, data: { page: name, revision: entry.revision },
    });
    expect(seen.status()).toBe(200);
  }
}

// Errors the page throws.
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function seenAnswer(page: Page, method: string) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === SEEN && response.request().method() === method);
}

// The page's post to the seen route, answered 200; what it sent. The page
// never reads the answer, so neither can the check.
async function posted(answer: Promise<Response>) {
  const response = await answer;
  expect(response.status()).toBe(200);
  return response.request().postDataJSON();
}

// Open the page and let its post to the seen route come back; what it sent.
async function openPage(page: Page, name: string) {
  const answer = seenAnswer(page, 'POST');
  await page.goto(`/${name}.html`);
  return posted(answer);
}

// Open the index's Pages view, which signed in is not the one it opens on,
// or load it again, and let its read of the seen route come back.
async function openIndex(page: Page, again = false) {
  const read = seenAnswer(page, 'GET');
  await (again ? page.reload() : page.goto('/#pages'));
  await read;
}

function row(page: Page, name: string) {
  return page.locator(`.index-table tbody tr[data-page="${name}"]`);
}

function shownPages(page: Page): Promise<string[]> {
  return page.locator('.index-table tbody tr:not([hidden])').evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.page ?? ''));
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('a page republished since it was opened is marked, and Updated keeps only those', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'seen-check';
    const first = publish(name, source('Seen check', 'first'));
    await catchUp(request);
    expect(await openPage(page, name)).toEqual({ page: name, revision: first });

    await openIndex(page);
    const toggle = page.locator('button.index-toggle', { hasText: /^Updated/ });
    await expect(row(page, name)).toHaveCount(1);
    await expect(row(page, name).locator('.index-mark')).toHaveCount(0);
    await expect(page.locator('.index-mark')).toHaveCount(0);
    await expect(toggle).toHaveText('Updated · 0');

    // serve dates a page to the second: a publish in the second the page was
    // served would leave the browser's cached copy current.
    await page.waitForTimeout(1100);
    const second = publish(name, source('Seen check', 'second'));
    expect(second).not.toBe(first);
    await openIndex(page, true);
    const all = await shownPages(page);
    expect(all.length).toBeGreaterThan(1);
    const mark = row(page, name).locator('span.index-mark');
    await expect(mark).toHaveText('updated');
    await expect(page.locator('.index-mark')).toHaveCount(1);
    // Beside the title's link.
    expect(await mark.evaluate((node) => node.parentElement?.classList.contains('episode-title')))
      .toBe(true);

    // The toggle sits after the Labels menu, unpressed.
    await expect(toggle).toHaveText('Updated · 1');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await toggle.evaluate((node) =>
      node.previousElementSibling?.classList.contains('index-labels-menu'))).toBe(true);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => shownPages(page)).toEqual([name]);
    await expect(page.locator('.index-active')).toHaveText('Showing updated ✕');
    await expect(page.locator('.index-count')).toHaveText(`1 of ${all.length} pages`);

    // The Labels menu and the search still apply on top.
    await page.getByLabel('Search').fill('no page says this');
    await expect(page.locator('.index-table tbody tr:not([hidden])')).toHaveCount(0);
    await page.getByLabel('Search').fill('');
    await expect.poll(() => shownPages(page)).toEqual([name]);

    await page.getByRole('button', { name: 'Remove filter updated' }).click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toBeFocused();
    await expect(page.locator('.index-active')).toBeHidden();
    await expect.poll(() => shownPages(page)).toEqual(all);

    // Opened again, and back on the index, the page is no longer marked.
    const answer = seenAnswer(page, 'POST');
    await row(page, name).locator('a').click();
    expect(await posted(answer)).toEqual({ page: name, revision: second });
    const read = seenAnswer(page, 'GET');
    await page.goBack();
    await read;
    await expect(row(page, name).locator('.index-mark')).toHaveCount(0);
    await expect(toggle).toHaveText('Updated · 0');
    expect(errors).toEqual([]);
  });

  test('with the seen route answered 404 the index has no toggle and no mark, and still filters', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'seen-shim';
    publish(name, source('Seen shim', 'first'));
    await catchUp(request);
    await openPage(page, name);
    // Marked, were the route to answer.
    publish(name, source('Seen shim', 'second'));

    await page.route((url) => url.pathname === SEEN, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    await openIndex(page);
    await expect(page.locator('.index-count')).toBeVisible();
    await expect(page.locator('.index-toggle')).toHaveCount(0);
    await expect(page.locator('.index-mark')).toHaveCount(0);
    const all = await shownPages(page);
    expect(all).toContain(name);

    // The Labels menu filters.
    const labelled = await page.locator('.index-table tbody tr[data-labels]').evaluateAll((rows) =>
      rows.filter((row) => ((row as HTMLElement).dataset.labels ?? '').split(',').includes('relos'))
        .map((row) => (row as HTMLElement).dataset.page ?? ''));
    expect(labelled.length).toBeGreaterThan(0);
    await page.getByRole('button', { name: /^Labels/ }).click();
    await page.locator('.index-labels-option', { hasText: 'relos' }).locator('input').check();
    await page.keyboard.press('Escape');
    await expect.poll(() => shownPages(page)).toEqual(labelled);
    await expect(page.locator('.index-active')).toHaveText('Showing relos ✕');
    await page.getByRole('button', { name: 'Remove filter relos' }).click();
    await expect.poll(() => shownPages(page)).toEqual(all);

    // So does the search.
    await page.getByLabel('Search').fill('Seen shim');
    await expect.poll(() => shownPages(page)).toEqual([name]);
    expect(errors).toEqual([]);
  });
});
