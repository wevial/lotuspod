import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  expect, test, type Frame, type FrameLocator, type Locator, type Page, type Request,
} from '@playwright/test';

// A page lists its earlier versions from the artifacts repository, and opens
// each one read-only. The capture fixture's site is the top of its own git
// repository, so each publish is a version: the first check publishes a page
// of its own twice with a real `lotuspod publish`; the fixture published
// capture-versions-once once and capture-versions-many 25 times. A page the
// reader opened before it was published again says what changed since: the
// changes checks publish pages of their own, open them, publish them again
// with one line changed and open them once more.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const HERMES = ENV.LOTUSPOD_TEST_CREDENTIAL_HERMES ?? '';
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const OWNER = 'hermes';

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// A page's markdown: the edition named in its first paragraph, a section
// that takes comments and one question.
function source(title: string, edition: string) {
  return [
    `# ${title}`, '', `Edition: ${edition}.`, '',
    '## Pond', '', 'The pond freezes in January, and the pump stops with it.', '',
    '## Decisions for the maintainer', '',
    '| # | Question | Options | Default |', '|---|---|---|---|',
    '| 1 | Which heater? | Floating / Submerged | Floating |', '',
  ].join('\n');
}

// A page of two sections, with the pump's line as given.
function changesSource(title: string, pump: string) {
  return [
    `# ${title}`, '', 'The plan for the pond this winter.', '',
    '## Pond', '', 'The pond freezes in January.', '',
    '## Pump', '', 'The pump sits by the steps.', pump, 'The fish sleep under the ice.', '',
  ].join('\n');
}

