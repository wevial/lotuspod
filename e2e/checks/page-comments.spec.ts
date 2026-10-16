import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// A thread on the whole page. The check publishes pages of its own as hermes
// on the capture fixture's site with a real `lotuspod publish`: one with two
// h2 sections, which gets a box for the whole page under its title, and one
// with a single section, whose one box already covers the whole page. hermes
// claims and replies through real `lotuspod comments` commands on the
// fixture's agent socket. The run shares one database, so each repeat
// publishes pages of its own names.
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
const WIDE = { width: 1440, height: 900 };
const MEDIUM = { width: 1024, height: 768 };
// It names hermes, so it waits for hermes, not the responder.
const QUESTION = '@hermes Is this plan still current?';
const REPLY = 'Yes, as of today.';
const TWO = ['# Pond plan', '', 'What we will do this winter.', '',
  '## Goals', '', 'Keep the fish alive until spring.', '',
  '## Risks', '', 'The pond may freeze, and the pump stops with it.', ''].join('\n');
const ONE = ['# Pond note', '', 'A short note.', '',
  '## Only', '', 'Nothing else to say.', ''].join('\n');

test.use({ viewport: WIDE });

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
  return JSON.parse(run('comments', action, ...args, '--json',
    '--socket', SOCKET, '--credential', HERMES));
}

