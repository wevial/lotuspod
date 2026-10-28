import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page, type Request } from '@playwright/test';

// Emoji reactions on a thread's comments: each comment shows its reactions
// as chips under its text, a chip adds or removes the reader's own, and Add
// reaction opens six quick emoji. Each check renders a page of its own into
// the capture fixture's site, owned by hermes; the reader opens a thread on
// it and hermes follows it up through the real `lotuspod comments
// follow-up`. At 1440 pixels a section's threads open in the panel, and on a
// touch phone in a bottom sheet.
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
test.use({ viewport: WIDE });

const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
// A second reader, heron.
const SECOND = { 'Cf-Access-Jwt-Assertion': ENV.LOTUSPOD_TEST_ASSERTION_SECOND ?? '' };
const SOCKET = ENV.LOTUSPOD_TEST_SOCKET ?? '';
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const OWNER = 'hermes';
const COMMENTS = '/api/comments';
const SECTION = 'pond';
const QUICK = ['👍', '❤️', '🎉', '😄', '👀', '✅'];
const BODY = `<p>A page for the reaction checks.</p>
<h2>Pond</h2>
<p>The pond freezes in January, and the pump stops with it.</p>
<h2>Frogs</h2>
<p>The frogs sleep under the ice until the thaw.</p>
`;

test.beforeAll(() => {
  for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
});

// The page polls /api/comments; a poll still in a route handler's
// route.fetch when a check ends would otherwise fail that check.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

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
  return JSON.parse(run('comments', action, ...args, '--json', '--socket', SOCKET, '--credential', HERMES));
}

// A page of hermes's, rendered under a name of the check's own, with a
// thread the reader opened on its Pond section and hermes's follow-up to
// it: the page's name and the two comments' ids.
async function rendered(request: APIRequestContext, name: string) {
  run('render', '--name', name, '--title', 'Check reactions', '--comments', '--body', BODY,
    '--out-dir', OUT, '--owner', OWNER, '--credential', HERMES);
  const opened = await request.post(COMMENTS, {
    headers: SIGNED_IN, data: { page: name, section: SECTION, text: 'Should the pump run all winter?' },
  });
  expect(opened.status()).toBe(201);
  const thread = ((await opened.json()) as { id: number }).id;
  const reply = hermes('follow-up', String(thread), '--key', `${name}-${thread}`,
    '--text', 'Yes: a pump that stops lets the ice close over the outlet.') as { id: number };
  expect(reply.id).toBeGreaterThan(thread);
  return { name, thread, reply: reply.id };
}

async function react(request: APIRequestContext, headers: Record<string, string>, name: string,
  comment: number, emoji: string) {
  const response = await request.post(COMMENTS, { headers, data: { page: name, comment, emoji, reacted: true } });
  expect(response.status()).toBe(200);
}

// Page errors, and console errors other than a refused request's.
function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(message.text());
  });
  return errors;
}

function reactionPost(request: Request) {
  return new URL(request.url()).pathname === COMMENTS && request.method() === 'POST' &&
    'emoji' in (request.postDataJSON() ?? {});
}

// The bodies of the page's reaction posts.
function reactionPosts(page: Page) {
  const bodies: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (reactionPost(r)) bodies.push(r.postDataJSON()); });
  return bodies;
}

function reactionAnswered(page: Page) {
  return page.waitForResponse((r) => reactionPost(r.request()));
}

// Load the page on its own and let its first read of the threads end.
async function open(page: Page, name: string, again = false) {
  await (again ? page.reload() : page.goto(`/${name}.html?standalone`));
  await expect(page.locator(':root')).toHaveAttribute('data-lotuspod-comments-read', '');
}

// The section's chip opens its thread in the panel, or in the bottom sheet
// on a phone.
async function openThread(page: Page, within: string) {
  await page.locator(`details.artifact-comment[data-section="${SECTION}"] summary`).click();
  await expect(page.locator(within)).toBeVisible();
}

function row(page: Page, within: string, id: number) {
  return page.locator(`${within} .artifact-comment-item:has(#artifact-comment-text-${id})`);
}

function chip(at: Locator, emoji: string) {
  return at.locator('button.artifact-reaction', { hasText: emoji });
}

