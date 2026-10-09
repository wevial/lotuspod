import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The index from the capture fixture: rendered pages, never stamped, were
// updated when the fixture committed them, at the start of their created
// day; published pages carry publish's later stamp on the same day. The rows arrive newest update first,
// the Updated header says so, and its first click reverses that order. Times
// are read from each date cell's time element, never from the day it shows.
const COLUMNS = ['Title', 'Created', 'Updated', 'Summary'];

async function load(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.index-table .sort-button')).toHaveCount(COLUMNS.length);
  return errors;
}

function header(page: Page, label: string) {
  return page.locator('.index-table thead th', { hasText: label });
}

// The Updated column's datetime values, top row first.
function updatedTimes(page: Page): Promise<string[]> {
  return page.locator('.index-table tbody tr').evaluateAll((rows) =>
    rows.map((row) => (row as HTMLTableRowElement).cells[2]
      .querySelector('time')?.getAttribute('datetime') ?? ''));
}

// Each title's link text, without the tags under it.
function titles(page: Page): Promise<string[]> {
  return page.locator('.index-table tbody tr').evaluateAll((rows) =>
    rows.map((row) => (row as HTMLTableRowElement).cells[0]
      .querySelector('a')?.textContent?.trim() ?? ''));
}

function never(times: string[], step: (a: string, b: string) => boolean) {
  return times.every((time, i) => i === 0 || !step(times[i - 1], time));
}

test('the rows arrive newest update first and the Updated header says so', async ({ page }) => {
  const errors = await load(page);
  expect(await page.locator('.index-table thead th').allTextContents()).toEqual(COLUMNS);
  await expect(page.locator('.index-table td.episode-number')).toHaveCount(0);
  await expect(header(page, 'Updated')).toHaveAttribute('aria-sort', 'descending');

  const times = await updatedTimes(page);
  expect(times.length).toBeGreaterThan(1);
  expect(times.every(Boolean)).toBe(true);
  // More than one time, so the order is a real one.
  expect(new Set(times).size).toBeGreaterThan(1);
  expect(never(times, (above, below) => below > above)).toBe(true);
  expect(errors).toEqual([]);
});

test('one click on Updated reverses the order, and Title sorts by title', async ({ page }) => {
  const errors = await load(page);
  const first = await updatedTimes(page);

  await header(page, 'Updated').getByRole('button').click();
  await expect(header(page, 'Updated')).toHaveAttribute('aria-sort', 'ascending');
  const reversed = await updatedTimes(page);
  expect(reversed.slice().sort()).toEqual(first.slice().sort());
  expect(never(reversed, (above, below) => below < above)).toBe(true);
  expect(reversed[0]).not.toEqual(first[0]);

  await header(page, 'Title').getByRole('button').click();
  await expect(header(page, 'Title')).toHaveAttribute('aria-sort', 'ascending');
  await expect(header(page, 'Updated')).toHaveAttribute('aria-sort', 'none');
  const names = await titles(page);
  expect(names).toEqual(names.slice().sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })));
  expect(errors).toEqual([]);
});

// The Labels menu. The capture fixture labels its published pages - relos,
// croton and relos, holophyte, croton - and its rendered ones not at all, so
// one page carries relos second. Expectations are read from the rows'
// data-labels, which the index writes from each page's labels.
const PYTHON = process.env.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const NO_MATCH = 'No pages match these filters.';

type Row = { title: string; labels: string[] };

function shownRows(page: Page): Promise<Row[]> {
  return page.locator('.index-table tbody tr:not([hidden])').evaluateAll((rows) =>
    rows.map((row) => ({
      title: row.querySelector('td a')?.textContent?.trim() ?? '',
      labels: ((row as HTMLElement).dataset.labels ?? '').split(',').filter(Boolean),
    })));
}

function menuButton(page: Page) {
  return page.getByRole('button', { name: /^Labels/ });
}

