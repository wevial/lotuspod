import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type FrameLocator, type Page } from '@playwright/test';

// A reply in a thread the reader started stays unread for them until they
// open the thread: marked New on the page, counted on its chip, in its header
// and its tab title, and on the index. Each check posts a thread of its own
// on the capture fixture's comments page, and hermes replies to it through
// real `lotuspod` commands on the fixture's agent socket.
const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

// The page polls /api/comments; a poll still in a route handler's route.fetch
// when a check ends would otherwise fail that check with "Test ended".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const PAGE = '/capture-comments.html';
const NAME = 'capture-comments';
const SECTION = 'next-steps';
const COMMENTS = '/api/comments';
const SEEN = '/api/seen';
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
// A second reader, who wrote nothing in the threads the first starts.
const SECOND = { 'Cf-Access-Jwt-Assertion': ENV.LOTUSPOD_TEST_ASSERTION_SECOND ?? '' };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const OWNER = 'hermes';
// Where the page keeps that the reader shows resolved threads.
const RESOLVED_SHOWN = `lotuspod:resolved-shown:${PAGE}`;

type Row = { id: number };
type Thread = { root: Row; replies: Row[] };

// `lotuspod comments ACTION ... --json` as hermes; what it printed.
function hermes(action: string, ...args: string[]) {
  const stdout = execFileSync(PYTHON, [
    '-m', 'lotuspod', 'comments', action, ...args, '--json',
    '--socket', SOCKET, '--credential', HERMES,
  ], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}

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

// The reader opens a thread on the comments page and hermes answers it: the
// thread's id and the reply's.
async function answered(request: APIRequestContext, text: string, name = NAME) {
  await catchUp(request);
  // hermes listens, and the comment names it, so it waits for it.
  hermes('pull', '--owner', OWNER);
  const posted = await request.post(COMMENTS, {
    headers: SIGNED_IN, data: { page: name, section: SECTION, text: `@${OWNER} ${text}` },
  });
  expect(posted.status()).toBe(201);
  const { id } = (await posted.json()) as Row;
  return { thread: id, reply: answer(id, 'A submerged heater, clear of the pump outlet.') };
}

// Resolve a thread as the reader, through the comments route.
async function resolve(request: APIRequestContext, thread: number) {
  const resolved = await request.post(COMMENTS, {
    headers: SIGNED_IN, data: { page: NAME, thread, resolved: true },
  });
  expect(resolved.status()).toBe(200);
}

// The page's post of a thread as seen, up to comment if given, once answered.
function seenPost(page: Page, thread: number, comment?: number) {
  return page.waitForResponse((response) => {
    if (new URL(response.url()).pathname !== SEEN || response.request().method() !== 'POST') return false;
    const body = response.request().postDataJSON() ?? {};
    return body.thread === thread && (comment === undefined || body.comment === comment);
  });
}

// The page's read of the threads that finds a thread resolved.
function readResolved(page: Page, thread: number) {
  return page.waitForResponse(async (response) =>
    new URL(response.url()).pathname === COMMENTS && response.request().method() === 'GET' &&
    ((await response.json()) as { threads: (Thread & { resolution: { resolved: boolean } | null })[] })
      .threads.some((each) => each.root.id === thread && each.resolution?.resolved), { timeout: 60_000 });
}

// The tab hidden or shown, as a browser says so.
async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

// Publish a page of hermes's whose Next steps section holds no thread yet
// (a page with one section has a box for the whole page only),
// under a name no earlier run has used; its name.
function publish() {
  const name = `unread-resolved-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-unread-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, ['# Pond heater', '', 'Keeping the pond open over winter.', '',
      '## Findings', '', 'The pond freezes in January.', '', '## Next steps', '', 'Fit the heater.', ''].join('\n'), 'utf-8');
    const said = execFileSync(PYTHON, ['-m', 'lotuspod', 'publish', file, '--local', '--out-dir', OUT,
      '--owner', OWNER, '--credential', HERMES, '--comments'], {
      encoding: 'utf-8', env: { ...ENV, PYTHONPATH: SRC }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    });
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return name;
}

// hermes answers the reader's comment ID; the reply's id.
function answer(id: number, text: string) {
  const claim = hermes('claim', String(id));
  // A claim token may start with '-': give it to its option in one word.
  const reply = hermes('reply', String(id), `--claim=${claim.claimToken}`, '--key', `unread-${id}`, '--text', text);
  expect(reply.parent).toBe(id);
  return reply.id as number;
}

// The reader starts a thread on the section from the panel's form, naming
// hermes, which waits for it; the thread's id once it is stored.
async function startInPanel(page: Page, text: string, on: Page | FrameLocator = page) {
  hermes('pull', '--owner', OWNER);
  await on.locator('.artifact-comments-rail').click();
  await on.locator('aside.artifact-comments-panel').getByRole('button', { name: 'Comment on a section' }).click();
  await on.locator('aside.artifact-comments-panel').getByRole('option').filter({ hasText: 'Next steps' }).click();
  const field = on.getByLabel('Comment on Next steps');
  await expect(field).toBeFocused();
  await field.fill(`@${OWNER} ${text}`);
  const posted = page.waitForResponse((response) =>
    new URL(response.url()).pathname === COMMENTS && response.request().method() === 'POST');
  await on.locator('aside.artifact-comments-panel').getByRole('button', { name: 'Comment', exact: true }).click();
  const stored = await posted;
  expect(stored.status()).toBe(201);
  return ((await stored.json()) as Row).id;
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

function threadsRead(page: Page) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === COMMENTS && response.request().method() === 'GET');
}

// Open the comments page on its own (?standalone, so it does not open in the
// index's tabs), or load it again, and let its first read of the threads come
// back.
async function openPage(page: Page, again = false, at = PAGE) {
  const read = threadsRead(page);
  await (again ? page.reload() : page.goto(`${at}?standalone`));
  await read;
}

function chip(page: Page) {
  return page.locator(`details.artifact-comment[data-section="${SECTION}"] summary`);
}

function reply(page: Page, id: number) {
  return page.locator(`.artifact-comment-thread .artifact-comment-item:has(#artifact-comment-text-${id})`);
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
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  // What these checks leave unread is no later check's.
  test.afterEach(async ({ request }) => {
    await catchUp(request);
  });

  test('a reply is counted until its thread opens, marked New while it is open, and gone after', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    const { thread, reply: id } = await answered(request, 'Which heater, and where does it go?');

    await openPage(page);
    const title = await page.evaluate(() => document.title.replace(/^\(\d+\) /, ''));
    await expect(chip(page).locator('.artifact-comment-chip-unread')).toHaveText('1 new');
    await expect(page.locator('header.artifact-header .artifact-meta .artifact-unread'))
      .toHaveText('1 new reply to you');
    // It ends the date line.
    expect(await page.locator('.artifact-unread').evaluate((node) => node.nextElementSibling)).toBeNull();
    await expect(page).toHaveTitle(`(1) ${title}`);

    // The chip opens the section's newest thread, this one, and the page
    // posts its newest comment as seen.
    const seen = page.waitForResponse((response) =>
      new URL(response.url()).pathname === SEEN && response.request().method() === 'POST' &&
      'thread' in (response.request().postDataJSON() ?? {}));
    await chip(page).click();
    const answer = await seen;
    expect(answer.status()).toBe(200);
    expect(answer.request().postDataJSON()).toEqual({ page: NAME, thread, comment: id });
    expect(await answer.json()).toEqual({ thread, comment: id });

    const theirs = reply(page, id);
    await expect(theirs).toBeVisible();
    await expect(theirs).toHaveClass(/\bartifact-comment--unread\b/);
    await expect(theirs.locator('.artifact-comment-by .artifact-comment-new')).toHaveText('New');
    const divider = page.locator(`.artifact-comment-thread[data-thread="${thread}"] .artifact-comment-divider`);
    await expect(divider).toHaveText('New since you last looked');
    // Right above the reply.
    expect(await divider.evaluate((node, replyId) =>
      node.nextElementSibling?.querySelector(`#artifact-comment-text-${replyId}`) !== null, id)).toBe(true);
    // Seen: nothing counts any more, though the reply stays marked while open.
    await expect(page.locator('.artifact-unread')).toHaveCount(0);
    await expect(page).toHaveTitle(title);
    await expect(chip(page).locator('.artifact-comment-chip-unread')).toHaveCount(0);
    await expect(theirs).toHaveClass(/\bartifact-comment--unread\b/);

    // The window narrowed to a popover, the thread keeps its New marks.
    await page.setViewportSize({ width: 1024, height: 900 });
    const popover = page.locator('.artifact-comments-popover');
    await expect(popover.locator(`.artifact-comment-thread[data-thread="${thread}"]`)).toBeVisible();
    const narrowed = popover.locator(`.artifact-comment-item:has(#artifact-comment-text-${id})`);
    await expect(narrowed).toHaveClass(/\bartifact-comment--unread\b/);
    await expect(narrowed.locator('.artifact-comment-new')).toHaveText('New');
    await expect(popover.locator('.artifact-comment-divider')).toHaveText('New since you last looked');
    await expect(page.locator('.artifact-unread')).toHaveCount(0);

    await page.setViewportSize(WIDE);
    await openPage(page, true);
    await expect(reply(page, id)).toHaveCount(1);
    await expect(page.locator('.artifact-comment--unread')).toHaveCount(0);
    await expect(page.locator('.artifact-comment-new')).toHaveCount(0);
    await expect(page.locator('.artifact-unread')).toHaveCount(0);
    await expect(page.locator('.artifact-comment-chip-unread')).toHaveCount(0);
    await expect(page).toHaveTitle(title);
    expect(errors).toEqual([]);
  });

  test('folding the panel closes its thread, and unfolding it opens the thread again', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await catchUp(request);
    // hermes listens, and the comment names it, so it waits for it, and the
    // page keeps reading the threads while the panel is folded.
    hermes('pull', '--owner', OWNER);
    const posted = await request.post(COMMENTS, {
      headers: SIGNED_IN, data: { page: NAME, section: SECTION, text: '@hermes Does the pump need a cover?' },
    });
    expect(posted.status()).toBe(201);
    const { id: thread } = (await posted.json()) as Row;

    await openPage(page);
    await chip(page).click();
    const entry = page.locator(`.artifact-comment-thread[data-thread="${thread}"]`);
    await expect(entry).toBeVisible();
    await page.locator('.artifact-comments-fold').click();
    await expect(entry).toBeHidden();

    // hermes answers while the panel is folded: the reply is counted.
    const answer = page.waitForResponse(async (response) =>
      new URL(response.url()).pathname === COMMENTS && response.request().method() === 'GET' &&
      ((await response.json()) as { unread?: number[] }).unread?.length === 1, { timeout: 60_000 });
    const claim = hermes('claim', String(thread));
    const { id } = hermes('reply', String(thread), `--claim=${claim.claimToken}`,
      '--key', `unread-fold-${thread}`, '--text', 'A board over it, weighted at the corners.');
    expect(((await (await answer).json()) as { unread: number[] }).unread).toEqual([id]);
    await expect(page.locator('.artifact-unread')).toHaveText('1 new reply to you');

    // Unfolded, the thread is open again: it posts the reply as seen and
    // marks it New while it stays open.
    const seen = page.waitForResponse((response) =>
      new URL(response.url()).pathname === SEEN && response.request().method() === 'POST' &&
      'thread' in (response.request().postDataJSON() ?? {}));
    await page.locator('.artifact-comments-rail').click();
    expect((await seen).request().postDataJSON()).toEqual({ page: NAME, thread, comment: id });
    await expect(reply(page, id)).toHaveClass(/\bartifact-comment--unread\b/);
    await expect(reply(page, id).locator('.artifact-comment-new')).toHaveText('New');
    await expect(page.locator('.artifact-unread')).toHaveCount(0);

    // Folded and unfolded again, the reply is read: no longer marked.
    await page.locator('.artifact-comments-fold').click();
    await page.locator('.artifact-comments-rail').click();
    await expect(reply(page, id)).toBeVisible();
    await expect(page.locator('.artifact-comment--unread')).toHaveCount(0);
    await expect(page.locator('.artifact-comment-divider')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a thread opened with nothing unread is posted as seen too', async ({ page, request }) => {
    const errors = watchErrors(page);
    await catchUp(request);
    const posted = await request.post(COMMENTS, {
      headers: SIGNED_IN, data: { page: NAME, section: SECTION, text: 'Is the overflow clear?' },
    });
    expect(posted.status()).toBe(201);
    const { id: thread } = (await posted.json()) as Row;

    await openPage(page);
    const seen = page.waitForResponse((response) =>
      new URL(response.url()).pathname === SEEN && response.request().method() === 'POST' &&
      'thread' in (response.request().postDataJSON() ?? {}));
    await chip(page).click();
    const answer = await seen;
    expect(answer.request().postDataJSON()).toEqual({ page: NAME, thread, comment: thread });
    expect(await answer.json()).toEqual({ thread, comment: thread });
    await expect(page.locator('.artifact-comment--unread')).toHaveCount(0);
    await expect(page.locator('.artifact-unread')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a thread opened from a folded panel is the only one seen', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await catchUp(request);
    hermes('pull', '--owner', OWNER);
    const start = async (section: string, text: string) => {
      const posted = await request.post(COMMENTS, { headers: SIGNED_IN, data: { page: NAME, section, text } });
      expect(posted.status()).toBe(201);
      return ((await posted.json()) as Row).id;
    };
    const mine = await start(SECTION, '@hermes Should the pump come out for winter?');
    const other = await start('findings', 'How thick does the ice get?');

    await openPage(page);
    await chip(page).click();
    await expect(page.locator(`.artifact-comment-thread[data-thread="${mine}"]`)).toBeVisible();
    await page.locator('.artifact-comments-fold').click();

    const answer = page.waitForResponse(async (response) =>
      new URL(response.url()).pathname === COMMENTS && response.request().method() === 'GET' &&
      ((await response.json()) as { unread?: number[] }).unread?.length === 1, { timeout: 60_000 });
    const claim = hermes('claim', String(mine));
    const { id } = hermes('reply', String(mine), `--claim=${claim.claimToken}`,
      '--key', `unread-switch-${mine}`, '--text', 'Out, and stored somewhere frost-free.');
    await answer;
    await expect(page.locator('.artifact-unread')).toHaveText('1 new reply to you');

    // Another section's chip opens the panel at its own thread: that one is
    // posted as seen, and the one selected before is not looked at.
    const posts: unknown[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === SEEN && sent.method() === 'POST') posts.push(sent.postDataJSON());
    });
    await page.locator('details.artifact-comment[data-section="findings"] summary').click();
    await expect(page.locator(`.artifact-comment-thread[data-thread="${other}"]`)).toBeVisible();
    await expect.poll(() => posts.length).toBe(1);
    await page.waitForTimeout(500);
    expect(posts).toEqual([{ page: NAME, thread: other, comment: other }]);
    await expect(page.locator('.artifact-unread')).toHaveText('1 new reply to you');
    const read = await request.get(`${COMMENTS}?page=${NAME}`, { headers: SIGNED_IN });
    expect(((await read.json()) as { unread: number[] }).unread).toEqual([id]);
    expect(errors).toEqual([]);
  });

  test('a resolved thread opens from its line to read its reply, which is then seen, and it stays resolved', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    const { thread, reply: id } = await answered(request, 'Should the heater stay in all winter?');
    await resolve(request, thread);
    const resolving: unknown[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === COMMENTS && sent.method() === 'POST' &&
        'resolved' in (sent.postDataJSON() ?? {})) resolving.push(sent.postDataJSON());
    });

    await openPage(page);
    const title = await page.evaluate(() => document.title.replace(/^\(\d+\) /, ''));
    await expect(page.locator('header.artifact-header .artifact-meta .artifact-unread'))
      .toHaveText('1 new reply to you');
    await expect(page).toHaveTitle(`(1) ${title}`);
    await page.locator('.artifact-comments-rail').click();
    await page.locator('.artifact-comments-show-resolved', { hasText: /^Show resolved/ }).click();
    const item = page.locator(`.artifact-comments-panel .artifact-comments-entry[data-thread="${thread}"]`);
    const line = item.locator('.artifact-comments-entry-resolved');
    const read = line.locator('.artifact-comments-entry-read');
    await expect(line).toBeVisible();
    await expect(line.getByRole('button', { name: 'Reopen' })).toBeVisible();
    await expect(item.locator('.artifact-comments-entry-head')).toBeHidden();
    await expect(read).toHaveAttribute('aria-expanded', 'false');
    await expect(reply(page, id)).toBeHidden();

    // Its line opens it: the reply shows marked New, and is posted as seen.
    const seen = seenPost(page, thread);
    await read.click();
    const answer = await seen;
    expect(answer.request().postDataJSON()).toEqual({ page: NAME, thread, comment: id });
    expect(answer.status()).toBe(200);
    const theirs = reply(page, id);
    await expect(theirs).toBeVisible();
    await expect(theirs).toHaveClass(/\bartifact-comment--unread\b/);
    await expect(theirs.locator('.artifact-comment-by .artifact-comment-new')).toHaveText('New');
    const divider = item.locator('.artifact-comment-divider');
    await expect(divider).toHaveText('New since you last looked');
    expect(await divider.evaluate((node, replyId) =>
      node.nextElementSibling?.querySelector(`#artifact-comment-text-${replyId}`) !== null, id)).toBe(true);
    // Still resolved: its line stays, with Reopen and no Resolve.
    await expect(read).toHaveAttribute('aria-expanded', 'true');
    await expect(line.getByRole('button', { name: 'Reopen' })).toBeVisible();
    await expect(item.locator('.artifact-comments-resolve')).toBeHidden();
    await expect(page.locator('.artifact-unread')).toHaveCount(0);
    await expect(page).toHaveTitle(title);

    // As the window narrows to a popover, the thread moves there still open
    // to read, its reply marked New; widened again, it is back in the panel.
    await page.setViewportSize({ width: 1024, height: 900 });
    const popover = page.locator('.artifact-comments-popover');
    const moved = popover.locator(`.artifact-comment-item:has(#artifact-comment-text-${id})`);
    await expect(moved).toBeVisible();
    await expect(moved.locator('.artifact-comment-new')).toHaveText('New');
    await expect(popover.locator('.artifact-comments-entry-read')).toHaveAttribute('aria-expanded', 'true');
    await page.setViewportSize(WIDE);

    // Its line again: folded back to the line.
    await read.click();
    await expect(read).toHaveAttribute('aria-expanded', 'false');
    await expect(theirs).toBeHidden();
    await expect(line).toBeVisible();
    expect(resolving).toEqual([]);

    await openPage(page, true);
    await expect(page.locator(`.artifact-comments-entry[data-thread="${thread}"]`))
      .toHaveClass(/\bartifact-comments-entry--resolved\b/);
    await expect(reply(page, id)).toHaveCount(1);
    await expect(page.locator('.artifact-comment--unread')).toHaveCount(0);
    await expect(page.locator('.artifact-comment-new')).toHaveCount(0);
    await expect(page.locator('.artifact-unread')).toHaveCount(0);
    await expect(page).toHaveTitle(title);
    const stored = await request.get(`${COMMENTS}?page=${NAME}`, { headers: SIGNED_IN });
    const { threads } = (await stored.json()) as { threads: (Thread & { resolution: { resolved: boolean } })[] };
    expect(threads.find((each) => each.root.id === thread)?.resolution.resolved).toBe(true);
    expect(resolving).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('a resolved thread opens from its line in its section\'s popover, and its reply is seen', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1024, height: 900 });
    const { thread, reply: id } = await answered(request, 'Does the heater need a guard?');
    await resolve(request, thread);
    // Resolved threads shown, as the panel's control would leave them.
    await page.addInitScript((key) => sessionStorage.setItem(key, '1'), RESOLVED_SHOWN);

    await openPage(page);
    await expect(page.locator('.artifact-unread')).toHaveText('1 new reply to you');
    await chip(page).click();
    const popover = page.locator('.artifact-comments-popover');
    const item = popover.locator(`.artifact-comments-entry[data-thread="${thread}"]`);
    const read = item.locator('.artifact-comments-entry-resolved .artifact-comments-entry-read');
    await expect(read).toBeVisible();
    await expect(item.getByRole('button', { name: 'Reopen' })).toBeVisible();
    const theirs = popover.locator(`.artifact-comment-item:has(#artifact-comment-text-${id})`);
    await expect(theirs).toBeHidden();

    const seen = seenPost(page, thread);
    await read.click();
    const answer = await seen;
    expect(answer.request().postDataJSON()).toEqual({ page: NAME, thread, comment: id });
    expect(answer.status()).toBe(200);
    await expect(theirs).toBeVisible();
    await expect(theirs).toHaveClass(/\bartifact-comment--unread\b/);
    await expect(theirs.locator('.artifact-comment-new')).toHaveText('New');
    await expect(item.locator('.artifact-comments-resolve')).toBeHidden();
    await expect(page.locator('.artifact-unread')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a thread resolved elsewhere while open reads from its line at the first press, and reopened stays open as resolved ones hide', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await catchUp(request);
    const start = async (text: string) => {
      const posted = await request.post(COMMENTS, {
        headers: SIGNED_IN, data: { page: NAME, section: SECTION, text },
      });
      expect(posted.status()).toBe(201);
      return ((await posted.json()) as Row).id;
    };
    // Another resolved thread keeps the Hide resolved control once this
    // one is reopened.
    await resolve(request, await start('Is the old heater kept as a spare?'));
    const thread = await start('Is the heater on a timer?');

    await openPage(page);
    await chip(page).click();
    const item = page.locator(`.artifact-comments-panel .artifact-comments-entry[data-thread="${thread}"]`);
    const head = item.locator('.artifact-comments-entry-head');
    const read = item.locator('.artifact-comments-entry-read');
    const said = item.locator('.artifact-comment-thread');
    await expect(head).toHaveAttribute('aria-expanded', 'true');

    // Resolved in another tab: the page reads it so and folds it.
    let polled = readResolved(page, thread);
    await resolve(request, thread);
    await polled;
    await expect(item).toHaveClass(/\bartifact-comments-entry--resolved\b/);
    await page.locator('.artifact-comments-show-resolved', { hasText: /^Show resolved/ }).click();
    await expect(said).toBeHidden();
    await read.click();
    await expect(read).toHaveAttribute('aria-expanded', 'true');
    await expect(said).toBeVisible();

    // Reopened, it is no longer read as resolved: hiding those leaves it open.
    await item.getByRole('button', { name: 'Reopen' }).click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.artifact-comments-show-resolved', { hasText: 'Hide resolved' }).click();
    await expect(head).toHaveAttribute('aria-expanded', 'true');
    await expect(said).toBeVisible();

    // Resolved elsewhere again, it folds, hidden with the others, and is
    // not taken as read while out of sight.
    const posts: unknown[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === SEEN && sent.method() === 'POST' &&
        (sent.postDataJSON() ?? {}).thread === thread) posts.push(sent.postDataJSON());
    });
    polled = readResolved(page, thread);
    await resolve(request, thread);
    await polled;
    await expect(item).toBeHidden();
    await expect(read).toHaveAttribute('aria-expanded', 'false');
    await page.locator('.artifact-comments-fold').click();
    await page.locator('.artifact-comments-rail').click();
    await expect(page.locator('.artifact-comments-fold')).toBeVisible();
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the index counts the reply on its row and in its title, and Unread keeps only that row', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await answered(request, 'Does the pump need a cover?');

    const read = page.waitForResponse((response) =>
      new URL(response.url()).pathname === SEEN && response.request().method() === 'GET');
    // The Pages view: signed in, the index opens on Recent activity.
    await page.goto('/#pages');
    await read;
    const all = await shownPages(page);
    expect(all.length).toBeGreaterThan(1);
    const badge = row(page, NAME).locator('span.index-unread');
    await expect(badge).toHaveText('1 new reply');
    await expect(page.locator('.index-unread')).toHaveCount(1);
    // Beside the title's link.
    expect(await badge.evaluate((node) => node.parentElement?.querySelector('a') !== null)).toBe(true);
    await expect(page).toHaveTitle('(1) Lotuspod');

    // After the Updated toggle, unpressed.
    const toggle = page.locator('button.index-toggle', { hasText: /^Unread/ });
    await expect(toggle).toHaveText('Unread · 1');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(await toggle.evaluate((node) => node.previousElementSibling?.textContent ?? ''))
      .toMatch(/^Updated · \d+$/);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => shownPages(page)).toEqual([NAME]);
    await expect(page.locator('.index-active')).toHaveText('Showing unread ✕');
    await expect(page.locator('.index-count')).toHaveText(`1 of ${all.length} pages`);

    // The search still applies on top.
    await page.getByLabel('Search').fill('no page says this');
    await expect(page.locator('.index-table tbody tr:not([hidden])')).toHaveCount(0);
    await page.getByLabel('Search').fill('');
    await expect.poll(() => shownPages(page)).toEqual([NAME]);

    await page.getByRole('button', { name: 'Remove filter unread' }).click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(toggle).toBeFocused();
    await expect.poll(() => shownPages(page)).toEqual(all);
    expect(errors).toEqual([]);
  });

  test('answered as the demo answers, with no unread and the seen route 404, nothing is marked or counted', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    const { thread, reply: id } = await answered(request, 'Will the heater trip the breaker?');
    const posts: unknown[] = [];
    await page.route((url) => url.pathname === SEEN, (route) => {
      if (route.request().method() === 'POST') posts.push(route.request().postDataJSON());
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    });
    await page.route((url) => url.pathname === COMMENTS, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const payload = await response.json();
      expect(payload.unread).toContain(id);
      delete payload.unread;
      return route.fulfill({ response, json: payload });
    });

    await openPage(page);
    const title = await page.evaluate(() => document.title);
    expect(title.startsWith('(')).toBe(false);
    await chip(page).click();
    const theirs = reply(page, id);
    await expect(theirs).toBeVisible();
    await expect(page.locator(`.artifact-comment-thread[data-thread="${thread}"]`)).toBeVisible();
    await expect(page.locator('.artifact-comment--unread')).toHaveCount(0);
    await expect(page.locator('.artifact-comment-new')).toHaveCount(0);
    await expect(page.locator('.artifact-comment-divider')).toHaveCount(0);
    await expect(page.locator('.artifact-comment-chip-unread')).toHaveCount(0);
    await expect(page.locator('.artifact-unread')).toHaveCount(0);
    await expect(page).toHaveTitle(title);
    // Only the page's own post of its revision; opening the thread posts nothing.
    expect(posts.filter((body) => typeof body === 'object' && body !== null && 'thread' in body))
      .toEqual([]);

    const read = page.waitForResponse((response) => new URL(response.url()).pathname === SEEN);
    await page.goto('/#pages');
    await read;
    await expect(page.locator('.index-count')).toBeVisible();
    await expect(page.locator('.index-toggle')).toHaveCount(0);
    await expect(page.locator('.index-unread')).toHaveCount(0);
    await expect(page).toHaveTitle('Lotuspod');

    // The index still filters: the Labels menu, then the search.
    const all = await shownPages(page);
    expect(all).toContain(NAME);
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
    const name = (await row(page, NAME).locator('a').first().textContent())?.trim() ?? '';
    await page.getByLabel('Search').fill(name);
    await expect.poll(() => shownPages(page)).toEqual([NAME]);
    expect(errors).toEqual([]);
  });
  test('a reply that arrives in the open thread is posted as seen, and counts nowhere', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await catchUp(request);
    await openPage(page);
    const title = await page.evaluate(() => document.title.replace(/^\(\d+\) /, ''));
    const thread = await startInPanel(page, 'Does the heater need a thermostat?');
    const item = page.locator(`.artifact-comments-panel .artifact-comments-entry[data-thread="${thread}"]`);
    await expect(item.locator('.artifact-comments-entry-head')).toHaveAttribute('aria-expanded', 'true');

    const id = answer(thread, 'One built in, set to four degrees.');
    const seen = await seenPost(page, thread, id);
    expect(seen.status()).toBe(200);
    const theirs = reply(page, id);
    await expect(theirs).toBeVisible();
    await expect(theirs.locator('.artifact-comment-new')).toHaveText('New');
    await expect(chip(page).locator('.artifact-comment-chip-unread')).toHaveCount(0);
    await expect(page.locator('header.artifact-header .artifact-meta .artifact-unread')).toHaveCount(0);
    await expect(page).toHaveTitle(title);

    await openPage(page, true);
    await expect(reply(page, id)).toHaveCount(1);
    await expect(page.locator('.artifact-unread')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a reply that arrives in a thread open in view is posted as seen for a reader it never counted for', async ({ browser, request }) => {
    test.setTimeout(120_000);
    expect(SECOND['Cf-Access-Jwt-Assertion'], 'the capture fixture names a second reader').toBeTruthy();
    await catchUp(request);
    hermes('pull', '--owner', OWNER);
    const posted = await request.post(COMMENTS, {
      headers: SIGNED_IN, data: { page: NAME, section: SECTION, text: `@${OWNER} Is the heater rated for outdoors?` },
    });
    expect(posted.status()).toBe(201);
    const { id: thread } = (await posted.json()) as Row;

    const context = await browser.newContext({ extraHTTPHeaders: SECOND, viewport: WIDE });
    try {
      const page = await context.newPage();
      const errors = watchErrors(page);
      await openPage(page);
      const opened = seenPost(page, thread, thread);
      await chip(page).click();
      expect((await opened).status()).toBe(200);
      const item = page.locator(`.artifact-comments-panel .artifact-comments-entry[data-thread="${thread}"]`);
      await expect(item.locator('.artifact-comments-entry-head')).toHaveAttribute('aria-expanded', 'true');

      // Not this reader's thread: the reply never counts for them, and is
      // seen all the same as it is drawn in the open thread.
      const id = answer(thread, 'It is: IP68.');
      const arrived = await seenPost(page, thread, id);
      expect(arrived.status()).toBe(200);
      await expect(reply(page, id)).toBeVisible();
      await expect(reply(page, id)).not.toHaveClass(/\bartifact-comment--unread\b/);
      await expect(page.locator('.artifact-unread')).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('a reply that arrives in the open thread of an index tab not shown is posted as seen once the tab shows', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await catchUp(request);
    // Loaded at its own address, the page opens as the index's active tab.
    await page.goto(PAGE);
    const frame = page.locator('iframe.pod-frame--active');
    await expect(frame).toBeVisible();
    const title = (await frame.getAttribute('title')) ?? '';
    const framed = page.frameLocator(`iframe.pod-frame[title="${title}"]`);
    await expect(framed.locator('details.artifact-comment')).not.toHaveCount(0);
    const thread = await startInPanel(page, 'Does the heater need its own breaker?', framed);
    await expect(framed.locator(`.artifact-comments-entry[data-thread="${thread}"] .artifact-comments-entry-head`))
      .toHaveAttribute('aria-expanded', 'true');
    await expect(framed.locator(`.artifact-comment-thread[data-thread="${thread}"] .artifact-comment-typing`)).toBeVisible();
    await page.waitForTimeout(300);

    const posts: unknown[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === SEEN && sent.method() === 'POST' &&
        (sent.postDataJSON() ?? {}).thread === thread) posts.push(sent.postDataJSON());
    });
    // The listing shown, the tab's frame is hidden; the page in it still reads.
    await page.locator('.pod-tabs-bar').getByRole('button', { name: 'Lotuspod', exact: true }).click();
    await expect(page.locator(`iframe.pod-frame[title="${title}"]`)).toBeHidden();
    const id = answer(thread, 'It does: a 6 A one.');
    await page.waitForResponse(async (response) =>
      new URL(response.url()).pathname === COMMENTS && response.request().method() === 'GET' &&
      ((await response.json()) as { unread?: number[] }).unread?.includes(id), { timeout: 60_000 });
    await expect(framed.locator('header.artifact-header .artifact-meta .artifact-unread')).toHaveText('1 new reply to you');
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);

    const seen = seenPost(page, thread, id);
    await page.getByRole('group', { name: 'Open pods' }).locator('.pod-tab[data-page="capture-comments"] button.pod-tab-title').click();
    expect((await seen).status()).toBe(200);
    await expect(framed.locator('.artifact-unread')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a reply that arrives in the open thread while the page is hidden is posted as seen once it shows', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    await catchUp(request);
    await openPage(page);
    const thread = await startInPanel(page, 'Should the heater go in before the first frost?');
    const item = page.locator(`.artifact-comments-panel .artifact-comments-entry[data-thread="${thread}"]`);
    await expect(item.locator('.artifact-comments-entry-head')).toHaveAttribute('aria-expanded', 'true');
    // The post of the thread as it opened is in before the page hides.
    await expect(page.locator(`.artifact-comment-thread[data-thread="${thread}"] .artifact-comment-typing`)).toBeVisible();
    await page.waitForTimeout(300);

    const posts: unknown[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === SEEN && sent.method() === 'POST' &&
        (sent.postDataJSON() ?? {}).thread === thread) posts.push(sent.postDataJSON());
    });
    await setVisibility(page, 'hidden');
    const id = answer(thread, 'Yes, a week before.');
    // A hidden page reads no threads on its own: a link to a thread it does
    // not have reads them and opens nothing.
    const read = page.waitForResponse(async (response) =>
      new URL(response.url()).pathname === COMMENTS && response.request().method() === 'GET' &&
      ((await response.json()) as { unread?: number[] }).unread?.includes(id));
    await page.evaluate(() => { location.hash = '#thread=999999999'; });
    await read;
    await expect(reply(page, id)).toBeAttached();
    await expect(page.locator('header.artifact-header .artifact-meta .artifact-unread')).toHaveText('1 new reply to you');
    await page.waitForTimeout(500);
    expect(posts).toEqual([]);

    const seen = seenPost(page, thread, id);
    await setVisibility(page, 'visible');
    expect((await seen).status()).toBe(200);
    await expect(page.locator('.artifact-unread')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('Resolve posts the thread as seen, and the section\'s chip says it is resolved until a follow-up comes', async ({ page, request }) => {
    test.setTimeout(120_000);
    const errors = watchErrors(page);
    const name = publish();
    const at = `/${name}.html`;
    const { thread, reply: id } = await answered(request, 'Does the heater want a float switch?', name);
    // The page's first post of the thread as seen is refused: the reply
    // still counts.
    let refused = false;
    await page.route((url) => url.pathname === SEEN, (route) => {
      const body = route.request().postDataJSON() ?? {};
      if (!refused && route.request().method() === 'POST' && body.thread === thread) {
        refused = true;
        return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"refused"}' });
      }
      return route.continue();
    });

    await openPage(page, false, at);
    const refusal = seenPost(page, thread);
    await chip(page).click();
    expect((await refusal).status()).toBe(500);
    const item = page.locator(`.artifact-comments-panel .artifact-comments-entry[data-thread="${thread}"]`);
    await expect(reply(page, id)).toBeVisible();
    await expect(page.locator('header.artifact-header .artifact-meta .artifact-unread')).toHaveText('1 new reply to you');

    const seen = seenPost(page, thread, id);
    await item.getByRole('button', { name: 'Resolve' }).click();
    const posted = await seen;
    expect(posted.status()).toBe(200);
    await expect(page.locator('header.artifact-header .artifact-meta .artifact-unread')).toHaveCount(0);
    await expect(chip(page).locator('.artifact-comment-chip-text')).toHaveText('1 resolved');

    // A follow-up to the resolved thread counts.
    hermes('follow-up', String(thread), '--key', `unread-follow-up-${thread}`, '--text', 'It came with one fitted.');
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await openPage(page, true, at);
    await expect(chip(page).locator('.artifact-comment-chip-text')).toHaveText('1 resolved · 1 new');
    await expect(page.locator('header.artifact-header .artifact-meta .artifact-unread')).toHaveText('1 new reply to you');

    // With an open thread beside it, the section reads that thread's line.
    hermes('pull', '--owner', OWNER);
    const open = await request.post(COMMENTS, {
      headers: SIGNED_IN, data: { page: name, section: SECTION, text: `@${OWNER} Where does the cable run?` },
    });
    expect(open.status()).toBe(201);
    await openPage(page, true, at);
    await expect(chip(page).locator('.artifact-comment-chip-text')).toHaveText('1 comment · waiting · 1 new');
    expect(errors).toEqual([]);
  });
});