const PANEL = 'aside.artifact-comments-panel';
const SHEET = '.artifact-comments-bottom-sheet';

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });
  test.describe.configure({ timeout: 120_000 });

  test('Add reaction posts 👍, chips follow other reactions live, and a chip toggles the reader\'s own', async ({ page, request }) => {
    const errors = watch(page);
    const { name, reply, thread } = await rendered(request, `check-reactions-panel-${test.info().repeatEachIndex}`);
    const posts = reactionPosts(page);
    await open(page, name);
    await openThread(page, PANEL);
    const hermesRow = row(page, PANEL, reply);
    await expect(hermesRow).toBeVisible();
    await expect(hermesRow.locator('button.artifact-reaction')).toHaveCount(0);

    await hermesRow.hover();
    const add = hermesRow.getByRole('button', { name: 'Add reaction' });
    await expect(add).toBeVisible();
    await expect(add).toHaveAttribute('aria-expanded', 'false');
    await add.click();
    await expect(add).toHaveAttribute('aria-expanded', 'true');
    const menu = hermesRow.locator('div.artifact-reaction-menu');
    await expect(menu.getByRole('button')).toHaveCount(QUICK.length);
    for (const [index, emoji] of QUICK.entries()) {
      await expect(menu.getByRole('button').nth(index)).toHaveAccessibleName(emoji);
    }

    const answered = reactionAnswered(page);
    await menu.getByRole('button', { name: '👍', exact: true }).click();
    expect((await answered).status()).toBe(200);
    expect(posts).toEqual([{ page: name, comment: reply, emoji: '👍', reacted: true }]);
    await expect(menu).toHaveCount(0);
    await expect(add).toBeFocused();
    const thumbs = chip(hermesRow, '👍');
    await expect(thumbs).toHaveText('👍 1');
    await expect(thumbs).toHaveAttribute('aria-pressed', 'true');
    await expect(thumbs).toHaveAttribute('title', 'maintainer');
    await expect(thumbs).toHaveAttribute('aria-label', '👍 1: maintainer');

    // A reload still shows it; the follow-up is seen by now.
    await open(page, name, true);
    if (!(await row(page, PANEL, reply).isVisible())) await openThread(page, PANEL);
    await expect(thumbs).toHaveText('👍 1');
    await expect(thumbs).toHaveAttribute('aria-pressed', 'true');
    const box = page.locator(`${PANEL} .artifact-comment-thread[data-thread="${thread}"]`);
    await expect(box.locator('.artifact-comment-divider')).toHaveCount(0);
    await expect(box.locator('.artifact-comment--unread')).toHaveCount(0);

    // heron and hermes react: the chips follow with no reload.
    await react(request, SECOND, name, reply, '👍');
    hermes('react', String(reply), '👀');
    const eyes = chip(hermesRow, '👀');
    await expect(thumbs).toHaveText('👍 2');
    await expect(thumbs).toHaveAttribute('title', 'maintainer, heron');
    await expect(eyes).toHaveText('👀 1');
    await expect(eyes).toHaveAttribute('title', 'hermes');
    await expect(eyes).toHaveAttribute('aria-pressed', 'false');
    await expect(hermesRow.locator('button.artifact-reaction')).toHaveText(['👍 2', '👀 1']);
    // A reaction marks nothing new.
    await react(request, SECOND, name, thread, '🎉');
    await expect(chip(row(page, PANEL, thread), '🎉')).toHaveText('🎉 1');
    await expect(box.locator('.artifact-comment-divider')).toHaveCount(0);
    await expect(box.locator('.artifact-comment--unread')).toHaveCount(0);

    posts.length = 0;
    let saved = reactionAnswered(page);
    await thumbs.click();
    expect((await saved).status()).toBe(200);
    expect(posts).toEqual([{ page: name, comment: reply, emoji: '👍', reacted: false }]);
    await expect(thumbs).toHaveText('👍 1');
    await expect(thumbs).toHaveAttribute('aria-pressed', 'false');
    await expect(thumbs).toHaveAttribute('title', 'heron');
    await expect(thumbs).toBeFocused();

    saved = reactionAnswered(page);
    await eyes.click();
    expect((await saved).status()).toBe(200);
    await expect(eyes).toHaveText('👀 2');
    await expect(eyes).toHaveAttribute('aria-pressed', 'true');
    await expect(eyes).toHaveAttribute('title', 'hermes, maintainer');

    await open(page, name, true);
    if (!(await row(page, PANEL, reply).isVisible())) await openThread(page, PANEL);
    await expect(hermesRow.locator('button.artifact-reaction')).toHaveText(['👍 1', '👀 2']);
    await expect(box.locator('.artifact-comment-divider')).toHaveCount(0);
    await expect(box.locator('.artifact-comment--unread')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('Add reaction shows on hover alone, and Escape or a click outside closes its menu, focus back on Add reaction', async ({ page, request }) => {
    const errors = watch(page);
    const { name, reply, thread } = await rendered(request, `check-reactions-escape-${test.info().repeatEachIndex}`);
    const posts = reactionPosts(page);
    await open(page, name);
    await openThread(page, PANEL);
    const first = row(page, PANEL, thread);
    await expect(first).toBeVisible();
    await expect(first.locator('button.artifact-reaction')).toHaveCount(0);
    await page.mouse.move(5, 5);
    const firstAdd = first.getByRole('button', { name: 'Add reaction' });
    await expect(firstAdd).toBeHidden();
    const before = (await first.boundingBox())!.height;
    await first.locator('.artifact-comment-text').hover();
    await expect(firstAdd).toBeVisible();
    // Showing it moves nothing under it.
    expect((await first.boundingBox())!.height).toBe(before);

    const hermesRow = row(page, PANEL, reply);
    await hermesRow.hover();
    const add = hermesRow.getByRole('button', { name: 'Add reaction' });
    await add.click();
    const menu = hermesRow.locator('div.artifact-reaction-menu');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(add).toBeFocused();
    await expect(add).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, PANEL, reply)).toBeVisible();

    // A click outside the menu closes it and puts focus back on Add
    // reaction: on the page, in a field, on a chip.
    await add.click();
    await expect(menu).toBeVisible();
    await page.locator('.artifact-body p').first().click();
    await expect(menu).toHaveCount(0);
    await expect(add).toBeFocused();

    await page.locator(PANEL).getByRole('button', { name: 'Reply', exact: true }).click();
    const field = page.locator(`${PANEL} form.artifact-comment-reply textarea[name="text"]`);
    await expect(field).toBeFocused();
    await hermesRow.hover();
    await add.click();
    await expect(menu).toBeVisible();
    await field.click();
    await expect(menu).toHaveCount(0);
    await expect(add).toBeFocused();
    await page.waitForTimeout(300);
    expect(posts).toEqual([]);

    await react(request, SECOND, name, reply, '👍');
    const thumbs = chip(hermesRow, '👍');
    await expect(thumbs).toHaveText('👍 1');
    await hermesRow.hover();
    await add.click();
    await expect(menu).toBeVisible();
    const saved = reactionAnswered(page);
    await thumbs.click();
    expect((await saved).status()).toBe(200);
    await expect(menu).toHaveCount(0);
    await expect(add).toBeFocused();
    expect(posts).toEqual([{ page: name, comment: reply, emoji: '👍', reacted: true }]);
    await expect(thumbs).toHaveText('👍 2');
    expect(errors).toEqual([]);
  });

  test('a row\'s reactions are posted one after another, so an older answer never replaces a newer one', async ({ page, request }) => {
    const errors = watch(page);
    const { name, reply } = await rendered(request, `check-reactions-order-${test.info().repeatEachIndex}`);
    await react(request, SECOND, name, reply, '👍');
    await react(request, SECOND, name, reply, '👀');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    await page.route((url) => url.pathname === COMMENTS, async (route) => {
      if (reactionPost(route.request()) && first) {
        first = false;
        const answer = await route.fetch();
        await held;
        return route.fulfill({ response: answer });
      }
      return route.continue();
    });
    const posts = reactionPosts(page);
    await open(page, name);
    await openThread(page, PANEL);
    const hermesRow = row(page, PANEL, reply);
    const thumbs = chip(hermesRow, '👍'), eyes = chip(hermesRow, '👀');
    await expect(hermesRow.locator('button.artifact-reaction')).toHaveText(['👍 1', '👀 1']);
    await thumbs.click();
    await eyes.click();
    await page.waitForTimeout(300);
    expect(posts).toHaveLength(1);
    const second = page.waitForResponse((r) => reactionPost(r.request()) && r.request().postDataJSON().emoji === '👀');
    release();
    expect((await second).status()).toBe(200);
    expect(posts.map((body) => body.emoji)).toEqual(['👍', '👀']);
    await expect(hermesRow.locator('button.artifact-reaction')).toHaveText(['👍 2', '👀 2']);
    await expect(eyes).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(500);
    await expect(eyes).toHaveText('👀 2');
    await expect(eyes).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('at the panel\'s narrowest the quick emoji stay inside it', async ({ page, request }) => {
    const errors = watch(page);
    const { name, reply, thread } = await rendered(request, `check-reactions-narrow-${test.info().repeatEachIndex}`);
    await page.addInitScript(() => localStorage.setItem('lotuspod:comments-width', '16'));
    await open(page, name);
    await openThread(page, PANEL);
    const aside = page.locator(PANEL);
    await expect.poll(async () => Math.round((await aside.boundingBox())!.width)).toBeLessThanOrEqual(257);
    for (const id of [reply, thread]) {
      const at = row(page, PANEL, id);
      await at.hover();
      await at.getByRole('button', { name: 'Add reaction' }).click();
      const quick = at.locator('div.artifact-reaction-menu').getByRole('button');
      await expect(quick).toHaveCount(6);
      const edge = (await aside.boundingBox())!;
      for (let index = 0; index < 6; index += 1) {
        const shown = (await quick.nth(index).boundingBox())!;
        expect(shown.x).toBeGreaterThanOrEqual(edge.x);
        expect(shown.x + shown.width).toBeLessThanOrEqual(edge.x + edge.width);
      }
      const wide = await aside.evaluate((node) => [node, ...node.querySelectorAll('*')]
        .filter((each) => ['auto', 'scroll'].includes(getComputedStyle(each).overflowX) && each.scrollWidth > each.clientWidth + 1)
        .map((each) => each.className));
      expect(wide).toEqual([]);
      await page.keyboard.press('Escape');
    }
    expect(errors).toEqual([]);
  });

  test('a refused reaction leaves the chips as they were', async ({ page, request }) => {
    const errors = watch(page);
    const { name, reply } = await rendered(request, `check-reactions-refused-${test.info().repeatEachIndex}`);
    await react(request, SECOND, name, reply, '👍');
    await page.route((url) => url.pathname === COMMENTS, (route) => {
      if (reactionPost(route.request())) {
        return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error": "storage_unavailable"}' });
      }
      return route.continue();
    });
    await open(page, name);
    await openThread(page, PANEL);
    const hermesRow = row(page, PANEL, reply);
    await expect(hermesRow.locator('button.artifact-reaction')).toHaveText(['👍 1']);
    await hermesRow.hover();
    const add = hermesRow.getByRole('button', { name: 'Add reaction' });
    await add.click();
    const answered = reactionAnswered(page);
    await hermesRow.locator('div.artifact-reaction-menu').getByRole('button', { name: '✅' }).click();
    expect((await answered).status()).toBe(503);
    await expect(add).toBeEnabled();
    await expect(hermesRow.locator('button.artifact-reaction')).toHaveText(['👍 1']);
    await expect(chip(hermesRow, '👍')).toHaveAttribute('aria-pressed', 'false');
    expect(errors).toEqual([]);
  });

  test('an archived page draws its chips disabled and no Add reaction', async ({ page, request }) => {
    const errors = watch(page);
    const { name, reply } = await rendered(request, `check-reactions-archived-${test.info().repeatEachIndex}`);
    await react(request, SECOND, name, reply, '👍');
    expect(run('archive', name, '--local', '--out-dir', OUT)).toContain(`archived ${name}`);
    try {
      const posts = reactionPosts(page);
      await open(page, name);
      await expect(page.locator('meta[name="lotuspod:archived"]')).toHaveCount(1);
      await openThread(page, PANEL);
      const hermesRow = row(page, PANEL, reply);
      await hermesRow.hover();
      const thumbs = chip(hermesRow, '👍');
      await expect(thumbs).toHaveText('👍 1');
      await expect(thumbs).toBeDisabled();
      await expect(page.locator(`${PANEL} .artifact-reaction-add`)).toHaveCount(0);
      await thumbs.click({ force: true });
      await page.waitForTimeout(300);
      expect(posts).toEqual([]);
      await expect(thumbs).toHaveText('👍 1');
    } finally {
      run('unarchive', name, '--local', '--out-dir', OUT);
    }
    expect(errors).toEqual([]);
  });

  test.describe('on a touch phone', () => {
    test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

    test('the bottom sheet shows the chips and Add reaction without a hover', async ({ page, request }) => {
      const errors = watch(page);
      const { name, reply } = await rendered(request, `check-reactions-phone-${test.info().repeatEachIndex}`);
      await react(request, SECOND, name, reply, '👍');
      await open(page, name);
      await openThread(page, SHEET);
      const hermesRow = row(page, SHEET, reply);
      await hermesRow.scrollIntoViewIfNeeded();
      await expect(chip(hermesRow, '👍')).toBeVisible();
      await expect(chip(hermesRow, '👍')).toHaveText('👍 1');
      const add = hermesRow.getByRole('button', { name: 'Add reaction' });
      await expect(add).toBeVisible();
      await add.tap();
      const menu = hermesRow.locator('div.artifact-reaction-menu');
      await expect(menu.getByRole('button')).toHaveCount(QUICK.length);
      const answered = reactionAnswered(page);
      await menu.getByRole('button', { name: '🎉' }).tap();
      expect((await answered).status()).toBe(200);
      const party = chip(hermesRow, '🎉');
      await expect(party).toHaveText('🎉 1');
      await expect(party).toHaveAttribute('aria-pressed', 'true');
      await expect(hermesRow.locator('button.artifact-reaction')).toHaveText(['👍 1', '🎉 1']);
      expect(errors).toEqual([]);
    });
  });
});