// A label's checkbox, found whether the menu is open or not.
function option(page: Page, label: string) {
  return page.locator('.index-labels-option')
    .filter({ has: page.locator('.index-labels-name', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input[type="checkbox"]');
}

test('the Labels menu lists each label with its count and filters by any checked one', async ({ page }) => {
  const errors = await load(page);
  const all = await shownRows(page);
  const total = all.length;
  const carrying = (labels: string[]) =>
    all.filter((row) => row.labels.some((label) => labels.includes(label))).map((row) => row.title);
  expect(all.some((row) => row.labels.indexOf('relos') > 0)).toBe(true);
  expect(all.some((row) => row.labels.length === 0)).toBe(true);
  await expect(page.locator('.index-count')).toHaveText(`${total} pages, newest update first`);
  await expect(page.locator('.index-active')).toBeHidden();

  // The tags under each title are its labels, in its order.
  const tags = await page.locator('.index-table tbody tr').evaluateAll((rows) =>
    rows.map((row) => Array.from(row.querySelectorAll('.index-tag'), (tag) => tag.textContent)));
  expect(tags).toEqual(all.map((row) => row.labels));

  const button = menuButton(page);
  await expect(button).toHaveText('Labels ▾');
  await expect(button).toHaveAttribute('aria-haspopup', 'true');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const names = ['croton', 'holophyte', 'relos'];
  const listed = await page.locator('.index-labels-option').evaluateAll((options) =>
    options.map((option) => [
      option.querySelector('.index-labels-name')?.textContent,
      option.querySelector('.index-labels-count')?.textContent,
    ]));
  expect(listed).toEqual(names.map((name) => [name, String(carrying([name]).length)]));

  await option(page, 'relos').check();
  const relos = carrying(['relos']);
  expect(relos.length).toBeGreaterThan(1);
  expect((await shownRows(page)).map((row) => row.title)).toEqual(relos);
  await expect(button).toHaveText('Labels (1) ▾');
  await expect(page.locator('.index-active')).toHaveText('Showing relos ✕');
  await expect(page.getByRole('button', { name: 'Remove filter relos' })).toHaveText('relos ✕');
  await expect(page.locator('.index-count')).toHaveText(`${relos.length} of ${total} pages`);

  await option(page, 'holophyte').check();
  const either = carrying(['relos', 'holophyte']);
  expect(either.length).toBeGreaterThan(relos.length);
  expect((await shownRows(page)).map((row) => row.title)).toEqual(either);
  await expect(button).toHaveText('Labels (2) ▾');
  await expect(page.locator('.index-count')).toHaveText(`${either.length} of ${total} pages`);

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Remove filter relos' }).click();
  await expect(option(page, 'relos')).not.toBeChecked();
  await expect(option(page, 'holophyte')).toBeChecked();
  await expect(page.locator('.index-active')).toHaveText('Showing holophyte ✕');
  expect((await shownRows(page)).map((row) => row.title)).toEqual(carrying(['holophyte']));

  await page.getByRole('button', { name: 'Remove filter holophyte' }).click();
  await expect(page.locator('.index-active')).toBeHidden();
  await expect(button).toHaveText('Labels ▾');
  await expect(button).toBeFocused();
  expect(await shownRows(page)).toEqual(all);
  expect(errors).toEqual([]);
});

test('a search that leaves no labelled row says no page matches, and clearing it brings them back', async ({ page }) => {
  const errors = await load(page);
  const all = await shownRows(page);
  const relos = all.filter((row) => row.labels.includes('relos')).map((row) => row.title);
  const rowText = await page.locator('.index-table tbody tr').evaluateAll((rows) =>
    rows.filter((row) => ((row as HTMLElement).dataset.labels ?? '').split(',').includes('relos'))
      .map((row) => row.textContent?.toLowerCase() ?? ''));
  const word = 'diagram';
  expect(rowText.some((text) => text.includes(word))).toBe(false);

  await menuButton(page).click();
  await option(page, 'relos').check();
  await page.keyboard.press('Escape');
  await page.getByLabel('Search').fill(word);
  await expect(page.locator('.index-table tbody tr:not([hidden])')).toHaveCount(0);
  await expect(page.locator('.index-table')).toBeHidden();
  await expect(page.getByText(NO_MATCH)).toBeVisible();
  await expect(page.locator('.index-count')).toHaveText(`0 of ${all.length} pages`);

  await page.getByLabel('Search').fill('');
  await expect(page.getByText(NO_MATCH)).toBeHidden();
  await expect(page.locator('.index-table')).toBeVisible();
  expect((await shownRows(page)).map((row) => row.title)).toEqual(relos);
  expect(errors).toEqual([]);
});

test('Escape or a click outside closes the menu with focus on its button', async ({ page }) => {
  const errors = await load(page);
  const button = menuButton(page);
  await button.click();
  await option(page, 'croton').focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('.index-labels-list')).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();

  await button.click();
  await expect(page.locator('.index-labels-list')).toBeVisible();
  await page.locator('.index-title').click();
  await expect(page.locator('.index-labels-list')).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();

  // Escape still closes it once focus has left it for the search.
  await button.click();
  await expect(page.locator('.index-labels-list')).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByLabel('Search')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.index-labels-list')).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();

  // A click on a control of its own, the search, returns focus all the same.
  await button.click();
  await expect(page.locator('.index-labels-list')).toBeVisible();
  await page.getByLabel('Search').click();
  await expect(page.locator('.index-labels-list')).toBeHidden();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toBeFocused();
  expect(errors).toEqual([]);
});

// An index this checkout's CLI builds in a directory of its own, after
// build(cli, dir) puts pages there, served in place of the fixture's at the
// site's root so the theme still loads.
async function serveIndex(page: Page,
  build: (cli: (...args: string[]) => void, dir: string) => void) {
  expect(PYTHON, 'LOTUSPOD_TEST_PYTHON names the fixture Python').not.toBe('');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-index-'));
  try {
    const cli = (...args: string[]) => {
      execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
        env: { ...process.env, PYTHONPATH: SRC },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
    };
    build(cli, dir);
    cli('index', '--out-dir', dir);
    const body = fs.readFileSync(path.join(dir, 'index.html'), 'utf-8');
    await page.route((url) => url.pathname === '/', (route) =>
      route.fulfill({ body, contentType: 'text/html; charset=utf-8' }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a label every page carries still counts as a filter', async ({ page }) => {
  await serveIndex(page, (cli, dir) => {
    for (const title of ['Alder', 'Bream']) {
      const source = path.join(dir, `${title.toLowerCase()}.source.md`);
      fs.writeFileSync(source, `# ${title}\n\nStill.\n`);
      cli('publish', source, '--local', '--name', title.toLowerCase(), '--label', 'relos',
        '--out-dir', dir);
      fs.rmSync(source);
    }
  });
  const errors = await load(page);
  await expect(page.locator('.index-count')).toHaveText('2 pages, newest update first');

  await menuButton(page).click();
  await option(page, 'relos').check();
  await expect(page.locator('.index-table tbody tr:not([hidden])')).toHaveCount(2);
  await expect(page.locator('.index-active')).toHaveText('Showing relos ✕');
  await expect(page.locator('.index-count')).toHaveText('2 of 2 pages');

  await option(page, 'relos').uncheck();
  await expect(page.locator('.index-count')).toHaveText('2 pages, newest update first');
  // A search every row matches is a filter too.
  await page.getByLabel('Search').fill('relos');
  await expect(page.locator('.index-count')).toHaveText('2 of 2 pages');
  expect(errors).toEqual([]);
});

test('an index with no labelled page has no Labels button and still sorts', async ({ page }) => {
  await serveIndex(page, (cli, dir) => {
    for (const [title, date] of [['Bream', '2026-09-03'], ['Alder', '2026-09-01'], ['Carp', '2026-09-02']]) {
      cli('render', '--name', title.toLowerCase(), '--title', title, '--body', '<p>Still.</p>',
        '--date', date, '--out-dir', dir);
    }
  });

  const errors = await load(page);
  await expect(page.getByLabel('Search')).toBeVisible();
  await expect(menuButton(page)).toHaveCount(0);
  await expect(page.locator('.index-tag')).toHaveCount(0);
  await expect(page.locator('.index-count')).toHaveText('3 pages, newest update first');

  await header(page, 'Title').getByRole('button').click();
  await expect(header(page, 'Title')).toHaveAttribute('aria-sort', 'ascending');
  expect(await titles(page)).toEqual(['Alder', 'Bream', 'Carp']);
  await expect(page.locator('.index-count')).toHaveText('3 pages');
  await header(page, 'Title').getByRole('button').click();
  expect(await titles(page)).toEqual(['Carp', 'Bream', 'Alder']);
  expect(errors).toEqual([]);
});
