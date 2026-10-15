import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// Wide enough for the side panel: a thread opens in it.
const WIDE = { width: 1440, height: 900 };
test.use({ viewport: WIDE });

// An open page or index tab listens to serve's stream (/api/events,
// js/live-events.js): a tick runs the checks the page already has at once.
// Each check publishes a page of its own on the capture fixture's site with
// a real `lotuspod publish`, and hermes replies with real `lotuspod
// comments` commands on the fixture's socket. The page's clock is paused, so
// nothing on the schedule runs unless a check moves it: what is drawn came
// from a tick.
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
const EVENTS = '/api/events';
const REVISION = '/api/revision';
const CHECK = 60_000;
const START = Date.parse('2026-10-15T12:00:00Z');

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

// A page's markdown: three sections, the edition named at the top.
function source(title: string, edition: string) {
  const lines = [`# ${title}`, '', `Edition: ${edition}.`, ''];
  for (const section of ['Findings', 'Risks', 'Next steps']) {
    lines.push(`## ${section}`, '', `${section}: the pond freezes in January, and the pump stops with it.`, '');
  }
  return lines.join('\n');
}

// hermes publishes markdown as the page name, with any extra options; the
// revision it is now at.
function publish(name: string, markdown: string, ...extra: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspod-live-events-'));
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

// Chromium's console error for the stream refused with a 503.
function refused(message: { text(): string; location(): { url: string } }) {
  return new URL(message.location().url || 'about:blank', 'http://x').pathname === EVENTS &&
    message.text().includes('503');
}

// Errors the page throws or logs, but for the stream refused.
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !refused(message)) errors.push(message.text());
  });
  return errors;
}

// The requests to a path from the page and every frame in it.
function watchAsked(page: Page, pathname: string) {
  const asked: string[] = [];
  page.on('request', (sent) => {
    if (new URL(sent.url()).pathname === pathname) asked.push(sent.url());
  });
  return asked;
}

// The page's clock, paused at START: it moves only when moved.
async function stopClock(page: Page) {
  await page.clock.install({ time: START });
  await page.clock.pauseAt(START + 1000);
}

// The stream answered 200, so the page is listening.
function streaming(page: Page) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === EVENTS && response.status() === 200);
}

// Open the page, let its first read of the threads come back and its stream
// open.
async function open(page: Page, name: string) {
  const read = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/comments' && response.request().method() === 'GET');
  const listening = streaming(page);
  await page.goto(`/${name}.html?standalone`);
  await read;
  await listening;
}

