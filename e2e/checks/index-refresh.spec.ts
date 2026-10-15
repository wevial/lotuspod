import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page, type Response } from '@playwright/test';

// The index keeps its listing fresh (lotuspod-index.js, from
// web/src/index-refresh.ts): while the listing is shown it reads its own page
// again every 60 seconds and each time the listing shows again over the tabs,
// and swaps in the rows when they differ, keeping the reader's search, labels,
// sort, view and tabs. Each check publishes pages of its own on the capture
// fixture's site with a real `lotuspod publish`, as activity.spec.ts does,
// and moves the index's clock by hand, as live-page.spec.ts does. Their names
// all start index-refresh-, and the one label added is taken off again, so
// the other index checks' labels stay the fixture's.
const WIDE = { width: 1280, height: 800 };
test.use({ viewport: WIDE });

const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const ACTIVITY = '/api/activity';
const EVERY = 60_000;
const START = Date.parse('2026-10-15T09:00:00Z');
const LABEL = 'refresh-check';

const ARTICLE = { name: 'capture-article', title: 'Capture article' };
const CHECKLIST = { name: 'capture-checklist', title: 'Capture checklist' };

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function source(title: string) {
  return [`# ${title}`, '', 'Notes from the pond this autumn.', '',
    '## Bank', '', 'The reeds lean over the water.', ''].join('\n');
}

// hermes publishes a page under the name, titled and summed up as given,
// with any extra options.
function publish(name: string, title: string, summary: string, ...extra: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-index-refresh-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, source(title), 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', 'hermes',
      '--credential', HERMES, '--summary', summary, ...extra);
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

const isIndexRead = (response: Response) =>
  new URL(response.url()).pathname === '/' && response.request().resourceType() === 'fetch';

function indexRead(page: Page) {
  return page.waitForResponse(isIndexRead);
}

// Every load of the index's window after the first, counted: a fragment
// written in place is none.
function watchLoads(page: Page) {
  const loads: string[] = [];
  page.on('load', () => loads.push(page.url()));
  return loads;
}

// The index on its Pages view, its clock stopped: it moves only when moved.
async function openIndex(page: Page, address = '/#pages') {
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
  await page.goto(address);
  await expect(page.locator('.index-table .sort-button')).toHaveCount(4);
  await expect(page.getByRole('group', { name: 'Open pods' })).toHaveCount(1);
}

// The 60-second read, run and answered.
async function nextRead(page: Page) {
  const read = indexRead(page);
  await page.clock.runFor(EVERY);
  expect((await read).status()).toBe(200);
}

const row = (page: Page, name: string) => page.locator(`.index-table tbody tr[data-page="${name}"]`);
const rowLink = (page: Page, name: string) => row(page, name).locator('td.episode-title > a');

function shownRows(page: Page): Promise<string[]> {
  return page.locator('.index-table tbody tr:not([hidden])').evaluateAll((rows) =>
    rows.map((each) => (each as HTMLElement).dataset.page ?? ''));
}

function listedTotal(page: Page): Promise<number> {
  return page.locator('.index-table tbody tr:not([data-archived])').count();
}

function option(page: Page, label: string) {
  return page.locator('.index-labels-option')
    .filter({ has: page.locator('.index-labels-name', { hasText: new RegExp(`^${label}$`) }) });
}

const strip = (page: Page) => page.getByRole('group', { name: 'Open pods' });
const home = (page: Page) => page.locator('.pod-tabs-bar').getByRole('button', { name: 'Lotuspod', exact: true });

function openNames(page: Page): Promise<string[]> {
  return strip(page).locator('.pod-tab').evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.page ?? ''));
}

