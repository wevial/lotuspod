import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// An archived page opens with a banner under its title bar, keeps its
// threads readable and takes no new comment, reply or answer; its owner gets
// an Archive or Unarchive button in the header. The check publishes a page
// with a decision and its successor on the capture fixture's site with a
// real `lotuspod publish`, posts a thread and a reply on it, archives it
// with a real `lotuspod archive --superseded-by`, and unarchives it when
// done, so later checks see no archived page.
const ENV = process.env;
const ASSERTION = ENV.LOTUSPOD_TEST_ASSERTION ?? '';
const SECOND = ENV.LOTUSPOD_TEST_ASSERTION_SECOND ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ASSERTION };
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
// This checkout's package, whatever lotuspod is installed.
const SRC = path.resolve(__dirname, '..', '..', 'src');
const NAME = 'archived-page-check';
const NEXT = 'archived-page-check-next';
const NEXT_TITLE = 'Pond plan, the second';
const CLOSED = 'Comments are closed: this page is archived.';
const CLOSED_NOTE = 'Answering is closed: this page is archived.';
const PARAGRAPH = 'The pond froze in January, and the pump stopped with it.';

test.use({ viewport: { width: 1440, height: 900 } });

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function publish(name: string, lines: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-archived-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, lines.join('\n'), 'utf-8');
    expect(run('publish', file, '--local', '--out-dir', OUT)).toContain(`published ${name}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function archive() {
  expect(run('archive', NAME, '--superseded-by', NEXT, '--local', '--out-dir', OUT))
    .toContain(`archived ${NAME}`);
}

// The day the page was archived, as its record keeps it.
function archivedDay(): string {
  const record = JSON.parse(fs.readFileSync(path.join(OUT, `${NAME}.archived.json`), 'utf-8'));
  return String(record.archivedAt).slice(0, 10);
}

async function post(request: APIRequestContext, data: Record<string, unknown>) {
  const response = await request.post('/api/comments', { headers: SIGNED_IN, data });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: number };
}

// Errors the page throws, and how many of its reads are in flight.
async function watch(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const w = window as any;
    w.__inflight = 0;
    const real = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      w.__inflight++;
      try {
        return await real(input, init);
      } finally {
        w.__inflight--;
      }
    };
  });
  return errors;
}

async function settle(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).__inflight as number)).toBe(0);
}

// Open the page and let its first reads come back: the threads drawn, and
// the archive route and the answers read.
async function open(page: Page) {
  const read = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/archive' && response.request().method() === 'GET');
  await page.goto(`/${NAME}.html`);
  await read;
  await settle(page);
}

function parts(page: Page) {
  const aside = page.locator('aside.artifact-comments-panel');
  return {
    banner: page.locator('div.artifact-archived-banner'),
    button: page.locator('button.artifact-archive'),
    aside,
    opener: aside.locator('button.artifact-comments-opener'),
    fold: aside.getByRole('button', { name: 'Fold comments' }),
    closed: aside.locator('.artifact-comments-closed'),
    pick: aside.locator('button.artifact-comments-pick'),
    pill: page.locator('button.artifact-passage-pill'),
    fieldset: page.locator('form.artifact-decision fieldset'),
    ask: page.locator('form.artifact-decision button.artifact-decision-ask'),
    save: page.locator('form.artifact-decision button[type="submit"]'),
    note: page.locator('form.artifact-decision .artifact-archived-note'),
  };
}

function entry(page: Page, id: number) {
  const item = page.locator(`aside.artifact-comments-panel .artifact-comments-entry[data-thread="${id}"]`);
  return {
    item,
    head: item.locator('.artifact-comments-entry-head'),
    toggle: item.locator('button.artifact-comment-toggle'),
  };
}

// The panel open, at the thread, its replies shown.
async function openThread(page: Page, id: number) {
  const side = parts(page);
  if (await side.opener.isVisible()) await side.opener.click();
  await expect(side.fold).toBeVisible();
  const thread = entry(page, id);
  await expect(thread.item).toBeVisible();
  if (!(await thread.toggle.isVisible())) await thread.head.click();
  await expect(thread.toggle).toBeVisible();
  return thread;
}

// Select the paragraph's words with the mouse.
async function drag(page: Page, words: string) {
  const spots = await page.evaluate((wanted) => {
    const walker = document.createTreeWalker(document.querySelector('.artifact-body')!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      const at = node.data.indexOf(wanted);
      if (at < 0) continue;
      node.parentElement!.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const first = range.getBoundingClientRect();
      range.setStart(node, at + wanted.length - 1);
      range.setEnd(node, at + wanted.length);
      const last = range.getBoundingClientRect();
      return {
        from: { x: first.left + 1, y: first.top + first.height / 2 },
        to: { x: last.right - 1, y: last.top + last.height / 2 },
      };
    }
    return null;
  }, words);
  expect(spots, `the body holds ${words}`).not.toBeNull();
  await page.mouse.move(spots!.from.x, spots!.from.y);
  await page.mouse.down();
  await page.mouse.move(spots!.to.x, spots!.to.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => String(document.getSelection()))).toBe(words);
}

// Press the header's button and let the page load again.
async function press(page: Page, label: string) {
  const button = parts(page).button;
  await expect(button).toHaveText(label);
  const answered = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/archive' && response.request().method() === 'POST');
  const loaded = page.waitForEvent('load');
  await button.click();
  expect((await answered).status()).toBe(200);
  await loaded;
  await page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/archive' && response.request().method() === 'GET');
  await settle(page);
}

let thread = 0;
let reply = '';

test.describe.serial('an archived page', () => {
  test.beforeAll(async ({ playwright, baseURL }) => {
    for (const [name, value] of Object.entries({ ASSERTION, SECOND, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
    publish(NEXT, [`# ${NEXT_TITLE}`, '', 'What replaced the first plan.', '',
      '## Findings', '', 'The pond has a heater now.', '']);
    publish(NAME, ['# Pond plan', '', 'A finished plan for the pond.', '',
      '## Findings', '', PARAGRAPH, '',
      '## Decisions for the maintainer', '',
      '| # | Question | Options | Default |', '|---|---|---|---|',
      '| 1 | Which heater? | Floating / Submerged | Floating |', '']);
    const request = await playwright.request.newContext({ baseURL });
    try {
      thread = (await post(request, { page: NAME, section: 'findings', text: 'Did the pump crack?' })).id;
      reply = 'It held, but only just.';
      await post(request, { page: NAME, parent: thread, text: reply });
    } finally {
      await request.dispose();
    }
    archive();
  });

  test.afterAll(() => {
    if (OUT && PYTHON) run('unarchive', NAME, '--local', '--out-dir', OUT);
  });

  test.describe('signed in as its owner', () => {
    test.use({ extraHTTPHeaders: SIGNED_IN });

    test('shows the banner, keeps its thread readable and closes its composers', async ({ page }) => {
      const errors = await watch(page);
      await open(page);
      const side = parts(page);

      await expect(side.banner).toHaveText(`Archived ${archivedDay()} · superseded by ${NEXT_TITLE}`);
      await expect(side.banner).toHaveAttribute('role', 'note');
      const link = side.banner.locator('a');
      await expect(link).toHaveText(NEXT_TITLE);
      await expect(link).toHaveAttribute('href', `${NEXT}.html`);
      expect(await side.banner.evaluate((node) =>
        node.previousElementSibling?.classList.contains('artifact-topbar'))).toBe(true);

      // Its words, selected, offer no comment.
      await drag(page, PARAGRAPH);
      await page.waitForTimeout(600);
      await expect(side.pill).toBeHidden();
      await page.mouse.click(5, 300);

      const shown = await openThread(page, thread);
      await expect(shown.item).toContainText('Did the pump crack?');
      await expect(shown.item).toContainText(reply);
      await expect(shown.toggle).toBeDisabled();
      await expect(side.closed).toHaveText(CLOSED);
      await expect(side.pick).toBeVisible();
      await expect(side.pick).toBeDisabled();
      const news = await side.aside.locator('button.artifact-comments-new').evaluateAll((nodes) =>
        nodes.map((node) => (node as HTMLButtonElement).disabled));
      expect(news.length).toBeGreaterThan(0);
      expect(news.every(Boolean)).toBe(true);

      await expect(side.fieldset).toHaveJSProperty('disabled', true);
      await expect(side.ask).toBeDisabled();
      await expect(side.save).toHaveText('Save answer');
      await expect(side.save).toBeDisabled();
      await expect(side.note).toHaveText(CLOSED_NOTE);
      await expect(page.locator('.artifact-review-count')).toHaveCount(0);
      expect(errors).toEqual([]);
    });

    test('the owner unarchives it from the header, and archives it again', async ({ page }) => {
      const errors = await watch(page);
      await open(page);
      const side = parts(page);
      await expect(side.banner).toBeVisible();
      await expect(side.button).toHaveText('Unarchive');
      expect(await side.button.evaluate((node) =>
        node.previousElementSibling?.classList.contains('artifact-meta') &&
        node.parentElement?.matches('header.artifact-header'))).toBe(true);

      await press(page, 'Unarchive');
      await expect(side.banner).toHaveCount(0);
      await expect(side.button).toHaveText('Archive');
      await expect(side.fieldset).toHaveJSProperty('disabled', false);
      await expect(page.locator('.artifact-review-count')).toHaveCount(1);
      await drag(page, PARAGRAPH);
      await expect(side.pill).toBeVisible();
      await page.mouse.click(5, 300);
      const shown = await openThread(page, thread);
      await expect(shown.toggle).toBeEnabled();
      await expect(side.closed).toHaveCount(0);

      await press(page, 'Archive');
      await expect(side.banner).toBeVisible();
      await expect(side.banner).toContainText(`Archived ${new Date().toISOString().slice(0, 10)}`);
      await expect(side.button).toHaveText('Unarchive');
      await expect((await openThread(page, thread)).toggle).toBeDisabled();
      expect(errors).toEqual([]);
    });
  });

  test('a reader who is no owner, and one signed out, see the banner and no button', async ({ browser, baseURL }) => {
    for (const headers of [{ 'Cf-Access-Jwt-Assertion': SECOND }, {}]) {
      const context = await browser.newContext({
        baseURL, extraHTTPHeaders: headers, viewport: { width: 1440, height: 900 },
      });
      try {
        const page = await context.newPage();
        const errors = await watch(page);
        await open(page);
        const side = parts(page);
        await expect(side.banner).toBeVisible();
        await expect(side.banner).toContainText('Archived ');
        await expect(side.button).toHaveCount(0);
        expect(errors).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});
