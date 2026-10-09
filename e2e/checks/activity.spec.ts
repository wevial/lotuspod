import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The index's Recent activity view, fed by /api/activity, beside the Pages
// view. The first check publishes two pages of its own on the capture
// fixture's site with a real `lotuspod publish`, comments on one, publishes
// the other again with one section changed, and has hermes reply to the
// comment through real `lotuspod comments` commands on the fixture's agent
// socket. The others answer the activity route with page.route.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWNER = 'hermes';
const ACTIVITY = '/api/activity';
const SEEN = '/api/seen';
const COMMENTS = '/api/comments';
const DAY = 86_400_000;
// A label only page A carries; the check takes it off again at the end, so
// the Labels menu lists the fixture's labels alone for later checks.
const LABEL = 'activity-check';
const A = 'activity-check-a';
const B = 'activity-check-b';

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// `lotuspod comments ACTION ... --json` as hermes; what it printed.
function hermes(action: string, ...args: string[]) {
  return JSON.parse(run('comments', action, ...args, '--json', '--socket', SOCKET,
    '--credential', HERMES));
}

// A page's markdown: two sections, the heater's line as given.
function source(title: string, heater: string) {
  return [`# ${title}`, '', 'The plan for the pond this winter.', '',
    '## Pump', '', 'The pump sits by the steps.', '',
    '## Heater', '', heater, ''].join('\n');
}

// hermes publishes markdown as the page name, with comments and any extra
// options.
function publish(name: string, markdown: string, ...extra: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-activity-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, '--comments', ...extra);
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

type Row = { id: number };
type Thread = { root: Row; replies: Row[] };

// Other checks leave replies to the reader unread: the reader sees every
// thread up to its newest comment, so only this check's reply counts.
async function catchUp(request: APIRequestContext) {
  const response = await request.get(SEEN, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  const { pages } = (await response.json()) as { pages: Record<string, { unread: number }> };
  for (const [name, entry] of Object.entries(pages)) {
    if (!entry.unread) continue;
    const read = await request.get(`${COMMENTS}?page=${encodeURIComponent(name)}`, { headers: SIGNED_IN });
    expect(read.status()).toBe(200);
    const { threads, unread } = (await read.json()) as { threads: Thread[]; unread: number[] };
    for (const thread of threads) {
      const ids = [thread.root, ...thread.replies].map((row) => row.id);
      if (!ids.some((id) => unread.includes(id))) continue;
      const seen = await request.post(SEEN, {
        headers: SIGNED_IN, data: { page: name, thread: thread.root.id, comment: Math.max(...ids) },
      });
      expect(seen.status()).toBe(200);
    }
  }
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function activityRead(page: Page) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === ACTIVITY);
}

// Open the index, or load it again, and let its read of the activity route
// and the seen route come back.
async function openIndex(page: Page, again = false) {
  const reads = [activityRead(page), page.waitForResponse((response) =>
    new URL(response.url()).pathname === SEEN)];
  await (again ? page.reload() : page.goto('/'));
  return Promise.all(reads);
}

function views(page: Page) {
  const group = page.getByRole('group', { name: 'View' });
  return {
    group,
    pages: group.getByRole('button', { name: 'Pages', exact: true }),
    activity: group.getByRole('button', { name: 'Recent activity' }),
  };
}

function shownGroups(page: Page): Promise<string[]> {
  return page.locator('section.index-activity-page:not([hidden])').evaluateAll((groups) =>
    groups.map((group) => (group as HTMLElement).dataset.page ?? ''));
}

function group(page: Page, name: string) {
  return page.locator(`section.index-activity-page[data-page="${name}"]`);
}

function shownRows(page: Page): Promise<string[]> {
  return page.locator('.index-table tbody tr:not([hidden])').evaluateAll((rows) =>
    rows.map((row) => (row as HTMLElement).dataset.page ?? ''));
}

