import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// One theme choice for the whole site: a choice made in any page's switch
// applies at once, with no reload, to the tab shell (the index) and to every
// pod open in its tabs, a page kept from before the theme switch shipped
// included; Auto clears it everywhere. old-shell is that page, as Lotuspod
// 0.5.0 published it (tests/fixtures/old-template), copied into the served
// directory with its source and listed by the real `lotuspod manifest` and
// `lotuspod index`.
const ENV = process.env;
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ENV.LOTUSPOD_TEST_ASSERTION ?? '' };
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const FIXTURES = path.resolve(__dirname, '..', '..', '..', '..', 'tests', 'fixtures', 'old-template');
const KEY = 'lotuspod:theme';
const TOKENS = JSON.parse(fs.readFileSync(path.join(SRC, 'lotuspod', 'core', 'theme', 'tokens.json'), 'utf-8'));
const NIGHT: Record<string, string> = TOKENS.colors;
const DAWN: Record<string, string> = TOKENS.dawn.colors;

type Pod = { name: string; title: string };
const OLD: Pod = { name: 'old-shell', title: 'Old shell' };
const ARTICLE: Pod = { name: 'capture-article', title: 'Capture article' };

test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', extraHTTPHeaders: SIGNED_IN });

function run(...args: string[]) {
  return execFileSync(PYTHON, ['-m', 'lotuspod', ...args], {
    encoding: 'utf-8',
    env: { ...ENV, PYTHONPATH: SRC },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

function relist() {
  run('manifest', '--out-dir', OUT);
  run('index', '--out-dir', OUT);
}

function removeOld() {
  for (const file of fs.readdirSync(OUT)) {
    if (file.startsWith(`${OLD.name}.`)) fs.rmSync(path.join(OUT, file), { force: true });
  }
}

test.beforeAll(() => {
  for (const [name, value] of Object.entries({ OUT, PYTHON })) {
    expect(value, `the capture fixture names ${name}`).toBeTruthy();
  }
  removeOld();
  for (const suffix of ['.html', '.md']) {
    fs.copyFileSync(path.join(FIXTURES, `${OLD.name}${suffix}`), path.join(OUT, `${OLD.name}${suffix}`));
  }
  relist();
});

test.afterAll(() => {
  if (!OUT || !PYTHON) return;
  removeOld();
  relist();
});

// A comments poll still in a route handler when a check ends would otherwise
// fail that check with "Test ended".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

function rgb(token: string) {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(token);
  if (!hex) return token;
  const [r, g, b] = hex.slice(1).map((pair) => parseInt(pair, 16));
  return `rgb(${r}, ${g}, ${b})`;
}

async function watch(page: Page) {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route((url) => url.pathname === '/api/comments', (route) =>
    route.fulfill({ json: { page: new URL(route.request().url()).searchParams.get('page') ?? '', threads: [] } }));
  return errors;
}

const strip = (page: Page) => page.getByRole('group', { name: 'Open pods' });
const tabTitle = (page: Page, pod: Pod) =>
  strip(page).locator(`.pod-tab[data-page="${pod.name}"] button.pod-tab-title`);
const framed = (page: Page, pod: Pod) => page.frameLocator(`iframe.pod-frame[title="${pod.title}"]`);
const choice = (page: Page, pod: Pod, name: 'Night' | 'Dawn' | 'Auto') =>
  framed(page, pod).getByRole('group', { name: 'Theme' }).getByRole('button', { name, exact: true });

// The theme on the shell's root and on each open frame's, by frame title.
function themes(page: Page) {
  return page.evaluate(() => {
    const seen: Record<string, string | null> = { shell: document.documentElement.getAttribute('data-theme') };
    document.querySelectorAll('iframe.pod-frame').forEach((frame) => {
      const framedDocument = (frame as HTMLIFrameElement).contentDocument;
      seen[frame.getAttribute('title') ?? ''] =
        framedDocument ? framedDocument.documentElement.getAttribute('data-theme') : null;
    });
    return seen;
  });
}

function everywhere(theme: string) {
  return { shell: theme, [OLD.title]: theme, [ARTICLE.title]: theme };
}

// Whether the shell and each frame still hold the mark set before the
// choice, so none of them was loaded again.
function marked(page: Page) {
  return page.evaluate(() => {
    const frames = Array.from(document.querySelectorAll('iframe.pod-frame'));
    return [(window as any).themeMark === true,
      ...frames.map((frame) => ((frame as HTMLIFrameElement).contentWindow as any)?.themeMark === true)];
  });
}

function shellBackground(page: Page) {
  return page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);
}

test('one theme choice holds across the tab shell and every open tab, a page kept from before the switch included', async ({ page }) => {
  const errors = await watch(page);
  await page.goto(`/#tabs=${OLD.name},${ARTICLE.name}&on=${ARTICLE.name}`);
  await expect(strip(page)).toHaveCount(1);
  for (const pod of [OLD, ARTICLE]) await expect(framed(page, pod).locator('h1')).toHaveText(pod.title);
  await expect(choice(page, ARTICLE, 'Dawn')).toBeVisible();

  // Auto under a dark system reads as Night in the shell and in both tabs.
  await expect.poll(() => themes(page)).toEqual(everywhere('night'));
  await page.evaluate(() => {
    (window as any).themeMark = true;
    document.querySelectorAll('iframe.pod-frame').forEach((frame) => {
      ((frame as HTMLIFrameElement).contentWindow as any).themeMark = true;
    });
  });

  await choice(page, ARTICLE, 'Dawn').click();
  await expect.poll(() => themes(page)).toEqual(everywhere('dawn'));
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBe('dawn');
  await expect.poll(() => shellBackground(page)).toBe(rgb(DAWN.night));
  expect(await marked(page)).toEqual([true, true, true]);

  await tabTitle(page, OLD).click();
  await expect(choice(page, OLD, 'Dawn')).toBeVisible();
  await expect(choice(page, OLD, 'Dawn')).toHaveAttribute('aria-pressed', 'true');
  await choice(page, OLD, 'Auto').click();
  await expect.poll(() => themes(page)).toEqual(everywhere('night'));
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).toBeNull();
  await expect.poll(() => shellBackground(page)).toBe(rgb(NIGHT.night));
  await expect(choice(page, ARTICLE, 'Auto')).toHaveAttribute('aria-pressed', 'true');
  expect(await marked(page)).toEqual([true, true, true]);
  expect(errors).toEqual([]);
});