function dots(page: Page): Promise<(string | null)[]> {
  return strip(page).locator('.pod-tab').evaluateAll((nodes) =>
    nodes.map((node) => node.querySelector<HTMLElement>('.pod-tab-dot')?.dataset.kind ?? null));
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('a pod published while a search is typed is listed and shown, the search kept', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'index-refresh-heron';
    await openIndex(page);
    const loads = watchLoads(page);
    await page.evaluate(() => { (window as any).__stayed = true; });
    const search = page.getByLabel('Search');
    await search.fill('heron');
    await expect(page.locator('.index-table tbody tr:not([hidden])')).toHaveCount(0);
    const total = await listedTotal(page);
    await expect(page.locator('.index-count')).toHaveText(`0 of ${total} pages`);

    publish(name, 'Index refresh far bank', 'A heron stands on the far bank each morning.');
    await nextRead(page);

    await expect.poll(() => shownRows(page)).toEqual([name]);
    await expect(rowLink(page, name)).toHaveText('Index refresh far bank');
    await expect(search).toHaveValue('heron');
    await expect(page.locator('.index-count')).toHaveText(`1 of ${total + 1} pages`);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe(true);
    expect(loads).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a new label is listed unchecked while the checked one still filters', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'index-refresh-label';
    try {
      await openIndex(page);
      await expect(option(page, LABEL)).toHaveCount(0);
      await page.locator('.index-labels').click();
      await option(page, 'relos').locator('input').check();
      await page.keyboard.press('Escape');
      const relos = await shownRows(page);
      expect(relos.length).toBeGreaterThan(0);

      publish(name, 'Index refresh labelled', 'A page with a label no row carried.', '--label', LABEL);
      await nextRead(page);

      await expect(option(page, LABEL)).toHaveCount(1);
      await expect(option(page, LABEL).locator('input')).not.toBeChecked();
      await expect(option(page, LABEL).locator('.index-labels-count')).toHaveText('1');
      await expect(option(page, 'relos').locator('input')).toBeChecked();
      expect(await page.locator('.index-labels-name').allTextContents())
        .toEqual(['croton', 'holophyte', 'refresh-check', 'relos']);
      expect(await shownRows(page)).toEqual(relos);
      const carried = await page.locator('.index-table tbody tr:not([hidden])').evaluateAll((rows) =>
        rows.every((each) => ((each as HTMLElement).dataset.labels ?? '').split(',').includes('relos')));
      expect(carried).toBe(true);
      await expect(page.locator('.index-active')).toHaveText('Showing relos ✕');
      expect(errors).toEqual([]);
    } finally {
      // The label leaves the index with this check.
      publish(name, 'Index refresh labelled', 'A page with a label no row carried.', '--no-labels');
    }
  });

  test('a pod republished with a new title keeps its place in the reader\'s title order', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'index-refresh-title';
    publish(name, 'Index refresh aardvark', 'A page whose title changes.');
    await openIndex(page);
    const title = page.locator('.index-table thead th', { hasText: 'Title' });
    await title.getByRole('button').click();
    await expect(title).toHaveAttribute('aria-sort', 'ascending');

    publish(name, 'Index refresh zander', 'A page whose title changes.');
    await nextRead(page);

    await expect(rowLink(page, name)).toHaveText('Index refresh zander');
    const titles = await page.locator('.index-table tbody tr').evaluateAll((rows) =>
      rows.map((each) => (each as HTMLTableRowElement).cells[0].querySelector('a')?.textContent?.trim() ?? ''));
    const ordered = titles.slice().sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    expect(titles).toEqual(ordered);
    await expect(title).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('.index-table thead th', { hasText: 'Updated' })).toHaveAttribute('aria-sort', 'none');
    expect(errors).toEqual([]);
  });

  test('on Recent activity a new pod\'s group is listed after the read, the view kept', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'index-refresh-activity';
    const first = page.waitForResponse((response) => new URL(response.url()).pathname === ACTIVITY);
    await openIndex(page, '/#activity');
    await first;
    const view = page.getByRole('group', { name: 'View' }).getByRole('button', { name: 'Recent activity' });
    await expect(view).toHaveAttribute('aria-pressed', 'true');

    publish(name, 'Index refresh activity', 'A page published while Recent activity is shown.');
    const again = page.waitForResponse((response) => new URL(response.url()).pathname === ACTIVITY);
    await nextRead(page);
    await again;

    const group = page.locator(`section.index-activity-page[data-page="${name}"]`);
    await expect(group).toBeVisible();
    await expect(group).toContainText('published the page');
    await expect(view).toHaveAttribute('aria-pressed', 'true');
    expect(page.url()).toMatch(/#activity$/);
    expect(errors).toEqual([]);
  });

  test('the tabs stay as they were, and a new pod opens in a third tab', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'index-refresh-tabs';
    const title = 'Index refresh third tab';
    await openIndex(page);
    for (const pod of [ARTICLE, CHECKLIST]) {
      await rowLink(page, pod.name).click();
      await expect(strip(page).locator(`.pod-tab[data-page="${pod.name}"] .pod-tab-title`))
        .toHaveAttribute('aria-current', 'page');
      const shown = indexRead(page);
      await home(page).click();
      await shown;
    }
    await expect(page.locator('main.index')).toBeVisible();
    const before = await dots(page);

    publish(name, title, 'A page opened in a tab after the listing was read again.');
    await nextRead(page);

    await expect(rowLink(page, name)).toHaveText(title);
    expect(await openNames(page)).toEqual([ARTICLE.name, CHECKLIST.name]);
    expect(await dots(page)).toEqual(before);
    await expect(strip(page).locator('[aria-current]')).toHaveCount(0);

    await rowLink(page, name).click();
    expect(await openNames(page)).toEqual([ARTICLE.name, CHECKLIST.name, name]);
    const third = strip(page).locator(`.pod-tab[data-page="${name}"]`);
    await expect(third.locator('.pod-tab-name')).toHaveText(title);
    await expect(third.locator('.pod-tab-title')).toHaveAttribute('aria-current', 'page');
    await expect(page.frameLocator(`iframe.pod-frame[title="${title}"]`).locator('h1')).toHaveText(title);
    expect(errors).toEqual([]);
  });

  test('while a tab is active nothing is read, and showing the listing reads once', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'index-refresh-held';
    await openIndex(page);
    const reads: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/' && request.resourceType() === 'fetch') reads.push(request.url());
    });
    await rowLink(page, ARTICLE.name).click();
    await expect(page.locator('main.index')).toBeHidden();

    publish(name, 'Index refresh held back', 'A page published while a tab was active.');
    await page.clock.runFor(2 * EVERY);
    expect(reads).toEqual([]);
    await expect(row(page, name)).toHaveCount(0);

    const shown = indexRead(page);
    await home(page).click();
    expect((await shown).status()).toBe(200);
    await expect(row(page, name)).toHaveCount(1);
    await expect(rowLink(page, name)).toBeVisible();
    expect(reads.length).toBe(1);
    expect(errors).toEqual([]);
  });

  test('a pressed Archived toggle stays pressed when its last page is unarchived', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'index-refresh-archived';
    publish(name, 'Index refresh archived', 'A page archived, then brought back.');
    run('archive', name, '--local', '--out-dir', OUT);
    try {
      await openIndex(page);
      const archived = page.locator('.index-controls button.index-toggle', { hasText: 'Archived' });
      await expect(archived).toHaveText('Archived · 1');
      await archived.click();
      await expect.poll(() => shownRows(page)).toEqual([name]);

      run('unarchive', name, '--local', '--out-dir', OUT);
      await nextRead(page);

      await expect(row(page, name)).not.toHaveAttribute('data-archived', /.*/);
      await expect(archived).toHaveText('Archived · 0');
      await expect(archived).toHaveAttribute('aria-pressed', 'true');
      expect(await shownRows(page)).toEqual([]);
      await expect(page.locator('.index-count')).toHaveText('0 archived pages');
      expect(errors).toEqual([]);
    } finally {
      run('unarchive', name, '--local', '--out-dir', OUT);
    }
  });

  test('an answer that comes once a tab is active is not drawn and loads nothing', async ({ page }) => {
    const errors = watchErrors(page);
    await openIndex(page);
    const loads = watchLoads(page);
    // The read held until a tab is active, then answered as an index with
    // no page, which would load the index again were it drawn.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let asked = () => {};
    const reached = new Promise<void>((resolve) => { asked = resolve; });
    await page.route((url) => url.pathname === '/', async (route) => {
      if (route.request().resourceType() !== 'fetch') return route.continue();
      const response = await route.fetch();
      asked();
      await held;
      const body = (await response.text()).replace(/<table class="index-table">[\s\S]*?<\/table>/, '');
      await route.fulfill({ response, body });
    });
    await page.clock.runFor(EVERY);
    await reached;
    await rowLink(page, ARTICLE.name).click();
    await expect(page.locator('main.index')).toBeHidden();
    const answered = indexRead(page);
    release();
    await answered;
    await page.waitForTimeout(500);
    expect(loads).toEqual([]);
    await expect(page.locator('main.index')).toBeHidden();
    await expect(page.locator('.index-table tbody tr')).not.toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('focus on a pod\'s link moves to its new row when it is republished', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'index-refresh-focus';
    publish(name, 'Index refresh focus', 'A page whose summary changes.');
    await openIndex(page);
    await rowLink(page, name).evaluate((link) => link.setAttribute('data-old', ''));
    await rowLink(page, name).focus();
    await expect(rowLink(page, name)).toBeFocused();

    publish(name, 'Index refresh focus', 'A page whose summary changed while it had focus.');
    await nextRead(page);

    await expect(row(page, name).locator('td.episode-summary'))
      .toHaveText('A page whose summary changed while it had focus.');
    await expect(rowLink(page, name)).not.toHaveAttribute('data-old', '');
    await expect(rowLink(page, name)).toBeFocused();
    expect(errors).toEqual([]);
  });
});
