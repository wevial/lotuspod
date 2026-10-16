import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';


// The ticket flow uses the same real publishes and weekly route shape as the regression check.
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

const ARTICLE = { name: 'capture-article', title: 'Capture article' };

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

function indexRead(page: Page) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/' && response.request().resourceType() === 'fetch');
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

  test('Recent activity keeps the weeks it shows when it refreshes, and Show older adds one week', async ({ browser }) => {
    const output = process.env.CAPTURE_OUT!;
    expect(output).toBeTruthy();
    fs.mkdirSync(output, { recursive: true });
    const context = await browser.newContext({
      baseURL: ENV.LOTUSPOD_URL, extraHTTPHeaders: SIGNED_IN,
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: path.join(output, 'video'), size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    const video = page.video()!;
    const week = 7 * 24 * 60 * 60 * 1000;
    const asked: { before: string | null; at: number; from: string }[] = [];
    let newest = 0;
    await page.route((url) => url.pathname === ACTIVITY, (route) => {
      const before = new URL(route.request().url()).searchParams.get('before');
      // Use real time: the browser's stopped clock would hide the gap
      // between the previous week's start and the refreshed week's start.
      const to = before ? Date.parse(before) : Date.now();
      const from = new Date(to - week).toISOString();
      asked.push({ before, at: Date.now(), from });
      const at = new Date(to - 1000).toISOString();
      const summary = before ? 'an older week' : `ask ${++newest}`;
      return route.fulfill({ json: {
        from, to: new Date(to).toISOString(),
        older: true, truncated: false,
        pages: [{ page: ARTICLE.name, title: ARTICLE.title, latest: at,
          events: [{ kind: 'version', at, commit: at, revision: 'r1', actor: null,
            first: false, summary }] }],
      } });
    });
    // Observe the real stream and row swap before publishing. The server's
    // manifest poll sends publish followed by index, possibly after the read.
    await page.addInitScript(() => {
      const state = { published: '', indexed: '', rows: 0 };
      (window as any).__weekRefresh = state;
      document.addEventListener('lotuspod:change', (event) => {
        const { what, page } = (event as CustomEvent).detail;
        if (what === 'publish') state.published = page;
        if (what === 'index') state.indexed = state.published;
      });
      document.addEventListener('lotuspod:rows', () => { state.rows += 1; });
    });
    const settled = async (name: string, rows: number) => {
      await expect.poll(() => page.evaluate(() => (window as any).__weekRefresh))
        .toMatchObject({ indexed: name, rows });
    };
    await openIndex(page, '/#activity');
    const group = page.locator(`section.index-activity-page[data-page="${ARTICLE.name}"]`);
    await expect(group).toBeVisible();
    for (let n = 1; n <= 3; n += 1) {
      const opened = newest;
      asked.length = 0;
      publish(`index-refresh-weeks-${n}`, `Index refresh weeks ${n}`, 'A page published while one week is shown.');
      await nextRead(page);
      await settled(`index-refresh-weeks-${n}`, n);
      // The newest summary lands only after the whole refresh chain merges.
      await expect.poll(async () => newest > opened &&
        (await group.textContent())?.includes(`ask ${newest}`)).toBe(true);

      expect(asked.filter(({ before }) => before !== null)).toEqual([]);
      await expect(page.locator('.index-count')).toHaveText('1 page with activity in the last 7 days');
      await expect(group.locator('li.index-activity-event')).toHaveCount(1);
    }

    await page.screenshot({ path: path.join(output, '01-one-week-after-three-publishes.png') });
    const first = asked[asked.length - 1];
    asked.length = 0;
    await page.getByRole('button', { name: 'Show older', exact: true }).click();
    await expect(group.locator('li.index-activity-event')).toHaveCount(2);
    expect(asked).toHaveLength(1);
    expect(asked[0].before).toBe(first.from);
    await expect(page.locator('.index-count')).toHaveText('1 page with activity in the last 14 days');

    const opened = newest;
    asked.length = 0;
    publish('index-refresh-weeks-4', 'Index refresh weeks 4', 'A page published while two weeks are shown.');
    await nextRead(page);
    await settled('index-refresh-weeks-4', 4);
    await expect.poll(async () => newest > opened &&
      (await group.textContent())?.includes(`ask ${newest}`)).toBe(true);
    for (const { before, at } of asked) {
      if (before !== null) expect(at - Date.parse(before)).toBeLessThanOrEqual(week + EVERY);
    }
    await expect(page.locator('.index-count')).toHaveText('1 page with activity in the last 14 days');
    await expect(group.locator('li.index-activity-event')).toHaveCount(2);
    await page.screenshot({ path: path.join(output, '02-two-weeks-after-another-publish.png') });
    await context.close();
    await video.saveAs(path.join(output, 'flow.webm'));
    fs.rmSync(path.join(output, 'video'), { recursive: true, force: true });
  });
