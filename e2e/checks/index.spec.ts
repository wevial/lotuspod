import { expect, test, type Page } from '@playwright/test';

// The index from the capture fixture: rendered pages, never stamped and not
// in a repository, were updated on their created date; published pages carry
// publish's later stamp on the same day. The rows arrive newest update first,
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

function titles(page: Page): Promise<string[]> {
  return page.locator('.index-table tbody tr').evaluateAll((rows) =>
    rows.map((row) => (row as HTMLTableRowElement).cells[0].textContent?.trim() ?? ''));
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
