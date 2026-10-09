import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// An archived page leaves the index's default list for an "Archived · N"
// toggle, and Recent activity. The check publishes a page of its own on the
// capture fixture's site with a real `lotuspod publish`, archives it with a
// real `lotuspod archive`, and unarchives it when done, so later checks see
// no archived row.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const NAME = 'archive-check';

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-archive-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, ['# Archive check', '', 'A finished plan for the pond.', '',
      '## Findings', '', 'The pond froze, and thawed.', ''].join('\n'), 'utf-8');
    expect(run('publish', file, '--local', '--out-dir', OUT)).toContain(`published ${name}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function row(page: Page, name: string) {
  return page.locator(`.index-table tbody tr[data-page="${name}"]`);
}

function shownPages(page: Page): Promise<string[]> {
  return page.locator('.index-table tbody tr:not([hidden])').evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.page ?? ''));
}

function group(page: Page, name: string) {
  return page.locator(`section.index-activity-page[data-page="${name}"]`);
}

test.describe('archived', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test.afterAll(() => {
    if (OUT && PYTHON) run('unarchive', NAME, '--local', '--out-dir', OUT);
  });

  test('an archived page leaves the default list and Recent activity for its toggle', async ({ page, browser, baseURL }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    publish(NAME);

    // Published just now, the page has a group in Recent activity.
    await page.goto('/');
    await expect(group(page, NAME)).toHaveCount(1);

    // serve dates the index to the second: one written in the second it was
    // served would leave the browser's cached copy current.
    await page.waitForTimeout(1100);
    expect(run('archive', NAME, '--local', '--out-dir', OUT)).toContain(`archived ${NAME}`);

    await page.reload();
    await expect(page.locator('.index-activity')).toBeVisible();
    // The view is drawn from the route's answer, with or without other groups.
    await expect(page.locator('.index-count')).toHaveText(/(with activity|No activity) in the last 7 days/);
    await expect(group(page, NAME)).toHaveCount(0);

    await page.goto('/#pages');
    const toggles = page.locator('.index-controls button.index-toggle');
    await expect(toggles).toHaveCount(3);
    await expect(toggles.nth(0)).toHaveText(/^Updated · \d+$/);
    await expect(toggles.nth(1)).toHaveText(/^Unread · \d+$/);
    const archived = toggles.nth(2);
    await expect(archived).toHaveText('Archived · 1');
    await expect(archived).toHaveAttribute('aria-pressed', 'false');

    const total = (await page.locator('.index-table tbody tr').count()) - 1;
    await expect(row(page, NAME)).toBeHidden();
    expect(await shownPages(page)).not.toContain(NAME);
    expect(await shownPages(page)).toHaveLength(total);
    await expect(page.locator('.index-count')).toHaveText(`${total} pages, newest update first`);
    await expect(page.locator('.index-active')).toBeHidden();

    await archived.click();
    await expect(archived).toHaveAttribute('aria-pressed', 'true');
    await expect(row(page, NAME)).toBeVisible();
    expect(await shownPages(page)).toEqual([NAME]);
    await expect(page.locator('.index-count')).toHaveText('1 archived page');
    const token = page.locator('.index-active .index-token');
    await expect(token).toHaveText(['archived ✕']);

    await token.click();
    await expect(archived).toHaveAttribute('aria-pressed', 'false');
    await expect(row(page, NAME)).toBeHidden();
    expect(await shownPages(page)).toHaveLength(total);
    await expect(page.locator('.index-count')).toHaveText(`${total} pages, newest update first`);
    await expect(page.locator('.index-active')).toBeHidden();

    // Signed out, there is no seen route and no Recent activity, but the
    // toggle still shows and works.
    const signedOut = await browser.newContext({ baseURL, extraHTTPHeaders: {} });
    try {
      const outside = await signedOut.newPage();
      await outside.goto('/');
      const only = outside.locator('.index-controls button.index-toggle');
      await expect(only).toHaveCount(1);
      await expect(only).toHaveText('Archived · 1');
      await expect(row(outside, NAME)).toBeHidden();
      await only.click();
      expect(await shownPages(outside)).toEqual([NAME]);
      await expect(outside.locator('.index-count')).toHaveText('1 archived page');
    } finally {
      await signedOut.close();
    }

    await page.waitForTimeout(1100);
    expect(run('unarchive', NAME, '--local', '--out-dir', OUT)).toContain(`unarchived ${NAME}`);
    await page.reload();
    await expect(row(page, NAME)).toBeVisible();
    await expect(toggles).toHaveCount(2);
    await expect(page.locator('button.index-toggle', { hasText: /^Archived/ })).toHaveCount(0);
    await expect(page.locator('.index-count')).toHaveText(`${total + 1} pages, newest update first`);
    expect(errors).toEqual([]);
  });
});