// hermes publishes markdown, or HTML with suffix .html, as the page name,
// with comments.
function publish(name: string, markdown: string, suffix = '.md') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-versions-'));
  try {
    const file = path.join(dir, `${name}${suffix}`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, '--comments');
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The full versions view, from the header's "Versions · N": on a page with
// a comments panel it opens the History tab, whose "See all versions" opens
// the view.
async function openView(page: Page, link: Locator) {
  await link.click();
  await page.locator('#artifact-comments-history .artifact-history-all').click();
}

function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

// A click on part of a versions row that is not its link. The link's
// stretched box covers the row, so the click lands on the link, as a
// reader's would; force skips the check that would refuse a covered element.
function onRow(part: Locator, modifiers: ('ControlOrMeta')[] = []) {
  return part.click({ force: true, modifiers });
}

function view(page: Page | FrameLocator) {
  const node = page.locator('section.artifact-versions');
  return {
    node,
    heading: node.getByRole('heading', { name: 'Versions' }),
    entries: node.locator('li.artifact-versions-entry'),
    more: node.getByRole('button', { name: 'Show older versions' }),
  };
}

// The current page, loaded on its own at the top level by a link to it,
// opens in the index's tabs (features/publish/ts/open-in-tabs.js): the index,
// that page its active tab, and the page in its frame.
async function inTab(page: Page, name: string) {
  await expect(page).toHaveURL(new RegExp(`/#tabs=${name}&on=${name}$`));
  return page.frameLocator('iframe.pod-frame--active');
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('a page published twice lists two versions and opens the older one read-only', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'versions-check';
    publish(name, source('Versions check', 'first'));
    publish(name, source('Versions check', 'second'));

    await page.goto(`/${name}.html?standalone`);
    const link = page.locator('.artifact-header .artifact-meta a.artifact-versions-link');
    await expect(link).toHaveText('Versions · 2');
    await openView(page, link);
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html\\?standalone#versions$`));
    const versions = view(page);
    await expect(versions.heading).toBeVisible();
    await expect(versions.node).toContainText('2, newest first');
    await expect(page.locator('.artifact-body')).toBeHidden();
    await expect(versions.entries).toHaveCount(2);
    const times = await versions.entries.locator('time').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('datetime') ?? ''));
    expect(times[0] >= times[1]).toBe(true);
    await expect(versions.entries.nth(0).locator('.artifact-versions-current')).toHaveText('current');
    await expect(versions.entries.nth(0).getByRole('link', { name: 'View the current version' }))
      .toHaveAttribute('href', `${name}.html`);
    await expect(versions.entries.nth(1).locator('.artifact-versions-current')).toHaveCount(0);
    await expect(versions.more).toBeHidden();

    // A click anywhere on a row follows its link, as the link itself would.
    const answered = await page.request.get(`/api/versions?page=${name}`);
    expect(answered.status()).toBe(200);
    const older = (await answered.json()).versions[1];
    expect(older.current).toBe(false);
    const oldUrl = new RegExp(`/${name}\\.html\\?version=${older.commit}$`);
    const banner = page.locator('main.artifact--old-version > div.artifact-version-banner');
    await onRow(versions.entries.nth(1).locator('.artifact-versions-note'));
    await expect(page).toHaveURL(oldUrl);
    await expect(banner).toBeVisible();
    await page.goBack();
    await expect(versions.heading).toBeVisible();

    await onRow(versions.entries.nth(0).locator('.artifact-versions-date'));
    await expect((await inTab(page, name)).locator('.artifact-body')).toContainText('Edition: second.');
    await page.goBack();
    await expect(versions.heading).toBeVisible();

    // A modified click opens the row's version in a new tab, and the first
    // tab stays. Playwright at times never reports, or never sees load, a tab
    // opened in the background on a page whose policy forbids every script,
    // as an old version's does, so the new tab is witnessed by its
    // navigation: one to the version that is not the first tab's.
    const moved: string[] = [];
    const onMove = (frame: Frame) => {
      if (frame === page.mainFrame()) moved.push(frame.url());
    };
    page.on('framenavigated', onMove);
    const [opened] = await Promise.all([
      page.context().waitForEvent('request', {
        predicate: (request) => request.isNavigationRequest() && oldUrl.test(request.url()),
      }),
      onRow(versions.entries.nth(1).locator('.artifact-versions-note'), ['ControlOrMeta']),
    ]);
    expect(opened.method()).toBe('GET');
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html\\?standalone#versions$`));
    await expect(versions.heading).toBeVisible();
    page.off('framenavigated', onMove);
    expect(moved).toEqual([]);
    for (const other of page.context().pages()) {
      if (other !== page) await other.close();
    }

    // Each row's one link is its only tab stop.
    await versions.heading.focus();
    const focused = () => page.evaluate(() => {
      const node = document.activeElement;
      const row = node?.closest('li.artifact-versions-entry');
      const rows = Array.from(document.querySelectorAll('li.artifact-versions-entry'));
      return row ? `${rows.indexOf(row)}:${node!.tagName}` : 'outside';
    });
    await page.keyboard.press('Tab');
    expect(await focused()).toBe('0:A');
    await page.keyboard.press('Tab');
    expect(await focused()).toBe('1:A');
    await page.keyboard.press('Tab');
    expect(await focused()).toBe('outside');
    await page.keyboard.press('Shift+Tab');
    expect(await focused()).toBe('1:A');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(oldUrl);
    await expect(banner).toBeVisible();
    await page.goBack();
    await expect(versions.heading).toBeVisible();

    await versions.entries.nth(1).getByRole('link', { name: /^View/ }).click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html\\?version=[0-9a-f]{40}$`));
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('1 version behind');
    await expect(page.locator('.artifact-body')).toContainText('Edition: first.');
    await expect(page.locator('.artifact-body')).not.toContainText('Edition: second.');
    const fieldsets = page.locator('form.artifact-decision fieldset');
    await expect(fieldsets).toHaveCount(1);
    await expect(fieldsets).toHaveAttribute('disabled', '');
    await expect(page.getByRole('radio', { name: 'Floating' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save answer' })).toBeDisabled();
    await expect(page.locator('.artifact-version-note')).toContainText('Answering is off on old versions.');
    await expect(page.locator('details.artifact-comment').first()).toBeAttached();
    await expect(page.locator('details.artifact-comment:visible')).toHaveCount(0);
    await expect(page.locator('.artifact-versions-link')).toHaveCount(0);

    await banner.getByRole('link', { name: 'Back to current' }).click();
    const current = await inTab(page, name);
    await expect(current.locator('.artifact-body')).toContainText('Edition: second.');
    await expect(current.locator('.artifact-version-banner')).toHaveCount(0);

    await page.goBack();
    await expect(banner).toBeVisible();
    await banner.getByRole('link', { name: 'All versions' }).click();
    const all = await inTab(page, name);
    await expect(view(all).heading).toBeVisible();
    await expect(view(all).entries).toHaveCount(2);

    // Leaving the view shows the page again.
    await view(all).node.getByRole('link', { name: 'Versions check' }).click();
    await expect(all.locator('.artifact-body')).toBeVisible();
    await expect(view(all).node).toBeHidden();

    // The old version's banner carries the header's version menu, drawn by
    // the one script it runs, which asks the versions route once and posts
    // nothing; the page script never runs there.
    const requests: string[] = [];
    const onRequest = (request: Request) => {
      const url = new URL(request.url());
      requests.push(`${request.method()} ${url.pathname}${url.search}`);
    };
    page.on('request', onRequest);
    await page.goto(`/${name}.html?version=${older.commit}`);
    const choose = banner.getByRole('button', { name: 'Choose a version' });
    const menu = page.getByRole('menu');
    const items = menu.getByRole('menuitem');
    await expect(choose).toBeVisible();
    await expect(choose).toHaveText('Choose a version ▾');
    await page.waitForLoadState('networkidle');
    page.off('request', onRequest);
    expect(requests.filter((said) => / \/api(\/|\?|$)/.test(said)))
      .toEqual([`GET /api/versions?page=${name}`]);
    expect(requests.filter((said) => !said.startsWith('GET '))).toEqual([]);
    await expect(page.locator('.artifact-versions-link')).toHaveCount(0);
    await expect(page.locator('aside.artifact-comments-panel')).toHaveCount(0);
    // The button sits before the banner's "All versions" link.
    await expect(banner.locator('.artifact-version-banner-menu + a')).toHaveText('All versions');

    await expect(menu).toBeHidden();
    await choose.click();
    await expect(menu).toBeVisible();
    await expect(choose).toHaveAttribute('aria-expanded', 'true');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0).locator('.artifact-versions-current')).toHaveText('current');
    await expect(items.nth(0)).toHaveAttribute('href', `${name}.html`);
    await expect(items.nth(0)).not.toHaveAttribute('aria-current', /.*/);
    await expect(items.nth(0).locator('.artifact-versions-viewing')).toHaveCount(0);
    await expect(items.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(items.nth(1).locator('.artifact-versions-viewing')).toHaveText('viewing');
    await expect(items.nth(1).locator('.artifact-versions-current')).toHaveCount(0);
    await expect(items.nth(1)).toHaveAttribute('href', `${name}.html?version=${older.commit}`);
    await expect(menu.locator('.artifact-versions-seen')).toHaveCount(0);
    await expect(items.nth(2)).toHaveText('See all versions');
    await expect(items.nth(2)).toHaveAttribute('href', `${name}.html#versions`);

    // The current item opens the page as the index's active tab, as any
    // direct load of a current page does; "See all versions" its versions
    // view.
    await items.nth(0).click();
    await expect(page).toHaveURL(new RegExp(`/#tabs=${name}&on=${name}$`));
    const chosen = page.frameLocator('iframe.pod-frame--active');
    await expect(page.locator('iframe.pod-frame--active'))
      .toHaveAttribute('src', new RegExp(`(^|/)${name}\\.html$`));
    await expect(chosen.locator('.artifact-body')).toContainText('Edition: second.');
    const framed = page.frames().find((frame) => frame !== page.mainFrame()
      && new URL(frame.url()).pathname.endsWith(`/${name}.html`));
    expect(framed, `a frame holds ${name}.html`).toBeTruthy();
    expect(new URL(framed!.url()).search).toBe('');
    await expect(chosen.locator('.artifact-version-banner')).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(oldUrl);
    await choose.click();
    await items.nth(2).click();
    await expect(view(await inTab(page, name)).heading).toBeVisible();

    // A click on the banner's text closes it.
    await page.goto(`/${name}.html?version=${older.commit}`);
    await choose.click();
    await expect(menu).toBeVisible();
    await banner.locator('.artifact-version-banner-text').click({ position: { x: 4, y: 4 } });
    await expect(menu).toBeHidden();
    await expect(choose).toHaveAttribute('aria-expanded', 'false');
    expect(errors).toEqual([]);
  });

  test("an old version's banner menu is its own page's, whatever data-page its body carries", async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'versions-named-check';
    // An HTML page is published as it is written, any attribute kept.
    const embedded = (edition: string) => [
      '<h1>Versions named check</h1>', `<p>Edition: ${edition}.</p>`,
      '<div data-page="capture-versions-many">Embedded.</div>', '',
    ].join('\n');
    publish(name, embedded('first'), '.html');
    publish(name, embedded('second'), '.html');
    const answered = await page.request.get(`/api/versions?page=${name}`);
    expect(answered.status()).toBe(200);
    const older = (await answered.json()).versions[1];

    const asked: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/versions') asked.push(url.search);
    });
    await page.goto(`/${name}.html?version=${older.commit}`);
    await expect(page.locator('[data-page="capture-versions-many"]')).toHaveCount(1);
    const choose = page.getByRole('button', { name: 'Choose a version' });
    await choose.click();
    const items = page.getByRole('menu').getByRole('menuitem');
    await expect(items).toHaveCount(3);
    expect(asked).toEqual([`?page=${name}`]);
    await expect(items.nth(0)).toHaveAttribute('href', `${name}.html`);
    await expect(items.nth(1)).toHaveAttribute('href', `${name}.html?version=${older.commit}`);
    await expect(items.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(items.nth(2)).toHaveAttribute('href', `${name}.html#versions`);
    expect(errors).toEqual([]);
  });

  test("an old version's banner keeps its links when the versions route fails", async ({ page }) => {
    const errors = watchErrors(page);
    const answered = await page.request.get('/api/versions?page=capture-versions-many');
    expect(answered.status()).toBe(200);
    const older = (await answered.json()).versions[1];
    expect(older.current).toBe(false);
    let asked = 0;
    await page.route((url) => url.pathname === '/api/versions', (route) => {
      asked += 1;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' });
    });

    await page.goto(`/capture-versions-many.html?version=${older.commit}`);
    const banner = page.locator('main.artifact--old-version > div.artifact-version-banner');
    await expect(banner).toBeVisible();
    await expect.poll(() => asked).toBe(1);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => new Promise((done) => setTimeout(done, 100)));
    await expect(banner.getByRole('button')).toHaveCount(0);
    await expect(banner.getByRole('link', { name: 'All versions' })).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Back to current' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('each entry notes what it changed, as the activity route says it', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'versions-note-check';
    publish(name, changesSource('Versions note check', 'The pump stops in January.'));
    publish(name, changesSource('Versions note check', 'The pump runs all winter.'));

    const answered = await page.request.get('/api/activity');
    expect(answered.status()).toBe(200);
    const activity = await answered.json();
    const entry = activity.pages.find((found: { page: string }) => found.page === name);
    expect(entry, `the activity lists ${name}`).toBeTruthy();
    const newest = entry.events.find((event: { kind: string }) => event.kind === 'version');
    expect(newest.summary).toBe('Pump changed');

    await page.goto(`/${name}.html?standalone#versions`);
    const versions = view(page);
    await expect(versions.heading).toBeVisible();
    await expect(versions.entries).toHaveCount(2);
    await expect(versions.entries.nth(0).locator('.artifact-versions-note')).toHaveText(newest.summary);
    await expect(versions.entries.nth(1).locator('.artifact-versions-note')).toHaveText('First version');
    // The note sits under the entry's date.
    const [date, note] = await Promise.all(['.artifact-versions-date', '.artifact-versions-note']
      .map((selector) => versions.entries.nth(0).locator(selector).boundingBox()));
    expect(note!.y).toBeGreaterThanOrEqual(date!.y + date!.height - 1);
    expect(errors).toEqual([]);
  });

  test('a page published once is its only version', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/capture-versions-once.html?standalone');
    const link = page.locator('.artifact-versions-link');
    await expect(link).toHaveText('Versions · 1');
    await openView(page, link);
    const versions = view(page);
    await expect(versions.node).toContainText('This is the only version.');
    await expect(versions.entries).toHaveCount(1);
    await expect(versions.entries.first()).toContainText('current');

    // Outside a repository the versions route answers 200 with no versions;
    // the fixture's site is one, so that answer is stood in for.
    await page.route('**/api/versions?*', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ page: 'capture-versions-once', versions: [] }),
    }));
    await page.goto('/capture-versions-once.html?standalone');
    await expect(link).toHaveText('Versions · 0');
    await openView(page, link);
    await expect(versions.heading).toBeVisible();
    await expect(versions.node).toContainText('This page has no versions yet.');
    await expect(versions.entries).toHaveCount(0);
    await expect(versions.more).toBeHidden();
    await expect(page.locator('.artifact-body')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test("the header's menu picks a version without leaving the page", async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'versions-menu-check';
    publish(name, source('Versions menu check', 'first'));
    publish(name, source('Versions menu check', 'second'));
    const answered = await page.request.get(`/api/versions?page=${name}`);
    expect(answered.status()).toBe(200);
    const listed = (await answered.json()).versions;
    expect(listed).toHaveLength(2);
    const oldUrl = new RegExp(`/${name}\\.html\\?version=${listed[1].commit}$`);
    const banner = page.locator('main.artifact--old-version > div.artifact-version-banner');

    await page.goto(`/${name}.html?standalone`);
    const button = page.getByRole('button', { name: 'Choose a version' });
    const menu = page.getByRole('menu');
    const items = menu.getByRole('menuitem');
    await expect(button).toHaveText('▾');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
    // The button follows the link in its slot, before any unread badge.
    expect(await button.evaluate((node) => {
      const line = node.closest('.artifact-header .artifact-meta');
      const link = node.previousElementSibling;
      return Boolean(line && node.parentElement!.matches('.artifact-versions-slot') &&
        link?.matches('a.artifact-versions-link') &&
        Array.from(line.querySelectorAll('.artifact-unread')).every((badge) =>
          node.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING));
    })).toBe(true);
    const hit = await button.boundingBox();
    expect(hit!.width).toBeGreaterThanOrEqual(24);
    expect(hit!.height).toBeGreaterThanOrEqual(24);

    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(menu).toBeVisible();
    await expect(items).toHaveCount(3);
    for (const index of [0, 1]) {
      await expect(items.nth(index).locator('time')).toHaveAttribute('datetime', listed[index].date);
    }
    await expect(items.nth(0)).toContainText(listed[0].summary);
    await expect(items.nth(1).locator('.artifact-versions-menu-note')).toHaveText('First version');
    await expect(items.nth(0).locator('.artifact-versions-current')).toHaveText('current');
    await expect(items.nth(1).locator('.artifact-versions-current')).toHaveCount(0);
    await expect(items.nth(0)).toHaveAttribute('aria-current', 'page');
    await expect(items.nth(0)).toHaveAttribute('href', `${name}.html`);
    await expect(items.nth(2)).toHaveText('See all versions');
    await expect(items.nth(2)).toHaveAttribute('href', /#versions$/);

    // The older item opens the old version; the first, the page itself.
    await items.nth(1).click();
    await expect(page).toHaveURL(oldUrl);
    await expect(banner).toBeVisible();
    await page.goBack();
    await button.click();
    await items.nth(0).click();
    await expect((await inTab(page, name)).locator('.artifact-body')).toContainText('Edition: second.');
    await page.goto(`/${name}.html?standalone`);
    await button.click();
    await items.nth(2).click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html\\?standalone#versions$`));
    await expect(view(page).heading).toBeVisible();
    await expect(menu).toBeHidden();

    // The keyboard, as a menu button takes it.
    await page.goto(`/${name}.html?standalone`);
    await button.focus();
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(items.nth(2)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(menu).toBeHidden();
    await expect(button).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(2)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(button).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(oldUrl);
    await expect(banner).toBeVisible();

    // A click outside closes it, and so does Tab.
    await page.goBack();
    await button.click();
    await expect(menu).toBeVisible();
    await page.locator('.artifact-title').click();
    await expect(menu).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await button.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(menu).toBeHidden();
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(errors).toEqual([]);
  });

  test('the menu of 25 versions scrolls them above "See all versions", and fits a phone', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/capture-versions-many.html?standalone');
    const button = page.getByRole('button', { name: 'Choose a version' });
    const menu = page.getByRole('menu');
    await button.click();
    await expect(menu).toBeVisible();
    const list = menu.locator('.artifact-versions-menu-list');
    await expect(list.getByRole('menuitem')).toHaveCount(25);
    expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    const all = menu.getByRole('menuitem', { name: 'See all versions' });
    await expect(all).toBeInViewport({ ratio: 1 });
    const [listBox, allBox] = await Promise.all([list.boundingBox(), all.boundingBox()]);
    expect(allBox!.y).toBeGreaterThanOrEqual(listBox!.y + listBox!.height - 1);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await button.click();
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  });

  test('a page with 25 versions lists 20, then the other 5', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/capture-versions-many.html?standalone#versions');
    const versions = view(page);
    await expect(versions.heading).toBeVisible();
    await expect(versions.node).toContainText('25, newest first');
    await expect(versions.entries).toHaveCount(20);
    await expect(versions.more).toBeVisible();
    await versions.more.click();
    await expect(versions.entries).toHaveCount(25);
    await expect(versions.more).toBeHidden();
    await expect(versions.entries.locator('.artifact-versions-current')).toHaveCount(1);
    await expect(versions.entries.locator('a.artifact-versions-view')).toHaveCount(25);
    expect(errors).toEqual([]);
  });
});

