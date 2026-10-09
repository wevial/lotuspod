import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

// Wide enough for the side panel: a thread opens in it.
const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

// An open page notices it was published again. Each check publishes a page
// of its own on the capture fixture's site with a real `lotuspod publish`,
// opens it, publishes it again to a new revision and drives the page's
// clock: the page asks for its revision every 60 seconds, and learns it from
// each read of its threads too.
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
const NEWER = 'A newer version of this page is available';
const CHECK = 60_000;
const START = Date.parse('2026-10-02T12:00:00Z');
const FISH = path.resolve(__dirname, '..', '..', 'tests', 'fixtures', 'media', 'fish-320x240.jpg');
const MEDIA_URL = /^\/media\/[0-9a-f]{64}\.jpg$/;

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

// hermes pulls, so it is listening and a new comment waits for it.
function listen() {
  JSON.parse(run('comments', 'pull', '--owner', OWNER, '--json', '--socket', SOCKET,
    '--credential', HERMES));
}

// A page's markdown: three sections of `paragraphs` paragraphs each, the
// edition named at the top.
function source(title: string, edition: string, paragraphs = 2) {
  const lines = [`# ${title}`, '', `Edition: ${edition}.`, ''];
  for (const section of ['Findings', 'Risks', 'Next steps']) {
    lines.push(`## ${section}`, '');
    for (let n = 1; n <= paragraphs; n += 1) {
      lines.push(`${section}, paragraph ${n}: the pond freezes in January, the pump stops ` +
        'with it, and the heater keeps a hole in the ice open for the fish until the thaw.', '');
    }
  }
  return lines.join('\n');
}

