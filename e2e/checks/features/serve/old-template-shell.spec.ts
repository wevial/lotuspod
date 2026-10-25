import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Pages kept from before the theme switch shipped, each copied into the
// served directory as it sits there: old-shell, as Lotuspod 0.5.0 published
// it from its markdown source, kept beside it; and old-plain, a page of the
// September site kept only as its rendered HTML, with no source, no revision
// and no script. serve answers each with today's shell: the title bar's
// theme switch, the reader's stored choice before the first paint, and the
// body and stamps the page was published with.
const ENV = process.env;
const OUT = ENV.LOTUSPOD_TEST_OUT ?? '';
const SIGNED_IN = { 'Cf-Access-Jwt-Assertion': ENV.LOTUSPOD_TEST_ASSERTION ?? '' };
const KEY = 'lotuspod:theme';
const TOKENS = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', '..', '..', '..', 'src', 'lotuspod', 'core', 'theme', 'tokens.json'), 'utf-8'));
const NIGHT: Record<string, string> = TOKENS.colors;
const DAWN: Record<string, string> = TOKENS.dawn.colors;

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

// The September site's shell (theme v0.4.6), its text replaced: no policy,
// no revision, no script, a back link and a kicker, and a body that styles
// itself.
const OLD_PLAIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Old plain · Lotuspod</title>
  <meta name="generator" content="lotuspod theme lotus v0.4.6">
  <meta name="lotuspod:visible" content="true">
  <link rel="icon" type="image/svg+xml" href="favicon.svg">
  <link rel="stylesheet" href="lotuspod.css?v=0.4.6">
</head>
<body>
  <main class="artifact artifact--report" id="top">
    <div class="artifact-topbar">
      <a class="artifact-topbar-brand" href="index.html">Lotuspod</a><span class="artifact-topbar-sep">:</span>
      <a class="artifact-topbar-title" href="#top">Old plain</a>
    </div>

    <nav class="artifact-nav">
      <a href="index.html"><span aria-hidden="true">&#8592;</span> Lotuspod</a>
    </nav>

    <header class="artifact-header">
      <p class="artifact-kicker">Lotuspod</p>
      <h1 class="artifact-title">Old plain</h1>
      <p class="artifact-meta"><time datetime="2026-09-04">2026-09-04</time></p>
      <p class="artifact-summary">Kept only as its rendered page.</p>
    </header>

    <div class="artifact-main">
      <nav class="artifact-outline" aria-label="On this page">
        <details class="artifact-outline-disclosure">
          <summary class="artifact-outline-summary">On this page</summary>
          <ol class="artifact-outline-list" role="list">
            <li><a href="#the-beds">The beds</a></li>
            <li><a href="#the-path">The path</a></li>
          </ol>
        </details>
      </nav>

      <section class="artifact-body">
        <style>
.artifact-body .plain-note{color:var(--color-muted-lavender)}
</style>
<p class="plain-note">Planted in the spring.</p>
<h2 id="the-beds">The beds</h2>
<p>Three beds of lettuce.</p>
<h2 id="the-path">The path</h2>
<p>Gravel, then stone.</p>

      </section>
    </div>

    <footer class="artifact-footer">
      <span aria-hidden="true">&#10047;</span> lotuspod
    </footer>
  </main>
</body>
</html>
`;

type Kept = {
  name: string;
  title: string;
  files: Record<string, string>;
  ids: string[];
  text: string[];
  revision: string | null;
  created: string;
};

const PAGES: Kept[] = [
  {
    name: 'old-shell',
    title: 'Old shell',
    files: { 'old-shell.html': OLD_SHELL_PAGE, 'old-shell.md': OLD_SHELL_SOURCE },
    ids: ['findings', 'next-steps'],
    text: ['Written before the theme switch.', 'The pond freezes in January.', 'Order a heater before the frost.'],
    revision: '48dada2b3407',
    created: '2026-10-20',
  },
  {
    name: 'old-plain',
    title: 'Old plain',
    files: { 'old-plain.html': OLD_PLAIN_PAGE },
    ids: ['the-beds', 'the-path'],
    text: ['Planted in the spring.', 'Three beds of lettuce.', 'Gravel, then stone.'],
    revision: null,
    created: '2026-09-04',
  },
];

test.use({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', extraHTTPHeaders: SIGNED_IN });

function removeKept() {
  for (const kept of PAGES) {
    for (const file of fs.readdirSync(OUT)) {
      if (file.startsWith(`${kept.name}.`)) fs.rmSync(path.join(OUT, file), { force: true });
    }
  }
}

test.beforeAll(() => {
  expect(OUT, 'the capture fixture names LOTUSPOD_TEST_OUT').toBeTruthy();
  removeKept();
  for (const kept of PAGES) {
    for (const [file, text] of Object.entries(kept.files)) fs.writeFileSync(path.join(OUT, file), text, 'utf-8');
  }
});

test.afterAll(() => {
  if (OUT) removeKept();
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

function theme(page: Page) {
  return page.evaluate(() => document.documentElement.getAttribute('data-theme'));
}

function stored(page: Page) {
  return page.evaluate((key) => localStorage.getItem(key), KEY);
}

function background(page: Page) {
  return page.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor);
}

function choice(page: Page, name: 'Night' | 'Dawn' | 'Auto') {
  return page.getByRole('group', { name: 'Theme' }).getByRole('button', { name, exact: true });
}

for (const kept of PAGES) {
  test(`${kept.name}, kept from before the theme switch, is answered with today's shell and the reader's theme`, async ({ page }) => {
    const errors = await watch(page);
    await page.goto('/index.html');
    await page.evaluate((key) => localStorage.setItem(key, 'dawn'), KEY);
    await page.addInitScript(() => {
      requestAnimationFrame(() => {
        (window as any).firstFrameTheme = document.documentElement.getAttribute('data-theme');
      });
    });

    await page.goto(`/${kept.name}.html?standalone`);
    await expect(page.locator('h1.artifact-title')).toHaveText(kept.title);
    await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
    expect(await page.evaluate(() => (window as any).firstFrameTheme)).toBe('dawn');
    await expect(choice(page, 'Dawn')).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => background(page)).toBe(rgb(DAWN.night));

    await choice(page, 'Night').click();
    expect(await theme(page)).toBe('night');
    expect(await stored(page)).toBe('night');
    await expect.poll(() => background(page)).toBe(rgb(NIGHT.night));

    expect(await page.locator('.artifact-body h2').evaluateAll((headings) => headings.map((h) => h.id)))
      .toEqual(kept.ids);
    for (const line of kept.text) await expect(page.locator('.artifact-body')).toContainText(line);
    await expect(page.locator('.artifact-header time').first()).toHaveAttribute('datetime', kept.created);
    const revision = page.locator('meta[name="lotuspod:revision"]');
    if (kept.revision === null) await expect(revision).toHaveCount(0);
    else await expect(revision).toHaveAttribute('content', kept.revision);
    expect(errors).toEqual([]);
  });
}