function publish(name: string, markdown: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-page-comments-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, '--comments');
    expect(said).toContain(`published ${name} at revision`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

// Load a page on its own, not in the index's tabs, and wait for its first
// read of threads: every chip drawn.
async function load(page: Page, url: string) {
  await page.goto(`${url}?standalone`);
  const boxes = page.locator('details.artifact-comment');
  await expect(boxes.first()).toBeAttached();
  await expect(page.locator('details.artifact-comment > summary.artifact-comment-chip'))
    .toHaveCount(await boxes.count());
}

function box(page: Page, section: string) {
  const details = page.locator(`details.artifact-comment[data-section="${section}"]`);
  return { details, chip: details.locator(':scope > summary') };
}

function panel(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  return {
    aside,
    fold: aside.getByRole('button', { name: 'Fold comments' }),
    titles: aside.locator('.artifact-comments-group:not([hidden]) > .artifact-comments-group-title'),
    group: (title: string) => aside.locator('.artifact-comments-group')
      .filter({ has: page.locator('.artifact-comments-group-title', { hasText: title }) }),
    pick: aside.getByRole('button', { name: 'Comment on a section' }),
    options: aside.getByRole('listbox', { name: 'Sections' }).getByRole('option'),
  };
}

async function threads(request: APIRequestContext, name: string) {
  const response = await request.get(`/api/comments?page=${name}`, { headers: SIGNED_IN });
  expect(response.status()).toBe(200);
  return (await response.json()).threads as { root: { id: number; section: string } }[];
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test('the main column stays put while a slow page script draws the chip under the title', async ({ page, request }) => {
    const name = `page-comments-slow-${test.info().repeatEachIndex}`;
    publish(name, TWO);
    const posted = await request.post('/api/comments', {
      headers: SIGNED_IN, data: { page: name, section: '', text: QUESTION } });
    expect(posted.status()).toBe(201);

    await page.addInitScript(() => {
      const sources: Node[] = [];
      (window as any).__commentShiftSources = sources;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          for (const source of (entry as any).sources ?? []) {
            if (source.node) sources.push(source.node);
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route((url) => url.pathname === '/lotuspod-page.js', async (route) => {
      await held;
      await route.continue();
    });
    const main = page.locator('.artifact-main');
    const top = () => main.evaluate((node) => node.getBoundingClientRect().top + scrollY);
    let before: number;
    try {
      // A held deferred script prevents load, but lets the served page paint.
      await page.goto(`/${name}.html?standalone`, { waitUntil: 'commit' });
      await expect(main).toBeVisible();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      before = await top();
      expect.soft(await page.locator('header.artifact-header > p.artifact-meta + details.artifact-comment[data-section=""] > summary')
        .allTextContents(), 'the served header contains the whole-page comment box').toEqual(['Comment']);
    } finally {
      release();
    }
    await expect(box(page, '').chip).toHaveText('1 comment · waiting');
    const boxes = page.locator('details.artifact-comment');
    await expect(page.locator('details.artifact-comment > summary.artifact-comment-chip'))
      .toHaveCount(await boxes.count());
    const after = await top();
    // Still collect the observer evidence when the measured top has moved.
    expect.soft(Math.abs(after - before), `main column top moved from ${before} to ${after}`).toBeLessThanOrEqual(0.5);
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.evaluate(() => {
      const main = document.querySelector('.artifact-main')!;
      const header = document.querySelector('header.artifact-header')!;
      return ((window as any).__commentShiftSources as Node[]).some((node) =>
        main.contains(node) || header.contains(node));
    }), 'no layout shift names the main column or header').toBe(false);
  });

  test("with scripts off the page's box sits under the title and the main column starts where it does with scripts", async ({ page, browser }) => {
    const name = `page-comments-no-script-${test.info().repeatEachIndex}`;
    publish(name, TWO);
    await load(page, `/${name}.html`);
    await page.evaluate(() => document.fonts.ready);
    const scriptedTop = await page.locator('.artifact-main')
      .evaluate((node) => node.getBoundingClientRect().top + scrollY);
    const context = await browser.newContext({ javaScriptEnabled: false, viewport: WIDE,
      extraHTTPHeaders: SIGNED_IN });
    try {
      const plain = await context.newPage();
      await plain.goto(new URL(`/${name}.html?standalone`, page.url()).href);
      await expect(plain.locator('header.artifact-header > p.artifact-meta + details.artifact-comment[data-section=""] > summary'))
        .toHaveText('Comment');
      await plain.evaluate(() => document.fonts.ready);
      const plainTop = await plain.locator('.artifact-main')
        .evaluate((node) => node.getBoundingClientRect().top + scrollY);
      expect(Math.abs(plainTop - scriptedTop)).toBeLessThanOrEqual(0.5);
    } finally {
      await context.close();
    }
  });

  test('a page served without its header box still gets one drawn after the date line', async ({ page }) => {
    const name = `page-comments-legacy-${test.info().repeatEachIndex}`;
    publish(name, TWO);
    await page.route((url) => url.pathname === `/${name}.html`, async (route) => {
      const response = await route.fetch();
      const html = await response.text();
      const body = html.replace(/<details class="artifact-comment"[^>]*data-section="">[\s\S]*?<\/details>/, '');
      expect(body).not.toMatch(/<details class="artifact-comment"[^>]*data-section=""/);
      await route.fulfill({ response, body });
    });
    await load(page, `/${name}.html`);
    await expect(page.locator('header.artifact-header details.artifact-comment[data-section=""]')).toHaveCount(1);
    await expect(page.locator('header.artifact-header > p.artifact-meta + details.artifact-comment[data-section=""] > summary'))
      .toHaveText('No comments · Comment on this page');
  });

  test('a reader comments on the whole page from the chip under its title, and hermes answers', async ({ page, request }) => {
    test.setTimeout(120_000);
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    const name = `page-comments-check-${test.info().repeatEachIndex}`;
    publish(name, TWO);
    // hermes pulls first, so it is listening and the comment, naming it, waits for it.
    hermes('pull', '--owner', OWNER);
    const errors = watch(page);
    await load(page, `/${name}.html`);

    const whole = box(page, '');
    const goals = box(page, 'goals');
    const risks = box(page, 'risks');
    await expect(page.locator('header.artifact-header > details.artifact-comment[data-section=""]'))
      .toHaveCount(1);
    // Right after the date line; the owner's Archive control is in the top bar, not the header.
    const archive = page.locator('.artifact-topbar > span.artifact-archive-bar > button.artifact-archive');
    await expect(archive).toHaveText('Archive');
    await expect(page.locator('header.artifact-header button.artifact-archive')).toHaveCount(0);
    expect(await whole.details.evaluate((node) =>
      node.previousElementSibling?.classList.contains('artifact-meta'))).toBe(true);
    await expect(whole.chip).toHaveText('No comments · Comment on this page');
    await expect(goals.chip).toHaveText('No comments · Comment');

    const side = panel(page);
    await whole.chip.click();
    await expect(side.fold).toBeVisible();
    await expect(side.titles.first()).toHaveText('This page');
    const group = side.group('This page');
    const field = group.getByLabel('Comment on this page');
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await field.fill(QUESTION);
    await group.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(group.locator('.artifact-comments-entry')).toHaveCount(1);
    await expect(group.locator('.artifact-comment-item--reader .artifact-comment-text'))
      .toHaveText(QUESTION);
    await expect(whole.chip).toHaveText('1 comment · waiting');
    const [thread] = await threads(request, name);
    expect(thread.root.section).toBe('');
    const id = thread.root.id;

    // The reader is away while hermes answers, so the reply waits unread.
    await page.goto('about:blank');
    const claim = hermes('claim', String(id));
    expect(claim.handle).toBe(OWNER);
    // A claim token may start with '-': give it to its option in one word.
    hermes('reply', String(id), `--claim=${claim.claimToken}`, '--key', `page-comments-${id}`,
      '--text', REPLY);
    await load(page, `/${name}.html`);
    await expect(whole.chip).toContainText(`${OWNER} answered`);
    await expect(whole.chip).toContainText('1 new');
    await expect(side.titles).toHaveText(['This page']);
    await whole.chip.click();
    await expect(group.locator('.artifact-comment-item--agent .artifact-comment-text'))
      .toHaveText(REPLY);
    for (const section of [goals, risks]) {
      await expect(section.chip).toHaveText('No comments · Comment');
    }
    for (const title of ['Goals', 'Risks']) {
      await expect(side.group(title).locator('.artifact-comments-entry')).toHaveCount(0);
    }

    await side.pick.click();
    await expect(side.options).toHaveText(['This page', 'Goals', 'Risks']);
    await page.keyboard.press('Escape');

    await page.setViewportSize(MEDIUM);
    await load(page, `/${name}.html`);
    await whole.chip.click();
    const pop = page.locator('.artifact-comments-popover');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.artifact-comments-held-title')).toHaveText('This page');
    await expect(pop.locator(`.artifact-comment-thread[data-thread="${id}"]`)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a page with one section keeps its one box for the whole page', async ({ page }) => {
    const name = `page-comments-one-${test.info().repeatEachIndex}`;
    publish(name, ONE);
    const errors = watch(page);
    await load(page, `/${name}.html`);
    const boxes = page.locator('details.artifact-comment');
    await expect(boxes).toHaveCount(1);
    await expect(boxes).toHaveAttribute('data-section', 'page');
    await expect(page.locator('header.artifact-header details.artifact-comment')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a thread on the whole page stays in the page box once the page keeps one section', async ({ page, request }) => {
    const name = `page-comments-fewer-${test.info().repeatEachIndex}`;
    publish(name, TWO);
    const posted = await request.post('/api/comments', {
      headers: SIGNED_IN, data: { page: name, section: '', text: QUESTION } });
    expect(posted.status()).toBe(201);
    publish(name, ONE);
    const errors = watch(page);
    await load(page, `/${name}.html`);
    const only = box(page, 'page');
    await expect(page.locator('details.artifact-comment')).toHaveCount(1);
    await expect(only.chip).toHaveText('1 comment · waiting');
    await expect(page.locator('.artifact-comments-group-title', { hasText: 'Sections that have changed' }))
      .toBeHidden();
    await only.chip.click();
    const side = panel(page);
    await expect(side.titles).toHaveText(['This page']);
    await expect(side.group('This page').locator('.artifact-comment-item--reader .artifact-comment-text'))
      .toHaveText(QUESTION);
    expect(errors).toEqual([]);
  });

  test('a thread on the one page box shows in the whole page box once the page has sections', async ({ page, request }) => {
    const name = `page-comments-more-${test.info().repeatEachIndex}`;
    publish(name, ONE);
    const posted = await request.post('/api/comments', {
      headers: SIGNED_IN, data: { page: name, section: 'page', text: QUESTION } });
    expect(posted.status()).toBe(201);
    publish(name, TWO);
    const errors = watch(page);
    await load(page, `/${name}.html`);
    const whole = box(page, '');
    await expect(whole.chip).toHaveText('1 comment · waiting');
    await expect(page.locator('.artifact-comments-group-title', { hasText: 'Sections that have changed' }))
      .toBeHidden();
    await whole.chip.click();
    const side = panel(page);
    await expect(side.titles).toHaveText(['This page']);
    await expect(side.group('This page').locator('.artifact-comment-item--reader .artifact-comment-text'))
      .toHaveText(QUESTION);
    const [thread] = await threads(request, name);
    expect(thread.root.section).toBe('page');

    await page.setViewportSize(MEDIUM);
    await load(page, `/${name}.html`);
    await expect(page.locator('section.artifact-comments-changed')).toHaveCount(0);
    await whole.chip.click();
    const pop = page.locator('.artifact-comments-popover');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.artifact-comments-held-title')).toHaveText('This page');
    await expect(pop.locator(`.artifact-comment-thread[data-thread="${thread.root.id}"]`)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