// hermes publishes markdown as the page name, with any extra options; the
// revision it is now at.
function publish(name: string, markdown: string, ...extra: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-live-page-'));
  try {
    const file = path.join(dir, `${name}.md`);
    fs.writeFileSync(file, markdown, 'utf-8');
    const said = run('publish', file, '--local', '--out-dir', OUT, '--owner', OWNER,
      '--credential', HERMES, ...extra);
    const revision = /at revision ([0-9a-f]{12})/.exec(said)?.[1] ?? '';
    expect(revision, said).not.toBe('');
    return revision;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The reader's new thread on a section, stored through the comments route.
async function comment(request: APIRequestContext, name: string, section: string, text: string) {
  const response = await request.post('/api/comments', {
    headers: SIGNED_IN, data: { page: name, section, text },
  });
  expect(response.status()).toBe(201);
  return (await response.json()) as { id: number; state: string };
}

// Errors the page throws or logs.
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

// The page's clock, paused at START: it moves only when moved.
async function stopClock(page: Page) {
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
}

// Open the page and let its first read of the threads come back.
async function open(page: Page, name: string) {
  const read = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'GET');
  await page.goto(`/${name}.html`);
  await read;
}

function revisionOf(page: Page) {
  return page.locator('meta[name="lotuspod:revision"]').getAttribute('content');
}

// Where the page's text starts in the window: the same, to the pixel the
// scroll position snaps to, after a reload that brings the reader back to the
// same place in it, even with the box saying what changed drawn above it.
function textTop(page: Page) {
  return page.evaluate(() => document.querySelector('.artifact-main')!.getBoundingClientRect().top);
}

function banner(page: Page) {
  const node = page.locator('.artifact-live-page-banner');
  return { node, reload: node.getByRole('button', { name: 'Reload' }) };
}

async function setVisibility(page: Page, state: 'hidden' | 'visible') {
  await page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

// Paste the fish JPEG into a field, as the clipboard hands it to the page,
// and wait for its upload to be answered.
async function pasteFish(page: Page, field: Locator) {
  const base64 = fs.readFileSync(FISH).toString('base64');
  const uploaded = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/media');
  await field.evaluate((node, base64) => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    data.items.add(new File([bytes], 'fish.jpg', { type: 'image/jpeg' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, base64);
  expect((await uploaded).status()).toBe(201);
}

// The thumbnails attached in a form: their /media/ paths, once drawn.
async function attachedIn(form: Locator) {
  return form.locator('.artifact-attach-item img').evaluateAll((images) =>
    images.map((img) => new URL((img as HTMLImageElement).src).pathname));
}

// Where every element of the page's main column is, in the window.
function layout(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('main.artifact *')).map((node) => {
    const rect = node.getBoundingClientRect();
    return [rect.x, rect.y, rect.width, rect.height];
  }));
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test('a republish shows the banner at the next check, over the page, moving nothing', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-check';
    const first = publish(name, source('Live page check', 'first'));
    await stopClock(page);
    await open(page, name);
    expect(await revisionOf(page)).toBe(first);
    const before = await layout(page);
    expect(before.length).toBeGreaterThan(10);

    const second = publish(name, source('Live page check', 'second'));
    expect(second).not.toBe(first);
    await page.clock.runFor(CHECK - 1000);
    await expect(banner(page).node).toHaveCount(0);
    await page.clock.runFor(1000);

    const shown = banner(page);
    await expect(shown.node).toBeVisible();
    await expect(shown.node).toContainText(NEWER);
    await expect(shown.reload).toBeVisible();
    // Fixed over the top of the window, announced politely.
    await expect(shown.node.locator('xpath=ancestor::*[@role="status"]')).toHaveCount(1);
    await expect(page.locator('.artifact-live-page')).toHaveCSS('position', 'fixed');
    const box = (await shown.node.boundingBox())!;
    expect(box.y).toBeLessThan(40);
    expect(await layout(page)).toEqual(before);
    // The page is still the one it was until the reader reloads it.
    expect(await revisionOf(page)).toBe(first);
    expect(errors).toEqual([]);
  });

  test('a published page with no comments, decisions or sections notices a republish too', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-plain';
    const NOTE = (edition: string) => `# Live page plain\n\nEdition: ${edition}. One note, no sections.\n`;
    const first = publish(name, NOTE('first'), '--no-comments');
    await stopClock(page);
    await page.goto(`/${name}.html`);
    expect(await revisionOf(page)).toBe(first);
    await expect(page.locator('details.artifact-comment, form.artifact-decision, h2')).toHaveCount(0);

    const second = publish(name, NOTE('second'), '--no-comments');
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toContainText(NEWER);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;
    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    expect(errors).toEqual([]);
  });

  test("a waiting thread's next read brings the banner without the 60-second check", async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-poll';
    listen();
    publish(name, source('Live page poll', 'first'));
    const root = await comment(request, name, 'findings', 'Which heater?');
    expect(root.state).toBe('pending');
    const asked: string[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === '/api/revision') asked.push(sent.url());
    });
    await stopClock(page);
    await open(page, name);
    await expect(banner(page).node).toHaveCount(0);

    publish(name, source('Live page poll', 'second'));
    await page.clock.runFor(5000);
    await expect(banner(page).node).toBeVisible();
    await expect(banner(page).node).toContainText(NEWER);
    expect(asked).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Reload shows the new revision at the same place, its thread open and its text unsent', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-reload';
    publish(name, source('Live page reload', 'first', 8));
    const root = await comment(request, name, 'risks', 'Will the pump crack?');
    await stopClock(page);
    await open(page, name);

    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const entry = page.locator(`.artifact-comments-panel li.artifact-comments-entry[data-thread="${root.id}"]`);
    await expect(entry).toHaveClass(/artifact-comments-entry--open/);
    const node = entry.locator('.artifact-comment-thread');
    await node.locator('.artifact-comment-toggle').click();
    const field = node.locator('form.artifact-comment-reply textarea[name="text"]');
    const UNSENT = 'And if the heater fails as well?';
    await field.fill(UNSENT);
    const y = await page.evaluate(() => {
      window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2));
      return window.scrollY;
    });
    expect(y).toBeGreaterThan(300);
    const top = await textTop(page);

    const second = publish(name, source('Live page reload', 'second', 8));
    await page.clock.runFor(CHECK);
    const shown = banner(page);
    await expect(shown.reload).toBeVisible();
    const loaded = page.waitForEvent('load');
    await shown.reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    await expect(entry).toHaveClass(/artifact-comments-entry--open/);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue(UNSENT);
    await expect.poll(async () => Math.abs(await textTop(page) - top)).toBeLessThanOrEqual(1);
    await expect(banner(page).node).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('what the reader writes and scrolls while Reload fetches the page is kept too', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-slow';
    publish(name, source('Live page slow', 'first', 8));
    const root = await comment(request, name, 'risks', 'Will the pump crack?');
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const node = page.locator(`.artifact-comments-panel .artifact-comment-thread[data-thread="${root.id}"]`);
    await node.locator('.artifact-comment-toggle').click();
    const field = node.locator('form.artifact-comment-reply textarea[name="text"]');
    await field.fill('And if the heater');

    // The page's fetch before the reload waits until released; the reload
    // itself goes through.
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let asked = false;
    await page.route(`**/${name}.html`, async (route) => {
      if (route.request().resourceType() === 'fetch') {
        asked = true;
        await held;
      }
      await route.continue();
    });

    const second = publish(name, source('Live page slow', 'second', 8));
    await page.clock.runFor(CHECK);
    await banner(page).reload.click();
    await expect.poll(() => asked).toBe(true);
    await field.pressSequentially(' fails as well?');
    const y = await page.evaluate(() => {
      window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) / 2));
      return window.scrollY;
    });
    expect(y).toBeGreaterThan(300);
    const top = await textTop(page);
    const loaded = page.waitForEvent('load');
    release();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(field).toHaveValue('And if the heater fails as well?');
    await expect.poll(async () => Math.abs(await textTop(page) - top)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  test('on a phone, Reload opens the thread in the sheet again at the same scroll position', async ({ page, request }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = watchErrors(page);
    const name = 'live-page-phone';
    publish(name, source('Live page phone', 'first', 8));
    const root = await comment(request, name, 'risks', 'Will the pump crack?');
    await stopClock(page);
    await open(page, name);

    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const sheet = page.locator('.artifact-comments-bottom-sheet');
    const node = sheet.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
    await expect(node).toBeVisible();
    await node.locator('.artifact-comment-toggle').click();
    const field = node.locator('form.artifact-comment-reply textarea[name="text"]');
    const UNSENT = 'And if the heater fails as well?';
    await field.fill(UNSENT);
    // Well past the thread's chip, which the sheet would scroll back to.
    const y = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight - window.innerHeight);
      return window.scrollY;
    });
    expect(y).toBeGreaterThan(1000);
    const top = await textTop(page);

    const second = publish(name, source('Live page phone', 'second', 8));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(node).toBeVisible();
    await expect(field).toHaveValue(UNSENT);
    await expect.poll(async () => Math.abs(await textTop(page) - top)).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });

  // Select the first `length` characters of the paragraph holding `words`
  // and open the passage composer on them.
  async function selectPassage(page: Page, words: string, length: number) {
    await page.locator('.artifact-body p', { hasText: words }).evaluate((paragraph, length) => {
      const range = document.createRange();
      range.setStart(paragraph.firstChild!, 0);
      range.setEnd(paragraph.firstChild!, length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, length);
    await page.keyboard.press('Control+Alt+m');
    const field = page.getByRole('textbox', { name: 'Comment on the selected words' });
    await expect(field).toBeFocused();
    return field;
  }

  test('Reload opens a passage composer again on its words, its text unsent', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-passage';
    publish(name, source('Live page passage', 'first'));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, 'Risks, paragraph 1', 18);
    const UNSENT = 'Which pump is this?';
    await field.fill(UNSENT);

    const second = publish(name, source('Live page passage', 'second'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(field).toHaveValue(UNSENT);
    await expect(page.locator('mark.artifact-passage--pending')).toHaveText('Risks, paragraph 1');
    expect(errors).toEqual([]);
  });

  test('a passage comment whose words changed is kept in its section\'s form, saying why', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-passage-gone';
    publish(name, source('Live page passage gone', 'first'));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, 'Risks, paragraph 1', 18);
    const UNSENT = 'Which pump is this?';
    await field.fill(UNSENT);

    const second = publish(name, source('Live page passage gone', 'second')
      .replace('Risks, paragraph 1:', 'Risks, first point:'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('.artifact-body')).toContainText('Risks, first point:');
    await expect(page.locator('mark.artifact-passage--pending')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Risks' }) });
    await expect(form.locator('textarea')).toBeVisible();
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'The words you selected have changed since. Your comment is kept here, on the section.');
    expect(errors).toEqual([]);
  });

  test('a comment on a section renamed since is kept in the form where the section was, saying why', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-renamed';
    publish(name, source('Live page renamed', 'first'));
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const risks = page.locator('.artifact-comments-panel').getByRole('textbox', { name: 'Comment on Risks' });
    await expect(risks).toBeFocused();
    const UNSENT = 'What cracks first, the pump or the pipe?';
    await risks.fill(UNSENT);

    const second = publish(name, source('Live page renamed', 'second').replace(/Risks/g, 'Hazards'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('details.artifact-comment[data-section="risks"]')).toHaveCount(0);
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Hazards' }) });
    await expect(form.locator('textarea')).toBeVisible();
    await expect(form.locator('textarea')).toHaveValue(UNSENT);
    await expect(form.locator('.artifact-comment-status')).toHaveText(
      'Where you were writing has changed since. Your text is kept here.');
    expect(errors).toEqual([]);
  });

  test('a hidden page with nothing unsent has reloaded itself before it is seen again', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-hidden';
    const first = publish(name, source('Live page hidden', 'first'));
    await stopClock(page);
    await open(page, name);
    await setVisibility(page, 'hidden');

    const second = publish(name, source('Live page hidden', 'second'));
    expect(second).not.toBe(first);
    const loaded = page.waitForEvent('load');
    await page.clock.runFor(CHECK);
    await loaded;
    await setVisibility(page, 'visible');

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    await expect(banner(page).node).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a hidden page with unsent text waits for the reader, the banner showing and the text intact', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-unsent';
    const first = publish(name, source('Live page unsent', 'first'));
    await stopClock(page);
    await open(page, name);
    // No thread yet: the chip opens the section's form for a new one.
    await page.locator('details.artifact-comment[data-section="findings"] summary').click();
    const field = page.locator('.artifact-comments-panel')
      .getByRole('textbox', { name: 'Comment on Findings' });
    await expect(field).toBeFocused();
    const UNSENT = 'Half a thought about the pump';
    await field.fill(UNSENT);
    await page.evaluate(() => { (window as any).__stayed = 'this page'; });
    await setVisibility(page, 'hidden');

    publish(name, source('Live page unsent', 'second'));
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toBeAttached();
    await setVisibility(page, 'visible');

    await expect(banner(page).node).toBeVisible();
    await expect(banner(page).node).toContainText(NEWER);
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    expect(await revisionOf(page)).toBe(first);
    await expect(field).toHaveValue(UNSENT);
    expect(errors).toEqual([]);
  });

  test('a hidden page with only an image attached waits for the reader, the image intact', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-unsent-image';
    const first = publish(name, source('Live page unsent image', 'first'));
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="findings"] summary').click();
    const field = page.locator('.artifact-comments-panel')
      .getByRole('textbox', { name: 'Comment on Findings' });
    await expect(field).toBeFocused();
    const form = page.locator('.artifact-comments-panel form.artifact-comment-form')
      .filter({ has: page.getByRole('textbox', { name: 'Comment on Findings' }) });
    await pasteFish(page, field);
    await expect(form.locator('.artifact-attach-item img')).toHaveCount(1);
    const attached = await attachedIn(form);
    await page.evaluate(() => { (window as any).__stayed = 'this page'; });
    await setVisibility(page, 'hidden');

    publish(name, source('Live page unsent image', 'second'));
    await page.clock.runFor(CHECK);
    await expect(banner(page).node).toBeAttached();
    await setVisibility(page, 'visible');

    await expect(banner(page).node).toBeVisible();
    expect(await page.evaluate(() => (window as any).__stayed)).toBe('this page');
    expect(await revisionOf(page)).toBe(first);
    expect(await attachedIn(form)).toEqual(attached);
    expect(errors).toEqual([]);
  });

  test('Reload keeps the image attached in a reply with no text, and the reply sends it', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-page-reply-image';
    publish(name, source('Live page reply image', 'first'));
    const root = await comment(request, name, 'risks', 'What does the ice look like?');
    await stopClock(page);
    await open(page, name);
    await page.locator('details.artifact-comment[data-section="risks"] summary').click();
    const entry = page.locator(`.artifact-comments-panel li.artifact-comments-entry[data-thread="${root.id}"]`);
    await expect(entry).toHaveClass(/artifact-comments-entry--open/);
    const node = entry.locator('.artifact-comment-thread');
    await node.locator('.artifact-comment-toggle').click();
    const form = node.locator('form.artifact-comment-reply');
    const field = form.locator('textarea[name="text"]');
    await pasteFish(page, field);
    const attached = await attachedIn(form);
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatch(MEDIA_URL);

    const second = publish(name, source('Live page reply image', 'second'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(field).toBeVisible();
    await expect(field).toHaveValue('');
    await expect(form.locator('.artifact-attach-item img')).toHaveCount(1);
    expect(await attachedIn(form)).toEqual(attached);
    const [posted] = await Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === '/api/comments' && r.request().method() === 'POST'),
      form.getByRole('button', { name: 'Send' }).click(),
    ]);
    expect(posted.status()).toBe(201);
    expect((await posted.json()).images.map((image: { url: string }) => image.url)).toEqual(attached);
    expect(errors).toEqual([]);
  });

  test('Reload opens a passage composer again with the image attached in it', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-page-passage-image';
    publish(name, source('Live page passage image', 'first'));
    await stopClock(page);
    await open(page, name);
    const field = await selectPassage(page, 'Risks, paragraph 1', 18);
    const form = page.locator('form.artifact-passage-form');
    await pasteFish(page, field);
    const attached = await attachedIn(form);
    expect(attached).toHaveLength(1);

    const second = publish(name, source('Live page passage image', 'second'));
    await page.clock.runFor(CHECK);
    const loaded = page.waitForEvent('load');
    await banner(page).reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('mark.artifact-passage--pending')).toHaveText('Risks, paragraph 1');
    await expect(form.locator('.artifact-attach-item img')).toHaveCount(1);
    expect(await attachedIn(form)).toEqual(attached);
    expect(errors).toEqual([]);
  });

  test('with storage that throws, the banner still shows and Reload still reloads', async ({ page }) => {
    const errors = watchErrors(page);
    await page.addInitScript(() => {
      const refuse = () => { throw new DOMException('Storage is refused', 'SecurityError'); };
      for (const method of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
        Object.defineProperty(Storage.prototype, method, { value: refuse, configurable: true });
      }
      for (const name of ['localStorage', 'sessionStorage']) {
        Object.defineProperty(window, name, { get: refuse, configurable: true });
      }
    });
    const name = 'live-page-storage';
    publish(name, source('Live page storage', 'first'));
    await stopClock(page);
    await open(page, name);
    expect(await page.evaluate(() => {
      try {
        window.sessionStorage.getItem('x');
        return 'kept';
      } catch {
        return 'refused';
      }
    })).toBe('refused');

    const second = publish(name, source('Live page storage', 'second'));
    await page.clock.runFor(CHECK);
    const shown = banner(page);
    await expect(shown.node).toContainText(NEWER);
    const loaded = page.waitForEvent('load');
    await shown.reload.click();
    await loaded;

    expect(await revisionOf(page)).toBe(second);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.');
    await expect(banner(page).node).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