function option(page: Page, label: string) {
  return page.locator('.index-labels-option')
    .filter({ has: page.locator('.index-labels-name', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input[type="checkbox"]');
}

// An index this checkout's CLI builds over a directory with no page,
// served in place of the fixture's at the site's root so the theme still
// loads.
async function serveEmptyIndex(page: Page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-activity-empty-'));
  try {
    run('index', '--out-dir', dir);
    const body = fs.readFileSync(path.join(dir, 'index.html'), 'utf-8');
    await page.route((url) => url.pathname === '/', (route) =>
      route.fulfill({ body, contentType: 'text/html; charset=utf-8' }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// An activity route answer of one page with one event, `ago` before now.
function oneEvent(name: string, title: string, event: object, ago: number, older: boolean, to: number) {
  return {
    from: new Date(to - 7 * DAY).toISOString(), to: new Date(to).toISOString(), older,
    truncated: false,
    pages: [{ page: name, title, latest: new Date(to - ago).toISOString(),
      events: [{ ...event, at: new Date(to - ago).toISOString() }] }],
  };
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('the index opens on Recent activity, grouped by page, newest first, and the filters span both views', async ({ page, request }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(page);
    await catchUp(request);
    publish(A, source('Activity check A', 'A heater keeps a hole in the ice.'), '--label', LABEL);
    publish(B, source('Activity check B', 'The heater shares the pump outlet.'));
    // hermes listens, so the comment waits for it.
    hermes('pull', '--owner', OWNER);
    const posted = await request.post(COMMENTS, {
      headers: SIGNED_IN, data: { page: B, section: 'heater', text: 'Which outlet does it share?' },
    });
    expect(posted.status()).toBe(201);
    const { id: thread } = (await posted.json()) as Row;
    // A version is dated to the second: A's must come after the comment.
    await page.waitForTimeout(1100);
    publish(A, source('Activity check A', 'A floating heater keeps a hole in the ice.'),
      '--label', LABEL);

    try {
      await openIndex(page);
      const { group: switcher, pages, activity } = views(page);
      await expect(switcher).toBeVisible();
      // After the title.
      expect(await switcher.evaluate((node) => node.previousElementSibling?.className)).toBe('index-title');
      await expect(activity).toHaveAttribute('aria-pressed', 'true');
      await expect(pages).toHaveAttribute('aria-pressed', 'false');
      await expect(page.locator('.index-table')).toBeHidden();
      await expect(page.locator('.index-activity')).toBeVisible();
      expect((await shownGroups(page)).slice(0, 2)).toEqual([A, B]);
      await expect(page.locator('.index-count')).toHaveText(/^\d+ pages? with activity in the last 7 days$/);

      const a = group(page, A);
      await expect(a.locator('.index-activity-title a')).toHaveText('Activity check A');
      await expect(a.locator('.index-activity-title a')).toHaveAttribute('href', `${A}.html`);
      await expect(a.locator('.index-tag')).toHaveText([LABEL]);
      await expect(a.locator('.index-activity-count')).toHaveText('2 events');
      const aEvents = a.locator('li.index-activity-event');
      await expect(aEvents).toHaveCount(2);
      await expect(aEvents.nth(0)).toContainText('hermes published a new version: Heater changed');
      await expect(aEvents.nth(0).locator('.index-dot')).toHaveClass('index-dot index-dot--version');
      await expect(aEvents.nth(0).locator('.index-dot')).toHaveAttribute('aria-hidden', 'true');
      await expect(aEvents.nth(1)).toContainText('hermes published the page');
      // Today's events show the time of day alone.
      await expect(aEvents.nth(0).locator('time')).toHaveText(/^\d{2}:\d{2}( [AP]M)?$/);

      const b = group(page, B);
      const comment = b.locator('li.index-activity-event').first();
      await expect(comment.locator('.index-activity-actor')).toHaveText('you');
      await expect(comment).toContainText('you commented on “Heater”');
      await expect(comment.locator('.index-dot')).toHaveClass('index-dot index-dot--comment');
      await expect(b.locator('.index-activity-unread')).toHaveCount(0);

      // hermes replies to the comment: B moves above A.
      const claim = hermes('claim', String(thread));
      // A claim token may start with '-': give it to its option in one word.
      const reply = hermes('reply', String(thread), `--claim=${claim.claimToken}`,
        '--key', `activity-${thread}`, '--text', 'The one by the steps.');
      expect(reply.parent).toBe(thread);
      await openIndex(page, true);
      expect((await shownGroups(page)).slice(0, 2)).toEqual([B, A]);
      await expect(b.locator('.index-activity-unread')).toHaveText('1 new reply to you');
      await expect(b.locator('.index-activity-count')).toHaveText('3 events');
      const replied = b.locator('li.index-activity-event').first();
      await expect(replied).toContainText('hermes replied to your comment on “Heater” · new, to you');
      await expect(replied.locator('.index-activity-new')).toHaveText('new, to you');
      await expect(replied.locator('.index-dot')).toHaveClass('index-dot index-dot--reply index-dot--unread');

      // Pages, then back.
      await pages.click();
      await expect(page).toHaveURL(/#pages$/);
      await expect(pages).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.index-table')).toBeVisible();
      await expect(page.locator('.index-activity')).toBeHidden();
      await expect(page.locator('.index-count')).toHaveText(/^\d+ pages, newest update first$/);
      await page.goBack();
      await expect(page).not.toHaveURL(/#/);
      await expect(activity).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.index-activity')).toBeVisible();
      await expect(page.locator('.index-table')).toBeHidden();
      await page.goForward();
      await expect(pages).toHaveAttribute('aria-pressed', 'true');
      await activity.click();
      await expect(page).not.toHaveURL(/#/);
      await expect(activity).toHaveAttribute('aria-pressed', 'true');

      // A label only A carries keeps only A's group, then only its row.
      await page.getByRole('button', { name: /^Labels/ }).click();
      await option(page, LABEL).check();
      await page.keyboard.press('Escape');
      await expect.poll(() => shownGroups(page)).toEqual([A]);
      await expect(page.locator('.index-active')).toHaveText(`Showing ${LABEL} ✕`);
      await expect(page.locator('.index-count')).toHaveText(/^1 of \d+ pages? with activity in the last 7 days$/);
      await pages.click();
      await expect.poll(() => shownRows(page)).toEqual([A]);
      await expect(page.locator('.index-active')).toHaveText(`Showing ${LABEL} ✕`);
      await activity.click();

      // Unread keeps B alone, which carries no label: no group is left.
      const unread = page.locator('button.index-toggle', { hasText: /^Unread/ });
      await expect(unread).toHaveText('Unread · 1');
      await unread.click();
      await expect.poll(() => shownGroups(page)).toEqual([]);
      await expect(page.getByText('No activity matches these filters.')).toBeVisible();
      await expect(page.locator('.index-active')).toHaveText(`Showing ${LABEL} ✕ unread ✕`);

      // The search reads a group's events too.
      await page.getByRole('button', { name: `Remove filter ${LABEL}` }).click();
      await expect.poll(() => shownGroups(page)).toEqual([B]);
      // The unread reply's flag is event text too.
      await page.getByLabel('Search').fill('new, to you');
      await expect.poll(() => shownGroups(page)).toEqual([B]);
      await page.getByLabel('Search').fill('by the steps');
      await expect.poll(() => shownGroups(page)).toEqual([]);
      await page.getByLabel('Search').fill('your comment on “heater”');
      await expect.poll(() => shownGroups(page)).toEqual([B]);
      expect(errors).toEqual([]);
    } finally {
      // The label leaves the index with this check.
      publish(A, source('Activity check A', 'A floating heater keeps a hole in the ice.'),
        '--no-labels');
      await catchUp(request);
    }
  });

  test('Show older loads the 7 days before and merges them in', async ({ page }) => {
    const errors = watchErrors(page);
    const now = Date.now();
    const asked: (string | null)[] = [];
    const first = oneEvent('capture-comments', 'Capture comments',
      { kind: 'version', commit: 'c1', revision: 'r1', actor: null, first: false, summary: 'new version' },
      DAY, true, now);
    const earlier = {
      from: new Date(now - 14 * DAY).toISOString(), to: first.from, older: false, truncated: false,
      pages: [
        { page: 'capture-comments', title: 'Capture comments', latest: new Date(now - 9 * DAY).toISOString(),
          events: [{ kind: 'answer', at: new Date(now - 9 * DAY).toISOString(), question: '1',
            questionText: 'Which pump?', label: 'Floating', actor: { kind: 'human', name: 'robin' }, mine: false }] },
        { page: 'capture-article', title: 'Capture article', latest: new Date(now - 12 * DAY).toISOString(),
          events: [{ kind: 'reply', at: new Date(now - 12 * DAY).toISOString(), id: 9, thread: 8,
            sectionTitle: 'First section', actor: { kind: 'agent', handle: 'claude-3f9a2c' },
            mine: false, yours: false, unread: false }] },
      ],
    };
    await page.route((url) => url.pathname === ACTIVITY, (route) => {
      const before = new URL(route.request().url()).searchParams.get('before');
      asked.push(before);
      return route.fulfill({ json: before ? earlier : first });
    });

    await page.goto('/');
    const older = page.getByRole('button', { name: 'Show older' });
    await expect(older).toBeVisible();
    expect(await shownGroups(page)).toEqual(['capture-comments']);
    await expect(group(page, 'capture-comments').locator('li')).toHaveText([/Lotuspod published a new version$/]);
    await expect(page.locator('.index-count')).toHaveText('1 page with activity in the last 7 days');

    await older.click();
    await expect(older).toBeHidden();
    expect(asked).toEqual([null, first.from]);
    expect(await shownGroups(page)).toEqual(['capture-comments', 'capture-article']);
    const events = group(page, 'capture-comments').locator('li');
    await expect(events).toHaveCount(2);
    await expect(events.nth(1)).toContainText('robin answered “Which pump?”: Floating');
    await expect(events.nth(1).locator('.index-dot')).toHaveClass('index-dot index-dot--answer');
    // Not today: the day and the time.
    await expect(events.nth(1).locator('time')).not.toHaveText(/^\d{2}:\d{2}( [AP]M)?$/);
    await expect(group(page, 'capture-article').locator('li'))
      .toContainText('claude-3f9a2c replied in “First section”');
    await expect(group(page, 'capture-article').locator('.index-activity-new')).toHaveCount(0);
    await expect(page.locator('.index-count')).toHaveText('2 pages with activity in the last 14 days');
    expect(errors).toEqual([]);
  });

  test('back through the back-forward cache, the view asks again over the days it shows', async ({ page }) => {
    const errors = watchErrors(page);
    let read = false;
    const asked: (string | null)[] = [];
    const reply = (unread: boolean) => ({ kind: 'reply', id: 7, thread: 6, sectionTitle: 'Heater',
      actor: { kind: 'agent', handle: 'hermes' }, mine: false, yours: true, unread });
    // The week before `before`.
    const earlier = (before: string) => oneEvent('capture-article', 'Capture article',
      { kind: 'version', commit: 'c2', revision: 'r2', actor: 'hermes', first: true, summary: '' },
      3 * DAY, false, Date.parse(before));
    await page.route((url) => url.pathname === ACTIVITY, (route) => {
      const before = new URL(route.request().url()).searchParams.get('before');
      asked.push(before);
      if (before) return route.fulfill({ json: earlier(before) });
      // The newest week ends now, as the route's does.
      return route.fulfill({ json: oneEvent('capture-comments', 'Capture comments', reply(!read), DAY, true,
        Date.now()) });
    });

    await page.goto('/');
    const comments = group(page, 'capture-comments');
    await expect(comments.locator('.index-activity-new')).toHaveText('new, to you');
    await page.getByRole('button', { name: 'Show older' }).click();
    await expect.poll(() => shownGroups(page)).toEqual(['capture-comments', 'capture-article']);

    // The reply is read elsewhere; the index comes back from the cache.
    read = true;
    asked.length = 0;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(comments.locator('.index-activity-new')).toHaveCount(0);
    await expect(comments.locator('.index-dot')).toHaveClass('index-dot index-dot--reply');
    await expect(comments).toContainText('hermes replied to your comment on “Heater”');
    // Both weeks, as shown before.
    expect(await shownGroups(page)).toEqual(['capture-comments', 'capture-article']);
    expect(asked.length).toBe(2);
    expect(asked[0]).toBeNull();
    await expect(page.locator('.index-count')).toHaveText('2 pages with activity in the last 14 days');
    expect(errors).toEqual([]);
  });

  test('an answer with nothing in it says there was no activity', async ({ page }) => {
    const errors = watchErrors(page);
    const now = Date.now();
    await page.route((url) => url.pathname === ACTIVITY, (route) => route.fulfill({
      json: { from: new Date(now - 7 * DAY).toISOString(), to: new Date(now).toISOString(),
        older: false, truncated: false, pages: [] },
    }));
    await page.goto('/');
    await expect(views(page).activity).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.index-count')).toHaveText('No activity in the last 7 days.');
    await expect(page.getByText('No activity matches these filters.')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Show older' })).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('the Pages view lists Title, Updated, Created and Summary, each update with its time', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/#pages');
    await expect(views(page).pages).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.index-table')).toBeVisible();
    expect(await page.locator('.index-table thead th').allTextContents())
      .toEqual(['Title', 'Updated', 'Created', 'Summary']);
    const updated = await page.locator('.index-table tbody tr').evaluateAll((rows) =>
      rows.map((row) => (row as HTMLTableRowElement).cells[1].textContent?.trim() ?? ''));
    expect(updated.length).toBeGreaterThan(1);
    for (const text of updated) expect(text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(errors).toEqual([]);
  });

  test('a comment on a decision names its question, read from the page, else its section', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    const name = 'activity-check-decision';
    publish(name, ['# Activity check decision', '', 'Before the frost.', '',
      '## Decisions for the maintainer', '',
      '| # | Question | Options |', '|---|---|---|',
      '| 1 | Freeze the pond? | Yes / No |', ''].join('\n'));
    const posted = await request.post(COMMENTS, {
      headers: SIGNED_IN, data: { page: name, question: 'decision-1', text: 'What about the fish?' },
    });
    expect(posted.status()).toBe(201);
    const line = group(page, name).locator('li.index-activity-event').first();

    // No answer in the feed names the question: the index reads it from the page.
    await openIndex(page);
    await expect(line).toContainText('you commented on “Freeze the pond?”');

    // A page that cannot be read leaves its section's title, here none (the
    // thread sits in the page's own box), and never an id.
    await page.route((url) => url.pathname === `/${name}.html`, (route) =>
      route.fulfill({ status: 404, body: 'gone' }));
    await openIndex(page, true);
    await expect(line).toContainText('you commented on a decision');
    await expect(group(page, name)).not.toContainText('decision-1');
    await expect(group(page, name)).not.toContainText('“page”');
    expect(errors).toEqual([]);
  });

  test('an index with no page opens on Recent activity too, and says there was none', async ({ page }) => {
    const errors = watchErrors(page);
    await serveEmptyIndex(page);
    const now = Date.now();
    await page.route((url) => url.pathname === ACTIVITY, (route) => route.fulfill({
      json: { from: new Date(now - 7 * DAY).toISOString(), to: new Date(now).toISOString(),
        older: false, truncated: false, pages: [] },
    }));
    await page.goto('/');
    const { pages, activity } = views(page);
    await expect(activity).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.index-count')).toHaveText('No activity in the last 7 days.');
    await expect(page.getByText('Nothing in the pond yet.')).toBeHidden();
    await expect(page.getByText('No activity matches these filters.')).toBeHidden();

    await pages.click();
    await expect(page.getByText('Nothing in the pond yet.')).toBeVisible();
    await expect(page.getByText('No pages match these filters.')).toBeHidden();
    await expect(page.locator('.index-count')).toHaveText('0 pages');
    expect(errors).toEqual([]);
  });

  test('an index with no page and no activity answer is as it was', async ({ page }) => {
    const errors = watchErrors(page);
    await serveEmptyIndex(page);
    await page.route((url) => url.pathname === ACTIVITY, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    const read = activityRead(page);
    await page.goto('/');
    expect((await read).status()).toBe(404);
    await expect(page.getByText('Nothing in the pond yet.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'View' })).toHaveCount(0);
    await expect(page.locator('.index-controls')).toBeHidden();
    await expect(page.getByText('No pages match these filters.')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('answered 404, as the demo answers, the index is the Pages view with no switch', async ({ page }) => {
    const errors = watchErrors(page);
    await page.route((url) => url.pathname === ACTIVITY, (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    const read = activityRead(page);
    await page.goto('/');
    expect((await read).status()).toBe(404);
    await expect(page.locator('.index-count')).toHaveText(/^\d+ pages, newest update first$/);
    await expect(page.getByRole('group', { name: 'View' })).toHaveCount(0);
    await expect(page.locator('.index-table')).toBeVisible();
    await expect(page.locator('.index-activity')).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test('signed out, the activity route answers 401 and the index is the Pages view with no switch', async ({ page }) => {
  const errors = watchErrors(page);
  const read = activityRead(page);
  await page.goto('/');
  expect((await read).status()).toBe(401);
  await expect(page.locator('.index-count')).toHaveText(/^\d+ pages, newest update first$/);
  await expect(page.getByRole('group', { name: 'View' })).toHaveCount(0);
  await expect(page.locator('.index-table')).toBeVisible();
  await expect(page.locator('.index-activity')).toBeHidden();
  expect(errors).toEqual([]);
});
