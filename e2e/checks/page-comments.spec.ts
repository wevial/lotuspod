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
const QUESTION = 'Is this plan still current?';
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

// Load a page and wait for its first read of threads: every chip drawn.
async function load(page: Page, url: string) {
  await page.goto(url);
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

  test('a reader comments on the whole page from the chip under its title, and hermes answers', async ({ page, request }) => {
    test.setTimeout(120_000);
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    const name = `page-comments-check-${test.info().repeatEachIndex}`;
    publish(name, TWO);
    // hermes pulls first, so it is listening and the comment waits for it.
    hermes('pull', '--owner', OWNER);
    const errors = watch(page);
    await load(page, `/${name}.html`);

    const whole = box(page, '');
    const goals = box(page, 'goals');
    const risks = box(page, 'risks');
    await expect(page.locator('header.artifact-header > details.artifact-comment[data-section=""]'))
      .toHaveCount(1);
    // Right after the date line, the owner's Archive control after it.
    const archive = page.locator('header.artifact-header > button.artifact-archive');
    await expect(archive).toHaveText('Archive');
    expect(await whole.details.evaluate((node) =>
      node.previousElementSibling?.classList.contains('artifact-meta'))).toBe(true);
    expect(await archive.evaluate((node) =>
      node.previousElementSibling?.matches('details.artifact-comment[data-section=""]'))).toBe(true);
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
});