test.describe('signed in, what changed', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN, viewport: { width: 1280, height: 800 } });

  const HISTORY = '#artifact-comments-history';

  // Opens the page and waits until its versions link and its History tab are
  // drawn: by then the page has heard the versions route and what changed.
  async function open(page: Page, name: string) {
    const seen = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/seen' && response.request().method() === 'POST');
    await page.goto(`/${name}.html?standalone`);
    expect((await seen).status()).toBe(200);
    await expect(page.locator('.artifact-versions-link')).toBeVisible();
    await expect(page.locator('#artifact-comments-tab-history')).toBeAttached();
  }

  // The page draws no box under the header and no tag on a heading: the
  // header runs straight into the body.
  async function noBox(page: Page) {
    await expect(page.locator('section.artifact-changes')).toHaveCount(0);
    await expect(page.locator('.artifact-changed-tag')).toHaveCount(0);
    expect(await page.locator('header.artifact-header').evaluate((header) => {
      const next = header.nextElementSibling;
      return Boolean(next && (next.matches('section.artifact-body') ||
        next.querySelector(':scope > section.artifact-body')));
    })).toBe(true);
  }

  // Publishes the page, opens it with nothing to say yet, publishes it again
  // with the pump's line changed and opens it once more.
  async function republish(page: Page, name: string, title: string) {
    publish(name, changesSource(title, 'The pump stops in January.'));
    await open(page, name);
    await expect(page.locator('.artifact-history-pill')).toHaveCount(0);

    // serve dates a page to the second: a publish in the second the page was
    // served would leave the browser's cached copy current.
    await page.waitForTimeout(1100);
    publish(name, changesSource(title, 'The pump runs all winter.'));
    await open(page, name);
  }

  // What a heading's ::before draws: its content, width and background, and
  // the theme's sky as a probe resolves it, so the check holds in either
  // theme.
  function rule(heading: Locator) {
    return heading.evaluate((node) => {
      const probe = document.body.appendChild(document.createElement('div'));
      probe.style.background = 'var(--color-sky)';
      const sky = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const drawn = getComputedStyle(node, '::before');
      return { content: drawn.content, width: drawn.width, background: drawn.backgroundColor, sky };
    });
  }

  async function ruled(heading: Locator) {
    const found = await rule(heading);
    expect(found.content).not.toBe('none');
    expect(found.width).toBe('3px');
    expect(found.background).toBe(found.sky);
  }

  async function unruled(heading: Locator) {
    expect((await rule(heading)).content).toBe('none');
  }

  test('a page republished since the reader opened it says what changed in History', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'changes-check';
    await republish(page, name, 'Changes check');
    await noBox(page);
    const pill = page.locator('.artifact-topbar button.artifact-history-pill');
    await expect(pill).toHaveText('1 changed');

    // The header's menu marks the version the reader last looked at.
    const button = page.getByRole('button', { name: 'Choose a version' });
    await button.click();
    const items = page.getByRole('menu').getByRole('menuitem');
    await expect(items).toHaveCount(3);
    await expect(items.nth(1).locator('.artifact-versions-seen')).toHaveText('you last looked');
    await expect(items.nth(0)).not.toContainText('you last looked');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();

    // On a narrow window with large text the pill wraps under the date,
    // inside the menu.
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 320, height: 844 });
    await page.evaluate(() => { document.documentElement.style.fontSize = '32px'; });
    await button.click();
    const [seenPill, list] = await Promise.all([items.nth(1).locator('.artifact-versions-seen'),
      page.locator('.artifact-versions-menu-list')].map((node) => node.boundingBox()));
    expect(seenPill!.x + seenPill!.width).toBeLessThanOrEqual(list!.x + list!.width);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.setViewportSize(size);

    await pill.click();
    const history = page.locator(HISTORY);
    await expect(history).toBeVisible();
    await expect(history).toContainText('You last opened this on');
    await expect(history).toContainText('1 version ago');
    await expect(history.getByRole('link', { name: 'Pump' })).toHaveAttribute('href', '#pump');
    await expect(history.getByRole('link', { name: 'Pond' })).toHaveCount(0);

    await history.getByRole('link', { name: 'See all versions' }).click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html\\?standalone#versions$`));
    const versions = view(page);
    await expect(versions.heading).toBeVisible();
    const pane = versions.node.locator('aside.artifact-versions-diff');
    await expect(pane).toBeVisible();
    await expect(pane.getByRole('heading')).toContainText('→ current');
    await expect(pane.locator('del.artifact-diff-line--removed')).toHaveText(/The pump stops in January\./);
    await expect(pane.locator('ins.artifact-diff-line--added')).toHaveText(/The pump runs all winter\./);
    await expect(pane.locator('.artifact-diff-line--removed, .artifact-diff-line--added')).toHaveCount(2);
    await expect(versions.entries).toHaveCount(2);
    await expect(versions.entries.nth(1).locator('.artifact-versions-seen')).toHaveText('you last looked');
    await expect(versions.entries.nth(0).locator('.artifact-versions-seen')).toHaveCount(0);

    // The next load was seen at the page's own revision: nothing to say.
    await open(page, name);
    await noBox(page);
    await expect(page.locator('.artifact-history-pill')).toHaveCount(0);
    await expect(page.locator('.artifact-history-changed')).toHaveCount(0);
    await openView(page, page.locator('.artifact-versions-link'));
    await expect(view(page).heading).toBeVisible();
    await expect(page.locator('aside.artifact-versions-diff')).toHaveCount(0);
    await expect(page.locator('.artifact-versions-seen')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a changed section's heading carries a rule only while History is open", async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'changes-rules';
    await republish(page, name, 'Changes rules');
    const pump = page.locator('.artifact-body h2#pump');
    const pond = page.locator('.artifact-body h2#pond');
    await expect(page.locator('.artifact-comments-panel')).not.toHaveClass(/artifact-comments-panel--open/);
    await unruled(pump);

    await page.locator('.artifact-topbar button.artifact-history-pill').click();
    await expect(page.locator(HISTORY)).toBeVisible();
    await expect(pump).toHaveClass(/\bartifact-history-changed\b/);
    await ruled(pump);
    await unruled(pond);

    await page.locator('#artifact-comments-tab-comments').click();
    await expect(page.locator(HISTORY)).toBeHidden();
    await unruled(pump);

    await page.locator('#artifact-comments-tab-history').click();
    await ruled(pump);
    await page.locator(HISTORY).getByRole('button', { name: 'Mark as seen' }).click();
    await expect(pump).not.toHaveClass(/\bartifact-history-changed\b/);
    await unruled(pump);
    expect(errors).toEqual([]);
  });

  test("on a phone, the heading's rule shows while the bottom sheet holds History", async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const name = 'changes-rules-phone';
    await republish(page, name, 'Changes rules phone');
    const pump = page.locator('.artifact-body h2#pump');
    await unruled(pump);

    await page.locator('.artifact-topbar button.artifact-history-pill').click();
    const sheet = page.locator('.artifact-comments-bottom-sheet');
    await expect(sheet.locator('#artifact-comments-bottom-sheet-history .artifact-history')).toBeVisible();
    await ruled(pump);

    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(sheet).toBeHidden();
    await unruled(pump);
    expect(errors).toEqual([]);
  });

  test('a page names itself by its address, whatever data-page its body carries', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'changes-named-check';
    // An HTML page is published as it is written, any attribute kept. With
    // no h2 it has one comment box, after the body's text, so the authored
    // data-page is the document's first.
    const embedded = (pump: string) => [
      '<div data-page="capture-versions-many">Embedded.</div>',
      '<h1>Changes named check</h1>', '<p>The plan for the pond this winter.</p>',
      `<p>The pump sits by the steps. ${pump}</p>`, '',
    ].join('\n');
    const asked: { path: string, page: string | null }[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/seen' && request.method() === 'POST') {
        asked.push({ path: url.pathname, page: request.postDataJSON().page });
      } else if (url.pathname === '/api/versions' || url.pathname === '/api/changes') {
        asked.push({ path: url.pathname, page: url.searchParams.get('page') });
      }
    });

    publish(name, embedded('The pump stops in January.'), '.html');
    await open(page, name);
    await expect(page.locator('[data-page="capture-versions-many"]')).toHaveCount(1);
    expect.soft(asked.filter((each) => each.path === '/api/seen')).toEqual([{ path: '/api/seen', page: name }]);
    await expect.soft.poll(() => asked.filter((each) => each.path === '/api/versions'))
      .toContainEqual({ path: '/api/versions', page: name });
    expect.soft(asked.filter((each) => each.page !== name)).toEqual([]);

    await page.waitForTimeout(1100);
    publish(name, embedded('The pump runs all winter.'), '.html');
    await open(page, name);
    await expect.soft(page.locator('.artifact-topbar button.artifact-history-pill')).toHaveText('1 changed');
    expect.soft(asked.filter((each) => each.path === '/api/changes'))
      .toContainEqual({ path: '/api/changes', page: name });
    expect.soft(asked.filter((each) => each.page !== name)).toEqual([]);

    // A draft kept over a reload under the page's own name comes back.
    const section = await page.locator('details.artifact-comment').first().getAttribute('data-section');
    const draft = 'Which pump survives the frost?';
    // Written as the page is left, after the page keeps its own.
    await page.evaluate(([key, section, text]) => {
      window.addEventListener('pagehide', () => sessionStorage.setItem(key, JSON.stringify({ x: 0, y: 0, comments: {
        open: null, passage: null, texts: [{ section, index: 0, text, images: [] }],
      } })));
    }, [`lotuspod:reload:${name}`, section!, draft] as const);
    await page.reload();
    await expect(page.locator('.artifact-versions-link')).toBeVisible();
    const field = page.locator(`details.artifact-comment[data-section="${section}"] form.artifact-comment-form textarea, ` +
      '.artifact-comments-panel form.artifact-comment-form textarea');
    await expect.soft.poll(() => field.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLTextAreaElement).value))).toContain(draft);
    expect.soft(await page.evaluate((key) => sessionStorage.getItem(key), `lotuspod:reload:${name}`)).toBeNull();
    expect(errors).toEqual([]);
  });

  test('a page left with one heading links and rules it from History', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'changes-one-heading';
    publish(name, changesSource('Changes one heading', 'The pump stops in January.'));
    await open(page, name);
    await page.waitForTimeout(1100);
    // The outline gives no id to a page's only h2.
    publish(name, ['# Changes one heading', '', 'The plan for the pond this winter.', '', '## Pump', '', 'The pump runs all winter.', ''].join('\n'));
    await open(page, name);
    await noBox(page);
    await page.locator('.artifact-topbar button.artifact-history-pill').click();
    const history = page.locator(HISTORY);
    await expect(history.getByRole('link', { name: 'Pump' })).toHaveAttribute('href', '#pump');
    await expect(history.locator('.artifact-history-item--removed')).toHaveText(/Pond/);
    await expect(history.locator('.artifact-history-item--added')).toHaveCount(0);
    await expect(page.locator('.artifact-body h2#pump')).toHaveClass(/\bartifact-history-changed\b/);
    await history.getByRole('link', { name: 'Pump' }).click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html\\?standalone#pump$`));
    expect(errors).toEqual([]);
  });

  test('a page with no headings links its text from History', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'changes-no-heading';
    publish(name, ['# Changes no heading', '', 'The pump stops in January.', ''].join('\n'));
    await open(page, name);
    await page.waitForTimeout(1100);
    publish(name, ['# Changes no heading', '', 'The pump runs all winter.', ''].join('\n'));
    await open(page, name);
    await noBox(page);
    await page.locator('.artifact-topbar button.artifact-history-pill').click();
    const link = page.locator(HISTORY).getByRole('link', { name: 'The page text' });
    await expect(link).toHaveAttribute('href', '#page-text');
    await expect(page.locator('section.artifact-body#page-text')).toHaveCount(1);
    // The text before any heading has no heading to carry a rule.
    await expect(page.locator('.artifact-history-changed')).toHaveCount(0);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/${name}\\.html\\?standalone#page-text$`));
    expect(errors).toEqual([]);
  });
});

test('signed out, a page shows no versions', async ({ page }) => {
  const errors = watchErrors(page);
  const answered = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/versions');
  await page.goto('/capture-versions-once.html?standalone');
  expect((await answered).status()).toBe(401);
  await expect(page.locator('.artifact-meta')).toBeVisible();
  await expect(page.locator('.artifact-versions-link')).toHaveCount(0);
  await expect(page.locator('section.artifact-versions')).toHaveCount(0);
  expect(errors).toEqual([]);
});