test.describe('signed in', () => {
  test.use({ extraHTTPHeaders: SIGNED_IN });

  test.beforeEach(() => {
    for (const [name, value] of Object.entries({ ASSERTION, SOCKET, HERMES, OUT, PYTHON })) {
      expect(value, `the capture fixture names ${name}`).toBeTruthy();
    }
  });

  test("hermes's reply is drawn in its thread at once, the clock never moved", async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-events-reply';
    // hermes pulls first, so it is listening and the comment, naming it, waits for it.
    hermes('pull', '--owner', OWNER);
    publish(name, source('Live events reply', 'first'));
    const root = await comment(request, name, 'findings', '@hermes Which heater?');
    const claim = hermes('claim', String(root.id));
    expect(claim.handle).toBe(OWNER);
    await stopClock(page);
    await open(page, name);

    await page.locator('details.artifact-comment[data-section="findings"] summary').click();
    const thread = page.locator(`.artifact-comment-thread[data-thread="${root.id}"]`);
    await expect(thread).toBeVisible();
    await expect(thread.locator('.artifact-comment-item--agent')).toHaveCount(0);

    const REPLY = 'A submerged heater, clear of the pump outlet.';
    // A claim token may start with '-': give it to its option in one word.
    hermes('reply', String(root.id), `--claim=${claim.claimToken}`, '--key', `live-events-${root.id}`,
      '--text', REPLY);
    await expect(thread.locator('.artifact-comment-item--agent .artifact-comment-text'))
      .toHaveText(REPLY, { timeout: 10_000 });
    expect(await page.evaluate(() => Date.now())).toBe(START + 1000);
    expect(errors).toEqual([]);
  });

  test('a republish is checked and swapped in at once, the clock never moved', async ({ page, request }) => {
    const errors = watchErrors(page);
    const name = 'live-events-publish';
    const first = publish(name, source('Live events publish', 'first'));
    await comment(request, name, 'risks', 'Will the pump crack?');
    const asked = watchAsked(page, REVISION);
    await stopClock(page);
    await open(page, name);
    expect(asked).toEqual([]);

    const second = publish(name, source('Live events publish', 'second'));
    expect(second).not.toBe(first);
    await expect(page.locator('.artifact-body')).toContainText('Edition: second.', { timeout: 10_000 });
    await expect(page.locator('.artifact-body')).not.toContainText('Edition: first.');
    await expect.poll(() => page.locator('meta[name="lotuspod:revision"]').getAttribute('content'))
      .toBe(second);
    expect(asked.length).toBeGreaterThanOrEqual(1);
    await expect(page.locator('.artifact-live-page-banner')).toHaveCount(0);
    expect(await page.evaluate(() => Date.now())).toBe(START + 1000);
    expect(errors).toEqual([]);
  });

  test('with the stream refused, a republish waits for the 60-second check, and the stream is asked again', async ({ page }) => {
    const errors = watchErrors(page);
    const name = 'live-events-refused';
    publish(name, source('Live events refused', 'first'), '--no-comments');
    await page.route((url) => url.pathname === EVENTS, (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: '{"error": "too_many_streams"}' }));
    // Each stream the page makes and each error it gets, so the clock moves
    // on only once the page has met each refusal.
    await page.addInitScript(() => {
      const w = window as any;
      w.__streams = { made: 0, errors: 0 };
      const Native = window.EventSource;
      window.EventSource = class extends Native {
        constructor(url: string | URL, init?: EventSourceInit) {
          super(url, init);
          w.__streams.made += 1;
          this.addEventListener('error', () => { w.__streams.errors += 1; });
        }
      };
    });
    const streams = () => page.evaluate(() => (window as any).__streams as { made: number; errors: number });
    const settle = () => expect.poll(async () => {
      const { made, errors } = await streams();
      return made === errors;
    }).toBe(true);
    const pass = async (ms: number) => {
      for (let done = 0; done < ms; done += 1000) {
        await page.clock.runFor(1000);
        await settle();
      }
    };
    const asked = watchAsked(page, REVISION);
    const body = page.locator('.artifact-body');
    await stopClock(page);
    await page.goto(`/${name}.html?standalone`);
    await expect.poll(async () => (await streams()).errors).toBe(1);

    publish(name, source('Live events refused', 'second'), '--no-comments');
    // Well past the stream's tick, had it been open.
    await page.waitForTimeout(3000);
    await pass(CHECK - 1000);
    expect(asked).toEqual([]);
    await expect(body).toContainText('Edition: first.');

    await pass(1000);
    await expect.poll(() => asked.length).toBe(1);
    await expect(body).toContainText('Edition: second.');
    const made = (await streams()).made;
    expect(made).toBeGreaterThan(1);

    await pass(2000);
    expect((await streams()).made).toBeGreaterThan(made);
    expect(errors).toEqual([]);
  });

  test('the index holds one stream for its frames, and a republished tab shows "new version" at once', async ({ page }) => {
    const errors = watchErrors(page);
    const shown = { name: 'live-events-shown', title: 'Live events shown' };
    const behind = { name: 'live-events-behind', title: 'Live events behind' };
    publish(shown.name, source(shown.title, 'first'), '--no-comments');
    publish(behind.name, source(behind.title, 'first'), '--no-comments');
    // Each stream asked, and whether the index's own document asked it.
    const streams: boolean[] = [];
    page.on('request', (sent) => {
      if (new URL(sent.url()).pathname === EVENTS) streams.push(sent.frame() === page.mainFrame());
    });
    // Each framed page posts its own revision once it has loaded.
    const recorded = (pod: { name: string }) => page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/seen' && response.request().method() === 'POST' &&
      response.request().postDataJSON().page === pod.name);
    const loaded = [recorded(shown), recorded(behind)];
    const listening = streaming(page);
    await stopClock(page);
    await page.goto(`/#tabs=${shown.name},${behind.name}&on=${shown.name}`);
    await expect(page.getByRole('group', { name: 'Open pods' }).locator('.pod-tab')).toHaveCount(2);
    await Promise.all(loaded);
    await listening;
    await page.waitForTimeout(1000);
    expect(streams).toEqual([true]);

    const tab = page.locator(`.pod-tab[data-page="${behind.name}"]`);
    await expect(tab.locator('.pod-tab-dot')).toHaveCount(0);
    publish(behind.name, source(behind.title, 'second'), '--no-comments');
    await expect(tab.locator('.pod-tab-dot')).toHaveText('new version', { timeout: 10_000 });
    expect(await page.evaluate(() => Date.now())).toBe(START + 1000);
    expect(streams).toEqual([true]);
    expect(errors).toEqual([]);
  });

  test('an old version of a page opens no stream', async ({ page }) => {
    // Thrown errors only: the old version's policy blocks the page script it
    // names, which Chromium logs.
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const name = 'live-events-old';
    publish(name, source('Live events old', 'first'));
    publish(name, source('Live events old', 'second'));
    const answered = await page.request.get(`/api/versions?page=${name}`);
    expect(answered.status()).toBe(200);
    const older = (await answered.json()).versions[1];
    expect(older.current).toBe(false);
    const streams = watchAsked(page, EVENTS);
    const versions = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/versions');
    await page.goto(`/${name}.html?version=${older.commit}`);
    await expect(page.locator('main.artifact--old-version > div.artifact-version-banner')).toBeVisible();
    await versions;
    await page.waitForTimeout(1000);
    expect(streams).toEqual([]);
    expect(errors).toEqual([]);
  });
});
