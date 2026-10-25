import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// One theme choice for the whole site: a choice made in any page's switch
// applies at once, with no reload, to the tab shell (the index) and to every
// pod open in its tabs, a page kept from before the theme switch shipped
// included; Auto clears it everywhere. old-shell is that page, as Lotuspod
// 0.5.0 published it, copied into the served directory with its source and
// listed by the real `lotuspod manifest` and `lotuspod index`.
const ENV = process.env;
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const PYTHON = ENV.LOTUSPOD_TEST_PYTHON ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ENV.LOTUSPOD_TEST_ASSERTION ?? '' };
const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
const KEY = 'lotuspod:theme';
const TOKENS = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', 'src', 'lotuspod', 'core', 'theme', 'tokens.json'), 'utf-8'));
const NIGHT: Record<string, string> = TOKENS.colors;
const DAWN: Record<string, string> = TOKENS.dawn.colors;

type Pod = { name: string; title: string };
const OLD: Pod = { name: 'old-shell', title: 'Old shell' };
const ARTICLE: Pod = { name: 'capture-article', title: 'Capture article' };

const OLD_SHELL_SOURCE = `# Old shell

Written before the theme switch.

## Findings

The pond freezes in January.

## Next steps

Order a heater before the frost.
`;

// `lotuspod publish old-shell.md --local --date 2026-10-20` under the v0.5.0
// release, byte for byte.
const OLD_SHELL_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Old shell · Lotuspod</title>
  <meta name="generator" content="lotuspod theme lotus">
  <meta name="lotuspod:visible" content="true">
  <meta name="lotuspod:revision" content="48dada2b3407">
  <meta name="lotuspod:updated" content="2026-10-24T23:54:48Z">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="lotuspod.css?v=626c6f0689e7">
</head>
<body>
  <main class="artifact artifact--report" id="top">
    <div class="artifact-topbar">
      <a class="artifact-topbar-brand" href="index.html">Lotuspod</a><span class="artifact-topbar-sep">:</span>
      <a class="artifact-topbar-title" href="#top">Old shell</a>
    </div>

    <header class="artifact-header" data-digest="ca2e709438e2e84e">
      <h1 class="artifact-title">Old shell</h1>
      <p class="artifact-meta">Created <time datetime="2026-10-20">2026-10-20</time> · Updated <time datetime="2026-10-24T23:54:48Z">2026-10-24</time></p>
      <details class="artifact-comment" data-page="old-shell" data-section="">
<summary class="artifact-comment-summary">Comment</summary>
<div class="artifact-comment-threads"></div>
<form class="artifact-comment-form">
<textarea name="text" rows="3" maxlength="4000" required aria-label="Comment on this page"></textarea>
<div class="artifact-comment-actions"><button type="submit">Comment</button><p class="artifact-comment-status" role="status"></p></div>
</form>
</details>

    </header>

    <div class="artifact-main">
      <nav class="artifact-outline" data-digest="d505fdc0e516e95a" aria-label="On this page">
        <details class="artifact-outline-disclosure">
          <summary class="artifact-outline-summary">On this page</summary>
          <ol class="artifact-outline-list" role="list">
            <li><a href="#findings">Findings</a></li>
            <li><a href="#next-steps">Next steps</a></li>
          </ol>
        </details>
      </nav>

      <section class="artifact-body" data-intro-digest="53707d75c6f943a8">
        <p>Written before the theme switch.</p>
<h2 id="findings">Findings</h2>
<div class="artifact-section-body" data-section="findings" data-digest="74e550f8388b9369">
<p>The pond freezes in January.</p>
<details class="artifact-comment" data-page="old-shell" data-section="findings">
<summary class="artifact-comment-summary">Comment</summary>
<div class="artifact-comment-threads"></div>
<form class="artifact-comment-form">
<textarea name="text" rows="3" maxlength="4000" required aria-label="Comment on Findings"></textarea>
<div class="artifact-comment-actions"><button type="submit">Comment</button><p class="artifact-comment-status" role="status"></p></div>
</form>
</details>
</div>
<h2 id="next-steps">Next steps</h2>
<div class="artifact-section-body" data-section="next-steps" data-digest="b13438d4183c39ba">
<p>Order a heater before the frost.</p>
<details class="artifact-comment" data-page="old-shell" data-section="next-steps">
<summary class="artifact-comment-summary">Comment</summary>
<div class="artifact-comment-threads"></div>
<form class="artifact-comment-form">
<textarea name="text" rows="3" maxlength="4000" required aria-label="Comment on Next steps"></textarea>
<div class="artifact-comment-actions"><button type="submit">Comment</button><p class="artifact-comment-status" role="status"></p></div>
</form>
</details>
</div>

      </section>
    </div>

    <footer class="artifact-footer">
      <span aria-hidden="true">&#10047;</span> lotuspod
    </footer>
  </main>
  <script src="lotuspod-page.js?v=626c6f0689e7" defer></script>
</body>
</html>
`;

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
  fs.writeFileSync(path.join(OUT, `${OLD.name}.html`), OLD_SHELL_PAGE, 'utf-8');
  fs.writeFileSync(path.join(OUT, `${OLD.name}.md`), OLD_SHELL_SOURCE, 'utf-8');
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
